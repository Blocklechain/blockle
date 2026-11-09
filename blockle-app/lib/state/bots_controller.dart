// bots_controller.dart — the VIEW-MODEL for the native Blockle Bots UI
// (docs/BLOCKLE-BOTS.md §1-9). It is a THIN adapter: it owns no money logic and
// no second broadcast path. EVERYTHING is driven by the real engine modules
// already in this wallet:
//
//   • bots.dart        — the Bot model, deal state machines, money/qty helpers.
//   • bot_runner.dart  — the ONE gated dispatch (caps -> confirm -> commit ->
//                        recordSpend, with the 0.05% fee + kill + allowlist +
//                        hash-chained audit + mainnet gate + the hard per-bot
//                        allocation ledger). The UI calls ONLY these methods.
//   • bot_templates    — the starter presets + the non-bypassable template import
//                        (always lands paper + disabled + testnet).
//   • arena.dart       — the PURE, play-money sandbox (no keys/vault/gate ever).
//   • pnl.dart/notify  — the realized-profit ledger + pop-up surface (§8).
//   • discovery.dart   — the READ-ONLY candidate feed for signal bots (§7).
//
// SAFETY: the controller NEVER signs or broadcasts. Paper bots never touch the
// gate. A LIVE order only fires through BotRunner's dispatch, which binds to a
// RUNNING agent channel's real policy + tools (wired to the Accounts facade) so
// there is exactly one commit path. Live arming is fail-closed without a backing
// channel (no session cap -> BotRunner.armLive throws). Kill-all is the runner
// kill (stops all bots, cancels open orders, locks the vault).

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'dart:convert';

import 'dart:async' show unawaited;

import '../agent/audit.dart';
import '../agent/bot_delegation_client.dart';
import '../multichain/wallet_export.dart' as wx;
import '../agent/bots.dart' as b;
import '../agent/bot_runner.dart';
import '../agent/bot_templates.dart' as tpl;
import '../agent/arena.dart' as ar;
import '../agent/index.dart' show AgentInstance;
import '../agent/notify.dart';
import '../agent/pnl.dart';
import '../agent/policy.dart';
import '../agent/signals_discovery.dart' show SignalsDiscovery;
import '../agent/strategies.dart' show StrategyContext;
import '../agent/tools.dart' show ToolRegistry;
import '../multichain/backup_client.dart' as bc;
import '../services/agent_service.dart' show SecureChannelStore;
import '../services/local_notifications.dart' show LocalNotifications;
import 'liquidity_controller.dart' show LiquidityService;
import '../multichain/chains/chain_adapter.dart' show AssetRef;
import '../multichain/prices.dart' show PriceService, priceKey;
import 'multichain_controller.dart';

/// The bot order tools that must be on the policy allowlist for a bot to act.
const List<String> kBotToolNames = ['swap', 'place_order', 'cancel_order'];

class BotsController extends ChangeNotifier {
  BotsController(this._mc);

  final MultichainController _mc;

  // ---- engine objects (all real; none mocked) ------------------------------
  late final b.BotStore _store;
  late final Audit _fallbackAudit;
  late final Policy _fallbackPolicy;
  late final ToolRegistry _fallbackTools;
  late final PnlLedger _pnlLedger;
  late final PnlHook _pnl;
  // READ-ONLY lane/mode-aware candidate feed for signal bots + the scanner (§7).
  // Never trades, never auto-allowlists; approval + the gate still apply.
  final SignalsDiscovery _discovery = SignalsDiscovery();
  BotRunner? _runner;
  // The account's effective Copilot tier (incl. active free trial); gates live arming.
  // Fail-closed to 'free'. Updated via setLiveEntitled() when subscription state changes.
  String _liveTier = 'free';
  // Per-plan LIVE-bot cap (Free 1, Copilot 3, Pro -1 = unlimited). -1 until an
  // account is linked (live arming is separately gated by _liveTier). Mirrors the
  // web wallet (app.js loadTier -> runner.setLiveBotLimit).
  int _liveBotLimit = -1;
  final ar.ArenaProfile arena = ar.ArenaProfile();
  Map<String, dynamic>? _vectors;

  bool ready = false;

  /// Realized-profit pop-ups from the notify module (§8); newest first.
  final List<AgentNotification> notifications = [];

  /// Optional per-surface theme override (null = follow the app theme). Mirrors
  /// the reference prototype's light/dark toggle.
  Brightness? themeOverride;

  // ---- lifecycle -----------------------------------------------------------

  Future<void> init() async {
    _store = b.BotStore(
      store: SecureChannelStore(blobKey: 'bk_bots'),
      key: 'agentBots',
    );
    _fallbackAudit = Audit();
    // A fallback policy so PAPER bots + lifecycle work before any agent channel
    // is connected. It carries a default session cap (bounds any future live
    // arm attempt) and allowlists the bot order tools so paper fills pass the
    // allowlist check. It has NO value-moving tool handlers, so it can never
    // broadcast — live orders only ever fire through a real channel's policy.
    _fallbackPolicy = Policy.create(caps: const {'sessionUsd': 100})
      ..setAllowlist(kBotToolNames);
    _fallbackTools = ToolRegistry(const []);
    _pnlLedger = PnlLedger();
    _pnl = PnlHook(
      ledger: _pnlLedger,
      notifier: CallbackNotifier(_onNotify),
      audit: _fallbackAudit,
    );

    try {
      await _store.restore();
    } catch (_) {}
    try {
      final raw = await rootBundle.loadString('assets/bots/arena-vectors.json');
      _vectors = (jsonDecode(raw) as Map).cast<String, dynamic>();
    } catch (_) {
      _vectors = null; // Arena falls back to the live generator (§9, non-canonical)
    }
    _rebuildRunner();
    _mc.addListener(_rebuildRunner);
    ready = true;
    notifyListeners();
  }

