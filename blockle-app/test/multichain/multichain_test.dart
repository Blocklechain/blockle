// Dart port of blockle-extension/multichain.test.js — validates the multi-chain
// account layer against the SAME published, independently-verifiable vectors:
//   • crypto primitives: SHA-256/512, HMAC, RIPEMD-160, Keccak-256, base58check
//   • secp256k1: pubkey derivation + RFC6979 deterministic ECDSA (sipa vector)
//   • BIP39 seed (Trezor vector) + BIP32 derivation (BIP32 Test Vector 1)
//   • address derivation: EIP-55, BIP84 P2WPKH (BTC/LTC), legacy P2PKH (DOGE)
//   • tx building: ERC-20 calldata, EIP-1559 (sender recovery), BIP143 segwit
//     sighash (exact spec vector) + full UTXO build self-consistency
//   • registry derivation (no network)
import 'dart:convert';
import 'dart:typed_data';

import 'package:blockle_app/multichain/chains/chain_adapter.dart';
import 'package:blockle_app/multichain/chains/evm.dart' as e;
import 'package:blockle_app/multichain/chains/registry.dart';
import 'package:blockle_app/multichain/chains/solana.dart' show splTokenProgram;
import 'package:blockle_app/multichain/chains/tron.dart' as tr;
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

  // ---- Bitcoin Cash (CashAddr + BIP143 FORKID 0x41) -----------------------
  // THE GATE: these expected values were produced by an INDEPENDENT reference
  // (coincurve / libsecp256k1 + a from-spec CashAddr codec validated against the
  // published legacy<->cashaddr pairs), NOT by this port. All 4 wallets must
  // reproduce them byte-for-byte before BCH signing touches real funds.
  group('Bitcoin Cash (CashAddr + FORKID sighash)', () {
    // THE shared cross-wallet fixture — docs/bch-vectors.json. Same inputs,
    // same expected bytes as the extension, web vendor and Python ports.
    const toCash = 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';
    const toLegacy = '1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu';
    const expSignedRaw =
        '0100000002aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa000000006a473044022045fe408740f38fb99760e24cb1655cba521cc06bc3017ad3b46dc844ae6bd56102205776349c08f4c615fdfb89960baf14c6c1c1fb6daaae46c7a8ab471cdc6a993c412102bbe7dbcdf8b2261530a867df7180b17a90b482f74f2736b8a30d3f756e42e217ffffffffbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb010000006a473044022020ce30ef15c54e6723cfa453d4ef80a07453fdbd9340af575638f50f4c8ceb1d02203c1b7392f2706268714d26f79460914d79202e29f4b210314cb42274b3abf3db412102bbe7dbcdf8b2261530a867df7180b17a90b482f74f2736b8a30d3f756e42e217ffffffff02c0d40100000000001976a91476a04053bda0a88bda5177b86a15c3b29f55987388ace26d0000000000001976a914086a977c7dad32a56996af2ce90a727238d4899888ac00000000';
    const expTxid =
        '660810784f5f726d09132f220004bf3c1416b188cedd0ed030a8fedcfff37ad5';
    const expSighash0 =
        '876731cd34024074ce64cd6d6c9324f7158c4ae7ce48d367d322560432f94fa2';

    test('CashAddr codec vs published spec pairs + roundtrip', () {
      // Published legacy<->CashAddr pairs (Bitcoin ABC spec).
      for (final pair in const [
        ['1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu',
         'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'],
        ['1KXrWXciRDZUpQwQmuM1DbwsKDLYAYsVLR',
         'bitcoincash:qr95sy3j9xwd2ap32xkykttr4cvcu7as4y0qverfuy'],
      ]) {
        final h160 = c.base58checkDecode(pair[0]).sublist(1);
        expect(a.cashAddrEncode('bitcoincash', 0, h160), pair[1]);
        final dec = a.cashAddrDecode(pair[1]);
        expect(h(dec.hash), h(h160));
        expect(dec.type, 0);
      }
    });

    test('derive CashAddr + legacy from seed (golden)', () {
      final seed = hd.mnemonicToSeed(abandon, '');
      final net = u.networks['bitcoincash']!;
      final node = hd.derivePath(seed, '${net.path}/0');
      expect(a.cashAddrP2pkh(node.publicKey, 'bitcoincash'),
          'bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6');
      expect(a.p2pkh(node.publicKey, net.p2pkh), '1mW6fDEMjKrDHvLvoEsaeLxSCzZBf3Bfg');
      expect(h(node.publicKey),
          '02bbe7dbcdf8b2261530a867df7180b17a90b482f74f2736b8a30d3f756e42e217');
      // CashAddr decode round-trips to the same hash160 as the legacy form.
      final dec = a.cashAddrDecode('bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6');
      expect(h(dec.hash), h(c.hash160(node.publicKey)));
    });

    test('addressToScript accepts BOTH CashAddr and legacy (same script)', () {
      final net = u.networks['bitcoincash']!;
      expect(h(u.addressToScript(toCash, net)), h(u.addressToScript(toLegacy, net)));
    });

    test('buildAndSign byte-identical signed tx + FORKID sighash (golden)', () {
      final seed = hd.mnemonicToSeed(abandon, '');
      final net = u.networks['bitcoincash']!;
      final node = hd.derivePath(seed, '${net.path}/0');
      final from = a.cashAddrP2pkh(node.publicKey, 'bitcoincash');
      final built = u.buildAndSign(net, node, from, {
        'to': toCash,
        'amount': '120000',
        'feeRate': 5,
        'utxos': [
          {'txid': 'a' * 64, 'vout': 0, 'value': '100000'},
          {'txid': 'b' * 64, 'vout': 1, 'value': '50000'},
        ],
      });
      expect(built.raw, expSignedRaw); // byte-identical
      expect(built.txid, expTxid);
      expect(built.fee, '1870');
      expect(built.sighashes[0], expSighash0); // FORKID sighash of input 0
      expect(built.raw.substring(8, 12) != '0001', isTrue); // NO segwit marker
      // sig recovers to owner pubkey over the 0x41 sighash
      expect(
          built.signedInputs.every((si) =>
              h(s.recover(si.sighash, si.sig.r, si.sig.s, si.sig.recovery, true)) ==
              h(node.publicKey)),
          isTrue);
    });
  });

  // ---- Tron (secp256k1 → 0x41 → base58check + LOCAL txID signing) ---------
  // THE GATE: these expected values were produced from the abandon seed and
  // INDEPENDENTLY cross-checked against bip_utils' TRON derivation + a
  // standalone Python base58check + a Python ECDSA verify (docs/tron-vectors.json
  // / test-vectors/tron-golden.json). All 4 wallets must reproduce them
  // byte-for-byte before Tron touches real funds.
  group('Tron (0x41 base58check + txID signing)', () {
    const goldenAddr = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH';
    const goldenAddrHex = '41c8599111f29c1e1e061265b4af93ea1f274ad78a';
    const goldenPriv =
        'b5a4cea271ff424d7c31dc12a3e43e401df7a40d7412a15750f3f0b6b5449a28';
    const goldenPubU =
        '04ff21f8e64d3a3c0198edfbb7afdc79be959432e92e2f8a1984bb436a414b8edcec0345aad0c1bf7da04fd036dd7f9f617e30669224283d950fab9dd84831dc83';
    // Regenerated correct golden (the prior native/TRC-20 raw_data were malformed
    // — zero recipient / non-protobuf Any.value); these bytes now DECODE to the
    // declared {to, amount} / {contract, call_value 0, data}. See tron_test.dart.
    const nativeRaw =
        '0a0202db2208b921b61923a6b1ef40f8e0e9f8a62e5a67080112630a2d747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5472616e73666572436f6e747261637412320a1541c8599111f29c1e1e061265b4af93ea1f274ad78a1215415cd0fb0ab3ce40f3051414c604b27756e69e43db18c0843d';
    const nativeTxId =
        '2d576151d9f4703b8fefdcaac0bb88510269fda67ba31ee78bd7a692f74191a2';
    const nativeSig =
        '6edd2aea57ae0ff2b2dd39075f38fe601c760d346a06e02d3fd5caa1e248f2f01b3e086afbe027876a6183cefd2a1e98a94f61c8e1fe6871d1034e9875c0398d01';
    const trc20Param =
        '0000000000000000000000005cd0fb0ab3ce40f3051414c604b27756e69e43db00000000000000000000000000000000000000000000000000000000000f4240';
    const trc20Raw =
        '0a0202db2208b921b61923a6b1ef40f8e0e9f8a62e5aae01081f12a9010a31747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e54726967676572536d617274436f6e747261637412740a1541c8599111f29c1e1e061265b4af93ea1f274ad78a121541a614f803b6fd780986a42c78ec9c7f77e6ded13c2244a9059cbb0000000000000000000000005cd0fb0ab3ce40f3051414c604b27756e69e43db00000000000000000000000000000000000000000000000000000000000f4240';
    const trc20TxId =
        '592fe64f26e0df4a32ccf669a8f28b6a546b6da9d29a9b1fe828dda8cdaa2d64';
    const trc20Sig =
        'f0bc426f6a855a613c91de12945e9c842be774eabc5f3e086ee19dfade129c8042592adbb29f561b3057a567203d8cfb5e0305c2c04c908d743963d4b5f113ec01';
    const usdt = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

    test('address codec vs spec pairs (both ways) + validation', () {
      for (final pair in const [
        ['41c8599111f29c1e1e061265b4af93ea1f274ad78a',
         'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH'],
        ['415cd0fb0ab3ce40f3051414c604b27756e69e43db',
         'TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC'],
        // published TronWeb reference vector
        ['41e552f6487585c2b58bc2c9bb4492bc1f17132cd0',
         'TWsm8HtU2A5eEzoT8ev8yaoFjHsXLLrckb'],
      ]) {
        expect(tr.hexToBase58(pair[0]), pair[1]);
        expect(tr.addressToHex(pair[1]), pair[0]);
        expect(tr.isTronAddress(pair[1]), isTrue);
      }
      // rejects a corrupted checksum / non-T strings
      expect(tr.isTronAddress('TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdX'), isFalse);
      expect(tr.isTronAddress('0xabc'), isFalse);
    });

    test('derive 0x41 base58check address from seed (golden)', () {
      final seed = hd.mnemonicToSeed(abandon, '');
      final node = hd.derivePath(seed, "m/44'/195'/0'/0/0");
      expect(h(node.privateKey!), goldenPriv);
      expect(h(s.publicKey(node.privateKey!, compressed: false)), goldenPubU);
      expect(tr.tronAddressFromPub(node.publicKey), goldenAddr);
      expect(tr.addressToHex(goldenAddr), goldenAddrHex);
      expect(tr.hexToBase58(goldenAddrHex), goldenAddr);
    });

    test('txID == sha256(raw_data_hex) + 65B [r||s||v] sig verifies (native)',
        () {
      final seed = hd.mnemonicToSeed(abandon, '');
      final priv = hd.derivePath(seed, "m/44'/195'/0'/0/0").privateKey!;
      // txID recomputed locally from raw_data_hex (the malicious-node guard).
      expect(tr.txIdFromRawData(nativeRaw), nativeTxId);
      final sig = tr.signTxId(c.hexToBytes(nativeTxId), priv);
      expect(h(sig), nativeSig); // deterministic RFC6979 → byte-identical
      expect(sig.length, 65);
      expect(sig[64], anyOf(0, 1)); // v = recovery, NO +27
      // the sig verifies + recovers to the owner pubkey over the 32-byte txID
      final r = s.bytesToBig(sig.sublist(0, 32));
      final sv = s.bytesToBig(sig.sublist(32, 64));
      final ecsig = s.EcdsaSignature(r, sv, sig[64]);
      expect(s.verify(c.hexToBytes(nativeTxId),
          ecsig, s.publicKey(priv, compressed: false)), isTrue);
      expect(h(s.recover(c.hexToBytes(nativeTxId), r, sv, sig[64], false)),
          goldenPubU);
    });

    test('TRC-20 transfer parameter + txID + sig (golden)', () {
      final seed = hd.mnemonicToSeed(abandon, '');
      final priv = hd.derivePath(seed, "m/44'/195'/0'/0/0").privateKey!;
      expect(
          tr.trc20TransferParameter('TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC',
              '1000000'),
          trc20Param);
      expect(tr.txIdFromRawData(trc20Raw), trc20TxId);
      expect(h(tr.signTxId(c.hexToBytes(trc20TxId), priv)), trc20Sig);
    });

    test('buildSend assembles (mock node) + signs the verified txID', () async {
      final seed = hd.mnemonicToSeed(abandon, '');
      final root = RootSecret(seed: seed);
      String? seenPath;
      final adapter = tr.TronAdapter(
        api: 'https://api.trongrid.io',
        post: (path, body) async {
          seenPath = path;
          if (path == '/wallet/createtransaction') {
            return jsonEncode({'txID': nativeTxId, 'raw_data_hex': nativeRaw});
          }
          if (path == '/wallet/broadcasttransaction') {
            return jsonEncode({'result': true, 'txid': nativeTxId});
          }
          return '{}';
        },
      );
      adapter.unlock(root);
      final acct = await adapter.deriveAccount(root);
      expect(acct.address, goldenAddr);
      final built = await adapter.buildSend(
          acct,
          const SendRequest(
              to: 'TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC', amount: '1000000'));
      expect(seenPath, '/wallet/createtransaction');
      expect(built.txid, nativeTxId);
      final signed = jsonDecode(built.raw) as Map<String, dynamic>;
      expect((signed['signature'] as List).first, nativeSig);
      final res = await adapter.broadcast(built);
      expect(res.accepted, isTrue);
      expect(res.txid, nativeTxId);
      expect(adapter.explorerTx(nativeTxId),
          'https://tronscan.org/#/transaction/$nativeTxId');
    });

    test('MALICIOUS-NODE GUARD: rejects a tx whose txID != sha256(raw)',
        () async {
      final seed = hd.mnemonicToSeed(abandon, '');
      final root = RootSecret(seed: seed);
      final adapter = tr.TronAdapter(
        api: 'https://api.trongrid.io',
        post: (path, body) async =>
            // node lies: real raw, but a DIFFERENT (attacker) txID
            jsonEncode({'txID': 'deadbeef' * 8, 'raw_data_hex': nativeRaw}),
      );
      adapter.unlock(root);
      final acct = await adapter.deriveAccount(root);
      expect(
          () => adapter.buildSend(
              acct,
              const SendRequest(
                  to: 'TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC', amount: '1000000')),
          throwsA(isA<StateError>()));
    });

    test('registry wires Tron: enabled, endpoint, token, golden address',
        () async {
      final reg = ChainRegistry.create();
      final root = RootSecret(seed: hd.mnemonicToSeed(abandon, ''));
      reg.unlock(root);
      expect(reg.has('tron'), isTrue);
      expect(reg.enabled().contains('tron'), isTrue);
      expect(reg.endpoints('tron')?.api, 'https://api.trongrid.io');
      final t = reg.tokensFor('tron');
      expect(t.any((x) => x.symbol == 'USDT' && x.address == usdt), isTrue);
      final acct = await reg.get('tron').deriveAccount(root);
      expect(acct.chain, 'tron');
      expect(acct.scheme, 'secp256k1');
      expect(acct.path, "m/44'/195'/0'/0/0");
      expect(acct.address, goldenAddr);
    });

    test('registry wires XRP: enabled, rippled endpoint, r… address', () async {
      final reg = ChainRegistry.create();
      final root = RootSecret(seed: hd.mnemonicToSeed(abandon, ''));
      reg.unlock(root);
      expect(reg.has('xrp'), isTrue);
      expect(reg.enabled().contains('xrp'), isTrue);
      expect(reg.endpoints('xrp')?.rpcUrl, 'https://xrplcluster.com');
      final acct = await reg.get('xrp').deriveAccount(root);
      expect(acct.chain, 'xrp');
      expect(acct.scheme, 'secp256k1');
      expect(acct.path, "m/44'/144'/0'/0/0");
      expect(acct.address, 'rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3');
    });

    test('registry wires Stellar: enabled, Horizon endpoint, G… address',
        () async {
      final reg = ChainRegistry.create();
      final root = RootSecret(seed: hd.mnemonicToSeed(abandon, ''));
      reg.unlock(root);
      expect(reg.has('stellar'), isTrue);
      expect(reg.enabled().contains('stellar'), isTrue);
      expect(reg.endpoints('stellar')?.horizon, 'https://horizon.stellar.org');
      final acct = await reg.get('stellar').deriveAccount(root);
      expect(acct.chain, 'stellar');
      expect(acct.scheme, 'ed25519');
      expect(acct.path, "m/44'/148'/0'");
      expect(acct.address,
          'GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX');
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
      // Bitcoin Cash: enabled by default, derives a CashAddr via the registry.
      final bch = await reg.get('bitcoincash').deriveAccount(root);
      expect(bch.address, 'bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6');
      expect(reg.enabled().contains('bitcoincash'), isTrue);
      // BCH balances/UTXOs/broadcast go through Haskoin (apiStyle: 'haskoin'),
      // not an Esplora instance — the imaginary.cash Esplora shim was unreliable.
      expect(reg.endpoints('bitcoincash')?.esplora, 'https://api.haskoin.com/bch');
      expect(reg.enabled().contains('ethereum'), isTrue);
      expect(reg.enabled().contains('bitcoin'), isTrue);
      expect(reg.tokensFor('ethereum').any((t) => t.symbol == 'USDC'), isTrue);
    });
  });

  group('registry solana (SOL + SPL, mocked RPC)', () {
    test('registry builds solana, derives address, parses SPL accounts',
        () async {
      // Inject a stub JSON-RPC so no network is touched. The builder receives
      // the configured endpoint URL and returns the per-call transport.
      String? seenUrl;
      String? seenProgram;
      final reg = ChainRegistry.create(
        rpcBuilder: (url) => (method, params) async {
          seenUrl = url;
          if (method == 'getTokenAccountsByOwner') {
            seenProgram = (params[1] as Map)['programId'] as String?;
            // Two accounts of the same mint (must aggregate) + a zero-balance
            // junk mint (must be dropped) — mirrors a real jsonParsed reply.
            return {
              'value': [
                {
                  'account': {
                    'data': {
                      'parsed': {
                        'info': {
                          'mint': 'MintUSDCxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
                          'tokenAmount': {'amount': '2500000', 'decimals': 6}
                        }
                      }
                    }
                  }
                },
                {
                  'account': {
                    'data': {
                      'parsed': {
                        'info': {
                          'mint': 'MintUSDCxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
                          'tokenAmount': {'amount': '1500000', 'decimals': 6}
                        }
                      }
                    }
                  }
                },
                {
                  'account': {
                    'data': {
                      'parsed': {
                        'info': {
                          'mint': 'MintBONKyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy',
                          'tokenAmount': {'amount': '0', 'decimals': 5}
                        }
                      }
                    }
                  }
                }
              ]
            };
          }
          return null;
        },
      );

      // Registered + enabled by default, with the public mainnet RPC default
      // (config-overridable; no secret).
      expect(reg.has('solana'), isTrue);
      expect(reg.enabled().contains('solana'), isTrue);
      expect(reg.endpoints('solana')?.rpcUrl,
          'https://api.mainnet-beta.solana.com');

      final seed = hd.mnemonicToSeed(abandon, '');
      final root = RootSecret(seed: seed);
      reg.unlock(root);

      // Derives an ed25519 (SLIP-0010 m/44'/501'/0'/0') base58 pubkey address.
      final acct = await reg.get('solana').deriveAccount(root);
      expect(acct.chain, 'solana');
      expect(acct.scheme, 'ed25519');
      expect(acct.path, "m/44'/501'/0'/0'");
      expect(acct.address.length, inInclusiveRange(32, 44));
      expect(RegExp(r'^[1-9A-HJ-NP-Za-km-z]+$').hasMatch(acct.address), isTrue,
          reason: 'address must be base58');
      // Deterministic for the same seed.
      final acct2 = await reg.get('solana').deriveAccount(root);
      expect(acct2.address, acct.address);

      // SPL auto-detect flows through the registry adapter + the default RPC.
      final held = await reg.get('solana').discoverTokens(acct.address);
      expect(seenProgram, splTokenProgram);
      expect(seenUrl, 'https://api.mainnet-beta.solana.com');
      expect(held.length, 1); // zero-balance junk dropped
      final usdc = held.single;
      expect(usdc.asset.chain, 'solana');
      expect(usdc.asset.kind, 'spl');
      expect(usdc.asset.decimals, 6);
      expect(usdc.confirmed, '4000000'); // two accounts aggregated
      expect(usdc.display, '4');
    });
  });
}
