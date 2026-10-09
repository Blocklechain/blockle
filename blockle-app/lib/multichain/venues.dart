// venues.dart — the VENUE registry the in-wallet AI agent trades THROUGH
// (Dart port of blockle-extension/venues.js). Three venues ship here:
//
//   • blockle — the NATIVE Blockle rail: AMM + non-custodial exchange + x402.
//   • evmdex  — an EVM DEX aggregator (0x/1inch-style): quote + router-call tx.
//   • jupiter — Solana's Jupiter aggregator: quote + serialized swap tx.
//
// EVERY venue speaks the SAME two methods:
//   quote(from, to, amount, opts)  -> Quote       [READ-ONLY, no signing]
//   buildSwap(req)                 -> BuiltSwap    [builds a tx; NEVER signs,
//                                                    NEVER sends]
//
// THE 0.05% AGENT TRADE FEE (non-bypassable, audit-logged):
//   feeBps is read from exchange/treasury.json (agentTradeFeeBps = 5 = 0.05%).
//   On EVERY agent-executed swap we skim 0.05% of the trade's INPUT amount and
//   produce a FEE TRANSFER to the treasury address for THAT TRADE'S CHAIN.
//   Fail-closed: if no treasury address is configured for a trade's chain we
//   THROW rather than silently skip the fee or send to an empty address.
//
// All amounts are BASE-UNIT decimal strings; fee math is exact BigInt.

import 'dart:convert';

/// Injectable HTTP transport (keeps the venues testable with no real network).
typedef VenueRequest = Future<dynamic> Function({
  required String method,
  required String url,
  Map<String, String>? headers,
  dynamic body,
});

final BigInt _bpsDenom = BigInt.from(10000);

BigInt _bigOf(dynamic v) {
  if (v is BigInt) return v;
  final s = (v == null ? '0' : '$v').trim();
  if (!RegExp(r'^-?\d+$').hasMatch(s)) {
    throw ArgumentError('amount must be a base-unit integer string: $s');
  }
  return BigInt.parse(s);
}

/// Exact floor of (amountBase * bps / 10000), base units in, base units out.
BigInt feeAmount(dynamic amountBase, num bps) {
  final a = _bigOf(amountBase);
  final b = BigInt.from(bps.truncate());
  if (b < BigInt.zero) throw ArgumentError('feeBps must be >= 0');
  final abs = a < BigInt.zero ? -a : a;
  return (abs * b) ~/ _bpsDenom;
}

/// Slippage-adjusted minimum out. [slippage] is a FRACTION (0.01 = 1%).
String applySlippage(dynamic amountOutBase, num? slippage) {
  final out = _bigOf(amountOutBase);
  final s = (slippage ?? 0).toDouble();
  if (!s.isFinite || s <= 0) return out.toString();
  final capped = s < 1.0 ? s : 1.0;
  final keepBps = _bpsDenom - BigInt.from((capped * 10000).round());
  return ((out * keepBps) ~/ _bpsDenom).toString();
}

/// Constant-product AMM quote (x*y=k) with a pool fee in bps. Pure + exact.
///   amountOut = reserveOut * inAfterFee / (reserveIn + inAfterFee)
String ammQuote(dynamic amountIn, dynamic reserveIn, dynamic reserveOut,
    [num? poolFeeBps]) {
  final aIn = _bigOf(amountIn);
  final rIn = _bigOf(reserveIn);
  final rOut = _bigOf(reserveOut);
  if (aIn <= BigInt.zero || rIn <= BigInt.zero || rOut <= BigInt.zero) {
    return '0';
  }
  final feeBps = BigInt.from((poolFeeBps ?? 30).truncate());
  final inAfterFee = (aIn * (_bpsDenom - feeBps)) ~/ _bpsDenom;
  return ((rOut * inAfterFee) ~/ (rIn + inAfterFee)).toString();
}

const Map<String, String> _chainAlias = {
  'eth': 'ethereum', 'ethereum': 'ethereum', 'mainnet': 'ethereum',
  'base': 'base',
  'sol': 'solana', 'solana': 'solana',
  'btc': 'bitcoin', 'bitcoin': 'bitcoin',
  'ltc': 'litecoin', 'litecoin': 'litecoin',
  'doge': 'dogecoin', 'dogecoin': 'dogecoin',
  'sui': 'sui',
  'block': 'block', 'blockle': 'block',
};

