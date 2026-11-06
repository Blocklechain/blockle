// chains/stellar_xdr.dart — the Stellar STRKEY codec + the XDR serializer for a
// TransactionEnvelope (v1) carrying one Payment op. Mirrors ton_cell.dart's
// split: the pure codec lives here, the adapter in chains/stellar.dart.
//
// Pinned byte-for-byte by docs/stellar-vectors.json (cross-checked against
// js-stellar-base / stellar-sdk):
//  • strkey 'G…' = base32(0x30 || ed25519-pub(32) || crc16-xmodem(2, LE)), no
//    padding, uppercase. CRC16/XMODEM (poly 0x1021, init 0) is the SAME algorithm
//    TON uses (ton_cell crc16Ccitt), only appended little-endian here.
//  • a TransactionV1 struct + TransactionEnvelope(ENVELOPE_TYPE_TX=2) with a
//    single native-XLM or AlphaNum4-asset Payment op, serialized with Stellar
//    XDR (big-endian, 4-byte aligned). The signing hash is
//    SHA256(networkId || ENVELOPE_TYPE_TX || txXDR); the ed25519 signature + the
//    4-byte key hint go in signatures[].
//
// NOT post-quantum — ed25519 (see crypto/ed25519.dart). Ported from stellar.js.
import 'dart:convert';
import 'dart:typed_data';

import '../crypto/crypto_core.dart' as c;

/// 1 XLM = 1e7 stroops (7 decimals).
const int stroop = 10000000;
const String stellarDefaultPath = "m/44'/148'/0'";
const String publicNetworkPassphrase =
    'Public Global Stellar Network ; September 2015';
const int _versionByteEd25519 = 6 << 3; // 0x30 — strkey 'G…'
const int envelopeTypeTx = 2;

// ---- base32 (RFC 4648, no padding) -----------------------------------------
const String _b32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

String _base32Encode(List<int> data) {
  final b = c.toBytes(data);
  final sb = StringBuffer();
  var bits = 0, value = 0;
  for (final byte in b) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      sb.write(_b32[(value >> bits) & 0x1f]);
    }
  }
  if (bits > 0) {
    sb.write(_b32[(value << (5 - bits)) & 0x1f]);
  }
  return sb.toString();
}

Uint8List _base32Decode(String str) {
  final out = <int>[];
  var bits = 0, value = 0;
  for (final ch in str.toUpperCase().split('')) {
    final idx = _b32.indexOf(ch);
    if (idx < 0) throw FormatException('invalid base32 char: $ch');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.add((value >> bits) & 0xff);
    }
  }
  return Uint8List.fromList(out);
}

