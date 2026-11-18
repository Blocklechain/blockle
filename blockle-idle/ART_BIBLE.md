# Blockle Idle — Art Bible

The single source of truth for how Blockle Idle looks. Every painted asset, every
placeholder, every UI tint must obey this document. When a drawn asset and this
bible disagree, the bible wins and the asset is repainted.

All hex values here are pulled directly from the game data (`data/realms.json`,
`data/resources.json`, `data/blocklings.json`, `data/buildings.json`) so the art
and the simulation stay in lockstep. If a value changes in data, change it here too.

No cryptocurrency, no logos, no text baked into art, no emoji. "Blockle" is only a
brand name.

---

## 1. Overall Direction

Blockle Idle is a **storybook** world: a hand-painted **watercolour and gouache**
picture book that happens to be a living, growing civilization. Think a well-loved
children's picture book — soft washes, visible brushwork, warm paper underneath
everything — not a slick vector mobile game and not pixel art.

Guiding adjectives, in priority order:

1. **Cozy** — the player should feel they are tending a small warm world.
2. **Whimsical** — rounded, friendly, a little magical; nothing sharp or grim.
3. **Painterly** — every surface shows the hand that made it: washes, dry-brush,
   soft bleeds, a faint paper tooth.
4. **Readable** — even wrapped in watercolour, every Blockling, building and
   resource reads instantly at thumbnail size.

Tone is gentle wonder. The world is calm and slightly dreamlike. Nothing is urgent;
the island breathes.

### Medium rules
- Watercolour **washes** for large soft areas (sky, water, distant hills).
- **Gouache** for the solid, confident shapes of foreground subjects (Blocklings,
  buildings) so they pop against the washes.
- **Painted edges**, never hard vector outlines. Where an edge is needed it is a
  darker value of the fill drawn with a brush, slightly irregular, sometimes broken.
- Visible **paper grain** throughout (see §6).

---

## 2. Master Palette

The master palette is the six **resource colours**. These are the anchor hues of the
entire game; every other colour on screen is a neighbour, tint or shade of one of
these. Resource icons, production numbers, progress fills and any UI that refers to a
resource use its exact hex.

| Resource  | Hex       | Role in the palette                         |
|-----------|-----------|---------------------------------------------|
| Essence   | `#7FE3B0` | The signature green — life, growth, magic.  |
| Timber    | `#C9955B` | Warm wood brown — the "built world" neutral.|
| Stone     | `#9AA3AD` | Cool grey — structure, patience.            |
| Crystal   | `#8FB8FF` | Soft sky-blue — stored magic, technology.   |
| Stardust  | `#C79BFF` | Violet — the cosmic, the rare, progression. |
| Relics    | `#FFC978` | Warm gold — the ancient, the precious.      |

Two support neutrals used everywhere (paper and ink):

- **Paper warm white** `#FBF6E9` — the base paper tone; the lightest value in most
  scenes, also the default light-UI background wash.
- **Ink brown** `#3A2E22` — the darkest value; used for the softest shadow cores and
  painted-edge accents. Never pure black (`#000000`) anywhere in the art.

**Rule:** a single asset uses at most three resource-family hues plus the two
neutrals. More than that and the painting turns muddy.

---

## 3. Per-Realm Palettes

Each realm is a mood, defined by its three **sky** values (far → near gradient) and a
single **accent** that keys its foreground magic, rim light and signature props. Pull
these straight from `data/realms.json`. The resource hues from §2 still appear inside
each realm (a Lumber Grove is always Timber-brown), but the **sky wash + accent** set
the overall temperature.

