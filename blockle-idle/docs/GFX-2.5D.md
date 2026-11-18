# GFX-2.5D — The Depth, Light & Atmosphere Architecture

Status: BUILD SPEC (v1). Audience: the ~20 build agents implementing the 2.5D
upgrade. Read `scripts/proc/CONVENTIONS.md`, `scripts/autoload/Proc.gd`, and
`scripts/proc/ProcNode.gd` FIRST — every rule there still binds. This document is
ADDITIVE: no existing public factory or API signature changes. Anything here that
touches an existing module is an extension (new optional `opts` keys, new methods,
new child nodes), never a rewrite of a signature that `WorldSpace`, `ItemCatalog`,
`Interact`, `IdleSim`, `Puzzles` or `StartJourney` already calls.

Target: portrait 1080×1920 mobile, Godot 4.7.2 GDScript, warnings-as-errors,
100% procedural (no image assets, no emoji), 60 fps with 100+ living things.

---

## 0. One-page summary of the new world

Today the island is a single ground CONTOUR (`ProcTerrain._Island.surface_y(tx)`)
with everything planted on one line, z-ordered by layer constants. The upgrade
turns that line into a ground BAND with continuous depth `d ∈ [0,1]` (0 = front
edge, nearest the player; 1 = back edge at the horizon), five derived planting
rows, per-depth scale/tint/parallax, a world light context every module shades
against (sun/moon + local sources), layered atmosphere between the depth bands,
and one cheap full-screen post grade. Seven new files deliver it:

| File (scripts/proc/) | Role |
| --- | --- |
| `ProcDepth.gd` | pure-math depth model: projection, rows, fog, LOD, DepthCtx |
| `ProcLighting.gd` | the world light context (LightCtx), shading + shadow helpers |
| `ProcAtmosphere.gd` | fog bands, god rays, haze, heat shimmer, horizon glow |
| `ProcPost.gd` | the single full-screen grade/vignette/bloom-overlay/grain layer |
| `ProcFoliage.gd` | shared 3-tone leaf-cluster + canopy mass renderer |
| `ProcWeatherFX.gd` | depth-aware weather overlays (rain sheets, mist rolls, snow) |
| `ProcSilhouettes.gd` | foreground framing silhouettes + distant islet skyline |

All seven are `class_name <Name> extends RefCounted` modules with static
factories per CONVENTIONS (inner `_X extends ProcNode` classes), except the two
pure-static helpers (`ProcDepth`, part of `ProcLighting`) which also expose
stateless math. Nothing new is an autoload — `project.godot` is untouchable.

---

## 1. THE DEPTH MODEL (`ProcDepth.gd`)

### 1.1 The ground band

The island keeps its authoritative front contour: `surface_y(tx)` is unchanged
and remains the d=0 edge. Behind it the ground extends UP-SCREEN toward a
horizon line. Constants (all in `ProcDepth`):

```gdscript
const BAND_H := 340.0          # full front→back rise in px at the front row's scale
const SCALE_BACK := 0.55       # entity scale at d=1 (front = 1.0)
const ROWS := 5                # planting rows derived from d
const ROW_D := [0.04, 0.26, 0.50, 0.74, 0.96]   # row centre depths
const PARALLAX_BACK := 0.25    # camera-x multiplier at d=1 (front = 1.0)
```

### 1.2 Projection — the only three formulas anyone may use

Every module converts depth to screen the same way. These are pure statics:

```gdscript
# Vertical lift of the ground under a thing at depth d (NEGATIVE = up-screen).
static func depth_y(d: float) -> float:
    var e := clampf(d, 0.0, 1.0)
    return -BAND_H * (1.0 - pow(1.0 - e, 1.45))   # perspective: rows compress toward back

# Uniform scale applied to a thing's root node at depth d.
static func depth_scale(d: float) -> float:
    return lerpf(1.0, SCALE_BACK, clampf(d, 0.0, 1.0))

# Horizontal camera parallax multiplier for a thing (or band container) at depth d.
static func parallax(d: float) -> float:
    return lerpf(1.0, PARALLAX_BACK, clampf(d, 0.0, 1.0))
```

`depth_y` uses an ease-out so the back rows crowd together near the horizon (real
perspective foreshortening). A thing placed at depth `d`, terrain-x `tx` sits at
cam-local `Vector2(tx, surface_y(tx) * (1.0 - d * 0.65) + depth_y(d))` — the
contour itself flattens toward the back (the `* (1.0 - d * 0.65)` term) so the
horizon reads straight. `WorldSpace` wraps this in one new method (see §1.6).

### 1.3 Y-sort and z-index

Within the entity layer, draw order is purely front-over-back:

