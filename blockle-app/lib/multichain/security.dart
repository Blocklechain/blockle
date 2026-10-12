// multichain/security.dart — the WALLET SECURITY SUITE (docs/WALLET-SECURITY.md).
//
// Dart port of blockle-extension/security.js (the JS reference). Behaviourally
// IDENTICAL; asserted against the authoritative docs/security-vectors.json.
//
// Stops the #1 way funds get drained: blind-signing a malicious transaction or a
// hostile token approval. Everything here is READ-ONLY analysis + warnings — it
// NEVER signs, NEVER moves funds, and NEVER fabricates a safety claim (the
// absence of a warning is not a claim of safety).
//
// Three parts, one spec, three identical implementations:
//   1. inspectTransaction(tx, ctx) -> Inspection   (pure given injected ctx)
//   2. approval manager: listApprovals (read-only) + buildRevoke (approve(s,0))
//   3. scam / phishing / malicious-approval warnings (config-toggleable, pinned
//      codes) + a pre-sign gate helper (danger forces an explicit confirm).
//
// PURE: every chain read (getCode / balance / USD / indexer / denylist / history)
// is injected via `ctx` and mockable. All money math is base-unit / BigInt-exact.
// Reuses the EXISTING ERC-20 calldata builder in chains/evm.dart (erc20ApproveData).

import 'chains/chain_adapter.dart' show formatUnits;
import 'chains/evm.dart' show erc20ApproveData, erc20TransferData;

// ---- selectors (mirror chains/evm.dart) ------------------------------------
const String _selTransfer = 'a9059cbb'; // transfer(address,uint256)
const String _selApprove = '095ea7b3'; // approve(address,uint256)
const String _selTransferFrom = '23b872dd'; // transferFrom(address,address,uint256)
const String _selSetApprovalForAll = 'a22cb465'; // setApprovalForAll(address,bool)
const String _selSafeTransfer721 = '42842e0e'; // safeTransferFrom(address,address,uint256)
const String _selSafeTransfer1155 = 'f242432a'; // safeTransferFrom(address,address,uint256,uint256,bytes)

final BigInt kMaxUint256 = (BigInt.one << 256) - BigInt.one;

/// Default "unlimited" threshold: at/above this an allowance is treated as
/// unlimited. 2^255 catches 2^256-1 and every absurdly-large grant while never
/// flagging a real, sized allowance. Operator-overridable via config.
final BigInt kDefaultUnlimitedThreshold = BigInt.one << 255;

const Set<String> kEvmChains = {
  'ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bnb', 'avalanche'
};
const Set<String> kUtxoChains = {'bitcoin', 'litecoin', 'dogecoin'};

const Map<String, int> kSevRank = {'none': 0, 'info': 1, 'warn': 2, 'danger': 3};
const List<String> kWarningCodes = [
  'unlimited-approval', 'approval-to-unknown-spender', 'approval-to-eoa',
  'known-drainer', 'send-to-flagged', 'setApprovalForAll-true',
  'new-address', 'large-share', 'mismatch-currency',
];

// ---- small pure helpers -----------------------------------------------------
BigInt toBig(dynamic v) {
  if (v is BigInt) return v;
  if (v == null || v == '') return BigInt.zero;
  final s = '$v'.trim();
  if (RegExp(r'^0x[0-9a-fA-F]+$').hasMatch(s)) {
    return BigInt.parse(s.substring(2), radix: 16);
  }
  if (!RegExp(r'^-?\d+$').hasMatch(s)) {
    throw ArgumentError('not a base-unit integer: $s');
  }
  return BigInt.parse(s);
}

/// Normalize an address for comparison: EVM hex is case-insensitive (lowercase);
/// base58 (Solana) / bech32 are case-sensitive, left as-is.
String? norm(dynamic a) {
  if (a == null) return null;
  final s = '$a';
  return RegExp(r'^0x[0-9a-fA-F]*$').hasMatch(s) ? s.toLowerCase() : s;
}

String _shorten(dynamic a) {
  final s = '${a ?? ''}';
  return s.length > 14 ? '${s.substring(0, 8)}…${s.substring(s.length - 4)}' : s;
}

bool isEmptyCode(dynamic code) {
  if (code == null) return true;
  final s = '$code'.replaceFirst(RegExp(r'^0x'), '');
  return s.isEmpty || RegExp(r'^0*$').hasMatch(s);
}

String _fmtAmt(dynamic base, dynamic decimals, String? symbol) {
  String s;
  if (decimals != null && decimals is num && decimals == decimals.toInt()) {
    try {
      s = formatUnits(toBig(base).toString(), decimals.toInt());
    } catch (_) {
      s = '$base';
    }
  } else {
    s = '$base base units';
  }
  return symbol != null ? '$s $symbol' : s;
}

bool _has(dynamic setLike, dynamic key) {
  if (setLike == null) return false;
  if (setLike is Set) return setLike.contains(key);
  if (setLike is Iterable) return setLike.contains(key);
  return false;
}

/// A typed warning.
class Warning {
  final String code;
  final String severity;
  final String message;
  final Map<String, dynamic>? evidence;
  const Warning(this.code, this.severity, this.message, [this.evidence]);
  Map<String, dynamic> toMap() => {
        'code': code,
        'severity': severity,
        'message': message,
        if (evidence != null) 'evidence': evidence,
      };
}

String maxSeverity(List<Warning> warnings) {
  var best = 'none';
  for (final w in warnings) {
    if ((kSevRank[w.severity] ?? 0) > (kSevRank[best] ?? 0)) best = w.severity;
  }
  return best;
}

/// Which checks ran and which were skipped (transparency; never "safe").
class Checks {
  final List<String> ran;
  final List<Map<String, dynamic>> skipped;
  Checks(this.ran, this.skipped);
  List<String> get skippedCodes =>
      skipped.map((s) => '${s['code']}').toList();
}

