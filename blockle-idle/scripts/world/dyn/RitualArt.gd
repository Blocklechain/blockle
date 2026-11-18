class_name RitualArt
extends RefCounted
# RitualArt — every drawn thing the RITUALS system puts in the world.
#
# DYNAMICS §6.5 asks for a ritual site you can SEE charging: a ring of standing
# stones at the Heart Tree's roots, carved runes that light one by one as offerings
# land on the stones, a column of soft light while a ceremony runs, three vigil
# lanterns for the Ascension nights, a wave of light that crosses the island when a
# rite completes, and — at the very end — the world folding into a seed.
#
# Nothing here is a panel, a bar or a number. The ritual circle IS the progress bar:
# the runes are the fill, the stones are the history (3 → 7 as rites are performed),
# the lanterns are the vigil count, and the brightness is the blessing.
#
# Everything is generated from math (CONVENTIONS rule 1-7):
#   • smooth, hand-drawn outlines (Proc.smooth_loop / superellipse / grad_fill),
#   • seeded + deterministic — the same world always carves the same runes,
#   • growth-staged: the circle unfurls from the soil, stones rise as they are earned,
#   • alive but CHEAP: _draw only re-runs when a shape actually changes; the dust,
#     the lanterns, the light column and the motes animate by child transforms only.
#
# PUBLIC API (all pure factories — Rituals.gd owns the state, this owns the pixels):
#   make_circle(world_seed, key, opts) -> ProcNode
#       opts: {radius, palette}
#       methods on the result:
#           set_stones(n: int)                  3..8 standing stones
#           set_runes(lit: int, total: int)     the charge readout
#           set_offerings(list: Array)          [{mat: String, n: int}, …] resting on stones
#           set_running(on: bool, u: float)     ceremony in progress, u = 0..1
#           set_vigils(n: int)                  0..3 lanterns lit
#           set_blessings(n: int)               ambient brightness (active rites)
#           radius() -> float
#   make_heart_bloom(world_seed, key, opts) -> ProcNode     the Ascension golden bloom
#   make_wave(world_seed, key, opts) -> ProcNode            light crossing the island
#   make_offer_mote(world_seed, key, mat, opts) -> ProcNode  an offering flying to the stones
#   make_keepsake(world_seed, key, opts) -> ProcNode        the "kept" mark on an Everbloom
#   make_seed_fold(world_seed, key, opts) -> ProcNode       the world folds into a seed
#   draw_mat_glyph(ci, pos, r, mat, warm, cool)             one material, drawn small
#
# Twelve material glyphs are drawn here (dewdrop, heartwood, emberbloom, moonsilver,
# skyshard, lichen_wool, honeycomb, river_clay, grainloaf, honeycake, lightwell_glass,
# rootbalm, + kindling_lamp / starcloth) so an offering resting on a stone is
# recognisably the thing you carried there.

const GOLD := Color(1.0, 0.88, 0.56)
const GOLD_HI := Color(1.0, 0.98, 0.84)
const RUNE_DARK := Color(0.22, 0.19, 0.17, 0.55)
const STONE := Color(0.62, 0.60, 0.58)
const STONE_DK := Color(0.33, 0.32, 0.33)
const STONE_LT := Color(0.82, 0.81, 0.78)
const EARTH := Color(0.38, 0.30, 0.22)


# =============================================================================
# FACTORIES
# =============================================================================
static func make_circle(world_seed: int, key: String, opts: Dictionary = {}) -> ProcNode:
	var n := _Circle.new()
	n.seedv = hash("%d:ritual:%s" % [world_seed, key])
	n.wseed = world_seed
	n.ckey = key
	n.ring_r = float(opts.get("radius", 104.0))
	var p: Variant = opts.get("palette", null)
	if p is Dictionary:
		n.pal = p as Dictionary
	else:
		n.pal = Proc.palette(world_seed, "ritual")
	n.footprint_radius = n.ring_r * 1.1
	n.grow_rate = 0.0
	return n


static func make_heart_bloom(world_seed: int, key: String, opts: Dictionary = {}) -> ProcNode:
	var n := _HeartBloom.new()
	n.seedv = hash("%d:bloom:%s" % [world_seed, key])
	n.reach = float(opts.get("radius", 240.0))
	n.grow_rate = 1.0 / float(maxf(4.0, float(opts.get("ramp", 22.0))))
	n.growth = 0.0
	n.z_index = int(opts.get("z", 1))
	return n


static func make_wave(world_seed: int, key: String, opts: Dictionary = {}) -> ProcNode:
	var n := _Wave.new()
	n.seedv = hash("%d:wave:%s" % [world_seed, key])
	n.life = float(opts.get("life", 2.6))
	n.span = float(opts.get("span", 1400.0))
	n.height = float(opts.get("height", 760.0))
	n.dir = 1.0 if float(opts.get("dir", 1.0)) >= 0.0 else -1.0
	var c: Variant = opts.get("color", null)
	if c is Color:
		n.tint = c as Color
	n.z_index = int(opts.get("z", 29))
	n.grow_rate = 0.0
	return n


static func make_offer_mote(world_seed: int, key: String, mat: String, opts: Dictionary = {}) -> ProcNode:
	var n := _OfferMote.new()
	n.seedv = hash("%d:offer:%s" % [world_seed, key])
	n.mat = mat
	n.from_p = opts.get("from", Vector2.ZERO)
	n.to_p = opts.get("to", Vector2.ZERO)
	n.life = float(opts.get("life", 1.15))
	n.arc = float(opts.get("arc", 64.0))
	n.rsize = float(opts.get("size", 13.0))
	if opts.get("on_arrive") is Callable:
		n.on_arrive = opts["on_arrive"]
	n.z_index = int(opts.get("z", 30))
	n.grow_rate = 0.0
	return n


static func make_keepsake(world_seed: int, key: String, opts: Dictionary = {}) -> ProcNode:
	var n := _Keepsake.new()
	n.seedv = hash("%d:keep:%s" % [world_seed, key])
	n.ring_r = float(opts.get("radius", 46.0))
	n.z_index = int(opts.get("z", 0))
	n.grow_rate = 0.0
	n.growth = 0.0
	return n


