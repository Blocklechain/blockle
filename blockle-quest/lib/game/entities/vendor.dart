import 'dart:ui';

import 'package:flame/components.dart';
import 'package:flutter/painting.dart';

import '../../economy/economy.dart';
import '../../models/item.dart';
import '../../theme.dart';
import '../blocklings_game.dart';

/// A single item for sale at a vendor, priced in crypto.
class ShopEntry {
  final Item item;
  final Chain chain;
  final double price;
  const ShopEntry(this.item, this.chain, this.price);
}

/// A merchant NPC (market stall). Sells normal (non-NFT) items for crypto;
/// purchases route to the treasury and 90% backs BLOCK via Liquidity (see
/// EconomyService.buyFromVendor). Stock is generated deterministically from the
/// vendor seed, so every vendor is distinct and stable.
class Vendor extends PositionComponent {
  final String name;
  final int seed;
  late final List<ShopEntry> stock;

  Vendor({required this.name, required this.seed, required Vector2 position}) {
    this.position = position;
    size = Vector2.all(30);
    anchor = Anchor.center;
    priority = position.y.round();
    const chains = [Chain.blockle, Chain.blockle, Chain.blockle, Chain.ethereum, Chain.solana];
    stock = List.generate(8, (i) {
      final item = Item.at(seed * 131 + i * 17 + 3);
      final chain = chains[(seed + i) % chains.length];
      final double price = chain == Chain.blockle
          ? double.parse((item.valueBlock * 2 + 1).toStringAsFixed(1))
          : double.parse((item.valueBlock / 600 + 0.001).toStringAsFixed(4));
      return ShopEntry(item, chain, price);
    });
  }

  final Paint _p = Paint();

  @override
  void render(Canvas canvas) {
    final game = findGame();
    if (game is! BlocklingsGame) return;
    canvas.save();
    canvas.translate(-position.x, -position.y);
    final s = game.project(position.x, position.y);
    final sc = game.scaleAt(s.y);
    const w = 30.0;
    // Ground shadow.
    _p.color = const Color(0x55000000);
    canvas.drawOval(Rect.fromCenter(center: Offset(s.x, s.y), width: 26 * sc, height: 9 * sc), _p);
    // Market stall, upright, feet at s.
    canvas.translate(s.x - w / 2 * sc, s.y - w * sc);
    canvas.scale(sc);
    _p.color = const Color(0xFF6B4A2F);
    canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromLTWH(0, w * 0.5, w, w * 0.5), const Radius.circular(3)), _p);
    for (var i = 0; i < 4; i++) {
      _p.color = i.isEven ? Bq.accent : const Color(0xFFEDEDF4);
      canvas.drawRect(Rect.fromLTWH(i * w / 4, 0, w / 4, w * 0.3), _p);
    }
    _p.color = const Color(0xFF3A2A66);
    canvas.drawRect(Rect.fromLTWH(0, w * 0.3, w, 3), _p);
    _p.color = Bq.xp;
    canvas.drawCircle(Offset(w * 0.5, w * 0.62), 3, _p);
    canvas.restore();
  }

  /// Build a few vendors near a world point (deterministic by cell).
  static String nameFor(int seed) {
    const a = ['Gilda', 'Benly', 'Mara', 'Orin', 'Pell', 'Suki', 'Tovik', 'Wenna'];
    const b = ["'s Wares", "'s Emporium", "'s Trading Post", "'s Bazaar", "'s Outfitters", "'s Goods"];
    return '${a[seed % a.length]}${b[(seed ~/ 3) % b.length]}';
  }

  double distanceToPlayer(Vector2 playerPos) => position.distanceTo(playerPos);
}
