class_name WorldSpace
extends Node2D
# WorldSpace — the living, pannable WORLD the diegetic interaction layer plants into.
#
# It is the single source of truth for everything spatial in the menu-less game
# (IDLE-DESIGN §2): the ground you stand things on, the Heart Tree that lights the
# island and pools your essence at its roots, the registry of every placed living
# thing, the rules that decide where a dragged seed may land, the local
# "neighbourhood" each planted thing adapts to, the slow diegetic accrual that drifts
# resource-motes home, and the camera pan + soft clamp that lets you wander the isle
# with your thumb. Interact.gd (the controller) drives it; ItemCatalog.gd turns an
# inventory entry into the actual ProcNode art; this class owns WHERE and WHETHER.
#
# Design contract honoured here:
#   • One world, feet-at-origin placement (CONVENTIONS rule 7): a thing's node origin
#     sits exactly on the ground contour.
#   • Seeded + deterministic (rule 3): a placement's instance key is its stable
#     place-id, so the thing regenerates identically across saves / sessions. Ground
#     positions persist as TERRAIN-LOCAL x (pan-independent), never screen pixels.
#   • Growth is continuous (rule 4): placing a fresh seed calls pop_in(); a replaced
#     keepsake resumes from its frozen growth; the land itself grows glacially.
#   • Adapt-to-surroundings (§2.3a): build_context() measures local palette, the light
#     direction toward the Heart Tree, the elevation/exposure, and nearby neighbours,
#     and hands it to the thing so flora leans to the light and clusters nestle.
#   • Status is diegetic (§2.4): no HUD. Producers shed resource-motes that drift to a
#     luminous pool at the Heart Tree's roots; "ready" things wear a soft orbiting glow.
#
# PUBLIC API (called by Interact / puzzle modules):
#   setup(world_seed:int, viewport:Vector2)                 — build the world once
#   restore_from_state()                                    — rebuild placements from Game.state
#   screen_to_world(p)/world_to_screen(p) -> Vector2
#   pan_by(delta:Vector2) / settle_pan()                    — drag-pan + rubber-band
#   snap_ground(world_pos:Vector2) -> Vector2               — feet-to-contour snap point
#   terrain_x(world_pos:Vector2) -> float
#   can_place(entry:Dictionary, ghost:ProcNode, world_pos) -> Dictionary {ok, snap, reason}
#   build_context(world_pos:Vector2, footprint:float) -> Dictionary
#   place(entry, place_id, world_pos, growth, minted) -> Dictionary (record)
#   remove_record(place_id) -> Dictionary                   — uproot, returns the saved entry
#   record_at_screen(p:Vector2) -> Dictionary               — hit-test a placed thing ({} if none)
#   heart_hit(p:Vector2) -> bool  /  heart_tap() -> float   — the kept _tap_tree, diegetic
#   set_minted(place_id, on:bool)                           — freeze/thaw a thing's life
#   nurture(record) / harvest(record) -> float
#   awaken_region(dir:int, key:String)                      — puzzle reward: grow the land
#   play_offline_timelapse(summary:Dictionary)              — the §2.4 "while away" wake
#   signals: whisper(text), essence_pool_changed(amount), world_ready

signal whisper(text: String)
signal essence_pool_changed(amount: float)
signal world_ready

const GROUND_SNAP_RISE := 0.08       # fresh-seed sprout stage (mirrors ItemCatalog.SEED_GROWTH)
const OVERLAP_TOL := 0.45            # neighbours may nestle deeply — placement stays forgiving
								     # even for big-footprint buildings on a busy island
const NEIGHBOUR_REACH := 1.9         # footprints: how far "nearby" reaches for adaptation
const MAX_MOTES := 48                # concurrency cap on drifting resource motes
const POOL_KEYS := ["essence", "timber", "stone", "crystal", "stardust", "relics"]

var world_seed: int = 1
var vp: Vector2 = Vector2(1080, 1920)

# --- scene graph -------------------------------------------------------------
var _cam: Node2D                     # the ONE pannable container; everything world-space lives under it
var _terrain: ProcNode               # ProcTerrain._Island — authoritative ground geometry
var _heart: ProcNode                 # the Heart Tree: light source + essence pool anchor
var _ent_layer: Node2D               # placed living things
var _fx_layer: Node2D                # transient effects (puffs, sparkles, motes, rings)
var _pool_node: _RootPool            # the luminous essence heap at the roots (diegetic readout)

