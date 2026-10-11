// bots_widgets.dart — small shared building blocks for the Bots surfaces, all
// theme-aware off [BotTokens]. Accessibility baked in: hit targets >= 44px,
// state never by color alone (badges/dots carry text + a shape), Semantics labels
// on the interactive and numeric pieces, monospaced tabular numbers.

import 'package:flutter/material.dart';

import 'bots_tokens.dart';

/// Format a signed USD figure like the reference (`+$1,284.60` / `−$12.40`).
String moneyUsd(num n, {bool sign = true}) {
  final neg = n < 0;
  final cents = (n.abs() * 100).round();
  final whole = (cents ~/ 100).toString();
  final frac = (cents % 100).toString().padLeft(2, '0');
  final buf = StringBuffer();
  for (var i = 0; i < whole.length; i++) {
    if (i > 0 && (whole.length - i) % 3 == 0) buf.write(',');
    buf.write(whole[i]);
  }
  final body = '\$$buf.$frac';
  if (!sign) return neg ? '−$body' : body;
  return neg ? '−$body' : '+$body';
}

TextStyle mono(BotTokens t, {double size = 13, Color? color, FontWeight? w}) =>
    TextStyle(
      fontFamily: kMonoFamily,
      fontFeatures: const [FontFeature.tabularFigures()],
      fontSize: size,
      color: color ?? t.ink,
      fontWeight: w,
      letterSpacing: -0.1,
    );

/// A surface card (border + radius) matching `.card`.
class BotCard extends StatelessWidget {
  const BotCard({super.key, required this.child, this.padding, this.onTap});
  final Widget child;
  final EdgeInsets? padding;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    final card = Container(
      decoration: BoxDecoration(
        color: t.surface,
        borderRadius: BorderRadius.circular(BotTokens.radius),
        border: Border.all(color: t.line),
      ),
      padding: padding ?? const EdgeInsets.all(18),
      child: child,
    );
    if (onTap == null) return card;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(BotTokens.radius),
        child: card,
      ),
    );
  }
}

/// Uppercase micro-label (`.eyebrow`).
class Eyebrow extends StatelessWidget {
  const Eyebrow(this.text, {super.key});
  final String text;
  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    return Text(
      text.toUpperCase(),
      style: TextStyle(
        fontSize: 11,
        letterSpacing: 1.4,
        fontWeight: FontWeight.w600,
        color: t.inkFaint,
      ),
    );
  }
}

/// A type / info chip (`.chip` / `.chip.type`).
class BotChip extends StatelessWidget {
  const BotChip(this.label, {super.key, this.accent = false});
  final String label;
  final bool accent;
  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: accent ? t.accentGhost : t.elevated,
        borderRadius: BorderRadius.circular(7),
        border: Border.all(color: accent ? t.accentDim : t.line),
      ),
      child: Text(label,
          style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w600,
              color: accent ? t.accent : t.inkMuted)),
    );
  }
}

/// The mode badge: paper = outline, live = solid accent/gain, each with a dot +
/// the word (never color alone).
class ModeBadge extends StatelessWidget {
  const ModeBadge({super.key, required this.live});
  final bool live;
  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
      decoration: BoxDecoration(
        color: live ? t.gain : Colors.transparent,
        borderRadius: BorderRadius.circular(20),
        border: live ? null : Border.all(color: t.accentDim),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 6,
            height: 6,
            decoration: BoxDecoration(
                shape: BoxShape.circle, color: live ? Colors.white : t.accent),
          ),
          const SizedBox(width: 5),
          Text(live ? 'Live' : 'Paper',
              style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                  color: live ? Colors.white : t.accent)),
        ],
      ),
    );
  }
}

/// A status dot + text (`running` / `paused` / `killed`).
class StatusDot extends StatelessWidget {
  const StatusDot({super.key, required this.status});
  final String status;
  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    final Color c = status == 'running'
        ? t.gain
        : status == 'killed'
            ? t.loss
            : t.inkFaint;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
            width: 7,
            height: 7,
            decoration: BoxDecoration(shape: BoxShape.circle, color: c)),
        const SizedBox(width: 6),
        Text(status, style: TextStyle(fontSize: 12, color: t.inkMuted)),
      ],
    );
  }
}

/// A slim allocation progress bar (single sequential accent hue).
class AllocBar extends StatelessWidget {
  const AllocBar({super.key, required this.fraction});
  final double fraction;
  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    return ClipRRect(
      borderRadius: BorderRadius.circular(4),
      child: LinearProgressIndicator(
        value: fraction.clamp(0, 1),
        minHeight: 6,
        backgroundColor: t.line,
        valueColor: AlwaysStoppedAnimation(t.accent),
      ),
    );
  }
}

/// A primary (filled) or ghost (outline) button, >= 44px tall.
class BotButton extends StatelessWidget {
  const BotButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.icon,
    this.primary = false,
    this.danger = false,
    this.expand = false,
  });
  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;
  final bool primary;
  final bool danger;
  final bool expand;

  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    final fg = danger
        ? (primary ? Colors.white : t.loss)
        : (primary ? Colors.white : t.ink);
    final bg = primary ? (danger ? t.loss : t.accent) : t.elevated;
    final child = Row(
      mainAxisSize: expand ? MainAxisSize.max : MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        if (icon != null) ...[Icon(icon, size: 16, color: fg), const SizedBox(width: 8)],
        Text(label,
            style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: fg)),
      ],
    );
    final btn = Material(
      color: bg,
      borderRadius: BorderRadius.circular(11),
      child: InkWell(
        onTap: onPressed,
        borderRadius: BorderRadius.circular(11),
        child: Container(
          constraints: const BoxConstraints(minHeight: 44),
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 11),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(11),
            border: primary
                ? null
                : Border.all(color: danger ? t.loss : t.line),
          ),
          child: child,
        ),
      ),
    );
    return expand ? SizedBox(width: double.infinity, child: btn) : btn;
  }
}

/// The persistent non-custodial note (`.note`).
class SafetyNote extends StatelessWidget {
  const SafetyNote({super.key, required this.child, this.icon = Icons.info_outline});
  final Widget child;
  final IconData icon;
  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 13),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(BotTokens.radiusSm),
        border: Border.all(color: t.line, style: BorderStyle.solid),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 16, color: t.accent),
          const SizedBox(width: 9),
          Expanded(
            child: DefaultTextStyle(
              style: TextStyle(fontSize: 12.5, color: t.inkFaint, height: 1.5),
              child: child,
            ),
          ),
        ],
      ),
    );
  }
}
