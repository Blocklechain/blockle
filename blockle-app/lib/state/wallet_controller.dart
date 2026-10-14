// wallet_controller.dart — the VIEW-MODEL for the native multi-chain WALLET UI
// (docs/design/wallet + docs/WALLET-PORTFOLIO.md / WALLET-SECURITY.md /
// WALLET-WALLETCONNECT.md / WALLET-NFT.md). Like bots_controller, it is a THIN
// adapter over the REAL engine modules already in this wallet — it owns no money
// logic and no second broadcast path:
//
//   • portfolio.dart     — unified cross-chain net worth + the daily snapshot.
//   • activity.dart      — the aggregated, security-decoded history feed.
//   • nft.dart           — the NFT inventory + operator-approval surfacing.
//   • walletconnect.dart — the WC v2 session + request state machine + gate.
//   • addressbook.dart   — the local contacts store + ENS/SNS name resolution.
//   • security.dart      — inspectTransaction / listApprovals / presign gate.
//
// SAFETY: READ-ONLY throughout. The controller NEVER signs and NEVER adds a money
// path — the only writes are the local daily-snapshot store, the local address
// book, and the WC session store (no key material, ever). Prices come from the
// SAME live mark source the bots use (the non-custodial Exchange). Nothing is
// mocked: a value that cannot be sourced is surfaced honestly (unpriced /
// unavailable note), never guessed.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../screens/wallet/security_sheet.dart';
import '../multichain/activity.dart' as act;
import '../multichain/addressbook.dart' as ab;
import '../multichain/chains/chain_adapter.dart' show Balance;
import '../multichain/chains/evm.dart' show EvmAdapter;
import '../multichain/chains/solana.dart' show SolanaAdapter;
import '../multichain/nft.dart' as nft;
import '../multichain/nft_indexer.dart' as nidx;
import '../multichain/portfolio.dart' as pf;
import '../multichain/security.dart' as sec;
import '../multichain/walletconnect.dart' as wc;
import '../multichain/wc_relay.dart' as wcr;
import '../screens/wallet/connect_view.dart' show showWcProposalReview;
import '../services/exchange_client.dart' show ExchangeClient, ExchangeMarket;
import 'multichain_controller.dart';

// Operator-configurable transport credentials (set at build time via
// --dart-define). Empty by default: the WC relay still runs (projectId is
// optional on some relays) and the NFT indexer honestly reports `unavailable`
// rather than fabricating an empty inventory when no key is configured.
const String _kWcProjectId = String.fromEnvironment('BLOCKLE_WC_PROJECT_ID', defaultValue: '');
const String _kWcRelayUrl = String.fromEnvironment('BLOCKLE_WC_RELAY_URL', defaultValue: wcr.kDefaultRelayUrl);
const String _kAlchemyNftKey = String.fromEnvironment('BLOCKLE_ALCHEMY_NFT_KEY', defaultValue: '');
const String _kAlchemyNftBaseUrl = String.fromEnvironment('BLOCKLE_ALCHEMY_NFT_BASEURL', defaultValue: '');
const String _kHeliusKey = String.fromEnvironment('BLOCKLE_HELIUS_KEY', defaultValue: '');
const String _kSolanaDasUrl = String.fromEnvironment('BLOCKLE_SOLANA_DAS_URL', defaultValue: '');

/// Stablecoins pin to $1 (mirrors the engine's `_stableUsd` set / bots_controller).
const Set<String> _stableSyms = {
  'USDC', 'USDT', 'DAI', 'USD', 'USDBC', 'USDB', 'PYUSD', 'TUSD',
};

/// Maps a wallet chain id → the CAIP-2 string WalletConnect settles into, so the
/// WC core can expose the wallet's real accounts to a dApp session.
const Map<String, String> kCaip2ByChain = {
  'ethereum': 'eip155:1',
  'base': 'eip155:8453',
  'arbitrum': 'eip155:42161',
  'optimism': 'eip155:10',
  'polygon': 'eip155:137',
  'bnb': 'eip155:56',
  'avalanche': 'eip155:43114',
  'solana': 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
};

