class_name ProcFoliage
extends RefCounted
# ProcFoliage — the shared FOLIAGE renderer of the 2.5D upgrade (GFX-2.5D §7.5)
# plus the dense GROUND-DETAIL layer that makes the meadow read lush.
#
# Two families, both 100% math (CONVENTIONS.md — no images, no emoji):
#
#   LEAF-CLUSTER / CANOPY MASS (the §5 "Leaf cluster, 3-tone depth" recipe)
#       One agreed way to draw a mass of leaves, so every tree, bush and the
#       Heart Tree shade identically: three stacked blob layers from the SAME
#       seeded controls at three scales (back = shade, mid = base, front = lit,
#       each offset toward the sun), finished with seeded leaf-tip scallop arcs
#       along the lit rim. Available three ways:
#         · make_cluster()        — a self-contained ProcNode child (sways,
#                                   grows, reshades itself on light changes)
#         · build_cluster_cache() + draw_cluster_into() — immediate-mode pair
#                                   for modules that must stay single-_draw
#                                   (ProcTrees/ProcHeartTree/ProcPlants migrate
#                                   their canopies onto these, signatures kept)
#         · canopy_colors()       — the agreed 3-tone + rim set, fog applied
#
#   GROUND COVER (make_ground_cover) — a thick strip of instanced grass blades,
#       seed-head stalks, clover patches, tiny flowers and pebbles scattered
#       along a depth row. Blades/clover/flowers ride THREE MultiMesh batches
#       (one draw call each, thousands-of-blades feel for mobile pennies) bent
#       by a tiny vertex shader: wind waves ripple across the strip (phase by
#       x), gusts breathe, and the cover near placed entities PARTS and
#       FLATTENS subtly (press/release API — up to 8 live press points pushed
#       as uniforms, zero redraws). Pebbles + the soil contact band are cached
#       polygons drawn once. Everything is seeded, realm-tinted via the base /
#       accent colors handed in, depth-fogged per GFX-2.5D §1.4, LOD-aware
#       (§6) and grows believably from sparse stubble to lush meadow.
#
# Lighting: colors derive from the LightCtx (GFX-2.5D §2). ProcLighting may not
# exist yet while the 2.5D build is in flight, so this module soft-bridges to it
# (loads it if the file exists, else uses the spec's deterministic noon default)
# and re-shades cache-on-change per §2.4 — never per frame.
#
# Perf contract honoured here:
#   · point arrays + meshes + color arrays are built once (_on_built / reshade)
#   · _animate only sets transforms and pushes a few float uniforms
#   · no allocation per frame; presses/reshades allocate only on their events
#   · every polygon is guarded ≥ 3 distinct points; degenerate radii clamp out
#
# ── Usage ────────────────────────────────────────────────────────────────────
#   # a canopy for a tree (child node; parent positions it at the crown):
#   var cl := ProcFoliage.make_cluster(ws, key + ":crown", 64.0, pal.base,
#       {"season": season, "d": d, "lod": lod})
#   add_child(cl)
#
#   # single-_draw modules (inside _on_built / _reshade, then in _draw):
#   var cols := ProcFoliage.canopy_colors(base, ProcFoliage.light_ctx(), d, horizon)
#   _canopy_cache = ProcFoliage.build_cluster_cache(ws, key, 64.0, cols, lod)
#   ...  func _draw(): ProcFoliage.draw_cluster_into(self, _canopy_cache)
#
#   # WorldSpace plants one cover strip per band row (front row shown):
#   var cover := ProcFoliage.make_ground_cover(world_seed, "home:cover0",
#       half * 2.0, pal.base, {"accent": pal.accent, "d": 0.04,
#       "surface": _cover_surface_callable})   # Callable(x)->ground y offset
#   _ent_layer.add_child(cover)
#   cover.z_index = 2                          # just over the front contour
#   # when an entity is placed / removed on this row:
#   cover.press(place_id, tx, footprint * 1.3, 0.85)
#   cover.release(place_id)

const _LIGHT_PATH := "res://scripts/proc/ProcLighting.gd"
const _MAX_PRESS := 8
const _MAX_BLADES := 2600

# ---------------------------------------------------------------------------
# PUBLIC FACTORIES + HELPERS (GFX-2.5D §7.5 — signatures are the contract)
# ---------------------------------------------------------------------------

# The §5 3-tone leaf mass as a reusable child node (sway via its transform).
# opts: {lod:int, droop:float, scallops:bool, season:String}
#   additive extras: {d:float, horizon:Color, sway:float, grow_minutes:float}
static func make_cluster(world_seed: int, key: String, radius: float,
		base: Color, opts: Dictionary = {}) -> Node2D:
	var n := _Cluster.new()
	n.seedv = hash("%d:%s" % [world_seed, key])
	n.radius = maxf(6.0, radius)
	n.base_col = base
	n.lod = int(opts.get("lod", 0))
	n.droop = clampf(float(opts.get("droop", 0.0)), 0.0, 1.0)
	n.want_scallops = bool(opts.get("scallops", true))
	n.season = String(opts.get("season", "summer"))
	n.depth_d = clampf(float(opts.get("d", 0.0)), 0.0, 1.0)
	n.sway_amp = clampf(float(opts.get("sway", 1.0)), 0.0, 3.0)
	if opts.has("horizon"):
		n.horizon_col = opts["horizon"]
		n.horizon_set = true
	var gm: float = float(opts.get("grow_minutes", -1.0))
	if gm > 0.0:
		n.set_grow_minutes(gm)
	return n