```gdscript
static func z_for(d: float) -> int:
    return 1000 - int(round(clampf(d, 0.0, 1.0) * 1000.0))   # 0..1000
```

Entities keep living under `WorldSpace._ent_layer` (z_index 1); each placed node
gets `node.z_index = ProcDepth.z_for(d)` with `z_as_relative = true` (default).
Two things at the same row tie-break by `tx` hash — add `-int(Proc.hashf(seed,
"ztb:"+place_id) * 3.0)`. No per-frame y-sorting: depth is fixed at placement,
so z is computed once. (Creatures that wander in depth — future — re-set z only
when their row changes.)

### 1.4 Atmospheric depth tint

Backness desaturates and cools toward the sky horizon color. One helper every
module calls on its PALETTE ONCE at build/adapt time (never per frame):

```gdscript
# Fade a color into the distance. horizon = LightCtx.horizon (see §2).
static func fog_mix(d: float) -> float:
    var e := clampf(d, 0.0, 1.0)
    return 0.42 * pow(e, 1.5)                     # 0 at front, 0.42 at the back edge

static func tint(c: Color, d: float, horizon: Color) -> Color:
    var m := fog_mix(d)
    var g := c.v                                  # cheap desat: pull toward own value
    var desat := Color.from_hsv(c.h, c.s * (1.0 - m * 0.6), c.v, c.a)
    return desat.lerp(Color(horizon.r, horizon.g, horizon.b, c.a), m * (0.8 + 0.2 * g))
```

Rule: modules apply `tint` to their derived palette inside `_on_built`/`adapt`
when the DepthCtx arrives, caching the result. The per-frame cost of depth is
ZERO color math.

### 1.5 Rows and the DepthCtx dictionary

```gdscript
static func row_of(d: float) -> int        # nearest ROW_D index, 0..4
static func row_d(row: int) -> float       # ROW_D[clampi(row,0,4)]
static func jitter_d(seed: int, key: String, row: int) -> float
    # row_d(row) + Proc.rangef(seed, "dj:"+key, -0.06, 0.06), clamped to [0,1]
```

The shared typed dictionary handed to every placed/decor module (merged INTO the
existing `build_context()` dictionary — existing keys unchanged):

```gdscript
# DepthCtx — merged into context under key "depth". ALL fields always present.
{
  "d": float,            # depth in [0,1]
  "row": int,            # 0..4
  "scale": float,        # ProcDepth.depth_scale(d) — applied by WorldSpace to the root
  "y_off": float,        # ProcDepth.depth_y(d) — informational; WorldSpace positions
  "fog": float,          # ProcDepth.fog_mix(d)
  "horizon": Color,      # current horizon tint to fog toward (from LightCtx)
  "parallax": float,     # ProcDepth.parallax(d)
  "lod": int,            # 0/1/2 per §6
}
```

Modules read `context.get("depth", {})` and fall back to front-row defaults
(`d=0, lod=0, fog=0`) when absent — this keeps every existing call site valid.

### 1.6 WorldSpace integration (additive)

`WorldSpace` keeps its whole public API. It ADDS:

```gdscript
func snap_ground_band(world_pos: Vector2) -> Dictionary
    # {pos: Vector2 (cam-local, contour+depth applied), tx: float, d: float}
    # d is derived from the tap's y relative to the band: a tap ABOVE the front
    # contour by k px maps to d = clampf(inverse of depth_y, 0, 1); taps below → d=0.
func depth_of(place_id: String) -> float          # 0.0 if unknown
```

`place()` (signature unchanged) internally calls `snap_ground_band`, stores `d`
in the record (`record["d"]`) and in the save (`"d"` key; restore defaults to
`ProcDepth.jitter_d(world_seed, pid, ProcDepth.row_of(Proc.hashf(world_seed,
"dlegacy:"+pid)*0.99))` for old saves — deterministic, so a legacy island
re-lands on believable rows forever). `place()` applies to the node:
`scale = Vector2.ONE * depth_scale(d)`, `z_index = z_for(d)`, position via the
§1.2 projection, and merges the DepthCtx into the context before
`ItemCatalog.make_node` / `adapt` (both already pass `context` through —
untouched signatures). `can_place` overlap tests gain a depth gate: two records
only collide when `absf(d1 - d2) < 0.18` AND the existing x-distance test fails,
so rows can overlap on screen while nestling believably.

### 1.7 Parallax planes (back to front)

`WorldSpace.setup()` restructures ONLY its internal scene graph (no public
change). Containers, all children of `_cam` except the sky:

