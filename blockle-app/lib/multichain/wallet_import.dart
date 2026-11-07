// wallet_import.dart — the INVERSE of wallet_export.dart: parse a single private
// key in any supported chain's native format into a [RootSecret] that every
// adapter of that key's scheme signs from DIRECTLY (HD bypassed, one account per
// chain). The scheme determines which chains the import enables:
//   • secp256k1 (32-byte key)      → all EVM + all UTXO + Tron + XRP
//   • ed25519   (32-byte seed)     → Solana + TON + Stellar + Tezos
//   • Cardano   (96-byte acct xprv)→ Cardano
//
// Formats accepted (auto-detected, or forced via [ImportKind]):
//   EVM / raw      0x-hex or bare 64-hex secp256k1 private key
//   WIF            Bitcoin-style WIF (BTC/LTC/DOGE/BCH share the secp256k1 key)
//   XRP            00-prefixed 66-hex secp256k1 (ripple-keypairs style)
//   Solana         base58 secret (64-byte seed||pub, Phantom-style) or 32-byte
//   Stellar        StrKey S… secret seed (ed25519)
//   Tezos          edsk… 32-byte seed (base58check)
//   Cardano        192-hex (96-byte CIP-1852 account xprv)
//
// NEVER guesses: an unparseable / out-of-range key throws ImportException; the
// bytes are validated (secp scalar range, lengths) before anything is derived.

import 'dart:typed_data';

import 'chains/chain_adapter.dart' show RootSecret;
import 'crypto/crypto_core.dart' as c;
import 'crypto/secp256k1.dart' as s;

class ImportException implements Exception {
  ImportException(this.message);
  final String message;
  @override
  String toString() => message;
}

enum ImportScheme { secp256k1, ed25519, cardano }

enum ImportKind { auto, evm, wif, xrp, solana, stellar, tezos, cardano, ed25519Raw }

/// Chains a given import scheme controls (one key → these addresses).
const List<String> kSecpImportChains = [
  'ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bnb', 'avalanche',
  'hyperevm', 'bitcoin', 'litecoin', 'dogecoin', 'bitcoincash', 'tron', 'xrp',
];
const List<String> kEd25519ImportChains = ['solana', 'ton', 'stellar', 'tezos'];
const List<String> kCardanoImportChains = ['cardano'];

class ImportResult {
  ImportResult(this.scheme, this.bytes);
  final ImportScheme scheme;
  final Uint8List bytes;

  List<String> get chains => switch (scheme) {
        ImportScheme.secp256k1 => kSecpImportChains,
        ImportScheme.ed25519 => kEd25519ImportChains,
        ImportScheme.cardano => kCardanoImportChains,
      };

  String get label => switch (scheme) {
        ImportScheme.secp256k1 => 'secp256k1 (EVM, Bitcoin, Tron, XRP …)',
        ImportScheme.ed25519 => 'ed25519 (Solana, TON, Stellar, Tezos)',
        ImportScheme.cardano => 'Cardano account key',
      };

  RootSecret toRootSecret() => RootSecret(
        importedSecp: scheme == ImportScheme.secp256k1 ? bytes : null,
        importedEd25519: scheme == ImportScheme.ed25519 ? bytes : null,
        importedCardano: scheme == ImportScheme.cardano ? bytes : null,
      );
}

bool _isHex(String s) => RegExp(r'^[0-9a-fA-F]+$').hasMatch(s);

Uint8List _validSecp(Uint8List k) {
  if (k.length != 32) throw ImportException('secp256k1 key must be 32 bytes');
  final d = s.bytesToBig(k);
  if (d == BigInt.zero || !s.isValidPrivate(d)) {
    throw ImportException('secp256k1 key is out of range');
  }
  return k;
}

// ---- individual format parsers --------------------------------------------

ImportResult _parseHexSecp(String input) {
  var h = input.trim();
  if (h.startsWith('0x') || h.startsWith('0X')) h = h.substring(2);
  if (h.length != 64 || !_isHex(h)) {
    throw ImportException('expected a 64-hex secp256k1 private key');
  }
  return ImportResult(ImportScheme.secp256k1, _validSecp(c.hexToBytes(h)));
}

ImportResult _parseWif(String input) {
  final Uint8List dec;
  try {
    dec = c.base58checkDecode(input.trim());
  } catch (_) {
    throw ImportException('invalid WIF (base58check failed)');
  }
  // version(1) + key(32) [+ 0x01 compressed]
  if (dec.length != 33 && dec.length != 34) {
    throw ImportException('invalid WIF length');
  }
  final key = Uint8List.fromList(dec.sublist(1, 33));
  return ImportResult(ImportScheme.secp256k1, _validSecp(key));
}

ImportResult _parseXrp(String input) {
  var h = input.trim();
  if (h.startsWith('0x') || h.startsWith('0X')) h = h.substring(2);
  if (h.length == 66 && _isHex(h) && h.substring(0, 2) == '00') {
    return ImportResult(ImportScheme.secp256k1, _validSecp(c.hexToBytes(h.substring(2))));
  }
  if (h.length == 64 && _isHex(h)) {
    return ImportResult(ImportScheme.secp256k1, _validSecp(c.hexToBytes(h)));
  }
  throw ImportException('expected a 00-prefixed 66-hex XRP key');
}

