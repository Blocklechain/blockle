# Blockle Idle

A cozy, portrait-only **idle civilization** game for mobile, built in **Godot 4.7.2**
with GDScript. You tend a floating island around an ancient **Heart Tree**, recruit
little creatures called **Blocklings**, raise whimsical buildings, research upgrades,
discover new realms, and ascend to grow a civilization that keeps working while you are
away.

"Blockle" is only a brand name. This is a wholesome storybook game.

---

## What it is, honestly

Blockle Idle is a **fully runnable Godot 4 idle game** with real systems and real,
balanced data — not a mockup. What runs today:

- **Resources** — Essence, Timber, Stone, Crystal, Stardust, Relics
  (`data/resources.json`), produced continuously.
- **Buildings** — 10 buildable structures with real cost/production curves
  (`data/buildings.json`), handled by `Economy`, `Buildings`, `Production`.
- **Blocklings** — 30 creatures across 6 rarities (`data/blocklings.json`): recruit,
  assign to buildings, level up, discover new species (`Blocklings`).
- **Research** — 7 branches / 35 nodes of upgrades (`data/research.json`, `Research`).
- **Realms** — 7 themed realms with unlock costs and production multipliers
  (`data/realms.json`, `Realms`).
- **Ascension** — prestige layer converting progress into lasting bonuses
  (`Ascension`).
- **Achievements** — `data/achievements.json`, checked each frame (`Achievements`).
- **Offline progress, saving, audio, cosmetics** — via the `Save`, `Offline`, `Audio`,
  `Cosmetics` autoloads.

**Art status:** the game currently renders with **clearly-labelled programmatic
placeholder art** — flat painted shapes drawn in code from each asset's `shape` and
`palette`/`color` fields, following the palettes in `ART_BIBLE.md`. The game is fully
playable and legible this way. Hand-painted storybook watercolour assets are produced
separately (see `art/prompts/`) and **drop straight in** at the paths listed in
`art/prompts/NAMING.md` with no code changes. Placeholders are never presented as final
art.

### What this game is NOT

- **No cryptocurrency.** No blockchain, wallets, tokens, NFTs, mining, or coins of any
  kind, anywhere in the game or the codebase. None.
- **No ads. No subscriptions. No pay-to-win. No loot boxes.** Core gameplay is never
  paywalled or gated behind spending.
- **Monetization is cosmetic-only** — optional visual flourishes (skins, palettes,
  decorations) that change nothing about progression or balance (`Cosmetics`, `IAP`).
- **No emoji** anywhere — not in code, UI, or art.

---

## Requirements

- **Godot 4.7.2 (stable)**. On this machine the editor binary is:
  `/Applications/Godot.app/Contents/MacOS/Godot`
- For iOS export: the **4.7.2.stable export templates** installed in Godot, plus a
  working **Xcode** toolchain. CI performs the iOS build.

---

## Open, run, export

**Open the project in the Godot editor**

```
/Applications/Godot.app/Contents/MacOS/Godot --editor --path /Volumes/ExtremePro/blockle/blockle-idle
```

**Run the game (windowed, from the command line)**

```
/Applications/Godot.app/Contents/MacOS/Godot --path /Volumes/ExtremePro/blockle/blockle-idle
```

**Headless smoke-run** (boots all autoloads, ticks production, then quits — used to
verify the project loads and the simulation runs without a display; ~180 frames):

```
/Applications/Godot.app/Contents/MacOS/Godot --headless --path /Volumes/ExtremePro/blockle/blockle-idle --quit-after 180
```

**iOS export** (CI does this on a machine with the toolchain):

1. Install the **Godot 4.7.2.stable export templates** (Editor → Manage Export
   Templates), or place them where CI expects.
2. Ensure **Xcode** and command-line tools are installed and licensed.
3. Export the **iOS** preset from `export/` (preset + signing config are managed by the
   CI workflow under `.github/workflows/`).
4. The export produces an Xcode project / IPA; signing and upload are handled by the CI
   pipeline.

Portrait orientation is enforced in the project settings; the game is designed for a
tall phone screen only.

---

## Directory structure

```
blockle-idle/
  project.godot            Godot project + autoload registration + portrait/display config
  README.md                this file
  ART_BIBLE.md             the strict visual bible (palettes, proportions, lighting, motion)

  data/                    the game's content, as JSON (treated as fixed contracts)
    resources.json         6 resources (id, name, color, shape)
    buildings.json         10 buildings (costs, production, art.shape/palette)
    blocklings.json        6 rarities + 30 Blocklings (shape, palette, profession)
    realms.json            7 realms (sky[], accent, unlock cost, prod_mult)
    research.json          7 branches / 35 research nodes
    achievements.json      achievement definitions

  scripts/
    autoload/              global singletons (see ART_BIBLE / CLAUDE contract)
      GameData.gd          loads data/*.json into arrays + *_by_id dicts
      Game.gd              state, save, resources, boot
      Economy.gd           building costs + purchase
      Production.gd        production rates + tick + tap value
      Buildings.gd         ownership, levels, slots, Blockling assignment
      Blocklings.gd        recruit, level, discover, bonuses
      Research.gd          unlocks + aggregate modifiers
      Realms.gd            realm unlock + switch
      Ascension.gd         prestige layer
      (Save, Offline, Audio, Achievements, Cosmetics, IAP — added as autoloads)
    util/
      Fmt.gd               class_name Fmt — static number/time/color formatting helpers

  scenes/                  Godot scenes (UI + gameplay screens)
  audio/                   music + sfx
  export/                  export presets / build output
  art/
    placeholder/           programmatic placeholder-art helpers
    prompts/               the hand-painted-art pipeline pack
      PROMPTS.md           Draw Things (M2) prompt pack for every priority asset
      NAMING.md            maps each prompt to the exact res:// path the game loads
```

### Where real art drops in

Hand-painted assets load from `res://art/...`. When a final painting is produced for an
asset, export it as a transparent PNG and save it at the exact path given in
`art/prompts/NAMING.md`, for example:

```
res://art/blocklings/pip.png
res://art/buildings/heart_tree.png
res://art/realms/verdant_bg.png
```

The game prefers a real asset at that path and falls back to the programmatic
placeholder when the file is absent, so art can be delivered incrementally with no code
changes.

---

## The art pipeline

See `ART_BIBLE.md` for the complete visual standard and `art/prompts/PROMPTS.md` for the
ready-to-run **Draw Things** prompts (optimized for Apple Silicon / M2). Produce the
**Heart Tree**, the **starting island**, and the **first five Blocklings** (Pip, Mossy,
Cobble, Quill, Ember) first — they lock the visual identity for everything else.
