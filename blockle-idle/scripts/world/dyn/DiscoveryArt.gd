class_name DiscoveryArt
extends RefCounted
# DiscoveryArt — every drawn thing the Discovery dynamics system needs.
#
# Discovery (scripts/world/dyn/Discovery.gd) is the collection + breeding layer:
# rare variants, cross-pollination hybrids, kin-pair eggs, weather-born rarities,
# and the living JOURNAL TREE that is the game's only collection readout. None of
# that is allowed a panel, a grid or a list (DYNAMICS §1), so all of it has to be
# *drawn in the world*. This file is that drawing — kept out of Discovery.gd so the
# logic file stays readable, exactly as the proc modules keep art out of the systems.
#
# Everything here follows scripts/proc/CONVENTIONS.md:
#   • recognisable silhouettes (a tree reads as a tree, a leaf as a leaf)
#   • smooth hand-drawn edges (Proc.smooth_loop / grad_fill, antialiased polylines)
#   • seeded + deterministic — pure functions of (world_seed, key)
#   • growth-staged: the Journal Tree's `growth` IS your collection progress, so the
#     monument literally grows as you discover; every stage must read believably
#   • alive but CHEAP: sway/orbit/pulse are child-transform animations; `_draw` only
#     re-runs when the shape actually changes (a new leaf, a growth step)
#   • feet-at-origin (the Journal Tree's roots sit exactly on the ground contour)
#
# PUBLIC FACTORIES
#   make_journal_tree(seed, key, opts)        -> ProcNode   the living collection
#   make_variant_aura(seed, key, tier, r)     -> ProcNode   radiant/ancient overlay
#   make_pollen_mote(seed, key, from, to, o)  -> ProcNode   A→B cross-pollination
#   make_pollen_thread(seed, key, a, b)       -> ProcNode   the faint "they're courting" arc
#   make_nest_glow(seed, key, radius)         -> ProcNode   an egg is forming here
#   make_storm_mark(seed, key, radius)        -> ProcNode   storm-touched keepsake halo
#   make_hybrid_bloom(seed, key, radius)      -> ProcNode   one-shot hybrid flourish

# The eight branches of the Journal Tree — one per category of discovery.
const CATEGORIES := ["species", "creatures", "hybrids", "variants",
					 "recipes", "rites", "events", "grounds"]

const CAT_LABEL := {
	"species": "growing things", "creatures": "kin", "hybrids": "crossings",
	"variants": "rare forms", "recipes": "makings", "rites": "rites",
	"events": "skies", "grounds": "grounds",
}

# Leaf colour per branch. Warm, storybook, never neon.
const CAT_COL := {
	"species":   [Color(0.46, 0.74, 0.40), Color(0.26, 0.50, 0.28)],
	"creatures": [Color(0.96, 0.62, 0.52), Color(0.74, 0.38, 0.33)],
	"hybrids":   [Color(0.76, 0.60, 0.92), Color(0.49, 0.36, 0.68)],
	"variants":  [Color(0.99, 0.84, 0.48), Color(0.80, 0.58, 0.24)],
	"recipes":   [Color(0.93, 0.78, 0.52), Color(0.68, 0.50, 0.28)],
	"rites":     [Color(0.62, 0.80, 0.96), Color(0.34, 0.52, 0.76)],
	"events":    [Color(0.84, 0.86, 0.98), Color(0.55, 0.58, 0.82)],
	"grounds":   [Color(0.80, 0.68, 0.48), Color(0.52, 0.41, 0.26)],
}

const BARK_A := Color(0.49, 0.36, 0.25)
const BARK_B := Color(0.30, 0.21, 0.15)
const BARK_HI := Color(0.64, 0.49, 0.34)
const BLOSSOM_A := Color(1.00, 0.88, 0.93)
const BLOSSOM_B := Color(0.96, 0.66, 0.78)
const GOLD := Color(1.00, 0.90, 0.62)

const MAX_LEAVES_PER_BRANCH := 14      # perf budget: 8 × 14 leaves max on screen
const MAX_BLOSSOMS := 7


# =============================================================================
# FACTORIES
# =============================================================================

# The Journal Tree. `opts.progress` is the collection fraction (its growth), and
# `opts.twin` grows the second trunk the seed_library arc awards.
static func make_journal_tree(world_seed: int, key: String, opts: Dictionary = {}) -> ProcNode:
	var n := _JournalTree.new()
	n.seedv = hash("%d:%s" % [world_seed, key])
	n.wseed = world_seed
	n.fkey = key
	n.grow_rate = 0.0                                   # its growth IS the collection
	n.twin = bool(opts.get("twin", false))
	n.growth = clampf(float(opts.get("progress", 0.03)), 0.02, 1.0)
	return n


# The overlay a rare variant wears. `tier` ∈ lush|radiant|ancient.
static func make_variant_aura(world_seed: int, key: String, tier: String, radius: float = 40.0) -> ProcNode:
	var n := _VariantAura.new()
	n.seedv = hash("%d:%s" % [world_seed, key])
	n.tier = tier
	n.base_r = maxf(14.0, radius)
	n.z_index = -1
	return n


# One golden puff of pollen crossing from A to B — the moment a hybrid is made.
static func make_pollen_mote(world_seed: int, key: String, from: Vector2, to: Vector2, opts: Dictionary = {}) -> ProcNode:
	var n := _PollenMote.new()
	n.seedv = hash("%d:%s" % [world_seed, key])
	n.from_p = from
	n.to_p = to
	n.life = float(opts.get("life", 3.0))
	n.tint = opts.get("color", GOLD) as Color
	n.z_index = int(opts.get("z", 26))
	return n


