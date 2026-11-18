class_name World
extends Node2D
# World — the floating isometric island, drawn as ONE coherent scene.
#
# Deliberately a single renderer rather than a pile of independent modules: every
# tile and prop goes through Iso and takes its colours from Pal, so the whole
# image shares one grid, one light direction and one palette. That is the thing
# that makes it read as a place instead of a collage.
#
# Painting order (strict, back to front):
#   sky  ->  island columns sorted by (gx+gy)  ->  props sorted by the same key
# Within a column, cubes are painted bottom-up so the higher one overlaps.

const R := 8                      # island radius in tiles
var world_seed: int = 12345
var _tiles: Dictionary = {}       # Vector2i -> {h: top elevation, deep: rock depth}
var _props: Array = []            # [{gx, gy, z, kind, seed}]
var t := 0.0

func _ready() -> void:
	_generate()

func _process(delta: float) -> void:
	t += delta
	queue_redraw()                # the scene is small; a full redraw is cheap

# ---- generation --------------------------------------------------------------

# A seeded 0..1 value. Godot's hash() of two SIMILAR strings returns two similar
# numbers ("tk1","tk2","tk3" came out 0.87182, 0.87183, 0.87184), so taking it
# straight made every tree pick the same species and the grass band in stripes.
# Avalanche the bits first so neighbouring keys land far apart.
func _rf(key: String) -> float:
	var h: int = hash("%d:%s" % [world_seed, key]) & 0x7FFFFFFF
	h = ((h ^ (h >> 16)) * 0x7feb352d) & 0x7FFFFFFF
	h = ((h ^ (h >> 15)) * 0x846ca68b) & 0x7FFFFFFF
	h = (h ^ (h >> 16)) & 0x7FFFFFFF
	return float(h % 1000000) / 1000000.0

func _generate() -> void:
	_tiles.clear()
	_props.clear()
	# A rounded, slightly irregular island: radius wobbles with angle.
	for gx in range(-R, R + 1):
		for gy in range(-R, R + 1):
			var d := sqrt(float(gx * gx + gy * gy))
			var ang := atan2(float(gy), float(gx))
			var wobble := 1.0 + 0.18 * sin(ang * 3.0 + _rf("w") * 6.28) \
							  + 0.10 * sin(ang * 5.0 + _rf("w2") * 6.28)
			if d > R * wobble:
				continue
			# gentle crown: higher toward the middle
			var h := 0.0
			if d < R * 0.45:
				h = 1.0
			if d < R * 0.22:
				h = 2.0
			# The underside is a deep inverted cone — this is what sells "floating".
			# Steeply deeper toward the middle so the island has real mass below.
			var dn: float = 1.0 - clampf(d / float(R), 0.0, 1.0)
			var deep := int(round(3.0 + dn * dn * 26.0))
			# A pond, dug toward the FRONT of the island where the camera can see
			# into it — it gives the palette its cool accent.
			var pc := Vector2(float(R) * 0.26, float(R) * 0.44)
			var water := Vector2(float(gx), float(gy)).distance_to(pc) < 2.6
			if water:
				h -= 1.0
			_tiles[Vector2i(gx, gy)] = {"h": h, "deep": deep, "water": water}

	# Props on valid tiles, seeded and spaced so nothing overlaps badly.
	# Walk a deterministically SHUFFLED tile list instead of guessing random
	# indices — rejection sampling kept failing and bunched everything in one
	# corner. A shuffled walk spreads props evenly across the whole island.
	var spots: Array = _tiles.keys()
	spots.sort_custom(func(a, b):
		return _rf("sh%d_%d" % [a.x, a.y]) < _rf("sh%d_%d" % [b.x, b.y]))
	var cursor := 0
	var used := {}
	var want := [
		{"kind": "cottage", "n": 3},
		{"kind": "tree", "n": 11},
		{"kind": "rock", "n": 6},
		{"kind": "flower", "n": 22},
	]
	var pick := 0
	for w in want:
		for i in range(int(w["n"])):
			for attempt in range(spots.size()):
				pick += 1
				cursor = (cursor + 1) % spots.size()
				var c: Vector2i = spots[cursor]
				var d := sqrt(float(c.x * c.x + c.y * c.y))
				if d > R * 0.80:
					continue                       # keep props off the crumbling rim
				if bool(_tiles[c].get("water", false)):
					continue                       # and out of the pond
				var clear := true
				for o in used.keys():
					var oc: Vector2i = o
					if absi(oc.x - c.x) + absi(oc.y - c.y) < (3 if w["kind"] != "flower" else 2):
						clear = false
						break
				if not clear:
					continue
				used[c] = true
				var tl: Dictionary = _tiles[c]
				_props.append({"gx": c.x, "gy": c.y, "z": float(tl["h"]) + 1.0,
					"kind": String(w["kind"]), "s": pick})
				break

