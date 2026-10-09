// discovery.test.js — unit tests for token auto-detection.
//
//   node discovery.test.js
//
// Covers:
//   • TokenDiscovery.mergeTokens: dedupe by (chain,contract|mint), non-zero
//     first, default-list preserved, spam filter, metadata merge
//   • EVM adapter.discoverTokens: parses alchemy_getTokenBalances +
//     alchemy_getTokenMetadata (mocked fetch); skips zero/errored balances
//   • EVM adapter.discoverTokens: alchemy OFF (no key) => [] (known-list fallback)
//   • Solana adapter.discoverTokens: parses getTokenAccountsByOwner jsonParsed,
//     sums multiple accounts per mint, drops zero
//   • registry.discoverTokens: merges adapter discovery with the default list
//
// No real network: global.fetch is stubbed per-case.

const assert = require('node:assert');
const D = require('./chains/discovery.js');
const E = require('./chains/evm.js');
const SOL = require('./chains/solana.js');
const REG = require('./chains/registry.js');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.log('FAIL ' + name); } }
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log('FAIL ' + name + '\n  got  ' + g + '\n  want ' + w); }
}

// A one-shot fetch stub: each POST returns the next queued JSON-RPC result.
function stubFetch(results) {
  let i = 0;
  const calls = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, method: body.method, params: body.params });
    const r = results[i++];
    if (r === undefined) throw new Error('no stubbed result for call ' + i);
    return { async json() { return { jsonrpc: '2.0', id: body.id, result: r }; } };
  };
  return calls;
}

// ---- mergeTokens: dedupe + non-zero first + defaults preserved ----
{
  const defaults = [
    { chain: 'ethereum', kind: 'erc20', symbol: 'USDC', decimals: 6, address: '0xAAA' },
    { chain: 'ethereum', kind: 'erc20', symbol: 'USDT', decimals: 6, address: '0xBBB' },
  ];
  const discovered = [
    // same as USDC (different case) but now WITH a balance -> should merge, keep one row
    { chain: 'ethereum', kind: 'erc20', symbol: 'USDC', decimals: 6, address: '0xaaa', balance: '1500000', display: '1.5' },
    // a brand-new token with a balance
    { chain: 'ethereum', kind: 'erc20', symbol: 'DAI', decimals: 18, address: '0xCCC', balance: '2000000000000000000', display: '2' },
  ];
  const merged = D.mergeTokens(defaults, discovered);
  eq('merge dedupes USDC to one row', merged.filter((t) => t.symbol === 'USDC').length, 1);
  eq('merge yields 3 rows total (USDC,USDT,DAI)', merged.length, 3);
  ok('merge: USDC carries the discovered balance', merged.find((t) => t.symbol === 'USDC').balance === '1500000');
  ok('merge: USDC kept isDefault', merged.find((t) => t.symbol === 'USDC').isDefault === true);
  ok('merge: DAI is not default', merged.find((t) => t.symbol === 'DAI').isDefault === false);
  // non-zero first: USDC + DAI (have balances) precede USDT (none)
  eq('merge non-zero first', merged[merged.length - 1].symbol, 'USDT');
}

// ---- mergeTokens: spam filter hides zero-balance + spammy non-defaults ----
{
  const defaults = [{ chain: 'ethereum', kind: 'erc20', symbol: 'USDC', decimals: 6, address: '0xAAA' }];
  const discovered = [
    { chain: 'ethereum', kind: 'erc20', symbol: 'REAL', decimals: 18, address: '0xC1', balance: '5', display: '5' },
    { chain: 'ethereum', kind: 'erc20', symbol: 'Visit claim-airdrop.xyz', decimals: 18, address: '0xC2', balance: '999', display: '999' },
    { chain: 'ethereum', kind: 'erc20', symbol: 'ZERO', decimals: 18, address: '0xC3', balance: '0', display: '0' },
  ];
  const merged = D.mergeTokens(defaults, discovered, { spamFilter: true });
  const syms = merged.map((t) => t.symbol).sort();
  eq('spam filter keeps USDC(default)+REAL only', syms, ['REAL', 'USDC']);
}

// ---- mergeTokens: dedupe across Solana mints ----
{
  const merged = D.mergeTokens(
    [],
    [
      { chain: 'solana', kind: 'spl', mint: 'MintA', decimals: 6, balance: '10' },
      { chain: 'solana', kind: 'spl', mint: 'MintA', decimals: 6, balance: '5' }, // dup key -> last wins
    ],
  );
  eq('solana mint dedupe to 1', merged.length, 1);
}

