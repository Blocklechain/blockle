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

import '../agent/audit.dart';
import '../agent/bots.dart' as b;
import '../agent/bot_runner.dart';
import '../agent/bot_templates.dart' as tpl;
import '../agent/arena.dart' as ar;
import '../agent/index.dart' show AgentInstance;
import '../agent/notify.dart';
import '../agent/pnl.dart';
import '../agent/policy.dart';
import '../agent/signals_discovery.dart' show SignalsDiscovery;
import '../agent/tools.dart' show ToolRegistry;
import '../services/agent_service.dart' show SecureChannelStore;
import '../services/exchange_client.dart' show ExchangeClient, ExchangeMarket;
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

  /// Whether a live bot can be armed right now (a real gated channel is up).
  bool get canGoLive => _backingInstance() != null;

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

  void _rebuildRunner() {
    // Cancel the outgoing runner's scheduler so a rebuild (e.g. a channel
    // connecting) never leaves an orphaned timer ticking the old instance.
    _runner?.stopScheduler();
    final inst = _backingInstance();
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
      ),
      mainnetEnabled: false,
      onEvent: _onEvent,
      pnl: pnl,
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
  // Feed the engine a per-symbol USD unit price derived from the wallet's
  // EXISTING live market data — the non-custodial Blockle Exchange
  // (getMarkets/getBook/getTrades), the SAME source the agent runner ctx is
  // wired to. The mark for a symbol is its BASE/QUOTE market's book mid (best
  // bid/ask), falling back to the last trade, then the market's last price, all
  // converted to USD through the quote symbol (stablecoins = $1).
  //
  // NO SYNTHETIC PRICES: a symbol the Exchange can't price is simply omitted, so
  // `_unitUc` finds no mark and the engine skips that tick (audited `skipped`).
  // The Exchange client itself is best-effort (returns [] / null on any network
  // error) so a genuinely-unavailable market degrades to a clean skip, never a
  // fabricated fill.

  /// Stablecoins pin to $1 (mirrors the engine's `_stableUsd` set).
  static const Set<String> _stableSyms = {
    'USDC', 'USDT', 'DAI', 'USD', 'USDBC', 'USDB', 'PYUSD', 'TUSD',
  };

  Future<Map<String, num>> _prices(List<String> symbols) async {
    final wanted = <String>{for (final s in symbols) s};
    if (wanted.isEmpty) return const {};

    final ExchangeClient ex = _mc.exchange;
    final List<ExchangeMarket> markets = await ex.getMarkets();
    if (markets.isEmpty) return const {}; // exchange unavailable -> no marks

    final out = <String, num>{};
    for (final sym in wanted) {
      final usd = await _usdMark(sym, markets, ex, const <String>{});
      if (usd != null && usd.isFinite && usd > 0) out[sym] = usd;
    }
    return out;
  }

  /// USD unit price for [sym]: stable -> $1; else the best BASE/QUOTE market's
  /// book mid / last trade, converted through the quote's own USD price. Returns
  /// null when the Exchange has no data to price it (never a synthetic value).
  /// [seen] guards against cyclic quote chains (e.g. A/B priced via B/A).
  Future<num?> _usdMark(
    String sym,
    List<ExchangeMarket> markets,
    ExchangeClient ex,
    Set<String> seen,
  ) async {
    final up = sym.toUpperCase();
    if (_stableSyms.contains(up)) return 1;
    if (seen.contains(up)) return null;

    // Candidate markets where this symbol is the BASE; prefer a stablecoin quote
    // (direct USD), then any quote we can price transitively.
    final candidates = markets.where((m) => m.base.toUpperCase() == up).toList()
      ..sort((a, c) {
        final ai = _stableSyms.contains(a.quote.toUpperCase()) ? 0 : 1;
        final ci = _stableSyms.contains(c.quote.toUpperCase()) ? 0 : 1;
        return ai.compareTo(ci);
      });

    for (final m in candidates) {
      final markInQuote = await _markInQuote(m, ex);
      if (markInQuote == null || markInQuote <= 0) continue;
      final quoteUsd = await _usdMark(m.quote, markets, ex, {...seen, up});
      if (quoteUsd == null || quoteUsd <= 0) continue;
      return markInQuote * quoteUsd;
    }
    return null;
  }

  /// A single market's mark in QUOTE units: book mid (best bid+ask)/2, else the
  /// best single side, else the most recent trade, else the market's last price.
  Future<num?> _markInQuote(ExchangeMarket m, ExchangeClient ex) async {
    final book = await ex.getBook(m.id);
    if (book != null) {
      final num? bid = book.bids.isNotEmpty ? book.bids.first.price : null;
      final num? ask = book.asks.isNotEmpty ? book.asks.first.price : null;
      if (bid != null && ask != null && bid > 0 && ask > 0) return (bid + ask) / 2;
      if (ask != null && ask > 0) return ask;
      if (bid != null && bid > 0) return bid;
    }
    final trades = await ex.getTrades(m.id);
    if (trades.isNotEmpty) {
      final p = _asNum(trades.first['price'] ?? trades.first['px'] ?? trades.first['rate']);
      if (p != null && p > 0) return p;
    }
    if (m.last != null && m.last! > 0) return m.last;
    return null;
  }

  static num? _asNum(dynamic v) {
    if (v == null) return null;
    if (v is num) return v;
    return num.tryParse('$v');
  }

  void _onNotify(AgentNotification n) {
    notifications.insert(0, n);
    if (notifications.length > 20) notifications.removeRange(20, notifications.length);
    notifyListeners();
  }

  void _onEvent(Map<String, dynamic> ev) {
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
  }) {
    final spec = tpl.fromTemplate(templateKey, pair: pair, name: name);
    if (configOverride != null) {
      spec['config'] = {
        ...(spec['config'] as Map).cast<String, dynamic>(),
        ...configOverride,
      };
    }
    spec['allocationUsd'] = allocationUsd;
    // LANE + RISK MODE: optional; the Bot constructor validates + nulls unknowns
    // and (when a lane is set) pins chainPrefs to that chain. Null = legacy.
    if (lane != null) spec['lane'] = lane;
    if (riskMode != null) spec['riskMode'] = riskMode;
    final created = _runner!.add(spec);
    _persist();
    notifyListeners();
    return created;
  }

  /// Arm a bot in PAPER mode (simulated fills; never broadcasts). Allocation is
  /// not required for paper; when an [allocationUsd] > 0 is given the paper run is
  /// a bounded sandbox the same size as the real one (the budget depletes).
  Future<void> enablePaper(String id, {num? allocationUsd}) async {
    await _runner!.enablePaper(id, allocationUsd: allocationUsd);
    notifyListeners();
  }

  /// Arm a bot LIVE through the engine's fail-closed gate (BotRunner.armLive):
  /// requires allocationUsd in (0, session cap] and, on mainnet, mainnetEnabled.
  /// The caller MUST have shown the review sheet first; this is the single
  /// confirm action, never a silent flip.
  Future<void> armLive(String id, {required num allocationUsd}) async {
    await _runner!.armLive(id, allocationUsd: allocationUsd);
    notifyListeners();
  }

  Future<void> pause(String id) async {
    await _runner!.pause(id);
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
