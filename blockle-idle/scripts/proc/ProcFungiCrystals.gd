class_name ProcFungiCrystals
extends RefCounted
# ProcFungiCrystals — procedurally-grown FUNGI and CRYSTALS for Blockle Idle.
#
# Two living families drawn entirely from math (CONVENTIONS.md), both feet-at-origin:
#
#   FUNGI  — mushrooms, toadstools, glowing caps. Soft storybook domes on tender
#            curved stems, with spots / gills / scales / rings / honeycombs, a soft
#            additive bloom for the bioluminescent kinds, and drifting spore motes.
#            Growth: a pin-head primordium pushes up a stem whose button cap slowly
#            unfurls into the species' open form; spots, gills and glow emerge late;
#            clustered species sprout their siblings one by one as growth climbs.
#
#   CRYSTALS — faceted-but-smooth shard clusters, cut gems and split geodes with an
#            inner light-to-dark gradient, bright inner cores, rim glints, a pulsing
#            additive aura and orbiting sparkle motes. Growth: shards rise from tiny
#            nubs and gain siblings + facets + inner light as growth climbs; a geode
#            slowly cracks open to reveal its druzy cavity.
#
# Animation is CHEAP (CONVENTIONS rule 5/6): fungus bodies live in a child Node2D
# whose transform sways + breathes around the feet; crystal shimmer is a GPU
# canvas_item shader driven by TIME + a per-instance phase; glow is an add-blend
# child animated by modulate/scale; motes are a handful of add-blend child dots
# moved by transform. The immediate-mode _draw only re-runs when `growth` crosses a
# threshold (handled by ProcNode), so a screen full of them stays smooth.
#
# Module shape per CONVENTIONS: `class_name ProcFungiCrystals extends RefCounted`
# with static factories returning ProcNode subclasses defined below.

# ---------------------------------------------------------------------------
# Species catalogues (the public vocabulary a world builder can ask for)
# ---------------------------------------------------------------------------
const FUNGUS_SPECIES := [
	"mushroom", "toadstool", "bluecap", "parasol", "morel", "puffball",
	"bracket", "inkcap", "chanterelle", "fairycap", "glowcap", "amanita",
]
const CRYSTAL_SPECIES := [
	"crystal", "crystalpink", "iceshard", "gem", "geode", "amethyst",
	"quartz", "emerald", "ruby", "obsidian", "sapphire", "topaz",
]

# Map decoration ids / loose names → an internal species.
const _ALIASES := {
	"mushroom": "mushroom", "toadstool": "toadstool", "bluecap": "bluecap",
	"crystal": "crystal", "crystalpink": "crystalpink", "iceshard": "iceshard",
	"gem": "gem", "geode": "geode", "shroom": "mushroom", "fungus": "mushroom",
	"ice": "iceshard", "diamond": "quartz",
}

# ===========================================================================
# PUBLIC FACTORIES
# ===========================================================================

# Universal entry point. `type_id` may be a decoration id ("toadstool", "geode"),
# an internal species, or a loose alias; it is routed to the right family. An
# optional adaptation `context` (local_palette / light_dir / elevation /
# neighbours / growth, see §2.3a) is honoured.
static func make(world_seed: int, key: String, type_id: String = "mushroom", context: Dictionary = {}) -> ProcNode:
	var sp := _resolve(type_id)
	if sp in CRYSTAL_SPECIES:
		return make_crystal(world_seed, key, sp, context)
	return make_fungus(world_seed, key, sp, context)

# Build a fungus. `species` ∈ FUNGUS_SPECIES (anything else falls back to a
# seed-chosen one).
static func make_fungus(world_seed: int, key: String, species: String = "mushroom", context: Dictionary = {}) -> ProcNode:
	var n := _Fungus.new()
	n.seedv = _seed(world_seed, key)
	n.species = (species if species in FUNGUS_SPECIES else FUNGUS_SPECIES[_pick(n.seedv, "fsp", FUNGUS_SPECIES.size())])
	n.ctx = context
	if context.has("growth"):
		n.growth = clampf(float(context["growth"]), 0.0, 1.0)
	return n

# Build a crystal / gem / geode. `species` ∈ CRYSTAL_SPECIES.
static func make_crystal(world_seed: int, key: String, species: String = "crystal", context: Dictionary = {}) -> ProcNode:
	var n := _Crystal.new()
	n.seedv = _seed(world_seed, key)
	n.species = (species if species in CRYSTAL_SPECIES else CRYSTAL_SPECIES[_pick(n.seedv, "csp", CRYSTAL_SPECIES.size())])
	n.ctx = context
	if context.has("growth"):
		n.growth = clampf(float(context["growth"]), 0.0, 1.0)
	return n

# Build straight from a decorations.json type dict ({id, material, ...}).
static func make_decoration(world_seed: int, key: String, deco: Dictionary, context: Dictionary = {}) -> ProcNode:
	var mat := String(deco.get("material", ""))
	var id := String(deco.get("id", "mushroom"))
	if mat == "crystal":
		return make_crystal(world_seed, key, _resolve(id), context)
	if mat == "fungus":
		return make_fungus(world_seed, key, _resolve(id), context)
	# Unknown material: route by id anyway.
	return make(world_seed, key, id, context)

# Seed-chosen variety (nice for scatter).
static func random_fungus(world_seed: int, key: String, context: Dictionary = {}) -> ProcNode:
	var s := _seed(world_seed, key)
	return make_fungus(world_seed, key, FUNGUS_SPECIES[_pick(s, "rf", FUNGUS_SPECIES.size())], context)

static func random_crystal(world_seed: int, key: String, context: Dictionary = {}) -> ProcNode:
	var s := _seed(world_seed, key)
	return make_crystal(world_seed, key, CRYSTAL_SPECIES[_pick(s, "rc", CRYSTAL_SPECIES.size())], context)

# ---------------------------------------------------------------------------
# small shared helpers
# ---------------------------------------------------------------------------
static func _seed(world_seed: int, key: String) -> int:
	return hash("%d:%s" % [world_seed, key])

static func _resolve(name: String) -> String:
	var low := name.strip_edges().to_lower()
	if low in FUNGUS_SPECIES or low in CRYSTAL_SPECIES:
		return low
	if _ALIASES.has(low):
		return _ALIASES[low]
	return "mushroom"

static func _pick(seedv: int, key: String, n: int) -> int:
	return int(Proc.hashf(seedv, key) * n) % n

static func _drift(c: Color, ctx: Dictionary, amt: float) -> Color:
	# Blend a species colour `amt` toward the local realm palette so a thing takes
	# on the mood of where it is planted while staying recognisable (§2.3a).
	if ctx.has("local_palette"):
		var lp = ctx["local_palette"]
		if lp is Dictionary and lp.has("base") and lp["base"] is Color:
			return c.lerp(lp["base"], clampf(amt, 0.0, 1.0))
	return c

