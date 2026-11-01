// solana-nft.test.js — real Solana (SPL/Metaplex) NFT transfer construction.
// Run: node --test solana-nft.test.js
//
// Proves the hand-rolled Solana transfer builder byte-for-byte against golden
// vectors captured from the canonical @solana/web3.js + @solana/spl-token
// (see scripts that generated docs/nft-vectors.json). No external deps at test
// time. Covers: the base58 all-zero fix, ATA (program-derived) addresses, the
// TransferChecked + idempotent-create-ATA instructions, the compiled legacy
// message (with and without the create ix), and a full sign + verify round-trip.

const { test } = require('node:test');
const assert = require('node:assert');

const C = require('./crypto-core.js');
const ED = require('./ed25519.js');
const SOL = require('./chains/solana.js');

// Golden vectors — deterministic inputs (ed25519 pubkeys from fixed 32-byte
// seeds 1/2/3/9), cross-generated against @solana/web3.js.
const G = {
  owner: 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9',
  dest: '9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu',
  mint: 'GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse',
  source: 'JAYwnTWS9z44Bv3N3otEHihbKfMLzTwwskqhWc9n5qii',
  destAta: '13KoHDCDXebtaN59JpGpQCmhsk8u7qk9H9FFSCMyynLh',
  blockhash: 'J2xccRtuG43drESLYznHhLhQkLTdfepcKYbiQ9BsJVaf',
  msgWithCreate:
    '010005088a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c00986a9f842ff1b003c7af9c6107e715f22c1d10702647496098cc0bd6adddcaff09065c342ea325b694ca7e5e1774b889b59a9a1c010f48425d8c1b718090e3000000000000000000000000000000000000000000000000000000000000000006ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a98139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b3948c97258f4e2489f1bb3d1029148e0d830b5a1399daff1084048e7bd8dbe9f859ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1fd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f61802060600010507030401010404020701000a0c010000000000000000',
  msgNoCreate:
    '010002058a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c00986a9f842ff1b003c7af9c6107e715f22c1d10702647496098cc0bd6adddcaff09065c342ea325b694ca7e5e1774b889b59a9a1c010f48425d8c1b718090e306ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1fd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f618010304020401000a0c010000000000000000',
};
const hex = (u) => C.bytesToHex(u);

test('base58 encodes/decodes the all-zero System program key exactly', () => {
  const ones = '11111111111111111111111111111111'; // 32 ones
  const dec = C.base58decode(ones);
  assert.strictEqual(dec.length, 32);
  assert.ok(dec.every((b) => b === 0));
  assert.strictEqual(C.base58encode(dec), ones);
  assert.strictEqual(C.base58encode(new Uint8Array(32)), ones);
});

test('findProgramAddress yields a deterministic, off-curve address', () => {
  const seeds = [C.base58decode(G.owner), C.base58decode(SOL.TOKEN_PROGRAM), C.base58decode(G.mint)];
  const prog = C.base58decode(SOL.ASSOCIATED_TOKEN_PROGRAM);
  const a = SOL.findProgramAddress(seeds, prog);
  const b = SOL.findProgramAddress(seeds, prog);
  assert.strictEqual(hex(a.address), hex(b.address)); // deterministic
  assert.strictEqual(SOL.isOnCurve(a.address), false); // PDAs are off the curve
});

test('ATA derivation matches the canonical source + destination accounts', () => {
  const owner = C.base58decode(G.owner), dest = C.base58decode(G.dest), mint = C.base58decode(G.mint);
  assert.strictEqual(C.base58encode(SOL.associatedTokenAddress(owner, mint)), G.source);
  assert.strictEqual(C.base58encode(SOL.associatedTokenAddress(dest, mint)), G.destAta);
});

test('TransferChecked data = tag 12 ‖ amount(u64 LE) ‖ decimals', () => {
  const ix = SOL.transferCheckedIx(
    C.base58decode(G.source), C.base58decode(G.mint), C.base58decode(G.destAta),
    C.base58decode(G.owner), '1', 0);
  assert.strictEqual(hex(ix.data), '0c' + '0100000000000000' + '00'); // tag 12, amount 1 (u64 LE), 0 decimals
  assert.strictEqual(ix.keys.length, 4);
  assert.strictEqual(ix.keys[3].isSigner, true); // owner signs
});

test('compiled legacy message is byte-stable (portable bytewise order; web3.js-deserializable) — no create', () => {
  const ix = SOL.transferCheckedIx(
    C.base58decode(G.source), C.base58decode(G.mint), C.base58decode(G.destAta),
    C.base58decode(G.owner), '1', 0);
  const msg = SOL.compileMessage(C.base58decode(G.owner), [ix], C.base58decode(G.blockhash));
  assert.strictEqual(hex(msg), G.msgNoCreate);
});

test('compiled message is byte-stable with an idempotent ATA-create prepended', () => {
  const owner = C.base58decode(G.owner), mint = C.base58decode(G.mint);
  const create = SOL.createAtaIdempotentIx(owner, C.base58decode(G.destAta), C.base58decode(G.dest), mint);
  const xfer = SOL.transferCheckedIx(C.base58decode(G.source), mint, C.base58decode(G.destAta), owner, '1', 0);
  const msg = SOL.compileMessage(owner, [create, xfer], C.base58decode(G.blockhash));
  assert.strictEqual(hex(msg), G.msgWithCreate);
});

test('the unsigned tx can be located + signed, and the signature verifies', () => {
  const ix = SOL.transferCheckedIx(
    C.base58decode(G.source), C.base58decode(G.mint), C.base58decode(G.destAta),
    C.base58decode(G.owner), '1', 0);
  const msg = SOL.compileMessage(C.base58decode(G.owner), [ix], C.base58decode(G.blockhash));
  const unsigned = SOL.unsignedTx(msg);
  // a real signer whose pubkey IS the fee payer
  const seed = new Uint8Array(32).fill(1); // same seed that produced G.owner
  const pub = ED.publicKey(seed);
  assert.strictEqual(C.base58encode(pub), G.owner);
  const signed = SOL.signSerializedTx(unsigned, seed, pub);
  const loc = SOL.locateSigner(signed, pub);
  assert.strictEqual(loc.signerIndex, 0); // fee payer is index 0
  const sig = signed.slice(loc.sigAreaStart, loc.sigAreaStart + 64);
  assert.ok(ED.verify(signed.slice(loc.messageStart), sig, pub));
});
