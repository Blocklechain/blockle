class_name WorldStage
extends Node2D
# ===========================================================================
#  WorldStage — the living world scene for Blockle Idle.
#
#  One calm, gorgeous, portrait screen (docs/IDLE-DESIGN.md §6): a procedural
#  sky breathing overhead, a floating island shaped by your opening sentence,
#  the Heart Tree at its core, Blocklings wandering, trees you planted this
#  morning a little taller than they were. WorldStage is the *stage* that all
#  of that stands on — it does NOT draw anything itself (every pixel comes from
#  the Proc* art modules); it COMPOSES them into one coherent, depth-sorted,
#  day-lit, thumb-draggable place and exposes the handful of verbs the rest of
#  the game needs.
#
#  What it owns & wires together:
#    • ProcSky            — a screen-fixed backdrop (its own CanvasLayer) whose
#                           slow day↔dusk↔night cycle drives the world's light.
#    • ProcTerrain        — the hero island (ground queries) + a parallax shelf
#                           of distant islets in a ParallaxBackground.
#    • ProcWater          — ponds / streams placed on the land as features.
#    • ProcHeartTree      — the luminous centre + the essence root-pool anchor.
#    • entities           — any ProcNode (trees, creatures, buildings, decor,
#                           crystals, plants) placed on the surface, FEET-at
#                           -origin, depth-sorted by a built-in Y-sort layer.
#    • WorldCamera        — inertial drag-pan, soft rubber-band clamp to the
#                           modest world bounds, tight optional pinch-zoom.
#    • GroundPlacement    — snap-to-ground, land/water gating, footprint tests,
#                           and the §2.3a adaptation Context.
#
#  Collaborators (IdleSim, GrowthState, PuzzleSystem, ItemCatalog) are OPTIONAL
#  and plug in through `attach_*`; WorldStage duck-types them so it never breaks
#  if their APIs drift. Everything obeys CONVENTIONS: seeded + limitless, alive,
#  performant (camera transform + child animation do the work; no per-frame
#  allocation here, no redraw).
# ===========================================================================

signal whisper(text: String, world_pos: Vector2)   # §2.6 diegetic one-liners, relayed
signal entity_added(node: Node2D)
signal entity_removed(node: Node2D)
signal land_grew(world_rect: Rect2)                 # a Rootwork reward unfurled new ground
signal ground_awoke(world_rect: Rect2)              # a Lightweave dell became plantable
signal day_phase_changed(time_of_day: float)        # crosses dawn/noon/dusk/midnight
signal tapped_world(world_pos: Vector2)             # an un-consumed tap on empty world

# ---- config ----------------------------------------------------------------
@export var handle_own_input: bool = true           # false → Main drives pan via the API
@export var day_minutes: float = 28.0               # one full sky cycle
@export var auto_day_cycle: bool = true

# ---- identity ---------------------------------------------------------------
var world_seed: int = 1
var realm_id: String = "verdant"
var view_size: Vector2 = Vector2(1080, 1920)

# ---- scene graph ------------------------------------------------------------
var sky_layer: CanvasLayer                          # layer -200, screen-fixed
var sky: ProcNode                                   # ProcSky _Sky
var bg: ParallaxBackground                           # layer -100, auto-parallax
var far_layer: ParallaxLayer
var mid_layer: ParallaxLayer
var camera: WorldCamera
var root: Node2D                                    # world content (factor 1)
var terrain: ProcNode                               # the hero island
var water_layer: Node2D
var ysort: Node2D                                   # entities + ponds, feet Y-sort
var puzzle_host: Node2D
var fx_layer: Node2D
var heart: ProcNode

# ---- placement + bounds -----------------------------------------------------
var place: GroundPlacement
var world_rect: Rect2 = Rect2(-540, -960, 1080, 1920)
var ground_y: float = 0.0                           # surface height at island centre
var _bounds_accum: float = 0.0

# ---- day/night --------------------------------------------------------------
var _world_tint: Color = Color.WHITE
var _ambient: Color = Color.WHITE
var _light_dir: Vector2 = Vector2(-0.28, -1.0)
var _light_point: Vector2 = Vector2(0, -600)
var _last_tod: float = -1.0
var _last_phase: int = -1
var _backdrops: Array = []                          # islet nodes to co-tint at dusk/night

