'use strict';

/**
 * BTC leg of the Blockle cross-chain atomic swap.
 *
 * A native Bitcoin Script HTLC, wrapped in P2WSH (native SegWit v0), with a
 * PSBT-based builder for the three protocol transitions:
 *
 *   - lock    : fund the P2WSH HTLC output
 *   - redeem  : spend it with the preimage (receiver / happy path)
 *   - refund  : spend it after the CLTV timelock (depositor / failure path)
 *
 * Hashlock is **sha256(preimage)** so it is byte-identical to the EVM and
 * Solana legs (see ../PROTOCOL.md §4). We therefore use the Script opcode
 * OP_SHA256 — NOT OP_HASH160 (which is ripemd160(sha256(x)) and would be a
 * different, incompatible hashlock).
 *
 * Witness script (BIP-199-style HTLC):
 *
 *   OP_SHA256 <H> OP_EQUAL
 *   OP_IF
 *       <receiverPubKey>
 *   OP_ELSE
 *       <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP
 *       <refundPubKey>
 *   OP_ENDIF
 *   OP_CHECKSIG
 *
 * Redeem path  (receiver, with preimage): witness = [ sig, preimage,     script ]
 * Refund path  (depositor, after locktime): witness = [ sig, <empty/00>, script ]
 *
 * The top OP_SHA256 ... OP_EQUAL leaves TRUE/FALSE on the stack which the
 * OP_IF consumes to select the branch: a correct preimage selects the receiver
 * key, anything else selects the refund key (which additionally gates on CLTV).
 * A single trailing OP_CHECKSIG serves both branches.
 *
 * This module is pure script/PSBT construction — it never touches a network,
 * a node, or a private key store. Signing is done by the caller's key via the
 * standard PSBT signer interface. Broadcasting is out of scope (needs a
 * testnet node / wallet / Esplora endpoint — see README).
 */

const bitcoin = require('bitcoinjs-lib');
const { crypto, script: bscript, opcodes, payments, Psbt, networks, Transaction } = bitcoin;

// nSequence that still allows CLTV (must be < 0xffffffff so nLockTime is honored,
// and we keep the RBF/relative-locktime-disable semantics simple). BIP-65 only
// requires the input's sequence not be final (0xffffffff).
const CLTV_SEQUENCE = 0xfffffffe;

/** Map a friendly network name to a bitcoinjs network object. */
function getNetwork(name) {
  switch ((name || 'testnet').toLowerCase()) {
    case 'mainnet':
    case 'bitcoin':
      return networks.bitcoin;
    case 'testnet':
    case 'signet': // signet shares testnet address prefixes in bitcoinjs-lib
      return networks.testnet;
    case 'regtest':
      return networks.regtest;
    default:
      throw new Error(`unknown network: ${name}`);
  }
}

/**
 * Compute the protocol hashlock from a preimage.
 * H = sha256(preimage) — identical to the EVM/Solana legs.
 * @param {Buffer} preimage 32 random bytes (any length accepted; 32 is the norm)
 * @returns {Buffer} 32-byte sha256 digest
 */
function hashlock(preimage) {
  if (!Buffer.isBuffer(preimage)) throw new TypeError('preimage must be a Buffer');
  return crypto.sha256(preimage);
}

/**
 * Build the raw HTLC witness script (the redeemScript for P2WSH).
 *
 * @param {object} p
 * @param {Buffer} p.hash           32-byte hashlock H = sha256(preimage)
 * @param {Buffer} p.receiverPubkey 33-byte compressed pubkey that can redeem with the preimage
 * @param {Buffer} p.refundPubkey   33-byte compressed pubkey that can refund after locktime
 * @param {number} p.locktime       CLTV value: unix time (>=500000000) or block height (<500000000)
 * @returns {Buffer} the witness script
 */
function htlcScript({ hash, receiverPubkey, refundPubkey, locktime }) {
  if (!Buffer.isBuffer(hash) || hash.length !== 32) {
    throw new Error('hash (hashlock) must be a 32-byte Buffer');
  }
  assertPubkey(receiverPubkey, 'receiverPubkey');
  assertPubkey(refundPubkey, 'refundPubkey');
  if (!Number.isInteger(locktime) || locktime < 0) {
    throw new Error('locktime must be a non-negative integer');
  }

  return bscript.compile([
    opcodes.OP_SHA256,
    hash,
    opcodes.OP_EQUAL,
    opcodes.OP_IF,
      receiverPubkey,
    opcodes.OP_ELSE,
      bscript.number.encode(locktime),
      opcodes.OP_CHECKLOCKTIMEVERIFY,
      opcodes.OP_DROP,
      refundPubkey,
    opcodes.OP_ENDIF,
    opcodes.OP_CHECKSIG,
  ]);
}

function assertPubkey(pk, label) {
  if (!Buffer.isBuffer(pk) || pk.length !== 33 || (pk[0] !== 0x02 && pk[0] !== 0x03)) {
    throw new Error(`${label} must be a 33-byte compressed public key`);
  }
}