| Plane | Node | z_index | parallax (cam-x mult) | Content |
| --- | --- | --- | --- | --- |
| P0 far sky | `_sky` (screen-space, existing) | -10 | 0.06 (existing `set_parallax`) | ProcSky |
| P1 distant islets | `_far_layer` | -8 | 0.18 | `ProcSilhouettes.make_islets` + existing `ProcTerrain.make_backdrop` |
| P2 BACK band | `_band_back` | -4 | 0.55 | rows 3–4 entities, back ground skin |
| P3 haze | `_atmo_mid` | -2 | 0.65 | `ProcAtmosphere.make_haze_band` |
| P4 MID band | `_band_mid` | 0 | 0.80 | row 2 entities, Heart Tree |
| P5 FRONT band | `_band_front` (== `_ent_layer`) | 1 | 1.00 | rows 0–1 entities, front contour |
| P6 fx | `_fx_layer` (existing) | 30 | 1.00 | motes, puffs |
| P7 foreground framing | `_fg_layer` | 40 | 1.25 | `ProcSilhouettes.make_framing` — slides FASTER than the camera |
| P8 weather | `_wx_layer` | 45 | 1.0 (screen-ish) | `ProcWeatherFX` |
| P9 post | `ProcPost` CanvasLayer | layer 50 | none | grade/vignette/bloom/grain |

Parallax implementation: `pan_by()` already moves `_cam`; after moving it, set
`container.position.x = _cam.position.x * (mult - 1.0) * -1.0` for each plane
whose mult ≠ 1.0 (so a 0.55 plane visually moves at 55% of camera speed and the
1.25 foreground overshoots). One line per plane per pan event, zero per-frame
cost when the camera is still. Entities parent into `_band_back/_band_mid/
_band_front` by row (rows 3–4 / 2 / 0–1); their stored `tx` stays authoritative
and pan-independent, so persistence is untouched.

The terrain itself: `_terrain` (front contour, unchanged) lives in P5. P2 gets a
second, cheaper skin — `ProcTerrain.make(world_seed, "home-back", half*1.08,
realm, 1)` (existing lod-1 factory), tinted with `ProcDepth.tint(c, 0.85, …)`,
drawn behind everything in the band, its `surface_y` flattened by scaling its
node `scale.y *= 0.4`. This sells a receding meadow without new terrain code.

---

## 2. THE LIGHTING MODEL (`ProcLighting.gd`)

### 2.1 Ownership and access — no autoload

`ProcLighting` is `class_name ProcLighting extends RefCounted` holding Godot-4
STATIC state (static vars are legal in 4.7.2 and project-wide without autoload):

```gdscript
static var _ctx: Dictionary = {}          # the LightCtx below
static var _version: int = 0              # bumped every meaningful change
static var _sources: Dictionary = {}      # id -> local-source dict

static func ctx() -> Dictionary           # ALWAYS returns a complete LightCtx
static func version() -> int              # cheap change detector for consumers

# The per-world driver node. WorldSpace.setup() creates exactly one:
static func install(world: Node2D, sky: ProcNode) -> Node
    # returns a _Driver (Node) added as a child of `world`; it polls
    # sky.get_time_of_day() + weather each 0.25 s, rebuilds _ctx, bumps _version.
```

If `ctx()` is called before `install` (headless tests, previews), it returns a
deterministic noon default — modules never branch on "is lighting ready".

### 2.2 LightCtx — the shared typed dictionary

```gdscript
# LightCtx — ALL fields always present, all typed as shown.
{
  "tod": float,              # time-of-day [0,1): 0 midnight, .25 dawn, .5 noon, .75 dusk
  "sun_dir": Vector2,        # normalized, points FROM the sun (shade direction);
                             # noon ≈ (0.12, 0.99), morning (−0.78, 0.63), evening (0.78, 0.63)
  "sun_color": Color,        # warm white at noon → amber at dusk → cool slate moon at night
  "sun_energy": float,       # 0 (deep night) .. 1 (noon); moon contributes ≤ 0.25
  "ambient": Color,          # sky-fill tint for shade sides
  "horizon": Color,          # the fog-toward color (feeds ProcDepth.tint + atmosphere)
  "is_night": bool,          # sun_energy < 0.18
  "weather": String,         # "clear"/"overcast"/"mist"/"storm" (mirrors ProcSky)
  "version": int,            # equals ProcLighting.version() at build time
}
```

Derivation (inside `_Driver._rebuild()`, pure math from `tod` + weather +
`Proc.palette(world_seed, "world")`): sun elevation `el = sin(tod * TAU - PI/2)
* 0.5 + 0.5`; azimuth sweeps east→west `ax = -cos(tod * TAU - PI/2)`;
`sun_dir = Vector2(ax * 0.78, maxf(0.25, el)).normalized()`;
`sun_energy = smoothstep(0.08, 0.35, el)` damped ×0.55 by overcast, ×0.35 storm.
Colors lerp through anchored stops (night slate `#2d3350`, dawn rose `#ffb48c`,
noon `#fff6e0`, dusk amber `#ff9a5c`) tinted 12% toward the world palette's
accent so every seed keeps its mood.

