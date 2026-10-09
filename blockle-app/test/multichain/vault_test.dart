// Dart port of blockle-extension/vault.test.js. Covers:
//   1. scrypt correctness vs. RFC 7914 published vectors (matches the extension),
//   2. seal->open roundtrip preserves the full multi-chain plaintext,
//   3. wrong-passphrase rejection (AES-GCM auth failure, normalized),
//   4. a tampered blob is rejected,
//   5. legacy v1 (PBKDF2) blobs still open, and needsUpgrade() flags them.

import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:pointycastle/export.dart';
import 'package:blockle_app/multichain/vault.dart';

String _hex(List<int> b) =>
    b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

void main() {
  group('scrypt RFC 7914 vectors', () {
    test('N=16384,r=8,p=1 — matches the v2 default params', () {
      final dk = Vault.scrypt('pleaseletmein',
          Uint8List.fromList(utf8.encode('SodiumChloride')), 16384, 8, 1, 64);
      expect(
        _hex(dk),
        '7023bdcb3afd7348461c06cd81fd38ebfda8fbba904f8e3ea9b543f6545da1f2'
        'd5432955613f0fcf62d49705242a9af9e61e85dc0d651e40dfcf017b45575887',
      );
    });

    test('N=1024,r=8,p=16 — exercises multiple blocks (p>1)', () {
      final dk = Vault.scrypt('password',
          Uint8List.fromList(utf8.encode('NaCl')), 1024, 8, 16, 64);
      expect(
        _hex(dk),
        'fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b373162'
        '2eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640',
      );
    });
  });

  // The full multi-chain plaintext: BLOCK ML-DSA keypair + secp256k1 HD seed +
  // the agent LLM credential + private endpoints.
  final plaintext = {
    'version': 2,
    'block': {'secret': 'ab' * 32, 'public': 'cd' * 32},
    'seed': 'ef' * 32,
    'agent': {'provider': 'claude', 'apiKey': 'sk-ant-test-DO-NOT-LEAVE-DEVICE'},
    'endpoints': {
      'ethereum': {'rpc': 'https://rpc.example'}
    },
  };

  group('seal / open', () {
    test('roundtrip preserves the full multi-chain plaintext', () {
      final sealed = Vault.seal(plaintext, 'correct horse battery staple');
      expect(sealed.v, 2);
      expect(sealed.kdfName, 'scrypt');
      expect(sealed.kdfParams['N'], 16384);
      // ciphertext must not leak the secret in the clear
      expect(sealed.data.contains('sk-ant'), isFalse);
      final opened = Vault.open(sealed, 'correct horse battery staple');
      expect(opened, equals(plaintext));
    });

    test('two seals of the same plaintext differ (random salt + iv)', () {
      final a = Vault.seal(plaintext, 'pw');
      final b = Vault.seal(plaintext, 'pw');
      expect(a.salt, isNot(b.salt));
      expect(a.iv, isNot(b.iv));
      expect(a.data, isNot(b.data));
    });

    test('a freshly sealed v2 blob does NOT need upgrade', () {
      expect(Vault.needsUpgrade(Vault.seal(plaintext, 'pw')), isFalse);
    });
  });

  group('wrong passphrase / tamper', () {
    test('wrong passphrase is rejected', () {
      final sealed = Vault.seal(plaintext, 'the-right-one');
      expect(() => Vault.open(sealed, 'the-wrong-one'),
          throwsA(isA<WrongPasswordException>()));
    });

    test('empty-string passphrase is rejected when sealed under a real one', () {
      final sealed = Vault.seal(plaintext, 'nonempty');
      expect(
          () => Vault.open(sealed, ''), throwsA(isA<WrongPasswordException>()));
    });

    test('tampered ciphertext is rejected (AEAD auth)', () {
      final sealed = Vault.seal(plaintext, 'pw');
      final raw = base64.decode(sealed.data);
      raw[0] ^= 0x01; // flip one bit
      final tampered = SealedVault(
        v: sealed.v,
        kdfName: sealed.kdfName,
        kdfParams: sealed.kdfParams,
        salt: sealed.salt,
        iv: sealed.iv,
        data: base64.encode(raw),
      );
      expect(
          () => Vault.open(tampered, 'pw'), throwsA(isA<WrongPasswordException>()));
    });
  });

  group('legacy v1 (PBKDF2) compatibility', () {
    // Build a v1 blob exactly as the old vault did: PBKDF2-310k -> AES-256-GCM.
    SealedVault buildV1(Map<String, dynamic> obj, String password) {
      final salt = Uint8List.fromList(List.generate(16, (i) => i + 1));
      final iv = Uint8List.fromList(List.generate(12, (i) => i + 100));
      final kd = PBKDF2KeyDerivator(HMac(SHA256Digest(), 64))
        ..init(Pbkdf2Parameters(salt, 310000, 32));
      final key = kd.process(Uint8List.fromList(utf8.encode(password)));
      final gcm = GCMBlockCipher(AESEngine())
        ..init(true, AEADParameters(KeyParameter(key), 128, iv, Uint8List(0)));
      final ct = gcm.process(Uint8List.fromList(utf8.encode(jsonEncode(obj))));
      return SealedVault(
        v: 1,
        kdfName: 'pbkdf2',
        kdfParams: const {},
        salt: base64.encode(salt),
        iv: base64.encode(iv),
        data: base64.encode(ct),
      );
    }

    test('v1 blob still opens, and needsUpgrade flags it', () {
      final legacyObj = {'secret': 'deadbeef', 'public': 'feedface'};
      final v1 = buildV1(legacyObj, 'legacy-pw');
      expect(Vault.needsUpgrade(v1), isTrue);
      expect(Vault.open(v1, 'legacy-pw'), equals(legacyObj));
      expect(() => Vault.open(v1, 'nope'),
          throwsA(isA<WrongPasswordException>()));
    });
  });
}
