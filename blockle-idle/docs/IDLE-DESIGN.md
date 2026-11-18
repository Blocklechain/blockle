# Blockle Idle — Game Design Document

**One living screen. No menus but the tray. Everything grows.**

This is the authoritative design for Blockle Idle's reinvention as a **menu-less,
procedurally-generated 2D idle simulation**. It resolves the brief into something
buildable and binds every other agent (proc-art modules, the tray, the puzzle
layer, the placement system) to one coherent contract. Where this document and a
stray older assumption disagree, **this document wins.**

Read alongside: `scripts/proc/CONVENTIONS.md` (the seven hard rules + the Proc
toolkit), `scripts/autoload/Proc.gd`, `scripts/proc/ProcNode.gd`,
`scripts/autoload/GameData.gd`, and `data/*.json`. All art is generated from math
— no imported images, no emoji, no pre-baked assets.

---

## 0. The pitch in one breath

You answer a single open question — *"Where do you start your journey?"* — and that
sentence **seeds an entire world**: its island shape, its colour mood, its weather,
the creatures that will wander it, the first puzzle written into its ground. From
then on there is no menu, no tabs, no numbers shouting at you. There is a gorgeous
portrait world you can drag around with your thumb, a small tray of living things at
the bottom you can pull out and plant, and a world that **grows the whole time —
continuously, very slowly, online and offline**. You tend it. You solve the quiet
light-and-water-and-root puzzles written into the land to coax new ground awake. You
watch seedlings you planted this morning become trees by tonight. When something
becomes precious to you, you can mint it — which *stops its growth*, pressing it like
a flower in a book — and place it back later to let it live again.

It is calm. You cannot lose. You can only make it more beautiful.

---

## 1. What "idle simulation" means here

Blockle Idle is an **idle simulation**, not an idle *clicker*. The verbs are *tend,
place, coax, watch* — never *grind*. The core loop is "arrange beautiful living
things, then let time make them beautiful-er."

### 1.1 What accrues on its own

Three things grow without the player doing anything, all **continuous and VERY slow**:

1. **Form-growth (the headline).** Every placed thing is a `ProcNode` with
   `growth ∈ [0,1]` that creeps upward every frame via `grow_rate`
   (`ProcNode._process`). A planted seed *visibly becomes* a sprout, a sapling, a
   mature tree — never a pop, always a creep. This is the primary "number going up,"
   except the number is **the shape itself**. Default maturity is ~25 real minutes
   (`ProcNode.grow_rate`); designers retune per class with `set_grow_minutes()` (see
   §4.2). This replaces the old "level" concept as the felt progression.

2. **Resource-accrual.** The six resources (`data/resources.json`:
   `essence, timber, stone, crystal, stardust, relics`) still tick up via the
   existing `Production` / `Game` economy — but the rate is now a **readout of the
   living world**, not of menu purchases. A Lumber Grove that is 40% grown produces
   ~40% of its mature rate; a fully-bloomed Essence Garden produces full rate. Rate
   `= Σ building.base_prod · realm.prod_mult · g(building.growth) · kin_bonus`. The
   player grows production by *planting and tending*, not by tapping a buy button.

3. **Life-accrual.** Wandering Blocklings, discoveries, and the slow drift of
   weather/season. New kin occasionally *arrive on their own* (walk in from the world
   edge) when Homes capacity and Essence allow — a diegetic replacement for the
   "Recruit" button.

### 1.2 Soft diminishing returns, no grind

- **Growth self-limits.** `growth` asymptotes at 1.0. A mature thing stops getting
  bigger; it just *lives* (sways, breathes). There is nothing to spam.
- **Density falloff.** The world is clamped (§2.5) and ground is finite until you
  *earn* more by solving puzzles (§3). You cannot carpet-bomb the island — space
  itself is the soft cap. More land is a puzzle reward, not a currency sink.
