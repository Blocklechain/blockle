// Accounts facade tests: unlock -> HD root fan-out -> lazy, cached per-chain
// DerivedAccount across secp256k1 / ed25519 chains, the BLOCK compat shim via a
// fake signer bridge, and the lock/kill fan-out that wipes the root + adapters +
// vault session. Fully offline — a fake VaultSession stands in for
// MultichainVaultStore so no flutter_secure_storage / platform channel is hit.

import 'package:blockle_app/multichain/accounts.dart';
import 'package:blockle_app/multichain/chains/block.dart';
import 'package:blockle_app/multichain/chains/registry.dart';
import 'package:blockle_app/multichain/vault.dart' show WrongPasswordException;
import 'package:blockle_app/multichain/vault_store.dart';
import 'package:flutter_test/flutter_test.dart';

const abandon =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

class FakeVault implements VaultSession {
  FakeVault(this._pt);
  final VaultPlaintext? _pt;
  bool _unlocked = false;
  @override
  bool get isUnlocked => _unlocked;
  @override
  Future<VaultPlaintext> unlock(String password) async {
    if (password != 'pw') throw const WrongPasswordException();
    _unlocked = true;
    return _pt!;
  }

  @override
  VaultPlaintext? get plaintext => _unlocked ? _pt : null;
  @override
  void lock() => _unlocked = false;
}

/// A minimal BLOCK bridge so accountFor('block') resolves without a mnemonic.
class FakeBlockBridge implements BlockSignerBridge {
  @override
  String get address => 'block1qnativeid';
  @override
  String get publicKeyHex => 'cafe';
  @override
  bool isUnlocked() => true;
  @override
  Future<Map<String, dynamic>?> account(String address) async => {'balance': 0};
  @override
  Future<List<dynamic>> utxos(String address) async => const [];
  @override
  Future<Map<String, dynamic>> buildTransfer(
          List<dynamic> utxos, String to, BigInt amount, BigInt fee) async =>
      {'raw': '', 'txid': ''};
  @override
  Future<dynamic> submit(String raw) async => {};
}

void main() {
  group('Accounts derive across chains', () {
    late Accounts accounts;
    late FakeVault vault;

    setUp(() {
      vault = FakeVault(VaultPlaintext(mnemonic: abandon));
      accounts = Accounts(
        vault: vault,
        registry: ChainRegistry.create(),
      );
    });

    test('unlock fans the HD root into adapters; derives per chain', () async {
      await accounts.unlock('pw');
      expect(accounts.isUnlocked(), isTrue);

      final eth = await accounts.accountFor('ethereum');
      expect(eth.scheme, 'secp256k1');
      expect(RegExp(r'^0x[0-9a-fA-F]{40}$').hasMatch(eth.address), isTrue);

      final btc = await accounts.accountFor('bitcoin');
      expect(btc.scheme, 'secp256k1');
      expect(btc.address.startsWith('bc1'), isTrue);

      final sol = await accounts.accountFor('solana');
      expect(sol.scheme, 'ed25519');
      expect(RegExp(r'^[1-9A-HJ-NP-Za-km-z]{32,44}$').hasMatch(sol.address), isTrue);
    });

    test('derived accounts are cached (same instance per chain/index)', () async {
      await accounts.unlock('pw');
      final a1 = await accounts.accountFor('ethereum');
      final a2 = await accounts.accountFor('ethereum');
      expect(identical(a1, a2), isTrue);
      final b1 = await accounts.accountFor('ethereum', index: 1);
      expect(identical(a1, b1), isFalse);
      expect(b1.path, "m/44'/60'/0'/0/1");
    });

    test('a wrong password throws and leaves the facade locked', () async {
      expect(() => accounts.unlock('nope'), throwsA(isA<WrongPasswordException>()));
      expect(accounts.isUnlocked(), isFalse);
    });

    test('lock/kill fan-out wipes the root; derivation then fails', () async {
      await accounts.unlock('pw');
      await accounts.accountFor('ethereum');
      accounts.lock();
      expect(accounts.isUnlocked(), isFalse);
      expect(vault.isUnlocked, isFalse); // vault session locked too
      expect(() => accounts.accountFor('ethereum'), throwsStateError);
    });
  });

  group('BLOCK account via the signer bridge (no HD seed needed)', () {
    test('accountFor(block) + address shim resolve from the bridge', () async {
      final bridge = FakeBlockBridge();
      final accounts = Accounts(
        vault: FakeVault(VaultPlaintext()), // no mnemonic
        registry: ChainRegistry.create(block: bridge),
        block: bridge,
      );
      await accounts.unlock('pw');
      expect(accounts.address, 'block1qnativeid');
      final blk = await accounts.accountFor('block');
      expect(blk.chain, 'block');
      expect(blk.scheme, 'ml-dsa-44');
      expect(blk.address, 'block1qnativeid');
    });

    test('a non-BLOCK chain without a seed is rejected', () async {
      final accounts = Accounts(
        vault: FakeVault(VaultPlaintext()),
        registry: ChainRegistry.create(),
      );
      await accounts.unlock('pw');
      expect(() => accounts.accountFor('ethereum'), throwsStateError);
    });
  });
}