# ===========================================================================
# GLOW / SPARK / SHADOW — tiny reusable child canvas-items (cheap, add-blend)
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
		var n := 9
		for i in range(n):
			var ti := float(i) / float(n - 1)
			var r: float = lerp(rad, rad * 0.12, ti)
			var a: float = lerp(0.035, 0.16, ti)
			draw_circle(Vector2.ZERO, r, Color(col.r, col.g, col.b, a))

class _Spark extends Node2D:
	var col: Color = Color(1, 1, 1, 1)
	var r: float = 2.0
	func _ready() -> void:
		var m := CanvasItemMaterial.new()
		m.blend_mode = CanvasItemMaterial.BLEND_MODE_ADD
		material = m
	func _draw() -> void:
		draw_circle(Vector2.ZERO, r * 2.2, Color(col.r, col.g, col.b, 0.14))
		draw_circle(Vector2.ZERO, r, Color(col.r, col.g, col.b, 0.5))
		draw_circle(Vector2.ZERO, r * 0.45, Color(1, 1, 1, 0.85))

class _Shadow extends Node2D:
	var w: float = 30.0
	func _draw() -> void:
		var pts := Proc.superellipse(w, w * 0.30, 2.4, 20)
		draw_colored_polygon(pts, Color(0.05, 0.04, 0.08, 0.20))

# ===========================================================================
# FUNGUS
# ===========================================================================

class _Fungus extends ProcNode:
	var species: String = "mushroom"
	var ctx: Dictionary = {}

	# computed in _on_built
	var col: Dictionary = {}
	var subs: Array = []            # per-cap descriptors (clustered species have several)
	var size_mul: float = 1.0
	var lean_x: float = 0.0
	var sway_amp: float = 0.03
	var is_glow: bool = false
	var glow_strength: float = 0.0
	var footprint_radius: float = 26.0

	# children
	var _body: Node2D
	var _glow: _Glow
	var _shadow: _Shadow
	var _sparks: Array = []         # [{node,base,amp,sw,rise,riseh,ph,a}]

	func _on_built() -> void:
		_configure()
		set_grow_minutes(ProcFungiCrystals._f_grow_minutes(species))

		# contact shadow (behind everything)
		_shadow = _Shadow.new()
		_shadow.w = footprint_radius
		_shadow.position = Vector2(0, -1.5)
		add_child(_shadow)

		# soft bloom for glowing kinds
		if is_glow:
			_glow = _Glow.new()
			_glow.col = col["glow"]
			_glow.rad = footprint_radius * 1.9
			_glow.position = Vector2(lean_x, subs[0]["cap_y"])
			_glow.modulate.a = glow_strength
			add_child(_glow)

		# the drawn body lives in a child so sway/breathe is a cheap transform
		_body = _FungusBody.new()
		_body.set("owner_node", self)
		add_child(_body)

		# drifting spore motes for glowing kinds
		if is_glow:
			var cnt := 3 + ProcFungiCrystals._pick(seedv, "mcnt", 3)
			for i in range(cnt):
				var sp := _Spark.new()
				sp.col = col["glow"].lerp(Color(1, 1, 1, 1), 0.4)
				sp.r = Proc.rangef(seedv, "msz%d" % i, 1.2, 2.4)
				add_child(sp)
				_sparks.append({
					"node": sp,
					"base": Vector2(lean_x + Proc.rangef(seedv, "mx%d" % i, -footprint_radius, footprint_radius),
						subs[0]["cap_y"]),
					"amp": Proc.rangef(seedv, "ma%d" % i, 4.0, 12.0),
					"sw": Proc.rangef(seedv, "mw%d" % i, 0.5, 1.4),
					"rise": Proc.rangef(seedv, "mr%d" % i, 0.08, 0.22),
					"riseh": Proc.rangef(seedv, "mh%d" % i, 22.0, 54.0),
					"ph": Proc.rangef(seedv, "mp%d" % i, 0.0, TAU),
					"a": Proc.rangef(seedv, "mal%d" % i, 0.4, 0.9),
				})

	func _configure() -> void:
		col = ProcFungiCrystals._fungus_colors(species, seedv, ctx)
		glow_strength = float(col.get("glow_strength", 0.0))
		is_glow = glow_strength > 0.02

		# size: elevation shrinks (windswept), nestling shrinks a touch
		size_mul = Proc.rangef(seedv, "sz", 0.84, 1.16)
		var elev := float(ctx.get("elevation", 0.0))
		size_mul *= (1.0 - 0.18 * clampf(elev, 0.0, 1.0))
		if int(ctx.get("neighbours", 0)) > 0:
			size_mul *= 0.93

		# lean toward light; higher ground sways a touch more
		var ld = ctx.get("light_dir", Vector2.ZERO)
		if ld is Vector2:
			lean_x = clampf((ld as Vector2).x, -1.0, 1.0)
		sway_amp = (0.018 + 0.03 * clampf(elev, 0.0, 1.0))

		var sh := ProcFungiCrystals._f_shape(species)   # per-species geometry knobs
		sway_amp *= float(sh.get("sway", 1.0))

		# build the cluster of individual caps
		subs.clear()
		var count := 1
		if bool(sh.get("cluster", false)):
			count = 2 + ProcFungiCrystals._pick(seedv, "cl", 4)
		var spread := float(sh.get("spread", 10.0)) * size_mul
		var maxw := 0.0
		for i in range(count):
			var t := (0.0 if count == 1 else (float(i) / float(count - 1) - 0.5) * 2.0)
			var dx := t * spread + Proc.rangef(seedv, "dx%d" % i, -3.0, 3.0) * size_mul
			var isc := 1.0 if i == 0 else Proc.rangef(seedv, "isc%d" % i, 0.55, 0.85)
			var cap_hw := float(sh["cap_hw"]) * size_mul * isc
			var cap_h := float(sh["cap_h"]) * size_mul * isc
			var stem_h := float(sh["stem_h"]) * size_mul * isc
			var stem_w := float(sh["stem_w"]) * size_mul * isc
			subs.append({
				"i": i,
				"dx": dx,
				"emerge": (0.0 if i == 0 else float(i) / float(count) * 0.55),
				"cap_hw": cap_hw,
				"cap_h": cap_h,
				"cap_y": -(stem_h + cap_h * 0.35),
				"stem_h": stem_h,
				"stem_w": stem_w,
				"flat": float(sh["flat"]),
				"umbo": float(sh["umbo"]),
				"droop": float(sh["droop"]),
				"bulb": float(sh["bulb"]),
				"ring": bool(sh["ring"]),
				"spots": int(sh["spots"]),
				"gills": bool(sh["gills"]),
				"scales": bool(sh["scales"]),
				"bands": bool(sh["bands"]),
				"honey": bool(sh["honey"]),
				"ball": bool(sh["ball"]),
			})
			maxw = max(maxw, abs(dx) + cap_hw)
		footprint_radius = max(18.0, maxw)

	func _on_growth() -> void:
		var gg := g()
		if _body:
			_body.queue_redraw()
		if _shadow:
			_shadow.scale = Vector2.ONE * (0.4 + 0.6 * gg)
		if _glow:
			_glow.rad = footprint_radius * (1.0 + 0.9 * gg)
			_glow.queue_redraw()

	func _animate(_delta: float) -> void:
		if _body:
			var sway := sin(t * 0.9 + phase) * sway_amp
			# a slow secondary wobble + lean bias toward the light
			sway += sin(t * 0.37 + phase * 1.7) * sway_amp * 0.4 + lean_x * 0.015
			_body.rotation = sway
			var breathe := 1.0 + sin(t * 1.25 + phase) * 0.02 * g()
			_body.scale = Vector2(1.0 - (breathe - 1.0) * 0.4, breathe)
		if _glow:
			var pulse := 0.72 + 0.28 * (0.5 + 0.5 * sin(t * 1.5 + phase))
			_glow.modulate.a = glow_strength * pulse * g()
			_glow.scale = Vector2.ONE * (0.95 + 0.08 * sin(t * 1.1 + phase))
		for s in _sparks:
			var h := fposmod(t * float(s["rise"]) + float(s["ph"]), 1.0)
			var bx := float(s["base"].x) + sin(t * float(s["sw"]) + float(s["ph"])) * float(s["amp"])
			var by := float(s["base"].y) - float(s["riseh"]) * h
			s["node"].position = Vector2(bx, by)
			s["node"].modulate.a = sin(h * PI) * float(s["a"]) * g()

	func _draw() -> void:
		pass   # all body art is in _FungusBody; this node only hosts children