- **Offline is generous but curved.** On wake, `Game` computes elapsed seconds and
  advances each entity's `growth` and each resource stockpile by that elapsed time,
  then applies a **soft diminishing curve**: full credit for the first ~8 hours,
  tapering to ~50% effective rate out to a ~48h cap. Rationale: a player who checks
  in twice a day should feel *rewarded and caught-up*, never punished, never obliged.
  The wake is shown diegetically (§2.4), not as a spreadsheet popup.
- **No timers to babysit, no energy, no ads-for-doublers.** The only monetisation is
  cosmetic (`data/cosmetics.json`, `IAP`) and optional NFT minting (§5). Power is
  never for sale.

> **Design law:** if a feature creates an obligation to return at a specific minute,
> cut it. Idle here means *the world is patient with you.*

---

## 2. Menu-less interaction — the diegetic world

The entire nav-bar / tabs / slide-up-panel / modal stack is **removed**. There is
exactly **one** piece of chrome: the **bottom Inventory Tray**. Everything else is
done by touching the world itself.

### 2.1 Exactly what to delete from `scripts/Main.gd`

Main.gd currently assembles a full menu UI. The following are **deleted** (both the
`_build_*` call in `_ready()` and the function + its state + its refreshers):

| Delete | Functions / state to remove | Why |
|---|---|---|
| **Top resource bar** | `_build_bar`, `_make_chip`, `_refresh_bar`, `_bar`, `_chips`, `_bar_h` | Resources shown diegetically (§2.4) |
| **Realm strip** | `_build_strip`, `_refresh_strip`, `_pick_weather`, `_strip*`, `_strip_h`, `_weather_word` | Realm/weather read from sky + world, not a text strip |
| **Bottom 5-tab nav** | `_build_nav`, `_on_nav`, `_refresh_nav`, `_nav`, `_nav_items`, `_nav_h`, `TAB_IDS/LABELS/GLYPH` | Replaced by the Tray + touching the world |
| **Slide-up panel + all tab bodies** | `_build_panel`, `_open_panel`, `_close_panel`, `_rebuild_panel_body`, `_tab_title`, `_panel*`, `_panel_open`, `_current_tab`, and **every** `_fill_*_panel`, `_*_card`, `_realm_row`, `_fill_assign_box`, `_assign_label`, `_cycle_assign`, `_journal_cell`, `_achievement_row`, `_research_card` | All of these become in-world actions (§2.3) or world-edge gestures |
| **Coachmark tutorial** | `_build_coach`, `_tutorial_text`, `_update_coach`, `_advance_tutorial`, `_check_tutorial_progress`, `_coach*` | Replaced by a one-line diegetic whisper (§2.6) |
| **Modal menus** | `_open_store`, `_store_row`, `_open_wallet`, `_wallet_collectible_row`, `_show_modal`, `_close_all_modals`, `_confirm_ascend`, `_confirm_reset` | Store/wallet/ascend become **world objects** you touch (§2.7) |
| **HUD toast** | `_build_toast`, `_show_toast`, `_toast*` | Replaced by in-world floating text (`_spawn_float`, already exists) |
| **Panel helpers used nowhere else** | `_card`, `_btn`, `_icon_button`, `_slider_row`, `_hsep`, `_vsep`, `_cost_str`, `_art_thumb` (keep only if the Tray reuses them) | Chrome builders |

**Kept and generalised in Main.gd:** `_build_world`, the `_process` world-animation
loop, `_make_island`/`_blob_poly`, `_build_fx`, all entrance/FX helpers (`_pop_in`,
`_fade_in`, `_spawn_puff`, `_spawn_float`, `_circle_poly`), `_recompute_insets`
(safe-area for the Tray), and the offline hook `_on_offline_ready` (reframed, §2.4).
The `_tap_tree` logic generalises into the universal "tap a placed thing" handler
(§2.3). **Do not** let any agent other than Main's owner edit Main.gd; the deletions
above are a spec for that owner, and the contract the rest of us build against.

