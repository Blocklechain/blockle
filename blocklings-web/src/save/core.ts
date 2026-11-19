/**
 * Save module — persistence for every stateful system.
 *
 * Serializes all saveRegistry providers + the player's pos/hp/mp/name into a
 * CharacterSave-shaped envelope `{ v: 1, t, name, pos, hp, mp, mods: {key: data} }`
 * (kept well under 12KB: compact arrays, rounded positions).
 *
 * - Local:   localStorage 'blocklings_save_v1' (always, synchronously).
 * - Account: when the page has a Blockle session (bearer `blk_token` or the
 *   browser cookie), GET/PUT https://blockle.org/account/api/game/character
 *   `{ character: envelope }`. The account copy wins on boot when its `t`
 *   (epoch ms) is newer. Fully offline-tolerant — the game never blocks or
 *   breaks when the network/account is absent.
 *
 * Boot order contract: the integrator calls initSave(api) FIRST among the
 * stateful modules. We load the envelope immediately, stash the per-module
 * blobs, and apply each one the moment its provider registers (late-binding
 * via a wrap of saveRegistry.register).
 */
import type { GameAPI } from '../types'
import { events } from '../events'
import { saveRegistry, type SaveProvider } from './registry'

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/** CharacterSave-shaped persistent envelope (v1). */
export interface SaveEnvelope {
  v: 1
  /** Epoch ms of the save — newer wins between local and account copies. */
  t: number
  name: string
  /** [x, z] feet position, rounded to 0.1 (y re-derived from groundHeight). */
  pos: [number, number]
  hp: number
  mp: number
  /** Per-module blobs keyed by saveRegistry key ('inv', 'skills', ...). */
  mods: Record<string, unknown>
  /** Account id (sub/username) that owns this save. Absent = guest/local-only.
   *  Used so an explicit sign-in loads the ACCOUNT character even when a newer
   *  guest/other-device local save exists (your account owns the hero, not the
   *  device). Same-owner copies still resolve by newest `t`. */
  acct?: string
}

const LOCAL_KEY = 'blocklings_save_v1'
const ORIGIN = 'https://blockle.org'
const DEBOUNCE_MS = 2_000
const AUTOSAVE_MS = 30_000
const ACCOUNT_MIN_GAP_MS = 15_000
const TOAST_MIN_GAP_MS = 180_000
const MAX_BYTES = 12_288

