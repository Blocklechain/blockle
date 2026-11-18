class_name ProcDecor
extends RefCounted

# WorldSpace supplies an ARRAY of neighbour descriptors; tolerate a plain count.
static func _nbcount(ctx: Dictionary) -> int:
	var v = ctx.get("neighbours", 0)
	return (v as Array).size() if v is Array else int(v)

# ProcDecor — procedurally-built WORLD SET-DRESSING / PROPS for Blockle Idle.
#
# The crafted, built things that make an island read as a *tended place* rather
# than raw wilderness: fences and signposts, glowing lanterns and flickering
# torches, barrels and hand-carts, birdhouses and woven beehives, round hay
# bales, mossy rocks and boulders, weathered obelisks and garden statues, stone
# cairns and runestones, wishing-wells, little stone bridges and stepping-stone
# paths, braziers, street-lamps, ponds, troughs and tiered fountains. All drawn
# from math (CONVENTIONS.md) — no imported images — and all feet-at-origin so a
# world builder can stand them on the island surface at y=0.
#
# FOUR MATERIAL FAMILIES (from data/decorations.json: wood/stone/light/water),
# each with its own soul:
#   WOOD  — warm planks, staves and posts with grain, knots, nails and moss; a
#           slow, barely-there creak. Growth = the thing being BUILT: posts rise,
#           rails and staves slot in, roofs raise, wheels roll on.
#   STONE — heavy settled rock with facets, lichen and carved faces; it does not
#           sway, it just sits. Growth = the stone HEAVING up out of the ground
#           and gathering moss, carvings deepening late.
#   LIGHT — lanterns, torches, candles, braziers, street-lamps, fireflies and
#           fluttering pennants. Each emitter casts a soft additive GLOW and a
#           live FLAME that flickers (sum-of-sines, no per-frame alloc). Growth =
#           the structure building then the light slowly KINDLING awake.
#   WATER — wells, ponds, troughs, fountains, birdbaths, lily-pads. A cheap GPU
#           ripple-shimmer shader fills the water surface (zero CPU per frame).
#           Growth = the basin being built then slowly FILLING with water.
#
# ANIMATION IS CHEAP (CONVENTIONS rule 5/6): the drawn silhouette lives in a
# child Node2D (`_DecorBody`) whose transform does the wood-creak / light-sway;
# flames are a small additive child animated by scale/rotation/modulate; glow is
# an add-blend child pulsed via modulate; water is a GPU shader; pennants and
# firefly motes are tiny isolated children. The immediate-mode body _draw only
# re-runs when `growth` crosses a threshold (ProcNode handles that), so a screen
# packed with props stays smooth.
#
# Module shape per CONVENTIONS: `class_name ProcDecor extends RefCounted` with
# static factories returning the ProcNode subclass `_Decor` defined below.

# ---------------------------------------------------------------------------
# Species catalogue — the public vocabulary a world builder can ask for.
# ---------------------------------------------------------------------------
const WOOD_SPECIES := [
	"fence", "signpost", "log", "stump", "barrel", "cart", "birdhouse",
	"beehive", "haybale", "acorn", "crate", "bench", "woodpile", "ladder",
]
const STONE_SPECIES := [
	"rock", "boulder", "pebbles", "stalagmite", "obelisk", "statue",
	"cairn", "runestone", "archway", "path", "bridge", "birdbath",
]
const LIGHT_SPECIES := [
	"lantern", "torch", "candle", "firefly", "flag", "brazier", "streetlamp",
]
const WATER_SPECIES := [
	"well", "pond", "trough", "fountain", "lilypad",
]

# Loose names / decoration ids → an internal species.
const _ALIASES := {
	"post": "signpost", "sign": "signpost", "pennant": "flag",
	"lamp": "streetlamp", "lamppost": "streetlamp", "streetlight": "streetlamp",
	"fountain_pool": "fountain", "wishingwell": "well", "wishing_well": "well",
	"stone": "rock", "mossyrock": "rock", "stones": "pebbles",
	"monolith": "obelisk", "menhir": "runestone", "stele": "runestone",
	"arch": "archway", "steppingstones": "path", "stonepath": "path",
	"bale": "haybale", "hay": "haybale", "cask": "barrel", "bucket": "well",
	"skep": "beehive", "hive": "beehive", "nestbox": "birdhouse",
	"handcart": "cart", "box": "crate", "seat": "bench", "firepit": "brazier",
}

# ===========================================================================
# PUBLIC FACTORIES
# ===========================================================================

# Universal entry point. `type_id` may be a decorations.json id ("fence",
# "obelisk", "well"), an internal species, or a loose alias; it is routed to the
# right family. An optional adaptation `context` (local_palette / light_dir /
# elevation / neighbours / growth, see IDLE-DESIGN §2.3a) is honoured.
static func make(world_seed: int, key: String, type_id: String = "lantern", context: Dictionary = {}) -> ProcNode:
	var sp := _resolve(type_id)
	var n := _Decor.new()
	n.seedv = _seed(world_seed, key)
	n.species = sp
	n.mat_kind = _material_of(sp)
	n.ctx = context
	if context.has("growth"):
		n.growth = clampf(float(context["growth"]), 0.0, 1.0)
	return n

# Family-scoped builders (species falls back to a seed-chosen one in-family).
static func make_wood(world_seed: int, key: String, species: String = "barrel", context: Dictionary = {}) -> ProcNode:
	return _family(world_seed, key, species, WOOD_SPECIES, "fsp", context)

static func make_stone(world_seed: int, key: String, species: String = "rock", context: Dictionary = {}) -> ProcNode:
	return _family(world_seed, key, species, STONE_SPECIES, "ssp", context)

static func make_light(world_seed: int, key: String, species: String = "lantern", context: Dictionary = {}) -> ProcNode:
	return _family(world_seed, key, species, LIGHT_SPECIES, "lsp", context)

static func make_water(world_seed: int, key: String, species: String = "well", context: Dictionary = {}) -> ProcNode:
	return _family(world_seed, key, species, WATER_SPECIES, "wsp", context)

# Build straight from a decorations.json type dict ({id, material, ...}).
static func make_decoration(world_seed: int, key: String, deco: Dictionary, context: Dictionary = {}) -> ProcNode:
	return make(world_seed, key, String(deco.get("id", "lantern")), context)

# A seed-chosen prop from any family (nice for scatter).
static func random(world_seed: int, key: String, context: Dictionary = {}) -> ProcNode:
	var s := _seed(world_seed, key)
	var all := WOOD_SPECIES + STONE_SPECIES + LIGHT_SPECIES + WATER_SPECIES
	return make(world_seed, key, all[_pick(s, "rnd", all.size())], context)

# ---------------------------------------------------------------------------
# small shared helpers
# ---------------------------------------------------------------------------
static func _family(world_seed: int, key: String, species: String, pool: Array, pk: String, context: Dictionary) -> ProcNode:
	var n := _Decor.new()
	n.seedv = _seed(world_seed, key)
	n.species = (species if species in pool else pool[_pick(n.seedv, pk, pool.size())])
	n.mat_kind = _material_of(n.species)
	n.ctx = context
	if context.has("growth"):
		n.growth = clampf(float(context["growth"]), 0.0, 1.0)
	return n

static func _seed(world_seed: int, key: String) -> int:
	return hash("%d:%s" % [world_seed, key])

static func _resolve(name: String) -> String:
	var low := name.strip_edges().to_lower()
	if low in WOOD_SPECIES or low in STONE_SPECIES or low in LIGHT_SPECIES or low in WATER_SPECIES:
		return low
	if _ALIASES.has(low):
		return _ALIASES[low]
	return "lantern"

static func _material_of(species: String) -> String:
	if species in WOOD_SPECIES: return "wood"
	if species in STONE_SPECIES: return "stone"
	if species in LIGHT_SPECIES: return "light"
	if species in WATER_SPECIES: return "water"
	return "wood"

static func _pick(seedv: int, key: String, n: int) -> int:
	return int(Proc.hashf(seedv, key) * n) % n

static func _drift(c: Color, ctx: Dictionary, amt: float) -> Color:
	# Blend a species colour `amt` toward the local realm palette so a thing
	# takes on the mood of where it is planted while staying recognisable.
	if ctx.has("local_palette"):
		var lp = ctx["local_palette"]
		if lp is Dictionary and lp.has("base") and lp["base"] is Color:
			return c.lerp(lp["base"], clampf(amt, 0.0, 1.0))
	return c

static func _light_dir_x(ctx: Dictionary) -> float:
	var ld = ctx.get("light_dir", Vector2.ZERO)
	if ld is Vector2:
		return clampf((ld as Vector2).x, -1.0, 1.0)
	return 0.0

# ===========================================================================
# tiny reusable child canvas-items (cheap, add-blend) — glow / spark / flame
# ===========================================================================

class _Glow extends Node2D:
	var col: Color = Color(1, 1, 1, 1)
	var rad: float = 40.0
	func _ready() -> void:
		var m := CanvasItemMaterial.new()
		m.blend_mode = CanvasItemMaterial.BLEND_MODE_ADD
		material = m
		z_index = -1
	func _draw() -> void:
		var n := 10
		for i in range(n):
			var ti := float(i) / float(n - 1)
			var r: float = lerp(rad, rad * 0.10, ti)
			var a: float = lerp(0.030, 0.17, ti)
			draw_circle(Vector2.ZERO, r, Color(col.r, col.g, col.b, a))

class _Spark extends Node2D:
	var col: Color = Color(1, 1, 1, 1)
	var r: float = 2.0
	func _ready() -> void:
		var m := CanvasItemMaterial.new()
		m.blend_mode = CanvasItemMaterial.BLEND_MODE_ADD
		material = m
	func _draw() -> void:
		draw_circle(Vector2.ZERO, r * 2.4, Color(col.r, col.g, col.b, 0.14))
		draw_circle(Vector2.ZERO, r, Color(col.r, col.g, col.b, 0.55))
		draw_circle(Vector2.ZERO, r * 0.45, Color(1, 1, 1, 0.9))

class _Shadow extends Node2D:
	var w: float = 30.0
	var squash: float = 0.28
	func _draw() -> void:
		var pts := Proc.superellipse(w, w * squash, 2.4, 20)
		draw_colored_polygon(pts, Color(0.05, 0.04, 0.08, 0.22))

# A live flame: layered teardrops, additive. Parent flickers it via transform +
# modulate (no reshaping), so the shape itself never re-draws per frame.
class _Flame extends Node2D:
	var h: float = 22.0
	var w: float = 9.0
	var core: Color = Color(1.0, 0.96, 0.72, 1.0)
	var mid: Color = Color(1.0, 0.62, 0.22, 1.0)
	var tip: Color = Color(1.0, 0.34, 0.12, 1.0)
	func _ready() -> void:
		var m := CanvasItemMaterial.new()
		m.blend_mode = CanvasItemMaterial.BLEND_MODE_ADD
		material = m
	func _teardrop(hh: float, ww: float) -> PackedVector2Array:
		# feet at origin, flame rising in -y, pinched at top
		var controls := PackedVector2Array([
			Vector2(0.0, 0.0),
			Vector2(ww, -hh * 0.28),
			Vector2(ww * 0.52, -hh * 0.70),
			Vector2(0.0, -hh),
			Vector2(-ww * 0.52, -hh * 0.70),
			Vector2(-ww, -hh * 0.28),
		])
		return Proc.smooth_loop(controls, 7)
	func _draw() -> void:
		draw_colored_polygon(_teardrop(h * 1.12, w * 1.15), Color(tip.r, tip.g, tip.b, 0.5))
		draw_colored_polygon(_teardrop(h, w), Color(mid.r, mid.g, mid.b, 0.9))
		draw_colored_polygon(_teardrop(h * 0.6, w * 0.5), Color(core.r, core.g, core.b, 0.95))
		draw_circle(Vector2(0, -h * 0.18), w * 0.28, Color(1, 1, 1, 0.9))

