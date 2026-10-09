// agent/channels.dart — the multi-CHANNEL manager (Dart port of
// blockle-extension/agent/channels.js). A "channel" is one independent agent
// instance bound to a SPECIFIC wallet/account, with its OWN provider connection,
// venue/strategy config, spend/risk caps, kill switch, audit log, and P&L. A
// user can run several at once; each is fully isolated — a cap hit or a kill on
// one never touches another.
//
// PERSISTENT CONNECTION: a small secret-free record per channel is persisted so
// channels survive an app close and AUTO-RESUME on the next unlock.
//
// CREDENTIAL HANDLING (hard rule): the LLM API key is NEVER persisted here. The
// record holds only a `credRef` — an opaque pointer the host resolves against
// the unlocked vault. The key lives in memory only while the channel runs and is
// dropped on stop/kill/lock. Keys are never logged or sent to a Blockle server.

import 'dart:math';

import 'audit.dart' show AuditStore;
import 'index.dart';
import 'providers.dart' show ProviderFetch;
import 'tools.dart' show AgentContext;

const String channelsStoreKey = 'agentChannels';

/// Sane default caps: a value-moving channel must have caps before it can start.
const Map<String, dynamic> defaultChannelCaps = {'sessionUsd': 100, 'perAsset': {}};

/// "How do I get credentials" guidance shown in the UI for each provider.
const Map<String, Map<String, dynamic>> providerGuides = {
  'claude': {
    'label': 'Claude (Anthropic)',
    'provider': 'claude',
    'needs': ['apiKey'],
    'defaultModel': 'claude-sonnet-4-5',
    'url': 'https://console.anthropic.com/settings/keys',
    'how':
        'Sign in to the Anthropic Console, open Settings → API Keys, create a key (starts with sk-ant-), and paste it here. The key is stored encrypted in your vault and sent only to api.anthropic.com.',
  },
  'chatgpt': {
    'label': 'ChatGPT (OpenAI)',
    'provider': 'openai',
    'needs': ['apiKey'],
    'defaultModel': 'gpt-4.1',
    'url': 'https://platform.openai.com/api-keys',
    'how':
        'Sign in to the OpenAI platform, open API keys, create a secret key (starts with sk-), and paste it here. The key is stored encrypted in your vault and sent only to api.openai.com.',
  },
  'copilot': {
    'label': 'GitHub Copilot',
    'provider': 'copilot',
    'needs': ['apiKey'],
    'defaultModel': 'gpt-4.1',
    'url': 'https://github.com/settings/tokens',
    'how':
        'Authorize via GitHub device/OAuth sign-in, or paste a GitHub token that has Copilot access. The token is stored encrypted in your vault and sent only to the Copilot endpoint.',
  },
  'other': {
    'label': 'Other (OpenAI-compatible)',
    'provider': 'openai',
    'needs': ['baseUrl', 'model', 'apiKey'],
    'defaultModel': '',
    'url': '',
    'how':
        'Point at any OpenAI-compatible endpoint: enter the base URL (e.g. https://host/v1 — your wallet appends /chat/completions), the exact model name, and the API key. Everything is stored encrypted in your vault and sent only to the base URL you provide.',
  },
};

/// Persistent store shim (the chrome.storage get/set/remove shape).
abstract class ChannelStore {
  Future<Map<String, dynamic>> get(List<String>? keys);
  Future<void> set(Map<String, dynamic> obj);
  Future<void> remove(List<String> keys);
}

bool _hasCaps(Map<String, dynamic>? caps) {
  if (caps == null) return false;
  if (caps['sessionUsd'] != null) return true;
  if (caps['perAsset'] is Map && (caps['perAsset'] as Map).isNotEmpty) return true;
  return false;
}

final Random _rng = Random.secure();
String _rid() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return 'ch${List.generate(8, (_) => chars[_rng.nextInt(chars.length)]).join()}';
}