static func make_seed_fold(world_seed: int, key: String, opts: Dictionary = {}) -> ProcNode:
	var n := _SeedFold.new()
	n.seedv = hash("%d:fold:%s" % [world_seed, key])
	n.life = float(opts.get("life", 5.0))
	n.reach = float(opts.get("radius", 620.0))
	n.z_index = int(opts.get("z", 34))
	n.grow_rate = 0.0
	return n


# =============================================================================
# SHARED PRIMITIVES
# =============================================================================

# A flattened ground ellipse as a polygon (feet-at-origin friendly).
static func ellipse(rx: float, ry: float, steps: int = 30, off: Vector2 = Vector2.ZERO) -> PackedVector2Array:
	var pts := PackedVector2Array()
	var n: int = maxi(6, steps)
	for i in range(n):
		var a: float = TAU * float(i) / float(n)
		pts.append(off + Vector2(cos(a) * rx, sin(a) * ry))
	return pts


# A soft glowing dot: a few stacked translucent discs, cheapest possible "light".
static func soft(ci: CanvasItem, pos: Vector2, r: float, col: Color, layers: int = 4) -> void:
	if r <= 0.3 or col.a <= 0.004:
		return
	var n: int = maxi(1, layers)
	for i in range(n):
		var k: float = 1.0 - float(i) / float(n)
		var rr: float = r * (0.35 + 0.65 * (1.0 - k))
		var a: float = col.a * (0.1 + 0.42 * k)
		ci.draw_circle(pos, rr, Color(col.r, col.g, col.b, a))


# A rune: a seeded little carved mark, 2-4 strokes, drawn into a box of size `s`.
static func rune_strokes(world_seed: int, key: String, s: float) -> Array:
	var out: Array = []
	var strokes: int = 2 + int(Proc.hashf(world_seed, key + ":n") * 3.0)
	for i in range(strokes):
		var k := "%s:%d" % [key, i]
		var ax: float = Proc.rangef(world_seed, k + "ax", -0.5, 0.5) * s
		var ay: float = Proc.rangef(world_seed, k + "ay", -0.5, 0.5) * s
		var bx: float = Proc.rangef(world_seed, k + "bx", -0.5, 0.5) * s
		var by: float = Proc.rangef(world_seed, k + "by", -0.5, 0.5) * s
		# snap to a rough lattice so marks read as carved language, not scribble
		ax = round(ax / (s * 0.25)) * (s * 0.25)
		ay = round(ay / (s * 0.25)) * (s * 0.25)
		bx = round(bx / (s * 0.25)) * (s * 0.25)
		by = round(by / (s * 0.25)) * (s * 0.25)
		if Vector2(ax - bx, ay - by).length() < s * 0.2:
			bx = -ax
			by = -ay
		out.append([Vector2(ax, ay), Vector2(bx, by)])
	return out