### 2.3 Local light sources

Lanterns, crystals, lit windows, the Heart Tree register themselves:

```gdscript
static func register_source(id: String, pos: Vector2, color: Color,
        radius: float, strength: float) -> void   # pos is CAM-LOCAL (band container space)
static func move_source(id: String, pos: Vector2) -> void
static func set_source_strength(id: String, strength: float) -> void
static func unregister_source(id: String) -> void
static func sources() -> Array                    # [{id,pos,color,radius,strength}]

# The one query entities use (cheap: iterates sources, max 24, O(n) adds+lerps):
static func sample(pos: Vector2) -> Dictionary
    # {dir: Vector2 (dominant light dir at pos), color: Color, energy: float}
    # = sun contribution + the single strongest in-radius local source.
```

Cap: 24 registered sources; `register_source` beyond the cap evicts the weakest.
The Heart Tree registers itself in its `_on_built` (`id="heart"`, radius grows
with `g()`). `ProcDecor` lantern/torch species and `ProcFungiCrystals` glow
species register in `_on_built`, unregister in `_exit_tree` (add
`func _exit_tree()` in those inner classes — additive). `ProcBuildings` windows
register one combined source per building when `is_night` (driven by §2.6
consumption, not per-frame).

### 2.4 How entities consume light — the two-tone recipe

Per-frame shading is forbidden; shading is cache-on-change. Pattern every module
follows (document verbatim in each PR):

```gdscript
var _lit_version := -1
func _animate(delta: float) -> void:
    # ... existing cheap transforms ...
    if ProcLighting.version() != _lit_version:
        _lit_version = ProcLighting.version()
        _reshade()          # recompute cached lit/shade colors, THEN queue_redraw()
```

`_Driver` bumps `_version` at most every 0.25 s and only when `tod` moved ≥0.004
or weather/sources changed — so a full-island reshade happens ~every 7 s of the
28-min day cycle, imperceptible and nearly free.

The two-tone split, provided as statics so every module shades identically:

```gdscript
static func shade_pair(base: Color, lc: Dictionary) -> Dictionary
    # {lit: Color, shade: Color}
    # lit   = base.lerp(lc.sun_color, 0.16 * lc.sun_energy).lightened(0.08 * lc.sun_energy)
    # shade = base.darkened(0.18 + 0.10 * (1.0 - lc.sun_energy)).lerp(lc.ambient, 0.22)
static func lit_side(lc: Dictionary) -> float     # −1.0 (light from left) or +1.0
```

Form shading in `_draw`: split the body with the EXISTING vertical `grad_fill`
PLUS a horizontal bias — draw the body polygon filled with `shade`, then overlay
a clipped lit-lobe: take the cached body outline, keep the vertices whose
`x * lit_side < body_w * 0.12`, close through the centroid with
`Proc.smooth_loop`, fill with `lit` at alpha 0.85. One extra polygon per body
mass. Guard: if the kept run has < 3 distinct vertices, skip the lobe (no
degenerate polygons).

### 2.5 Warm rim light

On LOD0 only: an antialiased polyline along the LIT edge of the silhouette.

```gdscript
static func rim_points(outline: PackedVector2Array, lc: Dictionary,
        frac: float = 0.34) -> PackedVector2Array
    # Returns the contiguous run of `outline` centred on the point most opposed
    # to sun_dir (the lit edge), covering `frac` of the loop. Never closed,
    # ≥ 2 points or empty (caller skips when < 2).
```

Draw: `draw_polyline(rim, Color(lc.sun_color, 0.55 * lc.sun_energy), 2.5, true)`.
Cache the rim run with the outline; recompute only in `_reshade()`.

### 2.6 Soft projected blob shadows

```gdscript
static func make_shadow(radius: float) -> Node2D   # returns _BlobShadow
# _BlobShadow extends Node2D: draws 3 stacked half-ellipses (dark→transparent),
# anchored at (0,0) = the owner's feet; reacts to version() in _process by
# updating ONLY its transform + modulate (never redrawing):
#   scale.x  = 1.0 + 0.9 * absf(lc.sun_dir.x)
#   skew     = clampf(-lc.sun_dir.x * 0.55, -0.6, 0.6)   (applied via Transform2D)
#   modulate.a = lerpf(0.10, 0.34, lc.sun_energy) * (0.4 if lc.is_night else 1.0)
```

