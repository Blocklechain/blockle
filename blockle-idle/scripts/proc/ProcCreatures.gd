class_name ProcCreatures extends RefCounted
# ProcCreatures — the Blocklings. The hero procedural-art module: cute, recognizable,
# storybook creatures synthesised entirely from math. No imported images, no emoji.
#
# A Blockling is a parametric little being. Its SPECIES SHAPE (sprout, fox, owlet,
# turtle, frog, deer, cat, golem, moth, star, dragon, …) chooses a set of proportions
# and which appendages it wears (ears / snout / beak / horns / shell / wings / tail /
# antennae). The SEED drives everything else — exact proportions, a cohesive colour
# set, and a full procedural TRAITS stack (hue-shift / marking / accessory / hat /
# wings / tail-style / aura) drawn directly, never stamped as overlays. Two Blocklings
# of the same species therefore never look like copies, yet a "fox" always reads foxy
# and an "owlet" always reads owly.
#
# GROWTH (ProcNode.growth in [0,1]) is a continuous baby→adult life stage: at 0 it is a
# tiny, round, big-headed, big-eyed, stubby-limbed chibi; as g() eases to 1 the head
# shrinks toward adult proportion, limbs lengthen, markings/wings/tails fill in, and
# colour deepens. Every value in between renders a believable in-between — nothing pops.
#
# ALIVE (ProcNode._animate) is all cheap child-transform animation (no per-frame
# redraw): the torso breathes with a soft squash-stretch, eyes blink, the head looks
# slowly around, ears and tail wiggle, wings flap, an aura drifts, and once in a while
# the whole creature does a little hop with an anticipation crouch. animate_draw stays
# false; geometry is rebuilt only when growth crosses ProcNode's threshold.
#
# See scripts/proc/CONVENTIONS.md + docs/IDLE-DESIGN.md. Feet-at-origin (y grows up as
# negative y); backgrounds don't apply here — a Blockling stands on the ground at 0.

# Every species shape this module can render. Unknown keys fall back to a soft critter.
const SHAPES := [
	"sprout", "mossling", "pebble", "frog", "owlet", "mole", "stickbug", "deer",
	"cat", "turtle", "fox", "golem", "bird", "moth", "mooncat", "greatdeer",
	"star", "dragon",
]

# -----------------------------------------------------------------------------
# Public factory functions
# -----------------------------------------------------------------------------

# The main entry point a world builder calls. `blockling_id` looks the creature up in
# GameData.blocklings (so its shape/profession/rarity/palette match the real entity);
# pass "" to pick a seeded species for this key. `context` carries §2.3a adaptation
# ({local_palette, light_dir, elevation, neighbours}); all keys optional.
static func make(world_seed: int, key: String, blockling_id: String = "", context: Dictionary = {}) -> ProcNode:
	var data := _lookup(blockling_id)
	if data.is_empty():
		data = _pick_species(world_seed, key)
	return from_data(world_seed, key, data, context)

# Pick a seeded random species from GameData (or the built-in table) for this key.
static func random(world_seed: int, key: String, context: Dictionary = {}) -> ProcNode:
	return from_data(world_seed, key, _pick_species(world_seed, key), context)

# Build directly from a blockling data dict ({id,name,shape,profession,rarity,palette,desc}).
static func from_data(world_seed: int, key: String, data: Dictionary, context: Dictionary = {}) -> ProcNode:
	var n := _Blockling.new()
	n.seedv = hash("%d:blockling:%s" % [world_seed, key])
	n.world_seed = world_seed
	n.keyv = key
	n.species = String(data.get("shape", "cat"))
	n.bl_id = String(data.get("id", ""))
	n.bl_name = String(data.get("name", "Blockling"))
	n.profession = String(data.get("profession", ""))
	n.rarity = String(data.get("rarity", "common"))
	n.rarity_idx = _rarity_index(n.rarity)
	n.base_palette = _parse_palette(data.get("palette", []))
	n.context = context
	n.set_grow_minutes(25.0)
	return n

# Build a bespoke creature from an explicit shape + colours (for the tray / previews /
# puzzles that aren't data entities). `opts` may override: rarity, profession, traits,
# size, grow_minutes.
static func make_shape(world_seed: int, key: String, shape: String, colors: Array = [], opts: Dictionary = {}) -> ProcNode:
	var n := _Blockling.new()
	n.seedv = hash("%d:creature:%s:%s" % [world_seed, key, shape])
	n.world_seed = world_seed
	n.keyv = key
	n.species = shape
	n.bl_name = String(opts.get("name", shape.capitalize()))
	n.profession = String(opts.get("profession", ""))
	n.rarity = String(opts.get("rarity", "common"))
	n.rarity_idx = _rarity_index(n.rarity)
	n.base_palette = _parse_palette(colors) if not colors.is_empty() else _seeded_palette(world_seed, key)
	n.trait_override = opts.get("traits", {})
	n.base_px = float(opts.get("size", 110.0))
	n.context = opts.get("context", {})
	n.set_grow_minutes(float(opts.get("grow_minutes", 25.0)))
	return n

# The species this module can draw (handy for the Tray / egg generator).
static func species_shapes() -> PackedStringArray:
	return PackedStringArray(SHAPES)

# -----------------------------------------------------------------------------
# Static helpers (data / colour / traits)
# -----------------------------------------------------------------------------

static func _lookup(id: String) -> Dictionary:
	if id == "":
		return {}
	var gd = Engine.get_singleton("GameData") if Engine.has_singleton("GameData") else null
	# GameData is an autoload; access it directly if present.
	if gd == null and _has_gamedata():
		gd = GameData
	if gd != null and gd.blocklings_by_id.has(id):
		return gd.blocklings_by_id[id]
	return {}

static func _has_gamedata() -> bool:
	return ClassDB.class_exists("GameData") or true  # autoload symbol resolved below

static func _pick_species(world_seed: int, key: String) -> Dictionary:
	# Prefer a real GameData entity so professions/rarities/palettes are authentic.
	if _gamedata_ready():
		var list: Array = GameData.blocklings
		if list.size() > 0:
			var i := int(Proc.hashf(world_seed, "pickbl:" + key) * list.size()) % list.size()
			return list[i]
	# Fallback: synthesise from the built-in shape table.
	var s: String = SHAPES[int(Proc.hashf(world_seed, "picksh:" + key) * SHAPES.size()) % SHAPES.size()]
	return {"id": "", "name": s.capitalize(), "shape": s, "profession": "", "rarity": "common",
		"palette": []}

static func _gamedata_ready() -> bool:
	# Autoload may not exist in isolated tests; guard access.
	return Engine.get_main_loop() != null and _safe_gamedata() != null

static func _safe_gamedata():
	# Access the GameData autoload safely.
	var tree := Engine.get_main_loop() as SceneTree
	if tree == null:
		return null
	var root := tree.root
	if root == null:
		return null
	if root.has_node("GameData"):
		return root.get_node("GameData")
	return null

static func _rarity_index(rarity: String) -> int:
	match rarity:
		"common": return 0
		"uncommon": return 1
		"rare": return 2
		"epic": return 3
		"legendary": return 4
		"mythic": return 5
	return 0

static func _parse_palette(arr) -> PackedColorArray:
	var out := PackedColorArray()
	if arr is Array or arr is PackedStringArray or arr is PackedColorArray:
		for c in arr:
			if c is Color:
				out.append(c)
			elif c is String:
				out.append(Color.html(c))
	return out

static func _seeded_palette(world_seed: int, key: String) -> PackedColorArray:
	var p := Proc.palette(world_seed, "creature:" + key)
	return PackedColorArray([p.base, p.accent])

# =============================================================================
# Generic layered part — draws a stack of filled + stroked smooth polygons. Every
# visible piece of a Blockling is one of these; animation moves the NODE, not the art.
# =============================================================================
class _Part extends Node2D:
	var layers: Array = []          # each: {poly, top, bot, fill, stroke, sw, close}
	var extra_circles: Array = []   # each: {c, r, col}  (cheeks / dots / shines)
	var extra_arcs: Array = []      # each: {pts, col, w}

	func set_data(ls: Array, circles: Array = [], arcs: Array = []) -> void:
		layers = ls
		extra_circles = circles
		extra_arcs = arcs
		queue_redraw()

	func _draw() -> void:
		for L in layers:
			var poly: PackedVector2Array = L["poly"]
			if poly.size() < 2:
				continue
			# A fill needs a real, simple (non-self-intersecting) area. Pre-triangulate
			# so a degenerate layer is skipped quietly (its stroke still draws) rather
			# than spamming the renderer — any smooth outline stays safe for free.
			if L.get("fill", true) and poly.size() >= 3 and not Geometry2D.triangulate_polygon(poly).is_empty():
				var top: Color = L.get("top", Color.WHITE)
				var bot: Color = L.get("bot", top)
				draw_polygon(poly, Proc.grad_fill(poly, top, bot))
			var sw: float = L.get("sw", 0.0)
			if sw > 0.0:
				var line := poly.duplicate()
				if L.get("close", true):
					line.append(poly[0])
				draw_polyline(line, L.get("stroke", Color.BLACK), sw, true)
		for a in extra_arcs:
			draw_polyline(a["pts"], a["col"], a.get("w", 2.0), true)
		for cc in extra_circles:
			draw_circle(cc["c"], cc["r"], cc["col"])

# =============================================================================
# Eye — its own node so a blink is just scale.y → ~0. Several expressive styles.
# =============================================================================
class _Eye extends Node2D:
	var r := 7.0
	var style := "round"        # round / big / sleepy / dot / star / sparkle
	var sclera := Color(1, 1, 1)
	var iris := Color(0.12, 0.12, 0.16)
	var ink := Color(0.08, 0.07, 0.1)
	var look := Vector2.ZERO    # pupil offset (gaze)
	var shine := true

	func refresh() -> void:
		queue_redraw()

	func _draw() -> void:
		match style:
			"dot":
				draw_circle(Vector2.ZERO, r * 0.78, ink)
				if shine:
					draw_circle(Vector2(-r * 0.3, -r * 0.34), r * 0.26, Color(1, 1, 1, 0.9))
			"sleepy":
				# a calm downward lash-arc with a soft fill under it
				var a := PackedVector2Array()
				for i in 15:
					var th := lerpf(PI * 0.12, PI * 0.88, float(i) / 14.0)
					a.append(Vector2(cos(th), -sin(th) * 0.55) * r)
				var fill := a.duplicate()
				fill.append(Vector2(-r * 0.9, r * 0.02))
				fill.append(Vector2(r * 0.9, r * 0.02))
				draw_colored_polygon(fill, iris.lerp(sclera, 0.25))
				draw_polyline(a, ink, maxf(1.2, r * 0.22), true)
			"star":
				_draw_star(ink, r)
				_draw_star(Color(1, 1, 1, 0.85), r * 0.45)
			_:
				# round / big / sparkle — a glossy cartoon eye
				var rr := r if style != "big" else r * 1.18
				draw_circle(Vector2.ZERO, rr + 1.4, ink)                       # outline
				draw_circle(Vector2.ZERO, rr, sclera)                          # white
				var pc := look.limit_length(rr * 0.42)
				draw_circle(pc, rr * 0.62, iris)                               # iris
				draw_circle(pc, rr * 0.30, ink)                                # pupil
				if shine:
					draw_circle(pc + Vector2(-rr * 0.3, -rr * 0.34), rr * 0.24, Color(1, 1, 1, 0.95))
					draw_circle(pc + Vector2(rr * 0.22, rr * 0.3), rr * 0.12, Color(1, 1, 1, 0.5))
				if style == "sparkle":
					draw_circle(Vector2(rr * 0.55, -rr * 0.55), rr * 0.16, Color(1, 1, 1, 0.8))

	func _draw_star(col: Color, rad: float) -> void:
		var pts := PackedVector2Array()
		for i in 10:
			var ang := -PI / 2.0 + PI * i / 5.0
			var rm := rad if i % 2 == 0 else rad * 0.44
			pts.append(Vector2(cos(ang), sin(ang)) * rm)
		draw_colored_polygon(pts, col)

