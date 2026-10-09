// accounts.dart — the Accounts facade (§5 of docs/MULTICHAIN-WALLET.md). Sits
// between the unlocked vault and the ChainRegistry:
//
//   - unlock the vault -> derive the HD root (BIP39 seed) for secp256k1/ed25519
//     chains, and fan the root into every adapter session;
//   - lazily derive + CACHE one DerivedAccount per (chain,index);
//   - expose the active account + balances to the UI / exchange / agent;
//   - lock / kill FAN-OUT: wipe the cache, drop the root, lock the registry
//     adapters AND the vault session in one call — nothing spendable survives.
//
// BLOCK is special: its identity is the ML-DSA-44 keypair held in the engine
// session (reached through the BlockAdapter's BlockSignerBridge), NOT the HD
// seed. accountFor('block') therefore works even when the vault has no mnemonic.
//
// HARD RULE: the decrypted seed / BLOCK key / agent credential live only in the
// vault session's memory; this facade never logs, persists, or copies them. The
// RootSecret it hands to adapters carries the seed bytes in-memory only.

import 'dart:typed_data';

import 'chains/block.dart' show BlockSignerBridge;
import 'chains/chain_adapter.dart';
import 'chains/registry.dart';
import 'crypto/hd.dart' as hd;
import 'vault_store.dart';

/// Derives a BIP39 seed from a mnemonic. Injectable so tests stay deterministic
/// and offline; defaults to the audited [hd.mnemonicToSeed].
typedef SeedFromMnemonic = Uint8List Function(String mnemonic);

class Accounts {
  Accounts({
    required this.vault,
    required this.registry,
    this.block,
    SeedFromMnemonic? seedFromMnemonic,
  }) : _seedFromMnemonic = seedFromMnemonic ?? hd.mnemonicToSeed;

  final VaultSession vault;
  final ChainRegistry registry;

  /// The app's BLOCK signer bridge, for the synchronous BLOCK-address compat
  /// shim. Optional (omitted in pure-Dart tests).
  final BlockSignerBridge? block;
  final SeedFromMnemonic _seedFromMnemonic;

  RootSecret? _root;
  final Map<String, DerivedAccount> _cache = {};

  bool isUnlocked() => vault.isUnlocked && _root != null;

  /// Unlock the vault, derive the HD root from its mnemonic, and fan the root
  /// into every adapter session. Throws whatever the vault throws on a bad
  /// password.
  Future<void> unlock(String password) async {
    final pt = await vault.unlock(password);
    _applyRoot(pt);
  }

  /// Apply an already-unlocked plaintext (e.g. a vault unlocked elsewhere in the
  /// app). Idempotent; resets the derived-account cache.
  void applyPlaintext(VaultPlaintext pt) => _applyRoot(pt);

  void _applyRoot(VaultPlaintext pt) {
    final mn = pt.mnemonic;
    final seed = (mn != null && mn.isNotEmpty) ? _seedFromMnemonic(mn) : null;
    _root = RootSecret(seed: seed);
    _cache.clear();
    registry.unlock(_root!);
  }

  /// The enabled chains this facade can serve accounts for.
  List<String> chains() => registry.enabled();

  /// Lazily derive + cache the account for [chain] at [index]. BLOCK resolves
  /// via its engine-session bridge; secp256k1/ed25519 chains require an unlocked
  /// HD seed.
  Future<DerivedAccount> accountFor(String chain, {int index = 0}) async {
    final key = '$chain/$index';
    final cached = _cache[key];
    if (cached != null) return cached;
    if (chain != 'block' && (_root?.seed == null)) {
      throw StateError('locked: no HD seed for $chain');
    }
    final acct = await registry
        .get(chain)
        .deriveAccount(_root ?? RootSecret(), index: index);
    _cache[key] = acct;
    return acct;
  }

  /// Best-effort balances for [chain] via its adapter. Returns the native coin +
  /// the curated/default token list, MERGED with auto-detected holdings
  /// (Solana SPL, BLOCK-20, EVM ERC-20 via Alchemy when configured), deduped by
  /// (chain, contract), non-zero balances first. Set [discover] false to skip
  /// auto-detect. Never throws into the UI — adapters flag read errors.
  Future<List<Balance>> balances(String chain,
      {int index = 0, bool discover = true}) async {
    final acct = await accountFor(chain, index: index);
    final adapter = registry.get(chain);
    final known =
        await adapter.getBalance(acct.address, tokens: registry.tokensFor(chain));
    if (!discover) return known;
    List<Balance> found = const [];
    try {
      found = await adapter.discoverTokens(acct.address);
    } catch (_) {
      found = const [];
    }
    return mergeBalances(known, found);
  }

  /// The active BLOCK address (compat shim for the existing BLOCK-centric UI /
  /// dApp provider). Empty string when the BLOCK bridge is not wired/unlocked.
  String get address =>
      block?.address ?? _cache['block/0']?.address ?? '';

  /// Lock / kill FAN-OUT: wipe derived accounts + the HD root, lock every
  /// adapter, and lock the vault session. Nothing spendable survives.
  void lock() {
    _cache.clear();
    _root = null;
    registry.lock();
    vault.lock();
  }

  /// Alias used by the global kill switch.
  void kill() => lock();
}