# One material, drawn small and recognisable. `warm`/`cool` let the caller tint it
# into the local palette without the glyph losing its identity.
static func draw_mat_glyph(ci: CanvasItem, pos: Vector2, r: float, mat: String, warm: Color = GOLD, cool: Color = Color(0.72, 0.86, 1.0)) -> void:
	var ink := Color(0.20, 0.16, 0.13, 0.75)
	match mat:
		"dewdrop":
			var d := PackedVector2Array()
			d.append(pos + Vector2(0, -r))
			for i in range(13):
				var a: float = PI * 0.5 + TAU * float(i) / 13.0
				d.append(pos + Vector2(cos(a) * r * 0.62, r * 0.28 + sin(a) * r * 0.6))
			ci.draw_colored_polygon(d, cool.lerp(Color(1, 1, 1, 1), 0.25))
			soft(ci, pos + Vector2(-r * 0.2, r * 0.1), r * 0.4, Color(1, 1, 1, 0.5), 3)
		"heartwood":
			var body := Proc.superellipse(r * 0.9, r * 0.5, 3.4, 22)
			var bp := PackedVector2Array()
			for p in body:
				bp.append(pos + p)
			ci.draw_polygon(bp, Proc.grad_fill(bp, Color(0.62, 0.44, 0.28), Color(0.38, 0.26, 0.17)))
			for i in range(3):
				ci.draw_arc(pos + Vector2(r * 0.34, 0), r * 0.1 * float(i + 1), 0.0, TAU, 14, Color(0.84, 0.68, 0.46, 0.8), 1.6, true)
		"emberbloom":
			var f := PackedVector2Array()
			f.append(pos + Vector2(0, -r * 1.05))
			f.append(pos + Vector2(r * 0.52, -r * 0.1))
			f.append(pos + Vector2(r * 0.26, r * 0.5))
			f.append(pos + Vector2(-r * 0.26, r * 0.5))
			f.append(pos + Vector2(-r * 0.52, -r * 0.1))
			var fs := Proc.smooth_loop(f, 7)
			ci.draw_polygon(fs, Proc.grad_fill(fs, Color(1.0, 0.92, 0.55), Color(0.95, 0.42, 0.22)))
			soft(ci, pos + Vector2(0, -r * 0.2), r * 0.7, Color(1.0, 0.7, 0.35, 0.45), 3)
		"moonsilver":
			var c1 := PackedVector2Array()
			for i in range(22):
				var a: float = -PI * 0.5 + PI * float(i) / 21.0
				c1.append(pos + Vector2(cos(a) * r * 0.86, sin(a) * r * 0.86))
			for i in range(22):
				var a2: float = PI * 0.5 - PI * float(i) / 21.0
				c1.append(pos + Vector2(cos(a2) * r * 0.86 - r * 0.42, sin(a2) * r * 0.78))
			ci.draw_colored_polygon(c1, Color(0.88, 0.92, 1.0, 0.95))
			soft(ci, pos, r * 0.9, Color(0.8, 0.88, 1.0, 0.35), 3)
		"skyshard":
			for i in range(4):
				var a3: float = TAU * float(i) / 4.0 + PI * 0.25
				var tip: Vector2 = pos + Vector2(cos(a3), sin(a3)) * r * 1.15
				var l: Vector2 = pos + Vector2(cos(a3 + PI * 0.5), sin(a3 + PI * 0.5)) * r * 0.3
				var rr: Vector2 = pos + Vector2(cos(a3 - PI * 0.5), sin(a3 - PI * 0.5)) * r * 0.3
				ci.draw_colored_polygon(PackedVector2Array([tip, l, rr]), Color(0.78, 0.86, 1.0, 0.92))
			soft(ci, pos, r * 0.8, Color(0.9, 0.95, 1.0, 0.5), 3)
		"lichen_wool":
			var sp := PackedVector2Array()
			for i in range(44):
				var u: float = float(i) / 43.0
				var a4: float = u * TAU * 2.2
				var rad: float = r * (0.16 + 0.78 * u)
				sp.append(pos + Vector2(cos(a4) * rad, sin(a4) * rad * 0.82))
			ci.draw_polyline(sp, Color(0.74, 0.78, 0.64), 2.6, true)
			soft(ci, pos, r * 0.5, Color(0.86, 0.9, 0.76, 0.3), 2)
		"honeycomb":
			var hx := PackedVector2Array()
			for i in range(6):
				var a5: float = TAU * float(i) / 6.0 + PI / 6.0
				hx.append(pos + Vector2(cos(a5) * r, sin(a5) * r * 0.92))
			ci.draw_polygon(hx, Proc.grad_fill(hx, Color(1.0, 0.86, 0.45), Color(0.86, 0.62, 0.2)))
			var hi := PackedVector2Array()
			for i in range(6):
				var a6: float = TAU * float(i) / 6.0 + PI / 6.0
				hi.append(pos + Vector2(cos(a6) * r * 0.5, sin(a6) * r * 0.46))
			ci.draw_colored_polygon(hi, Color(1.0, 0.94, 0.68, 0.8))
		"river_clay":
			var lump := Proc.blob(1337, "clay", r * 0.95, 7, 0.22)
			var lp := PackedVector2Array()
			for p in lump:
				lp.append(pos + Vector2(p.x, p.y * 0.72))
			ci.draw_polygon(lp, Proc.grad_fill(lp, Color(0.72, 0.56, 0.44), Color(0.45, 0.33, 0.26)))
		"grainloaf":
			var loaf := PackedVector2Array()
			for i in range(18):
				var a7: float = PI + PI * float(i) / 17.0
				loaf.append(pos + Vector2(cos(a7) * r, sin(a7) * r * 0.82 + r * 0.26))
			loaf.append(pos + Vector2(r * 0.92, r * 0.3))
			loaf.append(pos + Vector2(-r * 0.92, r * 0.3))
			ci.draw_polygon(loaf, Proc.grad_fill(loaf, Color(0.93, 0.76, 0.46), Color(0.68, 0.46, 0.25)))
			for i in range(3):
				var x: float = -r * 0.44 + r * 0.44 * float(i)
				ci.draw_line(pos + Vector2(x - r * 0.1, -r * 0.3), pos + Vector2(x + r * 0.14, -r * 0.08), Color(0.56, 0.37, 0.2, 0.8), 1.8, true)
		"honeycake":
			for i in range(3):
				var y: float = r * 0.34 - r * 0.34 * float(i)
				var w: float = r * (0.92 - 0.1 * float(i))
				var lay := Proc.superellipse(w, r * 0.2, 3.2, 20)
				var lp2 := PackedVector2Array()
				for p in lay:
					lp2.append(pos + p + Vector2(0, y))
				ci.draw_polygon(lp2, Proc.grad_fill(lp2, Color(1.0, 0.84, 0.56), Color(0.78, 0.5, 0.28)))
			soft(ci, pos + Vector2(0, -r * 0.5), r * 0.4, Color(1.0, 0.92, 0.6, 0.5), 3)
		"lightwell_glass":
			var pane := PackedVector2Array([
				pos + Vector2(0, -r * 1.1), pos + Vector2(r * 0.74, 0),
				pos + Vector2(0, r * 1.1), pos + Vector2(-r * 0.74, 0)])
			ci.draw_polygon(pane, Proc.grad_fill(pane, Color(0.92, 0.98, 1.0, 0.95), Color(0.56, 0.78, 0.92, 0.85)))
			ci.draw_line(pos + Vector2(0, -r), pos + Vector2(0, r), Color(1, 1, 1, 0.55), 1.4, true)
			soft(ci, pos, r * 1.0, Color(0.85, 0.95, 1.0, 0.4), 3)
		"rootbalm":
			var jar := Proc.superellipse(r * 0.68, r * 0.84, 3.0, 22)
			var jp := PackedVector2Array()
			for p in jar:
				jp.append(pos + p + Vector2(0, r * 0.1))
			ci.draw_polygon(jp, Proc.grad_fill(jp, Color(0.56, 0.74, 0.52), Color(0.28, 0.44, 0.3)))
			ci.draw_colored_polygon(PackedVector2Array([
				pos + Vector2(-r * 0.5, -r * 0.62), pos + Vector2(r * 0.5, -r * 0.62),
				pos + Vector2(r * 0.42, -r * 0.88), pos + Vector2(-r * 0.42, -r * 0.88)]),
				Color(0.74, 0.62, 0.42))
		"kindling_lamp":
			ci.draw_colored_polygon(PackedVector2Array([
				pos + Vector2(-r * 0.5, r * 0.6), pos + Vector2(r * 0.5, r * 0.6),
				pos + Vector2(r * 0.36, -r * 0.5), pos + Vector2(-r * 0.36, -r * 0.5)]),
				Color(0.42, 0.36, 0.3, 0.9))
			soft(ci, pos, r * 0.9, Color(1.0, 0.82, 0.44, 0.6), 4)
		"starcloth":
			var cl := PackedVector2Array([
				pos + Vector2(-r, r * 0.3), pos + Vector2(-r * 0.3, -r * 0.5),
				pos + Vector2(r * 0.5, -r * 0.2), pos + Vector2(r * 0.9, r * 0.5),
				pos + Vector2(0, r * 0.8)])
			var cs := Proc.smooth_loop(cl, 6)
			ci.draw_polygon(cs, Proc.grad_fill(cs, Color(0.84, 0.86, 0.96), Color(0.44, 0.48, 0.66)))
			for i in range(3):
				soft(ci, pos + Vector2(-r * 0.3 + r * 0.4 * float(i), r * 0.05), r * 0.14, Color(1, 1, 1, 0.8), 2)
		_:
			# an unknown offering still reads as "something precious"
			ci.draw_circle(pos, r * 0.7, warm.lerp(Color(1, 1, 1, 1), 0.2))
			ci.draw_arc(pos, r * 0.92, 0.0, TAU, 20, ink, 1.6, true)


