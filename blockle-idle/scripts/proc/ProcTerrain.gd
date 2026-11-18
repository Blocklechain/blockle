class_name ProcTerrain extends RefCounted
# ProcTerrain — the floating sky-island the whole world sits on.
#
# Everything here is synthesised from (world_seed, key): a noise-deformed smooth
# multi-lobe silhouette (a classic inverted-mountain floating island), layered
# strata (grass crown with a vertical gradient, a soil band, then a craggy rock
# body with sedimentary striations down the underside), mossy drip-edges, and
# roots + hanging vines that dangle from the rim and sway. It supports MANY
# islands at once (foreground + parallax backdrops) and can GROW its landmass
# over time through an expansion API (`add_region`) so the world is literally
# woven larger as Rootwork puzzles are solved.
#
#   GROWTH  — the island renders a believable stage for ANY `growth` in [0,1], so
#             its mass can ease from a tiny floating clod (0) to a full landmass (1).
#             By DEFAULT an island spawns fully-formed (growth 1.0) — the land is
#             ancient, and a stable full-size ground query is what the world wants
#             out of the box — so a caller that wants the clod→land staging opts in
#             with `pop_in()` or `set_growth(0.0)`; `set_grow_minutes()` then paces
#             the (very slow) creep back up. Each appended region ALWAYS unfurls
#             outward from 0→1 on its own clock regardless, so new land blooms open
#             in a few seconds and the ground query grows with it.
#   ANIMATION — the body itself is static (so the ground query is stable for
#             things placed on it) and redraws ONLY when the shape changes; all
#             life is cheap child-transform animation: roots/vines/tufts sway by
#             rotating about their anchor, crystal/star glints pulse via modulate,
#             and dust-motes drift up beneath the rim.
#
# Public factories (a world-builder calls these):
#   make(world_seed, key, half_width, realm_id, lod)        -> ProcNode (an island)
#   make_islet(world_seed, key, half_width, realm_id, depth)-> ProcNode (small bg island)
#   make_backdrop(world_seed, key, realm_id, count)         -> ProcNode (a parallax shelf)
#   make_cluster(world_seed, key, realm_id, half_width)     -> ProcNode (backdrops + main)
#
# Ground query on an island node (feet-at-origin world placement):
#   surface_y(x) · surface_point(x) · surface_normal(x) · ground_extents()
#   contains_x(x) · random_surface_x(key) · add_region(...) / grow_landmass(key)


# ============================================================================
#  FACTORIES
# ============================================================================

static func make(world_seed: int, key: String, half_width: float = 420.0,
		realm_id: String = "verdant", lod: int = 0) -> ProcNode:
	var n := _Island.new()
	n.seedv = hash("%d:isl:%s" % [world_seed, key])
	n.world_seed = world_seed
	n.key = key
	n.base_w = max(60.0, half_width)
	# Depth scales with width but is capped: a very WIDE landmass should read as a
	# broad stretch of land, not an abyssal spike hanging kilometres below.
	n.max_depth = minf(n.base_w * 1.55, 860.0)
	n.realm_id = realm_id
	n.lod = clampi(lod, 0, 2)
	n.set_grow_minutes(60.0 * 8.0)   # the land itself is ancient & slow
	return n

# A small island for parallax backdrops; `depth` 1..3 pushes it further away
# (smaller, hazier, gently bobbing). Fewer details for performance.
static func make_islet(world_seed: int, key: String, half_width: float = 150.0,
		realm_id: String = "verdant", depth: int = 1) -> ProcNode:
	var lod := clampi(depth, 1, 2)
	var n := _Island.new()
	n.seedv = hash("%d:islet:%s" % [world_seed, key])
	n.world_seed = world_seed
	n.key = key
	n.base_w = max(40.0, half_width)
	n.max_depth = n.base_w * 1.7
	n.realm_id = realm_id
	n.lod = lod
	n.bob_amp = lerpf(6.0, 16.0, float(depth) / 3.0)
	n.haze = clampf(0.1 * depth, 0.0, 0.5)
	n.set_grow_minutes(0.0)          # backdrops arrive fully-formed
	return n

# A shelf of several backdrop islets strewn behind the main island, each at its
# own parallax factor. Returns a parent node you can offset for parallax via
# `set_camera(offset)`. Positions/sizes are all seeded.
static func make_backdrop(world_seed: int, key: String, realm_id: String = "verdant",
		count: int = 5) -> ProcNode:
	var a := _Archipelago.new()
	a.seedv = hash("%d:bg:%s" % [world_seed, key])
	for i in range(count):
		var depth := 1 + (i % 3)
		var w := Proc.rangef(world_seed, "bgw:%s:%d" % [key, i], 70.0, 190.0)
		var islet := make_islet(world_seed, "%s#%d" % [key, i], w, realm_id, depth)
		var px := Proc.rangef(world_seed, "bgx:%s:%d" % [key, i], -720.0, 720.0)
		var py := Proc.rangef(world_seed, "bgy:%s:%d" % [key, i], -520.0, 180.0)
		var factor := lerpf(0.22, 0.6, 1.0 - float(depth) / 3.0)
		a.add_layer(islet, Vector2(px, py), factor)
	return a

