import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../state/app_state.dart';
import '../theme.dart';
import 'wallet_tab.dart';
import 'browser_tab.dart';
import 'settings.dart';

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  static const _pages = [WalletTab(), BrowserTab(), SettingsScreen()];

  @override
  Widget build(BuildContext context) {
    final i = context.watch<AppState>().tabIndex;
    return Scaffold(
      body: IndexedStack(index: i, children: _pages),
      bottomNavigationBar: NavigationBarTheme(
        data: const NavigationBarThemeData(
          backgroundColor: Bk.bg2,
          indicatorColor: Color(0x2E7C5CFF),
          labelTextStyle: WidgetStatePropertyAll(
            TextStyle(fontSize: 12, color: Bk.muted),
          ),
        ),
        child: NavigationBar(
          selectedIndex: i,
          onDestinationSelected: (n) => context.read<AppState>().setTab(n),
          destinations: const [
            NavigationDestination(
                icon: Icon(Icons.account_balance_wallet_outlined, color: Bk.muted),
                selectedIcon: Icon(Icons.account_balance_wallet, color: Bk.accent),
                label: 'Wallet'),
            NavigationDestination(
                icon: Icon(Icons.public_outlined, color: Bk.muted),
                selectedIcon: Icon(Icons.public, color: Bk.accent),
                label: 'Browser'),
            NavigationDestination(
                icon: Icon(Icons.settings_outlined, color: Bk.muted),
                selectedIcon: Icon(Icons.settings, color: Bk.accent),
                label: 'Settings'),
          ],
        ),
      ),
    );
  }
}
