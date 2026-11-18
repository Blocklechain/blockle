class_name ProcEffects
extends RefCounted
# ProcEffects — transient, procedural FEEDBACK EFFECTS for Blockle Idle.
#
# These are the little bursts of life the world throws off when the player (or the
# world itself) does something: planting a seed, a thing levelling up, harvesting a
# grove, selecting something, tapping the ground, a resource floating home, and the
# grand bloom when a whole new world is born. Everything is synthesised from math
# (CONVENTIONS.md) — no textures, no imported images: soft motes, sparkles, light
# rings, petals and glints are all drawn from circles, arcs, stars and smooth loops.
#
# They differ from the standing world modules in one way only: they are TRANSIENT.
# A standing tree grows forever and lives; an effect is born, plays once over a
# fraction of a second (or loops, for a selection halo) and then auto-frees. So here
# `growth ∈ [0,1]` is re-cast as the effect's LIFE TIMELINE: 0 = just sparked,
# 1 = fully played-out and gone. Every `_draw` renders a believable frame of that
# timeline for any value in [0,1] (a fresh flash at 0.05, a wide fading ring at 0.9),
# eased through g() — so the brief's "render any growth in [0,1]" still holds, it is
# just a fast, one-shot timeline instead of a slow eternal one. The base disables the
# slow world grow-rate and drives the timeline from its own `life` clock, then frees
# itself (short-lived + auto-free, per the brief). A looping halo never frees until
# you call fade_out().
#
# Animation is CHEAP (CONVENTIONS rule 5/6): particle descriptors are seeded and
# precomputed once in _on_built; every frame the motion/alpha/size of each is a pure
# analytic function of the life parameter `u` (no per-frame allocation of the heavy
# arrays), and the glow layer is additive-blended on the GPU. Because effects are few
# and short, immediate-mode redraw each frame is affordable.
#
# Module shape per CONVENTIONS: `class_name ProcEffects extends RefCounted` with
# static factory functions returning ProcNode subclasses defined below. A world /
# interaction builder places the returned node at the event location and adds it to
# the world; it tears itself down. Colours come from GameData (resources / realms)
# or an explicit colour, never hardcoded balance.
#
# ---------------------------------------------------------------------------
# PUBLIC FACTORY FUNCTIONS (signatures)
# ---------------------------------------------------------------------------
#   make(world_seed, key, kind:="puff", opts:={})           -> ProcNode  (dispatcher)
#   make_puff(world_seed, key, opts:={})                    -> ProcNode  (spawn/plant)
#   make_growth_sparkle(world_seed, key, opts:={})          -> ProcNode  (level-up)
#   make_harvest_burst(world_seed, key, opts:={})           -> ProcNode  (collect)
#   make_selection_ring(world_seed, key, opts:={})          -> ProcNode  (looping halo)
#   make_tap_ripple(world_seed, key, opts:={})              -> ProcNode  (gentle tap)
#   make_pickup_float(world_seed, key, resource_id:="essence", amount:=1.0, opts:={}) -> ProcNode
#   make_world_birth(world_seed, key, opts:={})             -> ProcNode  (new game bloom)
#
# Common opts (all optional): scale:float, radius:float, life:float, color:Color|hex,
#   colors:Array[Color|hex], resource:String (resource id), realm:String (realm id),
#   palette:Dictionary (a Proc.palette), material:String (puff flavour: plant/stone/
#   crystal/water/light/fungus/wood), ground:bool (lay flat as a ground ellipse),
#   strength:float, style:String, z:int.
#
# Selection ring extras: style ∈ {"glow","rune","bloom","dashed"}, and the returned
#   node exposes fade_out(dur:=0.35) to dismiss it gracefully.

# ===========================================================================
# DEFAULTS / DATA
# ===========================================================================

# Fallback resource colours + glyph shapes (mirrors data/resources.json so effects
# still look right if GameData hasn't loaded). GameData wins when present.
const _RES_FALLBACK := {
	"essence":  { "color": "#7FE3B0", "shape": "spark" },
	"timber":   { "color": "#C9955B", "shape": "log" },
	"stone":    { "color": "#9AA3AD", "shape": "block" },
	"crystal":  { "color": "#8FB8FF", "shape": "gem" },
	"stardust": { "color": "#C79BFF", "shape": "star" },
	"relics":   { "color": "#FFC978", "shape": "rune" },
}

# A gentle warm "magic" default when nothing is specified.
const _GOLD := Color(1.0, 0.90, 0.62, 1.0)
const _GOLD_HI := Color(1.0, 0.98, 0.86, 1.0)

# ===========================================================================
# PUBLIC FACTORIES
# ===========================================================================

static func make(world_seed: int, key: String, kind: String = "puff", opts: Dictionary = {}) -> ProcNode:
	match kind:
		"sparkle", "growth", "levelup", "grow":
			return make_growth_sparkle(world_seed, key, opts)
		"harvest", "burst", "collect", "pluck":
			return make_harvest_burst(world_seed, key, opts)
		"ring", "halo", "select", "selection":
			return make_selection_ring(world_seed, key, opts)
		"ripple", "tap", "touch":
			return make_tap_ripple(world_seed, key, opts)
		"pickup", "float", "resource":
			return make_pickup_float(world_seed, key, String(opts.get("resource", "essence")),
				float(opts.get("amount", 1.0)), opts)
		"birth", "worldbirth", "world_birth", "genesis", "bloom_world":
			return make_world_birth(world_seed, key, opts)
		_:
			return make_puff(world_seed, key, opts)


# A soft poof of particles for spawning / planting. `material` flavours the flecks
# (green pollen + leaf for plants, dust + pebbles for stone, droplets for water, …).
static func make_puff(world_seed: int, key: String, opts: Dictionary = {}) -> ProcNode:
	var n := _Puff.new()
	_apply_common(n, world_seed, key, opts)
	n.material_kind = String(opts.get("material", "plant"))
	n.life = float(opts.get("life", 0.9))
	n.spread = float(opts.get("radius", 46.0)) * n.escale
	return n