  @override
  void dispose() {
    _runner?.stopScheduler();
    _mc.removeListener(_rebuildRunner);
    super.dispose();
  }

  // ---- runner binding: use a RUNNING channel's real gate when available -----

  /// The first running, value-moving (non-read-only) agent channel's instance —
  /// the real policy + tools wired to the Accounts facade. Null when none is up.
  AgentInstance? _backingInstance() {
    try {
      for (final ch in _mc.agent.manager.channels.values) {
        if (ch.instance != null && ch.meta['readOnly'] != true) {
          return ch.instance;
        }
      }
    } catch (_) {}
    return null;
  }

  /// Whether a live bot can be armed right now. Live execution runs on the
  /// SERVER (delegation), which needs a signed-in Blockle account — OR, legacy,
  /// a running in-app value-moving channel. (The old in-app Agent tab is gone;
  /// signing in is the path now, handled by requireAccount in the go-live flow.)
  bool get canGoLive =>
      (_mc.moonpayBearer ?? '').isNotEmpty || _backingInstance() != null;

  String? get backingChannelLabel {
    try {
      for (final ch in _mc.agent.manager.channels.values) {
        if (ch.instance != null && ch.meta['readOnly'] != true) {
          return ch.meta['label'] as String?;
        }
      }
    } catch (_) {}
    return null;
  }

  // Identity of the inputs that actually require a runner rebuild. This runs as a
  // listener on EVERY MultichainController notify (balance/price polls fire it
  // constantly), so it must NOT rebuild unless something material changed — a
  // rebuild recreates the scheduler's Timer.periodic from zero, and if that
  // happens more often than the tick interval the timer never fires and BOTS
  // NEVER TICK (no trades, paper or live). The guard below keeps the running
  // scheduler alive across the noise.
  String? _lastBuildKey;

  void _rebuildRunner() {
    // Keep the live-bot gate in sync with the account's effective tier (the agent
    // tracks it, incl. an active free trial). Fail-soft: `agent` is a late field
    // that can be mid-(re)init; a throw here would blank the Bots screen.
    try {
      _liveTier = _mc.agent.copilotTier;
      _liveBotLimit = _mc.agent.liveBotLimit;
    } catch (_) {/* agent not ready yet — keep prior tier/limit (fail-closed) */}
    final inst = _backingInstance();
    // Only a change in the BACKING INSTANCE (policy/tools source) requires a true
    // rebuild. Tier/limit/portfolio-cap are pushed into the EXISTING runner below
    // without touching its scheduler, so a normal notify never resets the tick.
    final key = '${identityHashCode(inst)}';
    if (_runner != null && key == _lastBuildKey) {
      _runner!
        ..setLiveEntitled(_liveTier)
        ..setLiveBotLimit(_liveBotLimit)
        ..portfolioLiveCapUsd = _store.meta['portfolioLiveCapUsd'] as num?;
      // Make sure a scheduler is running if there are enabled bots (e.g. after a
      // hot-reload or if it was stopped) — startScheduler is a no-op when already
      // running at the right cadence is NOT guaranteed, so only start when idle.
      if (!_runner!.schedulerRunning && _runner!.list().any((b) => b.enabled)) {
        _runner!.startScheduler();
      }
      return;
    }
    _lastBuildKey = key;
    // A genuine rebuild (backing instance changed): stop the old scheduler so it
    // doesn't orphan-tick the old instance.
    _runner?.stopScheduler();
    final Policy policy = inst?.policy ?? _fallbackPolicy;
    final ToolRegistry tools = inst?.tools ?? _fallbackTools;
    final dynamic audit = inst?.audit ?? _fallbackAudit;
    final PnlHook pnl = inst?.pnlHook ?? _pnl;
    _runner = BotRunner(
      policy: policy,
      tools: tools,
      audit: audit,
      ctx: BotContext(
        now: () => DateTime.now().millisecondsSinceEpoch,
        network: () => 'testnet',
        // REAL marks from the wallet's existing live market data — the SAME
        // non-custodial Exchange the agent ctx uses (§5). A market with no data
        // simply yields no mark and the engine skips that tick.
        prices: _prices,
        // READ-ONLY lane/mode-aware candidate feed (signal bots + scanner).
        discovery: _discovery,
        // The scheduled/indicator strategy planners (rsi/macd/… + rebalance/
        // momentum) read market data through this READ-ONLY context. The runner
        // feeds them a rolling price `history` from the SAME real marks; a non-
        // stable quote is priced from here (never fabricated). getBalance is
        // omitted (indicator exits then skip until a balance source is wired).
        strategyCtx: StrategyContext(
          now: () => DateTime.now().millisecondsSinceEpoch,
          network: () => 'testnet',
          prices: _prices,
          policyRemaining: () {
            final s = policy.caps.sessionUsd;
            return {'sessionUsd': s};
          },
        ),
      ),
      mainnetEnabled: false,
      // Every tier can run at least ONE live bot (Free 1 / Alien 3 / Pro ∞);
      // the paywall gates the COUNT, not live access. The per-plan cap below
      // enforces how many.
      liveEntitled: true,
      liveBotLimit: _liveBotLimit,
      portfolioLiveCapUsd: _store.meta['portfolioLiveCapUsd'] as num?,
      // Production: tick a freshly-enabled bot immediately (don't make it wait a
      // full poll interval to place its first order).
      immediateFirstTick: true,
      // Only execute live orders locally when a real value-moving channel backs
      // the runner. Otherwise live bots run on the SERVER (delegation); the
      // client just registers them and must not tick-execute (see BotRunner).
      clientExecutesLive: inst != null,
      onEvent: _onEvent,
      pnl: pnl,
      // Profit pings (paper + live, any currency) flow through the SAME in-app
      // notification sink as the PnlHook, and on to the OS banner surface.
      notifier: CallbackNotifier(_onNotify),
      store: _store,
    );
    // Resume ticking across a rebuild if any bot is already enabled/armed.
    if (_runner!.list().any((bot) => bot.enabled)) {
      _runner!.startScheduler();
    }
    notifyListeners();
  }

