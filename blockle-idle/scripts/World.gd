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
var _kin: Array = []              # the Blocklings living here (see Kin.gd)
var ghost_kind := ""              # set by Main while a tray item is being dragged
var ghost_tile := Vector2i(9999, 9999)
var ghost_ok := false
var t := 0.0
# Time of day, 0 = midnight, .25 dawn, .5 noon, .75 dusk. A full day takes
# DAY_SECONDS of real time; the whole island is tinted from this one number.
const DAY_SECONDS := 240.0
const GROW_MINUTES := 4.0      # seed -> full size, in real minutes
var tod := 0.34
var _tod_set := false          # true when a caller pins the time (screenshots)
var _L: Array = []             # this frame's [sky_hi, sky_mid, sky_lo, warm, cool, strength]

func _ready() -> void:
	_generate()

func _process(delta: float) -> void:
	t += delta
	if not _tod_set:
		tod = fposmod(tod + delta / DAY_SECONDS, 1.0)
	_tick_kin(delta)
	# Continuous, very slow growth: a freshly planted thing takes GROW_MINUTES of
	# real time to reach maturity, and keeps creeping while you watch.
	for p in _props:
		if float(p.get("g", 1.0)) < 1.0:
			p["g"] = minf(1.0, float(p["g"]) + delta / (GROW_MINUTES * 60.0))
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
		{"kind": "bush", "n": 9},
		{"kind": "mushroom", "n": 7},
		{"kind": "flower", "n": 20},
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
	_carve_path()
	_spawn_kin()

# Pin the clock (used by the screenshot harness to inspect each hour).
func set_time_of_day(v: float) -> void:
	tod = fposmod(v, 1.0)
	_tod_set = true

func _warm() -> Color: return _L[3]
func _cool() -> Color: return _L[4]
func _str() -> float:  return float(_L[5])

# Light a material with the CURRENT time of day.
func _hz(m: Array, amount: float) -> Array:
	var x: float = clampf(amount, 0.0, 1.0)
	var horizon: Color = _L[2]
	return [m[0].lerp(horizon, x * 0.30), m[1].lerp(horizon, x * 0.26), m[2].lerp(horizon, x * 0.22)]

func _lit(m: Array, k: float = 1.0) -> Array:
	return Pal.lit(m, _warm(), _cool(), _str(), k)

# How far back a tile sits, 0 (nearest the camera) .. 1 (far horizon edge).
# Drives aerial haze so the island has real depth across its own surface.
func _back(gx: float, gy: float) -> float:
	return clampf(0.5 - (gx + gy) / (float(R) * 4.0), 0.0, 1.0)

# A worn dirt path wandering between the cottages — the single strongest cue
# that someone LIVES here rather than the props being scattered at random.
func _carve_path() -> void:
	var homes: Array = []
	for p in _props:
		if String(p["kind"]) == "cottage":
			homes.append(Vector2(float(p["gx"]), float(p["gy"])))
	if homes.size() < 2:
		return
	homes.sort_custom(func(a, b): return a.x + a.y < b.x + b.y)
	for i in range(homes.size() - 1):
		var a: Vector2 = homes[i]
		var b: Vector2 = homes[i + 1]
		var steps := int(maxf(absf(b.x - a.x), absf(b.y - a.y)) * 2.0) + 2
		for st in range(steps + 1):
			var f := float(st) / float(steps)
			# a slight sideways wander so the path is never a ruled line
			var wob := sin(f * PI) * (_rf("pw%d" % i) * 1.6 - 0.8)
			var pt := a.lerp(b, f) + Vector2(wob, -wob) * 0.6
			var key := Vector2i(int(round(pt.x)), int(round(pt.y)))
			if _tiles.has(key) and not bool(_tiles[key].get("water", false)):
				_tiles[key]["path"] = true
				# widen here and there so the trail isn't a single-tile thread
				var side := Vector2i(key.x + (1 if _rf("pwz%d_%d" % [key.x, key.y]) > 0.5 else 0),
					key.y + (1 if _rf("pwy%d_%d" % [key.x, key.y]) > 0.62 else 0))
				if _tiles.has(side) and not bool(_tiles[side].get("water", false)):
					_tiles[side]["path"] = true

# ---- drawing -----------------------------------------------------------------

