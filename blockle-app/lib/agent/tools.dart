// agent/tools.dart — the tool ALLOWLIST (Dart port of
// blockle-extension/agent/tools.js). The agent can call only tools defined
// here; anything else is rejected by policy.dart before execution. There is no
// shell / eval / arbitrary-RPC tool.
//
// Each tool declares a typed JSON-schema `parameters`, a `valueMoving` flag, and
// a handler that routes to a ChainAdapter, the embedded ExchangeClient, or the
// SDK. Two handler shapes, both enforced by the runner:
//   - read / non-value tools:  run(args) -> result
//   - value-moving tools:      prepare(args) -> PreparedAction { summary, value,
//                              commit, [fee, feeValue, commitFee] }
//       prepare() BUILDS (and signs) but does NOT broadcast; commit() executes.
//
// All amounts are BASE-UNIT decimal strings. A tool that needs a capability the
// host didn't wire throws a clear error (surfaced to the model as a tool error).

import 'policy.dart' show SpendValue;
import '../multichain/venues.dart' show VenueRegistry, Venue, FeeDescriptor;

/// Exchange client surface (nullable closures — a wallet build wires what it
/// supports; an unwired capability surfaces a clean tool error).
class ExchangeLike {
  final Future<Map<String, dynamic>> Function(
      String from, String to, String amount, Map<String, dynamic> opts)? quote;
  final Future<dynamic> Function()? getMarkets;
  final Future<dynamic> Function(String market)? getBook;
  final Future<dynamic> Function(String market)? getTrades;
  final Future<Map<String, dynamic>> Function(Map<String, dynamic> order)? placeOrder;
  final Future<dynamic> Function(String orderId)? cancelOrder;
  final Future<Map<String, dynamic>> Function(String usdc,
      [dynamic a, Map<String, dynamic>? proof])? buyBlock;
  final Future<Map<String, dynamic>> Function(
      String blockAmount, Map<String, dynamic> opts)? sellBlock;
  final Future<Map<String, dynamic>> Function(Map<String, dynamic> req)? listAsset;
  final Future<Map<String, dynamic>> Function(dynamic asset, List extraPairs)? listingQuote;
  final Future<Map<String, dynamic>> Function(
      String from, String to, String amount, Map<String, dynamic> opts)? swap;

  const ExchangeLike({
    this.quote,
    this.getMarkets,
    this.getBook,
    this.getTrades,
    this.placeOrder,
    this.cancelOrder,
    this.buyBlock,
    this.sellBlock,
    this.listAsset,
    this.listingQuote,
    this.swap,
  });
}

/// Native AMM surface.
class AmmLike {
  final Future<Map<String, dynamic>> Function(
      String token, String blockAmt, String tokenAmt)? createPool;
  final Future<Map<String, dynamic>> Function(
      String token, String blockAmt, String tokenMax)? addLiquidity;
  final Future<Map<String, dynamic>> Function(String token, String shares)? removeLiquidity;
  const AmmLike({this.createPool, this.addLiquidity, this.removeLiquidity});
}

/// The injected wiring. Every field is optional; a tool that needs an unwired
/// capability throws "capability not available in this wallet build".
class AgentContext {
  final Future<dynamic> Function(String chain)? getAddress;
  final Future<dynamic> Function(String chain, [dynamic tokens])? getBalance;
  final Future<dynamic> Function()? listAssets;
  final Future<Map<String, dynamic>> Function(String chain, Map<String, dynamic> req)? buildSend;
  final Future<Map<String, dynamic>> Function(String chain, Map<String, dynamic> built)? broadcast;
  final String? Function(String chain, String? txid)? explorerTx;
  final Future<num?> Function(String asset, String amount)? estimateUsd;
  final ExchangeLike? exchange;
  final VenueRegistry? venues;
  final Future<Map<String, dynamic>> Function(Map<String, dynamic> built)? executeSwap;
  final Future<Map<String, dynamic>> Function(Map<String, dynamic> feeXfer)? sendFee;
  final AmmLike? amm;
  final Future<dynamic> Function(Map<String, dynamic> spec)? launchToken;
  final Future<Map<String, dynamic>?> Function(dynamic challenge)? payX402Usdc;

  const AgentContext({
    this.getAddress,
    this.getBalance,
    this.listAssets,
    this.buildSend,
    this.broadcast,
    this.explorerTx,
    this.estimateUsd,
    this.exchange,
    this.venues,
    this.executeSwap,
    this.sendFee,
    this.amm,
    this.launchToken,
    this.payX402Usdc,
  });
}

