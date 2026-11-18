class_name ProcPlants
extends RefCounted
# ProcPlants — the LOW-FLORA generator for Blockle Idle.
#
# Everything here is synthesised from (world_seed, key): wildflowers of many
# shapes and colours, grass tufts, bushes, shrubs, pines, ferns, fiddleheads,
# vines, reeds, clover, flower patches, berry bushes, pumpkins, cacti, saplings.
# Each reads as the real thing (CONVENTIONS rule 1), is drawn with smooth
# Catmull/superellipse outlines + vertex-colour gradients (rule 2), is a pure
# function of its seed (rule 3), stages a believable form for ANY growth in
# [0,1] (rule 4), sways/breathes forever (rule 5), redraws only when the shape
# changes (rule 6), and stands feet-at-origin in portrait (rule 7).
#
# GROWTH  — one organic clock. Stems climb, leaves unfold at seeded heights,
#           buds swell and petals bloom open, pumpkins ripen green→orange,
#           fiddleheads uncoil into fronds — all continuous via g()/smoothstep.
# ANIM    — CHEAP. The whole plant is drawn once into a child "body" node; each
#           frame we only set that child's rotation / skew / scale (a gusting
#           wind that pivots about the feet and leans toward the light). No
#           per-frame allocation, no per-frame redraw.
#
# Usage (a world builder):
#   ProcPlants.make(world_seed, "garden:7", "poppy", ctx)
#   ProcPlants.from_decoration(world_seed, key, "berrybush", ctx)
#   ProcPlants.wildflower(world_seed, key, ctx)   # seed-chosen flower species
# ctx (all optional): { local_palette:Dictionary, light_dir:Vector2,
#                       elevation:float(0..1), neighbours:int }

# ---------------------------------------------------------------------------
# Public species catalogue + factories
# ---------------------------------------------------------------------------

const SPECIES := [
	"flower", "daisy", "tulip", "poppy", "bluebell", "sunflower", "dandelion",
	"clover", "flowerpatch", "grasstuft", "reed", "bush", "shrub", "pine",
	"berrybush", "fern", "fiddlehead", "vine", "pumpkin", "cactus", "sapling",
]

const FLOWERS := [
	"flower", "daisy", "tulip", "poppy", "bluebell", "sunflower", "dandelion",
]

# Map the data/decorations.json ids onto our kinds.
const DECO_MAP := {
	"flower": "flower", "daisy": "daisy", "tulip": "tulip", "poppy": "poppy",
	"bluebell": "bluebell", "sunflower": "sunflower", "dandelion": "dandelion",
	"fern": "fern", "fiddlehead": "fiddlehead", "bush": "bush", "shrub": "shrub",
	"pine": "pine", "sapling": "sapling", "cactus": "cactus", "vine": "vine",
	"grasstuft": "grasstuft", "reed": "reed", "clover": "clover",
	"flowerpatch": "flowerpatch", "berrybush": "berrybush", "pumpkin": "pumpkin",
}

# The main entry point. `species` may be a kind, a decoration id, or "random".
static func make(world_seed: int, key: String, species: String = "flower", context: Dictionary = {}) -> ProcNode:
	var n := _Plant.new()
	n.seedv = hash("%d:%s" % [world_seed, key])
	n.kind = _normalize(n.seedv, species)
	n._ctx = context.duplicate(true)
	return n

# Build directly from a decorations.json id.
#
# FLORA ONLY. ProcPlants is the low-flora module: the caller MUST pre-filter so
# only plant-material decoration ids (see DECO_MAP) reach here. Non-plant ids
# (mushroom/toadstool/rock/crystal/lantern/lilypad/pond/…) belong to their own
# sibling modules. If an unknown id slips through we still return a wildflower
# (so a world never crashes mid-build), but we push a warning rather than
# silently coercing it — that mis-render is a routing bug in the caller.
static func from_decoration(world_seed: int, key: String, decoration_id: String, context: Dictionary = {}) -> ProcNode:
	var id := decoration_id.strip_edges().to_lower()
	if not DECO_MAP.has(id) and not SPECIES.has(id) and id != "random" and id != "":
		push_warning("ProcPlants.from_decoration: '%s' is not a known flora id; " % decoration_id
			+ "caller should pre-filter by material==plant. Falling back to a wildflower.")
	var k: String = DECO_MAP.get(decoration_id, decoration_id)
	return make(world_seed, key, k, context)

# A seed-chosen wildflower (one of the flowering kinds).
static func wildflower(world_seed: int, key: String, context: Dictionary = {}) -> ProcNode:
	var i := int(Proc.hashf(hash("%d:%s" % [world_seed, key]), "wf") * FLOWERS.size())
	return make(world_seed, key, FLOWERS[clampi(i, 0, FLOWERS.size() - 1)], context)

# A seed-chosen species from the whole catalogue (great for dense scatter).
static func random_species(world_seed: int, key: String, context: Dictionary = {}) -> ProcNode:
	var i := int(Proc.hashf(hash("%d:%s" % [world_seed, key]), "sp") * SPECIES.size())
	return make(world_seed, key, SPECIES[clampi(i, 0, SPECIES.size() - 1)], context)

# Thin convenience wrappers so a builder reads nicely.
static func grass(ws: int, key: String, ctx: Dictionary = {}) -> ProcNode: return make(ws, key, "grasstuft", ctx)
static func bush(ws: int, key: String, ctx: Dictionary = {}) -> ProcNode: return make(ws, key, "bush", ctx)
static func shrub(ws: int, key: String, ctx: Dictionary = {}) -> ProcNode: return make(ws, key, "shrub", ctx)
static func fern(ws: int, key: String, ctx: Dictionary = {}) -> ProcNode: return make(ws, key, "fern", ctx)
static func vine(ws: int, key: String, ctx: Dictionary = {}) -> ProcNode: return make(ws, key, "vine", ctx)
static func reed(ws: int, key: String, ctx: Dictionary = {}) -> ProcNode: return make(ws, key, "reed", ctx)
static func clover(ws: int, key: String, ctx: Dictionary = {}) -> ProcNode: return make(ws, key, "clover", ctx)
static func berrybush(ws: int, key: String, ctx: Dictionary = {}) -> ProcNode: return make(ws, key, "berrybush", ctx)
static func pumpkin(ws: int, key: String, ctx: Dictionary = {}) -> ProcNode: return make(ws, key, "pumpkin", ctx)
static func crop(ws: int, key: String, ctx: Dictionary = {}) -> ProcNode:
	var warm := Proc.hashf(hash("%d:%s" % [ws, key]), "crop") < 0.6
	return make(ws, key, ("pumpkin" if warm else "cactus"), ctx)

static func _normalize(seedv: int, s: String) -> String:
	var k := s.strip_edges().to_lower()
	if k == "random" or k == "":
		var i := int(Proc.hashf(seedv, "norm") * SPECIES.size())
		return SPECIES[clampi(i, 0, SPECIES.size() - 1)]
	if DECO_MAP.has(k):
		return DECO_MAP[k]
	if SPECIES.has(k):
		return k
	# gentle aliases
	match k:
		"grass", "tuft": return "grasstuft"
		"wildflower", "bloom": return "flower"
		"cattail": return "reed"
		"squash", "gourd": return "pumpkin"
		"succulent": return "cactus"
		"trefoil": return "clover"
		_: return "flower"


