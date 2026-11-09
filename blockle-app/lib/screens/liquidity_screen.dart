// screens/liquidity_screen.dart — Blockle Liquidity.
//
// The treasury that every trading bot funds: a 0.05% fee on each bot trade is
// auto-deposited here as the traded pair's base coin, deepening per-coin reserves
// ("hot wallets") paired against BLOCK. BLOCK starts at $0.001 with a 50,000-BLOCK
// seed. Here the user can see the pools grow and SWAP BLOCK ↔ any MoonPay coin
// against that fee-funded liquidity.

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../multichain/chains/chain_adapter.dart' show Balance;
import '../state/liquidity_controller.dart';
import '../state/multichain_controller.dart';
import '../theme.dart';

class LiquidityScreen extends StatelessWidget {
  const LiquidityScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Blockle Liquidity'),
        actions: [
          IconButton(
            tooltip: 'Refresh prices',
            icon: const Icon(Icons.refresh),
            onPressed: () => context.read<LiquidityService>().refreshPrices(),
          ),
        ],
      ),
      body: Consumer<LiquidityService>(
        builder: (context, svc, _) {
          if (!svc.ready) {
            return const Center(child: CircularProgressIndicator());
          }
          return ListView(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 40),
            children: [
              _Header(svc: svc),
              const SizedBox(height: 18),
              _SwapCard(svc: svc),
              const SizedBox(height: 22),
              Text('HOT WALLETS',
                  style: TextStyle(
                      fontSize: 12, letterSpacing: 0.8, color: Bk.muted, fontWeight: FontWeight.w700)),
              const SizedBox(height: 4),
              Text('Fee-funded reserves supplying BLOCK ↔ coin liquidity.',
                  style: TextStyle(fontSize: 12, color: Bk.faint)),
              const SizedBox(height: 10),
              _PoolList(svc: svc),
            ],
          );
        },
      ),
    );
  }
}

String _fmtUsd(double v) {
  if (v >= 1000) return '\$${v.toStringAsFixed(0)}';
  if (v >= 1) return '\$${v.toStringAsFixed(2)}';
  if (v == 0) return '\$0';
  return '\$${v.toStringAsFixed(v < 0.01 ? 6 : 4)}';
}

String _fmtAmt(double v) {
  if (v >= 1000) return v.toStringAsFixed(2);
  if (v >= 1) return v.toStringAsFixed(4);
  return v.toStringAsFixed(6);
}

/// Exact, trailing-zero-trimmed amount for inputs and deposit instructions.
String _trimAmt(double v) {
  if (v <= 0) return '0';
  var s = v.toStringAsFixed(8);
  if (s.contains('.')) s = s.replaceFirst(RegExp(r'0+$'), '').replaceFirst(RegExp(r'\.$'), '');
  return s;
}

class _Header extends StatelessWidget {
  const _Header({required this.svc});
  final LiquidityService svc;
  @override
  Widget build(BuildContext context) {
    final price = svc.blockPriceUsd;
    final treasury = svc.pool.blockTreasury;
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          colors: [Color(0xFF1B1536), Color(0xFF17172B)],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(Bk.rLg),
        border: Border.all(color: Bk.border),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Text('BLOCK', style: TextStyle(color: Bk.muted, fontSize: 13, fontWeight: FontWeight.w600)),
          const Spacer(),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(color: Bk.accentGhost, borderRadius: BorderRadius.circular(20)),
            child: Text('0.05% bot fee → liquidity',
                style: TextStyle(color: Bk.accent, fontSize: 11, fontWeight: FontWeight.w600)),
          ),
        ]),
        const SizedBox(height: 6),
        Text('\$${price.toStringAsFixed(price < 0.01 ? 6 : 4)}',
            style: const TextStyle(fontSize: 34, fontWeight: FontWeight.w800, color: Bk.text)),
        Text('BLOCK price', style: TextStyle(fontSize: 12, color: Bk.faint)),
        const SizedBox(height: 16),
        Row(children: [
          _stat('Total liquidity', _fmtUsd(svc.tvlUsd)),
          _stat('Fees collected', _fmtUsd(svc.pool.totalFeesUsd)),
        ]),
        const SizedBox(height: 10),
        Row(children: [
          _stat('Treasury BLOCK', _fmtAmt(treasury)),
          _stat('Source', svc.serverBacked ? 'Server treasury' : 'Local preview'),
        ]),
      ]),
    );
  }

  Widget _stat(String label, String value) => Expanded(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label, style: TextStyle(fontSize: 11, color: Bk.faint)),
          const SizedBox(height: 2),
          Text(value, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: Bk.text)),
        ]),
      );
}