func _draw() -> void:
	_L = Pal.tod_mix(tod)
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
			Iso.cube(self, k.x, k.y, float(tl["h"]) - float(lvl), 1.0,
				_hz(m, _back(k.x, k.y) * 0.5))
	# TOP: soil band + grass cap, back to front
	for k in keys:
		_draw_column(k)
	# props, same key so they interleave correctly with the ground
	# props AND kin share one back-to-front pass, so a Blockling correctly walks
	# behind a cottage and in front of the tree beyond it.
	var draws: Array = []
	for p in _props:
		draws.append({"k": float(p["gx"]) + float(p["gy"]), "p": p})
	for o in _kin:
		var kk: Kin = o
		draws.append({"k": kk.gx + kk.gy + 0.01, "kin": kk})
	draws.sort_custom(func(a, b): return float(a["k"]) < float(b["k"]))
	for d in draws:
		if d.has("kin"):
			_draw_kin(d["kin"])
		else:
			_draw_prop(d["p"])
	if ghost_kind != "":
		draw_ghost(ghost_kind, ghost_tile, ghost_ok)

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
		var col: Color = (_L[0] as Color).lerp(_L[1], minf(1.0, f * 1.6)) if f < 0.62 \
			else (_L[1] as Color).lerp(_L[2], (f - 0.62) / 0.38)
		# bands OVERLAP by a pixel: a seam of background between them is the
		# thing that ruined the last sky.
		var y: float = floorf(top + f * span)
		draw_rect(Rect2(Vector2(-vp.x * 1.5, y), Vector2(vp.x * 3.0, bh + 2.0)), col)
	# STARS, fading in as the sky darkens
	var night: float = clampf(1.0 - _str() / 0.9, 0.0, 1.0)
	if night > 0.02:
		for i in range(46):
			var ss := "st%d" % i
			var sx := -vp.x * 0.6 + _rf(ss) * vp.x * 1.2
			var sy := -vp.y * 0.95 + _rf(ss + "y") * vp.y * 0.85
			var tw := 0.55 + 0.45 * sin(t * 1.7 + _rf(ss + "p") * 9.0)
			Iso.box(self, Vector2(sx, sy), Vector2(1, 1),
				Color(Pal.CREAM.r, Pal.CREAM.g, Pal.CREAM.b, night * tw * 0.9))
	# The SUN arcs across the sky and the MOON follows it round — the light that
	# tints every surface is visibly the one hanging up there.
	var ang := (tod - 0.25) * TAU
	var orb := Vector2(vp.x * 0.5 + cos(ang) * vp.x * 0.62,
		-vp.y * 0.22 - sin(ang) * vp.y * 0.34)
	var is_day := sin(ang) > -0.12
	var disc: Color = Pal.CREAM if is_day else Color("#dfe6ff")
	var halo: Color = _warm() if is_day else Color("#8fa8e0")
	for i in range(5, 0, -1):
		draw_circle(orb, 12.0 + float(i) * 7.0, Color(halo.r, halo.g, halo.b, 0.065))
	draw_circle(orb, 12.0, disc)
	if not is_day:   # a crescent bite out of the moon
		draw_circle(orb + Vector2(5, -3), 10.0, (_L[0] as Color).lerp(_L[1], 0.4))
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
	Iso.cube(self, k.x, k.y, h - 1.0, 1.0, _hz(_lit(Pal.mat("soil"), 0.6), _back(k.x, k.y)))
	# Per-tile grass variation: a large flat field of one green reads as empty, so
	# each tile shifts slightly and some wear to a lighter, sandier patch.
	var v := _rf("g%d_%d" % [k.x, k.y])
	if bool(tl.get("water", false)):
		Iso.cube(self, k.x, k.y, h, 1.0, _hz(_lit(Pal.mat("water"), 0.5), _back(k.x, k.y)))
		# a glint that drifts across the surface
		var wc := Iso.to_screen(k.x, k.y, h + 1.0)
		# lily pads: a couple of flat green discs with an occasional bloom
		if _rf("lp%d_%d" % [k.x, k.y]) > 0.62:
			var lc := Iso.to_screen(k.x, k.y, h + 1.0)
			var bob := sin(t * 0.8 + float(k.x * 3 + k.y)) * 0.8
			Iso.diamond(self, lc + Vector2(0, bob), Pal.LEAF_T.lerp(Pal.GRASS_T, 0.3), 13.0, 7.0)
			if _rf("lb%d_%d" % [k.x, k.y]) > 0.6:
				Iso.box(self, lc + Vector2(-1, bob - 3), Vector2(3, 3), Pal.BLOSSOM)
		var gl := 0.5 + 0.5 * sin(t * 1.3 + float(k.x + k.y) * 0.9)
		if gl > 0.72:
			Iso.box(self, wc + Vector2(-4, -1), Vector2(8, 2),
				Color(Pal.CREAM.r, Pal.CREAM.g, Pal.CREAM.b, 0.5))
		return
	var g := Pal.mat("grass")
	var m: Array = g
	# a sandy shore wherever the turf meets the pond
	var shore := false
	for o in [Vector2i(1,0), Vector2i(-1,0), Vector2i(0,1), Vector2i(0,-1)]:
		var nk := Vector2i(k.x + o.x, k.y + o.y)
		if _tiles.has(nk) and bool(_tiles[nk].get("water", false)):
			shore = true
			break
	if shore:
		m = [Color("#e8d6a8"), Color("#c4ad7e"), Color("#95805a")]
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
	if bool(tl.get("path", false)):
		var pm := [Color("#e0c89a"), Color("#bda173"), Color("#8f7652")]
		Iso.cube(self, k.x, k.y, h, 1.0, _hz(_lit(pm), _back(k.x, k.y)))
		return
	Iso.cube(self, k.x, k.y, h, 1.0, _hz(_lit(m), _back(k.x, k.y)))
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
	var g: float = float(p.get("g", 1.0))
	# eased so a sprout starts gently and fills out toward the end
	var gv: float = g * g * (3.0 - 2.0 * g)
	match String(p["kind"]):
		"tree": _tree(gx, gy, z, s, gv)
		"cottage": _cottage(gx, gy, z, s, gv)
		"rock": _rock(gx, gy, z, s)
		"flower": _flower(gx, gy, z, s, gv)
		"bush": _bush(gx, gy, z, s, gv)
		"mushroom": _mushroom(gx, gy, z, s)

