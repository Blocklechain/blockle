// agent/rag-load.js — BROWSER corpus loader for the client-side RAG layer.
//
// agent/rag.js auto-loads the bundled corpus via require('./rag-corpus.json') in
// Node (tests). In the extension there is no require, so this tiny loader fetches
// the SAME packaged rag-corpus.json (a same-origin extension resource — NOT a
// network call to any server) and installs it as the AgentRAG corpus. Until it
// resolves, grounding degrades gracefully to live-only; the fetch completes long
// before the user issues a command. Node ignores this file.
(function (root) {
  'use strict';
  if (typeof fetch === 'undefined' || !root.AgentRAG || typeof root.AgentRAG.setCorpus !== 'function') return;
  var url = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
    ? chrome.runtime.getURL('agent/rag-corpus.json')
    : 'agent/rag-corpus.json';
  try {
    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (arr) {
        if (Array.isArray(arr) && arr.length) {
          root.AgentRAGCorpus = arr;
          root.AgentRAG.setCorpus(arr);
        }
      })
      .catch(function () { /* grounding falls back to live-only */ });
  } catch (_) { /* no-op */ }
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
