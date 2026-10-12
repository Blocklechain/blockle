// multichain/walletconnect.dart — Wallet dApp Connect (WalletConnect v2, Sign
// API) CORE.
//
// Spec: docs/WALLET-WALLETCONNECT.md. One spec, three identical implementations:
// blockle-extension/walletconnect.js is the JS reference; this is the Dart port;
// python/blockle ports the SAME shared vectors (docs/walletconnect-vectors.json).
// Behaviourally IDENTICAL to the reference, asserted against those vectors.
//
// WHAT THIS IS: the SESSION + REQUEST state machine + the SECURITY integration.
// It is PURE given an INJECTED [relay] client — the WC v2 relay transport + the
// WC crypto (x25519 + chacha20-poly1305) live behind that client and are NOT
// implemented here (tests inject a FAKE relay). The real SDK wiring + a live
// pairing smoke test are the final integration step (see §6), like the HTLC
// transport.
//
// TRUST MODEL (the whole point): an external dApp is UNTRUSTED. Unlike the
// user's own bots — which may run auto within an allocation — EVERY dApp signing
// request requires explicit human approval AND runs through the wallet security
// pre-sign gate (reuses security.dart inspectTransaction/decode). NO dApp request
// ever auto-approves. The core NEVER holds keys: it signs via the injected
// wallet [signer] ONLY after approval, and sessions persist NO key material.
//
// All money is base-unit / BigInt-exact.

import 'dart:convert';

import 'security.dart' show Inspection, SecCtx, Warning, inspectTransaction, maxSeverity, toBig;

// ---- pinned JSON-RPC / state-machine error codes (shared across ports) ------
const int errUnauthorized = 3001; // chain/method outside the approved namespace
const int errUserRejected = 4001; // a human declined the approval / danger confirm
const int errEthSignDisabled = 4100; // eth_sign refused by default (blind-sign)
const int errSessionExpired = 4201; // request on an expired session
const int errUnknownTopic = 4202; // request on a topic with no settled session
const int errUnsupportedChain = 4203; // switch/add to a chain the wallet lacks
const int errBlocked = 5000; // fail-closed: no approval/confirm handler wired

const Map<String, int> kWcErr = {
  'UNAUTHORIZED': errUnauthorized,
  'USER_REJECTED': errUserRejected,
  'ETH_SIGN_DISABLED': errEthSignDisabled,
  'SESSION_EXPIRED': errSessionExpired,
  'UNKNOWN_TOPIC': errUnknownTopic,
  'UNSUPPORTED_CHAIN': errUnsupportedChain,
  'BLOCKED': errBlocked,
};

// The SUPPORTED + SAFE method set the wallet will ever settle into a session.
// eth_sign is DELIBERATELY absent (refused by default, §3). Read methods are
// answered from session state.
const List<String> kDefaultMethods = [
  'eth_sendTransaction',
  'eth_signTypedData', 'eth_signTypedData_v4', 'eth_signTypedData_v3',
  'personal_sign',
  'wallet_switchEthereumChain', 'wallet_addEthereumChain',
  'eth_accounts', 'eth_chainId',
  'solana_signTransaction', 'solana_signAndSendTransaction', 'solana_signMessage',
];
const Set<String> kReadMethods = {'eth_accounts', 'eth_chainId'};
const List<String> kDefaultEvents = ['accountsChanged', 'chainChanged'];
const int kDefaultTtlSeconds = 7 * 24 * 3600;
const int kDefaultLongDeadlineSeconds = 30 * 24 * 3600;

const String kStoreKey = 'wc:sessions';

// unlimited sentinels for off-chain (Permit / Permit2) approvals. Permit2 amount
// is uint160 (max 2^160-1 is its "infinite" sentinel); EIP-2612 value is uint256
// (max 2^256-1). The generic unlimitedThreshold (2^255) catches uint256-style
// grants; the uint160 sentinel is matched explicitly so a Permit2 infinite
// allowance is never missed.
final BigInt kMaxUint256 = (BigInt.one << 256) - BigInt.one;
final BigInt kMaxUint160 = (BigInt.one << 160) - BigInt.one;
final BigInt kMaxUint48 = (BigInt.one << 48) - BigInt.one; // Permit2 "no expiry"

// ---- small pure helpers -----------------------------------------------------
String? _lc(dynamic s) => s == null ? null : '$s'.toLowerCase();

List<T> _uniq<T>(Iterable<T> it) {
  final seen = <T>{};
  final out = <T>[];
  for (final x in it) {
    if (seen.add(x)) out.add(x);
  }
  return out;
}

int _nowSec(int ms) => ms ~/ 1000;

String? hostOf(String? url) {
  if (url == null || url.isEmpty) return null;
  try {
    final u = Uri.parse(url);
    if (u.host.isNotEmpty) return u.host.toLowerCase();
  } catch (_) {/* fall through */}
  final stripped = url.replaceFirst(RegExp(r'^[a-z]+://', caseSensitive: false), '');
  final m = stripped.split(RegExp(r'[/?#]')).first;
  return m.isEmpty ? null : m.toLowerCase();
}

String? hexToUtf8(dynamic hex) {
  final h = '$hex'.replaceFirst(RegExp(r'^0x'), '');
  if (h.isEmpty || h.length % 2 != 0 || RegExp(r'[^0-9a-fA-F]').hasMatch(h)) {
    return null;
  }
  final bytes = <int>[];
  for (var i = 0; i < h.length; i += 2) {
    bytes.add(int.parse(h.substring(i, i + 2), radix: 16));
  }
  try {
    return utf8.decode(bytes, allowMalformed: true);
  } catch (_) {
    return null;
  }
}

String _utf8ToHex(String s) {
  final bytes = utf8.encode(s);
  final sb = StringBuffer('0x');
  for (final b in bytes) {
    sb.write(b.toRadixString(16).padLeft(2, '0'));
  }
  return sb.toString();
}

bool _isMostlyPrintable(String s) {
  if (s.isEmpty) return false;
  var printable = 0;
  for (final c in s.codeUnits) {
    if (c == 9 || c == 10 || c == 13 || (c >= 32 && c < 127) || c >= 160) {
      printable++;
    }
  }
  return printable / s.length >= 0.8;
}