# The faint courting arc between two plants whose pollen dwell is accruing. Loops
# until fade_out() / queue_free(). `strength` 0..1 sets how visible it is.
static func make_pollen_thread(world_seed: int, key: String, a: Vector2, b: Vector2) -> ProcNode:
	var n := _PollenThread.new()
	n.seedv = hash("%d:%s" % [world_seed, key])
	n.a_p = a
	n.b_p = b
	n.z_index = 24
	return n


# A soft nest-glow on the ground where a kin-pair's egg is forming.
static func make_nest_glow(world_seed: int, key: String, radius: float = 54.0) -> ProcNode:
	var n := _NestGlow.new()
	n.seedv = hash("%d:%s" % [world_seed, key])
	n.base_r = maxf(20.0, radius)
	n.z_index = -1
	return n


# The pale crackle a storm leaves on the thing it touched. Loops.
static func make_storm_mark(world_seed: int, key: String, radius: float = 44.0) -> ProcNode:
	var n := _StormMark.new()
	n.seedv = hash("%d:%s" % [world_seed, key])
	n.base_r = maxf(16.0, radius)
	n.z_index = -1
	return n


# A one-shot flourish of petals when a hybrid seed is born. Frees itself.
static func make_hybrid_bloom(world_seed: int, key: String, radius: float = 70.0) -> ProcNode:
	var n := _HybridBloom.new()
	n.seedv = hash("%d:%s" % [world_seed, key])
	n.reach = maxf(24.0, radius)
	n.z_index = 27
	return n


static func cat_colors(cat: String) -> Array:
	if CAT_COL.has(cat):
		return CAT_COL[cat]
	return [Color(0.6, 0.7, 0.5), Color(0.35, 0.44, 0.30)]


static func cat_index(cat: String) -> int:
	var i := CATEGORIES.find(cat)
	return i if i >= 0 else 0