// ---- CRC16/XMODEM (poly 0x1021, init 0x0000) — Stellar appends little-endian --
int crc16Xmodem(List<int> bytes) {
  var crc = 0;
  for (final byte in bytes) {
    crc ^= byte << 8;
    for (var b = 0; b < 8; b++) {
      crc = (crc & 0x8000) != 0 ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc & 0xffff;
}

// ---- strkey ----------------------------------------------------------------
/// 'G…' strkey from a 32-byte ed25519 public key.
String strkeyEncodeEd25519(List<int> pub) {
  final p = c.toBytes(pub);
  if (p.length != 32) throw ArgumentError('ed25519 pubkey must be 32 bytes');
  final payload = c.concatBytes([
    Uint8List.fromList([_versionByteEd25519]),
    p,
  ]);
  final crc = crc16Xmodem(payload);
  final full = c.concatBytes([
    payload,
    Uint8List.fromList([crc & 0xff, (crc >> 8) & 0xff]), // little-endian
  ]);
  return _base32Encode(full);
}

/// 32-byte ed25519 public key from a 'G…' strkey (throws on bad version/CRC).
Uint8List strkeyDecodeEd25519(String address) {
  final full = _base32Decode(address.trim());
  if (full.length != 35) throw const FormatException('bad strkey length');
  if (full[0] != _versionByteEd25519) {
    throw const FormatException('not an ed25519 public strkey');
  }
  final payload = full.sublist(0, 33);
  final crc = crc16Xmodem(payload);
  if (full[33] != (crc & 0xff) || full[34] != ((crc >> 8) & 0xff)) {
    throw const FormatException('bad strkey crc');
  }
  return Uint8List.fromList(full.sublist(1, 33));
}

/// Validate a 'G…' Stellar address.
bool isStellarAddress(String address) {
  final a = address.trim();
  if (!a.startsWith('G') || a.length != 56) return false;
  try {
    strkeyDecodeEd25519(a);
    return true;
  } catch (_) {
    return false;
  }
}

// ---- XDR writer ------------------------------------------------------------
class _Xdr {
  final BytesBuilder _b = BytesBuilder();
  void u32(int v) {
    _b.addByte((v >> 24) & 0xff);
    _b.addByte((v >> 16) & 0xff);
    _b.addByte((v >> 8) & 0xff);
    _b.addByte(v & 0xff);
  }

  void i64(BigInt v) {
    final out = Uint8List(8);
    var x = v & ((BigInt.one << 64) - BigInt.one);
    for (var i = 7; i >= 0; i--) {
      out[i] = (x & BigInt.from(0xff)).toInt();
      x >>= 8;
    }
    _b.add(out);
  }

  void u64(BigInt v) => i64(v);
  void raw(List<int> bytes) => _b.add(bytes);

  /// Opaque variable-length: 4-byte length + bytes + 4-byte alignment padding.
  void opaqueVar(List<int> bytes) {
    u32(bytes.length);
    _b.add(bytes);
    final pad = (4 - (bytes.length % 4)) % 4;
    for (var i = 0; i < pad; i++) {
      _b.addByte(0);
    }
  }

  Uint8List bytes() => _b.toBytes();
}

/// A Stellar asset: native XLM, or an AlphaNum4 issued asset {code, issuer}.
class StellarAsset {
  const StellarAsset.native()
      : code = null,
        issuerPub = null;
  const StellarAsset.alphaNum4(this.code, this.issuerPub);
  final String? code; // 1..4 chars
  final Uint8List? issuerPub; // 32-byte ed25519 pubkey of the issuer
  bool get isNative => code == null;
}

void _putMuxedEd25519(_Xdr w, List<int> pub32) {
  w.u32(0); // CryptoKeyType KEY_TYPE_ED25519 / account type
  w.raw(pub32);
}

void _putAsset(_Xdr w, StellarAsset asset) {
  if (asset.isNative) {
    w.u32(0); // ASSET_TYPE_NATIVE
    return;
  }
  w.u32(1); // ASSET_TYPE_CREDIT_ALPHANUM4
  final code = asset.code!;
  final buf = Uint8List(4);
  final cb = c.utf8Bytes(code);
  for (var i = 0; i < cb.length && i < 4; i++) {
    buf[i] = cb[i];
  }
  w.raw(buf);
  _putMuxedEd25519(w, asset.issuerPub!); // issuer AccountID (PublicKey)
}

/// Inputs for a single-Payment TransactionV1.
class StellarPayment {
  StellarPayment({
    required this.sourcePub,
    required this.destPub,
    required this.sequence,
    required this.fee,
    required this.amountStroops,
    this.asset = const StellarAsset.native(),
  });
  final Uint8List sourcePub; // 32
  final Uint8List destPub; // 32
  final BigInt sequence;
  final int fee;
  final String amountStroops;
  final StellarAsset asset;
}

/// Serialize the Transaction (v1) struct — the body the signature covers.
Uint8List serializeTransaction(StellarPayment p) {
  final w = _Xdr();
  _putMuxedEd25519(w, p.sourcePub); // sourceAccount (MuxedAccount)
  w.u32(p.fee);
  w.i64(p.sequence);
  w.u32(0); // cond: Preconditions = PRECOND_NONE (no timebounds — pinned)
  w.u32(0); // memo: MEMO_NONE
  w.u32(1); // operations.length = 1
  // Operation
  w.u32(0); // op.sourceAccount present? 0 = none
  w.u32(1); // op.body type = PAYMENT
  _putMuxedEd25519(w, p.destPub); // destination (MuxedAccount)
  _putAsset(w, p.asset);
  w.i64(BigInt.parse(p.amountStroops));
  w.u32(0); // Transaction.ext v = 0
  return w.bytes();
}

/// networkId = SHA256(network passphrase).
Uint8List networkId([String passphrase = publicNetworkPassphrase]) =>
    c.sha256(c.utf8Bytes(passphrase));

/// The signature base: networkId || ENVELOPE_TYPE_TX || txXDR.
Uint8List signatureBase(Uint8List txXdr, [String? passphrase]) {
  final w = _Xdr();
  w.raw(networkId(passphrase ?? publicNetworkPassphrase));
  w.u32(envelopeTypeTx);
  w.raw(txXdr);
  return w.bytes();
}

/// The transaction hash = SHA256(signatureBase) — also the ed25519 signing msg.
Uint8List txHashBytes(Uint8List txXdr, [String? passphrase]) =>
    c.sha256(signatureBase(txXdr, passphrase));

/// The full signed TransactionEnvelope (v1): discriminant || tx || signatures[].
/// [hint] is the last 4 bytes of the signer's public key.
Uint8List serializeEnvelope(
    Uint8List txXdr, Uint8List hint, Uint8List signature) {
  final w = _Xdr();
  w.u32(envelopeTypeTx);
  w.raw(txXdr);
  w.u32(1); // signatures.length = 1
  w.raw(hint); // SignatureHint (4 bytes, fixed)
  w.opaqueVar(signature); // Signature (opaque<64>)
  return w.bytes();
}

/// Base64 (standard, padded) of arbitrary bytes.
String toBase64(List<int> bytes) => base64.encode(c.toBytes(bytes));

/// Decode standard base64 to bytes.
Uint8List fromBase64(String b64) => base64.decode(b64);