/// The result of inspectTransaction.
class Inspection {
  final String chain;
  final String kind;
  final String summary;
  final List<Map<String, dynamic>> details;
  final List<Map<String, dynamic>> effects;
  final List<Warning> warnings;
  final String severity;
  final Checks checks;
  Inspection({
    required this.chain,
    required this.kind,
    required this.summary,
    required this.details,
    required this.effects,
    required this.warnings,
    required this.severity,
    required this.checks,
  });

  /// Warning codes, sorted (matches the vectors' SORTED-set convention).
  List<String> get warningCodes =>
      (warnings.map((w) => w.code).toList()..sort());

  Map<String, dynamic>? field(String label) {
    for (final d in details) {
      if (d['label'] == label) return d;
    }
    return null;
  }

  Map<String, dynamic> toMap() => {
        'chain': chain,
        'kind': kind,
        'summary': summary,
        'details': details,
        'effects': effects,
        'warnings': warnings.map((w) => w.toMap()).toList(),
        'severity': severity,
        'checks': {'ran': checks.ran, 'skipped': checks.skipped},
      };
}

/// Merged, normalized security config.
class SecConfig {
  final BigInt unlimitedThreshold;
  final num largeSharePct;
  final Set<String> denylist;
  final Set<String> knownSpenders;
  final Map<String, dynamic> warnings;
  SecConfig({
    required this.unlimitedThreshold,
    required this.largeSharePct,
    required this.denylist,
    required this.knownSpenders,
    required this.warnings,
  });
  bool on(String code) => warnings[code] != false;
}

SecConfig mergeConfig(Map<String, dynamic>? cfg) {
  cfg = cfg ?? const {};
  return SecConfig(
    unlimitedThreshold: cfg['unlimitedThreshold'] != null
        ? toBig(cfg['unlimitedThreshold'])
        : kDefaultUnlimitedThreshold,
    largeSharePct: cfg['largeSharePct'] != null
        ? (cfg['largeSharePct'] as num)
        : 50,
    denylist: {
      for (final a in (cfg['denylist'] as List? ?? const []))
        if (norm(a) != null) norm(a)!
    },
    knownSpenders: {
      for (final a in (cfg['knownSpenders'] as List? ?? const []))
        if (norm(a) != null) norm(a)!
    },
    warnings: (cfg['warnings'] as Map?)?.cast<String, dynamic>() ?? const {},
  );
}

/// Built-in default known-good spender allowlist (spec §3): the well-known DEX
/// routers so `approval-to-unknown-spender` runs by DEFAULT in production (it is
/// gated on `knownSpenders.isNotEmpty`). Shipped here, operator-overridable: the
/// production wiring seeds config.knownSpenders from these via
/// [defaultSecurityConfig] (mirrors blockle-extension/wiring.js:securityCtx,
/// where the host injects the allowlist into the suite's ctx). The pure shared-
/// vector path (SecCtx.fromSpec) never routes through this, so docs/
/// security-vectors.json stays default-free and byte-for-byte identical.
const List<String> kDefaultKnownSpenders = [
  // Uniswap V2 Router02
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d',
  // Uniswap V3 SwapRouter02
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
  // Uniswap Universal Router
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad',
  // 1inch v5 Aggregation Router
  '0x1111111254eeb25477b68fb85ed929f73a960582',
  // 0x Exchange Proxy (allowance target)
  '0xdef1c0ded9bec7f1a1670819833240f027b25eff',
  // Jupiter v6 aggregator program (Solana)
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
];

/// Build a PRODUCTION security config seeded with the shipped default
/// [kDefaultKnownSpenders] (so `approval-to-unknown-spender` runs by default),
/// unioned with any operator-provided `knownSpenders`. Every other field passes
/// through untouched and operators may still extend denylist / thresholds /
/// toggles. Used by the agent/bots inspect hook and the user-send signer guard;
/// NOT by the shared-vector fixtures (which stay default-free).
Map<String, dynamic> defaultSecurityConfig([Map<String, dynamic>? operator]) {
  final cfg = <String, dynamic>{...?operator};
  final provided = (cfg['knownSpenders'] as List?) ?? const [];
  cfg['knownSpenders'] = [...kDefaultKnownSpenders, ...provided];
  return cfg;
}

/// Injected, mockable context. Every chain read is a function here, so
/// inspectTransaction stays pure. Build one from a plain-data spec (the shared
/// vectors' ctxSpec) via [SecCtx.fromSpec].
class SecCtx {
  final String? chain;
  final Map<String, dynamic>? config;
  final Future<dynamic> Function(String address)? getCode;
  final Future<dynamic> Function(dynamic asset)? getBalance;
  final Future<num?> Function(dynamic asset, String amount)? estimateUsd;
  final dynamic seenRecipients; // Set / Iterable of normed addresses
  final dynamic priorApprovals; // Set / Iterable of normed addresses
  final ApprovalIndexer? indexer;
  const SecCtx({
    this.chain,
    this.config,
    this.getCode,
    this.getBalance,
    this.estimateUsd,
    this.seenRecipients,
    this.priorApprovals,
    this.indexer,
  });

