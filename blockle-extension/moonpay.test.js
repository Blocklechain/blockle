// moonpay.test.js — unit tests for the MoonPay fiat on-ramp module.
//
//   node moonpay.test.js
//
// Covers:
//   • baseFromKey: pk_live_ -> production host, everything else -> sandbox
//   • codeFor: native + token lookup, BLOCK absent (no code), unknown asset null
//   • mergeMap: a user override tweaks one code without dropping the rest
//   • buildWidgetUrl: host from key prefix + the expected query params
//   • sellBaseFromKey: pk_live_ -> sell host, everything else -> sell sandbox
//   • buildSellUrl: sell host + baseCurrencyCode(crypto)/quoteCurrencyCode(fiat)
//   • fetchSignedUrl: {url} passthrough, {signature} append, failure fallback
//   • buyUrl / sellUrl: supported asset -> ok+url, unsupported -> {ok:false}
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

// ---- sellBaseFromKey -------------------------------------------------------
{
  eq('pk_live -> sell live host', MP.sellBaseFromKey('pk_live_abc'), MP.SELL_LIVE_BASE);
  eq('pk_test -> sell sandbox host', MP.sellBaseFromKey('pk_test_abc'), MP.SELL_SANDBOX_BASE);
  eq('blank -> sell sandbox host', MP.sellBaseFromKey(''), MP.SELL_SANDBOX_BASE);
  eq('malformed -> sell sandbox host', MP.sellBaseFromKey('nonsense'), MP.SELL_SANDBOX_BASE);
}

