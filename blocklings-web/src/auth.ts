/**
 * Auth module — Blockle-account login for Blocklings (MMO front door).
 *
 * Shows the title screen at boot, signs the player in against the shared
 * accounts service (https://blockle.org/account/api, native-client bearer
 * pattern), stores the token in localStorage 'blk_token' (the save module
 * already reads that key for cloud character sync), and emits 'auth:changed'
 * so the integrator can set the character name to the account display name.
 *
 * Flows:
 *   - restore: existing 'blk_token' -> GET /me -> "Welcome back, X" panel.
 *     401/403 -> token cleared, forms shown. Network down -> last-known name
 *     gets an offline "Enter World" (token kept; save syncs when back).
 *   - sign in: POST /login (2FA code field appears when the API asks).
 *   - register: POST /register -> verify-email notice -> sign-in tab.
 *   - OFFLINE GUEST: always available; local-only save, gentle periodic nag.
 *
 * Integration (integrator wires, no module imports):
 *   initAuth(uiMount) once at boot; on 'auth:changed' {signedIn:true, name}
 *   set player.name = name. Settings hooks: the returned AuthAPI.signOut
 *   (also exported standalone) and window.blocklingsSignOut.
 */
import { events } from './events'
import {
  login,
  register,
  me,
  errorText,
  needsTotp,
  displayNameOf,
  type ApiResult
} from './auth/client'
import { createTitleScreen, type TitleScreen } from './auth/title'

const TOKEN_KEY = 'blk_token'
const NAME_KEY = 'blk_name'
const GUEST_NAG_MS = 15 * 60_000

export interface AuthAPI {
  /** Signed in with a Blockle account (false = offline guest). */
  signedIn(): boolean
  /** Account display name (character name), null as guest. */
  displayName(): string | null
  /** Settings hook: sign out and return to the title screen. */
  signOut(): Promise<void>
  /** Re-show the title screen without clearing the session. */
  showTitle(): void
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let title: TitleScreen | null = null
let signed = false
let name: string | null = null
let guestNag: ReturnType<typeof setInterval> | null = null
let inited = false

function store(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* private mode — session just won't persist */
  }
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function stopGuestNag(): void {
  if (guestNag) {
    clearInterval(guestNag)
    guestNag = null
  }
}

/** Gentle, non-blocking reminders that guest progress is device-local. */
function startGuestNag(): void {
  stopGuestNag()
  events.emit('chat:system', {
    text: 'Offline guest mode: progress saves to THIS device only. A Blockle account would remember you anywhere.'
  })
  guestNag = setInterval(() => {
    events.emit('chat:system', {
      text: 'Still adventuring as a guest — sign in sometime so the cloud can worry about your save instead of you.'
    })
  }, GUEST_NAG_MS)
}

/** Title fades, world entry proceeds, 'auth:changed' tells everyone. */
function finishEntry(asSignedIn: boolean): void {
  signed = asSignedIn
  if (asSignedIn && name) events.emit('auth:changed', { signedIn: true, name })
  else events.emit('auth:changed', { signedIn: asSignedIn })
  title?.hide()
  if (asSignedIn) stopGuestNag()
  else startGuestNag()
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

async function doSignIn(email: string, password: string, totp?: string): Promise<void> {
  const t = title!
  t.setBusy(true)
  const r = await login(email, password, totp)
  t.setBusy(false)
  const token = r.data.token
  if (r.ok && typeof token === 'string' && token) {
    store(TOKEN_KEY, token)
    name = displayNameOf(r.data.user) ?? (await nameFromMe(token)) ?? email.slice(0, 24)
    store(NAME_KEY, name)
    finishEntry(true)
    return
  }
  if (needsTotp(r)) {
    t.showTotp()
    t.showError(totp ? 'That code didn’t work — try a fresh one.' : 'Enter your 6-digit authenticator code.')
    return
  }
  if (r.status === 0) {
    t.showError('Can’t reach blockle.org — check your connection, or play offline below.')
    return
  }
  t.showError(errorText(r) || 'Sign-in failed. The gate remains shut.')
}

async function nameFromMe(token: string): Promise<string | null> {
  const r = await me(token)
  if (!r.ok) return null
  return displayNameOf(r.data.user)
}

async function doRegister(username: string, email: string, password: string): Promise<void> {
  const t = title!
  t.setBusy(true)
  const r = await register(email, password, username)
  t.setBusy(false)
  if (r.ok) {
    t.switchTab('signin')
    t.prefillEmail(email)
    t.showNotice(
      errorText(r) || 'Account created — check your email to verify, then sign in.'
    )
    return
  }
  if (r.status === 0) {
    t.showError('Can’t reach blockle.org — check your connection, or play offline below.')
    return
  }
  t.showError(errorText(r) || 'Could not create the account.')
}

/** Boot-time session restore. */
async function restore(): Promise<void> {
  const t = title!
  const token = read(TOKEN_KEY)
  if (!token) {
    t.showForms()
    return
  }
  const r: ApiResult = await me(token)
  if (r.ok) {
    name = displayNameOf(r.data.user) ?? read(NAME_KEY)
    if (name) store(NAME_KEY, name)
    t.showWelcome(name ?? 'Adventurer')
    return
  }
  if (r.status === 401 || r.status === 403) {
    // stale/revoked token — honest reset
    store(TOKEN_KEY, null)
    t.showForms()
    t.showNotice('Session expired — sign in again, hero.')
    return
  }
  // Network unreachable: keep the token; the save module will sync when the
  // connection returns. Offer entry under the last-known name if we have one.
  const last = read(NAME_KEY)
  if (last) {
    name = last
    t.showWelcome(last, 'Can’t reach blockle.org right now — you can still enter; your save will sync when it’s back.')
  } else {
    t.showForms()
    t.showNotice('Can’t reach blockle.org — Offline Guest still works.')
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sign out: clear the stored session, announce it, return to the title
 * screen. Exported standalone so the settings UI can be handed this hook.
 */
export async function signOut(): Promise<void> {
  const wasSigned = signed
  store(TOKEN_KEY, null)
  store(NAME_KEY, null)
  signed = false
  name = null
  stopGuestNag()
  // Pre-entry "switch account" must not read as a world entry downstream —
  // 'auth:changed' only fires here when a signed-in session actually ends.
  if (wasSigned) events.emit('auth:changed', { signedIn: false })
  if (title) {
    title.show()
    title.showForms()
  }
}

/**
 * Boot the auth module: mounts the title screen into the UI overlay and
 * starts session restore. Call once, before world entry matters.
 */
export function initAuth(mount: HTMLElement): AuthAPI {
  if (!inited) {
    inited = true
    title = createTitleScreen(mount, {
      signIn: (email, password, totp) => {
        void doSignIn(email, password, totp)
      },
      register: (username, email, password) => {
        void doRegister(username, email, password)
      },
      guest: () => finishEntry(false),
      enterWorld: () => finishEntry(true),
      switchAccount: () => {
        void signOut()
      }
    })
    title.show()
    void restore()
    // Duck-typed settings hook, same pattern as blocklingsSetQuality.
    ;(window as unknown as Record<string, unknown>).blocklingsSignOut = signOut
  }
  return {
    signedIn: () => signed,
    displayName: () => name,
    signOut,
    showTitle: () => title?.show()
  }
}
