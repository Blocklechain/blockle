class_name IdleMote extends ProcNode
# IdleMote — the diegetic unit of the idle SIMULATION's output.
#
# The world does not show numbers. When a living thing (a lit building, a mature
# grove, a foraging creature) produces, it sheds a soft luminous MOTE that drifts
# across the island and is drawn into the Heart Tree's root-pool — and only WHEN
# the mote lands is the resource actually credited. So the economy you read is the
# traffic of light across the world (CONVENTIONS rule 5, IDLE-DESIGN §2.4): a busy
# grove visibly sheds motes faster, a stalled thing goes quiet.
#
# It is a ProcNode so it honours the one contract: seeded + deterministic, alive,
# and GROWTH-staged. Here `growth ∈ [0,1]` is re-cast (as ProcEffects does) as the
# mote's JOURNEY: 0 = just shed at the source, 1 = merged into the pool. `_draw`
# renders a believable frame for any value — a faint spark leaving, a bright comet
# mid-flight, a soft pour as it arrives — eased through g(). The slow world
# grow-rate is disabled; the journey is driven by the mote's own travel clock.
#
# Everything is math (no textures): a layered soft glow, a tiny resource glyph, and
# a short comet-trail sampled analytically along the flight bezier (no per-frame
# allocation of heavy arrays). Motion is a cheap transform + a few draw calls.
#
# ---------------------------------------------------------------------------
# PUBLIC FACTORY API
# ---------------------------------------------------------------------------
#   IdleMote.make(world_seed, key, opts:={}) -> IdleMote
#   IdleMote.spawn(parent, world_seed, key, from, to, opts:={}) -> IdleMote
#       (make + configure + add to `parent`, returns the live node)
#
# opts (all optional):
#   from:Vector2, to:Vector2          flight endpoints in the PARENT's space
#   color:Color|hex                   primary tint (resource colour)
#   colors:Array                      [primary, light, white] override
#   shape:String                      resource glyph: spark|star|gem|block|log|rune|seed|leaf
#   amount:float                      size/trail scale (not shown as a number)
#   travel:float                      seconds of flight (default seeded ~1.1–1.5)
#   arc:float                         lateral bow of the flight path (px, signed by seed)
#   on_arrive:Callable                called once when the mote lands (deliver credit)
#   kind:String                       "resource" | "seed" | "forage" | "ambience" (flavour)
#   z:int                             z_index (default 16)
#   spin_in:bool                      little scale-pop as it is shed (default true)

const _FALLBACK_COL := {
	"essence":  "#7FE3B0", "timber": "#C9955B", "stone": "#9AA3AD",
	"crystal":  "#8FB8FF", "stardust": "#C79BFF", "relics": "#FFC978",
}

# ---------------------------------------------------------------------------
# factories
# ---------------------------------------------------------------------------

static func make(world_seed: int, key: String, opts: Dictionary = {}) -> IdleMote:
	var m := IdleMote.new()
	m.seedv = hash("%d:mote:%s" % [world_seed, key])
	m._configure(opts)
	return m


static func spawn(parent: Node, world_seed: int, key: String, from: Vector2, to: Vector2, opts: Dictionary = {}) -> IdleMote:
	var o := opts.duplicate()
	o["from"] = from
	o["to"] = to
	var m := make(world_seed, key, o)
	if parent != null and is_instance_valid(parent):
		parent.add_child(m)
	return m


# ---------------------------------------------------------------------------
# instance
# ---------------------------------------------------------------------------

var from_p := Vector2.ZERO
var to_p := Vector2.ZERO
var _ctrl := Vector2.ZERO
var travel := 1.25
var arc := 40.0
var amount := 1.0
var kind := "resource"
var glyph := "spark"
var on_arrive: Callable = Callable()
var _spin_in := true

var _cols: Array = []                 # [primary, light, white]
var _elapsed := 0.0
var _arrived := false
var _wob_freq := 2.0
var _wob_amp := 7.0
var _rot_sp := 1.4
var _base_r := 9.0