# =============================================================================
#  _Circle — THE RITUAL CIRCLE.  A worn earth ring at the Heart Tree's roots,
#  ringed by standing stones, carved with runes that light as offerings land, and
#  crowned by a column of soft light while a ceremony runs.
# =============================================================================
class _Circle extends ProcNode:
	var wseed: int = 1
	var ckey: String = "circle"
	var pal: Dictionary = {}
	var ring_r: float = 104.0
	var footprint_radius: float = 110.0

	var stones: int = 3
	var runes_lit: int = 0
	var runes_total: int = 7
	var offerings: Array = []          # [{mat: String, n: int}, …]
	var vigils: int = 0
	var blessings: int = 0
	var running: bool = false
	var run_u: float = 0.0

	var _dust: Array = []              # Array[_Dust]
	var _lamps: Array = []             # Array[_Lamp]
	var _column: _Column
	var _core: _Core
	var _stone_cache: Array = []       # per-stone {pos, pts, cap, h}
	var _cache_for: int = -1

	func _on_built() -> void:
		z_index = 2
		_core = _Core.new()
		_core.owner_circle = self
		_core.z_index = -1
		add_child(_core)
		_column = _Column.new()
		_column.owner_circle = self
		_column.z_index = 3
		_column.visible = false
		add_child(_column)
		for i in range(7):
			var d := _Dust.new()
			d.seedv = hash("%d:dust:%d" % [wseed, i])
			d.base = Vector2(Proc.rangef(wseed, "dx:%d" % i, -ring_r * 0.6, ring_r * 0.6), 0.0)
			d.speed = Proc.rangef(wseed, "ds:%d" % i, 10.0, 24.0)
			d.reach = Proc.rangef(wseed, "dr:%d" % i, 60.0, 150.0)
			d.rsize = Proc.rangef(wseed, "dz:%d" % i, 1.6, 3.4)
			d.off = Proc.hashf(wseed, "do:%d" % i)
			d.z_index = 2
			add_child(d)
			_dust.append(d)
		for i in range(3):
			var l := _Lamp.new()
			l.seedv = hash("%d:lamp:%d" % [wseed, i])
			var a: float = PI + PI * (0.18 + 0.32 * float(i))
			l.position = Vector2(cos(a) * ring_r * 1.42, sin(a) * ring_r * 0.5 - 2.0)
			l.z_index = 4 if l.position.y > 0.0 else 0
			add_child(l)
			_lamps.append(l)

	# ---- setters (each only invalidates what it must) -----------------------
	func set_stones(n: int) -> void:
		var v: int = clampi(n, 3, 8)
		if v == stones:
			return
		stones = v
		_stone_cache.clear()
		queue_redraw()

	func set_runes(lit: int, total: int) -> void:
		var t: int = maxi(1, total)
		var l: int = clampi(lit, 0, t)
		if l == runes_lit and t == runes_total:
			return
		runes_lit = l
		runes_total = t
		queue_redraw()

	func set_offerings(list: Array) -> void:
		if list.size() == offerings.size():
			var same := true
			for i in range(list.size()):
				var a: Dictionary = list[i]
				var b: Dictionary = offerings[i]
				if String(a.get("mat", "")) != String(b.get("mat", "")) or int(a.get("n", 0)) != int(b.get("n", 0)):
					same = false
					break
			if same:
				return
		offerings = list.duplicate(true)
		queue_redraw()

	func set_running(on: bool, u: float) -> void:
		run_u = clampf(u, 0.0, 1.0)
		if on == running:
			return
		running = on
		if _column != null and is_instance_valid(_column):
			_column.visible = on
			_column.scale = Vector2(1.0, 0.02 if on else 1.0)
		queue_redraw()

	func set_vigils(n: int) -> void:
		var v: int = clampi(n, 0, 3)
		if v == vigils:
			return
		vigils = v
		for i in range(_lamps.size()):
			var l: _Lamp = _lamps[i]
			if is_instance_valid(l):
				l.set_lit(i < v)

	func set_blessings(n: int) -> void:
		blessings = clampi(n, 0, 4)

	func radius() -> float:
		return ring_r

	# ---- life --------------------------------------------------------------
	func _animate(delta: float) -> void:
		var breath: float = 0.5 + 0.5 * sin(t * 0.7 + phase)
		if _core != null and is_instance_valid(_core):
			var warmth: float = 0.25 + 0.14 * float(blessings) + (0.35 * run_u if running else 0.0)
			_core.modulate.a = clampf((0.35 + 0.3 * breath) * (0.5 + warmth), 0.08, 1.0)
			_core.scale = Vector2.ONE * (0.96 + 0.05 * breath)
		if running and _column != null and is_instance_valid(_column):
			var open: float = smoothstep(0.0, 0.14, run_u) * (1.0 - smoothstep(0.92, 1.0, run_u))
			_column.scale = Vector2(0.86 + 0.2 * breath, maxf(0.02, open))
			_column.modulate.a = clampf(0.3 + 0.5 * open, 0.0, 1.0)
		var busy: float = 1.0 if running else (0.35 + 0.2 * float(blessings))
		for d in _dust:
			var dd: _Dust = d
			if is_instance_valid(dd):
				dd.rate = busy
				dd.step(delta)

	func _draw() -> void:
		var gv: float = g()
		if gv <= 0.004:
			return
		var r: float = ring_r * (0.45 + 0.55 * gv)
		var soil: Color = _pal_col("soil", RitualArt.EARTH)
		# 1. contact shadow — the circle sits IN the ground, not on it
		var sh := RitualArt.ellipse(r * 1.5, r * 0.56, 34)
		draw_colored_polygon(sh, Color(0.05, 0.04, 0.03, 0.2 * gv))
		# 2. the worn earth ring: a packed-earth annulus, trodden pale at the rim
		var outer := RitualArt.ellipse(r * 1.34, r * 0.5, 40)
		draw_polygon(outer, Proc.grad_fill(outer,
			soil.lightened(0.26), soil.darkened(0.2)))
		var inner := RitualArt.ellipse(r * 1.02, r * 0.37, 36)
		draw_polygon(inner, Proc.grad_fill(inner,
			soil.darkened(0.12), soil.darkened(0.34)))
		# a faint trodden highlight along the ring's near edge
		var rim := RitualArt.ellipse(r * 1.18, r * 0.44, 46)
		var rim_line := rim
		rim_line.append(rim[0])
		draw_polyline(rim_line, Color(0.9, 0.84, 0.7, 0.14 * gv), 2.0, true)
		# 3. the runes, carved on the ring, lighting one by one as offerings land
		_draw_runes(r, gv)
		# 4. the standing stones (back ones first so the near ones overlap)
		_ensure_stones(r)
		for item in _stone_cache:
			var s: Dictionary = item
			_draw_stone(s, gv)
		# 5. offerings resting on the stone tops
		_draw_offerings(gv)
		# 6. the centre: a low luminous disc of gathered light
		var cr: float = r * 0.5 * (0.6 + 0.4 * gv)
		var warm: Color = RitualArt.GOLD
		for i in range(4):
			var k: float = 1.0 - float(i) / 4.0
			var e := RitualArt.ellipse(cr * (0.4 + 0.75 * (1.0 - k)), cr * (0.16 + 0.3 * (1.0 - k)), 24)
			draw_colored_polygon(e, Color(warm.r, warm.g, warm.b, 0.06 + 0.07 * k))

	func _draw_runes(r: float, gv: float) -> void:
		var n: int = maxi(1, runes_total)
		for i in range(n):
			var a: float = PI * 0.08 + TAU * float(i) / float(n)
			var p := Vector2(cos(a) * r * 1.18, sin(a) * r * 0.44)
			var lit: bool = i < runes_lit
			var s: float = r * 0.17
			var strokes: Array = RitualArt.rune_strokes(wseed, "%s:rune:%d" % [ckey, i], s)
			var col: Color = RitualArt.RUNE_DARK
			if lit:
				var pulse: float = 0.72 + 0.28 * sin(t * 2.0 + float(i) * 0.7 + phase)
				col = Color(RitualArt.GOLD_HI.r, RitualArt.GOLD_HI.g, RitualArt.GOLD_HI.b, 0.55 + 0.4 * pulse)
				RitualArt.soft(self, p, s * 1.5, Color(RitualArt.GOLD.r, RitualArt.GOLD.g, RitualArt.GOLD.b, 0.4 * pulse), 3)
			for st in strokes:
				var pair: Array = st
				var a0: Vector2 = pair[0]
				var b0: Vector2 = pair[1]
				draw_line(p + Vector2(a0.x, a0.y * 0.46), p + Vector2(b0.x, b0.y * 0.46),
					Color(col.r, col.g, col.b, col.a * gv), maxf(1.4, s * 0.17), true)

	func _ensure_stones(r: float) -> void:
		if _cache_for == stones and not _stone_cache.is_empty():
			return
		_cache_for = stones
		_stone_cache.clear()
		for i in range(stones):
			# arranged around the ring, biased to the back half so the circle's
			# mouth stays open toward the camera
			var u: float = float(i) / float(maxi(1, stones))
			var a: float = PI * 1.08 + u * PI * 1.84 + Proc.rangef(wseed, "%s:sa:%d" % [ckey, i], -0.1, 0.1)
			var pos := Vector2(cos(a) * r * 1.26, sin(a) * r * 0.47)
			var h: float = r * Proc.rangef(wseed, "%s:sh:%d" % [ckey, i], 0.72, 1.18)
			var w: float = r * Proc.rangef(wseed, "%s:sw:%d" % [ckey, i], 0.2, 0.31)
			# a weathered monolith: a tapered, slightly leaning smooth loop
			var lean: float = Proc.rangef(wseed, "%s:sl:%d" % [ckey, i], -0.12, 0.12)
			var ctrl := PackedVector2Array()
			ctrl.append(Vector2(-w, 0.0))
			ctrl.append(Vector2(-w * Proc.rangef(wseed, "%s:sq:%d" % [ckey, i], 0.72, 0.98) + lean * h * 0.4, -h * 0.46))
			ctrl.append(Vector2(-w * 0.52 + lean * h, -h * 0.94))
			ctrl.append(Vector2(w * 0.5 + lean * h, -h))
			ctrl.append(Vector2(w * 0.78 + lean * h * 0.4, -h * 0.5))
			ctrl.append(Vector2(w * 1.02, 0.0))
			var pts := Proc.smooth_loop(ctrl, 7)
			_stone_cache.append({
				"pos": pos, "pts": pts, "h": h, "w": w,
				"cap": Vector2(lean * h * 0.8, -h),
				"tone": Proc.hashf(wseed, "%s:st:%d" % [ckey, i]),
			})

	func _draw_stone(s: Dictionary, gv: float) -> void:
		var pos: Vector2 = s["pos"]
		var raw: PackedVector2Array = s["pts"]
		var tone: float = float(s["tone"])
		var rise: float = 0.3 + 0.7 * gv
		var pts := PackedVector2Array()
		for p in raw:
			pts.append(pos + Vector2(p.x * (0.7 + 0.3 * gv), p.y * rise))
		# ground shadow at its foot
		draw_colored_polygon(RitualArt.ellipse(float(s["w"]) * 1.5, float(s["w"]) * 0.42, 18, pos),
			Color(0.05, 0.04, 0.03, 0.22))
		var base: Color = RitualArt.STONE.lerp(_pal_col("base_dk", RitualArt.STONE_DK), 0.22 + 0.2 * tone)
		draw_polygon(pts, Proc.grad_fill(pts,
			base.lerp(RitualArt.STONE_LT, 0.34), base.darkened(0.3)))
		# a light-catching edge on the side facing the Heart Tree's glow
		var edge := PackedVector2Array()
		for i in range(raw.size()):
			var p: Vector2 = raw[i]
			if p.x < 0.0 and p.y < -1.0:
				edge.append(pos + Vector2(p.x * (0.7 + 0.3 * gv), p.y * rise))
		if edge.size() > 2:
			draw_polyline(edge, Color(1.0, 0.96, 0.88, 0.18 + 0.1 * gv), 2.2, true)
		# moss freckles near the base (the island has been here a while)
		var moss: Color = _pal_col("base", Color(0.46, 0.62, 0.38))
		for i in range(3):
			var mx: float = Proc.rangef(wseed, "%s:m%d" % [ckey, i], -0.6, 0.6) * float(s["w"])
			var my: float = -float(s["h"]) * rise * Proc.rangef(wseed, "%s:my%d" % [ckey, i], 0.04, 0.3)
			draw_circle(pos + Vector2(mx, my), maxf(1.2, float(s["w"]) * 0.14), Color(moss.r, moss.g, moss.b, 0.3))

	func _draw_offerings(gv: float) -> void:
		if offerings.is_empty() or _stone_cache.is_empty():
			return
		var slot := 0
		for item in offerings:
			var o: Dictionary = item
			var mat: String = String(o.get("mat", ""))
			var count: int = maxi(1, int(o.get("n", 1)))
			for k in range(mini(count, 3)):
				var s: Dictionary = _stone_cache[slot % _stone_cache.size()]
				var pos: Vector2 = s["pos"]
				var cap: Vector2 = s["cap"]
				var top := pos + Vector2(cap.x * (0.7 + 0.3 * gv), cap.y * (0.3 + 0.7 * gv))
				var jitter := Vector2(
					Proc.rangef(wseed, "%s:oj%d" % [mat, slot], -4.0, 4.0),
					Proc.rangef(wseed, "%s:ok%d" % [mat, slot], -3.0, 1.0))
				var lift: float = 2.0 + 1.6 * sin(t * 1.3 + float(slot) * 0.9 + phase)
				RitualArt.draw_mat_glyph(self, top + jitter + Vector2(0, -8.0 - lift), 10.0, mat)
				slot += 1

	func _pal_col(key: String, fb: Color) -> Color:
		var v: Variant = pal.get(key, null)
		if v is Color:
			return v as Color
		return fb


	# ---- the glow core: a separate child so the heavy ring never redraws for it
	class _Core extends Node2D:
		var owner_circle: _Circle

		func _draw() -> void:
			if owner_circle == null or not is_instance_valid(owner_circle):
				return
			var r: float = owner_circle.radius()
			RitualArt.soft(self, Vector2(0, -r * 0.1), r * 0.9,
				Color(RitualArt.GOLD.r, RitualArt.GOLD.g, RitualArt.GOLD.b, 0.5), 5)

	# ---- the column of light that stands in the ring while a rite runs ------
	class _Column extends Node2D:
		var owner_circle: _Circle

		func _draw() -> void:
			if owner_circle == null or not is_instance_valid(owner_circle):
				return
			var r: float = owner_circle.radius()
			var h: float = r * 5.2
			var pts := PackedVector2Array([
				Vector2(-r * 0.62, 0.0), Vector2(-r * 0.2, -h),
				Vector2(r * 0.2, -h), Vector2(r * 0.62, 0.0)])
			draw_polygon(pts, Proc.grad_fill(pts,
				Color(1.0, 0.97, 0.84, 0.0), Color(1.0, 0.92, 0.6, 0.42)))
			var inner := PackedVector2Array([
				Vector2(-r * 0.26, 0.0), Vector2(-r * 0.08, -h * 0.9),
				Vector2(r * 0.08, -h * 0.9), Vector2(r * 0.26, 0.0)])
			draw_polygon(inner, Proc.grad_fill(inner,
				Color(1, 1, 1, 0.0), Color(1, 1, 1, 0.5)))
			RitualArt.soft(self, Vector2(0, -r * 0.2), r * 1.3, Color(1.0, 0.94, 0.7, 0.5), 5)

	# ---- a rising dust mote (transform-animated; draws once) ----------------
	class _Dust extends Node2D:
		var seedv: int = 1
		var base: Vector2 = Vector2.ZERO
		var speed: float = 16.0
		var reach: float = 100.0
		var rsize: float = 2.4
		var off: float = 0.0
		var rate: float = 1.0
		var _u: float = 0.0

		func _ready() -> void:
			_u = off
			position = base

		func step(delta: float) -> void:
			_u += delta * speed / maxf(1.0, reach) * maxf(0.15, rate)
			if _u >= 1.0:
				_u -= 1.0
			var y: float = -reach * _u
			var x: float = base.x + sin((_u * 3.4 + off * TAU)) * 9.0
			position = Vector2(x, y)
			var fade: float = sin(_u * PI)
			modulate.a = clampf(fade * 0.8, 0.0, 1.0)
			scale = Vector2.ONE * (0.6 + 0.5 * fade)

		func _draw() -> void:
			RitualArt.soft(self, Vector2.ZERO, rsize * 2.4, Color(1.0, 0.93, 0.7, 0.8), 3)

	# ---- a vigil lantern: unlit stone cup, then a held flame ---------------
	class _Lamp extends Node2D:
		var seedv: int = 1
		var lit: bool = false
		var _t: float = 0.0

		func _ready() -> void:
			set_process(true)

		func set_lit(on: bool) -> void:
			if on == lit:
				return
			lit = on
			queue_redraw()
			if on:
				var tw := create_tween().set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
				scale = Vector2(0.7, 0.7)
				tw.tween_property(self, "scale", Vector2.ONE, 0.5)

		func _process(delta: float) -> void:
			_t += delta
			if lit:
				var b: float = 0.88 + 0.12 * sin(_t * 3.1 + float(seedv % 97) * 0.07)
				scale = Vector2(scale.x, b)

		func _draw() -> void:
			# a small stone cup on a stubby post
			var post := PackedVector2Array([
				Vector2(-3.4, 0.0), Vector2(-2.2, -16.0),
				Vector2(2.2, -16.0), Vector2(3.4, 0.0)])
			draw_polygon(post, Proc.grad_fill(post, Color(0.5, 0.46, 0.42), Color(0.3, 0.27, 0.25)))
			var cup := Proc.superellipse(7.5, 4.6, 3.0, 20)
			var cp := PackedVector2Array()
			for p in cup:
				cp.append(p + Vector2(0, -18.0))
			draw_polygon(cp, Proc.grad_fill(cp, Color(0.62, 0.58, 0.54), Color(0.34, 0.31, 0.3)))
			if lit:
				var flame := PackedVector2Array([
					Vector2(0, -32.0), Vector2(4.0, -22.0),
					Vector2(0, -17.0), Vector2(-4.0, -22.0)])
				var fs := Proc.smooth_loop(flame, 6)
				draw_polygon(fs, Proc.grad_fill(fs, Color(1.0, 0.98, 0.8), Color(1.0, 0.62, 0.24)))
				RitualArt.soft(self, Vector2(0, -23.0), 22.0, Color(1.0, 0.82, 0.46, 0.55), 5)


