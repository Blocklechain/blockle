extends Node
# Pal — THE palette. One fixed, hand-picked, limited colour set that EVERYTHING
# in the game draws from. Nothing may invent a colour.
#
# This is the art direction, and it is deliberately strict: a small cohesive
# palette is what makes pixel art read as intentional instead of noisy. The rules:
#
#   * Cool shadows, warm lights. Shadows drift toward plum/indigo, lights toward
#     gold. That single relationship is what makes the whole scene feel lit.
#   * Every solid material is a TRIPLE — top / left / right — the three faces of
#     an isometric cube, in descending brightness. Drawing a cube with three
#     shades of one hue is what sells 3D with no shading maths at all.
#   * Nothing is pure black or pure white. Deep plum stands in for black, warm
#     cream for white, so the image never feels like clip-art.
#   * Saturation stays mid-to-high. The last build washed out; this one commits.

# ---- the base ramp (shared darks/lights keep everything in one family) -------
const INK        := Color("#2b1e35")   # deepest shadow / outlines (plum, not black)
const INK_SOFT   := Color("#4a3358")
const CREAM      := Color("#ffeedd")   # highest light (warm, not white)
const GOLD       := Color("#ffc96b")   # the warm key light
const GOLD_DEEP  := Color("#e8903c")

# ---- sky / atmosphere --------------------------------------------------------
const SKY_HI     := Color("#4fc4c4")   # zenith teal
const SKY_MID    := Color("#7fd8cc")
const SKY_LO     := Color("#d9f2e0")   # horizon haze
const CLOUD      := Color("#f2fbf4")
const CLOUD_SH   := Color("#b9ddd8")

# ---- GRASS (the island crown) ------------------------------------------------
const GRASS_T    := Color("#8ed158")   # top face
const GRASS_L    := Color("#5fa83f")   # left face
const GRASS_R    := Color("#3f7e32")   # right face

# ---- SOIL (under the grass) --------------------------------------------------
const SOIL_T     := Color("#a9703f")
const SOIL_L     := Color("#834f2c")
const SOIL_R     := Color("#5d361f")

# ---- ROCK (the craggy underside) ---------------------------------------------
const ROCK_T     := Color("#6d6484")
const ROCK_L     := Color("#514a68")
const ROCK_R     := Color("#3a3450")

# ---- BOULDER (rocks sitting ON the grass; the deep ROCK purple is for the
# island's shadowed underside and reads as a hole when used up in the light) ---
const BLDR_T     := Color("#b9b2a6")
const BLDR_L     := Color("#8e8679")
const BLDR_R     := Color("#6b6459")

# ---- WOOD (walls, fences, carts) ---------------------------------------------
const WOOD_T     := Color("#c08b55")
const WOOD_L     := Color("#97653b")
const WOOD_R     := Color("#6e4728")

# ---- STONE (cottage walls) ---------------------------------------------------
const STONE_T    := Color("#efe3cd")
const STONE_L    := Color("#c9b79c")
const STONE_R    := Color("#9d8a74")

# ---- ROOF (the blue shingles from the reference) -----------------------------
const ROOF_T     := Color("#6fc2d8")
const ROOF_L     := Color("#4592b5")
const ROOF_R     := Color("#2f6690")

# ---- WATER -------------------------------------------------------------------
const WATER_T    := Color("#6fd6e8")
const WATER_L    := Color("#3fa8d0")
const WATER_R    := Color("#2d7cae")

# ---- FOLIAGE (tree canopies — deeper than grass so trees read against it) ----
const LEAF_T     := Color("#4fa65c")   # deeper + bluer than the turf, so a tree
const LEAF_L     := Color("#2f7547")   # never dissolves into the grass behind it
const LEAF_R     := Color("#1d4d33")
const BLOSSOM    := Color("#ffb3cd")

# ---- autumn / accent foliage -------------------------------------------------
const AUT_T      := Color("#f0a648")
const AUT_L      := Color("#c9742c")
const AUT_R      := Color("#9a4f20")

# ---- creature base (the Blocklings) -----------------------------------------
const KIN_T      := Color("#f5d9a8")
const KIN_L      := Color("#d9b27e")
const KIN_R      := Color("#b08a5e")

# ---- glow / UI ---------------------------------------------------------------
const GLOW       := Color("#ffe9a8")
const UI_BG      := Color("#2b1e35")
const UI_EDGE    := Color("#4a3358")


# Sun-tint a material triple. The sun sits up-left, so the TOP face catches warm
# gold, the left face (facing it) stays near-true, and the right face falls away
# into a cool shadow. Applying this one relationship to every surface in the
# scene is what makes a flat palette suddenly look LIT.
static func sun(m: Array, strength: float = 1.0) -> Array:
	return [
		m[0].lerp(GOLD, 0.16 * strength),
		m[1].lerp(CREAM, 0.05 * strength),
		m[2].lerp(INK_SOFT, 0.18 * strength)]

