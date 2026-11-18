class_name ProcBuildings extends RefCounted
# ProcBuildings — recognizable, limitless, living STORYBOOK BUILDINGS built
# entirely from math. No imported images, no emoji, no pre-baked assets.
#
# Every building reads unmistakably as its KIND (from data/buildings.json's
# art.shape): cosy round Homes, an open Lumber Grove with its log pile and
# turning grindstone, a Stone Quarry with a timber derrick, a Crystal Mine with
# a spinning headframe wheel and a glowing portal, a dignified Research Library
# with arched windows and a cupola, a glass-roofed Essence Garden, a hearth-warm
# Explorer's Lodge, a domed Ancient Observatory whose slit tracks the sky, and a
# columned Relic Temple with braziers and a floating relic. Walls, pitched /
# curved / domed / belled roofs, blue-ish scalloped shingles, warm LIT windows
# that flicker like candlelight, doors, chimneys with drifting smoke, and banners
# that flutter — all drawn from splines, gradients and seeded noise.
#
# GROWTH is a BUILD. `growth` in [0,1] is a continuous construction, eased by
# g(), rendered believably at every stage:
#   0.00-0.13  FOUNDATION   — a cleared stone terrace + footing course laid.
#   0.10-0.38  TIMBER FRAME — corner posts, beams and a ridge rise from nothing.
#   0.34-0.64  WALLS        — walls fill upward between the frame; scaffolding up.
#   0.58-0.88  ROOF         — shingles / glass / dome settle onto the full walls.
#   0.84-1.00  FINISHED+LIT — doors, trim, chimneys smoke, windows warm & flicker,
#                             banners unfurl and the building's signature comes to
#                             life. The frame and scaffolding fade away.
# Redraw happens only when growth crosses the ~0.0025 threshold (ProcNode), so a
# finished street of buildings costs nothing to keep standing.
#
# ALIVE via cheap child-transform + modulate animation (no per-frame redraw of
# the architecture): windows flicker, chimney smoke drifts and fades, banners
# ripple, the observatory dome turns, the mine headframe and grove grindstone
# spin, the quarry derrick's stone sways, temple braziers flutter and the relic
# bobs — each with per-instance phase so no two breathe in lockstep.
#
# Shape contract (CONVENTIONS.md): feet at origin (bottom-centre at y=0), body at
# negative y; portrait; seeded + deterministic from (world_seed, key); exposes
# footprint_radius and accepts a context Dictionary for §2.3a local adaptation.
#
# -- public factory API -------------------------------------------------------
#   ProcBuildings.make(world_seed, key, building_id="blockling_homes",
#                      realm_id="verdant") -> ProcNode   (standing, mature)
#   ProcBuildings.make_by_shape(world_seed, key, shape, palette_hexes=[],
#                      realm_id="verdant") -> ProcNode
#   ProcBuildings.construct(world_seed, key, building_id="blockling_homes",
#                      realm_id="verdant") -> ProcNode   (lays foundation, then
#                                                          builds itself over time)
#   ProcBuildings.shapes() -> PackedStringArray
#   ProcBuildings.building_ids() -> PackedStringArray

const SHAPES := ["homes", "grove", "quarry", "mine", "library", "garden",
	"lodge", "observatory", "temple", "cottage"]

# art.shape value -> our renderer key
const SHAPE_ALIAS := {
	"homes": "homes", "grove": "grove", "quarry": "quarry", "mine": "mine",
	"library": "library", "garden": "garden", "lodge": "lodge",
	"observatory": "observatory", "temple": "temple", "tree": "cottage",
}

# ---------------------------------------------------------------------------
# Factories
# ---------------------------------------------------------------------------

static func make(world_seed: int, key: String, building_id: String = "blockling_homes", realm_id: String = "verdant") -> ProcNode:
	var n := _Building.new()
	n.seedv = hash("%d:bld:%s" % [world_seed, key])
	n.building_id = building_id
	n.realm_id = realm_id
	var bd := _building_data(building_id)
	n.shape = _resolve_shape(bd, building_id)
	n.title = String(bd.get("name", _pretty(building_id)))
	n.palette_hexes = _art_palette(bd)
	return n

static func make_by_shape(world_seed: int, key: String, shape: String, palette_hexes: Array = [], realm_id: String = "verdant") -> ProcNode:
	var n := _Building.new()
	n.seedv = hash("%d:bldshape:%s" % [world_seed, key])
	n.shape = shape if shape in SHAPES else "cottage"
	n.realm_id = realm_id
	n.palette_hexes = palette_hexes
	n.title = _pretty(shape)
	return n

# Newly placed: a cleared foundation, then the building raises itself over its
# class pace (buildings take ~2 hours by default — "grow across a day").
static func construct(world_seed: int, key: String, building_id: String = "blockling_homes", realm_id: String = "verdant") -> ProcNode:
	var n := make(world_seed, key, building_id, realm_id)
	n.growth = 0.0
	(n as _Building)._lay_foundation_on_ready = true
	return n

static func shapes() -> PackedStringArray:
	return PackedStringArray(SHAPES)

static func building_ids() -> PackedStringArray:
	var ids: Array = ["blockling_homes", "lumber_grove", "stone_quarry",
		"crystal_mine", "research_library", "essence_garden", "explorers_lodge",
		"ancient_observatory", "relic_temple"]
	return PackedStringArray(ids)

# ---------------------------------------------------------------------------
# data helpers (read GameData if present; never hardcode balance)
# ---------------------------------------------------------------------------

static func _building_data(building_id: String) -> Dictionary:
	var gd = Engine.get_main_loop()
	if gd and gd is SceneTree:
		var root := (gd as SceneTree).root
		if root and root.has_node("GameData"):
			var g = root.get_node("GameData")
			if g and g.buildings_by_id.has(building_id):
				return g.buildings_by_id[building_id]
	return {}

static func _resolve_shape(bd: Dictionary, building_id: String) -> String:
	var art = bd.get("art", {})
	var s := String(art.get("shape", "")) if art is Dictionary else ""
	if SHAPE_ALIAS.has(s):
		return SHAPE_ALIAS[s]
	# fall back by id keyword
	for k in SHAPES:
		if building_id.findn(k) >= 0:
			return k
	if building_id.findn("home") >= 0:
		return "homes"
	return "cottage"

static func _art_palette(bd: Dictionary) -> Array:
	var art = bd.get("art", {})
	if art is Dictionary and art.has("palette"):
		return art["palette"]
	return []

static func _pretty(id: String) -> String:
	return id.replace("_", " ").capitalize()

# ---------------------------------------------------------------------------
# small static geometry / colour helpers
# ---------------------------------------------------------------------------

static func _col(hexs: Array, i: int, fb: Color) -> Color:
	if i >= 0 and i < hexs.size():
		var s := String(hexs[i])
		if s.begins_with("#") and Color.html_is_valid(s):
			return Color.html(s)
	return fb

static func _flat(n: int, c: Color) -> PackedColorArray:
	var a := PackedColorArray()
	a.resize(n)
	for i in n:
		a[i] = c
	return a

static func _rect(cx: float, top: float, bot: float, hw: float) -> PackedVector2Array:
	return PackedVector2Array([
		Vector2(cx - hw, bot), Vector2(cx - hw, top),
		Vector2(cx + hw, top), Vector2(cx + hw, bot)])

static func _mul_a(c: Color, a: float) -> Color:
	return Color(c.r, c.g, c.b, c.a * a)

# A wavy "scalloped" edge from a to b (shingle course bottoms), dipping +y.
static func _scallop(a: Vector2, b: Vector2, scallops: int, depth: float) -> PackedVector2Array:
	var segs := maxi(6, scallops * 3)
	var pts := PackedVector2Array()
	pts.resize(segs + 1)
	for k in segs + 1:
		var tt := float(k) / float(segs)
		var p := a.lerp(b, tt)
		p.y += depth * (0.5 - 0.5 * cos(tt * TAU * float(scallops)))
		pts[k] = p
	return pts

static func _arc_pts(center: Vector2, rx: float, ry: float, a0: float, a1: float, steps: int) -> PackedVector2Array:
	var pts := PackedVector2Array()
	pts.resize(steps + 1)
	for i in steps + 1:
		var a := lerpf(a0, a1, float(i) / float(steps))
		pts[i] = center + Vector2(cos(a) * rx, sin(a) * ry)
	return pts

static func _bld_closed(p: PackedVector2Array) -> PackedVector2Array:
	var o := PackedVector2Array(p)
	if o.size() > 0:
		o.append(o[0])
	return o

