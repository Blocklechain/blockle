// blockle_alien_screen.dart — the Blockle Alien subscription screen (in-app
// purchase). Live trading is FREE for your first bot; Blockle Alien raises the
// live-bot cap (3), Blockle Alien Pro removes it. Purchase via the App Store /
// Play Billing (StoreKit), a 7-day free trial, crypto (MoonPay Commerce), or
// Restore. The server webhook is the authority on entitlement — the client only
// reflects the tier it reports back.

import 'package:flutter/material.dart';
import 'package:in_app_purchase/in_app_purchase.dart';
import 'package:provider/provider.dart';

import '../services/open_url.dart';
import '../services/subscription_service.dart';
import '../state/bots_controller.dart';
import '../state/multichain_controller.dart';
import '../theme.dart';
import 'account_auth_screen.dart';

class BlockleAlienScreen extends StatefulWidget {
  const BlockleAlienScreen({super.key});
  @override
  State<BlockleAlienScreen> createState() => _BlockleAlienScreenState();
}

class _BlockleAlienScreenState extends State<BlockleAlienScreen> {
  late final SubscriptionService _subs;
  List<ProductDetails> _products = const [];
  bool _storeReady = false;
  bool _busy = false;
  String? _note;
  String? _error;

  @override
  void initState() {
    super.initState();
    final mc = context.read<MultichainController>();
    final bots = context.read<BotsController>();
    _subs = SubscriptionService(
      tokenProvider: () => mc.agent.acctToken,
      originProvider: () => mc.agent.acctOrigin,
      onEntitlement: (tier) {
        // The server reported the new effective tier — reflect it into the live
        // bot gate and refresh the UI.
        bots.setLiveEntitled(tier);
        if (mounted) {
          setState(() => _note = 'You\'re on ${blockleAlienTierLabel(tier)}.');
        }
      },
    );
    _subs.start();
    _loadProducts();
  }

  @override
  void dispose() {
    _subs.dispose();
    super.dispose();
  }

  Future<void> _loadProducts() async {
    try {
      final ready = await _subs.available();
      final prods = ready ? await _subs.products() : const <ProductDetails>[];
      if (!mounted) return;
      setState(() {
        _storeReady = ready;
        _products = prods;
      });
    } catch (_) {
      if (mounted) setState(() => _storeReady = false);
    }
  }

  ProductDetails? _product(String id) {
    for (final p in _products) {
      if (p.id == id) return p;
    }
    return null;
  }

  Future<bool> _ensureSignedIn() async {
    final mc = context.read<MultichainController>();
    if (mc.agent.acctToken != null) return true;
    final ok = await requireAccount(context,
        reason: 'A subscription is tied to your Blockle account so it works across '
            'your devices and the web wallet. Sign in to continue.');
    return ok && mc.agent.acctToken != null;
  }

