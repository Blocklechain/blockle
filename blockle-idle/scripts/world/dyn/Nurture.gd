class_name Nurture
extends Node2D
# Nurture — THE CARING VERBS, DEEPENED (DYNAMICS §6.7).
#
# This is the "things to do" layer of the calm island: four small, tactile, drawn
# interactions that each have a real but gentle effect, plus the weather and season
# interplay that gives them meaning, plus the long quiet road from "a plant you
# planted" to "a Beloved thing with a halo".
#
#   WATER   — a stone WELL stands on the island. Tap it and a drawn watering can
#             lifts into your hand; carry it to a plant and let go: the can tilts,
#             a stream ARCS from its spout, the ground darkens, the plant visibly
#             PERKS and grows a little. The can holds four pours and then lives
#             wherever you set it down, waiting in the grass.
#             (Also available as a `water` verb on the action bubble.)
#   PRUNE   — choose `prune` on a mature plant and a pair of drawn SHEARS comes to
#             your finger. Drag across the crown: each pass snips a leaf-cluster
#             (it drifts away as motes, the crown re-adapts tidier), and a snip may
#             hand you a CUTTING — a real new seed in your basket.
#   FEED    — offer a bloom or a berry: drag a bloom/berry/loaf out of the tray onto
#             a creature and it hops over, takes three bites, and a heart bubble
#             pops over its head (bond + mood up, via the shared event language).
#             Feeding a plant nudges its growth.
#   WARM    — in winter, frost-rime draws itself around the base of things. Choose
#             `warm` and you STAND A TORCH in the ground: a drawn, flickering torch
#             that keeps everything within its light warm for four hours. Tap a
#             torch to pick it up and move it. Three may burn at once.
#
# Weather & seasons (the heart of it): rain and Bloomtide swells AUTO-WATER the whole
# island; Highsun shortens a watering; night lengthens it; Stillfrost slows growth
# unless a thing is warm; a storm gently REFUSES pruning and leaves things ruffled —
# and ruffled things are restored by any act of care (never withered, never lost).
#
# SACRED: no panel, no menu, no HUD, no timer shown as a timer. Everything here is a
# bubble, a glow, a mote, a whisper, an in-world object, or an ActionBubble verb.
# Nothing punishes. Nothing expires harshly. Every opportunity waits for you.
#
# STATE: exactly one top-level key — Game.state["nurture"] — every field backfilled
# with .get defaults, so a legacy save with no dyn keys at all loads clean.
#
# PUBLIC API (DYNAMICS §4.2 / §4.4)
#   setup(world_seed, ctx) / catch_up(elapsed) / notify(kind, payload)
#   care_mult(place_id, key) -> float          1.00 .. 1.20
#   is_watered(pid) / is_pruned(pid) / is_warm(pid) -> bool
#   tended(pid) -> int   /   is_beloved(pid) -> bool
#   is_raining() -> bool /   auto_water(seconds, source) -> void   (Rituals/Seasons)
#   offer_hint() -> Dictionary                 (Wishes: a reachable `tend` subject)
#   extra_actions(record) / handle_action(action, record)
#   handle_drop(entry, inst_key, world_pos) / handle_tap(screen_pos, world_pos)
#   signals: whisper(text), dyn_event(kind, payload)

signal whisper(text: String)
signal dyn_event(kind: String, payload: Dictionary)

const SYS_KEY := "nurture"
const SYS_VERSION := 1

# --- care tuning (DYNAMICS §6.7 — copy these numbers, do not invent new ones) ---
const WATER_DUR := 45.0 * 60.0          # a watering lasts 45 min (modified below)
const WATER_GAP := 10.0 * 60.0          # ...and may be repeated every 10 min
const PRUNE_DUR := 90.0 * 60.0
const PRUNE_GAP := 60.0 * 60.0
const WARM_DUR := 4.0 * 3600.0
const PRUNE_GATE := 0.6                 # a plant must be this grown to shape it
const FEED_GROWTH := 0.06
const FEED_GROWTH_RICH := 0.10
const WATER_GROW := 1.20
const PRUNE_YIELD := 1.15
const BELOVED_YIELD := 1.08
const CARE_CAP := 1.20                  # §2.1: care resolves inside 1.00 .. 1.20
const TEND_STEP_BONUS := 0.01           # +1% grow per 10 cares...
const TEND_STEP_CAP := 0.10             # ...up to +10% at 100 cares
const BELOVED_AT := 25
const JOURNAL_AT := 50
const SEEDFALL_AT := 100
const SEEDFALL_GAP := 24.0 * 3600.0

# --- the ask (the pity invitation — never an obligation) ------------------------
const ASK_GAP := 25.0 * 60.0
const ASK_LIFE := 12.0

# --- objects ------------------------------------------------------------------
const CAN_CAPACITY := 4
const MAX_TORCHES := 3
const TORCH_RADIUS := 190.0
const WELL_OFFSET := -170.0             # tx, relative to the Heart Tree
const RESERVED_TX := [-260.0, 300.0]    # Journal Tree / Ritual Circle keep-outs
const SNIPS := 3
const SNIP_REACH := 46.0
const CUT_CHANCE := 0.55
const CUT_PITY := 3
const FEED_REACH := 130.0
const RUFFLE_FADE := 2.0 * 3600.0       # a storm-ruffle relaxes on its own in 2 h

# --- budgets (§2.6 / §8) ------------------------------------------------------
const WHISPER_GAP := 15.0
const MOTE_BUDGET := 24
const TICK := 1.0
const SLOW_TICK := 6.0
const GROW_PER_TICK := 10               # records re-multiplied per tick, round-robin

# --- offline curve (§2.3 — identical to IdleSim.effective_seconds) ------------
const OFFLINE_FULL_HOURS := 8.0
const OFFLINE_CAP_HOURS := 48.0
const OFFLINE_FLOOR := 0.5

const CAP_FOR := {
	"grow": 1.60, "yield": 1.60, "bond": 2.00, "luck": 3.00,
	"cadence": 1.50, "craft": 1.50, "offline": 12.0,
}

# Things that can be watered / pruned at all.
const GREEN_KINDS := {"plant": true, "tree": true, "fungus": true}

# Foods. `rich` ones are the premium feed (Chains' baked goods).
const FOODS := {
	"honeycomb": {"rich": false, "glyph": "berry", "label": "Honeycomb"},
	"grainloaf": {"rich": true, "glyph": "loaf", "label": "Grainloaf"},
	"honeycake": {"rich": true, "glyph": "loaf", "label": "Honeycake"},
	"rootbalm": {"rich": true, "glyph": "berry", "label": "Rootbalm"},
	"emberbloom": {"rich": false, "glyph": "bloom", "label": "Emberbloom"},
	"lichen_wool": {"rich": false, "glyph": "berry", "label": "Lichen Wool"},
}
const WATER_MATS := {"dewdrop": true, "river_clay": false}
const WARM_MATS := {"kindling_lamp": true, "emberbloom": true}

# =============================================================================
# wiring
# =============================================================================
var world_seed: int = 1
var _space: Node = null
var _interact: Node = null
var _sim: Node = null
var _sky: Node = null
var _puzzles: Node = null

var _obj: Node2D = null                 # well / can / torches (world objects)
var _fx: Node2D = null                  # streams, bubbles, motes (transient)

var _acc: float = 0.0
var _slow_acc: float = 0.0
var _rr: int = 0                        # round-robin cursor for grow re-multiply
var _whisper_at: float = 0.0
var _live_motes: Array = []
var _booted: bool = false

# in-world objects we own
var _well: ProcNode = null
var _can: ProcNode = null
var _torch_nodes: Dictionary = {}       # torch_id -> ProcNode
var _halos: Dictionary = {}             # pid -> ProcNode (Beloved halo)
var _rimes: Dictionary = {}             # pid -> Node2D (frost)
var _ask: Dictionary = {}               # {pid, node, at}

# the one gesture Nurture owns directly: something carried in your hand.
# "" (nothing) | "can" | "torch:<id>" | "shears"
var _carry: String = ""
var _carry_node: Node2D = null
var _carry_at: float = 0.0
var _shear_pid: String = ""
var _shear_pts: Array = []              # [{pos: Vector2, cut: bool}]
var _shear_cuts: int = 0
var _fallback_press: Vector2 = Vector2.ZERO
var _fallback_armed: bool = false

var _known_pids: Dictionary = {}         # pid -> true (so `placed` works unwired)


# =============================================================================
# SETUP
# =============================================================================
func setup(seed_value: int, ctx: Dictionary) -> void:
	world_seed = seed_value
	_space = ctx.get("space", null) as Node
	_interact = ctx.get("interact", null) as Node
	_sim = ctx.get("sim", null) as Node
	_puzzles = ctx.get("puzzles", null) as Node
	_sky = ctx.get("sky", null) as Node
	z_index = 2

	_obj = Node2D.new()
	_obj.name = "NurtureObjects"
	_obj.z_index = 1
	add_child(_obj)

	_fx = Node2D.new()
	_fx.name = "NurtureFX"
	_fx.z_index = 26
	add_child(_fx)

	var st: Dictionary = _st()
	# The yield seam (§7.2). If WorldSpace exposes the optional callback we feed it
	# the shared §2.1 product; every system computes the same formula, so whoever
	# registers last produces the same number.
	if _space != null and _space.has_method("set_yield_mult_fn"):
		_space.call("set_yield_mult_fn", Callable(self, "_yield_mult_for_record"))

	_restore_objects(st)
	_seed_known_pids()
	_refresh_all_grow()
	_booted = true
	set_process(true)


func catch_up(elapsed: float) -> void:
	# Everything in this system is a wall-clock stamp, so "catching up" is really
	# "notice what quietly finished while you were away" — never a loss.
	if not (Game and Game.state is Dictionary):
		return
	var st: Dictionary = _st()
	var now: float = _now()
	var eff: float = _effective(elapsed)
	st["away"] = float(st.get("away", 0.0)) + eff
	# torches burn in real time; gutter the dead ones quietly
	_torch_sweep(true)
	# storm-ruffles relax on their own
	var care: Dictionary = st["care"]
	for key in care.keys():
		var pid: String = String(key)
		var c: Dictionary = care[pid]
		if float(c.get("ruffled", 0.0)) > 0.0 and now - float(c.get("ruffled", 0.0)) > RUFFLE_FADE:
			c["ruffled"] = 0.0
	# the things you love best drop a seed while you are away (once per day each)
	var fell: int = _seedfall_sweep()
	_prune_care_entries()
	_refresh_all_grow()
	_refresh_frost(true)
	if fell > 0:
		_say("Something you tend dropped a seed while you were away.")


# =============================================================================
# STATE  (one key, every field backfilled — a legacy save must load clean)
# =============================================================================
func _st() -> Dictionary:
	if not (Game and Game.state is Dictionary):
		return {}
	if not Game.state.has(SYS_KEY) or not (Game.state[SYS_KEY] is Dictionary):
		Game.state[SYS_KEY] = {}
	var st: Dictionary = Game.state[SYS_KEY]
	st["version"] = int(st.get("version", SYS_VERSION))
	st["seq"] = int(st.get("seq", 0))
	if not (st.get("pity") is Dictionary):
		st["pity"] = {}
	var pity: Dictionary = st["pity"]
	pity["ask"] = float(pity.get("ask", 0.0))
	pity["cutting"] = int(pity.get("cutting", 0))
	if not (st.get("care") is Dictionary):
		st["care"] = {}
	if not (st.get("auto") is Dictionary):
		st["auto"] = {}
	var auto: Dictionary = st["auto"]
	auto["rain_until"] = float(auto.get("rain_until", 0.0))
	auto["source"] = String(auto.get("source", ""))
	if not (st.get("well") is Dictionary):
		st["well"] = {}
	var well: Dictionary = st["well"]
	well["planted"] = bool(well.get("planted", false))
	well["tx"] = float(well.get("tx", WELL_OFFSET))
	if not (st.get("can") is Dictionary):
		st["can"] = {}
	var can: Dictionary = st["can"]
	can["out"] = bool(can.get("out", false))
	can["tx"] = float(can.get("tx", 0.0))
	can["water"] = int(can.get("water", CAN_CAPACITY))
	if not (st.get("torches") is Array):
		st["torches"] = []
	if not (st.get("stats") is Dictionary):
		st["stats"] = {}
	var stats: Dictionary = st["stats"]
	stats["water"] = int(stats.get("water", 0))
	stats["prune"] = int(stats.get("prune", 0))
	stats["feed"] = int(stats.get("feed", 0))
	stats["warm"] = int(stats.get("warm", 0))
	stats["cuttings"] = int(stats.get("cuttings", 0))
	if not (st.get("said") is Dictionary):
		st["said"] = {}
	st["last_care"] = float(st.get("last_care", 0.0))
	st["away"] = float(st.get("away", 0.0))
	return st


# A care record, created on demand.
func _care(pid: String) -> Dictionary:
	var st: Dictionary = _st()
	if st.is_empty() or pid == "":
		return {}
	var care: Dictionary = st["care"]
	if not (care.get(pid) is Dictionary):
		care[pid] = {}
	var c: Dictionary = care[pid]
	c["watered"] = float(c.get("watered", 0.0))
	c["water_until"] = float(c.get("water_until", 0.0))
	c["pruned"] = float(c.get("pruned", 0.0))
	c["prune_until"] = float(c.get("prune_until", 0.0))
	c["fed"] = float(c.get("fed", 0.0))
	c["warmed"] = float(c.get("warmed", 0.0))
	c["warm_until"] = float(c.get("warm_until", 0.0))
	c["ruffled"] = float(c.get("ruffled", 0.0))
	c["tended"] = int(c.get("tended", 0))
	c["beloved"] = bool(c.get("beloved", false))
	c["seedfall"] = float(c.get("seedfall", 0.0))
	return c


# Read-only peek that never creates an entry (queries must stay cheap + pure).
func _care_ro(pid: String) -> Dictionary:
	if not (Game and Game.state is Dictionary):
		return {}
	var root: Dictionary = Game.state.get(SYS_KEY, {}) as Dictionary
	var care: Dictionary = root.get("care", {}) as Dictionary
	var c: Dictionary = care.get(pid, {}) as Dictionary
	return c


# §2.5 — the persisted-counter RNG. Rolls reproduce from the save, not the clock.
func _rand(tag: String) -> float:
	var st: Dictionary = _st()
	if st.is_empty():
		return Proc.hashf(world_seed, "%s:%s" % [SYS_KEY, tag])
	var n: int = int(st.get("seq", 0))
	st["seq"] = n + 1
	return Proc.hashf(world_seed, "%s:%s:%d" % [SYS_KEY, tag, n])


# §2.2 — nothing is ever only luck.
func _roll(tag: String, chance: float, pity_field: String, pity_max: int) -> bool:
	var st: Dictionary = _st()
	if st.is_empty():
		return false
	var pity: Dictionary = st["pity"]
	var n: int = int(pity.get(pity_field, 0))
	var forced: bool = n >= pity_max
	var hit: bool = forced or _rand(tag) < chance * _luck()
	pity[pity_field] = 0 if hit else n + 1
	return hit


func _luck() -> float:
	var d: Node = _sib("Discovery")
	if d != null and d.has_method("luck_mult"):
		return clampf(float(d.call("luck_mult")), 0.5, float(CAP_FOR["luck"]))
	return 1.0


func _dirty() -> void:
	if Game and Game.has_signal("state_dirty"):
		Game.emit_signal("state_dirty")


# =============================================================================
# THE QUERY SURFACE  (§4.4 — this is Nurture's half of the contract)
# =============================================================================
# care contributes 1.00 .. 1.20 and NEVER a penalty (§2.1 floor law).
func care_mult(place_id: String, key: String) -> float:
	if place_id == "":
		return 1.0
	var c: Dictionary = _care_ro(place_id)
	if c.is_empty():
		return 1.0
	var ruffled: bool = _is_ruffled(c)
	var m: float = 1.0
	match key:
		"grow":
			if not ruffled and _watered_c(place_id, c):
				m *= WATER_GROW
			# the long quiet progression: +1% per ten cares, capped at +10%
			var t: int = int(c.get("tended", 0))
			m *= 1.0 + minf(TEND_STEP_CAP, TEND_STEP_BONUS * float(t / 10))
			# a warmed thing shrugs off Stillfrost's slow (the only sub-1.0 in the game)
			if _is_winter() and _warm_c(place_id, c):
				m *= _frost_relief()
		"yield":
			if not ruffled and _pruned_c(c):
				m *= PRUNE_YIELD
			if bool(c.get("beloved", false)):
				m *= BELOVED_YIELD
		_:
			m = 1.0
	if ruffled:
		m = minf(m, 1.0)        # a storm-ruffled thing simply rests; never a loss
	return clampf(m, 1.0, CARE_CAP)


