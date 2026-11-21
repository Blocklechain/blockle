// The small set of pieces every shop screen is built from.
//
// WHY THIS FILE EXISTS. theme.dart already defines a careful type scale and a
// violet-biased palette, and the first shop screen ignored all of it —
// `fontSize: 30, color: Colors.white` hardcoded inline. That is how an app
// stops feeling like one app: not through a bad screen, but through five
// screens that each invented their own heading size and their own grey. Every
// widget here reads Theme.of(context) and Bk, and nothing in the shop screens
// should construct a TextStyle from scratch.
//
// It is deliberately a small vocabulary — a page header, a card, a pill, a
// price, an empty state, a field. If a screen needs a sixth thing, it belongs
// here rather than inline in that screen.

import 'package:flutter/material.dart';

import '../theme.dart';
import 'product.dart';

/// A screen's title block. One size, one spacing, everywhere.
class ShopHeader extends StatelessWidget {
  const ShopHeader(this.title, {super.key, this.subtitle, this.trailing});

  final String title;
  final String? subtitle;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 18),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: t.displaySmall),
            if (subtitle != null) ...[
              const SizedBox(height: 6),
              Text(subtitle!, style: t.bodyMedium?.copyWith(color: Bk.muted)),
            ],
          ]),
        ),
        if (trailing != null) ...[const SizedBox(width: 12), trailing!],
      ]),
    );
  }
}

/// The one card shape in the shop. Same radius, border and padding as the
/// rest of the app's surfaces.
class ShopCard extends StatelessWidget {
  const ShopCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(16),
    this.onTap,
    this.highlight = false,
  });

  final Widget child;
  final EdgeInsets padding;
  final VoidCallback? onTap;

  /// Lifts the border to the accent — for the one card on a screen that is
  /// the recommended action. Never more than one at a time.
  final bool highlight;

  @override
  Widget build(BuildContext context) {
    final body = Container(
      padding: padding,
      decoration: BoxDecoration(
        color: Bk.surface,
        borderRadius: BorderRadius.circular(Bk.rLg),
        border: Border.all(color: highlight ? Bk.accent : Bk.border),
      ),
      child: child,
    );
    if (onTap == null) return body;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(Bk.rLg),
      child: body,
    );
  }
}

/// Section label above a group. Uses the theme's label tier so it matches the
/// labels already used elsewhere in the app.
class ShopSection extends StatelessWidget {
  const ShopSection(this.label, {super.key, this.action});
  final String label;
  final Widget? action;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 8, bottom: 10),
        child: Row(children: [
          Text(label.toUpperCase(),
              style: Theme.of(context).textTheme.labelMedium),
          const Spacer(),
          if (action != null) action!,
        ]),
      );
}

enum PillTone { neutral, accent, good, warn, bad }

/// A small status chip. The tone carries meaning — availability, timing,
/// whether something is an estimate — so it is never chosen for looks.
class ShopPill extends StatelessWidget {
  const ShopPill(this.text, {super.key, this.tone = PillTone.neutral, this.icon});

  final String text;
  final PillTone tone;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final (fg, bg) = switch (tone) {
      PillTone.neutral => (Bk.muted, Bk.surface3),
      PillTone.accent => (Bk.accent, Bk.accentGhost),
      PillTone.good => (Bk.good, const Color(0x1F4ADE80)),
      PillTone.warn => (Bk.warn, const Color(0x1FF5A524)),
      PillTone.bad => (Bk.bad, const Color(0x1FFB7185)),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
      decoration: BoxDecoration(
          color: bg, borderRadius: BorderRadius.circular(Bk.rSm)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        if (icon != null) ...[
          Icon(icon, size: 12, color: fg),
          const SizedBox(width: 4),
        ],
        Text(text,
            style: TextStyle(
                fontSize: 11.5, fontWeight: FontWeight.w600, color: fg)),
      ]),
    );
  }
}

/// A price, in fiat, with the crypto estimate underneath.
///
/// THE FIAT FIGURE IS THE PRICE. The retailer charges fiat; the crypto line is
/// what it is worth right now and is always marked as approximate by
/// CryptoPrice itself. Showing the crypto amount as the headline would be a
/// quote this app cannot honour, since the rate moves between looking and
/// paying.
class PriceText extends StatelessWidget {
  const PriceText(this.product, {super.key, this.crypto, this.large = false});

