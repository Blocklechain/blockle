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