# --- the actual fungus silhouette (child so the parent can sway it) ---------
class _FungusBody extends Node2D:
	var owner_node   # _Fungus

	func _draw() -> void:
		if owner_node == null:
			return
		var o = owner_node
		var gg: float = o.g()
		var col: Dictionary = o.col
		# draw back-to-front (smaller clustered caps sit behind the first)
		var order: Array = o.subs.duplicate()
		order.sort_custom(func(a, b): return float(a["cap_hw"]) > float(b["cap_hw"]))
		for sub in order:
			_draw_one(sub, gg, col)

	func _draw_one(sub: Dictionary, gg: float, col: Dictionary) -> void:
		var o = owner_node
		# per-cap local growth: siblings emerge as overall growth climbs
		var em := float(sub["emerge"])
		var lg := clampf((gg - em) / max(0.001, 1.0 - em), 0.0, 1.0)
		if lg <= 0.001:
			return
		var elg := lg * lg * (3.0 - 2.0 * lg)         # smoothstep ease
		var dx := float(sub["dx"])
		var lean: float = o.lean_x

		# --- staged dimensions ---
		var stem_h := float(sub["stem_h"]) * (0.18 + 0.82 * elg)
		var stem_w := float(sub["stem_w"]) * (0.55 + 0.45 * elg)
		var open := smoothstep(0.32, 0.82, lg)         # how far the cap has unfurled
		# button→open: width grows, height relaxes, flat/droop emerge
		var cap_hw := float(sub["cap_hw"]) * (0.42 + 0.58 * elg) * (0.72 + 0.28 * open)
		var cap_h := float(sub["cap_h"]) * (0.52 + 0.48 * elg) * (1.08 - 0.22 * open)
		var flat := float(sub["flat"]) * open
		var umbo := float(sub["umbo"])
		var droop := float(sub["droop"]) * open
		var ball := bool(sub["ball"])

		var cap_cx := dx + lean * (stem_h * 0.10)
		var cap_cy := -(stem_h) - (0.0 if ball else cap_h * 0.02)
		var lean_top := lean * stem_h * 0.08

		# ---------- STEM ----------
		if not ball:
			var stem := _stem_poly(dx, stem_w, stem_w * 0.62, stem_h, float(sub["bulb"]) * elg, lean_top)
			draw_polygon(stem, Proc.grad_fill(stem, col["stem_lt"], col["stem_dk"]))
			# soft core highlight down the stem
			var hw := stem_w * 0.22
			var hi := PackedVector2Array([
				Vector2(dx - hw + lean_top * 0.4, -stem_h * 0.92),
				Vector2(dx + hw * 0.3 + lean_top * 0.4, -stem_h * 0.92),
				Vector2(dx + hw * 0.2, -2.0),
				Vector2(dx - hw * 0.8, -2.0)])
			draw_colored_polygon(hi, Color(col["stem_lt"].r, col["stem_lt"].g, col["stem_lt"].b, 0.5))
			# ring / annulus skirt (toadstool, amanita)
			if bool(sub["ring"]) and open > 0.2:
				var ry := -stem_h * 0.62
				var rw := stem_w * (1.5 + open)
				var ring := PackedVector2Array([
					Vector2(dx - rw, ry), Vector2(dx + rw, ry),
					Vector2(dx + rw * 0.7, ry + stem_w * 0.9),
					Vector2(dx - rw * 0.7, ry + stem_w * 0.9)])
				draw_colored_polygon(ring, col["ring"])

		# ---------- CAP ----------
		var cap
		if ball:
			cap = { "poly": Proc.superellipse(cap_hw, cap_h, 2.0, 30), "crown": PackedVector2Array() }
			# recentre ball so its bottom sits near stem top / ground
			var shifted := PackedVector2Array()
			for p in cap["poly"]:
				shifted.append(Vector2(p.x + cap_cx, p.y + cap_cy - cap_h * 0.1))
			cap["poly"] = shifted
		else:
			cap = _cap_poly(cap_cx, cap_cy, cap_hw, cap_h, flat, umbo, droop)

		# gills: a soft dark crescent under an opened cap, with a few radial ticks
		if bool(sub["gills"]) and open > 0.25 and not ball:
			var gy := cap_cy + cap_h * 0.06
			var gcol: Color = col["gill"]
			gcol.a = 0.55 * open
			var gh := cap_h * 0.22 * open
			var cres := PackedVector2Array([
				Vector2(cap_cx - cap_hw * 0.92, gy),
				Vector2(cap_cx, gy + gh),
				Vector2(cap_cx + cap_hw * 0.92, gy)])
			draw_colored_polygon(cres, gcol)
			var ticks := 5
			for i in range(ticks + 1):
				var u := float(i) / ticks
				var gx := lerpf(cap_cx - cap_hw * 0.8, cap_cx + cap_hw * 0.8, u)
				draw_line(Vector2(gx, gy + gh * 0.1),
					Vector2(cap_cx + (gx - cap_cx) * 0.5, gy + gh * 0.9),
					Color(gcol.r, gcol.g, gcol.b, gcol.a * 0.8), 1.0, true)

		# cap body gradient
		draw_polygon(cap["poly"], Proc.grad_fill(cap["poly"], col["cap_top"], col["cap_bot"]))

		# rim / crown highlight
		if cap["crown"].size() > 1:
			draw_polyline(cap["crown"], col["cap_hi"], max(1.5, cap_hw * 0.06), true)

		# ---- surface detailing by species ----
		if int(sub["spots"]) > 0 and open > 0.12:
			_draw_spots(sub, cap_cx, cap_cy, cap_hw, cap_h, flat, open, col)
		if bool(sub["scales"]) and open > 0.2:
			_draw_scales(sub, cap_cx, cap_cy, cap_hw, cap_h, open, col)
		if bool(sub["bands"]):
			_draw_bands(cap_cx, cap_cy, cap_hw, cap_h, col)
		if bool(sub["honey"]):
			_draw_honey(sub, cap_cx, cap_cy, cap_hw, cap_h, col)

		# umbo / top specular dab
		var dab_c := Vector2(cap_cx - cap_hw * 0.22, cap_cy - cap_h * (0.52 if not ball else 0.35))
		draw_circle(dab_c, cap_hw * 0.16, Color(col["cap_hi"].r, col["cap_hi"].g, col["cap_hi"].b, 0.35))

	# ---- cap outline: top profile + shallow underside, returned with the crown ----
	func _cap_poly(cx: float, cy: float, hw: float, h: float, flat: float, umbo: float, droop: float) -> Dictionary:
		var crown := PackedVector2Array()
		var steps := 26
		for i in range(steps + 1):
			var u := float(i) / steps                 # 0..1 L→R
			var x: float = lerp(-hw, hw, u)
			var arch := sin(u * PI)                    # 1 at centre, 0 at edges
			var top_y := cy - h * pow(max(0.0, arch), 0.62 + flat * 1.5)
			top_y -= umbo * h * max(0.0, 1.0 - abs(u - 0.5) * 3.6)   # central umbo bump
			top_y += droop * h * (1.0 - arch)                        # edges droop down
			crown.append(Vector2(cx + x, top_y))
		var poly := PackedVector2Array(crown)
		var bsteps := 12
		for i in range(bsteps + 1):
			var u := 1.0 - float(i) / bsteps
			var x: float = lerp(-hw, hw, u)
			var edge := sin(u * PI)
			var by := cy + h * 0.14 * edge * (1.0 - flat * 0.6)
			poly.append(Vector2(cx + x, by))
		return { "poly": poly, "crown": crown }

	# ---- tapered, slightly bulbous stem ----
	func _stem_poly(dx: float, wb: float, wt: float, h: float, bulb: float, lean_top: float) -> PackedVector2Array:
		var controls := PackedVector2Array()
		controls.append(Vector2(dx - wb, 0.0))
		controls.append(Vector2(dx - wb * (1.0 + bulb * 0.5), -h * 0.14))
		controls.append(Vector2(dx - wt - lean_top * 0.0, -h * 0.55))
		controls.append(Vector2(dx - wt + lean_top, -h))
		controls.append(Vector2(dx + wt + lean_top, -h))
		controls.append(Vector2(dx + wt, -h * 0.55))
		controls.append(Vector2(dx + wb * (1.0 + bulb * 0.5), -h * 0.14))
		controls.append(Vector2(dx + wb, 0.0))
		return Proc.smooth_loop(controls, 5)

	func _draw_spots(sub: Dictionary, cx: float, cy: float, hw: float, h: float, flat: float, open: float, col: Dictionary) -> void:
		var o = owner_node
		var n := int(round(int(sub["spots"]) * open))
		var sc: Color = col["spot"]
		for i in range(n):
			var u := Proc.hashf(o.seedv, "sp%d_%d_u" % [int(sub["i"]), i]) * 2.0 - 1.0
			var v := Proc.hashf(o.seedv, "sp%d_%d_v" % [int(sub["i"]), i])
			var sx := cx + u * hw * 0.78
			var arch := 1.0 - u * u
			var sy := cy - h * pow(max(0.0, arch), 0.62 + flat * 1.5) * (0.35 + v * 0.55)
			var sr := hw * (0.07 + 0.06 * Proc.hashf(o.seedv, "sp%d_%d_r" % [int(sub["i"]), i])) * (0.6 + 0.4 * open)
			draw_circle(Vector2(sx, sy), sr, sc)
			draw_circle(Vector2(sx - sr * 0.3, sy - sr * 0.3), sr * 0.45, Color(1, 1, 1, 0.5))

	func _draw_scales(sub: Dictionary, cx: float, cy: float, hw: float, h: float, open: float, col: Dictionary) -> void:
		var o = owner_node
		var rings := 3
		var sc: Color = col["cap_bot"].darkened(0.2)
		for r in range(rings):
			var rr := float(r + 1) / float(rings + 1)
			var count := 5 + r * 3
			for i in range(count):
				var u := float(i) / count * 2.0 - 1.0 + Proc.hashf(o.seedv, "scl%d%d%d" % [int(sub["i"]), r, i]) * 0.1
				var sx := cx + u * hw * rr
				var arch := 1.0 - u * u
				var sy := cy - h * arch * (1.0 - rr) * 0.9 - h * 0.08
				draw_circle(Vector2(sx, sy), hw * 0.055, Color(sc.r, sc.g, sc.b, 0.5))

	func _draw_bands(cx: float, cy: float, hw: float, h: float, col: Dictionary) -> void:
		# concentric shelf-fungus growth rings
		var rings := 4
		for r in range(rings):
			var f := float(r + 1) / float(rings + 1)
			var band := PackedVector2Array()
			var steps := 20
			for i in range(steps + 1):
				var u := float(i) / steps
				var x: float = lerp(-hw * f, hw * f, u)
				var arch := sin(u * PI)
				band.append(Vector2(cx + x, cy - h * arch * f * 0.9 - h * 0.05))
			var c: Color = col["cap_top"].lerp(col["cap_bot"], f)
			draw_polyline(band, Color(c.r, c.g, c.b, 0.55), 1.4, true)

	func _draw_honey(sub: Dictionary, cx: float, cy: float, hw: float, h: float, col: Dictionary) -> void:
		# morel honeycomb pits
		var o = owner_node
		var cols := 4
		var rows := 5
		var dk: Color = col["cap_bot"].darkened(0.3)
		for ry in range(rows):
			var fy := float(ry) / float(rows - 1)
			var w := hw * (1.0 - fy * 0.7)
			for cxi in range(cols):
				var u := (float(cxi) / float(cols - 1) - 0.5) * 2.0
				var px := cx + u * w + (0.5 if ry % 2 else 0.0) * (w / cols)
				var py := cy - h * (0.1 + fy * 0.78)
				if abs(u) * w > hw:
					continue
				draw_circle(Vector2(px, py), hw * 0.11, Color(dk.r, dk.g, dk.b, 0.6))