func is_watered(place_id: String) -> bool:
	if is_raining():
		return true
	return _watered_c(place_id, _care_ro(place_id))


func is_pruned(place_id: String) -> bool:
	return _pruned_c(_care_ro(place_id))


func is_warm(place_id: String) -> bool:
	return _warm_c(place_id, _care_ro(place_id))


func tended(place_id: String) -> int:
	var c: Dictionary = _care_ro(place_id)
	return int(c.get("tended", 0))


func is_beloved(place_id: String) -> bool:
	var c: Dictionary = _care_ro(place_id)
	return bool(c.get("beloved", false))


# Rain (real weather, a Bloomtide swell, or the Rite of Rain) waters everything.
func is_raining() -> bool:
	if not (Game and Game.state is Dictionary):
		return false
	var root: Dictionary = Game.state.get(SYS_KEY, {}) as Dictionary
	var auto: Dictionary = root.get("auto", {}) as Dictionary
	if _now() < float(auto.get("rain_until", 0.0)):
		return true
	return _wet_weather()


# Anyone may make it rain on the garden: SeasonsEvents' Bloomtide swell, the Rite of
# Rain, a solved Bloomtide puzzle, the Quiet Rain arc's daily gift.
func auto_water(seconds: float, source: String = "") -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	var auto: Dictionary = st["auto"]
	var until: float = maxf(float(auto.get("rain_until", 0.0)), _now() + maxf(0.0, seconds))
	auto["rain_until"] = until
	auto["source"] = source
	_refresh_all_grow()


# Wishes asks this for a `tend` wish that lands on something visibly asking.
func offer_hint() -> Dictionary:
	var pick: Dictionary = _neediest()
	if pick.is_empty():
		return {}
	return {
		"place_id": String(pick.get("id", "")),
		"verb": String(pick.get("verb", "water")),
		"label": String(pick.get("label", "")),
	}


func care_total() -> int:
	var st: Dictionary = _st()
	if st.is_empty():
		return 0
	var stats: Dictionary = st["stats"]
	return int(stats.get("water", 0)) + int(stats.get("prune", 0)) \
		+ int(stats.get("feed", 0)) + int(stats.get("warm", 0))


# =============================================================================
# internal predicates
# =============================================================================
func _watered_c(pid: String, c: Dictionary) -> bool:
	if c.is_empty():
		return is_raining()
	if _now() < float(c.get("water_until", 0.0)):
		return true
	if pid != "" and is_raining():
		return true
	return false


func _pruned_c(c: Dictionary) -> bool:
	if c.is_empty():
		return false
	return _now() < float(c.get("prune_until", 0.0))


func _warm_c(pid: String, c: Dictionary) -> bool:
	if not c.is_empty() and _now() < float(c.get("warm_until", 0.0)):
		return true
	# the Rite of Warmth warms everything
	var r: Node = _sib("Rituals")
	if r != null and r.has_method("is_active") and bool(r.call("is_active", "warmth")):
		return true
	if pid == "":
		return false
	# ...and so does standing inside a torch's light
	var rec: Dictionary = _rec(pid)
	if rec.is_empty():
		return false
	var tx: float = float(rec.get("tx", 0.0))
	for item in _torches():
		var tr: Dictionary = item
		if float(tr.get("until", 0.0)) <= _now():
			continue
		if absf(float(tr.get("tx", 0.0)) - tx) <= TORCH_RADIUS:
			return true
	return false


func _is_ruffled(c: Dictionary) -> bool:
	if c.is_empty():
		return false
	var at: float = float(c.get("ruffled", 0.0))
	if at <= 0.0:
		return false
	return _now() - at < RUFFLE_FADE


# Divide Stillfrost's slow back out for this one warmed thing (never above +10%).
func _frost_relief() -> float:
	var s: Node = _sib("SeasonsEvents")
	var mod: float = 0.92
	if s != null and s.has_method("modifier"):
		mod = clampf(float(s.call("modifier", "grow")), 0.8, 1.0)
	if mod >= 0.999:
		return 1.0
	return clampf(1.0 / mod, 1.0, 1.10)


# =============================================================================
# THE SHARED MULTIPLIER FORMULA  (§2.1 — every sibling query guarded + optional)
# =============================================================================
func _mult(key: String, place_id: String) -> float:
	var m: float = 1.0
	var s: Node = _sib("SeasonsEvents")
	if s != null and s.has_method("modifier"):
		m *= float(s.call("modifier", key))
	var r: Node = _sib("Rituals")
	if r != null and r.has_method("blessing"):
		m *= float(r.call("blessing", key))
	m *= care_mult(place_id, key)
	var c: Node = _sib("CreatureLife")
	if c != null:
		if c.has_method("job_mult"):
			m *= float(c.call("job_mult", place_id, key))
		if c.has_method("bond_mult"):
			m *= float(c.call("bond_mult", place_id, key))
	var d: Node = _sib("Discovery")
	if d != null and d.has_method("variant_mult"):
		m *= float(d.call("variant_mult", place_id, key))
	return clampf(m, 0.92, float(CAP_FOR.get(key, 1.6)))


func _sib(n: String) -> Node:
	var p: Node = get_parent()
	if p == null:
		return null
	return p.get_node_or_null(n)


func _season_id() -> String:
	var s: Node = _sib("SeasonsEvents")
	if s != null and s.has_method("season_id"):
		return String(s.call("season_id"))
	return ""


func _is_winter() -> bool:
	return _season_id() == "stillfrost"


func _is_night() -> bool:
	var s: Node = _sib("SeasonsEvents")
	if s != null and s.has_method("is_night"):
		return bool(s.call("is_night"))
	# fall back to the living sky's own clock
	if _sky != null and _sky.has_method("get_time_of_day"):
		var tod: float = float(_sky.call("get_time_of_day"))
		return tod > 0.78 or tod < 0.10
	return false


func _weather() -> String:
	var s: Node = _sib("SeasonsEvents")
	if s != null and s.has_method("weather"):
		var w: String = String(s.call("weather"))
		if w != "":
			return w
	if _sky != null:
		var v: Variant = _sky.get("weather")
		if v != null:
			return String(v)
	return "clear"


func _wet_weather() -> bool:
	var w: String = _weather()
	return w == "rain" or w == "storm" or w == "showers" or w == "bloomtide"


func _is_storm() -> bool:
	return _weather() == "storm"


# Is a creature with this profession standing near `world_pos`?
func _job_near(job: String, world_pos: Vector2, radius: float) -> bool:
	var c: Node = _sib("CreatureLife")
	if c == null:
		return false
	if c.has_method("nearest"):
		var near: Dictionary = c.call("nearest", world_pos, job) as Dictionary
		if not near.is_empty():
			var p: Vector2 = near.get("pos", Vector2(1e9, 1e9))
			return p.distance_to(world_pos) <= radius
	if c.has_method("creatures"):
		var arr: Array = c.call("creatures") as Array
		for item in arr:
			var cr: Dictionary = item
			if String(cr.get("job", "")) != job:
				continue
			var p2: Vector2 = cr.get("pos", Vector2(1e9, 1e9))
			if p2.distance_to(world_pos) <= radius:
				return true
	return false


# =============================================================================
# RECORDS  (§7.1 — never cache a node pointer; always re-validate)
# Works through the designed §9.2 accessors when they exist, and falls back to the
# accessors WorldSpace already exposes publicly today, so Nurture is alive either way.
# =============================================================================
func _records() -> Array:
	var out: Array = []
	if _space == null:
		return out
	if _space.has_method("records"):
		var arr: Array = _space.call("records") as Array
		for item in arr:
			var r: Dictionary = item
			if not (r.get("node") is ProcNode) or not is_instance_valid(r["node"]):
				continue
			out.append(r)
		return out
	# --- fallback: rebuild light records from the entity layer + the save --------
	if not _space.has_method("entity_layer"):
		return out
	var layer: Node = _space.call("entity_layer") as Node
	if layer == null:
		return out
	var saved: Dictionary = {}
	if Game and Game.state is Dictionary:
		saved = Game.state.get("placements", {}) as Dictionary
	var ox: float = _origin_x()
	for child in layer.get_children():
		if not (child is ProcNode):
			continue
		var node: ProcNode = child
		var tx: float = node.position.x - ox
		var best_pid: String = ""
		var best_d: float = 9.0
		for key in saved.keys():
			var pid: String = String(key)
			var rec: Dictionary = saved[pid]
			var d: float = absf(float(rec.get("tx", 0.0)) - tx)
			if d < best_d:
				best_d = d
				best_pid = pid
		if best_pid == "":
			continue
		var entry: Dictionary = saved[best_pid]
		out.append({
			"id": best_pid, "node": node, "tx": tx,
			"footprint": _node_fr(node), "minted": bool(entry.get("minted", false)),
			"entry": {
				"kind": String(entry.get("kind", "plant")),
				"species": String(entry.get("species", "")),
				"building_id": String(entry.get("building_id", "")),
				"label": String(entry.get("label", "")),
				"minted": bool(entry.get("minted", false)),
			},
		})
	return out


func _rec(place_id: String) -> Dictionary:
	if _space != null and _space.has_method("record_by_id"):
		return _space.call("record_by_id", place_id) as Dictionary
	for item in _records():
		var r: Dictionary = item
		if String(r.get("id", "")) == place_id:
			return r
	return {}


# The placed thing nearest a world point (a tolerant capsule around its body).
func _rec_at_world(wp: Vector2, pad: float = 0.0) -> Dictionary:
	var best: Dictionary = {}
	var best_d: float = INF
	for item in _records():
		var r: Dictionary = item
		var node: ProcNode = r["node"]
		var base: Vector2 = node.position
		var fr: float = float(r.get("footprint", 24.0))
		var bh: float = maxf(fr * 2.4, 70.0)
		var dx: float = absf(wp.x - base.x)
		if dx > fr * 1.2 + pad:
			continue
		if wp.y > base.y + 16.0 + pad or wp.y < base.y - bh - pad:
			continue
		var d: float = dx + absf((base.y - bh * 0.5) - wp.y) * 0.3
		if d < best_d:
			best_d = d
			best = r
	return best


func _node_fr(node: ProcNode) -> float:
	if node == null:
		return 24.0
	var v: Variant = node.get("footprint_radius")
	if v != null:
		return maxf(8.0, float(v))
	return 24.0


func _origin_x() -> float:
	if _space == null:
		return 0.0
	if _space.has_method("ground_origin"):
		var o: Vector2 = _space.call("ground_origin")
		return o.x
	if _space.has_method("heart_foot"):
		var hf: Vector2 = _space.call("heart_foot")
		return hf.x
	return 0.0


func _heart_tx() -> float:
	if _space != null and _space.has_method("heart_tx"):
		return float(_space.call("heart_tx"))
	return 0.0


# Ground point (cam-local, which is also this node's local space) for a terrain-x.
func _ground_point(tx: float) -> Vector2:
	if _space == null:
		return Vector2(tx, 0.0)
	if _space.has_method("ground_origin") and _space.has_method("ground_surface_at"):
		var o: Vector2 = _space.call("ground_origin")
		return o + Vector2(tx, float(_space.call("ground_surface_at", tx)))
	if _space.has_method("snap_ground"):
		return _space.call("snap_ground", Vector2(_origin_x() + tx, 0.0))
	return Vector2(_origin_x() + tx, 0.0)


func _tx_of(world_pos: Vector2) -> float:
	if _space != null and _space.has_method("terrain_x"):
		return float(_space.call("terrain_x", world_pos))
	return world_pos.x - _origin_x()


func _body_h(r: Dictionary) -> float:
	return maxf(float(r.get("footprint", 24.0)) * 2.4, 70.0)


func _crown(r: Dictionary) -> Vector2:
	var node: ProcNode = r["node"]
	return node.position + Vector2(0.0, -_body_h(r) * 0.72)


func _is_green(r: Dictionary) -> bool:
	var entry: Dictionary = r.get("entry", {}) as Dictionary
	return GREEN_KINDS.has(String(entry.get("kind", "")))


func _is_creature(r: Dictionary) -> bool:
	var entry: Dictionary = r.get("entry", {}) as Dictionary
	return String(entry.get("kind", "")) == "creature"


func _label(r: Dictionary) -> String:
	var entry: Dictionary = r.get("entry", {}) as Dictionary
	return ItemCatalog.display_label(entry)


func _species_of(r: Dictionary) -> String:
	var entry: Dictionary = r.get("entry", {}) as Dictionary
	var sp: String = String(entry.get("species", "")).strip_edges().to_lower()
	if sp != "" and sp != "random":
		return sp
	var node: ProcNode = r.get("node") as ProcNode
	if node != null and is_instance_valid(node):
		var v: Variant = node.get("species")
		if v != null and String(v) != "":
			return String(v)
		var k: Variant = node.get("kind")
		if k != null and String(k) != "":
			return String(k)
	return "flower"


func _growth_of(r: Dictionary) -> float:
	var node: ProcNode = r.get("node") as ProcNode
	if node == null or not is_instance_valid(node):
		return 0.0
	return float(node.growth)


func _frozen(r: Dictionary) -> bool:
	if bool(r.get("minted", false)):
		return true
	var entry: Dictionary = r.get("entry", {}) as Dictionary
	if bool(entry.get("minted", false)):
		return true
	var pid: String = String(r.get("id", ""))
	if typeof(Growth) == TYPE_OBJECT and Growth != null and Growth.has_method("is_frozen"):
		if bool(Growth.call("is_frozen", pid)):
			return true
	return false


# =============================================================================
# APPLYING THE MULTIPLIERS  (§7.2 — store the base once, never accumulate)
# =============================================================================
func _refresh_grow(place_id: String) -> void:
	var r: Dictionary = _rec(place_id)
	if r.is_empty():
		return
	_apply_grow(r)


func _apply_grow(r: Dictionary) -> void:
	var node: ProcNode = r.get("node") as ProcNode
	if node == null or not is_instance_valid(node):
		return
	if _frozen(r):
		return                                 # a pressed flower's clock stays stopped
	if not node.has_meta("dyn_base_grow"):
		if node.grow_rate <= 0.0:
			return                             # frozen by some other owner; leave it
		node.set_meta("dyn_base_grow", node.grow_rate)
	var base: float = float(node.get_meta("dyn_base_grow", node.grow_rate))
	if base <= 0.0:
		return
	var want: float = base * _mult("grow", String(r.get("id", "")))
	if absf(want - node.grow_rate) > base * 0.01:
		node.grow_rate = want


func _refresh_all_grow() -> void:
	for item in _records():
		var r: Dictionary = item
		_apply_grow(r)


# The optional WorldSpace yield callback (§9.2). Returns the live §2.1 product.
func _yield_mult_for_record(record: Dictionary) -> float:
	if not (record is Dictionary):
		return 1.0
	return _mult("yield", String(record.get("id", "")))