# The whole landscape: a parallax backdrop shelf + the main playable island at
# centre. `main_island()` returns the island to run ground queries against.
static func make_cluster(world_seed: int, key: String, realm_id: String = "verdant",
		half_width: float = 440.0) -> ProcNode:
	var a := _Archipelago.new()
	a.seedv = hash("%d:cl:%s" % [world_seed, key])
	# far + mid backdrops. make_backdrop() parents each islet under its own throwaway
	# _Archipelago, so we must DETACH them from that parent before re-homing them on
	# `a` — Godot 4's add_child() does not auto-reparent and would error on an
	# already-parented node (leaving every backdrop islet invisible). Detach, re-add,
	# then free the now-empty scratch archipelago.
	var bg := make_backdrop(world_seed, key + ":bg", realm_id, 6)
	var bg_layers: Array = (bg as _Archipelago).layers.duplicate()
	for L in bg_layers:
		var node: ProcNode = L.node
		if node.get_parent() == bg:
			bg.remove_child(node)
		a.add_layer(node, L.base_pos, L.factor)
	bg.free()
	# the hero island, full detail, no bob (stable ground), parallax factor 1
	var main := make(world_seed, key + ":main", half_width, realm_id, 0)
	a.add_layer(main, Vector2.ZERO, 1.0)
	a.main = main
	return a


# ============================================================================
#  BIOME / PALETTE  (seeded, realm-aware, pulls sky colours from GameData)
# ============================================================================

static func _realm_sky(realm_id: String) -> Array:
	var out: Array = []
	var r := _realm(realm_id)
	if r.has("sky"):
		for h in r["sky"]:
			out.append(_hex(String(h)))
	if out.is_empty():
		out = [_hex("#8FD3C4"), _hex("#D9F2E6"), _hex("#FBF6E9")]
	return out

static func _realm(realm_id: String) -> Dictionary:
	if GameData and GameData.realms_by_id.has(realm_id):
		return GameData.realms_by_id[realm_id]
	return {}

static func _hex(s: String) -> Color:
	return Color(s)

# Smootherstep easing for region-growth [0,1] (mirrors ProcNode.g()).
static func _ease(x: float) -> float:
	var v := clampf(x, 0.0, 1.0)
	return v * v * v * (v * (v * 6.0 - 15.0) + 10.0)

# A full terrain colour-set + feature flags for a realm, nudged by the world seed
# so two worlds in the same realm still differ a little.
static func _make_bio(world_seed: int, key: String, realm_id: String) -> Dictionary:
	var pal := Proc.palette(world_seed, "terr:" + key)
	var sky := _realm_sky(realm_id)
	var warm: Color = sky[sky.size() - 1]
	var bio := {
		"grass_top": _hex("#8FC24E"), "grass_bot": _hex("#3F7E36"), "grass_dk": _hex("#2C5E28"),
		"soil_top": _hex("#6E4B2E"), "soil_bot": _hex("#4A3420"),
		"rock_lt": _hex("#8C8277"), "rock_mid": _hex("#6A6054"), "rock_dk": _hex("#3C352D"),
		"moss": _hex("#5C8C3A"), "snow": false, "glint": Color(0, 0, 0, 0),
		"mushrooms": false, "crystal": false, "star": false, "gold": false, "frozen": false,
	}
	match realm_id:
		"crystal_hollow":
			bio.grass_top = _hex("#45B49A"); bio.grass_bot = _hex("#1E6E6A"); bio.grass_dk = _hex("#124E52")
			bio.soil_top = _hex("#2A3A58"); bio.soil_bot = _hex("#15243B")
			bio.rock_lt = _hex("#4E5E8E"); bio.rock_mid = _hex("#313B66"); bio.rock_dk = _hex("#161A3A")
			bio.moss = _hex("#4FC7C7"); bio.crystal = true; bio.glint = _hex("#9FD8FF")
		"skylands":
			bio.grass_top = _hex("#AAE26E"); bio.grass_bot = _hex("#5FA846"); bio.grass_dk = _hex("#3E7A34")
			bio.soil_top = _hex("#7C6442"); bio.soil_bot = _hex("#52402A")
			bio.rock_lt = _hex("#D2C9BA"); bio.rock_mid = _hex("#A89C8C"); bio.rock_dk = _hex("#6E6456")
			bio.moss = _hex("#8FD06A")
		"forgotten_wilds":
			bio.grass_top = _hex("#6FD080"); bio.grass_bot = _hex("#2E7E46"); bio.grass_dk = _hex("#184E2C")
			bio.soil_top = _hex("#3A2E24"); bio.soil_bot = _hex("#221A14")
			bio.rock_lt = _hex("#3E5A44"); bio.rock_mid = _hex("#27402E"); bio.rock_dk = _hex("#122018")
			bio.moss = _hex("#9CF0B0"); bio.mushrooms = true; bio.glint = _hex("#C79BFF")
		"frostfall":
			bio.grass_top = _hex("#FFFFFF"); bio.grass_bot = _hex("#D7E8F2"); bio.grass_dk = _hex("#9DBACB")
			bio.soil_top = _hex("#5C6C74"); bio.soil_bot = _hex("#3A464E")
			bio.rock_lt = _hex("#90A6B4"); bio.rock_mid = _hex("#64788A"); bio.rock_dk = _hex("#39454E")
			bio.moss = _hex("#9EC4B0"); bio.snow = true; bio.frozen = true; bio.glint = _hex("#DFF4FF")
		"astral":
			bio.grass_top = _hex("#7260AC"); bio.grass_bot = _hex("#3C2E6E"); bio.grass_dk = _hex("#241A46")
			bio.soil_top = _hex("#2A1F4A"); bio.soil_bot = _hex("#160E2E")
			bio.rock_lt = _hex("#4E427E"); bio.rock_mid = _hex("#2E2456"); bio.rock_dk = _hex("#150E30")
			bio.moss = _hex("#C79BFF"); bio.star = true; bio.glint = _hex("#FFFFFF")
		"first_kingdom":
			bio.grass_top = _hex("#D8B24E"); bio.grass_bot = _hex("#9A6E2A"); bio.grass_dk = _hex("#6E4A1E")
			bio.soil_top = _hex("#6E4A1E"); bio.soil_bot = _hex("#3E2A10")
			bio.rock_lt = _hex("#B49064"); bio.rock_mid = _hex("#8A6A3E"); bio.rock_dk = _hex("#4E3A1E")
			bio.moss = _hex("#C98A3A"); bio.gold = true; bio.glint = _hex("#FFC978")
		_:
			pass
	# per-world hue nudge so repeats diverge subtly
	var tint := Color.from_hsv(pal["hue"], 0.3, 0.5)
	bio.rock_mid = (bio.rock_mid as Color).lerp(tint, 0.1)
	bio.rock_lt = (bio.rock_lt as Color).lerp(tint, 0.06)
	bio.grass_bot = (bio.grass_bot as Color).lerp(tint, 0.05)
	bio["rim"] = warm.lerp(Color(1, 1, 1, 1), 0.35)
	return bio