  /// Build the identical injected ctx that every language derives from the
  /// shared vectors' plain-data `ctxSpec` (no functions in the fixture).
  factory SecCtx.fromSpec(Map<String, dynamic> spec) {
    String symOf(dynamic asset) {
      if (asset is Map) return '${asset['symbol'] ?? ''}';
      return '$asset';
    }

    Future<dynamic> Function(String)? getCode;
    final codeByAddress = spec['codeByAddress'];
    if (codeByAddress is Map) {
      final m = <String, dynamic>{
        for (final e in codeByAddress.entries) norm(e.key)!: e.value
      };
      getCode = (a) async => m[norm(a)];
    }

    Future<dynamic> Function(dynamic)? getBalance;
    final balances = spec['balances'];
    if (balances is Map) {
      getBalance = (asset) async => balances[symOf(asset)];
    }

    Future<num?> Function(dynamic, String)? estimateUsd;
    final usd = spec['usd'];
    if (usd is Map) {
      estimateUsd = (asset, amount) async {
        final p = usd[symOf(asset)];
        return p == null ? null : (p as num);
      };
    }

    Set<String>? seen;
    final sr = spec['seenRecipients'];
    if (sr is List) seen = {for (final a in sr) norm(a)!};

    Set<String>? prior;
    final pa = spec['priorApprovals'];
    if (pa is List) prior = {for (final a in pa) norm(a)!};

    return SecCtx(
      config: (spec['config'] as Map?)?.cast<String, dynamic>(),
      getCode: getCode,
      getBalance: getBalance,
      estimateUsd: estimateUsd,
      seenRecipients: seen,
      priorApprovals: prior,
    );
  }
}

// Internal decoded shape (kind + presentation + semantics for the warning pass).
class _Decoded {
  final String kind;
  final String summary;
  final List<Map<String, dynamic>> details;
  final List<Map<String, dynamic>> effects;
  final Map<String, dynamic> sem;
  final String? approvalType;
  _Decoded({
    required this.kind,
    required this.summary,
    required this.details,
    required this.effects,
    required this.sem,
    this.approvalType,
  });
}

// =============================================================================
// 1. DECODE — chain-specific, no fabrication (unknown stays contract-call)
// =============================================================================

String _nativeSymbol(Map tx) {
  final asset = tx['asset'];
  if (asset is Map && asset['symbol'] != null) return '${asset['symbol']}';
  if (tx['symbol'] != null) return '${tx['symbol']}';
  return 'ETH';
}

Map<String, dynamic> _nativeAsset(Map tx) {
  final asset = tx['asset'];
  if (asset is Map && asset['kind'] == 'native') return asset.cast<String, dynamic>();
  return {
    'chain': tx['chain'],
    'kind': 'native',
    'symbol': _nativeSymbol(tx),
    'decimals': (asset is Map && asset['decimals'] != null) ? asset['decimals'] : 18,
  };
}

