class_name PuzzleSystem
extends Node2D
# PuzzleSystem — the in-screen, diegetic PUZZLE layer for Blockle Idle.
#
# Puzzles are the game's one *active* verb between stretches of idle (IDLE-DESIGN §3):
# calm, beautiful, procedurally generated, SEEDED, and UNLOSABLE (no clock, no moves
# limit, no fail state). They are drawn as living parts of the world with the Proc
# toolkit — never a minigame popup — and every one rewards GROWTH or EXPANSION.
#
# Three polished types ship here, each a `ProcNode` region seeded from
# (world_seed, region_key) so the same world always poses the same puzzles and new
# worlds diverge completely:
#
#   LIGHTWEAVE  (§3.1, growth)    — a shaded dell the Heart Tree's light can't reach.
#                                   Tap crystal MIRRORS to bend a warm beam until it
#                                   touches every bloom-stone. Solving wakes the dell
#                                   to green (plants there can finally reach growth=1).
#
#   ROOTWORK    (§3.2, expansion) — dormant seed-nodes adrift in mist past the island
#                                   edge. DRAW a single living root with your finger
#                                   from the Heart-root out through every node without
#                                   the root crossing itself. Solving unfurls a fresh
#                                   patch of island (the engine of world expansion).
#
#   BLOOMTIDE   (§3.3, growth)    — a terraced slope with a spring on top and dry
#                                   flower-beds below. Tap channel-stones to rotate
#                                   them into a continuous downhill watercourse that
#                                   reaches every bed. Solving blooms the terrace into
#                                   a permanent Essence Garden.
#
# This is a SYSTEMS module, but it honours the seven hard rules (CONVENTIONS.md):
# recognizable storybook shapes drawn with Proc.smooth_loop / grad_fill / arcs; seeded
# + limitless; growth + bloom rendered continuously; everything subtly alive via cheap
# child-transform / modulate animation; redraw only when the shape changes; portrait,
# regions anchored on the ground contour. It is self-contained (depends only on the
# `Proc` autoload and the `ProcNode` base) so it composes without touching any module.
#
# ---------------------------------------------------------------------------------
# INTEGRATION (see the note returned with this file):
#   var puzzles := PuzzleSystem.new()
#   _world.add_child(puzzles)                       # sibling of placed things, in _world space
#   puzzles.setup(world_seed, { "realm_id": Game.current_realm(),
#                               "ground_sampler": Callable(self, "_ground_y_at"),
#                               "palette": Proc.palette(world_seed) })
#   puzzles.generate_default()                      # seeds one of each near the start
#   puzzles.puzzle_solved.connect(_on_puzzle_solved)
#   puzzles.land_expanded.connect(_on_land_expanded)   # grow camera clamp + unfurl ground
#   puzzles.ground_awoke.connect(_on_ground_awoke)
#   puzzles.whisper.connect(_on_whisper)               # §2.6 diegetic one-liner
#   # In Main's gesture handler, offer each gesture to the puzzles FIRST:
#   #   down: if puzzles.handle_touch_down(wp): return      (else pan / pick-up)
#   #   move: if puzzles.handle_touch_move(wp): return
#   #   up:   if puzzles.handle_touch_up(wp):   return
#   #   tap:  if puzzles.handle_tap(wp):        return
#   # Coordinates are in _world space (the same space placed ProcNodes live in).

# =====================================================================
# SIGNALS — how the world reacts to a solve (Main wires these)
# =====================================================================
signal puzzle_started(puzzle_id: String)
signal puzzle_progress(puzzle_id: String, progress: float)   # 0..1, for ambient feedback
signal puzzle_solved(puzzle_id: String, reward: Dictionary)
signal land_expanded(world_pos: Vector2, radius: float)      # Rootwork → unfurl new ground + grow clamp
signal ground_awoke(world_rect: Rect2)                       # Lightweave → dell becomes plantable
signal whisper(text: String, world_pos: Vector2)             # §2.6 one-line diegetic hint

# =====================================================================
# PUBLIC TYPE VOCABULARY
# =====================================================================
const TYPE_LIGHTWEAVE := "lightweave"
const TYPE_ROOTWORK := "rootwork"
const TYPE_BLOOMTIDE := "bloomtide"
const TYPES := [TYPE_LIGHTWEAVE, TYPE_ROOTWORK, TYPE_BLOOMTIDE]

# =====================================================================
# CONFIG (set by setup())
# =====================================================================
var world_seed: int = 0
var realm_id: String = "verdant"
var ground_y: float = 0.0            # baseline feet line in world space (fallback)
var ground_sampler: Callable         # optional: func(x: float) -> float  (ground y at x)
var pal: Dictionary = {}             # a Proc.palette() dict (local mood)
var expansion_level: int = 0         # how far the world has grown (gently scales difficulty)

# =====================================================================
# RUNTIME
# =====================================================================
var _puzzles: Array = []             # Array[_Puzzle]
var _by_id: Dictionary = {}
var _active: _Puzzle = null          # puzzle receiving the current gesture
var _mode: String = ""               # "root" | "tap"
var _down_wp: Vector2 = Vector2.ZERO
var _moved: bool = false
var _seen: Dictionary = {}           # puzzle_id -> true once the player has panned to it

# ---------------------------------------------------------------------
# SETUP / CONFIG
# ---------------------------------------------------------------------
func setup(seed_value: int, opts: Dictionary = {}) -> void:
	world_seed = seed_value
	realm_id = String(opts.get("realm_id", realm_id))
	ground_y = float(opts.get("ground_y", ground_y))
	expansion_level = int(opts.get("expansion_level", expansion_level))
	if opts.has("ground_sampler") and opts["ground_sampler"] is Callable:
		ground_sampler = opts["ground_sampler"]
	if opts.has("palette") and opts["palette"] is Dictionary:
		pal = opts["palette"]
	if pal.is_empty():
		pal = Proc.palette(world_seed, realm_id)

# Spawn the starter set: one of each type scattered at seeded spots on/near the island.
# Positions are relative to the start-view origin; Main can translate the node after.
func generate_default() -> void:
	var s := world_seed
	# A shaded dell to the LEFT of the Heart Tree.
	var lx := Proc.rangef(s, "pz:lw:x", -560.0, -300.0)
	add_lightweave("lw0", Vector2(lx, _ground(lx)), _diff(2, 4))
	# Dormant nodes off the RIGHT edge, floating in mist.
	var rx := Proc.rangef(s, "pz:rw:x", 360.0, 620.0)
	add_rootwork("rw0", Vector2(rx, _ground(rx) - 70.0), _diff(4, 7))
	# A terraced slope BELOW-LEFT.
	var bx := Proc.rangef(s, "pz:bt:x", -340.0, -120.0)
	add_bloomtide("bt0", Vector2(bx, _ground(bx)), _diff(3, 5))

# Gentle difficulty: lo..hi element count, nudged up by how far the world has expanded,
# never meaner (CONVENTIONS / §3.4).
func _diff(lo: int, hi: int) -> int:
	var bump := int(min(2, expansion_level))
	return clampi(lo + bump, lo, hi)

# ---------------------------------------------------------------------
# FACTORIES
# ---------------------------------------------------------------------
func add_lightweave(key: String, pos: Vector2, pieces: int = 3) -> ProcNode:
	var p := _Lightweave.new()
	_mount(p, key, pos)
	p.generate(pieces)
	return p

func add_rootwork(key: String, pos: Vector2, nodes: int = 5) -> ProcNode:
	var p := _Rootwork.new()
	_mount(p, key, pos)
	p.generate(nodes)
	return p

func add_bloomtide(key: String, pos: Vector2, beds: int = 3) -> ProcNode:
	var p := _Bloomtide.new()
	_mount(p, key, pos)
	p.generate(beds)
	return p

func _mount(p: _Puzzle, key: String, pos: Vector2) -> void:
	p.seedv = hash("%d:pz:%s" % [world_seed, key])
	p.puzzle_id = key
	p.world_seed = world_seed
	p.pal = pal
	p.mgr = self
	p.grow_rate = 0.0        # puzzle regions do not auto-grow; they bloom on solve
	p.position = pos
	add_child(p)
	_puzzles.append(p)
	_by_id[key] = p