/**
 * Derive the full HTLC descriptor: witness script + P2WSH address.
 * @param {object} args see htlcScript()
 * @param {string|object} network friendly name or bitcoinjs network object
 * @returns {{ witnessScript: Buffer, address: string, output: Buffer, network: object, hash: Buffer, locktime: number }}
 */
function buildHtlc(args, network = 'testnet') {
  const net = typeof network === 'string' ? getNetwork(network) : network;
  const witnessScript = htlcScript(args);
  const p2wsh = payments.p2wsh({
    redeem: { output: witnessScript, network: net },
    network: net,
  });
  return {
    witnessScript,
    address: p2wsh.address,
    output: p2wsh.output, // scriptPubKey
    network: net,
    hash: args.hash,
    locktime: args.locktime,
  };
}

/**
 * Build an unsigned PSBT that FUNDS the HTLC (the lock transaction).
 *
 * The depositor funds `htlc.address` with `amount` sats from one or more of
 * their own UTXOs. This is an ordinary send to the P2WSH address — nothing
 * HTLC-specific is needed to construct it, but we provide it for completeness
 * and so the whole leg lives in one builder.
 *
 * @param {object} p
 * @param {object} p.htlc           result of buildHtlc()
 * @param {number} p.amount         sats to lock into the HTLC output
 * @param {Array}  p.inputs         [{ hash|txid, index, witnessUtxo?|nonWitnessUtxo? , ...signData }]
 * @param {string} p.changeAddress  where to send change
 * @param {number} p.fee            miner fee in sats
 * @returns {Psbt}
 */
function buildLockPsbt({ htlc, amount, inputs, changeAddress, fee }) {
  const net = htlc.network;
  const psbt = new Psbt({ network: net });
  let inSum = 0;
  for (const inp of inputs) {
    const base = normalizeInput(inp);
    psbt.addInput(base);
    inSum += inputValue(inp);
  }
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('amount must be a positive integer (sats)');
  psbt.addOutput({ address: htlc.address, value: amount });
  const change = inSum - amount - fee;
  if (change < 0) throw new Error(`insufficient inputs: have ${inSum}, need ${amount + fee}`);
  if (change > 0) psbt.addOutput({ address: changeAddress, value: change });
  return psbt;
}

/**
 * Build an unsigned PSBT that REDEEMS the HTLC with the preimage.
 *
 * Spends the HTLC output to the receiver (minus the protocol fee, which goes
 * to feeAddress — matching PROTOCOL.md §5). Fee is taken ONLY on this happy
 * path. The caller signs with the receiver key, then finalizeRedeem() injects
 * the preimage and selects the IF branch.
 *
 * @param {object} p
 * @param {object} p.htlc        buildHtlc() result
 * @param {object} p.utxo        { txid, index, value } of the HTLC output being spent
 * @param {string} p.receiverAddress payout destination
 * @param {number} p.minerFee    miner fee in sats
 * @param {number} [p.feeBps=0]  protocol fee in basis points (<=100). 0 to disable.
 * @param {string} [p.feeAddress] protocol fee destination (required if feeBps>0)
 * @returns {Psbt}
 */
function buildRedeemPsbt({ htlc, utxo, receiverAddress, minerFee, feeBps = 0, feeAddress }) {
  const net = htlc.network;
  const psbt = new Psbt({ network: net });

  psbt.addInput({
    hash: txidToHash(utxo.txid),
    index: utxo.index,
    sequence: CLTV_SEQUENCE,
    witnessUtxo: { script: htlc.output, value: utxo.value },
    witnessScript: htlc.witnessScript,
  });
  // No nLockTime needed on the redeem path (IF branch has no CLTV).

  const { payout, protocolFee } = splitFee(utxo.value - minerFee, feeBps);
  if (payout <= 0) throw new Error('miner fee exceeds output value');
  psbt.addOutput({ address: receiverAddress, value: payout });
  if (protocolFee > 0) {
    if (!feeAddress) throw new Error('feeAddress required when feeBps > 0');
    psbt.addOutput({ address: feeAddress, value: protocolFee });
  }
  return psbt;
}

/**
 * Build an unsigned PSBT that REFUNDS the HTLC after the timelock.
 *
 * Spends the HTLC output back to the depositor via the ELSE branch, which is
 * only valid once the chain's locktime >= htlc.locktime. No protocol fee is
 * taken on a refund (failed swap — user made whole).
 *
 * @param {object} p
 * @param {object} p.htlc           buildHtlc() result
 * @param {object} p.utxo           { txid, index, value }
 * @param {string} p.refundAddress  depositor payout
 * @param {number} p.minerFee       miner fee in sats
 * @returns {Psbt}
 */
function buildRefundPsbt({ htlc, utxo, refundAddress, minerFee }) {
  const net = htlc.network;
  const psbt = new Psbt({ network: net });

  psbt.setLocktime(htlc.locktime);
  psbt.addInput({
    hash: txidToHash(utxo.txid),
    index: utxo.index,
    sequence: CLTV_SEQUENCE, // non-final so nLockTime is enforced
    witnessUtxo: { script: htlc.output, value: utxo.value },
    witnessScript: htlc.witnessScript,
  });

  const value = utxo.value - minerFee;
  if (value <= 0) throw new Error('miner fee exceeds output value');
  psbt.addOutput({ address: refundAddress, value });
  return psbt;
}

