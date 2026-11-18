class_name Interact
extends Node2D
# Interact — the DIEGETIC INTERACTION controller. This single node turns the game from
# "a world behind a menu" into "a world, plus one basket." It is the one thing Main.gd
# mounts; it owns and wires together the whole menu-less interaction model of
# IDLE-DESIGN §2:
#
#   • WorldSpace   — the pannable living world (ground, Heart Tree, placed things,
#                    essence pool, diegetic motes). Everything spatial.
#   • InventoryTray — THE one menu: a bottom shelf of the living things you own.
#   • drag-ghost   — pulling a chip out of the tray lifts a live preview that follows
#                    your finger, snaps to valid ground, tints green/red, and on drop
#                    is planted and begins to grow.
#   • ActionBubble — a tap on a placed thing raises a tiny floating action pill
#                    (nurture / harvest / inspect / assign / mint / pick-up) with a
#                    glowing selection ring — no nav bar, no modal, no slide-up panel.
#   • whisper      — the entire tutorial + all status: one line of drifting text.
#
# There is NO other chrome. Panning is a drag on empty world; a tap on empty world
# dismisses; a long-press on a placed thing picks it up (preserving its growth); a tap
# on the Heart Tree pools essence. Status is the world itself (motes, the root-pool,
# ready-glows), never a HUD.
#
# INTEGRATION (see the integration note): Main.gd deletes its entire nav/tabs/panel/
# modal/coachmark/resource-bar/realm-strip stack and, after building the bare `_world`
# + sky, does:   var it := Interact.new(); _world.add_child(it)
# That is the whole hookup. Interact seeds Game.state["inventory"]/["placements"] on
# first run, restores placements on boot, and plays the offline time-lapse on wake.

const SEED_STAGE := 0.08
const PICKUP_HOLD := 0.25          # seconds of hold on a placed thing to pick it up
const PAN_SLOP := 16.0             # px of travel before a world-press becomes a pan
const PARCH := Color("#FBF6E9")
const INK := Color("#3A2E22")

signal world_booted()   # fired once the world + UI are live (Main wires IdleSim/Puzzles here)

var world_seed: int = 1
var vp: Vector2 = Vector2(1080, 1920)

# scene graph
var _space: WorldSpace
var _ui: CanvasLayer
var _tray: InventoryTray
var _bubble: ActionBubble
var _ghost_layer: Node2D
var _whisper: Label
var _whisper_tw: Tween

# drag-ghost state (shared by tray-drag and world-pickup)
var _placing := false
var _ghost: ProcNode
var _ghost_ring: _GhostRing
var _ghost_entry: Dictionary = {}
var _ghost_key := ""               # tray inst_key to consume on plant ("" = came from world)
var _ghost_from_world := false
var _ghost_valid := false
var _ghost_target := Vector2.ZERO  # screen-space magnetic target
var _ghost_pos := Vector2.ZERO

# world-gesture state machine
var _pressing := false
var _panning := false
var _press_screen := Vector2.ZERO
var _press_time := 0.0
var _last_touch := Vector2.ZERO
var _pan_prev := Vector2.ZERO
var _press_record: Dictionary = {}
var _press_heart := false

# tap-action state
var _bubble_record: Dictionary = {}
var _sel_ring: ProcNode
var _assign_record: Dictionary = {}


# =============================================================================
# BOOT
# =============================================================================
func _ready() -> void:
	if Game and Game.booted:
		_boot()
	elif Game:
		Game.state_dirty.connect(_boot, CONNECT_ONE_SHOT)