Every standing entity gets one shadow node as its FIRST child (drawn under the
body), sized `footprint_radius * 0.9`, scaled by the entity's `g()` in
`_on_growth`. `WorldSpace.place()` adds it generically to any node exposing
`footprint_radius` — modules need no code. At night shadows fade and local
sources take over: `_BlobShadow` additionally offsets AWAY from the dominant
`sample(global feet pos)` dir when a local source is within radius (pool-of-
light look), updating at 4 Hz, not per frame.

### 2.7 Night pools of light

`ProcLighting` provides the halo primitive used by lanterns/windows/crystals:

```gdscript
static func make_light_pool(color: Color, radius: float) -> Node2D
# _LightPool: additive-blended (CanvasItemMaterial BLEND_MODE_ADD) node drawing
# a 24-seg radial-faded disc + a ground-hugging half-ellipse wash; exposes
# set_strength(s), and self-modulates by (1.0 - lc.sun_energy) so pools bloom
# at dusk and vanish by day — transform/modulate only, zero redraws.
```

---

## 3. ATMOSPHERE (`ProcAtmosphere.gd`)

Static factories, all returning ProcNode subclasses sized to a given rect:

```gdscript
static func make_haze_band(world_seed: int, key: String, size: Vector2,
        depth: float, opts: Dictionary = {}) -> ProcNode
static func make_god_rays(world_seed: int, key: String, size: Vector2,
        opts: Dictionary = {}) -> ProcNode
static func make_heat_shimmer(world_seed: int, key: String, size: Vector2,
        opts: Dictionary = {}) -> ProcNode          # OFF unless realm opts ask
static func make_horizon_glow(world_seed: int, key: String, size: Vector2,
        opts: Dictionary = {}) -> ProcNode
```

- **Depth fog curve.** Fog is baked into entity palettes via `ProcDepth.tint`
  (§1.4) — the atmosphere nodes add the VOLUME between bands, not per-entity
  math. `make_haze_band` is one wide, low quad strip (ShaderMaterial: scrolling
  2-octave value noise in the shader, alpha `0.10 + 0.14 * fog_mix(depth)`,
  color = `LightCtx.horizon` via a uniform the node pushes when `version()`
  changes). Placement: one at P3 (`depth 0.6`), one thin one inside P1
  (`depth 0.95`), one near-invisible at P5 front (`depth 0.08`, alpha 0.04) so
  the layering reads continuous.
- **God rays.** A screen-space fan of 5–9 translucent wedges from the sun's
  screen position (computed from `sun_dir`), ShaderMaterial with soft edges +
  slow width breathing (`TIME`-free: uniform `u_t` pushed from `_animate`).
  Alpha gated: `clear` weather, `sun_energy > 0.55`, else fades out over 2 s.
  Lives just above P4 (z between mid and front bands) so rays fall BEHIND front
  trees. Mobile cost: ≤ 9 quads + trivial fragment.
- **Heat shimmer** (option, ember/desert realms): a narrow strip above the back
  band using a `hint_screen_texture` canvas shader displacing UV.y by
  `sin(uv.x * k + u_t) * 1.5px`. Only ever instanced when
  `opts.get("shimmer", false)` — default OFF.
- **Horizon glow.** A tall soft gradient quad behind P1 islets: additive,
  `sun_color → transparent`, strongest at dawn/dusk
  (`alpha = 0.35 * sin(clampf(abs(tod - 0.25) …))` — pushes uniforms on version
  change only). Sells the sun position without drawing a disc (ProcSky already
  owns the disc).
- **Dust/haze motes** stay in `ProcAmbience` (exists) — ProcAtmosphere does NOT
  duplicate particles; WorldSpace instances `ProcAmbience.make_dust` per band at
  the band's parallax so motes drift with their plane.

All atmosphere nodes expose `set_strength(s: float)` for weather blending and
listen to `ProcLighting.version()` to re-push color uniforms (uniform pushes
only — no redraws, no allocation).

---

## 4. POST STACK (`ProcPost.gd`)

```gdscript
static func make(world_seed: int, vp: Vector2, opts: Dictionary = {}) -> CanvasLayer
    # returns _Post (CanvasLayer, layer = 50); WorldSpace.setup() adds it last.
# _Post API:
func set_grain(on: bool) -> void          # default OFF
func set_strengths(grade: float, vignette: float, bloom: float) -> void
func flash(color: Color, dur: float) -> void   # reusable screen-kiss for rewards
```

One full-screen `ColorRect` with ONE canvas shader (the only screen-texture read
in the game):

