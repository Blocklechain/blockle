// moonpay.test.js — unit tests for the MoonPay fiat on-ramp module.
//
//   node moonpay.test.js
//
// Covers:
//   • baseFromKey: pk_live_ -> production host, everything else -> sandbox
//   • codeFor: native + token lookup, BLOCK absent (no code), unknown asset null
//   • mergeMap: a user override tweaks one code without dropping the rest
//   • buildWidgetUrl: host from key prefix + the expected query params
//   • fetchSignedUrl: {url} passthrough, {signature} append, failure fallback
//   • buyUrl: supported asset -> ok+url, unsupported -> {ok:false}
//
// No network (fetch is injected).

const MP = require('./moonpay.js');

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (got === want) pass++;
  else { fail++; console.log('FAIL ' + name + '\n  got  ' + got + '\n  want ' + want); }
}
function ok(name, cond) { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } }

// ---- baseFromKey -----------------------------------------------------------
{
  eq('pk_live -> live host', MP.baseFromKey('pk_live_abc'), MP.LIVE_BASE);
  eq('pk_test -> sandbox host', MP.baseFromKey('pk_test_abc'), MP.SANDBOX_BASE);
  eq('blank -> sandbox host', MP.baseFromKey(''), MP.SANDBOX_BASE);
  eq('malformed -> sandbox host', MP.baseFromKey('nonsense'), MP.SANDBOX_BASE);
}

// ---- codeFor ---------------------------------------------------------------
{
  const map = MP.effectiveMap({});
  eq('eth native', MP.codeFor(map, 'ethereum', { native: true }), 'eth');
  eq('btc native', MP.codeFor(map, 'bitcoin', { native: true }), 'btc');
  eq('eth USDC token', MP.codeFor(map, 'ethereum', { symbol: 'USDC' }), 'usdc');
  eq('solana USDC token', MP.codeFor(map, 'solana', { symbol: 'USDC' }), 'usdc_sol');
  eq('lowercase symbol still resolves', MP.codeFor(map, 'ethereum', { symbol: 'usdc' }), 'usdc');
  eq('BLOCK native is null', MP.codeFor(map, 'block', { native: true }), null);
  eq('unknown chain is null', MP.codeFor(map, 'nope', { native: true }), null);
  eq('unknown token is null', MP.codeFor(map, 'ethereum', { symbol: 'WETH' }), null);
  ok('isSupported eth native', MP.isSupported(map, 'ethereum', { native: true }));
  ok('isSupported block false', !MP.isSupported(map, 'block', { native: true }));
}

// ---- mergeMap override -----------------------------------------------------
{
  const map = MP.effectiveMap({ currencyCodes: { base: { native: 'eth' }, ethereum: { tokens: { DAI: 'dai' } } } });
  eq('override base native', MP.codeFor(map, 'base', { native: true }), 'eth');
  eq('override keeps eth native', MP.codeFor(map, 'ethereum', { native: true }), 'eth');
  eq('override adds eth DAI', MP.codeFor(map, 'ethereum', { symbol: 'DAI' }), 'dai');
  eq('override keeps eth USDC', MP.codeFor(map, 'ethereum', { symbol: 'USDC' }), 'usdc');
}

// ---- buildWidgetUrl --------------------------------------------------------
{
  const u = MP.buildWidgetUrl({ apiKey: 'pk_test_x', currencyCode: 'eth', walletAddress: '0xABC', baseCurrencyCode: 'usd', theme: 'dark' });
  ok('sandbox host', u.startsWith(MP.SANDBOX_BASE + '?'));
  ok('has apiKey', u.indexOf('apiKey=pk_test_x') >= 0);
  ok('has currencyCode', u.indexOf('currencyCode=eth') >= 0);
  ok('has walletAddress', u.indexOf('walletAddress=0xABC') >= 0);
  ok('has baseCurrencyCode', u.indexOf('baseCurrencyCode=usd') >= 0);

  const live = MP.buildWidgetUrl({ apiKey: 'pk_live_y', currencyCode: 'btc' });
  ok('live host from key', live.startsWith(MP.LIVE_BASE + '?'));
}

// ---- fetchSignedUrl --------------------------------------------------------
(async () => {
  const unsigned = 'https://buy-sandbox.moonpay.com?apiKey=pk_test_x&currencyCode=eth';

  // Server returns a full signed url.
  const fakeUrl = async () => ({ ok: true, json: async () => ({ url: unsigned + '&signature=SIG', signed: true }) });
  eq('signed url passthrough', await MP.fetchSignedUrl('https://x/sign', unsigned, fakeUrl), unsigned + '&signature=SIG');

  // Server returns only a signature -> we append it (url-encoded).
  const fakeSig = async () => ({ ok: true, json: async () => ({ signature: 'a/b+c=' }) });
  eq('signature appended+encoded', await MP.fetchSignedUrl('https://x/sign', unsigned, fakeSig),
     unsigned + '&signature=' + encodeURIComponent('a/b+c='));

  // No signing endpoint -> unsigned (sandbox path).
  eq('no endpoint -> unsigned', await MP.fetchSignedUrl('', unsigned, fakeUrl), unsigned);

  // Non-ok response -> fall back to unsigned.
  const fakeFail = async () => ({ ok: false, json: async () => ({}) });
  eq('non-ok -> unsigned', await MP.fetchSignedUrl('https://x/sign', unsigned, fakeFail), unsigned);

  // Thrown fetch -> fall back to unsigned.
  const fakeThrow = async () => { throw new Error('network'); };
  eq('throw -> unsigned', await MP.fetchSignedUrl('https://x/sign', unsigned, fakeThrow), unsigned);

  // ---- buyUrl (uses default config; Store absent -> defaults) --------------
  const supported = await MP.buyUrl({ chain: 'ethereum', native: true, walletAddress: '0xABC', fetchFn: async () => ({ ok: false }) });
  ok('buyUrl supported ok', supported.ok === true && !!supported.url && supported.code === 'eth');
  ok('buyUrl supported has walletAddress', supported.url.indexOf('walletAddress=0xABC') >= 0);

  const unsupported = await MP.buyUrl({ chain: 'block', native: true, walletAddress: 'block1xyz' });
  ok('buyUrl BLOCK unsupported', unsupported.ok === false && unsupported.reason === 'unsupported');

  console.log(`moonpay.test.js: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