# The agreed 3-tone + rim set, fog applied (GFX-2.5D §1.4 + §2.4).
# Returns {back, mid, front, rim} (+ "sun_x": which x direction faces the sun,
# so cache builders can offset layers toward the light).
static func canopy_colors(base: Color, lc: Dictionary, d: float, horizon: Color) -> Dictionary:
	var sp := shade_pair(base, lc)
	var lit: Color = sp["lit"]
	var shade: Color = sp["shade"]
	var sd: Vector2 = lc.get("sun_dir", Vector2(0.12, 0.99))
	var sun_x: float = -1.0 if sd.x >= 0.0 else 1.0
	return {
		"back": fog_tint(shade.darkened(0.10), d, horizon),
		"mid": fog_tint(base, d, horizon),
		"front": fog_tint(lit, d, horizon),
		"rim": fog_tint(lit.lightened(0.10), d, horizon),
		"sun_x": sun_x,
	}

# Immediate-mode variant for modules that must stay single-_draw.
static func draw_cluster_into(ci: CanvasItem, pts_cache: Dictionary) -> void:
	if pts_cache.is_empty():
		return
	var polys: Array = pts_cache.get("polys", [])
	for entry in polys:
		var layer: Dictionary = entry
		var pts: PackedVector2Array = layer.get("pts", PackedVector2Array())
		var cols: PackedColorArray = layer.get("cols", PackedColorArray())
		if pts.size() >= 3 and cols.size() == pts.size():
			ci.draw_polygon(pts, cols)
	var rim_col: Color = pts_cache.get("rim_col", Color.WHITE)
	var scallops: Array = pts_cache.get("scallops", [])
	for entry in scallops:
		var s: Dictionary = entry
		var pos: Vector2 = s.get("pos", Vector2.ZERO)
		var r: float = float(s.get("r", 0.0))
		if r > 0.5:
			ci.draw_arc(pos, r, float(s.get("a0", 0.0)), float(s.get("a1", 1.0)),
				10, rim_col, 1.8, true)

# The pts_cache for draw_cluster_into. `cols` comes from canopy_colors().
static func build_cluster_cache(world_seed: int, key: String, radius: float,
		cols: Dictionary, lod: int) -> Dictionary:
	return _build_cache(hash("%d:%s" % [world_seed, key]), "cc", radius, cols, lod, 0.0, true)

# Re-tint an existing cluster cache in place after a light change (reshade path
# for single-_draw consumers): geometry is kept, only color arrays rebuild.
static func recolor_cluster_cache(pts_cache: Dictionary, cols: Dictionary) -> void:
	if pts_cache.is_empty():
		return
	var polys: Array = pts_cache.get("polys", [])
	for entry in polys:
		var layer: Dictionary = entry
		var role: String = String(layer.get("role", "mid"))
		var c: Color = cols.get(role, Color.WHITE)
		var pts: PackedVector2Array = layer.get("pts", PackedVector2Array())
		if pts.size() >= 3:
			layer["cols"] = Proc.grad_fill(pts, c.lightened(0.07), c.darkened(0.10))
	pts_cache["rim_col"] = cols.get("rim", Color.WHITE)

# ---------------------------------------------------------------------------
# GROUND COVER (additive API — the dense ground-detail strip)
# ---------------------------------------------------------------------------

# A thick strip of grass/clover/flowers/pebbles centred on the node origin:
# x in [-width/2, width/2], ground line at y = 0 (+ optional surface callable).
# opts:
#   density: float = 1.0        overall thickness multiplier
#   lod: int = -1               -1 = derive from d (GFX-2.5D §6-ish bands)
#   d: float = 0.0              depth in [0,1] — fogs the palette (§1.4)
#   horizon: Color              fog-toward color (default: LightCtx horizon)
#   depth: Dictionary           a DepthCtx (§1.5); its d/horizon/lod win
#   accent: Color               realm accent — tints flower heads + blade tips
#   season: String = "summer"   spring / summer / autumn / winter tinting
#   wind: float = 1.0           wind strength (also set_wind at runtime)
#   height: float = 1.0         blade height multiplier
#   flowers / clover / pebbles: bool = true   toggle sub-layers
#   surface: Callable           f(x:float)->y offset of the ground line at x
#   surface_amp: float = 3.0    seeded undulation when no surface callable
#   grow_minutes: float         growth pace override
static func make_ground_cover(world_seed: int, key: String, width: float,
		base: Color, opts: Dictionary = {}) -> ProcNode:
	var n := _GroundCover.new()
	n.seedv = hash("%d:%s" % [world_seed, key])
	n.strip_w = maxf(80.0, width)
	n.base_col = base
	var dctx: Dictionary = opts.get("depth", {})
	n.depth_d = clampf(float(dctx.get("d", opts.get("d", 0.0))), 0.0, 1.0)
	if dctx.has("horizon"):
		n.horizon_col = dctx["horizon"]
		n.horizon_set = true
	elif opts.has("horizon"):
		n.horizon_col = opts["horizon"]
		n.horizon_set = true
	var lod_in: int = int(dctx.get("lod", opts.get("lod", -1)))
	if lod_in < 0:
		lod_in = 2 if n.depth_d > 0.70 else (1 if n.depth_d > 0.35 else 0)
	n.lod = clampi(lod_in, 0, 2)
	n.density = clampf(float(opts.get("density", 1.0)), 0.05, 3.0)
	n.accent_col = opts.get("accent", base.lightened(0.25))
	n.season = String(opts.get("season", "summer"))
	n.wind = clampf(float(opts.get("wind", 1.0)), 0.0, 3.0)
	n.height_mul = clampf(float(opts.get("height", 1.0)), 0.2, 3.0)
	n.want_flowers = bool(opts.get("flowers", true))
	n.want_clover = bool(opts.get("clover", true))
	n.want_pebbles = bool(opts.get("pebbles", true))
	n.surface_fn = opts.get("surface", Callable())
	n.surface_amp = clampf(float(opts.get("surface_amp", 3.0)), 0.0, 24.0)
	var gm: float = float(opts.get("grow_minutes", -1.0))
	if gm > 0.0:
		n.set_grow_minutes(gm)
	return n

