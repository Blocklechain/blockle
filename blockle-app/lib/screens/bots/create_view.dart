// create_view.dart — CREATE (§5a): two tiers on one screen. SIMPLE = template
// gallery -> pair -> ONE amount -> plain-language preview -> Start in paper
// (primary) / Go live (secondary). ADVANCED drawer (collapsed) = base order,
// safety orders, step, volume scale, take-profit, trailing — driving a LIVE
// deal-ladder preview computed with the real engine math (charts.DealPreview).
//
// Going live opens the REVIEW SHEET (the one deliberate moment): it restates the
// allocation cap, that orders run auto within it with no further taps, the kill
// switch, and the mainnet requirement, then a single confirm -> BotRunner.armLive.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../agent/bots.dart' as b;
import '../../state/bots_controller.dart';
import 'bots_tokens.dart';
import 'bots_widgets.dart';
import 'charts.dart';

class _Tpl {
  final String key, name, blurb, type;
  final IconData icon;
  final double base, tp, step, vol, tr;
  final int so;
  const _Tpl(this.key, this.name, this.blurb, this.type, this.icon,
      {this.base = 20, this.tp = 2, this.so = 3, this.step = 2, this.vol = 1, this.tr = 0});
}

const List<_Tpl> _templates = [
  _Tpl('conservative_dca', 'Conservative DCA', 'Small base, 3 safety orders, +2% take-profit.',
      'dca', Icons.shield_outlined, base: 20, tp: 2, so: 3, step: 2, vol: 1.0, tr: 0),
  _Tpl('aggressive_dca', 'Aggressive DCA', 'Bigger base, martingale safety ladder, +3% TP.',
      'dca', Icons.bolt_outlined, base: 25, tp: 3, so: 4, step: 3, vol: 1.5, tr: 1),
  _Tpl('wide_grid', 'Wide Grid', 'A ladder of limit orders across a broad range.',
      'grid', Icons.grid_view_outlined),
  _Tpl('block_accumulator', 'BLOCK Accumulator', 'Stack BLOCK on dips, trailing take-profit.',
      'dca', Icons.layers_outlined, base: 15, tp: 5, so: 5, step: 4, vol: 1.2, tr: 2),
];

// Reference preview prices (projection only — no oracle is wired; the ladder is
// the exact engine math at this reference, clearly labelled, not a live quote).
const Map<String, double> _refPrice = {
  'SOL': 142.8, 'ETH': 3200, 'BTC': 64000, 'BLOCK': 1.0, 'ARB': 0.9,
  'JUP': 0.8, 'USDC': 1, 'USDT': 1,
};

class CreateView extends StatefulWidget {
  const CreateView({
    super.key,
    required this.controller,
    required this.onCreated,
    this.seed,
  });
  final BotsController controller;
  final void Function(String botId, bool live) onCreated;

  /// Optional seed from the Arena "use this for real" on-ramp.
  final Map<String, dynamic>? seed;

  @override
  State<CreateView> createState() => _CreateViewState();
}

// Profit-currency choices (settlement/quote assets). USDC is the default.
const List<String> _profitCurrencies = ['USDC', 'USDT', 'DAI', 'USD'];

// LANE choices — a bot trades ONE lane (chain + base asset), never cross-chain.
// null = unconstrained (legacy; the autopilot may wander any discoverable chain).
const List<MapEntry<String?, String>> _laneChoices = [
  MapEntry(null, 'Any lane'),
  MapEntry('solana', 'Solana · SOL'),
  MapEntry('ethereum', 'Ethereum · ETH'),
  MapEntry('bsc', 'BSC · BNB'),
  MapEntry('block', 'BLOCK'),
];

// PROFIT-HANDLING choices — what happens to realized profit. 'take' (default)
// skims profit to the profit currency and keeps the deploy cap at the fixed
// budget; 'compound' reinvests realized profit so gains raise the cap. Losses
// only ever draw down this bot's budget — never the wallet (the budget is a floor).
const List<MapEntry<String, String>> _profitModeChoices = [
  MapEntry('take', 'Take (skim profit)'),
  MapEntry('compound', 'Compound (reinvest)'),
];

// RISK-MODE choices — tune discovery/scanner strictness. null = engine default
// (medium). `high`/`sniper` loosen the gates and carry a warning.
const List<MapEntry<String?, String>> _riskChoices = [
  MapEntry(null, 'Default'),
  MapEntry('safe', 'Safe'),
  MapEntry('medium', 'Medium'),
  MapEntry('high', 'High'),
  MapEntry('sniper', 'Sniper'),
];