String normChain(dynamic c) {
  final k = '${c ?? ''}'.toLowerCase();
  return _chainAlias[k] ?? k;
}

/// normalized chain -> treasury.json address key
String treasuryKey(dynamic chain) {
  final c = normChain(chain);
  if (c == 'bitcoin') return 'btc';
  return c;
}

String? _tokenId(dynamic t) {
  if (t is Map) return (t['address'] ?? t['mint'] ?? t['symbol']) as String?;
  return t as String?;
}

String? _tokenSym(dynamic t) {
  if (t is Map) return (t['symbol'] ?? t['address'] ?? t['mint']) as String?;
  return t as String?;
}

/// A fee descriptor {bps, chain, asset, amount, treasury}.
class FeeDescriptor {
  final num bps;
  final String chain;
  final String? asset;
  final String amount;
  final String treasury;
  const FeeDescriptor({
    required this.bps,
    required this.chain,
    required this.asset,
    required this.amount,
    required this.treasury,
  });

  Map<String, dynamic> toJson() => {
        'bps': bps,
        'chain': chain,
        'asset': asset,
        'amount': amount,
        'treasury': treasury,
      };
}

/// A fee descriptor -> a send request the ChainAdapter.buildSend understands.
Map<String, dynamic>? feeTransfer(FeeDescriptor? fee) {
  if (fee == null) return null;
  return {
    'chain': fee.chain,
    'to': fee.treasury,
    'amount': fee.amount,
    if (fee.asset != null) 'asset': fee.asset,
  };
}

/// Treasury router — resolves feeBps + the per-chain fee recipient. Accepts the
/// parsed exchange/treasury.json as-is (agentTradeFeeBps + a `mainnet` address
/// map), OR an explicit { feeBps, addresses } shape, OR a network sub-map. No
/// private keys ever live here.
class Treasury {
  final num feeBps;
  final String network;
  final Map<String, String> addresses;

  Treasury._(this.feeBps, this.network, this.addresses);

  factory Treasury.from(Map<String, dynamic>? cfg) {
    cfg = cfg ?? {};
    final feeRaw = cfg['feeBps'] ?? cfg['agentTradeFeeBps'] ?? 5;
    final feeBps = (feeRaw as num).toDouble();
    if (!feeBps.isFinite || feeBps < 0) {
      throw ArgumentError('invalid agent feeBps');
    }
    final network = (cfg['network'] as String?) ?? 'mainnet';
    final addrs = <String, String>{};
    void merge(dynamic m) {
      if (m is Map) {
        m.forEach((k, v) {
          if (v is String) addrs['$k'] = v;
        });
      }
    }

    merge(cfg['mainnet']);
    if (cfg[network] is Map) merge(cfg[network]);
    merge(cfg['addresses']);
    return Treasury._(feeBps, network, addrs);
  }

  String addressFor(dynamic chain) {
    final a = addresses[treasuryKey(chain)];
    if (a == null) {
      throw StateError(
          'no treasury address configured for chain "${normChain(chain)}" — agent fee cannot be routed (fail-closed)');
    }
    return a;
  }

  /// fee descriptor for a trade of [amountBase] (input asset) on [chain].
  FeeDescriptor feeFor(dynamic chain, dynamic amountBase, [String? asset]) {
    return FeeDescriptor(
      bps: feeBps,
      chain: normChain(chain),
      asset: asset,
      amount: feeAmount(amountBase, feeBps).toString(),
      treasury: addressFor(chain),
    );
  }
}

/// Common venue surface: quote + buildSwap.
abstract class Venue {
  String get id;
  String get kind;
  List<String> get chains;
  bool supports(dynamic chain);
  Future<Map<String, dynamic>> quote(
      dynamic from, dynamic to, dynamic amount, Map<String, dynamic>? opts);
  Future<Map<String, dynamic>> buildSwap(Map<String, dynamic> req);
}

/// Native Blockle rail (AMM + non-custodial exchange + x402). `exchange` and
/// `amm` are optional pricing sources, injected by the host/tests.
class BlockleVenue extends Venue {
  final Treasury treasury;
  final Map<String, String> assetChain;
  final num poolFeeBps;

