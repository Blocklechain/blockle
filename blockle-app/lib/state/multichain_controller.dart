// multichain_controller.dart — the PASS 2 glue that makes the audited Dart core
// usable from the UI. It wires:
//
//   • the existing BLOCK engine (AppState.store / AppState.chain) into the
//     multichain BLOCK adapter via AppBlockSignerBridge;
//   • a MultichainVaultStore (HD seed for ETH/Base/BTC/LTC/DOGE/SOL + the agent
//     LLM credential) sealed under the user's password;
//   • a ChainRegistry with real package:http transports + config endpoints;
//   • the Accounts facade (derive + balances, lock/kill fan-out);
//   • the VenueRegistry + AgentService (multi-channel AI agent);
//   • the ExchangeClient (non-custodial exchange sign-in + trading).
//
// SAFETY: this controller provides the agent's REQUIRED confirm handler (a real
// modal rendered through the app navigator) and the global KILL fan-out. It is
// ADDITIVE — it never touches the existing BLOCK-only screens/engine.
//
// HARD RULE: no seed / BLOCK key / LLM key is ever logged or persisted in the
// clear. The HD seed + agent key live only in the unlocked vault session; the
// exchange token lives in memory only.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../agent/channels.dart' show providerGuides;
import '../multichain/accounts.dart';
import '../multichain/chains/chain_adapter.dart';
import '../multichain/chains/registry.dart';
import '../multichain/crypto/hd.dart' as hd;
import '../multichain/telemetry.dart' show Telemetry;
import '../multichain/vault_store.dart';
import '../multichain/venues.dart' show VenueRegistry;
import '../services/agent_service.dart';
import '../services/block_signer_bridge.dart';
import '../services/exchange_client.dart';
import '../services/transports.dart';
import '../state/app_state.dart';

/// The chains the Accounts screen renders, in display order. BLOCK first (it is
/// the only post-quantum chain) then the HD-derived chains.
const List<String> kDisplayChains = [
  'block',
  'ethereum',
  'base',
  'arbitrum',
  'optimism',
  'polygon',
  'bnb',
  'avalanche',
  'bitcoin',
  'litecoin',
  'dogecoin',
  'solana',
];

/// The EVM networks — all share one secp256k1 address (m/44'/60') + the same
/// EvmAdapter; auto-detect via Alchemy on the first five.
const Set<String> kEvmChains = {
  'ethereum',
  'base',
  'arbitrum',
  'optimism',
  'polygon',
  'bnb',
  'avalanche',
};

/// EVM chains Alchemy's getTokenBalances enhanced API covers — the ones where
/// ERC-20 auto-detect can be switched on with a read-only indexer key.
const Set<String> kAlchemyChains = {
  'ethereum',
  'base',
  'arbitrum',
  'optimism',
  'polygon',
};

const Map<String, String> kChainLabels = {
  'block': 'Blockle',
  'ethereum': 'Ethereum',
  'base': 'Base',
  'arbitrum': 'Arbitrum One',
  'optimism': 'Optimism',
  'polygon': 'Polygon',
  'bnb': 'BNB Chain',
  'avalanche': 'Avalanche C-Chain',
  'bitcoin': 'Bitcoin',
  'litecoin': 'Litecoin',
  'dogecoin': 'Dogecoin',
  'solana': 'Solana',
};

const Map<String, String> kChainTickers = {
  'block': 'BLOCK',
  'ethereum': 'ETH',
  'base': 'ETH',
  'arbitrum': 'ETH',
  'optimism': 'ETH',
  'polygon': 'POL',
  'bnb': 'BNB',
  'avalanche': 'AVAX',
  'bitcoin': 'BTC',
  'litecoin': 'LTC',
  'dogecoin': 'DOGE',
  'solana': 'SOL',
};

class MultichainController extends ChangeNotifier {
  MultichainController(this._app, this._navKey);

  final AppState _app;
  final GlobalKey<NavigatorState> _navKey;

  static const _kEndpoints = 'bk_mc_endpoints';
  static const _kTokens = 'bk_mc_tokens';
  final _storage = const FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  late final MultichainVaultStore vault;
  late ChainRegistry registry;
  late Accounts accounts;
  late VenueRegistry venues;
  late AgentService agent;
  late final ExchangeClient exchange;
  late final AppBlockSignerBridge _bridge;

  bool ready = false;
  bool vaultExists = false;
  String? lastAgentError;

  Map<String, EndpointCfg> _endpoints = {};
  Map<String, List<AssetRef>> _customTokens = {};

  bool get vaultUnlocked => vault.isUnlocked && accounts.isUnlocked();

  // ---- lifecycle -----------------------------------------------------------