class _CreateViewState extends State<CreateView> {
  int _tpl = 0;
  final _pair = TextEditingController(text: 'SOL / USDC');
  final _alloc = TextEditingController(text: '500');
  bool _advanced = false;
  double _base = 20, _tp = 2, _step = 2, _vol = 1.0, _tr = 0;
  int _so = 3;

  // PAIR SELECTION MODE — defaults to 'ai' ("Let the AI choose pairs": the
  // scanner/autopilot scans + picks worthy pairs). 'manual' ("I'll pick a pair")
  // is opt-in and brings back the manual pair picker.
  String _pairMode = 'ai';

  // PROFIT CURRENCY — the settlement/quote asset realized profit settles INTO (AI
  // mode: user-chosen; manual mode: derived from the pair quote).
  String _profitCurrency = 'USDC';

  // LANE + RISK MODE — both optional (null = legacy/unconstrained). A lane pins
  // the bot to one chain; the risk mode tunes discovery/scanner strictness.
  String? _lane;
  String? _riskMode;

  // PROFIT HANDLING — Take (skim, default) | Compound (reinvest realized profit).
  // Defaults to 'take'. Passed into the bot spec; 'compound' lifts the deploy cap
  // by realized profit (losses only draw down this bot's budget, never the wallet).
  String _profitMode = 'take';

  bool get _aiPicksPairs => _pairMode != 'manual';

  @override
  void initState() {
    super.initState();
    _applyTpl(_templates[0]);
    // A seed from the Arena on-ramp is a concrete strategy on a pair -> manual.
    if (widget.seed != null) _pairMode = 'manual';
    _profitCurrency = _quoteOf(_normPair());
  }

  /// Profit currency derived from a BASE/QUOTE pair's quote (manual mode).
  String _quoteOf(String pair) {
    final parts = pair.toUpperCase().split('/');
    if (parts.length == 2 && parts[1].trim().isNotEmpty) return parts[1].trim();
    return _profitCurrency;
  }

  void _applyTpl(_Tpl t) {
    _base = t.base;
    _tp = t.tp;
    _so = t.so;
    _step = t.step;
    _vol = t.vol;
    _tr = t.tr;
  }

  @override
  void dispose() {
    _pair.dispose();
    _alloc.dispose();
    super.dispose();
  }

  String get _baseSym {
    final p = _pair.text.toUpperCase().split('/');
    return p.isNotEmpty ? p.first.trim() : 'SOL';
  }

  double get _price => _refPrice[_baseSym] ?? 100;
  bool get _isDca => _templates[_tpl].type == 'dca';

  DealPreview get _preview => DealPreview.fromDca(
        baseOrderUsd: _base,
        safetyOrders: _so,
        stepPct: _step,
        volumeScale: _vol,
        takeProfitPct: _tp,
        priceUsd: _price,
      );

  Map<String, dynamic> _dcaOverride() => {
        'baseOrderUsd': _base,
        'safetyOrderUsd': _base,
        'maxSafetyOrders': _so,
        'safetyStepPct': _step,
        'safetyVolumeScale': _vol,
        'takeProfitPct': _tp,
        'trailingTpPct': _tr,
      };

  String _normPair() {
    final parts = _pair.text.toUpperCase().split('/');
    if (parts.length == 2 && parts[0].trim().isNotEmpty && parts[1].trim().isNotEmpty) {
      return '${parts[0].trim()}/${parts[1].trim()}';
    }
    return 'SOL/USDC';
  }

  double get _allocUsd => double.tryParse(_alloc.text.trim()) ?? 0;

  /// Build a paper + disabled bot from the create-flow state. AI mode ("Let the AI
  /// choose pairs") -> the scan-&-trade autopilot, realizing profit INTO the chosen
  /// profit currency (no pair). Manual mode -> the selected template on the pair.
  b.Bot _createBot(num alloc) {
    if (_aiPicksPairs) {
      return widget.controller.createFromTemplate(
        'scan_and_trade',
        allocationUsd: alloc,
        configOverride: {'profitCurrency': _profitCurrency},
        lane: _lane,
        riskMode: _riskMode,
        profitMode: _profitMode,
      );
    }
    final tpl = _templates[_tpl];
    return widget.controller.createFromTemplate(
      tpl.key,
      pair: _normPair(),
      allocationUsd: alloc,
      configOverride: tpl.type == 'dca' ? _dcaOverride() : null,
      lane: _lane,
      riskMode: _riskMode,
      profitMode: _profitMode,
    );
  }

