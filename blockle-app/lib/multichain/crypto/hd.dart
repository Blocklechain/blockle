// hd.dart — BIP39 mnemonic + BIP32 hierarchical-deterministic derivation for
// the secp256k1 chains (EVM + BTC/LTC/DOGE). The BIP39 seed is the HD root
// stored in the vault; each chain derives its account via a BIP44/BIP84 path.
//
// Ported from the extension's hd.js; validated against BIP39 (Trezor) and
// BIP32 Test Vector 1.
import 'dart:math';
import 'dart:typed_data';

import 'bip39_wordlist.dart';
import 'crypto_core.dart' as c;
import 'secp256k1.dart' as s;

const int hardened = 0x80000000;

// ---- BIP39 -----------------------------------------------------------------
String entropyToMnemonic(List<int> entropy) {
  final ent = c.toBytes(entropy);
  if (ent.length % 4 != 0 || ent.length < 16 || ent.length > 32) {
    throw ArgumentError('bad entropy length');
  }
  final hash = c.sha256(ent);
  final csBits = (ent.length * 8) ~/ 32;
  final bits = StringBuffer();
  for (final b in ent) {
    bits.write(b.toRadixString(2).padLeft(8, '0'));
  }
  final csByteBits = StringBuffer();
  for (final b in hash) {
    csByteBits.write(b.toRadixString(2).padLeft(8, '0'));
  }
  final all = bits.toString() + csByteBits.toString().substring(0, csBits);
  final words = <String>[];
  for (var i = 0; i < all.length; i += 11) {
    words.add(bip39Wordlist[int.parse(all.substring(i, i + 11), radix: 2)]);
  }
  return words.join(' ');
}

String generateMnemonic({int strength = 128}) {
  if (strength % 32 != 0) throw ArgumentError('strength must be multiple of 32');
  final rng = Random.secure();
  final ent = Uint8List(strength ~/ 8);
  for (var i = 0; i < ent.length; i++) {
    ent[i] = rng.nextInt(256);
  }
  return entropyToMnemonic(ent);
}

Uint8List mnemonicToEntropy(String mnemonic) {
  final words = mnemonic.trim().split(RegExp(r'\s+'));
  if (![12, 15, 18, 21, 24].contains(words.length)) {
    throw ArgumentError('bad mnemonic word count');
  }
  final bits = StringBuffer();
  for (final w in words) {
    final idx = bip39Wordlist.indexOf(w);
    if (idx < 0) throw ArgumentError('unknown word: $w');
    bits.write(idx.toRadixString(2).padLeft(11, '0'));
  }
  final bitStr = bits.toString();
  final csBits = words.length ~/ 3;
  final entBits = bitStr.length - csBits;
  final entropy = Uint8List(entBits ~/ 8);
  for (var i = 0; i < entropy.length; i++) {
    entropy[i] = int.parse(bitStr.substring(i * 8, i * 8 + 8), radix: 2);
  }
  final hash = c.sha256(entropy);
  final csCheck = StringBuffer();
  for (final b in hash) {
    csCheck.write(b.toRadixString(2).padLeft(8, '0'));
  }
  if (bitStr.substring(entBits) != csCheck.toString().substring(0, csBits)) {
    throw ArgumentError('invalid mnemonic checksum');
  }
  return entropy;
}

bool validateMnemonic(String mnemonic) {
  try {
    mnemonicToEntropy(mnemonic);
    return true;
  } catch (_) {
    return false;
  }
}

Uint8List mnemonicToSeed(String mnemonic, [String passphrase = '']) {
  final mn = c.utf8Bytes(mnemonic);
  final salt = c.utf8Bytes('mnemonic$passphrase');
  return c.pbkdf2Sha512(mn, salt, 2048, 64);
}

// ---- BIP32 -----------------------------------------------------------------
class HdNode {
  HdNode({
    required this.privateKey,
    required this.publicKey,
    required this.chainCode,
    required this.depth,
    required this.index,
    required this.parentFingerprint,
  });

  final Uint8List? privateKey;
  final Uint8List publicKey;
  final Uint8List chainCode;
  final int depth;
  final int index;
  final Uint8List parentFingerprint;
}