# A twinkling upward shower + flash ring when a thing levels up / is nurtured.
static func make_growth_sparkle(world_seed: int, key: String, opts: Dictionary = {}) -> ProcNode:
	var n := _Sparkle.new()
	_apply_common(n, world_seed, key, opts)
	n.life = float(opts.get("life", 1.2))
	n.rise = float(opts.get("rise", 80.0)) * n.escale
	n.ring_r = float(opts.get("radius", 60.0)) * n.escale
	return n


# A radial burst of resource-coloured motes with streaks + a flash, for harvest /
# collect. Pass `resource` (or `color`) to tint it to what was gathered.
static func make_harvest_burst(world_seed: int, key: String, opts: Dictionary = {}) -> ProcNode:
	var n := _Burst.new()
	_apply_common(n, world_seed, key, opts)
	n.life = float(opts.get("life", 0.72))
	n.reach = float(opts.get("radius", 70.0)) * n.escale
	return n


# A soft glowing halo/selection ring for the diegetic action bubble — LOOPS until
# fade_out() is called. `style` ∈ glow|rune|bloom|dashed. `ground` lays it flat.
static func make_selection_ring(world_seed: int, key: String, opts: Dictionary = {}) -> ProcNode:
	var n := _Halo.new()
	_apply_common(n, world_seed, key, opts)
	n.looped = true
	n.style = String(opts.get("style", "rune"))
	n.ring_r = float(opts.get("radius", 54.0)) * n.escale
	n.ground = bool(opts.get("ground", true))
	n.z_index = int(opts.get("z", -1))
	return n


# Concentric ground ripples that expand and fade — a light touch on the land.
static func make_tap_ripple(world_seed: int, key: String, opts: Dictionary = {}) -> ProcNode:
	var n := _Ripple.new()
	_apply_common(n, world_seed, key, opts)
	n.life = float(opts.get("life", 0.75))
	n.reach = float(opts.get("radius", 64.0)) * n.escale
	n.ground = bool(opts.get("ground", true))
	n.rings = int(opts.get("rings", 3))
	return n


# A resource orb that floats up and fades, shaped + coloured by the resource, with a
# trailing comet of sparkles. `amount` gently sizes it / adds trailing sparkles.
static func make_pickup_float(world_seed: int, key: String, resource_id: String = "essence", amount: float = 1.0, opts: Dictionary = {}) -> ProcNode:
	var n := _Pickup.new()
	_apply_common(n, world_seed, key, opts)
	var info := _res_info(resource_id)
	n.glyph_shape = String(opts.get("shape", info["shape"]))
	# resource colour wins unless an explicit colour was handed in
	if not (opts.has("color") or opts.has("colors")):
		var rc: Color = info["color"]
		n.cols = [rc, rc.lightened(0.35), Color(1, 1, 1, 1)]
	n.amount = maxf(0.1, amount)
	n.life = float(opts.get("life", 1.15))
	n.rise = float(opts.get("rise", 78.0)) * n.escale
	return n


# The grand one-shot bloom of light, rings, rays, petals and a mote-shower used when
# a brand new world is seeded. `radius` sizes the whole burst to fill the view.
static func make_world_birth(world_seed: int, key: String, opts: Dictionary = {}) -> ProcNode:
	var n := _WorldBirth.new()
	_apply_common(n, world_seed, key, opts)
	n.life = float(opts.get("life", 2.7))
	n.reach = float(opts.get("radius", 520.0)) * n.escale
	n.z_index = int(opts.get("z", 40))
	return n


# ===========================================================================
# SHARED SET-UP
# ===========================================================================

static func _apply_common(n: _Fx, world_seed: int, key: String, opts: Dictionary) -> void:
	n.seedv = hash("%d:%s" % [world_seed, key])
	n.wseed = world_seed
	n.fkey = key
	n.escale = float(opts.get("scale", 1.0))
	n.strength = float(opts.get("strength", 1.0))
	if opts.has("z"):
		n.z_index = int(opts["z"])
	else:
		n.z_index = 20
	n.cols = _resolve_cols(world_seed, key, opts)
	if opts.has("life"):
		n.life = float(opts["life"])


# Resolve the effect's colour set from (in priority order): explicit colors / color,
# a resource id, a supplied palette dict, a realm id, else a seeded world palette.
static func _resolve_cols(world_seed: int, key: String, opts: Dictionary) -> Array:
	var out: Array = []
	if opts.has("colors") and opts["colors"] is Array:
		for v in opts["colors"]:
			out.append(_as_color(v, _GOLD))
	elif opts.has("color"):
		var c := _as_color(opts["color"], _GOLD)
		out = [c, c.lightened(0.3), _GOLD_HI]
	elif opts.has("resource"):
		var rc: Color = _res_info(String(opts["resource"]))["color"]
		out = [rc, rc.lightened(0.35), Color(1, 1, 1, 1)]
	elif opts.has("palette") and opts["palette"] is Dictionary:
		var p: Dictionary = opts["palette"]
		out = [
			_pick_col(p, "accent", _GOLD),
			_pick_col(p, "base_lt", _GOLD_HI),
			_pick_col(p, "base", _GOLD),
		]
	elif opts.has("realm"):
		out = _realm_cols(String(opts["realm"]))
	if out.is_empty():
		var pal := Proc.palette(world_seed, "fx:" + key)
		out = [pal["accent"], pal["base_lt"], pal["base"]]
	# always end on a bright near-white sparkle colour for glints
	out.append(Color(1, 1, 1, 1))
	return out


static func _pick_col(p: Dictionary, k: String, fb: Color) -> Color:
	if p.has(k) and p[k] is Color:
		return p[k]
	return fb


static func _realm_cols(realm_id: String) -> Array:
	var gd = _gamedata()
	if gd != null and gd.realms_by_id is Dictionary and gd.realms_by_id.has(realm_id):
		var r = gd.realms_by_id[realm_id]
		if typeof(r) == TYPE_DICTIONARY:
			var acc := _as_color(r.get("accent", "#FFE6A0"), _GOLD)
			var sky = r.get("sky", [])
			var lt := _GOLD_HI
			if sky is Array and sky.size() > 0:
				lt = _as_color(sky[sky.size() - 1], _GOLD_HI)
			return [acc, lt, acc.lightened(0.2)]
	return []


