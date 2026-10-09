// Dart port of blockle-extension/multichain.test.js — validates the multi-chain
// account layer against the SAME published, independently-verifiable vectors:
//   • crypto primitives: SHA-256/512, HMAC, RIPEMD-160, Keccak-256, base58check
//   • secp256k1: pubkey derivation + RFC6979 deterministic ECDSA (sipa vector)
//   • BIP39 seed (Trezor vector) + BIP32 derivation (BIP32 Test Vector 1)
//   • address derivation: EIP-55, BIP84 P2WPKH (BTC/LTC), legacy P2PKH (DOGE)
//   • tx building: ERC-20 calldata, EIP-1559 (sender recovery), BIP143 segwit
//     sighash (exact spec vector) + full UTXO build self-consistency
//   • registry derivation (no network)
import 'dart:typed_data';

import 'package:blockle_app/multichain/chains/chain_adapter.dart';
import 'package:blockle_app/multichain/chains/evm.dart' as e;
import 'package:blockle_app/multichain/chains/registry.dart';
import 'package:blockle_app/multichain/chains/utxo.dart' as u;
import 'package:blockle_app/multichain/crypto/address.dart' as a;
import 'package:blockle_app/multichain/crypto/crypto_core.dart' as c;
import 'package:blockle_app/multichain/crypto/hd.dart' as hd;
import 'package:blockle_app/multichain/crypto/secp256k1.dart' as s;
import 'package:flutter_test/flutter_test.dart';

String h(List<int> b) => c.bytesToHex(b);
Uint8List te(String str) => c.utf8Bytes(str);
const abandon =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

