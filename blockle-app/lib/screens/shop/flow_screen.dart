// Running a money flow, one step at a time.
//
// THIS SCREEN IS A GUIDE, NOT AN AUTOPILOT, and it says so. Three of the four
// steps are not ours to perform: MoonPay's buy and sell are hosted widgets
// where MoonPay is the merchant of record and runs the KYC, and the final
// retail purchase is the user paying a shop with their own money, which a
// non-custodial wallet cannot do on their behalf. Only the treasury swap is
// executed by Blockle.
//
// So each step opens the right place, and the user confirms what happened.
// The confirm button is worded "I've done this" rather than "Next" for a
// reason: tapping it records the user's statement, and on the payout leg a
// wrong tap means waiting days for money that was never sent.
//
// THE PROGRESS IS SAVED AFTER EVERY STEP. "Pay with BLOCK" spans a bank
// payout of one to three business days, so the user will close the app in the
// middle of it. See flow_run.dart.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../services/moonpay.dart';
import '../../shop/flow_run.dart';
import '../../shop/ui.dart';
import '../../state/app_state.dart';
import '../../state/multichain_controller.dart';
import '../../theme.dart';
import '../accounts_screen.dart' show MoonPayBuyScreen, MoonPaySellScreen;
import '../liquidity_screen.dart';

class FlowScreen extends StatelessWidget {
  const FlowScreen({super.key, required this.runId});
  final String runId;

  @override
  Widget build(BuildContext context) {
    final runs = context.watch<FlowRuns>();
    final run = runs.runs.where((r) => r.id == runId).firstOrNull;

    if (run == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Flow')),
        body: const Padding(
          padding: EdgeInsets.all(16),
          child: ShopEmpty(
              icon: Icons.help_outline,
              title: 'This flow is no longer here',
              body: 'It may have been completed or cleared on another '
                  'device.'),
        ),
      );
    }

    final t = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: Text(run.title)),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
          children: [
            _Progress(run: run),
            const SizedBox(height: 18),

            for (var i = 0; i < run.steps.length; i++)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: _StepCard(run: run, step: run.steps[i], index: i),
              ),

            const SizedBox(height: 8),
            if (run.complete)
              const ShopNote(
                  'All steps done. Anything that settles on a bank timetable '
                  'may still be in transit.',
                  tone: PillTone.good,
                  icon: Icons.check_circle_outline)
            else
              // SAID ONCE, PROMINENTLY. A user who believes the app is doing
              // this for them will close it and wait for something that never
              // happens.
              const ShopNote(
                  'Blockle guides these steps but does not perform them for '
                  'you. Your funds stay in your wallet and your accounts '
                  'throughout — each step opens the place where you complete '
                  'it yourself.',
                  icon: Icons.account_balance_wallet_outlined),

            if (!run.complete) ...[
              const SizedBox(height: 18),
              TextButton(
                onPressed: () => _confirmAbandon(context, runs, run),
                child: Text('Stop tracking this',
                    style: t.labelLarge?.copyWith(color: Bk.faint)),
              ),
            ],
          ],
        ),
      ),
    );
  }

  void _confirmAbandon(BuildContext context, FlowRuns runs, FlowRun run) {
    showDialog<void>(
      context: context,
      builder: (d) => AlertDialog(
        title: const Text('Stop tracking?'),
        // NOT "cancel". Nothing here can be cancelled — any step already
        // completed moved real money, and saying otherwise would imply this
        // undoes it.
        content: const Text(
            'This only removes the checklist. Steps you have already '
            'completed are not reversed — any funds that moved have moved. '
            'The record is kept in your history.'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(d), child: const Text('Keep')),
          TextButton(
            onPressed: () {
              runs.abandon(run);
              Navigator.pop(d);
              Navigator.pop(context);
            },
            child: const Text('Stop tracking',
                style: TextStyle(color: Bk.bad)),
          ),
        ],
      ),
    );
  }
}

