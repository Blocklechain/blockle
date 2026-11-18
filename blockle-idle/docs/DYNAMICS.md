# Blockle Idle — GAME DYNAMICS

**Seven interlocking systems that give the calm world a lot more to DO — without
ever adding a menu, a timer that nags, or a way to lose.**

This document is the authoritative design for the *dynamics layer* that sits on top
of the shipped world (`WorldSpace` + `Interact` + `ItemCatalog` + `IdleSim` +
`GrowthState` + `PuzzleSystem`). It binds seven build agents to one contract so the
systems compose into a single living loop.

Read first: `docs/IDLE-DESIGN.md` (the base design — it wins on anything it already
decides), `scripts/proc/CONVENTIONS.md` (the seven hard art rules), and the live
files named in §9.

Where this document and a stray assumption disagree, **this document wins**; where
this document and `IDLE-DESIGN.md` disagree, **IDLE-DESIGN wins**.

---

## 0. The loop in one breath

> You plant things. They grow. The creatures that live among them develop **moods**
> and **bonds** with you; some take **jobs** and quietly make the things around them
> thrive. A creature starts to **wish** for something — a loaf of bread, a lantern
> road, a friend — and the wish is a thought bubble over its head, not a quest log.
> Granting it needs **materials**, which your living things shed on their own when
> you **tend** them (water, prune, feed, warm) — and which you **combine** on a
> hearthstone into real goods. The **seasons** turn, slowly, and bring
> opportunities: a meteor shower, a merchant walking in from the edge, a migration
> crossing the sky, a festival when enough of your kin are fond of you. What you
> grow and craft you can **offer** at the ritual circle, turning essence into
> blessings on the whole island — and the deepest rite of all, the **Ascension
> vigil**, is three quiet nights of ceremony, not a confirm button. Everything you
> ever find — a rare variant, a hybrid you cross-pollinated, a recipe, a rite — grows
> a leaf on the **Journal Tree** beside the Heart Tree, the only collection screen
> this game will ever have.

Seven systems, one sentence each:

| # | System | File | One line |
|---|---|---|---|
| 1 | **CreatureLife** | `scripts/world/dyn/CreatureLife.gd` | Creatures wander, feel, bond with you, and take jobs that help their neighbours. |
| 2 | **Wishes** | `scripts/world/dyn/Wishes.gd` | Diegetic quests as thought bubbles, grouped into six slow arcs. |
| 3 | **Discovery** | `scripts/world/dyn/Discovery.gd` | Rare variants, cross-pollination, breeding — all recorded as leaves on the living Journal Tree. |
| 4 | **SeasonsEvents** | `scripts/world/dyn/SeasonsEvents.gd` | A 12-day year of four seasons, plus soft-windowed events (meteors, festivals, merchants, migrations). |
| 5 | **Rituals** | `scripts/world/dyn/Rituals.gd` | Essence + goods → timed world blessings; and the three-vigil Ascension ceremony. |
| 6 | **Chains** | `scripts/world/dyn/Chains.gd` | 12 new items: 8 raw materials your living things shed, 4 goods you combine in-world. |
| 7 | **Nurture** | `scripts/world/dyn/Nurture.gd` | Water / prune / feed / warm — capped buffs, weather interplay, and the slow road to a Beloved thing. |

---

## 1. The sacred constraints (non-negotiable)

1. **MENU-LESS.** No new panel, menu, HUD, bar, badge, tab, list or modal. The only
   menu in the game remains the bottom **inventory tray** (`InventoryTray.gd`).
   Every one of your readouts must be one of:
   - a **thought bubble** over a creature (your own inline `ProcNode` subclass),
   - a **glow / ring / sheen** on a thing (`ProcEffects.make_selection_ring`, a shader),
   - **drifting motes** (`ProcEffects.make_pickup_float`, `IdleMote`, or your own),
   - a **whisper** — the one-line label, via the whisper relay (§9.4),
   - an **in-world object** you can see and touch (Journal Tree, Ritual Circle,
     Hearthstone, Stockpile, the merchant standing on the grass),
   - the existing **ActionBubble** pill raised by a tap (new verbs are free — see §9.3).
2. **Calm.** Nothing punishes. Nothing expires harshly. No countdown is ever shown
   as a countdown. Every window closes *softly* (§2.3). There is no health, no
   wilting, no hunger meter, no failure state anywhere in this layer.
3. **Opportunities, not obligations.** If a feature creates a reason to open the app
   at a specific minute, it is wrong — redesign it. An event you miss mails its
   leftovers into your basket. A wish you ignore waits forever.
4. **Seeded determinism.** Generation and all "random" outcomes come from
   `Proc.hashf / rangef / rng / noise` with a key that includes a **persisted
   counter** (§2.5) — never `randf()`, never `Time` as a randomness source.
   Wall-clock time is used only for *elapsed-time gameplay*, exactly as
   `IdleSim`/`GrowthState` already do.
5. **One top-level state key per system**, migrate-safe (§3).
6. **Proc toolkit for all visuals.** Tiny inline `ProcNode` subclasses in your own
   file are encouraged. Honour growth staging, cheap animation, and the perf budget
   (§8).
7. **New files only**, under `scripts/world/dyn/`. Never edit `WorldSpace.gd`,
   `Interact.gd`, `Main.gd` or `project.godot` — design the hook, put it in your
   integration note, the maintainer wires it (§9). `ItemCatalog.gd` may receive
   **append-only additive blocks**, and only from the two agents named in §9.6.

---

## 2. Shared tuning philosophy

Every system obeys the same five laws. Build agents: copy these numbers, do not
invent parallel ones.

### 2.1 Gentle — everything is a small multiplier, and multipliers are clamped

No single effect in this layer is worth more than **+30%**. Effects multiply, then
the **product is clamped** by category. Rituals owns the clamp table; every system
resolves its multipliers through one shared formula:

```
effective(key, place_id) =
    base(1.0)
  * seasons_mod(key)            # SeasonsEvents.modifier(key)        0.92 .. 1.25
  * blessing(key)               # Rituals.blessing(key)              1.00 .. 1.30
  * care(key, place_id)         # Nurture.care_mult(place_id, key)   1.00 .. 1.20
  * jobs(key, place_id)         # CreatureLife.job_mult(place_id,key) 1.00 .. 1.25 (best 2 only)
  * variant(key, place_id)      # Discovery.variant_mult(place_id,key) 1.00 .. 1.30
  * bond(key, place_id)         # CreatureLife.bond_mult(place_id,key) 1.00 .. 1.30
  → clamped to CAP[key]
```

| `key` | meaning | CAP |
|---|---|---|
| `grow` | growth-rate multiplier on a placed thing | **1.60** |
| `yield` | resource shed / harvest stock rate | **1.60** |
| `bond` | bond-gain rate | **2.00** |
| `luck` | rare-variant / hybrid / egg odds | **3.00** |
| `cadence` | how often wishes/events are offered | **1.50** |
| `craft` | craft speed | **1.50** |
| `offline` | offline full-credit window hours | **12.0 h** (from 8.0) |

**Floor law:** no key may ever resolve below **0.92**, and only `grow` in Stillfrost
may go below 1.0 at all. Nothing else in this layer is ever a penalty.

Every query is optional and guarded. A system must work correctly if any or all of
its six siblings are absent:

```gdscript
func _mult(key: String, place_id: String) -> float:
    var m := 1.0
    var s: Node = _sib("SeasonsEvents")
    if s != null and s.has_method("modifier"):
        m *= float(s.call("modifier", key))
    # ... same shape for the others
    return clampf(m, 0.92, CAP_FOR[key])
```

### 2.2 Pity-timered — nothing is ever only luck

Every probabilistic grant in this layer carries a **guarantee counter** persisted in
state. The pattern (copy it):

```gdscript
# roll with pity: after `pity_max` misses the next roll is forced
func _roll(key: String, chance: float, pity_field: String, pity_max: int) -> bool:
    var n := int(_st()["pity"].get(pity_field, 0))
    var forced := n >= pity_max
    var hit := forced or _rand(key) < chance * _mult("luck", "")
    _st()["pity"][pity_field] = 0 if hit else n + 1
    return hit
```

Published pity ceilings (also listed per system):

| Grant | Chance | Pity ceiling |
|---|---|---|
| Non-common variant on placement | 11.5% | 25 placements |
| Radiant-or-better variant | 3.0% | 120 placements |
| Cross-pollination hybrid | dwell-timed | 45 min of eligible dwell |
| Breeding egg | dwell-timed | 90 min of eligible dwell |
| A wish is offered | cadence-timed | 60 min of play with a free slot |
| Each event kind appears | season-weighted | 36 h of play (merchant: 24 h) |
| Kindred creature brings a gift | 6% / 10 min | 8 attempts |
| Material shed from an eligible source | interval-timed | interval × 1.6 |

### 2.3 Soft windows — nothing is lost by being away

An event, a craft, a rite, a care-buff: all have an end, and the end is **never a
loss**.

- **Events** run for a long window (45–180 min). When one ends, everything the
  player could have collected is **mailed into the tray** as a parting gift
  (`Chains.give()` / an inventory entry) plus one whisper: *"The sky put its
  leftovers in your basket."*
- **Crafts** never spoil. A finished output sits on its craft site, glowing, until
  tapped — forever.
- **Rites** expire; the blessing simply fades. The rite can be run again.
- **Care buffs** expire; the thing returns to its base rate. Nothing withers.
- **Wishes** never expire at all.
- **Offline**: every system implements `catch_up(elapsed: float)` and advances its
  wall-clock state through the **same curve as `IdleSim.effective_seconds`**:

```gdscript
const OFFLINE_FULL_HOURS := 8.0     # Rituals' `offline` blessing can raise to 12.0
const OFFLINE_CAP_HOURS := 48.0
const OFFLINE_FLOOR := 0.5
func _effective(elapsed: float) -> float:
    var e: float = maxf(0.0, elapsed)
    var full: float = _full_hours() * 3600.0
    var cap: float = OFFLINE_CAP_HOURS * 3600.0
    if e <= full: return e
    var span: float = maxf(1.0, cap - full)
    var over: float = minf(e, cap) - full
    var avg: float = 1.0 - (1.0 - OFFLINE_FLOOR) * 0.5 * (over / span)
    return full + over * avg
```

Season progression and event *scheduling* use **raw** wall-clock (the year turns
whether you watch or not); *accrual* (materials, bonds, pollen dwell, craft
progress) uses the **curved** effective seconds.

### 2.4 Capped boosts, no runaway stacking

Per-thing boost slots: a placed thing may receive **at most 2 job boosts** (the best
two by magnitude) and **1 variant tier**. A creature may hold **1 job**. A world may
hold **3 active rites**, **3 active wishes**, **1 active event + 1 queued**, **3
stockpiles**, **2 craft sites**, **4 Everbloom slots**.

