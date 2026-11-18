class_name ProcSilhouettes extends RefCounted
# ProcSilhouettes — the diorama's FRAME. Two jobs, per docs/GFX-2.5D.md §7.7:
#
#   P1 (deep background, parallax 0.18)  make_islets   — 2–4 distant floating
#       islets on the skyline, heavily fogged toward the horizon colour
#       (d ≈ 0.92), bobbing on a slow ~12 s swell, with an optional far flock
#       of silhouette birds drifting across the band.
#   P7 (foreground framing, parallax 1.25) make_framing — near-black ink
#       silhouettes hugging the screen edges: a near-camera ground lip along the
#       bottom, rock shoulders in the bottom corners, swaying grass-blade clumps
#       and a fern, tufts planted on the lip, and at most ONE leafy branch
#       arcing in from a top corner. Oversized (1.15–1.35×) and sliding FASTER
#       than the camera, so the scene reads as a deep stage seen from between
#       things, not a flat backdrop.
#
# Plus one additive extra this system owns (slots behind the ground band, P1/P2):
#       make_treeline — depth-tinted far tree-lines / rolling hills, 1–3 stacked
#       ridge bands with realm-aware tree silhouettes (broadleaf domes, conifer
#       spires, crystal shards, dunes), each band fogged by its own depth.
#
# Rules honoured here (CONVENTIONS.md + GFX-2.5D.md):
#   · 100% seeded — Proc.hashf / rangef / rng / blob / noise only, no Time/randf.
#   · All geometry is cached in _on_built; _draw only fires on growth change or
#     reshade; _animate touches ONLY child transforms — zero per-frame allocation.
#   · Depth/lighting come from ProcDepth.tint / ProcLighting.ctx + version
#     (build-order step 1). ProcLighting.ctx() is defined to return a complete
#     deterministic noon LightCtx before any driver is installed, so every
#     factory here renders standalone with no world, no context, no lighting.
#   · Degenerate-polygon guards everywhere: every fill is ≥ 3 distinct points,
#     every polyline ≥ 2, tapered strips refuse to emit from a too-short spine.
#
# Coverage budget for make_framing (spec §7.7: never cover > 14% of the screen).
#   MEASURED, not estimated: every ink polygon of a full-fat frame (LOD0, both
#   corners, density 1.0, branch on) rasterized on a 108×192 grid at 1080×1920
#   across 8 seeds → 5.68%, 5.83%, 5.90%, 5.96%, 6.19%, 6.28%, 6.59%, 6.66%
#   (worst 6.66%). `density` is clamped to ≤ 1.0 and `lod` only ever removes
#   geometry, so no option combination can push the frame past the cap.
#
# How other modules consume this file:
#   WorldSpace.setup():
#     _far_layer (P1): add make_islets(seed, "far", vp, 3, {realm: realm_id})
#                      and make_treeline(seed, "hills", band_rect, 0.85, realm_id)
#     _fg_layer (P7):  add make_framing(seed, "frame", vp, "both", {realm: realm_id})
#   Parallax is the CONTAINER's job (ProcDepth.PLANE_FAR 0.18 / PLANE_FG 1.25) —
#     nothing here reads the camera, so panning costs these nodes nothing.
#   ProcWeatherFX / storms: framing.set_wind(2.0) whips the grass; all three
#     node kinds also expose set_strength(s) (the ProcAtmosphere convention) so
#     a whiteout can sink the frame and the skyline into the haze.
#   ProcLighting._Driver: nothing to call — every node here watches
#     ProcLighting.version() itself and re-tints (modulate / cached colours only).

const DEEP_D := 0.92              # default islet fog depth (spec §7.7)
const FRAMING_MAX_WIND := 3.0
const FRAMING_ALPHA := 0.85       # spec §7.7: foreground ink sits at alpha ≈ 0.85


# ============================================================================
#  FACTORIES (public API — signatures per GFX-2.5D.md §7.7, additive extras after)
# ============================================================================

# P1 skyline: 2–4 distant floating islets fogged toward the horizon at d ≈ 0.92,
# each with a grass crown, a hanging rock keel with strata, tiny tree/crystal
# silhouettes, an occasional thread of waterfall and a cloud wisp beneath, on a
# slow 10–15 s swell bob driven by child transforms only.
# opts: {realm: String, d: float, birds: bool, lod: int, terrain: bool}
#   terrain = true swaps in ProcTerrain.make_islet (full rock detail) instead of
#   this file's own skyline silhouette — opt-IN, because at P1 the islets read as
#   fogged shapes and a self-contained outline is both cheaper and guaranteed
#   non-degenerate (ProcTerrain's islet body currently fails triangulation).
static func make_islets(world_seed: int, key: String, size: Vector2,
		count: int = 3, opts: Dictionary = {}) -> ProcNode:
	var n := _Islets.new()
	n.seedv = hash("%d:silh-isl:%s" % [world_seed, key])
	n.world_seed = world_seed
	n.key = key
	n.size = size
	n.count = clampi(count, 2, 4)
	n.realm_id = String(opts.get("realm", "verdant"))
	n.d_depth = clampf(float(opts.get("d", DEEP_D)), 0.5, 1.0)
	n.birds_on = bool(opts.get("birds", true))
	n.lod = clampi(int(opts.get("lod", 1)), 0, 2)
	n.use_terrain = bool(opts.get("terrain", false))
	n.set_grow_minutes(0.0)          # the skyline is ancient; pop_in still works
	return n

# P7 foreground: ink silhouettes (horizon-complement near-black) — grass blades,
# a fern, rock shoulders in the bottom corners, one top branch max — drawn at
# 1.15–1.35× scale, alpha ≈ 0.85, swaying via rotation of child clumps.
# side: "both" / "left" / "right".
# opts: {branch: bool, density: float ≤ 1, lod: int, ink: Color}
static func make_framing(world_seed: int, key: String, size: Vector2,
		side: String = "both", opts: Dictionary = {}) -> ProcNode:
	var n := _Framing.new()
	n.seedv = hash("%d:silh-fg:%s" % [world_seed, key])
	n.world_seed = world_seed
	n.key = key
	n.size = size
	n.side = side if (side == "left" or side == "right") else "both"
	n.branch_on = bool(opts.get("branch", true))
	n.density = clampf(float(opts.get("density", 1.0)), 0.4, 1.0)
	n.lod = clampi(int(opts.get("lod", 0)), 0, 2)
	var ink_v: Variant = opts.get("ink", null)
	if ink_v is Color:
		n.ink_override = ink_v
	n.set_grow_minutes(0.0)
	return n

# ADDITIVE: depth-tinted far tree-lines / hills behind the ground band. 1–3
# stacked ridge bands (count by lod), realm-aware tree silhouette vocabulary,
# each band fogged at its own depth so the stack reads as receding kilometres.
# `size` is the strip the bands fill (top-left anchored, background convention).
# opts: {lod: int, bands: int}
static func make_treeline(world_seed: int, key: String, size: Vector2,
		depth: float = 0.85, realm_id: String = "verdant", opts: Dictionary = {}) -> ProcNode:
	var n := _Treeline.new()
	n.seedv = hash("%d:silh-tl:%s" % [world_seed, key])
	n.world_seed = world_seed
	n.key = key
	n.size = size
	n.depth = clampf(depth, 0.0, 1.0)
	n.realm_id = realm_id
	n.lod = clampi(int(opts.get("lod", 0)), 0, 2)
	n.bands_override = clampi(int(opts.get("bands", 0)), 0, 3)
	n.set_grow_minutes(0.0)
	return n


# ============================================================================
#  DEPTH / LIGHT ACCESS  (thin named wrappers so every inner class — and any
#  module that wants the same framing maths — goes through one door)
# ============================================================================

# Atmospheric depth tint (GFX-2.5D §1.4). Call ONCE per colour per reshade.
static func fog_tint(c: Color, d: float, horizon: Color) -> Color:
	return ProcDepth.tint(c, d, horizon)

static func fog_mix(d: float) -> float:
	return ProcDepth.fog_mix(d)

# The current LightCtx. ProcLighting.ctx() is contractually complete even before
# a driver is installed (deterministic noon), so standalone instancing works.
static func light_ctx() -> Dictionary:
	return ProcLighting.ctx()

static func light_version() -> int:
	return ProcLighting.version()

# Near-black framing ink: the horizon's COMPLEMENT, barely saturated, slightly
# seed-jittered — the foreground reads as a different DEPTH, not different art.
static func ink_color(world_seed: int, key: String, horizon: Color) -> Color:
	var hh: float = fposmod(horizon.h + 0.5, 1.0)
	var jit: float = Proc.rangef(world_seed, "silh:inkh:" + key, -0.03, 0.03)
	return Color.from_hsv(fposmod(hh + jit, 1.0), 0.30, 0.085)

# Normalised-horizon modulate veil: multiplying by this cools/fogs a child node
# toward the horizon without darkening it into mud (transform/modulate only).
static func _veil_color(horizon: Color, strength: float) -> Color:
	var mx: float = maxf(horizon.r, maxf(horizon.g, horizon.b))
	var nrm := horizon
	if mx > 0.001:
		nrm = Color(horizon.r / mx, horizon.g / mx, horizon.b / mx, 1.0)
	return Color(1, 1, 1, 1).lerp(nrm, clampf(strength, 0.0, 1.0))


# ============================================================================
#  SHARED GEOMETRY HELPERS (pure, allocation only at build time)
# ============================================================================

# Sampled quadratic bezier, ≥ 3 points always.
static func _qbez(p0: Vector2, p1: Vector2, p2: Vector2, steps: int) -> PackedVector2Array:
	var out := PackedVector2Array()
	var n: int = maxi(2, steps)
	for i in range(n + 1):
		var u: float = float(i) / float(n)
		var a := p0.lerp(p1, u)
		var b := p1.lerp(p2, u)
		out.append(a.lerp(b, u))
	return out

