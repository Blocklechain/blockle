// nft.js — WALLET NFT SUPPORT (docs/WALLET-NFT.md).
//
// View + send NFTs across EVM (ERC-721 / ERC-1155) and Solana (Metaplex).
// READ-ONLY except the explicit, approved SEND — which builds calldata only and
// routes through the SAME flow as a normal send: security.inspectTransaction
// first, a danger forces the extra confirm, then the EXISTING signer signs +
// broadcasts. THIS MODULE NEVER SIGNS AND NEVER HOLDS KEYS.
//
// NEVER fabricates ownership or metadata: an unresolvable item is shown with
// what's known + metadataOk:false / 'metadata-unavailable', never invented. An
// unavailable indexer adds to `unavailable` (never a fabricated empty inventory).
//
// PURE given the injected ctx (indexer / config). All counts + ids are
// base-unit / BigInt-exact. Reuses chains/evm.js calldata builders and the
// security suite (inspectTransaction + the approval manager) — no new signing or
// approval path.
//
// Global `WalletNft`; module.exports for node tests.
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);
  const EVM = inNode ? require('./chains/evm.js') : global.EvmAdapter;
  const Security = inNode ? require('./security.js') : global.WalletSecurity;

  const EVM_CHAINS = new Set(['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bnb', 'avalanche']);
  const EVM_STANDARDS = new Set(['erc721', 'erc1155']);
  const DEFAULT_GATEWAY = 'https://ipfs.io/ipfs/';

  // Conservative phishing signal: a claim/reward/airdrop lure paired with an
  // off-platform link (classic "claim your rewards at …" drainer bait). FLAG
  // only — never a safety claim, never an assertion of value.
  const CLAIM_WORD = /\b(claim|rewards?|airdrop|free\s+mint|verify|activate|unlock)\b/i;
  const URL_LIKE = /(https?:\/\/|www\.|\.(?:xyz|top|io|co|app|site|click|link|gift|vip|finance)\b)/i;

  // ---- small pure helpers ---------------------------------------------------
  function toBig(v) {
    if (typeof v === 'bigint') return v;
    if (v == null || v === '') return 0n;
    const s = String(v).trim();
    if (/^0x[0-9a-fA-F]+$/.test(s)) return BigInt(s);
    if (!/^\d+$/.test(s)) throw new Error('not a base-unit integer: ' + s);
    return BigInt(s);
  }
  function normAddr(a) {
    if (a == null) return a;
    const s = String(a);
    return /^0x[0-9a-fA-F]*$/.test(s) ? s.toLowerCase() : s;
  }
  function addrEq(chain, a, b) {
    if (a == null || b == null) return false;
    if (EVM_CHAINS.has(chain)) return String(a).toLowerCase() === String(b).toLowerCase();
    return String(a) === String(b); // base58 / others are case-sensitive
  }

  // ipfs:// (and ipfs://ipfs/CID) → configured gateway. Everything else passes
  // through UNCHANGED — the core FETCHES NOTHING; the UI loads media under its
  // own CSP. Returns the original value for null/non-string.
  function normalizeUri(uri, config) {
    if (uri == null) return uri;
    const s = String(uri);
    if (!/^ipfs:\/\//i.test(s)) return s;
    const gw = ((config && config.ipfsGateway) || DEFAULT_GATEWAY).replace(/\/+$/, '');
    let rest = s.replace(/^ipfs:\/\//i, '').replace(/^ipfs\//i, '').replace(/^\/+/, '');
    return gw + '/' + rest;
  }

  // ---- spam / scam heuristics (§3): FLAG only, never assert safe/valuable ----
  function spamReasons(raw, item, config) {
    const reasons = [];
    const denylist = new Set((config.nftDenylist || []).map((a) => String(a).toLowerCase()));
    const contract = item.contract != null ? String(item.contract).toLowerCase() : null;

    if (contract && denylist.has(contract)) reasons.push('denylist');

    // zero-floor airdrop: an item the wallet never bought, with no floor value.
    const airdrop = raw.airdrop === true || raw.acquiredVia === 'airdrop';
    let floorZero = true;
    try { floorZero = toBig(raw.floorBase != null ? raw.floorBase : (raw.floor != null ? raw.floor : 0)) === 0n; }
    catch { floorZero = true; }
    if (airdrop && floorZero) reasons.push('zero-floor-airdrop');

    // phishing name / URL pattern (needs BOTH a lure word and a link to flag).
    const text = [item.name, item.collection, item.metadataUri, item.image, raw.description]
      .filter((x) => x != null).map(String).join(' ');
    if (CLAIM_WORD.test(text) && URL_LIKE.test(text)) reasons.push('phishing-pattern');

    // link-only metadata: no name/collection/attributes, only an external link.
    const hasAttrs = Array.isArray(item.attributes) && item.attributes.length > 0;
    const linkOnly = !item.name && !item.collection && !hasAttrs
      && (URL_LIKE.test(String(item.image || '')) || URL_LIKE.test(String(item.metadataUri || '')) || URL_LIKE.test(String(raw.externalUrl || '')));
    if (linkOnly) reasons.push('link-only-metadata');

    return reasons;
  }

  // ---- normalize one raw indexer item (no fabrication) ----------------------
  function normalizeItem(raw, config) {
    const chain = raw.chain;
    const standard = raw.standard || raw.tokenType || (chain === 'solana' ? 'metaplex' : undefined);
    const item = { chain, standard, contract: raw.contract != null ? String(raw.contract) : undefined };
    if (raw.tokenId != null) item.tokenId = String(raw.tokenId);
    // balance: erc721 is always 1; 1155/metaplex may be >1. BigInt-exact string.
    let bal;
    try { bal = standard === 'erc721' ? 1n : toBig(raw.balance != null ? raw.balance : 1); }
    catch { bal = 1n; }
    if (standard === 'erc721') bal = 1n;
    item.balance = bal.toString();

    // metadata — present only when the indexer actually resolved it (never guessed)
    if (raw.name != null) item.name = raw.name;
    if (raw.collection != null) item.collection = raw.collection;
    if (raw.image != null) item.image = normalizeUri(raw.image, config);
    if (raw.animation != null) item.animation = normalizeUri(raw.animation, config);
    if (raw.attributes != null) item.attributes = raw.attributes;
    if (raw.metadataUri != null) item.metadataUri = normalizeUri(raw.metadataUri, config);

    // metadataOk: false when the indexer couldn't fetch metadata. We keep what's
    // known and flag it — NEVER invent a name/image for an unresolved item.
    item.metadataOk = raw.metadataOk !== false;
    if (!item.metadataOk) item.metadataNote = 'metadata-unavailable';

    const reasons = spamReasons(raw, item, config);
    if (reasons.length) { item.spam = true; item.spamReasons = reasons; }
    return item;
  }

  // ---- group by collection (chain + contract) -------------------------------
  function groupByCollection(items) {
    const byKey = new Map();
    for (const it of items) {
      const key = it.chain + ':' + String(it.contract || '').toLowerCase();
      let g = byKey.get(key);
      if (!g) {
        g = { key, chain: it.chain, contract: it.contract, standard: it.standard, name: it.collection, count: 0, items: [] };
        byKey.set(key, g);
      }
      if (!g.name && it.collection) g.name = it.collection;
      g.items.push(it);
      g.count += 1;
    }
    return Array.from(byKey.values());
  }

  // ===========================================================================
  // 1. INVENTORY (read-only) — nfts(accounts, ctx)
  // ===========================================================================
  // accounts: [{chain, address}]. ctx.indexer.getNFTsForOwner(chain, owner) ->
  // raw items (EVM getNFTsForOwner / Solana Metaplex-DAS). A missing indexer or a
  // failing call for an account adds to `unavailable` (never a fake empty list).
  async function nfts(accounts, ctx) {
    ctx = ctx || {};
    const config = ctx.config || {};
    const indexer = ctx.indexer;
    const items = [];
    const unavailable = [];
    for (const acc of (accounts || [])) {
      const chain = acc.chain, owner = acc.address;
      if (!indexer || typeof indexer.getNFTsForOwner !== 'function') {
        unavailable.push({ chain, address: owner, reason: 'no NFT indexer configured — NOT a claim the wallet holds no NFTs.' });
        continue;
      }
      let raw;
      try { raw = await indexer.getNFTsForOwner(chain, owner); }
      catch (e) {
        unavailable.push({ chain, address: owner, reason: 'indexer error (' + (e && e.message || e) + ') — NOT a claim the wallet holds no NFTs.' });
        continue;
      }
      if (raw == null) {
        unavailable.push({ chain, address: owner, reason: 'indexer returned no result — NOT a claim the wallet holds no NFTs.' });
        continue;
      }
      for (const r of raw) {
        const withChain = r.chain ? r : Object.assign({ chain }, r);
        items.push(normalizeItem(withChain, config));
      }
    }
    return { items, collections: groupByCollection(items), unavailable };
  }

  // ===========================================================================
  // 2. SEND — buildNftTransfer: calldata only, fail-closed guards
  // ===========================================================================
  // req: {chain, standard, contract, tokenId, from, to, amount?, ownedBalance?}
  // GUARDS (fail-closed, never partial/overdraw):
  //   • `from` MUST equal the wallet's address for that chain (ctx.accounts).
  //   • ERC-1155 amount REQUIRED, 1..ownedBalance (ownedBalance required).
  // Returns a tx shaped for the normal send flow (inspect → gate → signer). The
  // module NEVER signs — the caller runs security.inspectTransaction then hands
  // the tx to the existing signer.
  function buildNftTransfer(req, ctx) {
    req = req || {};
    ctx = ctx || {};
    const { chain, standard, contract, tokenId, from, to } = req;
    if (!chain) throw new Error('buildNftTransfer: missing chain');
    if (!standard) throw new Error('buildNftTransfer: missing standard');
    if (!contract) throw new Error('buildNftTransfer: missing contract');
    if (!to) throw new Error('buildNftTransfer: missing recipient (to)');
    if (!from) throw new Error('buildNftTransfer: missing from');

    // GUARD: from must be THIS wallet's address for the chain (fail-closed).
    const walletAddr = addressForChain(chain, ctx);
    if (walletAddr == null) {
      throw new Error('buildNftTransfer: no wallet account for chain ' + chain + ' — refusing (fail-closed)');
    }
    if (!addrEq(chain, from, walletAddr)) {
      throw new Error('buildNftTransfer: `from` is not this wallet\'s address for ' + chain + ' — refusing (fail-closed)');
    }

    if (EVM_CHAINS.has(chain)) {
      if (!EVM_STANDARDS.has(standard)) throw new Error('buildNftTransfer: EVM standard must be erc721|erc1155');
      if (tokenId == null) throw new Error('buildNftTransfer: missing tokenId');
      const idBig = toBig(tokenId);

      if (standard === 'erc721') {
        const data = EVM.erc721SafeTransferFromData(from, to, idBig.toString());
        return evmTx(chain, 'erc721', contract, from, to, idBig, 1n, data);
      }
      // erc1155: amount required, 1..ownedBalance (never overdraw / fabricate).
      if (req.amount == null) throw new Error('buildNftTransfer: erc1155 requires amount');
      const amt = toBig(req.amount);
      if (amt <= 0n) throw new Error('buildNftTransfer: erc1155 amount must be > 0');
      if (req.ownedBalance == null) throw new Error('buildNftTransfer: erc1155 requires ownedBalance to guard overdraw (fail-closed)');
      const owned = toBig(req.ownedBalance);
      if (amt > owned) throw new Error('buildNftTransfer: erc1155 amount ' + amt + ' exceeds owned balance ' + owned + ' — refusing (fail-closed)');
      const data = EVM.erc1155SafeTransferFromData(from, to, idBig.toString(), amt.toString(), '0x');
      return evmTx(chain, 'erc1155', contract, from, to, idBig, amt, data);
    }

    if (chain === 'solana') {
      // Metaplex transfer: amount defaults to 1 (pNFT/NFT); editions may be >1.
      const amt = req.amount == null ? 1n : toBig(req.amount);
      if (amt <= 0n) throw new Error('buildNftTransfer: solana amount must be > 0');
      if (req.ownedBalance != null && amt > toBig(req.ownedBalance)) {
        throw new Error('buildNftTransfer: solana amount exceeds owned balance — refusing (fail-closed)');
      }
      // No calldata is fabricated here: the existing Solana adapter builds +
      // signs the Metaplex transfer instruction. We return a descriptor that
      // routes through that adapter (and inspectTransaction) — the module never signs.
      return {
        chain: 'solana', kind: 'nft-transfer', standard: 'metaplex',
        mint: contract, from, to, amount: amt.toString(),
        route: 'build via the existing Solana adapter; inspectTransaction runs first; the signer signs — this module never signs.',
        summary: 'Transfer Metaplex NFT ' + shorten(contract) + ' to ' + shorten(to),
      };
    }

    throw new Error('buildNftTransfer: unsupported chain ' + chain);
  }

  function evmTx(chain, standard, contract, from, to, tokenId, amount, data) {
    return {
      chain, kind: 'nft-transfer', standard,
      to: contract,            // the collection contract is the tx target
      value: '0',
      data,
      from,
      nft: { contract, tokenId: tokenId.toString(), amount: amount.toString() },
      route: 'inspectTransaction runs first (danger forces confirm); the EXISTING signer signs + broadcasts. This module never signs.',
      summary: (standard === 'erc1155' ? amount.toString() + '× ' : '') +
        'Transfer NFT #' + tokenId.toString() + ' (' + shorten(contract) + ') to ' + shorten(to),
    };
  }

  function addressForChain(chain, ctx) {
    if (typeof ctx.addressFor === 'function') return ctx.addressFor(chain);
    const list = ctx.accounts || [];
    for (const a of list) if (a && a.chain === chain) return a.address;
    return null;
  }
  function shorten(a) {
    const s = String(a || '');
    return s.length > 14 ? s.slice(0, 8) + '…' + s.slice(-4) : s;
  }

  // ===========================================================================
  // 4. APPROVAL AWARENESS — reuse the security approval manager (no new path)
  // ===========================================================================
  // Surfaces per-collection setApprovalForAll OPERATOR approvals (danger) so the
  // user can revoke. Reuses Security.listApprovals (read-only) — no new approval
  // path; revocation goes through the normal send flow + security gate.
  async function surfaceApprovals(chain, owner, ctx) {
    const listing = await Security.listApprovals(chain, owner, ctx);
    if (!listing.available) return { chain, owner, approvals: [], operatorApprovals: [], available: false, note: listing.note };
    const operatorApprovals = [];
    for (const a of listing.approvals) {
      if (a.operator === true) {
        operatorApprovals.push({
          collection: a.token, collectionName: a.tokenSymbol,
          operator: a.spender, operatorLabel: a.spenderLabel,
          severity: 'danger', revocable: true, lastUpdated: a.lastUpdated,
          note: 'setApprovalForAll grants control over your ENTIRE collection — revoke via the normal send flow (the security gate applies). This is NOT a safety claim.',
        });
      }
    }
    return { chain, owner, approvals: listing.approvals, operatorApprovals, available: true };
  }

  const API = {
    nfts, buildNftTransfer, surfaceApprovals,
    // internals exported for tests / ports:
    normalizeUri, normalizeItem, spamReasons, groupByCollection,
    addrEq, toBig, DEFAULT_GATEWAY, EVM_CHAINS, EVM_STANDARDS,
  };
  global.WalletNft = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