### 2.5 Determinism: the persisted-counter RNG pattern

```gdscript
func _rand(tag: String) -> float:
    var st: Dictionary = _st()
    var n := int(st.get("seq", 0))
    st["seq"] = n + 1
    return Proc.hashf(world_seed, "%s:%s:%d" % [SYS_KEY, tag, n])
```

Rolls are reproducible from the save, not from the clock. Layout (where the Ritual
Circle stands, which three merchant offers appear, the order of wishes in an arc) is
a pure function of `(world_seed, stable_key)` with **no** counter — same world, same
world.

### 2.6 Whisper budget

The whisper line is a shared, precious channel. Each system keeps its own cooldown
and may not exceed its budget:

| System | Min gap | Notes |
|---|---|---|
| Wishes | 8 s | may whisper on offer / completion / arc |
| CreatureLife | 20 s | prefers thought bubbles over whispers |
| Discovery | 12 s | a find is worth a line |
| SeasonsEvents | 25 s | season turn, event start/end |
| Rituals | 12 s | rite start/complete, vigil |
| Chains | 15 s | craft done, stockpile full |
| Nurture | 15 s | refusals ("the wind is too strong — later") |

Never whisper while the player is mid-drag (`Interact.mode`/placing — ask via
`_interact.is_placing()`, a designed accessor in §9.4). Drop the line rather than
queue it.

---

## 3. State: one key per system

All seven keys live at the top level of `Game.state` (so `Save.gd` serialises them
for free) and **must be backfilled with `.get` defaults on every read**. Legacy
saves have none of these keys and must load without error.

```gdscript
const SYS_KEY := "creature_life"     # per system, see table
const SYS_VERSION := 1

func _st() -> Dictionary:
    if not (Game and Game.state is Dictionary):
        return {}                                   # headless/boot safety
    if not Game.state.has(SYS_KEY) or not (Game.state[SYS_KEY] is Dictionary):
        Game.state[SYS_KEY] = {}
    var st: Dictionary = Game.state[SYS_KEY]
    st["version"] = int(st.get("version", SYS_VERSION))
    st["seq"] = int(st.get("seq", 0))
    st["pity"] = st.get("pity", {}) as Dictionary
    # ... every sub-dict backfilled the same way, never assumed
    return st
```

| System | `Game.state` key | Shape |
|---|---|---|
| CreatureLife | `creature_life` | `{version, seq, pity:{}, kin:{cl_<place_id>:{species, mood, mood_until, bond, bond_xp, job, home_place, fed_at, warmed_at, friends:{}, naps:int, last_tick}}, play:{date:int, pets:int}}` |
| Wishes | `wishes` | `{version, seq, pity:{}, active:[{id, kind, giver, want:{}, prog:float, created}], done:{id:unix}, shelved:[id], arcs:{arc_id:{step:int, done:bool}}, last_offer:unix}` |
| Discovery | `discovery` | `{version, seq, pity:{place:int, rare:int, pollen:int, egg:int}, found:{key:{at, count, tier}}, variants:{place_id:tier}, pollen:{pair_key:{dwell:float, at}}, hybrids:{id:true}, eggs:{pair_key:{dwell:float}}, journal:{planted:bool, place_id, leaves:[], blossoms:[]}}` |
| SeasonsEvents | `seasons` | `{version, seq, pity:{}, epoch:unix, last_tick:unix, season:int, year:int, seen:{int:true}, event:{id, kind, started, ends, data:{}}, queued:{}, history:[{kind, at}], caught:int}` |
| Rituals | `rituals` | `{version, seq, pity:{}, circle:{planted:bool, tx:float, stones:int}, pending:{rite:"", inputs:{}}, active:{rite_id:{started, ends, strength}}, done:{rite_id:int}, vigils:{n:int, last:unix}, everbloom:[place_id]}` |
| Chains | `chains` | `{version, seq, pity:{}, piles:{place_id:{mat:int}}, sites:{place_id:{kind, inputs:{mat:int}, recipe:"", started:unix, ends:unix, output:""}}, learned:{recipe:true}, buffer:{place_id:{mat:float}}, produced:{mat:int}}` |
| Nurture | `nurture` | `{version, seq, pity:{ask:unix}, care:{place_id:{watered:unix, pruned:unix, fed:unix, warmed:unix, tended:int, beloved:bool}}, last_care:unix, auto:{rain_until:unix}}` |

**Carried materials are NOT a new store.** They live in the existing
`Game.state["inventory"]` (so the tray shows and drags them for free, see §7.3).
`chains.piles` is what sits in stockpiles; `chains.buffer` is fractional accrual at
a source. `chains.produced` is lifetime counters for the Journal.

**Never clobber existing keys.** `Game.state["discovered"]` (legacy blockling
collection) must be *read* by Discovery to backfill the Journal, never overwritten.
`Game.state["placements"]`, `["inventory"]`, `["growth"]`, `["expansion_level"]`,
`["heart_growth"]` belong to other owners — read freely, write never (except
`inventory` via the designed grant helper, §7.3).

---

## 4. The Dyn contract — how seven systems interlock with zero shared files

There is **no shared base class and no shared helper file.** Seven agents build in
parallel; a shared file would be a merge hazard. Interop is by **node name + duck
typing**, and every cross-call is optional.

### 4.1 Mounting

The maintainer creates one container under the pan camera and mounts the seven
systems with **exactly these node names** (§9.1):

```
WorldSpace/PanCam/Dyn/CreatureLife
                     /Wishes
                     /Discovery
                     /SeasonsEvents
                     /Rituals
                     /Chains
                     /Nurture
```

Sibling lookup, five lines in every file:

```gdscript
func _sib(n: String) -> Node:
    var p := get_parent()
    if p == null:
        return null
    return p.get_node_or_null(n)
```

### 4.2 Every system implements this interface

```gdscript
class_name <Name> extends Node2D

signal whisper(text: String)                      # relayed to the one-line label
signal dyn_event(kind: String, payload: Dictionary)   # the shared event language

func setup(world_seed: int, ctx: Dictionary) -> void   # ctx: {space, interact, sim, puzzles, sky}
func catch_up(elapsed: float) -> void                  # boot + resume wall-clock advance
func notify(kind: String, payload: Dictionary) -> void # inbound sibling events (no-op by default)
```

Optional (implement only if your system needs it; the dispatcher checks
`has_method`, and the **first system to return `true` consumes** the gesture):

```gdscript
func extra_actions(record: Dictionary) -> Array                             # add bubble verbs
func handle_action(action: String, record: Dictionary) -> bool               # own a verb
func handle_drop(entry: Dictionary, inst_key: String, world_pos: Vector2) -> bool   # own a drop
func handle_tap(screen_pos: Vector2, world_pos: Vector2) -> bool             # own an empty-world tap
func handle_heart_hold() -> bool                                             # Rituals only
```

Gesture consumption priority (the maintainer iterates `Dyn`'s children in mount
order, so mount order *is* priority): **Rituals → Chains → SeasonsEvents →
Discovery → Wishes → Nurture → CreatureLife**. Rationale: a drop onto the ritual
circle beats a drop onto a hearthstone beats a plain plant; a tap on a falling star
beats a tap on the Journal Tree beats a tap on a wish bubble.

### 4.3 The shared event language

Every system emits `dyn_event(kind, payload)`; the maintainer cross-connects every
system's `dyn_event` to every other system's `notify`. This is the interlock
backbone: you never import a sibling to *hear* about something, only to *ask* it a
question.

| `kind` | Emitted by | payload |
|---|---|---|
| `placed` / `removed` | (relayed from WorldSpace, §9.2) | `{place_id, entry, tx}` |
| `nurtured` / `harvested` | (relayed from WorldSpace) | `{place_id, entry, resource, amount}` |
| `watered` `pruned` `fed` `warmed` | Nurture | `{place_id, entry, verb, at}` |
| `tended_milestone` | Nurture | `{place_id, tended:int, beloved:bool}` |
| `bond_up` | CreatureLife | `{place_id, bond, level}` |
| `mood` | CreatureLife | `{place_id, mood}` |
| `job_set` | CreatureLife | `{place_id, job}` |
| `friendship` | CreatureLife | `{a, b, meetings}` |
| `gift` | CreatureLife | `{place_id, material}` |
| `material_gained` | Chains | `{mat, n, from_place}` |
| `craft_done` | Chains | `{site, recipe, output}` |
| `stock_full` | Chains | `{place_id}` |
| `discovered` | Discovery | `{key, category, tier, label}` |
| `hybrid` | Discovery | `{species, parents:[a,b], item_key}` |
| `variant` | Discovery | `{place_id, tier}` |
| `egg` | Discovery | `{species, parents, item_key}` |
| `journal_grew` | Discovery | `{leaves:int, total:int}` |
| `season_changed` | SeasonsEvents | `{season:int, id, year}` |
| `weather_changed` | SeasonsEvents | `{weather}` |
| `event_started` / `event_ended` | SeasonsEvents | `{kind, id, ends, data}` |
| `meteor_caught` | SeasonsEvents | `{n}` |
| `migration_settled` | SeasonsEvents | `{species, item_key}` |
| `merchant_traded` | SeasonsEvents | `{gave:{}, got:{}}` |
| `rite_started` / `rite_done` | Rituals | `{rite, ends, strength}` |
| `blessing_changed` | Rituals | `{key, mult, until}` |
| `vigil` | Rituals | `{n:int, of:3}` |
| `ascended` | Rituals | `{count}` |
| `wish_offered` / `wish_progress` / `wish_done` | Wishes | `{id, kind, giver, prog}` |
| `arc_done` | Wishes | `{arc, blessing}` |

### 4.4 Read-only query surface (what siblings may ask you)

Implement exactly these signatures. Callers guard with `has_method` and fall back
to the neutral value in brackets.