func _configure(opts: Dictionary) -> void:
	from_p = opts.get("from", from_p)
	to_p = opts.get("to", to_p)
	amount = maxf(0.05, float(opts.get("amount", 1.0)))
	kind = String(opts.get("kind", "resource"))
	glyph = String(opts.get("shape", _shape_for_kind(kind)))
	z_index = int(opts.get("z", 16))
	_spin_in = bool(opts.get("spin_in", true))
	if opts.has("on_arrive") and opts["on_arrive"] is Callable:
		on_arrive = opts["on_arrive"]
	# colours
	if opts.has("colors") and opts["colors"] is Array and not (opts["colors"] as Array).is_empty():
		for v in opts["colors"]:
			_cols.append(_as_color(v, Color(1, 0.95, 0.7)))
	else:
		var c := _as_color(opts.get("color", Color(1.0, 0.9, 0.62)), Color(1.0, 0.9, 0.62))
		_cols = [c, c.lightened(0.34), Color(1, 1, 1, 1)]
	travel = float(opts.get("travel", travel))
	arc = float(opts.get("arc", arc))

func _on_built() -> void:
	grow_rate = 0.0            # journey is driven by our own clock, not slow growth
	animate_draw = true        # the comet shape changes every frame
	growth = 0.0
	# seeded flight personality
	travel = travel * Proc.rangef(seedv, "tv", 0.9, 1.18)
	var side := 1.0 if Proc.hashf(seedv, "sd") < 0.5 else -1.0
	arc = arc * Proc.rangef(seedv, "ar", 0.6, 1.3) * side
	_wob_freq = Proc.rangef(seedv, "wf", 1.3, 2.8)
	_wob_amp = Proc.rangef(seedv, "wa", 4.0, 10.0)
	_rot_sp = Proc.rangef(seedv, "rs", 1.0, 2.2) * side
	_base_r = (7.5 + clampf(log(amount + 1.0) * 2.6, 0.0, 9.0)) * Proc.rangef(seedv, "br", 0.9, 1.15)
	_build_path()
	position = from_p

func _build_path() -> void:
	# a gentle bow toward one side + a slight lift, so motes stream in soft arcs
	var mid := from_p.lerp(to_p, 0.5)
	var dir := (to_p - from_p)
	var dist: float = maxf(1.0, dir.length())
	var perp := Vector2(-dir.y, dir.x) / dist
	_ctrl = mid + perp * arc - Vector2(0, dist * 0.12 + 16.0)

func _animate(delta: float) -> void:
	if _arrived:
		return
	_elapsed += delta
	var u := clampf(_elapsed / maxf(0.05, travel), 0.0, 1.0)
	growth = u
	# eased progress: lingers a touch at the source, accelerates, settles in
	var e := u * u * (3.0 - 2.0 * u)
	var p := _bezier(from_p, _ctrl, to_p, e)
	# fine perpendicular shimmer that fades as it lands
	var dir := (to_p - from_p)
	var dl: float = maxf(1.0, dir.length())
	var perp := Vector2(-dir.y, dir.x) / dl
	p += perp * sin(_elapsed * _wob_freq * TAU + phase) * _wob_amp * (1.0 - e)
	position = p
	if u >= 1.0:
		_arrive()

func _arrive() -> void:
	if _arrived:
		return
	_arrived = true
	if on_arrive.is_valid():
		on_arrive.call(amount)
	queue_free()

# ---------------------------------------------------------------------------
# drawing — staged by g() (the journey), in LOCAL space (origin = mote centre)
# ---------------------------------------------------------------------------

