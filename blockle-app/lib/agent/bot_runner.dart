// agent/bot_runner.dart — the BotRunner (Dart port of
// blockle-extension/agent/bot-runner.js): ticks enabled bots, runs their deal-
// engine state machines (bots.dart), and routes every LIVE order through the
// SAME value-moving dispatch as the NL runner and the StrategyRunner (runner.dart
// dispatchValueMoving). There is exactly ONE commit path — no second broadcast
// path exists. See docs/BLOCKLE-BOTS.md §2-6.
//
// THE FULLY-AUTO-WITHIN-ALLOCATION GATE (§5), made non-bypassable:
//   • `allocationUsd` is a hard per-bot cap enforced by a per-bot committed-spend
//     ledger (bot.state.committedUc) IN ADDITION to the policy session/per-asset
//     caps — the tighter bound wins. A live BUY that would push cumulative live
//     spend over allocationUsd is NOT auto-approved and NOT prompted: it simply
//     does not fire (audited `skipped: allocation`). Accrual is BigInt-exact and
//     only counts orders that actually broadcast.
//   • Arming a LIVE bot REQUIRES allocationUsd > 0 AND <= the policy session USD
//     cap (fail-closed otherwise).
//   • Auto-approve reuses the EXISTING policy.autoApproveUnderUsd, which the runner
//     sets to the bot's REMAINING allocation around each dispatch — so "auto within
//     allocation" is the ONE gate, not a new path. Above remaining allocation the
//     policy falls back to its normal confirm (fail-closed with no handler).
//   • Caps, allowlist, kill, hash-chained audit, the 0.05% fee, and the mainnet
//     gate (default off) are NEVER skipped. Bots default paper + disabled + testnet.
//   • PAPER mode simulates fills at the ctx quote: it does NOT broadcast, does NOT
//     call the gate, and does NOT consume allocation — it records a simulated deal
//     + pnl tagged `paper`.
//   • No synthetic prices: a missing mark skips the tick (audited `skipped: price`).

import 'dart:async';

import 'bots.dart' as b;
import 'notify.dart' show AgentNotifier, AgentNotification, formatUsd;
import 'pnl.dart' show PnlHook;
import 'policy.dart';
import 'runner.dart' show dispatchValueMoving, DispatchOutcome;
import 'scanner.dart' show AgentScanner, ScanIntent, ScanResult;
import 'strategies.dart' show StrategyContext, Strategy, defaultStrategies;
import 'tools.dart' show ToolRegistry;
import '../multichain/venues.dart' show chooseRoute;

const Map<String, int> _stableUsd = {
  'USDC': 1, 'USDT': 1, 'DAI': 1, 'USD': 1, 'USDBC': 1, 'PYUSD': 1,
};

/// READ-ONLY accessors the BotRunner needs. Every field is an injected closure so
/// the runner stays pure + testable. Deal bots use [now]/[network]/[prices];
/// scheduled bots (rebalance/momentum) reuse the strategy planners via
/// [strategyCtx]. There is NO commit path here.
class BotContext {
  final int Function()? now;
  final String Function()? network;
  final Future<Map<String, num>> Function(List<String> symbols)? prices;

  /// Candidate feed for signal bots (§7). Duck-typed `{ scan() }` — a [Discovery]
  /// or a test fake. READ-ONLY; never trades or auto-allowlists.
  final dynamic discovery;

  /// The strategy READ-ONLY context for scheduled bots (rebalance/momentum).
  final StrategyContext? strategyCtx;

  /// Candidate universe feed for the scanner (scan-&-trade autopilot) — the
  /// discovery feed ∪ exchange markets ∪ connected venue pairs, enriched with
  /// venue prices/history/book. READ-ONLY; `config` is the bot's config.
  final Future<List<dynamic>> Function([Map<String, dynamic>? config])? scanUniverse;

  /// LEVER 1+2 AT DISPATCH (optional): resolve the cheapest fillable venue for a
  /// swap. Returns route descriptors ({id, feeBps, gasUsd, notionalUsd,
  /// priceImpactBps, internal, canFill}) fed to the shared Venues.chooseRoute —
  /// the internal Blockle rail is preferred when it can ACTUALLY fill the
  /// pair+size (never assumed). With no resolver wired the bot's configured venue
  /// is used unchanged, so every existing dispatch path behaves exactly as before.
  final Future<List<dynamic>> Function(
      {required String from,
      required String to,
      num? sizeUsd,
      String? chain,
      String? bot})? routeCandidates;

  const BotContext(
      {this.now,
      this.network,
      this.prices,
      this.discovery,
      this.strategyCtx,
      this.scanUniverse,
      this.routeCandidates});
}

class BotRunner {
  final Policy policy;
  final ToolRegistry tools;
  final dynamic audit;
  final BotContext ctx;
  final bool mainnetEnabled;
  /// Live trading is a paid feature (Blockle Copilot tier or the free trial). Fail-closed:
  /// false until [setLiveEntitled] is called with the account's effective tier. Paper/Arena
  /// are unaffected. Mutable because subscription state changes at runtime.
  bool liveEntitled;
  /// Per-plan LIVE-bot cap (Free 1, Copilot 3, Pro -1 = unlimited). The host sets
  /// it from the account's sub.liveBotLimit; -1 preserves legacy (uncapped)
  /// behavior. Counted at arm time against OTHER already-live+enabled bots.
  int liveBotLimit;
  /// Optional PORTFOLIO-level live-allocation ceiling in USD (§9). null/≤0 =
  /// uncapped (default). When set, armLive refuses a bot whose allocation, added
  /// to the remaining allocation of all other live bots, would exceed it. Host-
  /// settable at runtime (persisted in the bot store meta).
  num? portfolioLiveCapUsd;
  /// When true, [startScheduler] fires one tick immediately so a freshly-enabled
  /// bot acts right away instead of waiting a full poll interval. The host (the
  /// production controller) enables it; tests leave it off and drive ticks.
  final bool immediateFirstTick;
  /// Whether THIS (client-side) runner executes live orders itself. True when a
  /// real value-moving channel backs it (legacy in-app path). False when live
  /// execution is delegated to the SERVER runner (the default now that the
  /// in-app agent channel is gone) — the client then only registers the
  /// delegation and does NOT tick-execute live bots locally (no double-trade,
  /// and the stuck-bot auto-pause never fires on a server-run bot). Paper bots
  /// always run locally regardless.
  bool clientExecutesLive;

  /// KEEP-GAS (optional host hook): async check "is the native gas balance on
  /// [lane] running low?". When wired, a LIVE bot automatically converts a small
  /// slice of realized profit into the lane's native coin through the SAME gated
  /// dispatch, so it can never strand itself unable to pay network fees.
  /// Null (default) = feature inert — the engine stays pure for tests.
  final Future<bool> Function(String lane)? lowGasCheck;
  final void Function(Map<String, dynamic> ev)? onEvent;
  final PnlHook? pnl;
  /// Surface a pop-up whenever a bot REALIZES profit — in paper OR live, in ANY
  /// profit currency. The PnlHook only pops on a live STABLECOIN exit, so paper
  /// profit and base-currency (SOL/ETH) profit would otherwise be invisible. This
  /// fires on the realized-gain DELTA each tick (closed deals + open grid rungs),
  /// deduped via bot.state['_notifiedRealizedUc']. Carries only public figures.
  final AgentNotifier? notifier;
  final b.BotStore store;
  final dynamic discovery;
  final String wallet;
  final String channel;
  final Map<String, Strategy> strategies;
  bool _killed = false;

  // Transient last-seen USD mark per base symbol, captured each tick from the
  // SAME real marks the engine trades on (ctx.prices). Fed to [dashboard] so an
  // OPEN deal's unrealized P&L is shown live instead of "awaiting market data".
  // Intentionally NOT persisted: a mark is only "current" within a running
  // session — after a restart the first tick (~1s) repopulates it, so a stale
  // number is never presented as the live price (docs/BLOCKLE-BOTS.md §4/§5).
  final Map<String, num> _lastMarks = {};

  // ---- background scheduler ------------------------------------------------
  // A real bot RUNS: once a bot is enabled/armed the scheduler ticks every
  // ENABLED bot on its pollSec. Without this nothing would ever advance a deal.
  // Injectable timer factory so tests drive it deterministically (no real clock).
  final Timer Function(Duration interval, void Function() onTick)? _timerFactory;
  Timer? _schedulerTimer;
  bool _ticking = false;

  BotRunner({
    required this.policy,
    required this.tools,
    this.audit,
    BotContext? ctx,
    this.mainnetEnabled = false,
    this.liveEntitled = false,
    this.liveBotLimit = -1,
    this.portfolioLiveCapUsd,
    this.clientExecutesLive = true,
    this.immediateFirstTick = false,
    this.lowGasCheck,
    this.onEvent,
    this.pnl,
    this.notifier,
    b.BotStore? store,
    dynamic persist,
    dynamic discovery,
    String? wallet,
    String? channel,
    Map<String, Strategy>? strategies,
    Timer Function(Duration interval, void Function() onTick)? timerFactory,
  })  : ctx = ctx ?? const BotContext(),
        _timerFactory = timerFactory,
        wallet = wallet ?? 'default',
        channel = channel ?? 'default',
        strategies = strategies ?? defaultStrategies(),
        store = store ?? b.BotStore(store: persist, wallet: wallet, channel: channel),
        discovery = discovery ?? ctx?.discovery;

  void emit(Map<String, dynamic> ev) {
    if (onEvent != null) {
      try {
        onEvent!(ev);
      } catch (_) {}
    }
  }

  Future<void> _audit(Map<String, dynamic> rec) async {
    if (audit != null) {
      try {
        await audit.record(rec);
      } catch (_) {}
    }
  }

  bool _allowed(String name) {
    try {
      policy.checkAllowed(name);
      return true;
    } catch (_) {
      return false;
    }
  }

  // ---- background scheduler -----------------------------------------------
  bool get schedulerRunning => _schedulerTimer != null;

  /// The scheduler interval: the tightest ENABLED-bot pollSec (min 1s), else 60s.
  Duration _pollInterval() {
    final en = store.enabled();
    if (en.isEmpty) return const Duration(seconds: 60);
    var sec = en.map((x) => x.pollSec).reduce((a, c) => a < c ? a : c);
    if (sec < 1) sec = 1;
    return Duration(seconds: sec);
  }

  /// Start (or restart) the background scheduler. Idempotent; a no-op once killed
  /// or when no bot is enabled. Called whenever a bot is enabled/armed so a
  /// running bot is actually ticked.
  void startScheduler() {
    if (_killed) return;
    if (store.enabled().isEmpty) return;
    _schedulerTimer?.cancel();
    final interval = _pollInterval();
    void onFire() {
      if (_killed || store.enabled().isEmpty) {
        stopScheduler();
        return;
      }
      if (_ticking) return; // never overlap ticks
      _ticking = true;
      // WATCHDOG: never let a slow/hung tick latch _ticking forever (which would
      // freeze every future tick and make the bot look permanently stuck). A tick
      // that runs past 45s is abandoned for scheduling purposes; the latch releases
      // and the next interval tries again. The HTTP calls have their own 10-12s
      // timeouts; this is the last-resort backstop.
      tickAll()
          .timeout(const Duration(seconds: 45),
              onTimeout: () => const <Map<String, dynamic>>[])
          .whenComplete(() {
        _ticking = false;
        emit({'type': 'bot_tick'});
      });
    }

    final factory = _timerFactory;
    _schedulerTimer = factory != null
        ? factory(interval, onFire)
        : Timer.periodic(interval, (_) => onFire());
    // Fire the FIRST tick NOW so a freshly-enabled bot opens its deal / places
    // its base order immediately instead of waiting a full interval (up to a
    // minute by default). Opt-in (the host sets it in production); tests drive
    // ticks explicitly and leave it off so their assertions see a clean tick.
    if (immediateFirstTick) onFire();
  }

  /// Stop the background scheduler (no more automatic ticks).
  void stopScheduler() {
    _schedulerTimer?.cancel();
    _schedulerTimer = null;
  }

