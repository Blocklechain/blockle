class_name GroundPlacement
extends RefCounted
# ---------------------------------------------------------------------------
# GroundPlacement — the "where can this go, and how does it adapt there" helper
# for the living world (Blockle Idle, §2.3 / §2.3a of docs/IDLE-DESIGN.md).
#
# It wraps the main ProcTerrain island (the thing with surface_y / surface_point
# / surface_normal / ground_extents / contains_x) and turns it into a tidy set
# of queries every placement gesture needs:
#
#   * snap the FEET of a standing thing to the ground contour under a finger,
#   * tell land from water (so a lilypad only takes on water, a tree only on
#     land, a building only on a level-enough patch),
#   * reject footprint overlaps so you can't carpet-bomb the island (§1.2),
#   * build the adaptation Context (§2.3a: local palette drift, lean-to-light,
#     elevation scale, nestle-by-neighbours) handed into each ProcNode so a
#     planted thing is composed by its surroundings, not stamped.
#
# All geometry is expressed in the coordinate space of `space_node` — the
# WorldStage content root the island and every entity live under — so a world
# point and a "placement" point are the same thing. Pure queries, no state
# mutated on the world; cheap enough to call every frame while a ghost drags.
# ---------------------------------------------------------------------------

# Modules expose this when they want their mature radius respected. We read it
# defensively via `_radius_of` so a module without it still places fine.
const DEFAULT_FOOTPRINT := 48.0
const OVERLAP_TOLERANCE := 0.70     # centres closer than 70% of summed radii = reject
const LEVEL_SLOPE_MAX := 0.26       # buildings want ground flatter than this (rise/run)
const WATER_SNAP_DIST := 120.0      # how near a water surface counts as "on water"

var island: ProcNode = null         # the ProcTerrain _Island (ground source)
var space_node: Node2D = null       # content root everything is parented under
var world_seed: int = 1
var realm_id: String = "verdant"

# Water features registered with the stage: [{node, centre, radius}] in space coords.
var water_regions: Array = []
# Awoken-ground rects (Lightweave dells that became plantable). Rect2 in space coords.
var awake_rects: Array = []
# Live occupants for overlap tests: [{node, pos, radius, ground}].
var occupants: Array = []


static func make(island_node: ProcNode, space: Node2D, seed_value: int, realm: String = "verdant") -> GroundPlacement:
	var g := GroundPlacement.new()
	g.island = island_node
	g.space_node = space
	g.world_seed = seed_value
	g.realm_id = realm
	return g


# ===========================================================================
#  coordinate helpers (space_node <-> island-local)
# ===========================================================================

func _to_island(p: Vector2) -> Vector2:
	if island == null:
		return p
	return island.to_local(_to_global(p))

func _from_island(p: Vector2) -> Vector2:
	if island == null:
		return p
	return _from_global(island.to_global(p))

func _to_global(p: Vector2) -> Vector2:
	if space_node:
		return space_node.to_global(p)
	return p

func _from_global(p: Vector2) -> Vector2:
	if space_node:
		return space_node.to_local(p)
	return p


# ===========================================================================
#  ground queries  (all in space_node coordinates)
# ===========================================================================

# The surface point (feet rest here) at a given x. Falls back to a flat line if
# the island is missing so callers never crash during early boot.
func surface_point(x: float) -> Vector2:
	if island == null or not island.has_method("surface_point"):
		return Vector2(x, 0.0)
	var li := _to_island(Vector2(x, 0.0))
	var sp: Vector2 = island.surface_point(li.x)
	return _from_island(sp)


func surface_y(x: float) -> float:
	return surface_point(x).y


# Upward ground normal at x (for tilting a thing to follow a slope).
func surface_normal(x: float) -> Vector2:
	if island == null or not island.has_method("surface_normal"):
		return Vector2.UP
	var li := _to_island(Vector2(x, 0.0))
	var n: Vector2 = island.surface_normal(li.x)
	# normals are directionless under uniform transforms; just pass through
	return n.normalized()


