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

import 'bots.dart' as b;
import 'pnl.dart' show PnlHook;
import 'policy.dart';
import 'runner.dart' show dispatchValueMoving, DispatchOutcome;
import 'strategies.dart' show StrategyContext, Strategy, defaultStrategies;
import 'tools.dart' show ToolRegistry;

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

  const BotContext({this.now, this.network, this.prices, this.discovery, this.strategyCtx});
}

class BotRunner {
  final Policy policy;
  final ToolRegistry tools;
  final dynamic audit;
  final BotContext ctx;
  final bool mainnetEnabled;
  final void Function(Map<String, dynamic> ev)? onEvent;
  final PnlHook? pnl;
  final b.BotStore store;
  final dynamic discovery;
  final String wallet;
  final String channel;
  final Map<String, Strategy> strategies;
  bool _killed = false;

  BotRunner({
    required this.policy,
    required this.tools,
    this.audit,
    BotContext? ctx,
    this.mainnetEnabled = false,
    this.onEvent,
    this.pnl,
    b.BotStore? store,
    dynamic persist,
    dynamic discovery,
    String? wallet,
    String? channel,
    Map<String, Strategy>? strategies,
  })  : ctx = ctx ?? const BotContext(),
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

  // ---- bot lifecycle ------------------------------------------------------
  b.Bot add(dynamic spec) => store.add(spec);
  b.Bot? get(String id) => store.get(id);
  List<b.Bot> list() => store.list();

  /// Arm a bot LIVE (§5). Fail-closed: requires a finite allocationUsd in (0, sessionCap].
  Future<b.Bot> armLive(String id, {num? allocationUsd}) async {
    final bot = store.get(id);
    if (bot == null) throw ArgumentError('unknown bot: $id');
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
    bot.allocationUsd = alloc;
    bot.mode = 'live';
    bot.enabled = true;
    await _audit({'type': 'bot_armed', 'bot': id, 'mode': 'live', 'allocationUsd': alloc, 'network': bot.network});
    emit({'type': 'bot_armed', 'bot': id, 'mode': 'live', 'allocationUsd': alloc});
    await store.persist();
    return bot;
  }

  Future<b.Bot> enablePaper(String id) async {
    final bot = store.get(id);
    if (bot == null) throw ArgumentError('unknown bot: $id');
    bot.mode = 'paper';
    bot.enabled = true;
    await _audit({'type': 'bot_armed', 'bot': id, 'mode': 'paper'});
    await store.persist();
    return bot;
  }

  Future<b.Bot?> pause(String id) async {
    final bot = store.get(id);
    if (bot != null) {
      bot.enabled = false;
      await _audit({'type': 'bot_paused', 'bot': id});
      await store.persist();
    }
    return bot;
  }