# ---- per-species fungus geometry & colour tables --------------------------

static func _f_grow_minutes(species: String) -> float:
	match species:
		"bracket": return 9.0
		"puffball", "parasol": return 6.0
		_: return 4.0 + (3.0 if species in ["toadstool", "amanita", "glowcap"] else 0.0)

static func _f_shape(species: String) -> Dictionary:
	# cap_hw/cap_h/stem_h/stem_w are mature half-sizes in px; flags toggle detailing.
	var base := {
		"cap_hw": 22.0, "cap_h": 16.0, "stem_h": 46.0, "stem_w": 6.0,
		"flat": 0.35, "umbo": 0.0, "droop": 0.0, "bulb": 0.3,
		"ring": false, "spots": 0, "gills": true, "scales": false,
		"bands": false, "honey": false, "ball": false,
		"cluster": false, "spread": 11.0, "sway": 1.0,
	}
	match species:
		"mushroom":
			base.merge({ "cap_hw": 18.0, "cap_h": 14.0, "stem_h": 34.0, "stem_w": 5.5,
				"flat": 0.5, "cluster": true, "spread": 16.0, "bulb": 0.25 }, true)
		"toadstool":
			base.merge({ "cap_hw": 26.0, "cap_h": 20.0, "stem_h": 56.0, "stem_w": 7.5,
				"flat": 0.45, "umbo": 0.08, "ring": true, "spots": 11, "bulb": 0.55,
				"sway": 1.15 }, true)
		"amanita":
			base.merge({ "cap_hw": 25.0, "cap_h": 22.0, "stem_h": 60.0, "stem_w": 7.0,
				"flat": 0.35, "umbo": 0.12, "ring": true, "spots": 8, "bulb": 0.7,
				"sway": 1.2 }, true)
		"bluecap":
			base.merge({ "cap_hw": 13.0, "cap_h": 17.0, "stem_h": 44.0, "stem_w": 3.6,
				"flat": 0.18, "umbo": 0.25, "cluster": true, "spread": 12.0,
				"bulb": 0.2, "sway": 1.5 }, true)
		"glowcap":
			base.merge({ "cap_hw": 16.0, "cap_h": 20.0, "stem_h": 40.0, "stem_w": 4.0,
				"flat": 0.2, "umbo": 0.3, "cluster": true, "spread": 13.0,
				"sway": 1.4 }, true)
		"fairycap":
			base.merge({ "cap_hw": 10.0, "cap_h": 12.0, "stem_h": 26.0, "stem_w": 2.8,
				"flat": 0.22, "umbo": 0.2, "cluster": true, "spread": 15.0,
				"sway": 1.6 }, true)
		"parasol":
			base.merge({ "cap_hw": 30.0, "cap_h": 14.0, "stem_h": 70.0, "stem_w": 5.5,
				"flat": 0.72, "umbo": 0.14, "droop": 0.12, "ring": true,
				"scales": true, "sway": 1.25 }, true)
		"inkcap":
			base.merge({ "cap_hw": 11.0, "cap_h": 26.0, "stem_h": 58.0, "stem_w": 3.4,
				"flat": 0.05, "umbo": 0.0, "droop": 0.16, "cluster": true,
				"spread": 9.0, "sway": 1.6 }, true)
		"chanterelle":
			base.merge({ "cap_hw": 20.0, "cap_h": 16.0, "stem_h": 40.0, "stem_w": 6.0,
				"flat": 0.3, "umbo": -0.35, "droop": -0.2, "cluster": true,
				"spread": 12.0, "sway": 1.1 }, true)
		"morel":
			base.merge({ "cap_hw": 15.0, "cap_h": 34.0, "stem_h": 26.0, "stem_w": 7.0,
				"flat": 0.02, "umbo": 0.0, "honey": true, "bulb": 0.4,
				"gills": false, "sway": 0.9 }, true)
		"puffball":
			base.merge({ "cap_hw": 20.0, "cap_h": 20.0, "stem_h": 8.0, "stem_w": 14.0,
				"ball": true, "gills": false, "bulb": 0.6, "sway": 0.6 }, true)
		"bracket":
			base.merge({ "cap_hw": 30.0, "cap_h": 12.0, "stem_h": 6.0, "stem_w": 10.0,
				"flat": 0.85, "droop": 0.25, "bands": true, "gills": false,
				"bulb": 0.2, "sway": 0.5 }, true)
	return base

