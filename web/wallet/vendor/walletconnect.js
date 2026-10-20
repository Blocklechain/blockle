// walletconnect.js — Wallet dApp Connect (WalletConnect v2, Sign API) CORE.
//
// Spec: docs/WALLET-WALLETCONNECT.md. One spec, three identical implementations:
// this is the JS reference; blockle-app/lib (Dart) + python/blockle (Python)
// port the SAME shared vectors (docs/walletconnect-vectors.json).
//
// WHAT THIS IS: the SESSION + REQUEST state machine + the SECURITY integration.
// It is PURE given an INJECTED `relay` client — the WC v2 relay transport + the
// WC crypto (x25519 + chacha20-poly1305) live behind that client and are NOT
// implemented here (tests inject a FAKE relay). The real SDK wiring + a live
// pairing smoke test are the final integration step (see §6), exactly like the
// HTLC transport.
//
// TRUST MODEL (the whole point): an external dApp is UNTRUSTED. Unlike the
// user's own bots — which may run auto within an allocation — EVERY dApp signing
// request requires explicit human approval AND runs through the wallet security
// pre-sign gate (reuses security.js inspectTransaction/decode). NO dApp request
// ever auto-approves. The core NEVER holds keys: it signs via the injected
// wallet `signer` ONLY after approval, and sessions persist NO key material.
//
// All money is base-unit / BigInt-exact.
//
// Global `WalletConnect`; module.exports for node tests. IIFE browser-global +
// module.exports pattern (matches security.js / chains/*).
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);
  const Security = inNode ? require('./security.js') : global.WalletSecurity;

  // ---- pinned JSON-RPC / state-machine error codes (shared across ports) ----
  const ERR = {
    UNAUTHORIZED: 3001,     // chain/method outside the approved namespace
    USER_REJECTED: 4001,    // a human declined the approval / danger confirm
    ETH_SIGN_DISABLED: 4100,// eth_sign refused by default (blind-sign phishing)
    SESSION_EXPIRED: 4201,  // request on an expired session
    UNKNOWN_TOPIC: 4202,    // request on a topic with no settled session
    UNSUPPORTED_CHAIN: 4203,// wallet_switch/add to a chain the wallet lacks
    BLOCKED: 5000,          // fail-closed: no approval/confirm handler wired
  };

  // The SUPPORTED + SAFE method set the wallet will ever settle into a session.
  // eth_sign is DELIBERATELY absent (refused by default, §3). Read methods are
  // answered from session state.
  const DEFAULT_METHODS = [
    'eth_sendTransaction',
    'eth_signTypedData', 'eth_signTypedData_v4', 'eth_signTypedData_v3',
    'personal_sign',
    'wallet_switchEthereumChain', 'wallet_addEthereumChain',
    'eth_accounts', 'eth_chainId',
    'solana_signTransaction', 'solana_signAndSendTransaction', 'solana_signMessage',
  ];
  const READ_METHODS = new Set(['eth_accounts', 'eth_chainId']);
  const SIGNING_METHODS = new Set([
    'eth_sendTransaction', 'eth_signTypedData', 'eth_signTypedData_v4', 'eth_signTypedData_v3',
    'personal_sign', 'solana_signTransaction', 'solana_signAndSendTransaction', 'solana_signMessage',
  ]);
  const DEFAULT_EVENTS = ['accountsChanged', 'chainChanged'];
  const DEFAULT_TTL_SECONDS = 7 * 24 * 3600;
  const DEFAULT_LONG_DEADLINE_SECONDS = 30 * 24 * 3600;

  const STORE_KEY = 'wc:sessions';

  // unlimited sentinels for off-chain (Permit / Permit2) approvals. Permit2
  // amount is uint160 (max 2^160-1 is its "infinite" sentinel); EIP-2612 value
  // is uint256 (max 2^256-1). The generic unlimitedThreshold (2^255) catches
  // uint256-style grants; the uint160 sentinel is matched explicitly so a
  // Permit2 infinite allowance is never missed.
  const MAX_UINT256 = (1n << 256n) - 1n;
  const MAX_UINT160 = (1n << 160n) - 1n;
  const MAX_UINT48 = (1n << 48n) - 1n; // Permit2 "no expiry" sentinel

  // ---- small pure helpers ---------------------------------------------------
  function toBig(v) {
    if (typeof v === 'bigint') return v;
    if (v == null || v === '') return 0n;
    const s = String(v).trim();
    if (/^0x[0-9a-fA-F]+$/.test(s)) return BigInt(s);
    if (!/^-?\d+$/.test(s)) throw new Error('not a base-unit integer: ' + s);
    return BigInt(s);
  }
  function lc(s) { return s == null ? s : String(s).toLowerCase(); }
  function uniq(arr) { return Array.from(new Set(arr)); }
  function nowSec(ms) { return Math.floor(ms / 1000); }

  function hostOf(url) {
    if (!url) return null;
    try {
      // Node + browsers both have URL; fall back to a regex if a bare host slips in.
      return new URL(url).hostname.toLowerCase();
    } catch {
      const m = String(url).replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0];
      return m ? m.toLowerCase() : null;
    }
  }

  function hexToUtf8(hex) {
    const h = String(hex).replace(/^0x/, '');
    if (h.length === 0 || h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) return null;
    const bytes = new Uint8Array(h.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    try {
      if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('utf8');
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch { return null; }
  }

  // JSON-RPC result / error shapers. handleRequest echoes the request id.
  function rpcResult(id, result) { return { id, result }; }
  function rpcError(id, code, message, data) {
    const e = { code, message };
    if (data !== undefined) e.data = data;
    return { id, error: e };
  }

  // ===========================================================================
  // 1. PAIRING URI — accept ONLY v2, reject v1 + malformed with a clear error.
  // ===========================================================================
  // wc:<topic>@2?relay-protocol=irn&symKey=<hex>
  function parsePairingUri(uri) {
    if (uri == null || typeof uri !== 'string') throw new Error('walletconnect: pairing URI must be a string');
    const s = uri.trim();
    if (!s.toLowerCase().startsWith('wc:')) {
      throw new Error('walletconnect: not a WalletConnect URI (missing wc: scheme)');
    }
    // wc:TOPIC@VERSION?query
    const body = s.slice(3);
    const at = body.indexOf('@');
    if (at < 0) throw new Error('walletconnect: malformed pairing URI (missing @version)');
    const topic = body.slice(0, at);
    const rest = body.slice(at + 1);
    const qIndex = rest.indexOf('?');
    const version = qIndex < 0 ? rest : rest.slice(0, qIndex);
    if (version === '1') {
      throw new Error('walletconnect: WalletConnect v1 URIs are not supported (deprecated + insecure) — use a v2 (@2) link');
    }
    if (version !== '2') {
      throw new Error('walletconnect: unsupported WalletConnect version "@' + version + '" (only v2 is accepted)');
    }
    if (!topic || /[^0-9a-f]/i.test(topic)) {
      throw new Error('walletconnect: malformed pairing URI (bad topic)');
    }
    const query = qIndex < 0 ? '' : rest.slice(qIndex + 1);
    const params = {};
    for (const kv of query.split('&')) {
      if (!kv) continue;
      const eq = kv.indexOf('=');
      const k = eq < 0 ? kv : kv.slice(0, eq);
      const v = eq < 0 ? '' : decodeURIComponent(kv.slice(eq + 1));
      params[k] = v;
    }
    const relayProtocol = params['relay-protocol'];
    const symKey = params['symKey'];
    if (!relayProtocol) throw new Error('walletconnect: malformed pairing URI (missing relay-protocol)');
    if (!symKey || !/^[0-9a-f]{64}$/i.test(symKey)) {
      throw new Error('walletconnect: malformed pairing URI (missing or invalid symKey)');
    }
    return { protocol: 'wc', topic, version: 2, relayProtocol, symKey };
  }

  // ===========================================================================
  // factory — all platform pieces INJECTED. relay + store + signer are mockable.
  // ===========================================================================
  function createWalletConnect(deps) {
    deps = deps || {};
    const relay = deps.relay || null;           // transport (injected; fake in tests)
    const store = deps.store || inMemoryStore(); // encrypted session store (NO keys)
    const signer = deps.signer || null;          // signs ONLY after approval
    const security = deps.security || Security;   // the wallet security suite (reused)
    const clock = typeof deps.now === 'function' ? deps.now : (() => Date.now());

    const cfg = normalizeConfig(deps.config);

    // -------------------------------------------------------------------------
    // session persistence (via the injected store; NO key material ever stored)
    // -------------------------------------------------------------------------
    async function loadAll() {
      const got = await store.get(STORE_KEY);
      const map = got ? got[STORE_KEY] : null;
      return (map && typeof map === 'object') ? map : {};
    }
    async function saveAll(map) {
      await store.set({ [STORE_KEY]: map });
    }
    async function listSessions() {
      const map = await loadAll();
      return Object.values(map);
    }
    async function getSession(topic) {
      const map = await loadAll();
      return map[topic] || null;
    }
    async function putSession(sess) {
      const map = await loadAll();
      map[sess.topic] = sess;
      await saveAll(map);
      return sess;
    }
    async function disconnect(topic, reason) {
      const map = await loadAll();
      const existed = !!map[topic];
      delete map[topic];
      await saveAll(map);
      if (existed && relay && typeof relay.disconnect === 'function') {
        try { await relay.disconnect(topic, reason); } catch (_) { /* best-effort */ }
      }
      return { topic, disconnected: existed };
    }

    // -------------------------------------------------------------------------
    // 1b. pair — hand the parsed pairing to the relay. Grants NOTHING on its own.
    // -------------------------------------------------------------------------
    async function pair(uri) {
      const parsed = parsePairingUri(uri); // throws on v1/malformed
      if (relay && typeof relay.pair === 'function') {
        await relay.pair(parsed);
      }
      return parsed;
    }

    // -------------------------------------------------------------------------
    // 2. PROPOSAL review / approve / reject
    // -------------------------------------------------------------------------
    // Flatten a WC v2 namespaces object into {chains, methods, events}. Chains
    // may be on the namespace entry (.chains) OR encoded in the key (eip155:1).
    function flattenNamespaces(ns) {
      const chains = [], methods = [], events = [];
      for (const key of Object.keys(ns || {})) {
        const entry = ns[key] || {};
        let entryChains = Array.isArray(entry.chains) ? entry.chains.slice() : [];
        if (entryChains.length === 0 && key.indexOf(':') >= 0) entryChains = [key];
        for (const c of entryChains) chains.push(c);
        for (const m of (entry.methods || [])) methods.push(m);
        for (const e of (entry.events || [])) events.push(e);
      }
      return { chains: uniq(chains), methods: uniq(methods), events: uniq(events) };
    }
    function mergedRequest(proposal) {
      const req = flattenNamespaces(proposal.requiredNamespaces);
      const opt = flattenNamespaces(proposal.optionalNamespaces);
      return {
        requiredChains: req.chains,
        chains: uniq(req.chains.concat(opt.chains)),
        methods: uniq(req.methods.concat(opt.methods)),
        events: uniq(req.events.concat(opt.events)),
      };
    }
    function namespaceIdOf(caip2) { return String(caip2).split(':')[0]; }

    function reviewProposal(proposal) {
      proposal = proposal || {};
      const dappRaw = proposal.proposer && proposal.proposer.metadata ? proposal.proposer.metadata : (proposal.dapp || proposal.metadata || {});
      // CLAIMED metadata — surfaced, NEVER trusted.
      const dapp = {
        name: dappRaw.name || null,
        url: dappRaw.url || null,
        icons: dappRaw.icons || [],
        description: dappRaw.description || null,
      };
      const m = mergedRequest(proposal);
      const warnings = [];

      const host = hostOf(dapp.url);
      if (host && (cfg.denylist.has(host) || (dapp.url && cfg.denylist.has(lc(dapp.url))))) {
        warnings.push({ code: 'dapp-domain-denylisted', severity: 'danger',
          message: 'This dApp domain is on the known-phishing / scam denylist.', evidence: { url: dapp.url, host } });
      }
      const unsupported = m.chains.filter((c) => !cfg.walletChains.has(c));
      if (unsupported.length) {
        warnings.push({ code: 'requests-unsupported-chain', severity: 'warn',
          message: 'The dApp requests chains this wallet does not control; those will not be granted.',
          evidence: { chains: unsupported } });
      }
      if (m.methods.indexOf('eth_sign') >= 0) {
        warnings.push({ code: 'requests-eth_sign', severity: 'warn',
          message: 'The dApp requests eth_sign — a blind-sign legacy method refused by default (classic phishing vector).' });
      }

      return {
        dapp,
        requiredNamespaces: proposal.requiredNamespaces || {},
        optionalNamespaces: proposal.optionalNamespaces || {},
        chains: m.chains,
        methods: m.methods,
        events: m.events,
        warnings,
        severity: maxSeverity(warnings),
      };
    }

    // approveProposal(proposal, { accounts }) — accounts are CAIP-10 the wallet
    // offers (e.g. 'eip155:1:0x..'). Build the settled namespace = requested ∩
    // wallet-controlled chains/accounts + the supported+safe method set. A
    // REQUIRED chain the wallet lacks is rejected (fail-closed); never fabricated.
    // Calling this IS the explicit user approval (the host calls it only after
    // the human approves).
    async function approveProposal(proposal, opts) {
      proposal = proposal || {};
      opts = opts || {};
      const offered = (opts.accounts || []).filter(Boolean);
      const review = reviewProposal(proposal);
      const m = mergedRequest(proposal);

      // chains the wallet actually controls = config-controlled ∩ offered-account chains
      const offeredChains = new Set(offered.map((a) => caip2OfAccount(a)));
      const controlled = new Set(
        Array.from(cfg.walletChains).filter((c) => offeredChains.has(c))
      );

      // fail-closed: a REQUIRED chain not controlled => reject the whole proposal.
      const missingRequired = m.requiredChains.filter((c) => !controlled.has(c));
      if (missingRequired.length) {
        const e = new Error('walletconnect: proposal requires chains the wallet does not control: ' + missingRequired.join(', '));
        e.code = ERR.UNSUPPORTED_CHAIN;
        e.missingRequired = missingRequired;
        throw e;
      }

      // settled chains = requested ∩ controlled (optional unsupported are simply dropped)
      const settledChains = m.chains.filter((c) => controlled.has(c));
      const settledMethods = m.methods.filter((x) => cfg.supportedMethods.has(x)); // supported+safe only
      const settledEvents = m.events.filter((x) => cfg.supportedEvents.has(x));

      // group into namespaces keyed by the caip2 namespace id (eip155, solana…)
      const namespaces = {};
      for (const c of settledChains) {
        const nsId = namespaceIdOf(c);
        if (!namespaces[nsId]) namespaces[nsId] = { chains: [], accounts: [], methods: [], events: [] };
        namespaces[nsId].chains.push(c);
      }
      for (const a of offered) {
        const c = caip2OfAccount(a);
        if (!controlled.has(c)) continue; // never expose an account on a chain we didn't settle
        const nsId = namespaceIdOf(c);
        if (namespaces[nsId]) namespaces[nsId].accounts.push(a);
      }
      // methods/events apply per-namespace (intersected with what that ns requested)
      for (const nsId of Object.keys(namespaces)) {
        namespaces[nsId].methods = uniq(settledMethods);
        namespaces[nsId].events = uniq(settledEvents);
        namespaces[nsId].chains = uniq(namespaces[nsId].chains);
        namespaces[nsId].accounts = uniq(namespaces[nsId].accounts);
      }

      const nowMs = clock();
      const ttl = (opts.ttlSeconds != null ? Number(opts.ttlSeconds) : cfg.sessionTtlSeconds);
      const topic = proposal.sessionTopic || proposal.topic || proposal.pairingTopic;
      if (!topic) throw new Error('walletconnect: proposal has no session topic');

      const session = {
        topic,
        pairingTopic: proposal.pairingTopic || null,
        dapp: review.dapp,                  // CLAIMED metadata (persisted as claimed)
        namespaces,                         // approved chains/accounts/methods/events
        activeChainId: settledChains[0] || null,
        createdAt: nowMs,
        expiry: nowMs + ttl * 1000,         // ms epoch
        relayProtocol: (proposal.relays && proposal.relays[0] && proposal.relays[0].protocol) || 'irn',
        // NO key material. Ever.
      };

      await putSession(session);
      if (relay && typeof relay.approveProposal === 'function') {
        try { await relay.approveProposal(proposal, { namespaces, topic }); } catch (_) { /* transport best-effort */ }
      }
      return session;
    }

    async function rejectProposal(proposal, reason) {
      proposal = proposal || {};
      if (relay && typeof relay.rejectProposal === 'function') {
        try { await relay.rejectProposal(proposal, reason || { code: ERR.USER_REJECTED, message: 'user rejected the session proposal' }); }
        catch (_) { /* best-effort */ }
      }
      return;
    }

    // -------------------------------------------------------------------------
    // 3. REQUEST ROUTING — namespace enforcement FIRST, then the signing surface.
    // -------------------------------------------------------------------------
    // ctx (per-call, host-provided):
    //   approve(presentation) -> bool   REQUIRED human gate for every signing
    //                                    request (no dApp request auto-approves).
    //   confirm(presentation) -> bool   the EXTRA explicit confirm a DANGER forces
    //                                    (fail-closed when absent).
    //   security: extra inspect ctx (getCode/getBalance/estimateUsd/seenRecipients…)
    async function handleRequest(request, ctx) {
      request = request || {};
      ctx = ctx || {};
      const id = request.id;
      const { topic, chainId, method, params } = request;

      // (4) unknown topic / expiry — state-machine guards first.
      const session = await getSession(topic);
      if (!session) return rpcError(id, ERR.UNKNOWN_TOPIC, 'no settled session for topic: ' + topic);
      if (session.expiry != null && clock() >= session.expiry) {
        return rpcError(id, ERR.SESSION_EXPIRED, 'session expired — reconnect the dApp');
      }

      // eth_sign — REFUSED by default with an explanatory error (strictly more
      // restrictive than the namespace gate; never signs blind).
      if (method === 'eth_sign' && !cfg.allowEthSign) {
        return rpcError(id, ERR.ETH_SIGN_DISABLED,
          'eth_sign is disabled: it blind-signs an arbitrary 32-byte digest (a classic drainer vector). ' +
          'Use personal_sign or eth_signTypedData_v4 instead.');
      }

      // NAMESPACE ENFORCEMENT — chainId + method must be inside the approved
      // namespace. No exceptions (read methods are allowed on an approved chain).
      const ns = namespaceForChain(session, chainId);
      if (!ns) return rpcError(id, ERR.UNAUTHORIZED, 'unauthorized chain (outside the approved session namespace): ' + chainId);
      const methodAllowed = ns.methods.indexOf(method) >= 0 || READ_METHODS.has(method);
      if (!methodAllowed) return rpcError(id, ERR.UNAUTHORIZED, 'unauthorized method (outside the approved session namespace): ' + method);

      // READ methods — answered from session state, NO prompt.
      if (method === 'eth_accounts') {
        return rpcResult(id, addressesFor(session, chainId));
      }
      if (method === 'eth_chainId') {
        return rpcResult(id, chainIdHex(session.activeChainId || chainId));
      }

      // the account the wallet exposes for this chainId (CAIP-10 + bare address)
      const account = accountFor(session, chainId);

      try {
        switch (method) {
          case 'eth_sendTransaction':
            return await doEthSendTransaction(id, session, chainId, params, account, ctx);
          case 'eth_signTypedData':
          case 'eth_signTypedData_v4':
          case 'eth_signTypedData_v3':
            return await doSignTypedData(id, session, chainId, method, params, account, ctx);
          case 'personal_sign':
            return await doPersonalSign(id, session, chainId, params, account, ctx);
          case 'wallet_switchEthereumChain':
            return await doSwitchChain(id, session, params, ctx);
          case 'wallet_addEthereumChain':
            return await doAddChain(id, session, params, ctx);
          case 'solana_signTransaction':
            return await doSolana(id, session, chainId, 'signTransaction', params, account, ctx);
          case 'solana_signAndSendTransaction':
            return await doSolana(id, session, chainId, 'signAndSendTransaction', params, account, ctx);
          case 'solana_signMessage':
            return await doSolanaMessage(id, session, chainId, params, account, ctx);
          default:
            return rpcError(id, ERR.UNAUTHORIZED, 'unsupported method: ' + method);
        }
      } catch (e) {
        if (e && e.rpc) return e.rpc; // a gate-produced JSON-RPC error
        throw e;
      }
    }

    // ---- the ONE human + security gate every signing request flows through ---
    // Returns true when cleared to sign; throws { rpc } (a JSON-RPC error) when
    // rejected/blocked. A DANGER severity forces the extra confirm (fail-closed).
    // This is the SAME gate the user's own signer uses — a dApp can never cause
    // an unprompted or danger-auto-approved signature.
    async function gate(id, presentation, ctx) {
      const severity = presentation.severity || 'none';
      if (severity === 'danger') {
        if (typeof ctx.confirm !== 'function') {
          const err = new Error('blocked'); err.rpc = rpcError(id, ERR.BLOCKED,
            'signing blocked: danger-level security warnings require an explicit confirmation handler (fail-closed)');
          throw err;
        }
        const okc = await ctx.confirm(presentation);
        if (!okc) {
          const err = new Error('rejected'); err.rpc = rpcError(id, ERR.USER_REJECTED, 'user declined after danger-level warnings');
          throw err;
        }
      }
      // explicit human approval is ALWAYS required — never auto-approve a dApp.
      if (typeof ctx.approve !== 'function') {
        const err = new Error('blocked'); err.rpc = rpcError(id, ERR.BLOCKED,
          'signing blocked: no approval handler wired — an external dApp request can never auto-approve (fail-closed)');
        throw err;
      }
      const ok = await ctx.approve(presentation);
      if (!ok) {
        const err = new Error('rejected'); err.rpc = rpcError(id, ERR.USER_REJECTED, 'user rejected the request');
        throw err;
      }
      return true;
    }

    function securityCtx(ctx, chainId) {
      const base = (ctx && ctx.security) || {};
      return Object.assign({}, base, {
        chain: evmChainName(chainId),
        config: Object.assign({}, base.config, {
          denylist: Array.from(cfg.denylist),
          unlimitedThreshold: cfg.unlimitedThreshold,
        }),
      });
    }

    async function doEthSendTransaction(id, session, chainId, params, account, ctx) {
      const tx = Array.isArray(params) ? params[0] : params;
      const inspectTx = Object.assign({ chain: evmChainName(chainId) }, tx);
      const inspection = await security.inspectTransaction(inspectTx, securityCtx(ctx, chainId));
      const presentation = {
        method: 'eth_sendTransaction', topic: session.topic, chainId,
        dapp: session.dapp, account,
        inspection, severity: inspection.severity, warnings: inspection.warnings,
      };
      await gate(id, presentation, ctx); // throws on reject/block
      if (!signer || typeof signer.ethSendTransaction !== 'function') {
        throw rpcThrow(id, ERR.BLOCKED, 'no signer wired for eth_sendTransaction');
      }
      const hash = await signer.ethSendTransaction({ account, chainId, tx, inspection });
      return rpcResult(id, typeof hash === 'string' ? hash : (hash && hash.hash) || hash);
    }

    async function doSignTypedData(id, session, chainId, method, params, account, ctx) {
      // params: [address, typedDataJSONorObject]
      const raw = Array.isArray(params) ? params[1] : params;
      const decoded = decodeTypedData(raw, cfg, nowSec(clock()));
      const presentation = {
        method, topic: session.topic, chainId, dapp: session.dapp, account,
        decoded, warnings: decoded.warnings, severity: decoded.severity,
      };
      await gate(id, presentation, ctx);
      if (!signer || typeof signer.ethSignTypedData !== 'function') {
        throw rpcThrow(id, ERR.BLOCKED, 'no signer wired for ' + method);
      }
      const version = method === 'eth_signTypedData_v3' ? 'v3' : 'v4';
      const sig = await signer.ethSignTypedData({ account, chainId, typedData: decoded.typed, version, decoded });
      return rpcResult(id, sig);
    }

    async function doPersonalSign(id, session, chainId, params, account, ctx) {
      // params: [message, address]  (message hex or utf-8)
      const decoded = decodePersonalSign(params);
      const presentation = {
        method: 'personal_sign', topic: session.topic, chainId, dapp: session.dapp, account,
        decoded, warnings: decoded.warnings, severity: decoded.severity,
      };
      await gate(id, presentation, ctx);
      if (!signer || typeof signer.personalSign !== 'function') {
        throw rpcThrow(id, ERR.BLOCKED, 'no signer wired for personal_sign');
      }
      const sig = await signer.personalSign({ account, chainId, message: decoded.messageHex, text: decoded.text });
      return rpcResult(id, sig);
    }

    async function doSwitchChain(id, session, params, ctx) {
      const p = Array.isArray(params) ? params[0] : params;
      const hexId = p && (p.chainId || p);
      const caip2 = 'eip155:' + String(parseInt(hexId, 16));
      if (!namespaceForChain(session, caip2) && !cfg.walletChains.has(caip2)) {
        return rpcError(id, ERR.UNSUPPORTED_CHAIN, 'cannot switch to a chain the wallet does not have: ' + caip2);
      }
      // switching to an approved chain still requires the human nod (no silent state change)
      await gate(id, { method: 'wallet_switchEthereumChain', topic: session.topic, chainId: caip2, dapp: session.dapp, severity: 'none' }, ctx);
      session.activeChainId = caip2;
      await putSession(session);
      return rpcResult(id, null);
    }

    async function doAddChain(id, session, params, ctx) {
      const p = Array.isArray(params) ? params[0] : params;
      const hexId = p && p.chainId;
      const caip2 = 'eip155:' + String(parseInt(hexId, 16));
      if (!cfg.walletChains.has(caip2)) {
        return rpcError(id, ERR.UNSUPPORTED_CHAIN, 'refusing to add a chain the wallet does not have configured: ' + caip2);
      }
      await gate(id, { method: 'wallet_addEthereumChain', topic: session.topic, chainId: caip2, dapp: session.dapp, severity: 'none' }, ctx);
      return rpcResult(id, null);
    }

    async function doSolana(id, session, chainId, kind, params, account, ctx) {
      const p = (params && typeof params === 'object' && !Array.isArray(params)) ? params : { transaction: Array.isArray(params) ? params[0] : params };
      // best-effort security inspection: use parsed instructions if the dApp
      // provided them; otherwise a minimal unknown-program review (still gated).
      const inspection = await security.inspectTransaction(
        { chain: 'solana', instructions: p.instructions || (p.transaction && p.transaction.instructions) || [] },
        securityCtx(ctx, chainId));
      const presentation = {
        method: 'solana_' + kind, topic: session.topic, chainId, dapp: session.dapp, account,
        inspection, severity: inspection.severity, warnings: inspection.warnings,
      };
      await gate(id, presentation, ctx);
      const fn = kind === 'signAndSendTransaction' ? 'solanaSignAndSend' : 'solanaSignTransaction';
      if (!signer || typeof signer[fn] !== 'function') throw rpcThrow(id, ERR.BLOCKED, 'no signer wired for solana_' + kind);
      const out = await signer[fn]({ account, chainId, transaction: p.transaction, inspection });
      return rpcResult(id, out);
    }

    async function doSolanaMessage(id, session, chainId, params, account, ctx) {
      const p = (params && typeof params === 'object' && !Array.isArray(params)) ? params : { message: Array.isArray(params) ? params[0] : params };
      const text = p.message != null ? String(p.message) : '';
      const presentation = {
        method: 'solana_signMessage', topic: session.topic, chainId, dapp: session.dapp, account,
        decoded: { kind: 'message', text }, warnings: [], severity: 'none',
      };
      await gate(id, presentation, ctx);
      if (!signer || typeof signer.solanaSignMessage !== 'function') throw rpcThrow(id, ERR.BLOCKED, 'no signer wired for solana_signMessage');
      const sig = await signer.solanaSignMessage({ account, chainId, message: p.message });
      return rpcResult(id, sig);
    }

    // ---- connect the relay (integration glue; tests call handleRequest direct)
    function connectRelay(ctx) {
      if (!relay || typeof relay.subscribeRequests !== 'function') return () => {};
      return relay.subscribeRequests(async (request) => {
        const response = await handleRequest(request, ctx || {});
        if (relay && typeof relay.respond === 'function') await relay.respond(request.topic, response);
        return response;
      });
    }

    return {
      // pairing
      parsePairingUri, pair,
      // proposals
      reviewProposal, approveProposal, rejectProposal,
      // requests
      handleRequest,
      // sessions
      listSessions, getSession, disconnect,
      // integration
      connectRelay,
      // introspection (tests / UI)
      config: cfg, ERR,
    };
  }

  // helper so a gate-less path can throw a JSON-RPC error uniformly
  function rpcThrow(id, code, message) {
    const err = new Error(message); err.rpc = rpcError(id, code, message); return err;
  }

  // ===========================================================================
  // EIP-712 typed-data decode + Permit / Permit2 detection (off-chain approval
  // phishing is a top drainer vector — flag unlimited / long-deadline as DANGER)
  // ===========================================================================
  function decodeTypedData(raw, cfg, nowS) {
    let typed;
    try { typed = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch { typed = {}; }
    typed = typed || {};
    const domain = typed.domain || {};
    const message = typed.message || {};
    const primaryType = typed.primaryType || '';

    const warnings = [];
    const isPermit2 = lc(domain.name) === 'permit2' || /^Permit(Single|Batch)$/.test(primaryType);
    const looksPermit = /permit/i.test(primaryType) ||
      (message && (message.value != null || message.amount != null || (message.details && message.details.amount != null)) &&
        (message.spender != null || (message.details && message.details.token != null)));
    const isApproval = isPermit2 || looksPermit;

    const details = [
      { label: 'Primary type', value: primaryType || '(unknown)' },
      { label: 'Domain', value: domain.name != null ? String(domain.name) : '(unnamed)' },
    ];
    if (domain.verifyingContract) details.push({ label: 'Verifying contract', value: domain.verifyingContract });
    if (domain.chainId != null) details.push({ label: 'Chain id', value: String(domain.chainId) });

    let severity = 'none';
    const sem = {};

    if (isApproval) {
      const spender = message.spender || (message.details && message.details.spender) || null;
      const token = (message.details && message.details.token) || message.token || domain.verifyingContract || null;
      const amountRaw = message.value != null ? message.value
        : (message.details && message.details.amount != null) ? message.details.amount
        : message.amount != null ? message.amount : null;
      const deadlineRaw = message.deadline != null ? message.deadline
        : message.sigDeadline != null ? message.sigDeadline
        : (message.details && message.details.expiration != null) ? message.details.expiration : null;

      let amount = null, unlimited = false;
      if (amountRaw != null) {
        amount = toBig(amountRaw);
        unlimited = amount >= cfg.unlimitedThreshold || amount === MAX_UINT160 || amount === MAX_UINT256;
      }
      let deadline = null, longDeadline = false;
      if (deadlineRaw != null) {
        deadline = toBig(deadlineRaw);
        const longWindow = BigInt(cfg.longDeadlineSeconds);
        longDeadline = deadline === MAX_UINT48 || deadline === MAX_UINT256 ||
          (deadline > BigInt(nowS) && (deadline - BigInt(nowS)) > longWindow);
      }

      sem.spender = spender; sem.token = token; sem.unlimited = unlimited; sem.longDeadline = longDeadline;
      sem.amount = amount != null ? amount.toString() : null;
      sem.deadline = deadline != null ? deadline.toString() : null;

      details.push({ label: 'Spender', value: spender || '(none)' });
      if (token) details.push({ label: 'Token', value: token });
      details.push({ label: 'Allowance', value: amount == null ? '(none)' : (unlimited ? 'UNLIMITED' : amount.toString()) });
      if (deadline != null) details.push({ label: 'Deadline', value: (deadline === MAX_UINT48 || deadline === MAX_UINT256) ? 'NEVER EXPIRES' : deadline.toString() });

      warnings.push({ code: 'offchain-approval', severity: 'info',
        message: 'This is an OFF-CHAIN token approval signature (Permit' + (isPermit2 ? '2' : '') + ') — it grants a spender allowance without an on-chain tx.',
        evidence: { spender, token } });
      if (unlimited) warnings.push({ code: 'permit-unlimited', severity: 'danger',
        message: 'This Permit grants an UNLIMITED token allowance — the spender can drain your entire balance.',
        evidence: { spender, amount: sem.amount } });
      if (longDeadline) warnings.push({ code: 'permit-long-deadline', severity: 'danger',
        message: 'This Permit has an extremely long (or no) expiry — the allowance stays live far into the future.',
        evidence: { spender, deadline: sem.deadline } });

      severity = maxSeverity(warnings);
    }

    const kind = isApproval ? 'typed-data-permit' : 'typed-data';
    const summary = isApproval
      ? ('Sign off-chain approval (' + (isPermit2 ? 'Permit2' : 'Permit') + ')' + (sem.unlimited ? ' — UNLIMITED' : '') + (sem.spender ? ' to ' + sem.spender : ''))
      : ('Sign typed data: ' + (primaryType || 'struct') + (domain.name ? ' (' + domain.name + ')' : ''));

    return { kind, primaryType, domain, message, typed, details, warnings, severity, summary, sem, isApproval, isPermit2 };
  }

  // personal_sign — decode UTF-8 + flag a tx / EIP-712 smuggled as "text".
  function decodePersonalSign(params) {
    const msgRaw = Array.isArray(params) ? params[0] : params;
    const isHex = typeof msgRaw === 'string' && /^0x[0-9a-fA-F]*$/.test(msgRaw);
    const messageHex = isHex ? msgRaw : utf8ToHex(String(msgRaw == null ? '' : msgRaw));
    const text = isHex ? (hexToUtf8(msgRaw) != null ? hexToUtf8(msgRaw) : msgRaw) : String(msgRaw == null ? '' : msgRaw);

    const warnings = [];
    const t = String(text || '');
    const looksTyped = /"types"\s*:/.test(t) && /"domain"\s*:/.test(t);
    // a long pure-hex body that decoded to mostly non-printable text looks like a
    // smuggled raw transaction / digest rather than a human-readable message.
    const hexBody = isHex ? msgRaw.replace(/^0x/, '') : '';
    const looksRawTx = isHex && hexBody.length >= 64 && !isMostlyPrintable(t);
    if (looksTyped) warnings.push({ code: 'personal-sign-structured', severity: 'warn',
      message: 'This "message" contains EIP-712 typed-data JSON — a structured approval may be smuggled as plain text. Read it carefully.' });
    if (looksRawTx) warnings.push({ code: 'personal-sign-binary', severity: 'warn',
      message: 'This "message" is a long binary/hex blob (not human-readable text) — it may be a raw transaction or digest. Do not sign unless you know what it is.' });

    return {
      kind: 'personal-sign', messageHex, text: t,
      details: [{ label: 'Message', value: t }],
      warnings, severity: maxSeverity(warnings),
      summary: 'Sign message: ' + (t.length > 80 ? t.slice(0, 80) + '…' : t),
    };
  }

  function isMostlyPrintable(s) {
    if (!s || !s.length) return false;
    let printable = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 160) printable++;
    }
    return printable / s.length >= 0.8;
  }
  function utf8ToHex(s) {
    const bytes = typeof Buffer !== 'undefined' ? Buffer.from(s, 'utf8') : new TextEncoder().encode(s);
    let h = '0x';
    for (let i = 0; i < bytes.length; i++) h += bytes[i].toString(16).padStart(2, '0');
    return h;
  }

  function maxSeverity(warnings) {
    const RANK = { none: 0, info: 1, warn: 2, danger: 3 };
    let best = 'none';
    for (const w of (warnings || [])) if (RANK[w.severity] > RANK[best]) best = w.severity;
    return best;
  }

  // ---- CAIP + namespace helpers ---------------------------------------------
  function caip2OfAccount(caip10) {
    const parts = String(caip10).split(':');
    return parts.length >= 3 ? parts[0] + ':' + parts[1] : String(caip10);
  }
  function addressOfAccount(caip10) {
    const parts = String(caip10).split(':');
    return parts.length >= 3 ? parts.slice(2).join(':') : String(caip10);
  }
  function namespaceForChain(session, chainId) {
    const nss = session.namespaces || {};
    for (const nsId of Object.keys(nss)) {
      if ((nss[nsId].chains || []).indexOf(chainId) >= 0) return nss[nsId];
    }
    return null;
  }
  function accountFor(session, chainId) {
    const ns = namespaceForChain(session, chainId);
    if (!ns) return null;
    const match = (ns.accounts || []).find((a) => caip2OfAccount(a) === chainId);
    const caip10 = match || (ns.accounts || [])[0] || null;
    if (!caip10) return null;
    return { caip10, address: addressOfAccount(caip10), chainId };
  }
  function addressesFor(session, chainId) {
    const ns = namespaceForChain(session, chainId);
    if (!ns) return [];
    return (ns.accounts || []).filter((a) => caip2OfAccount(a) === chainId).map(addressOfAccount);
  }
  function chainIdHex(caip2) {
    if (!caip2) return null;
    const n = String(caip2).split(':')[1];
    if (/^\d+$/.test(n)) return '0x' + parseInt(n, 10).toString(16);
    return caip2; // non-eip155 (e.g. solana) — return the caip2 as-is
  }
  // map a CAIP-2 eip155 chain to the security suite's chain name (best-effort).
  const EIP155_NAME = {
    '1': 'ethereum', '8453': 'base', '42161': 'arbitrum', '10': 'optimism',
    '137': 'polygon', '56': 'bnb', '43114': 'avalanche',
  };
  function evmChainName(chainId) {
    if (!chainId) return 'ethereum';
    const parts = String(chainId).split(':');
    if (parts[0] === 'solana') return 'solana';
    if (parts[0] === 'eip155') return EIP155_NAME[parts[1]] || 'ethereum';
    return 'ethereum';
  }

  function normalizeConfig(c) {
    c = c || {};
    const denylist = new Set((c.denylist || []).map((d) => lc(d)));
    const walletChains = new Set(c.walletChains || c.chains || []);
    const supportedMethods = new Set(c.supportedMethods || DEFAULT_METHODS);
    if (c.allowEthSign) supportedMethods.add('eth_sign'); else supportedMethods.delete('eth_sign');
    const supportedEvents = new Set(c.supportedEvents || DEFAULT_EVENTS);
    return {
      denylist, walletChains, supportedMethods, supportedEvents,
      allowEthSign: !!c.allowEthSign,
      sessionTtlSeconds: c.sessionTtlSeconds != null ? Number(c.sessionTtlSeconds) : DEFAULT_TTL_SECONDS,
      unlimitedThreshold: c.unlimitedThreshold != null ? toBig(c.unlimitedThreshold) : (1n << 255n),
      longDeadlineSeconds: c.longDeadlineSeconds != null ? Number(c.longDeadlineSeconds) : DEFAULT_LONG_DEADLINE_SECONDS,
    };
  }

  // in-memory fallback store (tests inject their own; prod injects encrypted Store)
  function inMemoryStore() {
    const mem = {};
    return {
      async get(key) { return { [key]: mem[key] }; },
      async set(obj) { Object.assign(mem, obj); },
    };
  }

  const API = {
    createWalletConnect,
    parsePairingUri,
    // internals exported for tests / ports:
    decodeTypedData, decodePersonalSign, maxSeverity,
    caip2OfAccount, addressOfAccount, chainIdHex, evmChainName,
    normalizeConfig, hostOf, hexToUtf8,
    DEFAULT_METHODS, DEFAULT_EVENTS, ERR,
    MAX_UINT256, MAX_UINT160, MAX_UINT48,
  };
  global.WalletConnect = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
