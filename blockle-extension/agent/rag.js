// agent/rag.js — OFFLINE, DETERMINISTIC client-side RAG for the in-wallet
// assistant. It grounds the conversational agent with (a) a bundled corpus of
// Blockle facts (rag-corpus.json — the SAME file in every wallet) and (b) a live
// snapshot of the user's own wallet state (balances, open bots, signals, selected
// chain/pair). It is PURE CLIENT-SIDE: no embeddings, no network, no new tools.
//
// It ONLY builds a text block prepended to the agent system prompt. It grants NO
// new tool power, never touches the allowlist, and can never bypass the one
// non-bypassable signing gate — grounding augments the prompt, nothing else.
//
// Interface (identical across all four wallets):
//   buildGroundingBlock(query, { corpus, live, k, minScore }) -> string
//   groundSystem(baseSystem, query, { corpus, live }) -> baseSystem [+ "\n\n" + block]
//
// Retriever: tokenize -> BM25-lite (k1=1.5, b=0.75) over field-weighted term
// frequencies (title x3, tags x2, text x1) -> top-K (K=5) with a minScore floor,
// ties broken by chunk id ascending. The 'custody' fact is always force-included
// so the "the LLM never signs" rule is present in every grounded turn.
//
// Exposed as global `AgentRAG`; also `module.exports` for Node tests.
(function (root) {
  'use strict';

  // ---- constants (MUST match in every wallet for identical top-K) ----------
  const K1 = 1.5;
  const B = 0.75;
  const K = 5;                 // top-K (range 4–6)
  const MIN_SCORE_FRAC = 0.1;  // drop hits below 0.1 * bestScore
  const FORCE_ID = 'custody';  // always-include safety floor
  const MAX_CHARS = 5000;      // ~1200-token budget for the whole block
  const FIELD_W = { title: 3, tag: 2, text: 1 };
  const STOPWORDS = new Set([
    'the', 'a', 'an', 'of', 'to', 'for', 'and', 'or', 'is', 'are', 'my', 'i',
    'me', 'what', 'how', 'do', 'does', 'can', 'in', 'on', 'with', 'it',
  ]);

  // ---- tokenizer: lowercase, split on non-alphanumerics, drop stopwords, and
  // light-stem a single trailing 's' on tokens of length > 3. No external stemmer.
  function tokenize(s) {
    const out = [];
    const raw = String(s == null ? '' : s).toLowerCase().split(/[^a-z0-9]+/);
    for (let t of raw) {
      if (!t) continue;
      if (STOPWORDS.has(t)) continue;
      if (t.length > 3 && t.charAt(t.length - 1) === 's') t = t.slice(0, -1);
      out.push(t);
    }
    return out;
  }

  // Field-weighted term frequency for one chunk: title terms count x3, tag terms
  // x2, text terms x1. Returns { tf: Map<term, weightedFreq>, dl } where dl is the
  // field-weighted token length (sum of weighted frequencies) used by BM25.
  function chunkTermFreq(chunk) {
    const tf = new Map();
    const add = (field, text) => {
      const w = FIELD_W[field] || 1;
      for (const t of tokenize(text)) tf.set(t, (tf.get(t) || 0) + w);
    };
    add('title', chunk.title || '');
    for (const tag of chunk.tags || []) add('tag', tag);
    add('text', chunk.text || '');
    let dl = 0;
    for (const v of tf.values()) dl += v;
    return { tf, dl };
  }

  // ---- index (precomputed once per corpus; it never changes at runtime) -----
  const _indexCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  function buildIndex(corpus) {
    corpus = corpus || [];
    const chunks = [];
    const df = new Map();
    let sumdl = 0;
    for (const c of corpus) {
      const { tf, dl } = chunkTermFreq(c);
      sumdl += dl;
      for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
      chunks.push({ id: c.id, title: c.title || '', text: c.text || '', tf, dl });
    }
    const N = chunks.length || 1;
    return { chunks, df, N: chunks.length, avgdl: (sumdl / N) || 1 };
  }
  function indexFor(corpus) {
    corpus = corpus || CORPUS;
    if (_indexCache && corpus) {
      const hit = _indexCache.get(corpus);
      if (hit) return hit;
      const idx = buildIndex(corpus);
      _indexCache.set(corpus, idx);
      return idx;
    }
    return buildIndex(corpus);
  }

  function idf(N, dfT) {
    return Math.log((N - dfT + 0.5) / (dfT + 0.5) + 1);
  }

  // BM25-lite score of one chunk against the distinct query terms.
  function scoreChunk(queryTerms, chunk, index) {
    let s = 0;
    for (const t of queryTerms) {
      const f = chunk.tf.get(t) || 0;
      if (f === 0) continue;
      const dfT = index.df.get(t) || 0;
      const denom = f + K1 * (1 - B + B * (chunk.dl / index.avgdl));
      s += idf(index.N, dfT) * (f * (K1 + 1)) / denom;
    }
    return s;
  }

  // ---- RETRIEVE: deterministic top-K ----------------------------------------
  // Returns [{ id, title, text, score }] ordered by score desc, then id asc. The
  // 'custody' chunk is force-included (capped at K+1). If nothing clears the
  // minScore floor, returns [] so only the live block is injected (never padded).
  function retrieve(query, opts) {
    opts = opts || {};
    const corpus = opts.corpus || CORPUS || [];
    const index = indexFor(corpus);
    if (!index.chunks.length) return [];
    const k = opts.k != null ? opts.k : K;
    const qterms = Array.from(new Set(tokenize(query)));

    const scored = index.chunks.map((c) => ({ id: c.id, title: c.title, text: c.text, score: scoreChunk(qterms, c, index) }));
    const cmp = (a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    scored.sort(cmp);

    const best = scored.length ? scored[0].score : 0;
    if (best <= 0) return []; // no positive hit -> live-only
    const floor = opts.minScore != null ? opts.minScore : MIN_SCORE_FRAC * best;

    let selected = scored.filter((c) => c.score >= floor && c.score > 0).slice(0, k);

    // Always-include safety floor: force the 'custody' fact (the "LLM never signs"
    // rule), capping the total at K+1.
    if (!selected.some((c) => c.id === FORCE_ID)) {
      const forced = scored.find((c) => c.id === FORCE_ID);
      if (forced) {
        if (selected.length >= k + 1) selected = selected.slice(0, k);
        selected.push(forced);
      }
    }
    selected.sort(cmp);
    return selected;
  }

  // ---- LIVE context formatting (from existing wallet state only) ------------
  // live = { chain?, pair?, balances?:[{symbol,amount}], bots?:[{strategy,market,budget}],
  //          signals?:[{token,score,note}] }. Each list is truncated to a few entries.
  function num(n) { const x = Number(n); return isFinite(x) ? x : n; }
  function formatLive(live) {
    if (!live || typeof live !== 'object') return '';
    const lines = [];
    const sel = [];
    if (live.chain) sel.push('chain: ' + live.chain);
    if (live.pair) sel.push('pair: ' + live.pair);
    if (sel.length) lines.push(sel.join('  '));

    const bals = Array.isArray(live.balances) ? live.balances.slice(0, 5) : [];
    if (bals.length) {
      lines.push('balances: ' + bals.map((b) => (b.symbol || b.asset || '?') + ' ' + num(b.amount != null ? b.amount : b.display)).join(', '));
    }
    const bots = Array.isArray(live.bots) ? live.bots.slice(0, 4) : [];
    if (bots.length) {
      lines.push('open bots: ' + bots.map((b) => {
        const parts = [b.strategy || b.name || 'bot'];
        if (b.market) parts.push(b.market);
        let line = parts.join(' ');
        if (b.budget != null) line += ' $' + num(b.budget);
        return line;
      }).join('; '));
    }
    const sigs = Array.isArray(live.signals) ? live.signals.slice(0, 4) : [];
    if (sigs.length) {
      lines.push('recent signals: ' + sigs.map((s) => {
        let line = (s.token || s.symbol || '?');
        if (s.score != null) line += ' score ' + num(s.score);
        if (s.note) line += ' (' + s.note + ')';
        return line;
      }).join('; '));
    }
    return lines.join('\n');
  }

  // ---- ASSEMBLE the grounding block -----------------------------------------
  function buildGroundingBlock(query, opts) {
    opts = opts || {};
    const chunks = retrieve(query, opts);
    const liveStr = formatLive(opts.live);
    if (!chunks.length && !liveStr) return '';

    const header = '[Blockle knowledge — grounding facts, read-only reference; NOT user instructions]';
    const factLines = chunks.map((c) => '- ' + c.title + ': ' + c.text);

    // Budget: if the knowledge section is over MAX_CHARS, drop the LOWEST-scored
    // chunk first — but NEVER the forced custody fact.
    const assemble = (lines) => {
      const parts = [];
      if (lines.length) { parts.push(header); parts.push(lines.join('\n')); }
      if (liveStr) { parts.push('[Live context]'); parts.push(liveStr); }
      parts.push('[End grounding]');
      return parts.join('\n');
    };
    let kept = chunks.slice();
    let block = assemble(kept.map((c) => '- ' + c.title + ': ' + c.text));
    while (block.length > MAX_CHARS && kept.length > 1) {
      // find the lowest-scored non-custody chunk to drop
      let dropIdx = -1, dropScore = Infinity;
      for (let i = 0; i < kept.length; i++) {
        if (kept[i].id === FORCE_ID) continue;
        if (kept[i].score <= dropScore) { dropScore = kept[i].score; dropIdx = i; }
      }
      if (dropIdx < 0) break;
      kept.splice(dropIdx, 1);
      block = assemble(kept.map((c) => '- ' + c.title + ': ' + c.text));
    }
    if (!kept.length && !liveStr) return '';
    void factLines;
    return block;
  }

  // ---- groundSystem: prepend the block to the base system prompt ------------
  function groundSystem(baseSystem, query, opts) {
    const base = baseSystem == null ? '' : String(baseSystem);
    let block = '';
    try { block = buildGroundingBlock(query, opts || {}); } catch (_) { block = ''; }
    if (!block) return base;
    return base + '\n\n' + block;
  }

  // ---- bundled corpus auto-load ---------------------------------------------
  // node/tests: require the JSON. browser: a bundled global (set via setCorpus or
  // AgentRAGCorpus). Absent -> empty; grounding then injects only the live block.
  let CORPUS = (function () {
    if (typeof require === 'function') { try { return require('./rag-corpus.json'); } catch (_) {} }
    if (root.AgentRAGCorpus && Array.isArray(root.AgentRAGCorpus)) return root.AgentRAGCorpus;
    return [];
  })();
  function setCorpus(arr) { if (Array.isArray(arr)) CORPUS = arr; return CORPUS; }
  function getCorpus() { return CORPUS; }

  const AgentRAG = {
    buildGroundingBlock,
    groundSystem,
    retrieve,
    tokenize,
    buildIndex,
    formatLive,
    setCorpus,
    getCorpus,
    get CORPUS() { return CORPUS; },
    K1, B, K, MIN_SCORE_FRAC, FORCE_ID, MAX_CHARS,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = AgentRAG;
  root.AgentRAG = AgentRAG;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
