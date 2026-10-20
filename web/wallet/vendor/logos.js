// logos.js — CORRECT PER-CHAIN / PER-TOKEN LOGOS (the REFERENCE resolver).
//
// • CHAINS: brand-colored icons for every supported chain are BUNDLED here as
//   inline SVG — they render OFFLINE with no remote fetch. BTC, ETH/EVM, SOL,
//   DOGE, LTC, BLOCK, BNB, Base, Polygon, Arbitrum, Optimism, Avalanche.
// • TOKENS: use the token metadata `logoURI`/`logo` that discovery / auto-import
//   already carries, rendered at runtime, with a graceful colored-MONOGRAM
//   fallback when it is absent or fails to load. No broken / placeholder icons.
//
// `resolve(asset)` is the one entry point the UI uses; `chainIcon(id)` and
// `monogram(text)` are exposed for direct use + tests.
//
// Global `Logos`; module.exports for the node tests.
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);

  // ---- bundled, brand-colored chain icons (inline SVG, offline) ------------
  // Each is a 32x32 brand-colored disc with the chain's glyph — recognizable,
  // tiny, and self-contained (no network, CSP-safe).
  function disc(bg, fg, glyph, extra) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">'
      + '<circle cx="16" cy="16" r="16" fill="' + bg + '"/>'
      + (extra || '')
      + '<text x="16" y="22" font-family="Arial,Helvetica,sans-serif" font-size="18" font-weight="700"'
      + ' text-anchor="middle" fill="' + fg + '">' + glyph + '</text></svg>';
  }
  function solDisc() {
    // Solana's three-bar mark on its brand gradient.
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">'
      + '<defs><linearGradient id="solg" x1="0" y1="0" x2="1" y2="1">'
      + '<stop offset="0" stop-color="#9945FF"/><stop offset="1" stop-color="#14F195"/></linearGradient></defs>'
      + '<circle cx="16" cy="16" r="16" fill="#111"/>'
      + '<g fill="url(#solg)">'
      + '<path d="M9 12.2c.2-.2.4-.3.7-.3h13.1c.4 0 .6.5.3.8l-2.1 2.1c-.1.2-.4.3-.6.3H7.3c-.4 0-.6-.5-.3-.8z"/>'
      + '<path d="M9 21.3c.2-.2.4-.3.7-.3h13.1c.4 0 .6.5.3.8l-2.1 2.1c-.1.2-.4.3-.6.3H7.3c-.4 0-.6-.5-.3-.8z" transform="translate(0 -4)"/>'
      + '<path d="M23.1 16.7c-.2-.2-.4-.3-.7-.3H9.3c-.4 0-.6.5-.3.8l2.1 2.1c.1.2.4.3.6.3h13.1c.4 0 .6-.5.3-.8z"/>'
      + '</g></svg>';
  }

  const CHAIN_ICONS = {
    btc:       disc('#f7931a', '#ffffff', '₿'),      // ₿
    eth:       disc('#627eea', '#ffffff', 'Ξ'),      // Ξ
    sol:       solDisc(),
    doge:      disc('#c2a633', '#ffffff', 'Ð'),      // Ð
    ltc:       disc('#345d9d', '#ffffff', 'Ł'),      // Ł
    block:     disc('#4c8dff', '#ffffff', 'B'),           // Blockle brand accent
    bnb:       disc('#f3ba2f', '#1e2026', 'B'),
    base:      disc('#0052ff', '#ffffff', 'B'),
    polygon:   disc('#8247e5', '#ffffff', 'P'),
    arbitrum:  disc('#28a0f0', '#ffffff', 'A'),
    optimism:  disc('#ff0420', '#ffffff', 'O'),
    avalanche: disc('#e84142', '#ffffff', 'A'),
  };

  // chain id (adapter id or symbol) -> canonical icon key.
  const CHAIN_ALIAS = {
    bitcoin: 'btc', btc: 'btc',
    ethereum: 'eth', eth: 'eth', evm: 'eth',
    solana: 'sol', sol: 'sol',
    dogecoin: 'doge', doge: 'doge',
    litecoin: 'ltc', ltc: 'ltc',
    block: 'block', blockle: 'block',
    bnb: 'bnb', bsc: 'bnb', binance: 'bnb',
    base: 'base',
    polygon: 'polygon', pol: 'polygon', matic: 'polygon',
    arbitrum: 'arbitrum', arb: 'arbitrum',
    optimism: 'optimism', op: 'optimism',
    avalanche: 'avalanche', avax: 'avalanche',
  };

  function canonChain(id) {
    if (!id) return null;
    const k = String(id).toLowerCase();
    return CHAIN_ALIAS[k] || (CHAIN_ICONS[k] ? k : null);
  }

  // ---- colored monogram fallback (deterministic from the text) -------------
  const MONO_COLORS = [
    '#6366f1', '#22d3ee', '#c084fc', '#34d399', '#f59e0b',
    '#fb7185', '#38bdf8', '#a3e635', '#f472b6', '#2dd4bf',
  ];
  function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h;
  }
  function monoColor(text) {
    return MONO_COLORS[hashStr(String(text || '?').toUpperCase()) % MONO_COLORS.length];
  }
  function monoText(text) {
    const t = String(text || '?').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    return (t.slice(0, 2) || '?');
  }
  function escXml(s) {
    return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function monogram(text) {
    const bg = monoColor(text);
    const label = escXml(monoText(text));
    const size = label.length > 1 ? 13 : 16;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">'
      + '<circle cx="16" cy="16" r="16" fill="' + bg + '"/>'
      + '<text x="16" y="21" font-family="Arial,Helvetica,sans-serif" font-size="' + size + '" font-weight="700"'
      + ' text-anchor="middle" fill="#ffffff">' + label + '</text></svg>';
  }

  // A chain icon by id — ALWAYS returns markup: the bundled brand icon, else a
  // monogram of the id so there is never a broken/placeholder icon.
  function chainIcon(id) {
    const k = canonChain(id);
    return k ? CHAIN_ICONS[k] : monogram(id);
  }

  function svgDataUri(svg) {
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }

  // Is this asset the chain's native coin (vs. a token)?
  function isNative(asset) {
    if (!asset) return false;
    if (asset.kind && asset.kind !== 'native') return false;
    return !(asset.address || asset.mint || asset.contract);
  }

  // THE RESOLVER. Given an asset ({ chain, symbol, kind, address|mint|contract,
  // logo|logoURI }) return how to render its icon:
  //   • native coin        -> { kind:'chain', id, svg, dataUri }
  //   • token w/ logo URI   -> { kind:'image', src, fallback:{ svg, dataUri } }
  //   • token w/o logo URI  -> { kind:'monogram', text, color, svg, dataUri }
  // The `fallback` on an image is what the UI swaps in on a load error, so a
  // broken remote logo degrades to a clean monogram — never a broken image.
  function resolve(asset) {
    asset = asset || {};
    if (isNative(asset)) {
      const svg = chainIcon(asset.chain || asset.symbol);
      return { kind: 'chain', id: canonChain(asset.chain || asset.symbol), svg, dataUri: svgDataUri(svg) };
    }
    const uri = asset.logoURI || asset.logo || null;
    const text = asset.symbol || asset.name || asset.chain || '?';
    const fbSvg = monogram(text);
    const fallback = { svg: fbSvg, dataUri: svgDataUri(fbSvg), text: monoText(text), color: monoColor(text) };
    if (uri && typeof uri === 'string' && uri.trim()) {
      return { kind: 'image', src: uri.trim(), fallback };
    }
    return { kind: 'monogram', text: fallback.text, color: fallback.color, svg: fbSvg, dataUri: fallback.dataUri };
  }

  const API = {
    CHAIN_ICONS, CHAIN_ALIAS,
    canonChain, chainIcon, monogram, monoColor, monoText,
    svgDataUri, isNative, resolve,
  };
  global.Logos = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