# A fluttering pennant cloth. Isolated small animate-every-frame child (one tiny
# poly), so the rest of the world does not redraw with it.
class _FlagBody extends Node2D:
	var length: float = 34.0
	var height: float = 20.0
	var col_a: Color = Color(0.85, 0.25, 0.25, 1.0)
	var col_b: Color = Color(0.70, 0.15, 0.20, 1.0)
	var ph: float = 0.0
	var tt: float = 0.0
	var grow: float = 1.0
	func _process(delta: float) -> void:
		tt += delta
		queue_redraw()
	func _draw() -> void:
		var L := length * (0.2 + 0.8 * grow)
		var segs := 14
		var top := PackedVector2Array()
		var bot := PackedVector2Array()
		for i in range(segs + 1):
			var u := float(i) / segs
			var x := u * L
			var wave := sin(u * 6.5 - tt * 4.2 + ph) * height * 0.16 * u
			var half := height * 0.5 * (1.0 - u)        # pennant tapers to a point
			top.append(Vector2(x, -height * 0.5 + (height * 0.5 - half) + wave - half))
			bot.append(Vector2(x,  height * 0.5 - (height * 0.5 - half) + wave + half))
		var poly := PackedVector2Array(top)
		for i in range(bot.size()):
			poly.append(bot[bot.size() - 1 - i])
		draw_polygon(poly, Proc.grad_fill(poly, col_a, col_b))
		# a lighter leading stripe near the pole
		var stripe := PackedVector2Array()
		for i in range(segs + 1):
			var u := float(i) / segs
			var x := u * L
			var wave := sin(u * 6.5 - tt * 4.2 + ph) * height * 0.16 * u
			var half := height * 0.5 * (1.0 - u)
			stripe.append(Vector2(x, wave - half * 0.15))
		draw_polyline(stripe, Color(1, 1, 1, 0.28), 2.0, true)

# ===========================================================================
# WATER SURFACE — a cheap GPU ripple-shimmer fill (zero CPU per frame).
# Local-coordinate based (via VERTEX) so it is camera-independent.
# ===========================================================================
const _WATER_CODE := """
shader_type canvas_item;
uniform float u_phase = 0.0;
uniform float u_speed = 1.0;
uniform float u_radius = 20.0;
uniform float u_fill = 1.0;
uniform vec4 u_shallow : source_color = vec4(0.55, 0.82, 0.86, 0.95);
uniform vec4 u_deep : source_color = vec4(0.10, 0.38, 0.56, 1.0);
uniform vec4 u_glint : source_color = vec4(1.0, 1.0, 1.0, 1.0);
varying vec2 vp;
void vertex() { vp = VERTEX; }
void fragment() {
	vec2 p = vp / max(1.0, u_radius);
	float w  = sin((p.x * 3.1 + p.y * 2.2) + TIME * u_speed + u_phase);
	float w2 = sin((p.x * 5.3 - p.y * 3.6) - TIME * u_speed * 0.8 + u_phase * 1.7);
	float d = clamp(length(p), 0.0, 1.0);
	vec4 c = mix(u_shallow, u_deep, clamp(d * 0.82 + 0.08 + w * 0.03, 0.0, 1.0));
	float g = smoothstep(0.62, 1.0, (w * 0.5 + 0.5) * (w2 * 0.5 + 0.5));
	c.rgb = mix(c.rgb, u_glint.rgb, g * 0.5);
	COLOR = vec4(c.rgb, c.a * COLOR.a * u_fill);
}
"""

# A shader-filled water polygon, used for well mouths, ponds, troughs, basins.
class _WaterTop extends Node2D:
	var poly: PackedVector2Array
	func _draw() -> void:
		if poly.size() >= 3:
			draw_colored_polygon(poly, Color(1, 1, 1, 1))

# ===========================================================================
# THE PROP
# ===========================================================================

class _Decor extends ProcNode:
	var species: String = "lantern"
	var mat_kind: String = "light"
	var ctx: Dictionary = {}

	# computed in _on_built
	var col: Dictionary = {}
	var size_mul: float = 1.0
	var tone: float = 0.0
	var lean_x: float = 0.0
	var sway_amp: float = 0.0
	var sway_rate: float = 0.9
	var flip: float = 1.0
	var footprint_radius: float = 26.0

	# light / flame
	var is_emitter: bool = false
	var glow_strength: float = 0.0
	var flame_anchor: Vector2 = Vector2.ZERO
	var flame_size: Vector2 = Vector2(9, 22)

	# water
	var has_water: bool = false
	var water_anchor: Vector2 = Vector2.ZERO
	var water_radius: float = 18.0

	# children
	var _body: Node2D
	var _shadow: _Shadow
	var _glow: _Glow
	var _flame: _Flame
	var _flag: _FlagBody
	var _water: _WaterTop
	var _motes: Array = []       # firefly / ember motes [{node, cx, cy, orb, sp, ph, a, rise}]

	func _on_built() -> void:
		_configure()
		set_grow_minutes(ProcDecor._grow_minutes(species))

		# contact shadow behind everything
		_shadow = _Shadow.new()
		_shadow.w = footprint_radius
		_shadow.squash = (0.22 if mat_kind == "stone" else 0.30)
		_shadow.position = Vector2(0, -1.5)
		add_child(_shadow)

		# soft bloom for light emitters / glowing water
		if is_emitter and glow_strength > 0.02:
			_glow = _Glow.new()
			_glow.col = col.get("glow", Color(1.0, 0.8, 0.45))
			_glow.rad = footprint_radius * 2.1
			_glow.position = flame_anchor
			_glow.modulate.a = glow_strength
			add_child(_glow)

		# the drawn silhouette lives in a child so creak/sway is a cheap transform
		_body = _DecorBody.new()
		_body.set("owner_node", self)
		_body.scale.x = flip
		add_child(_body)

		# water surface (shader) — sits inside the basin / pool
		if has_water:
			_build_water()

		# flame for fire emitters
		if species in ["lantern", "torch", "candle", "brazier", "streetlamp"]:
			_flame = _Flame.new()
			_flame.w = flame_size.x
			_flame.h = flame_size.y
			_flame.core = col.get("flame_core", Color(1.0, 0.96, 0.72))
			_flame.mid = col.get("flame_mid", Color(1.0, 0.62, 0.22))
			_flame.tip = col.get("flame_tip", Color(1.0, 0.34, 0.12))
			_flame.position = flame_anchor
			add_child(_flame)
			# a few rising embers
			var ec := 3 + ProcDecor._pick(seedv, "emb", 3)
			for i in range(ec):
				var sp := _Spark.new()
				sp.col = col.get("flame_mid", Color(1.0, 0.6, 0.2)).lerp(Color(1, 1, 1, 1), 0.3)
				sp.r = Proc.rangef(seedv, "esz%d" % i, 0.9, 1.8)
				add_child(sp)
				_motes.append({
					"node": sp,
					"cx": flame_anchor.x + Proc.rangef(seedv, "ex%d" % i, -4.0, 4.0),
					"cy": flame_anchor.y - flame_size.y * 0.4,
					"orb": Proc.rangef(seedv, "eo%d" % i, 2.0, 5.0),
					"sp": Proc.rangef(seedv, "esp%d" % i, 0.6, 1.3),
					"ph": Proc.rangef(seedv, "eph%d" % i, 0.0, TAU),
					"a": Proc.rangef(seedv, "ea%d" % i, 0.4, 0.8),
					"rise": Proc.rangef(seedv, "er%d" % i, 0.10, 0.22),
					"riseh": Proc.rangef(seedv, "erh%d" % i, 18.0, 40.0),
				})

		# firefly orbs drifting over a grass tuft
		if species == "firefly":
			var fc := 3 + ProcDecor._pick(seedv, "ffc", 4)
			for i in range(fc):
				var sp := _Spark.new()
				sp.col = col.get("glow", Color(0.8, 1.0, 0.5))
				sp.r = Proc.rangef(seedv, "ffsz%d" % i, 1.4, 2.6)
				add_child(sp)
				_motes.append({
					"node": sp,
					"cx": Proc.rangef(seedv, "ffx%d" % i, -footprint_radius, footprint_radius),
					"cy": -Proc.rangef(seedv, "ffy%d" % i, 14.0, 46.0),
					"orb": Proc.rangef(seedv, "ffo%d" % i, 8.0, 20.0),
					"sp": Proc.rangef(seedv, "ffsp%d" % i, 0.4, 1.0),
					"ph": Proc.rangef(seedv, "ffph%d" % i, 0.0, TAU),
					"a": Proc.rangef(seedv, "ffa%d" % i, 0.5, 0.95),
					"rise": 0.0, "riseh": 0.0,
				})

		# fluttering pennant cloth as an isolated child
		if species == "flag":
			_flag = _FlagBody.new()
			_flag.length = 36.0 * size_mul
			_flag.height = 20.0 * size_mul
			_flag.col_a = col.get("cloth_lt", Color(0.85, 0.25, 0.25))
			_flag.col_b = col.get("cloth_dk", Color(0.6, 0.12, 0.18))
			_flag.ph = phase
			_flag.position = Vector2(2.0 * flip, -_pole_height())
			add_child(_flag)

	func _pole_height() -> float:
		return 74.0 * size_mul

	func _build_water() -> void:
		var sh := Shader.new()
		sh.code = ProcDecor._WATER_CODE
		var mat := ShaderMaterial.new()
		mat.shader = sh
		mat.set_shader_parameter("u_phase", phase)
		mat.set_shader_parameter("u_speed", 1.0)
		mat.set_shader_parameter("u_radius", water_radius)
		mat.set_shader_parameter("u_fill", 0.0)
		mat.set_shader_parameter("u_shallow", col.get("w_shallow", Color(0.55, 0.82, 0.86, 0.95)))
		mat.set_shader_parameter("u_deep", col.get("w_deep", Color(0.10, 0.38, 0.56, 1.0)))
		mat.set_shader_parameter("u_glint", col.get("w_glint", Color(1, 1, 1, 1)))
		_water = _WaterTop.new()
		_water.material = mat
		_water.position = water_anchor
		# an ellipse surface (perspective-squashed) sized to the basin
		var e := Proc.superellipse(water_radius, water_radius * 0.52, 2.2, 28)
		_water.poly = e
		add_child(_water)

	func _configure() -> void:
		col = ProcDecor._colors(species, mat_kind, seedv, ctx)
		tone = Proc.hashf(seedv, "tone")
		glow_strength = float(col.get("glow_strength", 0.0))
		is_emitter = glow_strength > 0.02

		# size: elevation shrinks (windswept), nestling shrinks a touch
		size_mul = Proc.rangef(seedv, "sz", 0.86, 1.14)
		var elev := float(ctx.get("elevation", 0.0))
		size_mul *= (1.0 - 0.16 * clampf(elev, 0.0, 1.0))
		if ProcDecor._nbcount(ctx) > 0:
			size_mul *= 0.94

		# orientation flip per-instance so repeats don't read as copies
		flip = (1.0 if Proc.hashf(seedv, "flip") < 0.5 else -1.0)

		# lean / sway by material (wood creaks faintly, stone is still)
		lean_x = ProcDecor._light_dir_x(ctx)
		match mat_kind:
			"wood":  sway_amp = 0.010 + 0.010 * clampf(elev, 0.0, 1.0); sway_rate = 0.6
			"light": sway_amp = 0.016 + 0.014 * clampf(elev, 0.0, 1.0); sway_rate = 0.85
			"stone": sway_amp = 0.0;                                     sway_rate = 0.0
			"water": sway_amp = 0.0;                                     sway_rate = 0.0
			_:       sway_amp = 0.012;                                   sway_rate = 0.7

		# per-species rigging: anchors, flame size, water, footprint
		_rig()

	# Resolve geometry anchors + footprint for the chosen species.
	func _rig() -> void:
		var s := size_mul
		footprint_radius = 24.0 * s
		match species:
			"fence":
				footprint_radius = 46.0 * s
			"signpost":
				footprint_radius = 20.0 * s
			"log":
				footprint_radius = 40.0 * s
			"stump":
				footprint_radius = 24.0 * s
			"barrel":
				footprint_radius = 20.0 * s
			"cart":
				footprint_radius = 40.0 * s
			"birdhouse":
				footprint_radius = 16.0 * s
			"beehive":
				footprint_radius = 22.0 * s
			"haybale":
				footprint_radius = 30.0 * s
			"acorn":
				footprint_radius = 20.0 * s
			"crate":
				footprint_radius = 22.0 * s
			"bench":
				footprint_radius = 34.0 * s
			"woodpile":
				footprint_radius = 30.0 * s
			"ladder":
				footprint_radius = 20.0 * s
			"rock":
				footprint_radius = 24.0 * s
			"boulder":
				footprint_radius = 38.0 * s
			"pebbles":
				footprint_radius = 26.0 * s
			"stalagmite":
				footprint_radius = 18.0 * s
			"obelisk":
				footprint_radius = 20.0 * s
			"statue":
				footprint_radius = 26.0 * s
			"cairn":
				footprint_radius = 22.0 * s
			"runestone":
				footprint_radius = 24.0 * s
			"archway":
				footprint_radius = 44.0 * s
			"path":
				footprint_radius = 48.0 * s
			"bridge":
				footprint_radius = 70.0 * s
			"birdbath":
				footprint_radius = 24.0 * s
				has_water = true
				water_anchor = Vector2(0, -62.0 * s)
				water_radius = 20.0 * s
			"lantern":
				footprint_radius = 16.0 * s
				flame_anchor = Vector2(0, -70.0 * s)
				flame_size = Vector2(5.5 * s, 13.0 * s)
			"torch":
				footprint_radius = 14.0 * s
				flame_anchor = Vector2(0, -78.0 * s)
				flame_size = Vector2(9.0 * s, 24.0 * s)
			"candle":
				footprint_radius = 14.0 * s
				flame_anchor = Vector2(0, -34.0 * s)
				flame_size = Vector2(4.0 * s, 11.0 * s)
			"brazier":
				footprint_radius = 22.0 * s
				flame_anchor = Vector2(0, -48.0 * s)
				flame_size = Vector2(13.0 * s, 28.0 * s)
			"streetlamp":
				footprint_radius = 18.0 * s
				flame_anchor = Vector2(0, -120.0 * s)
				flame_size = Vector2(6.0 * s, 14.0 * s)
			"firefly":
				footprint_radius = 26.0 * s
			"flag":
				footprint_radius = 16.0 * s
			"well":
				footprint_radius = 34.0 * s
				has_water = true
				water_anchor = Vector2(0, -36.0 * s)
				water_radius = 24.0 * s
			"pond":
				footprint_radius = 46.0 * s
				has_water = true
				water_anchor = Vector2(0, -6.0 * s)
				water_radius = 44.0 * s
			"trough":
				footprint_radius = 32.0 * s
				has_water = true
				water_anchor = Vector2(0, -24.0 * s)
				water_radius = 28.0 * s
			"fountain":
				footprint_radius = 40.0 * s
				has_water = true
				water_anchor = Vector2(0, -24.0 * s)
				water_radius = 34.0 * s
			"lilypad":
				footprint_radius = 26.0 * s
				has_water = true
				water_anchor = Vector2(0, -3.0 * s)
				water_radius = 26.0 * s

	func _on_growth() -> void:
		var gg := g()
		if _body:
			_body.queue_redraw()
		if _shadow:
			_shadow.scale = Vector2.ONE * (0.4 + 0.6 * gg)
		if _glow:
			# light kindles late in growth
			var kindle := smoothstep(0.55, 1.0, gg)
			_glow.rad = footprint_radius * (1.4 + 0.9 * kindle)
			_glow.queue_redraw()
		if _flag:
			_flag.grow = gg
		if _water and _water.material is ShaderMaterial:
			# basin fills as it is built
			(_water.material as ShaderMaterial).set_shader_parameter("u_fill", smoothstep(0.35, 1.0, gg))

	func _animate(_delta: float) -> void:
		var gg := g()
		# wood creak / light sway of the whole body around its feet
		if _body and sway_amp > 0.0:
			var sway := sin(t * sway_rate + phase) * sway_amp
			sway += sin(t * sway_rate * 0.43 + phase * 1.6) * sway_amp * 0.35
			sway += lean_x * 0.010
			_body.rotation = sway

		# flame flicker — sum-of-sines, no allocation, drives scale/rot/alpha
		if _flame:
			var kindle := smoothstep(0.5, 1.0, gg)
			var fl := 0.82 + 0.18 * sin(t * 11.0 + phase)
			fl += 0.10 * sin(t * 23.0 + phase * 2.3)
			fl += 0.06 * sin(t * 37.0 + phase * 0.7)
			var lean := 0.10 * sin(t * 2.3 + phase) + lean_x * 0.18
			_flame.scale = Vector2(1.0 + 0.08 * (fl - 1.0), fl) * (0.4 + 0.6 * kindle)
			_flame.rotation = lean
			_flame.modulate.a = kindle
		if _glow:
			var kindle2 := smoothstep(0.5, 1.0, gg)
			var pulse := 0.74 + 0.20 * sin(t * 9.0 + phase)
			pulse += 0.06 * sin(t * 19.0 + phase * 1.7)
			_glow.modulate.a = glow_strength * pulse * kindle2
			_glow.scale = Vector2.ONE * (0.95 + 0.06 * sin(t * 1.3 + phase))

		# water speed eases with growth; shimmer handled on GPU
		if _water and _water.material is ShaderMaterial:
			(_water.material as ShaderMaterial).set_shader_parameter("u_speed", 0.6 + 0.5 * gg)

		# drifting motes (embers / fireflies)
		for m in _motes:
			if float(m["riseh"]) > 0.0:
				# rising ember
				var h := fposmod(t * float(m["rise"]) + float(m["ph"]), 1.0)
				var bx := float(m["cx"]) + sin(t * float(m["sp"]) + float(m["ph"])) * float(m["orb"])
				var by := float(m["cy"]) - float(m["riseh"]) * h
				m["node"].position = Vector2(bx, by)
				m["node"].modulate.a = sin(h * PI) * float(m["a"]) * smoothstep(0.5, 1.0, gg)
			else:
				# orbiting firefly (also blinks)
				var tt := t * float(m["sp"]) + float(m["ph"])
				m["node"].position = Vector2(
					float(m["cx"]) + cos(tt) * float(m["orb"]),
					float(m["cy"]) + sin(tt * 0.8) * float(m["orb"]) * 0.6)
				var blink := 0.5 + 0.5 * sin(tt * 1.9 + sin(tt * 0.7) * 2.0)
				m["node"].modulate.a = blink * float(m["a"]) * gg

	func _draw() -> void:
		pass   # all silhouette art is in _DecorBody; this node hosts children

