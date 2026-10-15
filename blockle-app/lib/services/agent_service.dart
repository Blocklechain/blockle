// agent_service.dart — the host wiring for the in-wallet AI agent. Constructs a
// [ChannelManager] (lib/agent/channels.dart) bound to the app's Accounts facade,
// ChainRegistry, VenueRegistry, and Telemetry, and persists each channel's
// secret-free connection record so channels AUTO-RESUME on the next unlock.
//
// SAFETY / CREDENTIAL RULES (non-bypassable, mirror the extension):
//   - The LLM API key is NEVER persisted here. Channel records hold only a
//     `credRef`; the key is resolved from the UNLOCKED vault at start time,
//     held in memory for the session, and dropped on stop/kill/lock.
//   - Every value-moving tool goes through the agent's own policy
//     (caps -> confirm -> kill -> allowlist, hash-chained audit); this service
//     only provides the confirm handler + the host-wide kill fan-out.
//   - The global kill locks the Accounts facade (wipes HD seed + BLOCK key +
//     adapters + vault session) in one call.

import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

import '../agent/channels.dart';
import '../agent/command.dart' show CommandRouter, CommandEngines, ResolveNameFn;
import '../agent/index.dart' show AgentCredential;
import '../agent/providers.dart'
    show ProviderFetch, ProviderResponse, hostedSession, defaultGatewayUrl;
import '../agent/tools.dart' show AgentContext, AmmLike, ExchangeLike;
import '../multichain/accounts.dart';
import '../multichain/chains/chain_adapter.dart';
import '../multichain/chains/evm.dart' show erc20ApproveData;
import '../multichain/chains/registry.dart';
import '../multichain/security.dart' as sec;
import '../multichain/telemetry.dart' show Telemetry;
import '../multichain/venues.dart' show VenueRegistry;

/// A [ChannelStore] backed by flutter_secure_storage. All channel keys (records
/// + per-channel audit logs) are kept in ONE JSON blob under [blobKey] so the
/// chrome.storage-style get/set/remove map onto a single encrypted entry.
class SecureChannelStore implements ChannelStore {
  SecureChannelStore({FlutterSecureStorage? storage, this.blobKey = 'bk_agent_channels'})
      : _storage = storage ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            );

  final FlutterSecureStorage _storage;
  final String blobKey;

  Future<Map<String, dynamic>> _read() async {
    final raw = await _storage.read(key: blobKey);
    if (raw == null || raw.isEmpty) return {};
    try {
      return (jsonDecode(raw) as Map).cast<String, dynamic>();
    } catch (_) {
      return {};
    }
  }

  Future<void> _write(Map<String, dynamic> m) =>
      _storage.write(key: blobKey, value: jsonEncode(m));

  @override
  Future<Map<String, dynamic>> get(List<String>? keys) async {
    final m = await _read();
    if (keys == null) return m;
    return {for (final k in keys) if (m.containsKey(k)) k: m[k]};
  }

  @override
  Future<void> set(Map<String, dynamic> obj) async {
    final m = await _read();
    m.addAll(obj);
    await _write(m);
  }

  @override
  Future<void> remove(List<String> keys) async {
    final m = await _read();
    for (final k in keys) {
      m.remove(k);
    }
    await _write(m);
  }
}

/// Default ProviderFetch over package:http (the providers only ever POST/GET to
/// their chosen LLM API — the key is in the headers the provider builds).
Future<ProviderResponse> httpProviderFetch(
  String url, {
  required String method,
  required Map<String, String> headers,
  required String body,
}) async {
  final uri = Uri.parse(url);
  final http.Response r;
  if (method == 'GET') {
    r = await http.get(uri, headers: headers);
  } else {
    r = await http.post(uri, headers: headers, body: body);
  }
  return ProviderResponse(r.statusCode >= 200 && r.statusCode < 300, r.statusCode, r.body);
}

