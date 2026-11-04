// Tests for the signals service's ONLINE-PRESENCE ("buzz") feed (services/signals/
// src/buzz.js) and the engine's buzz rank plumbing. Run: node tests/signals-buzz.test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as Buzz from '../services/signals/src/buzz.js';

const require = createRequire(import.meta.url);
const V = '/opt/blockle/web/wallet/vendor/';
let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('ok   ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); }
}

await test('attentionScore: top search + top pool + heavy buyer traffic saturates near 100; nothing → 0', () => {
  assert.equal(Buzz.attentionScore({}), 0);
  const top = Buzz.attentionScore({ searchRank: 1, searchTotal: 15, poolRank: 1, poolTotal: 20, buyers1h: 500, buyers24h: 5000, boosts: 4, profile: true, watchlistUsers: 500000, sentimentUp: 100 });
  assert.equal(top, 100);
  const lastSearch = Buzz.attentionScore({ searchRank: 15, searchTotal: 15 });
  const firstSearch = Buzz.attentionScore({ searchRank: 1, searchTotal: 15 });
  assert.equal(firstSearch, 30); assert.equal(lastSearch, 2);
  // promo boosts are capped (they are bought, not earned)
  assert.equal(Buzz.attentionScore({ boosts: 100 }), 8);
  assert.equal(Buzz.attentionScore({ boosts: 100, profile: true }), 11);
  // sentiment is ±3 around 50%
  assert.equal(Buzz.attentionScore({ sentimentUp: 0 }), 0);
  assert.equal(Buzz.attentionScore({ sentimentUp: 100 }), 3);
});

await test('velocityScore: accelerating volume + buyer dominance + fresh move scores high; chased or dumping is penalised', () => {
  assert.equal(Buzz.velocityScore({}), 0);
  const hot = Buzz.velocityScore({ vol1h: 50000, vol24h: 200000, chg5m: 5, chg1h: 15, chg6h: 40, chg24h: 100, buys1h: 80, sells1h: 20 });
  assert.equal(hot, 100);
  const steady = Buzz.velocityScore({ vol1h: 10000, vol24h: 240000, chg5m: 0, chg1h: 0, chg6h: 0, chg24h: 0, buys1h: 50, sells1h: 50 });
  assert.equal(steady, 5); // accel exactly 1 → 30*(0.5/3)=5
  const chased = Buzz.velocityScore({ chg1h: 180, chg5m: 2 });
  const brisk = Buzz.velocityScore({ chg1h: 15, chg5m: 2 });
  assert.ok(chased < brisk, 'a +180% hour is late, not early: ' + chased + ' vs ' + brisk);
  const dumping = Buzz.velocityScore({ chg1h: -20, chg5m: -3, buys1h: 10, sells1h: 50 });
  assert.equal(dumping, 0);
});

await test('quickScore: needs BOTH attention and velocity, scaled by exit depth, zero when unsafe', () => {
  assert.equal(Buzz.quickScore({ attention: 100, velocity: 0, liquidityUsd: 1e6, safe: true }), 0);
  assert.equal(Buzz.quickScore({ attention: 0, velocity: 100, liquidityUsd: 1e6, safe: true }), 0);
  assert.equal(Buzz.quickScore({ attention: 100, velocity: 100, liquidityUsd: 1e6, safe: true }), 100);
  assert.equal(Buzz.quickScore({ attention: 100, velocity: 100, liquidityUsd: 1e6, safe: false }), 0);
  assert.equal(Buzz.quickScore({ attention: 64, velocity: 36, liquidityUsd: 1e6, safe: true }), 48); // sqrt(64·36)=48
  const thin = Buzz.quickScore({ attention: 64, velocity: 36, liquidityUsd: 1000, safe: true });
  assert.equal(thin, 5); // feasibility 0.1 under $5k
  assert.equal(Buzz.feasibility(null), 0.5);
  assert.equal(Buzz.feasibility(1e6), 1);
});