# =============================================================================
# THE FOUR VERBS
# =============================================================================
# ---- WATER -------------------------------------------------------------------
func water(place_id: String, from_pos: Vector2 = Vector2.ZERO, by_can: bool = false) -> bool:
	var r: Dictionary = _rec(place_id)
	if r.is_empty() or not _is_green(r):
		return false
	if _frozen(r):
		_say("It is held timeless — it needs nothing.")
		return false
	var c: Dictionary = _care(place_id)
	var now: float = _now()
	if now - float(c.get("watered", 0.0)) < WATER_GAP:
		_say("It drank its fill not long ago.")
		return false
	var node: ProcNode = r["node"]
	var dur: float = WATER_DUR * _water_duration_mult(node.position)
	c["watered"] = now
	c["water_until"] = maxf(float(c.get("water_until", 0.0)), now + dur)
	# juice: the stream, the darkened soil, the perk, three falling droplets
	var target: Vector2 = _crown(r)
	var src: Vector2 = from_pos if from_pos != Vector2.ZERO else target + Vector2(-70.0, -90.0)
	_spawn_stream(src, target)
	_spawn_damp(node.position, float(r.get("footprint", 24.0)))
	_perk(node, 0.012 if by_can else 0.008)
	_spawn_motes(target, "droplet", 3)
	_credit_care(place_id, "water", r)
	if by_can:
		_say_once("first_water", "The soil darkens, and the leaves lift a little.")
	return true


func _water_duration_mult(world_pos: Vector2) -> float:
	var m: float = 1.0
	if _season_id() == "highsun":
		m *= 0.55               # summer is when watering actually matters
	if _is_night():
		m *= 1.2                # cool air holds the damp
	if is_raining():
		m *= 2.0                # watering in the rain goes a long, long way
	if _season_id() == "greenrise":
		m *= 1.15
	if _job_near("guardian", world_pos, 220.0):
		m *= 1.25
	return clampf(m, 0.4, 3.0)


# ---- PRUNE -------------------------------------------------------------------
# Choosing `prune` puts SHEARS in your hand; the shaping itself is the gesture.
func prune_begin(place_id: String) -> bool:
	var r: Dictionary = _rec(place_id)
	if r.is_empty() or not _is_green(r):
		return false
	if _frozen(r):
		return false
	if _growth_of(r) < PRUNE_GATE:
		_say("Let it grow a little fuller first.")
		return false
	var c: Dictionary = _care(place_id)
	var now: float = _now()
	if now - float(c.get("pruned", 0.0)) < PRUNE_GAP:
		_say("It is already beautifully shaped.")
		return false
	if _is_storm() and not _job_near("guardian", (r["node"] as ProcNode).position, 220.0):
		_say("The wind is too strong — later.")
		return false
	_begin_shears(r)
	return true


func _begin_shears(r: Dictionary) -> void:
	_end_carry(false)
	var node: ProcNode = r["node"]
	var fr: float = float(r.get("footprint", 24.0))
	var bh: float = _body_h(r)
	_shear_pid = String(r.get("id", ""))
	_shear_cuts = 0
	_shear_pts = []
	for i in range(SNIPS):
		var a: float = -0.9 + 0.9 * float(i)
		var p: Vector2 = node.position + Vector2(sin(a) * fr * 0.62, -bh * (0.52 + 0.14 * float(i % 2)))
		_shear_pts.append({"pos": p, "cut": false})
		var ring: ProcNode = ProcEffects.make_selection_ring(world_seed, "snip:%s:%d" % [_shear_pid, i], {
			"radius": 17.0, "style": "bloom", "ground": false, "z": 24,
			"color": Color(0.72, 0.95, 0.70, 1.0)})
		ring.position = p
		ring.modulate.a = 0.5
		_fx.add_child(ring)
		(_shear_pts[i] as Dictionary)["ring"] = ring
	var shears: _Shears = _Shears.new()
	shears.seedv = hash("%d:shears" % world_seed)
	shears.position = _shear_pts[0]["pos"]
	shears.z_index = 40
	_fx.add_child(shears)
	_carry = "shears"
	_carry_node = shears
	_carry_at = _now()
	_say_once("first_prune", "Shape it with your finger.")


func _shear_move(wp: Vector2) -> void:
	if _carry_node != null and is_instance_valid(_carry_node):
		_carry_node.position = _carry_node.position.lerp(wp, 0.45)
	for i in range(_shear_pts.size()):
		var p: Dictionary = _shear_pts[i]
		if bool(p.get("cut", false)):
			continue
		var pos: Vector2 = p.get("pos", Vector2.ZERO)
		if pos.distance_to(wp) <= SNIP_REACH:
			_snip(i)


func _snip(idx: int) -> void:
	if idx < 0 or idx >= _shear_pts.size():
		return
	var p: Dictionary = _shear_pts[idx]
	if bool(p.get("cut", false)):
		return
	p["cut"] = true
	_shear_cuts += 1
	var pos: Vector2 = p.get("pos", Vector2.ZERO)
	var ring: Variant = p.get("ring", null)
	if ring != null and is_instance_valid(ring) and (ring as Node).has_method("fade_out"):
		(ring as Node).call("fade_out", 0.25)
	if _carry_node != null and is_instance_valid(_carry_node) and _carry_node.has_method("snip"):
		_carry_node.call("snip")
	_spawn_motes(pos, "leaf", 4)
	var r: Dictionary = _rec(_shear_pid)
	if r.is_empty():
		_end_carry(false)
		return
	# the first snip is what earns the shaping buff — pruning always pays
	if _shear_cuts == 1:
		var c: Dictionary = _care(_shear_pid)
		var now: float = _now()
		var dur: float = PRUNE_DUR * (1.2 if _season_id() == "emberfall" else 1.0) \
			* (1.15 if _season_id() == "greenrise" else 1.0) \
			* (1.25 if _job_near("guardian", (r["node"] as ProcNode).position, 220.0) else 1.0)
		c["pruned"] = now
		c["prune_until"] = maxf(float(c.get("prune_until", 0.0)), now + dur)
		# re-adapt for a tidier crown — the art module decides what "pruned" means
		_adapt(r, {"pruned": true})
		_credit_care(_shear_pid, "prune", r)
	# a snip may hand you a cutting: a real new seed in the basket
	if _roll("cut:%s:%d" % [_shear_pid, _shear_cuts], CUT_CHANCE, "cutting", CUT_PITY):
		_give_cutting(r)
	if _shear_cuts >= SNIPS:
		_end_carry(true)


func _give_cutting(r: Dictionary) -> void:
	var sp: String = _species_of(r)
	var entry: Dictionary = r.get("entry", {}) as Dictionary
	var kind: String = String(entry.get("kind", "plant"))
	var label: String = "%s Cutting" % sp.capitalize()
	var item_key: String = "seed:%s" % sp
	_grant(item_key, {
		"count": 0, "kind": kind, "species": sp, "label": label,
		"growth": -1.0, "minted": false,
	}, 1)
	var st: Dictionary = _st()
	if not st.is_empty():
		var stats: Dictionary = st["stats"]
		stats["cuttings"] = int(stats.get("cuttings", 0)) + 1
	var node: ProcNode = r.get("node") as ProcNode
	if node != null and is_instance_valid(node):
		_spawn_bubble(node.position + Vector2(0.0, -_body_h(r) - 20.0), "leaf", 3.4)
	_say("A cutting — it will root if you plant it.")
	emit_signal("dyn_event", "cutting", {"place_id": String(r.get("id", "")), "species": sp, "item_key": item_key})


# ---- FEED --------------------------------------------------------------------
# Offer a bloom, a berry, a loaf. Creatures eat; plants drink it in and grow.
func feed(place_id: String, food: Dictionary = {}, item_key: String = "") -> bool:
	var r: Dictionary = _rec(place_id)
	if r.is_empty():
		return false
	if _frozen(r):
		_say("It is held timeless — it needs nothing.")
		return false
	var rich: bool = false
	var glyph: String = "bloom"
	var paid: bool = false
	if not food.is_empty():
		var def: Dictionary = _food_def(food)
		if bool(def.get("ok", false)):
			rich = bool(def.get("rich", false))
			glyph = String(def.get("glyph", "bloom"))
			paid = true
	if not paid:
		# the premium feed first (Chains' baked goods), else a pinch of essence
		if _take_mat("rootbalm", 1):
			rich = true
			glyph = "berry"
			paid = true
		elif _take_mat("grainloaf", 1):
			rich = true
			glyph = "loaf"
			paid = true
		elif Game and Game.can_afford({"essence": 6.0}):
			Game.spend({"essence": 6.0})
			paid = true
	if not paid:
		_say("It would like something to eat — a bloom, a berry, a loaf.")
		return false
	var node: ProcNode = r["node"]
	var c: Dictionary = _care(place_id)
	c["fed"] = _now()
	if _is_creature(r):
		_offer_to_creature(r, glyph, rich)
	else:
		var bump: float = FEED_GROWTH_RICH if rich else FEED_GROWTH
		node.grow_to(minf(1.0, float(node.growth) + bump), 0.9)
		_spawn_ring(node.position, float(r.get("footprint", 24.0)) * 1.25, Color(1.0, 0.92, 0.66))
		_spawn_motes(_crown(r), "sparkle", 2)
	_credit_care(place_id, "feed", r)
	if rich:
		var c2: Dictionary = _care(place_id)
		c2["tended"] = int(c2.get("tended", 0)) + 1      # a rich feed counts double
		_check_milestones(place_id, r)
	emit_signal("dyn_event", "fed", {"place_id": place_id, "rich": rich,
		"creature": _is_creature(r), "at": _now()})
	return true


func _offer_to_creature(r: Dictionary, glyph: String, rich: bool) -> void:
	var node: ProcNode = r["node"]
	var fr: float = float(r.get("footprint", 24.0))
	var off: _Offering = _Offering.new()
	off.seedv = hash("%d:offer:%s" % [world_seed, String(r.get("id", ""))])
	off.glyph = glyph
	off.position = node.position + Vector2(fr * 0.9, -fr * 0.9)
	off.z_index = 24
	_fx.add_child(off)
	off.eat(2.1 if rich else 1.7)
	# a little hop toward the food, then the heart
	if node is Node2D:
		var tw: Tween = node.create_tween().set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_OUT)
		var home: Vector2 = node.position
		tw.tween_property(node, "position", home + Vector2(fr * 0.28, -6.0), 0.22)
		tw.tween_property(node, "position", home + Vector2(fr * 0.28, 0.0), 0.16)
		tw.tween_interval(1.1)
		tw.tween_property(node, "position", home, 0.5)
	_spawn_motes(off.position, "crumb", 3)
	_spawn_bubble(node.position + Vector2(0.0, -_body_h(r) - 18.0), "heart", 4.2)


# ---- WARM --------------------------------------------------------------------
# Stand a torch in the ground. Everything in its light shrugs off the frost.
func warm(place_id: String) -> bool:
	var r: Dictionary = _rec(place_id)
	if r.is_empty():
		return false
	if _frozen(r):
		return false
	if not (_is_winter() or _is_night() or _frost_touched(r)):
		_say("Nothing here is cold just now.")
		return false
	var c: Dictionary = _care(place_id)
	var now: float = _now()
	if now < float(c.get("warm_until", 0.0)):
		_say("It is already warm.")
		return false
	var paid: bool = false
	if _take_mat("kindling_lamp", 1):
		paid = true
	elif Game and Game.can_afford({"essence": 10.0}):
		Game.spend({"essence": 10.0})
		paid = true
	if not paid:
		_say("A torch needs a little essence, or kindling.")
		return false
	var node: ProcNode = r["node"]
	c["warmed"] = now
	c["warm_until"] = now + WARM_DUR
	_plant_torch(float(r.get("tx", _tx_of(node.position))) + float(r.get("footprint", 24.0)) + 26.0)
	_clear_rime(place_id, true)
	_spawn_motes(node.position + Vector2(0.0, -20.0), "ember", 3)
	_credit_care(place_id, "warm", r)
	return true


func _frost_touched(r: Dictionary) -> bool:
	if not _is_green(r):
		return false
	if not (_is_winter() or (_is_night() and _weather() == "mist")):
		return false
	return not is_warm(String(r.get("id", "")))


# ---- the shared bookkeeping for every successful care -------------------------
func _credit_care(place_id: String, verb: String, r: Dictionary) -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	var c: Dictionary = _care(place_id)
	var now: float = _now()
	c["tended"] = int(c.get("tended", 0)) + 1
	c["ruffled"] = 0.0                       # any care straightens a storm-ruffled thing
	st["last_care"] = now
	var stats: Dictionary = st["stats"]
	if stats.has(verb):
		stats[verb] = int(stats.get(verb, 0)) + 1
	_refresh_grow(place_id)
	_check_milestones(place_id, r)
	_dismiss_ask()
	emit_signal("dyn_event", _verb_event(verb), {
		"place_id": place_id, "entry": r.get("entry", {}), "verb": verb, "at": now})
	# Wishes counts tend-verbs; tell it directly too (it may not be listening yet)
	var w: Node = _sib("Wishes")
	if w != null and w.has_method("note_progress"):
		w.call("note_progress", "tend", {"place_id": place_id, "verb": verb})
	# care near a gardener lifts its mood (CreatureLife honours the event)
	var node: ProcNode = r.get("node") as ProcNode
	if node != null and is_instance_valid(node):
		emit_signal("dyn_event", "care_near", {"pos": node.position, "radius": 200.0, "verb": verb})
	if Game:
		Game.save_now()


func _verb_event(verb: String) -> String:
	match verb:
		"water": return "watered"
		"prune": return "pruned"
		"feed": return "fed"
		"warm": return "warmed"
	return verb


func _check_milestones(place_id: String, r: Dictionary) -> void:
	var c: Dictionary = _care(place_id)
	var t: int = int(c.get("tended", 0))
	if t >= BELOVED_AT and not bool(c.get("beloved", false)):
		c["beloved"] = true
		_ensure_halo(place_id)
		_say("It has become beloved.")
		emit_signal("dyn_event", "tended_milestone", {"place_id": place_id, "tended": t, "beloved": true})
	elif t % 10 == 0:
		emit_signal("dyn_event", "tended_milestone", {"place_id": place_id, "tended": t,
			"beloved": bool(c.get("beloved", false))})
	if t == JOURNAL_AT:
		var d: Node = _sib("Discovery")
		var sp: String = _species_of(r)
		if d != null and d.has_method("discover"):
			d.call("discover", "care:well_tended", {"category": "care", "tier": "common",
				"label": "Well-tended", "species": sp})
		_say("Fifty acts of care. The journal remembers.")


# =============================================================================
# THE WELL + THE WATERING CAN  (the drawn, carried, pourable interaction)
# =============================================================================
func _restore_objects(st: Dictionary) -> void:
	if st.is_empty():
		return
	var well: Dictionary = st["well"]
	if bool(well.get("planted", false)):
		_build_well(float(well.get("tx", WELL_OFFSET)), false)
	var can: Dictionary = st["can"]
	if bool(can.get("out", false)):
		_build_can(float(can.get("tx", 0.0)))
	for item in _torches():
		var tr: Dictionary = item
		if float(tr.get("until", 0.0)) > _now():
			_build_torch(String(tr.get("id", "")), float(tr.get("tx", 0.0)), false)
	_torch_sweep(false)


# The well arrives the first time there is anything to water (diegetic, unfurling).
func _ensure_well() -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	var well: Dictionary = st["well"]
	if bool(well.get("planted", false)):
		if _well == null or not is_instance_valid(_well):
			_build_well(float(well.get("tx", WELL_OFFSET)), false)
		return
	var green: int = 0
	for item in _records():
		var r: Dictionary = item
		if _is_green(r):
			green += 1
	if green <= 0:
		return
	var tx: float = _free_tx(_heart_tx() + WELL_OFFSET + Proc.rangef(world_seed, "well:tx", -40.0, 40.0))
	well["planted"] = true
	well["tx"] = tx
	_build_well(tx, true)
	_say("A well wakes at the island's heart. Its water is yours.")
	if Game:
		Game.save_now()


func _build_well(tx: float, fresh: bool) -> void:
	if _well != null and is_instance_valid(_well):
		_well.queue_free()
	var w: _Well = _Well.new()
	w.seedv = hash("%d:well" % world_seed)
	w.pal = Proc.palette(world_seed, "well")
	w.position = _ground_point(tx)
	w.z_index = 1
	_obj.add_child(w)
	if fresh:
		w.set_growth(0.0)
		w.grow_to(1.0, 2.4)
	else:
		w.set_growth(1.0)
	w.grow_rate = 0.0
	_well = w


