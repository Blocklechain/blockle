// eip712.dart — EIP-712 typed-structured-data hashing (the signing digest for
// eth_signTypedData_v4 / _v3). This is what Uniswap's Permit2 approvals and most
// "sign to trade" flows use. PURE: no network, no keys. The returned 32-byte
// digest is signed with the wallet's secp256k1 key (0x1901-prefixed), exactly
// per https://eips.ethereum.org/EIPS/eip-712.
import 'dart:typed_data';

import '../crypto/crypto_core.dart' as c;

/// The 32-byte EIP-712 signing digest for a typed-data object
/// `{types, primaryType, domain, message}`. Sign this with secp256k1.
Uint8List eip712Digest(Map<String, dynamic> td) {
  final types = <String, List<Map<String, dynamic>>>{};
  (td['types'] as Map).forEach((k, v) {
    types['$k'] = (v as List).map((e) => (e as Map).cast<String, dynamic>()).toList();
  });
  final domainSep = _hashStruct('EIP712Domain', td['domain'] as Map, types);
  final primaryType = '${td['primaryType']}';
  final structHash = _hashStruct(primaryType, td['message'] as Map, types);
  return c.keccak256(<int>[0x19, 0x01, ...domainSep, ...structHash]);
}

// ---- type encoding ---------------------------------------------------------

/// The canonical `encodeType` string: the primary type, then every referenced
/// struct type sorted alphabetically.
String _encodeType(String primary, Map<String, List<Map<String, dynamic>>> types) {
  final deps = <String>{};
  void collect(String t) {
    final base = t.replaceAll(RegExp(r'\[\d*\]$'), '');
    if (!types.containsKey(base) || deps.contains(base)) return;
    deps.add(base);
    for (final f in types[base]!) {
      collect('${f['type']}');
    }
  }

  collect(primary);
  deps.remove(primary);
  final ordered = [primary, ...(deps.toList()..sort())];
  final sb = StringBuffer();
  for (final t in ordered) {
    sb.write(t);
    sb.write('(');
    sb.write(types[t]!.map((f) => '${f['type']} ${f['name']}').join(','));
    sb.write(')');
  }
  return sb.toString();
}

Uint8List _typeHash(String primary, Map<String, List<Map<String, dynamic>>> types) =>
    c.keccak256(c.utf8Bytes(_encodeType(primary, types)));

Uint8List _hashStruct(
    String type, Map data, Map<String, List<Map<String, dynamic>>> types) {
  final out = <int>[];
  out.addAll(_typeHash(type, types));
  for (final field in types[type]!) {
    out.addAll(_encodeValue('${field['type']}', data['${field['name']}'], types));
  }
  return c.keccak256(out);
}

/// Encode one field value to its 32-byte (or hashed) EIP-712 form.
List<int> _encodeValue(
    String type, dynamic value, Map<String, List<Map<String, dynamic>>> types) {
  // arrays: keccak of the concatenated encoded elements
  final arr = RegExp(r'^(.*)\[(\d*)\]$').firstMatch(type);
  if (arr != null) {
    final inner = arr.group(1)!;
    final items = (value as List?) ?? const [];
    final buf = <int>[];
    for (final it in items) {
      buf.addAll(_encodeValue(inner, it, types));
    }
    return c.keccak256(buf);
  }
  // referenced struct: hashStruct recursively
  if (types.containsKey(type)) {
    return _hashStruct(type, value as Map, types);
  }
  // dynamic bytes / string: keccak of the raw bytes
  if (type == 'string') {
    return c.keccak256(c.utf8Bytes('${value ?? ''}'));
  }
  if (type == 'bytes') {
    return c.keccak256(_bytes('$value'));
  }
  // bytes1..bytes32 (fixed): right-padded to 32
  final fb = RegExp(r'^bytes(\d+)$').firstMatch(type);
  if (fb != null) {
    final b = _bytes('$value');
    final out = Uint8List(32);
    for (var i = 0; i < b.length && i < 32; i++) {
      out[i] = b[i];
    }
    return out;
  }
  // address: 20 bytes right-aligned in 32
  if (type == 'address') {
    final b = _bytes('$value');
    return _pad32(b);
  }
  if (type == 'bool') {
    final truthy = value == true || '$value' == 'true' || '$value' == '1';
    return _word(BigInt.from(truthy ? 1 : 0));
  }
  // uint*/int*: 32-byte big-endian two's-complement
  if (type.startsWith('uint') || type.startsWith('int')) {
    return _word(_toBigInt(value));
  }
  throw ArgumentError('eip712: unsupported type "$type"');
}

// ---- helpers ---------------------------------------------------------------

Uint8List _bytes(String v) =>
    v.startsWith('0x') || v.startsWith('0X') ? c.hexToBytes(v.substring(2)) : c.hexToBytes(v);

Uint8List _pad32(List<int> b) {
  final out = Uint8List(32);
  final start = 32 - b.length;
  for (var i = 0; i < b.length && i < 32; i++) {
    out[start + i] = b[i];
  }
  return out;
}

BigInt _toBigInt(dynamic v) {
  if (v is BigInt) return v;
  if (v is int) return BigInt.from(v);
  final s = '$v';
  if (s.startsWith('0x') || s.startsWith('0X')) {
    return BigInt.parse(s.substring(2), radix: 16);
  }
  return BigInt.parse(s);
}

/// 32-byte big-endian two's-complement word for a (possibly negative) integer.
Uint8List _word(BigInt v) {
  var n = v;
  if (n < BigInt.zero) {
    n = (BigInt.one << 256) + n; // two's complement
  }
  final out = Uint8List(32);
  for (var i = 31; i >= 0; i--) {
    out[i] = (n & BigInt.from(0xff)).toInt();
    n = n >> 8;
  }
  return out;
}