# ---- entities ---------------------------------------------------------------
var _entities: Array = []                           # [{node, ground, key}]
var _ent_n: int = 0

# ---- optional collaborators -------------------------------------------------
var sim: Node = null          # IdleSim
var growth: Node = null       # GrowthState
var puzzles: Node = null      # PuzzleSystem
var catalog_adapt: Callable = Callable()

# ---- input state ------------------------------------------------------------
var _touches: Dictionary = {}       # index -> screen pos (active fingers)
var _pan_id: int = -1               # which finger is panning (-1 = mouse / none)
var _pinch_dist: float = 0.0
var _mouse_down: bool = false
var _down_pos: Vector2 = Vector2.ZERO
var _moved: float = 0.0


# ===========================================================================
#  construction
# ===========================================================================

static func make(seed_value: int, realm: String = "verdant", view: Vector2 = Vector2(1080, 1920)) -> WorldStage:
	var w := WorldStage.new()
	w.world_seed = seed_value
	w.realm_id = realm
	w.view_size = view
	w.name = "WorldStage"
	return w


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	if get_viewport():
		view_size = get_viewport().get_visible_rect().size
	build()


# Build (or rebuild) the whole stage. Safe to call once from _ready, or after a
# `set_world` change. Idempotent-ish: tears down a previous build first.
func build() -> void:
	_teardown()
	_world_tint = _player_tint()

	# --- sky: screen-fixed backdrop in its own canvas layer -----------------
	sky_layer = CanvasLayer.new()
	sky_layer.layer = -200
	add_child(sky_layer)
	sky = ProcSky.make_for_realm(world_seed, realm_id, view_size,
		{"time_of_day": 0.32, "day_minutes": day_minutes, "auto_advance": auto_day_cycle})
	sky_layer.add_child(sky)
	if sky.has_method("set_auto_advance"):
		sky.set_auto_advance(auto_day_cycle, day_minutes)

	# --- parallax backdrop shelf (distant islets) ---------------------------
	bg = ParallaxBackground.new()
	bg.layer = -100
	add_child(bg)
	far_layer = ParallaxLayer.new()
	far_layer.motion_scale = Vector2(0.32, 0.32)
	bg.add_child(far_layer)
	mid_layer = ParallaxLayer.new()
	mid_layer.motion_scale = Vector2(0.6, 0.6)
	bg.add_child(mid_layer)
	_build_backdrops()

	# --- world content (factor 1) -------------------------------------------
	root = Node2D.new()
	root.name = "WorldRoot"
	add_child(root)

	terrain = ProcTerrain.make(world_seed, "home", _island_half_width(), realm_id, 0)
	terrain.position = Vector2.ZERO            # island feet-centre is the world origin
	root.add_child(terrain)

	water_layer = Node2D.new()
	water_layer.name = "Water"
	root.add_child(water_layer)

	ysort = Node2D.new()
	ysort.name = "Entities"
	ysort.y_sort_enabled = true                # feet-at-origin → perfect depth sort
	root.add_child(ysort)

	puzzle_host = Node2D.new()
	puzzle_host.name = "Puzzles"
	root.add_child(puzzle_host)

	fx_layer = Node2D.new()
	fx_layer.name = "FX"
	root.add_child(fx_layer)

	# --- ground helper + bounds ---------------------------------------------
	place = GroundPlacement.make(terrain, root, world_seed, realm_id)
	ground_y = place.surface_y(0.0)
	_recompute_bounds()

	# --- heart tree: the luminous centrepiece -------------------------------
	heart = ProcHeartTree.make_for_realm(world_seed, "heart", realm_id)
	heart.position = place.surface_point(0.0)
	ysort.add_child(heart)

	# --- camera -------------------------------------------------------------
	camera = WorldCamera.new()
	camera.name = "WorldCamera"
	camera.set_view_size(view_size)
	add_child(camera)
	camera.set_world_rect(world_rect)
	camera.set_input_enabled(true)
	camera.focus(Vector2(0.0, ground_y - view_size.y * 0.10), true)

	# first light
	_update_day_night(true)