class _SwapCard extends StatefulWidget {
  const _SwapCard({required this.svc});
  final LiquidityService svc;
  @override
  State<_SwapCard> createState() => _SwapCardState();
}

// Which wallet chain holds each swap coin (for the balance read + the payout
// receive address). Tokens settle on their host chain; null = not in-wallet.
String? _chainForCoin(String coin) {
  switch (coin.toUpperCase()) {
    case 'BLOCK':
      return 'block';
    case 'ETH':
    case 'USDC':
    case 'USDT':
    case 'DAI':
      return 'ethereum';
    case 'SOL':
      return 'solana';
    case 'BTC':
      return 'bitcoin';
    case 'LTC':
      return 'litecoin';
    case 'DOGE':
      return 'dogecoin';
    case 'BCH':
      return 'bitcoincash';
    case 'XRP':
      return 'xrp';
    case 'ADA':
      return 'cardano';
    case 'TRX':
      return 'tron';
    case 'BNB':
      return 'bnb';
    case 'MATIC':
    case 'POL':
      return 'polygon';
    case 'AVAX':
      return 'avalanche';
    default:
      return null; // DOT etc. — no in-wallet chain
  }
}

bool _isTokenCoin(String coin) => const {'USDC', 'USDT', 'DAI'}.contains(coin.toUpperCase());

// Conservative native-coin gas buffer kept back by the 100% (max) autofill so a
// drained balance can still pay the network fee. Tokens pay gas in the native
// coin, so their max fills the full token balance.
double _gasReserve(String coin) {
  switch (coin.toUpperCase()) {
    case 'ETH':
      return 0.0006;
    case 'BNB':
      return 0.0008;
    case 'MATIC':
    case 'POL':
      return 0.05;
    case 'AVAX':
      return 0.01;
    case 'SOL':
      return 0.00002;
    case 'BLOCK':
      return 0.001; // the chain's flat 0.001 BLOCK fee
    case 'BTC':
    case 'LTC':
    case 'BCH':
    case 'DOGE':
      return 0.0003;
    case 'XRP':
      return 0.00002;
    case 'ADA':
      return 0.2;
    case 'TRX':
      return 1.0; // bandwidth/energy headroom
    default:
      return 0;
  }
}

class _SwapCardState extends State<_SwapCard> {
  final _amt = TextEditingController();
  String _coin = 'USDC';
  bool _blockToCoin = true; // BLOCK -> coin by default

  double? _fromBalance; // wallet balance of the input asset (null = loading)
  String _balFor = ''; // which asset _fromBalance currently reflects
  bool _loadingBal = false;

  @override
  void initState() {
    super.initState();
    _loadBalance();
  }

  @override
  void dispose() {
    _amt.dispose();
    super.dispose();
  }

  String get _fromAsset => _blockToCoin ? 'BLOCK' : _coin;

  // Resolve the user's balance of the current input asset from the wallet.
  Future<void> _loadBalance() async {
    final asset = _fromAsset;
    if (_loadingBal) return;
    setState(() {
      _loadingBal = true;
      if (_balFor != asset) _fromBalance = null;
    });
    double? bal;
    try {
      final mc = context.read<MultichainController>();
      final chain = _chainForCoin(asset);
      if (chain != null) {
        final List<Balance> bals = await mc.balancesFor(chain);
        final want = asset.toUpperCase();
        Balance? match;
        for (final b in bals) {
          if ((b.asset.symbol).toUpperCase() == want) {
            match = b;
            break;
          }
        }
        match ??= _isTokenCoin(asset) ? null : (bals.isNotEmpty ? bals.first : null);
        if (match != null) {
          final raw = BigInt.tryParse(match.confirmed) ?? BigInt.zero;
          final dec = match.asset.decimals;
          bal = raw.toDouble() / math.pow(10, dec);
        } else {
          bal = 0;
        }
      }
    } catch (_) {
      bal = null;
    }
    if (!mounted) return;
    setState(() {
      _fromBalance = bal;
      _balFor = asset;
      _loadingBal = false;
    });
  }

