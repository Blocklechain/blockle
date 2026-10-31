import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../state/app_state.dart';
import '../theme.dart';
import 'wallet_tab.dart';
import 'accounts_screen.dart';
import 'exchange_screen.dart';
import 'trade_screen.dart';
import 'agent_screen.dart';
import 'bots_screen.dart';
import 'chat_screen.dart';
import 'browser_tab.dart';
import 'settings.dart';
import 'wallet/wallet_screen.dart';

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  static const _pages = [
    WalletTab(),
    AccountsScreen(),
    ExchangeScreen(),
    TradeScreen(),
    AgentScreen(),
    BotsScreen(),
    BrowserTab(),
    SettingsScreen(),
    WalletScreen(),
    ChatScreen(),
  ];

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
                icon: Icon(Icons.layers_outlined, color: Bk.muted),
                selectedIcon: Icon(Icons.layers, color: Bk.accent),
                label: 'Accounts'),
            NavigationDestination(
                icon: Icon(Icons.candlestick_chart_outlined, color: Bk.muted),
                selectedIcon: Icon(Icons.candlestick_chart, color: Bk.accent),
                label: 'Exchange'),
            NavigationDestination(
                icon: Icon(Icons.swap_horiz_outlined, color: Bk.muted),
                selectedIcon: Icon(Icons.swap_horiz, color: Bk.accent),
                label: 'Trade'),
            NavigationDestination(
                icon: Icon(Icons.smart_toy_outlined, color: Bk.muted),
                selectedIcon: Icon(Icons.smart_toy, color: Bk.accent),
                label: 'Agent'),
            NavigationDestination(
                icon: Icon(Icons.auto_graph_outlined, color: Bk.muted),
                selectedIcon: Icon(Icons.auto_graph, color: Bk.accent),
                label: 'Bots'),
            NavigationDestination(
                icon: Icon(Icons.public_outlined, color: Bk.muted),
                selectedIcon: Icon(Icons.public, color: Bk.accent),
                label: 'Browser'),
            NavigationDestination(
                icon: Icon(Icons.settings_outlined, color: Bk.muted),
                selectedIcon: Icon(Icons.settings, color: Bk.accent),
                label: 'Settings'),
            NavigationDestination(
                icon: Icon(Icons.diamond_outlined, color: Bk.muted),
                selectedIcon: Icon(Icons.diamond, color: Bk.accent),
                label: 'Portfolio'),
            NavigationDestination(
                icon: Icon(Icons.chat_bubble_outline, color: Bk.muted),
                selectedIcon: Icon(Icons.chat_bubble, color: Bk.accent),
                label: 'AI Chat'),
          ],
        ),
      ),
    );
  }
}
