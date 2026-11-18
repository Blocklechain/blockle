class_name WorldExpansion
extends Node
# WorldExpansion — the "ever-expanding world" controller for Blockle Idle.
#
# The opening question seeds one origin island (StartJourney). From that single
# origin seed the world keeps growing OUTWARD, forever, the way everything else in
# this game grows: continuously, very slowly, online AND offline, never a pop.
#
# This node is the quiet gardener of new LAND. It does not draw anything itself; it
# composes ProcTerrain islets/islands and stages them in over a long, gentle bloom,
# then tells the rest of the game ("a new region woke, here, with this seed") so the
# placement / puzzle / plot systems can hang life on the fresh ground.
#
# WHY TIME-DRIVEN (and how it co-exists with the Rootwork puzzle, IDLE-DESIGN §3.2):
#   * The whole layout is a PURE FUNCTION of (world_seed, region_index): position,
#     size, realm-flavour and the exact wall-clock AGE at which each region matures.
#     Nothing is stored per-region, so a save stays tiny and two players with the
#     same origin phrase grow the identical archipelago in the identical order.
#   * "World age" is wall-clock: now − genesis. That makes expansion inherently
#     offline-aware — come back in two days and the regions that matured while you
#     were gone are simply already there, fully grown, the moment you wake.
#   * It is the AUTOMATIC floor of expansion. The Rootwork puzzle is the player's
#     ACCELERATOR: solving one calls force_bloom_next() to wake the next region now,
#     ahead of its scheduled age — so puzzles always feel like they moved the world
#     forward, and an idle player still, slowly, gains new land regardless.
#
# Honours the seven hard rules through the modules it stages: seeded + limitless,
# smooth storybook land, growth continuous (grow_to over seconds for a *fresh* bloom,
# instant-mature for land that woke long ago while away), alive (the islets ProcTerrain
# gives us bob and shimmer on their own), cheap (we instantiate land only as it is due,
# never per-frame), portrait-agnostic (positions are world-space around the origin).
#
# ---------------------------------------------------------------------------
# PUBLIC API
# ---------------------------------------------------------------------------
#   signal region_sprouting(index:int, pos:Vector2, region_seed:int)  # bloom begins
#   signal region_bloomed  (index:int, pos:Vector2, region_seed:int, half_width:float, node:ProcNode)
#   signal bounds_changed  (bounds:Rect2)      # camera-clamp should grow to fit
#
#   func setup(world_seed:int, world_layer:Node2D, origin:Vector2 = Vector2.ZERO,
#              opts:Dictionary = {}) -> void
#        opts: realm:String, first_delay_min:float, growth:float (geometric spacing),
#              spacing:float (px step), fresh_window_sec:float, bloom_seconds:float,
#              max_regions:int, auto:bool (time-driven on/off), start_index:int
#
#   func world_age_seconds() -> float           # now − genesis (persisted)
#   func regions_due(age := -1.0) -> int         # how many regions should exist by `age`
#   func region_seed(i:int) -> int
#   func region_position(i:int) -> Vector2       # world-space, relative to origin
#   func region_half_width(i:int) -> float
#   func region_bloom_age(i:int) -> float        # world-age (sec) at which region i matures
#   func region_realm(i:int) -> String
#   func time_until_next() -> float              # seconds until the next region is due (−1 if none)
#   func force_bloom_next() -> int               # puzzle reward: wake the next region NOW (−1 if none)
#   func current_bounds() -> Rect2               # origin + every bloomed region (+ margin)
#   func bloomed_count() -> int
#   func region_node(i:int) -> ProcNode          # the live node for a bloomed region (or null)
#
# See the INTEGRATION NOTE for how Main wires this up.

signal region_sprouting(index: int, pos: Vector2, region_seed: int)
signal region_bloomed(index: int, pos: Vector2, region_seed: int, half_width: float, node: ProcNode)
signal bounds_changed(bounds: Rect2)

# ---- tuning (all overridable through setup() opts) --------------------------
const DEF_FIRST_DELAY_MIN := 90.0      # the first new region wakes ~1.5h after genesis
const DEF_GROWTH := 1.5                # each region takes this much longer than the last
const DEF_SPACING := 360.0            # world-px step of the outward spiral
const DEF_FRESH_WINDOW := 1800.0      # if a region matured within this many sec, animate its bloom
const DEF_BLOOM_SECONDS := 6.5        # how long a fresh bloom takes to unfurl on screen
const DEF_MAX_REGIONS := 64           # a generous, effectively-limitless ceiling
const GOLDEN := 2.3999632297286       # golden angle — a pleasing, non-repeating spiral

# ---- state ------------------------------------------------------------------
var world_seed := 0
var _layer: Node2D = null
var _origin := Vector2.ZERO
var _realm := "verdant"