# ---- drawing -----------------------------------------------------------------

func _draw() -> void:
	_draw_sky()
	# island, back to front
	var keys: Array = _tiles.keys()
	keys.sort_custom(func(a, b): return (a.x + a.y) < (b.x + b.y))
	# UNDERSIDE: painted one elevation LEVEL at a time, deepest first. Each level
	# includes only the tiles that reach that deep, so the mass narrows with depth
	# into a solid stepped cone. (Narrowing each column on its own instead left
	# gaps between neighbours — the island hung in thin spikes.)
	var maxdeep := 0
	for k in keys:
		maxdeep = maxi(maxdeep, int(_tiles[k]["deep"]))
	for lvl in range(maxdeep, 0, -1):
		var fade: float = clampf(float(lvl) / 20.0, 0.0, 0.66)
		var rm := Pal.mat("rock")
		var m := [rm[0].lerp(Pal.INK, fade), rm[1].lerp(Pal.INK, fade), rm[2].lerp(Pal.INK, fade)]
		for k in keys:
			var tl: Dictionary = _tiles[k]
			if int(tl["deep"]) < lvl:
				continue
			Iso.cube(self, k.x, k.y, float(tl["h"]) - float(lvl), 1.0, m)
	# TOP: soil band + grass cap, back to front
	for k in keys:
		_draw_column(k)
	# props, same key so they interleave correctly with the ground
	var props := _props.duplicate()
	props.sort_custom(func(a, b): return (a["gx"] + a["gy"]) < (b["gx"] + b["gy"]))
	for p in props:
		_draw_prop(p)

func _draw_sky() -> void:
	# A banded vertical gradient — banding is a pixel-art virtue, not a flaw.
	var vp := get_viewport_rect().size
	var top := -vp.y * 1.2
	var span := vp.y * 2.4
	var bands := 22
	# band height must match the band SPACING (span/(bands-1)) or thin seams of
	# background show through between them — that was the stripey sky.
	var step: float = span / float(bands - 1)
	var bh: float = ceilf(step) + 2.0
	for i in range(bands):
		var f := float(i) / float(bands - 1)
		var col := Pal.SKY_HI.lerp(Pal.SKY_MID, minf(1.0, f * 1.6)) if f < 0.62 \
			else Pal.SKY_MID.lerp(Pal.SKY_LO, (f - 0.62) / 0.38)
		# bands OVERLAP by a pixel: a seam of background between them is the
		# thing that ruined the last sky.
		var y: float = floorf(top + f * span)
		draw_rect(Rect2(Vector2(-vp.x * 1.5, y), Vector2(vp.x * 3.0, bh + 2.0)), col)
	# the sun, with a soft stepped halo (banding, again, on purpose)
	var sun := Vector2(vp.x * 0.30, -vp.y * 0.44)
	for i in range(4, 0, -1):
		var rr := 13.0 + float(i) * 7.0
		draw_circle(sun, rr, Color(Pal.GOLD.r, Pal.GOLD.g, Pal.GOLD.b, 0.07))
	draw_circle(sun, 13.0, Pal.CREAM)
	# birds: little drifting v-marks, the cheapest life a sky can have
	for i in range(4):
		var bs := "bd%d" % i
		var bx := fmod(_rf(bs) * 700.0 + t * (14.0 + i * 5.0), 760.0) - 380.0
		var by := -150.0 - _rf(bs + "y") * 190.0 + sin(t * 1.4 + float(i)) * 4.0
		var bc := Color(Pal.INK_SOFT.r, Pal.INK_SOFT.g, Pal.INK_SOFT.b, 0.55)
		Iso.box(self, Vector2(bx - 3, by), Vector2(2, 1), bc)
		Iso.box(self, Vector2(bx - 1, by - 1), Vector2(2, 1), bc)
		Iso.box(self, Vector2(bx + 1, by), Vector2(2, 1), bc)
	# a few slow clouds
	for i in range(5):
		var cs := "cl%d" % i
		var cx := fmod(_rf(cs) * 900.0 + t * (6.0 + i * 2.0), 1000.0) - 500.0
		var cy := -220.0 - _rf(cs + "y") * 260.0
		_cloud(Vector2(cx, cy), 18.0 + _rf(cs + "s") * 16.0)

