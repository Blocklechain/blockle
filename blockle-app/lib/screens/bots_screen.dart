// bots_screen.dart — the native Blockle Bots surface for the Flutter wallet.
// Hosts the four surfaces from the shared visual contract (docs/design/bots):
// COCKPIT, CREATE, BOT DETAIL, and ARENA (PLAY), under a sticky top bar with a
// prominent Kill-all control and a light/dark toggle. Theme-aware via BotTokens
// ported 1:1 from the reference. Everything is driven by [BotsController], which
// is a thin adapter over the real engine (bots / bot_runner / arena / pnl /
// notify) — no mock data, no new money path.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/bots_controller.dart';
import 'bots/arena_view.dart';
import 'bots/bots_tokens.dart';
import 'bots/bots_widgets.dart';
import 'bots/cockpit_view.dart';
import 'bots/create_view.dart';
import 'bots/detail_view.dart';

class BotsScreen extends StatefulWidget {
  const BotsScreen({super.key});
  @override
  State<BotsScreen> createState() => _BotsScreenState();
}

class _BotsScreenState extends State<BotsScreen> {
  int _tab = 0; // 0 cockpit · 1 create · 2 detail · 3 arena
  BotFilter _filter = BotFilter.all;
  String? _selectedBotId;
  Brightness? _themeOverride;
  int _shownNotifs = 0;
  bool _didInit = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_didInit) {
      _didInit = true;
      // Kick off the controller's engine load exactly once.
      final c = context.read<BotsController>();
      if (!c.ready) c.init();
      _shownNotifs = c.notifications.length;
    }
  }

  void _openBot(String id) => setState(() {
        _selectedBotId = id;
        _tab = 2;
      });

  @override
  Widget build(BuildContext context) {
    final c = context.watch<BotsController>();
    final appBrightness = Theme.of(context).brightness;
    final brightness = _themeOverride ?? appBrightness;
    final t = BotTokens.of(brightness);

    // Surface any new realized-profit pop-up from the notify module (§8).
    if (c.notifications.length > _shownNotifs) {
      final n = c.notifications.first;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(n.subtitle == null ? n.title : '${n.title}\n${n.subtitle}'),
          backgroundColor: t.gain,
        ));
      });
      _shownNotifs = c.notifications.length;
    }

    return BotTheme(
      tokens: t,
      child: Container(
        color: t.ground,
        child: SafeArea(
          bottom: false,
          child: Column(
            children: [
              _TopBar(
                filter: _filter,
                onFilter: (f) => setState(() => _filter = f),
                onKillAll: () => _killAll(c),
                onToggleTheme: () => setState(() {
                  _themeOverride = brightness == Brightness.dark
                      ? Brightness.light
                      : Brightness.dark;
                }),
                onSync: () => _sync(c),
              ),
              _Tabs(
                tab: _tab,
                hasDetail: _selectedBotId != null,
                onTab: (i) => setState(() => _tab = i),
              ),
              Expanded(child: _body(c)),
            ],
          ),
        ),
      ),
    );
  }

  Widget _body(BotsController c) {
    if (!c.ready) {
      return const Center(child: CircularProgressIndicator());
    }
    switch (_tab) {
      case 1:
        return CreateView(
          controller: c,
          onCreated: (id, live) {
            setState(() {
              _filter = live ? BotFilter.live : BotFilter.paper;
              _tab = 0;
            });
            ScaffoldMessenger.of(context).showSnackBar(SnackBar(
                content: Text(live
                    ? 'Live bot armed within its allocation cap.'
                    : 'Paper bot started — forward-testing risk-free.')));
          },
        );
      case 2:
        if (_selectedBotId == null) {
          return _pickPrompt();
        }
        return DetailView(
          controller: c,
          botId: _selectedBotId!,
          onBack: () => setState(() => _tab = 0),
          onClonedTo: (id) => setState(() => _selectedBotId = id),
        );
      case 3:
        return ArenaView(
          controller: c,
          onDesign: () => setState(() => _tab = 1),
          onUseForReal: (id) => setState(() {
            _selectedBotId = id;
            _filter = BotFilter.paper;
            _tab = 0;
          }),
        );
      case 0:
      default:
        return CockpitView(
          controller: c,
          filter: _filter,
          onFilter: (f) => setState(() => _filter = f),
          onOpenBot: _openBot,
          onCreate: () => setState(() => _tab = 1),
        );
    }
  }

  Widget _pickPrompt() {
    final t = BotTheme.of(context);
    return Center(
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Icon(Icons.touch_app_outlined, color: t.inkMuted, size: 36),
        const SizedBox(height: 10),
        Text('Pick a bot in the Cockpit to see its detail.',
            style: TextStyle(color: t.inkMuted)),
        const SizedBox(height: 12),
        BotButton(label: 'Go to cockpit', onPressed: () => setState(() => _tab = 0)),
      ]),
    );
  }

  Future<void> _killAll(BotsController c) async {
    final t = BotTheme.of(context);
    final ok = await showDialog<bool>(
      context: context,
      builder: (dctx) => BotTheme(
        tokens: t,
        child: AlertDialog(
          backgroundColor: t.surface,
          title: Row(children: [
            Icon(Icons.power_settings_new, color: t.loss, size: 20),
            const SizedBox(width: 8),
            const Text('Kill all bots'),
          ]),
          content: Text(
            'Immediately stop EVERY bot, best-effort cancel their open orders, and '
            'lock the vault (wiping the decrypted keys + the LLM credential). A kill '
            'mid-tick blocks any in-flight order. Nothing spendable survives.',
            style: TextStyle(color: t.inkMuted, fontSize: 13, height: 1.5),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(dctx, false), child: const Text('Cancel')),
            FilledButton(
              style: FilledButton.styleFrom(backgroundColor: t.loss),
              onPressed: () => Navigator.pop(dctx, true),
              child: const Text('KILL ALL'),
            ),
          ],
        ),
      ),
    );
    if (ok == true) {
      await c.killAll('user kill-all');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('All bots killed · vault locked.')));
      }
    }
  }

  Future<void> _sync(BotsController c) async {
    final out = await c.tick();
    if (!mounted) return;
    final acted = out.where((e) => (e['events'] as List?)?.isNotEmpty == true).length;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(out.isEmpty
            ? 'No enabled bots to tick.'
            : 'Ticked ${out.length} bot(s)${acted == 0 ? ' · no market data, nothing filled' : ''}.')));
  }
}