  /// exchange.quote(from,to,amount,opts) -> { amountOut | out | expectedOut }
  final Future<Map<String, dynamic>> Function(
      String from, String to, String amount, Map<String, dynamic> opts)? exchangeQuote;

  /// amm.reserves(from,to) -> { reserveIn, reserveOut, poolFeeBps? }
  final Future<Map<String, dynamic>> Function(String from, String to)? ammReserves;

  BlockleVenue(
    this.treasury, {
    Map<String, String>? assetChain,
    num? poolFeeBps,
    this.exchangeQuote,
    this.ammReserves,
  })  : assetChain = {
          'BLOCK': 'block',
          'USDC': 'base',
          'USDT': 'ethereum',
          'ETH': 'ethereum',
          'WETH': 'ethereum',
          'SOL': 'solana',
          'BTC': 'bitcoin',
          ...?assetChain,
        },
        poolFeeBps = poolFeeBps ?? 30;

  @override
  String get id => 'blockle';
  @override
  String get kind => 'native';
  @override
  List<String> get chains => const ['block'];
  @override
  bool supports(dynamic chain) => normChain(chain) == 'block';

  String _feeChainOf(dynamic from, Map<String, dynamic>? req) {
    if (req != null && req['chain'] != null) return normChain(req['chain']);
    final sym = (_tokenSym(from) ?? '').toUpperCase();
    return normChain(assetChain[sym] ?? 'block');
  }

  Future<Map<String, dynamic>> _rawQuote(
      dynamic from, dynamic to, dynamic amount, Map<String, dynamic> opts) async {
    if (exchangeQuote != null) {
      final q = await exchangeQuote!(
          _tokenSym(from)!, _tokenSym(to)!, '$amount', opts);
      final out = q['amountOut'] ?? q['out'] ?? q['expectedOut'];
      return {
        'amountOut': out != null ? '$out' : '0',
        'route': q['route'] ?? q['path'] ?? ['blockle'],
        'raw': q,
      };
    }
    if (ammReserves != null) {
      final r = await ammReserves!(_tokenSym(from)!, _tokenSym(to)!);
      final out = ammQuote(amount, r['reserveIn'], r['reserveOut'],
          (r['poolFeeBps'] as num?) ?? poolFeeBps);
      return {
        'amountOut': out,
        'route': ['amm:${_tokenSym(from)}/${_tokenSym(to)}'],
        'raw': r,
      };
    }
    throw StateError(
        'blockle venue: no pricing source (wire exchange.quote or amm.reserves)');
  }

  @override
  Future<Map<String, dynamic>> quote(
      dynamic from, dynamic to, dynamic amount, Map<String, dynamic>? opts) async {
    opts = opts ?? {};
    final r = await _rawQuote(from, to, amount, opts);
    final chain = _feeChainOf(from, opts);
    final slip = opts['slippage'] as num?;
    return {
      'venue': 'blockle',
      'chain': chain,
      'from': _tokenSym(from),
      'to': _tokenSym(to),
      'amountIn': '$amount',
      'amountOut': r['amountOut'],
      'minOut': applySlippage(r['amountOut'], slip ?? 0.005),
      'route': r['route'],
      'fee': treasury.feeFor(chain, amount, _tokenSym(from)),
      'raw': r['raw'],
    };
  }

  @override
  Future<Map<String, dynamic>> buildSwap(Map<String, dynamic> req) async {
    final q = await quote(req['from'], req['to'], req['amount'], req);
    final fee = q['fee'] as FeeDescriptor;
    return {
      'venue': 'blockle',
      'chain': q['chain'],
      'from': q['from'],
      'to': q['to'],
      'amountIn': q['amountIn'],
      'amountOut': q['amountOut'],
      'minOut': q['minOut'],
      'intent': {
        'kind': 'exchange-swap',
        'from': q['from'],
        'to': q['to'],
        'amount': q['amountIn'],
        'slippage': req['slippage'],
      },
      'quote': q,
      'fee': fee,
      'feeTransfer': feeTransfer(fee),
      'autoSend': false,
    };
  }
}

/// EVM DEX aggregator (0x/1inch-style). Needs an injected [request].
class EvmDexVenue extends Venue {
  final Treasury treasury;
  @override
  final List<String> chains;
  final VenueRequest request;
  final String? baseUrl;
  final Map<String, String> Function(String chain)? headersFor;
  final String quotePath;

