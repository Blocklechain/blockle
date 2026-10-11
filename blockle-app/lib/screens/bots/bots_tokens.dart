// bots_tokens.dart — the Blockle Bots design tokens, ported 1:1 from the shared
// visual contract docs/design/bots/index.html (:root + :root[data-theme=light]).
// ONE source of truth across the three wallets (extension CSS vars, this Flutter
// token set, Qt QSS). Theme-aware: first-class light AND dark, never an automatic
// invert — dark is its own validated step set.
//
// Colors carry their exact hex (including the ghost alphas: `1f`=0x1F, `14`=0x14).
// Charts use the categorical triad (kBase azure / kSafety amber / kTp green —
// the Okabe–Ito-safe set lifted for dark) and the diverging gain/loss pair with a
// neutral zero, matching the dataviz method (validated palette, one axis).

import 'package:flutter/widgets.dart';

@immutable
class BotTokens {
  final Color ground;
  final Color surface;
  final Color elevated;
  final Color line;
  final Color lineSoft;
  final Color ink;
  final Color inkMuted;
  final Color inkFaint;
  final Color accent;
  final Color accentDim;
  final Color accentGhost;
  final Color gain;
  final Color gainGhost;
  final Color loss;
  final Color lossGhost;
  final Color warn;
  final Color kBase; // deal-ladder categorical: base order
  final Color kSafety; // safety orders
  final Color kTp; // take-profit
  final Brightness brightness;

  const BotTokens({
    required this.ground,
    required this.surface,
    required this.elevated,
    required this.line,
    required this.lineSoft,
    required this.ink,
    required this.inkMuted,
    required this.inkFaint,
    required this.accent,
    required this.accentDim,
    required this.accentGhost,
    required this.gain,
    required this.gainGhost,
    required this.loss,
    required this.lossGhost,
    required this.warn,
    required this.kBase,
    required this.kSafety,
    required this.kTp,
    required this.brightness,
  });

  bool get isDark => brightness == Brightness.dark;

  // radius scale (px -> logical) — matches --radius / --radius-sm
  static const double radius = 14;
  static const double radiusSm = 9;

  static const BotTokens dark = BotTokens(
    ground: Color(0xFF0B0F15),
    surface: Color(0xFF141B24),
    elevated: Color(0xFF1D2630),
    line: Color(0xFF27333F),
    lineSoft: Color(0xFF1F2932),
    ink: Color(0xFFE8EDF3),
    inkMuted: Color(0xFF8795A4),
    inkFaint: Color(0xFF5D6B79),
    accent: Color(0xFF4C8DFF),
    accentDim: Color(0xFF2B4A86),
    accentGhost: Color(0x1F4C8DFF),
    gain: Color(0xFF2FD39B),
    gainGhost: Color(0x1F2FD39B),
    loss: Color(0xFFF0536A),
    lossGhost: Color(0x1FF0536A),
    warn: Color(0xFFF0A732),
    kBase: Color(0xFF4C8DFF),
    kSafety: Color(0xFFF0A732),
    kTp: Color(0xFF2FD39B),
    brightness: Brightness.dark,
  );

  static const BotTokens light = BotTokens(
    ground: Color(0xFFF3F5F8),
    surface: Color(0xFFFFFFFF),
    elevated: Color(0xFFFFFFFF),
    line: Color(0xFFDDE3EA),
    lineSoft: Color(0xFFE8EDF2),
    ink: Color(0xFF11212F),
    inkMuted: Color(0xFF5A6B7B),
    inkFaint: Color(0xFF93A1AF),
    accent: Color(0xFF2F6FF0),
    accentDim: Color(0xFFA9C6FF),
    accentGhost: Color(0x142F6FF0),
    gain: Color(0xFF0C9E6F),
    gainGhost: Color(0x140C9E6F),
    loss: Color(0xFFD83A52),
    lossGhost: Color(0x14D83A52),
    warn: Color(0xFFC6830F),
    kBase: Color(0xFF2F6FF0),
    kSafety: Color(0xFFC6830F),
    kTp: Color(0xFF0C9E6F),
    brightness: Brightness.light,
  );

  static BotTokens of(Brightness b) =>
      b == Brightness.light ? light : dark;

  /// Sign-explicit gain/loss color (diverging pair, neutral at zero -> inkMuted).
  Color pnlColor(num v) => v > 0 ? gain : (v < 0 ? loss : inkMuted);
}

/// Inherited access to the active [BotTokens] for the Bots surfaces. Lets every
/// sub-widget read the theme-aware token set without prop-drilling.
class BotTheme extends InheritedWidget {
  final BotTokens tokens;
  const BotTheme({super.key, required this.tokens, required super.child});

  static BotTokens of(BuildContext context) {
    final w = context.dependOnInheritedWidgetOfExactType<BotTheme>();
    assert(w != null, 'BotTheme.of() called without a BotTheme ancestor');
    return w!.tokens;
  }

  @override
  bool updateShouldNotify(BotTheme oldWidget) => oldWidget.tokens != tokens;
}

const String kMonoFamily = 'monospace';
