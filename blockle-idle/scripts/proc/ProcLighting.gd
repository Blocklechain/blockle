class_name ProcLighting
extends RefCounted
# ProcLighting — the world LIGHT CONTEXT every module shades against (GFX-2.5D §2).
#
# One _Driver node (installed by WorldSpace.setup via ProcLighting.install) polls
# the sky's time-of-day + weather every 0.25 s and rebuilds a shared LightCtx —
# sun/moon direction, sun colour, ambient sky-fill, the horizon fog colour —
# bumping a cheap integer `version()` only when something meaningfully changed
# (tod moved >= 0.004 or weather flipped). Modules cache their lit/shade colours
# and recompute ONLY when `version()` moves (§2.4), so a full-island reshade
# costs ~nothing and happens roughly every 7 s of the 28-min day. Per-frame work
# everywhere in this file is transforms + modulate ONLY: zero allocation, zero
# redraws.
#
# Local light sources get their OWN counter, `sources_version()`: a wandering
# lantern or a pulsing crystal must not drag EVERY entity through a colour
# recompute 4x/s, so source edits never bump `version()`.
#
# Public surface (spec §7.2 — exact, plus additive extras marked +):
#   install(world, sky) -> Node                 the per-world _Driver (sky may be null)
#   ctx() -> Dictionary                         ALWAYS-complete LightCtx (§2.2)
#   version() -> int                            tod / weather / palette changes
# + sources_version() -> int                    local-source changes only
#   register_source / move_source / set_source_strength / unregister_source
#   sources() -> Array                          duplicated {id,pos,color,radius,strength}
# + set_source_space(n) / to_source_space(gpos)  the space source positions live in
#   sample(pos) -> {dir, color, energy}         sun + strongest in-radius source
#   shade_pair(base, lc, [surface_dir]) -> {lit, shade}
#   lit_side(lc) -> float                       -1.0 light-from-left, else +1.0
#   rim_points(outline, lc, frac) -> PackedVector2Array   lit-edge run (§2.5)
#   make_shadow(radius, [lod]) -> Node2D        _BlobShadow (§2.6, LOD per §6)
#   make_light_pool(color, radius, [lod]) -> Node2D       _LightPool (§2.7)
#
# Consumption pattern every module follows (verbatim from the spec):
#   var _lit_version := -1
#   func _animate(delta):
#       if ProcLighting.version() != _lit_version:
#           _lit_version = ProcLighting.version()
#           _reshade()        # recompute cached lit/shade colours, queue_redraw()
#
# If ctx() is called before install (headless tests, previews) it returns a
# deterministic noon-clear default — modules never branch on "is lighting ready".

const MAX_SOURCES := 24
const POLL_SECONDS := 0.25
const TOD_EPSILON := 0.004
const NIGHT_ENERGY := 0.18

# Anchored time-of-day colour stops (spec §2.2): index 0..4 at tod 0, .25, .5,
# .75, 1.0 (last == first so the ramp wraps). Night slate -> dawn rose -> noon
# warm white -> dusk amber. Each rebuild tints 12% toward the world palette's
# accent so every seed keeps its own mood.
const SUN_STOPS: Array[Color] = [
	Color("2d3350"), Color("ffb48c"), Color("fff6e0"), Color("ff9a5c"), Color("2d3350"),
]
const AMB_STOPS: Array[Color] = [
	Color("1d2340"), Color("a98ea6"), Color("bdd3e6"), Color("91718a"), Color("1d2340"),
]
const HOR_STOPS: Array[Color] = [
	Color("242b4c"), Color("ffd2b0"), Color("cfe4f2"), Color("ffb27e"), Color("242b4c"),
]

static var _ctx: Dictionary = {}
static var _version: int = 0
static var _sources: Dictionary = {}          # id -> {id,pos,color,radius,strength}
static var _sources_dirty: bool = false
static var _sources_version: int = 0
static var _source_space: Node2D = null
static var _driver: Node = null
static var _add_mat: CanvasItemMaterial = null

# ---- context ----------------------------------------------------------------

# The shared LightCtx. ALL fields always present (§2.2):
#   tod, sun_dir, sun_color, sun_energy, ambient, horizon, is_night, weather, version
static func ctx() -> Dictionary:
	if _ctx.is_empty():
		# Deterministic noon-clear default (no palette tint): headless-safe.
		_ctx = _build_ctx(0.5, "clear", Color.WHITE, 0.0)
	return _ctx

# The island-wide reshade trigger (§2.4): moves on time-of-day / weather /
# palette changes only, at most every POLL_SECONDS. Local-source edits are
# reported separately by sources_version().
static func version() -> int:
	return _version

# Change detector for consumers that care about the registered local sources
# (blob shadows, light pools, ProcPost's bloom overlay) rather than the sun.
# Coalesced to the driver's 0.25 s tick, so a lantern wandering every frame
# produces at most 4 bumps/s and never touches version().
static func sources_version() -> int:
	return _sources_version