  // ---- REAL market marks (§4/§5) -------------------------------------------
  //
  // Feed the engine a per-symbol USD unit price from the shared [PriceService]
  // (server proxy → CoinGecko → DeFiLlama → Coinbase) — the SAME live feed the
  // Accounts/portfolio screens use. Covers every chain's native coin + major
  // tokens, so the scanner / live bots can price-and-trade on any supported
  // chain (not just the decommissioned exchange's pairs).
  //
  // NO SYNTHETIC PRICES: a symbol no source can price is simply omitted, so the
  // engine skips that tick (audited `skipped`) rather than fabricating a fill.

  /// Stablecoins pin to $1 (mirrors the engine's `_stableUsd` set).
  static const Set<String> _stableSyms = {
    'USDC', 'USDT', 'DAI', 'USD', 'USDBC', 'USDB', 'PYUSD', 'TUSD',
  };

  final PriceService _priceSvc = PriceService(serverBase: 'https://blockle.org');

  Future<Map<String, num>> _prices(List<String> symbols) async {
    if (symbols.isEmpty) return const {};
    final out = <String, num>{};
    final refBySym = <String, AssetRef>{};
    for (final s in symbols) {
      final up = s.toUpperCase();
      if (_stableSyms.contains(up)) {
        out[s] = 1;
      } else {
        // A native-coin AssetRef — PriceService resolves it by symbol→coingecko
        // id (chain-agnostic for the mark). BLOCK is intentionally never priced.
        refBySym[s] = AssetRef(chain: '', kind: 'native', symbol: up, decimals: 18);
      }
    }
    if (refBySym.isNotEmpty) {
      try {
        final usd = await _priceSvc.fetchUsd(refBySym.values.toList());
        refBySym.forEach((s, ref) {
          final p = usd[priceKey(ref)];
          if (p != null && p.isFinite && p > 0) out[s] = p;
        });
      } catch (_) {/* best-effort — unresolved symbols skip the tick */}
    }
    return out;
  }

  void _onNotify(AgentNotification n) {
    notifications.insert(0, n);
    if (notifications.length > 20) notifications.removeRange(20, notifications.length);
    // Also surface money events (a realized profit) as an OS banner so the user is
    // told even with the app backgrounded. Fail-soft: no-op until the plugin is
    // initialized, and it never throws. Non-money pings stay in-app only.
    final type = '${n.data['type'] ?? ''}';
    if (type == 'bot_profit' || type == 'realized_profit' || n.data['realizedUsd'] != null) {
      unawaited(LocalNotifications.instance.show(n));
    }
    notifyListeners();
  }

  void _onEvent(Map<String, dynamic> ev) {
    // The 0.05% liquidity fee on every bot trade (paper OR live) → the in-wallet
    // liquidity treasury, keyed by the pair's base coin. Fail-soft.
    if (ev['type'] == 'bot_fee') {
      final coin = '${ev['coin'] ?? ''}';
      final fee = (ev['feeUsd'] as num?)?.toDouble() ?? 0;
      if (coin.isNotEmpty && fee > 0) LiquidityService.instance.takeFee(coin, fee);
    }
    // A risk circuit-breaker (max-drawdown / loss-streak) halted a bot in the
    // engine — revoke its server-side delegation key immediately so a live bot
    // that tripped a guard holds no key while idle (same teardown as pause()).
    if (ev['type'] == 'bot_autohalt' && ev['bot'] != null) {
      final id = '${ev['bot']}';
      unawaited(_delegations.revoke(id));
      _onNotify(AgentNotification(
        title: 'Bot auto-stopped',
        subtitle: 'A risk limit (${ev['reason']}) halted a bot. Review before restarting.',
        tag: 'autohalt:$id',
      ));
    }
    // bot_skip / bot_armed / bot_kill etc. — refresh the surfaces.
    notifyListeners();
  }

  BotRunner get runner => _runner!;

  /// Public nudge so views can re-render after mutating a bot field directly
  /// (e.g. editing a paper bot's allocation before it is armed).
  void refresh() => notifyListeners();

  // ---- reads (pure off persisted bot state) --------------------------------

  List<b.Bot> bots() => _runner?.list() ?? const [];
  Map<String, dynamic>? dashboard(String id) => _runner?.dashboard(id);
  Map<String, dynamic> aggregate() => _runner?.aggregate() ?? {'realizedUsd': 0, 'bots': []};
  b.Bot? bot(String id) => _runner?.get(id);
  bool get killed => _runner?.killed ?? false;

