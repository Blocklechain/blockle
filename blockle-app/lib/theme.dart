import 'package:flutter/material.dart';

/// Blockle brand palette + Material theme. Dark, violet-accented, matching the
/// browser extension's look — tuned for a sleek, modern, high-contrast feel.
class Bk {
  // Grounds & surfaces (violet-biased neutrals, not pure grey).
  static const bg = Color(0xFF0B0B14);
  static const bg2 = Color(0xFF11111F);
  static const surface = Color(0xFF17172B);
  static const surface2 = Color(0xFF1F1F38);
  // A slightly lifted surface for nested/elevated chips & tiles.
  static const surface3 = Color(0xFF26263F);
  static const border = Color(0xFF2A2A45);
  // Hairline border for quiet separators (softer than `border`).
  static const line = Color(0xFF20203A);

  static const accent = Color(0xFF7C5CFF);
  static const accent2 = Color(0xFF37E0C8);
  // A faint accent wash for selected/active fills.
  static const accentGhost = Color(0x1F7C5CFF);
  static const text = Color(0xFFECECF5);
  static const muted = Color(0xFF9A9AB5);
  // A dimmer tier for captions / tertiary text.
  static const faint = Color(0xFF6C6C86);
  static const good = Color(0xFF4ADE80);
  static const bad = Color(0xFFFB7185);
  static const warn = Color(0xFFF5A524);

  // Consistent corner-radius scale used across the app.
  static const rSm = 10.0;
  static const rMd = 14.0;
  static const rLg = 18.0;
  static const rXl = 22.0;