# --- world geometry ----------------------------------------------------------
var _ground_origin: Vector2 = Vector2.ZERO   # cam-local point where the terrain feet-origin sits
var _heart_base: Vector2 = Vector2.ZERO      # cam-local Heart-Tree foot (the light source / pool)
var _pan_home: Vector2 = Vector2.ZERO        # resting cam position (ground centred)
var _pan_ext: Vector2 = Vector2(600, 500)    # half-extents the cam may stray from home

# --- placed registry ---------------------------------------------------------
# record := { id, inst_key, entry, node, tx, footprint, minted, frost, stock:{}, ready:bool }
var _records: Array = []
var _motes: Array = []               # live drifting motes [{node, from, dt, kind}]
var _mote_accum: float = 0.0
var _ready_built := false


# =============================================================================
# BUILD
# =============================================================================
func setup(seed_value: int, viewport: Vector2) -> void:
	world_seed = seed_value
	vp = viewport
	_cam = Node2D.new()
	_cam.name = "PanCam"
	add_child(_cam)

	# Ground: the hero island. Deliberately WIDER than the portrait screen so the
	# world feels bigger than the window and panning is meaningful (borders still
	# only slightly beyond the view — pan bounds derive from this span).
	var half := clampf(vp.x * 0.62, 260.0, 780.0)
	_terrain = ProcTerrain.make(world_seed, "home", half, _realm_id(), 0)
	_ground_origin = Vector2(vp.x * 0.5, vp.y * 0.60)
	_terrain.position = _ground_origin
	_cam.add_child(_terrain)

	# The Heart Tree: the centrepiece and light source — and the FARTHEST-BACK
	# feature: everything planted lives in front of it (z above), so it reads as
	# the great backdrop the world grows against. It also grows VERY slowly, its
	# stage persisted — no bursting into existence.
	_heart_base = Vector2(_ground_origin.x, _ground_origin.y + _ground_surface(0.0))
	_heart = ProcHeartTree.make_for_realm(world_seed, "heart", _realm_id())
	_heart.position = _heart_base
	_heart.z_index = 0
	_heart.growth = clampf(float(Game.state.get("heart_growth", 0.06)) if (Game and Game.state) else 0.06, 0.02, 1.0)
	_heart.set_grow_minutes(600.0)   # ~10 real hours from seedling to the ancient giant
	_cam.add_child(_heart)

	# Essence pool + its root heap sit at the island crown, at the Heart Tree's feet.
	_pool_node = _RootPool.new()
	_pool_node.position = _heart_base
	_cam.add_child(_pool_node)

	_fx_layer = Node2D.new()
	_fx_layer.name = "FX"
	_fx_layer.z_index = 30
	_cam.add_child(_fx_layer)

	_ent_layer = Node2D.new()
	_ent_layer.name = "Entities"
	_ent_layer.z_index = 1
	_cam.add_child(_ent_layer)

	_recompute_pan_bounds()
	_pan_home = Vector2.ZERO
	_cam.position = _pan_home
	_ready_built = true
	_pool_node.set_amount(_pool_total())
	emit_signal("world_ready")


func _realm_id() -> String:
	if Game and Game.state:
		return String(Game.state.get("realm", "verdant"))
	return "verdant"


# The terrain reports surface height in ITS local space; convert a terrain-x to a
# cam-local y offset below the ground origin.
func _ground_surface(tx: float) -> float:
	if _terrain and _terrain.has_method("surface_y"):
		return _terrain.call("surface_y", tx)
	# analytic fallback: a gentle crowned contour
	var half := vp.x * 0.42
	var e: float = clampf(1.0 - absf(tx) / maxf(1.0, half), 0.0, 1.0)
	return -14.0 * sin(e * PI) + sin(tx * 0.03) * 6.0


func _ground_extents() -> Vector2:
	if _terrain and _terrain.has_method("ground_extents"):
		return _terrain.call("ground_extents")
	var half := vp.x * 0.42
	return Vector2(-half, half)


func _island_radius() -> float:
	var e := _ground_extents()
	return maxf(1.0, (e.y - e.x) * 0.5)