  // ---- bot lifecycle ------------------------------------------------------
  b.Bot add(dynamic spec) => store.add(spec);
  b.Bot? get(String id) => store.get(id);
  List<b.Bot> list() => store.list();

  /// Permanently delete a bot from the store. Stops the scheduler when the last
  /// enabled bot is gone. Returns true when a bot was actually removed.
  Future<bool> remove(String id) async {
    final existed = store.remove(id);
    if (existed) {
      await store.persist();
      if (store.enabled().isEmpty) stopScheduler();
      emit({'type': 'bot_removed', 'bot': id});
    }
    return existed;
  }

  /// Host hook: reflect the account's effective entitlement (paid tier OR active free trial).
  /// [tier] is the server's entitledTier ('free' | 'copilot' | 'copilot_pro'); anything other
  /// than free/empty unlocks live arming. Does not touch already-armed bots.
  bool setLiveEntitled(String? tier) {
    liveEntitled = tier != null && tier.isNotEmpty && tier != 'free';
    return liveEntitled;
  }

  /// Host hook: reflect the account's per-plan LIVE-bot cap (sub.liveBotLimit).
  /// null -> -1 (uncapped). Does not touch already-armed bots.
  int setLiveBotLimit(int? n) {
    liveBotLimit = n ?? -1;
    return liveBotLimit;
  }

  /// Arm a bot LIVE (§5). Fail-closed: requires a finite allocationUsd in (0, sessionCap].
  Future<b.Bot> armLive(String id, {num? allocationUsd}) async {
    final bot = store.get(id);
    if (bot == null) throw ArgumentError('unknown bot: $id');
    if (!liveEntitled) {
      await _audit({'type': 'bot_arm_refused', 'bot': id, 'reason': 'subscription required'});
      throw StateError('Live trading requires Blockle Alien. Start your free trial or subscribe to go live.');
    }
    final alloc = allocationUsd != null ? allocationUsd.toDouble() : bot.allocationUsd;
    final sessionCap = policy.caps.sessionUsd;
    if (!(alloc > 0)) {
      await _audit({'type': 'bot_arm_refused', 'bot': id, 'reason': 'allocationUsd must be > 0'});
      throw StateError('cannot arm live: allocationUsd must be > 0 (fail-closed)');
    }
    if (sessionCap == null) {
      await _audit({'type': 'bot_arm_refused', 'bot': id, 'reason': 'no policy session USD cap set'});
      throw StateError('cannot arm live: a policy session USD cap is required (fail-closed)');
    }
    if (!(alloc <= sessionCap)) {
      await _audit({'type': 'bot_arm_refused', 'bot': id, 'reason': 'allocationUsd > session cap'});
      throw StateError(
          'cannot arm live: allocationUsd ($alloc) exceeds the policy session cap (\$$sessionCap)');
    }
    if (bot.network == 'mainnet' && !mainnetEnabled) {
      await _audit({'type': 'bot_arm_refused', 'bot': id, 'reason': 'mainnet disabled'});
      throw StateError('cannot arm live on mainnet: set mainnetEnabled=true (operator sign-off)');
    }
    // PORTFOLIO-LEVEL live exposure cap (§9, opt-in). The per-bot allocation
    // bounds ONE bot; this bounds the AGGREGATE across every live bot. Sum the
    // remaining (unspent) allocation of OTHER live+enabled bots + this bot's new
    // allocation; refuse if it would exceed the configured portfolio ceiling.
    // null => uncapped (legacy behavior, nothing changes).
    final portCap = portfolioLiveCapUsd;
    if (portCap != null && portCap > 0) {
      var othersRemainingUc = BigInt.zero;
      for (final x in store.list()) {
        if (x.id == id || x.mode != 'live' || !x.enabled) continue;
        final rem = _effectiveCapUc(x) - ((x.state['committedUc'] as BigInt?) ?? BigInt.zero);
        if (rem > BigInt.zero) othersRemainingUc += rem;
      }
      final wantUc = othersRemainingUc + b.microUsd(alloc);
      if (wantUc > b.microUsd(portCap)) {
        final inUseUsd = b.ucToUsd(othersRemainingUc) ?? 0;
        await _audit({
          'type': 'bot_arm_refused', 'bot': id, 'reason': 'portfolio cap',
          'portfolioCapUsd': portCap, 'othersRemainingUsd': inUseUsd, 'wantUsd': alloc,
        });
        throw StateError(
            'Portfolio live cap reached: \$${inUseUsd.toStringAsFixed(0)} already committed across live bots '
            '+ \$${alloc.toStringAsFixed(0)} here would exceed your \$${portCap.toStringAsFixed(0)} ceiling. '
            'Lower the allocation, pause a live bot, or raise the cap.');
      }
    }
    // Per-plan LIVE-bot cap (Free 1 / Copilot 3 / Pro unlimited). Count OTHER
    // already-live+enabled bots; -1 = uncapped. Mirrors the web runner.
    if (liveBotLimit >= 0) {
      final liveNow =
          store.list().where((x) => x.id != id && x.mode == 'live' && x.enabled).length;
      if (liveNow >= liveBotLimit) {
        await _audit({'type': 'bot_arm_refused', 'bot': id, 'reason': 'live bot limit reached', 'limit': liveBotLimit});
        // Point at the NEXT tier: Free (1) → Blockle Alien, Alien (3) → Alien Pro.
        final nextTier = liveBotLimit <= 1 ? 'Blockle Alien' : 'Blockle Alien Pro';
        throw StateError(
            'You\'re running your plan\'s $liveBotLimit live bot${liveBotLimit == 1 ? '' : 's'}. '
            'Upgrade to $nextTier to run more.');
      }
    }
    bot.allocationUsd = alloc;
    bot.mode = 'live';
    bot.enabled = true;
    bot.state['haltReason'] = null; // a fresh arm clears any prior risk halt
    bot.state['lastError'] = null;
    bot.state['_consecErrors'] = 0;
    await _audit({'type': 'bot_armed', 'bot': id, 'mode': 'live', 'allocationUsd': alloc, 'network': bot.network});
    emit({'type': 'bot_armed', 'bot': id, 'mode': 'live', 'allocationUsd': alloc});
    await store.persist();
    startScheduler(); // a running bot is actually ticked
    return bot;
  }

  Future<b.Bot> enablePaper(String id, {num? allocationUsd}) async {
    final bot = store.get(id);
    if (bot == null) throw ArgumentError('unknown bot: $id');
    // Optional paper BUDGET: when provided (>0) it bounds cumulative paper spend
    // exactly like the live allocation cap — a sandbox the same size as the real
    // one. Omitted -> unbounded paper (legacy/arena behavior, allocationUsd stays 0).
    if (allocationUsd != null && allocationUsd.toDouble() > 0) {
      bot.allocationUsd = allocationUsd.toDouble();
    }
    bot.mode = 'paper';
    bot.enabled = true;
    bot.state['haltReason'] = null; // a fresh start clears any prior risk halt
    bot.state['lastError'] = null;
    bot.state['_consecErrors'] = 0;
    await _audit({'type': 'bot_armed', 'bot': id, 'mode': 'paper', 'allocationUsd': bot.allocationUsd});
    await store.persist();
    startScheduler(); // a running bot is actually ticked
    return bot;
  }

  /// Per-bot STOP: truly halt a single bot. Disables it (the scheduler skips it),
  /// persists, and stops the scheduler when it was the last enabled bot.
  Future<b.Bot?> pause(String id) async {
    final bot = store.get(id);
    if (bot != null) {
      bot.enabled = false;
      await _audit({'type': 'bot_paused', 'bot': id});
      await store.persist();
      if (store.enabled().isEmpty) stopScheduler();
    }
    return bot;
  }

  // ---- KILL (§5): stop ALL bots, best-effort cancel open orders, lock vault --
  Future<void> killAll([String? reason]) async {
    _killed = true;
    stopScheduler(); // no more automatic ticks — every bot is halting now
    for (final bot in store.list()) {
      bot.enabled = false;
      if (bot.mode == 'live') {
        try {
          await _cancelOpenOrders(bot);
        } catch (_) {}
      }
    }
    await _audit({'type': 'bot_kill', 'reason': reason ?? 'user', 'bots': store.list().length});
    emit({'type': 'bot_kill', 'reason': reason ?? 'user'});
    // policy.kill wipes decrypted keys + the LLM credential and locks the vault.
    await policy.kill(reason ?? 'bot kill');
    await store.persist();
  }

  Future<void> _cancelOpenOrders(b.Bot bot) async {
    final tool = tools.get('cancel_order');
    if (tool == null || !_allowed('cancel_order')) return;
    // Route cancels through the ONE shared value-moving dispatch (the SAME audited
    // commit routine every order uses) — NOT a bare prepare().commit() second path.
    // Best-effort: a failed cancel never blocks the kill (which locks the vault next).
    final remainingUc = b.microUsd(bot.allocationUsd) - ((bot.state['committedUc'] as BigInt?) ?? BigInt.zero);
    final envelope = remainingUc > BigInt.zero ? remainingUc : b.microUsd(bot.allocationUsd);
    final byPair = (bot.state['byPair'] as Map?) ?? const {};
    for (final pair in byPair.keys) {
      final ps = byPair[pair] as Map?;
      final deal = ps?['deal'] as Map?;
      final levels = deal?['levels'] as List?;
      for (final lv in (levels ?? const [])) {
        if (lv is Map && lv['orderId'] != null) {
          try {
            await _dispatch(bot, 'cancel_order', {'orderId': lv['orderId']}, envelope);
          } catch (_) {}
        }
      }
    }
  }

  // ---- read helpers -------------------------------------------------------
  bool _ctxMainnet() {
    try {
      return ctx.network != null && ctx.network!() == 'mainnet';
    } catch (_) {
      return false;
    }
  }

  Future<Map<String, num>> _prices(List<String> symbols) async {
    try {
      if (ctx.prices == null) return {};
      return await ctx.prices!(symbols);
    } catch (_) {
      return {};
    }
  }

  BigInt? _unitUc(Map<String, num> prices, String sym) {
    final v = prices[sym];
    if (v != null && v.isFinite && v > 0) return b.microUsd(v);
    final s = _stableUsd[sym.toUpperCase()];
    if (s != null) return b.microUsd(s);
    return null; // no synthetic price
  }

  int _now() => (ctx.now != null ? ctx.now!() : DateTime.now().millisecondsSinceEpoch);

  // The EFFECTIVE deploy cap (micro-dollars) for a bot's BUY gates.
  //   off / take → the fixed budget, microUsd(allocationUsd) — byte-for-byte the
  //                legacy cap (the deterministic fixtures all run here).
  //   compound   → budget + the bot's POSITIVE cumulative realized profit. Gains
  //                raise the cap so the next orders can be larger (reinvested);
  //                losses (realized <= 0) floor it at the budget so the cap NEVER
  //                drops below the budget and NEVER pulls from the wallet.
  BigInt _effectiveCapUc(b.Bot bot) {
    final base = b.microUsd(bot.allocationUsd);
    if (bot.profitMode == 'compound') {
      final r = (bot.state['realizedUc'] as BigInt?) ?? BigInt.zero;
      return r > BigInt.zero ? base + r : base;
    }
    return base;
  }

  // ===========================================================================
  // tick
  // ===========================================================================
  Future<List<Map<String, dynamic>>> tickAll() async {
    final out = <Map<String, dynamic>>[];
    for (final bot in store.enabled()) {
      out.add(await tickBot(bot.id));
    }
    return out;
  }