func _build_can(tx: float) -> void:
	if _can != null and is_instance_valid(_can):
		_can.queue_free()
	var st: Dictionary = _st()
	var can_st: Dictionary = st.get("can", {}) as Dictionary
	var c: _Can = _Can.new()
	c.seedv = hash("%d:can" % world_seed)
	c.pal = Proc.palette(world_seed, "can")
	c.water = int(can_st.get("water", CAN_CAPACITY))
	c.set_growth(1.0)
	c.grow_rate = 0.0
	c.position = _ground_point(tx)
	c.z_index = 22
	_obj.add_child(c)
	_can = c


func _lift_can(wp: Vector2) -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	var can_st: Dictionary = st["can"]
	if _can == null or not is_instance_valid(_can):
		_build_can(_tx_of(wp))
	can_st["out"] = true
	_end_carry(false)
	_carry = "can"
	_carry_node = _can
	_carry_at = _now()
	if _can != null:
		_can.position = wp
		_can.z_index = 44
	_highlight_thirsty(true)
	if _can_water() <= 0:
		_say("The can is dry — dip it in the well.")
	else:
		_say_once("first_can", "Carry it to something green and let go.")


func _refill_can() -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	var can_st: Dictionary = st["can"]
	can_st["water"] = CAN_CAPACITY
	if _can != null and is_instance_valid(_can):
		if _can.has_method("set_water"):
			_can.call("set_water", CAN_CAPACITY)
		_spawn_motes(_can.position, "droplet", 3)


func _pour_on(r: Dictionary) -> bool:
	var st: Dictionary = _st()
	if st.is_empty():
		return false
	var can_st: Dictionary = st["can"]
	var left: int = int(can_st.get("water", 0))
	if left <= 0:
		_say("The can is dry — dip it in the well.")
		return false
	var spout: Vector2 = Vector2.ZERO
	if _can != null and is_instance_valid(_can):
		spout = _can.position + Vector2(18.0, -16.0)
		if _can.has_method("tip"):
			_can.call("tip")
	if not water(String(r.get("id", "")), spout, true):
		return false
	can_st["water"] = maxi(0, left - 1)
	if _can != null and is_instance_valid(_can) and _can.has_method("set_water"):
		_can.call("set_water", int(can_st["water"]))
	return true


# A gentle bloom on everything that would like a drink, while the can is in hand.
func _highlight_thirsty(on: bool) -> void:
	if not on:
		for key in _halos.keys():
			var pid: String = String(key)
			if String(pid).begins_with("thirsty:"):
				var n: Variant = _halos[pid]
				if n != null and is_instance_valid(n) and (n as Node).has_method("fade_out"):
					(n as Node).call("fade_out", 0.3)
				_halos.erase(pid)
		return
	var shown: int = 0
	for item in _records():
		var r: Dictionary = item
		if shown >= 10:
			break
		if not _is_green(r) or _frozen(r):
			continue
		var pid: String = String(r.get("id", ""))
		if is_watered(pid):
			continue
		var key2: String = "thirsty:%s" % pid
		if _halos.has(key2):
			continue
		var node: ProcNode = r["node"]
		var ring: ProcNode = ProcEffects.make_selection_ring(world_seed, key2, {
			"radius": float(r.get("footprint", 24.0)) * 1.2, "style": "bloom", "ground": true,
			"z": 0, "color": Color(0.58, 0.84, 1.0)})
		ring.modulate.a = 0.42
		node.add_child(ring)
		_halos[key2] = ring
		shown += 1


# =============================================================================
# TORCHES
# =============================================================================
func _torches() -> Array:
	var st: Dictionary = _st()
	if st.is_empty():
		return []
	return st["torches"] as Array


func _plant_torch(tx: float) -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	var arr: Array = st["torches"]
	# three may burn at once; a fourth simply lets the oldest gutter out (no loss)
	while arr.size() >= MAX_TORCHES:
		var old: Dictionary = arr[0]
		_gutter_torch(String(old.get("id", "")))
		arr.remove_at(0)
	var tid: String = "t%d" % int(_rand("torch") * 1000000.0)
	var rec: Dictionary = {"id": tid, "tx": _free_tx(tx), "until": _now() + WARM_DUR}
	arr.append(rec)
	_build_torch(tid, float(rec["tx"]), true)
	_refresh_frost(true)


func _build_torch(tid: String, tx: float, fresh: bool) -> void:
	if _torch_nodes.has(tid):
		var old: Variant = _torch_nodes[tid]
		if old != null and is_instance_valid(old):
			(old as Node).queue_free()
	var t: _Torch = _Torch.new()
	t.seedv = hash("%d:torch:%s" % [world_seed, tid])
	t.pal = Proc.palette(world_seed, "torch")
	t.position = _ground_point(tx)
	t.z_index = 3
	_obj.add_child(t)
	if fresh:
		t.set_growth(0.0)
		t.grow_to(1.0, 0.8)
	else:
		t.set_growth(1.0)
	t.grow_rate = 0.0
	_torch_nodes[tid] = t


func _gutter_torch(tid: String) -> void:
	if not _torch_nodes.has(tid):
		return
	var n: Variant = _torch_nodes[tid]
	_torch_nodes.erase(tid)
	if n == null or not is_instance_valid(n):
		return
	var node: Node2D = n
	if node.has_method("gutter"):
		node.call("gutter")
	else:
		node.queue_free()


func _torch_sweep(quiet: bool) -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	var arr: Array = st["torches"]
	var keep: Array = []
	var now: float = _now()
	for item in arr:
		var tr: Dictionary = item
		if float(tr.get("until", 0.0)) > now:
			keep.append(tr)
			var tid: String = String(tr.get("id", ""))
			if not _torch_nodes.has(tid) or not is_instance_valid(_torch_nodes.get(tid)):
				_build_torch(tid, float(tr.get("tx", 0.0)), false)
		else:
			_gutter_torch(String(tr.get("id", "")))
			if not quiet:
				_spawn_motes(_ground_point(float(tr.get("tx", 0.0))) + Vector2(0.0, -40.0), "ember", 2)
	st["torches"] = keep


func _lift_torch(tid: String, wp: Vector2) -> void:
	if not _torch_nodes.has(tid):
		return
	var n: Variant = _torch_nodes[tid]
	if n == null or not is_instance_valid(n):
		return
	_end_carry(false)
	_carry = "torch:%s" % tid
	_carry_node = n
	_carry_at = _now()
	(n as Node2D).z_index = 44
	(n as Node2D).position = wp


func _stand_torch(tid: String, wp: Vector2) -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	var tx: float = _tx_of(wp)
	for item in st["torches"] as Array:
		var tr: Dictionary = item
		if String(tr.get("id", "")) == tid:
			tr["tx"] = tx
	if _torch_nodes.has(tid):
		var n: Variant = _torch_nodes[tid]
		if n != null and is_instance_valid(n):
			var node: Node2D = n
			node.z_index = 3
			var tw: Tween = node.create_tween().set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
			tw.tween_property(node, "position", _ground_point(tx), 0.26)
	_spawn_motes(_ground_point(tx) + Vector2(0.0, -30.0), "ember", 2)
	_refresh_frost(true)


# =============================================================================
# FROST, HALOS, RUFFLES — the readouts that live on the things themselves
# =============================================================================
func _refresh_frost(force: bool) -> void:
	var winter: bool = _is_winter() or (_is_night() and _weather() == "mist")
	if not winter:
		if not _rimes.is_empty():
			for key in _rimes.keys():
				_clear_rime(String(key), false)
		return
	var n: int = 0
	for item in _records():
		var r: Dictionary = item
		if n >= 22 and not force:
			break
		if not _is_green(r):
			continue
		var pid: String = String(r.get("id", ""))
		if is_warm(pid) or _frozen(r):
			_clear_rime(pid, true)
			continue
		_ensure_rime(pid, r)
		n += 1


func _ensure_rime(pid: String, r: Dictionary) -> void:
	if _rimes.has(pid) and is_instance_valid(_rimes.get(pid)):
		return
	var node: ProcNode = r.get("node") as ProcNode
	if node == null or not is_instance_valid(node):
		return
	var rime: _Rime = _Rime.new()
	rime.seedv = hash("%d:rime:%s" % [world_seed, pid])
	rime.radius = float(r.get("footprint", 24.0)) * 1.15
	rime.z_index = 2
	rime.modulate.a = 0.0
	node.add_child(rime)
	var tw: Tween = rime.create_tween()
	tw.tween_property(rime, "modulate:a", 0.85, 1.6)
	_rimes[pid] = rime


func _clear_rime(pid: String, melt: bool) -> void:
	if not _rimes.has(pid):
		return
	var n: Variant = _rimes[pid]
	_rimes.erase(pid)
	if n == null or not is_instance_valid(n):
		return
	var node: Node2D = n
	if melt:
		_spawn_motes(node.global_position, "droplet", 2)
	var tw: Tween = node.create_tween()
	tw.tween_property(node, "modulate:a", 0.0, 0.5)
	tw.tween_callback(node.queue_free)


func _ensure_halo(pid: String) -> void:
	if _halos.has(pid) and is_instance_valid(_halos.get(pid)):
		return
	var r: Dictionary = _rec(pid)
	if r.is_empty():
		return
	var node: ProcNode = r["node"]
	var ring: ProcNode = ProcEffects.make_selection_ring(world_seed, "beloved:%s" % pid, {
		"radius": float(r.get("footprint", 24.0)) * 1.45, "style": "bloom", "ground": true,
		"z": 0, "color": Color(1.0, 0.92, 0.72)})
	ring.modulate.a = 0.38
	node.add_child(ring)
	_halos[pid] = ring


func _refresh_halos() -> void:
	for item in _records():
		var r: Dictionary = item
		var pid: String = String(r.get("id", ""))
		if is_beloved(pid):
			_ensure_halo(pid)


# A storm leaves things ruffled: a lean, a few torn leaves, buffs resting.
# ANY act of care straightens them. They also relax on their own in two hours.
func _ruffle_all() -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	var now: float = _now()
	var hit: int = 0
	for item in _records():
		var r: Dictionary = item
		if not _is_green(r) or _frozen(r):
			continue
		var pid: String = String(r.get("id", ""))
		var c: Dictionary = _care(pid)
		if _is_ruffled(c):
			continue
		if _job_near("guardian", (r["node"] as ProcNode).position, 220.0):
			continue
		c["ruffled"] = now
		var node: ProcNode = r["node"]
		var lean: float = (0.09 if int(hash(pid)) % 2 == 0 else -0.09)
		var tw: Tween = node.create_tween().set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_IN_OUT)
		tw.tween_property(node, "rotation", node.rotation + lean, 1.4)
		if hit < 6:
			_spawn_motes(_crown(r), "leaf", 1)
		hit += 1
		_refresh_grow(pid)
	if hit > 0:
		_say("The storm leaves the garden leaning. A little care will set it right.")


func _straighten(pid: String) -> void:
	var r: Dictionary = _rec(pid)
	if r.is_empty():
		return
	var node: ProcNode = r.get("node") as ProcNode
	if node == null or not is_instance_valid(node):
		return
	var tw: Tween = node.create_tween().set_trans(Tween.TRANS_ELASTIC).set_ease(Tween.EASE_OUT)
	tw.tween_property(node, "rotation", 0.0, 0.9)
	_spawn_motes(_crown(r), "sparkle", 2)


# =============================================================================
# THE ASK  (the pity invitation — a bubble, a glow, and no consequence at all)
# =============================================================================
func _maybe_ask() -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	if not _ask.is_empty():
		if _now() - float(_ask.get("at", 0.0)) > ASK_LIFE:
			_dismiss_ask()
		return
	var now: float = _now()
	var pity: Dictionary = st["pity"]
	var last: float = maxf(float(pity.get("ask", 0.0)), float(st.get("last_care", 0.0)))
	if last <= 0.0:
		pity["ask"] = now
		return
	if now - last < ASK_GAP:
		return
	var pick: Dictionary = _neediest()
	if pick.is_empty():
		pity["ask"] = now
		return
	pity["ask"] = now
	var pid: String = String(pick.get("id", ""))
	var r: Dictionary = _rec(pid)
	if r.is_empty():
		return
	var node: ProcNode = r.get("node") as ProcNode
	if node == null or not is_instance_valid(node):
		return
	var glyph: String = "droplet"
	match String(pick.get("verb", "water")):
		"prune": glyph = "leaf"
		"warm": glyph = "ember"
		"feed": glyph = "berry"
	var bub: ProcNode = _spawn_bubble(node.position + Vector2(0.0, -_body_h(r) - 22.0), glyph, ASK_LIFE)
	var ring: ProcNode = ProcEffects.make_selection_ring(world_seed, "ask:%s" % pid, {
		"radius": float(r.get("footprint", 24.0)) * 1.3, "style": "bloom", "ground": true,
		"z": 0, "color": Color(0.80, 0.94, 0.78)})
	ring.modulate.a = 0.20
	node.add_child(ring)
	_ask = {"pid": pid, "node": bub, "ring": ring, "at": now, "verb": String(pick.get("verb", "water"))}
	emit_signal("dyn_event", "care_asked", {"place_id": pid, "verb": String(pick.get("verb", "water"))})


func _dismiss_ask() -> void:
	if _ask.is_empty():
		return
	var bub: Variant = _ask.get("node", null)
	if bub != null and is_instance_valid(bub) and (bub as Node).has_method("dismiss"):
		(bub as Node).call("dismiss")
	var ring: Variant = _ask.get("ring", null)
	if ring != null and is_instance_valid(ring) and (ring as Node).has_method("fade_out"):
		(ring as Node).call("fade_out", 0.3)
	_ask = {}


# "The thing that would benefit most": the lowest grow multiplier × the most room
# left to grow. Ties broken toward things you have already cared for.
func _neediest() -> Dictionary:
	var best: Dictionary = {}
	var best_s: float = 0.0
	for item in _records():
		var r: Dictionary = item
		if _frozen(r):
			continue
		var pid: String = String(r.get("id", ""))
		var verb: String = ""
		if _is_green(r):
			if not is_watered(pid):
				verb = "water"
			elif _frost_touched(r):
				verb = "warm"
			elif _growth_of(r) >= PRUNE_GATE and not is_pruned(pid):
				verb = "prune"
		elif _is_creature(r):
			verb = "feed"
		if verb == "":
			continue
		var headroom: float = 1.0 - _growth_of(r)
		var deficit: float = clampf(CARE_CAP + 0.01 - care_mult(pid, "grow"), 0.0, 0.3)
		var loved: float = 1.0 + 0.02 * float(tended(pid))
		var s: float = (0.15 + headroom) * (0.05 + deficit) * loved
		if s > best_s:
			best_s = s
			best = {"id": pid, "verb": verb, "label": _label(r)}
	return best


# =============================================================================
# TICK  (§8 — 1 s logic, round-robin, nothing allocated per frame)
# =============================================================================
func _process(delta: float) -> void:
	if not _booted or not (Game and Game.booted):
		return
	# the carried thing follows the finger smoothly even between input events
	if _carry != "" and _carry_node != null and is_instance_valid(_carry_node):
		if _now() - _carry_at > 25.0:
			_end_carry(false)            # safety: never hold input hostage
	_acc += delta
	if _acc < TICK:
		return
	_acc = 0.0
	_prune_motes()
	_sweep_known()
	_apply_grow_roundrobin()
	_auto_water_tick()
	_maybe_ask()
	_slow_acc += TICK
	if _slow_acc >= SLOW_TICK:
		_slow_acc = 0.0
		_ensure_well()
		_torch_sweep(false)
		_refresh_frost(false)
		_refresh_halos()
		_seedfall_sweep()


func _apply_grow_roundrobin() -> void:
	var recs: Array = _records()
	if recs.is_empty():
		return
	var n: int = recs.size()
	for i in range(mini(GROW_PER_TICK, n)):
		var idx: int = (_rr + i) % n
		var r: Dictionary = recs[idx]
		_apply_grow(r)
	_rr = (_rr + GROW_PER_TICK) % n


# Rain really does the watering for you — that is the whole point of a rainy day.
func _auto_water_tick() -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	var auto: Dictionary = st["auto"]
	if _wet_weather():
		var until: float = _now() + 90.0          # keep it topped up while it rains
		if float(auto.get("rain_until", 0.0)) < until:
			auto["rain_until"] = until
			auto["source"] = "weather"


