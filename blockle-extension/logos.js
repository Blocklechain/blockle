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

  // ---- REAL brand marks -----------------------------------------------------
  // `brand(bg, innerMarkup)` = a brand-colored 32x32 disc with the REAL logo as
  // inline vector paths (monochrome glyph, not a generated letter). Self-contained,
  // offline, CSP-safe. `bg==='none'` draws just the paths (transparent disc) for
  // marks that already carry their own background.
  function brand(bg, inner) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">'
      + (bg === 'none' ? '' : '<circle cx="16" cy="16" r="16" fill="' + bg + '"/>')
      + inner + '</svg>';
  }

  // Each P is the real brand glyph path(s), white (#fff) on the brand disc unless noted.
  const P = {
    // Bitcoin ₿ (official).
    btc: '<path fill="#fff" d="M23.19 14.02c.31-2.1-1.28-3.22-3.47-3.98l.71-2.84-1.73-.43-.69 2.77c-.45-.12-.92-.22-1.38-.33l.69-2.78-1.73-.43-.71 2.84c-.38-.09-.75-.17-1.1-.26l.002-.01-2.38-.6-.46 1.85s1.28.29 1.26.31c.7.17.82.64.8 1.01l-.8 3.23c.05.01.11.03.18.06l-.18-.05-1.13 4.53c-.09.21-.3.53-.79.41.02.02-1.26-.31-1.26-.31l-.86 1.98 2.25.56c.42.11.83.22 1.23.32l-.71 2.87 1.73.43.71-2.84c.47.13.93.25 1.38.36l-.71 2.83 1.73.43.71-2.87c2.95.56 5.16.33 6.1-2.33.75-2.15-.04-3.39-1.59-4.19 1.13-.26 1.98-1 2.21-2.54zm-3.95 5.54c-.53 2.15-4.15.99-5.32.7l.95-3.81c1.17.29 4.93.87 4.37 3.11zm.53-5.57c-.49 1.95-3.5.96-4.47.72l.86-3.45c.98.24 4.12.7 3.61 2.73z"/>',
    // Ethereum octahedron (official cryptocurrency-icons).
    eth: '<g fill="#fff"><path fill-opacity=".6" d="M16.5 4v8.87l7.5 3.35z"/><path d="M16.5 4L9 16.22l7.5-3.35z"/><path fill-opacity=".6" d="M16.5 21.97v6.03L24 17.62z"/><path d="M16.5 28v-6.03L9 17.62z"/><path fill-opacity=".2" d="M16.5 20.57l7.5-4.35-7.5-3.35z"/><path fill-opacity=".6" d="M9 16.22l7.5 4.35v-7.7z"/></g>',
    // Dogecoin Ð.
    doge: '<path fill="#fff" d="M11 9h5.2c3.9 0 6.3 2.6 6.3 7s-2.4 7-6.3 7H11v-6H9v-2.2h2V9zm2.6 2.3v3.5H16v2.2h-2.4v3.4h2.4c2.3 0 3.6-1.6 3.6-4.6s-1.3-4.5-3.6-4.5h-2.4z"/>',
    // Litecoin Ł (official).
    ltc: '<path fill="#fff" d="M10.43 19.21L9 19.77l.67-2.65 1.44-.57L13.17 8h5.34l-1.65 6.59 1.42-.57-.67 2.65-1.52.59-.86 3.43h8.08L21.95 24H9.87z"/>',
    // Bitcoin Cash (B, official style).
    bch: '<path fill="#fff" d="M21.21 10.53c-.78-2.32-3.14-2.74-5.96-2.22l-.9-2.82-1.72.55.88 2.74c-.45.14-.91.3-1.37.45l-.89-2.76-1.71.55.9 2.82c-.37.12-.73.25-1.09.36l-.003-.01-2.37.76.57 1.77s1.27-.42 1.25-.4c.7-.22 1.03.15 1.2.5l1.03 3.21c.05-.02.12-.04.2-.06l-.2.07 1.45 4.5c.04.17.01.45-.36.58.02.01-1.25.4-1.25.4l.28 2.07 2.23-.72c.42-.13.83-.26 1.23-.39l.91 2.85 1.71-.55-.9-2.82c.47-.14.93-.29 1.38-.44l.9 2.8 1.72-.55-.91-2.84c2.72-.5 4.59-1.63 4.26-4.24-.27-2.1-1.49-2.77-3.06-2.79.88-.63 1.37-1.59.91-2.97zm-1.29 5.95c.38 2.1-2.99 2.61-4.08 2.96l-1.21-3.78c1.09-.35 4.77-1.37 5.29.82zm-1.67-5.15c.35 1.91-2.46 2.31-3.37 2.6l-1.1-3.42c.91-.29 3.9-1.25 4.47.82z"/>',
    // TRON (official).
    tron: '<path fill="#fff" d="M20.67 10.68c-.93-.86-2.21-2.16-3.26-3.07l-.06-.04a1 1 0 0 0-.32-.18l-.01-.002c-2.26-.54-12.94-2.54-13.15-2.51a.4.4 0 0 0-.16.06l-.06.05a.57.57 0 0 0-.13.21l-.02.04v.21l.004.03C4.7 9.9 9.44 20.86 10.37 23.44c.06.17.16.5.36.52h.04c.11 0 .56-.59.56-.59s8.04-9.74 8.85-10.78c.11-.13.2-.27.28-.41a.69.69 0 0 0-.19-1.49zm-5.08 1.31l3.43-2.85 2.01 1.85-5.44.99zm-1.33-.19L8.47 7.27l9.56 1.76-3.77 3.14zm.53 1.27l6.04-.97-6.91 8.32.87-7.34zM7.18 7.82l6 5.09-.9 7.64L7.18 7.82z"/>',
    // TON diamond (official).
    ton: '<path fill="#fff" d="M22.5 9.3c0-.73-.6-1.3-1.3-1.3H10.8c-.73 0-1.3.6-1.3 1.3 0 .3.1.6.28.88l5.2 8.9c.4.63 1.2.63 1.6 0l5.2-8.9c.19-.28.29-.58.29-.88zm-7.1 7.83l-1.1-2.13-2.73-4.88a.1.1 0 0 1 .09-.15h3.74v7.16zm4.06-7.01l-2.73 4.88-1.1 2.13v-7.16h3.74a.1.1 0 0 1 .09.15z"/>',
    // XRP ledger "X" (official).
    xrp: '<path fill="#fff" d="M22.2 8.5h2.8l-5.83 5.78a4.56 4.56 0 0 1-6.42 0L6.94 8.5h2.82l4.4 4.36c.98.97 2.62.97 3.6 0L22.2 8.5zM9.74 23.5H6.94l5.86-5.81a4.56 4.56 0 0 1 6.42 0L25.1 23.5h-2.82l-4.44-4.4a2.56 2.56 0 0 0-3.6 0L9.74 23.5z"/>',
    // Stellar twin-arc rocket (official).
    stellar: '<path fill="#fff" d="M23.86 9.17l-2.27 1.16-11.1 5.65a6.18 6.18 0 0 1-.02-.46 6.1 6.1 0 0 1 9.1-5.3l1.3-.66.2-.1A7.54 7.54 0 0 0 8.78 15.2c0 .24 0 .48.03.72.03.47-.2.92-.62 1.13l-.83.43v1.68l1.92-.98.62-.32.6-.31 11.82-6.02.83-.43V9.17zm0 2.65L10.3 18.73l-1.3.66A7.54 7.54 0 0 0 23.2 15.8c0-.24 0-.48-.03-.72a1.26 1.26 0 0 1 .64-1.13l.83-.43v-1.68l-1.9.97-.64.33-.6.31-11.84 6.03-.83.43v1.66l2.27-1.16 11.1-5.65c0 .15.02.3.02.46a6.1 6.1 0 0 1-9.1 5.31l-.1.05-1.42.73A7.54 7.54 0 0 0 23.86 14z"/>',
    // Tezos ꜩ.
    tezos: '<path fill="#fff" d="M15.07 6.9h2.2v3.3h3.6v1.95h-3.6v5.08c0 .83.1 1.35.42 1.65.3.28.72.42 1.2.42.42 0 .9-.1 1.4-.3v2.05c-.63.3-1.33.45-2.05.45-1.13 0-2-.3-2.64-.92-.63-.6-.94-1.5-.94-2.72v-5.6h-2.3v-1.4l4.7-5.03V6.9z"/>',
    // Cardano ADA cluster.
    cardano: '<g fill="#fff"><circle cx="16" cy="16" r="2.1"/><circle cx="16" cy="8.3" r="1.25"/><circle cx="16" cy="23.7" r="1.25"/><circle cx="9.9" cy="12.15" r="1.25"/><circle cx="22.1" cy="12.15" r="1.25"/><circle cx="9.9" cy="19.85" r="1.25"/><circle cx="22.1" cy="19.85" r="1.25"/><circle cx="11.2" cy="16" r="1"/><circle cx="20.8" cy="16" r="1"/></g>',
    // Polygon (official).
    polygon: '<path fill="#fff" d="M20.63 12.9c-.37-.21-.85-.21-1.26 0l-2.93 1.73-1.98 1.1-2.88 1.73c-.37.21-.85.21-1.26 0l-2.25-1.36a1.28 1.28 0 0 1-.63-1.1v-2.62c0-.42.21-.84.63-1.1l2.25-1.31c.37-.21.85-.21 1.26 0l2.25 1.36c.37.21.63.63.63 1.1v1.73l1.98-1.15v-1.78c0-.42-.21-.84-.63-1.1l-4.18-2.46c-.37-.21-.85-.21-1.26 0L5.86 10.5c-.42.26-.63.68-.63 1.1v4.92c0 .42.21.84.63 1.1l4.23 2.46c.37.21.85.21 1.26 0l2.88-1.67 1.98-1.15 2.88-1.68c.37-.21.85-.21 1.26 0l2.25 1.31c.37.21.63.63.63 1.1v2.62c0 .42-.21.84-.63 1.1l-2.19 1.31c-.37.21-.85.21-1.26 0l-2.25-1.31a1.28 1.28 0 0 1-.63-1.1v-1.68l-1.98 1.15v1.73c0 .42.21.84.63 1.1l4.23 2.46c.37.21.85.21 1.26 0l4.23-2.46c.37-.21.63-.63.63-1.1v-4.92c0-.42-.21-.84-.63-1.1l-4.28-2.51z"/>',
    // Avalanche (official).
    avalanche: '<path fill="#fff" d="M19.1 13.2c.46-.8 1.2-.8 1.66 0l2.86 5.03c.46.8.09 1.46-.83 1.46h-5.78c-.9 0-1.3-.66-.84-1.46l2.77-5.03zm-4.5-8.6c.46-.8 1.18-.8 1.64 0l.64 1.14 1.5 2.63c.37.75.37 1.63 0 2.38l-5.02 8.7c-.46.71-1.22 1.16-2.08 1.2H7.78c-.93 0-1.3-.65-.84-1.46L14.6 4.6z"/>',
    // Binance BNB (dark glyph on yellow).
    bnb: '<path fill="#1e2026" d="M12.12 14.26L16 10.38l3.88 3.88 2.26-2.26L16 5.86l-6.14 6.14 2.26 2.26zM6.5 16l2.26-2.26L11.02 16l-2.26 2.26L6.5 16zm5.62 1.74L16 21.62l3.88-3.88 2.26 2.26L16 26.14l-6.14-6.14 2.26-2.26zM20.98 16l2.26-2.26L25.5 16l-2.26 2.26L20.98 16zm-2.69-.01L16 13.68l-1.7 1.7-.19.2-.41.4 2.3 2.3 2.29-2.3z"/>',
    // Base (official — disc with flat ledge).
    base: '<path fill="#fff" d="M16 24.5c4.7 0 8.5-3.8 8.5-8.5S20.7 7.5 16 7.5c-4.46 0-8.12 3.44-8.47 7.81h11.24v1.38H7.53A8.5 8.5 0 0 0 16 24.5z"/>',
    // Arbitrum (chevron mark).
    arbitrum: '<g fill="#fff"><path d="M15.3 6.6c.42-.24.94-.24 1.36 0l6.1 3.52c.42.24.68.69.68 1.18v5.3l-2.1-3.63-3.9-6.74-2.14 1.24zM16 10.2l3.62 6.28 1.9 3.3-1.3.75-4.22-7.3-1.64 2.84 2.56 4.43-1.35.78L12.3 16l3.7-6.4z"/><path d="M13.6 13.1l-3.1 5.36 1.02.6 3.1-5.36-1.02-.6z" opacity=".55"/></g>',
    // Optimism (OP wordmark).
    optimism: '<g fill="#fff"><path d="M11.9 12.8c-1.95 0-3.5 1.12-3.9 3.06l-.5 2.42c-.07.33-.1.64-.1.9 0 1.63 1.2 2.74 3.22 2.74 1.95 0 3.5-1.12 3.9-3.06l.5-2.42c.06-.33.1-.64.1-.9 0-1.63-1.2-2.74-3.22-2.74zm1.02 3.68l-.5 2.5c-.2.9-.82 1.4-1.6 1.4-.72 0-1.12-.4-1.12-1.1 0-.1 0-.2.02-.3l.5-2.5c.18-.9.8-1.4 1.6-1.4.72 0 1.12.4 1.12 1.1 0 .1 0 .2-.02.3zM20.1 12.95h-3.72l-1.6 7.72h1.8l.48-2.3h1.92c1.92 0 3.12-1 3.44-2.6.02-.1.04-.2.05-.3.03-.2.05-.37.05-.54 0-1.22-.9-1.98-2.42-1.98zm.6 2.5c-.14.65-.6.95-1.3.95h-1.4l.44-2.1h1.42c.56 0 .9.26.9.75 0 .07 0 .13-.02.2z"/></g>',
    // Hyperliquid (HYPE) — teal brand "H".
    hype: '<path fill="#072723" d="M9 9h2.9v4.4c.6-.8 1.5-1.3 2.7-1.3 1 0 1.8.3 2.4.9.6.6.9 1.5.9 2.6V23h-2.9v-6.5c0-.9-.5-1.4-1.3-1.4-.9 0-1.5.6-1.5 1.6V23H9V9zm9.8 0h2.9v14h-2.9V9z"/>',
    // Blockle BLOCK mark — the Blockle "B" stack on brand blue.
    block: '<g fill="#fff"><path d="M10 8h7.3c2.1 0 3.6 1.3 3.6 3.3 0 1.3-.7 2.3-1.8 2.8 1.4.4 2.3 1.5 2.3 3.1 0 2.2-1.6 3.6-4 3.6H10V8zm2.9 2.5v2.7h3.4c1 0 1.6-.5 1.6-1.35 0-.85-.6-1.35-1.6-1.35h-3.4zm0 5v2.8h3.7c1.05 0 1.7-.55 1.7-1.4 0-.85-.65-1.4-1.7-1.4h-3.7z"/></g>',
  };

  const CHAIN_ICONS = {
    btc:       brand('#f7931a', P.btc),
    eth:       brand('#627eea', P.eth),
    sol:       solDisc(),
    doge:      brand('#c2a633', P.doge),
    ltc:       brand('#345d9d', P.ltc),
    bch:       brand('#0ac18e', P.bch),
    tron:      brand('#ec0623', P.tron),
    ton:       brand('#0098ea', P.ton),
    xrp:       brand('#23292f', P.xrp),
    stellar:   brand('#000000', P.stellar),
    tezos:     brand('#2c7df7', P.tezos),
    cardano:   brand('#0033ad', P.cardano),
    block:     brand('#4c8dff', P.block),       // Blockle brand mark
    bnb:       brand('#f3ba2f', P.bnb),
    base:      brand('#0052ff', P.base),
    polygon:   brand('#8247e5', P.polygon),
    arbitrum:  brand('#28a0f0', P.arbitrum),
    optimism:  brand('#ff0420', P.optimism),
    avalanche: brand('#e84142', P.avalanche),
    hype:      brand('#97fce4', P.hype),          // Hyperliquid teal
  };

  // ---- REAL default/known-TOKEN brand marks ---------------------------------
  // Keyed `chain:SYMBOL`, `chain:ADDRESS`, or `*:SYMBOL` (brand shared across every
  // chain the token lives on — the UI overlays a per-chain badge). Resolved in
  // resolve() BEFORE the runtime logoURI, so every default/known token shows its
  // REAL brand mark; genuinely-unknown imported tokens still fall to monogram().
  // Block-native marks (BLOCK, USDB=usdb-token.svg, WORLD=world-token.svg) are NOT
  // here — BLOCK uses the chain icon; USDB/WORLD carry their own logoURI.
  const TOK = {
    usdt: brand('#26a17b', '<path fill="#fff" d="M17.9 14.6v-1.9h4.3V9.9H9.8v2.8h4.3v1.9c-3.5.16-6.13.85-6.13 1.68s2.63 1.52 6.13 1.68v6.03h3.8v-6.03c3.49-.16 6.11-.85 6.11-1.68s-2.62-1.52-6.11-1.68zm0 2.84v-.003c-.09.006-.55.034-1.55.034-.8 0-1.37-.025-1.57-.034v.004c-3.08-.136-5.37-.673-5.37-1.316s2.3-1.18 5.37-1.316v2.096c.2.014.78.048 1.59.048.96 0 1.44-.04 1.53-.048v-2.096c3.07.135 5.36.673 5.36 1.316s-2.29 1.18-5.36 1.315z"/>'),
    usdc: brand('#2775ca', '<g fill="#fff"><path d="M16 6.2c-.3 0-.55.25-.55.56v.82c-2.9.38-5.1 2.85-5.1 5.84 0 2.99 2.2 5.46 5.1 5.84v.82c0 .3.25.55.55.55a.55.55 0 0 0 .55-.55v-.82c2.9-.38 5.1-2.85 5.1-5.84 0-3-2.2-5.46-5.1-5.84v-.82A.55.55 0 0 0 16 6.2z" opacity="0"/><path d="M15.4 20.3v-.8c-1.4-.19-2.08-.97-2.26-2.03-.03-.19.11-.35.3-.35h.76c.15 0 .28.1.32.26.13.52.43.92 1.36.92.68 0 1.17-.38 1.17-.95 0-.57-.3-.79-1.37-.97-1.57-.21-2.31-.69-2.31-1.92 0-.95.72-1.69 1.83-1.85v-.79c0-.28.22-.5.5-.5h.5c.28 0 .5.22.5.5v.81c1.03.18 1.68.77 1.89 1.72.04.19-.1.37-.3.37h-.7a.33.33 0 0 1-.32-.24c-.18-.5-.54-.72-1.17-.72-.7 0-1.06.34-1.06.82 0 .5.21.75 1.36.9 1.54.21 2.33.65 2.33 1.99 0 1-.74 1.8-1.9 1.98v.77c0 .28-.22.5-.5.5h-.5a.5.5 0 0 1-.5-.5z"/><path d="M18.17 9.1c-.22-.05-.37.1-.37.3v.5c0 .25.15.42.35.5a5.3 5.3 0 0 1 0 9.98c-.2.08-.35.25-.35.5v.52c0 .2.15.35.37.3a6.67 6.67 0 0 0 0-12.6zm-4.34 0a6.67 6.67 0 0 0 0 12.6c.22.05.37-.1.37-.3v-.52c0-.25-.15-.42-.35-.5a5.3 5.3 0 0 1 0-9.98c.2-.08.35-.25.35-.5v-.5c0-.2-.15-.35-.37-.3z" opacity=".5"/></g>'),
    dai: brand('#f5ac37', '<path fill="#fff" d="M11 11.4h5.1c2.6 0 4.5 1.4 5.2 3.5h1.2v1.4h-.95c.02.17.03.35.03.53v.03c0 .14 0 .28-.02.42h.91v1.4h-1.18c-.72 2.1-2.6 3.5-5.2 3.5H11v-3.5H9.5v-1.4H11v-.9H9.5v-1.4H11v-3.58zm1.7 1.5v2.08h6.78c-.55-1.2-1.68-2.08-3.4-2.08h-3.38zm0 5.5v2.1h3.38c1.72 0 2.85-.9 3.4-2.1h-6.78zm0-2.52v.9h7.3c.02-.14.02-.28.02-.42v-.03c0-.17-.01-.3-.02-.45h-7.3z"/>'),
    link: brand('#2a5ada', '<path fill="#fff" d="M16 6l-1.8 1.05L9.3 9.9 7.5 10.95v10.1L9.3 22.1l4.95 2.85L16 26l1.8-1.05 4.9-2.85 1.8-1.05v-10.1L22.7 9.9l-4.9-2.85L16 6zm-4.9 11.95v-5.9L16 9.1l4.9 2.95v5.9L16 20.9l-4.9-2.95z"/>'),
    xaut: brand('#cfa959', '<path fill="#fff" d="M17.9 14.6v-1.9h4.3V9.9H9.8v2.8h4.3v1.9c-3.5.16-6.13.85-6.13 1.68s2.63 1.52 6.13 1.68v6.03h3.8v-6.03c3.49-.16 6.11-.85 6.11-1.68s-2.62-1.52-6.11-1.68zm0 2.84v-.003c-.09.006-.55.034-1.55.034-.8 0-1.37-.025-1.57-.034v.004c-3.08-.136-5.37-.673-5.37-1.316s2.3-1.18 5.37-1.316v2.096c.2.014.78.048 1.59.048.96 0 1.44-.04 1.53-.048v-2.096c3.07.135 5.36.673 5.36 1.316s-2.29 1.18-5.36 1.315z"/>'),
    wbtc: brand('#201a2d', P.btc),
    pol: brand('#8247e5', P.polygon),
  };
  const TOKEN_ICONS = {
    '*:USDT': TOK.usdt, '*:USDC': TOK.usdc, '*:USDC.E': TOK.usdc, '*:USDBC': TOK.usdc,
    '*:DAI': TOK.dai, '*:LINK': TOK.link, '*:XAUT': TOK.xaut, '*:WBTC': TOK.wbtc,
    '*:POL': TOK.pol, '*:MATIC': TOK.pol,
  };

  // chain id (adapter id or symbol) -> canonical icon key.
  const CHAIN_ALIAS = {
    bitcoin: 'btc', btc: 'btc',
    ethereum: 'eth', eth: 'eth', evm: 'eth',
    solana: 'sol', sol: 'sol',
    dogecoin: 'doge', doge: 'doge',
    litecoin: 'ltc', ltc: 'ltc',
    bitcoincash: 'bch', bch: 'bch',
    tron: 'tron', trx: 'tron',
    ton: 'ton', toncoin: 'ton',
    xrp: 'xrp', xrpl: 'xrp', ripple: 'xrp',
    stellar: 'stellar', xlm: 'stellar',
    tezos: 'tezos', xtz: 'tezos',
    cardano: 'cardano', ada: 'cardano',
    block: 'block', blockle: 'block',
    bnb: 'bnb', bsc: 'bnb', binance: 'bnb',
    base: 'base',
    polygon: 'polygon', pol: 'polygon', matic: 'polygon',
    arbitrum: 'arbitrum', arb: 'arbitrum',
    optimism: 'optimism', op: 'optimism',
    avalanche: 'avalanche', avax: 'avalanche',
    hype: 'hype', hyperliquid: 'hype', hyperevm: 'hype',
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
  // A known default/known-token brand mark, or null. Keyed chain:ADDRESS first
  // (contract-specific), then chain:SYMBOL, then *:SYMBOL (brand shared across
  // every chain the token lives on). Case-normalized.
  function tokenIcon(asset) {
    if (!asset) return null;
    const sym = String(asset.symbol || '').toUpperCase();
    const addr = String(asset.address || asset.mint || asset.contract || '').toLowerCase();
    const ch = canonChain(asset.chain) || String(asset.chain || '').toLowerCase();
    if (ch && addr && TOKEN_ICONS[ch + ':' + addr]) return TOKEN_ICONS[ch + ':' + addr];
    if (ch && sym && TOKEN_ICONS[ch + ':' + sym]) return TOKEN_ICONS[ch + ':' + sym];
    if (sym && TOKEN_ICONS['*:' + sym]) return TOKEN_ICONS['*:' + sym];
    return null;
  }

  function resolve(asset) {
    asset = asset || {};
    if (isNative(asset)) {
      const svg = chainIcon(asset.chain || asset.symbol);
      return { kind: 'chain', id: canonChain(asset.chain || asset.symbol), svg, dataUri: svgDataUri(svg) };
    }
    // Real brand mark for a default/known token BEFORE the runtime logoURI.
    const tsvg = tokenIcon(asset);
    if (tsvg) return { kind: 'token', svg: tsvg, dataUri: svgDataUri(tsvg) };
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
    CHAIN_ICONS, CHAIN_ALIAS, TOKEN_ICONS,
    canonChain, chainIcon, tokenIcon, monogram, monoColor, monoText,
    svgDataUri, isNative, resolve,
  };
  global.Logos = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