  Future<void> init() async {
    _bridge = AppBlockSignerBridge(_app.store, _app.chain);
    vault = MultichainVaultStore();
    exchange = ExchangeClient();
    await _loadEndpoints();
    await _loadTokens();
    _buildRegistryAndAccounts();
    venues = VenueRegistry.create(); // treasury unset -> agent fee fail-closed
    agent = AgentService(
      accounts: accounts,
      venues: venues,
      telemetry: Telemetry(),
      confirm: _confirm,
      estimateUsd: _estimateUsd,
      defaults: const {
        'system':
            'You are the Blockle in-wallet trading agent. You operate ONE channel bound '
                'to a specific account. Every value-moving action is capped, confirmed, and '
                'audited. Never attempt to move funds beyond the session caps.',
      },
    );
    try {
      await agent.load();
    } catch (_) {}
    vaultExists = await vault.exists();
    ready = true;
    notifyListeners();
  }

  void _buildRegistryAndAccounts() {
    final merged = <String, List<AssetRef>>{};
    for (final chain in defaultTokens.keys) {
      merged[chain] = [...defaultTokens[chain]!];
    }
    _customTokens.forEach((chain, list) {
      merged[chain] = [...(merged[chain] ?? const []), ...list];
    });
    registry = buildWiredRegistry(
        endpoints: _endpoints, tokens: merged, block: _bridge);
    accounts = Accounts(vault: vault, registry: registry, block: _bridge);
  }

  Future<void> _loadTokens() async {
    _customTokens = {};
    try {
      final raw = await _storage.read(key: _kTokens);
      if (raw == null || raw.isEmpty) return;
      final list = (jsonDecode(raw) as List).cast<Map<String, dynamic>>();
      for (final t in list) {
        final chain = '${t['chain']}';
        (_customTokens[chain] ??= []).add(AssetRef(
          chain: chain,
          kind: '${t['kind'] ?? 'erc20'}',
          symbol: '${t['symbol']}',
          decimals: (t['decimals'] as num?)?.toInt() ?? 18,
          address: t['address'] as String?,
        ));
      }
    } catch (_) {
      _customTokens = {};
    }
  }

  List<AssetRef> customTokens(String chain) => _customTokens[chain] ?? const [];

  Future<void> addToken(AssetRef token) async {
    (_customTokens[token.chain] ??= []).add(token);
    await _persistTokens();
    _rebuildPreservingSession();
  }

  Future<void> removeToken(String chain, String address) async {
    _customTokens[chain]?.removeWhere((t) => t.address == address);
    await _persistTokens();
    _rebuildPreservingSession();
  }

  Future<void> _persistTokens() async {
    final list = <Map<String, dynamic>>[];
    _customTokens.forEach((chain, toks) {
      for (final t in toks) {
        list.add(t.toJson());
      }
    });
    await _storage.write(key: _kTokens, value: jsonEncode(list));
  }

  Future<void> _loadEndpoints() async {
    _endpoints = {};
    try {
      final raw = await _storage.read(key: _kEndpoints);
      if (raw == null || raw.isEmpty) return;
      final m = (jsonDecode(raw) as Map).cast<String, dynamic>();
      m.forEach((chain, v) {
        if (v is Map) {
          _endpoints[chain] = EndpointCfg(
            rpcUrl: v['rpcUrl'] as String?,
            esplora: v['esplora'] as String?,
            chainId: (v['chainId'] as num?)?.toInt(),
            alchemyUrl: v['alchemyUrl'] as String?,
          );
        }
      });
    } catch (_) {
      _endpoints = {};
    }
  }

  /// Resolve the effective endpoint for display/editing (config override or the
  /// built-in public default).
  EndpointCfg effectiveEndpoint(String chain) =>
      _endpoints[chain] ?? defaultEndpoints[chain] ?? const EndpointCfg();

  bool hasEndpointOverride(String chain) => _endpoints.containsKey(chain);

  Future<void> setEndpoint(String chain,
      {String? rpcUrl, String? esplora, int? chainId}) async {
    final cur = effectiveEndpoint(chain);
    _endpoints[chain] = EndpointCfg(
      rpcUrl: (rpcUrl != null && rpcUrl.isNotEmpty) ? rpcUrl : cur.rpcUrl,
      esplora: (esplora != null && esplora.isNotEmpty) ? esplora : cur.esplora,
      chainId: chainId ?? cur.chainId,
      alchemyUrl: cur.alchemyUrl,
    );
    await _persistEndpoints();
    _rebuildPreservingSession();
  }