static func _fungus_colors(species: String, seedv: int, ctx: Dictionary) -> Dictionary:
	var jh := Proc.rangef(seedv, "fjh", -0.02, 0.02)
	# defaults (earthy mushroom)
	var cap_h := 0.07
	var cap_s := 0.45
	var cap_v := 0.74
	var stem_h := 0.10
	var stem_s := 0.12
	var stem_v := 0.95
	var spot := Color(0.98, 0.96, 0.9, 1.0)
	var gill := Color(0.6, 0.45, 0.4, 1.0)
	var glow_hue := 0.12
	var glow_strength := 0.0
	match species:
		"toadstool", "amanita":
			cap_h = (0.0 if species == "toadstool" else 0.055); cap_s = 0.82; cap_v = 0.92
			glow_hue = 0.07; glow_strength = (0.35 if species == "toadstool" else 0.22)
		"bluecap":
			cap_h = 0.58; cap_s = 0.6; cap_v = 0.95; glow_hue = 0.56; glow_strength = 0.9
			stem_h = 0.57; stem_s = 0.14; stem_v = 0.96
		"glowcap":
			cap_h = 0.33; cap_s = 0.62; cap_v = 0.96; glow_hue = 0.34; glow_strength = 1.0
			stem_h = 0.3; stem_s = 0.2; stem_v = 0.95
		"fairycap":
			cap_h = 0.78; cap_s = 0.3; cap_v = 0.95; glow_hue = 0.8; glow_strength = 0.4
			stem_h = 0.8; stem_s = 0.08; stem_v = 0.97
		"parasol":
			cap_h = 0.08; cap_s = 0.32; cap_v = 0.82
		"morel":
			cap_h = 0.09; cap_s = 0.42; cap_v = 0.6; stem_v = 0.92
		"puffball":
			cap_h = 0.1; cap_s = 0.08; cap_v = 0.93; glow_strength = 0.0
		"bracket":
			cap_h = 0.06; cap_s = 0.52; cap_v = 0.72
		"inkcap":
			cap_h = 0.62; cap_s = 0.05; cap_v = 0.92; glow_hue = 0.62; glow_strength = 0.12
		"chanterelle":
			cap_h = 0.11; cap_s = 0.62; cap_v = 0.93
		"mushroom":
			cap_h = 0.07; cap_s = 0.4; cap_v = 0.76
	cap_h = fposmod(cap_h + jh, 1.0)
	var cap_bot := Color.from_hsv(cap_h, min(1.0, cap_s + 0.12), cap_v * 0.78)
	var cap_top := Color.from_hsv(cap_h, cap_s, min(1.0, cap_v + 0.08))
	var cap_hi := Color.from_hsv(cap_h, cap_s * 0.5, min(1.0, cap_v + 0.2))
	var stem_dk := Color.from_hsv(stem_h, min(1.0, stem_s + 0.1), stem_v * 0.7)
	var stem_lt := Color.from_hsv(stem_h, stem_s * 0.6, min(1.0, stem_v + 0.03))
	# context palette drift (keep mostly the species' own hue)
	cap_top = ProcFungiCrystals._drift(cap_top, ctx, 0.18)
	cap_bot = ProcFungiCrystals._drift(cap_bot, ctx, 0.18)
	return {
		"cap_top": cap_top, "cap_bot": cap_bot, "cap_hi": cap_hi,
		"stem_lt": stem_lt, "stem_dk": stem_dk,
		"spot": spot, "gill": gill,
		"ring": Color(stem_lt.r, stem_lt.g, stem_lt.b, 0.9),
		"glow": Color.from_hsv(fposmod(glow_hue + jh, 1.0), 0.6, 1.0),
		"glow_strength": glow_strength,
	}