  EvmDexVenue(
    this.treasury, {
    List<String>? chains,
    required this.request,
    this.baseUrl,
    this.headersFor,
    String? quotePath,
  })  : chains = (chains ?? const ['ethereum', 'base']).map(normChain).toList(),
        quotePath = quotePath ?? '/swap/v1/quote';

  @override
  String get id => 'evmdex';
  @override
  String get kind => 'aggregator';
  @override
  bool supports(dynamic chain) => chains.contains(normChain(chain));

  String _baseUrlFor(String chain) {
    if (baseUrl == null) {
      throw StateError('evmdex: no API baseUrl configured for chain $chain');
    }
    return baseUrl!.replaceAll(RegExp(r'/$'), '');
  }

  Map<String, dynamic> _mapResp(Map j) => {
        'amountOut':
            '${j['buyAmount'] ?? j['toTokenAmount'] ?? j['outAmount'] ?? '0'}',
        'price': j['price'] ?? j['guaranteedPrice'],
        'route': j['sources'] ?? j['protocols'] ?? j['route'],
        'to': j['to'] ?? (j['tx'] is Map ? j['tx']['to'] : null),
        'data': j['data'] ?? (j['tx'] is Map ? j['tx']['data'] : null),
        'value': '${j['value'] ?? (j['tx'] is Map ? j['tx']['value'] : null) ?? '0'}',
        'allowanceTarget': j['allowanceTarget'] ?? j['spender'],
      };

  Future<Map<String, dynamic>> _call(String chain, Map<String, dynamic> req) async {
    final c = normChain(chain);
    final url = _baseUrlFor(c) +
        quotePath +
        _qs({
          'sellToken': _tokenId(req['from']),
          'buyToken': _tokenId(req['to']),
          'sellAmount': '${req['amount']}',
          'slippagePercentage': req['slippage'],
          'takerAddress': req['account'] is Map
              ? req['account']['address']
              : req['account'],
        });
    final j = await request(
        method: 'GET', url: url, headers: headersFor?.call(c) ?? const {});
    return {'norm': _mapResp(j as Map), 'raw': j};
  }

  @override
  Future<Map<String, dynamic>> quote(
      dynamic from, dynamic to, dynamic amount, Map<String, dynamic>? opts) async {
    opts = opts ?? {};
    final chain = normChain(opts['chain'] ?? chains.first);
    if (!supports(chain)) throw StateError('evmdex: unsupported chain $chain');
    final r = await _call(chain, {
      'from': from,
      'to': to,
      'amount': amount,
      'slippage': opts['slippage'],
      'account': opts['account'],
    });
    final norm = r['norm'] as Map<String, dynamic>;
    final slip = opts['slippage'] as num?;
    return {
      'venue': 'evmdex',
      'chain': chain,
      'from': _tokenId(from),
      'to': _tokenId(to),
      'amountIn': '$amount',
      'amountOut': norm['amountOut'],
      'minOut': applySlippage(norm['amountOut'], slip ?? 0.005),
      'price': norm['price'],
      'route': norm['route'],
      'fee': treasury.feeFor(chain, amount, _tokenSym(from)),
      'raw': r['raw'],
    };
  }

  @override
  Future<Map<String, dynamic>> buildSwap(Map<String, dynamic> req) async {
    final chain = normChain(req['chain'] ?? chains.first);
    if (!supports(chain)) throw StateError('evmdex: unsupported chain $chain');
    final r = await _call(chain, req);
    final norm = r['norm'] as Map<String, dynamic>;
    final fee = treasury.feeFor(chain, req['amount'], _tokenSym(req['from']));
    final slip = req['slippage'] as num?;
    return {
      'venue': 'evmdex',
      'chain': chain,
      'from': _tokenId(req['from']),
      'to': _tokenId(req['to']),
      'amountIn': '${req['amount']}',
      'amountOut': norm['amountOut'],
      'minOut': applySlippage(norm['amountOut'], slip ?? 0.005),
      'tx': {
        'chain': chain,
        'to': norm['to'],
        'data': norm['data'],
        'value': norm['value'] ?? '0',
      },
      'allowanceTarget': norm['allowanceTarget'],
      'fee': fee,
      'feeTransfer': feeTransfer(fee),
      'autoSend': false,
      'raw': r['raw'],
    };
  }
}