func _boot() -> void:
	vp = get_viewport_rect().size
	world_seed = int(Game.state.get("world_seed", 1)) if (Game and Game.state) else 1
	_ensure_state()

	# --- the world ---
	_space = WorldSpace.new()
	add_child(_space)
	_space.setup(world_seed, vp)
	_space.whisper.connect(_show_whisper)
	_space.restore_from_state()

	# --- the screen-space UI layer (tray + ghost + bubble + whisper) ---
	_ui = CanvasLayer.new()
	_ui.layer = 10
	add_child(_ui)

	_ghost_layer = Node2D.new()
	_ghost_layer.name = "GhostLayer"
	_ui.add_child(_ghost_layer)

	_bubble = ActionBubble.new()
	_bubble.action_chosen.connect(_on_action_chosen)
	_ui.add_child(_bubble)

	_whisper = Label.new()
	_whisper.add_theme_font_size_override("font_size", 30)
	_whisper.add_theme_color_override("font_color", PARCH)
	_whisper.add_theme_color_override("font_outline_color", INK)
	_whisper.add_theme_constant_override("outline_size", 6)
	_whisper.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_whisper.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_whisper.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_whisper.modulate.a = 0.0
	_ui.add_child(_whisper)

	_tray = InventoryTray.new()
	_tray.setup(world_seed)
	_tray.set_inset_bottom(_safe_bottom())
	_tray.drag_started.connect(_on_tray_drag_started)
	_tray.drag_moved.connect(_on_tray_drag_moved)
	_tray.drag_released.connect(_on_tray_drag_released)
	_ui.add_child(_tray)

	# offline wake → diegetic time-lapse (reuses Game.offline_ready)
	if Game and not Game.offline_ready.is_connected(_on_offline_ready):
		Game.offline_ready.connect(_on_offline_ready)
	# re-home / re-tint when the realm changes under us
	if Game and not Game.realm_changed.is_connected(_on_realm_changed):
		Game.realm_changed.connect(_on_realm_changed)

	# the entire tutorial: one whisper, once.
	if Game.state.get("placements", {}).is_empty() and not bool(Game.state.get("diegetic_hinted", false)):
		_show_whisper("Pull something from your basket. Plant it anywhere.", 5.0)
	world_booted.emit()


# The live world (valid after world_booted) — Main wires IdleSim/Puzzles onto it.
func space() -> WorldSpace:
	return _space


func _ensure_state() -> void:
	if not (Game and Game.state):
		return
	if not Game.state.has("inventory") or (Game.state["inventory"] is Dictionary and Game.state["inventory"].is_empty()):
		Game.state["inventory"] = ItemCatalog.starter_inventory()
	if not Game.state.has("placements"):
		Game.state["placements"] = {}
	if not Game.state.has("place_counter"):
		Game.state["place_counter"] = 0


func _safe_bottom() -> float:
	var sa := DisplayServer.get_display_safe_area()
	var win := DisplayServer.window_get_size()
	if win.y > 0 and sa.size.y > 0 and sa.size.y <= win.y:
		var sc := vp.y / float(win.y)
		return clampf((win.y - (sa.position.y + sa.size.y)) * sc, 12.0, 120.0)
	return 16.0


# =============================================================================
# TRAY → DRAG GHOST  (the heart of the menu-less design)
# =============================================================================
func _on_tray_drag_started(inst_key: String, entry: Dictionary, global_pos: Vector2) -> void:
	_dismiss_bubble()
	_tray.collapse()
	_begin_ghost(entry, inst_key, global_pos, false)


func _on_tray_drag_moved(global_pos: Vector2) -> void:
	_update_ghost(global_pos)


func _on_tray_drag_released(global_pos: Vector2) -> void:
	_end_ghost(global_pos)


func _begin_ghost(entry: Dictionary, inst_key: String, screen_pos: Vector2, from_world: bool) -> void:
	_cancel_ghost()
	_placing = true
	_ghost_entry = entry.duplicate(true)
	_ghost_key = inst_key
	_ghost_from_world = from_world
	var stage := SEED_STAGE
	if from_world and float(entry.get("growth", -1.0)) >= 0.0:
		stage = float(entry.get("growth"))
	elif bool(entry.get("minted", false)):
		stage = clampf(float(entry.get("growth", 0.9)), 0.4, 1.0)
	_ghost = ItemCatalog.make_node(world_seed, "ghost", _ghost_entry, {}, stage)
	_ghost.grow_rate = 0.0
	_ghost.modulate = Color(1, 1, 1, 0.55)
	_ghost.z_index = 50
	_ghost_layer.add_child(_ghost)
	_ghost_ring = _GhostRing.new()
	_ghost_ring.radius = _footprint(_ghost)
	_ghost_ring.z_index = 49
	_ghost_layer.add_child(_ghost_ring)
	_ghost_pos = screen_pos
	_ghost_target = screen_pos
	_update_ghost(screen_pos)


