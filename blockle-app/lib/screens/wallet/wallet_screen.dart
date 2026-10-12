// wallet_screen.dart — the native multi-chain WALLET surface for the Flutter app.
// Hosts the five surfaces from the shared visual contract (docs/design/wallet):
// PORTFOLIO, ACTIVITY, NFTS, CONNECT, ADDRESS BOOK — under a sticky top bar with
// a light/dark toggle. Theme-aware via the SHARED BotTokens token set (ported 1:1
// from the reference CSS :root) so all three wallets + the bots UI look like ONE
// product. Everything is driven by [WalletController], a thin adapter over the
// real engines (portfolio / activity / nft / walletconnect / addressbook /
// security) — no mock data, no new money path.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../state/wallet_controller.dart';
import '../accounts_screen.dart' show MultiSendScreen;
import '../bots/bots_tokens.dart';
import 'activity_view.dart';
import 'addressbook_view.dart';
import 'connect_view.dart';
import 'nfts_view.dart';
import 'portfolio_view.dart';

class WalletScreen extends StatefulWidget {
  const WalletScreen({super.key});
  @override
  State<WalletScreen> createState() => _WalletScreenState();
}

class _WalletScreenState extends State<WalletScreen> {
  int _tab = 0; // 0 portfolio · 1 activity · 2 nfts · 3 connect · 4 book
  Brightness? _themeOverride;
  bool _didInit = false;

  static const _labels = ['Portfolio', 'Activity', 'NFTs', 'Connect', 'Address book'];

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_didInit) {
      _didInit = true;
      final c = context.read<WalletController>();
      if (!c.ready) c.init();
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<WalletController>();
    final brightness = _themeOverride ?? Theme.of(context).brightness;
    final t = BotTokens.of(brightness);
    return BotTheme(
      tokens: t,
      child: Container(
        color: t.ground,
        child: SafeArea(
          bottom: false,
          child: Column(children: [
            _topBar(t),
            _tabs(t),
            Expanded(child: c.ready ? _body(c) : Center(child: CircularProgressIndicator(color: t.accent))),
          ]),
        ),
      ),
    );
  }

  Widget _body(WalletController c) {
    switch (_tab) {
      case 1:
        return const ActivityView();
      case 2:
        return const NftsView();
      case 3:
        return const ConnectView();
      case 4:
        return AddressBookView(onSend: (chain, address) => _openSend(chain: chain, prefillTo: address));
      case 0:
      default:
        return PortfolioView(onSend: () => _openSend());
    }
  }

  Widget _topBar(BotTokens t) {
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
      decoration: BoxDecoration(
        color: t.ground,
        border: Border(bottom: BorderSide(color: t.lineSoft)),
      ),
      child: Row(children: [
        Container(
          width: 30,
          height: 30,
          decoration: BoxDecoration(
            gradient: const LinearGradient(colors: [Color(0xFF4C8DFF), Color(0xFF6AA6FF)]),
            borderRadius: BorderRadius.circular(9),
          ),
          child: const Icon(Icons.diamond_outlined, size: 16, color: Colors.white),
        ),
        const SizedBox(width: 11),
        Expanded(
          child: Row(children: [
            Text('Blockle',
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: t.ink)),
            const SizedBox(width: 6),
            Text('WALLET',
                style: TextStyle(
                    fontSize: 11, letterSpacing: 1.2, fontWeight: FontWeight.w600, color: t.inkFaint)),
          ]),
        ),
        Tooltip(
          message: 'Toggle light / dark',
          child: InkWell(
            onTap: () => setState(() {
              _themeOverride =
                  (_themeOverride ?? Theme.of(context).brightness) == Brightness.dark
                      ? Brightness.light
                      : Brightness.dark;
            }),
            borderRadius: BorderRadius.circular(10),
            child: Container(
              width: 38,
              height: 38,
              decoration: BoxDecoration(
                color: t.surface,
                border: Border.all(color: t.line),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Icon(t.isDark ? Icons.light_mode_outlined : Icons.dark_mode_outlined,
                  size: 18, color: t.inkMuted),
            ),
          ),
        ),
      ]),
    );
  }

  Widget _tabs(BotTokens t) {
    return Container(
      decoration: BoxDecoration(border: Border(bottom: BorderSide(color: t.lineSoft))),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 10),
        child: Row(children: [
          for (var i = 0; i < _labels.length; i++)
            InkWell(
              onTap: () => setState(() => _tab = i),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                decoration: BoxDecoration(
                  border: Border(
                    bottom: BorderSide(
                        color: i == _tab ? t.accent : Colors.transparent, width: 2),
                  ),
                ),
                child: Text(_labels[i],
                    style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                        color: i == _tab ? t.ink : t.inkMuted)),
              ),
            ),
        ]),
      ),
    );
  }

  // ---- Send: pick a chain (when none given) then open the real send flow -----
  Future<void> _openSend({String? chain, String? prefillTo}) async {
    final c = context.read<WalletController>();
    var target = chain;
    if (target == null) {
      final accounts = await c.accountsList();
      if (!mounted) return;
      if (accounts.isEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Unlock the multi-chain vault to send.')));
        return;
      }
      target = await _pickChain(accounts.map((a) => '${a['chain']}').toList());
      if (target == null) return;
    }
    if (!mounted) return;
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => MultiSendScreen(chain: target!, prefillTo: prefillTo),
    ));
  }

  Future<String?> _pickChain(List<String> chains) {
    final t = BotTheme.of(context);
    final c = context.read<WalletController>();
    return showModalBottomSheet<String>(
      context: context,
      backgroundColor: Colors.transparent,
      builder: (ctx) => BotTheme(
        tokens: t,
        child: Container(
          decoration: BoxDecoration(
            color: t.surface,
            border: Border.all(color: t.line),
            borderRadius: const BorderRadius.vertical(top: Radius.circular(18)),
          ),
          child: SafeArea(
            top: false,
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 18, 20, 8),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Text('Send from which chain?',
                      style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: t.ink)),
                ),
              ),
              for (final chain in chains)
                ListTile(
                  title: Text(c.chainLabel(chain), style: TextStyle(color: t.ink)),
                  trailing: Icon(Icons.chevron_right, color: t.inkFaint),
                  onTap: () => Navigator.of(ctx).pop(chain),
                ),
              const SizedBox(height: 10),
            ]),
          ),
        ),
      ),
    );
  }
}