# =============================================================================
# Face — cheeks, muzzle, nose, mouth, brows. Holds the two eye nodes as children so
# they draw on top of the cheeks. Reads a plain data dict assembled by the Blockling.
# =============================================================================
class _Face extends Node2D:
	var d: Dictionary = {}

	func set_face(dd: Dictionary) -> void:
		d = dd
		queue_redraw()

	func _draw() -> void:
		if d.is_empty():
			return
		var ink: Color = d.get("ink", Color(0.1, 0.09, 0.12))
		# blush cheeks
		if d.get("cheeks", true):
			var cr: float = d.get("cheek_r", 5.0)
			var ccol: Color = d.get("cheek_col", Color(1, 0.6, 0.62, 0.5))
			var cx: float = d.get("cheek_x", 16.0)
			var cy: float = d.get("cheek_y", 4.0)
			draw_circle(Vector2(-cx, cy), cr, ccol)
			draw_circle(Vector2(cx, cy), cr, ccol)
		# muzzle / beak
		match String(d.get("muzzle", "none")):
			"snout":
				var sw2: float = d.get("sw", 2.0)
				var mc: Color = d.get("muzzle_col", Color(1, 1, 1))
				var m: PackedVector2Array = d.get("snout_poly", PackedVector2Array())
				if m.size() > 2:
					draw_colored_polygon(m, mc)
					var ml := m.duplicate(); ml.append(m[0])
					draw_polyline(ml, ink, sw2 * 0.8, true)
				var np: Vector2 = d.get("nose", Vector2(0, 2))
				draw_circle(np, d.get("nose_r", 2.6), ink)
				# mouth lines under nose
				var mw: float = d.get("mouth_w", 7.0)
				draw_polyline(_smile(np + Vector2(0, d.get("nose_r", 2.6)), mw, 3.0), ink, sw2 * 0.7, true)
			"beak":
				var bk: PackedVector2Array = d.get("beak_poly", PackedVector2Array())
				if bk.size() > 2:
					draw_colored_polygon(bk, d.get("beak_col", Color(0.95, 0.7, 0.3)))
					var bl := bk.duplicate(); bl.append(bk[0])
					draw_polyline(bl, ink, d.get("sw", 2.0) * 0.7, true)
			"wide":
				# frog smile: a long upward arc with two nostril dots
				var ww: float = d.get("mouth_w", 18.0)
				draw_polyline(_smile(Vector2(0, d.get("mouth_y", 6.0)), ww, 6.0), ink, d.get("sw", 2.0), true)
				draw_circle(Vector2(-ww * 0.18, d.get("mouth_y", 6.0) - 7.0), 1.4, ink)
				draw_circle(Vector2(ww * 0.18, d.get("mouth_y", 6.0) - 7.0), 1.4, ink)
			_:
				# plain small smile
				var mw2: float = d.get("mouth_w", 7.0)
				draw_polyline(_smile(Vector2(0, d.get("mouth_y", 6.0)), mw2, 3.0), ink, d.get("sw", 2.0) * 0.8, true)
		# brows (mood)
		if d.get("brows", false):
			var bx: float = d.get("eye_x", 10.0)
			var by: float = d.get("eye_y", -4.0) - d.get("eye_r", 7.0) - 3.0
			var ba: float = d.get("brow_ang", 0.0)
			var bl2: float = d.get("eye_r", 7.0) * 0.9
			draw_polyline(PackedVector2Array([Vector2(-bx - bl2, by + ba), Vector2(-bx + bl2, by - ba)]), ink, d.get("sw", 2.0) * 0.7, true)
			draw_polyline(PackedVector2Array([Vector2(bx - bl2, by - ba), Vector2(bx + bl2, by + ba)]), ink, d.get("sw", 2.0) * 0.7, true)

	func _smile(c: Vector2, w: float, depth: float) -> PackedVector2Array:
		var o := PackedVector2Array()
		for i in 13:
			var tt := float(i) / 12.0
			var x := lerpf(-w * 0.5, w * 0.5, tt)
			var y := c.y + sin(tt * PI) * depth
			o.append(Vector2(c.x + x, y))
		return o

# =============================================================================
# Aura — drifting sparkle / glow / starfield motes for rare+ Blocklings. Rotated and
# alpha-pulsed as a whole node (no redraw) by the Blockling.
# =============================================================================
class _Aura extends Node2D:
	var motes: Array = []       # each {pos, r, col}
	var rings: Array = []       # each {r, col, w}

	func set_data(ms: Array, rs: Array) -> void:
		motes = ms
		rings = rs
		queue_redraw()

	func _draw() -> void:
		for ring in rings:
			var pts := PackedVector2Array()
			for i in 33:
				var a := TAU * i / 32.0
				pts.append(Vector2(cos(a), sin(a)) * ring["r"])
			pts.append(pts[0])
			draw_polyline(pts, ring["col"], ring.get("w", 2.0), true)
		for m in motes:
			draw_circle(m["pos"], m["r"], m["col"])
			draw_circle(m["pos"], m["r"] * 0.5, Color(1, 1, 1, m["col"].a * 0.8))