# ---------------------------------------------------------------------------
# LIGHT BRIDGE — soft link to ProcLighting (GFX-2.5D §2), safe standalone
# ---------------------------------------------------------------------------

static var _light_checked := false
static var _light_script: GDScript = null
static var _noon: Dictionary = {}

static func _light_ref() -> GDScript:
	if not _light_checked:
		_light_checked = true
		if ResourceLoader.exists(_LIGHT_PATH):
			_light_script = load(_LIGHT_PATH) as GDScript
	return _light_script

# The live LightCtx when ProcLighting is installed, else the spec's
# deterministic noon default — callers never branch on readiness.
static func light_ctx() -> Dictionary:
	var ls := _light_ref()
	if ls != null:
		var c: Variant = ls.call("ctx")
		if c is Dictionary:
			var cd: Dictionary = c
			if not cd.is_empty():
				return cd
	if _noon.is_empty():
		_noon = {
			"tod": 0.5,
			"sun_dir": Vector2(0.12, 0.99).normalized(),
			"sun_color": Color(1.0, 0.965, 0.878),
			"sun_energy": 1.0,
			"ambient": Color(0.72, 0.78, 0.88),
			"horizon": Color(0.80, 0.86, 0.93),
			"is_night": false,
			"weather": "clear",
			"version": 0,
		}
	return _noon

static func light_version() -> int:
	var ls := _light_ref()
	if ls != null:
		var v: Variant = ls.call("version")
		if v is int:
			return v
	return 0

# The §2.4 two-tone split (duplicated formula so this module parses + renders
# standalone before/without ProcLighting; the math is spec-identical).
static func shade_pair(base: Color, lc: Dictionary) -> Dictionary:
	var se: float = clampf(float(lc.get("sun_energy", 1.0)), 0.0, 1.0)
	var sc: Color = lc.get("sun_color", Color(1.0, 0.965, 0.878))
	var amb: Color = lc.get("ambient", Color(0.72, 0.78, 0.88))
	var lit: Color = base.lerp(sc, 0.16 * se).lightened(0.08 * se)
	var shade: Color = base.darkened(0.18 + 0.10 * (1.0 - se)).lerp(amb, 0.22)
	return {"lit": lit, "shade": shade}

# The §1.4 atmospheric depth tint (spec-identical math, kept local for the
# same standalone reason — zero per-frame cost: call at build/reshade only).
static func fog_tint(c: Color, d: float, horizon: Color) -> Color:
	var e := clampf(d, 0.0, 1.0)
	var m := 0.42 * pow(e, 1.5)
	if m <= 0.0005:
		return c
	var gv := c.v
	var desat := Color.from_hsv(c.h, c.s * (1.0 - m * 0.6), c.v, c.a)
	return desat.lerp(Color(horizon.r, horizon.g, horizon.b, c.a), m * (0.8 + 0.2 * gv))

# Season tinting shared by clusters and ground cover.
static func season_shift(c: Color, season: String) -> Color:
	match season:
		"spring":
			return Color.from_hsv(fposmod(c.h + 0.015, 1.0), c.s * 0.92, minf(1.0, c.v + 0.07), c.a)
		"autumn":
			return Color.from_hsv(lerpf(c.h, 0.07, 0.55), minf(1.0, c.s * 1.12), c.v * 0.96, c.a)
		"winter":
			return Color.from_hsv(c.h, c.s * 0.38, minf(1.0, c.v + 0.10), c.a)
		_:
			return c

# ---------------------------------------------------------------------------
# INTERNAL — cluster cache geometry
# ---------------------------------------------------------------------------

static func _build_cache(seedv: int, key: String, radius: float, cols: Dictionary,
		lod: int, droop: float, scallops_on: bool) -> Dictionary:
	var rad := maxf(6.0, radius)
	var r := Proc.rng(seedv, "foliage:" + key)
	var lobes: int = 8 + (r.randi() % 4)
	var controls := PackedVector2Array()
	var ph := r.randf() * TAU
	for i in range(lobes):
		var a := ph + TAU * float(i) / float(lobes)
		var rr := rad * (0.78 + r.randf() * 0.40)
		var p := Vector2(cos(a), sin(a) * 0.86) * rr
		if p.y > 0.0:
			p.y *= 1.0 + droop * 0.6
		controls.append(p)
	var samples := 10
	if lod == 1:
		samples = 6
	elif lod >= 2:
		samples = 4
	var sun_x: float = float(cols.get("sun_x", -1.0))
	var off_mid := Vector2(sun_x * minf(6.0, rad * 0.10), -minf(4.0, rad * 0.05))
	var off_front := Vector2(sun_x * minf(10.0, rad * 0.16), -minf(7.0, rad * 0.09))
	# [role, scale, offset] stacks per LOD (§5 leaf-cluster recipe).
	var stack: Array = []
	if lod <= 0:
		stack = [["back", 1.0, Vector2.ZERO], ["mid", 0.86, off_mid], ["front", 0.68, off_front]]
	elif lod == 1:
		stack = [["back", 1.0, Vector2.ZERO], ["front", 0.78, off_front]]
	else:
		stack = [["mid", 1.0, Vector2.ZERO]]
	var polys: Array = []
	for entry in stack:
		var layer: Array = entry
		var role: String = layer[0]
		var sc: float = layer[1]
		var off: Vector2 = layer[2]
		var cpts := PackedVector2Array()
		for cp in controls:
			cpts.append(cp * sc + off)
		var pts := Proc.smooth_loop(cpts, samples)
		if pts.size() < 3:
			continue
		var c: Color = cols.get(role, Color(0.35, 0.55, 0.32))
		polys.append({
			"role": role,
			"pts": pts,
			"cols": Proc.grad_fill(pts, c.lightened(0.07), c.darkened(0.10)),
		})
	var scallops: Array = []
	if lod <= 0 and scallops_on:
		var n_sc: int = 5 + (r.randi() % 5)
		for i in range(n_sc):
			# Along the lit rim: upper quadrant biased toward the sun side.
			var k := float(i) / float(maxi(1, n_sc - 1))
			var base_a := -PI * 0.5 + sun_x * lerpf(-0.95, 0.35, k)
			var aa := base_a + r.randf_range(-0.12, 0.12)
			var ring := rad * 0.68 * r.randf_range(0.86, 1.0)
			var pos := off_front + Vector2(cos(aa), sin(aa) * 0.86) * ring
			var sr := rad * r.randf_range(0.12, 0.20)
			scallops.append({
				"pos": pos, "r": sr,
				"a0": aa - r.randf_range(0.65, 0.9),
				"a1": aa + r.randf_range(0.65, 0.9),
			})
	return {
		"polys": polys,
		"scallops": scallops,
		"rim_col": cols.get("rim", Color.WHITE),
		"lod": lod,
	}

