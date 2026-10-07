// vault.js — password-derived encryption of the wallet secret, using WebCrypto
// (PBKDF2-SHA256 → AES-256-GCM). Works in the extension and as a plain page.
// Exposed as global `Vault`.
(function (global) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const KDF_ITERS = 310000;

  function b64(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
  }
  function unb64(s) {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  }

  async function deriveKey(password, salt) {
    const base = await crypto.subtle.importKey(
      'raw',
      enc.encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: KDF_ITERS, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  const Vault = {
    // plaintext (object) + password -> { v, salt, iv, data } (all base64)
    async seal(obj, password) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await deriveKey(password, salt);
      const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        enc.encode(JSON.stringify(obj))
      );
      return { v: 1, salt: b64(salt), iv: b64(iv), data: b64(ct) };
    },

    // sealed + password -> object (throws on wrong password)
    async open(sealed, password) {
      const key = await deriveKey(password, unb64(sealed.salt));
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: unb64(sealed.iv) },
        key,
        unb64(sealed.data)
      );
      return JSON.parse(dec.decode(pt));
    },
  };

  global.Vault = Vault;
  global.VaultUtil = { b64, unb64 };
})(typeof self !== 'undefined' ? self : window);
