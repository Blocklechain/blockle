class_name InventoryTray
extends Control
# InventoryTray — THE ONE MENU. (IDLE-DESIGN §2.2)
#
# The entire nav-bar / tabs / slide-up-panel / modal stack is gone. In its place is
# this single bottom shelf: a soft parchment drawer holding a horizontally-scrolling
# row of the living things you own — seeds, spores, shards, decor, eggs, building
# plans and minted keepsakes. There are NO sub-tabs; categories are just colour-sorted
# runs in the one scroll row, and a category you own nothing in simply isn't there.
#
# Every chip is a LIVE procedural thumbnail (a tiny breathing tree, a glowing crystal,
# a curled creature — the SAME generator that will draw the real thing once planted,
# via ItemCatalog) over a count badge. The whole point of the game's interaction model
# lives here: you DRAG a chip up out of the tray and the world receives a ghost that
# follows your finger (Interact handles the ghost + placement). The tray's job is only
# to (1) show what you own, beautifully and alive, and (2) report drag gestures.
#
# It peeks as a short handle when idle; a short upward drag on the handle expands it;
# it auto-collapses the moment you begin placing, and never covers more than the
# bottom ~22% of the screen.
#
# PUBLIC API (Interact drives it):
#   setup(world_seed:int)                      — build once
#   refresh()                                  — rebuild chips from Game.state["inventory"]
#   consume(inst_key:String)                   — decrement a stack after a successful plant
#   add_entry(entry:Dictionary)                — return an uprooted/placed thing to the tray
#   collapse() / expand()                      — drawer state
#   entry_for(inst_key) -> Dictionary
#   set_height_px(h) / tray_rect() -> Rect2
# SIGNALS (to Interact):
#   drag_started(inst_key, entry, global_pos)
#   drag_moved(global_pos)
#   drag_released(global_pos)

signal drag_started(inst_key: String, entry: Dictionary, global_pos: Vector2)
signal drag_moved(global_pos: Vector2)
signal drag_released(global_pos: Vector2)

const PARCH := Color("#FBF6E9")
const PARCH2 := Color("#F2E7CE")
const INK := Color("#3A2E22")
const INK_SOFT := Color("#6E5B46")

# category ordering + a tint accent per kind, so the one row reads as tidy runs
const KIND_ORDER := ["tree", "plant", "fungus", "crystal", "water", "decor", "creature", "building"]
const KIND_TINT := {
	"tree": Color("#8FBF6A"), "plant": Color("#E6A6C2"), "fungus": Color("#D8A05C"),
	"crystal": Color("#8FB8FF"), "water": Color("#7FD3E3"), "decor": Color("#C9A66B"),
	"creature": Color("#F2C14E"), "building": Color("#B59B7A"),
}

var world_seed: int = 1
var _expanded := false
var _tray_h := 196.0
var _handle_h := 74.0
var _inset_bot := 16.0

var _scroll: ScrollContainer
var _row: HBoxContainer
var _handle_btn: Button
var _dragging := ""            # inst_key currently being dragged out (or "")
var _press_origin := Vector2.ZERO
var _press_in_tray := false
var _handle_drag := false

# chip bookkeeping: inst_key -> { chip:Control, count_lbl:Label, thumb:_Thumb }
var _chips := {}


# =============================================================================
func setup(seed_value: int) -> void:
	world_seed = seed_value
	mouse_filter = Control.MOUSE_FILTER_PASS
	_build()
	refresh()
	collapse()


