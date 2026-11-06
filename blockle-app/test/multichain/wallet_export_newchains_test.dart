// Golden-vector gate for the NEW-chain private-key exports (BCH / Tron / XRP).
// A wrong derivation here loses funds, so each exported key MUST reproduce the
// published per-chain vector (docs/{bch,tron,xrp}-vectors.json) byte-for-byte
// for the canonical BIP39 "abandon…about" mnemonic at index 0.
import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/multichain/wallet_export.dart' as wx;

const _mnemonic =
    'abandon abandon abandon abandon abandon abandon abandon abandon '
    'abandon abandon abandon about';

void main() {
  final keys = wx.privateKeys(wx.fromMnemonic(_mnemonic).seed);

  test('BCH export matches docs/bch-vectors.json (m/44\'/145\'/0\'/0/0)', () {
    final k = keys['bitcoincash']!;
    expect(k.path, "m/44'/145'/0'/0/0");
    expect(k.publicKey,
        '02bbe7dbcdf8b2261530a867df7180b17a90b482f74f2736b8a30d3f756e42e217');
    // The exported address MUST be the CashAddr the Accounts screen shows.
    expect(k.address,
        'bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6');
    expect(k.wif, isNotNull); // BTC-style WIF (0x80, compressed) for Electron Cash
    expect(k.wifVersion, 0x80);
  });

  test('Tron export matches docs/tron-vectors.json (m/44\'/195\'/0\'/0/0)', () {
    final k = keys['tron']!;
    expect(k.path, "m/44'/195'/0'/0/0");
    expect(k.privateKey,
        'b5a4cea271ff424d7c31dc12a3e43e401df7a40d7412a15750f3f0b6b5449a28');
    expect(k.publicKey,
        '03ff21f8e64d3a3c0198edfbb7afdc79be959432e92e2f8a1984bb436a414b8edc');
    expect(k.address, 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH');
  });

  test('XRP export matches docs/xrp-vectors.json (m/44\'/144\'/0\'/0/0)', () {
    final k = keys['xrp']!;
    expect(k.path, "m/44'/144'/0'/0/0");
    // 00-prefixed UPPERCASE secp256k1 key, as ripple-keypairs/xrpl.js expect.
    expect(k.privateKey,
        '0090802A50AA84EFB6CDB225F17C27616EA94048C179142FECF03F4712A07EA7A4');
    expect(k.publicKey,
        '031D68BC1A142E6766B2BDFB006CCFE135EF2E0E2E94ABB5CF5C9AB6104776FBAE');
    expect(k.address, 'rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3');
  });

  test('Stellar export matches docs/stellar-vectors.json (m/44\'/148\'/0\')', () {
    final k = keys['stellar']!;
    expect(k.path, "m/44'/148'/0'");
    expect(k.publicKey,
        '7691d85048acc4ed085d9061ce0948bbdf7de6a92b790aaf241d31b7dcaa4238');
    expect(k.address,
        'GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX');
    // 'S…' StrKey secret seed (independently computed from the vector seed).
    expect(k.secretKey,
        'SBUV3MRWKNS6AYKZ6E6MOUVF2OYMON3MIUASWL3JLY5E3ISDJFELYBRZ');
  });

  test('Tezos export matches docs/tezos-vectors.json (m/44\'/1729\'/0\'/0\')', () {
    final k = keys['tezos']!;
    expect(k.path, "m/44'/1729'/0'/0'");
    expect(k.publicKey,
        'edpku4US3ZykcZifjzSGFCmFr3zRgCKndE82estE4irj4d5oqDNDvf');
    expect(k.address, 'tz1VQA4RP4fLjEEMW2FR4pE9kAg5abb5h5GL');
    // 'edsk…' 32-byte seed secret (independently computed from the vector seed).
    expect(k.secretKey, 'edsk4BBVKnpwdnJrx9PB4hLkXZHtceSdSZVTfKBXArhmZ3Jg87Lcxi');
  });

  test('legacy chains unchanged (BTC WIF + EVM 0x-hex still present)', () {
    expect(keys['bitcoin']!.wif, isNotNull);
    expect(keys['evm']!.privateKey!.startsWith('0x'), isTrue);
    expect(keys['solana']!.secretKey, isNotNull);
  });
}