# ---- planting (what the inventory tray drives) ------------------------------

# Which tile a screen point lands on. Walks the candidate tiles and picks the
# one whose drawn top face actually contains the point, so tall ground near the
# crown doesn't mis-target the tile behind it.
func tile_at(local_pos: Vector2) -> Vector2i:
	var best := Vector2i(9999, 9999)
	var best_k := -1e9
	for k in _tiles.keys():
		var kk: Vector2i = k
		var h: float = float(_tiles[kk]["h"])
		var c := Iso.to_screen(kk.x, kk.y, h + 1.0)
		var d := local_pos - c
		# inside the 2:1 diamond?
		if absf(d.x) / (Iso.TILE_W * 0.5) + absf(d.y) / (Iso.TILE_H * 0.5) <= 1.0:
			var key := float(kk.x + kk.y) * 64.0 + h
			if key > best_k:
				best_k = key
				best = kk
	return best

func has_tile(k: Vector2i) -> bool:
	return _tiles.has(k)

# May something be planted here? Water, the worn path and occupied tiles say no.
func can_plant(k: Vector2i) -> Dictionary:
	if not _tiles.has(k):
		return {"ok": false, "why": "there is only sky there"}
	if bool(_tiles[k].get("water", false)):
		return {"ok": false, "why": "that is the pond"}
	for p in _props:
		if int(p["gx"]) == k.x and int(p["gy"]) == k.y:
			return {"ok": false, "why": "something already grows here"}
	return {"ok": true, "why": ""}

# Plant a fresh thing: it starts as a seed and grows from there.
func plant(kind: String, k: Vector2i) -> bool:
	var chk := can_plant(k)
	if not bool(chk["ok"]):
		return false
	_props.append({"gx": k.x, "gy": k.y, "z": float(_tiles[k]["h"]) + 1.0,
		"kind": kind, "s": 9000 + _props.size(), "g": 0.0})
	return true

# The ghost preview the tray draws while a finger is dragging over the world.
func draw_ghost(kind: String, k: Vector2i, ok: bool) -> void:
	if not _tiles.has(k):
		return
	var h: float = float(_tiles[k]["h"])
	var c := Iso.to_screen(k.x, k.y, h + 1.0)
	var tint: Color = Color(0.6, 1.0, 0.7, 0.55) if ok else Color(1.0, 0.45, 0.45, 0.5)
	Iso.diamond(self, c, tint, Iso.TILE_W, Iso.TILE_H)
	# a pulsing outline so the target tile is unmistakable
	var pulse: float = 0.6 + 0.4 * sin(t * 6.0)
	var hw := Iso.TILE_W * 0.5
	var hh := Iso.TILE_H * 0.5
	var pts := PackedVector2Array([c + Vector2(0, -hh), c + Vector2(hw, 0),
		c + Vector2(0, hh), c + Vector2(-hw, 0), c + Vector2(0, -hh)])
	draw_polyline(pts, Color(tint.r, tint.g, tint.b, pulse), 1.0)