_Decoded _decodeEvm(Map tx, SecConfig config) {
  final to = norm(tx['to']);
  final value = toBig(tx['value'] ?? 0);
  final data = '${tx['data'] ?? '0x'}'.toLowerCase();
  final hex = data.replaceFirst(RegExp(r'^0x'), '');
  final tokenAsset = (tx['asset'] is Map)
      ? (tx['asset'] as Map).cast<String, dynamic>()
      : <String, dynamic>{'chain': tx['chain'], 'kind': 'erc20', 'address': to};

  // native transfer: no (or empty) calldata
  if (hex.length < 8) {
    final native = _nativeAsset(tx);
    return _Decoded(
      kind: 'native-transfer',
      summary:
          'Send ${_fmtAmt(value, native['decimals'], native['symbol'] as String?)} to ${_shorten(to)}',
      details: [
        {'label': 'To', 'value': to},
        {'label': 'Amount', 'value': value.toString()}
      ],
      effects: value > BigInt.zero
          ? [
              {'asset': native, 'direction': 'out', 'amountBase': value.toString()}
            ]
          : [],
      sem: {'recipient': to, 'outAmount': value, 'asset': native},
    );
  }

  final selector = hex.substring(0, 8);
  final args = hex.substring(8);
  String word(int i) {
    final start = i * 64;
    if (start >= args.length) return '';
    final end = (start + 64 <= args.length) ? start + 64 : args.length;
    return args.substring(start, end);
  }

  String addrAt(int i) {
    final w = word(i);
    return '0x${w.length >= 24 ? w.substring(24) : w}';
  }

  BigInt bigAt(int i) {
    final w = word(i);
    return w.isEmpty ? BigInt.zero : BigInt.parse(w, radix: 16);
  }

  if (selector == _selTransfer) {
    final recipient = norm(addrAt(0));
    final amount = bigAt(1);
    return _Decoded(
      kind: 'token-transfer',
      summary:
          'Transfer ${_fmtAmt(amount, tokenAsset['decimals'], (tokenAsset['symbol'] as String?) ?? 'tokens')} to ${_shorten(recipient)}',
      details: [
        {'label': 'Token', 'value': to},
        {'label': 'To', 'value': recipient},
        {'label': 'Amount', 'value': amount.toString()}
      ],
      effects: [
        {'asset': tokenAsset, 'direction': 'out', 'amountBase': amount.toString()}
      ],
      sem: {'recipient': recipient, 'outAmount': amount, 'asset': tokenAsset, 'token': to},
    );
  }

  if (selector == _selApprove) {
    final spender = norm(addrAt(0));
    final allowance = bigAt(1);
    final unlimited = allowance >= config.unlimitedThreshold;
    return _Decoded(
      kind: 'token-approval',
      approvalType: 'erc20',
      summary:
          'Approve ${_shorten(spender)} to spend ${unlimited ? 'UNLIMITED' : _fmtAmt(allowance, tokenAsset['decimals'], (tokenAsset['symbol'] as String?) ?? 'tokens')}',
      details: [
        {'label': 'Token', 'value': to},
        {'label': 'Spender', 'value': spender},
        {'label': 'Allowance', 'value': unlimited ? 'UNLIMITED' : allowance.toString()}
      ],
      effects: const [],
      sem: {
        'spender': spender,
        'allowance': allowance,
        'unlimited': unlimited,
        'asset': tokenAsset,
        'token': to
      },
    );
  }

  if (selector == _selTransferFrom) {
    final from = norm(addrAt(0));
    final recipient = norm(addrAt(1));
    final amount = bigAt(2);
    return _Decoded(
      kind: 'token-transfer',
      summary:
          'transferFrom ${_shorten(from)} → ${_shorten(recipient)}: ${_fmtAmt(amount, tokenAsset['decimals'], (tokenAsset['symbol'] as String?) ?? 'tokens')}',
      details: [
        {'label': 'Token', 'value': to},
        {'label': 'From', 'value': from},
        {'label': 'To', 'value': recipient},
        {'label': 'Amount', 'value': amount.toString()}
      ],
      effects: [
        {'asset': tokenAsset, 'direction': 'out', 'amountBase': amount.toString()}
      ],
      sem: {
        'recipient': recipient,
        'from': from,
        'outAmount': amount,
        'asset': tokenAsset,
        'token': to
      },
    );
  }

  if (selector == _selSafeTransfer721) {
    final from = norm(addrAt(0));
    final recipient = norm(addrAt(1));
    final tokenId = bigAt(2);
    final nftAsset = <String, dynamic>{
      'chain': tx['chain'],
      'kind': 'nft',
      'standard': 'erc721',
      'contract': to,
      'tokenId': tokenId.toString()
    };
    return _Decoded(
      kind: 'nft-transfer',
      summary:
          'Transfer NFT #${tokenId.toString()} (collection ${_shorten(to)}) from ${_shorten(from)} to ${_shorten(recipient)}',
      details: [
        {'label': 'Collection', 'value': to},
        {'label': 'From', 'value': from},
        {'label': 'To', 'value': recipient},
        {'label': 'Token ID', 'value': tokenId.toString()}
      ],
      effects: [
        {'asset': nftAsset, 'direction': 'out', 'amountBase': '1'}
      ],
      sem: {
        'recipient': recipient,
        'from': from,
        'token': to,
        'tokenId': tokenId.toString(),
        'asset': nftAsset
      },
    );
  }

  if (selector == _selSafeTransfer1155) {
    final from = norm(addrAt(0));
    final recipient = norm(addrAt(1));
    final tokenId = bigAt(2);
    final amount = bigAt(3);
    final nftAsset = <String, dynamic>{
      'chain': tx['chain'],
      'kind': 'nft',
      'standard': 'erc1155',
      'contract': to,
      'tokenId': tokenId.toString()
    };
    return _Decoded(
      kind: 'nft-transfer',
      summary:
          'Transfer ${amount.toString()}× NFT #${tokenId.toString()} (collection ${_shorten(to)}) from ${_shorten(from)} to ${_shorten(recipient)}',
      details: [
        {'label': 'Collection', 'value': to},
        {'label': 'From', 'value': from},
        {'label': 'To', 'value': recipient},
        {'label': 'Token ID', 'value': tokenId.toString()},
        {'label': 'Amount', 'value': amount.toString()}
      ],
      effects: [
        {'asset': nftAsset, 'direction': 'out', 'amountBase': amount.toString()}
      ],
      sem: {
        'recipient': recipient,
        'from': from,
        'token': to,
        'tokenId': tokenId.toString(),
        'outAmount': amount,
        'asset': nftAsset
      },
    );
  }

  if (selector == _selSetApprovalForAll) {
    final operator = norm(addrAt(0));
    final approved = bigAt(1) != BigInt.zero;
    return _Decoded(
      kind: 'token-approval',
      approvalType: 'operator',
      summary:
          '${approved ? 'GRANT' : 'Revoke'} operator approval over your ENTIRE collection ${_shorten(to)} to ${_shorten(operator)}',
      details: [
        {'label': 'Collection', 'value': to},
        {'label': 'Operator', 'value': operator},
        {'label': 'Approved', 'value': approved}
      ],
      effects: const [],
      sem: {'operator': operator, 'spender': operator, 'approved': approved, 'token': to},
    );
  }

  // unknown selector -> contract-call (never fabricate a meaning)
  return _Decoded(
    kind: 'contract-call',
    summary:
        'Call contract ${_shorten(to)} (selector 0x$selector)${value > BigInt.zero ? ' sending ${_fmtAmt(value, 18, _nativeSymbol(tx))}' : ''}',
    details: [
      {'label': 'Contract', 'value': to},
      {'label': 'Selector', 'value': '0x$selector'},
      {'label': 'Value', 'value': value.toString()}
    ],
    effects: value > BigInt.zero
        ? [
            {'asset': _nativeAsset(tx), 'direction': 'out', 'amountBase': value.toString()}
          ]
        : [],
    sem: {
      'contract': to,
      if (value > BigInt.zero) 'recipient': to,
      'outAmount': value,
      'asset': _nativeAsset(tx)
    },
  );
}

_Decoded _decodeBlock(Map tx) {
  final to = tx['to'];
  final amount = toBig(tx['amount'] ?? 0);
  final fee = tx['fee'] != null ? toBig(tx['fee']) : null;
  final asset = (tx['asset'] is Map)
      ? (tx['asset'] as Map).cast<String, dynamic>()
      : <String, dynamic>{'chain': 'block', 'kind': 'native', 'symbol': 'BLOCK', 'decimals': 8};
  final details = <Map<String, dynamic>>[
    {'label': 'To', 'value': to},
    {'label': 'Amount', 'value': amount.toString()}
  ];
  if (fee != null) details.add({'label': 'Fee', 'value': fee.toString()});
  return _Decoded(
    kind: 'block-send',
    summary: 'Send ${_fmtAmt(amount, asset['decimals'], asset['symbol'] as String?)} to ${_shorten(to)}',
    details: details,
    effects: [
      {'asset': asset, 'direction': 'out', 'amountBase': amount.toString()}
    ],
    sem: {'recipient': to, 'outAmount': amount, 'asset': asset},
  );
}

