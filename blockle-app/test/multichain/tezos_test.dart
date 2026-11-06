// tezos_test.dart — the Tezos adapter gate for the Flutter port.
//
// Asserts, against the SHARED cross-port vector docs/tezos-vectors.json (cross-
// checked BYTE-IDENTICAL against @taquito/local-forging + @taquito/signer), that
// the Dart port reproduces every value byte-for-byte, all OFFLINE:
//   (a) blake2b KATs at 20- and 32-byte lengths (the one new primitive), proven
//       BEFORE any address/forge assertion.
//   (b) zarith (base-128 LEB128) KATs.
//   (c) contract-id (destination) KATs for tz1/tz2/tz3/KT1.
//   (d) SLIP-0010 ed25519 m/44'/1729'/0'/0' -> 32B seed + edpk + tz1 address;
//       addressSpecVectors (pub -> tz1); isTz1Address / isTezosDestination.
//   (e) client-forged single 'transaction' op: forgedHex byte-exact; signing
//       hash = blake2b(0x03||forged,32); ed25519 signature byte-exact + verify;
//       edsig; injectionHex (what POSTs to /injection/operation).
//   (f) adapter wiring + client-built buildSend (branch + counter injected
//       offline) reproducing the golden injection hex.
import 'dart:convert';
import 'dart:io';

import 'package:blockle_app/multichain/chains/chain_adapter.dart';
import 'package:blockle_app/multichain/chains/tezos.dart' as tezos;
import 'package:blockle_app/multichain/chains/tezos_forge.dart' as tz;
import 'package:blockle_app/multichain/crypto/crypto_core.dart' as c;
import 'package:blockle_app/multichain/crypto/ed25519.dart' as ed;
import 'package:blockle_app/multichain/crypto/hd.dart' as hd;
import 'package:flutter_test/flutter_test.dart';

String h(List<int> b) => c.bytesToHex(b);

Map<String, dynamic> _loadVectors() {
  final f = File('../docs/tezos-vectors.json');
  if (!f.existsSync()) {
    throw StateError('tezos vector not found (../docs/tezos-vectors.json)');
  }
  return jsonDecode(f.readAsStringSync()) as Map<String, dynamic>;
}

