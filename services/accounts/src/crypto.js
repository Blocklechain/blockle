// Security primitives for Blockle accounts. Node built-in crypto only — zero native deps.
// Nothing here ever sees a wallet key or seed; the zero-knowledge backup is encrypted on the
// client and the server only stores opaque ciphertext (see store.js / server.js).
import crypto from 'node:crypto';

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

// --- password hashing (scrypt) --------------------------------------------------------------
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(Buffer.from(String(password), 'utf8'), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltHex, keyHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(keyHex, 'hex');
    const key = crypto.scryptSync(Buffer.from(String(password), 'utf8'), salt,
      expected.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
    // timingSafeEqual requires equal length; expected.length is fixed so this is safe.
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

// --- tokens (sessions, email verification, password reset) ----------------------------------
export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

// Tokens are stored only as SHA-256 digests; a DB leak never yields a usable token.
export function sha256(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

export function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ab.length !== bb.length) {
    // compare against self to keep timing independent of the length mismatch
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

// --- TOTP (RFC 6238, SHA-1, 6 digits, 30s) --------------------------------------------------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/=+$/,'').replace(/\s/g,'');
  let bits = 0, value = 0; const out = [];
  for (const c of clean) {
    const idx = B32.indexOf(c);
    if (idx === -1) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

export function totpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secretB32, counter) {
  const key = base32Decode(secretB32);
  const buf = Buffer.alloc(8);
  // counter is < 2^53; write as big-endian 64-bit
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

// The current 6-digit code for a secret at a given time (used by clients/tests).
export function totpCode(secretB32, atMs) {
  return hotp(secretB32, Math.floor((atMs ?? safeNow()) / 1000 / 30));
}

// Accepts the current 30s step +/- `window` steps to tolerate clock skew.
export function totpVerify(secretB32, code, atMs, window = 1) {
  const step = Math.floor((atMs ?? safeNow()) / 1000 / 30);
  const given = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return false;
  for (let w = -window; w <= window; w++) {
    if (timingSafeEqualStr(hotp(secretB32, step + w), given)) return true;
  }
  return false;
}

export function totpUri(secretB32, account, issuer = 'Blockle') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// Recovery codes: 10 single-use codes, stored hashed.
export function genRecoveryCodes(n = 10) {
  return Array.from({ length: n }, () =>
    crypto.randomBytes(5).toString('hex').replace(/(.{5})(.{5})/, '$1-$2'));
}

// Date.now is fine in the service runtime (only workflow scripts forbid it).
export function safeNow() { return Date.now(); }
