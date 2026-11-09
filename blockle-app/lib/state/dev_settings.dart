// state/dev_settings.dart — the Developer-mode gate for the wallet.
//
// Developer mode is OFF by default. When on, it unlocks the Developer Tools
// screen (RPC console, price probe, address inspector, per-chain testnet switch,
// liquidity inspector, feature flags, diagnostics). Everything gated here is a
// DEVELOPER affordance — none of it bypasses the money gates (mainnet flag,
// approvals, allocation caps). Persisted so the choice survives restarts.

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class DevSettings extends ChangeNotifier {
  DevSettings._();
  static final DevSettings instance = DevSettings._();

  static const _kDevMode = 'blockle_dev_mode';
  static const _kFlags = 'blockle_dev_flags';
  final _store = const FlutterSecureStorage();

  bool _devMode = false;
  bool get devMode => _devMode;

  /// Experimental feature flags (name → on). Only meaningful while devMode is on.
  final Map<String, bool> _flags = {};
  bool flag(String name) => _devMode && (_flags[name] ?? false);
  Map<String, bool> get flags => Map.unmodifiable(_flags);

  bool _ready = false;
  bool get ready => _ready;

  Future<void> init() async {
    if (_ready) return;
    try {
      _devMode = (await _store.read(key: _kDevMode)) == '1';
      final raw = await _store.read(key: _kFlags);
      if (raw != null && raw.isNotEmpty) {
        for (final kv in raw.split(',')) {
          final i = kv.indexOf('=');
          if (i > 0) _flags[kv.substring(0, i)] = kv.substring(i + 1) == '1';
        }
      }
    } catch (_) {/* default off */}
    _ready = true;
    notifyListeners();
  }

  Future<void> setDevMode(bool on) async {
    if (_devMode == on) return;
    _devMode = on;
    notifyListeners();
    try {
      await _store.write(key: _kDevMode, value: on ? '1' : '0');
    } catch (_) {}
  }

  Future<void> setFlag(String name, bool on) async {
    _flags[name] = on;
    notifyListeners();
    try {
      await _store.write(
          key: _kFlags, value: _flags.entries.map((e) => '${e.key}=${e.value ? '1' : '0'}').join(','));
    } catch (_) {}
  }
}

/// The experimental feature flags the Developer screen exposes. Add here to grow
/// the dev surface; each is OFF unless toggled (and devMode is on).
const List<({String key, String label, String desc})> kDevFlags = [
  (key: 'verboseLogs', label: 'Verbose logging', desc: 'Extra console output for bot ticks + RPC.'),
  (key: 'showRawJson', label: 'Raw JSON everywhere', desc: 'Expose raw payloads in detail views.'),
  (key: 'unlockAllStrategies', label: 'Unlock all strategies', desc: 'Show experimental/unlisted bot strategies.'),
  (key: 'fakeFees', label: 'Simulate bot fees', desc: 'Seed the liquidity treasury with sample fees for testing.'),
];