# ---------------------------------------------------------------------------
# INTERNAL — shared wind shader + meshes for the ground cover
# ---------------------------------------------------------------------------

const _WIND_SHADER_SRC := """
shader_type canvas_item;
// Bends instanced ground flora. INSTANCE_CUSTOM = (phase01, x01, size_x_px, size_y_px):
// meshes are UNIT-sized; scaling happens HERE so all displacement math is in px
// regardless of how the renderer composes instance transforms.
uniform float u_t = 0.0;
uniform float u_wind = 1.0;
uniform float u_grow = 1.0;
uniform float u_bend = 6.0;
uniform float u_speed = 1.6;
uniform float u_width = 1000.0;
uniform float u_phase_per_px = 0.013;
uniform float u_alpha = 1.0;
uniform vec4 u_root_col : source_color = vec4(1.0);
uniform vec4 u_tip_col : source_color = vec4(1.0);
uniform int u_press_count = 0;
uniform vec3 u_press[8];
void vertex() {
	vec4 cd = INSTANCE_CUSTOM;
	float tip = clamp(-VERTEX.y, 0.0, 1.0);
	VERTEX *= vec2(max(cd.b, 0.01), max(cd.a, 0.01) * u_grow);
	float bx = (cd.g - 0.5) * u_width;
	float ph = cd.r * 6.2831853 + bx * u_phase_per_px;
	float sway = sin(u_t * u_speed + ph) * 0.65 + sin(u_t * u_speed * 0.317 + ph * 1.73) * 0.35;
	float flat_amt = 0.0;
	float push = 0.0;
	for (int i = 0; i < u_press_count; i++) {
		vec3 p = u_press[i];
		float dx = bx - p.x;
		float w = 1.0 - clamp(abs(dx) / max(p.y, 1.0), 0.0, 1.0);
		w = w * w * (3.0 - 2.0 * w) * p.z;
		flat_amt = max(flat_amt, w);
		push += (dx >= 0.0 ? 1.0 : -1.0) * w;
	}
	VERTEX.y *= 1.0 - 0.55 * clamp(flat_amt, 0.0, 1.0) * tip;
	VERTEX.x += (sway * u_wind * u_bend + push * 9.0) * tip * tip;
	COLOR *= mix(u_root_col, u_tip_col, tip);
	COLOR.a *= u_alpha;
}
"""

static var _wind_shader: Shader = null
static var _blade_mesh: ArrayMesh = null
static var _clover_mesh: ArrayMesh = null
static var _flower_mesh: ArrayMesh = null

static func _wind_shader_res() -> Shader:
	if _wind_shader == null:
		_wind_shader = Shader.new()
		_wind_shader.code = _WIND_SHADER_SRC
	return _wind_shader

# Unit blade: root at (±0.5, 0), tip at (0, −1), two mid rows for smooth bend.
static func _blade_mesh_res() -> ArrayMesh:
	if _blade_mesh != null:
		return _blade_mesh
	var v := PackedVector2Array([
		Vector2(-0.5, 0.0), Vector2(0.5, 0.0),
		Vector2(-0.36, -0.42), Vector2(0.36, -0.42),
		Vector2(-0.18, -0.78), Vector2(0.18, -0.78),
		Vector2(0.0, -1.0),
	])
	var c := PackedColorArray()
	for i in range(v.size()):
		c.append(Color.WHITE)
	var idx := PackedInt32Array([0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4, 4, 5, 6])
	_blade_mesh = _mesh_from(v, c, idx)
	return _blade_mesh

# Unit clover: short stem + three round leaflets near y ≈ −0.7.
static func _clover_mesh_res() -> ArrayMesh:
	if _clover_mesh != null:
		return _clover_mesh
	var v := PackedVector2Array()
	var c := PackedColorArray()
	var idx := PackedInt32Array()
	_add_quad(v, c, idx, Vector2(-0.035, 0.0), Vector2(0.035, 0.0),
		Vector2(0.03, -0.52), Vector2(-0.03, -0.52), Color(0.92, 1.0, 0.9))
	var centers := [Vector2(-0.24, -0.62), Vector2(0.24, -0.62), Vector2(0.0, -0.86)]
	for entry in centers:
		var ctr: Vector2 = entry
		_add_disc(v, c, idx, ctr, 0.21, 7, Color.WHITE)
	_clover_mesh = _mesh_from(v, c, idx)
	return _clover_mesh

