// agent_service.dart — the host wiring for the in-wallet AI agent. Constructs a
// [ChannelManager] (lib/agent/channels.dart) bound to the app's Accounts facade,
// ChainRegistry, VenueRegistry, and Telemetry, and persists each channel's
// secret-free connection record so channels AUTO-RESUME on the next unlock.
//
// SAFETY / CREDENTIAL RULES (non-bypassable, mirror the extension):
//   - The LLM API key is NEVER persisted here. Channel records hold only a
//     `credRef`; the key is resolved from the UNLOCKED vault at start time,
//     held in memory for the session, and dropped on stop/kill/lock.
//   - Every value-moving tool goes through the agent's own policy
//     (caps -> confirm -> kill -> allowlist, hash-chained audit); this service
//     only provides the confirm handler + the host-wide kill fan-out.
//   - The global kill locks the Accounts facade (wipes HD seed + BLOCK key +
//     adapters + vault session) in one call.

import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

import '../agent/channels.dart';
import '../agent/index.dart' show AgentCredential;
import '../agent/providers.dart' show ProviderFetch, ProviderResponse;
import '../agent/tools.dart' show AgentContext;
import '../multichain/accounts.dart';
import '../multichain/chains/chain_adapter.dart';
import '../multichain/chains/registry.dart';
import '../multichain/telemetry.dart' show Telemetry;
import '../multichain/venues.dart' show VenueRegistry;

/// A [ChannelStore] backed by flutter_secure_storage. All channel keys (records
/// + per-channel audit logs) are kept in ONE JSON blob under [blobKey] so the
/// chrome.storage-style get/set/remove map onto a single encrypted entry.
class SecureChannelStore implements ChannelStore {
  SecureChannelStore({FlutterSecureStorage? storage, this.blobKey = 'bk_agent_channels'})
      : _storage = storage ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            );

  final FlutterSecureStorage _storage;
  final String blobKey;

  Future<Map<String, dynamic>> _read() async {
    final raw = await _storage.read(key: blobKey);
    if (raw == null || raw.isEmpty) return {};
    try {
      return (jsonDecode(raw) as Map).cast<String, dynamic>();
    } catch (_) {
      return {};
    }
  }

  Future<void> _write(Map<String, dynamic> m) =>
      _storage.write(key: blobKey, value: jsonEncode(m));

  @override
  Future<Map<String, dynamic>> get(List<String>? keys) async {
    final m = await _read();
    if (keys == null) return m;
    return {for (final k in keys) if (m.containsKey(k)) k: m[k]};
  }

  @override
  Future<void> set(Map<String, dynamic> obj) async {
    final m = await _read();
    m.addAll(obj);
    await _write(m);
  }

  @override
  Future<void> remove(List<String> keys) async {
    final m = await _read();
    for (final k in keys) {
      m.remove(k);
    }
    await _write(m);
  }
}

/// Default ProviderFetch over package:http (the providers only ever POST/GET to
/// their chosen LLM API — the key is in the headers the provider builds).
Future<ProviderResponse> httpProviderFetch(
  String url, {
  required String method,
  required Map<String, String> headers,
  required String body,
}) async {
  final uri = Uri.parse(url);
  final http.Response r;
  if (method == 'GET') {
    r = await http.get(uri, headers: headers);
  } else {
    r = await http.post(uri, headers: headers, body: body);
  }
  return ProviderResponse(r.statusCode >= 200 && r.statusCode < 300, r.statusCode, r.body);
}

/// The host service that owns the agent's channels.
class AgentService {
  AgentService({
    required this.accounts,
    required this.venues,
    this.telemetry,
    ChannelStore? store,
    ProviderFetch? fetch,
    Future<bool> Function(Map<String, dynamic> summary)? confirm,
    Future<num?> Function(String asset, String amount)? estimateUsd,
    Map<String, dynamic>? defaults,
  })  : store = store ?? SecureChannelStore(),
        _estimateUsd = estimateUsd {
    manager = ChannelManager(
      fetch: fetch ?? httpProviderFetch,
      store: this.store,
      resolveCredential: _resolveCredential,
      confirm: confirm,
      onKill: _killAll,
      ctxFor: _ctxFor,
      onEvent: _onEvent,
      defaults: defaults ?? const {},
    );
  }

  final Accounts accounts;
  final VenueRegistry venues;
  final Telemetry? telemetry;
  final ChannelStore store;
  final Future<num?> Function(String asset, String amount)? _estimateUsd;

  late final ChannelManager manager;

  ChainRegistry get registry => accounts.registry;

  /// Load persisted channel records (does NOT start them).
  Future<void> load() => manager.load();