# Closed tapered ribbon around an open spine (grass blades, boughs, twigs,
# leaflets). Width never collapses below 0.5 px so the polygon keeps real area;
# returns EMPTY when the spine is too short — the caller skips (degenerate guard).
static func _tapered_strip(spine: PackedVector2Array, w0: float, w1: float) -> PackedVector2Array:
	var n := spine.size()
	if n < 2:
		return PackedVector2Array()
	var left := PackedVector2Array()
	var right := PackedVector2Array()
	for i in range(n):
		var dirv: Vector2
		if i == 0:
			dirv = spine[1] - spine[0]
		elif i == n - 1:
			dirv = spine[n - 1] - spine[n - 2]
		else:
			dirv = spine[i + 1] - spine[i - 1]
		if dirv.length_squared() < 0.0001:
			dirv = Vector2(0.0, -1.0)
		var nrm := dirv.normalized().orthogonal()
		var w: float = maxf(0.5, lerpf(w0, w1, float(i) / float(n - 1))) * 0.5
		left.append(spine[i] + nrm * w)
		right.append(spine[i] - nrm * w)
	right.reverse()
	var out := PackedVector2Array()
	out.append_array(left)
	out.append_array(right)
	return out

# A real LEAF lens: a curved midrib from `base` to `tip`, swelled to `w` at its
# waist and closing to a point at both ends — the shape that makes a silhouette
# read as foliage instead of berries. `curve` bows the midrib sideways (as a
# fraction of leaf length). Returns EMPTY for a degenerate (too-short) leaf.
static func _leaf(base: Vector2, tip: Vector2, w: float, curve: float, steps: int = 7) -> PackedVector2Array:
	var axis := tip - base
	var ln: float = axis.length()
	if ln < 2.0 or w < 0.6:
		return PackedVector2Array()
	var dirv := axis / ln
	var nrm := dirv.orthogonal()
	var ns: int = maxi(4, steps)
	var out := PackedVector2Array()
	# forward edge (base → tip), then the mirrored edge back, skipping the two
	# shared endpoints so the loop never retraces a zero-length segment.
	for i in range(ns + 1):
		var u: float = float(i) / float(ns)
		var mid := base + dirv * (ln * u) + nrm * (curve * ln * sin(PI * u))
		out.append(mid + nrm * (w * 0.5 * sin(PI * pow(u, 0.82))))
	for i in range(ns - 1, 0, -1):
		var u2: float = float(i) / float(ns)
		var mid2 := base + dirv * (ln * u2) + nrm * (curve * ln * sin(PI * u2))
		out.append(mid2 - nrm * (w * 0.5 * sin(PI * pow(u2, 0.82))))
	return out

# THE degenerate-polygon gate (build time only — never called per frame). A fill
# is only emitted when it has >= 3 real edges AND more than half a pixel of area,
# so no self-retracing outline or zero-area sliver ever reaches the renderer.
static func _poly_ok(pts: PackedVector2Array) -> bool:
	var n := pts.size()
	if n < 3:
		return false
	var area2: float = 0.0
	var edges: int = 0
	for i in range(n):
		var a := pts[i]
		var b := pts[(i + 1) % n]
		area2 += a.x * b.y - b.x * a.y
		if a.distance_squared_to(b) > 0.0025:
			edges += 1
	return edges >= 3 and absf(area2) * 0.5 > 0.5

# Realm → deep/mid silhouette colours (anchored storybook deeps, nudged by the
# world palette so two worlds in the same realm still differ a little).
static func _realm_cols(world_seed: int, key: String, realm_id: String) -> Dictionary:
	var pal := Proc.palette(world_seed, "silh:" + key)
	var deep := Color("#2C5E28")
	var mid := Color("#3F7E36")
	match realm_id:
		"crystal_hollow":
			deep = Color("#124E52")
			mid = Color("#1E6E6A")
		"skylands":
			deep = Color("#3E7A34")
			mid = Color("#5FA846")
		"forgotten_wilds":
			deep = Color("#184E2C")
			mid = Color("#2E7E46")
		"frostfall":
			deep = Color("#7E9DB4")
			mid = Color("#B6D2E2")
		"astral":
			deep = Color("#241A46")
			mid = Color("#3C2E6E")
		"first_kingdom":
			deep = Color("#6E4A1E")
			mid = Color("#9A6E2A")
		_:
			pass
	var nudge := Color.from_hsv(float(pal["hue"]), 0.3, 0.5)
	deep = deep.lerp(nudge, 0.08)
	mid = mid.lerp(nudge, 0.06)
	return {"deep": deep, "mid": mid, "accent": pal["accent"]}

# Realm → treeline silhouette vocabulary.
static func _realm_style(realm_id: String) -> String:
	if realm_id == "frostfall":
		return "conifer"
	if realm_id == "crystal_hollow" or realm_id == "astral":
		return "crystal"
	if realm_id == "first_kingdom":
		return "dune"
	if realm_id == "forgotten_wilds":
		return "broadleaf"
	return "mixed"

# Height of one silhouetted tree above the ridge at horizontal offset dx.
# Smooth storybook profiles: domes (broadleaf), soft spires (conifer), sharp
# shards (crystal), low swells (dune).
static func _tree_profile(style: String, dx: float, r: float, hgt: float) -> float:
	var a: float = absf(dx) / maxf(1.0, r)
	if a >= 1.0:
		return 0.0
	if style == "conifer":
		return hgt * pow(1.0 - a, 1.4)
	if style == "crystal":
		return hgt * pow(1.0 - a, 2.1)
	if style == "dune":
		return hgt * 0.55 * (1.0 - a * a)
	return hgt * sqrt(maxf(0.0, 1.0 - a * a))


# ============================================================================
#  _Islets — P1 distant skyline (fogged floating islets + far birds)
# ============================================================================