func _update_ghost(screen_pos: Vector2) -> void:
	if not _placing or _ghost == null:
		return
	_last_touch = screen_pos
	var world := _space.screen_to_world(screen_pos)
	var res := _space.can_place(_ghost_entry, _ghost, world)
	_ghost_valid = bool(res.ok)
	if _ghost_valid:
		# magnetic snap: aim the ghost at the snapped ground point (eased in _process)
		_ghost_target = _space.world_to_screen(res.snap)
	else:
		_ghost_target = screen_pos
	# validity tint
	if _ghost_valid:
		_ghost.modulate = Color(0.78, 1.0, 0.82, 0.62)
		_ghost_ring.tint = Color(0.5, 0.95, 0.6, 0.6)
	else:
		_ghost.modulate = Color(1.0, 0.72, 0.68, 0.5)
		_ghost_ring.tint = Color(1.0, 0.5, 0.45, 0.5)
	_ghost_ring.queue_redraw()


func _end_ghost(screen_pos: Vector2) -> void:
	if not _placing:
		return
	var world := _space.screen_to_world(screen_pos)
	var res := _space.can_place(_ghost_entry, _ghost, world)
	if bool(res.ok):
		var pid := _next_place_id()
		var growth := -1.0
		if _ghost_from_world or bool(_ghost_entry.get("minted", false)):
			growth = float(_ghost_entry.get("growth", -1.0))
		_space.place(_ghost_entry, pid, res.snap, growth, bool(_ghost_entry.get("minted", false)))
		if not _ghost_from_world and _ghost_key != "":
			_tray.consume(_ghost_key)
		# first-ever placement ends the one-line tutorial forever
		if not bool(Game.state.get("diegetic_hinted", false)):
			Game.state["diegetic_hinted"] = true
			_hide_whisper()
		if Game:
			Game.save_now()
	else:
		# invalid drop → it springs back to the basket
		if _ghost_from_world:
			# an uprooted thing we failed to replant returns to the tray intact
			_tray.add_entry(_ghost_entry)
		_tray.expand()
	_cancel_ghost()


func _cancel_ghost() -> void:
	_placing = false
	_ghost_valid = false
	_ghost_key = ""
	_ghost_from_world = false
	if is_instance_valid(_ghost):
		_ghost.queue_free()
	if is_instance_valid(_ghost_ring):
		_ghost_ring.queue_free()
	_ghost = null
	_ghost_ring = null


func _next_place_id() -> String:
	var c := int(Game.state.get("place_counter", 0))
	Game.state["place_counter"] = c + 1
	return "pl_%d" % c


# =============================================================================
# WORLD GESTURES  (pan / tap / long-press pick-up / heart tap)
# =============================================================================
func _unhandled_input(event: InputEvent) -> void:
	if _space == null:
		return
	# a tray-drag is already captured by the tray; ignore world input while placing
	if _placing:
		if (event is InputEventScreenTouch or event is InputEventMouseButton) and not event.pressed:
			_end_ghost(_evt_pos(event))
		elif event is InputEventScreenDrag or event is InputEventMouseMotion:
			_update_ghost(_evt_pos(event))
		return

	if (event is InputEventScreenTouch or event is InputEventMouseButton):
		if event.pressed:
			_on_world_press(_evt_pos(event))
		else:
			_on_world_release(_evt_pos(event))
	elif event is InputEventScreenDrag or event is InputEventMouseMotion:
		if _pressing:
			_on_world_drag(_evt_pos(event))


func _on_world_press(p: Vector2) -> void:
	if _tray.tray_rect().has_point(p):
		return                         # the tray owns its own area
	_pressing = true
	_panning = false
	_press_screen = p
	_last_touch = p
	_pan_prev = p
	_press_time = _now()
	_press_record = _space.record_at_screen(p)
	_press_heart = _space.heart_hit(p) and _press_record.is_empty()


func _on_world_drag(p: Vector2) -> void:
	_last_touch = p
	if not _panning and _press_screen.distance_to(p) > PAN_SLOP:
		# travel beyond the slop: this is a pan, not a tap/pick-up
		_panning = true
		_dismiss_bubble()
	if _panning:
		_space.pan_by(p - _pan_prev)
	_pan_prev = p


func _on_world_release(p: Vector2) -> void:
	var was_panning := _panning
	var pressed_rec := _press_record
	var pressed_heart := _press_heart
	_pressing = false
	_panning = false
	if was_panning:
		_space.settle_pan()
		return
	if _press_screen.distance_to(p) > PAN_SLOP:
		return
	# a clean tap
	if pressed_heart:
		_space.heart_tap()
		return
	if not pressed_rec.is_empty():
		if not _assign_record.is_empty():
			_resolve_assign(pressed_rec)
			return
		_open_bubble(pressed_rec)
		return
	# tap on empty world → dismiss everything
	_dismiss_bubble()
	_hide_whisper()
	_assign_record = {}