  // ---- create (SIMPLE + ADVANCED) ------------------------------------------

  /// Build a paper + disabled bot from a template, with an optional pair,
  /// allocation cap, and advanced DCA overrides. Returns the created [b.Bot].
  b.Bot createFromTemplate(
    String templateKey, {
    String? pair,
    String? name,
    num allocationUsd = 0,
    Map<String, dynamic>? configOverride,
    String? lane,
    String? riskMode,
    String? profitMode,
    int? pollSec,
  }) {
    final spec = tpl.fromTemplate(templateKey, pair: pair, name: name);
    if (configOverride != null) {
      spec['config'] = {
        ...(spec['config'] as Map).cast<String, dynamic>(),
        ...configOverride,
      };
    }
    spec['allocationUsd'] = allocationUsd;
    if (pollSec != null) spec['pollSec'] = pollSec; // adjustable tick interval
    // "AI picks the pairs" (scanner) is AGGRESSIVE by default: the 'high'
    // discovery gate (smaller, younger tokens) unless the user chose a risk
    // mode, and a per-trade size that scales with the allocation (~1/8 of the
    // cap, min $20) instead of a fixed $20 — so a $500 bot trades $62 clips.
    if (templateKey == 'scan_and_trade') {
      riskMode ??= 'high';
      final cfg = (spec['config'] as Map).cast<String, dynamic>();
      if (configOverride == null || !configOverride.containsKey('perTradeUsd')) {
        cfg['perTradeUsd'] = aggressivePerTradeUsd(allocationUsd);
      }
      spec['config'] = cfg;
    }
    // LANE + RISK MODE: optional; the Bot constructor validates + nulls unknowns
    // and (when a lane is set) pins chainPrefs to that chain. Null = legacy.
    if (lane != null) spec['lane'] = lane;
    if (riskMode != null) spec['riskMode'] = riskMode;
    // PROFIT MODE: optional; the Bot constructor validates + defaults unknowns to
    // 'off' (the legacy fixed cap). 'compound' reinvests realized profit.
    if (profitMode != null) spec['profitMode'] = profitMode;
    final created = _runner!.add(spec);
    _persist();
    notifyListeners();
    return created;
  }

  /// Build a paper + disabled bot from a STRATEGY PLANNER (the 9 indicator
  /// planners + rebalance/momentum) on a specific pair, seeded with the UI-edited
  /// knobs. The strategy's own validateParams clamps every knob at tick time.
  b.Bot createFromStrategy(
    String type, {
    required String pair,
    String? name,
    num allocationUsd = 0,
    Map<String, dynamic>? knobs,
    Map<String, dynamic>? configOverride,
    String? lane,
    String? riskMode,
    String? profitMode,
    int? pollSec,
  }) {
    final spec = tpl.fromStrategy(type, pair: pair, name: name, knobs: knobs);
    if (configOverride != null) {
      spec['config'] = {
        ...(spec['config'] as Map).cast<String, dynamic>(),
        ...configOverride,
      };
    }
    spec['allocationUsd'] = allocationUsd;
    if (pollSec != null) spec['pollSec'] = pollSec; // adjustable tick interval
    if (lane != null) spec['lane'] = lane;
    if (riskMode != null) spec['riskMode'] = riskMode;
    if (profitMode != null) spec['profitMode'] = profitMode;
    final created = _runner!.add(spec);
    _persist();
    notifyListeners();
    return created;
  }

  /// Supported tick intervals (seconds) for the UI picker. 5s is the floor the
  /// scheduler allows; longer intervals cut RPC load + battery for slow strategies.
  static const List<int> pollSecChoices = [5, 15, 30, 60, 300, 900, 3600];

  /// Friendly label for a tick interval in seconds (e.g. 30 → "30s", 3600 → "1h").
  static String tickLabel(int s) =>
      s < 60 ? '${s}s' : (s < 3600 ? '${s ~/ 60}m' : '${s ~/ 3600}h');

  /// Change a bot's tick interval (seconds) live. Clamps to [5, 3600] and
  /// restarts the scheduler so the new cadence takes effect immediately.
  Future<void> setPollSec(String id, int sec) async {
    final bot = _runner?.get(id);
    if (bot == null) return;
    bot.pollSec = sec.clamp(5, 3600);
    await _persist();
    // Re-arm at the new tightest-enabled interval (startScheduler cancels +
    // recreates the timer), so the change applies without a restart.
    if (_runner!.list().any((b) => b.enabled)) _runner!.startScheduler();
    notifyListeners();
  }

  /// Arm a bot in PAPER mode (simulated fills; never broadcasts). Allocation is
  /// not required for paper; when an [allocationUsd] > 0 is given the paper run is
  /// a bounded sandbox the same size as the real one (the budget depletes).
  Future<void> enablePaper(String id, {num? allocationUsd}) async {
    await _runner!.enablePaper(id, allocationUsd: allocationUsd);
    notifyListeners();
  }

  /// Reflect the account's effective Copilot tier (incl. active free trial) into the live-bot
  /// gate. Call whenever subscription state changes (sign-in, IAP purchase, trial start). A
  /// tier other than 'free' unlocks live arming; 'free' re-locks it. Paper/Arena are unaffected.
  void setLiveEntitled(String tier) {
    _liveTier = tier;
    _runner?.setLiveEntitled(tier);
    // Keep the per-plan live-bot cap in sync with the latest account state.
    _liveBotLimit = _mc.agent.liveBotLimit;
    _runner?.setLiveBotLimit(_liveBotLimit);
    notifyListeners();
  }

