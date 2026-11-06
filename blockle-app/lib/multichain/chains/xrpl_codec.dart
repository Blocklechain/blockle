// chains/xrpl_codec.dart — the XRP Ledger BINARY CODEC + classic-address codec,
// the serialization engine the XRP adapter (chains/xrp.dart) signs and submits.
// Mirrors ton_cell.dart's split: the pure codec lives here, the adapter there.
//
// Two independently-checkable pieces, both pinned by docs/xrp-vectors.json
// (cross-checked byte-identical against ripple-binary-codec / ripple-keypairs /
// xrpl-py):
//  • classic 'r…' address = ripple-base58check(0x00 || AccountID) where
//    AccountID = RIPEMD160(SHA256(compressed-pubkey)). Ripple's base58 alphabet
//    ('rpshna…') differs from Bitcoin's, so this is a SELF-CONTAINED base58 —
//    it does NOT reuse crypto_core's Bitcoin-alphabet base58.
//  • a Payment serialized with the canonical XRPL binary codec: fields emitted in
//    (type_code, field_code) order with the standard field-header + type
//    serializers (UInt16/UInt32/Amount-drops/Blob/AccountID). encodeForSigning
//    prepends the 0x53545800 'STX\0' prefix and omits TxnSignature; encode (full)
//    includes TxnSignature. The signing hash is SHA512-half of the signing
//    serialization; the tx hash is SHA512-half of 0x54584E00 'TXN\0' || signed.
//
// NOT post-quantum — the account key is secp256k1 (see crypto/secp256k1.dart).
import 'dart:typed_data';

import '../crypto/crypto_core.dart' as c;

/// Ripple's base58 dictionary (NOT the Bitcoin alphabet).
const String rippleAlphabet =
    'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';

/// 1 XRP = 1_000_000 drops (6 decimals).
const int drops = 1000000;
const String xrpDefaultPath = "m/44'/144'/0'/0/0";
const int _accountIdVersion = 0x00; // classic address version byte

// ---- ripple base58 (custom alphabet) ---------------------------------------
String _rippleBase58Encode(List<int> bytes) {
  final b = c.toBytes(bytes);
  var zeros = 0;
  while (zeros < b.length && b[zeros] == 0) {
    zeros++;
  }
  final digits = <int>[0];
  for (var i = zeros; i < b.length; i++) {
    var carry = b[i];
    for (var j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = carry ~/ 58;
    }
    while (carry > 0) {
      digits.add(carry % 58);
      carry = carry ~/ 58;
    }
  }
  final sb = StringBuffer();
  for (var i = 0; i < zeros; i++) {
    sb.write(rippleAlphabet[0]);
  }
  if (zeros < b.length) {
    for (var i = digits.length - 1; i >= 0; i--) {
      sb.write(rippleAlphabet[digits[i]]);
    }
  }
  return sb.toString();
}

Uint8List _rippleBase58Decode(String str) {
  final bytes = <int>[0];
  for (final ch in str.split('')) {
    final val = rippleAlphabet.indexOf(ch);
    if (val < 0) throw FormatException('invalid ripple-base58 char: $ch');
    var carry = val;
    for (var j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.add(carry & 0xff);
      carry >>= 8;
    }
  }
  var zeros = 0;
  for (final ch in str.split('')) {
    if (ch == rippleAlphabet[0]) {
      zeros++;
    } else {
      break;
    }
  }
  var n = bytes.length;
  if (n == 1 && bytes[0] == 0) n = 0;
  final out = Uint8List(zeros + n);
  for (var i = 0; i < n; i++) {
    out[zeros + i] = bytes[n - 1 - i];
  }
  return out;
}

String _rippleBase58Check(List<int> payload) {
  final b = c.toBytes(payload);
  final checksum = c.hash256(b).sublist(0, 4);
  return _rippleBase58Encode(c.concatBytes([b, checksum]));
}