void main() {
  group('crypto-core', () {
    test('sha256(abc)', () {
      expect(h(c.sha256(te('abc'))),
          'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });
    test('sha512(abc)', () {
      expect(h(c.sha512(te('abc'))),
          'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f');
    });
    test('ripemd160(abc)', () {
      expect(h(c.ripemd160(te('abc'))), '8eb208f7e05d987a9b044a8e98c6b087f15a0bfc');
    });
    test('keccak256(abc)', () {
      expect(h(c.keccak256(te('abc'))),
          '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
    });
    test('hmac-sha512 rfc4231', () {
      expect(
          h(c.hmacSha512(c.hexToBytes('0b' * 20), te('Hi There'))),
          '87aa7cdea5ef619d4ff0b4241a1d6cb02379f4e2ce4ec2787ad0b30545e17cdedaa833b7d6b8a702038b274eaea3f4e4be9d914eeb61f1702e696c203a126854');
    });
    test('hash160(abc)', () {
      expect(h(c.hash160(te('abc'))), 'bb1be98c142444d7a56aa3981c3942a978e4dc33');
    });
    test('base58check roundtrip', () {
      final payload = c.hexToBytes('00010966776006953d5567439e5e39f86a0d273bee');
      final enc = c.base58checkEncode(payload);
      expect(enc, '16UwLL9Risc3QfPqBUvKofHmBQ7wMtjvM');
      expect(h(c.base58checkDecode(enc)), h(payload));
    });
  });

  group('secp256k1 (sipa RFC6979 vector)', () {
    final priv = c.hexToBytes('1'.padLeft(64, '0'));
    test('pub(1) compressed', () {
      expect(h(s.publicKey(priv)),
          '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
    });
    test('rfc6979 r/s + verify', () {
      final msg = c.sha256(te(
          'Everything should be made as simple as possible, but not simpler.'));
      final sig = s.sign(msg, priv);
      expect(sig.rHex,
          '33a69cd2065432a30f3d1ce4eb0d59b8ab58c74f27c41a7fdb5696ad4e6108c9');
      expect(sig.sHex,
          '6f807982866f785d3f6418d24163ddae117b7db4d5fdf0071de069fa54342262');
      expect(s.verify(msg, sig, s.publicKey(priv)), isTrue);
    });
  });

  group('BIP39 seed + BIP32 Test Vector 1', () {
    test('bip39 trezor seed', () {
      expect(h(hd.mnemonicToSeed(abandon, 'TREZOR')),
          'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04');
    });
    test('bip39 validate / reject', () {
      expect(hd.validateMnemonic(abandon), isTrue);
      expect(hd.validateMnemonic('abandon abandon zoo'), isFalse);
    });
    test('bip32 vectors', () {
      final seed = c.hexToBytes('000102030405060708090a0b0c0d0e0f');
      expect(hd.serialize(hd.masterFromSeed(seed), false),
          'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi');
      expect(hd.serialize(hd.derivePath(seed, "m/0'"), true),
          'xpub68Gmy5EdvgibQVfPdqkBBCHxA5htiqg55crXYuXoQRKfDBFA1WEjWgP6LHhwBZeNK1VTsfTFUHCdrfp1bgwQ9xv5ski8PX9rL2dZXvgGDnw');
      expect(
          hd.serialize(
              hd.derivePath(seed, "m/0'/1/2'/2/1000000000"), false),
          'xprvA41z7zogVVwxVSgdKUHDy1SKmdb533PjDz7J6N6mV6uS3ze1ai8FHa8kmHScGpWmj4WggLyQjgPie1rFSruoUihUZREPSL39UNdE3BBDu76');
    });
  });

  group('address derivation (abandon mnemonic)', () {
    final seed = hd.mnemonicToSeed(abandon, '');
    test('eth privkey + EIP-55 address', () {
      final eth = hd.derivePath(seed, "m/44'/60'/0'/0/0");
      expect(h(eth.privateKey!),
          '1ab42cc412b618bdea3a599e3c9bae199ebf030895b039e9db1e30dafb12b727');
      expect(a.evmAddress(eth.publicKey),
          '0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
    });
    test('BIP84 BTC/LTC P2WPKH', () {
      expect(a.p2wpkh(hd.derivePath(seed, "m/84'/0'/0'/0/0").publicKey, 'bc'),
          'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
      expect(a.p2wpkh(hd.derivePath(seed, "m/84'/2'/0'/0/0").publicKey, 'ltc'),
          'ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh');
    });
    test('DOGE P2PKH + eip55 known', () {
      expect(a.p2pkh(hd.derivePath(seed, "m/44'/3'/0'/0/0").publicKey, 0x1e),
          'DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC');
      expect(a.toChecksumAddress('0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359'),
          '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359');
    });
  });

  group('EVM tx building', () {
    test('erc20 transfer calldata', () {
      expect(
          e.erc20TransferData('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '1'),
          '0xa9059cbb0000000000000000000000005aaeb6053f3e94c9b9a09f33669435e7ef1beaed0000000000000000000000000000000000000000000000000000000000000001');
    });
    test('eip1559 sender recovers + typed-2', () {
      final seed = hd.mnemonicToSeed(abandon, '');
      final node = hd.derivePath(seed, "m/44'/60'/0'/0/0");
      final from = a.evmAddress(node.publicKey);
      final tx = {
        'chainId': 1,
        'nonce': BigInt.zero,
        'maxPriorityFeePerGas': BigInt.from(1000000000),
        'maxFeePerGas': BigInt.from(20000000000),
        'gasLimit': BigInt.from(21000),
        'to': '0x3535353535353535353535353535353535353535',
        'value': BigInt.from(10).pow(18),
        'data': '0x',
      };
      final signed = e.signEip1559(tx, node.privateKey!);
      final hash = c.hexToBytes(signed.sigHash!.substring(2));
      final sig = s.sign(hash, node.privateKey!);
      final rec = a.evmAddress(s.recover(hash, sig.r, sig.s, sig.recovery, false));
      expect(rec.toLowerCase(), from.toLowerCase());
      expect(signed.raw.startsWith('0x02'), isTrue);
      expect(RegExp(r'^0x[0-9a-f]{64}$').hasMatch(signed.txid), isTrue);
    });
    test('erc20 approve/allowance calldata', () {
      const spender = '0x1111111254EEB25477B68fb85Ed929f73A960582';
      expect(e.erc20ApproveData(spender),
          '0x095ea7b30000000000000000000000001111111254eeb25477b68fb85ed929f73a960582ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
      expect(e.erc20ApproveData(spender, BigInt.from(1000)),
          '0x095ea7b30000000000000000000000001111111254eeb25477b68fb85ed929f73a96058200000000000000000000000000000000000000000000000000000000000003e8');
      expect(
          e.erc20AllowanceData(
              '0x9858EfFD232B4033E47d90003D41EC34EcaEda94', spender),
          '0xdd62ed3e0000000000000000000000009858effd232b4033e47d90003d41ec34ecaeda940000000000000000000000001111111254eeb25477b68fb85ed929f73a960582');
    });
    test('formatUnits values', () {
      expect(e.formatUnits('1500000000000000000', 18), '1.5');
      expect(e.formatUnits('1234567', 6), '1.234567');
    });
  });

  group('UTXO tx building', () {
    test('BIP143 sighash + DER + pubkey (exact spec vector)', () {
      const le0 =
          'fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f';
      const le1 =
          'ef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a';
      final inputs = [
        u.UtxoInput(h(c.hexToBytes(le0).reversed.toList()), 0, 0xffffffee),
        u.UtxoInput(h(c.hexToBytes(le1).reversed.toList()), 1, 0xffffffff),
      ];
      final outputs = [
        u.UtxoOutput(
            c.hexToBytes('76a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac'),
            BigInt.from(112340000)),
        u.UtxoOutput(
            c.hexToBytes('76a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac'),
            BigInt.from(223450000)),
      ];
      final scriptCode =
          c.hexToBytes('76a9141d0f172a0ecb48aee1be1f2687d2963ae33f71a188ac');
      final sh = u.sighashSegwit(1, inputs, outputs, 1, scriptCode,
          BigInt.from(600000000), 0xffffffff, 0x11, 0x01);
      expect(h(sh),
          'c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670');
      final priv = c.hexToBytes(
          '619c335025c7f4012e556c2a58b2506e30b8511b53ade95ea316fd8c3286feb9');
      final sig = s.sign(sh, priv);
      expect('${h(sig.der)}01',
          '304402203609e17b84f6a7d30c80bfa610b5b4542f32a8a0d5447a12fb1366d7f01cc44a0220573a954c4518331561406f90300e8f3358f51928d43c212a8caed02de67eebee01');
      expect(h(s.publicKey(priv)),
          '025476c2e83188368da1ff3e292e7acafcdb3566bb0ad253f62fc70f07aeee6357');
    });

    test('full build self-consistency: BTC segwit + DOGE legacy', () {
      final seed = hd.mnemonicToSeed(abandon, '');
      final net = u.networks['bitcoin']!;
      final node = hd.derivePath(seed, '${net.path}/0');
      final from = a.p2wpkh(node.publicKey, 'bc');
      final built = u.buildAndSign(net, node, from, {
        'to': 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
        'amount': '120000',
        'feeRate': 10,
        'utxos': [
          {'txid': 'a' * 64, 'vout': 0, 'value': '100000'},
          {'txid': 'b' * 64, 'vout': 1, 'value': '50000'},
        ],
      });
      expect(built.raw.substring(8, 12), '0001'); // segwit marker
      expect(RegExp(r'^[0-9a-f]{64}$').hasMatch(built.txid), isTrue);
      expect(
          built.signedInputs.every((si) =>
              h(s.recover(si.sighash, si.sig.r, si.sig.s, si.sig.recovery, true)) ==
              h(node.publicKey)),
          isTrue);

      final dnet = u.networks['dogecoin']!;
      final dnode = hd.derivePath(seed, '${dnet.path}/0');
      final dfrom = a.p2pkh(dnode.publicKey, dnet.p2pkh);
      final dbuilt = u.buildAndSign(dnet, dnode, dfrom, {
        'to': dfrom,
        'amount': '100000000',
        'feeRate': 1000,
        'utxos': [
          {'txid': 'c' * 64, 'vout': 0, 'value': '500000000'},
        ],
      });
      expect(dbuilt.raw.substring(8, 12) != '0001', isTrue); // no segwit marker
      expect(
          dbuilt.signedInputs.every((si) =>
              h(s.recover(si.sighash, si.sig.r, si.sig.s, si.sig.recovery, true)) ==
              h(dnode.publicKey)),
          isTrue);

      expect(
          () => u.buildAndSign(net, node, from, {
                'to': from,
                'amount': '999999999',
                'feeRate': 10,
                'utxos': [
                  {'txid': 'a' * 64, 'vout': 0, 'value': '100000'},
                ],
              }),
          throwsStateError);
    });
  });

  group('registry derivation (no network)', () {
    test('eth==base key, addresses, enabled, tokens', () async {
      final reg = ChainRegistry.create();
      final seed = hd.mnemonicToSeed(abandon, '');
      final root = RootSecret(seed: seed);
      reg.unlock(root);
      final eth = await reg.get('ethereum').deriveAccount(root);
      final base = await reg.get('base').deriveAccount(root);
      expect(eth.address.toLowerCase(), base.address.toLowerCase());
      expect(eth.address, '0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
      final btc = await reg.get('bitcoin').deriveAccount(root);
      expect(btc.address, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
      expect(reg.enabled().contains('ethereum'), isTrue);
      expect(reg.enabled().contains('bitcoin'), isTrue);
      expect(reg.tokensFor('ethereum').any((t) => t.symbol == 'USDC'), isTrue);
    });
  });
}