# ===========================================================================
# The living plant node
# ===========================================================================
class _Plant extends ProcNode:
	var kind := "flower"
	var _ctx := {}

	# A dedicated child that holds the whole drawn plant, so wind is a single
	# cheap transform about the feet.
	var _body: Node2D

	# placement contract (CONVENTIONS / IDLE-DESIGN §7)
	var footprint_radius: float = 22.0

	# cached geometry / feel
	var _h: float = 90.0          # mature height (px)
	var _flex: float = 1.0        # how much it bends in wind
	var _amp: float = 0.10        # sway amplitude (rad) at full growth
	var _spd: float = 1.4         # sway speed
	var _lean: float = 0.0        # steady lean toward the light
	var _nvar: int = 0            # seeded count variation (petals/blades/berries)
	var _svar: float = 1.0        # per-instance scale variation
	var _flip: float = 1.0        # mirror some asymmetric forms

	# colours
	var _stem_a: Color
	var _stem_b: Color
	var _leaf_a: Color
	var _leaf_b: Color
	var _petal_a: Color
	var _petal_b: Color
	var _center: Color
	var _accent: Color

	func _on_built() -> void:
		_svar = _rngv("svar", 0.86, 1.16)
		_nvar = int(_hf("nvar") * 5.0)          # 0..4
		_flip = 1.0 if _hf("flip") < 0.5 else -1.0
		_setup_kind()
		_setup_colors()
		_apply_context()
		# the wind body
		_body = _Body.new()
		_body.plant = self
		_body.position = Vector2.ZERO
		add_child(_body)
		_body.queue_redraw()

	# -- pacing / sizing per species ----------------------------------------
	func _setup_kind() -> void:
		var mins := 5.0
		match kind:
			"flower":
				_h = 92.0; footprint_radius = 20.0; _flex = 1.0; mins = 5.0
			"daisy":
				_h = 84.0; footprint_radius = 20.0; _flex = 1.0; mins = 4.5
			"poppy":
				_h = 96.0; footprint_radius = 18.0; _flex = 1.25; mins = 5.0
			"tulip":
				_h = 104.0; footprint_radius = 20.0; _flex = 0.8; mins = 5.5
			"bluebell":
				_h = 112.0; footprint_radius = 24.0; _flex = 1.15; mins = 6.0
			"sunflower":
				_h = 156.0; footprint_radius = 28.0; _flex = 0.6; mins = 7.0
			"dandelion":
				_h = 80.0; footprint_radius = 18.0; _flex = 1.15; mins = 4.0
			"clover":
				_h = 42.0; footprint_radius = 20.0; _flex = 1.05; mins = 4.0
			"flowerpatch":
				_h = 58.0; footprint_radius = 34.0; _flex = 1.1; mins = 5.0
			"grasstuft":
				_h = 98.0; footprint_radius = 24.0; _flex = 1.45; mins = 3.0
			"reed":
				_h = 164.0; footprint_radius = 26.0; _flex = 1.25; mins = 6.0
			"bush":
				_h = 104.0; footprint_radius = 50.0; _flex = 0.5; mins = 14.0
			"shrub":
				_h = 92.0; footprint_radius = 44.0; _flex = 0.55; mins = 13.0
			"pine":
				_h = 118.0; footprint_radius = 42.0; _flex = 0.4; mins = 18.0
			"berrybush":
				_h = 98.0; footprint_radius = 46.0; _flex = 0.5; mins = 16.0
			"fern":
				_h = 92.0; footprint_radius = 40.0; _flex = 1.05; mins = 8.0
			"fiddlehead":
				_h = 58.0; footprint_radius = 20.0; _flex = 1.0; mins = 6.0
			"vine":
				_h = 168.0; footprint_radius = 24.0; _flex = 1.3; mins = 10.0
			"pumpkin":
				_h = 56.0; footprint_radius = 42.0; _flex = 0.22; mins = 8.0
			"cactus":
				_h = 112.0; footprint_radius = 26.0; _flex = 0.2; mins = 18.0
			"sapling":
				_h = 150.0; footprint_radius = 40.0; _flex = 0.7; mins = 30.0
			_:
				_h = 90.0; footprint_radius = 22.0; _flex = 1.0; mins = 5.0
		_h *= _svar
		footprint_radius *= _svar
		_amp = 0.09 * _flex
		_spd = _rngv("spd", 1.05, 1.9) * (1.0 + 0.2 * _flex)
		# very-slow continuous growth, seed-jittered ±30%
		set_grow_minutes(mins * _rngv("mins", 0.72, 1.3))

	# -- colour harmony ------------------------------------------------------
	func _setup_colors() -> void:
		var gh := _rngv("gh", 0.26, 0.37)
		var gs := _rngv("gs", 0.42, 0.64)
		var gv := _rngv("gvv", 0.56, 0.80)
		_stem_b = Color.from_hsv(gh, gs, gv * 0.82)
		_stem_a = Color.from_hsv(gh, gs * 0.78, minf(1.0, gv + 0.12))
		_leaf_b = Color.from_hsv(gh, gs, gv * 0.86)
		_leaf_a = Color.from_hsv(fposmod(gh - 0.02, 1.0), gs * 0.82, minf(1.0, gv + 0.15))
		_accent = Color.from_hsv(fposmod(gh + 0.5, 1.0), 0.6, 0.9)

		var ph := _hf("ph")
		# defaults — a vivid seed-chosen wildflower
		_petal_a = Color.from_hsv(ph, 0.7, 0.98)
		_petal_b = Color.from_hsv(ph, 0.86, 0.80)
		_center = Color.from_hsv(fposmod(ph + 0.09, 1.0), 0.72, 0.96)

		match kind:
			"poppy":
				# iconic red poppy: a narrow band wrapped across the hue origin
				# (scarlet 0.965..1.0 through to warm red 0.0..0.035). A plain
				# ascending Proc.rangef here would interpolate the long way round
				# and land in orange/yellow/green — so wrap with fposmod.
				_petal_a = Color.from_hsv(fposmod(_rngv("pp", -0.035, 0.035), 1.0), 0.84, 0.96)
				_petal_b = _petal_a.darkened(0.22)
				_center = Color(0.12, 0.07, 0.10)
			"tulip":
				var th: float = [0.0, 0.045, 0.9, 0.12, 0.95][int(_hf("th") * 5.0) % 5]
				_petal_a = Color.from_hsv(th, 0.78, 0.98)
				_petal_b = _petal_a.darkened(0.2)
				_center = Color.from_hsv(0.14, 0.5, 0.9)
			"bluebell":
				var bh := _rngv("bh", 0.60, 0.74)
				_petal_a = Color.from_hsv(bh, 0.62, 0.95)
				_petal_b = Color.from_hsv(bh, 0.8, 0.72)
				_center = _petal_a.lightened(0.2)
			"sunflower":
				_petal_a = Color.from_hsv(0.125, 0.85, 1.0)
				_petal_b = Color.from_hsv(0.10, 0.95, 0.82)
				_center = Color(0.34, 0.20, 0.08)
			"dandelion":
				_petal_a = Color.from_hsv(0.14, 0.88, 1.0)
				_petal_b = Color.from_hsv(0.11, 0.95, 0.85)
				_center = Color.from_hsv(0.13, 0.7, 0.92)
			"daisy":
				_petal_a = Color(1.0, 1.0, 0.985)
				_petal_b = Color(0.85, 0.87, 0.93)
				_center = Color.from_hsv(0.13, 0.85, 0.98)
			"shrub":
				_petal_a = Color.from_hsv(ph, 0.4, 1.0)
				_petal_b = Color.from_hsv(ph, 0.55, 0.9)
			"berrybush":
				# ripe red berries: wrapped red band across the hue origin
				# (deep crimson 0.97..1.0 through to red 0.0..0.03).
				_accent = Color.from_hsv(fposmod(_rngv("bb", -0.03, 0.03), 1.0), 0.8, 0.85)
			"cactus":
				_petal_a = Color.from_hsv(_rngv("cf", 0.88, 0.98), 0.6, 0.98)
				_petal_b = _petal_a.darkened(0.18)
			"pumpkin":
				_petal_a = Color.from_hsv(0.07, 0.85, 0.95)   # ripe orange
				_petal_b = Color.from_hsv(0.055, 0.92, 0.78)

	# -- adapt to neighbourhood (IDLE-DESIGN §2.3a) -------------------------
	func _apply_context() -> void:
		var ld = _ctx.get("light_dir", Vector2(-0.35, -1.0))
		if ld is Vector2 and ld.length() > 0.01:
			_lean = clampf((ld as Vector2).normalized().x, -1.0, 1.0) * 0.16 * _flex
		var elev := float(_ctx.get("elevation", 0.0))
		# windswept on high/outer ground, fuller when sheltered
		var sh := lerpf(1.0, 0.82, clampf(elev, 0.0, 1.0))
		_h *= sh
		footprint_radius *= lerpf(1.0, 0.88, clampf(elev, 0.0, 1.0))
		_amp *= lerpf(1.0, 1.35, clampf(elev, 0.0, 1.0))
		var nb := int(_ctx.get("neighbours", 0))
		if nb > 0:
			# desync the sway within a cluster so it breathes as a loose round
			phase += float(nb) * 0.7
		var lp = _ctx.get("local_palette", null)
		if lp is Dictionary:
			_blend_local(lp)

	func _blend_local(lp: Dictionary) -> void:
		var amt := 0.24
		if lp.has("base"):
			_stem_a = _stem_a.lerp(lp["base"], amt * 0.6)
			_stem_b = _stem_b.lerp(lp["base"], amt * 0.6)
			_leaf_a = _leaf_a.lerp(lp["base"], amt)
			_leaf_b = _leaf_b.lerp(lp["base"], amt)
		if lp.has("accent"):
			_petal_a = _petal_a.lerp(lp["accent"], amt * 0.5)
			_petal_b = _petal_b.lerp(lp["accent"], amt * 0.5)

	# -- growth / anim -------------------------------------------------------
	func _on_growth() -> void:
		if _body:
			_body.queue_redraw()

	func _animate(_d: float) -> void:
		if _body == null:
			return
		var gv := g()
		# a slow gusting envelope so the breeze swells and falls
		var gust := 0.60 + 0.40 * sin(t * 0.27 + phase * 0.6)
		var a := _lean * gv + _amp * gv * gust * sin(t * _spd + phase)
		_body.rotation = a
		_body.skew = 0.45 * _amp * gv * sin(t * _spd * 1.63 + phase * 1.3)
		# a whisper of breathing
		_body.scale = Vector2(1.0, 1.0 + 0.012 * sin(t * 1.1 + phase))

	# -- the ground shadow (stays put while the body sways) -----------------
	func _draw() -> void:
		var gv := g()
		var r := footprint_radius * (0.42 + 0.58 * gv)
		var sh := PackedVector2Array()
		var n := 18
		for i in range(n):
			var ang := TAU * float(i) / float(n)
			sh.append(Vector2(cos(ang) * r, sin(ang) * r * 0.30))
		draw_colored_polygon(sh, Color(0.05, 0.08, 0.06, 0.16))

	# =====================================================================
	# BODY DRAW — dispatched by kind. `ci` is the swaying child canvas.
	# =====================================================================
	func _draw_body(ci: CanvasItem) -> void:
		var gv := g()
		match kind:
			"flower": _d_flower(ci, gv)
			"daisy": _d_daisy(ci, gv)
			"poppy": _d_poppy(ci, gv)
			"tulip": _d_tulip(ci, gv)
			"bluebell": _d_bluebell(ci, gv)
			"sunflower": _d_sunflower(ci, gv)
			"dandelion": _d_dandelion(ci, gv)
			"clover": _d_clover(ci, gv)
			"flowerpatch": _d_flowerpatch(ci, gv)
			"grasstuft": _d_grass(ci, gv)
			"reed": _d_reed(ci, gv)
			"bush": _d_bush(ci, gv)
			"shrub": _d_shrub(ci, gv)
			"pine": _d_pine(ci, gv)
			"berrybush": _d_berrybush(ci, gv)
			"fern": _d_fern(ci, gv)
			"fiddlehead": _d_fiddlehead(ci, gv)
			"vine": _d_vine(ci, gv)
			"pumpkin": _d_pumpkin(ci, gv)
			"cactus": _d_cactus(ci, gv)
			"sapling": _d_sapling(ci, gv)
			_: _d_flower(ci, gv)

	# ---------------------------------------------------------------------
	# FLOWERING KINDS
	# ---------------------------------------------------------------------
	func _d_flower(ci: CanvasItem, gv: float) -> void:
		var top := _draw_stem_leaves(ci, gv, _h, 4.5, 2, _flip)
		var petals := 5 + (_nvar % 3)
		_head_radial(ci, top, gv, petals, _h * 0.17, _h * 0.085, _petal_a, _petal_b, _center, _h * 0.07, 0.6, 0.95)

	func _d_daisy(ci: CanvasItem, gv: float) -> void:
		var top := _draw_stem_leaves(ci, gv, _h, 4.0, 2, _flip)
		var petals := 11 + (_nvar * 2)
		_head_radial(ci, top, gv, petals, _h * 0.19, _h * 0.045, _petal_a, _petal_b, _center, _h * 0.065, 0.58, 0.92)

	func _d_poppy(ci: CanvasItem, gv: float) -> void:
		# thin hairy stem, nodding bud when young
		var nod := (1.0 - smoothstep(0.35, 0.7, gv)) * 0.5
		var top := _draw_stem_leaves(ci, gv, _h, 3.2, 1, _flip)
		top += Vector2(_flip * nod * _h * 0.12, nod * _h * 0.05)
		# a few stem hairs
		var hs := Color(_stem_b.r, _stem_b.g, _stem_b.b, 0.5)
		for i in range(5):
			var hy := -_h * (0.3 + 0.12 * i) * gv
			var hx := _bow_x(-_h * (0.3 + 0.12 * i) * gv, _h, _flip)
			ci.draw_line(Vector2(hx, hy), Vector2(hx + _flip * 4.0, hy - 5.0), hs, 1.0, true)
		_head_radial(ci, top, gv, 5, _h * 0.18, _h * 0.12, _petal_a, _petal_b, _center, _h * 0.05, 0.5, 0.9)

	func _d_tulip(ci: CanvasItem, gv: float) -> void:
		var top := _draw_stem_leaves(ci, gv, _h, 6.0, 2, _flip)
		_head_tulip(ci, top, gv)

	func _d_sunflower(ci: CanvasItem, gv: float) -> void:
		var top := _draw_stem_leaves(ci, gv, _h, 8.0, 3, _flip)
		var petals := 18 + (_nvar * 2)
		_head_radial(ci, top, gv, petals, _h * 0.15, _h * 0.05, _petal_a, _petal_b, _center, _h * 0.11, 0.5, 0.9)
		# seed-face dots
		var open := smoothstep(0.55, 0.92, gv)
		if open > 0.1:
			var cr := _h * 0.11 * lerpf(0.4, 1.0, open)
			var dc := _center.darkened(0.25)
			var rings := 2
			for ring in range(1, rings + 1):
				var rr := cr * float(ring) / float(rings + 1)
				var cnt := 5 + ring * 5
				for j in range(cnt):
					var aa := TAU * float(j) / float(cnt) + ring * 0.4
					var p := top + Vector2(cos(aa) * rr, -_h * 0.0 + sin(aa) * rr)
					ci.draw_circle(p, 1.6, dc)

	func _d_dandelion(ci: CanvasItem, gv: float) -> void:
		var top := _draw_stem_leaves(ci, gv, _h, 3.2, 2, _flip)
		var yellow := 1.0 - smoothstep(0.62, 0.82, gv)
		var puff := smoothstep(0.66, 0.86, gv)
		if yellow > 0.01:
			var pa := _petal_a
			pa.a = yellow
			var pb := _petal_b
			pb.a = yellow
			var cc := _center
			cc.a = yellow
			_head_radial(ci, top, gv, 22, _h * 0.12, _h * 0.03, pa, pb, cc, _h * 0.05, 0.5, 0.86)
		if puff > 0.01:
			_head_seedpuff(ci, top, puff, _h * 0.17 * lerpf(0.7, 1.0, gv))

	func _d_bluebell(ci: CanvasItem, gv: float) -> void:
		# arching stem of hanging bells + 2 strap leaves
		var H := _h * gv
		var arc := _flip * _h * 0.22
		# strap leaves
		for s in range(2):
			var side := 1.0 if s == 0 else -1.0
			var lg := smoothstep(0.1, 0.35, gv)
			if lg > 0.01:
				var leaf := _blade(Vector2(side * 4.0, 0), Vector2(side * _h * 0.13, -_h * 0.6 * gv * lg), _h * 0.06, side * 0.1)
				if leaf.size() > 2:
					ci.draw_polygon(leaf, Proc.grad_fill(leaf, _leaf_a, _leaf_b))
		# arching stem as a smooth thick line
		var spine := PackedVector2Array()
		var segs := 10
		for i in range(segs + 1):
			var tt := float(i) / float(segs)
			# ease the arch over so the top droops
			var x := arc * tt * tt
			spine.append(Vector2(x, -H * tt))
		ci.draw_polyline(spine, _stem_b, 2.6, true)
		# bells hanging from the upper half
		var nbell := 4 + (_nvar % 3)
		var bloom := smoothstep(0.4, 0.95, gv)
		for i in range(nbell):
			var f := 0.45 + 0.55 * float(i) / float(maxi(1, nbell - 1))
			var bg := smoothstep(0.35 + f * 0.25, 0.6 + f * 0.25, gv)
			if bg <= 0.01:
				continue
			var ax := arc * f * f
			var anchor := Vector2(ax, -H * f)
			var bsz := _h * 0.05 * bg
			var bell_c := anchor + Vector2(_flip * bsz * 0.3, bsz * 1.6)
			ci.draw_line(anchor, bell_c + Vector2(0, -bsz * 0.6), _stem_b, 1.4, true)
			var bell := _offset(Proc.superellipse(bsz * 0.8, bsz * 1.15, 2.3, 16), bell_c)
			ci.draw_polygon(bell, Proc.grad_fill(bell, _petal_a, _petal_b))
			# scalloped rim hint
			ci.draw_circle(bell_c + Vector2(0, bsz * 1.0), bsz * 0.28, _petal_b.darkened(0.1))

	func _d_clover(ci: CanvasItem, gv: float) -> void:
		var stems := 3 + (_nvar % 2)
		for i in range(stems):
			var f := float(i) / float(maxi(1, stems - 1)) - 0.5
			var sg := smoothstep(0.08, 0.4, gv)
			var sh := _h * (0.6 + 0.4 * _hf("ch%d" % i)) * gv
			var sx := f * footprint_radius * 0.7
			var topp := Vector2(sx + f * sh * 0.3, -sh)
			ci.draw_line(Vector2(sx, 0), topp, _stem_b, 2.0, true)
			if sg > 0.01:
				_trefoil(ci, topp, _h * 0.16 * sg, i)
		# a tiny flower puff on the tallest at maturity
		var fl := smoothstep(0.7, 0.95, gv)
		if fl > 0.01:
			var fy := -_h * 1.05 * gv
			var fc := Color.from_hsv(_hf("cfh") * 0.1 + 0.9, 0.4, 1.0)
			ci.draw_line(Vector2(0, 0), Vector2(0, fy), _stem_b, 2.0, true)
			for j in range(10):
				var aa := TAU * float(j) / 10.0
				ci.draw_circle(Vector2(0, fy) + Vector2(cos(aa), sin(aa)) * _h * 0.05 * fl, 2.2, fc)

	func _d_flowerpatch(ci: CanvasItem, gv: float) -> void:
		# a low clump of grass blades + a few tiny mixed flowers
		var blades := 4 + _nvar
		for i in range(blades):
			var f := float(i) / float(maxi(1, blades - 1)) - 0.5
			var bl := _h * (0.7 + 0.3 * _hf("fb%d" % i)) * gv
			var bx := f * footprint_radius * 0.9
			var blade := _blade(Vector2(bx, 0), Vector2(bx + f * bl * 0.4, -bl), _h * 0.05, f * 0.5)
			if blade.size() > 2:
				ci.draw_polygon(blade, Proc.grad_fill(blade, _leaf_a, _stem_b))
		var nf := 3 + (_nvar % 3)
		for i in range(nf):
			var fx := (_hf("pfx%d" % i) - 0.5) * footprint_radius * 1.3
			var fh := _h * (0.6 + 0.4 * _hf("pfh%d" % i)) * gv
			var top := Vector2(fx, -fh)
			ci.draw_line(Vector2(fx, 0), top, _stem_b, 1.8, true)
			var ph := _hf("pfc%d" % i)
			var pa := Color.from_hsv(ph, 0.72, 1.0)
			_head_radial(ci, top, gv, 5, _h * 0.12, _h * 0.06, pa, pa.darkened(0.2), Color.from_hsv(fposmod(ph + 0.1, 1.0), 0.7, 0.98), _h * 0.04, 0.5, 0.9)

	# ---------------------------------------------------------------------
	# GRASS / REEDS
	# ---------------------------------------------------------------------
	func _d_grass(ci: CanvasItem, gv: float) -> void:
		var nb := 5 + _nvar
		for i in range(nb):
			var f := float(i) / float(maxi(1, nb - 1)) - 0.5
			var bl := _h * (0.7 + 0.35 * _hf("gb%d" % i)) * gv
			var bx := f * footprint_radius * 0.7
			var curve := (f + 0.12 * (_hf("gc%d" % i) - 0.5)) * 0.8
			var tip := Vector2(bx + f * bl * 0.5, -bl)
			var blade := _blade(Vector2(bx, 0), tip, _h * 0.045 * (0.8 + 0.4 * _hf("gw%d" % i)), curve)
			if blade.size() > 2:
				var tipc := _leaf_a.lightened(0.1)
				ci.draw_polygon(blade, Proc.grad_fill(blade, tipc, _stem_b))

	func _d_reed(ci: CanvasItem, gv: float) -> void:
		var nb := 3 + (_nvar % 3)
		for i in range(nb):
			var f := float(i) / float(maxi(1, nb - 1)) - 0.5
			var bl := _h * (0.8 + 0.2 * _hf("rb%d" % i)) * gv
			var bx := f * footprint_radius * 0.6
			# tall straight-ish blade
			var blade := _blade(Vector2(bx, 0), Vector2(bx + f * bl * 0.25, -bl), _h * 0.035, f * 0.3)
			if blade.size() > 2:
				ci.draw_polygon(blade, Proc.grad_fill(blade, _leaf_a, _stem_b))
			# a cattail head on the inner stalks at maturity
			var cat := smoothstep(0.55, 0.85, gv)
			if cat > 0.01 and absf(f) < 0.3:
				var cy := -bl * 0.78
				var cx := bx + f * bl * 0.2
				var cap := _offset(Proc.superellipse(_h * 0.028, _h * 0.12 * cat, 3.2, 16), Vector2(cx, cy))
				var br := Color.from_hsv(0.07, 0.72, 0.42)
				ci.draw_polygon(cap, Proc.grad_fill(cap, br.lightened(0.12), br.darkened(0.15)))

	# ---------------------------------------------------------------------
	# BUSHES / SHRUBS / PINES
	# ---------------------------------------------------------------------
	func _d_bush(ci: CanvasItem, gv: float) -> void:
		_draw_mound(ci, gv, footprint_radius * 1.05, _leaf_a, _leaf_b, 9)

	func _d_shrub(ci: CanvasItem, gv: float) -> void:
		var c := _draw_mound(ci, gv, footprint_radius * 1.0, _leaf_a, _leaf_b, 9)
		# dusting of small flowers
		var fl := smoothstep(0.5, 0.85, gv)
		if fl > 0.01:
			var nf := 5 + _nvar
			for i in range(nf):
				var a := TAU * _hf("sf%d" % i)
				var rr := footprint_radius * 0.7 * _hf("sr%d" % i)
				var p := c + Vector2(cos(a), sin(a) * 0.7) * rr
				ci.draw_circle(p, 3.0 * fl, _petal_a)
				ci.draw_circle(p, 1.2 * fl, _center)

	func _d_pine(ci: CanvasItem, gv: float) -> void:
		var r := footprint_radius * gv
		# little brown trunk
		var tw := r * 0.12
		ci.draw_colored_polygon(PackedVector2Array([
			Vector2(-tw, 0), Vector2(tw, 0), Vector2(tw * 0.7, -r * 0.4), Vector2(-tw * 0.7, -r * 0.4)]),
			Color.from_hsv(0.08, 0.55, 0.42))
		var tiers := 3
		var dk := Color.from_hsv(0.36, 0.6, 0.44)
		var lt := Color.from_hsv(0.33, 0.52, 0.62)
		for i in range(tiers):
			var ti := float(i) / float(tiers)
			var rr := r * (1.0 - ti * 0.55)
			var cy := -r * (0.35 + ti * 0.72)
			var blob := _offset(Proc.blob(seedv, "pine%d" % i, rr * 0.7, 7, 0.26), Vector2(0, cy))
			# flatten slightly into a conifer tier
			for k in range(blob.size()):
				blob[k] = Vector2(blob[k].x * 1.15, blob[k].y * 0.8)
			ci.draw_polygon(blob, Proc.grad_fill(blob, lt.lerp(dk, ti), dk))

	func _d_berrybush(ci: CanvasItem, gv: float) -> void:
		var c := _draw_mound(ci, gv, footprint_radius * 1.0, _leaf_a, _leaf_b, 9)
		var fl := smoothstep(0.55, 0.85, gv)
		if fl > 0.01:
			var nb := 6 + _nvar * 2
			for i in range(nb):
				var a := TAU * _hf("be%d" % i)
				var rr := footprint_radius * 0.72 * (0.4 + 0.6 * _hf("br%d" % i))
				var p := c + Vector2(cos(a), sin(a) * 0.75) * rr
				var bs := 2.6 * fl
				ci.draw_circle(p, bs, _accent.darkened(0.1))
				ci.draw_circle(p + Vector2(-bs * 0.3, -bs * 0.3), bs * 0.4, _accent.lightened(0.4))

	# ---------------------------------------------------------------------
	# FERNS
	# ---------------------------------------------------------------------
	func _d_fern(ci: CanvasItem, gv: float) -> void:
		var fronds := 4 + (_nvar % 3)
		var open := smoothstep(0.4, 0.62, gv)
		for i in range(fronds):
			var f := float(i) / float(maxi(1, fronds - 1)) - 0.5
			var lean := f * 1.2
			var L := _h * (0.7 + 0.3 * _hf("ff%d" % i)) * gv
			if open < 0.5:
				# still a coil
				var ca := 1.0 - open * 2.0
				_draw_coil(ci, Vector2(f * footprint_radius * 0.4, -L * 0.6), _h * 0.1 * gv, 2.0, 1.0 - gv, _leaf_a.lerp(_leaf_b, 0.3), ca)
			else:
				_draw_frond(ci, Vector2(f * footprint_radius * 0.3, 0), lean, L, open, i)

	func _d_fiddlehead(ci: CanvasItem, gv: float) -> void:
		var stems := 2 + (_nvar % 3)
		for i in range(stems):
			var f := float(i) / float(maxi(1, stems - 1)) - 0.5
			var H := _h * (0.7 + 0.3 * _hf("fi%d" % i)) * gv
			var sx := f * footprint_radius * 0.5
			var topp := Vector2(sx + f * H * 0.3, -H)
			# stalk
			var spine := PackedVector2Array()
			for s in range(8):
				var tt := float(s) / 7.0
				spine.append(Vector2(lerpf(sx, topp.x, tt), -H * tt))
			ci.draw_polyline(spine, _stem_b, 2.6, true)
			# the coil, slightly unfurling with growth
			_draw_coil(ci, topp, _h * 0.12 * gv, 2.2, 0.15 + gv * 0.5, _leaf_a.lerp(_leaf_b, 0.3), 1.0)

	# ---------------------------------------------------------------------
	# VINE
	# ---------------------------------------------------------------------
	func _d_vine(ci: CanvasItem, gv: float) -> void:
		var H := _h * gv
		var segs := 7
		var spine := PackedVector2Array()
		for i in range(segs + 1):
			var tt := float(i) / float(segs)
			var x := sin(tt * PI * 1.7 + _hf("vx") * TAU) * footprint_radius * 0.55 * tt * _flip
			spine.append(Vector2(x, -H * tt))
		ci.draw_polyline(spine, _stem_b, 3.0, true)
		ci.draw_polyline(spine, _stem_a, 1.2, true)
		# leaves alternating up the vine
		var nl := spine.size()
		for i in range(1, nl):
			var lg := smoothstep(float(i) / float(nl) * 0.7, float(i) / float(nl) * 0.7 + 0.2, gv)
			if lg <= 0.02:
				continue
			var side := 1.0 if (i % 2 == 0) else -1.0
			var base := spine[i]
			var ll := _h * 0.11 * lg
			var tip := base + Vector2(side * ll, -ll * 0.3)
			var leaf := _leaf_poly(base, tip, ll * 0.7)
			if leaf.size() > 2:
				ci.draw_polygon(leaf, Proc.grad_fill(leaf, _leaf_a, _leaf_b))
		# a tendril curl at the tip
		if gv > 0.3:
			_draw_coil(ci, spine[spine.size() - 1], _h * 0.05 * gv, 2.0, 0.6, _stem_a, 1.0)
		# tiny flowers on a mature vine
		var fl := smoothstep(0.7, 0.95, gv)
		if fl > 0.01:
			for i in range(2 + _nvar % 2):
				var idx := nl - 1 - i * 2
				if idx < 1:
					break
				var p := spine[idx]
				ci.draw_circle(p, 3.0 * fl, _accent)
				ci.draw_circle(p, 1.2 * fl, _accent.lightened(0.4))

	# ---------------------------------------------------------------------
	# PUMPKIN (ripens green -> orange)
	# ---------------------------------------------------------------------
	func _d_pumpkin(ci: CanvasItem, gv: float) -> void:
		var r := footprint_radius * lerpf(0.2, 1.0, gv)
		var ripe := smoothstep(0.35, 0.95, gv)
		# unripe green -> ripe orange
		var body_a := Color.from_hsv(0.3, 0.55, 0.7).lerp(_petal_a, ripe)
		var body_b := Color.from_hsv(0.33, 0.6, 0.5).lerp(_petal_b, ripe)
		var cy := -r * 0.82
		# ribbed body = overlapping vertical ellipses
		var ribs := 5
		for i in range(ribs):
			var f := float(i) / float(ribs - 1) - 0.5
			var ex := f * r * 0.95
			var ew := r * (1.0 - absf(f) * 0.45)
			var seg := _offset(Proc.superellipse(ew * 0.42, r * 0.92, 2.6, 20), Vector2(ex, cy))
			var shade := 1.0 - absf(f) * 0.35
			ci.draw_polygon(seg, Proc.grad_fill(seg, body_a.lightened(0.05 * shade), body_b.darkened(0.08 * (1.0 - shade))))
		# stem
		var sw := r * 0.12
		var sy := cy - r * 0.9
		ci.draw_colored_polygon(PackedVector2Array([
			Vector2(-sw, sy + r * 0.1), Vector2(sw, sy + r * 0.1),
			Vector2(sw * 0.7, sy - r * 0.25), Vector2(-sw * 0.7, sy - r * 0.25)]),
			Color.from_hsv(0.3, 0.5, 0.45))
		# curly tendril
		if gv > 0.3:
			_draw_coil(ci, Vector2(_flip * r * 0.5, sy), r * 0.22, 2.0, 0.6, _stem_a, 1.0)
		# one broad leaf resting beside
		if gv > 0.25:
			var lb := Vector2(-_flip * r * 0.8, -r * 0.1)
			var lt := lb + Vector2(-_flip * r * 0.7, -r * 0.5)
			var leaf := _leaf_poly(lb, lt, r * 0.55)
			if leaf.size() > 2:
				ci.draw_polygon(leaf, Proc.grad_fill(leaf, _leaf_a, _leaf_b))

	# ---------------------------------------------------------------------
	# CACTUS
	# ---------------------------------------------------------------------
	func _d_cactus(ci: CanvasItem, gv: float) -> void:
		var H := _h * gv
		var w := footprint_radius * 0.75
		var body := _offset(Proc.superellipse(w, H * 0.5, 3.0, 28), Vector2(0, -H * 0.5))
		var ca := Color.from_hsv(0.33, 0.55, 0.62)
		var cb := Color.from_hsv(0.36, 0.62, 0.42)
		ci.draw_polygon(body, Proc.grad_fill(body, ca, cb))
		# an arm on one side when grown
		if gv > 0.55:
			var ag := smoothstep(0.55, 0.85, gv)
			var ay := -H * 0.55
			var arm := _offset(Proc.superellipse(w * 0.4, H * 0.22 * ag, 3.0, 20), Vector2(_flip * w * 0.9, ay))
			ci.draw_polygon(arm, Proc.grad_fill(arm, ca, cb))
			# vertical connector
			ci.draw_line(Vector2(_flip * w * 0.5, ay + 4), Vector2(_flip * w * 0.9, ay), cb, 3.0, true)
		# ribs + spines
		var ribs := 4
		for i in range(ribs):
			var rx := lerpf(-w * 0.6, w * 0.6, float(i) / float(ribs - 1))
			ci.draw_line(Vector2(rx, -4), Vector2(rx * 0.7, -H * 0.95), ca.lightened(0.15), 1.4, true)
			for s in range(3):
				var sy := -H * (0.2 + 0.3 * s)
				var sp := Color(0.95, 0.95, 0.85, 0.7)
				ci.draw_line(Vector2(rx, sy), Vector2(rx + 3, sy - 2), sp, 1.0, true)
				ci.draw_line(Vector2(rx, sy), Vector2(rx - 3, sy - 2), sp, 1.0, true)
		# crown flower at maturity
		var fl := smoothstep(0.75, 0.95, gv)
		if fl > 0.01:
			var top := Vector2(0, -H)
			_head_radial(ci, top, gv, 8, w * 0.7, w * 0.3, _petal_a, _petal_b, _petal_a.lightened(0.3), w * 0.3, 0.7, 0.95)

	# ---------------------------------------------------------------------
	# SAPLING (a very small young tree)
	# ---------------------------------------------------------------------
	func _d_sapling(ci: CanvasItem, gv: float) -> void:
		var H := _h * gv
		# slender trunk
		var trunk := _bowed_stem(Vector2(0, 0), Vector2(_flip * H * 0.08, -H * 0.62), H * 0.05, H * 0.025, _flip * H * 0.04)
		var tw := Color.from_hsv(0.08, 0.45, 0.5)
		ci.draw_polygon(trunk, Proc.grad_fill(trunk, tw.lightened(0.1), tw.darkened(0.15)))
		# a couple of branch leaves climbing
		for i in range(2):
			var lg := smoothstep(0.2 + i * 0.15, 0.45 + i * 0.15, gv)
			if lg <= 0.01:
				continue
			var by := -H * (0.35 + 0.18 * i)
			var side := 1.0 if i % 2 == 0 else -1.0
			var leaf := _leaf_poly(Vector2(_flip * by * 0.08, by), Vector2(side * H * 0.14, by - H * 0.1) * lg, H * 0.05)
			if leaf.size() > 2:
				ci.draw_polygon(leaf, Proc.grad_fill(leaf, _leaf_a, _leaf_b))
		# round young canopy
		var cr := H * 0.3
		var cy := -H * 0.72
		var cx := _flip * H * 0.08
		var canopy := _offset(Proc.blob(seedv, "sapcan", cr, 8, 0.24), Vector2(cx, cy))
		ci.draw_polygon(canopy, Proc.grad_fill(canopy, _leaf_a.lightened(0.08), _leaf_b))
		var hi := _offset(Proc.blob(seedv, "saphi", cr * 0.5, 6, 0.3), Vector2(cx - cr * 0.25, cy - cr * 0.3))
		ci.draw_polygon(hi, Proc.grad_fill(hi, _leaf_a.lightened(0.2), _leaf_a))

	# =====================================================================
	# SHARED DRAW HELPERS
	# =====================================================================

	# Stem + climbing leaves. Returns the flower-attach point at the top.
	func _draw_stem_leaves(ci: CanvasItem, gv: float, h: float, stem_w: float, nleaves: int, flip: float) -> Vector2:
		var bow := flip * h * 0.04
		var topy := -h * gv
		var topx := _bow_x(topy, h, flip)
		var base := Vector2(0, 0)
		var top := Vector2(topx, topy)
		# seed husk fading out early
		var husk := 1.0 - smoothstep(0.04, 0.2, gv)
		if husk > 0.01:
			var hk := _offset(Proc.superellipse(5.0, 7.0, 2.6, 12), Vector2(0, -6.0))
			ci.draw_polygon(hk, Proc.grad_fill(hk, Color(0.5, 0.38, 0.26, husk), Color(0.3, 0.22, 0.15, husk)))
		# stem
		var stem := _bowed_stem(base, top, stem_w * lerpf(0.4, 1.0, gv), stem_w * 0.4, bow)
		ci.draw_polygon(stem, Proc.grad_fill(stem, _stem_a, _stem_b))
		# leaves at seeded heights, unfolding with growth
		for i in range(nleaves):
			var thr := 0.14 + 0.14 * i
			var lg := smoothstep(thr, thr + 0.22, gv)
			if lg <= 0.01:
				continue
			var frac := 0.32 + 0.5 * (float(i) + 0.5) / float(maxi(1, nleaves))
			var ly := -h * gv * frac
			var lx := _bow_x(ly, h, flip)
			var side := 1.0 if (i % 2 == 0) else -1.0
			var llen := h * 0.24 * lg
			var lbase := Vector2(lx, ly)
			var ltip := lbase + Vector2(side * llen * 0.95, -llen * 0.42)
			var leaf := _leaf_poly(lbase, ltip, llen * 0.36)
			if leaf.size() > 2:
				ci.draw_polygon(leaf, Proc.grad_fill(leaf, _leaf_a, _leaf_b))
		return top

	# A radial flower head: a bud that swells, then petals bloom open + a disc.
	func _head_radial(ci: CanvasItem, top: Vector2, gv: float, petals: int, plen: float, pw: float, ca: Color, cb: Color, cc: Color, cenr: float, open_lo: float, open_hi: float) -> void:
		var bloom := smoothstep(open_lo - 0.14, open_lo + 0.02, gv)
		if bloom <= 0.02:
			_draw_bud(ci, top, gv, ca, cb)
			return
		var open := smoothstep(open_lo, open_hi, gv)
		var up := Vector2(0, -1)
		var plen2 := plen * lerpf(0.55, 1.0, open) * lerpf(0.7, 1.0, gv)
		for i in range(petals):
			var a := TAU * float(i) / float(petals) + _hf("pa") * 0.5
			var outward := Vector2(sin(a), -cos(a))
			var dir := up.lerp(outward, open)
			if dir.length() < 0.02:
				dir = up
			dir = dir.normalized()
			var plj := plen2 * (0.85 + 0.25 * _hf("pl%d" % i))
			var pbase := top + dir * plen2 * 0.12
			var ptip := top + dir * plj
			var petal := _leaf_poly(pbase, ptip, pw * lerpf(0.7, 1.0, open))
			if petal.size() > 2:
				ci.draw_polygon(petal, Proc.grad_fill(petal, ca, cb))
		# centre disc
		var cr := cenr * lerpf(0.4, 1.0, open)
		if cr > 0.4:
			var cpts := _offset(Proc.superellipse(cr, cr, 2.0, 18), top)
			ci.draw_polygon(cpts, Proc.grad_fill(cpts, cc.lightened(0.18), cc.darkened(0.22)))

	# Tulip cup — upright overlapping petals that stay fairly closed.
	func _head_tulip(ci: CanvasItem, top: Vector2, gv: float) -> void:
		var bloom := smoothstep(0.28, 0.46, gv)
		if bloom <= 0.02:
			_draw_bud(ci, top, gv, _petal_a, _petal_b)
			return
		var open := smoothstep(0.5, 0.95, gv) * 0.45
		var sz := lerpf(_h * 0.07, _h * 0.24, gv)
		var spreads := [-1.0, 1.0, 0.0]
		for s in spreads:
			var dir := Vector2(s * open, -1.0).normalized()
			var base := top
			var tip := top + dir * sz * (1.0 if s == 0.0 else 0.92)
			var p := _leaf_poly(base, tip, sz * 0.5)
			if p.size() > 2:
				var fc := _petal_a if s == 0.0 else _petal_b
				ci.draw_polygon(p, Proc.grad_fill(p, fc.lightened(0.05), _petal_b.darkened(0.08)))

	# A dandelion seed-clock: a fluffy white sphere of radiating tufts.
	func _head_seedpuff(ci: CanvasItem, top: Vector2, amt: float, r: float) -> void:
		var soft := Color(1.0, 1.0, 1.0, 0.18 * amt)
		var disc := _offset(Proc.superellipse(r, r, 2.0, 18), top)
		ci.draw_polygon(disc, Proc.grad_fill(disc, soft, Color(1, 1, 1, 0.05 * amt)))
		var n := 22
		var lc := Color(1.0, 1.0, 0.98, 0.7 * amt)
		for i in range(n):
			var a := TAU * float(i) / float(n)
			var dir := Vector2(cos(a), sin(a))
			var tip := top + dir * r
			ci.draw_line(top, tip, lc, 1.0, true)
			ci.draw_circle(tip, 1.2, Color(1, 1, 1, 0.8 * amt))

	# A simple closed flower bud (green calyx with a hint of petal colour).
	func _draw_bud(ci: CanvasItem, top: Vector2, gv: float, ca: Color, cb: Color) -> void:
		var r := 3.0 + 7.0 * gv
		var calyx := _offset(Proc.superellipse(r * 0.72, r * 1.1, 2.4, 16), top + Vector2(0, -r * 0.5))
		ci.draw_polygon(calyx, Proc.grad_fill(calyx, _leaf_a, _leaf_b.darkened(0.08)))
		var tipc := _offset(Proc.superellipse(r * 0.42, r * 0.55, 2.2, 12), top + Vector2(0, -r * 1.15))
		ci.draw_polygon(tipc, Proc.grad_fill(tipc, ca, cb))

	# A leafy mound (bush family). Returns the approx centre for decoration.
	func _draw_mound(ci: CanvasItem, gv: float, rad: float, ca: Color, cb: Color, lobes: int) -> Vector2:
		var r := rad * lerpf(0.28, 1.0, gv)
		var cy := -r * 0.9
		var p1 := _offset(Proc.blob(seedv, "m1", r, lobes, 0.22), Vector2(0, cy))
		ci.draw_polygon(p1, Proc.grad_fill(p1, cb, cb.darkened(0.18)))
		var p2 := _offset(Proc.blob(seedv, "m2", r * 0.82, lobes, 0.26), Vector2(-r * 0.12, cy - r * 0.26))
		ci.draw_polygon(p2, Proc.grad_fill(p2, ca.lightened(0.06), ca.darkened(0.04)))
		var p3 := _offset(Proc.blob(seedv, "m3", r * 0.56, lobes, 0.3), Vector2(r * 0.2, cy - r * 0.1))
		ci.draw_polygon(p3, Proc.grad_fill(p3, ca.lightened(0.16), ca))
		return Vector2(0, cy - r * 0.1)

	# Three rounded leaflets on short stems (clover trefoil).
	func _trefoil(ci: CanvasItem, center: Vector2, r: float, idx: int) -> void:
		var base_a := _hf("tf%d" % idx) * TAU
		for j in range(3):
			var a := base_a + TAU * float(j) / 3.0 - PI * 0.5
			var dir := Vector2(cos(a), sin(a))
			var lc := center + dir * r * 0.5
			var leaf := _offset(Proc.superellipse(r * 0.45, r * 0.55, 2.3, 14), lc)
			# nudge into a heart-ish leaflet
			ci.draw_polygon(leaf, Proc.grad_fill(leaf, _leaf_a, _leaf_b))
			ci.draw_line(center, lc, _leaf_b.darkened(0.1), 1.0, true)

	# One fern frond: a curving midrib with shrinking leaflets.
	func _draw_frond(ci: CanvasItem, base: Vector2, lean: float, L: float, open: float, idx: int) -> void:
		var segs := 9
		var mid := PackedVector2Array()
		for i in range(segs + 1):
			var tt := float(i) / float(segs)
			var x := base.x + sin(tt * PI * 0.5) * L * 0.35 * lean
			var y := base.y - L * tt
			mid.append(Vector2(x, y))
		ci.draw_polyline(mid, _stem_b, 2.0, true)
		var leaflets := int(6 * open) + 2
		for i in range(1, mid.size()):
			if i > leaflets:
				break
			var tt := float(i) / float(mid.size())
			var ll := L * 0.16 * (1.0 - tt) * open
			if ll < 1.0:
				continue
			for side in [-1.0, 1.0]:
				var p := mid[i]
				var tip := p + Vector2(side * ll, -ll * 0.4)
				var lf := _leaf_poly(p, tip, ll * 0.5)
				if lf.size() > 2:
					ci.draw_polygon(lf, Proc.grad_fill(lf, _leaf_a, _leaf_b))

	# A spiral curl (fiddlehead / tendril). `open` loosens the coil.
	func _draw_coil(ci: CanvasItem, center: Vector2, r0: float, turns: float, open: float, col: Color, amt: float) -> void:
		if amt <= 0.01 or r0 < 0.5:
			return
		var n := 36
		var pts := PackedVector2Array()
		var start := _hf("co") * TAU
		var loosen := lerpf(1.0, 0.45, clampf(open, 0.0, 1.0))
		for i in range(n + 1):
			var tt := float(i) / float(n)
			var ang := start + tt * turns * TAU * loosen
			var rr := r0 * (1.0 - tt * 0.9)
			pts.append(center + Vector2(cos(ang), sin(ang)) * rr)
		var c := col
		c.a = amt
		ci.draw_polyline(pts, c, 2.4, true)

	# ---------------------------------------------------------------------
	# GEOMETRY PRIMITIVES
	# ---------------------------------------------------------------------

	# A tapered, gently bowed stem polygon.
	func _bowed_stem(base: Vector2, top: Vector2, wb: float, wt: float, bow: float) -> PackedVector2Array:
		var steps := 8
		var left := PackedVector2Array()
		var right := PackedVector2Array()
		for i in range(steps + 1):
			var tt := float(i) / float(steps)
			var p := base.lerp(top, tt)
			p.x += sin(tt * PI) * bow
			var w := lerpf(wb, wt, tt) * 0.5
			left.append(Vector2(p.x - w, p.y))
			right.append(Vector2(p.x + w, p.y))
		right.reverse()
		var out := PackedVector2Array()
		for p in left:
			out.append(p)
		for p in right:
			out.append(p)
		return out

	# A smooth pointed leaf from base to tip with the given half-width.
	func _leaf_poly(base: Vector2, tip: Vector2, width: float) -> PackedVector2Array:
		var d := tip - base
		var L := d.length()
		if L < 0.01:
			return PackedVector2Array()
		var dir := d / L
		var nrm := Vector2(-dir.y, dir.x)
		var mid := base + dir * L * 0.45
		var controls := PackedVector2Array([
			base,
			mid + nrm * width,
			tip,
			mid - nrm * width,
		])
		return Proc.smooth_loop(controls, 9)

	# A curved tapered blade (grass / strap leaf): wide at base, point at tip.
	func _blade(base: Vector2, tip: Vector2, w: float, curve: float) -> PackedVector2Array:
		var d := tip - base
		var L := d.length()
		if L < 0.01:
			return PackedVector2Array()
		var u := d / L
		var nrm := Vector2(-u.y, u.x)
		var steps := 6
		var left := PackedVector2Array()
		var right := PackedVector2Array()
		for i in range(steps + 1):
			var tt := float(i) / float(steps)
			var p := base.lerp(tip, tt) + nrm * curve * sin(tt * PI) * L * 0.25
			var ww := w * (1.0 - tt) * 0.5
			left.append(p + nrm * ww)
			right.append(p - nrm * ww)
		right.reverse()
		var out := PackedVector2Array()
		for p in left:
			out.append(p)
		for p in right:
			out.append(p)
		return out

	# Offset a polygon by a vector (packed arrays are copy-on-write).
	func _offset(pts: PackedVector2Array, o: Vector2) -> PackedVector2Array:
		var out := PackedVector2Array()
		for p in pts:
			out.append(p + o)
		return out

	# The stem's horizontal bow offset at a given y (keeps leaves on the stem).
	func _bow_x(y: float, h: float, flip: float) -> float:
		var tt := clampf(-y / maxf(1.0, h), 0.0, 1.0)
		return flip * h * 0.04 * sin(tt * PI)

	# ---------------------------------------------------------------------
	# SEED HELPERS
	# ---------------------------------------------------------------------
	func _hf(key: String) -> float:
		return Proc.hashf(seedv, key)

	func _rngv(key: String, lo: float, hi: float) -> float:
		return Proc.rangef(seedv, key, lo, hi)


# A tiny canvas whose only job is to draw the plant under the swaying transform.
class _Body extends Node2D:
	var plant

	func _draw() -> void:
		if plant:
			plant._draw_body(self)
