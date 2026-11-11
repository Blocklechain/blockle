// blockshot_screen.dart — BLOCKSHOT: launch + trade BLOCK-20 tokens on the
// native AMM, pump-style. Fully non-custodial: a launch is ONE user-signed
// LaunchToken transaction (deploy + mint + seed pool); every trade is the SAME
// gated AMM swap the Swap screen uses (security inspection + confirm sheet,
// then a user-signed pool swap). Nothing custodial, no server in the money path.
//
// Token metadata (logo image, description, links) is OFF-chain cosmetics,
// registered with /api/dex/register after the launch confirms and shown on the
// token page — it can never affect funds.
//
// RULES HONORED: BLOCK-20 prices are shown in BLOCK ONLY (never USD); no emoji
// in product UI (icons + gradients carry the flash).

import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:image_picker/image_picker.dart';
import 'package:provider/provider.dart';

import '../services/open_url.dart';
import '../state/app_state.dart';
import '../theme.dart';
import 'queue.dart';
import 'wallet/send_gate.dart';

const int _coin = 100000000; // BLOCK base units
const double _ammFee = 0.003; // 0.30% pool swap fee
const double _slip = 0.02; // 2% slippage tolerance for quick taps

/// Session price history per token (price in BLOCK), for sparklines + flashes.
final Map<String, List<double>> _spark = {};

double _poolPrice(Map<String, dynamic> p) {
  final dec = (p['decimals'] as num?)?.toInt() ?? 0;
  final br = ((p['blockReserve'] as num?) ?? 0) / _coin;
  final tr = ((p['tokenReserve'] as num?) ?? 0) / math.pow(10, dec);
  if (br <= 0 || tr <= 0) return 0;
  return br / tr; // BLOCK per token
}

String _fmtB(double n, {int max = 8}) {
  if (n == 0) return '0';
  if (n >= 1000) return n.toStringAsFixed(0);
  if (n >= 1) return n.toStringAsFixed(2);
  var s = n.toStringAsFixed(max);
  s = s.replaceFirst(RegExp(r'0+$'), '').replaceFirst(RegExp(r'\.$'), '');
  return s;
}

/// Brand detection for token links — the right symbol per destination.
/// (Material ships telegram/discord glyphs; X gets a bold letter mark.)
({IconData? icon, String? letter, String label}) _linkBrand(String url) {
  final u = url.toLowerCase();
  if (u.contains('x.com') || u.contains('twitter.com')) {
    return (icon: null, letter: 'X', label: 'X');
  }
  if (u.contains('t.me') || u.contains('telegram')) {
    return (icon: Icons.telegram, letter: null, label: 'Telegram');
  }
  if (u.contains('discord.gg') || u.contains('discord.com')) {
    return (icon: Icons.discord, letter: null, label: 'Discord');
  }
  final host = Uri.tryParse(url)?.host ?? '';
  return (icon: Icons.language_rounded, letter: null, label: host.isEmpty ? 'Website' : host);
}

class BlockshotScreen extends StatefulWidget {
  const BlockshotScreen({super.key});
  @override
  State<BlockshotScreen> createState() => _BlockshotScreenState();
}

