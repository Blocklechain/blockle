// moonpay_swap.dart — crypto↔crypto SWAP via the MoonPay Trade API (the hosted
// buy/sell widgets don't cover swaps, so this is a native screen over the authed
// /account/api/moonpay/swap proxy). It is GATED behind a signed-in blockle.org
// account — the server's trade key is only released to logged-in users. The
// wallet never holds the trade key; it only relays quote/execute calls and shows
// MoonPay's deposit instructions (MoonPay custodies the swap leg, like its
// buy/sell flows). No new on-chain money path — funding the deposit uses the
// wallet's existing, gated Send.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../services/moonpay.dart';
import '../state/multichain_controller.dart';
import '../theme.dart';
import 'account_auth_screen.dart';
import 'accounts_screen.dart' show MultiSendScreen;

/// A MoonPay-swappable asset: the Trade-API currency code + a display label and
/// the wallet chain used to fund a deposit (null = fund manually).
class _SwapAsset {
  const _SwapAsset(this.code, this.symbol, this.name, {this.chain});
  final String code;
  final String symbol;
  final String name;
  final String? chain;
}

// A curated set of widely-supported MoonPay assets. Codes match MoonPay's
// currency list; `chain` ties the sell asset back to a wallet chain so the
// deposit can be funded through the gated Send.
const List<_SwapAsset> _kAssets = [
  _SwapAsset('eth', 'ETH', 'Ethereum', chain: 'ethereum'),
  _SwapAsset('usdc', 'USDC', 'USD Coin (Ethereum)', chain: 'ethereum'),
  _SwapAsset('usdt', 'USDT', 'Tether (Ethereum)', chain: 'ethereum'),
  _SwapAsset('btc', 'BTC', 'Bitcoin', chain: 'bitcoin'),
  _SwapAsset('sol', 'SOL', 'Solana', chain: 'solana'),
  _SwapAsset('usdc_sol', 'USDC', 'USD Coin (Solana)', chain: 'solana'),
  _SwapAsset('ltc', 'LTC', 'Litecoin', chain: 'litecoin'),
  _SwapAsset('bch', 'BCH', 'Bitcoin Cash', chain: 'bitcoincash'),
  _SwapAsset('doge', 'DOGE', 'Dogecoin', chain: 'dogecoin'),
  _SwapAsset('xrp', 'XRP', 'XRP', chain: 'xrp'),
  _SwapAsset('ada', 'ADA', 'Cardano', chain: 'cardano'),
  _SwapAsset('trx', 'TRX', 'Tron', chain: 'tron'),
  _SwapAsset('avax_cchain', 'AVAX', 'Avalanche', chain: 'avalanche'),
  _SwapAsset('bnb_bsc', 'BNB', 'BNB Chain', chain: 'bnb'),
  _SwapAsset('pol_polygon', 'POL', 'Polygon', chain: 'polygon'),
];

class MoonPaySwapScreen extends StatefulWidget {
  const MoonPaySwapScreen({super.key});
  @override
  State<MoonPaySwapScreen> createState() => _MoonPaySwapScreenState();
}

class _MoonPaySwapScreenState extends State<MoonPaySwapScreen> {
  _SwapAsset _sell = _kAssets[0]; // ETH
  _SwapAsset _buy = _kAssets[1]; // USDC
  final _amt = TextEditingController();
  Timer? _debounce;

  bool _quoting = false;
  bool _busy = false;
  String? _error;
  Map<String, dynamic>? _quote;

  @override
  void initState() {
    super.initState();
    _amt.addListener(_onAmtChanged);
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _amt.dispose();
    super.dispose();
  }

  void _onAmtChanged() {
    _debounce?.cancel();
    setState(() => _quote = null);
    _debounce = Timer(const Duration(milliseconds: 550), _fetchQuote);
  }

  double get _amount => double.tryParse(_amt.text.trim()) ?? 0;

  /// Tolerant numeric read — the Trade API shapes vary across fields/versions.
  static double? _num(Map m, List<String> keys) {
    for (final k in keys) {
      final v = m[k];
      if (v is num) return v.toDouble();
      if (v is String) {
        final p = double.tryParse(v);
        if (p != null) return p;
      }
    }
    return null;
  }