// JSON-RPC result / error shapers. handleRequest echoes the request id.
Map<String, dynamic> _rpcResult(dynamic id, dynamic result) => {'id': id, 'result': result};
Map<String, dynamic> _rpcError(dynamic id, int code, String message, [dynamic data]) => {
      'id': id,
      'error': {'code': code, 'message': message, if (data != null) 'data': data},
    };

// a gate-produced JSON-RPC error, caught and returned by handleRequest.
class _RpcError implements Exception {
  final Map<String, dynamic> rpc;
  _RpcError(this.rpc);
}

// ===========================================================================
// 1. PAIRING URI — accept ONLY v2, reject v1 + malformed with a clear error.
// ===========================================================================
// wc:<topic>@2?relay-protocol=irn&symKey=<hex>
Map<String, dynamic> parsePairingUri(dynamic uri) {
  if (uri is! String) {
    throw ArgumentError('walletconnect: pairing URI must be a string');
  }
  final s = uri.trim();
  if (!s.toLowerCase().startsWith('wc:')) {
    throw ArgumentError('walletconnect: not a WalletConnect URI (missing wc: scheme)');
  }
  final body = s.substring(3);
  final at = body.indexOf('@');
  if (at < 0) {
    throw ArgumentError('walletconnect: malformed pairing URI (missing @version)');
  }
  final topic = body.substring(0, at);
  final rest = body.substring(at + 1);
  final qIndex = rest.indexOf('?');
  final version = qIndex < 0 ? rest : rest.substring(0, qIndex);
  if (version == '1') {
    throw ArgumentError(
        'walletconnect: WalletConnect v1 URIs are not supported (deprecated + insecure) — use a v2 (@2) link');
  }
  if (version != '2') {
    throw ArgumentError(
        'walletconnect: unsupported WalletConnect version "@$version" (only v2 is accepted)');
  }
  if (topic.isEmpty || RegExp(r'[^0-9a-f]', caseSensitive: false).hasMatch(topic)) {
    throw ArgumentError('walletconnect: malformed pairing URI (bad topic)');
  }
  final query = qIndex < 0 ? '' : rest.substring(qIndex + 1);
  final params = <String, String>{};
  for (final kv in query.split('&')) {
    if (kv.isEmpty) continue;
    final eq = kv.indexOf('=');
    final k = eq < 0 ? kv : kv.substring(0, eq);
    final v = eq < 0 ? '' : Uri.decodeComponent(kv.substring(eq + 1));
    params[k] = v;
  }
  final relayProtocol = params['relay-protocol'];
  final symKey = params['symKey'];
  if (relayProtocol == null || relayProtocol.isEmpty) {
    throw ArgumentError('walletconnect: malformed pairing URI (missing relay-protocol)');
  }
  if (symKey == null || !RegExp(r'^[0-9a-f]{64}$', caseSensitive: false).hasMatch(symKey)) {
    throw ArgumentError('walletconnect: malformed pairing URI (missing or invalid symKey)');
  }
  return {
    'protocol': 'wc',
    'topic': topic,
    'version': 2,
    'relayProtocol': relayProtocol,
    'symKey': symKey,
  };
}

// ===========================================================================
// injected platform pieces
// ===========================================================================

/// The key/value encrypted settings backend WC sessions persist through (the
/// same backend address book / settings use). `get` returns `{key: value}` for
/// the requested key; `set` merges. NO key material is ever stored here.
abstract class WalletConnectStore {
  Future<Map<String, dynamic>> get(String key);
  Future<void> set(Map<String, dynamic> obj);
}

/// In-memory fallback store (tests inject their own; prod injects the encrypted
/// settings backend).
class InMemoryWcStore implements WalletConnectStore {
  final Map<String, dynamic> mem = {};
  @override
  Future<Map<String, dynamic>> get(String key) async => {key: mem[key]};
  @override
  Future<void> set(Map<String, dynamic> obj) async => mem.addAll(obj);
}

/// The injected relay transport (real SDK per platform; FAKE in tests). The WC
/// v2 crypto lives behind this; the core never touches it.
abstract class WcRelay {
  Future<void> pair(Map<String, dynamic> parsed);
  Future<void> approveProposal(Map<String, dynamic> proposal, Map<String, dynamic> settled);
  Future<void> rejectProposal(Map<String, dynamic> proposal, Map<String, dynamic> reason);
  Future<void> respond(String topic, Map<String, dynamic> response);
  Future<void> disconnect(String topic, Map<String, dynamic>? reason);
  void Function() subscribeRequests(Future<Map<String, dynamic>> Function(Map<String, dynamic> request) onRequest);
}

/// The injected wallet signer. Signs ONLY after approval; the core holds no keys.
abstract class WcSigner {
  Future<dynamic> ethSendTransaction(Map<String, dynamic> args);
  Future<dynamic> ethSignTypedData(Map<String, dynamic> args);
  Future<dynamic> personalSign(Map<String, dynamic> args);
  Future<dynamic> solanaSignTransaction(Map<String, dynamic> args);
  Future<dynamic> solanaSignAndSend(Map<String, dynamic> args);
  Future<dynamic> solanaSignMessage(Map<String, dynamic> args);
}

/// Per-call, host-provided context: the REQUIRED human approval gate (every
/// signing request — no dApp request auto-approves), the EXTRA confirm a DANGER
/// forces (fail-closed when absent), and optional extra security-inspect ctx.
class WcRequestCtx {
  final Future<bool> Function(Map<String, dynamic> presentation)? approve;
  final Future<bool> Function(Map<String, dynamic> presentation)? confirm;
  final SecCtx? security;
  const WcRequestCtx({this.approve, this.confirm, this.security});
}

