import 'package:flutter/material.dart' hide Element;

import '../economy/economy.dart';
import '../models/blockling.dart' show Element, ElementX;
import '../models/item.dart';
import '../world/zones.dart';

enum QuestType { slay, gather, explore, ascend, mint, trade, skill }

/// A single quest. Objectives are matched against game events by the [QuestLog].
class Quest {
  final int id;
  final QuestType type;
  final String title;
  final String desc;
  final int target;

  // Matchers (null = any).
  final int? zoneId;
  final Element? element;
  final int? minRarity; // gather
  final int? reqLevel; // ascend / display gate
  final String? skill; // skill
  final int rewardBlock;
  final int? rewardItemIndex;

  int progress = 0;
  bool done = false;

  Quest({
    required this.id,
    required this.type,
    required this.title,
    required this.desc,
    required this.target,
    required this.rewardBlock,
    this.zoneId,
    this.element,
    this.minRarity,
    this.reqLevel,
    this.skill,
    this.rewardItemIndex,
  });

  double get frac => (progress / target).clamp(0.0, 1.0);
}

/// Deterministically generate exactly 1000 quests — 10 per zone across the 100
/// zones. Variety comes from the zone's theme/element/tier.
List<Quest> generateQuests() {
  final quests = <Quest>[];
  const skillNames = ['Mining', 'Fishing', 'Woodcutting', 'Smithing', 'Cooking', 'Magic', 'Slayer', 'Blockchain'];
  var id = 0;
  for (final z in Zones.all) {
    for (var k = 0; k < 10; k++) {
      final tierR = (z.tier + 1);
      final reward = tierR * 4 + k * 2;
      final t = QuestType.values[(z.id * 7 + k) % QuestType.values.length];
      Quest q;
      switch (t) {
        case QuestType.slay:
          final n = 5 + tierR * 3 + k;
          q = Quest(
            id: id, type: t, target: n, zoneId: z.id, element: z.elementBias, rewardBlock: reward,
            title: 'Cull the ${z.elementBias.label} of ${z.name}',
            desc: 'Defeat $n ${z.elementBias.label} Blocklings in ${z.name}.',
          );
        case QuestType.gather:
          final rarity = (z.tier ~/ 2).clamp(0, 4);
          final n = 3 + k;
          q = Quest(
            id: id, type: t, target: n, minRarity: rarity, rewardBlock: reward,
            title: 'Supplies for ${z.name}',
            desc: 'Collect $n items of ${['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'][rarity]}+ rarity.',
            rewardItemIndex: (z.id * 91 + k * 7) % Item.catalogSize,
          );
        case QuestType.explore:
          final dest = Zones.all[(z.id + 1) % Zones.count];
          q = Quest(
            id: id, type: t, target: 1, zoneId: dest.id, rewardBlock: reward,
            title: 'Chart ${dest.name}',
            desc: 'Travel to and explore ${dest.name}.',
          );
        case QuestType.ascend:
          final lvl = 3 + z.tier * 5 + k;
          q = Quest(
            id: id, type: t, target: lvl, reqLevel: lvl, rewardBlock: reward,
            title: 'Grow stronger (Lv $lvl)',
            desc: 'Reach character level $lvl.',
          );
        case QuestType.mint:
          final n = 1 + (k ~/ 4);
          q = Quest(
            id: id, type: t, target: n, rewardBlock: reward,
            title: 'Immortalize your spoils',
            desc: 'Mint $n item/Blockling NFT${n > 1 ? 's' : ''} on Blockle, Ethereum or Solana.',
          );
        case QuestType.trade:
          final n = 1 + (k ~/ 5);
          q = Quest(
            id: id, type: t, target: n, rewardBlock: reward,
            title: 'Merchant of ${z.name}',
            desc: 'Sell $n NFT${n > 1 ? 's' : ''} on the marketplace.',
          );
        case QuestType.skill:
          final sk = skillNames[(z.id + k) % skillNames.length];
          final lvl = 5 + z.tier * 6;
          q = Quest(
            id: id, type: t, target: lvl, skill: sk, reqLevel: lvl, rewardBlock: reward,
            title: 'Apprentice of $sk',
            desc: 'Train $sk to level $lvl.',
          );
      }
      quests.add(q);
      id++;
    }
  }
  return quests;
}

/// Tracks all quests and advances them from game events, paying rewards.
class QuestLog extends ChangeNotifier {
  QuestLog._();
  static final QuestLog instance = QuestLog._();

  final List<Quest> quests = generateQuests();
  final _econ = EconomyService.instance;

  /// Most recent completion, for a toast.
  String? lastCompleted;

  int get completedCount => quests.where((q) => q.done).length;

  Iterable<Quest> get active =>
      quests.where((q) => !q.done).take(80); // tracked window; full log browsable

  void _advance(Quest q, int by) {
    if (q.done) return;
    q.progress += by;
    if (q.progress >= q.target) {
      q.done = true;
      q.progress = q.target;
      _econ.credit(Chain.blockle, q.rewardBlock.toDouble());
      if (q.rewardItemIndex != null) _econ.addItem(Item.at(q.rewardItemIndex!));
      lastCompleted = q.title;
    }
    notifyListeners();
  }

  void onKill(int zoneId, Element element) {
    for (final q in quests) {
      if (q.type == QuestType.slay &&
          (q.zoneId == null || q.zoneId == zoneId) &&
          (q.element == null || q.element == element)) {
        _advance(q, 1);
      }
    }
  }

  void onGather(int rarity) {
    for (final q in quests) {
      if (q.type == QuestType.gather && rarity >= (q.minRarity ?? 0)) _advance(q, 1);
    }
  }

  void onExplore(int zoneId) {
    for (final q in quests) {
      if (q.type == QuestType.explore && q.zoneId == zoneId && !q.done) _advance(q, q.target);
    }
  }

  void onLevel(int level) {
    for (final q in quests) {
      if (q.type == QuestType.ascend && level >= q.target && !q.done) _advance(q, q.target);
    }
  }

  void onSkill(String name, int level) {
    for (final q in quests) {
      if (q.type == QuestType.skill && q.skill == name && level >= q.target && !q.done) _advance(q, q.target);
    }
  }

  void onMint() {
    for (final q in quests) {
      if (q.type == QuestType.mint) _advance(q, 1);
    }
  }

  void onTrade() {
    for (final q in quests) {
      if (q.type == QuestType.trade) _advance(q, 1);
    }
  }
}