// ---- EVM discoverTokens: alchemy ON (mocked) ----
(async () => {
  const calls = stubFetch([
    // alchemy_getTokenBalances
    { address: '0xme', tokenBalances: [
      { contractAddress: '0xToken1', tokenBalance: '0x0000000000000000000000000000000000000000000000000000000000000064' }, // 100
      { contractAddress: '0xZero', tokenBalance: '0x0' }, // skipped
      { contractAddress: '0xErr', tokenBalance: '0x5', error: 'boom' }, // skipped
    ] },
    // alchemy_getTokenMetadata for 0xToken1
    { decimals: 2, symbol: 'TKN', name: 'Token One', logo: 'https://logo' },
  ]);
  const evm = E.createEvmAdapter({ id: 'ethereum', chainId: 1, symbol: 'ETH', rpcUrl: 'http://rpc', alchemy: 'http://alchemy/key' });
  const found = await evm.discoverTokens('0xme');
  eq('evm discover: 1 non-zero token', found.length, 1);
  eq('evm discover: symbol', found[0].symbol, 'TKN');
  eq('evm discover: decimals', found[0].decimals, 2);
  eq('evm discover: balance base units', found[0].balance, '100');
  eq('evm discover: display', found[0].display, '1');
  eq('evm discover: logo passed through', found[0].logo, 'https://logo');
  ok('evm discover: first call is getTokenBalances', calls[0].method === 'alchemy_getTokenBalances');
  ok('evm discover: metadata call made', calls.some((c) => c.method === 'alchemy_getTokenMetadata'));

  // ---- EVM discoverTokens: alchemy OFF -> [] (no network touched) ----
  let touched = false;
  global.fetch = async () => { touched = true; throw new Error('should not fetch'); };
  const evmOff = E.createEvmAdapter({ id: 'ethereum', chainId: 1, symbol: 'ETH', rpcUrl: 'http://rpc' /* no alchemy */ });
  const none = await evmOff.discoverTokens('0xme');
  eq('evm discover OFF: empty', none, []);
  ok('evm discover OFF: no fetch', touched === false);

  // ---- Solana discoverTokens (mocked) ----
  stubFetch([
    { value: [
      { account: { data: { parsed: { info: { mint: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', tokenAmount: { amount: '30', decimals: 6 } } } } } },
      { account: { data: { parsed: { info: { mint: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', tokenAmount: { amount: '12', decimals: 6 } } } } } }, // same mint -> sum
      { account: { data: { parsed: { info: { mint: 'MintZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ', tokenAmount: { amount: '0', decimals: 0 } } } } } }, // zero -> dropped
    ] },
  ]);
  const sol = SOL.createSolanaAdapter({ rpcUrl: 'http://sol' });
  const sfound = await sol.discoverTokens('OwnerPubkey');
  eq('solana discover: 1 non-zero mint', sfound.length, 1);
  eq('solana discover: summed amount', sfound[0].balance, '42');
  eq('solana discover: decimals', sfound[0].decimals, 6);
  ok('solana discover: kind spl', sfound[0].kind === 'spl');
  ok('solana discover: mint preserved', sfound[0].mint.startsWith('MintA'));

  // ---- registry.discoverTokens: merges adapter discovery with defaults ----
  stubFetch([
    { address: '0xme', tokenBalances: [
      { contractAddress: '0xNEW', tokenBalance: '0x0000000000000000000000000000000000000000000000000000000000000005' },
    ] },
    { decimals: 0, symbol: 'NEW', name: 'New Token' },
  ]);
  const reg = REG.createRegistry({ alchemy: { apiKey: 'testkey' } });
  const merged = await reg.discoverTokens('ethereum', '0xme', { spamFilter: true });
  ok('registry discover: includes default USDC', merged.some((t) => t.symbol === 'USDC' && t.isDefault));
  ok('registry discover: includes discovered NEW with balance', merged.some((t) => t.symbol === 'NEW' && t.balance === '5'));

  // ---- registry: alchemy resolution + expanded EVM set ----
  ok('resolveAlchemy composes shared key', REG.resolveAlchemy({ apiKey: 'K' }, 'base') === REG.ALCHEMY_HOSTS.base + 'K');
  ok('resolveAlchemy per-net url wins', REG.resolveAlchemy({ polygon: 'http://custom' }, 'polygon') === 'http://custom');
  ok('resolveAlchemy none -> null', REG.resolveAlchemy({}, 'ethereum') === null);
  ok('resolveAlchemy: bnb has no host -> null even with key', REG.resolveAlchemy({ apiKey: 'K' }, 'bnb') === null);
  const reg2 = REG.createRegistry({});
  const en = reg2.enabled();
  ok('registry enables all 7 EVM chains', ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bnb', 'avalanche'].every((c) => en.includes(c)));
  ok('registry: bnb native is BNB', reg2.get('bnb').native.symbol === 'BNB');
  ok('registry: polygon native is POL', reg2.get('polygon').native.symbol === 'POL');
  ok('registry: avalanche native is AVAX', reg2.get('avalanche').native.symbol === 'AVAX');
  ok('registry: arbitrum default USDC present', reg2.tokensFor('arbitrum').some((t) => t.symbol === 'USDC'));
  // BNB/Avalanche not Alchemy-backed: discoverTokens returns the known list only (no fetch).
  let bnbTouched = false;
  global.fetch = async () => { bnbTouched = true; throw new Error('no fetch for bnb discovery'); };
  const bnbMerged = await reg2.discoverTokens('bnb', '0xme', {});
  ok('bnb discover: known-list fallback (no fetch)', bnbTouched === false && bnbMerged.some((t) => t.symbol === 'USDC'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