# =============================================================================
#  _HeartBloom — the Heart Tree's slow golden bloom when Ascension is ready.
#  It is an overlay child of the Heart Tree node, so it pans and scales with it.
# =============================================================================
class _HeartBloom extends ProcNode:
	var reach: float = 240.0
	var _petals: Node2D
	var _ring: Node2D

	func _on_built() -> void:
		_ring = _BloomRing.new()
		_ring.set("owner_bloom", self)
		add_child(_ring)
		_petals = Node2D.new()
		add_child(_petals)
		for i in range(12):
			var p := _Petal.new()
			p.seedv = hash("%d:petal:%d" % [seedv, i])
			p.idx = i
			p.of = 12
			p.reach = reach
			_petals.add_child(p)

	func _animate(_delta: float) -> void:
		var gv: float = g()
		if _petals != null and is_instance_valid(_petals):
			_petals.rotation = t * 0.055
			_petals.scale = Vector2.ONE * (0.6 + 0.4 * gv) * (0.98 + 0.02 * sin(t * 0.8 + phase))
			_petals.modulate.a = clampf(gv * 0.9, 0.0, 1.0)
		if _ring != null and is_instance_valid(_ring):
			_ring.scale = Vector2.ONE * (0.8 + 0.25 * gv + 0.03 * sin(t * 0.6))
			_ring.modulate.a = clampf(gv, 0.0, 1.0)

	func _draw() -> void:
		var gv: float = g()
		if gv <= 0.01:
			return
		RitualArt.soft(self, Vector2(0, -reach * 0.55), reach * 1.25 * gv,
			Color(1.0, 0.9, 0.58, 0.3 * gv), 6)

	class _BloomRing extends Node2D:
		var owner_bloom: _HeartBloom

		func _draw() -> void:
			var r: float = 220.0
			if owner_bloom != null and is_instance_valid(owner_bloom):
				r = owner_bloom.reach
			for i in range(3):
				var rr: float = r * (0.7 + 0.22 * float(i))
				draw_arc(Vector2(0, -r * 0.55), rr, 0.0, TAU, 56,
					Color(1.0, 0.94, 0.72, 0.13 - 0.03 * float(i)), 2.4, true)

	class _Petal extends Node2D:
		var seedv: int = 1
		var idx: int = 0
		var of: int = 12
		var reach: float = 240.0

		func _draw() -> void:
			var a: float = TAU * float(idx) / float(maxi(1, of))
			var rad: float = reach * (0.62 + Proc.hashf(seedv, "pr") * 0.3)
			var c := Vector2(cos(a) * rad, sin(a) * rad * 0.7 - reach * 0.55)
			var w: float = reach * 0.1
			var ctrl := PackedVector2Array([
				c + Vector2(-w, 0), c + Vector2(0, -w * 2.1),
				c + Vector2(w, 0), c + Vector2(0, w * 1.2)])
			var pts := Proc.smooth_loop(ctrl, 7)
			draw_polygon(pts, Proc.grad_fill(pts,
				Color(1.0, 0.98, 0.86, 0.6), Color(1.0, 0.82, 0.42, 0.25)))
			RitualArt.soft(self, c, w * 1.6, Color(1.0, 0.9, 0.6, 0.3), 3)