func _draw() -> void:
	var u := clampf(growth, 0.0, 1.0)
	var gv := g()
	# visible the whole flight; soft fade-in as it is shed, soft pour-in as it lands
	var a := clampf(u / 0.1, 0.0, 1.0) * clampf((1.0 - u) / 0.12, 0.0, 1.0)
	if a <= 0.004:
		return
	var pop := 1.0
	if _spin_in:
		pop += 0.5 * pow(1.0 - clampf(u / 0.16, 0.0, 1.0), 2.0)
	var twk := 0.72 + 0.28 * sin(t * 7.0 + phase)
	var r := _base_r * pop * twk
	var prim: Color = _cols[0]
	var lite: Color = _cols[min(1, _cols.size() - 1)]
	var white: Color = _cols[_cols.size() - 1]

	# 1) comet trail — a few samples behind the current eased position
	var e := u * u * (3.0 - 2.0 * u)
	var here := _bezier(from_p, _ctrl, to_p, e)
	var tn := 5
	for i in range(1, tn + 1):
		var back := e - float(i) * 0.05
		if back <= 0.0:
			break
		var tp := _bezier(from_p, _ctrl, to_p, back) - here   # local to this node
		var ta := a * (1.0 - float(i) / float(tn + 1)) * 0.5
		var tr := r * (1.0 - float(i) / float(tn + 1)) * 0.8
		draw_circle(tp, tr, Color(prim.r, prim.g, prim.b, ta * 0.5))
		draw_circle(tp, tr * 0.45, Color(lite.r, lite.g, lite.b, ta))

	# 2) soft layered glow
	for i in range(4):
		var f := float(i) / 3.0
		var rr: float = lerp(r * 1.9, r * 0.4, f)
		var aa: float = lerp(a * 0.14, a * 0.6, f)
		draw_circle(Vector2.ZERO, rr, Color(prim.r, prim.g, prim.b, aa))

	# 3) the resource glyph core
	_draw_glyph(here, r, prim, lite, white, a, t * _rot_sp + phase, gv)

# A little procedural resource glyph. `pos` passed only for stable rotation feel;
# everything is drawn at the node origin.
func _draw_glyph(_pos: Vector2, r: float, prim: Color, lite: Color, white: Color, a: float, rot: float, _gv: float) -> void:
	match glyph:
		"gem":
			var d := PackedVector2Array([
				Vector2(0, -r), Vector2(r * 0.7, -r * 0.15), Vector2(0, r * 0.9), Vector2(-r * 0.7, -r * 0.15)])
			draw_colored_polygon(d, Color(prim.r, prim.g, prim.b, a))
			draw_line(Vector2(-r * 0.7, -r * 0.15), Vector2(r * 0.7, -r * 0.15), Color(1, 1, 1, a * 0.6), 1.2, true)
			draw_circle(Vector2(-r * 0.2, -r * 0.3), r * 0.18, Color(1, 1, 1, a))
		"block":
			var sq := Proc.superellipse(r * 0.8, r * 0.8, 3.4, 18)
			var sp := PackedVector2Array()
			for q in sq:
				sp.append(q.rotated(rot * 0.2))
			draw_colored_polygon(sp, Color(prim.r, prim.g, prim.b, a))
			draw_circle(Vector2(-r * 0.24, -r * 0.3), r * 0.2, Color(1, 1, 1, a * 0.8))
		"log":
			var cap := Proc.superellipse(r, r * 0.46, 4.5, 20)
			var lp := PackedVector2Array()
			for q in cap:
				lp.append(q.rotated(rot * 0.25 - 0.4))
			draw_colored_polygon(lp, Color(prim.r, prim.g, prim.b, a))
			draw_circle(Vector2.ZERO, r * 0.2, Color(prim.r, prim.g, prim.b, a).darkened(0.3))
		"star":
			_draw_glint(r * 1.1, prim, a, rot, 5)
		"rune":
			draw_circle(Vector2.ZERO, r * 0.78, Color(prim.r, prim.g, prim.b, a * 0.4))
			_draw_ring(r * 0.78, Color(lite.r, lite.g, lite.b, a), 2.0, 22)
			for i in range(3):
				var ang := rot + TAU * float(i) / 3.0
				draw_line(Vector2.ZERO, Vector2(cos(ang), sin(ang)) * r * 0.78, Color(1, 1, 1, a * 0.8), 1.3, true)
			draw_circle(Vector2.ZERO, r * 0.16, Color(1, 1, 1, a))
		"seed":
			# a little teardrop seed with a pale sheen — what mature trees shed
			var seed := PackedVector2Array([
				Vector2(0, -r * 1.15), Vector2(r * 0.62, 0), Vector2(0, r * 0.95), Vector2(-r * 0.62, 0)])
			var spts := PackedVector2Array()
			for q in seed:
				spts.append(q.rotated(sin(rot * 0.5) * 0.4))
			draw_colored_polygon(spts, Color(prim.r, prim.g, prim.b, a))
			draw_circle(Vector2(-r * 0.2, -r * 0.4), r * 0.2, Color(1, 1, 1, a * 0.7))
		"leaf":
			var leaf := PackedVector2Array([
				Vector2(0, -r * 1.1), Vector2(r * 0.55, 0), Vector2(0, r * 1.0), Vector2(-r * 0.55, 0)])
			var lf := PackedVector2Array()
			for q in leaf:
				lf.append(q.rotated(rot * 0.4))
			draw_colored_polygon(lf, Color(prim.r, prim.g, prim.b, a))
			draw_line(Vector2(0, -r), Vector2(0, r * 0.9), Color(white.r, white.g, white.b, a * 0.5), 1.0, true)
		_:  # "spark" + default
			_draw_glint(r * 1.1, prim, a, rot, 4)
	# a bright white core on every mote
	draw_circle(Vector2.ZERO, r * 0.24, Color(white.r, white.g, white.b, min(1.0, a * 1.1)))