# ============================================================================
#  ARCHIPELAGO  — a parent that holds islands at different parallax depths
# ============================================================================

class _Archipelago extends ProcNode:
	var layers: Array = []          # [{node, base_pos, factor, bob, ph}]
	var main: ProcNode = null
	var _cam := Vector2.ZERO

	func add_layer(node: ProcNode, base_pos: Vector2, factor: float) -> void:
		add_child(node)
		node.position = base_pos
		var bob: float = 0.0
		if "bob_amp" in node:
			bob = node.bob_amp
		layers.append({"node": node, "base_pos": base_pos, "factor": factor,
			"bob": bob, "ph": Proc.hashf(seedv, "ph:%d" % layers.size()) * TAU})

	# Offset every layer by the camera according to its parallax factor. Call
	# this from your camera/pan controller each time the view moves.
	func set_camera(offset: Vector2) -> void:
		_cam = offset
		_apply()

	func main_island() -> ProcNode:
		return main

	func _apply() -> void:
		for L in layers:
			var n: Node2D = L.node
			n.position = L.base_pos - _cam * L.factor

	func _animate(_d: float) -> void:
		# backdrops breathe; the main island (bob 0) stays put so ground is stable
		for L in layers:
			if L.bob <= 0.0:
				continue
			var n: Node2D = L.node
			var y: float = sin(t * 0.4 + L.ph) * L.bob
			n.position = (L.base_pos - _cam * L.factor) + Vector2(0, y)


# ============================================================================
#  ISLAND  — the main generative body
# ============================================================================