func clear() -> void:
	for p in _puzzles:
		if is_instance_valid(p):
			p.queue_free()
	_puzzles.clear()
	_by_id.clear()
	_active = null

# ---------------------------------------------------------------------
# QUERIES
# ---------------------------------------------------------------------
func get_puzzle(id: String) -> ProcNode:
	return _by_id.get(id, null)

func all_puzzles() -> Array:
	return _puzzles.duplicate()

func solved_count() -> int:
	var n := 0
	for p in _puzzles:
		if p.solved:
			n += 1
	return n

func total_count() -> int:
	return _puzzles.size()

# ---------------------------------------------------------------------
# INPUT  (all coordinates in _world space)
# Main offers each gesture here FIRST; a true return means "the puzzle took it"
# (suppress pan / pick-up). false means "not mine" (let the world handle it).
# ---------------------------------------------------------------------
func handle_touch_down(wp: Vector2) -> bool:
	_active = null
	_mode = ""
	_down_wp = wp
	_moved = false
	var p := _pick(wp)
	if p == null:
		return false
	var lp := _local(p, wp)
	# Rootwork: a drag that begins on the root anchor / free end starts weaving.
	if p is _Rootwork and (p as _Rootwork).begin_stroke(lp):
		_active = p
		_mode = "root"
		_emit_started(p)
		return true
	# Tap-rotate puzzles: remember the piece now, commit the rotation on release.
	if p.pending_from_point(lp):
		_active = p
		_mode = "tap"
		return true
	return false

func handle_touch_move(wp: Vector2) -> bool:
	if _active == null:
		return false
	if wp.distance_to(_down_wp) > 8.0:
		_moved = true
	if _mode == "root":
		(_active as _Rootwork).extend_stroke(_local(_active, wp))
		return true
	# a tap that turns into a drag is released without rotating (feels non-committal)
	return true

func handle_touch_up(wp: Vector2) -> bool:
	if _active == null:
		return false
	var consumed := true
	if _mode == "root":
		(_active as _Rootwork).end_stroke()
	elif _mode == "tap":
		if not _moved:
			_active.commit_pending()
			_emit_started(_active)
		else:
			_active.clear_pending()
	_active = null
	_mode = ""
	return consumed

# Convenience for hosts that classify a short touch as a discrete "tap".
func handle_tap(wp: Vector2) -> bool:
	var p := _pick(wp)
	if p == null:
		return false
	var lp := _local(p, wp)
	if p is _Rootwork:
		# a tap on the root anchor clears the current stroke (start over, patiently)
		if (p as _Rootwork).tap_anchor(lp):
			return true
		return false
	if p.pending_from_point(lp):
		p.commit_pending()
		_emit_started(p)
		return true
	return false

# Call when the camera settles so a never-seen puzzle can whisper once (§2.6).
func notify_view_center(wp: Vector2) -> void:
	for p in _puzzles:
		if p.solved or _seen.has(p.puzzle_id):
			continue
		if wp.distance_to(p.position) < 520.0:
			_seen[p.puzzle_id] = true
			whisper.emit(p.intro_whisper(), p.position + Vector2(0.0, -p.region_radius() - 40.0))
			break

# ---------------------------------------------------------------------
# internal glue called by the puzzle instances
# ---------------------------------------------------------------------
func _emit_started(p: _Puzzle) -> void:
	if not p._announced:
		p._announced = true
		puzzle_started.emit(p.puzzle_id)

func _report_progress(p: _Puzzle, prog: float) -> void:
	puzzle_progress.emit(p.puzzle_id, prog)

func _report_solved(p: _Puzzle) -> void:
	var reward := p.reward()
	puzzle_solved.emit(p.puzzle_id, reward)
	match p.kind():
		TYPE_ROOTWORK:
			land_expanded.emit(p.position + Vector2(reward.get("expand_dx", 160.0), reward.get("expand_dy", -20.0)), float(reward.get("expand_radius", 220.0)))
		TYPE_LIGHTWEAVE:
			ground_awoke.emit(Rect2(p.position - Vector2(p.region_radius(), p.region_radius() * 1.4), Vector2(p.region_radius() * 2.0, p.region_radius() * 1.6)))
		TYPE_BLOOMTIDE:
			ground_awoke.emit(Rect2(p.position - Vector2(p.region_radius(), p.region_radius() * 1.8), Vector2(p.region_radius() * 2.0, p.region_radius() * 2.0)))

func _pick(wp: Vector2) -> _Puzzle:
	# Nearest puzzle whose interactive region contains the point (unsolved ones first).
	var best: _Puzzle = null
	var best_d := INF
	for p in _puzzles:
		if p.solved:
			continue
		var d := wp.distance_to(p.position)
		if d < p.region_radius() * 1.15 and d < best_d:
			best = p
			best_d = d
	return best

func _local(p: _Puzzle, wp: Vector2) -> Vector2:
	return wp - p.position

func _ground(x: float) -> float:
	if ground_sampler.is_valid():
		return float(ground_sampler.call(x))
	return ground_y

# ---------------------------------------------------------------------
# SERIALIZE / RESTORE (so solved state + player progress survive a reload)
# ---------------------------------------------------------------------
func serialize() -> Dictionary:
	var out := {}
	for p in _puzzles:
		out[p.puzzle_id] = p.serialize()
	return out

func restore(data: Dictionary) -> void:
	for p in _puzzles:
		if data.has(p.puzzle_id):
			p.restore(data[p.puzzle_id])

# =====================================================================
# GEOMETRY HELPERS (static, pure — shared by every puzzle)
# =====================================================================
static func ang(v: Vector2) -> float:
	return atan2(v.y, v.x)

static func dir(a: float) -> Vector2:
	return Vector2(cos(a), sin(a))

# Reflect a unit ray direction across a mirror LINE at angle `line_angle`.
static func reflect_line(d: Vector2, line_angle: float) -> Vector2:
	return dir(2.0 * line_angle - ang(d))

# Ray (ro + t*rd, rd unit) vs segment a->b. Returns distance t>eps or -1.0.
static func ray_segment(ro: Vector2, rd: Vector2, a: Vector2, b: Vector2) -> float:
	var v1 := ro - a
	var v2 := b - a
	var v3 := Vector2(-rd.y, rd.x)
	var denom := v2.dot(v3)
	if absf(denom) < 1e-6:
		return -1.0
	var t := (v2.x * v1.y - v2.y * v1.x) / denom
	var u := v1.dot(v3) / denom
	if t >= 0.01 and u >= 0.0 and u <= 1.0:
		return t
	return -1.0

# Ray vs circle. Returns nearest positive distance or -1.0.
static func ray_circle(ro: Vector2, rd: Vector2, c: Vector2, r: float) -> float:
	var oc := ro - c
	var b := oc.dot(rd)
	var cc := oc.dot(oc) - r * r
	var disc := b * b - cc
	if disc < 0.0:
		return -1.0
	var sq := sqrt(disc)
	var t := -b - sq
	if t > 0.01:
		return t
	t = -b + sq
	if t > 0.01:
		return t
	return -1.0

static func point_seg_dist(p: Vector2, a: Vector2, b: Vector2) -> float:
	var ab := b - a
	var denom: float = max(ab.dot(ab), 1e-6)
	var t: float = clampf((p - a).dot(ab) / denom, 0.0, 1.0)
	return p.distance_to(a + ab * t)

static func _cross(a: Vector2, b: Vector2) -> float:
	return a.x * b.y - a.y * b.x

# Proper segment-segment crossing (shared endpoints do NOT count as a crossing).
static func segs_cross(p1: Vector2, p2: Vector2, p3: Vector2, p4: Vector2) -> bool:
	var d1 := _cross(p4 - p3, p1 - p3)
	var d2 := _cross(p4 - p3, p2 - p3)
	var d3 := _cross(p2 - p1, p3 - p1)
	var d4 := _cross(p2 - p1, p4 - p1)
	if ((d1 > 0.0 and d2 < 0.0) or (d1 < 0.0 and d2 > 0.0)) and ((d3 > 0.0 and d4 < 0.0) or (d3 < 0.0 and d4 > 0.0)):
		return true
	return false

