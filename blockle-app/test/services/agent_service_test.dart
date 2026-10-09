// AgentService wiring tests: a channel resolves its LLM credential from the
// UNLOCKED vault (never from the persisted record), the per-channel AgentContext
// is bound to the Accounts facade, and the host-wide kill fan-out locks the
// Accounts facade (wiping the seed + BLOCK key + vault session). Fully offline:
// a fake ChannelStore + fake VaultSession + fake provider fetch.

import 'package:blockle_app/agent/channels.dart';
import 'package:blockle_app/agent/providers.dart' show ProviderResponse;
import 'package:blockle_app/multichain/accounts.dart';
import 'package:blockle_app/multichain/chains/block.dart';
import 'package:blockle_app/multichain/chains/registry.dart';
import 'package:blockle_app/multichain/vault_store.dart';
import 'package:blockle_app/multichain/venues.dart';
import 'package:blockle_app/services/agent_service.dart';
import 'package:flutter_test/flutter_test.dart';

class FakeVault implements VaultSession {
  FakeVault(this._pt);
  final VaultPlaintext _pt;
  bool _unlocked = false;
  @override
  bool get isUnlocked => _unlocked;
  @override
  Future<VaultPlaintext> unlock(String password) async {
    _unlocked = true;
    return _pt;
  }

  @override
  VaultPlaintext? get plaintext => _unlocked ? _pt : null;
  @override
  void lock() => _unlocked = false;
}

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
  Future<List<dynamic>> tokenHoldings(String address) async => const [];
  @override
  Future<dynamic> submit(String raw) async => {};
}

class MemChannelStore implements ChannelStore {
  final Map<String, dynamic> m = {};
  @override
  Future<Map<String, dynamic>> get(List<String>? keys) async =>
      keys == null ? {...m} : {for (final k in keys) if (m.containsKey(k)) k: m[k]};
  @override
  Future<void> set(Map<String, dynamic> obj) async => m.addAll(obj);
  @override
  Future<void> remove(List<String> keys) async => keys.forEach(m.remove);
}

Future<ProviderResponse> _noFetch(String url,
        {required String method,
        required Map<String, String> headers,
        required String body}) async =>
    const ProviderResponse(true, 200, '{}');

Accounts _accounts(VaultSession vault, FakeBlockBridge bridge) => Accounts(
      vault: vault,
      registry: ChainRegistry.create(block: bridge),
      block: bridge,
    );

void main() {
  test('readOnly channel resolves its credential from the unlocked vault', () async {
    final vault = FakeVault(VaultPlaintext(
      mnemonic: null,
      agent: {'provider': 'claude', 'apiKey': 'sk-ant-secret', 'model': 'm'},
    ));
    final bridge = FakeBlockBridge();
    final accounts = _accounts(vault, bridge);
    await accounts.unlock('pw');

    final svc = AgentService(
      accounts: accounts,
      venues: VenueRegistry.create(),
      store: MemChannelStore(),
      fetch: _noFetch,
    );
    await svc.load();
    final ch = await svc.manager.create({
      'provider': 'claude',
      'walletId': 'w1',
      'readOnly': true,
    });
    final started = await svc.manager.start(ch['id'] as String);
    expect(started['running'], isTrue);

    // The persisted record must NOT contain the API key.
    final mem = (svc.store as MemChannelStore).m;
    expect(mem.toString().contains('sk-ant-secret'), isFalse);
  });

  test('start fails when the vault is locked (no credential available)', () async {
    final vault = FakeVault(VaultPlaintext(
      agent: {'provider': 'claude', 'apiKey': 'sk-ant-secret'},
    ));
    final accounts = _accounts(vault, FakeBlockBridge());
    // NOT unlocked.
    final svc = AgentService(
      accounts: accounts,
      venues: VenueRegistry.create(),
      store: MemChannelStore(),
      fetch: _noFetch,
    );
    final ch = await svc.manager.create({
      'provider': 'claude',
      'walletId': 'w1',
      'readOnly': true,
    });
    expect(() => svc.manager.start(ch['id'] as String), throwsStateError);
  });

  test('global kill fan-out locks the Accounts facade', () async {
    final vault = FakeVault(VaultPlaintext(
      mnemonic: null,
      agent: {'provider': 'claude', 'apiKey': 'sk-ant-secret'},
    ));
    final bridge = FakeBlockBridge();
    final accounts = _accounts(vault, bridge);
    await accounts.unlock('pw');
    expect(accounts.isUnlocked(), isTrue);

    final svc = AgentService(
      accounts: accounts,
      venues: VenueRegistry.create(),
      store: MemChannelStore(),
      fetch: _noFetch,
    );
    await svc.manager.killAll('test');
    expect(accounts.isUnlocked(), isFalse);
    expect(vault.isUnlocked, isFalse);
  });
}