  Future<Map<String, dynamic>> tickBot(String id) async {
    final bot = store.get(id);
    if (bot == null) throw ArgumentError('unknown bot: $id');
    if (_killed || !bot.enabled) return {'bot': bot.id, 'skipped': 'disabled'};
    policy.assertLive();
    final now = _now();
    bot.state['lastTickAt'] = now;

    // SERVER-MANAGED LIVE: when this client runner has no local value-moving
    // executor, a LIVE bot is run by the server-side runner (via the delegation
    // the controller registered). The client must NOT tick-execute it — doing so
    // would either double-trade (if it could) or, with empty fallback tools,
    // reject every tick and trip the stuck-bot auto-pause against a bot that is
    // actually trading fine server-side. Keep lastTickAt fresh for liveness and
    // no-op. Paper bots always run locally.
    if (bot.mode == 'live' && !clientExecutesLive) {
      return {'bot': bot.id, 'serverManaged': true};
    }

    Map<String, dynamic> report;
    try {
      if (b.kScheduledTypes.contains(bot.type)) {
        report = await _tickScheduled(bot, now);
      } else if (bot.type == 'scanner') {
        report = await _tickScanner(bot, now);
      } else if (bot.type == 'signal') {
        report = await _tickSignal(bot, now);
      } else {
        report = await _tickDealBot(bot, bot.type, bot.config, bot.pairs(), now);
      }
    } on AgentHalted {
      _killed = true;
      await _audit({'type': 'bot_abort', 'bot': bot.id, 'reason': 'killed'});
      return {'bot': bot.id, 'killed': true};
    } catch (e) {
      await _audit({'type': 'bot_error', 'bot': bot.id, 'error': '$e'});
      report = {'bot': bot.id, 'error': '$e'};
    }
    // Track bot health: a bot stuck rejecting/blocking every tick (bad allowlist,
    // repeated cap breach, dispatch error) is invisible otherwise. Surface the
    // last error + auto-pause after a run of them (§14).
    _updateHealth(report, bot);
    // Pop a profit notification on any realized-gain since the last one (paper or
    // live, any profit currency). This is the user-visible "you made money" ping.
    _maybeNotifyProfit(bot);
    // PERSIST ONLY WHEN IT MATTERS. The scheduler can tick as often as every 1s;
    // writing encrypted state to secure storage on every tick (mostly unchanged
    // but for lastTickAt) is needless flash wear + main-thread jank. Persist when
    // a tick actually mutated state (a fill, deal open/close, settlement, auto-
    // halt), else checkpoint liveness at most once per _persistEverySec.
    if (_reportMutated(report, bot)) {
      bot.state['_lastPersistAt'] = now;
      await store.persist();
    } else if (now - ((bot.state['_lastPersistAt'] as int?) ?? 0) >= _persistEverySec * 1000) {
      bot.state['_lastPersistAt'] = now;
      await store.persist();
    }
    return report;
  }

  // After N consecutive hard-failure ticks (rejects/blocks/cap breaches/errors
  // with no fill between), auto-pause the bot so a hot failing loop can't run
  // unattended. Price-skips/waits are normal and never counted.
  static const int _autoHaltAfterErrors = 25;
  void _updateHealth(Map<String, dynamic> report, b.Bot bot) {
    if (!bot.enabled) return; // already halted this tick (autohalt/kill)
    final evs = report['events'];
    var success = false, hardFail = false;
    String? reason;
    if (report['error'] != null) {
      hardFail = true;
      reason = 'error';
    }
    if (evs is List) {
      for (final e in evs) {
        if (e is! Map) continue;
        if (e['action'] != null || e['side'] != null || e['executed'] == true || e['paper'] == true) {
          success = true;
        }
        if (e['rejected'] != null) {
          hardFail = true;
          reason = 'order rejected';
        } else if (e['blocked'] == true) {
          hardFail = true;
          reason = 'tool blocked';
        } else if (e['skipped'] == 'allocation' || e['skipped'] == 'allocation-unknown') {
          hardFail = true;
          reason = 'allocation cap reached';
        } else if (e['skipped'] == 'mainnet') {
          hardFail = true;
          reason = 'mainnet disabled';
        } else if (e['skipped'] == 'order') {
          hardFail = true;
          reason = 'order not placed';
        }
      }
    }
    if (success) {
      bot.state['_consecErrors'] = 0;
      bot.state['lastError'] = null;
    } else if (hardFail) {
      final n = ((bot.state['_consecErrors'] as int?) ?? 0) + 1;
      bot.state['_consecErrors'] = n;
      bot.state['lastError'] = reason;
      if (n >= _autoHaltAfterErrors) {
        _autoHalt(bot, 'repeated-errors', {'consecutive': n, 'lastError': reason});
      }
    }
    // Pure price-skip / waiting ticks neither reset nor increment — normal idle.
  }

  // The bot's cumulative realized profit (USD microdollars): closed deals
  // (bot.state['realizedUc']) PLUS the realized rungs of any still-open grid deal
  // (a running grid books profit per sell without ever closing the deal).
  BigInt _currentRealizedUc(b.Bot bot) {
    var total = (bot.state['realizedUc'] as BigInt?) ?? BigInt.zero;
    final byPair = (bot.state['byPair'] as Map?) ?? const {};
    for (final ps in byPair.values) {
      if (ps is! Map) continue;
      final deal = ps['deal'] as Map?;
      if (deal != null && deal['status'] != 'closed') {
        total += (deal['realizedUc'] as BigInt?) ?? BigInt.zero;
      }
    }
    return total;
  }

  // Pop ONE notification per fresh chunk of realized profit. Fires on the POSITIVE
  // delta since the last notification (≥ $0.01); sub-cent gains accumulate silently
  // until they cross the threshold (we don't advance the baseline below it, so no
  // profit is ever dropped). Works in paper AND live, in any profit currency —
  // unlike the PnlHook, which only pops on a live stablecoin exit.
  void _maybeNotifyProfit(b.Bot bot) {
    final n = notifier;
    if (n == null) return;
    final cur = _currentRealizedUc(bot);
    final last = (bot.state['_notifiedRealizedUc'] as BigInt?) ?? BigInt.zero;
    final delta = cur - last;
    if (delta <= BigInt.zero) {
      // Realized went DOWN (new deal reset, or a loss after the last ping) — re-
      // baseline so the NEXT gain is measured from here, never a stale high-water.
      if (cur < last) bot.state['_notifiedRealizedUc'] = cur;
      return;
    }
    final deltaUsd = b.ucToUsd(delta) ?? 0;
    if (deltaUsd < 0.01) return; // too small yet; let it accumulate (baseline held)
    bot.state['_notifiedRealizedUc'] = cur;
    final pc = _profitCurrency(bot);
    final totalUsd = b.ucToUsd(cur) ?? 0;
    final tagMode = bot.mode == 'paper' ? ' (paper)' : '';
    try {
      unawaited(n.notify(AgentNotification(
        title: '${bot.name}: ${formatUsd(deltaUsd, sign: true)} profit$tagMode',
        subtitle: pc != null
            ? 'Realized in $pc · ${formatUsd(totalUsd, sign: true)} total'
            : '${formatUsd(totalUsd, sign: true)} realized in total',
        tag: 'botprofit:${bot.id}',
        data: {
          'type': 'bot_profit', 'bot': bot.id, 'name': bot.name, 'mode': bot.mode,
          'deltaUsd': deltaUsd, 'realizedUsd': totalUsd,
          if (pc != null) 'currency': pc,
        },
      )));
    } catch (_) {/* notifications are best-effort — never block a tick */}
  }

  // A tick "mutated" if it fired/settled an order or flipped the bot off (auto-
  // halt/kill). Pure skips/waits/price-misses/errors are not material state.
  static const int _persistEverySec = 30;
  bool _reportMutated(Map<String, dynamic> report, b.Bot bot) {
    if (!bot.enabled) return true; // disabled DURING this tick (autohalt/kill)
    final evs = report['events'];
    if (evs is! List) return false;
    for (final e in evs) {
      if (e is! Map) continue;
      if (e['action'] != null ||
          e['side'] != null ||
          e['executed'] == true ||
          e['paper'] == true ||
          e['settlement'] == true) {
        return true;
      }
    }
    return false;
  }

  // ---- deal bots (dca / grid / smarttrade), also reused by signal-spawned ---
  Future<Map<String, dynamic>> _tickDealBot(
      b.Bot bot, String type, Map<String, dynamic> cfg, List<String> pairs, int now) async {
    final bcfg = type == 'dca'
        ? b.dcaBps(cfg)
        : type == 'grid'
            ? b.gridBcfg(cfg)
            : cfg;
    final ctxMainnet = _ctxMainnet();
    final events = <Map<String, dynamic>>[];

    for (final pair in pairs) {
      final parts = b.splitPair(pair);
      final base = parts[0], quote = parts[1];
      final prices = await _prices([base, quote]);
      final markUc = _unitUc(prices, base);
      if (markUc == null) {
        await _audit({'type': 'bot_skip', 'bot': bot.id, 'pair': pair, 'reason': 'price', 'detail': 'no mark for $base'});
        events.add({'pair': pair, 'skipped': 'price'});
        continue;
      }
      // Cache the live mark so an open deal's unrealized P&L can be marked (§4).
      final markUsd = b.ucToUsd(markUc);
      if (markUsd != null && markUsd > 0) _lastMarks[base] = markUsd;
      final bd = b.decimalsFor(base, cfg['decimals'] as Map<String, dynamic>?);
      final quoteDec = b.decimalsFor(quote, cfg['decimals'] as Map<String, dynamic>?);
      final quoteUc = _unitUc(prices, quote);

      final byPair = bot.state['byPair'] as Map<String, dynamic>;
      var ps = byPair[pair] as Map<String, dynamic>?;
      if (ps == null) {
        ps = {'deal': null, 'lastCloseAt': 0};
        byPair[pair] = ps;
      }

      if (type == 'grid') {
        if (ps['deal'] == null) {
          ps['deal'] = b.newGridDeal('${bot.id}:$pair', cfg, markUc, bd, now);
        }
      } else {
        if (ps['deal'] == null || (ps['deal'] as Map)['status'] == 'closed') {
          if (!_canStart(bot, ps, now)) {
            events.add({'pair': pair, 'waiting': true});
            continue;
          }
          final dealCount = bot.state['dealCount'] as int;
          ps['deal'] = type == 'smarttrade'
              ? b.newSmartTradeDeal('${bot.id}:$pair:${dealCount + 1}', cfg, now)
              : b.newDcaDeal('${bot.id}:$pair:${dealCount + 1}', now);
        }
      }

      final deal = ps['deal'] as Map<String, dynamic>;
      if (type == 'dca') b.dcaObserve(deal, markUc);

      final m = {'base': base, 'quote': quote, 'bd': bd, 'quoteDec': quoteDec, 'quoteUc': quoteUc};
      var guard = 0;
      while (guard++ < 128) {
        final order = _engineStep(type, deal, bcfg, cfg, markUc);
        if (order == null) break;

        if (order['action'] == 'arm') {
          order['_markUc'] = markUc;
          _engineApply(type, deal, bcfg, cfg, order, null, now);
          continue;
        }

        final fill = await _executeOrder(bot, m, order, markUc, ctxMainnet);
        if (fill == null) {
          // Had an order to place but it didn't fire (allocation cap, mainnet off,
          // blocked tool, dispatch reject, dust). Record it so health tracking can
          // surface/auto-pause a bot stuck not trading — vs a benign price skip.
          events.add({'pair': pair, 'skipped': 'order'});
          break; // stop this pair's cascade
        }
        fill['bd'] = bd;
        _engineApply(type, deal, bcfg, cfg, order, fill, now);
        events.add({
          'pair': pair, 'action': order['kind'], 'side': order['side'],
          'qty': (fill['qty'] as BigInt).toString(), 'priceUc': (fill['priceUc'] as BigInt).toString(),
          'paper': fill['paper'] == true,
        });

        // UNIFORM SETTLEMENT STEP (the deal-engine exit/realize path, all lanes):
        // a realized SELL realizes proceeds in the pair-native quote. If that is
        // NOT the bot profit currency, convert the proceeds INTO it with ONE extra
        // swap through the SAME value-moving gate; the realized-profit record then
        // reports the FINAL settled currency. No route / blocked -> keep the native
        // quote AND label realized.currency with the ACTUAL output (never lie).
        if (order['side'] == 'sell') {
          final settle = await _settleRealizedExit(
            bot,
            proceedsAsset: quote,
            proceedsUc: (fill['proceedsUc'] as BigInt?) ?? BigInt.zero,
            mainnet: ctxMainnet || bot.network == 'mainnet',
            paper: fill['paper'] == true,
          );
          deal['realizedCurrency'] = settle['currency'];
          ps['realizedCurrency'] = settle['currency'];
          if (settle['settled'] == true) {
            events.add({
              'pair': pair, 'settlement': true, 'from': quote, 'to': settle['currency'],
              'paper': settle['paper'] == true,
            });
          }
        }

        if (deal['status'] == 'closed') {
          _bookClose(bot, ps, now);
          break;
        }
      }
    }
    return {'bot': bot.id, 'type': type, 'events': events, 'dashboard': dashboard(bot.id)};
  }