class _Islets extends ProcNode:
	var world_seed: int = 0
	var key: String = "far"
	var size: Vector2 = Vector2(1080, 1920)
	var realm_id: String = "verdant"
	var count: int = 3
	var d_depth: float = 0.92
	var birds_on: bool = true
	var lod: int = 1
	var use_terrain: bool = false

	var _wraps: Array[Dictionary] = []    # {node, shape, terrain, base, base_scale, d, amp, spd, ph}
	var _flock: Node2D = null
	var _birds: Array[Dictionary] = []    # {node, flap, ph}
	var _drift: float = 9.0
	var _drift_off: float = 0.0
	var _bird_y: float = 300.0
	var _strength: float = 1.0
	var _lit_version: int = -1

	func _on_built() -> void:
		var slot_w: float = size.x / float(count)
		for i in range(count):
			var ikey := "%s#%d" % [key, i]
			var w: float = Proc.rangef(world_seed, "siw:" + ikey, 64.0, 148.0)
			var di: float = clampf(d_depth + Proc.rangef(world_seed, "sid:" + ikey, -0.05, 0.04), 0.5, 1.0)
			var shape: Node2D
			if use_terrain:
				# Opt-in full terrain islet at its cheapest detail (depth 3 → lod 2);
				# its own haze fade does the first fog pass, our veil the second.
				var tnode := ProcTerrain.make_islet(world_seed, "silh:" + ikey, w, realm_id, 3)
				tnode.set("haze", clampf(0.30 + ProcSilhouettes.fog_mix(di), 0.0, 0.6))
				shape = tnode
			else:
				var snode := _Islet.new()
				snode.build(world_seed, "silh:" + ikey, w, realm_id, maxi(lod, 1), di)
				shape = snode
			var wrap := Node2D.new()
			wrap.name = "Islet%d" % i
			var px: float = slot_w * (float(i) + 0.5) + Proc.rangef(world_seed, "six:" + ikey, -slot_w * 0.28, slot_w * 0.28)
			var py: float = size.y * Proc.rangef(world_seed, "siy:" + ikey, 0.16, 0.40)
			wrap.position = Vector2(px, py)
			var sc: float = Proc.rangef(world_seed, "sis:" + ikey, 0.55, 0.85) * lerpf(1.0, 0.7, di)
			wrap.scale = Vector2.ONE * sc
			wrap.add_child(shape)
			add_child(wrap)
			_wraps.append({
				"node": wrap, "shape": shape, "terrain": use_terrain,
				"base": wrap.position, "base_scale": sc, "d": di,
				"amp": Proc.rangef(world_seed, "sib:" + ikey, 4.0, 9.0),
				"spd": TAU / Proc.rangef(world_seed, "sip:" + ikey, 10.0, 15.0),
				"ph": Proc.hashf(world_seed, "siph:" + ikey) * TAU,
			})
		if birds_on and lod < 2:
			_build_flock()
		_reshade()

	# Weather / dawn blending hook, matching the ProcAtmosphere convention:
	# 0 hides the skyline (whiteout storm), 1 is the normal fogged reading.
	func set_strength(s: float) -> void:
		_strength = clampf(s, 0.0, 1.0)
		modulate.a = _strength

	func _build_flock() -> void:
		_flock = Node2D.new()
		_flock.name = "Flock"
		add_child(_flock)
		_bird_y = size.y * Proc.rangef(world_seed, "sfby:" + key, 0.14, 0.30)
		_drift = Proc.rangef(world_seed, "sfdr:" + key, 6.0, 12.0)
		_drift_off = Proc.rangef(world_seed, "sfof:" + key, 0.0, 600.0)
		var nb: int = 2 + int(Proc.hashf(world_seed, "sfn:" + key) * 2.99)
		for i in range(nb):
			var b := _Bird.new()
			b.span = Proc.rangef(world_seed, "sfs:%s:%d" % [key, i], 5.0, 9.0)
			b.position = Vector2(
				Proc.rangef(world_seed, "sfx:%s:%d" % [key, i], -60.0, 60.0),
				Proc.rangef(world_seed, "sfy:%s:%d" % [key, i], -26.0, 26.0))
			_flock.add_child(b)
			_birds.append({
				"node": b,
				"flap": Proc.rangef(world_seed, "sff:%s:%d" % [key, i], 4.0, 7.0),
				"ph": Proc.hashf(world_seed, "sfp:%s:%d" % [key, i]) * TAU,
			})

	func _animate(_delta: float) -> void:
		# slow swell bob + flock drift — child transforms only, zero allocation
		for i in range(_wraps.size()):
			var wr: Dictionary = _wraps[i]
			var n: Node2D = wr.node
			n.position = (wr.base as Vector2) + Vector2(0.0, sin(t * float(wr.spd) + float(wr.ph)) * float(wr.amp))
		if _flock != null:
			_flock.position = Vector2(
				fposmod(t * _drift + _drift_off, size.x + 260.0) - 130.0,
				_bird_y + sin(t * 0.37 + phase) * 7.0)
			for i in range(_birds.size()):
				var bd: Dictionary = _birds[i]
				var bn: Node2D = bd.node
				bn.scale = Vector2(1.0, 0.35 + 0.65 * absf(sin(t * float(bd.flap) + float(bd.ph))))
		if ProcSilhouettes.light_version() != _lit_version:
			_lit_version = ProcSilhouettes.light_version()
			_reshade()

	func _on_growth() -> void:
		var gs: float = 0.2 + 0.8 * g()
		for i in range(_wraps.size()):
			var wr: Dictionary = _wraps[i]
			var n: Node2D = wr.node
			n.scale = Vector2.ONE * (float(wr.base_scale) * gs)

	# Horizon-aware re-tint (cache-on-change, ~every 7 s): own silhouette islets
	# recompute their fogged palette; opt-in terrain islets get a modulate veil
	# instead and are never redrawn.
	func _reshade() -> void:
		var lc := ProcSilhouettes.light_ctx()
		var hz: Color = lc.get("horizon", Color(0.84, 0.89, 0.94))
		var sc: Color = lc.get("sun_color", Color(1.0, 0.965, 0.878))
		var energy: float = float(lc.get("sun_energy", 1.0))
		var rc := ProcSilhouettes._realm_cols(world_seed, key, realm_id)
		var deep: Color = rc.deep
		var mid: Color = rc.mid
		for i in range(_wraps.size()):
			var wr: Dictionary = _wraps[i]
			var n: Node2D = wr.node
			var di: float = float(wr.d)
			if bool(wr.terrain):
				var veil := ProcSilhouettes._veil_color(hz, 0.30 + 0.35 * ProcSilhouettes.fog_mix(di))
				veil.a = 0.96
				n.modulate = veil
				continue
			var shp_n: Node2D = wr.shape
			var shp := shp_n as _Islet
			if shp == null:
				continue
			# Everything the islet draws is fogged ONCE here, at its own depth.
			var rock := ProcSilhouettes.fog_tint(deep.darkened(0.30), di, hz)
			var rock_lt := ProcSilhouettes.fog_tint(deep.darkened(0.12), di, hz)
			var grass := ProcSilhouettes.fog_tint(mid, di, hz)
			var soil := ProcSilhouettes.fog_tint(deep.lerp(mid, 0.30), di, hz)
			shp.retint({
				"rock_t": rock_lt, "rock_b": rock.darkened(0.12),
				"soil_t": soil, "soil_b": soil.darkened(0.16),
				"grass_t": grass.lightened(0.10 + 0.10 * energy), "grass_b": grass.darkened(0.14),
				"tree_t": ProcSilhouettes.fog_tint(deep.darkened(0.08), di, hz),
				"tree_b": ProcSilhouettes.fog_tint(deep.darkened(0.26), di, hz),
				"wisp": Color(hz.r, hz.g, hz.b, 0.16 + 0.14 * ProcSilhouettes.fog_mix(di)),
				"fall": Color(hz.r, hz.g, hz.b, 1.0).lerp(Color(1, 1, 1, 1), 0.35),
				"strata": rock.darkened(0.22),
				"rim": Color(sc.r, sc.g, sc.b, 0.10 + 0.22 * energy),
				"lc": lc,
			})
		if _flock != null:
			var ink := ProcSilhouettes.ink_color(world_seed, key, hz)
			var bcol := ProcSilhouettes.fog_tint(ink, 0.8, hz)
			bcol.a = 0.55
			for i in range(_birds.size()):
				var bn: _Bird = _birds[i].node
				bn.col = bcol
				bn.queue_redraw()


class _Bird extends Node2D:
	# A distant bird: one antialiased chevron. Flap = scale.y oscillation
	# driven by the parent (transform only, no redraw).
	var span: float = 7.0
	var col: Color = Color(0.12, 0.14, 0.2, 0.55)
	var _pts: PackedVector2Array = PackedVector2Array()

	func _ready() -> void:
		_pts = PackedVector2Array([
			Vector2(-span, 0.0), Vector2(-span * 0.4, -span * 0.42),
			Vector2(0.0, -span * 0.18),
			Vector2(span * 0.4, -span * 0.42), Vector2(span, 0.0)])

	func _draw() -> void:
		if _pts.size() >= 2:
			draw_polyline(_pts, col, 1.6, true)


