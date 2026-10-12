// nft.test.js — WALLET NFT SUPPORT (docs/WALLET-NFT.md). Run: node --test nft.test.js
//
// Asserts the reference nft.js against the AUTHORITATIVE shared vectors
// (docs/nft-vectors.json) that the Dart + Python ports must reproduce: inventory
// grouping (incl. a metadata-unavailable item), ipfs:// normalization, exact
// ERC-721 + ERC-1155 transfer calldata, the overdraw / wrong-from fail-closed
// guards, spam flagging, approval surfacing, and that a built send routes through
// the SAME security.inspectTransaction gate as a normal send.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const NFT = require('./nft.js');
const EVM = require('./chains/evm.js');
const Security = require('./security.js');

const V = require(path.join('..', 'docs', 'nft-vectors.json'));

// an injected indexer built from the PLAIN vector `raw` map (no functions)
function indexerFromRaw(rawMap) {
  return {
    async getNFTsForOwner(chain, owner) {
      const key = chain + ':' + owner;
      if (!(key in rawMap)) return [];
      return rawMap[key];
    },
  };
}
function byContract(items) {
  const m = {};
  for (const it of items) {
    const k = String(it.contract).toLowerCase();
    (m[k] = m[k] || []).push(it);
  }
  return m;
}

// ===========================================================================
// 1. INVENTORY — grouping, balances, metadata-unavailable, ipfs normalization
// ===========================================================================
test('inventory: groups by collection; erc721/erc1155/metaplex; never fabricates metadata', async () => {
  const inv = V.inventory;
  const ctx = { config: V.config, indexer: indexerFromRaw(inv.raw) };
  const res = await NFT.nfts(inv.accounts, ctx);
  const e = inv.expect;

  assert.deepEqual(res.unavailable, e.unavailable, 'no unavailable accounts');

  const groups = byContract(res.items);
  for (const [contract, exp] of Object.entries(e.itemsByContract)) {
    const items = groups[contract];
    assert.ok(items, 'has items for ' + contract);
    assert.equal(items.length, exp.count, 'count for ' + contract);
    assert.equal(items[0].standard, exp.standard, 'standard for ' + contract);
    const balances = items.map((i) => i.balance);
    assert.deepEqual(balances, exp.balances, 'balances for ' + contract);
    if (exp.tokenIds) assert.deepEqual(items.map((i) => i.tokenId), exp.tokenIds, 'tokenIds for ' + contract);
    if (exp.collection != null) assert.equal(items[0].collection, exp.collection, 'collection name for ' + contract);
    if (exp.metadataOk === false) {
      assert.equal(items[0].metadataOk, false, 'metadataOk false for ' + contract);
      assert.equal(items[0].metadataNote, exp.metadataNote, 'metadata-unavailable note');
    }
    if (exp.hasName === false) assert.equal(items[0].name, undefined, 'no fabricated name for ' + contract);
  }

  // grouping object
  const keys = res.collections.map((c) => c.key);
  assert.deepEqual(keys.sort(), [...e.collectionKeys].sort(), 'collection keys');
  const bayc = res.collections.find((c) => c.key === 'ethereum:0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d');
  assert.equal(bayc.count, 2, 'BAYC grouped count');
  assert.equal(bayc.items.length, 2);

  // ipfs media normalized on the inventory items
  for (const [k, expImg] of Object.entries(e.normalizedImages)) {
    const [chain, contract, tokenId] = k.split(':');
    const it = res.items.find((i) => i.chain === chain && String(i.contract).toLowerCase() === contract && i.tokenId === tokenId);
    assert.ok(it, 'found item ' + k);
    assert.equal(it.image, expImg, 'normalized image for ' + k);
  }
});

test('inventory: no indexer => account listed unavailable, NEVER a fake empty inventory', async () => {
  const u = V.unavailable;
  const res = await NFT.nfts(u.accounts, { config: V.config }); // no indexer
  assert.equal(res.items.length, u.expect.items);
  assert.equal(res.unavailable.length, u.expect.unavailableCount);
  assert.match(res.unavailable[0].reason, /NOT a claim/);
});

test('inventory: indexer error => unavailable (fails safe)', async () => {
  const indexer = { async getNFTsForOwner() { throw new Error('boom'); } };
  const res = await NFT.nfts([{ chain: 'ethereum', address: '0x1111111111111111111111111111111111111111' }], { indexer });
  assert.equal(res.items.length, 0);
  assert.equal(res.unavailable.length, 1);
  assert.match(res.unavailable[0].reason, /indexer error/);
});

// ===========================================================================
// 2. ipfs:// normalization (gateway-configured; non-ipfs passes through)
// ===========================================================================
test('ipfs:// normalization to the configured gateway', () => {
  for (const c of V.ipfs) {
    assert.equal(NFT.normalizeUri(c.in, V.config), c.out, c.in);
  }
  assert.equal(NFT.normalizeUri(null, V.config), null, 'null passes through');
});