# Create the per-world driver. WorldSpace.setup() calls this exactly once with
# the world root and the ProcSky node; the driver polls the sky and rebuilds the
# LightCtx. Installing clears any stale sources from a previous world.
#
# `sky` is OPTIONAL (§2.1 promises headless tests/previews work without one):
# every read of it here and in _Driver is null-guarded, so install(world, null)
# simply yields the noon-clear polling defaults. A null/freed `world` is the one
# real failure, and it returns BEFORE touching source state so a failed install
# cannot destroy an already-registered set of sources.
static func install(world: Node2D, sky: ProcNode) -> Node:
	if world == null or not is_instance_valid(world):
		return null
	if _driver != null and is_instance_valid(_driver):
		_driver.queue_free()
	_sources.clear()
	_source_space = null
	_sources_dirty = false
	_sources_version += 1
	var d := _Driver.new()
	d.name = "ProcLightingDriver"
	d.sky = sky
	var ws := 1
	if sky != null and is_instance_valid(sky):
		ws = sky.seedv
	var wsv: Variant = world.get("world_seed")
	if wsv is int:
		ws = wsv
	d.world_seed = ws
	_driver = d
	world.add_child(d)
	return d

# ---- local light sources (§2.3) ---------------------------------------------
# Positions are CAM-LOCAL (band container space). Capped at MAX_SOURCES; a
# registration beyond the cap evicts the weakest existing source.

static func register_source(id: String, pos: Vector2, color: Color,
		radius: float, strength: float) -> void:
	if not _sources.has(id) and _sources.size() >= MAX_SOURCES:
		var weakest := ""
		var wmin := INF
		for k: String in _sources:
			var st: float = _sources[k]["strength"]
			if st < wmin:
				wmin = st
				weakest = k
		if weakest != "":
			_sources.erase(weakest)
	_sources[id] = {
		"id": id, "pos": pos, "color": color,
		"radius": maxf(1.0, radius), "strength": maxf(0.0, strength),
	}
	_mark_sources_changed()

static func move_source(id: String, pos: Vector2) -> void:
	if _sources.has(id):
		_sources[id]["pos"] = pos
		_mark_sources_changed()

static func set_source_strength(id: String, strength: float) -> void:
	if _sources.has(id):
		_sources[id]["strength"] = maxf(0.0, strength)
		_mark_sources_changed()

static func unregister_source(id: String) -> void:
	if _sources.erase(id):
		_mark_sources_changed()

# Snapshot of every registered source: [{id,pos,color,radius,strength}].
# The dictionaries are DUPLICATES of the internal records — <= 24 small dicts at
# a consumer's 4 Hz cadence is affordable, and it means a consumer cannot corrupt
# `sample()` weighting (or ProcPost's bloom alphas) by writing into what it got
# back. Treat the array itself as a fresh snapshot, not a live view.
static func sources() -> Array:
	var out: Array = []
	out.resize(_sources.size())
	var i := 0
	for k: String in _sources:
		var rec: Dictionary = _sources[k]
		out[i] = rec.duplicate()
		i += 1
	return out

# Declare the node whose LOCAL space `register_source` positions are expressed
# in (WorldSpace wires its cam/band container here once, right after install).
# Nodes that need to compare their own GLOBAL position against source positions
# — _BlobShadow, ProcPost's bloom — go through to_source_space().
static func set_source_space(n: Node2D) -> void:
	_source_space = n

# Convert a global (canvas) position into source space. With no declared space,
# global space is assumed — which is exactly what a standalone preview wants.
static func to_source_space(global_pos: Vector2) -> Vector2:
	if _source_space != null and is_instance_valid(_source_space) \
			and _source_space.is_inside_tree():
		return _source_space.get_global_transform().affine_inverse() * global_pos
	return global_pos

# With a driver the change folds into the next 0.25 s tick; without one
# (standalone / tests) bump immediately so consumers still notice.
static func _mark_sources_changed() -> void:
	_sources_dirty = true
	if _driver == null or not is_instance_valid(_driver):
		_sources_version += 1