static func drift(c: Color, p: Dictionary, amt: float) -> Color:
	# blend a colour toward the local realm palette (§2.3a) while staying recognizable
	if p.has("base") and p["base"] is Color:
		return c.lerp(p["base"], clampf(amt, 0.0, 1.0))
	return c

# A soft multi-pass glowing polyline (cheap: a handful of translucent strokes).
static func glow_line(ci: CanvasItem, pts: PackedVector2Array, col: Color, core_w: float, glow_w: float, a_core: float = 0.95) -> void:
	if pts.size() < 2:
		return
	var halo := Color(col.r, col.g, col.b, 0.10)
	ci.draw_polyline(pts, halo, glow_w, true)
	ci.draw_polyline(pts, Color(col.r, col.g, col.b, 0.22), glow_w * 0.55, true)
	ci.draw_polyline(pts, Color(col.r, col.g, col.b, 0.55), core_w * 1.8, true)
	var bright := Color(min(1.0, col.r + 0.35), min(1.0, col.g + 0.35), min(1.0, col.b + 0.35), a_core)
	ci.draw_polyline(pts, bright, core_w, true)

# =====================================================================
# CHEAP REUSABLE CHILD CANVAS-ITEMS (add-blend, animated by transform only)
# =====================================================================
class _Glow extends Node2D:
	var col: Color = Color(1, 1, 1, 1)
	var rad: float = 60.0
	func _ready() -> void:
		var m := CanvasItemMaterial.new()
		m.blend_mode = CanvasItemMaterial.BLEND_MODE_ADD
		material = m
		z_index = -2
	func _draw() -> void:
		var n := 10
		for i in range(n):
			var ti := float(i) / float(n - 1)
			var r: float = lerpf(rad, rad * 0.1, ti)
			var a: float = lerpf(0.02, 0.14, ti)
			draw_circle(Vector2.ZERO, r, Color(col.r, col.g, col.b, a))

class _Mote extends Node2D:
	var col: Color = Color(1, 1, 1, 1)
	var r: float = 2.4
	func _ready() -> void:
		var m := CanvasItemMaterial.new()
		m.blend_mode = CanvasItemMaterial.BLEND_MODE_ADD
		material = m
	func _draw() -> void:
		draw_circle(Vector2.ZERO, r * 2.6, Color(col.r, col.g, col.b, 0.12))
		draw_circle(Vector2.ZERO, r * 1.5, Color(col.r, col.g, col.b, 0.3))
		draw_circle(Vector2.ZERO, r, Color(col.r, col.g, col.b, 0.75))

# =====================================================================
# BASE PUZZLE — shared contract for the three types
# =====================================================================
class _Puzzle extends ProcNode:
	var puzzle_id: String = ""
	var world_seed: int = 0
	var pal: Dictionary = {}
	var mgr                           # PuzzleSystem (back-reference)
	var solved: bool = false
	var bloom: float = 0.0            # 0..1 solve-celebration + "awake" level
	var _announced: bool = false
	var _bloom_tw: Tween
	var _idle_glow: _Glow

	# --- contract subclasses fill in ---
	func kind() -> String: return ""
	func region_radius() -> float: return 160.0
	func intro_whisper() -> String: return "The ground here is sleeping. Help it wake."
	func reward() -> Dictionary: return {}
	func generate(_n: int) -> void: pass

	# --- tap-rotate contract (Lightweave / Bloomtide) ---
	func pending_from_point(_local_pos: Vector2) -> bool: return false
	func commit_pending() -> void: pass
	func clear_pending() -> void: pass

	# --- helpers available to subclasses ---
	func _f(key: String) -> float:
		return Proc.hashf(seedv, key)
	func _rf(key: String, lo: float, hi: float) -> float:
		return Proc.rangef(seedv, key, lo, hi)
	func _pick_i(key: String, n: int) -> int:
		return int(Proc.hashf(seedv, key) * float(n)) % max(1, n)

	func _mark_progress(prog: float) -> void:
		if mgr != null:
			mgr._report_progress(self, clampf(prog, 0.0, 1.0))

	func _solve() -> void:
		if solved:
			return
		solved = true
		_play_bloom()
		if mgr != null:
			mgr._report_solved(self)

	func _play_bloom() -> void:
		if _bloom_tw and _bloom_tw.is_valid():
			_bloom_tw.kill()
		_bloom_tw = create_tween().set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_OUT)
		_bloom_tw.tween_method(_set_bloom, bloom, 1.0, 2.4)

	func _set_bloom(v: float) -> void:
		bloom = v
		queue_redraw()
		if _idle_glow:
			_idle_glow.modulate.a = 0.6 + 0.4 * v

	# soft contact shadow under a region, for grounding
	func _shadow(cx: float, w: float, h: float, a: float = 0.16) -> void:
		var pts := PackedVector2Array()
		var steps := 26
		for i in range(steps):
			var th := TAU * float(i) / float(steps)
			pts.append(Vector2(cx + cos(th) * w, sin(th) * h))
		draw_colored_polygon(pts, Color(0, 0, 0, a))

	func serialize() -> Dictionary:
		return {"solved": solved, "bloom": bloom}
	func restore(d: Dictionary) -> void:
		solved = bool(d.get("solved", false))
		bloom = float(d.get("bloom", 1.0 if solved else 0.0))
		queue_redraw()

