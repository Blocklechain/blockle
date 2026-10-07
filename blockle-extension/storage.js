// storage.js — a tiny storage shim that uses chrome.storage.local inside the
// extension and falls back to localStorage when run as a plain web page (so the
// exact same UI can be previewed outside the extension sandbox).
(function (global) {
  const hasChrome =
    typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

  const Store = {
    async get(keys) {
      if (hasChrome) return chrome.storage.local.get(keys);
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
      for (const [k, v] of Object.entries(obj)) {
        localStorage.setItem('blk:' + k, JSON.stringify(v));
      }
    },
    async remove(keys) {
      if (hasChrome) return chrome.storage.local.remove(keys);
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) localStorage.removeItem('blk:' + k);
    },
  };

  // Ephemeral, in-memory session storage (cleared when the browser closes):
  // chrome.storage.session in the extension, sessionStorage as a page fallback.
  const hasSession =
    typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session;
  const Session = {
    async get(key) {
      if (hasSession) return (await chrome.storage.session.get(key))[key];
      const v = sessionStorage.getItem('blks:' + key);
      return v == null ? undefined : safeParse(v);
    },
    async set(key, value) {
      if (hasSession) return chrome.storage.session.set({ [key]: value });
      sessionStorage.setItem('blks:' + key, JSON.stringify(value));
    },
    async clear(key) {
      if (hasSession) return chrome.storage.session.remove(key);
      sessionStorage.removeItem('blks:' + key);
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
})(typeof self !== 'undefined' ? self : window);
