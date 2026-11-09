// Developer mode gate + per-chain testnet endpoint map.

import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/services.dart';
import 'package:blockle_app/state/dev_settings.dart';
import 'package:blockle_app/multichain/chains/registry.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  // flutter_secure_storage has no plugin in unit tests; DevSettings swallows the
  // write errors, so the in-memory gate logic is still exercised.
  setUpAll(() {
    const ch = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(ch, (c) async => null);
  });

  group('DevSettings gate', () {
    test('developer mode is OFF by default and gates feature flags', () async {
      final d = DevSettings.instance;
      // A flag is never active unless devMode is on, even if toggled.
      await d.setFlag('verboseLogs', true);
      await d.setDevMode(false);
      expect(d.devMode, isFalse);
      expect(d.flag('verboseLogs'), isFalse); // gated off when devMode off

      await d.setDevMode(true);
      expect(d.devMode, isTrue);
      expect(d.flag('verboseLogs'), isTrue); // now active
      await d.setDevMode(false); // leave it off for other tests
    });
  });

  group('testnet endpoints', () {
    test('EVM chains carry a testnet chainId; non-EVM a testnet endpoint', () {
      expect(kTestnetEndpoints['ethereum']!.chainId, 11155111); // Sepolia
      expect(kTestnetEndpoints['base']!.chainId, 84532); // Base Sepolia
      expect(kTestnetEndpoints['polygon']!.chainId, 80002); // Amoy
      expect(kTestnetEndpoints['solana']!.rpcUrl, contains('devnet'));
      expect(kTestnetEndpoints['stellar']!.horizon, contains('testnet'));
      expect(kTestnetEndpoints['tron']!.api, isNotNull);
    });

    test('every testnet chainId differs from its mainnet default', () {
      for (final c in kTestnetEndpoints.keys) {
        final t = kTestnetEndpoints[c]!;
        final m = defaultEndpoints[c];
        if (m == null) continue;
        if (t.chainId != null && m.chainId != null) {
          expect(t.chainId, isNot(m.chainId), reason: '$c testnet chainId must differ');
        }
        if (t.rpcUrl != null && m.rpcUrl != null) {
          expect(t.rpcUrl, isNot(m.rpcUrl), reason: '$c testnet rpc must differ');
        }
      }
    });
  });
}