class _BlockshotScreenState extends State<BlockshotScreen>
    with SingleTickerProviderStateMixin {
  List<Map<String, dynamic>> _pools = [];
  Set<String> _hidden = {};
  Map<String, Map<String, dynamic>> _meta = {}; // token -> {logo, description, links}
  final Map<String, double> _lastPrice = {};
  final Map<String, int> _flash = {}; // token -> +1 up / -1 down, cleared after paint
  bool _loading = true;
  Timer? _poll;
  late final AnimationController _pulse;

  @override
  void initState() {
    super.initState();
    _pulse = AnimationController(vsync: this, duration: const Duration(seconds: 2))
      ..repeat(reverse: true);
    _load();
    _loadMeta();
    _poll = Timer.periodic(const Duration(seconds: 8), (_) => _load());
  }

  @override
  void dispose() {
    _poll?.cancel();
    _pulse.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final app = context.read<AppState>();
    final pools = await app.chain.pools();
    final hidden = await _BlockshotModeration.hidden();
    if (!mounted) return;
    _hidden = hidden;
    for (final p in pools) {
      final id = '${p['token']}';
      final px = _poolPrice(p);
      final prev = _lastPrice[id];
      if (prev != null && px != prev) _flash[id] = px > prev ? 1 : -1;
      _lastPrice[id] = px;
      final h = _spark.putIfAbsent(id, () => []);
      if (h.isEmpty || h.last != px) h.add(px);
      if (h.length > 60) h.removeAt(0);
    }
    setState(() {
      _pools = pools;
      _loading = false;
    });
    if (_flash.isNotEmpty) {
      Future.delayed(const Duration(milliseconds: 900), () {
        if (mounted) setState(_flash.clear);
      });
    }
  }

  Future<void> _loadMeta() async {
    try {
      final app = context.read<AppState>();
      final base = app.chain.apiBase.replaceFirst(RegExp(r'/explorer$'), '');
      final r = await http
          .get(Uri.parse('$base/dex/tokens'))
          .timeout(const Duration(seconds: 8));
      if (r.statusCode != 200 || !mounted) return;
      final j = (jsonDecode(r.body) as Map).cast<String, dynamic>();
      setState(() {
        _meta = {
          for (final e in j.entries)
            if (e.value is Map) e.key: (e.value as Map).cast<String, dynamic>(),
        };
      });
    } catch (_) {/* monograms are fine */}
  }

  int get _tip => _pools.isEmpty ? 0 : ((_pools.first['height'] as num?)?.toInt() ?? 0);
  double get _totalLiqBlock =>
      _pools.fold(0.0, (a, p) => a + ((p['blockReserve'] as num?) ?? 0) / _coin * 2);

  // Tokens the user reported/hid are filtered out of every board list.
  Iterable<Map<String, dynamic>> get _visible =>
      _pools.where((p) => !_hidden.contains('${p['token']}'));

  List<Map<String, dynamic>> get _trending {
    final l = _visible.toList();
    l.sort((a, b) => ((b['blockReserve'] as num?) ?? 0).compareTo((a['blockReserve'] as num?) ?? 0));
    return l;
  }

  List<Map<String, dynamic>> get _fresh {
    final l = _visible.toList();
    l.sort((a, b) => ((b['createdHeight'] as num?) ?? 0).compareTo((a['createdHeight'] as num?) ?? 0));
    return l;
  }

  void _refreshAll() {
    _load();
    _loadMeta();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Bk.bg,
      body: SafeArea(
        child: RefreshIndicator(
          onRefresh: () async => _refreshAll(),
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 110),
            children: [
              _hero(),
              const SizedBox(height: 14),
              _launchCta(),
              const SizedBox(height: 20),
              _sectionHead('TRENDING', Icons.local_fire_department_rounded, Bk.accent),
              const SizedBox(height: 6),
              if (_loading)
                const Padding(
                  padding: EdgeInsets.all(30),
                  child: Center(child: CircularProgressIndicator(color: Bk.accent)),
                )
              else if (_pools.isEmpty)
                _emptyState()
              else
                ..._trending.take(10).map(_tokenRow),
              if (_fresh.isNotEmpty) ...[
                const SizedBox(height: 18),
                _sectionHead('JUST LAUNCHED', Icons.rocket_launch_rounded, Bk.accent2),
                const SizedBox(height: 6),
                ..._fresh.take(6).map((p) => _tokenRow(p, fresh: true)),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _hero() {
    return AnimatedBuilder(
      animation: _pulse,
      builder: (context, _) {
        final t = _pulse.value;
        return Container(
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: [
                Color.lerp(const Color(0xFF2A1458), const Color(0xFF131B4D), t)!,
                Color.lerp(const Color(0xFF0E2A3A), const Color(0xFF0B3A2E), t)!,
              ],
            ),
            borderRadius: BorderRadius.circular(20),
            border: Border.all(color: Bk.accent.withValues(alpha: 0.35 + 0.2 * t)),
            boxShadow: [
              BoxShadow(
                color: Bk.accent.withValues(alpha: 0.10 + 0.08 * t),
                blurRadius: 24,
                spreadRadius: 1,
              ),
            ],
          ),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              const Text('BLOCKSHOT',
                  style: TextStyle(
                      fontSize: 26,
                      fontWeight: FontWeight.w900,
                      letterSpacing: 2.5,
                      color: Bk.text)),
              const SizedBox(width: 10),
              Container(
                width: 9,
                height: 9,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: Bk.good.withValues(alpha: 0.5 + 0.5 * t),
                  boxShadow: [
                    BoxShadow(color: Bk.good.withValues(alpha: 0.6 * t), blurRadius: 8)
                  ],
                ),
              ),
              Text('  LIVE',
                  style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 1.5,
                      color: Bk.good.withValues(alpha: 0.7 + 0.3 * t))),
            ]),
            const SizedBox(height: 4),
            const Text('Launch a token in one transaction. Trade every launch on the curve.',
                style: TextStyle(fontSize: 12.5, color: Bk.muted, height: 1.4)),
            const SizedBox(height: 14),
            Row(children: [
              _heroStat('${_pools.length}', 'tokens live'),
              const SizedBox(width: 22),
              _heroStat('${_fmtB(_totalLiqBlock, max: 2)} BLOCK', 'locked in pools'),
              const SizedBox(width: 22),
              _heroStat(_tip > 0 ? '#$_tip' : '—', 'block height'),
            ]),
          ]),
        );
      },
    );
  }

  Widget _heroStat(String v, String l) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(v,
              style: const TextStyle(
                  fontSize: 16, fontWeight: FontWeight.w800, color: Bk.text,
                  fontFeatures: [FontFeature.tabularFigures()])),
          Text(l, style: const TextStyle(fontSize: 10.5, color: Bk.faint)),
        ],
      );

  Widget _launchCta() {
    return GestureDetector(
      onTap: () {
        HapticFeedback.mediumImpact();
        showModalBottomSheet(
          context: context,
          isScrollControlled: true,
          backgroundColor: Colors.transparent,
          builder: (_) => _LaunchSheet(onLaunched: _refreshAll),
        );
      },
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 16),
        decoration: BoxDecoration(
          gradient: const LinearGradient(colors: [Bk.accent, Color(0xFF37E0C8)]),
          borderRadius: BorderRadius.circular(16),
          boxShadow: [
            BoxShadow(color: Bk.accent.withValues(alpha: 0.35), blurRadius: 18, offset: const Offset(0, 6)),
          ],
        ),
        child: const Row(mainAxisAlignment: MainAxisAlignment.center, children: [
          Icon(Icons.rocket_launch_rounded, color: Colors.white, size: 20),
          SizedBox(width: 9),
          Text('LAUNCH YOUR TOKEN',
              style: TextStyle(
                  color: Colors.white,
                  fontWeight: FontWeight.w900,
                  fontSize: 15,
                  letterSpacing: 1.2)),
        ]),
      ),
    );
  }

  Widget _sectionHead(String title, IconData icon, Color c) => Row(children: [
        Icon(icon, size: 16, color: c),
        const SizedBox(width: 6),
        Text(title,
            style: TextStyle(
                fontSize: 12, fontWeight: FontWeight.w900, letterSpacing: 1.6, color: c)),
      ]);

  Widget _emptyState() => Container(
        padding: const EdgeInsets.all(26),
        decoration: BoxDecoration(
          color: Bk.surface,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: Bk.border),
        ),
        child: const Column(children: [
          Icon(Icons.rocket_launch_outlined, size: 38, color: Bk.muted),
          SizedBox(height: 10),
          Text('No tokens yet — be the FIRST launch.',
              style: TextStyle(color: Bk.text, fontWeight: FontWeight.w700)),
          SizedBox(height: 4),
          Text('The first mover gets the whole board to itself.',
              style: TextStyle(color: Bk.muted, fontSize: 12)),
        ]),
      );

  Widget _tokenRow(Map<String, dynamic> p, {bool fresh = false}) {
    final id = '${p['token']}';
    final sym = '${p['symbol'] ?? '?'}';
    final name = '${p['name'] ?? ''}';
    final px = _poolPrice(p);
    final liq = ((p['blockReserve'] as num?) ?? 0) / _coin * 2;
    final tip = (p['height'] as num?)?.toInt() ?? 0;
    final created = (p['createdHeight'] as num?)?.toInt() ?? 0;
    final locked = ((p['lockedUntil'] as num?)?.toInt() ?? 0) > tip;
    final ageBlocks = tip - created;
    final isNew = ageBlocks >= 0 && ageBlocks < 144; // < ~24h at 10-min blocks
    final flash = _flash[id] ?? 0;
    final logo = _meta[id]?['logo'] as String?;

    return AnimatedContainer(
      duration: const Duration(milliseconds: 500),
      margin: const EdgeInsets.only(bottom: 9),
      decoration: BoxDecoration(
        color: flash == 1
            ? Bk.good.withValues(alpha: 0.10)
            : flash == -1
                ? Bk.bad.withValues(alpha: 0.10)
                : Bk.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(
            color: flash == 1
                ? Bk.good.withValues(alpha: 0.5)
                : flash == -1
                    ? Bk.bad.withValues(alpha: 0.5)
                    : Bk.border),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: () {
          HapticFeedback.selectionClick();
          showModalBottomSheet(
            context: context,
            isScrollControlled: true,
            backgroundColor: Colors.transparent,
            builder: (_) => _TokenSheet(pool: p, meta: _meta[id], onTraded: _refreshAll),
          );
        },
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Row(children: [
            _tokenAvatar(sym, logo),
            const SizedBox(width: 11),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Text(sym,
                      style: const TextStyle(
                          fontWeight: FontWeight.w800, fontSize: 15, color: Bk.text)),
                  const SizedBox(width: 7),
                  if (isNew || fresh) _chip('NEW', Bk.accent2),
                  if (locked) _chip('LP LOCKED', Bk.good),
                ]),
                const SizedBox(height: 2),
                Text(name.isEmpty ? 'BLOCK-20' : name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 11.5, color: Bk.muted)),
              ]),
            ),
            Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
              Text('${_fmtB(px)} BLOCK',
                  style: TextStyle(
                      fontWeight: FontWeight.w800,
                      fontSize: 13.5,
                      color: flash == 1
                          ? Bk.good
                          : flash == -1
                              ? Bk.bad
                              : Bk.text,
                      fontFeatures: const [FontFeature.tabularFigures()])),
              const SizedBox(height: 2),
              Text('${_fmtB(liq, max: 2)} BLOCK liq',
                  style: const TextStyle(fontSize: 10.5, color: Bk.faint)),
            ]),
            const SizedBox(width: 6),
            const Icon(Icons.chevron_right_rounded, color: Bk.muted, size: 20),
          ]),
        ),
      ),
    );
  }
}