static func _res_info(id: String) -> Dictionary:
	var gd = _gamedata()
	if gd != null and gd.resources_by_id is Dictionary and gd.resources_by_id.has(id):
		var r = gd.resources_by_id[id]
		if typeof(r) == TYPE_DICTIONARY:
			return {
				"color": _as_color(r.get("color", "#FFE6A0"), _GOLD),
				"shape": String(r.get("shape", "spark")),
			}
	if _RES_FALLBACK.has(id):
		var f: Dictionary = _RES_FALLBACK[id]
		return { "color": Color(f["color"]), "shape": f["shape"] }
	return { "color": _GOLD, "shape": "spark" }


static func _gamedata():
	# GameData is an autoload; guard in case an effect is built in isolation/tests.
	if typeof(GameData) == TYPE_OBJECT:
		return GameData
	return null


static func _as_color(v, fallback: Color) -> Color:
	if v is Color:
		return v
	if v is String:
		var s := String(v)
		if s.length() >= 4:
			return Color(s)
	return fallback


# ===========================================================================
# ADDITIVE GLOW LAYER  (a child whose _draw delegates back to the owner)
# ===========================================================================

class _FxAdd extends Node2D:
	var owner_fx                     # _Fx
	func _ready() -> void:
		var m := CanvasItemMaterial.new()
		m.blend_mode = CanvasItemMaterial.BLEND_MODE_ADD
		material = m
	func _draw() -> void:
		if owner_fx != null and is_instance_valid(owner_fx):
			owner_fx._draw_add(self)


# ===========================================================================
# BASE TRANSIENT EFFECT
# ===========================================================================

class _Fx extends ProcNode:
	var wseed: int = 0
	var fkey: String = "fx"
	var cols: Array = []             # [primary, light, deep, white]
	var escale: float = 1.0          # external scale multiplier
	var strength: float = 1.0
	var life: float = 1.0            # seconds the one-shot timeline runs
	var looped: bool = false         # true for the selection halo (never auto-frees)
	var auto_free: bool = true
	var parts: Array = []            # precomputed particle descriptors (no per-frame alloc)

	var _add: _FxAdd
	var _dying: bool = false
	var _die_t: float = 0.0
	var _die_dur: float = 0.35

	func _on_built() -> void:
		# Transient effects opt OUT of the slow world grow-rate; they drive their own
		# fast life timeline and redraw every frame while alive.
		grow_rate = 0.0
		animate_draw = true
		if cols.is_empty():
			cols = [ProcEffects._GOLD, Color(1, 1, 1, 1), ProcEffects._GOLD, Color(1, 1, 1, 1)]
		_add = _FxAdd.new()
		_add.owner_fx = self
		add_child(_add)
		_build()

	# --- life timeline -------------------------------------------------------
	func life_u() -> float:
		if looped:
			return 1.0
		return clampf(t / maxf(0.0001, life), 0.0, 1.0)

	func _animate(delta: float) -> void:
		if not looped:
			growth = life_u()
		if _add:
			_add.queue_redraw()
		if _dying:
			_die_t += delta
			var k := clampf(_die_t / _die_dur, 0.0, 1.0)
			modulate.a = 1.0 - k * k
			if k >= 1.0:
				queue_free()
			return
		_fx_animate(delta)
		if not looped and auto_free and t >= life:
			queue_free()

	# Dismiss a looping effect (or hurry any effect off) with a soft fade.
	func fade_out(dur: float = 0.35) -> void:
		if _dying:
			return
		_dying = true
		_die_dur = maxf(0.05, dur)
		_die_t = 0.0

	# Subclasses override these.
	func _build() -> void: pass           # precompute seeded particles once
	func _fx_animate(_delta: float) -> void: pass
	func _draw_add(_c: CanvasItem) -> void: pass    # additive / glow content

	# --- colour helpers ------------------------------------------------------
	func col(i: int) -> Color:
		if cols.is_empty():
			return Color(1, 1, 1, 1)
		return cols[clampi(i, 0, cols.size() - 1)]
	func c_primary() -> Color: return col(0)
	func c_light() -> Color: return col(1)
	func c_deep() -> Color: return col(2)
	func c_white() -> Color: return cols[cols.size() - 1] if not cols.is_empty() else Color(1, 1, 1, 1)

	# --- reusable procedural drawing primitives ------------------------------

	# A soft glowing dot: a few stacked translucent discs + a bright pip.
	func draw_soft(c: CanvasItem, pos: Vector2, r: float, color: Color, layers: int = 4) -> void:
		if r <= 0.2 or color.a <= 0.003:
			return
		for i in range(layers):
			var ti := float(i) / float(maxi(1, layers - 1))
			var rr: float = lerp(r, r * 0.18, ti)
			var aa: float = lerp(color.a * 0.12, color.a * 0.6, ti)
			c.draw_circle(pos, rr, Color(color.r, color.g, color.b, aa))
		c.draw_circle(pos, r * 0.2, Color(1, 1, 1, min(1.0, color.a * 0.9)))

	# A sparkle / star glint: a soft halo + a tapered N-point star + white core.
	func draw_glint(c: CanvasItem, pos: Vector2, r: float, color: Color, rot: float = 0.0, spikes: int = 4) -> void:
		if r <= 0.2 or color.a <= 0.003:
			return
		c.draw_circle(pos, r * 0.95, Color(color.r, color.g, color.b, color.a * 0.22))
		var pts := PackedVector2Array()
		var n := spikes * 2
		for i in range(n):
			var a := rot + TAU * float(i) / float(n)
			var rad: float = r if (i % 2 == 0) else r * 0.3
			pts.append(pos + Vector2(cos(a), sin(a)) * rad)
		c.draw_colored_polygon(pts, Color(color.r, color.g, color.b, color.a))
		c.draw_circle(pos, r * 0.26, Color(1, 1, 1, min(1.0, color.a * 1.2)))

	# A closed ellipse outline (ground-squashable) as an antialiased polyline.
	func draw_ring(c: CanvasItem, rx: float, ry: float, color: Color, width: float, center: Vector2 = Vector2.ZERO, steps: int = 56) -> void:
		if rx <= 0.5 or color.a <= 0.003:
			return
		var pts := PackedVector2Array()
		for i in range(steps + 1):
			var a := TAU * float(i) / float(steps)
			pts.append(center + Vector2(cos(a) * rx, sin(a) * ry))
		c.draw_polyline(pts, color, maxf(1.0, width), true)

	# A filled soft ellipse glow (stacked for a feathered edge).
	func draw_fill_ellipse(c: CanvasItem, rx: float, ry: float, color: Color, center: Vector2 = Vector2.ZERO, steps: int = 30) -> void:
		if rx <= 0.5 or color.a <= 0.003:
			return
		var pts := PackedVector2Array()
		for i in range(steps):
			var a := TAU * float(i) / float(steps)
			pts.append(center + Vector2(cos(a) * rx, sin(a) * ry))
		c.draw_colored_polygon(pts, color)

	# A resource / keepsake glyph by shape name.
	func draw_glyph(c: CanvasItem, pos: Vector2, r: float, shape: String, color: Color, rot: float = 0.0) -> void:
		if r <= 0.5 or color.a <= 0.003:
			return
		# soft aura behind every glyph
		c.draw_circle(pos, r * 1.5, Color(color.r, color.g, color.b, color.a * 0.2))
		match shape:
			"spark":
				draw_glint(c, pos, r * 1.15, color, rot, 4)
			"star":
				draw_glint(c, pos, r * 1.15, color, rot, 5)
			"gem":
				var d := PackedVector2Array([
					pos + Vector2(0, -r), pos + Vector2(r * 0.72, -r * 0.2),
					pos + Vector2(0, r), pos + Vector2(-r * 0.72, -r * 0.2)])
				c.draw_colored_polygon(d, color)
				c.draw_line(pos + Vector2(-r * 0.72, -r * 0.2), pos + Vector2(r * 0.72, -r * 0.2),
					Color(1, 1, 1, color.a * 0.6), 1.2, true)
				c.draw_circle(pos + Vector2(-r * 0.18, -r * 0.3), r * 0.18, Color(1, 1, 1, color.a))
			"block":
				var sq := Proc.superellipse(r * 0.85, r * 0.85, 3.4, 20)
				var sp := PackedVector2Array()
				for p in sq:
					sp.append(pos + p.rotated(rot * 0.2))
				c.draw_colored_polygon(sp, color)
				c.draw_circle(pos + Vector2(-r * 0.25, -r * 0.3), r * 0.22, Color(1, 1, 1, color.a * 0.8))
			"log":
				var cap := Proc.superellipse(r * 1.05, r * 0.5, 4.5, 22)
				var lp := PackedVector2Array()
				for p in cap:
					lp.append(pos + p.rotated(rot * 0.3 - 0.4))
				c.draw_colored_polygon(lp, color)
				c.draw_circle(pos, r * 0.2, Color(color.r, color.g, color.b, color.a).darkened(0.3))
			"rune":
				c.draw_circle(pos, r * 0.8, Color(color.r, color.g, color.b, color.a * 0.4))
				draw_ring(c, r * 0.8, r * 0.8, color, 2.0, pos, 24)
				for i in range(3):
					var a := rot + TAU * float(i) / 3.0
					c.draw_line(pos, pos + Vector2(cos(a), sin(a)) * r * 0.8,
						Color(1, 1, 1, color.a * 0.8), 1.4, true)
				c.draw_circle(pos, r * 0.16, Color(1, 1, 1, color.a))
			_:
				draw_soft(c, pos, r, color, 4)


