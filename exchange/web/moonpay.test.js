// moonpay.test.js — unit tests for the exchange MoonPay URL-building module.
//
//   node moonpay.test.js
//
// Covers:
//   • baseFromKey / sellBaseFromKey: pk_live_ -> production, else sandbox
//   • codeFor + codeForAsset: native vs token from the chain's native symbol,
//     BLOCK absent (no code), unknown chain/token null
//   • mergeMap override: tweak one code without dropping the rest
//   • buildWidgetUrl / buildSellUrl: host from key prefix + expected params
//   • fetchSignedUrl: {url} passthrough, {signature} append, failure fallback
//   • buyUrl / sellUrl: supported exchange asset -> ok+url, BLOCK -> unsupported
//
// No network (fetch is injected).

const MP = require('./moonpay.js');

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (got === want) pass++;
  else { fail++; console.log('FAIL ' + name + '\n  got  ' + got + '\n  want ' + want); }
}
function ok(name, cond) { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } }

// ---- host selection --------------------------------------------------------
{
  eq('pk_live -> live host', MP.baseFromKey('pk_live_abc'), MP.LIVE_BASE);
  eq('pk_test -> sandbox host', MP.baseFromKey('pk_test_abc'), MP.SANDBOX_BASE);
  eq('blank -> sandbox host', MP.baseFromKey(''), MP.SANDBOX_BASE);
  eq('pk_live -> sell live host', MP.sellBaseFromKey('pk_live_abc'), MP.SELL_LIVE_BASE);
  eq('pk_test -> sell sandbox host', MP.sellBaseFromKey('nonsense'), MP.SELL_SANDBOX_BASE);
}

// ---- codeFor + codeForAsset ------------------------------------------------
{
  const map = MP.effectiveMap({});
  eq('eth native', MP.codeFor(map, 'ethereum', { native: true }), 'eth');
  eq('eth USDC token', MP.codeFor(map, 'ethereum', { symbol: 'USDC' }), 'usdc');

  // codeForAsset decides native-vs-token from the chain's native symbol.
  eq('asset ETH -> native', MP.codeForAsset(map, 'ethereum', 'ETH'), 'eth');
  eq('asset eth lowercase -> native', MP.codeForAsset(map, 'ethereum', 'eth'), 'eth');
  eq('asset SOL -> native', MP.codeForAsset(map, 'solana', 'SOL'), 'sol');
  eq('asset USDC on eth -> token', MP.codeForAsset(map, 'ethereum', 'USDC'), 'usdc');
  eq('asset USDC on solana -> token', MP.codeForAsset(map, 'solana', 'USDC'), 'usdc_sol');
  eq('asset USDT on eth -> token', MP.codeForAsset(map, 'ethereum', 'USDT'), 'usdt');
  eq('asset BLOCK -> null', MP.codeForAsset(map, 'block', 'BLOCK'), null);
  eq('asset unknown chain -> null', MP.codeForAsset(map, 'nope', 'ETH'), null);
  eq('asset unknown token -> null', MP.codeForAsset(map, 'ethereum', 'WETH'), null);
  eq('asset empty symbol -> null', MP.codeForAsset(map, 'ethereum', ''), null);
  ok('isAssetSupported ETH', MP.isAssetSupported(map, 'ethereum', 'ETH'));
  ok('isAssetSupported USDC', MP.isAssetSupported(map, 'solana', 'USDC'));
  ok('isAssetSupported BLOCK false', !MP.isAssetSupported(map, 'block', 'BLOCK'));
}

// ---- mergeMap override -----------------------------------------------------
{
  const map = MP.effectiveMap({ currencyCodes: { ethereum: { tokens: { DAI: 'dai' } } } });
  eq('override adds eth DAI', MP.codeForAsset(map, 'ethereum', 'DAI'), 'dai');
  eq('override keeps eth USDC', MP.codeForAsset(map, 'ethereum', 'USDC'), 'usdc');
  eq('override keeps eth native', MP.codeForAsset(map, 'ethereum', 'ETH'), 'eth');
}