/**
 * Finalize the redeem input: build the witness stack
 *   [ signature, preimage, witnessScript ]
 * selecting the OP_IF (receiver) branch.
 */
function finalizeRedeem(psbt, inputIndex, preimage) {
  const finalizer = (idx, input) => {
    const sig = getOnlySignature(input, idx);
    const witnessStack = [sig, preimage, lastWitnessScript(input)];
    return { finalScriptWitness: witnessStackToScriptWitness(witnessStack) };
  };
  psbt.finalizeInput(inputIndex, finalizer);
  return psbt;
}

/**
 * Finalize the refund input: build the witness stack
 *   [ signature, <empty>, witnessScript ]
 * The empty element is a zero-length push → OP_EQUAL yields FALSE → OP_ELSE
 * (refund) branch.
 */
function finalizeRefund(psbt, inputIndex) {
  const finalizer = (idx, input) => {
    const sig = getOnlySignature(input, idx);
    const witnessStack = [sig, Buffer.alloc(0), lastWitnessScript(input)];
    return { finalScriptWitness: witnessStackToScriptWitness(witnessStack) };
  };
  psbt.finalizeInput(inputIndex, finalizer);
  return psbt;
}

// ---- helpers ----------------------------------------------------------------

function splitFee(spendable, feeBps) {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 100) {
    throw new Error('feeBps must be an integer in [0, 100] (max 1.00%)');
  }
  const protocolFee = Math.floor((spendable * feeBps) / 10000);
  return { payout: spendable - protocolFee, protocolFee };
}

function getOnlySignature(input, idx) {
  if (!input.partialSig || input.partialSig.length === 0) {
    throw new Error(`input ${idx} is unsigned`);
  }
  return input.partialSig[0].signature;
}

function lastWitnessScript(input) {
  if (input.witnessScript) return input.witnessScript;
  throw new Error('missing witnessScript on input');
}

/** Convert a big-endian txid hex string to the little-endian hash Buffer PSBT wants. */
function txidToHash(txid) {
  return Buffer.from(txid, 'hex').reverse();
}

function normalizeInput(inp) {
  const base = {
    hash: inp.hash || txidToHash(inp.txid),
    index: inp.index,
    sequence: inp.sequence,
  };
  if (inp.witnessUtxo) base.witnessUtxo = inp.witnessUtxo;
  if (inp.nonWitnessUtxo) base.nonWitnessUtxo = inp.nonWitnessUtxo;
  if (inp.redeemScript) base.redeemScript = inp.redeemScript;
  if (inp.witnessScript) base.witnessScript = inp.witnessScript;
  return base;
}

function inputValue(inp) {
  if (typeof inp.value === 'number') return inp.value;
  if (inp.witnessUtxo) return inp.witnessUtxo.value;
  throw new Error('cannot determine input value; pass { value } or witnessUtxo');
}

/**
 * Serialize a witness stack (array of Buffers) into the finalScriptWitness
 * format PSBT expects. bitcoinjs-lib does not export this helper publicly, so
 * we re-implement the trivial varint-prefixed concatenation.
 */
function witnessStackToScriptWitness(witness) {
  let buffer = Buffer.allocUnsafe(0);
  const writeSlice = (slice) => { buffer = Buffer.concat([buffer, Buffer.from(slice)]); };
  const writeVarInt = (i) => {
    const current = Buffer.allocUnsafe(varIntSize(i));
    writeVarIntTo(current, 0, i);
    buffer = Buffer.concat([buffer, current]);
  };
  const writeVarSlice = (slice) => { writeVarInt(slice.length); writeSlice(slice); };
  const writeVector = (vector) => { writeVarInt(vector.length); vector.forEach(writeVarSlice); };
  writeVector(witness);
  return buffer;
}

function varIntSize(i) {
  if (i < 0xfd) return 1;
  if (i <= 0xffff) return 3;
  if (i <= 0xffffffff) return 5;
  return 9;
}
function writeVarIntTo(buf, offset, i) {
  if (i < 0xfd) { buf.writeUInt8(i, offset); return 1; }
  if (i <= 0xffff) { buf.writeUInt8(0xfd, offset); buf.writeUInt16LE(i, offset + 1); return 3; }
  if (i <= 0xffffffff) { buf.writeUInt8(0xfe, offset); buf.writeUInt32LE(i, offset + 1); return 5; }
  buf.writeUInt8(0xff, offset); buf.writeBigUInt64LE(BigInt(i), offset + 1); return 9;
}

module.exports = {
  CLTV_SEQUENCE,
  getNetwork,
  hashlock,
  htlcScript,
  buildHtlc,
  buildLockPsbt,
  buildRedeemPsbt,
  buildRefundPsbt,
  finalizeRedeem,
  finalizeRefund,
  splitFee,
  witnessStackToScriptWitness,
  // re-export for tests / callers
  bitcoin,
  Transaction,
};
