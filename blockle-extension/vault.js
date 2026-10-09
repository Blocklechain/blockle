// vault.js — password-sealed encryption of wallet secrets.
//
// The vault holds the entire secret state as one authenticated-encrypted blob:
//   - the BLOCK identity (ML-DSA-44 keypair) — post-quantum,
//   - the HD seed for every secp256k1 chain (EVM / BTC / LTC / DOGE) — ECDSA,
//   - and any private settings (agent credential, endpoints, token list).
// The vault is format-agnostic: seal(obj) protects whatever plaintext object
// it is given; the shape is defined by wallet.js / the accounts module.
//
// IMPORTANT (honest scoping): the vault is a STORAGE property, not a signature
// property. Sealing a BTC/LTC/DOGE/EVM key in a memory-hard vault does NOT make
// that key post-quantum — those chains sign with ECDSA (secp256k1). Only the
// BLOCK chain's on-chain signatures are post-quantum (ML-DSA-44). The vault
// hardens every key against OFFLINE theft of the stored blob; it says nothing
// about the on-chain signature scheme.
//
// Crypto:
//   v2 (current) — scrypt (RFC 7914, memory-hard) → AES-256-GCM (AEAD).
//   v1 (legacy)  — PBKDF2-SHA256/310k → AES-256-GCM. Still opens; callers
//                  transparently re-seal as v2 on the next successful unlock.
//
// scrypt is implemented here in self-contained JS (Salsa20/8 + BlockMix + ROMix)
// using WebCrypto's PBKDF2-HMAC-SHA256 for the two PBKDF2 passes — no external
// dependency, so it satisfies the extension's strict CSP. Runs in the extension,
// as a plain web page, and under Node (for the unit tests).
//
// Exposed as global `Vault`.
(function (global) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // Legacy v1 KDF cost (only used to OPEN old blobs).
  const PBKDF2_ITERS = 310000;

  // v2 KDF cost. scrypt N=2^14, r=8, p=1 ≈ 16 MiB of memory-hard work per guess
  // — the standard "interactive" setting. Params are stored in the sealed blob
  // so they can evolve without breaking existing vaults.
  const SCRYPT = { N: 16384, r: 8, p: 1 };
  const KEY_LEN = 32; // AES-256

  function b64(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
  }
  function unb64(s) {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  }

  // --- scrypt (RFC 7914) ---------------------------------------------------

  function rotl(a, b) {
    return (a << b) | (a >>> (32 - b));
  }

  // Salsa20/8 core: 8 rounds over a 64-byte block held as 16 LE uint32 words.
  function salsa20_8(B) {
    const x = new Uint32Array(16);
    for (let i = 0; i < 16; i++) x[i] = B[i];
    for (let i = 8; i > 0; i -= 2) {
      x[4] ^= rotl((x[0] + x[12]) >>> 0, 7);
      x[8] ^= rotl((x[4] + x[0]) >>> 0, 9);
      x[12] ^= rotl((x[8] + x[4]) >>> 0, 13);
      x[0] ^= rotl((x[12] + x[8]) >>> 0, 18);
      x[9] ^= rotl((x[5] + x[1]) >>> 0, 7);
      x[13] ^= rotl((x[9] + x[5]) >>> 0, 9);
      x[1] ^= rotl((x[13] + x[9]) >>> 0, 13);
      x[5] ^= rotl((x[1] + x[13]) >>> 0, 18);
      x[14] ^= rotl((x[10] + x[6]) >>> 0, 7);
      x[2] ^= rotl((x[14] + x[10]) >>> 0, 9);
      x[6] ^= rotl((x[2] + x[14]) >>> 0, 13);
      x[10] ^= rotl((x[6] + x[2]) >>> 0, 18);
      x[3] ^= rotl((x[15] + x[11]) >>> 0, 7);
      x[7] ^= rotl((x[3] + x[15]) >>> 0, 9);
      x[11] ^= rotl((x[7] + x[3]) >>> 0, 13);
      x[15] ^= rotl((x[11] + x[7]) >>> 0, 18);
      x[1] ^= rotl((x[0] + x[3]) >>> 0, 7);
      x[2] ^= rotl((x[1] + x[0]) >>> 0, 9);
      x[3] ^= rotl((x[2] + x[1]) >>> 0, 13);
      x[0] ^= rotl((x[3] + x[2]) >>> 0, 18);
      x[6] ^= rotl((x[5] + x[4]) >>> 0, 7);
      x[7] ^= rotl((x[6] + x[5]) >>> 0, 9);
      x[4] ^= rotl((x[7] + x[6]) >>> 0, 13);
      x[5] ^= rotl((x[4] + x[7]) >>> 0, 18);
      x[11] ^= rotl((x[10] + x[9]) >>> 0, 7);
      x[8] ^= rotl((x[11] + x[10]) >>> 0, 9);
      x[9] ^= rotl((x[8] + x[11]) >>> 0, 13);
      x[10] ^= rotl((x[9] + x[8]) >>> 0, 18);
      x[12] ^= rotl((x[15] + x[14]) >>> 0, 7);
      x[13] ^= rotl((x[12] + x[15]) >>> 0, 9);
      x[14] ^= rotl((x[13] + x[12]) >>> 0, 13);
      x[15] ^= rotl((x[14] + x[13]) >>> 0, 18);
    }
    for (let i = 0; i < 16; i++) B[i] = (B[i] + x[i]) >>> 0;
  }

  // BlockMix on 2r 64-byte sub-blocks (B,Y: Uint32Array length 32*r).
  function blockMix(B, Y, r) {
    const X = new Uint32Array(16);
    X.set(B.subarray((2 * r - 1) * 16, (2 * r - 1) * 16 + 16));
    for (let i = 0; i < 2 * r; i++) {
      for (let j = 0; j < 16; j++) X[j] ^= B[i * 16 + j];
      salsa20_8(X);
      Y.set(X, i * 16);
    }
    for (let i = 0; i < r; i++) {
      B.set(Y.subarray(i * 2 * 16, i * 2 * 16 + 16), i * 16);
      B.set(Y.subarray((i * 2 + 1) * 16, (i * 2 + 1) * 16 + 16), (i + r) * 16);
    }
  }

  // ROMix on one 128*r-byte block (B: Uint32Array length 32*r). N power of 2.
  function roMix(B, N, r) {
    const stride = 32 * r;
    const X = new Uint32Array(B);
    const Y = new Uint32Array(stride);
    const V = new Uint32Array(stride * N);
    for (let i = 0; i < N; i++) {
      V.set(X, i * stride);
      blockMix(X, Y, r);
    }
    for (let i = 0; i < N; i++) {
      const j = X[(2 * r - 1) * 16] & (N - 1); // Integerify mod N
      const off = j * stride;
      for (let k = 0; k < stride; k++) X[k] ^= V[off + k];
      blockMix(X, Y, r);
    }
    B.set(X);
  }

  function bytesToWordsLE(bytes) {
    const w = new Uint32Array(bytes.length >>> 2);
    for (let i = 0; i < w.length; i++) {
      const o = i * 4;
      w[i] =
        (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
    }
    return w;
  }
  function wordsToBytesLE(w) {
    const b = new Uint8Array(w.length * 4);
    for (let i = 0; i < w.length; i++) {
      const v = w[i], o = i * 4;
      b[o] = v & 0xff;
      b[o + 1] = (v >>> 8) & 0xff;
      b[o + 2] = (v >>> 16) & 0xff;
      b[o + 3] = (v >>> 24) & 0xff;
    }
    return b;
  }

  async function pbkdf2(passwordBytes, saltBytes, iters, dkLenBytes) {
    const key = await crypto.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: saltBytes, iterations: iters, hash: 'SHA-256' },
      key,
      dkLenBytes * 8
    );
    return new Uint8Array(bits);
  }

  // scrypt(password, salt, N, r, p) -> Uint8Array(KEY_LEN)
  async function scrypt(password, salt, N, r, p, dkLen) {
    const pw = enc.encode(password);
    const stride = 32 * r; // uint32 words per block
    const B = await pbkdf2(pw, salt, 1, p * 128 * r);
    const words = bytesToWordsLE(B);
    for (let i = 0; i < p; i++) {
      roMix(words.subarray(i * stride, (i + 1) * stride), N, r);
    }
    return pbkdf2(pw, wordsToBytesLE(words), 1, dkLen);
  }

  // --- key import ----------------------------------------------------------

  async function aesKeyFromRaw(raw) {
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  // Legacy v1 derivation (PBKDF2 directly to an AES-GCM key).
  async function aesKeyPbkdf2(password, salt, iters) {
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  // Resolve the KDF descriptor for a sealed blob, defaulting legacy blobs
  // (no `kdf` field, v:1 or unset) to PBKDF2.
  function kdfOf(sealed) {
    if (sealed && sealed.kdf && sealed.kdf.name) return sealed.kdf;
    return { name: 'pbkdf2', params: { iters: PBKDF2_ITERS } };
  }

  async function keyFor(sealed, password, salt) {
    const kdf = kdfOf(sealed);
    if (kdf.name === 'scrypt') {
      const p = kdf.params || SCRYPT;
      const dk = await scrypt(password, salt, p.N, p.r, p.p, KEY_LEN);
      return aesKeyFromRaw(dk);
    }
    if (kdf.name === 'pbkdf2') {
      return aesKeyPbkdf2(password, salt, (kdf.params && kdf.params.iters) || PBKDF2_ITERS);
    }
    throw new Error('vault: unknown kdf "' + kdf.name + '"');
  }

  const Vault = {
    // plaintext (object) + password -> SealedVault:
    //   { v:2, kdf:{name,params}, salt, iv, data }  (salt/iv/data base64)
    async seal(obj, password) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const dk = await scrypt(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, KEY_LEN);
      const key = await aesKeyFromRaw(dk);
      const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        enc.encode(JSON.stringify(obj))
      );
      return {
        v: 2,
        kdf: { name: 'scrypt', params: { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p } },
        salt: b64(salt),
        iv: b64(iv),
        data: b64(ct),
      };
    },

    // sealed + password -> object. Throws on a wrong password (the AES-GCM
    // auth tag fails to verify — there is no decryption oracle beyond that).
    async open(sealed, password) {
      const salt = unb64(sealed.salt);
      const key = await keyFor(sealed, password, salt);
      let pt;
      try {
        pt = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: unb64(sealed.iv) },
          key,
          unb64(sealed.data)
        );
      } catch (e) {
        // GCM tag mismatch (wrong password / tampered blob). Normalize the error.
        throw new Error('wrong password');
      }
      return JSON.parse(dec.decode(pt));
    },

    // True if a sealed blob is not in the current (v2 / scrypt) format and
    // should be transparently re-sealed on the next unlock.
    needsUpgrade(sealed) {
      return !sealed || sealed.v !== 2 || kdfOf(sealed).name !== 'scrypt';
    },
  };

  global.Vault = Vault;
  global.VaultUtil = { b64, unb64, scrypt };
})(
  typeof self !== 'undefined'
    ? self
    : typeof window !== 'undefined'
    ? window
    : globalThis
);