func _draw_glint(r: float, color: Color, a: float, rot: float, spikes: int) -> void:
	draw_circle(Vector2.ZERO, r * 0.9, Color(color.r, color.g, color.b, a * 0.22))
	var pts := PackedVector2Array()
	var n := spikes * 2
	for i in range(n):
		var ang := rot + TAU * float(i) / float(n)
		var rad: float = r if (i % 2 == 0) else r * 0.34
		pts.append(Vector2(cos(ang), sin(ang)) * rad)
	draw_colored_polygon(pts, Color(color.r, color.g, color.b, a))

func _draw_ring(rad: float, color: Color, width: float, steps: int) -> void:
	var pts := PackedVector2Array()
	for i in range(steps + 1):
		var ang := TAU * float(i) / float(steps)
		pts.append(Vector2(cos(ang), sin(ang)) * rad)
	draw_polyline(pts, color, maxf(1.0, width), true)

# ---------------------------------------------------------------------------
# static helpers
# ---------------------------------------------------------------------------

static func _bezier(a: Vector2, c: Vector2, b: Vector2, t: float) -> Vector2:
	var u := 1.0 - t
	return a * (u * u) + c * (2.0 * u * t) + b * (t * t)

static func _shape_for_kind(k: String) -> String:
	match k:
		"seed": return "seed"
		"forage": return "leaf"
		"ambience": return "spark"
		_: return "spark"

static func _as_color(v, fallback: Color) -> Color:
	if v is Color:
		return v
	if v is String:
		var s := String(v)
		if s.length() >= 4:
			return Color(s)
	return fallback

# Resolve a resource's colour (GameData wins, then fallback table).
static func resource_color(resource_id: String) -> Color:
	if typeof(GameData) == TYPE_OBJECT and GameData.resources_by_id is Dictionary and GameData.resources_by_id.has(resource_id):
		var r = GameData.resources_by_id[resource_id]
		if typeof(r) == TYPE_DICTIONARY and r.has("color"):
			return _as_color(r["color"], Color(1, 0.9, 0.62))
	if _FALLBACK_COL.has(resource_id):
		return Color(_FALLBACK_COL[resource_id])
	return Color(1.0, 0.9, 0.62)

static func resource_shape(resource_id: String) -> String:
	if typeof(GameData) == TYPE_OBJECT and GameData.resources_by_id is Dictionary and GameData.resources_by_id.has(resource_id):
		var r = GameData.resources_by_id[resource_id]
		if typeof(r) == TYPE_DICTIONARY and r.has("shape"):
			return String(r["shape"])
	return "spark"
