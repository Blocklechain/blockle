extends Node
# Proc — the procedural-generation math toolkit. Everything the game draws is
# synthesised from numbers here: no imported images. One text prompt ("where do
# you start your journey") becomes a world_seed, and that seed drives colour
# harmonies, noise fields, organic outlines and creature parameters — so every
# world, island, tree and Blockling is deterministic, unique and limitless.
#
# All helpers are PURE functions of their inputs (seed + key), so the same world
# always regenerates identically with nothing stored.

# ---- seeds ------------------------------------------------------------------

# Turn an open-ended answer ("a quiet northern shore", "under the twin moons")
# into a stable 63-bit world seed. Different phrasings diverge; the same phrase
# always lands on the same world.
func seed_from_text(text: String) -> int:
	var t := text.strip_edges().to_lower()
	if t == "":
		t = "the first morning"
	# FNV-1a style mix over characters, then avalanche, so small edits scatter.
	var h := 1469598103934665603
	for c in t.to_utf8_buffer():
		h = (h ^ int(c)) * 1099511628211
		h = h & 0x7FFFFFFFFFFFFFFF
	h = h ^ (h >> 29)
	h = (h * 0x27D4EB2F165667C5) & 0x7FFFFFFFFFFFFFFF
	h = h ^ (h >> 32)
	return int(h & 0x7FFFFFFFFFFFFFFF)

func rng(world_seed: int, key: String) -> RandomNumberGenerator:
	var r := RandomNumberGenerator.new()
	r.seed = hash("%d:%s" % [world_seed, key])
	return r

# A deterministic float in [0,1) from (seed, key) without allocating an RNG.
func hashf(world_seed: int, key: String) -> float:
	var h: int = absi(hash("%d:%s" % [world_seed, key]))
	return float(h % 1000000) / 1000000.0

func rangef(world_seed: int, key: String, lo: float, hi: float) -> float:
	return lo + hashf(world_seed, key) * (hi - lo)

# ---- noise ------------------------------------------------------------------

# A configured FastNoiseLite, seeded. freq ~0.005 huge features, ~0.05 fine.
func noise(world_seed: int, key: String, freq: float = 0.01, octaves: int = 4) -> FastNoiseLite:
	var n := FastNoiseLite.new()
	n.seed = int(hash("%d:%s" % [world_seed, key]) & 0x7FFFFFFF)
	n.noise_type = FastNoiseLite.TYPE_SIMPLEX_SMOOTH
	n.frequency = freq
	n.fractal_type = FastNoiseLite.FRACTAL_FBM
	n.fractal_octaves = octaves
	return n

# ---- colour harmonies -------------------------------------------------------

# A cohesive palette derived from the seed: a base hue + a harmony scheme
# (analogous / complementary / triad / split), returned as an ordered set of
# roles. Because it is seed-driven, each world has its own consistent mood.
func palette(world_seed: int, key: String = "world") -> Dictionary:
	var r := rng(world_seed, "pal:" + key)
	var base_h := r.randf()
	var scheme := r.randi() % 4
	var warm := r.randf() < 0.5
	var sat := r.randf_range(0.42, 0.72)
	var val := r.randf_range(0.72, 0.92)

	var accent_h := base_h
	match scheme:
		0: accent_h = fposmod(base_h + 0.5, 1.0)                 # complementary
		1: accent_h = fposmod(base_h + r.randf_range(0.08, 0.16), 1.0)  # analogous
		2: accent_h = fposmod(base_h + 0.33, 1.0)               # triad
		3: accent_h = fposmod(base_h + 0.45, 1.0)               # split

	var sky_h := fposmod(base_h + (0.55 if warm else -0.08), 1.0)
	return {
		"base":    Color.from_hsv(base_h, sat, val),
		"base_dk": Color.from_hsv(base_h, min(1.0, sat + 0.1), val * 0.7),
		"base_lt": Color.from_hsv(base_h, sat * 0.7, min(1.0, val + 0.14)),
		"accent":  Color.from_hsv(accent_h, min(1.0, sat + 0.12), min(1.0, val + 0.06)),
		"accent_dk": Color.from_hsv(accent_h, min(1.0, sat + 0.2), val * 0.72),
		"sky_top": Color.from_hsv(sky_h, sat * 0.55, min(1.0, val + 0.12)),
		"sky_bot": Color.from_hsv(fposmod(sky_h + 0.04, 1.0), sat * 0.4, min(1.0, val + 0.2)),
		"soil":    Color.from_hsv(fposmod(base_h + 0.03, 1.0), sat * 0.8, val * 0.5),
		"ink":     Color.from_hsv(base_h, 0.4, 0.18),
		"hue":     base_h, "scheme": scheme, "warm": warm,
	}

# ---- smooth organic outlines ------------------------------------------------

# A closed Catmull-Rom spline through `controls`, returned as a dense polygon so
# the edge reads as hand-drawn smooth rather than faceted. `samples` per segment.
func smooth_loop(controls: PackedVector2Array, samples: int = 10) -> PackedVector2Array:
	var n := controls.size()
	var out := PackedVector2Array()
	if n < 3:
		return controls
	for i in range(n):
		var p0 := controls[(i - 1 + n) % n]
		var p1 := controls[i]
		var p2 := controls[(i + 1) % n]
		var p3 := controls[(i + 2) % n]
		for s in range(samples):
			var t := float(s) / samples
			out.append(_catmull(p0, p1, p2, p3, t))
	return out

func _catmull(p0: Vector2, p1: Vector2, p2: Vector2, p3: Vector2, t: float) -> Vector2:
	var t2 := t * t
	var t3 := t2 * t
	return 0.5 * ((2.0 * p1) + (-p0 + p2) * t
		+ (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
		+ (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3)

# A blobby closed outline: `lobes` control points on a circle of `radius`, each
# pushed in/out by seeded noise, then Catmull-smoothed. The organic base shape
# for islands, canopies, creature bodies, clouds, etc.
func blob(world_seed: int, key: String, radius: float, lobes: int = 9, wobble: float = 0.28) -> PackedVector2Array:
	var r := rng(world_seed, "blob:" + key)
	var controls := PackedVector2Array()
	var phase := r.randf() * TAU
	for i in range(lobes):
		var a := phase + TAU * i / lobes
		var rad := radius * (1.0 - wobble + r.randf() * wobble * 2.0)
		controls.append(Vector2(cos(a), sin(a)) * rad)
	return smooth_loop(controls, 8)

# A superellipse (squircle) outline — smooth rounded body with a tunable corner
# fullness `n` (2 = ellipse, higher = boxier). Great for creature bodies.
func superellipse(rx: float, ry: float, n: float = 2.6, steps: int = 48) -> PackedVector2Array:
	var pts := PackedVector2Array()
	for i in range(steps):
		var a := TAU * i / steps
		var ca := cos(a)
		var sa := sin(a)
		pts.append(Vector2(
			sign(ca) * pow(abs(ca), 2.0 / n) * rx,
			sign(sa) * pow(abs(sa), 2.0 / n) * ry))
	return pts

# ---- gradient fills ---------------------------------------------------------

# Vertex-coloured vertical gradient fill of a polygon: cheap, smooth, no texture.
func grad_fill(poly: PackedVector2Array, top: Color, bot: Color) -> PackedColorArray:
	var min_y := INF
	var max_y := -INF
	for p in poly:
		min_y = min(min_y, p.y)
		max_y = max(max_y, p.y)
	var span: float = max(0.001, max_y - min_y)
	var cols := PackedColorArray()
	for p in poly:
		cols.append(top.lerp(bot, (p.y - min_y) / span))
	return cols