  // Every tier can run at least one live bot (Free 1 / Alien 3 / Pro ∞) — live
  // access is universal; the paywall gates the bot COUNT (liveBotLimit).
  bool get liveEntitled => true;

  /// The account's current tier slug ('free' / 'copilot' / 'copilot_pro').
  String get tier => _liveTier;

  /// The per-plan live-bot cap in effect (Free 1, Blockle Alien 3, Pro ∞/-1).
  int get liveBotCap => _liveBotLimit;

  /// How many live bots are currently armed + enabled (for the cap display/CTA).
  int get liveBotCount => bots().where((b) => b.mode == 'live' && b.enabled).length;

  /// The opt-in PORTFOLIO-level live-allocation ceiling in USD (§9), or null when
  /// uncapped. Bounds the aggregate committed allocation across ALL live bots —
  /// the per-bot allocation only bounds one bot.
  num? get portfolioLiveCapUsd => _runner?.portfolioLiveCapUsd;

  /// Set (or clear, with null/≤0) the portfolio live cap. Persisted in the bot
  /// store meta so it survives a rebuild/restart, and applied to the live runner.
  Future<void> setPortfolioLiveCap(num? usd) async {
    final v = (usd != null && usd > 0) ? usd : null;
    _runner?.portfolioLiveCapUsd = v;
    if (v == null) {
      _store.meta.remove('portfolioLiveCapUsd');
    } else {
      _store.meta['portfolioLiveCapUsd'] = v;
    }
    await _store.persist();
    notifyListeners();
  }

  /// Total allocation already committed across live+enabled bots (for the cap
  /// "X / cap" display). Reads the per-bot dashboards (committed in USD).
  num liveAllocationInUse() {
    var sum = 0.0;
    for (final bt in bots()) {
      if (bt.mode != 'live' || !bt.enabled) continue;
      final d = _runner?.dashboard(bt.id);
      sum += ((d?['committedUsd'] as num?) ?? 0).toDouble();
    }
    return sum;
  }

  /// The per-plan LIVE-bot cap in effect (Free 1, Copilot 3, Pro -1 = unlimited).
  int get liveBotLimit => _liveBotLimit;

  /// Push an explicit per-plan live-bot cap into the running engine (mirrors the
  /// web wallet's setLiveBotLimit). -1 = unlimited.
  void setLiveBotLimit(int n) {
    _liveBotLimit = n;
    _runner?.setLiveBotLimit(n);
    notifyListeners();
  }

  // ---- strategy picker data (live planners only) ---------------------------

  /// The live-eligible strategy planner names (the 5 originals + the 9 indicator
  /// planners), in a stable display order. scalp/martingale are NOT live and are
  /// absent from the registry, so they can never appear here.
  List<String> get liveStrategyNames {
    const order = [
      'dca', 'grid', 'rebalance', 'momentum', 'arbitrage',
      'rsi', 'macd', 'bollinger', 'breakout', 'emacross',
      'momentum_roc', 'meanrev', 'rebalance_hold', 'hodl',
    ];
    final have = _runner?.strategies.keys.toSet() ?? <String>{};
    final out = [for (final n in order) if (have.contains(n)) n];
    // Append any registered live strategy not in the explicit order (future-proof).
    for (final n in have) {
      if (!out.contains(n)) out.add(n);
    }
    return out;
  }

  /// The INDICATOR-PLANNER allow-list for the create-UI Strategy picker: the 9
  /// single-market planners whose config is a map of simple numeric knobs (seeded
  /// from .defaults). Mirrors the extension's plannerStrategies/isPlannerType gate.
  /// DELIBERATELY EXCLUDES the deal-bots (dca/grid/arbitrage — they keep their own
  /// template create-flow) and the MULTI-ASSET planners (rebalance's config is an
  /// asset->weight map, momentum is SMA-based) — picking any of those from the knob
  /// picker crashes or creates a bot that errors every tick. scalp/martingale are
  /// paper-only and never registered, so they can never appear here either.
  static const List<String> kPlannerStrategyNames = [
    'rsi', 'macd', 'bollinger', 'breakout', 'emacross',
    'momentum_roc', 'meanrev', 'rebalance_hold', 'hodl',
  ];

  /// The indicator-planner names actually registered in the live engine, in the
  /// stable [kPlannerStrategyNames] display order. This is the ONLY list the
  /// Strategy picker may render.
  List<String> get plannerNames {
    final have = _runner?.strategies.keys.toSet() ?? <String>{};
    return [for (final n in kPlannerStrategyNames) if (have.contains(n)) n];
  }

  /// Human help text for a strategy (its planner's describe()), or '' if unknown.
  String strategyDescribe(String name) {
    final s = _runner?.strategies[name];
    try {
      return s?.describe() ?? '';
    } catch (_) {
      return '';
    }
  }

  /// The planner's default knob map (used to seed the create-UI inputs). Empty
  /// when the strategy is not a live planner.
  Map<String, dynamic> strategyDefaults(String name) {
    final s = _runner?.strategies[name];
    try {
      return s != null ? Map<String, dynamic>.from(s.defaults) : <String, dynamic>{};
    } catch (_) {
      return <String, dynamic>{};
    }
  }

  // ---- gated backtest + copy-config (account endpoints) --------------------