/// The host service that owns the agent's channels.
class AgentService {
  AgentService({
    required this.accounts,
    required this.venues,
    this.telemetry,
    ChannelStore? store,
    ProviderFetch? fetch,
    Future<bool> Function(Map<String, dynamic> summary)? confirm,
    Future<num?> Function(String asset, String amount)? estimateUsd,
    ExchangeLike? exchange,
    AmmLike? amm,
    Future<dynamic> Function(Map<String, dynamic> spec)? launchToken,
    Future<Map<String, dynamic>?> Function(dynamic challenge)? payX402Usdc,
    Future<dynamic> Function(String challenge)? hostedSign,
    Map<String, dynamic>? defaults,
    Map<String, dynamic>? securityConfig,
  })  : store = store ?? SecureChannelStore(),
        _estimateUsd = estimateUsd,
        _exchange = exchange,
        _amm = amm,
        _launchToken = launchToken,
        _payX402Override = payX402Usdc,
        _confirm = confirm,
        _hostedSign = hostedSign,
        _fetch = fetch ?? httpProviderFetch,
        _securityConfig = securityConfig {
    manager = ChannelManager(
      fetch: _fetch,
      store: this.store,
      resolveCredential: _resolveCredential,
      // Transparent hosted-session refresh: re-sign the gateway challenge and
      // update the stored token in place (mirrors agent-ui.js:hostedRefresh +
      // agent-store.refreshHosted). A BYO-key channel passes null here.
      hostedRefresh: _hostedRefresh,
      confirm: confirm,
      onKill: _killAll,
      ctxFor: _ctxFor,
      onEvent: _onEvent,
      defaults: defaults ?? const {},
    );
  }

  final Accounts accounts;
  final VenueRegistry venues;
  final Telemetry? telemetry;
  final ChannelStore store;
  final Future<num?> Function(String asset, String amount)? _estimateUsd;

  // Optional trading surfaces, wired by the host when the build supports them.
  // Each is null in a minimal build and the corresponding tool then fails closed
  // with a clear "capability not available" error (mirrors blockle-extension/wiring.js).
  final ExchangeLike? _exchange;
  final AmmLike? _amm;
  final Future<dynamic> Function(Map<String, dynamic> spec)? _launchToken;
  final Future<Map<String, dynamic>?> Function(dynamic challenge)? _payX402Override;

  /// The shared value-moving confirm handler (same one the ChannelManager gate
  /// uses — it presents the SHARED security confirm sheet). Held here so the
  /// commit-time signer guards below (the x402 payTo and the DEX approve SPENDER,
  /// neither of which is known at prepare()/gate time) can force an EXPLICIT
  /// human confirm on a DANGER inspection via [sec.presignOutgoing]. Fail-closed:
  /// no handler => a danger inspection cannot be cleared and the broadcast is
  /// refused (never auto-paid).
  final Future<bool> Function(Map<String, dynamic> summary)? _confirm;

  /// The injected HTTP transport (also handed to the ChannelManager). Reused by
  /// the hosted connect handshake + the transparent refresh re-sign.
  final ProviderFetch _fetch;

  /// The wallet's own signer for the KEYLESS hosted handshake: `sign(challenge)`
  /// returns `{ signature, publicKey }` and proves control of an address (NOT a
  /// spend). Null => the handshake uses the gateway's anonymous (rate-limited,
  /// free-tier) fallback. No private key / seed is ever placed in the request.
  final Future<dynamic> Function(String challenge)? _hostedSign;

  /// Operator overrides for the WALLET SECURITY SUITE (denylist / knownSpenders /
  /// largeSharePct / thresholds / per-rule toggles). The shipped default router
  /// allowlist is always seeded on top via [sec.defaultSecurityConfig].
  final Map<String, dynamic>? _securityConfig;

  late final ChannelManager manager;

  ChainRegistry get registry => accounts.registry;

  /// Load persisted channel records (does NOT start them).
  Future<void> load() => manager.load();

  /// Auto-resume every enabled channel (call right after a successful unlock).
  Future<Map<String, dynamic>> resume() => manager.resume();

