class_name ProcTrees extends RefCounted
# ProcTrees — recognizable, limitless, living TREES built entirely from math.
#
# No imported images. A tree is grown from an L-system-ish parameter set per
# species (oak, pine, birch, willow, blossom, fruit, palm, ancient, maple,
# cypress): a recursive hierarchy of tapered, gently-curved branch polygons, with
# blobby layered gradient canopies, soft leaf clumps, blossoms, fruit, conifer
# skirts, palm fronds or hanging willow fronds depending on the species.
#
# GROWTH is first-class and continuous. The full mature skeleton is built once;
# the overall tree scales 10%->100% across its life (g()), and deeper branches
# APPEAR and extend progressively as growth climbs — so a seed unfurls into a
# two-leaf sprout (~0.1), then a slender sapling (~0.4), then a full crowned tree
# (1.0), every stage interpolated smoothly and redrawn only when the shape
# actually changes.
#
# ALIVE via pure transform animation: a layered-sine wind drives every limb's
# rotation around its rest angle, compounding down the hierarchy so trunks sway
# a little and leaf-laden tips sway a lot — with per-instance phase so no two
# trees breathe in lockstep. No per-frame redraw, no per-frame allocation.
#
# Shape contract (CONVENTIONS.md): feet at origin (y=0), body drawn at negative
# y; portrait; seeded + deterministic from (world_seed, key); exposes
# footprint_radius and accepts a context Dictionary for local adaptation.
#
# -- public factory API -------------------------------------------------------
#   ProcTrees.make(world_seed, key, species="oak", season="summer") -> ProcNode
#   ProcTrees.make_random(world_seed, key, season="summer") -> ProcNode
#   ProcTrees.make_for_realm(world_seed, key, realm_id="verdant", season="") -> ProcNode
#   ProcTrees.sprout(world_seed, key, species="oak", season="summer") -> ProcNode
#   ProcTrees.species_list() -> PackedStringArray
#   ProcTrees.seasons() -> PackedStringArray

const SPECIES := ["oak", "maple", "birch", "willow", "blossom", "fruit",
	"pine", "cypress", "palm", "ancient"]
const SEASONS := ["spring", "summer", "autumn", "winter"]

# ---------------------------------------------------------------------------
# Factories
# ---------------------------------------------------------------------------

static func make(world_seed: int, key: String, species: String = "oak", season: String = "summer") -> ProcNode:
	var n := _Tree.new()
	n.seedv = hash("%d:tree:%s" % [world_seed, key])
	n.species = species if species in SPECIES else "oak"
	n.season = season if season in SEASONS else "summer"
	return n

# Seed-pick a species from the key, so a world's scatter is deterministic.
static func make_random(world_seed: int, key: String, season: String = "summer") -> ProcNode:
	var i := int(Proc.hashf(world_seed, "treepick:" + key) * SPECIES.size())
	return make(world_seed, key, SPECIES[clampi(i, 0, SPECIES.size() - 1)], season)

# Pick a species (and a sensible default season) that fits a realm's mood.
static func make_for_realm(world_seed: int, key: String, realm_id: String = "verdant", season: String = "") -> ProcNode:
	var pool := _realm_species(realm_id)
	var i := int(Proc.hashf(world_seed, "realmtree:" + key) * pool.size())
	var sp: String = pool[clampi(i, 0, pool.size() - 1)]
	var se := season
	if se == "":
		se = _realm_season(realm_id, world_seed, key)
	return make(world_seed, key, sp, se)

# A tree that begins as a just-planted seed and unfurls on spawn.
static func sprout(world_seed: int, key: String, species: String = "oak", season: String = "summer") -> ProcNode:
	var n := make(world_seed, key, species, season)
	n.growth = 0.0
	(n as _Tree)._pop_on_ready = true
	return n

static func species_list() -> PackedStringArray:
	return PackedStringArray(SPECIES)

static func seasons() -> PackedStringArray:
	return PackedStringArray(SEASONS)

static func _realm_species(realm_id: String) -> Array:
	match realm_id:
		"crystal_hollow": return ["pine", "cypress", "ancient"]
		"skylands": return ["blossom", "birch", "palm"]
		"forgotten_wilds": return ["ancient", "willow", "oak", "maple"]
		"frostfall": return ["pine", "cypress"]
		"astral": return ["blossom", "ancient"]
		"first_kingdom": return ["ancient", "oak", "palm"]
		_: return ["oak", "birch", "maple", "willow", "blossom", "fruit"]

static func _realm_season(realm_id: String, ws: int, key: String) -> String:
	if realm_id == "frostfall":
		return "winter"
	# Everywhere else, a gentle seeded spread across the warm seasons.
	var r := ["spring", "summer", "summer", "autumn"]
	var i := int(Proc.hashf(ws, "season:" + key) * r.size())
	return r[clampi(i, 0, r.size() - 1)]

# ---------------------------------------------------------------------------
# small static geometry helpers (no per-frame allocation on the hot path)
# ---------------------------------------------------------------------------

static func _scaletr(pts: PackedVector2Array, s: float, off: Vector2) -> PackedVector2Array:
	var o := PackedVector2Array()
	o.resize(pts.size())
	for i in pts.size():
		o[i] = pts[i] * s + off
	return o

static func _flat(n: int, c: Color) -> PackedColorArray:
	var a := PackedColorArray()
	a.resize(n)
	for i in n:
		a[i] = c
	return a

static func _quad(a: Vector2, b: Vector2, c: Vector2, t: float) -> Vector2:
	var u := 1.0 - t
	return a * (u * u) + b * (2.0 * u * t) + c * (t * t)

# A unit-radius blob (centred at origin, radius ~1). Cheap, cached at build.
static func _unit_blob(seedv: int, key: String, lobes: int, wobble: float) -> PackedVector2Array:
	return Proc.blob(seedv, "canblob:" + key, 1.0, lobes, wobble)