Widget _chip(String t, Color c) => Container(
      margin: const EdgeInsets.only(right: 4),
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: c.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(t,
          style: TextStyle(fontSize: 8.5, fontWeight: FontWeight.w900, letterSpacing: 0.8, color: c)),
    );

Widget _tokenAvatar(String sym, String? logo) {
  final mono = Container(
    width: 42,
    height: 42,
    decoration: BoxDecoration(
      gradient: LinearGradient(colors: [
        Bk.accent.withValues(alpha: 0.8),
        Bk.accent2.withValues(alpha: 0.8),
      ]),
      borderRadius: BorderRadius.circular(12),
    ),
    alignment: Alignment.center,
    child: Text(sym.isEmpty ? '?' : sym[0],
        style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w900, fontSize: 18)),
  );
  if (logo == null || logo.isEmpty) return mono;
  return ClipRRect(
    borderRadius: BorderRadius.circular(12),
    child: Image.network(logo,
        width: 42, height: 42, fit: BoxFit.cover, errorBuilder: (_, __, ___) => mono),
  );
}

/// Shared shell for both sheets: DRAG-DOWN CLOSES (DraggableScrollableSheet),
/// grab-handle + a BACK button in the header row.
/// Content moderation for launched tokens (user-generated content): a server
/// REPORT endpoint plus a local HIDE/block list so a user never sees a token
/// they've flagged again. Required by App Store Guideline 1.2 (UGC).
class _BlockshotModeration {
  static const _store = FlutterSecureStorage(
      aOptions: AndroidOptions(encryptedSharedPreferences: true));
  static const _key = 'blockshot_hidden_v1';
  static Set<String> _cache = {};
  static bool _loaded = false;

  static Future<Set<String>> hidden() async {
    if (_loaded) return _cache;
    try {
      final raw = await _store.read(key: _key);
      if (raw != null) {
        _cache = (jsonDecode(raw) as List).map((e) => '$e').toSet();
      }
    } catch (_) {}
    _loaded = true;
    return _cache;
  }

  static Future<void> hide(String contractId) async {
    _cache.add(contractId);
    _loaded = true;
    try {
      await _store.write(key: _key, value: jsonEncode(_cache.toList()));
    } catch (_) {}
  }

  /// Flag a token to Blockle for review. Best-effort — a dropped report must not
  /// block the user from also hiding it locally.
  static Future<void> report(
      String origin, String contractId, String symbol, String reason) async {
    try {
      await http
          .post(Uri.parse('$origin/account/api/blockshot/report'),
              headers: {'content-type': 'application/json'},
              body: jsonEncode({
                'token': contractId,
                'symbol': symbol,
                'reason': reason,
              }))
          .timeout(const Duration(seconds: 10));
    } catch (_) {}
  }
}

Widget _sheetShell(BuildContext context,
    {required String title,
    Widget? headerTrailing,
    required List<Widget> Function(ScrollController) children}) {
  return DraggableScrollableSheet(
    expand: false,
    initialChildSize: 0.88,
    minChildSize: 0.45,
    maxChildSize: 0.95,
    builder: (ctx, scroll) => Container(
      decoration: const BoxDecoration(
        color: Bk.bg2,
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      padding: EdgeInsets.only(bottom: MediaQuery.of(ctx).viewInsets.bottom),
      child: ListView(
        controller: scroll,
        padding: const EdgeInsets.fromLTRB(18, 10, 18, 28),
        children: [
          Center(
            child: Container(
                width: 42, height: 4,
                decoration: BoxDecoration(
                    color: Bk.border, borderRadius: BorderRadius.circular(4))),
          ),
          const SizedBox(height: 8),
          Row(children: [
            IconButton(
              icon: const Icon(Icons.arrow_back_rounded, color: Bk.text),
              tooltip: 'Back',
              onPressed: () => Navigator.of(context).pop(),
            ),
            Expanded(
              child: Text(title,
                  style: const TextStyle(
                      fontSize: 19, fontWeight: FontWeight.w900, color: Bk.text)),
            ),
            if (headerTrailing != null) headerTrailing,
          ]),
          const SizedBox(height: 6),
          ...children(scroll),
        ],
      ),
    ),
  );
}

/// Open the Blockshot buy/sell sheet for a token by its contract id — used
/// from the wallet page's owned-token rows. Fetches the live pool + metadata;
/// shows a short notice if the token has no AMM pool yet.
Future<void> openBlockshotTrade(BuildContext context, String contractId,
    {VoidCallback? onTraded}) async {
  final app = context.read<AppState>();
  final pools = await app.chain.pools();
  Map<String, dynamic>? pool;
  for (final p in pools) {
    if ('${p['token']}' == contractId) { pool = p; break; }
  }
  if (pool == null) {
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('No trading pool for this token yet.')));
    }
    return;
  }
  Map<String, dynamic>? meta;
  try {
    final base = app.chain.apiBase.replaceFirst(RegExp(r'/explorer$'), '');
    final r = await http.get(Uri.parse('$base/dex/tokens')).timeout(const Duration(seconds: 8));
    if (r.statusCode == 200) {
      final j = (jsonDecode(r.body) as Map).cast<String, dynamic>();
      if (j[contractId] is Map) meta = (j[contractId] as Map).cast<String, dynamic>();
    }
  } catch (_) {}
  if (!context.mounted) return;
  showModalBottomSheet(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (_) => _TokenSheet(pool: pool!, meta: meta, onTraded: onTraded ?? () {}),
  );
}