# The one query entities use: sun contribution + the single strongest in-radius
# local source, blended. `dir` follows the sun_dir convention (the direction
# light TRAVELS, i.e. the shade direction). Cheap O(n) over <= 24 sources.
#
# RANGES: `dir` is normalized; `energy` is in [0, 1.5] — the sun's 0..1 PLUS the
# local source's contribution, so a lamp can push a surface past daylight. The
# §2.4 shade recipe wants 0..1, and `shade_pair` clamps for exactly that reason;
# callers doing their own maths should clamp too.
static func sample(pos: Vector2) -> Dictionary:
	var lc := ctx()
	var sd: Vector2 = lc.get("sun_dir", Vector2(0.12, 0.99))
	var sc: Color = lc.get("sun_color", Color("fff6e0"))
	var se: float = lc.get("sun_energy", 1.0)
	var best_w := 0.0
	var best_pos := Vector2.ZERO
	var best_col := Color.WHITE
	for k: String in _sources:
		var s: Dictionary = _sources[k]
		var sp: Vector2 = s["pos"]
		var rr: float = s["radius"]
		var dist := pos.distance_to(sp)
		if dist >= rr:
			continue
		var fall := 1.0 - dist / rr
		var w: float = float(s["strength"]) * fall * fall
		if w > best_w:
			best_w = w
			best_pos = sp
			best_col = s["color"]
	if best_w <= 0.001:
		return {"dir": sd, "color": sc, "energy": se}
	var away := pos - best_pos
	# Standing exactly ON a source gives no usable away-vector; fall back to the
	# sun direction (a believable shade dir) rather than hard-coded straight down.
	var ldir := sd
	if away.length_squared() > 0.0001:
		ldir = away.normalized()
	var tw := maxf(0.0001, se + best_w)
	var mix := (sd * (se / tw) + ldir * (best_w / tw))
	var outdir := mix.normalized() if mix.length_squared() > 0.0001 else ldir
	return {
		"dir": outdir,
		"color": sc.lerp(best_col, clampf(best_w / tw, 0.0, 1.0)),
		"energy": clampf(se + best_w, 0.0, 1.5),
	}

# ---- shading helpers (§2.4–2.5) ---------------------------------------------

# The two-tone split every module uses so the whole island shades identically.
# Optional `surface_dir`: the outward normal of the surface being shaded (e.g. a
# roof plane). Faces toward the light get a touch more lift, faces away sink.
#
# `sun_energy` is CLAMPED to 0..1 here: `sample()` legitimately reports up to 1.5
# near a lamp, and feeding that in raw inverted the recipe (lightened(0.12) with
# darkened(0.13)) and diverged from ProcFoliage's mirrored copy, which clamps.
static func shade_pair(base: Color, lc: Dictionary,
		surface_dir: Vector2 = Vector2.ZERO) -> Dictionary:
	var sc: Color = lc.get("sun_color", Color("fff6e0"))
	var amb: Color = lc.get("ambient", Color("bdd3e6"))
	var en: float = clampf(float(lc.get("sun_energy", 1.0)), 0.0, 1.0)
	var lit := base.lerp(sc, 0.16 * en).lightened(0.08 * en)
	var shade := base.darkened(0.18 + 0.10 * (1.0 - en)).lerp(amb, 0.22)
	if surface_dir != Vector2.ZERO:
		var sd: Vector2 = lc.get("sun_dir", Vector2(0.12, 0.99))
		var facing := clampf(surface_dir.normalized().dot(-sd), -1.0, 1.0)
		if facing > 0.0:
			lit = lit.lightened(0.06 * facing * en)
		else:
			shade = shade.darkened(0.08 * -facing)
	return {"lit": lit, "shade": shade}

# Which side of a body the light falls on: -1.0 when the lit side is screen-left
# (light arriving from the left), +1.0 otherwise. sun_dir is the shade direction,
# so a positive sun_dir.x means light travels rightward = lit side is the left.
static func lit_side(lc: Dictionary) -> float:
	var sd: Vector2 = lc.get("sun_dir", Vector2(0.12, 0.99))
	return -1.0 if sd.x > 0.0 else 1.0

# Warm rim light (LOD0 only): the contiguous run of `outline` centred on the
# point most opposed to sun_dir (the lit edge), covering `frac` of the loop.
# Never closed; returns >= 2 points or empty (callers skip when < 2).
static func rim_points(outline: PackedVector2Array, lc: Dictionary,
		frac: float = 0.34) -> PackedVector2Array:
	var out := PackedVector2Array()
	var n := outline.size()
	if n < 3 or frac <= 0.0:
		return out
	var c := Vector2.ZERO
	for p in outline:
		c += p
	c /= float(n)
	var sd: Vector2 = lc.get("sun_dir", Vector2(0.12, 0.99))
	var lit_dir := -sd
	var best := 0
	var best_d := -INF
	for i in range(n):
		var dd := (outline[i] - c).normalized().dot(lit_dir)
		if dd > best_d:
			best_d = dd
			best = i
	var count := clampi(int(round(float(n) * clampf(frac, 0.0, 0.9))), 2, n - 1)
	var half := int(float(count) * 0.5)
	out.resize(count)
	for i in range(count):
		out[i] = outline[posmod(best - half + i, n)]
	return out

# ---- node factories (§2.6–2.7) ----------------------------------------------