  /// Auto-resume every enabled channel (call right after a successful unlock).
  Future<Map<String, dynamic>> resume() => manager.resume();

  // --- credential resolution (vault-only; never persisted) ------------------

  Future<AgentCredential?> _resolveCredential(
      String? credRef, Map<String, dynamic> meta) async {
    if (!accounts.vault.isUnlocked) return null;
    final agent = accounts.vault.plaintext?.agent;
    if (agent == null) return null;
    final apiKey = (agent['apiKey'] as String?) ?? '';
    if (apiKey.isEmpty) return null;
    return AgentCredential(
      provider: (meta['provider'] as String?) ?? (agent['provider'] as String?) ?? 'claude',
      apiKey: apiKey,
      model: (meta['model'] as String?) ?? agent['model'] as String?,
      baseUrl: (meta['baseUrl'] as String?) ?? agent['baseUrl'] as String?,
    );
  }

  // --- host-wide kill fan-out -----------------------------------------------

  Future<void> _killAll(String? reason) async {
    accounts.kill(); // wipes seed + BLOCK key + adapters + vault session
  }

  // --- telemetry (best-effort, fire-and-forget; never blocks the agent) -----

  void _onEvent(String id, Map<String, dynamic> ev) {
    final t = telemetry;
    if (t == null || !t.isEnabled()) return;
    try {
      t.emit({'channel': id, ...ev});
    } catch (_) {}
  }

  // --- per-channel AgentContext bound to Accounts + registry + venues -------

  AgentContext _ctxFor(Map<String, dynamic> meta) {
    return AgentContext(
      getAddress: (chain) async => (await accounts.accountFor(chain)).address,
      getBalance: (chain, [tokens]) async {
        final acct = await accounts.accountFor(chain);
        final bals = await registry
            .get(chain)
            .getBalance(acct.address, tokens: registry.tokensFor(chain));
        return [
          for (final b in bals)
            {
              'asset': b.asset.toJson(),
              'confirmed': b.confirmed,
              'display': b.display,
              if (b.spendable != null) 'spendable': b.spendable,
              if (b.error != null) 'error': b.error,
            }
        ];
      },
      buildSend: (chain, req) => _buildSend(chain, req),
      broadcast: (chain, built) => _broadcast(chain, built),
      explorerTx: (chain, txid) =>
          txid == null ? null : registry.get(chain).explorerTx(txid),
      estimateUsd: _estimateUsd,
      venues: venues,
      sendFee: (feeXfer) => _sendFee(feeXfer),
      executeSwap: (built) => _broadcast(built['chain'] as String, built),
    );
  }

  Future<Map<String, dynamic>> _buildSend(
      String chain, Map<String, dynamic> req) async {
    final acct = await accounts.accountFor(chain);
    final adapter = registry.get(chain);
    final built = await adapter.buildSend(
      acct,
      SendRequest(
        to: req['to'] as String,
        amount: '${req['amount']}',
        asset: _assetFromMap(req['asset']),
        feeRate: req['feeRate'] as String?,
        memo: req['memo'] as String?,
      ),
    );
    return {
      'chain': built.chain,
      'raw': built.raw,
      'txid': built.txid,
      'fee': built.fee,
    };
  }

  Future<Map<String, dynamic>> _broadcast(
      String chain, Map<String, dynamic> built) async {
    final adapter = registry.get(chain);
    final res = await adapter.broadcast(BuiltTx(
      chain: (built['chain'] as String?) ?? chain,
      raw: built['raw'] as String,
      txid: (built['txid'] as String?) ?? '',
      fee: '${built['fee'] ?? '0'}',
      summary: const SendRequest(to: '', amount: '0'),
    ));
    return {'txid': res.txid, 'accepted': res.accepted};
  }

  /// The 0.05% fee leg: a gated + audited transfer to the treasury on the fee's
  /// chain. Built + broadcast through the SAME adapters as any other send.
  Future<Map<String, dynamic>> _sendFee(Map<String, dynamic> feeXfer) async {
    final chain = feeXfer['chain'] as String;
    final built = await _buildSend(chain, {
      'to': feeXfer['treasury'] ?? feeXfer['to'],
      'amount': '${feeXfer['amount']}',
      'asset': feeXfer['asset'],
    });
    return _broadcast(chain, built);
  }

  static AssetRef? _assetFromMap(dynamic m) {
    if (m is! Map) return null;
    return AssetRef(
      chain: '${m['chain']}',
      kind: '${m['kind'] ?? 'native'}',
      symbol: '${m['symbol'] ?? ''}',
      decimals: (m['decimals'] as num?)?.toInt() ?? 0,
      address: m['address'] as String?,
    );
  }
}
