// agent_screen.dart — the AGENT COCKPIT (PASS 2 #3).
//
// Provider CONNECT (Claude / ChatGPT / Copilot / Other) with a per-provider
// "how to get a key" guide + link; the connection persists in the vault and
// auto-reconnects on unlock until the user disconnects. A MULTI-CHANNEL list,
// each channel bound to a wallet/account with its own P&L, command box,
// predefined prompts, venue toggles + strategy/slippage config, and spend caps.
//
// SAFETY (enforced, not optional):
//   • a REQUIRED confirm modal (provided by MultichainController._confirm) gates
//     every value-moving action — the agent fails closed without it;
//   • an always-visible KILL switch (global + per-channel);
//   • sane default session caps on every value-moving channel;
//   • the core REFUSES to start a value-moving channel until caps are set.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../agent/channels.dart' show providerGuides;
import '../agent/runner.dart' show RunResult;
import '../state/app_state.dart';
import '../state/multichain_controller.dart';
import '../theme.dart';

const List<String> _predefinedPrompts = [
  'DCA \$50/week into BLOCK',
  'Rebalance to 50/50',
  'Buy the dip -10%',
  'Take profit +25%',
  'Market-make BLOCK/USDC',
];

const List<String> _venueIds = ['blockle', 'evmdex', 'jupiter'];

class AgentScreen extends StatefulWidget {
  const AgentScreen({super.key});
  @override
  State<AgentScreen> createState() => _AgentScreenState();
}

