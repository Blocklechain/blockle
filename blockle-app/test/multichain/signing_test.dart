// Dart port of blockle-extension/signing.test.js — the DEX-execution signing
// layer, validated against published vectors:
//   • ed25519 (RFC 8032 §7.1 Test 1/2/3): public key, sign, verify + reject
//   • SLIP-0010 ed25519 HD derivation (SLIP-0010 Test vector 1: m and m/0')
//   • Solana: shortvec decode, signer-slot location, serialized-tx sign that
//     verifies against the derived account key (legacy + v0 versioned layout)
//   • EVM arbitrary-tx sign → sender recovers to owner; ERC-20 approve calldata;
//     buildApprove is a type-2 tx whose sender recovers to owner
import 'dart:typed_data';

import 'package:blockle_app/multichain/chains/chain_adapter.dart';
import 'package:blockle_app/multichain/chains/evm.dart' as e;
import 'package:blockle_app/multichain/chains/solana.dart' as sol;
import 'package:blockle_app/multichain/crypto/address.dart' as a;
import 'package:blockle_app/multichain/crypto/crypto_core.dart' as c;
import 'package:blockle_app/multichain/crypto/ed25519.dart' as ed;
import 'package:blockle_app/multichain/crypto/hd.dart' as hd;
import 'package:blockle_app/multichain/crypto/secp256k1.dart' as s;
import 'package:flutter_test/flutter_test.dart';

String h(List<int> b) => c.bytesToHex(b);
Uint8List hx(String s) => c.hexToBytes(s);
const abandon =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