# =============================================================================
#  _JournalTree — the collection, as a living monument.
#
#  Feet at origin. A gnarled trunk (two trunks once the seed_library arc lands)
#  carrying EIGHT boughs, one per discovery category. Every discovery is a leaf on
#  its bough; every completed arc is a blossom; the newest leaf glows. The tree's
#  `growth` is the collection fraction, so the whole silhouette fills out as you
#  play — a small bare sapling at the first find, a broad crowned tree at the end.
# =============================================================================
class _JournalTree extends ProcNode:
	var wseed: int = 1
	var fkey: String = "journal"
	var footprint_radius: float = 74.0
	var twin: bool = false

	# content
	var _leaves: Array = []              # [{cat:String, key:String, label:String, line:String}]
	var _blossoms: Array = []            # [{arc:String, label:String, line:String}]
	var _newest: int = -1                # index into _leaves

	# geometry cache (rebuilt only when growth / content changes)
	var _h: float = 180.0
	var _trunk: PackedVector2Array = PackedVector2Array()
	var _trunk2: PackedVector2Array = PackedVector2Array()
	var _roots: Array = []               # [PackedVector2Array]
	var _branches: Array = []            # [_Branch]
	var _glow: _LeafGlow
	var _sway: Array = []                # per-branch seeded sway params
	var _built := false

	func _on_built() -> void:
		footprint_radius = 58.0
		for i in range(DiscoveryArt.CATEGORIES.size()):
			var br := _Branch.new()
			br.tree_ref = self
			br.idx = i
			br.cat = String(DiscoveryArt.CATEGORIES[i])
			add_child(br)
			_branches.append(br)
			_sway.append({
				"amp": Proc.rangef(seedv, "amp:%d" % i, 0.012, 0.030),
				"spd": Proc.rangef(seedv, "spd:%d" % i, 0.42, 0.78),
				"off": Proc.hashf(seedv, "off:%d" % i) * TAU,
			})
		_glow = _LeafGlow.new()
		_glow.visible = false
		add_child(_glow)
		_built = true
		_rebuild()

	# ---- content ------------------------------------------------------------

	# Hand the tree the whole ordered collection. `newest` is an index into leaves.
	func set_content(leaves: Array, blossoms: Array, newest: int) -> void:
		_leaves = leaves
		_blossoms = blossoms
		_newest = newest
		if _built:
			_rebuild()

	func set_progress(p: float) -> void:
		var want: float = clampf(p, 0.02, 1.0)
		if absf(want - growth) < 0.0008:
			return
		if not is_inside_tree():
			growth = want
			return
		grow_to(want, 1.6)

	# Pop the most recent leaf open, so a discovery is something you SEE arrive.
	func pop_newest() -> void:
		if _newest < 0 or _newest >= _leaves.size():
			return
		var cat := String((_leaves[_newest] as Dictionary).get("cat", "species"))
		var ci := DiscoveryArt.cat_index(cat)
		if ci < _branches.size():
			var br: _Branch = _branches[ci]
			br.pop_last()

	# ---- geometry -----------------------------------------------------------

	func _rebuild() -> void:
		var gv := g()
		_h = 150.0 + 300.0 * gv
		footprint_radius = 46.0 + 54.0 * gv
		_trunk = _make_trunk(0.0, 1.0, "t0")
		_trunk2 = PackedVector2Array()
		if twin:
			_trunk2 = _make_trunk(34.0 + 10.0 * gv, 0.72, "t1")
		_build_roots()
		# split the leaves out per category
		var per: Array = []
		for i in range(DiscoveryArt.CATEGORIES.size()):
			per.append([])
		for item in _leaves:
			var d: Dictionary = item
			var ci := DiscoveryArt.cat_index(String(d.get("cat", "species")))
			(per[ci] as Array).append(d)
		for i in range(_branches.size()):
			var br: _Branch = _branches[i]
			var geo := _branch_geo(i)
			br.position = geo["base"] as Vector2
			br.set_shape(geo["dir"] as Vector2, float(geo["len"]), float(geo["width"]), gv)
			br.set_leaves(per[i] as Array)
			var bl: Array = []
			for item in _blossoms:
				var d2: Dictionary = item
				if DiscoveryArt.cat_index(String(d2.get("cat", "rites"))) == i:
					bl.append(d2)
			br.set_blossoms(bl)
		_place_glow()
		queue_redraw()

	# A tapered, slightly leaning trunk as one smooth closed polygon.
	func _make_trunk(dx: float, scale: float, key: String) -> PackedVector2Array:
		var steps := 16
		var top: float = -_h * (0.52 + 0.08 * g()) * scale
		var w0: float = (14.0 + 15.0 * g()) * scale
		var bend: float = Proc.rangef(seedv, "bend:" + key, -0.26, 0.26)
		var left := PackedVector2Array()
		var right := PackedVector2Array()
		for i in range(steps + 1):
			var u := float(i) / float(steps)
			var y := lerpf(0.0, top, u)
			var w: float = w0 * (1.0 - 0.66 * u) + 1.2
			var x: float = dx + sin(u * 2.1) * bend * 26.0 * scale
			left.append(Vector2(x - w, y))
			right.append(Vector2(x + w, y))
		var out := PackedVector2Array()
		for p in left:
			out.append(p)
		for i in range(right.size() - 1, -1, -1):
			out.append(right[i])
		return out

	func _build_roots() -> void:
		_roots.clear()
		var gv := g()
		var n := 3 + int(gv * 2.0)
		for i in range(n):
			var side: float = -1.0 if i % 2 == 0 else 1.0
			var reach: float = (24.0 + 46.0 * gv) * Proc.rangef(seedv, "rr:%d" % i, 0.7, 1.25)
			var ctrl := PackedVector2Array([
				Vector2(0, -6),
				Vector2(side * reach * 0.45, -3.0 + Proc.rangef(seedv, "ry:%d" % i, -3.0, 3.0)),
				Vector2(side * reach, 2.0),
			])
			var poly := PackedVector2Array()
			var samples := 10
			for s in range(samples + 1):
				var u := float(s) / float(samples)
				var p := _quad(ctrl[0], ctrl[1], ctrl[2], u)
				poly.append(p + Vector2(0, -2.0 * (1.0 - u)))
			for s in range(samples, -1, -1):
				var u2 := float(s) / float(samples)
				var p2 := _quad(ctrl[0], ctrl[1], ctrl[2], u2)
				poly.append(p2 + Vector2(0, 2.0 + 3.0 * (1.0 - u2)))
			_roots.append(poly)

	func _quad(a: Vector2, b: Vector2, c: Vector2, u: float) -> Vector2:
		var iu := 1.0 - u
		return a * (iu * iu) + b * (2.0 * iu * u) + c * (u * u)

	# Where branch `i` leaves the trunk, and which way it reaches.
	func _branch_geo(i: int) -> Dictionary:
		var n := DiscoveryArt.CATEGORIES.size()
		var u := float(i) / float(maxi(1, n - 1))
		var gv := g()
		# alternate up the trunk so the boughs stagger instead of forming a wheel
		var rise: float = lerpf(0.30, 0.60, fposmod(float(i) * 0.37, 1.0))
		var on_twin: bool = twin and i >= 5
		var trunk_dx: float = (34.0 + 10.0 * gv) if on_twin else 0.0
		var base_y: float = -_h * (0.52 + 0.08 * gv) * (0.72 if on_twin else 1.0) * rise / 0.52
		base_y = clampf(base_y, -_h * 0.62, -_h * 0.14)
		var deg: float = lerpf(-156.0, -24.0, u) + Proc.rangef(seedv, "bj:%d" % i, -7.0, 7.0)
		var dir := Vector2(cos(deg_to_rad(deg)), sin(deg_to_rad(deg)))
		var ln: float = _h * lerpf(0.26, 0.46, Proc.hashf(seedv, "bl:%d" % i)) * (0.55 + 0.45 * gv)
		return {
			"base": Vector2(trunk_dx + dir.x * 6.0, base_y),
			"dir": dir,
			"len": ln,
			"width": (5.0 + 5.0 * gv) * (0.8 if on_twin else 1.0),
		}

	func _place_glow() -> void:
		if _glow == null:
			return
		if _newest < 0 or _newest >= _leaves.size():
			_glow.visible = false
			return
		var cat := String((_leaves[_newest] as Dictionary).get("cat", "species"))
		var ci := DiscoveryArt.cat_index(cat)
		if ci >= _branches.size():
			_glow.visible = false
			return
		var br: _Branch = _branches[ci]
		var lp := br.last_leaf_pos()
		_glow.visible = true
		_glow.position = br.position + lp
		var cols: Array = DiscoveryArt.cat_colors(cat)
		_glow.tint = cols[0] as Color
		_glow.queue_redraw()

	# Stop the newest-leaf glow (called after ~10 minutes).
	func clear_glow() -> void:
		if _glow != null:
			_glow.visible = false

	# ---- animation ----------------------------------------------------------

	func _animate(_delta: float) -> void:
		for i in range(_branches.size()):
			var br: _Branch = _branches[i]
			var s: Dictionary = _sway[i]
			br.rotation = sin(t * float(s["spd"]) + float(s["off"]) + phase) * float(s["amp"])
		if _glow != null and _glow.visible:
			var pul: float = 0.86 + 0.14 * sin(t * 2.1 + phase)
			_glow.scale = Vector2.ONE * pul
			_glow.modulate.a = 0.55 + 0.35 * pul

	func _on_growth() -> void:
		if _built:
			_rebuild()

	# ---- hit testing (the tap-to-read interface; no panel, ever) -------------

	func trunk_hit(local: Vector2) -> bool:
		if local.y > 16.0 or local.y < -_h * 0.60:
			return false
		var w: float = 22.0 + 18.0 * g()
		if absf(local.x) < w:
			return true
		return twin and absf(local.x - (34.0 + 10.0 * g())) < w * 0.8

	# Nearest leaf within `tol` px of a local point, or {} — carries its entry.
	func leaf_at(local: Vector2, tol: float = 26.0) -> Dictionary:
		var best: Dictionary = {}
		var best_d: float = tol * tol
		for i in range(_branches.size()):
			var br: _Branch = _branches[i]
			for item in br.leaf_hits():
				var h: Dictionary = item
				var p: Vector2 = br.position + (h["pos"] as Vector2)
				var d: float = p.distance_squared_to(local)
				if d < best_d:
					best_d = d
					best = h["data"] as Dictionary
		return best

	func blossom_at(local: Vector2, tol: float = 30.0) -> Dictionary:
		var best: Dictionary = {}
		var best_d: float = tol * tol
		for i in range(_branches.size()):
			var br: _Branch = _branches[i]
			for item in br.blossom_hits():
				var h: Dictionary = item
				var p: Vector2 = br.position + (h["pos"] as Vector2)
				var d: float = p.distance_squared_to(local)
				if d < best_d:
					best_d = d
					best = h["data"] as Dictionary
		return best

	func canopy_rect() -> Rect2:
		var w: float = footprint_radius * 2.4
		return Rect2(Vector2(-w * 0.5, -_h * 1.05), Vector2(w, _h * 1.2))

	# ---- draw ---------------------------------------------------------------

	func _draw() -> void:
		var gv := g()
		# contact shadow
		draw_colored_polygon(_ellipse(Vector2(2, -2), footprint_radius * 1.05, 11.0 + 5.0 * gv),
			Color(0.12, 0.10, 0.08, 0.20))
		# roots
		for item in _roots:
			var poly: PackedVector2Array = item
			draw_polygon(poly, Proc.grad_fill(poly, BARK_A.darkened(0.08), BARK_B))
		# trunks
		if _trunk2.size() > 2:
			draw_polygon(_trunk2, Proc.grad_fill(_trunk2, BARK_HI.darkened(0.1), BARK_B))
		if _trunk.size() > 2:
			draw_polygon(_trunk, Proc.grad_fill(_trunk, BARK_HI, BARK_B))
			# a couple of bark seams, drawn as thin lines up the trunk
			var seams := 2 + int(gv * 2.0)
			for s in range(seams):
				var sx: float = lerpf(-7.0, 7.0, Proc.hashf(seedv, "sx:%d" % s))
				var pts := PackedVector2Array()
				var steps := 8
				for i in range(steps + 1):
					var u := float(i) / float(steps)
					var y: float = lerpf(-4.0, -_h * 0.46, u)
					pts.append(Vector2(sx * (1.0 - u * 0.6) + sin(u * 2.1) * 3.0, y))
				draw_polyline(pts, Color(BARK_B.r, BARK_B.g, BARK_B.b, 0.45), 1.6, true)
		# a worn stone slate at the foot — where the island's finders carve the count
		if gv > 0.08:
			var slate := _ellipse(Vector2(-footprint_radius * 0.72, -4.0), 16.0 + 6.0 * gv, 6.0)
			draw_colored_polygon(slate, Color(0.62, 0.60, 0.56, 0.85))
			draw_colored_polygon(_ellipse(Vector2(-footprint_radius * 0.72, -6.5), 13.0 + 5.0 * gv, 4.4),
				Color(0.76, 0.74, 0.70, 0.9))

	func _ellipse(c: Vector2, rx: float, ry: float) -> PackedVector2Array:
		var pts := PackedVector2Array()
		var segs := 22
		for i in range(segs):
			var a := TAU * float(i) / float(segs)
			pts.append(c + Vector2(cos(a) * rx, sin(a) * ry))
		return pts