/// The live BLOCK price of a token by contract id, from its pool (0 if none).
double blockshotPriceOf(List<Map<String, dynamic>> pools, String contractId) {
  for (final p in pools) {
    if ('${p['token']}' == contractId) return _poolPrice(p);
  }
  return 0;
}

/* ========================= TOKEN DETAIL + TRADE ========================= */

class _TokenSheet extends StatefulWidget {
  const _TokenSheet({required this.pool, this.meta, required this.onTraded});
  final Map<String, dynamic> pool;
  final Map<String, dynamic>? meta;
  final VoidCallback onTraded;
  @override
  State<_TokenSheet> createState() => _TokenSheetState();
}

class _TokenSheetState extends State<_TokenSheet> {
  bool _buy = true;
  bool _busy = false;
  String? _error;
  String? _okTxid;
  double _okAmount = 0;
  final _amt = TextEditingController();
  bool _confetti = false;
  double? _tokBal; // the user's REAL WORLD/token balance (whole units)

  @override
  void initState() {
    super.initState();
    _loadBalance();
  }

  Future<void> _loadBalance() async {
    final app = context.read<AppState>();
    final addr = app.store.address;
    if (addr == null) return;
    final info = await app.chain.token(_token, holder: addr);
    final raw = info?['balance'];
    if (!mounted || raw == null) return;
    final n = (raw is num) ? raw.toDouble() : (double.tryParse('$raw') ?? 0);
    setState(() => _tokBal = n / math.pow(10, _dec));
  }

