class_name WorldCamera
extends Camera2D
# ---------------------------------------------------------------------------
# WorldCamera — the thumb-drag, inertial, softly-clamped view of the living
# world (Blockle Idle, §2.5 of docs/IDLE-DESIGN.md).
#
# The world is a *modest* place: only slightly larger than the screen. You can
# drag it a little in each direction, feel a soft rubber-band at the borders,
# and pinch-zoom within tight limits — never get lost, never hit a hard wall.
# As the island is woven larger by Rootwork puzzles, the bounds grow with it
# (WorldStage calls `set_world_rect`), always keeping the same "just-beyond-the
# -edge" margin.
#
# This is a pure CONTROLLER: it owns no input routing of its own. WorldStage
# feeds it gestures (`grab`, `drag`, `release`, `pinch`, `wheel_zoom`) after it
# has decided a touch was a world-pan and not a tap-on-a-thing or a tray pull.
# Everything here is cheap: a little vector maths per frame, no allocation, no
# redraw. The camera transform itself does all the visual work (and drives the
# ParallaxBackground automatically), honouring CONVENTIONS rule 6.
#
# Coordinate notes:
#   * The camera lives in WORLD space; `position` is the world point at screen
#     centre. `zoom` > 1 means zoomed IN (a smaller visible area).
#   * `world_rect` is the clamp box in world space. The VISIBLE rect is kept
#     inside it; if the world is smaller than the view on an axis, that axis is
#     simply locked to the world centre.
# ---------------------------------------------------------------------------

# ---- tuning ----------------------------------------------------------------
@export var min_zoom: float = 0.82          # most zoomed-OUT (see a touch more)
@export var max_zoom: float = 1.28          # most zoomed-IN  (tight limit, §2.5)
@export var zoom_ease: float = 10.0         # how snappily zoom settles
@export var pan_ease: float = 16.0          # position smoothing toward target
@export var inertia_friction: float = 4.2   # per-second damping of fling velocity
@export var inertia_min: float = 6.0        # below this speed (world px/s) we stop
@export var rubber_give: float = 0.42       # fraction of overscroll allowed past the edge
@export var rubber_return: float = 9.0      # how fast overscroll eases back in
@export var fling_scale: float = 0.85       # how much release velocity becomes a fling
@export var idle_drift: float = 0.0         # tiny ambient sway amplitude (0 = off)

# ---- clamp box -------------------------------------------------------------
var world_rect: Rect2 = Rect2(-540, -960, 1080, 1920)

# ---- live state ------------------------------------------------------------
var _target: Vector2 = Vector2.ZERO         # desired camera centre (pre rubber-band)
var _vel: Vector2 = Vector2.ZERO            # inertial velocity (world px/s)
var _dragging: bool = false
var _grab_world: Vector2 = Vector2.ZERO     # world point pinned under the finger
var _last_screen: Vector2 = Vector2.ZERO    # previous finger screen position
var _drag_speed: Vector2 = Vector2.ZERO     # smoothed finger velocity, world px/s (for fling)
var _target_zoom: float = 1.0
var _view_size: Vector2 = Vector2(1080, 1920)
var _idle_t: float = 0.0
var _enabled := true


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	position_smoothing_enabled = false       # we smooth manually for rubber-band control
	# Leave the hard Camera2D limits wide open; our soft clamp does the real work so
	# the border can rubber-band instead of slamming.
	limit_left = -100000000
	limit_right = 100000000
	limit_top = -100000000
	limit_bottom = 100000000
	_target = position
	_target_zoom = zoom.x
	make_current()


# ===========================================================================
#  configuration
# ===========================================================================

func set_view_size(v: Vector2) -> void:
	_view_size = v


# The clamp box in world space. Grows as the world expands. We re-snap the
# target into the (possibly new) box so a freshly-grown edge is reachable.
func set_world_rect(r: Rect2) -> void:
	world_rect = r
	_target = _clamp_centre(_target, 0.0)


func grow_world_rect(include: Rect2) -> void:
	set_world_rect(world_rect.merge(include))


func set_input_enabled(on: bool) -> void:
	_enabled = on
	if not on:
		_dragging = false
		_vel = Vector2.ZERO


# Frame the camera on a world point (used on boot / realm travel / wake).
func focus(world_pos: Vector2, snap: bool = false) -> void:
	_target = _clamp_centre(world_pos, 0.0)
	_vel = Vector2.ZERO
	if snap:
		position = _target


func set_zoom_level(z: float, snap: bool = false) -> void:
	_target_zoom = clampf(z, min_zoom, max_zoom)
	if snap:
		zoom = Vector2(_target_zoom, _target_zoom)


# The world rectangle currently visible through the lens (handy for culling and
# for WorldStage's "what did the player pan to" puzzle hints).
func visible_world_rect() -> Rect2:
	var vis: Vector2 = _view_size / maxf(0.001, zoom.x)
	return Rect2(position - vis * 0.5, vis)


func is_panning() -> bool:
	return _dragging or _vel.length() > inertia_min


# ===========================================================================
#  gesture API  (WorldStage calls these after its own hit-testing)
# ===========================================================================