# -----------------------------------------------------------------------------
#  _Branch — one bough of the Journal Tree and the leaves it carries.
#  Its own Node2D so sway is a single rotation and a new leaf only redraws here.
# -----------------------------------------------------------------------------
class _Branch extends Node2D:
	var tree_ref: ProcNode
	var idx: int = 0
	var cat: String = "species"
	var dir: Vector2 = Vector2(-1, -1).normalized()
	var ln: float = 90.0
	var wid: float = 7.0
	var gv: float = 1.0
	var pop: float = 1.0

	var _leaves: Array = []
	var _blossoms: Array = []
	var _leaf_geo: Array = []            # [{pos, poly, col_a, col_b, data}]
	var _blos_geo: Array = []            # [{pos, data}]
	var _bough: PackedVector2Array = PackedVector2Array()
	var _pop_tw: Tween

	func set_shape(d: Vector2, length: float, width: float, growth_v: float) -> void:
		dir = d
		ln = length
		wid = width
		gv = growth_v
		_bough = _bough_points()
		_regeo()
		queue_redraw()

	func set_leaves(list: Array) -> void:
		_leaves = list
		_regeo()
		queue_redraw()

	func set_blossoms(list: Array) -> void:
		_blossoms = list
		_regeo()
		queue_redraw()

	func set_pop(v: float) -> void:
		pop = v
		queue_redraw()

	func pop_last() -> void:
		if _pop_tw != null and _pop_tw.is_valid():
			_pop_tw.kill()
		pop = 0.0
		_pop_tw = create_tween().set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
		_pop_tw.tween_method(set_pop, 0.0, 1.0, 0.9)

	func leaf_hits() -> Array:
		var out: Array = []
		for item in _leaf_geo:
			var d: Dictionary = item
			out.append({"pos": d["pos"], "data": d["data"]})
		return out

	func blossom_hits() -> Array:
		var out: Array = []
		for item in _blos_geo:
			var d: Dictionary = item
			out.append({"pos": d["pos"], "data": d["data"]})
		return out

	func last_leaf_pos() -> Vector2:
		if _leaf_geo.is_empty():
			return dir * ln * 0.8
		return (_leaf_geo[_leaf_geo.size() - 1] as Dictionary)["pos"] as Vector2

	# ---- geometry -----------------------------------------------------------

	func _bough_points() -> PackedVector2Array:
		# a gently arcing bough: lifts, then levels out
		var pts := PackedVector2Array()
		var steps := 9
		var curl: float = -0.22 if dir.x < 0.0 else 0.22
		for i in range(steps + 1):
			var u := float(i) / float(steps)
			var p: Vector2 = dir.rotated(curl * u * u) * (ln * u)
			p.y -= sin(u * PI) * ln * 0.09
			pts.append(p)
		return pts

	func _regeo() -> void:
		_leaf_geo.clear()
		_blos_geo.clear()
		if _bough.is_empty():
			_bough = _bough_points()
		var shown: int = mini(_leaves.size(), DiscoveryArt.MAX_LEAVES_PER_BRANCH)
		var overflow: int = maxi(0, _leaves.size() - shown)
		# the overflow does not vanish — it FATTENS the leaves that are there
		var fat: float = 1.0 + clampf(float(overflow) / 24.0, 0.0, 0.55)
		var cols: Array = DiscoveryArt.cat_colors(cat)
		var ca: Color = cols[0] as Color
		var cb: Color = cols[1] as Color
		for i in range(shown):
			# the newest leaves sit furthest out, so the bough visibly extends
			var u: float = lerpf(0.30, 0.97, (float(i) + 0.5) / float(maxi(1, shown)))
			var side: float = -1.0 if i % 2 == 0 else 1.0
			var base: Vector2 = _along(u)
			var nrm: Vector2 = _normal(u) * side
			var lr: float = (6.6 + 4.4 * gv) * fat
			var jit: float = Proc.hashf(hash(cat), "lj:%d" % i)
			var pos: Vector2 = base + nrm * (lr * 0.9 + jit * 4.0)
			var ang: float = nrm.angle() + (jit - 0.5) * 0.5
			var src: Dictionary = _leaves[_leaves.size() - shown + i]
			var tier := String(src.get("tier", ""))
			var la := ca
			var lb := cb
			if tier == "radiant" or tier == "ancient":
				la = ca.lerp(DiscoveryArt.GOLD, 0.45)
				lb = cb.lerp(DiscoveryArt.GOLD.darkened(0.3), 0.35)
			_leaf_geo.append({
				"pos": pos,
				"poly": _leaf_poly(pos, ang, lr),
				"col_a": la,
				"col_b": lb,
				"data": src,
			})
		var nb: int = mini(_blossoms.size(), DiscoveryArt.MAX_BLOSSOMS)
		for i in range(nb):
			var bu: float = lerpf(0.46, 0.88, (float(i) + 0.5) / float(maxi(1, nb)))
			var bside: float = 1.0 if i % 2 == 0 else -1.0
			var bpos: Vector2 = _along(bu) + _normal(bu) * bside * (9.0 + 5.0 * gv)
			_blos_geo.append({"pos": bpos, "data": _blossoms[i]})

	func _along(u: float) -> Vector2:
		if _bough.is_empty():
			return Vector2.ZERO
		var fi: float = clampf(u, 0.0, 1.0) * float(_bough.size() - 1)
		var i0: int = int(floor(fi))
		var i1: int = mini(i0 + 1, _bough.size() - 1)
		return _bough[i0].lerp(_bough[i1], fi - float(i0))

	func _normal(u: float) -> Vector2:
		var a := _along(clampf(u - 0.06, 0.0, 1.0))
		var b := _along(clampf(u + 0.06, 0.0, 1.0))
		var tangent := (b - a)
		if tangent.length() < 0.01:
			tangent = dir
		return Vector2(-tangent.y, tangent.x).normalized()

	# A smooth teardrop leaf, hand-drawn feel, pointing along `ang`.
	func _leaf_poly(c: Vector2, ang: float, r: float) -> PackedVector2Array:
		var ctrl := PackedVector2Array([
			Vector2(0, 0),
			Vector2(r * 0.58, -r * 0.52),
			Vector2(r * 1.70, -r * 0.10),
			Vector2(r * 0.58, r * 0.52),
		])
		var smooth := Proc.smooth_loop(ctrl, 5)
		var out := PackedVector2Array()
		for p in smooth:
			out.append(c + p.rotated(ang))
		return out

	# ---- draw ---------------------------------------------------------------

	func _draw() -> void:
		if _bough.size() < 2:
			return
		# the bough, tapering in three passes (cheap, smooth, reads as wood)
		var third: int = maxi(2, int(_bough.size() / 3))
		var seg_a := _slice(0, third + 1)
		var seg_b := _slice(third, third * 2 + 1)
		var seg_c := _slice(third * 2, _bough.size())
		draw_polyline(seg_a, DiscoveryArt.BARK_B, wid, true)
		draw_polyline(seg_b, DiscoveryArt.BARK_A, wid * 0.66, true)
		draw_polyline(seg_c, DiscoveryArt.BARK_A.lightened(0.08), wid * 0.4, true)
		# leaves — the newest one unfurls via `pop`
		var n := _leaf_geo.size()
		for i in range(n):
			var d: Dictionary = _leaf_geo[i]
			var poly: PackedVector2Array = d["poly"]
			var sc: float = 1.0
			if i == n - 1 and pop < 1.0:
				sc = clampf(pop, 0.05, 1.0)
			if sc < 0.999:
				var centre: Vector2 = d["pos"]
				var shrunk := PackedVector2Array()
				for p in poly:
					shrunk.append(centre + (p - centre) * sc)
				poly = shrunk
			draw_polygon(poly, Proc.grad_fill(poly, d["col_a"] as Color, d["col_b"] as Color))
		# blossoms — one per completed arc, five soft petals and a gold heart
		for item in _blos_geo:
			var bd: Dictionary = item
			var bc: Vector2 = bd["pos"]
			var br: float = 5.0 + 3.0 * gv
			for k in range(5):
				var a := TAU * float(k) / 5.0 + 0.3
				draw_circle(bc + Vector2(cos(a), sin(a)) * br * 0.9, br,
					DiscoveryArt.BLOSSOM_A if k % 2 == 0 else DiscoveryArt.BLOSSOM_B)
			draw_circle(bc, br * 0.62, DiscoveryArt.GOLD)

	func _slice(from: int, to: int) -> PackedVector2Array:
		var out := PackedVector2Array()
		var a: int = clampi(from, 0, _bough.size())
		var b: int = clampi(to, 0, _bough.size())
		for i in range(a, b):
			out.append(_bough[i])
		if out.size() < 2 and _bough.size() >= 2:
			out = PackedVector2Array([_bough[0], _bough[1]])
		return out