/// A Store wrapper prefixing every key with `ch:<id>:` so each channel's audit
/// log persists under its OWN key. Only set() is needed by the Audit.
class _NamespacedAuditStore implements AuditStore {
  final ChannelStore store;
  final String prefix;
  _NamespacedAuditStore(this.store, String id) : prefix = 'ch:$id:';
  @override
  Future<void> set(Map<String, dynamic> obj) {
    final next = <String, dynamic>{};
    obj.forEach((k, v) => next['$prefix$k'] = v);
    return store.set(next);
  }
}

/// One running (or stopped) channel. Holds its persisted meta + the live agent
/// instance when running. All value/safety enforcement lives inside the agent's
/// own policy — this class owns lifecycle, isolation, and P&L bookkeeping.
class Channel {
  final ChannelManager manager;
  final Map<String, dynamic> meta; // persisted record (NO apiKey)
  AgentInstance? instance;
  bool killed = false;
  late final Map<String, dynamic> pnl;

  Channel(this.manager, this.meta) {
    pnl = {
      'realizedUsd': 0,
      'tradeCount': 0,
      'trades': <Map<String, dynamic>>[],
      ...?(meta['pnl'] as Map?)?.cast<String, dynamic>(),
    };
    pnl['trades'] ??= <Map<String, dynamic>>[];
  }

  String get id => meta['id'] as String;
  bool get running => instance != null;

  Map<String, dynamic> describe() => {
        'id': meta['id'],
        'label': meta['label'],
        'walletId': meta['walletId'],
        'accountId': meta['accountId'],
        'provider': meta['provider'],
        'model': meta['model'],
        'baseUrl': meta['baseUrl'],
        'credRef': meta['credRef'],
        'enabled': meta['enabled'] == true,
        'running': running,
        'killed': killed,
        'readOnly': meta['readOnly'] == true,
        'config': meta['config'] ?? {},
        'caps': meta['caps'] ?? {},
        'pnl': {'realizedUsd': pnl['realizedUsd'], 'tradeCount': pnl['tradeCount']},
        'remaining': instance?.remaining(),
        'createdAt': meta['createdAt'],
      };

  Future<void> recordPnl(Map<String, dynamic> entry) {
    if (entry['realizedUsd'] != null) {
      pnl['realizedUsd'] = (pnl['realizedUsd'] as num) + (entry['realizedUsd'] as num);
    }
    (pnl['trades'] as List).add({'ts': DateTime.now().millisecondsSinceEpoch, ...entry});
    meta['pnl'] = {'realizedUsd': pnl['realizedUsd'], 'tradeCount': pnl['tradeCount']};
    return manager.persist();
  }

  Future<dynamic> run(String prompt, {bool Function()? aborted}) {
    if (instance == null) throw StateError('channel not started: $id');
    return instance!.run(prompt, aborted: aborted);
  }

  Future<void> setCaps(Map<String, dynamic> caps) {
    meta['caps'] = {...?(meta['caps'] as Map?)?.cast<String, dynamic>(), ...caps};
    instance?.setCaps(meta['caps'] as Map<String, dynamic>);
    return manager.persist();
  }

  Map<String, dynamic>? remaining() => instance?.remaining();

  /// Kill THIS channel only. Other channels are untouched. Marks it disabled so
  /// it does not auto-resume until the user explicitly reconnects.
  Future<void> kill([String? reason]) async {
    killed = true;
    meta['enabled'] = false;
    if (instance != null) {
      try {
        await instance!.kill(reason ?? 'channel kill');
      } catch (_) {}
    }
    instance = null; // drop the only ref that holds the decrypted key
    await manager.persist();
  }
}

class ChannelManager {
  final ChannelStore? store;
  final ProviderFetch fetch;
  final Future<AgentCredential?> Function(String? credRef, Map<String, dynamic> meta)?
      resolveCredential;
  final Future<bool> Function(Map<String, dynamic> summary)? confirm;
  final Future<void> Function(String? reason)? onKill;
  final Future<void> Function(String id, String? reason)? onChannelKill;
  final void Function(String id, Map<String, dynamic> ev)? onEvent;
  final AgentContext Function(Map<String, dynamic> meta)? ctxFor;
  final Map<String, dynamic> defaults;
  final Map<String, Channel> channels = {};