# ===========================================================================
# _Building — the root ProcNode. Owns the staged architecture + living children.
# ===========================================================================
class _Building extends ProcNode:
	var building_id := ""
	var realm_id := "verdant"
	var shape := "cottage"
	var title := "Building"
	var palette_hexes: Array = []
	var footprint_radius := 140.0
	var _lay_foundation_on_ready := false
	var _frozen := false

	var cfg := {}                 # geometry: units[], special, grow_minutes, ...
	var _ctx := {}
	var size_mul := 1.0
	var _light := Vector2(-0.4, -1.0).normalized()

	# colours
	var wall_top := Color(0.82, 0.62, 0.38)
	var wall_bot := Color(0.55, 0.38, 0.22)
	var wall_lt := Color(0.92, 0.78, 0.56)
	var wall_dk := Color(0.4, 0.27, 0.16)
	var roof_top := Color(0.52, 0.66, 0.84)
	var roof_bot := Color(0.26, 0.38, 0.58)
	var roof_dk := Color(0.18, 0.27, 0.44)
	var roof_lt := Color(0.74, 0.86, 0.98)
	var trim := Color(0.86, 0.6, 0.3)
	var trim_dk := Color(0.5, 0.33, 0.16)
	var stone_top := Color(0.72, 0.73, 0.76)
	var stone_bot := Color(0.44, 0.45, 0.49)
	var stone_dk := Color(0.3, 0.31, 0.35)
	var glass := Color(0.7, 0.9, 0.95, 0.4)
	var glow_warm := Color(1.0, 0.82, 0.45)
	var interior := Color(1.0, 0.8, 0.45)
	var ink := Color(0.12, 0.1, 0.12)

	# living children + animation bookkeeping
	var _wins: Array = []         # [{node, pf}]
	var _puffs: Array = []        # [{node, origin, spd, off, rise, drift, wind, s0, sg}]
	var _banners: Array = []      # [_Banner]
	var _glows: Array = []        # [{node, base, spd, ph}]
	var _spins: Array = []        # [{node, spd}]
	var _pend: Array = []         # [{node, amp, spd, ph, rest}]

	# ---- lifecycle ---------------------------------------------------------

	func _on_built() -> void:
		shape = shape if shape in ProcBuildings.SHAPES else "cottage"
		_build_cfg()
		if _ctx.size() > 0:
			_absorb_context(_ctx)
		_compute_colours()
		set_grow_minutes(float(cfg.get("grow_minutes", 120.0)))
		_spawn_children()
		_layout_children()
		if _lay_foundation_on_ready:
			# clear the plot instantly, then let the slow build carry on from there
			set_growth(0.05)

	func apply_context(ctx: Dictionary) -> void:
		_ctx = ctx.duplicate()
		if is_inside_tree() and not cfg.is_empty():
			_absorb_context(_ctx)
			_compute_colours()
			queue_redraw()

	func set_frozen(b: bool) -> void:
		_frozen = b
		grow_rate = 0.0 if b else (1.0 / (float(cfg.get("grow_minutes", 120.0)) * 60.0))
		queue_redraw()

	func _absorb_context(ctx: Dictionary) -> void:
		if ctx.has("light_dir"):
			var ld: Vector2 = ctx["light_dir"]
			if ld.length() > 0.01:
				_light = ld.normalized()
		if ctx.has("elevation"):
			var e := clampf(float(ctx["elevation"]), 0.0, 1.0)
			size_mul = lerpf(1.04, 0.9, e)

	# ---- genome / geometry -------------------------------------------------

	func _build_cfg() -> void:
		var c := {"units": [], "special": "", "grow_minutes": 120.0,
			"flag_tone": 0.0, "n_banners": 1}
		match shape:
			"homes":
				c.grow_minutes = 110.0
				c.special = "homes"
				c.n_banners = 0
				var n := 2 + int(Proc.hashf(seedv, "nhome") < 0.6)   # 2 or 3 cottages
				var xs := [-120.0, 14.0, 150.0]
				for i in n:
					var w := Proc.rangef(seedv, "hw%d" % i, 118.0, 150.0)
					var h := Proc.rangef(seedv, "hh%d" % i, 96.0, 128.0)
					var rf: String = ["dome", "cone", "bell"][int(Proc.hashf(seedv, "hr%d" % i) * 3.0) % 3]
					var u := _unit(xs[i], w, h, rf)
					u.material = "wood"
					u.round = true
					u.roof_h = h * Proc.rangef(seedv, "hrh%d" % i, 0.62, 0.82)
					u.overhang = w * 0.14
					u.windows = [_win(0.0, h * 0.5, w * 0.2, w * 0.2, "round")]
					if i == 0:
						u.windows.append(_win(w * 0.26, h * 0.52, w * 0.15, w * 0.15, "round"))
					u.door = _door(w * -0.02, w * 0.24, h * 0.5, "round")
					u.chimneys = [_chim(w * (0.3 if i % 2 == 0 else -0.3), w * 0.12, h * 0.46, true)]
					c.units.append(u)
			"grove":
				c.grow_minutes = 95.0
				c.special = "grove"
				var u := _unit(10.0, 212.0, 118.0, "pitch")
				u.material = "wood"
				u.open = true                         # open-sided timber shelter
				u.roof_h = 96.0
				u.overhang = 36.0
				u.windows = []
				u.door = null
				u.chimneys = [_chim(-78.0, 16.0, 44.0, true)]   # a small drying kiln
				c.units.append(u)
			"quarry":
				c.grow_minutes = 120.0
				c.special = "quarry"
				var u := _unit(-24.0, 150.0, 92.0, "pitch")
				u.material = "stone"
				u.roof_h = 46.0
				u.overhang = 20.0
				u.windows = [_win(-30.0, 48.0, 26.0, 26.0, "square")]
				u.door = _door(28.0, 40.0, 70.0, "arch")
				u.chimneys = []
				c.units.append(u)
			"mine":
				c.grow_minutes = 115.0
				c.special = "mine"
				var u := _unit(-34.0, 128.0, 104.0, "pitch")
				u.material = "wood"
				u.roof_h = 64.0
				u.overhang = 22.0
				u.windows = [_win(-26.0, 56.0, 24.0, 28.0, "square")]
				u.door = null
				u.chimneys = []
				c.units.append(u)
			"library":
				c.grow_minutes = 150.0
				c.special = "library"
				var u := _unit(0.0, 196.0, 184.0, "dome")
				u.material = "stone"
				u.roof_h = 96.0
				u.overhang = 16.0
				u.cupola = true
				u.windows = [
					_win(-62.0, 86.0, 30.0, 74.0, "arch"),
					_win(62.0, 86.0, 30.0, 74.0, "arch"),
					_win(0.0, 128.0, 44.0, 44.0, "rose")]
				u.door = _door(0.0, 48.0, 92.0, "arch")
				u.chimneys = []
				c.units.append(u)
			"garden":
				c.grow_minutes = 85.0
				c.special = "garden"
				var u := _unit(0.0, 208.0, 128.0, "glass")
				u.material = "glass"
				u.roof_h = 92.0
				u.overhang = 10.0
				u.windows = []                        # whole thing is glazing
				u.door = _door(0.0, 44.0, 84.0, "arch")
				u.chimneys = []
				c.units.append(u)
			"lodge":
				c.grow_minutes = 115.0
				c.special = "lodge"
				var u := _unit(10.0, 186.0, 118.0, "pitch")
				u.material = "log"
				u.roof_h = 92.0
				u.overhang = 30.0
				u.windows = [
					_win(-44.0, 56.0, 34.0, 34.0, "square"),
					_win(60.0, 58.0, 28.0, 30.0, "square")]
				u.door = _door(6.0, 40.0, 80.0, "arch")
				u.chimneys = [_chim(-96.0, 34.0, 118.0, true)]   # great stone hearth
				u.chimneys[0].stone = true
				c.units.append(u)
			"observatory":
				c.grow_minutes = 180.0
				c.special = "observatory"
				var u := _unit(0.0, 124.0, 198.0, "dome_slit")
				u.material = "stone"
				u.tower = true
				u.roof_h = 78.0
				u.overhang = 20.0
				u.windows = [
					_win(0.0, 70.0, 26.0, 40.0, "arch"),
					_win(-40.0, 120.0, 20.0, 24.0, "round"),
					_win(40.0, 120.0, 20.0, 24.0, "round")]
				u.door = _door(0.0, 42.0, 78.0, "arch")
				u.chimneys = []
				c.units.append(u)
			"temple":
				c.grow_minutes = 220.0
				c.special = "temple"
				var u := _unit(0.0, 224.0, 150.0, "pediment")
				u.material = "stone"
				u.portico = true
				u.roof_h = 70.0
				u.overhang = 24.0
				u.windows = []
				u.door = _door(0.0, 64.0, 108.0, "arch")
				u.chimneys = []
				c.units.append(u)
			_:  # cottage
				c.grow_minutes = 100.0
				c.special = ""
				var u := _unit(0.0, 152.0, 112.0, "pitch")
				u.material = "wood"
				u.roof_h = 86.0
				u.overhang = 24.0
				u.windows = [
					_win(-42.0, 56.0, 30.0, 34.0, "square"),
					_win(44.0, 56.0, 30.0, 34.0, "square")]
				u.door = _door(0.0, 40.0, 76.0, "arch")
				u.chimneys = [_chim(58.0, 18.0, 58.0, true)]
				c.units.append(u)
		cfg = c
		# footprint = overall mature half-width + margin
		var minx := INF
		var maxx := -INF
		for u in c.units:
			var hw: float = float(u.base_w) * 0.5 + float(u.overhang)
			minx = minf(minx, float(u.dx) - hw)
			maxx = maxf(maxx, float(u.dx) + hw)
		if c.special == "quarry" or c.special == "mine":
			maxx += 70.0
		footprint_radius = maxf(90.0, (maxx - minx) * 0.5 + 24.0)

	func _unit(dx: float, w: float, h: float, roof: String) -> Dictionary:
		return {"dx": dx, "base_w": w, "wall_h": h, "roof": roof, "roof_h": h * 0.7,
			"overhang": w * 0.1, "material": "wood", "round": false, "open": false,
			"tower": false, "portico": false, "cupola": false,
			"windows": [], "door": null, "chimneys": []}

	func _win(x: float, y: float, w: float, h: float, kind: String) -> Dictionary:
		return {"x": x, "y": y, "w": w, "h": h, "kind": kind}

	func _door(x: float, w: float, h: float, kind: String) -> Dictionary:
		return {"x": x, "w": w, "h": h, "kind": kind}

	func _chim(x: float, w: float, h: float, smoke: bool) -> Dictionary:
		return {"x": x, "w": w, "h": h, "smoke": smoke, "stone": false}

	# ---- colour ------------------------------------------------------------

	func _compute_colours() -> void:
		var pal := Proc.palette(seedv, "bld")
		var base := ProcBuildings._col(palette_hexes, 0, Color(0.79, 0.58, 0.36))
		var acc := ProcBuildings._col(palette_hexes, 2, Color(0.86, 0.6, 0.3))
		# seeded per-instance jitter so a row of homes isn't identical
		var hv := Proc.rangef(seedv, "wj", -0.02, 0.02)
		base = base.from_hsv(fposmod(base.h + hv, 1.0), clampf(base.s + Proc.rangef(seedv, "ws", -0.05, 0.05), 0.05, 1.0), clampf(base.v + Proc.rangef(seedv, "wv", -0.04, 0.04), 0.1, 1.0))

		wall_lt = base.lightened(0.26)
		wall_top = base.lightened(0.08)
		wall_bot = base.darkened(0.3)
		wall_dk = base.darkened(0.5)

		# blue-ish shingles — a cool roof hue, nudged toward the realm accent + seed
		var bh := fposmod(0.57 + Proc.rangef(seedv, "rh", -0.04, 0.05), 1.0)
		var rs := Proc.rangef(seedv, "rsat", 0.38, 0.56)
		roof_lt = Color.from_hsv(bh, rs * 0.7, 0.92)
		roof_top = Color.from_hsv(bh, rs, 0.7)
		roof_bot = Color.from_hsv(fposmod(bh + 0.02, 1.0), min(1.0, rs + 0.16), 0.46)
		roof_dk = Color.from_hsv(fposmod(bh + 0.03, 1.0), min(1.0, rs + 0.2), 0.3)

		trim = acc.lightened(0.05)
		trim_dk = acc.darkened(0.35)

		var sv := Proc.rangef(seedv, "stv", -0.03, 0.03)
		stone_top = Color(0.74 + sv, 0.75 + sv, 0.78 + sv)
		stone_bot = Color(0.45 + sv, 0.46 + sv, 0.5 + sv)
		stone_dk = Color(0.29, 0.3, 0.34)

		glass = Color(0.72, 0.9, 0.93, 0.34)
		glow_warm = Color(1.0, 0.83, 0.47)
		ink = Color(0.1, 0.09, 0.11)

		# per-special interior glow colour
		match cfg.get("special", ""):
			"mine": interior = Color(0.56, 0.74, 1.0)
			"garden": interior = Color(0.6, 0.98, 0.72)
			"observatory": interior = Color(0.78, 0.66, 1.0)
			"temple": interior = Color(1.0, 0.82, 0.42)
			"library": interior = Color(0.7, 0.78, 1.0)
			_: interior = glow_warm

		# §2.3a: 20% drift toward the local realm palette, keep the kind legible
		var local = _ctx.get("local_palette", null)
		if local is Dictionary and local.has("base"):
			var lb: Color = local["base"]
			wall_top = wall_top.lerp(lb.lightened(0.18), 0.2)
			wall_bot = wall_bot.lerp(lb, 0.2)
			roof_top = roof_top.lerp(lb, 0.12)

	# ===================================================================
	# LIVING CHILDREN — spawned once; driven by cheap transforms/modulate
	# ===================================================================

	func _spawn_children() -> void:
		_wins.clear(); _puffs.clear(); _banners.clear()
		_glows.clear(); _spins.clear(); _pend.clear()
		# window glow haloes
		for u in cfg.units:
			for w in u.windows:
				if String(w.kind) == "rose":
					continue   # rose window handled as a pulsing glow special
				var gw := _Glow.new()
				gw.col = glow_warm
				gw.rad = maxf(10.0, float(w.w) * 0.8 * size_mul)
				gw.position = Vector2(float(u.dx) + float(w.x), -float(w.y))
				gw.modulate.a = 0.0
				add_child(gw)
				_wins.append({"node": gw, "pf": Proc.hashf(seedv, "wpf%d" % _wins.size()) * TAU})
		# chimney smoke
		for u in cfg.units:
			for ch in u.chimneys:
				if not bool(ch.smoke):
					continue
				var top := Vector2(float(u.dx) + float(ch.x), -(float(u.wall_h) * size_mul + float(ch.h) * size_mul))
				var count := 6 if bool(ch.stone) else 4
				for k in count:
					var pf := _Puff.new()
					pf.col = Color(0.86, 0.86, 0.9)
					pf.position = top
					pf.modulate.a = 0.0
					add_child(pf)
					_puffs.append({
						"node": pf, "origin": top,
						"spd": Proc.rangef(seedv, "psp%d%d" % [_puffs.size(), k], 0.12, 0.2),
						"off": float(k) / float(count),
						"rise": Proc.rangef(seedv, "pri%d" % _puffs.size(), 130.0, 190.0) * size_mul,
						"drift": Proc.rangef(seedv, "pdr%d" % _puffs.size(), 6.0, 16.0),
						"wind": Proc.rangef(seedv, "pwi%d" % _puffs.size(), 10.0, 26.0),
						"s0": Proc.rangef(seedv, "ps0%d" % _puffs.size(), 0.18, 0.3) * size_mul,
						"sg": Proc.rangef(seedv, "psg%d" % _puffs.size(), 0.5, 0.9) * size_mul})
		# banners / flags
		var nb := int(cfg.get("n_banners", 0))
		for i in nb:
			var u0 = cfg.units[0]
			var bn := _Banner.new()
			bn.seedv = hash("%d:ban:%d" % [seedv, i])
			bn.col_a = trim
			bn.col_b = trim.lerp(Color(1, 1, 1), 0.3)
			bn.length = 54.0 * size_mul
			var side := -1.0 if i % 2 == 0 else 1.0
			bn.position = Vector2(float(u0.dx) + side * float(u0.base_w) * 0.5 * size_mul, -(float(u0.wall_h) * size_mul + float(u0.roof_h) * size_mul * 0.7))
			bn.modulate.a = 0.0
			add_child(bn)
			_banners.append(bn)
		_spawn_special_children()

	func _spawn_special_children() -> void:
		var sp := String(cfg.get("special", ""))
		var u = cfg.units[0] if cfg.units.size() > 0 else null
		match sp:
			"observatory":
				var dome := _Deco.new()
				dome.kind = "dome_cap"
				dome.c0 = stone_top; dome.c1 = stone_bot; dome.c2 = interior
				dome.rx = float(u.base_w) * 0.5 * size_mul * 1.02
				dome.ry = float(u.roof_h) * size_mul
				dome.position = Vector2(float(u.dx), -float(u.wall_h) * size_mul)
				dome.modulate.a = 0.0
				add_child(dome)
				_spins.append({"node": dome, "spd": 0.08})
				var slit := _Glow.new()
				slit.col = interior
				slit.rad = float(u.base_w) * 0.18 * size_mul
				slit.position = dome.position + Vector2(0, -dome.ry * 0.4)
				slit.modulate.a = 0.0
				add_child(slit)
				_glows.append({"node": slit, "base": 0.85, "spd": 1.3, "ph": phase})
			"mine":
				var wheel := _Deco.new()
				wheel.kind = "wheel"
				wheel.c0 = Color(0.45, 0.32, 0.2); wheel.c1 = Color(0.3, 0.2, 0.12)
				wheel.rx = 26.0 * size_mul
				wheel.position = Vector2(float(u.dx) + 70.0 * size_mul, -(float(u.wall_h) * size_mul + 86.0 * size_mul))
				wheel.modulate.a = 0.0
				add_child(wheel)
				_spins.append({"node": wheel, "spd": 0.5})
				var por := _Glow.new()
				por.col = interior
				por.rad = 34.0 * size_mul
				por.position = Vector2(float(u.dx), -40.0 * size_mul)
				por.modulate.a = 0.0
				add_child(por)
				_glows.append({"node": por, "base": 0.8, "spd": 0.9, "ph": phase})
			"grove":
				var grind := _Deco.new()
				grind.kind = "grindstone"
				grind.c0 = stone_top; grind.c1 = stone_bot
				grind.rx = 30.0 * size_mul
				grind.position = Vector2(float(u.dx) + 86.0 * size_mul, -36.0 * size_mul)
				grind.modulate.a = 0.0
				add_child(grind)
				_spins.append({"node": grind, "spd": 1.1})
			"quarry":
				var blk := _Deco.new()
				blk.kind = "hangblock"
				blk.c0 = stone_top; blk.c1 = stone_bot
				blk.rx = 24.0 * size_mul
				blk.position = Vector2(float(u.dx) + 86.0 * size_mul, -126.0 * size_mul)
				blk.modulate.a = 0.0
				add_child(blk)
				_pend.append({"node": blk, "amp": 0.12, "spd": 0.9, "ph": phase, "rest": 0.0})
			"garden":
				var gg := _Glow.new()
				gg.col = interior
				gg.rad = float(u.base_w) * 0.42 * size_mul
				gg.position = Vector2(float(u.dx), -float(u.wall_h) * 0.5 * size_mul)
				gg.modulate.a = 0.0
				add_child(gg)
				_glows.append({"node": gg, "base": 0.5, "spd": 0.6, "ph": phase})
			"library":
				# rose window glow
				for w in u.windows:
					if String(w.kind) == "rose":
						var rg := _Glow.new()
						rg.col = interior
						rg.rad = float(w.w) * 0.7 * size_mul
						rg.position = Vector2(float(u.dx) + float(w.x), -float(w.y))
						rg.modulate.a = 0.0
						add_child(rg)
						_glows.append({"node": rg, "base": 0.8, "spd": 0.7, "ph": phase})
			"lodge":
				var lan := _Glow.new()
				lan.col = Color(1.0, 0.78, 0.4)
				lan.rad = 16.0 * size_mul
				lan.position = Vector2(float(u.dx) + float(u.door.x) + float(u.door.w) * 0.7, -float(u.door.h) * 0.9)
				lan.modulate.a = 0.0
				add_child(lan)
				_glows.append({"node": lan, "base": 0.95, "spd": 2.1, "ph": phase})
			"temple":
				for s in [-1.0, 1.0]:
					var br := _Glow.new()
					br.col = Color(1.0, 0.66, 0.28)
					br.rad = 22.0 * size_mul
					br.position = Vector2(float(u.dx) + s * float(u.base_w) * 0.5 * size_mul * 0.92, -84.0 * size_mul)
					br.modulate.a = 0.0
					add_child(br)
					_glows.append({"node": br, "base": 0.9, "spd": 3.0 + s, "ph": phase + s})
				var relic := _Deco.new()
				relic.kind = "relic"
				relic.c0 = interior; relic.c1 = Color(1.0, 0.95, 0.7)
				relic.rx = 16.0 * size_mul
				relic.position = Vector2(float(u.dx), -float(u.door.h) * 1.3)
				relic.modulate.a = 0.0
				add_child(relic)
				_pend.append({"node": relic, "amp": 0.0, "spd": 0.8, "ph": phase, "rest": 0.0, "by": relic.position.y})
				_glows.append({"node": relic, "base": 0.9, "spd": 1.1, "ph": phase})

	func _layout_children() -> void:
		# everything is positioned in build-local space already; nothing to do
		pass

	# ---- growth ------------------------------------------------------------

	func _on_growth() -> void:
		# child visibility gating is handled by modulate in _animate (uses g())
		pass

	# ---- animation (cheap; no architecture redraw) -------------------------

	func _animate(_delta: float) -> void:
		var G := g()
		var fin := smoothstep(0.84, 1.0, G)
		var fm := 0.14 if _frozen else 1.0
		# windows: warm candle flicker
		for w in _wins:
			var ph: float = w.pf
			var fl := 0.84 + 0.1 * sin(t * 3.2 + ph) + 0.06 * sin(t * 7.1 + ph * 1.7)
			fl -= 0.1 * maxf(0.0, sin(t * 0.8 + ph * 2.1)) * maxf(0.0, sin(t * 2.4 + ph))
			w.node.modulate.a = clampf(fin * fl * fm, 0.0, 1.0)
		# chimney smoke
		var smk := smoothstep(0.88, 1.0, G)
		for p in _puffs:
			var life := fposmod(t * float(p.spd) + float(p.off), 1.0)
			var px: float = sin(t * 0.6 + float(p.off) * TAU) * float(p.drift) + life * float(p.wind)
			p.node.position = Vector2(float(p.origin.x) + px, float(p.origin.y) - life * float(p.rise))
			var sc: float = float(p.s0) + life * float(p.sg)
			p.node.scale = Vector2(sc, sc)
			p.node.modulate.a = smk * sin(life * PI) * 0.45 * fm
		# banners
		for bn in _banners:
			bn.modulate.a = fin
			bn.wind = fm
		# pulsing glows
		for gi in _glows:
			var b: float = float(gi.base)
			var pulse := 0.7 + 0.3 * sin(t * float(gi.spd) + float(gi.ph))
			gi.node.modulate.a = fin * b * pulse * fm
		# spinners (dome / wheels / grindstone)
		for si in _spins:
			si.node.rotation += _delta * float(si.spd) * fm
		# pendulums (hanging stone sways) / floating relic bobs up and down
		for pe in _pend:
			if float(pe.amp) > 0.0:
				pe.node.rotation = float(pe.rest) + float(pe.amp) * sin(t * float(pe.spd) + float(pe.ph)) * fm
			else:
				var yb := 5.0 * sin(t * float(pe.spd) + float(pe.ph)) * fm
				pe.node.position = Vector2(pe.node.position.x, float(pe.by) + yb)

	# ===================================================================
	# DRAW — the staged architecture (redraws only on growth change)
	# ===================================================================

	func _draw() -> void:
		if cfg.is_empty():
			return
		var G := g()
		var st := {
			"found": smoothstep(0.0, 0.13, G),
			"frame": smoothstep(0.1, 0.38, G),
			"walls": smoothstep(0.34, 0.64, G),
			"roof": smoothstep(0.58, 0.88, G),
			"fin": smoothstep(0.84, 1.0, G),
		}
		# overall soft contact shadow
		var fr := footprint_radius * size_mul * (0.4 + 0.6 * float(st.found))
		if fr > 3.0:
			var sh := Proc.superellipse(fr, fr * 0.22, 2.3, 26)
			draw_colored_polygon(sh, Color(0.05, 0.06, 0.08, 0.22))
		# any behind-the-building special scenery (pits, rails, headframe legs)
		_draw_special_back(st)
		# each structural unit
		for u in cfg.units:
			_draw_unit(u, st)
		# front special scenery (logs, columns, crystals, braziers base, terraces)
		_draw_special_front(st)

	# ---- one structure -----------------------------------------------------

	func _draw_unit(u: Dictionary, st: Dictionary) -> void:
		var cx := float(u.dx)
		var W := float(u.base_w) * size_mul
		var hw := W * 0.5
		var H := float(u.wall_h) * size_mul
		var mat := String(u.material)
		var found: float = st.found
		var frame: float = st.frame
		var walls: float = st.walls
		var roof: float = st.roof
		var fin: float = st.fin

		# FOUNDATION — levelled stone terrace + footing course
		if found > 0.01:
			var tw := hw * 1.16 * found + 6.0
			var terrace := Proc.smooth_loop(PackedVector2Array([
				Vector2(cx - tw, 0.0), Vector2(cx - tw * 0.96, -9.0 * found),
				Vector2(cx + tw * 0.96, -9.0 * found), Vector2(cx + tw, 0.0),
				Vector2(cx + tw * 0.9, 6.0), Vector2(cx - tw * 0.9, 6.0)]), 6)
			draw_polygon(terrace, Proc.grad_fill(terrace, stone_top, stone_bot))
			var foot := ProcBuildings._rect(cx, -12.0 * found, 0.0, hw * 1.02)
			draw_polygon(foot, Proc.grad_fill(foot, stone_bot, stone_dk))

		# TIMBER FRAME — posts + top beam + ridge, fading as walls cover them
		if frame > 0.02 and walls < 0.985 and not bool(u.open):
			var fa := frame * (1.0 - 0.8 * walls)
			if fa > 0.02:
				var pc := _mul_a(Color(0.42, 0.3, 0.18), fa)
				var ph := H * frame
				for sx in [-1.0, 1.0]:
					draw_polygon(ProcBuildings._rect(cx + sx * hw * 0.9, -ph, 0.0, 4.5 * size_mul), ProcBuildings._flat(4, pc))
				draw_polygon(ProcBuildings._rect(cx, -ph, 0.0, 4.0 * size_mul), ProcBuildings._flat(4, pc))   # king post
				var beam := ProcBuildings._rect(cx, -ph, -ph + 7.0 * size_mul, hw * 0.96)
				draw_polygon(beam, ProcBuildings._flat(4, pc))
				# a simple ridge triangle preview of the roof pitch
				draw_polyline(PackedVector2Array([
					Vector2(cx - hw * 0.96, -ph), Vector2(cx, -ph - float(u.roof_h) * size_mul * frame),
					Vector2(cx + hw * 0.96, -ph)]), pc, 3.5 * size_mul, true)

		# WALLS — rise from the ground up
		if walls > 0.01 and not bool(u.open):
			_draw_walls(u, cx, hw, H * walls, mat, walls)
		elif bool(u.open) and walls > 0.01:
			_draw_open_frame(u, cx, hw, H * walls, walls)

		# scaffolding during mid-build
		if walls > 0.05 and fin < 0.92:
			var sa := clampf((1.0 - fin) * frame, 0.0, 1.0) * 0.8
			if sa > 0.03:
				_draw_scaffold(cx, hw, H, sa)

		# ROOF — settles onto full walls
		if roof > 0.02 and walls > 0.25:
			var eave_y := -H * walls
			_draw_roof(u, cx, hw, eave_y, roof)

		# FINISH — doors, windows, chimneys, trim come to life
		if fin > 0.02:
			if u.door != null:
				_draw_door(u, cx, H, fin)
			for w in u.windows:
				_draw_window(cx, w, fin)
			for ch in u.chimneys:
				_draw_chimney(u, cx, H, ch, roof, fin)
			_draw_unit_trim(u, cx, hw, H, fin)

	# ---- walls -------------------------------------------------------------

	func _draw_walls(u: Dictionary, cx: float, hw: float, wh: float, mat: String, walls: float) -> void:
		var top := -wh
		var body: PackedVector2Array
		if bool(u.round):
			# a softly rounded cottage body (barrel shouldered)
			body = Proc.smooth_loop(PackedVector2Array([
				Vector2(cx - hw, 0.0), Vector2(cx - hw, top * 0.55),
				Vector2(cx - hw * 0.78, top), Vector2(cx, top * 1.04),
				Vector2(cx + hw * 0.78, top), Vector2(cx + hw, top * 0.55),
				Vector2(cx + hw, 0.0)]), 7)
		elif bool(u.tower):
			body = ProcBuildings._rect(cx, top, 0.0, hw)
		else:
			body = ProcBuildings._rect(cx, top, 0.0, hw)
		var ctop := wall_lt if mat != "stone" else stone_top
		var cbot := wall_bot if mat != "stone" else stone_bot
		if mat == "glass":
			ctop = Color(0.84, 0.92, 0.95); cbot = Color(0.6, 0.76, 0.82)
		draw_polygon(body, Proc.grad_fill(body, ctop, cbot))
		# lit side gradient (toward the light)
		var litside := -signf(_light.x)
		var lit := ProcBuildings._rect(cx + litside * hw * 0.5, top * 0.98, -2.0, hw * 0.5)
		draw_polygon(lit, ProcBuildings._flat(4, _mul_a(ctop.lightened(0.12), 0.5)))
		# shaded far side
		var shd := ProcBuildings._rect(cx - litside * hw * 0.62, top * 0.98, -2.0, hw * 0.38)
		draw_polygon(shd, ProcBuildings._flat(4, _mul_a(cbot.darkened(0.2), 0.45)))
		# tower cylinder shading
		if bool(u.tower):
			for i in 5:
				var fxx := (float(i) / 4.0 - 0.5)
				var shade := clampf(absf(fxx + _light.x * 0.3) * 1.4, 0.0, 1.0)
				var col := stone_top.lerp(stone_dk, shade)
				var strip := ProcBuildings._rect(cx + fxx * hw * 1.9, top, 0.0, hw * 0.26)
				draw_polygon(strip, ProcBuildings._flat(4, _mul_a(col, 0.5)))
		# material texture
		_draw_wall_texture(u, cx, hw, wh, mat)
		# a soft outline for definition
		draw_polyline(_closed(body), _mul_a(cbot.darkened(0.3), 0.8), 2.0 * size_mul, true)

	func _draw_wall_texture(u: Dictionary, cx: float, hw: float, wh: float, mat: String) -> void:
		match mat:
			"stone":
				var rows := int(wh / (18.0 * size_mul))
				for r in rows:
					var y := -float(r + 1) * 18.0 * size_mul
					if y < -wh:
						break
					draw_line(Vector2(cx - hw * 0.96, y), Vector2(cx + hw * 0.96, y), _mul_a(stone_dk, 0.4), 1.5, true)
					var off := (r % 2) * 22.0 * size_mul
					var x := cx - hw * 0.9 + off
					while x < cx + hw * 0.9:
						draw_line(Vector2(x, y), Vector2(x, y + 18.0 * size_mul), _mul_a(stone_dk, 0.3), 1.2, true)
						x += 44.0 * size_mul
			"log":
				var rows2 := int(wh / (22.0 * size_mul))
				for r in rows2:
					var y := -float(r) * 22.0 * size_mul - 11.0 * size_mul
					if y < -wh:
						break
					var lg := ProcBuildings._rect(cx, y - 10.0 * size_mul, y + 10.0 * size_mul, hw * 0.97)
					draw_polygon(lg, Proc.grad_fill(lg, wall_lt, wall_top))
					draw_line(Vector2(cx - hw * 0.95, y + 10.0 * size_mul), Vector2(cx + hw * 0.95, y + 10.0 * size_mul), _mul_a(wall_dk, 0.5), 1.4, true)
			"wood":
				var cols := int(hw * 2.0 / (20.0 * size_mul))
				for ccol in cols:
					var x := cx - hw * 0.95 + float(ccol) * 20.0 * size_mul
					draw_line(Vector2(x, -4.0), Vector2(x, -wh * 0.98), _mul_a(wall_dk, 0.22), 1.2, true)
			"glass":
				# mullion grid for the greenhouse walls
				var gc := int(hw * 2.0 / (26.0 * size_mul))
				for ccol in gc + 1:
					var x := cx - hw + float(ccol) * 26.0 * size_mul
					draw_line(Vector2(x, 0.0), Vector2(x, -wh), _mul_a(trim_dk, 0.6), 2.0, true)
				var gr := int(wh / (30.0 * size_mul))
				for rr in gr + 1:
					var y := -float(rr) * 30.0 * size_mul
					draw_line(Vector2(cx - hw, y), Vector2(cx + hw, y), _mul_a(trim_dk, 0.6), 2.0, true)

	func _draw_open_frame(u: Dictionary, cx: float, hw: float, wh: float, walls: float) -> void:
		# open-sided timber shelter (lumber grove): posts + braces, no walls
		var pc := Color(0.46, 0.33, 0.2)
		for sx in [-1.0, -0.33, 0.33, 1.0]:
			draw_polygon(ProcBuildings._rect(cx + sx * hw * 0.92, -wh, 0.0, 6.0 * size_mul), Proc.grad_fill(ProcBuildings._rect(cx + sx * hw * 0.92, -wh, 0.0, 6.0 * size_mul), pc.lightened(0.1), pc.darkened(0.3)))
		# knee braces
		for sx in [-1.0, 1.0]:
			draw_line(Vector2(cx + sx * hw * 0.92, -wh * 0.7), Vector2(cx + sx * hw * 0.55, -wh), pc.darkened(0.2), 5.0 * size_mul, true)
		# back wall (half height plank wall)
		var back := ProcBuildings._rect(cx, -wh * 0.55, 0.0, hw * 0.92)
		draw_polygon(back, Proc.grad_fill(back, wall_top.darkened(0.1), wall_bot.darkened(0.15)))

	func _draw_scaffold(cx: float, hw: float, H: float, a: float) -> void:
		var c := _mul_a(Color(0.6, 0.45, 0.28), a)
		for sx in [-1.08, 1.08]:
			draw_line(Vector2(cx + sx * hw, 0.0), Vector2(cx + sx * hw, -H * 1.02), c, 3.0 * size_mul, true)
		for r in 3:
			var y := -H * (0.3 + 0.32 * r)
			draw_line(Vector2(cx - hw * 1.08, y), Vector2(cx + hw * 1.08, y), c, 2.0 * size_mul, true)
		draw_line(Vector2(cx - hw * 1.08, -H * 0.3), Vector2(cx + hw * 1.08, -H * 0.62), _mul_a(c, 0.7), 1.6 * size_mul, true)

	# ---- roofs -------------------------------------------------------------

	func _draw_roof(u: Dictionary, cx: float, hw: float, eave_y: float, a: float) -> void:
		var rh := float(u.roof_h) * size_mul
		var ov := float(u.overhang) * size_mul
		match String(u.roof):
			"pitch":
				_roof_pitch(cx, hw, eave_y, rh, ov, a)
			"dome":
				_roof_dome(cx, hw, eave_y, rh, a, false)
			"dome_slit":
				# the fixed drum; the moving cap is a spinning child (_Deco)
				_roof_drum(cx, hw, eave_y, rh, a)
			"cone":
				_roof_cone(cx, hw, eave_y, rh, ov, a)
			"bell":
				_roof_bell(cx, hw, eave_y, rh, ov, a)
			"glass":
				_roof_glass(cx, hw, eave_y, rh, ov, a)
			"pediment":
				_roof_pediment(cx, hw, eave_y, rh, ov, a)
			"flat":
				var slab := ProcBuildings._rect(cx, eave_y - rh * 0.3, eave_y, hw + ov)
				draw_polygon(slab, Proc.grad_fill(slab, roof_top, roof_bot))
			_:
				_roof_pitch(cx, hw, eave_y, rh, ov, a)
		# cupola for the library
		if bool(u.get("cupola", false)):
			_draw_cupola(cx, eave_y - rh, a)

	func _shingle_panel(apex: Vector2, le: Vector2, re: Vector2, rows: int, a: float) -> void:
		# triangular/trapezoidal shingled panel; lower courses drawn last (on top)
		var halfw := (re.x - le.x) * 0.5
		var scall := clampi(int(halfw / (11.0 * size_mul)), 3, 14)
		for i in range(rows - 1, -1, -1):
			var h0 := float(i) / float(rows)          # lower edge
			var h1 := float(i + 1) / float(rows)      # upper edge
			var ll := le.lerp(apex, h0)
			var lr := re.lerp(apex, h0)
			var ul := le.lerp(apex, h1)
			var ur := re.lerp(apex, h1)
			var depth := (ll - ul).length() * 0.34 + 2.0
			var poly := PackedVector2Array([ul, ur])
			var sc := int(maxf(2.0, float(scall) * (1.0 - h0 * 0.7)))
			poly.append_array(ProcBuildings._scallop(lr, ll, sc, depth))
			var col := roof_top.lerp(roof_bot, h0 * 0.85)
			draw_polygon(poly, ProcBuildings._flat(poly.size(), _mul_a(col, a)))
			# thin lit line along each course top
			draw_polyline(PackedVector2Array([ul, ur]), _mul_a(roof_lt, a * 0.5), 1.4 * size_mul, true)

	func _roof_pitch(cx: float, hw: float, eave_y: float, rh: float, ov: float, a: float) -> void:
		var apex := Vector2(cx, eave_y - rh)
		var le := Vector2(cx - hw - ov, eave_y)
		var re := Vector2(cx + hw + ov, eave_y)
		# gable face base fill
		var base := PackedVector2Array([le, apex, re])
		draw_polygon(base, ProcBuildings._flat(3, _mul_a(roof_bot, a)))
		_shingle_panel(apex, le, re, 6, a)
		# barge-board trim + ridge
		draw_polyline(PackedVector2Array([le, apex, re]), _mul_a(trim_dk, a), 3.0 * size_mul, true)
		draw_line(apex, Vector2(cx, eave_y), _mul_a(roof_dk, a * 0.5), 1.4 * size_mul, true)
		# little gable vent window
		var gv := apex + Vector2(0, rh * 0.42)
		draw_circle(gv, rh * 0.09, _mul_a(roof_dk, a))
		draw_circle(gv, rh * 0.065, _mul_a(glow_warm, a * 0.8))

	func _roof_dome(cx: float, hw: float, eave_y: float, rh: float, a: float, slit: bool) -> void:
		var rx := hw * 1.02
		var arc := ProcBuildings._arc_pts(Vector2(cx, eave_y), rx, rh, PI, TAU, 26)
		var poly := PackedVector2Array(arc)
		poly.append(Vector2(cx + rx, eave_y))
		poly.append(Vector2(cx - rx, eave_y))
		draw_polygon(poly, Proc.grad_fill(poly, roof_lt, roof_bot))
		# shingle bands as nested arcs
		for b in range(1, 5):
			var f := float(b) / 5.0
			var band := ProcBuildings._arc_pts(Vector2(cx, eave_y), rx * (1.0 - f * 0.12), rh * (1.0 - f), PI, TAU, 22)
			draw_polyline(band, _mul_a(roof_dk, a * 0.4), 1.4 * size_mul, true)
		# finial
		draw_circle(Vector2(cx, eave_y - rh), 5.0 * size_mul, _mul_a(trim, a))
		draw_line(Vector2(cx, eave_y - rh), Vector2(cx, eave_y - rh - 12.0 * size_mul), _mul_a(trim, a), 2.5 * size_mul, true)

	func _roof_drum(cx: float, hw: float, eave_y: float, rh: float, a: float) -> void:
		# the stone drum the observatory dome sits on
		var drum := ProcBuildings._rect(cx, eave_y - rh * 0.35, eave_y, hw)
		draw_polygon(drum, Proc.grad_fill(drum, stone_top, stone_bot))
		draw_line(Vector2(cx - hw, eave_y - rh * 0.35), Vector2(cx + hw, eave_y - rh * 0.35), _mul_a(stone_dk, a), 2.0, true)

	func _roof_cone(cx: float, hw: float, eave_y: float, rh: float, ov: float, a: float) -> void:
		# witch-hat: curved sides via spline, shingle rings
		var apex := Vector2(cx, eave_y - rh)
		var le := Vector2(cx - hw - ov, eave_y)
		var re := Vector2(cx + hw + ov, eave_y)
		var left := Proc.smooth_loop(PackedVector2Array([
			le, Vector2(cx - hw * 0.5, eave_y - rh * 0.55), apex,
			Vector2(cx + hw * 0.5, eave_y - rh * 0.55), re,
			Vector2(cx, eave_y + 2.0)]), 8)
		draw_polygon(left, Proc.grad_fill(left, roof_lt, roof_bot))
		for b in range(1, 5):
			var f := float(b) / 5.0
			var yy := eave_y - rh * f
			var ww := (hw + ov) * (1.0 - f)
			var ring := ProcBuildings._scallop(Vector2(cx + ww, yy), Vector2(cx - ww, yy), maxi(3, int(ww / (10.0 * size_mul))), 5.0 * size_mul)
			draw_polyline(ring, _mul_a(roof_dk, a * 0.5), 1.6 * size_mul, true)
		draw_circle(apex, 4.0 * size_mul, _mul_a(trim, a))

	func _roof_bell(cx: float, hw: float, eave_y: float, rh: float, ov: float, a: float) -> void:
		var apex := Vector2(cx, eave_y - rh)
		var outline := Proc.smooth_loop(PackedVector2Array([
			Vector2(cx - hw * 0.5, eave_y),
			Vector2(cx - hw - ov, eave_y - rh * 0.28),
			Vector2(cx - hw * 0.4, eave_y - rh * 0.62),
			apex,
			Vector2(cx + hw * 0.4, eave_y - rh * 0.62),
			Vector2(cx + hw + ov, eave_y - rh * 0.28),
			Vector2(cx + hw * 0.5, eave_y)]), 9)
		draw_polygon(outline, Proc.grad_fill(outline, roof_lt, roof_bot))
		for b in range(1, 5):
			var f := float(b) / 5.0
			var yy := eave_y - rh * (f * 0.9)
			var ww := lerpf(hw + ov, hw * 0.1, f) * (1.1 - 0.3 * f)
			var ring := ProcBuildings._scallop(Vector2(cx + ww, yy), Vector2(cx - ww, yy), maxi(3, int(ww / (11.0 * size_mul))), 5.0 * size_mul)
			draw_polyline(ring, _mul_a(roof_dk, a * 0.45), 1.6 * size_mul, true)
		draw_line(apex, apex + Vector2(0, -12.0 * size_mul), _mul_a(trim, a), 2.4 * size_mul, true)
		draw_circle(apex + Vector2(0, -14.0 * size_mul), 4.0 * size_mul, _mul_a(trim, a))

	func _roof_glass(cx: float, hw: float, eave_y: float, rh: float, ov: float, a: float) -> void:
		# arched glasshouse roof: translucent panes + mullions + glint
		var arc := ProcBuildings._arc_pts(Vector2(cx, eave_y), hw + ov, rh, PI, TAU, 24)
		var poly := PackedVector2Array(arc)
		poly.append(Vector2(cx + hw + ov, eave_y))
		poly.append(Vector2(cx - hw - ov, eave_y))
		var gcols := PackedColorArray()
		gcols.resize(poly.size())
		for i in poly.size():
			gcols[i] = _mul_a(glass.lerp(interior, 0.25), a)
		draw_polygon(poly, gcols)
		# mullion ribs
		for m in range(-3, 4):
			var xx := cx + float(m) * (hw + ov) * 0.3
			var yy := eave_y - rh * sqrt(maxf(0.0, 1.0 - pow(float(m) / 3.2, 2.0)))
			draw_line(Vector2(xx, eave_y), Vector2(xx, yy), _mul_a(trim_dk, a * 0.8), 2.0 * size_mul, true)
		draw_polyline(arc, _mul_a(trim_dk, a), 2.6 * size_mul, true)
		# a bright glint
		var glint := ProcBuildings._arc_pts(Vector2(cx, eave_y), (hw + ov) * 0.7, rh * 0.7, PI * 1.15, PI * 1.4, 8)
		draw_polyline(glint, _mul_a(Color(1, 1, 1), a * 0.5), 2.0 * size_mul, true)
		# ridge cresting
		draw_line(Vector2(cx, eave_y - rh), Vector2(cx, eave_y - rh - 10.0 * size_mul), _mul_a(trim, a), 2.0, true)

	func _roof_pediment(cx: float, hw: float, eave_y: float, rh: float, ov: float, a: float) -> void:
		# temple: a low triangular pediment on an entablature
		var ent := ProcBuildings._rect(cx, eave_y - rh * 0.3, eave_y, hw + ov)
		draw_polygon(ent, Proc.grad_fill(ent, stone_top, stone_bot))
		draw_line(Vector2(cx - hw - ov, eave_y - rh * 0.3), Vector2(cx + hw + ov, eave_y - rh * 0.3), _mul_a(trim, a), 2.4 * size_mul, true)
		var le := Vector2(cx - hw - ov, eave_y - rh * 0.3)
		var re := Vector2(cx + hw + ov, eave_y - rh * 0.3)
		var apex := Vector2(cx, eave_y - rh)
		var ped := PackedVector2Array([le, apex, re])
		draw_polygon(ped, Proc.grad_fill(ped, stone_top, stone_bot))
		draw_polyline(PackedVector2Array([le, apex, re, le]), _mul_a(trim, a), 2.6 * size_mul, true)
		# acroterion
		draw_circle(apex + Vector2(0, -6.0 * size_mul), 5.0 * size_mul, _mul_a(trim, a))

	func _draw_cupola(cx: float, base_y: float, a: float) -> void:
		var w := 24.0 * size_mul
		var drum := ProcBuildings._rect(cx, base_y - w * 1.1, base_y, w)
		draw_polygon(drum, Proc.grad_fill(drum, stone_top, stone_bot))
		# little arched openings
		draw_arc(Vector2(cx, base_y - w * 0.6), w * 0.5, PI, TAU, 10, _mul_a(ink, a), 2.0, true)
		draw_circle(Vector2(cx, base_y - w * 0.6), w * 0.32, _mul_a(glow_warm, a * 0.8))
		_roof_dome(cx, w, base_y - w * 1.1, w * 0.8, a, false)

	# ---- doors / windows / chimneys / trim ---------------------------------

	func _draw_door(u: Dictionary, cx: float, H: float, a: float) -> void:
		var d = u.door
		var dx := cx + float(d.x)
		var dw := float(d.w) * size_mul
		var dh := float(d.h) * size_mul
		var kind := String(d.kind)
		var frame_c := _mul_a(trim_dk, a)
		var wood := _mul_a(Color(0.4, 0.26, 0.15), a)
		var woodl := _mul_a(Color(0.52, 0.36, 0.22), a)
		var poly: PackedVector2Array
		if kind == "round":
			poly = Proc.smooth_loop(PackedVector2Array([
				Vector2(dx - dw * 0.5, 0.0), Vector2(dx - dw * 0.5, -dh * 0.5),
				Vector2(dx, -dh), Vector2(dx + dw * 0.5, -dh * 0.5),
				Vector2(dx + dw * 0.5, 0.0)]), 7)
		elif kind == "arch":
			var arch := ProcBuildings._arc_pts(Vector2(dx, -dh * 0.62), dw * 0.5, dh * 0.4, PI, TAU, 12)
			poly = PackedVector2Array([Vector2(dx - dw * 0.5, 0.0), Vector2(dx - dw * 0.5, -dh * 0.62)])
			poly.append_array(arch)
			poly.append(Vector2(dx + dw * 0.5, 0.0))
		else:
			poly = ProcBuildings._rect(dx, -dh, 0.0, dw * 0.5)
		# recess + door leaf
		draw_polygon(poly, ProcBuildings._flat(poly.size(), frame_c))
		var leaf := _scale_about(poly, Vector2(dx, 0.0), 0.82)
		draw_polygon(leaf, Proc.grad_fill(leaf, woodl, wood))
		# planks + handle
		for p in 2:
			var px := dx + (float(p) - 0.5) * dw * 0.28
			draw_line(Vector2(px, -dh * 0.8), Vector2(px, -dh * 0.06), _mul_a(wood.darkened(0.3), a), 1.5, true)
		draw_circle(Vector2(dx + dw * 0.26, -dh * 0.45), 2.5 * size_mul, _mul_a(trim, a))
		# warm spill of light from the doorway sill
		draw_circle(Vector2(dx, -dh * 0.1), dw * 0.6, _mul_a(interior, a * 0.14))

	func _draw_window(cx: float, w: Dictionary, a: float) -> void:
		var wx := cx + float(w.x)
		var wy := -float(w.y)
		var ww := float(w.w) * size_mul
		var wh := float(w.h) * size_mul
		var kind := String(w.kind)
		var frame_c := _mul_a(trim_dk, a)
		var pane := _mul_a(interior.lerp(Color(1, 0.9, 0.6), 0.4), a)
		match kind:
			"round":
				draw_circle(Vector2(wx, wy), ww * 0.6, frame_c)
				draw_circle(Vector2(wx, wy), ww * 0.5, pane)
				draw_line(Vector2(wx - ww * 0.5, wy), Vector2(wx + ww * 0.5, wy), frame_c, 2.0, true)
				draw_line(Vector2(wx, wy - ww * 0.5), Vector2(wx, wy + ww * 0.5), frame_c, 2.0, true)
			"arch":
				var top := wy - wh * 0.5
				var frame := PackedVector2Array([Vector2(wx - ww * 0.55, wy + wh * 0.5), Vector2(wx - ww * 0.55, top)])
				frame.append_array(ProcBuildings._arc_pts(Vector2(wx, top), ww * 0.55, ww * 0.55, PI, TAU, 10))
				frame.append(Vector2(wx + ww * 0.55, wy + wh * 0.5))
				draw_polygon(frame, ProcBuildings._flat(frame.size(), frame_c))
				var inr := _scale_about(frame, Vector2(wx, wy), 0.8)
				draw_polygon(inr, ProcBuildings._flat(inr.size(), pane))
				draw_line(Vector2(wx, top - ww * 0.4), Vector2(wx, wy + wh * 0.4), frame_c, 1.8, true)
				draw_line(Vector2(wx - ww * 0.4, wy), Vector2(wx + ww * 0.4, wy), frame_c, 1.8, true)
			"rose":
				# the library's great round window (glow is a pulsing child)
				draw_circle(Vector2(wx, wy), ww * 0.62, frame_c)
				draw_circle(Vector2(wx, wy), ww * 0.54, _mul_a(interior, a * 0.8))
				for k in 8:
					var ang := TAU * float(k) / 8.0
					draw_line(Vector2(wx, wy), Vector2(wx, wy) + Vector2(cos(ang), sin(ang)) * ww * 0.54, frame_c, 1.6, true)
				draw_circle(Vector2(wx, wy), ww * 0.16, frame_c)
			_:  # square / shuttered
				var fr := ProcBuildings._rect(wx, wy - wh * 0.5, wy + wh * 0.5, ww * 0.55)
				draw_polygon(fr, ProcBuildings._flat(4, frame_c))
				var pn := ProcBuildings._rect(wx, wy - wh * 0.42, wy + wh * 0.42, ww * 0.44)
				draw_polygon(pn, ProcBuildings._flat(4, pane))
				draw_line(Vector2(wx, wy - wh * 0.42), Vector2(wx, wy + wh * 0.42), frame_c, 1.8, true)
				draw_line(Vector2(wx - ww * 0.44, wy), Vector2(wx + ww * 0.44, wy), frame_c, 1.8, true)
				# a window box with a bloom for cottages/homes
				if String(cfg.get("special", "")) in ["", "homes"]:
					var boxy := wy + wh * 0.5
					draw_polygon(ProcBuildings._rect(wx, boxy, boxy + 7.0 * size_mul, ww * 0.52), ProcBuildings._flat(4, _mul_a(trim_dk, a)))
					draw_circle(Vector2(wx, boxy - 2.0 * size_mul), 3.0 * size_mul, _mul_a(Color(0.95, 0.5, 0.6), a))

	func _draw_chimney(u: Dictionary, cx: float, H: float, ch: Dictionary, roof: float, a: float) -> void:
		var chx := cx + float(ch.x)
		var chw := float(ch.w) * size_mul
		var chh := float(ch.h) * size_mul * clampf(roof * 1.1, 0.0, 1.0)
		var top := -H * size_mul - chh
		var c0 := stone_top if bool(ch.stone) else _mul_a(Color(0.55, 0.3, 0.22), 1.0)
		var c1 := stone_bot if bool(ch.stone) else _mul_a(Color(0.35, 0.18, 0.12), 1.0)
		var stack := ProcBuildings._rect(chx, top, -H * size_mul + 6.0, chw)
		draw_polygon(stack, Proc.grad_fill(stack, _mul_a(c0, a), _mul_a(c1, a)))
		# cap
		var cap := ProcBuildings._rect(chx, top - 6.0 * size_mul, top, chw * 1.22)
		draw_polygon(cap, ProcBuildings._flat(4, _mul_a(c1.darkened(0.1), a)))
		# stone courses
		if bool(ch.stone):
			for r in int(chh / (16.0 * size_mul)):
				var y := top + float(r + 1) * 16.0 * size_mul
				draw_line(Vector2(chx - chw * 0.9, y), Vector2(chx + chw * 0.9, y), _mul_a(stone_dk, a * 0.4), 1.2, true)
		# warm glow at the pot mouth
		draw_circle(Vector2(chx, top - 2.0 * size_mul), chw * 0.4, _mul_a(Color(1.0, 0.6, 0.3), a * 0.5))

	func _draw_unit_trim(u: Dictionary, cx: float, hw: float, H: float, a: float) -> void:
		# eave fascia board
		var ey := -H * size_mul
		draw_line(Vector2(cx - hw * 1.02, ey), Vector2(cx + hw * 1.02, ey), _mul_a(trim, a), 2.4 * size_mul, true)
		# corner quoins / posts for timbered looks
		if String(u.material) == "wood" and not bool(u.round):
			for sx in [-1.0, 1.0]:
				draw_polygon(ProcBuildings._rect(cx + sx * hw * 0.97, ey, 0.0, 3.5 * size_mul), ProcBuildings._flat(4, _mul_a(trim_dk, a * 0.8)))

	# ===================================================================
	# SPECIAL per-kind scenery (static; staged by `fin`)
	# ===================================================================

	func _draw_special_back(st: Dictionary) -> void:
		var walls: float = st.walls
		var fin: float = st.fin
		match String(cfg.get("special", "")):
			"mine":
				# a dark portal mouth cut into a low earth mound (behind the shed)
				if walls > 0.2:
					var cx := float(cfg.units[0].dx)
					var mouth := Proc.smooth_loop(PackedVector2Array([
						Vector2(cx - 34.0 * size_mul, 0.0), Vector2(cx - 30.0 * size_mul, -56.0 * size_mul),
						Vector2(cx, -74.0 * size_mul), Vector2(cx + 30.0 * size_mul, -56.0 * size_mul),
						Vector2(cx + 34.0 * size_mul, 0.0)]), 7)
					draw_polygon(mouth, Proc.grad_fill(mouth, Color(0.1, 0.1, 0.16), Color(0.03, 0.03, 0.06)))
					# timber portal frame
					draw_polyline(mouth, _mul_a(Color(0.4, 0.28, 0.16), walls), 5.0 * size_mul, true)
			"quarry":
				# the derrick's tall A-frame mast (behind)
				if walls > 0.2:
					var cx := float(cfg.units[0].dx) + 86.0 * size_mul
					var top := Vector2(cx, -132.0 * size_mul)
					var pc := _mul_a(Color(0.44, 0.3, 0.18), walls)
					draw_line(Vector2(cx - 34.0 * size_mul, 0.0), top, pc, 6.0 * size_mul, true)
					draw_line(Vector2(cx + 34.0 * size_mul, 0.0), top, pc, 6.0 * size_mul, true)
					draw_line(Vector2(cx - 20.0 * size_mul, -70.0 * size_mul), Vector2(cx + 20.0 * size_mul, -70.0 * size_mul), pc, 4.0 * size_mul, true)
					# the jib + pulley rope the swinging block hangs from
					draw_line(top, Vector2(cx, -126.0 * size_mul), pc, 3.0, true)
			"observatory":
				pass

	func _draw_special_front(st: Dictionary) -> void:
		var fin: float = st.fin
		if fin <= 0.02:
			return
		match String(cfg.get("special", "")):
			"grove":
				_special_grove(fin)
			"quarry":
				_special_quarry(fin)
			"mine":
				_special_mine(fin)
			"library":
				_special_library(fin)
			"garden":
				_special_garden(fin)
			"lodge":
				_special_lodge(fin)
			"observatory":
				_special_observatory(fin)
			"temple":
				_special_temple(fin)

	func _special_grove(a: float) -> void:
		var cx := float(cfg.units[0].dx)
		# a tidy stacked log pile (circles) to the right
		var bx := cx + 72.0 * size_mul
		var wood0 := _mul_a(Color(0.62, 0.44, 0.28), a)
		var wood1 := _mul_a(Color(0.42, 0.28, 0.17), a)
		var stack := [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [0, 2]]
		for pr in stack:
			var lx := bx + float(pr[0]) * 22.0 * size_mul + float(pr[1]) * 11.0 * size_mul
			var ly := -10.0 * size_mul - float(pr[1]) * 20.0 * size_mul
			draw_circle(Vector2(lx, ly), 11.0 * size_mul, wood1)
			draw_circle(Vector2(lx, ly), 9.0 * size_mul, wood0)
			draw_circle(Vector2(lx, ly), 4.0 * size_mul, _mul_a(Color(0.78, 0.6, 0.4), a))
		# a cut-plank stack to the left
		var px := cx - 100.0 * size_mul
		for i in 4:
			var pl := ProcBuildings._rect(px, -6.0 * size_mul - float(i) * 7.0 * size_mul, -float(i) * 7.0 * size_mul, 26.0 * size_mul)
			draw_polygon(pl, Proc.grad_fill(pl, _mul_a(Color(0.8, 0.64, 0.42), a), _mul_a(Color(0.6, 0.46, 0.3), a)))
		# a stump with an axe
		var sx := cx - 14.0 * size_mul
		draw_polygon(ProcBuildings._rect(sx, -16.0 * size_mul, 0.0, 12.0 * size_mul), ProcBuildings._flat(4, wood1))
		draw_circle(Vector2(sx, -16.0 * size_mul), 12.0 * size_mul, _mul_a(Color(0.72, 0.55, 0.36), a))
		draw_line(Vector2(sx + 6.0 * size_mul, -16.0 * size_mul), Vector2(sx + 20.0 * size_mul, -44.0 * size_mul), _mul_a(Color(0.45, 0.3, 0.18), a), 3.0, true)
		draw_line(Vector2(sx + 16.0 * size_mul, -40.0 * size_mul), Vector2(sx + 26.0 * size_mul, -48.0 * size_mul), _mul_a(Color(0.8, 0.82, 0.86), a), 5.0, true)

	func _special_quarry(a: float) -> void:
		var cx := float(cfg.units[0].dx)
		# cut stone blocks stacked
		var bx := cx - 92.0 * size_mul
		for i in 3:
			for j in 2 - int(i > 1):
				var blk := ProcBuildings._rect(bx + float(j) * 30.0 * size_mul + float(i) * 15.0 * size_mul, -14.0 * size_mul - float(i) * 16.0 * size_mul, -float(i) * 16.0 * size_mul, 14.0 * size_mul)
				draw_polygon(blk, Proc.grad_fill(blk, _mul_a(stone_top, a), _mul_a(stone_bot, a)))
				draw_polyline(_closed(blk), _mul_a(stone_dk, a * 0.6), 1.2, true)
		# the open cut pit in front
		var pit := Proc.smooth_loop(PackedVector2Array([
			Vector2(cx + 40.0 * size_mul, 2.0), Vector2(cx + 120.0 * size_mul, 10.0 * size_mul),
			Vector2(cx + 128.0 * size_mul, 2.0), Vector2(cx + 60.0 * size_mul, -6.0 * size_mul)]), 6)
		draw_polygon(pit, Proc.grad_fill(pit, _mul_a(stone_dk, a), _mul_a(Color(0.2, 0.2, 0.22), a)))

	func _special_mine(a: float) -> void:
		var cx := float(cfg.units[0].dx)
		# mine-cart on rails leading out of the portal
		var ry := -2.0 * size_mul
		draw_line(Vector2(cx, ry), Vector2(cx + 96.0 * size_mul, ry + 6.0 * size_mul), _mul_a(Color(0.3, 0.26, 0.24), a), 2.0, true)
		draw_line(Vector2(cx, ry - 8.0 * size_mul), Vector2(cx + 96.0 * size_mul, ry - 2.0 * size_mul), _mul_a(Color(0.3, 0.26, 0.24), a), 2.0, true)
		var ccx := cx + 60.0 * size_mul
		draw_polygon(ProcBuildings._rect(ccx, -26.0 * size_mul, -8.0 * size_mul, 16.0 * size_mul), ProcBuildings._flat(4, _mul_a(Color(0.4, 0.32, 0.24), a)))
		draw_circle(Vector2(ccx - 10.0 * size_mul, -6.0 * size_mul), 6.0 * size_mul, _mul_a(Color(0.2, 0.18, 0.18), a))
		draw_circle(Vector2(ccx + 10.0 * size_mul, -6.0 * size_mul), 6.0 * size_mul, _mul_a(Color(0.2, 0.18, 0.18), a))
		# a cluster of glowing crystals by the mouth
		for k in 4:
			var kx := cx - 30.0 * size_mul + float(k) * 10.0 * size_mul
			var kh := (14.0 + 10.0 * Proc.hashf(seedv, "cr%d" % k)) * size_mul
			var cry := PackedVector2Array([Vector2(kx - 5.0 * size_mul, 0.0), Vector2(kx - 2.5 * size_mul, -kh), Vector2(kx + 2.5 * size_mul, -kh), Vector2(kx + 5.0 * size_mul, 0.0)])
			draw_polygon(cry, Proc.grad_fill(cry, _mul_a(interior.lightened(0.3), a), _mul_a(interior.darkened(0.2), a)))

	func _special_library(a: float) -> void:
		var cx := float(cfg.units[0].dx)
		var hw := float(cfg.units[0].base_w) * 0.5 * size_mul
		# a small columned portico at the entrance
		for sx in [-1.0, 1.0]:
			var colx := cx + float(sx) * hw * 0.62
			_draw_column(colx, 96.0 * size_mul, 10.0 * size_mul, a)
		# entablature over the columns
		var ent := ProcBuildings._rect(cx, -104.0 * size_mul, -96.0 * size_mul, hw * 0.78)
		draw_polygon(ent, ProcBuildings._flat(4, _mul_a(stone_top, a)))
		# a couple of steps
		for s in 2:
			var w := hw * (0.9 - float(s) * 0.12)
			draw_polygon(ProcBuildings._rect(cx, -float(s + 1) * 6.0 * size_mul, -float(s) * 6.0 * size_mul, w), ProcBuildings._flat(4, _mul_a(stone_top.darkened(0.05 * s), a)))

	func _special_garden(a: float) -> void:
		var cx := float(cfg.units[0].dx)
		var hw := float(cfg.units[0].base_w) * 0.5 * size_mul
		# terraced flower beds along the base
		for i in 3:
			var tx := cx - hw * 0.7 + float(i) * hw * 0.7
			draw_polygon(ProcBuildings._rect(tx, -8.0 * size_mul, 0.0, hw * 0.3), ProcBuildings._flat(4, _mul_a(Color(0.4, 0.3, 0.2), a)))
			for b in 3:
				var bx := tx - hw * 0.2 + float(b) * hw * 0.2
				var bc: Color = [Color(0.95, 0.5, 0.6), Color(0.95, 0.82, 0.4), Color(0.75, 0.6, 0.95)][b % 3]
				draw_circle(Vector2(bx, -12.0 * size_mul), 4.0 * size_mul, _mul_a(bc, a))
				draw_line(Vector2(bx, -8.0 * size_mul), Vector2(bx, -2.0 * size_mul), _mul_a(Color(0.3, 0.6, 0.35), a), 1.5, true)
		# trellis arch at the door
		draw_arc(Vector2(cx, 0.0), 30.0 * size_mul, PI, TAU, 12, _mul_a(trim_dk, a), 3.0, true)

	func _special_lodge(a: float) -> void:
		var cx := float(cfg.units[0].dx)
		# a hanging lantern post by the door (glow is a child)
		var lx := cx + float(cfg.units[0].door.x) + float(cfg.units[0].door.w) * 0.7
		draw_line(Vector2(lx, -float(cfg.units[0].door.h) * 0.95), Vector2(lx, -float(cfg.units[0].door.h) * 0.75), _mul_a(Color(0.3, 0.2, 0.12), a), 2.0, true)
		draw_polygon(ProcBuildings._rect(lx, -float(cfg.units[0].door.h) * 0.74, -float(cfg.units[0].door.h) * 0.62, 5.0 * size_mul), ProcBuildings._flat(4, _mul_a(Color(0.3, 0.22, 0.14), a)))
		# a tiny weathervane / antler on the ridge
		var ry := -(float(cfg.units[0].wall_h) + float(cfg.units[0].roof_h)) * size_mul
		draw_line(Vector2(cx + 60.0 * size_mul, ry), Vector2(cx + 60.0 * size_mul, ry - 16.0 * size_mul), _mul_a(ink, a), 2.0, true)
		draw_line(Vector2(cx + 54.0 * size_mul, ry - 16.0 * size_mul), Vector2(cx + 66.0 * size_mul, ry - 16.0 * size_mul), _mul_a(ink, a), 2.0, true)

	func _special_observatory(a: float) -> void:
		var cx := float(cfg.units[0].dx)
		var top := -(float(cfg.units[0].wall_h)) * size_mul
		# telescope poking from the dome slit
		var base := Vector2(cx, top - float(cfg.units[0].roof_h) * size_mul * 0.4)
		var tube := base + Vector2(44.0 * size_mul, -34.0 * size_mul)
		draw_line(base, tube, _mul_a(Color(0.3, 0.28, 0.36), a), 10.0 * size_mul, true)
		draw_circle(tube, 8.0 * size_mul, _mul_a(interior.lightened(0.2), a))
		# star motifs on the tower
		for k in 4:
			var sx := cx - 36.0 * size_mul + float(k) * 24.0 * size_mul
			var sy := -140.0 * size_mul + (k % 2) * 20.0 * size_mul
			_draw_star(Vector2(sx, sy), 4.0 * size_mul, _mul_a(trim, a * 0.8))

	func _special_temple(a: float) -> void:
		var cx := float(cfg.units[0].dx)
		var hw := float(cfg.units[0].base_w) * 0.5 * size_mul
		# stepped stone base
		for s in 3:
			var w := hw * (1.1 - float(s) * 0.08)
			draw_polygon(ProcBuildings._rect(cx, -float(s + 1) * 8.0 * size_mul, -float(s) * 8.0 * size_mul, w), Proc.grad_fill(ProcBuildings._rect(cx, -float(s + 1) * 8.0 * size_mul, -float(s) * 8.0 * size_mul, w), _mul_a(stone_top, a), _mul_a(stone_bot, a)))
		# a colonnade of weathered columns across the front
		var ncol := 4
		for i in ncol:
			var colx := cx + (float(i) / float(ncol - 1) - 0.5) * hw * 1.5
			_draw_column(colx, 110.0 * size_mul, 11.0 * size_mul, a)
		# two brazier bowls (flames are glowing children)
		for sx in [-1.0, 1.0]:
			var bxp := cx + float(sx) * hw * 0.92
			draw_line(Vector2(bxp, 0.0), Vector2(bxp, -58.0 * size_mul), _mul_a(trim_dk, a), 3.0, true)
			var bowl := Proc.smooth_loop(PackedVector2Array([
				Vector2(bxp - 12.0 * size_mul, -58.0 * size_mul), Vector2(bxp, -52.0 * size_mul),
				Vector2(bxp + 12.0 * size_mul, -58.0 * size_mul), Vector2(bxp + 8.0 * size_mul, -66.0 * size_mul),
				Vector2(bxp - 8.0 * size_mul, -66.0 * size_mul)]), 6)
			draw_polygon(bowl, Proc.grad_fill(bowl, _mul_a(trim, a), _mul_a(trim_dk, a)))

	# ---- small shared drawing primitives -----------------------------------

	func _draw_column(cx: float, h: float, w: float, a: float) -> void:
		var shaft := ProcBuildings._rect(cx, -h, 0.0, w)
		draw_polygon(shaft, Proc.grad_fill(shaft, _mul_a(stone_top, a), _mul_a(stone_bot, a)))
		# fluting
		for f in 3:
			var fx := cx + (float(f) - 1.0) * w * 0.5
			draw_line(Vector2(fx, -h * 0.95), Vector2(fx, -h * 0.05), _mul_a(stone_dk, a * 0.4), 1.2, true)
		# capital + base
		draw_polygon(ProcBuildings._rect(cx, -h - 6.0 * size_mul, -h, w * 1.4), ProcBuildings._flat(4, _mul_a(stone_top, a)))
		draw_polygon(ProcBuildings._rect(cx, -6.0 * size_mul, 0.0, w * 1.4), ProcBuildings._flat(4, _mul_a(stone_bot, a)))

	func _draw_star(c: Vector2, r: float, col: Color) -> void:
		var pts := PackedVector2Array()
		for i in 10:
			var ang := -PI * 0.5 + TAU * float(i) / 10.0
			var rr := r if i % 2 == 0 else r * 0.42
			pts.append(c + Vector2(cos(ang), sin(ang)) * rr)
		draw_polygon(pts, ProcBuildings._flat(pts.size(), col))

	func _mul_a(c: Color, a: float) -> Color:
		return Color(c.r, c.g, c.b, c.a * a)

	func _closed(p: PackedVector2Array) -> PackedVector2Array:
		var o := PackedVector2Array(p)
		if o.size() > 0:
			o.append(o[0])
		return o

	func _scale_about(p: PackedVector2Array, pivot: Vector2, s: float) -> PackedVector2Array:
		var o := PackedVector2Array()
		o.resize(p.size())
		for i in p.size():
			o[i] = pivot + (p[i] - pivot) * s
		return o

