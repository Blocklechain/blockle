class_name ProcNode
extends Node2D
# Base class for every procedurally-drawn, living thing in the world. It gives
# all subsystems one consistent contract for three things the game cares about:
#
#   1. SEEDED       — `seedv` (+ keys) makes each instance deterministic + unique.
#   2. GROWING      — `growth` in [0,1] is the life stage: 0 = just-planted seed,
#                     1 = fully grown. Draw code MUST render a believable stage for
#                     any value (a sprout at 0.2, a sapling at 0.5, mature at 1.0),
#                     so spawning and levelling up are real growth, not a pop.
#   3. ALIVE        — an animation clock `t` with a per-instance `phase` so nothing
#                     moves in lockstep. Prefer cheap TRANSFORM animation (rotate/
#                     scale child nodes, shader uniforms) over redrawing every
#                     frame; only call queue_redraw() when the SHAPE changes
#                     (i.e. when growth changes), so a busy world stays smooth.
#
# Recognisability rule: shapes must read as the real thing (tree, cottage, creature),
# never abstract blobs. Smoothness rule: use Proc.smooth_loop / superellipse /
# grad_fill and many-segment arcs; no hard facets.

@export var seedv: int = 1
var growth: float = 1.0
var t: float = 0.0
var phase: float = 0.0
var animate_draw: bool = false   # set true only if _draw itself must change per frame
# Continuous, VERY SLOW growth: the world keeps growing the whole time you play.
# grow_rate is growth-per-second; default ~ full maturity over 25 minutes. Growth
# never visibly jumps — a redraw only happens when it has crept past a threshold.
var grow_rate: float = 1.0 / (25.0 * 60.0)
var _last_draw_growth: float = -1.0
var _grow_tw: Tween

func _ready() -> void:
	phase = Proc.hashf(seedv, "phase:%d" % get_instance_id()) * TAU
	_on_built()

func _process(delta: float) -> void:
	t += delta
	# Continuous slow growth toward maturity (unless a tween is actively driving it).
	if grow_rate > 0.0 and growth < 1.0 and not (_grow_tw and _grow_tw.is_valid()):
		growth = min(1.0, growth + grow_rate * delta)
	_animate(delta)
	# Redraw on meaningful shape change (slow growth) or when a subclass needs per-frame shape anim.
	if animate_draw or absf(growth - _last_draw_growth) > 0.0025:
		_last_draw_growth = growth
		queue_redraw()
		_on_growth()

# Set how long (minutes) this thing takes to grow from seed to full.
func set_grow_minutes(m: float) -> void:
	grow_rate = (1.0 / (m * 60.0)) if m > 0.0 else 0.0

# Subclasses override these three.
func _on_built() -> void:
	pass                      # build child nodes / shaders once here if desired
func _animate(_delta: float) -> void:
	pass                      # cheap transform / shader-uniform animation per frame
# (subclasses also override _draw() for immediate-mode shapes)

# ---- growth -----------------------------------------------------------------

func set_growth(v: float) -> void:
	growth = clampf(v, 0.0, 1.0)
	# Before the node enters the tree, _on_built() hasn't run yet, so subclass
	# growth reactions would touch uninitialised internals. Just store the value —
	# the first _process() after _ready() redraws + reacts at this growth.
	if not is_inside_tree():
		return
	queue_redraw()
	_on_growth()

func _on_growth() -> void:
	pass                      # react to a new growth value (e.g. resize child nodes)

# Animate from the current growth up to `target` with an organic ease-out-back so
# it looks like something unfurling. Used on spawn and on level-up.
func grow_to(target: float, dur: float = 0.9) -> void:
	if _grow_tw and _grow_tw.is_valid():
		_grow_tw.kill()
	_grow_tw = create_tween().set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
	_grow_tw.tween_method(set_growth, growth, clampf(target, 0.0, 1.0), dur)

# Spawn newly planted: start as a seed and unfurl to full.
func pop_in(dur: float = 1.0) -> void:
	set_growth(0.0)
	grow_to(1.0, dur)

# Eased growth for drawing: smootherstep so early stages are gentle.
func g() -> float:
	var x := clampf(growth, 0.0, 1.0)
	return x * x * x * (x * (x * 6.0 - 15.0) + 10.0)