class _Island extends ProcNode:
	var world_seed: int = 0
	var key: String = "a"
	var base_w: float = 420.0        # half-width at full growth, before regions
	var max_depth: float = 650.0     # keel depth at full growth
	var realm_id: String = "verdant"
	var lod: int = 0
	var bob_amp: float = 0.0
	var haze: float = 0.0            # backdrop atmospheric fade
	var light_dir: Vector2 = Vector2(-0.28, -1.0).normalized()
	var footprint_radius: float = 420.0
	var island_radius: float = 420.0

	var bio: Dictionary = {}
	var _n_top: FastNoiseLite
	var _n_bot: FastNoiseLite
	var _n_rock: FastNoiseLite
	var _lobes: Array = []           # [{nx, w, d}] underside stalactite lobes
	var _regions: Array = []         # [{key, dir, span, depth_scale, growth}]
	var _hangers: Array = []         # [{node, nx, kind}]
	var _glints: _Glints = null
	var _motes: _Motes = null

	# cached current geometry (set by _geom())
	var _gg: float = 1.0
	var _left: float = -420.0
	var _right: float = 420.0
	var _curD: float = 650.0
	var _grassH: float = 20.0
	var _soilH: float = 36.0
	# geometry cache: geometry is a pure function of (growth, region growths), yet
	# every public ground query, _layout_hangers and _draw all call _geom(). With a
	# busy world hitting surface_y/point/normal many times per frame this would
	# recompute g() + the region loop needlessly; we recompute only when the inputs
	# actually changed (growth creeps + region tweens both move them).
	var _geom_valid: bool = false
	var _geom_growth: float = -1.0
	var _geom_rsig: float = -1.0

	# -- build -----------------------------------------------------------------
	func _on_built() -> void:
		bio = ProcTerrain._make_bio(world_seed, key, realm_id)
		_n_top = Proc.noise(seedv, "top", 0.011, 3)
		_n_bot = Proc.noise(seedv, "bot", 0.006, 4)
		_n_rock = Proc.noise(seedv, "rock", 0.02, 3)
		_build_lobes()
		_build_hangers()
		if lod == 0:
			_glints = _Glints.new()
			_glints.setup(self)
			add_child(_glints)
			_motes = _Motes.new()
			_motes.setup(self)
			add_child(_motes)
		_layout_hangers()

	func _build_lobes() -> void:
		var n := 2 + int(Proc.rangef(seedv, "nlobe", 1.0, 3.99))
		for i in range(n):
			_lobes.append({
				"nx": Proc.rangef(seedv, "lnx:%d" % i, 0.18, 0.82),
				"w": Proc.rangef(seedv, "lw:%d" % i, 0.08, 0.2),
				"d": Proc.rangef(seedv, "ld:%d" % i, 0.22, 0.62),
			})

	func _build_hangers() -> void:
		var roots: int = [6, 3, 0][lod]
		var vines: int = [7, 3, 0][lod]
		var tufts: int = [10, 4, 0][lod]
		for i in range(roots):
			_add_hanger("root", Proc.rangef(seedv, "rtx:%d" % i, 0.2, 0.8), i)
		for i in range(vines):
			var side := 0.12 if (i % 2 == 0) else 0.88
			var nx := lerpf(side, 0.5, Proc.hashf(seedv, "vnx:%d" % i) * 0.6)
			_add_hanger("vine", nx, i)
		for i in range(tufts):
			_add_hanger("tuft", Proc.rangef(seedv, "tfx:%d" % i, 0.06, 0.94), i)

	func _add_hanger(kind: String, nx: float, i: int) -> void:
		var h := _Hanger.new()
		h.seedv = hash("%d:%s:%d" % [seedv, kind, i])
		h.kind = kind
		h.bio = bio
		h.light_dir = light_dir
		h.grow_rate = 0.0
		match kind:
			"root":
				h.length = max_depth * Proc.rangef(h.seedv, "len", 0.26, 0.55)
				h.thick = clampf(base_w * 0.022, 4.0, 13.0)
				h.amp = 0.05; h.speed = Proc.rangef(h.seedv, "sp", 0.5, 0.9)
			"vine":
				h.length = clampf(base_w * 0.26, 46.0, 170.0) * Proc.rangef(h.seedv, "len", 0.7, 1.2)
				h.thick = clampf(base_w * 0.008, 2.0, 5.0)
				h.amp = 0.16; h.speed = Proc.rangef(h.seedv, "sp", 0.7, 1.2)
			"tuft":
				h.length = clampf(base_w * 0.05, 14.0, 34.0) * Proc.rangef(h.seedv, "len", 0.8, 1.2)
				h.thick = 2.0
				h.amp = 0.1; h.speed = Proc.rangef(h.seedv, "sp", 1.0, 1.6)
		add_child(h)
		_hangers.append({"node": h, "nx": nx, "kind": kind})

	# -- geometry --------------------------------------------------------------
	func _geom() -> void:
		# Recompute only when growth or any region's growth actually moved; a
		# signature over (region count + each region's growth) + the live growth
		# lets the many per-frame ground queries share one computation.
		var rsig := float(_regions.size()) * 7.0
		for r in _regions:
			rsig += r.growth
		if _geom_valid and absf(growth - _geom_growth) < 0.00001 and absf(rsig - _geom_rsig) < 0.00001:
			return
		_geom_growth = growth
		_geom_rsig = rsig
		_geom_valid = true
		_gg = g()
		var w := base_w * lerpf(0.12, 1.0, _gg)
		var left := -w
		var right := w
		for r in _regions:
			var rg: float = ProcTerrain._ease(r.growth)
			if r.dir > 0:
				right += r.span * rg
			else:
				left -= r.span * rg
		_left = left
		_right = right
		_curD = max_depth * lerpf(0.22, 1.0, _gg)
		var span: float = max(1.0, right - left)
		_grassH = clampf(span * 0.028, 8.0, 30.0)
		_soilH = clampf(span * 0.05, 14.0, 60.0)
		island_radius = span * 0.5
		footprint_radius = island_radius

	func _edge(x: float) -> float:
		# 0 at the extreme edges, 1 toward the middle
		var span: float = max(1.0, _right - _left)
		var nx := clampf((x - _left) / span, 0.0, 1.0)
		return sin(nx * PI)

	func _top_y(x: float) -> float:
		var e := _edge(x)
		var roll := _n_top.get_noise_1d(x * 0.9) * (8.0 + 6.0 * e)
		var dome := -11.0 * e                       # crown lifts in the middle
		var shoulder := 24.0 * (1.0 - e)            # edges droop toward the cliff
		return roll + dome + shoulder

	func _depth_at(x: float) -> float:
		var span: float = max(1.0, _right - _left)
		var nx := clampf((x - _left) / span, 0.0, 1.0)
		var env := pow(sin(nx * PI), 0.72)          # 0 at edges, deep in the middle
		var base := _curD * env
		var cr := 1.0 + _n_bot.get_noise_1d(x * 0.5) * 0.4
		base *= cr
		for lb in _lobes:                           # hanging stalactite spires
			var cx: float = lerpf(_left, _right, lb.nx)
			var dx: float = (x - cx) / (span * lb.w)
			base += _curD * lb.d * exp(-dx * dx) * env
		return max(2.0, base)

	# -- draw ------------------------------------------------------------------
	func _draw() -> void:
		_geom()
		var tstep: float = [66.0, 90.0, 120.0][lod]
		var bstep: float = [42.0, 60.0, 84.0][lod]
		var span := _right - _left
		var ts := maxi(6, int(span / tstep))
		var bs := maxi(8, int(span / bstep))

		# --- full silhouette (rock body) ---
		var ctrl := PackedVector2Array()
		for i in range(ts + 1):
			var x: float = lerpf(_left, _right, float(i) / ts)
			ctrl.append(Vector2(x, _top_y(x)))
		var under := PackedVector2Array()           # kept for strata offsetting
		for i in range(bs + 1):
			var x: float = lerpf(_right, _left, float(i) / bs)
			var p := Vector2(x, _top_y(x) + _depth_at(x))
			ctrl.append(p)
			under.append(p)
		var outline := Proc.smooth_loop(ctrl, 6 if lod == 0 else 4)

		# soft contact shadow under the keel
		var deepest := Vector2((_left + _right) * 0.5, 0.0)
		for p in under:
			if p.y > deepest.y:
				deepest = p
		draw_circle(deepest + Vector2(0, 8), span * 0.22, Color(0, 0, 0, 0.12 * (1.0 - haze)))

		var rlt: Color = bio.rock_lt
		var rdk: Color = bio.rock_dk
		if haze > 0.0:
			var fog: Color = bio.get("rim", Color(1, 1, 1))
			rlt = rlt.lerp(fog, haze); rdk = rdk.lerp(fog, haze * 0.7)
		draw_polygon(outline, Proc.grad_fill(outline, rlt.lerp(bio.rock_mid, 0.5), rdk))
		draw_polyline(outline, rdk.darkened(0.2), 2.0, true)

		# --- sedimentary striations parallel to the craggy underside ---
		_draw_strata(under)
		if bio.get("mushrooms", false) and lod == 0:
			_draw_mushrooms(under, span)

		# --- soil band ---
		var soil_poly := PackedVector2Array()
		for i in range(ts + 1):
			var x: float = lerpf(_left, _right, float(i) / ts)
			soil_poly.append(Vector2(x, _top_y(x) + _grassH))
		for i in range(ts + 1):
			var x: float = lerpf(_right, _left, float(i) / ts)
			var e := _edge(x)
			soil_poly.append(Vector2(x, _top_y(x) + _grassH + _soilH * (0.4 + 0.6 * e)))
		draw_polygon(soil_poly, Proc.grad_fill(soil_poly, bio.soil_top, bio.soil_bot))

		# --- grass / snow crown with a scalloped, dripping lower edge ---
		var grass_poly := PackedVector2Array()
		for i in range(ts * 2 + 1):
			var x: float = lerpf(_left, _right, float(i) / (ts * 2))
			grass_poly.append(Vector2(x, _top_y(x) - 1.0))
		for i in range(ts * 2 + 1):
			var x: float = lerpf(_right, _left, float(i) / (ts * 2))
			var e := _edge(x)
			var scallop := (sin(x * 0.07 + seedv) * 0.5 + 0.5) * _grassH * 0.5
			var drip := maxf(0.0, _n_rock.get_noise_1d(x * 1.3)) * _grassH * 1.1
			grass_poly.append(Vector2(x, _top_y(x) + _grassH * (0.55 + 0.45 * e) + scallop + drip))
		draw_polygon(grass_poly, Proc.grad_fill(grass_poly,
			bio.grass_top, (bio.grass_bot as Color).lerp(bio.grass_dk, 0.5)))

		# seam shadow where grass meets soil, + sunlit rim on the crown
		var seam := PackedVector2Array()
		var rim := PackedVector2Array()
		for i in range(ts + 1):
			var x: float = lerpf(_left, _right, float(i) / ts)
			seam.append(Vector2(x, _top_y(x) + _grassH * 0.95))
			rim.append(Vector2(x, _top_y(x) - 0.5))
		draw_polyline(seam, Color(0, 0, 0, 0.12), 2.0, true)
		draw_polyline(rim, (bio.get("rim", Color(1, 1, 1)) as Color) * Color(1, 1, 1, 0.5), 2.0, true)

		# --- moss drip clumps along the rim, then grass blades on top ---
		if lod < 2:
			_draw_moss(span)
		if lod == 0:
			_draw_blades(span)

	func _draw_strata(under: PackedVector2Array) -> void:
		if under.size() < 3:
			return
		var layers: int = [7, 4, 2][lod]
		var step := _curD * 0.11
		var col: Color = (bio.rock_dk as Color)
		for k in range(1, layers + 1):
			var off := k * step
			var line := PackedVector2Array()
			for p: Vector2 in under:
				var limit := _top_y(p.x) + _grassH + _soilH + 4.0
				var yy: float = maxf(limit, p.y - off)
				line.append(Vector2(p.x + _n_rock.get_noise_1d(p.x + k * 13.0) * 4.0, yy))
			draw_polyline(line, Color(col.r, col.g, col.b, 0.22), 1.6, true)
		# a couple of vertical cracks near the keel
		if lod == 0:
			for c in range(2):
				var cx: float = lerpf(_left, _right, Proc.rangef(seedv, "crk:%d" % c, 0.38, 0.62))
				var d := _depth_at(cx)
				var top := _top_y(cx) + _grassH + _soilH + d * 0.3
				var crack := PackedVector2Array([
					Vector2(cx, top),
					Vector2(cx + 5, top + d * 0.2),
					Vector2(cx - 3, top + d * 0.42),
					Vector2(cx + 2, top + d * 0.55)])
				draw_polyline(crack, Color(col.r, col.g, col.b, 0.3), 1.4, true)

	func _draw_mushrooms(under: PackedVector2Array, span: float) -> void:
		var glow: Color = bio.get("glint", Color(0.7, 0.6, 1.0))
		var n := 9
		for i in range(n):
			var x: float = lerpf(_left + span * 0.1, _right - span * 0.1,
				Proc.hashf(seedv, "mush:%d" % i))
			var d := _depth_at(x)
			var y := _top_y(x) + _grassH + _soilH + d * Proc.rangef(seedv, "mushy:%d" % i, 0.12, 0.5)
			var r := Proc.rangef(seedv, "mushr:%d" % i, 2.5, 5.0)
			draw_circle(Vector2(x, y), r * 2.0, Color(glow.r, glow.g, glow.b, 0.12))
			draw_circle(Vector2(x, y), r, glow)

	func _draw_moss(span: float) -> void:
		var n: int = [16, 7][lod]
		var m: Color = bio.moss
		for i in range(n):
			var x: float = lerpf(_left + 6, _right - 6, Proc.hashf(seedv, "moss:%d" % i))
			var y := _top_y(x) + _grassH * (0.9 + 0.5 * Proc.hashf(seedv, "mossy:%d" % i))
			var rr := Proc.rangef(seedv, "mossr:%d" % i, 5.0, 12.0)
			var blob := Proc.blob(seedv, "mossb:%d" % i, rr, 7, 0.35)
			var pts := PackedVector2Array()
			for p in blob:
				pts.append(p * Vector2(1.0, 0.7) + Vector2(x, y))
			draw_colored_polygon(pts, m.darkened(0.15))
			var hi := PackedVector2Array()
			for p in blob:
				hi.append(p * Vector2(0.7, 0.45) + Vector2(x, y - rr * 0.3))
			draw_colored_polygon(hi, m.lightened(0.15))

	func _draw_blades(span: float) -> void:
		if bio.get("snow", false):
			return   # snow crown has no blades
		var leanx: float = clampf(-light_dir.x, -1.0, 1.0)
		var step := clampf(span / 60.0, 14.0, 34.0)
		var x := _left + 10.0
		var gtop: Color = bio.grass_top
		var gdk: Color = bio.grass_dk
		var idx := 0
		while x < _right - 10.0:
			var jx := x + Proc.rangef(seedv, "blx:%d" % idx, -5.0, 5.0)
			var h := _grassH * Proc.rangef(seedv, "blh:%d" % idx, 1.1, 2.3)
			var base := Vector2(jx, _top_y(jx))
			var tip := base + Vector2(leanx * h * 0.45, -h)
			var tri := PackedVector2Array([
				base + Vector2(-2.0, 0), base + Vector2(2.0, 0), tip])
			draw_colored_polygon(tri, gdk)
			var tri2 := PackedVector2Array([
				base + Vector2(-1.0, 0), base + Vector2(1.4, 0),
				tip + Vector2(leanx * 2.0, 1.0)])
			draw_colored_polygon(tri2, gtop)
			x += step
			idx += 1

	# -- growth / layout -------------------------------------------------------
	func _on_growth() -> void:
		_layout_hangers()

	func _layout_hangers() -> void:
		_geom()
		for h in _hangers:
			var node: ProcNode = h.node
			var nx: float = h.nx
			# regions off the active extent hide until the land reaches them
			var active := nx > 0.015 and nx < 0.985
			node.visible = active
			if not active:
				continue
			var x: float = lerpf(_left, _right, nx)
			var sy := _top_y(x)
			match h.kind:
				"tuft":
					node.position = Vector2(x, sy - 1.0)
				"vine":
					node.position = Vector2(x, sy + _grassH * 0.7)
				_:
					var d := _depth_at(x)
					var frac: float = lerpf(0.22, 0.55, Proc.hashf(seedv, "rtd:" + str(nx)))
					node.position = Vector2(x, sy + _grassH + _soilH + d * frac)
			node.set_growth(growth)

	# -- animation -------------------------------------------------------------
	func _animate(_d: float) -> void:
		# The body is deliberately still (stable ground query). Life is carried by
		# the swaying hanger children + the glint/mote children, which animate
		# themselves. Nothing to do per frame here on the body itself.
		pass

	# ======================================================================
	#  PUBLIC API — ground query & expansion
	# ======================================================================

	# World-space-local surface height at local x (feet-at-origin placement).
	func surface_y(x: float) -> float:
		_geom()
		return _top_y(clampf(x, _left, _right))

	func surface_point(x: float) -> Vector2:
		_geom()
		var cx := clampf(x, _left, _right)
		return Vector2(cx, _top_y(cx))

	# Upward ground normal at local x (for tilting things that follow slope).
	func surface_normal(x: float) -> Vector2:
		_geom()
		var cx := clampf(x, _left, _right)
		var dx := 3.0
		var dy := _top_y(cx + dx) - _top_y(cx - dx)
		return Vector2(dy, -2.0 * dx).normalized()

	# Current left/right ground span (grows as regions unfurl).
	func ground_extents() -> Vector2:
		_geom()
		return Vector2(_left, _right)

	func contains_x(x: float) -> bool:
		_geom()
		return x >= _left and x <= _right

	# A seeded x somewhere on plantable ground (kept off the very edges).
	func random_surface_x(key_s: String) -> float:
		_geom()
		return lerpf(_left + island_radius * 0.12, _right - island_radius * 0.12,
			Proc.hashf(seedv, "rsx:" + key_s))

	# Grow the landmass: append a new region that unfurls outward over `dur`
	# seconds (a Rootwork puzzle reward). dir +1 extends right, -1 left.
	func add_region(region_key: String, dir: int = 1, span: float = -1.0,
			depth_scale: float = 1.0, dur: float = 6.0) -> void:
		var s := span
		if s < 0.0:
			s = base_w * Proc.rangef(seedv, "rspan:" + region_key, 0.45, 0.9)
		var r := {"key": region_key, "dir": signi(dir) if dir != 0 else 1,
			"span": s, "depth_scale": depth_scale, "growth": 0.0}
		_regions.append(r)
		# new hangers growing on the fresh land
		if lod == 0:
			var base_nx := 0.92 if r.dir > 0 else 0.08
			_add_hanger("tuft", base_nx, _hangers.size())
			_add_hanger("vine", base_nx, _hangers.size())
		var cb := func(v: float) -> void:
			r["growth"] = v
			_refresh_shape()
		var tw := create_tween().set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_OUT)
		tw.tween_method(cb, 0.0, 1.0, dur)

	func grow_landmass(region_key: String, dir: int = 1) -> void:
		add_region(region_key, dir)

	func region_count() -> int:
		return _regions.size()

	func _refresh_shape() -> void:
		queue_redraw()
		_layout_hangers()

	# Re-tint to a (possibly new) realm; rebuilds the biome palette.
	func set_realm(new_realm: String) -> void:
		realm_id = new_realm
		bio = ProcTerrain._make_bio(world_seed, key, realm_id)
		for h in _hangers:
			h.node.bio = bio
			h.node.queue_redraw()
		if _glints:
			_glints.col = bio.get("glint", Color(0, 0, 0, 0))
			_glints.queue_redraw()
		queue_redraw()

	# Adaptation hook (CONVENTIONS §2.3a): honour an optional placement context.
	func apply_context(ctx: Dictionary) -> void:
		if ctx.has("light_dir"):
			light_dir = (ctx["light_dir"] as Vector2).normalized()
		if ctx.has("local_palette"):
			var lp: Dictionary = ctx["local_palette"]
			if lp.has("base"):
				bio.grass_bot = (bio.grass_bot as Color).lerp(lp["base"], 0.2)
				bio.rock_mid = (bio.rock_mid as Color).lerp(lp["base"], 0.12)
		queue_redraw()