void main() {
  final V = _loadVectors();
  final seedBytes =
      hd.mnemonicToSeed(V['mnemonic'] as String, V['passphrase'] as String? ?? '');
  final path = V['path'] as String;
  final exp = V['expected'] as Map<String, dynamic>;

  final seedKey = tezos.deriveSlip10Key(seedBytes, path);
  final pub = ed.publicKey(seedKey);

  group('(a) blake2b KATs (the one new primitive)', () {
    test('empty + "abc" at 20 and 32 bytes', () {
      for (final kat in V['blake2bKats'] as List) {
        final msg = kat[0] as String;
        final want = kat[1] as String;
        final outLen = kat[2] as int;
        expect(h(c.blake2b(c.utf8Bytes(msg), outLen: outLen)), want,
            reason: 'blake2b("$msg", $outLen)');
      }
    });
  });

  group('(b) zarith KATs', () {
    test('base-128 LEB128 varint', () {
      for (final kat in V['zarithKats'] as List) {
        final n = kat[0] as int;
        expect(h(tz.zarith(BigInt.from(n))), kat[1] as String,
            reason: 'zarith($n)');
      }
    });
  });

  group('(c) contract-id (destination) KATs', () {
    test('tz1/tz2/tz3/KT1 encodings', () {
      for (final kat in V['destinationKats'] as List) {
        final dest = kat[0] as String;
        expect(h(tz.contractId(dest)), kat[1] as String, reason: dest);
        expect(tz.isTezosDestination(dest), true);
      }
    });
  });

  group('(d) SLIP-0010 ed25519 derivation -> edpk + tz1 address', () {
    test('seed key + edpk public key match', () {
      expect(h(seedKey), exp['seedKeyHex']);
      expect(h(pub), exp['edpkPubkeyHex']);
    });
    test('edpk + tz1 address match', () {
      expect(tz.edpk(pub), exp['edpk']);
      expect(tz.tz1FromPublicKey(pub), exp['address']);
    });
    test('addressSpecVectors (pub -> tz1)', () {
      for (final pair in V['addressSpecVectors'] as List) {
        expect(tz.tz1FromPublicKey(c.hexToBytes(pair[0] as String)), pair[1]);
      }
    });
    test('isTz1Address accepts tz1, rejects others', () {
      expect(tz.isTz1Address(exp['address'] as String), true);
      expect(tz.isTz1Address('0x52908400098527886E0F7030069857D2E4169EE7'), false);
      expect(tz.isTz1Address('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'), false);
    });
    test('deriveAccount yields the tz1 address + ed25519 scheme', () async {
      final a = tezos.TezosAdapter();
      final acct = await a.deriveAccount(RootSecret(seed: seedBytes));
      expect(acct.address, exp['address']);
      expect(acct.publicKey, exp['edpkPubkeyHex']);
      expect(acct.scheme, 'ed25519');
      expect(acct.path, path);
    });
  });

  group('(e) client-forged transaction byte-exact', () {
    final txv = V['tx'] as Map<String, dynamic>;
    final fields = txv['fields'] as Map<String, dynamic>;
    final texp = txv['expected'] as Map<String, dynamic>;
    final f = tz.TezosTxFields(
      branch: fields['branch'] as String,
      source: fields['source'] as String,
      fee: fields['fee'] as String,
      counter: fields['counter'] as String,
      gasLimit: fields['gas_limit'] as String,
      storageLimit: fields['storage_limit'] as String,
      amount: fields['amount'] as String,
      destination: fields['destination'] as String,
    );
    final built = tezos.buildTransfer(seedKey: seedKey, fields: f);

    test('forgedHex byte-exact', () {
      expect(built.forgedHex, texp['forgedHex']);
    });
    test('signing hash = blake2b(0x03||forged,32)', () {
      expect(built.signingHashHex, texp['signingHashHex']);
      expect(h(tz.signingBytesFromHex(built.forgedHex)), texp['signingHashHex']);
    });
    test('ed25519 signature byte-exact + verifies + edsig', () {
      expect(h(built.signature), texp['signatureHex']);
      expect(built.edsig, texp['edsig']);
      final hash = tz.signingBytesFromHex(built.forgedHex);
      expect(ed.verify(hash, built.signature, pub), true);
    });
    test('injection hex = forged || sig', () {
      expect(built.injectionHex, texp['injectionHex']);
    });
  });

  group('(f) adapter wiring + client-built buildSend', () {
    test('native asset: tezos, 6 decimals; explorer deep-link', () {
      final a = tezos.TezosAdapter();
      expect(a.id, 'tezos');
      expect(a.native.symbol, 'XTZ');
      expect(a.native.decimals, 6);
      expect(a.explorerTx('opABC'), 'https://tzkt.io/opABC');
    });
    test('buildSend reproduces the golden injection (branch+counter injected)',
        () async {
      final txv = V['tx'] as Map<String, dynamic>;
      final fields = txv['fields'] as Map<String, dynamic>;
      final texp = txv['expected'] as Map<String, dynamic>;
      // Vector counter is "1" => inject the account's current counter "0" (+1).
      Future<String> get(String apiPath) async {
        if (apiPath.endsWith('/hash')) {
          return jsonEncode(fields['branch'] as String);
        }
        if (apiPath.endsWith('/counter')) return jsonEncode('0');
        if (apiPath.endsWith('/balance')) return jsonEncode('12300000');
        return jsonEncode('');
      }

      final a = tezos.TezosAdapter(get: get);
      a.unlock(RootSecret(seed: seedBytes));
      final acct = await a.deriveAccount(RootSecret(seed: seedBytes));
      final built = await a.buildSend(
        acct,
        SendRequest(
          to: fields['destination'] as String,
          amount: fields['amount'] as String,
          feeRate: fields['fee'] as String,
        ),
      );
      expect(built.raw, texp['injectionHex']); // injection-ready hex byte-exact
      expect(built.txid, texp['edsig']);
      expect(built.extra?['kind'], 'transaction');
      expect(built.extra?['counter'], '1');
      expect(built.extra?['forgedHex'], texp['forgedHex']);
    });
    test('getBalance parses mutez -> 6dp display', () async {
      Future<String> get(String apiPath) async => jsonEncode('12300000');
      final a = tezos.TezosAdapter(get: get);
      final bals = await a.getBalance(exp['address'] as String);
      expect(bals.first.confirmed, '12300000');
      expect(bals.first.display, '12.3');
    });
  });
}
