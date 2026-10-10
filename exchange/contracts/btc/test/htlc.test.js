'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const ecc = require('tiny-secp256k1');
const { ECPairFactory } = require('ecpair');
const ECPair = ECPairFactory(ecc);

const htlc = require('../src/htlc');
const {
  bitcoin,
  hashlock,
  htlcScript,
  buildHtlc,
  buildLockPsbt,
  buildRedeemPsbt,
  buildRefundPsbt,
  finalizeRedeem,
  finalizeRefund,
  splitFee,
  getNetwork,
} = htlc;
const { opcodes, script: bscript, Transaction } = bitcoin;

// ---------------------------------------------------------------------------
// Deterministic test fixtures (fixed keys/preimage → stable vectors, no RNG).
// These are TEST keys only — never used for real funds.
// ---------------------------------------------------------------------------
const NET = getNetwork('testnet');

// 32-byte preimage = bytes 0x00..0x1f
const PREIMAGE = Buffer.from(
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  'hex'
);
const H = hashlock(PREIMAGE); // sha256(preimage)

const receiverKey = ECPair.fromPrivateKey(
  Buffer.from('1111111111111111111111111111111111111111111111111111111111111111', 'hex'),
  { network: NET }
);
const refundKey = ECPair.fromPrivateKey(
  Buffer.from('2222222222222222222222222222222222222222222222222222222222222222', 'hex'),
  { network: NET }
);
const funderKey = ECPair.fromPrivateKey(
  Buffer.from('3333333333333333333333333333333333333333333333333333333333333333', 'hex'),
  { network: NET }
);

const LOCKTIME = 1800000000; // unix seconds (>500000000 → CLTV time mode), year 2027
const receiverPubkey = Buffer.from(receiverKey.publicKey);
const refundPubkey = Buffer.from(refundKey.publicKey);

function makeHtlc() {
  return buildHtlc(
    { hash: H, receiverPubkey, refundPubkey, locktime: LOCKTIME },
    'testnet'
  );
}

// A p2wpkh address controlled by a key (payout/change destination helper).
function p2wpkhAddress(key) {
  return bitcoin.payments.p2wpkh({ pubkey: Buffer.from(key.publicKey), network: NET }).address;
}

// Verify a PSBT partialSig actually signs the segwit-v0 sighash for the given
// witnessScript + value. This is the real cryptographic check that the spend
// would be accepted by a node for that branch.
function assertSigValid(psbt, inputIndex, witnessScript, value) {
  const input = psbt.data.inputs[inputIndex];
  assert.ok(input.partialSig && input.partialSig.length === 1, 'exactly one partialSig');
  const { signature, pubkey } = input.partialSig[0];
  const decoded = bscript.signature.decode(signature); // { signature: 64B, hashType }
  assert.equal(decoded.hashType, Transaction.SIGHASH_ALL);
  const tx = psbt.__CACHE.__TX; // the in-progress transaction
  const sighash = tx.hashForWitnessV0(inputIndex, witnessScript, value, Transaction.SIGHASH_ALL);
  assert.ok(ecc.verify(sighash, pubkey, decoded.signature), 'signature verifies against sighash');
}

// ---------------------------------------------------------------------------

test('hashlock is sha256(preimage) — identical to EVM/Solana legs', () => {
  const expected = crypto.createHash('sha256').update(PREIMAGE).digest('hex');
  assert.equal(H.toString('hex'), expected);
  // sanity: node crypto and bitcoinjs crypto agree
  assert.equal(H.toString('hex'), bitcoin.crypto.sha256(PREIMAGE).toString('hex'));
});

test('witness script decompiles to the exact HTLC template (OP_SHA256, not OP_HASH160)', () => {
  const script = htlcScript({ hash: H, receiverPubkey, refundPubkey, locktime: LOCKTIME });
  const asm = bscript.toASM(script).split(' ');

  assert.equal(asm[0], 'OP_SHA256', 'top opcode is OP_SHA256 (protocol sha256 hashlock)');
  assert.equal(asm[1], H.toString('hex'), 'pushes the 32-byte sha256 hashlock');
  assert.equal(asm[2], 'OP_EQUAL');
  assert.equal(asm[3], 'OP_IF');
  assert.equal(asm[4], receiverPubkey.toString('hex'), 'IF branch = receiver pubkey');
  assert.equal(asm[5], 'OP_ELSE');
  // asm[6] = locktime minimally-encoded number
  assert.equal(asm[7], 'OP_CHECKLOCKTIMEVERIFY');
  assert.equal(asm[8], 'OP_DROP');
  assert.equal(asm[9], refundPubkey.toString('hex'), 'ELSE branch = refund pubkey');
  assert.equal(asm[10], 'OP_ENDIF');
  assert.equal(asm[11], 'OP_CHECKSIG');

  // The locktime encodes/decodes correctly.
  const decodedLock = bscript.number.decode(Buffer.from(asm[6], 'hex'));
  assert.equal(decodedLock, LOCKTIME);

  // Must NOT contain OP_HASH160 (ripemd160·sha256 would be an incompatible hashlock).
  assert.ok(!asm.includes('OP_HASH160'), 'no OP_HASH160 — hashlock stays pure sha256');
});