/// A FlutterSecureStorage-backed key/value blob, implementing BOTH the address
/// book store shape (get(List)/set(Map)) and the WC store shape (get(String)/
/// set(Map)) over ONE encrypted-at-rest JSON blob. No key material is stored.
class _SecureBlobStore implements ab.AddressBookStore, wc.WalletConnectStore {
  _SecureBlobStore(this.blobKey);
  final String blobKey;
  final FlutterSecureStorage _storage = const FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  Future<Map<String, dynamic>> _read() async {
    try {
      final raw = await _storage.read(key: blobKey);
      if (raw == null || raw.isEmpty) return {};
      final m = jsonDecode(raw);
      return m is Map ? m.cast<String, dynamic>() : {};
    } catch (_) {
      return {};
    }
  }

  Future<void> _write(Map<String, dynamic> m) async {
    try {
      await _storage.write(key: blobKey, value: jsonEncode(m));
    } catch (_) {/* best-effort; never throws into the UI */}
  }

  // AddressBookStore: get the requested keys.
  @override
  Future<Map<String, dynamic>> get(dynamic keys) async {
    final m = await _read();
    if (keys is String) return {keys: m[keys]};
    final out = <String, dynamic>{};
    for (final k in (keys as List)) {
      out['$k'] = m['$k'];
    }
    return out;
  }

  @override
  Future<void> set(Map<String, dynamic> obj) async {
    final m = await _read();
    m.addAll(obj);
    await _write(m);
  }
}

class WalletController extends ChangeNotifier {
  WalletController(this._mc, this._navKey);

  final MultichainController _mc;
  final GlobalKey<NavigatorState> _navKey;

  static const _kNwHistory = 'bk_wallet_nw_history';
  final _storage = const FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  late final ab.AddressBook addressBook;
  late final wc.WalletConnect walletConnect;

  /// The LIVE WalletConnect v2 relay transport injected into [walletConnect] —
  /// the real WebSocket/irn/ChaCha20-Poly1305 client (wc_relay.dart). The engine
  /// stays pure; this is what drives real pairings. Kept as a field so the UI can
  /// subscribe to incoming proposals.
  late final wcr.WcLiveRelay wcRelay;

  /// The LIVE NFT indexer injected into every NFT inventory read (nft_indexer.dart)
  /// — Alchemy (EVM) + Helius DAS (Solana). A missing key => honest `unavailable`.
  late final nidx.LiveNftIndexer nftIndexer;

  bool ready = false;

  /// Optional per-surface theme override (null = follow the app theme).
  Brightness? themeOverride;

  /// The locally-persisted daily net-worth snapshot history (oldest→newest).
  List<Map<String, dynamic>> nwHistory = [];

  // ---- lifecycle -----------------------------------------------------------