  /// Build a NATURAL-LANGUAGE COMMAND BAR router over a RUNNING channel. It adds
  /// NO new power: it reuses that channel's live provider, its EXISTING tool
  /// registry, and — crucially — its ONE policy/gate (the SAME policy whose
  /// `confirm` is the shared security sheet). Value moves still flow only through
  /// `dispatchValueMoving`; a query runs in a read-only registry. Returns null
  /// when no suitable channel is running (nothing to drive yet).
  ///
  /// [channelId] selects a specific channel; otherwise the first running one is
  /// used. [resolveName] is the WalletAddressBook name resolver bound to the
  /// active chain ctx; [engines] supplies the read-only net-worth / bots-P&L
  /// sources a QUERY answers from (never fabricated).
  CommandRouter? buildCommandRouter({
    String? channelId,
    void Function(Map<String, dynamic> ev)? onEvent,
    ResolveNameFn? resolveName,
    CommandEngines? engines,
    int? maxTurns,
    String? defaultChain,
  }) {
    Channel? ch = channelId != null ? manager.get(channelId) : null;
    ch ??= _firstRunning();
    final inst = ch?.instance;
    if (inst == null) return null;
    return CommandRouter(
      provider: inst.runner.provider,
      tools: inst.tools,
      policy: inst.policy,
      audit: inst.audit,
      pnl: inst.pnlHook,
      pnlWallet: ch!.meta['walletId'] as String?,
      pnlChannel: ch.id,
      onEvent: onEvent,
      resolveNameFn: resolveName,
      engines: engines,
      maxTurns: maxTurns,
      defaultChain: defaultChain ?? (ch.meta['accountId'] as String?),
    );
  }

  Channel? _firstRunning() {
    for (final c in manager.channels.values) {
      if (c.running) return c;
    }
    return null;
  }

  // --- credential resolution (vault-only; never persisted) ------------------

  Future<AgentCredential?> _resolveCredential(
      String? credRef, Map<String, dynamic> meta) async {
    if (!accounts.vault.isUnlocked) return null;
    final agent = accounts.vault.plaintext?.agent;
    if (agent == null) return null;
    // HOSTED (keyless) record: resolve the gatewayUrl + short-lived sessionToken
    // (NO apiKey). This is what makes the `hosted` provider actually used — the
    // channel starts against Blockle's gateway with only a session token.
    final provider =
        (meta['provider'] as String?) ?? (agent['provider'] as String?);
    if (provider == 'hosted') {
      final gatewayUrl = (agent['gatewayUrl'] as String?) ?? '';
      final sessionToken = (agent['sessionToken'] as String?) ?? '';
      if (gatewayUrl.isEmpty || sessionToken.isEmpty) return null;
      return AgentCredential(
        provider: 'hosted',
        gatewayUrl: gatewayUrl,
        sessionToken: sessionToken,
        expiresAt: (agent['expiresAt'] as num?)?.toInt(),
        model: (meta['model'] as String?) ?? agent['model'] as String?,
      );
    }
    final apiKey = (agent['apiKey'] as String?) ?? '';
    if (apiKey.isEmpty) return null;
    return AgentCredential(
      provider: provider ?? 'claude',
      apiKey: apiKey,
      model: (meta['model'] as String?) ?? agent['model'] as String?,
      baseUrl: (meta['baseUrl'] as String?) ?? agent['baseUrl'] as String?,
    );
  }

  // --- keyless hosted connect + transparent refresh -------------------------

  /// KEYLESS connect: run the wallet-signature session handshake against the
  /// gateway (challenge -> sign with the wallet address key -> verify ->
  /// sessionToken) and return the stored hosted-connection fields (gatewayUrl,
  /// sessionToken, expiresAt, address, chain, publicKey, label). The caller seals
  /// this into the vault — it holds NO apiKey, and no private key/seed is ever
  /// sent (only a signature over a server nonce + the public key). Mirrors
  /// blockle-extension/agent-store.js:connectHosted. With no signer wired the
  /// gateway's anonymous (rate-limited) fallback is used.
  Future<Map<String, dynamic>> connectHosted({
    String? gatewayUrl,
    String? address,
    String? chain,
    String? publicKey,
    String? label,
    Future<dynamic> Function(String challenge)? sign,
    bool anon = false,
  }) {
    return hostedSession(
      fetch: _fetch,
      gatewayUrl: gatewayUrl ?? defaultGatewayUrl,
      address: address,
      chain: chain,
      publicKey: publicKey,
      label: label,
      sign: sign ?? _hostedSign,
      anon: anon,
    );
  }