# Things at a hundred cares quietly drop a seed of themselves, once a day.
func _seedfall_sweep() -> int:
	var now: float = _now()
	var fell: int = 0
	for item in _records():
		var r: Dictionary = item
		var pid: String = String(r.get("id", ""))
		var c: Dictionary = _care_ro(pid)
		if c.is_empty() or int(c.get("tended", 0)) < SEEDFALL_AT:
			continue
		if now - float(c.get("seedfall", 0.0)) < SEEDFALL_GAP:
			continue
		var cw: Dictionary = _care(pid)
		cw["seedfall"] = now
		_give_cutting(r)
		fell += 1
		if fell >= 2:
			break
	return fell


func _sweep_known() -> void:
	# `placed` / `removed` relays are optional (§9.2); noticing new things ourselves
	# keeps Nurture correct even before the maintainer wires the signals.
	var seen: Dictionary = {}
	for item in _records():
		var r: Dictionary = item
		var pid: String = String(r.get("id", ""))
		seen[pid] = true
		if not _known_pids.has(pid):
			_known_pids[pid] = true
			_apply_grow(r)
	for key in _known_pids.keys():
		var pid2: String = String(key)
		if not seen.has(pid2):
			_known_pids.erase(pid2)
			_clear_rime(pid2, false)
			if _halos.has(pid2):
				var n: Variant = _halos[pid2]
				if n != null and is_instance_valid(n) and (n as Node).has_method("fade_out"):
					(n as Node).call("fade_out", 0.2)
				_halos.erase(pid2)


func _seed_known_pids() -> void:
	for item in _records():
		var r: Dictionary = item
		_known_pids[String(r.get("id", ""))] = true


# Keep the care table from growing without bound across many ascensions.
func _prune_care_entries() -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	var care: Dictionary = st["care"]
	if care.size() <= 160:
		return
	var live: Dictionary = {}
	for item in _records():
		var r: Dictionary = item
		live[String(r.get("id", ""))] = true
	for key in care.keys():
		var pid: String = String(key)
		if live.has(pid):
			continue
		var c: Dictionary = care[pid]
		if int(c.get("tended", 0)) >= BELOVED_AT:
			continue                      # a beloved memory is never forgotten
		care.erase(pid)
		if care.size() <= 120:
			return


# =============================================================================
# GESTURES — the hooks the maintainer dispatches into (§9.5)
# =============================================================================
func extra_actions(record: Dictionary) -> Array:
	var out: Array = []
	if not (record is Dictionary) or record.is_empty():
		return out
	var entry: Dictionary = record.get("entry", {}) as Dictionary
	if bool(entry.get("minted", false)) or bool(record.get("minted", false)):
		return out
	var pid: String = String(record.get("id", ""))
	var kind: String = String(entry.get("kind", ""))
	var g: float = 0.0
	var node: ProcNode = record.get("node") as ProcNode
	if node != null and is_instance_valid(node):
		g = float(node.growth)
	if GREEN_KINDS.has(kind):
		var c: Dictionary = _care_ro(pid)
		if _now() - float(c.get("watered", 0.0)) >= WATER_GAP and not is_raining():
			out.append("water")
		if g >= PRUNE_GATE and _now() - float(c.get("pruned", 0.0)) >= PRUNE_GAP:
			out.append("prune")
	out.append("feed")
	if (_is_winter() or _is_night()) and not is_warm(pid):
		out.append("warm")
	return out


func handle_action(action: String, record: Dictionary) -> bool:
	if not (record is Dictionary) or record.is_empty():
		return false
	var pid: String = String(record.get("id", ""))
	match action:
		"water":
			var r: Dictionary = _rec(pid)
			var from: Vector2 = Vector2.ZERO
			if _well != null and is_instance_valid(_well):
				from = _well.position + Vector2(0.0, -58.0)
			elif not r.is_empty():
				from = _crown(r) + Vector2(-70.0, -80.0)
			return water(pid, from, false)
		"prune":
			return prune_begin(pid)
		"feed":
			return feed(pid, {}, "")
		"warm":
			return warm(pid)
	return false


# A bloom, a berry, a loaf, a dewdrop, a lamp — dragged from the basket onto the
# world. Nurture only ever consumes things that are clearly acts of care.
func handle_drop(entry: Dictionary, inst_key: String, world_pos: Vector2) -> bool:
	if not (entry is Dictionary) or entry.is_empty():
		return false
	var kind: String = String(entry.get("kind", ""))
	var species: String = String(entry.get("species", "")).to_lower()
	var target: Dictionary = _rec_at_world(world_pos, 26.0)
	if target.is_empty():
		return false
	var pid: String = String(target.get("id", ""))
	# 1. a treat dropped onto a creature — always a feeding
	if _is_creature(target):
		var def: Dictionary = _food_def(entry)
		var treat: bool = bool(def.get("ok", false)) or kind == "plant" or kind == "fungus"
		if treat:
			if feed(pid, entry, inst_key):
				_say("%s is offered, and gratefully taken." % ItemCatalog.display_label(entry))
				return true
		return false
	if kind != "material":
		return false                     # never steal a plantable drop
	# 2. water from a dewdrop
	if WATER_MATS.has(species) and bool(WATER_MATS.get(species, false)):
		if water(pid, world_pos + Vector2(0.0, -90.0), true):
			return true
		return false
	# 3. kindling / emberbloom warms a cold thing
	if WARM_MATS.has(species):
		var c: Dictionary = _care(pid)
		var now: float = _now()
		if now < float(c.get("warm_until", 0.0)):
			return false
		c["warmed"] = now
		c["warm_until"] = now + WARM_DUR
		_plant_torch(float(target.get("tx", _tx_of(world_pos))) + 28.0)
		_clear_rime(pid, true)
		_credit_care(pid, "warm", target)
		return true
	# 4. any other food feeds the plant
	if FOODS.has(species):
		return feed(pid, entry, inst_key)
	return false


# Taps on Nurture's own in-world objects.
func handle_tap(screen_pos: Vector2, world_pos: Vector2) -> bool:
	if _carry != "":
		# a tap while something is in hand puts it down / pours it out
		_carry_release(world_pos)
		return true
	# the ask bubble: tell me what it would like
	if not _ask.is_empty():
		var bub: Variant = _ask.get("node", null)
		if bub != null and is_instance_valid(bub) and (bub as Node2D).position.distance_to(world_pos) < 64.0:
			var pid: String = String(_ask.get("pid", ""))
			_say(_ask_line(String(_ask.get("verb", "water")), pid))
			return true
	# the well: lift a can, or dip the one you are carrying
	if _well != null and is_instance_valid(_well):
		if _hit(_well.position, world_pos, 86.0, 120.0):
			# the well always hands you a full can — dipping it is the whole gesture
			_refill_can()
			_lift_can(_well.position + Vector2(64.0, -40.0))
			return true
	# the can resting in the grass
	if _can != null and is_instance_valid(_can) and _carry == "":
		if _hit(_can.position, world_pos, 44.0, 60.0):
			_lift_can(world_pos)
			return true
	# a torch
	for key in _torch_nodes.keys():
		var tid: String = String(key)
		var n: Variant = _torch_nodes[tid]
		if n == null or not is_instance_valid(n):
			continue
		if _hit((n as Node2D).position, world_pos, 34.0, 130.0):
			_lift_torch(tid, world_pos)
			_say_once("first_torch", "Stand it wherever the frost bites.")
			return true
	return false


func _can_water() -> int:
	var st: Dictionary = _st()
	if st.is_empty():
		return 0
	var can: Dictionary = st["can"]
	return int(can.get("water", 0))


func _ask_line(verb: String, pid: String) -> String:
	var r: Dictionary = _rec(pid)
	var nm: String = _label(r) if not r.is_empty() else "It"
	match verb:
		"water": return "%s would like a drink." % nm
		"prune": return "%s has grown shaggy — it would like shaping." % nm
		"warm": return "%s is cold. A torch would help." % nm
		"feed": return "%s is looking at you, hopefully." % nm
	return "%s would like a little attention." % nm


func _hit(obj: Vector2, wp: Vector2, half_w: float, height: float) -> bool:
	return absf(wp.x - obj.x) <= half_w and wp.y <= obj.y + 18.0 and wp.y >= obj.y - height


# =============================================================================
# CARRY MODE — Nurture owns input ONLY while something is in your hand.
# (No edit to Interact is needed for this; outside carry mode it never looks at
#  input at all, so panning, the tray and every other gesture are untouched.)
# =============================================================================
func _input(event: InputEvent) -> void:
	if _carry == "":
		return
	var vp: Viewport = get_viewport()
	if event is InputEventScreenDrag or event is InputEventMouseMotion:
		_carry_move(_world_of(event))
		if vp != null:
			vp.set_input_as_handled()
	elif event is InputEventScreenTouch or event is InputEventMouseButton:
		if event.pressed:
			_carry_move(_world_of(event))
		else:
			_carry_release(_world_of(event))
		if vp != null:
			vp.set_input_as_handled()


# Fallback tap routing for when the §9.5 dispatch points are not wired yet: we only
# ever consume a press whose world point actually lands on one of our own objects.
func _unhandled_input(event: InputEvent) -> void:
	if _carry != "" or _hooks_live():
		return
	if not (event is InputEventScreenTouch or event is InputEventMouseButton):
		return
	var p: Vector2 = _screen_of(event)
	if p.y > _vp_size().y * 0.80:
		return                                  # the tray owns the bottom of the screen
	var wp: Vector2 = _world_point(p)
	if event.pressed:
		_fallback_armed = _tap_targets_us(wp)
		_fallback_press = p
		if _fallback_armed:
			var vp: Viewport = get_viewport()
			if vp != null:
				vp.set_input_as_handled()
		return
	if not _fallback_armed:
		return
	_fallback_armed = false
	var vp2: Viewport = get_viewport()
	if p.distance_to(_fallback_press) < 18.0:
		if handle_tap(p, wp) and vp2 != null:
			vp2.set_input_as_handled()


func _tap_targets_us(wp: Vector2) -> bool:
	if _well != null and is_instance_valid(_well) and _hit(_well.position, wp, 86.0, 120.0):
		return true
	if _can != null and is_instance_valid(_can) and _hit(_can.position, wp, 44.0, 60.0):
		return true
	for key in _torch_nodes.keys():
		var n: Variant = _torch_nodes[key]
		if n != null and is_instance_valid(n) and _hit((n as Node2D).position, wp, 34.0, 130.0):
			return true
	if not _ask.is_empty():
		var bub: Variant = _ask.get("node", null)
		if bub != null and is_instance_valid(bub) and (bub as Node2D).position.distance_to(wp) < 64.0:
			return true
	return false


func _hooks_live() -> bool:
	return _interact != null and _interact.has_method("dyn")


func _carry_move(wp: Vector2) -> void:
	if _carry == "shears":
		_shear_move(wp)
		return
	if _carry_node != null and is_instance_valid(_carry_node):
		_carry_node.position = _carry_node.position.lerp(wp, 0.5)
	if _carry == "can":
		# tilt the can toward whatever it is hovering over
		var over: Dictionary = _rec_at_world(wp, 40.0)
		if _carry_node != null and is_instance_valid(_carry_node) and _carry_node.has_method("aim"):
			_carry_node.call("aim", not over.is_empty() and _is_green(over))


func _carry_release(wp: Vector2) -> void:
	var what: String = _carry
	if what == "shears":
		# a release never cancels the shaping; it ends when the work is done or the
		# shears simply fade after a few seconds.
		if _now() - _carry_at > 6.0 or _shear_cuts >= SNIPS:
			_end_carry(true)
		return
	if what == "can":
		var over: Dictionary = _rec_at_world(wp, 44.0)
		if not over.is_empty() and _is_green(over):
			_pour_on(over)
			return                              # stay in hand: water the next one
		if _well != null and is_instance_valid(_well) and _hit(_well.position, wp, 92.0, 130.0):
			_refill_can()
			_set_can_down(_well.position + Vector2(74.0, 0.0))
			_end_carry(true)
			return
		_set_can_down(wp)
		_end_carry(true)
		return
	if what.begins_with("torch:"):
		_stand_torch(what.substr(6), wp)
		_end_carry(true)
		return
	_end_carry(true)


func _set_can_down(wp: Vector2) -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	var can: Dictionary = st["can"]
	var tx: float = _tx_of(wp)
	can["out"] = true
	can["tx"] = tx
	if _can != null and is_instance_valid(_can):
		_can.z_index = 22
		if _can.has_method("aim"):
			_can.call("aim", false)
		var tw: Tween = _can.create_tween().set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
		tw.tween_property(_can, "position", _ground_point(tx), 0.3)


func _end_carry(graceful: bool) -> void:
	if _carry == "shears":
		if _carry_node != null and is_instance_valid(_carry_node):
			var node: Node2D = _carry_node
			var tw: Tween = node.create_tween()
			tw.tween_property(node, "modulate:a", 0.0, 0.35)
			tw.tween_callback(node.queue_free)
		for item in _shear_pts:
			var p: Dictionary = item
			var ring: Variant = p.get("ring", null)
			if ring != null and is_instance_valid(ring) and (ring as Node).has_method("fade_out"):
				(ring as Node).call("fade_out", 0.25)
		_shear_pts = []
		_shear_pid = ""
		_shear_cuts = 0
	if _carry == "can":
		_highlight_thirsty(false)
	_carry = ""
	_carry_node = null
	if graceful and Game:
		Game.save_now()


func _world_of(event: InputEvent) -> Vector2:
	return _world_point(_screen_of(event))


func _screen_of(event: InputEvent) -> Vector2:
	if event is InputEventMouseButton or event is InputEventMouseMotion:
		return (event as InputEventMouse).position
	if event is InputEventScreenTouch:
		return (event as InputEventScreenTouch).position
	if event is InputEventScreenDrag:
		return (event as InputEventScreenDrag).position
	var vp: Viewport = get_viewport()
	if vp != null:
		return vp.get_mouse_position()
	return Vector2.ZERO


func _world_point(screen_pos: Vector2) -> Vector2:
	if _space != null and _space.has_method("screen_to_world"):
		return _space.call("screen_to_world", screen_pos)
	return to_local(screen_pos)


func _vp_size() -> Vector2:
	var vp: Viewport = get_viewport()
	if vp != null:
		return vp.get_visible_rect().size
	return Vector2(1080, 1920)


# =============================================================================
# INBOUND EVENTS  (§4.3 — hear about the world without importing anybody)
# =============================================================================
func notify(kind: String, payload: Dictionary) -> void:
	if not _booted:
		return
	match kind:
		"placed":
			var pid: String = String(payload.get("id", payload.get("place_id", "")))
			if pid != "":
				_known_pids[pid] = true
				_refresh_grow(pid)
			_ensure_well()
			_refresh_frost(false)
		"removed":
			var rid: String = String(payload.get("place_id", ""))
			if rid != "":
				_known_pids.erase(rid)
				_clear_rime(rid, false)
		"nurtured":
			# the base game's essence-for-growth verb counts as a feeding
			var nid: String = String(payload.get("id", payload.get("place_id", "")))
			if nid != "":
				var r: Dictionary = _rec(nid)
				if not r.is_empty():
					var c: Dictionary = _care(nid)
					c["fed"] = _now()
					_credit_care(nid, "feed", r)
		"weather_changed":
			var w: String = String(payload.get("weather", ""))
			if w == "storm":
				_ruffle_all()
			if w == "rain" or w == "storm":
				auto_water(20.0 * 60.0, "weather")
			_refresh_frost(true)
		"season_changed":
			_refresh_frost(true)
			_refresh_all_grow()
		"event_started":
			var ek: String = String(payload.get("kind", ""))
			if ek == "bloomtide" or ek == "bloomtide_swell" or ek == "rain":
				var ends: float = float(payload.get("ends", 0.0))
				var secs: float = maxf(30.0 * 60.0, ends - _now())
				auto_water(secs, "bloomtide")
				_say("The swell rolls in. Everything drinks.")
		"rite_started", "rite_done":
			var rid2: String = String(payload.get("rite", ""))
			if rid2 == "rain":
				auto_water(2.0 * 3600.0, "rite")
			elif rid2 == "warmth":
				_refresh_frost(true)
				_refresh_all_grow()
		"blessing_changed":
			_refresh_all_grow()
		"puzzle_solved":
			var pzid: String = String(payload.get("id", ""))
			if pzid.find("bloomtide") >= 0:
				auto_water(30.0 * 60.0, "puzzle")
		"variant", "job_set", "bond_up":
			_refresh_all_grow()
		"ascended":
			# keep the beloved memories, drop the rest (placements are gone anyway)
			_prune_care_entries()