```glsl
shader_type canvas_item;
uniform sampler2D screen_tex : hint_screen_texture, filter_linear;
uniform vec3 u_lift;      // shadow tint   (time-of-day graded)
uniform vec3 u_gain;      // highlight tint
uniform float u_warmth;   // −0.2..0.2 channel push
uniform float u_vig;      // 0..0.35 vignette strength
uniform float u_grain;    // 0 default
uniform float u_t;
void fragment() {
    vec3 c = texture(screen_tex, SCREEN_UV).rgb;
    c = c * u_gain + u_lift * (1.0 - c);                    // cheap lift/gain grade
    c.r += u_warmth * 0.06; c.b -= u_warmth * 0.05;
    float d = distance(SCREEN_UV, vec2(0.5, 0.46));
    c *= 1.0 - u_vig * smoothstep(0.42, 0.85, d);           // gentle vignette
    if (u_grain > 0.001) {
        float n = fract(sin(dot(SCREEN_UV * 1021.0, vec2(12.9898, 78.233)) + u_t) * 43758.5);
        c += (n - 0.5) * u_grain * 0.035;
    }
    COLOR = vec4(c, 1.0);
}
```

Grade presets by `tod` (pushed on `ProcLighting.version()` change): dawn lifts
rose, noon neutral, dusk warm gain, night cool lift + slightly stronger
vignette; storm desaturates via `u_gain` 0.92. **Bloom approximation:** NOT in
the shader — `_Post` keeps a child `Node2D` (additive blend) that draws one soft
radial quad per bright source from `ProcLighting.sources()` (≤ 24), at the
source's screen position, `radius * 1.6`, alpha `0.10 * strength *
(1.0 − sun_energy × 0.6)`. Updated at 4 Hz via cached quads + transform moves.
Total post cost: one full-screen fragment pass + ≤ 24 small additive quads.
`u_t` is pushed from `_process` accumulation (gameplay clock, not generation —
allowed), grain remains default OFF so the branch is skipped.

---

## 5. MATERIAL VOCABULARY

Shared recipes so every module renders the same material the same way. All are
draw-primitive sequences over cached point arrays; colors come from
`ProcLighting.shade_pair` (lc = `ProcLighting.ctx()`), fogged once via
`ProcDepth.tint`. LOD column per §6.

**Bark ridges** (trees, wood decor): over the trunk polygon (filled `shade`→
`lit` grad_fill), draw 3–6 near-vertical antialiased polylines sampled from the
trunk's own edge flow (`lerp(left_edge[i], right_edge[i], k)` for seeded k),
color `shade.darkened(0.18)` width 2.0, plus ONE highlight polyline on the lit
edge inset 15%, color `lit.lightened(0.12)` width 1.6. LOD1: 2 ridges, no
highlight. LOD2: none.

**Leaf cluster, 3-tone depth** (the `ProcFoliage` core, §7): a canopy mass is
3 stacked blob layers from the SAME seeded controls at 3 scales:
back = `shade.darkened(0.10)` (scale 1.0), mid = base (0.86, offset 6px toward
the sun), front = `lit` (0.68, offset 10px toward the sun). Then 5–9 seeded
leaf-tip scallop arcs (`draw_arc`, 10 seg) in `lit.lightened(0.1)` along the lit
rim. LOD1: 2 layers, no scallops. LOD2: 1 silhouette fill.

**Stone facets + AO creases** (rocks, buildings): body blob filled grad
(`lit` top → `shade` bot); 2–4 interior facet polygons — each a chord-split of
the body (two seeded rim points + centroid, `smooth_loop`ed) alternately filled
`lit`/`shade` at alpha 0.5; AO creases: short polylines in the valleys between
facets, `shade.darkened(0.25)` alpha 0.6 width 2.5, plus a 1-px
`lit.lightened(0.15)` top-edge line. Contact AO: the §2.6 shadow node darkened
×1.3 for stone. LOD1: 2 facets, no creases. LOD2: fill only.

**Water specular glints**: on any `ProcWater` surface at LOD0–1, a child node
draws 4–8 short horizontal dashes (`draw_line`, width 2) at seeded surface
points, color `sun_color` alpha `0.5 * sun_energy`, positions nudged by phase in
`_animate` via the child's transform (ProcWater's existing `_Glints` pattern in
ProcTerrain is the reference). At night: swap to moon slate + halo from any
in-radius source.

**Crystal refraction bands**: crystal prism polygon filled grad; 2–3 interior
bands = thin parallelogram polys tilted 20–30° off the prism axis, additive
blend, colors `accent.lightened(0.3)` / `sun_color` alpha 0.25; one bright facet
edge polyline on the lit side; `make_light_pool` child registered as a source
(§2.3). Bands shift by moving the child's `position.x` ±2 px slowly in
`_animate`. LOD1: 1 band. LOD2: fill + pool only.

**Cloth sheen** (flags, awnings, banners): the cloth polygon (existing `_Banner`/
`_FlagBody` wave logic untouched) gains a sheen stripe: a 4-point quad across
the cloth at the wave's current crest, filled `lit.lightened(0.2)` alpha 0.3 —
crest index is already computed by the wave; reuse it, redraw only when the wave
redraws (these are the few legitimately `animate_draw` nodes). LOD1+: skip.

---

## 6. LOD RULES (`ProcDepth.lod_for`)

```gdscript
static func lod_for(d: float, px_h: float) -> int
    # px_h = the thing's on-screen body height AFTER depth_scale.
    # LOD0: d < 0.35 and px_h >= 110
    # LOD2: d > 0.70 or px_h < 44
    # LOD1: everything else