  Future<void> _startPaper() async {
    final bot = _createBot(_allocUsd);
    // Pass the amount as the paper BUDGET so the sandbox is the same size as a
    // live run would be (depletes as it spends). Omitted/0 -> unbounded paper.
    await widget.controller.enablePaper(bot.id, allocationUsd: _allocUsd);
    widget.onCreated(bot.id, false);
  }

  Future<void> _goLive() async {
    final alloc = _allocUsd;
    if (alloc <= 0) {
      _snack('Set an allocation above \$0 — a live bot needs a hard cap.');
      return;
    }
    if (!widget.controller.canGoLive) {
      _snack('Connect a value-moving agent channel (Agent tab) to arm a live bot.');
      return;
    }
    final confirmed = await _showReviewSheet(alloc);
    if (confirmed != true) return;
    final bot = _createBot(alloc);
    try {
      await widget.controller.armLive(bot.id, allocationUsd: alloc);
      widget.onCreated(bot.id, true);
    } catch (e) {
      _snack(e.toString().replaceFirst('StateError: ', '').replaceFirst('Exception: ', ''));
    }
  }

  Future<bool?> _showReviewSheet(double alloc) {
    final t = BotTheme.of(context);
    return showModalBottomSheet<bool>(
      context: context,
      backgroundColor: t.surface,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (_) => BotTheme(
        tokens: t,
        child: _ReviewSheet(
          alloc: alloc,
          pair: _aiPicksPairs ? 'AI-chosen pairs → $_profitCurrency' : _normPair(),
          channel: widget.controller.backingChannelLabel,
        ),
      ),
    );
  }