func _teardown() -> void:
	for c in [sky_layer, bg, root, camera]:
		if c and is_instance_valid(c):
			c.queue_free()
	_entities.clear()
	_backdrops.clear()
	_touches.clear()


# ===========================================================================
#  per-frame: camera parallax feed, bounds re-sync, day/night light
# ===========================================================================

func _process(delta: float) -> void:
	# feed the camera offset into the sky so its cloud layers drift with the pan
	if sky and camera and sky.has_method("set_parallax"):
		sky.set_parallax(camera.position)

	# keep the clamp box in step with a world that may be growing (land tween)
	_bounds_accum += delta
	if _bounds_accum >= 0.4:
		_bounds_accum = 0.0
		_recompute_bounds()
		if camera:
			camera.set_world_rect(world_rect)

	# the sky owns the clock; we READ it and relight the world
	_update_day_night(false)


# ===========================================================================
#  day / night  (light read from ProcSky, applied as a cheap ambient grade)
# ===========================================================================

func _update_day_night(force: bool) -> void:
	if sky == null or not sky.has_method("get_time_of_day"):
		return
	var tod: float = sky.get_time_of_day()
	if not force and absf(tod - _last_tod) < 0.002:
		return
	_last_tod = tod

	# daylight 0 (midnight) .. 1 (noon); duskness peaks at dawn/dusk transitions
	var daylight: float = 0.5 - 0.5 * cos(tod * TAU)
	var duskness: float = clampf(1.0 - absf(daylight - 0.5) * 2.0, 0.0, 1.0)

	var night_col := Color(0.46, 0.54, 0.76)
	var day_col := Color(1.0, 1.0, 1.0)
	_ambient = night_col.lerp(day_col, daylight)
	_ambient = _ambient.lerp(Color(1.08, 0.92, 0.78), duskness * 0.22)   # warm horizon

	# apply to world content + co-tint the distant islets (separate canvas layer)
	var m := Color(_world_tint.r * _ambient.r, _world_tint.g * _ambient.g,
		_world_tint.b * _ambient.b, 1.0)
	if root:
		root.modulate = m
	var bm := night_col.lerp(day_col, clampf(daylight + 0.12, 0.0, 1.0))
	for isl in _backdrops:
		if is_instance_valid(isl):
			var haze: float = 1.0
			if "haze" in isl:
				haze = 1.0 - float(isl.haze) * 0.4
			isl.modulate = Color(bm.r, bm.g, bm.b, haze)

	# light direction: toward the sun by day, up-from-the-Heart by night
	var sun_a: float = (tod - 0.25) / 0.5           # 0 dawn .. 1 dusk across the day
	var sun_x: float = lerpf(-1.0, 1.0, clampf(sun_a, 0.0, 1.0))
	var sun_h: float = sin(clampf(sun_a, 0.0, 1.0) * PI)
	if daylight > 0.14:
		_light_dir = Vector2(sun_x * (0.5 - 0.3 * sun_h), -(0.45 + 0.55 * sun_h)).normalized()
		_light_point = Vector2(sun_x * view_size.x * 0.6, ground_y - view_size.y * 0.9)
	else:
		_light_dir = Vector2(0.0, -1.0)
		if is_instance_valid(heart):
			_light_point = heart.position + Vector2(0, -260.0)

	# announce crossing a quarter-phase (for ambient audio / weather hooks elsewhere)
	var phase := int(floor(fposmod(tod, 1.0) * 4.0)) % 4
	if phase != _last_phase:
		_last_phase = phase
		emit_signal("day_phase_changed", tod)


func current_light_dir() -> Vector2:
	return _light_dir

func daylight() -> float:
	if sky and sky.has_method("get_time_of_day"):
		return 0.5 - 0.5 * cos(sky.get_time_of_day() * TAU)
	return 1.0


# ===========================================================================
#  world bounds  (the modest, growing clamp box — §2.5)
# ===========================================================================