# long-press detection + ghost magnetism + bubble follow
func _process(_delta: float) -> void:
	# magnetic ghost ease toward the snapped target
	if _placing and is_instance_valid(_ghost):
		_ghost_pos = _ghost_pos.lerp(_ghost_target, 0.35)
		_ghost.position = _ghost_pos
		if is_instance_valid(_ghost_ring):
			_ghost_ring.position = _ghost_pos
	# long-press on a placed thing → pick it up into a world-ghost
	if _pressing and not _panning and not _placing and not _press_record.is_empty():
		if _now() - _press_time >= PICKUP_HOLD:
			var rec := _press_record
			_pressing = false
			_dismiss_bubble()
			var entry: Dictionary = _space.remove_record(String(rec.id))
			if not entry.is_empty():
				_begin_ghost(entry, "", _last_touch, true)
	# keep an open bubble glued above its (possibly panning) thing
	if _bubble != null and _bubble.is_open() and not _bubble_record.is_empty():
		if is_instance_valid(_bubble_record.node):
			_bubble.move_to(_space.record_screen_top(_bubble_record))
		else:
			_dismiss_bubble()
	# tear down a lingering selection ring when the bubble has closed
	if _sel_ring != null and (_bubble == null or not _bubble.is_open()):
		if is_instance_valid(_sel_ring) and _sel_ring.has_method("fade_out"):
			_sel_ring.call("fade_out", 0.3)
		_sel_ring = null


# =============================================================================
# TAP ACTIONS  (what the floating bubble offers — the former tab menus, in-world)
# =============================================================================
func _open_bubble(record: Dictionary) -> void:
	_bubble_record = record
	var g := float(record.node.growth) if is_instance_valid(record.node) else 0.0
	var actions := ItemCatalog.actions_for(record.entry, g)
	# a glowing selection ring on the thing itself
	if _sel_ring != null and is_instance_valid(_sel_ring) and _sel_ring.has_method("fade_out"):
		_sel_ring.call("fade_out", 0.1)
	_sel_ring = ProcEffects.make_selection_ring(world_seed, "sel", {
		"radius": record.footprint * 1.25, "style": "rune", "ground": true, "z": 0})
	record.node.add_child(_sel_ring)
	_bubble.show_actions(actions, _space.record_screen_top(record))


func _on_action_chosen(action: String) -> void:
	var rec := _bubble_record
	if rec.is_empty() or not is_instance_valid(rec.node):
		return
	match action:
		"nurture":
			_space.nurture(rec)
		"harvest":
			var amt := _space.harvest(rec)
			if amt > 0.0:
				var res := String(ItemCatalog.produces(rec.entry))
				_show_whisper("+%s %s" % [_fmt(amt), _res_name(res)], 1.6)
		"inspect":
			_show_whisper(ItemCatalog.inspect_line(rec.entry, float(rec.node.growth)), 3.2)
		"assign":
			_assign_record = rec
			_show_whisper("Tap a building to send them to work.", 3.0)
		"mint":
			_try_mint(rec)
		"pickup":
			var entry := _space.remove_record(String(rec.id))
			if not entry.is_empty():
				_tray.add_entry(entry)
				_tray.expand()
				_show_whisper("Tucked into your basket.", 1.6)
			if Game:
				Game.save_now()


func _resolve_assign(target: Dictionary) -> void:
	# light diegetic assign: a creature nestles at a tapped building and "works"
	var who := _assign_record
	_assign_record = {}
	if who.is_empty() or target.is_empty():
		return
	if String(target.entry.get("kind", "")) != "building":
		_show_whisper("They can only work at a building.", 2.0)
		return
	# walk the creature over beside the building (cheap tween)
	if is_instance_valid(who.node) and is_instance_valid(target.node):
		var who_node: Node2D = who.node
		var dest: Vector2 = target.node.position + Vector2(target.footprint * 0.8, 0)
		var tw: Tween = who_node.create_tween().set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_IN_OUT)
		tw.tween_property(who_node, "position", dest, 1.1)
	_show_whisper("Off to work they go.", 1.8)


func _try_mint(record: Dictionary) -> void:
	if float(record.node.growth) < 0.85:
		_show_whisper("Let it grow a little more before you press it.", 2.4)
		return
	# hand off to the ecosystem wallet if it can sign; otherwise freeze locally.
	if Wallet and Wallet.has_method("can_mint") and bool(Wallet.can_mint()):
		if Wallet.has_method("mint_entity"):
			Wallet.call("mint_entity", _mint_metadata(record))
	_space.set_minted(String(record.id), true)
	if Game:
		Game.save_now()
	_show_whisper("Pressed like a flower — held timeless now.", 3.0)
	_dismiss_bubble()