# =============================================================================
# GRANTING INTO THE TRAY  (§7.3 — this pattern must match every agent's exactly)
# =============================================================================
func _grant(item_key: String, entry: Dictionary, n: int = 1) -> void:
	if not (Game and Game.state is Dictionary):
		return
	if not Game.state.has("inventory") or not (Game.state["inventory"] is Dictionary):
		Game.state["inventory"] = {}
	var inv: Dictionary = Game.state["inventory"]
	if not (inv.get(item_key) is Dictionary):
		var e: Dictionary = entry.duplicate(true)
		e["count"] = 0
		inv[item_key] = e
	var cur: Dictionary = inv[item_key]
	cur["count"] = int(cur.get("count", 0)) + n
	var tray: Node = _tray()
	if tray != null and tray.has_method("refresh"):
		tray.call("refresh")
	_dirty()


func _tray() -> Node:
	if _interact != null and _interact.has_method("tray"):
		return _interact.call("tray") as Node
	return null


# Chains holds the materials; if it is absent, nothing is taken and callers fall
# back to essence (never a block).
func _take_mat(mat: String, n: int) -> bool:
	var c: Node = _sib("Chains")
	if c == null or not c.has_method("take"):
		return false
	return bool(c.call("take", mat, n))


func _food_def(entry: Dictionary) -> Dictionary:
	var kind: String = String(entry.get("kind", ""))
	var sp: String = String(entry.get("species", "")).to_lower()
	if kind == "material" and FOODS.has(sp):
		var d: Dictionary = FOODS[sp]
		return {"ok": true, "rich": bool(d.get("rich", false)), "glyph": String(d.get("glyph", "bloom"))}
	if kind == "plant":
		return {"ok": true, "rich": false, "glyph": "bloom"}
	if kind == "fungus":
		return {"ok": true, "rich": false, "glyph": "berry"}
	return {"ok": false, "rich": false, "glyph": "bloom"}


func _adapt(r: Dictionary, extra: Dictionary) -> void:
	var node: ProcNode = r.get("node") as ProcNode
	if node == null or not is_instance_valid(node) or _space == null:
		return
	if not _space.has_method("build_context"):
		return
	var ctx: Dictionary = _space.call("build_context", node.position, float(r.get("footprint", 24.0)))
	for k in extra.keys():
		ctx[k] = extra[k]
	ItemCatalog.adapt(node, ctx)


# =============================================================================
# WHISPERS  (§2.6 — a shared, precious channel: 15 s gap, dropped not queued)
# =============================================================================
func _say(text: String) -> void:
	if text == "":
		return
	if _interact != null and _interact.has_method("is_placing") and bool(_interact.call("is_placing")):
		return
	var now: float = _now()
	if now - _whisper_at < WHISPER_GAP:
		return
	_whisper_at = now
	emit_signal("whisper", text)


func _say_once(key: String, text: String) -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	var said: Dictionary = st["said"]
	if bool(said.get(key, false)):
		return
	said[key] = true
	_whisper_at = 0.0           # a first-time line is always worth the channel
	_say(text)


# =============================================================================
# VISUAL SPAWNS  (all drawn with the Proc toolkit; motes stay inside the budget)
# =============================================================================
func _mote_room(n: int) -> bool:
	_prune_motes()
	return _live_motes.size() + n <= MOTE_BUDGET


func _prune_motes() -> void:
	var keep: Array = []
	for m in _live_motes:
		if m != null and is_instance_valid(m):
			keep.append(m)
	_live_motes = keep


func _spawn_stream(from: Vector2, to: Vector2) -> void:
	var s: _Stream = _Stream.new()
	s.seedv = hash("%d:stream:%d" % [world_seed, _live_motes.size()])
	s.from_p = from
	s.to_p = to
	s.z_index = 27
	_fx.add_child(s)


func _spawn_damp(pos: Vector2, radius: float) -> void:
	var d: _Damp = _Damp.new()
	d.radius = maxf(22.0, radius * 1.5)
	d.position = pos
	d.z_index = 0
	_fx.add_child(d)
	d.begin()


func _spawn_ring(pos: Vector2, radius: float, col: Color) -> void:
	var fx: ProcNode = ProcEffects.make_growth_sparkle(world_seed, "feed:%d" % int(_now() * 10.0), {
		"radius": radius, "color": col, "z": 26, "life": 1.1})
	fx.position = pos
	_fx.add_child(fx)


func _spawn_motes(pos: Vector2, kind: String, n: int) -> void:
	if not _mote_room(n):
		return
	for i in range(n):
		var m: _Mote = _Mote.new()
		m.seedv = hash("%d:mote:%s:%d:%d" % [world_seed, kind, int(_now()), i])
		m.kind = kind
		m.position = pos + Vector2(Proc.rangef(m.seedv, "ox", -14.0, 14.0),
			Proc.rangef(m.seedv, "oy", -12.0, 6.0))
		m.z_index = 27
		_fx.add_child(m)
		_live_motes.append(m)


func _spawn_bubble(pos: Vector2, glyph: String, life: float) -> ProcNode:
	var b: _Bubble = _Bubble.new()
	b.seedv = hash("%d:bub:%s:%d" % [world_seed, glyph, int(_now())])
	b.glyph = glyph
	b.position = pos
	b.z_index = 34
	_fx.add_child(b)
	b.appear(life)
	return b


# A thing that has just been cared for visibly PERKS: a quick lift and a small,
# real growth nudge (growth is the game's only number, so care must move it).
func _perk(node: ProcNode, bump: float) -> void:
	if node == null or not is_instance_valid(node):
		return
	var base: Vector2 = node.scale
	var tw: Tween = node.create_tween().set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
	tw.tween_property(node, "scale", Vector2(base.x * 0.985, base.y * 1.045), 0.16)
	tw.tween_property(node, "scale", base, 0.42)
	if node.rotation != 0.0:
		tw.parallel().tween_property(node, "rotation", node.rotation * 0.35, 0.5)
	if bump > 0.0 and node.grow_rate > 0.0 and node.growth < 1.0:
		node.grow_to(minf(1.0, float(node.growth) + bump), 1.1)


# =============================================================================
# geometry / time helpers
# =============================================================================
# A free patch of ground near `tx`, stepping outward past anything standing there.
func _free_tx(tx: float) -> float:
	var want: float = tx
	for attempt in range(9):
		var ok: bool = true
		for item in RESERVED_TX:
			if absf(want - (_heart_tx() + float(item))) < 70.0:
				ok = false
		if ok:
			for item2 in _records():
				var r: Dictionary = item2
				if absf(want - float(r.get("tx", 0.0))) < float(r.get("footprint", 24.0)) + 44.0:
					ok = false
					break
		if ok and absf(want - _heart_tx()) > 120.0:
			return want
		var step: float = 76.0 * float(attempt + 1)
		want = tx + (step if attempt % 2 == 0 else -step)
	return tx


func _effective(elapsed: float) -> float:
	var e: float = maxf(0.0, elapsed)
	var full: float = _full_hours() * 3600.0
	var cap: float = OFFLINE_CAP_HOURS * 3600.0
	if e <= full:
		return e
	var span: float = maxf(1.0, cap - full)
	var over: float = minf(e, cap) - full
	var avg: float = 1.0 - (1.0 - OFFLINE_FLOOR) * 0.5 * (over / span)
	return full + over * avg


func _full_hours() -> float:
	var r: Node = _sib("Rituals")
	if r != null and r.has_method("blessing"):
		var b: float = float(r.call("blessing", "offline"))
		if b > 1.5:
			return clampf(b, OFFLINE_FULL_HOURS, float(CAP_FOR["offline"]))
		return clampf(OFFLINE_FULL_HOURS * b, OFFLINE_FULL_HOURS, float(CAP_FOR["offline"]))
	return OFFLINE_FULL_HOURS


func _now() -> float:
	return float(Time.get_unix_time_from_system())


# =============================================================================
#  DRAWN THINGS — tiny ProcNode subclasses, all generated from math (CONVENTIONS).
# =============================================================================

# -----------------------------------------------------------------------------
#  _Bit — one small animated accessory (water gleam, bucket, flame, glow). Kept
#  as a single class so the well/torch stay cheap: the parent animates transforms.
# -----------------------------------------------------------------------------
class _Bit extends Node2D:
	var kind: String = "gleam"
	var col: Color = Color(1, 1, 1, 1)
	var col2: Color = Color(1, 1, 1, 0.5)
	var rad: float = 20.0

	func _draw() -> void:
		match kind:
			"gleam":
				# three crescent highlights on dark well water
				for i in range(3):
					var y: float = -2.0 - float(i) * 3.4
					var w: float = rad * (0.74 - 0.16 * float(i))
					var pts := PackedVector2Array()
					for s in range(12):
						var u: float = float(s) / 11.0
						pts.append(Vector2(lerpf(-w, w, u), y - sin(u * PI) * 2.2))
					draw_polyline(pts, Color(col.r, col.g, col.b, 0.5 - 0.12 * float(i)), 2.0, true)
			"bucket":
				var bw: float = rad * 0.46
				var bh: float = rad * 0.52
				var body := PackedVector2Array([
					Vector2(-bw, -bh), Vector2(bw, -bh),
					Vector2(bw * 0.78, bh * 0.6), Vector2(-bw * 0.78, bh * 0.6)])
				draw_polygon(body, Proc.grad_fill(body, col.lightened(0.18), col.darkened(0.3)))
				draw_polyline(PackedVector2Array([body[0], body[1], body[2], body[3], body[0]]),
					col2, 1.6, true)
				var hoop := PackedVector2Array()
				for i in range(14):
					var a: float = PI + PI * float(i) / 13.0
					hoop.append(Vector2(cos(a) * bw * 0.96, -bh + sin(a) * bw * 0.5))
				draw_polyline(hoop, col2, 1.6, true)
			"flame":
				# a teardrop flame: hot core, warm body, soft halo
				for layer in range(3):
					var sc: float = 1.0 - 0.3 * float(layer)
					var h: float = rad * 1.9 * sc
					var w2: float = rad * 0.62 * sc
					var pts2 := PackedVector2Array()
					for i in range(18):
						var u: float = float(i) / 17.0
						var x: float = sin(u * PI) * w2 * (1.0 - u * 0.55)
						pts2.append(Vector2(x, -u * h))
					for i in range(17, -1, -1):
						var u2: float = float(i) / 17.0
						var x2: float = -sin(u2 * PI) * w2 * (1.0 - u2 * 0.55)
						pts2.append(Vector2(x2, -u2 * h))
					var c: Color = col if layer == 0 else (col.lightened(0.3) if layer == 1 else Color(1, 1, 0.9, 0.9))
					draw_colored_polygon(pts2, Color(c.r, c.g, c.b, 0.42 + 0.22 * float(layer)))
			"glow":
				for i in range(4):
					var rr: float = rad * (1.0 - 0.2 * float(i))
					draw_circle(Vector2.ZERO, rr, Color(col.r, col.g, col.b, 0.05 + 0.035 * float(i)))


# -----------------------------------------------------------------------------
#  _Well — the stone well the island's water comes from. Not a placement: it
#  cannot be uprooted, minted or harvested. It unfurls out of the soil once.
# -----------------------------------------------------------------------------
class _Well extends ProcNode:
	var pal: Dictionary = {}
	var footprint_radius: float = 48.0
	var _gleam: _Bit = null
	var _bucket: _Bit = null

	func _on_built() -> void:
		var stone: Color = _stone()
		_gleam = _Bit.new()
		_gleam.kind = "gleam"
		_gleam.col = Color(0.78, 0.93, 1.0)
		_gleam.rad = 34.0
		_gleam.position = Vector2(0.0, -34.0)
		add_child(_gleam)
		_bucket = _Bit.new()
		_bucket.kind = "bucket"
		_bucket.col = Color(0.62, 0.45, 0.30)
		_bucket.col2 = stone.darkened(0.3)
		_bucket.rad = 26.0
		_bucket.position = Vector2(0.0, -84.0)
		add_child(_bucket)

	func _stone() -> Color:
		var base: Color = Color(0.68, 0.68, 0.66)
		if pal.has("base") and pal["base"] is Color:
			base = (pal["base"] as Color).lerp(Color(0.7, 0.7, 0.68), 0.62)
		return base

	func _animate(_delta: float) -> void:
		var gv: float = g()
		if _bucket != null:
			_bucket.rotation = sin(t * 0.8 + phase) * 0.06 * gv
			_bucket.position.y = -84.0 * gv - sin(t * 0.55 + phase) * 1.6
			_bucket.scale = Vector2.ONE * maxf(0.001, gv)
		if _gleam != null:
			_gleam.position.y = -34.0 * gv
			_gleam.scale = Vector2(1.0 + sin(t * 0.9) * 0.03, 1.0) * maxf(0.001, gv)

	func _draw() -> void:
		var gv: float = g()
		if gv <= 0.01:
			return
		var stone: Color = _stone()
		var dk: Color = stone.darkened(0.42)
		var lt: Color = stone.lightened(0.24)
		var w: float = 54.0 * gv
		var h: float = 44.0 * gv
		# contact shadow
		var sh := PackedVector2Array()
		for i in range(22):
			var a: float = TAU * float(i) / 22.0
			sh.append(Vector2(cos(a) * w * 1.32, sin(a) * h * 0.26))
		draw_colored_polygon(sh, Color(0.05, 0.06, 0.05, 0.2))
		# the drum: a stack of smooth courses
		var drum := PackedVector2Array()
		for i in range(26):
			var u: float = float(i) / 25.0
			drum.append(Vector2(lerpf(-w, w, u), 0.0))
		var body := PackedVector2Array([
			Vector2(-w, 0.0), Vector2(-w * 0.94, -h), Vector2(w * 0.94, -h), Vector2(w, 0.0)])
		draw_polygon(body, Proc.grad_fill(body, lt, dk))
		for i in range(3):
			var y: float = -h * (0.28 + 0.26 * float(i))
			var cw: float = w * (0.95 - 0.01 * float(i))
			draw_line(Vector2(-cw, y), Vector2(cw, y), Color(dk.r, dk.g, dk.b, 0.5), 1.6, true)
		# the stones, drawn as soft rounded blocks along each course
		var rs: RandomNumberGenerator = Proc.rng(seedv, "stones")
		for i in range(9):
			var sx: float = rs.randf_range(-w * 0.86, w * 0.78)
			var sy: float = -h * rs.randf_range(0.12, 0.88)
			var sw: float = w * rs.randf_range(0.12, 0.2)
			var sht: float = h * 0.16
			var blk: PackedVector2Array = Proc.superellipse(sw, sht, 3.4, 16)
			var moved := PackedVector2Array()
			for p in blk:
				moved.append(p + Vector2(sx, sy))
			draw_colored_polygon(moved, Color(lt.r, lt.g, lt.b, 0.4))
			draw_polyline(_close(moved), Color(dk.r, dk.g, dk.b, 0.35), 1.2, true)
		# the mouth: dark water inside the rim
		var rim := PackedVector2Array()
		for i in range(26):
			var a2: float = TAU * float(i) / 26.0
			rim.append(Vector2(cos(a2) * w * 0.94, -h + sin(a2) * h * 0.3))
		draw_polygon(rim, Proc.grad_fill(rim, dk.darkened(0.3), Color(0.08, 0.16, 0.22)))
		var water := PackedVector2Array()
		for i in range(24):
			var a3: float = TAU * float(i) / 24.0
			water.append(Vector2(cos(a3) * w * 0.74, -h + sin(a3) * h * 0.22))
		var wc: Color = Color(0.16, 0.42, 0.52)
		draw_polygon(water, Proc.grad_fill(water, wc.lightened(0.25), wc.darkened(0.3)))
		draw_polyline(_close(rim), lt, 2.0, true)
		# posts + roof, which only arrive as the well finishes growing
		var rg: float = clampf((gv - 0.35) / 0.65, 0.0, 1.0)
		if rg > 0.02:
			var ph: float = 86.0 * rg
			var wood: Color = Color(0.46, 0.33, 0.22)
			for sgn in [-1.0, 1.0]:
				var px: float = sgn * w * 0.78
				var post := PackedVector2Array([
					Vector2(px - 4.5, -h * 0.85), Vector2(px + 4.5, -h * 0.85),
					Vector2(px + 3.5, -h - ph), Vector2(px - 3.5, -h - ph)])
				draw_polygon(post, Proc.grad_fill(post, wood.lightened(0.2), wood.darkened(0.35)))
			var bar_y: float = -h - ph + 6.0
			draw_line(Vector2(-w * 0.8, bar_y), Vector2(w * 0.8, bar_y), wood.darkened(0.2), 4.0, true)
			# shingled roof
			var rw: float = w * 1.22
			var rh: float = 34.0 * rg
			var roof := PackedVector2Array([
				Vector2(-rw, bar_y - 4.0), Vector2(0.0, bar_y - 4.0 - rh),
				Vector2(rw, bar_y - 4.0), Vector2(rw * 0.9, bar_y + 2.0), Vector2(-rw * 0.9, bar_y + 2.0)])
			var rc: Color = Color(0.38, 0.30, 0.24)
			if pal.has("accent_dk") and pal["accent_dk"] is Color:
				rc = (pal["accent_dk"] as Color).lerp(rc, 0.5)
			draw_polygon(roof, Proc.grad_fill(roof, rc.lightened(0.26), rc.darkened(0.2)))
			for i in range(5):
				var u3: float = float(i + 1) / 6.0
				draw_line(Vector2(lerpf(-rw, 0.0, u3), lerpf(bar_y - 4.0, bar_y - 4.0 - rh, u3)),
					Vector2(lerpf(-rw * 0.9, 0.0, u3), lerpf(bar_y + 2.0, bar_y - 4.0 - rh, u3)),
					Color(0, 0, 0, 0.12), 1.2, true)
				draw_line(Vector2(lerpf(rw, 0.0, u3), lerpf(bar_y - 4.0, bar_y - 4.0 - rh, u3)),
					Vector2(lerpf(rw * 0.9, 0.0, u3), lerpf(bar_y + 2.0, bar_y - 4.0 - rh, u3)),
					Color(0, 0, 0, 0.12), 1.2, true)
			# rope
			draw_line(Vector2(0.0, bar_y), Vector2(0.0, -84.0 * gv), Color(0.78, 0.68, 0.5, 0.9), 1.8, true)
		# a little moss, because it is old
		var rm: RandomNumberGenerator = Proc.rng(seedv, "moss")
		for i in range(6):
			var mx: float = rm.randf_range(-w * 0.9, w * 0.9)
			draw_circle(Vector2(mx, -h * rm.randf_range(0.05, 0.3)),
				rm.randf_range(2.0, 5.0) * gv, Color(0.33, 0.52, 0.3, 0.5))

	func _close(p: PackedVector2Array) -> PackedVector2Array:
		var out: PackedVector2Array = p.duplicate()
		if out.size() > 0:
			out.append(out[0])
		return out