# ===========================================================================
# PUFF  — a soft poof when something is planted / spawned
# ===========================================================================

class _Puff extends _Fx:
	var material_kind: String = "plant"
	var spread: float = 46.0

	func _build() -> void:
		z_index = 22
		# a ring of flecks biased into the upper hemisphere (they poof up + out)
		var n := 9 + int(Proc.hashf(seedv, "pc") * 6.0)
		for i in range(n):
			# bias upward: angle swept across the top ~200°, with jitter
			var base_a := -PI * 0.5 + (float(i) / float(n) - 0.5) * (PI * 1.25)
			var a := base_a + Proc.rangef(seedv, "pa%d" % i, -0.35, 0.35)
			var spd := Proc.rangef(seedv, "ps%d" % i, 0.42, 1.0) * spread
			parts.append({
				"ang": a,
				"spd": spd,
				"grav": Proc.rangef(seedv, "pg%d" % i, 0.35, 0.95) * spread * 0.9,
				"sz": Proc.rangef(seedv, "pz%d" % i, 2.4, 5.2) * escale,
				"spin": Proc.rangef(seedv, "pr%d" % i, -6.0, 6.0),
				"delay": Proc.rangef(seedv, "pd%d" % i, 0.0, 0.14),
				"hue": Proc.hashf(seedv, "ph%d" % i),
				"kind": Proc.hashf(seedv, "pk%d" % i),
			})
		# a few expanding dust rings at the base
		parts.append({ "dust": true })

	func _fleck_color(hue: float) -> Color:
		var base := c_primary()
		match material_kind:
			"plant", "fungus":
				return Color.from_hsv(fposmod(0.28 + hue * 0.12, 1.0), 0.55, 0.78)
			"stone":
				return Color(0.62, 0.60, 0.56).lerp(base, 0.15)
			"crystal":
				return c_light()
			"water":
				return Color.from_hsv(0.54, 0.4, 0.95)
			"light":
				return c_light()
			"wood":
				return Color(0.55, 0.38, 0.22)
			_:
				return base

	# NORMAL-blend content: the soft dust cloud + opaque flecks.
	func _draw() -> void:
		var u := life_u()
		if u >= 1.0:
			return
		var soil := Color(0.44, 0.36, 0.26)
		if material_kind == "crystal" or material_kind == "light":
			soil = c_light()
		# dust: a couple of expanding, fast-fading soft discs near the ground
		var dust_e: float = 1.0 - pow(1.0 - u, 2.2)
		var dust_a: float = (1.0 - u) * (1.0 - u) * 0.5 * strength
		for d in range(2):
			var rr := spread * (0.28 + 0.75 * dust_e) * (1.0 - 0.3 * d)
			var cy := -spread * 0.12 * dust_e
			draw_fill_ellipse(self, rr, rr * 0.62, Color(soil.r, soil.g, soil.b, dust_a * (1.0 - 0.4 * d)),
				Vector2(0, cy), 26)
		# flecks (leaves / pebbles / droplets) arc out and settle
		for p in parts:
			if p.has("dust"):
				continue
			var delay := float(p["delay"])
			var lu := clampf((u - delay) / maxf(0.001, 1.0 - delay), 0.0, 1.0)
			if lu <= 0.0:
				continue
			var e: float = 1.0 - pow(1.0 - lu, 2.0)
			var dir := Vector2(cos(float(p["ang"])), sin(float(p["ang"])))
			var pos := dir * float(p["spd"]) * e
			pos.y += float(p["grav"]) * lu * lu          # gravity pulls flecks down
			var env: float = min(lu * 5.0, 1.0) * (1.0 - lu)
			var fa := env * strength
			if fa <= 0.01:
				continue
			var fc := _fleck_color(float(p["hue"]))
			fc.a = fa
			var sz := float(p["sz"]) * (0.7 + 0.5 * sin(lu * PI))
			var rot := float(p["spin"]) * lu
			_draw_fleck(pos, sz, fc, rot)

	func _draw_fleck(pos: Vector2, sz: float, fc: Color, rot: float) -> void:
		match material_kind:
			"plant":
				# tiny leaf teardrop
				var leaf := PackedVector2Array([
					Vector2(0, -sz), Vector2(sz * 0.55, 0), Vector2(0, sz), Vector2(-sz * 0.55, 0)])
				var lp := PackedVector2Array()
				for q in leaf:
					lp.append(pos + q.rotated(rot))
				draw_colored_polygon(lp, fc)
			"stone":
				var pebble := Proc.superellipse(sz, sz * 0.8, 3.0, 10)
				var pp := PackedVector2Array()
				for q in pebble:
					pp.append(pos + q.rotated(rot))
				draw_colored_polygon(pp, fc)
			"water":
				# droplet
				var drop := PackedVector2Array([
					Vector2(0, -sz * 1.3), Vector2(sz * 0.7, sz * 0.4), Vector2(0, sz * 0.8), Vector2(-sz * 0.7, sz * 0.4)])
				var dp := PackedVector2Array()
				for q in drop:
					dp.append(pos + q.rotated(rot * 0.3))
				draw_colored_polygon(dp, fc)
			_:
				draw_circle(pos, sz * 0.7, fc)

	# ADDITIVE content: the opening flash + glinty sparkle flecks for shiny kinds.
	func _draw_add(c: CanvasItem) -> void:
		var u := life_u()
		if u >= 1.0:
			return
		# a soft opening flash
		var fa: float = pow(1.0 - clampf(u / 0.3, 0.0, 1.0), 2.0) * 0.55 * strength
		if fa > 0.01:
			draw_soft(c, Vector2(0, -spread * 0.1), spread * 0.8, Color(c_light().r, c_light().g, c_light().b, fa), 5)
		if material_kind == "crystal" or material_kind == "light":
			for p in parts:
				if p.has("dust"):
					continue
				var lu := clampf((u - float(p["delay"])) / maxf(0.001, 1.0 - float(p["delay"])), 0.0, 1.0)
				if lu <= 0.0:
					continue
				var e: float = 1.0 - pow(1.0 - lu, 2.0)
				var dir := Vector2(cos(float(p["ang"])), sin(float(p["ang"])))
				var pos := dir * float(p["spd"]) * e
				pos.y += float(p["grav"]) * lu * lu * 0.5
				var env: float = min(lu * 5.0, 1.0) * (1.0 - lu)
				var gc := c_light()
				gc.a = env * strength
				draw_glint(c, pos, float(p["sz"]) * 1.1, gc, lu * 4.0, 4)