# Soft projected blob shadow (§2.6): a smooth RADIAL-FADE ellipse (vertex-alpha
# fan — CONVENTIONS rule 2, never a stack of hard-edged discs) plus a tighter
# contact umbra, anchored at (0,0) = the owner's feet. Add as a child of the
# entity; it z-sorts itself under the parent's own _draw. Stretches/leans with
# the sun, fades at night, and under a nearby local source at night it slides
# AWAY from the light (pool-of-light look) — all via transform + modulate at
# <= 4 Hz, never redrawn.
#
# `lod` follows the §6 table:
#   0  full: radial penumbra + contact umbra, local-source response at 4 Hz
#   1  ONE radial ellipse, no local-source scan (the entity itself still
#      samples local light at 4 Hz; the shadow is the cheap secondary cue)
#   2  nothing: invisible and _process disabled (fog eats it)
#
# The owner OWNS none of the node's transform: compose through the setters
# instead of writing `scale` / `modulate.a` / `position` directly, because
# _apply_light re-derives all three whenever version() moves (~every 7 s):
#   set_growth_scale(g())   growth staging (§2.6) — transform only, no rebuild
#   set_ao_mul(1.3)         stone contact AO (§5) — darkens the shadow
#   set_base_offset(off)    a fixed local offset for off-centre footprints
#   set_radius(r)           the only call that rebuilds geometry (guarded no-op
#                           when the radius has not actually changed)
static func make_shadow(radius: float, lod: int = 0) -> Node2D:
	var s := _BlobShadow.new()
	s.radius = maxf(3.0, radius)
	s.lod = clampi(lod, 0, 2)
	return s

# Night pool of light for lanterns / lit windows / crystals (§2.7): an additive
# radial-faded disc (one vertex-alpha fan, smooth — no concentric rings) plus a
# ground-hugging ellipse wash. Exposes set_strength(); self-modulates by
# (1 - sun_energy) so pools bloom at dusk and vanish by day, hiding themselves
# entirely once fully transparent so they leave the blend pipeline. All pools
# share ONE additive CanvasItemMaterial (no per-instance material switch).
# `lod`: 0 full, 1 disc only (fewer segments, no wash), 2 off (§6).
static func make_light_pool(color: Color, radius: float, lod: int = 0) -> Node2D:
	var p := _LightPool.new()
	p.color = color
	p.radius = maxf(8.0, radius)
	p.lod = clampi(lod, 0, 2)
	return p

# The single additive material shared by every _LightPool (cf. ProcWater._shader).
static func _additive_material() -> CanvasItemMaterial:
	if _add_mat == null:
		_add_mat = CanvasItemMaterial.new()
		_add_mat.blend_mode = CanvasItemMaterial.BLEND_MODE_ADD
	return _add_mat

# ---- radial-fade fan geometry (shared by both halo primitives) --------------

# A true radial gradient with ONE draw call: vertex 0 is the centre, then
# `rings.size()` concentric ellipse rings of `segs` vertices at radius fractions
# `rings[i]` of (rx, ry). Submitted via RenderingServer.canvas_item_add_triangle_array
# so the alpha interpolates ACROSS the triangles — the smooth "radial-faded disc"
# §2.7 asks for, instead of the visible concentric banding a stack of
# fixed-alpha draw_polygon circles produces at 60+ px on a 1080-wide portrait.
# Cost is one canvas item command either way.
#
# Never degenerate: segs is floored at 8 distinct rim points per ring, the radii
# are floored by the callers (maxf(3.0, r) / maxf(8.0, r)) and `rings` is
# strictly increasing, so every emitted triangle has area.
static func _fan_mesh(rx: float, ry: float, segs: int,
		rings: PackedFloat32Array) -> Dictionary:
	var sg := maxi(8, segs)
	# A caller that passes no rings would index past the end; one solid rim ring
	# is the only sane reading of "a disc with no stops".
	var rg := rings
	if rg.is_empty():
		rg = PackedFloat32Array([1.0])
	var nr := rg.size()
	var vcount := 1 + sg * nr
	var pts := PackedVector2Array()
	var ring_of := PackedInt32Array()
	pts.resize(vcount)
	ring_of.resize(vcount)
	pts[0] = Vector2.ZERO
	ring_of[0] = 0
	for ri in range(nr):
		var fr: float = maxf(0.004, rg[ri])
		for i in range(sg):
			var a := TAU * float(i) / float(sg)
			var vi := 1 + ri * sg + i
			pts[vi] = Vector2(cos(a) * rx * fr, sin(a) * ry * fr)
			ring_of[vi] = ri + 1
	var idx := PackedInt32Array()
	idx.resize(sg * 3 + (nr - 1) * sg * 6)
	var k := 0
	# Inner cap: centre -> first ring.
	for i in range(sg):
		idx[k] = 0
		idx[k + 1] = 1 + i
		idx[k + 2] = 1 + (i + 1) % sg
		k += 3
	# Annular strips between successive rings.
	for ri in range(nr - 1):
		var b0 := 1 + ri * sg
		var b1 := 1 + (ri + 1) * sg
		for i in range(sg):
			var i0 := b0 + i
			var i1 := b0 + (i + 1) % sg
			var o0 := b1 + i
			var o1 := b1 + (i + 1) % sg
			idx[k] = i0
			idx[k + 1] = o0
			idx[k + 2] = o1
			idx[k + 3] = i0
			idx[k + 4] = o1
			idx[k + 5] = i1
			k += 6
	return {"pts": pts, "idx": idx, "ring": ring_of}

