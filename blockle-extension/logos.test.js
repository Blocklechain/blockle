// logos.test.js — CORRECT PER-CHAIN / PER-TOKEN LOGOS. Run:
//   node --test logos.test.js
//
// Asserts the reference logos.js resolver: bundled brand icons for every
// supported chain (offline, no remote fetch), the token logoURI path, and the
// colored-monogram fallback when a logo is absent or fails to load. There is
// never a broken / placeholder icon.

const { test } = require('node:test');
const assert = require('node:assert');

const Logos = require('./logos.js');

const SUPPORTED = ['btc', 'eth', 'sol', 'doge', 'ltc', 'block', 'bnb', 'base', 'polygon', 'arbitrum', 'optimism', 'avalanche'];

// A remote FETCH (src=/href=/url(...) to http(s)) — NOT the SVG xmlns namespace
// URI, which is a required identifier, not a network request.
function fetchesRemote(svg) {
  return /(?:src|href|xlink:href)\s*=\s*["']?\s*https?:/i.test(svg) || /url\(\s*['"]?\s*https?:/i.test(svg);
}

// ===========================================================================
// 1. BUNDLED CHAIN ICONS — present, inline SVG, offline (no http/data-remote)
// ===========================================================================
test('every supported chain has a bundled inline-SVG icon', () => {
  for (const id of SUPPORTED) {
    const svg = Logos.CHAIN_ICONS[id];
    assert.ok(svg, id + ' icon exists');
    assert.ok(/^<svg/.test(svg), id + ' is inline SVG');
    // OFFLINE: no remote references anywhere in the markup.
    assert.ok(!fetchesRemote(svg), id + ' icon fetches nothing remote');
  }
});

test('chainIcon resolves adapter ids + symbol aliases to the right brand icon', () => {
  assert.strictEqual(Logos.chainIcon('bitcoin'), Logos.CHAIN_ICONS.btc);
  assert.strictEqual(Logos.chainIcon('BTC'), Logos.CHAIN_ICONS.btc);
  assert.strictEqual(Logos.chainIcon('ethereum'), Logos.CHAIN_ICONS.eth);
  assert.strictEqual(Logos.chainIcon('evm'), Logos.CHAIN_ICONS.eth);
  assert.strictEqual(Logos.chainIcon('solana'), Logos.CHAIN_ICONS.sol);
  assert.strictEqual(Logos.chainIcon('dogecoin'), Logos.CHAIN_ICONS.doge);
  assert.strictEqual(Logos.chainIcon('litecoin'), Logos.CHAIN_ICONS.ltc);
  assert.strictEqual(Logos.chainIcon('block'), Logos.CHAIN_ICONS.block);
  assert.strictEqual(Logos.chainIcon('bsc'), Logos.CHAIN_ICONS.bnb);
  assert.strictEqual(Logos.chainIcon('matic'), Logos.CHAIN_ICONS.polygon);
});

test('chain brand colors are the recognizable ones', () => {
  assert.ok(Logos.CHAIN_ICONS.btc.includes('#f7931a'), 'BTC orange');
  assert.ok(Logos.CHAIN_ICONS.eth.includes('#627eea'), 'ETH periwinkle');
  assert.ok(Logos.CHAIN_ICONS.doge.includes('#c2a633'), 'DOGE gold');
  assert.ok(Logos.CHAIN_ICONS.ltc.includes('#345d9d'), 'LTC blue');
  assert.ok(Logos.CHAIN_ICONS.block.includes('#4c8dff'), 'BLOCK brand accent');
  assert.ok(Logos.CHAIN_ICONS.bnb.includes('#f3ba2f'), 'BNB yellow');
  assert.ok(Logos.CHAIN_ICONS.base.includes('#0052ff'), 'Base blue');
});

test('unknown chain never returns a broken icon — falls back to a monogram', () => {
  const svg = Logos.chainIcon('totally-unknown-chain');
  assert.ok(/^<svg/.test(svg));
  assert.ok(!fetchesRemote(svg));
});

// ===========================================================================
// 2. RESOLVE — native coin -> chain icon
// ===========================================================================
test('resolve(native) returns the chain brand icon', () => {
  const r = Logos.resolve({ chain: 'bitcoin', kind: 'native', symbol: 'BTC' });
  assert.strictEqual(r.kind, 'chain');
  assert.strictEqual(r.id, 'btc');
  assert.strictEqual(r.svg, Logos.CHAIN_ICONS.btc);
  assert.ok(r.dataUri.startsWith('data:image/svg+xml,'));

  // a native coin on an EVM L2 still resolves to its chain's brand icon
  const base = Logos.resolve({ chain: 'base', kind: 'native', symbol: 'ETH' });
  assert.strictEqual(base.id, 'base');
  assert.strictEqual(base.svg, Logos.CHAIN_ICONS.base);
});

// ===========================================================================
// 3. RESOLVE — token WITH a logoURI -> image + monogram fallback
// ===========================================================================
test('resolve(token w/ logoURI) renders the image and carries a monogram fallback', () => {
  const r = Logos.resolve({ chain: 'ethereum', kind: 'erc20', symbol: 'USDC',
    address: '0xA0b8', logoURI: 'https://tokens.example/usdc.png' });
  assert.strictEqual(r.kind, 'image');
  assert.strictEqual(r.src, 'https://tokens.example/usdc.png');
  // graceful fallback for an onerror swap — never a broken image
  assert.ok(r.fallback && /^<svg/.test(r.fallback.svg));
  assert.strictEqual(r.fallback.text, 'US');
});

test('resolve also accepts the discovery `logo` field', () => {
  const r = Logos.resolve({ chain: 'solana', kind: 'spl', symbol: 'BONK',
    mint: 'DezX', logo: 'https://img.example/bonk.png' });
  assert.strictEqual(r.kind, 'image');
  assert.strictEqual(r.src, 'https://img.example/bonk.png');
});

// ===========================================================================
// 4. RESOLVE — token WITHOUT a logo -> colored monogram fallback
// ===========================================================================
test('resolve(token w/o logo) returns a deterministic colored monogram', () => {
  const a = Logos.resolve({ chain: 'ethereum', kind: 'erc20', symbol: 'FOO', address: '0x1' });
  assert.strictEqual(a.kind, 'monogram');
  assert.strictEqual(a.text, 'FO');
  assert.ok(/^#/.test(a.color));
  assert.ok(/^<svg/.test(a.svg));
  assert.ok(a.svg.includes('FO'));
  // deterministic: same symbol -> same color
  const b = Logos.resolve({ chain: 'bnb', kind: 'erc20', symbol: 'FOO', address: '0x2' });
  assert.strictEqual(a.color, b.color);
});

test('an empty / whitespace logoURI degrades to the monogram (not a broken image)', () => {
  const r = Logos.resolve({ chain: 'ethereum', kind: 'erc20', symbol: 'BAR', address: '0x3', logoURI: '   ' });
  assert.strictEqual(r.kind, 'monogram');
  assert.strictEqual(r.text, 'BA');
});

test('monogram is XML-safe and single-or-double char', () => {
  assert.strictEqual(Logos.monoText('x'), 'X');
  assert.strictEqual(Logos.monoText('usd-coin'), 'US');
  assert.strictEqual(Logos.monoText('<script>'), 'SC');
  const svg = Logos.monogram('<b>&"');
  assert.ok(!svg.includes('<b>'), 'no raw markup injected');
});