  /// Quick-backtest a configured strategy on recent real prices via the account
  /// service. Returns {pnlPct, trades, sells, wins, winRatePct, sharpe, vsHodlPct,
  /// assetMovePct, maxDrawdownPct, curve, ...}. Throws when no account is linked
  /// or the service is unavailable.
  Future<Map<String, dynamic>> backtest({
    required String type,
    required Map<String, dynamic> params,
    required String asset,
  }) async {
    final token = _mc.agent.acctToken;
    if (token == null) {
      throw StateError('Link your blockle.org account to run a backtest.');
    }
    return bc.backtest(_mc.agent.acctOrigin, token,
        type: type, params: params, asset: asset);
  }

  /// Fetch a cloned bot CONFIG (copy-trade) by another trader's bot id. Returns the
  /// bot view {type, pair, params, ...} — CONFIG ONLY, never funds or live state.
  Future<Map<String, dynamic>?> copyBotConfig(String fromBotId) async {
    final token = _mc.agent.acctToken;
    if (token == null) {
      throw StateError('Link your blockle.org account to copy a bot.');
    }
    return bc.copyBot(_mc.agent.acctOrigin, token, fromBotId);
  }

  /// Arm a bot LIVE through the engine's fail-closed gate (BotRunner.armLive):
  /// requires allocationUsd in (0, session cap] and, on mainnet, mainnetEnabled.
  /// The caller MUST have shown the review sheet first; this is the single
  /// confirm action, never a silent flip.
  Future<void> armLive(String id, {required num allocationUsd}) async {
    await _runner!.armLive(id, allocationUsd: allocationUsd);
    // Register an EPHEMERAL, per-active-chain delegation so the server runner can
    // keep this bot trading while the app is closed (Stage 1: lifecycle only, no
    // key leaves the device). Best-effort; signed-out → runs app-open only.
    unawaited(_registerDelegation(id, allocationUsd));
    notifyListeners();
  }

  BotDelegationClient get _delegations => BotDelegationClient(
        origin: 'https://blockle.org',
        bearer: () => _mc.agent.acctToken,
      );

  // EVM lane → chainId + native symbol (for the server runner's price/gate).
  static const _evmChainId = {
    'ethereum': 1, 'base': 8453, 'arbitrum': 42161, 'optimism': 10,
    'polygon': 137, 'bnb': 56, 'avalanche': 43114,
  };
  static const _evmNativeSym = {
    'ethereum': 'ETH', 'base': 'ETH', 'arbitrum': 'ETH', 'optimism': 'ETH',
    'polygon': 'POL', 'bnb': 'BNB', 'avalanche': 'AVAX',
  };

  // A STABLE, high HD index per bot → a dedicated EVM sub-account (so the
  // server's reach is only that one funded sub-account, never the main wallet).
  int _botSubIndex(String botId) {
    var h = 0;
    for (final cu in botId.codeUnits) {
      h = (h * 31 + cu) & 0x7fffffff;
    }
    return 0x40000000 | (h % 0x0fffffff); // high + stable, < 2^31
  }

  /// The dedicated EVM sub-account address a BACKGROUND bot trades from — the
  /// user funds THIS address with the bot's allocation so the server runner can
  /// drip/trade from it (never the main wallet). Null for non-EVM lanes,
  /// imported/locked wallets, or if derivation fails. Pure (no network).
  String? backgroundFundingAddress(String botId) {
    final bot = _runner?.get(botId);
    if (bot == null) return null;
    const laneToChain = {'bsc': 'bnb'};
    final lane = bot.lane;
    final chain = (lane != null && lane.isNotEmpty) ? (laneToChain[lane] ?? lane) : 'ethereum';
    if (!_evmChainId.containsKey(chain)) return null;
    final mn = _mc.vault.plaintext?.mnemonic;
    if (mn == null || mn.isEmpty) return null;
    try {
      return wx.evmKey(wx.fromMnemonic(mn).seed, _botSubIndex(botId)).address;
    } catch (_) {
      return null;
    }
  }

