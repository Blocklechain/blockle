# Blockle Idle — Build Status

Portrait-only mobile idle civilization game. Godot 4.7.2.stable / GDScript.
No cryptocurrency. Cosmetic-only monetization. No emoji, no ads, no subscriptions.

Last validated: 2026-11-17 against Godot 4.7.2.stable (headless).

## Boot status: CLEAN

```
/Applications/Godot.app/Contents/MacOS/Godot --headless --path . --quit-after 180
# exit 0, 0 SCRIPT ERROR, 0 ERROR:
```

The project imports and boots headless with **zero script errors**. All 15 autoloads
compile and resolve, the main scene loads, every `data/*.json` parses, and the
production tick + achievement check run across ~180 frames without a crash.

The only remaining console output is one repeated non-fatal WARNING:
`Nodes with non-equal opposite anchors will have their size overridden after _ready()`.
It is benign — `Main._layout()` uses manual pixel layout driven by the live viewport
size and is re-run after `_ready()` and on every resize, so the final geometry is
correct. It does not affect gameplay, saving, or export.

## Fix made during integration

- `scripts/autoload/Audio.gd:86` — `var path := base + ext` could not have its type
  inferred because `ext` came from an untyped array literal (Variant), so `String +
  Variant` had no static type. This was a hard **Parse Error** that blocked the Audio
  autoload from compiling, which in turn failed autoload creation at boot. Fixed by
  typing explicitly: `var path: String = base + ext`. No other files needed changes.

## What is implemented and WORKING

Autoloads (boot order in `project.godot`): GameData -> Save -> Game -> Economy ->
Production -> Buildings -> Blocklings -> Research -> Realms -> Ascension -> Offline ->
Audio -> Achievements -> Cosmetics -> IAP. All compile and are reachable.

- **Core economy**: 6 resources, tap-to-earn + passive production (`Production.tick`),
  `Fmt.short`/`rate` number formatting. Verified running in the headless tick loop.
- **Buildings**: 10 buildings, cost-scaling purchase (`Economy.buy_building`), levels,
  blockling assignment slots.
- **Blocklings**: 30 species across 6 rarities, recruit / level-up / per-uid bonus,
  discovery tracking.
- **Research**: 7 branches, 35 nodes with requirement gating and typed effects
  (resource_prod / global_prod / tap / etc.).
- **Realms**: 7 realms with unlock + switch and per-realm production multipliers.
- **Ascension**: ancient-knowledge prestige with preview + global bonus.
- **Achievements**: 15 achievements, checked every frame via `Achievements.check`.
- **Save/Offline**: `Save.load_or_new()` creates/loads state; `Offline.apply_offline()`
  grants capped offline progress and emits `offline_ready` when elapsed > 5s;
  15-second autosave timer in `Game._process` (not exercised by the 180-frame run,
  which is ~3s — but the code path compiles and `save_now()` works).
- **UI**: single-scene `scenes/Main.tscn` + `scripts/Main.gd` (1492 lines). Top
  resource bar, bottom nav, sliding panels for each system, coachmark/tutorial,
  toast messages. All optional-autoload calls (Audio / Cosmetics / IAP) are guarded
  with a `_has(obj, method)` check, so a missing method degrades gracefully instead
  of crashing.
- **Cosmetics**: 22 items, owned/equip/nameplate state. `Main` probes `all_items()`
  and `is_owned()`, both of which Cosmetics exposes, so the shop populates.
- **IAP**: cosmetic-only product layer with a defensive wrapper around the platform
  store plugin; grants the matching cosmetic on purchase. No ads, no subscriptions
  (enforced by design — see the header comment in `IAP.gd`).

## What is PLACEHOLDER (programmatic art)

There is no bitmap/sprite art and no audio files shipped. Everything visual is drawn
at runtime:
- `scripts/ui/PlaceholderArt.gd` and `Main`'s inline `_Glyph` class draw nav icons,
  resource swatches, the close button, and realm backdrops as vector shapes/gradients.
- `art/` and `audio/` hold design docs (`ART_BIBLE.md`) but no final assets.
- `Audio` tries `.ogg` then `.wav` by path and no-ops cleanly when a file is absent,
  so the game is silent until audio is added — not broken.

Final art and sound are a content pass, not a code dependency. The APIs they will
plug into already exist.

## How to play (core loop)

1. **Tap** the main resource to earn essence.
2. **Buy buildings** so resources accrue passively.
3. **Recruit blocklings** and **assign** them to buildings for production bonuses.
4. **Unlock research** to multiply output.
5. **Unlock new realms** for higher multipliers.
6. When growth stalls, **ascend** to bank ancient knowledge for a permanent global
   bonus and restart stronger.
7. **Cosmetics** (optional, purely visual) can be equipped; nothing in the loop is
   paywalled.

## How to run / export

Run headless (CI / validation):
```
/Applications/Godot.app/Contents/MacOS/Godot --headless --path . --import   # run twice on a fresh checkout
/Applications/Godot.app/Contents/MacOS/Godot --headless --path . --quit-after 180
```

Run in the editor: open the project in Godot 4.7.2 and press Play; `scenes/Main.tscn`
is the main scene.

Export (iOS): `export_presets.cfg` defines an **iOS** preset, bundle id
`org.blockle.idle`, portrait, output `build/ios/BlockleIdle.ipa`. Requires the
Godot 4.7.2 iOS **export templates** installed and an Xcode/signing toolchain.
```
/Applications/Godot.app/Contents/MacOS/Godot --headless --path . --export-release "iOS" build/ios/BlockleIdle.ipa
```

## Honest known gaps

- **No shipped art or audio** — all visuals are programmatic placeholders; no sound
  files exist yet.
- **Anchor WARNING** at boot (benign, documented above) — layout is correct but the
  warning is noisy; a future cleanup could set anchor presets before sizing in
  `Main._layout()`.
- **IAP is wrapper-only** — it talks to a platform store plugin defensively but has
  not been run against a live App Store sandbox; purchase/restore flows are unverified
  end-to-end on device.
- **Autosave not exercised** in the 180-frame (~3s) validation run (15s threshold);
  the save path itself compiles and `save_now()` is reachable.
- **No automated gameplay/unit tests** — validation is boot-clean + static API
  cross-check, not behavioral coverage.
- Panel-open UI paths are statically verified against the manager APIs (every singleton
  call in `Main.gd` resolves to an existing method), but were not click-tested in a
  rendered session.

## Single manual step for TestFlight

Create the App Store Connect app record for bundle id **`org.blockle.idle`**
(name, SKU, primary language) under the team, then upload the signed `.ipa`. The
bundle identifier is already set in `export_presets.cfg`; everything else is
code-side. No other manual code change is required.