| Realm (order)          | Sky far → mid → near             | Accent    | Mood                                   |
|------------------------|----------------------------------|-----------|----------------------------------------|
| 1 Verdant Beginning    | `#8FD3C4` `#D9F2E6` `#FBF6E9`     | `#2E7D4F` | Dawn-fresh, hopeful, soft green day.   |
| 2 Crystal Hollow       | `#2A2350` `#4C3A80` `#8FB8FF`     | `#8FB8FF` | Deep cavern dark lit by glowing blue.  |
| 3 The Skylands         | `#AED4FF` `#E7F2FF` `#FFF4D6`     | `#5C7CC4` | High, bright, airy, windswept.         |
| 4 Forgotten Wilds      | `#16281F` `#2E5E43` `#9CF0B0`     | `#9CF0B0` | Enchanted-dark forest, bioluminescent. |
| 5 Frostfall            | `#B7D6E8` `#E4F1F7` `#FFFFFF`     | `#9ED3EA` | Pale, cold, hushed, snow-bright.       |
| 6 The Astral Realm     | `#140C33` `#3B2A6B` `#C79BFF`     | `#C79BFF` | Cosmic night, celestial violet.        |
| 7 The First Kingdom    | `#2B1B08` `#7A4E1E` `#FFC978`     | `#FFC978` | Warm amber dusk, golden and ancient.   |

**How to read the sky triplet:** paint the far band (index 0) at the horizon/top,
blend through the mid band (index 1), to the near band (index 2) nearest the island.
Verdant and Skylands are light realms (near value is nearly paper white); Crystal
Hollow, Forgotten Wilds, Astral and First Kingdom are **dark realms** where the near
value is the bright accent emerging from darkness.

**Realm discipline:**
- A realm's **accent** is the only colour allowed to glow. Rim light, magical motes,
  crystal veins, firelight and UI highlights inside that realm all key to the accent.
- Dark realms (2, 4, 6, 7) rely on the accent and the resource hues for all their
  pop; keep saturation low everywhere else so the glow reads.
- Light realms (1, 3, 5) get their interest from warm/cool contrast, not brightness —
  push warm paper (`#FBF6E9` / `#FFF4D6`) against the cool sky washes.

---

## 4. Characters — The Blocklings

Blocklings are the heart of the game's charm. There are 30 of them across six
rarities. Every one must feel like it belongs to the same family of drawings.

### Proportions
- **Chibi / big-head.** Head is roughly **1/2 of total height**. Body is a single
  rounded mass; limbs are small, soft and stubby.
- Overall footprint is a **soft upright egg or rounded blob** — wider at the base,
  settled, never top-heavy despite the big head.
- Eyes are large, round, warm and **set low and wide** on the face; a tiny highlight
  in each. Mouths are minimal — a small curve. No visible teeth, no sharp features.
- **No humanoid faces, no realistic anatomy.** They are gentle creature-shapes.

### Silhouette rules
- Each Blockling must be **identifiable in pure black silhouette** by its `shape`
  field alone. The silhouette carries the species; colour only confirms it.
- One **signature silhouette feature** per species, drawn large and clear: Pip's
  single curling sprout-leaf, Quill's owlet ear-tufts and book, Ember's cat ears and
  tail, Mossy's little garden-hump, Cobble's perfectly round pebble body.
- Silhouettes stay **simple and chunky** — readable at 64px. No thin spindly bits
  except where the shape demands it (Twig the stickbug), and even then kept bold.
- Rarity never changes the silhouette; a Common and a Mythic of the same `shape`
  share a body plan. Rarity is told by colour richness and aura (below).

### Colour & rarity
- Each species paints from its own two-colour `palette` (`data/blocklings.json`):
  the first hex is the **body / main mass**, the second is the **accent** (belly,
  leaf, ears, markings). Stay within these two plus the paper/ink neutrals.
- **Rarity aura:** a soft painted rim-glow behind the Blockling, keyed to its rarity
  colour — Common `#B9C2CC`, Uncommon `#7FE3B0`, Rare `#8FB8FF`, Epic `#C79BFF`,
  Legendary `#FFC978`, Mythic `#FF9BB0`. Commons get the faintest wash; higher
  rarities get a stronger, warmer glow and a few drifting motes in the aura colour.
  Rarity is read from the glow, never from redrawing the creature.

### The first five (lock these first — they define the family)
| Blockling | shape    | rarity   | body / accent        | signature feature              |
|-----------|----------|----------|----------------------|--------------------------------|
| Pip       | sprout   | Common   | `#86C06C` / `#3F6B3A`| one curling sprout-leaf on head|
| Mossy     | mossling | Common   | `#4F8A5B` / `#7FE3B0`| tiny garden/moss hump on back  |
| Cobble    | pebble   | Common   | `#9AA3AD` / `#6E7680`| perfectly round smooth stone   |
| Quill     | owlet    | Common   | `#C9955B` / `#E8C39E`| ear-tufts + a little book      |
| Ember     | cat      | Uncommon | `#E08A4A` / `#FFC978`| cat ears, curled tail, warm glow|