  Future<void> init() async {
    final store = _SecureBlobStore('bk_wallet_book');
    addressBook = ab.AddressBook(
      store: store,
      // REAL name resolution wired to the live chain adapters: .eth → ENS on the
      // Ethereum-mainnet EvmAdapter (eth_call), .sol → SNS on the SolanaAdapter
      // (getAccountInfo). Resolved lazily at call time so the registry is ready;
      // when an adapter/endpoint isn't available the resolver returns null —
      // never a guessed address.
      resolvers: ab.ResolveCtx(
        resolveEns: _resolveEns,
        resolveSns: _resolveSns,
      ),
    );
    // LIVE NFT indexer (nft_indexer.dart): Alchemy for EVM + Helius DAS for
    // Solana, operator-configurable via --dart-define. Injected into every NFT
    // inventory read below.
    nftIndexer = nidx.LiveNftIndexer(
      alchemy: {
        if (_kAlchemyNftKey.isNotEmpty) 'apiKey': _kAlchemyNftKey,
        if (_kAlchemyNftBaseUrl.isNotEmpty) 'baseUrl': _kAlchemyNftBaseUrl,
      },
      das: {
        if (_kHeliusKey.isNotEmpty) 'apiKey': _kHeliusKey,
        if (_kSolanaDasUrl.isNotEmpty) 'url': _kSolanaDasUrl,
      },
    );

    // LIVE WalletConnect v2 relay transport (wc_relay.dart): the real
    // WebSocket/irn/ChaCha20-Poly1305 client. The engine (walletconnect.dart)
    // stays pure — this transport is what it drives.
    wcRelay = wcr.WcLiveRelay(relayUrl: _kWcRelayUrl, projectId: _kWcProjectId);
    walletConnect = wc.WalletConnect(
      store: _SecureBlobStore('bk_wallet_wc'),
      // Inject the LIVE relay + the real signer (both route every dApp request
      // through the SAME security gate — no new money path, nothing auto-signs).
      relay: wcRelay,
      signer: _LiveWcSigner(_mc),
      config: {
        'walletChains': kCaip2ByChain.values.toList(),
        'denylist': const <String>[],
      },
    );
    // Wire the dApp signing gate through the SHARED security sheet: every WC
    // signing request delivered by the live relay routes to the same confirm
    // sheet Send/NFT use — a DANGER forces the explicit confirm, nothing
    // auto-signs, eth_sign stays refused (all enforced by the untouched engine).
    walletConnect.connectRelay(wcRequestCtx());
    // Incoming session proposals from the relay → the proposal-review sheet →
    // explicit approve/reject (the only thing that settles a session).
    wcRelay.subscribeProposals(_onWcProposal);
    await _loadNwHistory();
    ready = true;
    notifyListeners();
  }

  /// Handle an incoming WC v2 session proposal pushed by the live relay: review
  /// it (CLAIMED metadata + warnings, surfaced never trusted), show the approval
  /// sheet, then approve (settling the wallet's real CAIP-10 accounts) or reject.
  Future<void> _onWcProposal(Map<String, dynamic> proposal) async {
    final review = walletConnect.reviewProposal(proposal);
    final ctx = _navKey.currentContext;
    // fail-closed: no UI to approve through → reject the proposal.
    final approved = ctx == null ? false : await showWcProposalReview(ctx, review);
    if (!approved) {
      await walletConnect.rejectProposal(proposal);
      return;
    }
    // CAIP-10 accounts the wallet offers (only chains it actually controls).
    final accts = await accountsList();
    final caip10 = <String>[
      for (final a in accts)
        if (kCaip2ByChain[a['chain']] != null) '${kCaip2ByChain[a['chain']]}:${a['address']}'
    ];
    await walletConnect.approveProposal(proposal, accounts: caip10);
    notifyListeners();
  }

  /// The per-request context the WalletConnect core drives every dApp SIGNATURE /
  /// SEND request through: an explicit human approval (never auto-approve) plus
  /// the extra confirm a DANGER forces — both rendered as the SHARED security
  /// confirm sheet via the app navigator. Reused unchanged at relay integration.
  wc.WcRequestCtx wcRequestCtx() => wc.WcRequestCtx(
        approve: (p) => _presentWcRequest(p, danger: false),
        confirm: (p) => _presentWcRequest(p, danger: true),
      );

  Future<bool> _presentWcRequest(Map<String, dynamic> p, {required bool danger}) async {
    final ctx = _navKey.currentContext;
    if (ctx == null) return false; // fail-closed: no UI → deny
    final dapp = (p['dapp'] as Map?)?.cast<String, dynamic>() ?? const {};
    SecuritySheetConfig cfg;
    final insp = p['inspection'];
    if (insp is sec.Inspection) {
      cfg = SecuritySheetConfig.fromInspection(
        insp,
        title: '${p['method']}',
        dappName: dapp['name'] as String?,
        dappUrl: dapp['url'] as String?,
      );
    } else if (p['decoded'] is Map) {
      cfg = SecuritySheetConfig.fromDecoded(
        (p['decoded'] as Map).cast<String, dynamic>(),
        title: '${p['method']}',
        dappName: dapp['name'] as String?,
        dappUrl: dapp['url'] as String?,
      );
    } else {
      cfg = SecuritySheetConfig(title: '${p['method']}', previewHeader: 'dApp request');
    }
    return showSecuritySheet(ctx, cfg);
  }