# =============================================================================
# The Blockling itself.
# =============================================================================
class _Blockling extends ProcNode:
	# identity
	var world_seed: int = 0
	var keyv: String = ""
	var species: String = "cat"
	var bl_id: String = ""
	var bl_name: String = "Blockling"
	var profession: String = ""
	var rarity: String = "common"
	var rarity_idx: int = 0
	var base_palette := PackedColorArray()
	var base_px: float = 110.0
	var context: Dictionary = {}
	var trait_override: Dictionary = {}

	# adaptation / state
	var footprint_radius: float = 34.0
	var facing: float = 1.0          # +1 looks right, -1 left
	var minted: bool = false
	var _damp: float = 1.0           # animation amplitude (minted → near 0)

	# derived
	var traits: Dictionary = {}
	var col := {}                    # colour roles
	var P := {}                      # shape params
	var sc_cache: float = 1.0
	var head_base := Vector2.ZERO
	var head_lean: float = 0.0
	var hop_h: float = 18.0

	# node rig
	var bounce: Node2D
	var breath: Node2D
	var rig: Node2D
	var aura_back: _Aura
	var aura_front: _Aura
	var wing_l: _Part
	var wing_r: _Part
	var tail: _Part
	var legs: _Part
	var body: _Part
	var shell: _Part
	var horns_back: _Part
	var head: _Part
	var ear_l: _Part
	var ear_r: _Part
	var face: _Face
	var eye_l: _Eye
	var eye_r: _Eye
	var accessory: _Part
	var hat: _Part
	var sheen: _Part                 # minted glassy overlay

	# animation rest angles
	var ear_l_rest: float = 0.0
	var ear_r_rest: float = 0.0
	var tail_rest: float = 0.0
	var wing_l_rest: float = 0.0
	var wing_r_rest: float = 0.0
	var wing_speed: float = 6.0
	var wing_amp: float = 0.12

	# behaviour clocks
	var _blc := 0
	var _hc := 0
	var _lc := 0
	var _blink_timer: float = 1.0
	var _blink_prog: float = 0.0
	var _hop_timer: float = 4.0
	var _hop_prog: float = 0.0
	var _look_timer: float = 2.0
	var _look_cur: float = 0.0
	var _look_target: float = 0.0

	# -------------------------------------------------------------------------
	func _on_built() -> void:
		facing = 1.0 if Proc.hashf(seedv, "facing") < 0.6 else -1.0
		traits = _build_traits()
		col = _build_colours()
		P = _shape_params(species)
		_apply_context()

		# build the rig (back → front draw order)
		bounce = Node2D.new(); add_child(bounce)
		breath = Node2D.new(); bounce.add_child(breath)
		rig = Node2D.new(); breath.add_child(rig)

		aura_back = _Aura.new(); rig.add_child(aura_back)
		wing_l = _Part.new(); rig.add_child(wing_l)
		wing_r = _Part.new(); rig.add_child(wing_r)
		tail = _Part.new(); rig.add_child(tail)
		legs = _Part.new(); rig.add_child(legs)
		body = _Part.new(); rig.add_child(body)
		shell = _Part.new(); rig.add_child(shell)
		horns_back = _Part.new(); rig.add_child(horns_back)
		head = _Part.new(); rig.add_child(head)
		ear_l = _Part.new(); head.add_child(ear_l)
		ear_r = _Part.new(); head.add_child(ear_r)
		face = _Face.new(); head.add_child(face)
		eye_l = _Eye.new(); face.add_child(eye_l)
		eye_r = _Eye.new(); face.add_child(eye_r)
		accessory = _Part.new(); rig.add_child(accessory)
		hat = _Part.new(); rig.add_child(hat)
		aura_front = _Aura.new(); rig.add_child(aura_front)
		sheen = _Part.new(); rig.add_child(sheen)

		# stagger behaviour so a crowd never acts in lockstep
		_blink_timer = Proc.rangef(seedv, "blink0", 0.5, 4.0)
		_hop_timer = Proc.rangef(seedv, "hop0", 3.0, 12.0)
		_look_timer = Proc.rangef(seedv, "look0", 1.0, 4.0)

		_rebuild()

	func set_facing(dir: float) -> void:
		facing = -1.0 if dir < 0.0 else 1.0
		if is_instance_valid(rig):
			_rebuild()

	# Freeze (mint) / revive this creature. Minting stops growth and damps all life.
	func set_minted(on: bool) -> void:
		minted = on
		grow_rate = 0.0 if on else (1.0 / (25.0 * 60.0))
		_damp = 0.12 if on else 1.0
		if is_instance_valid(rig):
			_rebuild()

	func _on_growth() -> void:
		_rebuild()

	# -------------------------------------------------------------------------
	# Context adaptation (§2.3a): drift toward the local palette, lean to light,
	# shrink on exposed ground.
	func _apply_context() -> void:
		var local = context.get("local_palette", null)
		if local is Dictionary and local.has("base"):
			var lc: Color = local["base"]
			for k in col.keys():
				if col[k] is Color:
					col[k] = (col[k] as Color).lerp(lc, 0.22)
		var ld = context.get("light_dir", null)
		if ld is Vector2:
			head_lean = clampf(ld.x, -1.0, 1.0) * 0.07
		var elev = float(context.get("elevation", 0.0))
		base_px *= lerpf(1.0, 0.9, clampf(elev, 0.0, 1.0))

	# -------------------------------------------------------------------------
	# Traits
	func _build_traits() -> Dictionary:
		var t := {}
		var k := "tr:" + keyv
		t["hue"] = Proc.rangef(seedv, k + ":hue", -0.045, 0.045)
		var markings := ["none", "none", "belly", "spots", "stripes", "patch", "freckles", "ombre", "star_mark"]
		t["marking"] = markings[int(Proc.hashf(seedv, k + ":mk") * markings.size()) % markings.size()]
		var acc := ["scarf", "collar", "pendant", "flower", "satchel", "leaf_cloak", "bell"]
		t["accessory"] = "none"
		if Proc.hashf(seedv, k + ":acc") < 0.14 + rarity_idx * 0.11:
			t["accessory"] = acc[int(Proc.hashf(seedv, k + ":acc2") * acc.size()) % acc.size()]
		var hats := ["acorn", "leaf", "crown", "star", "mushroom", "bow", "petal", "berry"]
		t["hat"] = "none"
		if Proc.hashf(seedv, k + ":hat") < 0.09 + rarity_idx * 0.08:
			t["hat"] = hats[int(Proc.hashf(seedv, k + ":hat2") * hats.size()) % hats.size()]
		var auras := ["none", "none", "sparkle", "glow", "firefly", "starfield", "cosmic"]
		t["aura"] = auras[clampi(rarity_idx, 0, auras.size() - 1)]
		t["fairy_wings"] = Proc.hashf(seedv, k + ":fw") < 0.03 + rarity_idx * 0.03
		for ko in trait_override.keys():
			t[ko] = trait_override[ko]
		return t

	# Colour roles from the entity palette + hue trait.
	func _build_colours() -> Dictionary:
		var base: Color
		var acc: Color
		if base_palette.size() >= 2:
			base = base_palette[0]; acc = base_palette[1]
		elif base_palette.size() == 1:
			base = base_palette[0]; acc = base.lightened(0.3)
		else:
			var p := Proc.palette(seedv, "fallback")
			base = p.base; acc = p.accent
		var hs: float = traits.get("hue", 0.0)
		base = Color.from_hsv(fposmod(base.h + hs, 1.0), base.s, base.v, 1.0)
		acc = Color.from_hsv(fposmod(acc.h + hs, 1.0), acc.s, acc.v, 1.0)
		var c := {}
		c["base"] = base
		c["base_dk"] = base.darkened(0.26)
		c["base_dk2"] = base.darkened(0.42)
		c["base_lt"] = base.lightened(0.26)
		c["belly"] = Color.from_hsv(base.h, maxf(0.05, base.s * 0.35), minf(1.0, base.v + 0.22))
		c["accent"] = acc
		c["accent_dk"] = acc.darkened(0.3)
		c["ink"] = Color.from_hsv(base.h, clampf(base.s * 0.55, 0.0, 1.0), 0.14)
		c["cheek"] = Color(1.0, 0.55, 0.6, 0.45)
		c["eye"] = Color.from_hsv(fposmod(acc.h + 0.03, 1.0), minf(1.0, acc.s + 0.2), maxf(0.18, acc.v * 0.5))
		var rc := _rarity_color()
		c["rarity"] = rc
		return c

	func _rarity_color() -> Color:
		match rarity:
			"uncommon": return Color.html("#7FE3B0")
			"rare": return Color.html("#8FB8FF")
			"epic": return Color.html("#C79BFF")
			"legendary": return Color.html("#FFC978")
			"mythic": return Color.html("#FF9BB0")
		return Color.html("#B9C2CC")

	# =========================================================================
	# Shape parameter table — proportions + which appendages each species wears.
	# All numbers are ADULT pixels at base_px≈110 and get scaled by growth.
	# =========================================================================
	func _shape_params(shape: String) -> Dictionary:
		# sensible defaults (a soft quadruped-ish critter)
		var d := {
			"body_w": 46.0, "body_h": 42.0, "body_n": 2.5,
			"leg_len": 16.0, "leg_w": 11.0, "leg_count": 2, "leg_style": "stub",
			"head_r": 30.0, "head_overlap": 0.5, "head_squash": 1.0,
			"face_dy": 2.0, "eye_r": 7.0, "eye_x": 11.0, "eye_y": -2.0, "eye_style": "round",
			"ears": "round", "ear_size": 1.0,
			"horns": "none", "muzzle": "none", "tail": "none", "wings": "none",
			"body_kind": "fur", "shell": false, "antennae": false,
			"star_points": 0, "mouth_w": 8.0, "brows": false, "brow_ang": 0.0,
		}
		match shape:
			"sprout":
				d.merge({"body_w": 34.0, "body_h": 34.0, "body_n": 2.2, "leg_len": 12.0, "leg_w": 8.0,
					"head_r": 26.0, "head_overlap": 0.85, "eye_r": 7.0, "eye_x": 9.0, "eye_y": 0.0,
					"ears": "none", "tail": "none", "body_kind": "leaf", "muzzle": "none",
					"special": "sprout", "mouth_w": 7.0}, true)
			"mossling":
				d.merge({"body_w": 42.0, "body_h": 36.0, "body_n": 2.6, "leg_len": 12.0, "leg_w": 10.0,
					"head_r": 25.0, "head_overlap": 0.7, "eye_r": 6.5, "eye_x": 9.0, "eye_y": 0.0,
					"ears": "none", "tail": "none", "body_kind": "leaf", "special": "moss"}, true)
			"pebble":
				d.merge({"body_w": 44.0, "body_h": 38.0, "body_n": 3.2, "leg_len": 9.0, "leg_w": 11.0,
					"head_r": 30.0, "head_overlap": 0.92, "eye_r": 7.0, "eye_x": 10.0, "eye_y": 0.0,
					"ears": "none", "tail": "none", "body_kind": "stone", "head_squash": 0.92}, true)
			"frog":
				d.merge({"body_w": 50.0, "body_h": 34.0, "body_n": 2.3, "leg_len": 10.0, "leg_w": 13.0,
					"leg_style": "web", "head_r": 30.0, "head_overlap": 0.75, "eye_r": 9.0, "eye_x": 13.0,
					"eye_y": -16.0, "eye_style": "big", "ears": "none", "tail": "none",
					"muzzle": "wide", "body_kind": "fur", "mouth_w": 22.0, "eye_top": true}, true)
			"owlet":
				d.merge({"body_w": 40.0, "body_h": 46.0, "body_n": 2.2, "leg_len": 8.0, "leg_w": 7.0,
					"leg_style": "bird", "head_r": 30.0, "head_overlap": 0.55, "eye_r": 10.0, "eye_x": 11.0,
					"eye_y": -2.0, "eye_style": "big", "ears": "tuft", "muzzle": "beak", "tail": "feather",
					"wings": "bird", "body_kind": "feather", "brows": true, "brow_ang": 2.0}, true)
			"mole":
				d.merge({"body_w": 44.0, "body_h": 34.0, "body_n": 2.6, "leg_len": 10.0, "leg_w": 12.0,
					"leg_style": "claw", "head_r": 24.0, "head_overlap": 0.7, "eye_r": 4.5, "eye_x": 8.0,
					"eye_y": -1.0, "eye_style": "dot", "ears": "tiny", "muzzle": "snout", "tail": "thin",
					"body_kind": "fur", "nose_big": true}, true)
			"stickbug":
				d.merge({"body_w": 22.0, "body_h": 54.0, "body_n": 2.0, "leg_len": 26.0, "leg_w": 4.0,
					"leg_count": 6, "leg_style": "stick", "head_r": 18.0, "head_overlap": 0.4,
					"eye_r": 6.0, "eye_x": 7.0, "eye_y": -1.0, "ears": "none", "muzzle": "none",
					"antennae": true, "body_kind": "fur", "tail": "none"}, true)
			"deer":
				d.merge({"body_w": 40.0, "body_h": 40.0, "body_n": 2.6, "leg_len": 26.0, "leg_w": 7.0,
					"leg_count": 4, "leg_style": "hoof", "head_r": 24.0, "head_overlap": 0.3,
					"eye_r": 7.0, "eye_x": 9.0, "eye_y": -1.0, "eye_style": "sleepy", "ears": "deer",
					"horns": "deer", "muzzle": "snout", "tail": "puff", "body_kind": "fur"}, true)
			"cat":
				d.merge({"body_w": 42.0, "body_h": 40.0, "body_n": 2.6, "leg_len": 18.0, "leg_w": 9.0,
					"leg_count": 4, "leg_style": "stub", "head_r": 27.0, "head_overlap": 0.4,
					"eye_r": 7.5, "eye_x": 10.0, "eye_y": -1.0, "ears": "cat", "muzzle": "snout",
					"tail": "cat", "body_kind": "fur"}, true)
			"turtle":
				d.merge({"body_w": 50.0, "body_h": 30.0, "body_n": 2.8, "leg_len": 10.0, "leg_w": 12.0,
					"leg_count": 4, "leg_style": "stub", "head_r": 18.0, "head_overlap": 0.0,
					"eye_r": 5.0, "eye_x": 6.0, "eye_y": -1.0, "eye_style": "sleepy", "ears": "none",
					"muzzle": "snout", "tail": "thin", "shell": true, "body_kind": "fur",
					"head_front": true}, true)
			"fox":
				d.merge({"body_w": 42.0, "body_h": 38.0, "body_n": 2.5, "leg_len": 18.0, "leg_w": 8.0,
					"leg_count": 4, "leg_style": "stub", "head_r": 26.0, "head_overlap": 0.38,
					"eye_r": 7.0, "eye_x": 10.0, "eye_y": -1.0, "ears": "fox", "muzzle": "snout",
					"tail": "fox", "body_kind": "fur"}, true)
			"golem":
				d.merge({"body_w": 50.0, "body_h": 50.0, "body_n": 3.6, "leg_len": 16.0, "leg_w": 16.0,
					"leg_count": 2, "leg_style": "block", "head_r": 30.0, "head_overlap": 0.4,
					"eye_r": 6.5, "eye_x": 11.0, "eye_y": -1.0, "eye_style": "round", "ears": "none",
					"horns": "crystal", "muzzle": "none", "tail": "none", "body_kind": "stone",
					"arms": true}, true)
			"bird":
				d.merge({"body_w": 34.0, "body_h": 38.0, "body_n": 2.3, "leg_len": 10.0, "leg_w": 5.0,
					"leg_style": "bird", "head_r": 23.0, "head_overlap": 0.5, "eye_r": 7.0, "eye_x": 8.0,
					"eye_y": -1.0, "ears": "none", "muzzle": "beak", "tail": "feather", "wings": "bird",
					"body_kind": "feather", "crest": true}, true)
			"moth":
				d.merge({"body_w": 26.0, "body_h": 40.0, "body_n": 2.2, "leg_len": 8.0, "leg_w": 5.0,
					"head_r": 20.0, "head_overlap": 0.55, "eye_r": 8.0, "eye_x": 8.0, "eye_y": -1.0,
					"eye_style": "sparkle", "ears": "none", "muzzle": "none", "tail": "none",
					"wings": "moth", "antennae": true, "body_kind": "glow", "fuzzy": true}, true)
			"mooncat":
				d.merge({"body_w": 40.0, "body_h": 40.0, "body_n": 2.6, "leg_len": 17.0, "leg_w": 9.0,
					"leg_count": 4, "leg_style": "stub", "head_r": 27.0, "head_overlap": 0.4,
					"eye_r": 7.5, "eye_x": 10.0, "eye_y": -1.0, "eye_style": "sparkle", "ears": "cat",
					"muzzle": "snout", "tail": "cat", "body_kind": "glow", "star_marks": true,
					"horns": "crescent"}, true)
			"greatdeer":
				d.merge({"body_w": 46.0, "body_h": 46.0, "body_n": 2.6, "leg_len": 30.0, "leg_w": 8.0,
					"leg_count": 4, "leg_style": "hoof", "head_r": 26.0, "head_overlap": 0.28,
					"eye_r": 7.0, "eye_x": 9.0, "eye_y": -1.0, "eye_style": "sleepy", "ears": "deer",
					"horns": "antler", "muzzle": "snout", "tail": "puff", "body_kind": "fur",
					"grand": true}, true)
			"star":
				d.merge({"body_w": 40.0, "body_h": 40.0, "body_n": 2.0, "leg_len": 10.0, "leg_w": 6.0,
					"head_r": 0.0, "head_overlap": 1.0, "eye_r": 7.0, "eye_x": 9.0, "eye_y": -2.0,
					"eye_style": "sparkle", "ears": "none", "muzzle": "none", "tail": "none",
					"body_kind": "glow", "star_points": 5, "star_body": true}, true)
			"dragon":
				d.merge({"body_w": 44.0, "body_h": 42.0, "body_n": 2.5, "leg_len": 16.0, "leg_w": 9.0,
					"leg_count": 2, "leg_style": "stub", "head_r": 25.0, "head_overlap": 0.35,
					"eye_r": 6.5, "eye_x": 9.0, "eye_y": -2.0, "eye_style": "round", "ears": "none",
					"horns": "dragon", "muzzle": "snout", "tail": "dragon", "wings": "dragon",
					"body_kind": "scale", "spines": true, "brows": true, "brow_ang": 3.0}, true)
		return d

	# =========================================================================
	# GROWTH-STAGED REBUILD — recompute geometry for the current eased growth and
	# push it to every part. Called on build and whenever growth crosses threshold.
	# =========================================================================
	func _rebuild() -> void:
		var ge := g()
		var sc := (base_px / 110.0) * lerpf(0.46, 1.0, ge)
		sc_cache = sc
		var headk := lerpf(1.42, 1.0, ge)     # babies: big head
		var eyek := lerpf(1.3, 1.0, ge)       # babies: big eyes
		var limk := lerpf(0.42, 1.0, ge)      # babies: stubby limbs
		var detail := clampf((ge - 0.12) / 0.88, 0.0, 1.0)  # markings / wings / tail fill in
		var sw := maxf(1.3, 3.2 * sc)
		var ink: Color = col["ink"]

		# ---- core metrics -------------------------------------------------
		var legs_h: float = P["leg_len"] * limk * sc
		if String(P.get("leg_style", "")) == "bird":
			legs_h = P["leg_len"] * limk * sc * 0.8
		var bw: float = P["body_w"] * sc * lerpf(0.92, 1.0, ge)
		var bh: float = P["body_h"] * sc * lerpf(0.88, 1.0, ge)
		var body_cy := -(legs_h + bh * 0.5)
		var body_top := body_cy - bh * 0.5
		var head_r: float = P["head_r"] * headk * sc
		var head_cy: float = body_top - head_r + float(P["head_overlap"]) * head_r
		if P.get("head_front", false):
			# turtle: head pokes forward from under the shell, not above
			head_cy = body_cy + bh * 0.1
		head_base = Vector2(facing * head_r * (0.0 if P.get("head_front", false) else 0.0), head_cy)

		footprint_radius = bw * 0.62
		hop_h = (bh + legs_h) * 0.22
		_damp = 0.12 if minted else 1.0

		# position the breathe pivot at the torso centre
		breath.position = Vector2(0, body_cy)
		rig.position = Vector2(0, -body_cy)

		# contact shadow lives on the root (not under bounce) so it stays on the ground
		_shadow_w = bw * 1.05
		_shadow_h = bw * 0.3
		queue_redraw()

		# ---- build each piece --------------------------------------------
		_build_legs(sc, sw, legs_h, bw, bh, body_cy, limk)
		_build_tail(sc, sw, detail, body_cy, bw, bh)
		_build_wings(sc, sw, detail, body_cy, bw, bh)
		_build_body(sc, sw, detail, body_cy, bw, bh)
		_build_shell(sc, sw, body_cy, bw, bh)
		_build_head(sc, sw, head_r, head_cy, eyek, detail)
		_build_accessory(sc, sw, detail, body_cy, bw, bh, head_cy, head_r)
		_build_hat(sc, sw, detail, head_cy, head_r)
		_build_aura(sc, body_cy, bw, bh, detail)
		_build_sheen(sc, body_cy, bw, bh)

	var _shadow_w: float = 40.0
	var _shadow_h: float = 12.0

	func _draw() -> void:
		# soft contact shadow on the ground
		var a := 0.22 if not minted else 0.14
		var e := _ellipse(0, -2.0, _shadow_w * 0.5, _shadow_h * 0.5, 2.2, 26)
		draw_colored_polygon(e, Color(0.05, 0.06, 0.08, a))

	# =========================================================================
	# Geometry primitives
	# =========================================================================
	func _ellipse(cx: float, cy: float, rx: float, ry: float, n: float = 2.4, steps: int = 40) -> PackedVector2Array:
		var p := Proc.superellipse(rx, ry, n, steps)
		for i in p.size():
			p[i] = p[i] + Vector2(cx, cy)
		return p

	func _capsule(cx: float, y_top: float, y_bot: float, w: float, n: float = 2.6) -> PackedVector2Array:
		var cy := (y_top + y_bot) * 0.5
		var ry := absf(y_bot - y_top) * 0.5
		return _ellipse(cx, cy, w * 0.5, ry, n, 22)

	func _arc(c: Vector2, r: float, a0: float, a1: float, steps: int = 16) -> PackedVector2Array:
		var o := PackedVector2Array()
		for i in steps + 1:
			var ang := lerpf(a0, a1, float(i) / steps)
			o.append(c + Vector2(cos(ang), sin(ang)) * r)
		return o

	func _star_poly(c: Vector2, r_out: float, r_in: float, points: int, rot: float = -PI / 2.0, smooth: bool = true) -> PackedVector2Array:
		var ctrl := PackedVector2Array()
		for i in points * 2:
			var ang := rot + PI * i / points
			var rr := r_out if i % 2 == 0 else r_in
			ctrl.append(c + Vector2(cos(ang), sin(ang)) * rr)
		if smooth:
			var s := Proc.smooth_loop(ctrl, 4)
			return s
		return ctrl

	func _leaf(base: Vector2, length: float, width: float, ang: float) -> PackedVector2Array:
		var dir := Vector2(cos(ang), sin(ang))
		var perp := Vector2(-dir.y, dir.x)
		var tip := base + dir * length
		var mid := base + dir * length * 0.5
		var ctrl := PackedVector2Array([
			base, mid + perp * width * 0.5, tip, mid - perp * width * 0.5,
		])
		return Proc.smooth_loop(ctrl, 7)

	func _blob(key: String, c: Vector2, r: float, lobes: int, wobble: float) -> PackedVector2Array:
		var p := Proc.blob(seedv, key, r, lobes, wobble)
		for i in p.size():
			p[i] = p[i] + c
		return p

	# =========================================================================
	# LEGS
	# =========================================================================
	func _build_legs(sc: float, sw: float, legs_h: float, bw: float, bh: float, body_cy: float, limk: float) -> void:
		var ls := []
		if legs_h <= 0.5 or String(P.get("leg_style", "")) == "none":
			legs.set_data(ls); return
		var count: int = int(P.get("leg_count", 2))
		var style := String(P.get("leg_style", "stub"))
		var lw: float = P["leg_w"] * sc * lerpf(1.15, 1.0, limk)
		var top_y := body_cy + bh * 0.28
		var bot_y := -1.0
		var span := bw * 0.6
		var dk: Color = col["base_dk"]
		var dk2: Color = col["base_dk2"]
		if count >= 4:
			# two back legs (darker), two front legs
			for side: float in [-1.0, 1.0]:
				var x := side * span * 0.62
				ls.append(_leg_layer(style, x - facing * span * 0.12, top_y, bot_y, lw, dk2, sw, true))
			for side: float in [-1.0, 1.0]:
				var x2 := side * span * 0.55
				ls.append(_leg_layer(style, x2 + facing * span * 0.12, top_y, bot_y, lw, dk, sw, false))
		elif count == 6:
			for i in 3:
				var fx := lerpf(-span * 0.7, span * 0.7, float(i) / 2.0)
				ls.append(_leg_layer(style, fx, top_y, bot_y, lw, dk2, sw, true))
				ls.append(_leg_layer(style, fx + facing * 6.0 * sc, top_y, bot_y, lw, dk, sw, false))
		else:
			for side: float in [-1.0, 1.0]:
				var x3 := side * span * 0.5
				ls.append(_leg_layer(style, x3, top_y, bot_y, lw, dk, sw, false))
		legs.set_data(ls)

	func _leg_layer(style: String, x: float, top_y: float, bot_y: float, w: float, c: Color, sw: float, back: bool) -> Dictionary:
		var poly: PackedVector2Array
		match style:
			"hoof":
				poly = _capsule(x, top_y, bot_y, w * 0.7, 2.2)
				# darken the hoof tip by just using base colour; keep slim
			"stick":
				poly = _capsule(x, top_y, bot_y, maxf(2.0, w * 0.5), 2.0)
			"bird":
				poly = _capsule(x, top_y, bot_y, maxf(2.5, w * 0.6), 2.0)
			"web", "block":
				poly = _capsule(x, top_y, bot_y + 1.0, w * 1.1, 3.0)
			"claw":
				poly = _capsule(x, top_y, bot_y, w, 2.6)
			_:
				poly = _capsule(x, top_y, bot_y, w, 2.6)
		var top := c.lightened(0.05)
		var bot := c.darkened(0.12)
		return {"poly": poly, "top": top, "bot": bot, "stroke": col["ink"], "sw": sw * 0.75}

	# =========================================================================
	# BODY (torso + belly + markings + arms)
	# =========================================================================
	func _build_body(sc: float, sw: float, detail: float, body_cy: float, bw: float, bh: float) -> void:
		var ls := []
		var circles := []
		var kind := String(P.get("body_kind", "fur"))
		var base: Color = col["base"]
		var base_lt: Color = col["base_lt"]
		var base_dk: Color = col["base_dk"]

		# arms (golem) behind torso
		if P.get("arms", false):
			var aw := bw * 0.26
			for side: float in [-1.0, 1.0]:
				var ax := side * bw * 0.52
				ls.append({"poly": _capsule(ax, body_cy - bh * 0.1, body_cy + bh * 0.3, aw, 3.2),
					"top": base_dk.lightened(0.05), "bot": base_dk.darkened(0.1), "stroke": col["ink"], "sw": sw * 0.8})

		# main torso silhouette
		var torso: PackedVector2Array
		if P.get("star_body", false):
			torso = _star_poly(Vector2(0, body_cy), bw * 0.95, bw * 0.42, int(P.get("star_points", 5)), -PI / 2.0, true)
		elif kind == "stone":
			torso = _blob("torso", Vector2(0, body_cy), bw * 0.56, 8, 0.18)
		else:
			torso = _ellipse(0, body_cy, bw * 0.5, bh * 0.5, P["body_n"], 46)
		var top_c := base_lt
		var bot_c := base_dk
		if kind == "glow":
			top_c = base.lightened(0.35); bot_c = base.darkened(0.08)
		ls.append({"poly": torso, "top": top_c, "bot": bot_c, "stroke": col["ink"], "sw": sw})

		# belly / underside patch
		if kind != "stone" and not P.get("star_body", false):
			var belly := _ellipse(facing * bw * 0.02, body_cy + bh * 0.16, bw * 0.3, bh * 0.32, 2.3, 30)
			ls.append({"poly": belly, "top": col["belly"].lightened(0.1), "bot": col["belly"], "fill": true, "sw": 0.0})

		# markings
		_add_markings(ls, circles, sc, detail, body_cy, bw, bh, kind)

		# stone facets / scale hints
		if kind == "stone":
			for i in 3:
				var fx := Proc.rangef(seedv, "facet:%d" % i, -0.4, 0.4) * bw
				var fy := body_cy + Proc.rangef(seedv, "facety:%d" % i, -0.3, 0.3) * bh
				ls.append({"poly": _ellipse(fx, fy, bw * 0.12, bh * 0.1, 3.0, 10),
					"top": base_lt, "bot": base, "fill": true, "sw": 0.0})
		elif kind == "scale":
			for i in 4:
				var yy := body_cy - bh * 0.2 + i * bh * 0.14
				ls.append({"poly": _arc(Vector2(0, yy), bw * 0.3, 0.15 * PI, 0.85 * PI, 10),
					"top": base_dk, "bot": base_dk, "fill": false, "stroke": base_dk, "sw": sw * 0.6, "close": false})

		# dragon spines along the back
		if P.get("spines", false):
			for i in 3:
				var syy := body_cy - bh * 0.3 + i * bh * 0.2
				var sp := PackedVector2Array([
					Vector2(-facing * (4.0 + i) * sc, syy + 5 * sc),
					Vector2(-facing * (10.0 + i * 2) * sc, syy - 6 * sc),
					Vector2(-facing * (2.0 + i) * sc, syy)])
				ls.append({"poly": sp, "top": col["accent"], "bot": col["accent_dk"], "stroke": col["ink"], "sw": sw * 0.6})

		body.set_data(ls, circles)

	func _add_markings(ls: Array, circles: Array, sc: float, detail: float, body_cy: float, bw: float, bh: float, kind: String) -> void:
		if detail < 0.08:
			return
		var m := String(traits.get("marking", "none"))
		var acc: Color = col["accent"]
		var acc_dk: Color = col["accent_dk"]
		var a := detail
		match m:
			"spots":
				for i in 4:
					var sx := Proc.rangef(seedv, "spot:%d" % i, -0.35, 0.35) * bw
					var sy := body_cy + Proc.rangef(seedv, "spoty:%d" % i, -0.2, 0.3) * bh
					circles.append({"c": Vector2(sx, sy), "r": bw * 0.07 * a, "col": Color(acc_dk.r, acc_dk.g, acc_dk.b, 0.7 * a)})
			"stripes":
				for i in 3:
					var yy := body_cy - bh * 0.15 + i * bh * 0.16
					ls.append({"poly": _arc(Vector2(0, yy), bw * 0.34, 0.2 * PI, 0.8 * PI, 10),
						"fill": false, "stroke": Color(acc_dk.r, acc_dk.g, acc_dk.b, 0.8 * a), "sw": maxf(1.5, 3.0 * sc) * a, "close": false})
			"patch":
				ls.append({"poly": _ellipse(facing * bw * 0.22, body_cy - bh * 0.05, bw * 0.2, bh * 0.22, 2.4, 20),
					"top": acc.lightened(0.1), "bot": acc, "fill": true, "sw": 0.0})
			"freckles":
				for i in 6:
					var fx := Proc.rangef(seedv, "frk:%d" % i, -0.4, 0.4) * bw
					var fy := body_cy + Proc.rangef(seedv, "frky:%d" % i, 0.0, 0.3) * bh
					circles.append({"c": Vector2(fx, fy), "r": 1.6 * sc, "col": Color(acc_dk.r, acc_dk.g, acc_dk.b, 0.55 * a)})
			"ombre":
				ls.append({"poly": _ellipse(0, body_cy + bh * 0.22, bw * 0.46, bh * 0.28, 2.4, 30),
					"top": Color(acc.r, acc.g, acc.b, 0.0), "bot": Color(acc.r, acc.g, acc.b, 0.6 * a), "fill": true, "sw": 0.0})
			"star_mark":
				ls.append({"poly": _star_poly(Vector2(facing * bw * 0.18, body_cy - bh * 0.02), bw * 0.12 * a, bw * 0.055 * a, 5),
					"top": acc.lightened(0.2), "bot": acc, "fill": true, "sw": 0.0})
		# celestial star-flecks for glow creatures
		if P.get("star_marks", false):
			for i in 5:
				var sx2 := Proc.rangef(seedv, "cm:%d" % i, -0.35, 0.35) * bw
				var sy2 := body_cy + Proc.rangef(seedv, "cmy:%d" % i, -0.3, 0.3) * bh
				circles.append({"c": Vector2(sx2, sy2), "r": 1.6 * sc, "col": Color(1, 1, 1, 0.8 * detail)})

	# =========================================================================
	# SHELL (turtle)
	# =========================================================================
	func _build_shell(sc: float, sw: float, body_cy: float, bw: float, bh: float) -> void:
		if not P.get("shell", false):
			shell.set_data([]); return
		var ls := []
		var cy := body_cy - bh * 0.12
		var dome := _ellipse(0, cy, bw * 0.5, bh * 0.68, 2.6, 40)
		ls.append({"poly": dome, "top": col["accent"].lightened(0.2), "bot": col["accent_dk"], "stroke": col["ink"], "sw": sw})
		# plates
		var ring := _ellipse(0, cy, bw * 0.3, bh * 0.4, 2.6, 24)
		ls.append({"poly": ring, "fill": false, "stroke": col["accent_dk"].darkened(0.1), "sw": sw * 0.6})
		for i in 6:
			var ang := TAU * i / 6.0
			var p0 := Vector2(cos(ang), sin(ang) * 0.75) * Vector2(bw * 0.3, bh * 0.4).x
			ls.append({"poly": PackedVector2Array([
				Vector2(0, cy) + Vector2(cos(ang), sin(ang)) * Vector2(bw * 0.3, 0).x * 0.6 * 0.5,
				Vector2(0, cy) + Vector2(cos(ang), sin(ang) * 0.8) * bw * 0.48,
			]), "fill": false, "stroke": col["accent_dk"].darkened(0.1), "sw": sw * 0.5, "close": false})
		shell.set_data(ls)

	# =========================================================================
	# TAIL
	# =========================================================================
	func _build_tail(sc: float, sw: float, detail: float, body_cy: float, bw: float, bh: float) -> void:
		var kind := String(P.get("tail", "none"))
		if kind == "none" or detail < 0.1:
			tail.set_data([]); tail.position = Vector2.ZERO; return
		var base_x := -facing * bw * 0.42
		var base_y := body_cy + bh * 0.1
		tail.position = Vector2(base_x, base_y)
		tail_rest = 0.0
		var ls := []
		var base: Color = col["base"]
		var base_dk: Color = col["base_dk"]
		var lt: Color = col["base_lt"]
		match kind:
			"fox":
				var len := bw * 0.9 * detail
				var w := bw * 0.4
				var t := _leaf(Vector2.ZERO, len, w, PI * 0.78 - (0.0 if facing > 0 else PI) * 0.0)
				# tilt whole leaf via control: build along -facing up
				t = _fluffy_tail(len, w, true)
				ls.append({"poly": t, "top": lt, "bot": base_dk, "stroke": col["ink"], "sw": sw})
				var tip := _fluffy_tail(len * 0.42, w * 0.7, true)
				ls.append({"poly": tip, "top": Color(1, 1, 1, 0.95), "bot": col["belly"], "fill": true, "sw": 0.0})
			"cat":
				var tl := _capsule(0, -bw * 0.75 * detail, 0, bw * 0.16)
				# curl it
				tl = _curl_tail(bw * 0.8 * detail, bw * 0.16, 0.5)
				ls.append({"poly": tl, "top": base, "bot": base_dk, "stroke": col["ink"], "sw": sw})
			"puff":
				ls.append({"poly": _ellipse(0, -bw * 0.1, bw * 0.16, bw * 0.16, 2.2, 18),
					"top": col["belly"].lightened(0.1), "bot": col["belly"], "stroke": col["ink"], "sw": sw * 0.7})
			"feather":
				for i in 3:
					var ang := PI * 0.5 + (i - 1) * 0.3
					ls.append({"poly": _leaf(Vector2.ZERO, bw * 0.55 * detail, bw * 0.18, ang),
						"top": lt, "bot": base_dk, "stroke": col["ink"], "sw": sw * 0.7})
			"thin":
				ls.append({"poly": _capsule(0, -bw * 0.3 * detail, 0, bw * 0.08),
					"top": base, "bot": base_dk, "stroke": col["ink"], "sw": sw * 0.6})
			"dragon":
				ls.append({"poly": _dragon_tail(bw * 1.1 * detail, bw * 0.22),
					"top": col["base_lt"], "bot": base_dk, "stroke": col["ink"], "sw": sw})
				# spade tip
				var tipc := Vector2(-bw * 0.95 * detail, -bw * 0.15 * detail)
				ls.append({"poly": _leaf(tipc, bw * 0.3, bw * 0.3, PI * 0.9),
					"top": col["accent"], "bot": col["accent_dk"], "stroke": col["ink"], "sw": sw * 0.7})
		tail.set_data(ls)

	func _fluffy_tail(length: float, width: float, fluffy: bool) -> PackedVector2Array:
		# a curved teardrop sweeping up-and-back from origin
		var ctrl := PackedVector2Array([
			Vector2(0, width * 0.4),
			Vector2(-length * 0.3, -length * 0.1),
			Vector2(-length * 0.7, -length * 0.5),
			Vector2(-length * 0.55, -length * 0.95),
			Vector2(-length * 0.1, -length * 0.8),
			Vector2(width * 0.5, -length * 0.2),
		])
		return Proc.smooth_loop(ctrl, 7)

	func _curl_tail(length: float, width: float, curl: float) -> PackedVector2Array:
		# A curling cat tail: build a smooth centreline, then offset PERPENDICULAR to
		# the curve (tapering to a point) so the two edges never cross — a simple,
		# fillable ribbon no matter how tight the curl.
		var n := 14
		var center := PackedVector2Array()
		for i in n + 1:
			var tt := float(i) / n
			var ang := -PI * 0.5 - tt * curl * PI
			var r := length * (1.0 - tt * 0.1)
			center.append(Vector2(cos(ang), sin(ang)) * r * tt)
		var right := PackedVector2Array()
		var left := PackedVector2Array()
		var cnt := center.size()
		for i in cnt:
			var hw := width * 0.5 * (1.0 - float(i) / float(cnt) * 0.65)   # taper to tip
			var tangent: Vector2
			if i == 0:
				tangent = center[1] - center[0]
			elif i == cnt - 1:
				tangent = center[i] - center[i - 1]
			else:
				tangent = center[i + 1] - center[i - 1]
			if tangent.length() < 0.0001:
				tangent = Vector2.UP
			var perp := tangent.orthogonal().normalized()
			right.append(center[i] + perp * hw)
			left.append(center[i] - perp * hw)
		# base→tip along the right edge, tip→base along the left edge = a simple loop
		var pts := right.duplicate()
		for i in range(cnt - 1, -1, -1):
			pts.append(left[i])
		return Proc.smooth_loop(pts, 2)

	func _dragon_tail(length: float, width: float) -> PackedVector2Array:
		var ctrl := PackedVector2Array([
			Vector2(width * 0.4, width * 0.5),
			Vector2(-length * 0.4, width * 0.2),
			Vector2(-length * 0.85, -length * 0.2),
			Vector2(-length * 0.9, -length * 0.35),
			Vector2(-length * 0.55, -width * 0.2),
			Vector2(width * 0.4, -width * 0.5),
		])
		return Proc.smooth_loop(ctrl, 7)

	# =========================================================================
	# WINGS
	# =========================================================================
	func _build_wings(sc: float, sw: float, detail: float, body_cy: float, bw: float, bh: float) -> void:
		var kind := String(P.get("wings", "none"))
		if bool(traits.get("fairy_wings", false)):
			if kind == "none":
				kind = "fairy"
		if kind == "none" or detail < 0.15:
			wing_l.set_data([]); wing_r.set_data([]); return
		var sx := bw * 0.32
		var sy := body_cy - bh * 0.1
		wing_l.position = Vector2(-sx, sy)
		wing_r.position = Vector2(sx, sy)
		var dd := detail
		match kind:
			"moth":
				wing_speed = 3.0; wing_amp = 0.10
				_moth_wing(wing_l, -1.0, bw, dd, sw)
				_moth_wing(wing_r, 1.0, bw, dd, sw)
			"bird":
				wing_speed = 7.0; wing_amp = 0.22
				_bird_wing(wing_l, -1.0, bw, dd, sw)
				_bird_wing(wing_r, 1.0, bw, dd, sw)
			"dragon":
				wing_speed = 2.4; wing_amp = 0.16
				_dragon_wing(wing_l, -1.0, bw, dd, sw)
				_dragon_wing(wing_r, 1.0, bw, dd, sw)
			"fairy":
				wing_speed = 9.0; wing_amp = 0.10
				_fairy_wing(wing_l, -1.0, bw, dd, sw)
				_fairy_wing(wing_r, 1.0, bw, dd, sw)
		wing_l_rest = 0.0
		wing_r_rest = 0.0

	func _moth_wing(part: _Part, s: float, bw: float, dd: float, sw: float) -> void:
		var ls := []
		var up := _leaf(Vector2.ZERO, bw * 0.85 * dd, bw * 0.6 * dd, (PI if s < 0 else 0.0) + s * 0.4 - PI * 0.5 * 0)
		# build fore + hind wings with a soft pattern
		var fore := _wing_blob(s, bw * 0.8 * dd, bw * 0.62 * dd, -0.25)
		var hind := _wing_blob(s, bw * 0.55 * dd, bw * 0.5 * dd, 0.5)
		ls.append({"poly": hind, "top": col["accent"].lightened(0.25), "bot": col["accent"], "stroke": col["ink"], "sw": sw * 0.7})
		ls.append({"poly": fore, "top": col["base_lt"], "bot": col["base"], "stroke": col["ink"], "sw": sw * 0.7})
		var circles := [
			{"c": Vector2(s * bw * 0.4, -bw * 0.3 * dd), "r": bw * 0.1 * dd, "col": Color(col["accent_dk"].r, col["accent_dk"].g, col["accent_dk"].b, 0.8)},
			{"c": Vector2(s * bw * 0.4, -bw * 0.3 * dd), "r": bw * 0.045 * dd, "col": Color(1, 1, 1, 0.9)},
		]
		part.set_data(ls, circles)

	func _wing_blob(s: float, w: float, h: float, tilt: float) -> PackedVector2Array:
		var ctrl := PackedVector2Array([
			Vector2.ZERO,
			Vector2(s * w * 0.4, -h * 0.7),
			Vector2(s * w, -h * 0.5 + tilt * h),
			Vector2(s * w * 0.9, h * 0.3),
			Vector2(s * w * 0.3, h * 0.2),
		])
		return Proc.smooth_loop(ctrl, 7)

	func _bird_wing(part: _Part, s: float, bw: float, dd: float, sw: float) -> void:
		var ls := []
		var ctrl := PackedVector2Array([
			Vector2.ZERO,
			Vector2(s * bw * 0.3, -bw * 0.5 * dd),
			Vector2(s * bw * 0.85, -bw * 0.2 * dd),
			Vector2(s * bw * 0.7, bw * 0.3 * dd),
			Vector2(s * bw * 0.1, bw * 0.15 * dd),
		])
		ls.append({"poly": Proc.smooth_loop(ctrl, 7), "top": col["base_lt"], "bot": col["base_dk"], "stroke": col["ink"], "sw": sw * 0.8})
		for i in 3:
			var fy := bw * (0.0 + i * 0.1) * dd
			ls.append({"poly": PackedVector2Array([Vector2(s * bw * 0.2, fy), Vector2(s * bw * 0.7, fy + bw * 0.08 * dd)]),
				"fill": false, "stroke": col["base_dk"], "sw": sw * 0.5, "close": false})
		part.set_data(ls)

	func _dragon_wing(part: _Part, s: float, bw: float, dd: float, sw: float) -> void:
		var ls := []
		var ox := s * bw
		var spokes := [Vector2(ox * 0.95, -bw * 0.55 * dd), Vector2(ox * 1.05, -bw * 0.1 * dd), Vector2(ox * 0.85, bw * 0.35 * dd)]
		var ctrl := PackedVector2Array([Vector2.ZERO])
		for sp in spokes:
			ctrl.append(sp)
		ctrl.append(Vector2(s * bw * 0.2, bw * 0.15 * dd))
		var mem := Proc.smooth_loop(ctrl, 6)
		ls.append({"poly": mem, "top": col["accent"].lightened(0.15), "bot": col["accent_dk"], "stroke": col["ink"], "sw": sw * 0.8})
		for sp in spokes:
			ls.append({"poly": PackedVector2Array([Vector2.ZERO, sp]), "fill": false, "stroke": col["ink"], "sw": sw * 0.6, "close": false})
		part.set_data(ls)

	func _fairy_wing(part: _Part, s: float, bw: float, dd: float, sw: float) -> void:
		var ls := []
		var up := _wing_blob(s, bw * 0.6 * dd, bw * 0.75 * dd, -0.3)
		var dn := _wing_blob(s, bw * 0.45 * dd, bw * 0.4 * dd, 0.6)
		var glass := Color(col["rarity"].r, col["rarity"].g, col["rarity"].b, 0.45)
		ls.append({"poly": up, "top": Color(1, 1, 1, 0.5), "bot": glass, "stroke": col["rarity"], "sw": sw * 0.5})
		ls.append({"poly": dn, "top": Color(1, 1, 1, 0.4), "bot": glass, "stroke": col["rarity"], "sw": sw * 0.5})
		part.set_data(ls)

	# =========================================================================
	# HEAD (dome + horns + ears + face)
	# =========================================================================
	func _build_head(sc: float, sw: float, head_r: float, head_cy: float, eyek: float, detail: float) -> void:
		head.position = Vector2(0, head_cy)
		head.rotation = head_lean
		var ls := []
		var base: Color = col["base"]
		var base_lt: Color = col["base_lt"]
		var base_dk: Color = col["base_dk"]
		var kind := String(P.get("body_kind", "fur"))

		# horns drawn behind the dome
		_build_horns_behind(sc, sw, head_r, head_cy, detail)

		# head dome
		var squash: float = P.get("head_squash", 1.0)
		var dome: PackedVector2Array
		if head_r <= 1.0:
			dome = PackedVector2Array()  # star body: face sits on the body
			head.position = Vector2(0, head_cy)
		elif kind == "stone":
			dome = _blob("head", Vector2.ZERO, head_r * 0.98, 8, 0.12)
		else:
			dome = _ellipse(0, 0, head_r, head_r * squash, 2.4, 44)
		var htop := base_lt
		var hbot := base_dk
		if kind == "glow":
			htop = base.lightened(0.4); hbot = base.darkened(0.05)
		if dome.size() > 2:
			ls.append({"poly": dome, "top": htop, "bot": hbot, "stroke": col["ink"], "sw": sw})
			# fuzzy rim for moth
			if P.get("fuzzy", false):
				for i in 14:
					var ang := TAU * i / 14.0
					var p0 := Vector2(cos(ang), sin(ang)) * head_r
					var p1 := p0 + Vector2(cos(ang), sin(ang)) * head_r * 0.18
					ls.append({"poly": PackedVector2Array([p0, p1]), "fill": false, "stroke": base_lt, "sw": sw * 0.5, "close": false})
			# forehead highlight
			ls.append({"poly": _ellipse(-head_r * 0.25, -head_r * 0.35, head_r * 0.28, head_r * 0.2, 2.2, 16),
				"top": Color(1, 1, 1, 0.3), "bot": Color(1, 1, 1, 0.0), "fill": true, "sw": 0.0})
		# crest feather (bird)
		if P.get("crest", false):
			for i in 3:
				var ang2 := -PI * 0.5 + (i - 1) * 0.3
				ls.append({"poly": _leaf(Vector2(0, -head_r * 0.9), head_r * 0.6 * detail, head_r * 0.22, ang2),
					"top": col["accent"], "bot": col["accent_dk"], "stroke": col["ink"], "sw": sw * 0.6})
		head.set_data(ls)

		_build_ears(sc, sw, head_r, detail)
		_build_face(sc, sw, head_r, eyek, detail)

	func _build_horns_behind(sc: float, sw: float, head_r: float, head_cy: float, detail: float) -> void:
		var kind := String(P.get("horns", "none"))
		horns_back.position = Vector2(0, head_cy)
		horns_back.rotation = head_lean
		if kind == "none" or detail < 0.3:
			horns_back.set_data([]); return
		var ls := []
		var hc: Color = col["accent"].lightened(0.1)
		var hc2: Color = col["accent_dk"]
		match kind:
			"deer":
				for s: float in [-1.0, 1.0]:
					var bx := s * head_r * 0.45
					ls.append({"poly": _capsule(bx, -head_r * 1.5 * detail, -head_r * 0.7, head_r * 0.12, 2.2),
						"top": hc, "bot": hc2, "stroke": col["ink"], "sw": sw * 0.7})
					ls.append({"poly": _capsule(bx + s * head_r * 0.2, -head_r * 1.3 * detail, -head_r * 1.0, head_r * 0.08, 2.2),
						"top": hc, "bot": hc2, "stroke": col["ink"], "sw": sw * 0.6})
			"antler":
				for s2: float in [-1.0, 1.0]:
					var bx2 := s2 * head_r * 0.5
					ls.append({"poly": _capsule(bx2, -head_r * 1.8 * detail, -head_r * 0.7, head_r * 0.11, 2.2),
						"top": hc, "bot": hc2, "stroke": col["ink"], "sw": sw * 0.7})
					for j in 3:
						var yy := -head_r * (0.9 + j * 0.3) * detail
						ls.append({"poly": _capsule(bx2 + s2 * head_r * (0.25 + j * 0.12), yy, yy + head_r * 0.35, head_r * 0.07, 2.2),
							"top": hc, "bot": hc2, "stroke": col["ink"], "sw": sw * 0.55})
			"dragon":
				for s3: float in [-1.0, 1.0]:
					ls.append({"poly": _horn_curve(s3, head_r, detail), "top": hc, "bot": hc2, "stroke": col["ink"], "sw": sw * 0.7})
			"crystal":
				for i in 3:
					var cx := (i - 1) * head_r * 0.4
					var hh := head_r * (1.1 - absf(i - 1) * 0.25) * detail
					ls.append({"poly": PackedVector2Array([
						Vector2(cx - head_r * 0.12, -head_r * 0.7),
						Vector2(cx, -head_r * 0.7 - hh),
						Vector2(cx + head_r * 0.12, -head_r * 0.7)]),
						"top": col["rarity"].lightened(0.3), "bot": col["rarity"], "stroke": col["ink"], "sw": sw * 0.6})
			"crescent":
				ls.append({"poly": _arc(Vector2(0, -head_r * 0.95), head_r * 0.5 * detail, PI * 1.1, PI * 1.9, 12),
					"fill": false, "stroke": col["rarity"], "sw": sw * 1.4, "close": false})
		horns_back.set_data(ls)

	func _horn_curve(s: float, head_r: float, detail: float) -> PackedVector2Array:
		var bx := s * head_r * 0.55
		var ctrl := PackedVector2Array([
			Vector2(bx - s * head_r * 0.1, -head_r * 0.65),
			Vector2(bx + s * head_r * 0.1, -head_r * 0.65),
			Vector2(bx + s * head_r * 0.5, -head_r * (0.9 + 0.5 * detail)),
			Vector2(bx + s * head_r * 0.75, -head_r * (0.75 + 0.5 * detail)),
			Vector2(bx + s * head_r * 0.35, -head_r * 0.72),
		])
		return Proc.smooth_loop(ctrl, 6)

	func _build_ears(sc: float, sw: float, head_r: float, detail: float) -> void:
		var kind := String(P.get("ears", "round"))
		if kind == "none" or head_r <= 1.0:
			ear_l.set_data([]); ear_r.set_data([]); return
		var size: float = P.get("ear_size", 1.0)
		# ear base positions on the head (relative to head centre)
		var ex := head_r * 0.62
		var ey := -head_r * 0.62
		match kind:
			"cat", "fox":
				ex = head_r * 0.6; ey = -head_r * 0.6
			"deer":
				ex = head_r * 0.7; ey = -head_r * 0.3
			"tuft":
				ex = head_r * 0.45; ey = -head_r * 0.8
			"round":
				ex = head_r * 0.75; ey = -head_r * 0.55
			"tiny":
				ex = head_r * 0.7; ey = -head_r * 0.45
		ear_l.position = Vector2(-ex, ey)
		ear_r.position = Vector2(ex, ey)
		ear_l_rest = -0.18
		ear_r_rest = 0.18
		_ear_art(ear_l, kind, -1.0, head_r, size, sw, detail)
		_ear_art(ear_r, kind, 1.0, head_r, size, sw, detail)

	func _ear_art(part: _Part, kind: String, s: float, head_r: float, size: float, sw: float, detail: float) -> void:
		var ls := []
		var base: Color = col["base"]
		var dk: Color = col["base_dk"]
		var inner: Color = col["cheek"]
		match kind:
			"cat":
				var tri := PackedVector2Array([
					Vector2(-head_r * 0.3 * size, head_r * 0.2),
					Vector2(0, -head_r * 0.7 * size),
					Vector2(head_r * 0.3 * size, head_r * 0.2)])
				ls.append({"poly": Proc.smooth_loop(tri, 4), "top": col["base_lt"], "bot": dk, "stroke": col["ink"], "sw": sw * 0.8})
				ls.append({"poly": PackedVector2Array([
					Vector2(-head_r * 0.14 * size, head_r * 0.1),
					Vector2(0, -head_r * 0.42 * size),
					Vector2(head_r * 0.14 * size, head_r * 0.1)]),
					"top": inner.lightened(0.1), "bot": inner, "fill": true, "sw": 0.0})
			"fox":
				var tri2 := PackedVector2Array([
					Vector2(-head_r * 0.26 * size, head_r * 0.25),
					Vector2(0, -head_r * 0.95 * size),
					Vector2(head_r * 0.26 * size, head_r * 0.25)])
				ls.append({"poly": Proc.smooth_loop(tri2, 4), "top": col["base_lt"], "bot": dk, "stroke": col["ink"], "sw": sw * 0.8})
				# dark tip
				ls.append({"poly": PackedVector2Array([
					Vector2(-head_r * 0.12 * size, -head_r * 0.55 * size),
					Vector2(0, -head_r * 0.95 * size),
					Vector2(head_r * 0.12 * size, -head_r * 0.55 * size)]),
					"top": col["ink"].lightened(0.1), "bot": col["ink"], "fill": true, "sw": 0.0})
			"deer":
				ls.append({"poly": _leaf(Vector2.ZERO, head_r * 0.85 * size, head_r * 0.45 * size, -PI * 0.5 + s * 0.6),
					"top": col["base_lt"], "bot": dk, "stroke": col["ink"], "sw": sw * 0.7})
				ls.append({"poly": _leaf(Vector2.ZERO, head_r * 0.55 * size, head_r * 0.22 * size, -PI * 0.5 + s * 0.6),
					"top": inner, "bot": inner, "fill": true, "sw": 0.0})
			"tuft":
				for i in 2:
					var ang := -PI * 0.5 + (i - 0.5) * 0.5 * s
					ls.append({"poly": _leaf(Vector2.ZERO, head_r * 0.5 * size, head_r * 0.16 * size, ang),
						"top": col["base_lt"], "bot": dk, "stroke": col["ink"], "sw": sw * 0.6})
			"tiny":
				ls.append({"poly": _ellipse(0, 0, head_r * 0.18 * size, head_r * 0.18 * size, 2.2, 12),
					"top": base, "bot": dk, "stroke": col["ink"], "sw": sw * 0.6})
			_:
				ls.append({"poly": _ellipse(0, -head_r * 0.15, head_r * 0.28 * size, head_r * 0.3 * size, 2.3, 16),
					"top": col["base_lt"], "bot": dk, "stroke": col["ink"], "sw": sw * 0.7})
				ls.append({"poly": _ellipse(0, -head_r * 0.12, head_r * 0.14 * size, head_r * 0.16 * size, 2.3, 12),
					"top": inner, "bot": inner, "fill": true, "sw": 0.0})
		part.set_data(ls)

	# =========================================================================
	# FACE
	# =========================================================================
	func _build_face(sc: float, sw: float, head_r: float, eyek: float, detail: float) -> void:
		var fr: float = head_r if head_r > 1.0 else float(P["body_w"]) * sc * 0.5
		face.position = Vector2(facing * fr * 0.08, P.get("face_dy", 2.0) * sc + (0.0 if head_r > 1.0 else 0.0))
		var er: float = P["eye_r"] * sc * eyek
		var ex: float = P["eye_x"] * sc
		var ey: float = P["eye_y"] * sc
		var style := String(P.get("eye_style", "round"))
		# for eye-on-top species (frog) eyes ride high
		# configure eye nodes
		for e: _Eye in [eye_l, eye_r]:
			e.r = er
			e.style = style
			e.sclera = Color(1, 1, 1)
			e.iris = col["eye"]
			e.ink = col["ink"]
			e.shine = true
			e.refresh()
		eye_l.position = Vector2(-ex, ey)
		eye_r.position = Vector2(ex, ey)
		var gaze := Vector2(facing * er * 0.18, 0)
		eye_l.look = gaze
		eye_r.look = gaze

		# frog: eyes on bumps above the head — raise and add lid bumps via face data
		var d := {
			"ink": col["ink"], "sw": sw,
			"cheeks": true, "cheek_r": er * 0.8, "cheek_col": col["cheek"],
			"cheek_x": ex + er * 0.7, "cheek_y": ey + er * 0.9,
			"eye_r": er, "eye_x": ex, "eye_y": ey,
			"muzzle": String(P.get("muzzle", "none")),
			"mouth_y": ey + er * 1.9, "mouth_w": P.get("mouth_w", 8.0) * sc,
			"brows": P.get("brows", false), "brow_ang": P.get("brow_ang", 0.0) * sc,
		}
		# muzzle geometry
		match String(P.get("muzzle", "none")):
			"snout":
				var mr := head_r * 0.42
				var big: float = 1.25 if P.get("nose_big", false) else 1.0
				d["snout_poly"] = _ellipse(0, ey + er * 1.4, mr * 0.9 * big, mr * 0.65 * big, 2.3, 24)
				d["muzzle_col"] = col["belly"].lightened(0.1)
				d["nose"] = Vector2(0, ey + er * 1.0)
				d["nose_r"] = er * 0.42 * big
				d["mouth_w"] = mr * 0.9
			"beak":
				var by := ey + er * 1.3
				d["beak_poly"] = PackedVector2Array([
					Vector2(-head_r * 0.22, by - head_r * 0.08),
					Vector2(head_r * 0.22, by - head_r * 0.08),
					Vector2(0, by + head_r * 0.3)])
				d["beak_col"] = col["accent"].lightened(0.1)
			"wide":
				d["mouth_y"] = ey + er * 1.8
				d["mouth_w"] = head_r * 1.3
		face.set_face(d)

	# =========================================================================
	# ACCESSORY (scarf / collar / pendant / flower / satchel / leaf cloak / bell)
	# =========================================================================
	func _build_accessory(sc: float, sw: float, detail: float, body_cy: float, bw: float, bh: float, head_cy: float, head_r: float) -> void:
		var kind := String(traits.get("accessory", "none"))
		if kind == "none" or detail < 0.35:
			accessory.set_data([]); return
		var ls := []
		var neck_y := lerpf(head_cy, body_cy, 0.4)
		var acc: Color = col["rarity"]
		match kind:
			"scarf":
				ls.append({"poly": _ellipse(0, neck_y, bw * 0.4, bh * 0.1, 2.4, 24),
					"top": acc.lightened(0.15), "bot": acc.darkened(0.1), "stroke": col["ink"], "sw": sw * 0.7})
				ls.append({"poly": _capsule(facing * bw * 0.2, neck_y, neck_y + bh * 0.4, bw * 0.12),
					"top": acc.lightened(0.1), "bot": acc.darkened(0.12), "stroke": col["ink"], "sw": sw * 0.6})
			"collar":
				ls.append({"poly": _ellipse(0, neck_y, bw * 0.36, bh * 0.07, 2.6, 24),
					"top": acc, "bot": acc.darkened(0.2), "stroke": col["ink"], "sw": sw * 0.6})
				ls.append({"poly": _ellipse(0, neck_y + bh * 0.06, bw * 0.06, bh * 0.06, 2.2, 12),
					"top": Color("#FFF4D6"), "bot": col["accent"], "stroke": col["ink"], "sw": sw * 0.5})
			"pendant":
				ls.append({"poly": _arc(Vector2(0, neck_y), bw * 0.3, 0.1 * PI, 0.9 * PI, 14),
					"fill": false, "stroke": col["ink"], "sw": sw * 0.5, "close": false})
				ls.append({"poly": _star_poly(Vector2(0, neck_y + bh * 0.18), bw * 0.1, bw * 0.045, 4),
					"top": col["rarity"].lightened(0.2), "bot": col["rarity"], "stroke": col["ink"], "sw": sw * 0.5})
			"flower":
				var fc := Vector2(-head_r * 0.7, head_cy - head_r * 0.4)
				for i in 5:
					var ang := TAU * i / 5.0
					ls.append({"poly": _ellipse(fc.x + cos(ang) * head_r * 0.18, fc.y + sin(ang) * head_r * 0.18, head_r * 0.14, head_r * 0.14, 2.2, 10),
						"top": Color("#FF9BB0"), "bot": Color("#FF7088"), "fill": true, "sw": 0.0})
				ls.append({"poly": _ellipse(fc.x, fc.y, head_r * 0.12, head_r * 0.12, 2.2, 10),
					"top": Color("#FFF4D6"), "bot": col["accent"], "fill": true, "sw": 0.0})
			"satchel":
				var sxp := facing * bw * 0.42
				ls.append({"poly": _ellipse(sxp, body_cy + bh * 0.1, bw * 0.16, bh * 0.2, 3.0, 16),
					"top": Color("#C9955B"), "bot": Color("#8A6A4A"), "stroke": col["ink"], "sw": sw * 0.7})
				ls.append({"poly": _arc(Vector2(0, body_cy - bh * 0.1), bw * 0.42, -0.1 * PI, 0.6 * PI, 14),
					"fill": false, "stroke": Color("#8A6A4A"), "sw": sw * 0.8, "close": false})
			"leaf_cloak":
				ls.append({"poly": _leaf(Vector2(-facing * bw * 0.1, body_cy - bh * 0.2), bh * 0.9 * detail, bw * 0.7, PI * 0.5),
					"top": Color("#86C06C"), "bot": Color("#3F6B3A"), "stroke": col["ink"], "sw": sw * 0.7})
			"bell":
				ls.append({"poly": _ellipse(0, neck_y, bw * 0.34, bh * 0.07, 2.6, 24),
					"top": col["accent"], "bot": col["accent_dk"], "stroke": col["ink"], "sw": sw * 0.5})
				ls.append({"poly": _ellipse(0, neck_y + bh * 0.08, bw * 0.08, bw * 0.08, 2.2, 12),
					"top": Color("#FFC978"), "bot": Color("#E08A4A"), "stroke": col["ink"], "sw": sw * 0.5})
		accessory.set_data(ls)

	# =========================================================================
	# HAT
	# =========================================================================
	func _build_hat(sc: float, sw: float, detail: float, head_cy: float, head_r: float) -> void:
		var kind := String(traits.get("hat", "none"))
		if kind == "none" or detail < 0.4 or head_r <= 1.0:
			hat.set_data([]); return
		hat.position = Vector2(0, head_cy - head_r * 0.85)
		hat.rotation = head_lean
		var ls := []
		match kind:
			"acorn":
				ls.append({"poly": _ellipse(0, 0, head_r * 0.5, head_r * 0.32, 2.4, 20),
					"top": Color("#C9955B"), "bot": Color("#8A6A4A"), "stroke": col["ink"], "sw": sw * 0.7})
				ls.append({"poly": _ellipse(0, -head_r * 0.2, head_r * 0.1, head_r * 0.2, 2.2, 10),
					"top": Color("#8A6A4A"), "bot": Color("#6E5238"), "stroke": col["ink"], "sw": sw * 0.5})
			"leaf":
				ls.append({"poly": _leaf(Vector2(0, head_r * 0.1), head_r * 0.9, head_r * 0.5, -PI * 0.5 - 0.3),
					"top": Color("#86C06C"), "bot": Color("#3F6B3A"), "stroke": col["ink"], "sw": sw * 0.7})
			"crown":
				ls.append({"poly": _star_poly(Vector2(0, head_r * 0.1), head_r * 0.5, head_r * 0.2, 3, -PI / 2.0, false),
					"top": Color("#FFC978"), "bot": Color("#E08A4A"), "stroke": col["ink"], "sw": sw * 0.7})
			"star":
				ls.append({"poly": _star_poly(Vector2(0, 0), head_r * 0.42, head_r * 0.18, 5),
					"top": Color("#FFF4D6"), "bot": Color("#FFC978"), "stroke": col["ink"], "sw": sw * 0.6})
			"mushroom":
				ls.append({"poly": _ellipse(0, 0, head_r * 0.55, head_r * 0.3, 2.2, 22),
					"top": Color("#FF9BB0"), "bot": Color("#E0566F"), "stroke": col["ink"], "sw": sw * 0.7})
				for i in 3:
					var dx := (i - 1) * head_r * 0.25
					ls.append({"poly": _ellipse(dx, -head_r * 0.03, head_r * 0.08, head_r * 0.06, 2.2, 10),
						"top": Color("#FFF4D6"), "bot": Color("#FFF4D6"), "fill": true, "sw": 0.0})
			"bow":
				for s: float in [-1.0, 1.0]:
					ls.append({"poly": PackedVector2Array([Vector2(0, head_r * 0.1),
						Vector2(s * head_r * 0.4, -head_r * 0.15), Vector2(s * head_r * 0.4, head_r * 0.3)]),
						"top": Color("#FF9BB0"), "bot": Color("#E0566F"), "stroke": col["ink"], "sw": sw * 0.6})
				ls.append({"poly": _ellipse(0, head_r * 0.08, head_r * 0.1, head_r * 0.12, 2.2, 10),
					"top": Color("#E0566F"), "bot": Color("#C03B55"), "fill": true, "sw": 0.0})
			"petal", "berry":
				ls.append({"poly": _ellipse(0, head_r * 0.05, head_r * 0.18, head_r * 0.18, 2.2, 12),
					"top": Color("#C79BFF"), "bot": Color("#9B6BE0"), "stroke": col["ink"], "sw": sw * 0.6})
		hat.set_data(ls)

	# =========================================================================
	# AURA (rarity sparkle / glow / starfield)
	# =========================================================================
	func _build_aura(sc: float, body_cy: float, bw: float, bh: float, detail: float) -> void:
		var kind := String(traits.get("aura", "none"))
		aura_back.position = Vector2(0, body_cy)
		aura_front.position = Vector2(0, body_cy)
		aura_back.set_data([], [])
		aura_front.set_data([], [])
		if kind == "none" or detail < 0.3:
			return
		var rc: Color = col["rarity"]
		var r := maxf(bw, bh) * 0.75
		match kind:
			"glow":
				var rings := []
				for i in 3:
					rings.append({"r": r * (0.8 + i * 0.18), "col": Color(rc.r, rc.g, rc.b, 0.12), "w": maxf(3.0, 8.0 * sc)})
				aura_back.set_data([], rings)
			"sparkle":
				var motes := []
				for i in 5:
					var ang := TAU * i / 5.0 + Proc.hashf(seedv, "spk:%d" % i) * TAU
					motes.append({"pos": Vector2(cos(ang), sin(ang)) * r * 0.95, "r": 2.2 * sc, "col": Color(rc.r, rc.g, rc.b, 0.9)})
				aura_front.set_data(motes, [])
			"firefly":
				var motes2 := []
				for i in 7:
					var ang2 := Proc.hashf(seedv, "ff:%d" % i) * TAU
					var rr := r * Proc.rangef(seedv, "ffr:%d" % i, 0.7, 1.2)
					motes2.append({"pos": Vector2(cos(ang2), sin(ang2)) * rr, "r": 2.6 * sc, "col": Color(0.6, 1.0, 0.5, 0.85)})
				aura_front.set_data(motes2, [])
			"starfield", "cosmic":
				var rings2 := [{"r": r, "col": Color(rc.r, rc.g, rc.b, 0.14), "w": maxf(3.0, 10.0 * sc)}]
				aura_back.set_data([], rings2)
				var motes3 := []
				for i in 9:
					var ang3 := Proc.hashf(seedv, "st:%d" % i) * TAU
					var rr3 := r * Proc.rangef(seedv, "str:%d" % i, 0.6, 1.25)
					motes3.append({"pos": Vector2(cos(ang3), sin(ang3)) * rr3, "r": Proc.rangef(seedv, "stsz:%d" % i, 1.4, 3.0) * sc, "col": Color(1, 1, 1, 0.9)})
				aura_front.set_data(motes3, [])

	# =========================================================================
	# MINTED glassy sheen overlay
	# =========================================================================
	func _build_sheen(sc: float, body_cy: float, bw: float, bh: float) -> void:
		if not minted:
			sheen.set_data([]); return
		var ls := []
		# a diagonal glass streak + a cool outline glint
		ls.append({"poly": PackedVector2Array([
			Vector2(-bw * 0.4, body_cy - bh * 0.5),
			Vector2(-bw * 0.1, body_cy - bh * 0.5),
			Vector2(-bw * 0.4, body_cy + bh * 0.5),
			Vector2(-bw * 0.7, body_cy + bh * 0.5)]),
			"top": Color(1, 1, 1, 0.22), "bot": Color(1, 1, 1, 0.04), "fill": true, "sw": 0.0})
		sheen.set_data(ls)

	# =========================================================================
	# ANIMATION — all cheap child-transform work, no per-frame allocation/redraw.
	# =========================================================================
	func _animate(delta: float) -> void:
		var dmp := _damp
		var tt := t

		# breathe (gentle squash-stretch around the torso centre)
		var b := sin(tt * 1.5 + phase) * 0.02 * dmp
		breath.scale = Vector2(1.0 - b * 0.7, 1.0 + b)

		# blink
		_blink_timer -= delta
		if _blink_timer <= 0.0 and _blink_prog <= 0.0:
			_blink_prog = 0.0001
			_blc += 1
			_blink_timer = Proc.rangef(seedv, "blinkiv:%d" % _blc, 2.0, 6.0)
		if _blink_prog > 0.0:
			_blink_prog += delta / 0.15
			var ey := 1.0
			if _blink_prog >= 1.0:
				_blink_prog = 0.0
			else:
				ey = 1.0 - sin(_blink_prog * PI) * 0.92
			eye_l.scale.y = ey
			eye_r.scale.y = ey

		# look around (slow head turn)
		_look_timer -= delta
		if _look_timer <= 0.0:
			_lc += 1
			_look_target = Proc.rangef(seedv, "look:%d" % _lc, -1.0, 1.0)
			_look_timer = Proc.rangef(seedv, "lookiv:%d" % _lc, 2.5, 6.5)
		_look_cur = lerpf(_look_cur, _look_target, clampf(delta * 2.5, 0.0, 1.0))
		head.rotation = head_lean + _look_cur * 0.12 * dmp
		head.position.x = head_base.x + _look_cur * 2.4 * sc_cache * dmp
		var gz := Vector2((facing * 0.18 + _look_cur * 0.5) * eye_l.r, 0)
		eye_l.look = gz; eye_r.look = gz

		# hop (occasional, with anticipation crouch)
		_hop_timer -= delta
		if _hop_timer <= 0.0 and _hop_prog <= 0.0:
			_hop_prog = 0.0001
			_hc += 1
			_hop_timer = Proc.rangef(seedv, "hopiv:%d" % _hc, 6.0, 15.0)
		if _hop_prog > 0.0:
			_hop_prog += delta / 0.55
			if _hop_prog >= 1.0:
				_hop_prog = 0.0
				bounce.position.y = 0.0
				bounce.scale = Vector2.ONE
			else:
				var p := _hop_prog
				var h := sin(p * PI)
				bounce.position.y = -h * hop_h * dmp
				var sq := 1.0 + (h - 0.4) * 0.14 * dmp
				bounce.scale = Vector2(1.0 - (sq - 1.0), sq)

		# ears + tail wiggle (extra swish mid-hop)
		var ew := sin(tt * 2.2 + phase) * 0.06 * dmp
		var hop_boost := (1.0 if _hop_prog > 0.0 else 0.0)
		if ear_l.visible:
			ear_l.rotation = ear_l_rest - ew - hop_boost * 0.1
			ear_r.rotation = ear_r_rest + ew + hop_boost * 0.1
		tail.rotation = tail_rest + sin(tt * 1.8 + phase * 1.3) * 0.2 * dmp + hop_boost * 0.25 * sin(tt * 9.0)

		# wings flap
		var fl := sin(tt * wing_speed + phase) * wing_amp * dmp
		wing_l.rotation = wing_l_rest - fl
		wing_r.rotation = wing_r_rest + fl

		# aura drift + twinkle
		aura_front.rotation += delta * 0.35 * dmp
		aura_back.rotation -= delta * 0.12 * dmp
		var pulse := 0.6 + 0.35 * sin(tt * 1.3 + phase)
		aura_front.self_modulate.a = pulse
		aura_back.self_modulate.a = 0.5 + 0.3 * sin(tt * 0.9 + phase)
