class_name MintFrost extends Node2D
# MintFrost — the "pressed flower in a book" cue for a MINTED (growth-frozen) thing.
#
# When GrowthState freezes an entity (because it was minted as an NFT, §5 of
# IDLE-DESIGN), it parents one of these over the living art. It draws a faint
# crystalline glass case hugging the thing's silhouette — a cool vertical sheen,
# one diagonal shine streak, a rim of frost, and a few tiny, barely-moving
# sparkles — so a minted object reads as *held, timeless, precious*, visibly
# distinct from the things breathing around it, WITHOUT hiding the art beneath.
#
# It honours the engine rules: generated from math (no images), smooth outlines
# (Proc.superellipse / smooth_loop), portrait + feet-at-origin (the case rises
# from y=0 up to -height), and ALIVE but DAMPED — a mint is paused life, so the
# only motion is an almost-imperceptible shimmer driven by a cheap transform/
# alpha animation. No per-frame redraw: the glass shape is static, only the
# shine's opacity and a hair of parallax drift each frame.
#
# Public:
#   MintFrost.new();  frost.setup(radius, height, tint);  node.add_child(frost)
#   frost.set_strength(0..1)   — fade the whole case in/out (used on freeze/thaw)

var radius: float = 40.0          # half-width of the case (from footprint_radius)
var height: float = 110.0         # the case rises from y=0 to y=-height
var tint: Color = Color(0.74, 0.87, 1.0)
var _strength: float = 1.0        # overall opacity multiplier (fade in/out)

var _t: float = 0.0
var _phase: float = 0.0
var _case: PackedVector2Array      # cached glass silhouette
var _shine: PackedVector2Array     # cached shine streak
var _frost: PackedVector2Array     # cached frost rim (upper crescent)
var _sparks: Array = []            # [{pos, r, p}] cached sparkle seeds
var _shine_node: Node2D            # the one moving child (shine), animated by transform

func setup(r: float, h: float, t: Color = Color(0.74, 0.87, 1.0)) -> void:
	radius = maxf(8.0, r)
	height = maxf(radius * 1.6, h)
	tint = t
	_rebuild()
	queue_redraw()

func set_strength(s: float) -> void:
	_strength = clampf(s, 0.0, 1.0)
	modulate.a = _strength
	queue_redraw()

func _ready() -> void:
	z_index = 20                     # float above the frozen art
	_phase = Proc.hashf(int(get_instance_id()), "frostphase") * TAU
	if _case.is_empty():
		_rebuild()
	# the shine lives on its own node so we can slide it with pure transform anim
	_shine_node = Node2D.new()
	add_child(_shine_node)
	_shine_node.position = Vector2.ZERO

func _rebuild() -> void:
	var cx := 0.0
	var cy := -height * 0.5
	# a rounded glass capsule hugging the silhouette (squircle, feet-anchored)
	_case = Proc.superellipse(radius * 1.12, height * 0.56, 2.7, 40)
	for i in _case.size():
		_case[i] += Vector2(cx, cy)
	# an upper frost crescent (where rime would settle on a pressed thing)
	_frost = Proc.smooth_loop(PackedVector2Array([
		Vector2(cx - radius * 0.95, cy - height * 0.18),
		Vector2(cx - radius * 0.4, cy - height * 0.42),
		Vector2(cx + radius * 0.2, cy - height * 0.48),
		Vector2(cx + radius * 0.9, cy - height * 0.3),
		Vector2(cx + radius * 0.5, cy - height * 0.22),
		Vector2(cx, cy - height * 0.3),
		Vector2(cx - radius * 0.5, cy - height * 0.22)]), 7)
	# a single diagonal shine streak across the glass
	var w := radius * 0.42
	_shine = PackedVector2Array([
		Vector2(cx - radius * 0.7, cy + height * 0.42),
		Vector2(cx - radius * 0.7 + w, cy + height * 0.42),
		Vector2(cx + radius * 0.5 + w, cy - height * 0.42),
		Vector2(cx + radius * 0.5, cy - height * 0.42)])
	# a handful of still frost-sparkles frozen into the glass
	_sparks.clear()
	var n := 5
	for i in n:
		_sparks.append({
			"pos": Vector2(
				Proc.rangef(int(get_instance_id()), "sx%d" % i, -radius * 0.7, radius * 0.7),
				cy + Proc.rangef(int(get_instance_id()), "sy%d" % i, -height * 0.42, height * 0.42)),
			"r": Proc.rangef(int(get_instance_id()), "sr%d" % i, radius * 0.05, radius * 0.11),
			"p": Proc.hashf(int(get_instance_id()), "sp%d" % i) * TAU,
		})

