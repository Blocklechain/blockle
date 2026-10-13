// wallet_export_test.dart — WALLET EXPORT (docs/WALLET-EXPORT.md).
//
// Asserts the Dart wallet_export.dart against the AUTHORITATIVE shared vectors
// (docs/wallet-export-vectors.json) — the SAME contract the extension and the
// Python wallet reproduce: the fixed seed -> exact WIF (btc/ltc/doge) + EVM
// 0x-hex + Solana base58 keys, and the exact Core importwallet dump lines
// (BYTE-FOR-BYTE). Plus: WIF round-trips to the same key+address; each dump WIF
// matches its stated address; the gate blocks export while locked and on a
// declined confirm; and NO secret leaves when blocked.
import 'dart:convert';
import 'dart:io';

import 'package:blockle_app/multichain/chains/utxo.dart' as utxo;
import 'package:blockle_app/multichain/crypto/address.dart' as addr;
import 'package:blockle_app/multichain/crypto/crypto_core.dart' as c;
import 'package:blockle_app/multichain/crypto/ed25519.dart' as ed;
import 'package:blockle_app/multichain/crypto/secp256k1.dart' as s;
import 'package:blockle_app/multichain/wallet_export.dart' as wx;
import 'package:flutter_test/flutter_test.dart';

Map<String, dynamic> _loadVectors() {
  for (final p in const [
    '../docs/wallet-export-vectors.json',
    'docs/wallet-export-vectors.json',
    '../../docs/wallet-export-vectors.json',
  ]) {
    final f = File(p);
    if (f.existsSync()) {
      return jsonDecode(f.readAsStringSync()) as Map<String, dynamic>;
    }
  }
  throw StateError(
      'wallet-export-vectors.json not found (cwd=${Directory.current.path})');
}

final V = _loadVectors();

// Re-derive an address from a WIF exactly as a recovering wallet would.
String _addressFromWif(String chainId, String wif) {
  final net = utxo.networks[chainId]!;
  final dec = addr.fromWIF(wif);
  final pub = s.publicKey(dec.privateKey, compressed: true);
  return net.segwit ? addr.p2wpkh(pub, net.hrp!) : addr.p2pkh(pub, net.p2pkh);
}