---

## 5. Lighting

One gentle, consistent light model across the whole game.

- **Soft warm key** from the **upper-left**, low and diffuse — like late-afternoon
  sun through a window. No hard cast shadows; shadows are soft, warm-grey, and sit
  directly under the subject as a contact blob.
- **Gentle magical rim** on the opposite (lower-right) edge of foreground subjects,
  keyed to the **current realm's accent** colour. This is the "magic in the air" —
  always present, always subtle. In dark realms the rim is the main thing that lifts a
  subject off the background.
- **Ambient occlusion by paint**, not by filter: the crevices between forms get a soft
  deeper wash of the local hue, never a grey multiply.
- Highlights are **warm** (toward `#FBF6E9`), cores are **warm-dark** (toward
  `#3A2E22`). The whole game leans warm even in the cold realms, which keeps Frostfall
  pale-and-cozy rather than clinical.
- Light sources inside the scene (crystal veins, firelight, the Heart Tree's core,
  observatory lenses) glow in the **realm accent** and cast a soft local wash on
  nearby surfaces.

---

## 6. Materials & Texture

- **Paper grain everywhere.** A faint, consistent cold-press watercolour-paper tooth
  sits under the entire image at low opacity. It unifies painted assets and
  placeholders alike and is the single most important "storybook" signal.
- **Painted edges:** darker-value brush edges, slightly irregular, occasionally
  broken or dry-brushed. Never a uniform vector stroke, never pure black.
- **Washes vs. body:** backgrounds are translucent watercolour washes that let the
  paper show through; foreground subjects are more opaque gouache so they sit forward.
- **Pigment behaviour:** allow soft **blooms and backruns** where two wet washes meet,
  and a little **granulation** in large sky and stone areas. These "imperfections" are
  the look — keep them.
- **No photographic textures, no gradients-from-a-tool, no gloss/plastic highlights,
  no hard specular.** Metal (Aurum, Pyrite, relics) is gold gouache with a soft
  warm highlight, not a chrome reflection.
- Edges of every asset fade slightly into the paper rather than clipping hard.

---

## 7. Environment & Perspective

- **Portrait orientation only.** Every scene is composed tall (9:16-ish). The island
  is centred; sky fills the top, the island body and its roots fill the middle, and
  foreground foliage/water frames the bottom.
- **Slightly-above 3/4 island view.** The camera looks down onto a **floating island**
  at a gentle 3/4 angle — we see the top surface where buildings sit *and* a little of
  the island's underside and dangling roots. Not top-down, not side-on.
- **Floating islands.** Every realm's "ground" is an island adrift in that realm's sky
  — a rounded chunk of land with roots, rock or crystal trailing beneath it.
- **Layered parallax**, back to front:
  1. **Sky wash** (realm sky triplet), slowest.
  2. **Far silhouettes** — distant islands, peaks, cloud banks in a desaturated
     realm-accent tint.
  3. **Mid / island body** — the main island surface, buildings, Blocklings.
  4. **Foreground frame** — a few near leaves, grasses, rocks or motes, fastest, at
     the very bottom edge, slightly soft-focused.
- Depth is told by **atmospheric perspective**: distant layers lose contrast and shift
  toward the sky's far value; near layers are warm, saturated and crisp.

---

## 8. Architecture

Buildings are **organic, rounded and whimsical** — grown or lovingly hand-built, never
industrial or gridded.

- **Rounded everything:** soft domes, bulging walls, curved rooflines, chunky
  proportions. No sharp right angles, no straight skyscrapers, no machinery.
- Buildings look like they **grew out of the island** or were raised by the
  Blocklings' own hands: timber that still remembers being a tree, stone that keeps
  its boulder roundness, crystal that sprouts in clusters.