_Decoded _decodeUtxo(Map tx) {
  final inputs = (tx['inputs'] as List?) ?? const [];
  final outputs = (tx['outputs'] as List?) ?? const [];
  final symbol = (tx['asset'] is Map && (tx['asset'] as Map)['symbol'] != null)
      ? '${(tx['asset'] as Map)['symbol']}'
      : (tx['chain'] == 'litecoin' ? 'LTC' : tx['chain'] == 'dogecoin' ? 'DOGE' : 'BTC');
  final asset = (tx['asset'] is Map)
      ? (tx['asset'] as Map).cast<String, dynamic>()
      : <String, dynamic>{'chain': tx['chain'], 'kind': 'native', 'symbol': symbol, 'decimals': 8};
  final changeSet = <String>{};
  for (final v in [
    ...(tx['changeAddress'] is List ? tx['changeAddress'] : [if (tx['changeAddress'] != null) tx['changeAddress']]),
    ...(tx['ownAddresses'] is List ? tx['ownAddresses'] : [if (tx['ownAddresses'] != null) tx['ownAddresses']]),
  ]) {
    final n = norm(v);
    if (n != null) changeSet.add(n);
  }
  var inTotal = BigInt.zero;
  for (final i in inputs) {
    inTotal += toBig((i as Map)['value']);
  }
  var outTotal = BigInt.zero;
  for (final o in outputs) {
    outTotal += toBig((o as Map)['value']);
  }
  final fee = inTotal > BigInt.zero ? (inTotal - outTotal) : null;
  final sendOutputs =
      outputs.where((o) => !changeSet.contains(norm((o as Map)['address']))).toList();
  var netSend = BigInt.zero;
  for (final o in sendOutputs) {
    netSend += toBig((o as Map)['value']);
  }
  final primary = sendOutputs.isNotEmpty
      ? norm((sendOutputs[0] as Map)['address'])
      : (outputs.isNotEmpty ? norm((outputs[0] as Map)['address']) : null);
  final details = <Map<String, dynamic>>[
    {'label': 'Inputs', 'value': '${inputs.length}'},
    {'label': 'Outputs', 'value': '${outputs.length}'},
    {'label': 'To', 'value': primary},
    {'label': 'Net send', 'value': netSend.toString()}
  ];
  if (fee != null) details.add({'label': 'Fee', 'value': fee.toString()});
  return _Decoded(
    kind: 'utxo-send',
    summary:
        'Send ${_fmtAmt(netSend, 8, symbol)} to ${_shorten(primary)} (${inputs.length} in → ${outputs.length} out)',
    details: details,
    effects: [
      {'asset': asset, 'direction': 'out', 'amountBase': netSend.toString()}
    ],
    sem: {'recipient': primary, 'outAmount': netSend, 'asset': asset},
  );
}

_Decoded _decodeSolana(Map tx, SecConfig config) {
  final native = {'chain': 'solana', 'kind': 'native', 'symbol': 'SOL', 'decimals': 9};
  final ix = (tx['instructions'] as List?) ??
      (tx['instruction'] != null ? [tx['instruction']] : const []);
  Map asMap(dynamic i) => i is Map ? i : const {};
  bool isSystem(dynamic i) {
    final m = asMap(i);
    return m['program'] == 'system' || m['programId'] == '11111111111111111111111111111111';
  }

  bool isToken(dynamic i) {
    final m = asMap(i);
    return m['program'] == 'spl-token' ||
        m['programId'] == 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  }

  Map info(dynamic i) {
    final m = asMap(i);
    if (m['info'] is Map) return m['info'] as Map;
    if (m['parsed'] is Map && (m['parsed'] as Map)['info'] is Map) {
      return (m['parsed'] as Map)['info'] as Map;
    }
    return const {};
  }

  dynamic typ(dynamic i) {
    final m = asMap(i);
    return m['type'] ?? (m['parsed'] is Map ? (m['parsed'] as Map)['type'] : null);
  }

  dynamic find(bool Function(dynamic) pred) {
    for (final i in ix) {
      if (pred(i)) return i;
    }
    return null;
  }

  final sysXfer = find((i) => isSystem(i) && typ(i) == 'transfer');
  if (sysXfer != null) {
    final d = info(sysXfer);
    final amount = toBig(d['lamports'] ?? d['amount'] ?? 0);
    final to = d['destination'] ?? d['to'];
    return _Decoded(
      kind: 'native-transfer',
      summary: 'Send ${_fmtAmt(amount, 9, 'SOL')} to ${_shorten(to)}',
      details: [
        {'label': 'To', 'value': to},
        {'label': 'Amount', 'value': amount.toString()}
      ],
      effects: [
        {'asset': native, 'direction': 'out', 'amountBase': amount.toString()}
      ],
      sem: {'recipient': to, 'outAmount': amount, 'asset': native},
    );
  }

  final tokXfer = find((i) => isToken(i) && (typ(i) == 'transfer' || typ(i) == 'transferChecked'));
  if (tokXfer != null) {
    final d = info(tokXfer);
    final amount =
        toBig((d['tokenAmount'] is Map ? (d['tokenAmount'] as Map)['amount'] : null) ?? d['amount'] ?? 0);
    final to = d['destination'] ?? d['to'];
    final mint = d['mint'];
    final asset = {
      'chain': 'solana',
      'kind': 'spl',
      'mint': mint,
      'symbol': tx['asset'] is Map ? (tx['asset'] as Map)['symbol'] : null,
      'decimals': tx['asset'] is Map ? (tx['asset'] as Map)['decimals'] : null,
    };
    return _Decoded(
      kind: 'token-transfer',
      summary:
          'Transfer ${_fmtAmt(amount, asset['decimals'], (asset['symbol'] as String?) ?? 'SPL tokens')} to ${_shorten(to)}',
      details: [
        {'label': 'Mint', 'value': mint},
        {'label': 'To', 'value': to},
        {'label': 'Amount', 'value': amount.toString()}
      ],
      effects: [
        {'asset': asset, 'direction': 'out', 'amountBase': amount.toString()}
      ],
      sem: {'recipient': to, 'outAmount': amount, 'asset': asset},
    );
  }

  final tokApprove = find((i) => isToken(i) && (typ(i) == 'approve' || typ(i) == 'approveChecked'));
  if (tokApprove != null) {
    final d = info(tokApprove);
    final allowance =
        toBig((d['tokenAmount'] is Map ? (d['tokenAmount'] as Map)['amount'] : null) ?? d['amount'] ?? 0);
    final spender = d['delegate'] ?? d['spender'];
    // Detect an unlimited SPL delegate allowance the SAME way as EVM (allowance
    // at/above the configured threshold) so a max delegate grant raises
    // unlimited-approval, instead of silently hard-coding unlimited=false.
    final unlimited = allowance >= config.unlimitedThreshold;
    return _Decoded(
      kind: 'token-approval',
      approvalType: 'erc20',
      summary:
          'Approve delegate ${_shorten(spender)} to spend ${unlimited ? 'UNLIMITED' : '${allowance.toString()} base units'}',
      details: [
        {'label': 'Delegate', 'value': spender},
        {'label': 'Allowance', 'value': unlimited ? 'UNLIMITED' : allowance.toString()}
      ],
      effects: const [],
      sem: {'spender': spender, 'allowance': allowance, 'unlimited': unlimited, 'token': d['mint']},
    );
  }

  final programIds = <dynamic>[];
  for (final i in ix) {
    final m = asMap(i);
    final p = m['programId'] ?? m['program'];
    if (p != null) programIds.add(p);
  }
  return _Decoded(
    kind: 'contract-call',
    summary:
        'Solana program call (${programIds.length} instruction${programIds.length == 1 ? '' : 's'})',
    details: [
      {'label': 'Programs', 'value': programIds.join(', ')}
    ],
    effects: const [],
    sem: {'programIds': programIds},
  );
}