void main() {
  final keysV = V['keys'] as Map<String, dynamic>;
  final pathsV = V['paths'] as Map<String, dynamic>;
  final dumpsV = V['coreDumps'] as Map<String, dynamic>;
  final seedHex = V['seedHex'] as String;
  final accountIndex = (V['accountIndex'] as num).toInt();

  // =========================================================================
  // 1. DART === VECTORS  (the cross-wallet contract)
  // =========================================================================
  test('fromMnemonic reproduces the vector seed hex', () {
    final r = wx.fromMnemonic(V['mnemonic'] as String, V['passphrase'] as String);
    expect(r.seedHex, seedHex);
  });

  test('privateKeys reproduces every vector key + address + path', () {
    final k = wx.privateKeys(seedHex, accountIndex);
    for (final chain in ['bitcoin', 'litecoin', 'dogecoin']) {
      final v = keysV[chain] as Map<String, dynamic>;
      expect(k[chain]!.wif, v['wif'], reason: '$chain wif');
      expect(k[chain]!.address, v['address'], reason: '$chain address');
      expect(k[chain]!.wifVersion, (v['wifVersion'] as num).toInt(),
          reason: '$chain wif version byte');
      expect(k[chain]!.path, pathsV[chain], reason: '$chain path');
      expect(k[chain]!.publicKey, v['publicKey'], reason: '$chain pubkey');
    }
    final evm = keysV['evm'] as Map<String, dynamic>;
    expect(k['evm']!.privateKey, evm['privateKey']);
    expect(k['evm']!.address, evm['address']);
    expect(k['evm']!.path, pathsV['evm']);
    expect(k['evm']!.publicKey, evm['publicKey']);
    final sol = keysV['solana'] as Map<String, dynamic>;
    expect(k['solana']!.secretKey, sol['secretKey']);
    expect(k['solana']!.address, sol['address']);
    expect(k['solana']!.path, pathsV['solana']);
    expect(k['solana']!.publicKey, sol['publicKey']);
  });

  test('WIF version bytes are chain-correct (BTC 0x80, LTC 0xb0, DOGE 0x9e)', () {
    expect((keysV['bitcoin']['wifVersion'] as num).toInt(), 0x80);
    expect((keysV['litecoin']['wifVersion'] as num).toInt(), 0xb0);
    expect((keysV['dogecoin']['wifVersion'] as num).toInt(), 0x9e);
    for (final chain in ['bitcoin', 'litecoin', 'dogecoin']) {
      expect(addr.fromWIF(keysV[chain]['wif'] as String).version,
          (keysV[chain]['wifVersion'] as num).toInt(),
          reason: chain);
    }
  });

  test('coreDump reproduces the exact vector dump text (header + lines)', () {
    for (final chain in ['bitcoin', 'litecoin', 'dogecoin']) {
      final text = wx.coreDump(chain, seedHex,
          indices: [accountIndex], time: V['dumpTime'] as String);
      expect(text, dumpsV[chain]['text'], reason: '$chain dump');
      expect(wx.coreDumpFilename(chain), dumpsV[chain]['filename'],
          reason: '$chain filename');
      expect(text.startsWith('# Wallet dump'), isTrue,
          reason: '$chain has the # Wallet dump header');
    }
  });

  test('danger warning matches the shared vector', () {
    expect(wx.dangerWarning, V['dangerWarning']);
  });

  // =========================================================================
  // 2. WIF ROUND-TRIP — decode back to the SAME key + address
  // =========================================================================
  test('each WIF decodes back to the same private key + address', () {
    final k = wx.privateKeys(seedHex, accountIndex);
    for (final chain in ['bitcoin', 'litecoin', 'dogecoin']) {
      final dec = addr.fromWIF(k[chain]!.wif!);
      expect(dec.compressed, isTrue, reason: '$chain WIF is compressed');
      // re-encode -> identical WIF (key preserved)
      expect(
          addr.toWIF(dec.privateKey,
              versionByte: dec.version, compressed: true),
          k[chain]!.wif,
          reason: '$chain re-encode');
      // re-derive address from the decoded key
      expect(_addressFromWif(chain, k[chain]!.wif!), k[chain]!.address,
          reason: '$chain address from WIF');
    }
  });

  // =========================================================================
  // 3. DUMP INTEGRITY — every dump WIF matches its stated addr=
  // =========================================================================
  test('each importwallet dump WIF matches its stated address', () {
    for (final chain in ['bitcoin', 'litecoin', 'dogecoin']) {
      final parsed = wx.parseDump(dumpsV[chain]['text'] as String);
      expect(parsed.length >= 1, isTrue, reason: '$chain has >=1 key line');
      for (final row in parsed) {
        expect(row.wif.isNotEmpty && row.address != null, isTrue,
            reason: '$chain line has WIF + addr');
        expect(_addressFromWif(chain, row.wif), row.address,
            reason: '$chain dump WIF -> addr');
        expect(RegExp(r'^m/').hasMatch(row.hdkeypath ?? ''), isTrue,
            reason: '$chain line carries hdkeypath');
      }
    }
  });

  // =========================================================================
  // 4. SOLANA + EVM key integrity
  // =========================================================================
  test('Solana base58 secret decodes to seed||pubkey and matches the address', () {
    final secret = c.base58decode(keysV['solana']['secretKey'] as String);
    expect(secret.length, 64);
    final seedPart = secret.sublist(0, 32);
    final pubPart = secret.sublist(32);
    final pub = ed.publicKey(seedPart);
    expect(c.bytesToHex(pub), c.bytesToHex(pubPart),
        reason: 'secret tail === pubkey');
    expect(c.base58encode(pub), keysV['solana']['address'],
        reason: 'pubkey -> address');
  });

  test('EVM 0x-hex private key re-derives the stated checksummed address', () {
    final priv = c.hexToBytes(
        (keysV['evm']['privateKey'] as String).replaceFirst('0x', ''));
    final pub = s.publicKey(priv, compressed: true);
    expect(addr.evmAddress(pub), keysV['evm']['address']);
  });

  // =========================================================================
  // 5. THE SECURITY GATE — blocked while locked / on declined confirm
  // =========================================================================
  test('gate blocks export while the vault is locked', () async {
    final r = await wx.exportSecrets(
        unlocked: false, confirm: (_) async => true, mnemonic: V['mnemonic'] as String);
    expect(r.ok, isFalse);
    expect(r.reason, 'locked');
    expect(r.keys, isNull);
    expect(r.mnemonic, isNull);
    expect(r.dumps, isNull);
    expect(r.warning, wx.dangerWarning);
  });

  test('gate blocks export on a declined confirm', () async {
    final r = await wx.exportSecrets(
        unlocked: true, confirm: (_) async => false, mnemonic: V['mnemonic'] as String);
    expect(r.ok, isFalse);
    expect(r.reason, 'declined');
    expect(r.keys, isNull);
  });

  test('gate fails closed with no confirm handler', () async {
    final r = await wx.exportSecrets(
        unlocked: true, mnemonic: V['mnemonic'] as String);
    expect(r.ok, isFalse);
    expect(r.reason, 'no-confirm-handler');
    expect(r.keys, isNull);
  });

  test('a passed gate assembles exactly the vector material', () async {
    var warned = '';
    final r = await wx.exportSecrets(
      unlocked: true,
      confirm: (w) async {
        warned = w;
        return true;
      },
      mnemonic: V['mnemonic'] as String,
      passphrase: V['passphrase'] as String,
      index: accountIndex,
      coreDumps: true,
    );
    expect(r.ok, isTrue);
    expect(warned, wx.dangerWarning); // the confirm surfaced the danger warning
    expect(r.mnemonic!.seedHex, seedHex);
    expect(r.keys!['bitcoin']!.wif, keysV['bitcoin']['wif']);
    expect(r.keys!['evm']!.privateKey, keysV['evm']['privateKey']);
    expect(r.keys!['solana']!.secretKey, keysV['solana']['secretKey']);
    for (final chain in ['bitcoin', 'litecoin', 'dogecoin']) {
      expect(r.dumps![chain]!['text'], dumpsV[chain]['text']);
      expect(r.dumps![chain]!['filename'], dumpsV[chain]['filename']);
    }
  });

  test('BLOCK session key exports straight from the unlocked session', () {
    final b = wx.blockKey({
      'address': 'block1exampleaddr',
      'secretKeyHex': 'aa' * 32,
      'publicKeyHex': 'bb' * 32,
    });
    expect(b, isNotNull);
    expect(b!.chain, 'block');
    expect(b.scheme, 'ml-dsa-44');
    expect(b.secretKey, 'aa' * 32);
    expect(wx.blockKey(null), isNull);
    expect(wx.blockKey({'address': 'x'}), isNull); // no key material -> null
  });
}