func _recompute_pan_bounds() -> void:
	var ext := _ground_extents()
	var span := ext.y - ext.x
	# "just-beyond-the-edge": you may pan about one screen past the ground, no more.
	var hx: float = maxf(0.0, span * 0.5 - vp.x * 0.42) + vp.x * 0.55
	_pan_ext = Vector2(hx, vp.y * 0.62)


# =============================================================================
# CAMERA / COORDINATES
# =============================================================================
func screen_to_world(p: Vector2) -> Vector2:
	if _cam == null:
		return p
	return _cam.to_local(p)


func world_to_screen(w: Vector2) -> Vector2:
	if _cam == null:
		return w
	return _cam.to_global(w)


func pan_by(delta: Vector2) -> void:
	if _cam == null:
		return
	var target := _cam.position + delta
	# soft rubber-band: motion past the clamp is damped, not walled.
	_cam.position = _rubber(target)


func _rubber(pos: Vector2) -> Vector2:
	var out := pos
	out.x = _rubber_axis(pos.x, _pan_home.x, _pan_ext.x)
	out.y = _rubber_axis(pos.y, _pan_home.y, _pan_ext.y)
	return out


func _rubber_axis(v: float, home: float, ext: float) -> float:
	var d := v - home
	if absf(d) <= ext:
		return v
	var over := absf(d) - ext
	# diminishing overscroll
	return home + signf(d) * (ext + over * 0.35)


# Ease the camera back inside the clamp when the finger lifts.
func settle_pan() -> void:
	if _cam == null:
		return
	var inside := Vector2(
		clampf(_cam.position.x, _pan_home.x - _pan_ext.x, _pan_home.x + _pan_ext.x),
		clampf(_cam.position.y, _pan_home.y - _pan_ext.y, _pan_home.y + _pan_ext.y))
	if inside.distance_to(_cam.position) < 0.5:
		return
	var tw := create_tween().set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_OUT)
	tw.tween_property(_cam, "position", inside, 0.3)


# =============================================================================
# GROUND QUERIES
# =============================================================================
func terrain_x(world_pos: Vector2) -> float:
	var ext := _ground_extents()
	return clampf(world_pos.x - _ground_origin.x, ext.x, ext.y)


# The feet-to-contour snap point (cam-local) for a finger hovering at `world_pos`.
func snap_ground(world_pos: Vector2) -> Vector2:
	var tx := terrain_x(world_pos)
	return _ground_origin + Vector2(tx, _ground_surface(tx))


func on_ground(world_pos: Vector2) -> bool:
	var ext := _ground_extents()
	var tx := world_pos.x - _ground_origin.x
	if tx < ext.x - 6.0 or tx > ext.y + 6.0:
		return false
	# within a tolerant band around the surface contour
	var gy := _ground_origin.y + _ground_surface(clampf(tx, ext.x, ext.y))
	return absf(world_pos.y - gy) < _island_radius() * 1.3 + 160.0


# Ground flavour at a terrain-x. v1: land everywhere, plus any "water area" a placed
# water feature (pond/well/lilypad) has opened nearby. Dormant dells (puzzle ground)
# can later mark regions locked; awaken_region() clears them.
func ground_kind(tx: float) -> String:
	for r in _records:
		if String(ItemCatalog.ground_type(r.entry)) == "water":
			if absf((_ground_origin.x + tx) - r.node.position.x) < r.footprint * 1.4:
				return "water"
	return "land"


# =============================================================================
# PLACEMENT VALIDITY  (IDLE-DESIGN §2.3 — forgiving, tactile, unlosable)
# =============================================================================
func can_place(entry: Dictionary, ghost: ProcNode, world_pos: Vector2) -> Dictionary:
	var snap := snap_ground(world_pos)
	var tx := terrain_x(world_pos)
	var fr := _footprint_of(ghost)
	# off the island? (lenient: a thing may hang a little over the edge)
	var ext := _ground_extents()
	if tx <= ext.x + fr * 0.15 or tx >= ext.y - fr * 0.15:
		return {"ok": false, "snap": snap, "reason": "off_island"}
	# ground-type gating (water flora want water; land things reject water tiles)
	var want := String(ItemCatalog.ground_type(entry))
	var here := ground_kind(tx)
	if want == "water" and here != "water":
		# water features bring their own water, so allow ponds/wells/lilypads anywhere
		# EXCEPT directly on top of a land thing (handled by overlap below). This keeps
		# the starter Lily Pad plantable without a pre-existing pond.
		pass
	if want == "land" and here == "water":
		return {"ok": false, "snap": snap, "reason": "over_water"}
	# footprint overlap with existing things (gentle: nestling allowed)
	for r in _records:
		var d: float = absf(snap.x - r.node.position.x)
		var allow: float = (fr + r.footprint) * OVERLAP_TOL
		if d < allow:
			return {"ok": false, "snap": snap, "reason": "too_close"}
	return {"ok": true, "snap": snap, "reason": ""}


