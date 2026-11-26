// screens/exchange/exchange_ui.dart — the pieces every exchange section shares.
//
// THE INVARIANTS THESE WIDGETS EXIST TO ENFORCE are the ones exchange.js is
// built around (exchange.js:8-28), and they are all about a custodial venue
// that holds real money:
//
//   * unknown renders as an EM DASH, never as 0;
//   * a failed list prints its error INSIDE the list — an empty table reads as
//     "you have nothing", which is a lie about someone's money;
//   * a closed chain or a refused action shows the server's REASON, never a
//     blank;
//   * the LIVE badge fails closed: TESTNET unless /public/status says live.
//
// They are widgets rather than conventions so a later section cannot forget.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../state/exchange_controller.dart';
import '../../theme.dart';
import '../account_auth_screen.dart';
import 'section_table.dart';

/// Unknown. Not zero, not blank, not "0.00".
const String kEmDash = '—';

/// Render a figure the venue may not have: null becomes an em dash.
String fig(Object? v) {
  if (v == null) return kEmDash;
  final s = v.toString().trim();
  return s.isEmpty ? kEmDash : s;
}

/// A PRICE OR SIZE AS THE VENUE WROTE IT, falling back to the parsed number
/// only when the string is missing.
///
/// THIS IS NOT COSMETIC. `Object.toString()` on a Dart double goes exponential
/// below 1e-6, so a venue price of `0.00000012` — the live quote on every
/// BLOCK-quoted cheap coin, all of which carry 8 decimal places — rendered as
/// `1.2e-7`, and `1234567.00000000` rendered as `1234567.0`. The tape printed
/// the venue's string while the header two lines above printed the exponential
/// for the SAME price. Every display of a price or a size goes through here or
/// through [exFixed]; nothing renders a bare `num`.
String figStr(String? text, [Object? numeric]) {
  final t = text?.trim();
  if (t != null && t.isNotEmpty) return t;
  if (numeric is num) return exFixed(numeric, 8);
  return fig(numeric);
}

/// A COMPUTED figure — a mid, an order value, a fee estimate — as fixed point.
///
/// Never exponential and never a float's full 17 digits: `(a + b) / 2` on two
/// 8-place prices produces `1.2000000000000002e-7`, which is not a price anyone
/// can read or check. [decimals] is the market's own scale, so the figure comes
/// out in the same shape the venue publishes.
String exFixed(num? v, int decimals) {
  if (v == null) return kEmDash;
  final d = decimals < 0 ? 0 : (decimals > 18 ? 18 : decimals);
  final s = v.toDouble();
  if (s.isNaN || s.isInfinite) return kEmDash;
  return s.toStringAsFixed(d);
}

enum ExTone { plain, good, warn, bad }

Color _toneBg(ExTone t) => switch (t) {
      ExTone.good => const Color(0x224ADE80),
      ExTone.warn => const Color(0x22F5A524),
      ExTone.bad => const Color(0x22FB7185),
      ExTone.plain => Bk.surface,
    };

Color toneColor(ExTone t) => switch (t) {
      ExTone.good => Bk.good,
      ExTone.warn => Bk.warn,
      ExTone.bad => Bk.bad,
      ExTone.plain => Bk.muted,
    };

/// The section-content card. One radius, one border, four tones.
class ExCard extends StatelessWidget {
  const ExCard({super.key, required this.child, this.tone = ExTone.plain, this.padding});
  final Widget child;
  final ExTone tone;
  final EdgeInsetsGeometry? padding;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: padding ?? const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: _toneBg(tone),
        borderRadius: BorderRadius.circular(Bk.rMd),
        border: Border.all(
            color: tone == ExTone.plain ? Bk.border : toneColor(tone).withValues(alpha: 0.35)),
      ),
      child: child,
    );
  }
}

/// A small state pill: open / filled / confirming / closed.
class ExPill extends StatelessWidget {
  const ExPill(this.text, {super.key, this.tone = ExTone.plain});
  final String text;
  final ExTone tone;

  @override
  Widget build(BuildContext context) {
    final c = toneColor(tone);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: c.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Text(text,
          style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: c)),
    );
  }
}

/// The content pane's own header. The rail's 8-glyph label is a locator; THIS
/// is the title, and it is also where an exact count belongs ("3 waiting to
/// confirm") because the rail only ever draws a dot.
class ExHeader extends StatelessWidget {
  const ExHeader({super.key, required this.title, this.note, this.trailing});
  final String title;
  final String? note;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: Theme.of(context).textTheme.titleLarge),
                if (note != null) ...[
                  const SizedBox(height: 4),
                  Text(note!,
                      style: const TextStyle(fontSize: 12.5, color: Bk.muted, height: 1.35)),
                ],
              ],
            ),
          ),
          if (trailing != null) ...[const SizedBox(width: 10), trailing!],
        ],
      ),
    );
  }
}