# Unit flower: stem, five diamond petals around a head at (0, −0.8), warm core.
static func _flower_mesh_res() -> ArrayMesh:
	if _flower_mesh != null:
		return _flower_mesh
	var v := PackedVector2Array()
	var c := PackedColorArray()
	var idx := PackedInt32Array()
	_add_quad(v, c, idx, Vector2(-0.028, 0.0), Vector2(0.028, 0.0),
		Vector2(0.022, -0.74), Vector2(-0.022, -0.74), Color(0.9, 1.0, 0.88))
	var head := Vector2(0.0, -0.8)
	for i in range(5):
		var a := -PI * 0.5 + TAU * float(i) / 5.0
		var dir := Vector2(cos(a), sin(a))
		var side := Vector2(-dir.y, dir.x)
		var i0 := v.size()
		v.append(head + dir * 0.05)
		v.append(head + dir * 0.15 + side * 0.09)
		v.append(head + dir * 0.27)
		v.append(head + dir * 0.15 - side * 0.09)
		for k in range(4):
			c.append(Color.WHITE)
		idx.append_array(PackedInt32Array([i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3]))
	_add_disc(v, c, idx, head, 0.085, 7, Color(1.0, 0.86, 0.42))
	_flower_mesh = _mesh_from(v, c, idx)
	return _flower_mesh

static func _mesh_from(v: PackedVector2Array, c: PackedColorArray, idx: PackedInt32Array) -> ArrayMesh:
	var arrays: Array = []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = v
	arrays[Mesh.ARRAY_COLOR] = c
	arrays[Mesh.ARRAY_INDEX] = idx
	var m := ArrayMesh.new()
	m.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	return m

static func _add_quad(v: PackedVector2Array, c: PackedColorArray, idx: PackedInt32Array,
		a: Vector2, b: Vector2, c2: Vector2, d2: Vector2, col: Color) -> void:
	var i0 := v.size()
	v.append_array(PackedVector2Array([a, b, c2, d2]))
	for k in range(4):
		c.append(col)
	idx.append_array(PackedInt32Array([i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3]))

static func _add_disc(v: PackedVector2Array, c: PackedColorArray, idx: PackedInt32Array,
		ctr: Vector2, radius: float, segs: int, col: Color) -> void:
	var i0 := v.size()
	v.append(ctr)
	c.append(col.lightened(0.08))
	for i in range(segs):
		var a := TAU * float(i) / float(segs)
		v.append(ctr + Vector2(cos(a), sin(a) * 0.92) * radius)
		c.append(col)
	for i in range(segs):
		idx.append_array(PackedInt32Array([i0, i0 + 1 + i, i0 + 1 + ((i + 1) % segs)]))

# ===========================================================================
# _Cluster — the self-contained canopy mass node
# ===========================================================================
class _Cluster extends ProcNode:
	var radius := 48.0
	var base_col := Color(0.34, 0.56, 0.32)
	var lod := 0
	var droop := 0.0
	var want_scallops := true
	var season := "summer"
	var depth_d := 0.0
	var horizon_col := Color(0.80, 0.86, 0.93)
	var horizon_set := false
	var sway_amp := 1.0
	var _cache: Dictionary = {}
	var _lit_version := -1
	var _lv_timer := 0.0
	var _base_eff := Color.WHITE

	func _on_built() -> void:
		_base_eff = ProcFoliage.season_shift(base_col, season)
		_reshade()

	func _reshade() -> void:
		var lc := ProcFoliage.light_ctx()
		if not horizon_set:
			horizon_col = lc.get("horizon", horizon_col)
		var cols := ProcFoliage.canopy_colors(_base_eff, lc, depth_d, horizon_col)
		if _cache.is_empty():
			_cache = ProcFoliage._build_cache(seedv, "cl", radius, cols, lod, droop, want_scallops)
		else:
			ProcFoliage.recolor_cluster_cache(_cache, cols)
		queue_redraw()

	func _animate(delta: float) -> void:
		# Sway: pure transform — a slow lean plus a tiny breath, desynced by phase.
		rotation = (sin(t * 0.45 + phase) * 0.022 + sin(t * 1.21 + phase * 1.7) * 0.008) * sway_amp
		_lv_timer += delta
		if _lv_timer >= 0.25:
			_lv_timer = 0.0
			var lv := ProcFoliage.light_version()
			if lv != _lit_version:
				_lit_version = lv
				_reshade()

	func _on_growth() -> void:
		var sc := lerpf(0.12, 1.0, g())
		scale = Vector2(sc, sc)

	func _draw() -> void:
		ProcFoliage.draw_cluster_into(self, _cache)