func _footprint_of(node: ProcNode) -> float:
	if node == null:
		return 24.0
	if _has_prop(node, "footprint_radius"):
		return maxf(8.0, float(node.get("footprint_radius")))
	return 24.0


# =============================================================================
# ADAPTATION CONTEXT  (§2.3a — things blend into where they are planted)
# =============================================================================
func build_context(world_pos: Vector2, footprint: float) -> Dictionary:
	var tx := terrain_x(world_pos)
	var snap := _ground_origin + Vector2(tx, _ground_surface(tx))
	# local palette: a position-seeded harmony so a hollow runs cooler than the crown
	var bucket := int(round(tx / 80.0))
	var local_palette := Proc.palette(world_seed, "loc:%d" % bucket)
	# light leans toward the Heart Tree's glow (its crown, a little above the base)
	var light_target := _heart_base + Vector2(0.0, -_heart_height() * 0.6)
	var light_dir: Vector2 = (light_target - snap)
	if light_dir.length() < 1.0:
		light_dir = Vector2(0, -1)
	light_dir = light_dir.normalized()
	# elevation/exposure: outer ground is higher & more windswept → things run smaller
	var elevation: float = clampf(absf(tx) / _island_radius(), 0.0, 1.0)
	# neighbours within reach, as cam-local offsets + footprints (for nestling)
	var neighbours: Array = []
	for r in _records:
		var off: Vector2 = r.node.position - snap
		if off.length() < (footprint + r.footprint) * NEIGHBOUR_REACH:
			neighbours.append({"offset": off, "footprint": r.footprint,
				"kind": String(r.entry.get("kind", ""))})
	return {
		"local_palette": local_palette,
		"light_dir": light_dir,
		"elevation": elevation,
		"neighbours": neighbours,
		"realm": _realm_id(),
	}


func _heart_height() -> float:
	if _heart and _has_prop(_heart, "footprint_radius"):
		return maxf(120.0, float(_heart.get("footprint_radius")) * 1.4)
	return 260.0


# =============================================================================
# PLACE / REMOVE
# =============================================================================
# Plant / set down a thing. `growth` < 0 → a fresh seed that unfurls via pop_in();
# otherwise it resumes from that growth (a replaced keepsake or uprooted thing).
func place(entry: Dictionary, place_id: String, world_pos: Vector2, growth: float = -1.0, minted: bool = false) -> Dictionary:
	var snap := snap_ground(world_pos)
	var ctx := build_context(snap, 24.0)
	var node := ItemCatalog.make_node(world_seed, place_id, entry, ctx, -1.0)
	node.position = snap
	# orient to the ground slope just a touch (buildings level, flora tilts gently)
	var nrm := _ground_normal(terrain_x(snap))
	node.rotation = _slope_lean(nrm) * (0.0 if String(entry.get("kind", "")) == "building" else 0.35)
	_ent_layer.add_child(node)
	var fr := _footprint_of(node)
	# re-measure neighbours now that we know the real footprint, and adapt
	ItemCatalog.adapt(node, build_context(snap, fr))

	if minted:
		ItemCatalog.set_frozen(node, true)
		if growth >= 0.0:
			node.set_growth(clampf(growth, 0.0, 1.0))
	elif growth >= 0.0:
		node.set_growth(clampf(growth, 0.0, 1.0))
	else:
		node.pop_in(0.9)

	var record := {
		"id": place_id, "inst_key": place_id, "entry": entry.duplicate(true),
		"node": node, "tx": terrain_x(snap), "footprint": fr,
		"minted": minted, "frost": null, "stock": {}, "ready": false,
	}
	if minted:
		record.frost = _add_frost(node, fr)
	_records.append(record)
	_spawn_fx(snap, "puff", String(entry.get("kind", "plant")))
	_persist()
	return record