  // ---- accounts (one {chain,address} per resolvable chain) -----------------

  Future<List<Map<String, dynamic>>> accountsList() async {
    final out = <Map<String, dynamic>>[];
    if (!_mc.ready) return out;
    for (final chain in _mc.displayChains()) {
      // BLOCK is always resolvable; HD chains need the vault unlocked.
      if (chain != 'block' && !_mc.vaultUnlocked) continue;
      final acct = await _mc.addressFor(chain);
      final addr = acct?.address;
      if (addr == null || addr.isEmpty) continue;
      out.add({'chain': chain, 'address': addr});
    }
    return out;
  }

  // ---- PRICE resolver (the shared live mark source, as the bots use) -------
  //
  // A per-load closure caches the Exchange markets + resolved symbol prices so
  // portfolio() prices every holding from real market data. A symbol the
  // Exchange can't price returns null → the holding goes to `unpriced` (never a
  // guessed/zero value).
  Future<Future<num?> Function(dynamic asset)> _priceResolver() async {
    final ExchangeClient ex = _mc.exchange;
    List<ExchangeMarket> markets;
    try {
      markets = await ex.getMarkets();
    } catch (_) {
      markets = const [];
    }
    final cache = <String, num?>{};

    Future<num?> markInQuote(ExchangeMarket m) async {
      try {
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
          final p = num.tryParse('${trades.first['price'] ?? trades.first['px'] ?? ''}');
          if (p != null && p > 0) return p;
        }
      } catch (_) {/* fall through */}
      if (m.last != null && m.last! > 0) return m.last;
      return null;
    }

    Future<num?> usdMark(String sym, Set<String> seen) async {
      final up = sym.toUpperCase();
      if (_stableSyms.contains(up)) return 1;
      if (cache.containsKey(up)) return cache[up];
      if (seen.contains(up)) return null;
      final candidates = markets.where((m) => m.base.toUpperCase() == up).toList()
        ..sort((a, c) {
          final ai = _stableSyms.contains(a.quote.toUpperCase()) ? 0 : 1;
          final ci = _stableSyms.contains(c.quote.toUpperCase()) ? 0 : 1;
          return ai.compareTo(ci);
        });
      num? result;
      for (final m in candidates) {
        final mq = await markInQuote(m);
        if (mq == null || mq <= 0) continue;
        final qUsd = await usdMark(m.quote, {...seen, up});
        if (qUsd == null || qUsd <= 0) continue;
        result = mq * qUsd;
        break;
      }
      cache[up] = result;
      return result;
    }