  ChannelManager({
    required this.fetch,
    this.store,
    this.resolveCredential,
    this.confirm,
    this.onKill,
    this.onChannelKill,
    this.onEvent,
    this.ctxFor,
    Map<String, dynamic>? defaults,
  }) : defaults = defaults ?? const {};

  /// Load persisted records into memory (does NOT start them — call resume()).
  Future<List<Map<String, dynamic>>> load() async {
    List recs = [];
    if (store != null) {
      try {
        recs = (await store!.get([channelsStoreKey]))[channelsStoreKey] as List? ?? [];
      } catch (_) {
        recs = [];
      }
    }
    channels.clear();
    for (final rec in recs) {
      final meta = (rec as Map).cast<String, dynamic>();
      channels[meta['id'] as String] = Channel(this, meta);
    }
    return list();
  }

  Future<void> persist() async {
    if (store == null) return;
    final recs = [for (final ch in channels.values) ch.meta];
    try {
      await store!.set({channelsStoreKey: recs});
    } catch (_) {}
  }

  List<Map<String, dynamic>> list() =>
      channels.values.map((c) => c.describe()).toList();

  Channel? get(String id) => channels[id];

  /// Create a new channel record (does NOT start it unless `start: true`).
  Future<Map<String, dynamic>> create(Map<String, dynamic> spec) async {
    if (spec['provider'] == null) throw StateError('channel requires a provider');
    if (spec['walletId'] == null && spec['accountId'] == null) {
      throw StateError('channel must be bound to a wallet/account (walletId or accountId)');
    }
    final guide = providerGuides[spec['provider']];
    final readOnly = spec['readOnly'] == true;
    final meta = <String, dynamic>{
      'id': spec['id'] ?? _rid(),
      'label': spec['label'] ?? 'Channel ${channels.length + 1}',
      'walletId': spec['walletId'],
      'accountId': spec['accountId'],
      'provider': spec['provider'],
      'model': spec['model'] ?? guide?['defaultModel'] ?? defaults['model'],
      'baseUrl': spec['baseUrl'],
      'credRef': spec['credRef'],
      'enabled': false,
      'readOnly': readOnly,
      'config': spec['config'] ?? {},
      'caps': spec['caps'] ?? (readOnly ? {} : Map<String, dynamic>.from(defaultChannelCaps)),
      'pnl': {'realizedUsd': 0, 'tradeCount': 0},
      'createdAt': DateTime.now().millisecondsSinceEpoch,
    };
    if (channels.containsKey(meta['id'])) {
      throw StateError('channel already exists: ${meta['id']}');
    }
    final ch = Channel(this, meta);
    channels[meta['id'] as String] = ch;
    await persist();
    if (spec['start'] == true) await start(meta['id'] as String);
    return ch.describe();
  }