# Local slope magnitude (rise/run) around x — small = flat, good for buildings.
func slope_at(x: float) -> float:
	var a := surface_point(x - 22.0)
	var b := surface_point(x + 22.0)
	var run: float = max(1.0, absf(b.x - a.x))
	return absf(b.y - a.y) / run


# Left/right plantable extents in space coords (grows as the land expands).
func extents() -> Vector2:
	if island == null or not island.has_method("ground_extents"):
		return Vector2(-400.0, 400.0)
	var e: Vector2 = island.ground_extents()
	var l := _from_island(Vector2(e.x, 0.0)).x
	var r := _from_island(Vector2(e.y, 0.0)).x
	return Vector2(min(l, r), max(l, r))


func on_ground_x(x: float) -> bool:
	var e := extents()
	# keep a small inset off the very lip so feet never hang over the edge
	var inset: float = min(26.0, (e.y - e.x) * 0.06)
	return x >= e.x + inset and x <= e.y - inset


# A seeded random surface point, nicely inset from the edges (for scatter spawns).
func random_surface_point(key: String) -> Vector2:
	var e := extents()
	var inset := (e.y - e.x) * 0.14
	var x: float = lerpf(e.x + inset, e.y - inset, Proc.hashf(world_seed, "gp:rsx:" + key))
	return surface_point(x)


# ===========================================================================
#  ground type  (land / water / level patch)
# ===========================================================================

func register_water(node: Node2D, centre: Vector2, radius: float) -> void:
	water_regions.append({"node": node, "centre": centre, "radius": max(10.0, radius)})

func clear_water() -> void:
	water_regions.clear()

func add_awake_rect(r: Rect2) -> void:
	awake_rects.append(r)


# "land" | "water" at a space-coord point.
func ground_type_at(p: Vector2) -> String:
	for w in water_regions:
		if not is_instance_valid(w["node"]):
			continue
		if p.distance_to(w["centre"]) <= float(w["radius"]) + WATER_SNAP_DIST * 0.0:
			return "water"
	return "land"


func is_water(p: Vector2) -> bool:
	return ground_type_at(p) == "water"


# The snap target for a given desired kind of ground. Water things snap to the
# nearest water surface centre-height; land things snap to the terrain contour.
func snap(p: Vector2, want_ground: String = "land") -> Vector2:
	if want_ground == "water":
		var best: Dictionary = {}
		var best_d := INF
		for w in water_regions:
			if not is_instance_valid(w["node"]):
				continue
			var d: float = p.distance_to(w["centre"])
			if d < best_d:
				best_d = d
				best = w
		if not best.is_empty():
			var c: Vector2 = best["centre"]
			var rad: float = best["radius"]
			# clamp onto the pond disc, feet rest on the water plane (centre y)
			var off := p - c
			if off.length() > rad * 0.82:
				off = off.normalized() * rad * 0.82
			return Vector2(c.x + off.x, c.y + off.y * 0.35)
		return p   # no water yet; leave where it is (caller marks invalid)
	# land: feet to the contour at this x
	return surface_point(p.x)


# ===========================================================================
#  validity  (the green/red glow test from §2.3)
# ===========================================================================

func register_occupant(node: Node2D, pos: Vector2, ground: String = "land") -> void:
	occupants.append({"node": node, "pos": pos, "radius": _radius_of(node), "ground": ground})

func unregister_occupant(node: Node2D) -> void:
	for i in range(occupants.size() - 1, -1, -1):
		if occupants[i]["node"] == node or not is_instance_valid(occupants[i]["node"]):
			occupants.remove_at(i)

func clear_occupants() -> void:
	occupants.clear()