  void _fillPct(double pct) {
    final bal = _fromBalance ?? 0;
    if (bal <= 0) return;
    double amt;
    if (pct >= 0.999 && !_isTokenCoin(_fromAsset)) {
      amt = (bal - _gasReserve(_fromAsset)).clamp(0.0, bal);
    } else {
      amt = bal * pct;
    }
    _amt.text = _trimAmt(amt);
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final svc = widget.svc;
    final amount = double.tryParse(_amt.text.trim()) ?? 0;
    final from = _blockToCoin ? 'BLOCK' : _coin;
    final to = _blockToCoin ? _coin : 'BLOCK';
    final q = amount > 0 ? svc.quote(from, to, amount) : null;
    final liqUsd = svc.availableLiquidityUsd(_coin);

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Bk.surface,
        borderRadius: BorderRadius.circular(Bk.rLg),
        border: Border.all(color: Bk.border),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          const Text('Swap', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: Bk.text)),
          const Spacer(),
          Text('$from → $to', style: TextStyle(color: Bk.muted, fontSize: 13)),
        ]),
        const SizedBox(height: 14),
        // From row
        Row(children: [
          Expanded(
            child: TextField(
              controller: _amt,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))],
              onChanged: (_) => setState(() {}),
              style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700, color: Bk.text),
              decoration: InputDecoration(
                hintText: '0.0',
                hintStyle: TextStyle(color: Bk.faint),
                filled: true,
                fillColor: Bk.surface2,
                contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
                border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(Bk.rMd), borderSide: BorderSide.none),
              ),
            ),
          ),
          const SizedBox(width: 10),
          _assetChip(from, selectable: !_blockToCoin),
        ]),
        const SizedBox(height: 8),
        _balanceRow(from),
        const SizedBox(height: 4),
        Center(
          child: IconButton(
            icon: const Icon(Icons.swap_vert, color: Bk.accent),
            onPressed: () {
              setState(() => _blockToCoin = !_blockToCoin);
              _loadBalance();
            },
          ),
        ),
        // To row
        Row(children: [
          Expanded(
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 16),
              decoration: BoxDecoration(color: Bk.surface2, borderRadius: BorderRadius.circular(Bk.rMd)),
              child: Text(
                q != null && q.ok ? _fmtAmt(q.amountOut) : '0.0',
                style: TextStyle(
                    fontSize: 20,
                    fontWeight: FontWeight.w700,
                    color: q != null && q.ok ? Bk.text : Bk.faint),
              ),
            ),
          ),
          const SizedBox(width: 10),
          _assetChip(to, selectable: _blockToCoin),
        ]),
        const SizedBox(height: 12),
        Row(children: [
          Text('$_coin liquidity: ${_fmtUsd(liqUsd)}', style: TextStyle(fontSize: 12, color: Bk.muted)),
          const Spacer(),
          Text('1 BLOCK = \$${svc.blockPriceUsd.toStringAsFixed(svc.blockPriceUsd < 0.01 ? 6 : 4)}',
              style: const TextStyle(fontSize: 12, color: Bk.muted)),
        ]),
        if (q != null && !q.ok) ...[
          const SizedBox(height: 8),
          Text(q.reason ?? 'Unavailable', style: TextStyle(fontSize: 12, color: Bk.bad)),
        ],
        const SizedBox(height: 14),
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: (q != null && q.ok) ? () => _doSwap(context, svc, from, to, amount) : null,
            style: FilledButton.styleFrom(
              backgroundColor: Bk.accent,
              padding: const EdgeInsets.symmetric(vertical: 15),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Bk.rMd)),
            ),
            child: Text(amount <= 0 ? 'Enter an amount' : 'Swap',
                style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
          ),
        ),
        const SizedBox(height: 6),
        Text(
            svc.onchainSettlement
                ? 'Live — a swap records against the treasury, then you deposit '
                    '$from to the hot wallet and we pay out $to on-chain. Your '
                    'funds are only moved once your deposit is confirmed.'
                : 'Preview — swaps run against the in-wallet treasury model. '
                    'Reserves are simulated (seeded + fee-funded), not yet '
                    'on-chain custodial liquidity.',
            style: TextStyle(fontSize: 11, color: Bk.faint, height: 1.35)),
      ]),
    );
  }

  Widget _assetChip(String asset, {required bool selectable}) {
    if (asset == 'BLOCK' || !selectable) {
      return Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
        decoration: BoxDecoration(color: Bk.surface3, borderRadius: BorderRadius.circular(Bk.rMd)),
        child: Text(asset, style: const TextStyle(fontWeight: FontWeight.w700, color: Bk.text)),
      );
    }
    return InkWell(
      onTap: _pickCoin,
      borderRadius: BorderRadius.circular(Bk.rMd),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
        decoration: BoxDecoration(color: Bk.surface3, borderRadius: BorderRadius.circular(Bk.rMd)),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Text(_coin, style: const TextStyle(fontWeight: FontWeight.w700, color: Bk.text)),
          const Icon(Icons.expand_more, size: 18, color: Bk.muted),
        ]),
      ),
    );
  }

  Future<void> _pickCoin() async {
    final svc = widget.svc;
    // Sort the pickable coins by how much liquidity each pool actually has — the
    // deepest first — so the user sees where a swap will fill best.
    final coins = [...kMoonPayCoins]
      ..sort((a, b) => svc.availableLiquidityUsd(b).compareTo(svc.availableLiquidityUsd(a)));
    final maxLiq = coins.fold<double>(0, (m, c) => svc.availableLiquidityUsd(c) > m ? svc.availableLiquidityUsd(c) : m);
    final picked = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: Bk.surface,
      isScrollControlled: true,
      builder: (_) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Padding(
            padding: EdgeInsets.fromLTRB(18, 16, 18, 4),
            child: Align(alignment: Alignment.centerLeft,
              child: Text('Swap BLOCK for', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: Bk.text))),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 0, 18, 8),
            child: Align(alignment: Alignment.centerLeft,
              child: Text('Available liquidity per asset (fee-funded).',
                  style: TextStyle(fontSize: 12, color: Bk.faint))),
          ),
          Flexible(
            child: ListView(
              shrinkWrap: true,
              children: [
                for (final c in coins)
                  Builder(builder: (_) {
                    final liqUsd = svc.availableLiquidityUsd(c);
                    final units = svc.pool.reserves[c] ?? 0;
                    final has = liqUsd > 0.01;
                    final frac = maxLiq > 0 ? (liqUsd / maxLiq).clamp(0.0, 1.0) : 0.0;
                    return ListTile(
                      onTap: () => Navigator.pop(context, c),
                      title: Row(children: [
                        Text(c, style: const TextStyle(color: Bk.text, fontWeight: FontWeight.w700)),
                        const SizedBox(width: 10),
                        if (has)
                          Expanded(
                            child: ClipRRect(
                              borderRadius: BorderRadius.circular(3),
                              child: LinearProgressIndicator(
                                value: frac, minHeight: 4,
                                backgroundColor: Bk.surface2,
                                valueColor: const AlwaysStoppedAnimation(Bk.accent),
                              ),
                            ),
                          )
                        else
                          const Spacer(),
                      ]),
                      subtitle: Text(
                        has ? '${_fmtAmt(units)} $c in pool' : 'No liquidity yet — bot fees fund it',
                        style: TextStyle(fontSize: 11.5, color: has ? Bk.muted : Bk.faint),
                      ),
                      trailing: Text(has ? _fmtUsd(liqUsd) : '—',
                          style: TextStyle(color: has ? Bk.text : Bk.faint, fontSize: 13, fontWeight: FontWeight.w700)),
                    );
                  }),
              ],
            ),
          ),
        ]),
      ),
    );
    if (picked != null) {
      setState(() => _coin = picked);
      if (!_blockToCoin) _loadBalance(); // the coin is the input asset
    }
  }

  // Balance of the input asset + gas-aware 25/50/100% autofills.
  Widget _balanceRow(String from) {
    final chainKnown = _chainForCoin(from) != null;
    final bal = _fromBalance;
    final loading = _loadingBal && _balFor != from;
    final balText = !chainKnown
        ? '—'
        : loading
            ? '…'
            : bal == null
                ? '—'
                : '${_trimAmt(bal)} $from';
    final enabled = (bal ?? 0) > 0;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        Text('Balance: ', style: TextStyle(fontSize: 12, color: Bk.faint)),
        Flexible(
          child: Text(balText,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: Bk.text)),
        ),
        const Spacer(),
        for (final p in const [0.25, 0.5, 1.0])
          Padding(
            padding: const EdgeInsets.only(left: 6),
            child: _PctChip(
              label: p >= 1.0 ? 'MAX' : '${(p * 100).round()}%',
              onTap: enabled ? () => _fillPct(p) : null,
            ),
          ),
      ]),
      if (enabled && !_isTokenCoin(from) && _gasReserve(from) > 0)
        Padding(
          padding: const EdgeInsets.only(top: 3),
          child: Text('MAX keeps ~${_trimAmt(_gasReserve(from))} $from back for gas',
              style: TextStyle(fontSize: 10.5, color: Bk.faint)),
        ),
    ]);
  }

  Future<void> _doSwap(BuildContext context, LiquidityService svc, String from, String to, double amount) async {
    final messenger = ScaffoldMessenger.of(context);
    // On-chain gate live → real settlement: deposit the input asset to the
    // treasury hot wallet, then /settle pays out the output asset.
    if (svc.onchainSettlement) {
      final coin = from == 'BLOCK' ? to : from;
      if (!svc.coinSettlesOnchain(coin)) {
        messenger.showSnackBar(SnackBar(
          content: Text('$coin on-chain settlement isn\'t live yet — BLOCK ↔ '
              'USDC/USDT/DAI/ETH/BNB/MATIC/AVAX settle today.'),
        ));
        return;
      }
      await _doOnchainSwap(context, svc, from, to, amount);
      return;
    }
    // Gate off → authoritative accounting preview (no funds move).
    final q = await svc.swap(from, to, amount);
    if (!mounted) return;
    if (q.ok) {
      _amt.clear();
      setState(() {});
      messenger.showSnackBar(SnackBar(
        content: Text('Swapped ${_fmtAmt(q.amountIn)} $from → ${_fmtAmt(q.amountOut)} $to'),
        backgroundColor: Bk.good.withValues(alpha: 0.9),
      ));
    } else {
      messenger.showSnackBar(SnackBar(content: Text(q.reason ?? 'Swap failed')));
    }
  }

  Future<void> _doOnchainSwap(
      BuildContext context, LiquidityService svc, String from, String to, double amount) async {
    final messenger = ScaffoldMessenger.of(context);
    // Where the PAYOUT (the `to` asset) should land = the user's wallet address
    // on the output asset's chain.
    final payoutChain = _chainForCoin(to);
    if (payoutChain == null) {
      messenger.showSnackBar(SnackBar(content: Text('No wallet address for $to')));
      return;
    }
    String? receive;
    try {
      final acct = await context.read<MultichainController>().addressFor(payoutChain);
      receive = acct?.address;
    } catch (_) {}
    if (receive == null || receive.isEmpty) {
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text('Could not derive your $to receive address')));
      return;
    }
    final receiveAddr = receive;
    final rec = await svc.startOnchainSwap(from, to, amount, receiveAddr);
    if (!mounted) return;
    if (rec == null || rec['ok'] == false || rec['status'] == null) {
      messenger.showSnackBar(SnackBar(content: Text('${rec?['reason'] ?? rec?['error'] ?? 'Swap unavailable'}')));
      return;
    }
    final depositAddress = '${rec['depositAddress'] ?? svc.depositAddressFor(from) ?? ''}';
    if (depositAddress.isEmpty) {
      messenger.showSnackBar(const SnackBar(content: Text('Treasury deposit wallet not ready')));
      return;
    }
    _amt.clear();
    setState(() {});
    // Hand off to the settlement sheet (deposit → paste txid → /settle → payout).
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: Bk.surface,
      isScrollControlled: true,
      builder: (_) => _SettlementSheet(
        svc: svc,
        id: '${rec['id']}',
        from: from,
        to: to,
        amountIn: (rec['amountIn'] as num?)?.toDouble() ?? amount,
        amountOut: (rec['amountOut'] as num?)?.toDouble() ?? 0,
        depositAddress: depositAddress,
        receiveAddress: receiveAddr,
      ),
    );
    if (mounted) _loadBalance();
  }
}