# -----------------------------------------------------------------------------
#  _Can — the watering can: carried, tilted, poured, set down in the grass.
# -----------------------------------------------------------------------------
class _Can extends ProcNode:
	var pal: Dictionary = {}
	var water: int = 4
	var footprint_radius: float = 22.0
	var _tilt: float = 0.0
	var _tilt_t: float = 0.0
	var _aimed: bool = false

	func set_water(n: int) -> void:
		water = maxi(0, n)
		queue_redraw()

	func aim(on: bool) -> void:
		if _aimed == on:
			return
		_aimed = on
		queue_redraw()

	func tip() -> void:
		_tilt_t = 1.0

	func _animate(delta: float) -> void:
		_tilt_t = maxf(0.0, _tilt_t - delta * 0.9)
		var want: float = (-0.55 if _tilt_t > 0.0 else (-0.22 if _aimed else 0.0))
		_tilt = lerpf(_tilt, want, clampf(delta * 6.0, 0.0, 1.0))
		rotation = _tilt + sin(t * 1.6 + phase) * 0.015

	func _draw() -> void:
		var tin: Color = Color(0.72, 0.78, 0.76)
		if pal.has("base") and pal["base"] is Color:
			tin = (pal["base"] as Color).lerp(Color(0.74, 0.8, 0.8), 0.6)
		var dk: Color = tin.darkened(0.42)
		var lt: Color = tin.lightened(0.3)
		# body: a soft squircle sitting on its base
		var bw: float = 20.0
		var bh: float = 18.0
		var body: PackedVector2Array = Proc.superellipse(bw, bh, 3.0, 26)
		var moved := PackedVector2Array()
		for p in body:
			moved.append(p + Vector2(0.0, -bh))
		draw_colored_polygon(moved, Color(0.05, 0.06, 0.06, 0.16))      # shadow pad
		draw_polygon(moved, Proc.grad_fill(moved, lt, dk))
		# water level inside, seen through the open top
		var lvl: float = clampf(float(water) / 4.0, 0.0, 1.0)
		if lvl > 0.02:
			var wtr := PackedVector2Array()
			var top_y: float = -bh - bh * 0.1 + (1.0 - lvl) * bh * 1.2
			for i in range(16):
				var u: float = float(i) / 15.0
				wtr.append(Vector2(lerpf(-bw * 0.72, bw * 0.72, u), top_y + sin(u * PI * 2.0 + t) * 1.1))
			wtr.append(Vector2(bw * 0.6, -bh * 0.3))
			wtr.append(Vector2(-bw * 0.6, -bh * 0.3))
			draw_colored_polygon(wtr, Color(0.36, 0.68, 0.82, 0.62))
		# spout: a tapered tube up and out to the left
		var sp := PackedVector2Array([
			Vector2(-bw * 0.72, -bh * 1.1), Vector2(-bw * 1.95, -bh * 1.9),
			Vector2(-bw * 1.75, -bh * 2.35), Vector2(-bw * 0.62, -bh * 1.55)])
		draw_polygon(sp, Proc.grad_fill(sp, lt, dk))
		draw_polyline(PackedVector2Array([sp[0], sp[1], sp[2], sp[3], sp[0]]), dk, 1.3, true)
		# rose (the sprinkler head)
		draw_circle(Vector2(-bw * 1.9, -bh * 2.1), 4.4, lt)
		# handle: an arc over the top
		var hd := PackedVector2Array()
		for i in range(16):
			var a: float = PI * (0.08 + 0.84 * float(i) / 15.0)
			hd.append(Vector2(cos(a) * bw * 0.86, -bh * 1.1 - sin(a) * bh * 0.95))
		draw_polyline(hd, dk, 3.4, true)
		draw_polyline(hd, lt, 1.4, true)
		# rim + a highlight glint
		draw_line(Vector2(-bw * 0.76, -bh * 1.9), Vector2(bw * 0.76, -bh * 1.9), dk, 2.4, true)
		draw_line(Vector2(-bw * 0.4, -bh * 1.55), Vector2(bw * 0.1, -bh * 1.62),
			Color(1, 1, 1, 0.5), 2.0, true)
		if _aimed:
			draw_circle(Vector2(-bw * 1.9, -bh * 2.1), 7.5, Color(0.6, 0.9, 1.0, 0.3))


# -----------------------------------------------------------------------------
#  _Stream — the arc of water from spout to plant: the single juiciest moment in
#  the whole care loop. Shape changes every frame, so animate_draw is honest here.
# -----------------------------------------------------------------------------
class _Stream extends ProcNode:
	var from_p: Vector2 = Vector2.ZERO
	var to_p: Vector2 = Vector2(80.0, 40.0)
	var life: float = 1.45

	func _on_built() -> void:
		animate_draw = true
		grow_rate = 0.0
		set_growth(1.0)

	func _animate(_delta: float) -> void:
		if t >= life:
			queue_free()

	func _bez(u: float) -> Vector2:
		# a lifted quadratic so the water visibly ARCS rather than pouring straight
		var mid: Vector2 = from_p.lerp(to_p, 0.5) + Vector2(0.0, -58.0 - from_p.distance_to(to_p) * 0.12)
		var a: Vector2 = from_p.lerp(mid, u)
		var b: Vector2 = mid.lerp(to_p, u)
		return a.lerp(b, u)

	func _draw() -> void:
		var u: float = clampf(t / life, 0.0, 1.0)
		# the ribbon extends, holds, then retracts from the spout end
		var head: float = clampf(u / 0.22, 0.0, 1.0)
		var tail: float = clampf((u - 0.74) / 0.26, 0.0, 1.0)
		if head <= 0.0 or tail >= 1.0:
			return
		var pts := PackedVector2Array()
		var segs: int = 22
		for i in range(segs + 1):
			var s: float = lerpf(tail, head, float(i) / float(segs))
			pts.append(_bez(s))
		var core: Color = Color(0.72, 0.92, 1.0, 0.95)
		var glow: Color = Color(0.45, 0.78, 0.95, 0.35)
		draw_polyline(pts, glow, 9.0, true)
		draw_polyline(pts, core, 3.6, true)
		# travelling droplets along the arc
		for i in range(5):
			var dp: float = fposmod(u * 2.4 + float(i) * 0.2, 1.0)
			if dp < tail or dp > head:
				continue
			var p: Vector2 = _bez(dp)
			draw_circle(p, 2.6 - 0.25 * float(i), Color(0.86, 0.97, 1.0, 0.9))
		# the splash, once the water has arrived
		if u > 0.26:
			var sp: float = clampf((u - 0.26) / 0.5, 0.0, 1.0)
			var r: float = 10.0 + sp * 30.0
			var ring := PackedVector2Array()
			for i in range(22):
				var a: float = TAU * float(i) / 22.0
				ring.append(to_p + Vector2(cos(a) * r, sin(a) * r * 0.32))
			ring.append(ring[0])
			draw_polyline(ring, Color(0.75, 0.93, 1.0, 0.5 * (1.0 - sp)), 2.2, true)
			for i in range(4):
				var a2: float = PI * (0.15 + 0.23 * float(i))
				var d: float = sp * (26.0 + 6.0 * float(i))
				var pos: Vector2 = to_p + Vector2(-cos(a2) * d, -sin(a2) * d * (1.0 - sp) - 6.0)
				draw_circle(pos, 2.4 * (1.0 - sp), Color(0.8, 0.95, 1.0, 0.8 * (1.0 - sp)))


# -----------------------------------------------------------------------------
#  _Damp — the patch of darkened, watered soil. It lingers, then quietly dries.
# -----------------------------------------------------------------------------
class _Damp extends Node2D:
	var radius: float = 34.0

	func begin() -> void:
		modulate.a = 0.0
		var tw: Tween = create_tween()
		tw.tween_property(self, "modulate:a", 1.0, 0.45)
		tw.tween_interval(16.0)
		tw.tween_property(self, "modulate:a", 0.0, 7.0)
		tw.tween_callback(queue_free)

	func _draw() -> void:
		for i in range(3):
			var r: float = radius * (1.0 - 0.26 * float(i))
			var pts := PackedVector2Array()
			for s in range(22):
				var a: float = TAU * float(s) / 22.0
				pts.append(Vector2(cos(a) * r, sin(a) * r * 0.3))
			draw_colored_polygon(pts, Color(0.16, 0.12, 0.09, 0.09 + 0.05 * float(i)))


# -----------------------------------------------------------------------------
#  _Shears — the drawn shears that come to your finger while you shape a plant.
# -----------------------------------------------------------------------------
class _Shears extends ProcNode:
	var _open: float = 1.0
	var _snap: float = 0.0

	func _on_built() -> void:
		grow_rate = 0.0
		set_growth(1.0)
		animate_draw = true

	func snip() -> void:
		_snap = 1.0

	func _animate(delta: float) -> void:
		_snap = maxf(0.0, _snap - delta * 3.2)
		_open = lerpf(1.0, 0.1, _snap)
		rotation = -0.25 + sin(t * 2.0 + phase) * 0.04

	func _draw() -> void:
		var steel: Color = Color(0.82, 0.86, 0.9)
		var dark: Color = Color(0.3, 0.33, 0.36)
		var wood: Color = Color(0.52, 0.34, 0.22)
		var spread: float = 0.34 * _open
		for sgn in [-1.0, 1.0]:
			var a: float = sgn * spread
			var tipv: Vector2 = Vector2(sin(a), -cos(a)) * 30.0
			var blade := PackedVector2Array([
				Vector2(0.0, 0.0), tipv + Vector2(sgn * 3.4, 0.0),
				tipv, Vector2(sgn * -2.0, 2.0)])
			draw_polygon(blade, Proc.grad_fill(blade, steel, steel.darkened(0.3)))
			draw_polyline(PackedVector2Array([blade[0], blade[1], blade[2], blade[3], blade[0]]),
				dark, 1.2, true)
			# handle + grip loop
			var hv: Vector2 = Vector2(sin(a * 1.4), cos(a * 1.4)) * 26.0
			draw_line(Vector2.ZERO, hv, wood, 4.2, true)
			var loop := PackedVector2Array()
			for i in range(14):
				var ang: float = TAU * float(i) / 14.0
				loop.append(hv + Vector2(cos(ang) * 7.0, sin(ang) * 9.0))
			loop.append(loop[0])
			draw_polyline(loop, wood.darkened(0.15), 3.0, true)
		draw_circle(Vector2.ZERO, 3.4, dark)
		draw_circle(Vector2.ZERO, 1.6, Color(1, 1, 1, 0.6))
		if _snap > 0.05:
			draw_circle(Vector2(0.0, -24.0), 9.0 * _snap, Color(1, 1, 1, 0.22 * _snap))


