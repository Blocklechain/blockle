// xrp_test.dart — the XRP adapter gate for the Flutter port.
//
// Asserts, against the SHARED cross-port vector docs/xrp-vectors.json (cross-
// checked byte-identical against ripple-keypairs + ripple-binary-codec), that the
// Dart port reproduces every value byte-for-byte:
//   (a) BIP44 secp256k1 m/44'/144'/0'/0/0 -> priv + 33B compressed pub ->
//       AccountID=RIPEMD160(SHA256(pub)) -> classic 'r…' address.
//   (b) addressSpecVectors (accountId <-> 'r…') round-trip; isXrpAddress.
//   (c) the XRPL binary-codec Payment: encodeForSigning ('STX\0'||tx) ==
//       signingDataHex; the secp256k1 RFC6979 low-S DER == txnSignatureDerHex;
//       the full signed tx_blob == txBlobHex; txid = SHA512-half('TXN\0'||blob).
//   (d) a DestinationTag variant (txWithTag).
//   (e) buildSend (client-built path) reproduces the golden blob; the only node
//       inputs (Sequence + LastLedgerSequence) are injected offline.
import 'dart:convert';
import 'dart:io';

import 'package:blockle_app/multichain/chains/chain_adapter.dart';
import 'package:blockle_app/multichain/chains/xrp.dart' as xrp;
import 'package:blockle_app/multichain/chains/xrpl_codec.dart' as x;
import 'package:blockle_app/multichain/crypto/crypto_core.dart' as c;
import 'package:blockle_app/multichain/crypto/hd.dart' as hd;
import 'package:blockle_app/multichain/crypto/secp256k1.dart' as s;
import 'package:flutter_test/flutter_test.dart';

String h(List<int> b) => c.bytesToHex(b);

Map<String, dynamic> _loadVectors() {
  final f = File('../docs/xrp-vectors.json');
  if (!f.existsSync()) throw StateError('xrp vector not found (../docs/xrp-vectors.json)');
  return jsonDecode(f.readAsStringSync()) as Map<String, dynamic>;
}

x.XrpPayment _paymentFromFields(Map<String, dynamic> fields) {
  final tag = fields['DestinationTag'];
  return x.XrpPayment(
    accountId: x.accountIdFromAddress(fields['Account'] as String),
    destinationAccountId: x.accountIdFromAddress(fields['Destination'] as String),
    amountDrops: fields['Amount'] as String,
    feeDrops: fields['Fee'] as String,
    sequence: fields['Sequence'] as int,
    flags: fields['Flags'] as int,
    lastLedgerSequence: fields['LastLedgerSequence'] as int,
    signingPubKey: c.hexToBytes(fields['SigningPubKey'] as String),
    destinationTag: tag is int ? tag : null,
  );
}