  Map<String, dynamic>? _engineStep(
      String type, Map<String, dynamic> deal, Map<String, dynamic> bcfg, Map<String, dynamic> cfg, BigInt markUc) {
    if (type == 'dca') return b.dcaStep(deal, bcfg, markUc);
    if (type == 'grid') return b.gridStep(deal, markUc, bcfg);
    if (type == 'smarttrade') return b.smartStep(deal, cfg, markUc);
    return null;
  }

  void _engineApply(String type, Map<String, dynamic> deal, Map<String, dynamic> bcfg,
      Map<String, dynamic> cfg, Map<String, dynamic> order, Map<String, dynamic>? fill, int now) {
    if (type == 'dca') {
      b.dcaApply(deal, bcfg, order, fill, now);
    } else if (type == 'grid') {
      b.gridApply(deal, order, fill!, now);
    } else if (type == 'smarttrade') {
      b.smartApply(deal, cfg, order, fill!, now);
    }
  }

  bool _canStart(b.Bot bot, Map<String, dynamic> ps, int now) {
    if (bot.cooldownSec > 0 && (ps['lastCloseAt'] as int? ?? 0) != 0) {
      if ((now - (ps['lastCloseAt'] as int)) < bot.cooldownSec * 1000) return false;
    }
    final sc = bot.config['startCondition'];
    if (sc == 'signal') return ps['signalArmed'] == true;
    return true;
  }

  // Book a closed deal into the bot's dashboard stats + archive.
  void _bookClose(b.Bot bot, Map<String, dynamic> ps, int now) {
    final deal = ps['deal'] as Map<String, dynamic>;
    final r = (deal['realizedUc'] as BigInt?) ?? BigInt.zero;
    bot.state['realizedUc'] = ((bot.state['realizedUc'] as BigInt?) ?? BigInt.zero) + r;
    bot.state['dealCount'] = (bot.state['dealCount'] as int) + 1;
    if (r > BigInt.zero) {
      bot.state['winCount'] = (bot.state['winCount'] as int) + 1;
      bot.state['_consecLosses'] = 0; // a win breaks any losing streak
    } else if (r < BigInt.zero) {
      bot.state['lossCount'] = (bot.state['lossCount'] as int) + 1;
      bot.state['_consecLosses'] = ((bot.state['_consecLosses'] as int?) ?? 0) + 1;
    }
    bot.state['_peakRealizedUc'] = (bot.state['_peakRealizedUc'] as BigInt?) ?? BigInt.zero;
    if ((bot.state['realizedUc'] as BigInt) > (bot.state['_peakRealizedUc'] as BigInt)) {
      bot.state['_peakRealizedUc'] = bot.state['realizedUc'];
    }
    final dd = (bot.state['_peakRealizedUc'] as BigInt) - (bot.state['realizedUc'] as BigInt);
    if (dd > ((bot.state['maxDrawdownUc'] as BigInt?) ?? BigInt.zero)) {
      bot.state['maxDrawdownUc'] = dd;
    }
    (bot.state['closedDeals'] as List).add(deal);
    final closed = bot.state['closedDeals'] as List;
    if (closed.length > 500) closed.removeRange(0, closed.length - 500);
    ps['lastCloseAt'] = now;
    ps['deal'] = null;
    ps['signalArmed'] = false;

    // ---- RISK CIRCUIT-BREAKER (§5 safety) ----------------------------------
    // Optional per-bot guards. When the realized drawdown from peak exceeds
    // maxDrawdownUsd, or the losing streak hits maxConsecutiveLosses, the bot
    // auto-halts: it stops ticking AND (for a live bot) its server-side key is
    // revoked, so a misconfigured bot can't bleed unattended. Opt-in — a bot
    // without the knobs behaves exactly as before.
    final maxDdUsd = _posNum(bot.config['maxDrawdownUsd']);
    final maxLosses = _posInt(bot.config['maxConsecutiveLosses']);
    final ddUsd = b.ucToUsd(dd) ?? 0;
    if (maxDdUsd != null && ddUsd >= maxDdUsd) {
      _autoHalt(bot, 'max-drawdown', {'drawdownUsd': ddUsd, 'limitUsd': maxDdUsd});
    } else if (maxLosses != null && ((bot.state['_consecLosses'] as int?) ?? 0) >= maxLosses) {
      _autoHalt(bot, 'loss-streak', {'losses': bot.state['_consecLosses'], 'limit': maxLosses});
    }
  }

  // Positive finite num from loose config, else null (0/absent => guard off).
  static num? _posNum(dynamic v) {
    if (v is num && v.isFinite && v > 0) return v;
    if (v is String) { final n = num.tryParse(v); if (n != null && n.isFinite && n > 0) return n; }
    return null;
  }

  static int? _posInt(dynamic v) => _posNum(v)?.floor();

  // Disable a single bot NOW for a risk reason, audit + emit a `bot_autohalt`
  // event (the host revokes the live delegation key on that event), and stop the
  // scheduler if it was the last running bot. Synchronous: safe to call mid-tick.
  void _autoHalt(b.Bot bot, String reason, [Map<String, dynamic>? detail]) {
    if (!bot.enabled) return;
    bot.enabled = false;
    bot.state['haltReason'] = reason;
    bot.state['haltAt'] = _now();
    unawaited(_audit({'type': 'bot_autohalt', 'bot': bot.id, 'reason': reason, ...?detail}));
    emit({'type': 'bot_autohalt', 'bot': bot.id, 'reason': reason, ...?detail});
    if (store.enabled().isEmpty) stopScheduler();
  }

  // ===========================================================================
  // execute a single order — PAPER simulates; LIVE routes through the ONE gate.
  // Returns a fill map or null when the order did not fire (all audited).
  // ===========================================================================
  Future<Map<String, dynamic>?> _executeOrder(
      b.Bot bot, Map<String, dynamic> m, Map<String, dynamic> order, BigInt markUc, bool ctxMainnet) async {
    final mainnet = bot.network == 'mainnet' || ctxMainnet;
    final toolName = bot.type == 'grid' ? 'place_order' : 'swap';
    final bd = m['bd'] as int;
    // Grid orders are LIMIT orders at a specific ladder price; DCA/smarttrade fill
    // at the current mark. Use the level price for grid so size = qty*levelPrice.
    final execPriceUc = (order['_levelPriceUc'] as BigInt?) ?? markUc;

    if (order['side'] == 'buy') {
      // DCA/smarttrade buys carry a USD size; GRID buys carry only a fixed base
      // qty + its level price (FIX-GRID). Derive usdSizeUc/costUc from qty*levelPrice
      // (base-unit/BigInt-exact) so the SAME allocation cap-check + committed-spend
      // accrual + ONE dispatch apply to grid EXACTLY like DCA.
      final BigInt usdSizeUc;
      final BigInt qty;
      final orderUsd = order['usdSizeUc'] as BigInt?;
      if (orderUsd != null) {
        usdSizeUc = orderUsd;
        qty = order['_qtyOverride'] as BigInt? ?? b.qtyForUsd(usdSizeUc, markUc, bd);
      } else {
        qty = order['qty'] as BigInt;
        usdSizeUc = b.valueOf(qty, execPriceUc, bd); // grid: fixed qty * level price
      }
      final costUc = b.valueOf(qty, execPriceUc, bd);
      if (qty <= BigInt.zero) {
        await _audit({'type': 'bot_skip', 'bot': bot.id, 'reason': 'size', 'detail': 'buy rounds to zero'});
        return null;
      }

      // The mandatory 0.05% agent fee rides EVERY live trade; the allocation ledger
      // bounds the TRUE outflow = trade + fee (FIX-ALLOC-FEE), so cap-check AND
      // accrue trade+fee — cumulative live spend can never exceed allocationUsd.
      final feeUc = b.agentFeeUc(usdSizeUc);

      // --- allocation gate (BigInt-exact, non-bypassable) ------------------
      // LIVE always enforces the per-bot budget. PAPER enforces it too WHEN a
      // budget was set (allocationUsd > 0) — so a paper run is a sandbox the same
      // size as the real one. Legacy/arena paper bots (allocationUsd == 0) are
      // unbounded, preserving the deterministic fixtures exactly.
      BigInt? remainingUc;
      final enforceBudget = bot.mode == 'live' || (bot.mode == 'paper' && bot.allocationUsd > 0);
      if (enforceBudget) {
        final allocUc = _effectiveCapUc(bot); // budget, + realized profit when compounding
        remainingUc = allocUc - ((bot.state['committedUc'] as BigInt?) ?? BigInt.zero);
        if (usdSizeUc + feeUc > remainingUc) {
          // does NOT fire, is NOT prompted — the hard per-bot cap (trade + fee).
          await _audit({
            'type': 'bot_skip', 'bot': bot.id, 'reason': 'allocation',
            'wantUc': (usdSizeUc + feeUc).toString(), 'remainingUc': remainingUc.toString(), 'allocationUsd': bot.allocationUsd,
          });
          emit({'type': 'bot_skip', 'bot': bot.id, 'reason': 'allocation'});
          return null;
        }
      }

      // --- mainnet gate (never skipped) ------------------------------------
      if (mainnet && !mainnetEnabled) {
        await _audit({'type': 'bot_skip', 'bot': bot.id, 'reason': 'mainnet', 'detail': 'mainnetEnabled=false'});
        return null;
      }
      // --- allowlist -------------------------------------------------------
      if (!_allowed(toolName)) {
        await _audit({'type': 'bot_blocked', 'bot': bot.id, 'tool': toolName, 'reason': 'not on allowlist'});
        return null;
      }

      if (bot.mode == 'paper') {
        // Mirror the live ledger in paper WHEN a budget is set, so the sandbox
        // depletes its budget identically. No-op when unbounded (alloc 0).
        if (enforceBudget) {
          bot.state['committedUc'] =
              ((bot.state['committedUc'] as BigInt?) ?? BigInt.zero) + usdSizeUc + feeUc;
        }
        await _audit({
          'type': 'bot_paper_fill', 'bot': bot.id, 'side': 'buy', 'kind': order['kind'],
          'pair': '${m['base']}/${m['quote']}', 'qty': qty.toString(), 'priceUc': execPriceUc.toString(), 'costUc': costUc.toString(),
        });
        _emitTradeFee(bot, '${m['quote']}', b.ucToUsd(usdSizeUc)); // 0.05% -> liquidity
        return {'side': 'buy', 'qty': qty, 'priceUc': execPriceUc, 'costUc': costUc, 'paper': true};
      }

      // --- LIVE: route through the ONE value-moving dispatch ---------------
      final quoteUc = (m['quoteUc'] as BigInt?) ?? b.microUsd(1);
      final amount = toolName == 'place_order'
          ? qty.toString()
          : b.qtyForUsd(usdSizeUc, quoteUc, m['quoteDec'] as int).toString();
      final args = toolName == 'place_order'
          ? {
              'market': '${m['base']}/${m['quote']}', 'side': 'buy', 'type': 'limit',
              'amount': qty.toString(), 'price': b.ucToUsd((order['_levelPriceUc'] as BigInt?) ?? markUc),
            }
          : {
              'from': m['quote'], 'to': m['base'], 'amount': amount,
              'venue': await _resolveVenue(
                  bot, '${m['quote']}', '${m['base']}', b.ucToUsd(usdSizeUc), null),
            };
      final r = await _dispatch(bot, toolName, args, remainingUc);
      if (r['rejected'] == true || r['result'] == null) {
        await _audit({'type': 'bot_order_rejected', 'bot': bot.id, 'reason': r['reason']});
        return null;
      }
      bot.state['committedUc'] =
          ((bot.state['committedUc'] as BigInt?) ?? BigInt.zero) + usdSizeUc + feeUc; // accrue trade + fee, ONLY on broadcast
      final result = r['result'];
      final outQty = (result is Map && result['amountOut'] != null)
          ? BigInt.parse('${result['amountOut']}')
          : qty;
      _emitTradeFee(bot, '${m['quote']}', b.ucToUsd(usdSizeUc)); // 0.05% -> liquidity
      return {'side': 'buy', 'qty': outQty, 'priceUc': execPriceUc, 'costUc': costUc, 'txid': r['txid'], 'orderId': r['orderId']};
    }

    // ---- SELL (take-profit / stop-loss / grid flip): proceeds, no allocation --
    final qty = order['qty'] as BigInt?;
    if (qty == null || qty <= BigInt.zero) {
      await _audit({'type': 'bot_skip', 'bot': bot.id, 'reason': 'size', 'detail': 'sell qty zero'});
      return null;
    }
    final proceedsUc = b.valueOf(qty, execPriceUc, bd);
    if (mainnet && !mainnetEnabled) {
      await _audit({'type': 'bot_skip', 'bot': bot.id, 'reason': 'mainnet'});
      return null;
    }
    if (!_allowed(toolName)) {
      await _audit({'type': 'bot_blocked', 'bot': bot.id, 'tool': toolName, 'reason': 'not on allowlist'});
      return null;
    }

    if (bot.mode == 'paper') {
      await _audit({
        'type': 'bot_paper_fill', 'bot': bot.id, 'side': 'sell', 'kind': order['kind'],
        'pair': '${m['base']}/${m['quote']}', 'qty': qty.toString(), 'priceUc': execPriceUc.toString(), 'proceedsUc': proceedsUc.toString(),
      });
      return {'side': 'sell', 'qty': qty, 'priceUc': execPriceUc, 'proceedsUc': proceedsUc, 'paper': true};
    }
    final args = toolName == 'place_order'
        ? {
            'market': '${m['base']}/${m['quote']}', 'side': 'sell', 'type': 'limit',
            'amount': qty.toString(), 'price': b.ucToUsd((order['_levelPriceUc'] as BigInt?) ?? markUc),
          }
        : {
            'from': m['base'], 'to': m['quote'], 'amount': qty.toString(),
            'venue': await _resolveVenue(
                bot, '${m['base']}', '${m['quote']}', b.ucToUsd(proceedsUc), null),
          };
    // sells do not consume allocation; keep the auto-approve envelope at remaining
    // allocation so the sell still auto-approves within the same ONE gate.
    final remainingUc = b.microUsd(bot.allocationUsd) - ((bot.state['committedUc'] as BigInt?) ?? BigInt.zero);
    final r = await _dispatch(bot, toolName, args, remainingUc > BigInt.zero ? remainingUc : b.microUsd(bot.allocationUsd));
    if (r['rejected'] == true || r['result'] == null) {
      await _audit({'type': 'bot_order_rejected', 'bot': bot.id, 'reason': r['reason']});
      return null;
    }
    return {'side': 'sell', 'qty': qty, 'priceUc': execPriceUc, 'proceedsUc': proceedsUc, 'txid': r['txid'], 'orderId': r['orderId']};
  }

