import 'package:flutter/material.dart';

/// Blockle Quest palette — shared by the Flame render layer and the Flutter HUD.
class Bq {
  static const bg = Color(0xFF0E0E14);
  static const panel = Color(0xFF16161F);
  static const panel2 = Color(0xFF1E1E2B);
  static const accent = Color(0xFF7C5CFF);
  static const accent2 = Color(0xFF9D7BFF);
  static const text = Color(0xFFEDEDF4);
  static const dim = Color(0xFF9AA0B5);

  // World tiles
  static const grass = Color(0xFF26432B);
  static const grassAlt = Color(0xFF2C4D32);
  static const tallGrass = Color(0xFF1C7A3E);
  static const path = Color(0xFF5A4A36);
  static const water = Color(0xFF1C3A6E);
  static const tree = Color(0xFF14361C);

  // Combat
  static const hpGood = Color(0xFF3FD17A);
  static const hpBad = Color(0xFFE5484D);
  static const enemy = Color(0xFFE5705A);
  static const xp = Color(0xFF4FC3F7);

  static ThemeData theme() => ThemeData(
        useMaterial3: true,
        brightness: Brightness.dark,
        scaffoldBackgroundColor: bg,
        colorScheme: ColorScheme.fromSeed(
          seedColor: accent,
          brightness: Brightness.dark,
        ).copyWith(surface: panel),
        fontFamily: 'Roboto',
      );
}