func _add_frost(node: ProcNode, fr: float) -> MintFrost:
	var frost := MintFrost.new()
	node.add_child(frost)
	var tint := Color(0.74, 0.87, 1.0)
	if node is CanvasItem:
		frost.setup(fr * 1.15, maxf(fr * 2.4, 120.0), tint)
	frost.set_strength(1.0)
	return frost


func _ground_normal(tx: float) -> Vector2:
	if _terrain and _terrain.has_method("surface_normal"):
		return _terrain.call("surface_normal", tx)
	return Vector2(0, -1)


func _slope_lean(nrm: Vector2) -> float:
	# small rotation so a thing tilts with the hill, clamped so nothing looks fallen
	var up := Vector2(0, -1)
	var a := up.angle_to(nrm)
	return clampf(a, -0.18, 0.18)


# Uproot: free the node, drop it from the registry + save, and return the entry
# (with its CURRENT growth folded in) so the caller can put it back in the tray.
func remove_record(place_id: String) -> Dictionary:
	for i in range(_records.size()):
		var r: Dictionary = _records[i]
		if r.id == place_id:
			var entry: Dictionary = r.entry.duplicate(true)
			entry["growth"] = float(r.node.growth)
			entry["minted"] = bool(r.minted)
			if is_instance_valid(r.node):
				_spawn_fx(r.node.position, "puff", String(entry.get("kind", "plant")))
				r.node.queue_free()
			_records.remove_at(i)
			_persist()
			return entry
	return {}


# =============================================================================
# HIT-TESTING  (tap / long-press pick-up)
# =============================================================================
func record_at_screen(p: Vector2) -> Dictionary:
	var w := screen_to_world(p)
	var best := {}
	var best_d := INF
	for r in _records:
		if not is_instance_valid(r.node):
			continue
		# feet-at-origin bodies rise upward; test a capsule around the trunk line
		var base: Vector2 = r.node.position
		var dx: float = absf(w.x - base.x)
		var body_h: float = maxf(r.footprint * 2.4, 70.0)
		var within_x: bool = dx < r.footprint * 1.15
		var within_y: bool = w.y < base.y + 12.0 and w.y > base.y - body_h
		if within_x and within_y:
			var d: float = dx + absf((base.y - body_h * 0.5) - w.y) * 0.3
			if d < best_d:
				best_d = d
				best = r
	return best


func record_screen_top(record: Dictionary) -> Vector2:
	if record.is_empty() or not is_instance_valid(record.node):
		return Vector2.ZERO
	var body_h: float = maxf(record.footprint * 2.4, 80.0)
	return world_to_screen(record.node.position + Vector2(0, -body_h - 14.0))


# =============================================================================
# Composition accessors — Main wires IdleSim / Puzzles onto the live world.
# =============================================================================
func heart_node() -> ProcNode:
	return _heart

func heart_foot() -> Vector2:
	return _heart_base

func cam_node() -> Node2D:
	return _cam

func entity_layer() -> Node2D:
	return _ent_layer


# =============================================================================
# HEART TREE  (the kept _tap_tree, now diegetic: taps pool essence at the roots)
# =============================================================================
func heart_hit(p: Vector2) -> bool:
	var w := screen_to_world(p)
	var hr: float = _heart_height() * 0.5
	return w.distance_to(_heart_base + Vector2(0, -hr)) < maxf(120.0, hr)


func heart_tap() -> float:
	var amt := 1.0
	if Production and Production.has_method("tap_value"):
		amt = float(Production.tap_value())
	if Game:
		Game.add_resource("essence", amt)
		if Game.state.has("stats"):
			Game.state["stats"]["taps"] = int(Game.state["stats"].get("taps", 0)) + 1
	_spawn_fx(_heart_base + Vector2(0, -_heart_height() * 0.5), "tap", "light")
	if is_instance_valid(_heart):
		var tw := create_tween()
		tw.tween_property(_heart, "scale", _heart.scale * 1.03, 0.07)
		tw.tween_property(_heart, "scale", _heart.scale, 0.12)
	_pool_node.set_amount(_pool_total())
	emit_signal("essence_pool_changed", Game.res("essence") if Game else 0.0)
	return amt