  /// Configure (or clear) the per-chain Alchemy indexer URL used for ERC-20
  /// auto-detect. The URL embeds a READ-ONLY indexer key — stored in settings,
  /// never logged. Pass null/empty to turn auto-detect back OFF for the chain.
  Future<void> setAlchemy(String chain, String? url) async {
    final cur = effectiveEndpoint(chain);
    _endpoints[chain] = EndpointCfg(
      rpcUrl: cur.rpcUrl,
      esplora: cur.esplora,
      chainId: cur.chainId,
      alchemyUrl: (url != null && url.trim().isNotEmpty) ? url.trim() : null,
    );
    await _persistEndpoints();
    _rebuildPreservingSession();
  }

  bool alchemyEnabled(String chain) =>
      (effectiveEndpoint(chain).alchemyUrl ?? '').isNotEmpty;

  Future<void> resetEndpoint(String chain) async {
    _endpoints.remove(chain);
    await _persistEndpoints();
    _rebuildPreservingSession();
  }

  Future<void> _persistEndpoints() async {
    final m = <String, dynamic>{};
    _endpoints.forEach((chain, cfg) {
      m[chain] = {
        if (cfg.rpcUrl != null) 'rpcUrl': cfg.rpcUrl,
        if (cfg.esplora != null) 'esplora': cfg.esplora,
        if (cfg.chainId != null) 'chainId': cfg.chainId,
        if (cfg.alchemyUrl != null) 'alchemyUrl': cfg.alchemyUrl,
      };
    });
    await _storage.write(key: _kEndpoints, value: jsonEncode(m));
  }

  /// Rebuild the registry (new endpoints) while keeping the unlocked HD root, so
  /// a settings change doesn't force a re-unlock.
  void _rebuildPreservingSession() {
    final wasUnlocked = vault.isUnlocked;
    final pt = wasUnlocked ? vault.plaintext : null;
    _buildRegistryAndAccounts();
    // Rewire the agent's registry reference through its Accounts facade.
    agent = AgentService(
      accounts: accounts,
      venues: venues,
      telemetry: Telemetry(),
      confirm: _confirm,
      estimateUsd: _estimateUsd,
    );
    agent.load();
    if (pt != null) accounts.applyPlaintext(pt);
    notifyListeners();
  }

  // ---- vault setup / unlock ------------------------------------------------

  /// First-time multi-chain setup: generate (or import) a BIP39 mnemonic and
  /// seal it under [password]. BLOCK stays on its own engine; this adds the HD
  /// chains + the home for the agent credential.
  Future<void> setupVault(String password, {String? mnemonic}) async {
    final mn = (mnemonic != null && mnemonic.trim().isNotEmpty)
        ? mnemonic.trim()
        : hd.generateMnemonic();
    if (!hd.validateMnemonic(mn)) {
      throw Exception('that recovery phrase is not valid BIP39');
    }
    final pt = VaultPlaintext(mnemonic: mn);
    await vault.create(pt, password);
    accounts.applyPlaintext(pt);
    vaultExists = true;
    await _resumeAgent();
    notifyListeners();
  }

  /// Unlock the multi-chain vault (HD chains + agent). Best-effort: BLOCK works
  /// without it. Call after the BLOCK wallet is unlocked (common: same password).
  Future<bool> unlockVault(String password) async {
    if (!await vault.exists()) {
      vaultExists = false;
      notifyListeners();
      return false;
    }
    try {
      await accounts.unlock(password);
      vaultExists = true;
      await _resumeAgent();
      notifyListeners();
      return true;
    } catch (e) {
      lastAgentError = e.toString();
      notifyListeners();
      return false;
    }
  }

  /// Hook the UnlockScreen calls after the BLOCK wallet unlocks — tries the same
  /// password on the multi-chain vault so everything comes back in one step.
  Future<void> onAppUnlock(String password) async {
    if (await vault.exists()) {
      await unlockVault(password);
    }
  }

  Future<void> _resumeAgent() async {
    try {
      final r = await agent.resume();
      final skipped = (r['skipped'] as List?) ?? const [];
      lastAgentError = skipped.isEmpty ? null : 'some channels did not resume';
    } catch (e) {
      lastAgentError = e.toString();
    }
  }

  // ---- agent credential (stored in the vault, never in the clear) ----------

  bool get agentConnected {
    final a = vault.isUnlocked ? vault.plaintext?.agent : null;
    return a != null && (a['apiKey'] as String?)?.isNotEmpty == true;
  }

  String? get agentProvider =>
      vault.isUnlocked ? (vault.plaintext?.agent?['provider'] as String?) : null;

