import 'dart:math' as math;

import 'package:flutter/material.dart';

/// RuneScape-style skilling. 24 skills, each levelling 1→99 on the classic XP
/// curve, each with a tree of leveled actions ("stuff to do"). Combat skills
/// train from fighting; gathering/artisan skills train from their actions.

enum SkillCat { combat, gather, artisan, support }

class SkillAction {
  final String name;
  final int level; // required level
  final int xp; // xp per action
  const SkillAction(this.name, this.level, this.xp);
}

class Skill {
  final String name;
  final SkillCat cat;
  final Color color;
  final List<SkillAction> tree;
  const Skill(this.name, this.cat, this.color, this.tree);
}

// ---- XP curve (RuneScape formula, capped at 99 = 13,034,431 xp) -----------
int xpForLevel(int level) {
  if (level <= 1) return 0;
  double total = 0;
  for (var l = 1; l < level; l++) {
    total += (l + 300 * math.pow(2, l / 7.0)).floor();
  }
  return (total / 4).floor();
}

final List<int> _xpTable = List.generate(100, xpForLevel);

int levelForXp(int xp) {
  var lvl = 1;
  while (lvl < 99 && _xpTable[lvl + 1] <= xp) {
    lvl++;
  }
  return lvl;
}

/// Build a tree from (name, level) pairs; xp scales with the level requirement.
List<SkillAction> _tree(List<List<dynamic>> rows) =>
    [for (final r in rows) SkillAction(r[0] as String, r[1] as int, (8 + (r[1] as int) * 4))];

// ---- The 24 skills --------------------------------------------------------
const _c = SkillCat.combat, _g = SkillCat.gather, _a = SkillCat.artisan, _s = SkillCat.support;

