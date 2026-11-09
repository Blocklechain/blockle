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

import '../multichain/chains/chain_adapter.dart' show AssetRef, Balance, SendRequest;
import '../state/liquidity_controller.dart';
import '../state/multichain_controller.dart';
import '../theme.dart';
import 'wallet/send_gate.dart';

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
    // Prefer the REAL on-chain custodial balance when the server reports it;
    // fall back to the accounting treasury figure otherwise.
    final onchainBal = svc.blockOnchainBalance;
    final treasury = onchainBal ?? svc.pool.blockTreasury;
    final treasuryLabel = onchainBal != null ? 'Treasury BLOCK · on-chain' : 'Treasury BLOCK';
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
          _stat(treasuryLabel, _fmtAmt(treasury)),
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
  AssetRef? _fromAssetRef; // the exact asset ref (token contract/decimals) to send
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
    AssetRef? ref;
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
          ref = match.asset;
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
      _fromAssetRef = ref;
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
        if (q != null && q.ok) ...[
          Builder(builder: (_) {
            // Effective fill price vs spot — shows the curve moving on this trade.
            final spot = q.blockPriceUsd;
            final cu = svc.priceOf(_coin) > 0 ? svc.priceOf(_coin) : 1.0;
            final eff = _blockToCoin
                ? (q.amountOut * cu) / q.amountIn // BLOCK→coin: USD out / BLOCK in
                : (q.amountIn * cu) / q.amountOut; // coin→BLOCK: USD in / BLOCK out
            final pct = spot > 0 ? (eff / spot - 1) * 100 : 0.0;
            if (pct.abs() < 0.01) return const SizedBox.shrink();
            final up = pct > 0;
            return Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                '${up ? 'Pushes BLOCK price up' : 'Moves BLOCK price down'} '
                '${pct.abs().toStringAsFixed(pct.abs() >= 1 ? 1 : 2)}% · '
                'fills at \$${eff.toStringAsFixed(eff < 0.01 ? 6 : 4)}/BLOCK',
                style: TextStyle(fontSize: 11.5, color: up ? Bk.good : Bk.muted),
              ),
            );
          }),
        ],
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
                ? 'Live — confirm once and the wallet automatically deposits '
                    '$from and pays out $to on-chain. Nothing moves until you '
                    'approve the deposit; the payout completes on its own once '
                    'the deposit confirms.'
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
              '${svc.settleableLabel} settle today.'),
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
    final id = '${rec['id']}';
    final amountIn = (rec['amountIn'] as num?)?.toDouble() ?? amount;
    final amountOut = (rec['amountOut'] as num?)?.toDouble() ?? 0;
    final depositChain = _chainForCoin(from)!;

    // Resolve the exact asset to send: the one loaded for the balance (correct
    // token contract + decimals), else the chain's native coin.
    final mc = context.read<MultichainController>();
    final isNative = !_isTokenCoin(from);
    AssetRef? assetRef = (_balFor == from) ? _fromAssetRef : null;
    if (!isNative && assetRef == null) {
      // Fetch the token ref if we don't already hold it.
      try {
        final bals = await mc.balancesFor(depositChain);
        for (final b in bals) {
          if (b.asset.symbol.toUpperCase() == from.toUpperCase()) {
            assetRef = b.asset;
            break;
          }
        }
      } catch (_) {}
      if (assetRef == null) {
        if (!mounted) return;
        messenger.showSnackBar(SnackBar(content: Text('Could not resolve $from to deposit')));
        return;
      }
    }
    // Decimals come from the resolved asset, else the deposit chain's NATIVE coin
    // (SOL = 9, BLOCK = 8, ETH = 18…) — never a hard-coded 18, which would have
    // scaled a native SOL deposit by 10^9.
    final dec = assetRef?.decimals ?? mc.registry.get(depositChain).native.decimals;
    final amountBase = _toBaseUnits(amountIn, dec);

    // THE pre-sign security gate — every value-moving send must clear it.
    final approved = await reviewSend(
      context,
      chain: depositChain,
      to: depositAddress,
      amount: amountBase,
      asset: (assetRef ?? mc.registry.get(depositChain).native).toJson(),
      title: 'Confirm swap deposit',
      previewHeader: 'Deposit $from to Blockle Liquidity',
      resolvedAddress: shortSendAddr(depositAddress),
    );
    if (!mounted) return;
    if (!approved) {
      messenger.showSnackBar(const SnackBar(content: Text('Swap cancelled — nothing was sent.')));
      return;
    }

    // Build + broadcast the deposit automatically, then auto-settle.
    _amt.clear();
    setState(() {});
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: Bk.surface,
      isScrollControlled: true,
      isDismissible: false,
      enableDrag: false,
      builder: (_) => _AutoSettleSheet(
        svc: svc,
        mc: mc,
        id: id,
        from: from,
        to: to,
        amountIn: amountIn,
        amountOut: amountOut,
        depositChain: depositChain,
        depositAddress: depositAddress,
        assetRef: isNative ? null : assetRef,
        amountBase: amountBase,
      ),
    );
    if (mounted) _loadBalance();
  }

  // Whole units → base-unit integer string for [decimals] places.
  static String _toBaseUnits(double amount, int decimals) {
    final s = amount.toStringAsFixed(decimals);
    final parts = s.split('.');
    final whole = BigInt.parse(parts[0]);
    final frac = parts.length > 1 ? parts[1].padRight(decimals, '0').substring(0, decimals) : '';
    final scaled = whole * BigInt.from(10).pow(decimals) + (frac.isEmpty ? BigInt.zero : BigInt.parse(frac));
    return scaled.toString();
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


// Fully-automatic on-chain settlement: builds + broadcasts the deposit from the
// user's wallet (the security gate already cleared), then polls /settle until the
// payout lands. If the deposit hasn't confirmed within the window (BLOCK blocks
// are ~10 min), it's registered as a pending settlement that completes
// automatically later — the user never copies an address or a txid.
class _AutoSettleSheet extends StatefulWidget {
  const _AutoSettleSheet({
    required this.svc,
    required this.mc,
    required this.id,
    required this.from,
    required this.to,
    required this.amountIn,
    required this.amountOut,
    required this.depositChain,
    required this.depositAddress,
    required this.assetRef,
    required this.amountBase,
  });
  final LiquidityService svc;
  final MultichainController mc;
  final String id;
  final String from;
  final String to;
  final double amountIn;
  final double amountOut;
  final String depositChain;
  final String depositAddress;
  final AssetRef? assetRef; // null = native coin
  final String amountBase;

  @override
  State<_AutoSettleSheet> createState() => _AutoSettleSheetState();
}

enum _Phase { sending, settling, done, pending, error }

class _AutoSettleSheetState extends State<_AutoSettleSheet> {
  _Phase _phase = _Phase.sending;
  String _status = 'Signing and broadcasting your deposit…';
  String? _depositTxid;
  String? _payoutTxid;
  String? _error;
  bool _closed = false;

  @override
  void initState() {
    super.initState();
    _run();
  }

  @override
  void dispose() {
    _closed = true;
    super.dispose();
  }

  Future<void> _run() async {
    // 1) Build + broadcast the deposit from the user's own wallet.
    String txid;
    try {
      final adapter = widget.mc.registry.get(widget.depositChain);
      final acct = await widget.mc.accounts.accountFor(widget.depositChain);
      final built = await adapter.buildSend(
        acct,
        SendRequest(
          to: widget.depositAddress,
          amount: widget.amountBase,
          asset: widget.assetRef, // null = native
        ),
      );
      final res = await adapter.broadcast(built);
      txid = res.txid;
      if (txid.isEmpty) throw Exception('no deposit txid');
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _phase = _Phase.error;
        _error = 'Deposit failed: ${e.toString().replaceFirst('Exception: ', '')}';
      });
      return;
    }
    _depositTxid = txid;
    // Persist immediately so the payout completes even if the app is closed.
    await widget.svc.addPendingSettlement({
      'id': widget.id,
      'depositTxid': txid,
      'from': widget.from,
      'to': widget.to,
      'amountOut': widget.amountOut,
    });
    if (!mounted) return;
    setState(() {
      _phase = _Phase.settling;
      _status = 'Deposit sent. Waiting for confirmation, then paying out…';
    });

    // 2) Poll /settle until the payout lands or the window elapses.
    const maxTries = 10;
    for (var i = 0; i < maxTries && !_closed; i++) {
      final r = await widget.svc.settle(widget.id, txid);
      if (!mounted) return;
      final st = '${r['status'] ?? ''}';
      if (st == 'settled') {
        await widget.svc.resumePendingSettlements(); // drops it from pending
        setState(() {
          _phase = _Phase.done;
          _payoutTxid = '${r['payoutTxid'] ?? ''}';
        });
        return;
      }
      if (st == 'unsupported' || st == 'failed' || '${r['error'] ?? ''}'.contains('unknown swap')) {
        setState(() {
          _phase = _Phase.error;
          _error = '${r['reason'] ?? r['error'] ?? 'Settlement failed'}';
        });
        return;
      }
      // still 'awaiting-deposit' / 'paying' → wait and retry. Surface the
      // server's reason (e.g. "deposit not confirmed yet", or a payout that was
      // rejected and will be retried) so a stall is never a silent spinner.
      final why = '${r['reason'] ?? r['error'] ?? ''}'.trim();
      setState(() => _status = st == 'paying'
          ? 'Deposit confirmed — paying out your ${widget.to}… (${i + 1}/$maxTries)'
          : 'Confirming deposit… (${i + 1}/$maxTries)${why.isNotEmpty ? ' — $why' : ''}');
      await Future<void>.delayed(const Duration(seconds: 15));
    }
    // Didn't confirm in-window — it stays pending and auto-completes later.
    if (!mounted) return;
    setState(() {
      _phase = _Phase.pending;
      _status = 'Deposit broadcast. Your ${widget.to} will arrive automatically '
          'once the deposit confirms — you can close this.';
    });
  }

  @override
  Widget build(BuildContext context) {
    final done = _phase == _Phase.done;
    final err = _phase == _Phase.error;
    final busy = _phase == _Phase.sending || _phase == _Phase.settling;
    // Closeable once the deposit is broadcast — it finishes automatically.
    final canClose = _phase != _Phase.sending;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(18, 18, 18, 18),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Text(
                done
                    ? 'Swap complete'
                    : err
                        ? 'Swap failed'
                        : _phase == _Phase.pending
                            ? 'Deposit sent'
                            : 'Swapping…',
                style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800, color: Bk.text)),
            const Spacer(),
            if (canClose)
              IconButton(icon: const Icon(Icons.close, color: Bk.muted), onPressed: () => Navigator.pop(context)),
          ]),
          const SizedBox(height: 2),
          Text('${_fmtAmt(widget.amountIn)} ${widget.from}  →  ${_fmtAmt(widget.amountOut)} ${widget.to}',
              style: TextStyle(fontSize: 14, color: Bk.muted, fontWeight: FontWeight.w600)),
          const SizedBox(height: 18),
          if (busy) ...[
            Row(children: [
              const SizedBox(
                  height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Bk.accent)),
              const SizedBox(width: 12),
              Expanded(child: Text(_status, style: const TextStyle(fontSize: 13.5, color: Bk.text))),
            ]),
          ] else if (done) ...[
            _resultBanner(Bk.good, Icons.check_circle,
                '${_fmtAmt(widget.amountOut)} ${widget.to} sent to your wallet.'),
            if ((_payoutTxid ?? '').isNotEmpty) ...[
              const SizedBox(height: 10),
              _txRow('Payout transaction', _payoutTxid!),
            ],
          ] else if (_phase == _Phase.pending) ...[
            _resultBanner(Bk.accent, Icons.schedule, _status),
            if ((_depositTxid ?? '').isNotEmpty) ...[
              const SizedBox(height: 10),
              _txRow('Deposit transaction', _depositTxid!),
            ],
          ] else ...[
            _resultBanner(Bk.bad, Icons.error_outline, _error ?? 'Something went wrong'),
            if ((_depositTxid ?? '').isNotEmpty) ...[
              const SizedBox(height: 10),
              Text('Your deposit ($_depositTxid) was broadcast and will still be '
                  'settled automatically once it confirms.',
                  style: TextStyle(fontSize: 11.5, color: Bk.faint, height: 1.35)),
            ],
          ],
          if (!busy) ...[
            const SizedBox(height: 16),
            SizedBox(
              width: double.infinity,
              child: FilledButton(
                onPressed: () => Navigator.pop(context),
                style: FilledButton.styleFrom(
                    backgroundColor: Bk.accent,
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Bk.rMd))),
                child: Text(done ? 'Done' : 'Close', style: const TextStyle(fontWeight: FontWeight.w700)),
              ),
            ),
          ],
        ]),
      ),
    );
  }

  Widget _resultBanner(Color c, IconData icon, String text) => Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
            color: c.withValues(alpha: 0.12),
            borderRadius: BorderRadius.circular(Bk.rMd),
            border: Border.all(color: c.withValues(alpha: 0.4))),
        child: Row(children: [
          Icon(icon, color: c),
          const SizedBox(width: 10),
          Expanded(child: Text(text, style: const TextStyle(color: Bk.text, fontWeight: FontWeight.w600))),
        ]),
      );

  Widget _txRow(String label, String value) => Container(
        padding: const EdgeInsets.fromLTRB(14, 10, 8, 10),
        decoration: BoxDecoration(color: Bk.surface2, borderRadius: BorderRadius.circular(Bk.rMd)),
        child: Row(children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(label, style: TextStyle(fontSize: 11, color: Bk.faint)),
              const SizedBox(height: 2),
              Text(value, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12.5, color: Bk.text)),
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