# ===========================================================================
# GROWTH SPARKLE  — a level-up / nurture shimmer
# ===========================================================================

class _Sparkle extends _Fx:
	var rise: float = 80.0
	var ring_r: float = 60.0

	func _build() -> void:
		z_index = 24
		var n := 8 + int(Proc.hashf(seedv, "sc") * 6.0)
		for i in range(n):
			parts.append({
				"x": Proc.rangef(seedv, "sx%d" % i, -ring_r * 0.6, ring_r * 0.6),
				"rise": Proc.rangef(seedv, "sr%d" % i, 0.55, 1.0) * rise,
				"sway": Proc.rangef(seedv, "sw%d" % i, 6.0, 16.0),
				"freq": Proc.rangef(seedv, "sf%d" % i, 1.2, 2.6),
				"sz": Proc.rangef(seedv, "sz%d" % i, 2.6, 5.4) * escale,
				"delay": Proc.rangef(seedv, "sd%d" % i, 0.0, 0.5),
				"twk": Proc.rangef(seedv, "st%d" % i, 6.0, 12.0),
				"ph": Proc.rangef(seedv, "sp%d" % i, 0.0, TAU),
				"spikes": 4 + int(Proc.hashf(seedv, "ss%d" % i) * 2.0),
			})

	func _draw_add(c: CanvasItem) -> void:
		var u := life_u()
		if u >= 1.0:
			return
		# flash rings expanding out from the feet
		for r in range(2):
			var rd := float(r)
			var ru := clampf((u - rd * 0.08) / 0.55, 0.0, 1.0)
			if ru <= 0.0 or ru >= 1.0:
				continue
			var e: float = 1.0 - pow(1.0 - ru, 2.5)
			var rr := ring_r * (0.2 + 0.9 * e) * (1.0 + 0.25 * rd)
			var ra: float = pow(1.0 - ru, 2.0) * 0.6 * strength
			var rc := c_light()
			draw_ring(c, rr, rr * 0.85, Color(rc.r, rc.g, rc.b, ra), 3.0 * (1.0 - ru) + 1.0, Vector2(0, -ring_r * 0.15), 48)
		# a gentle column of light rising (reads as "growing")
		var col_a: float = sin(u * PI) * 0.18 * strength
		if col_a > 0.01:
			var cw := ring_r * 0.3
			var colp := PackedVector2Array([
				Vector2(-cw, 0), Vector2(cw, 0),
				Vector2(cw * 0.4, -rise * 1.1), Vector2(-cw * 0.4, -rise * 1.1)])
			var lc := c_light()
			draw_colored_polygon(colp, Color(lc.r, lc.g, lc.b, col_a))
		# the rising twinkles
		for p in parts:
			var delay := float(p["delay"])
			var lu := clampf((u - delay) / maxf(0.001, 1.0 - delay), 0.0, 1.0)
			if lu <= 0.0:
				continue
			var e2: float = 1.0 - pow(1.0 - lu, 1.7)
			var y := -float(p["rise"]) * e2
			var x := float(p["x"]) + sin(lu * float(p["freq"]) * TAU + float(p["ph"])) * float(p["sway"])
			var env: float = sin(lu * PI)
			var twinkle: float = 0.55 + 0.45 * sin(t * float(p["twk"]) + float(p["ph"]))
			var a := env * twinkle * strength
			if a <= 0.01:
				continue
			var sc := c_primary() if (int(p["spikes"]) % 2 == 0) else c_light()
			sc.a = a
			draw_glint(c, Vector2(x, y), float(p["sz"]) * (0.7 + 0.5 * env), sc, lu * 3.0 + float(p["ph"]), int(p["spikes"]))


