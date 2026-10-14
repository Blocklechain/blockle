// arena_view.dart — ARENA / PLAY (§9): play balance, scenario picker, Run, an
// animated play-P&L + score + XP/level, a mission, badges, a local leaderboard,
// the persistent "simulation — not financial advice" disclaimer, and the one
// honest "use this for real" on-ramp (imports as paper + disabled).
//
// Everything is PURE sim driven by ArenaProfile.run — no keys, no vault, no gate,
// no broadcast. Play funds are labelled PLAY and can never become real.

import 'dart:async';

import 'package:flutter/material.dart';

import '../../agent/arena.dart' as a;
import '../../agent/bots.dart' as b;
import '../../state/bots_controller.dart';
import 'bots_tokens.dart';
import 'bots_widgets.dart';
import 'charts.dart';

const Map<int, String> _levelNames = {
  1: 'Rookie', 2: 'Apprentice', 3: 'Trader', 4: 'Tactician', 5: 'Strategist',
};

const Map<String, String> _scenEmoji = {
  'bull': '📈', 'crab': '🦀', 'bear': '📉', 'crash': '💥', 'pump': '🚀',
};
const Map<String, String> _scenName = {
  'bull': 'Bull', 'crab': 'Crab', 'bear': 'Bear', 'crash': 'Flash-crash', 'pump': 'Pump & fade',
};
const Map<String, String> _badgeEmoji = {
  'first_run': '🎓', 'green_run': '🔥', 'high_score': '🎯',
  'diamond_hands': '🛡️', 'all_scenarios': '🌍', 'veteran': '💎',
};

// The Arena strategy the sandbox runs (a Conservative DCA on SOL by default).
const Map<String, dynamic> _arenaConfig = {
  'baseOrderUsd': 200, 'safetyOrderUsd': 200, 'maxSafetyOrders': 3,
  'safetyStepPct': 2, 'safetyVolumeScale': 1.4, 'takeProfitPct': 2,
};

class ArenaView extends StatefulWidget {
  const ArenaView({super.key, required this.controller, required this.onDesign, required this.onUseForReal});
  final BotsController controller;
  final VoidCallback onDesign;
  final ValueChanged<String> onUseForReal;

  @override
  State<ArenaView> createState() => _ArenaViewState();
}

// The pair the Arena strategy trades (its base is what the live feed is sampled on).
const String _arenaPair = 'SOL/USDC';
const String _arenaBase = 'SOL';

class _ArenaViewState extends State<ArenaView> with SingleTickerProviderStateMixin {
  // Arena market mode: 'live' (play money on REAL marks) is the DEFAULT; 'demo' is
  // the fixed-fixture scenario replay (the cross-wallet parity contract).
  String _mode = 'live';

  String _scen = 'bull';
  List<double> _path = const [];
  List<Map<String, dynamic>> _fills = const [];
  a.ArenaResult? _result;
  late final AnimationController _anim;
  int _upto = 0;
  String _state = 'Ready';

  // LIVE MARKET state — accumulated REAL marks (null = no data that tick, skipped),
  // the running PLAY result, and the 5s poll timer. Never broadcasts, never real.
  final List<num?> _liveMarks = [];
  a.ArenaResult? _liveResult;
  Timer? _livePoll;