/// Merged, normalized WC config.
class WcConfig {
  final Set<String> denylist; // lowercased
  final Set<String> walletChains;
  final Set<String> supportedMethods;
  final Set<String> supportedEvents;
  final bool allowEthSign;
  final int sessionTtlSeconds;
  final BigInt unlimitedThreshold;
  final int longDeadlineSeconds;
  WcConfig({
    required this.denylist,
    required this.walletChains,
    required this.supportedMethods,
    required this.supportedEvents,
    required this.allowEthSign,
    required this.sessionTtlSeconds,
    required this.unlimitedThreshold,
    required this.longDeadlineSeconds,
  });
}

WcConfig normalizeConfig(Map<String, dynamic>? c) {
  c = c ?? const {};
  final denylist = {
    for (final d in (c['denylist'] as List? ?? const [])) _lc(d)!
  };
  final walletChains = {
    ...((c['walletChains'] ?? c['chains']) as List? ?? const []).map((e) => '$e')
  };
  final supportedMethods = {
    ...((c['supportedMethods'] as List?)?.map((e) => '$e') ?? kDefaultMethods)
  };
  final allowEthSign = c['allowEthSign'] == true;
  if (allowEthSign) {
    supportedMethods.add('eth_sign');
  } else {
    supportedMethods.remove('eth_sign');
  }
  final supportedEvents = {
    ...((c['supportedEvents'] as List?)?.map((e) => '$e') ?? kDefaultEvents)
  };
  return WcConfig(
    denylist: denylist,
    walletChains: walletChains,
    supportedMethods: supportedMethods,
    supportedEvents: supportedEvents,
    allowEthSign: allowEthSign,
    sessionTtlSeconds:
        c['sessionTtlSeconds'] != null ? (c['sessionTtlSeconds'] as num).toInt() : kDefaultTtlSeconds,
    unlimitedThreshold:
        c['unlimitedThreshold'] != null ? toBig(c['unlimitedThreshold']) : (BigInt.one << 255),
    longDeadlineSeconds: c['longDeadlineSeconds'] != null
        ? (c['longDeadlineSeconds'] as num).toInt()
        : kDefaultLongDeadlineSeconds,
  );
}

// ---- CAIP + namespace helpers ----------------------------------------------
String caip2OfAccount(dynamic caip10) {
  final parts = '$caip10'.split(':');
  return parts.length >= 3 ? '${parts[0]}:${parts[1]}' : '$caip10';
}

String addressOfAccount(dynamic caip10) {
  final parts = '$caip10'.split(':');
  return parts.length >= 3 ? parts.sublist(2).join(':') : '$caip10';
}

Map<String, dynamic>? _namespaceForChain(Map<String, dynamic> session, dynamic chainId) {
  final nss = (session['namespaces'] as Map?) ?? const {};
  for (final nsId in nss.keys) {
    final ns = (nss[nsId] as Map).cast<String, dynamic>();
    final chains = (ns['chains'] as List? ?? const []).map((e) => '$e');
    if (chains.contains('$chainId')) return ns;
  }
  return null;
}

Map<String, dynamic>? _accountFor(Map<String, dynamic> session, dynamic chainId) {
  final ns = _namespaceForChain(session, chainId);
  if (ns == null) return null;
  final accounts = (ns['accounts'] as List? ?? const []).map((e) => '$e').toList();
  String? caip10;
  for (final a in accounts) {
    if (caip2OfAccount(a) == '$chainId') {
      caip10 = a;
      break;
    }
  }
  caip10 ??= accounts.isNotEmpty ? accounts.first : null;
  if (caip10 == null) return null;
  return {'caip10': caip10, 'address': addressOfAccount(caip10), 'chainId': '$chainId'};
}

List<String> _addressesFor(Map<String, dynamic> session, dynamic chainId) {
  final ns = _namespaceForChain(session, chainId);
  if (ns == null) return const [];
  return (ns['accounts'] as List? ?? const [])
      .map((e) => '$e')
      .where((a) => caip2OfAccount(a) == '$chainId')
      .map(addressOfAccount)
      .toList();
}

String? chainIdHex(dynamic caip2) {
  if (caip2 == null) return null;
  final parts = '$caip2'.split(':');
  final n = parts.length > 1 ? parts[1] : '';
  if (RegExp(r'^\d+$').hasMatch(n)) return '0x${int.parse(n).toRadixString(16)}';
  return '$caip2'; // non-eip155 (e.g. solana) — return caip2 as-is
}

// map a CAIP-2 eip155 chain to the security suite's chain name (best-effort).
const Map<String, String> _eip155Name = {
  '1': 'ethereum', '8453': 'base', '42161': 'arbitrum', '10': 'optimism',
  '137': 'polygon', '56': 'bnb', '43114': 'avalanche',
};
String evmChainName(dynamic chainId) {
  if (chainId == null) return 'ethereum';
  final parts = '$chainId'.split(':');
  if (parts[0] == 'solana') return 'solana';
  if (parts[0] == 'eip155') return _eip155Name[parts.length > 1 ? parts[1] : ''] ?? 'ethereum';
  return 'ethereum';
}

String _namespaceIdOf(dynamic caip2) => '$caip2'.split(':').first;

