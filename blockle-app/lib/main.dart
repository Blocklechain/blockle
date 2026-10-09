import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'state/app_state.dart';
import 'state/multichain_controller.dart';
import 'theme.dart';
import 'screens/onboarding.dart';
import 'screens/home.dart';
import 'widgets/particle_logo.dart';

/// App-wide navigator key — lets the AgentService render its REQUIRED confirm
/// modal from outside the widget tree (it runs in a background service).
final GlobalKey<NavigatorState> appNavigatorKey = GlobalKey<NavigatorState>();

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final app = AppState()..bootstrap();
  runApp(
    MultiProvider(
      providers: [
        ChangeNotifierProvider<AppState>.value(value: app),
        ChangeNotifierProvider<MultichainController>(
          create: (_) => MultichainController(app, appNavigatorKey)..init(),
        ),
      ],
      child: const BlockleApp(),
    ),
  );
}

class BlockleApp extends StatelessWidget {
  const BlockleApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Blockle Wallet',
      debugShowCheckedModeBanner: false,
      navigatorKey: appNavigatorKey,
      theme: Bk.theme(),
      home: const _Gate(),
    );
  }
}

/// Routes between splash / onboarding / unlock / home based on wallet state.
class _Gate extends StatelessWidget {
  const _Gate();

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    if (app.booting) return const _Splash();
    if (app.bootError != null) return _BootError(message: app.bootError!);
    if (!app.hasWallet) return const OnboardingScreen();
    if (!app.unlocked) return const UnlockScreen();
    return const HomeScreen();
  }
}

class _Splash extends StatelessWidget {
  const _Splash();
  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            ParticleLogo(size: 180),
            SizedBox(height: 24),
            Text('Blockle Wallet',
                style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700)),
            SizedBox(height: 8),
            Text('starting the post-quantum engine…',
                style: TextStyle(color: Bk.muted)),
          ],
        ),
      ),
    );
  }
}

class _BootError extends StatelessWidget {
  const _BootError({required this.message});
  final String message;
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Icon(Icons.error_outline, color: Bk.bad, size: 48),
              const SizedBox(height: 16),
              const Text('The wallet engine failed to start',
                  style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
              const SizedBox(height: 8),
              Text(message,
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: Bk.muted)),
              const SizedBox(height: 20),
              FilledButton(
                onPressed: () => context.read<AppState>().bootstrap(),
                child: const Text('Retry'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
