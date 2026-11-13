import 'dart:async';

import 'package:flame/game.dart';
import 'package:flutter/material.dart';

import 'economy/economy.dart';
import 'game/blocklings_game.dart';
import 'theme.dart';
import 'ui/panels.dart';

void main() => runApp(const BlocklingsApp());

class BlocklingsApp extends StatelessWidget {
  const BlocklingsApp({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'Blocklings',
        debugShowCheckedModeBanner: false,
        theme: Bq.theme(),
        home: const GameScreen(),
      );
}

class GameScreen extends StatefulWidget {
  const GameScreen({super.key});
  @override
  State<GameScreen> createState() => _GameScreenState();
}

class _GameScreenState extends State<GameScreen> {
  late final BlocklingsGame game = BlocklingsGame();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: GameWidget(
        game: game,
        overlayBuilderMap: {
          'hud': (_, BlocklingsGame g) => Hud(game: g),
          'inventory': (_, BlocklingsGame g) => InventoryPanel(game: g),
          'wallet': (_, BlocklingsGame g) => WalletPanel(game: g),
          'market': (_, BlocklingsGame g) => MarketPanel(game: g),
          'skills': (_, BlocklingsGame g) => SkillsPanel(game: g),
          'quests': (_, BlocklingsGame g) => QuestsPanel(game: g),
        },
        initialActiveOverlays: const ['hud'],
      ),
    );
  }
}

/// Always-on heads-up display: health/level, crypto balances, auto-combat toggle
/// and the panel buttons. Rebuilds on a light timer for the live stats.
class Hud extends StatefulWidget {
  final BlocklingsGame game;
  const Hud({super.key, required this.game});
  @override
  State<Hud> createState() => _HudState();
}

class _HudState extends State<Hud> {
  Timer? _t;

  @override
  void initState() {
    super.initState();
    _t = Timer.periodic(const Duration(milliseconds: 120), (_) => setState(() {}));
    widget.game.toast.addListener(_onToast);
  }

  void _onToast() {
    final msg = widget.game.toast.value;
    if (msg.isEmpty || !mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg),
      duration: const Duration(milliseconds: 1400),
      behavior: SnackBarBehavior.floating,
    ));
  }

  @override
  void dispose() {
    _t?.cancel();
    widget.game.toast.removeListener(_onToast);
    super.dispose();
  }

  void _open(String overlay) {
    widget.game.overlays.add(overlay);
    widget.game.pauseEngine();
  }

  @override
  Widget build(BuildContext context) {
    final g = widget.game;
    final p = g.player;
    final hpFrac = (p.hp / p.maxHp).clamp(0.0, 1.0);
    final xpFrac = (p.xp / p.xpToNext).clamp(0.0, 1.0);

    return SafeArea(
      child: Stack(
        children: [
          // Top-center: current zone.
          if (g.currentZoneName.isNotEmpty)
            Align(
              alignment: Alignment.topCenter,
              child: Container(
                margin: const EdgeInsets.only(top: 10),
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 5),
                decoration: BoxDecoration(
                  color: Bq.panel.withValues(alpha: 0.82),
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text(g.currentZoneName,
                    style: const TextStyle(color: Bq.text, fontSize: 12, fontWeight: FontWeight.w700)),
              ),
            ),
          // Top-left: vitals.
          Positioned(
            left: 12,
            top: 8,
            child: Container(
              width: 190,
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: Bq.panel.withValues(alpha: 0.82),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text('Lv ${p.level}',
                      style: const TextStyle(color: Bq.text, fontWeight: FontWeight.w700)),
                  const SizedBox(height: 6),
                  _bar(hpFrac, Bq.hpGood, '${p.hp.toInt()}/${p.maxHp} HP'),
                  const SizedBox(height: 4),
                  _bar(xpFrac, Bq.xp, 'XP'),
                ],
              ),
            ),
          ),
          // Top-right: crypto balances.
          Positioned(
            right: 12,
            top: 8,
            child: AnimatedBuilder(
              animation: EconomyService.instance,
              builder: (_, __) => Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  for (final c in EconomyService.kCurrencies) _coin(c),
                ],
              ),
            ),
          ),
          // Bottom-right: panel buttons + auto toggle (sits above the attack button).
          Positioned(
            right: 12,
            bottom: 120,
            child: Column(
              children: [
                _round('AUTO', g.autoCombat ? Bq.accent : Bq.panel2, () => setState(g.toggleAuto)),
                const SizedBox(height: 8),
                _round('BAG', Bq.panel2, () => _open('inventory')),
                const SizedBox(height: 8),
                _round('SKL', Bq.panel2, () => _open('skills')),
                const SizedBox(height: 8),
                _round('QST', Bq.panel2, () => _open('quests')),
                const SizedBox(height: 8),
                _round('\$', Bq.panel2, () => _open('wallet')),
                const SizedBox(height: 8),
                _round('MKT', Bq.panel2, () => _open('market')),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _bar(double frac, Color color, String label) => Stack(
        alignment: Alignment.centerLeft,
        children: [
          Container(
            height: 16,
            decoration: BoxDecoration(color: Bq.bg, borderRadius: BorderRadius.circular(8)),
          ),
          FractionallySizedBox(
            widthFactor: frac,
            child: Container(
              height: 16,
              decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(8)),
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(left: 8),
            child: Text(label, style: const TextStyle(color: Bq.text, fontSize: 10)),
          ),
        ],
      );

  Widget _coin(Chain c) => Container(
        margin: const EdgeInsets.only(bottom: 6),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: BoxDecoration(
          color: Bq.panel.withValues(alpha: 0.82),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Container(width: 9, height: 9, decoration: BoxDecoration(color: c.color, shape: BoxShape.circle)),
          const SizedBox(width: 6),
          Text('${_fmt(EconomyService.instance.balance(c))} ${c.symbol}',
              style: const TextStyle(color: Bq.text, fontSize: 12, fontWeight: FontWeight.w600)),
        ]),
      );

  Widget _round(String label, Color bg, VoidCallback onTap) => Material(
        color: bg,
        shape: const CircleBorder(),
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onTap,
          child: SizedBox(
            width: 52,
            height: 52,
            child: Center(
              child: Text(label,
                  style: const TextStyle(color: Bq.text, fontSize: 12, fontWeight: FontWeight.w800)),
            ),
          ),
        ),
      );

  static String _fmt(double v) =>
      v >= 100 ? v.toStringAsFixed(0) : (v >= 1 ? v.toStringAsFixed(2) : v.toStringAsFixed(4));
}