  void _snack(String m) {
    if (mounted) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(m)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    final left = _leftPane(t);
    final right = _ladderPane(t);
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 18, 16, 36),
      children: [
        LayoutBuilder(builder: (ctx, c) {
          if (c.maxWidth > 760) {
            return Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(child: left),
                const SizedBox(width: 16),
                Expanded(child: right),
              ],
            );
          }
          return Column(children: [left, const SizedBox(height: 16), right]);
        }),
      ],
    );
  }

  Widget _leftPane(BotTokens t) {
    return BotCard(
      padding: const EdgeInsets.fromLTRB(20, 20, 20, 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Create a bot',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: t.ink)),
          const SizedBox(height: 3),
          Text('Pick a starting point, choose a pair, set one amount. Tune the rest under Advanced.',
              style: TextStyle(fontSize: 12.5, color: t.inkMuted)),
          const SizedBox(height: 16),
          // STEP 1 — the strategy-template picker. In the default AI-chooses-pairs
          // mode the autopilot FORCES scan_and_trade and IGNORES the template, so
          // the picker has no effect and is hidden (switching to "I'll pick a pair"
          // brings it back). Never show a control that does nothing.
          if (!_aiPicksPairs) ...[
            const Eyebrow('1 · Template'),
            const SizedBox(height: 9),
            GridView.count(
              crossAxisCount: 2,
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              crossAxisSpacing: 10,
              mainAxisSpacing: 10,
              childAspectRatio: 2.4,
              children: [
                for (var i = 0; i < _templates.length; i++)
                  _TplCard(
                    tpl: _templates[i],
                    selected: i == _tpl,
                    onTap: () => setState(() {
                      _tpl = i;
                      _applyTpl(_templates[i]);
                    }),
                  ),
              ],
            ),
            const SizedBox(height: 16),
          ],
          _pairSelect(t),
          const SizedBox(height: 14),
          _Field(
            label: '3 · Amount to allocate',
            hint: "the bot's hard cap",
            child: TextField(
              controller: _alloc,
              onChanged: (_) => setState(() {}),
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))],
              style: mono(t, size: 16),
              decoration: _inputDec(t, prefix: '\$', suffix: _aiPicksPairs ? _profitCurrency : 'USDC'),
            ),
          ),
          const SizedBox(height: 16),
          _laneRiskSelect(t),
          const SizedBox(height: 16),
          _profitSelect(t),
          const SizedBox(height: 16),
          if (_aiPicksPairs)
            _AutopilotNote(profitCurrency: _profitCurrency, alloc: _allocUsd)
          else ...[
            _Preview(
              isDca: _isDca,
              base: _base,
              so: _so,
              step: _step,
              tp: _tp,
              tr: _tr,
              baseSym: _baseSym,
              alloc: _allocUsd,
            ),
            if (_isDca) ...[
              const SizedBox(height: 8),
              _AdvancedToggle(
                expanded: _advanced,
                onTap: () => setState(() => _advanced = !_advanced),
              ),
              if (_advanced) _advancedDrawer(t),
            ],
          ],
          const SizedBox(height: 18),
          Row(children: [
            Expanded(
              child: BotButton(
                label: 'Start in paper',
                icon: Icons.play_arrow_rounded,
                primary: true,
                expand: true,
                onPressed: _startPaper,
              ),
            ),
            const SizedBox(width: 10),
            BotButton(label: 'Go live…', icon: Icons.bolt, onPressed: _goLive),
          ]),
        ],
      ),
    );
  }

  // STEP 2 — the pair-selection mode toggle plus EITHER the profit-currency
  // selector (AI chooses pairs; the manual pair picker is HIDDEN) OR the manual
  // pair picker ("I'll pick a pair"). Defaults to AI.
  Widget _pairSelect(BotTokens t) {
    final modeToggle = Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: t.elevated,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: t.line),
      ),
      child: Row(children: [
        _modeSeg(t, 'ai', '🤖 Let the AI choose pairs'),
        _modeSeg(t, 'manual', "✎ I'll pick a pair"),
      ]),
    );

    if (_aiPicksPairs) {
      // AI chooses pairs: NO manual pair picker — a profit-currency selector instead.
      return _Field(
        label: '2 · Pairs',
        hint: 'the autopilot scans & picks worthy pairs',
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          modeToggle,
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: Text(
                'The AI scanner scores every discoverable pair and auto-trades the '
                'worthy ones within your cap — no pair to pick. Paper + disabled by default.',
                style: TextStyle(fontSize: 11.5, color: t.inkMuted, height: 1.45)),
          ),
          Text('Profit currency — what profit is realized & settled into',
              style: TextStyle(fontSize: 12, color: t.inkMuted)),
          const SizedBox(height: 7),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 13),
            decoration: BoxDecoration(
              color: t.elevated,
              borderRadius: BorderRadius.circular(BotTokens.radiusSm),
              border: Border.all(color: t.line),
            ),
            child: Row(children: [
              Expanded(
                child: DropdownButtonHideUnderline(
                  child: DropdownButton<String>(
                    value: _profitCurrency,
                    isExpanded: true,
                    dropdownColor: t.surface,
                    style: mono(t, size: 15, color: t.ink),
                    items: [
                      for (final c in _profitCurrencies)
                        DropdownMenuItem(value: c, child: Text(c)),
                    ],
                    onChanged: (v) => setState(() => _profitCurrency = (v ?? 'USDC').toUpperCase()),
                  ),
                ),
              ),
              Text('settles P&L', style: TextStyle(fontSize: 12, color: t.inkMuted)),
            ]),
          ),
        ]),
      );
    }

    // Manual: the pair picker returns; profit currency derives from the pair quote.
    return _Field(
      label: '2 · Pair',
      hint: 'what to trade',
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        modeToggle,
        TextField(
          controller: _pair,
          onChanged: (_) => setState(() => _profitCurrency = _quoteOf(_normPair())),
          style: mono(t, size: 15),
          decoration: _inputDec(t, suffix: 'Jupiter · Blockle'),
        ),
      ]),
    );
  }

  Widget _modeSeg(BotTokens t, String mode, String label) {
    final on = _pairMode == mode;
    return Expanded(
      child: Semantics(
        button: true,
        selected: on,
        child: InkWell(
          onTap: () => setState(() {
            _pairMode = mode;
            if (mode == 'manual') _profitCurrency = _quoteOf(_normPair());
          }),
          borderRadius: BorderRadius.circular(8),
          child: Container(
            padding: const EdgeInsets.symmetric(vertical: 9, horizontal: 6),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: on ? t.accentGhost : Colors.transparent,
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: on ? t.accent : Colors.transparent),
            ),
            child: Text(label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                    fontSize: 12, fontWeight: FontWeight.w600, color: on ? t.ink : t.inkMuted)),
          ),
        ),
      ),
    );
  }

  // LANE + RISK-MODE selectors. Both optional: "Any lane" / "Default" keep the
  // bot legacy (null). high/sniper show a caution line (sniper is the loudest).
  Widget _laneRiskSelect(BotTokens t) {
    Widget dropdown(String? value, List<MapEntry<String?, String>> choices,
        ValueChanged<String?> onCh) {
      return Container(
        padding: const EdgeInsets.symmetric(horizontal: 13),
        decoration: BoxDecoration(
          color: t.elevated,
          borderRadius: BorderRadius.circular(BotTokens.radiusSm),
          border: Border.all(color: t.line),
        ),
        child: DropdownButtonHideUnderline(
          child: DropdownButton<String?>(
            value: value,
            isExpanded: true,
            dropdownColor: t.surface,
            style: mono(t, size: 15, color: t.ink),
            items: [
              for (final c in choices)
                DropdownMenuItem<String?>(value: c.key, child: Text(c.value)),
            ],
            onChanged: (v) => setState(() => onCh(v)),
          ),
        ),
      );
    }

    final warn = _riskMode == 'sniper'
        ? 'Sniper targets brand-new launches — no track record, most go to zero. '
            'Every rug/holder/liquidity check still runs, but only risk what you can lose.'
        : _riskMode == 'high'
            ? 'High relaxes the liquidity + age gates to reach smaller, younger '
                'tokens — higher upside, higher chance of a loss.'
            : null;

    return _Field(
      label: 'Lane & risk',
      hint: 'one chain, one risk profile',
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(child: dropdown(_lane, _laneChoices, (v) => _lane = v)),
          const SizedBox(width: 10),
          Expanded(child: dropdown(_riskMode, _riskChoices, (v) => _riskMode = v)),
        ]),
        if (warn != null) ...[
          const SizedBox(height: 9),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              color: t.warn.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(BotTokens.radiusSm),
              border: Border.all(color: t.warn.withValues(alpha: 0.5)),
            ),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Icon(Icons.warning_amber_rounded, size: 16, color: t.warn),
              const SizedBox(width: 8),
              Expanded(
                child: Text(warn,
                    style: TextStyle(fontSize: 11.5, color: t.ink, height: 1.4)),
              ),
            ]),
          ),
        ],
      ]),
    );
  }

  // PROFIT-HANDLING selector — Take (skim) vs Compound (reinvest realized profit).
  // Defaults to 'take'. Compound lifts the deploy cap by realized profit; the note
  // makes the hard floor explicit: losses only draw down this bot's budget.
  Widget _profitSelect(BotTokens t) {
    return _Field(
      label: 'Profit handling',
      hint: 'what happens to realized profit',
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 13),
          decoration: BoxDecoration(
            color: t.elevated,
            borderRadius: BorderRadius.circular(BotTokens.radiusSm),
            border: Border.all(color: t.line),
          ),
          child: DropdownButtonHideUnderline(
            child: DropdownButton<String>(
              value: _profitMode,
              isExpanded: true,
              dropdownColor: t.surface,
              style: mono(t, size: 15, color: t.ink),
              items: [
                for (final c in _profitModeChoices)
                  DropdownMenuItem<String>(value: c.key, child: Text(c.value)),
              ],
              onChanged: (v) => setState(() => _profitMode = v ?? 'take'),
            ),
          ),
        ),
        const SizedBox(height: 7),
        Text(
          _profitMode == 'compound'
              ? 'Realized profit is reinvested — gains raise this bot’s deploy '
                  'cap so the next orders can be larger. Losses only draw down this '
                  'bot’s budget — never your wallet.'
              : 'Realized profit is skimmed to your profit currency and the deploy '
                  'cap stays at your budget. Losses only draw down this bot’s '
                  'budget — never your wallet.',
          style: TextStyle(fontSize: 11.5, color: t.inkMuted, height: 1.45),
        ),
      ]),
    );
  }

  Widget _advancedDrawer(BotTokens t) {
    Widget slider(String label, String value, double v, double min, double max,
        int divisions, ValueChanged<double> onCh) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            Text(label, style: TextStyle(fontSize: 12, color: t.inkMuted)),
            const Spacer(),
            Text(value, style: mono(t, size: 12, color: t.ink, w: FontWeight.w600)),
          ]),
          SliderTheme(
            data: SliderTheme.of(context).copyWith(
              trackHeight: 5,
              activeTrackColor: t.accent,
              inactiveTrackColor: t.line,
              thumbColor: t.accent,
              overlayColor: t.accentGhost,
            ),
            child: Slider(
              value: v,
              min: min,
              max: max,
              divisions: divisions,
              onChanged: (x) => setState(() => onCh(x)),
            ),
          ),
        ],
      );
    }

    final kids = [
      slider('Base order', '\$${_base.round()}', _base, 10, 300, 29, (x) => _base = x),
      slider('Take-profit', '${_tp.toStringAsFixed(1)}%', _tp, 0.5, 8, 15, (x) => _tp = x),
      slider('Safety orders', '$_so', _so.toDouble(), 0, 6, 6, (x) => _so = x.round()),
      slider('Price step', '${_step.toStringAsFixed(1)}%', _step, 0.5, 6, 11, (x) => _step = x),
      slider('Volume scale', '${_vol.toStringAsFixed(1)}×', _vol, 1, 2.5, 15, (x) => _vol = x),
      slider('Trailing', '${_tr.toStringAsFixed(1)}%', _tr, 0, 3, 15, (x) => _tr = x),
    ];
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: GridView.count(
        crossAxisCount: 2,
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        crossAxisSpacing: 13,
        mainAxisSpacing: 4,
        childAspectRatio: 3.1,
        children: kids,
      ),
    );
  }

  Widget _ladderPane(BotTokens t) {
    if (_aiPicksPairs) return _autopilotPane(t);
    final p = _preview;
    return BotCard(
      padding: const EdgeInsets.fromLTRB(20, 18, 20, 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Eyebrow('Deal preview'),
                const SizedBox(height: 4),
                Text(_normPair().replaceAll('/', ' / '),
                    style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: t.ink)),
              ],
            ),
            const Spacer(),
            BotChip(_templates[_tpl].type.toUpperCase(), accent: true),
          ]),
          const SizedBox(height: 10),
          if (_isDca)
            LadderChart(preview: p, priceUsd: _price)
          else
            _GridPreview(),
          const SizedBox(height: 14),
          // legend (table-fallback for the chart marks)
          Wrap(spacing: 16, runSpacing: 8, children: [
            _legend(t, t.kBase, 'Base order'),
            _legend(t, t.kSafety, 'Safety orders'),
            _legend(t, t.kTp, 'Take-profit'),
          ]),
          const SizedBox(height: 14),
          Divider(height: 1, color: t.lineSoft),
          const SizedBox(height: 14),
          Row(children: [
            _stat(t, 'Max deal size', moneyUsd(p.maxDealUsd, sign: false)),
            _stat(t, 'Avg entry if all fill', '\$${p.avgEntryUsd.toStringAsFixed(2)}'),
            _stat(t, 'Covers a dip of', '−${p.dipPct.toStringAsFixed(1)}%'),
          ]),
          const SizedBox(height: 10),
          Text('Preview at a reference \$${_price.toStringAsFixed(2)} — the exact engine math, not a live quote.',
              style: TextStyle(fontSize: 11, color: t.inkFaint)),
        ],
      ),
    );
  }

  Widget _autopilotPane(BotTokens t) {
    Widget point(IconData ic, String title, String body) => Padding(
          padding: const EdgeInsets.only(bottom: 14),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Icon(ic, size: 18, color: t.accent),
            const SizedBox(width: 11),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(title, style: TextStyle(fontWeight: FontWeight.w700, color: t.ink, fontSize: 13.5)),
                const SizedBox(height: 2),
                Text(body, style: TextStyle(color: t.inkMuted, fontSize: 12.5, height: 1.45)),
              ]),
            ),
          ]),
        );
    return BotCard(
      padding: const EdgeInsets.fromLTRB(20, 18, 20, 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Eyebrow('Autopilot · AI picks the pairs'),
                const SizedBox(height: 4),
                Text('Scan & Trade',
                    style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: t.ink)),
              ],
            ),
            const Spacer(),
            BotChip(_profitCurrency, accent: true),
          ]),
          const SizedBox(height: 14),
          point(Icons.radar, 'Scans every discoverable pair',
              'The scanner scores each pair for cost-positive profit (arbitrage, momentum, grid), net of gas, slippage and fees.'),
          point(Icons.trending_up, 'Trades only the worthy ones',
              'It auto-trades the top-ranked worthy pairs within your cap. A pair with no real signal is skipped — never a fabricated trade.'),
          point(Icons.savings_outlined, 'Realizes profit into $_profitCurrency',
              'P&L is denominated in $_profitCurrency and take-profit exits route their proceeds into it.'),
          point(Icons.verified_user, 'Paper + disabled + testnet by default',
              'Nothing goes live silently — live still passes the one gate, allocation cap, allowlist and audit.'),
        ],
      ),
    );
  }

  Widget _legend(BotTokens t, Color c, String label) => Row(mainAxisSize: MainAxisSize.min, children: [
        Container(width: 18, height: 3, color: c),
        const SizedBox(width: 7),
        Text(label, style: TextStyle(fontSize: 12, color: t.inkMuted)),
      ]);

  Widget _stat(BotTokens t, String label, String value) => Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Eyebrow(label),
            const SizedBox(height: 4),
            Text(value, style: mono(t, size: 16, color: t.ink, w: FontWeight.w600)),
          ],
        ),
      );

  InputDecoration _inputDec(BotTokens t, {String? prefix, String? suffix}) => InputDecoration(
        filled: true,
        fillColor: t.elevated,
        isDense: true,
        contentPadding: const EdgeInsets.symmetric(horizontal: 13, vertical: 14),
        prefixText: prefix,
        prefixStyle: mono(t, size: 15, color: t.inkFaint),
        suffixText: suffix,
        suffixStyle: TextStyle(fontSize: 12, color: t.inkMuted),
        enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(BotTokens.radiusSm),
            borderSide: BorderSide(color: t.line)),
        focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(BotTokens.radiusSm),
            borderSide: BorderSide(color: t.accent, width: 1.5)),
      );
}