# ===========================================================================
# CRYSTAL
# ===========================================================================

class _Crystal extends ProcNode:
	var species: String = "crystal"
	var ctx: Dictionary = {}

	var col: Dictionary = {}
	var shards: Array = []           # [{dx, h, w, lean, emerge, hue}]
	var render_mode: String = "shards"   # shards | gems | geode
	var size_mul: float = 1.0
	var glow_strength: float = 0.8
	var footprint_radius: float = 26.0

	var _glow: _Glow
	var _shadow: _Shadow
	var _sparks: Array = []

	func _on_built() -> void:
		_configure()
		set_grow_minutes(ProcFungiCrystals._c_grow_minutes(species))

		# shimmer shader on the crystal body itself (this node's own _draw output)
		var sh := Shader.new()
		sh.code = _SHIMMER_CODE
		var mat := ShaderMaterial.new()
		mat.shader = sh
		mat.set_shader_parameter("phase", phase)
		mat.set_shader_parameter("glint", 0.45 + 0.35 * glow_strength)
		mat.set_shader_parameter("pulse_amt", 0.10 + 0.06 * glow_strength)
		material = mat

		_shadow = _Shadow.new()
		_shadow.w = footprint_radius
		_shadow.position = Vector2(0, -1.0)
		add_child(_shadow)
		move_child(_shadow, 0)

		_glow = _Glow.new()
		_glow.col = col["glow"]
		_glow.rad = footprint_radius * 1.7
		_glow.position = Vector2(0, -_c_height() * 0.55)
		_glow.modulate.a = glow_strength
		add_child(_glow)
		move_child(_glow, 0)

		var cnt := 3 + ProcFungiCrystals._pick(seedv, "csk", 3)
		for i in range(cnt):
			var sp := _Spark.new()
			sp.col = col["glow"].lerp(Color(1, 1, 1, 1), 0.55)
			sp.r = Proc.rangef(seedv, "csz%d" % i, 1.0, 2.2)
			add_child(sp)
			_sparks.append({
				"node": sp,
				"cx": Proc.rangef(seedv, "ccx%d" % i, -footprint_radius * 0.7, footprint_radius * 0.7),
				"cy": -Proc.rangef(seedv, "ccy%d" % i, _c_height() * 0.2, _c_height() * 0.95),
				"orb": Proc.rangef(seedv, "cor%d" % i, 4.0, 11.0),
				"sp": Proc.rangef(seedv, "csp%d" % i, 0.4, 1.1),
				"ph": Proc.rangef(seedv, "cph%d" % i, 0.0, TAU),
				"a": Proc.rangef(seedv, "cal%d" % i, 0.4, 0.85),
			})

	func _c_height() -> float:
		var h := 0.0
		for s in shards:
			h = max(h, float(s["h"]))
		return max(24.0, h)

	func _configure() -> void:
		col = ProcFungiCrystals._crystal_colors(species, seedv, ctx)
		glow_strength = float(col.get("glow_strength", 0.8))
		size_mul = Proc.rangef(seedv, "csz", 0.85, 1.18)
		var elev := float(ctx.get("elevation", 0.0))
		size_mul *= (1.0 - 0.14 * clampf(elev, 0.0, 1.0))
		if int(ctx.get("neighbours", 0)) > 0:
			size_mul *= 0.95

		match species:
			"gem": render_mode = "gems"
			"geode": render_mode = "geode"
			_: render_mode = "shards"

		shards.clear()
		if render_mode == "geode":
			_build_geode()
		else:
			_build_cluster()
		var maxw := 8.0
		for s in shards:
			maxw = max(maxw, abs(float(s["dx"])) + float(s["w"]) * 0.7)
		footprint_radius = max(16.0, maxw)

	func _build_cluster() -> void:
		var count := 3 + ProcFungiCrystals._pick(seedv, "ccnt", 5)
		if render_mode == "gems":
			count = 2 + ProcFungiCrystals._pick(seedv, "gcnt", 3)
		var base_h := (62.0 if render_mode == "shards" else 30.0) * size_mul
		for i in range(count):
			var tc := (0.0 if count == 1 else (float(i) / float(count - 1) - 0.5) * 2.0)
			var is_main := i == 0
			var hh := base_h * (1.0 if is_main else Proc.rangef(seedv, "ch%d" % i, 0.4, 0.82))
			var ww := hh * Proc.rangef(seedv, "cw%d" % i, 0.22, 0.34)
			if render_mode == "gems":
				ww = hh * Proc.rangef(seedv, "gw%d" % i, 0.7, 0.95)
			shards.append({
				"dx": tc * footprint_hint() + Proc.rangef(seedv, "cdx%d" % i, -4.0, 4.0),
				"h": hh, "w": ww,
				"lean": Proc.rangef(seedv, "cln%d" % i, -0.22, 0.22) + (0.0 if is_main else tc * 0.18),
				"emerge": (0.0 if is_main else float(i) / float(count) * 0.6),
				"hue": Proc.hashf(seedv, "chue%d" % i),   # used by gem/multi species
			})

	func footprint_hint() -> float:
		return (22.0 if render_mode == "gems" else 16.0) * size_mul

	func _build_geode() -> void:
		# one implicit outer shell (drawn specially) + a ring of tiny inner shards
		var inner := 7 + ProcFungiCrystals._pick(seedv, "gi", 6)
		var rad := 26.0 * size_mul
		for i in range(inner):
			var a := PI + (float(i) / float(inner - 1)) * PI    # lower cavity arc, pointing up/in
			var hh := Proc.rangef(seedv, "gih%d" % i, 7.0, 16.0) * size_mul
			shards.append({
				"dx": cos(a) * rad * 0.7,
				"h": hh, "w": hh * 0.4,
				"lean": -cos(a) * 0.5,
				"emerge": 0.3 + 0.5 * Proc.hashf(seedv, "gie%d" % i),
				"hue": Proc.hashf(seedv, "gihue%d" % i),
				"cy": sin(a) * rad * 0.35 - rad * 0.2,
			})

	func _on_growth() -> void:
		queue_redraw()
		var gg := g()
		if _shadow:
			_shadow.scale = Vector2.ONE * (0.4 + 0.6 * gg)
		if _glow:
			_glow.rad = footprint_radius * (0.9 + 1.0 * gg)
			_glow.queue_redraw()

	func _animate(_delta: float) -> void:
		if _glow:
			var pulse := 0.68 + 0.32 * (0.5 + 0.5 * sin(t * 1.35 + phase))
			# a faint secondary twinkle
			pulse *= 0.9 + 0.1 * sin(t * 3.1 + phase * 2.0)
			_glow.modulate.a = glow_strength * pulse * g()
			_glow.scale = Vector2.ONE * (0.94 + 0.09 * sin(t * 0.9 + phase))
		for s in _sparks:
			var tt := t * float(s["sp"]) + float(s["ph"])
			s["node"].position = Vector2(
				float(s["cx"]) + cos(tt) * float(s["orb"]),
				float(s["cy"]) + sin(tt * 0.8) * float(s["orb"]) * 0.5)
			s["node"].modulate.a = (0.4 + 0.6 * (0.5 + 0.5 * sin(tt * 1.7))) * float(s["a"]) * g()

	func _draw() -> void:
		var gg := g()
		match render_mode:
			"geode": _draw_geode(gg)
			"gems": _draw_gems(gg)
			_: _draw_shards(gg)

	# ---- faceted-but-smooth pointed shards -------------------------------
	func _draw_shards(gg: float) -> void:
		var order: Array = shards.duplicate()
		order.sort_custom(func(a, b): return float(a["h"]) > float(b["h"]))
		for s in order:
			_draw_shard(s, gg, col["base"], col["lt"], col["core"], col["facet"], col["rim"])

	func _draw_shard(s: Dictionary, gg: float, base: Color, lt: Color, core: Color, facet: Color, rim: Color) -> void:
		var em := float(s["emerge"])
		var lg := clampf((gg - em) / max(0.001, 1.0 - em), 0.0, 1.0)
		if lg <= 0.01:
			return
		var elg := lg * lg * (3.0 - 2.0 * lg)
		var dx := float(s["dx"])
		var h := float(s["h"]) * (0.12 + 0.88 * elg)
		var w := float(s["w"]) * (0.45 + 0.55 * elg)
		var lean := float(s["lean"])
		var tipx := dx + lean * h
		var shoulder := h * 0.62

		var outline := PackedVector2Array([
			Vector2(dx - w, 0.0),
			Vector2(dx - w, -h * 0.28),
			Vector2(dx - w * 0.78 + lean * shoulder * 0.5, -shoulder),
			Vector2(tipx, -h),
			Vector2(dx + w * 0.78 + lean * shoulder * 0.5, -shoulder),
			Vector2(dx + w, -h * 0.28),
			Vector2(dx + w, 0.0),
		])
		# soften corners just slightly (faceted-but-smooth)
		var poly := Proc.smooth_loop(outline, 3)
		draw_polygon(poly, Proc.grad_fill(poly, lt, base))

		# left/right facet split: a darker right face + a bright left face
		var midx_top := tipx
		var right := PackedVector2Array([
			Vector2(dx + w, 0.0), Vector2(dx + w, -h * 0.28),
			Vector2(dx + w * 0.78 + lean * shoulder * 0.5, -shoulder),
			Vector2(midx_top, -h), Vector2(dx + w * 0.12, 0.0)])
		draw_colored_polygon(right, Color(base.r, base.g, base.b, 0.55))

		# inner luminous core (narrow bright shard up the middle)
		var cw := w * 0.42
		var core_poly := PackedVector2Array([
			Vector2(dx - cw, -h * 0.05),
			Vector2(dx - cw * 0.6 + lean * shoulder * 0.5, -shoulder),
			Vector2(tipx, -h),
			Vector2(dx + cw * 0.6 + lean * shoulder * 0.5, -shoulder),
			Vector2(dx + cw, -h * 0.05)])
		draw_polygon(core_poly, Proc.grad_fill(core_poly,
			Color(core.r, core.g, core.b, 0.9), Color(core.r, core.g, core.b, 0.25)))

		# facet lines + rim glints
		draw_line(Vector2(dx, -h * 0.04), Vector2(tipx, -h), Color(facet.r, facet.g, facet.b, 0.55), 1.2, true)
		draw_polyline(PackedVector2Array([
			Vector2(dx - w, -h * 0.26),
			Vector2(dx - w * 0.78 + lean * shoulder * 0.5, -shoulder),
			Vector2(tipx, -h)]), rim, 1.6, true)
		# tiny tip sparkle
		draw_circle(Vector2(tipx, -h), max(1.2, w * 0.14), Color(1, 1, 1, 0.8))

	# ---- cut gems (rounded faceted jewels, multi-hued) -------------------
	func _draw_gems(gg: float) -> void:
		var order: Array = shards.duplicate()
		order.sort_custom(func(a, b): return float(a["h"]) > float(b["h"]))
		for s in order:
			_draw_gem(s, gg)

	func _draw_gem(s: Dictionary, gg: float) -> void:
		var em := float(s["emerge"])
		var lg := clampf((gg - em) / max(0.001, 1.0 - em), 0.0, 1.0)
		if lg <= 0.01:
			return
		var elg := lg * lg * (3.0 - 2.0 * lg)
		var dx := float(s["dx"])
		var h := float(s["h"]) * (0.2 + 0.8 * elg)
		var w := float(s["w"]) * (0.5 + 0.5 * elg)
		# gem palette: species base hue, or per-gem hue for the "gem" multi cluster
		var base: Color = col["base"]
		var lt: Color = col["lt"]
		var rim: Color = col["rim"]
		if species == "gem":
			var hue := float(s["hue"])
			base = Color.from_hsv(hue, 0.65, 0.55)
			lt = Color.from_hsv(hue, 0.5, 0.95)
			rim = Color.from_hsv(hue, 0.25, 1.0)
		# silhouette: crown (table at top) + pavilion (culet at bottom)
		var crown_y := -h
		var girdle_y := -h * 0.48
		var poly := PackedVector2Array([
			Vector2(dx - w * 0.5, crown_y),           # table left
			Vector2(dx + w * 0.5, crown_y),           # table right
			Vector2(dx + w, girdle_y),                # girdle right
			Vector2(dx + w * 0.35, 0.0),              # pavilion right → culet
			Vector2(dx - w * 0.35, 0.0),              # pavilion left
			Vector2(dx - w, girdle_y),                # girdle left
		])
		draw_polygon(poly, Proc.grad_fill(poly, lt, base))
		# table facet (bright quad on top)
		var table := PackedVector2Array([
			Vector2(dx - w * 0.5, crown_y), Vector2(dx + w * 0.5, crown_y),
			Vector2(dx + w * 0.34, girdle_y * 0.86), Vector2(dx - w * 0.34, girdle_y * 0.86)])
		draw_colored_polygon(table, Color(lt.r, lt.g, lt.b, 0.85))
		# facet star: lines from girdle corners to culet & table corners
		var culet := Vector2(dx, 0.0)
		var pts := [Vector2(dx - w, girdle_y), Vector2(dx + w, girdle_y),
			Vector2(dx - w * 0.5, crown_y), Vector2(dx + w * 0.5, crown_y)]
		for p in pts:
			draw_line(p, culet, Color(rim.r, rim.g, rim.b, 0.4), 1.0, true)
		# rim outline + sparkle
		var rimloop := PackedVector2Array(poly)
		rimloop.append(poly[0])
		draw_polyline(rimloop, Color(rim.r, rim.g, rim.b, 0.7), 1.4, true)
		draw_circle(Vector2(dx - w * 0.2, crown_y + h * 0.12), max(1.2, w * 0.1), Color(1, 1, 1, 0.9))

	# ---- geode: stone shell cracking open onto a druzy cavity -------------
	func _draw_geode(gg: float) -> void:
		var r := 28.0 * size_mul
		var open := smoothstep(0.25, 0.8, gg)     # the crack widening
		# outer stone shell (two halves parting)
		var shell_col: Color = col.get("shell", Color(0.4, 0.37, 0.34))
		var shell_dk := shell_col.darkened(0.3)
		for side in [-1.0, 1.0]:
			var sd := float(side)
			var gap := sd * open * r * 0.12
			# a blobby half-disc shell that parts as the geode opens
			var blob := PackedVector2Array()
			var bs := 18
			for i in range(bs + 1):
				var u := float(i) / bs
				var a := PI * 0.5 + sd * u * PI
				blob.append(Vector2(gap + cos(a) * r, -r + sin(a) * r))
			blob.append(Vector2(gap, -r))
			draw_polygon(blob, Proc.grad_fill(blob, shell_col, shell_dk))
			draw_polyline(blob, shell_dk, 1.5, true)
		# inner cavity (revealed as it opens)
		var cav_col: Color = col["base"].darkened(0.4)
		var cav := Proc.superellipse(r * 0.72 * open + 1.0, r * 0.82, 2.2, 22)
		var cshift := PackedVector2Array()
		for p in cav:
			cshift.append(Vector2(p.x, p.y - r))
		draw_polygon(cshift, Proc.grad_fill(cshift, col["base"].darkened(0.2), cav_col))
		# druzy lining: the tiny inner shards
		if open > 0.1:
			for s in shards:
				var sh: Dictionary = s.duplicate()
				sh["h"] = float(s["h"]) * open
				_draw_druzy(sh, gg, r, col["lt"], col["base"], col["rim"])
		# a glint across the cavity
		if open > 0.3:
			draw_circle(Vector2(-r * 0.2, -r * 1.2), r * 0.1, Color(1, 1, 1, 0.5 * open))

	func _draw_druzy(s: Dictionary, gg: float, r: float, lt: Color, base: Color, rim: Color) -> void:
		var em := float(s["emerge"])
		var lg := clampf((gg - em) / max(0.001, 1.0 - em), 0.0, 1.0)
		if lg <= 0.01:
			return
		var dx := float(s["dx"])
		var cy := float(s.get("cy", -r)) - r * 0.2
		var h := float(s["h"]) * lg
		var w := float(s["w"])
		var lean := float(s["lean"])
		var tip := Vector2(dx + lean * h, cy - h)
		var poly := PackedVector2Array([
			Vector2(dx - w, cy), Vector2(dx - w * 0.6, cy - h * 0.6),
			tip, Vector2(dx + w * 0.6, cy - h * 0.6), Vector2(dx + w, cy)])
		draw_polygon(poly, Proc.grad_fill(poly, lt, base))
		draw_circle(tip, max(0.9, w * 0.3), Color(1, 1, 1, 0.75))

