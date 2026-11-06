// bip32_ed25519.dart — Icarus (CIP-3) master key + BIP32-Ed25519
// (Khovratovich / CIP-1852) hierarchical derivation, the HD scheme Cardano uses.
//
// This is NOT SLIP-0010. The root comes from the BIP39 ENTROPY (the raw 16-32
// entropy bytes, NOT the 64-byte seed):
//   masterKey = PBKDF2-HMAC-SHA512(password="", salt=entropy, iters=4096, 96B)
//               -> (kL||kR||cc), then clamp kL (kL[0]&=0xF8, kL[31]&=0x1F|0x40).
// Child derivation keeps the full 256-bit kL with NO reduction mod L (the subtle
// part) and signs with the extended key via ed.signExtended.
//
// Cross-checked BYTE-IDENTICAL against the independent bip_utils
// (CardanoIcarus / CIP-1852 / CardanoShelley) reference; pinned by
// docs/cardano-vectors.json. Ported alongside the extension's cardano-crypto.js.
import 'dart:typed_data';

import 'crypto_core.dart' as c;
import 'ed25519.dart' as ed;

const int cardanoHardened = 0x80000000;

/// A BIP32-Ed25519 node: the extended private scalar halves [kL]/[kR]
/// (32 bytes each), the chain code [cc] (32 bytes) and the compressed public
/// key [a] (32 bytes, == ed.scalarMulBase(kL)).
class Bip32Ed25519Node {
  Bip32Ed25519Node(this.kL, this.kR, this.cc, this.a);
  final Uint8List kL;
  final Uint8List kR;
  final Uint8List cc;
  final Uint8List a;
}

BigInt _intLE(List<int> b) {
  var x = BigInt.zero;
  for (var i = b.length - 1; i >= 0; i--) {
    x = (x << 8) | BigInt.from(b[i] & 0xff);
  }
  return x;
}

Uint8List _toLE(BigInt n, int len) {
  final mask = BigInt.from(0xff);
  final out = Uint8List(len);
  var v = n;
  for (var i = 0; i < len; i++) {
    out[i] = (v & mask).toInt();
    v >>= 8;
  }
  return out;
}

Uint8List _ser32LE(int i) {
  final b = Uint8List(4);
  b[0] = i & 0xff;
  b[1] = (i >> 8) & 0xff;
  b[2] = (i >> 16) & 0xff;
  b[3] = (i >> 24) & 0xff;
  return b;
}

/// Icarus (CIP-3) master node from the BIP39 [entropy] (16-32 raw bytes).
Bip32Ed25519Node icarusMasterKey(List<int> entropy) {
  final mk = c.pbkdf2Sha512(const <int>[], c.toBytes(entropy), 4096, 96);
  final kL = Uint8List.fromList(mk.sublist(0, 32));
  final kR = Uint8List.fromList(mk.sublist(32, 64));
  final cc = Uint8List.fromList(mk.sublist(64, 96));
  kL[0] &= 0xF8;
  kL[31] &= 0x1F;
  kL[31] |= 0x40;
  final a = ed.scalarMulBase(kL);
  return Bip32Ed25519Node(kL, kR, cc, a);
}

/// Derive one child. Hardened when [index] >= 0x80000000. Keeps kL' as a full
/// 256-bit value (kL' = 8·int_LE(ZL) + int_LE(kL), serialized to 32B LE — NO
/// reduction mod L); kR' = (int_LE(ZR) + int_LE(kR)) mod 2^256.
Bip32Ed25519Node deriveChild(Bip32Ed25519Node node, int index) {
  final serI = _ser32LE(index);
  final Uint8List z;
  final Uint8List ccFull;
  if (index >= cardanoHardened) {
    z = c.hmacSha512(
        node.cc, c.concatBytes([const [0x00], node.kL, node.kR, serI]));
    ccFull = c.hmacSha512(
        node.cc, c.concatBytes([const [0x01], node.kL, node.kR, serI]));
  } else {
    z = c.hmacSha512(node.cc, c.concatBytes([const [0x02], node.a, serI]));
    ccFull = c.hmacSha512(node.cc, c.concatBytes([const [0x03], node.a, serI]));
  }
  final zl = z.sublist(0, 28);
  final zr = z.sublist(32, 64);
  final kLn = BigInt.from(8) * _intLE(zl) + _intLE(node.kL);
  final kRn = _intLE(zr) + _intLE(node.kR);
  final kL2 = _toLE(kLn, 32); // mod 2^256 via truncation to 32 bytes
  final kR2 = _toLE(kRn, 32);
  final cc2 = Uint8List.fromList(ccFull.sublist(32, 64));
  final a2 = ed.scalarMulBase(kL2);
  return Bip32Ed25519Node(kL2, kR2, cc2, a2);
}

/// Parse a CIP-1852 path like m/1852'/1815'/0'/0/0 into integer segments.
List<int> parseCardanoPath(String path) {
  final parts = path.split('/');
  if (parts[0] != 'm') throw ArgumentError("path must start with 'm'");
  return parts.sublist(1).map((p) {
    final hardened = p.endsWith("'") || p.endsWith('h') || p.endsWith('H');
    final n = int.parse(hardened ? p.substring(0, p.length - 1) : p);
    if (n < 0) throw ArgumentError('bad path segment: $p');
    return hardened ? (n + cardanoHardened) & 0xffffffff : n;
  }).toList();
}

/// Derive the node at [path] from the Icarus master built on [entropy].
Bip32Ed25519Node derivePath(List<int> entropy, String path) {
  var node = icarusMasterKey(entropy);
  for (final i in parseCardanoPath(path)) {
    node = deriveChild(node, i);
  }
  return node;
}