# ============================================================================
#  HANGER  — a single dangling root, hanging vine, or upright grass tuft
# ============================================================================

class _Hanger extends ProcNode:
	var kind: String = "root"
	var length: float = 120.0
	var thick: float = 8.0
	var amp: float = 0.12            # sway amplitude (radians)
	var speed: float = 0.8
	var bio: Dictionary = {}
	var light_dir: Vector2 = Vector2(-0.3, -1.0)
	var _lean: float = 0.0

	func _on_built() -> void:
		_lean = Proc.rangef(seedv, "lean", -0.12, 0.12) + light_dir.x * 0.12

	func _animate(_d: float) -> void:
		rotation = _lean + sin(t * speed + phase) * amp * (0.3 + 0.7 * g())

	func _draw() -> void:
		var gg := g()
		if gg <= 0.01:
			return
		match kind:
			"tuft":
				_draw_tuft(gg)
			"vine":
				_draw_vine(gg)
			_:
				_draw_root(gg)

	func _draw_root(gg: float) -> void:
		var L := length * lerpf(0.3, 1.0, gg)
		var w0 := thick * lerpf(0.5, 1.0, gg)
		var steps := 9
		var curl := Proc.rangef(seedv, "curl", -0.5, 0.5)
		var left := PackedVector2Array()
		var right := PackedVector2Array()
		for i in range(steps + 1):
			var f := float(i) / steps
			var yy := f * L
			var cx := sin(f * PI * 0.5) * L * 0.1 * curl
			var ww := w0 * (1.0 - f * 0.85)
			left.append(Vector2(cx - ww, yy))
			right.append(Vector2(cx + ww, yy))
		var poly := PackedVector2Array()
		for p in left:
			poly.append(p)
		for i in range(right.size()):
			poly.append(right[right.size() - 1 - i])
		var c0: Color = (bio.get("soil_top", Color(0.4, 0.3, 0.2)) as Color).lightened(0.05)
		var c1: Color = bio.get("soil_bot", Color(0.3, 0.2, 0.12))
		draw_polygon(poly, Proc.grad_fill(poly, c0, c1))
		# a rootlet or two near the tip
		if gg > 0.5:
			var tip := Vector2(sin(PI * 0.5) * L * 0.1 * curl, L)
			for s in range(2):
				var sgn := 1.0 if s == 0 else -1.0
				var rl := PackedVector2Array([
					tip,
					tip + Vector2(sgn * w0 * 1.5, L * 0.12),
					tip + Vector2(sgn * w0 * 2.4, L * 0.26)])
				draw_polyline(rl, c1, maxf(1.0, w0 * 0.4), true)

	func _draw_vine(gg: float) -> void:
		var L := length * lerpf(0.3, 1.0, gg)
		var steps := 12
		var curl := Proc.rangef(seedv, "curl", -1.0, 1.0)
		var line := PackedVector2Array()
		for i in range(steps + 1):
			var f := float(i) / steps
			line.append(Vector2(sin(f * PI) * L * 0.14 * curl, f * L))
		var cvine: Color = (bio.get("grass_bot", Color(0.3, 0.5, 0.25)) as Color)
		draw_polyline(line, cvine.darkened(0.1), maxf(1.5, thick), true)
		# leaves along the vine
		var leafc: Color = bio.get("grass_top", Color(0.5, 0.7, 0.3))
		var nleaf := int(3 + gg * 4)
		for i in range(nleaf):
			var f := float(i + 1) / (nleaf + 1)
			var p := Vector2(sin(f * PI) * L * 0.14 * curl, f * L)
			var sgn := 1.0 if (i % 2 == 0) else -1.0
			var ls := clampf(L * 0.12, 4.0, 14.0) * (0.6 + 0.4 * gg)
			var leaf := PackedVector2Array([
				p,
				p + Vector2(sgn * ls, -ls * 0.3),
				p + Vector2(sgn * ls * 1.4, ls * 0.3),
				p + Vector2(sgn * ls * 0.4, ls * 0.6)])
			draw_colored_polygon(Proc.smooth_loop(leaf, 5), leafc)
		# tip leaf
		var tip := Vector2(sin(PI) * L * 0.14 * curl, L)
		var tl := Proc.blob(seedv, "tipleaf", clampf(L * 0.1, 4.0, 12.0) * (0.5 + 0.5 * gg), 6, 0.3)
		var tlp := PackedVector2Array()
		for p in tl:
			tlp.append(p * Vector2(0.7, 1.0) + tip + Vector2(0, L * 0.06))
		draw_colored_polygon(tlp, leafc.lightened(0.08))

	func _draw_tuft(gg: float) -> void:
		var L := length * lerpf(0.3, 1.0, gg)
		var n := 5
		var gtop: Color = bio.get("grass_top", Color(0.55, 0.75, 0.3))
		var gdk: Color = bio.get("grass_dk", Color(0.2, 0.4, 0.18))
		for i in range(n):
			var f := float(i) / (n - 1) - 0.5
			var base := Vector2(f * thick * 4.0, 0.0)
			var h := L * (0.7 + 0.3 * (1.0 - absf(f) * 1.6))
			var tip := base + Vector2(f * h * 0.5, -h)
			var blade := PackedVector2Array([
				base + Vector2(-1.5, 0), base + Vector2(1.5, 0), tip])
			draw_colored_polygon(blade, gdk if (i % 2 == 0) else gtop)