  @override
  void initState() {
    super.initState();
    _anim = AnimationController(vsync: this, duration: const Duration(milliseconds: 1500))
      ..addListener(() {
        if (_path.isEmpty) return;
        setState(() => _upto = (_anim.value * (_path.length - 1)).round());
      })
      ..addStatusListener((s) {
        if (s == AnimationStatus.completed) setState(() => _state = 'Done');
      });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_mode == 'demo') {
        _load();
      } else {
        _startLivePoll();
      }
    });
  }

  void _load() {
    setState(() {
      _path = widget.controller.scenarioPath(_scen);
      _fills = const [];
      _result = null;
      _upto = _path.isEmpty ? 0 : _path.length - 1;
      _state = 'Ready';
    });
  }

  void _setMode(String m) {
    if (m == _mode) return;
    _anim.stop();
    _stopLivePoll();
    setState(() => _mode = m);
    if (m == 'demo') {
      _load();
    } else {
      _startLivePoll();
    }
  }

  // --- LIVE MARKET (play money on REAL marks) -------------------------------
  void _startLivePoll() {
    _stopLivePoll();
    _liveTick();
    _livePoll = Timer.periodic(const Duration(seconds: 5), (_) => _liveTick());
  }

  void _stopLivePoll() {
    _livePoll?.cancel();
    _livePoll = null;
  }

  void _resetLive() {
    setState(() {
      _liveMarks.clear();
      _liveResult = null;
    });
  }

  // Sample the CURRENT real mark for the arena pair base from the SAME live feed
  // the real bots + scanner use, append it (or null when NO data — never a
  // fabricated price), re-run the PURE play-money engine, and redraw.
  Future<void> _liveTick() async {
    if (!mounted || _mode == 'demo') return;
    num? mark;
    try {
      mark = await widget.controller.liveMark(_arenaBase);
    } catch (_) {
      mark = null;
    }
    if (!mounted || _mode == 'demo') return;
    _liveMarks.add(mark); // null => awaiting data this tick (never fabricated)
    if (_liveMarks.length > 600) _liveMarks.removeAt(0);
    a.ArenaResult? res;
    try {
      res = widget.controller.runArenaLive(
        type: 'dca',
        config: Map<String, dynamic>.from(_arenaConfig),
        pair: _arenaPair,
        marks: _liveMarks,
        name: 'Arena DCA',
      );
    } catch (_) {
      res = null;
    }
    setState(() => _liveResult = res);
  }

  List<double> get _liveSeries => [
        for (final m in _liveMarks)
          if (m != null && m.isFinite && m > 0) m.toDouble()
      ];

  @override
  void dispose() {
    _stopLivePoll();
    _anim.dispose();
    super.dispose();
  }

  void _run() {
    final summary = widget.controller.runArena(
      type: 'dca',
      config: Map<String, dynamic>.from(_arenaConfig),
      pair: 'SOL/USDC',
      scenario: _scen,
      name: 'Arena DCA',
    );
    final res = summary['result'] as a.ArenaResult;
    _result = res;
    _path = widget.controller.scenarioPath(_scen);
    _fills = [
      for (final f in res.fills)
        {
          't': f['t'] as int,
          'side': f['side'],
          'priceUsd': (b.ucToUsd(BigInt.parse('${f['priceUc']}')) ?? 0),
        }
    ];
    final reduceMotion = MediaQuery.of(context).disableAnimations;
    setState(() => _state = 'Running…');
    if (reduceMotion || _path.length < 2) {
      setState(() {
        _upto = _path.length - 1;
        _state = 'Done';
      });
    } else {
      _anim.forward(from: 0);
    }
  }

  double _pnlAt(int i) {
    final r = _result;
    if (r == null || r.equityCurveUc.isEmpty) return 0;
    final idx = i.clamp(0, r.equityCurveUc.length - 1);
    return b.ucToUsd(r.equityCurveUc[idx]) ?? 0;
  }

  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    final prof = widget.controller.arena;
    final lvl = prof.level();
    final playBal = b.ucToUsd(prof.playBalance.balanceUc) ?? 0;

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 18, 16, 36),
      children: [
        _topRow(t, lvl, playBal),
        const SizedBox(height: 18),
        LayoutBuilder(builder: (ctx, c) {
          final sim = _simCard(t);
          final side = _sideCard(t, lvl);
          if (c.maxWidth > 820) {
            return Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Expanded(flex: 3, child: sim),
              const SizedBox(width: 16),
              Expanded(flex: 2, child: side),
            ]);
          }
          return Column(children: [sim, const SizedBox(height: 16), side]);
        }),
      ],
    );
  }

  Widget _topRow(BotTokens t, a.LevelInfo lvl, double playBal) {
    final name = _levelNames[lvl.level] ?? 'Trader';
    final nextMin = lvl.xp + lvl.xpToNext;
    final frac = lvl.nextLevel != null && nextMin > 0 ? (lvl.xp / nextMin) : 1.0;
    return Wrap(
      spacing: 16,
      runSpacing: 12,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: [t.accentGhost, t.surface],
            ),
            borderRadius: BorderRadius.circular(BotTokens.radius),
            border: Border.all(color: t.accentDim),
          ),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            const Text('🪙', style: TextStyle(fontSize: 28)),
            const SizedBox(width: 12),
            Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('PLAY BALANCE',
                  style: TextStyle(fontSize: 11, letterSpacing: 1.2, fontWeight: FontWeight.w700, color: t.warn)),
              Text(moneyUsd(playBal, sign: false),
                  style: mono(t, size: 24, color: t.ink, w: FontWeight.w700)),
            ]),
          ]),
        ),
        SizedBox(
          width: 220,
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Text('Lv ${lvl.level} · $name',
                  style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: t.accent)),
              const Spacer(),
              Text(
                  lvl.nextLevel != null ? '${lvl.xp} / $nextMin XP' : '${lvl.xp} XP',
                  style: mono(t, size: 11, color: t.inkMuted)),
            ]),
            const SizedBox(height: 6),
            AllocBar(fraction: frac),
            const SizedBox(height: 6),
            Text(
                lvl.nextLevel != null
                    ? 'Next unlock at Lv ${lvl.nextLevel}'
                    : 'All parameters unlocked',
                style: TextStyle(fontSize: 11, color: t.inkFaint)),
          ]),
        ),
      ],
    );
  }

  Widget _modeToggle(BotTokens t) {
    Widget seg(String mode, Widget label) {
      final on = _mode == mode;
      return Expanded(
        child: Semantics(
          button: true,
          selected: on,
          child: InkWell(
            onTap: () => _setMode(mode),
            borderRadius: BorderRadius.circular(8),
            child: Container(
              padding: const EdgeInsets.symmetric(vertical: 9),
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: on ? t.accentGhost : Colors.transparent,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: on ? t.accent : Colors.transparent),
              ),
              child: DefaultTextStyle(
                style: TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                    color: on ? t.ink : t.inkMuted),
                child: label,
              ),
            ),
          ),
        ),
      );
    }

    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: t.elevated,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: t.line),
      ),
      child: Row(children: [
        seg(
          'live',
          Row(mainAxisSize: MainAxisSize.min, children: [
            const Text('Live market'),
            const SizedBox(width: 6),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
              decoration: BoxDecoration(
                color: t.warn.withValues(alpha: 0.18),
                borderRadius: BorderRadius.circular(5),
              ),
              child: Text('PLAY',
                  style: TextStyle(
                      fontSize: 9, letterSpacing: 0.8, fontWeight: FontWeight.w800, color: t.warn)),
            ),
          ]),
        ),
        seg('demo', const Text('Demo scenario')),
      ]),
    );
  }

  Widget _simCard(BotTokens t) {
    return _mode == 'demo' ? _demoCard(t) : _liveCard(t);
  }

  Widget _liveCard(BotTokens t) {
    final r = _liveResult;
    final series = _liveSeries;
    final hasData = r != null && !r.awaitingData && series.isNotEmpty;
    final pnl = (hasData && r.equityCurveUc.isNotEmpty)
        ? (b.ucToUsd(r.equityCurveUc.last) ?? 0)
        : 0.0;
    final stateChip = hasData
        ? 'Live · ${_signed(r.score)}'
        : 'Awaiting data…';
    return BotCard(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Eyebrow('Live market · play money on REAL marks'),
              const SizedBox(height: 4),
              Text('Conservative DCA · SOL',
                  style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: t.ink)),
            ]),
            const Spacer(),
            BotChip(stateChip, accent: hasData),
          ]),
          const SizedBox(height: 12),
          _modeToggle(t),
          const SizedBox(height: 10),
          Text(
              'Ticks your strategy on the SAME live marks the real bots use — play '
              'balances only. It never broadcasts and never touches real funds. A '
              'market with no data is skipped (awaiting data); prices are never invented.',
              style: TextStyle(fontSize: 11.5, color: t.inkMuted, height: 1.45)),
          const SizedBox(height: 12),
          if (series.length >= 2)
            SimChart(path: series, fills: const [], upto: series.length - 1)
          else
            SizedBox(
              height: 280,
              child: Center(
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  SizedBox(
                      width: 22,
                      height: 22,
                      child: CircularProgressIndicator(strokeWidth: 2, color: t.accent)),
                  const SizedBox(height: 12),
                  Text('Awaiting live market data…',
                      style: TextStyle(color: t.inkFaint, fontSize: 12.5)),
                ]),
              ),
            ),
          const SizedBox(height: 12),
          Divider(height: 1, color: t.lineSoft),
          const SizedBox(height: 12),
          Wrap(
            spacing: 16,
            runSpacing: 12,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              BotButton(label: 'Reset play run', icon: Icons.refresh, onPressed: _resetLive),
              _score(t, 'Play P&L', hasData ? moneyUsd(pnl) : '—',
                  hasData ? t.pnlColor(pnl) : t.inkMuted),
              _score(t, 'Score', hasData ? _signed(r.score) : '—',
                  hasData ? t.pnlColor(r.score) : t.inkMuted),
              _score(t, 'Max drawdown',
                  hasData ? '−${(r.ddTenthPct.toDouble() / 10).toStringAsFixed(1)}%' : '—',
                  t.inkMuted),
            ],
          ),
          const SizedBox(height: 14),
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Icon(Icons.info_outline, size: 14, color: t.inkFaint),
            const SizedBox(width: 8),
            Expanded(
              child: Text(widget.controller.arenaDisclaimer,
                  style: TextStyle(fontSize: 11.5, color: t.inkFaint, height: 1.4)),
            ),
          ]),
        ],
      ),
    );
  }

  Widget _demoCard(BotTokens t) {
    final pnl = _pnlAt(_upto);
    final r = _result;
    return BotCard(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Eyebrow('Demo scenario · fixed fixture, seeded & replayable'),
              const SizedBox(height: 4),
              Text('Conservative DCA · SOL',
                  style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: t.ink)),
            ]),
            const Spacer(),
            BotChip(_state, accent: _state == 'Running…'),
          ]),
          const SizedBox(height: 12),
          _modeToggle(t),
          const SizedBox(height: 10),
          Wrap(spacing: 7, runSpacing: 7, children: [
            for (final s in widget.controller.arenaScenarios) _scenButton(t, s),
          ]),
          const SizedBox(height: 12),
          if (_path.length >= 2)
            SimChart(path: _path, fills: _fills, upto: _upto)
          else
            SizedBox(height: 280, child: Center(child: Text('Loading scenario…', style: TextStyle(color: t.inkFaint)))),
          const SizedBox(height: 12),
          Divider(height: 1, color: t.lineSoft),
          const SizedBox(height: 12),
          Wrap(
            spacing: 16,
            runSpacing: 12,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              BotButton(label: 'Run simulation', icon: Icons.play_arrow_rounded, primary: true, onPressed: _run),
              _score(t, 'Play P&L', moneyUsd(pnl), t.pnlColor(pnl)),
              _score(t, 'Score', r == null ? '—' : _signed(r.score), r == null ? t.inkMuted : t.pnlColor(r.score)),
              _score(t, 'Max drawdown', r == null ? '—' : '−${(r.ddTenthPct.toDouble() / 10).toStringAsFixed(1)}%', t.inkMuted),
            ],
          ),
          const SizedBox(height: 14),
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Icon(Icons.info_outline, size: 14, color: t.inkFaint),
            const SizedBox(width: 8),
            Expanded(
              child: Text(widget.controller.arenaDisclaimer,
                  style: TextStyle(fontSize: 11.5, color: t.inkFaint, height: 1.4)),
            ),
          ]),
          if (!widget.controller.hasCanonicalVectors)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text('Using the live generator (canonical fixture not bundled) — scores are not leaderboard-comparable.',
                  style: TextStyle(fontSize: 11, color: t.warn)),
            ),
        ],
      ),
    );
  }

  String _signed(num v) => (v >= 0 ? '+' : '') + v.toStringAsFixed(1);

  Widget _score(BotTokens t, String label, String value, Color c) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Eyebrow(label),
          const SizedBox(height: 3),
          Text(value, style: mono(t, size: 20, color: c, w: FontWeight.w600)),
        ],
      );

  Widget _scenButton(BotTokens t, String s) {
    final on = _scen == s;
    return Semantics(
      button: true,
      selected: on,
      label: '${_scenName[s]} scenario',
      child: InkWell(
        onTap: () {
          _anim.stop();
          setState(() => _scen = s);
          _load();
        },
        borderRadius: BorderRadius.circular(20),
        child: Container(
          constraints: const BoxConstraints(minHeight: 36),
          padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 7),
          decoration: BoxDecoration(
            color: on ? t.accentGhost : t.elevated,
            borderRadius: BorderRadius.circular(20),
            border: Border.all(color: on ? t.accent : t.line),
          ),
          child: Text('${_scenEmoji[s]} ${_scenName[s]}',
              style: TextStyle(
                  fontSize: 12.5, fontWeight: FontWeight.w600, color: on ? t.ink : t.inkMuted)),
        ),
      ),
    );
  }

  Widget _sideCard(BotTokens t, a.LevelInfo lvl) {
    final prof = widget.controller.arena;
    final mission = a.kMissions.firstWhere(
      (m) => m.scenario == _scen,
      orElse: () => a.kMissions.last,
    );
    final missionDone = prof.missionsCompleted.contains(mission.id);
    final board = prof.leaderboard.top(_scen, 5);

    return BotCard(
      padding: const EdgeInsets.all(18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            Text('🎯 Mission',
                style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: t.ink)),
            const Spacer(),
            BotChip('+${mission.rewardXp} XP', accent: missionDone),
          ]),
          const SizedBox(height: 7),
          Text(mission.desc, style: TextStyle(fontSize: 13, color: t.inkMuted, height: 1.5)),
          const SizedBox(height: 4),
          if (missionDone)
            Text('✓ completed', style: TextStyle(fontSize: 12, color: t.gain, fontWeight: FontWeight.w600)),
          const SizedBox(height: 12),
          BotButton(label: 'Design your strategy →', expand: true, onPressed: widget.onDesign),
          const SizedBox(height: 20),
          const Eyebrow('Badges'),
          const SizedBox(height: 10),
          Wrap(spacing: 9, runSpacing: 9, children: [
            for (final badge in a.kBadges)
              _badge(t, badge, prof.badges.contains(badge.id)),
          ]),
          const SizedBox(height: 20),
          Row(children: [
            Eyebrow('Leaderboard · ${_scenName[_scen]}'),
            const Spacer(),
            Text('local', style: TextStyle(fontSize: 11, color: t.inkFaint)),
          ]),
          const SizedBox(height: 8),
          if (board.isEmpty)
            Text('No runs yet — run this scenario to set a personal best.',
                style: TextStyle(fontSize: 12.5, color: t.inkFaint))
          else
            for (var i = 0; i < board.length; i++) _lbRow(t, i + 1, board[i]),
          const SizedBox(height: 8),
          Text('Global leaderboard & shareable runs — coming later.',
              style: TextStyle(fontSize: 11, color: t.inkFaint)),
          const SizedBox(height: 16),
          BotButton(
            label: 'Use this strategy for real (starts in paper)',
            icon: Icons.check,
            primary: true,
            expand: true,
            onPressed: () {
              final bot = widget.controller.useForReal(
                type: 'dca',
                config: Map<String, dynamic>.from(_arenaConfig),
                pair: 'SOL/USDC',
                name: 'Arena DCA',
              );
              ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
                  content: Text('Imported as a paper + disabled bot — review and arm it when ready.')));
              widget.onUseForReal(bot.id);
            },
          ),
        ],
      ),
    );
  }

  Widget _badge(BotTokens t, a.Badge badge, bool earned) {
    final emoji = _badgeEmoji[badge.id] ?? '🏅';
    return Tooltip(
      message: earned ? '${badge.name}: ${badge.desc}' : 'Locked — ${badge.desc}',
      child: Opacity(
        opacity: earned ? 1 : 0.32,
        child: Container(
          width: 44,
          height: 44,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: t.elevated,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: t.line),
          ),
          child: Text(emoji, style: const TextStyle(fontSize: 20)),
        ),
      ),
    );
  }

  Widget _lbRow(BotTokens t, int rank, Map<String, dynamic> e) {
    final tenths = int.tryParse('${e['scoreTenths']}') ?? 0;
    final score = tenths / 10;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(children: [
        SizedBox(
          width: 22,
          child: Text('$rank', style: mono(t, size: 13, color: t.inkFaint, w: FontWeight.w700)),
        ),
        Expanded(
          child: Text('${e['name'] ?? 'you'}',
              style: TextStyle(fontSize: 13, color: t.ink)),
        ),
        Text(_signed(score), style: mono(t, size: 13, color: t.pnlColor(score), w: FontWeight.w600)),
      ]),
    );
  }
}