// ===========================================================================
// EIP-712 typed-data decode + Permit / Permit2 detection (off-chain approval
// phishing is a top drainer vector — flag unlimited / long-deadline as DANGER)
// ===========================================================================
Map<String, dynamic> decodeTypedData(dynamic raw, WcConfig cfg, int nowS) {
  dynamic typed;
  try {
    typed = raw is String ? jsonDecode(raw) : raw;
  } catch (_) {
    typed = {};
  }
  typed = (typed is Map) ? typed : {};
  final domain = (typed['domain'] as Map?)?.cast<String, dynamic>() ?? const {};
  final message = (typed['message'] as Map?)?.cast<String, dynamic>() ?? const {};
  final primaryType = '${typed['primaryType'] ?? ''}';

  final warnings = <Warning>[];
  final isPermit2 = _lc(domain['name']) == 'permit2' || RegExp(r'^Permit(Single|Batch)$').hasMatch(primaryType);
  final msgDetails = (message['details'] as Map?)?.cast<String, dynamic>();
  final looksPermit = RegExp('permit', caseSensitive: false).hasMatch(primaryType) ||
      ((message['value'] != null || message['amount'] != null || (msgDetails != null && msgDetails['amount'] != null)) &&
          (message['spender'] != null || (msgDetails != null && msgDetails['token'] != null)));
  final isApproval = isPermit2 || looksPermit;

  final details = <Map<String, dynamic>>[
    {'label': 'Primary type', 'value': primaryType.isNotEmpty ? primaryType : '(unknown)'},
    {'label': 'Domain', 'value': domain['name'] != null ? '${domain['name']}' : '(unnamed)'},
  ];
  if (domain['verifyingContract'] != null) {
    details.add({'label': 'Verifying contract', 'value': domain['verifyingContract']});
  }
  if (domain['chainId'] != null) {
    details.add({'label': 'Chain id', 'value': '${domain['chainId']}'});
  }

  var severity = 'none';
  final sem = <String, dynamic>{};

  if (isApproval) {
    final spender = message['spender'] ?? (msgDetails != null ? msgDetails['spender'] : null);
    final token = (msgDetails != null ? msgDetails['token'] : null) ?? message['token'] ?? domain['verifyingContract'];
    final amountRaw = message['value'] != null
        ? message['value']
        : (msgDetails != null && msgDetails['amount'] != null)
            ? msgDetails['amount']
            : message['amount'];
    final deadlineRaw = message['deadline'] != null
        ? message['deadline']
        : message['sigDeadline'] != null
            ? message['sigDeadline']
            : (msgDetails != null ? msgDetails['expiration'] : null);

    BigInt? amount;
    var unlimited = false;
    if (amountRaw != null) {
      amount = toBig(amountRaw);
      unlimited = amount >= cfg.unlimitedThreshold || amount == kMaxUint160 || amount == kMaxUint256;
    }
    BigInt? deadline;
    var longDeadline = false;
    if (deadlineRaw != null) {
      deadline = toBig(deadlineRaw);
      final longWindow = BigInt.from(cfg.longDeadlineSeconds);
      longDeadline = deadline == kMaxUint48 ||
          deadline == kMaxUint256 ||
          (deadline > BigInt.from(nowS) && (deadline - BigInt.from(nowS)) > longWindow);
    }

    sem['spender'] = spender;
    sem['token'] = token;
    sem['unlimited'] = unlimited;
    sem['longDeadline'] = longDeadline;
    sem['amount'] = amount?.toString();
    sem['deadline'] = deadline?.toString();

    details.add({'label': 'Spender', 'value': spender ?? '(none)'});
    if (token != null) details.add({'label': 'Token', 'value': token});
    details.add({
      'label': 'Allowance',
      'value': amount == null ? '(none)' : (unlimited ? 'UNLIMITED' : amount.toString())
    });
    if (deadline != null) {
      details.add({
        'label': 'Deadline',
        'value': (deadline == kMaxUint48 || deadline == kMaxUint256) ? 'NEVER EXPIRES' : deadline.toString()
      });
    }

    warnings.add(Warning('offchain-approval', 'info',
        'This is an OFF-CHAIN token approval signature (Permit${isPermit2 ? '2' : ''}) — it grants a spender allowance without an on-chain tx.',
        {'spender': spender, 'token': token}));
    if (unlimited) {
      warnings.add(Warning('permit-unlimited', 'danger',
          'This Permit grants an UNLIMITED token allowance — the spender can drain your entire balance.',
          {'spender': spender, 'amount': sem['amount']}));
    }
    if (longDeadline) {
      warnings.add(Warning('permit-long-deadline', 'danger',
          'This Permit has an extremely long (or no) expiry — the allowance stays live far into the future.',
          {'spender': spender, 'deadline': sem['deadline']}));
    }
    severity = maxSeverity(warnings);
  }

  final kind = isApproval ? 'typed-data-permit' : 'typed-data';
  final summary = isApproval
      ? ('Sign off-chain approval (${isPermit2 ? 'Permit2' : 'Permit'})${sem['unlimited'] == true ? ' — UNLIMITED' : ''}${sem['spender'] != null ? ' to ${sem['spender']}' : ''}')
      : ('Sign typed data: ${primaryType.isNotEmpty ? primaryType : 'struct'}${domain['name'] != null ? ' (${domain['name']})' : ''}');

  return {
    'kind': kind,
    'primaryType': primaryType,
    'domain': domain,
    'message': message,
    'typed': typed,
    'details': details,
    'warnings': warnings,
    'severity': severity,
    'summary': summary,
    'sem': sem,
    'isApproval': isApproval,
    'isPermit2': isPermit2,
  };
}

// personal_sign — decode UTF-8 + flag a tx / EIP-712 smuggled as "text".
Map<String, dynamic> decodePersonalSign(dynamic params) {
  final msgRaw = params is List ? (params.isNotEmpty ? params[0] : null) : params;
  final isHex = msgRaw is String && RegExp(r'^0x[0-9a-fA-F]*$').hasMatch(msgRaw);
  final messageHex = isHex ? msgRaw : _utf8ToHex('${msgRaw ?? ''}');
  final decodedText = isHex ? hexToUtf8(msgRaw) : null;
  final text = isHex ? (decodedText ?? '$msgRaw') : '${msgRaw ?? ''}';

  final warnings = <Warning>[];
  final t = text;
  final looksTyped = RegExp(r'"types"\s*:').hasMatch(t) && RegExp(r'"domain"\s*:').hasMatch(t);
  final hexBody = isHex ? msgRaw.replaceFirst(RegExp(r'^0x'), '') : '';
  final looksRawTx = isHex && hexBody.length >= 64 && !_isMostlyPrintable(t);
  if (looksTyped) {
    warnings.add(Warning('personal-sign-structured', 'warn',
        'This "message" contains EIP-712 typed-data JSON — a structured approval may be smuggled as plain text. Read it carefully.'));
  }
  if (looksRawTx) {
    warnings.add(Warning('personal-sign-binary', 'warn',
        'This "message" is a long binary/hex blob (not human-readable text) — it may be a raw transaction or digest. Do not sign unless you know what it is.'));
  }

  return {
    'kind': 'personal-sign',
    'messageHex': messageHex,
    'text': t,
    'details': [
      {'label': 'Message', 'value': t}
    ],
    'warnings': warnings,
    'severity': maxSeverity(warnings),
    'summary': 'Sign message: ${t.length > 80 ? '${t.substring(0, 80)}…' : t}',
  };
}