# ============================================================================
#  GLINTS  — crystal / star / gold / ice specks on the rock face, pulsing
# ============================================================================

class _Glints extends Node2D:
	var specks: Array = []           # [{pos, r}]
	var col: Color = Color(0, 0, 0, 0)
	var _tt: float = 0.0
	var _ph: float = 0.0

	func setup(isl: _Island) -> void:
		col = isl.bio.get("glint", Color(0, 0, 0, 0))
		if col.a <= 0.0:
			return
		_ph = Proc.hashf(isl.seedv, "glph") * TAU
		isl._geom()
		var n := 14
		for i in range(n):
			var x: float = lerpf(isl._left + 20.0, isl._right - 20.0,
				Proc.hashf(isl.seedv, "glx:%d" % i))
			var d := isl._depth_at(x)
			var y := isl._top_y(x) + isl._grassH + isl._soilH + d * Proc.rangef(isl.seedv, "gly:%d" % i, 0.1, 0.6)
			specks.append({"pos": Vector2(x, y),
				"r": Proc.rangef(isl.seedv, "glr:%d" % i, 1.2, 3.2),
				"p": Proc.hashf(isl.seedv, "glp:%d" % i) * TAU})

	func _process(delta: float) -> void:
		_tt += delta

	func _draw() -> void:
		if col.a <= 0.0:
			return
		for s in specks:
			var a: float = 0.4 + 0.6 * (0.5 + 0.5 * sin(_tt * 1.6 + s.p + _ph))
			var cc := Color(col.r, col.g, col.b, a)
			draw_circle(s.pos, s.r * 2.2, Color(col.r, col.g, col.b, a * 0.25))
			draw_circle(s.pos, s.r, cc)

	func _ready() -> void:
		set_process(true)
		# repaint the pulse cheaply (tiny node, a handful of circles)
		var tw := create_tween().set_loops()
		tw.tween_callback(queue_redraw).set_delay(1.0 / 20.0)