var _first_delay := DEF_FIRST_DELAY_MIN * 60.0
var _growth := DEF_GROWTH
var _spacing := DEF_SPACING
var _fresh_window := DEF_FRESH_WINDOW
var _bloom_seconds := DEF_BLOOM_SECONDS
var _max_regions := DEF_MAX_REGIONS
var _auto := true

var _spawned := 0                      # how many regions are already placed
var _nodes: Dictionary = {}            # index -> ProcNode
var _bounds := Rect2()
var _setup_done := false
var _poll := 0.0                       # throttle the due-check

# =============================================================================
# SETUP
# =============================================================================

func setup(p_world_seed: int, world_layer: Node2D, origin: Vector2 = Vector2.ZERO, opts: Dictionary = {}) -> void:
	world_seed = p_world_seed
	_layer = world_layer
	_origin = origin
	_realm = String(opts.get("realm", _current_realm()))
	_first_delay = float(opts.get("first_delay_min", DEF_FIRST_DELAY_MIN)) * 60.0
	_growth = maxf(1.05, float(opts.get("growth", DEF_GROWTH)))
	_spacing = float(opts.get("spacing", DEF_SPACING))
	_fresh_window = float(opts.get("fresh_window_sec", DEF_FRESH_WINDOW))
	_bloom_seconds = float(opts.get("bloom_seconds", DEF_BLOOM_SECONDS))
	_max_regions = int(opts.get("max_regions", DEF_MAX_REGIONS))
	_auto = bool(opts.get("auto", true))
	_spawned = int(opts.get("start_index", 0))

	# Make sure a genesis timestamp exists so the age clock is honest even if the
	# intro screen was skipped in some flow.
	_ensure_genesis()

	# The origin island establishes the initial bounds.
	_bounds = Rect2(_origin, Vector2.ZERO).grow(_spacing * 0.5)

	# Catch up: every region that should already have matured (while away, or on a
	# returning save) is placed immediately, fully grown — no cinematic for old land.
	var due := regions_due()
	for i in range(_spawned, due):
		_bloom(i, false)
	_setup_done = true
	_emit_bounds()
	set_process(_auto)

func _ensure_genesis() -> void:
	if Game and typeof(Game.state) == TYPE_DICTIONARY and not Game.state.has(StartJourney.K_GENESIS):
		Game.state[StartJourney.K_GENESIS] = Time.get_unix_time_from_system()

func _current_realm() -> String:
	if Game and typeof(Game.state) == TYPE_DICTIONARY:
		return String(Game.state.get("realm", "verdant"))
	return "verdant"

# =============================================================================
# TIME / SCHEDULE  (pure functions of the origin seed)
# =============================================================================

func genesis_unix() -> float:
	if Game and typeof(Game.state) == TYPE_DICTIONARY and Game.state.has(StartJourney.K_GENESIS):
		return float(Game.state[StartJourney.K_GENESIS])
	return Time.get_unix_time_from_system()

func world_age_seconds() -> float:
	return maxf(0.0, Time.get_unix_time_from_system() - genesis_unix())

# The wall-clock age at which region i matures. Region 0 is the next new land after
# the origin; each subsequent region takes `_growth`× longer than the previous gap,
# so land arrives often at first and then, pleasingly, rarer and grander. A small
# seeded jitter keeps the cadence from feeling mechanical.
func region_bloom_age(i: int) -> float:
	if i < 0:
		return 0.0
	var age := 0.0
	var gap := _first_delay
	for k in range(i + 1):
		var jitter := 0.85 + 0.3 * Proc.hashf(world_seed, "rgap:%d" % k)
		age += gap * jitter
		gap *= _growth
	return age

func regions_due(age := -1.0) -> int:
	var a := age if age >= 0.0 else world_age_seconds()
	var n := 0
	while n < _max_regions and region_bloom_age(n) <= a:
		n += 1
	return n

func time_until_next() -> float:
	if _spawned >= _max_regions:
		return -1.0
	return maxf(0.0, region_bloom_age(_spawned) - world_age_seconds())

# =============================================================================
# LAYOUT  (pure functions of the origin seed)
# =============================================================================

func region_seed(i: int) -> int:
	return int(hash("%d:region:%d" % [world_seed, i]) & 0x7FFFFFFF)

# An outward golden-angle spiral, jittered, so regions ring the origin without ever
# overlapping and without repeating a pattern — a growing archipelago.
func region_position(i: int) -> Vector2:
	var rs := region_seed(i)
	var ang := GOLDEN * float(i + 1) + Proc.rangef(rs, "ang", -0.35, 0.35)
	# distance grows ~sqrt(i) for an even areal spread, nudged by seed
	var dist := _spacing * (1.15 + sqrt(float(i + 1)) * 0.92) * Proc.rangef(rs, "dist", 0.9, 1.18)
	# gently flatten vertically — the world is wider than it is tall (portrait camera)
	return _origin + Vector2(cos(ang) * dist, sin(ang) * dist * 0.62)