# ===========================================================================
# THE SILHOUETTE — a child so the parent can creak/sway it. Dispatches to a
# per-species draw routine, every one staged by the parent's eased growth g().
# ===========================================================================
class _DecorBody extends Node2D:
	var owner_node   # _Decor

	func _draw() -> void:
		if owner_node == null:
			return
		var o = owner_node
		var gg: float = o.g()
		match o.species:
			"fence":      _fence(o, gg)
			"signpost":   _signpost(o, gg)
			"log":        _log(o, gg)
			"stump":      _stump(o, gg)
			"barrel":     _barrel(o, gg)
			"cart":       _cart(o, gg)
			"birdhouse":  _birdhouse(o, gg)
			"beehive":    _beehive(o, gg)
			"haybale":    _haybale(o, gg)
			"acorn":      _acorn(o, gg)
			"crate":      _crate(o, gg)
			"bench":      _bench(o, gg)
			"woodpile":   _woodpile(o, gg)
			"ladder":     _ladder(o, gg)
			"rock":       _rock(o, gg, 1.0)
			"boulder":    _rock(o, gg, 1.6)
			"pebbles":    _pebbles(o, gg)
			"stalagmite": _stalagmite(o, gg)
			"obelisk":    _obelisk(o, gg)
			"statue":     _statue(o, gg)
			"cairn":      _cairn(o, gg)
			"runestone":  _runestone(o, gg)
			"archway":    _archway(o, gg)
			"path":       _path(o, gg)
			"bridge":     _bridge(o, gg)
			"birdbath":   _birdbath(o, gg)
			"lantern":    _lantern(o, gg)
			"torch":      _torch(o, gg)
			"candle":     _candle(o, gg)
			"brazier":    _brazier(o, gg)
			"streetlamp": _streetlamp(o, gg)
			"firefly":    _firefly(o, gg)
			"flag":       _flagpole(o, gg)
			"well":       _well(o, gg)
			"pond":       _pond(o, gg)
			"trough":     _trough(o, gg)
			"fountain":   _fountain(o, gg)
			"lilypad":    _lilypad(o, gg)

	# ---- shared geometry helpers -----------------------------------------
	func _tp(pts: PackedVector2Array, off: Vector2) -> PackedVector2Array:
		var out := PackedVector2Array()
		for p in pts:
			out.append(p + off)
		return out

	func _rrect(cx: float, bottom_y: float, w: float, h: float, r: float = 0.0) -> PackedVector2Array:
		# rounded rect with bottom edge at bottom_y, rising to bottom_y - h
		var n := 2.6 if r > 0.0 else 8.0
		var se := Proc.superellipse(w * 0.5, h * 0.5, n, 30)
		return _tp(se, Vector2(cx, bottom_y - h * 0.5))

	func _plank(a: Vector2, b: Vector2, thick: float) -> PackedVector2Array:
		var dir := (b - a)
		if dir.length() < 0.001:
			return PackedVector2Array()
		var perp := Vector2(-dir.y, dir.x).normalized() * (thick * 0.5)
		return PackedVector2Array([a + perp, b + perp, b - perp, a - perp])

	func _fill(poly: PackedVector2Array, top: Color, bot: Color) -> void:
		if poly.size() >= 3:
			draw_polygon(poly, Proc.grad_fill(poly, top, bot))

	func _wood_grain(poly_cx: float, top_y: float, bot_y: float, n: int, col: Color, seedv: int, kk: String) -> void:
		for i in range(n):
			var u := Proc.hashf(seedv, "%s_g%d" % [kk, i])
			var x := poly_cx + (u - 0.5) * 2.0
			draw_line(Vector2(x, top_y), Vector2(x + (u - 0.5) * 3.0, bot_y),
				Color(col.r, col.g, col.b, 0.22), 1.0, true)

	func _moss(cx: float, cy: float, spread: float, n: int, mcol: Color, seedv: int, gg: float) -> void:
		var count := int(round(n * smoothstep(0.4, 1.0, gg)))
		for i in range(count):
			var ux := (Proc.hashf(seedv, "mx%d" % i) - 0.5) * 2.0
			var uy := Proc.hashf(seedv, "my%d" % i)
			var mx := cx + ux * spread
			var my := cy - uy * spread * 0.6
			var mr := spread * (0.10 + 0.10 * Proc.hashf(seedv, "mr%d" % i))
			draw_circle(Vector2(mx, my), mr, Color(mcol.r, mcol.g, mcol.b, 0.5))
			draw_circle(Vector2(mx - mr * 0.3, my - mr * 0.3), mr * 0.5, Color(mcol.r, mcol.g, mcol.b, 0.7))

	func _post(cx: float, h: float, w: float, col_lt: Color, col_dk: Color, capped: bool = true) -> void:
		var top_y := -h
		var poly := PackedVector2Array([
			Vector2(cx - w * 0.5, 0.0), Vector2(cx - w * 0.5, top_y + (w * 0.5 if capped else 0.0)),
			Vector2(cx, top_y - (w * 0.4 if capped else 0.0)),
			Vector2(cx + w * 0.5, top_y + (w * 0.5 if capped else 0.0)), Vector2(cx + w * 0.5, 0.0)])
		_fill(poly, col_lt, col_dk)
		draw_line(Vector2(cx - w * 0.18, -2), Vector2(cx - w * 0.18, top_y), Color(col_lt.r, col_lt.g, col_lt.b, 0.5), 1.5, true)
		draw_line(Vector2(cx + w * 0.3, -2), Vector2(cx + w * 0.3, top_y), Color(col_dk.r, col_dk.g, col_dk.b, 0.5), 1.0, true)

	# ===================================================================
	# WOOD
	# ===================================================================
	func _fence(o, gg: float) -> void:
		var s: float = o.size_mul
		var lt: Color = o.col["wood_lt"]
		var dk: Color = o.col["wood_dk"]
		var span := 76.0 * s
		var n := 3
		var ph := (70.0 + 24.0 * smoothstep(0.1, 0.6, gg)) * s        # posts rise first
		var railg := smoothstep(0.45, 0.95, gg)                       # rails slot in later
		# rails
		if railg > 0.01:
			for ry in [-ph * 0.75, -ph * 0.38]:
				var rail := _plank(Vector2(-span * 0.5, ry), Vector2(-span * 0.5 + span * railg, ry), 7.0 * s)
				_fill(rail, lt, dk)
		# posts
		for i in range(n):
			var cx := -span * 0.5 + span * float(i) / float(n - 1)
			_post(cx, ph, 9.0 * s, lt, dk, true)
			draw_circle(Vector2(cx, -ph * 0.75), 1.6 * s, dk)       # nail
			draw_circle(Vector2(cx, -ph * 0.38), 1.6 * s, dk)
		_moss(-span * 0.5, 0, 10 * s, 4, o.col["moss"], o.seedv, gg)

	func _signpost(o, gg: float) -> void:
		var s: float = o.size_mul
		var lt: Color = o.col["wood_lt"]
		var dk: Color = o.col["wood_dk"]
		var h := (84.0) * s * smoothstep(0.05, 0.55, gg)
		_post(0, h, 8.0 * s, lt, dk, false)
		# the board swings in as it is hung
		var bg := smoothstep(0.5, 1.0, gg)
		if bg > 0.01:
			var bw := 44.0 * s * bg
			var bh := 22.0 * s
			var by := -h * 0.78
			var board := PackedVector2Array([
				Vector2(-bw * 0.5, by - bh * 0.5), Vector2(bw * 0.5, by - bh * 0.5),
				Vector2(bw * 0.5 + 5.0 * s, by), Vector2(bw * 0.5, by + bh * 0.5),
				Vector2(-bw * 0.5, by + bh * 0.5), Vector2(-bw * 0.5 - 5.0 * s, by)])
			_fill(board, lt.lightened(0.08), dk)
			draw_polyline(board, dk, 2.0, true)
			_wood_grain(0, by - bh * 0.4, by + bh * 0.4, 4, dk, o.seedv, "sign")
			# two hang pegs
			draw_circle(Vector2(-bw * 0.3, by - bh * 0.5), 1.8 * s, dk)
			draw_circle(Vector2(bw * 0.3, by - bh * 0.5), 1.8 * s, dk)

	func _log(o, gg: float) -> void:
		var s: float = o.size_mul
		var lt: Color = o.col["wood_lt"]
		var dk: Color = o.col["wood_dk"]
		var L := 64.0 * s * (0.4 + 0.6 * gg)
		var r := 13.0 * s
		var body := PackedVector2Array([
			Vector2(-L * 0.5, 0), Vector2(-L * 0.5, -r * 1.2),
			Vector2(L * 0.5, -r * 1.2), Vector2(L * 0.5, 0)])
		_fill(body, lt, dk)
		# bark grain
		for i in range(4):
			var yy := -r * 0.3 - i * r * 0.22
			draw_line(Vector2(-L * 0.45, yy), Vector2(L * 0.45, yy), Color(dk.r, dk.g, dk.b, 0.3), 1.0, true)
		# cut end rings
		var end := _tp(Proc.superellipse(r * 0.42, r * 0.62, 2.0, 22), Vector2(L * 0.5, -r * 0.6))
		_fill(end, o.col["wood_core"], dk)
		for ri in range(3):
			var rr := r * (0.5 - ri * 0.14)
			draw_arc(Vector2(L * 0.5, -r * 0.6), rr, 0, TAU, 20, Color(dk.r, dk.g, dk.b, 0.4), 1.0, true)
		_moss(0, -r * 0.4, L * 0.4, 6, o.col["moss"], o.seedv, gg)

	func _stump(o, gg: float) -> void:
		var s: float = o.size_mul
		var lt: Color = o.col["wood_lt"]
		var dk: Color = o.col["wood_dk"]
		var r := 16.0 * s
		var h := 22.0 * s * (0.35 + 0.65 * gg)
		var body := PackedVector2Array([
			Vector2(-r, 0), Vector2(-r * 0.92, -h), Vector2(r * 0.92, -h), Vector2(r, 0)])
		_fill(body, lt, dk)
		_wood_grain(0, -2, -h, 5, dk, o.seedv, "stump")
		# top rings
		var top := _tp(Proc.superellipse(r * 0.92, r * 0.34, 2.0, 24), Vector2(0, -h))
		_fill(top, o.col["wood_core"].lightened(0.1), o.col["wood_core"])
		for ri in range(3):
			draw_arc(Vector2(0, -h), r * (0.65 - ri * 0.18), 0, TAU, 22, Color(dk.r, dk.g, dk.b, 0.4), 1.0, true)
		# a tiny sprout as it ages (life returning)
		if gg > 0.6:
			var sg := smoothstep(0.6, 1.0, gg)
			var leaf := _tp(Proc.superellipse(4.0 * s * sg, 8.0 * s * sg, 2.0, 14), Vector2(r * 0.3, -h - 8.0 * s * sg))
			_fill(leaf, o.col["moss"].lightened(0.25), o.col["moss"])
		_moss(0, -h * 0.4, r, 5, o.col["moss"], o.seedv, gg)

	func _barrel(o, gg: float) -> void:
		var s: float = o.size_mul
		var lt: Color = o.col["wood_lt"]
		var dk: Color = o.col["wood_dk"]
		var band: Color = o.col["metal"]
		var h := 40.0 * s * (0.4 + 0.6 * gg)
		var w := 24.0 * s
		# barrel staves: a bulging barrel body built from smooth outline
		var controls := PackedVector2Array([
			Vector2(-w * 0.72, 0), Vector2(-w, -h * 0.5), Vector2(-w * 0.72, -h),
			Vector2(w * 0.72, -h), Vector2(w, -h * 0.5), Vector2(w * 0.72, 0)])
		var body := Proc.smooth_loop(controls, 6)
		_fill(body, lt, dk)
		# stave seams
		var staves := int(round(5 * smoothstep(0.1, 0.8, gg)))
		for i in range(staves):
			var u := (float(i) / 5.0 - 0.5) * 2.0
			var sx := u * w * 0.9
			draw_line(Vector2(sx * 0.72, -2), Vector2(sx, -h * 0.5), Color(dk.r, dk.g, dk.b, 0.35), 1.2, true)
			draw_line(Vector2(sx, -h * 0.5), Vector2(sx * 0.72, -h + 2), Color(dk.r, dk.g, dk.b, 0.35), 1.2, true)
		# iron hoops (appear as the barrel is bound)
		if gg > 0.5:
			for hy in [-h * 0.12, -h * 0.5, -h * 0.88]:
				var hyf: float = hy
				var ww: float = w * (1.0 - abs(hyf + h * 0.5) / (h * 0.5) * 0.28)
				draw_line(Vector2(-ww, hyf), Vector2(ww, hyf), band, 3.0 * s, true)
				draw_line(Vector2(-ww, hyf - 1), Vector2(ww, hyf - 1), Color(1, 1, 1, 0.2), 1.0, true)
		# lid
		var lid := _tp(Proc.superellipse(w * 0.72, w * 0.26, 2.0, 22), Vector2(0, -h))
		_fill(lid, lt.lightened(0.1), dk)

	func _cart(o, gg: float) -> void:
		var s: float = o.size_mul
		var lt: Color = o.col["wood_lt"]
		var dk: Color = o.col["wood_dk"]
		var metal: Color = o.col["metal"]
		var wheelg := smoothstep(0.1, 0.5, gg)
		var bedg := smoothstep(0.4, 0.9, gg)
		var r := 15.0 * s * wheelg
		var bedy := -r - 8.0 * s
		# bed
		if bedg > 0.01:
			var bw := 54.0 * s * bedg
			var bed := PackedVector2Array([
				Vector2(-bw * 0.5, bedy), Vector2(bw * 0.5, bedy),
				Vector2(bw * 0.5, bedy - 10.0 * s), Vector2(-bw * 0.5, bedy - 10.0 * s)])
			_fill(bed, lt, dk)
			# plank seams
			for i in range(4):
				var px := -bw * 0.5 + bw * float(i + 1) / 5.0
				draw_line(Vector2(px, bedy), Vector2(px, bedy - 10.0 * s), Color(dk.r, dk.g, dk.b, 0.3), 1.0, true)
			# raised side rail + handle
			draw_line(Vector2(-bw * 0.5, bedy - 10.0 * s), Vector2(-bw * 0.5, bedy - 20.0 * s), dk, 3.0 * s, true)
			draw_line(Vector2(bw * 0.5, bedy - 10.0 * s), Vector2(bw * 0.5 + 18.0 * s, bedy - 14.0 * s), lt, 3.0 * s, true)
		# two wheels
		for wx in [-16.0 * s, 16.0 * s]:
			_wheel(Vector2(wx, -r), r, metal, dk, lt)
		_moss(0, 0, 14 * s, 3, o.col["moss"], o.seedv, gg)

	func _wheel(c: Vector2, r: float, rim: Color, dk: Color, lt: Color) -> void:
		draw_circle(c, r, dk)
		draw_circle(c, r * 0.9, lt.darkened(0.1))
		draw_arc(c, r * 0.9, 0, TAU, 24, rim, 2.0, true)
		draw_circle(c, r * 0.22, dk)
		for i in range(6):
			var a := TAU * i / 6.0
			draw_line(c, c + Vector2(cos(a), sin(a)) * r * 0.85, Color(dk.r, dk.g, dk.b, 0.8), 2.0, true)

	func _birdhouse(o, gg: float) -> void:
		var s: float = o.size_mul
		var lt: Color = o.col["wood_lt"]
		var dk: Color = o.col["wood_dk"]
		var h := 80.0 * s * smoothstep(0.05, 0.5, gg)
		_post(0, h, 6.0 * s, lt.darkened(0.05), dk, false)
		var boxg := smoothstep(0.45, 0.95, gg)
		if boxg > 0.01:
			var bw := 26.0 * s
			var bh := 28.0 * s * boxg
			var by := -h
			var box := PackedVector2Array([
				Vector2(-bw * 0.5, by + bh), Vector2(-bw * 0.5, by),
				Vector2(bw * 0.5, by), Vector2(bw * 0.5, by + bh)])
			_fill(box, lt, dk)
			_wood_grain(0, by, by + bh, 4, dk, o.seedv, "bh")
			# peaked roof
			var roof := PackedVector2Array([
				Vector2(-bw * 0.65, by), Vector2(0, by - 16.0 * s), Vector2(bw * 0.65, by)])
			_fill(roof, o.col["wood_core"].lightened(0.05), dk)
			draw_polyline(PackedVector2Array([Vector2(-bw * 0.65, by), Vector2(0, by - 16.0 * s), Vector2(bw * 0.65, by)]), dk, 2.0, true)
			# round hole + perch
			draw_circle(Vector2(0, by + bh * 0.42), 5.5 * s, Color(0.1, 0.08, 0.1, 0.9))
			draw_circle(Vector2(0, by + bh * 0.42), 4.0 * s, Color(0.05, 0.04, 0.06, 1.0))
			draw_line(Vector2(0, by + bh * 0.62), Vector2(0, by + bh * 0.62 + 6.0 * s), dk, 2.0, true)

	func _beehive(o, gg: float) -> void:
		var s: float = o.size_mul
		var lt: Color = o.col["straw_lt"]
		var dk: Color = o.col["straw_dk"]
		var h := 42.0 * s * (0.3 + 0.7 * gg)
		var w := 22.0 * s
		# stacked tapering woven rings (skep)
		var rings := 5
		for i in range(rings):
			var f := float(i) / float(rings)
			var rw := w * (1.0 - f * 0.55)
			var ry := -h * f
			var rh := h / float(rings) * 1.25
			var seg := PackedVector2Array([
				Vector2(-rw, ry), Vector2(rw, ry),
				Vector2(rw * 0.92, ry - rh), Vector2(-rw * 0.92, ry - rh)])
			var c: Color = lt.lerp(dk, f * 0.4)
			_fill(seg, c.lightened(0.08), c.darkened(0.12))
			draw_line(Vector2(-rw, ry), Vector2(rw, ry), Color(dk.r, dk.g, dk.b, 0.4), 1.2, true)
		# dome top
		var dome := _tp(Proc.superellipse(w * 0.45, 10.0 * s, 2.0, 20), Vector2(0, -h))
		var dpoly := PackedVector2Array()
		for p in dome:
			if p.y <= -h: dpoly.append(p)
		if dpoly.size() >= 3:
			_fill(_tp(Proc.superellipse(w * 0.45, 8.0 * s, 2.0, 16), Vector2(0, -h - 4.0 * s)), lt, dk)
		# entrance
		draw_circle(Vector2(0, -h * 0.22), 4.0 * s, Color(0.15, 0.1, 0.05, 0.9))
		# bees as it comes alive
		if gg > 0.6:
			for i in range(3):
				var ba := Proc.hashf(o.seedv, "bee%d" % i) * TAU
				var bx := cos(ba) * w * 1.3
				var byy := -h * 0.5 + sin(ba) * h * 0.3
				draw_circle(Vector2(bx, byy), 2.0 * s, Color(0.95, 0.8, 0.2, 0.9))
				draw_circle(Vector2(bx, byy), 1.0 * s, Color(0.1, 0.08, 0.05, 0.9))

	func _haybale(o, gg: float) -> void:
		var s: float = o.size_mul
		var lt: Color = o.col["straw_lt"]
		var dk: Color = o.col["straw_dk"]
		var r := 26.0 * s * (0.4 + 0.6 * gg)
		var body := _tp(Proc.superellipse(r, r * 0.86, 2.3, 30), Vector2(0, -r * 0.86))
		_fill(body, lt, dk)
		# coiled rolls (concentric arcs)
		for i in range(4):
			draw_arc(Vector2(0, -r * 0.86), r * (0.8 - i * 0.18), 0, TAU, 26, Color(dk.r, dk.g, dk.b, 0.35), 1.4, true)
		# stray straws
		for i in range(8):
			var a := Proc.hashf(o.seedv, "hs%d" % i) * TAU
			var p := Vector2(cos(a), sin(a) * 0.86) * r
			draw_line(p + Vector2(0, -r * 0.86), p + Vector2(0, -r * 0.86) + Vector2(cos(a), sin(a)) * 4.0 * s, Color(lt.r, lt.g, lt.b, 0.6), 1.0, true)

	func _acorn(o, gg: float) -> void:
		var s: float = o.size_mul
		var nut: Color = o.col["wood_lt"]
		var cap: Color = o.col["wood_dk"]
		var n := int(round(5 * smoothstep(0.1, 0.9, gg)))
		for i in range(max(1, n)):
			var ax := (Proc.hashf(o.seedv, "ac%d" % i) - 0.5) * 30.0 * s
			var ay := -Proc.hashf(o.seedv, "ay%d" % i) * 6.0 * s
			var ar := 6.0 * s * (0.8 + 0.4 * Proc.hashf(o.seedv, "ar%d" % i))
			var nutp := _tp(Proc.superellipse(ar * 0.8, ar, 2.3, 16), Vector2(ax, ay - ar))
			_fill(nutp, nut.lightened(0.1), nut.darkened(0.1))
			var capp := _tp(Proc.superellipse(ar * 0.95, ar * 0.5, 2.2, 14), Vector2(ax, ay - ar * 1.5))
			var cpoly := PackedVector2Array()
			for p in capp:
				if p.y <= ay - ar * 1.3: cpoly.append(p)
			draw_colored_polygon(_tp(Proc.superellipse(ar * 0.95, ar * 0.45, 2.0, 14), Vector2(ax, ay - ar * 1.55)), cap)
			draw_line(Vector2(ax, ay - ar * 2.0), Vector2(ax, ay - ar * 2.3), cap, 1.5, true)

	func _crate(o, gg: float) -> void:
		var s: float = o.size_mul
		var lt: Color = o.col["wood_lt"]
		var dk: Color = o.col["wood_dk"]
		var w := 36.0 * s
		var h := 34.0 * s * (0.4 + 0.6 * gg)
		var box := PackedVector2Array([
			Vector2(-w * 0.5, 0), Vector2(-w * 0.5, -h), Vector2(w * 0.5, -h), Vector2(w * 0.5, 0)])
		_fill(box, lt, dk)
		# frame planks
		draw_polyline(PackedVector2Array([Vector2(-w * 0.5, 0), Vector2(-w * 0.5, -h), Vector2(w * 0.5, -h), Vector2(w * 0.5, 0)]), dk, 3.0 * s, true)
		# X brace
		if gg > 0.5:
			draw_line(Vector2(-w * 0.45, -2), Vector2(w * 0.45, -h + 2), Color(dk.r, dk.g, dk.b, 0.7), 3.0 * s, true)
			draw_line(Vector2(w * 0.45, -2), Vector2(-w * 0.45, -h + 2), Color(dk.r, dk.g, dk.b, 0.7), 3.0 * s, true)
		# horizontal plank seam
		draw_line(Vector2(-w * 0.5, -h * 0.5), Vector2(w * 0.5, -h * 0.5), Color(dk.r, dk.g, dk.b, 0.4), 1.5, true)

	func _bench(o, gg: float) -> void:
		var s: float = o.size_mul
		var lt: Color = o.col["wood_lt"]
		var dk: Color = o.col["wood_dk"]
		var w := 56.0 * s
		var legg := smoothstep(0.1, 0.5, gg)
		var seaty := -20.0 * s * legg
		# legs
		for lx in [-w * 0.4, w * 0.4]:
			draw_line(Vector2(lx, 0), Vector2(lx, seaty), dk, 5.0 * s, true)
		# seat
		if gg > 0.4:
			var sg := smoothstep(0.4, 0.85, gg)
			var seat := PackedVector2Array([
				Vector2(-w * 0.5 * sg, seaty), Vector2(w * 0.5 * sg, seaty),
				Vector2(w * 0.5 * sg, seaty - 6.0 * s), Vector2(-w * 0.5 * sg, seaty - 6.0 * s)])
			_fill(seat, lt, dk)
			# backrest
			if gg > 0.65:
				var bg := smoothstep(0.65, 1.0, gg)
				for bx in [-w * 0.4, w * 0.4]:
					draw_line(Vector2(bx, seaty - 6.0 * s), Vector2(bx, seaty - 22.0 * s * bg), dk, 4.0 * s, true)
				draw_line(Vector2(-w * 0.45, seaty - 20.0 * s * bg), Vector2(w * 0.45, seaty - 20.0 * s * bg), lt, 4.0 * s, true)

	func _woodpile(o, gg: float) -> void:
		var s: float = o.size_mul
		var lt: Color = o.col["wood_lt"]
		var dk: Color = o.col["wood_dk"]
		var core: Color = o.col["wood_core"]
		var r := 9.0 * s
		var rows := int(round(3 * smoothstep(0.1, 0.9, gg)))
		var idx := 0
		for row in range(max(1, rows)):
			var cnt := 4 - row
			for i in range(cnt):
				var cx := (float(i) - (cnt - 1) * 0.5) * r * 2.1 + (row * r)
				var cy := -r - row * r * 1.7
				var endp := _tp(Proc.superellipse(r, r, 2.0, 18), Vector2(cx, cy))
				_fill(endp, core.lightened(0.1), core.darkened(0.1))
				draw_arc(Vector2(cx, cy), r * 0.9, 0, TAU, 16, Color(dk.r, dk.g, dk.b, 0.4), 1.0, true)
				draw_arc(Vector2(cx, cy), r * 0.5, 0, TAU, 14, Color(dk.r, dk.g, dk.b, 0.3), 1.0, true)
				idx += 1

	func _ladder(o, gg: float) -> void:
		var s: float = o.size_mul
		var lt: Color = o.col["wood_lt"]
		var dk: Color = o.col["wood_dk"]
		var h := 90.0 * s * smoothstep(0.1, 0.6, gg)
		var lean := 10.0 * s
		var lx := -8.0 * s
		var rx := 8.0 * s
		draw_line(Vector2(lx, 0), Vector2(lx - lean, -h), dk, 4.0 * s, true)
		draw_line(Vector2(rx, 0), Vector2(rx - lean, -h), dk, 4.0 * s, true)
		var rungs := int(round(5 * smoothstep(0.3, 0.9, gg)))
		for i in range(rungs):
			var u := float(i + 1) / 6.0
			var y := -h * u
			var off := -lean * u
			draw_line(Vector2(lx + off, y), Vector2(rx + off, y), lt, 3.0 * s, true)

	# ===================================================================
	# STONE
	# ===================================================================
	func _rock(o, gg: float, scale: float) -> void:
		var s: float = o.size_mul * scale
		var base: Color = o.col["stone_lt"]
		var dk: Color = o.col["stone_dk"]
		var r := 20.0 * s * (0.3 + 0.7 * gg)
		var body := Proc.blob(o.seedv, "rock", r, 8, 0.26)
		var bpoly := PackedVector2Array()
		for p in body:
			bpoly.append(Vector2(p.x, min(0.0, p.y) * 0.92 - r * 0.1))
		_fill(bpoly, base, dk)
		# a facet highlight
		var hi := Proc.blob(o.seedv, "rockhi", r * 0.6, 6, 0.3)
		var hpoly := PackedVector2Array()
		for p in hi:
			hpoly.append(Vector2(p.x - r * 0.2, min(0.0, p.y) * 0.9 - r * 0.35))
		draw_colored_polygon(hpoly, Color(base.r, base.g, base.b, 0.35))
		# crack lines
		draw_line(Vector2(-r * 0.3, -r * 0.2), Vector2(r * 0.1, -r * 0.7), Color(dk.r, dk.g, dk.b, 0.5), 1.2, true)
		_moss(0, -r * 0.3, r * 0.9, int(8 * scale), o.col["moss"], o.seedv, gg)

	func _pebbles(o, gg: float) -> void:
		var s: float = o.size_mul
		var base: Color = o.col["stone_lt"]
		var dk: Color = o.col["stone_dk"]
		var n := int(round(6 * smoothstep(0.1, 0.9, gg)))
		for i in range(max(1, n)):
			var px := (Proc.hashf(o.seedv, "pb%d" % i) - 0.5) * 44.0 * s
			var pr := 5.0 * s * (0.8 + 0.7 * Proc.hashf(o.seedv, "pr%d" % i))
			var py := -pr * 0.6 - Proc.hashf(o.seedv, "py%d" % i) * 4.0 * s
			var peb := _tp(Proc.superellipse(pr, pr * 0.7, 2.4, 16), Vector2(px, py))
			_fill(peb, base.lightened(0.05 * Proc.hashf(o.seedv, "pl%d" % i)), dk)
			draw_circle(Vector2(px - pr * 0.3, py - pr * 0.3), pr * 0.3, Color(1, 1, 1, 0.25))

	func _stalagmite(o, gg: float) -> void:
		var s: float = o.size_mul
		var base: Color = o.col["stone_lt"]
		var dk: Color = o.col["stone_dk"]
		var h := 50.0 * s * (0.3 + 0.7 * gg)
		var w := 16.0 * s
		var controls := PackedVector2Array([
			Vector2(-w, 0), Vector2(-w * 0.5, -h * 0.5), Vector2(-w * 0.14, -h * 0.85),
			Vector2(0, -h), Vector2(w * 0.14, -h * 0.85), Vector2(w * 0.5, -h * 0.5), Vector2(w, 0)])
		var body := Proc.smooth_loop(controls, 6)
		_fill(body, base, dk)
		draw_line(Vector2(-w * 0.2, -2), Vector2(0, -h), Color(base.r, base.g, base.b, 0.5), 1.4, true)
		_moss(0, -h * 0.2, w, 3, o.col["moss"], o.seedv, gg)

	func _obelisk(o, gg: float) -> void:
		var s: float = o.size_mul
		var base: Color = o.col["stone_lt"]
		var dk: Color = o.col["stone_dk"]
		var h := 100.0 * s * (0.2 + 0.8 * smoothstep(0.05, 0.7, gg))
		var wb := 15.0 * s
		var wt := 7.0 * s
		var body := PackedVector2Array([
			Vector2(-wb, 0), Vector2(-wt, -h * 0.82), Vector2(0, -h),
			Vector2(wt, -h * 0.82), Vector2(wb, 0)])
		_fill(body, base, dk)
		# lit face vs shadow face
		draw_colored_polygon(PackedVector2Array([
			Vector2(0, 0), Vector2(0, -h), Vector2(wt, -h * 0.82), Vector2(wb, 0)]),
			Color(dk.r, dk.g, dk.b, 0.35))
		# carved glyphs deepen late
		if gg > 0.6:
			var cg := smoothstep(0.6, 1.0, gg)
			for i in range(3):
				var y := -h * (0.3 + i * 0.18)
				draw_line(Vector2(-wb * 0.4, y), Vector2(wb * 0.4, y), Color(dk.r, dk.g, dk.b, 0.6 * cg), 1.5, true)
				draw_circle(Vector2(0, y - 4.0 * s), 2.0 * s * cg, Color(dk.r, dk.g, dk.b, 0.6 * cg))
		_moss(0, 0, wb, 4, o.col["moss"], o.seedv, gg)

	func _statue(o, gg: float) -> void:
		var s: float = o.size_mul
		var base: Color = o.col["stone_lt"]
		var dk: Color = o.col["stone_dk"]
		# pedestal
		var pw := 24.0 * s
		var ph := 16.0 * s * smoothstep(0.05, 0.4, gg)
		var ped := PackedVector2Array([Vector2(-pw * 0.5, 0), Vector2(-pw * 0.5, -ph), Vector2(pw * 0.5, -ph), Vector2(pw * 0.5, 0)])
		_fill(ped, base, dk)
		draw_line(Vector2(-pw * 0.5, -ph), Vector2(pw * 0.5, -ph), Color(base.r, base.g, base.b, 0.6), 1.5, true)
		# figure (a serene robed silhouette) rises & carves in
		var fg := smoothstep(0.4, 1.0, gg)
		if fg > 0.01:
			var fh := 56.0 * s * fg
			var fy := -ph
			# robe body
			var robe := Proc.smooth_loop(PackedVector2Array([
				Vector2(-12.0 * s, fy), Vector2(-10.0 * s, fy - fh * 0.55),
				Vector2(-6.0 * s, fy - fh * 0.82), Vector2(0, fy - fh),
				Vector2(6.0 * s, fy - fh * 0.82), Vector2(10.0 * s, fy - fh * 0.55),
				Vector2(12.0 * s, fy)]), 6)
			_fill(robe, base.lightened(0.05), dk)
			# head
			draw_circle(Vector2(0, fy - fh - 7.0 * s), 8.0 * s, base.lightened(0.08))
			draw_circle(Vector2(2.0 * s, fy - fh - 6.0 * s), 3.0 * s, Color(dk.r, dk.g, dk.b, 0.3))
			# robe fold lines
			draw_line(Vector2(0, fy - fh * 0.7), Vector2(-3.0 * s, fy), Color(dk.r, dk.g, dk.b, 0.4), 1.2, true)
			draw_line(Vector2(3.0 * s, fy - fh * 0.55), Vector2(5.0 * s, fy), Color(dk.r, dk.g, dk.b, 0.4), 1.2, true)
		_moss(0, 0, pw * 0.6, 6, o.col["moss"], o.seedv, gg)

	func _cairn(o, gg: float) -> void:
		var s: float = o.size_mul
		var base: Color = o.col["stone_lt"]
		var dk: Color = o.col["stone_dk"]
		var n := int(round(5 * smoothstep(0.1, 0.9, gg)))
		var y := 0.0
		for i in range(max(1, n)):
			var f := float(i) / 5.0
			var rw := (16.0 - i * 2.2) * s
			var rh := (9.0 - i * 0.6) * s
			var off := (Proc.hashf(o.seedv, "cn%d" % i) - 0.5) * 5.0 * s
			var stone := _tp(Proc.superellipse(rw, rh, 2.5, 18), Vector2(off, y - rh))
			_fill(stone, base.lightened(0.04 * i), dk)
			draw_arc(Vector2(off, y - rh), rw * 0.6, PI, TAU, 12, Color(1, 1, 1, 0.18), 1.0, true)
			y -= rh * 2.0 - 1.0
		_moss(0, 0, 14 * s, 4, o.col["moss"], o.seedv, gg)

	func _runestone(o, gg: float) -> void:
		var s: float = o.size_mul
		var base: Color = o.col["stone_lt"]
		var dk: Color = o.col["stone_dk"]
		var h := 72.0 * s * (0.25 + 0.75 * smoothstep(0.05, 0.6, gg))
		var w := 22.0 * s
		var controls := PackedVector2Array([
			Vector2(-w, 0), Vector2(-w * 0.9, -h * 0.5), Vector2(-w * 0.6, -h * 0.9),
			Vector2(0, -h), Vector2(w * 0.55, -h * 0.88), Vector2(w * 0.9, -h * 0.45), Vector2(w, 0)])
		var body := Proc.smooth_loop(controls, 6)
		_fill(body, base, dk)
		# glowing carved runes late (ancient magic)
		if gg > 0.55:
			var cg := smoothstep(0.55, 1.0, gg)
			var rc: Color = o.col.get("rune", Color(0.5, 0.85, 0.95))
			rc.a = 0.7 * cg
			for i in range(4):
				var y := -h * (0.25 + i * 0.16)
				var rw := w * 0.4 * (0.7 + 0.3 * Proc.hashf(o.seedv, "rn%d" % i))
				draw_line(Vector2(-rw, y), Vector2(rw, y - 3.0 * s), rc, 1.6, true)
				draw_line(Vector2(0, y - 4.0 * s), Vector2(rw * 0.5, y + 3.0 * s), rc, 1.4, true)
		_moss(0, 0, w, 5, o.col["moss"], o.seedv, gg)

	func _archway(o, gg: float) -> void:
		var s: float = o.size_mul
		var base: Color = o.col["stone_lt"]
		var dk: Color = o.col["stone_dk"]
		var span := 54.0 * s
		var ph := 70.0 * s * smoothstep(0.05, 0.5, gg)
		var pw := 14.0 * s
		# two piers
		for px in [-span * 0.5, span * 0.5]:
			var pier := PackedVector2Array([
				Vector2(px - pw * 0.5, 0), Vector2(px - pw * 0.5, -ph),
				Vector2(px + pw * 0.5, -ph), Vector2(px + pw * 0.5, 0)])
			_fill(pier, base, dk)
			# block courses
			for cy in range(4):
				var y := -ph * float(cy + 1) / 5.0
				draw_line(Vector2(px - pw * 0.5, y), Vector2(px + pw * 0.5, y), Color(dk.r, dk.g, dk.b, 0.35), 1.0, true)
		# the arch keystone band
		var arcg := smoothstep(0.5, 1.0, gg)
		if arcg > 0.01:
			var outer := PackedVector2Array()
			var inner := PackedVector2Array()
			var steps := 20
			var cr := span * 0.5 + pw * 0.3
			for i in range(steps + 1):
				var a := PI * float(i) / steps
				outer.append(Vector2(cos(a) * cr, -ph + (-sin(a) * cr * 0.7) * arcg))
			for i in range(steps + 1):
				var a := PI * float(steps - i) / steps
				inner.append(Vector2(cos(a) * (cr - pw), -ph + (-sin(a) * (cr - pw) * 0.7) * arcg))
			var band := PackedVector2Array(outer)
			for p in inner:
				band.append(p)
			_fill(band, base.lightened(0.05), dk)
			draw_polyline(outer, Color(dk.r, dk.g, dk.b, 0.4), 1.2, true)
		_moss(-span * 0.5, 0, pw, 4, o.col["moss"], o.seedv, gg)

	func _path(o, gg: float) -> void:
		var s: float = o.size_mul
		var base: Color = o.col["stone_lt"]
		var dk: Color = o.col["stone_dk"]
		# a run of flat stepping stones receding up-screen (slight perspective)
		var n := int(round(6 * smoothstep(0.1, 0.95, gg)))
		for i in range(max(1, n)):
			var f := float(i) / 6.0
			var cx := (Proc.hashf(o.seedv, "pt%d" % i) - 0.5) * 20.0 * s + sin(i * 1.3) * 6.0 * s
			var cy := -i * 11.0 * s
			var rw := (18.0 - i * 1.6) * s
			var stone := _tp(Proc.superellipse(rw, rw * 0.42, 2.6, 18), Vector2(cx, cy))
			_fill(stone, base.lerp(dk, f * 0.25).lightened(0.04), dk)
			draw_arc(Vector2(cx, cy), rw * 0.5, PI, TAU, 12, Color(1, 1, 1, 0.14), 1.0, true)
			# grass in the cracks
			if Proc.hashf(o.seedv, "pg%d" % i) > 0.5:
				draw_line(Vector2(cx + rw * 0.8, cy), Vector2(cx + rw * 0.8, cy - 5.0 * s), Color(o.col["moss"].r, o.col["moss"].g, o.col["moss"].b, 0.7), 1.2, true)

	func _bridge(o, gg: float) -> void:
		var s: float = o.size_mul
		var stone: Color = o.col["stone_lt"]
		var dk: Color = o.col["stone_dk"]
		var wood_lt: Color = o.col["wood_lt"]
		var wood_dk: Color = o.col["wood_dk"]
		var span := 120.0 * s
		var rise := 34.0 * s
		var deckg := smoothstep(0.1, 0.6, gg)
		# arched stone understructure
		var arc_outer := PackedVector2Array()
		var arc_inner := PackedVector2Array()
		var steps := 24
		for i in range(steps + 1):
			var u := float(i) / steps
			var x := lerpf(-span * 0.5, span * 0.5, u)
			var y := -rise * sin(u * PI) * deckg
			arc_outer.append(Vector2(x, y))
		for i in range(steps + 1):
			var u := float(steps - i) / steps
			var x := lerpf(-span * 0.5, span * 0.5, u)
			var y := -rise * sin(u * PI) * deckg + 8.0 * s
			arc_inner.append(Vector2(x, y))
		var deck := PackedVector2Array(arc_outer)
		for p in arc_inner:
			deck.append(p)
		_fill(deck, stone.lightened(0.05), dk)
		# plank seams across the deck
		for i in range(10):
			var u := float(i) / 10.0
			var x := lerpf(-span * 0.45, span * 0.45, u)
			var y := -rise * sin(u * PI) * deckg
			draw_line(Vector2(x, y), Vector2(x, y + 7.0 * s), Color(wood_dk.r, wood_dk.g, wood_dk.b, 0.3), 1.0, true)
		# support arch opening beneath (two stone legs + arch)
		if gg > 0.3:
			var leg_h := 24.0 * s
			for lx in [-span * 0.42, span * 0.42]:
				draw_line(Vector2(lx, 8.0 * s), Vector2(lx, 8.0 * s + leg_h), dk, 6.0 * s, true)
		# railings rise last
		var railg := smoothstep(0.55, 1.0, gg)
		if railg > 0.01:
			var rail := PackedVector2Array()
			for i in range(steps + 1):
				var u := float(i) / steps
				var x := lerpf(-span * 0.5, span * 0.5, u)
				var y := -rise * sin(u * PI) * deckg - 18.0 * s * railg
				rail.append(Vector2(x, y))
			draw_polyline(rail, wood_lt, 3.0 * s, true)
			# balusters
			for i in range(9):
				var u := float(i) / 8.0
				var x := lerpf(-span * 0.46, span * 0.46, u)
				var y := -rise * sin(u * PI) * deckg
				draw_line(Vector2(x, y), Vector2(x, y - 18.0 * s * railg), wood_dk, 2.0 * s, true)
		_moss(-span * 0.4, 8.0 * s, 16 * s, 5, o.col["moss"], o.seedv, gg)

	func _birdbath(o, gg: float) -> void:
		var s: float = o.size_mul
		var base: Color = o.col["stone_lt"]
		var dk: Color = o.col["stone_dk"]
		var ph := 58.0 * s * smoothstep(0.05, 0.5, gg)
		# pedestal (tapered)
		var ped := PackedVector2Array([
			Vector2(-10.0 * s, 0), Vector2(-5.0 * s, -ph), Vector2(5.0 * s, -ph), Vector2(10.0 * s, 0)])
		_fill(ped, base, dk)
		# foot
		draw_colored_polygon(_tp(Proc.superellipse(14.0 * s, 5.0 * s, 2.4, 16), Vector2(0, -4.0 * s)), dk)
		# basin bowl
		if gg > 0.4:
			var bg := smoothstep(0.4, 0.85, gg)
			var bw := 22.0 * s * bg
			var bowl := PackedVector2Array([
				Vector2(-bw, -ph), Vector2(-bw * 0.6, -ph + 8.0 * s),
				Vector2(bw * 0.6, -ph + 8.0 * s), Vector2(bw, -ph)])
			_fill(bowl, base.lightened(0.05), dk)
			draw_colored_polygon(_tp(Proc.superellipse(bw, 5.0 * s, 2.2, 18), Vector2(0, -ph)), dk.lightened(0.1))
		_moss(0, 0, 12 * s, 4, o.col["moss"], o.seedv, gg)

	# ===================================================================
	# LIGHT
	# ===================================================================
	func _lantern(o, gg: float) -> void:
		var s: float = o.size_mul
		var wood_lt: Color = o.col["wood_lt"]
		var wood_dk: Color = o.col["wood_dk"]
		var paper: Color = o.col["paper"]
		var h := 72.0 * s * smoothstep(0.05, 0.5, gg)
		_post(0, h, 6.0 * s, wood_lt.darkened(0.1), wood_dk, false)
		# cross-arm
		draw_line(Vector2(0, -h), Vector2(14.0 * s, -h), wood_dk, 3.0 * s, true)
		# hanging paper lantern — glows from within as it kindles
		var lg := smoothstep(0.4, 0.95, gg)
		if lg > 0.01:
			var lw := 13.0 * s * lg
			var lh := 20.0 * s * lg
			var ly := -h + lh * 0.7
			var lamp := _tp(Proc.superellipse(lw, lh * 0.5, 2.4, 24), Vector2(14.0 * s, ly))
			var kindle := smoothstep(0.55, 1.0, gg)
			var pc := paper.lerp(Color(1.0, 0.92, 0.6), kindle * 0.6)
			_fill(lamp, pc.lightened(0.15), pc.darkened(0.1))
			# ribs
			draw_line(Vector2(14.0 * s - lw, ly), Vector2(14.0 * s + lw, ly), Color(wood_dk.r, wood_dk.g, wood_dk.b, 0.4), 1.0, true)
			draw_line(Vector2(14.0 * s, ly - lh * 0.5), Vector2(14.0 * s, ly + lh * 0.5), Color(wood_dk.r, wood_dk.g, wood_dk.b, 0.3), 1.0, true)
			# top + bottom caps
			draw_line(Vector2(14.0 * s - lw * 0.5, ly - lh * 0.5), Vector2(14.0 * s + lw * 0.5, ly - lh * 0.5), wood_dk, 2.0 * s, true)

	func _torch(o, gg: float) -> void:
		var s: float = o.size_mul
		var wood_lt: Color = o.col["wood_lt"]
		var wood_dk: Color = o.col["wood_dk"]
		var h := 78.0 * s * smoothstep(0.05, 0.55, gg)
		# stake
		var stake := PackedVector2Array([
			Vector2(-3.0 * s, 0), Vector2(-3.5 * s, -h * 0.85), Vector2(0, -h),
			Vector2(3.5 * s, -h * 0.85), Vector2(3.0 * s, 0)])
		_fill(stake, wood_lt, wood_dk)
		# wrapped head (rag-bound)
		if gg > 0.3:
			var head := _tp(Proc.superellipse(7.0 * s, 10.0 * s, 2.3, 18), Vector2(0, -h - 2.0 * s))
			_fill(head, o.col["rag"].lightened(0.1), o.col["rag"].darkened(0.15))
			for i in range(3):
				var y := -h - i * 5.0 * s
				draw_line(Vector2(-6.0 * s, y), Vector2(6.0 * s, y - 1.0 * s), Color(wood_dk.r, wood_dk.g, wood_dk.b, 0.5), 1.4, true)

	func _candle(o, gg: float) -> void:
		var s: float = o.size_mul
		var glass: Color = o.col["glass"]
		var wax: Color = o.col["wax"]
		# jar
		var jw := 14.0 * s
		var jh := 30.0 * s * smoothstep(0.05, 0.6, gg)
		var jar := PackedVector2Array([
			Vector2(-jw, 0), Vector2(-jw, -jh), Vector2(-jw * 0.8, -jh - 3.0 * s),
			Vector2(jw * 0.8, -jh - 3.0 * s), Vector2(jw, -jh), Vector2(jw, 0)])
		_fill(jar, Color(glass.r, glass.g, glass.b, 0.35), Color(glass.r, glass.g, glass.b, 0.55))
		draw_polyline(jar, Color(glass.r, glass.g, glass.b, 0.6), 1.5, true)
		# glass highlight
		draw_line(Vector2(-jw * 0.6, -jh * 0.2), Vector2(-jw * 0.6, -jh * 0.8), Color(1, 1, 1, 0.3), 2.0, true)
		# candle wax inside
		if gg > 0.4:
			var cw := jw * 0.6
			var ch := jh * 0.55 * smoothstep(0.4, 0.9, gg)
			var candle := PackedVector2Array([
				Vector2(-cw, -3.0 * s), Vector2(-cw, -ch), Vector2(cw, -ch), Vector2(cw, -3.0 * s)])
			_fill(candle, wax.lightened(0.1), wax.darkened(0.1))
			# wick
			draw_line(Vector2(0, -ch), Vector2(0, -ch - 4.0 * s), Color(0.2, 0.15, 0.1), 1.5, true)

	func _brazier(o, gg: float) -> void:
		var s: float = o.size_mul
		var metal: Color = o.col["metal"]
		var h := 40.0 * s * smoothstep(0.05, 0.5, gg)
		# three legs
		for lx in [-12.0 * s, 0.0, 12.0 * s]:
			draw_line(Vector2(lx * 0.4, 0), Vector2(lx, -h * 0.7), metal.darkened(0.2), 3.0 * s, true)
		# bowl
		if gg > 0.35:
			var bw := 22.0 * s * smoothstep(0.35, 0.8, gg)
			var bowl := PackedVector2Array([
				Vector2(-bw, -h), Vector2(-bw * 0.6, -h * 0.6),
				Vector2(bw * 0.6, -h * 0.6), Vector2(bw, -h)])
			_fill(bowl, metal.lightened(0.1), metal.darkened(0.2))
			draw_colored_polygon(_tp(Proc.superellipse(bw, 5.0 * s, 2.2, 18), Vector2(0, -h)), metal.darkened(0.1))
			# glowing coals
			var kindle := smoothstep(0.5, 1.0, gg)
			for i in range(4):
				var cx := (Proc.hashf(o.seedv, "co%d" % i) - 0.5) * bw * 1.2
				draw_circle(Vector2(cx, -h), 3.0 * s, Color(1.0, 0.5, 0.15, 0.8 * kindle))

	func _streetlamp(o, gg: float) -> void:
		var s: float = o.size_mul
		var metal: Color = o.col["metal"]
		var glass: Color = o.col["glass"]
		var h := 122.0 * s * smoothstep(0.05, 0.55, gg)
		# ornate iron post
		var post := PackedVector2Array([
			Vector2(-4.0 * s, 0), Vector2(-3.0 * s, -h), Vector2(3.0 * s, -h), Vector2(4.0 * s, 0)])
		_fill(post, metal.lightened(0.1), metal.darkened(0.2))
		# base flare
		draw_colored_polygon(_tp(Proc.superellipse(9.0 * s, 4.0 * s, 2.4, 14), Vector2(0, -3.0 * s)), metal.darkened(0.1))
		# lamp head (glass box with a peaked cap)
		var lg := smoothstep(0.45, 0.95, gg)
		if lg > 0.01:
			var lw := 13.0 * s
			var lh := 20.0 * s
			var ly := -h
			var kindle := smoothstep(0.55, 1.0, gg)
			var box := PackedVector2Array([
				Vector2(-lw, ly + lh), Vector2(-lw, ly), Vector2(lw, ly), Vector2(lw, ly + lh)])
			var gc := glass.lerp(Color(1.0, 0.92, 0.6), kindle * 0.6)
			_fill(box, Color(gc.r, gc.g, gc.b, 0.75), Color(gc.r, gc.g, gc.b, 0.5))
			draw_polyline(box, metal.darkened(0.2), 2.0 * s, true)
			# cap
			var cap := PackedVector2Array([Vector2(-lw * 1.2, ly), Vector2(0, ly - 12.0 * s), Vector2(lw * 1.2, ly)])
			_fill(cap, metal.lightened(0.1), metal.darkened(0.2))

	func _firefly(o, gg: float) -> void:
		var s: float = o.size_mul
		var moss: Color = o.col["moss"]
		# a small tuft of grass over which the fireflies drift (motes are children)
		var blades := int(round(7 * smoothstep(0.1, 0.9, gg)))
		for i in range(max(1, blades)):
			var bx := (Proc.hashf(o.seedv, "fg%d" % i) - 0.5) * 36.0 * s
			var bh := (10.0 + 10.0 * Proc.hashf(o.seedv, "fh%d" % i)) * s * gg
			if bh < 3.0 * s:
				continue                 # too short to form a valid blade yet
			var curl := (Proc.hashf(o.seedv, "fc%d" % i) - 0.5) * 8.0 * s
			var bw := 1.8 * s
			# a simple, non-self-intersecting tapered blade: base-L, mid-L, tip,
			# mid-R, base-R (a convex sliver that always triangulates cleanly).
			var blade := PackedVector2Array([
				Vector2(bx - bw, 0),
				Vector2(bx + curl * 0.5 - bw * 0.4, -bh * 0.55),
				Vector2(bx + curl, -bh),
				Vector2(bx + curl * 0.5 + bw * 0.4, -bh * 0.55),
				Vector2(bx + bw, 0)])
			_fill(blade, moss.lightened(0.2), moss.darkened(0.1))

	func _flagpole(o, gg: float) -> void:
		var s: float = o.size_mul
		var wood_lt: Color = o.col["wood_lt"]
		var wood_dk: Color = o.col["wood_dk"]
		var h := 74.0 * s * smoothstep(0.05, 0.55, gg)
		# pole
		var pole := PackedVector2Array([
			Vector2(-2.5 * s, 0), Vector2(-2.0 * s, -h), Vector2(2.0 * s, -h), Vector2(2.5 * s, 0)])
		_fill(pole, wood_lt, wood_dk)
		# finial ball
		draw_circle(Vector2(0, -h - 3.0 * s), 4.0 * s, o.col["metal"])
		# the cloth itself is the animated _FlagBody child

	# ===================================================================
	# WATER (the still surface is a shader child; here we draw the vessel)
	# ===================================================================
	func _well(o, gg: float) -> void:
		var s: float = o.size_mul
		var stone: Color = o.col["stone_lt"]
		var dk: Color = o.col["stone_dk"]
		var wood_lt: Color = o.col["wood_lt"]
		var wood_dk: Color = o.col["wood_dk"]
		var rimg := smoothstep(0.05, 0.5, gg)
		var rw := 28.0 * s
		var rh := 34.0 * s * rimg
		# the stone ring wall
		var wall := PackedVector2Array([
			Vector2(-rw, -4.0 * s), Vector2(-rw, -rh), Vector2(rw, -rh), Vector2(rw, -4.0 * s)])
		_fill(wall, stone, dk)
		# block courses
		for cy in range(3):
			var y := -4.0 * s - rh * float(cy + 1) / 4.0
			draw_line(Vector2(-rw, y), Vector2(rw, y), Color(dk.r, dk.g, dk.b, 0.35), 1.0, true)
			for bx in range(3):
				var x := -rw + rw * 2.0 * float(bx) / 3.0 + (rw / 3.0 if cy % 2 else 0.0)
				draw_line(Vector2(x, y), Vector2(x, y + rh / 4.0), Color(dk.r, dk.g, dk.b, 0.3), 1.0, true)
		# the stone rim (ellipse lip) — water surface child sits just under it
		draw_colored_polygon(_tp(Proc.superellipse(rw, rw * 0.5, 2.2, 24), Vector2(0, -rh)), stone.lightened(0.08))
		draw_colored_polygon(_tp(Proc.superellipse(rw * 0.78, rw * 0.38, 2.2, 24), Vector2(0, -rh)), Color(0.08, 0.1, 0.14, 0.8))
		# wooden roof posts + peaked shingle roof raise last
		var roofg := smoothstep(0.5, 1.0, gg)
		if roofg > 0.01:
			var post_h := 46.0 * s * roofg
			for px in [-rw * 0.85, rw * 0.85]:
				draw_line(Vector2(px, -rh), Vector2(px, -rh - post_h), wood_dk, 4.0 * s, true)
			var ry := -rh - post_h
			var roof := PackedVector2Array([
				Vector2(-rw * 1.25, ry), Vector2(0, ry - 26.0 * s), Vector2(rw * 1.25, ry),
				Vector2(rw * 1.05, ry + 4.0 * s), Vector2(-rw * 1.05, ry + 4.0 * s)])
			_fill(roof, wood_lt.lightened(0.05), wood_dk)
			draw_polyline(PackedVector2Array([Vector2(-rw * 1.25, ry), Vector2(0, ry - 26.0 * s), Vector2(rw * 1.25, ry)]), wood_dk, 2.0 * s, true)
			# shingle lines
			for i in range(3):
				var f := float(i + 1) / 4.0
				draw_line(Vector2(-rw * 1.25 * (1.0 - f), ry - 26.0 * s * f), Vector2(0, ry - 26.0 * s * (f + 0.1)), Color(wood_dk.r, wood_dk.g, wood_dk.b, 0.3), 1.0, true)
			# crank + rope + bucket
			draw_line(Vector2(-rw * 0.85, ry + post_h * 0.4), Vector2(rw * 0.85, ry + post_h * 0.4), wood_dk, 3.0 * s, true)
			draw_line(Vector2(0, ry + post_h * 0.4), Vector2(0, -rh - 2.0 * s), Color(0.3, 0.25, 0.2), 1.2, true)
			var bkt := _rrect(0, -rh - 2.0 * s, 11.0 * s, 10.0 * s, 1.0)
			_fill(bkt, wood_lt, wood_dk)

	func _pond(o, gg: float) -> void:
		var s: float = o.size_mul
		var moss: Color = o.col["moss"]
		var dk: Color = o.col["stone_dk"]
		# muddy/grassy bank ring around the water (the water is the shader child)
		var rw := 44.0 * s * (0.4 + 0.6 * gg)
		var bank := _tp(Proc.superellipse(rw + 6.0 * s, (rw + 6.0 * s) * 0.55, 2.2, 28), Vector2(0, -6.0 * s))
		_fill(bank, o.col["soil"].lightened(0.05), o.col["soil"].darkened(0.15))
		# reeds + a rock on the near bank (edge detail)
		if gg > 0.4:
			for i in range(5):
				var ra := Proc.hashf(o.seedv, "rd%d" % i) * PI - PI * 0.5
				var rx := cos(ra) * rw * 0.9
				var ry := -6.0 * s + sin(ra) * rw * 0.45
				var rh := (14.0 + 10.0 * Proc.hashf(o.seedv, "rdh%d" % i)) * s
				draw_line(Vector2(rx, ry), Vector2(rx + 2.0 * s, ry - rh), moss.darkened(0.1), 1.6 * s, true)
				draw_circle(Vector2(rx + 2.0 * s, ry - rh), 2.0 * s, moss.darkened(0.2))
			var rkx := rw * 0.5
			draw_colored_polygon(_tp(Proc.superellipse(9.0 * s, 6.0 * s, 2.4, 16), Vector2(rkx, -8.0 * s)), o.col["stone_lt"])

	func _trough(o, gg: float) -> void:
		var s: float = o.size_mul
		var wood_lt: Color = o.col["wood_lt"]
		var wood_dk: Color = o.col["wood_dk"]
		var w := 30.0 * s
		var h := 26.0 * s * smoothstep(0.05, 0.6, gg)
		# body
		var body := PackedVector2Array([
			Vector2(-w, 0), Vector2(-w * 0.92, -h), Vector2(w * 0.92, -h), Vector2(w, 0)])
		_fill(body, wood_lt, wood_dk)
		# plank seams + hoops
		for i in range(3):
			var x := -w + w * 2.0 * float(i + 1) / 4.0
			draw_line(Vector2(x * 0.96, -2), Vector2(x * 0.92, -h + 2), Color(wood_dk.r, wood_dk.g, wood_dk.b, 0.3), 1.0, true)
		draw_line(Vector2(-w * 0.95, -h * 0.5), Vector2(w * 0.95, -h * 0.5), o.col["metal"], 2.0 * s, true)
		# inner rim (water surface child sits here)
		draw_colored_polygon(_tp(Proc.superellipse(w * 0.9, 5.0 * s, 2.2, 20), Vector2(0, -h)), wood_dk.darkened(0.2))

	func _fountain(o, gg: float) -> void:
		var s: float = o.size_mul
		var stone: Color = o.col["stone_lt"]
		var dk: Color = o.col["stone_dk"]
		# lower basin (water surface child sits in it)
		var bw := 34.0 * s * (0.4 + 0.6 * gg)
		var basin := PackedVector2Array([
			Vector2(-bw, 0), Vector2(-bw * 0.85, -14.0 * s), Vector2(bw * 0.85, -14.0 * s), Vector2(bw, 0)])
		_fill(basin, stone, dk)
		draw_colored_polygon(_tp(Proc.superellipse(bw * 0.85, 7.0 * s, 2.2, 24), Vector2(0, -14.0 * s)), stone.lightened(0.08))
		# central pillar + upper tier dish
		var pg := smoothstep(0.4, 0.9, gg)
		if pg > 0.01:
			draw_line(Vector2(0, -14.0 * s), Vector2(0, -40.0 * s * pg), dk, 6.0 * s, true)
			var tw := 16.0 * s * pg
			var dish := PackedVector2Array([
				Vector2(-tw, -40.0 * s * pg), Vector2(-tw * 0.6, -34.0 * s * pg),
				Vector2(tw * 0.6, -34.0 * s * pg), Vector2(tw, -40.0 * s * pg)])
			_fill(dish, stone.lightened(0.05), dk)
			# falling water streams late
			if gg > 0.7:
				var wc: Color = o.col.get("w_shallow", Color(0.6, 0.85, 0.9, 0.7))
				for sx in [-tw * 0.7, tw * 0.7]:
					draw_line(Vector2(sx, -38.0 * s * pg), Vector2(sx * 1.1, -16.0 * s), Color(wc.r, wc.g, wc.b, 0.5), 2.0 * s, true)

	func _lilypad(o, gg: float) -> void:
		var s: float = o.size_mul
		var pad: Color = o.col["moss"]
		# one or two round pads (on the water-surface child)
		var n := 1 + int(round(Proc.hashf(o.seedv, "lp") + 0.2))
		for i in range(n):
			var cx := (Proc.hashf(o.seedv, "lx%d" % i) - 0.5) * 20.0 * s
			var pr := (13.0 - i * 4.0) * s * (0.3 + 0.7 * gg)
			var padp := _tp(Proc.superellipse(pr, pr * 0.42, 2.2, 22), Vector2(cx, -3.0 * s))
			# notch the pad
			_fill(padp, pad.lightened(0.18), pad.darkened(0.08))
			draw_line(Vector2(cx, -3.0 * s), Vector2(cx + pr, -3.0 * s - pr * 0.1), o.col["soil"].darkened(0.2), 2.0, true)
			for v in range(4):
				var a := -PI * 0.3 + v * 0.3
				draw_line(Vector2(cx, -3.0 * s), Vector2(cx + cos(a) * pr * 0.9, -3.0 * s - sin(a) * pr * 0.35), Color(pad.r, pad.g, pad.b, 0.4).darkened(0.2), 1.0, true)
		# a little flower on the main pad
		if gg > 0.6:
			var fg := smoothstep(0.6, 1.0, gg)
			var fc: Color = o.col.get("flower", Color(0.98, 0.7, 0.85))
			for p in range(6):
				var a := TAU * p / 6.0
				var petal := _tp(Proc.superellipse(2.2 * s * fg, 5.0 * s * fg, 2.0, 12), Vector2(cos(a) * 4.0 * s, -6.0 * s - sin(a) * 2.0 * s))
				draw_colored_polygon(petal, fc)
			draw_circle(Vector2(0, -6.0 * s), 2.5 * s * fg, Color(1.0, 0.9, 0.4))