test('P2WSH address is deterministic and round-trips to scriptPubKey', () => {
  const h = makeHtlc();
  // testnet native segwit v0 script hash → tb1q...
  assert.match(h.address, /^tb1q[0-9a-z]{58}$/);

  // scriptPubKey = OP_0 <sha256(witnessScript)>
  const expectedProgram = bitcoin.crypto.sha256(h.witnessScript);
  const spk = bscript.decompile(h.output);
  assert.equal(spk[0], opcodes.OP_0);
  assert.equal(Buffer.from(spk[1]).toString('hex'), expectedProgram.toString('hex'));

  // address → output script round-trip
  assert.equal(
    bitcoin.address.toOutputScript(h.address, NET).toString('hex'),
    h.output.toString('hex')
  );
});

test('regtest/signet/mainnet networks produce the right address prefixes', () => {
  const args = { hash: H, receiverPubkey, refundPubkey, locktime: LOCKTIME };
  assert.match(buildHtlc(args, 'regtest').address, /^bcrt1q/);
  assert.match(buildHtlc(args, 'signet').address, /^tb1q/);
  assert.match(buildHtlc(args, 'mainnet').address, /^bc1q/);
});

// Build a fake but well-formed funding (lock) transaction so we have a real
// prevout (txid + vout) to spend in redeem/refund. No network needed.
function fundHtlc(h, amount = 100000) {
  const funderAddr = p2wpkhAddress(funderKey);
  const funderSpk = bitcoin.address.toOutputScript(funderAddr, NET);
  // a dummy prior utxo feeding the lock tx
  const lock = buildLockPsbt({
    htlc: h,
    amount,
    inputs: [{
      txid: 'aa'.repeat(32),
      index: 0,
      sequence: 0xffffffff,
      witnessUtxo: { script: funderSpk, value: amount + 500 },
      value: amount + 500,
    }],
    changeAddress: funderAddr,
    fee: 500,
  });
  lock.signInput(0, funderKey);
  lock.finalizeInput(0);
  const tx = lock.extractTransaction();
  return { txid: tx.getId(), index: 0, value: amount };
}

test('LOCK psbt funds the P2WSH output and balances change', () => {
  const h = makeHtlc();
  const funderAddr = p2wpkhAddress(funderKey);
  const funderSpk = bitcoin.address.toOutputScript(funderAddr, NET);
  const psbt = buildLockPsbt({
    htlc: h,
    amount: 100000,
    inputs: [{ txid: 'bb'.repeat(32), index: 1, sequence: 0xffffffff, witnessUtxo: { script: funderSpk, value: 150000 }, value: 150000 }],
    changeAddress: funderAddr,
    fee: 500,
  });
  const outs = psbt.txOutputs;
  assert.equal(outs[0].address, h.address);
  assert.equal(outs[0].value, 100000);
  assert.equal(outs[1].value, 150000 - 100000 - 500); // change
});