// ===========================================================================
// factory — all platform pieces INJECTED. relay + store + signer are mockable.
// ===========================================================================
class WalletConnect {
  final WcRelay? relay;
  final WalletConnectStore store;
  final WcSigner? signer;
  final int Function() _clock;
  final WcConfig config;

  WalletConnect({
    this.relay,
    WalletConnectStore? store,
    this.signer,
    Map<String, dynamic>? config,
    int Function()? now,
  })  : store = store ?? InMemoryWcStore(),
        _clock = now ?? (() => DateTime.now().millisecondsSinceEpoch),
        config = normalizeConfig(config);

  Map<String, int> get err => kWcErr;

  // ---- session persistence (NO key material ever stored) --------------------
  Future<Map<String, dynamic>> _loadAll() async {
    final got = await store.get(kStoreKey);
    final map = got[kStoreKey];
    return (map is Map) ? map.cast<String, dynamic>() : <String, dynamic>{};
  }

  Future<void> _saveAll(Map<String, dynamic> map) => store.set({kStoreKey: map});

  Future<List<Map<String, dynamic>>> listSessions() async {
    final map = await _loadAll();
    return map.values.map((v) => (v as Map).cast<String, dynamic>()).toList();
  }

  Future<Map<String, dynamic>?> getSession(String topic) async {
    final map = await _loadAll();
    final s = map[topic];
    return s is Map ? s.cast<String, dynamic>() : null;
  }

  Future<Map<String, dynamic>> _putSession(Map<String, dynamic> sess) async {
    final map = await _loadAll();
    map['${sess['topic']}'] = sess;
    await _saveAll(map);
    return sess;
  }

  Future<Map<String, dynamic>> disconnect(String topic, [Map<String, dynamic>? reason]) async {
    final map = await _loadAll();
    final existed = map.containsKey(topic);
    map.remove(topic);
    await _saveAll(map);
    if (existed && relay != null) {
      try {
        await relay!.disconnect(topic, reason);
      } catch (_) {/* best-effort */}
    }
    return {'topic': topic, 'disconnected': existed};
  }

  // ---- 1b. pair — hand the parsed pairing to the relay. Grants NOTHING. -----
  Future<Map<String, dynamic>> pair(dynamic uri) async {
    final parsed = parsePairingUri(uri); // throws on v1/malformed
    if (relay != null) await relay!.pair(parsed);
    return parsed;
  }

  // ---- 2. PROPOSAL review / approve / reject --------------------------------
  Map<String, List<String>> _flattenNamespaces(dynamic ns) {
    final chains = <String>[], methods = <String>[], events = <String>[];
    final m = (ns is Map) ? ns.cast<String, dynamic>() : const <String, dynamic>{};
    for (final key in m.keys) {
      final entry = (m[key] as Map?)?.cast<String, dynamic>() ?? const {};
      var entryChains = (entry['chains'] as List? ?? const []).map((e) => '$e').toList();
      if (entryChains.isEmpty && key.contains(':')) entryChains = [key];
      chains.addAll(entryChains);
      methods.addAll((entry['methods'] as List? ?? const []).map((e) => '$e'));
      events.addAll((entry['events'] as List? ?? const []).map((e) => '$e'));
    }
    return {'chains': _uniq(chains), 'methods': _uniq(methods), 'events': _uniq(events)};
  }

  Map<String, List<String>> _mergedRequest(Map<String, dynamic> proposal) {
    final req = _flattenNamespaces(proposal['requiredNamespaces']);
    final opt = _flattenNamespaces(proposal['optionalNamespaces']);
    return {
      'requiredChains': req['chains']!,
      'chains': _uniq([...req['chains']!, ...opt['chains']!]),
      'methods': _uniq([...req['methods']!, ...opt['methods']!]),
      'events': _uniq([...req['events']!, ...opt['events']!]),
    };
  }

  Map<String, dynamic> reviewProposal(Map<String, dynamic>? proposal) {
    proposal = proposal ?? {};
    final proposer = (proposal['proposer'] as Map?)?.cast<String, dynamic>();
    final dappRaw = (proposer?['metadata'] as Map?)?.cast<String, dynamic>() ??
        (proposal['dapp'] as Map?)?.cast<String, dynamic>() ??
        (proposal['metadata'] as Map?)?.cast<String, dynamic>() ??
        const {};
    // CLAIMED metadata — surfaced, NEVER trusted.
    final dapp = {
      'name': dappRaw['name'],
      'url': dappRaw['url'],
      'icons': dappRaw['icons'] ?? const [],
      'description': dappRaw['description'],
    };
    final m = _mergedRequest(proposal);
    final warnings = <Warning>[];

    final host = hostOf(dapp['url'] as String?);
    final url = dapp['url'] as String?;
    if (host != null && (config.denylist.contains(host) || (url != null && config.denylist.contains(_lc(url))))) {
      warnings.add(Warning('dapp-domain-denylisted', 'danger',
          'This dApp domain is on the known-phishing / scam denylist.', {'url': url, 'host': host}));
    }
    final unsupported = m['chains']!.where((c) => !config.walletChains.contains(c)).toList();
    if (unsupported.isNotEmpty) {
      warnings.add(Warning('requests-unsupported-chain', 'warn',
          'The dApp requests chains this wallet does not control; those will not be granted.',
          {'chains': unsupported}));
    }
    if (m['methods']!.contains('eth_sign')) {
      warnings.add(Warning('requests-eth_sign', 'warn',
          'The dApp requests eth_sign — a blind-sign legacy method refused by default (classic phishing vector).'));
    }

    return {
      'dapp': dapp,
      'requiredNamespaces': proposal['requiredNamespaces'] ?? const {},
      'optionalNamespaces': proposal['optionalNamespaces'] ?? const {},
      'chains': m['chains'],
      'methods': m['methods'],
      'events': m['events'],
      'warnings': warnings,
      'severity': maxSeverity(warnings),
    };
  }

