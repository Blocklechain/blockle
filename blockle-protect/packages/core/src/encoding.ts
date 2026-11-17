/**
 * Encoding helpers. Canonical JSON gives a single deterministic byte string for
 * any object (sorted keys, no insignificant whitespace), so a manifest signed
 * on iOS verifies byte-for-byte in the browser and the backend.
 */
import type { Bytes } from './primitives.js'

const enc = new TextEncoder()
const dec = new TextDecoder()

export function utf8(s: string): Bytes {
  return enc.encode(s)
}
export function fromUtf8(b: Bytes): string {
  return dec.decode(b)
}

export function toBase64Url(b: Bytes): string {
  let bin = ''
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]!)
  const b64 = (typeof btoa === 'function' ? btoa(bin) : Buffer.from(b).toString('base64'))
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(s: string): Bytes {
  const pad = (4 - (s.length % 4)) % 4
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad)
  if (typeof atob === 'function') {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

export function toHex(b: Bytes): string {
  let s = ''
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, '0')
  return s
}

export function concatBytes(...arrays: Bytes[]): Bytes {
  let len = 0
  for (const a of arrays) len += a.length
  const out = new Uint8Array(len)
  let off = 0
  for (const a of arrays) {
    out.set(a, off)
    off += a.length
  }
  return out
}

export function bytesEqual(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0 // constant-time compare
}

/**
 * RFC 8785-style canonical JSON: object keys sorted lexicographically, arrays
 * preserved, no extra whitespace. Numbers must be finite integers/plain floats;
 * we keep manifests to strings + integers to stay deterministic across runtimes.
 */
export function canonicalJsonBytes(value: unknown): Bytes {
  return utf8(canonicalJson(value))
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('canonicalJson: non-finite number')
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}'
  }
  throw new Error('canonicalJson: unsupported value type ' + typeof value)
}