  String _venue(b.Bot bot) {
    final vp = bot.venuePrefs;
    if (vp is Map && vp['venue'] != null) return '${vp['venue']}';
    return 'blockle';
  }

  /// LEVER 1+2 AT DISPATCH: resolve the cheapest fillable venue for THIS swap when
  /// a route resolver is wired (ctx.routeCandidates -> route descriptors fed to the
  /// shared Venues.chooseRoute; the internal Blockle rail is preferred when it can
  /// ACTUALLY fill the pair+size, never assumed). Falls back to the bot's
  /// configured venue (default 'blockle'). Default-safe: with no resolver the venue
  /// is unchanged, so every existing dispatch path behaves exactly as before.
  Future<String> _resolveVenue(
      b.Bot bot, String from, String to, num? sizeUsd, String? chain) async {
    final def = _venue(bot);
    try {
      if (ctx.routeCandidates != null) {
        final cands = await ctx.routeCandidates!(
            from: from, to: to, sizeUsd: sizeUsd, chain: chain, bot: bot.id);
        if (cands.isNotEmpty) {
          final picked = chooseRoute(cands);
          final venue = picked['venue'];
          if (venue != null) return '$venue';
        }
      }
    } catch (_) {}
    return def;
  }

  // The bot's configured profit currency (the asset realized P&L settles INTO), or
  // null when none is set (then the pair-native quote IS the realized currency and
  // no settlement fires). Normalized upper-case.
  String? _profitCurrency(b.Bot bot) {
    final pc = bot.config['profitCurrency'];
    if (pc is String && pc.trim().isNotEmpty) return pc.trim().toUpperCase();
    return null;
  }

  // The OUTPUT asset of an intent IFF it is a realizing SELL/exit leg, else null
  // (buys never settle). Reads the exit flag a scanner intent carries; for a plain
  // strategy intent an exit is identified by the shared `:sell` tag convention.
  String? _exitOutputAsset(dynamic it) {
    bool isExit = false;
    try {
      if (it.exit == true) isExit = true;
    } catch (_) {}
    final tag = '${it.tag}';
    if (!isExit && !RegExp(r':sell(:|$)').hasMatch(tag)) return null;
    final tool = '${it.tool}';
    final args = (it.args is Map) ? (it.args as Map) : const {};
    if (tool == 'swap') {
      final to = args['to'];
      return to == null ? null : '$to'.toUpperCase();
    }
    if (tool == 'sell_block') return 'USDC';
    if (tool == 'place_order' && '${args['side']}' == 'sell') {
      final parts = '${args['market'] ?? ''}'.split('/');
      if (parts.length == 2) return parts[1].toUpperCase();
    }
    return null;
  }

  // ===========================================================================
  // THE UNIFORM SETTLEMENT STEP (docs/BLOCKLE-BOTS.md §6) — every lane, one place.
  // A realized SELL/exit produces [proceedsUc] worth of [proceedsAsset]. When that
  // asset != the bot profit currency AND a route exists, emit ONE additional swap
  // (proceedsAsset -> profitCurrency) through the SAME value-moving dispatch the
  // rest of the engine uses (allocation envelope, allowlist, mainnet gate, security
  // pre-sign, the mandatory 0.05% fee). Returns {currency, settled, paper?}:
  //   • settled:true,  currency = profitCurrency  — the proceeds were converted
  //     (or paper-recorded in paper mode; PAPER NEVER broadcasts).
  //   • settled:false, currency = proceedsAsset    — no settlement needed (already
  //     the profit currency) OR NO route / blocked / rejected: the label reports
  //     the ACTUAL output asset — it NEVER claims the profit currency it did not
  //     reach (honesty over optimism; a price is never fabricated to force a hop).
  // Lane -> native gas coin (the asset network fees are paid in).
  static const Map<String, String> _laneNative = {
    'solana': 'SOL', 'ethereum': 'ETH', 'base': 'ETH', 'arbitrum': 'ETH',
    'optimism': 'ETH', 'polygon': 'POL', 'bnb': 'BNB', 'avalanche': 'AVAX',
    'block': 'BLOCK',
  };

  // KEEP-GAS (default ON; config keepGas:false disables, keepGasUsd sizes the
  // top-up, default $3): when the host's lowGasCheck reports the lane's native
  // gas balance is LOW, a LIVE bot converts a small slice of realized profit
  // into the native coin FIRST — through the SAME gated dispatch (allocation
  // envelope, allowlist, mainnet gate, security pre-sign, 0.05% fee) — so it
  // can never strand itself unable to pay network fees. Returns the proceeds
  // REMAINING after the gas slice (unchanged when nothing fires). Fail-soft:
  // any error leaves the proceeds untouched.
  Future<BigInt> _maybeKeepGas(
      b.Bot bot, String from, BigInt proceedsUc,
      {required bool mainnet, required bool paper}) async {
    if (paper || proceedsUc <= BigInt.zero) return proceedsUc;
    if (bot.config['keepGas'] == false) return proceedsUc;
    final check = lowGasCheck;
    if (check == null) return proceedsUc;
    final lane = bot.lane ?? '';
    final gasCoin = _laneNative[lane] ?? '';
    if (gasCoin.isEmpty || gasCoin == from) return proceedsUc;
    try {
      if (!await check(lane)) return proceedsUc;
      // Same hard gates the settlement hop honors — skip quietly when blocked.
      if (mainnet && !mainnetEnabled) return proceedsUc;
      if (!_allowed('swap')) return proceedsUc;
      final prices = await _prices([from]);
      final fromUc = _unitUc(prices, from);
      if (fromUc == null) return proceedsUc;
      final topUpUc = b.microUsd((bot.config['keepGasUsd'] as num?) ?? 3);
      final sliceUc = proceedsUc < topUpUc ? proceedsUc : topUpUc;
      final fromDec = b.decimalsFor(from, bot.config['decimals'] as Map<String, dynamic>?);
      final amount = b.qtyForUsd(sliceUc, fromUc, fromDec);
      if (amount <= BigInt.zero) return proceedsUc;
      final remainingUc = b.microUsd(bot.allocationUsd) -
          ((bot.state['committedUc'] as BigInt?) ?? BigInt.zero);
      final r = await _dispatch(
        bot,
        'swap',
        {
          'from': from, 'to': gasCoin, 'amount': amount.toString(),
          'venue': await _resolveVenue(bot, from, gasCoin, b.ucToUsd(sliceUc), null),
        },
        remainingUc > BigInt.zero ? remainingUc : b.microUsd(bot.allocationUsd),
      );
      if (r['rejected'] == true || r['result'] == null) {
        await _audit({'type': 'bot_keep_gas_skip', 'bot': bot.id, 'reason': r['reason'] ?? 'rejected', 'from': from, 'to': gasCoin});
        return proceedsUc;
      }
      await _audit({'type': 'bot_keep_gas', 'bot': bot.id, 'from': from, 'to': gasCoin, 'amount': amount.toString(), 'txid': r['txid']});
      emit({'type': 'bot_keep_gas', 'bot': bot.id, 'from': from, 'to': gasCoin, 'usd': b.ucToUsd(sliceUc)});
      return proceedsUc - sliceUc;
    } catch (_) {
      return proceedsUc; // fail-soft — never blocks the settlement path
    }
  }