| System | Query | Returns |
|---|---|---|
| SeasonsEvents | `season() -> int` `season_id() -> String` `season_phase() -> float` `year() -> int` | 0..3 / `"greenrise"` / 0..1 |
| | `weather() -> String` `is_night() -> bool` `daylight() -> float` | `"clear"` [clear] / bool [false] |
| | `event_kind() -> String` `event_ends() -> float` | `""` [""] |
| | `modifier(key: String) -> float` | 0.92..1.25 [1.0] |
| Rituals | `blessing(key: String) -> float` | 1.0..1.30 [1.0] |
| | `is_active(rite_id: String) -> bool` `cost_for(rite_id) -> Dictionary` | [false] |
| | `is_everbloom(place_id: String) -> bool` | [false] |
| Nurture | `care_mult(place_id: String, key: String) -> float` | 1.0..1.20 [1.0] |
| | `is_watered(place_id) -> bool` `is_pruned(place_id) -> bool` `is_warm(place_id) -> bool` | [false] |
| | `tended(place_id) -> int` `is_beloved(place_id) -> bool` | [0] / [false] |
| CreatureLife | `bond(place_id) -> float` `bond_level(place_id) -> String` `mood(place_id) -> String` | [0.0] / [`"shy"`] / [`"content"`] |
| | `bond_mult(place_id, key) -> float` `job_mult(place_id, key) -> float` | [1.0] |
| | `creatures() -> Array` (of `{place_id, species, job, bond, pos}`) | [[]] |
| | `nearest(world_pos: Vector2, job: String = "") -> Dictionary` | [{}] |
| | `avg_bond() -> float` `home_capacity() -> int` | [0.0] / [0] |
| Chains | `stock(mat: String) -> int` (inventory + piles) | [0] |
| | `take(mat: String, n: int) -> bool` `give(mat: String, n: int) -> void` | [false] / no-op |
| | `knows(recipe: String) -> bool` `learn(recipe: String) -> void` | [false] |
| | `recipes() -> Array` `materials() -> Array` | [[]] |
| Discovery | `is_found(key: String) -> bool` `discover(key, meta: Dictionary) -> bool` | [false] |
| | `variant_tier(place_id) -> String` `variant_mult(place_id, key) -> float` | [`"common"`] / [1.0] |
| | `luck_mult() -> float` `journal_progress() -> float` | [1.0] / [0.0] |
| Wishes | `active_wishes() -> Array` `note_progress(kind, payload) -> void` | [[]] / no-op |
| | `wants(mat_or_key: String) -> bool` | [false] |

---

## 5. How the systems feed each other

This is the design's spine. Every arrow is a real, named call or event.

```
         ┌──────────────── SeasonsEvents ────────────────┐
         │ season/weather/events modulate EVERYTHING     │
         ▼                                               ▼
     Nurture  ──water/prune/feed/warm──▶  Chains  ──materials──▶  Rituals
         │  (buffs, Beloved)                 │  (goods)            (essence sink
         │                                   │                      → blessings)
         ├──────▶ CreatureLife (bond up)     ├──────▶ Wishes (bring/craft wants)
         │                │                  │              │
         │                ├─jobs─▶ everything│              └──arc blessing──▶ Rituals
         │                │                  │
         └────▶ Discovery ◀──pollen/breeding─┘
                     │
                     └──▶ the Journal Tree (the one collection readout)
```

### 5.1 The twenty concrete couplings

| From → To | Mechanism |
|---|---|
| **Nurture → Chains** | A watered plant becomes a `dewdrop` source; a pruned mature tree becomes a `heartwood` source; `warmed` keeps `emberbloom` flowing in winter. Chains listens for `watered`/`pruned`/`warmed`. |
| **Nurture → CreatureLife** | `fed` on a creature: `bond_xp += 0.035`. Any care within 200 px of a `gardener`: that creature's `bond_xp += 0.008` and mood → `content`. |
| **Nurture → Discovery** | Cross-pollination requires **both** partners watered within 30 min. `prune` in Greenrise adds +1 pollen dwell tick. |
| **Nurture → Wishes** | `tend`-kind wishes count `watered`/`pruned` events. The Nurture "ask" pity bubble (§8 of its spec) is also the hint Wishes uses to pick a reachable `tend` wish. |
| **Nurture ← SeasonsEvents** | Rain / Bloomtide swell / Rite of Rain auto-water everything (`auto.rain_until`). Highsun halves water duration (45→25 min). Stillfrost makes `warm` meaningful. Storm refuses `prune` with a whisper. |
| **Chains → Wishes** | `bring` and `craft` wishes only ever ask for things Wishes can see are reachable: it calls `Chains.stock()` and `Chains.knows()` before offering. |
| **Chains → Rituals** | Every rite costs essence **plus** 1–3 crafted/raw materials. `Rituals` calls `Chains.take()`; if Chains is absent, the rite costs essence only ×1.5. |
| **Chains → Nurture** | `grainloaf`/`rootbalm` are the premium `feed` (growth +0.10 instead of +0.06, and +2 `tended`). `kindling-lamp` is the `warm` fuel. |
| **Chains → Discovery** | `lightwell glass` placed within 220 px of a thing adds +60% to that thing's variant roll (a luck source, capped by `CAP["luck"]`). Each first craft is a `discovered` recipe leaf. |
| **Chains ← CreatureLife** | An `artisan` within 200 px of a craft site: `craft` speed ×1.20. A `gatherer` within 220 px of a source: material interval ×0.85. |
| **CreatureLife → Discovery** | A kin-pair (3+ play meetings, both bond ≥ 0.45) near a `blockling_homes` is the breeding precondition. `Kindred` creatures reveal one hidden Journal leaf per ascension. |
| **CreatureLife → Wishes** | Creatures are the **givers**. Bond gates wish quality: Shy gives `tend`/`plant`; Fond gives `bring`/`craft`; Devoted+ gives arc steps. |
| **CreatureLife → everything** | Jobs apply the `job_mult` boosts in §6.1 within a radius. |
| **Discovery → Chains** | A `radiant`/`ancient` variant source sheds its material 30% faster. Hybrids unlock 1 recipe each (seeded from the 12). |
| **Discovery → Wishes** | Discovered species widen the `plant` wish pool, so wishes stay fresh as the collection grows. An `arc_done` plants a Journal **blossom**. |
| **Discovery ← SeasonsEvents** | Greenrise: pollen dwell ×1.5, breeding ×1.5. Stillfrost: `moonsilver`/crystal variants ×1.2. Meteor shower grants +1 `rare` pity credit per catch. |
| **Rituals → everything** | `blessing(key)` is the one place a temporary world-wide multiplier comes from, and it owns the clamp table. |
| **Rituals → Discovery** | `Rite of Finding` → `luck` ×2 for 2 h. Each first performance of a rite is a `discovered` leaf. |
| **Rituals ← Wishes** | Completing an arc grants a permanent **+3%** blessing of one category (max +12% total from all six arcs) registered through `Rituals` so it lands inside the caps. |
| **SeasonsEvents → CreatureLife** | Festival: all bonds +0.03, moods → `content` for its duration, creatures gather and dance at the Heart Tree. Migration may **settle** a free creature if `home_capacity() > 0` and `avg_bond() ≥ 0.4`. |

### 5.2 One worked player session (the loop proving itself)

1. It is **Greenrise**, lightly raining (SeasonsEvents). The rain auto-waters the
   garden (Nurture `auto.rain_until`).
2. Two watered mature plants of different species stand 150 px apart; Discovery's
   pollen dwell accrues ×1.5 for the season. A pollen mote crosses between them and
   a **hybrid seed** drops into the tray; a leaf grows on the Journal Tree.
3. The player **prunes** a mature oak (Nurture, growth ≥ 0.6) → yield ×1.15 for
   90 min, and the oak becomes a `heartwood` source (Chains).
4. `Mossy` the gardener Blockling is strolling nearby; the care event lifts her mood
   to `content` and her bond to **Fond** (CreatureLife). Being Fond, she now wishes
   for something real: a **honeycake** (Wishes `craft` kind — offered only because
   `Chains.knows("honeycake")`).
5. Honeycake needs `honeycomb ×2 + grainloaf`. Honeycomb comes from a 3-flower
   cluster; grainloaf is baked on the **Hearthstone** by dragging `honeycomb` and
   two `dewdrop` onto it (Chains, in-world, no menu). `Ember` the artisan is nearby:
   craft ×1.20.
6. Granting the wish gives +0.08 bond, a `skyshard`, and step 3 of the **Long Table**
   arc. The arc's completion later grants a permanent +3% `yield` blessing through
   Rituals.
7. That night a **meteor shower** (SeasonsEvents, Stillfrost ×2 but it's Greenrise so
   base odds) drops stardust and skyshards; two land and sit as glowing pebbles the
   player can pick up tomorrow — nothing is missed.
8. With 1 skyshard the player runs the **Rite of Finding** at the Ritual Circle:
   drag the skyshard onto the stones, 180 essence melts into rising motes, a 90-second
   ceremony plays, and for 2 h `luck` ×2 — which is exactly when the player plants
   the hybrid seed from step 2 and gets a **radiant** variant.
9. The radiant hybrid becomes the family's favourite. Twenty-five cares later it is
   **Beloved** (Nurture) — permanent halo, +8% yield — and when the three Ascension
   vigils are finally done, it is the keepsake chosen for an **Everbloom** slot and
   survives the reset.

---

## 6. The seven systems in detail

### 6.1 CreatureLife — `scripts/world/dyn/CreatureLife.gd`

**Node:** `class_name CreatureLife extends Node2D`, name `"CreatureLife"`.
**State key:** `creature_life`. **Tick:** per-frame movement (cheap), 1 s logic.

#### Who it manages
Every placed record whose `entry.kind == "creature"`. Discovered by listening for
`placed`/`removed` (§9.2) and by an initial pass over `space.records()`. Keyed
`cl_<place_id>`.

#### Behaviour state machine
`idle → stroll → visit → work → play → sleep` (and `follow` while the player drags
a thing near them). Movement is strictly along the ground contour:

```gdscript
var tx: float = cur_tx + dir * speed * delta
node.position = space.ground_origin() + Vector2(tx, space.ground_surface_at(tx))
```

| Param | Value |
|---|---|
| Walk speed | 18–34 px/s (seeded per creature) |
| Stroll leg length | 60–220 px |
| Pause between legs | 3–12 s |
| Roam radius from home | 420 px (900 px for `explorer`) |
| Night (`SeasonsEvents.is_night()`) | → `sleep` near `blockling_homes`, else near the Heart Tree |
| Sleep visual | a slow breathing scale + a `zzz` bubble every ~25 s |
| Max simulated creatures | **24** (beyond that, extras idle-animate only) |

The feet must *touch the ground*: re-snap the y every frame from
`space.ground_surface_at(tx)`, never tween position in screen space.

#### Moods
Five moods, each a **thought bubble** glyph drawn with Proc shapes (inline
`_ThoughtBubble extends ProcNode` — a soft parchment cloud with 2 trailing dots and
a generated glyph; growth-staged pop-in, 4–6 s life, fade out):

| Mood | Glyph | Caused by | Effect |
|---|---|---|---|
| `content` | a small heart | fed, festival, care nearby | bond gain ×1.15 |
| `curious` | a spiral | a new thing placed within 300 px, a discovery | wish-offer cadence ×1.2 |
| `sleepy` | `zzz` | night, long play session | forage ×0.95 (floored, cosmetic) |
| `playful` | two bouncing dots | another creature within 120 px, festival | friendship meetings tick |
| `wistful` | a drifting leaf | no care anywhere for 40 min, Emberfall | a `tend` wish becomes likely |