# ===========================================================================
# _GroundCover — the dense instanced ground-detail strip
# ===========================================================================
class _GroundCover extends ProcNode:
	var strip_w := 800.0
	var base_col := Color(0.34, 0.56, 0.32)
	var accent_col := Color(0.8, 0.6, 0.4)
	var season := "summer"
	var depth_d := 0.0
	var horizon_col := Color(0.80, 0.86, 0.93)
	var horizon_set := false
	var lod := 0
	var density := 1.0
	var wind := 1.0
	var height_mul := 1.0
	var want_flowers := true
	var want_clover := true
	var want_pebbles := true
	var surface_fn := Callable()
	var surface_amp := 3.0

	var _mats: Array[ShaderMaterial] = []
	var _flower_mat: ShaderMaterial = null
	var _clover_mat: ShaderMaterial = null
	var _presses: Dictionary = {}
	var _pebbles: Array = []
	var _soil_pts := PackedVector2Array()
	var _soil_cols := PackedColorArray()
	var _soil_top := Color(0, 0, 0, 0.22)
	var _lit_version := -1
	var _lv_timer := 0.0
	var _surf_noise: FastNoiseLite = null
	var _base_eff := Color.WHITE

	# -- public runtime API ---------------------------------------------------

	# Part + flatten the cover around x (strip-local px). Call when an entity
	# lands on this row; id lets you move/clear it later. Max 8 live presses —
	# beyond that the weakest is evicted.
	func press(id: String, x: float, radius: float, strength: float = 1.0) -> void:
		_presses[id] = Vector3(x, maxf(6.0, radius), clampf(strength, 0.0, 1.0))
		if _presses.size() > ProcFoliage._MAX_PRESS:
			var weakest := ""
			var wmin := INF
			for pid: String in _presses.keys():
				var pv: Vector3 = _presses[pid]
				if pv.z < wmin:
					wmin = pv.z
					weakest = pid
			if weakest != "" and weakest != id:
				_presses.erase(weakest)
		_push_presses()

	func release(id: String) -> void:
		if _presses.erase(id):
			_push_presses()

	func clear_presses() -> void:
		if not _presses.is_empty():
			_presses.clear()
			_push_presses()

	func set_wind(w: float) -> void:
		wind = clampf(w, 0.0, 3.0)

	# -- build ---------------------------------------------------------------

	func _on_built() -> void:
		_base_eff = ProcFoliage.season_shift(base_col, season)
		if not surface_fn.is_valid():
			_surf_noise = Proc.noise(seedv, "cover:surf", 0.008, 2)
		var lc := ProcFoliage.light_ctx()
		if not horizon_set:
			horizon_col = lc.get("horizon", horizon_col)
		_build_blades()
		_build_clover()
		_build_flowers()
		_build_ground_detail(lc)
		_apply_palette(lc)
		_push_presses()
		_push_grow()
		queue_redraw()

	func _surface_y(x: float) -> float:
		if surface_fn.is_valid():
			return float(surface_fn.call(x))
		if _surf_noise != null:
			return _surf_noise.get_noise_1d(x) * surface_amp
		return 0.0

	func _lod_mult() -> float:
		if lod >= 2:
			return 0.30
		return 0.55 if lod == 1 else 1.0

	func _make_mat(bend_px: float, speed: float) -> ShaderMaterial:
		var m := ShaderMaterial.new()
		m.shader = ProcFoliage._wind_shader_res()
		m.set_shader_parameter(&"u_width", strip_w)
		m.set_shader_parameter(&"u_bend", bend_px)
		m.set_shader_parameter(&"u_speed", speed)
		m.set_shader_parameter(&"u_phase_per_px", 0.013)
		_mats.append(m)
		return m

	func _make_mmi(mesh: ArrayMesh, count: int, mat: ShaderMaterial, z: int) -> MultiMesh:
		var mm := MultiMesh.new()
		mm.transform_format = MultiMesh.TRANSFORM_2D
		mm.use_colors = true
		mm.use_custom_data = true
		mm.mesh = mesh
		mm.instance_count = count
		var mi := MultiMeshInstance2D.new()
		mi.multimesh = mm
		mi.material = mat
		mi.z_index = z
		mi.z_as_relative = true
		add_child(mi)
		return mm

	# Two blade batches: a darker back rank (slightly up-screen, calmer) and a
	# lighter front rank (livelier) — instant depth inside the strip itself.
	func _build_blades() -> void:
		var r := Proc.rng(seedv, "cover:blades")
		var total := clampi(int(strip_w * 1.05 * density * _lod_mult()),
			24, ProcFoliage._MAX_BLADES)
		var n_back := int(float(total) * 0.55)
		var n_front := total - n_back
		var n_clumps := maxi(2, int(strip_w / 110.0))
		var clumps := PackedFloat32Array()
		for i in range(n_clumps):
			clumps.append((r.randf() - 0.5) * strip_w * 0.96)
		var back_mat := _make_mat(4.6, 1.35)
		var front_mat := _make_mat(6.4, 1.7)
		var mm_back := _make_mmi(ProcFoliage._blade_mesh_res(), n_back, back_mat, 0)
		var mm_front := _make_mmi(ProcFoliage._blade_mesh_res(), n_front, front_mat, 2)
		_fill_blades(mm_back, r, clumps, n_back, -2.0, 0.82)
		_fill_blades(mm_front, r, clumps, n_front, 0.5, 1.0)

	func _fill_blades(mm: MultiMesh, r: RandomNumberGenerator,
			clumps: PackedFloat32Array, count: int, y_bias: float, h_mul: float) -> void:
		var half := strip_w * 0.5
		for i in range(count):
			var x: float
			if r.randf() < 0.7 and clumps.size() > 0:
				var ci := r.randi() % clumps.size()
				x = clumps[ci] + (r.randf() + r.randf() - 1.0) * 58.0
			else:
				x = (r.randf() - 0.5) * strip_w
			x = clampf(x, -half, half)
			var y := _surface_y(x) + y_bias + r.randf_range(-1.5, 1.5)
			var rot := r.randf_range(-0.14, 0.14)
			var sx := r.randf_range(2.0, 3.4)
			var sy := r.randf_range(9.0, 22.0) * height_mul * h_mul
			# Occasional pale seed-head stalk for texture variety.
			var seedhead := r.randf() < 0.045
			if seedhead:
				sy *= 1.7
				sx *= 0.8
			mm.set_instance_transform_2d(i, Transform2D(rot, Vector2(x, y)))
			var jv := r.randf_range(0.88, 1.1)
			var jh := r.randf_range(-0.05, 0.05)
			var vari := Color(
				clampf(jv + jh, 0.5, 1.4),
				clampf(jv, 0.5, 1.4),
				clampf(jv - jh * 0.6, 0.5, 1.4), 1.0)
			if seedhead:
				vari = Color(1.22, 1.16, 0.92, 1.0)
			mm.set_instance_color(i, vari)
			mm.set_instance_custom_data(i, Color(r.randf(), x / strip_w + 0.5, sx, sy))

	func _build_clover() -> void:
		if not want_clover or lod >= 2:
			return
		var r := Proc.rng(seedv, "cover:clover")
		var count := clampi(int(strip_w / 26.0 * density * _lod_mult()), 4, 220)
		_clover_mat = _make_mat(2.2, 1.1)
		var mm := _make_mmi(ProcFoliage._clover_mesh_res(), count, _clover_mat, 1)
		var half := strip_w * 0.5
		var n_patch := maxi(1, int(float(count) / 9.0))
		var patches := PackedFloat32Array()
		for i in range(n_patch):
			patches.append((r.randf() - 0.5) * strip_w * 0.9)
		for i in range(count):
			var pi := r.randi() % patches.size()
			var x := clampf(patches[pi] + (r.randf() + r.randf() - 1.0) * 34.0, -half, half)
			var y := _surface_y(x) + r.randf_range(-0.5, 1.5)
			var s := r.randf_range(7.0, 12.0)
			mm.set_instance_transform_2d(i, Transform2D(r.randf_range(-0.2, 0.2), Vector2(x, y)))
			var jv := r.randf_range(0.85, 1.08)
			mm.set_instance_color(i, Color(jv * 0.94, jv, jv * 0.9, 1.0))
			mm.set_instance_custom_data(i, Color(r.randf(), x / strip_w + 0.5, s, s))

	func _build_flowers() -> void:
		if not want_flowers or lod >= 2:
			return
		var r := Proc.rng(seedv, "cover:flowers")
		var count := clampi(int(strip_w / 42.0 * density * _lod_mult()), 3, 120)
		_flower_mat = _make_mat(3.6, 1.45)
		var mm := _make_mmi(ProcFoliage._flower_mesh_res(), count, _flower_mat, 3)
		var half := strip_w * 0.5
		var tints := _flower_tints()
		for i in range(count):
			var x := (r.randf() - 0.5) * strip_w * 0.96
			x = clampf(x, -half, half)
			var y := _surface_y(x) + r.randf_range(-0.5, 1.0)
			var s := r.randf_range(10.0, 16.0)
			mm.set_instance_transform_2d(i, Transform2D(r.randf_range(-0.16, 0.16), Vector2(x, y)))
			var tc: Color = tints[r.randi() % tints.size()]
			var jv := r.randf_range(0.92, 1.06)
			mm.set_instance_color(i, Color(tc.r * jv, tc.g * jv, tc.b * jv, 1.0))
			mm.set_instance_custom_data(i, Color(r.randf(), x / strip_w + 0.5, s, s * r.randf_range(1.0, 1.25)))

	func _flower_tints() -> Array:
		var a := ProcFoliage.season_shift(accent_col, season)
		var soft := Color(0.97, 0.95, 0.92)
		var warm := Color.from_hsv(fposmod(a.h + 0.08, 1.0), a.s * 0.8, minf(1.0, a.v + 0.12))
		var cool := Color.from_hsv(fposmod(a.h - 0.1, 1.0), a.s * 0.65, minf(1.0, a.v + 0.08))
		if season == "winter":
			return [soft, soft.darkened(0.06), cool]
		return [soft, a.lightened(0.18), warm, cool]

	# Pebbles + the soil contact band: cached polygons, drawn in _draw.
	func _build_ground_detail(lc: Dictionary) -> void:
		_pebbles.clear()
		var r := Proc.rng(seedv, "cover:ground")
		var half := strip_w * 0.5
		# Soil contact band — grounds the blade roots in one translucent strip.
		var step := 24.0
		var n := maxi(3, int(strip_w / step))
		var top := PackedVector2Array()
		var bot := PackedVector2Array()
		for i in range(n + 1):
			var x := -half + strip_w * float(i) / float(n)
			var sy := _surface_y(x)
			top.append(Vector2(x, sy - 1.0))
			bot.append(Vector2(x, sy + 5.0))
		_soil_pts = PackedVector2Array()
		_soil_pts.append_array(top)
		var rev := PackedVector2Array()
		for i in range(bot.size() - 1, -1, -1):
			rev.append(bot[i])
		_soil_pts.append_array(rev)
		_rebuild_soil_cols(lc)
		# Pebbles.
		if not want_pebbles:
			return
		var divisor := 55.0 if lod < 2 else 90.0
		var count := clampi(int(strip_w / divisor * density), 2, 80)
		for i in range(count):
			var x := (r.randf() - 0.5) * strip_w * 0.98
			x = clampf(x, -half, half)
			var y := _surface_y(x) + r.randf_range(0.0, 2.0)
			var rad := r.randf_range(2.2, 6.5)
			var stone := Color.from_hsv(base_col.h, base_col.s * 0.18,
				0.50 + r.randf() * 0.22)
			var raw := Proc.blob(seedv, "peb:%d" % i, rad, 7, 0.18)
			var pts := PackedVector2Array()
			for p in raw:
				pts.append(Vector2(x + p.x, y - rad * 0.45 + p.y * 0.58))
			if pts.size() < 3:
				continue
			var sh := PackedVector2Array()
			for k in range(10):
				var a := TAU * float(k) / 10.0
				sh.append(Vector2(x + cos(a) * rad * 1.05, y + 0.6 + sin(a) * rad * 0.22))
			var peb := {
				"base": stone, "pts": pts, "sh_pts": sh,
				"hi_c": Vector2(x - rad * 0.2, y - rad * 0.75),
				"hi_r": rad * 0.55,
				"cols": PackedColorArray(), "hi_col": Color.WHITE,
				"sh_col": Color(0, 0, 0, 0.14),
			}
			_recolor_pebble(peb, lc)
			_pebbles.append(peb)

	func _rebuild_soil_cols(lc: Dictionary) -> void:
		var sp := ProcFoliage.shade_pair(_base_eff, lc)
		var shade: Color = sp["shade"]
		var dark := ProcFoliage.fog_tint(shade.darkened(0.45), depth_d, horizon_col)
		_soil_top = Color(dark.r, dark.g, dark.b, 0.22)
		var n := _soil_pts.size()
		_soil_cols = PackedColorArray()
		var half_n := int(float(n) * 0.5)
		for i in range(n):
			_soil_cols.append(_soil_top if i < half_n else Color(dark.r, dark.g, dark.b, 0.0))

	func _recolor_pebble(peb: Dictionary, lc: Dictionary) -> void:
		var stone: Color = peb["base"]
		var sp := ProcFoliage.shade_pair(stone, lc)
		var raw_lit: Color = sp["lit"]
		var raw_shd: Color = sp["shade"]
		var lit := ProcFoliage.fog_tint(raw_lit, depth_d, horizon_col)
		var shd := ProcFoliage.fog_tint(raw_shd, depth_d, horizon_col)
		var pts: PackedVector2Array = peb["pts"]
		peb["cols"] = Proc.grad_fill(pts, lit, shd)
		peb["hi_col"] = Color(lit.lightened(0.18), 0.5)

	# Palette → shader uniforms (reshade path too: uniforms only, no rebuilds).
	func _apply_palette(lc: Dictionary) -> void:
		var sp := ProcFoliage.shade_pair(_base_eff, lc)
		var lit: Color = sp["lit"]
		var shd: Color = sp["shade"]
		var root := ProcFoliage.fog_tint(shd.darkened(0.25), depth_d, horizon_col)
		var tip := ProcFoliage.fog_tint(lit.lerp(accent_col, 0.08), depth_d, horizon_col)
		var sun_c: Color = lc.get("sun_color", Color.WHITE)
		var petal := ProcFoliage.fog_tint(Color.WHITE.lerp(sun_c, 0.1), depth_d, horizon_col)
		for i in range(_mats.size()):
			var m := _mats[i]
			if m == _flower_mat:
				# Flowers: green root (stem), near-white tip so petal vertex /
				# instance colors read true; both still fogged + lit.
				m.set_shader_parameter(&"u_root_col", root.lerp(tip, 0.3))
				m.set_shader_parameter(&"u_tip_col", petal)
			elif m == _clover_mat:
				m.set_shader_parameter(&"u_root_col", root)
				m.set_shader_parameter(&"u_tip_col", tip.lerp(Color(0.85, 1.0, 0.85), 0.2))
			else:
				m.set_shader_parameter(&"u_root_col", root)
				m.set_shader_parameter(&"u_tip_col", tip)

	func _push_presses() -> void:
		var arr := PackedVector3Array()
		for pid: String in _presses.keys():
			var pv: Vector3 = _presses[pid]
			arr.append(pv)
			if arr.size() >= ProcFoliage._MAX_PRESS:
				break
		for m in _mats:
			m.set_shader_parameter(&"u_press", arr)
			m.set_shader_parameter(&"u_press_count", arr.size())

	func _push_grow() -> void:
		var gg := g()
		var grow := 0.12 + 0.88 * gg
		var bloom := clampf((gg - 0.4) / 0.45, 0.0, 1.0)
		for m in _mats:
			m.set_shader_parameter(&"u_grow", grow)
		if _flower_mat != null:
			_flower_mat.set_shader_parameter(&"u_alpha", bloom)
		if _clover_mat != null:
			_clover_mat.set_shader_parameter(&"u_alpha", clampf((gg - 0.2) / 0.5, 0.0, 1.0))

	# -- runtime -------------------------------------------------------------

	func _animate(delta: float) -> void:
		if lod >= 2 and (Engine.get_process_frames() & 1) == 1:
			return   # back rows animate at half rate (§6)
		# Wind: a slow gust envelope over the base strength; waves travel across
		# the strip because each blade's phase is keyed to its x (in the shader).
		var gust := wind * (0.78 + 0.18 * sin(t * 0.21 + phase) + 0.07 * sin(t * 1.63 + phase * 2.1))
		for m in _mats:
			m.set_shader_parameter(&"u_t", t)
			m.set_shader_parameter(&"u_wind", gust)
		_lv_timer += delta
		if _lv_timer >= 0.25:
			_lv_timer = 0.0
			var lv := ProcFoliage.light_version()
			if lv != _lit_version:
				_lit_version = lv
				_reshade()

	func _reshade() -> void:
		var lc := ProcFoliage.light_ctx()
		if not horizon_set:
			horizon_col = lc.get("horizon", horizon_col)
		_apply_palette(lc)
		_rebuild_soil_cols(lc)
		for entry in _pebbles:
			var peb: Dictionary = entry
			_recolor_pebble(peb, lc)
		queue_redraw()

	func _on_growth() -> void:
		_push_grow()

	func _draw() -> void:
		if _soil_pts.size() >= 3 and _soil_cols.size() == _soil_pts.size():
			draw_polygon(_soil_pts, _soil_cols)
		for entry in _pebbles:
			var peb: Dictionary = entry
			var sh: PackedVector2Array = peb["sh_pts"]
			var sh_col: Color = peb["sh_col"]
			if sh.size() >= 3:
				draw_colored_polygon(sh, sh_col)
			var pts: PackedVector2Array = peb["pts"]
			var cols: PackedColorArray = peb["cols"]
			if pts.size() >= 3 and cols.size() == pts.size():
				draw_polygon(pts, cols)
			var hr: float = peb["hi_r"]
			var hc: Vector2 = peb["hi_c"]
			var hi_col: Color = peb["hi_col"]
			if hr > 0.8:
				draw_arc(hc, hr, -2.6, -0.7, 8, hi_col, 1.3, true)
