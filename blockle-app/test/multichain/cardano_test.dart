// cardano_test.dart — the Cardano adapter gate for the Flutter port. THE HARDEST
// chain; the golden vector is the hard cross-port gate.
//
// Asserts, against the SHARED cross-port vector docs/cardano-vectors.json (whose
// Icarus master, CIP-1852 payment+stake pubkeys and addr1 address were
// CROSS-CHECKED BYTE-IDENTICAL against the independent bip_utils
// CardanoIcarus/CIP-1852/AdaShelleyAddr reference, and whose tx body + extended
// signature were re-verified against an independent pure-Python reference), that
// the Dart port reproduces every value byte-for-byte, all OFFLINE:
//   (a) blake2b KATs at 28- and 32-byte lengths (cred + txHash).
//   (b) canonical CBOR KATs (minimal-width uints + bstr/array/map encodings).
//   (c) Icarus (CIP-3) master key from the BIP39 ENTROPY (kL||kR||cc, clamped).
//   (d) BIP32-Ed25519 (CIP-1852) m/1852'/1815'/0'/{0,2}/0 -> payment+stake
//       pubkeys -> Shelley base addr1; address validation.
//   (e) tx_body CBOR byte-exact; txHash = blake2b256(body); ed25519-BIP32
//       signExtended byte-exact + VERIFIES under standard ed25519.verify; full
//       signed-tx CBOR byte-exact.
//   (f) adapter wiring: deriveAccount reproduces addr1; client-built buildSend
//       (UTXO + ttl injected offline) reproduces the golden signed-tx hex.
import 'dart:convert';
import 'dart:io';

import 'package:blockle_app/multichain/chains/cardano.dart' as cardano;
import 'package:blockle_app/multichain/chains/cardano_cbor.dart' as cbor;
import 'package:blockle_app/multichain/chains/chain_adapter.dart';
import 'package:blockle_app/multichain/crypto/address.dart' as addr;
import 'package:blockle_app/multichain/crypto/bip32_ed25519.dart' as b32;
import 'package:blockle_app/multichain/crypto/crypto_core.dart' as c;
import 'package:blockle_app/multichain/crypto/ed25519.dart' as ed;
import 'package:flutter_test/flutter_test.dart';

String h(List<int> b) => c.bytesToHex(b);

Map<String, dynamic> _loadVectors() {
  final f = File('../docs/cardano-vectors.json');
  if (!f.existsSync()) {
    throw StateError('cardano vector not found (../docs/cardano-vectors.json)');
  }
  return jsonDecode(f.readAsStringSync()) as Map<String, dynamic>;
}