# =====================================================================
# 1) LIGHTWEAVE — bend the beam to every bloom-stone
# =====================================================================
class _Lightweave extends _Puzzle:
	const STEP := TAU / 24.0          # tap-rotation increment; 24 steps wrap to the solution
	var dell_r: float = 230.0
	var dell_c: Vector2 = Vector2.ZERO
	var emitter: Vector2 = Vector2.ZERO
	var emit_dir: Vector2 = Vector2.RIGHT
	var mirrors: Array = []           # [{c, base, steps, len}]
	var stones: Array = []            # [{p, r, lit, g}]   g = per-stone bloom 0..1
	var blockers: Array = []          # [{c, r}]
	var beam: PackedVector2Array = PackedVector2Array()
	var _pending: int = -1            # mirror index awaiting a committed rotation
	var _spark_t: float = 0.0
	var _warm: Color
	var _sparks: Array = []           # drifting caustic motes (child nodes)

	func kind() -> String: return PuzzleSystem.TYPE_LIGHTWEAVE
	func region_radius() -> float: return dell_r
	func intro_whisper() -> String: return "A shadow lies on this dell. Bend the light and wake it."

	func generate(pieces: int) -> void:
		dell_r = _rf("dr", 200.0, 250.0)
		dell_c = Vector2(0.0, -dell_r * 0.72)       # dell sits above the feet-origin
		_warm = Color(1.0, 0.86, 0.52)
		if pal.has("accent") and pal["accent"] is Color:
			_warm = _warm.lerp(pal["accent"], 0.15)
		# Emitter (Sun-Stone) on the dell rim, aimed inward.
		var ea := _rf("ea", PI * 0.78, PI * 1.18)   # upper-left rim
		emitter = dell_c + PuzzleSystem.dir(ea) * (dell_r * 0.92)
		emit_dir = (dell_c - emitter).normalized().rotated(_rf("ed", -0.18, 0.18))
		# FORWARD construction so a solution provably exists:
		# walk the beam, drop a mirror, turn toward the interior, drop a bloom-stone
		# on the straight run after each mirror. Each mirror's solution angle is the
		# bisector that turns d_in into the chosen d_out.
		mirrors.clear()
		stones.clear()
		blockers.clear()
		var nm: int = clampi(pieces, 2, 4)
		var pos := emitter
		var d := emit_dir
		for i in range(nm):
			var travel := _rf("mt%d" % i, dell_r * 0.5, dell_r * 0.78)
			var mc := pos + d * travel
			mc = dell_c + (mc - dell_c).limit_length(dell_r * 0.74)   # keep inside
			# choose an outgoing direction turned toward the dell interior
			var to_in := (dell_c - mc).normalized()
			var turn := _rf("mr%d" % i, 0.6, 1.25) * (1.0 if _f("ms%d" % i) < 0.5 else -1.0)
			var d_out := to_in.rotated(turn).normalized()
			var base_angle := (PuzzleSystem.ang(d) + PuzzleSystem.ang(d_out)) * 0.5
			var start := (1 + _pick_i("mk%d" % i, 23))               # scrambled offset (never solved)
			mirrors.append({"c": mc, "base": base_angle, "steps": start, "len": _rf("ml%d" % i, 46.0, 62.0)})
			# a bloom-stone part-way along the OUTGOING run (slight perpendicular offset)
			var run := _rf("sr%d" % i, dell_r * 0.32, dell_r * 0.6)
			var perp := Vector2(-d_out.y, d_out.x) * _rf("sp%d" % i, -14.0, 14.0)
			var sp := mc + d_out * run + perp
			sp = dell_c + (sp - dell_c).limit_length(dell_r * 0.85)
			stones.append({"p": sp, "r": _rf("sz%d" % i, 22.0, 30.0), "lit": false, "g": 0.0})
			pos = mc
			d = d_out
		# a couple of inert blocker rocks, kept clear of the solution path
		var nb: int = _pick_i("nb", 3)
		for j in range(nb):
			var ba := _rf("ba%d" % j, 0.0, TAU)
			var bc := dell_c + PuzzleSystem.dir(ba) * _rf("brd%d" % j, dell_r * 0.35, dell_r * 0.7)
			var br := _rf("brr%d" % j, 20.0, 30.0)
			if _blocker_ok(bc, br):
				blockers.append({"c": bc, "r": br})
		_trace()

	func _blocker_ok(bc: Vector2, br: float) -> bool:
		# reject blockers that would sit on the generated solution beam
		for i in range(mirrors.size()):
			var m = mirrors[i]
			if bc.distance_to(m.c) < br + m.len:
				return false
		for s in stones:
			if bc.distance_to(s.p) < br + s.r + 20.0:
				return false
		if bc.distance_to(emitter) < br + 40.0:
			return false
		return true

	func _on_built() -> void:
		_idle_glow = _Glow.new()
		_idle_glow.col = _warm
		_idle_glow.rad = dell_r * 0.7
		_idle_glow.position = dell_c
		_idle_glow.modulate.a = 0.55
		add_child(_idle_glow)
		# a few caustic sparkle motes that drift along the beam
		for i in range(5):
			var mo := _Mote.new()
			mo.col = _warm
			mo.r = 2.0
			add_child(mo)
			_sparks.append(mo)

	func _mirror_angle(m: Dictionary) -> float:
		return float(m.base) + float(m.steps) * STEP

	# Trace the beam through the current mirror orientations and light stones.
	func _trace() -> void:
		for s in stones:
			s.lit = false
		beam = PackedVector2Array()
		beam.append(emitter)
		var pos := emitter
		var d := emit_dir
		var lit_count := 0
		for bounce in range(10):
			var best_t := INF
			var hit_kind := 0           # 0 none, 1 mirror
			var hit_mi := -1
			# mirrors
			for i in range(mirrors.size()):
				var m = mirrors[i]
				var a := _mirror_angle(m)
				var half := PuzzleSystem.dir(a) * float(m.len) * 0.5
				var t := PuzzleSystem.ray_segment(pos, d, m.c - half, m.c + half)
				if t > 0.0 and t < best_t:
					best_t = t
					hit_kind = 1
					hit_mi = i
			# blockers (absorb)
			for b in blockers:
				var tb := PuzzleSystem.ray_circle(pos, d, b.c, b.r)
				if tb > 0.0 and tb < best_t:
					best_t = tb
					hit_kind = 0
					hit_mi = -1
			# dell boundary (exit)
			var tbound := PuzzleSystem.ray_circle(pos, d, dell_c, dell_r)
			var end: Vector2
			if hit_kind == 1 and best_t <= tbound:
				end = pos + d * best_t
			else:
				end = pos + d * (tbound if tbound > 0.0 else dell_r)
			beam.append(end)
			# light any stone whose centre is near this beam segment
			for s in stones:
				if not s.lit and PuzzleSystem.point_seg_dist(s.p, pos, end) < s.r * 0.95:
					s.lit = true
					lit_count += 1
			if hit_kind == 1 and best_t <= tbound:
				d = PuzzleSystem.reflect_line(d, _mirror_angle(mirrors[hit_mi]))
				pos = end + d * 0.5
			else:
				break
		var total: int = max(1, stones.size())
		_mark_progress(float(lit_count) / float(total))
		if lit_count >= stones.size() and not solved:
			for s in stones:
				s.lit = true
			_solve()

	# ----- tap-rotate -----
	func pending_from_point(lp: Vector2) -> bool:
		if solved:
			return false
		var best := -1
		var best_d := 40.0
		for i in range(mirrors.size()):
			var dd := lp.distance_to(mirrors[i].c)
			if dd < best_d:
				best_d = dd
				best = i
		_pending = best
		return best >= 0

	func commit_pending() -> void:
		if _pending < 0 or solved:
			return
		var m = mirrors[_pending]
		m.steps = (int(m.steps) + 1) % 24          # one rotation step; 24 wraps to the solution
		_pending = -1
		_trace()
		queue_redraw()

	func clear_pending() -> void:
		_pending = -1

	func _play_bloom() -> void:
		super._play_bloom()
		# stagger each stone's bloom
		for i in range(stones.size()):
			var s = stones[i]
			var tw := create_tween().set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_OUT)
			tw.tween_interval(0.12 * float(i))
			tw.tween_method(func(v): s.g = v; queue_redraw(), 0.0, 1.0, 1.0)

	func _animate(_delta: float) -> void:
		_spark_t += _delta
		# pulse the dell glow; brighten toward solved
		if _idle_glow:
			var base := 0.5 + 0.4 * bloom
			_idle_glow.modulate.a = base + 0.12 * sin(t * 1.6 + phase)
			_idle_glow.scale = Vector2.ONE * (1.0 + 0.03 * sin(t * 1.1))
		# drift caustic motes along the live beam
		if beam.size() >= 2:
			var total := 0.0
			for i in range(beam.size() - 1):
				total += beam[i].distance_to(beam[i + 1])
			if total > 1.0:
				for k in range(_sparks.size()):
					var u: float = fposmod(_spark_t * 0.12 + float(k) / float(_sparks.size()), 1.0)
					_sparks[k].position = _beam_point(u * total)
					_sparks[k].modulate.a = 0.5 + 0.5 * sin(_spark_t * 3.0 + k)

	func _beam_point(dist: float) -> Vector2:
		var acc := 0.0
		for i in range(beam.size() - 1):
			var seg := beam[i].distance_to(beam[i + 1])
			if acc + seg >= dist:
				var f: float = (dist - acc) / max(seg, 0.001)
				return beam[i].lerp(beam[i + 1], f)
			acc += seg
		return beam[beam.size() - 1]

	func _draw() -> void:
		# shaded ground oval of the dell
		var grey := Color(0.30, 0.34, 0.33)
		if pal.has("soil") and pal["soil"] is Color:
			grey = (pal["soil"] as Color).darkened(0.25)
		var wake := Color(0.42, 0.72, 0.42)
		if pal.has("base") and pal["base"] is Color:
			wake = (pal["base"] as Color)
		var ground := grey.lerp(wake, bloom)
		var oval := PackedVector2Array()
		var steps := 48
		for i in range(steps):
			var th := TAU * float(i) / float(steps)
			oval.append(dell_c + Vector2(cos(th) * dell_r, sin(th) * dell_r * 0.62))
		draw_colored_polygon(oval, Color(ground.r, ground.g, ground.b, 0.5 + 0.2 * (1.0 - bloom)))
		# soft darkness vignette that lifts as the dell wakes
		draw_arc(dell_c, dell_r, 0.0, TAU, 64, Color(0.1, 0.12, 0.14, 0.4 * (1.0 - bloom)), 10.0, true)
		# emitter Sun-Stone
		_draw_sunstone()
		# blockers
		for b in blockers:
			_draw_rock(b.c, b.r)
		# the beam (behind stones/mirrors so they sit on it)
		if beam.size() >= 2:
			PuzzleSystem.glow_line(self, beam, _warm, 3.0, 26.0, 0.9)
		# bloom-stones
		for s in stones:
			_draw_bloomstone(s)
		# mirrors
		for i in range(mirrors.size()):
			_draw_mirror(mirrors[i], i == _pending)

	func _draw_sunstone() -> void:
		var c := emitter
		for i in range(3):
			var rr: float = 26.0 - i * 6.0
			draw_circle(c, rr, Color(1.0, 0.8, 0.4, 0.3 + 0.2 * i))
		draw_circle(c, 11.0, Color(1.0, 0.95, 0.7, 1.0))
		# a few warm rim rays
		for k in range(8):
			var a := TAU * k / 8.0 + t * 0.3
			draw_line(c + PuzzleSystem.dir(a) * 14.0, c + PuzzleSystem.dir(a) * 22.0, Color(1.0, 0.85, 0.5, 0.5), 2.0, true)

	func _draw_rock(c: Vector2, r: float) -> void:
		var pts := Proc.blob(seedv, "rk%.0f%.0f" % [c.x, c.y], r, 7, 0.22)
		var moved := PackedVector2Array()
		for p in pts:
			moved.append(c + p)
		draw_colored_polygon(moved, Color(0.33, 0.33, 0.37))
		draw_polyline(moved, Color(0.2, 0.2, 0.24, 0.8), 2.0, true)

	func _draw_bloomstone(s: Dictionary) -> void:
		var p: Vector2 = s.p
		var r: float = s.r
		var lit: bool = s.lit
		var gb: float = float(s.g)
		var cold := Color(0.4, 0.45, 0.55)
		var hot := Color(0.7, 1.0, 0.75)
		if pal.has("accent") and pal["accent"] is Color:
			hot = hot.lerp(pal["accent"], 0.3)
		var body := cold.lerp(hot, (0.4 if lit else 0.0) + 0.6 * gb)
		if lit:
			draw_circle(p, r * (1.9 + 0.5 * gb), Color(hot.r, hot.g, hot.b, 0.18 + 0.2 * gb))
		# faceted crystal bud (smooth superellipse petals)
		var petals := 5
		for k in range(petals):
			var a := TAU * k / petals - PI * 0.5 + 0.1 * sin(t + k)
			var tip := p + PuzzleSystem.dir(a) * r * (1.0 + 0.6 * gb)
			var w := PuzzleSystem.dir(a + PI * 0.5) * r * 0.4
			var leaf := PackedVector2Array([p, p + w, tip, p - w])
			draw_colored_polygon(leaf, body)
		draw_circle(p, r * 0.45, Color(min(1.0, body.r + 0.2), min(1.0, body.g + 0.2), min(1.0, body.b + 0.2)))

	func _draw_mirror(m: Dictionary, highlight: bool) -> void:
		var c: Vector2 = m.c
		var a := _mirror_angle(m)
		var hx := PuzzleSystem.dir(a) * float(m.len) * 0.5
		var hy := PuzzleSystem.dir(a + PI * 0.5) * 7.0
		var quad := PackedVector2Array([c - hx - hy, c + hx - hy, c + hx + hy, c - hx + hy])
		var face := Color(0.75, 0.9, 1.0, 0.92)
		if pal.has("accent") and pal["accent"] is Color:
			face = face.lerp(pal["accent"], 0.2)
		draw_colored_polygon(quad, face)
		# reflective sheen line
		draw_line(c - hx + hy * 0.3, c + hx + hy * 0.3, Color(1, 1, 1, 0.8), 2.0, true)
		# crystalline frame
		draw_polyline(PackedVector2Array([quad[0], quad[1], quad[2], quad[3], quad[0]]), Color(0.5, 0.7, 0.9, 0.9), 2.0, true)
		# a little pivot base so it reads as a tappable prism in a socket
		draw_circle(c, 6.0, Color(0.9, 0.95, 1.0, 0.9))
		if highlight:
			draw_arc(c, float(m.len) * 0.5 + 10.0, 0.0, TAU, 28, Color(1, 1, 1, 0.5), 2.0, true)

	func reward() -> Dictionary:
		return {
			"type": kind(),
			"essence_bloom": 60.0 + 20.0 * float(stones.size()),
			"wake_radius": dell_r,
			"rare_decoration": _f("rare") < 0.35,
		}

	func serialize() -> Dictionary:
		var ms := []
		for m in mirrors:
			ms.append(int(m.steps))
		var d := super.serialize()
		d["mirror_steps"] = ms
		return d

	func restore(d: Dictionary) -> void:
		var ms = d.get("mirror_steps", [])
		for i in range(min(ms.size(), mirrors.size())):
			mirrors[i].steps = int(ms[i])
		super.restore(d)
		_trace()