# ---- per-species crystal grow pacing & colours ----------------------------

static func _c_grow_minutes(species: String) -> float:
	match species:
		"geode": return 8.0
		"iceshard": return 5.0
		_: return 6.0

static func _crystal_colors(species: String, seedv: int, ctx: Dictionary) -> Dictionary:
	var jh := Proc.rangef(seedv, "cjh", -0.025, 0.025)
	var h := 0.5
	var s := 0.55
	var v := 0.95
	var glow_strength := 0.8
	var alpha := 1.0
	var shell := Color(0.42, 0.38, 0.34)
	match species:
		"crystal":     h = 0.5;  s = 0.55; v = 0.95; glow_strength = 0.85
		"crystalpink": h = 0.9;  s = 0.5;  v = 0.98; glow_strength = 0.9
		"iceshard":    h = 0.55; s = 0.22; v = 1.0;  glow_strength = 0.7; alpha = 0.82
		"gem":         h = 0.0;  s = 0.6;  v = 0.9;  glow_strength = 0.8
		"geode":       h = 0.78; s = 0.5;  v = 0.9;  glow_strength = 0.6
		"amethyst":    h = 0.76; s = 0.55; v = 0.92; glow_strength = 0.8
		"quartz":      h = 0.0;  s = 0.03; v = 1.0;  glow_strength = 0.5
		"emerald":     h = 0.4;  s = 0.6;  v = 0.85; glow_strength = 0.8
		"ruby":        h = 0.98; s = 0.72; v = 0.85; glow_strength = 0.85
		"obsidian":    h = 0.72; s = 0.35; v = 0.2;  glow_strength = 0.25
		"sapphire":    h = 0.62; s = 0.72; v = 0.82; glow_strength = 0.85
		"topaz":       h = 0.12; s = 0.62; v = 0.95; glow_strength = 0.75
	h = fposmod(h + jh, 1.0)
	var base := Color.from_hsv(h, min(1.0, s + 0.18), v * 0.5)
	var lt := Color.from_hsv(h, s * 0.72, min(1.0, v + 0.05))
	var core := Color.from_hsv(h, s * 0.45, min(1.0, v + 0.1))
	var facet := Color.from_hsv(h, s * 0.3, min(1.0, v + 0.15))
	var rim := Color.from_hsv(h, s * 0.2, min(1.0, v + 0.2))
	base.a = alpha
	lt.a = alpha
	# context palette drift (gentle — crystals keep their jewel identity)
	base = ProcFungiCrystals._drift(base, ctx, 0.14)
	lt = ProcFungiCrystals._drift(lt, ctx, 0.12)
	return {
		"base": base, "lt": lt, "core": core, "facet": facet, "rim": rim,
		"shell": shell,
		"glow": Color.from_hsv(h, min(1.0, s + 0.1), 1.0),
		"glow_strength": glow_strength,
	}

# GPU shimmer: a travelling diagonal glint + gentle pulse, desynced per instance
# via the `phase` uniform. Cheap (no CPU per-frame work; driven by shader TIME).
const _SHIMMER_CODE := """
shader_type canvas_item;
uniform float phase = 0.0;
uniform float glint = 0.6;
uniform float pulse_amt = 0.12;
void fragment() {
	float d = (FRAGCOORD.x * 0.7 + FRAGCOORD.y) * 0.02;
	float band = sin(d - TIME * 1.1 + phase);
	band = smoothstep(0.82, 1.0, band);
	float band2 = sin(d * 2.3 + TIME * 0.7 + phase * 1.7);
	band2 = smoothstep(0.9, 1.0, band2);
	vec3 add = vec3(band * glint + band2 * glint * 0.65);
	COLOR.rgb += add * COLOR.a;
	float pulse = 1.0 + pulse_amt * sin(TIME * 0.9 + phase);
	COLOR.rgb *= pulse;
}
"""