func region_half_width(i: int) -> float:
	var rs := region_seed(i)
	# nearer regions are smaller stepping-stones; farther regions can be grand.
	var base := lerpf(120.0, 280.0, clampf(float(i) / 10.0, 0.0, 1.0))
	return base * Proc.rangef(rs, "hw", 0.82, 1.3)

func region_realm(i: int) -> String:
	# Stay in the player's current realm for near regions; let distant land
	# occasionally take a neighbouring realm's flavour for variety (cosmetic only).
	var rs := region_seed(i)
	if i < 3 or Proc.hashf(rs, "realmroll") < 0.7:
		return _realm
	var realms: Array = GameData.realms if GameData else []
	if realms.is_empty():
		return _realm
	var rd: Dictionary = realms[int(Proc.hashf(rs, "realmpick") * realms.size()) % realms.size()]
	return String(rd.get("id", _realm))

# =============================================================================
# BLOOM
# =============================================================================

func _process(delta: float) -> void:
	if not _setup_done or not _auto:
		return
	_poll += delta
	if _poll < 1.0:                     # the world grows slowly; once a second is plenty
		return
	_poll = 0.0
	var due := regions_due()
	while _spawned < due:
		_bloom(_spawned, true)          # these just matured → animate the unfurl

# Stage region `i`. `animate` true => it matured recently (or by puzzle), so unfurl it
# live; false => it matured long ago (offline / returning), so it is simply already here.
func _bloom(i: int, animate: bool) -> void:
	if i < _spawned:
		return
	if _nodes.has(i):
		return
	var rs := region_seed(i)
	var pos := region_position(i)
	var hw := region_half_width(i)
	var realm := region_realm(i)

	var node: ProcNode = ProcTerrain.make(world_seed, "region:%d" % i, hw, realm, _lod_for(i))
	node.position = pos
	# Sort so farther/ newer land tucks behind nearer land a touch.
	node.z_index = -2 - (i % 6)
	if _layer:
		_layer.add_child(node)
	_nodes[i] = node
	_spawned = max(_spawned, i + 1)

	if animate:
		node.growth = 0.0
		node.modulate.a = 0.0
		emit_signal("region_sprouting", i, pos, rs)
		_spawn_birth_fx(pos, hw)
		var tw := create_tween()
		tw.tween_property(node, "modulate:a", 1.0, 1.2)
		node.grow_to(1.0, _bloom_seconds)
		tw.chain().tween_interval(_bloom_seconds * 0.7)
		tw.tween_callback(func(): emit_signal("region_bloomed", i, pos, rs, hw, node))
	else:
		node.set_growth(1.0)              # ancient land, already standing
		emit_signal("region_bloomed", i, pos, rs, hw, node)

	_grow_bounds(pos, hw)
	_emit_bounds()

func _lod_for(i: int) -> int:
	# Near land full detail; distant land lighter for performance.
	if i < 4:
		return 0
	if i < 12:
		return 1
	return 2

func _spawn_birth_fx(pos: Vector2, hw: float) -> void:
	if _layer == null:
		return
	var fx := ProcEffects.make_world_birth(world_seed, "regionfx:%d" % _spawned, {
		"radius": hw * 1.4, "life": 2.6, "z": 30, "realm": _realm,
	})
	fx.position = pos
	_layer.add_child(fx)

# The puzzle layer's accelerator: wake the next scheduled region immediately, with a
# full live bloom, regardless of its time-of-maturity. Returns the index (−1 if maxed).
func force_bloom_next() -> int:
	if not _setup_done or _spawned >= _max_regions:
		return -1
	var i := _spawned
	_bloom(i, true)
	return i

# =============================================================================
# BOUNDS  (for the camera clamp to grow with the world, IDLE-DESIGN §2.5)
# =============================================================================

func _grow_bounds(pos: Vector2, hw: float) -> void:
	var r := Rect2(pos - Vector2(hw, hw), Vector2(hw, hw) * 2.0)
	_bounds = _bounds.merge(r) if _bounds.size != Vector2.ZERO else r

func current_bounds() -> Rect2:
	# a soft margin so there is always "just beyond the edge" to pan into
	return _bounds.grow(_spacing * 0.75)

func _emit_bounds() -> void:
	emit_signal("bounds_changed", current_bounds())

# =============================================================================
# QUERIES
# =============================================================================

func bloomed_count() -> int:
	return _spawned

func region_node(i: int) -> ProcNode:
	return _nodes.get(i, null)

# A human whisper for when a region wakes (diegetic, IDLE-DESIGN §2.6) — optional.
func region_whisper(i: int) -> String:
	var rs := region_seed(i)
	var openers := ["New land breaks the mist.", "The world remembers more of itself.",
		"An island rises at the edge.", "Something green wakes offshore.",
		"The sea gives back a little ground."]
	return String(openers[int(Proc.hashf(rs, "whisper") * openers.size()) % openers.size()])