# Per-vertex colours for a _fan_mesh: `alphas[0]` is the centre, `alphas[i+1]`
# ring i. End on 0.0 for a fade that reaches nothing at the rim.
static func _fan_cols(ring_of: PackedInt32Array, col: Color,
		alphas: PackedFloat32Array) -> PackedColorArray:
	var cols := PackedColorArray()
	var n := ring_of.size()
	cols.resize(n)
	var top := maxi(0, alphas.size() - 1)
	for i in range(n):
		var ri: int = clampi(ring_of[i], 0, top)
		cols[i] = Color(col.r, col.g, col.b, clampf(alphas[ri], 0.0, 1.0))
	return cols

# ---- LightCtx derivation (pure math, §2.2) ----------------------------------

static func _build_ctx(tod: float, weather: String, accent: Color,
		accent_w: float) -> Dictionary:
	var arg := tod * TAU - PI * 0.5
	var alt := sin(arg)                      # sun altitude -1..1 (0 = horizon)
	var el := alt * 0.5 + 0.5                # sun elevation 0..1 (spec §2.2)
	var ax := -cos(arg)                      # azimuth sweeps east -> west
	var damp := 1.0
	match weather:
		"overcast": damp = 0.55
		"storm": damp = 0.35
		"mist": damp = 0.8
	# Energy follows ProcSky's own daylight ramp (smoothstep over the altitude
	# crossing the horizon) so shading darkens exactly as the visible sky does,
	# then a second term lifts it toward 1.0 only when the sun is genuinely high:
	# noon = 1.0, mid-morning ~0.94.
	var sun_part := smoothstep(-0.05, 0.30, alt) * (0.70 + 0.30 * smoothstep(0.10, 0.85, alt)) * damp
	var moon_el := 1.0 - el
	# TWILIGHT FLOOR. `sun_part` is ~0 at the horizon crossing, so the raw sum
	# used to collapse to ~0.04 at dawn and dusk — the island went 3x DARKER than
	# midnight exactly when ProcSky's sky is at its brightest and warmest, pools
	# burned at full strength under a rose sky, and `is_night` stayed true across
	# the whole visible sunrise. Two floors carry the crossing instead:
	#   · moon_part — the lunar floor (0.12), rising once the sun is properly down
	#   · sky_part  — scattered SKYLIGHT, peaking at the horizon (alt 0) and gone
	#                 by |alt| > 0.5. Above NIGHT_ENERGY in clear weather, so
	#                 is_night releases near alt ~ 0 (about 8 degrees below the
	#                 horizon — civil twilight) instead of through the sunrise.
	# Energy is smooth and NEVER dips below the lunar floor: the moon term
	# saturates within ~10 degrees of the horizon (smoothstep to -alt 0.18), which
	# is where sky_part has decayed to the same 0.12, so the two floors hand over
	# without a notch. Measured over 2000 sampled tods, clear weather: minimum
	# 0.120 == the midnight floor (the old 0.34 moon ramp left a 0.110 notch just
	# before dawn); midnight 0.120, dawn/dusk 0.220, mid-morning 0.757, noon 1.000.
	var moon_part := 0.12 * maxf(damp, 0.5) * smoothstep(0.0, 0.18, -alt)
	var sky_part := 0.22 * maxf(damp, 0.45) * smoothstep(0.56, 0.0, absf(alt))
	var energy := clampf(maxf(sun_part + moon_part, sky_part), 0.0, 1.0)

	# Shade direction: sun by day, its antipode moon by night, blended through
	# twilight by their relative contributions. The small cross term keeps noon
	# off perfect vertical (spec's (0.12, 0.99)); y is floored so shadows always
	# fall downward-ish (never a horizon-grazing smear).
	var sun_vec := Vector2(ax * 0.78 + 0.12 * (1.0 - absf(ax)), maxf(0.25, el))
	var moon_vec := Vector2(-ax * 0.78 - 0.12 * (1.0 - absf(ax)), maxf(0.25, moon_el))
	var wsum := maxf(0.0001, sun_part + moon_part)
	var dir_mix := sun_vec * (sun_part / wsum) + moon_vec * (moon_part / wsum)
	var sun_dir := dir_mix.normalized() if dir_mix.length_squared() > 0.0001 else Vector2(0.0, 1.0)

	var tint_amt := 0.12 * clampf(accent_w, 0.0, 1.0)
	var sun_color := _ramp(SUN_STOPS, tod).lerp(accent, tint_amt)
	var ambient := _ramp(AMB_STOPS, tod).lerp(accent, tint_amt)
	var horizon := _ramp(HOR_STOPS, tod).lerp(accent, tint_amt)
	if weather == "overcast" or weather == "storm":
		var grey := Color(0.60, 0.63, 0.68)
		var k := 0.35 if weather == "overcast" else 0.55
		sun_color = sun_color.lerp(grey, k * 0.6)
		ambient = ambient.lerp(grey, k)
		horizon = horizon.lerp(grey, k)
		if weather == "storm":
			ambient = ambient.darkened(0.16)
			horizon = horizon.darkened(0.14)
	elif weather == "mist":
		horizon = horizon.lightened(0.10)
		ambient = ambient.lerp(horizon, 0.30)

	return {
		"tod": fposmod(tod, 1.0),
		"sun_dir": sun_dir,
		"sun_color": sun_color,
		"sun_energy": energy,
		"ambient": ambient,
		"horizon": horizon,
		"is_night": energy < NIGHT_ENERGY,
		"weather": weather,
		"version": _version,
	}

