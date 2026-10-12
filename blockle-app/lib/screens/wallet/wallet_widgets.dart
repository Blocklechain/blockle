// wallet_widgets.dart — small shared presentation pieces for the wallet
// surfaces, built on the shared BotTokens token set (one product look). Pure UI;
// no engine calls, no money path.

import 'package:flutter/material.dart';

import '../bots/bots_tokens.dart';

/// A surface card matching the reference `.card` (surface + line + radius).
class WCard extends StatelessWidget {
  const WCard({super.key, required this.child, this.padding});
  final Widget child;
  final EdgeInsets? padding;
  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    return Container(
      padding: padding,
      decoration: BoxDecoration(
        color: t.surface,
        border: Border.all(color: t.line),
        borderRadius: BorderRadius.circular(BotTokens.radius),
      ),
      child: child,
    );
  }
}

/// The `.sec-head` section header: a title + an optional count pill + trailing.
class SectionHead extends StatelessWidget {
  const SectionHead({super.key, required this.title, this.count, this.trailing});
  final String title;
  final String? count;
  final Widget? trailing;
  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(2, 24, 2, 11),
      child: Row(children: [
        Text(title, style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: t.ink)),
        if (count != null) ...[
          const SizedBox(width: 10),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 2),
            decoration: BoxDecoration(
              color: t.elevated,
              border: Border.all(color: t.line),
              borderRadius: BorderRadius.circular(20),
            ),
            child: Text(count!,
                style: TextStyle(fontSize: 12, color: t.inkFaint, fontFamily: kMonoFamily)),
          ),
        ],
        if (trailing != null) ...[const Spacer(), trailing!],
      ]),
    );
  }
}

/// A round token/initials bubble (the `.token` mark).
class TokenBubble extends StatelessWidget {
  const TokenBubble({super.key, required this.label, this.color, this.size = 32});
  final String label;
  final Color? color;
  final double size;
  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: color ?? colorForSymbol(label),
        shape: BoxShape.circle,
      ),
      child: Text(
        label.length >= 2 ? label.substring(0, 2).toUpperCase() : label.toUpperCase(),
        style: TextStyle(
            fontSize: size * 0.36, fontWeight: FontWeight.w800, color: Colors.white),
      ),
    );
  }
}

/// A small inline tag/chip (e.g. UNPRICED, ENS, SNS, mchips).
class WTag extends StatelessWidget {
  const WTag(this.label, {super.key, this.color, this.bordered = false, this.mono = false});
  final String label;
  final Color? color;
  final bool bordered;
  final bool mono;
  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    final c = color ?? t.inkFaint;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        color: bordered ? null : t.elevated,
        border: Border.all(color: bordered ? t.line : t.line),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(label,
          style: TextStyle(
              fontSize: 10.5,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.3,
              fontFamily: mono ? kMonoFamily : null,
              color: c)),
    );
  }
}

/// Deterministic brand-ish color per chain (categorical, from the token set).
Color colorForChain(String chain, BotTokens t) {
  switch (chain) {
    case 'ethereum':
      return t.kBase;
    case 'solana':
      return t.kTp;
    case 'base':
    case 'arbitrum':
      return t.accent;
    case 'block':
      return t.kSafety;
    default:
      return colorForSymbol(chain);
  }
}

/// A stable pastel from a symbol's hash (used when no brand color applies).
Color colorForSymbol(String s) {
  var h = 0;
  for (final c in s.codeUnits) {
    h = (h * 31 + c) & 0x7fffffff;
  }
  final hue = (h % 360).toDouble();
  return HSLColor.fromAHSL(1, hue, 0.52, 0.55).toColor();
}

/// Truncate an address for display (keep head + tail).
String shortAddr(String a) =>
    a.length > 16 ? '${a.substring(0, 8)}…${a.substring(a.length - 4)}' : a;