func _recompute_bounds() -> void:
	if place == null:
		return
	var e := place.extents()
	# the surface band the island occupies
	var top := place.surface_y(0.0) - view_size.y * 0.52     # sky headroom above
	var keel := place.surface_y(0.0) + view_size.y * 0.62    # room to see the roots below
	var margin_x: float = view_size.x * 0.30                 # "just beyond the edge"
	var left: float = min(e.x - margin_x, -view_size.x * 0.5)
	var right: float = max(e.y + margin_x, view_size.x * 0.5)
	# guarantee at least a viewport in each axis so the camera always has slack
	if right - left < view_size.x:
		var cx := (left + right) * 0.5
		left = cx - view_size.x * 0.5
		right = cx + view_size.x * 0.5
	if keel - top < view_size.y:
		var cy := (top + keel) * 0.5
		top = cy - view_size.y * 0.5
		keel = cy + view_size.y * 0.5
	var nr := Rect2(left, top, right - left, keel - top)
	if not nr.is_equal_approx(world_rect):
		world_rect = nr


func world_bounds() -> Rect2:
	return world_rect


func visible_bounds() -> Rect2:
	if camera:
		return camera.visible_world_rect()
	return world_rect


# ===========================================================================
#  ENTITIES  (the public placement API — add / remove / ground helpers)
# ===========================================================================

# Place any ProcNode on the world. `opts`:
#   ground        : "land" | "water" | "level"      (gating + snap target)
#   context       : a prebuilt §2.3a Context (else one is built here)
#   no_snap       : true to place at the raw world_pos (e.g. floating things)
#   pop           : true → pop_in() unfurl from a seed (default true)
#   grow_minutes  : retune this instance's growth pace
#   register_sim  : IdleSim spec dict (if a sim is attached)
#   register_growth : GrowthState spec dict (if growth is attached)
# Returns the node (now parented + living), or null if invalid ground.
func add_entity(node: ProcNode, world_pos: Vector2, opts: Dictionary = {}) -> ProcNode:
	if node == null:
		return null
	var ground: String = String(opts.get("ground", "land"))
	var pos := world_pos
	if not bool(opts.get("no_snap", false)):
		pos = place.snap(world_pos, "water" if ground == "water" else "land")

	# build + apply the adaptation context (local palette, light, nestle…)
	var ctx: Dictionary = opts.get("context", {})
	if ctx.is_empty():
		ctx = place.build_context(pos, _light_dir, {"light_point": _light_point})
	_apply_context(node, ctx)

	if opts.has("grow_minutes") and node.has_method("set_grow_minutes"):
		node.set_grow_minutes(float(opts["grow_minutes"]))

	node.position = pos
	ysort.add_child(node)

	_ent_n += 1
	var key := String(opts.get("key", "ent:%d" % _ent_n))
	_entities.append({"node": node, "ground": ground, "key": key})
	place.register_occupant(node, pos, ground)

	# register with the idle economy + growth persistence if those are attached
	if sim and opts.has("register_sim"):
		_register_sim(node, opts["register_sim"])
	if growth and opts.has("register_growth"):
		_register_growth(node, opts["register_growth"])

	# unfurl from a seed unless told otherwise (minted re-places pass pop:false)
	if bool(opts.get("pop", true)) and node.has_method("pop_in"):
		node.pop_in(float(opts.get("pop_dur", 1.0)))

	emit_signal("entity_added", node)
	return node


func remove_entity(node: ProcNode) -> void:
	if node == null:
		return
	for i in range(_entities.size() - 1, -1, -1):
		if _entities[i]["node"] == node:
			_entities.remove_at(i)
	place.unregister_occupant(node)
	if sim and sim.has_method("unregister"):
		sim.unregister(node)
	emit_signal("entity_removed", node)
	if is_instance_valid(node):
		node.queue_free()


# Uproot into the tray WITHOUT losing age: detach but keep growth (the caller /
# GrowthState snapshots it). Returns the node, now orphaned.
func detach_entity(node: ProcNode) -> ProcNode:
	for i in range(_entities.size() - 1, -1, -1):
		if _entities[i]["node"] == node:
			_entities.remove_at(i)
	place.unregister_occupant(node)
	if sim and sim.has_method("unregister"):
		sim.unregister(node)
	if node.get_parent():
		node.get_parent().remove_child(node)
	emit_signal("entity_removed", node)
	return node


func entities() -> Array:
	var out: Array = []
	for e in _entities:
		if is_instance_valid(e["node"]):
			out.append(e["node"])
	return out


# ---- ground-placement helpers (pass-throughs for the placement/ghost agent) -

