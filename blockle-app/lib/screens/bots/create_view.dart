// create_view.dart — CREATE (§5a): two tiers on one screen. SIMPLE = template
// gallery -> pair -> ONE amount -> plain-language preview -> Start in paper
// (primary) / Go live (secondary). ADVANCED drawer (collapsed) = base order,
// safety orders, step, volume scale, take-profit, trailing — driving a LIVE
// deal-ladder preview computed with the real engine math (charts.DealPreview).
//
// Going live opens the REVIEW SHEET (the one deliberate moment): it restates the
// allocation cap, that orders run auto within it with no further taps, the kill
// switch, and the mainnet requirement, then a single confirm -> BotRunner.armLive.

import 'dart:async' show unawaited;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../agent/bots.dart' as b;
import '../../services/moonpay.dart';
import '../../services/open_url.dart';
import '../../state/bots_controller.dart';
import '../../state/multichain_controller.dart';
import '../../ui/app_icons.dart';
import '../accounts_screen.dart' show MoonPayBuyScreen;
import 'bots_tokens.dart';
import 'bots_widgets.dart';
import 'charts.dart';

class _Tpl {
  final String key, name, blurb, type;
  final IconData icon;
  final double base, tp, step, vol, tr, sl;
  final int so;
  const _Tpl(this.key, this.name, this.blurb, this.type, this.icon,
      {this.base = 20, this.tp = 2, this.so = 3, this.step = 2, this.vol = 1, this.tr = 0, this.sl = 0});
}

const List<_Tpl> _templates = [
  _Tpl('conservative_dca', 'Conservative DCA', 'Small base, 3 safety orders, +2% take-profit.',
      'dca', Icons.shield_outlined, base: 20, tp: 2, so: 3, step: 2, vol: 1.0, tr: 0, sl: 12),
  _Tpl('aggressive_dca', 'Aggressive DCA', 'Bigger base, martingale safety ladder, +3% TP.',
      'dca', Icons.bolt_outlined, base: 25, tp: 3, so: 4, step: 3, vol: 1.5, tr: 1, sl: 10),
  _Tpl('wide_grid', 'Wide Grid', 'A ladder of limit orders across a broad range.',
      'grid', Icons.grid_view_outlined),
  _Tpl('scalp_grid', 'Scalp Grid', 'A tight ±3% ladder around the live price.',
      'grid', Icons.grid_on_outlined),
  // The accumulator thesis is "no stop-loss, no rush" — keep sl: 0 deliberately.
  // Trades + takes profit in SOL (a real, priceable asset) — the old BLOCK pair
  // could never be priced, so that bot never traded.
  _Tpl('sol_accumulator', 'SOL Accumulator', 'Stack SOL on dips, trailing take-profit.',
      'dca', Icons.layers_outlined, base: 15, tp: 5, so: 5, step: 4, vol: 1.2, tr: 2, sl: 0),
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
    this.initialStrategy,
    this.copyBotId,
  });
  final BotsController controller;
  final void Function(String botId, bool live) onCreated;

  /// Optional seed from the Arena "use this for real" on-ramp.
  final Map<String, dynamic>? seed;

  /// Deep-link: `?strategy=<name>` from the home board "USE THIS STRATEGY" —
  /// preselects that live strategy in the picker.
  final String? initialStrategy;

  /// Deep-link: `?copyBot=<id>` from the leaderboard/profile "Copy" — clones
  /// another trader's bot CONFIG (strategy + knobs) via POST /account/api/bots/copy.
  final String? copyBotId;

  @override
  State<CreateView> createState() => _CreateViewState();
}

// Profit-currency choices (settlement/quote assets). USDC is the default.
// Stable AND base-currency profit options — "take profit in SOL/ETH/BTC" grows a
// real-asset stack (the settlement step converts proceeds into the chosen asset),
// not just a USD-pegged balance.
const List<String> _profitCurrencies = ['USDC', 'USDT', 'DAI', 'USD', 'SOL', 'ETH', 'BTC'];