Mood is recomputed every 60–120 s (seeded jitter), shown on recompute if it changed,
and always shown on `inspect`. A mood is **never a problem to solve** — `wistful`
is an invitation, not a debuff.

#### Bonds
`bond ∈ [0,1]`, driven by `bond_xp` with gentle diminishing returns:
`bond = 1 - exp(-bond_xp / 2.2)`.

| Source | `bond_xp` |
|---|---|
| `nurture` on the creature (existing verb) | +0.05 |
| `feed` (Nurture, costs a material or 6 essence) | +0.09 |
| `pet` (new verb, see below) | +0.03, soft daily cap 6 pets/day |
| care performed within 200 px | +0.02 |
| wish granted to this creature | +0.20 |
| festival | +0.08 (one-off per festival) |
| idling near a thing of its favourite kind | +0.002 / min |

| Level | Range | Unlocks |
|---|---|---|
| `shy` | < 0.20 | stays away from the finger; `tend`/`plant` wishes |
| `friendly` | 0.20–0.45 | approaches when you tap nearby; forage ×1.08 |
| `fond` | 0.45–0.70 | `bring`/`craft` wishes; forage ×1.15; breeding-eligible |
| `devoted` | 0.70–0.90 | gives arc steps; forage ×1.24; follows you while dragging |
| `kindred` | ≥ 0.90 | forage ×1.30 (the cap); **brings gifts**: 6% / 10 min, pity 8, a random Chains material |

`bond_mult(place_id, "yield") = 1.0 + 0.30 * bond` (so the cap is exactly +30%).

#### Jobs
The `assign` verb already exists in `Interact` (tap creature → tap building). Jobs
now *do* something. Profession comes from `GameData.blocklings_by_id[species].profession`
(the data already has all eight). A job applies to things within **220 px** of the
creature's current position, recomputed every 5 s, capped at **2 job boosts per
thing** (best two) and `job_mult ≤ 1.25`:

| Profession | Effect |
|---|---|
| `gatherer` | `yield` ×1.12 on trees/plants; material interval ×0.85 |
| `gardener` | `grow` ×1.15 on plants/trees |
| `miner` | `yield` ×1.12 on crystals/stone sources |
| `scholar` | +1 Journal **insight** per 20 min → `Discovery.discover()` of one already-eligible-but-unseen key (hint, never a free find) |
| `explorer` | +25% event pity accrual; +1 merchant-arrival weight; drops a `trail mote` the player can tap for a seeded material |
| `artisan` | `craft` ×1.20 at a nearby craft site |
| `guardian` | care-buff durations ×1.25 nearby; storm never refuses prune nearby |
| `astral_keeper` | rite essence cost ×0.9 (floored at the caps); spots meteor showers 5 min early as a sky shimmer |

#### Friendships
Two creatures within 120 px while both `playful` log a **meeting** (max 1 per pair
per 10 min). At 3 meetings they are a **kin-pair**: both +0.05 bond, a small ring of
petals drawn between them once, `dyn_event("friendship")` → Discovery's breeding
precondition.

#### New bubble verbs it owns
`extra_actions(record)`: for creatures, append `"pet"`; append `"play"` when mood is
`playful`; append `"gift"` when the creature is `kindred` and has a gift waiting.
`handle_action` owns `pet`, `play`, `gift`.

#### Hooks it needs
`placed`/`removed`/`nurtured` relays; `space.ground_origin()`,
`space.ground_surface_at()`, `space.records()`; `extra_actions`/`handle_action`
dispatch; whisper relay. (All in §9.)

---

### 6.2 Wishes — `scripts/world/dyn/Wishes.gd`

**Node:** `class_name Wishes extends Node2D`, name `"Wishes"`.
**State key:** `wishes`. **Tick:** 5 s.

#### The presentation (no quest log, ever)
A wish lives as a **wish bubble** over its giver: the same thought-bubble form as
CreatureLife's but parchment-rimmed with a **gold progress arc** sweeping 0→1 around
it, and a generated glyph of the *thing wished for* (a loaf, a lantern, a sprout, a
pair of creatures, a star). The giver also wears a soft gold `ProcEffects` selection
ring at 35% opacity.

- Tap the giver → `extra_actions` offers **`hear`** (whisper the wish as one poetic
  line) and, when the want is satisfiable right now, **`grant`**.
