import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runCheckup, passwordStrength, compareVersions, pwnedPasswordCount } from '../src/index.js'

test('passwordStrength: weak vs strong', () => {
  assert.equal(passwordStrength('abc').score, 0)
  assert.equal(passwordStrength('password1').score, 1)
  assert.equal(passwordStrength('Tr0ub4dour&3xplore!!').score, 4)
  assert.ok(passwordStrength('abc').suggestions.length > 0)
})

test('compareVersions', () => {
  assert.equal(compareVersions('18.1.1', '18.2'), -1)
  assert.equal(compareVersions('18.2', '18.1.9'), 1)
  assert.equal(compareVersions('17.0', '17.0.0'), 0)
})

test('runCheckup: all clear → grade A', () => {
  const c = runCheckup({ passcodeSet: true, biometricsEnrolled: true, jailbroken: false, appTampered: false, osVersion: '18.2', latestOsVersion: '18.2', protectedFilesFailing: 0, recoveryConfigured: true, advancedDataProtection: true, pwnedPasswordHits: 0 })
  assert.equal(c.grade, 'A')
  assert.equal(c.findings.length, 1)
  assert.equal(c.findings[0]!.severity, 'ok')
})

test('runCheckup: critical jailbreak dominates + low score', () => {
  const c = runCheckup({ jailbroken: true, passcodeSet: false, pwnedPasswordHits: 3 })
  assert.equal(c.findings[0]!.severity, 'critical')       // worst first
  assert.equal(c.findings[0]!.id, 'jailbreak')
  assert.ok(c.score < 40 && c.grade === 'F')
  // every finding carries a next step
  for (const f of c.findings) assert.ok(f.nextStep.length > 0)
})

test('runCheckup: breached password → high finding with rotate fix', () => {
  const c = runCheckup({ passcodeSet: true, pwnedPasswordHits: 52373976 })
  const pwned = c.findings.find((f) => f.id === 'pwned')
  assert.ok(pwned && pwned.severity === 'high')
  assert.deepEqual(pwned!.fix, { kind: 'rotatePassword' })
})

test('runCheckup: out-of-date OS flagged', () => {
  const c = runCheckup({ passcodeSet: true, osVersion: '17.4', latestOsVersion: '18.2' })
  assert.ok(c.findings.some((f) => f.id === 'os' && f.severity === 'high'))
})

test('pwnedPasswordCount: k-anonymity match via mock (password never sent in full)', async () => {
  // SHA-1("password") = 5BAA6 1E4C9B93F3F0682250B6CF8331B7EE68FD8
  const mockFetch = (async (url: string | URL | Request) => {
    assert.ok(String(url).endsWith('/range/5BAA6'), 'only the 5-char prefix is sent')
    return { ok: true, text: async () => '0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n1E4C9B93F3F0682250B6CF8331B7EE68FD8:52373976\r\n' }
  }) as unknown as typeof fetch
  const n = await pwnedPasswordCount('password', mockFetch)
  assert.equal(n, 52373976)
  const miss = (async () => ({ ok: true, text: async () => 'ABCDEF0000000000000000000000000000000:7\r\n' })) as unknown as typeof fetch
  assert.equal(await pwnedPasswordCount('a-unique-unbreached-pass', miss), 0)
})