func _build() -> void:
	# backing parchment shelf
	var bg := Panel.new()
	bg.name = "bg"
	bg.add_theme_stylebox_override("panel", _sb(Color(PARCH.r, PARCH.g, PARCH.b, 0.97), 26, 0))
	bg.set_anchors_preset(Control.PRESET_FULL_RECT)
	bg.mouse_filter = Control.MOUSE_FILTER_PASS
	add_child(bg)

	# a slim grab-handle / collapse toggle across the top of the shelf
	_handle_btn = Button.new()
	_handle_btn.flat = true
	_handle_btn.focus_mode = Control.FOCUS_NONE
	_handle_btn.name = "handle"
	_handle_btn.mouse_filter = Control.MOUSE_FILTER_PASS
	var hb := _HandleBar.new()
	hb.mouse_filter = Control.MOUSE_FILTER_IGNORE
	hb.set_anchors_preset(Control.PRESET_FULL_RECT)
	_handle_btn.add_child(hb)
	_handle_btn.pressed.connect(func(): _toggle())
	add_child(_handle_btn)

	# the single scrolling chip row — no sub-tabs
	_scroll = ScrollContainer.new()
	_scroll.name = "scroll"
	_scroll.vertical_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_AUTO
	_scroll.mouse_filter = Control.MOUSE_FILTER_PASS
	add_child(_scroll)
	_row = HBoxContainer.new()
	_row.add_theme_constant_override("separation", 10)
	_row.alignment = BoxContainer.ALIGNMENT_CENTER
	_row.mouse_filter = Control.MOUSE_FILTER_PASS
	_scroll.add_child(_row)


# =============================================================================
# DATA → CHIPS
# =============================================================================
func _inventory() -> Dictionary:
	if Game and Game.state:
		return Game.state.get("inventory", {})
	return {}


func refresh() -> void:
	for ch in _row.get_children():
		ch.queue_free()
	_chips.clear()
	var inv := _inventory()
	var keys := inv.keys()
	# colour-sorted runs: order by kind, then label, so categories cluster visually
	keys.sort_custom(func(a, b):
		var ka := String(inv[a].get("kind", "plant"))
		var kb := String(inv[b].get("kind", "plant"))
		var ia := KIND_ORDER.find(ka)
		var ib := KIND_ORDER.find(kb)
		if ia != ib:
			return ia < ib
		return String(inv[a].get("label", a)) < String(inv[b].get("label", b)))
	for k in keys:
		var entry: Dictionary = inv[k]
		if int(entry.get("count", 0)) <= 0:
			continue
		_row.add_child(_make_chip(String(k), entry))


func _make_chip(inst_key: String, entry: Dictionary) -> Control:
	var kind := String(entry.get("kind", "plant"))
	var tint: Color = KIND_TINT.get(kind, INK_SOFT)
	var chip := Control.new()
	chip.custom_minimum_size = Vector2(108, 118)
	chip.mouse_filter = Control.MOUSE_FILTER_STOP

	# soft rounded card under the thumbnail
	var card := Panel.new()
	card.add_theme_stylebox_override("panel", _sb(Color(tint.r, tint.g, tint.b, 0.18), 20, 0))
	card.set_anchors_preset(Control.PRESET_FULL_RECT)
	card.mouse_filter = Control.MOUSE_FILTER_IGNORE
	chip.add_child(card)

	# the LIVE procedural thumbnail — same generator as the planted thing
	var thumb := _Thumb.new()
	thumb.setup(world_seed, inst_key, entry)
	thumb.mouse_filter = Control.MOUSE_FILTER_IGNORE
	thumb.position = Vector2(54, 92)
	thumb.custom_minimum_size = Vector2(108, 100)
	chip.add_child(thumb)

	# minted keepsakes wear a tiny drawn frost glint so you can tell them apart
	if bool(entry.get("minted", false)):
		var frost := _FrostDot.new()
		frost.position = Vector2(16, 14)
		frost.mouse_filter = Control.MOUSE_FILTER_IGNORE
		chip.add_child(frost)

	# count badge
	var count := int(entry.get("count", 1))
	var cl := Label.new()
	cl.text = "x%d" % count
	cl.add_theme_font_size_override("font_size", 20)
	cl.add_theme_color_override("font_color", INK)
	cl.add_theme_color_override("font_outline_color", PARCH)
	cl.add_theme_constant_override("outline_size", 4)
	cl.position = Vector2(66, 90)
	cl.mouse_filter = Control.MOUSE_FILTER_IGNORE
	chip.add_child(cl)

	# label
	var nm := Label.new()
	nm.text = ItemCatalog.display_label(entry)
	nm.add_theme_font_size_override("font_size", 14)
	nm.add_theme_color_override("font_color", INK_SOFT)
	nm.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	nm.set_anchors_preset(Control.PRESET_BOTTOM_WIDE)
	nm.position = Vector2(0, 98)
	nm.size = Vector2(108, 20)
	nm.mouse_filter = Control.MOUSE_FILTER_IGNORE
	chip.add_child(nm)

	chip.gui_input.connect(_on_chip_input.bind(inst_key, entry))
	_chips[inst_key] = {"chip": chip, "count_lbl": cl, "thumb": thumb}
	return chip