func _process(delta: float) -> void:
	_t += delta
	# DAMPED life: a slow, shallow shimmer. Shine slides on its own node (transform
	# only); the case itself never redraws. A faint breathing alpha sells "glass".
	if _shine_node:
		var slide := sin(_t * 0.22 + _phase) * radius * 0.16
		_shine_node.position = Vector2(slide, -slide * 0.5)
		var pulse := 0.5 + 0.5 * sin(_t * 0.3 + _phase)
		_shine_node.modulate.a = (0.35 + 0.45 * pulse) * _strength
	# the sparkles twinkle extremely slowly — redraw only every ~0.5s to stay cheap
	if int(_t * 2.0) != int((_t - delta) * 2.0):
		queue_redraw()

func _draw() -> void:
	if _case.is_empty():
		return
	var ice_hi := tint.lightened(0.28)
	var ice_lo := tint.darkened(0.12)
	# 1) the glass body — translucent cool vertical gradient, art shows through
	var body_cols := Proc.grad_fill(_case, Color(ice_hi.r, ice_hi.g, ice_hi.b, 0.17 * _strength),
		Color(ice_lo.r, ice_lo.g, ice_lo.b, 0.09 * _strength))
	draw_polygon(_case, body_cols)
	# 2) a crisp frost rim around the case edge
	var rim := _case.duplicate()
	rim.append(_case[0])
	draw_polyline(rim, Color(ice_hi.r, ice_hi.g, ice_hi.b, 0.33 * _strength), maxf(1.0, radius * 0.03), true)
	# 3) the settled frost crescent up top
	draw_polygon(_frost, _flat(_frost.size(), Color(0.96, 0.98, 1.0, 0.16 * _strength)))
	# 4) the diagonal shine streak (drawn on the moving child so it slides)
	if _shine_node:
		# clear previous frame's shine by redrawing child via its own draw? Simpler:
		# draw shine here in parent space offset by the child's transform.
		var off := _shine_node.position
		var sh := _shine.duplicate()
		for i in sh.size():
			sh[i] += off
		var sa := _shine_node.modulate.a
		draw_polygon(sh, _flat(sh.size(), Color(1, 1, 1, 0.22 * sa)))
	# 5) still frozen sparkles — tiny four-point glints
	for s in _sparks:
		var tw: float = 0.6 + 0.4 * sin(_t * 0.6 + float(s.p))
		var a := 0.5 * tw * _strength
		_draw_glint(s.pos, float(s.r) * (0.8 + 0.3 * tw), Color(1, 1, 1, a))

func _draw_glint(c: Vector2, r: float, col: Color) -> void:
	var star := PackedVector2Array([
		c + Vector2(0, -r), c + Vector2(r * 0.22, -r * 0.22),
		c + Vector2(r, 0), c + Vector2(r * 0.22, r * 0.22),
		c + Vector2(0, r), c + Vector2(-r * 0.22, r * 0.22),
		c + Vector2(-r, 0), c + Vector2(-r * 0.22, -r * 0.22)])
	draw_polygon(star, _flat(star.size(), col))

func _flat(n: int, c: Color) -> PackedColorArray:
	var a := PackedColorArray()
	a.resize(n)
	for i in n:
		a[i] = c
	return a