- Tap the bubble itself (`handle_tap`) → whisper the wish + a **motes-trail** that
  drifts from the bubble toward *where the answer is* (a craft site, a stockpile,
  the species' nearest cousin) — the entire navigation UI.
- Tap the bubble twice within 2 s → **shelve** it (no penalty, no whisper of
  disapproval, returns to the pool, may be re-offered after 45 min).

#### Wish kinds

| Kind | Want shape | Satisfied when | Typical reward |
|---|---|---|---|
| `bring` | `{mat, n}` | `Chains.take(mat, n)` succeeds via `grant` | essence, bond, a rare seed |
| `craft` | `{recipe}` | the recipe's output is in the tray | recipe variant, skyshard, bond |
| `plant` | `{kind/species, n, radius}` | n matching things within radius of giver | hybrid seed, decor, bond |
| `tend` | `{verb, n}` | n `watered`/`pruned`/`fed`/`warmed` events | rootbalm, bond, `grow` blessing token |
| `befriend` | `{bond}` or `{pair}` | `CreatureLife.bond()` crosses the threshold | egg, Journal leaf, bond |
| `host` | `{building_id}` | that building placed within 400 px | materials ×3, a Journal leaf |
| `witness` | `{event_kind}` or `{season}` | present when that event/season starts | stardust, skyshard, blessing token |
| `ritual` | `{rite_id}` | `rite_done` for that rite | permanent arc step, Journal blossom |

#### Cadence and reachability (the "never impossible" law)

```
MAX_ACTIVE          = 3
MIN_GAP             = 20 min between offers   (×1/cadence_mult, floor 12 min)
PITY_OFFER          = 60 min of play with a free slot → force an offer from EASY_POOL
SHELF_COOLDOWN      = 45 min
NO_EXPIRY           = true (always)
```

Before offering, Wishes **proves the wish reachable**: `bring` only for a material
whose source the player already owns or whose `Chains.stock() > 0`; `craft` only if
`Chains.knows(recipe)`; `plant` only for a species in `Discovery.is_found()` or the
current tray; `ritual` only for a rite whose circle is planted. If nothing is
provable, it offers a `tend` wish (always reachable) — this is the EASY_POOL.

Givers are chosen by bond (§6.1). With no creatures placed, the **Heart Tree** is the
giver (its own small bubble above the crown); during a merchant event the **merchant**
is a giver with one richer wish.

#### The six arcs

Each arc is 4–6 ordered steps; step order is seeded per world
(`Proc.hashf(world_seed, "arc:<id>:<n>")`) so two worlds tell the story differently.
Arcs advance **only** through wishes given by `devoted`+ creatures (or the Heart
Tree), so the arcs are the slow spine, not the filler.

| Arc | Theme | Steps touch | Completion blessing (permanent, +3%) | Also grants |
|---|---|---|---|---|
| `lantern_road` | light the island | `plant` lanterns, `craft` lightwell glass, `host` a building, `ritual` Rite of Light | `yield` | the **Lantern Road** decor set (3 items) |
| `deep_root` | stone and roots | `bring` river-clay, a Rootwork solve (`PuzzleSystem.puzzle_solved`), `ritual` Rite of Roots | `grow` | a Journal branch + 1 Everbloom slot |
| `quiet_rain` | weather and care | `tend` ×12, `witness` a Bloomtide swell, `ritual` Rite of Rain | `grow` | permanent auto-water 10 min/day |
| `seed_library` | the collection | `plant` 6 species, a hybrid, a radiant variant | `luck` | the Journal Tree's second trunk |
| `long_table` | food and friends | `craft` grainloaf + honeycake, `befriend` ×2, `witness` a festival | `bond` | festival lanterns become permanent |
| `star_vigil` | the sky and the end | `witness` a meteor shower, `bring` moonsilver, 3 vigils, `ritual` Rite of the Long Year | `cadence` | unlocks the **Ascension ceremony** |

**Arc blessings are permanent but capped at +12% total**, registered through
`Rituals.register_permanent(key, 0.03)` so they land inside the §2.1 clamps. If
Rituals is absent, Wishes stores them and exposes `permanent(key) -> float` itself.

---

### 6.3 Discovery — `scripts/world/dyn/Discovery.gd`

**Node:** `class_name Discovery extends Node2D`, name `"Discovery"`.
**State key:** `discovery`. **Tick:** 5 s.

#### Rare variants
Every newly `placed` thing gets exactly one variant tier, rolled once and stored in
`discovery.variants[place_id]`.

| Tier | Base chance | `yield`/`grow` mult | Visual (through the adapt context) |
|---|---|---|---|
| `common` | 85.5% | 1.00 | — |
| `lush` | 11.5% | 1.08 | +8% scale, palette +0.06 saturation, one extra leaf cluster |
| `radiant` | 2.7% | 1.18 | a faint bloom ring + 2 orbiting motes, palette lightened 0.12 |
| `ancient` | 0.3% | 1.30 | a slow golden shimmer, +14% scale, a soft ground glow |

Chance is multiplied by `_mult("luck", place_id)` (Rite of Finding, lightwell glass,
Greenrise, meteor credits) and **pity-guaranteed**: a non-common within 25
placements, a radiant-or-better within 120.

Variants are applied by re-adapting the node — **never** by editing art modules:

```gdscript
var ctx: Dictionary = space.build_context(node.position, footprint)
ctx["variant"] = tier
ctx["variant_scale"] = VARIANT_SCALE[tier]
ctx["variant_tint"] = VARIANT_TINT[tier]
ItemCatalog.adapt(node, ctx)
node.scale = Vector2.ONE * VARIANT_SCALE[tier]
```
plus Discovery's own child overlay node (bloom ring / shimmer) for `radiant`+, drawn
in-file with the Proc toolkit.

#### Cross-pollination
Two **mature** (`growth ≥ 0.85`) plants/trees/fungi of **different species** within
**180 px**, both watered within the last 30 min (`Nurture.is_watered`), accrue
**dwell** at 1 s/s × `_mult("luck")` × season (Greenrise ×1.5, Bloomtide swell ×1.5).

```
POLLEN_DWELL   = 18 min   (pity 45 min of eligible dwell)
PAIR_COOLDOWN  = 2 h after a hybrid from the same pair
MAX_PAIRS      = 8 tracked simultaneously (nearest first)
```

On completion: a **pollen mote** (an inline ProcNode: a drifting golden puff with a
trailing shimmer) crosses from A to B over 3 s, both things sparkle, and a **hybrid
seed** enters the tray.

Hybrid identity: `species = "x:" + [a, b].sorted()[0] + "+" + sorted()[1]`, which
`ItemCatalog` resolves through Discovery's additive helper (§9.6) to the parent whose
art reads stronger, with the other parent's accent blended 35% and a `hybrid: true`
context flag. **Fourteen named hybrids** get real names and a Journal entry of their
own; everything else gets a seeded two-part name (`"Dew-Fern"`, `"Ember-Clover"`) so
nothing is ever called "Hybrid #7".

| Named hybrid | Parents |
|---|---|
| Dawnpoppy | poppy + sunflower |
| Mistbell | bluebell + fern |
| Emberclover | clover + poppy |
| Moonfern | fern + bluecap |
| Glasslily | lilypad + crystal |
| Ashblossom | blossom + toadstool |
| Willowlight | willow + lantern-flower |
| Stoneclover | clover + mushroom |
| Starthistle | daisy + crystalpink |
| Dewbirch | birch + fern |
| Thornapple | maple + bramble-flower |
| Lanternmoss | mushroom + bluecap |
| Frostbloom | blossom + geode |
| Sunoak | oak + sunflower |

#### Breeding
A kin-pair (`friendship` from CreatureLife, both bond ≥ 0.45) within **300 px** of a
`blockling_homes` building accrues egg dwell at 1 s/s × season (Greenrise ×1.5,
festival ×2.0).

```
EGG_DWELL   = 35 min  (pity 90 min)
PAIR_LIMIT  = 1 egg per pair per 6 h
HOME_GATE   = requires CreatureLife.home_capacity() > 0
```

Species of the egg: seeded pick weighted 60% toward the parents' `shape`, 25% toward
their `profession`, 15% free — climbing the `GameData.blocklings.rarities` ladder one
step at most, and only when both parents are `devoted`+. The egg enters the tray as a
`creature` entry with `growth: -1.0` so the existing placement path hatches it by
growing it, exactly as `egg:pip` does today.

#### The living Journal Tree
The game's **only** collection readout, and a real object in the world.

- **Planting:** the first time anything is discovered, a small second tree unfurls
  (`pop_in`) at `tx = heart_tx - 260` (seeded ±40, snapped to ground, skipped if
  occupied → next free spot outward). Stored as
  `discovery.journal = {planted: true, place_id: "journal_tree"}` — it is **not** a
  normal placement (it cannot be uprooted, minted, or harvested).
- **Form:** an inline `ProcNode` subclass. Its `growth` = `journal_progress()`
  (found / total), so the tree literally grows as you discover. **Eight branches**,
  one per category (species, creatures, hybrids, variants, recipes, rites, events,
  grounds). Each discovery is a **leaf** on its branch; each completed arc is a
  **blossom**; the newest leaf glows for 10 min.
- **Reading it:** `handle_tap` — a tap on the trunk whispers the newest discovery and
  the progress as a poetic fraction (*"Thirty-one leaves, and the branches still
  reaching"*); a tap within 24 px of a leaf whispers that entry's one line; a tap on
  a blossom whispers the arc. No panel, no grid, no pages.
- **Categories count:** derive `total` from live data —
  `GameData.decoration_types.size() + ItemCatalog.WILD_* pools + GameData.blocklings.size()
  + HYBRIDS + 4 variant tiers + Chains.recipes().size() + 9 rites + 6 event kinds +
  (4 seasons) + grounds awoken` — computed, never hardcoded, floored at 1.

Backfill: on first run, Discovery reads legacy `Game.state["discovered"]` and
`Game.state["placements"]` and plants the matching leaves silently (no whisper
storm — cap announcements at 1, *"The journal remembers what you have already met."*).

---

### 6.4 SeasonsEvents — `scripts/world/dyn/SeasonsEvents.gd`

**Node:** `class_name SeasonsEvents extends Node2D`, name `"SeasonsEvents"`.
**State key:** `seasons`. **Tick:** 10 s (plus per-frame only for falling-star motion).

#### Seasons: a 12-day year, derived from the clock
```
SEASON_HOURS = 72.0                      # 3 real days per season → 12-day year
epoch        = seasons.epoch (set once, = first boot unix)
elapsed_h    = (now - epoch) / 3600
season       = int(floor(elapsed_h / 72)) % 4
year         = int(floor(elapsed_h / 288))
phase        = fmod(elapsed_h, 72) / 72   # 0..1 within the season, for blending
```
Because it is purely derived, seasons advance offline for free; `catch_up` only has
to *announce* the change and re-apply visuals.

| # | Season | `modifier()` | Flavour |
|---|---|---|---|
| 0 | `greenrise` | `grow` 1.10, `luck` 1.20 (pollen/breeding ×1.5 via explicit queries) | pollen + butterflies ambience, bright soft sky |
| 1 | `highsun` | `yield` 1.10; water duration ×0.55 (Nurture reads `season_id`) | long days, dust motes, hot palette drift |
| 2 | `emberfall` | `yield` 1.08, seed-drop ×1.4, harvest cap ×1.25 | falling leaves, amber sky, mist mornings |
| 3 | `stillfrost` | `grow` **0.92** (the only sub-1.0 in the game), `yield` 1.05 for crystal, meteor weight ×2 | snow ambience, long nights, `warm` matters |

Season change: one whisper (*"Greenrise. The island leans into the light."*), a
**14-second cross-fade** of sky weather weights + ambience overlays, and a
`season_changed` event. Transitions blend over `phase ∈ [0.0, 0.04]` so there is no
snap.

Visuals: `ctx["sky"]` is the live `ProcSky` node (via `space.sky_node()`, §9.2).
Use its real API — `set_weather(w)`, `set_time_of_day(v)`, `set_parallax(off)` — and
mount season ambience with `ProcAmbience.make_effect(world_seed, key, kind, size,
opts)` (`leaves`, `snow`, `pollen`, `butterflies`, `rain`, `fireflies`, `birds`) on
SeasonsEvents' own child layer. **Never** fight `WorldSpace`'s own weather wander:
SeasonsEvents takes ownership by calling `set_weather` *more recently*; if its own
weather plan is `""` it leaves the sky alone.

`is_night()` reads the sky's `time_of_day` when available (`> 0.78 || < 0.10`), else
derives from `phase`.

#### Events — six kinds, always a soft window

```
EVENT_GAP       = 3.5 .. 7.0 h   (seeded, × 1/cadence_mult, floor 2.5 h)
MAX_ACTIVE      = 1 active + 1 queued
PITY_PER_KIND   = 36 h of play (merchant 24 h)
SOFT_END        = leftovers are mailed into the tray; one whisper; never a loss
```

| Event | Window | Trigger weight | What the player DOES | Grants |
|---|---|---|---|---|
| **Meteor shower** | 40–70 min, night only | ×2 in Stillfrost; `astral_keeper` spots it 5 min early | **Tap falling stars** (`handle_tap` against live mote positions, 48 px radius). Missed stars **land** and sit as glowing pebbles for 6 h — tap them any time. | `stardust` 2–5 each, `skyshard` ×1 per 3 catches, +1 `rare` pity credit per catch, `caught` counter |
| **Festival** | 90–180 min | fires when ≥4 creatures at bond ≥0.45, or on `arc_done`; max 1/20 h | Nothing required. Lanterns light along the island, creatures walk to the Heart Tree and dance (CreatureLife honours a `gather(pos)` request via `notify`). | all bonds +0.08 xp, moods `content`, `yield` 1.15 while it runs, feast recipes temporarily `knows`-true, 1 Journal leaf |
| **Merchant** | 60–120 min | +1 weight per `explorer` | A trader creature **walks in from the world edge** along the ground and stands. Tap → **3 seeded offers** as glyph pairs in the action bubble (`offer1/offer2/offer3` verbs); each is a straight swap. | rare seeds, a recipe, decor, a blessing token, hybrids for materials |
| **Migration** | 75–150 min | ×1.4 in Emberfall | Watch, or tap a passing creature to greet it (+bond chance). | `down-feather`/`shed-scale` → 2 materials; **one may settle** as a free creature if `home_capacity() > 0` and `avg_bond() ≥ 0.4` |
| **Bloomtide swell** | 30–90 min | ×1.5 in Greenrise | Nothing. It rains. | auto-water all (`Nurture.auto.rain_until`), `grow` 1.15 while raining, pollen ×1.5, `dewdrop` ×2 |
| **Aurora / quiet night** | 60 min | ×1.6 in Stillfrost | Nothing. It is beautiful. | `yield` 1.08, +1 **vigil charge** for Rituals, 1 Journal leaf |

Every event is announced by **one whisper and a world change you can see** — never a
banner. Events are *also* the `witness` targets for Wishes.

---

### 6.5 Rituals — `scripts/world/dyn/Rituals.gd`

**Node:** `class_name Rituals extends Node2D`, name `"Rituals"`.
**State key:** `rituals`. **Tick:** 5 s. **Gesture priority: first.**

#### The Ritual Circle (the in-world object)
A ring of standing stones on the ground at `tx = heart_tx + 300` (seeded ±50, ground
snapped, nudged outward past occupied space). It **appears** — unfurling from the
soil over 8 s with `pop_in` — the first time either is true: the player holds ≥ 120
essence, or a wish grants it. `rituals.circle = {planted, tx, stones}`.

Form (inline `ProcNode`): 3 stones at first, growing to 7 as rites are performed
(`stones = clampi(3 + done_total / 3, 3, 7)`), a worn earth ring, carved runes that
**light one by one** as offerings land, and a slow dust of motes rising from the
centre. While a rite runs, a column of soft light stands in the ring and the runes
pulse in sequence; the whole thing is drawn with `Proc.smooth_loop` + `grad_fill`,
animated by child transforms only.

#### Performing a rite — diegetic, drag-based, no recipe list
1. **Drag an offering from the tray onto the circle.** `handle_drop` consumes it
   (returns `true`), the item **visibly rests on a stone**, and the circle whispers
   what it now almost is: *"Dew and ember. It wants one more breath of essence."*
2. Rituals matches `rituals.pending.inputs` against the rite table. The **moment** a
   rite's full material set is present **and** the essence cost is affordable, the
   circle's runes complete and the ceremony begins automatically.
3. **The ceremony** runs `20 s – 4 min` (per rite). It is *watchable, not required*:
   leaving, panning away, or closing the app does not interrupt it — `ends` is a
   wall-clock stamp, so it completes offline.
4. On completion: a wave of light crosses the island, the blessing registers, a
   Journal leaf grows if first time, one whisper.
5. A wrong/partial set just **sits there**. Tap the circle (`handle_tap`) → `reclaim`
   verb returns everything to the tray. No loss, ever.

#### The nine rites

Costs are expressed in **minutes of the player's current essence income** so they
stay meaningful at every stage, with absolute guard rails:

```gdscript
func cost_for(rite_id: String) -> Dictionary:
    var mins: float = RITE[rite_id]["minutes"]
    var rate: float = 1.0
    var sim: Node = _ctx_sim()                         # IdleSim, optional
    if sim != null and sim.has_method("rates"):
        rate = maxf(0.5, float(sim.call("rates").get("essence", 1.0)))
    var ess: float = clampf(mins * 60.0 * rate, RITE[rite_id]["min_abs"], RITE[rite_id]["max_abs"])
    ess *= 1.0 + 0.30 * float(Game.state.get("ascension", {}).get("count", 0))
    var ak: float = _astral_keeper_discount()          # 0.90 if an astral_keeper is near
    return {"essence": ess * ak, "materials": RITE[rite_id]["mats"]}
```

| Rite | Minutes of income | abs floor/ceiling | Materials | Ceremony | Blessing (duration) |
|---|---|---|---|---|---|
| `rain` | 6 | 150 / 2 500 | dewdrop ×2 | 25 s | auto-water all; `grow` ×1.08 (2 h) |
| `warmth` | 7 | 180 / 3 000 | emberbloom ×2 | 30 s | `warm` on everything; Stillfrost penalty removed (3 h) |
| `light` | 9 | 240 / 4 000 | lightwell glass ×1 | 45 s | `yield` ×1.10 (3 h); Lightweave dells shimmer a hint |
| `roots` | 11 | 300 / 5 000 | heartwood ×3 | 60 s | `grow` ×1.12 on trees (4 h) |
| `kinship` | 13 | 360 / 6 000 | honeycake ×1 | 60 s | `bond` ×1.5, `cadence` ×1.35 (6 h) |
| `finding` | 15 | 420 / 7 000 | skyshard ×1 | 75 s | `luck` ×2.0 (2 h) |
| `plenty` | 18 | 500 / 9 000 | grainloaf ×2 | 90 s | harvest cap ×1.3, seed drops ×1.5 (4 h) |
| `stillness` | 20 | 560 / 10 000 | moonsilver ×1 | 90 s | `offline` full-credit 8 h → 12 h (8 h) |
| `long_year` | 40 | 1 200 / 24 000 | one of each: grainloaf, honeycake, lightwell glass, rootbalm | 4 min | all of the above at **half strength** (24 h) + a permanent Journal blossom |

Only **3 rites may be active** at once; a fourth replaces the weakest with a
whisper, never silently. If Chains is absent, materials are waived and essence ×1.5.

`blessing(key)` returns the clamped product of all active rites + permanent arc
grants, and is the single authority for the §2.1 caps:

```gdscript
func blessing(key: String) -> float:
    var m := 1.0
    for rid in _active_ids():
        m *= float(RITE[rid]["blessing"].get(key, 1.0)) ** _strength(rid)
    m *= 1.0 + _permanent.get(key, 0.0)
    return clampf(m, 0.92, PERMITTED[key])
func register_permanent(key: String, amount: float) -> void   # Wishes' arc grants, ≤ +0.12 total
```

#### The Ascension ceremony
`IDLE-DESIGN §2.7` makes Ascension the Heart Tree's deep ritual. Rituals makes it a
*ceremony*, not a confirm:

1. When `Ascension.can_ascend()` turns true, the Heart Tree gains a slow **golden
   bloom** (a Rituals-owned overlay child on `space.heart_node()`), the circle grows
   an **eighth stone**, and one whisper arrives: *"The tree is ready to begin again.
   It asks for three nights."*
2. **Three vigils.** Each vigil is a 10-minute ritual at the circle, and **only one
   vigil may be completed per in-world night** (`SeasonsEvents.is_night()`; if
   SeasonsEvents is absent, one per 6 h). An Aurora event grants a free vigil charge.
   `rituals.vigils = {n, last}`. Each vigil lights one of three lanterns around the
   circle and drifts a line of motes to the Heart Tree.
3. With `vigils.n >= 3`, a **long-press on the Heart Tree** (the `handle_heart_hold`
   hook, §9.5) raises the one confirm bubble: `ascend` / `wait`. "Wait" costs nothing
   and the vigils persist forever.
4. On ascend: call the existing `Ascension.ascend()`. This layer additionally
   **keeps**: the Journal Tree and every leaf/blossom, learned recipes, arc progress,
   discovered hybrids, bond *memories* (bond is restored at 50% for any creature that
   returns), and up to **4 Everbloom** placements chosen before the ceremony (tap a
   thing during a vigil → `everbloom` verb; Beloved or minted things only).
   It **resets**: stockpiles, active rites, active wishes (shelved, not lost),
   placements (per the base game's rules).

---

### 6.6 Chains — `scripts/world/dyn/Chains.gd`

**Node:** `class_name Chains extends Node2D`, name `"Chains"`.
**State key:** `chains`. **Tick:** 2 s. **Gesture priority: second.**

#### The 12 new items (8 raw + 4 crafted)

Materials are **shed by living things you already have**, under conditions you create
by tending. No shop, no node to click.

| id | label | Source condition | Interval | Season/flavour |
|---|---|---|---|---|
| `dewdrop` | Dewdrop | any plant/tree watered within 30 min | 40 min | ×2 while raining; Highsun ×1.3 |
| `heartwood` | Heartwood | a tree at `growth` 1.0, pruned within 3 h | 90 min | Emberfall ×1.3 |
| `emberbloom` | Emberbloom | a `sunflower`/`poppy`/`tulip` in Highsun, or under Rite of Warmth | 60 min | — |
| `moonsilver` | Moonsilver | any crystal, at night | 70 min | Stillfrost ×1.4 |
| `skyshard` | Skyshard | meteor catches (not an interval source) | — | Stillfrost ×2 |
| `lichen_wool` | Lichen Wool | a fungus within 120 px of a `rock`/`pebbles`/stone decor | 80 min | mist ×1.3 |
| `honeycomb` | Honeycomb | a cluster of ≥3 plants within 200 px (the cluster centre is the source) | 55 min | Greenrise ×1.4; festival ×1.5 |
| `river_clay` | River Clay | any water feature (`pond`/`lilypad`/`well`) | 65 min | rain ×1.5 |

| id | label | Recipe | Site | Craft time |
|---|---|---|---|---|
| `grainloaf` | Grainloaf | `honeycomb ×1 + dewdrop ×2` | Hearthstone | 5 min |
| `honeycake` | Honeycake | `honeycomb ×2 + grainloaf ×1` | Hearthstone | 8 min |
| `lightwell_glass` | Lightwell Glass | `river_clay ×1 + skyshard ×1` | Craftlog | 10 min |
| `rootbalm` | Rootbalm | `lichen_wool ×1 + dewdrop ×1 + heartwood ×1` | Craftlog | 12 min |

**Stretch (optional, same shape):** `kindling_lamp` (`heartwood + emberbloom`,
Craftlog, 7 min — the `warm` fuel) and `starcloth` (`moonsilver + lichen_wool ×2`,
Craftlog, 14 min — a decor + merchant currency).

Interval modifiers: × `1/_mult("yield", place_id)` (so care, jobs, variants and
blessings all speed material shedding), × season, × 0.85 with a `gatherer` nearby,
× 0.70 for a `radiant`+ variant source. Pity: if a source misses, its next interval
is × 1.6 shorter, capped once.

#### Stockpiles
A new placeable: **`pile:basket`** (`kind: "decor"` to the existing placement path,
`species: "stockpile"`, art owned by Chains). Granted 1 at first material gain, 2
more via wishes. Max 3 placed, **24 items each (72 total)**.

- Visible contents: the heap **draws what is in it** — a stack of loaves, a coil of
  wool, a cluster of shards — growing with fill level. The basket's `growth` tracks
  `fill/24` so it visually swells.
- Materials shed by a source fly to the nearest basket as motes (reuse
  `space.drift_mote()` style or Chains' own) and land in `chains.piles`.
- **Overflow is never lost**: when all baskets are full the source keeps its material
  in `chains.buffer` and its glow intensifies (a `stock_full` event + one whisper per
  20 min max). Place another basket or take some out and it flows again.
- Tap a basket → `extra_actions` offers `take` (move its contents into the tray, i.e.
  `Game.state["inventory"]`) and `inspect` (a whisper of what it holds, poetically:
  *"Three loaves, a coil of wool, and something that glitters."*).

#### Craft sites and the combination craft
Two new placeables, each granted by an early wish:

- **`site:hearth`** — Hearthstone: a flat warm stone with a low fire; food recipes.
- **`site:craftlog`** — Craftlog: a worked log bench with a small kiln; everything else.

The craft is **drag-and-see**, not a recipe menu:

1. Drag a material chip from the tray onto a site. `handle_drop` consumes it and the
   material **physically appears on the site** (a loaf of dough, a shard, a coil).
2. When the inputs on a site exactly match a known recipe
   (`chains.learned[recipe]`), the site **glows** and crafting starts automatically.
   `ends = now + craft_seconds / _mult("craft", site_place_id)` (artisan ×1.20,
   blessings, festival).
3. When it finishes, the **output sits on the site, glowing, forever** until tapped
   (`take` verb → into the tray). `craft_done` fires; first-ever craft of a recipe is
   a Journal leaf.
4. Inputs that match nothing just sit there. Tap → `reclaim` returns them to the tray.
   Nothing is consumed until a recipe actually starts.

Recipes are **learned**, not browsed: `grainloaf` is known from the start;
`lightwell_glass` from the first skyshard; `rootbalm` from a wish or a merchant;
`honeycake` from a festival or `Discovery` hybrid. `knows(recipe)` is the gate and
Wishes/Rituals both respect it.

#### Material items in the tray
Materials are inventory entries with `kind: "material"`:

```gdscript
{"count": 3, "kind": "material", "species": "dewdrop", "label": "Dewdrop",
 "growth": -1.0, "minted": false}
```

They must **not** be plantable. Two parts:
- `ItemCatalog` additive block (Chains owns it, §9.6): `MATERIALS` definitions,
  `is_material(entry)`, `material_def(id)`, `material_entry(id, count)`, and
  `ground_type` override advice (`"none"`).
- The **one-line maintainer hook** in `ItemCatalog.make_node`'s `match` (§9.6) so a
  material chip/ghost draws Chains' own little bundle icon rather than falling through
  to a flower.
- Chains' `handle_drop` runs **before** placement (§9.5), so a material dragged onto a
  craft site or a basket is consumed there; dropped anywhere else it springs back to
  the basket with a gentle whisper (*"That is for the hearth, not the soil."*).

---

### 6.7 Nurture — `scripts/world/dyn/Nurture.gd`

**Node:** `class_name Nurture extends Node2D`, name `"Nurture"`.
**State key:** `nurture`. **Tick:** 1 s.

#### Four verbs, added to the existing action bubble

`extra_actions(record)` appends, in this order, only when applicable:

| Verb | Gate | Cost | Effect | Visual |
|---|---|---|---|---|
| `water` | plants/trees/fungi, not watered in the last 10 min | free | `grow` ×1.20 for **45 min** (×0.55 in Highsun; ×2 duration if performed while raining; ×1.25 with a `guardian` nearby) + becomes a `dewdrop` source | a damp sheen (modulate + 3 falling droplet motes), a short ground darkening |
| `prune` | `growth ≥ 0.6`, not pruned in 60 min; **refused in a storm** | free | `yield` ×1.15 for **90 min** + becomes a `heartwood` source; Greenrise adds +1 heartwood | 4 snipped leaf motes drift away; `ctx["pruned"] = true` re-adapt for a tidier crown |
| `feed` | anything | `grainloaf`/`rootbalm` ×1 via `Chains.take()`, else 6 essence | `growth +0.06` (`+0.10` with rootbalm) via `node.grow_to()`; creature: mood → `content`, `bond_xp +0.09` | a warm pulse ring + 2 rising sparkles |
| `warm` | only when `season_id() == "stillfrost"` or `is_night()`; not warm already | `kindling_lamp` ×1, else 10 essence | removes the Stillfrost `grow` penalty on that thing for **4 h**; creature: `bond_xp +0.04` | a soft ember glow at the base, breathing |

Refusals are **always a whisper, never a penalty**: *"The wind is too strong — later."*
/ *"It drank its fill not long ago."* No cooldown is ever displayed.

Nurture also **listens** to `WorldSpace.nurture()` (the existing essence-for-growth
verb) through the `nurtured` relay and credits it as a `feed` for `tended` purposes —
so the base game's verb and this layer agree.

#### Weather and season interplay (the heart of it)

| Condition | Effect |
|---|---|
| Rain / Bloomtide swell / Rite of Rain | **auto-water everything** — `nurture.auto.rain_until = now + duration`. `is_watered()` returns true for all while it holds. Watering by hand during rain gives ×2 duration. |
| Highsun | water duration ×0.55 — summer is when watering actually matters |
| Stillfrost | `grow` ×0.92 unless the thing is `warm` or the Rite of Warmth is active |
| Greenrise | `prune` yields +1 heartwood; care buff durations ×1.15 |
| Emberfall | `prune` yield-buff ×1.2 |
| Storm | `prune` gently refused (unless a `guardian` is within 220 px) |
| Night | `water` buff duration ×1.2 (cool air); `warm` becomes available |

#### `tended` — the long, quiet progression
Every successful care increments `nurture.care[place_id].tended`.

| `tended` | Reward |
|---|---|
| every 10 | +0.01 **permanent** `grow_rate` bonus on that thing (cap +0.10 at 100) |
| 25 | **Beloved**: a permanent soft halo (a low-opacity bloom ring child), `yield` ×1.08, eligible as a Wishes subject and as an **Everbloom** keepsake |
| 50 | a Journal leaf (*"Well-tended"*) and the thing's inspect line gains a second clause |
| 100 | the thing drops a seed of itself into the tray once per 24 h |

#### The pity "ask"
If no care verb has succeeded in **25 minutes of play**, the thing that would benefit
most (lowest `grow` multiplier × highest `growth` headroom) **asks**: a droplet or
leaf thought bubble over it plus a 20% selection-ring glow, for 12 s, once per 25 min.
That same pick is handed to Wishes (`offer_hint`) so a `tend` wish lands on something
the player can see is asking. An ask is an **invitation** — ignoring it costs nothing
and the bubble simply fades.

---

## 7. Cross-cutting rules the agents must share

### 7.1 Finding and touching placed things
Never cache a node pointer across frames without `is_instance_valid`. The canonical
loop (note the explicit typing — warnings-as-errors):

```gdscript
var space: WorldSpace = _space
if space == null or not space.has_method("records"):
    return
for item in space.records():
    var r: Dictionary = item
    if not (r.get("node") is ProcNode) or not is_instance_valid(r["node"]):
        continue
    var node: ProcNode = r["node"]
    var pid: String = String(r.get("id", ""))
```

### 7.2 Applying a `grow`/`yield` multiplier
- **`grow`**: multiply the node's `grow_rate`. Store the base once
  (`node.set_meta("dyn_base_grow", node.grow_rate)` if absent) and always recompute
  `node.grow_rate = base * effective("grow", pid)` — never accumulate.
  Respect freeze: if `GrowthState.is_frozen(entity_id)` or the record is `minted`,
  leave `grow_rate` at 0.
- **`yield`**: do not touch `record.stock` directly. The honest seam is
  `ItemCatalog.base_yield` × the record's live multiplier, consumed by
  `WorldSpace._process`. Since `WorldSpace` is off-limits, the designed hook is a
  **yield-multiplier callback** (§9.2): `space.set_yield_mult_fn(Callable)`, called
  per record per tick. Until it is wired, `yield` effects still land on **Chains**
  material intervals and on harvest-time bonuses that Chains/Nurture apply through
  `give()`, so nothing is blocked.

### 7.3 Granting items into the tray
One shared pattern (each agent implements it locally; it must match exactly so counts
never diverge):

```gdscript
func _grant(item_key: String, entry: Dictionary, n: int = 1) -> void:
    if not (Game and Game.state is Dictionary):
        return
    if not Game.state.has("inventory") or not (Game.state["inventory"] is Dictionary):
        Game.state["inventory"] = {}
    var inv: Dictionary = Game.state["inventory"]
    if not (inv.get(item_key) is Dictionary):
        var e: Dictionary = entry.duplicate(true)
        e["count"] = 0
        inv[item_key] = e
    var cur: Dictionary = inv[item_key]
    cur["count"] = int(cur.get("count", 0)) + n
    var tray: Node = _tray()          # via ctx.interact, optional
    if tray != null and tray.has_method("refresh"):
        tray.call("refresh")
    Game.emit_signal("state_dirty")
```

`item_key` conventions: `mat:<id>`, `seed:<species>`, `egg:<species>`,
`recipe:<id>`, `pile:basket`, `site:hearth`, `site:craftlog`, `decor:<id>`.
**Never** reuse an existing starter key with a different shape.

### 7.4 Visual conventions for this layer
- **Thought bubbles** (CreatureLife, Wishes, Nurture's ask): one shared visual
  language — a `Proc.smooth_loop` parchment cloud, 2 trailing dots toward the
  speaker, a 1.5 px ink outline, `PARCH #FBF6E9` / `INK #3A2E22`, a generated glyph
  inside. Pop in over 0.18 s with `TRANS_BACK`, hold 4–6 s, fade 0.4 s. Each agent
  writes its own inline class — they only need to *look* like one family.
- **Glows**: reuse `ProcEffects.make_selection_ring(world_seed, key, {radius, style,
  ground, z, color})` with `style: "bloom"` for positive states and `"rune"` for
  ritual/wish states. Opacity ≤ 0.45 so the island never looks like a Christmas tree.
- **Motes**: `ProcEffects.make_pickup_float` for resources; your own tiny ProcNode for
  pollen / stars / offering motes. Global soft budget: **24 extra motes** from this
  whole layer at once (the existing `MAX_MOTES`/`MOTE_CAP` belong to WorldSpace and
  IdleSim — do not raise them).
- **Season tinting**: never recolour a thing directly. Pass `ctx["season"]`,
  `ctx["season_tint"]` through `ItemCatalog.adapt()` and let the art modules decide.

### 7.5 GDScript under warnings-as-errors
- Type every local that would otherwise infer `Variant`:
  `var d: Dictionary = x.get("k", {})`, `var f: float = float(x.get("k", 0.0))`,
  `for item in arr: var r: Dictionary = item`.
- Guard every autoload: `if Game == null or not (Game.state is Dictionary): return`.
- Guard every sibling: `if s != null and s.has_method("x")`.
- Guard every signal connection: `if n.has_signal("x") and not n.x.is_connected(f)`.
- Never `await` in a `_process`-driven path; use accumulators and wall-clock stamps.
- `class_name` must be unique — `grep -rn "^class_name <Name>" scripts/` before you
  commit to a name.
- Verify with `godot --headless --check-only --script <file>` (or the project's
  existing check task) and **do not** run the whole project.

---

## 8. Performance budget

| System | Tick | Budget |
|---|---|---|
| CreatureLife | per-frame movement for ≤ 24 creatures; 1 s logic | 0.35 ms |
| Nurture | 1 s | 0.10 ms |
| Chains | 2 s | 0.15 ms |
| Discovery | 5 s | 0.15 ms |
| Wishes | 5 s | 0.10 ms |
| Rituals | 5 s | 0.10 ms |
| SeasonsEvents | 10 s (per-frame only for live star motes) | 0.15 ms |
| **Total** | | **≤ 1.2 ms/frame** |

Rules: accumulate `delta` and early-return (`if _acc < PERIOD: return`); never
allocate in a per-frame path; cache the nearest-neighbour queries (recompute at most
every 5 s); redraw only when a shape actually changes (`queue_redraw` gated on a
threshold, exactly as `ProcNode` does at 0.0025 growth); keep every new ProcNode's
`_draw` under ~150 draw calls; stagger all per-entity work round-robin
(`i % n == frame % n`) when a list is long.

---

## 9. The exact hooks the maintainer must wire

Build agents: do **not** apply these. Put them verbatim in your integration note.
They are designed so **one** set of edits serves all seven systems.

### 9.1 `scripts/Main.gd` — mount the Dyn layer (in `_wire_world`, after `_wire_puzzles`)

```gdscript
var dyn := Node2D.new()
dyn.name = "Dyn"
space.cam_node().add_child(dyn)

# mount order IS gesture priority (see DYNAMICS §4.2)
var systems: Array[Node] = [Rituals.new(), Chains.new(), SeasonsEvents.new(),
    Discovery.new(), Wishes.new(), Nurture.new(), CreatureLife.new()]
var names: Array[String] = ["Rituals", "Chains", "SeasonsEvents",
    "Discovery", "Wishes", "Nurture", "CreatureLife"]
for i in range(systems.size()):
    systems[i].name = names[i]
    dyn.add_child(systems[i])

var dyn_ctx := {"space": space, "interact": _interact, "sim": _sim,
                "puzzles": _puzzles, "sky": space.sky_node()}
for s in dyn.get_children():
    if s.has_method("setup"):
        s.call("setup", ws, dyn_ctx)
    if s.has_signal("whisper"):
        s.whisper.connect(func(t: String): _interact.whisper(t))
# cross-connect the event language: every emitter → every other listener
for a in dyn.get_children():
    if not a.has_signal("dyn_event"):
        continue
    for b in dyn.get_children():
        if a == b or not b.has_method("notify"):
            continue
        a.dyn_event.connect(func(k: String, p: Dictionary): b.call("notify", k, p))
# puzzle rewards are arc + journal material
if _puzzles != null:
    _puzzles.puzzle_solved.connect(func(id: String, _r: Dictionary):
        for s in dyn.get_children():
            if s.has_method("notify"):
                s.call("notify", "puzzle_solved", {"id": id}))
```

Also, in `Main._interact.world_booted` path there is already an offline relay through
`Interact`; nothing further is needed here.

### 9.2 `scripts/world/WorldSpace.gd` — additive accessors + four signals

Purely additive. No existing behaviour changes.

```gdscript
# --- new signals (emit at the marked call sites) -----------------------------
signal placed(record: Dictionary)                 # end of place()
signal removed(place_id: String, entry: Dictionary)   # in remove_record(), before return
signal nurtured(record: Dictionary)               # end of nurture(), after _persist()
signal harvested(record: Dictionary, resource: String, amount: float)  # end of harvest()

# --- new read accessors -----------------------------------------------------
func sky_node() -> ProcNode: return _sky
func fx_layer() -> Node2D: return _fx_layer
func records() -> Array: return _records
func record_by_id(place_id: String) -> Dictionary:
    for r in _records:
        if String(r.get("id", "")) == place_id: return r
    return {}
func ground_origin() -> Vector2: return _ground_origin
func ground_surface_at(tx: float) -> float: return _ground_surface(tx)
func ground_span() -> Vector2: return _ground_extents()
func heart_tx() -> float: return terrain_x(_heart_base)

# --- public wrappers for the existing private FX helpers --------------------
func spawn_world_fx(world_pos: Vector2, kind: String, material: String = "", res: String = "") -> void:
    _spawn_fx(world_pos, kind, material, res)
func drift_mote_pub(from: Vector2, res: String, amount: float) -> void:
    _drift_mote(from, res, amount)

# --- OPTIONAL (unlocks the `yield` multiplier, DYNAMICS §7.2) ---------------
var _yield_mult_fn: Callable = Callable()
func set_yield_mult_fn(fn: Callable) -> void: _yield_mult_fn = fn
#   …and in _process(), where `rate` is computed:
#   var rate: float = ItemCatalog.base_yield(r.entry) * gv
#   if _yield_mult_fn.is_valid(): rate *= float(_yield_mult_fn.call(r))
```

### 9.3 `ActionBubble` — **no edit required**

`LABELS.get(action, action.capitalize())` and `TINTS.get(action, …)` already handle
unknown verbs. All new verbs are therefore single lowercase words that capitalize
cleanly: `pet` `play` `gift` `water` `prune` `feed` `warm` `hear` `grant` `take`
`reclaim` `craft` `offer` `everbloom` `ascend` `wait` `offer1` `offer2` `offer3`.

*Optional polish only* (one additive block the maintainer may add to make the pills
prettier — never required for function):

```gdscript
# appended inside LABELS / TINTS
"water": "Water", "prune": "Prune", "feed": "Feed", "warm": "Warm",
"pet": "Pet", "play": "Play", "gift": "Gift", "hear": "Listen",
"grant": "Grant", "take": "Take", "reclaim": "Take back",
"offer1": "Trade", "offer2": "Trade", "offer3": "Trade",
"everbloom": "Keep", "ascend": "Begin again", "wait": "Not yet",
```

### 9.4 `scripts/world/Interact.gd` — a public whisper + two tiny accessors

```gdscript
func whisper(text: String, hold: float = 2.6) -> void:   # public relay for Dyn systems
    _show_whisper(text, hold)
func is_placing() -> bool: return _placing
func tray() -> InventoryTray: return _tray
func dyn() -> Node2D:
    return _space.cam_node().get_node_or_null("Dyn") if _space != null else null
```

### 9.5 `scripts/world/Interact.gd` — five dispatch points

Each is 2–6 lines and serves all seven systems.

**(a) extra bubble verbs** — in `_open_bubble`, after `var actions := ItemCatalog.actions_for(...)`:
```gdscript
var d := dyn()
if d != null:
    for s in d.get_children():
        if s.has_method("extra_actions"):
            var extra: Array = s.call("extra_actions", record)
            for a in extra:
                if not actions.has(a):
                    actions.append(a)
```

**(b) new verbs dispatch** — in `_on_action_chosen`, as the `match`'s default arm:
```gdscript
        _:
            var d := dyn()
            if d != null:
                for s in d.get_children():
                    if s.has_method("handle_action") and bool(s.call("handle_action", action, rec)):
                        break
```

**(c) drops onto in-world objects** — in `_end_ghost`, **before** `if bool(res.ok):`:
```gdscript
    var d := dyn()
    if d != null:
        for s in d.get_children():
            if s.has_method("handle_drop") and bool(s.call("handle_drop", _ghost_entry, _ghost_key, world)):
                if not _ghost_from_world and _ghost_key != "":
                    _tray.consume(_ghost_key)
                if Game: Game.save_now()
                _cancel_ghost()
                return
```

**(d) taps on in-world objects** — in `_on_world_release`, in the clean-tap branch,
**before** `if pressed_heart:`:
```gdscript
    var d := dyn()
    if d != null:
        var wp := _space.screen_to_world(p)
        for s in d.get_children():
            if s.has_method("handle_tap") and bool(s.call("handle_tap", p, wp)):
                return
```

**(e) the Heart-Tree long-press (Ascension ceremony)** — in `_process`, beside the
existing pick-up long-press:
```gdscript
    if _pressing and not _panning and not _placing and _press_heart and _press_record.is_empty():
        if _now() - _press_time >= 0.6:
            _pressing = false
            var d := dyn()
            if d != null:
                for s in d.get_children():
                    if s.has_method("handle_heart_hold") and bool(s.call("handle_heart_hold")):
                        break
```

**(f) offline catch-up** — in `_on_offline_ready(summary)`, after
`_space.play_offline_timelapse(summary)`:
```gdscript
    var d := dyn()
    if d != null:
        var el := float(summary.get("elapsed", 0.0))
        for s in d.get_children():
            if s.has_method("catch_up"):
                s.call("catch_up", el)
```

**(g) WorldSpace signal relay** — in `_boot()`, right after `_space.restore_from_state()`
is **not** enough (Dyn is mounted later by Main), so relay in Main instead, directly
after mounting Dyn:
```gdscript
space.placed.connect(func(rec: Dictionary):
    for s in dyn.get_children():
        if s.has_method("notify"): s.call("notify", "placed", rec))
space.removed.connect(func(pid: String, entry: Dictionary):
    for s in dyn.get_children():
        if s.has_method("notify"): s.call("notify", "removed", {"place_id": pid, "entry": entry}))
space.nurtured.connect(func(rec: Dictionary):
    for s in dyn.get_children():
        if s.has_method("notify"): s.call("notify", "nurtured", rec))
space.harvested.connect(func(rec: Dictionary, res: String, amt: float):
    for s in dyn.get_children():
        if s.has_method("notify"): s.call("notify", "harvested",
            {"record": rec, "resource": res, "amount": amt}))
```

### 9.6 `scripts/world/ItemCatalog.gd` — append-only, two owners only

Only **Chains** and **Discovery** may append, each exactly one block at the **end** of
the file, headed by its marker comment. Nothing existing may be modified.

```gdscript
# --- dyn:chains (additive) ---------------------------------------------------
const MATERIALS := { "dewdrop": {...}, ... }          # 8 raw + 4 crafted
static func is_material(entry: Dictionary) -> bool
static func material_def(id: String) -> Dictionary
static func material_entry(id: String, count: int = 1) -> Dictionary
static func craft_sites() -> Array                      # the two site entries
static func stockpile_entry() -> Dictionary

# --- dyn:discovery (additive) ------------------------------------------------
const HYBRIDS := { "x:oak+sunflower": {"label": "Sunoak", ...}, ... }   # 14 named
static func hybrid_def(species: String) -> Dictionary
static func hybrid_species(a: String, b: String) -> String
static func hybrid_label(species: String) -> String
static func variant_label(tier: String) -> String
```

**One maintainer line** inside `ItemCatalog.make_node`'s `match kind:` block (so
material chips/ghosts draw as bundles, not flowers):
```gdscript
            "material":
                node = Chains.make_material_icon(world_seed, inst_key, String(entry.get("species", "")), ctx)
```
If this line is not wired, materials simply render as a small flower — ugly but
harmless; no system is blocked.

### 9.7 What nobody may touch
`scripts/Main.gd`, `scripts/world/WorldSpace.gd`, `scripts/world/Interact.gd`,
`scripts/world/ActionBubble.gd`, `scripts/world/InventoryTray.gd`,
`scripts/world/Puzzles.gd`, `scripts/world/IdleSim.gd`,
`scripts/world/GrowthState.gd`, `scripts/proc/*`, `data/*.json`, `project.godot`.
`ItemCatalog.gd` only as §9.6. Everything else you need goes in your own file under
`scripts/world/dyn/`.

---

## 10. Build order and the definition of done

Agents can build in parallel; nothing in this design requires another system to
exist. Recommended reading order within a file: state → queries → tick → visuals →
gestures → interlocks.

A system is **done** when all of these are true:

1. Its single file exists under `scripts/world/dyn/`, parses clean under
   warnings-as-errors, and declares a unique `class_name`.
2. It implements `setup` / `catch_up` / `notify` and its half of §4.4 exactly.
3. It owns exactly one `Game.state` key, backfills every field with `.get` defaults,
   and loads a legacy save (no dyn keys at all) without a single error.
4. Every random outcome goes through the persisted-counter pattern (§2.5) and has a
   pity ceiling (§2.2).
5. Every multiplier it produces respects the §2.1 caps and the 0.92 floor, and every
   sibling query it makes is `has_method`-guarded with a neutral fallback.
6. It adds **no** panel, menu, HUD, bar or list — only bubbles, glows, motes,
   whispers, in-world objects and ActionBubble verbs.
7. It respects its §8 tick budget and allocates nothing per frame.
8. Its integration note lists: files created, public API, the state key and its
   shape, and precisely which of the §9 hooks it depends on (and what degrades, not
   breaks, if a hook is unwired).

The last line of the design, and the test for every decision in it: **after each
system lands, the island should have more to do and feel calmer, not busier.**
