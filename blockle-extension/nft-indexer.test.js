// nft-indexer.test.js — WALLET NFT LIVE INDEXER (nft-indexer.js).
// Run: node --test nft-indexer.test.js
//
// Verifies the live indexer maps a MOCK Alchemy NFT v3 response (EVM) and a MOCK
// DAS getAssetsByOwner response (Helius / Solana) to the RAW item shape nft.js
// expects, that a MISSING key/endpoint (or an HTTP/parse error) returns no result
// -> `unavailable` (NEVER a fabricated empty inventory), and that the raw items
// feed nft.js end-to-end into a correctly-normalized inventory.

const { test } = require('node:test');
const assert = require('node:assert');

const NI = require('./nft-indexer.js');
const NFT = require('./nft.js');

// a fetch stub: route by URL/body, return { ok, json() }.
function fetchStub(routes) {
  return async function (url, init) {
    for (const r of routes) {
      if (r.match(url, init)) return { ok: r.ok !== false, status: r.status || 200, async json() { return r.body; } };
    }
    return { ok: false, status: 404, async json() { return {}; } };
  };
}

// ---- mock Alchemy NFT API v3 getNFTsForOwner response ----------------------
const ALCHEMY_BODY = {
  ownedNfts: [
    {
      contract: { address: '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D', tokenType: 'ERC721' },
      tokenId: '7777',
      balance: '1',
      name: 'Bored Ape #7777',
      image: { cachedUrl: 'https://cdn.alchemy.com/bayc/7777.png', originalUrl: 'ipfs://Qmbayc/7777.png' },
      collection: { name: 'Bored Ape Yacht Club' },
      tokenUri: 'ipfs://Qmbayc/7777.json',
      raw: { metadata: { name: 'Bored Ape #7777', image: 'ipfs://Qmbayc/7777.png', attributes: [{ trait_type: 'Fur', value: 'Gold' }] } },
    },
    {
      contract: { address: '0x495f947276749Ce646f68AC8c248420045cb7b5e', tokenType: 'ERC1155' },
      tokenId: '42',
      balance: '3',
      name: 'Edition 42',
      image: { cachedUrl: 'https://cdn.alchemy.com/ed/42.png' },
      collection: { name: 'OpenSea Shared' },
      raw: { metadata: { attributes: [] } },
    },
    {
      // metadata-less item — the indexer must NOT fabricate a name/image
      contract: { address: '0x0000000000000000000000000000000000000abc', tokenType: 'ERC721' },
      tokenId: '1',
      balance: '1',
      image: {},
      raw: { metadata: {} },
    },
  ],
};

// ---- mock DAS (Helius) getAssetsByOwner response ---------------------------
const DAS_BODY = {
  jsonrpc: '2.0', id: 'nfts',
  result: {
    total: 2, limit: 1000, page: 1,
    items: [
      {
        interface: 'V1_NFT',
        id: 'MintAddrSolana1111111111111111111111111111',
        content: {
          json_uri: 'https://arweave.net/abc.json',
          metadata: { name: 'DeGod #1234', symbol: 'DGOD', attributes: [{ trait_type: 'Background', value: 'Blue' }] },
          links: { image: 'https://arweave.net/degod-1234.png' },
        },
        grouping: [{ group_key: 'collection', group_value: 'DeGodsColl1111111111111111111111111111111' }],
      },
      {
        // a fungible token the DAS endpoint may also return — must be filtered out
        interface: 'FungibleToken',
        id: 'UsdcMint1111111111111111111111111111111111',
        content: { metadata: { name: 'USD Coin', symbol: 'USDC' }, links: {} },
      },
    ],
  },
};

// ===========================================================================
// 1. EVM — Alchemy mapping
// ===========================================================================
test('evm: maps the Alchemy getNFTsForOwner response to raw items (no fabrication)', async () => {
  const idx = NI.createIndexer({ alchemy: { apiKey: 'test-key' }, fetchImpl: fetchStub([
    { match: (u) => /eth-mainnet\.g\.alchemy\.com\/nft\/v3\/.*\/getNFTsForOwner/.test(u) && /owner=0xOWNER/.test(u), body: ALCHEMY_BODY },
  ]) });
  const raw = await idx.getNFTsForOwner('ethereum', '0xOWNER');
  assert.ok(Array.isArray(raw), 'returns an array when the indexer answered');
  assert.equal(raw.length, 3);

  const bayc = raw[0];
  assert.equal(bayc.chain, 'ethereum');
  assert.equal(bayc.contract, '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D');
  assert.equal(bayc.standard, 'erc721');
  assert.equal(bayc.tokenId, '7777');
  assert.equal(bayc.balance, '1');
  assert.equal(bayc.name, 'Bored Ape #7777');
  assert.equal(bayc.collection, 'Bored Ape Yacht Club');
  assert.equal(bayc.image, 'https://cdn.alchemy.com/bayc/7777.png');
  assert.equal(bayc.metadataUri, 'ipfs://Qmbayc/7777.json');
  assert.deepEqual(bayc.attributes, [{ trait_type: 'Fur', value: 'Gold' }]);
  assert.equal(bayc.metadataOk, true);

  const ed = raw[1];
  assert.equal(ed.standard, 'erc1155');
  assert.equal(ed.balance, '3', 'keeps the 1155 balance');

  // metadata-less item: flagged, never invented
  const bare = raw[2];
  assert.equal(bare.metadataOk, false, 'no name/image => metadataOk:false');
  assert.equal(bare.name, undefined, 'never fabricates a name');
  assert.equal(bare.image, undefined, 'never fabricates an image');
});