# ===========================================================================
# per-species grow pacing (minutes) + colour tables
# ===========================================================================
static func _grow_minutes(species: String) -> float:
	match species:
		# small props that build quickly within a session
		"acorn", "pebbles", "haybale": return 6.0
		"lilypad", "firefly": return 5.0
		"flag", "candle": return 8.0
		# medium structures across a session
		"barrel", "crate", "bench", "woodpile", "ladder", "stump": return 22.0
		"signpost", "lantern", "torch", "birdhouse", "beehive", "cart": return 28.0
		"rock", "log", "stalagmite", "cairn", "trough", "brazier": return 30.0
		"fence", "path": return 24.0
		# large / heavy things across a day
		"boulder", "obelisk", "runestone", "streetlamp", "archway": return 90.0
		"statue", "birdbath", "pond": return 120.0
		"well", "fountain": return 150.0
		"bridge": return 180.0
	return 30.0

static func _colors(species: String, material: String, seedv: int, ctx: Dictionary) -> Dictionary:
	var jh := Proc.rangef(seedv, "jh", -0.03, 0.03)
	var d := {}

	# --- wood tones (varied per instance) ---
	var wh := fposmod(0.07 + Proc.rangef(seedv, "wh", -0.02, 0.03) + jh, 1.0)
	var wsat := Proc.rangef(seedv, "ws", 0.38, 0.58)
	var wval := Proc.rangef(seedv, "wv", 0.56, 0.72)
	var wood_lt := Color.from_hsv(wh, wsat * 0.8, min(1.0, wval + 0.18))
	var wood := Color.from_hsv(wh, wsat, wval)
	var wood_dk := Color.from_hsv(wh, min(1.0, wsat + 0.1), wval * 0.62)
	var wood_core := Color.from_hsv(fposmod(wh + 0.02, 1.0), wsat * 0.7, min(1.0, wval + 0.26))
	wood_lt = ProcDecor._drift(wood_lt, ctx, 0.14)
	wood = ProcDecor._drift(wood, ctx, 0.14)
	d["wood_lt"] = wood_lt
	d["wood"] = wood
	d["wood_dk"] = wood_dk
	d["wood_core"] = wood_core

	# --- stone tones ---
	var sh := fposmod(Proc.rangef(seedv, "sh", 0.05, 0.16) + jh, 1.0)
	var ssat := Proc.rangef(seedv, "ss", 0.05, 0.16)
	var sval := Proc.rangef(seedv, "sv", 0.62, 0.80)
	var stone_lt := Color.from_hsv(sh, ssat * 0.7, min(1.0, sval + 0.14))
	var stone := Color.from_hsv(sh, ssat, sval)
	var stone_dk := Color.from_hsv(sh, min(1.0, ssat + 0.08), sval * 0.6)
	stone_lt = ProcDecor._drift(stone_lt, ctx, 0.12)
	stone = ProcDecor._drift(stone, ctx, 0.12)
	d["stone_lt"] = stone_lt
	d["stone"] = stone
	d["stone_dk"] = stone_dk

	# --- shared accents ---
	var moss_h := fposmod(0.30 + Proc.rangef(seedv, "mh", -0.04, 0.05), 1.0)
	d["moss"] = Color.from_hsv(moss_h, 0.5, 0.52)
	d["metal"] = Color.from_hsv(0.08, 0.08, 0.42)
	d["soil"] = Color.from_hsv(fposmod(wh + 0.01, 1.0), 0.42, 0.40)
	d["straw_lt"] = Color.from_hsv(0.13, 0.55, 0.88)
	d["straw_dk"] = Color.from_hsv(0.11, 0.62, 0.62)
	d["rag"] = Color.from_hsv(0.08, 0.3, 0.55)
	d["glass"] = Color.from_hsv(0.55, 0.14, 0.9)
	d["wax"] = Color.from_hsv(0.12, 0.18, 0.95)
	d["paper"] = Color.from_hsv(0.11, 0.3, 0.92)
	d["rune"] = Color.from_hsv(fposmod(0.52 + jh, 1.0), 0.6, 0.95)
	d["flower"] = Color.from_hsv(fposmod(0.92 + Proc.rangef(seedv, "fl", -0.1, 0.1), 1.0), 0.45, 0.98)

	# --- light / flame ---
	var flame_hue := Proc.rangef(seedv, "fh", 0.06, 0.11)
	d["flame_core"] = Color.from_hsv(0.14, 0.35, 1.0)
	d["flame_mid"] = Color.from_hsv(flame_hue, 0.85, 1.0)
	d["flame_tip"] = Color.from_hsv(max(0.0, flame_hue - 0.04), 0.95, 0.95)
	d["glow"] = Color.from_hsv(flame_hue + 0.02, 0.55, 1.0)

	# per-emitter glow strength
	var gs := 0.0
	match species:
		"lantern": gs = 0.8
		"torch": gs = 1.0
		"candle": gs = 0.5
		"brazier": gs = 1.1
		"streetlamp": gs = 0.9
		"firefly": gs = 0.6
		"runestone": gs = 0.0   # rune glow drawn in-body, no bloom child
	d["glow_strength"] = gs
	if species == "firefly":
		d["glow"] = Color.from_hsv(fposmod(0.28 + Proc.rangef(seedv, "ffh", -0.06, 0.08), 1.0), 0.65, 1.0)

	# pennant cloth colours
	var ch := fposmod(Proc.hashf(seedv, "clh"), 1.0)
	d["cloth_lt"] = Color.from_hsv(ch, 0.6, 0.92)
	d["cloth_dk"] = Color.from_hsv(ch, 0.75, 0.68)

	# --- water surface colours (drift toward local mood) ---
	var w_h := fposmod(0.52 + Proc.rangef(seedv, "wth", -0.05, 0.06) + jh, 1.0)
	var w_shallow := Color.from_hsv(w_h, 0.38, 0.88)
	var w_deep := Color.from_hsv(fposmod(w_h + 0.02, 1.0), 0.6, 0.5)
	w_shallow.a = 0.95
	w_deep.a = 1.0
	w_shallow = ProcDecor._drift(w_shallow, ctx, 0.22)
	w_deep = ProcDecor._drift(w_deep, ctx, 0.22)
	d["w_shallow"] = w_shallow
	d["w_deep"] = w_deep
	d["w_glint"] = Color(1, 1, 1, 1)

	return d