// =============================================================================
// 3. WARNINGS — each independently toggleable, thresholds from config
// =============================================================================
Future<Map<String, dynamic>> _runWarnings(
    _Decoded decoded, Map tx, SecCtx ctx, SecConfig config) async {
  final warnings = <Warning>[];
  final ran = <String>[];
  final skipped = <Map<String, dynamic>>[];
  final denylist = config.denylist;
  final knownSpenders = config.knownSpenders;
  final sem = decoded.sem;
  final kind = decoded.kind;

  final isApproval = kind == 'token-approval';
  final isTransfer = kind == 'native-transfer' ||
      kind == 'token-transfer' ||
      kind == 'block-send' ||
      kind == 'utxo-send' ||
      kind == 'nft-transfer';
  final isContractCall = kind == 'contract-call';

  // run a single check: skip (with reason) when its dependency is unavailable,
  // else record it ran and emit a warning if it fired. Disabled checks are
  // omitted entirely (neither ran nor skipped).
  Future<void> check(String code, bool canRun, String? reason,
      Future<Warning?> Function() fn) async {
    if (!config.on(code)) return;
    if (!canRun) {
      skipped.add({'code': code, 'reason': reason});
      return;
    }
    Warning? w;
    try {
      w = await fn();
    } catch (e) {
      skipped.add({'code': code, 'reason': 'error: $e'});
      return;
    }
    ran.add(code);
    if (w != null) warnings.add(w);
  }

  // ---- approvals ------------------------------------------------------------
  if (isApproval && decoded.approvalType == 'erc20') {
    await check('unlimited-approval', true, null, () async {
      return sem['unlimited'] == true
          ? Warning('unlimited-approval', 'warn',
              'This grants an UNLIMITED token allowance — the spender can move your entire balance, now and in future.',
              {
                  'spender': sem['spender'],
                  'allowance': sem['allowance']?.toString()
                })
          : null;
    });
  }
  if (isApproval && decoded.approvalType == 'operator') {
    await check('setApprovalForAll-true', true, null, () async {
      return sem['approved'] == true
          ? Warning('setApprovalForAll-true', 'danger',
              'Grants an operator control over your ENTIRE NFT collection — it can transfer every item.',
              {'operator': sem['operator'], 'collection': sem['token']})
          : null;
    });
  }
  if (isApproval) {
    final spender = norm(sem['spender'] ?? sem['operator']);
    await check('approval-to-unknown-spender', knownSpenders.isNotEmpty,
        'no known-good router allowlist configured', () async {
      final unknown = spender != null &&
          !knownSpenders.contains(spender) &&
          !_has(ctx.priorApprovals, spender);
      return unknown
          ? Warning('approval-to-unknown-spender', 'warn',
              'Spender is not a known router and has not been approved by this wallet before.',
              {'spender': spender})
          : null;
    });
    await check('approval-to-eoa', ctx.getCode != null,
        'code check skipped: no getCode/RPC', () async {
      final code = await ctx.getCode!(spender ?? '');
      return isEmptyCode(code)
          ? Warning('approval-to-eoa', 'danger',
              'Spender has NO contract code (an EOA) — it cannot be a real router. Classic drainer pattern.',
              {'spender': spender})
          : null;
    });
  }

  // ---- known drainer (approval spender / contract-call target) --------------
  if (isApproval || isContractCall) {
    final target = norm(sem['spender'] ?? sem['operator'] ?? sem['contract']);
    await check('known-drainer', true, null, () async {
      return target != null && denylist.contains(target)
          ? Warning('known-drainer', 'danger',
              'Target address is on the known-drainer denylist.', {'address': target})
          : null;
    });
  }

  // ---- transfers ------------------------------------------------------------
  if (isTransfer) {
    final recipient = norm(sem['recipient']);
    await check('send-to-flagged', true, null, () async {
      return recipient != null && denylist.contains(recipient)
          ? Warning('send-to-flagged', 'danger',
              'Recipient is on the known-drainer / scam denylist.', {'recipient': recipient})
          : null;
    });

    await check('new-address', ctx.seenRecipients != null,
        'no local recipient history available', () async {
      return recipient != null && !_has(ctx.seenRecipients, recipient)
          ? Warning('new-address', 'info',
              'First time this wallet has sent to this address.', {'recipient': recipient})
          : null;
    });

    final amount = sem['outAmount'] != null ? toBig(sem['outAmount']) : BigInt.zero;
    await check('large-share', ctx.getBalance != null && amount > BigInt.zero,
        'balance unavailable (cannot compute share)', () async {
      final bal = toBig(await ctx.getBalance!(sem['asset']));
      if (bal <= BigInt.zero) return null;
      // amount / bal > pct/100  <=>  amount*100 > bal*pct   (BigInt-exact)
      final pct = BigInt.from(config.largeSharePct.round().clamp(0, 1 << 30));
      return (amount * BigInt.from(100) > bal * pct)
          ? Warning('large-share', 'warn',
              'This spends more than ${config.largeSharePct}% of your ${(sem['asset'] is Map ? (sem['asset'] as Map)['symbol'] : null) ?? 'balance'}.',
              {'amount': amount.toString(), 'balance': bal.toString()})
          : null;
    });

    await check('mismatch-currency', ctx.estimateUsd != null && amount > BigInt.zero,
        'no USD price source', () async {
      final usd = await ctx.estimateUsd!(sem['asset'], amount.toString());
      return usd == null
          ? Warning('mismatch-currency', 'info',
              'Cannot resolve a USD value for this asset — double-check the token is what you expect.',
              {
                  'asset': sem['asset'] is Map
                      ? ((sem['asset'] as Map)['symbol'] ??
                          (sem['asset'] as Map)['address'] ??
                          (sem['asset'] as Map)['mint'])
                      : null
                })
          : null;
    });
  }

  return {'warnings': warnings, 'checks': Checks(ran, skipped)};
}