function isEnvelope(x: unknown): x is SaveEnvelope {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false
  const e = x as Record<string, unknown>
  return e.v === 1 && typeof e.t === 'number' && typeof e.mods === 'object' && e.mods !== null
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

// ---------------------------------------------------------------------------
// Blockle account client (bearer token or browser cookie; never throws out)
// ---------------------------------------------------------------------------

function bearerToken(): string | null {
  try {
    return localStorage.getItem('blk_token')
  } catch {
    return null
  }
}

/** CSRF from /account/api/me — cookie-session PUTs require it; bearer doesn't. */
let csrf: string | null = null
let sessionOk = false
/** True only when THIS session signed in explicitly (gates all account sync). */
let accountEnabled = false
/** The signed-in account's stable id (sub/username), captured from /me. Tags
 *  every envelope so we can tell "my account's hero" from a guest/other save. */
let accountId: string | null = null
// CRITICAL safety: for a signed-in session we must NOT write the account's cloud
// OR local slot until bootAccountSync has CONFIRMED the character state (loaded the
// existing hero, or verified the account is genuinely new). Otherwise a transient
// character-fetch failure at boot leaves the in-memory hero at defaults and a save
// would overwrite the real save with an empty character — the "reset" bug.
let loadConfirmed = false

async function accountFetch(
  method: 'GET' | 'PUT',
  path: string,
  body?: unknown,
  keepalive = false
): Promise<Record<string, unknown> | null> {
  const headers: Record<string, string> = { 'x-blockle-client': 'blocklings' }
  const token = bearerToken()
  if (token) headers['Authorization'] = 'Bearer ' + token
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (method !== 'GET' && !token && csrf) headers['x-csrf-token'] = csrf
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 10_000) : null
  try {
    const init: RequestInit = {
      method,
      headers,
      credentials: token ? 'omit' : 'include',
      keepalive
    }
    if (body !== undefined) init.body = JSON.stringify(body)
    if (ctrl) init.signal = ctrl.signal
    const r = await fetch(ORIGIN + path, init)
    if (!r.ok) return null
    return (await r.json()) as Record<string, unknown>
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

let api: GameAPI | null = null
let bootPos: import('three').Vector3 | null = null
let pendingMods: Record<string, unknown> = {}
let dirty = false
let accountDirty = false
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let lastAccountPut = 0
let lastToast = 0
let saveCount = 0
let inited = false

const TOASTS = [
  'Saved. Your questionable life choices are now permanent.',
  'Progress saved. The universe reluctantly remembers you.',
  'Saved. Even the bad haircut.',
  'Game saved. No take-backsies.'
]

/** Build the current envelope from live state + all registered providers. */
function buildEnvelope(): SaveEnvelope {
  const p = api!.player
  const mods: Record<string, unknown> = {}
  // Carry forward blobs for modules that saved before but haven't registered
  // this boot (e.g. feature-flagged off) so their progress isn't dropped.
  for (const [k, v] of Object.entries(pendingMods)) mods[k] = v
  for (const [key, prov] of saveRegistry.providers) {
    try {
      mods[key] = prov.dump()
    } catch (e) {
      console.error(`[save] provider '${key}' dump() threw`, e)
    }
  }
  const env: SaveEnvelope = {
    v: 1,
    t: Date.now(),
    name: p.name,
    pos: [round1(p.pos.x), round1(p.pos.z)],
    hp: Math.round(p.hp),
    mp: Math.round(p.mp),
    mods
  }
  // Stamp ownership so the account copy is recognizable across devices.
  if (accountId) env.acct = accountId
  return env
}

/** Apply the player-level fields of an envelope to live state. */
function applyPlayer(env: SaveEnvelope): void {
  const p = api!.player
  if (typeof env.name === 'string' && env.name.trim()) p.name = env.name.trim().slice(0, 24)
  if (Array.isArray(env.pos) && env.pos.length === 2) {
    const [x, z] = env.pos
    if (Number.isFinite(x) && Number.isFinite(z) && !api!.world.isBlocked(x, z)) {
      p.pos.set(x, api!.world.groundHeight(x, z), z)
    }
  }
  // DON'T clamp to p.maxHp/maxMp here: at load time these are still the BASE
  // defaults (100/50) — vitality/skills recompute the real maxima a moment
  // later (applyVitality on 'save:applied'). Clamping now capped a vitality
  // hero's saved 250/300 HP down to 100, which read as "HP reverts to 100 on
  // reopen". We only floor; the real cap is applied once maxHp is known.
  if (Number.isFinite(env.hp)) p.hp = Math.max(1, env.hp)
  if (Number.isFinite(env.mp)) p.mp = Math.max(0, env.mp)
}

/** Apply an envelope: player fields now, mod blobs to whoever has registered
 *  (the rest stay stashed for late-binding apply on register).
 *  `withPlayer:false` skips position/hp — used when the account copy resolves
 *  AFTER play has begun, so a slow network can never teleport the player. */
function applyEnvelope(env: SaveEnvelope, withPlayer = true): void {
  if (withPlayer) applyPlayer(env)
  pendingMods = { ...env.mods }
  for (const [key, prov] of saveRegistry.providers) {
    if (key in pendingMods) {
      const data = pendingMods[key]
      delete pendingMods[key]
      try {
        prov.load(data)
      } catch (e) {
        console.error(`[save] provider '${key}' load() threw`, e)
      }
    }
  }
  // Skills/vitality just changed — tell consumers to recompute derived state.
  // Critical cross-device: the async account sync applies here, LONG after the
  // boot-time character-level sync ran, so without this the hero shows Lv 1.
  events.emit('save:applied', {})
}

// Per-account local slot: once signed in, the cache key is scoped to the account
// id so two emails on the SAME device never share a character. Guests use the
// bare key. `activeKey` is promoted to the account-scoped key the moment the
// session establishes (see bootAccountSync).
const acctKey = (id: string): string => `${LOCAL_KEY}:acct:${id}`
let activeKey = LOCAL_KEY

function readLocal(key: string = activeKey): SaveEnvelope | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isEnvelope(parsed) ? parsed : null
  } catch {
    return null
  }
}