  final Product product;
  final CryptoPrice? crypto;
  final bool large;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    if (!product.hasPrice) {
      // Two different absences, said differently. A curated retailer link is
      // COMPLETE without a price — Amazon's terms permit showing one only
      // from their own API or their own embed, so "see it there" is the
      // correct permanent state, not a gap. A seller's own listing with no
      // price really is unfinished.
      //
      // Either way: no invented "$0.00" and no "Free".
      return Text(
          product.priceLivesAtRetailer
              ? 'See price on ${product.merchant}'
              : 'Price not listed',
          style: t.bodyMedium?.copyWith(
              color: product.priceLivesAtRetailer ? Bk.accent : Bk.faint,
              fontWeight: product.priceLivesAtRetailer
                  ? FontWeight.w600
                  : FontWeight.w400));
    }
    final money = _format(product.price!, product.currency!);
    final was = product.originalPrice == null
        ? null
        : _format(product.originalPrice!, product.currency!);
    final off = product.discountPercent;

    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic, children: [
        Text(money,
            style: (large ? t.headlineMedium : t.titleLarge)
                ?.copyWith(fontFeatures: const [FontFeature.tabularFigures()])),
        if (was != null) ...[
          const SizedBox(width: 8),
          Text(was,
              style: t.bodySmall?.copyWith(
                  color: Bk.faint, decoration: TextDecoration.lineThrough)),
        ],
        if (off != null) ...[
          const SizedBox(width: 8),
          ShopPill('$off% off', tone: PillTone.good),
        ],
      ]),
      if (crypto != null) ...[
        const SizedBox(height: 4),
        Text(crypto!.display,
            style: t.bodySmall?.copyWith(color: Bk.accent)),
      ],
    ]);
  }

  /// Minimal, honest formatting. Known symbols get a symbol; anything else
  /// keeps its ISO code rather than being dressed up as dollars.
  static String _format(double v, String cur) {
    const sym = {'USD': r'$', 'EUR': '€', 'GBP': '£', 'JPY': '¥'};
    final s = sym[cur];
    final n = v.toStringAsFixed(cur == 'JPY' ? 0 : 2);
    return s == null ? '$n $cur' : '$s$n';
  }
}

/// The screen state that says "there is nothing here, and here is why".
///
/// Used instead of a blank area or, worse, sample content. Every shop empty
/// state in this app goes through this widget so they all explain themselves
/// the same way.
class ShopEmpty extends StatelessWidget {
  const ShopEmpty({
    super.key,
    required this.icon,
    required this.title,
    required this.body,
    this.action,
  });

  final IconData icon;
  final String title;
  final String body;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 28),
      decoration: BoxDecoration(
          color: Bk.bg2,
          borderRadius: BorderRadius.circular(Bk.rLg),
          border: Border.all(color: Bk.line)),
      child: Column(children: [
        Icon(icon, color: Bk.faint, size: 30),
        const SizedBox(height: 12),
        Text(title, textAlign: TextAlign.center, style: t.titleMedium),
        const SizedBox(height: 8),
        Text(body,
            textAlign: TextAlign.center,
            style: t.bodySmall?.copyWith(color: Bk.muted)),
        if (action != null) ...[const SizedBox(height: 16), action!],
      ]),
    );
  }
}

/// An explanatory note attached to a control — the blocker on a flow card, the
/// reason a source is offline, the caveat on an estimate.
class ShopNote extends StatelessWidget {
  const ShopNote(this.text, {super.key, this.tone = PillTone.neutral, this.icon});

  final String text;
  final PillTone tone;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final fg = switch (tone) {
      PillTone.good => Bk.good,
      PillTone.warn => Bk.warn,
      PillTone.bad => Bk.bad,
      PillTone.accent => Bk.accent,
      PillTone.neutral => Bk.muted,
    };
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(11),
      decoration: BoxDecoration(
          color: Bk.surface2,
          borderRadius: BorderRadius.circular(Bk.rSm),
          border: Border.all(color: Bk.border)),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Icon(icon ?? Icons.info_outline, size: 15, color: fg),
        const SizedBox(width: 9),
        Expanded(
            child: Text(text,
                style: Theme.of(context)
                    .textTheme
                    .bodySmall
                    ?.copyWith(color: Bk.muted))),
      ]),
    );
  }
}

/// The product thumbnail, with the failure cases handled once.
///
/// A broken image URL is normal — merchants move their CDN, hotlink
/// protection kicks in — and must degrade to a placeholder rather than a red
/// exception box on a shopping screen.
class ProductImage extends StatelessWidget {
  const ProductImage(this.url, {super.key, this.size = 72, this.radius});

  final String? url;
  final double size;
  final double? radius;

  @override
  Widget build(BuildContext context) {
    final r = radius ?? Bk.rMd;
    final fallback = Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
          color: Bk.surface2,
          borderRadius: BorderRadius.circular(r),
          border: Border.all(color: Bk.border)),
      child: Icon(Icons.image_outlined, color: Bk.faint, size: size * 0.32),
    );
    final u = url;
    if (u == null || u.isEmpty) return fallback;
    return ClipRRect(
      borderRadius: BorderRadius.circular(r),
      child: Image.network(
        u,
        width: size,
        height: size,
        fit: BoxFit.cover,
        errorBuilder: (_, __, ___) => fallback,
        loadingBuilder: (c, child, p) => p == null
            ? child
            : Container(
                width: size,
                height: size,
                color: Bk.surface2,
                child: const Center(
                    child: SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2)))),
      ),
    );
  }
}

/// Stock state as a chip, including the honest `unknown` case.
class AvailabilityPill extends StatelessWidget {
  const AvailabilityPill(this.availability, {super.key});
  final Availability availability;

  @override
  Widget build(BuildContext context) => switch (availability) {
        Availability.inStock =>
          const ShopPill('In stock', tone: PillTone.good, icon: Icons.check),
        Availability.outOfStock =>
          const ShopPill('Out of stock', tone: PillTone.bad),
        Availability.preorder =>
          const ShopPill('Pre-order', tone: PillTone.warn),
        // Said plainly rather than hidden. "Not stated" is the truth for most
        // pages, and dropping the chip entirely would let a shopper assume
        // the thing is available.
        Availability.unknown =>
          const ShopPill('Stock not stated', tone: PillTone.neutral),
      };
}