# ===========================================================================
# HARVEST BURST  — a radial pop of resource-coloured motes
# ===========================================================================

class _Burst extends _Fx:
	var reach: float = 70.0

	func _build() -> void:
		z_index = 24
		var n := 12 + int(Proc.hashf(seedv, "bc") * 8.0)
		for i in range(n):
			var a := TAU * float(i) / float(n) + Proc.rangef(seedv, "ba%d" % i, -0.2, 0.2)
			# bias a touch upward so it reads as "lifting off" the thing
			parts.append({
				"ang": a,
				"spd": Proc.rangef(seedv, "bs%d" % i, 0.55, 1.0) * reach,
				"sz": Proc.rangef(seedv, "bz%d" % i, 2.2, 4.6) * escale,
				"delay": Proc.rangef(seedv, "bd%d" % i, 0.0, 0.1),
				"grav": Proc.rangef(seedv, "bg%d" % i, -0.2, 0.4) * reach,
			})

	func _draw_add(c: CanvasItem) -> void:
		var u := life_u()
		if u >= 1.0:
			return
		var centre := Vector2(0, -reach * 0.1)
		# central flash
		var fa: float = pow(1.0 - clampf(u / 0.25, 0.0, 1.0), 2.0) * 0.7 * strength
		if fa > 0.01:
			draw_soft(c, centre, reach * 0.6, Color(c_white().r, c_white().g, c_white().b, fa), 5)
		# a quick expanding ring
		var ru := clampf(u / 0.5, 0.0, 1.0)
		if ru < 1.0:
			var rr := reach * (0.2 + 0.85 * (1.0 - pow(1.0 - ru, 2.0)))
			var rc := c_light()
			draw_ring(c, rr, rr, Color(rc.r, rc.g, rc.b, pow(1.0 - ru, 2.0) * 0.5 * strength), 2.5, centre, 40)
		# motes fly outward with a short trailing streak
		for p in parts:
			var lu := clampf((u - float(p["delay"])) / maxf(0.001, 1.0 - float(p["delay"])), 0.0, 1.0)
			if lu <= 0.0:
				continue
			var e: float = 1.0 - pow(1.0 - lu, 2.3)
			var dir := Vector2(cos(float(p["ang"])), sin(float(p["ang"])))
			var pos := centre + dir * float(p["spd"]) * e
			pos.y += float(p["grav"]) * lu * lu
			var env: float = (1.0 - lu)
			var a := env * strength
			if a <= 0.01:
				continue
			# streak back toward where it came from
			var tail := pos - dir * float(p["sz"]) * 2.4 * (1.0 - e)
			var mc := c_primary()
			c.draw_line(tail, pos, Color(mc.r, mc.g, mc.b, a * 0.4), maxf(1.0, float(p["sz"]) * 0.5), true)
			draw_soft(c, pos, float(p["sz"]) * (0.8 + 0.4 * env), Color(mc.r, mc.g, mc.b, a), 3)


# ===========================================================================
# SELECTION RING / HALO  — a looping glow around a selected thing
# ===========================================================================

class _Halo extends _Fx:
	var ring_r: float = 54.0
	var ground: bool = true
	var style: String = "rune"
	var ticks: int = 8

	func _build() -> void:
		ticks = 6 + int(Proc.hashf(seedv, "ht") * 6.0)

	func _squash() -> float:
		return 0.42 if ground else 1.0

	func _draw_add(c: CanvasItem) -> void:
		# fade/scale in over the first third of a second
		var appear := smoothstep(0.0, 0.32, t)
		var breathe := 0.5 + 0.5 * sin(t * 1.8 + phase)
		var sq := _squash()
		var base := c_primary()
		var lite := c_light()
		var rr := ring_r * appear * (0.97 + 0.05 * breathe)

		# soft inner fill glow
		var fill_a := (0.10 + 0.07 * breathe) * appear * strength
		draw_fill_ellipse(c, rr * 0.96, rr * 0.96 * sq, Color(base.r, base.g, base.b, fill_a), Vector2.ZERO, 32)

		match style:
			"glow":
				draw_ring(c, rr, rr * sq, Color(lite.r, lite.g, lite.b, (0.6 + 0.3 * breathe) * appear), 3.5, Vector2.ZERO, 64)
				draw_ring(c, rr * 0.82, rr * 0.82 * sq, Color(base.r, base.g, base.b, 0.35 * appear), 2.0, Vector2.ZERO, 56)
			"bloom":
				draw_ring(c, rr, rr * sq, Color(lite.r, lite.g, lite.b, 0.5 * appear), 2.5, Vector2.ZERO, 64)
				var petals := ticks
				for i in range(petals):
					var a := t * 0.4 + TAU * float(i) / float(petals)
					var pc := Vector2(cos(a) * rr, sin(a) * rr * sq)
					var pscale := 0.7 + 0.3 * sin(t * 2.0 + float(i))
					_draw_petal(c, pc, a, ring_r * 0.26 * pscale * appear, Color(lite.r, lite.g, lite.b, 0.5 * appear))
			"dashed":
				var dn := ticks * 2
				for i in range(dn):
					if i % 2 == 1:
						continue
					var a0 := t * 0.5 + TAU * float(i) / float(dn)
					var a1 := a0 + TAU / float(dn) * 0.8
					var seg := PackedVector2Array()
					for s in range(5):
						var aa: float = lerp(a0, a1, float(s) / 4.0)
						seg.append(Vector2(cos(aa) * rr, sin(aa) * rr * sq))
					c.draw_polyline(seg, Color(lite.r, lite.g, lite.b, (0.65 + 0.25 * breathe) * appear), 3.0, true)
			_:  # "rune": a smooth ring with orbiting glint ticks
				draw_ring(c, rr, rr * sq, Color(lite.r, lite.g, lite.b, (0.55 + 0.3 * breathe) * appear), 2.6, Vector2.ZERO, 64)
				for i in range(ticks):
					var a := t * 0.6 + TAU * float(i) / float(ticks)
					var tp := Vector2(cos(a) * rr, sin(a) * rr * sq)
					var tw := 0.5 + 0.5 * sin(t * 3.0 + float(i) * 1.7)
					var gc := c_primary()
					gc.a = (0.4 + 0.5 * tw) * appear * strength
					draw_glint(c, tp, ring_r * 0.09 * (0.7 + 0.5 * tw) * appear, gc, a, 4)

	func _draw_petal(c: CanvasItem, pos: Vector2, ang: float, r: float, color: Color) -> void:
		var pet := PackedVector2Array([
			Vector2(0, 0), Vector2(r * 0.4, -r * 0.5), Vector2(0, -r), Vector2(-r * 0.4, -r * 0.5)])
		var pp := PackedVector2Array()
		for q in pet:
			pp.append(pos + q.rotated(ang + PI * 0.5))
		c.draw_colored_polygon(pp, color)