// LANE choices — a bot trades ONE lane (chain + base asset), never cross-chain.
// null = unconstrained (legacy; the autopilot may wander any discoverable chain).
const List<MapEntry<String?, String>> _laneChoices = [
  MapEntry(null, 'Any lane'),
  MapEntry('solana', 'Solana · SOL'),
  MapEntry('ethereum', 'Ethereum · ETH'),
  MapEntry('base', 'Base · ETH'),
  MapEntry('arbitrum', 'Arbitrum · ETH'),
  MapEntry('optimism', 'Optimism · ETH'),
  MapEntry('polygon', 'Polygon · POL'),
  MapEntry('bsc', 'BNB Chain · BNB'),
  MapEntry('avalanche', 'Avalanche · AVAX'),
  MapEntry('tron', 'Tron · TRX'),
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
  double _base = 20, _tp = 2, _step = 2, _vol = 1.0, _tr = 0, _sl = 12;
  int _pollSec = 60; // adjustable tick interval (seconds)
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

  // STRATEGY MODE — the indicator-planner picker (the 9 single-market planners
  // with numeric knobs; see BotsController.plannerNames). Active when _pairMode ==
  // 'strategy'. The deal-bots (dca/grid/arbitrage) keep their template flow.
  // A per-chain BASE/QUOTE pair + one numeric input per planner knob (seeded from
  // the planner's .defaults) + a quick server backtest.
  String _strategy = '';
  final Map<String, TextEditingController> _knobCtls = {};
  final _baseCtl = TextEditingController(text: 'SOL');
  final _quoteCtl = TextEditingController(text: 'USDC');
  Map<String, dynamic>? _btResult; // last backtest {pnlPct, maxDrawdownPct, curve}
  bool _btBusy = false;

  // Default keys that are NOT user knobs (market/feed/portfolio), never rendered.
  static const Set<String> _knobSkip = {'market', 'history', 'held', 'balances'};

  bool get _strategyMode => _pairMode == 'strategy';
  bool get _aiPicksPairs => _pairMode == 'ai';

  @override
  void initState() {
    super.initState();
    _applyTpl(_templates[0]);
    // A seed from the Arena on-ramp is a concrete strategy on a pair -> manual.
    if (widget.seed != null) _pairMode = 'manual';
    _profitCurrency = _quoteOf(_normPair());
    // Default strategy selection (first indicator planner). The picker only ever
    // offers the 9 numeric-knob planners, so the default must come from that list.
    final live = widget.controller.plannerNames;
    _strategy = live.isNotEmpty ? live.first : 'rsi';
    _rebuildKnobs(_strategy);
    // DEEP-LINKS: ?strategy=<name> preselects a strategy; ?copyBot=<id> clones a
    // trader's CONFIG. Both land in the strategy picker (config only, never funds).
    final want = widget.initialStrategy?.trim().toLowerCase();
    if (want != null && want.isNotEmpty && live.contains(want)) {
      _pairMode = 'strategy';
      _strategy = want;
      _rebuildKnobs(want);
    }
    if (widget.copyBotId != null && widget.copyBotId!.trim().isNotEmpty) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _applyCopyBot(widget.copyBotId!.trim()));
    }
  }

  /// Rebuild the knob text controllers for [name] from its planner .defaults
  /// (skipping market/history/held/balances). Disposes the previous set.
  void _rebuildKnobs(String name) {
    for (final c in _knobCtls.values) {
      c.dispose();
    }
    _knobCtls.clear();
    final defs = widget.controller.strategyDefaults(name);
    for (final e in defs.entries) {
      if (_knobSkip.contains(e.key)) continue;
      if (e.value is! num) continue; // only numeric knobs get an input
      _knobCtls[e.key] = TextEditingController(text: _fmtKnob(e.value as num));
    }
    _btResult = null;
  }

  static String _fmtKnob(num v) {
    if (v == v.roundToDouble()) return v.toInt().toString();
    return '$v';
  }

  /// Collect the edited knob values (parsed as num, falling back to the default).
  Map<String, dynamic> _knobValues() {
    final defs = widget.controller.strategyDefaults(_strategy);
    final out = <String, dynamic>{};
    for (final e in _knobCtls.entries) {
      final parsed = num.tryParse(e.value.text.trim());
      out[e.key] = parsed ?? defs[e.key];
    }
    return out;
  }

  /// Fetch a cloned bot CONFIG by id (copy-trade) and prefill the strategy + knobs
  /// + pair. CONFIG ONLY — never funds or live state.
  Future<void> _applyCopyBot(String botId) async {
    try {
      final cfg = await widget.controller.copyBotConfig(botId);
      if (cfg == null || !mounted) return;
      final type = '${cfg['type'] ?? ''}'.toLowerCase();
      final live = widget.controller.plannerNames;
      final params = (cfg['params'] as Map?)?.cast<String, dynamic>() ?? const {};
      final pair = '${cfg['pair'] ?? ''}';
      setState(() {
        if (live.contains(type)) {
          _pairMode = 'strategy';
          _strategy = type;
          _rebuildKnobs(type);
          // Overlay copied knob values onto the seeded defaults.
          for (final e in _knobCtls.entries) {
            final v = params[e.key];
            if (v is num) e.value.text = _fmtKnob(v);
          }
        }
        if (pair.contains('/')) {
          final parts = pair.toUpperCase().split('/');
          _baseCtl.text = parts[0].trim();
          _quoteCtl.text = parts[1].trim();
        }
      });
      _snack('Copied $type config from the shared bot — review + arm when ready.');
    } catch (e) {
      _snack(e.toString().replaceFirst('StateError: ', '').replaceFirst('Exception: ', ''));
    }
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
    _sl = t.sl;
  }

  @override
  void dispose() {
    _pair.dispose();
    _alloc.dispose();
    _baseCtl.dispose();
    _quoteCtl.dispose();
    for (final c in _knobCtls.values) {
      c.dispose();
    }
    super.dispose();
  }

  String get _baseSym {
    if (_strategyMode) {
      final b = _baseCtl.text.trim().toUpperCase();
      return b.isNotEmpty ? b : 'SOL';
    }
    final p = _pair.text.toUpperCase().split('/');
    return p.isNotEmpty ? p.first.trim() : 'SOL';
  }

  /// The strategy-mode BASE/QUOTE market (per selected chain), normalized.
  String _stratPair() {
    final b = _baseCtl.text.trim().toUpperCase();
    final q = _quoteCtl.text.trim().toUpperCase();
    return '${b.isNotEmpty ? b : 'SOL'}/${q.isNotEmpty ? q : 'USDC'}';
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
        'stopLossPct': _sl,
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
    if (_strategyMode) {
      final pair = _stratPair();
      return widget.controller.createFromStrategy(
        _strategy,
        pair: pair,
        allocationUsd: alloc,
        knobs: _knobValues(),
        configOverride: {'profitCurrency': _quoteOf(pair)},
        lane: _lane,
        riskMode: _riskMode,
        profitMode: _profitMode,
        pollSec: _pollSec,
      );
    }
    if (_aiPicksPairs) {
      return widget.controller.createFromTemplate(
        'scan_and_trade',
        allocationUsd: alloc,
        configOverride: {'profitCurrency': _profitCurrency},
        lane: _lane,
        riskMode: _riskMode,
        profitMode: _profitMode,
        pollSec: _pollSec,
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
      pollSec: _pollSec,
    );
  }

  Future<void> _startPaper() async {
    // Surface any createFromStrategy/validateConfig/enablePaper throw as a snack
    // instead of crashing the create screen (mirrors _goLive's guard).
    try {
      final bot = _createBot(_allocUsd);
      // Pass the amount as the paper BUDGET so the sandbox is the same size as a
      // live run would be (depletes as it spends). Omitted/0 -> unbounded paper.
      await widget.controller.enablePaper(bot.id, allocationUsd: _allocUsd);
      widget.onCreated(bot.id, false);
    } catch (e) {
      _snack(e.toString().replaceFirst('StateError: ', '').replaceFirst('Exception: ', ''));
    }
  }

  Future<void> _goLive() async {
    final alloc = _allocUsd;
    if (alloc <= 0) {
      _snack('Set an allocation above \$0 — a live bot needs a hard cap.');
      return;
    }
    // Live trading is included for everyone — no plan gate, no sign-in wall.
    // Signed IN: the bot is delegated to Blockle's server runner and keeps
    // trading while the app is closed. Signed OUT: it still goes live, executed
    // by this device's runner while the app is open (delegation is best-effort
    // and simply skipped without an account bearer).
    // C1 FUND-A-BOT — if the live quote/settlement balance is below the hard
    // allocation cap, offer a card top-up of exactly the shortfall before we
    // arm. The arming gate itself is unchanged (this only funds the wallet).
    await _maybeTopUpShortfall(alloc);
    if (!mounted) return;
    final confirmed = await _showReviewSheet(alloc);
    if (confirmed != true || !mounted) return;
    final bot = _createBot(alloc);
    try {
      await widget.controller.armLive(bot.id, allocationUsd: alloc);
      // Background bots trade from a DEDICATED sub-account — surface it so the
      // user can fund it with the allocation (nothing drips until it's funded).
      final fundAddr = widget.controller.backgroundFundingAddress(bot.id);
      if (fundAddr != null && mounted) {
        await _showFundingSheet(fundAddr, alloc);
      }
      widget.onCreated(bot.id, true);
    } catch (e) {
      // Arming failed (cap, channel) — don't leave a stray disabled bot cluttering
      // the cockpit; remove the one we just created.
      unawaited(widget.controller.remove(bot.id));
      final msg = e.toString().replaceFirst('StateError: ', '').replaceFirst('Exception: ', '');
      _snack(msg);
    }
  }

  /// Prompt the user to fund the bot's dedicated background sub-account.
  Future<void> _showFundingSheet(String address, double alloc) {
    final t = BotTheme.of(context);
    return showModalBottomSheet<void>(
      context: context,
      backgroundColor: t.surface,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (sheetCtx) => BotTheme(
        tokens: t,
        child: Padding(
          padding: EdgeInsets.fromLTRB(20, 18, 20, 18 + MediaQuery.of(sheetCtx).viewInsets.bottom),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Icon(Icons.account_balance_wallet_outlined, color: t.accent, size: 20),
              const SizedBox(width: 8),
              Text('Fund your bot', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: t.ink)),
            ]),
            const SizedBox(height: 8),
            Text(
                'To keep trading while the app is closed, this bot runs from its OWN '
                'dedicated sub-account. Send up to ${moneyUsd(alloc, sign: false)} (plus a '
                'little for gas) to the address below. The bot can only ever touch this '
                'sub-account — never the rest of your wallet.',
                style: TextStyle(color: t.inkMuted, fontSize: 13, height: 1.5)),
            const SizedBox(height: 14),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: t.elevated,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: t.line),
              ),
              child: Row(children: [
                Expanded(child: SelectableText(address, style: mono(t, size: 12, color: t.ink))),
                IconButton(
                  icon: const Icon(Icons.copy, size: 18),
                  color: t.accent,
                  onPressed: () {
                    Clipboard.setData(ClipboardData(text: address));
                    ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text('Bot sub-account address copied.')));
                  },
                ),
              ]),
            ),
            const SizedBox(height: 10),
            Text(
                'Not funded yet? No problem — the bot just waits. Stopping it or Kill-all '
                'revokes the server delegation; sweep the sub-account back any time by '
                'sending from it in the wallet.',
                style: TextStyle(color: t.inkFaint, fontSize: 11.5, height: 1.4)),
            const SizedBox(height: 14),
            BotButton(label: 'Done', expand: true, onPressed: () => Navigator.pop(sheetCtx)),
          ]),
        ),
      ),
    );
  }

  /// The quote/settlement symbol this bot funds in (AI mode → profit currency;
  /// otherwise the pair's quote).
  String _fundingQuote() {
    if (_aiPicksPairs) return _profitCurrency.toUpperCase();
    if (_strategyMode) return _quoteOf(_stratPair());
    return _quoteOf(_normPair());
  }

  /// Map the selected lane to a wallet chain id for a card top-up ('bsc' is the
  /// wallet's 'bnb'; a null lane defaults to Ethereum for a stablecoin quote).
  String _fundingChain() {
    const laneToChain = {'bsc': 'bnb'};
    final lane = _lane;
    if (lane != null && lane.isNotEmpty) return laneToChain[lane] ?? lane;
    return 'ethereum';
  }

  /// C1 — check the live quote balance vs the allocation and, when short, offer
  /// a one-tap card top-up of the shortfall (BUY the quote stablecoin to the
  /// lane's own address). Only the stablecoin quotes (USDC/USDT/DAI) are checked
  /// 1:1 against USD; any other case just proceeds (never blocks arming).
  Future<void> _maybeTopUpShortfall(double alloc) async {
    const stables = {'USDC', 'USDT', 'DAI', 'USD'};
    final quote = _fundingQuote();
    if (!stables.contains(quote)) return; // can't value a non-stable quote 1:1
    final mc = context.read<MultichainController>();
    final chain = _fundingChain();
    double held = 0;
    try {
      final bals = await mc.balancesFor(chain);
      for (final bal in bals) {
        if (bal.asset.symbol.toUpperCase() == quote && bal.error == null) {
          held = double.tryParse(bal.display.replaceAll(',', '')) ?? 0;
          break;
        }
      }
    } catch (_) {
      return; // balance unknown → don't block
    }
    final shortfall = alloc - held;
    if (shortfall < 1) return; // funded enough
    if (!mounted) return;
    final acct = await mc.addressFor(chain);
    final addr = acct?.address ?? '';
    if (addr.isEmpty || !mc.moonpayConfig.featureBuy) return;
    if (!mounted) return;
    final topUp = await showDialog<bool>(
      context: context,
      builder: (dctx) => AlertDialog(
        backgroundColor: BotTheme.of(context).surface,
        title: const Text('Top up to fund this bot?'),
        content: Text(
          'Your $quote balance (\$${held.toStringAsFixed(2)}) is below the '
          '\$${alloc.toStringAsFixed(2)} allocation. Buy the \$'
          '${shortfall.ceil()} shortfall with a card now — it is delivered to '
          'your own wallet, then arming continues.',
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(dctx, false),
              child: const Text('Skip')),
          FilledButton(
              onPressed: () => Navigator.pop(dctx, true),
              child: Text('Top up \$${shortfall.ceil()}')),
        ],
      ),
    );
    if (topUp != true || !mounted) return;
    final url = await moonpayTopUpShortfall(
      config: mc.moonpayConfig,
      chain: chain,
      kind: 'erc20',
      symbol: quote,
      walletAddress: addr,
      shortfallUsd: shortfall,
    );
    if (!mounted) return;
    if (url == null) {
      _snack('Topping up $quote with a card isn’t available on $chain.');
      return;
    }
    if (kIsWeb) {
      openExternal(url);
    } else {
      await Navigator.push(
        context,
        MaterialPageRoute(
            builder: (_) => MoonPayBuyScreen(url: url, assetLabel: quote)),
      );
    }
    // On return we fall through to the review sheet → arm (auto-continue).
  }

  /// C2 FIAT AUTO-DCA — set up a recurring MoonPay card buy that funds this DCA
  /// bot. Opens the MoonPay recurring-buy widget (buy $X of the base asset every
  /// week) and pre-fills the bot's allocation to the matching weekly amount so
  /// "invest $X every week" and the DCA strategy are created together.
  Future<void> _setUpRecurringBuy() async {
    final weekly = await _askWeeklyUsd();
    if (weekly == null || !mounted) return;
    final mc = context.read<MultichainController>();
    final chain = _fundingChain();
    final acct = await mc.addressFor(chain);
    final addr = acct?.address ?? '';
    if (!mounted) return;
    final preset = await moonpayRecurringBuyPreset(
      config: mc.moonpayConfig,
      chain: chain,
      kind: 'native',
      symbol: _baseSym,
      walletAddress: addr,
      weeklyUsd: weekly,
    );
    if (!mounted) return;
    // Mirror the preset's DCA spec into the create form: a weekly cadence bot
    // whose allocation matches the recurring buy.
    setState(() {
      _alloc.text = (preset.botSpec['allocationUsd'] as num).toStringAsFixed(0);
    });
    if (preset.url == null) {
      _snack('Recurring card buys for $_baseSym aren’t available on $chain — '
          'the weekly DCA bot is still set up; start it below.');
      return;
    }
    if (kIsWeb) {
      openExternal(preset.url!);
    } else {
      await Navigator.push(
        context,
        MaterialPageRoute(
            builder: (_) =>
                MoonPayBuyScreen(url: preset.url!, assetLabel: _baseSym)),
      );
    }
    if (!mounted) return;
    _snack('Recurring buy set. Start the matching weekly DCA bot below.');
  }

  Future<double?> _askWeeklyUsd() async {
    final seed = _allocUsd > 0 ? _allocUsd.toStringAsFixed(0) : '25';
    final ctrl = TextEditingController(text: seed);
    final t = BotTheme.of(context);
    final v = await showDialog<double>(
      context: context,
      builder: (dctx) => AlertDialog(
        backgroundColor: t.surface,
        title: const Text('Invest how much per week?'),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))],
          decoration: const InputDecoration(prefixText: '\$ ', suffixText: '/ week'),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(dctx), child: const Text('Cancel')),
          FilledButton(
            onPressed: () =>
                Navigator.pop(dctx, double.tryParse(ctrl.text.trim())),
            child: const Text('Set it up'),
          ),
        ],
      ),
    );
    if (v == null || v <= 0) return null;
    return v;
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
          pair: _aiPicksPairs
              ? 'AI-chosen pairs → $_profitCurrency'
              : _strategyMode
                  ? '${_strategy.toUpperCase()} · ${_stratPair()}'
                  : _normPair(),
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
    // The numeric keypad on iOS has no return key, so the amount fields couldn't
    // be dismissed. Dragging the form now dismisses it, and a "Done" bar appears
    // above the keyboard whenever a field is focused.
    final keyboardOpen = MediaQuery.of(context).viewInsets.bottom > 0;
    return Stack(
      children: [
        ListView(
          padding: const EdgeInsets.fromLTRB(16, 18, 16, 36),
          keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
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
        ),
        if (keyboardOpen)
          Positioned(
            left: 0,
            right: 0,
            bottom: 0,
            child: Material(
              color: t.elevated,
              child: SafeArea(
                top: false,
                child: Container(
                  alignment: Alignment.centerRight,
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                  decoration: BoxDecoration(
                    border: Border(top: BorderSide(color: t.line)),
                  ),
                  child: TextButton(
                    onPressed: () =>
                        FocusManager.instance.primaryFocus?.unfocus(),
                    child: Text('Done',
                        style: TextStyle(
                            color: t.accent, fontWeight: FontWeight.w700)),
                  ),
                ),
              ),
            ),
          ),
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
          // brings it back). The Strategy mode has its OWN planner picker, so the
          // DCA/grid template grid is only shown in manual mode. Never show a
          // control that does nothing.
          if (_pairMode == 'manual') ...[
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
              decoration: _inputDec(t,
                  prefix: '\$',
                  suffix: _aiPicksPairs
                      ? _profitCurrency
                      : _strategyMode
                          ? _quoteOf(_stratPair())
                          : 'USDC'),
            ),
          ),
          const SizedBox(height: 16),
          _laneRiskSelect(t),
          const SizedBox(height: 16),
          _profitSelect(t),
          const SizedBox(height: 14),
          _tickPicker(t),
          const SizedBox(height: 16),
          if (_aiPicksPairs)
            _AutopilotNote(profitCurrency: _profitCurrency, alloc: _allocUsd)
          else if (_strategyMode) ...[
            const Eyebrow('Knobs'),
            const SizedBox(height: 10),
            _knobGrid(t),
            const SizedBox(height: 16),
            _backtestRow(t),
          ] else ...[
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
              const SizedBox(height: 10),
              _RecurringBuyCard(onTap: _setUpRecurringBuy),
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
        _modeSeg(t, 'ai', 'bot', 'AI picks'),
        _modeSeg(t, 'manual', 'edit', 'Pick a pair'),
        _modeSeg(t, 'strategy', 'bars', 'Strategy'),
      ]),
    );

    if (_strategyMode) {
      // STRATEGY MODE: a live-planner picker + a per-chain BASE/QUOTE pair. The
      // numeric knobs + backtest render below (left pane); this section owns the
      // picker + pair so bots run on every supported chain.
      return _Field(
        label: '2 · Strategy & market',
        hint: 'a live planner on a pair',
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          modeToggle,
          _strategyPicker(t),
          const SizedBox(height: 12),
          _pairFields(t),
        ]),
      );
    }

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

  Widget _modeSeg(BotTokens t, String mode, String iconName, String label) {
    final on = _pairMode == mode;
    return Expanded(
      child: Semantics(
        button: true,
        selected: on,
        child: InkWell(
          onTap: () => setState(() {
            _pairMode = mode;
            if (mode == 'manual') _profitCurrency = _quoteOf(_normPair());
            if (mode == 'strategy') _seedPairFromLane();
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
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              AppIcons.icon(iconName, size: 15, color: on ? t.ink : t.inkMuted),
              const SizedBox(width: 5),
              Flexible(
                child: Text(label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                        fontSize: 12, fontWeight: FontWeight.w600, color: on ? t.ink : t.inkMuted)),
              ),
            ]),
          ),
        ),
      ),
    );
  }

  // Seed the strategy-mode BASE from the selected lane's held asset (quote stays
  // USDC unless the user overrides it). "Any lane" leaves the current base.
  void _seedPairFromLane() {
    final base = b.laneBase(_lane);
    if (base != null && base.isNotEmpty) _baseCtl.text = base;
  }

  // STRATEGY PICKER — the 9 single-market INDICATOR planners (rsi/macd/bollinger/
  // breakout/emacross/momentum_roc/meanrev/rebalance_hold/hodl) as selectable
  // tiles, each with its describe() help text. The deal-bots (dca/grid/arbitrage)
  // keep their own template flow and the multi-asset planners (rebalance/momentum)
  // are excluded — picking those here builds an invalid config that crashes or
  // errors every tick. scalp/martingale are paper-only and never appear.
  Widget _strategyPicker(BotTokens t) {
    final names = widget.controller.plannerNames;
    return GridView.count(
      crossAxisCount: 2,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      crossAxisSpacing: 10,
      mainAxisSpacing: 10,
      childAspectRatio: 2.2,
      children: [
        for (final n in names)
          _StrategyCard(
            name: n,
            blurb: widget.controller.strategyDescribe(n),
            selected: n == _strategy,
            onTap: () => setState(() {
              _strategy = n;
              _rebuildKnobs(n);
            }),
          ),
      ],
    );
  }

  // Per-chain BASE / QUOTE market picker (bots run on every supported chain). The
  // base seeds from the selected lane; both are editable.
  Widget _pairFields(BotTokens t) {
    Widget fld(TextEditingController c, String label) => Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(label, style: TextStyle(fontSize: 11.5, color: t.inkMuted)),
            const SizedBox(height: 6),
            TextField(
              controller: c,
              onChanged: (_) => setState(() => _btResult = null),
              textCapitalization: TextCapitalization.characters,
              style: mono(t, size: 15),
              decoration: _inputDec(t),
            ),
          ]),
        );
    return Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
      fld(_baseCtl, 'Base (what to trade)'),
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 10),
        child: Text('/', style: TextStyle(fontSize: 18, color: t.inkMuted)),
      ),
      fld(_quoteCtl, 'Quote (settles P&L)'),
    ]);
  }

  // One numeric input per planner knob (seeded from .defaults; market/history/
  // held/balances are never shown). Edited values become the bot's params.
  Widget _knobGrid(BotTokens t) {
    if (_knobCtls.isEmpty) {
      return Text('This strategy has no tunable knobs — it buys once and holds.',
          style: TextStyle(fontSize: 12, color: t.inkMuted));
    }
    return GridView.count(
      crossAxisCount: 2,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      crossAxisSpacing: 13,
      mainAxisSpacing: 10,
      childAspectRatio: 3.0,
      children: [
        for (final e in _knobCtls.entries)
          Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(_knobLabel(e.key),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 11.5, color: t.inkMuted)),
            const SizedBox(height: 5),
            TextField(
              controller: e.value,
              onChanged: (_) => setState(() => _btResult = null),
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))],
              style: mono(t, size: 15),
              decoration: _inputDec(t),
            ),
          ]),
      ],
    );
  }

  // Humanize a knob key for its label.
  static String _knobLabel(String key) {
    switch (key) {
      case 'budgetUsd':
        return 'Budget (USD)';
      case 'positionPct':
        return 'Position %';
      case 'oversold':
        return 'Oversold';
      case 'overbought':
        return 'Overbought';
      case 'signalP':
        return 'Signal period';
      case 'thresholdPct':
        return 'Threshold %';
      case 'bandPct':
        return 'Band %';
      case 'targetPct':
        return 'Target %';
      case 'driftPct':
        return 'Drift %';
      case 'stopPct':
        return 'Stop %';
      default:
        return key[0].toUpperCase() + key.substring(1);
    }
  }

  // "Backtest this config" — POST the configured strategy to the account service
  // and show pnl% + a sparkline from the returned equity curve.
  Future<void> _runBacktest() async {
    setState(() {
      _btBusy = true;
      _btResult = null;
    });
    try {
      final res = await widget.controller.backtest(
        type: _strategy,
        params: {..._knobValues(), 'market': _stratPair()},
        asset: _baseSym,
      );
      if (mounted) setState(() => _btResult = res);
    } catch (e) {
      _snack(e.toString().replaceFirst('StateError: ', '').replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _btBusy = false);
    }
  }

  Widget _backtestRow(BotTokens t) {
    final res = _btResult;
    final curve = (res?['curve'] as List?)?.map((e) => (e as num).toDouble()).toList() ?? const <double>[];
    final pnl = res != null ? (res['pnlPct'] as num?)?.toDouble() : null;
    final dd = res != null ? (res['maxDrawdownPct'] as num?)?.toDouble() : null;
    final trades = res != null ? (res['trades'] as num?)?.toInt() : null;
    final winRate = res != null ? (res['winRatePct'] as num?)?.toDouble() : null;
    final sharpe = res != null ? (res['sharpe'] as num?)?.toDouble() : null;
    final vsHodl = res != null ? (res['vsHodlPct'] as num?)?.toDouble() : null;
    final hodl = res != null ? (res['assetMovePct'] as num?)?.toDouble() : null;

    Widget metric(String label, String value, {Color? vc}) => Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(label, style: TextStyle(fontSize: 10.5, color: t.inkFaint)),
            const SizedBox(height: 2),
            Text(value, style: mono(t, size: 14, color: vc ?? t.ink, w: FontWeight.w700)),
          ],
        );

    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        BotButton(
          label: _btBusy ? 'Backtesting…' : 'Backtest this config',
          icon: Icons.insights_outlined,
          onPressed: _btBusy ? null : _runBacktest,
        ),
        const SizedBox(width: 10),
        if (pnl != null)
          Text('${pnl >= 0 ? '+' : ''}${pnl.toStringAsFixed(2)}%',
              style: mono(t, size: 18,
                  color: pnl >= 0 ? t.gain : t.loss, w: FontWeight.w700)),
      ]),
      if (res != null) ...[
        const SizedBox(height: 10),
        if (curve.length > 1)
          _Sparkline(values: curve, color: (pnl ?? 0) >= 0 ? t.gain : t.loss, line: t.line),
        const SizedBox(height: 12),
        // Richer analytics: vs buy-and-hold, win-rate, risk-adjusted return.
        Wrap(spacing: 22, runSpacing: 10, children: [
          if (vsHodl != null)
            metric('vs HODL', '${vsHodl >= 0 ? '+' : ''}${vsHodl.toStringAsFixed(2)}%',
                vc: vsHodl >= 0 ? t.gain : t.loss),
          if (winRate != null) metric('Win rate', '${winRate.toStringAsFixed(0)}%'),
          if (sharpe != null)
            metric('Risk-adj (Sharpe)', sharpe.toStringAsFixed(2),
                vc: sharpe >= 0 ? t.ink : t.loss),
          if (dd != null) metric('Max drawdown', '-${dd.toStringAsFixed(1)}%', vc: t.loss),
          if (trades != null) metric('Trades', '$trades'),
        ]),
        const SizedBox(height: 10),
        // The "USE THIS STRATEGY" apply the onboarding copy promises — one tap to
        // start this exact config in paper (live stays behind the review sheet).
        BotButton(
          label: 'Use this strategy — start in paper',
          icon: Icons.play_arrow_rounded,
          onPressed: _btBusy ? null : _startPaper,
        ),
        const SizedBox(height: 8),
        Text(
          'Paper simulation on ~30 days of real $_baseSym prices'
          '${hodl != null ? ' (buy-and-hold was ${hodl >= 0 ? '+' : ''}${hodl.toStringAsFixed(1)}%)' : ''}. '
          'Past results never guarantee future returns.',
          style: TextStyle(fontSize: 11, color: t.inkFaint, height: 1.4),
        ),
      ],
    ]);
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
          Expanded(child: dropdown(_lane, _laneChoices, (v) {
            _lane = v;
            if (_strategyMode) _seedPairFromLane();
          })),
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
      slider('Stop-loss', _sl <= 0 ? 'Off' : '-${_sl.round()}%', _sl, 0, 30, 30, (x) => _sl = x),
    ];
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        GridView.count(
          crossAxisCount: 2,
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          crossAxisSpacing: 13,
          mainAxisSpacing: 4,
          childAspectRatio: 3.1,
          children: kids,
        ),
        const SizedBox(height: 10),
        _tickPicker(t),
      ]),
    );
  }

  /// Adjustable tick-interval picker (how often the bot evaluates + may trade).
  /// Shorter = more reactive (more RPC/battery); longer = calmer. Applies to
  /// every bot type.
  Widget _tickPicker(BotTokens t) {
    return Row(children: [
      Icon(Icons.timer_outlined, size: 16, color: t.inkMuted),
      const SizedBox(width: 8),
      Text('Tick every', style: TextStyle(fontSize: 12.5, color: t.inkMuted)),
      const Spacer(),
      Container(
        padding: const EdgeInsets.symmetric(horizontal: 12),
        decoration: BoxDecoration(
          color: t.elevated,
          borderRadius: BorderRadius.circular(BotTokens.radiusSm),
          border: Border.all(color: t.line),
        ),
        child: DropdownButtonHideUnderline(
          child: DropdownButton<int>(
            value: _pollSec,
            dropdownColor: t.surface,
            style: mono(t, size: 14, color: t.ink),
            items: [
              for (final s in BotsController.pollSecChoices)
                DropdownMenuItem<int>(value: s, child: Text(BotsController.tickLabel(s))),
            ],
            onChanged: (v) => setState(() => _pollSec = v ?? _pollSec),
          ),
        ),
      ),
    ]);
  }

  Widget _ladderPane(BotTokens t) {
    if (_aiPicksPairs) return _autopilotPane(t);
    if (_strategyMode) return _strategyPane(t);
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
          Row(children: [
            Icon(_sl > 0 ? Icons.verified_user_outlined : Icons.info_outline,
                size: 14, color: _sl > 0 ? t.gain : t.inkFaint),
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                _sl > 0
                    ? 'Stop-loss at −${_sl.round()}% from average entry — the bot cuts the position if price falls through it.'
                    : 'No stop-loss — this bot holds through any drawdown. Add one in Advanced for downside protection.',
                style: TextStyle(fontSize: 11.5, color: _sl > 0 ? t.inkMuted : t.inkFaint, height: 1.4),
              ),
            ),
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
          point(Icons.radar, 'Scans every discoverable pair, every minute',
              'The scanner scores each pair for cost-positive profit (arbitrage, momentum, grid, sniper), net of gas, slippage and fees.'),
          point(Icons.bolt, 'Aggressive by default',
              'Takes any edge from 10 bps, runs up to 6 pairs at once, sizes each clip at ~1/8 of your cap and buys screened new tokens from the "high" discovery gate (risk: ${_riskMode ?? 'high'}). Rug, honeypot and denylist checks still hard-fail.'),
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

  // STRATEGY MODE right pane — the selected planner, its describe() help, the
  // market it runs on, and the live knob values (mirrors the deal-preview pane).
  Widget _strategyPane(BotTokens t) {
    final knobs = _knobValues();
    return BotCard(
      padding: const EdgeInsets.fromLTRB(20, 18, 20, 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Eyebrow('Strategy · live planner'),
                const SizedBox(height: 4),
                Text(_strategy.toUpperCase(),
                    style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: t.ink)),
              ],
            ),
            const Spacer(),
            BotChip(_stratPair().replaceAll('/', ' / '), accent: true),
          ]),
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 14),
            decoration: BoxDecoration(
              color: t.accentGhost,
              borderRadius: BorderRadius.circular(BotTokens.radiusSm),
              border: Border.all(color: t.accentDim),
            ),
            child: Text(widget.controller.strategyDescribe(_strategy),
                style: TextStyle(fontSize: 13.5, color: t.ink, height: 1.55)),
          ),
          const SizedBox(height: 14),
          Divider(height: 1, color: t.lineSoft),
          const SizedBox(height: 14),
          Wrap(spacing: 18, runSpacing: 12, children: [
            for (final e in knobs.entries)
              _stat(t, _knobLabel(e.key), '${e.value}'),
          ]),
          const SizedBox(height: 14),
          Text(
            'Runs on the ${b.laneBase(_lane) != null ? b.laneChain(_lane) : 'selected'} chain. '
            'Starts paper + disabled + testnet — nothing goes live until you review + arm it.',
            style: TextStyle(fontSize: 11, color: t.inkFaint, height: 1.4),
          ),
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
/// C2 — the "Invest weekly with a card" affordance on the DCA create flow.
class _RecurringBuyCard extends StatelessWidget {
  const _RecurringBuyCard({required this.onTap});
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(BotTokens.radiusSm),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: t.accentGhost,
          borderRadius: BorderRadius.circular(BotTokens.radiusSm),
          border: Border.all(color: t.accentDim),
        ),
        child: Row(children: [
          Icon(Icons.event_repeat_outlined, size: 18, color: t.accent),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Invest every week with a card',
                  style: TextStyle(
                      fontSize: 13.5,
                      fontWeight: FontWeight.w700,
                      color: t.ink)),
              const SizedBox(height: 2),
              Text('Sets up a recurring MoonPay buy funding this DCA bot.',
                  style: TextStyle(fontSize: 12, color: t.inkMuted)),
            ]),
          ),
          Icon(Icons.chevron_right, size: 18, color: t.inkMuted),
        ]),
      ),
    );
  }
}

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
    final media = MediaQuery.of(context);
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(20, 18, 20, 18 + media.viewInsets.bottom),
        // The review text is long; on a small phone it overflows a plain
        // Column. Cap the sheet at 88% of the screen and SCROLL the body while
        // the Cancel / Arm live buttons stay pinned and always reachable.
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: media.size.height * 0.88),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Flexible(
                child: SingleChildScrollView(
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
            const SizedBox(height: 14),
            // SECURITY-CHANGE NOTICE — a live bot that keeps trading while the app
            // is closed must delegate a scoped signing key to Blockle's server;
            // otherwise your keys never leave the device. The user acknowledges
            // this by tapping "Arm live".
            Container(
              padding: const EdgeInsets.all(13),
              decoration: BoxDecoration(
                color: t.warn.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: t.warn.withValues(alpha: 0.5)),
              ),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Icon(Icons.shield_outlined, size: 18, color: t.warn),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('Starting a trading bot changes your security',
                        style: TextStyle(
                            fontWeight: FontWeight.w800, color: t.warn, fontSize: 13)),
                    const SizedBox(height: 3),
                    Text(
                        'Normally your keys never leave this device. To keep trading '
                        'while the app is closed, a live bot delegates a SCOPED, capped, '
                        'revocable signing key so it can trade within the cap only — never '
                        'the rest of your wallet. Strict limits:\n'
                        '• Held only WHILE the bot runs — stopping it or Kill-all wipes the '
                        'key from the server immediately.\n'
                        '• Only the key for THIS bot\'s active chain is delegated — no other '
                        'chain\'s keys are ever uploaded.\n'
                        'Leave it off and the bot only runs while the app is open.',
                        style: TextStyle(color: t.inkMuted, fontSize: 12, height: 1.45)),
                  ]),
                ),
              ]),
            ),
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
                    ],
                  ),
                ),
              ),
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
      ),
    );
  }
}