// ===========================================================================
// 3-4. SEND — exact ERC-721 + ERC-1155 calldata (routes through the signer)
// ===========================================================================
for (const tv of V.transfers) {
  test('transfer: ' + tv.name, () => {
    const tx = NFT.buildNftTransfer(tv.req, tv.ctx);
    const e = tv.expect;
    assert.equal(tx.kind, e.kind, 'kind');
    assert.equal(tx.standard, e.standard, 'standard');
    assert.equal(tx.to, e.to, 'to (contract target)');
    assert.equal(tx.value, e.value, 'value');
    assert.equal(tx.data, e.data, 'EXACT calldata');
    // the module NEVER signs: no raw/txid/signature on the built tx
    assert.ok(!('raw' in tx) && !('txid' in tx), 'no signed artifact — module never signs');
  });
}

// ===========================================================================
// GUARDS — fail-closed (overdraw / wrong-from / missing ownedBalance)
// ===========================================================================
for (const g of V.guards) {
  test('guard: ' + g.name, () => {
    assert.throws(() => NFT.buildNftTransfer(g.req, g.ctx), (err) => {
      assert.ok(err.message.includes(g.expectError), 'error "' + err.message + '" includes "' + g.expectError + '"');
      return true;
    });
  });
}

// ===========================================================================
// 3 (spec §3). SPAM — conservative FLAG only, never a safety/value claim
// ===========================================================================
for (const s of V.spam) {
  test('spam: ' + s.name, () => {
    const item = NFT.normalizeItem(s.raw, V.config);
    if (s.expect.spam) {
      assert.equal(item.spam, true, 'flagged');
      assert.deepEqual((item.spamReasons || []).sort(), [...s.expect.reasons].sort(), 'reasons');
    } else {
      assert.ok(!item.spam, 'not flagged');
    }
  });
}

// ===========================================================================
// 4 (spec §4). APPROVAL AWARENESS — reuse the security approval manager
// ===========================================================================
test('surfaceApprovals: operator (setApprovalForAll) rows flagged danger/revocable; erc20 allowance is not', async () => {
  const a = V.approvals;
  const indexer = { async getApprovals() { return a.rawApprovals; } };
  const res = await NFT.surfaceApprovals(a.chain, a.owner, { indexer });
  assert.equal(res.available, true);
  assert.equal(res.operatorApprovals.length, a.expect.operatorApprovals.length, 'one operator approval surfaced');
  const op = res.operatorApprovals[0];
  const exp = a.expect.operatorApprovals[0];
  assert.equal(op.collection, exp.collection);
  assert.equal(op.operator, exp.operator);
  assert.equal(op.severity, 'danger');
  assert.equal(op.revocable, true);
});

test('surfaceApprovals: no indexer => unavailable, never a fake all-clear', async () => {
  const res = await NFT.surfaceApprovals('ethereum', '0x1111111111111111111111111111111111111111', {});
  assert.equal(res.available, false);
  assert.deepEqual(res.operatorApprovals, []);
});

// ===========================================================================
// SEND ROUTES THROUGH THE SAME SECURITY GATE as a normal send
// ===========================================================================
test('built send is inspected by security.inspectTransaction (decodes nft-transfer + recipient)', async () => {
  const s = V.inspect.safeRecipient;
  const insp = await Security.inspectTransaction(s.tx, {});
  assert.equal(insp.kind, s.expect.kind, 'kind');
  assert.equal(insp.severity, s.expect.severity, 'severity');
  const to = insp.details.find((d) => d.label === 'To');
  assert.equal(to.value, s.expect.to, 'recipient decoded');
});

test('built send to a denylisted recipient raises send-to-flagged (danger) — same gate as any send', async () => {
  const s = V.inspect.flaggedRecipient;
  const insp = await Security.inspectTransaction(s.tx, { config: s.config });
  assert.equal(insp.kind, s.expect.kind);
  assert.equal(insp.severity, s.expect.severity);
  assert.deepEqual(insp.warnings.map((w) => w.code).sort(), [...s.expect.warnings].sort());
});

// ===========================================================================
// end-to-end: a built ERC-1155 send and the security inspection agree on calldata
// ===========================================================================
test('end-to-end: buildNftTransfer calldata matches the EVM adapter builder exactly', () => {
  const tx = NFT.buildNftTransfer({
    chain: 'ethereum', standard: 'erc1155',
    contract: '0x495f947276749Ce646f68AC8c248420045cb7b5e',
    tokenId: '42', amount: '3', ownedBalance: '7',
    from: '0x1111111111111111111111111111111111111111',
    to: '0x2222222222222222222222222222222222222222',
  }, { accounts: [{ chain: 'ethereum', address: '0x1111111111111111111111111111111111111111' }] });
  const direct = EVM.erc1155SafeTransferFromData(
    '0x1111111111111111111111111111111111111111',
    '0x2222222222222222222222222222222222222222', '42', '3', '0x');
  assert.equal(tx.data, direct, 'nft.js reuses the EVM calldata builder');
});