test('evm: the raw items feed nft.js into a normalized, grouped inventory', async () => {
  const idx = NI.createIndexer({ alchemy: { apiKey: 'test-key' }, fetchImpl: fetchStub([
    { match: () => true, body: ALCHEMY_BODY },
  ]) });
  const res = await NFT.nfts([{ chain: 'ethereum', address: '0xOWNER' }], { indexer: idx, config: {} });
  assert.deepEqual(res.unavailable, [], 'the account resolved (not unavailable)');
  assert.equal(res.items.length, 3);
  // ipfs metadataUri normalized by nft.js (indexer stays raw)
  const bayc = res.items.find((i) => i.tokenId === '7777');
  assert.equal(bayc.metadataUri, 'https://ipfs.io/ipfs/Qmbayc/7777.json');
  const bare = res.items.find((i) => i.metadataOk === false);
  assert.equal(bare.metadataNote, 'metadata-unavailable');
});

// ===========================================================================
// 2. Solana — DAS mapping (non-fungibles only)
// ===========================================================================
test('solana: maps the DAS getAssetsByOwner response and filters fungibles', async () => {
  let sawBody = null;
  const idx = NI.createIndexer({ helius: { apiKey: 'helius-key' }, fetchImpl: async (url, init) => {
    sawBody = JSON.parse(init.body);
    return { ok: true, async json() { return DAS_BODY; } };
  } });
  const raw = await idx.getNFTsForOwner('solana', 'OwnerSolPubkey111');
  assert.equal(sawBody.method, 'getAssetsByOwner', 'calls the DAS method');
  assert.equal(sawBody.params.ownerAddress, 'OwnerSolPubkey111');
  assert.ok(Array.isArray(raw));
  assert.equal(raw.length, 1, 'the fungible token is filtered out');
  const degod = raw[0];
  assert.equal(degod.chain, 'solana');
  assert.equal(degod.standard, 'metaplex');
  assert.equal(degod.contract, 'MintAddrSolana1111111111111111111111111111');
  assert.equal(degod.name, 'DeGod #1234');
  assert.equal(degod.image, 'https://arweave.net/degod-1234.png');
  assert.equal(degod.metadataUri, 'https://arweave.net/abc.json');
  assert.deepEqual(degod.attributes, [{ trait_type: 'Background', value: 'Blue' }]);
  assert.equal(degod.metadataOk, true);
});

// ===========================================================================
// 3. HONEST-OR-NOTHING — missing key / error => null => `unavailable`
// ===========================================================================
test('missing key => null (not a fake empty array)', async () => {
  const idx = NI.createIndexer({ alchemy: {}, fetchImpl: fetchStub([{ match: () => true, body: ALCHEMY_BODY }]) });
  assert.equal(await idx.getNFTsForOwner('ethereum', '0xOWNER'), null, 'no Alchemy key -> null');

  const idxSol = NI.createIndexer({ fetchImpl: fetchStub([{ match: () => true, body: DAS_BODY }]) });
  assert.equal(await idxSol.getNFTsForOwner('solana', 'Owner'), null, 'no DAS key/url -> null');
});

test('HTTP / parse error => null', async () => {
  const idx = NI.createIndexer({ alchemy: { apiKey: 'k' }, fetchImpl: fetchStub([{ match: () => true, ok: false, status: 500, body: {} }]) });
  assert.equal(await idx.getNFTsForOwner('ethereum', '0xOWNER'), null, 'HTTP 500 -> null');

  const idxThrow = NI.createIndexer({ alchemy: { apiKey: 'k' }, fetchImpl: async () => { throw new Error('network down'); } });
  assert.equal(await idxThrow.getNFTsForOwner('ethereum', '0xOWNER'), null, 'thrown error -> null');

  const idxDasErr = NI.createIndexer({ helius: { apiKey: 'k' }, fetchImpl: async () => ({ ok: true, async json() { return { error: { code: -32000, message: 'bad' } }; } }) });
  assert.equal(await idxDasErr.getNFTsForOwner('solana', 'Owner'), null, 'DAS error body -> null');
});

test('missing key => nft.js reports the account unavailable (NEVER a fake empty inventory)', async () => {
  const idx = NI.createIndexer({ alchemy: {}, fetchImpl: fetchStub([{ match: () => true, body: ALCHEMY_BODY }]) });
  const res = await NFT.nfts([{ chain: 'ethereum', address: '0xOWNER' }], { indexer: idx, config: {} });
  assert.equal(res.items.length, 0);
  assert.equal(res.unavailable.length, 1);
  assert.match(res.unavailable[0].reason, /NOT a claim/, 'honest unavailable note, not an empty-holdings claim');
});

test('unsupported chain => null (honest)', async () => {
  const idx = NI.createIndexer({ alchemy: { apiKey: 'k' }, helius: { apiKey: 'k' }, fetchImpl: fetchStub([{ match: () => true, body: {} }]) });
  assert.equal(await idx.getNFTsForOwner('bitcoin', 'bc1xyz'), null);
});