func ground_point(world_x: float) -> Vector2:
	return place.surface_point(world_x)

func ground_normal(world_x: float) -> Vector2:
	return place.surface_normal(world_x)

func snap_to_ground(world_pos: Vector2, ground: String = "land") -> Vector2:
	return place.snap(world_pos, "water" if ground == "water" else "land")

func can_place(world_pos: Vector2, ground: String = "land", radius: float = -1.0) -> bool:
	return place.can_place(world_pos, ground, radius)

func ground_type_at(world_pos: Vector2) -> String:
	return place.ground_type_at(world_pos)

func make_context(world_pos: Vector2, extra: Dictionary = {}) -> Dictionary:
	var ex := extra.duplicate()
	if not ex.has("light_point"):
		ex["light_point"] = _light_point
	return place.build_context(world_pos, _light_dir, ex)

func ground_sampler() -> Callable:
	return place.sampler()


# ===========================================================================
#  convenience spawners  (seeded, context-aware — the common planting verbs)
# ===========================================================================

func spawn_tree(world_x: float, species: String = "", opts: Dictionary = {}) -> ProcNode:
	var pos := place.surface_point(world_x)
	var ctx := make_context(pos)
	var node: ProcNode
	if species == "":
		node = ProcTrees.make_for_realm(world_seed, _ekey("tree"), realm_id)
	else:
		node = ProcTrees.make(world_seed, _ekey("tree"), species)
	var o := opts.duplicate()
	o["context"] = ctx
	o["ground"] = "land"
	return add_entity(node, pos, o)


func spawn_creature(world_x: float, blockling_id: String = "", opts: Dictionary = {}) -> ProcNode:
	var pos := place.surface_point(world_x)
	var ctx := make_context(pos)
	var node := ProcCreatures.make(world_seed, _ekey("kin"), blockling_id, ctx)
	var o := opts.duplicate()
	o["context"] = ctx
	o["ground"] = "land"
	return add_entity(node, pos, o)


func spawn_building(world_x: float, building_id: String, opts: Dictionary = {}) -> ProcNode:
	var pos := place.snap(Vector2(world_x, 0.0), "land")
	var ctx := make_context(pos, {"building": true})
	var node := ProcBuildings.make(world_seed, _ekey("bld"), building_id, realm_id)
	var o := opts.duplicate()
	o["context"] = ctx
	o["ground"] = "level"
	return add_entity(node, pos, o)


func spawn_plant(world_x: float, species: String = "flower", opts: Dictionary = {}) -> ProcNode:
	var pos := place.surface_point(world_x)
	var ctx := make_context(pos)
	var node := ProcPlants.make(world_seed, _ekey("plant"), species, ctx)
	var o := opts.duplicate()
	o["context"] = ctx
	return add_entity(node, pos, o)


func spawn_decoration(world_x: float, type_id: String, opts: Dictionary = {}) -> ProcNode:
	var pos := place.surface_point(world_x)
	var ctx := make_context(pos)
	var node := ProcDecor.make(world_seed, _ekey("decor"), type_id, ctx)
	var o := opts.duplicate()
	o["context"] = ctx
	return add_entity(node, pos, o)


func spawn_crystal(world_x: float, species: String = "crystal", opts: Dictionary = {}) -> ProcNode:
	var pos := place.surface_point(world_x)
	var ctx := make_context(pos)
	var node := ProcFungiCrystals.make_crystal(world_seed, _ekey("xtl"), species, ctx)
	var o := opts.duplicate()
	o["context"] = ctx
	return add_entity(node, pos, o)


func spawn_fungus(world_x: float, species: String = "mushroom", opts: Dictionary = {}) -> ProcNode:
	var pos := place.surface_point(world_x)
	var ctx := make_context(pos)
	var node := ProcFungiCrystals.make_fungus(world_seed, _ekey("fungus"), species, ctx)
	var o := opts.duplicate()
	o["context"] = ctx
	return add_entity(node, pos, o)