# =====================================================================
# 2) ROOTWORK — weave one non-crossing root through every dormant node
# =====================================================================
class _Rootwork extends _Puzzle:
	var reach: float = 300.0
	var anchor: Vector2 = Vector2.ZERO            # the live Heart-root tip
	var nodes: Array = []                         # [{p, r, hit, g}]
	var stroke: PackedVector2Array = PackedVector2Array()
	var _drawing: bool = false
	var _sap: Array = []                          # travelling sap motes
	var _sap_t: float = 0.0
	var _rootc: Color
	var _nodec: Color

	func kind() -> String: return PuzzleSystem.TYPE_ROOTWORK
	func region_radius() -> float: return reach
	func intro_whisper() -> String: return "Dormant seeds drift past the edge. Weave a root to each."

	func generate(n: int) -> void:
		reach = _rf("reach", 280.0, 340.0)
		anchor = Vector2(0.0, -40.0)
		_rootc = Color(0.85, 0.72, 0.5)
		_nodec = Color(0.55, 0.85, 0.65)
		if pal.has("accent") and pal["accent"] is Color:
			_nodec = _nodec.lerp(pal["accent"], 0.3)
		nodes.clear()
		var count: int = clampi(n, 3, 8)
		# Place nodes on a jittered OUTWARD SPIRAL (monotone angle + radius) so a
		# simple, non-self-crossing visiting order provably exists (§3.2, always solvable).
		var a0 := _rf("a0", -0.6, 0.6)
		var spread := _rf("spr", 2.4, 3.6)          # total swept angle (radians)
		for i in range(count):
			var f := float(i) / float(max(1, count - 1))
			var a := a0 + spread * f - PI * 0.5      # sweep upward/outward
			var rad := reach * (0.42 + 0.5 * f) + _rf("nr%d" % i, -14.0, 14.0)
			var p := anchor + Vector2(cos(a) * rad * 1.05, sin(a) * rad * 0.8)
			p.y -= reach * 0.15                      # lift the cluster into the mist
			nodes.append({"p": p, "r": _rf("ns%d" % i, 20.0, 27.0), "hit": false, "g": 0.0})

	func _on_built() -> void:
		_idle_glow = _Glow.new()
		_idle_glow.col = _nodec
		_idle_glow.rad = reach * 0.6
		_idle_glow.position = _centroid()
		_idle_glow.modulate.a = 0.4
		add_child(_idle_glow)
		for i in range(4):
			var mo := _Mote.new()
			mo.col = Color(0.8, 1.0, 0.7)
			mo.r = 2.2
			add_child(mo)
			_sap.append(mo)

	func _centroid() -> Vector2:
		var c := anchor
		for nd in nodes:
			c += nd.p
		return c / float(nodes.size() + 1)

	# ----- finger drawing -----
	func begin_stroke(lp: Vector2) -> bool:
		if solved:
			return false
		if stroke.is_empty():
			if lp.distance_to(anchor) < 60.0:
				stroke.append(anchor)
				_drawing = true
				queue_redraw()
				return true
			return false
		# resume from the free end
		if lp.distance_to(stroke[stroke.size() - 1]) < 60.0:
			_drawing = true
			return true
		return false

	func extend_stroke(lp: Vector2) -> void:
		if not _drawing or solved:
			return
		var last := stroke[stroke.size() - 1]
		if lp.distance_to(last) < 11.0:
			return
		# the root may not cross itself — if the new segment would cross an earlier one
		# it simply will not take (recoils softly, §3.2). Skip the two adjacent segs.
		for i in range(stroke.size() - 2):
			if PuzzleSystem.segs_cross(last, lp, stroke[i], stroke[i + 1]):
				return
		stroke.append(lp)
		# mark nodes the new segment passes through
		var newly := 0
		for nd in nodes:
			if not nd.hit and PuzzleSystem.point_seg_dist(nd.p, last, lp) < nd.r:
				nd.hit = true
				newly += 1
		if newly > 0:
			_mark_progress(float(_hit_count()) / float(nodes.size()))
		queue_redraw()

	func end_stroke() -> void:
		_drawing = false
		if _hit_count() >= nodes.size() and not solved:
			_solve()

	func tap_anchor(lp: Vector2) -> bool:
		if solved:
			return false
		if lp.distance_to(anchor) < 50.0 and not stroke.is_empty():
			# patiently start over
			stroke = PackedVector2Array()
			for nd in nodes:
				nd.hit = false
			_mark_progress(0.0)
			queue_redraw()
			return true
		return false

	func _hit_count() -> int:
		var n := 0
		for nd in nodes:
			if nd.hit:
				n += 1
		return n

	func _play_bloom() -> void:
		super._play_bloom()
		for i in range(nodes.size()):
			var nd = nodes[i]
			var tw := create_tween().set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
			tw.tween_interval(0.1 * float(i))
			tw.tween_method(func(v): nd.g = v; queue_redraw(), 0.0, 1.0, 1.1)

	func _animate(_delta: float) -> void:
		_sap_t += _delta
		if _idle_glow:
			_idle_glow.modulate.a = (0.35 + 0.5 * bloom) + 0.1 * sin(t * 1.3 + phase)
		# travelling sap pulse along the drawn root (and brighter once solved)
		if stroke.size() >= 2:
			var total := 0.0
			for i in range(stroke.size() - 1):
				total += stroke[i].distance_to(stroke[i + 1])
			if total > 1.0:
				for k in range(_sap.size()):
					var u: float = fposmod(_sap_t * (0.25 + 0.15 * bloom) + float(k) / float(_sap.size()), 1.0)
					_sap[k].position = _stroke_point(u * total)
					_sap[k].modulate.a = (0.4 + 0.6 * bloom) * (0.5 + 0.5 * sin(_sap_t * 4.0 + k))
		else:
			for mo in _sap:
				mo.modulate.a = 0.0

	func _stroke_point(dist: float) -> Vector2:
		var acc := 0.0
		for i in range(stroke.size() - 1):
			var seg := stroke[i].distance_to(stroke[i + 1])
			if acc + seg >= dist:
				var f: float = (dist - acc) / max(seg, 0.001)
				return stroke[i].lerp(stroke[i + 1], f)
			acc += seg
		return stroke[stroke.size() - 1]

	func _draw() -> void:
		# misty veil over the dormant field (lifts on solve)
		var veil := Color(0.7, 0.78, 0.82, 0.18 * (1.0 - bloom))
		draw_circle(_centroid(), reach * 0.82, veil)
		# the live Heart-root anchor
		_draw_anchor()
		# the drawn root
		if stroke.size() >= 2:
			var rc := _rootc.lerp(Color(0.7, 1.0, 0.7), bloom)
			PuzzleSystem.glow_line(self, stroke, rc, 4.5 + 2.0 * bloom, 20.0, 0.95)
			# little fibrous rootlets along the path
			_draw_rootlets()
		# dormant / woken seed-nodes
		for nd in nodes:
			_draw_node(nd)

	func _draw_anchor() -> void:
		draw_circle(anchor, 15.0, Color(0.5, 0.36, 0.24))
		draw_circle(anchor, 9.0, Color(0.75, 0.9, 0.6, 0.8 + 0.2 * sin(t * 2.0)))
		# a few roots already reaching out of the ground
		for k in range(3):
			var a := PI * 0.5 + _rf("ar%d" % k, -0.5, 0.5)
			draw_line(anchor, anchor + PuzzleSystem.dir(a) * 18.0, Color(0.5, 0.36, 0.24), 3.0, true)

	func _draw_rootlets() -> void:
		var rc := _rootc.lerp(Color(0.7, 1.0, 0.7), bloom)
		var i := 6
		while i < stroke.size():
			var p := stroke[i]
			var prev := stroke[i - 1]
			var tang := (p - prev).normalized()
			var nrm := Vector2(-tang.y, tang.x)
			var side := 1.0 if (i % 2 == 0) else -1.0
			draw_line(p, p + (nrm * side + tang * 0.3) * 10.0, Color(rc.r, rc.g, rc.b, 0.5), 1.5, true)
			i += 5

	func _draw_node(nd: Dictionary) -> void:
		var p: Vector2 = nd.p
		var r: float = nd.r
		var gb: float = float(nd.g)
		var dormant := Color(0.42, 0.45, 0.5)
		var woken := _nodec
		var body := dormant.lerp(woken, (0.35 if nd.hit else 0.0) + 0.65 * gb)
		if nd.hit:
			draw_circle(p, r * (1.8 + gb), Color(woken.r, woken.g, woken.b, 0.16 + 0.18 * gb))
		# a seed-pod: a smooth teardrop that cracks into a sprout as it wakes
		var pod := PackedVector2Array()
		var steps := 20
		for i in range(steps):
			var th := TAU * float(i) / float(steps)
			var rr: float = r * (1.0 - 0.25 * sin(th))     # teardrop
			pod.append(p + Vector2(cos(th) * rr, sin(th) * rr * 1.15))
		draw_colored_polygon(pod, body)
		draw_polyline(_closed(pod), body.darkened(0.3), 1.5, true)
		if gb > 0.2:
			# a little sprout unfurling from the woken pod
			var top := p + Vector2(0, -r * 1.1)
			var stem := PackedVector2Array([p + Vector2(0, -r * 0.3), top])
			draw_polyline(stem, Color(0.4, 0.7, 0.45), 2.0 * gb + 1.0, true)
			for sgn in [-1.0, 1.0]:
				var la: float = -PI * 0.5 + 0.7 * float(sgn)
				var lp: Vector2 = top + PuzzleSystem.dir(la) * r * 0.8 * gb
				draw_line(top, lp, Color(0.45, 0.8, 0.5), 2.0, true)

	func _closed(p: PackedVector2Array) -> PackedVector2Array:
		var o := p.duplicate()
		if o.size() > 0:
			o.append(o[0])
		return o

	func reward() -> Dictionary:
		var vein_roll := _f("vein")
		var vein := "none"
		if vein_roll < 0.33:
			vein = "crystal"
		elif vein_roll < 0.6:
			vein = "timber"
		return {
			"type": kind(),
			"expand_dx": _rf("edx", 120.0, 220.0),
			"expand_dy": _rf("edy", -40.0, 20.0),
			"expand_radius": reach * (0.7 + 0.15 * float(nodes.size())),
			"new_plots": nodes.size(),
			"resource_vein": vein,
		}

	func serialize() -> Dictionary:
		var pts := []
		for p in stroke:
			pts.append([p.x, p.y])
		var d := super.serialize()
		d["stroke"] = pts
		return d

	func restore(d: Dictionary) -> void:
		stroke = PackedVector2Array()
		for pr in d.get("stroke", []):
			stroke.append(Vector2(pr[0], pr[1]))
		# recompute which nodes the restored root hits
		for nd in nodes:
			nd.hit = false
		for i in range(stroke.size() - 1):
			for nd in nodes:
				if not nd.hit and PuzzleSystem.point_seg_dist(nd.p, stroke[i], stroke[i + 1]) < nd.r:
					nd.hit = true
		super.restore(d)