  Future<Map<String, dynamic>> _settleRealizedExit(
    b.Bot bot, {
    required String proceedsAsset,
    required BigInt proceedsUc,
    required bool mainnet,
    required bool paper,
  }) async {
    final from = proceedsAsset.toUpperCase();
    // KEEP-GAS runs FIRST (and also covers bots with no profit currency): carve
    // a small gas top-up out of realized profit when the wallet is running low.
    proceedsUc = await _maybeKeepGas(bot, from, proceedsUc, mainnet: mainnet, paper: paper);
    final pc = _profitCurrency(bot);
    // No profit currency configured, already in it, or nothing realized -> the
    // native quote IS the realized currency; skip the redundant hop.
    if (pc == null || pc == from || proceedsUc <= BigInt.zero) {
      return {'currency': from, 'settled': false};
    }

    // ROUTE CHECK: need a USD unit price for BOTH legs (stablecoins are $1). No
    // price -> NO route: leave proceeds native, label the ACTUAL output, audit it.
    final prices = await _prices([from, pc]);
    final fromUc = _unitUc(prices, from);
    final pcUc = _unitUc(prices, pc);
    if (fromUc == null || pcUc == null) {
      await _audit({
        'type': 'bot_settle_skip', 'bot': bot.id, 'reason': 'no-route',
        'from': from, 'to': pc, 'proceedsUc': proceedsUc.toString(),
      });
      return {'currency': from, 'settled': false, 'noRoute': true};
    }

    // The proceeds expressed in from-asset base units (what the swap spends).
    final fromDec = b.decimalsFor(from, bot.config['decimals'] as Map<String, dynamic>?);
    final amount = b.qtyForUsd(proceedsUc, fromUc, fromDec);
    if (amount <= BigInt.zero) return {'currency': from, 'settled': false};

    // PAPER / Arena: record the settlement, NEVER broadcast, NEVER touch the gate.
    if (paper) {
      await _audit({
        'type': 'bot_settle', 'bot': bot.id, 'mode': 'paper',
        'from': from, 'to': pc, 'amount': amount.toString(), 'proceedsUc': proceedsUc.toString(),
      });
      return {'currency': pc, 'settled': true, 'paper': true};
    }

    // --- mainnet gate (never skipped) ------------------------------------
    if (mainnet && !mainnetEnabled) {
      await _audit({'type': 'bot_settle_skip', 'bot': bot.id, 'reason': 'mainnet', 'from': from, 'to': pc});
      return {'currency': from, 'settled': false};
    }
    // --- allowlist -------------------------------------------------------
    if (!_allowed('swap')) {
      await _audit({'type': 'bot_settle_skip', 'bot': bot.id, 'reason': 'not on allowlist', 'from': from, 'to': pc});
      return {'currency': from, 'settled': false};
    }

    // Settlement converts proceeds (it does not spend fresh allocation, like every
    // other sell); keep the auto-approve envelope at remaining allocation so it
    // still clears the SAME one gate.
    final remainingUc = b.microUsd(bot.allocationUsd) - ((bot.state['committedUc'] as BigInt?) ?? BigInt.zero);
    final r = await _dispatch(
      bot,
      'swap',
      {
        'from': from, 'to': pc, 'amount': amount.toString(),
        'venue': await _resolveVenue(
            bot, from, pc, b.ucToUsd(proceedsUc), null),
      },
      remainingUc > BigInt.zero ? remainingUc : b.microUsd(bot.allocationUsd),
    );
    if (r['rejected'] == true || r['result'] == null) {
      await _audit({'type': 'bot_settle_skip', 'bot': bot.id, 'reason': r['reason'] ?? 'rejected', 'from': from, 'to': pc});
      return {'currency': from, 'settled': false};
    }
    await _audit({'type': 'bot_settle', 'bot': bot.id, 'from': from, 'to': pc, 'amount': amount.toString(), 'txid': r['txid']});
    emit({'type': 'bot_settle', 'bot': bot.id, 'from': from, 'to': pc});
    return {'currency': pc, 'settled': true, 'txid': r['txid']};
  }

  // The ONE gate call: temporarily set policy.autoApproveUnderUsd = remaining
  // allocation so an order WITHIN allocation auto-approves through the SAME gate
  // the NL runner uses; restore it afterward so bot state never leaks out.
  Future<Map<String, dynamic>> _dispatch(
      b.Bot bot, String toolName, Map<String, dynamic> args, BigInt? remainingUc) async {
    final tool = tools.get(toolName);
    if (tool == null || !tool.valueMoving) {
      await _audit({'type': 'bot_blocked', 'bot': bot.id, 'tool': toolName, 'reason': 'not value-moving'});
      return {'rejected': true, 'reason': 'not value-moving'};
    }
    final prevAuto = policy.autoApproveUnderUsd;
    if (remainingUc != null) policy.autoApproveUnderUsd = b.ucToUsd(remainingUc);
    try {
      await _audit({'type': 'bot_dispatch', 'bot': bot.id, 'tool': toolName});
      final DispatchOutcome o = await dispatchValueMoving(
        tools: tools, policy: policy, name: toolName, args: args, audit: audit,
        emit: onEvent, pnl: pnl, pnlWallet: bot.wallet, pnlChannel: bot.channel,
      );
      if (o.declined) return {'rejected': true, 'reason': 'declined'};
      final result = o.result;
      return {
        'result': result, 'txid': o.txid,
        'orderId': result is Map ? result['orderId'] : null,
      };
    } on AgentHalted {
      rethrow;
    } on CapExceeded catch (e) {
      return {'rejected': true, 'reason': '$e'};
    } finally {
      policy.autoApproveUnderUsd = prevAuto;
    }
  }

  // ---- signal bot (§2.4) --------------------------------------------------
  Future<Map<String, dynamic>> _tickSignal(b.Bot bot, int now) async {
    final cfg = bot.config;
    final spawn = (cfg['onSignal'] as Map).cast<String, dynamic>();
    final byPair = bot.state['byPair'] as Map<String, dynamic>;
    final openCount = byPair.values
        .where((p) => p is Map && p['deal'] != null && (p['deal'] as Map)['status'] != 'closed')
        .length;
    var room = (cfg['maxConcurrent'] as int) - openCount;
    if (room < 0) room = 0;

    final signals = <Map<String, dynamic>>[];
    final source = cfg['source'];
    final minScore = (cfg['minScore'] as num).toDouble();
    if ((source == 'discovery' || source == 'both') && discovery != null) {
      // Lane + risk-mode aware discovery: the feed returns only same-chain,
      // same-mode candidates that already cleared the safety gate.
      final cands = await _discoveryScan(discovery, bot.lane, bot.riskMode);
      final laneChain = bot.lane != null ? b.laneChain(bot.lane) : null;
      for (final c in cands) {
        final chain = _field(c, 'chain');
        if (laneChain != null && chain != null && chain != laneChain) continue; // never cross-lane
        final approved = _field(c, 'approved') == true;
        final score = _field(c, 'score');
        final pair = _field(c, 'pair');
        if (approved && (score == null || (score as num) >= minScore) && pair != null) {
          signals.add({'pair': pair, 'score': score, 'source': 'discovery'});
        }
      }
    }
    if (source == 'inbox' || source == 'both') {
      final inbox = (bot.state['inbox'] as List?) ?? const [];
      for (var i = (bot.state['cursor'] as int? ?? 0); i < inbox.length; i++) {
        final s = inbox[i];
        final pair = s is Map ? s['pair'] : _field(s, 'pair');
        if (pair != null) signals.add({'pair': pair, 'source': 'inbox'});
      }
      bot.state['cursor'] = inbox.length;
    }

    for (final sig in signals) {
      if (room <= 0) break;
      final pair = '${sig['pair']}'.toUpperCase();
      final existing = byPair[pair] as Map?;
      if (existing != null && existing['deal'] != null && (existing['deal'] as Map)['status'] != 'closed') {
        continue;
      }
      if (byPair[pair] == null) byPair[pair] = <String, dynamic>{'deal': null, 'lastCloseAt': 0};
      (byPair[pair] as Map<String, dynamic>)['signalArmed'] = true;
      await _audit({'type': 'bot_signal', 'bot': bot.id, 'pair': pair, 'source': sig['source'], 'template': spawn['type']});
      room -= 1;
    }

    final pairs = byPair.keys.toList();
    return _tickDealBot(bot, spawn['type'] as String, (spawn['config'] as Map).cast<String, dynamic>(), pairs, now);
  }

  dynamic _field(dynamic c, String name) {
    if (c is Map) return c[name];
    try {
      switch (name) {
        case 'approved':
          return (c as dynamic).approved;
        case 'score':
          return (c as dynamic).score;
        case 'pair':
          return (c as dynamic).pair;
        case 'chain':
          return (c as dynamic).chain;
      }
    } catch (_) {}
    return null;
  }

  /// Call a duck-typed discovery feed's `scan`, passing the bot's {lane, mode} so
  /// a signals-backed client can fetch same-chain/same-mode candidates. Falls back
  /// to the legacy no-arg `scan()` when the feed does not accept options (test
  /// fakes), and to [] on any error. READ-ONLY.
  Future<List<dynamic>> _discoveryScan(dynamic d, String? lane, String? mode) async {
    try {
      return List<dynamic>.from(await d.scan({'lane': lane, 'mode': mode}));
    } on NoSuchMethodError {
      try {
        return List<dynamic>.from(await d.scan());
      } catch (_) {
        return const [];
      }
    } catch (_) {
      return const [];
    }
  }

  /// Post a local signal to a signal bot's inbox (user / NL agent). READ side only.
  Future<b.Bot> postSignal(String id, Map<String, dynamic> signal) async {
    final bot = store.get(id);
    if (bot == null) throw ArgumentError('unknown bot: $id');
    (bot.state['inbox'] as List?) ?? (bot.state['inbox'] = <dynamic>[]);
    (bot.state['inbox'] as List).add(signal);
    await store.persist();
    return bot;
  }

  // ---- scheduled bots (rebalance / momentum + the 9 indicator planners) ------
  // All route through the strategy PLANNER each tick. The indicator + momentum
  // planners decide on a rolling price `history`; the runner maintains a per-bot
  // price RING here from the SAME real marks the deal bots use (ctx.prices) and
  // feeds it in as `history` (oldest -> newest) unless the config already carries
  // one. No synthetic prices: a tick with no mark simply does not extend the ring.
  Future<Map<String, dynamic>> _tickScheduled(b.Bot bot, int now) async {
    final strat = strategies[bot.type];
    final sctx = ctx.strategyCtx;
    if (strat == null) return {'bot': bot.id, 'error': 'no strategy ${bot.type}'};
    if (sctx == null) return {'bot': bot.id, 'error': 'no strategy ctx for ${bot.type}'};
    final cfg = {...bot.config};
    final market = _scheduledMarket(bot);
    if (market != null) {
      cfg['market'] = market;
      final ring = await _extendPriceRing(bot, market);
      // Only seed history from the ring when the config does not supply its own
      // (preserves explicit-history callers + the deterministic fixtures exactly).
      if (ring.isNotEmpty && (cfg['history'] == null ||
          (cfg['history'] is List && (cfg['history'] as List).isEmpty))) {
        cfg['history'] = ring;
      }
    }
    final Map<String, dynamic> params;
    try {
      params = strat.validateParams(cfg);
    } catch (e) {
      await _audit({'type': 'bot_error', 'bot': bot.id, 'error': '$e'});
      return {'bot': bot.id, 'type': bot.type, 'error': '$e'};
    }
    // Answer the planner's getBalance from THIS bot's own position ledger so
    // indicator/momentum exits can size (and fire) — see _plannerCtx.
    final intents = await strat.plan(_plannerCtx(sctx, bot), params);
    final events = await _dispatchIntents(bot, intents);
    return {'bot': bot.id, 'type': bot.type, 'events': events};
  }

  // The market a scheduled bot trades: its config `market` (indicator bots) or its
  // first universe pair (rebalance/momentum), normalized BASE/QUOTE, else null.
  String? _scheduledMarket(b.Bot bot) {
    final m = bot.config['market'];
    if (m is String && m.trim().isNotEmpty) return m.trim().toUpperCase();
    final ps = bot.pairs();
    if (ps.isNotEmpty && ps.first.contains('/')) return ps.first.toUpperCase();
    return null;
  }

  // Append the current base mark to the bot's rolling price ring (capped) and
  // return it oldest -> newest. Persisted in bot.state so indicators warm up
  // across ticks. A missing mark leaves the ring unchanged (no synthetic price).
  static const int _priceRingCap = 512;
  Future<List<num>> _extendPriceRing(b.Bot bot, String market) async {
    final base = b.splitPair(market)[0];
    final prices = await _prices([base, b.splitPair(market)[1]]);
    final markUc = _unitUc(prices, base);
    final ring = (bot.state['priceRing'] as List?)?.cast<num>() ?? <num>[];
    if (markUc != null) {
      final usd = b.ucToUsd(markUc);
      if (usd != null && usd > 0) {
        ring.add(usd);
        if (ring.length > _priceRingCap) {
          ring.removeRange(0, ring.length - _priceRingCap);
        }
        bot.state['priceRing'] = ring;
      }
    }
    return List<num>.from(ring);
  }