class _PctChip extends StatelessWidget {
  const _PctChip({required this.label, this.onTap});
  final String label;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) {
    final on = onTap != null;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
        decoration: BoxDecoration(
          color: on ? Bk.accentGhost : Bk.surface2,
          borderRadius: BorderRadius.circular(8),
        ),
        child: Text(label,
            style: TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w700,
                color: on ? Bk.accent : Bk.faint)),
      ),
    );
  }
}

// The on-chain settlement sheet: the swap is recorded server-side and awaiting
// the user's deposit. The user sends `amountIn` of `from` to the treasury hot
// wallet, pastes the deposit txid, and /settle verifies it + pays out `to`.
class _SettlementSheet extends StatefulWidget {
  const _SettlementSheet({
    required this.svc,
    required this.id,
    required this.from,
    required this.to,
    required this.amountIn,
    required this.amountOut,
    required this.depositAddress,
    required this.receiveAddress,
  });
  final LiquidityService svc;
  final String id;
  final String from;
  final String to;
  final double amountIn;
  final double amountOut;
  final String depositAddress;
  final String receiveAddress;

  @override
  State<_SettlementSheet> createState() => _SettlementSheetState();
}

class _SettlementSheetState extends State<_SettlementSheet> {
  final _txid = TextEditingController();
  bool _busy = false;
  String? _error;
  String? _payoutTxid; // set once settled

