// custom-networks.test.js — unit tests for user-added custom EVM networks.
//
//   node custom-networks.test.js
//
// Covers:
//   • CustomNetworks: validate (good/bad), slugify, chainId coercion,
//     upsert/remove roundtrip, normalizeList, probeChainId (injected fetch)
//   • ChainRegistry: builds a NEW custom net via the same generic EVM adapter
//     and derives the SAME secp256k1 address as the built-in EVM chains
//   • dedupe-by-chainId: a custom net with a built-in's chainId OVERRIDES its
//     RPC instead of duplicating (no new adapter, built-in id kept)
//
// No network (probe uses an injected fake fetch).

const CN = require('./chains/custom-networks.js');
const REG = require('./chains/registry.js');
const HD = require('./hd.js');
const C = require('./crypto-core.js');

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (got === want) pass++;
  else { fail++; console.log('FAIL ' + name + '\n  got  ' + got + '\n  want ' + want); }
}
function ok(name, cond) { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } }

// ---- validate / normalize --------------------------------------------------
{
  const good = CN.validate({ name: 'My Chain', chainId: '10200', rpcUrl: 'https://rpc.example.org', nativeSymbol: 'xDAI' });
  ok('validate good ok', good.ok);
  eq('validate good id slug', good.value.id, 'my-chain');
  eq('validate good chainId int', good.value.chainId, 10200);
  eq('validate default decimals 18', good.value.decimals, 18);

  const hex = CN.validate({ name: 'Hex', chainId: '0x27d8', rpcUrl: 'https://r.example', nativeSymbol: 'E' });
  eq('validate 0x chainId', hex.value.chainId, 0x27d8);

  const bad = CN.validate({ name: '', chainId: '-3', rpcUrl: 'ftp://nope', nativeSymbol: '' });
  ok('validate bad not ok', !bad.ok);
  ok('validate bad name err', !!bad.errors.name);
  ok('validate bad chainId err', !!bad.errors.chainId);
  ok('validate bad rpc err', !!bad.errors.rpcUrl);
  ok('validate bad symbol err', !!bad.errors.nativeSymbol);

  ok('validate rejects chainId 0', !CN.validate({ name: 'Z', chainId: '0', rpcUrl: 'https://r.x', nativeSymbol: 'Z' }).ok);
  ok('validate rejects non-http rpc', !CN.validate({ name: 'Z', chainId: '5', rpcUrl: 'javascript:alert(1)', nativeSymbol: 'Z' }).ok);
  ok('validate decimals out of range', !CN.validate({ name: 'Z', chainId: '5', rpcUrl: 'https://r.x', nativeSymbol: 'Z', decimals: 99 }).ok);
  ok('validate optional explorer bad', !CN.validate({ name: 'Z', chainId: '5', rpcUrl: 'https://r.x', nativeSymbol: 'Z', explorerUrl: 'not-a-url' }).ok);
  ok('validate optional indexer good', CN.validate({ name: 'Z', chainId: '5', rpcUrl: 'https://r.x', nativeSymbol: 'Z', tokenIndexerUrl: 'https://idx.x/v2/KEY' }).ok);
}

// ---- upsert / remove / normalizeList (store roundtrip) ---------------------
{
  let list = [];
  list = CN.upsert(list, { name: 'Gnosis', chainId: '100', rpcUrl: 'https://rpc.gnosis', nativeSymbol: 'xDAI' });
  eq('upsert adds one', list.length, 1);
  eq('upsert stored id', list[0].id, 'gnosis');

  // edit same id -> replaces, not appends
  list = CN.upsert(list, { name: 'Gnosis', chainId: '100', rpcUrl: 'https://rpc2.gnosis', nativeSymbol: 'xDAI' });
  eq('upsert edit no dup', list.length, 1);
  eq('upsert edit new rpc', list[0].rpcUrl, 'https://rpc2.gnosis');

  // rename via originalId -> still one entry, new slug
  list = CN.upsert(list, { name: 'Gnosis Chain', chainId: '100', rpcUrl: 'https://rpc2.gnosis', nativeSymbol: 'xDAI' }, 'gnosis');
  eq('upsert rename no dup', list.length, 1);
  eq('upsert rename new slug', list[0].id, 'gnosis-chain');

  // add a second
  list = CN.upsert(list, { name: 'Celo', chainId: '42220', rpcUrl: 'https://rpc.celo', nativeSymbol: 'CELO' });
  eq('upsert second', list.length, 2);

  // invalid upsert throws with errors
  let threw = false;
  try { CN.upsert(list, { name: '', chainId: 'x', rpcUrl: 'nope', nativeSymbol: '' }); }
  catch (e) { threw = !!e.errors; }
  ok('upsert invalid throws with errors', threw);

  // remove
  list = CN.remove(list, 'gnosis-chain');
  eq('remove drops one', list.length, 1);
  eq('remove kept celo', list[0].id, 'celo');

  // normalizeList drops bad rows
  const normalized = CN.normalizeList([
    { name: 'OK', chainId: 7, rpcUrl: 'https://ok.x', nativeSymbol: 'OK' },
    { name: '', chainId: 'bad', rpcUrl: 'x', nativeSymbol: '' },
    null,
  ]);
  eq('normalizeList keeps valid only', normalized.length, 1);
  eq('normalizeList value id', normalized[0].id, 'ok');
}