# =============================================================================
# ACTIONS  (nurture / harvest / mint)
# =============================================================================
func nurture(record: Dictionary) -> void:
	if record.is_empty() or not is_instance_valid(record.node):
		return
	var cost := {"essence": 2.0}
	if Game and not Game.can_afford(cost):
		emit_signal("whisper", "It needs a little essence first.")
		return
	if Game:
		Game.spend(cost)
	var g := float(record.node.growth)
	record.node.grow_to(minf(1.0, g + 0.08), 0.8)
	_spawn_fx(record.node.position + Vector2(0, -record.footprint), "sparkle", "light")
	_persist()


func harvest(record: Dictionary) -> float:
	if record.is_empty() or not is_instance_valid(record.node):
		return 0.0
	var res := String(ItemCatalog.produces(record.entry))
	if res == "":
		return 0.0
	var amt := float(record.stock.get(res, 0.0))
	if amt < 0.5:
		emit_signal("whisper", "Still gathering — come back soon.")
		return 0.0
	record.stock[res] = 0.0
	record.ready = false
	if Game:
		Game.add_resource(res, amt)
	_spawn_fx(record.node.position + Vector2(0, -record.footprint * 1.4), "harvest", "", res)
	_drift_mote(record.node.position + Vector2(0, -record.footprint), res, amt)
	return amt


func set_minted(place_id: String, on: bool) -> void:
	for r in _records:
		if r.id == place_id:
			r.minted = on
			ItemCatalog.set_frozen(r.node, on)
			if on and r.frost == null:
				r.frost = _add_frost(r.node, r.footprint)
			elif not on and r.frost != null:
				if is_instance_valid(r.frost):
					var frost: MintFrost = r.frost
					var tw := frost.create_tween()
					tw.tween_method(frost.set_strength, 1.0, 0.0, 0.35)
					tw.tween_callback(frost.queue_free)
				r.frost = null
			r.entry["minted"] = on
			_persist()
			return


# =============================================================================
# WORLD EXPANSION  (Rootwork puzzle reward — grow the land, widen the clamp)
# =============================================================================
func awaken_region(dir: int = 1, key: String = "") -> void:
	if _terrain and _terrain.has_method("add_region"):
		var k := key if key != "" else "awoken:%d" % _records.size()
		_terrain.call("add_region", k, dir, -1.0, 1.0, 6.0)
		await get_tree().create_timer(6.2).timeout
		_recompute_pan_bounds()
	emit_signal("whisper", "New ground wakes at the island's edge.")


# =============================================================================
# DIEGETIC ACCRUAL + MOTES  (§2.4 — the only "resource UI" is the world itself)
# =============================================================================
var _heart_save_accum := 0.0

func _process(delta: float) -> void:
	if not _ready_built or not (Game and Game.booted):
		return
	# persist the Heart Tree's very slow growth (throttled; survives restarts so
	# it never re-bursts into existence)
	_heart_save_accum += delta
	if _heart_save_accum >= 10.0:
		_heart_save_accum = 0.0
		if is_instance_valid(_heart) and Game and Game.state:
			var cur := float(Game.state.get("heart_growth", 0.0))
			if absf(float(_heart.growth) - cur) > 0.001:
				Game.state["heart_growth"] = float(_heart.growth)
	# producers slowly fill their own little stock, scaled by how grown they are
	_mote_accum += delta
	for r in _records:
		if not is_instance_valid(r.node) or r.minted:
			continue
		var res := String(ItemCatalog.produces(r.entry))
		if res == "":
			continue
		var gv: float = _eased(float(r.node.growth))
		var rate: float = ItemCatalog.base_yield(r.entry) * gv
		if rate <= 0.0:
			continue
		r.stock[res] = float(r.stock.get(res, 0.0)) + rate * delta
		# "ready" glow once a worthwhile amount has gathered
		var was: bool = r.ready
		r.ready = float(r.stock[res]) >= 4.0
		if r.ready and not was:
			_set_ready_glow(r, true)
		elif not r.ready and was:
			_set_ready_glow(r, false)
	# occasionally drift a mote from a busy producer home to the root-pool
	if _mote_accum >= 0.9:
		_mote_accum = 0.0
		_maybe_emit_producer_mote()
	_advance_motes(delta)