  // approveProposal — settled namespace = requested ∩ wallet-controlled
  // chains/accounts + the supported+safe method set. A REQUIRED chain the wallet
  // lacks is rejected (fail-closed); never fabricated. Calling this IS the
  // explicit user approval (the host calls it only after the human approves).
  Future<Map<String, dynamic>> approveProposal(Map<String, dynamic>? proposal,
      {List<String> accounts = const [], int? ttlSeconds}) async {
    proposal = proposal ?? {};
    final offered = accounts.where((a) => a.isNotEmpty).toList();
    final review = reviewProposal(proposal);
    final m = _mergedRequest(proposal);

    // chains the wallet actually controls = config-controlled ∩ offered-account chains
    final offeredChains = offered.map(caip2OfAccount).toSet();
    final controlled = config.walletChains.where(offeredChains.contains).toSet();

    // fail-closed: a REQUIRED chain not controlled => reject the whole proposal.
    final missingRequired = m['requiredChains']!.where((c) => !controlled.contains(c)).toList();
    if (missingRequired.isNotEmpty) {
      throw StateError(
          'walletconnect: proposal requires chains the wallet does not control: ${missingRequired.join(', ')}');
    }

    final settledChains = m['chains']!.where(controlled.contains).toList();
    final settledMethods = m['methods']!.where(config.supportedMethods.contains).toList();
    final settledEvents = m['events']!.where(config.supportedEvents.contains).toList();

    // group into namespaces keyed by the caip2 namespace id (eip155, solana…)
    final namespaces = <String, Map<String, dynamic>>{};
    for (final c in settledChains) {
      final nsId = _namespaceIdOf(c);
      namespaces.putIfAbsent(nsId, () => {'chains': <String>[], 'accounts': <String>[], 'methods': <String>[], 'events': <String>[]});
      (namespaces[nsId]!['chains'] as List).add(c);
    }
    for (final a in offered) {
      final c = caip2OfAccount(a);
      if (!controlled.contains(c)) continue; // never expose an account on an unsettled chain
      final nsId = _namespaceIdOf(c);
      if (namespaces.containsKey(nsId)) (namespaces[nsId]!['accounts'] as List).add(a);
    }
    for (final nsId in namespaces.keys) {
      namespaces[nsId]!['methods'] = _uniq(settledMethods);
      namespaces[nsId]!['events'] = _uniq(settledEvents);
      namespaces[nsId]!['chains'] = _uniq((namespaces[nsId]!['chains'] as List).cast<String>());
      namespaces[nsId]!['accounts'] = _uniq((namespaces[nsId]!['accounts'] as List).cast<String>());
    }

    final nowMs = _clock();
    final ttl = ttlSeconds ?? config.sessionTtlSeconds;
    final topic = proposal['sessionTopic'] ?? proposal['topic'] ?? proposal['pairingTopic'];
    if (topic == null) throw StateError('walletconnect: proposal has no session topic');

    final relays = proposal['relays'] as List?;
    final relayProtocol = (relays != null && relays.isNotEmpty && relays[0] is Map)
        ? ((relays[0] as Map)['protocol'] ?? 'irn')
        : 'irn';

    final session = <String, dynamic>{
      'topic': topic,
      'pairingTopic': proposal['pairingTopic'],
      'dapp': review['dapp'], // CLAIMED metadata (persisted as claimed)
      'namespaces': namespaces,
      'activeChainId': settledChains.isNotEmpty ? settledChains.first : null,
      'createdAt': nowMs,
      'expiry': nowMs + ttl * 1000, // ms epoch
      'relayProtocol': relayProtocol,
      // NO key material. Ever.
    };

    await _putSession(session);
    if (relay != null) {
      try {
        await relay!.approveProposal(proposal, {'namespaces': namespaces, 'topic': topic});
      } catch (_) {/* transport best-effort */}
    }
    return session;
  }

  Future<void> rejectProposal(Map<String, dynamic>? proposal, [Map<String, dynamic>? reason]) async {
    proposal = proposal ?? {};
    if (relay != null) {
      try {
        await relay!.rejectProposal(
            proposal, reason ?? {'code': errUserRejected, 'message': 'user rejected the session proposal'});
      } catch (_) {/* best-effort */}
    }
  }

  // ---- 3. REQUEST ROUTING — namespace enforcement FIRST, then signing surface.
  Future<Map<String, dynamic>> handleRequest(Map<String, dynamic>? request, [WcRequestCtx? ctx]) async {
    request = request ?? {};
    ctx = ctx ?? const WcRequestCtx();
    final id = request['id'];
    final topic = request['topic'];
    final chainId = request['chainId'];
    final method = request['method'];
    final params = request['params'];

    // (4) unknown topic / expiry — state-machine guards first.
    final session = await getSession('$topic');
    if (session == null) return _rpcError(id, errUnknownTopic, 'no settled session for topic: $topic');
    final expiry = session['expiry'];
    if (expiry != null && _clock() >= (expiry as num)) {
      return _rpcError(id, errSessionExpired, 'session expired — reconnect the dApp');
    }

    // eth_sign — REFUSED by default with an explanatory error.
    if (method == 'eth_sign' && !config.allowEthSign) {
      return _rpcError(id, errEthSignDisabled,
          'eth_sign is disabled: it blind-signs an arbitrary 32-byte digest (a classic drainer vector). '
          'Use personal_sign or eth_signTypedData_v4 instead.');
    }

    // NAMESPACE ENFORCEMENT — chainId + method must be inside the approved ns.
    final ns = _namespaceForChain(session, chainId);
    if (ns == null) {
      return _rpcError(id, errUnauthorized, 'unauthorized chain (outside the approved session namespace): $chainId');
    }
    final methodAllowed = (ns['methods'] as List? ?? const []).map((e) => '$e').contains('$method') ||
        kReadMethods.contains(method);
    if (!methodAllowed) {
      return _rpcError(id, errUnauthorized, 'unauthorized method (outside the approved session namespace): $method');
    }

    // READ methods — answered from session state, NO prompt.
    if (method == 'eth_accounts') return _rpcResult(id, _addressesFor(session, chainId));
    if (method == 'eth_chainId') return _rpcResult(id, chainIdHex(session['activeChainId'] ?? chainId));

    final account = _accountFor(session, chainId);

    try {
      switch (method) {
        case 'eth_sendTransaction':
          return await _doEthSendTransaction(id, session, chainId, params, account, ctx);
        case 'eth_signTypedData':
        case 'eth_signTypedData_v4':
        case 'eth_signTypedData_v3':
          return await _doSignTypedData(id, session, chainId, '$method', params, account, ctx);
        case 'personal_sign':
          return await _doPersonalSign(id, session, chainId, params, account, ctx);
        case 'wallet_switchEthereumChain':
          return await _doSwitchChain(id, session, params, ctx);
        case 'wallet_addEthereumChain':
          return await _doAddChain(id, session, params, ctx);
        case 'solana_signTransaction':
          return await _doSolana(id, session, chainId, 'signTransaction', params, account, ctx);
        case 'solana_signAndSendTransaction':
          return await _doSolana(id, session, chainId, 'signAndSendTransaction', params, account, ctx);
        case 'solana_signMessage':
          return await _doSolanaMessage(id, session, chainId, params, account, ctx);
        default:
          return _rpcError(id, errUnauthorized, 'unsupported method: $method');
      }
    } on _RpcError catch (e) {
      return e.rpc;
    }
  }