  // ---- planner position ledger (indicator / momentum SELL support) ----------
  // Indicator planners (rsi/macd/bollinger/breakout/emacross/roc/meanrev/…) and
  // the momentum death-cross read the HELD base via ctx.getBalance to size an
  // exit. Rather than expose the whole wallet balance (which would let a bot dump
  // holdings it never acquired), each planner bot keeps its OWN ledger: its
  // executed buys accrue base, its executed sells draw it down. So an indicator
  // bot takes profit on EXACTLY what it itself bought — never more. Self-
  // consistent in paper AND live; marks come from ctx.prices (never fabricated).
  Future<void> _accruePlannerPosition(b.Bot bot, dynamic it) async {
    try {
      if ('${it.tool}' != 'swap') return;
      final args = (it.args as Map).cast<String, dynamic>();
      final from = '${args['from']}'.toUpperCase();
      final to = '${args['to']}'.toUpperCase();
      final amount = BigInt.tryParse('${args['amount']}') ?? BigInt.zero;
      if (amount <= BigInt.zero) return;
      final pos = ((bot.state['plannerPos'] as Map?)?.cast<String, dynamic>()) ?? <String, dynamic>{};
      final isSell = RegExp(r':sell(:|$)').hasMatch('${it.tag}');
      if (isSell) {
        // SELL: `amount` is BASE units (from=base). Draw the ledger down, floor 0,
        // and release cost basis pro-rata (average-cost) so remaining unrealized
        // P&L stays honest.
        final cur = _posUnits(pos, from);
        final curCost = _posCostUc(pos, from);
        final sold = amount > cur ? cur : amount;
        final nextUnits = cur - sold;
        final nextCost = cur > BigInt.zero
            ? (nextUnits <= BigInt.zero ? BigInt.zero : (curCost * nextUnits) ~/ cur)
            : BigInt.zero;
        _setPos(pos, from, nextUnits, nextCost);
      } else {
        // BUY: `amount` is QUOTE units (from=quote, to=base). Convert the USD size
        // to base via the live base mark so the ledger holds base units (what the
        // SELL path reads). No mark -> accrue nothing (never fabricate a price).
        final base = to;
        final est = it.estUsd as num?;
        if (est == null || !est.isFinite || est <= 0) return;
        final marks = await _prices([base]);
        final markUc = _unitUc(marks, base);
        if (markUc == null || markUc <= BigInt.zero) return;
        // Capture the live mark so [dashboard] can value this holding right away
        // (the scanner path never flows through _tickDealBot's mark cache).
        final markUsd = b.ucToUsd(markUc);
        if (markUsd != null && markUsd > 0) _lastMarks[base] = markUsd;
        final bd = b.decimalsFor(base, bot.config['decimals'] as Map<String, dynamic>?);
        final received = b.qtyForUsd(b.microUsd(est), markUc, bd);
        if (received <= BigInt.zero) return;
        _setPos(pos, base, _posUnits(pos, base) + received,
            _posCostUc(pos, base) + b.microUsd(est));
      }
      bot.state['plannerPos'] = pos;
    } catch (_) {/* ledger is best-effort; never blocks a trade */}
  }

  // plannerPos entries are {units, costUc} maps. Readers tolerate the LEGACY bare
  // units-string shape (older persisted state) by treating its basis as unknown.
  static BigInt _posUnits(Map pos, String sym) {
    final v = pos[sym];
    if (v is Map) return BigInt.tryParse('${v['units'] ?? '0'}') ?? BigInt.zero;
    return BigInt.tryParse('$v') ?? BigInt.zero;
  }

  static BigInt _posCostUc(Map pos, String sym) {
    final v = pos[sym];
    if (v is Map) return BigInt.tryParse('${v['costUc'] ?? '0'}') ?? BigInt.zero;
    return BigInt.zero; // legacy bare-units: basis unknown
  }

  static void _setPos(Map pos, String sym, BigInt units, BigInt costUc) {
    if (units <= BigInt.zero) {
      pos.remove(sym);
    } else {
      pos[sym] = {'units': units.toString(), 'costUc': costUc.toString()};
    }
  }

  // A per-tick StrategyContext clone of [base] that answers getBalance from THIS
  // bot's planner ledger (above). Built fresh each scheduled tick so the shared
  // read-only ctx stays bot-agnostic.
  StrategyContext _plannerCtx(StrategyContext base, b.Bot bot) {
    return StrategyContext(
      now: base.now,
      network: base.network,
      listVenues: base.listVenues,
      venueQuote: base.venueQuote,
      getBook: base.getBook,
      getTrades: base.getTrades,
      getMarkets: base.getMarkets,
      prices: base.prices,
      policyRemaining: base.policyRemaining,
      openOrders: base.openOrders,
      note: base.note,
      getBalance: (chain, [tokens]) async {
        final pos = (bot.state['plannerPos'] as Map?)?.cast<String, dynamic>() ?? const {};
        final rows = <Map<String, dynamic>>[];
        pos.forEach((sym, _) {
          final u = _posUnits(pos, sym);
          if (u > BigInt.zero) {
            rows.add({
              'asset': {
                'symbol': sym,
                'decimals': b.decimalsFor(sym, bot.config['decimals'] as Map<String, dynamic>?),
              },
              'confirmed': u.toString(),
            });
          }
        });
        return rows;
      },
    );
  }

  // ---- liquidity fee hook (§Blockle Liquidity) ------------------------------
  // Every bot trade — paper OR live — contributes a 0.05% fee to the in-wallet
  // liquidity treasury, keyed by the pair's QUOTE/base coin (USDC/SOL/ETH/…), so
  // the pools deepen with the exact mix of coins the bots actually trade. The
  // engine only EMITS the event (pure, testable); the host (LiquidityService)
  // accrues it. notionalUsd is the trade size; feeUsd = 0.05% of it.
  static const double _liquidityFeeRate = 0.0005; // 0.05%
  void _emitTradeFee(b.Bot bot, String quoteCoin, num? notionalUsd) {
    // LIVE fills only: a paper fill moves no real money, so crediting its fee
    // to the liquidity ledger would inflate reserves with nothing backing them
    // (the server also refuses fee posts not marked mode:'live').
    if (bot.mode != 'live') return;
    final n = (notionalUsd ?? 0).toDouble();
    if (n <= 0 || quoteCoin.isEmpty) return;
    emit({
      'type': 'bot_fee',
      'bot': bot.id,
      'coin': quoteCoin.toUpperCase(),
      'notionalUsd': n,
      'feeUsd': n * _liquidityFeeRate,
      'mode': bot.mode,
    });
  }

  // The QUOTE/base coin of an intent's pair (from its `strat:BASE/QUOTE:side` tag,
  // else its swap `from`), which is the coin whose pool the fee deepens.
  String _intentQuote(dynamic it) {
    try {
      final m = RegExp(r':([A-Za-z0-9]+)/([A-Za-z0-9]+):').firstMatch('${it.tag}');
      if (m != null) return m.group(2)!.toUpperCase();
    } catch (_) {}
    try {
      final args = (it.args is Map) ? (it.args as Map) : const {};
      final from = '${args['from'] ?? ''}'.toUpperCase();
      if (from.isNotEmpty) return from;
    } catch (_) {}
    return 'USDC';
  }

  // The ONE shared Intent-dispatch loop used by scheduled bots AND the scanner:
  // every Intent passes the SAME non-bypassable gate — FINITE+positive estimate,
  // the hard per-bot allocation ledger (trade + 0.05% fee), the mainnet gate, the
  // tool allowlist, and the ONE value-moving dispatch (caps/confirm/kill/audit/
  // security pre-sign). PAPER records a paper_intent and NEVER broadcasts. Kill is
  // honored between Intents. [intents] is a list of StrategyIntent | ScanIntent —
  // both expose tool/args/estUsd/tag/mainnet. Returns a per-Intent event list.
  Future<List<Map<String, dynamic>>> _dispatchIntents(
      b.Bot bot, List<dynamic> intents) async {
    final ctxMainnet = _ctxMainnet();
    final events = <Map<String, dynamic>>[];
    for (final dynamic it in intents) {
      if (policy.isKilled()) break;
      final num? est = it.estUsd as num?;
      if (bot.mode == 'live') {
        // FIX-EST: a LIVE order must carry a FINITE, POSITIVE USD estimate or it
        // FAILS CLOSED. null/NaN/Infinity would coerce to $0 and slip past the
        // cap; a NEGATIVE estimate would accrue negative and EXPAND the ledger —
        // both bypass the hard cap, so reject all.
        if (est == null || !est.isFinite || est <= 0) {
          await _audit({'type': 'bot_skip', 'bot': bot.id, 'reason': 'allocation-unknown', 'tag': it.tag});
          events.add({'tag': it.tag, 'skipped': 'allocation-unknown'});
          continue;
        }
        final estUsdUc = b.microUsd(est);
        final feeUc = b.agentFeeUc(estUsdUc); // allocation bounds the trade + 0.05% fee
        final remainingUc = _effectiveCapUc(bot) - ((bot.state['committedUc'] as BigInt?) ?? BigInt.zero); // + realized profit when compounding
        if (estUsdUc + feeUc > remainingUc) {
          await _audit({'type': 'bot_skip', 'bot': bot.id, 'reason': 'allocation', 'tag': it.tag});
          events.add({'tag': it.tag, 'skipped': 'allocation'});
          continue;
        }
        if (((it.mainnet as bool) || ctxMainnet) && !mainnetEnabled) {
          await _audit({'type': 'bot_skip', 'bot': bot.id, 'reason': 'mainnet', 'tag': it.tag});
          events.add({'tag': it.tag, 'skipped': 'mainnet'});
          continue;
        }
        if (!_allowed(it.tool as String)) {
          await _audit({'type': 'bot_blocked', 'bot': bot.id, 'tool': it.tool});
          events.add({'tag': it.tag, 'blocked': true});
          continue;
        }
        final r = await _dispatch(
            bot, it.tool as String, (it.args as Map).cast<String, dynamic>(), remainingUc);
        if (r['rejected'] != true && r['result'] != null) {
          bot.state['committedUc'] = ((bot.state['committedUc'] as BigInt?) ?? BigInt.zero) + estUsdUc + feeUc;
          await _accruePlannerPosition(bot, it); // keep the exit-sizing ledger current
          events.add({'tag': it.tag, 'executed': true});
          _emitTradeFee(bot, _intentQuote(it), est); // 0.05% fee -> liquidity treasury
          // UNIFORM SETTLEMENT STEP — a realized exit (sell/take-profit) leg whose
          // output is NOT the profit currency gets ONE extra settlement swap into
          // it, through the SAME gate. The arbitrage exit already outputs the
          // profit currency (ScanIntent.tagged rewrote `to`), so the redundant hop
          // is skipped there. No route / blocked -> honest native currency label.
          final outAsset = _exitOutputAsset(it);
          if (outAsset != null) {
            final settle = await _settleRealizedExit(
              bot,
              proceedsAsset: outAsset,
              proceedsUc: estUsdUc,
              mainnet: (it.mainnet as bool) || ctxMainnet,
              paper: false,
            );
            if (settle['settled'] == true) {
              events.add({'tag': it.tag, 'settlement': true, 'from': outAsset, 'to': settle['currency']});
            }
          }
        } else {
          events.add({'tag': it.tag, 'rejected': r['reason']});
        }
      } else {
        if (((it.mainnet as bool) || ctxMainnet) && !mainnetEnabled) {
          events.add({'tag': it.tag, 'skipped': 'mainnet'});
          continue;
        }
        await _audit({'type': 'bot_paper_intent', 'bot': bot.id, 'tag': it.tag, 'estUsd': est});
        await _accruePlannerPosition(bot, it); // paper ledger mirrors live sizing
        events.add({'tag': it.tag, 'paper': true});
        _emitTradeFee(bot, _intentQuote(it), est); // 0.05% fee -> liquidity treasury
        // PAPER: the settlement step is paper-recorded, NEVER broadcast.
        final outAsset = _exitOutputAsset(it);
        if (outAsset != null && est != null && est.isFinite && est > 0) {
          final settle = await _settleRealizedExit(
            bot,
            proceedsAsset: outAsset,
            proceedsUc: b.microUsd(est),
            mainnet: (it.mainnet as bool) || ctxMainnet,
            paper: true,
          );
          if (settle['settled'] == true) {
            events.add({'tag': it.tag, 'settlement': true, 'paper': true, 'from': outAsset, 'to': settle['currency']});
          }
        }
      }
    }
    return events;
  }

