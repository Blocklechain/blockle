// cardano_cbor.dart — the canonical (definite-length) CBOR the Cardano ledger
// requires for transaction bodies and signed transactions.
//
// Only what a native-ADA transfer needs: unsigned ints (major 0, minimal
// width), byte strings (major 2), arrays (major 4), maps (major 5, small int
// keys 0..3 in canonical order) plus the `true`/`null` simple values of the
// Conway/Babbage signed-tx array. Every integer uses the MINIMAL encoding width
// (0x00..0x17 inline, else 0x18/0x19/0x1a/0x1b) — pinned by the cborKats in
// docs/cardano-vectors.json. Ported alongside the extension's cardano-cbor.js.
import 'dart:typed_data';

import '../crypto/crypto_core.dart' as c;

Uint8List _head(int major, int n) {
  final m = major << 5;
  if (n < 24) return Uint8List.fromList([m | n]);
  if (n < 0x100) return Uint8List.fromList([m | 24, n]);
  if (n < 0x10000) {
    return Uint8List.fromList([m | 25, (n >> 8) & 0xff, n & 0xff]);
  }
  if (n < 0x100000000) {
    return Uint8List.fromList([
      m | 26,
      (n >> 24) & 0xff,
      (n >> 16) & 0xff,
      (n >> 8) & 0xff,
      n & 0xff,
    ]);
  }
  // 64-bit width (8 bytes, big-endian). n is a Dart int (<= 2^63) here.
  final out = Uint8List(9);
  out[0] = m | 27;
  for (var i = 0; i < 8; i++) {
    out[8 - i] = (n >> (8 * i)) & 0xff;
  }
  return out;
}

Uint8List _headBig(int major, BigInt n) {
  if (n < BigInt.from(0x100000000)) return _head(major, n.toInt());
  final out = Uint8List(9);
  out[0] = (major << 5) | 27;
  final mask = BigInt.from(0xff);
  var v = n;
  for (var i = 0; i < 8; i++) {
    out[8 - i] = (v & mask).toInt();
    v >>= 8;
  }
  return out;
}

/// CBOR unsigned int (major 0), minimal width.
Uint8List cborUint(int n) => _head(0, n);

/// CBOR unsigned int from a BigInt (coin amounts can exceed 2^53).
Uint8List cborUintBig(BigInt n) => _headBig(0, n);

/// CBOR byte string (major 2).
Uint8List cborBytes(List<int> b) => c.concatBytes([_head(2, b.length), b]);

/// CBOR array (major 4) of already-encoded items.
Uint8List cborArray(List<Uint8List> items) =>
    c.concatBytes([_head(4, items.length), ...items]);

/// CBOR map (major 5) of already-encoded (key,value) pairs, in the given order
/// (the caller supplies canonical small-int-key order 0,1,2,3).
Uint8List cborMap(List<List<Uint8List>> pairs) => c.concatBytes([
      _head(5, pairs.length),
      for (final kv in pairs) ...[kv[0], kv[1]],
    ]);

final Uint8List cborTrue = Uint8List.fromList([0xf5]);
final Uint8List cborNull = Uint8List.fromList([0xf6]);

/// A transaction input: the 32-byte output tx hash + its index.
class CardanoTxIn {
  CardanoTxIn(this.txHash, this.index);
  final Uint8List txHash;
  final int index;
}

/// A transaction output: raw address bytes (57-byte Shelley base) + lovelace.
class CardanoTxOut {
  CardanoTxOut(this.addressBytes, this.coin);
  final Uint8List addressBytes;
  final BigInt coin;
}

/// Encode the canonical tx_body = {0:inputs, 1:outputs, 2:fee, 3:ttl}.
Uint8List encodeTxBody({
  required List<CardanoTxIn> inputs,
  required List<CardanoTxOut> outputs,
  required BigInt fee,
  required int ttl,
}) {
  final ins = cborArray([
    for (final i in inputs) cborArray([cborBytes(i.txHash), cborUint(i.index)]),
  ]);
  final outs = cborArray([
    for (final o in outputs)
      cborArray([cborBytes(o.addressBytes), cborUintBig(o.coin)]),
  ]);
  return cborMap([
    [cborUint(0), ins],
    [cborUint(1), outs],
    [cborUint(2), cborUintBig(fee)],
    [cborUint(3), cborUint(ttl)],
  ]);
}

/// Encode the Conway/Babbage signed tx = [body, {0:[[vkey,sig]]}, true, null].
Uint8List encodeSignedTx(Uint8List body, Uint8List vkey, Uint8List sig) {
  final vkeyWitness = cborArray([cborBytes(vkey), cborBytes(sig)]);
  final witnessSet = cborMap([
    [cborUint(0), cborArray([vkeyWitness])],
  ]);
  return cborArray([body, witnessSet, cborTrue, cborNull]);
}