  @override
  void dispose() {
    _txid.dispose();
    super.dispose();
  }

  Future<void> _complete() async {
    final txid = _txid.text.trim();
    if (txid.isEmpty) {
      setState(() => _error = 'Paste the transaction ID of your deposit');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final r = await widget.svc.settle(widget.id, txid);
    if (!mounted) return;
    final status = '${r['status'] ?? ''}';
    if (r['ok'] == false) {
      setState(() {
        _busy = false;
        _error = '${r['error'] ?? 'Settlement failed'}';
      });
    } else if (status == 'settled') {
      setState(() {
        _busy = false;
        _payoutTxid = '${r['payoutTxid'] ?? ''}';
      });
    } else if (status == 'awaiting-deposit') {
      setState(() {
        _busy = false;
        _error = '${r['reason'] ?? 'Deposit not confirmed yet'} — wait for a '
            'confirmation, then try Complete again.';
      });
    } else {
      setState(() {
        _busy = false;
        _error = '${r['reason'] ?? 'Could not settle ($status)'}';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final settled = _payoutTxid != null;
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(18, 16, 18, 16 + MediaQuery.of(context).viewInsets.bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Text(settled ? 'Swap complete' : 'Complete your swap',
                style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800, color: Bk.text)),
            const Spacer(),
            IconButton(icon: const Icon(Icons.close, color: Bk.muted), onPressed: () => Navigator.pop(context)),
          ]),
          const SizedBox(height: 2),
          Text('${_fmtAmt(widget.amountIn)} ${widget.from}  →  ${_fmtAmt(widget.amountOut)} ${widget.to}',
              style: TextStyle(fontSize: 14, color: Bk.muted, fontWeight: FontWeight.w600)),
          const SizedBox(height: 16),
          if (settled) ...[
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                  color: Bk.good.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(Bk.rMd),
                  border: Border.all(color: Bk.good.withValues(alpha: 0.4))),
              child: Row(children: [
                const Icon(Icons.check_circle, color: Bk.good),
                const SizedBox(width: 10),
                Expanded(
                  child: Text('${_fmtAmt(widget.amountOut)} ${widget.to} sent to your wallet.',
                      style: const TextStyle(color: Bk.text, fontWeight: FontWeight.w600)),
                ),
              ]),
            ),
            if ((_payoutTxid ?? '').isNotEmpty) ...[
              const SizedBox(height: 10),
              _copyField('Payout transaction', _payoutTxid!),
            ],
            const SizedBox(height: 16),
            SizedBox(
              width: double.infinity,
              child: FilledButton(
                onPressed: () => Navigator.pop(context),
                style: FilledButton.styleFrom(
                    backgroundColor: Bk.accent,
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Bk.rMd))),
                child: const Text('Done', style: TextStyle(fontWeight: FontWeight.w700)),
              ),
            ),
          ] else ...[
            _stepLabel('1', 'Send exactly this amount from your own wallet'),
            const SizedBox(height: 8),
            _copyField('Amount', _trimAmt(widget.amountIn), suffix: widget.from),
            const SizedBox(height: 8),
            _copyField('To — treasury ${widget.from} address', widget.depositAddress),
            const SizedBox(height: 16),
            _stepLabel('2', 'Paste the deposit transaction ID, then complete'),
            const SizedBox(height: 8),
            TextField(
              controller: _txid,
              style: const TextStyle(fontSize: 13, color: Bk.text),
              decoration: InputDecoration(
                hintText: 'Deposit transaction ID / hash',
                hintStyle: TextStyle(color: Bk.faint),
                filled: true,
                fillColor: Bk.surface2,
                contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(Bk.rMd), borderSide: BorderSide.none),
              ),
            ),
            if (_error != null) ...[
              const SizedBox(height: 10),
              Text(_error!, style: const TextStyle(fontSize: 12.5, color: Bk.bad)),
            ],
            const SizedBox(height: 10),
            Text('Payout goes to your ${widget.to} address '
                '${_short(widget.receiveAddress)}. The swap is held until your '
                'deposit is confirmed — your funds are never at risk before then.',
                style: TextStyle(fontSize: 11, color: Bk.faint, height: 1.35)),
            const SizedBox(height: 14),
            SizedBox(
              width: double.infinity,
              child: FilledButton(
                onPressed: _busy ? null : _complete,
                style: FilledButton.styleFrom(
                    backgroundColor: Bk.accent,
                    padding: const EdgeInsets.symmetric(vertical: 15),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Bk.rMd))),
                child: _busy
                    ? const SizedBox(
                        height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                    : const Text('Complete swap', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
              ),
            ),
          ],
        ]),
      ),
    );
  }

  static String _short(String a) => a.length <= 14 ? a : '${a.substring(0, 8)}…${a.substring(a.length - 4)}';

  Widget _stepLabel(String n, String text) => Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Container(
          width: 20,
          height: 20,
          alignment: Alignment.center,
          decoration: const BoxDecoration(color: Bk.accentGhost, shape: BoxShape.circle),
          child: Text(n, style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w800, color: Bk.accent)),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Text(text, style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, color: Bk.text)),
        ),
      ]);

  Widget _copyField(String label, String value, {String? suffix}) {
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 10, 8, 10),
      decoration: BoxDecoration(color: Bk.surface2, borderRadius: BorderRadius.circular(Bk.rMd)),
      child: Row(children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(label, style: TextStyle(fontSize: 11, color: Bk.faint)),
            const SizedBox(height: 2),
            Text(suffix == null ? value : '$value $suffix',
                style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: Bk.text)),
          ]),
        ),
        IconButton(
          icon: const Icon(Icons.copy, size: 18, color: Bk.muted),
          onPressed: () {
            Clipboard.setData(ClipboardData(text: value));
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text('$label copied'), duration: const Duration(seconds: 1)),
            );
          },
        ),
      ]),
    );
  }
}