Uint8List _rippleBase58CheckDecode(String str) {
  final full = _rippleBase58Decode(str);
  if (full.length < 5) throw const FormatException('ripple address too short');
  final payload = full.sublist(0, full.length - 4);
  final checksum = full.sublist(full.length - 4);
  final expect = c.hash256(payload).sublist(0, 4);
  for (var i = 0; i < 4; i++) {
    if (checksum[i] != expect[i]) {
      throw const FormatException('bad ripple base58check checksum');
    }
  }
  return payload;
}

// ---- address codec ---------------------------------------------------------
/// AccountID = RIPEMD160(SHA256(compressed-pubkey)).
Uint8List accountIdFromPubkey(List<int> pub) => c.hash160(c.toBytes(pub));

/// Classic 'r…' address from a 20-byte AccountID.
String classicAddressFromAccountId(List<int> accountId) {
  final id = c.toBytes(accountId);
  if (id.length != 20) throw ArgumentError('accountId must be 20 bytes');
  return _rippleBase58Check(c.concatBytes([
    Uint8List.fromList([_accountIdVersion]),
    id,
  ]));
}

/// Classic 'r…' address from a compressed public key.
String classicAddressFromPubkey(List<int> pub) =>
    classicAddressFromAccountId(accountIdFromPubkey(pub));

/// 20-byte AccountID from an 'r…' classic address (throws on bad checksum/form).
Uint8List accountIdFromAddress(String address) {
  final payload = _rippleBase58CheckDecode(address.trim());
  if (payload.length != 21 || payload[0] != _accountIdVersion) {
    throw const FormatException('not a classic XRP address');
  }
  return Uint8List.fromList(payload.sublist(1));
}

/// Validate an 'r…' classic XRP address.
bool isXrpAddress(String address) {
  final a = address.trim();
  if (!a.startsWith('r')) return false;
  try {
    accountIdFromAddress(a);
    return true;
  } catch (_) {
    return false;
  }
}

// ---- binary codec ----------------------------------------------------------
class _Writer {
  final BytesBuilder _b = BytesBuilder();
  void u8(int v) => _b.addByte(v & 0xff);
  void add(List<int> bytes) => _b.add(bytes);
  Uint8List bytes() => _b.toBytes();
}

/// Canonical field header for (typeCode, fieldCode). Matches rippled's encoding.
void _fieldHeader(_Writer w, int type, int field) {
  if (type < 16) {
    if (field < 16) {
      w.u8((type << 4) | field);
    } else {
      w.u8(type << 4);
      w.u8(field);
    }
  } else if (field < 16) {
    w.u8(field);
    w.u8(type);
  } else {
    w.u8(0);
    w.u8(type);
    w.u8(field);
  }
}

void _u16(_Writer w, int v) {
  w.u8((v >> 8) & 0xff);
  w.u8(v & 0xff);
}

void _u32(_Writer w, int v) {
  w.u8((v >> 24) & 0xff);
  w.u8((v >> 16) & 0xff);
  w.u8((v >> 8) & 0xff);
  w.u8(v & 0xff);
}

/// XRP native Amount (drops): 64-bit BE, positive-XRP top bits (0x40.. set).
void _amountDrops(_Writer w, String dropsStr) {
  final v = BigInt.parse(dropsStr);
  if (v < BigInt.zero) throw ArgumentError('negative drops');
  final encoded = v | (BigInt.one << 62); // "not XRP"=0, sign(positive)=1
  final out = Uint8List(8);
  var x = encoded;
  for (var i = 7; i >= 0; i--) {
    out[i] = (x & BigInt.from(0xff)).toInt();
    x >>= 8;
  }
  w.add(out);
}

/// XRPL variable-length prefix (len <= 192 is a single byte — all our fields).
void _vlLength(_Writer w, int len) {
  if (len <= 192) {
    w.u8(len);
  } else if (len <= 12480) {
    final l = len - 193;
    w.u8(193 + (l >> 8));
    w.u8(l & 0xff);
  } else {
    throw ArgumentError('vl length too large: $len');
  }
}

