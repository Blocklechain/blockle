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
  return {
    v: 1,
    t: Date.now(),
    name: p.name,
    pos: [round1(p.pos.x), round1(p.pos.z)],
    hp: Math.round(p.hp),
    mp: Math.round(p.mp),
    mods
  }
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
  if (Number.isFinite(env.hp)) p.hp = Math.max(1, Math.min(p.maxHp, env.hp))
  if (Number.isFinite(env.mp)) p.mp = Math.max(0, Math.min(p.maxMp, env.mp))
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
}

function readLocal(): SaveEnvelope | null {
  try {
    const raw = localStorage.getItem(LOCAL_KEY)
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
  try {
    localStorage.setItem(LOCAL_KEY, json)
  } catch {
    /* quota/private mode — account copy still gets it */
  }
  return json
}

async function pushAccount(env: SaveEnvelope, keepalive = false): Promise<void> {
  if (!sessionOk) return
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

/** Boot-time account sync: if signed in and the account copy is newer, it wins. */
async function bootAccountSync(localT: number): Promise<void> {
  const me = await accountFetch('GET', '/account/api/me')
  if (!me || !me.user) return
  if (typeof me.csrf === 'string') csrf = me.csrf
  sessionOk = true
  const r = await accountFetch('GET', '/account/api/game/character')
  const remote: unknown = r?.character
  if (isEnvelope(remote) && remote.t > localT) {
    // Player fields only if the player hasn't started moving yet — a slow
    // account fetch must never teleport someone mid-adventure.
    const moved = bootPos ? api!.player.pos.distanceTo(bootPos) > 1.5 : true
    applyEnvelope(remote, !moved)
    writeLocal(remote)
    events.emit('chat:system', { text: 'Cloud save loaded. Welcome back, you beautiful disaster.' })
  } else if (dirty || localT > 0) {
    // Local is king — seed/refresh the account copy so other devices see it.
    void pushAccount(buildEnvelope())
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
export function initSave(gameApi: GameAPI): { saveNow(): void } {
  if (inited) return { saveNow }
  inited = true
  api = gameApi

  // 1) Load the local envelope and apply what we can right now.
  const local = readLocal()
  if (local) applyEnvelope(local)

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

  // 3) Account copy (async, never blocks the game).
  bootPos = gameApi.player.pos.clone()
  void bootAccountSync(local?.t ?? 0)

  // 4) Debounced writes on 'save:dirty'.
  events.on('save:dirty', () => {
    dirty = true
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => doSave(), DEBOUNCE_MS)
  })

  // 5) Belt: autosave every 30s (position drifts without emitting dirty) and
  //    flush any throttled account push.
  setInterval(() => {
    if (dirty) {
      doSave()
    } else {
      const env = buildEnvelope()
      writeLocal(env)
      if (accountDirty) void pushAccount(env)
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