  // ---- UGC moderation (App Store Guideline 1.2) --------------------------
  Future<void> _report() async {
    final reasons = ['Spam or scam', 'Hateful or abusive', 'Sexual content',
      'Impersonation', 'Other'];
    final reason = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: Bk.bg2,
      builder: (bctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Padding(
            padding: EdgeInsets.all(16),
            child: Text('Report this token',
                style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
          ),
          for (final r in reasons)
            ListTile(title: Text(r), onTap: () => Navigator.of(bctx).pop(r)),
          const SizedBox(height: 8),
        ]),
      ),
    );
    if (reason == null || !mounted) return;
    final origin = Uri.parse(context.read<AppState>().chain.apiBase).origin;
    await _BlockshotModeration.report(origin, _token, _sym, reason);
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('Thanks — reported to Blockle for review.')));
  }

  Future<void> _hide() async {
    await _BlockshotModeration.hide(_token);
    if (!mounted) return;
    widget.onTraded(); // board re-filters hidden tokens on refresh
    Navigator.of(context).pop();
    ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('$_sym hidden — you won\'t see it again.')));
  }

  Map<String, dynamic> get p => widget.pool;
  String get _sym => '${p['symbol'] ?? '?'}';
  String get _token => '${p['token']}';
  int get _dec => (p['decimals'] as num?)?.toInt() ?? 0;
  double get _blockRes => ((p['blockReserve'] as num?) ?? 0) / _coin;
  double get _tokRes => ((p['tokenReserve'] as num?) ?? 0) / math.pow(10, _dec);
  double get _px => _poolPrice(p);
  String? get _logo => widget.meta?['logo'] as String?;
  String get _description => '${widget.meta?['description'] ?? ''}';
  List<String> get _links =>
      ((widget.meta?['links'] as List?) ?? const []).map((e) => '$e').toList();

  double _out(double amt, double inRes, double outRes) {
    if (amt <= 0 || inRes <= 0 || outRes <= 0) return 0;
    final ain = amt * (1 - _ammFee);
    return outRes * ain / (inRes + ain);
  }

  double get _amountIn => double.tryParse(_amt.text.trim()) ?? 0;
  double get _estOut =>
      _buy ? _out(_amountIn, _blockRes, _tokRes) : _out(_amountIn, _tokRes, _blockRes);

  Future<void> _trade() async {
    final app = context.read<AppState>();
    if (_amountIn <= 0) {
      setState(() => _error = 'Enter an amount.');
      return;
    }
    if (!app.store.isUnlocked) {
      setState(() => _error = 'Wallet is locked — unlock it first.');
      return;
    }
    // Guard: selling more than you hold would SILENTLY no-op on-chain (the
    // pool contract refunds nothing and burns the gas) — refuse up front.
    if (!_buy && _tokBal != null && _amountIn > _tokBal! + 1e-9) {
      setState(() => _error =
          'You only hold ${_fmtB(_tokBal!, max: 6)} $_sym — lower the amount.');
      return;
    }
    final out = _estOut;
    final BigInt amountIn = _buy
        ? BigInt.from((_amountIn * _coin).round())
        : BigInt.from((_amountIn * math.pow(10, _dec)).round());
    final BigInt minOut = _buy
        ? BigInt.from((out * (1 - _slip) * math.pow(10, _dec)).floor())
        : BigInt.from((out * (1 - _slip) * _coin).floor());
    setState(() {
      _busy = true;
      _error = null;
      _okTxid = null;
    });
    try {
      // SAME one security gate as every value move (inspection + confirm sheet).
      final approved = await reviewSend(
        context,
        chain: 'block',
        to: _token,
        amount: amountIn.toString(),
        asset: _buy
            ? const {'chain': 'block', 'kind': 'native', 'symbol': 'BLOCK', 'decimals': 8}
            : {'chain': 'block', 'kind': 'block20', 'symbol': _sym, 'address': _token, 'decimals': _dec},
        title: 'Review swap',
        previewHeader: _buy ? 'Buy $_sym with BLOCK' : 'Sell $_sym for BLOCK',
        resolvedAddress: shortSendAddr(_token),
      );
      if (!mounted) return;
      if (!approved) {
        setState(() {
          _busy = false;
          _error = 'Cancelled — nothing was signed.';
        });
        return;
      }
      final addr = app.store.address!;
      final u = await app.chain.utxos(addr);
      final utxos = (u?['utxos'] as List?) ?? [];
      if (utxos.isEmpty) throw Exception('no spendable UTXOs for gas');
      final built = _buy
          ? await app.store.buildPoolSwapBuy(
              jsonEncode(utxos), _token, amountIn.toString(), minOut.toString(), 200000, 10)
          : await app.store.buildPoolSwapSell(
              jsonEncode(utxos), _token, amountIn.toString(), minOut.toString(), 200000, 10);
      final raw = built['raw'] as String?;
      if (raw == null) throw Exception('could not build swap');
      final res = await app.chain.submit(raw);
      final txid = (res is Map ? (res['txid'] ?? built['txid']) : built['txid']).toString();
      await app.addPending(txid, _buy ? 'Buy $_sym' : 'Sell $_sym');
      HapticFeedback.heavyImpact();
      setState(() {
        _busy = false;
        _okTxid = txid;
        _okAmount = out;
        _confetti = true;
        _amt.clear();
      });
      widget.onTraded();
      Future.delayed(const Duration(seconds: 12), _loadBalance); // refresh after it confirms
      Future.delayed(const Duration(milliseconds: 1800), () {
        if (mounted) setState(() => _confetti = false);
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e.toString().replaceFirst('Exception: ', '');
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final hist = _spark[_token] ?? const <double>[];
    final up = hist.length >= 2 && hist.last >= hist.first;
    return Stack(children: [
      _sheetShell(
        context,
        title: _sym,
        headerTrailing: Row(mainAxisSize: MainAxisSize.min, children: [
          _tokenAvatar(_sym, _logo),
          PopupMenuButton<String>(
            icon: const Icon(Icons.more_vert, color: Bk.muted),
            tooltip: 'More',
            onSelected: (v) {
              if (v == 'report') _report();
              if (v == 'hide') _hide();
            },
            itemBuilder: (_) => const [
              PopupMenuItem(value: 'report', child: Text('Report token')),
              PopupMenuItem(value: 'hide', child: Text('Hide this token')),
            ],
          ),
        ]),
        children: (_) => [
          Row(children: [
            Expanded(
              child: Text('${p['name'] ?? 'BLOCK-20'}',
                  style: const TextStyle(fontSize: 12, color: Bk.muted)),
            ),
            Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
              Text('${_fmtB(_px)} BLOCK',
                  style: TextStyle(
                      fontSize: 17,
                      fontWeight: FontWeight.w900,
                      color: up ? Bk.good : Bk.bad,
                      fontFeatures: const [FontFeature.tabularFigures()])),
              const Text('per token', style: TextStyle(fontSize: 10.5, color: Bk.faint)),
            ]),
          ]),
          if (_description.isNotEmpty) ...[
            const SizedBox(height: 10),
            Text(_description,
                style: const TextStyle(fontSize: 12.5, color: Bk.muted, height: 1.45)),
          ],
          if (_links.isNotEmpty) ...[
            const SizedBox(height: 10),
            Wrap(spacing: 8, runSpacing: 8, children: [
              for (final l in _links) _linkChip(l),
            ]),
          ],
          const SizedBox(height: 14),
          if (hist.length >= 2)
            SizedBox(
              height: 64,
              child: CustomPaint(
                size: Size.infinite,
                painter: _SparkPainter(hist, up ? Bk.good : Bk.bad),
              ),
            ),
          const SizedBox(height: 14),
          Row(children: [
            Expanded(child: _poolStat('Liquidity', '${_fmtB(_blockRes * 2, max: 2)} BLOCK')),
            const SizedBox(width: 8),
            Expanded(child: _poolStat('Pool $_sym', _fmtB(_tokRes, max: 2))),
            const SizedBox(width: 8),
            Expanded(
                child: _poolStat(
                    'LP lock',
                    (((p['lockedUntil'] as num?)?.toInt() ?? 0) >
                            ((p['height'] as num?)?.toInt() ?? 0))
                        ? 'LOCKED'
                        : 'open')),
          ]),
          const SizedBox(height: 16),
          Row(children: [
            Expanded(child: _sideBtn('BUY', true, Bk.good)),
            const SizedBox(width: 8),
            Expanded(child: _sideBtn('SELL', false, Bk.bad)),
          ]),
          const SizedBox(height: 12),
          TextField(
            controller: _amt,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            onChanged: (_) => setState(() {}),
            style: const TextStyle(
                fontSize: 22, fontWeight: FontWeight.w800, color: Bk.text),
            decoration: InputDecoration(
              hintText: '0.0',
              suffixText: _buy ? 'BLOCK' : _sym,
              suffixStyle: const TextStyle(color: Bk.muted, fontWeight: FontWeight.w700),
              filled: true,
              fillColor: Bk.surface,
              border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(14), borderSide: BorderSide.none),
            ),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              for (final v in _buy ? [10, 50, 250] : [25, 50, 100])
                Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: ActionChip(
                    backgroundColor: Bk.surface,
                    side: const BorderSide(color: Bk.border),
                    label: Text(_buy ? '$v BLOCK' : '$v%',
                        style: const TextStyle(fontSize: 11.5, color: Bk.text)),
                    onPressed: () {
                      HapticFeedback.selectionClick();
                      if (_buy) {
                        _amt.text = '$v';
                      } else {
                        // % of YOUR balance (minus a hair at 100% so rounding
                        // can't exceed it) — never the pool reserve.
                        final bal = _tokBal ?? 0;
                        final amt = v >= 100 ? bal * 0.999 : bal * v / 100;
                        _amt.text = _fmtB(amt, max: 6);
                      }
                      setState(() {});
                    },
                  ),
                ),
            ],
          ),
          const SizedBox(height: 6),
          if (!_buy)
            Text('Your balance: ${_tokBal == null ? '…' : _fmtB(_tokBal!, max: 6)} $_sym',
                style: const TextStyle(fontSize: 11.5, color: Bk.faint)),
          Text(
            _amountIn > 0
                ? (_buy
                    ? 'You receive about ${_fmtB(_estOut)} $_sym'
                    : 'You receive about ${_fmtB(_estOut)} BLOCK')
                : 'Quotes walk the live pool curve — big orders move the price.',
            style: const TextStyle(fontSize: 12, color: Bk.muted),
          ),
          const SizedBox(height: 12),
          FilledButton(
            onPressed: _busy ? null : _trade,
            style: FilledButton.styleFrom(
                backgroundColor: _buy ? Bk.good : Bk.bad,
                minimumSize: const Size.fromHeight(52)),
            child: Text(
                _busy ? 'Working…' : (_buy ? 'BUY $_sym' : 'SELL $_sym'),
                style: const TextStyle(
                    fontWeight: FontWeight.w900, fontSize: 15, color: Colors.white)),
          ),
          if (_okTxid != null) ...[
            const SizedBox(height: 10),
            Container(
              padding: const EdgeInsets.all(11),
              decoration: BoxDecoration(
                color: Bk.good.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: Bk.good.withValues(alpha: 0.4)),
              ),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(
                    '${_buy ? "Bought" : "Sold"} — about ${_fmtB(_okAmount)} ${_buy ? _sym : "BLOCK"} incoming once the block confirms.',
                    style: const TextStyle(color: Bk.good, fontSize: 12.5)),
                const SizedBox(height: 6),
                Row(children: [
                  TextButton(
                    onPressed: () => openExternal('https://blockle.org/tx/$_okTxid'),
                    child: const Text('View on explorer',
                        style: TextStyle(color: Bk.accent2, fontSize: 12)),
                  ),
                  TextButton(
                    onPressed: () => Navigator.of(context).push(
                        MaterialPageRoute(builder: (_) => const QueueScreen())),
                    child: const Text('Track in queue',
                        style: TextStyle(color: Bk.accent2, fontSize: 12)),
                  ),
                ]),
              ]),
            ),
          ],
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(_error!, style: const TextStyle(color: Bk.bad, fontSize: 12.5)),
          ],
        ],
      ),
      if (_confetti) const Positioned.fill(child: IgnorePointer(child: _Confetti())),
    ]);
  }

  Widget _linkChip(String url) {
    final b = _linkBrand(url);
    return ActionChip(
      backgroundColor: Bk.surface,
      side: const BorderSide(color: Bk.border),
      avatar: b.icon != null
          ? Icon(b.icon, size: 15, color: Bk.accent2)
          : const Text('X',
              style: TextStyle(
                  color: Bk.accent2, fontWeight: FontWeight.w900, fontSize: 13)),
      label: Text(b.label, style: const TextStyle(fontSize: 11.5, color: Bk.text)),
      onPressed: () => openExternal(url),
    );
  }

  Widget _sideBtn(String label, bool buy, Color c) {
    final sel = _buy == buy;
    return GestureDetector(
      onTap: () {
        HapticFeedback.selectionClick();
        setState(() => _buy = buy);
      },
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 180),
        padding: const EdgeInsets.symmetric(vertical: 12),
        decoration: BoxDecoration(
          color: sel ? c.withValues(alpha: 0.18) : Bk.surface,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: sel ? c : Bk.border, width: sel ? 1.6 : 1),
        ),
        alignment: Alignment.center,
        child: Text(label,
            style: TextStyle(
                fontWeight: FontWeight.w900,
                letterSpacing: 1.2,
                color: sel ? c : Bk.muted)),
      ),
    );
  }

  Widget _poolStat(String l, String v) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
        decoration: BoxDecoration(
          color: Bk.surface,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: Bk.border),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(l, style: const TextStyle(fontSize: 10, color: Bk.faint)),
          const SizedBox(height: 2),
          Text(v,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                  fontSize: 12.5, fontWeight: FontWeight.w700, color: Bk.text)),
        ]),
      );
}