# ============================================================================
#  MOTES  — dust / spores drifting up off the island underside (foreground only)
# ============================================================================

class _Motes extends Node2D:
	# Dust / spores drifting up off the underside. Fully Proc-seeded (CONVENTIONS
	# rule 3) exactly like _Glints — no engine randf anywhere in the generation or
	# respawn path, so the drifting field regenerates identically for a given world
	# seed instead of scattering differently on every run.
	var motes: Array = []            # [{pos, vel, r, a, x0, slot, cyc}]
	var col: Color = Color(1, 1, 1, 0.5)
	var seedv: int = 1
	var _tt: float = 0.0
	var _span := 400.0
	var _top := 0.0
	var _bot := 400.0

	func setup(isl: _Island) -> void:
		seedv = isl.seedv
		isl._geom()
		_span = isl._right - isl._left
		_top = isl._top_y((isl._left + isl._right) * 0.5)
		_bot = _top + isl._curD
		col = (isl.bio.get("rim", Color(1, 1, 1)) as Color)
		col.a = 0.5
		var n := 10
		for i in range(n):
			_spawn(isl, i, true)

	func _spawn(isl: _Island, i: int, scatter: bool) -> void:
		# every field seeded from (seedv, per-mote key) — deterministic + unique.
		var fx := Proc.hashf(seedv, "mx:%d" % i)
		var x: float = lerpf(isl._left * 0.7, isl._right * 0.7, fx)
		var fy := Proc.hashf(seedv, "my:%d" % i) if scatter else 1.0
		var jitter := Proc.hashf(seedv, "moy:%d" % i) * _bot * 0.5
		motes.append({
			"pos": Vector2(x, _top + fy * _bot * 0.3 + jitter),
			"vel": Vector2(Proc.rangef(seedv, "mvx:%d" % i, -6.0, 6.0),
				Proc.rangef(seedv, "mvy:%d" % i, -14.0, -4.0)),
			"r": Proc.rangef(seedv, "mr:%d" % i, 1.0, 2.6),
			"a": Proc.rangef(seedv, "ma:%d" % i, 0.2, 0.6),
			"x0": x,
			"slot": i,
			"cyc": 0})

	func _process(delta: float) -> void:
		_tt += delta
		for m in motes:
			m.pos += m.vel * delta
			m.pos.x = m.x0 + sin(m.pos.y * 0.02) * 10.0
			if m.pos.y < _top - _span * 0.3:
				# deterministic wrap: a fresh seeded offset keyed on (slot, cycle).
				m.cyc += 1
				m.pos.y = _bot + Proc.hashf(seedv, "mwrap:%d:%d" % [m.slot, m.cyc]) * _span * 0.2
		queue_redraw()

	func _draw() -> void:
		for m in motes:
			# a gentle, cheap twinkle so the motes shimmer as they drift (desynced
			# per mote via its slot) — transform-free, just an alpha wobble.
			var tw: float = 0.78 + 0.22 * sin(_tt * 1.3 + float(m.slot) * 1.7)
			draw_circle(m.pos, m.r, Color(col.r, col.g, col.b, m.a * tw))

	func _ready() -> void:
		set_process(true)
