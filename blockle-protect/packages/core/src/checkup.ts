/**
 * Security Checkup — an honest device + account health scan.
 *
 * What this is NOT: a virus scanner that reads your whole device. On iOS that is
 * impossible (apps are sandboxed) and prohibited. What it IS: a set of real,
 * high-value checks the platform actually permits, each turned into a plain
 * finding with a next step and — where the OS allows — a one-tap fix.
 *
 * The scoring engine (runCheckup) is pure and deterministic. The only networked
 * check, pwnedPasswordCount, uses k-anonymity: it sends a 5-char hash PREFIX, so
 * the password itself never leaves the device.
 */
import { sha1 } from '@noble/hashes/legacy'
import { toHex } from './encoding.js'

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'ok'

/** A one-tap fix the UI can offer, interpreted per platform. */
export type FixAction =
  | { kind: 'openSettings'; target: 'passcode' | 'biometrics' | 'softwareUpdate' | 'wifi' | 'advancedDataProtection' }
  | { kind: 'rotatePassword' }
  | { kind: 'reprotectFiles' }
  | { kind: 'updateApp' }
  | { kind: 'reviewDevice' }

export interface Finding {
  id: string
  title: string
  severity: Severity
  detail: string // what we found
  why: string //    why it matters
  nextStep: string // what to do about it
  fix?: FixAction //  one-tap fix, if the platform supports it
}

/** Signals collected by the platform layer (iOS/macOS/web) + prior scans.
 *  Every field is optional — a check is simply skipped when its signal is
 *  absent, so the engine degrades gracefully across platforms. */
export interface PostureSignals {
  jailbroken?: boolean //            device shows signs of jailbreak/root
  appTampered?: boolean //           app binary / debugger integrity check failed
  passcodeSet?: boolean //           a device passcode is set
  biometricsEnrolled?: boolean //    Face ID / Touch ID enrolled
  osVersion?: string //              e.g. "18.1.1"
  latestOsVersion?: string //        latest known (server-fed)
  advancedDataProtection?: boolean // Apple ADP enabled
  protectedFilesChecked?: number //  files the integrity monitor checked
  protectedFilesFailing?: number //  of those, how many failed verification
  pwnedPasswordHits?: number //      breach count from a prior pwnedPasswordCount run
  recoveryConfigured?: boolean //    a recovery key / contact is set up
}

export interface Checkup {
  score: number // 0–100
  grade: 'A' | 'B' | 'C' | 'D' | 'F'
  findings: Finding[] // worst first
  summary: string
}

const PENALTY: Record<Severity, number> = { critical: 45, high: 22, medium: 10, low: 4, ok: 0 }
const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, ok: 4 }

/** Privacy-preserving breach check (HaveIBeenPwned Pwned Passwords, k-anonymity).
 *  Only the first 5 hex chars of SHA-1(password) are sent; the response is a list
 *  of suffixes we match locally. Returns the number of times the password has
 *  appeared in known breaches (0 = not found). `fetchImpl` is injectable for
 *  tests/offline. */
export async function pwnedPasswordCount(
  password: string,
  fetchImpl: typeof fetch = fetch
): Promise<number> {
  const hash = toHex(sha1(new TextEncoder().encode(password))).toUpperCase()
  const prefix = hash.slice(0, 5)
  const suffix = hash.slice(5)
  const res = await fetchImpl(`https://api.pwnedpasswords.com/range/${prefix}`, {
    headers: { 'Add-Padding': 'true' } // defeats response-size fingerprinting
  })
  if (!res.ok) throw new Error(`pwned range lookup failed: ${res.status}`)
  const body = await res.text()
  for (const line of body.split('\n')) {
    const [suf, count] = line.trim().split(':')
    if (suf === suffix) return Number(count) || 0
  }
  return 0
}

export interface PasswordStrength {
  score: 0 | 1 | 2 | 3 | 4 // 0 very weak … 4 strong
  label: 'very weak' | 'weak' | 'fair' | 'good' | 'strong'
  suggestions: string[]
}

/** Heuristic password strength (length + character classes). Not a substitute
 *  for a breach check — a long unique password can still be breached. */
export function passwordStrength(password: string): PasswordStrength {
  const len = password.length
  const classes =
    (/[a-z]/.test(password) ? 1 : 0) +
    (/[A-Z]/.test(password) ? 1 : 0) +
    (/[0-9]/.test(password) ? 1 : 0) +
    (/[^A-Za-z0-9]/.test(password) ? 1 : 0)
  let score: PasswordStrength['score'] = 0
  if (len >= 8 && classes >= 2) score = 1
  if (len >= 12 && classes >= 3) score = 2
  if (len >= 14 && classes >= 3) score = 3
  if (len >= 16 && classes >= 4) score = 4
  const suggestions: string[] = []
  if (len < 16) suggestions.push('Use at least 16 characters.')
  if (classes < 4) suggestions.push('Mix upper, lower, numbers and symbols — or use a passphrase.')
  const labels = ['very weak', 'weak', 'fair', 'good', 'strong'] as const
  return { score, label: labels[score], suggestions }
}

