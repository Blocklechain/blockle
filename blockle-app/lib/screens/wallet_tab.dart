import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:provider/provider.dart';

import '../multichain/chains/chain_adapter.dart' show Balance;
import '../services/chain.dart';
import '../services/token_list.dart';
import '../state/app_state.dart';
import '../state/multichain_controller.dart';
import '../theme.dart';
import '../widgets/particle_logo.dart';
import '../widgets/chain_icon.dart';
import 'send.dart';
import 'receive.dart';
import 'moonpay_swap.dart';
import 'queue.dart';

class WalletTab extends StatefulWidget {
  const WalletTab({super.key});
  @override
  State<WalletTab> createState() => _WalletTabState();
}

class _WalletTabState extends State<WalletTab> {
  Map<String, dynamic>? _account;
  List<Map<String, dynamic>> _tokens = [];
  bool _loading = true;

  // The other chains shown (with live native balances) on the home page so it's
  // a true multi-currency wallet, not BLOCK-only. The full set + per-asset
  // buy/sell lives on the Accounts tab.
  static const _homeChains = [
    'ethereum',
    'base',
    'bitcoin',
    'solana',
    'polygon',
    'arbitrum',
  ];
  Map<String, Balance?> _native = {};
  bool _vaultLocked = false;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() => _loading = true);
    final app = context.read<AppState>();
    final mc = context.read<MultichainController>();
    final addr = app.store.address;
    final acct = await app.chain.account(addr);
    final toks = await _loadTokens(app.chain, addr);
    final native = await _loadNative(mc);
    if (!mounted) return;
    setState(() {
      _account = acct;
      _tokens = toks;
      _native = native;
      _vaultLocked = !mc.vaultUnlocked;
      _loading = false;
    });
  }

  /// Load each home chain's native-coin balance in parallel. A locked vault or a
  /// read error just yields null for that chain (rendered as a dash), never a
  /// crash.
  Future<Map<String, Balance?>> _loadNative(MultichainController mc) async {
    if (!mc.vaultUnlocked) return {};
    final out = <String, Balance?>{};
    await Future.wait(_homeChains.map((ch) async {
      try {
        final bals = await mc.balancesFor(ch);
        final ticker = mc.chainTicker(ch).toUpperCase();
        Balance? nat;
        for (final b in bals) {
          if (b.asset.symbol.toUpperCase() == ticker) {
            nat = b;
            break;
          }
        }
        out[ch] = nat ?? (bals.isNotEmpty ? bals.first : null);
      } catch (_) {
        out[ch] = null;
      }
    }));
    return out;
  }

  /// Tokens to list: every BLOCK-20 this address HOLDS (auto-detected through
  /// the node's holder read — parity with the web wallet, so a token bought on
  /// the DEX shows up by itself) merged with the user's imported watch-list
  /// (listed even at zero balance, e.g. right after a buy that is still
  /// pending). Imported ids are read with the holder so their balance fills in.
  Future<List<Map<String, dynamic>>> _loadTokens(Chain chain, String? holder) async {
    final imported = await listBlockTokens();
    final out = <Map<String, dynamic>>[];
    final seen = <String>{};
    if (holder != null && holder.isNotEmpty) {
      for (final h in await chain.addressTokens(holder, extraContracts: imported)) {
        final id = '${h['id']}'.toLowerCase();
        if (id.isEmpty || !seen.add(id)) continue;
        out.add({'imported': imported.any((e) => e.toLowerCase() == id), ...h});
      }
    }
    for (final id in imported) {
      if (!seen.add(id.toLowerCase())) continue;
      final info = await chain.token(id, holder: holder);
      out.add({
        'id': id,
        'imported': true,
        ...?info,
        if (info != null && info['balance'] == null) 'balance': 0,
      });
    }
    return out;
  }

  Future<void> _importToken() async {
    final ctrl = TextEditingController();
    final id = await showDialog<String>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: Bk.surface,
        title: const Text('Import token'),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          decoration: const InputDecoration(
              labelText: 'BLOCK-20 contract id (hex)',
              hintText: '64-character contract id'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.pop(context, ctrl.text.trim()),
              child: const Text('Import')),
        ],
      ),
    );
    if (id == null || id.isEmpty) return;
    // verify it's a token before saving
    try {
      final r = await http.get(Uri.parse('https://blockle.org/api/token/$id'));
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      final res = (j['result'] ?? j) as Map<String, dynamic>;
      if (res['isToken'] != true) {
        _snack('That contract is not a BLOCK-20 token.');
        return;
      }
    } catch (_) {
      _snack('Could not reach the token — check the contract id.');
      return;
    }
    await rememberBlockToken(id);
    await _refresh();
  }

  void _snack(String m) {
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final addr = app.store.address ?? '—';
    final balFmt = _account?['balanceFmt'] ?? '—';
    final txs = (_account?['txs'] as List?) ?? [];

    return SafeArea(
      child: RefreshIndicator(
        onRefresh: _refresh,
        color: Bk.accent,
        backgroundColor: Bk.surface,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(18, 10, 18, 28),
          children: [
            Row(
              children: [
                const SizedBox(width: 44, height: 44, child: ParticleLogo(size: 44)),
                const SizedBox(width: 12),
                const Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Blockle Wallet',
                          style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                      // No BLOCK/USD oracle exists — BLOCK is shown in BLOCK, never $.
                      Text('Native BLOCK network',
                          style: TextStyle(color: Bk.muted, fontSize: 12)),
                    ],
                  ),
                ),
                IconButton(
                    onPressed: () => _walletSwitcher(app),
                    icon: const Icon(Icons.swap_horiz, color: Bk.muted)),
              ],
            ),
            const SizedBox(height: 18),
            Container(
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(Bk.rXl),
                boxShadow: Bk.softShadow,
              ),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(Bk.rXl),
                child: Container(
                  decoration: const BoxDecoration(gradient: Bk.gradient),
                  child: Stack(
                    children: [
                      Positioned(right: -34, top: -34, child: _glow(130, 0x22FFFFFF)),
                      Positioned(right: 36, bottom: -60, child: _glow(150, 0x16FFFFFF)),
                      Padding(
                        padding: const EdgeInsets.all(22),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text('Total balance',
                                style: TextStyle(
                                    color: Colors.white70,
                                    fontSize: 13,
                                    fontWeight: FontWeight.w600)),
                            const SizedBox(height: 8),
                            Row(
                              crossAxisAlignment: CrossAxisAlignment.baseline,
                              textBaseline: TextBaseline.alphabetic,
                              children: [
                                Flexible(
                                  child: Text(_loading ? '…' : '$balFmt',
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: const TextStyle(
                                          fontSize: 40,
                                          fontWeight: FontWeight.w900,
                                          color: Colors.white,
                                          letterSpacing: -1)),
                                ),
                                const SizedBox(width: 8),
                                const Padding(
                                  padding: EdgeInsets.only(bottom: 6),
                                  child: Text('BLOCK',
                                      style: TextStyle(
                                          color: Colors.white70,
                                          fontWeight: FontWeight.w700)),
                                ),
                              ],
                            ),
                            const SizedBox(height: 16),
                            InkWell(
                              onTap: () {
                                Clipboard.setData(ClipboardData(text: addr));
                                _snack('Address copied');
                              },
                              borderRadius: BorderRadius.circular(30),
                              child: Container(
                                padding: const EdgeInsets.symmetric(
                                    horizontal: 12, vertical: 8),
                                decoration: BoxDecoration(
                                    color: const Color(0x26FFFFFF),
                                    borderRadius: BorderRadius.circular(30)),
                                child: Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    Text(_shortAddr(addr),
                                        style: kMono.copyWith(
                                            fontSize: 12, color: Colors.white)),
                                    const SizedBox(width: 8),
                                    const Icon(Icons.copy,
                                        size: 14, color: Colors.white70),
                                  ],
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
            const SizedBox(height: 14),
            Row(
              children: [
                _action(Icons.south_west, 'Receive', () {
                  Navigator.push(context,
                      MaterialPageRoute(builder: (_) => const ReceiveScreen()));
                }),
                const SizedBox(width: 10),
                _action(Icons.north_east, 'Send', () {
                  Navigator.push(context,
                      MaterialPageRoute(builder: (_) => const SendScreen()))
                      .then((_) => _refresh());
                }),
                const SizedBox(width: 10),
                _action(Icons.swap_horiz, 'Swap', () {
                  // Swap = MoonPay crypto<->crypto (not the BLOCK<->BLOCK-20 DEX).
                  Navigator.push(context,
                          MaterialPageRoute(builder: (_) => const MoonPaySwapScreen()))
                      .then((_) => _refresh());
                }),
              ],
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                // Buy / Sell with a card route to the Accounts tab, where each
                // supported asset has a MoonPay buy/sell flow.
                _action(Icons.add_card, 'Buy', () {
                  context.read<AppState>().setTab(1);
                }),
                const SizedBox(width: 10),
                _action(Icons.sell_outlined, 'Sell', () {
                  context.read<AppState>().setTab(1);
                }),
                const SizedBox(width: 10),
                _action(Icons.receipt_long, 'Queue', () {
                  Navigator.push(context,
                      MaterialPageRoute(builder: (_) => const QueueScreen()));
                }),
              ],
            ),
            const SizedBox(height: 22),
            Row(
              children: [
                const Text('Assets',
                    style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
                const Spacer(),
                TextButton(
                  onPressed: () => context.read<AppState>().setTab(1),
                  child: const Text('See all chains'),
                ),
              ],
            ),
            if (_vaultLocked)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 8),
                child: Text(
                    'Unlock multi-chain accounts (Accounts tab) to show your ETH, BTC, SOL and more.',
                    style: TextStyle(color: Bk.muted, fontSize: 13)),
              )
            else
              ..._homeChains.map((ch) => _nativeRow(ch)),
            const SizedBox(height: 22),
            Row(
              children: [
                const Text('Tokens',
                    style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
                const Spacer(),
                TextButton.icon(
                    onPressed: _importToken,
                    icon: const Icon(Icons.add, size: 18),
                    label: const Text('Import')),
              ],
            ),
            if (_tokens.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 8),
                child: Text(
                    'No BLOCK-20 tokens yet. Tokens you buy on the DEX appear here automatically, or import one by contract id.',
                    style: TextStyle(color: Bk.muted, fontSize: 13)),
              ),
            ..._tokens.map(_tokenRow),
            const SizedBox(height: 22),
            const Text('Activity',
                style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
            const SizedBox(height: 6),
            if (txs.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 8),
                child: Text('No transactions yet.',
                    style: TextStyle(color: Bk.muted, fontSize: 13)),
              ),
            ...txs.take(15).map((t) => _txRow(t as Map<String, dynamic>)),
          ],
        ),
      ),
    );
  }

  Widget _action(IconData ic, String label, VoidCallback onTap) {
    return Expanded(
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 14),
          decoration: BoxDecoration(
            color: Bk.surface,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: Bk.border),
          ),
          child: Column(
            children: [
              Icon(ic, color: Bk.accent, size: 22),
              const SizedBox(height: 6),
              Text(label, style: const TextStyle(fontSize: 12)),
            ],
          ),
        ),
      ),
    );
  }

  Widget _glow(double size, int color) => Container(
        width: size,
        height: size,
        decoration: BoxDecoration(shape: BoxShape.circle, color: Color(color)),
      );

  String _shortAddr(String a) =>
      a.length <= 20 ? a : '${a.substring(0, 12)}…${a.substring(a.length - 6)}';

  Widget _nativeRow(String chain) {
    final mc = context.read<MultichainController>();
    final ticker = mc.chainTicker(chain);
    final label = mc.chainLabel(chain);
    final bal = _native[chain];
    final loading = _loading && !_native.containsKey(chain);
    final display = bal == null
        ? (loading ? '…' : '—')
        : (bal.error != null ? '—' : bal.display);
    return InkWell(
      onTap: () => context.read<AppState>().setTab(1),
      borderRadius: BorderRadius.circular(12),
      child: Container(
        margin: const EdgeInsets.only(top: 8),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: Bk.surface,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: Bk.border),
        ),
        child: Row(
          children: [
            ChainIcon(chain, symbol: ticker, radius: 16),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(ticker, style: const TextStyle(fontWeight: FontWeight.w700)),
                  Text(label, style: const TextStyle(color: Bk.muted, fontSize: 12)),
                ],
              ),
            ),
            Text(display, style: kMono),
          ],
        ),
      ),
    );
  }

  Widget _tokenRow(Map<String, dynamic> t) {
    final sym = (t['symbol'] ?? '?').toString();
    final name = (t['name'] ?? 'Unknown token').toString();
    final dec = (t['decimals'] as num?)?.toInt() ?? 0;
    final balRaw = t['balance'];
    String bal = '—';
    if (balRaw is num) {
      bal = dec > 0 ? (balRaw / _pow10(dec)).toStringAsFixed(dec > 6 ? 6 : dec) : balRaw.toString();
    }
    return Container(
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Bk.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Bk.border),
      ),
      child: Row(
        children: [
          AssetIcon(
            chainId: (t['chain'] ?? 'block').toString(),
            symbol: sym,
            isToken: true,
            logoUri:
                (t['logoURI'] ?? t['logo'] ?? t['image'])?.toString(),
            address: (t['contract'] ?? t['address'] ?? t['id'])?.toString(),
            radius: 16,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(sym, style: const TextStyle(fontWeight: FontWeight.w700)),
                Text(name, style: const TextStyle(color: Bk.muted, fontSize: 12)),
              ],
            ),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(bal, style: kMono),
              const SizedBox(height: 6),
              SizedBox(
                height: 28,
                child: TextButton(
                  style: TextButton.styleFrom(
                    padding: const EdgeInsets.symmetric(horizontal: 10),
                    minimumSize: Size.zero,
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                  onPressed: () {
                    final cid = (t['contract'] ?? t['address'] ?? t['id'] ?? '').toString();
                    if (cid.isEmpty) return;
                    Navigator.push(
                      context,
                      MaterialPageRoute(
                        builder: (_) => SendScreen(token: {'contract': cid, 'decimals': dec, 'symbol': sym}),
                      ),
                    );
                  },
                  child: const Text('Send', style: TextStyle(fontSize: 12)),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _txRow(Map<String, dynamic> t) {
    final txid = (t['txid'] ?? '').toString();
    final net = (t['net'] as num?);
    final inc = net != null ? net > 0 : (t['incoming'] == true || t['direction'] == 'in');
    final val = net != null ? historyAmountLabel(t) : (t['valueFmt'] ?? t['value'] ?? '').toString();
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: Row(
        children: [
          Icon(inc ? Icons.south_west : Icons.north_east,
              size: 16, color: inc ? Bk.good : Bk.muted),
          const SizedBox(width: 10),
          Expanded(
            child: Text(txid.isNotEmpty ? '${txid.substring(0, txid.length.clamp(0, 18))}…' : 'transaction',
                style: kMono.copyWith(fontSize: 12, color: Bk.muted)),
          ),
          Text(val, style: const TextStyle(fontSize: 13)),
        ],
      ),
    );
  }

  double _pow10(int n) {
    var r = 1.0;
    for (var i = 0; i < n; i++) {
      r *= 10;
    }
    return r;
  }

  Future<void> _walletSwitcher(AppState app) async {
    final wallets = await app.store.list();
    if (!mounted) return;
    showModalBottomSheet(
      context: context,
      backgroundColor: Bk.surface,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (_) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Padding(
              padding: EdgeInsets.all(16),
              child: Text('Your wallets', style: TextStyle(fontWeight: FontWeight.w700)),
            ),
            ...wallets.map((w) => ListTile(
                  leading: Icon(w.active ? Icons.radio_button_checked : Icons.radio_button_off,
                      color: w.active ? Bk.accent : Bk.muted),
                  title: Text(w.label),
                  subtitle: Text(w.address,
                      maxLines: 1, overflow: TextOverflow.ellipsis, style: kMono.copyWith(fontSize: 11)),
                  trailing: w.watchOnly ? const Text('watch', style: TextStyle(color: Bk.muted, fontSize: 11)) : null,
                  onTap: () async {
                    final nav = Navigator.of(context);
                    await app.store.select(w.id);
                    app.refresh();
                    nav.pop();
                    _refresh();
                  },
                )),
            const SizedBox(height: 10),
          ],
        ),
      ),
    );
  }
}
