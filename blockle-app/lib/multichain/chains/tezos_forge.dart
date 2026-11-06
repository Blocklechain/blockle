// chains/tezos_forge.dart — the Tezos binary-codec engine: a self-contained,
// NETWORK-FREE forge/zarith/pkh/contract-id codec that both the adapter
// (tezos.dart) and the golden-vector test call. The Tezos analogue of
// ton_cell.dart (BOC) and stellar_xdr.dart (XDR).
//
// CRITICAL (fund-safety): the client forges the WHOLE operation here; the node
// supplies ONLY the branch (a verifiable head-block hash) and the per-account
// counter (verifiable) — there is no node-assembles-payload trust surface, the
// same posture the TON and Stellar adapters document.
//
// Cross-checked BYTE-IDENTICAL against @taquito/local-forging + @taquito/signer
// (docs/tezos-vectors.json). Pure bytes only — no network, no key material.
import 'dart:typed_data';

import '../crypto/crypto_core.dart' as c;

// ---- Tezos base58check prefix bytes ----------------------------------------
const List<int> tz1Prefix = [6, 161, 159]; // tz1 (ed25519 pkh)   0x06A19F
const List<int> tz2Prefix = [6, 161, 161]; // tz2 (secp256k1 pkh)
const List<int> tz3Prefix = [6, 161, 164]; // tz3 (p256 pkh)
const List<int> kt1Prefix = [2, 90, 121]; // KT1 (originated contract)
const List<int> edpkPrefix = [13, 15, 37, 217]; // edpk (ed25519 public key)
const List<int> edskSeedPrefix = [13, 15, 58, 7]; // edsk (ed25519 32-byte SEED)
const List<int> edsigPrefix = [9, 245, 205, 134, 18]; // edsig (ed25519 sig)
const List<int> blockHashPrefix = [1, 52]; // B… block hash

/// Operation signing watermark for a generic (manager) operation.
const int watermarkGeneric = 0x03;

/// Manager-operation tag for a `transaction`.
const int transactionTag = 0x6c;

// ---- base58check wrappers ---------------------------------------------------
String _b58(List<int> prefix, List<int> raw) =>
    c.base58checkEncode(c.concatBytes([prefix, raw]));

/// edpk… base58 for a 32-byte ed25519 public key.
String edpk(List<int> pub32) => _b58(edpkPrefix, pub32);

/// edsig… base58 for a 64-byte ed25519 signature.
String edsig(List<int> sig64) => _b58(edsigPrefix, sig64);

/// edsk… base58 SECRET KEY (the 32-byte SEED form other Tezos wallets import).
String edskFromSeed(List<int> seed32) => _b58(edskSeedPrefix, seed32);

/// tz1… address = base58check([6,161,159] || blake2b(pub, 20)).
String tz1FromPublicKey(List<int> pub32) =>
    _b58(tz1Prefix, c.blake2b(pub32, outLen: 20));

// ---- zarith (unsigned base-128 LEB128 varint) ------------------------------
/// Unsigned LEB128 for a non-negative [n]. Used for fee/counter/gas_limit/
/// storage_limit/amount (all mutez, 6 dp). BigInt only — never floats.
Uint8List zarith(BigInt n) {
  if (n < BigInt.zero) throw ArgumentError('zarith: negative');
  final out = <int>[];
  var v = n;
  final mask = BigInt.from(0x7f);
  while (v >= BigInt.from(0x80)) {
    out.add(((v & mask).toInt()) | 0x80);
    v >>= 7;
  }
  out.add(v.toInt());
  return Uint8List.fromList(out);
}

Uint8List zarithInt(int n) => zarith(BigInt.from(n));

// ---- public-key-hash + contract-id encodings -------------------------------
/// The 20-byte hash body of an implicit (tzN) address: base58check-decode, strip
/// the 3-byte prefix.
Uint8List pkhHash20(String address) {
  final dec = c.base58checkDecode(address);
  final body = dec.sublist(3);
  if (body.length != 20) {
    throw FormatException('tezos: bad pkh length ${body.length} for $address');
  }
  return Uint8List.fromList(body);
}

/// 1-byte curve tag for an implicit address: tz1=0x00, tz2=0x01, tz3=0x02.
int _curveTag(String address) {
  if (address.startsWith('tz1')) return 0x00;
  if (address.startsWith('tz2')) return 0x01;
  if (address.startsWith('tz3')) return 0x02;
  throw FormatException('tezos: not an implicit (tzN) address: $address');
}