  static const gradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0xFF7C5CFF), Color(0xFF37E0C8)],
  );

  /// Soft, low-spread shadow for cards that want a touch of depth without the
  /// heavy Material elevation tint.
  static const softShadow = [
    BoxShadow(color: Color(0x33000000), blurRadius: 18, offset: Offset(0, 8)),
  ];

  static ThemeData theme() {
    const scheme = ColorScheme.dark(
      primary: accent,
      onPrimary: Colors.white,
      secondary: accent2,
      onSecondary: Color(0xFF05241F),
      surface: surface,
      onSurface: text,
      surfaceContainerHighest: surface2,
      outline: border,
      outlineVariant: line,
      error: bad,
      onError: Color(0xFF2A0A0F),
    );
    final base = ThemeData.from(colorScheme: scheme, useMaterial3: true);

    // ---- typography: refined scale (tighter display tracking, airy body) ----
    TextStyle disp(double s, FontWeight w, double ls) =>
        TextStyle(fontSize: s, fontWeight: w, letterSpacing: ls, height: 1.1, color: text);
    final tt = base.textTheme.copyWith(
      displaySmall: disp(34, FontWeight.w800, -0.8),
      headlineMedium: disp(26, FontWeight.w800, -0.6),
      headlineSmall: disp(22, FontWeight.w700, -0.4),
      titleLarge: disp(19, FontWeight.w700, -0.2),
      titleMedium: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600, height: 1.25, color: text),
      titleSmall: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600, height: 1.3, color: text),
      bodyLarge: const TextStyle(fontSize: 15.5, height: 1.45, color: text),
      bodyMedium: const TextStyle(fontSize: 14, height: 1.45, color: text),
      bodySmall: const TextStyle(fontSize: 12.5, height: 1.4, color: muted),
      labelLarge: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600, letterSpacing: 0.1, color: text),
      labelMedium: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, letterSpacing: 0.4, color: muted),
    ).apply(bodyColor: text, displayColor: text);

    RoundedRectangleBorder rr(double r, [Color? side]) => RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(r),
          side: side == null ? BorderSide.none : BorderSide(color: side),
        );

    return base.copyWith(
      scaffoldBackgroundColor: bg,
      canvasColor: bg,
      dividerColor: line,
      textTheme: tt,
      splashFactory: InkSparkle.splashFactory,
      visualDensity: VisualDensity.standard,
      pageTransitionsTheme: const PageTransitionsTheme(builders: {
        TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
        TargetPlatform.android: FadeForwardsPageTransitionsBuilder(),
      }),

      appBarTheme: const AppBarTheme(
        backgroundColor: bg,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        foregroundColor: text,
        titleTextStyle: TextStyle(
            fontSize: 19, fontWeight: FontWeight.w700, letterSpacing: -0.2, color: text),
      ),

      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: surface2,
        hintStyle: const TextStyle(color: faint),
        labelStyle: const TextStyle(color: muted),
        floatingLabelStyle: const TextStyle(color: accent),
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 15),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(rMd),
          borderSide: const BorderSide(color: border),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(rMd),
          borderSide: const BorderSide(color: border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(rMd),
          borderSide: const BorderSide(color: accent, width: 1.6),
        ),
        errorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(rMd),
          borderSide: const BorderSide(color: bad),
        ),
      ),

      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: accent,
          foregroundColor: Colors.white,
          disabledBackgroundColor: surface3,
          disabledForegroundColor: faint,
          minimumSize: const Size.fromHeight(52),
          elevation: 0,
          shape: rr(rMd),
          textStyle: const TextStyle(
              fontSize: 15.5, fontWeight: FontWeight.w700, letterSpacing: 0.1),
        ),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: accent,
          foregroundColor: Colors.white,
          minimumSize: const Size.fromHeight(52),
          elevation: 0,
          shape: rr(rMd),
          textStyle: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w700),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: text,
          minimumSize: const Size.fromHeight(52),
          side: const BorderSide(color: border),
          shape: rr(rMd),
          textStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: accent,
          textStyle: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600),
          shape: rr(rSm),
        ),
      ),

      cardTheme: CardThemeData(
        color: surface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        margin: EdgeInsets.zero,
        clipBehavior: Clip.antiAlias,
        shape: rr(rLg, border),
      ),

      chipTheme: ChipThemeData(
        backgroundColor: surface2,
        selectedColor: accentGhost,
        side: const BorderSide(color: border),
        labelStyle: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: text),
        secondaryLabelStyle: const TextStyle(color: accent),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(rSm)),
      ),

      segmentedButtonTheme: SegmentedButtonThemeData(
        style: ButtonStyle(
          backgroundColor: WidgetStateProperty.resolveWith((s) =>
              s.contains(WidgetState.selected) ? accentGhost : Colors.transparent),
          foregroundColor: WidgetStateProperty.resolveWith((s) =>
              s.contains(WidgetState.selected) ? accent : muted),
          side: const WidgetStatePropertyAll(BorderSide(color: border)),
          textStyle: const WidgetStatePropertyAll(
              TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
          shape: WidgetStatePropertyAll(
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(rSm))),
        ),
      ),

      switchTheme: SwitchThemeData(
        thumbColor: WidgetStateProperty.resolveWith((s) =>
            s.contains(WidgetState.selected) ? Colors.white : muted),
        trackColor: WidgetStateProperty.resolveWith((s) =>
            s.contains(WidgetState.selected) ? accent : surface3),
        trackOutlineColor: const WidgetStatePropertyAll(Colors.transparent),
      ),
      sliderTheme: const SliderThemeData(
        activeTrackColor: accent,
        inactiveTrackColor: surface3,
        thumbColor: accent,
        overlayColor: accentGhost,
        trackHeight: 4,
      ),
      checkboxTheme: CheckboxThemeData(
        fillColor: WidgetStateProperty.resolveWith((s) =>
            s.contains(WidgetState.selected) ? accent : Colors.transparent),
        side: const BorderSide(color: border, width: 1.5),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
      ),

      dividerTheme: const DividerThemeData(color: line, thickness: 1, space: 1),
      listTileTheme: const ListTileThemeData(
        iconColor: muted,
        textColor: text,
        shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.all(Radius.circular(rMd))),
      ),

      dialogTheme: DialogThemeData(
        backgroundColor: surface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: rr(rXl, border),
        titleTextStyle: const TextStyle(
            fontSize: 18, fontWeight: FontWeight.w700, letterSpacing: -0.2, color: text),
        contentTextStyle: const TextStyle(fontSize: 14, height: 1.45, color: muted),
      ),
      bottomSheetTheme: const BottomSheetThemeData(
        backgroundColor: surface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.vertical(top: Radius.circular(rXl))),
        showDragHandle: true,
        dragHandleColor: surface3,
      ),
      snackBarTheme: SnackBarThemeData(
        backgroundColor: surface2,
        contentTextStyle: const TextStyle(color: text, fontWeight: FontWeight.w500),
        actionTextColor: accent,
        behavior: SnackBarBehavior.floating,
        elevation: 0,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(rMd)),
      ),
      tooltipTheme: TooltipThemeData(
        decoration: BoxDecoration(
            color: surface3, borderRadius: BorderRadius.circular(rSm)),
        textStyle: const TextStyle(color: text, fontSize: 12),
      ),
      tabBarTheme: const TabBarThemeData(
        labelColor: accent,
        unselectedLabelColor: muted,
        indicatorColor: accent,
        dividerColor: Colors.transparent,
        labelStyle: TextStyle(fontWeight: FontWeight.w700, fontSize: 14),
      ),
      progressIndicatorTheme: const ProgressIndicatorThemeData(
        color: accent,
        linearTrackColor: surface3,
        circularTrackColor: Colors.transparent,
      ),
      iconTheme: const IconThemeData(color: text),
      scrollbarTheme: const ScrollbarThemeData(
        thumbColor: WidgetStatePropertyAll(surface3),
        radius: Radius.circular(8),
        thickness: WidgetStatePropertyAll(4),
      ),
    );
  }
}

const kMono = TextStyle(
    fontFamily: 'monospace', fontSize: 13, letterSpacing: 0.2, color: Bk.text);