# All gestures work in SCREEN space (raw event positions). Screen-space glue is
# exact regardless of our manual easing, so a dragged world point stays welded
# under the finger.

func grab(screen_point: Vector2) -> void:
	if not _enabled:
		return
	_dragging = true
	_vel = Vector2.ZERO
	_drag_speed = Vector2.ZERO
	_grab_world = _screen_to_world(screen_point)
	_last_screen = screen_point


# Re-pin the grabbed world point under the finger's new screen position.
func drag(screen_point: Vector2, delta: float) -> void:
	if not _enabled or not _dragging:
		return
	# Desired centre so that _grab_world maps back under screen_point.
	var want: Vector2 = _grab_world - (screen_point - _view_size * 0.5) / maxf(0.001, zoom.x)
	if delta > 0.0001:
		var inst: Vector2 = (want - _target) / delta
		_drag_speed = _drag_speed.lerp(inst, 0.35)
	_target = want
	_last_screen = screen_point


func release() -> void:
	if not _dragging:
		return
	_dragging = false
	_vel = _drag_speed * fling_scale
	if _vel.length() < inertia_min:
		_vel = Vector2.ZERO


# Pinch about a focal SCREEN point, keeping that point under the fingers.
func pinch(factor: float, focal_screen: Vector2) -> void:
	if not _enabled:
		return
	var focal_world := _screen_to_world(focal_screen)
	_target_zoom = clampf(_target_zoom * factor, min_zoom, max_zoom)
	# Keep the focal world point under the same screen pixel after the zoom.
	_target = focal_world - (focal_screen - _view_size * 0.5) / maxf(0.001, _target_zoom)


func wheel_zoom(step: float, focal_screen: Vector2) -> void:
	pinch(1.0 + step, focal_screen)


# Map a screen pixel to a world point using the target centre + target zoom
# (what the lens is settling toward), so gestures compose without drift.
func _screen_to_world(screen_point: Vector2) -> Vector2:
	return _target + (screen_point - _view_size * 0.5) / maxf(0.001, zoom.x)


# ===========================================================================
#  per-frame integration
# ===========================================================================

func _process(delta: float) -> void:
	# ease zoom toward target
	var z: float = lerpf(zoom.x, _target_zoom, clampf(zoom_ease * delta, 0.0, 1.0))
	zoom = Vector2(z, z)

	# inertial fling when not actively dragging
	if not _dragging and _vel != Vector2.ZERO:
		_target += _vel * delta
		_vel = _vel.lerp(Vector2.ZERO, clampf(inertia_friction * delta, 0.0, 1.0))
		if _vel.length() < inertia_min:
			_vel = Vector2.ZERO

	# soft clamp: allow a little overscroll while dragging / flinging, then ease back
	var hard := _clamp_centre(_target, 0.0)
	if _dragging:
		# rubber-band: only a fraction of the overscroll is honoured
		var over := _target - hard
		var soft_limit := _overscroll_limit()
		over.x = clampf(over.x, -soft_limit.x, soft_limit.x) * rubber_give
		over.y = clampf(over.y, -soft_limit.y, soft_limit.y) * rubber_give
		_target = hard + over
	else:
		# ease the target home across the border
		_target = _target.lerp(hard, clampf(rubber_return * delta, 0.0, 1.0))
		if _target.distance_to(hard) < 0.5:
			_target = hard

	# optional barely-there ambient drift so a parked world still feels alive
	var drift := Vector2.ZERO
	if idle_drift > 0.0 and not _dragging and _vel == Vector2.ZERO:
		_idle_t += delta
		drift = Vector2(sin(_idle_t * 0.21), cos(_idle_t * 0.17)) * idle_drift

	# finally ease the real camera toward the (clamped) target for buttery motion
	var k := 1.0 if _dragging else clampf(pan_ease * delta, 0.0, 1.0)
	position = position.lerp(_target + drift, k)


# ===========================================================================
#  clamp maths
# ===========================================================================

# The half-size of the visible area in world units at the current zoom.
func _half_view() -> Vector2:
	return (_view_size * 0.5) / maxf(0.001, zoom.x)


# How far past the border the rubber-band may stretch (a fraction of the view).
func _overscroll_limit() -> Vector2:
	var hv := _half_view()
	return Vector2(hv.x * 0.6, hv.y * 0.6)


# Clamp a desired camera centre so the visible rect stays within world_rect.
# If the world is smaller than the view on an axis, lock to the world centre.
func _clamp_centre(c: Vector2, _pad: float) -> Vector2:
	var hv := _half_view()
	var out := c
	var min_x := world_rect.position.x + hv.x
	var max_x := world_rect.end.x - hv.x
	if min_x > max_x:
		out.x = world_rect.position.x + world_rect.size.x * 0.5
	else:
		out.x = clampf(c.x, min_x, max_x)
	var min_y := world_rect.position.y + hv.y
	var max_y := world_rect.end.y - hv.y
	if min_y > max_y:
		out.y = world_rect.position.y + world_rect.size.y * 0.5
	else:
		out.y = clampf(c.y, min_y, max_y)
	return out
