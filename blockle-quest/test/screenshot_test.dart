import 'package:flame/flame.dart';
import 'package:flame/game.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:blockle_quest/account/character.dart';
import 'package:blockle_quest/game/blocklings_game.dart';

/// Renders the REAL game (BlocklingsGame via GameWidget) into golden PNGs so a
/// human can see what Blockle Quest looks like. No HUD overlays are registered
/// — we render the bare GameWidget, so no fonts/UI matter. Multiplayer is off,
/// so no sockets open.
///
///   flutter test --update-goldens test/screenshot_test.dart
///
/// Why it is shaped this way: Flame decodes sprites asynchronously, and the
/// component mount queue (TileMap / Player / villages / buildings) is only
/// drained by the real game loop. Inside `tester.runAsync` the loop does not
/// drain that queue, so the components never mount and the frame renders black.
/// The reliable recipe is: pre-decode every sprite into the global Flame image
/// cache inside `runAsync`, THEN pump the GameWidget with the normal game loop
/// (outside runAsync) — cache hits let each component's onLoad resolve and the
/// loop mounts everything and streams the world in.
void main() {
  const surface = Size(1170, 540);

  // Every sprite the world, characters, companions and buildings use.
  final images = [
    'tiles/ash.png', 'tiles/blockstone.png', 'tiles/bog.png', 'tiles/fence.png',
    'tiles/grass.png', 'tiles/grassAlt.png', 'tiles/path.png', 'tiles/rock.png',
    'tiles/sand.png', 'tiles/snow.png', 'tiles/tallGrass.png', 'tiles/tree.png',
    'tiles/water.png',
    'chars/ember.png', 'chars/gust.png', 'chars/leaf.png', 'chars/player.png',
    'chars/spark.png', 'chars/stone.png', 'chars/tide.png',
    'buildings/blockhall.png', 'buildings/cabin.png', 'buildings/hall.png',
    'buildings/house.png', 'buildings/inn.png', 'buildings/shop.png',
    'buildings/tower.png',
    // Whole-zone painted scene patches (the ground).
    for (final t in [
      'meadow', 'forest', 'swamp', 'desert', 'tundra', 'volcanic',
      'crystal', 'ruins', 'shore', 'blocklands', 'village_ground',
    ])
      for (var v = 0; v < 4; v++) 'scenes/${t}_$v.png',
    // Standalone props (trees + upright fences).
    'props/oak_0.png', 'props/oak_1.png', 'props/pine_0.png', 'props/pine_1.png',
    'props/fence_0.png', 'props/fence_1.png',
  ];

  CharacterProfile makeProfile() => CharacterProfile(
        name: 'Adventurer',
        starterElement: 0,
        multiplayer: false,
      );

  /// Pump [game] with the real game loop and settle enough frames for sprites
  /// to mount and for villages/buildings/vendors to stream in around the focus.
  Future<void> pumpGame(WidgetTester tester, BlocklingsGame game) async {
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        home: RepaintBoundary(
          key: const ValueKey('shot'),
          child: GameWidget(game: game),
        ),
      ),
    );
    // 60 real-loop frames: mounts the tree, advances the Mode-7 tilt, and lets
    // the ~10Hz streamer place villages/buildings/vendors near the focus.
    for (var i = 0; i < 60; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
  }

  testWidgets('world_village + title_cinematic goldens', (tester) async {
    await tester.binding.setSurfaceSize(surface);
    addTearDown(() => tester.binding.setSurfaceSize(null));

    // Pre-decode all sprites into the global Flame cache (needs runAsync).
    await tester.runAsync(() => Flame.images.loadAll(images));

    // 1) In-world shot: drop out of the title cinematic so the camera centres
    //    on the player at the village spawn (buildings + fences visible).
    final world = BlocklingsGame(profile: makeProfile());
    world.cinematic = false;
    await pumpGame(tester, world);
    await expectLater(
      find.byKey(const ValueKey('shot')),
      matchesGoldenFile('goldens/world_village.png'),
    );

    // 2) Village gate shot: walk the player to the spawn zone's west border so
    //    the upright fence line, the gate gap and scattered trees are in frame.
    final gate = BlocklingsGame(profile: makeProfile());
    gate.cinematic = false;
    await pumpGame(tester, gate);
    gate.player.position.setValues(243 * 32.0, 264 * 32.0);
    for (var i = 0; i < 30; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
    await expectLater(
      find.byKey(const ValueKey('shot')),
      matchesGoldenFile('goldens/village_gate.png'),
    );

    // 3) Title cinematic shot: a fresh game left in cinematic mode, the camera
    //    drifting over the world.
    final title = BlocklingsGame(profile: makeProfile());
    // cinematic defaults to true — leave it.
    await pumpGame(tester, title);
    await expectLater(
      find.byKey(const ValueKey('shot')),
      matchesGoldenFile('goldens/title_cinematic.png'),
    );
  });
}