# A water feature sits on the land as its own little ecosystem; register it so
# land plants reject it and lilies/reeds snap onto it.
func spawn_water(world_x: float, kind: String = "pond", opts: Dictionary = {}) -> ProcNode:
	var pos := place.surface_point(world_x)
	var node := ProcWater.make(world_seed, _ekey("water"), kind,
		{"realm_id": realm_id})
	node.position = pos
	water_layer.add_child(node)
	var r: float = 120.0
	if "footprint_radius" in node and float(node.footprint_radius) > 0.0:
		r = float(node.footprint_radius)
	place.register_water(node, pos, r)
	if bool(opts.get("pop", true)) and node.has_method("pop_in"):
		node.pop_in(1.2)
	emit_signal("entity_added", node)
	return node


func _ekey(prefix: String) -> String:
	_ent_n += 1
	return "%s:%d" % [prefix, _ent_n]


# ===========================================================================
#  LAND EXPANSION  (Rootwork reward) + GROUND AWAKENING (Lightweave reward)
# ===========================================================================

# Unfurl a new patch of island toward `world_pos`, growing the camera clamp with
# it (§3.2 / §4.3). Returns when the region tween has been kicked off.
func expand_land(world_pos: Vector2, radius: float = 180.0, dur: float = 6.0) -> void:
	if terrain == null or not terrain.has_method("add_region"):
		return
	var dir := 1 if world_pos.x >= 0.0 else -1
	var span: float = clampf(radius * 1.6, 120.0, 420.0)
	terrain.add_region("grow:%d" % _ent_n, dir, span, 1.0, dur)
	_ent_n += 1
	# grow the clamp immediately so the fresh edge is reachable as it blooms in
	var incl := Rect2(world_pos - Vector2(radius, radius), Vector2(radius, radius) * 2.0)
	world_rect = world_rect.merge(incl)
	if camera:
		camera.grow_world_rect(incl)
	emit_signal("land_grew", world_rect)
	whisper_at("New ground wakes at the island's edge.", world_pos)


# Mark a dell plantable (its plants may now reach growth 1.0) and bloom it.
func awaken_ground(world_rect_in: Rect2) -> void:
	if place:
		place.add_awake_rect(world_rect_in)
	emit_signal("ground_awoke", world_rect_in)
	whisper_at("Light floods the hollow; the ground wakes green.", world_rect_in.get_center())


func whisper_at(text: String, world_pos: Vector2) -> void:
	emit_signal("whisper", text, world_pos)


# ===========================================================================
#  COLLABORATORS  (optional; plugged in by Main after construction)
# ===========================================================================

func attach_idle_sim(s: Node) -> void:
	sim = s
	if sim and sim.has_method("set_heart") and is_instance_valid(heart):
		sim.set_heart(heart)
	# the essence pool gathers at the Heart Tree's roots (feet origin)
	if sim and sim.has_method("set_collect_target") and is_instance_valid(heart):
		sim.set_collect_target(heart, Vector2(0, -8))
	if sim and not sim.is_inside_tree():
		add_child(sim)


func attach_growth(g: Node) -> void:
	growth = g
	if growth and not growth.is_inside_tree():
		add_child(growth)


# Mount the puzzle layer at WorldRoot origin so puzzle-local == world coords,
# hand it the ground sampler, and relay its rewards into land/ground growth.
func attach_puzzles(p: Node) -> void:
	puzzles = p
	if puzzles and not puzzles.is_inside_tree():
		puzzle_host.add_child(puzzles)
	if puzzles and puzzles.has_method("setup"):
		puzzles.setup(world_seed, {
			"realm_id": realm_id,
			"ground_y": ground_y,
			"ground_sampler": ground_sampler(),
			"palette": Proc.palette(world_seed, realm_id),
		})
	# wire rewards → world
	if puzzles and puzzles.has_signal("land_expanded"):
		puzzles.land_expanded.connect(func(wp: Vector2, r: float): expand_land(wp, r))
	if puzzles and puzzles.has_signal("ground_awoke"):
		puzzles.ground_awoke.connect(func(rect: Rect2): awaken_ground(rect))
	if puzzles and puzzles.has_signal("whisper"):
		puzzles.whisper.connect(func(txt: String, wp: Vector2): whisper_at(txt, wp))
	if puzzles and puzzles.has_method("generate_default"):
		puzzles.generate_default()


# ItemCatalog.adapt (static) can be supplied so pre-built items re-adapt on place.
func set_adapt_fn(fn: Callable) -> void:
	catalog_adapt = fn