class _GridPreview extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    return Container(
      height: 300,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: t.elevated,
        borderRadius: BorderRadius.circular(BotTokens.radiusSm),
        border: Border.all(color: t.line),
      ),
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.grid_view_rounded, color: t.accent, size: 34),
            const SizedBox(height: 12),
            Text('Grid of limit orders',
                style: TextStyle(fontWeight: FontWeight.w600, color: t.ink)),
            const SizedBox(height: 6),
            Text(
              'Seeds a ladder across the range from the template; a buy fill arms a sell '
              'one grid up (and vice-versa). Tune the range on the bot detail after creating.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 12, color: t.inkMuted, height: 1.5),
            ),
          ],
        ),
      ),
    );
  }
}

class _TplCard extends StatelessWidget {
  const _TplCard({required this.tpl, required this.selected, required this.onTap});
  final _Tpl tpl;
  final bool selected;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    return Semantics(
      button: true,
      selected: selected,
      label: '${tpl.name} template',
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(BotTokens.radiusSm),
        child: Container(
          padding: const EdgeInsets.all(13),
          decoration: BoxDecoration(
            color: selected ? t.accentGhost : t.elevated,
            borderRadius: BorderRadius.circular(BotTokens.radiusSm),
            border: Border.all(color: selected ? t.accent : t.line),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(children: [
                Container(
                  width: 22,
                  height: 22,
                  decoration: BoxDecoration(
                    color: t.accentGhost,
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Icon(tpl.icon, size: 13, color: t.accent),
                ),
                const SizedBox(width: 7),
                Expanded(
                  child: Text(tpl.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                          fontSize: 13.5, fontWeight: FontWeight.w600, color: t.ink)),
                ),
              ]),
              const SizedBox(height: 5),
              Expanded(
                child: Text(tpl.blurb,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 11.5, color: t.inkMuted, height: 1.4)),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Field extends StatelessWidget {
  const _Field({required this.label, required this.hint, required this.child});
  final String label, hint;
  final Widget child;
  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(children: [
          Text(label, style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: t.ink)),
          const SizedBox(width: 6),
          Text(hint, style: TextStyle(fontSize: 11.5, color: t.inkFaint)),
        ]),
        const SizedBox(height: 7),
        child,
      ],
    );
  }
}