# ===========================================================================
# _Glow — a soft radial warm/colour bloom (one window, portal, brazier…)
# ===========================================================================
class _Glow extends Node2D:
	var col := Color(1.0, 0.82, 0.45)
	var rad := 16.0

	func _draw() -> void:
		for i in 4:
			var f := 1.0 - float(i) / 4.0
			var c := Color(col.r, col.g, col.b, 0.14 + 0.16 * f)
			draw_circle(Vector2.ZERO, rad * (0.4 + 0.6 * (float(i) + 1) / 4.0), c)
		draw_circle(Vector2.ZERO, rad * 0.32, Color(1, 1, 1, 0.5).lerp(col, 0.4))

# ===========================================================================
# _Puff — one soft smoke ball; the parent drives its drift/scale/alpha
# ===========================================================================
class _Puff extends Node2D:
	var col := Color(0.86, 0.86, 0.9)

	func _draw() -> void:
		draw_circle(Vector2.ZERO, 20.0, Color(col.r, col.g, col.b, 0.5))
		draw_circle(Vector2(-6, -2), 14.0, Color(col.r, col.g, col.b, 0.4))
		draw_circle(Vector2(7, -3), 13.0, Color(col.r, col.g, col.b, 0.4))

# ===========================================================================
# _Deco — a static-shape moving part (dome cap, wheel, grindstone, hung block,
# floating relic). Parent drives its rotation / bob.
# ===========================================================================
class _Deco extends Node2D:
	var kind := "wheel"
	var c0 := Color(0.5, 0.5, 0.5)
	var c1 := Color(0.3, 0.3, 0.3)
	var c2 := Color(0.8, 0.8, 1.0)
	var rx := 20.0
	var ry := 20.0

	func _draw() -> void:
		match kind:
			"wheel", "grindstone":
				draw_circle(Vector2.ZERO, rx, c1)
				draw_circle(Vector2.ZERO, rx * 0.86, c0)
				for k in 6:
					var ang := TAU * float(k) / 6.0
					draw_line(Vector2.ZERO, Vector2(cos(ang), sin(ang)) * rx * 0.82, c1, 3.0, true)
				draw_circle(Vector2.ZERO, rx * 0.2, c1)
			"dome_cap":
				var arc := ProcBuildings._arc_pts(Vector2.ZERO, rx, ry, PI, TAU, 24)
				var poly := PackedVector2Array(arc)
				poly.append(Vector2(rx, 0)); poly.append(Vector2(-rx, 0))
				draw_polygon(poly, Proc.grad_fill(poly, c0.lightened(0.15), c1))
				# the open slit (shows the glow behind it)
				var slit := PackedVector2Array([
					Vector2(-rx * 0.1, 0.0), Vector2(-rx * 0.08, -ry * 0.92),
					Vector2(rx * 0.08, -ry * 0.92), Vector2(rx * 0.1, 0.0)])
				draw_polygon(slit, ProcBuildings._flat(4, Color(0.05, 0.05, 0.1)))
				for b in range(1, 4):
					var f := float(b) / 4.0
					draw_polyline(ProcBuildings._arc_pts(Vector2.ZERO, rx * (1.0 - f * 0.1), ry * (1.0 - f), PI, TAU, 18), Color(c1.r, c1.g, c1.b, 0.4), 1.4, true)
			"hangblock":
				draw_line(Vector2(0, -60), Vector2.ZERO, Color(0.3, 0.22, 0.14), 2.0, true)
				var blk := ProcBuildings._rect(0.0, -rx, rx, rx)
				draw_polygon(blk, Proc.grad_fill(blk, c0, c1))
			"relic":
				# a glowing faceted gem
				var gem := PackedVector2Array([
					Vector2(0, -rx), Vector2(rx * 0.7, -rx * 0.2),
					Vector2(rx * 0.45, rx * 0.8), Vector2(-rx * 0.45, rx * 0.8),
					Vector2(-rx * 0.7, -rx * 0.2)])
				draw_circle(Vector2.ZERO, rx * 1.4, Color(c0.r, c0.g, c0.b, 0.2))
				draw_polygon(gem, Proc.grad_fill(gem, c1, c0))
				draw_polyline(ProcBuildings._bld_closed(gem), Color(1, 1, 1, 0.6), 1.4, true)

	static func _unused() -> void:
		pass