  /// Connect an LLM provider: store {provider, apiKey, model, baseUrl} in the
  /// unlocked vault and re-seal. Requires the vault password to persist.
  Future<void> connectProvider({
    required String provider,
    required String apiKey,
    String? model,
    String? baseUrl,
    required String password,
  }) async {
    if (!vault.isUnlocked) {
      throw Exception('unlock the multi-chain vault first');
    }
    final pt = vault.plaintext!;
    final guide = providerGuides[provider];
    pt.agent = {
      'provider': (guide?['provider'] as String?) ?? provider,
      'apiKey': apiKey,
      if (model != null && model.isNotEmpty) 'model': model,
      if (baseUrl != null && baseUrl.isNotEmpty) 'baseUrl': baseUrl,
      'label': provider,
    };
    await vault.reseal(password);
    await _resumeAgent();
    notifyListeners();
  }

  Future<void> disconnectProvider(String password) async {
    if (!vault.isUnlocked) return;
    // Stop every channel first (drops the live decrypted key), then clear cred.
    for (final ch in agent.manager.channels.values.toList()) {
      try {
        await agent.manager.stop(ch.id);
      } catch (_) {}
    }
    vault.plaintext!.agent = null;
    await vault.reseal(password);
    notifyListeners();
  }

  // ---- global KILL + lock --------------------------------------------------

  /// The always-visible KILL switch: stop every channel, wipe the agent key,
  /// AND fan out to lock the HD seed + BLOCK key + vault session.
  Future<void> killAll([String? reason]) async {
    try {
      await agent.manager.killAll(reason ?? 'user kill switch');
    } catch (_) {}
    try {
      accounts.kill();
    } catch (_) {}
    _app.store.lock();
    _app.refresh();
    notifyListeners();
  }

  // ---- agent confirm modal (REQUIRED, non-bypassable) ----------------------

  Future<bool> _confirm(Map<String, dynamic> summary) async {
    final ctx = _navKey.currentContext;
    if (ctx == null) return false; // fail-closed: no UI -> deny
    final ok = await showDialog<bool>(
      context: ctx,
      barrierDismissible: false,
      builder: (dctx) => AgentConfirmDialog(summary: summary),
    );
    return ok == true;
  }

  Future<num?> _estimateUsd(String asset, String amount) async {
    // No oracle wired yet — return null so the policy requires an explicit
    // confirm (it only auto-approves when a USD value is known AND under cap).
    return null;
  }

  // ---- read helpers for the UI ---------------------------------------------

  Future<DerivedAccount?> addressFor(String chain) async {
    try {
      return await accounts.accountFor(chain);
    } catch (_) {
      return null;
    }
  }

  Future<List<Balance>> balancesFor(String chain) async {
    try {
      return await accounts.balances(chain);
    } catch (e) {
      return [
        Balance(
            asset: registry.get(chain).native,
            confirmed: '0',
            display: '—',
            error: e.toString()),
      ];
    }
  }

  /// A MessageSigner for the exchange sign-in, backed by the BLOCK ML-DSA signer.
  Future<({String signature, String publicKey})> signForExchange(
      String message) async {
    final res = await _app.store.signMessage(message);
    return (
      signature: (res['signature'] ?? res['sig'] ?? '').toString(),
      publicKey: (res['publicKey'] ?? _app.store.publicKeyHex ?? '').toString(),
    );
  }
}

/// The REQUIRED confirmation modal the agent must clear before any value-moving
/// action. Renders the built tx / swap summary and the 0.05% fee leg.
class AgentConfirmDialog extends StatelessWidget {
  const AgentConfirmDialog({super.key, required this.summary});
  final Map<String, dynamic> summary;

  @override
  Widget build(BuildContext context) {
    final rows = <Widget>[];
    void add(String k, dynamic v) {
      if (v == null) return;
      rows.add(Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
                width: 92,
                child: Text(k,
                    style: const TextStyle(color: Color(0xFF9A9AB5), fontSize: 12))),
            Expanded(
                child: Text('$v',
                    style: const TextStyle(
                        fontFamily: 'monospace', fontSize: 12))),
          ],
        ),
      ));
    }

    summary.forEach((k, v) {
      if (v is Map || v is List) {
        add(k, jsonEncode(v));
      } else {
        add(k, v);
      }
    });

    return AlertDialog(
      backgroundColor: const Color(0xFF17172B),
      title: const Row(
        children: [
          Icon(Icons.verified_user, color: Color(0xFF7C5CFF), size: 20),
          SizedBox(width: 8),
          Text('Confirm agent action'),
        ],
      ),
      content: SizedBox(
        width: 360,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                  'The agent prepared this value-moving action. Review it — nothing '
                  'is broadcast until you approve.',
                  style: TextStyle(color: Color(0xFF9A9AB5), fontSize: 12)),
              const SizedBox(height: 12),
              ...rows,
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context, false),
          child: const Text('Reject', style: TextStyle(color: Color(0xFFFB7185))),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(context, true),
          child: const Text('Approve & broadcast'),
        ),
      ],
    );
  }
}