HdNode masterFromSeed(List<int> seed) {
  final i = c.hmacSha512(c.utf8Bytes('Bitcoin seed'), c.toBytes(seed));
  final il = Uint8List.fromList(i.sublist(0, 32));
  final ir = Uint8List.fromList(i.sublist(32));
  final d = s.bytesToBig(il);
  if (d == BigInt.zero || !s.isValidPrivate(d)) {
    throw StateError('invalid master key');
  }
  return HdNode(
    privateKey: il,
    publicKey: s.publicKey(il),
    chainCode: ir,
    depth: 0,
    index: 0,
    parentFingerprint: Uint8List(4),
  );
}

Uint8List _fingerprint(HdNode node) =>
    Uint8List.fromList(c.hash160(node.publicKey).sublist(0, 4));

Uint8List _ser32(int i) {
  final b = Uint8List(4);
  ByteData.view(b.buffer).setUint32(0, i & 0xffffffff, Endian.big);
  return b;
}

HdNode deriveChild(HdNode node, int index) {
  final isHardened = index >= hardened;
  Uint8List data;
  if (isHardened) {
    if (node.privateKey == null) {
      throw StateError('cannot derive hardened from public node');
    }
    data = c.concatBytes([
      Uint8List.fromList([0x00]),
      node.privateKey!,
      _ser32(index),
    ]);
  } else {
    data = c.concatBytes([node.publicKey, _ser32(index)]);
  }
  final i = c.hmacSha512(node.chainCode, data);
  final il = Uint8List.fromList(i.sublist(0, 32));
  final ir = Uint8List.fromList(i.sublist(32));
  if (s.bytesToBig(il) >= s.n) return deriveChild(node, index + 1);
  if (node.privateKey != null) {
    Uint8List childPriv;
    try {
      childPriv = s.privAdd(node.privateKey!, il);
    } catch (_) {
      return deriveChild(node, index + 1);
    }
    return HdNode(
      privateKey: childPriv,
      publicKey: s.publicKey(childPriv),
      chainCode: ir,
      depth: node.depth + 1,
      index: index,
      parentFingerprint: _fingerprint(node),
    );
  } else {
    Uint8List childPub;
    try {
      childPub = s.pointAddScalar(node.publicKey, il);
    } catch (_) {
      return deriveChild(node, index + 1);
    }
    return HdNode(
      privateKey: null,
      publicKey: childPub,
      chainCode: ir,
      depth: node.depth + 1,
      index: index,
      parentFingerprint: _fingerprint(node),
    );
  }
}

List<int> parsePath(String path) {
  final parts = path.split('/');
  if (parts[0] != 'm') throw ArgumentError("path must start with 'm'");
  return parts.sublist(1).map((p) {
    final isHardened = p.endsWith("'") || p.endsWith('h') || p.endsWith('H');
    final n = int.parse(isHardened ? p.substring(0, p.length - 1) : p);
    if (n < 0) throw ArgumentError('bad path segment: $p');
    return isHardened ? (n + hardened) & 0xffffffff : n;
  }).toList();
}

HdNode derivePath(dynamic seedOrNode, String path) {
  var node = seedOrNode is HdNode ? seedOrNode : masterFromSeed(seedOrNode);
  for (final index in parsePath(path)) {
    node = deriveChild(node, index);
  }
  return node;
}

/// xprv/xpub Base58Check serialization (mainnet version bytes) — export/debug.
String serialize(HdNode node, bool pub, [String? versionHex]) {
  final vh = versionHex ?? (pub ? '0488b21e' : '0488ade4');
  final version = c.hexToBytes(vh);
  final depth = Uint8List.fromList([node.depth & 0xff]);
  final parentFp = node.parentFingerprint;
  final childIndex = _ser32(node.index);
  final key = pub
      ? node.publicKey
      : c.concatBytes([
          Uint8List.fromList([0x00]),
          node.privateKey!,
        ]);
  return c.base58checkEncode(
      c.concatBytes([version, depth, parentFp, childIndex, node.chainCode, key]));
}