# ===========================================================================
# TAP RIPPLE  — concentric ground rings radiating from a touch
# ===========================================================================

class _Ripple extends _Fx:
	var reach: float = 64.0
	var ground: bool = true
	var rings: int = 3

	func _build() -> void:
		z_index = 18

	func _squash() -> float:
		return 0.4 if ground else 1.0

	func _draw_add(c: CanvasItem) -> void:
		var u := life_u()
		if u >= 1.0:
			return
		var sq := _squash()
		var base := c_light()
		# a soft initial splash dot
		var sa: float = pow(1.0 - clampf(u / 0.25, 0.0, 1.0), 2.0) * 0.4 * strength
		if sa > 0.01:
			draw_fill_ellipse(c, reach * 0.3, reach * 0.3 * sq, Color(base.r, base.g, base.b, sa), Vector2.ZERO, 24)
		for i in range(rings):
			var stagger := float(i) * 0.14
			var lu := clampf((u - stagger) / maxf(0.001, 1.0 - stagger), 0.0, 1.0)
			if lu <= 0.0 or lu >= 1.0:
				continue
			var e: float = 1.0 - pow(1.0 - lu, 2.0)
			var rr := reach * (0.12 + 0.95 * e)
			var a: float = pow(1.0 - lu, 1.6) * 0.6 * strength
			var w := maxf(1.0, 3.2 * (1.0 - lu))
			draw_ring(c, rr, rr * sq, Color(base.r, base.g, base.b, a), w, Vector2.ZERO, 52)


# ===========================================================================
# PICKUP FLOAT  — a resource orb rising + fading with a sparkle trail
# ===========================================================================

class _Pickup extends _Fx:
	var glyph_shape: String = "spark"
	var amount: float = 1.0
	var rise: float = 78.0
	var _trail: Array = []

	func _build() -> void:
		z_index = 26
		var r := 10.0 * escale * (0.85 + clampf(log(amount + 1.0) * 0.18, 0.0, 0.7))
		set_meta("r", r)
		var tn := 3 + int(clampf(amount, 1.0, 5.0))
		for i in range(tn):
			_trail.append({
				"lag": Proc.rangef(seedv, "tl%d" % i, 0.06, 0.26),
				"ox": Proc.rangef(seedv, "tx%d" % i, -6.0, 6.0) * escale,
				"sz": Proc.rangef(seedv, "tz%d" % i, 1.6, 3.2) * escale,
				"ph": Proc.rangef(seedv, "tp%d" % i, 0.0, TAU),
			})

	func _pos_at(lu: float) -> Vector2:
		var e: float = 1.0 - pow(1.0 - clampf(lu, 0.0, 1.0), 1.8)
		var y := -rise * e
		var x := sin(clampf(lu, 0.0, 1.0) * 2.4 + phase) * 7.0 * escale
		return Vector2(x, y)

	func _draw_add(c: CanvasItem) -> void:
		var u := life_u()
		if u >= 1.0:
			return
		var r: float = get_meta("r", 10.0)
		# alpha: fade in fast, hold, fade out near the top
		var a := clampf(u / 0.12, 0.0, 1.0) * clampf((1.0 - u) / 0.4, 0.0, 1.0)
		a *= strength
		# scale: a little pop on arrival then settle
		var pop := 1.0 + 0.3 * pow(1.0 - clampf(u / 0.2, 0.0, 1.0), 2.0)
		var pos := _pos_at(u)

		# trailing sparkles lag behind the orb
		var mc := c_primary()
		for tr in _trail:
			var tu := u - float(tr["lag"])
			if tu <= 0.0:
				continue
			var tp := _pos_at(tu) + Vector2(float(tr["ox"]), 0)
			var ta := a * 0.6 * (0.5 + 0.5 * sin(t * 10.0 + float(tr["ph"])))
			draw_soft(c, tp, float(tr["sz"]) * (0.8 + 0.4 * sin(t * 6.0 + float(tr["ph"]))),
				Color(mc.r, mc.g, mc.b, ta), 3)

		# the resource glyph itself
		var gc := c_primary()
		gc.a = a
		draw_glyph(c, pos, r * pop, glyph_shape, gc, t * 1.5 + phase)


# ===========================================================================
# WORLD BIRTH  — the grand one-shot bloom for a newly-seeded world
# ===========================================================================