- Each building paints from its `art.palette` three-colour set
  (`data/buildings.json`) and reads at a glance by its `art.shape`:

  | Building            | shape       | palette (main / accent / detail)        |
  |---------------------|-------------|-----------------------------------------|
  | Heart Tree          | tree        | `#2E7D4F` / `#7FE3B0` / `#C9955B`        |
  | Lumber Grove        | grove       | `#3F6B3A` / `#C9955B` / `#86C06C`        |
  | Stone Quarry        | quarry      | `#9AA3AD` / `#6E7680` / `#C9955B`        |
  | Crystal Mine        | mine        | `#8FB8FF` / `#5C7CC4` / `#9AA3AD`        |
  | Essence Garden      | garden      | `#7FE3B0` / `#2E7D4F` / `#C79BFF`        |
  | Blockling Homes     | homes       | `#C9955B` / `#E8C39E` / `#3F6B3A`        |
  | Research Library    | library     | `#5C7CC4` / `#C79BFF` / `#C9955B`        |
  | Explorer's Lodge    | lodge       | `#C9955B` / `#3F6B3A` / `#FFC978`        |
  | Ancient Observatory | observatory | `#C79BFF` / `#5C7CC4` / `#FFC978`        |
  | Relic Temple        | temple      | `#FFC978` / `#C79BFF` / `#9AA3AD`        |

- The **Heart Tree** is the hero structure and the island's centre and tallest point:
  a great gnarled tree with a softly **glowing core** (`#7FE3B0`), warm amber light in
  its hollows, roots that wrap and dream the island into being. Everything else is
  visually subordinate to it.
- **Warm windows:** inhabited buildings (Homes, Library, Lodge) show small round
  windows glowing warm gold from inside — a core cozy signal.
- Level-ups make a building **bigger and more elaborate** (more fronds, more crystal
  clusters, taller dome) rather than changing its silhouette identity.

---

## 9. Animation Principles

Everything moves a little, all the time, gently. The world is alive but never busy.

- **Breathing idle:** every Blockling and the Heart Tree scale up/down ~2–4% on a slow
  2–4 second sine — a soft breath. Offset each creature's phase so a crowd isn't
  synchronised.
- **Gentle sway:** foliage, grasses, hanging roots, banners and clouds drift on a slow
  horizontal sine, far layers slower than near. Driven by a notional soft breeze from
  the upper-left (matching the key light).
- **Squash on interaction:** tapping the Heart Tree (or any Blockling) gives a quick
  **squash-and-stretch** — compress ~8–12% then overshoot back with a soft bounce —
  plus a short burst of accent-coloured motes. This is the game's primary tactile
  feedback; it must feel soft and springy, never snappy or mechanical.
- **Arrivals:** a newly built building and a newly recruited Blockling **pop in** with
  a small bounce and a ring of accent motes, then settle into their idle breath.
- **Resource ticks:** production floats a tiny resource-coloured number/mote upward
  that fades out — soft, slow, rewarding.
- **Timing is slow and eased.** Everything uses gentle ease-in-out; nothing is linear
  or abrupt. If an animation feels urgent, it is wrong.
- All motion respects the player's reduce-motion setting: when off, idles damp to a
  near-still, interactions stay (feedback is essential) but are softened.

---

## 10. Placeholder Policy

Until hand-painted assets exist, the game ships **clearly-labelled programmatic
placeholder art**: flat painted shapes drawn in code from the exact `shape` and
`palette`/`color` fields in `data/`, over the paper-grain base, keyed to the per-realm
palettes above. Placeholders obey this bible's palettes and silhouettes so the game is
fully legible and the transition to real art is a drop-in replacement (see
`art/prompts/NAMING.md`). Placeholders are never mistaken for final art — they are
honest, flat, and labelled as such in the project README.

---

## 11. Priority Order

Lock the visual identity before producing volume. Paint in this order:

1. **Heart Tree** (hero, Verdant palette).
2. **Starting island** (Verdant background + island body).
3. **The first five Blocklings:** Pip, Mossy, Cobble, Quill, Ember.

Everything the whole game's look rests on is in those seven images. Approve them, then
fan out to the remaining buildings, the other 25 Blocklings, and the six later realms.
