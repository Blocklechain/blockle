// screens/liquidity_screen.dart — Blockle Liquidity.
//
// The treasury that every trading bot funds: a 0.05% fee on each bot trade is
// auto-deposited here as the traded pair's base coin, deepening per-coin reserves
// ("hot wallets") paired against BLOCK. BLOCK starts at $0.001 with a 50,000-BLOCK
// seed. Here the user can see the pools grow and SWAP BLOCK ↔ any MoonPay coin
// against that fee-funded liquidity.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../liquidity/liquidity_pool.dart';
import '../state/liquidity_controller.dart';
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

class _Header extends StatelessWidget {
  const _Header({required this.svc});
  final LiquidityService svc;
  @override
  Widget build(BuildContext context) {
    final price = svc.blockPriceUsd ?? kBlockSeedPriceUsd;
    final treasury = svc.pool.blockTreasury;
    final deployed = svc.pool.deployedBlock;
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
          _stat('Deployed BLOCK', _fmtAmt(deployed)),
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

class _SwapCardState extends State<_SwapCard> {
  final _amt = TextEditingController();
  String _coin = 'USDC';
  bool _blockToCoin = true; // BLOCK -> coin by default
  @override
  void dispose() {
    _amt.dispose();
    super.dispose();
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
        Center(
          child: IconButton(
            icon: const Icon(Icons.swap_vert, color: Bk.accent),
            onPressed: () => setState(() => _blockToCoin = !_blockToCoin),
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
          Text('Liquidity: ${_fmtUsd(liqUsd)}', style: TextStyle(fontSize: 12, color: Bk.muted)),
          const Spacer(),
          if (q != null && q.ok)
            Text('Impact ${q.priceImpactPct.toStringAsFixed(2)}%',
                style: TextStyle(
                    fontSize: 12, color: q.priceImpactPct > 5 ? Bk.warn : Bk.muted)),
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
        Text('Swaps execute against the fee-funded treasury reserves.',
            style: TextStyle(fontSize: 11, color: Bk.faint)),
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
    final picked = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: Bk.surface,
      builder: (_) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(18, 14, 18, 8),
              child: Text('Swap BLOCK for', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: Bk.text)),
            ),
            for (final c in kMoonPayCoins)
              ListTile(
                title: Text(c, style: const TextStyle(color: Bk.text, fontWeight: FontWeight.w600)),
                trailing: Text(_fmtUsd(widget.svc.availableLiquidityUsd(c)),
                    style: TextStyle(color: Bk.muted, fontSize: 12)),
                onTap: () => Navigator.pop(context, c),
              ),
          ],
        ),
      ),
    );
    if (picked != null) setState(() => _coin = picked);
  }

  void _doSwap(BuildContext context, LiquidityService svc, String from, String to, double amount) {
    final q = svc.swap(from, to, amount);
    final messenger = ScaffoldMessenger.of(context);
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
}

class _PoolList extends StatelessWidget {
  const _PoolList({required this.svc});
  final LiquidityService svc;
  @override
  Widget build(BuildContext context) {
    final entries = svc.pool.pools.entries.toList()
      ..sort((a, b) => svc.availableLiquidityUsd(b.key).compareTo(svc.availableLiquidityUsd(a.key)));
    if (entries.isEmpty) {
      return Container(
        padding: const EdgeInsets.all(18),
        decoration: BoxDecoration(
            color: Bk.surface, borderRadius: BorderRadius.circular(Bk.rMd), border: Border.all(color: Bk.border)),
        child: Text(
          'No pools yet — run a trading bot and its 0.05% fees will seed the first hot wallet here.',
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
                  Text('${_fmtAmt(e.value.rBlock)} BLOCK · ${_fmtAmt(e.value.rBase)} ${e.key}',
                      style: TextStyle(fontSize: 11.5, color: Bk.muted)),
                ]),
              ),
              Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
                Text(_fmtUsd(svc.availableLiquidityUsd(e.key)),
                    style: const TextStyle(fontWeight: FontWeight.w700, color: Bk.text)),
                Text('fees ${_fmtUsd(e.value.feesUsd)}', style: TextStyle(fontSize: 11, color: Bk.faint)),
              ]),
            ]),
          ),
      ],
    );
  }
}