  /// Start (connect) a channel: resolve its credential, build its isolated agent
  /// instance, and mark it enabled so it auto-resumes on the next unlock.
  Future<Map<String, dynamic>> start(String id) async {
    final ch = channels[id];
    if (ch == null) throw StateError('no such channel: $id');
    if (ch.instance != null) return ch.describe(); // already running

    final meta = ch.meta;
    final readOnly = meta['readOnly'] == true;

    // Refuse to arm a value-moving channel without caps + a confirm handler.
    if (!readOnly) {
      if (!_hasCaps((meta['caps'] as Map?)?.cast<String, dynamic>())) {
        throw StateError(
            'refusing to start "${meta['label']}": set spend/risk caps first (value-moving channels require caps)');
      }
      if (confirm == null) {
        throw StateError(
            'refusing to start "${meta['label']}": a confirmation handler is required for value-moving channels');
      }
    }

    AgentCredential? cred;
    if (resolveCredential != null) cred = await resolveCredential!(meta['credRef'] as String?, meta);
    if (cred == null || cred.apiKey.isEmpty) {
      throw StateError(
          'cannot start "${meta['label']}": no LLM credential available (unlock the wallet and connect this channel)');
    }
    final credential = AgentCredential(
      provider: (meta['provider'] as String?) ?? cred.provider,
      apiKey: cred.apiKey,
      model: (meta['model'] as String?) ?? cred.model,
      baseUrl: (meta['baseUrl'] as String?) ?? cred.baseUrl,
    );

    Future<void> onKillLocal(String? reason) async {
      if (onChannelKill != null) {
        try {
          await onChannelKill!(id, reason);
        } catch (_) {}
      }
    }

    void onEventLocal(Map<String, dynamic> ev) {
      if (ev['type'] == 'executed' && ev['txid'] != null) {
        ch.pnl['tradeCount'] = (ch.pnl['tradeCount'] as int) + 1;
        (ch.pnl['trades'] as List).add(
            {'ts': DateTime.now().millisecondsSinceEpoch, 'name': ev['name'], 'txid': ev['txid']});
        meta['pnl'] = {'realizedUsd': ch.pnl['realizedUsd'], 'tradeCount': ch.pnl['tradeCount']};
        persist();
      }
      if (onEvent != null) {
        try {
          onEvent!(id, ev);
        } catch (_) {}
      }
    }

    final config = (meta['config'] as Map?)?.cast<String, dynamic>() ?? const {};
    ch.instance = startAgent(
      credential: credential,
      fetch: fetch,
      ctx: ctxFor != null ? ctxFor!(meta) : (defaults['ctx'] as AgentContext? ?? const AgentContext()),
      caps: (meta['caps'] as Map?)?.cast<String, dynamic>() ?? {},
      confirm: confirm,
      onKill: onKillLocal,
      store: store != null ? _NamespacedAuditStore(store!, id) : null,
      onEvent: onEventLocal,
      model: credential.model,
      allowlist: (config['allowlist'] as List?)?.cast<String>() ??
          (defaults['allowlist'] as List?)?.cast<String>(),
      system: (config['system'] as String?) ?? defaults['system'] as String?,
      maxTurns: (config['maxTurns'] as int?) ?? defaults['maxTurns'] as int?,
      requireConfirm: readOnly ? false : true,
      autoApproveUnderUsd: config['autoApproveUnderUsd'] as num?,
    );
    ch.killed = false;
    meta['enabled'] = true;
    await persist();
    return ch.describe();
  }

  /// Stop (disconnect) a channel: tear down the live instance + its decrypted
  /// credential, and mark it disabled. The record + caps/config/P&L are kept.
  Future<Map<String, dynamic>> stop(String id) async {
    final ch = channels[id];
    if (ch == null) throw StateError('no such channel: $id');
    if (ch.instance != null) {
      try {
        ch.instance!.reset();
      } catch (_) {}
    }
    ch.instance = null;
    ch.meta['enabled'] = false;
    await persist();
    return ch.describe();
  }

  /// Permanently remove a channel: stop it, then drop its record + audit log.
  Future<bool> delete(String id) async {
    final ch = channels[id];
    if (ch == null) return false;
    try {
      await stop(id);
    } catch (_) {}
    channels.remove(id);
    await persist();
    if (store != null) {
      try {
        await store!.remove(['ch:$id:agentAuditLog']);
      } catch (_) {}
    }
    return true;
  }

  /// Auto-resume every enabled channel after an unlock. Channels that cannot be
  /// resumed are skipped and reported, not thrown.
  Future<Map<String, dynamic>> resume() async {
    final started = <String>[];
    final skipped = <Map<String, dynamic>>[];
    for (final ch in channels.values) {
      if (ch.meta['enabled'] != true || ch.instance != null) continue;
      try {
        await start(ch.id);
        started.add(ch.id);
      } catch (e) {
        skipped.add({'id': ch.id, 'reason': '$e'});
      }
    }
    return {'started': started, 'skipped': skipped};
  }

  /// The always-visible global kill: stop every channel AND run the host-wide
  /// kill hook (locks the vault, revokes exchange sessions).
  Future<void> killAll([String? reason]) async {
    for (final ch in channels.values) {
      try {
        await ch.kill(reason ?? 'kill all');
      } catch (_) {}
    }
    if (onKill != null) {
      try {
        await onKill!(reason ?? 'kill all');
      } catch (_) {}
    }
    await persist();
  }
}