func _mint_metadata(record: Dictionary) -> Dictionary:
	return {
		"world_seed": world_seed,
		"entity_key": String(record.id),
		"kind": String(record.entry.get("kind", "")),
		"species": String(record.entry.get("species", "")),
		"building_id": String(record.entry.get("building_id", "")),
		"growth_snapshot": float(record.node.growth),
	}


func _dismiss_bubble() -> void:
	_bubble_record = {}
	if _bubble != null:
		_bubble.dismiss()


# =============================================================================
# WHISPER  (the whole status + tutorial surface)
# =============================================================================
func _show_whisper(text: String, hold: float = 2.6) -> void:
	if _whisper == null:
		return
	_whisper.text = text
	var w: float = minf(vp.x * 0.82, 760.0)
	_whisper.size = Vector2(w, 0)
	_whisper.position = Vector2((vp.x - w) * 0.5, vp.y * 0.30)
	if _whisper_tw and _whisper_tw.is_valid():
		_whisper_tw.kill()
	_whisper.modulate.a = 0.0
	_whisper_tw = create_tween()
	_whisper_tw.tween_property(_whisper, "modulate:a", 1.0, 0.3)
	_whisper_tw.parallel().tween_property(_whisper, "position:y", vp.y * 0.26, 0.3)
	_whisper_tw.tween_interval(hold)
	_whisper_tw.tween_property(_whisper, "modulate:a", 0.0, 0.6)
	_whisper_tw.parallel().tween_property(_whisper, "position:y", vp.y * 0.22, 0.6)


func _hide_whisper() -> void:
	if _whisper == null:
		return
	if _whisper_tw and _whisper_tw.is_valid():
		_whisper_tw.kill()
	var tw := create_tween()
	tw.tween_property(_whisper, "modulate:a", 0.0, 0.25)


# =============================================================================
# SIGNALS from the economy / lifecycle
# =============================================================================
func _on_offline_ready(summary: Dictionary) -> void:
	if _space:
		_space.play_offline_timelapse(summary)


func _on_realm_changed() -> void:
	# simplest robust response: rebuild the world for the new realm, keep placements.
	if _space:
		_space.queue_free()
	_space = WorldSpace.new()
	add_child(_space)
	move_child(_space, 0)
	vp = get_viewport_rect().size
	_space.setup(world_seed, vp)
	_space.whisper.connect(_show_whisper)
	_space.restore_from_state()


# =============================================================================
# tiny utilities
# =============================================================================
func _footprint(node: ProcNode) -> float:
	if node and node.get("footprint_radius") != null:
		return maxf(10.0, float(node.get("footprint_radius")))
	return 24.0


func _evt_pos(event: InputEvent) -> Vector2:
	if event is InputEventMouseButton or event is InputEventMouseMotion:
		return event.position
	if event is InputEventScreenTouch or event is InputEventScreenDrag:
		return event.position
	return get_viewport().get_mouse_position()


func _now() -> float:
	return float(Time.get_ticks_msec()) / 1000.0


func _res_name(res: String) -> String:
	if GameData and GameData.resources_by_id.has(res):
		return String(GameData.resources_by_id[res].get("name", res))
	return res


func _fmt(v: float) -> String:
	if v >= 1000.0:
		return "%.1fk" % (v / 1000.0)
	if v >= 100.0:
		return "%d" % int(round(v))
	return "%.1f" % v


# =============================================================================
#  _GhostRing — the soft footprint ring under the drag-ghost (green=ok / red=no).
# =============================================================================
class _GhostRing extends Node2D:
	var radius: float = 24.0
	var tint: Color = Color(0.5, 0.95, 0.6, 0.6)

	func _draw() -> void:
		# a flattened ground ellipse (feet-at-origin)
		var pts := PackedVector2Array()
		var segs := 28
		for i in range(segs):
			var a := TAU * float(i) / float(segs)
			pts.append(Vector2(cos(a) * radius * 1.35, sin(a) * radius * 0.5))
		draw_colored_polygon(pts, Color(tint.r, tint.g, tint.b, tint.a * 0.35))
		var ring := pts
		ring.append(pts[0])
		draw_polyline(ring, Color(tint.r, tint.g, tint.b, tint.a), 3.0, true)