ImportResult _parseSolana(String input) {
  final t = input.trim();
  Uint8List raw;
  if (_isHex(t.replaceFirst('0x', '')) && (t.length == 64 || t.length == 128)) {
    raw = c.hexToBytes(t.replaceFirst('0x', ''));
  } else {
    try {
      raw = c.base58decode(t);
    } catch (_) {
      throw ImportException('invalid Solana key (expect base58 or hex)');
    }
  }
  if (raw.length != 32 && raw.length != 64) {
    throw ImportException('Solana key must be 32 or 64 bytes');
  }
  // 64-byte Phantom secret = seed(32) || pubkey(32); the seed is the signer.
  final seed = Uint8List.fromList(raw.sublist(0, 32));
  return ImportResult(ImportScheme.ed25519, seed);
}

// RFC4648 base32 (no padding) — Stellar StrKey.
Uint8List _base32Decode(String str) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  final s = str.trim().toUpperCase().replaceAll('=', '');
  var bits = 0, value = 0;
  final out = <int>[];
  for (final ch in s.split('')) {
    final idx = alphabet.indexOf(ch);
    if (idx < 0) throw ImportException('invalid StrKey (base32)');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.add((value >> bits) & 0xff);
    }
  }
  return Uint8List.fromList(out);
}

ImportResult _parseStellar(String input) {
  final t = input.trim();
  if (!t.startsWith('S')) throw ImportException('Stellar secret must start with S');
  final full = _base32Decode(t);
  // version(1=0x90) + payload(32) + crc16(2)
  if (full.length < 35) throw ImportException('invalid Stellar StrKey length');
  final seed = Uint8List.fromList(full.sublist(1, 33));
  return ImportResult(ImportScheme.ed25519, seed);
}

ImportResult _parseTezos(String input) {
  final t = input.trim();
  if (!t.startsWith('edsk')) throw ImportException('Tezos key must start with edsk');
  final Uint8List dec;
  try {
    dec = c.base58checkDecode(t);
  } catch (_) {
    throw ImportException('invalid edsk (base58check failed)');
  }
  // edsk 32-byte SEED: 4-byte prefix [13,15,58,7] + seed(32).
  if (dec.length == 36) {
    return ImportResult(ImportScheme.ed25519, Uint8List.fromList(dec.sublist(4, 36)));
  }
  // edsk 64-byte full secret: prefix + (seed(32) || pub(32)); take the seed.
  if (dec.length == 68) {
    return ImportResult(ImportScheme.ed25519, Uint8List.fromList(dec.sublist(4, 36)));
  }
  throw ImportException('unrecognized edsk length');
}

ImportResult _parseCardano(String input) {
  var h = input.trim();
  if (h.startsWith('0x') || h.startsWith('0X')) h = h.substring(2);
  if (h.length != 192 || !_isHex(h)) {
    throw ImportException('expected a 192-hex (96-byte) Cardano account xprv');
  }
  return ImportResult(ImportScheme.cardano, c.hexToBytes(h));
}

ImportResult _parseEd25519Raw(String input) {
  var h = input.trim().replaceFirst('0x', '');
  if (_isHex(h) && (h.length == 64 || h.length == 128)) {
    final b = c.hexToBytes(h);
    return ImportResult(ImportScheme.ed25519, Uint8List.fromList(b.sublist(0, 32)));
  }
  // base64 / base58 fall back to the Solana parser's handling.
  return _parseSolana(input);
}

/// Parse [input] as [kind]. ImportKind.auto detects the format from its shape.
ImportResult parseImportedKey(String input, {ImportKind kind = ImportKind.auto}) {
  final t = input.trim();
  if (t.isEmpty) throw ImportException('empty key');
  switch (kind) {
    case ImportKind.evm:
      return _parseHexSecp(t);
    case ImportKind.wif:
      return _parseWif(t);
    case ImportKind.xrp:
      return _parseXrp(t);
    case ImportKind.solana:
      return _parseSolana(t);
    case ImportKind.stellar:
      return _parseStellar(t);
    case ImportKind.tezos:
      return _parseTezos(t);
    case ImportKind.cardano:
      return _parseCardano(t);
    case ImportKind.ed25519Raw:
      return _parseEd25519Raw(t);
    case ImportKind.auto:
      // Unambiguous prefixes first.
      if (t.startsWith('edsk')) return _parseTezos(t);
      if (t.startsWith('S') && !t.startsWith('0x')) {
        try {
          return _parseStellar(t);
        } catch (_) {/* fall through */}
      }
      final hex = t.replaceFirst(RegExp(r'^0x', caseSensitive: false), '');
      if (_isHex(hex)) {
        if (hex.length == 192) return _parseCardano(t);
        if (hex.length == 66 && hex.substring(0, 2) == '00') return _parseXrp(t);
        if (hex.length == 64) return _parseHexSecp(hex); // default secp (EVM/BTC/Tron)
        if (hex.length == 128) return _parseEd25519Raw(hex);
        throw ImportException('unrecognized hex key length (${hex.length})');
      }
      // Non-hex → base58: WIF (leading 5/K/L/c…) vs Solana (long base58).
      try {
        final dec = c.base58checkDecode(t);
        if (dec.length == 33 || dec.length == 34) return _parseWif(t);
      } catch (_) {/* not base58check → try Solana base58 */}
      return _parseSolana(t);
  }
}
