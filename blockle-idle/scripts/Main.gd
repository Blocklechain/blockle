extends Node2D
# Main — mounts the island and the basket, and owns the only two gestures in the
# game:
#
#   DRAG FROM THE BASKET  ->  a ghost follows your finger, the target tile lights
#                             green (or red if it will not take), release to plant
#   DRAG ON THE WORLD     ->  pan the island, softly clamped so it never sails off
#
# There is no other menu, no nav bar, no modal. Everything else the player does
# happens by touching the world itself.

var _world: World
var _tray: Tray
var _panning := false
var _pan_from := Vector2.ZERO
var _cam_from := Vector2.ZERO
var _cam := Vector2.ZERO
var _press := Vector2.ZERO
var _whisper := ""
var _whisper_t := 0.0

func _ready() -> void:
	_world = World.new()
	add_child(_world)
	_tray = Tray.new()
	add_child(_tray)
	_frame()
	get_viewport().size_changed.connect(_frame)

func _frame() -> void:
	var vp := get_viewport_rect().size
	_tray.vp = vp
	_cam = Vector2(vp.x * 0.5, vp.y * 0.42).round()
	_world.position = _cam

func _process(delta: float) -> void:
	if _whisper_t > 0.0:
		_whisper_t -= delta
	queue_redraw()

# ---- input -------------------------------------------------------------------

func _unhandled_input(e: InputEvent) -> void:
	if e is InputEventScreenTouch or e is InputEventMouseButton:
		if e.pressed:
			_on_press(_pos(e))
		else:
			_on_release(_pos(e))
	elif e is InputEventScreenDrag or e is InputEventMouseMotion:
		_on_drag(_pos(e))

func _pos(e: InputEvent) -> Vector2:
	if e is InputEventScreenTouch or e is InputEventScreenDrag:
		return e.position
	return get_viewport().get_mouse_position()

func _on_press(p: Vector2) -> void:
	_press = p
	var slot := _tray.slot_at(p)
	if slot >= 0:
		if int(_tray.items[slot]["n"]) > 0:
			_tray.held = slot          # lifted out of the basket
		else:
			_say("you have none left")
		return
	_panning = true
	_pan_from = p
	_cam_from = _cam

func _on_drag(p: Vector2) -> void:
	if _tray.held >= 0:
		# a ghost of the thing, hovering over whichever tile is under the finger
		var k := _world.tile_at(p - _world.position)
		_world.ghost_kind = String(_tray.items[_tray.held]["kind"])
		_world.ghost_tile = k
		_world.ghost_ok = bool(_world.can_plant(k)["ok"])
		return
	if _panning:
		_cam = _cam_from + (p - _pan_from)
		_clamp_cam()
		_world.position = _cam.round()

func _on_release(p: Vector2) -> void:
	if _tray.held >= 0:
		var slot := _tray.held
		_tray.held = -1
		_world.ghost_kind = ""
		# released back over the basket? put it away again, no harm done
		if _tray.slot_at(p) >= 0 or p.y >= _tray.top_y():
			return
		var k := _world.tile_at(p - _world.position)
		var chk := _world.can_plant(k)
		if bool(chk["ok"]):
			if _tray.take(slot):
				_world.plant(String(_tray.items[slot]["kind"]), k)
				_say("planted")
		else:
			_say(String(chk["why"]))
		return
	_panning = false

func _clamp_cam() -> void:
	# the island may wander a little past the edges, never away entirely
	var vp := get_viewport_rect().size
	var home := Vector2(vp.x * 0.5, vp.y * 0.42)
	var ext := Vector2(vp.x * 0.42, vp.y * 0.26)
	_cam.x = clampf(_cam.x, home.x - ext.x, home.x + ext.x)
	_cam.y = clampf(_cam.y, home.y - ext.y, home.y + ext.y)

func _say(msg: String) -> void:
	_whisper = msg
	_whisper_t = 1.8

# ---- the single line of text in the whole game -------------------------------

func _draw() -> void:
	if _whisper_t <= 0.0:
		return
	var vp := get_viewport_rect().size
	var font := ThemeDB.fallback_font
	var fs := 11
	var w := font.get_string_size(_whisper, HORIZONTAL_ALIGNMENT_LEFT, -1, fs).x
	var at := Vector2((vp.x - w) * 0.5, vp.y - Tray.H - 14.0)
	var a: float = clampf(_whisper_t / 0.6, 0.0, 1.0)
	draw_rect(Rect2(at - Vector2(5, 10), Vector2(w + 10, 15)),
		Color(Pal.INK.r, Pal.INK.g, Pal.INK.b, 0.72 * a))
	draw_string(font, at, _whisper, HORIZONTAL_ALIGNMENT_LEFT, -1, fs,
		Color(Pal.CREAM.r, Pal.CREAM.g, Pal.CREAM.b, a))