await test('mergeSources: same chain:token across sources merges; best rank + max traffic win; EVM keys case-insensitive', () => {
  const c = Buzz.mergeSources({
    coingeckoTrending: [{ chain: 'ethereum', token: '0xABC', symbol: 'abc', searchRank: 3, searchTotal: 15, watchlistUsers: 1000 }],
    geckoTerminalTrending: [{ chain: 'ethereum', token: '0xabc', name: 'Abc Coin', poolRank: 2, poolTotal: 20, buyers1h: 40, vol1h: 100 },
      { chain: 'solana', token: 'Mint1', symbol: 'M1', poolRank: 1, poolTotal: 20, buyers1h: 10 }],
    dexscreenerBoosts: [{ chain: 'ethereum', token: '0xabc', boosts: 2 }, { chain: 'ethereum', token: '0xabc', boosts: 5 }],
    dexscreenerProfiles: [{ chain: 'solana', token: 'Mint1', profile: true }],
  });
  assert.equal(c.length, 2);
  const abc = c.find((x) => x.chain === 'ethereum');
  assert.equal(abc.symbol, 'ABC'); assert.equal(abc.name, 'Abc Coin');
  assert.deepEqual(abc.sources, ['coingeckoTrending', 'geckoTerminalTrending', 'dexscreenerBoosts']);
  assert.equal(abc.signals.searchRank, 3); assert.equal(abc.signals.poolRank, 2);
  assert.equal(abc.signals.boosts, 5); assert.equal(abc.signals.buyers1h, 40); assert.equal(abc.signals.watchlistUsers, 1000);
  const m1 = c.find((x) => x.chain === 'solana');
  assert.equal(m1.signals.profile, true); assert.equal(m1.signals.poolRank, 1);
  // Solana mints are case-sensitive: different case = different token
  assert.equal(Buzz.mergeSources({ a: [{ chain: 'solana', token: 'AbC' }, { chain: 'solana', token: 'abc' }] }).length, 2);
});

await test('fetchGeckoTerminalTrending: parses pools, skips major-base pools, maps buyers/volume/price windows', async () => {
  const payload = {
    data: [
      { id: 'eth_p1', attributes: { address: '0xp1', name: 'GTA6 / ETH', pool_created_at: new Date(Date.now() - 7200e3).toISOString(), reserve_in_usd: '250000', fdv_usd: '3000000',
        price_change_percentage: { m5: '5.1', h1: '-18.6', h6: '23.8', h24: '113675' },
        transactions: { h1: { buys: 77, sells: 29, buyers: 56, sellers: 29 }, h24: { buys: 2640, sells: 894, buyers: 1093, sellers: 464 } },
        volume_usd: { h1: '136451', h24: '3702631' } },
        relationships: { base_token: { data: { id: 'eth_0xa258', type: 'token' } } } },
      { id: 'eth_p2', attributes: { address: '0xp2', name: 'WETH / USDC', transactions: {}, volume_usd: {}, price_change_percentage: {} },
        relationships: { base_token: { data: { id: 'eth_0xc02a', type: 'token' } } } },
    ],
    included: [
      { id: 'eth_0xa258', type: 'token', attributes: { address: '0xa258', symbol: 'GTA6', name: 'GTA VI' } },
      { id: 'eth_0xc02a', type: 'token', attributes: { address: '0xc02a', symbol: 'WETH', name: 'Wrapped Ether' } },
    ],
  };
  const urls = [];
  const rows = await Buzz.fetchGeckoTerminalTrending(async (u) => { urls.push(u); return payload; }, 'eth');
  assert.match(urls[0], /networks\/eth\/trending_pools/);
  assert.equal(rows.length, 1, 'WETH-base pool skipped');
  const r = rows[0];
  assert.equal(r.chain, 'ethereum'); assert.equal(r.token, '0xa258'); assert.equal(r.symbol, 'GTA6');
  assert.equal(r.poolRank, 1); assert.equal(r.poolTotal, 2);
  assert.equal(r.buyers1h, 56); assert.equal(r.buyers24h, 1093); assert.equal(r.buys1h, 77); assert.equal(r.sells1h, 29);
  assert.equal(r.vol1h, 136451); assert.equal(r.vol24h, 3702631);
  assert.equal(r.chg5m, 5.1); assert.equal(r.chg1h, -18.6); assert.equal(r.liquidityUsd, 250000);
  assert.ok(r.poolAgeSec >= 7199 && r.poolAgeSec <= 7205);
  assert.deepEqual(await Buzz.fetchGeckoTerminalTrending(async () => null, 'eth'), []);
  assert.deepEqual(await Buzz.fetchGeckoTerminalTrending(async () => payload, 'polygon'), [], 'unsupported network → []');
});