class _Progress extends StatelessWidget {
  const _Progress({required this.run});
  final FlowRun run;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final n = run.steps.length;
    return ShopCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(
            child: Text(
                run.merchant == null
                    ? run.title
                    : '${run.title} · ${run.merchant}',
                style: t.titleMedium),
          ),
          ShopPill('${run.doneCount} of $n done',
              tone: run.complete ? PillTone.good : PillTone.accent),
        ]),
        const SizedBox(height: 12),
        ClipRRect(
          borderRadius: BorderRadius.circular(4),
          child: LinearProgressIndicator(
            value: n == 0 ? 0 : run.doneCount / n,
            minHeight: 6,
            backgroundColor: Bk.surface3,
          ),
        ),
      ]),
    );
  }
}

class _StepCard extends StatefulWidget {
  const _StepCard({required this.run, required this.step, required this.index});
  final FlowRun run;
  final RunStep step;
  final int index;

  @override
  State<_StepCard> createState() => _StepCardState();
}

class _StepCardState extends State<_StepCard> {
  bool _opening = false;
  String? _openError;

  @override
  Widget build(BuildContext context) {
    final s = widget.step;
    final t = Theme.of(context).textTheme;
    final active = s.state == LegState.active || s.state == LegState.failed;
    final done = s.state == LegState.done;

    return Opacity(
      // Future steps are visibly inert so the one to act on is unmistakable.
      opacity: s.state == LegState.waiting ? 0.55 : 1,
      child: ShopCard(
        highlight: active,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            _Bullet(index: widget.index, state: s.state),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(s.name, style: t.titleSmall),
                    const SizedBox(height: 3),
                    Text(s.describe,
                        style: t.bodySmall?.copyWith(color: Bk.muted)),
                  ]),
            ),
            if (done) const Icon(Icons.check_circle, color: Bk.good, size: 20),
          ]),

          if (s.state == LegState.failed && s.note != null) ...[
            const SizedBox(height: 12),
            ShopNote(s.note!, tone: PillTone.bad, icon: Icons.error_outline),
          ],
          if (_openError != null) ...[
            const SizedBox(height: 12),
            ShopNote(_openError!, tone: PillTone.bad),
          ],

          if (active) ...[
            const SizedBox(height: 14),
            FilledButton(
              onPressed: _opening ? null : _open,
              child: _opening
                  ? const SizedBox(
                      height: 18,
                      width: 18,
                      child: CircularProgressIndicator(
                          strokeWidth: 2, color: Colors.white))
                  : Text(_openLabel(s.action)),
            ),
            const SizedBox(height: 8),
            Row(children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: () => _reportProblem(context),
                  child: const Text('It didn\'t work'),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                // "I'VE DONE THIS", never "Next". The user is asserting a
                // fact about their money, not advancing a wizard.
                child: FilledButton.tonal(
                  onPressed: () => context.read<FlowRuns>().advance(widget.run),
                  child: const Text('I\'ve done this'),
                ),
              ),
            ]),
          ],
        ]),
      ),
    );
  }

  static String _openLabel(LegAction a) => switch (a) {
        LegAction.moonpayBuy => 'Open MoonPay to buy',
        LegAction.moonpaySell => 'Open MoonPay to cash out',
        LegAction.treasurySwap => 'Open the swap',
        LegAction.retailCheckout => 'Open the store',
      };

  Future<void> _open() async {
    setState(() {
      _opening = true;
      _openError = null;
    });
    try {
      await _route();
    } catch (e) {
      if (mounted) {
        setState(() => _openError =
            'Could not open that step: ${e.toString().replaceFirst('Exception: ', '')}');
      }
    } finally {
      if (mounted) setState(() => _opening = false);
    }
  }

  /// Send the user to the real destination for this leg.
  ///
  /// Each branch reuses the screen that already owns that path — the MoonPay
  /// ramp host with its verified-webhook status handling, the Liquidity swap
  /// with its security gate and signing. A second implementation of any of
  /// these would be a second place for a money bug to live.
  Future<void> _route() async {
    final s = widget.step;
    final mc = context.read<MultichainController>();

    switch (s.action) {
      case LegAction.moonpayBuy:
        final coin = s.params['coin'] ?? '';
        final chain = _chainFor(coin);
        final acct = await mc.addressFor(chain);
        final addr = acct?.address ?? '';
        if (addr.isEmpty) {
          throw Exception('no $coin address in this wallet yet');
        }
        final url = await moonpayBuyUrl(
          config: mc.moonpayConfig,
          chain: chain,
          walletAddress: addr,
          symbol: coin,
          baseCurrencyCode: 'usd',
          baseCurrencyAmount: s.params['usd'],
        );
        if (url == null) throw Exception('MoonPay cannot sell $coin here');
        if (!mounted) return;
        await Navigator.push(
            context,
            MaterialPageRoute(
                builder: (_) => MoonPayBuyScreen(url: url, assetLabel: coin)));

      case LegAction.moonpaySell:
        final coin = s.params['coin'] ?? '';
        final chain = _chainFor(coin);
        final acct = await mc.addressFor(chain);
        final url = await moonpaySellUrl(
          config: mc.moonpayConfig,
          chain: chain,
          walletAddress: acct?.address,
          symbol: coin,
          quoteCurrencyCode: 'usd',
          baseCurrencyAmount: s.params['amount'],
        );
        if (url == null) throw Exception('MoonPay cannot cash out $coin here');
        if (!mounted) return;
        await Navigator.push(
            context,
            MaterialPageRoute(
                builder: (_) => MoonPaySellScreen(url: url, assetLabel: coin)));

      case LegAction.treasurySwap:
        if (!mounted) return;
        await Navigator.push(context,
            MaterialPageRoute(builder: (_) => const LiquidityScreen()));

      case LegAction.retailCheckout:
        final url = widget.run.checkoutUrl;
        if (url == null || url.isEmpty) {
          throw Exception('this flow has no store link');
        }
        // The user's own checkout, in the in-app browser. Blockle fills
        // nothing and submits nothing here.
        context.read<AppState>().openBrowser(url);
    }
  }

  /// MoonPay needs the chain the coin lives on. Only the assets these flows
  /// actually use are mapped; an unknown coin raises rather than guessing a
  /// chain, because a guess here sends a payout to an address on the wrong
  /// network.
  static String _chainFor(String coin) => switch (coin.toUpperCase()) {
        'SOL' => 'solana',
        'ETH' => 'ethereum',
        'BTC' => 'bitcoin',
        'USDC' => 'ethereum',
        'USDT' => 'ethereum',
        _ => throw Exception('no chain mapped for $coin'),
      };

  void _reportProblem(BuildContext context) {
    final c = TextEditingController();
    showDialog<void>(
      context: context,
      builder: (d) => AlertDialog(
        title: const Text('What happened?'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          const Text(
              'This is saved with the flow so you can see where it stopped.',
              style: TextStyle(fontSize: 13, color: Bk.muted)),
          const SizedBox(height: 12),
          TextField(
              controller: c,
              maxLines: 3,
              decoration: const InputDecoration(
                  hintText: 'e.g. MoonPay declined the card')),
        ]),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(d), child: const Text('Cancel')),
          TextButton(
            onPressed: () {
              context.read<FlowRuns>().fail(
                  widget.run,
                  c.text.trim().isEmpty
                      ? 'This step did not complete.'
                      : c.text.trim());
              Navigator.pop(d);
            },
            child: const Text('Save'),
          ),
        ],
      ),
    );
  }
}

class _Bullet extends StatelessWidget {
  const _Bullet({required this.index, required this.state});
  final int index;
  final LegState state;

  @override
  Widget build(BuildContext context) {
    final (bg, fg) = switch (state) {
      LegState.done => (Bk.good, Colors.black),
      LegState.active => (Bk.accent, Colors.white),
      LegState.failed => (Bk.bad, Colors.white),
      LegState.waiting => (Bk.surface3, Bk.faint),
    };
    return Container(
      width: 24,
      height: 24,
      alignment: Alignment.center,
      decoration: BoxDecoration(color: bg, shape: BoxShape.circle),
      child: Text('${index + 1}',
          style: TextStyle(
              fontSize: 12, fontWeight: FontWeight.w700, color: fg)),
    );
  }
}