# Push a material toward the sky as it recedes — aerial perspective. Distant
# ground reads as further away without moving a single pixel.
static func haze(m: Array, amount: float) -> Array:
	var a: float = clampf(amount, 0.0, 1.0)
	return [m[0].lerp(SKY_LO, a * 0.30), m[1].lerp(SKY_LO, a * 0.26), m[2].lerp(SKY_LO, a * 0.22)]


# ---- TIME OF DAY -------------------------------------------------------------
# Four keyed moods. The world lerps between them, and because every surface is
# tinted through sun()/haze() from these same values, the entire island changes
# character together instead of the sky alone shifting.
#   [sky_hi, sky_mid, sky_lo, sun_warm, shadow_cool, strength]
const TOD_NIGHT := [Color("#141d3a"), Color("#1f2b4d"), Color("#36406b"),
	Color("#9fb8e8"), Color("#0d1026"), 0.40]
const TOD_DAWN  := [Color("#5d7fc4"), Color("#e89a7a"), Color("#f6d2a8"),
	Color("#ffb877"), Color("#3c2a4a"), 0.85]
const TOD_DAY   := [Color("#4fc4c4"), Color("#7fd8cc"), Color("#d9f2e0"),
	Color("#ffc96b"), Color("#4a3358"), 1.00]
const TOD_DUSK  := [Color("#44407e"), Color("#d4746a"), Color("#f0b183"),
	Color("#ff9d5c"), Color("#2e2347"), 0.58]

# Blend the four moods for a time 0..1 (0 = midnight, .25 = dawn, .5 = noon,
# .75 = dusk) and return the keyed set for this instant.
static func tod_mix(tod: float) -> Array:
	var x: float = fposmod(tod, 1.0)
	var a: Array = TOD_NIGHT
	var b: Array = TOD_NIGHT
	var f := 0.0
	if x < 0.22:        a = TOD_NIGHT; b = TOD_DAWN;  f = x / 0.22
	elif x < 0.36:      a = TOD_DAWN;  b = TOD_DAY;   f = (x - 0.22) / 0.14
	elif x < 0.64:      a = TOD_DAY;   b = TOD_DAY;   f = 0.0
	elif x < 0.80:      a = TOD_DAY;   b = TOD_DUSK;  f = (x - 0.64) / 0.16
	else:               a = TOD_DUSK;  b = TOD_NIGHT; f = (x - 0.80) / 0.20
	f = f * f * (3.0 - 2.0 * f)
	return [
		(a[0] as Color).lerp(b[0], f), (a[1] as Color).lerp(b[1], f),
		(a[2] as Color).lerp(b[2], f), (a[3] as Color).lerp(b[3], f),
		(a[4] as Color).lerp(b[4], f), lerpf(float(a[5]), float(b[5]), f)]

# Sun-tint a material with an EXPLICIT light (warm key + cool shadow + strength),
# so dawn gold and dusk amber reach every surface, not just the sky.
static func lit(m: Array, warm: Color, cool: Color, strength: float, k: float = 1.0) -> Array:
	var s: float = clampf(strength * k, 0.0, 1.6)
	# How far from full daylight we are. This is the lever that actually carries
	# dusk and night onto the GROUND — tinting only the sky left the island
	# sitting in flat noon green under a purple sunset.
	var dark: float = clampf(1.0 - strength, 0.0, 1.0)
	var out: Array = []
	for i in range(3):
		var c: Color = m[i]
		c = c.lerp(cool, dark * 0.62)          # everything drifts into the ambient
		c = c.darkened(dark * 0.30)            # and loses light
		out.append(c)
	out[0] = (out[0] as Color).lerp(warm, 0.22 * s)   # warm key on the top face
	out[1] = (out[1] as Color).lerp(warm, 0.08 * s)
	out[2] = (out[2] as Color).lerp(cool, 0.18)       # shadow side stays cool
	return out

# A material triple: [top, left, right] faces of an iso cube.
static func mat(name: String) -> Array:
	match name:
		"grass":   return [GRASS_T, GRASS_L, GRASS_R]
		"soil":    return [SOIL_T, SOIL_L, SOIL_R]
		"rock":    return [ROCK_T, ROCK_L, ROCK_R]
		"boulder": return [BLDR_T, BLDR_L, BLDR_R]
		"wood":    return [WOOD_T, WOOD_L, WOOD_R]
		"stone":   return [STONE_T, STONE_L, STONE_R]
		"roof":    return [ROOF_T, ROOF_L, ROOF_R]
		"water":   return [WATER_T, WATER_L, WATER_R]
		"leaf":    return [LEAF_T, LEAF_L, LEAF_R]
		"autumn":  return [AUT_T, AUT_L, AUT_R]
		"kin":     return [KIN_T, KIN_L, KIN_R]
	return [GRASS_T, GRASS_L, GRASS_R]