class _WorldBirth extends _Fx:
	var reach: float = 520.0
	var _motes: Array = []
	var _petals: Array = []
	var _rays: int = 12

	func _build() -> void:
		z_index = 40
		_rays = 10 + int(Proc.hashf(seedv, "wr") * 8.0)
		# an outward-drifting, twinkling mote shower in the world's own colours
		var n := 40 + int(Proc.hashf(seedv, "wc") * 24.0)
		for i in range(n):
			var a := Proc.rangef(seedv, "wa%d" % i, 0.0, TAU)
			_motes.append({
				"ang": a,
				"dist": Proc.rangef(seedv, "wd%d" % i, 0.25, 1.0) * reach,
				"sz": Proc.rangef(seedv, "wz%d" % i, 2.0, 6.0) * escale,
				"delay": Proc.rangef(seedv, "wy%d" % i, 0.0, 0.5),
				"rise": Proc.rangef(seedv, "wv%d" % i, -0.3, 0.1) * reach,
				"twk": Proc.rangef(seedv, "wt%d" % i, 5.0, 11.0),
				"ph": Proc.rangef(seedv, "wp%d" % i, 0.0, TAU),
				"hue": Proc.hashf(seedv, "wh%d" % i),
			})
		# a ring of blooming petals (the world "opening like a flower")
		var pn := 8 + int(Proc.hashf(seedv, "wpn") * 6.0)
		for i in range(pn):
			_petals.append({
				"ang": TAU * float(i) / float(pn) + Proc.rangef(seedv, "wpa%d" % i, -0.1, 0.1),
				"len": Proc.rangef(seedv, "wpl%d" % i, 0.7, 1.0) * reach * 0.42,
				"wid": Proc.rangef(seedv, "wpw%d" % i, 0.4, 0.6),
				"delay": Proc.rangef(seedv, "wpd%d" % i, 0.08, 0.3),
			})

	func _mote_color(hue: float) -> Color:
		# blend between the three palette colours by hue so the shower is cohesive
		var a := c_primary()
		var b := c_light()
		var d := c_deep()
		if hue < 0.5:
			return a.lerp(b, hue * 2.0)
		return b.lerp(d, (hue - 0.5) * 2.0)

	func _draw_add(c: CanvasItem) -> void:
		var u := life_u()
		if u >= 1.0:
			return
		var lite := c_light()
		var base := c_primary()

		# 1) the initial brilliant core flash (very front-loaded)
		var fu := clampf(u / 0.22, 0.0, 1.0)
		var fa: float = pow(1.0 - fu, 2.0) * 0.95 * strength
		if fa > 0.01:
			draw_soft(c, Vector2.ZERO, reach * (0.3 + 0.5 * fu), Color(c_white().r, c_white().g, c_white().b, fa), 7)

		# 2) several expanding light rings in sequence (waves of becoming)
		for w in range(4):
			var wu := clampf((u - float(w) * 0.1) / 0.6, 0.0, 1.0)
			if wu <= 0.0 or wu >= 1.0:
				continue
			var e: float = 1.0 - pow(1.0 - wu, 2.4)
			var rr := reach * (0.1 + 0.95 * e)
			var ra: float = pow(1.0 - wu, 1.8) * 0.5 * strength
			var rc := lite if (w % 2 == 0) else base
			draw_ring(c, rr, rr, Color(rc.r, rc.g, rc.b, ra), 4.0 * (1.0 - wu) + 1.5, Vector2.ZERO, 72)

		# 3) radiating light rays sweeping outward (grow then fade, slow rotation)
		var ray_env: float = sin(clampf(u / 0.75, 0.0, 1.0) * PI)
		if ray_env > 0.01:
			var ray_len := reach * 0.9 * (0.3 + 0.7 * clampf(u / 0.5, 0.0, 1.0))
			for i in range(_rays):
				var a := t * 0.5 + TAU * float(i) / float(_rays)
				var w := 0.5 + 0.5 * sin(t * 2.0 + float(i) * 1.3)
				var tip := Vector2(cos(a), sin(a)) * ray_len
				var perp := Vector2(-sin(a), cos(a)) * reach * 0.03 * (0.5 + w)
				var tri := PackedVector2Array([perp, -perp, tip])
				draw_colored_polygon(tri, Color(lite.r, lite.g, lite.b, 0.12 * ray_env * (0.5 + 0.5 * w) * strength))

		# 4) blooming petals opening from the centre
		for p in _petals:
			var pu := clampf((u - float(p["delay"])) / 0.55, 0.0, 1.0)
			if pu <= 0.0:
				continue
			var open := 1.0 - pow(1.0 - pu, 2.0)
			var env: float = sin(pu * PI)
			var len := float(p["len"]) * open
			var wid := len * float(p["wid"])
			var a := float(p["ang"])
			var pa := env * 0.5 * strength
			if pa <= 0.01:
				continue
			var dir := Vector2(cos(a), sin(a))
			var side := Vector2(-sin(a), cos(a))
			var pet := PackedVector2Array([
				Vector2.ZERO,
				side * wid + dir * len * 0.5,
				dir * len,
				-side * wid + dir * len * 0.5])
			var pc := base.lerp(lite, 0.5)
			draw_colored_polygon(pet, Color(pc.r, pc.g, pc.b, pa))

		# 5) the drifting, twinkling mote shower
		for m in _motes:
			var mu := clampf((u - float(m["delay"])) / maxf(0.001, 1.0 - float(m["delay"])), 0.0, 1.0)
			if mu <= 0.0:
				continue
			var e2: float = 1.0 - pow(1.0 - mu, 2.0)
			var dir := Vector2(cos(float(m["ang"])), sin(float(m["ang"])))
			var pos := dir * float(m["dist"]) * e2
			pos.y += float(m["rise"]) * mu
			var env: float = sin(mu * PI)
			var twk: float = 0.5 + 0.5 * sin(t * float(m["twk"]) + float(m["ph"]))
			var a := env * twk * strength
			if a <= 0.01:
				continue
			var mc := _mote_color(float(m["hue"]))
			mc.a = a
			draw_glint(c, pos, float(m["sz"]) * (0.6 + 0.6 * env), mc, mu * 3.0 + float(m["ph"]), 4)