# =====================================================================
# 3) BLOOMTIDE — rotate channel-stones to route the spring to every bed
# =====================================================================
class _Bloomtide extends _Puzzle:
	# connection bits: N=1, E=2, S=4, W=8
	const N := 1
	const E := 2
	const S := 4
	const W := 8
	var cols: int = 3
	var rows: int = 4
	var cs: float = 74.0                 # cell size
	var origin: Vector2 = Vector2.ZERO   # top-left of the grid (local)
	var cells: Array = []                # per-cell dict {kind, mask, rot, watered}
	var src_idx: int = -1
	var beds: Array = []                 # indices of flower-bed sinks
	var _pending: int = -1
	var _flow: Array = []                # flow motes
	var _flow_t: float = 0.0
	var _waterc: Color
	var _stonec: Color

	func kind() -> String: return PuzzleSystem.TYPE_BLOOMTIDE
	func region_radius() -> float:
		return maxf(cols * cs, rows * cs) * 0.75
	func intro_whisper() -> String: return "The spring is dammed. Lay the channels and let it flow down."

	func generate(bed_count: int) -> void:
		cols = clampi(2 + _pick_i("cols", 2), 3, 4)
		rows = clampi(3 + _pick_i("rows", 2), 3, 5)
		cs = _rf("cs", 68.0, 80.0)
		origin = Vector2(-cols * cs * 0.5, -(rows * cs) - cs * 0.3)
		_waterc = Color(0.45, 0.78, 0.95)
		_stonec = Color(0.55, 0.52, 0.48)
		if pal.has("accent") and pal["accent"] is Color:
			_waterc = _waterc.lerp(pal["accent"], 0.2)
		cells.clear()
		for i in range(cols * rows):
			cells.append({"kind": "rock", "mask": 0, "rot": 0, "watered": false})
		# spring at a seeded top-row column
		var sc := _pick_i("sc", cols)
		src_idx = _ci(0, sc)
		beds.clear()
		var want: int = clampi(bed_count, 2, cols)
		# choose distinct bottom-row bed columns
		var cols_order := []
		for c in range(cols):
			cols_order.append(c)
		# seeded shuffle
		for i in range(cols_order.size()):
			var j := _pick_i("sh%d" % i, cols_order.size())
			var tmp = cols_order[i]
			cols_order[i] = cols_order[j]
			cols_order[j] = tmp
		for b in range(min(want, cols)):
			beds.append(_ci(rows - 1, cols_order[b]))
		# ---- carve guaranteed DOWNHILL solution paths (only S / E / W moves) ----
		var req := {}            # cell_idx -> required open mask
		for bi in range(beds.size()):
			_carve_path(src_idx, beds[bi], req, bi)
		# classify + build pieces
		src_idx = src_idx
		for idx in req.keys():
			var m: int = req[idx]
			if idx == src_idx:
				cells[idx] = {"kind": "spring", "mask": m, "rot": 0, "watered": true}
			elif beds.has(idx):
				cells[idx] = {"kind": "bed", "mask": m, "rot": 0, "watered": false, "g": 0.0}
			else:
				# rotatable channel-stone; scramble its orientation (keep solvable)
				var rot := 1 + _pick_i("rot%d" % idx, 3)
				cells[idx] = {"kind": "pipe", "mask": _rotate_mask(m, rot), "rot": rot, "base": m, "watered": false}
		# ensure spring + beds exist even if not touched (safety)
		if cells[src_idx].kind != "spring":
			cells[src_idx] = {"kind": "spring", "mask": S, "rot": 0, "watered": true}
		for bi in beds:
			if cells[bi].kind != "bed":
				cells[bi] = {"kind": "bed", "mask": N, "rot": 0, "watered": false, "g": 0.0}
		_flood()

	func _carve_path(from_idx: int, to_idx: int, req: Dictionary, salt: int) -> void:
		var r := _ri(from_idx)
		var c := _cci(from_idx)
		var tr := _ri(to_idx)
		var tc := _cci(to_idx)
		var guard := 0
		while (r != tr or c != tc) and guard < 64:
			guard += 1
			var step_down := r < tr
			var step_side := c != tc
			var go_down: bool
			if step_down and step_side:
				go_down = Proc.hashf(seedv, "carve%d:%d:%d" % [salt, guard, from_idx]) < 0.55
			elif step_down:
				go_down = true
			else:
				go_down = false
			var cur := _ci(r, c)
			var nr := r
			var nc := c
			var out_bit: int
			var in_bit: int
			if go_down:
				nr = r + 1
				out_bit = S
				in_bit = N
			else:
				if c < tc:
					nc = c + 1
					out_bit = E
					in_bit = W
				else:
					nc = c - 1
					out_bit = W
					in_bit = E
			req[cur] = int(req.get(cur, 0)) | out_bit
			var nxt := _ci(nr, nc)
			req[nxt] = int(req.get(nxt, 0)) | in_bit
			r = nr
			c = nc

	func _on_built() -> void:
		_idle_glow = _Glow.new()
		_idle_glow.col = _waterc
		_idle_glow.rad = region_radius() * 0.7
		_idle_glow.position = _grid_center()
		_idle_glow.modulate.a = 0.3
		add_child(_idle_glow)
		for i in range(6):
			var mo := _Mote.new()
			mo.col = Color(0.75, 0.95, 1.0)
			mo.r = 2.2
			add_child(mo)
			_flow.append(mo)

	# ----- grid index helpers -----
	func _ci(r: int, c: int) -> int: return r * cols + c
	func _ri(idx: int) -> int: return idx / cols
	func _cci(idx: int) -> int: return idx % cols
	func _cell_center(idx: int) -> Vector2:
		return origin + Vector2((_cci(idx) + 0.5) * cs, (_ri(idx) + 0.5) * cs)

	func _grid_center() -> Vector2:
		return origin + Vector2(cols * cs * 0.5, rows * cs * 0.5)

	static func _rotate_mask(m: int, quarters: int) -> int:
		var r := m & 0xF
		for _i in range(quarters % 4):
			r = ((r << 1) | (r >> 3)) & 0xF
		return r

	func _cell_mask(c: Dictionary) -> int:
		return int(c.mask)

	# ----- water flood: downhill + matching openings -----
	func _flood() -> void:
		for c in cells:
			c.watered = (c.kind == "spring")
		var queue := [src_idx]
		var head := 0
		while head < queue.size():
			var idx: int = queue[head]
			head += 1
			var r := _ri(idx)
			var c := _cci(idx)
			var m := _cell_mask(cells[idx])
			# try each open direction; water may go S / E / W (never up through N)
			var dirs := [[S, 1, 0, N], [E, 0, 1, W], [W, 0, -1, E]]
			for dd in dirs:
				var bit: int = dd[0]
				if (m & bit) == 0:
					continue
				var nr: int = r + dd[1]
				var nc: int = c + dd[2]
				if nr < 0 or nr >= rows or nc < 0 or nc >= cols:
					continue
				var nidx := _ci(nr, nc)
				var nm := _cell_mask(cells[nidx])
				if (nm & int(dd[3])) == 0:
					continue               # neighbour has no matching opening
				if cells[nidx].watered:
					continue
				cells[nidx].watered = true
				queue.append(nidx)
		# progress + solve
		var wet := 0
		for bi in beds:
			if cells[bi].watered:
				wet += 1
		_mark_progress(float(wet) / float(max(1, beds.size())))
		if wet >= beds.size() and not solved:
			_solve()

	# ----- tap-rotate -----
	func pending_from_point(lp: Vector2) -> bool:
		if solved:
			return false
		var idx := _cell_at(lp)
		if idx >= 0 and cells[idx].kind == "pipe":
			_pending = idx
			return true
		_pending = -1
		return false

	func _cell_at(lp: Vector2) -> int:
		var rel := lp - origin
		if rel.x < 0 or rel.y < 0:
			return -1
		var c := int(rel.x / cs)
		var r := int(rel.y / cs)
		if r < 0 or r >= rows or c < 0 or c >= cols:
			return -1
		return _ci(r, c)

	func commit_pending() -> void:
		if _pending < 0 or solved:
			return
		var cell = cells[_pending]
		if cell.kind == "pipe":
			cell.rot = (int(cell.rot) + 1) % 4
			cell.mask = _rotate_mask(int(cell.base), int(cell.rot))
		_pending = -1
		_flood()
		queue_redraw()

	func clear_pending() -> void:
		_pending = -1

	func _play_bloom() -> void:
		super._play_bloom()
		for bi in beds:
			var cell = cells[bi]
			var tw := create_tween().set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
			tw.tween_method(func(v): cell.g = v; queue_redraw(), 0.0, 1.0, 1.2)

	func _animate(_delta: float) -> void:
		_flow_t += _delta
		if _idle_glow:
			_idle_glow.modulate.a = (0.25 + 0.45 * bloom) + 0.08 * sin(t * 1.4 + phase)
		# drift flow motes along watered channels
		var wet_centers := []
		for i in range(cells.size()):
			if cells[i].watered and cells[i].kind != "bed":
				wet_centers.append(_cell_center(i))
		if wet_centers.size() > 0:
			for k in range(_flow.size()):
				var wi: int = k % wet_centers.size()
				var base: Vector2 = wet_centers[wi]
				var off := fposmod(_flow_t * 0.8 + float(k) * 0.37, 1.0) - 0.5
				_flow[k].position = base + Vector2(0, off * cs * 0.8)
				_flow[k].modulate.a = 0.4 + 0.4 * sin(_flow_t * 3.0 + k)
		else:
			for mo in _flow:
				mo.modulate.a = 0.0

	func _draw() -> void:
		# terrace earth under the grid
		for r in range(rows):
			var y0 := origin.y + r * cs
			var terr := PackedVector2Array([
				origin + Vector2(-8, y0),
				origin + Vector2(cols * cs + 8, y0),
				origin + Vector2(cols * cs + 8, y0 + cs),
				origin + Vector2(-8, y0 + cs),
			])
			var earth := Color(0.42, 0.34, 0.26).lerp(Color(0.5, 0.45, 0.3), float(r) / float(rows))
			earth = PuzzleSystem.drift(earth, pal, 0.1)
			draw_colored_polygon(terr, earth)
			# terrace lip highlight
			draw_line(origin + Vector2(-8, y0), origin + Vector2(cols * cs + 8, y0), Color(1, 1, 1, 0.08), 2.0, true)
		# cells
		for idx in range(cells.size()):
			_draw_cell(idx)
		# spring crown on top
		_draw_spring()

	func _draw_cell(idx: int) -> void:
		var cell = cells[idx]
		var cc := _cell_center(idx)
		match String(cell.kind):
			"rock":
				_draw_rock_cell(cc)
			"spring":
				_draw_channel(cc, _cell_mask(cell), cell.watered, true)
			"bed":
				_draw_bed(cc, cell)
			"pipe":
				_draw_channel(cc, _cell_mask(cell), cell.watered, false)
				if idx == _pending:
					draw_arc(cc, cs * 0.46, 0.0, TAU, 24, Color(1, 1, 1, 0.4), 2.0, true)

	func _draw_rock_cell(cc: Vector2) -> void:
		var pts := Proc.blob(seedv, "brk%.0f%.0f" % [cc.x, cc.y], cs * 0.32, 7, 0.26)
		var moved := PackedVector2Array()
		for p in pts:
			moved.append(cc + p)
		draw_colored_polygon(moved, _stonec.darkened(0.1))
		draw_polyline(_closed(moved), _stonec.darkened(0.35), 2.0, true)
		# a touch of moss
		draw_circle(cc + Vector2(-cs * 0.1, cs * 0.12), cs * 0.1, Color(0.4, 0.55, 0.35, 0.5))

	func _draw_channel(cc: Vector2, mask: int, watered: bool, is_spring: bool) -> void:
		# a rounded stone tile with carved grooves toward each open direction
		var tile_r := cs * 0.42
		var tile := Proc.superellipse(tile_r, tile_r, 4.0, 28)
		var moved := PackedVector2Array()
		for p in tile:
			moved.append(cc + p)
		var stone := _stonec
		if is_spring:
			stone = stone.lerp(Color(0.6, 0.7, 0.72), 0.4)
		draw_colored_polygon(moved, stone)
		draw_polyline(_closed(moved), stone.darkened(0.3), 2.0, true)
		# groove per direction
		var groove := Color(0.3, 0.28, 0.26)
		var gw := cs * 0.22
		var dirs := {N: Vector2(0, -1), E: Vector2(1, 0), S: Vector2(0, 1), W: Vector2(-1, 0)}
		for bit in dirs.keys():
			if (mask & bit) != 0:
				var dv: Vector2 = dirs[bit]
				var a := cc
				var b := cc + dv * tile_r
				draw_line(a, b, groove, gw, true)
		# water fill when this channel is wet
		if watered:
			var wcol := _waterc
			# a soft hub
			draw_circle(cc, gw * 0.55, Color(wcol.r, wcol.g, wcol.b, 0.95))
			for bit in dirs.keys():
				if (mask & bit) != 0:
					var dv: Vector2 = dirs[bit]
					draw_line(cc, cc + dv * tile_r, Color(wcol.r, wcol.g, wcol.b, 0.95), gw * 0.7, true)
			# surface glint
			draw_circle(cc + Vector2(-gw * 0.2, -gw * 0.2), gw * 0.18, Color(1, 1, 1, 0.5))

	func _draw_spring(_unused := 0) -> void:
		if src_idx < 0:
			return
		var cc := _cell_center(src_idx) + Vector2(0, -cs * 0.4)
		draw_circle(cc, cs * 0.2, Color(0.5, 0.55, 0.6))
		draw_circle(cc, cs * 0.14, _waterc)
		draw_circle(cc + Vector2(-3, -3), cs * 0.05, Color(1, 1, 1, 0.6))

	func _draw_bed(cc: Vector2, cell: Dictionary) -> void:
		var gb: float = float(cell.get("g", 0.0))
		var watered: bool = cell.watered
		# soil bed
		var bed := Proc.superellipse(cs * 0.4, cs * 0.3, 3.2, 24)
		var moved := PackedVector2Array()
		for p in bed:
			moved.append(cc + p + Vector2(0, cs * 0.08))
		var soil := Color(0.36, 0.26, 0.2)
		if watered:
			soil = soil.lerp(Color(0.3, 0.22, 0.16), 0.5)   # darker, damp
		draw_colored_polygon(moved, soil)
		# dry = cracked grey buds; watered/bloom = colourful flowers
		var n := 3
		for k in range(n):
			var fx := cc.x + (float(k) - 1.0) * cs * 0.22
			var fy := cc.y + cs * 0.05
			var base := Vector2(fx, fy)
			if gb < 0.05 and not watered:
				# wilted bud
				draw_circle(base, 3.0, Color(0.5, 0.5, 0.45))
				draw_line(base, base + Vector2(0, -8), Color(0.45, 0.5, 0.4), 1.5, true)
			else:
				var open: float = clampf((0.3 if watered else 0.0) + gb, 0.0, 1.0)
				# stem
				draw_line(base, base + Vector2(0, -cs * 0.22 * open), Color(0.35, 0.6, 0.4), 2.0, true)
				var head := base + Vector2(0, -cs * 0.22 * open)
				var fcol := Color.from_hsv(fposmod(_f("fh%.0f%d" % [cc.x, k]) + 0.0, 1.0), 0.6, 0.95)
				if pal.has("accent") and pal["accent"] is Color:
					fcol = fcol.lerp(pal["accent"], 0.2)
				var petals := 5
				for pI in range(petals):
					var a := TAU * pI / petals + t * 0.3
					var tip := head + PuzzleSystem.dir(a) * cs * 0.11 * open
					draw_line(head, tip, fcol, 3.0 * open + 0.5, true)
				draw_circle(head, 2.5 * open + 0.5, Color(1.0, 0.9, 0.5))

	func _closed(p: PackedVector2Array) -> PackedVector2Array:
		var o := p.duplicate()
		if o.size() > 0:
			o.append(o[0])
		return o

	func reward() -> Dictionary:
		return {
			"type": kind(),
			"essence_bonus": 0.08 + 0.02 * float(beds.size()),   # permanent % bonus to the patch
			"bloom_beds": beds.size(),
			"becomes": "essence_garden",
		}

	func serialize() -> Dictionary:
		var rots := []
		for c in cells:
			rots.append(int(c.get("rot", 0)))
		var d := super.serialize()
		d["rots"] = rots
		return d

	func restore(d: Dictionary) -> void:
		var rots = d.get("rots", [])
		for i in range(min(rots.size(), cells.size())):
			if cells[i].kind == "pipe":
				cells[i].rot = int(rots[i])
				cells[i].mask = _rotate_mask(int(cells[i].base), int(cells[i].rot))
		super.restore(d)
		_flood()