/// A section's scrolling body.
///
/// 14pt of left padding, not 16: the rail and its divider already supply the
/// visual gutter, which leaves 299pt of usable content width on a 390pt phone.
/// Every layout in this tab is designed against that number.
class ExBody extends StatelessWidget {
  const ExBody({super.key, required this.children});
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(14, 12, 16, 40),
      children: children,
    );
  }
}

/// A section whose content a later step fills in.
///
/// It names the feature, says plainly that it is not in this build, and lists
/// what will be there — including the gates, where the section moves money. A
/// placeholder that implied the feature was broken, or that a gate might be
/// skippable, would be worse than no placeholder at all.
class ExPlaceholder extends StatelessWidget {
  const ExPlaceholder({
    super.key,
    required this.title,
    required this.summary,
    this.willInclude = const <String>[],
    this.caution,
  });

  final String title;
  final String summary;
  final List<String> willInclude;

  /// A money-moving section's gates, stated here so the absence of the screen
  /// is never read as the absence of the rule.
  final String? caution;

  @override
  Widget build(BuildContext context) {
    return ExBody(children: [
      ExHeader(title: title, note: summary),
      ExCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Row(children: [
            Icon(Icons.construction_outlined, size: 18, color: Bk.muted),
            SizedBox(width: 8),
            Expanded(
              child: Text('Not in this build yet',
                  style: TextStyle(fontWeight: FontWeight.w700)),
            ),
          ]),
          const SizedBox(height: 8),
          const Text(
            'The rail is wired and this section has its place in it; the screen '
            'itself lands in a later step. Nothing here is hidden behind a '
            'paywall or a switch — it simply is not built.',
            style: TextStyle(color: Bk.muted, fontSize: 13, height: 1.4),
          ),
          if (willInclude.isNotEmpty) ...[
            const SizedBox(height: 12),
            const Text('What will be here',
                style: TextStyle(fontSize: 12, letterSpacing: 0.6,
                    fontWeight: FontWeight.w700, color: Bk.faint)),
            const SizedBox(height: 6),
            for (final w in willInclude)
              Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  const Text('· ', style: TextStyle(color: Bk.faint)),
                  Expanded(
                      child: Text(w,
                          style: const TextStyle(
                              fontSize: 13, color: Bk.muted, height: 1.35))),
                ]),
              ),
          ],
        ]),
      ),
      if (caution != null) ...[
        const SizedBox(height: 12),
        ExCard(
          tone: ExTone.warn,
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Icon(Icons.lock_outline, size: 18, color: Bk.warn),
            const SizedBox(width: 8),
            Expanded(
                child: Text(caution!,
                    style: const TextStyle(fontSize: 13, height: 1.4))),
          ]),
        ),
      ],
    ]);
  }
}

/// The signed-out treatment, PER SECTION rather than as the web's full-screen
/// curtain — precisely so the rail stays usable. Markets, Trade (read-only),
/// Fees and Venue work signed out; the account sections show this.
class ExAuthGate extends StatelessWidget {
  const ExAuthGate({super.key, required this.section});
  final ExchangeSection section;

  @override
  Widget build(BuildContext context) {
    return ExBody(children: [
      ExHeader(title: section.name),
      ExCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('This part needs your Blockle account',
              style: TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 6),
          const Text(
            'Markets, prices and reserves are public; balances, orders and '
            'withdrawals need your account. The exchange has no separate '
            'login — it uses the Blockle account this app already signs in to.',
            style: TextStyle(color: Bk.muted, fontSize: 13, height: 1.4),
          ),
          const SizedBox(height: 14),
          FilledButton(
            onPressed: () async {
              final c = context.read<ExchangeController>();
              final ok = await requireAccount(context,
                  reason: 'Sign in to use ${section.name.toLowerCase()} '
                      'on the Blockle exchange.');
              if (ok) await c.loadAccount();
            },
            child: const Text('Sign in'),
          ),
        ]),
      ),
    ]);
  }
}

/// An error that must never degrade to an empty list.
class ExError extends StatelessWidget {
  const ExError({super.key, required this.what, required this.message});

  /// What failed, in the user's terms ("your balance", "the order book").
  final String what;
  final String message;

  @override
  Widget build(BuildContext context) {
    return ExCard(
      tone: ExTone.bad,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('Could not read $what',
            style: const TextStyle(fontWeight: FontWeight.w700)),
        const SizedBox(height: 4),
        Text(message, style: const TextStyle(fontSize: 13, height: 1.4)),
        const SizedBox(height: 4),
        const Text(
          'This is a display problem — it says nothing about your funds.',
          style: TextStyle(fontSize: 12, color: Bk.muted),
        ),
      ]),
    );
  }
}