await test('fetchCoinGeckoTrending: natives map to wrapped tokens; others resolve platforms via the cached lookup', async () => {
  const trending = { coins: [
    { item: { id: 'solana', symbol: 'SOL', name: 'Solana', market_cap_rank: 6, data: { price_change_percentage_24h: { usd: 3.2 } } } },
    { item: { id: 'pepe', symbol: 'PEPE', name: 'Pepe', market_cap_rank: 30, data: { price_change_percentage_24h: { usd: -1 } } } },
    { item: { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', market_cap_rank: 1, data: {} } },
  ] };
  const resolved = [];
  const rows = await Buzz.fetchCoinGeckoTrending(async () => trending, async (id) => {
    resolved.push(id);
    if (id === 'pepe') return { platforms: { ethereum: '0x6982', 'binance-smart-chain': '0x25d8', avalanche: '0xa659' }, watchlistUsers: 396516, sentimentUp: 92.9, chg1h: -0.5 };
    return { platforms: {} }; // bitcoin: no contract on a supported chain
  });
  assert.deepEqual(resolved, ['pepe', 'bitcoin'], 'natives never hit the lookup');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { symbol: 'SOL', name: 'Solana', searchRank: 1, searchTotal: 3, chg24h: 3.2, marketCapRank: 6, chain: 'solana', token: 'So11111111111111111111111111111111111111112' });
  assert.equal(rows[1].chain, 'ethereum'); assert.equal(rows[1].token, '0x6982'); assert.equal(rows[1].searchRank, 2); assert.equal(rows[1].watchlistUsers, 396516); assert.equal(rows[1].chg1h, -0.5);
  assert.equal(rows[2].chain, 'bsc'); assert.equal(rows[2].token, '0x25d8');
  const parsed = Buzz.parseCoinGeckoCoin({ platforms: { solana: 'M' }, watchlist_portfolio_users: 12, sentiment_votes_up_percentage: 80, market_data: { price_change_percentage_1h_in_currency: { usd: 1.5 } } });
  assert.deepEqual(parsed, { platforms: { solana: 'M' }, watchlistUsers: 12, sentimentUp: 80, chg1h: 1.5 });
  assert.equal(Buzz.parseCoinGeckoCoin(null), null);
});

await test('scoreCandidate: signals beat report metrics, report fills the gaps, unsafe → quick 0 with basis string', () => {
  const c = { signals: { searchRank: 1, searchTotal: 15, poolRank: 1, poolTotal: 20, buyers1h: 500, buyers24h: 5000, vol1h: 50000, vol24h: 200000, chg5m: 5, chg1h: 15, chg6h: 40, chg24h: 100, buys1h: 80, sells1h: 20 } };
  const ok = Buzz.scoreCandidate(c, { safe: true, metrics: { liquidityUsd: 1e6 } });
  assert.equal(ok.attention, 85); assert.equal(ok.velocity, 100); assert.equal(ok.quick, 92); assert.equal(ok.safe, true); // sqrt(85·100)=92.2
  assert.equal(ok.basis, Buzz.BASIS);
  const bad = Buzz.scoreCandidate(c, { safe: false, flags: ['honeypot'], metrics: { liquidityUsd: 1e6 } });
  assert.equal(bad.quick, 0); assert.equal(bad.attention, 85);
  // no report at all: unknown safety (null) still scores, feasibility from signals' own liquidity
  const none = Buzz.scoreCandidate({ signals: { poolRank: 1, poolTotal: 20, buyers1h: 100, vol1h: 1000, vol24h: 4000, chg1h: 5, liquidityUsd: 1e6 } }, null);
  assert.equal(none.safe, null); assert.ok(none.quick > 0);
  // report metrics fill velocity when the merged signals lack them
  const fromReport = Buzz.scoreCandidate({ signals: { poolRank: 1, poolTotal: 20 } }, { safe: true, metrics: { liquidityUsd: 5e5, volume1hUsd: 10000, volume24hUsd: 40000, priceChange1hPct: 10, priceChange24hPct: 30 } });
  assert.ok(fromReport.velocity > 0 && fromReport.quick > 0);
});

await test('engine: signal bot config keeps rank only when buzz (fixtures unchanged); runner ranks by buzz.quick and skips no-buzz rows', async () => {
  const Bots = require(V + 'agent/bots.js');
  const plain = Bots.validateConfig('signal', { source: 'discovery', maxConcurrent: 2 });
  assert.equal('rank' in plain, false);
  assert.equal(Bots.validateConfig('signal', { rank: 'BUZZ' }).rank, 'buzz');
  assert.equal('rank' in Bots.validateConfig('signal', { rank: 'nope' }), false);
  const bot = Bots.create({ type: 'signal', lane: 'solana', riskMode: 'high', config: { rank: 'buzz', maxConcurrent: 1 } });
  assert.equal(bot.config.rank, 'buzz');
  assert.equal(JSON.parse(JSON.stringify(bot.toJSON ? bot.toJSON() : bot)).config.rank, 'buzz');

  // The runner's discovery call carries rank:'buzz' and orders by buzz.quick.
  const BotRunner = require(V + 'agent/bot-runner.js');
  const seen = [];
  const discovery = { async scan(o) { seen.push(o); return [
    { pair: 'LOW/USDC', symbol: 'LOW', chain: 'solana', approved: true, score: 0.9, buzz: { attention: 20, velocity: 20, quick: 15 }, liquidityUsd: 1e6, ageSec: 1e6 },
    { pair: 'HOT/USDC', symbol: 'HOT', chain: 'solana', approved: true, score: 0.6, buzz: { attention: 80, velocity: 70, quick: 70 }, liquidityUsd: 1e6, ageSec: 1e6 },
    { pair: 'NOBUZZ/USDC', symbol: 'NOBUZZ', chain: 'solana', approved: true, score: 0.95, liquidityUsd: 1e6, ageSec: 1e6 },
  ]; } };
  const audit = [];
  const feed = [];
  const Ctor = BotRunner.BotRunner || BotRunner.create || BotRunner;
  let runner;
  try {
    runner = typeof Ctor === 'function' && Ctor.prototype && Ctor.prototype._tickSignal ? Object.create(Ctor.prototype) : null;
  } catch (_) { runner = null; }
  assert.ok(runner, 'BotRunner prototype with _tickSignal');
  runner.Bots = Bots; runner.discovery = discovery;
  runner._audit = async (e) => { audit.push(e); };
  runner._feed = (b, e) => { feed.push(e); };
  runner._tickDealBot = async () => ({ events: [] });
  const b2 = Bots.create({ type: 'signal', lane: 'solana', riskMode: 'high', config: { rank: 'buzz', maxConcurrent: 1, minScore: 0.5, onSignal: { type: 'dca', config: {} } } });
  await runner._tickSignal(b2, Date.now(), {});
  assert.equal(seen[0].rank, 'buzz');
  assert.equal(audit.length, 1); assert.equal(audit[0].pair, 'HOT/USDC'); assert.deepEqual(audit[0].buzz, { attention: 80, velocity: 70, quick: 70 });
  assert.match(feed[0].text, /🔥 Buzz HOT\/USDC · attention 80/);
  // default rank: best safety score first, no rank param sent
  const b3 = Bots.create({ type: 'signal', lane: 'solana', riskMode: 'high', config: { maxConcurrent: 1, minScore: 0.5, onSignal: { type: 'dca', config: {} } } });
  audit.length = 0; seen.length = 0;
  await runner._tickSignal(b3, Date.now(), {});
  assert.equal(seen[0].rank, undefined);
  assert.equal(audit[0].pair, 'NOBUZZ/USDC'); assert.equal(audit[0].buzz, undefined);
});

await test('Full Auto: buzz is a default child (legacy 5-algo lists migrate), spec is a rank=buzz signal bot, priors sum to 1', () => {
  const Bots = require(V + 'agent/bots.js');
  assert.deepEqual(Bots.AUTO_ALGOS, ['momentum', 'buzz', 'sniper', 'grid', 'dip', 'scanner']);
  assert.deepEqual(Bots.validateConfig('auto', {}).algos, Bots.AUTO_ALGOS);
  assert.deepEqual(Bots.validateConfig('auto', { algos: ['momentum', 'sniper', 'grid', 'dip', 'scanner'] }).algos, Bots.AUTO_ALGOS);
  assert.deepEqual(Bots.validateConfig('auto', { algos: ['grid', 'dip'] }).algos, ['grid', 'dip']);
  const bot = Bots.create({ type: 'auto', lane: 'solana', riskMode: 'high', config: {} });
  assert.match(bot.describe(), /Momentum, Buzz, Sniper/);
  const BotRunner = require(V + 'agent/bot-runner.js');
  const proto = BotRunner.BotRunner.prototype;
  const r = Object.create(proto); r.Bots = Bots;
  const specs = r._autoAlgoSpecs(bot);
  assert.equal(specs.buzz.type, 'signal'); assert.equal(specs.buzz.config.rank, 'buzz'); assert.equal(specs.buzz.riskMode, 'high');
  assert.equal(specs.buzz.config.onSignal.type, 'smarttrade');
  const sniperLane = Bots.create({ type: 'auto', lane: 'solana', riskMode: 'sniper', config: {} });
  assert.equal(r._autoAlgoSpecs(sniperLane).buzz.riskMode, 'high', 'buzz never runs with the sniper age gate off');
  const child = { config: JSON.parse(JSON.stringify(specs.buzz.config)) };
  r._autoSizeChild(child, 'buzz', 300);
  assert.equal(child.config.onSignal.config.amountUsd, 100);
  for (const reg of ['trend-up', 'trend-down', 'ranging', 'quiet', 'warming', 'other']) {
    const p = r._autoPriors(reg);
    assert.ok('buzz' in p, reg + ' has buzz');
    assert.ok(Math.abs(Object.values(p).reduce((a, b) => a + b, 0) - 1) < 1e-9, reg + ' priors sum to 1');
  }
  assert.ok(r._autoPriors('trend-up').momentum > r._autoPriors('trend-up').buzz);
  assert.ok(r._autoPriors('quiet').buzz > r._autoPriors('quiet').sniper);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