# -----------------------------------------------------------------------------
#  _LeafGlow — the soft halo on the newest leaf, for its first ten minutes.
# -----------------------------------------------------------------------------
class _LeafGlow extends Node2D:
	var tint: Color = DiscoveryArt.GOLD

	func _draw() -> void:
		for i in range(3):
			var r: float = 20.0 - float(i) * 5.5
			draw_circle(Vector2.ZERO, r, Color(tint.r, tint.g, tint.b, 0.10 + 0.07 * float(i)))
		draw_circle(Vector2.ZERO, 3.2, Color(1, 1, 1, 0.75))


# =============================================================================
#  _VariantAura — what makes a rare morph READ as rare without a label.
#  lush: a faint warm halo. radiant: a bloom ring + two orbiting motes.
#  ancient: a slow golden shimmer, a third mote, and a soft glow on the ground.
# =============================================================================
class _VariantAura extends ProcNode:
	var tier: String = "lush"
	var base_r: float = 40.0
	var _motes: Array = []

	func _on_built() -> void:
		grow_rate = 0.0
		growth = 1.0
		var n := 0
		if tier == "radiant":
			n = 2
		elif tier == "ancient":
			n = 3
		for i in range(n):
			var m := _AuraMote.new()
			m.tint = DiscoveryArt.GOLD if tier == "ancient" else Color(0.86, 0.96, 1.0)
			m.rr = 2.6 + 0.9 * float(i % 2)
			add_child(m)
			_motes.append(m)

	func _animate(_delta: float) -> void:
		var n := _motes.size()
		for i in range(n):
			var m: Node2D = _motes[i]
			var a: float = t * (0.52 + 0.12 * float(i)) + phase + TAU * float(i) / float(maxi(1, n))
			var rx: float = base_r * 1.08
			var ry: float = base_r * 0.40
			m.position = Vector2(cos(a) * rx, -base_r * 0.85 + sin(a) * ry)
			m.scale = Vector2.ONE * (0.82 + 0.22 * sin(a * 2.0))

	func _draw() -> void:
		var pul: float = 0.90 + 0.10 * sin(t * 1.25 + phase)
		match tier:
			"lush":
				_halo(Vector2(0, -base_r * 0.6), base_r * 1.05 * pul, Color(0.72, 0.95, 0.70), 0.13)
			"radiant":
				_halo(Vector2(0, -base_r * 0.72), base_r * 1.28 * pul, Color(0.92, 0.98, 1.0), 0.20)
				_ground_ring(base_r * 1.18, Color(0.80, 0.94, 1.0, 0.22))
			"ancient":
				_halo(Vector2(0, -base_r * 0.78), base_r * 1.45 * pul, DiscoveryArt.GOLD, 0.24)
				_ground_ring(base_r * 1.34, Color(1.0, 0.88, 0.58, 0.26))
				# three slow shimmer arcs rising through the body
				for i in range(3):
					var u: float = fposmod(t * 0.16 + float(i) / 3.0, 1.0)
					var y: float = -base_r * 2.0 * u
					var w: float = base_r * (1.0 - absf(u - 0.5) * 1.4)
					if w <= 1.0:
						continue
					draw_line(Vector2(-w * 0.5, y), Vector2(w * 0.5, y),
						Color(1.0, 0.95, 0.72, 0.10 * (1.0 - u)), 2.0, true)

	func _halo(c: Vector2, r: float, col: Color, a0: float) -> void:
		for i in range(4):
			var rr: float = r * (1.0 - 0.19 * float(i))
			draw_circle(c, rr, Color(col.r, col.g, col.b, a0 * (0.35 + 0.22 * float(i))))

	func _ground_ring(r: float, col: Color) -> void:
		var pts := PackedVector2Array()
		var segs := 26
		for i in range(segs):
			var a := TAU * float(i) / float(segs)
			pts.append(Vector2(cos(a) * r * 1.25, sin(a) * r * 0.34))
		draw_colored_polygon(pts, Color(col.r, col.g, col.b, col.a * 0.45))
		var ring := pts
		ring.append(pts[0])
		draw_polyline(ring, col, 1.8, true)