  // ---- the ONE human + security gate every signing request flows through ----
  // Returns normally when cleared to sign; throws _RpcError when rejected/blocked.
  // A DANGER severity forces the extra confirm (fail-closed). NEVER auto-approves.
  Future<void> _gate(dynamic id, Map<String, dynamic> presentation, WcRequestCtx ctx) async {
    final severity = presentation['severity'] ?? 'none';
    if (severity == 'danger') {
      if (ctx.confirm == null) {
        throw _RpcError(_rpcError(id, errBlocked,
            'signing blocked: danger-level security warnings require an explicit confirmation handler (fail-closed)'));
      }
      final okc = await ctx.confirm!(presentation);
      if (!okc) {
        throw _RpcError(_rpcError(id, errUserRejected, 'user declined after danger-level warnings'));
      }
    }
    // explicit human approval is ALWAYS required — never auto-approve a dApp.
    if (ctx.approve == null) {
      throw _RpcError(_rpcError(id, errBlocked,
          'signing blocked: no approval handler wired — an external dApp request can never auto-approve (fail-closed)'));
    }
    final ok = await ctx.approve!(presentation);
    if (!ok) {
      throw _RpcError(_rpcError(id, errUserRejected, 'user rejected the request'));
    }
  }

  SecCtx _securityCtx(WcRequestCtx ctx, dynamic chainId) {
    final base = ctx.security;
    final mergedConfig = <String, dynamic>{
      ...?base?.config,
      'denylist': config.denylist.toList(),
      'unlimitedThreshold': config.unlimitedThreshold.toString(),
    };
    return SecCtx(
      chain: evmChainName(chainId),
      config: mergedConfig,
      getCode: base?.getCode,
      getBalance: base?.getBalance,
      estimateUsd: base?.estimateUsd,
      seenRecipients: base?.seenRecipients,
      priorApprovals: base?.priorApprovals,
      indexer: base?.indexer,
    );
  }

  Future<Map<String, dynamic>> _doEthSendTransaction(
      dynamic id, Map<String, dynamic> session, dynamic chainId, dynamic params, Map<String, dynamic>? account, WcRequestCtx ctx) async {
    final tx = params is List ? (params.isNotEmpty ? params[0] : null) : params;
    final inspectTx = <String, dynamic>{'chain': evmChainName(chainId), ...(tx as Map? ?? const {}).cast<String, dynamic>()};
    final Inspection inspection = await inspectTransaction(inspectTx, _securityCtx(ctx, chainId));
    final presentation = {
      'method': 'eth_sendTransaction', 'topic': session['topic'], 'chainId': chainId,
      'dapp': session['dapp'], 'account': account,
      'inspection': inspection, 'severity': inspection.severity, 'warnings': inspection.warnings,
    };
    await _gate(id, presentation, ctx); // throws on reject/block
    if (signer == null) throw _RpcError(_rpcError(id, errBlocked, 'no signer wired for eth_sendTransaction'));
    final hash = await signer!.ethSendTransaction({'account': account, 'chainId': chainId, 'tx': tx, 'inspection': inspection});
    return _rpcResult(id, hash is String ? hash : (hash is Map ? (hash['hash'] ?? hash) : hash));
  }

  Future<Map<String, dynamic>> _doSignTypedData(
      dynamic id, Map<String, dynamic> session, dynamic chainId, String method, dynamic params, Map<String, dynamic>? account, WcRequestCtx ctx) async {
    final raw = params is List ? (params.length > 1 ? params[1] : null) : params;
    final decoded = decodeTypedData(raw, config, _nowSec(_clock()));
    final presentation = {
      'method': method, 'topic': session['topic'], 'chainId': chainId, 'dapp': session['dapp'], 'account': account,
      'decoded': decoded, 'warnings': decoded['warnings'], 'severity': decoded['severity'],
    };
    await _gate(id, presentation, ctx);
    if (signer == null) throw _RpcError(_rpcError(id, errBlocked, 'no signer wired for $method'));
    final version = method == 'eth_signTypedData_v3' ? 'v3' : 'v4';
    final sig = await signer!.ethSignTypedData(
        {'account': account, 'chainId': chainId, 'typedData': decoded['typed'], 'version': version, 'decoded': decoded});
    return _rpcResult(id, sig);
  }