# ---- the Blocklings ---------------------------------------------------------

func _walkable(k: Vector2i) -> bool:
	return _tiles.has(k) and not bool(_tiles[k].get("water", false))

func _spawn_kin() -> void:
	var homes: Array = []
	for p in _props:
		if String(p["kind"]) == "cottage":
			homes.append(Vector2(float(p["gx"]), float(p["gy"])))
	var n := 10
	for i in range(n):
		var k := Kin.new()
		k.seedv = 7000 + i
		# start on a walkable tile near a home
		var hm: Vector2 = homes[i % homes.size()] if homes.size() > 0 else Vector2.ZERO
		k.home = hm
		k.gx = hm.x + _rf("kx%d" % i) * 2.0 - 1.0
		k.gy = hm.y + _rf("ky%d" % i) * 2.0 - 1.0
		k.tx = k.gx
		k.ty = k.gy
		# seeded colouring: a warm smock over the kin base tone
		var hue := _rf("kc%d" % i)
		var smock: Color = [Color("#e07a5f"), Color("#5f8fe0"), Color("#71b36a"),
			Color("#d9a441"), Color("#9b6fd4"), Color("#4fb3a8")][int(hue * 6.0) % 6]
		k.body = [smock, smock.darkened(0.18), smock.darkened(0.34)]
		if _rf("kh%d" % i) > 0.55:
			k.hat = [Pal.GOLD, Pal.BLOSSOM, Pal.CREAM, Pal.WATER_T][int(_rf("kt%d" % i) * 4.0) % 4]
		k.speed = 0.42 + _rf("ks%d" % i) * 0.30
		k.bob = _rf("kb%d" % i) * TAU
		k.pause = _rf("kp%d" % i) * 3.0
		_kin.append(k)

func _tick_kin(delta: float) -> void:
	# after dusk everyone drifts home; by day they wander and loiter
	var night: bool = tod > 0.80 or tod < 0.20
	for o in _kin:
		var k: Kin = o
		k.bob += delta * 6.0
		if k.pause > 0.0:
			k.pause -= delta
			continue
		var d := Vector2(k.tx - k.gx, k.ty - k.gy)
		if d.length() < 0.06:
			# arrived: choose somewhere new
			if night and not k.going_home:
				k.going_home = true
				k.tx = k.home.x
				k.ty = k.home.y
			elif night:
				k.pause = 4.0                      # tucked in for the night
			else:
				k.going_home = false
				for attempt in range(8):
					var nx := k.gx + _rf("w%d_%f" % [k.seedv, k.bob + float(attempt)]) * 6.0 - 3.0
					var ny := k.gy + _rf("v%d_%f" % [k.seedv, k.bob + float(attempt)]) * 6.0 - 3.0
					var key := Vector2i(int(round(nx)), int(round(ny)))
					if _walkable(key) and Vector2(nx, ny).length() < float(R) * 0.78:
						k.tx = nx
						k.ty = ny
						break
				k.pause = _rf("pz%d_%f" % [k.seedv, k.bob]) * 2.4
			continue
		var step := d.normalized() * k.speed * delta
		k.gx += step.x
		k.gy += step.y
		# screen-space facing: moving +x or -y heads screen-right
		var sdx := (step.x - step.y)
		if absf(sdx) > 0.0001:
			k.facing = signf(sdx)
		var key2 := Vector2i(int(round(k.gx)), int(round(k.gy)))
		if _tiles.has(key2):
			k.z = float(_tiles[key2]["h"]) + 1.0