```

| Drops | LOD0 (front/hero) | LOD1 (mid) | LOD2 (back/small) |
| --- | --- | --- | --- |
| Outline samples (`smooth_loop`) | ×1.0 | ×0.6 (min 6/seg→4) | ×0.4 (min 3) |
| Rim light (§2.5) | yes | no | no |
| Material detail (§5) | full | reduced per recipe | silhouette+grad only |
| Blob shadow | 3-layer | 1 ellipse | none (fog eats it) |
| Local-light `sample()` response | yes | yes (4 Hz) | no — sun only |
| `_animate` transforms | full | half rate (skip odd frames via `phase`) | breathing only |
| Child FX (sparks, flames, pools) | all | pools only | none |

LOD is FIXED at placement (depth never changes), so it is decided once in the
DepthCtx — no per-frame LOD switching, no hysteresis needed. Modules branch on
`ctx.depth.lod` inside `_on_built`/`_draw` only.

---

## 7. FILE / API PLAN — exact deliverables

Every file: `class_name <Name> extends RefCounted`, inner `_X extends ProcNode`
classes, seeded via `Proc.*` only, typed per warnings-as-errors (explicitly type
all `abs()/min()/lerp()` results; `absf/minf/maxf/clampf` preferred).

### 7.1 `scripts/proc/ProcDepth.gd` — pure statics, no nodes
```gdscript
const BAND_H := 340.0; const SCALE_BACK := 0.55; const ROWS := 5
const ROW_D: Array[float] = [0.04, 0.26, 0.50, 0.74, 0.96]
const PARALLAX_BACK := 0.25
static func depth_y(d: float) -> float
static func depth_scale(d: float) -> float
static func parallax(d: float) -> float
static func z_for(d: float) -> int
static func fog_mix(d: float) -> float
static func tint(c: Color, d: float, horizon: Color) -> Color
static func row_of(d: float) -> int
static func row_d(row: int) -> float
static func jitter_d(seed: int, key: String, row: int) -> float
static func lod_for(d: float, px_h: float) -> int
static func make_ctx(d: float, px_h: float, horizon: Color) -> Dictionary  # builds §1.5 DepthCtx
```

### 7.2 `scripts/proc/ProcLighting.gd`
```gdscript
static func install(world: Node2D, sky: ProcNode) -> Node     # the _Driver
static func ctx() -> Dictionary                                # LightCtx §2.2
static func version() -> int
static func register_source(id: String, pos: Vector2, color: Color, radius: float, strength: float) -> void
static func move_source(id: String, pos: Vector2) -> void
static func set_source_strength(id: String, strength: float) -> void
static func unregister_source(id: String) -> void
static func sources() -> Array
static func sample(pos: Vector2) -> Dictionary                 # {dir,color,energy}
static func shade_pair(base: Color, lc: Dictionary) -> Dictionary  # {lit,shade}
static func lit_side(lc: Dictionary) -> float
static func rim_points(outline: PackedVector2Array, lc: Dictionary, frac: float = 0.34) -> PackedVector2Array
static func make_shadow(radius: float) -> Node2D               # _BlobShadow
static func make_light_pool(color: Color, radius: float) -> Node2D  # _LightPool
# inner: _Driver extends Node, _BlobShadow extends Node2D, _LightPool extends Node2D
```

### 7.3 `scripts/proc/ProcAtmosphere.gd`
Factories per §3 (`make_haze_band`, `make_god_rays`, `make_heat_shimmer`,
`make_horizon_glow`), each returning a ProcNode with `set_strength(s: float)`.

### 7.4 `scripts/proc/ProcPost.gd`
`static func make(world_seed: int, vp: Vector2, opts: Dictionary = {}) -> CanvasLayer`
plus `_Post` methods per §4 (`set_grain`, `set_strengths`, `flash`).

### 7.5 `scripts/proc/ProcFoliage.gd`
```gdscript
static func make_cluster(world_seed: int, key: String, radius: float,
        base: Color, opts: Dictionary = {}) -> Node2D
    # the §5 3-tone leaf mass as a reusable child node (sway via its transform);
    # opts: {lod:int, droop:float, scallops:bool, season:String}