  // ---- KILL (§5): stop ALL bots, best-effort cancel open orders, lock vault --
  Future<void> killAll([String? reason]) async {
    _killed = true;
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

    Map<String, dynamic> report;
    try {
      if (bot.type == 'rebalance' || bot.type == 'momentum') {
        report = await _tickScheduled(bot, now);
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
    await store.persist();
    return report;
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
        if (fill == null) break; // skipped/blocked/declined — stop this pair's cascade
        fill['bd'] = bd;
        _engineApply(type, deal, bcfg, cfg, order, fill, now);
        events.add({
          'pair': pair, 'action': order['kind'], 'side': order['side'],
          'qty': (fill['qty'] as BigInt).toString(), 'priceUc': (fill['priceUc'] as BigInt).toString(),
          'paper': fill['paper'] == true,
        });

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
    } else if (r < BigInt.zero) {
      bot.state['lossCount'] = (bot.state['lossCount'] as int) + 1;
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

      // --- allocation gate (LIVE buys only; BigInt-exact, non-bypassable) ---
      BigInt? remainingUc;
      if (bot.mode == 'live') {
        final allocUc = b.microUsd(bot.allocationUsd);
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
        await _audit({
          'type': 'bot_paper_fill', 'bot': bot.id, 'side': 'buy', 'kind': order['kind'],
          'pair': '${m['base']}/${m['quote']}', 'qty': qty.toString(), 'priceUc': execPriceUc.toString(), 'costUc': costUc.toString(),
        });
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
              'venue': _venue(bot),
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
        : {'from': m['base'], 'to': m['quote'], 'amount': qty.toString(), 'venue': _venue(bot)};
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
      List<dynamic> cands = const [];
      try {
        cands = List<dynamic>.from(await discovery.scan());
      } catch (_) {
        cands = const [];
      }
      for (final c in cands) {
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
      }
    } catch (_) {}
    return null;
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

  // ---- scheduled bots (rebalance / momentum) reuse the strategy planners ----
  Future<Map<String, dynamic>> _tickScheduled(b.Bot bot, int now) async {
    final strat = strategies[bot.type];
    final sctx = ctx.strategyCtx;
    if (strat == null) return {'bot': bot.id, 'error': 'no strategy ${bot.type}'};
    if (sctx == null) return {'bot': bot.id, 'error': 'no strategy ctx for ${bot.type}'};
    final params = strat.validateParams({...bot.config});
    final intents = await strat.plan(sctx, params);
    final ctxMainnet = _ctxMainnet();
    final events = <Map<String, dynamic>>[];
    for (final it in intents) {
      if (policy.isKilled()) break;
      if (bot.mode == 'live') {
        // FIX-EST: a LIVE scheduled order must carry a FINITE, POSITIVE USD estimate
        // or it FAILS CLOSED. null/NaN/Infinity would coerce to $0 and slip past the
        // cap; a NEGATIVE estimate would even accrue negative and EXPAND the
        // allocation ledger — both bypass the hard cap, so reject all.
        if (it.estUsd == null || !it.estUsd!.isFinite || it.estUsd! <= 0) {
          await _audit({'type': 'bot_skip', 'bot': bot.id, 'reason': 'allocation-unknown', 'tag': it.tag});
          events.add({'tag': it.tag, 'skipped': 'allocation-unknown'});
          continue;
        }
        final estUsdUc = b.microUsd(it.estUsd);
        final feeUc = b.agentFeeUc(estUsdUc); // allocation bounds the trade + 0.05% fee
        final remainingUc = b.microUsd(bot.allocationUsd) - ((bot.state['committedUc'] as BigInt?) ?? BigInt.zero);
        if (estUsdUc + feeUc > remainingUc) {
          await _audit({'type': 'bot_skip', 'bot': bot.id, 'reason': 'allocation', 'tag': it.tag});
          events.add({'tag': it.tag, 'skipped': 'allocation'});
          continue;
        }
        if ((it.mainnet || ctxMainnet) && !mainnetEnabled) {
          await _audit({'type': 'bot_skip', 'bot': bot.id, 'reason': 'mainnet', 'tag': it.tag});
          events.add({'tag': it.tag, 'skipped': 'mainnet'});
          continue;
        }
        if (!_allowed(it.tool)) {
          await _audit({'type': 'bot_blocked', 'bot': bot.id, 'tool': it.tool});
          events.add({'tag': it.tag, 'blocked': true});
          continue;
        }
        final r = await _dispatch(bot, it.tool, it.args, remainingUc);
        if (r['rejected'] != true && r['result'] != null) {
          bot.state['committedUc'] = ((bot.state['committedUc'] as BigInt?) ?? BigInt.zero) + estUsdUc + feeUc;
          events.add({'tag': it.tag, 'executed': true});
        } else {
          events.add({'tag': it.tag, 'rejected': r['reason']});
        }
      } else {
        if ((it.mainnet || ctxMainnet) && !mainnetEnabled) {
          events.add({'tag': it.tag, 'skipped': 'mainnet'});
          continue;
        }
        await _audit({'type': 'bot_paper_intent', 'bot': bot.id, 'tag': it.tag, 'estUsd': it.estUsd});
        events.add({'tag': it.tag, 'paper': true});
      }
    }
    return {'bot': bot.id, 'type': bot.type, 'events': events};
  }

  // ===========================================================================
  // per-bot dashboard DATA (§4) — accessors only, no UI.
  // ===========================================================================
  Map<String, dynamic>? dashboard(String id, [Map<String, num>? marksOverride]) {
    final bot = store.get(id);
    if (bot == null) return null;
    final openDeals = <Map<String, dynamic>>[];
    var unrealizedUc = BigInt.zero;
    var safetyUsed = 0;
    final byPair = (bot.state['byPair'] as Map?) ?? const {};
    for (final pair in byPair.keys) {
      final ps = byPair[pair] as Map?;
      final deal = ps?['deal'] as Map?;
      if (deal == null || deal['status'] == 'closed') continue;
      final base = b.splitPair('$pair')[0];
      BigInt? markUc;
      if (marksOverride != null && marksOverride[base] != null) markUc = b.microUsd(marksOverride[base]);
      if (deal['type'] == 'grid') {
        var uc = BigInt.zero;
        for (final lv in (deal['levels'] as List)) {
          final held = (lv as Map)['heldQty'] as BigInt;
          if (held > BigInt.zero && markUc != null) {
            uc += b.valueOf(held, markUc, b.decimalsFor(base, bot.config['decimals'] as Map<String, dynamic>?)) -
                ((lv['_costUc'] as BigInt?) ?? BigInt.zero);
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
        if (markUc != null && qty > BigInt.zero) {
          uc = b.valueOf(qty, markUc, b.decimalsFor(base, bot.config['decimals'] as Map<String, dynamic>?)) -
              (cost ?? BigInt.zero);
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
    final dealCount = bot.state['dealCount'] as int? ?? 0;
    final wins = bot.state['winCount'] as int? ?? 0;
    return {
      'bot': bot.id, 'name': bot.name, 'type': bot.type, 'mode': bot.mode, 'enabled': bot.enabled, 'network': bot.network,
      'status': _killed ? 'killed' : (bot.enabled ? 'running' : 'paused'),
      'allocationUsd': bot.allocationUsd,
      'committedUsd': b.ucToUsd((bot.state['committedUc'] as BigInt?) ?? BigInt.zero),
      'remainingUsd': bot.mode == 'live'
          ? b.ucToUsd(b.microUsd(bot.allocationUsd) - ((bot.state['committedUc'] as BigInt?) ?? BigInt.zero))
          : null,
      'activeDeals': openDeals,
      'safetyOrdersUsed': safetyUsed,
      'realizedUsd': b.ucToUsd((bot.state['realizedUc'] as BigInt?) ?? BigInt.zero),
      'unrealizedUsd': b.ucToUsd(unrealizedUc),
      'totalDeals': dealCount,
      'winCount': wins, 'lossCount': bot.state['lossCount'] as int? ?? 0,
      'winRate': dealCount > 0 ? wins / dealCount : null,
      'maxDrawdownUsd': b.ucToUsd((bot.state['maxDrawdownUc'] as BigInt?) ?? BigInt.zero),
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