void main() {
  final V = _loadVectors();
  final entropy = c.hexToBytes(V['icarus']['entropyHex'] as String);
  final deriv = V['derivation'] as Map<String, dynamic>;
  final address = V['address'] as Map<String, dynamic>;
  final recipient = V['recipient'] as Map<String, dynamic>;
  final tx = V['tx'] as Map<String, dynamic>;

  group('discoverTokens: native-asset auto-detect over a mocked Koios UTXO read',
      () {
    // 56-hex policy id + asset_name 54455354 ("TEST") -> unit = policy+nameHex.
    const policy = 'abababababababababababababababababababababababababababab';
    const unit = '${policy}54455354';
    cardano.CardanoAdapter adapter(String body) =>
        cardano.CardanoAdapter(post: (p, b) async => body);

    test('aggregated native assets map to native-asset Balances (display-only)',
        () async {
      final body = jsonEncode([
        {
          'tx_hash': 'aa',
          'value': '2000000',
          'asset_list': [
            {'policy_id': policy, 'asset_name': '54455354', 'quantity': '4'}
          ]
        },
        {
          'tx_hash': 'bb',
          'value': '3000000',
          'asset_list': [
            {'policy_id': policy, 'asset_name': '54455354', 'quantity': '3'}
          ]
        }
      ]);
      final rows = await adapter(body).discoverTokens('addr1xyz');
      expect(rows.length, 1);
      final b = rows.first;
      expect(b.asset.chain, 'cardano');
      expect(b.asset.kind, 'native-asset');
      expect(b.asset.symbol, 'TEST'); // hex 54455354 decoded
      expect(b.asset.decimals, 0);
      expect(b.asset.address, unit);
      expect(b.confirmed, '7'); // 4 + 3 aggregated
    });

    test('an ADA-only UTXO set yields []; a network throw => []', () async {
      final body = jsonEncode([
        {'tx_hash': 'aa', 'value': '2000000', 'asset_list': []}
      ]);
      expect(await adapter(body).discoverTokens('addr1'), isEmpty);
      final thrower =
          cardano.CardanoAdapter(post: (p, b) async => throw StateError('net'));
      expect(await thrower.discoverTokens('addr1'), isEmpty);
    });
  });

  group('(a) blake2b KATs (cred 28B + txHash 32B)', () {
    test('empty + "abc" at 28 and 32 bytes', () {
      for (final kat in V['blake2bKats'] as List) {
        final msg = kat[0] as String;
        final want = kat[1] as String;
        final outLen = kat[2] as int;
        expect(h(c.blake2b(c.utf8Bytes(msg), outLen: outLen)), want,
            reason: 'blake2b("$msg", $outLen)');
      }
    });
  });

  group('(b) canonical CBOR KATs', () {
    final kats = V['cborKats'] as Map<String, dynamic>;
    test('minimal-width unsigned ints', () {
      for (final kat in kats['uint'] as List) {
        final n = kat[0] as int;
        expect(h(cbor.cborUintBig(BigInt.from(n))), kat[1] as String,
            reason: 'cborUint($n)');
      }
    });
    test('byte strings', () {
      for (final kat in kats['bstr'] as List) {
        final hex = kat[0] as String;
        expect(h(cbor.cborBytes(c.hexToBytes(hex))), kat[1] as String,
            reason: 'cborBytes($hex)');
      }
    });
    test('array [1,2,3] + map {0:1,2:3}', () {
      expect(
          h(cbor.cborArray(
              [cbor.cborUint(1), cbor.cborUint(2), cbor.cborUint(3)])),
          kats['array']);
      expect(
          h(cbor.cborMap([
            [cbor.cborUint(0), cbor.cborUint(1)],
            [cbor.cborUint(2), cbor.cborUint(3)],
          ])),
          kats['map']);
    });
  });

  group('(c) Icarus (CIP-3) master key from entropy', () {
    test('PBKDF2-HMAC-SHA512 + clamp -> kL||kR||cc', () {
      final m = b32.icarusMasterKey(entropy);
      expect(h(c.concatBytes([m.kL, m.kR, m.cc])),
          V['icarus']['masterKeyHex96']);
    });
  });

  late b32.Bip32Ed25519Node payNode;
  late b32.Bip32Ed25519Node stakeNode;

  group('(d) BIP32-Ed25519 (CIP-1852) derivation -> addr1', () {
    test('payment + stake pubkeys (cross-checked vs bip_utils)', () {
      payNode = b32.derivePath(entropy, deriv['paymentPath'] as String);
      stakeNode = b32.derivePath(entropy, deriv['stakePath'] as String);
      expect(h(payNode.a), deriv['paymentPubHex32']);
      expect(h(stakeNode.a), deriv['stakePubHex32']);
      // paymentXpubHex = A || chainCode
      expect(h(c.concatBytes([payNode.a, payNode.cc])),
          deriv['paymentXpubHex']);
    });
    test('credentials + Shelley base address bytes + addr1 bech32', () {
      expect(h(cardano.credential(payNode.a)), address['paymentCredHex28']);
      expect(h(cardano.credential(stakeNode.a)), address['stakeCredHex28']);
      expect(h(cardano.baseAddressBytes(payNode.a, stakeNode.a)),
          address['addressBytesHex57']);
      expect(cardano.baseAddress(payNode.a, stakeNode.a), address['bech32']);
    });
    test('recipient addr1 (payment index 1, same stake)', () {
      final pay1 = b32.derivePath(entropy, "m/1852'/1815'/0'/0/1");
      expect(cardano.baseAddress(pay1.a, stakeNode.a), recipient['bech32']);
    });
    test('address validation (isCardanoAddress)', () {
      expect(cardano.isCardanoAddress(address['bech32'] as String), true);
      expect(cardano.isCardanoAddress(recipient['bech32'] as String), true);
      expect(cardano.isCardanoAddress('addr1bogus'), false);
      expect(cardano.isCardanoAddress('bc1qxyz'), false);
      expect(cardano.isCardanoAddress(''), false);
    });
  });

  group('(e) tx_body CBOR + txHash + signExtended + signed tx (byte-exact)', () {
    final inp = (tx['inputs'] as List)[0] as Map<String, dynamic>;
    final outs = (tx['outputs'] as List).cast<Map<String, dynamic>>();

    test('tx_body CBOR byte-exact + txHash', () {
      final body = cbor.encodeTxBody(
        inputs: [
          cbor.CardanoTxIn(
              c.hexToBytes(inp['txHashHex'] as String), inp['index'] as int),
        ],
        outputs: [
          for (final o in outs)
            cbor.CardanoTxOut(addr.bech32Decode('addr', o['address'] as String),
                BigInt.parse(o['coin'] as String)),
        ],
        fee: BigInt.parse(tx['fee'] as String),
        ttl: tx['ttl'] as int,
      );
      expect(h(body), tx['txBodyCborHex']);
      expect(h(c.blake2b(body, outLen: 32)), tx['txHashHex']);
    });

    test('signExtended byte-exact + VERIFIES under standard ed25519.verify', () {
      final node = b32.derivePath(entropy, deriv['paymentPath'] as String);
      final txHash = c.hexToBytes(tx['txHashHex'] as String);
      final sig = ed.signExtended(txHash, node.kL, node.kR, node.a);
      expect(h(sig), tx['signatureHex64']);
      // A BIP32-Ed25519 extended-key sig MUST verify under the STANDARD ed25519
      // verify with the compressed public key as the vkey.
      expect(ed.verify(txHash, sig, node.a), true);
      expect(h(node.a), tx['vkeyHex32']);
    });

    test('full signed-tx CBOR byte-exact', () {
      final node = b32.derivePath(entropy, deriv['paymentPath'] as String);
      final body = c.hexToBytes(tx['txBodyCborHex'] as String);
      final sig = c.hexToBytes(tx['signatureHex64'] as String);
      final signed = cbor.encodeSignedTx(body, node.a, sig);
      expect(h(signed), tx['signedTxCborHex']);
    });
  });

  group('(f) adapter wiring (offline)', () {
    final adapter = cardano.CardanoAdapter();
    final root = RootSecret(entropy: entropy);
    adapter.unlock(root);

    test('deriveAccount reproduces the golden addr1', () async {
      final acct = await adapter.deriveAccount(root, index: 0);
      expect(acct.chain, 'cardano');
      expect(acct.scheme, 'ed25519-bip32');
      expect(acct.address, address['bech32']);
      expect(acct.publicKey, deriv['paymentPubHex32']);
      expect(acct.path, deriv['paymentPath']);
    });

    test('buildSend (UTXO + ttl injected offline) == golden signed tx', () async {
      final acct = await adapter.deriveAccount(root, index: 0);
      final inp = (tx['inputs'] as List)[0] as Map<String, dynamic>;
      final outs = (tx['outputs'] as List).cast<Map<String, dynamic>>();
      final built = await adapter.buildSend(
        acct,
        SendRequest(
          to: recipient['bech32'] as String,
          amount: outs[0]['coin'] as String,
          memo: (tx['ttl'] as int).toString(), // ttl injected via memo
          utxos: [
            {
              'tx_hash': inp['txHashHex'],
              'tx_index': inp['index'],
              'value': tx['inputTotal'],
            }
          ],
        ),
      );
      expect(built.chain, 'cardano');
      expect(built.fee, tx['fee']);
      expect(built.txid, tx['txHashHex']);
      expect(built.extra?['bodyHex'], tx['txBodyCborHex']);
      expect(built.raw, tx['signedTxCborHex']);
    });

    test('buildSend sendMax drains every input (amount + fee == total, no change)', () async {
      final acct = await adapter.deriveAccount(root, index: 0);
      final inp = (tx['inputs'] as List)[0] as Map<String, dynamic>;
      final total = BigInt.parse(tx['inputTotal'] as String);
      final built = await adapter.buildSend(
        acct,
        SendRequest(
          to: recipient['bech32'] as String,
          amount: '1', // ignored under sendMax
          memo: (tx['ttl'] as int).toString(),
          sendMax: true,
          utxos: [
            {
              'tx_hash': inp['txHashHex'],
              'tx_index': inp['index'],
              'value': tx['inputTotal'],
            }
          ],
        ),
      );
      // Everything is consumed: the sent amount + fee == the inputs, and the
      // sub-min-UTXO remainder folded into the fee (no change output stranded).
      expect(BigInt.parse(built.summary.amount) + BigInt.parse(built.fee), total);
      expect(built.summary.sendMax, isFalse);
      expect(built.extra?['change'], '0');
    });

    test('buildSend rejects non-addr1 destinations + CNT sending', () async {
      final acct = await adapter.deriveAccount(root, index: 0);
      expect(
          () => adapter.buildSend(
              acct, const SendRequest(to: 'bc1qxyz', amount: '1000000')),
          throwsStateError);
      expect(
          () => adapter.buildSend(
              acct,
              SendRequest(
                  to: address['bech32'] as String,
                  amount: '1000000',
                  asset: const AssetRef(
                      chain: 'cardano',
                      kind: 'cnt',
                      symbol: 'FOO',
                      decimals: 0))),
          throwsStateError);
    });

    test('explorerTx', () {
      expect(adapter.explorerTx(tx['txHashHex'] as String),
          '${V['network']['explorerTx']}${tx['txHashHex']}');
    });
  });
}