function writeLocal(env: SaveEnvelope): string {
  const json = JSON.stringify(env)
  if (json.length > MAX_BYTES) {
    console.warn(`[save] envelope is ${json.length}B (budget ${MAX_BYTES}B) — trim provider dumps`)
  }
  // Signed in but the account-scoped key isn't established yet, OR the character
  // hasn't been confirmed-loaded → DON'T write. Writing defaults to the shared
  // slot leaked characters across emails; writing defaults to the account slot
  // could win over the real cloud save on the next boot. Both are the "reset" bug.
  if (accountEnabled && (activeKey === LOCAL_KEY || !loadConfirmed)) return json
  try {
    localStorage.setItem(activeKey, json)
  } catch {
    /* quota/private mode — account copy still gets it */
  }
  return json
}

/**
 * Establish (or re-establish) the account session: confirm /account/api/me and
 * capture the CSRF token. Idempotent and retryable — a transient boot hiccup no
 * longer permanently wedges `sessionOk=false` (which used to silently no-op every
 * cloud push for the rest of the session, the cross-device data-loss bug). Only
 * ever runs for an EXPLICITLY signed-in session; guests stay local-only.
 */
let establishing: Promise<boolean> | null = null
async function ensureSession(): Promise<boolean> {
  if (!accountEnabled) return false
  if (sessionOk) return true
  if (establishing) return establishing
  establishing = (async () => {
    const me = await accountFetch('GET', '/account/api/me')
    if (me && me.user) {
      if (typeof me.csrf === 'string') csrf = me.csrf
      const user = me.user as Record<string, unknown>
      // /me returns { id, email, username, sub(=SUBSCRIPTION obj, NOT an id) }.
      // Use the stable user id (fallback email/username) — NEVER `sub`, which is
      // a truthy object that silently defeated this and left every email sharing
      // one local slot (the "same character across emails" bug).
      const id = user.id ?? user.email ?? user.username
      if (typeof id === 'string' && id) {
        accountId = id
        activeKey = acctKey(id) // from now on, local cache is this account's slot
      }
      sessionOk = true
      return true
    }
    return false
  })()
  try {
    return await establishing
  } finally {
    establishing = null
  }
}

async function pushAccount(env: SaveEnvelope, keepalive = false): Promise<void> {
  if (!accountEnabled) return // guest / local-only — never touch the account
  if (!loadConfirmed) { accountDirty = true; return } // not safe to write yet
  // Lazily (re)establish the session so a transient boot failure can't disable
  // cloud sync for the whole session. keepalive (page-hide) flushes skip the
  // async /me round-trip and rely on an already-established session.
  if (!sessionOk) {
    if (keepalive || !(await ensureSession())) {
      accountDirty = true
      return
    }
  }
  const now = Date.now()
  if (!keepalive && now - lastAccountPut < ACCOUNT_MIN_GAP_MS) {
    accountDirty = true
    return
  }
  lastAccountPut = now
  accountDirty = false
  const r = await accountFetch('PUT', '/account/api/game/character', { character: env }, keepalive)
  if (!r) accountDirty = true // retry on a later tick
}

/** The real save: envelope → localStorage (sync) + account (async, throttled). */
function doSave(keepalive = false): void {
  if (!api) return
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  dirty = false
  const env = buildEnvelope()
  writeLocal(env)
  void pushAccount(env, keepalive)
  saveCount++
  const now = Date.now()
  if (saveCount > 1 && now - lastToast > TOAST_MIN_GAP_MS) {
    lastToast = now
    events.emit('chat:system', { text: TOASTS[saveCount % TOASTS.length]! })
  }
}

/** Boot-time account sync. The character is attached to the EMAIL, not the device.
 *
 *  Characters are stored per-account both in the cloud and in a per-account local
 *  slot (`activeKey`, promoted to acctKey once the session establishes). The cloud
 *  copy is authoritative; the per-account local slot is just an offline cache for
 *  THIS email. Because the slot is account-scoped, a different email on the same
 *  device can never see or adopt this character — fixing the "same character across
 *  multiple emails" bug. The game booted at defaults (initSave does NOT apply the
 *  shared guest slot for signed-in sessions), so an email with no cloud character
 *  simply keeps those defaults as its fresh hero. */