class _AuraMote extends Node2D:
	var tint: Color = Color(1, 1, 1)
	var rr: float = 3.0

	func _draw() -> void:
		draw_circle(Vector2.ZERO, rr * 2.3, Color(tint.r, tint.g, tint.b, 0.16))
		draw_circle(Vector2.ZERO, rr, Color(tint.r, tint.g, tint.b, 0.85))
		draw_circle(Vector2(-rr * 0.3, -rr * 0.3), rr * 0.4, Color(1, 1, 1, 0.9))


# =============================================================================
#  _PollenMote — the golden puff that crosses between two parents. Self-freeing.
#  The trail is three lagging child dots, so nothing redraws per frame.
# =============================================================================
class _PollenMote extends ProcNode:
	var from_p: Vector2 = Vector2.ZERO
	var to_p: Vector2 = Vector2.ZERO
	var life: float = 3.0
	var tint: Color = DiscoveryArt.GOLD
	var _trail: Array = []
	var _dt: float = 0.0

	func _on_built() -> void:
		grow_rate = 0.0
		growth = 1.0
		for i in range(3):
			var d := _TrailDot.new()
			d.tint = tint
			d.rr = 3.4 - float(i) * 0.9
			d.alpha = 0.42 - float(i) * 0.11
			add_child(d)
			_trail.append(d)

	func _animate(delta: float) -> void:
		_dt += delta
		var u: float = clampf(_dt / maxf(0.2, life), 0.0, 1.0)
		position = _at(u)
		for i in range(_trail.size()):
			var d: Node2D = _trail[i]
			var lu: float = clampf(u - 0.055 * float(i + 1), 0.0, 1.0)
			d.position = _at(lu) - position
		var fade: float = 1.0
		if u < 0.12:
			fade = u / 0.12
		elif u > 0.86:
			fade = (1.0 - u) / 0.14
		modulate.a = clampf(fade, 0.0, 1.0)
		if u >= 1.0:
			queue_free()

	func _at(u: float) -> Vector2:
		var ue: float = u * u * (3.0 - 2.0 * u)
		var p: Vector2 = from_p.lerp(to_p, ue)
		p.y -= sin(ue * PI) * (38.0 + from_p.distance_to(to_p) * 0.14)
		p.x += sin(ue * TAU * 1.5 + phase) * 7.0
		return p

	func _draw() -> void:
		draw_circle(Vector2.ZERO, 11.0, Color(tint.r, tint.g, tint.b, 0.14))
		draw_circle(Vector2.ZERO, 6.0, Color(tint.r, tint.g, tint.b, 0.40))
		# a tiny tufted puff so it reads as pollen, not a generic orb
		for i in range(6):
			var a := TAU * float(i) / 6.0 + phase
			draw_circle(Vector2(cos(a), sin(a)) * 3.6, 2.1, Color(tint.r, tint.g, tint.b, 0.85))
		draw_circle(Vector2.ZERO, 2.4, Color(1, 1, 1, 0.92))


