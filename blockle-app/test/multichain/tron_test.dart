// tron_test.dart — Tron (TRX + USDT-TRC20) adapter gate for the Flutter port.
//
// Mirrors blockle-extension/tron.test.js and adds the FUND-SAFETY decode gate:
//   (1) golden vector (docs/tron-vectors.json): key/address re-derive, txID ==
//       sha256(raw_data_hex), deterministic 65B [r||s||v] signature that VERIFIES
//       and RECOVERS to the owner — the verified secp256k1 crypto, unchanged.
//   (2) decodeTronRawData() recovers EXACTLY {owner,to,amount} / {owner,contract,
//       call_value,data} from the signed bytes.
//   (3) buildSend ACCEPTS a correct node payload (native + TRC-20) and signs it
//       (native signature == golden), and REJECTS a tampered node payload
//       (recipient swapped, amount inflated, or TRC-20 calldata altered) by
//       throwing BEFORE any signature is produced.
// No network: the TronGrid transport is injected.
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:blockle_app/multichain/chains/chain_adapter.dart';
import 'package:blockle_app/multichain/chains/tron.dart' as tron;
import 'package:blockle_app/multichain/crypto/crypto_core.dart' as c;
import 'package:blockle_app/multichain/crypto/hd.dart' as hd;
import 'package:blockle_app/multichain/crypto/secp256k1.dart' as s;
import 'package:flutter_test/flutter_test.dart';

String h(List<int> b) => c.bytesToHex(b);
Uint8List hx(String s) => c.hexToBytes(s);
const abandon =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// USDT-TRC20 contract (TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t) + recipient of the
// golden transfer (TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC, 1 TRX = 1_000_000 sun).
const usdtContract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const recipient = 'TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC';
const attacker = 'TWsm8HtU2A5eEzoT8ev8yaoFjHsXLLrckb'; // 41e552f6…

// Realistic node payloads (real Tron Transaction.raw protobuf) generated from
// the golden seed. Each txID is sha256(rawDataHex) so the first guard passes and
// the decode-assert is exercised in isolation.
// native: TransferContract owner=TUEZ… to=TJRyWwFs… amount=1_000_000 (==golden).
const nativeOkRaw =
    '0a0202db2208b921b61923a6b1ef40f8e0e9f8a62e5a67080112630a2d747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5472616e73666572436f6e747261637412320a1541c8599111f29c1e1e061265b4af93ea1f274ad78a1215415cd0fb0ab3ce40f3051414c604b27756e69e43db18c0843d';
const nativeOkTxId =
    '2d576151d9f4703b8fefdcaac0bb88510269fda67ba31ee78bd7a692f74191a2';
// native tampered: recipient swapped to the attacker (same owner + amount).
const nativeBadToRaw =
    '0a0202db2208b921b61923a6b1ef40f8e0e9f8a62e5a67080112630a2d747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5472616e73666572436f6e747261637412320a1541c8599111f29c1e1e061265b4af93ea1f274ad78a121541e552f6487585c2b58bc2c9bb4492bc1f17132cd018c0843d';
const nativeBadToTxId =
    '613215c19e7db810df8abe5e7052fc09bf8820ccdba681ca4cda4ad07e35aed4';
// native tampered: amount inflated to 2 TRX (same owner + recipient).
const nativeBadAmtRaw =
    '0a0202db2208b921b61923a6b1ef40f8e0e9f8a62e5a67080112630a2d747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5472616e73666572436f6e747261637412320a1541c8599111f29c1e1e061265b4af93ea1f274ad78a1215415cd0fb0ab3ce40f3051414c604b27756e69e43db1880897a';
const nativeBadAmtTxId =
    '5387dc681cd418678ad7ea15826fce554d374e4fadafec4d621e015ba6c0bf2f';
// TRC-20: TriggerSmartContract owner=TUEZ… contract=USDT call_value=0
// data=a9059cbb||pad32(TJRyWwFs…)||pad32(1_000_000).
const trc20OkRaw =
    '0a0202db2208b921b61923a6b1ef40f8e0e9f8a62e5ab001081f12ab010a31747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e54726967676572536d617274436f6e747261637412760a1541c8599111f29c1e1e061265b4af93ea1f274ad78a121541a614f803b6fd780986a42c78ec9c7f77e6ded13c18002244a9059cbb0000000000000000000000005cd0fb0ab3ce40f3051414c604b27756e69e43db00000000000000000000000000000000000000000000000000000000000f4240';