class _TopBar extends StatelessWidget {
  const _TopBar({
    required this.filter,
    required this.onFilter,
    required this.onKillAll,
    required this.onToggleTheme,
    required this.onSync,
  });
  final BotFilter filter;
  final ValueChanged<BotFilter> onFilter;
  final VoidCallback onKillAll, onToggleTheme, onSync;
  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
      decoration: BoxDecoration(
        color: t.ground,
        border: Border(bottom: BorderSide(color: t.lineSoft)),
      ),
      child: Row(children: [
        Container(
          width: 30,
          height: 30,
          decoration: BoxDecoration(
            gradient: const LinearGradient(colors: [Color(0xFF4C8DFF), Color(0xFF6AA6FF)]),
            borderRadius: BorderRadius.circular(9),
          ),
          child: const Icon(Icons.hexagon_outlined, size: 17, color: Colors.white),
        ),
        const SizedBox(width: 11),
        Expanded(
          child: Row(children: [
            Flexible(
              child: Text('Blockle Bots',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: t.ink)),
            ),
            const SizedBox(width: 6),
            Text('DEX',
                style: TextStyle(fontSize: 11, letterSpacing: 1.2, fontWeight: FontWeight.w600, color: t.inkFaint)),
          ]),
        ),
        const SizedBox(width: 8),
        // The Paper/Live (+ All) trading-mode filter — matches the shared visual
        // contract (docs/design/bots/index.html), driving the cockpit grid.
        BotFilterSeg(filter: filter, onFilter: onFilter),
        const SizedBox(width: 10),
        _iconBtn(t, Icons.sync, 'Tick enabled bots', onSync),
        const SizedBox(width: 8),
        _iconBtn(t, t.isDark ? Icons.light_mode_outlined : Icons.dark_mode_outlined,
            'Toggle light / dark', onToggleTheme),
        const SizedBox(width: 10),
        // The prominent Kill-all control.
        Semantics(
          button: true,
          label: 'Kill all bots',
          child: InkWell(
            onTap: onKillAll,
            borderRadius: BorderRadius.circular(10),
            child: Container(
              constraints: const BoxConstraints(minHeight: 38),
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
              decoration: BoxDecoration(
                color: t.lossGhost,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: t.loss.withValues(alpha: 0.4)),
              ),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(Icons.power_settings_new, size: 15, color: t.loss),
                const SizedBox(width: 8),
                Text('Kill all',
                    style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: t.loss)),
              ]),
            ),
          ),
        ),
      ]),
    );
  }

  Widget _iconBtn(BotTokens t, IconData ic, String tip, VoidCallback onTap) => Tooltip(
        message: tip,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(10),
          child: Container(
            width: 38,
            height: 38,
            decoration: BoxDecoration(
              color: t.surface,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: t.line),
            ),
            child: Icon(ic, size: 18, color: t.inkMuted),
          ),
        ),
      );
}

class _Tabs extends StatelessWidget {
  const _Tabs({required this.tab, required this.hasDetail, required this.onTab});
  final int tab;
  final bool hasDetail;
  final ValueChanged<int> onTab;
  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    final labels = ['Cockpit', 'Create a bot', 'Bot detail', 'Arena'];
    return Container(
      decoration: BoxDecoration(border: Border(bottom: BorderSide(color: t.lineSoft))),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 10),
        child: Row(children: [
          for (var i = 0; i < labels.length; i++)
            _tabBtn(t, i, labels[i], i == 3),
        ]),
      ),
    );
  }

  Widget _tabBtn(BotTokens t, int i, String label, bool play) {
    final on = i == tab;
    return InkWell(
      onTap: () => onTab(i),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          border: Border(
            bottom: BorderSide(color: on ? t.accent : Colors.transparent, width: 2),
          ),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Text(label,
              style: TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                  color: on ? t.ink : t.inkMuted)),
          if (play) ...[
            const SizedBox(width: 6),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
              decoration: BoxDecoration(color: t.warn, borderRadius: BorderRadius.circular(20)),
              child: const Text('PLAY',
                  style: TextStyle(fontSize: 9, fontWeight: FontWeight.w800, color: Color(0xFF2A1A00))),
            ),
          ],
        ]),
      ),
    );
  }
}