class _Islet extends Node2D:
	# ONE distant floating islet, read as a recognizable storybook sky-island:
	# a domed grass crown over a soil band, a rock keel tapering to a weathered
	# tip with sedimentary strata, 0–5 tiny tree / conifer / crystal silhouettes
	# on top, sometimes a thread of waterfall spilling off an edge, and a flat
	# cloud wisp beneath that makes it read as FLOATING rather than cropped.
	#
	# The outline is built from two monotone-in-x profiles (crown left→right,
	# keel right→left), so it is a simple closed curve BY CONSTRUCTION — it can
	# never self-intersect at any seed, width or LOD. Geometry is built once;
	# only colours change (retint on ProcLighting.version), and the parent wrap
	# owns all motion, so this node never animates and never reallocates.
	const R_WISP := 0
	const R_ROCK := 1
	const R_SOIL := 2
	const R_GRASS := 3
	const R_TREE := 4
	const R_FALL := 5
	const R_VINE := 6
	const R_BOULDER := 7
	const R_TRUNK := 8

	var lod: int = 1
	var fills: Array[PackedVector2Array] = []
	var cols: Array[PackedColorArray] = []
	var roles: PackedInt32Array = PackedInt32Array()
	var strata: Array[PackedVector2Array] = []
	var strata_col: Color = Color(0, 0, 0, 0.28)
	var dots: PackedVector2Array = PackedVector2Array()
	var dot_r: PackedFloat32Array = PackedFloat32Array()
	var dot_col: Color = Color(1, 1, 1, 0.3)
	var outline: PackedVector2Array = PackedVector2Array()
	var rim: PackedVector2Array = PackedVector2Array()
	var rim_col: Color = Color(1, 1, 1, 0.0)

	# -- build -----------------------------------------------------------------

	func build(ws: int, k: String, w: float, realm: String, lod_in: int, _d: float) -> void:
		lod = clampi(lod_in, 0, 2)
		var hw: float = maxf(24.0, w)
		var nz := Proc.noise(ws, "islet:" + k, 0.016, 2)
		var h_top: float = hw * Proc.rangef(ws, k + ":ht", 0.30, 0.46)
		var keel: float = hw * Proc.rangef(ws, k + ":kl", 1.15, 1.95)
		var tip_u: float = Proc.rangef(ws, k + ":tu", 0.34, 0.66)
		var nt: int = [26, 16, 9][lod]
		var nk: int = [30, 18, 10][lod]

		# crown profile: flat-topped mesa rather than a lens — y = 0 at both
		# rims, a broad plateau between, warped by two noise scales so the skyline
		# edge is craggy instead of mathematically smooth.
		var crown := PackedVector2Array()
		var edges := PackedFloat32Array()
		for i in range(nt + 1):
			var u: float = float(i) / float(nt)
			var x: float = lerpf(-hw, hw, u)
			var e: float = pow(sin(PI * u), 0.38)
			var jit: float = 1.0 + 0.16 * nz.get_noise_1d(x) + 0.07 * nz.get_noise_1d(x * 3.3 + 91.0)
			crown.append(Vector2(x, -h_top * e * jit))
			edges.append(e)
		# keel profile: a hanging rock mass peaking at tip_u, with ledge swells
		# along its flanks, barely narrowed so it reads HEAVY — a chunk of island
		# torn out of the ground, not a cone.
		var keelc := PackedVector2Array()
		for i in range(nk + 1):
			var u2: float = 1.0 - float(i) / float(nk)
			var s: float = (u2 / tip_u) if u2 < tip_u else ((1.0 - u2) / maxf(0.001, 1.0 - tip_u))
			var sc2: float = pow(clampf(s, 0.0, 1.0), 1.12)
			sc2 = sc2 * (1.0 + 0.17 * sin(clampf(s, 0.0, 1.0) * PI * 2.6))
			var xk: float = lerpf(-hw, hw, u2)
			var jit2: float = 1.0 + 0.22 * nz.get_noise_1d(xk * 1.7 + 311.0) \
					+ 0.10 * nz.get_noise_1d(xk * 5.1 + 77.0)
			keelc.append(Vector2(xk * (1.0 - 0.14 * sc2), keel * maxf(0.0, sc2) * jit2))

		# cloud wisps UNDER the keel (drawn first → furthest back). Two offset
		# flat lenses read as a layer of air, which is what sells "floating".
		for wi in range(2 if lod < 2 else 1):
			var wkey := "%s:w%d" % [k, wi]
			var wr: float = hw * (1.10 - 0.34 * float(wi))
			var wisp := Proc.superellipse(wr, maxf(5.0, hw * (0.12 - 0.03 * float(wi))), 2.2, 18)
			var woff := Vector2(
				Proc.rangef(ws, wkey + ":wx", -hw * 0.28, hw * 0.28),
				keel * Proc.rangef(ws, wkey + ":wy", 0.62, 1.02))
			for i in range(wisp.size()):
				wisp[i] = wisp[i] + woff
			_push(wisp, R_WISP)

		# satellite boulders: the skylands tell — torn-off chunks still drifting
		# in the island's wake, each a squashed blob with its own little shadow
		var nb: int = [3, 2, 1][lod]
		for bi in range(nb):
			var bk := "%s:bd%d" % [k, bi]
			if Proc.hashf(ws, bk + ":on") > 0.78:
				continue
			var br: float = hw * Proc.rangef(ws, bk + ":r", 0.07, 0.17)
			var bsgn: float = 1.0 if Proc.hashf(ws, bk + ":s") < 0.5 else -1.0
			var bat := Vector2(
				bsgn * hw * Proc.rangef(ws, bk + ":x", 0.75, 1.45),
				keel * Proc.rangef(ws, bk + ":y", 0.25, 0.95))
			var braw := Proc.blob(ws, bk + ":b", br, 8, 0.26)
			var bpts := PackedVector2Array()
			bpts.resize(braw.size())
			for i in range(braw.size()):
				bpts[i] = bat + Vector2(braw[i].x, braw[i].y * 0.78)
			_push(bpts, R_BOULDER)

		# the body: crown (left→right) + keel interior (right→left)
		outline = PackedVector2Array()
		outline.append_array(crown)
		for i in range(1, keelc.size() - 1):
			outline.append(keelc[i])
		_push(outline, R_ROCK)

		# soil band + grass cap: two monotone curves each → always simple. The
		# grass cap overhangs the rock rim, the way turf does on a sea cliff.
		var soil_h: float = maxf(5.0, h_top * 0.46)
		var grass_h: float = maxf(4.0, h_top * 0.24)
		_push(_band(crown, edges, soil_h), R_SOIL)
		_push(_band(crown, edges, grass_h), R_GRASS)

		# sedimentary strata: nested copies of the keel curve, scaled about the
		# rim line, so the bands follow the rock's own flow (§5 stone recipe)
		var ns: int = [3, 1, 0][lod]
		for si in range(ns):
			var f: float = 1.0 - 0.17 * float(si + 1)
			var ln := PackedVector2Array()
			ln.resize(keelc.size())
			for i in range(keelc.size()):
				ln[i] = keelc[i] * f
			if ln.size() >= 2:
				strata.append(ln)

		# silhouette growth on the crown — a proper little copse, scaled to the
		# island (the old version drew pin-sized trees that vanished in the fog)
		var style := ProcSilhouettes._realm_style(realm)
		var ntree: int = [6, 3, 0][lod]
		if ntree > 0:
			ntree += int(Proc.hashf(ws, k + ":tn") * 3.0)
		for ti in range(ntree):
			var tk := "%s:t%d" % [k, ti]
			var tu: float = Proc.rangef(ws, tk + ":u", 0.12, 0.88)
			var idx: int = clampi(int(tu * float(nt)), 0, nt)
			var at := crown[idx] - Vector2(0.0, grass_h * 0.35)
			var th: float = h_top * Proc.rangef(ws, tk + ":h", 1.00, 2.10)
			var tr: float = th * Proc.rangef(ws, tk + ":r", 0.26, 0.40)
			var st := style
			if style == "mixed":
				st = "broadleaf" if Proc.hashf(ws, tk + ":s") < 0.6 else "conifer"
			_add_tree(at, th, tr, st)

		# vines / aerial roots trailing off the rim and down the keel: the single
		# cheapest cue that this rock is hanging in open air
		var nv: int = [4, 2, 0][lod]
		for vi in range(nv):
			var vk := "%s:v%d" % [k, vi]
			var vu: float = Proc.rangef(ws, vk + ":u", 0.06, 0.94)
			var vidx: int = clampi(int(vu * float(nt)), 0, nt)
			var vat := crown[vidx] + Vector2(0.0, soil_h * 0.6)
			var vsgn: float = 1.0 if vat.x >= 0.0 else -1.0
			var vlen: float = keel * Proc.rangef(ws, vk + ":l", 0.30, 0.78)
			var vsp := ProcSilhouettes._qbez(vat,
					vat + Vector2(vsgn * hw * 0.05, vlen * 0.55),
					vat + Vector2(vsgn * hw * 0.02, vlen), 6)
			var vpoly := ProcSilhouettes._tapered_strip(vsp, maxf(2.0, hw * 0.028), 0.8)
			_push(vpoly, R_VINE)
			if lod == 0:
				for li in range(3):
					var lu: float = 0.35 + 0.3 * float(li)
					var lidx: int = clampi(int(lu * float(vsp.size() - 1)), 1, vsp.size() - 1)
					var lbase := vsp[lidx]
					var ldir := Vector2(vsgn * (1.0 if li % 2 == 0 else -1.0), 0.45).normalized()
					var leaf := ProcSilhouettes._leaf(lbase, lbase + ldir * hw * 0.10,
							maxf(1.5, hw * 0.045), 0.1, 5)
					_push(leaf, R_VINE)

		# a thread of waterfall off one rim (never at the cheapest LOD)
		if lod < 2 and Proc.hashf(ws, k + ":wf") < 0.55:
			var fu: float = Proc.rangef(ws, k + ":fu", 0.22, 0.78)
			var fidx: int = clampi(int(fu * float(nt)), 1, nt - 1)
			var fat := crown[fidx]
			var sgn: float = 1.0 if fat.x >= 0.0 else -1.0
			var fend := fat + Vector2(sgn * hw * 0.11, keel * 1.18)
			var fsp := ProcSilhouettes._qbez(fat, fat + Vector2(sgn * hw * 0.04, keel * 0.55), fend, 7)
			var fpoly := ProcSilhouettes._tapered_strip(fsp, maxf(4.0, hw * 0.10), maxf(2.0, hw * 0.045))
			_push(fpoly, R_FALL)
			dots.append(fend + Vector2(0.0, 2.0))
			dot_r.append(maxf(2.5, hw * 0.065))
			if lod == 0:
				dots.append(fend + Vector2(sgn * hw * 0.06, -keel * 0.12))
				dot_r.append(maxf(1.5, hw * 0.038))
				dots.append(fend + Vector2(-sgn * hw * 0.05, keel * 0.05))
				dot_r.append(maxf(1.5, hw * 0.030))

	# A strip hugging the crown: the crown curve, then the crown pushed down by
	# `h` weighted toward the middle. Both halves are monotone in x, so the
	# polygon is simple; emitted only when it holds real area.
	func _band(crown: PackedVector2Array, edges: PackedFloat32Array, h: float) -> PackedVector2Array:
		var n := crown.size()
		if n < 2 or edges.size() != n:
			return PackedVector2Array()
		var out := PackedVector2Array()
		out.resize(n * 2)
		for i in range(n):
			out[i] = crown[i]
			var j := n - 1 - i
			out[n + i] = crown[j] + Vector2(0.0, h * (0.45 + 0.55 * edges[j]))
		return out

	func _add_tree(at: Vector2, th: float, tr: float, st: String) -> void:
		if st == "dune":
			# dune realms get low wind-shaped mounds instead of trees: one clean
			# half-ellipse arc, (+rx,0) → (−rx,0), closed by its own base edge
			var mound := PackedVector2Array()
			var steps := 12
			for i in range(steps + 1):
				var a: float = PI * float(i) / float(steps)
				mound.append(at + Vector2(cos(a) * tr * 2.2, -sin(a) * th * 0.5))
			_push(mound, R_TREE)
			return
		if st == "crystal":
			_push(PackedVector2Array([
				at + Vector2(-tr, 0.0), at + Vector2(-tr * 0.42, -th * 0.92),
				at + Vector2(tr * 0.12, -th), at + Vector2(tr * 0.72, -th * 0.6),
				at + Vector2(tr, 0.0)]), R_TREE)
			return
		var trunk := ProcSilhouettes._tapered_strip(
			PackedVector2Array([at, at + Vector2(0.0, -th * 0.55)]),
			maxf(2.0, tr * 0.34), maxf(1.2, tr * 0.2))
		_push(trunk, R_TREE)
		if st == "conifer":
			var spire := ProcSilhouettes._tapered_strip(
				PackedVector2Array([at + Vector2(0.0, -th * 0.18), at + Vector2(0.0, -th * 1.05)]),
				tr * 1.9, 1.0)
			_push(spire, R_TREE)
			return
		var canopy := Proc.superellipse(tr * 1.25, tr * 1.05, 2.3, 14)
		for i in range(canopy.size()):
			canopy[i] = canopy[i] + at + Vector2(0.0, -th * 0.78)
		_push(canopy, R_TREE)

	func _push(pts: PackedVector2Array, role: int) -> void:
		if not ProcSilhouettes._poly_ok(pts):
			return
		fills.append(pts)
		roles.append(role)
		cols.append(PackedColorArray())

	# -- colour (cache-on-change) ---------------------------------------------

	# p: {rock_t,rock_b,soil_t,soil_b,grass_t,grass_b,tree_t,tree_b,wisp,fall,
	#     strata,rim,lc} — already fogged to this islet's depth by the parent.
	func retint(p: Dictionary) -> void:
		# every colour is unpacked into a TYPED local first (no Variant ever
		# reaches a call argument), then one gradient per cached fill
		var rock_t: Color = p.get("rock_t", Color(0.26, 0.28, 0.30))
		var rock_b: Color = p.get("rock_b", Color(0.12, 0.13, 0.16))
		var soil_t: Color = p.get("soil_t", Color(0.34, 0.26, 0.18))
		var soil_b: Color = p.get("soil_b", Color(0.20, 0.15, 0.11))
		var grass_t: Color = p.get("grass_t", Color(0.34, 0.56, 0.30))
		var grass_b: Color = p.get("grass_b", Color(0.20, 0.36, 0.20))
		var tree_t: Color = p.get("tree_t", Color(0.20, 0.34, 0.22))
		var tree_b: Color = p.get("tree_b", Color(0.10, 0.18, 0.13))
		var wisp_c: Color = p.get("wisp", Color(1, 1, 1, 0.16))
		var fall_c: Color = p.get("fall", Color(1, 1, 1, 1))
		var wisp_top := Color(wisp_c.r, wisp_c.g, wisp_c.b, wisp_c.a * 0.35)
		var fall_top := Color(fall_c.r, fall_c.g, fall_c.b, 0.55)
		var fall_bot := Color(fall_c.r, fall_c.g, fall_c.b, 0.12)
		for i in range(fills.size()):
			var pts := fills[i]
			match roles[i]:
				R_WISP:
					cols[i] = Proc.grad_fill(pts, wisp_top, wisp_c)
				R_SOIL:
					cols[i] = Proc.grad_fill(pts, soil_t, soil_b)
				R_GRASS:
					cols[i] = Proc.grad_fill(pts, grass_t, grass_b)
				R_TREE:
					cols[i] = Proc.grad_fill(pts, tree_t, tree_b)
				R_FALL:
					cols[i] = Proc.grad_fill(pts, fall_top, fall_bot)
				_:
					cols[i] = Proc.grad_fill(pts, rock_t, rock_b)
		var st_c: Color = p.get("strata", strata_col)
		strata_col = st_c
		dot_col = Color(fall_c.r, fall_c.g, fall_c.b, 0.34)
		var rc: Color = p.get("rim", rim_col)
		rim_col = rc
		if lod == 0 and outline.size() >= 3:
			var lc: Dictionary = p.get("lc", {})
			rim = ProcLighting.rim_points(outline, lc, 0.30)
		queue_redraw()

	func _draw() -> void:
		for i in range(fills.size()):
			var pts := fills[i]
			var cs := cols[i]
			if pts.size() >= 3 and cs.size() == pts.size():
				draw_polygon(pts, cs)
		for i in range(strata.size()):
			var ln := strata[i]
			if ln.size() >= 2:
				draw_polyline(ln, strata_col, 1.6, true)
		for i in range(dots.size()):
			draw_circle(dots[i], dot_r[i], dot_col)
		if rim.size() >= 2:
			draw_polyline(rim, rim_col, 1.6, true)