# ===========================================================================
# _Tree — the root ProcNode. Owns colours, the limb hierarchy and the wind.
# ===========================================================================
class _Tree extends ProcNode:
	var species := "oak"
	var season := "summer"
	var footprint_radius := 90.0
	var _pop_on_ready := false
	var _frozen := false

	var cfg := {}                       # shared style + colour dict (limbs read it)
	var _ctx := {}                      # adaptation context from the world builder
	var _trunk: _Limb = null
	var _limbs: Array = []              # flat list for cheap per-frame sway
	var _global_size := 1.0
	var _light_dir := Vector2(-0.35, -1.0).normalized()
	var _wind_seed := 0.0

	func _on_built() -> void:
		_wind_seed = Proc.hashf(seedv, "wind") * TAU
		_build_cfg()
		if _ctx.size() > 0:
			_absorb_context(_ctx)
		_compute_colours()
		set_grow_minutes(float(cfg.get("grow_minutes", 90.0)))
		_build_skeleton()
		_global_size = lerpf(0.10, 1.0, g())
		_relayout()
		if _pop_on_ready:
			pop_in(1.2)

	# ---- public adaptation / state ----------------------------------------

	# {local_palette: Dictionary, light_dir: Vector2, elevation: float (0..1),
	#  neighbours: int}. Safe to call before or after the node enters the tree.
	func apply_context(ctx: Dictionary) -> void:
		_ctx = ctx.duplicate()
		if is_inside_tree() and cfg.size() > 0:
			_absorb_context(_ctx)
			_compute_colours()
			if _trunk:
				_relayout()
				_queue_all()

	# Mint: press the flower in the book — stop growth, go glassy-still.
	func set_frozen(b: bool) -> void:
		_frozen = b
		grow_rate = 0.0 if b else (1.0 / (float(cfg.get("grow_minutes", 90.0)) * 60.0))
		_queue_all()

	func _absorb_context(ctx: Dictionary) -> void:
		if ctx.has("light_dir"):
			var ld: Vector2 = ctx["light_dir"]
			if ld.length() > 0.01:
				_light_dir = ld.normalized()
		if ctx.has("elevation"):
			# Higher / more exposed ground -> a touch smaller & windier.
			var e := clampf(float(ctx["elevation"]), 0.0, 1.0)
			cfg["exposure"] = lerpf(1.0, 1.28, e)
			cfg["size_mul"] = lerpf(1.04, 0.86, e)
		if ctx.has("neighbours"):
			# Sheltered clusters run a little fuller. WorldSpace supplies an ARRAY of
			# neighbour descriptors; tolerate a plain count too.
			var nbv = ctx["neighbours"]
			var nb_raw: int = (nbv as Array).size() if nbv is Array else int(nbv)
			var nb := clampi(nb_raw, 0, 6)
			cfg["fullness"] = lerpf(1.0, 1.1, float(nb) / 6.0)

	# ---- style parameter set (the L-system-ish genome) ---------------------

	func _build_cfg() -> void:
		var c := {
			"trunk_len": 220.0, "trunk_base_w": 30.0, "trunk_tip_w": 13.0,
			"lean": Proc.rangef(seedv, "lean", -0.05, 0.05),
			"curve": 0.05, "max_depth": 3,
			"children": [3, 2, 2], "spread": 0.95, "up_bias": 0.45,
			"len_falloff": 0.72, "w_falloff": 0.62,
			"style": "blob", "canopy_scale": 0.42, "clumps": 3,
			"leaf_hue": 0.30, "leaf_sat": 0.5, "leaf_val": 0.62,
			"bark": "brown", "sway_amp": 0.028, "sway_speed": 1.05,
			"grow_minutes": 90.0, "skirts": 7,
			"exposure": 1.0, "size_mul": 1.0, "fullness": 1.0,
		}
		match species:
			"oak":
				c.trunk_len = 220.0; c.trunk_base_w = 34.0; c.trunk_tip_w = 14.0
				c.max_depth = 3; c.children = [3, 2, 2]; c.spread = 1.0; c.up_bias = 0.4
				c.canopy_scale = 0.46; c.clumps = 3; c.curve = 0.06
				c.leaf_hue = 0.29; c.leaf_sat = 0.52; c.leaf_val = 0.6
				c.bark = "oak"; c.grow_minutes = 95.0
			"maple":
				c.trunk_len = 210.0; c.trunk_base_w = 30.0; c.trunk_tip_w = 13.0
				c.max_depth = 3; c.children = [3, 2, 2]; c.spread = 0.92; c.up_bias = 0.5
				c.canopy_scale = 0.44; c.clumps = 3
				c.leaf_hue = 0.11; c.leaf_sat = 0.62; c.leaf_val = 0.72
				c.bark = "brown"; c.grow_minutes = 90.0
			"birch":
				c.trunk_len = 258.0; c.trunk_base_w = 20.0; c.trunk_tip_w = 9.0
				c.max_depth = 3; c.children = [2, 2, 2]; c.spread = 0.55; c.up_bias = 0.7
				c.style = "sparse"; c.canopy_scale = 0.3; c.clumps = 2; c.curve = 0.03
				c.leaf_hue = 0.26; c.leaf_sat = 0.5; c.leaf_val = 0.74
				c.bark = "birch"; c.sway_amp = 0.04; c.sway_speed = 1.3; c.grow_minutes = 80.0
			"willow":
				c.trunk_len = 180.0; c.trunk_base_w = 32.0; c.trunk_tip_w = 14.0
				c.max_depth = 2; c.children = [4, 3]; c.spread = 1.35; c.up_bias = 0.2
				c.style = "droop"; c.canopy_scale = 0.3; c.curve = 0.14
				c.leaf_hue = 0.27; c.leaf_sat = 0.48; c.leaf_val = 0.66
				c.bark = "grey"; c.sway_amp = 0.05; c.sway_speed = 0.8; c.grow_minutes = 115.0
			"blossom":
				c.trunk_len = 178.0; c.trunk_base_w = 26.0; c.trunk_tip_w = 11.0
				c.max_depth = 3; c.children = [3, 2, 2]; c.spread = 1.05; c.up_bias = 0.35
				c.style = "blossom"; c.canopy_scale = 0.42; c.clumps = 3; c.curve = 0.09
				c.leaf_hue = 0.3; c.leaf_sat = 0.4; c.leaf_val = 0.62
				c.bark = "grey"; c.sway_amp = 0.03; c.grow_minutes = 90.0
			"fruit":
				c.trunk_len = 158.0; c.trunk_base_w = 26.0; c.trunk_tip_w = 12.0
				c.max_depth = 3; c.children = [3, 2, 2]; c.spread = 1.05; c.up_bias = 0.45
				c.style = "fruit"; c.canopy_scale = 0.44; c.clumps = 3; c.curve = 0.07
				c.leaf_hue = 0.31; c.leaf_sat = 0.55; c.leaf_val = 0.58
				c.bark = "brown"; c.grow_minutes = 85.0
			"pine":
				c.trunk_len = 300.0; c.trunk_base_w = 26.0; c.trunk_tip_w = 6.0
				c.max_depth = 1; c.children = [0]; c.spread = 0.4; c.up_bias = 0.8
				c.style = "conifer"; c.canopy_scale = 0.4; c.skirts = 8; c.curve = 0.015
				c.leaf_hue = 0.37; c.leaf_sat = 0.5; c.leaf_val = 0.5
				c.bark = "pine"; c.sway_amp = 0.02; c.sway_speed = 0.9; c.grow_minutes = 150.0
			"cypress":
				c.trunk_len = 330.0; c.trunk_base_w = 22.0; c.trunk_tip_w = 5.0
				c.max_depth = 1; c.children = [0]; c.spread = 0.3; c.up_bias = 0.9
				c.style = "conifer"; c.canopy_scale = 0.26; c.skirts = 11; c.curve = 0.01
				c.leaf_hue = 0.39; c.leaf_sat = 0.52; c.leaf_val = 0.44
				c.bark = "pine"; c.sway_amp = 0.016; c.sway_speed = 0.8; c.grow_minutes = 150.0
			"palm":
				c.trunk_len = 300.0; c.trunk_base_w = 24.0; c.trunk_tip_w = 14.0
				c.max_depth = 0; c.children = [0]; c.spread = 0.0; c.up_bias = 1.0
				c.style = "fan"; c.canopy_scale = 0.62; c.curve = 0.22
				c.lean = Proc.rangef(seedv, "lean", 0.04, 0.16) * (1.0 if Proc.hashf(seedv, "flip") < 0.5 else -1.0)
				c.leaf_hue = 0.33; c.leaf_sat = 0.6; c.leaf_val = 0.62
				c.bark = "palm"; c.sway_amp = 0.035; c.sway_speed = 0.95; c.grow_minutes = 120.0
			"ancient":
				c.trunk_len = 278.0; c.trunk_base_w = 56.0; c.trunk_tip_w = 20.0
				c.max_depth = 4; c.children = [4, 3, 2, 2]; c.spread = 1.15; c.up_bias = 0.35
				c.canopy_scale = 0.5; c.clumps = 3; c.curve = 0.1
				c.lean = Proc.rangef(seedv, "lean", -0.08, 0.08)
				c.leaf_hue = 0.3; c.leaf_sat = 0.54; c.leaf_val = 0.52
				c.bark = "ancient"; c.sway_amp = 0.016; c.sway_speed = 0.6; c.grow_minutes = 480.0
		cfg = c
		# Mature footprint for placement: roughly the crown half-width.
		footprint_radius = c.trunk_len * c.canopy_scale * 1.25

	# ---- colour, season and local-palette drift ---------------------------

	func _compute_colours() -> void:
		var pal := Proc.palette(seedv, "tree")
		var h: float = cfg.leaf_hue
		var s: float = cfg.leaf_sat
		var v: float = cfg.leaf_val
		# per-instance variation so a grove isn't uniform
		h = fposmod(h + Proc.rangef(seedv, "hvar", -0.02, 0.02), 1.0)
		s = clampf(s + Proc.rangef(seedv, "svar", -0.06, 0.06), 0.1, 1.0)
		v = clampf(v + Proc.rangef(seedv, "vvar", -0.05, 0.05), 0.1, 1.0)

		var top := Color.from_hsv(h, s * 0.85, min(1.0, v + 0.16))
		var bot := Color.from_hsv(fposmod(h + 0.02, 1.0), min(1.0, s + 0.08), v * 0.78)
		var alt := Color.from_hsv(fposmod(h - 0.03, 1.0), s, v * 0.92)
		var bloom := Color(1, 1, 1)
		var bloom_amt := 0.0
		var fruit_col := Color(0.82, 0.16, 0.14)
		var snow := false
		var bare := false
		var deciduous: bool = cfg.style in ["blob", "sparse", "droop", "fruit", "blossom"]

		match season:
			"spring":
				top = top.lightened(0.14)
				bot = bot.lightened(0.05)
				if species == "blossom":
					bloom = Color.from_hsv(fposmod(0.95 + Proc.rangef(seedv, "bl", -0.04, 0.06), 1.0), 0.28, 0.99)
					bloom_amt = 0.9
				elif species == "fruit":
					bloom = Color(1.0, 0.97, 0.98)
					bloom_amt = 0.5
			"summer":
				pass
			"autumn":
				if deciduous:
					var hh: float = [0.09, 0.05, 0.02, 0.12][int(Proc.hashf(seedv, "fall") * 4.0) % 4]
					top = Color.from_hsv(hh, 0.7, 0.86)
					bot = Color.from_hsv(fposmod(hh - 0.02, 1.0), 0.82, 0.62)
					alt = Color.from_hsv(0.02, 0.75, 0.74)
					if species == "fruit":
						fruit_col = Color(0.78, 0.22, 0.1)
			"winter":
				snow = true
				if deciduous:
					bare = true
				else:
					top = top.darkened(0.08)
					bot = bot.darkened(0.08)

		# Blend 25% toward the local realm palette, keep the species legible.
		var local = _ctx.get("local_palette", null)
		if local is Dictionary and local.has("base"):
			var lb: Color = local["base"]
			top = top.lerp(lb.lightened(0.2), 0.22)
			bot = bot.lerp(lb, 0.22)
			alt = alt.lerp(lb, 0.2)

		# Bark palette
		var bark_top := Color(0.42, 0.3, 0.2)
		var bark_bot := Color(0.24, 0.16, 0.1)
		var mark := Color(0.1, 0.08, 0.07)
		match String(cfg.bark):
			"oak":
				bark_top = Color(0.46, 0.34, 0.23); bark_bot = Color(0.26, 0.18, 0.12)
			"brown":
				bark_top = Color(0.5, 0.37, 0.24); bark_bot = Color(0.3, 0.2, 0.12)
			"grey":
				bark_top = Color(0.52, 0.5, 0.47); bark_bot = Color(0.33, 0.31, 0.3)
			"birch":
				bark_top = Color(0.95, 0.95, 0.93); bark_bot = Color(0.8, 0.82, 0.82)
				mark = Color(0.18, 0.17, 0.16)
			"pine":
				bark_top = Color(0.46, 0.27, 0.19); bark_bot = Color(0.28, 0.15, 0.1)
			"palm":
				bark_top = Color(0.62, 0.47, 0.3); bark_bot = Color(0.42, 0.3, 0.18)
			"ancient":
				bark_top = Color(0.46, 0.4, 0.33); bark_bot = Color(0.24, 0.2, 0.16)

		cfg["leaf_top"] = top
		cfg["leaf_bot"] = bot
		cfg["leaf_alt"] = alt
		cfg["bloom"] = bloom
		cfg["bloom_amt"] = bloom_amt
		cfg["fruit_col"] = fruit_col
		cfg["snow"] = snow
		cfg["bare"] = bare
		cfg["bark_top"] = bark_top
		cfg["bark_bot"] = bark_bot
		cfg["bark_mark"] = mark
		cfg["bark_edge"] = bark_bot.darkened(0.3)
		cfg["light"] = _light_dir

	# ---- build the mature skeleton once ------------------------------------

	func _build_skeleton() -> void:
		_limbs.clear()
		var size_mul: float = cfg.get("size_mul", 1.0) * cfg.get("fullness", 1.0)
		_trunk = _Limb.new()
		_trunk._tree = self
		_trunk.cfg = cfg
		_trunk.depth = 0
		_trunk.grow_in = -1.0
		_trunk.full_length = float(cfg.trunk_len) * size_mul
		_trunk.base_w = float(cfg.trunk_base_w) * size_mul
		_trunk.tip_w = float(cfg.trunk_tip_w) * size_mul
		_trunk.curve = float(cfg.curve) * (1.0 if Proc.hashf(seedv, "tcurve") < 0.5 else -1.0)
		_trunk.rest_angle = float(cfg.lean)
		_trunk.is_tip = int(cfg.max_depth) == 0
		_trunk.bears_canopy = cfg.style in ["conifer", "fan"]
		_trunk._bp = Proc.hashf(seedv, "bp0") * TAU
		_trunk.sway_k = float(cfg.sway_amp) * 0.35
		_setup_clumps(_trunk, "c0")
		add_child(_trunk)
		_limbs.append(_trunk)
		_grow_children(_trunk, 1, "b")

	func _grow_children(parent: _Limb, depth: int, key: String) -> void:
		var maxd: int = int(cfg.max_depth)
		if depth > maxd:
			return
		var counts: Array = cfg.children
		var n := 0
		if depth - 1 < counts.size():
			n = int(counts[depth - 1])
		if n <= 0:
			return
		var size_mul: float = cfg.get("size_mul", 1.0) * cfg.get("fullness", 1.0)
		var spread: float = float(cfg.spread) * (1.0 - 0.18 * float(depth - 1))
		var lf: float = float(cfg.len_falloff)
		var wf: float = float(cfg.w_falloff)
		var up: float = float(cfg.up_bias)
		# Grow-in threshold rises with depth so deeper branches appear later.
		var gin := 0.22 + float(depth - 1) * 0.2
		# Bias the whole crown gently toward the light (lean to light).
		var light_lean := -atan2(_light_dir.x, -_light_dir.y) * 0.1
		for i in n:
			var frac := (float(i) + 0.5) / float(n) - 0.5          # -0.5..0.5
			var ang := frac * spread * 2.0
			ang += Proc.rangef(seedv, "%s:%d:%d:j" % [key, depth, i], -0.14, 0.14)
			ang *= (1.0 - up * 0.5)                                 # pull toward vertical
			ang += light_lean
			# Willow: arch outward then let fronds hang (handled in draw).
			if cfg.style == "droop" and depth >= int(cfg.max_depth):
				ang = frac * spread * 2.0 + Proc.rangef(seedv, "%s:%d:%d:w" % [key, depth, i], -0.1, 0.1)
			var child := _Limb.new()
			child._tree = self
			child.cfg = cfg
			child.depth = depth
			child.grow_in = gin
			child.full_length = parent.full_length * lf * Proc.rangef(seedv, "%s:%d:%d:l" % [key, depth, i], 0.82, 1.08)
			child.base_w = maxf(1.2, parent.tip_w * Proc.rangef(seedv, "%s:%d:%d:w0" % [key, depth, i], 0.78, 0.98))
			child.tip_w = maxf(0.8, child.base_w * wf)
			child.curve = Proc.rangef(seedv, "%s:%d:%d:c" % [key, depth, i], -0.14, 0.14)
			child.rest_angle = ang
			child.is_tip = (depth >= maxd)
			child.bears_canopy = child.is_tip or (cfg.style in ["blob", "fruit", "blossom"] and depth >= maxd - 1 and Proc.hashf(seedv, "%s:%d:%d:bc" % [key, depth, i]) < 0.5)
			child._bp = Proc.hashf(seedv, "%s:%d:%d:bp" % [key, depth, i]) * TAU
			# Thinner / higher limbs sway more; compounding gives lifelike motion.
			child.sway_k = float(cfg.sway_amp) * (0.35 + 0.6 * float(depth)) * (1.0 + 0.3 * frac)
			if cfg.style == "droop":
				child.sway_k *= 1.7
			if child.bears_canopy:
				_setup_clumps(child, "%s:%d:%d" % [key, depth, i])
			parent.add_child(child)
			parent.children_limbs.append(child)
			_limbs.append(child)
			_grow_children(child, depth + 1, key + "x")

	# Pre-generate a canopy cluster's blobs + leaf-dot offsets (cached unit shapes).
	func _setup_clumps(limb: _Limb, key: String) -> void:
		var count := int(cfg.get("clumps", 3))
		if cfg.style == "sparse":
			count = 2
		limb.clumps.clear()
		for k in count:
			var lobes := 7 + int(Proc.hashf(seedv, "%s:%d:lo" % [key, k]) * 4.0)
			var wob := Proc.rangef(seedv, "%s:%d:wo" % [key, k], 0.18, 0.34)
			var off := Vector2(
				Proc.rangef(seedv, "%s:%d:ox" % [key, k], -0.55, 0.55),
				Proc.rangef(seedv, "%s:%d:oy" % [key, k], -0.55, 0.2))
			var rsc := Proc.rangef(seedv, "%s:%d:rs" % [key, k], 0.62, 1.0)
			if k == 0:
				off = Vector2.ZERO
				rsc = 1.0
			limb.clumps.append({
				"pts": ProcTrees._unit_blob(seedv, "%s:%d" % [key, k], lobes, wob),
				"off": off, "r": rsc,
				"alt": Proc.hashf(seedv, "%s:%d:al" % [key, k]) < 0.33,
			})
		# A handful of blossom / fruit dot positions around the cluster.
		limb.dots.clear()
		var dn := 6
		for k in dn:
			limb.dots.append(Vector2(
				Proc.rangef(seedv, "%s:%d:dx" % [key, k], -0.7, 0.7),
				Proc.rangef(seedv, "%s:%d:dy" % [key, k], -0.6, 0.3)))

	# ---- growth: relayout the hierarchy ------------------------------------

	func _on_growth() -> void:
		_global_size = lerpf(0.10, 1.0, g())
		if _trunk:
			_relayout()

	func _relayout() -> void:
		_relayout_limb(_trunk)

	func _relayout_limb(limb: _Limb) -> void:
		limb._update_dims()
		for c in limb.children_limbs:
			c.position = Vector2(0, -limb.current_length)
			c.rotation = c.rest_angle
			_relayout_limb(c)

	func _queue_all() -> void:
		for l in _limbs:
			(l as _Limb).queue_redraw()

	# ---- the wind: pure transform animation, no redraw ---------------------

	func _animate(delta: float) -> void:
		if _limbs.is_empty():
			return
		var sp: float = float(cfg.sway_speed)
		var ph := phase + _wind_seed
		var wind := sin(t * sp + ph) * 0.68 + sin(t * sp * 0.43 + ph * 1.7) * 0.32
		var gust := 1.0 + 0.45 * maxf(0.0, sin(t * 0.21 + ph * 0.6))
		var expo: float = cfg.get("exposure", 1.0)
		var fm := 0.12 if _frozen else 1.0
		var amp := wind * gust * expo * fm
		for item in _limbs:
			var limb: _Limb = item
			limb.rotation = limb.rest_angle + amp * limb.sway_k
			if limb.is_tip:
				var b := 1.0 + 0.018 * sin(t * sp * 1.4 + limb._bp) * fm
				limb.scale = Vector2(b, b)

	# ---- root draws only the ground contact shadow + root flare ------------

	func _draw() -> void:
		if cfg.is_empty():
			return
		var gs := _global_size
		var fr := footprint_radius * gs * 0.72
		if fr > 2.0:
			var sh := Proc.superellipse(fr, fr * 0.26, 2.4, 28)
			draw_colored_polygon(sh, Color(0.05, 0.08, 0.05, 0.22))
		# A gentle root flare for the heavy species.
		if species in ["ancient", "oak", "palm"] and g() > 0.3:
			var w: float = float(cfg.trunk_base_w) * gs * cfg.get("size_mul", 1.0)
			var bt: Color = cfg.bark_top
			var bb: Color = cfg.bark_bot
			var nr := 5 if species == "ancient" else 3
			for i in nr:
				var fx := (float(i) / float(nr - 1) - 0.5) * w * 2.4
				var dir := signf(fx) if absf(fx) > 0.01 else 1.0
				var root := PackedVector2Array([
					Vector2(fx * 0.3, -w * 0.5),
					Vector2(fx, -w * 0.12),
					Vector2(fx + dir * w * 0.5, 0.0),
					Vector2(fx + dir * w * 0.2, 0.0),
					Vector2(fx * 0.2, -w * 0.2)])
				root = Proc.smooth_loop(root, 6)
				draw_polygon(root, Proc.grad_fill(root, bt.darkened(0.1), bb))

