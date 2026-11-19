class_name Tray
extends Node2D
# Tray — the ONE menu in the game: a basket of things you can plant.
#
# It is drawn with the same Iso primitives and the same Pal palette as the world,
# so it reads as part of the island rather than as UI pasted over it. Each slot
# shows a tiny live drawing of the thing itself (a real little tree, not an icon
# of a tree) plus how many you hold.
#
# Interaction is one gesture: press a slot and drag out onto the world. Main
# tracks the drag and asks World where it would land; the tray only owns the
# basket and its own hit-testing.

const SLOT := 40
const PAD := 5
const H := 54

var items: Array = [
	{"kind": "tree", "n": 6, "label": "Tree"},
	{"kind": "bush", "n": 5, "label": "Bush"},
	{"kind": "flower", "n": 9, "label": "Bloom"},
	{"kind": "mushroom", "n": 4, "label": "Shroom"},
	{"kind": "cottage", "n": 2, "label": "Home"},
]
var vp := Vector2(360, 640)
var held := -1             # slot index currently being dragged, -1 = none
var t := 0.0

func _process(delta: float) -> void:
	t += delta
	queue_redraw()

func top_y() -> float:
	return vp.y - H

# Which slot a screen point hits, or -1.
func slot_at(p: Vector2) -> int:
	if p.y < top_y():
		return -1
	var x := PAD
	for i in range(items.size()):
		if p.x >= x and p.x <= x + SLOT:
			return i
		x += SLOT + PAD
	return -1

func take(i: int) -> bool:
	if i < 0 or i >= items.size() or int(items[i]["n"]) <= 0:
		return false
	items[i]["n"] = int(items[i]["n"]) - 1
	return true

func give(kind: String) -> void:
	for it in items:
		if String(it["kind"]) == kind:
			it["n"] = int(it["n"]) + 1
			return

func _draw() -> void:
	# the basket shelf: a solid plank with a lighter lip, never a flat grey bar
	var y := top_y()
	draw_rect(Rect2(Vector2(0, y), Vector2(vp.x, H)), Pal.UI_BG)
	draw_rect(Rect2(Vector2(0, y), Vector2(vp.x, 2)), Pal.UI_EDGE)
	draw_rect(Rect2(Vector2(0, y + 2), Vector2(vp.x, 1)), Pal.INK_SOFT)
	var x := float(PAD)
	for i in range(items.size()):
		_slot(i, Vector2(x, y + 6.0))
		x += SLOT + PAD

func _slot(i: int, at: Vector2) -> void:
	var it: Dictionary = items[i]
	var n := int(it["n"])
	var empty := n <= 0
	# slot well
	var bg: Color = Pal.INK_SOFT if not empty else Pal.INK_SOFT.darkened(0.35)
	draw_rect(Rect2(at, Vector2(SLOT, SLOT)), bg)
	draw_rect(Rect2(at, Vector2(SLOT, 1)), Pal.UI_EDGE.lightened(0.2))
	if held == i:
		# lifted: a bright frame so you can see what is in your hand
		draw_rect(Rect2(at - Vector2(1, 1), Vector2(SLOT + 2, 1)), Pal.GOLD)
		draw_rect(Rect2(at + Vector2(-1, SLOT), Vector2(SLOT + 2, 1)), Pal.GOLD)
		draw_rect(Rect2(at - Vector2(1, 1), Vector2(1, SLOT + 2)), Pal.GOLD)
		draw_rect(Rect2(at + Vector2(SLOT, -1), Vector2(1, SLOT + 2)), Pal.GOLD)
	# a live miniature of the real thing
	var c := at + Vector2(SLOT * 0.5, SLOT * 0.72)
	var dim: float = 1.0 if not empty else 0.35
	_mini(String(it["kind"]), c, dim)
	# count, as pips rather than a number — no font needed, reads instantly
	var px := at.x + 3.0
	for p in range(mini(n, 9)):
		draw_rect(Rect2(Vector2(px + float(p) * 3.0, at.y + SLOT - 4.0), Vector2(2, 2)),
			Pal.GOLD if not empty else Pal.INK)

# Tiny versions of the world props, drawn with the same vocabulary.
func _mini(kind: String, c: Vector2, dim: float) -> void:
	var sway := sin(t * 1.5 + c.x) * 0.6
	match kind:
		"tree":
			draw_rect(Rect2((c + Vector2(-1, -8)).round(), Vector2(2, 8)), _d(Pal.WOOD_R, dim))
			_blob(c + Vector2(0, -11), 13, 7, _d(Pal.LEAF_T, dim), _d(Pal.LEAF_R, dim))
			_blob(c + Vector2(sway * 0.5, -16), 8, 5, _d(Pal.LEAF_T, dim), _d(Pal.LEAF_R, dim))
		"bush":
			_blob(c + Vector2(0, -5), 15, 8, _d(Pal.LEAF_T, dim), _d(Pal.LEAF_R, dim))
			draw_rect(Rect2((c + Vector2(-4, -8)).round(), Vector2(2, 2)), _d(Pal.GOLD_DEEP, dim))
			draw_rect(Rect2((c + Vector2(2, -6)).round(), Vector2(2, 2)), _d(Pal.GOLD_DEEP, dim))
		"flower":
			for j in range(3):
				var ox := -5.0 + float(j) * 5.0
				draw_rect(Rect2((c + Vector2(ox, -7)).round(), Vector2(1, 7)), _d(Pal.LEAF_R, dim))
				var col: Color = [Pal.BLOSSOM, Pal.GOLD, Pal.WATER_T][j]
				draw_rect(Rect2((c + Vector2(ox - 2 + sway, -11)).round(), Vector2(4, 4)), _d(col, dim))
		"mushroom":
			for j in range(2):
				var ox2 := -4.0 + float(j) * 7.0
				draw_rect(Rect2((c + Vector2(ox2, -6)).round(), Vector2(2, 6)), _d(Pal.CREAM, dim))
				draw_rect(Rect2((c + Vector2(ox2 - 2, -9)).round(), Vector2(6, 3)),
					_d(Color("#d9534f"), dim))
		"cottage":
			draw_rect(Rect2((c + Vector2(-8, -9)).round(), Vector2(16, 9)), _d(Pal.STONE_T, dim))
			draw_rect(Rect2((c + Vector2(-10, -13)).round(), Vector2(20, 4)), _d(Pal.ROOF_T, dim))
			draw_rect(Rect2((c + Vector2(-6, -16)).round(), Vector2(12, 3)), _d(Pal.ROOF_T, dim))
			draw_rect(Rect2((c + Vector2(-2, -6)).round(), Vector2(4, 6)), _d(Pal.WOOD_R, dim))
			draw_rect(Rect2((c + Vector2(-7, -7)).round(), Vector2(3, 3)), _d(Pal.GLOW, dim))

func _blob(c: Vector2, w: int, h: int, top: Color, bot: Color) -> void:
	draw_rect(Rect2((c - Vector2(w * 0.5, h * 0.5)).round(), Vector2(w, h)), bot)
	draw_rect(Rect2((c - Vector2(w * 0.5 - 1, h * 0.5)).round(), Vector2(w - 2, h - 3)), top)

func _d(c: Color, dim: float) -> Color:
	return c if dim >= 0.99 else c.darkened(1.0 - dim).lerp(Pal.INK, 0.25)