> Net result: Main.gd goes from "world behind a UI" to "world, plus a Tray." The
> `_world` Node2D becomes the whole game.

### 2.2 The one menu — the Inventory Tray

A single **bottom tray**, anchored above the safe-area inset (`_inset_bot`), ~180px
tall, a soft parchment shelf (`PanelContainer`, the game's `PARCH`/`INK` palette). It
is the *only* panel in the game. Built by a new module (the Tray agent):
`scripts/proc/ProcTray.gd` or similar, mounted by Main's owner as a sibling of
`_world`.

- **Contents:** a horizontally-scrolling row of **item chips**. Each chip is a live
  `ProcNode` thumbnail (a tiny breathing tree, a glowing crystal, a curled-up
  Blockling) over a count badge. Items are: seeds/saplings (become trees &
  decorations), building-plans (become buildings), kin-eggs (become Blocklings),
  and special items (puzzle pieces, minted NFTs ready to re-place). The tray reads
  the player's holdings from `Game.state` (an `inventory` dict — the Tray/economy
  agent defines its shape; suggested `{item_key: {count, kind, species/building_id,
  growth_snapshot}}`).
- **Idle tray state:** half-height "handle" peeking at the bottom showing 3-4 chips;
  a short upward drag expands it. It auto-collapses when you start placing. It never
  covers more than the bottom ~20% of the screen.
- **No sub-tabs inside it.** Categories are just colour-sorted runs in the one scroll
  row. If you own nothing in a category, it simply isn't there.

### 2.3 Every item is placeable — drag it onto the world

This is the heart of the menu-less design. **Interaction = drag-from-tray-and-plant,
or tap-a-placed-thing.**

**Placing (drag out of the tray):**
1. **Pick up.** Touch-down on a tray chip lifts a **ghost preview** — the real
   `ProcNode` art at `growth ≈ 0.08` (a seed/sprout), rendered at ~45% opacity,
   following the finger.