// ---- buildWidgetUrl / buildSellUrl -----------------------------------------
{
  const u = MP.buildWidgetUrl({ apiKey: 'pk_test_x', currencyCode: 'eth', walletAddress: '0xABC', baseCurrencyCode: 'usd', theme: 'dark' });
  ok('buy sandbox host', u.startsWith(MP.SANDBOX_BASE + '?'));
  ok('buy has apiKey', u.indexOf('apiKey=pk_test_x') >= 0);
  ok('buy has currencyCode', u.indexOf('currencyCode=eth') >= 0);
  ok('buy has walletAddress', u.indexOf('walletAddress=0xABC') >= 0);

  const live = MP.buildWidgetUrl({ apiKey: 'pk_live_y', currencyCode: 'btc' });
  ok('buy live host from key', live.startsWith(MP.LIVE_BASE + '?'));

  const s = MP.buildSellUrl({ apiKey: 'pk_test_x', baseCurrencyCode: 'eth', quoteCurrencyCode: 'usd', walletAddress: '0xABC' });
  ok('sell sandbox host', s.startsWith(MP.SELL_SANDBOX_BASE + '?'));
  ok('sell baseCurrencyCode is crypto', s.indexOf('baseCurrencyCode=eth') >= 0);
  ok('sell quoteCurrencyCode is fiat', s.indexOf('quoteCurrencyCode=usd') >= 0);
  ok('sell has no currencyCode param', s.indexOf('currencyCode=') < 0);
}

// ---- fetchSignedUrl + buyUrl/sellUrl ---------------------------------------
(async () => {
  const unsigned = 'https://buy-sandbox.moonpay.com?apiKey=pk_test_x&currencyCode=eth';

  const fakeUrl = async () => ({ ok: true, json: async () => ({ url: unsigned + '&signature=SIG' }) });
  eq('signed url passthrough', await MP.fetchSignedUrl('https://x/sign', unsigned, fakeUrl), unsigned + '&signature=SIG');

  const fakeSig = async () => ({ ok: true, json: async () => ({ signature: 'a/b+c=' }) });
  eq('signature appended+encoded', await MP.fetchSignedUrl('https://x/sign', unsigned, fakeSig),
     unsigned + '&signature=' + encodeURIComponent('a/b+c='));

  eq('no endpoint -> unsigned', await MP.fetchSignedUrl('', unsigned, fakeUrl), unsigned);

  // Cross-origin / network failure -> unsigned fallback (sandbox needs no sig).
  const fakeThrow = async () => { throw new Error('CORS blocked'); };
  eq('throw -> unsigned', await MP.fetchSignedUrl('https://x/sign', unsigned, fakeThrow), unsigned);

  // buyUrl from an exchange asset (default config; no signer).
  const buy = await MP.buyUrl({ chain: 'ethereum', symbol: 'ETH', walletAddress: '0xABC' });
  ok('buyUrl ETH ok', buy.ok === true && buy.code === 'eth');
  ok('buyUrl has walletAddress', buy.url.indexOf('walletAddress=0xABC') >= 0);
  ok('buyUrl sandbox host', buy.url.indexOf(MP.SANDBOX_BASE) === 0);

  const buyTok = await MP.buyUrl({ chain: 'solana', symbol: 'USDC', walletAddress: 'SoL1' });
  ok('buyUrl USDC-sol ok', buyTok.ok === true && buyTok.code === 'usdc_sol');

  const buyBlock = await MP.buyUrl({ chain: 'block', symbol: 'BLOCK', walletAddress: 'block1xyz' });
  ok('buyUrl BLOCK unsupported', buyBlock.ok === false && buyBlock.reason === 'unsupported');

  // sellUrl from an exchange asset, with a baseCurrencyAmount pre-fill.
  const sell = await MP.sellUrl({ chain: 'ethereum', symbol: 'ETH', walletAddress: '0xABC', baseCurrencyAmount: '1.5' });
  ok('sellUrl ETH ok', sell.ok === true && sell.code === 'eth');
  ok('sellUrl hits sell host', sell.url.indexOf(MP.SELL_SANDBOX_BASE) === 0);
  ok('sellUrl crypto in baseCurrencyCode', sell.url.indexOf('baseCurrencyCode=eth') >= 0);
  ok('sellUrl fiat in quoteCurrencyCode', sell.url.indexOf('quoteCurrencyCode=usd') >= 0);
  ok('sellUrl prefilled amount', sell.url.indexOf('baseCurrencyAmount=1.5') >= 0);
  ok('sellUrl unsigned (no signer)', sell.url.indexOf('signature=') < 0);

  const sellBlock = await MP.sellUrl({ chain: 'block', symbol: 'BLOCK', walletAddress: 'block1xyz' });
  ok('sellUrl BLOCK unsupported', sellBlock.ok === false && sellBlock.reason === 'unsupported');

  console.log(`moonpay.test.js: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