  // ---- scanner (scan-&-trade autopilot, docs/AGENT-SCAN.md §3-4) -------------
  // Build the candidate universe (discovery feed ∪ exchange markets ∪ venue pairs,
  // enriched with market data), score every pair with the shared AgentScanner
  // evaluator, pick the worthy ones that fit the REMAINING allocation, and dispatch
  // each chosen Intent through the SAME _dispatchIntents gate as every other bot.
  // READ-ONLY until dispatch; never fabricates a price/edge; a sub-threshold or
  // net-negative pair is NEVER emitted. Returns the scored candidate list (UI) +
  // the dispatch events.
  Future<Map<String, dynamic>> _tickScanner(b.Bot bot, int now) async {
    final universe = await _scanUniverse(bot);
    final committedUsd =
        b.ucToUsd((bot.state['committedUc'] as BigInt?) ?? BigInt.zero) ?? 0;
    final ScanResult result = AgentScanner.scanAndScore(
      universe,
      {...bot.config},
      allocationUsd: bot.allocationUsd,
      committedUsd: committedUsd,
      mainnet: _ctxMainnet(),
    );
    await _audit({
      'type': 'scanner_scan',
      'bot': bot.id,
      'candidates': result.candidates.length,
      'worthy': result.worthy.length,
      'traded': result.worthy.map((w) => w['pair']).toList(),
      'skipped': result.skipped.map((s) => '${s['pair']}:${s['reason']}').toList(),
    });
    // dispatch the chosen Intents through the ONE gate (same as scheduled bots).
    final events = await _dispatchIntents(bot, result.intents);
    // last-scan snapshot for the UI cockpit card.
    final lastScan = <String, dynamic>{
      'at': now,
      'candidates': result.candidates,
      'worthy': result.worthy.map((w) => w['pair']).toList(),
      'skipped': result.skipped,
      'minProfitBps': result.minProfitBps,
      'allocationUsd': result.allocationUsd,
      'committedUsd': committedUsd,
      'remainingUsd': result.remainingUsd,
    };
    bot.state['lastScan'] = lastScan;
    return {'bot': bot.id, 'type': 'scanner', 'scan': lastScan, 'events': events};
  }

  // Assemble the scanner's candidate universe. Prefer an injected enriched feed
  // (ctx.scanUniverse — discovery ∪ exchange markets ∪ venue pairs WITH venue
  // prices/history/book), else fall back to the discovery feed. READ-ONLY.
  Future<List<dynamic>> _scanUniverse(b.Bot bot) async {
    if (ctx.scanUniverse != null) {
      try {
        return (await ctx.scanUniverse!(bot.config)) ?? const [];
      } catch (_) {
        return const [];
      }
    }
    if (discovery != null) {
      try {
        var rows = await _discoveryScan(discovery, bot.lane, bot.riskMode);
        final laneChain = bot.lane != null ? b.laneChain(bot.lane) : null;
        if (laneChain != null) {
          rows = rows.where((r) {
            final chain = _field(r, 'chain');
            return chain == null || chain == laneChain; // never cross-lane
          }).toList();
        }
        return rows;
      } catch (_) {
        return const [];
      }
    }
    return const [];
  }

  // ===========================================================================
  // per-bot dashboard DATA (§4) — accessors only, no UI.
  // ===========================================================================
  Map<String, dynamic>? dashboard(String id, [Map<String, num>? marksOverride]) {
    final bot = store.get(id);
    if (bot == null) return null;
    // Use explicit marks when the caller passes them, else the live per-base
    // marks captured on the last tick (§4) — so an open deal is marked live
    // rather than stuck on "awaiting market data". Null only before any tick.
    final marks = marksOverride ?? _lastMarks;
    final openDeals = <Map<String, dynamic>>[];
    var unrealizedUc = BigInt.zero;
    var safetyUsed = 0;
    // True once an OPEN position cannot be marked (no price/oracle for its base).
    // The aggregate unrealized is then reported as null — "awaiting market data" —
    // never a misleading $0.00 (docs/BLOCKLE-BOTS.md §4/§5: no synthetic marks).
    var unmarked = false;
    final byPair = (bot.state['byPair'] as Map?) ?? const {};
    for (final pair in byPair.keys) {
      final ps = byPair[pair] as Map?;
      final deal = ps?['deal'] as Map?;
      if (deal == null || deal['status'] == 'closed') continue;
      final base = b.splitPair('$pair')[0];
      BigInt? markUc;
      if (marks[base] != null) markUc = b.microUsd(marks[base]!);
      if (deal['type'] == 'grid') {
        var uc = BigInt.zero;
        for (final lv in (deal['levels'] as List)) {
          final held = (lv as Map)['heldQty'] as BigInt;
          if (held > BigInt.zero) {
            if (markUc == null) {
              unmarked = true;
            } else {
              uc += b.valueOf(held, markUc, b.decimalsFor(base, bot.config['decimals'] as Map<String, dynamic>?)) -
                  ((lv['_costUc'] as BigInt?) ?? BigInt.zero);
            }
          }
        }
        unrealizedUc += uc;
        openDeals.add({
          'pair': pair, 'type': 'grid', 'levels': (deal['levels'] as List).length,
          'filledLevels': (deal['levels'] as List).where((l) => (l as Map)['heldQty'] as BigInt > BigInt.zero).length,
          'realizedUc': ((deal['realizedUc'] as BigInt?) ?? BigInt.zero).toString(),
        });
      } else {
        final qty = (deal['filledQty'] ?? deal['remainingQty']) as BigInt;
        final cost = (deal['costUc'] ?? deal['entryCostUc']) as BigInt?;
        safetyUsed += (deal['safetyOrdersUsed'] as int?) ?? 0;
        var uc = BigInt.zero;
        if (qty > BigInt.zero) {
          if (markUc == null) {
            unmarked = true;
          } else {
            uc = b.valueOf(qty, markUc, b.decimalsFor(base, bot.config['decimals'] as Map<String, dynamic>?)) -
                (cost ?? BigInt.zero);
          }
        }
        unrealizedUc += uc;
        openDeals.add({
          'pair': pair, 'type': deal['type'], 'status': deal['status'],
          'avgEntryUsd': b.ucToUsd(deal['avgEntryUc'] as BigInt?),
          'filledQty': qty.toString(),
          'safetyOrdersUsed': (deal['safetyOrdersUsed'] as int?) ?? 0,
          'unrealizedUsd': markUc != null ? b.ucToUsd(uc) : null,
        });
      }
    }
    // PLANNER / SCANNER HOLDINGS (§4): scanner (sniper) + indicator/momentum bots
    // don't open byPair "deals" — their executed buys accrue into plannerPos. Surface
    // each held asset as an ACTIVE position so the UI shows what the bot is holding
    // (otherwise an AI-picks bot that IS trading looks idle). Value + unrealized when
    // a live mark exists; else just units + cost basis (never a fabricated mark).
    final holdings = <Map<String, dynamic>>[];
    final pos = (bot.state['plannerPos'] as Map?)?.cast<String, dynamic>() ?? const {};
    for (final sym in pos.keys) {
      final units = _posUnits(pos, sym);
      if (units <= BigInt.zero) continue;
      final up = sym.toUpperCase();
      final dec = b.decimalsFor(up, bot.config['decimals'] as Map<String, dynamic>?);
      final costUc = _posCostUc(pos, sym);
      BigInt? markUc;
      if (marks[up] != null) markUc = b.microUsd(marks[up]!);
      num? valueUsd, unrealUsd;
      if (markUc != null) {
        final valUc = b.valueOf(units, markUc, dec);
        valueUsd = b.ucToUsd(valUc);
        if (costUc > BigInt.zero) {
          unrealUsd = b.ucToUsd(valUc - costUc);
          unrealizedUc += valUc - costUc;
        }
      } else {
        unmarked = true;
      }
      holdings.add({
        'symbol': up, 'units': units.toString(), 'decimals': dec,
        'costUsd': costUc > BigInt.zero ? b.ucToUsd(costUc) : null,
        'markUsd': markUc != null ? b.ucToUsd(markUc) : null,
        'valueUsd': valueUsd, 'unrealizedUsd': unrealUsd,
      });
    }

    final dealCount = bot.state['dealCount'] as int? ?? 0;
    final wins = bot.state['winCount'] as int? ?? 0;
    return {
      'holdings': holdings,
      'bot': bot.id, 'name': bot.name, 'type': bot.type, 'mode': bot.mode, 'enabled': bot.enabled, 'network': bot.network,
      'status': _killed ? 'killed' : (bot.enabled ? 'running' : 'paused'),
      'allocationUsd': bot.allocationUsd,
      'lane': bot.lane, 'riskMode': bot.riskMode, 'profitMode': bot.profitMode,
      // The effective deploy cap (budget, + realized profit when compounding).
      'effectiveCapUsd': b.ucToUsd(_effectiveCapUc(bot)),
      'committedUsd': b.ucToUsd((bot.state['committedUc'] as BigInt?) ?? BigInt.zero),
      // remaining budget shown whenever one is set (live always; paper when a budget was given)
      'remainingUsd': (bot.mode == 'live' || bot.allocationUsd > 0)
          ? b.ucToUsd(_effectiveCapUc(bot) - ((bot.state['committedUc'] as BigInt?) ?? BigInt.zero))
          : null,
      'activeDeals': openDeals,
      'safetyOrdersUsed': safetyUsed,
      'realizedUsd': b.ucToUsd((bot.state['realizedUc'] as BigInt?) ?? BigInt.zero),
      // null => an open position has no live mark yet ("awaiting market data").
      'unrealizedUsd': unmarked ? null : b.ucToUsd(unrealizedUc),
      'totalDeals': dealCount,
      'winCount': wins, 'lossCount': bot.state['lossCount'] as int? ?? 0,
      'winRate': dealCount > 0 ? wins / dealCount : null,
      'maxDrawdownUsd': b.ucToUsd((bot.state['maxDrawdownUc'] as BigInt?) ?? BigInt.zero),
      // Liveness affordance (§15): when the bot last advanced and its tick cadence,
      // so the UI can show "updated Xs ago · every Ns". 0 => not yet ticked.
      'lastTickAt': bot.state['lastTickAt'] as int? ?? 0,
      'pollSec': bot.pollSec,
      // Risk circuit-breaker state, if one tripped (for a warning chip).
      'haltReason': bot.state['haltReason'],
      // Last hard-failure reason while running (null once a trade succeeds).
      'lastError': bot.state['lastError'],
      // The scanner's most recent scan (worthy picks it traded / is holding) so the
      // AI-picks cockpit can show what it chose. null for non-scanner bots.
      'lastScan': bot.state['lastScan'],
      // One number the UI can trust for "is this bot doing anything": open deals +
      // planner/scanner holdings currently held.
      'activeCount': openDeals.length + holdings.length,
    };
  }

  Map<String, dynamic> aggregate() {
    var realizedUc = BigInt.zero;
    final rows = <Map<String, dynamic>?>[];
    for (final bot in store.list()) {
      realizedUc += (bot.state['realizedUc'] as BigInt?) ?? BigInt.zero;
      rows.add(dashboard(bot.id));
    }
    return {'realizedUsd': b.ucToUsd(realizedUc), 'bots': rows, 'killed': _killed};
  }

  bool get killed => _killed;
}