test('REDEEM: receiver spends with preimage; fee split correct; signature valid', () => {
  const h = makeHtlc();
  const utxo = fundHtlc(h, 100000);
  const receiverAddr = p2wpkhAddress(receiverKey);
  const feeAddr = p2wpkhAddress(funderKey); // stand-in treasury fee address

  const psbt = buildRedeemPsbt({
    htlc: h,
    utxo,
    receiverAddress: receiverAddr,
    minerFee: 300,
    feeBps: 10, // 0.1%
    feeAddress: feeAddr,
  });

  psbt.signInput(0, receiverKey);
  assertSigValid(psbt, 0, h.witnessScript, utxo.value);

  finalizeRedeem(psbt, 0, PREIMAGE);
  const tx = psbt.extractTransaction();

  // witness stack = [ sig, preimage, witnessScript ]
  const w = tx.ins[0].witness;
  assert.equal(w.length, 3);
  assert.equal(Buffer.from(w[1]).toString('hex'), PREIMAGE.toString('hex'), 'preimage revealed on-chain');
  assert.equal(Buffer.from(w[2]).toString('hex'), h.witnessScript.toString('hex'));

  // fee math: spendable = 100000 - 300 = 99700; fee = floor(99700*10/10000)=99
  const spendable = 100000 - 300;
  const fee = Math.floor((spendable * 10) / 10000);
  assert.equal(tx.outs[0].value, spendable - fee, 'receiver gets payout - protocol fee');
  assert.equal(tx.outs[1].value, fee, 'protocol fee output');
  assert.equal(tx.locktime, 0, 'redeem path sets no nLockTime');
});

test('REDEEM with feeBps=0 takes no protocol fee (single output)', () => {
  const h = makeHtlc();
  const utxo = fundHtlc(h, 100000);
  const psbt = buildRedeemPsbt({
    htlc: h, utxo, receiverAddress: p2wpkhAddress(receiverKey), minerFee: 300, feeBps: 0,
  });
  psbt.signInput(0, receiverKey);
  finalizeRedeem(psbt, 0, PREIMAGE);
  const tx = psbt.extractTransaction();
  assert.equal(tx.outs.length, 1);
  assert.equal(tx.outs[0].value, 100000 - 300);
});

test('REFUND: depositor spends ELSE branch after timelock; no fee; nLockTime set', () => {
  const h = makeHtlc();
  const utxo = fundHtlc(h, 100000);
  const refundAddr = p2wpkhAddress(refundKey);

  const psbt = buildRefundPsbt({ htlc: h, utxo, refundAddress: refundAddr, minerFee: 300 });
  psbt.signInput(0, refundKey);
  assertSigValid(psbt, 0, h.witnessScript, utxo.value);

  finalizeRefund(psbt, 0);
  const tx = psbt.extractTransaction();

  // witness stack = [ sig, <empty>, witnessScript ] → OP_EQUAL false → ELSE branch
  const w = tx.ins[0].witness;
  assert.equal(w.length, 3);
  assert.equal(Buffer.from(w[1]).length, 0, 'empty element selects the ELSE/refund branch');
  assert.equal(Buffer.from(w[2]).toString('hex'), h.witnessScript.toString('hex'));

  assert.equal(tx.locktime, LOCKTIME, 'nLockTime == CLTV locktime');
  assert.equal(tx.ins[0].sequence, htlc.CLTV_SEQUENCE, 'non-final sequence so CLTV is enforced');
  assert.equal(tx.outs.length, 1);
  assert.equal(tx.outs[0].value, 100000 - 300, 'full value back to depositor, no protocol fee');
});

test('wrong preimage does not satisfy the hashlock (OP_EQUAL would fail)', () => {
  const wrong = Buffer.from('ff'.repeat(32), 'hex');
  assert.notEqual(hashlock(wrong).toString('hex'), H.toString('hex'));
});

test('splitFee: 0.1% math and the 1% hard cap', () => {
  assert.deepEqual(splitFee(100000, 10), { payout: 99900, protocolFee: 100 });
  assert.deepEqual(splitFee(100000, 0), { payout: 100000, protocolFee: 0 });
  assert.deepEqual(splitFee(100000, 100), { payout: 99000, protocolFee: 1000 }); // 1%
  assert.throws(() => splitFee(100000, 101), /feeBps/); // over cap
});

test('buildRedeemPsbt rejects feeBps>0 without a feeAddress', () => {
  const h = makeHtlc();
  const utxo = fundHtlc(h, 100000);
  assert.throws(
    () => buildRedeemPsbt({ htlc: h, utxo, receiverAddress: p2wpkhAddress(receiverKey), minerFee: 300, feeBps: 10 }),
    /feeAddress required/
  );
});

test('input validation: bad hashlock / pubkey / locktime rejected', () => {
  assert.throws(() => htlcScript({ hash: Buffer.alloc(31), receiverPubkey, refundPubkey, locktime: LOCKTIME }), /32-byte/);
  assert.throws(() => htlcScript({ hash: H, receiverPubkey: Buffer.alloc(33), refundPubkey, locktime: LOCKTIME }), /compressed public key/);
  assert.throws(() => htlcScript({ hash: H, receiverPubkey, refundPubkey, locktime: -1 }), /locktime/);
});