# =============================================================================
#  _Wave — the wave of light that crosses the island when a rite completes.
# =============================================================================
class _Wave extends ProcNode:
	var life: float = 2.6
	var span: float = 1400.0
	var height: float = 760.0
	var dir: float = 1.0
	var tint: Color = Color(1.0, 0.94, 0.72)
	var _body: Node2D

	func _on_built() -> void:
		_body = _WaveBody.new()
		_body.set("owner_wave", self)
		add_child(_body)

	func _animate(_delta: float) -> void:
		var u: float = clampf(t / maxf(0.1, life), 0.0, 1.0)
		var ue: float = u * u * (3.0 - 2.0 * u)
		if _body != null and is_instance_valid(_body):
			_body.position = Vector2((-0.55 + 1.1 * ue) * span * dir, 0.0)
			_body.scale = Vector2(1.0 + 0.3 * sin(u * PI), 1.0)
		modulate.a = sin(u * PI)
		if u >= 1.0:
			queue_free()

	class _WaveBody extends Node2D:
		var owner_wave: _Wave

		func _draw() -> void:
			var h: float = 760.0
			var col := Color(1.0, 0.94, 0.72)
			if owner_wave != null and is_instance_valid(owner_wave):
				h = owner_wave.height
				col = owner_wave.tint
			var w: float = h * 0.12
			var pts := PackedVector2Array([
				Vector2(-w, -h * 0.75), Vector2(w, -h * 0.75),
				Vector2(w * 0.6, h * 0.25), Vector2(-w * 0.6, h * 0.25)])
			draw_polygon(pts, PackedColorArray([
				Color(col.r, col.g, col.b, 0.0), Color(col.r, col.g, col.b, 0.34),
				Color(col.r, col.g, col.b, 0.3), Color(col.r, col.g, col.b, 0.0)]))
			for i in range(5):
				var y: float = -h * 0.7 + h * 0.22 * float(i)
				RitualArt.soft(self, Vector2(0, y), w * 1.6, Color(col.r, col.g, col.b, 0.14), 3)