# ===========================================================================
#  INPUT  (drag-pan + pinch-zoom; only fires on UN-consumed world gestures)
# ===========================================================================

func _unhandled_input(event: InputEvent) -> void:
	if not handle_own_input or camera == null:
		return
	# --- touch (mobile) -----------------------------------------------------
	if event is InputEventScreenTouch:
		if event.pressed:
			_touches[event.index] = event.position
			if _touches.size() == 1:
				_pan_id = event.index
				_down_pos = event.position
				_moved = 0.0
				camera.grab(event.position)
			elif _touches.size() == 2:
				_pan_id = -1                   # two fingers → pinch, stop panning
				camera.release()
				_pinch_dist = _touch_spread()
			get_viewport().set_input_as_handled()
		else:
			_touches.erase(event.index)
			if event.index == _pan_id:
				_pan_id = -1
				camera.release()
				if _moved < 10.0:
					emit_signal("tapped_world", _screen_to_world(event.position))
			if _touches.size() == 1:
				# dropped from pinch back to a single drag
				_pan_id = _touches.keys()[0]
				camera.grab(_touches[_pan_id])
		return

	if event is InputEventScreenDrag:
		_touches[event.index] = event.position
		if _touches.size() >= 2:
			var d := _touch_spread()
			if _pinch_dist > 1.0:
				var factor := d / _pinch_dist
				camera.pinch(factor, _touch_mid())
			_pinch_dist = d
			get_viewport().set_input_as_handled()
		elif event.index == _pan_id:
			_moved += event.relative.length()
			camera.drag(event.position, get_process_delta_time())
			get_viewport().set_input_as_handled()
		return

	# --- trackpad magnify ---------------------------------------------------
	if event is InputEventMagnifyGesture:
		camera.pinch(event.factor, event.position)
		get_viewport().set_input_as_handled()
		return

	# --- mouse (editor / desktop) -------------------------------------------
	if event is InputEventMouseButton:
		if event.button_index == MOUSE_BUTTON_LEFT:
			if event.pressed:
				_mouse_down = true
				_down_pos = event.position
				_moved = 0.0
				camera.grab(event.position)
			else:
				_mouse_down = false
				camera.release()
				if _moved < 8.0:
					emit_signal("tapped_world", _screen_to_world(event.position))
			get_viewport().set_input_as_handled()
		elif event.button_index == MOUSE_BUTTON_WHEEL_UP:
			camera.wheel_zoom(0.08, event.position)
			get_viewport().set_input_as_handled()
		elif event.button_index == MOUSE_BUTTON_WHEEL_DOWN:
			camera.wheel_zoom(-0.08, event.position)
			get_viewport().set_input_as_handled()
		return

	if event is InputEventMouseMotion and _mouse_down:
		_moved += event.relative.length()
		camera.drag(event.position, get_process_delta_time())
		get_viewport().set_input_as_handled()


# ---- explicit pan API (when handle_own_input = false, Main drives these) ----
func pan_begin(screen_pos: Vector2) -> void:
	if camera: camera.grab(screen_pos)

func pan_update(screen_pos: Vector2) -> void:
	if camera: camera.drag(screen_pos, get_process_delta_time())

func pan_end() -> void:
	if camera: camera.release()

func zoom_by(factor: float, screen_focal: Vector2) -> void:
	if camera: camera.pinch(factor, screen_focal)

func focus_on(world_pos: Vector2, snap: bool = false) -> void:
	if camera: camera.focus(world_pos, snap)


func _touch_spread() -> float:
	var ks := _touches.keys()
	if ks.size() < 2:
		return 0.0
	return (_touches[ks[0]] as Vector2).distance_to(_touches[ks[1]])

func _touch_mid() -> Vector2:
	var ks := _touches.keys()
	if ks.size() < 2:
		return view_size * 0.5
	return ((_touches[ks[0]] as Vector2) + (_touches[ks[1]] as Vector2)) * 0.5


# Screen pixel → world point (for routing taps to the placement/action layer).
func screen_to_world(screen_pos: Vector2) -> Vector2:
	return _screen_to_world(screen_pos)