final List<Skill> kSkills = [
  // Combat (7)
  Skill('Attack', _c, const Color(0xFFE5484D), _tree([['Train accuracy', 1, 0], ['Precise strikes', 20, 0], ['Master duelist', 50, 0], ['Legendary blade', 80, 0]])),
  Skill('Strength', _c, const Color(0xFF8BC34A), _tree([['Power hits', 1, 0], ['Crushing blows', 25, 0], ['Titan might', 60, 0], ['Worldbreaker', 90, 0]])),
  Skill('Defence', _c, const Color(0xFF4FC3F7), _tree([['Block', 1, 0], ['Iron skin', 30, 0], ['Warding', 60, 0], ['Aegis', 85, 0]])),
  Skill('Constitution', _c, const Color(0xFFFF7043), _tree([['Endurance', 1, 0], ['Second wind', 30, 0], ['Vitality', 70, 0]])),
  Skill('Ranged', _c, const Color(0xFF26A69A), _tree([['Shortbow', 1, 0], ['Longbow', 20, 0], ['Crossbow', 45, 0], ['Blockforged bow', 80, 0]])),
  Skill('Magic', _c, const Color(0xFF7C5CFF), _tree([['Spark bolt', 1, 0], ['Firestorm', 35, 0], ['Chain lightning', 60, 0], ['Astral nova', 90, 0]])),
  Skill('Prayer', _c, const Color(0xFFFFE082), _tree([['Bless', 1, 0], ['Protect', 40, 0], ['Divine shield', 70, 0]])),
  // Gathering (6)
  Skill('Mining', _g, const Color(0xFF9E8B6E), _tree([['Copper', 1, 0], ['Iron', 15, 0], ['Coal', 30, 0], ['Mithril', 55, 0], ['Adamant', 70, 0], ['Runite', 85, 0], ['BLOCK ore', 92, 0]])),
  Skill('Fishing', _g, const Color(0xFF4FC3F7), _tree([['Shrimp', 1, 0], ['Trout', 20, 0], ['Lobster', 40, 0], ['Swordfish', 50, 0], ['Shark', 76, 0]])),
  Skill('Woodcutting', _g, const Color(0xFF6FCF67), _tree([['Logs', 1, 0], ['Oak', 15, 0], ['Willow', 30, 0], ['Maple', 45, 0], ['Yew', 60, 0], ['Magic', 75, 0]])),
  Skill('Farming', _g, const Color(0xFF8BC34A), _tree([['Herbs', 1, 0], ['Allotments', 20, 0], ['Trees', 45, 0], ['Blockroot', 80, 0]])),
  Skill('Hunter', _g, const Color(0xFFB0BEC5), _tree([['Birds', 1, 0], ['Kebbits', 25, 0], ['Chinchompas', 55, 0], ['Astral beasts', 85, 0]])),
  Skill('Foraging', _g, const Color(0xFF9CCC65), _tree([['Berries', 1, 0], ['Mushrooms', 20, 0], ['Rare flora', 50, 0]])),
  // Artisan (7)
  Skill('Smithing', _a, const Color(0xFFBCAAA4), _tree([['Bronze', 1, 0], ['Iron', 15, 0], ['Steel', 30, 0], ['Mithril', 50, 0], ['Adamant', 70, 0], ['Rune', 85, 0], ['Blockforged', 95, 0]])),
  Skill('Crafting', _a, const Color(0xFFCE93D8), _tree([['Leather', 1, 0], ['Gems', 20, 0], ['Jewelry', 40, 0], ['Dragonhide', 63, 0]])),
  Skill('Cooking', _a, const Color(0xFFFF8A65), _tree([['Bread', 1, 0], ['Stew', 25, 0], ['Pie', 45, 0], ['Feast', 70, 0]])),
  Skill('Fletching', _a, const Color(0xFFA1887F), _tree([['Arrows', 1, 0], ['Shortbow', 20, 0], ['Longbow', 40, 0], ['Blockforged bow', 85, 0]])),
  Skill('Runecrafting', _a, const Color(0xFF9575CD), _tree([['Air rune', 1, 0], ['Fire rune', 35, 0], ['Blood rune', 77, 0], ['BLOCK rune', 90, 0]])),
  Skill('Alchemy', _a, const Color(0xFFFFD54F), _tree([['Transmute copper', 1, 0], ['High alchemy', 55, 0], ['Item → BLOCK', 70, 0]])),
  Skill('Construction', _a, const Color(0xFF8D6E63), _tree([['Shed', 1, 0], ['Workshop', 30, 0], ['Guildhall', 60, 0], ['Block citadel', 90, 0]])),
  // Support (4)
  Skill('Agility', _s, const Color(0xFF4DB6AC), _tree([['Gnome course', 1, 0], ['Barbarian', 35, 0], ['Rooftops', 60, 0], ['Astral course', 90, 0]])),
  Skill('Thieving', _s, const Color(0xFF90A4AE), _tree([['Pickpocket', 1, 0], ['Stalls', 25, 0], ['Chests', 50, 0], ['Vaults', 80, 0]])),
  Skill('Slayer', _s, const Color(0xFF78909C), _tree([['Low tasks', 1, 0], ['Elite tasks', 50, 0], ['Boss tasks', 85, 0]])),
  Skill('Blockchain', _s, const Color(0xFF7C5CFF), _tree([['Mine BLOCK', 1, 0], ['Validate', 40, 0], ['Mint relics', 70, 0], ['Forge NFTs', 90, 0]])),
];

int skillIndex(String name) => kSkills.indexWhere((s) => s.name == name);

/// Live skill XP + levels.
class SkillsState extends ChangeNotifier {
  SkillsState._();
  static final SkillsState instance = SkillsState._();

  final List<int> xp = List.filled(kSkills.length, 0);

  int level(int i) => levelForXp(xp[i]);
  int xpOf(int i) => xp[i];
  int get totalLevel => List.generate(kSkills.length, level).fold(0, (a, b) => a + b);

  /// Add xp to a skill by name; returns true if it leveled up.
  bool addXp(String name, int amount) {
    final i = skillIndex(name);
    if (i < 0) return false;
    final before = level(i);
    xp[i] += amount;
    notifyListeners();
    return level(i) > before;
  }

  /// Progress 0..1 toward the next level for skill i.
  double progress(int i) {
    final lvl = level(i);
    if (lvl >= 99) return 1;
    final cur = _xpTable[lvl], next = _xpTable[lvl + 1];
    return ((xp[i] - cur) / (next - cur)).clamp(0.0, 1.0);
  }
}