# =============================================================================
#  _OfferMote — the offering you dropped, flying to the stones as a little comet.
# =============================================================================
class _OfferMote extends ProcNode:
	var mat: String = "dewdrop"
	var from_p: Vector2 = Vector2.ZERO
	var to_p: Vector2 = Vector2.ZERO
	var life: float = 1.15
	var arc: float = 64.0
	var rsize: float = 13.0
	var on_arrive: Callable = Callable()
	var _trail: Array = []       # Array[Vector2] fixed-size ring, no per-frame alloc
	var _ti: int = 0
	var _done: bool = false

	func _on_built() -> void:
		animate_draw = true
		position = from_p
		_trail.resize(8)
		for i in range(8):
			_trail[i] = from_p

	func _animate(_delta: float) -> void:
		if _done:
			return
		var u: float = clampf(t / maxf(0.08, life), 0.0, 1.0)
		var ue: float = u * u * (3.0 - 2.0 * u)
		var p: Vector2 = from_p.lerp(to_p, ue)
		p.y -= sin(u * PI) * arc
		position = p
		_ti = (_ti + 1) % _trail.size()
		_trail[_ti] = p
		rotation = sin(t * 4.0 + phase) * 0.22
		if u >= 1.0:
			_done = true
			if on_arrive.is_valid():
				on_arrive.call()
			queue_free()

	func _draw() -> void:
		# a short comet trail behind the glyph (positions are world-ish; draw local)
		for i in range(_trail.size()):
			var idx: int = (_ti - i + _trail.size() * 2) % _trail.size()
			var tp: Vector2 = _trail[idx]
			var k: float = 1.0 - float(i) / float(_trail.size())
			RitualArt.soft(self, tp - position, rsize * 0.5 * k,
				Color(1.0, 0.94, 0.72, 0.3 * k), 2)
		RitualArt.draw_mat_glyph(self, Vector2.ZERO, rsize, mat)