  Future<void> _registerDelegation(String id, num capUsd) async {
    final bot = _runner?.get(id);
    if (bot == null) return;
    const laneToChain = {'bsc': 'bnb'};
    final lane = bot.lane;
    final chain = (lane != null && lane.isNotEmpty) ? (laneToChain[lane] ?? lane) : 'ethereum';
    final chainId = _evmChainId[chain];
    final mn = _mc.vault.plaintext?.mnemonic;

    // AUTOPILOT (scanner / "AI picks the pairs"): the discovery feed is Solana
    // SPL tokens, so delegate a dedicated SOLANA sub-account key + a SNIPER plan.
    // The server picks the top safety-screened token each tick and buys it via
    // Jupiter — all under the mainnet + cap + sender gates (executeTrade). The
    // sub-account must be funded with USDC. Server refuses the key until mainnet.
    if (bot.type == 'scanner' && mn != null && mn.isNotEmpty) {
      try {
        final seed = wx.fromMnemonic(mn).seed;
        final subAddr = wx.solanaKey(seed, _botSubIndex(id)).address;
        final subSeedHex = wx.solanaSubSeedHex(seed, _botSubIndex(id));
        // AGGRESSIVE autopilot sizing: ~1/8 of the cap per buy (min $5), a
        // 15-minute cadence, the template's sniper gate (0.45) and enough
        // slippage headroom for thin microcap pools (>= 150 bps).
        final cfgSlip = (bot.config['slippageBps'] as num?)?.toInt() ?? 150;
        final plan = {
          'type': 'sniper',
          'perTradeUsd': (capUsd / 8).clamp(5, capUsd),
          'sniperMinScore': (bot.config['sniperMinScore'] as num?) ?? 0.45,
          'slippageBps': cfgSlip < 150 ? 150 : cfgSlip,
          'intervalMs': 15 * 60 * 1000,
        };
        await _delegations.register(
          botId: id, chain: 'solana', capUsd: capUsd,
          address: subAddr, key: subSeedHex, plan: plan,
        );
        return;
      } catch (_) {
        // fall through to the metadata-only registration below
      }
    }

    // Non-EVM lane, imported/locked wallet, or unknown chain → Stage-1
    // metadata-only (no key leaves the device).
    if (chainId == null || mn == null || mn.isEmpty) {
      String? address;
      try {
        address = (await _mc.addressFor(chain))?.address;
      } catch (_) {}
      await _delegations.register(botId: id, chain: chain, capUsd: capUsd, address: address);
      return;
    }

    // EVM background: delegate a DEDICATED sub-account key (not the main key) +
    // a DCA-drip plan. The server REFUSES to store a mainnet key until the
    // operator flips mainnet on, so this only enables background on testnet /
    // after go-live. The sub-account must be funded with the allocation.
    try {
      final seed = wx.fromMnemonic(mn).seed;
      final sub = wx.evmKey(seed, _botSubIndex(id)); // dedicated hot sub-account
      final main = wx.evmKey(seed, 0).address; // trades/drips settle into the main acct
      final plan = _planForBot(bot, chain, main, capUsd);
      await _delegations.register(
        botId: id, chain: chain, capUsd: capUsd,
        address: sub.address, chainId: chainId, key: sub.privateKey, plan: plan,
      );
    } catch (_) {
      await _delegations.register(botId: id, chain: chain, capUsd: capUsd);
    }
  }

  // The wrapped-native token symbol per EVM chain — buying it with native would
  // just be a wrap, so a bot targeting it (or the native coin) drips instead.
  static const _wrappedNativeSym = {
    'ethereum': {'WETH'}, 'base': {'WETH'}, 'arbitrum': {'WETH'}, 'optimism': {'WETH'},
    'polygon': {'WPOL', 'WMATIC'}, 'bnb': {'WBNB'}, 'avalanche': {'WAVAX'},
  };

  /// Build the server-runner PLAN for a live EVM bot.
  ///
  /// When the bot targets a concrete ERC-20 (its pair's base asset, resolved to a
  /// known token on this chain), emit a 'swap' plan so the server actually TRADES
  /// on-chain: native → tokenOut via Uniswap V3, each drip sized at ~1/20 of the
  /// cap, with a slippage floor (an underfilled swap reverts) and the tokens
  /// landing in the main account. When the target is the native coin / its
  /// wrapped form / an unknown token, fall back to the native DCA-drip (safe
  /// accumulate into main — never routes funds into an unverified contract).
  /// Mainnet execution is still gated server-side (cap + sender + mainnet flag).
  Map<String, dynamic> _planForBot(b.Bot bot, String chain, String mainAddr, num capUsd) {
    final nativeSym = _evmNativeSym[chain] ?? 'ETH';
    final perTradeUsd = (capUsd / 20).clamp(1, capUsd); // ~20 drips across the cap
    final dca = {
      'type': 'dca', 'to': mainAddr, 'sym': nativeSym,
      'perTradeUsd': perTradeUsd, 'intervalMs': 3600000,
    };

    // The base asset the bot accumulates (config market wins, else first pair).
    String? base;
    final m = bot.config['market'];
    if (m is String && m.contains('/')) base = m.split('/')[0].trim().toUpperCase();
    final ps = bot.pairs();
    if (base == null && ps.isNotEmpty && ps.first.contains('/')) {
      base = ps.first.split('/')[0].trim().toUpperCase();
    }
    if (base == null || base.isEmpty) return dca;

    // Native or wrapped-native target → drip (buying WETH with ETH is pointless).
    final wrapped = _wrappedNativeSym[chain] ?? const <String>{};
    if (base == nativeSym || wrapped.contains(base)) return dca;

    // Resolve the base to a KNOWN ERC-20 on this chain (curated addresses only).
    AssetRef? tok;
    for (final t in _mc.registry.tokensFor(chain)) {
      if (t.kind == 'erc20' && t.address != null && t.symbol.toUpperCase() == base) {
        tok = t;
        break;
      }
    }
    if (tok == null) return dca; // unknown token → never route to an unverified contract

    final slip = (bot.config['slippageBps'] as num?)?.toInt() ?? 100; // default 1%
    return {
      'type': 'swap',
      'to': mainAddr, // bought tokens settle into the main account
      'tokenOut': tok.address,
      'tokenOutSym': tok.symbol.toUpperCase(),
      'tokenOutDecimals': tok.decimals,
      'slippageBps': slip.clamp(1, 5000),
      'feeTier': 3000, // 0.3% V3 pool — the server reverts if the route can't fill
      'perTradeUsd': perTradeUsd,
      'intervalMs': 3600000,
    };
  }

  Future<void> pause(String id) async {
    await _runner!.pause(id);
    // Bot stopped → revoke its server delegation immediately (key, once Stage 2
    // holds one, is wiped the moment the bot is no longer running).
    unawaited(_delegations.revoke(id));
    notifyListeners();
  }