func _draw_kin(k: Kin) -> void:
	var c := Iso.to_screen(k.gx, k.gy, k.z)
	var moving: bool = Vector2(k.tx - k.gx, k.ty - k.gy).length() > 0.06 and k.pause <= 0.0
	var hop: float = (absf(sin(k.bob)) * 2.0) if moving else 0.0
	Iso.shadow(self, c, 11.0, 0.3)
	var b := _lit(k.body)
	var bc: Color = b[0]
	var bs: Color = b[2]
	var y := -hop
	# legs (two pixels that alternate while walking)
	var sw: float = sin(k.bob) * 1.5 if moving else 0.0
	Iso.box(self, c + Vector2(-4 + sw, y - 4), Vector2(3, 4), bs)
	Iso.box(self, c + Vector2(1 - sw, y - 4), Vector2(3, 4), bs)
	# body, with one arm swinging
	Iso.box(self, c + Vector2(-4, y - 11), Vector2(8, 7), bc)
	Iso.box(self, c + Vector2(-5, y - 10 + sw * 0.6), Vector2(2, 5), bs)
	Iso.box(self, c + Vector2(4, y - 10 - sw * 0.6), Vector2(2, 5), bs)
	# head
	var head := _lit(Pal.mat("kin"))
	Iso.box(self, c + Vector2(-4, y - 17), Vector2(8, 6), head[0])
	Iso.box(self, c + Vector2(-4, y - 17), Vector2(8, 1), head[1])
	# eyes, looking the way it walks
	var ex := 1.0 if k.facing > 0.0 else -3.0
	Iso.box(self, c + Vector2(ex, y - 14), Vector2(1, 2), Pal.INK)
	Iso.box(self, c + Vector2(ex + 2, y - 14), Vector2(1, 2), Pal.INK)
	if k.hat.a > 0.0:
		var hl := _lit([k.hat, k.hat, k.hat])
		Iso.box(self, c + Vector2(-5, y - 19), Vector2(10, 2), hl[0])
		Iso.box(self, c + Vector2(-3, y - 22), Vector2(6, 3), hl[0])

# ---- props (all built from Iso cubes so they sit on the grid) ----------------

func _tree(gx: float, gy: float, z: float, s: int, g: float = 1.0) -> void:
	# A tree must read instantly against the grass, so: a TALL visible trunk and
	# a canopy in a deeper, bluer green than the turf (never the same family).
	Iso.shadow(self, Iso.to_screen(gx, gy, z), Iso.TILE_W * 0.95, 1.6)
	# Every tree is its own size and species — a grove of identical trees is the
	# fastest way to make a world look stamped out.
	var sz: float = (0.78 + _rf("tz%d" % s) * 0.5) * maxf(0.16, g)
	if g < 0.22:
		# a sapling: two leaves on a stem, before it is a tree at all
		var sc := Iso.to_screen(gx, gy, z)
		Iso.box(self, sc + Vector2(-1, -7), Vector2(2, 7), _lit(Pal.mat("wood"))[0])
		Iso.box(self, sc + Vector2(-5, -10), Vector2(4, 3), _lit(Pal.mat("leaf"))[0])
		Iso.box(self, sc + Vector2(1, -12), Vector2(4, 3), _lit(Pal.mat("leaf"))[0])
		return
	var kind := _rf("tk%d" % s)
	var m := Pal.mat("leaf")
	if kind > 0.84:
		m = Pal.mat("autumn")
	elif kind > 0.70:
		m = [Pal.BLOSSOM, Pal.BLOSSOM.darkened(0.18), Pal.BLOSSOM.darkened(0.34)]
	m = _hz(_lit(m), _back(gx, gy) * 0.7)
	var trunk := 1.5 * sz
	Iso.cube(self, gx, gy, z, trunk, _lit(Pal.mat("wood"), 0.7), 0.28)
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

func _cottage(gx: float, gy: float, z: float, s: int, g: float = 1.0) -> void:
	if g < 0.99:
		# under construction: a timber frame that rises into the finished house
		var fc := Iso.to_screen(gx, gy, z)
		Iso.shadow(self, fc, Iso.TILE_W * 1.3, 1.0)
		var wm := _lit(Pal.mat("wood"))
		Iso.cube(self, gx, gy, z, maxf(0.2, 2.6 * g), wm, 1.5)
		for i in range(3):
			Iso.box(self, fc + Vector2(-14 + i * 13, -int(22 * g)), Vector2(2, int(22 * g) + 1), wm[2])
		return
	Iso.shadow(self, Iso.to_screen(gx, gy, z), Iso.TILE_W * 1.5, 2.0)
	# walls
	Iso.cube(self, gx, gy, z, 2.0, _lit(Pal.mat("stone")), 1.6)
	# roof: two shrinking blue cubes read as a pitched roof at this scale
	# a stepped pyramid reads as a pitched roof far better than two slabs
	Iso.cube(self, gx, gy, z + 2.0, 0.55, _lit(Pal.mat("roof")), 1.95)
	Iso.cube(self, gx, gy, z + 2.55, 0.5, _lit(Pal.mat("roof")), 1.5)
	Iso.cube(self, gx, gy, z + 3.05, 0.45, _lit(Pal.mat("roof")), 1.05)
	Iso.cube(self, gx, gy, z + 3.5, 0.4, _lit(Pal.mat("roof")), 0.6)
	# a warm window on the left face + a chimney
	var c := Iso.to_screen(gx, gy, z + 1.2)
	# windows wake up after dark, and spill a pool of light onto the grass
	var night: float = clampf(1.0 - _str() / 0.9, 0.0, 1.0)
	var w1: Color = Pal.GLOW if night < 0.35 else Pal.GLOW.lerp(Color("#fff2c0"), night)
	var w2: Color = Pal.GOLD_DEEP.lerp(Pal.GLOW, night)
	if night > 0.25:
		var gf := Iso.to_screen(gx, gy, z)
		for i in range(3, 0, -1):
			Iso.diamond(self, gf + Vector2(0, 2), Color(Pal.GOLD.r, Pal.GOLD.g, Pal.GOLD.b,
				0.05 * night), Iso.TILE_W * (1.0 + float(i) * 0.55),
				Iso.TILE_H * (1.0 + float(i) * 0.55))
	Iso.box(self, c + Vector2(-12, -4), Vector2(5, 5), w1)
	Iso.box(self, c + Vector2(6, -3), Vector2(5, 5), w2)
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
	Iso.cube(self, gx, gy, z, 0.45, _lit(Pal.mat("boulder")), 0.62)
	Iso.cube(self, gx + 0.18, gy + 0.12, z + 0.4, 0.3, _lit(Pal.mat("boulder")), 0.36)