  Future<void> _fetchQuote() async {
    if (!mounted || _amount <= 0 || _sell.code == _buy.code) return;
    final mc = context.read<MultichainController>();
    setState(() {
      _quoting = true;
      _error = null;
    });
    try {
      final q = await moonpaySwapQuote(
        config: mc.moonpayConfig,
        sellAsset: _sell.code,
        buyAsset: _buy.code,
        amount: _amount,
        bearer: mc.moonpayBearer,
      );
      if (!mounted) return;
      setState(() => _quote = q);
    } on MoonPayServerException catch (e) {
      if (!mounted) return;
      setState(() => _error = _friendly(e.status, e.body));
    } catch (_) {
      if (!mounted) return;
      setState(() => _error = 'Couldn’t fetch a quote. Try again in a moment.');
    } finally {
      if (mounted) setState(() => _quoting = false);
    }
  }

  String _friendly(int status, String body) {
    if (status == 401 || status == 403) {
      return 'Sign in to your Blockle account to swap with MoonPay.';
    }
    if (status == 400 && body.toLowerCase().contains('pair')) {
      return 'MoonPay can’t swap this pair. Pick different assets.';
    }
    return 'MoonPay returned an error (HTTP $status).';
  }

  @override
  Widget build(BuildContext context) {
    final mc = context.watch<MultichainController>();
    final signedIn = (mc.moonpayBearer ?? '').isNotEmpty;
    return Scaffold(
      backgroundColor: Bk.bg,
      appBar: AppBar(
        title: const Text('Swap'),
        bottom: const PreferredSize(
          preferredSize: Size.fromHeight(18),
          child: Padding(
            padding: EdgeInsets.only(bottom: 8, left: 16, right: 16),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text('Powered by MoonPay',
                  style: TextStyle(fontSize: 11.5, color: Bk.faint)),
            ),
          ),
        ),
      ),
      body: signedIn ? _swapForm() : _signInGate(),
    );
  }

  Widget _signInGate() => Center(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Icon(Icons.lock_outline, size: 40, color: Bk.muted),
            const SizedBox(height: 14),
            const Text('Sign in to swap',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700, color: Bk.text)),
            const SizedBox(height: 8),
            const Text(
              'Swaps run through MoonPay’s Trade service, which needs a linked '
              'Blockle account. Your wallet keys never leave this device.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 13.5, height: 1.5, color: Bk.muted),
            ),
            const SizedBox(height: 18),
            FilledButton(
                onPressed: () async {
                  final ok = await requireAccount(context,
                      reason: 'Sign in to swap tokens with MoonPay.');
                  if (ok && mounted) setState(() {}); // re-render the swap form
                },
                style: FilledButton.styleFrom(
                    minimumSize: const Size.fromHeight(48), backgroundColor: Bk.accent),
                child: const Text('Sign in / Create account')),
          ]),
        ),
      );

  Widget _swapForm() {
    final q = _quote;
    final receive = q == null
        ? null
        : _num(q, ['quoteCurrencyAmount', 'buyAmount', 'amountOut', 'baseCurrencyAmount']);
    final rate = q == null ? null : _num(q, ['exchangeRate', 'rate', 'price']);
    final fee = q == null
        ? null
        : _num(q, ['feeAmount', 'totalFee', 'feeUsd']);
    final network = q == null ? null : _num(q, ['networkFeeAmount', 'networkFee']);
    final canReview = _amount > 0 && _sell.code != _buy.code && q != null && !_busy;

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 28),
      children: [
        _assetRow('From', _sell, (a) {
          setState(() {
            _sell = a;
            if (_buy.code == a.code) _buy = _kAssets.firstWhere((x) => x.code != a.code);
          });
          _onAmtChanged();
        }),
        const SizedBox(height: 8),
        TextField(
          controller: _amt,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))],
          style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w700, color: Bk.text),
          decoration: InputDecoration(
            hintText: '0.0',
            filled: true,
            fillColor: Bk.surface,
            suffixText: _sell.symbol,
            border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12), borderSide: BorderSide.none),
          ),
        ),
        // Swap-direction flip
        Center(
          child: IconButton(
            tooltip: 'Flip',
            icon: const Icon(Icons.swap_vert, color: Bk.accent),
            onPressed: () {
              setState(() {
                final s = _sell;
                _sell = _buy;
                _buy = s;
              });
              _onAmtChanged();
            },
          ),
        ),
        _assetRow('To', _buy, (a) {
          setState(() {
            _buy = a;
            if (_sell.code == a.code) _sell = _kAssets.firstWhere((x) => x.code != a.code);
          });
          _onAmtChanged();
        }),
        const SizedBox(height: 18),
        _quoteCard(receive, rate, fee, network),
        if (_error != null) ...[
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: Bk.bad.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: Bk.bad.withValues(alpha: 0.4)),
            ),
            child: Text(_error!, style: const TextStyle(color: Bk.bad, fontSize: 13)),
          ),
        ],
        const SizedBox(height: 18),
        FilledButton(
          onPressed: canReview ? _review : null,
          style: FilledButton.styleFrom(
              minimumSize: const Size.fromHeight(50),
              backgroundColor: Bk.accent,
              disabledBackgroundColor: Bk.surface2),
          child: _busy
              ? const SizedBox(
                  width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
              : Text('Review swap',
                  style: TextStyle(
                      fontWeight: FontWeight.w700,
                      color: canReview ? Colors.white : Bk.faint)),
        ),
        const SizedBox(height: 14),
        const Text(
          'MoonPay handles the swap, KYC and settlement. You’ll be shown a deposit '
          'address to fund from this wallet (you sign the send) and MoonPay sends '
          'the bought asset to your address. BLOCK is not on MoonPay — use the '
          'in-wallet DEX for BLOCK.',
          style: TextStyle(fontSize: 12, height: 1.5, color: Bk.faint),
        ),
      ],
    );
  }

  Widget _assetRow(String label, _SwapAsset sel, ValueChanged<_SwapAsset> onPick) {
    return InkWell(
      onTap: () => _pickAsset(sel, onPick),
      borderRadius: BorderRadius.circular(12),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
        decoration: BoxDecoration(
          color: Bk.surface,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: Bk.line),
        ),
        child: Row(children: [
          Text(label, style: const TextStyle(fontSize: 13, color: Bk.muted)),
          const Spacer(),
          Text('${sel.symbol} · ${sel.name}',
              style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: Bk.text)),
          const SizedBox(width: 6),
          const Icon(Icons.expand_more, size: 20, color: Bk.muted),
        ]),
      ),
    );
  }

  Future<void> _pickAsset(_SwapAsset current, ValueChanged<_SwapAsset> onPick) async {
    final picked = await showModalBottomSheet<_SwapAsset>(
      context: context,
      backgroundColor: Bk.surface,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (_) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            for (final a in _kAssets)
              ListTile(
                title: Text('${a.symbol} · ${a.name}',
                    style: const TextStyle(color: Bk.text, fontSize: 14)),
                trailing: a.code == current.code
                    ? const Icon(Icons.check, color: Bk.accent, size: 18)
                    : null,
                onTap: () => Navigator.pop(context, a),
              ),
          ],
        ),
      ),
    );
    if (picked != null) onPick(picked);
  }

  Widget _quoteCard(double? receive, double? rate, double? fee, double? network) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Bk.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Bk.line),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Text('You receive (estimated)',
            style: TextStyle(fontSize: 12, color: Bk.muted)),
        const SizedBox(height: 6),
        if (_quoting)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 4),
            child: SizedBox(
                width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)),
          )
        else
          Text(
            receive == null ? '—' : '${_fmt(receive)} ${_buy.symbol}',
            style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w700, color: Bk.text),
          ),
        if (rate != null) ...[
          const SizedBox(height: 8),
          _line('Rate', '1 ${_sell.symbol} ≈ ${_fmt(rate)} ${_buy.symbol}'),
        ],
        if (fee != null) _line('MoonPay fee', _fmt(fee)),
        if (network != null) _line('Network fee', _fmt(network)),
      ]),
    );
  }

  Widget _line(String k, String v) => Padding(
        padding: const EdgeInsets.only(top: 4),
        child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
          Text(k, style: const TextStyle(fontSize: 12.5, color: Bk.muted)),
          Text(v, style: const TextStyle(fontSize: 12.5, color: Bk.text)),
        ]),
      );

  static String _fmt(double v) {
    if (v == 0) return '0';
    if (v >= 1000) return v.toStringAsFixed(2);
    if (v >= 1) return v.toStringAsFixed(4);
    return v.toStringAsFixed(8).replaceFirst(RegExp(r'0+$'), '').replaceFirst(RegExp(r'\.$'), '');
  }

  Future<void> _review() async {
    final mc = context.read<MultichainController>();
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      // The deposit must land at a MoonPay-provided address; give MoonPay the
      // wallet's receive address for the BOUGHT asset so settlement comes home.
      String? payoutAddr;
      final buyChain = _buy.chain;
      if (buyChain != null) {
        payoutAddr = (await mc.addressFor(buyChain))?.address;
      }
      final quoteId = (_quote?['id'] ?? _quote?['quoteId'] ?? '').toString();
      final trade = await moonpaySwapExecute(
        config: mc.moonpayConfig,
        quoteId: quoteId,
        bearer: mc.moonpayBearer,
        extra: {
          if (payoutAddr != null && payoutAddr.isNotEmpty) 'payoutWalletAddress': payoutAddr,
        },
      );
      if (!mounted) return;
      await _showDepositSheet(trade);
    } on MoonPayServerException catch (e) {
      if (!mounted) return;
      setState(() => _error = _friendly(e.status, e.body));
    } catch (_) {
      if (!mounted) return;
      setState(() => _error = 'Couldn’t start the swap. Try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Show MoonPay's deposit instructions. If the trade response carries a deposit
  /// address + amount, offer to fund it from the wallet through the gated Send
  /// (the user signs). Otherwise show whatever status MoonPay returned.
  Future<void> _showDepositSheet(Map<String, dynamic> trade) async {
    final deposit = (trade['depositWalletAddress'] ??
            trade['depositAddress'] ??
            (trade['depositWallet'] is Map ? trade['depositWallet']['address'] : null))
        ?.toString();
    final amount = _num(trade, ['baseCurrencyAmount', 'depositAmount', 'sellAmount']) ?? _amount;
    final status = (trade['status'] ?? 'created').toString();

    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Bk.surface,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (sheetCtx) => Padding(
        padding: EdgeInsets.fromLTRB(
            18, 18, 18, 18 + MediaQuery.of(sheetCtx).viewInsets.bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Swap started · $status',
              style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700, color: Bk.text)),
          const SizedBox(height: 10),
          if (deposit != null && deposit.isNotEmpty) ...[
            Text('Send ${_fmt(amount)} ${_sell.symbol} to MoonPay to complete the swap:',
                style: const TextStyle(fontSize: 13.5, height: 1.5, color: Bk.muted)),
            const SizedBox(height: 10),
            SelectableText(deposit,
                style: const TextStyle(fontSize: 13, fontFamily: 'monospace', color: Bk.text)),
            const SizedBox(height: 6),
            Row(children: [
              TextButton.icon(
                icon: const Icon(Icons.copy, size: 16),
                label: const Text('Copy'),
                onPressed: () {
                  Clipboard.setData(ClipboardData(text: deposit));
                  ScaffoldMessenger.of(context)
                      .showSnackBar(const SnackBar(content: Text('Deposit address copied.')));
                },
              ),
            ]),
            const SizedBox(height: 8),
            if (_sell.chain != null)
              FilledButton.icon(
                style: FilledButton.styleFrom(
                    minimumSize: const Size.fromHeight(48), backgroundColor: Bk.accent),
                icon: const Icon(Icons.north_east, size: 18),
                label: Text('Send ${_sell.symbol} now'),
                onPressed: () {
                  Navigator.pop(sheetCtx);
                  // The deposit address is pre-filled; the user enters the shown
                  // amount and signs through the wallet's existing gated Send.
                  Navigator.push(
                    context,
                    MaterialPageRoute(
                      builder: (_) =>
                          MultiSendScreen(chain: _sell.chain!, prefillTo: deposit),
                    ),
                  );
                },
              )
            else
              const Text('Fund this address manually from where you hold the asset.',
                  style: TextStyle(fontSize: 12.5, color: Bk.faint)),
          ] else
            const Text(
              'MoonPay has created your swap. Open MoonPay from your account to '
              'see deposit instructions and track settlement.',
              style: TextStyle(fontSize: 13.5, height: 1.5, color: Bk.muted),
            ),
          const SizedBox(height: 14),
          TextButton(
              onPressed: () => Navigator.pop(sheetCtx), child: const Text('Done')),
        ]),
      ),
    );
  }
}