class _Preview extends StatelessWidget {
  const _Preview({
    required this.isDca,
    required this.base,
    required this.so,
    required this.step,
    required this.tp,
    required this.tr,
    required this.baseSym,
    required this.alloc,
  });
  final bool isDca;
  final double base, step, tp, tr, alloc;
  final int so;
  final String baseSym;
  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    final trailing = tr > 0 ? ' with a ${tr.toStringAsFixed(1)}% trailing stop' : '';
    final text = isDca
        ? 'Buys \$${base.round()} of $baseSym now, then adds up to $so more '
            'time${so == 1 ? '' : 's'} if price dips (every ${step.toStringAsFixed(1)}%). '
            'Takes profit at +${tp.toStringAsFixed(1)}% from the average entry$trailing. '
            'Capped at ${moneyUsd(alloc, sign: false)}.'
        : 'Seeds a grid of limit orders across the template range and flips each fill '
            'one grid level. Capped at ${moneyUsd(alloc, sign: false)}.';
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 14),
      decoration: BoxDecoration(
        color: t.accentGhost,
        borderRadius: BorderRadius.circular(BotTokens.radiusSm),
        border: Border.all(color: t.accentDim),
      ),
      child: Text(text, style: TextStyle(fontSize: 13.5, color: t.ink, height: 1.55)),
    );
  }
}