  /// Re-sign the gateway challenge on a 401/expiry and update the stored session
  /// token in place, returning the fresh token (or null to give up). The new
  /// token lives in the in-memory vault session immediately and is written to
  /// disk on the next reseal. Mirrors agent-ui.js:hostedRefresh.
  Future<String?> _hostedRefresh(
      String? credRef, AgentCredential cred, Map<String, dynamic> meta) async {
    if (!accounts.vault.isUnlocked) return null;
    final agent = accounts.vault.plaintext?.agent;
    if (agent == null || agent['provider'] != 'hosted') return null;
    try {
      // An anon session (or one with no bound address) re-signs nothing — re-open
      // the rate-limited anon session. A per-address session (chain "evm") is
      // re-signed via EIP-191 so it verifies gateway-side, never 401s.
      final chain = agent['chain'] as String?;
      final address = agent['address'] as String?;
      final isAnon = chain == 'anon' || address == null || address.isEmpty;
      final sess = await hostedSession(
        fetch: _fetch,
        gatewayUrl:
            cred.gatewayUrl ?? (agent['gatewayUrl'] as String?) ?? defaultGatewayUrl,
        address: address,
        chain: chain,
        publicKey: agent['publicKey'] as String?,
        sign: isAnon ? null : _hostedSign,
        anon: isAnon,
      );
      final tok = sess['sessionToken'] as String?;
      if (tok == null || tok.isEmpty) return null;
      agent['sessionToken'] = tok;
      agent['expiresAt'] = sess['expiresAt'];
      return tok;
    } catch (_) {
      return null;
    }
  }

  // --- host-wide kill fan-out -----------------------------------------------

  Future<void> _killAll(String? reason) async {
    accounts.kill(); // wipes seed + BLOCK key + adapters + vault session
  }

  // --- telemetry (best-effort, fire-and-forget; never blocks the agent) -----

  void _onEvent(String id, Map<String, dynamic> ev) {
    final t = telemetry;
    if (t == null || !t.isEnabled()) return;
    try {
      t.emit({'channel': id, ...ev});
    } catch (_) {}
  }

  // --- per-channel AgentContext bound to Accounts + registry + venues -------

  AgentContext _ctxFor(Map<String, dynamic> meta) => buildAgentContext(meta);

  /// Build the per-channel [AgentContext] bound to Accounts + registry + venues.
  /// Public so the host (and tests) can assert the PRODUCTION ctx wiring — most
  /// importantly that it carries the WALLET SECURITY `inspect` hook (below), so
  /// a danger-severity order forces a human confirm in the gate.
  AgentContext buildAgentContext([Map<String, dynamic> meta = const {}]) {
    return AgentContext(
      getAddress: (chain) async => (await accounts.accountFor(chain)).address,
      getBalance: (chain, [tokens]) async {
        final acct = await accounts.accountFor(chain);
        final bals = await registry
            .get(chain)
            .getBalance(acct.address, tokens: registry.tokensFor(chain));
        return [
          for (final b in bals)
            {
              'asset': b.asset.toJson(),
              'confirmed': b.confirmed,
              'display': b.display,
              if (b.spendable != null) 'spendable': b.spendable,
              if (b.error != null) 'error': b.error,
            }
        ];
      },
      buildSend: (chain, req) => _buildSend(chain, req),
      broadcast: (chain, built) => _broadcast(chain, built),
      explorerTx: (chain, txid) =>
          txid == null ? null : registry.get(chain).explorerTx(txid),
      estimateUsd: _estimateUsd,
      exchange: _exchange,
      venues: venues,
      amm: _amm,
      launchToken: _launchToken,
      sendFee: (feeXfer) => _sendFee(feeXfer),
      // Sign + broadcast a venue's BuiltSwap by its SHAPE (native intent / EVM
      // router call / Solana serialized tx) — NEVER route the unsigned built
      // through _broadcast (which expects an already-signed raw-hex BuiltTx).
      executeSwap: (built) => _executeSwap(built),
      payX402Usdc: _payX402Override ?? _payX402Usdc,
      // WALLET SECURITY SUITE: the read-only pre-sign inspector tools.dart calls
      // in prepare(). A danger inspection sets prep.forceConfirm, which
      // dispatchValueMoving surfaces into the gate and which policy.gateConfirm
      // turns into a MANDATORY human confirm — even within a bot's allocation or
      // under autoApproveUnderUsd. Without this hook inspect() returns null,
      // prep.security stays null, and a danger auto-approves (the bug this fixes).
      // Mirrors blockle-extension/wiring.js:agentCtx.inspect.
      inspect: (chain, intent) => _inspect(chain, intent),
    );
  }