func _cloud(c: Vector2, r: float) -> void:
	for o in [Vector2(0, 0), Vector2(-r * 0.8, r * 0.25), Vector2(r * 0.85, r * 0.2),
			Vector2(-r * 0.3, -r * 0.45), Vector2(r * 0.35, -r * 0.4)]:
		draw_rect(Rect2((c + o - Vector2(r * 0.55, r * 0.3)).round(),
			Vector2(r * 1.1, r * 0.6).round()), Pal.CLOUD)
	draw_rect(Rect2((c + Vector2(-r * 0.9, r * 0.25)).round(),
		Vector2(r * 1.9, r * 0.28).round()), Pal.CLOUD_SH)

func _draw_column(k: Vector2i) -> void:
	var tl: Dictionary = _tiles[k]
	var h: float = tl["h"]
	# a band of soil directly under the turf, then the grass cap
	Iso.cube(self, k.x, k.y, h - 1.0, 1.0, Pal.mat("soil"))
	# Per-tile grass variation: a large flat field of one green reads as empty, so
	# each tile shifts slightly and some wear to a lighter, sandier patch.
	var v := _rf("g%d_%d" % [k.x, k.y])
	if bool(tl.get("water", false)):
		Iso.cube(self, k.x, k.y, h, 1.0, Pal.mat("water"))
		# a glint that drifts across the surface
		var wc := Iso.to_screen(k.x, k.y, h + 1.0)
		var gl := 0.5 + 0.5 * sin(t * 1.3 + float(k.x + k.y) * 0.9)
		if gl > 0.72:
			Iso.box(self, wc + Vector2(-4, -1), Vector2(8, 2),
				Color(Pal.CREAM.r, Pal.CREAM.g, Pal.CREAM.b, 0.5))
		return
	var g := Pal.mat("grass")
	var m: Array = g
	if v > 0.88:
		m = [g[0].lerp(Pal.SOIL_T, 0.35), g[1].lerp(Pal.SOIL_L, 0.3), g[2].lerp(Pal.SOIL_R, 0.3)]
	elif v > 0.62:
		m = [g[0].lightened(0.07), g[1].lightened(0.05), g[2].lightened(0.04)]
	elif v < 0.18:
		m = [g[0].darkened(0.08), g[1].darkened(0.07), g[2].darkened(0.06)]
	# Rim tiles sit a shade darker so the island reads with a crisp silhouette
	# instead of its edge dissolving into the sky.
	if not _tiles.has(Vector2i(k.x + 1, k.y)) or not _tiles.has(Vector2i(k.x, k.y + 1)):
		m = [m[0].darkened(0.06), m[1], m[2]]
	Iso.cube(self, k.x, k.y, h, 1.0, m)
	# a couple of pixel grass tufts, so the turf has texture up close
	if v > 0.30 and v < 0.62:
		var c := Iso.to_screen(k.x, k.y, h + 1.0)
		var dk: Color = m[0].darkened(0.18)
		Iso.box(self, c + Vector2(-5 + v * 8.0, -2), Vector2(1, 3), dk)
		Iso.box(self, c + Vector2(2 - v * 5.0, 1), Vector2(1, 2), dk)

func _draw_prop(p: Dictionary) -> void:
	var gx: float = p["gx"]
	var gy: float = p["gy"]
	var z: float = p["z"]
	var s: int = p["s"]
	match String(p["kind"]):
		"tree": _tree(gx, gy, z, s)
		"cottage": _cottage(gx, gy, z, s)
		"rock": _rock(gx, gy, z, s)
		"flower": _flower(gx, gy, z, s)

# ---- props (all built from Iso cubes so they sit on the grid) ----------------