static func canopy_colors(base: Color, lc: Dictionary, d: float, horizon: Color) -> Dictionary
    # {back,mid,front,rim} — the agreed 3-tone + rim set, fog applied
static func draw_cluster_into(ci: CanvasItem, pts_cache: Dictionary) -> void
    # immediate-mode variant for modules that must stay single-_draw
static func build_cluster_cache(world_seed: int, key: String, radius: float,
        cols: Dictionary, lod: int) -> Dictionary   # the pts_cache for the above
```
`ProcTrees`/`ProcHeartTree`/`ProcPlants` migrate their canopies to this renderer
(internal change; factory signatures untouched).

### 7.6 `scripts/proc/ProcWeatherFX.gd`
```gdscript
static func make(world_seed: int, key: String, kind: String, size: Vector2,
        opts: Dictionary = {}) -> ProcNode   # kind: "rain_sheet"/"mist_roll"/"snow_drift"/"storm_dim"
static func make_for_weather(world_seed: int, weather: String, size: Vector2,
        opts: Dictionary = {}) -> ProcNode   # composite matching a ProcSky weather id
```
Depth-aware: each effect spawns 2 internal layers (back at 0.5× speed/alpha,
front at 1×) so weather, too, has parallax. Rain uses `ProcAmbience.make_rain`
internally for drops and adds the sheet-gust shader strip; mist is 2 scrolling
noise-shader quads hugging `depth_y` rows. WorldSpace drives it from its
existing `set_weather` roll (additive: alongside `_sky.set_weather`).

### 7.7 `scripts/proc/ProcSilhouettes.gd`
```gdscript
static func make_islets(world_seed: int, key: String, size: Vector2,
        count: int = 3, opts: Dictionary = {}) -> ProcNode
    # P1 skyline: 2–4 distant floating islets (reuses ProcTerrain.make_islet at
    # lod 2 + ProcDepth.tint at d≈0.92), slow 12 s bob via child transforms.
static func make_framing(world_seed: int, key: String, size: Vector2,
        side: String = "both", opts: Dictionary = {}) -> ProcNode
    # P7 foreground: near-black (ink-tinted toward horizon complement) grass
    # blades / branch arcs / rock shoulders hugging screen edges, drawn at 1.15–
    # 1.35× scale, alpha 0.85; sway in _animate via rotation of 3 child clumps.
    # Must never cover > 14% of screen area; bottom corners + one top branch max.
```

### 7.8 Touched existing files (additive edits only)
- `WorldSpace.gd`: band containers + parallax (§1.7), `snap_ground_band`,
  `depth_of`, record/persist `d`, DepthCtx merge into `build_context()` result,
  `ProcLighting.install`, atmosphere/post/weather/silhouette instancing,
  generic shadow attachment in `place()`. No public signature changes.
- `ItemCatalog.gd`: pass-through only — it already forwards `context`; add
  `ProcDepth`/lod defaults in `_apply_ctx` for nodes exposing `lod`/`depth_d`.
- `ProcSky.gd`: no API change; `_Driver` consumes `get_time_of_day()`.
- Entity modules (`ProcTrees`, `ProcBuildings`, `ProcCreatures`, `ProcPlants`,
  `ProcDecor`, `ProcFungiCrystals`, `ProcHeartTree`, `ProcWater`, `ProcTerrain`):
  adopt §2.4 `_reshade` pattern, §5 recipes, §6 LOD branches, read
  `context.depth` — all behind defaults so they still render identically when
  instanced standalone with no context.

### 7.9 Build order for the 20 agents
1. `ProcDepth` + `ProcLighting` (everything depends on them; pure, testable).
2. `WorldSpace` band/parallax/DepthCtx integration + generic shadows.
3. `ProcFoliage`, then tree/plant/heart migrations.
4. `ProcAtmosphere` + `ProcSilhouettes` (slot into the P-planes).
5. Entity reshade/LOD passes (parallel per module).
6. `ProcWeatherFX`, then `ProcPost` last (it grades everything beneath it).

### 7.10 Hard checks before any PR lands
- Parses under 4.7.2 warnings-as-errors; every inferred-Variant var typed.
- No `Time.*`/`randf` in generation paths (`Proc.hashf/rng` only; `u_t`/gameplay
  clocks exempt per existing precedent).
- No allocation in `_animate`/`_process` (caches built in `_on_built`/`_reshade`).
- Every polygon ≥ 3 distinct points, no self-retracing loops (the `_RootPool`
  half-ellipse comment in WorldSpace is the cautionary tale), zero-area guarded.
- Any growth in [0,1] renders a believable stage; `pop_in`/`grow_to` untouched.
- Standalone instancing of every factory (no context, no lighting installed)
  still renders — defaults everywhere.
