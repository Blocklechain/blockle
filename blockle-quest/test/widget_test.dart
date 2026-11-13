import 'package:flutter_test/flutter_test.dart';

import 'package:blockle_quest/models/item.dart';
import 'package:blockle_quest/models/blockling.dart';
import 'package:blockle_quest/world/zones.dart';
import 'package:blockle_quest/quests/quests.dart';
import 'package:blockle_quest/skills/skills.dart';

void main() {
  test('world has 100 zones with unique names', () {
    expect(Zones.count, 100);
    expect(Zones.all.map((z) => z.name).toSet().length, 100);
  });

  test('exactly 1000 quests', () {
    expect(generateQuests().length, 1000);
  });

  test('24 skills, RuneScape xp curve to 99', () {
    expect(kSkills.length, 24);
    expect(xpForLevel(99), 13034431);
    expect(levelForXp(13034431), 99);
  });

  test('item catalog has thousands of unique items', () {
    expect(Item.catalogSize, greaterThan(10000));
  });

  test('item generation is deterministic (provably fair)', () {
    final a = Item.drop('block:2100000:drop:1');
    final b = Item.drop('block:2100000:drop:1');
    expect(a.name, b.name);
    expect(a.atk, b.atk);
    expect(a.catalogIndex, b.catalogIndex);
  });

  test('blockling generation is deterministic', () {
    final a = Blockling.fromSeed('starter:blockle');
    final b = Blockling.fromSeed('starter:blockle');
    expect(a.name, b.name);
    expect(a.rarity, b.rarity);
    expect(a.shiny, b.shiny);
  });

  test('catalog index round-trips through Item.at', () {
    final it = Item.at(3195);
    expect(it.catalogIndex, 3195);
  });
}