func _tree(gx: float, gy: float, z: float, s: int) -> void:
	# A tree must read instantly against the grass, so: a TALL visible trunk and
	# a canopy in a deeper, bluer green than the turf (never the same family).
	Iso.shadow(self, Iso.to_screen(gx, gy, z), Iso.TILE_W * 0.9)
	# Every tree is its own size and species — a grove of identical trees is the
	# fastest way to make a world look stamped out.
	var sz: float = 0.78 + _rf("tz%d" % s) * 0.5
	var kind := _rf("tk%d" % s)
	var m := Pal.mat("leaf")
	if kind > 0.84:
		m = Pal.mat("autumn")
	elif kind > 0.70:
		m = [Pal.BLOSSOM, Pal.BLOSSOM.darkened(0.18), Pal.BLOSSOM.darkened(0.34)]
	var trunk := 1.5 * sz
	Iso.cube(self, gx, gy, z, trunk, Pal.mat("wood"), 0.28)
	var base := z + trunk - 0.2
	if kind < 0.24:
		# a tall narrow conifer
		Iso.cube(self, gx, gy, base, 1.5 * sz, m, 1.0 * sz)
		Iso.cube(self, gx, gy, base + 1.4 * sz, 1.3 * sz, m, 0.74 * sz)
		Iso.cube(self, gx, gy, base + 2.6 * sz, 1.1 * sz, m, 0.5 * sz)
		Iso.cube(self, gx, gy, base + 3.6 * sz, 0.8 * sz, m, 0.26 * sz)
	else:
		# a full round-crowned tree
		Iso.cube(self, gx, gy, base, 1.7 * sz, m, 1.16 * sz)
		Iso.cube(self, gx, gy, base + 1.6 * sz, 1.3 * sz, m, 0.84 * sz)
		Iso.cube(self, gx, gy, base + 2.8 * sz, 1.0 * sz, m, 0.48 * sz)

func _cottage(gx: float, gy: float, z: float, s: int) -> void:
	# walls
	Iso.cube(self, gx, gy, z, 2.0, Pal.mat("stone"), 1.6)
	# roof: two shrinking blue cubes read as a pitched roof at this scale
	# a stepped pyramid reads as a pitched roof far better than two slabs
	Iso.cube(self, gx, gy, z + 2.0, 0.55, Pal.mat("roof"), 1.95)
	Iso.cube(self, gx, gy, z + 2.55, 0.5, Pal.mat("roof"), 1.5)
	Iso.cube(self, gx, gy, z + 3.05, 0.45, Pal.mat("roof"), 1.05)
	Iso.cube(self, gx, gy, z + 3.5, 0.4, Pal.mat("roof"), 0.6)
	# a warm window on the left face + a chimney
	var c := Iso.to_screen(gx, gy, z + 1.2)
	Iso.box(self, c + Vector2(-12, -4), Vector2(5, 5), Pal.GLOW)      # lit window
	Iso.box(self, c + Vector2(6, -3), Vector2(5, 5), Pal.GOLD_DEEP)   # window
	Iso.box(self, c + Vector2(-3, 1), Vector2(6, 9), Pal.WOOD_R)      # door
	Iso.box(self, c + Vector2(1, 5), Vector2(1, 1), Pal.GOLD)         # handle
	Iso.cube(self, gx + 0.45, gy - 0.45, z + 3.2, 1.0, Pal.mat("stone"), 0.3)
	# chimney smoke
	for i in range(3):
		var f := fmod(t * 0.5 + float(i) * 0.33, 1.0)
		var sc := Iso.to_screen(gx + 0.45, gy - 0.45, z + 4.3 + f * 2.2)
		var a := (1.0 - f) * 0.5
		draw_rect(Rect2((sc + Vector2(-2, -2 - f * 6.0)).round(), Vector2(4, 4)),
			Color(Pal.CREAM.r, Pal.CREAM.g, Pal.CREAM.b, a))

func _rock(gx: float, gy: float, z: float, s: int) -> void:
	Iso.shadow(self, Iso.to_screen(gx, gy, z), Iso.TILE_W * 0.62)
	Iso.cube(self, gx, gy, z, 0.45, Pal.mat("boulder"), 0.62)
	Iso.cube(self, gx + 0.18, gy + 0.12, z + 0.4, 0.3, Pal.mat("boulder"), 0.36)

func _flower(gx: float, gy: float, z: float, s: int) -> void:
	var c := Iso.to_screen(gx, gy, z)
	var sway := sin(t * 1.6 + float(s) * 1.7) * 1.0
	var cols := [Pal.BLOSSOM, Pal.GOLD, Pal.CREAM, Pal.WATER_T]
	var col: Color = cols[s % cols.size()]
	Iso.box(self, c + Vector2(-1, -8), Vector2(2, 8), Pal.LEAF_R)
	Iso.box(self, c + Vector2(-3 + sway, -13), Vector2(6, 6), col)
	Iso.box(self, c + Vector2(-1 + sway, -11), Vector2(1, 1), col.lightened(0.45))
