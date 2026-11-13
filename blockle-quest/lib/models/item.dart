import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';

import 'blockling.dart' show kRarityNames, kRarityColors;

/// Equip slots / categories.
enum Slot { weapon, offhand, head, chest, hands, feet, ring, amulet, consumable, material }

extension SlotX on Slot {
  String get label => switch (this) {
        Slot.weapon => 'Weapon',
        Slot.offhand => 'Off-hand',
        Slot.head => 'Head',
        Slot.chest => 'Chest',
        Slot.hands => 'Hands',
        Slot.feet => 'Feet',
        Slot.ring => 'Ring',
        Slot.amulet => 'Amulet',
        Slot.consumable => 'Consumable',
        Slot.material => 'Material',
      };
}

class _Base {
  final String noun;
  final Slot slot;
  final int atk;
  final int def;
  final int hp;
  const _Base(this.noun, this.slot, {this.atk = 0, this.def = 0, this.hp = 0});
}

/// ~32 base types across every slot. Stat mix per base; prefix/suffix scale it.
const List<_Base> _bases = [
  _Base('Sword', Slot.weapon, atk: 6),
  _Base('Axe', Slot.weapon, atk: 8),
  _Base('Dagger', Slot.weapon, atk: 4),
  _Base('Spear', Slot.weapon, atk: 7),
  _Base('Mace', Slot.weapon, atk: 7, def: 1),
  _Base('Bow', Slot.weapon, atk: 6),
  _Base('Staff', Slot.weapon, atk: 5, hp: 4),
  _Base('Wand', Slot.weapon, atk: 5),
  _Base('Greatsword', Slot.weapon, atk: 11),
  _Base('Shield', Slot.offhand, def: 6, hp: 4),
  _Base('Buckler', Slot.offhand, def: 3),
  _Base('Tome', Slot.offhand, atk: 2, hp: 6),
  _Base('Helm', Slot.head, def: 3, hp: 3),
  _Base('Hood', Slot.head, def: 2, hp: 2),
  _Base('Crown', Slot.head, def: 2, hp: 6),
  _Base('Breastplate', Slot.chest, def: 6, hp: 8),
  _Base('Robe', Slot.chest, def: 2, hp: 10),
  _Base('Tunic', Slot.chest, def: 3, hp: 5),
  _Base('Gauntlets', Slot.hands, def: 2, atk: 2),
  _Base('Gloves', Slot.hands, def: 1, atk: 1),
  _Base('Greaves', Slot.feet, def: 3, hp: 2),
  _Base('Boots', Slot.feet, def: 2, hp: 1),
  _Base('Ring', Slot.ring, atk: 2, hp: 2),
  _Base('Band', Slot.ring, def: 2, hp: 2),
  _Base('Signet', Slot.ring, atk: 3),
  _Base('Amulet', Slot.amulet, hp: 8),
  _Base('Pendant', Slot.amulet, atk: 2, hp: 4),
  _Base('Charm', Slot.amulet, def: 2, hp: 4),
  _Base('Potion', Slot.consumable, hp: 20),
  _Base('Elixir', Slot.consumable, hp: 40),
  _Base('Scroll', Slot.consumable, atk: 10),
  _Base('Ore', Slot.material),
  _Base('Essence', Slot.material),
  _Base('Gem', Slot.material),
];

/// Material/quality prefixes (scale base stats).
const List<String> _prefixes = [
  'Rusty', 'Worn', 'Iron', 'Steel', 'Bronze', 'Silver', 'Crystal', 'Obsidian',
  'Ember', 'Frost', 'Storm', 'Ancient', 'Blessed', 'Cursed', 'Voltaic',
  'Verdant', 'Tidal', 'Gilded', 'Shadow', 'Radiant', 'Runed', 'Draconic',
  'Astral', 'Blockforged',
];

/// Affix suffixes (add a themed bonus).
const List<String> _suffixes = [
  'of Power', 'of the Bear', 'of Swiftness', 'of Embers', 'of the Tide',
  'of Warding', 'of Fortune', 'of the Spark', 'of Stone', 'of Gales',
  'of Leeching', 'of Precision', 'of Vigor', 'of the Ancients', 'of BLOCK',
];