# Can `node` (or a radius) be planted at `p` wanting `want_ground`?
func can_place(p: Vector2, want_ground: String = "land", radius: float = -1.0, ignore: Node = null) -> bool:
	var r := radius if radius > 0.0 else DEFAULT_FOOTPRINT
	# 1) right kind of ground
	if want_ground == "water":
		if not is_water(p):
			return false
	else:
		if not on_ground_x(p.x):
			return false
		if is_water(p):
			return false
		# 2) buildings want a level-enough patch
		if want_ground == "level" and slope_at(p.x) > LEVEL_SLOPE_MAX:
			return false
	# 3) footprint overlap — nestling allowed (up to the tolerance), stacking not
	for o in occupants:
		if o["node"] == ignore or not is_instance_valid(o["node"]):
			continue
		var min_d: float = (r + float(o["radius"])) * OVERLAP_TOLERANCE
		if p.distance_to(o["pos"]) < min_d:
			return false
	return true


# The footprint radius a module declares (mature size), read defensively.
func _radius_of(node: Object) -> float:
	if node and ("footprint_radius" in node):
		var v: float = node.get("footprint_radius")
		if v > 0.0:
			return v
	return DEFAULT_FOOTPRINT


# ===========================================================================
#  adaptation Context  (§2.3a — things are composed by their surroundings)
# ===========================================================================

# Build the Context dict a freshly-placed ProcNode receives so it can tint to
# the local palette, lean to the light, scale by elevation and nestle by its
# neighbours. `light_dir` is supplied by WorldStage (sun by day, Heart by night).
func build_context(p: Vector2, light_dir: Vector2, extra: Dictionary = {}) -> Dictionary:
	var e := extents()
	var span: float = max(1.0, e.y - e.x)
	# elevation: how high above the lowest nearby ground, 0..1 (windswept outer/high)
	var here := surface_point(p.x).y
	var low: float = max(surface_point(e.x + span * 0.3).y, surface_point(e.y - span * 0.3).y)
	var elevation: float = clampf((low - here) / 120.0, 0.0, 1.0)
	# outer-ness: near the lip of the island → a touch smaller / more exposed
	var mid := (e.x + e.y) * 0.5
	var outerness: float = clampf(absf(p.x - mid) / (span * 0.5), 0.0, 1.0)

	# local palette: the realm harmony nudged by a position-seeded local hue, so a
	# flower in a cool hollow runs cooler than the same flower in the warm start.
	var lp := _local_palette(p)

	# neighbours within ~1.5 footprints (for nestle + complementary phase desync)
	var near: Array = []
	for o in occupants:
		if not is_instance_valid(o["node"]):
			continue
		var d: float = p.distance_to(o["pos"])
		if d < (float(o["radius"]) + DEFAULT_FOOTPRINT) * 1.5:
			near.append({"pos": o["pos"], "radius": o["radius"], "dist": d})

	var ctx := {
		"world_seed": world_seed,
		"realm_id": realm_id,
		"local_palette": lp,
		"light_dir": light_dir.normalized(),
		"light_point": extra.get("light_point", Vector2(p.x, here - 600.0)),
		"elevation": elevation,
		"outerness": outerness,
		"scale_hint": clampf(1.0 - outerness * 0.14 + elevation * 0.0, 0.8, 1.06),
		"neighbours": near,
		"ground_type": ground_type_at(p),
		"surface_normal": surface_normal(p.x),
	}
	for k in extra.keys():
		if not ctx.has(k):
			ctx[k] = extra[k]
	return ctx


# A realm palette drifted by a position-seeded local hue (blend ~25% local).
func _local_palette(p: Vector2) -> Dictionary:
	var base := Proc.palette(world_seed, realm_id)
	var lh := Proc.hashf(world_seed, "gp:lh:%d:%d" % [int(round(p.x / 90.0)), int(round(p.y / 90.0))])
	var drift := Color.from_hsv(lh, 0.30, 0.9)
	var out := base.duplicate(true)
	for role in ["base", "base_dk", "base_lt", "accent", "accent_dk", "soil"]:
		if out.has(role) and out[role] is Color:
			out[role] = (out[role] as Color).lerp(drift, 0.25)
	return out


# ===========================================================================
#  a Callable ground sampler for the puzzle system (ground_y at space-x)
# ===========================================================================

func sampler() -> Callable:
	return func(x: float) -> float: return surface_y(x)