/// Solana Jupiter aggregator. Needs an injected [request].
class JupiterVenue extends Venue {
  final Treasury treasury;
  final VenueRequest request;
  final String? baseUrl;
  final String quotePath;
  final String swapPath;
  final Map<String, String> headers;

  JupiterVenue(
    this.treasury, {
    required this.request,
    this.baseUrl,
    String? quotePath,
    String? swapPath,
    Map<String, String>? headers,
  })  : quotePath = quotePath ?? '/quote',
        swapPath = swapPath ?? '/swap',
        headers = headers ?? const {};

  @override
  String get id => 'jupiter';
  @override
  String get kind => 'aggregator';
  @override
  List<String> get chains => const ['solana'];
  @override
  bool supports(dynamic chain) => normChain(chain) == 'solana';

  String _baseUrl() {
    if (baseUrl == null) throw StateError('jupiter: no API baseUrl configured');
    return baseUrl!.replaceAll(RegExp(r'/$'), '');
  }

  Map<String, dynamic> _mapQuote(Map j) => {
        'amountOut': '${j['outAmount'] ?? j['otherAmountThreshold'] ?? '0'}',
        'route': j['routePlan'] ?? j['marketInfos'],
        'quoteResponse': j,
      };

  Future<Map<String, dynamic>> _doQuote(Map<String, dynamic> req) async {
    final url = _baseUrl() +
        quotePath +
        _qs({
          'inputMint': _tokenId(req['from']),
          'outputMint': _tokenId(req['to']),
          'amount': '${req['amount']}',
          'slippageBps': req['slippage'] != null
              ? ((req['slippage'] as num) * 10000).round()
              : null,
        });
    final j = await request(method: 'GET', url: url, headers: headers);
    return {'norm': _mapQuote(j as Map), 'raw': j};
  }

  @override
  Future<Map<String, dynamic>> quote(
      dynamic from, dynamic to, dynamic amount, Map<String, dynamic>? opts) async {
    opts = opts ?? {};
    final r = await _doQuote({'from': from, 'to': to, 'amount': amount, 'slippage': opts['slippage']});
    final norm = r['norm'] as Map<String, dynamic>;
    final slip = opts['slippage'] as num?;
    return {
      'venue': 'jupiter',
      'chain': 'solana',
      'from': _tokenId(from),
      'to': _tokenId(to),
      'amountIn': '$amount',
      'amountOut': norm['amountOut'],
      'minOut': applySlippage(norm['amountOut'], slip ?? 0.005),
      'route': norm['route'],
      'fee': treasury.feeFor('solana', amount, _tokenSym(from)),
      'raw': r['raw'],
    };
  }

  @override
  Future<Map<String, dynamic>> buildSwap(Map<String, dynamic> req) async {
    if (req['account'] == null) {
      throw StateError('jupiter buildSwap requires account (userPublicKey)');
    }
    final r = await _doQuote(req);
    final norm = r['norm'] as Map<String, dynamic>;
    final swapResp = await request(
      method: 'POST',
      url: _baseUrl() + swapPath,
      headers: headers,
      body: {
        'quoteResponse': norm['quoteResponse'],
        'userPublicKey':
            req['account'] is Map ? req['account']['address'] : req['account'],
        'wrapAndUnwrapSol': req['wrapAndUnwrapSol'] != false,
      },
    );
    final fee = treasury.feeFor('solana', req['amount'], _tokenSym(req['from']));
    final slip = req['slippage'] as num?;
    return {
      'venue': 'jupiter',
      'chain': 'solana',
      'from': _tokenId(req['from']),
      'to': _tokenId(req['to']),
      'amountIn': '${req['amount']}',
      'amountOut': norm['amountOut'],
      'minOut': applySlippage(norm['amountOut'], slip ?? 0.005),
      'tx': {
        'chain': 'solana',
        'swapTransaction': swapResp is Map ? swapResp['swapTransaction'] : null,
      },
      'fee': fee,
      'feeTransfer': feeTransfer(fee),
      'autoSend': false,
      'raw': {'quote': r['raw'], 'swap': swapResp},
    };
  }
}

/// The venue registry — mirrors `Venues.create`.
class VenueRegistry {
  final Treasury treasury;
  final List<Venue> _venues;
  late final Map<String, Venue> _byId;