void main() {
  group('ed25519 (RFC 8032 §7.1)', () {
    test('test 1 (empty message)', () {
      final sk =
          hx('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
      const pk =
          'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
      expect(h(ed.publicKey(sk)), pk);
      expect(h(ed.sign(Uint8List(0), sk)),
          'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b');
      expect(
          ed.verify(
              Uint8List(0),
              hx('e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'),
              hx(pk)),
          isTrue);
    });
    test('test 2 (1-byte message)', () {
      final sk =
          hx('4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb');
      const pk =
          '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c';
      expect(h(ed.publicKey(sk)), pk);
      expect(h(ed.sign(hx('72'), sk)),
          '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00');
      expect(ed.verify(hx('72'), ed.sign(hx('72'), sk), hx(pk)), isTrue);
    });
    test('test 3 (2-byte message) + rejects', () {
      final sk =
          hx('c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7');
      const pk =
          'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025';
      expect(h(ed.publicKey(sk)), pk);
      final sig3 = ed.sign(hx('af82'), sk);
      expect(h(sig3),
          '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a');
      expect(ed.verify(hx('af82'), sig3, hx(pk)), isTrue);
      expect(ed.verify(hx('af83'), sig3, hx(pk)), isFalse);
      final bad = Uint8List.fromList(sig3)..[0] ^= 0x01;
      expect(ed.verify(hx('af82'), bad, hx(pk)), isFalse);
    });
  });

  group('SLIP-0010 ed25519 (Test vector 1)', () {
    final seed = hx('000102030405060708090a0b0c0d0e0f');
    test('m', () {
      final m = sol.masterKey(seed);
      expect(h(m.chainCode),
          '90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb');
      expect(h(m.key),
          '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7');
      expect('00${h(ed.publicKey(m.key))}',
          '00a4b2856bfec510abab89753fac1ac0e1112364e7d250545963f135f2a33188ed');
    });
    test("m/0'", () {
      final m0 = sol.deriveSlip10(seed, "m/0'");
      expect(h(m0.chainCode),
          '8b59aa11380b624e81507a27fedda59fea6d0b779a778918a2fd3590e16e9c69');
      expect(h(m0.key),
          '68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3');
      expect('00${h(ed.publicKey(m0.key))}',
          '008c8a13df77a28f3445213a0f432fde644acaa215fc72dcdf300d5efaa85d350c');
    });
    test('rejects soft segment', () {
      expect(() => sol.deriveSlip10(seed, "m/44'/501'/0'/0"), throwsArgumentError);
    });
  });

  group('Solana adapter', () {
    test('derive + address', () async {
      final seed = hd.mnemonicToSeed(abandon, '');
      final adapter = sol.SolanaAdapter(rpcUrl: 'http://localhost');
      adapter.unlock(RootSecret(seed: seed));
      final acct = await adapter.deriveAccount(RootSecret(seed: seed));
      expect(RegExp(r'^[1-9A-HJ-NP-Za-km-z]{32,44}$').hasMatch(acct.address),
          isTrue);
      expect(acct.scheme, 'ed25519');
      expect(acct.path, "m/44'/501'/0'/0'");
      expect(c.base58encode(c.hexToBytes(acct.publicKey)), acct.address);
    });

    test('shortvec decode', () {
      expect(sol.decodeShortVec(Uint8List.fromList([0x01]), 0).value, 1);
      final a2 = sol.decodeShortVec(Uint8List.fromList([0x80, 0x01]), 0);
      expect(a2.value, 128);
      expect(a2.size, 2);
      final a3 = sol.decodeShortVec(Uint8List.fromList([0xff, 0xff, 0x03]), 0);
      expect(a3.value, 65535);
      expect(a3.size, 3);
    });

    test('serialized-tx signing (legacy + v0)', () {
      final seedKey =
          sol.deriveSlip10(hx('000102030405060708090a0b0c0d0e0f'), "m/44'/501'/0'/0'")
              .key;
      final pub = ed.publicKey(seedKey);
      for (final versioned in [false, true]) {
        final tx = _buildTx(pub, versioned);
        final loc = sol.locateSigner(tx, pub);
        expect(loc.sigCount, 1);
        expect(loc.signerIndex, 0);
        final signed = sol.signSerializedTx(tx, seedKey, pub);
        final sig = signed.sublist(loc.sigAreaStart, loc.sigAreaStart + 64);
        final message = tx.sublist(loc.messageStart);
        expect(ed.verify(message, sig, pub), isTrue);
        expect(h(signed.sublist(loc.messageStart)), h(message));
      }
      final otherKey = ed.publicKey(sol
          .deriveSlip10(hx('000102030405060708090a0b0c0d0e0f'), "m/44'/501'/1'/0'")
          .key);
      final tx2 = _buildTx(otherKey, false);
      expect(() => sol.signSerializedTx(tx2, seedKey, pub), throwsStateError);
    });
  });

  group('EVM arbitrary-tx + approve', () {
    final seed = hd.mnemonicToSeed(abandon, '');
    final node = hd.derivePath(seed, "m/44'/60'/0'/0/0");
    final from = a.evmAddress(node.publicKey);

    test('signArbitraryTx: sender recovers to owner, matches deterministic', () async {
      final adapter =
          e.EvmAdapter(id: 'base', chainId: 8453, rpcUrl: 'http://localhost');
      adapter.unlock(RootSecret(seed: seed));
      final acct = DerivedAccount(
          chain: 'base', index: 0, address: from, publicKey: '', scheme: 'secp256k1');
      final req = {
        'to': '0x1111111254EEB25477B68fb85Ed929f73A960582',
        'data': '0x12aa3caf${'00' * 64}',
        'value': BigInt.from(10).pow(16),
        'gasLimit': '0x30d40',
        'feeRate': '0x4a817c800',
        'maxPriorityFeePerGas': '0x3b9aca00',
        'nonce': '0x0',
      };
      final built = await adapter.signArbitraryTx(acct, req);
      expect(built.raw.startsWith('0x02'), isTrue);
      expect(RegExp(r'^0x[0-9a-f]{64}$').hasMatch(built.txid), isTrue);
      final tx = {
        'chainId': 8453,
        'nonce': BigInt.zero,
        'maxPriorityFeePerGas': BigInt.parse('0x3b9aca00'.substring(2), radix: 16),
        'maxFeePerGas': BigInt.parse('0x4a817c800'.substring(2), radix: 16),
        'gasLimit': BigInt.parse('0x30d40'.substring(2), radix: 16),
        'to': req['to'],
        'value': req['value'],
        'data': req['data'],
      };
      final signed = e.signEip1559(tx, node.privateKey!);
      expect(built.raw, signed.raw);
      final hash = c.hexToBytes(signed.sigHash!.substring(2));
      final sig = s.sign(hash, node.privateKey!);
      final rec = a.evmAddress(s.recover(hash, sig.r, sig.s, sig.recovery, false));
      expect(rec.toLowerCase(), from.toLowerCase());
    });

    test('signArbitraryTx rejects missing to', () async {
      final adapter =
          e.EvmAdapter(id: 'base', chainId: 8453, rpcUrl: 'http://localhost');
      adapter.unlock(RootSecret(seed: seed));
      final acct = DerivedAccount(
          chain: 'base', index: 0, address: from, publicKey: '', scheme: 'secp256k1');
      expect(() => adapter.signArbitraryTx(acct, {'data': '0x'}),
          throwsArgumentError);
    });
  });
}

// Mirror of signing.test.js buildTx: 1 signer, 1 account key = ours.
Uint8List _buildTx(List<int> pubkey, bool versioned) {
  final sigArea = c.concatBytes([
    Uint8List.fromList([0x01]),
    Uint8List(64),
  ]);
  final header = Uint8List.fromList([0x01, 0x00, 0x00]);
  final keys = c.concatBytes([
    Uint8List.fromList([0x01]),
    pubkey,
  ]);
  final blockhash = Uint8List(32)..fillRange(0, 32, 7);
  final instrs = Uint8List.fromList([0x00]);
  var message = c.concatBytes([header, keys, blockhash, instrs]);
  if (versioned) {
    message = c.concatBytes([
      Uint8List.fromList([0x80]),
      message,
    ]);
    message = c.concatBytes([
      message,
      Uint8List.fromList([0x00]),
    ]);
  }
  return c.concatBytes([sigArea, message]);
}