/// What a value-moving tool's prepare() returns. The runner enforces
/// cap-check -> confirm -> commit around this; a tool cannot bypass that.
class PreparedAction {
  final Map<String, dynamic> summary;
  final SpendValue value;
  final Future<dynamic> Function() commit;
  final Map<String, dynamic>? fee; // {bps,chain,asset,amount,treasury}
  final SpendValue? feeValue;
  final Future<dynamic> Function()? commitFee;
  const PreparedAction({
    required this.summary,
    required this.value,
    required this.commit,
    this.fee,
    this.feeValue,
    this.commitFee,
  });
}

class Tool {
  final String name;
  final String description;
  final bool valueMoving;
  final Map<String, dynamic> parameters;
  final Future<dynamic> Function(Map<String, dynamic> args)? run;
  final Future<PreparedAction> Function(Map<String, dynamic> args)? prepare;
  const Tool({
    required this.name,
    required this.description,
    required this.valueMoving,
    required this.parameters,
    this.run,
    this.prepare,
  });
}

class ToolRegistry {
  final List<Tool> all;
  late final Map<String, Tool> _byName;
  ToolRegistry(this.all) {
    _byName = {for (final t in all) t.name: t};
  }
  Tool? get(String name) => _byName[name];
  List<String> names() => all.map((t) => t.name).toList();
  List<Map<String, dynamic>> schemas() => all
      .map((t) => {
            'name': t.name,
            'description': t.description,
            'parameters': t.parameters,
          })
      .toList();
  List<String> valueMovingNames() =>
      all.where((t) => t.valueMoving).map((t) => t.name).toList();
}

String _sym(dynamic asset) =>
    asset is String ? asset : (asset is Map ? (asset['symbol'] ?? 'UNKNOWN') : 'UNKNOWN');

T _need<T>(T? fn, String label) {
  if (fn == null) {
    throw StateError('capability not available in this wallet build: $label');
  }
  return fn;
}