const trc20OkTxId =
    '9a71547f803af1cec37bd8a8b2db7bc06b470be415c352927bdb62ace0ba9122';
// TRC-20 tampered: calldata recipient swapped to the attacker (selector + amount
// unchanged) — the node tries to redirect the token transfer.
const trc20BadDataRaw =
    '0a0202db2208b921b61923a6b1ef40f8e0e9f8a62e5ab001081f12ab010a31747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e54726967676572536d617274436f6e747261637412760a1541c8599111f29c1e1e061265b4af93ea1f274ad78a121541a614f803b6fd780986a42c78ec9c7f77e6ded13c18002244a9059cbb000000000000000000000000e552f6487585c2b58bc2c9bb4492bc1f17132cd000000000000000000000000000000000000000000000000000000000000f4240';
const trc20BadDataTxId =
    'b9faea6926c377a2b0eee56fff60c88d5e59b31dc0e05c8ad2b134f3747e25c6';
// HARDENING fixtures (dup-field attack). Both are the native golden transfer
// with an appended DUPLICATE field so last-wins/merge semantics would read a
// different value; each txID == sha256(raw) so the first (integrity) guard
// passes and the dup-field-strict decoder is exercised in isolation.
// dupAmountRaw: a second `amount` (field 3) appended inside the TransferContract
// body (inner-contract level), all nested length prefixes recomputed.
const dupAmountRaw =
    '0a0202db2208b921b61923a6b1ef40f8e0e9f8a62e5a6b080112670a2d747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5472616e73666572436f6e747261637412360a1541c8599111f29c1e1e061265b4af93ea1f274ad78a1215415cd0fb0ab3ce40f3051414c604b27756e69e43db18c0843d18c0843d';
const dupAmountTxId =
    '22fcefe79d9ce1611e373b6f3f87323cd48176bd4a345cddd43464aa381b84dc';
// dupTopRaw: a second `expiration` (field 8) appended at the Transaction.raw
// level (top-level dup).
const dupTopRaw =
    '0a0202db2208b921b61923a6b1ef40f8e0e9f8a62e5a67080112630a2d747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5472616e73666572436f6e747261637412320a1541c8599111f29c1e1e061265b4af93ea1f274ad78a1215415cd0fb0ab3ce40f3051414c604b27756e69e43db18c0843d40f8e0e9f8a62e';
const dupTopTxId =
    '951fcf4b8193ef841df58f8daf53629fe201da42ee07888107a2b4a5777d651d';

Map<String, dynamic> _loadVectors() {
  // Dart test cwd is the package root (blockle-app); the shared vector lives at
  // the repo root. Prefer docs/, fall back to test-vectors/.
  for (final p in ['../docs/tron-vectors.json', '../test-vectors/tron-golden.json']) {
    final f = File(p);
    if (f.existsSync()) return jsonDecode(f.readAsStringSync()) as Map<String, dynamic>;
  }
  throw StateError('tron golden vector not found');
}

/// A TronAdapter whose node transport returns a fixed [raw]/[txId] for the next
/// build, so we can drive buildSend with an honest OR a tampered node payload.
tron.TronAdapter _adapterReturning(String raw, String txId) {
  Future<String> post(String path, String body) async {
    final tx = {'raw_data_hex': raw, 'txID': txId, 'raw_data': <String, dynamic>{}};
    if (path.contains('triggersmartcontract')) {
      return jsonEncode({'transaction': tx});
    }
    return jsonEncode(tx); // createtransaction
  }

  return tron.TronAdapter(post: post);
}

AssetRef get _usdt => const AssetRef(
    chain: 'tron', kind: 'trc20', symbol: 'USDT', decimals: 6, address: usdtContract);

/// A TronAdapter whose GET transport returns a fixed [body] for the discovery
/// call (/v1/accounts/{addr}/trc20), with an optional curated token list.
tron.TronAdapter _discoverAdapter(String body,
    {List<AssetRef> known = const []}) {
  Future<String> get(String path) async => body;
  return tron.TronAdapter(get: get, knownTokens: known);
}