  VenueRegistry._(this.treasury, this._venues) {
    _byId = {for (final v in _venues) v.id: v};
  }

  num get feeBps => treasury.feeBps;
  List<Venue> list() => List.unmodifiable(_venues);
  List<String> ids() => _venues.map((v) => v.id).toList();
  Venue? get(String id) => _byId[id];
  List<Venue> forChain(dynamic chain) =>
      _venues.where((v) {
        try {
          return v.supports(chain);
        } catch (_) {
          return false;
        }
      }).toList();
  FeeDescriptor feeFor(dynamic chain, dynamic amount, [String? asset]) =>
      treasury.feeFor(chain, amount, asset);

  /// Build a registry. The native Blockle venue is always present; evmdex and
  /// jupiter are enabled unless explicitly disabled. [request] is the injectable
  /// HTTP transport the API venues use.
  factory VenueRegistry.create({
    Map<String, dynamic>? treasury,
    VenueRequest? request,
    Map<String, dynamic>? blockle,
    Map<String, dynamic>? evmdex,
    Map<String, dynamic>? jupiter,
  }) {
    final t = Treasury.from(treasury);
    final venues = <Venue>[];

    blockle = blockle ?? {};
    venues.add(BlockleVenue(
      t,
      assetChain: (blockle['assetChain'] as Map?)?.cast<String, String>(),
      poolFeeBps: blockle['poolFeeBps'] as num?,
      exchangeQuote: blockle['exchangeQuote'] as Future<Map<String, dynamic>>
          Function(String, String, String, Map<String, dynamic>)?,
      ammReserves: blockle['ammReserves']
          as Future<Map<String, dynamic>> Function(String, String)?,
    ));

    if (evmdex == null || evmdex['enabled'] != false) {
      evmdex = evmdex ?? {};
      venues.add(EvmDexVenue(
        t,
        chains: (evmdex['chains'] as List?)?.cast<String>(),
        request: (evmdex['request'] as VenueRequest?) ??
            request ??
            _noTransport,
        baseUrl: evmdex['baseUrl'] as String?,
        headersFor: evmdex['headersFor'] as Map<String, String> Function(String)?,
        quotePath: evmdex['quotePath'] as String?,
      ));
    }

    if (jupiter == null || jupiter['enabled'] != false) {
      jupiter = jupiter ?? {};
      venues.add(JupiterVenue(
        t,
        request: (jupiter['request'] as VenueRequest?) ?? request ?? _noTransport,
        baseUrl: jupiter['baseUrl'] as String?,
        quotePath: jupiter['quotePath'] as String?,
        swapPath: jupiter['swapPath'] as String?,
        headers: (jupiter['headers'] as Map?)?.cast<String, String>(),
      ));
    }

    return VenueRegistry._(t, venues);
  }
}

Future<dynamic> _noTransport(
    {required String method,
    required String url,
    Map<String, String>? headers,
    dynamic body}) {
  throw StateError('no HTTP transport configured for this venue');
}

String _qs(Map<String, dynamic> params) {
  final parts = <String>[];
  params.forEach((k, v) {
    if (v == null || v == '') return;
    parts.add('${Uri.encodeComponent(k)}=${Uri.encodeComponent('$v')}');
  });
  return parts.isEmpty ? '' : '?${parts.join('&')}';
}

/// A default [VenueRequest] built on a `fetch`-style function. Swallows nothing;
/// mirrors the extension's defaultRequest JSON handling.
VenueRequest defaultRequest(
    Future<({int status, bool ok, String body})> Function(
            String url, String method, Map<String, String> headers, String? body)
        fetchImpl) {
  return ({required method, required url, headers, body}) async {
    final h = {'accept': 'application/json', ...?headers};
    String? payload;
    if (body != null) {
      h['content-type'] = 'application/json';
      payload = body is String ? body : jsonEncode(body);
    }
    final res = await fetchImpl(url, method, h, payload);
    dynamic data;
    try {
      data = res.body.isNotEmpty ? jsonDecode(res.body) : null;
    } catch (_) {
      data = res.body;
    }
    if (!res.ok || res.status >= 400) {
      final msg = (data is Map
              ? (data['reason'] ?? data['error'] ?? data['message'])
              : null) ??
          'HTTP ${res.status}';
      throw StateError('$msg');
    }
    return data;
  };
}