// ---- probeChainId (injected fetch; never throws) ---------------------------
(async () => {
  const fakeFetch = (url, opts) => {
    const body = JSON.parse(opts.body);
    ok('probe calls eth_chainId', body.method === 'eth_chainId');
    return Promise.resolve({ json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: '0x64' }) });
  };
  const cid = await CN.probeChainId('https://rpc.gnosis', fakeFetch);
  eq('probe decodes 0x64 -> 100', cid, 100);

  const errFetch = () => Promise.reject(new Error('network down'));
  const none = await CN.probeChainId('https://rpc.x', errFetch);
  eq('probe swallows errors -> null', none, null);

  const badUrl = await CN.probeChainId('not-a-url', fakeFetch);
  eq('probe bad url -> null', badUrl, null);

  // ---- registry: NEW custom net via the same adapter, same address ---------
  const seed = HD.mnemonicToSeed(ABANDON, '');
  const reg = REG.createRegistry({
    custom: [
      { id: 'gnosis', name: 'Gnosis', chainId: 100, rpcUrl: 'https://rpc.gnosis', nativeSymbol: 'xDAI', decimals: 18 },
    ],
  });
  reg.unlock({ seed });
  ok('registry enables custom net', reg.enabled().includes('gnosis'));
  ok('registry has custom adapter', reg.has('gnosis'));
  eq('registry custom chainId', reg.get('gnosis').chainId, 100);
  eq('registry custom native symbol', reg.get('gnosis').native.symbol, 'xDAI');

  const eth = await reg.get('ethereum').deriveAccount({ seed });
  const gno = await reg.get('gnosis').deriveAccount({ seed });
  eq('custom net same secp address as ETH', gno.address.toLowerCase(), eth.address.toLowerCase());
  eq('custom net eth addr vector', gno.address, '0x9858EfFD232B4033E47d90003D41EC34EcaEda94');

  const metas = reg.customNetworks();
  eq('registry customNetworks count', metas.length, 1);
  eq('registry customNetworks name', metas[0].name, 'Gnosis');

  // ---- dedupe by chainId: override a built-in, no duplicate ----------------
  const before = REG.createRegistry({}).enabled().length;
  const reg2 = REG.createRegistry({
    custom: [
      // chainId 1 == built-in ethereum: must OVERRIDE its RPC, NOT add a chain.
      { id: 'my-eth', name: 'My ETH', chainId: 1, rpcUrl: 'https://my-eth-rpc.example', nativeSymbol: 'ETH' },
    ],
  });
  const after = reg2.enabled().length;
  eq('dedupe adds no new chain', after, before);
  ok('dedupe did not create my-eth adapter', !reg2.has('my-eth'));
  ok('dedupe kept ethereum adapter', reg2.has('ethereum'));
  eq('dedupe customNetworks empty (override only)', reg2.customNetworks().length, 0);
  // the override takes effect: the ethereum adapter now uses the custom RPC.
  reg2.unlock({ seed });
  // (no network call — we just assert the adapter still derives the same address)
  const e2 = await reg2.get('ethereum').deriveAccount({ seed });
  eq('overridden ethereum same address', e2.address, '0x9858EfFD232B4033E47d90003D41EC34EcaEda94');

  // ---- id collision with a built-in slug but a NEW chainId -> unique id -----
  const reg3 = REG.createRegistry({
    custom: [
      { id: 'ethereum', name: 'Fake ETH', chainId: 999999, rpcUrl: 'https://fake.example', nativeSymbol: 'FETH' },
    ],
  });
  ok('collision keeps real ethereum', reg3.has('ethereum') && reg3.get('ethereum').chainId === 1);
  ok('collision creates suffixed id', reg3.has('ethereum-999999'));
  eq('collision suffixed chainId', reg3.get('ethereum-999999').chainId, 999999);

  done();
})();

function done() {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