  // --- WALLET SECURITY SUITE: read-only pre-sign inspection -----------------
  // Build the suite's injected ctx from the operator config + live adapters and
  // run inspectTransaction over the agent's prepared intent. Best-effort +
  // read-only: it never signs and never throws into the trade path (a failure
  // degrades to "fewer checks ran", never a fabricated OK). Mirrors
  // blockle-extension/wiring.js:{securityCtx,buildInspectTx,inspect}.

  sec.SecCtx _securityCtx(String chain) {
    // Seed the shipped default router allowlist (so approval-to-unknown-spender
    // runs by default) unioned with any operator overrides.
    final config = sec.defaultSecurityConfig(_securityConfig);

    // Best-effort native/token balance for the large-share check. Any failure
    // (no adapter for this chain, RPC error, locked) degrades to '0' => the
    // check runs but cannot fire, never a fabricated all-clear.
    Future<dynamic> getBalance(dynamic asset) async {
      try {
        final adapter = registry.get(chain);
        final acct = await accounts.accountFor(chain);
        final isToken = asset is Map && asset['kind'] != null && asset['kind'] != 'native';
        final bals = await adapter.getBalance(acct.address,
            tokens: isToken ? registry.tokensFor(chain) : null);
        final want = asset is Map
            ? (asset['address'] ?? asset['mint'] ?? asset['symbol'])
            : null;
        for (final b in bals) {
          final a = b.asset;
          final match = want != null
              ? (a.address == want || a.symbol == want)
              : a.kind == 'native';
          if (match) return b.confirmed;
        }
        return bals.isNotEmpty ? bals.first.confirmed : '0';
      } catch (_) {
        return '0';
      }
    }

    return sec.SecCtx(
      chain: chain,
      config: config,
      // EVM adapters expose no eth_getCode in this build, so approval-to-eoa is
      // recorded as skipped (never fabricated) — exactly as the suite intends.
      getBalance: getBalance,
      estimateUsd: _estimateUsd == null
          ? null
          : (asset, amount) => _estimateUsd(
              asset is Map ? '${asset['symbol'] ?? ''}' : '$asset', amount),
    );
  }

  Future<sec.Inspection?> _inspect(
      String chain, Map<String, dynamic> intent) async {
    try {
      final tx = sec.buildInspectTx(chain, intent);
      return await sec.inspectTransaction(tx, _securityCtx(chain));
    } catch (_) {
      return null;
    }
  }

  /// Adapt the stored value-moving [_confirm] handler into the
  /// `Future<bool> Function(Inspection)` shape [sec.presign] expects, merging the
  /// decoded inspection (severity + summary + warning codes) into [base] so the
  /// SHARED confirm sheet renders the security preview. Fail-closed: with no
  /// confirm handler wired a danger inspection can never be cleared.
  Future<bool> _confirmInspection(
      sec.Inspection insp, Map<String, dynamic> base) async {
    final c = _confirm;
    if (c == null) return false; // fail closed: no explicit confirm possible
    return c({
      ...base,
      'security': {
        'severity': insp.severity,
        'summary': insp.summary,
        'warnings': insp.warnings.map((w) => w.code).toList(),
      },
    });
  }