/* ============================= LAUNCH SHEET ============================= */

class _LaunchSheet extends StatefulWidget {
  const _LaunchSheet({required this.onLaunched});
  final VoidCallback onLaunched;
  @override
  State<_LaunchSheet> createState() => _LaunchSheetState();
}

class _LaunchSheetState extends State<_LaunchSheet> {
  final _name = TextEditingController();
  final _sym = TextEditingController();
  final _supply = TextEditingController(text: '1000000');
  final _desc = TextEditingController();
  final List<TextEditingController> _links = [TextEditingController()];
  // Pool seed in BLOCK — LOG-scale slider from the 0.1 BLOCK minimum to 500.
  double _seedT = 0.65; // slider position 0..1
  double get _seedBlock => 0.1 * math.pow(5000, _seedT).toDouble();
  int get _seedBlockBase => (_seedBlock * _coin).round();
  double _seedPct = 50; // % of supply into the pool
  bool _busy = false;
  String? _error;
  String? _okTxid;
  bool _confetti = false;
  Uint8List? _imageBytes;
  String? _imageMime;

  int get _supplyN => int.tryParse(_supply.text.trim()) ?? 0;
  int get _seedTok => (_supplyN * _seedPct / 100).floor();
  double get _startPx => _seedTok > 0 ? _seedBlock / _seedTok : 0;

  Future<void> _pickImage() async {
    try {
      final x = await ImagePicker().pickImage(
          source: ImageSource.gallery, maxWidth: 512, maxHeight: 512, imageQuality: 82);
      if (x == null) return;
      final bytes = await x.readAsBytes();
      if (bytes.length > 300 * 1024) {
        setState(() => _error = 'Image too large — pick something under 300 KB.');
        return;
      }
      setState(() {
        _imageBytes = bytes;
        _imageMime = (x.name.toLowerCase().endsWith('.png')) ? 'image/png' : 'image/jpeg';
        _error = null;
      });
    } catch (e) {
      setState(() => _error = 'Could not pick an image: $e');
    }
  }

  List<String> get _cleanLinks => _links
      .map((c) => c.text.trim())
      .where((l) => l.isNotEmpty)
      .map((l) => l.startsWith('http') ? l : 'https://$l')
      .where((l) => l.startsWith('https://'))
      .take(8)
      .toList();

  /// After the launch broadcasts, find the new token id (by symbol, newest
  /// pool) and register its off-chain metadata. Polls fail-soft for ~4 min.
  Future<void> _registerMeta(AppState app, String sym) async {
    final base = app.chain.apiBase.replaceFirst(RegExp(r'/explorer$'), '');
    final body = <String, dynamic>{
      if (_imageBytes != null)
        'logoData': 'data:$_imageMime;base64,${base64Encode(_imageBytes!)}',
      'description': _desc.text.trim(),
      'links': _cleanLinks,
    };
    for (var i = 0; i < 12; i++) {
      await Future.delayed(const Duration(seconds: 20));
      try {
        final pools = await app.chain.pools();
        Map<String, dynamic>? match;
        for (final p in pools) {
          if ('${p['symbol']}'.toUpperCase() == sym) {
            if (match == null ||
                ((p['createdHeight'] as num?) ?? 0) >
                    ((match['createdHeight'] as num?) ?? 0)) {
              match = p;
            }
          }
        }
        if (match == null) continue;
        await http
            .post(Uri.parse('$base/dex/register'),
                headers: {'content-type': 'application/json'},
                body: jsonEncode({'token': match['token'], ...body}))
            .timeout(const Duration(seconds: 15));
        widget.onLaunched();
        return;
      } catch (_) {/* retry */}
    }
  }