void main() {
  final V = _loadVectors();
  final seed = hd.mnemonicToSeed(V['mnemonic'] as String, V['passphrase'] as String? ?? '');
  final path = V['path'] as String;
  final exp = V['expected'] as Map<String, dynamic>;

  final node = hd.derivePath(seed, path);

  group('(a) BIP44 secp256k1 derivation -> classic address', () {
    test('private key + compressed public key match', () {
      expect(h(node.privateKey!), exp['privKeyHex']);
      expect(h(node.publicKey), exp['pubkeyHexCompressed']);
    });
    test('AccountID + classic address match', () {
      expect(h(x.accountIdFromPubkey(node.publicKey)), exp['accountIdHex']);
      expect(x.classicAddressFromPubkey(node.publicKey), exp['classicAddress']);
    });
    test('deriveAccount yields the classic address + secp256k1 scheme', () async {
      final a = xrp.XrpAdapter();
      final acct = await a.deriveAccount(RootSecret(seed: seed));
      expect(acct.address, exp['classicAddress']);
      expect(acct.publicKey, exp['pubkeyHexCompressed']);
      expect(acct.scheme, 'secp256k1');
      expect(acct.path, path);
    });
  });

  group('(b) address codec', () {
    test('addressSpecVectors (accountId <-> r…) round-trip', () {
      for (final pair in V['addressSpecVectors'] as List) {
        final accountIdHex = pair[0] as String;
        final address = pair[1] as String;
        expect(x.classicAddressFromAccountId(c.hexToBytes(accountIdHex)), address);
        expect(h(x.accountIdFromAddress(address)), accountIdHex);
      }
    });
    test('isXrpAddress accepts r…, rejects EVM/BTC/SOL/TON', () {
      expect(x.isXrpAddress(exp['classicAddress'] as String), true);
      expect(x.isXrpAddress('0x52908400098527886E0F7030069857D2E4169EE7'), false);
      expect(x.isXrpAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'), false);
      expect(x.isXrpAddress('So11111111111111111111111111111111111111112'), false);
      expect(x.isXrpAddress('rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v4'), false); // bad checksum
    });
  });

  group('(c) native Payment: signing data + signature + signed blob byte-exact', () {
    final tx = V['tx'] as Map<String, dynamic>;
    final fields = tx['fields'] as Map<String, dynamic>;
    final payment = _paymentFromFields(fields);
    final texp = tx['expected'] as Map<String, dynamic>;

    test('encodeForSigning == signingDataHex', () {
      expect(h(x.signingData(payment)), tx['signingDataHex']);
    });
    test('secp256k1 RFC6979 low-S DER == txnSignatureDerHex + verifies', () {
      final hash = x.sha512Half(x.signingData(payment));
      final sig = s.sign(hash, node.privateKey!);
      expect(h(sig.der), texp['txnSignatureDerHex']);
      expect(s.verify(hash, sig, node.publicKey), true);
      expect(texp['verifies'], true);
    });
    test('full signed tx_blob == txBlobHex + txid hash', () {
      final hash = x.sha512Half(x.signingData(payment));
      final sig = s.sign(hash, node.privateKey!);
      final blob = x.signedBlob(payment, sig.der);
      expect(h(blob), texp['txBlobHex']);
      expect(x.txHash(blob), texp['hash']);
    });
  });

  group('(d) DestinationTag Payment variant byte-exact', () {
    final tx = V['txWithTag'] as Map<String, dynamic>;
    final fields = tx['fields'] as Map<String, dynamic>;
    final payment = _paymentFromFields(fields);
    final texp = tx['expected'] as Map<String, dynamic>;
    test('signing data + signed blob + hash match', () {
      expect(h(x.signingData(payment)), tx['signingDataHex']);
      final hash = x.sha512Half(x.signingData(payment));
      final sig = s.sign(hash, node.privateKey!);
      expect(h(sig.der), texp['txnSignatureDerHex']);
      final blob = x.signedBlob(payment, sig.der);
      expect(h(blob), texp['txBlobHex']);
      expect(x.txHash(blob), texp['hash']);
    });
  });

  group('(e) adapter wiring + client-built buildSend', () {
    test('native asset: xrp, 6 decimals; explorer deep-link', () {
      final a = xrp.XrpAdapter();
      expect(a.id, 'xrp');
      expect(a.native.decimals, 6);
      expect(a.explorerTx('ABC'), 'https://xrpscan.com/tx/ABC');
    });
    test('buildSend reproduces the golden signed blob (seq + ledger injected)', () async {
      final tx = V['tx'] as Map<String, dynamic>;
      final fields = tx['fields'] as Map<String, dynamic>;
      final texp = tx['expected'] as Map<String, dynamic>;
      // Inject a rippled transport: account_info -> Sequence 1, ledger_current
      // -> 12325 (+20 buffer = LastLedgerSequence 12345, matching the vector).
      Future<String> post(String path, String body) async {
        final req = jsonDecode(body) as Map<String, dynamic>;
        final method = req['method'];
        if (method == 'account_info') {
          return jsonEncode({'result': {'account_data': {'Sequence': 1, 'Balance': '100000000'}}});
        }
        if (method == 'ledger_current') {
          return jsonEncode({'result': {'ledger_current_index': 12325}});
        }
        return jsonEncode({'result': {}});
      }

      final a = xrp.XrpAdapter(post: post);
      a.unlock(RootSecret(seed: seed));
      final acct = await a.deriveAccount(RootSecret(seed: seed));
      final built = await a.buildSend(
        acct,
        SendRequest(to: fields['Destination'] as String, amount: fields['Amount'] as String),
      );
      expect(built.raw, texp['txBlobHex']); // signed blob byte-exact
      expect(built.txid, texp['hash']);
      expect(built.extra?['kind'], 'payment');
      expect(built.extra?['sequence'], 1);
      expect(built.extra?['lastLedgerSequence'], 12345);
    });
  });
}