# =============================================================================
#  _Keepsake — the quiet "the world will remember this one" mark on an Everbloom.
# =============================================================================
class _Keepsake extends ProcNode:
	var ring_r: float = 46.0
	var _motes: Array = []

	func _on_built() -> void:
		grow_rate = 1.0 / 1.6          # fades in over ~1.6s, then holds
		for i in range(3):
			var m := _KeepMote.new()
			m.seedv = hash("%d:km:%d" % [seedv, i])
			m.idx = i
			m.of = 3
			m.ring_r = ring_r
			add_child(m)
			_motes.append(m)

	func _animate(_delta: float) -> void:
		var gv: float = g()
		for item in _motes:
			var m: Node2D = item
			if is_instance_valid(m):
				m.rotation = t * 0.5
				m.modulate.a = gv
		modulate.a = clampf(gv, 0.0, 1.0)

	func fade_out(dur: float = 0.4) -> void:
		var tw := create_tween()
		tw.tween_property(self, "modulate:a", 0.0, maxf(0.05, dur))
		tw.tween_callback(queue_free)

	func _draw() -> void:
		var gv: float = g()
		if gv <= 0.01:
			return
		var r: float = ring_r * (0.8 + 0.2 * gv)
		draw_arc(Vector2.ZERO, r, 0.0, TAU, 44, Color(1.0, 0.93, 0.7, 0.3 * gv), 2.0, true)
		var e := RitualArt.ellipse(r * 1.1, r * 0.34, 30)
		draw_colored_polygon(e, Color(1.0, 0.9, 0.62, 0.07 * gv))
		# four tiny carved ticks, like a ring of kept promises
		for i in range(4):
			var a: float = TAU * float(i) / 4.0 + PI * 0.25
			var p := Vector2(cos(a) * r, sin(a) * r * 0.34)
			draw_line(p * 0.86, p * 1.14, Color(1.0, 0.96, 0.8, 0.45 * gv), 2.0, true)

	class _KeepMote extends Node2D:
		var seedv: int = 1
		var idx: int = 0
		var of: int = 3
		var ring_r: float = 46.0

		func _draw() -> void:
			var a: float = TAU * float(idx) / float(maxi(1, of))
			var p := Vector2(cos(a) * ring_r, sin(a) * ring_r * 0.34)
			RitualArt.soft(self, p, 7.0, Color(1.0, 0.95, 0.76, 0.75), 3)


# =============================================================================
#  _SeedFold — the ASCENSION ceremony: the world folds inward into one seed,
#  the seed holds a breath, then opens outward as the first light of the next world.
# =============================================================================
class _SeedFold extends ProcNode:
	var life: float = 5.0
	var reach: float = 620.0

	func _on_built() -> void:
		animate_draw = true

	func _animate(_delta: float) -> void:
		if t >= life:
			queue_free()

	func _draw() -> void:
		var u: float = clampf(t / maxf(0.2, life), 0.0, 1.0)
		# three acts: fold in (0 .. .45), the held seed (.45 .. .62), open out (.62 .. 1)
		var fold: float = clampf(u / 0.45, 0.0, 1.0)
		var hold: float = clampf((u - 0.45) / 0.17, 0.0, 1.0)
		var open: float = clampf((u - 0.62) / 0.38, 0.0, 1.0)
		var folde: float = fold * fold * (3.0 - 2.0 * fold)
		# the folding rings: wide circles collapsing to the centre
		if fold < 1.0:
			for i in range(7):
				var k: float = float(i) / 6.0
				var rr: float = reach * (1.0 - folde) * (0.35 + 0.75 * k)
				var a: float = (1.0 - folde) * 0.3 * (1.0 - k * 0.5)
				draw_arc(Vector2.ZERO, maxf(2.0, rr), 0.0, TAU, 62,
					Color(1.0, 0.95, 0.76, a), 2.6 + 2.0 * k, true)
		# the seed itself
		var sr: float = reach * 0.08 * (0.3 + 0.7 * folde) * (1.0 + 0.5 * open * open)
		var seed_pts := PackedVector2Array()
		for i in range(26):
			var a2: float = TAU * float(i) / 26.0
			seed_pts.append(Vector2(cos(a2) * sr * 0.72, sin(a2) * sr * (1.08 if sin(a2) < 0.0 else 0.86)))
		draw_polygon(seed_pts, Proc.grad_fill(seed_pts,
			Color(1.0, 0.98, 0.88, 0.95), Color(0.86, 0.68, 0.36, 0.9)))
		RitualArt.soft(self, Vector2.ZERO, sr * (2.2 + 5.0 * hold + 9.0 * open),
			Color(1.0, 0.94, 0.72, 0.5 * (1.0 - open * 0.4)), 6)
		# the opening: rays of the next morning pushing outward
		if open > 0.0:
			var oe: float = open * open * (3.0 - 2.0 * open)
			for i in range(14):
				var a3: float = TAU * float(i) / 14.0 + t * 0.12
				var inner: float = sr * 1.1
				var outer: float = inner + reach * 1.15 * oe
				var w: float = 0.055
				draw_colored_polygon(PackedVector2Array([
					Vector2(cos(a3 - w), sin(a3 - w)) * inner,
					Vector2(cos(a3 + w), sin(a3 + w)) * inner,
					Vector2(cos(a3 + w * 0.35), sin(a3 + w * 0.35)) * outer,
					Vector2(cos(a3 - w * 0.35), sin(a3 - w * 0.35)) * outer]),
					Color(1.0, 0.96, 0.8, 0.26 * (1.0 - oe)))
			for i in range(4):
				var rr2: float = reach * 1.2 * oe * (0.4 + 0.2 * float(i))
				draw_arc(Vector2.ZERO, maxf(2.0, rr2), 0.0, TAU, 64,
					Color(1.0, 0.97, 0.85, 0.2 * (1.0 - oe)), 3.0, true)