  Future<void> _subscribe(bool pro) async {
    if (!await _ensureSignedIn() || !mounted) return;
    setState(() { _busy = true; _error = null; _note = null; });
    try {
      final id = pro ? CopilotProducts.copilotPro() : CopilotProducts.copilot();
      final launched = await _subs.buy(id);
      if (!launched) {
        setState(() => _error = _subs.lastError ?? 'The store sheet could not open.');
      } else {
        setState(() => _note = 'Complete the purchase in the store sheet — your plan '
            'unlocks once it\'s verified.');
      }
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _startTrial() async {
    if (!await _ensureSignedIn() || !mounted) return;
    setState(() { _busy = true; _error = null; _note = null; });
    try {
      final tier = await _subs.startFreeTrial();
      if (tier == 'free') {
        setState(() => _error = _subs.lastError ?? 'Your free trial could not be started '
            '(it may already have been used).');
      } else {
        setState(() => _note = 'Your 7-day free trial of ${blockleAlienTierLabel(tier)} is active.');
      }
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _payCrypto(bool pro) async {
    if (!await _ensureSignedIn() || !mounted) return;
    setState(() { _busy = true; _error = null; _note = null; });
    try {
      final url = await _subs.buyWithCrypto(pro: pro);
      if (url == null) {
        setState(() => _error = _subs.lastError ?? 'Crypto checkout is unavailable.');
      } else {
        openExternal(url);
        setState(() => _note = 'Finish the crypto checkout in your browser — your plan '
            'unlocks once the payment is confirmed.');
      }
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _restore() async {
    setState(() { _busy = true; _error = null; _note = null; });
    try {
      await _subs.restore();
      if (mounted) setState(() => _note = 'Restoring — any active subscription will re-apply.');
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final bots = context.watch<BotsController>();
    final tier = bots.tier;
    final cap = bots.liveBotCap; // 1 / 3 / -1
    final isPro = tier == 'copilot_pro';
    final isAlien = tier == 'copilot';

    return Scaffold(
      backgroundColor: Bk.bg,
      appBar: AppBar(title: const Text('Blockle Alien')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(18, 10, 18, 32),
        children: [
          _hero(tier, cap),
          const SizedBox(height: 20),
          _planCard(
            name: 'Free',
            price: '\$0',
            tagline: '1 live trading bot',
            features: const [
              '1 live bot (real funds, auto within its cap)',
              'Unlimited paper bots + Arena',
              'On-device AI (local or your own key)',
              'All chains, send, swap, NFTs',
            ],
            current: tier == 'free',
            highlight: false,
          ),
          const SizedBox(height: 12),
          _planCard(
            name: 'Blockle Alien',
            price: _priceOf(CopilotProducts.copilot(), '\$12/mo'),
            tagline: '3 live trading bots',
            features: const [
              'Everything in Free',
              'Run up to 3 live bots at once',
              'Priority strategy backtests',
            ],
            current: isAlien,
            highlight: tier == 'free',
            onSubscribe: isAlien || isPro ? null : () => _subscribe(false),
            onCrypto: isAlien || isPro ? null : () => _payCrypto(false),
          ),
          const SizedBox(height: 12),
          _planCard(
            name: 'Blockle Alien Pro',
            price: _priceOf(CopilotProducts.copilotPro(), '\$30/mo'),
            tagline: 'Unlimited live bots',
            features: const [
              'Everything in Blockle Alien',
              'Unlimited live bots',
              'Highest server-runner priority',
            ],
            current: isPro,
            highlight: isAlien,
            onSubscribe: isPro ? null : () => _subscribe(true),
            onCrypto: isPro ? null : () => _payCrypto(true),
          ),
          const SizedBox(height: 20),
          if (tier == 'free')
            OutlinedButton.icon(
              onPressed: _busy ? null : _startTrial,
              icon: const Icon(Icons.card_giftcard_outlined, size: 18),
              label: const Text('Start 7-day free trial'),
              style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
            ),
          const SizedBox(height: 10),
          TextButton(
            onPressed: _busy ? null : _restore,
            child: const Text('Restore purchases', style: TextStyle(color: Bk.accent)),
          ),
          if (_note != null) ...[
            const SizedBox(height: 8),
            _banner(_note!, Bk.good),
          ],
          if (_error != null) ...[
            const SizedBox(height: 8),
            _banner(_error!, Bk.bad),
          ],
          if (!_storeReady) ...[
            const SizedBox(height: 8),
            const Text(
              'The app store isn\'t available on this device — you can still pay with '
              'crypto or on the web.',
              style: TextStyle(color: Bk.muted, fontSize: 12),
            ),
          ],
          const SizedBox(height: 18),
          const Text(
            'Subscriptions renew monthly and can be managed or cancelled anytime in '
            'your App Store / Google Play account settings. The 7-day free trial is '
            'available once. Live trading moves real funds within each bot\'s hard cap; '
            'past results never guarantee future returns.',
            style: TextStyle(color: Bk.muted, fontSize: 11.5, height: 1.5),
          ),
        ],
      ),
    );
  }

  String _priceOf(String id, String fallback) => _product(id)?.price ?? fallback;

  Widget _hero(String tier, int cap) {
    final capLabel = cap < 0 ? 'unlimited' : '$cap';
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [Bk.accent.withValues(alpha: 0.18), Bk.accent.withValues(alpha: 0.04)],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: Bk.accent.withValues(alpha: 0.35)),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Text('Run more live bots',
            style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800, color: Bk.text)),
        const SizedBox(height: 6),
        Text(
          'Your plan: ${blockleAlienTierLabel(tier)} · $capLabel live bot${cap == 1 ? '' : 's'}. '
          'Live trading is free for your first bot — upgrade to run more at once.',
          style: const TextStyle(color: Bk.muted, fontSize: 13, height: 1.45),
        ),
      ]),
    );
  }

  Widget _banner(String text, Color color) => Container(
        padding: const EdgeInsets.all(11),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: color.withValues(alpha: 0.4)),
        ),
        child: Text(text, style: TextStyle(color: color, fontSize: 12.5, height: 1.4)),
      );

  Widget _planCard({
    required String name,
    required String price,
    required String tagline,
    required List<String> features,
    required bool current,
    required bool highlight,
    VoidCallback? onSubscribe,
    VoidCallback? onCrypto,
  }) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Bk.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(
            color: highlight ? Bk.accent : Bk.border, width: highlight ? 1.6 : 1),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(
            child: Text(name,
                style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800, color: Bk.text)),
          ),
          Text(price, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: Bk.text)),
        ]),
        const SizedBox(height: 2),
        Row(children: [
          Expanded(child: Text(tagline, style: const TextStyle(color: Bk.accent, fontSize: 12.5, fontWeight: FontWeight.w600))),
          if (current)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
              decoration: BoxDecoration(
                color: Bk.good.withValues(alpha: 0.15),
                borderRadius: BorderRadius.circular(20),
              ),
              child: const Text('Current', style: TextStyle(color: Bk.good, fontSize: 11, fontWeight: FontWeight.w700)),
            ),
        ]),
        const SizedBox(height: 10),
        for (final f in features)
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Icon(Icons.check_rounded, size: 16, color: Bk.good),
              const SizedBox(width: 8),
              Expanded(child: Text(f, style: const TextStyle(color: Bk.muted, fontSize: 12.5, height: 1.35))),
            ]),
          ),
        if (onSubscribe != null) ...[
          const SizedBox(height: 8),
          FilledButton(
            onPressed: _busy ? null : onSubscribe,
            style: FilledButton.styleFrom(
                minimumSize: const Size.fromHeight(46), backgroundColor: Bk.accent),
            child: Text('Subscribe to $name',
                style: const TextStyle(fontWeight: FontWeight.w700, color: Colors.white)),
          ),
          if (onCrypto != null)
            Center(
              child: TextButton(
                onPressed: _busy ? null : onCrypto,
                child: const Text('or pay with crypto', style: TextStyle(color: Bk.muted, fontSize: 12.5)),
              ),
            ),
        ],
      ]),
    );
  }
}