func _maybe_emit_producer_mote() -> void:
	if _motes.size() >= MAX_MOTES:
		return
	var pick: Dictionary = {}
	var best := 0.0
	for r in _records:
		if r.minted or not is_instance_valid(r.node):
			continue
		var res := String(ItemCatalog.produces(r.entry))
		if res == "":
			continue
		var s := float(r.stock.get(res, 0.0))
		if s > best:
			best = s
			pick = r
	if pick.is_empty() or best < 1.0:
		return
	_drift_mote(pick.node.position + Vector2(0, -pick.footprint), String(ItemCatalog.produces(pick.entry)), 1.0)


# Spawn a resource-mote that streams from `from` to the Heart Tree's root-pool.
func _drift_mote(from: Vector2, res: String, amount: float) -> void:
	if _motes.size() >= MAX_MOTES:
		return
	var m := ProcEffects.make_pickup_float(world_seed, "mote:%d" % Time.get_ticks_usec(),
		res, clampf(amount, 0.1, 4.0), {"scale": 0.7, "z": 25})
	m.position = from
	_fx_layer.add_child(m)
	_motes.append({"node": m, "from": from, "to": _heart_base + Vector2(0, -12.0), "dt": 0.0})


func _advance_motes(delta: float) -> void:
	var keep: Array = []
	for mo in _motes:
		if not is_instance_valid(mo.node):
			continue
		mo.dt += delta
		var u: float = clampf(mo.dt / 1.1, 0.0, 1.0)
		var ue: float = u * u * (3.0 - 2.0 * u)
		# arc gently upward on the way to the pool
		var from_v: Vector2 = mo.from
		var to_v: Vector2 = mo.to
		var mid: Vector2 = from_v.lerp(to_v, ue)
		mid.y -= sin(u * PI) * 46.0
		mo.node.position = mid
		if u >= 1.0:
			mo.node.queue_free()
			_pool_node.pulse()
			_pool_node.set_amount(_pool_total())
		else:
			keep.append(mo)
	_motes = keep


func _set_ready_glow(record: Dictionary, on: bool) -> void:
	if not is_instance_valid(record.node):
		return
	if on and record.get("glow", null) == null:
		var ring := ProcEffects.make_selection_ring(world_seed, "ready:%s" % record.id,
			{"radius": record.footprint * 1.3, "style": "bloom", "ground": true, "z": 0,
			 "color": _res_color(String(ItemCatalog.produces(record.entry)))})
		record.node.add_child(ring)
		record["glow"] = ring
	elif not on and record.get("glow", null) != null:
		var ring = record["glow"]
		if is_instance_valid(ring) and ring.has_method("fade_out"):
			ring.call("fade_out", 0.4)
		record["glow"] = null


func _pool_total() -> float:
	if not Game:
		return 0.0
	return Game.res("essence")


# =============================================================================
# OFFLINE WAKE  (§2.4 — a short diegetic time-lapse, not a spreadsheet popup)
# =============================================================================
func play_offline_timelapse(summary: Dictionary) -> void:
	var earnings: Dictionary = summary.get("earnings", {})
	var from := _heart_base + Vector2(-80, -40)
	for res in earnings.keys():
		if _motes.size() >= MAX_MOTES:
			break
		_drift_mote(from + Vector2(randf_range(-60, 60), randf_range(-40, 40)), String(res), 2.0)
	# nudge any still-young things to finish the stage they were mid-way through
	for r in _records:
		if is_instance_valid(r.node) and not r.minted and r.node.growth < 1.0:
			r.node.grow_to(minf(1.0, r.node.growth + 0.04), 1.4)
	emit_signal("whisper", "The island grew while you were away.")


# =============================================================================
# PERSISTENCE  (positions stored as terrain-local x, so pan never corrupts a save)
# =============================================================================
func restore_from_state() -> void:
	if not (Game and Game.state):
		return
	var saved: Dictionary = Game.state.get("placements", {})
	for pid in saved.keys():
		var rec: Dictionary = saved[pid]
		var entry := _entry_from_saved(rec)
		var tx := float(rec.get("tx", 0.0))
		var wp := _ground_origin + Vector2(tx, _ground_surface(tx))
		place(entry, String(pid), wp, float(rec.get("growth", -1.0)), bool(rec.get("minted", false)))