void main() {
  final V = _loadVectors();
  final expected = (V['expected'] ?? V['owner']) as Map<String, dynamic>;
  final seed = hd.mnemonicToSeed(V['mnemonic'] as String, '');
  final node = hd.derivePath(seed, V['path'] as String);

  group('discoverTokens: TRC-20 auto-detect over a mocked TronGrid indexer', () {
    test('maps a held TRC-20 to a Balance; symbol/decimals from the known list',
        () async {
      final a = _discoverAdapter(
          jsonEncode({
            'data': [
              {usdtContract: '5000000'}
            ]
          }),
          known: [_usdt]);
      final rows = await a.discoverTokens('TAddr');
      expect(rows.length, 1);
      final b = rows.first;
      expect(b.asset.chain, 'tron');
      expect(b.asset.kind, 'trc20');
      expect(b.asset.symbol, 'USDT');
      expect(b.asset.decimals, 6);
      expect(b.asset.address, usdtContract);
      expect(b.confirmed, '5000000');
      expect(b.display, '5');
    });

    test('an unknown contract falls back to short-contract symbol + 6 decimals',
        () async {
      final a = _discoverAdapter(jsonEncode({
        'data': [
          {'TXXXXcontractYYYYZZZZ1234': '1000000'}
        ]
      }));
      final rows = await a.discoverTokens('TAddr');
      expect(rows.first.asset.symbol, 'TXXX…1234');
      expect(rows.first.asset.decimals, 6);
      expect(rows.first.confirmed, '1000000');
    });

    test('zero balances skipped; empty data => []; a network throw => []',
        () async {
      final zero = _discoverAdapter(
          jsonEncode({
            'data': [
              {usdtContract: '0'}
            ]
          }),
          known: [_usdt]);
      expect(await zero.discoverTokens('T'), isEmpty);
      expect(await _discoverAdapter(jsonEncode({'data': []})).discoverTokens('T'),
          isEmpty);
      final thrower =
          tron.TronAdapter(get: (p) async => throw StateError('net'));
      expect(await thrower.discoverTokens('T'), isEmpty);
    });
  });

  group('golden vector (verified secp256k1 crypto — unchanged)', () {
    test('key + address re-derive to the golden vector', () async {
      expect(h(node.privateKey!), expected['privKeyHex']);
      final a = tron.TronAdapter();
      final acct = await a.deriveAccount(RootSecret(seed: seed));
      expect(acct.address, expected['base58Address']);
      expect(acct.path, V['path']);
      expect(acct.scheme, 'secp256k1');
    });

    test('native TRX: txID == sha256(raw_data_hex), 65B sig verifies + recovers',
        () {
      final tx = V['tx'] as Map<String, dynamic>;
      final exp = tx['expected'] as Map<String, dynamic>;
      final rawHex = tx['rawDataHex'] as String;
      final txId = h(c.sha256(hx(rawHex)));
      expect(txId, exp['txID']);
      expect(tron.txIdFromRawData(rawHex), exp['txID']);
      final sig = tron.signTxId(hx(txId), node.privateKey!);
      expect(h(sig), exp['signatureHex']);
      expect(sig.length, 65);
      final pub = s.publicKey(node.privateKey!, compressed: false);
      final r = s.bytesToBig(sig.sublist(0, 32));
      final ss = s.bytesToBig(sig.sublist(32, 64));
      final v = sig[64];
      expect(s.verify(hx(txId), s.EcdsaSignature(r, ss, v), pub), isTrue);
      expect(h(s.recover(hx(txId), r, ss, v, false)), h(pub));
    });

    test('TRC-20 USDT: txID == sha256(raw_data_hex), 65B sig verifies + recovers',
        () {
      final tx = V['trc20Tx'] as Map<String, dynamic>;
      final exp = tx['expected'] as Map<String, dynamic>;
      final rawHex = tx['rawDataHex'] as String;
      final txId = h(c.sha256(hx(rawHex)));
      expect(txId, exp['txID']);
      final sig = tron.signTxId(hx(txId), node.privateKey!);
      expect(h(sig), exp['signatureHex']);
      final pub = s.publicKey(node.privateKey!, compressed: false);
      final r = s.bytesToBig(sig.sublist(0, 32));
      final ss = s.bytesToBig(sig.sublist(32, 64));
      expect(s.verify(hx(txId), s.EcdsaSignature(r, ss, sig[64]), pub), isTrue);
    });
  });

  group('decodeTronRawData recovers the transfer from the signed bytes', () {
    test('native golden decodes to exactly {owner, to=TJRyWwFs…, amount=1 TRX}',
        () {
      final tx = V['tx'] as Map<String, dynamic>;
      final d = tron.decodeTronRawData(tx['rawDataHex'] as String);
      expect(d.type, tron.tronTransferContract);
      expect(d.ownerHex, tron.addressToHex(expected['base58Address'] as String));
      expect(d.toHex, tron.addressToHex(recipient));
      expect(d.amount, BigInt.parse(tx['amount'] as String));
      // self-consistency: the declared recipient/amount match the raw bytes.
      expect(d.toHex, tron.addressToHex(tx['to'] as String));
    });

    test('realistic TRC-20 decodes to {owner, contract=USDT, call_value 0, data}',
        () {
      final d = tron.decodeTronRawData(trc20OkRaw);
      expect(d.type, tron.tronTriggerSmartContract);
      expect(d.ownerHex, tron.addressToHex(expected['base58Address'] as String));
      expect(d.contractHex, tron.addressToHex(usdtContract));
      expect(d.callValue, BigInt.zero);
      expect(d.dataHex,
          (tron.trc20TransferSelector + tron.trc20TransferParameter(recipient, '1000000'))
              .toLowerCase());
    });
  });

  group('buildSend fund-safety gate: ACCEPT correct node payload', () {
    test('native: correct payload is signed (signature == golden)', () async {
      final a = _adapterReturning(nativeOkRaw, nativeOkTxId);
      a.unlock(RootSecret(seed: seed));
      final acct = await a.deriveAccount(RootSecret(seed: seed));
      final built =
          await a.buildSend(acct, const SendRequest(to: recipient, amount: '1000000'));
      expect(built.txid, nativeOkTxId);
      final signed = jsonDecode(built.raw) as Map<String, dynamic>;
      expect((signed['signature'] as List).first,
          (V['tx'] as Map)['expected']['signatureHex']);
    });

    test('TRC-20: correct payload is signed (65B signature)', () async {
      final a = _adapterReturning(trc20OkRaw, trc20OkTxId);
      a.unlock(RootSecret(seed: seed));
      final acct = await a.deriveAccount(RootSecret(seed: seed));
      final built = await a.buildSend(
          acct, SendRequest(to: recipient, amount: '1000000', asset: _usdt));
      expect(built.txid, trc20OkTxId);
      final signed = jsonDecode(built.raw) as Map<String, dynamic>;
      final sigHex = (signed['signature'] as List).first as String;
      expect(sigHex.length, 130); // 65 bytes
    });
  });

  group('buildSend fund-safety gate: REJECT tampered node payload (no signature)',
      () {
    Future<void> expectRejected(tron.TronAdapter a, SendRequest req) async {
      await expectLater(
        () async => a.buildSend(await a.deriveAccount(RootSecret(seed: seed)), req),
        throwsA(isA<StateError>()),
      );
    }

    test('native: recipient swapped to attacker is REJECTED', () async {
      final a = _adapterReturning(nativeBadToRaw, nativeBadToTxId);
      a.unlock(RootSecret(seed: seed));
      // the first guard still passes (txID == sha256), so this is the decode gate:
      expect(tron.txIdFromRawData(nativeBadToRaw), nativeBadToTxId);
      await expectRejected(a, const SendRequest(to: recipient, amount: '1000000'));
    });

    test('native: amount inflated is REJECTED', () async {
      final a = _adapterReturning(nativeBadAmtRaw, nativeBadAmtTxId);
      a.unlock(RootSecret(seed: seed));
      expect(tron.txIdFromRawData(nativeBadAmtRaw), nativeBadAmtTxId);
      await expectRejected(a, const SendRequest(to: recipient, amount: '1000000'));
    });

    test('TRC-20: calldata recipient altered is REJECTED', () async {
      final a = _adapterReturning(trc20BadDataRaw, trc20BadDataTxId);
      a.unlock(RootSecret(seed: seed));
      expect(tron.txIdFromRawData(trc20BadDataRaw), trc20BadDataTxId);
      await expectRejected(
          a, SendRequest(to: recipient, amount: '1000000', asset: _usdt));
    });

    test('direct assert: swapped recipient throws "refusing to sign"', () {
      expect(
        () => tron.assertTronRawDataMatches(
          rawDataHex: nativeBadToRaw,
          isTrc20: false,
          ownerAddr: expected['base58Address'] as String,
          to: recipient,
          amount: '1000000',
        ),
        throwsA(isA<StateError>()),
      );
      // the attacker address is what the tampered bytes actually encode
      final d = tron.decodeTronRawData(nativeBadToRaw);
      expect(d.toHex, tron.addressToHex(attacker));
    });
  });

  group('HARDENING A1: duplicate/unexpected protobuf fields are REJECTED', () {
    test('inner-contract dup (second amount) is rejected by the decoder', () {
      // the integrity guard would still pass (txID == sha256(raw))…
      expect(tron.txIdFromRawData(dupAmountRaw), dupAmountTxId);
      // …but the strict decoder refuses the duplicated field.
      expect(() => tron.decodeTronRawData(dupAmountRaw),
          throwsA(isA<FormatException>()));
    });

    test('top-level dup (second expiration) is rejected by the decoder', () {
      expect(tron.txIdFromRawData(dupTopRaw), dupTopTxId);
      expect(() => tron.decodeTronRawData(dupTopRaw),
          throwsA(isA<FormatException>()));
    });

    test('buildSend REJECTS a dup-field node payload (no signature)', () async {
      final a = _adapterReturning(dupAmountRaw, dupAmountTxId);
      a.unlock(RootSecret(seed: seed));
      final acct = await a.deriveAccount(RootSecret(seed: seed));
      await expectLater(
        () async =>
            a.buildSend(acct, const SendRequest(to: recipient, amount: '1000000')),
        throwsA(isA<StateError>()),
      );
    });

    test('the honest golden native raw still decodes (no false positive)', () {
      final d = tron.decodeTronRawData(nativeOkRaw);
      expect(d.type, tron.tronTransferContract);
      expect(d.amount, BigInt.parse('1000000'));
    });
  });

  group('HARDENING A2: MANDATORY intent — signing without intent throws', () {
    test('signTronTxId with intent:null is REFUSED (txID integrity alone)', () {
      expect(
        () => tron.signTronTxId(
          rawDataHex: nativeOkRaw,
          txId: nativeOkTxId,
          priv: node.privateKey!,
          intent: null,
        ),
        throwsA(isA<StateError>()),
      );
    });

    test('signTronTxId with a present+matching intent signs (sig == golden)', () {
      final sig = tron.signTronTxId(
        rawDataHex: nativeOkRaw,
        txId: nativeOkTxId,
        priv: node.privateKey!,
        intent: tron.TronIntent(
          ownerAddr: expected['base58Address'] as String,
          to: recipient,
          amount: '1000000',
          isTrc20: false,
        ),
      );
      expect(sig.length, 65);
      expect(h(sig), (V['tx'] as Map)['expected']['signatureHex']);
    });

    test('signTronTxId with a MISMATCHED intent is refused', () {
      expect(
        () => tron.signTronTxId(
          rawDataHex: nativeOkRaw,
          txId: nativeOkTxId,
          priv: node.privateKey!,
          intent: tron.TronIntent(
            ownerAddr: expected['base58Address'] as String,
            to: attacker, // intent says attacker, bytes say recipient
            amount: '1000000',
            isTrc20: false,
          ),
        ),
        throwsA(isA<StateError>()),
      );
    });
  });

  group('dApp signing bridge (TronLink window.tronWeb)', () {
    test('signTransaction appends a 65-byte sig; txID derived from raw_data_hex', () async {
      final a = _adapterReturning('', '');
      a.unlock(RootSecret(seed: seed));
      final acct = await a.deriveAccount(RootSecret(seed: seed));
      const raw = '0a02abce22080102030405060708';
      final signed = a.signTransaction(acct, {'raw_data_hex': raw, 'raw_data': <String, dynamic>{}});
      final sigs = signed['signature'] as List;
      expect(sigs.length, 1);
      expect((sigs.first as String).length, 130); // 65 bytes
      expect(signed['raw_data_hex'], raw); // body untouched
    });

    test('signTransaction rejects a txID that mismatches raw_data_hex', () async {
      final a = _adapterReturning('', '');
      a.unlock(RootSecret(seed: seed));
      final acct = await a.deriveAccount(RootSecret(seed: seed));
      expect(
        () => a.signTransaction(acct, {'raw_data_hex': '0a02abce', 'txID': 'deadbeef'}),
        throwsA(isA<StateError>()),
      );
    });

    test('signMessageV2 returns a 0x 65-byte signature', () async {
      final a = _adapterReturning('', '');
      a.unlock(RootSecret(seed: seed));
      final acct = await a.deriveAccount(RootSecret(seed: seed));
      final sig = a.signMessageV2(acct, 'hello blockle');
      expect(sig.startsWith('0x'), isTrue);
      expect(sig.length, 2 + 130);
    });
  });
}
