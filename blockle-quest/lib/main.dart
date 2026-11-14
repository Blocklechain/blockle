import 'dart:async';

import 'package:flame/game.dart';
import 'package:flutter/material.dart';

import 'account/account_service.dart';
import 'account/character.dart';
import 'account/deeplink_service.dart';
import 'economy/economy.dart';
import 'game/blocklings_game.dart';
import 'theme.dart';
import 'ui/dpad.dart';
import 'ui/panels.dart';
import 'ui/title_screen.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  DeepLinkService.instance.init(); // receive on-chain settlement callbacks
  runApp(const BlocklingsApp());
}

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
  BlocklingsGame? game;
  bool _loading = true;
  bool _hasProfile = false;

  @override
  void initState() {
    super.initState();
    _boot();
  }

  Future<void> _boot() async {
    // Restore a saved Blockle session, then prefer a character stored on the
    // account over the local one (so it follows the player across devices).
    await AccountService.instance.init();
    var p = await CharacterProfile.load();
    if (AccountService.instance.signedIn) {
      final remote = await AccountService.instance.getCharacter();
      if (remote != null) {
        try {
          p = CharacterProfile.fromJson(remote);
          await p.save();
        } catch (_) {/* keep the local profile */}
      }
    }
    if (!mounted) return;
    setState(() {
      _hasProfile = p != null;
      // Always create a game: a real profile if we have one, otherwise a
      // throwaway profile that only drives the title cinematic.
      game = BlocklingsGame(
        profile: p ?? CharacterProfile(name: 'Adventurer', starterElement: 0, multiplayer: false),
      );
      _loading = false;
    });
  }

  /// A brand-new character was created from the title screen: swap in a game
  /// bound to the real profile and drop into the world once it has loaded.
  void _onCreated(CharacterProfile p) {
    final g = BlocklingsGame(profile: p);
    setState(() {
      _hasProfile = true;
      game = g;
    });
    g.loaded.then((_) => g.enterWorld());
  }

  @override
  Widget build(BuildContext context) {
    final g = game;
    if (_loading || g == null) {
      return const Scaffold(backgroundColor: Bq.bg, body: Center(child: CircularProgressIndicator(color: Bq.accent)));
    }
    return Scaffold(
      body: GameWidget(
        game: g,
        overlayBuilderMap: {
          'title': (_, BlocklingsGame g) => TitleScreen(game: g, hasProfile: _hasProfile, onCreated: _onCreated),
          'hud': (_, BlocklingsGame g) => Hud(game: g),
          'inventory': (_, BlocklingsGame g) => InventoryPanel(game: g),
          'wallet': (_, BlocklingsGame g) => WalletPanel(game: g),
          'market': (_, BlocklingsGame g) => MarketPanel(game: g),
          'skills': (_, BlocklingsGame g) => SkillsPanel(game: g),
          'quests': (_, BlocklingsGame g) => QuestsPanel(game: g),
          'shop': (_, BlocklingsGame g) => ShopPanel(game: g),
          'interior': (_, BlocklingsGame g) => InteriorPanel(game: g),
          'zoneload': (_, BlocklingsGame g) => ZoneLoad(game: g),
          'roomfade': (_, BlocklingsGame g) => RoomFade(game: g),
        },
        initialActiveOverlays: const ['title'],
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
                if (g.nearbyBuilding != null) ...[
                  _round(Icons.door_front_door_outlined, Bq.accent, () => _open('interior')),
                  const SizedBox(height: 8),
                ],
                if (g.nearbyVendor != null) ...[
                  _round(Icons.shopping_cart_outlined, Bq.accent2, () => _open('shop')),
                  const SizedBox(height: 8),
                ],
                _round(Icons.bolt, g.autoCombat ? Bq.accent : Bq.panel2, () => setState(g.toggleAuto)),
                const SizedBox(height: 8),
                _round(Icons.backpack_outlined, Bq.panel2, () => _open('inventory')),
                const SizedBox(height: 8),
                _round(Icons.military_tech_outlined, Bq.panel2, () => _open('skills')),
                const SizedBox(height: 8),
                _round(Icons.menu_book_outlined, Bq.panel2, () => _open('quests')),
                const SizedBox(height: 8),
                _round(Icons.account_balance_wallet_outlined, Bq.panel2, () => _open('wallet')),
                const SizedBox(height: 8),
                _round(Icons.storefront_outlined, Bq.panel2, () => _open('market')),
              ],
            ),
          ),
          // Bottom-left: movement D-pad (turn AUTO off to walk manually).
          Positioned(
            left: 10,
            bottom: 20,
            child: DPad(onChanged: (v) => g.dpad.setFrom(v)),
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

  Widget _round(IconData icon, Color bg, VoidCallback onTap) => Material(
        color: bg,
        shape: const CircleBorder(),
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onTap,
          child: SizedBox(
            width: 52,
            height: 52,
            child: Center(child: Icon(icon, color: Bq.text, size: 24)),
          ),
        ),
      );

  static String _fmt(double v) =>
      v >= 100 ? v.toStringAsFixed(0) : (v >= 1 ? v.toStringAsFixed(2) : v.toStringAsFixed(4));
}