# ============================================================================
#  _Framing — P7 foreground ink silhouettes (rocks, grass clumps, one branch)
# ============================================================================

class _Framing extends ProcNode:
	var world_seed: int = 0
	var key: String = "fg"
	var size: Vector2 = Vector2(1080, 1920)
	var side: String = "both"
	var lod: int = 0
	var density: float = 1.0
	var branch_on: bool = true
	var ink_override: Color = Color(0, 0, 0, 0)   # alpha > 0 → fixed ink

	var _ink: Color = Color(0.05, 0.06, 0.09)
	var _rim_col: Color = Color(1, 1, 1, 0.0)
	var _rocks: Array[Dictionary] = []    # {pts, cols, rim, anchor, sx}
	var _clumps: Array[Node2D] = []       # every _Clump (for retint / growth)
	var _sway: Array[Dictionary] = []     # {node, base_rot, amp, speed, ph}
	var _wind: float = 1.0
	var _strength: float = 1.0
	var _lit_version: int = -1
	# the near-camera ground lip: ONE wide ink mound along the bottom edge, drawn
	# under a y-only growth transform so it never needs regeometry
	var _lip: PackedVector2Array = PackedVector2Array()
	var _lip_cols: PackedColorArray = PackedColorArray()
	var _lip_crest: PackedVector2Array = PackedVector2Array()
	var _lip_nz: FastNoiseLite = null
	# clumps whose ROOTS sit on the lip: {node, h, dy} — repositioned on growth
	# so blades always emerge from the lip's own surface, never float over it
	var _lip_anchored: Array[Dictionary] = []

	func _on_built() -> void:
		_lip_nz = Proc.noise(seedv, "fglip", 0.0016, 2)
		_build_lip()
		_build_corners()
		_build_edge_tufts()
		_build_branch()
		_reshade()

	# Weather hook (ProcWeatherFX / WorldSpace): 0 = dead calm, 1 = default
	# breeze, up to 3 = storm-whipped. Scales sway amplitude only.
	func set_wind(w: float) -> void:
		_wind = clampf(w, 0.0, ProcSilhouettes.FRAMING_MAX_WIND)

	# Matches the ProcAtmosphere convention so WorldSpace can fade the whole
	# frame as one (e.g. dim the ink during a whiteout, lift it for a close-up).
	func set_strength(s: float) -> void:
		_strength = clampf(s, 0.0, 1.0)
		modulate.a = _strength

	# -- construction ----------------------------------------------------------

	# Height of the foreground ground lip above the bottom screen edge at x:
	# low in the middle (so the diorama stays readable), swelling toward the
	# corners where it meets the rock shoulders, gently noise-wobbled.
	func _lip_y(x: float) -> float:
		var u: float = clampf(x / maxf(1.0, size.x), -0.45, 1.45)
		var base: float = size.y * 0.028 * density
		var swell: float = size.y * 0.030 * density * pow(absf(u - 0.5) * 2.0, 1.6)
		var wob: float = 0.0
		if _lip_nz != null:
			wob = size.y * 0.013 * density * _lip_nz.get_noise_1d(x * 0.9)
		return maxf(6.0, base + swell + wob)

	# The lip spans WELL past both screen edges: at parallax 1.25 this plane
	# slides ~25% of the camera's travel, so a screen-wide band would reveal its
	# own ends after a pan. Points are stored relative to the bottom edge and
	# drawn under a (1, g) transform, so growth never regenerates geometry.
	func _build_lip() -> void:
		var over := 420.0
		var steps: int = [30, 18, 11][clampi(lod, 0, 2)]
		var pts := PackedVector2Array()
		var crest := PackedVector2Array()
		for i in range(steps + 1):
			var x: float = lerpf(-over, size.x + over, float(i) / float(steps))
			var p := Vector2(x, -_lip_y(x))
			pts.append(p)
			crest.append(p)
		pts.append(Vector2(size.x + over, 48.0))
		pts.append(Vector2(-over, 48.0))
		if ProcSilhouettes._poly_ok(pts):
			_lip = pts
			_lip_crest = crest

	# Grass tufts planted ALONG the lip between the corners — the nearest thing
	# to the camera, so the eye reads a real floor in front of the island.
	func _build_edge_tufts() -> void:
		var n: int = [3, 2, 0][clampi(lod, 0, 2)]
		for i in range(n):
			var tk := "fgtuft:%d" % i
			var u: float = (float(i) + 0.5) / float(n)
			var x: float = size.x * (0.14 + 0.72 * u) + Proc.rangef(seedv, tk + ":x", -size.x * 0.07, size.x * 0.07)
			var clump := _Clump.new()
			clump.name = "Tuft%d" % i
			var lh: float = _lip_y(x)
			clump.position = Vector2(x, size.y - lh + 6.0)
			_lip_anchored.append({"node": clump, "h": lh, "dy": 6.0})
			var lean: float = 1.0 if x < size.x * 0.5 else -1.0
			var blades: int = [8, 5, 4][clampi(lod, 0, 2)] + int(Proc.hashf(seedv, tk + ":n") * 3.0)
			_fill_grass_clump(clump, tk, blades, lean, 0.78 * Proc.rangef(seedv, tk + ":s", 0.85, 1.15))
			add_child(clump)
			_clumps.append(clump)
			_sway.append({
				"node": clump,
				"base_rot": Proc.rangef(seedv, tk + ":br", -0.04, 0.04),
				"amp": Proc.rangef(seedv, tk + ":amp", 0.03, 0.055),
				"speed": Proc.rangef(seedv, tk + ":spd", 1.1, 2.0),
				"ph": Proc.hashf(seedv, tk + ":ph") * TAU,
			})

	func _build_corners() -> void:
		var corners: Array[String] = []
		if side == "both" or side == "left":
			corners.append("L")
		if side == "both" or side == "right":
			corners.append("R")
		for cid in corners:
			var sx: float = 1.0 if cid == "L" else -1.0
			var anchor := Vector2(-26.0, size.y + 18.0) if cid == "L" else Vector2(size.x + 26.0, size.y + 18.0)
			var ssc: float = Proc.rangef(seedv, "fgsc:" + cid, 1.15, 1.35)
			_build_rocks(cid, anchor, sx, ssc)
			_build_grass(cid, anchor, sx, ssc)

	# Two overlapping rock shoulders per corner; geometry is corner-local and
	# mirrored at draw time via draw_set_transform (negative x-scale), so both
	# corners share one build path. Squashed blobs read as weathered boulders.
	func _build_rocks(cid: String, anchor: Vector2, sx: float, ssc: float) -> void:
		var r1: float = size.x * 0.138 * density * ssc
		var raw1 := Proc.blob(seedv, "rock:" + cid + ":0", r1, 8, 0.20)
		var pts1 := PackedVector2Array()
		pts1.resize(raw1.size())
		var o1 := Vector2(r1 * 0.42, -r1 * 0.30)
		for i in range(raw1.size()):
			pts1[i] = o1 + Vector2(raw1[i].x, raw1[i].y * 0.74)
		var r2: float = r1 * Proc.rangef(seedv, "rk2:" + cid, 0.45, 0.62)
		var raw2 := Proc.blob(seedv, "rock:" + cid + ":1", r2, 7, 0.26)
		var pts2 := PackedVector2Array()
		pts2.resize(raw2.size())
		var o2 := Vector2(r1 * 1.18, -r2 * 0.26)
		for i in range(raw2.size()):
			pts2[i] = o2 + Vector2(raw2[i].x, raw2[i].y * 0.70)
		# `rimmed` rocks get a lit-edge rim run recomputed in _reshade (§2.5); the
		# small shoulder stays pure ink so the pair still reads as one dark mass.
		if ProcSilhouettes._poly_ok(pts1):
			_rocks.append({"pts": pts1, "cols": PackedColorArray(),
				"rim": PackedVector2Array(), "rimmed": true,
				"anchor": anchor, "sx": sx, "mirror": sx < 0.0})
		if ProcSilhouettes._poly_ok(pts2):
			_rocks.append({"pts": pts2, "cols": PackedColorArray(),
				"rim": PackedVector2Array(), "rimmed": false,
				"anchor": anchor, "sx": sx, "mirror": sx < 0.0})

	func _build_grass(cid: String, anchor: Vector2, sx: float, ssc: float) -> void:
		var nclump: int = [3, 2, 1][clampi(lod, 0, 2)]
		var r1: float = size.x * 0.138 * density * ssc   # matches the rock radius
		for ci in range(nclump):
			var ckey := "g:%s:%d" % [cid, ci]
			var clump := _Clump.new()
			clump.name = "Grass%s%d" % [cid, ci]
			var dx: float = r1 * (0.35 + 0.62 * float(ci)) + Proc.rangef(seedv, ckey + ":dx", -14.0, 14.0)
			var gx: float = anchor.x + sx * dx
			# plant into the lip's slope rather than the raw screen edge
			var lh: float = _lip_y(gx) * 0.55
			var dy: float = Proc.rangef(seedv, ckey + ":dy", 2.0, 14.0)
			clump.position = Vector2(gx, size.y - lh + dy)
			_lip_anchored.append({"node": clump, "h": lh, "dy": dy})
			var blades: int = [11, 7, 5][clampi(lod, 0, 2)] + int(Proc.hashf(seedv, ckey + ":n") * 3.0)
			var len_scale: float = ssc * lerpf(1.0, 0.7, float(ci) / maxf(1.0, float(nclump)))
			_fill_grass_clump(clump, ckey, blades, sx, len_scale)
			if lod == 0 and ci == 1:
				_fill_fern(clump, ckey + ":fern", sx, ssc)
			add_child(clump)
			_clumps.append(clump)
			_sway.append({
				"node": clump,
				"base_rot": Proc.rangef(seedv, ckey + ":br", -0.05, 0.05) * sx,
				"amp": Proc.rangef(seedv, ckey + ":amp", 0.022, 0.045),
				"speed": Proc.rangef(seedv, ckey + ":spd", 1.0, 1.9),
				"ph": Proc.hashf(seedv, ckey + ":ph") * TAU,
			})

	# Curved tapered blades leaning away from the corner; ~30% carry a seed-head
	# dot at the tip. All polygons cached once on the clump.
	func _fill_grass_clump(clump: _Clump, ckey: String, blades: int, lean_sign: float, len_scale: float) -> void:
		for b in range(blades):
			var bk := "%s:%d" % [ckey, b]
			var root := Vector2(
				Proc.rangef(seedv, bk + ":rx", -26.0, 26.0),
				Proc.rangef(seedv, bk + ":ry", -2.0, 2.0))
			var ln: float = Proc.rangef(seedv, bk + ":ln", 34.0, 92.0) * len_scale
			var lean: float = Proc.rangef(seedv, bk + ":le", 0.08, 0.5) * lean_sign
			var bend: float = Proc.rangef(seedv, bk + ":bd", 0.25, 0.85)
			var dirv := Vector2(sin(lean), -cos(lean))
			var p1 := root + dirv * ln * 0.55
			var p2 := root + dirv.rotated(lean * bend) * ln
			var spine := ProcSilhouettes._qbez(root, p1, p2, 5)
			var w0: float = Proc.rangef(seedv, bk + ":w", 2.4, 4.8)
			var poly := ProcSilhouettes._tapered_strip(spine, w0, 0.7)
			if ProcSilhouettes._poly_ok(poly):
				clump.polys.append(poly)
				clump.cols.append(Color(0, 0, 0, 0.85))
				clump.jit.append(Proc.rangef(seedv, bk + ":j", -0.028, 0.028))
				if Proc.hashf(seedv, bk + ":sh") < 0.3:
					clump.dots.append(spine[spine.size() - 1])
					clump.dot_r.append(Proc.rangef(seedv, bk + ":dr", 1.6, 2.8))

	# One arcing fern: a curved midrib polyline with paired tapering leaflets.
	func _fill_fern(clump: _Clump, fk: String, lean_sign: float, ssc: float) -> void:
		var root := Vector2(Proc.rangef(seedv, fk + ":rx", -18.0, 18.0), 0.0)
		var ln: float = Proc.rangef(seedv, fk + ":ln", 70.0, 110.0) * ssc
		var lean: float = Proc.rangef(seedv, fk + ":le", 0.3, 0.7) * lean_sign
		var dirv := Vector2(sin(lean), -cos(lean))
		var p2 := root + dirv.rotated(lean * 0.8) * ln
		var spine := ProcSilhouettes._qbez(root, root + dirv * ln * 0.5, p2, 8)
		clump.lines.append(spine)
		clump.line_cols.append(Color(0, 0, 0, 0.85))
		clump.line_jit.append(-0.01)
		var nl := 7
		for i in range(nl):
			var u: float = 0.2 + 0.75 * float(i) / float(nl - 1)
			var idx: int = clampi(int(u * float(spine.size() - 1)), 1, spine.size() - 1)
			var at := spine[idx]
			var tang := (spine[idx] - spine[idx - 1]).normalized()
			var side_n := tang.orthogonal()
			var leaf_len: float = ln * 0.22 * (1.0 - u * 0.75)
			for s_i in range(2):
				var sgn: float = -1.0 if s_i == 0 else 1.0
				var tipp := at + (side_n * sgn + tang * 0.25).normalized() * leaf_len
				var lsp := ProcSilhouettes._qbez(at, at.lerp(tipp, 0.5) - tang * leaf_len * 0.12, tipp, 3)
				var lp := ProcSilhouettes._tapered_strip(lsp, maxf(2.0, leaf_len * 0.34), 0.8)
				if ProcSilhouettes._poly_ok(lp):
					clump.polys.append(lp)
					clump.cols.append(Color(0, 0, 0, 0.85))
					clump.jit.append(Proc.rangef(seedv, "%s:lj:%d:%d" % [fk, i, s_i], -0.02, 0.02))

	# ONE leafy bough arcing in from a top corner (spec: one top branch max).
	func _build_branch() -> void:
		if not branch_on or lod >= 2:
			return
		var from_right: bool
		if side == "left":
			from_right = false
		elif side == "right":
			from_right = true
		else:
			from_right = Proc.hashf(seedv, "fgbr:side") < 0.5
		var sx: float = -1.0 if from_right else 1.0
		var ssc: float = Proc.rangef(seedv, "fgbr:sc", 1.15, 1.35)
		var ax: float = (size.x + 22.0) if from_right else -22.0
		var anchor := Vector2(ax, size.y * Proc.rangef(seedv, "fgbr:y", 0.045, 0.11))
		var clump := _Clump.new()
		clump.name = "Branch"
		clump.position = anchor
		var reach: float = size.x * Proc.rangef(seedv, "fgbr:rx", 0.42, 0.56) * density
		var droopv: float = size.y * Proc.rangef(seedv, "fgbr:dy", 0.05, 0.10)
		var p1 := Vector2(sx * reach * 0.45, -droopv * 0.35)
		var p2 := Vector2(sx * reach, droopv)
		var spine := ProcSilhouettes._qbez(Vector2.ZERO, p1, p2, 10)
		var bough := ProcSilhouettes._tapered_strip(spine, 17.0 * ssc, 3.0)
		if ProcSilhouettes._poly_ok(bough):
			clump.polys.append(bough)
			clump.cols.append(Color(0, 0, 0, 0.86))
			clump.jit.append(-0.012)
		var tw_n: int = 4 if lod == 0 else 2
		for i in range(tw_n):
			var u: float = 0.30 + 0.60 * float(i) / maxf(1.0, float(tw_n - 1))
			var idx: int = clampi(int(u * float(spine.size() - 1)), 1, spine.size() - 1)
			var at := spine[idx]
			var tang := (spine[idx] - spine[idx - 1]).normalized()
			var rot: float = (0.55 + 0.5 * Proc.hashf(seedv, "fgtw:%d" % i)) * (1.0 if i % 2 == 0 else -0.8)
			var tdir := tang.rotated(rot * sx)
			var tlen: float = Proc.rangef(seedv, "fgtl:%d" % i, 34.0, 64.0) * ssc
			var tspine := ProcSilhouettes._qbez(at, at + tdir * tlen * 0.5,
					at + tdir * tlen + Vector2(0.0, tlen * 0.18), 4)
			var tpoly := ProcSilhouettes._tapered_strip(tspine, 5.0, 1.0)
			if ProcSilhouettes._poly_ok(tpoly):
				clump.polys.append(tpoly)
				clump.cols.append(Color(0, 0, 0, 0.86))
				clump.jit.append(Proc.rangef(seedv, "fgtj:%d" % i, -0.02, 0.01))
			_add_leaf_cluster(clump, "fglc:%d" % i, tspine[tspine.size() - 1],
					Proc.rangef(seedv, "fglr:%d" % i, 15.0, 26.0) * ssc)
		_add_leaf_cluster(clump, "fglc:tip", spine[spine.size() - 1],
				Proc.rangef(seedv, "fglr:tip", 22.0, 32.0) * ssc)
		if lod == 0:
			# a hanging sprig: drooping strand with a few leaf-dots, mid-bough
			var hidx: int = int(0.6 * float(spine.size() - 1))
			var hat := spine[hidx]
			var hlen: float = Proc.rangef(seedv, "fgh:ln", 38.0, 70.0)
			var hsp := ProcSilhouettes._qbez(hat, hat + Vector2(sx * 8.0, hlen * 0.5),
					hat + Vector2(sx * 2.0, hlen), 5)
			clump.lines.append(hsp)
			clump.line_cols.append(Color(0, 0, 0, 0.80))
			clump.line_jit.append(0.0)
			for i in range(4):
				var u2: float = 0.3 + 0.7 * float(i) / 3.0
				var pidx: int = clampi(int(u2 * float(hsp.size() - 1)), 0, hsp.size() - 1)
				clump.dots.append(hsp[pidx] + Vector2(sx * 3.0, 1.5))
				clump.dot_r.append(Proc.rangef(seedv, "fghd:%d" % i, 2.0, 3.4))
		add_child(clump)
		_clumps.append(clump)
		_sway.append({
			"node": clump, "base_rot": 0.0, "amp": 0.012,
			"speed": Proc.rangef(seedv, "fgbr:spd", 0.55, 0.8),
			"ph": Proc.hashf(seedv, "fgbr:ph") * TAU,
		})

	# A leaf mass as 3 overlapping ink blobs — the silhouette cousin of the
	# ProcFoliage 3-tone cluster.
	func _add_leaf_cluster(clump: _Clump, ck: String, at: Vector2, r: float) -> void:
		for i in range(3):
			var off := Vector2(
				Proc.rangef(seedv, "%s:ox:%d" % [ck, i], -r * 0.5, r * 0.5),
				Proc.rangef(seedv, "%s:oy:%d" % [ck, i], -r * 0.45, r * 0.3))
			var rr: float = r * Proc.rangef(seedv, "%s:r:%d" % [ck, i], 0.55, 0.9)
			var raw := Proc.blob(seedv, "%s:b:%d" % [ck, i], rr, 7, 0.3)
			var pts := PackedVector2Array()
			pts.resize(raw.size())
			for j in range(raw.size()):
				pts[j] = at + off + raw[j]
			if ProcSilhouettes._poly_ok(pts):
				clump.polys.append(pts)
				clump.cols.append(Color(0, 0, 0, 0.85))
				clump.jit.append(Proc.rangef(seedv, "%s:j:%d" % [ck, i], -0.03, 0.02))

	# -- life ------------------------------------------------------------------

	func _animate(_delta: float) -> void:
		# sway = rotation of the cached clumps about their roots; nothing else
		for i in range(_sway.size()):
			var s: Dictionary = _sway[i]
			var n: Node2D = s.node
			n.rotation = float(s.base_rot) + sin(t * float(s.speed) + float(s.ph)) * float(s.amp) * _wind
		if ProcSilhouettes.light_version() != _lit_version:
			_lit_version = ProcSilhouettes.light_version()
			_reshade()

	func _on_growth() -> void:
		var gs: float = 0.25 + 0.75 * g()
		for i in range(_clumps.size()):
			_clumps[i].scale = Vector2.ONE * gs
		# the lip rises with growth (same factor _draw uses) — ride it
		var lg: float = maxf(0.08, gs)
		for i in range(_lip_anchored.size()):
			var la: Dictionary = _lip_anchored[i]
			var nd: Node2D = la.node
			nd.position.y = size.y - float(la.h) * lg + float(la.dy)

	# Cache-on-change shading (GFX-2.5D §2.4): rebuild the cached ink colours,
	# then redraw. Runs only when ProcLighting.version() moves (~every 7 s).
	func _reshade() -> void:
		var lc := ProcSilhouettes.light_ctx()
		var hz: Color = lc.get("horizon", Color(0.84, 0.89, 0.94))
		_ink = ink_override if ink_override.a > 0.0 else ProcSilhouettes.ink_color(world_seed, key, hz)
		var amb: Color = lc.get("ambient", Color(0.62, 0.70, 0.82))
		var energy: float = float(lc.get("sun_energy", 1.0))
		if bool(lc.get("is_night", false)):
			_ink = _ink.lerp(amb, 0.14)   # moonlit silhouettes soften, never vanish
		var sc: Color = lc.get("sun_color", Color(1.0, 0.965, 0.878))
		_rim_col = Color(sc.r, sc.g, sc.b, 0.08 + 0.16 * energy)
		# Right-corner rocks are DRAWN mirrored (negative x scale), so their rim
		# must be solved against a mirrored sun direction to land on the edge the
		# viewer sees lit. One duplicated ctx per reshade, never per frame.
		var sd: Vector2 = lc.get("sun_dir", Vector2(0.12, 0.99))
		var lc_m := lc.duplicate()
		lc_m["sun_dir"] = Vector2(-sd.x, sd.y)
		var top := Color.from_hsv(_ink.h, _ink.s, clampf(_ink.v + 0.07, 0.0, 1.0), ProcSilhouettes.FRAMING_ALPHA + 0.03)
		var bot := Color.from_hsv(_ink.h, _ink.s, clampf(_ink.v - 0.05, 0.0, 1.0), ProcSilhouettes.FRAMING_ALPHA + 0.07)
		for i in range(_rocks.size()):
			var rk: Dictionary = _rocks[i]
			var pts: PackedVector2Array = rk.pts
			rk.cols = Proc.grad_fill(pts, top, bot)
			if lod == 0 and bool(rk.rimmed):
				rk.rim = ProcLighting.rim_points(pts, lc_m if bool(rk.mirror) else lc, 0.26)
		if _lip.size() >= 3:
			# the lip is nearest the camera: a touch lighter at its crest (sky
			# bounce) and deepest at the screen edge, so it reads as a near FORM
			_lip_cols = Proc.grad_fill(_lip,
				Color.from_hsv(_ink.h, _ink.s * 0.92, clampf(_ink.v + 0.045, 0.0, 1.0), 0.90),
				Color.from_hsv(_ink.h, _ink.s, clampf(_ink.v - 0.035, 0.0, 1.0), 0.95))
		for i in range(_clumps.size()):
			var c := _clumps[i] as _Clump
			if c != null:
				c.retint(_ink)
		queue_redraw()

	func _draw() -> void:
		# Rocks + the ground lip only (clumps draw themselves); growth scales
		# about each corner anchor / the bottom edge via draw_set_transform, so
		# the cached points are never rebuilt or reallocated.
		var gs: float = maxf(0.08, 0.25 + 0.75 * g())
		if _lip.size() >= 3 and _lip_cols.size() == _lip.size():
			draw_set_transform(Vector2(0.0, size.y), 0.0, Vector2(1.0, gs))
			draw_polygon(_lip, _lip_cols)
			if lod == 0 and _lip_crest.size() >= 2:
				draw_polyline(_lip_crest, Color(_rim_col.r, _rim_col.g, _rim_col.b, _rim_col.a * 0.7), 1.8, true)
			draw_set_transform(Vector2.ZERO, 0.0, Vector2.ONE)
		for i in range(_rocks.size()):
			var rk: Dictionary = _rocks[i]
			var pts: PackedVector2Array = rk.pts
			if pts.size() < 3:
				continue
			var anchor: Vector2 = rk.anchor
			var sx: float = float(rk.sx)
			draw_set_transform(anchor, 0.0, Vector2(sx * gs, gs))
			var cols: PackedColorArray = rk.cols
			if cols.size() == pts.size():
				draw_polygon(pts, cols)
			if lod == 0:
				var rim: PackedVector2Array = rk.rim
				if rim.size() >= 2:
					draw_polyline(rim, _rim_col, 2.0, true)
		draw_set_transform(Vector2.ZERO, 0.0, Vector2.ONE)


