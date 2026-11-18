extends Control
# Main — the menu-less composition root of Blockle Idle.
#
# The game is one living, procedurally-generated world (see docs/IDLE-DESIGN.md):
# no nav bar, no tabs, no slide-up panels, no modal menus. The ONLY menu is the
# bottom inventory tray, owned by Interact. Interaction is diegetic — you drag
# things out of the basket into the world, tap placed things for a floating
# action, pan around a softly-bounded world, and watch everything grow —
# continuously and very slowly — from the seed phrase you answered at the start.
#
# Main therefore does almost nothing: it gates first-boot through StartJourney
# ("Where do you start your journey?"), then mounts:
#   - Interact        — the whole world + the one tray + gestures (self-booting)
#   - IdleSim         — the idle-simulation loop (producers -> drifting motes)
#   - PuzzleSystem    — the in-world seeded puzzles (growth/expansion rewards)
# and wires them together. All visuals are math (scripts/proc/*) — no images.

var _journey: StartJourney
var _interact: Interact
var _sim: IdleSim
var _puzzles: PuzzleSystem
var _world_up := false

func _ready() -> void:
	# CRITICAL: Main is a full-rect Control; with the default STOP filter it would
	# consume every touch and Interact's _unhandled_input (pan/tap/pick-up) would
	# never fire. The world must see the input; UI children still hit-test fine.
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	# Game (autoload) boots itself deferred; wait for it before deciding the path.
	if Game.booted:
		_route()
	else:
		Game.state_dirty.connect(_route, CONNECT_ONE_SHOT)

func _route() -> void:
	if StartJourney.needs_intro():
		_journey = StartJourney.attach(self)
		_journey.world_ready.connect(func(_seed: int):
			StartJourney.mark_done()
			_enter_world()
			if is_instance_valid(_journey):
				_journey.queue_free()
			_journey = null
		)
	else:
		_enter_world()

# ---- the living world --------------------------------------------------------

func _enter_world() -> void:
	if _world_up:
		return
	_world_up = true

	_interact = Interact.new()
	_interact.world_booted.connect(_wire_world, CONNECT_ONE_SHOT)
	add_child(_interact)
	move_child(_interact, 0)

# Once Interact's world is live, mount the idle loop + puzzles onto it.
func _wire_world() -> void:
	if OS.get_environment("NO_WIRE") == "1":
		return
	var space := _interact.space()
	if space == null:
		return
	var ws: int = int(Game.state.get("world_seed", 1))

	# Idle simulation: producers shed motes that drift to the Heart Tree's roots.
	if OS.get_environment("NO_SIM") == "1":
		_wire_puzzles(space, ws)
		return
	_sim = IdleSim.make(ws)
	space.cam_node().add_child(_sim)
	if is_instance_valid(space.heart_node()):
		_sim.set_heart(space.heart_node())
	_sim.set_collect_target(space.cam_node(), space.heart_foot())

	# Register everything already living in the world, and keep registering as
	# things are planted (entities carry their spec in meta, set by placement).
	for e in space.entity_layer().get_children():
		if e is ProcNode:
			_register_producer(e)
	space.entity_layer().child_entered_tree.connect(func(n: Node):
		if n is ProcNode:
			_register_producer(n)
	)

	if OS.get_environment("NO_PUZZLES") == "1":
		return
	_wire_puzzles(space, ws)

func _wire_puzzles(space: WorldSpace, ws: int) -> void:
	# In-world puzzles, seeded, standing on real ground.
	_puzzles = PuzzleSystem.new()
	space.cam_node().add_child(_puzzles)
	_puzzles.setup(ws, {
		"realm_id": String(Game.state.get("realm", "verdant")),
		"ground_sampler": func(x: float) -> float:
			return space.snap_ground(Vector2(x, 0.0)).y,
		"palette": Proc.palette(ws),
		"expansion_level": int(Game.state.get("expansion_level", 0)),
	})
	_puzzles.generate_default()
	_puzzles.puzzle_solved.connect(_on_puzzle_solved)
	_puzzles.land_expanded.connect(func(_pos: Vector2, _radius: float):
		Game.state["expansion_level"] = int(Game.state.get("expansion_level", 0)) + 1
		Game.emit_signal("state_dirty")
	)

func _register_producer(e: ProcNode) -> void:
	if _sim == null or not is_instance_valid(e):
		return
	var spec: Dictionary = {}
	if e.has_meta("spec"):
		var m = e.get_meta("spec")
		if m is Dictionary:
			spec = m
	_sim.register(e, spec)

func _on_puzzle_solved(_id: String, reward: Dictionary) -> void:
	for res in reward.keys():
		var amt = reward[res]
		if (amt is float or amt is int) and Game.has_method("add_resource"):
			Game.add_resource(String(res), float(amt))
