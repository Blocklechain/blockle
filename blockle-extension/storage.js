// storage.js — a tiny storage shim that uses chrome.storage.local inside the
// extension and falls back to localStorage when run as a plain web page (so the
// exact same UI can be previewed outside the extension sandbox).
(function (global) {
  const hasChrome =
    typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  // Page fallbacks exist only in a window/document context. In a service worker
  // (background.js) neither `localStorage` nor `sessionStorage` is defined — the
  // chrome.* paths are always taken there, but we still guard so a mis-load in a
  // worker throws a clear error instead of a bare ReferenceError.
  const hasLocalStorage = typeof localStorage !== 'undefined';
  const noFallback = () => {
    throw new Error('Store: no storage backend (chrome.storage.local unavailable and no window localStorage)');
  };

  const Store = {
    async get(keys) {
      if (hasChrome) return chrome.storage.local.get(keys);
      if (!hasLocalStorage) return noFallback();
      const out = {};
      const list = Array.isArray(keys) ? keys : keys == null ? null : [keys];
      if (list == null) {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith('blk:')) out[k.slice(4)] = safeParse(localStorage.getItem(k));
        }
        return out;
      }
      for (const k of list) {
        const v = localStorage.getItem('blk:' + k);
        if (v != null) out[k] = safeParse(v);
      }
      return out;
    },
    async set(obj) {
      if (hasChrome) return chrome.storage.local.set(obj);
      if (!hasLocalStorage) return noFallback();
      for (const [k, v] of Object.entries(obj)) {
        localStorage.setItem('blk:' + k, JSON.stringify(v));
      }
    },
    async remove(keys) {
      if (hasChrome) return chrome.storage.local.remove(keys);
      if (!hasLocalStorage) return noFallback();
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) localStorage.removeItem('blk:' + k);
    },
  };

  // Ephemeral session store — this is where DECRYPTED SECRETS live while the
  // wallet is unlocked (the HD seed, per-chain private material, the agent
  // passphrase). It must NEVER be disk-backed.
  //
  // In the extension we use chrome.storage.session, which is held in memory for
  // the life of the browser session and is NOT written to disk.
  //
  // Outside the extension (a plain web-page preview of the same UI, or a test
  // harness) the ONLY fallback is an in-process Map. We deliberately do NOT fall
  // back to window.sessionStorage: browsers persist sessionStorage to disk for
  // crash/session restore, which would leave decrypted seeds and private keys on
  // disk in a web deploy. The in-memory Map is cleared when the page context is
  // torn down and never touches disk — the correct, fail-safe behaviour for a
  // secrets store. (The preview simply won't survive a full page reload, which
  // is the intended, safe tradeoff.)
  const hasSession =
    typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session;
  const memSession = new Map();
  const Session = {
    async get(key) {
      if (hasSession) return (await chrome.storage.session.get(key))[key];
      return memSession.get(key);
    },
    async set(key, value) {
      if (hasSession) return chrome.storage.session.set({ [key]: value });
      memSession.set(key, value);
    },
    async clear(key) {
      if (hasSession) return chrome.storage.session.remove(key);
      memSession.delete(key);
    },
  };

  function safeParse(s) {
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  }

  global.Store = Store;
  global.Session = Session;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