// =============================================================================
// THE CORE: inspectTransaction(tx, ctx) -> Inspection
// =============================================================================
Future<Inspection> inspectTransaction(Map<String, dynamic>? tx, SecCtx? ctx) async {
  tx = tx ?? const {};
  ctx = ctx ?? const SecCtx();
  final config = mergeConfig(ctx.config);
  final chain = '${tx['chain'] ?? ctx.chain ?? 'unknown'}';

  _Decoded decoded;
  if (kEvmChains.contains(chain)) {
    decoded = _decodeEvm(tx, config);
  } else if (chain == 'solana') {
    decoded = _decodeSolana(tx, config);
  } else if (kUtxoChains.contains(chain)) {
    decoded = _decodeUtxo(tx);
  } else if (chain == 'block') {
    decoded = _decodeBlock(tx);
  } else {
    decoded = _Decoded(
        kind: 'unknown',
        summary: 'Unrecognized transaction',
        details: const [],
        effects: const [],
        sem: const {});
  }

  final res = await _runWarnings(decoded, tx, ctx, config);
  final warnings = res['warnings'] as List<Warning>;
  return Inspection(
    chain: chain,
    kind: decoded.kind,
    summary: decoded.summary,
    details: decoded.details,
    effects: decoded.effects,
    warnings: warnings,
    severity: maxSeverity(warnings),
    checks: res['checks'] as Checks,
  );
}

// =============================================================================
// 2. APPROVAL MANAGER — read-only list + buildRevoke (routes through sign path)
// =============================================================================

/// An on-chain token allowance held by `owner`.
class Approval {
  final dynamic token;
  final dynamic tokenSymbol;
  final dynamic spender;
  final dynamic spenderLabel;
  final String allowanceBase;
  final bool unlimited;
  final dynamic lastUpdated;

  /// True for an ERC-721/1155 `setApprovalForAll` OPERATOR approval — a
  /// collection-wide grant, not a sized ERC-20 allowance. The NFT view surfaces
  /// these as danger/revocable (see nft.dart surfaceApprovals).
  final bool operator;
  Approval({
    this.token,
    this.tokenSymbol,
    this.spender,
    this.spenderLabel,
    required this.allowanceBase,
    required this.unlimited,
    this.lastUpdated,
    this.operator = false,
  });
  Map<String, dynamic> toMap() => {
        'token': token,
        'tokenSymbol': tokenSymbol,
        'spender': spender,
        'spenderLabel': spenderLabel,
        'allowanceBase': allowanceBase,
        'unlimited': unlimited,
        'lastUpdated': lastUpdated,
        if (operator) 'operator': true,
      };
}

/// The read-only indexer the approval manager sources allowances from.
abstract class ApprovalIndexer {
  Future<List<Map<String, dynamic>>> getApprovals(String chain, String owner);
}

/// The result of listApprovals: NEVER a fabricated all-clear — when no indexer
/// is wired, `available` is false and `note` says so explicitly.
class ApprovalList {
  final String chain;
  final String owner;
  final List<Approval> approvals;
  final bool available;
  final String? note;
  ApprovalList({
    required this.chain,
    required this.owner,
    required this.approvals,
    required this.available,
    this.note,
  });
}

Future<ApprovalList> listApprovals(String chain, String owner, SecCtx? ctx) async {
  ctx = ctx ?? const SecCtx();
  final config = mergeConfig(ctx.config);
  final indexer = ctx.indexer;
  if (indexer == null) {
    // NEVER a fabricated all-clear: empty + an audited "unavailable" note.
    return ApprovalList(
      chain: chain,
      owner: owner,
      approvals: const [],
      available: false,
      note: 'approvals unavailable: no indexer configured — this is NOT a safety claim.',
    );
  }
  List<Map<String, dynamic>> raw;
  try {
    raw = await indexer.getApprovals(chain, owner);
  } catch (e) {
    return ApprovalList(
      chain: chain,
      owner: owner,
      approvals: const [],
      available: false,
      note: 'approvals unavailable: indexer error ($e) — NOT a safety claim.',
    );
  }
  final approvals = raw.map((a) {
    // An operator approval (ERC-721/1155 setApprovalForAll) is a collection-wide
    // grant, not a sized ERC-20 allowance — surface it so the NFT view can flag
    // it as danger. Passthrough is additive (optional fields).
    final isOperator = a['operator'] == true ||
        a['approvedForAll'] == true ||
        a['type'] == 'operator' ||
        a['standard'] == 'operator' ||
        a['kind'] == 'operator';
    final allowance = toBig(a['allowanceBase'] ?? a['allowance'] ?? a['amount'] ?? 0);
    return Approval(
      token: a['token'] ?? a['contract'] ?? a['address'],
      tokenSymbol: a['tokenSymbol'] ?? a['symbol'],
      spender: a['spender'] ?? a['operator'],
      spenderLabel: a['spenderLabel'] ?? a['operatorLabel'],
      allowanceBase: allowance.toString(),
      unlimited: isOperator ? true : allowance >= config.unlimitedThreshold,
      lastUpdated: a['lastUpdated'],
      operator: isOperator,
    );
  }).toList();
  return ApprovalList(chain: chain, owner: owner, approvals: approvals, available: true);
}