class _TrailDot extends Node2D:
	var tint: Color = Color(1, 1, 1)
	var rr: float = 3.0
	var alpha: float = 0.3

	func _draw() -> void:
		draw_circle(Vector2.ZERO, rr, Color(tint.r, tint.g, tint.b, alpha))


# =============================================================================
#  _PollenThread — the quiet readout that two plants are courting. A dotted arc
#  with three beads crawling along it; brighter the closer they are to a hybrid.
# =============================================================================
class _PollenThread extends ProcNode:
	var a_p: Vector2 = Vector2.ZERO
	var b_p: Vector2 = Vector2.ZERO
	var strength: float = 0.3
	var _beads: Array = []
	var _arc: PackedVector2Array = PackedVector2Array()

	func _on_built() -> void:
		grow_rate = 0.0
		growth = 1.0
		for i in range(3):
			var d := _TrailDot.new()
			d.tint = DiscoveryArt.GOLD
			d.rr = 2.6
			d.alpha = 0.8
			add_child(d)
			_beads.append(d)
		_rebuild()

	func set_ends(a: Vector2, b: Vector2) -> void:
		a_p = a
		b_p = b
		_rebuild()

	func set_strength(s: float) -> void:
		strength = clampf(s, 0.0, 1.0)
		modulate.a = 0.28 + 0.52 * strength

	func _rebuild() -> void:
		_arc = PackedVector2Array()
		var lift: float = 26.0 + a_p.distance_to(b_p) * 0.18
		var steps := 18
		for i in range(steps + 1):
			var u := float(i) / float(steps)
			var p: Vector2 = a_p.lerp(b_p, u)
			p.y -= sin(u * PI) * lift
			_arc.append(p)
		queue_redraw()

	func _at(u: float) -> Vector2:
		if _arc.is_empty():
			return Vector2.ZERO
		var fi: float = clampf(u, 0.0, 1.0) * float(_arc.size() - 1)
		var i0: int = int(floor(fi))
		var i1: int = mini(i0 + 1, _arc.size() - 1)
		return _arc[i0].lerp(_arc[i1], fi - float(i0))

	func _animate(_delta: float) -> void:
		for i in range(_beads.size()):
			var d: Node2D = _beads[i]
			var u: float = fposmod(t * 0.22 + float(i) / float(_beads.size()), 1.0)
			d.position = _at(u)
			d.scale = Vector2.ONE * (0.7 + 0.5 * sin(u * PI))

	func _draw() -> void:
		if _arc.size() < 2:
			return
		# dashed: every other pair of samples, so it reads as a drift not a wire
		var col := Color(DiscoveryArt.GOLD.r, DiscoveryArt.GOLD.g, DiscoveryArt.GOLD.b, 0.34)
		var i := 0
		while i < _arc.size() - 1:
			draw_line(_arc[i], _arc[i + 1], col, 1.7, true)
			i += 2

	func fade_out(dur: float = 0.4) -> void:
		var tw := create_tween()
		tw.tween_property(self, "modulate:a", 0.0, dur)
		tw.tween_callback(queue_free)