# =============================================================================
# DRAG — press a chip, drag it up into the world
# =============================================================================
func _on_chip_input(event: InputEvent, inst_key: String, entry: Dictionary) -> void:
	if event is InputEventScreenTouch or event is InputEventMouseButton:
		if event.pressed:
			_dragging = inst_key
			_press_origin = event.global_position if event is InputEventMouseButton else _row.get_global_mouse_position()
			emit_signal("drag_started", inst_key, entry, _global_point(event))
			accept_event()


# Because a drag leaves the chip bounds immediately, the TRAY watches the whole
# gesture via _input once a chip has been grabbed. This also stops the ScrollContainer
# from hijacking an upward place-drag.
func _input(event: InputEvent) -> void:
	if _dragging == "":
		return
	if event is InputEventScreenDrag or event is InputEventMouseMotion:
		emit_signal("drag_moved", _global_point(event))
		accept_event()
	elif (event is InputEventScreenTouch or event is InputEventMouseButton) and not event.pressed:
		var where := _global_point(event)
		_dragging = ""
		emit_signal("drag_released", where)
		accept_event()


func _global_point(event: InputEvent) -> Vector2:
	if event is InputEventMouseButton or event is InputEventMouseMotion:
		return event.global_position
	if event is InputEventScreenTouch or event is InputEventScreenDrag:
		return event.position
	return get_global_mouse_position()


# =============================================================================
# STACK MUTATION
# =============================================================================
func entry_for(inst_key: String) -> Dictionary:
	return _inventory().get(inst_key, {})


func consume(inst_key: String) -> void:
	if not (Game and Game.state):
		return
	var inv: Dictionary = Game.state.get("inventory", {})
	if not inv.has(inst_key):
		return
	inv[inst_key]["count"] = int(inv[inst_key].get("count", 1)) - 1
	if int(inv[inst_key]["count"]) <= 0:
		inv.erase(inst_key)
	Game.state["inventory"] = inv
	refresh()


# Put a thing back into the tray. Fresh/identical stacks merge; a minted keepsake or
# a partially-grown uprooted thing becomes its own stack so its growth is preserved.
func add_entry(entry: Dictionary) -> void:
	if not (Game and Game.state):
		return
	var inv: Dictionary = Game.state.get("inventory", {})
	var minted := bool(entry.get("minted", false))
	var growth := float(entry.get("growth", -1.0))
	var stackable := (not minted) and growth < 0.0
	var key := ""
	if stackable:
		key = "seed:%s:%s" % [String(entry.get("kind", "plant")), String(entry.get("species", ""))]
		if inv.has(key):
			inv[key]["count"] = int(inv[key].get("count", 0)) + 1
			Game.state["inventory"] = inv
			refresh()
			return
	else:
		key = "keep:%d" % (int(Game.state.get("uid_counter", 0)))
		Game.state["uid_counter"] = int(Game.state.get("uid_counter", 0)) + 1
	var stored := entry.duplicate(true)
	stored["count"] = 1
	inv[key] = stored
	Game.state["inventory"] = inv
	refresh()


# =============================================================================
# DRAWER STATE
# =============================================================================
func collapse() -> void:
	_expanded = false
	_animate_height(_handle_h + _inset_bot)


func expand() -> void:
	_expanded = true
	_animate_height(_tray_h + _inset_bot)


func _toggle() -> void:
	if _expanded:
		collapse()
	else:
		expand()


func is_expanded() -> bool:
	return _expanded


func set_inset_bottom(b: float) -> void:
	_inset_bot = b
	if _expanded:
		expand()
	else:
		collapse()