func _entry_from_saved(rec: Dictionary) -> Dictionary:
	return {
		"kind": String(rec.get("kind", "plant")),
		"species": String(rec.get("species", "")),
		"building_id": String(rec.get("building_id", "")),
		"label": String(rec.get("label", "")),
		"realm": String(rec.get("realm", _realm_id())),
		"minted": bool(rec.get("minted", false)),
	}


func _persist() -> void:
	if not (Game and Game.state):
		return
	var out := {}
	for r in _records:
		if not is_instance_valid(r.node):
			continue
		out[r.id] = {
			"kind": String(r.entry.get("kind", "plant")),
			"species": String(r.entry.get("species", "")),
			"building_id": String(r.entry.get("building_id", "")),
			"label": String(r.entry.get("label", "")),
			"realm": String(r.entry.get("realm", _realm_id())),
			"tx": float(r.tx),
			"growth": float(r.node.growth),
			"minted": bool(r.minted),
		}
	Game.state["placements"] = out


# =============================================================================
# FX helper
# =============================================================================
func _spawn_fx(world_pos: Vector2, kind: String, material: String = "", res: String = "") -> void:
	var opts := {"z": 28}
	if material != "":
		opts["material"] = material
	if res != "":
		opts["resource"] = res
	var fx := ProcEffects.make(world_seed, "fx:%d" % Time.get_ticks_usec(), kind, opts)
	fx.position = world_pos
	_fx_layer.add_child(fx)


# =============================================================================
# tiny utilities
# =============================================================================
func _eased(x: float) -> float:
	var c := clampf(x, 0.0, 1.0)
	return c * c * c * (c * (c * 6.0 - 15.0) + 10.0)


func _res_color(res: String) -> Color:
	var d: Dictionary = GameData.resources_by_id.get(res, {}) if GameData else {}
	if d.has("color"):
		return Color(d["color"])
	return Color(1.0, 0.9, 0.62)


func _has_prop(o: Object, pname: String) -> bool:
	for p in o.get_property_list():
		if String(p.get("name", "")) == pname:
			return true
	return false


# =============================================================================
#  _RootPool — the luminous essence heap at the Heart Tree's roots.
#  THIS is the game's only resource readout: a soft glowing mound whose size and
#  brightness encode how much essence you hold (IDLE-DESIGN §2.4). No numbers.
# =============================================================================
class _RootPool extends Node2D:
	var amount: float = 0.0
	var _shown: float = 0.0
	var _t: float = 0.0
	var _pulse: float = 0.0

	func _ready() -> void:
		z_index = 1
		set_process(true)

	func set_amount(a: float) -> void:
		amount = maxf(0.0, a)

	func pulse() -> void:
		_pulse = 1.0

	func _process(delta: float) -> void:
		_t += delta
		_shown = lerpf(_shown, amount, clampf(delta * 1.5, 0.0, 1.0))
		_pulse = maxf(0.0, _pulse - delta * 2.0)
		queue_redraw()

	func _draw() -> void:
		# radius grows with the log of your reserves so it never dwarfs the tree
		var r: float = 26.0 + log(1.0 + _shown) * 14.0
		r *= 1.0 + _pulse * 0.08
		var breathe: float = 0.92 + 0.08 * sin(_t * 1.3)
		var green := Color(0.5, 0.92, 0.70, 0.9)
		# flatten into a ground heap (wider than tall)
		# A half-ellipse dome (0..PI, closed along the flat base). A full-TAU loop
		# with -abs(sin) retraces itself and fails triangulation.
		var pts := PackedVector2Array()
		var segs := 26
		for i in range(segs + 1):
			var a := PI * float(i) / float(segs)
			pts.append(Vector2(cos(a) * r * 1.5, -sin(a) * r * 0.5 * breathe))
		var top := green.lightened(0.2)
		var bot := Color(green.r * 0.6, green.g * 0.8, green.b * 0.7, 0.75)
		draw_polygon(pts, Proc.grad_fill(pts, top, bot))
		# a soft inner glow core
		draw_circle(Vector2(0, -r * 0.18), r * 0.5 * breathe, Color(0.8, 1.0, 0.86, 0.35 + _pulse * 0.3))
