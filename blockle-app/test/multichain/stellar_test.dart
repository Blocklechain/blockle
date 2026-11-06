// stellar_test.dart — the Stellar adapter gate for the Flutter port.
//
// Asserts, against the SHARED cross-port vector docs/stellar-vectors.json (cross-
// checked byte-identical against @stellar/stellar-base), that the Dart port
// reproduces every value byte-for-byte:
//   (a) SLIP-0010 ed25519 m/44'/148'/0' -> 32B seed + 32B pub -> strkey 'G…'.
//   (b) addressSpecVectors (pub <-> 'G…') round-trip; isStellarAddress; crc16
//       KATs; networkId = SHA256(passphrase).
//   (c) native-XLM Payment: Transaction XDR == txXDRunsigned; tx hash =
//       SHA256(networkId||ENVELOPE_TYPE_TX||txXDR) == signingPayload; the ed25519
//       signature == signatureHex (+verify); hint; signed envelope base64 ==
//       envelopeXDRBase64.
//   (d) an AlphaNum4 issued-asset Payment variant (assetTx).
//   (e) buildSend (client-built path) reproduces the golden envelope; the only
//       node input (account sequence) is injected offline.
import 'dart:convert';
import 'dart:io';

import 'package:blockle_app/multichain/chains/chain_adapter.dart';
import 'package:blockle_app/multichain/chains/stellar.dart' as stellar;
import 'package:blockle_app/multichain/chains/stellar_xdr.dart' as sx;
import 'package:blockle_app/multichain/crypto/crypto_core.dart' as c;
import 'package:blockle_app/multichain/crypto/ed25519.dart' as ed;
import 'package:blockle_app/multichain/crypto/hd.dart' as hd;
import 'package:flutter_test/flutter_test.dart';

String h(List<int> b) => c.bytesToHex(b);

Map<String, dynamic> _loadVectors() {
  final f = File('../docs/stellar-vectors.json');
  if (!f.existsSync()) {
    throw StateError('stellar vector not found (../docs/stellar-vectors.json)');
  }
  return jsonDecode(f.readAsStringSync()) as Map<String, dynamic>;
}

