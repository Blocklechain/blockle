import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';

/// Elemental families — a Blockling's type.
enum Element { spark, stone, leaf, tide, ember, gust }

extension ElementX on Element {
  String get label => switch (this) {
        Element.spark => 'Spark',
        Element.stone => 'Stone',
        Element.leaf => 'Leaf',
        Element.tide => 'Tide',
        Element.ember => 'Ember',
        Element.gust => 'Gust',
      };

  Color get color => switch (this) {
        Element.spark => const Color(0xFFFFD54F),
        Element.stone => const Color(0xFF9E8B6E),
        Element.leaf => const Color(0xFF6FCF67),
        Element.tide => const Color(0xFF4FC3F7),
        Element.ember => const Color(0xFFE5705A),
        Element.gust => const Color(0xFFB0BEC5),
      };
}

/// The fixed species roster. Appearance is a color + shape family keyed off the
/// element; names are flavor.
class Species {
  final String name;
  final Element element;
  const Species(this.name, this.element);
}

const kSpecies = <Species>[
  Species('Voltlet', Element.spark),
  Species('Gritterra', Element.stone),
  Species('Sprigaw', Element.leaf),
  Species('Rippfin', Element.tide),
  Species('Cindibble', Element.ember),
  Species('Zephyx', Element.gust),
  Species('Arclume', Element.spark),
  Species('Boulderkin', Element.stone),
  Species('Thornwisp', Element.leaf),
  Species('Marlowe', Element.tide),
  Species('Pyrruff', Element.ember),
  Species('Galevane', Element.gust),
];

const kRarityNames = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'];
const kRarityColors = [
  Color(0xFFB0B6C8), // common
  Color(0xFF6FCF67), // uncommon
  Color(0xFF4FC3F7), // rare
  Color(0xFFB07BFF), // epic
  Color(0xFFFFC24B), // legendary
];

/// A creature you own. Catches are **provably fair**: everything below is
/// derived deterministically from [seed] (public chain data, e.g.
/// "block:<height>:<x>:<y>:<n>") via SHA-256, so the roll can be re-verified by
/// anyone and no hidden server RNG is involved. Each Blockling can be minted as
/// a BLOCK-721 NFT on a chosen chain (see EconomyService.mintBlockling).
class Blockling {
  final String seed;
  final int speciesIndex;
  final int rarity; // 0..4
  final bool shiny;
  final int baseHp;
  final int baseAtk;
  final int baseSpd;
  int level;
  int xp;

  /// Set once minted on-chain (non-custodial, via the wallet). Null = not yet.
  String? nftId;
  String? nftChain;

  Blockling({
    required this.seed,
    required this.speciesIndex,
    required this.rarity,
    required this.shiny,
    required this.baseHp,
    required this.baseAtk,
    required this.baseSpd,
    this.level = 1,
    this.xp = 0,
    this.nftId,
    this.nftChain,
  });

  Species get species => kSpecies[speciesIndex];
  Element get element => species.element;
  String get name => species.name;
  String get rarityName => kRarityNames[rarity];
  Color get rarityColor => kRarityColors[rarity];
  bool get minted => nftId != null;

  int get maxHp => baseHp + (level - 1) * (6 + rarity * 2);
  int get atk => baseAtk + (level - 1) * (2 + rarity);
  double get speed => 42.0 + baseSpd.toDouble();
  int get powerScore => maxHp + atk * 4 + (shiny ? 50 : 0) + rarity * 25;

  int get xpToNext => 20 + level * 15;

  /// Returns true if the creature leveled up.
  bool gainXp(int amount) {
    xp += amount;
    var leveled = false;
    while (xp >= xpToNext) {
      xp -= xpToNext;
      level++;
      leveled = true;
    }
    return leveled;
  }

  Map<String, dynamic> toJson() => {
        'seed': seed,
        'species': speciesIndex,
        'rarity': rarity,
        'shiny': shiny,
        'baseHp': baseHp,
        'baseAtk': baseAtk,
        'baseSpd': baseSpd,
        'level': level,
        'xp': xp,
        'nftId': nftId,
        'nftChain': nftChain,
      };

  /// A starter Blockling of a chosen element (picked at character creation).
  factory Blockling.ofElement(int elementIndex, {int level = 3}) {
    var si = kSpecies.indexWhere((s) => s.element.index == elementIndex);
    if (si < 0) si = 0;
    return Blockling(
      seed: 'starter:$elementIndex',
      speciesIndex: si,
      rarity: 1,
      shiny: false,
      baseHp: 34,
      baseAtk: 10,
      baseSpd: 5,
      level: level,
    );
  }

  /// Deterministic, verifiable generation from a public seed.
  factory Blockling.fromSeed(String seed) {
    final Uint8List h = Uint8List.fromList(sha256.convert(utf8.encode(seed)).bytes);
    int at(int i) => h[i % h.length];

    final speciesIndex = at(0) % kSpecies.length;

    // Rarity: weighted so Legendary is scarce. 0..255 bucketed.
    final r = at(1);
    final rarity = r < 150
        ? 0 // ~59% common
        : r < 210
            ? 1 // ~23% uncommon
            : r < 240
                ? 2 // ~12% rare
                : r < 253
                    ? 3 // ~5% epic
                    : 4; // ~1% legendary

    final shiny = at(2) == 0; // ~1/256, verifiable

    final baseHp = 24 + (at(3) % 16) + rarity * 6;
    final baseAtk = 6 + (at(4) % 6) + rarity * 2;
    final baseSpd = at(5) % 14;

    return Blockling(
      seed: seed,
      speciesIndex: speciesIndex,
      rarity: rarity,
      shiny: shiny,
      baseHp: baseHp,
      baseAtk: baseAtk,
      baseSpd: baseSpd,
    );
  }
}