# -----------------------------------------------------------------------------
#  _Torch — stood in the ground; everything in its light stays warm.
# -----------------------------------------------------------------------------
class _Torch extends ProcNode:
	var pal: Dictionary = {}
	var footprint_radius: float = 16.0
	var _flame: _Bit = null
	var _glow: _Bit = null

	func _on_built() -> void:
		_glow = _Bit.new()
		_glow.kind = "glow"
		_glow.col = Color(1.0, 0.72, 0.36)
		_glow.rad = 74.0
		_glow.position = Vector2(0.0, -96.0)
		var mat := CanvasItemMaterial.new()
		mat.blend_mode = CanvasItemMaterial.BLEND_MODE_ADD
		_glow.material = mat
		add_child(_glow)
		_flame = _Bit.new()
		_flame.kind = "flame"
		_flame.col = Color(1.0, 0.56, 0.22)
		_flame.rad = 11.0
		_flame.position = Vector2(0.0, -98.0)
		add_child(_flame)

	func gutter() -> void:
		var tw: Tween = create_tween()
		tw.tween_property(self, "modulate:a", 0.0, 1.8)
		tw.tween_callback(queue_free)

	func _animate(_delta: float) -> void:
		var gv: float = maxf(0.001, g())
		var flick: float = 0.86 + 0.14 * sin(t * 7.3 + phase) + 0.06 * sin(t * 13.1)
		if _flame != null:
			_flame.position.y = -98.0 * gv
			_flame.scale = Vector2(flick * 0.96, flick) * gv
			_flame.rotation = sin(t * 3.1 + phase) * 0.09
		if _glow != null:
			_glow.position.y = -96.0 * gv
			_glow.scale = Vector2.ONE * (0.9 + 0.1 * flick) * gv

	func _draw() -> void:
		var gv: float = g()
		if gv <= 0.01:
			return
		var wood: Color = Color(0.42, 0.29, 0.19)
		if pal.has("soil") and pal["soil"] is Color:
			wood = (pal["soil"] as Color).lerp(wood, 0.5)
		var h: float = 100.0 * gv
		# shadow + a little mound of pushed-up earth
		var mound := PackedVector2Array()
		for i in range(18):
			var a: float = PI + PI * float(i) / 17.0
			mound.append(Vector2(cos(a) * 15.0 * gv, sin(a) * 6.0 * gv))
		draw_colored_polygon(mound, Color(0.05, 0.05, 0.04, 0.22))
		# the shaft, slightly tapered and leaning
		var lean: float = 0.07
		var top: Vector2 = Vector2(sin(lean) * h, -cos(lean) * h)
		var shaft := PackedVector2Array([
			Vector2(-4.4, 0.0), Vector2(4.4, 0.0),
			top + Vector2(3.0, 0.0), top + Vector2(-3.0, 0.0)])
		draw_polygon(shaft, Proc.grad_fill(shaft, wood.lightened(0.22), wood.darkened(0.38)))
		draw_polyline(PackedVector2Array([shaft[0], shaft[1], shaft[2], shaft[3], shaft[0]]),
			wood.darkened(0.5), 1.2, true)
		# wrapped cloth head
		var head := PackedVector2Array()
		for i in range(20):
			var a2: float = TAU * float(i) / 20.0
			head.append(top + Vector2(cos(a2) * 9.0 * gv, sin(a2) * 12.0 * gv - 4.0))
		var cloth: Color = Color(0.56, 0.44, 0.3)
		draw_polygon(head, Proc.grad_fill(head, cloth.lightened(0.2), cloth.darkened(0.35)))
		for i in range(3):
			var y: float = top.y - 9.0 + float(i) * 6.0
			draw_line(Vector2(top.x - 8.0 * gv, y), Vector2(top.x + 8.0 * gv, y),
				cloth.darkened(0.4), 1.4, true)
		# embers rising
		var re: RandomNumberGenerator = Proc.rng(seedv, "ember")
		for i in range(3):
			var ph: float = fposmod(t * 0.5 + re.randf(), 1.0)
			var ex: float = top.x + sin(ph * 6.0 + float(i)) * 7.0
			var ey: float = top.y - 16.0 - ph * 34.0
			draw_circle(Vector2(ex, ey), 1.8 * (1.0 - ph), Color(1.0, 0.72, 0.4, 0.8 * (1.0 - ph)))


# -----------------------------------------------------------------------------
#  _Rime — the frost that draws itself around a cold thing's base in Stillfrost.
# -----------------------------------------------------------------------------
class _Rime extends Node2D:
	var radius: float = 28.0
	var seedv: int = 1

	func _draw() -> void:
		var r: RandomNumberGenerator = Proc.rng(seedv, "rime")
		var ice: Color = Color(0.78, 0.9, 1.0)
		# a pale crust hugging the ground
		var crust := PackedVector2Array()
		for i in range(26):
			var a: float = TAU * float(i) / 26.0
			var rr: float = radius * (0.9 + r.randf_range(-0.12, 0.16))
			crust.append(Vector2(cos(a) * rr * 1.25, sin(a) * rr * 0.3))
		draw_colored_polygon(crust, Color(ice.r, ice.g, ice.b, 0.22))
		draw_polyline(_closed(crust), Color(ice.r, ice.g, ice.b, 0.4), 1.4, true)
		# little needle crystals
		for i in range(9):
			var bx: float = r.randf_range(-radius * 1.1, radius * 1.1)
			var by: float = r.randf_range(-6.0, 3.0)
			var hgt: float = r.randf_range(5.0, 13.0)
			var tilt: float = r.randf_range(-0.4, 0.4)
			var tip: Vector2 = Vector2(bx + sin(tilt) * hgt, by - cos(tilt) * hgt)
			draw_line(Vector2(bx, by), tip, Color(ice.r, ice.g, ice.b, 0.72), 1.6, true)
			draw_line(tip, tip + Vector2(2.6, 2.2), Color(1, 1, 1, 0.5), 1.2, true)
			draw_line(tip, tip + Vector2(-2.6, 2.2), Color(1, 1, 1, 0.5), 1.2, true)
		# a cold glint
		draw_circle(Vector2(radius * 0.4, -8.0), 1.8, Color(1, 1, 1, 0.7))

	func _closed(p: PackedVector2Array) -> PackedVector2Array:
		var out: PackedVector2Array = p.duplicate()
		if out.size() > 0:
			out.append(out[0])
		return out


# -----------------------------------------------------------------------------
#  _Bubble — the shared thought-bubble language of this layer (§7.4): a parchment
#  cloud, two trailing dots, a generated glyph. Used for the ask and for thanks.
# -----------------------------------------------------------------------------
class _Bubble extends ProcNode:
	const PARCH := Color("#FBF6E9")
	const INK := Color("#3A2E22")
	var glyph: String = "droplet"
	var _cloud: PackedVector2Array = PackedVector2Array()

	func _on_built() -> void:
		grow_rate = 0.0
		set_growth(1.0)
		var ctrl := PackedVector2Array()
		var r: RandomNumberGenerator = Proc.rng(seedv, "cloud")
		for i in range(9):
			var a: float = TAU * float(i) / 9.0
			var rr: float = 26.0 * (1.0 + r.randf_range(-0.14, 0.14))
			ctrl.append(Vector2(cos(a) * rr * 1.24, sin(a) * rr * 0.86))
		_cloud = Proc.smooth_loop(ctrl, 8)

	func appear(life: float) -> void:
		scale = Vector2(0.2, 0.2)
		modulate.a = 0.0
		var tw: Tween = create_tween().set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
		tw.tween_property(self, "scale", Vector2.ONE, 0.18)
		tw.parallel().tween_property(self, "modulate:a", 1.0, 0.18)
		tw.tween_interval(maxf(0.6, life - 0.6))
		tw.tween_property(self, "modulate:a", 0.0, 0.4)
		tw.tween_callback(queue_free)

	func dismiss() -> void:
		var tw: Tween = create_tween()
		tw.tween_property(self, "modulate:a", 0.0, 0.3)
		tw.tween_callback(queue_free)

	func _animate(_delta: float) -> void:
		position.y += sin(t * 1.4 + phase) * 0.06
		rotation = sin(t * 0.9 + phase) * 0.02

	func _draw() -> void:
		if _cloud.size() < 3:
			return
		draw_colored_polygon(_cloud, PARCH)
		var ring: PackedVector2Array = _cloud.duplicate()
		ring.append(_cloud[0])
		draw_polyline(ring, INK, 1.5, true)
		# two trailing dots toward the speaker below
		draw_circle(Vector2(-6.0, 26.0), 5.0, PARCH)
		draw_arc(Vector2(-6.0, 26.0), 5.0, 0.0, TAU, 14, INK, 1.3, true)
		draw_circle(Vector2(-12.0, 36.0), 3.0, PARCH)
		draw_arc(Vector2(-12.0, 36.0), 3.0, 0.0, TAU, 12, INK, 1.1, true)
		_draw_glyph()

	func _draw_glyph() -> void:
		match glyph:
			"droplet":
				var pts := PackedVector2Array()
				for i in range(16):
					var u: float = float(i) / 15.0
					pts.append(Vector2(sin(u * PI) * 8.0, -11.0 + u * 22.0))
				for i in range(15, -1, -1):
					var u2: float = float(i) / 15.0
					pts.append(Vector2(-sin(u2 * PI) * 8.0, -11.0 + u2 * 22.0))
				draw_colored_polygon(pts, Color(0.38, 0.68, 0.88))
				draw_circle(Vector2(-3.0, 4.0), 2.0, Color(1, 1, 1, 0.7))
			"leaf":
				var lf := PackedVector2Array()
				for i in range(18):
					var u: float = float(i) / 17.0
					lf.append(Vector2(-11.0 + u * 22.0, -sin(u * PI) * 8.0))
				for i in range(17, -1, -1):
					var u2: float = float(i) / 17.0
					lf.append(Vector2(-11.0 + u2 * 22.0, sin(u2 * PI) * 3.0))
				draw_colored_polygon(lf, Color(0.4, 0.68, 0.34))
				draw_line(Vector2(-11.0, 0.0), Vector2(11.0, 0.0), Color(0.24, 0.45, 0.2), 1.2, true)
			"ember":
				for layer in range(2):
					var sc: float = 1.0 - 0.38 * float(layer)
					var fl := PackedVector2Array()
					for i in range(14):
						var u: float = float(i) / 13.0
						fl.append(Vector2(sin(u * PI) * 7.0 * sc * (1.0 - u * 0.5), 10.0 - u * 22.0 * sc))
					for i in range(13, -1, -1):
						var u2: float = float(i) / 13.0
						fl.append(Vector2(-sin(u2 * PI) * 7.0 * sc * (1.0 - u2 * 0.5), 10.0 - u2 * 22.0 * sc))
					draw_colored_polygon(fl, Color(1.0, 0.55 + 0.3 * float(layer), 0.2 + 0.4 * float(layer)))
			"heart":
				var ht := PackedVector2Array()
				for i in range(30):
					var a: float = TAU * float(i) / 30.0
					var x: float = 16.0 * pow(sin(a), 3.0)
					var y: float = -(13.0 * cos(a) - 5.0 * cos(2.0 * a) - 2.0 * cos(3.0 * a) - cos(4.0 * a))
					ht.append(Vector2(x * 0.62, y * 0.62))
				draw_colored_polygon(ht, Color(0.92, 0.42, 0.48))
				draw_circle(Vector2(-4.0, -3.0), 2.0, Color(1, 1, 1, 0.6))
			"berry":
				for i in range(3):
					var a2: float = -0.6 + 0.6 * float(i)
					draw_circle(Vector2(sin(a2) * 7.0, 2.0 + cos(a2) * 3.0), 5.0, Color(0.78, 0.26, 0.38))
					draw_circle(Vector2(sin(a2) * 7.0 - 1.6, 0.4 + cos(a2) * 3.0), 1.6, Color(1, 1, 1, 0.55))
				draw_line(Vector2(0.0, -2.0), Vector2(2.0, -11.0), Color(0.36, 0.5, 0.26), 1.6, true)
			_:
				draw_circle(Vector2.ZERO, 7.0, Color(1.0, 0.92, 0.6))


# -----------------------------------------------------------------------------
#  _Mote — a droplet, a snipped leaf, an ember, a crumb, a sparkle. Drifts, fades,
#  frees itself. All of them together stay inside this layer's 24-mote budget.
# -----------------------------------------------------------------------------
class _Mote extends ProcNode:
	var kind: String = "droplet"
	var life: float = 1.6
	var vel: Vector2 = Vector2.ZERO
	var spin: float = 0.0

	func _on_built() -> void:
		grow_rate = 0.0
		set_growth(1.0)
		var r: RandomNumberGenerator = Proc.rng(seedv, "mote")
		match kind:
			"droplet":
				vel = Vector2(r.randf_range(-16.0, 16.0), r.randf_range(26.0, 54.0))
				life = 1.0
			"leaf":
				vel = Vector2(r.randf_range(-34.0, 34.0), r.randf_range(10.0, 26.0))
				spin = r.randf_range(-2.4, 2.4)
				life = 2.6
			"ember":
				vel = Vector2(r.randf_range(-10.0, 10.0), r.randf_range(-40.0, -22.0))
				life = 1.9
			"crumb":
				vel = Vector2(r.randf_range(-24.0, 24.0), r.randf_range(14.0, 34.0))
				spin = r.randf_range(-3.0, 3.0)
				life = 1.3
			_:
				vel = Vector2(r.randf_range(-12.0, 12.0), r.randf_range(-34.0, -18.0))
				life = 1.4

	func _animate(delta: float) -> void:
		position += vel * delta
		if kind == "leaf":
			position.x += sin(t * 3.0 + phase) * 14.0 * delta
			vel.y = minf(vel.y + 18.0 * delta, 52.0)
		elif kind == "droplet" or kind == "crumb":
			vel.y += 90.0 * delta
		rotation += spin * delta
		modulate.a = clampf(1.0 - t / life, 0.0, 1.0)
		if t >= life:
			queue_free()

	func _draw() -> void:
		match kind:
			"droplet":
				var d := PackedVector2Array()
				for i in range(12):
					var u: float = float(i) / 11.0
					d.append(Vector2(sin(u * PI) * 2.6, -3.6 + u * 7.4))
				for i in range(11, -1, -1):
					var u2: float = float(i) / 11.0
					d.append(Vector2(-sin(u2 * PI) * 2.6, -3.6 + u2 * 7.4))
				draw_colored_polygon(d, Color(0.62, 0.86, 1.0, 0.92))
			"leaf":
				var lf := PackedVector2Array()
				for i in range(12):
					var u: float = float(i) / 11.0
					lf.append(Vector2(-6.0 + u * 12.0, -sin(u * PI) * 4.2))
				for i in range(11, -1, -1):
					var u2: float = float(i) / 11.0
					lf.append(Vector2(-6.0 + u2 * 12.0, sin(u2 * PI) * 1.6))
				draw_colored_polygon(lf, Color(0.44, 0.7, 0.36, 0.95))
			"ember":
				draw_circle(Vector2.ZERO, 2.6, Color(1.0, 0.68, 0.32, 0.9))
				draw_circle(Vector2.ZERO, 1.2, Color(1, 1, 0.86, 0.95))
			"crumb":
				draw_circle(Vector2.ZERO, 2.0, Color(0.82, 0.66, 0.42, 0.95))
			_:
				draw_circle(Vector2.ZERO, 2.2, Color(1.0, 0.96, 0.78, 0.9))
				draw_circle(Vector2.ZERO, 4.4, Color(1.0, 0.95, 0.7, 0.22))


# -----------------------------------------------------------------------------
#  _Offering — the bloom or berry sprig a creature is offered, eaten in 3 bites.
# -----------------------------------------------------------------------------
class _Offering extends ProcNode:
	var glyph: String = "bloom"
	var bites: int = 0

	func _on_built() -> void:
		grow_rate = 0.0
		set_growth(1.0)

	func eat(dur: float) -> void:
		var tw: Tween = create_tween()
		tw.tween_property(self, "position:y", position.y - 8.0, 0.2)
		for i in range(3):
			tw.tween_interval(maxf(0.18, dur / 3.0))
			tw.tween_callback(_bite)
		tw.tween_property(self, "modulate:a", 0.0, 0.25)
		tw.tween_callback(queue_free)

	func _bite() -> void:
		bites += 1
		queue_redraw()
		var tw: Tween = create_tween().set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
		tw.tween_property(self, "scale", Vector2(1.14, 0.88), 0.08)
		tw.tween_property(self, "scale", Vector2.ONE, 0.16)

	func _animate(_delta: float) -> void:
		rotation = sin(t * 2.2 + phase) * 0.06

	func _draw() -> void:
		var left: int = maxi(0, 3 - bites)
		if left <= 0:
			return
		# a little stem, then the heads
		draw_line(Vector2(0.0, 6.0), Vector2(0.0, -6.0), Color(0.36, 0.52, 0.28), 2.0, true)
		for i in range(left):
			var a: float = -0.5 + 0.5 * float(i)
			var c: Vector2 = Vector2(sin(a) * 7.0, -7.0 + cos(a) * 2.0)
			if glyph == "berry":
				draw_circle(c, 5.2, Color(0.8, 0.27, 0.4))
				draw_circle(c + Vector2(-1.6, -1.6), 1.7, Color(1, 1, 1, 0.55))
			elif glyph == "loaf":
				var l: PackedVector2Array = Proc.superellipse(7.0, 4.6, 3.2, 18)
				var mv := PackedVector2Array()
				for p in l:
					mv.append(p + c)
				draw_polygon(mv, Proc.grad_fill(mv, Color(0.9, 0.73, 0.45), Color(0.68, 0.48, 0.26)))
				draw_line(c + Vector2(-3.4, -1.0), c + Vector2(3.4, -1.6), Color(0.52, 0.36, 0.2), 1.2, true)
			else:
				for k in range(5):
					var pa: float = TAU * float(k) / 5.0
					draw_circle(c + Vector2(cos(pa), sin(pa)) * 3.6, 2.6, Color(0.96, 0.78, 0.36))
				draw_circle(c, 2.2, Color(0.98, 0.94, 0.62))