# Piecewise smooth ramp over the 5 anchored stops (wrapping; last == first).
static func _ramp(stops: Array[Color], tod: float) -> Color:
	var e := fposmod(tod, 1.0) * 4.0
	var i := mini(int(floor(e)), 3)
	var f := e - float(i)
	f = f * f * (3.0 - 2.0 * f)
	return stops[i].lerp(stops[i + 1], f)

# =============================================================================
# _Driver — the per-world poller. Rebuilds the LightCtx at most every 0.25 s and
# only on meaningful change, so version() consumers reshade ~every 7 s of the
# 28-minute day. The accumulator is a gameplay clock (allowed) — no Time.*.
# =============================================================================
class _Driver extends Node:
	var sky: Node = null
	var world_seed: int = 1
	var _accent: Color = Color.WHITE
	var _acc := 0.0
	var _last_tod := -1.0
	var _last_weather := ""

	func _ready() -> void:
		var pal := Proc.palette(world_seed, "world")
		_accent = pal["accent"]
		_rebuild(_poll_tod(), _poll_weather())

	func _process(delta: float) -> void:
		_acc += delta
		if _acc < ProcLighting.POLL_SECONDS:
			return
		_acc = 0.0
		var tod := _poll_tod()
		var w := _poll_weather()
		var moved := absf(tod - _last_tod)
		moved = minf(moved, 1.0 - moved)        # wrap-aware (tod is cyclic)
		if moved >= ProcLighting.TOD_EPSILON or w != _last_weather:
			_rebuild(tod, w)
		# Source edits ride their OWN counter, coalesced to this 0.25 s tick. The
		# LightCtx does not depend on sources, so there is nothing to rebuild and
		# — crucially — version() stays put: one wandering lantern must not force
		# every entity on the island to recompute its cached colours 4x/s when
		# §2.4 budgets one reshade every ~7 s.
		if ProcLighting._sources_dirty:
			ProcLighting._sources_dirty = false
			ProcLighting._sources_version += 1

	func _rebuild(tod: float, w: String) -> void:
		_last_tod = tod
		_last_weather = w
		ProcLighting._version += 1
		ProcLighting._ctx = ProcLighting._build_ctx(tod, w, _accent, 1.0)

	func _poll_tod() -> float:
		if sky != null and is_instance_valid(sky) and sky.has_method("get_time_of_day"):
			return float(sky.call("get_time_of_day"))
		return 0.5

	func _poll_weather() -> String:
		if sky != null and is_instance_valid(sky):
			var w: Variant = sky.get("weather")
			if w is String:
				return w
		return "clear"

	func _exit_tree() -> void:
		if ProcLighting._driver == self:
			ProcLighting._driver = null

