extends Node
# Iso — the isometric grid. Every single thing in the world is positioned and
# drawn through this one file, which is exactly why the scene stays coherent:
# there is no second opinion about where "up" is or how big a thing should be.
#
# THE GRID
#   A tile is a 2:1 diamond, TILE_W x TILE_H pixels. Grid coords are (gx, gy)
#   integers, elevation is `z` in half-tile steps. Screen position is a pure
#   function of those three — so nothing can drift off-grid.
#
#   Classic iso:  sx = (gx - gy) * TILE_W/2
#                 sy = (gx + gy) * TILE_H/2 - z * TILE_Z
#
# THE CUBE
#   A solid block is drawn as three faces — top diamond, left quad, right quad —
#   using one material triple from Pal. Three shades of one hue is all it takes
#   to read as a lit 3D object; no shaders, no normals, no lighting maths.
#
#   DRAW ORDER is everything in iso: paint back-to-front, sorted by (gx + gy)
#   then z. depth_of() gives the sort key.

const TILE_W := 32.0          # diamond width  (keep even)
const TILE_H := 16.0          # diamond height (exactly half the width)
const TILE_Z := 8.0           # one elevation step in pixels

# ---- projection --------------------------------------------------------------

func to_screen(gx: float, gy: float, z: float = 0.0) -> Vector2:
	return Vector2(
		(gx - gy) * (TILE_W * 0.5),
		(gx + gy) * (TILE_H * 0.5) - z * TILE_Z)

# Inverse: a screen point -> fractional grid coords at elevation z (for touch).
func to_grid(p: Vector2, z: float = 0.0) -> Vector2:
	var y := p.y + z * TILE_Z
	var a := p.x / (TILE_W * 0.5)
	var b := y / (TILE_H * 0.5)
	return Vector2((b + a) * 0.5, (b - a) * 0.5)

# Painter's-algorithm sort key: larger = nearer the camera = drawn later.
func depth_of(gx: float, gy: float, z: float = 0.0) -> float:
	return (gx + gy) * 64.0 + z

# ---- primitives (all pixel-snapped) -----------------------------------------

# The flat top face of a tile: a 2:1 diamond centred on `c`.
func diamond(ci: CanvasItem, c: Vector2, col: Color, w: float = TILE_W, h: float = TILE_H) -> void:
	var hw := w * 0.5
	var hh := h * 0.5
	ci.draw_colored_polygon(PackedVector2Array([
		Vector2(c.x, c.y - hh), Vector2(c.x + hw, c.y),
		Vector2(c.x, c.y + hh), Vector2(c.x - hw, c.y)]), col)

# A full isometric cube at grid (gx,gy,z) of height `h` elevation steps.
# `m` is a Pal material triple [top, left, right].
func cube(ci: CanvasItem, gx: float, gy: float, z: float, h: float, m: Array,
		w_mul: float = 1.0) -> void:
	var w := TILE_W * w_mul
	var hw := w * 0.5
	var hh := TILE_H * 0.5 * w_mul
	var top := to_screen(gx, gy, z + h)
	var dz := h * TILE_Z
	# left face (faces screen-left/down)
	ci.draw_colored_polygon(PackedVector2Array([
		Vector2(top.x - hw, top.y), Vector2(top.x, top.y + hh),
		Vector2(top.x, top.y + hh + dz), Vector2(top.x - hw, top.y + dz)]), m[1])
	# right face
	ci.draw_colored_polygon(PackedVector2Array([
		Vector2(top.x + hw, top.y), Vector2(top.x, top.y + hh),
		Vector2(top.x, top.y + hh + dz), Vector2(top.x + hw, top.y + dz)]), m[2])
	# top face last (it overlaps both sides)
	diamond(ci, top, m[0], w, TILE_H * w_mul)

# A "slab": a cube one elevation step tall — the standard ground tile.
func tile(ci: CanvasItem, gx: float, gy: float, z: float, m: Array) -> void:
	cube(ci, gx, gy, z, 1.0, m)

# An upright pixel box (not iso-projected) for sprite-ish details: trunks,
# windows, chimneys. Snapped so it stays crisp.
func box(ci: CanvasItem, at: Vector2, size: Vector2, col: Color) -> void:
	ci.draw_rect(Rect2(at.round(), size.round()), col)

# A soft elliptical contact shadow on the ground under something.
func shadow(ci: CanvasItem, c: Vector2, w: float = TILE_W * 0.8) -> void:
	diamond(ci, c, Color(Pal.INK.r, Pal.INK.g, Pal.INK.b, 0.22), w, w * 0.5)