/// A selectable LIVE-strategy tile for the strategy picker (strategy mode). Shows
/// the planner name + its describe() help text; mirrors _TplCard styling.
class _StrategyCard extends StatelessWidget {
  const _StrategyCard({
    required this.name,
    required this.blurb,
    required this.selected,
    required this.onTap,
  });
  final String name, blurb;
  final bool selected;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    return Semantics(
      button: true,
      selected: selected,
      label: '$name strategy',
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(BotTokens.radiusSm),
        child: Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: selected ? t.accentGhost : t.elevated,
            borderRadius: BorderRadius.circular(BotTokens.radiusSm),
            border: Border.all(color: selected ? t.accent : t.line),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(name.toUpperCase(),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                      fontSize: 13, fontWeight: FontWeight.w700, color: t.ink, letterSpacing: 0.3)),
              const SizedBox(height: 4),
              Expanded(
                child: Text(blurb,
                    maxLines: 3,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 11, color: t.inkMuted, height: 1.35)),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A minimal equity-curve sparkline for the quick-backtest result. Pure
/// CustomPainter (no external chart deps); the curve is a list of % values.
class _Sparkline extends StatelessWidget {
  const _Sparkline({required this.values, required this.color, required this.line});
  final List<double> values;
  final Color color, line;
  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 56,
      width: double.infinity,
      child: CustomPaint(painter: _SparklinePainter(values, color, line)),
    );
  }
}

class _SparklinePainter extends CustomPainter {
  _SparklinePainter(this.values, this.color, this.line);
  final List<double> values;
  final Color color, line;
  @override
  void paint(Canvas canvas, Size size) {
    if (values.length < 2) return;
    var lo = values.first, hi = values.first;
    for (final v in values) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    final span = (hi - lo).abs() < 1e-9 ? 1.0 : (hi - lo);
    double x(int i) => size.width * i / (values.length - 1);
    double y(double v) => size.height - ((v - lo) / span) * size.height;

    // zero baseline (break-even), when it falls within range
    if (lo <= 0 && hi >= 0) {
      final zy = y(0);
      canvas.drawLine(Offset(0, zy), Offset(size.width, zy),
          Paint()..color = line..strokeWidth = 1);
    }
    final path = Path()..moveTo(x(0), y(values[0]));
    for (var i = 1; i < values.length; i++) {
      path.lineTo(x(i), y(values[i]));
    }
    canvas.drawPath(
        path,
        Paint()
          ..color = color
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2
          ..strokeJoin = StrokeJoin.round);
  }

  @override
  bool shouldRepaint(_SparklinePainter old) => old.values != values || old.color != color;
}
