import 'package:flutter_test/flutter_test.dart';

import 'package:blockle_quest/models/item.dart';
import 'package:blockle_quest/models/blockling.dart';

void main() {
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