/// Build an approve(spender, 0) revoke. The suite NEVER signs — this tx goes
/// through the normal sign path (and the agent gate) like any other.
Map<String, dynamic> buildRevoke(String chain, dynamic token, String? spender) {
  final tokenAddr = (token is Map) ? token['address'] : token;
  if (tokenAddr == null) throw ArgumentError('buildRevoke: missing token address');
  if (spender == null || spender.isEmpty) throw ArgumentError('buildRevoke: missing spender');
  return {
    'chain': chain,
    'kind': 'token-approval-revoke',
    'to': tokenAddr,
    'value': '0',
    'data': erc20ApproveData(spender, BigInt.zero), // approve(spender, 0) via the EXISTING builder
    'note': 'revoke — routes through the normal sign path + agent gate; the suite never signs',
  };
}

// =============================================================================
// 4. PRE-SIGN GATE — the signer calls this before signing. A danger severity
//    forces an EXTRA explicit confirm; fail closed when no confirm handler is
//    wired. Composes with (never weakens) the caller's own gate. Never signs.
// =============================================================================

/// Thrown by [presign] when a danger-level inspection cannot be cleared.
class PresignBlocked implements Exception {
  final String message;
  final bool blocked;
  final bool declined;
  final Inspection inspection;
  PresignBlocked(this.message, this.inspection,
      {this.blocked = false, this.declined = false});
  @override
  String toString() => message;
}

class PresignResult {
  final Inspection inspection;
  final bool cleared;
  PresignResult(this.inspection, this.cleared);
}

Future<PresignResult> presign({
  required Map<String, dynamic> tx,
  SecCtx? ctx,
  Future<bool> Function(Inspection)? confirm,
}) async {
  final inspection = await inspectTransaction(tx, ctx);
  if (inspection.severity == 'danger') {
    if (confirm == null) {
      throw PresignBlocked(
          'signing blocked: danger-level security warnings require explicit confirmation',
          inspection,
          blocked: true);
    }
    final ok = await confirm(inspection);
    if (!ok) {
      throw PresignBlocked(
          'signing declined by user after danger warnings', inspection,
          declined: true);
    }
  }
  return PresignResult(inspection, true);
}

/// Build the tx SHAPE the suite decodes, from a high-level outgoing intent
/// (`{to, amount, asset?, data?, value?}`). Shared by the agent/bots inspect
/// hook and the user-send signer guard so BOTH paths decode identically. Mirrors
/// blockle-extension/wiring.js:buildInspectTx (EVM: raw calldata if present,
/// else an erc20 transfer when the asset is a token, else a native send; BLOCK;
/// a minimal Solana system-transfer; a single-output UTXO send).
Map<String, dynamic> buildInspectTx(String chain, Map<String, dynamic> intent) {
  final asset = intent['asset'];
  if (kEvmChains.contains(chain)) {
    if (intent['data'] != null) {
      return {
        'chain': chain,
        'to': intent['to'],
        'data': intent['data'],
        'value': intent['value'],
        'asset': asset,
      };
    }
    if (asset is Map && asset['kind'] == 'erc20' && asset['address'] != null) {
      return {
        'chain': chain,
        'to': asset['address'],
        'data': erc20TransferData('${intent['to']}', intent['amount'] ?? 0),
        'asset': asset,
      };
    }
    return {'chain': chain, 'to': intent['to'], 'value': intent['amount'] ?? 0, 'asset': asset};
  }
  if (chain == 'block') {
    return {'chain': chain, 'to': intent['to'], 'amount': intent['amount'], 'asset': asset};
  }
  if (chain == 'solana') {
    return {
      'chain': chain,
      'instructions': [
        {
          'program': 'system',
          'type': 'transfer',
          'info': {'destination': intent['to'], 'lamports': '${intent['amount'] ?? 0}'}
        }
      ],
    };
  }
  // utxo (btc/ltc/doge): synthesize a single recipient output for warning rules.
  return {
    'chain': chain,
    'outputs': [
      {'address': intent['to'], 'value': '${intent['amount'] ?? 0}'}
    ],
    'asset': asset,
  };
}

/// Pre-sign guard for a user-initiated outgoing send: build the inspect tx from
/// [intent], then run [presign]. A DANGER severity forces the explicit [confirm]
/// (fail-closed when none is wired — [PresignBlocked.blocked]); a decline throws
/// [PresignBlocked.declined]. Read-only: it NEVER signs or broadcasts — the
/// caller only proceeds to its existing sign/broadcast path on a cleared result.
/// This is the signer-level reuse of the exact same inspector the agent/bots
/// gate uses (mirrors blockle-extension's presign on the signing path).
Future<PresignResult> presignOutgoing({
  required String chain,
  required Map<String, dynamic> intent,
  SecCtx? ctx,
  Future<bool> Function(Inspection)? confirm,
}) {
  return presign(tx: buildInspectTx(chain, intent), ctx: ctx, confirm: confirm);
}