func _bush(gx: float, gy: float, z: float, s: int, g: float = 1.0) -> void:
	Iso.shadow(self, Iso.to_screen(gx, gy, z), Iso.TILE_W * 0.6, 0.4)
	var m := _hz(_lit(Pal.mat("leaf")), _back(gx, gy) * 0.6)
	var sz: float = (0.7 + _rf("bz%d" % s) * 0.4) * maxf(0.2, g)
	Iso.cube(self, gx, gy, z, 0.8 * sz, m, 0.78 * sz)
	Iso.cube(self, gx + 0.12, gy - 0.1, z + 0.7 * sz, 0.6 * sz, m, 0.5 * sz)
	# a few berries
	if _rf("bb%d" % s) > 0.5:
		var c := Iso.to_screen(gx, gy, z + 1.0)
		for i in range(3):
			Iso.box(self, c + Vector2(-5 + i * 4, -6 + (i % 2) * 3), Vector2(2, 2), Pal.GOLD_DEEP)

func _mushroom(gx: float, gy: float, z: float, s: int) -> void:
	var c := Iso.to_screen(gx, gy, z)
	Iso.shadow(self, c, Iso.TILE_W * 0.3, 0.2)
	var red := _rf("mr%d" % s) > 0.45
	var cap_col: Color = Color("#d9534f") if red else Color("#e8cfa8")
	for i in range(2):
		var ox := -4.0 + float(i) * 7.0
		var hh := 4.0 + _rf("mh%d_%d" % [s, i]) * 3.0
		Iso.box(self, c + Vector2(ox, -hh), Vector2(2, hh), Pal.CREAM)
		Iso.box(self, c + Vector2(ox - 2, -hh - 3), Vector2(6, 3), cap_col)
		Iso.box(self, c + Vector2(ox - 1, -hh - 4), Vector2(2, 1), cap_col.lightened(0.3))

func _flower(gx: float, gy: float, z: float, s: int, g: float = 1.0) -> void:
	var c := Iso.to_screen(gx, gy, z)
	var sway := sin(t * 1.6 + float(s) * 1.7) * 1.0
	var cols := [Pal.BLOSSOM, Pal.GOLD, Pal.CREAM, Pal.WATER_T, Color("#c98bdb")]
	var col: Color = cols[s % cols.size()]
	# a little cluster, never a lone stem
	for i in range(3):
		var ox := -6.0 + float(i) * 6.0 + _rf("fx%d_%d" % [s, i]) * 2.0
		var oy := -1.0 + _rf("fy%d_%d" % [s, i]) * 3.0
		var hgt := (6.0 + _rf("fh%d_%d" % [s, i]) * 4.0) * maxf(0.25, g)
		var sw := sway * (0.6 + float(i) * 0.25)
		Iso.box(self, c + Vector2(ox, oy - hgt), Vector2(1, hgt), Pal.LEAF_R)
		Iso.box(self, c + Vector2(ox - 2 + sw, oy - hgt - 4), Vector2(5, 5), col)
		Iso.box(self, c + Vector2(ox + sw, oy - hgt - 2), Vector2(1, 1), col.lightened(0.5))