// ---- buildSellUrl ----------------------------------------------------------
{
  const u = MP.buildSellUrl({ apiKey: 'pk_test_x', baseCurrencyCode: 'eth', quoteCurrencyCode: 'usd', walletAddress: '0xABC', theme: 'dark' });
  ok('sell sandbox host', u.startsWith(MP.SELL_SANDBOX_BASE + '?'));
  ok('sell has apiKey', u.indexOf('apiKey=pk_test_x') >= 0);
  ok('sell baseCurrencyCode is crypto', u.indexOf('baseCurrencyCode=eth') >= 0);
  ok('sell quoteCurrencyCode is fiat', u.indexOf('quoteCurrencyCode=usd') >= 0);
  ok('sell has walletAddress', u.indexOf('walletAddress=0xABC') >= 0);
  // No buy-style currencyCode param on the sell widget.
  ok('sell has no currencyCode param', u.indexOf('currencyCode=') < 0);

  const live = MP.buildSellUrl({ apiKey: 'pk_live_y', baseCurrencyCode: 'btc' });
  ok('sell live host from key', live.startsWith(MP.SELL_LIVE_BASE + '?'));
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

  // ---- sellUrl (uses default config; Store absent -> defaults) ------------
  const sellOk = await MP.sellUrl({ chain: 'ethereum', native: true, walletAddress: '0xABC', fetchFn: async () => ({ ok: false }) });
  ok('sellUrl supported ok', sellOk.ok === true && !!sellOk.url && sellOk.code === 'eth');
  ok('sellUrl hits sell host', sellOk.url.indexOf(MP.SELL_SANDBOX_BASE) === 0);
  ok('sellUrl crypto in baseCurrencyCode', sellOk.url.indexOf('baseCurrencyCode=eth') >= 0);
  ok('sellUrl fiat in quoteCurrencyCode', sellOk.url.indexOf('quoteCurrencyCode=usd') >= 0);
  ok('sellUrl has walletAddress', sellOk.url.indexOf('walletAddress=0xABC') >= 0);

  // Signing fallback: non-ok signer response -> unsigned sell url (unchanged).
  ok('sellUrl sign fallback unsigned', sellOk.url.indexOf('signature=') < 0);

  const sellTok = await MP.sellUrl({ chain: 'solana', symbol: 'USDC', walletAddress: 'SoL1', fetchFn: async () => ({ ok: false }) });
  ok('sellUrl token ok', sellTok.ok === true && sellTok.code === 'usdc_sol');

  const sellBlock = await MP.sellUrl({ chain: 'block', native: true, walletAddress: 'block1xyz' });
  ok('sellUrl BLOCK unsupported', sellBlock.ok === false && sellBlock.reason === 'unsupported');

  const sellUnknown = await MP.sellUrl({ chain: 'ethereum', symbol: 'WETH', walletAddress: '0xABC' });
  ok('sellUrl unknown token unsupported', sellUnknown.ok === false && sellUnknown.reason === 'unsupported');

  // ---- loadRemoteConfig + feature gating (NET-NEW) -------------------------
  {
    // Before a remote load, buy/sell default-on, swap/commerce off.
    // (fresh module state: _remote starts null)
    ok('feature buy default-on', MP.feature('buy') === true);
    ok('feature swap default-off', MP.feature('swap') === false);

    const cfgBody = {
      enabled: true, live: true,
      publishableKey: 'pk_live_REMOTE', commercePublicKey: 'pk_commerce_PUB',
      features: { buy: true, sell: false, swap: true, commerce: true },
    };
    const fakeCfg = async (url) => ({ ok: true, json: async () => cfgBody });
    const r = await MP.loadRemoteConfig(fakeCfg);
    ok('loadRemoteConfig returns config', r && r.publishableKey === 'pk_live_REMOTE');
    ok('remoteConfig cached', MP.remoteConfig().commercePublicKey === 'pk_commerce_PUB');
    ok('commercePublicKey exposed', MP.commercePublicKey() === 'pk_commerce_PUB');
    ok('feature sell now off (from server)', MP.feature('sell') === false);
    ok('feature swap now on (from server)', MP.feature('swap') === true);
    ok('feature commerce now on', MP.feature('commerce') === true);

    // With remote loaded, buyUrl uses the live pk + pins the sign endpoint.
    const buy = await MP.buyUrl({ chain: 'ethereum', native: true, walletAddress: '0xABC', fetchFn: async () => ({ ok: false }) });
    ok('buyUrl uses live pk from /config', buy.ok && buy.url.indexOf('apiKey=pk_live_REMOTE') >= 0);
    ok('buyUrl hits LIVE host under live key', buy.url.indexOf(MP.LIVE_BASE) === 0);

    // Non-ok /config leaves the cache intact.
    const keep = await MP.loadRemoteConfig(async () => ({ ok: false, json: async () => ({}) }));
    ok('non-ok /config keeps cache', keep && keep.publishableKey === 'pk_live_REMOTE');
  }

  // ---- swap proxy (NET-NEW) -------------------------------------------------
  {
    let seen = null;
    const fakeSwap = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ([{ id: 'tx1', status: 'completed' }]) }; };
    const res = await MP.swap('GET', '/v3/transactions', { query: { limit: 5 }, token: 'TKN', fetchFn: fakeSwap });
    ok('swap ok', res.ok && res.status === 200);
    ok('swap posts to swap endpoint', seen.url === MP.SWAP_ENDPOINT);
    ok('swap is a POST proxy', seen.init.method === 'POST');
    ok('swap sends bearer token', seen.init.headers['authorization'] === 'Bearer TKN');
    const sent = JSON.parse(seen.init.body);
    ok('swap forwards method+path', sent.method === 'GET' && sent.path === '/v3/transactions');
    ok('swap forwards query', sent.query.limit === 5);

    const q = await MP.swapQuote({ sellAsset: 'usdc', buyAsset: 'eth', amount: 100, token: 'T', fetchFn: fakeSwap });
    ok('swapQuote ok', q.ok);
    const qs = JSON.parse(seen.init.body);
    ok('swapQuote path', qs.path.indexOf('/v3/currencies/usdc/buy_quote') === 0);

    // A thrown fetch -> graceful ok:false, never throws.
    const thrown = await MP.swap('GET', '/x', { fetchFn: async () => { throw new Error('net'); } });
    ok('swap throw graceful', thrown.ok === false && !!thrown.reason);
  }

  // ---- status (NET-NEW) -----------------------------------------------------
  {
    // Store absent -> empty recorded list; authed poll merges server rows.
    const fakePoll = async () => ({ ok: true, status: 200, json: async () => ([{ id: 's1', status: 'completed', baseCurrencyAmount: 50, createdAt: '2026-01-01T00:00:00Z' }]) });
    const list = await MP.status({ token: 'T', fetchFn: fakePoll });
    ok('status returns server txns', Array.isArray(list) && list.some((t) => t.id === 's1'));
    const s1 = list.find((t) => t.id === 's1');
    ok('status normalizes amountUsd', s1 && s1.amountUsd === 50);
    // No token -> no poll, just recorded (empty here).
    const none = await MP.status({});
    ok('status without session is a list', Array.isArray(none));
  }

  // ---- commerceCheckout (NET-NEW) -------------------------------------------
  {
    let seen = null;
    const fakeCom = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ checkoutId: 'co_1', hostedUrl: 'https://pay.moonpay.com/co_1' }) }; };
    const res = await MP.commerceCheckout({ product: 'copilot', refId: 'u1', amountUsd: 20, token: 'TKN', fetchFn: fakeCom });
    ok('commerce ok', res.ok && res.checkoutId === 'co_1');
    ok('commerce hosted url', res.hostedUrl === 'https://pay.moonpay.com/co_1');
    ok('commerce posts to commerce endpoint', seen.url === MP.COMMERCE_ENDPOINT);
    ok('commerce sends bearer', seen.init.headers['authorization'] === 'Bearer TKN');
    const body = JSON.parse(seen.init.body);
    ok('commerce body action create', body.action === 'create' && body.product === 'copilot');
    // Non-ok -> ok:false, never throws.
    const bad = await MP.commerceCheckout({ product: 'copilot', fetchFn: async () => ({ ok: false, status: 401, json: async () => ({ error: 'auth' }) }) });
    ok('commerce non-ok graceful', bad.ok === false && bad.status === 401);
  }

  // ---- creative helpers (NET-NEW) -------------------------------------------
  {
    const noSign = async () => ({ ok: false });
    // topUpShortfall rounds UP to whole dollars and builds a buy url.
    const top = await MP.topUpShortfall({ chain: 'solana', native: true, walletAddress: 'SoL1', shortfallUsd: 12.3, fetchFn: noSign });
    ok('topUpShortfall ok', top.ok && !!top.url);
    ok('topUpShortfall ceils amount', top.amountUsd === 13);
    ok('topUpShortfall carries amount in url', top.url.indexOf('baseCurrencyAmount=13') >= 0);

    // cashOutGains -> a sell url pre-filled with the gain.
    const cash = await MP.cashOutGains({ chain: 'ethereum', native: true, walletAddress: '0xABC', gainAmount: 40, fetchFn: noSign });
    ok('cashOutGains ok', cash.ok && !!cash.url);
    ok('cashOutGains hits sell host', cash.url.indexOf(MP.SELL_SANDBOX_BASE) === 0 || cash.url.indexOf(MP.SELL_LIVE_BASE) === 0);
    ok('cashOutGains carries amount', cash.url.indexOf('baseCurrencyAmount=40') >= 0);

    // recurringBuyPreset -> url with recurring params + a weekly DCA bot spec.
    const rec = await MP.recurringBuyPreset({ chain: 'solana', symbol: 'USDC', walletAddress: 'SoL1', weeklyUsd: 25, fetchFn: noSign });
    ok('recurringBuyPreset ok', rec.ok && !!rec.url);
    ok('recurringBuyPreset carries recurring flag', rec.url.indexOf('recurringBuyEnabled=true') >= 0);
    ok('recurringBuyPreset weekly freq', rec.url.indexOf('recurringBuyFrequency=weekly') >= 0);
    ok('recurringBuyPreset returns DCA spec', rec.botSpec && rec.botSpec.type === 'dca' && rec.botSpec.cadence === 'weekly' && rec.botSpec.allocationUsd === 25);

    // getBlockWithCard -> 2-step plan: buy USDC then dex-swap to BLOCK.
    const gb = await MP.getBlockWithCard({ chain: 'solana', walletAddress: 'SoL1', usdAmount: 50, fetchFn: noSign });
    ok('getBlockWithCard ok', gb.ok && gb.totalSteps === 2);
    ok('getBlockWithCard step1 buys USDC', gb.step1.kind === 'buy' && gb.step1.symbol === 'USDC' && gb.step1.amountUsd === 50);
    ok('getBlockWithCard step1 code is usdc_sol', gb.step1.code === 'usdc_sol');
    ok('getBlockWithCard step2 swaps to BLOCK', gb.step2.kind === 'dex-swap' && gb.step2.to === 'BLOCK');
  }

  // ---- captureReturn (NET-NEW, Store absent -> still returns a txn) ----------
  {
    const txn = await MP.captureReturn('https://x/return?transactionId=T9&transactionStatus=completed&baseCurrencyAmount=15&baseCurrencyCode=usdc', 'buy');
    ok('captureReturn parses id', txn.id === 'T9');
    ok('captureReturn parses status', txn.status === 'completed');
    ok('captureReturn parses amount', txn.amountUsd === 15);
    ok('captureReturn parses asset', txn.asset === 'usdc');
    ok('captureReturn tags type', txn.type === 'buy');
  }

  console.log(`moonpay.test.js: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