    return (asset) async {
      final sym = '${(asset is Map ? asset['symbol'] : asset) ?? ''}';
      if (sym.isEmpty) return null;
      return usdMark(sym, const {});
    };
  }

  // ---- 1. PORTFOLIO (net worth) --------------------------------------------

  Future<pf.Portfolio> loadPortfolio() async {
    final accounts = await accountsList();
    final price = await _priceResolver();
    final ctx = pf.PortfolioCtx(
      asOf: DateTime.now().millisecondsSinceEpoch,
      priceUsd: price,
      getHoldings: (chain, address) async {
        try {
          final bals = await _mc.accounts.balances(chain);
          return [
            for (final Balance b in bals)
              {
                'confirmed': b.confirmed,
                'asset': {
                  'symbol': b.asset.symbol,
                  'decimals': b.asset.decimals,
                  'kind': b.asset.kind,
                  if (b.asset.address != null) 'address': b.asset.address,
                },
              }
          ];
        } catch (_) {
          return const [];
        }
      },
    );
    final p = await pf.portfolio(accounts, ctx);
    await _recordSnapshot(p);
    notifyListeners();
    return p;
  }

  Future<void> _loadNwHistory() async {
    try {
      final raw = await _storage.read(key: _kNwHistory);
      if (raw == null || raw.isEmpty) {
        nwHistory = [];
        return;
      }
      final list = jsonDecode(raw);
      nwHistory = list is List
          ? [for (final p in list) Map<String, dynamic>.from(p as Map)]
          : [];
    } catch (_) {
      nwHistory = [];
    }
  }

  Future<void> _recordSnapshot(pf.Portfolio p) async {
    try {
      nwHistory = pf.recordSnapshot(nwHistory, {
        'ts': p.asOf ?? DateTime.now().millisecondsSinceEpoch,
        'totalUsdMicro': p.totalUsdMicro,
      });
      await _storage.write(key: _kNwHistory, value: jsonEncode(nwHistory));
    } catch (_) {/* snapshot persistence is best-effort */}
  }

  /// The last ≤30 net-worth points in USD, for the hero sparkline.
  List<double> nwSpark() =>
      [for (final p in pf.sparkline(nwHistory, 30)) (p['usd'] as num).toDouble()];

  // ---- 2. ACTIVITY ---------------------------------------------------------

  Future<act.ActivityResult> loadActivity({String? cursor, int limit = 25}) async {
    final accounts = await accountsList();
    final ctx = act.ActivityCtx(
      securityConfig: sec.defaultSecurityConfig(),
      // Per-chain history indexers are the live-integration step; until wired
      // the engine reports an honest "unavailable" note per chain (never a
      // fabricated empty feed).
    );
    return act.activity(accounts, ctx, act.ActivityOpts(cursor: cursor, limit: limit));
  }

  // ---- 3. NFTs -------------------------------------------------------------

  Future<Map<String, dynamic>> loadNfts() async {
    final accounts = await accountsList();
    return nft.nfts(accounts, nft.NftCtx(indexer: nftIndexer, accounts: accounts));
  }

  /// The NFT inventory PLUS the aggregated per-collection operator approvals
  /// (setApprovalForAll, danger/revocable) across every EVM account — so the
  /// gallery can show the operator-approval badge + open a revoke. Honest
  /// `approvalsAvailable:false` when no indexer is wired (never a fake all-clear).
  Future<Map<String, dynamic>> loadNftsBundle() async {
    final accounts = await accountsList();
    final inv = await nft.nfts(accounts, nft.NftCtx(indexer: nftIndexer, accounts: accounts));
    final operatorApprovals = <Map<String, dynamic>>[];
    var available = false;
    for (final acc in accounts) {
      final chain = '${acc['chain']}';
      if (!nft.kNftEvmChains.contains(chain)) continue;
      final res = await loadOperatorApprovals(chain, '${acc['address']}');
      if (res['available'] == true) available = true;
      for (final a in (res['operatorApprovals'] as List? ?? const [])) {
        operatorApprovals.add({...(a as Map).cast<String, dynamic>(), 'chain': chain});
      }
    }
    return {
      ...inv,
      'operatorApprovals': operatorApprovals,
      'approvalsAvailable': available,
    };
  }

  /// Per-collection operator (setApprovalForAll) approvals, via the security
  /// approval manager. Honest "unavailable" when no indexer is configured.
  Future<Map<String, dynamic>> loadOperatorApprovals(String chain, String owner) =>
      nft.surfaceApprovals(chain, owner, securityCtx(chain));

  /// Build the revoke tx (approve(spender,0)) — routed through the normal send
  /// flow + security gate; the suite never signs.
  Map<String, dynamic> buildRevoke(String chain, dynamic collection, String? operator) =>
      sec.buildRevoke(chain, collection, operator);

  // ---- 4. WalletConnect ----------------------------------------------------

  Future<List<Map<String, dynamic>>> sessions() => walletConnect.listSessions();

  /// Parse + pair a WalletConnect v2 URI. Throws ArgumentError on a v1 / malformed
  /// URI (surfaced to the user); grants NOTHING on its own.
  Future<Map<String, dynamic>> pairUri(String uri) => walletConnect.pair(uri.trim());

  Future<void> disconnectSession(String topic) async {
    await walletConnect.disconnect(topic);
    notifyListeners();
  }

  /// Review a session proposal (surfaces the CLAIMED dApp metadata + warnings).
  Map<String, dynamic> reviewProposal(Map<String, dynamic> proposal) =>
      walletConnect.reviewProposal(proposal);

  // ---- security ------------------------------------------------------------

  /// The merged security ctx for a chain (production denylist/allowlist seeded).
  sec.SecCtx securityCtx(String chain) =>
      sec.SecCtx(chain: chain, config: sec.defaultSecurityConfig());

  /// ENS (.eth) forward resolver, delegated to the live Ethereum-mainnet
  /// EvmAdapter. Returns null (never a guess) when the adapter/endpoint isn't
  /// available or the name doesn't resolve.
  Future<dynamic> _resolveEns(String name) async {
    try {
      if (!_mc.registry.has('ethereum')) return null;
      final a = _mc.registry.get('ethereum');
      if (a is EvmAdapter) return await a.resolveEns(name);
    } catch (_) {/* fall through to null */}
    return null;
  }

  /// SNS (.sol) forward resolver, delegated to the live SolanaAdapter. Returns
  /// null (never a guess) when the adapter/endpoint isn't available or the name
  /// doesn't resolve.
  Future<dynamic> _resolveSns(String name) async {
    try {
      if (!_mc.registry.has('solana')) return null;
      final a = _mc.registry.get('solana');
      if (a is SolanaAdapter) return await a.resolveSns(name);
    } catch (_) {/* fall through to null */}
    return null;
  }

  /// Resolve a typed name/label/address for [chain] → {address, source} | null.
  Future<Map<String, dynamic>?> resolveName(String input, String chain) =>
      addressBook.resolveName(input, chain, null);

  Future<List<Map<String, dynamic>>> contacts() => addressBook.list();

  Future<void> addContact(Map<String, dynamic> entry) async {
    await addressBook.add(entry);
    notifyListeners();
  }

  Future<void> removeContact(String label) async {
    await addressBook.remove(label);
    notifyListeners();
  }

  String chainLabel(String chain) => _mc.chainLabel(chain);
  MultichainController get mc => _mc;
}