class _PoolList extends StatelessWidget {
  const _PoolList({required this.svc});
  final LiquidityService svc;
  @override
  Widget build(BuildContext context) {
    final entries = svc.pool.reserves.entries.where((e) => e.value > 1e-9).toList()
      ..sort((a, b) => svc.availableLiquidityUsd(b.key).compareTo(svc.availableLiquidityUsd(a.key)));
    if (entries.isEmpty) {
      return Container(
        padding: const EdgeInsets.all(18),
        decoration: BoxDecoration(
            color: Bk.surface, borderRadius: BorderRadius.circular(Bk.rMd), border: Border.all(color: Bk.border)),
        child: Text(
          'No reserves yet — run a trading bot and its 0.05% fees will seed the first hot wallet here.',
          style: TextStyle(color: Bk.muted, fontSize: 13, height: 1.4),
        ),
      );
    }
    return Column(
      children: [
        for (final e in entries)
          Container(
            margin: const EdgeInsets.only(bottom: 10),
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
                color: Bk.surface, borderRadius: BorderRadius.circular(Bk.rMd), border: Border.all(color: Bk.border)),
            child: Row(children: [
              Container(
                width: 38,
                height: 38,
                alignment: Alignment.center,
                decoration: BoxDecoration(color: Bk.surface3, borderRadius: BorderRadius.circular(10)),
                child: Text(e.key.substring(0, e.key.length >= 3 ? 3 : e.key.length),
                    style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 12, color: Bk.text)),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('BLOCK / ${e.key}',
                      style: const TextStyle(fontWeight: FontWeight.w700, color: Bk.text)),
                  const SizedBox(height: 2),
                  Text('${_fmtAmt(e.value)} ${e.key} in reserve',
                      style: TextStyle(fontSize: 11.5, color: Bk.muted)),
                ]),
              ),
              Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
                Text(_fmtUsd(svc.availableLiquidityUsd(e.key)),
                    style: const TextStyle(fontWeight: FontWeight.w700, color: Bk.text)),
                Text('fees ${_fmtUsd(svc.pool.feesUsd[e.key] ?? 0)}', style: TextStyle(fontSize: 11, color: Bk.faint)),
              ]),
            ]),
          ),
      ],
    );
  }
}