/// The AI-mode summary block (replaces the DCA deal-preview text when the autopilot
/// chooses pairs): what the autopilot does + where profit settles.
class _AutopilotNote extends StatelessWidget {
  const _AutopilotNote({required this.profitCurrency, required this.alloc});
  final String profitCurrency;
  final double alloc;
  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 14),
      decoration: BoxDecoration(
        color: t.accentGhost,
        borderRadius: BorderRadius.circular(BotTokens.radiusSm),
        border: Border.all(color: t.accentDim),
      ),
      child: Text(
        'The AI scanner picks the pairs: it scores every discoverable market and '
        'auto-trades the worthy ones within ${moneyUsd(alloc, sign: false)}, realizing '
        'profit into $profitCurrency. No pair to choose. Starts paper + disabled.',
        style: TextStyle(fontSize: 13.5, color: t.ink, height: 1.55),
      ),
    );
  }
}

class _AdvancedToggle extends StatelessWidget {
  const _AdvancedToggle({required this.expanded, required this.onTap});
  final bool expanded;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    return InkWell(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.only(top: 14),
        decoration: BoxDecoration(border: Border(top: BorderSide(color: t.line))),
        child: Row(children: [
          Text('Advanced — safety orders, take-profit, trailing',
              style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: t.inkMuted)),
          const Spacer(),
          Icon(expanded ? Icons.keyboard_arrow_up : Icons.keyboard_arrow_down,
              size: 18, color: t.inkMuted),
        ]),
      ),
    );
  }
}