let syncing = false
async function bootAccountSync(): Promise<void> {
  if (syncing || loadConfirmed) return
  syncing = true
  try {
    if (!(await ensureSession())) return
    // activeKey is now the account slot — read THIS email's cached character only.
    const localA = readLocal(activeKey)
    const r = await accountFetch('GET', '/account/api/game/character')
    // FETCH FAILED (null = non-OK / network error, NOT a genuine empty character,
    // which is `{character:null}`). Do NOT load defaults and do NOT confirm — bail
    // so the cloud save is never overwritten; the autosave belt retries this.
    if (!r) return
    const remote: unknown = r.character
    // Player fields only if the player hasn't started moving yet — a slow account
    // fetch must never teleport someone mid-adventure (mods still apply).
    const moved = (): boolean => (bootPos ? api!.player.pos.distanceTo(bootPos) > 1.5 : true)

    if (isEnvelope(remote)) {
      // Offline progress this device made (same email) that the cloud hasn't seen.
      if (localA && localA.t >= remote.t) {
        applyEnvelope(localA, !moved())
        loadConfirmed = true
        void pushAccount(buildEnvelope())
        return
      }
      const owned: SaveEnvelope =
        accountId && remote.acct !== accountId ? { ...remote, acct: accountId } : remote
      applyEnvelope(owned, !moved())
      writeLocal(owned)
      loadConfirmed = true
      events.emit('chat:system', { text: 'Cloud save loaded. Welcome back, you beautiful disaster.' })
    } else if (localA) {
      // No cloud copy yet but this email has an offline cache here — use it + seed.
      applyEnvelope(localA, !moved())
      loadConfirmed = true
      void pushAccount(buildEnvelope())
    } else {
      // Fetch SUCCEEDED and there is genuinely no character anywhere for this email
      // (cloud + local empty) → brand-new hero. Confirm + run character creation.
      loadConfirmed = true
      events.emit('save:needsCreator', {})
      void pushAccount(buildEnvelope())
    }
  } finally {
    syncing = false
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Force an immediate save (local + account). */
export function saveNow(): void {
  doSave()
}

/**
 * Initialize persistence. MUST be called first among the stateful modules
 * (after world + player state exist on the GameAPI).
 */
export function initSave(gameApi: GameAPI, signedIn = false): { saveNow(): void } {
  if (inited) return { saveNow }
  inited = true
  api = gameApi
  // Only an EXPLICIT Blockle sign-in this session enables account cloud-sync.
  // A lingering `blk_token` on a device (e.g. after choosing Guest) must NOT
  // auto-pull someone's account — that's the no-auto-login rule.
  accountEnabled = signedIn

  // 1) Load the local envelope and apply what we can right now. For a SIGNED-IN
  //    boot we must NOT apply the shared guest slot — it may belong to a different
  //    email on this device. The account's own character loads a moment later from
  //    the cloud / its per-account slot (bootAccountSync). Guests use the slot.
  if (!accountEnabled) {
    const local = readLocal(LOCAL_KEY)
    if (local) applyEnvelope(local)
  }

  // 2) Late-binding apply: hand each module its blob the moment it registers.
  const origRegister = saveRegistry.register.bind(saveRegistry)
  saveRegistry.register = (key: string, p: SaveProvider): void => {
    origRegister(key, p)
    if (key in pendingMods) {
      const data = pendingMods[key]
      delete pendingMods[key]
      try {
        p.load(data)
      } catch (e) {
        console.error(`[save] provider '${key}' load() threw`, e)
      }
    }
  }

  // 3) Account copy (async, never blocks the game) — ONLY when explicitly
  //    signed in this session. Guest / lingering-token boots stay local.
  bootPos = gameApi.player.pos.clone()
  if (accountEnabled) void bootAccountSync()

  // 4) Debounced writes on 'save:dirty'.
  events.on('save:dirty', () => {
    dirty = true
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => doSave(), DEBOUNCE_MS)
  })

  // 5) Belt: autosave every 30s (position drifts without emitting dirty) and
  //    flush any throttled account push.
  setInterval(() => {
    // Signed-in but the character hasn't been confirmed-loaded yet (boot fetch
    // failed / still pending) → keep retrying the load. NEVER save until it's
    // confirmed, so a transient failure can't overwrite the real save.
    if (accountEnabled && !loadConfirmed) {
      void bootAccountSync()
      return
    }
    if (dirty) {
      doSave()
    } else {
      const env = buildEnvelope()
      writeLocal(env)
      // Flush a throttled push, OR recover a never-established session: a
      // signed-in session that failed to establish at boot (network hiccup)
      // keeps retrying here so the cloud copy isn't silently abandoned.
      if (accountDirty || (accountEnabled && !sessionOk)) void pushAccount(env)
    }
  }, AUTOSAVE_MS)

  // 6) Suspenders: flush on pagehide/backgrounding (keepalive PUT survives).
  const flush = (): void => doSave(true)
  window.addEventListener('pagehide', flush)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })

  return { saveNow }
}