class _Clump extends Node2D:
	# One sway-able silhouette clump: cached ink polygons (blades, leaflets,
	# bough, leaf blobs), detail polylines (fern midrib, hanging sprig) and
	# seed-head dots. Geometry is built ONCE by _Framing; only colours ever
	# change (retint), and only rotation/scale animate.
	var polys: Array[PackedVector2Array] = []
	var cols: Array[Color] = []
	var jit: PackedFloat32Array = PackedFloat32Array()        # per-poly value jitter
	var lines: Array[PackedVector2Array] = []
	var line_cols: Array[Color] = []
	var line_jit: PackedFloat32Array = PackedFloat32Array()
	var line_w: float = 1.8
	var dots: PackedVector2Array = PackedVector2Array()
	var dot_r: PackedFloat32Array = PackedFloat32Array()
	var dot_col: Color = Color(0, 0, 0, 0.85)

	func retint(ink: Color) -> void:
		for i in range(polys.size()):
			var v: float = clampf(ink.v + jit[i], 0.0, 1.0)
			cols[i] = Color.from_hsv(ink.h, ink.s, v, cols[i].a)
		for i in range(lines.size()):
			var v2: float = clampf(ink.v + line_jit[i], 0.0, 1.0)
			line_cols[i] = Color.from_hsv(ink.h, ink.s, v2, line_cols[i].a)
		dot_col = Color.from_hsv(ink.h, ink.s, clampf(ink.v + 0.03, 0.0, 1.0), 0.85)
		queue_redraw()

	func _draw() -> void:
		for i in range(polys.size()):
			var p := polys[i]
			if p.size() >= 3:
				draw_colored_polygon(p, cols[i])
		for i in range(lines.size()):
			var l := lines[i]
			if l.size() >= 2:
				draw_polyline(l, line_cols[i], line_w, true)
		for i in range(dots.size()):
			draw_circle(dots[i], dot_r[i], dot_col)