# ===========================================================================
# _Banner — a hanging cloth that ripples (shape changes per frame -> own redraw,
# but it is tiny: a pennant of ~10 verts). Parent sets `wind`.
# ===========================================================================
class _Banner extends ProcNode:
	var col_a := Color(0.8, 0.5, 0.3)
	var col_b := Color(0.9, 0.6, 0.4)
	var length := 50.0
	var wind := 1.0

	func _on_built() -> void:
		animate_draw = true
		set_grow_minutes(0.0)   # banners don't "grow"; they just flutter
		growth = 1.0

	func _draw() -> void:
		var L := length
		var w := L * 0.42
		# the pole
		draw_line(Vector2(0, 6), Vector2(0, -L * 0.5), Color(0.3, 0.22, 0.14), 3.0, true)
		draw_circle(Vector2(0, -L * 0.5), 3.0, Color(0.85, 0.7, 0.3))
		# the cloth: a ripple along its length
		var n := 10
		var top := PackedVector2Array()
		var bot := PackedVector2Array()
		top.resize(n); bot.resize(n)
		for i in n:
			var f := float(i) / float(n - 1)
			var x := f * L
			var rip := sin(f * 5.0 - t * 4.0 + phase) * w * 0.16 * (0.3 + f) * wind
			top[i] = Vector2(x, -L * 0.42 + rip)
			bot[i] = Vector2(x, -L * 0.42 + w * (1.0 - f * 0.35) + rip)
		var poly := PackedVector2Array()
		poly.append_array(top)
		for i in n:
			poly.append(bot[n - 1 - i])
		draw_polygon(poly, Proc.grad_fill(poly, col_b, col_a))
		# a swallowtail notch look via an emblem dot
		draw_circle(Vector2(L * 0.4, -L * 0.42 + w * 0.4), w * 0.16, Color(1, 1, 1, 0.7))

	func _animate(_d: float) -> void:
		pass