# =============================================================================
#  _NestGlow — a soft woven ring on the ground where an egg is forming, with two
#  little sparks hovering over it. No numbers, no bar: it brightens as it nears.
# =============================================================================
class _NestGlow extends ProcNode:
	var base_r: float = 54.0
	var strength: float = 0.2
	var _sparks: Array = []

	func _on_built() -> void:
		grow_rate = 0.0
		growth = 1.0
		for i in range(2):
			var s := _TrailDot.new()
			s.tint = Color(1.0, 0.86, 0.92)
			s.rr = 2.8
			s.alpha = 0.9
			add_child(s)
			_sparks.append(s)

	func set_strength(s: float) -> void:
		strength = clampf(s, 0.0, 1.0)
		queue_redraw()

	func _animate(_delta: float) -> void:
		for i in range(_sparks.size()):
			var s: Node2D = _sparks[i]
			var a: float = t * 0.7 + phase + PI * float(i)
			s.position = Vector2(cos(a) * base_r * 0.55, -22.0 - 10.0 * sin(a * 1.3))
			s.scale = Vector2.ONE * (0.75 + 0.35 * sin(a * 2.0))

	func _draw() -> void:
		var pul: float = 0.9 + 0.1 * sin(t * 1.1 + phase)
		var a0: float = 0.10 + 0.22 * strength
		var pts := PackedVector2Array()
		var segs := 28
		for i in range(segs):
			var a := TAU * float(i) / float(segs)
			pts.append(Vector2(cos(a) * base_r * pul, sin(a) * base_r * 0.33 * pul))
		draw_colored_polygon(pts, Color(1.0, 0.84, 0.88, a0 * 0.5))
		var ring := pts
		ring.append(pts[0])
		draw_polyline(ring, Color(1.0, 0.80, 0.86, a0 * 1.8), 2.0, true)
		# a few woven twigs, so it reads as a nest rather than a magic circle
		for i in range(6):
			var a := TAU * float(i) / 6.0 + phase * 0.2
			var r0: float = base_r * 0.52
			var r1: float = base_r * 0.92
			draw_line(Vector2(cos(a) * r0, sin(a) * r0 * 0.33),
				Vector2(cos(a + 0.5) * r1, sin(a + 0.5) * r1 * 0.33),
				Color(0.54, 0.42, 0.30, 0.45), 1.6, true)


# =============================================================================
#  _StormMark — the pale crackle a storm leaves behind on what it touched.
# =============================================================================
class _StormMark extends ProcNode:
	var base_r: float = 44.0
	var _bolts: Array = []

	func _on_built() -> void:
		grow_rate = 0.0
		growth = 1.0
		for i in range(3):
			var pts := PackedVector2Array()
			var n := 5
			var side: float = -1.0 if i % 2 == 0 else 1.0
			for k in range(n):
				var u := float(k) / float(n - 1)
				pts.append(Vector2(
					side * base_r * (0.25 + 0.55 * u) + Proc.rangef(seedv, "bx:%d:%d" % [i, k], -7.0, 7.0),
					-base_r * 1.5 * u - 6.0))
			_bolts.append(pts)

	func _draw() -> void:
		var flick: float = 0.5 + 0.5 * sin(t * 3.1 + phase) * sin(t * 1.7)
		var col := Color(0.80, 0.90, 1.0, 0.18 + 0.26 * flick)
		for item in _bolts:
			var pts: PackedVector2Array = item
			draw_polyline(pts, col, 1.8, true)
		for i in range(4):
			var r: float = base_r * (1.15 - 0.2 * float(i))
			draw_circle(Vector2(0, -base_r * 0.7), r, Color(0.78, 0.88, 1.0, 0.045 + 0.02 * float(i)))

	func _animate(_delta: float) -> void:
		queue_redraw()        # one tiny node, 7 draw calls — cheap enough to flicker


# =============================================================================
#  _HybridBloom — a one-shot ring of petals when a crossing takes. Self-freeing.
# =============================================================================
class _HybridBloom extends ProcNode:
	var reach: float = 70.0
	var life: float = 1.5
	var _dt: float = 0.0
	var _petals: Array = []

	func _on_built() -> void:
		grow_rate = 0.0
		growth = 1.0
		animate_draw = true
		var n := 9
		for i in range(n):
			_petals.append({
				"a": TAU * float(i) / float(n) + Proc.hashf(seedv, "pa:%d" % i) * 0.4,
				"sp": Proc.rangef(seedv, "ps:%d" % i, 0.7, 1.25),
				"h": Proc.rangef(seedv, "ph:%d" % i, 0.0, 1.0),
			})

	func _animate(delta: float) -> void:
		_dt += delta
		if _dt >= life:
			queue_free()

	func _draw() -> void:
		var u: float = clampf(_dt / life, 0.0, 1.0)
		var ue: float = 1.0 - pow(1.0 - u, 2.4)
		var fade: float = 1.0 - u
		for item in _petals:
			var p: Dictionary = item
			var a: float = float(p["a"]) + ue * 0.6
			var r: float = reach * ue * float(p["sp"])
			var c := Vector2(cos(a) * r, sin(a) * r * 0.62 - ue * 22.0)
			var col := Color.from_hsv(fposmod(0.78 + float(p["h"]) * 0.22, 1.0), 0.45, 1.0,
				0.75 * fade)
			var pr: float = 5.5 * (1.0 - 0.4 * u)
			draw_circle(c, pr * 2.1, Color(col.r, col.g, col.b, col.a * 0.22))
			draw_circle(c, pr, col)
		draw_circle(Vector2(0, -8.0), 16.0 * (1.0 - u) + 4.0, Color(1, 1, 1, 0.35 * fade))
