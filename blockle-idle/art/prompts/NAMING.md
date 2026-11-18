# Blockle Idle — Asset Naming Map

Each prompt in `PROMPTS.md` maps to one **exact** in-game file path. Export the chosen
generation as a PNG and save it at the path below and it drops straight in — the game
loads real art from `res://art/...` and falls back to programmatic placeholders when a
file is absent. No code changes are needed.

**Export rules**
- Characters & buildings: **transparent-background PNG**, square, subject centred with
  margin. Trim excess transparent padding but keep a little breathing room.
- Realm backgrounds: **opaque PNG**, portrait 9:16, full-bleed.
- Filenames are **lowercase, exactly the `id` from `data/`** plus a suffix where noted.
  Do not rename ids — the loader keys off them.

---

## Priority assets (make these first)

| Prompt          | File path                                  |
|-----------------|--------------------------------------------|
| Heart Tree      | `res://art/buildings/heart_tree.png`       |
| Starting island | `res://art/realms/verdant_bg.png`          |
| Pip             | `res://art/blocklings/pip.png`             |
| Mossy           | `res://art/blocklings/mossy.png`           |
| Cobble          | `res://art/blocklings/cobble.png`          |
| Quill           | `res://art/blocklings/quill.png`           |
| Ember           | `res://art/blocklings/ember.png`           |

---

## Buildings  (`res://art/buildings/<id>.png`)

Ids from `data/buildings.json`.

| Building            | File path                                      |
|---------------------|------------------------------------------------|
| Heart Tree          | `res://art/buildings/heart_tree.png`           |
| Lumber Grove        | `res://art/buildings/lumber_grove.png`         |
| Stone Quarry        | `res://art/buildings/stone_quarry.png`         |
| Crystal Mine        | `res://art/buildings/crystal_mine.png`         |
| Essence Garden      | `res://art/buildings/essence_garden.png`       |
| Blockling Homes     | `res://art/buildings/blockling_homes.png`      |
| Research Library    | `res://art/buildings/research_library.png`     |
| Explorer's Lodge    | `res://art/buildings/explorers_lodge.png`      |
| Ancient Observatory | `res://art/buildings/ancient_observatory.png`  |
| Relic Temple        | `res://art/buildings/relic_temple.png`         |

---

## Realm backgrounds  (`res://art/realms/<id>_bg.png`)

Ids from `data/realms.json`. (Verdant's background is the "starting island" priority
asset above.)

| Realm               | File path                                     |
|---------------------|-----------------------------------------------|
| Verdant Beginning   | `res://art/realms/verdant_bg.png`             |
| Crystal Hollow      | `res://art/realms/crystal_hollow_bg.png`      |
| The Skylands        | `res://art/realms/skylands_bg.png`            |
| The Forgotten Wilds | `res://art/realms/forgotten_wilds_bg.png`     |
| Frostfall           | `res://art/realms/frostfall_bg.png`           |
| The Astral Realm    | `res://art/realms/astral_bg.png`              |
| The First Kingdom   | `res://art/realms/first_kingdom_bg.png`       |

---

## Blocklings  (`res://art/blocklings/<id>.png`)

Ids from `data/blocklings.json`. The first five are the priority set above; the
remaining 25 follow once the family is approved.

| Blockling | File path                              |
|-----------|----------------------------------------|
| pip       | `res://art/blocklings/pip.png`         |
| mossy     | `res://art/blocklings/mossy.png`       |
| cobble    | `res://art/blocklings/cobble.png`      |
| fen       | `res://art/blocklings/fen.png`         |
| quill     | `res://art/blocklings/quill.png`       |
| burrow    | `res://art/blocklings/burrow.png`      |
| dewdrop   | `res://art/blocklings/dewdrop.png`     |
| twig      | `res://art/blocklings/twig.png`        |
| flint     | `res://art/blocklings/flint.png`       |
| clover    | `res://art/blocklings/clover.png`      |
| ember     | `res://art/blocklings/ember.png`       |
| willow    | `res://art/blocklings/willow.png`      |
| bramble   | `res://art/blocklings/bramble.png`     |
| sable     | `res://art/blocklings/sable.png`       |
| inky      | `res://art/blocklings/inky.png`        |
| pyrite    | `res://art/blocklings/pyrite.png`      |
| breeze    | `res://art/blocklings/breeze.png`      |
| lumen     | `res://art/blocklings/lumen.png`       |
| thorne    | `res://art/blocklings/thorne.png`      |
| opal      | `res://art/blocklings/opal.png`        |
| marrow    | `res://art/blocklings/marrow.png`      |
| fable     | `res://art/blocklings/fable.png`       |
| gale      | `res://art/blocklings/gale.png`        |
| verdania  | `res://art/blocklings/verdania.png`    |
| aurum     | `res://art/blocklings/aurum.png`       |
| nocturne  | `res://art/blocklings/nocturne.png`    |
| basalt    | `res://art/blocklings/basalt.png`      |
| solenne   | `res://art/blocklings/solenne.png`     |
| sylvaan   | `res://art/blocklings/sylvaan.png`     |
| cosmyra   | `res://art/blocklings/cosmyra.png`     |

Prompts for the 25 beyond the first five follow the same per-species formula in
`PROMPTS.md`: shared Blockling tokens + the species `shape`, its two-colour `palette`
(body / accent), its signature silhouette feature, and its rarity glow colour from the
rarity table in `ART_BIBLE.md`.

---

## Resource icons (optional, later)  (`res://art/resources/<id>.png`)

Small painted icons keyed to each resource colour/shape in `data/resources.json`
(`essence` spark, `timber` log, `stone` block, `crystal` gem, `stardust` star,
`relics` rune). Placeholders cover these until painted.