  Future<void> _launch() async {
    final app = context.read<AppState>();
    final name = _name.text.trim();
    final sym = _sym.text.trim().toUpperCase();
    if (name.isEmpty || sym.isEmpty) {
      setState(() => _error = 'Name and ticker are required.');
      return;
    }
    if (sym.length > 8) {
      setState(() => _error = 'Ticker must be 8 characters or fewer.');
      return;
    }
    if (_supplyN <= 0 || _seedTok <= 0) {
      setState(() => _error = 'Supply and pool seed must be above zero.');
      return;
    }
    if (!app.store.isUnlocked) {
      setState(() => _error = 'Wallet is locked — unlock it first.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final seedBase = BigInt.from(_seedBlockBase);
      final approved = await reviewSend(
        context,
        chain: 'block',
        to: app.store.address!,
        amount: seedBase.toString(),
        asset: const {'chain': 'block', 'kind': 'native', 'symbol': 'BLOCK', 'decimals': 8},
        title: 'Review launch',
        previewHeader:
            'Launch $sym — seed ${_fmtB(_seedBlock, max: 2)} BLOCK + $_seedTok $sym into its pool',
        resolvedAddress: 'new $sym pool (atomic launch)',
      );
      if (!mounted) return;
      if (!approved) {
        setState(() {
          _busy = false;
          _error = 'Cancelled — nothing was signed.';
        });
        return;
      }
      final addr = app.store.address!;
      final u = await app.chain.utxos(addr);
      final utxos = (u?['utxos'] as List?) ?? [];
      if (utxos.isEmpty) throw Exception('no spendable UTXOs — fund your BLOCK address first');
      final built = await app.store.buildLaunchToken(
          jsonEncode(utxos), name, sym, 8, _supplyN, _seedBlockBase, _seedTok, 2000000, 10);
      final raw = built['raw'] as String?;
      if (raw == null) throw Exception('could not build the launch');
      final res = await app.chain.submit(raw);
      final txid = (res is Map ? (res['txid'] ?? built['txid']) : built['txid']).toString();
      await app.addPending(txid, 'Launch $sym');
      HapticFeedback.heavyImpact();
      setState(() {
        _busy = false;
        _okTxid = txid;
        _confetti = true;
      });
      widget.onLaunched();
      // Image/description/links are cosmetics registered once the pool appears.
      if (_imageBytes != null || _desc.text.trim().isNotEmpty || _cleanLinks.isNotEmpty) {
        unawaited(_registerMeta(app, sym));
      }
      Future.delayed(const Duration(milliseconds: 2200), () {
        if (mounted) setState(() => _confetti = false);
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e.toString().replaceFirst('Exception: ', '');
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Stack(children: [
      _sheetShell(
        context,
        title: 'Launch a token',
        headerTrailing: const Icon(Icons.rocket_launch_rounded, color: Bk.accent, size: 22),
        children: (_) => [
          const Text(
              'One signed transaction deploys your BLOCK-20, mints the supply, and opens its trading pool. Live on the board the moment it confirms.',
              style: TextStyle(fontSize: 12, color: Bk.muted, height: 1.4)),
          const SizedBox(height: 16),
          // Optional token image (shown as the logo on the board + token page).
          Row(children: [
            GestureDetector(
              onTap: _pickImage,
              child: Container(
                width: 64,
                height: 64,
                decoration: BoxDecoration(
                  color: Bk.surface,
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(color: Bk.border),
                  image: _imageBytes != null
                      ? DecorationImage(image: MemoryImage(_imageBytes!), fit: BoxFit.cover)
                      : null,
                ),
                child: _imageBytes == null
                    ? const Icon(Icons.add_photo_alternate_outlined, color: Bk.muted)
                    : null,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                const Text('Token image (optional)',
                    style: TextStyle(
                        fontSize: 12.5, fontWeight: FontWeight.w700, color: Bk.text)),
                Text(
                    _imageBytes == null
                        ? 'Square works best — shown on the board and token page.'
                        : 'Looks good. Tap to change.',
                    style: const TextStyle(fontSize: 11, color: Bk.muted)),
                if (_imageBytes != null)
                  TextButton(
                    onPressed: () => setState(() => _imageBytes = null),
                    style: TextButton.styleFrom(padding: EdgeInsets.zero),
                    child: const Text('Remove',
                        style: TextStyle(color: Bk.bad, fontSize: 11.5)),
                  ),
              ]),
            ),
          ]),
          const SizedBox(height: 12),
          _field('Name', _name, hint: 'Moon Rocket'),
          const SizedBox(height: 10),
          _field('Ticker', _sym, hint: 'MOON', caps: true),
          const SizedBox(height: 10),
          _field('Total supply', _supply, hint: '1000000', number: true),
          const SizedBox(height: 10),
          _field('Description (optional)', _desc,
              hint: 'What is this token about?', lines: 3),
          const SizedBox(height: 12),
          const Text('Links (optional)',
              style:
                  TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: Bk.text)),
          const SizedBox(height: 6),
          for (var i = 0; i < _links.length; i++) ...[
            Row(children: [
              // Brand icon auto-detects X / Telegram / Discord as they type.
              SizedBox(
                width: 30,
                child: Builder(builder: (_) {
                  final b = _linkBrand(_links[i].text);
                  return b.icon != null
                      ? Icon(b.icon, size: 18, color: Bk.accent2)
                      : const Center(
                          child: Text('X',
                              style: TextStyle(
                                  color: Bk.accent2,
                                  fontWeight: FontWeight.w900,
                                  fontSize: 15)));
                }),
              ),
              const SizedBox(width: 6),
              Expanded(
                child: _field('', _links[i],
                    hint: i == 0 ? 'https://yourtoken.xyz' : 'https://…', dense: true),
              ),
              if (_links.length > 1)
                IconButton(
                  icon: const Icon(Icons.close_rounded, size: 18, color: Bk.muted),
                  onPressed: () => setState(() => _links.removeAt(i)),
                ),
            ]),
            const SizedBox(height: 6),
          ],
          if (_links.length < 8)
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                onPressed: () => setState(() => _links.add(TextEditingController())),
                icon: const Icon(Icons.add_rounded, size: 17, color: Bk.accent2),
                label: const Text('Add link',
                    style: TextStyle(color: Bk.accent2, fontSize: 12.5)),
              ),
            ),
          const SizedBox(height: 10),
          Text('Pool seed — ${_fmtB(_seedBlock, max: 2)} BLOCK  (min 0.1)',
              style: const TextStyle(
                  fontSize: 12.5, fontWeight: FontWeight.w700, color: Bk.text)),
          // Logarithmic: equal slider travel multiplies the seed, so 0.1, 1,
          // 10 and 100 BLOCK are all easy to hit precisely.
          Slider(
            value: _seedT,
            min: 0,
            max: 1,
            activeColor: Bk.accent,
            onChanged: (v) => setState(() => _seedT = v),
          ),
          Text('Supply into the pool — ${_seedPct.round()}%  (you keep ${100 - _seedPct.round()}%)',
              style: const TextStyle(
                  fontSize: 12.5, fontWeight: FontWeight.w700, color: Bk.text)),
          Slider(
            value: _seedPct,
            min: 10,
            max: 100,
            divisions: 90,
            activeColor: Bk.accent2,
            onChanged: (v) => setState(() => _seedPct = v),
          ),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: Bk.surface,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: Bk.border),
            ),
            child: Column(children: [
              _kv('Starting price',
                  '${_fmtB(_startPx)} BLOCK per ${_sym.text.trim().isEmpty ? "token" : _sym.text.trim().toUpperCase()}'),
              _kv('Pool opens with', '${_fmtB(_seedBlock, max: 2)} BLOCK + $_seedTok tokens'),
              _kv('You keep', '${_supplyN - _seedTok} tokens'),
              _kv('Cost', '${_fmtB(_seedBlock, max: 2)} BLOCK + gas'),
            ]),
          ),
          const SizedBox(height: 14),
          FilledButton(
            onPressed: _busy ? null : _launch,
            style: FilledButton.styleFrom(
                backgroundColor: Bk.accent, minimumSize: const Size.fromHeight(52)),
            child: Text(_busy ? 'Launching…' : 'LAUNCH IT',
                style: const TextStyle(
                    fontWeight: FontWeight.w900, fontSize: 15, color: Colors.white)),
          ),
          if (_okTxid != null) ...[
            const SizedBox(height: 10),
            Container(
              padding: const EdgeInsets.all(11),
              decoration: BoxDecoration(
                color: Bk.good.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: Bk.good.withValues(alpha: 0.4)),
              ),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                const Text(
                    'LAUNCHED — your token hits the board as soon as the next block confirms. Your image and links attach automatically right after.',
                    style: TextStyle(color: Bk.good, fontSize: 12.5, height: 1.4)),
                TextButton(
                  onPressed: () => openExternal('https://blockle.org/tx/$_okTxid'),
                  style: TextButton.styleFrom(padding: EdgeInsets.zero),
                  child: const Text('View on explorer',
                      style: TextStyle(color: Bk.accent2, fontSize: 12)),
                ),
              ]),
            ),
          ],
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(_error!, style: const TextStyle(color: Bk.bad, fontSize: 12.5)),
          ],
        ],
      ),
      if (_confetti) const Positioned.fill(child: IgnorePointer(child: _Confetti())),
    ]);
  }

  Widget _field(String label, TextEditingController c,
      {String? hint, bool number = false, bool caps = false, int lines = 1, bool dense = false}) {
    return TextField(
      controller: c,
      keyboardType: number ? TextInputType.number : TextInputType.text,
      textCapitalization: caps ? TextCapitalization.characters : TextCapitalization.none,
      maxLines: lines,
      onChanged: (_) => setState(() {}),
      style: const TextStyle(color: Bk.text, fontWeight: FontWeight.w600),
      decoration: InputDecoration(
        labelText: label.isEmpty ? null : label,
        hintText: hint,
        isDense: dense,
        labelStyle: const TextStyle(color: Bk.muted, fontSize: 12.5),
        filled: true,
        fillColor: Bk.surface,
        border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12), borderSide: BorderSide.none),
      ),
    );
  }

  Widget _kv(String k, String v) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Row(children: [
          Text(k, style: const TextStyle(fontSize: 12, color: Bk.muted)),
          const Spacer(),
          Flexible(
              child: Text(v,
                  textAlign: TextAlign.right,
                  style: const TextStyle(
                      fontSize: 12, fontWeight: FontWeight.w700, color: Bk.text))),
        ]),
      );
}