# =============================================================================
# _BlobShadow — §2.6 + the §6 LOD table. Geometry is built ONCE as radial-fade
# fans (smooth vertex alpha, never degenerate); per-frame work is a static int
# compare and, at LOD0 only, a 4 Hz local-source scan. Only transform + modulate
# ever change, and all three of scale / modulate.a / position are COMPOSED from
# the owner-settable growth_scale / ao_mul / base_off so the owner's growth
# staging and stone-AO hooks survive every version bump.
# =============================================================================
class _BlobShadow extends Node2D:
	var radius: float = 12.0
	var lod: int = 0
	var growth_scale: float = 1.0     # entity g() — §2.6 growth staging
	var ao_mul: float = 1.0           # §5 stone contact AO (x1.3)
	var base_off: Vector2 = Vector2.ZERO
	var _lv := -1
	var _acc := 0.0
	var _pts: Array[PackedVector2Array] = []
	var _idx: Array[PackedInt32Array] = []
	var _cols: Array[PackedColorArray] = []
	var _sun_off := 0.0
	var _src_off := Vector2.ZERO

	func _ready() -> void:
		z_index = -1          # draw under the parent entity's own _draw
		_build()
		_apply_light()
		_apply_lod_state()

	# ---- owner-facing setters (compose, never clobber) ----------------------

	# Geometry rebuild — the ONE expensive setter. Guarded so a growth tick that
	# re-sends the same radius costs nothing; use set_growth_scale() for growth.
	func set_radius(r: float) -> void:
		var v := maxf(3.0, r)
		if is_equal_approx(v, radius):
			return
		radius = v
		_build()
		_apply_light()

	# §2.6: "scaled by the entity's g() in _on_growth". Transform only.
	func set_growth_scale(s: float) -> void:
		var v := maxf(0.0, s)
		if is_equal_approx(v, growth_scale):
			return
		growth_scale = v
		_apply_light()

	# §5: stone shadows are the contact AO, "darkened x1.3".
	func set_ao_mul(m: float) -> void:
		var v := maxf(0.0, m)
		if is_equal_approx(v, ao_mul):
			return
		ao_mul = v
		_apply_light()

	# A fixed local offset for off-centre footprints; the sun lean and the
	# night source push are added on top of it.
	func set_base_offset(off: Vector2) -> void:
		base_off = off
		position = base_off + Vector2(_sun_off, 0.0) + _src_off

	# §6: 0 = penumbra + umbra, 1 = one ellipse, 2 = none.
	func set_lod(l: int) -> void:
		var v := clampi(l, 0, 2)
		if v == lod:
			return
		lod = v
		_build()
		_apply_light()
		_apply_lod_state()

	# ---- build / draw -------------------------------------------------------

	func _build() -> void:
		_pts.clear()
		_idx.clear()
		_cols.clear()
		if lod >= 2:
			queue_redraw()
			return
		var rx := radius
		var ry := radius * 0.34
		var ink := Color(0.06, 0.07, 0.11)
		if lod == 1:
			# ONE radial ellipse: centre -> rim fade, 14 segments.
			_add_fan(ProcLighting._fan_mesh(rx, ry, 14,
					PackedFloat32Array([0.55, 1.0])), ink,
					PackedFloat32Array([0.80, 0.52, 0.0]))
		else:
			# Soft penumbra (3 rings = a 4-stop radial fade) ...
			_add_fan(ProcLighting._fan_mesh(rx, ry, 24,
					PackedFloat32Array([0.45, 0.78, 1.0])), ink,
					PackedFloat32Array([0.82, 0.70, 0.32, 0.0]))
			# ... plus a tighter, darker contact umbra right under the feet.
			_add_fan(ProcLighting._fan_mesh(rx * 0.52, ry * 0.60, 18,
					PackedFloat32Array([0.60, 1.0])), ink.darkened(0.25),
					PackedFloat32Array([0.55, 0.40, 0.0]))
		queue_redraw()

	func _add_fan(mesh: Dictionary, col: Color, alphas: PackedFloat32Array) -> void:
		var p: PackedVector2Array = mesh["pts"]
		var ix: PackedInt32Array = mesh["idx"]
		var ro: PackedInt32Array = mesh["ring"]
		_pts.append(p)
		_idx.append(ix)
		_cols.append(ProcLighting._fan_cols(ro, col, alphas))

	func _draw() -> void:
		var ci := get_canvas_item()
		for i in range(_pts.size()):
			RenderingServer.canvas_item_add_triangle_array(ci, _idx[i], _pts[i], _cols[i])

	func _apply_lod_state() -> void:
		var live := lod < 2
		set_process(live)
		if not live:
			_sun_off = 0.0
			_src_off = Vector2.ZERO
			visible = false

	# ---- per-frame (transform + modulate only) ------------------------------

	func _process(delta: float) -> void:
		if ProcLighting.version() != _lv:
			_lv = ProcLighting.version()
			_apply_light()
		if lod != 0:
			return      # §6: no local-source response below LOD0
		_acc += delta
		if _acc >= 0.25:
			_acc = 0.0
			_update_source_offset()

	func _apply_light() -> void:
		var lc := ProcLighting.ctx()
		var sd: Vector2 = lc.get("sun_dir", Vector2(0.12, 0.99))
		var en: float = clampf(float(lc.get("sun_energy", 1.0)), 0.0, 1.0)
		var night: bool = bool(lc.get("is_night", false))
		var night_mul := 0.4 if night else 1.0
		var gs := maxf(0.0, growth_scale)
		# COMPOSED, not assigned: growth staging and stone AO multiply in, so a
		# version bump re-derives the same values the owner asked for.
		scale = Vector2(gs * (1.0 + 0.9 * absf(sd.x)), gs)
		skew = clampf(-sd.x * 0.55, -0.6, 0.6)
		modulate.a = clampf(lerpf(0.10, 0.34, en) * night_mul * maxf(0.0, ao_mul), 0.0, 1.0)
		_sun_off = sd.x * radius * 0.35 * gs
		position = base_off + Vector2(_sun_off, 0.0) + _src_off
		# A just-planted seed (g() ~ 0) would rasterize a zero-area fan forever;
		# drop it out of the blend pipeline until the sprout casts something.
		visible = lod < 2 and modulate.a > 0.004 and gs > 0.004

	# At night a nearby registered source pushes the shadow AWAY from the light
	# (the pool-of-light look). LOD0 only, 4 Hz, iterates the source dict
	# directly instead of calling sample() so there is zero allocation here.
	#
	# Source positions are registered in ONE declared space (§2.3, cam/band
	# local). The owner's own `position` is a LOCAL offset inside whatever band
	# container it was parented into — and a module that nests this shadow one
	# level deeper makes it meaningless — so the feet are taken from the GLOBAL
	# transform and converted into source space.
	func _update_source_offset() -> void:
		var target := Vector2.ZERO
		if lod == 0 and not ProcLighting._sources.is_empty():
			var lc := ProcLighting.ctx()
			if bool(lc.get("is_night", false)):
				var feet := _feet_in_source_space()
				var best_w := 0.0
				var best_pos := Vector2.ZERO
				for k: String in ProcLighting._sources:
					var s: Dictionary = ProcLighting._sources[k]
					var sp: Vector2 = s["pos"]
					var rr: float = s["radius"]
					var dist := feet.distance_to(sp)
					if dist >= rr:
						continue
					var fall := 1.0 - dist / rr
					var w: float = float(s["strength"]) * fall * fall
					if w > best_w:
						best_w = w
						best_pos = sp
				if best_w > 0.001:
					var away := feet - best_pos
					if away.length_squared() > 0.0001:
						target = away.normalized() * radius * 0.4 \
								* maxf(0.0, growth_scale) * clampf(best_w, 0.0, 1.0)
		if target.is_equal_approx(_src_off):
			return
		_src_off = target
		position = base_off + Vector2(_sun_off, 0.0) + _src_off

	# The shadow sits at the owner's feet, so its own global origin IS the feet.
	func _feet_in_source_space() -> Vector2:
		if is_inside_tree():
			return ProcLighting.to_source_space(get_global_transform().origin)
		var par := get_parent()
		if par is Node2D:
			return (par as Node2D).position + base_off
		return base_off