/// A generated item. The full catalog is [catalogSize] =
/// bases × prefixes × suffixes distinct named items; `Item.at(i)` is the
/// deterministic item at a catalog index, and `Item.drop(seed)` rolls one from
/// a provably-fair seed (public chain data). Any item can be minted as an NFT
/// on a chosen chain (EconomyService.mintItem) — non-custodial, via the wallet.
class Item {
  final int baseIndex;
  final int prefixIndex;
  final int suffixIndex;
  final int rarity; // 0..4
  final int atk;
  final int def;
  final int hp;
  String? nftId;
  String? nftChain;

  Item({
    required this.baseIndex,
    required this.prefixIndex,
    required this.suffixIndex,
    required this.rarity,
    required this.atk,
    required this.def,
    required this.hp,
    this.nftId,
    this.nftChain,
  });

  static int get baseCount => _bases.length;
  static int get catalogSize => _bases.length * _prefixes.length * _suffixes.length;

  _Base get _base => _bases[baseIndex];
  Slot get slot => _base.slot;
  bool get minted => nftId != null;

  String get name => '${_prefixes[prefixIndex]} ${_base.noun} ${_suffixes[suffixIndex]}';
  String get rarityName => kRarityNames[rarity];
  Color get rarityColor => kRarityColors[rarity];

  /// Rough BLOCK value — scales with power and rarity.
  double get valueBlock {
    final power = atk * 4 + def * 3 + hp;
    return (power * (1 + rarity * 0.6)).clamp(1, 1e9) / 10.0;
  }

  /// Deterministic catalog index for this exact named+rarity item.
  int get catalogIndex =>
      (baseIndex * _prefixes.length + prefixIndex) * _suffixes.length + suffixIndex;

  Map<String, dynamic> toJson() => {
        'b': baseIndex,
        'p': prefixIndex,
        's': suffixIndex,
        'r': rarity,
        'atk': atk,
        'def': def,
        'hp': hp,
        'nftId': nftId,
        'nftChain': nftChain,
      };

  /// Build with stats derived from the base scaled by prefix tier + suffix bonus.
  factory Item._build(int baseIndex, int prefixIndex, int suffixIndex, int rarity) {
    final b = _bases[baseIndex];
    // Prefix tier: index position roughly = quality.
    final tier = 1.0 + prefixIndex * 0.14 + rarity * 0.5;
    int scale(int v) => (v * tier).round();

    var atk = scale(b.atk);
    var def = scale(b.def);
    var hp = scale(b.hp);

    // Suffix themed bonus.
    switch (suffixIndex) {
      case 0: // of Power
        atk += 2 + rarity;
      case 1: // of the Bear
        hp += 6 + rarity * 3;
      case 2: // of Swiftness
        atk += 1 + rarity;
      case 3: // of Embers
      case 7: // of the Spark
        atk += 2 + rarity;
      case 5: // of Warding
        def += 3 + rarity;
      case 8: // of Stone
        def += 2 + rarity;
        hp += 2 + rarity;
      case 12: // of Vigor
        hp += 4 + rarity * 2;
      case 14: // of BLOCK
        atk += 1 + rarity;
        def += 1 + rarity;
        hp += 3 + rarity;
      default:
        hp += 1 + rarity;
    }
    return Item(
      baseIndex: baseIndex,
      prefixIndex: prefixIndex,
      suffixIndex: suffixIndex,
      rarity: rarity,
      atk: atk,
      def: def,
      hp: hp,
    );
  }

  /// The item at a catalog index (rarity derived deterministically from the combo).
  factory Item.at(int index, {int? rarity}) {
    final i = index % catalogSize;
    final suffixIndex = i % _suffixes.length;
    final rest = i ~/ _suffixes.length;
    final prefixIndex = rest % _prefixes.length;
    final baseIndex = rest ~/ _prefixes.length;
    final r = rarity ?? (prefixIndex * 5 ~/ _prefixes.length).clamp(0, 4);
    return Item._build(baseIndex, prefixIndex, suffixIndex, r);
  }

  /// Provably-fair drop from a public seed (e.g. "block:<height>:drop:<n>").
  factory Item.drop(String seed) {
    final Uint8List h = Uint8List.fromList(sha256.convert(utf8.encode(seed)).bytes);
    int at(int i) => h[i % h.length];
    final baseIndex = at(0) % _bases.length;
    final prefixIndex = at(1) % _prefixes.length;
    final suffixIndex = at(2) % _suffixes.length;
    final rr = at(3);
    final rarity = rr < 150
        ? 0
        : rr < 210
            ? 1
            : rr < 240
                ? 2
                : rr < 253
                    ? 3
                    : 4;
    return Item._build(baseIndex, prefixIndex, suffixIndex, rarity);
  }
}