func _animate_height(h: float) -> void:
	custom_minimum_size.y = h
	# the tray is anchored to the bottom by the host; it grows upward from there
	var parent_size := get_parent_area_size() if get_parent() else Vector2(1080, 1920)
	position = Vector2(0, parent_size.y - h)
	size = Vector2(parent_size.x, h)
	_layout()


func tray_rect() -> Rect2:
	return Rect2(position, size)


func _layout() -> void:
	var w := size.x
	var hb: Node = get_node_or_null("handle")
	if hb:
		(hb as Control).position = Vector2(0, 0)
		(hb as Control).size = Vector2(w, _handle_h)
	if _scroll:
		_scroll.position = Vector2(8, _handle_h)
		_scroll.size = Vector2(w - 16, maxf(0.0, size.y - _handle_h - _inset_bot))
	var bg: Node = get_node_or_null("bg")
	if bg:
		(bg as Control).set_anchors_preset(Control.PRESET_FULL_RECT)


func _notification(what: int) -> void:
	if what == NOTIFICATION_RESIZED:
		_layout()


# =============================================================================
func _sb(bg: Color, radius: int, pad: int) -> StyleBoxFlat:
	var s := StyleBoxFlat.new()
	s.bg_color = bg
	s.corner_radius_top_left = radius
	s.corner_radius_top_right = radius
	s.content_margin_left = pad
	s.content_margin_right = pad
	s.content_margin_top = pad
	s.content_margin_bottom = pad
	return s


# =============================================================================
#  _Thumb — a live procedural mini of the inventory item, breathing in the tray.
#  It hosts the REAL ItemCatalog node at a small stage so the chip, the drag-ghost
#  and the planted thing are visibly one individual (CONVENTIONS rule 3).
# =============================================================================
class _Thumb extends Control:
	var _node: ProcNode

	func setup(world_seed: int, inst_key: String, entry: Dictionary) -> void:
		var stage := 0.72
		if bool(entry.get("minted", false)):
			stage = clampf(float(entry.get("growth", 0.9)), 0.4, 1.0)
		_node = ItemCatalog.make_node(world_seed, "thumb:" + inst_key, entry, {}, stage)
		# freeze the thumbnail's slow growth so it just idles prettily in the tray
		_node.grow_rate = 0.0
		var box := 100.0
		var fr := 24.0
		if _node.get("footprint_radius") != null:
			fr = maxf(10.0, float(_node.get("footprint_radius")))
		var s: float = clampf(box * 0.42 / fr, 0.25, 1.1)
		_node.scale = Vector2(s, s)
		add_child(_node)

	func _ready() -> void:
		custom_minimum_size = Vector2(108, 100)


# =============================================================================
#  _HandleBar — the little pill + grabber drawn across the drawer's top edge.
# =============================================================================
class _HandleBar extends Control:
	func _draw() -> void:
		var w := size.x
		var cx := w * 0.5
		# grab pill
		var pill := Rect2(cx - 34, 14, 68, 8)
		draw_rect(pill, Color(0.42, 0.35, 0.27, 0.5), true)
		# a faint "basket" label hint
		var ink := Color("#6E5B46")
		draw_line(Vector2(cx - 90, 44), Vector2(cx - 50, 44), Color(ink.r, ink.g, ink.b, 0.25), 2.0, true)
		draw_line(Vector2(cx + 50, 44), Vector2(cx + 90, 44), Color(ink.r, ink.g, ink.b, 0.25), 2.0, true)


# A tiny four-point frost glint marking a minted keepsake in the tray (drawn, no glyph).
class _FrostDot extends Control:
	func _ready() -> void:
		custom_minimum_size = Vector2(18, 18)
		size = Vector2(18, 18)

	func _draw() -> void:
		var c := Vector2(9, 9)
		var r := 8.0
		var col := Color(0.82, 0.92, 1.0, 0.95)
		draw_colored_polygon(PackedVector2Array([
			c + Vector2(0, -r), c + Vector2(r * 0.24, -r * 0.24),
			c + Vector2(r, 0), c + Vector2(r * 0.24, r * 0.24),
			c + Vector2(0, r), c + Vector2(-r * 0.24, r * 0.24),
			c + Vector2(-r, 0), c + Vector2(-r * 0.24, -r * 0.24)]), col)