class _AgentScreenState extends State<AgentScreen> {
  List<Map<String, dynamic>> _channels = [];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _refresh());
  }

  void _refresh() {
    final c = context.read<MultichainController>();
    setState(() => _channels = c.agent.manager.list());
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<MultichainController>();
    final connected = c.agentConnected;
    return SafeArea(
      child: ListView(
        padding: const EdgeInsets.fromLTRB(18, 14, 18, 28),
        children: [
          Row(
            children: [
              const Text('Agent',
                  style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
              const Spacer(),
              _killButton(c),
            ],
          ),
          const SizedBox(height: 10),
          if (!c.vaultUnlocked)
            _lockedBanner()
          else ...[
            _providerCard(c, connected),
            const SizedBox(height: 18),
            Row(
              children: [
                const Text('Channels',
                    style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
                const Spacer(),
                TextButton.icon(
                  onPressed: connected ? () => _createChannel(c) : null,
                  icon: const Icon(Icons.add, size: 18),
                  label: const Text('New channel'),
                ),
              ],
            ),
            if (_channels.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 8),
                child: Text(
                    'No channels yet. Connect a provider, then add a channel bound to an account.',
                    style: TextStyle(color: Bk.muted, fontSize: 13)),
              ),
            ..._channels.map((ch) => _channelCard(c, ch)),
          ],
        ],
      ),
    );
  }

  Widget _killButton(MultichainController c) {
    return OutlinedButton.icon(
      onPressed: () async {
        final ok = await showDialog<bool>(
          context: context,
          builder: (_) => AlertDialog(
            backgroundColor: Bk.surface,
            title: const Text('Kill switch'),
            content: const Text(
                'Stop every agent channel, wipe the in-memory LLM key, and lock '
                'all keys (HD seed + BLOCK key + vault). Nothing spendable survives.'),
            actions: [
              TextButton(
                  onPressed: () => Navigator.pop(context, false),
                  child: const Text('Cancel')),
              FilledButton(
                style: FilledButton.styleFrom(backgroundColor: Bk.bad),
                onPressed: () => Navigator.pop(context, true),
                child: const Text('KILL'),
              ),
            ],
          ),
        );
        if (ok == true) {
          await c.killAll('user kill switch');
          _refresh();
        }
      },
      style: OutlinedButton.styleFrom(
        foregroundColor: Bk.bad,
        side: const BorderSide(color: Bk.bad),
        minimumSize: const Size(0, 40),
        padding: const EdgeInsets.symmetric(horizontal: 14),
      ),
      icon: const Icon(Icons.power_settings_new, size: 16),
      label: const Text('KILL'),
    );
  }

  Widget _lockedBanner() {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Bk.accent.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: Bk.accent.withValues(alpha: 0.4)),
      ),
      child: const Text(
          'Unlock the multi-chain vault (Accounts tab) to connect an AI provider. '
          'The LLM key is stored encrypted in the vault and sent only to the provider you choose.',
          style: TextStyle(color: Bk.muted, fontSize: 13)),
    );
  }

  // ---- provider connect ----------------------------------------------------

  Widget _providerCard(MultichainController c, bool connected) {
    if (connected) {
      final prov = c.agentProvider ?? 'provider';
      return Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: Bk.surface,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: Bk.good.withValues(alpha: 0.4)),
        ),
        child: Row(
          children: [
            const Icon(Icons.check_circle, color: Bk.good, size: 20),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Connected · $prov',
                      style: const TextStyle(fontWeight: FontWeight.w700)),
                  const Text('Key stored encrypted in the vault · auto-reconnects on unlock',
                      style: TextStyle(color: Bk.muted, fontSize: 11)),
                ],
              ),
            ),
            TextButton(
              onPressed: () => _disconnectProvider(c),
              child: const Text('Disconnect', style: TextStyle(color: Bk.bad)),
            ),
          ],
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('Connect an AI provider',
            style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
        const SizedBox(height: 8),
        for (final entry in providerGuides.entries)
          _providerTile(c, entry.key, entry.value),
      ],
    );
  }

  Widget _providerTile(
      MultichainController c, String id, Map<String, dynamic> guide) {
    return Card(
      child: ListTile(
        title: Text('${guide['label']}'),
        subtitle: Text('${guide['how']}',
            style: const TextStyle(color: Bk.muted, fontSize: 11)),
        isThreeLine: true,
        trailing: FilledButton(
          onPressed: () => _connectDialog(c, id, guide),
          style: FilledButton.styleFrom(minimumSize: const Size(0, 38)),
          child: const Text('Connect'),
        ),
      ),
    );
  }

  Future<void> _connectDialog(
      MultichainController c, String id, Map<String, dynamic> guide) async {
    final key = TextEditingController();
    final model = TextEditingController(text: '${guide['defaultModel'] ?? ''}');
    final baseUrl = TextEditingController();
    final pw = TextEditingController();
    final needs = (guide['needs'] as List).cast<String>();
    final url = '${guide['url'] ?? ''}';
    final app = context.read<AppState>();

    final res = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: Bk.surface,
        title: Text('Connect ${guide['label']}'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('${guide['how']}',
                  style: const TextStyle(color: Bk.muted, fontSize: 12)),
              if (url.isNotEmpty) ...[
                const SizedBox(height: 8),
                InkWell(
                  onTap: () {
                    Navigator.pop(context, false);
                    app.openBrowser(url);
                  },
                  child: Text('Open $url',
                      style: const TextStyle(
                          color: Bk.accent,
                          fontSize: 12,
                          decoration: TextDecoration.underline)),
                ),
              ],
              const SizedBox(height: 12),
              if (needs.contains('baseUrl'))
                TextField(
                  controller: baseUrl,
                  decoration: const InputDecoration(
                      labelText: 'Base URL', hintText: 'https://host/v1'),
                ),
              if (needs.contains('model')) ...[
                const SizedBox(height: 8),
                TextField(
                  controller: model,
                  decoration: const InputDecoration(labelText: 'Model'),
                ),
              ],
              const SizedBox(height: 8),
              TextField(
                controller: key,
                obscureText: true,
                decoration: const InputDecoration(labelText: 'API key'),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: pw,
                obscureText: true,
                decoration: const InputDecoration(
                    labelText: 'Vault password (to save encrypted)'),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Connect')),
        ],
      ),
    );
    if (res != true) return;
    if (key.text.trim().isEmpty) {
      _snack('Enter an API key.');
      return;
    }
    try {
      await c.connectProvider(
        provider: id,
        apiKey: key.text.trim(),
        model: model.text.trim().isEmpty ? null : model.text.trim(),
        baseUrl: baseUrl.text.trim().isEmpty ? null : baseUrl.text.trim(),
        password: pw.text,
      );
      _refresh();
      _snack('Provider connected');
    } catch (e) {
      _snack(e.toString().replaceFirst('Exception: ', ''));
    }
  }

  Future<void> _disconnectProvider(MultichainController c) async {
    final pw = TextEditingController();
    final res = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: Bk.surface,
        title: const Text('Disconnect provider'),
        content: TextField(
          controller: pw,
          obscureText: true,
          decoration: const InputDecoration(labelText: 'Vault password'),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Disconnect')),
        ],
      ),
    );
    if (res != true) return;
    try {
      await c.disconnectProvider(pw.text);
      _refresh();
    } catch (e) {
      _snack(e.toString().replaceFirst('Exception: ', ''));
    }
  }

  // ---- channels ------------------------------------------------------------

  Future<void> _createChannel(MultichainController c) async {
    final label = TextEditingController();
    String chain = 'block';
    bool readOnly = false;
    final res = await showDialog<bool>(
      context: context,
      builder: (_) => StatefulBuilder(
        builder: (dctx, setLocal) => AlertDialog(
          backgroundColor: Bk.surface,
          title: const Text('New channel'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: label,
                decoration: const InputDecoration(labelText: 'Label'),
              ),
              const SizedBox(height: 10),
              DropdownButtonFormField<String>(
                initialValue: chain,
                dropdownColor: Bk.surface2,
                decoration: const InputDecoration(labelText: 'Bound account'),
                items: [
                  for (final ch in c.displayChains())
                    DropdownMenuItem(value: ch, child: Text(c.chainLabel(ch))),
                ],
                onChanged: (v) => setLocal(() => chain = v ?? 'block'),
              ),
              const SizedBox(height: 6),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Read-only (no value-moving tools)',
                    style: TextStyle(fontSize: 13)),
                value: readOnly,
                onChanged: (v) => setLocal(() => readOnly = v),
              ),
            ],
          ),
          actions: [
            TextButton(
                onPressed: () => Navigator.pop(dctx, false),
                child: const Text('Cancel')),
            FilledButton(
                onPressed: () => Navigator.pop(dctx, true),
                child: const Text('Create')),
          ],
        ),
      ),
    );
    if (res != true) return;
    try {
      await c.agent.manager.create({
        'provider': c.agentProvider ?? 'claude',
        'label': label.text.trim().isEmpty ? null : label.text.trim(),
        'accountId': chain,
        'readOnly': readOnly,
        'config': {'venues': _venueIds, 'slippage': 0.005},
      });
      _refresh();
    } catch (e) {
      _snack(e.toString().replaceFirst('Exception: ', ''));
    }
  }

  Widget _channelCard(MultichainController c, Map<String, dynamic> ch) {
    final id = ch['id'] as String;
    final running = ch['running'] == true;
    final readOnly = ch['readOnly'] == true;
    final caps = (ch['caps'] as Map?)?.cast<String, dynamic>() ?? {};
    final hasCaps = caps['sessionUsd'] != null ||
        (caps['perAsset'] is Map && (caps['perAsset'] as Map).isNotEmpty);
    final pnl = (ch['pnl'] as Map?)?.cast<String, dynamic>() ?? {};
    final cfg = (ch['config'] as Map?)?.cast<String, dynamic>() ?? {};
    final venues = (cfg['venues'] as List?)?.cast<String>() ?? const [];

    return Card(
      margin: const EdgeInsets.only(top: 10),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(running ? Icons.circle : Icons.circle_outlined,
                    size: 12, color: running ? Bk.good : Bk.muted),
                const SizedBox(width: 8),
                Expanded(
                  child: Text('${ch['label']}',
                      style: const TextStyle(fontWeight: FontWeight.w700)),
                ),
                if (readOnly)
                  const Text('read-only',
                      style: TextStyle(color: Bk.muted, fontSize: 11)),
              ],
            ),
            const SizedBox(height: 2),
            Text('account: ${ch['accountId'] ?? ch['walletId'] ?? '—'} · ${ch['provider']}',
                style: const TextStyle(color: Bk.muted, fontSize: 11)),
            const SizedBox(height: 10),
            // P&L / performance
            Row(
              children: [
                _stat('Realized', '\$${pnl['realizedUsd'] ?? 0}'),
                _stat('Trades', '${pnl['tradeCount'] ?? 0}'),
                _stat('Session cap',
                    caps['sessionUsd'] != null ? '\$${caps['sessionUsd']}' : 'unset'),
              ],
            ),
            const SizedBox(height: 10),
            if (!readOnly && !hasCaps)
              Container(
                padding: const EdgeInsets.all(10),
                margin: const EdgeInsets.only(bottom: 10),
                decoration: BoxDecoration(
                  color: Bk.bad.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: Bk.bad.withValues(alpha: 0.4)),
                ),
                child: const Text(
                    'Caps required. Value-moving tools are refused until you set spend caps.',
                    style: TextStyle(color: Bk.bad, fontSize: 12)),
              ),
            // venue toggles
            Wrap(
              spacing: 6,
              children: [
                for (final v in _venueIds)
                  FilterChip(
                    label: Text(v, style: const TextStyle(fontSize: 11)),
                    selected: venues.contains(v),
                    selectedColor: Bk.accent.withValues(alpha: 0.25),
                    backgroundColor: Bk.surface2,
                    onSelected: (sel) =>
                        _toggleVenue(c, id, cfg, v, sel),
                  ),
              ],
            ),
            const SizedBox(height: 8),
            // actions
            Wrap(
              spacing: 8,
              runSpacing: 4,
              children: [
                FilledButton(
                  style: FilledButton.styleFrom(
                      minimumSize: const Size(0, 38),
                      padding: const EdgeInsets.symmetric(horizontal: 14)),
                  onPressed: () => _toggleRun(c, id, running),
                  child: Text(running ? 'Disconnect' : 'Connect'),
                ),
                OutlinedButton(
                  style: OutlinedButton.styleFrom(
                      minimumSize: const Size(0, 38),
                      padding: const EdgeInsets.symmetric(horizontal: 14)),
                  onPressed: () => _capsDialog(c, id, caps),
                  child: const Text('Caps'),
                ),
                OutlinedButton(
                  style: OutlinedButton.styleFrom(
                      minimumSize: const Size(0, 38),
                      padding: const EdgeInsets.symmetric(horizontal: 14)),
                  onPressed: () => _strategyDialog(c, id, cfg),
                  child: const Text('Strategy'),
                ),
                OutlinedButton(
                  style: OutlinedButton.styleFrom(
                      minimumSize: const Size(0, 38),
                      padding: const EdgeInsets.symmetric(horizontal: 14),
                      foregroundColor: Bk.bad,
                      side: const BorderSide(color: Bk.bad)),
                  onPressed: () async {
                    await c.agent.manager.get(id)?.kill('channel kill');
                    _refresh();
                  },
                  child: const Text('Kill'),
                ),
                OutlinedButton(
                  style: OutlinedButton.styleFrom(
                      minimumSize: const Size(0, 38),
                      padding: const EdgeInsets.symmetric(horizontal: 14)),
                  onPressed: () async {
                    await c.agent.manager.delete(id);
                    _refresh();
                  },
                  child: const Text('Delete'),
                ),
              ],
            ),
            const SizedBox(height: 10),
            // predefined prompts
            Wrap(
              spacing: 6,
              runSpacing: 4,
              children: [
                for (final p in _predefinedPrompts)
                  ActionChip(
                    label: Text(p, style: const TextStyle(fontSize: 11)),
                    backgroundColor: Bk.surface2,
                    onPressed: running ? () => _runPrompt(c, id, p) : null,
                  ),
              ],
            ),
            const SizedBox(height: 8),
            // command box
            _CommandBox(
              enabled: running,
              onSend: (text) => _runPrompt(c, id, text),
            ),
          ],
        ),
      ),
    );
  }

  Widget _stat(String label, String value) {
    return Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: const TextStyle(color: Bk.muted, fontSize: 11)),
          Text(value,
              style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14)),
        ],
      ),
    );
  }

  Future<void> _toggleVenue(MultichainController c, String id,
      Map<String, dynamic> cfg, String venue, bool sel) async {
    final venues = {...((cfg['venues'] as List?)?.cast<String>() ?? const [])};
    if (sel) {
      venues.add(venue);
    } else {
      venues.remove(venue);
    }
    final ch = c.agent.manager.get(id);
    if (ch == null) return;
    ch.meta['config'] = {...cfg, 'venues': venues.toList()};
    await c.agent.manager.persist();
    _refresh();
  }

  Future<void> _toggleRun(
      MultichainController c, String id, bool running) async {
    try {
      if (running) {
        await c.agent.manager.stop(id);
      } else {
        await c.agent.manager.start(id);
      }
      _refresh();
    } catch (e) {
      _snack(e.toString().replaceFirst('Exception: ', ''));
    }
  }

  Future<void> _capsDialog(
      MultichainController c, String id, Map<String, dynamic> caps) async {
    final sessionUsd =
        TextEditingController(text: '${caps['sessionUsd'] ?? 100}');
    final res = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: Bk.surface,
        title: const Text('Spend caps'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text(
                'Per-session USD cap. The agent refuses value-moving tools without caps, '
                'and never exceeds them without a fresh confirm.',
                style: TextStyle(color: Bk.muted, fontSize: 12)),
            const SizedBox(height: 12),
            TextField(
              controller: sessionUsd,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: const InputDecoration(labelText: 'Session USD cap'),
            ),
          ],
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Save')),
        ],
      ),
    );
    if (res != true) return;
    final v = num.tryParse(sessionUsd.text.trim());
    await c.agent.manager.get(id)?.setCaps({'sessionUsd': v});
    _refresh();
  }

  Future<void> _strategyDialog(
      MultichainController c, String id, Map<String, dynamic> cfg) async {
    final slippage =
        TextEditingController(text: '${cfg['slippage'] ?? 0.005}');
    final strategy = TextEditingController(text: '${cfg['strategy'] ?? ''}');
    final res = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: Bk.surface,
        title: const Text('Strategy'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: slippage,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: const InputDecoration(
                  labelText: 'Slippage (fraction, e.g. 0.005 = 0.5%)'),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: strategy,
              minLines: 2,
              maxLines: 4,
              decoration: const InputDecoration(
                  labelText: 'Strategy notes (passed to the agent)'),
            ),
          ],
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Save')),
        ],
      ),
    );
    if (res != true) return;
    final ch = c.agent.manager.get(id);
    if (ch == null) return;
    ch.meta['config'] = {
      ...cfg,
      'slippage': num.tryParse(slippage.text.trim()) ?? 0.005,
      'strategy': strategy.text.trim(),
    };
    await c.agent.manager.persist();
    _refresh();
  }

  Future<void> _runPrompt(
      MultichainController c, String id, String prompt) async {
    final ch = c.agent.manager.get(id);
    if (ch == null || !ch.running) {
      _snack('Connect the channel first.');
      return;
    }
    final cfg = (ch.meta['config'] as Map?)?.cast<String, dynamic>() ?? {};
    final strategy = cfg['strategy'] as String?;
    final fullPrompt = (strategy != null && strategy.isNotEmpty)
        ? '$prompt\n\n[channel strategy: $strategy; slippage: ${cfg['slippage']}; venues: ${cfg['venues']}]'
        : prompt;
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (_) => const Center(child: CircularProgressIndicator()),
    );
    RunResult? result;
    String? err;
    try {
      result = await ch.run(fullPrompt);
    } catch (e) {
      err = e.toString().replaceFirst('Exception: ', '');
    }
    if (!mounted) return;
    Navigator.pop(context); // close spinner
    _refresh();
    await showDialog<void>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: Bk.surface,
        title: const Text('Agent'),
        content: SingleChildScrollView(
          child: Text(
            err ?? (result?.text ?? 'Done (${result?.reason ?? 'no output'}).'),
            style: const TextStyle(fontSize: 13),
          ),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Close')),
        ],
      ),
    );
  }

  void _snack(String m) {
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
    }
  }
}

class _CommandBox extends StatefulWidget {
  const _CommandBox({required this.enabled, required this.onSend});
  final bool enabled;
  final void Function(String text) onSend;
  @override
  State<_CommandBox> createState() => _CommandBoxState();
}

class _CommandBoxState extends State<_CommandBox> {
  final _ctrl = TextEditingController();
  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: TextField(
            controller: _ctrl,
            enabled: widget.enabled,
            decoration: InputDecoration(
              hintText: widget.enabled
                  ? 'Message the agent…'
                  : 'Connect the channel to message it',
              isDense: true,
            ),
            onSubmitted: (_) => _send(),
          ),
        ),
        const SizedBox(width: 8),
        IconButton(
          onPressed: widget.enabled ? _send : null,
          icon: const Icon(Icons.send, color: Bk.accent),
        ),
      ],
    );
  }

  void _send() {
    final t = _ctrl.text.trim();
    if (t.isEmpty) return;
    widget.onSend(t);
    _ctrl.clear();
  }
}