/** Compare dotted version strings. <0 if a older than b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

/** Turn collected signals into a graded checkup with prioritized, actionable
 *  findings. Pure + deterministic. */
export function runCheckup(s: PostureSignals): Checkup {
  const f: Finding[] = []

  if (s.jailbroken === true)
    f.push({ id: 'jailbreak', title: 'Device appears jailbroken', severity: 'critical',
      detail: 'This device shows signs of a jailbreak or root.', why: 'Jailbreaking removes the sandbox that keeps your encrypted files and keys isolated from other apps.',
      nextStep: 'Back up and restore this device to stock iOS before storing sensitive files.', fix: { kind: 'reviewDevice' } })

  if (s.appTampered === true)
    f.push({ id: 'tamper', title: 'App integrity check failed', severity: 'critical',
      detail: 'Blockle Protect detected that its own binary may have been modified or is being debugged.', why: 'A tampered app can leak keys. We halt sensitive operations when this is detected.',
      nextStep: 'Delete and reinstall Blockle Protect from the App Store.', fix: { kind: 'updateApp' } })

  if (s.passcodeSet === false)
    f.push({ id: 'passcode', title: 'No device passcode', severity: 'high',
      detail: 'This device has no passcode set.', why: 'Without a passcode, the Secure Enclave cannot protect your keys and anyone with the device can open it.',
      nextStep: 'Set a passcode in Settings.', fix: { kind: 'openSettings', target: 'passcode' } })

  if (s.pwnedPasswordHits !== undefined && s.pwnedPasswordHits > 0)
    f.push({ id: 'pwned', title: 'A password you use was found in data breaches', severity: 'high',
      detail: `This password appears in ${s.pwnedPasswordHits.toLocaleString()} known breaches.`, why: 'Breached passwords are the #1 way accounts get taken over by automated attacks.',
      nextStep: 'Change it everywhere you use it, and never reuse passwords.', fix: { kind: 'rotatePassword' } })

  if (s.osVersion && s.latestOsVersion && compareVersions(s.osVersion, s.latestOsVersion) < 0)
    f.push({ id: 'os', title: 'Your operating system is out of date', severity: 'high',
      detail: `You're on ${s.osVersion}; the latest is ${s.latestOsVersion}.`, why: 'Most device compromises exploit security holes that a software update already fixes.',
      nextStep: 'Install the latest update in Settings → General → Software Update.', fix: { kind: 'openSettings', target: 'softwareUpdate' } })

  if (s.protectedFilesFailing !== undefined && s.protectedFilesFailing > 0)
    f.push({ id: 'integrity', title: `${s.protectedFilesFailing} protected file(s) failed verification`, severity: 'high',
      detail: 'Some of your protected files no longer match their signed record.', why: 'A file that changed unexpectedly could be corruption — or tampering.',
      nextStep: 'Review the changes; restore the protected copy if the change was not yours.', fix: { kind: 'reprotectFiles' } })

  if (s.biometricsEnrolled === false)
    f.push({ id: 'biometrics', title: 'Face ID / Touch ID is not set up', severity: 'medium',
      detail: 'Biometric unlock is not enrolled on this device.', why: 'Biometrics let you lock your vault strongly without typing a passcode constantly.',
      nextStep: 'Enroll Face ID or Touch ID in Settings.', fix: { kind: 'openSettings', target: 'biometrics' } })

  if (s.recoveryConfigured === false)
    f.push({ id: 'recovery', title: 'No recovery method set up', severity: 'medium',
      detail: 'You have not set up a recovery key or recovery contact.', why: 'If you lose this device with no recovery method, your protected files cannot be restored — by design, there is no backdoor.',
      nextStep: 'Set up your recovery key and store it safely.', fix: { kind: 'reviewDevice' } })

  if (s.advancedDataProtection === false)
    f.push({ id: 'adp', title: 'Apple Advanced Data Protection is off', severity: 'low',
      detail: 'ADP end-to-end-encrypts more of your iCloud data.', why: 'Blockle Protect secures your protected files regardless, but ADP strengthens the rest of iCloud.',
      nextStep: 'Consider enabling Advanced Data Protection in your Apple ID settings.', fix: { kind: 'openSettings', target: 'advancedDataProtection' } })

  let score = 100
  for (const x of f) score -= PENALTY[x.severity]
  score = Math.max(0, Math.min(100, score))

  if (f.length === 0)
    f.push({ id: 'allclear', title: 'No issues found', severity: 'ok',
      detail: 'Your device posture and protected files look healthy.', why: 'Good security hygiene is the best defense against automated attacks.',
      nextStep: 'Keep your OS and app up to date, and run a checkup regularly.' })

  f.sort((a, b) => RANK[a.severity] - RANK[b.severity])
  const grade: Checkup['grade'] = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F'
  const worst = f[0]!.severity
  const summary =
    worst === 'ok' ? 'All clear — your protection looks healthy.'
      : worst === 'critical' ? 'Critical issues need your attention now.'
        : worst === 'high' ? 'A few important things to fix.'
          : 'Looking good — minor improvements available.'
  return { score, grade, findings: f, summary }
}
