// Blockle encrypted-backup envelope (v1) — the client-side crypto for zero-knowledge wallet
// backup. The vault is encrypted HERE with a key derived from the user's *backup passphrase*;
// only the opaque envelope leaves the device (see docs/ACCOUNTS.md §3). The server never sees
// the passphrase or key and cannot decrypt. This exact format is mirrored byte-for-byte in
// python/blockle/backup_crypto.py and blockle-app/lib/multichain/backup_crypto.dart so a backup
// made on any wallet restores on any other (verified by docs/backup-vectors.json).
//
// Envelope: base64url( utf8( JSON {v,kdf,iter,salt,nonce,ct} ) )
//   kdf   = PBKDF2-HMAC-SHA256, iter iterations, 32-byte key   (symmetric → post-quantum safe)
//   cipher= AES-256-GCM, 12-byte nonce, AAD = "blockle-backup-v1", ct = ciphertext||tag (b64)
// Works in the extension (global BLKBackup) and under Node (module.exports).
(function (global) {
  const subtle = (global.crypto || globalThis.crypto).subtle;
  const ITER = 600000;
  const AAD = new TextEncoder().encode('blockle-backup-v1');

  const u8 = (s) => new TextEncoder().encode(s);
  const fromU8 = (b) => new TextDecoder().decode(b);
  const hasBuffer = typeof Buffer !== 'undefined';
  function b64(bytes) {
    if (hasBuffer) return Buffer.from(bytes).toString('base64');
    let s = ''; const a = new Uint8Array(bytes); for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s);
  }
  function unb64(str) {
    if (hasBuffer) return new Uint8Array(Buffer.from(str, 'base64'));
    const s = atob(str); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a;
  }
  function b64url(bytes) { return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_'); }
  function unb64url(str) { return unb64(str.replace(/-/g, '+').replace(/_/g, '/')); }

  async function deriveKey(passphrase, salt, iter) {
    const base = await subtle.importKey('raw', u8(passphrase), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  // opts.salt / opts.nonce (Uint8Array) only for deterministic test vectors; omit in production.
  async function encryptVault(passphrase, plaintext, opts = {}) {
    const salt = opts.salt || global.crypto.getRandomValues(new Uint8Array(16));
    const nonce = opts.nonce || global.crypto.getRandomValues(new Uint8Array(12));
    const iter = opts.iter || ITER;
    const key = await deriveKey(passphrase, salt, iter);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: AAD }, key, u8(plaintext)));
    const env = { v: 1, kdf: 'pbkdf2-sha256', iter, salt: b64(salt), nonce: b64(nonce), ct: b64(ct) };
    return b64url(u8(JSON.stringify(env)));
  }

  async function decryptVault(passphrase, blob) {
    const env = JSON.parse(fromU8(unb64url(blob)));
    if (env.v !== 1 || env.kdf !== 'pbkdf2-sha256') throw new Error('unsupported backup version');
    const key = await deriveKey(passphrase, unb64(env.salt), env.iter);
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.nonce), additionalData: AAD }, key, unb64(env.ct));
    return fromU8(new Uint8Array(pt));
  }

  const api = { encryptVault, decryptVault, ITER, _b64, _b64url };
  function _b64(b) { return b64(b); }
  function _b64url(b) { return b64url(b); }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.BLKBackup = api;
})(typeof window !== 'undefined' ? window : globalThis);