# =============================================================================
# _LightPool — §2.7. Additive radial-faded halo: ONE vertex-alpha fan (smooth,
# no concentric banding) + a ground-hugging ellipse wash. Built once; afterwards
# only modulate changes (strength x (1 - sun_energy)), and the node hides itself
# once fully transparent so up to 24 pools stop costing blend bandwidth all day.
# Every pool shares the module's single additive CanvasItemMaterial.
# =============================================================================
class _LightPool extends Node2D:
	var color := Color(1.0, 0.85, 0.5)
	var radius := 60.0
	var strength := 1.0
	var lod: int = 0
	var _lv := -1
	var _pts: Array[PackedVector2Array] = []
	var _idx: Array[PackedInt32Array] = []
	var _cols: Array[PackedColorArray] = []

	func _ready() -> void:
		material = ProcLighting._additive_material()
		_build()
		_apply()

	func set_strength(s: float) -> void:
		strength = maxf(0.0, s)
		_apply()

	# §6: pools survive at LOD1 (disc only) and vanish at LOD2.
	func set_lod(l: int) -> void:
		var v := clampi(l, 0, 2)
		if v == lod:
			return
		lod = v
		_build()
		_apply()

	func _build() -> void:
		_pts.clear()
		_idx.clear()
		_cols.clear()
		if lod >= 2:
			queue_redraw()
			return
		if lod == 1:
			_add_fan(ProcLighting._fan_mesh(radius, radius, 16,
					PackedFloat32Array([0.50, 1.0])), color,
					PackedFloat32Array([0.30, 0.14, 0.0]))
		else:
			# The halo proper: a 4-stop radial fade to nothing at the rim.
			_add_fan(ProcLighting._fan_mesh(radius, radius, 28,
					PackedFloat32Array([0.30, 0.62, 1.0])), color,
					PackedFloat32Array([0.34, 0.22, 0.09, 0.0]))
			# Ground-hugging wash: a wide squashed ellipse at the node origin.
			_add_fan(ProcLighting._fan_mesh(radius * 1.35, radius * 0.22, 24,
					PackedFloat32Array([0.55, 1.0])), color,
					PackedFloat32Array([0.16, 0.08, 0.0]))
		queue_redraw()

	func _add_fan(mesh: Dictionary, col: Color, alphas: PackedFloat32Array) -> void:
		var p: PackedVector2Array = mesh["pts"]
		var ix: PackedInt32Array = mesh["idx"]
		var ro: PackedInt32Array = mesh["ring"]
		_pts.append(p)
		_idx.append(ix)
		_cols.append(ProcLighting._fan_cols(ro, col, alphas))

	func _draw() -> void:
		var ci := get_canvas_item()
		for i in range(_pts.size()):
			RenderingServer.canvas_item_add_triangle_array(ci, _idx[i], _pts[i], _cols[i])

	func _process(_delta: float) -> void:
		if ProcLighting.version() != _lv:
			_lv = ProcLighting.version()
			_apply()

	func _apply() -> void:
		var en: float = clampf(float(ProcLighting.ctx().get("sun_energy", 1.0)), 0.0, 1.0)
		var a := clampf(strength * (1.0 - en), 0.0, 1.0)
		modulate = Color(1.0, 1.0, 1.0, a)
		# Fully transparent pools leave the blend pipeline entirely (mobile perf
		# is a feature): at noon this is exactly 0 for all 24 of them.
		visible = lod < 2 and a > 0.004
		set_process(lod < 2)