func _screen_to_world(screen_pos: Vector2) -> Vector2:
	if get_viewport():
		return get_viewport().get_canvas_transform().affine_inverse() * screen_pos
	return screen_pos


# ===========================================================================
#  resize / realm change
# ===========================================================================

func set_view_size(v: Vector2) -> void:
	view_size = v
	if sky and sky.has_method("set_size"):
		sky.set_size(v)
	if camera:
		camera.set_view_size(v)
	_recompute_bounds()
	if camera:
		camera.set_world_rect(world_rect)


func set_realm(new_realm: String) -> void:
	realm_id = new_realm
	if terrain and terrain.has_method("set_realm"):
		terrain.set_realm(new_realm)
	if place:
		place.realm_id = new_realm
	# rebuild the sky for the new realm's mood (keeps the current time of day)
	if sky:
		var tod: float = sky.get_time_of_day() if sky.has_method("get_time_of_day") else 0.32
		var old := sky
		sky = ProcSky.make_for_realm(world_seed, new_realm, view_size,
			{"time_of_day": tod, "day_minutes": day_minutes, "auto_advance": auto_day_cycle})
		sky_layer.add_child(sky)
		old.queue_free()
	_update_day_night(true)


func set_time_of_day(v: float) -> void:
	if sky and sky.has_method("set_time_of_day"):
		sky.set_time_of_day(v)
		_update_day_night(true)

func set_weather(w: String) -> void:
	if sky and sky.has_method("set_weather"):
		sky.set_weather(w)


# ===========================================================================
#  internals
# ===========================================================================

func _player_tint() -> Color:
	# the subtle whole-world tint unique to this save (if WorldGen is present)
	if Engine.has_singleton("WorldGen") or (get_node_or_null("/root/WorldGen") != null):
		var wg = get_node_or_null("/root/WorldGen")
		if wg and wg.has_method("world_tint"):
			return wg.world_tint()
	return Color.WHITE


func _island_half_width() -> float:
	# a gently seed-varied hero-island size (kept portrait-friendly)
	return Proc.rangef(world_seed, "stage:isl:w", 380.0, 470.0)


func _build_backdrops() -> void:
	# a seeded shelf of distant islets drifting behind the hero island
	var far_n := 3
	var mid_n := 3
	for i in range(far_n):
		var w := Proc.rangef(world_seed, "stage:far:w:%d" % i, 80.0, 150.0)
		var isl := ProcTerrain.make_islet(world_seed, "far#%d" % i, w, realm_id, 2)
		isl.position = Vector2(
			Proc.rangef(world_seed, "stage:far:x:%d" % i, -600.0, 600.0),
			Proc.rangef(world_seed, "stage:far:y:%d" % i, -380.0, 40.0))
		far_layer.add_child(isl)
		_backdrops.append(isl)
	for i in range(mid_n):
		var w := Proc.rangef(world_seed, "stage:mid:w:%d" % i, 110.0, 190.0)
		var isl := ProcTerrain.make_islet(world_seed, "mid#%d" % i, w, realm_id, 1)
		isl.position = Vector2(
			Proc.rangef(world_seed, "stage:mid:x:%d" % i, -520.0, 520.0),
			Proc.rangef(world_seed, "stage:mid:y:%d" % i, -300.0, 120.0))
		mid_layer.add_child(isl)
		_backdrops.append(isl)


func _apply_context(node: Object, ctx: Dictionary) -> void:
	if node == null:
		return
	if node.has_method("apply_context"):
		node.apply_context(ctx)
	elif "context" in node:
		node.set("context", ctx)
	if catalog_adapt.is_valid():
		catalog_adapt.call(node, ctx)


func _register_sim(node: ProcNode, spec) -> void:
	if sim == null:
		return
	if spec is Dictionary and sim.has_method("register"):
		sim.register(node, spec)
	elif spec is String and sim.has_method("register_building"):
		sim.register_building(node, spec)
	elif sim.has_method("register_tree"):
		sim.register_tree(node, {})


func _register_growth(node: ProcNode, spec) -> void:
	if growth == null:
		return
	if spec is Dictionary and growth.has_method("register_new"):
		growth.register_new(node, spec)
	elif spec is String and growth.has_method("register"):
		growth.register(node, spec, {})