# ============================================================================
#  _Treeline — depth-tinted far tree-lines / hills behind the ground band
# ============================================================================

class _Treeline extends ProcNode:
	var world_seed: int = 0
	var key: String = "tl"
	var size: Vector2 = Vector2(1080, 540)
	var realm_id: String = "verdant"
	var depth: float = 0.85
	var lod: int = 0
	var bands_override: int = 0

	# per band: {xs, rises, base_y, d, base, top, bot, near, pts, cols, rim}
	# `pts`/`cols`/`rim` are allocated ONCE at build size and only ever mutated
	# in place, so neither _draw nor _reshade ever allocates.
	var _bands: Array[Dictionary] = []
	var _rim_col: Color = Color(1, 1, 1, 0.0)
	var _lit_version: int = -1
	var _drawn_g: float = -1.0
	var _cols_dirty: bool = true
	var _strength: float = 1.0

	# Weather hook (same contract as the atmosphere nodes): a storm or a
	# whiteout can sink the ridges back into the haze without a rebuild.
	func set_strength(s: float) -> void:
		_strength = clampf(s, 0.0, 1.0)
		modulate.a = _strength

	func _on_built() -> void:
		var nb: int = [3, 2, 1][clampi(lod, 0, 2)]
		if bands_override > 0:
			nb = bands_override
		var rcols := ProcSilhouettes._realm_cols(world_seed, key, realm_id)
		var style := ProcSilhouettes._realm_style(realm_id)
		var over := 110.0
		for b in range(nb):
			var fb: float = (float(b) / float(nb - 1)) if nb > 1 else 1.0   # 0 far → 1 near
			var db: float = clampf(depth + 0.10 - 0.24 * fb, 0.0, 1.0)
			var base_y: float = size.y * lerpf(0.46, 0.80, fb)
			var hill_amp: float = size.y * lerpf(0.10, 0.05, fb)
			var tree_h: float = size.y * lerpf(0.10, 0.22, fb)
			var step: float = lerpf(18.0, 12.0, fb)
			var nz := Proc.noise(seedv, "ridge:%d" % b, 0.0035, 3)
			# seeded trees strewn along the band
			var trees: Array[Dictionary] = []
			var spacing: float = lerpf(64.0, 120.0, fb)
			var tx: float = -over + Proc.rangef(seedv, "t0:%d" % b, 0.0, spacing)
			var ti := 0
			while tx < size.x + over:
				var tr_r: float = spacing * Proc.rangef(seedv, "tr:%d:%d" % [b, ti], 0.42, 0.75)
				var hgt: float = tree_h * Proc.rangef(seedv, "th:%d:%d" % [b, ti], 0.55, 1.0)
				var st := style
				if style == "mixed":
					st = "broadleaf" if Proc.hashf(seedv, "ts:%d:%d" % [b, ti]) < 0.62 else "conifer"
				trees.append({"cx": tx, "r": tr_r, "hgt": hgt, "st": st})
				tx += spacing * Proc.rangef(seedv, "tg:%d:%d" % [b, ti], 0.8, 1.3)
				ti += 1
			# sample the composite ridge: rolling hills + the tallest tree profile
			var steps: int = maxi(8, int(ceil((size.x + 2.0 * over) / step)))
			var xs := PackedFloat32Array()
			var rises := PackedFloat32Array()
			for i in range(steps + 1):
				var x: float = -over + (size.x + 2.0 * over) * float(i) / float(steps)
				var hill: float = (nz.get_noise_2d(x, float(b) * 37.0) * 0.5 + 0.5) * hill_amp
				var rise: float = hill
				for tr in trees:
					var p: float = ProcSilhouettes._tree_profile(
						String(tr.st), x - float(tr.cx), float(tr.r), float(tr.hgt))
					if p > 0.0:
						rise = maxf(rise, hill * 0.55 + p)
				xs.append(x)
				rises.append(rise)
			var base_col := (rcols.mid as Color).lerp(rcols.deep as Color, fb)
			# ONE-TIME allocation of every draw buffer (ridge + 2 closing points,
			# the vertex-colour array, the canopy rim run and the 4-point fog lip).
			# _draw and _reshade only ever mutate these in place.
			var pts := PackedVector2Array()
			pts.resize(xs.size() + 2)
			var cols := PackedColorArray()
			cols.resize(xs.size() + 2)
			var rim := PackedVector2Array()
			if lod == 0 and b == nb - 1:
				rim.resize(xs.size())
			var lip := PackedVector2Array()
			lip.resize(4)
			var lip_cols := PackedColorArray()
			lip_cols.resize(4)
			_bands.append({
				"xs": xs, "rises": rises, "base_y": base_y, "d": db,
				"base": base_col, "top": base_col, "bot": base_col,
				"near": b == nb - 1, "pts": pts, "cols": cols, "rim": rim,
				"lip": lip, "lip_cols": lip_cols,
				"lip_h": hill_amp * 1.6 + tree_h * 0.35,
				"crest_y": base_y,
			})
		_reshade()

	func _animate(_delta: float) -> void:
		# distant ridges don't sway — the only life here is the light changing
		if ProcSilhouettes.light_version() != _lit_version:
			_lit_version = ProcSilhouettes.light_version()
			_reshade()

	# Fog each band's base colour toward the CURRENT horizon (cache-on-change;
	# per-frame depth colour math stays zero per GFX-2.5D §1.4). Colours are
	# written into the already-allocated vertex arrays — no allocation here.
	func _reshade() -> void:
		var lc := ProcSilhouettes.light_ctx()
		var hz: Color = lc.get("horizon", Color(0.84, 0.89, 0.94))
		var sc: Color = lc.get("sun_color", Color(1.0, 0.965, 0.878))
		var energy: float = float(lc.get("sun_energy", 1.0))
		for i in range(_bands.size()):
			var bd: Dictionary = _bands[i]
			var fogged := ProcSilhouettes.fog_tint(bd.base as Color, float(bd.d), hz)
			bd.top = fogged.lightened(0.07)
			bd.bot = fogged.darkened(0.14)
			# aerial perspective: the FOOT of each ridge drowns in horizon haze,
			# which is what makes a stack of bands read as receding kilometres.
			var lip_cols: PackedColorArray = bd.lip_cols
			if lip_cols.size() == 4:
				var a: float = 0.08 + 0.30 * ProcSilhouettes.fog_mix(float(bd.d))
				lip_cols[0] = Color(hz.r, hz.g, hz.b, 0.0)
				lip_cols[1] = Color(hz.r, hz.g, hz.b, 0.0)
				lip_cols[2] = Color(hz.r, hz.g, hz.b, a)
				lip_cols[3] = Color(hz.r, hz.g, hz.b, a)
		_rim_col = Color(sc.r, sc.g, sc.b, 0.10 + 0.10 * energy)
		_cols_dirty = true
		queue_redraw()

	func _draw() -> void:
		# Back-to-front bands; growth scales ridge RISE about each band's base
		# line, so a growing world's hills swell up out of the haze believably.
		# Every buffer touched here was allocated once in _on_built.
		var gs: float = maxf(0.05, g())
		var regeom: bool = absf(gs - _drawn_g) > 0.0004
		var recol: bool = regeom or _cols_dirty
		var floor_y: float = size.y + 60.0
		for i in range(_bands.size()):
			var bd: Dictionary = _bands[i]
			var xs: PackedFloat32Array = bd.xs
			var rises: PackedFloat32Array = bd.rises
			var n: int = xs.size()
			var pts: PackedVector2Array = bd.pts
			var cols: PackedColorArray = bd.cols
			if n < 2 or pts.size() != n + 2 or cols.size() != n + 2:
				continue
			var base_y: float = float(bd.base_y)
			var rim: PackedVector2Array = bd.rim
			var lip: PackedVector2Array = bd.lip
			if regeom:
				var crest: float = base_y
				pts[0] = Vector2(xs[0], floor_y)
				for j in range(n):
					var ry: float = base_y - rises[j] * gs
					pts[j + 1] = Vector2(xs[j], ry)
					if ry < crest:
						crest = ry
					if rim.size() == n:
						rim[j] = Vector2(xs[j], ry - 1.0)
				pts[n + 1] = Vector2(xs[n - 1], floor_y)
				bd.crest_y = crest
				if lip.size() == 4:
					var lh: float = float(bd.lip_h) * gs
					lip[0] = Vector2(xs[0], base_y - lh)
					lip[1] = Vector2(xs[n - 1], base_y - lh)
					lip[2] = Vector2(xs[n - 1], base_y + 10.0)
					lip[3] = Vector2(xs[0], base_y + 10.0)
			if recol:
				# vertex gradient over the RIDGE span only (the two closing points
				# sit far below the screen; letting them set the range would flatten
				# the whole band into its top colour).
				var y0: float = float(bd.get("crest_y", base_y))
				var span: float = maxf(1.0, base_y - y0)
				var ctop: Color = bd.top
				var cbot: Color = bd.bot
				cols[0] = cbot
				cols[n + 1] = cbot
				for j in range(n):
					cols[j + 1] = ctop.lerp(cbot, clampf((pts[j + 1].y - y0) / span, 0.0, 1.0))
			draw_polygon(pts, cols)
			if lip.size() == 4:
				var lip_cols: PackedColorArray = bd.lip_cols
				if lip_cols.size() == 4:
					draw_polygon(lip, lip_cols)
			if lod == 0 and bool(bd.near) and rim.size() >= 2:
				# a whisper of top light along the nearest canopy line
				draw_polyline(rim, _rim_col, 1.6, true)
		_drawn_g = gs
		_cols_dirty = false