2. **Ghost + validity.** While dragging over the world, the ghost **snaps to valid
   ground** (see snap rules below) and tints: soft-green glow = plantable here,
   soft-red/greyed = invalid (over water for a land plant, off-island, overlapping
   another thing's footprint, or over locked/dormant ground). A faint ring shows the
   thing's footprint radius.
3. **Place.** Release on valid ground → the item is consumed from the tray, a real
   `ProcNode` is added to `_world` at the snap point, `pop_in()` plays (seed unfurls),
   `_spawn_puff` fires, and from that instant its `growth` starts creeping via
   `grow_rate`. Release on invalid ground → the ghost springs back into the tray.

**Snap & valid-ground rules (the placement agent owns `scripts/proc/ProcPlace.gd`):**
- Ground is the island surface (the `_island` polygon) plus any **awoken** expansion
  land (§3). Snap the feet-origin (§7 of CONVENTIONS: feet at y=0) to the ground
  contour at the finger's x.
- **Footprint test:** each `ProcNode` exposes `footprint_radius: float` (mature
  radius). Reject placement whose footprint overlaps an existing thing's footprint by
  more than ~30% (gentle — nestling is allowed and encouraged, §2.3a).
- **Material gating by ground type:** water plants (`lilypad`, `reed`, `pond`) snap
  only to water tiles; land things reject water; buildings need a **level-enough**
  patch (see "buildings level ground" in §2.3a).
- Snapping is forgiving and *tactile*: ease the ghost to the snap point over ~80ms so
  it feels magnetic, not rigid.

**Tapping a placed thing (replaces the old tab menus entirely):**
A short tap on any placed `ProcNode` raises a small **floating in-world action
bubble** anchored just above the thing (not a modal — a 1-3 button radial/pill that
fades after ~3s or on outside-tap). Actions are context-chosen by entity kind:
- **Nurture** — spend a pinch of essence to nudge `growth` up (a `grow_to`
  bump) and refresh the thing. This is the generalised `_tap_tree`: the Heart Tree's
  tap still gives essence; a sapling's tap *feeds* it.
- **Harvest / Collect** — on mature producers, pluck accrued resources (floating
  `_spawn_float` number), briefly dipping the thing's glow then letting it refill.
- **Inspect** — a whisper-line of diegetic text (name + one poetic stat) drifting up;
  no panel. For a Blockling this is its species/`desc` from `data/blocklings.json`.
- **Assign** (Blocklings only) — tap a Blockling, then tap a building, to send it to
  work (replaces the assign panel/`_cycle_assign`). The Blockling *walks over* and
  nestles at the building. Tap again to send it wandering.
- **Pick up / Uproot** — long-press returns a placed thing to the tray **preserving
  its current `growth`** (so you can rearrange your garden without losing age). This
  is also how you move things.
- **Mint** — appears only on sufficiently-mature, precious things (§5).

### 2.3a Placed things ADAPT to their surroundings

A planted thing is not a decal; it reads its neighbourhood on placement (and
re-reads on `_on_growth` milestones) and adapts — this is what makes the world feel
*composed by nature*, not stamped. The placement agent passes a small `Context`
dict into each `ProcNode` on placement; modules honour it:

- **Local palette drift.** Each thing tints toward the **local** `Proc.palette` of
  its realm + a position-seeded local hue (so a flower in a blue-crystal hollow runs
  cooler than the same flower in the verdant start). Blend ~25% toward local, keep
  75% of the species' own palette so it stays recognisable.
- **Scale by neighbours & elevation.** Things placed on higher/outer ground run a
  touch smaller (windswept); in sheltered clusters they run a touch fuller.
- **Lean to light.** Every world has a **light source** (the Heart Tree's glow by
  day, the realm sky's warm side). Plants and trees bias their canopy/`rotation` and
  their sway pivot *toward* it — a field of saplings all lean the same gentle way.
  Expose `light_dir: Vector2` in the Context; modules apply a few-degree canopy skew.
- **Nestle by neighbours.** On placement near others within ~1.5 footprints, a thing
  nudges its base a few px toward tucking under/beside the neighbour and picks a
  complementary `phase` so a cluster sways in a loose round, not in lockstep.
- **Buildings level ground.** A building, on placement, flattens a small apron of
  ground beneath it (the placement agent writes a short flat segment into the local
  ground contour + draws a subtle stone/earth terrace), and orients its facade to
  face the camera/path. Decorations then snap to that terrace edge.
- **Orientation/flip** is seed-chosen per instance (as `WorldGen.plot` already does
  for buildings) so repeats don't read as copies.

### 2.4 Status is diegetic — no HUD panels

No resource bar, no rate labels, no badges. The world *shows* its state:

- **Resource stockpiles** live as **physical motes/orbs drifting up from their
  source** and pooling at the Heart Tree's roots as a soft luminous heap whose size
  and colour mix encode your reserves (more essence = greener, brighter pool). A tap
  on the Heart Tree still harvests (the kept `_tap_tree`) and shows the `_spawn_float`
  number — numbers appear *on demand, in place*, never persistently.
- **Production rate** is legible as **flow**: a busy Lumber Grove visibly sheds timber
  motes faster. You read your economy by watching the traffic of light across the
  island.
- **"Ready to harvest"** = a gentle pulsing glow + a few orbiting motes on the thing
  (cheap shader/transform anim per CONVENTIONS rule 5). **"Needs nurture/stalled"** =
  motes thin out and the colour desaturates slightly. **"Growing well"** = occasional
  rising sparkle.
- **Weather/realm** is read straight from the procedural **sky + lighting** (the
  realm's `sky` colours from `data/realms.json`), not a text strip. A rain mood
  literally rains; a crystal hollow is literally dark and glittering.
- **Offline wake** (reuse `_on_offline_ready`): instead of a popup, the world **plays
  the catch-up as a short diegetic time-lapse** — on first frame after a long away,
  motes stream into the root-pool, a seedling you left visibly finishes unfurling,
  and a single soft whisper-line drifts up: *"The island grew while you were away."*
  Tapping anywhere skips to now.

### 2.5 The world is scrollable, gently clamped

- **Drag-pan.** A drag on empty world pans a `Camera2D` (or `_world` offset). Portrait
  1080×1920; the world canvas is **only slightly larger than the screen** — clamp the
  camera so you can pan at most ~1 screen-width horizontally and ~1.3 screens
  vertically beyond the start view (enough to feel like a place, bounded enough that
  you never get lost). As the world expands via puzzles (§3), the clamp **grows with
  it** so new land is reachable, always with the same "just-beyond-the-edge" margin.
- **Rubber-band** at the borders (overscroll eases back) so the edge feels soft, not
  like a wall.
- **No zoom** in v1 (keeps art scale predictable and performant). A pinch may be added
  later as pure camera zoom within a tight range.
- Pan and the tray must not fight: a drag that *starts on a tray chip* is a place
  gesture; a drag that starts on empty world is a pan; a drag that starts on a placed
  thing is a long-press-to-pick-up vs tap disambiguation (hold ~250ms = pick up).

### 2.6 Tutorial = one whisper, then silence

No coachmarks. The very first session shows a single drifting whisper-line over the
Heart Tree: *"Pull something from your basket. Plant it anywhere."* Once the player
places their first thing, it never appears again. One more whisper appears the first
time a puzzle's ground glows (§3): *"The ground here is sleeping. Help it wake."*
That is the entire tutorial.

### 2.7 Former modals become world objects

- **Store / Wallet / Mint:** a small **market stall / wishing-well** object sits on
  the island. Tapping it opens the cosmetic store and wallet flow *as an in-world
  action bubble sequence*, not a full modal. (The underlying `Cosmetics`, `IAP`,
  `Wallet` autoloads are unchanged; only their presentation moves in-world.)
- **Travel between realms:** reached by **panning to the island's edge**, where a
  **cloud-bridge / cave-mouth / stair** stands for each unlocked realm (from
  `data/realms.json`). Walking the camera onto it travels (replaces `_realm_row`).
  Locked realms show a dim, half-grown gate whose unlock cost appears as a whisper on
  tap. Realm `prod_mult` still applies.
- **Ascension** becomes the Heart Tree's own deep ritual: when eligible
  (`Ascension.can_ascend()`), the Heart Tree gains a slow golden bloom; a long-press
  on its trunk raises the "return the world to its beginning" confirm bubble.

---

## 3. The in-screen puzzles — the core interactive layer

Puzzles are the game's *active* verb between stretches of idle. They are **calm,
beautiful, procedurally generated, unlosable** (no timers, no fail state — you can
walk away mid-puzzle and the pieces wait), and every one is **tied to growth or
expansion**. They are drawn as living parts of the world, never as a minigame popup.
Three types ship in v1. The puzzle agent owns `scripts/proc/ProcPuzzle.gd` (+ one
subclass per type); each is a `ProcNode` region seeded from `(world_seed,
puzzle_key)` so the same world always poses the same puzzles and new worlds differ.

### 3.1 Lightweave — route the light (growth puzzle)

**Where:** a **shaded hollow** on the island — a dell the Heart Tree's light can't
reach, so the ground there is grey and nothing you plant will grow past `growth≈0.2`.

**Pieces:** a small set of **prisms, lenses and mirror-leaves** (crystal-material
`ProcNode`s) you drag from the tray or from fixed sockets, and can **rotate** by tap.
A beam of warm light emits from a fixed Sun-Stone (or the Heart Tree). The beam is a
glowing procedural polyline that **refracts/reflects** off each prism you place. The
layout (beam origin, the shaded target bloom-stones, a few fixed blocker rocks) is
seed-generated and gentle — always solvable, usually 2-4 pieces.

**Goal:** bend the beam so it touches every **bloom-stone** in the dell.

**Reward:** the dell's ground **wakes to green** and becomes fully plantable (its
plants can now reach `growth=1.0`), plus a one-time **essence bloom** and a chance to
reveal a rare decoration variant. Ties to growth: *light is literally what lets
things grow here.*

**Beauty & anim:** beams shimmer and pulse; prisms throw soft caustic sparkles; on
solve, light floods the dell and a wave of grass unfurls outward (a `grow_to` cascade
across the dell's decorations).

### 3.2 Rootwork — weave the ley-lines (expansion puzzle)

**Where:** the **edge of the known island**, where a cluster of **dormant seed-nodes**
floats in mist just past the border.

**Pieces:** you **draw root-paths with your finger** from the Heart Tree's live root
out to each dormant node. Classic one-line / flow logic on a **seed-generated organic
node graph** (nodes on a jittered hex-ish lattice from `Proc.noise`): each path must
reach a node, **paths may not cross**, and together they must connect **all** nodes
without leaving any isolated. Roots glow and pulse as you draw; an illegal crossing
simply won't take (the root recoils softly — no error, no penalty).

**Goal:** connect every dormant seed-node to the root network with non-crossing paths.

**Reward:** the dormant nodes **sprout into new ground** — a fresh patch of island
unfurls (grows in via `pop_in` over a few seconds), **expanding the world** and the
camera clamp (§2.5), and often carrying a new resource vein (a crystal seam, a timber
grove site) and new plantable plots. This is the primary engine of world expansion —
the "ever-expanding world" of §4.3 is literally built by solving Rootwork puzzles.

**Beauty & anim:** roots are smooth Catmull-Rom (`Proc.smooth_loop`) ribbons with a
travelling light pulse; on solve, bioluminescent sap rushes out to each node and the
new land blooms open like a time-lapse.

### 3.3 Bloomtide — guide the water (growth + terrace puzzle)

**Where:** a **terraced slope** with a spring at the top and **dry flower-beds** on
lower terraces that won't bloom without water.

**Pieces:** short **channel-stones / sluice-gates** you place and **rotate** to form a
continuous watercourse from the spring down across the terraces. Water flows by simple
seeded downhill rules through whatever channel you build; some terraces have fixed
rock you must route around. Layout is seed-generated and always solvable.

**Goal:** route the spring so water reaches every dry bed.

**Reward:** watered beds **bloom** (their decorations jump to full `growth` and gain a
flowering variant), the terrace becomes a permanent high-yield **Essence Garden**
patch, and the running water stays as a living water feature (ripple shader) that
raises the whole area's ambient beauty and a small permanent essence bonus. Ties to
growth: water = bloom.

**Beauty & anim:** flowing water is a cheap scrolling shimmer shader; filling a
terrace sends a soft reflective sheen across it, then flowers open in a ripple.

### 3.4 Shared puzzle rules

- **Unlosable & patient.** No clock, no moves limit, no lose state. Pieces persist in
  world if you leave. You may pick a puzzle up and return to it any time.
- **Diegetic entry.** A puzzle region announces itself with a soft glow + the §2.6
  whisper the first time you pan to it. No "Play puzzle?" dialog.
- **Procedural & seeded.** Every puzzle instance = pure function of `(world_seed,
  region_key)`; always has at least one solution; difficulty scales *gently* with how
  far you've expanded (more nodes/prisms/terraces, never meaner).
- **Rewards are always growth or land** — never a hard currency the player could
  otherwise grind. Puzzles are the *only* way to expand ground, which keeps the world
  deliberate and keeps §1.2's space-as-soft-cap honest.

---

## 4. Growth model

### 4.1 Everything grows, continuously and slowly

Growth is the spine of the whole game and is already built into `ProcNode`:
`growth ∈ [0,1]` creeps up every frame by `grow_rate` in `_process`, redrawing only
when it crosses a ~0.0025 threshold (CONVENTIONS rule 4/6). Every proc module's
`_draw` **must** render a believable stage for any `growth` — seed, sprout, sapling,
mature — eased through `g()` (smootherstep). Nothing pops into existence at full size
except via `pop_in()`'s brief unfurl.

### 4.2 Seed → mature staging & per-class pacing

Designers set pace per class with `set_grow_minutes(m)`:

| Class | Minutes to mature | Feel |
|---|---|---|
| Wildflowers / small decorations | 3-6 min | visibly bloom within a session |
| Shrubs, saplings, Blocklings (egg→adult) | 20-30 min (default) | grow across a play session |
| Trees, buildings | 1-3 hours | grow across a day |
| Heart Tree, ancient/legendary things | 8-24 hours | grow across many days — the long game |

Staging guidance for `_draw` (all continuous, all via `g()`):
- **0.0-0.15 seed/sprout:** a seed, a nub, a first pale leaf. Tiny, tender.
- **0.15-0.5 young:** recognisable but small & slender; fewer leaves/windows/limbs.
- **0.5-0.85 maturing:** near-full silhouette, filling in detail, richer colour.
- **0.85-1.0 mature:** full form, full detail, full production, full idle life.

Growth is **monotonic up** by default (things don't wither); nurture (`grow_to`)
gives a gentle bump, never a reset.

### 4.3 The open-ended start seeds an ever-expanding world

First launch asks one question — *"Where do you start your journey?"* — a free-text
field. The answer runs through `Proc.seed_from_text()` → the `world_seed` that drives
**everything**: `Proc.palette` mood, the island's blob outline (`WorldGen` jitter),
the starting realm's weather, the mix of decoration variants scattered
(`WorldGen.island_decorations`), which Blockling species you're likely to discover
first, and the exact layout of the first Rootwork/Lightweave/Bloomtide puzzles. Same
phrase → same world forever; a different phrase → a wholly different world.

From that seed the world **expands outward without limit**: every Rootwork puzzle
solved unfurls a new patch of seeded ground, each patch posing its own new puzzles and
plots — so the island is literally woven larger by play, bounded at any moment only by
the gently-growing camera clamp. There is no "end"; there is only *more island, slowly*.

---

## 5. Mint freezes growth

Minting an entity as an NFT is **pressing a flower in a book**: it snapshots and
**freezes** the thing's life.

- **On mint** (via the kept `Wallet.mint_*` flow, surfaced as an in-world action
  bubble, §2.7): capture the entity's full generative identity into the NFT metadata —
  `{world_seed, entity_key, species/building_id, growth_snapshot, palette_drift,
  variant, phase}` — everything needed to regenerate it *exactly*. Set the entity's
  `grow_rate = 0` so its `growth` stops advancing, and give it a subtle **crystalline
  stillness** cue in-world (a faint glassy sheen, animation damped to near-zero) so a
  minted thing reads as *held, timeless, precious* — distinct from the living things
  breathing around it. Only sufficiently-mature things (`growth ≥ ~0.85`) can be
  minted, so what you freeze is something you grew.
- **Minted things can be put away.** A minted entity can be picked up into the tray
  (or sits in the wallet collection) as a frozen keepsake. In the tray it shows its
  snapshot stage, unmoving.
- **On re-place into a world:** placing a minted item back onto valid ground
  **restores `grow_rate`** to its class default (`set_grow_minutes`) and growth
  **resumes from the frozen `growth_snapshot`** — the flower, replanted, lives again
  and keeps growing toward 1.0 from exactly where it stopped. Its identity
  (seed/palette/variant) regenerates identically from the stored metadata, so it is
  unmistakably *the same creature*, just woken.
- **Cross-world:** because identity is fully seeded, a minted thing can be re-placed
  into *any* world (yours or, later, a friend's), adapting its palette drift to the
  new locale (§2.3a) while keeping its form — a traded, living heirloom.

This gives minting real in-game meaning (a deliberate pause in a thing's life, a
keepsake you can revive) without ever selling power — a mint neither speeds nor
boosts production; it only *stops and later resumes* one object's clock.

---

## 6. How it ties together — one calm, gorgeous, living screen

Boot into a single portrait scene. A procedural sky breathes overhead in your world's
own colours. A floating island — *your* island, shaped by your opening sentence —
hangs in the middle, the Heart Tree at its core slowly pulsing light that pools, as
luminous motes, at its roots (that pool *is* your essence; that is the only "resource
UI"). Blocklings you've grown wander and nestle; trees you planted this morning are
taller than they were; a dell to the left glows softly, asking to be woken. You drag
the world with your thumb to wander it; you pull a seed from the one tray at the
bottom and plant it, and it adapts — leans to the tree's light, takes on the local
hue, tucks beside its neighbours — and begins, slowly, to grow. You tap a mature grove
to pluck its timber (a number floats up and is gone). You wander to the shaded dell,
bend a beam of light through two prisms until the ground wakes green, and a wave of
grass unfurls. You weave roots out to the dormant nodes at the edge and a new patch of
island blooms into being, carrying new ground to plant and new puzzles to find. When
the small tree you've tended for days is finally, fully grown, you press-and-hold it,
mint it — and it goes still and glassy and timeless, yours to keep — until some later
day you place it back and it quietly resumes its life.

Nothing nags. Nothing can be lost. Every system — idle accrual, placement, adaptation,
puzzles, growth, minting — is a different facet of the one verb: **tend a living
world, and let time make it beautiful.** The screen is never a menu in front of a
game. The screen *is* the game.

---

## 7. Build contract (so every agent composes)

- **One scene, one `_world`.** Main's owner keeps `_world: Node2D` + the Tray; deletes
  the UI in §2.1; mounts a `Camera2D` with the §2.5 clamp. Everyone else adds
  `ProcNode` subtrees under `_world`.
- **Every placeable is a `ProcNode`** (CONVENTIONS §Module shape): `class_name
  Proc<Thing> extends RefCounted` with static factories returning the subclass;
  feet-at-origin; staged `_draw` for all `growth`; cheap `_animate`. Additionally
  expose `footprint_radius: float` and accept an optional `context: Dictionary`
  (`{local_palette, light_dir, elevation, neighbours}`) applied in `_on_built`/
  `_on_growth` for §2.3a adaptation.
- **Seeds, not randomness.** Only `Proc.rng/hashf/rangef/noise/seed_from_text`. Same
  `world_seed` ⇒ same world, same puzzles, same scatter.
- **Data-driven forms.** Pull `shape/profession/palette/art/material` from `GameData`
  / `data/*.json` (never hardcode balance). A "fox" looks foxy, a "library" looks
  like a library, a `plant` sways and a `crystal` shimmers.
- **Economy stays in autoloads.** `Game`, `Production`, `Buildings`, `Blocklings`,
  `Realms`, `Economy`, `Research`, `Ascension`, `Cosmetics`, `IAP`, `Wallet` keep
  their logic; this redesign changes only *presentation* (menus → world) and ties
  production rate to `g(growth)` (§1.1). Add an `inventory` dict to `Game.state` for
  the Tray.
- **Performance budget (CONVENTIONS rule 6):** 100+ living things on screen; redraw
  only on growth-threshold crossings or `animate_draw` shapes; animate via child
  transforms + shader uniforms; cache heavy point arrays; no per-frame allocation.
- **New files only.** Each agent creates its own `scripts/proc/<Name>.gd`. Do not edit
  Main.gd, project.godot, or another agent's module. Do not git commit.