/// Build the tool registry from the injected [ctx]. Mirrors `AgentTools.build`.
ToolRegistry buildTools(AgentContext ctx) {
  Future<num?> usdOf(dynamic asset, dynamic amount) async {
    if (ctx.estimateUsd == null) return null;
    try {
      final v = await ctx.estimateUsd!(_sym(asset), '$amount');
      return v;
    } catch (_) {
      return null;
    }
  }

  String? explorer(String chain, String? txid) =>
      ctx.explorerTx != null ? ctx.explorerTx!(chain, txid) : null;

  // ---- venue routing helpers (used by `swap`) ------------------------------
  Venue pickVenue(VenueRegistry venues, Map<String, dynamic> a) {
    if (a['venue'] != null) {
      final v = venues.get(a['venue'] as String);
      if (v == null) throw StateError('unknown venue: ${a['venue']}');
      return v;
    }
    if (a['chain'] != null) {
      final list = venues.forChain(a['chain']);
      if (list.isNotEmpty) return list.first;
    }
    return venues.get('blockle') ?? venues.list().first;
  }

  Future<Map<String, dynamic>?> accountForVenue(Venue venue, Map<String, dynamic> a) async {
    if (venue.id == 'blockle' || venue.kind == 'native') return null;
    var chain = a['chain'];
    if (chain == null && venue.chains.isNotEmpty) chain = venue.chains.first;
    if (chain == null) return null;
    final address = await _need(ctx.getAddress, 'getAddress')(chain as String);
    return {'address': address, 'chain': chain};
  }

  final tools = <Tool>[];

  // ============================ reads (no value) ==========================

  tools.add(Tool(
    name: 'get_address',
    description:
        "Return this wallet's address for a chain (block, ethereum, base, bitcoin, litecoin, dogecoin).",
    valueMoving: false,
    parameters: {
      'type': 'object',
      'properties': {'chain': {'type': 'string'}},
      'required': ['chain']
    },
    run: (a) => _need(ctx.getAddress, 'getAddress')(a['chain'] as String),
  ));

  tools.add(Tool(
    name: 'get_balance',
    description:
        "Balances for a chain's account (native coin plus any imported tokens). Base units.",
    valueMoving: false,
    parameters: {
      'type': 'object',
      'properties': {
        'chain': {'type': 'string'},
        'tokens': {'type': 'array', 'items': {'type': 'object'}}
      },
      'required': ['chain']
    },
    run: (a) => _need(ctx.getBalance, 'getBalance')(a['chain'] as String, a['tokens']),
  ));

  tools.add(Tool(
    name: 'list_assets',
    description: 'List the assets this wallet holds or tracks across enabled chains.',
    valueMoving: false,
    parameters: {'type': 'object', 'properties': {}},
    run: (a) => _need(ctx.listAssets, 'listAssets')(),
  ));

  tools.add(Tool(
    name: 'get_markets',
    description: 'List exchange markets (base/quote pairs) on the non-custodial exchange.',
    valueMoving: false,
    parameters: {'type': 'object', 'properties': {}},
    run: (a) => _need(ctx.exchange?.getMarkets, 'exchange.getMarkets')(),
  ));

  tools.add(Tool(
    name: 'get_book',
    description: 'Order book (bids/asks) for a market, e.g. BLOCK/USDC.',
    valueMoving: false,
    parameters: {
      'type': 'object',
      'properties': {'market': {'type': 'string'}},
      'required': ['market']
    },
    run: (a) => _need(ctx.exchange?.getBook, 'exchange.getBook')(a['market'] as String),
  ));

  tools.add(Tool(
    name: 'get_trades',
    description: 'Recent fills for a market.',
    valueMoving: false,
    parameters: {
      'type': 'object',
      'properties': {'market': {'type': 'string'}},
      'required': ['market']
    },
    run: (a) => _need(ctx.exchange?.getTrades, 'exchange.getTrades')(a['market'] as String),
  ));

  tools.add(Tool(
    name: 'quote',
    description:
        'Price a swap without executing it. Returns expected out + slippage-adjusted minimum.',
    valueMoving: false,
    parameters: {
      'type': 'object',
      'properties': {
        'from': {'type': 'string'},
        'to': {'type': 'string'},
        'amount': {'type': 'string', 'description': 'base units of `from`'},
        'slippage': {'type': 'number'}
      },
      'required': ['from', 'to', 'amount']
    },
    run: (a) => _need(ctx.exchange?.quote, 'exchange.quote')(
        a['from'] as String, a['to'] as String, '${a['amount']}',
        {'slippage': a['slippage']}),
  ));

  // ========================= value-moving actions =========================

  tools.add(Tool(
    name: 'send',
    description: 'Send a native coin or token to an address. amount is base units.',
    valueMoving: true,
    parameters: {
      'type': 'object',
      'properties': {
        'chain': {'type': 'string'},
        'to': {'type': 'string'},
        'amount': {'type': 'string', 'description': 'base units'},
        'asset': {'type': 'object', 'description': 'AssetRef; omit for the chain native coin'},
        'feeRate': {'type': 'string'},
        'memo': {'type': 'string'}
      },
      'required': ['chain', 'to', 'amount']
    },
    prepare: (a) async {
      final chain = a['chain'] as String;
      final asset = a['asset'] ??
          {'chain': chain, 'kind': 'native', 'symbol': chain.toUpperCase()};
      final built = await _need(ctx.buildSend, 'buildSend')(chain, {
        'asset': asset,
        'to': a['to'],
        'amount': '${a['amount']}',
        'feeRate': a['feeRate'],
        'memo': a['memo'],
      });
      final usd = await usdOf(_sym(asset), a['amount']);
      final summary = {
        'action': 'send',
        'chain': chain,
        'asset': _sym(asset),
        'to': a['to'],
        'amount': '${a['amount']}',
        'fee': built['fee'] != null ? '${built['fee']}' : null,
        'txid': built['txid'],
        'explorer': explorer(chain, built['txid'] as String?),
      };
      return PreparedAction(
        summary: summary,
        value: SpendValue(asset: _sym(asset), amount: '${a['amount']}', usd: usd),
        commit: () => _need(ctx.broadcast, 'broadcast')(chain, built),
      );
    },
  ));

  tools.add(Tool(
    name: 'swap',
    description:
        "Swap one asset for another, routed through the best VENUE — the native Blockle AMM/exchange, an EVM DEX aggregator (0x/1inch-style), or Jupiter on Solana. A non-bypassable 0.05% agent fee is sent on-chain to the treasury for the trade's chain as part of the SAME confirmed action. amount is base units of `from`.",
    valueMoving: true,
    parameters: {
      'type': 'object',
      'properties': {
        'from': {'type': 'string'},
        'to': {'type': 'string'},
        'amount': {'type': 'string'},
        'slippage': {'type': 'number'},
        'chain': {'type': 'string', 'description': 'optional chain hint for the venue'},
        'venue': {
          'type': 'string',
          'enum': ['blockle', 'evmdex', 'jupiter'],
          'description': 'optional venue id; omit to auto-route'
        }
      },
      'required': ['from', 'to', 'amount']
    },
    prepare: (a) async {
      final venues = ctx.venues;

      // No venue registry wired => no treasury to route the mandatory 0.05%
      // agent fee through. Refuse (fail closed) rather than execute a swap that
      // silently skips the fee — the swap tool's non-bypassable-fee contract must
      // hold on EVERY path (see AGENT-STRATEGIES.md section 5).
      if (venues == null) {
        throw StateError(
            'swap refused: no venue registry/treasury wired — the mandatory 0.05% '
            'agent fee cannot be routed (fail closed)');
      }

      final venue = pickVenue(venues, a);
      final account = await accountForVenue(venue, a);
      final built = await venue.buildSwap({
        'from': a['from'],
        'to': a['to'],
        'amount': '${a['amount']}',
        'slippage': a['slippage'],
        'chain': a['chain'],
        'account': account,
      });
      final fee = built['fee'] as FeeDescriptor?;
      final feeXfer = built['feeTransfer'] as Map<String, dynamic>?;
      if (fee == null ||
          feeXfer == null ||
          feeXfer['to'] == null ||
          feeXfer['amount'] == null) {
        throw StateError(
            'swap refused: venue did not produce a routable 0.05% agent fee (fail closed)');
      }
      final usd = await usdOf(a['from'], a['amount']);
      final feeUsd = await usdOf(fee.asset ?? a['from'], fee.amount);
      final summary = {
        'action': 'swap',
        'venue': venue.id,
        'chain': built['chain'],
        'from': built['from'],
        'to': built['to'],
        'amount': '${built['amountIn'] ?? a['amount']}',
        'amountOut': built['amountOut'],
        'minOut': built['minOut'],
        'slippage': a['slippage'],
        'fee': fee.amount,
        'feeAsset': fee.asset,
        'feeBps': fee.bps,
        'feeTo': feeXfer['to'],
      };
      return PreparedAction(
        summary: summary,
        value: SpendValue(asset: a['from'] as String?, amount: '${a['amount']}', usd: usd),
        commit: () => _need(ctx.executeSwap, 'executeSwap')(built),
        fee: {
          'bps': fee.bps,
          'chain': fee.chain,
          'asset': fee.asset,
          'amount': fee.amount,
          'treasury': feeXfer['to'],
        },
        feeValue: SpendValue(
            asset: (fee.asset ?? a['from']) as String?,
            amount: fee.amount,
            usd: feeUsd),
        commitFee: () => _need(ctx.sendFee, 'sendFee')(feeXfer),
      );
    },
  ));

  tools.add(Tool(
    name: 'place_order',
    description:
        'Place a signed limit/market order on the exchange. amount + price are base units.',
    valueMoving: true,
    parameters: {
      'type': 'object',
      'properties': {
        'market': {'type': 'string'},
        'side': {'type': 'string', 'enum': ['buy', 'sell']},
        'amount': {'type': 'string'},
        'type': {'type': 'string', 'enum': ['limit', 'market']},
        'price': {'type': 'string'},
        'expiry': {'type': 'number'}
      },
      'required': ['market', 'side', 'amount']
    },
    prepare: (a) async {
      final market = a['market'] as String;
      final usd = await usdOf(market.split('/')[0], a['amount']);
      return PreparedAction(
        summary: {
          'action': 'place_order',
          'market': market,
          'side': a['side'],
          'type': a['type'] ?? 'limit',
          'amount': '${a['amount']}',
          'price': a['price'],
        },
        value: SpendValue(asset: market.split('/')[0], amount: '${a['amount']}', usd: usd),
        commit: () => _need(ctx.exchange?.placeOrder, 'exchange.placeOrder')({
          'market': market,
          'side': a['side'],
          'amount': '${a['amount']}',
          'type': a['type'],
          'price': a['price'],
          'expiry': a['expiry'],
        }),
      );
    },
  ));

  tools.add(Tool(
    name: 'cancel_order',
    description:
        'Cancel one of your resting orders (signed cancel). No funds move, but it is an authenticated action.',
    valueMoving: true,
    parameters: {
      'type': 'object',
      'properties': {'orderId': {'type': 'string'}},
      'required': ['orderId']
    },
    prepare: (a) async {
      return PreparedAction(
        summary: {'action': 'cancel_order', 'orderId': a['orderId']},
        value: const SpendValue(asset: null, amount: '0', usd: 0),
        commit: () => _need(ctx.exchange?.cancelOrder, 'exchange.cancelOrder')(a['orderId'] as String),
      );
    },
  ));

  tools.add(Tool(
    name: 'buy_block',
    description:
        'Buy BLOCK with USDC over the x402 rail. usdc is base units (6 dp). Delivered to this wallet. When the seller returns an x402 payment challenge, the wallet settles it by signing a USDC transfer on Base/Ethereum.',
    valueMoving: true,
    parameters: {
      'type': 'object',
      'properties': {'usdc': {'type': 'string'}},
      'required': ['usdc']
    },
    prepare: (a) async {
      final usd = (double.tryParse('${a['usdc']}') ?? 0) / 1e6;
      return PreparedAction(
        summary: {'action': 'buy_block', 'usdc': '${a['usdc']}', 'usdEquivalent': usd},
        value: SpendValue(asset: 'USDC', amount: '${a['usdc']}', usd: usd),
        commit: () async {
          final ex = ctx.exchange ?? const ExchangeLike();
          final buy = _need(ex.buyBlock, 'exchange.buyBlock');
          final first = await buy('${a['usdc']}');
          if (first['paymentRequired'] != true) return first;
          if (ctx.payX402Usdc == null) return first;
          Map<String, dynamic>? pay;
          try {
            pay = await ctx.payX402Usdc!(first['challenge']);
          } catch (_) {
            pay = null;
          }
          if (pay == null || pay['paymentTxid'] == null) return first;
          Map<String, dynamic>? settled;
          try {
            settled = await buy('${a['usdc']}', null,
                {'paymentTxid': pay['paymentTxid'], 'payment': pay});
          } catch (_) {}
          return {
            'paid': true,
            'paymentTxid': pay['paymentTxid'],
            'chain': pay['chain'],
            'explorer': explorer(pay['chain'] as String? ?? '', pay['paymentTxid'] as String?),
            'settlement': settled,
            if (settled == null) 'challenge': first['challenge'],
          };
        },
      );
    },
  ));

  tools.add(Tool(
    name: 'sell_block',
    description:
        'Sell BLOCK back for USDC (non-custodial): send to the reserve, settle USDC to your Base address. blockAmount is base units.',
    valueMoving: true,
    parameters: {
      'type': 'object',
      'properties': {
        'blockAmount': {'type': 'string'},
        'userUsdcAddr': {'type': 'string'}
      },
      'required': ['blockAmount']
    },
    prepare: (a) async {
      final usd = await usdOf('BLOCK', a['blockAmount']);
      return PreparedAction(
        summary: {
          'action': 'sell_block',
          'blockAmount': '${a['blockAmount']}',
          'userUsdcAddr': a['userUsdcAddr']
        },
        value: SpendValue(asset: 'BLOCK', amount: '${a['blockAmount']}', usd: usd),
        commit: () => _need(ctx.exchange?.sellBlock, 'exchange.sellBlock')(
            '${a['blockAmount']}', {'userUsdcAddr': a['userUsdcAddr']}),
      );
    },
  ));

  tools.add(Tool(
    name: 'launch_token',
    description:
        'Launch a BLOCK-20 token (deploy + init mints the supply to you). supply is in WHOLE tokens.',
    valueMoving: true,
    parameters: {
      'type': 'object',
      'properties': {
        'name': {'type': 'string'},
        'symbol': {'type': 'string'},
        'decimals': {'type': 'integer'},
        'supply': {'type': 'string'}
      },
      'required': ['name', 'symbol', 'decimals', 'supply']
    },
    prepare: (a) async {
      return PreparedAction(
        summary: {
          'action': 'launch_token',
          'name': a['name'],
          'symbol': a['symbol'],
          'decimals': a['decimals'],
          'supply': '${a['supply']}'
        },
        value: const SpendValue(asset: 'BLOCK', amount: '0', usd: null),
        commit: () => _need(ctx.launchToken, 'launchToken')({
          'name': a['name'],
          'symbol': a['symbol'],
          'decimals': a['decimals'],
          'supply': '${a['supply']}'
        }),
      );
    },
  ));

  tools.add(Tool(
    name: 'create_pool',
    description:
        'Create the AMM pool for a token with initial BLOCK + token liquidity. base units.',
    valueMoving: true,
    parameters: {
      'type': 'object',
      'properties': {
        'token': {'type': 'string'},
        'blockAmt': {'type': 'string'},
        'tokenAmt': {'type': 'string'}
      },
      'required': ['token', 'blockAmt', 'tokenAmt']
    },
    prepare: (a) async {
      final usd = await usdOf('BLOCK', a['blockAmt']);
      return PreparedAction(
        summary: {
          'action': 'create_pool',
          'token': a['token'],
          'blockAmt': '${a['blockAmt']}',
          'tokenAmt': '${a['tokenAmt']}'
        },
        value: SpendValue(asset: 'BLOCK', amount: '${a['blockAmt']}', usd: usd),
        commit: () => _need(ctx.amm?.createPool, 'amm.createPool')(
            a['token'] as String, '${a['blockAmt']}', '${a['tokenAmt']}'),
      );
    },
  ));

  tools.add(Tool(
    name: 'add_liquidity',
    description: 'Add liquidity: deposit blockAmt BLOCK plus up to tokenMax token. base units.',
    valueMoving: true,
    parameters: {
      'type': 'object',
      'properties': {
        'token': {'type': 'string'},
        'blockAmt': {'type': 'string'},
        'tokenMax': {'type': 'string'}
      },
      'required': ['token', 'blockAmt', 'tokenMax']
    },
    prepare: (a) async {
      final usd = await usdOf('BLOCK', a['blockAmt']);
      return PreparedAction(
        summary: {
          'action': 'add_liquidity',
          'token': a['token'],
          'blockAmt': '${a['blockAmt']}',
          'tokenMax': '${a['tokenMax']}'
        },
        value: SpendValue(asset: 'BLOCK', amount: '${a['blockAmt']}', usd: usd),
        commit: () => _need(ctx.amm?.addLiquidity, 'amm.addLiquidity')(
            a['token'] as String, '${a['blockAmt']}', '${a['tokenMax']}'),
      );
    },
  ));

  tools.add(Tool(
    name: 'remove_liquidity',
    description: "Remove `shares` LP from a token's pool (subject to the on-chain lock). base units.",
    valueMoving: true,
    parameters: {
      'type': 'object',
      'properties': {
        'token': {'type': 'string'},
        'shares': {'type': 'string'}
      },
      'required': ['token', 'shares']
    },
    prepare: (a) async {
      return PreparedAction(
        summary: {'action': 'remove_liquidity', 'token': a['token'], 'shares': '${a['shares']}'},
        value: SpendValue(asset: 'LP', amount: '${a['shares']}', usd: null),
        commit: () => _need(ctx.amm?.removeLiquidity, 'amm.removeLiquidity')(
            a['token'] as String, '${a['shares']}'),
      );
    },
  ));

  tools.add(Tool(
    name: 'list_asset',
    description:
        'List a new tradeable asset on the exchange (pays the listing fee non-custodially to the relay treasury).',
    valueMoving: true,
    parameters: {
      'type': 'object',
      'properties': {
        'asset': {'type': 'object'},
        'extraPairs': {'type': 'array', 'items': {'type': 'string'}},
        'payWith': {'type': 'string'}
      },
      'required': ['asset']
    },
    prepare: (a) async {
      final ex = ctx.exchange ?? const ExchangeLike();
      Map<String, dynamic>? quote;
      if (ex.listingQuote != null) {
        try {
          quote = await ex.listingQuote!(a['asset'], (a['extraPairs'] as List?) ?? const []);
        } catch (_) {}
      }
      return PreparedAction(
        summary: {
          'action': 'list_asset',
          'asset': a['asset'],
          'extraPairs': a['extraPairs'] ?? [],
          'payWith': a['payWith'] ?? 'block',
          'quote': quote,
        },
        value: SpendValue(
          asset: (a['payWith'] ?? 'BLOCK') as String?,
          amount: '0',
          usd: quote != null && quote['totalUsd'] != null ? (quote['totalUsd'] as num) : null,
        ),
        commit: () => _need(ex.listAsset, 'exchange.listAsset')({
          'asset': a['asset'],
          'extraPairs': a['extraPairs'],
          'payWith': a['payWith'],
        }),
      );
    },
  ));

  return ToolRegistry(tools);
}
