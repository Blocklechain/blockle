class_name ActionBubble
extends Control
# ActionBubble — the small floating in-world action menu that a TAP on a placed thing
# raises (IDLE-DESIGN §2.3). It is the ONLY thing that replaces the old tab panels and
# modal stack: a 1–3 button parchment pill that hovers just above the tapped thing,
# follows it as the world pans, and fades after a few seconds or on an outside tap.
# No slide-up, no dim overlay, no nav — just a whisper of chrome touching the world.
#
# It lives on the screen-space UI layer (so its buttons are crisp and reliably
# tappable) but is positioned every frame at the tapped thing's on-screen crown by the
# controller (Interact), which also drops a glowing ProcEffects selection ring on the
# thing itself in the world. The bubble only renders the choices and reports the pick.
#
# Actions are chosen per entity kind by ItemCatalog.actions_for():
#   nurture · harvest · inspect · assign · mint · pickup
#
# PUBLIC API (Interact drives it):
#   show_actions(actions:Array[String], screen_pos:Vector2)
#   move_to(screen_pos:Vector2)            — keep it glued above a panning thing
#   dismiss()
#   is_open() -> bool
# SIGNAL:
#   action_chosen(action:String)

signal action_chosen(action: String)

const PARCH := Color("#FBF6E9")
const INK := Color("#3A2E22")

const LABELS := {
	"nurture": "Nurture", "harvest": "Harvest", "inspect": "Inspect",
	"assign": "Assign", "mint": "Mint", "pickup": "Pick up",
}
const TINTS := {
	"nurture": Color("#7FE3B0"), "harvest": Color("#FFC978"), "inspect": Color("#AED4FF"),
	"assign": Color("#E6A6C2"), "mint": Color("#C79BFF"), "pickup": Color("#D8C291"),
}

var _row: HBoxContainer
var _open := false
var _life := 0.0
const LIFETIME := 3.4


func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_PASS
	visible = false
	z_index = 60
	_row = HBoxContainer.new()
	_row.add_theme_constant_override("separation", 8)
	add_child(_row)


func is_open() -> bool:
	return _open


func show_actions(actions: Array, screen_pos: Vector2) -> void:
	for ch in _row.get_children():
		ch.queue_free()
	for a in actions:
		_row.add_child(_make_button(String(a)))
	_open = true
	_life = 0.0
	visible = true
	modulate.a = 0.0
	# size follows content; sort so we can centre it over the thing
	await get_tree().process_frame
	_center_on(screen_pos)
	var tw := create_tween().set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
	scale = Vector2(0.8, 0.8)
	tw.parallel().tween_property(self, "modulate:a", 1.0, 0.16)
	tw.parallel().tween_property(self, "scale", Vector2.ONE, 0.22)


func move_to(screen_pos: Vector2) -> void:
	if _open:
		_center_on(screen_pos)


func _center_on(screen_pos: Vector2) -> void:
	var w := _row.get_combined_minimum_size().x + 24.0
	var h := 68.0
	size = Vector2(w, h)
	_row.position = Vector2(12, 8)
	# pivot at the bubble's bottom-centre so the pop scales up from the thing
	pivot_offset = Vector2(w * 0.5, h)
	position = screen_pos - Vector2(w * 0.5, h + 10.0)


func dismiss() -> void:
	if not _open:
		return
	_open = false
	var tw := create_tween()
	tw.tween_property(self, "modulate:a", 0.0, 0.16)
	tw.tween_callback(func(): visible = false)


func _process(delta: float) -> void:
	if not _open:
		return
	_life += delta
	if _life >= LIFETIME:
		dismiss()


func _make_button(action: String) -> Control:
	var tint: Color = TINTS.get(action, Color("#E7D4A8"))
	var holder := Control.new()
	holder.custom_minimum_size = Vector2(96, 52)

	var b := Button.new()
	b.text = String(LABELS.get(action, action.capitalize()))
	b.focus_mode = Control.FOCUS_NONE
	b.custom_minimum_size = Vector2(96, 52)
	b.add_theme_font_size_override("font_size", 22)
	b.add_theme_color_override("font_color", INK)
	b.add_theme_color_override("font_hover_color", INK)
	b.add_theme_color_override("font_pressed_color", INK)
	b.add_theme_stylebox_override("normal", _pill(tint.lerp(PARCH, 0.45)))
	b.add_theme_stylebox_override("hover", _pill(tint.lerp(PARCH, 0.30)))
	b.add_theme_stylebox_override("pressed", _pill(tint.lerp(INK, 0.15)))
	b.pressed.connect(func():
		emit_signal("action_chosen", action)
		dismiss())
	holder.add_child(b)
	return holder


func _pill(bg: Color) -> StyleBoxFlat:
	var s := StyleBoxFlat.new()
	s.bg_color = bg
	s.set_corner_radius_all(26)
	s.content_margin_left = 14
	s.content_margin_right = 14
	s.content_margin_top = 8
	s.content_margin_bottom = 8
	s.shadow_color = Color(0, 0, 0, 0.18)
	s.shadow_size = 4
	return s