  /// Execute a venue's BuiltSwap. Three shapes, three rails; nothing here holds a
  /// key (adapters sign from their in-memory root seed, wiped on lock). Ported
  /// from blockle-extension/wiring.js:executeSwap.
  Future<Map<String, dynamic>> _executeSwap(Map<String, dynamic> built) async {
    // (1) native Blockle rail — drive the non-custodial exchange / AMM intent.
    final intent = built['intent'];
    if (intent is Map && intent['kind'] == 'exchange-swap') {
      final sw = _exchange?.swap;
      if (sw == null) {
        throw StateError(
            'capability not available in this wallet build: exchange.swap');
      }
      final r = await sw(
        '${intent['from']}',
        '${intent['to']}',
        '${intent['amount']}',
        {'slippage': intent['slippage']},
      );
      return r;
    }

    final tx = built['tx'];

    // (2) Solana serialized tx (Jupiter): sign layer exists but this build wires
    // no Solana adapter / SOL-SPL fee transfer, so the fee cannot be routed ->
    // fail closed rather than trade without collecting the fee.
    if (tx is Map && tx['swapTransaction'] != null) {
      throw StateError(
          'solana swap execution is not wired in this build yet (sign layer present; '
          'registry adapter + SOL/SPL fee transfer pending) — fail closed');
    }

    // (3) EVM DEX router call — optional ERC-20 approve, then signArbitraryTx.
    if (tx is Map && tx['to'] != null) {
      final chain = (built['chain'] ?? tx['chain']) as String;
      final adapter = registry.get(chain);
      final acct = await accounts.accountFor(chain);
      final dyn = adapter as dynamic; // EvmAdapter exposes allowance/buildApprove/signArbitraryTx
      final fromId = built['from'];
      final allowanceTarget = built['allowanceTarget'];
      // Grant the router its allowance when the INPUT is an ERC-20 we must approve.
      if (allowanceTarget != null &&
          fromId is String &&
          RegExp(r'^0x[0-9a-fA-F]{40}$').hasMatch(fromId)) {
        // The allowance READ is best-effort (an RPC failure degrades to "assume
        // no approve needed" — the router reverts if it truly is). The approve
        // SIGN/BROADCAST below is NOT best-effort: its security guard must be
        // able to abort (fail closed), so it lives OUTSIDE this catch.
        var needApprove = false;
        try {
          final cur = await dyn.allowance(fromId, acct.address, allowanceTarget);
          final need = BigInt.parse('${built['amountIn'] ?? '0'}');
          needApprove = BigInt.parse('${cur ?? '0'}') < need;
        } catch (_) {
          needApprove = false;
        }
        if (needApprove) {
          // WALLET SECURITY SUITE: the approve SPENDER (allowanceTarget) is
          // venue-supplied — externally-influenced calldata that the swap's
          // prepare() inspect (which looked at the router call tx.to) did NOT
          // cover, because this approve is a SEPARATE tx broadcast here at commit
          // time. Inspect it before signing: a DANGER spender (denylisted /
          // known-drainer / unknown) forces an EXPLICIT human confirm through the
          // shared sheet, and fail-closed (no confirm => PresignBlocked) rather
          // than blind-approving a hostile spender over this ERC-20.
          await sec.presignOutgoing(
            chain: chain,
            intent: {
              'to': fromId, // the ERC-20 token contract
              'data': erc20ApproveData(allowanceTarget as String),
              'asset': {'chain': chain, 'kind': 'erc20', 'address': fromId},
            },
            ctx: _securityCtx(chain),
            confirm: (insp) => _confirmInspection(insp, {
              'action': 'approve',
              'chain': chain,
              'token': fromId,
              'spender': allowanceTarget,
            }),
          );
          final ap = await dyn.buildApprove(acct, fromId, allowanceTarget);
          await adapter.broadcast(ap as BuiltTx);
        }
      }
      final signed = await dyn.signArbitraryTx(acct, tx.cast<String, dynamic>());
      final res = await adapter.broadcast(signed as BuiltTx);
      return {'txid': res.txid, 'accepted': res.accepted};
    }

    throw StateError('executeSwap: unrecognized built-swap shape');
  }

  // --- x402 settlement: sign a USDC transfer on Base/Ethereum ----------------
  static const Map<String, String> _x402Net = {
    'base': 'base',
    'base-mainnet': 'base',
    '8453': 'base',
    'ethereum': 'ethereum',
    'mainnet': 'ethereum',
    '1': 'ethereum',
  };

  Map<String, dynamic>? _firstEvmAccept(dynamic challenge) {
    if (challenge is! Map) return null;
    final accepts = challenge['accepts'] is List
        ? challenge['accepts'] as List
        : challenge['paymentOptions'] is List
            ? challenge['paymentOptions'] as List
            : [challenge];
    for (final o in accepts) {
      if (o is! Map) continue;
      final net = _x402Net['${o['network']}'.toLowerCase()];
      final to = o['payTo'] ?? o['recipient'] ?? o['address'] ?? o['to'];
      final amount = o['maxAmountRequired'] ?? o['amount'] ?? o['value'];
      if (net != null && to != null && amount != null) {
        return {
          'chain': net,
          'to': to,
          'amount': amount,
          'asset': o['asset'] ?? o['token'] ?? o['tokenAddress'],
        };
      }
    }
    return null;
  }

