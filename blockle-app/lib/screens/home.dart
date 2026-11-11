import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../state/app_state.dart';
import '../theme.dart';
import 'wallet_tab.dart';
import 'accounts_screen.dart';
import 'bots_screen.dart';
import 'browser_tab.dart';
import 'settings.dart';
import 'wallet/wallet_screen.dart';
import 'liquidity_screen.dart';
import 'blockshot_screen.dart';

/// A single navigation destination (icon + label), the one source of truth for
/// both the collapsible side menu and the minimal bottom bar.
class _Dest {
  const _Dest(this.icon, this.selectedIcon, this.label);
  final IconData icon;
  final IconData selectedIcon;
  final String label;
}

/// Soft accent tint used to mark the active destination (≈15% accent).
const Color _activeTint = Color(0x267C5CFF);

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  // IMPORTANT: order must stay in lock-step with AppState's indices
  // (e.g. browserTabIndex == 3) so deep-links still land on the right page.
  static const _pages = [
    WalletTab(), // 0
    AccountsScreen(), // 1
    BotsScreen(), // 2
    BrowserTab(), // 3
    SettingsScreen(), // 4
    WalletScreen(), // 5  (Portfolio)
    LiquidityScreen(), // 6  (Blockle Liquidity)
    BlockshotScreen(), // 7  (Blockshot — launch + trade BLOCK-20s)
  ];

  static const _dests = <_Dest>[
    _Dest(Icons.account_balance_wallet_outlined, Icons.account_balance_wallet,
        'Wallet'),
    _Dest(Icons.layers_outlined, Icons.layers, 'Accounts'),
    _Dest(Icons.auto_graph_outlined, Icons.auto_graph, 'Bots'),
    _Dest(Icons.public_outlined, Icons.public, 'Browser'),
    _Dest(Icons.settings_outlined, Icons.settings, 'Settings'),
    _Dest(Icons.diamond_outlined, Icons.diamond, 'Portfolio'),
    _Dest(Icons.water_drop_outlined, Icons.water_drop, 'Liquidity'),
    _Dest(Icons.rocket_launch_outlined, Icons.rocket_launch, 'Blockshot'),
  ];

  /// The few destinations that get an icon-only button on the bottom bar; the
  /// full set always lives in the side menu.
  static const _bottomPrimary = <int>[0, 1, 2, 3]; // Wallet, Accounts, Bots, Browser

  @override
  Widget build(BuildContext context) {
    final i = context.watch<AppState>().tabIndex;
    return Scaffold(
      drawer: _SideMenu(current: i),
      body: IndexedStack(index: i, children: _pages),
      bottomNavigationBar: _MinimalBottomBar(current: i),
    );
  }
}

/// The collapsible side menu: the complete destination list, the active one
/// highlighted. Opens from the bottom bar's menu button or an edge swipe, and
/// collapses away when a destination is picked or the header chevron is tapped.
class _SideMenu extends StatelessWidget {
  const _SideMenu({required this.current});
  final int current;

  @override
  Widget build(BuildContext context) {
    return Drawer(
      backgroundColor: Bk.bg2,
      width: 288,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.horizontal(right: Radius.circular(22)),
      ),
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 18, 10, 14),
              child: Row(
                children: [
                  Container(
                    width: 40,
                    height: 40,
                    decoration: BoxDecoration(
                      gradient: Bk.gradient,
                      borderRadius: BorderRadius.circular(11),
                    ),
                    alignment: Alignment.center,
                    child: const Text('B',
                        style: TextStyle(
                            fontWeight: FontWeight.w900,
                            fontSize: 22,
                            color: Colors.white)),
                  ),
                  const SizedBox(width: 12),
                  const Expanded(
                    child: Text('Blockle Wallet',
                        style: TextStyle(
                            fontWeight: FontWeight.w800, fontSize: 16)),
                  ),
                  IconButton(
                    icon: const Icon(Icons.chevron_left, color: Bk.muted),
                    tooltip: 'Collapse menu',
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                ],
              ),
            ),
            const Divider(height: 1, color: Bk.border),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.symmetric(vertical: 8),
                children: [
                  for (int idx = 0; idx < HomeScreen._dests.length; idx++)
                    _DrawerItem(
                      dest: HomeScreen._dests[idx],
                      active: idx == current,
                      onTap: () {
                        context.read<AppState>().setTab(idx);
                        Navigator.of(context).pop();
                      },
                    ),
                ],
              ),
            ),
            const Divider(height: 1, color: Bk.border),
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 14, 20, 12),
              child: Text('Blockle · non-custodial',
                  style: TextStyle(color: Bk.muted, fontSize: 12)),
            ),
          ],
        ),
      ),
    );
  }
}

class _DrawerItem extends StatelessWidget {
  const _DrawerItem(
      {required this.dest, required this.active, required this.onTap});
  final _Dest dest;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 2),
      child: Material(
        color: active ? _activeTint : Colors.transparent,
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            child: Row(
              children: [
                Icon(active ? dest.selectedIcon : dest.icon,
                    size: 22, color: active ? Bk.accent : Bk.muted),
                const SizedBox(width: 16),
                Text(
                  dest.label,
                  style: TextStyle(
                    color: active ? Bk.text : Bk.muted,
                    fontWeight: active ? FontWeight.w700 : FontWeight.w500,
                    fontSize: 15,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// A minimal, label-free bottom bar: the primary destinations as icons plus a
/// menu button that opens the collapsible side menu for everything else.
class _MinimalBottomBar extends StatelessWidget {
  const _MinimalBottomBar({required this.current});
  final int current;

  @override
  Widget build(BuildContext context) {
    final onPrimary = HomeScreen._bottomPrimary.contains(current);
    return Container(
      decoration: const BoxDecoration(
        color: Bk.bg2,
        border: Border(top: BorderSide(color: Bk.border, width: 1)),
      ),
      child: SafeArea(
        top: false,
        child: SizedBox(
          height: 58,
          child: Row(
            children: [
              for (final idx in HomeScreen._bottomPrimary)
                _BarIcon(
                  icon: current == idx
                      ? HomeScreen._dests[idx].selectedIcon
                      : HomeScreen._dests[idx].icon,
                  active: current == idx,
                  tooltip: HomeScreen._dests[idx].label,
                  onTap: () => context.read<AppState>().setTab(idx),
                ),
              _BarIcon(
                icon: Icons.menu,
                // Light the menu up when the active page lives in the drawer.
                active: !onPrimary,
                tooltip: 'Menu',
                onTap: () => Scaffold.of(context).openDrawer(),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _BarIcon extends StatelessWidget {
  const _BarIcon(
      {required this.icon,
      required this.active,
      required this.tooltip,
      required this.onTap});
  final IconData icon;
  final bool active;
  final String tooltip;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: InkResponse(
        onTap: onTap,
        radius: 32,
        child: Center(
          child: Tooltip(
            message: tooltip,
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 160),
              padding: const EdgeInsets.all(9),
              decoration: BoxDecoration(
                color: active ? _activeTint : Colors.transparent,
                borderRadius: BorderRadius.circular(13),
              ),
              child: Icon(icon,
                  size: 24, color: active ? Bk.accent : Bk.muted),
            ),
          ),
        ),
      ),
    );
  }
}