/// public-key-hash encoding: 1-byte curve tag + 20-byte hash (21 bytes). The
/// `source` of a manager operation is encoded this way.
Uint8List publicKeyHash(String address) =>
    c.concatBytes([Uint8List.fromList([_curveTag(address)]), pkhHash20(address)]);

/// Contract-id (destination) encoding:
///   implicit (tz1/tz2/tz3): 0x00 || publicKeyHash (0x00||tag? no — 0x00 marker
///     + curve-tag + 20B) = [0x00, curveTag, …20B] (22 bytes);
///   originated (KT1):       0x01 || blake2b160(decoded) || 0x00 pad (22 bytes).
Uint8List contractId(String dest) {
  if (dest.startsWith('KT1')) {
    final dec = c.base58checkDecode(dest);
    final body = dec.sublist(3);
    if (body.length != 20) {
      throw FormatException('tezos: bad KT1 length ${body.length}');
    }
    return c.concatBytes([
      Uint8List.fromList([0x01]),
      body,
      Uint8List.fromList([0x00]),
    ]);
  }
  return c.concatBytes([Uint8List.fromList([0x00]), publicKeyHash(dest)]);
}

/// Validate a destination this wallet accepts: tz1/tz2/tz3 implicit or KT1
/// originated. (We ISSUE tz1 only, but SEND accepts all four.)
bool isTezosDestination(String addr) {
  final ok = addr.startsWith('tz1') ||
      addr.startsWith('tz2') ||
      addr.startsWith('tz3') ||
      addr.startsWith('KT1');
  if (!ok) return false;
  try {
    final dec = c.base58checkDecode(addr);
    return dec.length - (addr.startsWith('KT1') ? 3 : 3) == 20;
  } catch (_) {
    return false;
  }
}

/// Validate a tz1 address: base58check with the tz1 prefix + 20-byte body.
bool isTz1Address(String addr) {
  if (!RegExp(r'^tz1[1-9A-HJ-NP-Za-km-z]{33}$').hasMatch(addr)) return false;
  try {
    final dec = c.base58checkDecode(addr);
    return dec.length == 23 &&
        dec[0] == tz1Prefix[0] &&
        dec[1] == tz1Prefix[1] &&
        dec[2] == tz1Prefix[2];
  } catch (_) {
    return false;
  }
}

/// Fields of a single `transaction` manager operation (all amounts are decimal
/// mutez strings; counter is the per-account counter the op will carry).
class TezosTxFields {
  const TezosTxFields({
    required this.branch,
    required this.source,
    required this.fee,
    required this.counter,
    required this.gasLimit,
    required this.storageLimit,
    required this.amount,
    required this.destination,
  });
  final String branch;
  final String source;
  final String fee;
  final String counter;
  final String gasLimit;
  final String storageLimit;
  final String amount;
  final String destination;
}

/// Decode a branch (B…) block hash to its 32 raw bytes.
Uint8List branchBytes(String branch) {
  final dec = c.base58checkDecode(branch);
  final body = dec.sublist(blockHashPrefix.length);
  if (body.length != 32) {
    throw FormatException('tezos: bad branch length ${body.length}');
  }
  return Uint8List.fromList(body);
}

/// Forge a single `transaction` manager operation to its raw bytes (NO
/// watermark, NO signature):
///   branch(32) || 0x6c || pkh(source) || zarith fee || zarith counter ||
///   zarith gas_limit || zarith storage_limit || zarith amount ||
///   contractId(destination) || 0x00 (no params).
Uint8List forgeTransactionBytes(TezosTxFields f) {
  BigInt z(String s) => BigInt.parse(s);
  return c.concatBytes([
    branchBytes(f.branch),
    Uint8List.fromList([transactionTag]),
    publicKeyHash(f.source),
    zarith(z(f.fee)),
    zarith(z(f.counter)),
    zarith(z(f.gasLimit)),
    zarith(z(f.storageLimit)),
    zarith(z(f.amount)),
    contractId(f.destination),
    Uint8List.fromList([0x00]),
  ]);
}

/// Forge a transaction and return the lowercase hex string.
String forgeTransaction(TezosTxFields f) =>
    c.bytesToHex(forgeTransactionBytes(f));

/// The 32-byte signing hash: blake2b(0x03 || forged, 32).
Uint8List signingBytes(List<int> forged) =>
    c.blake2b(c.concatBytes([
      Uint8List.fromList([watermarkGeneric]),
      forged,
    ]), outLen: 32);

/// Signing hash from a forged-hex string.
Uint8List signingBytesFromHex(String forgedHex) =>
    signingBytes(c.hexToBytes(forgedHex));