  /// Settle an x402 challenge by signing a USDC transfer on Base/Ethereum.
  /// Returns null when the challenge is not a resolvable EVM/USDC accept (the
  /// caller then surfaces the challenge untouched — never a fabricated receipt).
  Future<Map<String, dynamic>?> _payX402Usdc(dynamic challenge) async {
    final acc = _firstEvmAccept(challenge);
    if (acc == null) return null;
    final chain = acc['chain'] as String;
    final assetAddr = acc['asset'] as String?;
    final asset = assetAddr != null
        ? {
            'chain': chain,
            'kind': 'erc20',
            'symbol': 'USDC',
            'decimals': 6,
            'address': assetAddr,
          }
        : null;
    // WALLET SECURITY SUITE: the x402 payTo is RELAY/SELLER-SUPPLIED — an
    // externally-influenced recipient revealed only in the challenge at
    // settlement time, AFTER the buy_block policy gate already ran on the USDC
    // spend. Inspect it BEFORE building/signing/broadcasting: a DANGER payTo (on
    // the drainer / scam denylist, or otherwise flagged) forces an EXPLICIT human
    // confirm through the shared sheet, and fail-closed (no confirm handler =>
    // PresignBlocked, which buy_block's commit catches and surfaces the challenge
    // UNPAID) rather than signing a USDC transfer to a hostile recipient.
    final pre = await sec.presignOutgoing(
      chain: chain,
      intent: {'to': acc['to'], 'amount': '${acc['amount']}', 'asset': asset},
      ctx: _securityCtx(chain),
      confirm: (insp) => _confirmInspection(insp, {
        'action': 'x402_pay',
        'chain': chain,
        'to': acc['to'],
        'amount': '${acc['amount']}',
        'asset': assetAddr,
      }),
    );
    final built = await _buildSend(chain, {
      'to': acc['to'],
      'amount': '${acc['amount']}',
      'asset': asset,
    });
    final res = await _broadcast(chain, built);
    return {
      'paymentTxid': res['txid'] ?? built['txid'],
      'chain': chain,
      'to': acc['to'],
      'amount': '${acc['amount']}',
      'asset': assetAddr,
      'security': {
        'severity': pre.inspection.severity,
        'warnings': pre.inspection.warnings.map((w) => w.code).toList(),
      },
    };
  }

  Future<Map<String, dynamic>> _buildSend(
      String chain, Map<String, dynamic> req) async {
    final acct = await accounts.accountFor(chain);
    final adapter = registry.get(chain);
    final built = await adapter.buildSend(
      acct,
      SendRequest(
        to: req['to'] as String,
        amount: '${req['amount']}',
        asset: _assetFromMap(req['asset']),
        feeRate: req['feeRate'] as String?,
        memo: req['memo'] as String?,
      ),
    );
    return {
      'chain': built.chain,
      'raw': built.raw,
      'txid': built.txid,
      'fee': built.fee,
    };
  }

  Future<Map<String, dynamic>> _broadcast(
      String chain, Map<String, dynamic> built) async {
    final adapter = registry.get(chain);
    final res = await adapter.broadcast(BuiltTx(
      chain: (built['chain'] as String?) ?? chain,
      raw: built['raw'] as String,
      txid: (built['txid'] as String?) ?? '',
      fee: '${built['fee'] ?? '0'}',
      summary: const SendRequest(to: '', amount: '0'),
    ));
    return {'txid': res.txid, 'accepted': res.accepted};
  }

  /// The 0.05% fee leg: a gated + audited transfer to the treasury on the fee's
  /// chain. Built + broadcast through the SAME adapters as any other send.
  Future<Map<String, dynamic>> _sendFee(Map<String, dynamic> feeXfer) async {
    final chain = feeXfer['chain'] as String;
    final built = await _buildSend(chain, {
      'to': feeXfer['treasury'] ?? feeXfer['to'],
      'amount': '${feeXfer['amount']}',
      'asset': feeXfer['asset'],
    });
    return _broadcast(chain, built);
  }

  static AssetRef? _assetFromMap(dynamic m) {
    if (m is! Map) return null;
    return AssetRef(
      chain: '${m['chain']}',
      kind: '${m['kind'] ?? 'native'}',
      symbol: '${m['symbol'] ?? ''}',
      decimals: (m['decimals'] as num?)?.toInt() ?? 0,
      address: m['address'] as String?,
    );
  }
}