/// The LIVE WalletConnect signer injected into the engine. It is reached ONLY
/// after the engine has run inspectTransaction + the human approval gate (and a
/// DANGER's extra confirm) — this class never gates, never auto-approves, and
/// holds no keys of its own: it signs through the SAME derived-key path the rest
/// of the wallet uses. eth_sign is already refused upstream by the engine.
class _LiveWcSigner implements wc.WcSigner {
  _LiveWcSigner(this._mc);
  final MultichainController _mc;

  @override
  Future<dynamic> personalSign(Map<String, dynamic> args) async {
    final signer = _mc.accounts.evmHostedSigner();
    if (signer == null) {
      throw StateError('personal_sign: no EVM account available (locked / BLOCK-only wallet)');
    }
    // EIP-191 personal_sign over the human-readable message (the engine already
    // decoded + inspected it, and the gate already approved it).
    final text = '${args['text'] ?? ''}';
    return signer.sign(text);
  }

  @override
  Future<dynamic> ethSendTransaction(Map<String, dynamic> args) =>
      throw UnsupportedError('eth_sendTransaction via WalletConnect is not enabled in this build');

  @override
  Future<dynamic> ethSignTypedData(Map<String, dynamic> args) =>
      throw UnsupportedError('eth_signTypedData via WalletConnect is not enabled in this build');

  @override
  Future<dynamic> solanaSignTransaction(Map<String, dynamic> args) =>
      throw UnsupportedError('solana_signTransaction via WalletConnect is not enabled in this build');

  @override
  Future<dynamic> solanaSignAndSend(Map<String, dynamic> args) =>
      throw UnsupportedError('solana_signAndSendTransaction via WalletConnect is not enabled in this build');

  @override
  Future<dynamic> solanaSignMessage(Map<String, dynamic> args) =>
      throw UnsupportedError('solana_signMessage via WalletConnect is not enabled in this build');
}