# ===========================================================================
# _Limb — one branch (or the trunk). Draws its tapered segment + any canopy.
# ===========================================================================
class _Limb extends Node2D:
	var _tree: _Tree = null
	var cfg := {}
	var depth := 0
	var grow_in := 0.0
	var full_length := 100.0
	var base_w := 10.0
	var tip_w := 6.0
	var curve := 0.05
	var rest_angle := 0.0
	var is_tip := false
	var bears_canopy := false
	var sway_k := 0.02
	var _bp := 0.0

	var current_length := 0.0
	var children_limbs: Array = []
	var clumps: Array = []
	var dots: Array = []

	func _appear() -> float:
		if depth == 0:
			return 1.0
		return smoothstep(grow_in, grow_in + 0.26, _tree.g())

	func _update_dims() -> void:
		var gs := _tree._global_size
		var af := _appear()
		current_length = full_length * gs * (0.3 + 0.7 * af)
		visible = depth == 0 or af > 0.004
		queue_redraw()

	# ---- draw --------------------------------------------------------------

	func _draw() -> void:
		if _tree == null or cfg.is_empty():
			return
		var gs := _tree._global_size
		var af := _appear()
		var cl := current_length
		if cl <= 0.6:
			return
		var bw := base_w * gs * af
		var tw := tip_w * gs * af

		# 0.0-0.24: the sprout stage is drawn on the trunk as two seed leaves,
		# fading as the real canopy fills in. Keeps the earliest stage tender.
		var style: String = cfg.style

		_draw_branch(cl, bw, tw)
		_draw_bark(cl, bw)
		if bool(cfg.get("snow", false)) and depth > 0:
			_draw_branch_snow(cl, bw)

		if style == "conifer" and depth == 0:
			_draw_conifer(cl, bw, gs)
		elif style == "fan" and depth == 0:
			_draw_fan(cl, gs)
		elif bears_canopy and not bool(cfg.get("bare", false)):
			if style == "droop":
				_draw_droop(cl, gs, af)
			else:
				_draw_blob_canopy(gs, af)
		elif bears_canopy and bool(cfg.get("bare", false)) and bool(cfg.get("snow", false)):
			# winter deciduous tip: a little snow clump cradled on the twigs
			_draw_snow_cap(Vector2(0, -cl * 0.1), (base_w + tip_w) * gs * 1.8)

		if depth == 0:
			_draw_sprout_overlay(gs)

	# tapered, gently curved branch polygon with vertical bark gradient
	func _draw_branch(cl: float, bw: float, tw: float) -> void:
		var n := 9
		var a := Vector2.ZERO
		var tip := Vector2(0, -cl)
		var ctrl := Vector2(curve * cl, -cl * 0.5)
		var spine := []
		spine.resize(n)
		for i in n:
			spine[i] = ProcTrees._quad(a, ctrl, tip, float(i) / float(n - 1))
		var left := PackedVector2Array()
		var right := PackedVector2Array()
		left.resize(n)
		right.resize(n)
		var gnarl := String(cfg.bark) == "ancient"
		for i in n:
			var tt := float(i) / float(n - 1)
			var w := lerpf(bw, tw, tt) * 0.5
			if gnarl:
				w *= 1.0 + 0.16 * sin(tt * 9.0 + _bp)
			var pprev: Vector2 = spine[maxi(i - 1, 0)]
			var pnext: Vector2 = spine[mini(i + 1, n - 1)]
			var tangent := (pnext - pprev)
			if tangent.length() < 0.001:
				tangent = Vector2(0, -1)
			tangent = tangent.normalized()
			var normal := Vector2(-tangent.y, tangent.x)
			left[i] = spine[i] + normal * w
			right[i] = spine[i] - normal * w
		var poly := PackedVector2Array()
		poly.append_array(left)
		for i in n:
			poly.append(right[n - 1 - i])
		draw_polygon(poly, Proc.grad_fill(poly, cfg.bark_top, cfg.bark_bot))
		# soft edge for definition
		if bw > 2.0:
			var edge := PackedVector2Array()
			edge.append_array(poly)
			edge.append(poly[0])
			draw_polyline(edge, cfg.bark_edge, maxf(1.0, bw * 0.06), true)

	func _draw_bark(cl: float, bw: float) -> void:
		var b := String(cfg.bark)
		if b == "birch" and depth == 0 and bw > 4.0:
			var m: Color = cfg.bark_mark
			var count := 5 + int(cl / 40.0)
			for i in count:
				var y := -cl * Proc.rangef(_tree.seedv, "bm%d" % i, 0.1, 0.92)
				var x := Proc.rangef(_tree.seedv, "bmx%d" % i, -0.3, 0.3) * bw
				var hw := bw * Proc.rangef(_tree.seedv, "bmw%d" % i, 0.18, 0.4)
				draw_line(Vector2(x - hw, y), Vector2(x + hw, y), m, maxf(1.5, bw * 0.12), true)
		elif b == "palm" and depth == 0 and bw > 4.0:
			var rings := int(cl / 26.0)
			var e: Color = cfg.bark_edge
			for i in rings:
				var yy := -cl * (float(i) + 0.5) / float(maxi(rings, 1))
				var ww := lerpf(bw, tip_w * _tree._global_size, (float(i) / float(maxi(rings, 1)))) * 0.42
				draw_arc(Vector2(curve * cl * (yy / -cl), yy), ww, 0.2, PI - 0.2, 7, e, maxf(1.0, bw * 0.08), true)

	# ---- blobby layered canopy (oak / maple / birch / blossom / fruit) -----
	func _draw_blob_canopy(gs: float, af: float) -> void:
		var tip := Vector2(0, -current_length)
		var radius: float = full_length * float(cfg.canopy_scale) * gs * af * (1.0 if _tree.species != "birch" else 0.9)
		if radius < 3.0:
			return
		var top: Color = cfg.leaf_top
		var bot: Color = cfg.leaf_bot
		var alt: Color = cfg.leaf_alt
		var light: Vector2 = cfg.light
		for clump in clumps:
			var cr := radius * float(clump.r)
			var off := tip + Vector2(clump.off) * radius
			var base: PackedVector2Array = clump.pts
			# under-shadow layer
			var u := ProcTrees._scaletr(base, cr * 1.06, off + Vector2(0, cr * 0.14))
			draw_polygon(u, ProcTrees._flat(u.size(), bot.darkened(0.14)))
			# main gradient body
			var ctop := alt if bool(clump.alt) else top
			var cbot := bot
			var m := ProcTrees._scaletr(base, cr, off)
			draw_polygon(m, Proc.grad_fill(m, ctop, cbot))
			# highlight toward the light
			var hl := ProcTrees._scaletr(base, cr * 0.58, off - light * cr * 0.34)
			draw_polygon(hl, ProcTrees._flat(hl.size(), top.lightened(0.22)))
		# textured leaf dots around the rim
		var dotc := bot.darkened(0.05)
		for d in dots:
			var p := tip + Vector2(d) * radius
			draw_circle(p, radius * 0.1, dotc)
		# blossoms / fruit
		var ba := float(cfg.get("bloom_amt", 0.0))
		if ba > 0.0:
			var bl: Color = cfg.bloom
			for d in dots:
				var p2 := tip + Vector2(d) * radius * 1.02
				draw_circle(p2, radius * 0.11 * ba, bl)
				draw_circle(p2 - light * radius * 0.03, radius * 0.05 * ba, bl.lightened(0.25))
		if _tree.species == "fruit" and not bool(cfg.get("bare", false)) and af > 0.6:
			var fc: Color = cfg.fruit_col
			for i in 3:
				var fp := tip + Vector2(
					Proc.rangef(_tree.seedv, "fr%d:%d:x" % [depth, i], -0.5, 0.5),
					Proc.rangef(_tree.seedv, "fr%d:%d:y" % [depth, i], 0.05, 0.5)) * radius
				draw_circle(fp, radius * 0.12, fc.darkened(0.1))
				draw_circle(fp, radius * 0.1, fc)
				draw_circle(fp - light * radius * 0.03, radius * 0.035, fc.lightened(0.3))
		if bool(cfg.get("snow", false)):
			_draw_snow_cap(tip - light * radius * 0.3, radius * 0.9)

	# ---- conifer skirts (pine / cypress), stacked up the trunk -------------
	func _draw_conifer(cl: float, bw: float, gs: float) -> void:
		var mature := _tree.g()
		var maxn := int(cfg.get("skirts", 8))
		var n := maxi(2, int(round(float(maxn) * (0.4 + 0.6 * mature))))
		var top: Color = cfg.leaf_top
		var bot: Color = cfg.leaf_bot
		var light: Vector2 = cfg.light
		var wide: float = full_length * float(cfg.canopy_scale) * gs
		# bottom (widest) first so upper skirts overlap in front
		for k in n:
			var frac := float(k) / float(n - 1)
			var ytop := -cl * lerpf(0.22, 0.98, frac)
			var skirt_h := cl * 0.2 * (1.0 - 0.3 * frac)
			var hw := lerpf(wide, wide * 0.1, frac)
			if hw < 2.0:
				continue
			var cx := curve * cl * (ytop / -cl)
			var controls := PackedVector2Array([
				Vector2(cx, ytop - skirt_h),                         # peak
				Vector2(cx + hw * 0.5, ytop - skirt_h * 0.1),
				Vector2(cx + hw, ytop + skirt_h * 0.35),             # right droop
				Vector2(cx + hw * 0.3, ytop + skirt_h * 0.2),
				Vector2(cx, ytop + skirt_h * 0.5),                   # centre dip
				Vector2(cx - hw * 0.3, ytop + skirt_h * 0.2),
				Vector2(cx - hw, ytop + skirt_h * 0.35),             # left droop
				Vector2(cx - hw * 0.5, ytop - skirt_h * 0.1)])
			var skirt := Proc.smooth_loop(controls, 7)
			draw_polygon(skirt, Proc.grad_fill(skirt, top.lerp(bot, frac * 0.4), bot))
			# a soft lit edge on the light side
			var hi := Proc.smooth_loop(PackedVector2Array([
				Vector2(cx, ytop - skirt_h),
				Vector2(cx - light.x * hw * 0.5, ytop - skirt_h * 0.2),
				Vector2(cx - light.x * hw * 0.2, ytop)]), 6)
			draw_polyline(hi, top.lightened(0.2), maxf(1.0, hw * 0.05), true)
			if bool(cfg.get("snow", false)):
				var snow := Proc.smooth_loop(PackedVector2Array([
					Vector2(cx, ytop - skirt_h * 0.9),
					Vector2(cx + hw * 0.45, ytop - skirt_h * 0.02),
					Vector2(cx + hw * 0.2, ytop - skirt_h * 0.1),
					Vector2(cx, ytop + skirt_h * 0.05),
					Vector2(cx - hw * 0.2, ytop - skirt_h * 0.1),
					Vector2(cx - hw * 0.45, ytop - skirt_h * 0.02)]), 6)
				draw_polygon(snow, ProcTrees._flat(snow.size(), Color(0.96, 0.97, 1.0, 0.92)))

	# ---- palm fronds radiating from the crown ------------------------------
	func _draw_fan(cl: float, gs: float) -> void:
		var tipx := curve * cl * (-cl / -cl)   # drift of the curved trunk tip
		var crown := Vector2(curve * cl, -cl)
		var mature := _tree.g()
		var fronds := maxi(3, int(round(7.0 * (0.4 + 0.6 * mature))))
		var flen: float = full_length * float(cfg.canopy_scale) * gs
		var top: Color = cfg.leaf_top
		var bot: Color = cfg.leaf_bot
		var light: Vector2 = cfg.light
		for i in fronds:
			var fa := PI + (float(i) / float(fronds - 1) - 0.5) * 2.4   # fan around downward-up
			# arc each frond: start up-and-out, droop at the end
			var dir := Vector2(cos(fa), sin(fa))
			var endp := crown + dir * flen + Vector2(0, flen * 0.35)    # gravity droop
			var ctrl := crown + dir * flen * 0.6 + Vector2(0, -flen * 0.1)
			var m := 9
			var spine := []
			spine.resize(m)
			for s in m:
				spine[s] = ProcTrees._quad(crown, ctrl, endp, float(s) / float(m - 1))
			# tapered frond polygon (the rachis + blade)
			var L := PackedVector2Array()
			var R := PackedVector2Array()
			L.resize(m)
			R.resize(m)
			for s in m:
				var tt := float(s) / float(m - 1)
				var w := flen * 0.07 * sin(PI * clampf(tt * 1.1, 0.0, 1.0))
				var pn: Vector2 = spine[mini(s + 1, m - 1)]
				var pp: Vector2 = spine[maxi(s - 1, 0)]
				var tang := (pn - pp).normalized()
				var nrm := Vector2(-tang.y, tang.x)
				L[s] = spine[s] + nrm * w
				R[s] = spine[s] - nrm * w
			var poly := PackedVector2Array()
			poly.append_array(L)
			for s in m:
				poly.append(R[m - 1 - s])
			var lit := 0.5 + 0.5 * dir.dot(-light)
			draw_polygon(poly, Proc.grad_fill(poly, top.lerp(top.lightened(0.2), lit), bot))
			# pinnae ticks along the rachis
			for s in range(1, m - 1):
				var tt := float(s) / float(m - 1)
				var w2 := flen * 0.11 * sin(PI * tt)
				var pn2: Vector2 = spine[mini(s + 1, m - 1)]
				var pp2: Vector2 = spine[maxi(s - 1, 0)]
				var tang2 := (pn2 - pp2).normalized()
				var nrm2 := Vector2(-tang2.y, tang2.x)
				draw_line(spine[s], spine[s] + nrm2 * w2, bot.darkened(0.05), 1.5, true)
				draw_line(spine[s], spine[s] - nrm2 * w2, bot.darkened(0.05), 1.5, true)
		# a cluster of coconuts at the crown for mature palms
		if mature > 0.7:
			for i in 3:
				var cp := crown + Vector2(Proc.rangef(_tree.seedv, "co%d:x" % i, -0.5, 0.5), Proc.rangef(_tree.seedv, "co%d:y" % i, 0.0, 0.4)) * flen * 0.2
				draw_circle(cp, flen * 0.05, Color(0.42, 0.3, 0.18))

	# ---- hanging willow fronds ---------------------------------------------
	func _draw_droop(cl: float, gs: float, af: float) -> void:
		var tip := Vector2(0, -cl)
		var strands := maxi(3, int(round(5.0 * af)))
		var flen: float = full_length * 1.15 * gs * af
		var top: Color = cfg.leaf_top
		var bot: Color = cfg.leaf_bot
		if flen < 6.0:
			return
		# a small leafy node at the branch tip
		var nodeb := ProcTrees._scaletr(clumps[0].pts if clumps.size() > 0 else Proc.blob(_tree.seedv, "wn", 1.0, 7, 0.3), flen * 0.14, tip)
		draw_polygon(nodeb, Proc.grad_fill(nodeb, top, bot))
		for i in strands:
			var sx := (float(i) / float(maxi(strands - 1, 1)) - 0.5) * flen * 0.5
			var start := tip + Vector2(sx, 0)
			var m := 8
			var pts := PackedVector2Array()
			pts.resize(m)
			var wavek := Proc.rangef(_tree.seedv, "ws%d:%d" % [depth, i], 0.6, 1.4)
			var wavea := flen * 0.06
			for s in m:
				var tt := float(s) / float(m - 1)
				var y := tt * flen
				var x := sx * (1.0 - tt * 0.3) + sin(tt * PI * 1.5 * wavek) * wavea * tt
				pts[s] = tip + Vector2(x, y)
			draw_polyline(pts, bot.lerp(top, 0.3), maxf(1.2, flen * 0.012), true)
			# little leaves along the strand
			for s in range(1, m, 2):
				var lp: Vector2 = pts[s]
				draw_circle(lp, flen * 0.022, top.lerp(bot, float(s) / float(m)))

	# ---- the sprout stage (two cotyledon seed-leaves on the trunk tip) -----
	func _draw_sprout_overlay(gs: float) -> void:
		var gv := _tree.g()
		if gv >= 0.26:
			return
		var a := smoothstep(0.26, 0.14, gv)   # 1 at very young, fading to 0
		if a <= 0.01:
			return
		var tip := Vector2(0, -current_length)
		var r := maxf(6.0, 40.0 * gs) * (0.6 + 0.5 * a)
		var top: Color = cfg.leaf_top
		var bot: Color = cfg.leaf_bot
		# stem continues a touch above the tiny trunk
		draw_line(tip, tip + Vector2(0, -r * 0.5), bot.lerp(top, 0.3), maxf(1.5, r * 0.08), true)
		var crown := tip + Vector2(0, -r * 0.5)
		for s in [-1.0, 1.0]:
			var leaf := PackedVector2Array([
				crown,
				crown + Vector2(s * r * 0.5, -r * 0.5),
				crown + Vector2(s * r * 0.95, -r * 0.35),
				crown + Vector2(s * r * 0.7, 0.0),
				crown + Vector2(s * r * 0.2, r * 0.05)])
			leaf = Proc.smooth_loop(leaf, 7)
			var col := Color(top.r, top.g, top.b, a)
			var colb := Color(bot.r, bot.g, bot.b, a)
			draw_polygon(leaf, Proc.grad_fill(leaf, col, colb))

	# ---- snow helpers ------------------------------------------------------
	func _draw_branch_snow(cl: float, bw: float) -> void:
		if bw < 1.5:
			return
		# a thin ridge of snow along the upper side of the limb
		var n := 6
		var pts := PackedVector2Array()
		pts.resize(n)
		for i in n:
			var tt := float(i) / float(n - 1)
			pts[i] = Vector2(curve * cl * (tt - tt * tt) * 2.0 - bw * 0.3, -cl * tt)
		draw_polyline(pts, Color(0.95, 0.97, 1.0, 0.8), maxf(1.0, bw * 0.3), true)

	func _draw_snow_cap(center: Vector2, radius: float) -> void:
		if radius < 3.0:
			return
		var cap := Proc.smooth_loop(PackedVector2Array([
			Vector2(center.x - radius * 0.5, center.y),
			Vector2(center.x - radius * 0.25, center.y - radius * 0.32),
			Vector2(center.x, center.y - radius * 0.2),
			Vector2(center.x + radius * 0.3, center.y - radius * 0.36),
			Vector2(center.x + radius * 0.55, center.y),
			Vector2(center.x + radius * 0.2, center.y + radius * 0.1),
			Vector2(center.x - radius * 0.2, center.y + radius * 0.1)]), 7)
		draw_polygon(cap, ProcTrees._flat(cap.size(), Color(0.96, 0.98, 1.0, 0.9)))