void main() {
  final V = _loadVectors();
  final seedBytes =
      hd.mnemonicToSeed(V['mnemonic'] as String, V['passphrase'] as String? ?? '');
  final path = V['path'] as String;
  final exp = V['expected'] as Map<String, dynamic>;
  final net = V['network'] as Map<String, dynamic>;

  final seedKey = stellar.deriveSlip10Key(seedBytes, path);
  final pub = ed.publicKey(seedKey);

  group('(a) SLIP-0010 ed25519 derivation -> strkey address', () {
    test('seed key + public key match', () {
      expect(h(seedKey), exp['seedKeyHex']);
      expect(h(pub), exp['pubkeyHex']);
    });
    test('strkey G… address matches', () {
      expect(sx.strkeyEncodeEd25519(pub), exp['address']);
    });
    test('deriveAccount yields the strkey address + ed25519 scheme', () async {
      final a = stellar.StellarAdapter();
      final acct = await a.deriveAccount(RootSecret(seed: seedBytes));
      expect(acct.address, exp['address']);
      expect(acct.publicKey, exp['pubkeyHex']);
      expect(acct.scheme, 'ed25519');
      expect(acct.path, path);
    });
  });

  group('(b) address codec + crc + networkId', () {
    test('addressSpecVectors (pub <-> G…) round-trip', () {
      for (final pair in V['addressSpecVectors'] as List) {
        final pubHex = pair[0] as String;
        final address = pair[1] as String;
        expect(sx.strkeyEncodeEd25519(c.hexToBytes(pubHex)), address);
        expect(h(sx.strkeyDecodeEd25519(address)), pubHex);
      }
    });
    test('isStellarAddress accepts G…, rejects EVM/BTC/SOL/XRP', () {
      expect(sx.isStellarAddress(exp['address'] as String), true);
      expect(sx.isStellarAddress('0x52908400098527886E0F7030069857D2E4169EE7'), false);
      expect(sx.isStellarAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'), false);
      expect(sx.isStellarAddress('rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3'), false);
    });
    test('crc16/XMODEM known-answer tests', () {
      for (final kat in V['crcKats'] as List) {
        expect(sx.crc16Xmodem(c.utf8Bytes(kat[0] as String)), kat[1]);
      }
    });
    test('networkId == SHA256(passphrase)', () {
      expect(h(sx.networkId(net['networkPassphrase'] as String)), net['networkIdHex']);
    });
  });

  group('(c) native-XLM Payment byte-exact', () {
    final tx = V['tx'] as Map<String, dynamic>;
    final fields = tx['fields'] as Map<String, dynamic>;
    final op = fields['op'] as Map<String, dynamic>;
    final texp = tx['expected'] as Map<String, dynamic>;
    final built = stellar.buildPayment(
      seedKey: seedKey,
      sourcePub: pub,
      destPub: sx.strkeyDecodeEd25519(op['destination'] as String),
      sequence: BigInt.parse(fields['sequence'] as String),
      fee: fields['fee'] as int,
      amountStroops: op['amountStroops'] as String,
    );

    test('Transaction XDR == txXDRunsignedBase64', () {
      expect(sx.toBase64(built.txXdr), tx['txXDRunsignedBase64']);
    });
    test('tx hash == signingPayloadHex == expected.hash', () {
      expect(built.hashHex, tx['signingPayloadHex']);
      expect(built.hashHex, texp['hash']);
    });
    test('ed25519 signature == signatureHex (+verify) + hint', () {
      expect(h(built.signature), texp['signatureHex']);
      expect(h(built.hint), texp['hint']);
      final hash = sx.txHashBytes(built.txXdr);
      expect(ed.verify(hash, built.signature, pub), true);
      expect(texp['verifies'], true);
    });
    test('signed envelope base64 == envelopeXDRBase64', () {
      expect(built.envelopeBase64, texp['envelopeXDRBase64']);
    });
  });

  group('(d) AlphaNum4 issued-asset Payment variant byte-exact', () {
    final tx = V['assetTx'] as Map<String, dynamic>;
    final fields = tx['fields'] as Map<String, dynamic>;
    final op = fields['op'] as Map<String, dynamic>;
    final asset = op['asset'] as Map<String, dynamic>;
    final texp = tx['expected'] as Map<String, dynamic>;
    final built = stellar.buildPayment(
      seedKey: seedKey,
      sourcePub: pub,
      destPub: sx.strkeyDecodeEd25519(op['destination'] as String),
      sequence: BigInt.parse(fields['sequence'] as String),
      fee: fields['fee'] as int,
      amountStroops: op['amountStroops'] as String,
      asset: sx.StellarAsset.alphaNum4(
          asset['code'] as String, sx.strkeyDecodeEd25519(asset['issuer'] as String)),
    );
    test('Transaction XDR + signature + envelope byte-exact', () {
      expect(sx.toBase64(built.txXdr), tx['txXDRunsignedBase64']);
      expect(built.hashHex, tx['signingPayloadHex']);
      expect(h(built.signature), texp['signatureHex']);
      expect(built.envelopeBase64, texp['envelopeXDRBase64']);
      expect(built.hashHex, texp['hash']);
    });
  });

  group('(e) adapter wiring + client-built buildSend', () {
    test('native asset: stellar, 7 decimals; explorer deep-link', () {
      final a = stellar.StellarAdapter();
      expect(a.id, 'stellar');
      expect(a.native.decimals, 7);
      expect(a.explorerTx('abc'), 'https://stellar.expert/explorer/public/tx/abc');
    });
    test('buildSend reproduces the golden envelope (sequence injected)', () async {
      final tx = V['tx'] as Map<String, dynamic>;
      final fields = tx['fields'] as Map<String, dynamic>;
      final op = fields['op'] as Map<String, dynamic>;
      final texp = tx['expected'] as Map<String, dynamic>;
      // tx seqNum = account sequence + 1; vector seqNum 4294967297 -> inject 4294967296.
      Future<String> get(String path) async {
        return jsonEncode({
          'sequence': '4294967296',
          'balances': [
            {'asset_type': 'native', 'balance': '10.0000000'}
          ]
        });
      }

      final a = stellar.StellarAdapter(get: get);
      a.unlock(RootSecret(seed: seedBytes));
      final acct = await a.deriveAccount(RootSecret(seed: seedBytes));
      final built = await a.buildSend(
        acct,
        SendRequest(to: op['destination'] as String, amount: op['amountStroops'] as String),
      );
      expect(built.raw, texp['envelopeXDRBase64']); // signed envelope byte-exact
      expect(built.txid, texp['hash']);
      expect(built.extra?['kind'], 'payment');
      expect(built.extra?['sequence'], '4294967297');
    });
  });
}