/* ============================== EYE CANDY ============================== */

class _SparkPainter extends CustomPainter {
  _SparkPainter(this.points, this.color);
  final List<double> points;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    if (points.length < 2) return;
    final lo = points.reduce(math.min), hi = points.reduce(math.max);
    final span = (hi - lo) == 0 ? 1.0 : (hi - lo);
    final path = Path();
    for (var i = 0; i < points.length; i++) {
      final x = i / (points.length - 1) * size.width;
      final y = size.height - ((points[i] - lo) / span) * (size.height - 6) - 3;
      i == 0 ? path.moveTo(x, y) : path.lineTo(x, y);
    }
    final fill = Path.from(path)
      ..lineTo(size.width, size.height)
      ..lineTo(0, size.height)
      ..close();
    canvas.drawPath(
        fill,
        Paint()
          ..shader = LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [color.withValues(alpha: 0.25), color.withValues(alpha: 0.0)],
          ).createShader(Offset.zero & size));
    canvas.drawPath(
        path,
        Paint()
          ..color = color
          ..strokeWidth = 2
          ..style = PaintingStyle.stroke
          ..strokeCap = StrokeCap.round);
    final lastY =
        size.height - ((points.last - lo) / span) * (size.height - 6) - 3;
    canvas.drawCircle(Offset(size.width, lastY), 3.2, Paint()..color = color);
  }

  @override
  bool shouldRepaint(_SparkPainter old) =>
      old.points.length != points.length || old.color != color;
}

/// Lightweight confetti burst — no packages, respects reduced motion.
class _Confetti extends StatefulWidget {
  const _Confetti();
  @override
  State<_Confetti> createState() => _ConfettiState();
}

class _ConfettiState extends State<_Confetti> with SingleTickerProviderStateMixin {
  late final AnimationController _c;
  late final List<_Particle> _parts;

  @override
  void initState() {
    super.initState();
    final rnd = math.Random();
    _parts = List.generate(60, (_) => _Particle(rnd));
    _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1800))
      ..forward();
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (MediaQuery.of(context).disableAnimations) return const SizedBox.shrink();
    return AnimatedBuilder(
      animation: _c,
      builder: (_, __) => CustomPaint(
        size: Size.infinite,
        painter: _ConfettiPainter(_parts, _c.value),
      ),
    );
  }
}

class _Particle {
  _Particle(math.Random r)
      : x = r.nextDouble(),
        vx = (r.nextDouble() - 0.5) * 0.6,
        vy = 0.5 + r.nextDouble() * 1.1,
        size = 4 + r.nextDouble() * 5,
        spin = r.nextDouble() * 6.3,
        color = [Bk.accent, Bk.accent2, Bk.good, const Color(0xFFFFD166)][r.nextInt(4)];
  final double x, vx, vy, size, spin;
  final Color color;
}

class _ConfettiPainter extends CustomPainter {
  _ConfettiPainter(this.parts, this.t);
  final List<_Particle> parts;
  final double t;

  @override
  void paint(Canvas canvas, Size size) {
    for (final p in parts) {
      final px = (p.x + p.vx * t) * size.width;
      final py = (-0.05 + p.vy * t * t) * size.height;
      if (py > size.height) continue;
      final paint = Paint()..color = p.color.withValues(alpha: (1 - t).clamp(0.0, 1.0));
      canvas.save();
      canvas.translate(px, py);
      canvas.rotate(p.spin + t * 6);
      canvas.drawRRect(
          RRect.fromRectAndRadius(
              Rect.fromCenter(center: Offset.zero, width: p.size, height: p.size * 0.6),
              const Radius.circular(1.5)),
          paint);
      canvas.restore();
    }
  }

  @override
  bool shouldRepaint(_ConfettiPainter old) => old.t != t;
}
