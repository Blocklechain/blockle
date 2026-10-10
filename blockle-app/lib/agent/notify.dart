// agent/notify.dart — the injectable pop-up surface for the in-wallet agent
// (Dart side of AGENT-STRATEGIES.md section 8). The agent core never talks to a
// platform notification plugin directly: it calls this small [AgentNotifier]
// interface, so the money logic stays pure, synchronous-testable, and identical
// across the three wallets.
//
//   production (Flutter):  wrap `flutter_local_notifications` (or an in-app
//                          Snackbar) in a [CallbackNotifier] and inject it.
//   tests:                 inject a [RecordingNotifier] and assert on `.sent`.
//
// NOTHING here persists or transmits key material — a notification carries only
// the already-public realized-profit figures (asset, amounts, txid).

/// A single non-blocking message to surface to the user.
class AgentNotification {
  /// The headline, e.g. `+$45.00 — sold 1.5 SOL → USDC`.
  final String title;

  /// Optional second line, e.g. `$180.00 basis → $225.00 proceeds`.
  final String? subtitle;

  /// A short stable tag so a surface can de-dupe/replace (e.g. the txid).
  final String? tag;

  /// The structured payload the UI may use (never keys/seeds).
  final Map<String, dynamic> data;

  const AgentNotification({
    required this.title,
    this.subtitle,
    this.tag,
    this.data = const {},
  });

  @override
  String toString() =>
      subtitle == null ? title : '$title\n$subtitle';
}

/// The surface the agent pops messages through. Inject a real one in production,
/// a fake in tests. `notify` must be non-throwing from the caller's view — the
/// commit path wraps it, but implementations should also fail soft.
abstract class AgentNotifier {
  Future<void> notify(AgentNotification n);
}

/// A notifier backed by a plain closure. Production wiring passes a closure that
/// calls `flutter_local_notifications` (or shows an in-app Snackbar); this keeps
/// the plugin dependency out of the agent core and out of `dart test`.
class CallbackNotifier implements AgentNotifier {
  final void Function(AgentNotification n) _cb;
  const CallbackNotifier(this._cb);

  @override
  Future<void> notify(AgentNotification n) async {
    _cb(n);
  }
}

/// A test double that records every notification instead of showing it.
class RecordingNotifier implements AgentNotifier {
  final List<AgentNotification> sent = [];

  @override
  Future<void> notify(AgentNotification n) async {
    sent.add(n);
  }

  void clear() => sent.clear();
}

/// Format a USD amount as `$1,234.56` (always two decimals, grouped thousands).
/// [sign] prefixes a leading `+`/`-` (used for the realized gain headline).
String formatUsd(num usd, {bool sign = false}) {
  final neg = usd < 0;
  final cents = (usd.abs() * 100).round();
  final whole = cents ~/ 100;
  final frac = (cents % 100).toString().padLeft(2, '0');
  final digits = whole.toString();
  final buf = StringBuffer();
  for (var i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 == 0) buf.write(',');
    buf.write(digits[i]);
  }
  final s = '\$$buf.$frac';
  if (sign) return neg ? '-$s' : '+$s';
  return neg ? '-$s' : s;
}

/// Format a base-unit BigInt as a trimmed decimal using [decimals]. When
/// [decimals] is null we cannot know the scale, so we show the raw base units
/// (never fabricate a decimal point we can't justify).
String formatQty(BigInt baseUnits, {int? decimals}) {
  if (decimals == null || decimals <= 0) return baseUnits.toString();
  final neg = baseUnits.isNegative;
  var s = baseUnits.abs().toString().padLeft(decimals + 1, '0');
  final cut = s.length - decimals;
  var whole = s.substring(0, cut);
  var frac = s.substring(cut).replaceFirst(RegExp(r'0+$'), '');
  final out = frac.isEmpty ? whole : '$whole.$frac';
  return neg ? '-$out' : out;
}

/// Build the realized-profit pop-up from a `realized_profit` event (the exact
/// shape §8 pins: `{asset, soldQty, proceedsUsd, basisUsd, realizedUsd, stable,
/// venue, txid}`). [decimals] is the sold asset's decimals for a human quantity
/// in the copy; omit it and the quantity shows as raw base units.
///
/// Copy (matches the spec example): `+$45.00 — sold 1.5 SOL → USDC`, subtitle
/// `$180.00 basis → $225.00 proceeds`.
AgentNotification realizedProfitNotification(
  Map<String, dynamic> event, {
  int? decimals,
}) {
  final realized = event['realizedUsd'] as num?;
  final asset = '${event['asset'] ?? '?'}';
  final stable = '${event['stable'] ?? 'USDC'}';
  final soldRaw = '${event['soldQty'] ?? '0'}';
  final soldQty = BigInt.tryParse(soldRaw) ?? BigInt.zero;
  final qtyStr = formatQty(soldQty, decimals: decimals);

  // When realized gain is known, lead with it (`+$45.00 — sold 1.5 SOL → USDC`).
  // On the proceeds-only path (requireBasis=false, basis unknown) realizedUsd is
  // null — never claim a `+$0.00` gain; state the sale honestly instead.
  final title = realized != null
      ? '${formatUsd(realized, sign: true)} — sold $qtyStr $asset → $stable'
      : 'Sold $qtyStr $asset → $stable';

  String? subtitle;
  final basis = event['basisUsd'];
  final proceeds = event['proceedsUsd'];
  if (basis is num && proceeds is num) {
    subtitle =
        '${formatUsd(basis)} basis → ${formatUsd(proceeds)} proceeds';
  } else if (proceeds is num) {
    // Unknown basis, proceeds-only (requireBasis=false path).
    subtitle = '${formatUsd(proceeds)} proceeds (basis unknown)';
  }

  return AgentNotification(
    title: title,
    subtitle: subtitle,
    tag: event['txid'] as String?,
    data: Map<String, dynamic>.from(event),
  );
}
