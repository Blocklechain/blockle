/**
 * Blockle accounts client — Blocklings signs in as a NATIVE CLIENT (bearer
 * token, `x-blockle-client: blocklings`) against the shared accounts service
 * at https://blockle.org/account/api, exactly like the wallet's
 * backup-client.js and the 2D app's account_service.dart.
 *
 * Endpoints used:
 *   POST /account/api/login     { email, password, totp? } -> { token, user }
 *   POST /account/api/register  { email, password, username? } -> { message }
 *   GET  /account/api/me        (Bearer) -> { user: { username|handle|email, sub? } }
 *
 * Every call resolves to an ApiResult — this module NEVER throws out, and
 * status 0 means "network unreachable" (offline / DNS / timeout) so callers
 * can tell "wrong password" from "no internet".
 */

const ORIGIN = 'https://blockle.org'
const CLIENT = 'blocklings'
const TIMEOUT_MS = 12_000

/** Uniform API outcome. `status === 0` = network failure, not a server reply. */
export interface ApiResult {
  ok: boolean
  status: number
  data: Record<string, unknown>
}

async function req(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
  token?: string | null
): Promise<ApiResult> {
  const headers: Record<string, string> = { 'x-blockle-client': CLIENT }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers['Authorization'] = 'Bearer ' + token
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null
  try {
    const init: RequestInit = { method, headers, credentials: 'omit' }
    if (body !== undefined) init.body = JSON.stringify(body)
    if (ctrl) init.signal = ctrl.signal
    const r = await fetch(ORIGIN + path, init)
    let data: Record<string, unknown> = {}
    try {
      data = (await r.json()) as Record<string, unknown>
    } catch {
      /* empty / non-JSON body */
    }
    return { ok: r.ok, status: r.status, data }
  } catch {
    return { ok: false, status: 0, data: {} }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Sign in. On success `data.token` (string) and usually `data.user`. */
export function login(email: string, password: string, totp?: string): Promise<ApiResult> {
  const body: Record<string, unknown> = { email, password }
  if (totp && totp.trim()) body.totp = totp.trim()
  return req('POST', '/account/api/login', body)
}

/** Create an account. On success `data.message` (verify-email prompt). */
export function register(email: string, password: string, username?: string): Promise<ApiResult> {
  const body: Record<string, unknown> = { email, password }
  if (username && username.trim()) body.username = username.trim()
  return req('POST', '/account/api/register', body)
}

/** The signed-in profile for a bearer token. */
export function me(token: string): Promise<ApiResult> {
  return req('GET', '/account/api/me', undefined, token)
}

/** Human error text from an API reply ('' when the server said nothing). */
export function errorText(r: ApiResult): string {
  const e = r.data.error ?? r.data.message
  return typeof e === 'string' ? e : ''
}

/**
 * Did the server reject this sign-in because it wants a 2FA code?
 * Detected via an explicit flag or the error text mentioning totp/2fa.
 */
export function needsTotp(r: ApiResult): boolean {
  if (r.ok) return false
  if (r.data.totpRequired === true || r.data.needs2fa === true) return true
  return /totp|2fa|two.?factor|authenticator|verification code/i.test(errorText(r))
}

/**
 * Account display name from a `user` object (login/me replies), the same
 * precedence the 2D app uses: username > handle > email. Trimmed to the
 * 24-char character-name budget. null when there is no usable name.
 */
export function displayNameOf(user: unknown): string | null {
  if (!user || typeof user !== 'object') return null
  const u = user as Record<string, unknown>
  for (const k of ['username', 'handle', 'displayName', 'email']) {
    const v = u[k]
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 24)
  }
  return null
}