void _blob(_Writer w, List<int> bytes) {
  _vlLength(w, bytes.length);
  w.add(bytes);
}

void _accountId(_Writer w, List<int> accountId20) {
  _vlLength(w, accountId20.length); // 20 -> 0x14
  w.add(accountId20);
}

/// The inputs of a Payment serialization (native XRP).
class XrpPayment {
  XrpPayment({
    required this.accountId,
    required this.destinationAccountId,
    required this.amountDrops,
    required this.feeDrops,
    required this.sequence,
    required this.flags,
    required this.lastLedgerSequence,
    required this.signingPubKey,
    this.destinationTag,
  });
  final Uint8List accountId; // 20
  final Uint8List destinationAccountId; // 20
  final String amountDrops;
  final String feeDrops;
  final int sequence;
  final int flags;
  final int lastLedgerSequence;
  final Uint8List signingPubKey; // 33 compressed
  final int? destinationTag;
}

/// Serialize the Payment's fields in canonical (type,field) order. When
/// [txnSignature] is null the SigningPubKey is still present but TxnSignature is
/// omitted (the signing form). The 'STX\0' prefix is NOT added here.
Uint8List serializePayment(XrpPayment p, {Uint8List? txnSignature}) {
  final w = _Writer();
  // (1,2) TransactionType UInt16 — Payment = 0
  _fieldHeader(w, 1, 2);
  _u16(w, 0);
  // (2,2) Flags
  _fieldHeader(w, 2, 2);
  _u32(w, p.flags);
  // (2,4) Sequence
  _fieldHeader(w, 2, 4);
  _u32(w, p.sequence);
  // (2,14) DestinationTag (optional)
  if (p.destinationTag != null) {
    _fieldHeader(w, 2, 14);
    _u32(w, p.destinationTag!);
  }
  // (2,27) LastLedgerSequence
  _fieldHeader(w, 2, 27);
  _u32(w, p.lastLedgerSequence);
  // (6,1) Amount
  _fieldHeader(w, 6, 1);
  _amountDrops(w, p.amountDrops);
  // (6,8) Fee
  _fieldHeader(w, 6, 8);
  _amountDrops(w, p.feeDrops);
  // (7,3) SigningPubKey
  _fieldHeader(w, 7, 3);
  _blob(w, p.signingPubKey);
  // (7,4) TxnSignature (full form only)
  if (txnSignature != null) {
    _fieldHeader(w, 7, 4);
    _blob(w, txnSignature);
  }
  // (8,1) Account
  _fieldHeader(w, 8, 1);
  _accountId(w, p.accountId);
  // (8,3) Destination
  _fieldHeader(w, 8, 3);
  _accountId(w, p.destinationAccountId);
  return w.bytes();
}

const int _stxPrefix = 0x53545800; // 'STX\0' — single-sign prefix
const int _txnPrefix = 0x54584E00; // 'TXN\0' — tx-hash prefix

/// The bytes that get SHA512-half'd + signed: 'STX\0' || payment-without-sig.
Uint8List signingData(XrpPayment p) {
  final w = _Writer();
  _u32(w, _stxPrefix);
  w.add(serializePayment(p));
  return w.bytes();
}

/// SHA512-half (first 32 bytes of SHA512) — the XRPL signing hash.
Uint8List sha512Half(List<int> bytes) =>
    Uint8List.fromList(c.sha512(bytes).sublist(0, 32));

/// The full signed tx_blob bytes (with TxnSignature).
Uint8List signedBlob(XrpPayment p, Uint8List txnSignature) =>
    serializePayment(p, txnSignature: txnSignature);

/// The transaction hash: SHA512-half('TXN\0' || signed blob), UPPERCASE hex.
String txHash(Uint8List signedBlobBytes) {
  final w = _Writer();
  _u32(w, _txnPrefix);
  w.add(signedBlobBytes);
  return c.bytesToHex(sha512Half(w.bytes())).toUpperCase();
}
