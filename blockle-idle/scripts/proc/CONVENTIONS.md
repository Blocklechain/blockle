# Blockle Idle — Procedural Generation Engine Conventions

Every visual in this game is **generated from math** — no imported images, no emoji,
no pre-baked assets. Read this file, `scripts/autoload/Proc.gd`, and
`scripts/proc/ProcNode.gd` before writing a module. Follow it exactly so all modules
compose into one coherent, beautiful, living world.

## The seven hard rules

1. **Recognizable, never abstract.** A tree reads as a tree, a cottage as a cottage,
   a Blockling as a cute storybook creature. Use strong, clear silhouettes. The
   entity's existing data (`shape`, `profession`, `type`, `palette`) drives the form
   so a "fox" creature looks foxy and a "library" building looks like a library.
2. **Smooth, hand-drawn feel.** No hard facets. Build outlines with
   `Proc.smooth_loop` (Catmull-Rom), `Proc.superellipse`, and `Proc.blob`; fill with
   vertex-colour gradients (`draw_polygon(pts, Proc.grad_fill(pts, top, bot))`); use
   many-segment arcs and antialiased `draw_polyline(pts, col, width, true)` with
   rounded feel. Layer a soft contact shadow, a mid tone, and a highlight.
3. **Seeded + limitless.** Everything is a pure function of `(world_seed, keys)` or
   explicit params. The same world regenerates identically; different seeds diverge
   completely. Never use `randf()`/`Time` directly — use `Proc.rng/hashf/rangef/noise`.
4. **Growth is first-class and CONTINUOUS + VERY SLOW.** Extend `ProcNode`. Your
   `_draw` must render a believable stage for ANY `growth` in [0,1] — a seedling at
   0.15, a sapling at 0.5, mature at 1.0 — interpolated smoothly (use `g()` for an
   eased value). Growth creeps up continuously over ~25 real minutes by default
   (`ProcNode.grow_rate`); do NOT fight it. Spawning uses `pop_in()`, level-ups use
   `grow_to()`.
5. **Alive.** Everything animates subtly and forever: trees sway, creatures breathe
   and blink, water shimmers, crystals pulse, flags flutter, motes drift. Prefer
   CHEAP animation — animate child-node transforms (rotate/scale/skew) and shader
   uniforms in `_animate(delta)`; only set `animate_draw = true` if the *shape*
   itself must change each frame. Use `t` (seconds) and `phase` (per-instance desync).
6. **Performant.** A screen may hold 100+ living things. Keep `_draw` to a few
   hundred draw calls; cache heavy point arrays; lean on `ShaderMaterial` (GPU) for
   skies/water/glow. Never allocate per frame in `_animate`.
7. **Portrait + feet-at-origin.** The game is portrait (1080×1920). Standing things
   (trees, creatures, buildings, decorations) anchor BOTTOM-CENTRE at the node origin
   (feet at y=0, body drawn at negative y). Backgrounds fill a given `size` from
   top-left.

## Proc toolkit (scripts/autoload/Proc.gd, autoload `Proc`)
- `seed_from_text(text) -> int` · `rng(seed,key)` · `hashf(seed,key)->[0,1)` · `rangef(seed,key,lo,hi)`
- `noise(seed,key,freq,octaves) -> FastNoiseLite`
- `palette(seed,key) -> {base,base_dk,base_lt,accent,accent_dk,sky_top,sky_bot,soil,ink,hue,scheme,warm}`
- `smooth_loop(controls, samples) -> dense PackedVector2Array` (Catmull-Rom closed)
- `blob(seed,key,radius,lobes,wobble)` · `superellipse(rx,ry,n,steps)` · `grad_fill(poly,top,bot)->PackedColorArray`

## ProcNode base (scripts/proc/ProcNode.gd)
`class_name ProcNode extends Node2D`. Fields: `seedv`, `growth`, `t`, `phase`,
`grow_rate`, `animate_draw`. Override `_on_built()` (build child nodes/shaders once),
`_animate(delta)` (cheap per-frame transform/uniform animation), `_on_growth()`
(react to a new growth value), and `_draw()`. Use `g()` for eased growth, `pop_in()`
/ `grow_to()` for bumps, `set_grow_minutes(m)` to tune pace.

## Module shape
Each module is a new file `scripts/proc/<Name>.gd`:
`class_name <Name> extends RefCounted`, with static factory functions returning a
ProcNode subclass instance (define the subclass(es) in the same file, inner or
sibling classes). Example:
```
class_name ProcTrees extends RefCounted
static func make(world_seed:int, key:String, species:String="oak") -> ProcNode:
    var n := _Tree.new(); n.seedv = hash("%d:%s"%[world_seed,key]); n.species = species; return n
class _Tree extends ProcNode:
    var species := "oak"
    func _draw(): ... # recognizable tree, staged by g()
    func _animate(d): ... # sway via rotation of canopy child
```
Keep each module **large and thorough** — many species/variants/shapes, rich detail,
real growth staging, real animation. Target genuinely beautiful, shippable art.

## Available game data (read via GameData autoload, do not hardcode)
- `GameData.blocklings` — each `{id, shape, profession, palette, ...}`
- `GameData.buildings` — each `{id, name, art:{shape,palette}, ...}`
- `GameData.realms` — each `{id, name, sky:[...], accent, prod_mult, ...}`
- `GameData.decoration_types` — each `{id, material, prompt}` (material: plant/fungus/crystal/light/stone/wood/water)

## Godot 4.7.2 notes
- Inline shaders: `var sh := Shader.new(); sh.code = "..."; var m := ShaderMaterial.new(); m.shader = sh; node.material = m`. Canvas shaders: `shader_type canvas_item;`.
- Tweens: `create_tween()`. Noise: `FastNoiseLite`. No `Time`/`randf()` for generation.
- Validate your file parses, but DO NOT run the whole project (other modules may not exist yet) and DO NOT git commit. Create ONLY your `scripts/proc/<Name>.gd` file.