  /// Clone a bot's RECIPE (via the template export/import) — lands a fresh
  /// paper + disabled + testnet bot with zero allocation. Never auto-armed.
  b.Bot clone(String id) {
    final src = _runner!.get(id);
    if (src == null) throw ArgumentError('unknown bot: $id');
    final imported = tpl.importTemplate(tpl.exportBot(src));
    imported.name = '${src.name} (copy)';
    final created = _runner!.add(imported);
    _persist();
    notifyListeners();
    return created;
  }

  /// Stop a bot: pause it (disable). Open deals are preserved and resume on the
  /// next tick when re-enabled.
  Future<void> stop(String id) => pause(id);

  /// Permanently remove a bot from the store AND the UI. Delegates to the runner
  /// so the scheduler stops when the last enabled bot is gone.
  Future<void> remove(String id) async {
    await _runner!.remove(id);
    unawaited(_delegations.revoke(id));
    notifyListeners();
  }

  /// Advance every ENABLED bot one tick (paper simulates at the quote; live
  /// routes through the gate). A no-op skip when no market data is available.
  Future<List<Map<String, dynamic>>> tick() async {
    if (_runner == null) return const [];
    final out = await _runner!.tickAll();
    notifyListeners();
    return out;
  }

  // ---- KILL (§5): the runner kill — stops all bots, cancels open orders, and
  // locks the vault (policy.kill wipes decrypted keys + the LLM credential). ----
  Future<void> killAll([String? reason]) async {
    await _runner!.killAll(reason ?? 'user kill-all');
    // Kill-all → revoke EVERY server delegation at once.
    unawaited(_delegations.revokeAll());
    notifyListeners();
  }

  Future<void> _persist() async {
    try {
      await _store.persist();
    } catch (_) {}
  }

  // ---- Arena (PLAY) --------------------------------------------------------

  List<String> get arenaScenarios => ar.kScenarios;
  String get arenaDisclaimer => ar.kDisclaimer;
  bool get hasCanonicalVectors => _vectors != null;

  /// The price path for [scenario] — the canonical fixture series when bundled,
  /// else the deterministic live generator (§9 non-canonical variety).
  List<double> scenarioPath(String scenario) {
    if (_vectors != null) {
      try {
        return ar
            .pricePath(_vectors!, scenario)
            .map((e) => e.toDouble())
            .toList();
      } catch (_) {}
    }
    return ar
        .generatePath(scenario, seed: scenario.hashCode & 0x7fffffff)
        .map((e) => e.toDouble())
        .toList();
  }

  /// Run a bot config over a scenario (PURE sim; no gate, no broadcast, no keys).
  /// Uses the canonical fixture paths when bundled, else the live generator.
  Map<String, dynamic> runArena({
    required String type,
    required Map<String, dynamic> config,
    required String pair,
    required String scenario,
    String? name,
  }) {
    final opts = <String, dynamic>{
      'bot': {'type': type, 'config': config, 'pair': pair, 'name': name},
      'scenario': scenario,
      'name': name,
    };
    if (_vectors != null) {
      opts['vectors'] = _vectors;
    } else {
      opts['prices'] = ar.generatePath(scenario, seed: scenario.hashCode & 0x7fffffff);
    }
    final summary = arena.run(opts);
    notifyListeners();
    return summary;
  }

  /// Fetch the current REAL USD mark for [base] from the SAME live market feed the
  /// live bots + scanner use (ctx.prices / the non-custodial Exchange). Returns
  /// null when the market has no data — NEVER a synthetic value; the Arena live
  /// tick then skips (shows "awaiting data"), it never invents a price.
  Future<num?> liveMark(String base) async {
    final up = base.toUpperCase();
    try {
      final p = await _prices([up]);
      final v = p[up];
      if (v != null && v.isFinite && v > 0) return v;
    } catch (_) {}
    return null;
  }

  /// LIVE MARKET Arena run (§9): tick the strategy on the accumulated REAL [marks]
  /// with PLAY balances. PURE sim — no gate, no broadcast, no keys, no real funds
  /// (zero real value, so no gate is needed). A null/<=0 mark is skipped (awaiting
  /// data); a price is NEVER fabricated.
  ar.ArenaResult runArenaLive({
    required String type,
    required Map<String, dynamic> config,
    required String pair,
    required List<num?> marks,
    String? name,
  }) {
    return ar.runLive({
      'bot': {'type': type, 'config': config, 'pair': pair, 'name': name},
      'marks': marks,
    });
  }

  /// Export the Arena strategy and import it as a REAL bot — the one honest
  /// on-ramp. ALWAYS lands paper + disabled + testnet with zero allocation.
  b.Bot useForReal({
    required String type,
    required Map<String, dynamic> config,
    required String pair,
    String? name,
  }) {
    final bot = ar.useForReal({
      'type': type,
      'config': config,
      'pair': pair,
      'name': name,
    });
    final created = _runner!.add(bot);
    _persist();
    notifyListeners();
    return created;
  }
}

/// Per-trade size for the aggressive "AI picks" autopilot: ~1/8 of the
/// allocation, never below 20 USD (and never above the allocation itself when
/// the allocation is smaller than that). Pure — unit-tested.
num aggressivePerTradeUsd(num allocationUsd) {
  if (!(allocationUsd > 0)) return 20;
  final eighth = allocationUsd / 8;
  final sized = eighth < 20 ? 20 : eighth;
  final capped = sized > allocationUsd ? allocationUsd : sized;
  return (capped * 100).roundToDouble() / 100;
}
