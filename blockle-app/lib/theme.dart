import 'package:flutter/material.dart';

/// Blockle brand palette + Material theme. Dark, violet-accented, matching the
/// browser extension's look.
class Bk {
  static const bg = Color(0xFF0B0B14);
  static const bg2 = Color(0xFF11111F);
  static const surface = Color(0xFF17172B);
  static const surface2 = Color(0xFF1F1F38);
  static const border = Color(0xFF2A2A45);
  static const accent = Color(0xFF7C5CFF);
  static const accent2 = Color(0xFF37E0C8);
  static const text = Color(0xFFECECF5);
  static const muted = Color(0xFF9A9AB5);
  static const good = Color(0xFF4ADE80);
  static const bad = Color(0xFFFB7185);

  static const gradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0xFF7C5CFF), Color(0xFF37E0C8)],
  );

  static ThemeData theme() {
    const scheme = ColorScheme.dark(
      primary: accent,
      secondary: accent2,
      surface: surface,
      error: bad,
      onPrimary: Colors.white,
      onSurface: text,
    );
    final base = ThemeData.from(colorScheme: scheme, useMaterial3: true);
    return base.copyWith(
      scaffoldBackgroundColor: bg,
      canvasColor: bg,
      dividerColor: border,
      textTheme: base.textTheme.apply(bodyColor: text, displayColor: text),
      appBarTheme: const AppBarTheme(
        backgroundColor: bg,
        elevation: 0,
        centerTitle: false,
        foregroundColor: text,
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: surface2,
        hintStyle: const TextStyle(color: muted),
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: const BorderSide(color: border),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: const BorderSide(color: border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: const BorderSide(color: accent, width: 1.5),
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: accent,
          foregroundColor: Colors.white,
          minimumSize: const Size.fromHeight(52),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
          textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: text,
          minimumSize: const Size.fromHeight(52),
          side: const BorderSide(color: border),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        ),
      ),
      cardTheme: CardThemeData(
        color: surface,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(18),
          side: const BorderSide(color: border),
        ),
      ),
      snackBarTheme: const SnackBarThemeData(
        backgroundColor: surface2,
        contentTextStyle: TextStyle(color: text),
        behavior: SnackBarBehavior.floating,
      ),
    );
  }
}

const kMono = TextStyle(fontFamily: 'monospace', fontSize: 13, color: Bk.text);