  Future<Map<String, dynamic>> _doPersonalSign(
      dynamic id, Map<String, dynamic> session, dynamic chainId, dynamic params, Map<String, dynamic>? account, WcRequestCtx ctx) async {
    final decoded = decodePersonalSign(params);
    final presentation = {
      'method': 'personal_sign', 'topic': session['topic'], 'chainId': chainId, 'dapp': session['dapp'], 'account': account,
      'decoded': decoded, 'warnings': decoded['warnings'], 'severity': decoded['severity'],
    };
    await _gate(id, presentation, ctx);
    if (signer == null) throw _RpcError(_rpcError(id, errBlocked, 'no signer wired for personal_sign'));
    final sig = await signer!.personalSign(
        {'account': account, 'chainId': chainId, 'message': decoded['messageHex'], 'text': decoded['text']});
    return _rpcResult(id, sig);
  }

  // Parse a dApp-supplied hex chainId (e.g. "0x1") into a CAIP-2 string, or null
  // when the dApp sent a missing/non-hex value. Never throws (a malformed value
  // from an untrusted dApp must yield a graceful JSON-RPC error, not crash the
  // request handler).
  String? _caip2FromHex(dynamic hexId) {
    final s = '$hexId'.trim();
    if (s.isEmpty || s == 'null') return null;
    final hex = s.replaceFirst(RegExp(r'^0x', caseSensitive: false), '');
    final n = int.tryParse(hex, radix: 16);
    if (n == null) return null;
    return 'eip155:$n';
  }

  Future<Map<String, dynamic>> _doSwitchChain(dynamic id, Map<String, dynamic> session, dynamic params, WcRequestCtx ctx) async {
    final p = params is List ? (params.isNotEmpty ? params[0] : null) : params;
    final hexId = (p is Map) ? p['chainId'] : p;
    final caip2 = _caip2FromHex(hexId);
    if (caip2 == null) {
      return _rpcError(id, errUnsupportedChain, 'wallet_switchEthereumChain: missing or non-hex chainId');
    }
    if (_namespaceForChain(session, caip2) == null && !config.walletChains.contains(caip2)) {
      return _rpcError(id, errUnsupportedChain, 'cannot switch to a chain the wallet does not have: $caip2');
    }
    await _gate(id, {'method': 'wallet_switchEthereumChain', 'topic': session['topic'], 'chainId': caip2, 'dapp': session['dapp'], 'severity': 'none'}, ctx);
    session['activeChainId'] = caip2;
    await _putSession(session);
    return _rpcResult(id, null);
  }

  Future<Map<String, dynamic>> _doAddChain(dynamic id, Map<String, dynamic> session, dynamic params, WcRequestCtx ctx) async {
    final p = params is List ? (params.isNotEmpty ? params[0] : null) : params;
    final hexId = (p is Map) ? p['chainId'] : null;
    final caip2 = _caip2FromHex(hexId);
    if (caip2 == null) {
      return _rpcError(id, errUnsupportedChain, 'wallet_addEthereumChain: missing or non-hex chainId');
    }
    if (!config.walletChains.contains(caip2)) {
      return _rpcError(id, errUnsupportedChain, 'refusing to add a chain the wallet does not have configured: $caip2');
    }
    await _gate(id, {'method': 'wallet_addEthereumChain', 'topic': session['topic'], 'chainId': caip2, 'dapp': session['dapp'], 'severity': 'none'}, ctx);
    return _rpcResult(id, null);
  }

  Future<Map<String, dynamic>> _doSolana(
      dynamic id, Map<String, dynamic> session, dynamic chainId, String kind, dynamic params, Map<String, dynamic>? account, WcRequestCtx ctx) async {
    final Map<String, dynamic> p = (params is Map)
        ? params.cast<String, dynamic>()
        : {'transaction': params is List ? (params.isNotEmpty ? params[0] : null) : params};
    final txObj = p['transaction'];
    final instructions = p['instructions'] ?? (txObj is Map ? txObj['instructions'] : null) ?? const [];
    final Inspection inspection = await inspectTransaction({'chain': 'solana', 'instructions': instructions}, _securityCtx(ctx, chainId));
    final presentation = {
      'method': 'solana_$kind', 'topic': session['topic'], 'chainId': chainId, 'dapp': session['dapp'], 'account': account,
      'inspection': inspection, 'severity': inspection.severity, 'warnings': inspection.warnings,
    };
    await _gate(id, presentation, ctx);
    if (signer == null) throw _RpcError(_rpcError(id, errBlocked, 'no signer wired for solana_$kind'));
    final out = kind == 'signAndSendTransaction'
        ? await signer!.solanaSignAndSend({'account': account, 'chainId': chainId, 'transaction': p['transaction'], 'inspection': inspection})
        : await signer!.solanaSignTransaction({'account': account, 'chainId': chainId, 'transaction': p['transaction'], 'inspection': inspection});
    return _rpcResult(id, out);
  }

  Future<Map<String, dynamic>> _doSolanaMessage(
      dynamic id, Map<String, dynamic> session, dynamic chainId, dynamic params, Map<String, dynamic>? account, WcRequestCtx ctx) async {
    final Map<String, dynamic> p = (params is Map)
        ? params.cast<String, dynamic>()
        : {'message': params is List ? (params.isNotEmpty ? params[0] : null) : params};
    final text = p['message'] != null ? '${p['message']}' : '';
    final presentation = {
      'method': 'solana_signMessage', 'topic': session['topic'], 'chainId': chainId, 'dapp': session['dapp'], 'account': account,
      'decoded': {'kind': 'message', 'text': text}, 'warnings': const <Warning>[], 'severity': 'none',
    };
    await _gate(id, presentation, ctx);
    if (signer == null) throw _RpcError(_rpcError(id, errBlocked, 'no signer wired for solana_signMessage'));
    final sig = await signer!.solanaSignMessage({'account': account, 'chainId': chainId, 'message': p['message']});
    return _rpcResult(id, sig);
  }

  // ---- connect the relay (integration glue; tests call handleRequest direct) -
  void Function() connectRelay([WcRequestCtx? ctx]) {
    if (relay == null) return () {};
    return relay!.subscribeRequests((request) async {
      final response = await handleRequest(request, ctx ?? const WcRequestCtx());
      await relay!.respond('${request['topic']}', response);
      return response;
    });
  }
}