/// The live-arming REVIEW SHEET — the one deliberate moment (§5a). Restates the
/// allocation cap, auto-within-allocation, the kill switch, and the mainnet
/// requirement in plain words, then a single confirm.
class _ReviewSheet extends StatelessWidget {
  const _ReviewSheet({required this.alloc, required this.pair, required this.channel});
  final double alloc;
  final String pair;
  final String? channel;
  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    Widget point(IconData ic, String title, String body) => Padding(
          padding: const EdgeInsets.only(bottom: 14),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Icon(ic, size: 18, color: t.accent),
            const SizedBox(width: 11),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(title, style: TextStyle(fontWeight: FontWeight.w700, color: t.ink, fontSize: 13.5)),
                const SizedBox(height: 2),
                Text(body, style: TextStyle(color: t.inkMuted, fontSize: 12.5, height: 1.45)),
              ]),
            ),
          ]),
        );
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(
            20, 18, 20, 18 + MediaQuery.of(context).viewInsets.bottom),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(children: [
              Icon(Icons.verified_user, color: t.warn, size: 20),
              const SizedBox(width: 8),
              Text('Go live — review',
                  style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: t.ink)),
            ]),
            const SizedBox(height: 4),
            Text('This arms a REAL bot on $pair. Nothing is flipped silently.',
                style: TextStyle(color: t.inkMuted, fontSize: 12.5)),
            const SizedBox(height: 16),
            point(Icons.lock_outline, 'Hard allocation cap: ${moneyUsd(alloc, sign: false)}',
                'The bot can never spend more than this, ever. The cap counts the trade plus the 0.05% fee and is enforced on top of your session caps — the tighter bound wins.'),
            point(Icons.autorenew, 'Auto within the cap — no further taps',
                'Inside the cap the bot places orders automatically with no per-order confirm. Every order still passes the session caps, the allowlist, the hash-chained audit, and the fee.'),
            point(Icons.power_settings_new, 'Kill switch stays armed',
                'Kill-all stops every bot immediately, cancels open orders, and locks the vault.'),
            point(Icons.public_off, 'Testnet first — mainnet stays off',
                'This bot runs on testnet. Mainnet requires a separate operator sign-off (mainnetEnabled) and is refused until you enable it.'),
            if (channel != null)
              Text('Gated through your "$channel" agent channel.',
                  style: TextStyle(fontSize: 11.5, color: t.inkFaint)),
            const SizedBox(height: 14),
            Row(children: [
              Expanded(
                child: BotButton(
                  label: 'Cancel',
                  expand: true,
                  onPressed: () => Navigator.pop(context, false),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: BotButton(
                  label: 'Arm live',
                  icon: Icons.bolt,
                  primary: true,
                  expand: true,
                  onPressed: () => Navigator.pop(context, true),
                ),
              ),
            ]),
          ],
        ),
      ),
    );
  }
}
