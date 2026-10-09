import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../services/chain.dart';
import '../services/engine.dart';
import '../services/wallet_store.dart';

/// A pending dApp request the UI must approve. The approval sheet fills in a
/// payload (e.g. a signature) when it approves.
class ApprovalRequest {
  final String type; // connect | sign | deploy
  final String origin;
  final String? message; // sign
  final String? code; // deploy
  final String? gas; // deploy
  ApprovalRequest(this.type, this.origin, {this.message, this.code, this.gas});
}

class ApprovalResult {
  final bool approved;
  final dynamic payload;
  ApprovalResult(this.approved, [this.payload]);
}

typedef ApprovalHandler = Future<ApprovalResult> Function(ApprovalRequest req);
typedef EventEmitter = void Function(String origin, String event, dynamic data);

/// Central application state: wallet, chain, connected sites, and the dApp
/// provider RPC handler. Mirrors the extension's background.js semantics.
class AppState extends ChangeNotifier {
  AppState() {
    engine = Engine.instance;
    store = WalletStore(engine);
    chain = Chain();
  }

  late final Engine engine;
  late final WalletStore store;
  late final Chain chain;

  static const _kSites = 'bk_sites';
  static const _kPending = 'bk_pending';
  final _storage = const FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  bool booting = true;
  String? bootError;
  bool hasWallet = false;
  bool get unlocked => store.isUnlocked;
  Map<String, dynamic> _sites = {};

  // ---- transaction queue (BLOCK blocks are ~10 min) ----
  List<Map<String, dynamic>> _pending = [];
  List<Map<String, dynamic>> get pending => _pending;

  Future<void> addPending(String? txid, String kind) async {
    if (txid == null || txid.isEmpty) return;
    if (_pending.any((e) => e['txid'] == txid)) return;
    _pending.insert(0, {'txid': txid, 'kind': kind, 'time': DateTime.now().millisecondsSinceEpoch});
    if (_pending.length > 30) _pending = _pending.sublist(0, 30);
    await _storage.write(key: _kPending, value: jsonEncode(_pending));
    notifyListeners();
  }

  // ---- navigation (bottom tabs + browser deep-link) ----
  int tabIndex = 0;
  String? pendingBrowserUrl;
  void setTab(int i) {
    tabIndex = i;
    notifyListeners();
  }

  /// Index of the in-app Browser tab in HomeScreen's NavigationBar.
  static const browserTabIndex = 4;

  /// Switch to the in-app browser and load [url].
  void openBrowser(String url) {
    pendingBrowserUrl = url;
    tabIndex = browserTabIndex;
    notifyListeners();
  }

  void consumedBrowserUrl() => pendingBrowserUrl = null;

  Future<void> syncWalletFlag() async {
    hasWallet = await store.exists();
    notifyListeners();
  }

  /// Set by the browser screen (shows approval sheets).
  ApprovalHandler? onApproval;

  /// Set by the browser screen (pushes events into the current page).
  EventEmitter? emitEvent;

  Future<void> bootstrap() async {
    try {
      await engine.ensureStarted();
      await store.loadPublic();
      hasWallet = await store.exists();
      final raw = await _storage.read(key: _kSites);
      if (raw != null && raw.isNotEmpty) {
        _sites = jsonDecode(raw) as Map<String, dynamic>;
      }
      final praw = await _storage.read(key: _kPending);
      if (praw != null && praw.isNotEmpty) {
        _pending = (jsonDecode(praw) as List).cast<Map<String, dynamic>>();
      }
    } catch (e) {
      bootError = e.toString();
    } finally {
      booting = false;
      notifyListeners();
    }
  }

  void refresh() => notifyListeners();

  // ---- connected sites ----
  bool isConnected(String origin) => _sites.containsKey(origin);
  List<String> get connectedOrigins => _sites.keys.toList();

  Future<void> _saveSites() async =>
      _storage.write(key: _kSites, value: jsonEncode(_sites));

  Future<void> revokeSite(String origin) async {
    _sites.remove(origin);
    await _saveSites();
    emitEvent?.call(origin, 'disconnect', {});
    emitEvent?.call(origin, 'accountsChanged', []);
    notifyListeners();
  }

  // ---- dApp provider RPC (called by the browser's JS handler) ----
  Map<String, dynamic> _err(int code, String message) =>
      {'error': {'code': code, 'message': message}};

  Future<Map<String, dynamic>> handleRpc(
      String method, List params, String origin) async {
    final address = store.address;
    switch (method) {
      case 'blockle_chainInfo':
        return {'result': {'chainId': 'blockle-main', 'ticker': 'BLOCK', 'name': 'Blockle'}};

      case 'blockle_getHeight':
        final s = await chain.stats();
        return {'result': s?['height']};

      case 'blockle_accounts':
        return {'result': isConnected(origin) && address != null ? [address] : []};

      case 'blockle_connect':
        {
          if (address == null) return _err(4100, 'No wallet is set up in Blockle Wallet');
          if (isConnected(origin)) return {'result': [address]};
          final dec = await (onApproval?.call(ApprovalRequest('connect', origin)) ??
              Future.value(ApprovalResult(false)));
          if (!dec.approved) return _err(4001, 'User rejected the connection request');
          _sites[origin] = {'connectedAt': DateTime.now().millisecondsSinceEpoch, 'address': address};
          await _saveSites();
          notifyListeners();
          emitEvent?.call(origin, 'connect', {'address': address});
          emitEvent?.call(origin, 'accountsChanged', [address]);
          return {'result': [address]};
        }

      case 'blockle_disconnect':
        await revokeSite(origin);
        return {'result': true};

      case 'blockle_getBalance':
        {
          if (!isConnected(origin)) return _err(4100, 'Not connected — call connect() first');
          final a = await chain.account(address);
          return {'result': a != null
              ? {'address': address, 'balance': a['balance'], 'balanceFmt': a['balanceFmt'], 'ticker': 'BLOCK'}
              : {'address': address, 'balance': null}};
        }

      case 'blockle_signMessage':
        {
          if (!isConnected(origin)) return _err(4100, 'Not connected — call connect() first');
          final message = params.isNotEmpty && params[0] != null ? '${params[0]}' : '';
          final dec = await (onApproval?.call(ApprovalRequest('sign', origin, message: message)) ??
              Future.value(ApprovalResult(false)));
          if (!dec.approved) return _err(4001, 'User rejected the signature request');
          return {'result': dec.payload};
        }

      case 'blockle_deployContract':
        {
          if (!isConnected(origin)) return _err(4100, 'Not connected — call connect() first');
          final code = params.isNotEmpty && params[0] != null ? '${params[0]}' : '';
          final gas = '${params.length > 1 && params[1] != null ? params[1] : 200000}';
          if (code.isEmpty || !RegExp(r'^[0-9a-fA-F]+$').hasMatch(code)) {
            return _err(4200, 'invalid contract bytecode');
          }
          final dec = await (onApproval
                  ?.call(ApprovalRequest('deploy', origin, code: code, gas: gas)) ??
              Future.value(ApprovalResult(false)));
          if (!dec.approved) return _err(4001, 'User rejected the deployment');
          return {'result': dec.payload};
        }

      default:
        return _err(4200, 'Unsupported method: $method');
    }
  }
}
