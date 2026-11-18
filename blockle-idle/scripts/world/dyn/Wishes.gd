class_name Wishes
extends Node2D
# Wishes — the DIEGETIC QUEST LAYER (DYNAMICS §6.2).
#
# There is no quest log, no task list, no "!" over a head. Instead the living
# things on the island quietly WANT something, and that want is drawn as a soft
# parchment thought-bubble floating over the wisher, with a gold progress arc
# sweeping around its rim and a hand-drawn glyph of the thing wished for — a loaf,
# a lantern, a sprout, a droplet, two little hearts, a star.
#
#   • A creature dreams of a blossom tree growing near it.
#   • The land itself (the Heart Tree speaking for it) wishes for water in the dry
#     east, for a lantern against the night, for roots woven out to sleeping ground.
#   • A merchant passing through wishes for one richer thing.
#
# Fulfilling a wish is never a chore: you plant the thing, you tend the thing, you
# hand the thing over (drag it onto the wisher, or tap → Grant). Then a joy
# celebration blooms — petals, light, rising motes — and a real reward lands: a rare
# seed, an essence surge, a material, a new creature walking in from the island's
# edge. Three wishes from one creature and it gifts you its own rare variant seed.
#
# Every wish is seeded, gentle and PATIENT: 1-3 at a time, never expiring, never
# scolding. Ignore one forever and nothing bad happens; shelve it with a double-tap
# and it drifts back into the pool. Wishes also chain into six slow ARCS whose
# completion grants a small permanent blessing through Rituals.
#
# MENU-LESS (DYNAMICS §1): this file adds no panel, bar, list or HUD — only
# ProcNode bubbles, glows, motes, whispers and ActionBubble verbs.
#
# ---------------------------------------------------------------------------
# PUBLIC API
#   setup(world_seed: int, ctx: Dictionary) -> void      # {space, interact, sim, puzzles, sky}
#   catch_up(elapsed: float) -> void
#   notify(kind: String, payload: Dictionary) -> void
#   active_wishes() -> Array                             # [{id, kind, giver, want, prog}]
#   note_progress(kind: String, payload: Dictionary) -> void
#   wants(mat_or_key: String) -> bool
#   permanent(key: String) -> float                      # arc blessings, if Rituals absent
#   offer_hint(place_id: String) -> void                  # Nurture's "ask" pick
#   extra_actions(record) -> Array                        # "hear" / "grant"
#   handle_action(action, record) -> bool                 # owns "hear", "grant"
#   handle_drop(entry, inst_key, world_pos) -> bool       # hand a wanted item to the wisher
#   handle_tap(screen_pos, world_pos) -> bool             # tap a bubble: listen / shelve
#   signals: whisper(text), dyn_event(kind, payload)
#
# STATE: Game.state["wishes"] only (migrate-safe, every field .get-backfilled).
# ---------------------------------------------------------------------------

signal whisper(text: String)
signal dyn_event(kind: String, payload: Dictionary)

const SYS_KEY := "wishes"
const SYS_VERSION := 1

# --- cadence (DYNAMICS §6.2) -------------------------------------------------
const TICK := 5.0                  # logic period (seconds)
const MAX_ACTIVE := 3
const MIN_GAP := 1200.0            # 20 min between offers, ÷ cadence
const MIN_GAP_FLOOR := 720.0       # never tighter than 12 min
const PITY_OFFER := 3600.0         # 60 min of play with a free slot → forced easy offer
const SHELF_COOLDOWN := 2700.0     # 45 min before a shelved template returns
const WHISPER_GAP := 8.0           # §2.6 whisper budget for this system
const BUBBLE_TAP_R := 72.0         # world-space radius for a tap on a bubble
const DOUBLE_TAP := 2.0            # two taps inside this window = shelve
const HAND_OVER_R := 150.0         # drop-onto-the-wisher radius
const MAX_TRAIL_MOTES := 8         # our slice of the layer's 24-mote soft budget

# --- shared clamp table (DYNAMICS §2.1) --------------------------------------
const CAP := {"grow": 1.6, "yield": 1.6, "bond": 2.0, "luck": 3.0,
	"cadence": 1.5, "craft": 1.5, "offline": 12.0}
const FLOOR_MULT := 0.92

# --- offline curve (DYNAMICS §2.3) ------------------------------------------
const OFFLINE_FULL_HOURS := 8.0
const OFFLINE_CAP_HOURS := 48.0
const OFFLINE_FLOOR := 0.5

# --- arc blessings ----------------------------------------------------------
const ARC_BLESSING := 0.03         # +3% per arc …
const PERM_MAX := 0.12             # … capped at +12% across all six

# Raw materials this layer may ask for. Mirrors Chains' table read-only: Wishes
# never *defines* an item, it only knows the names and how to draw a glyph for one.
const MATS := {
	"dewdrop": {"label": "a dewdrop", "glyph": "droplet"},
	"heartwood": {"label": "heartwood", "glyph": "wood"},
	"emberbloom": {"label": "emberbloom", "glyph": "ember"},
	"moonsilver": {"label": "moonsilver", "glyph": "shard"},
	"skyshard": {"label": "a skyshard", "glyph": "star"},
	"lichen_wool": {"label": "lichen wool", "glyph": "coil"},
	"honeycomb": {"label": "honeycomb", "glyph": "comb"},
	"river_clay": {"label": "river clay", "glyph": "clay"},
}
const GOODS := {
	"grainloaf": {"label": "a grainloaf", "glyph": "loaf"},
	"honeycake": {"label": "a honeycake", "glyph": "cake"},
	"lightwell_glass": {"label": "lightwell glass", "glyph": "glass"},
	"rootbalm": {"label": "rootbalm", "glyph": "balm"},
}

const CARE_VERBS := ["water", "prune", "feed", "warm"]
const CARE_WORD := {"water": "watering", "prune": "pruning", "feed": "feeding",
	"warm": "warming"}

# The six slow arcs (DYNAMICS §6.2). `steps` are *templates*; the concrete want is
# resolved at offer time against what the player can actually reach, and the order
# of the opening steps is shuffled per world (the final step always closes the arc).
const ARCS := {
	"lantern_road": {
		"label": "the Lantern Road", "blessing": "yield",
		"steps": [
			{"kind": "plant", "want": {"kind": "decor", "species": "lantern", "n": 3, "radius": 460.0}},
			{"kind": "craft", "want": {"recipe": "lightwell_glass"}},
			{"kind": "host", "want": {"building_id": "any"}},
			{"kind": "ritual", "want": {"rite": "light"}},
		],
		"gift": "lanterns",
	},
	"deep_root": {
		"label": "the Deep Root", "blessing": "grow",
		"steps": [
			{"kind": "bring", "want": {"mat": "river_clay", "n": 2}},
			{"kind": "puzzle", "want": {"puzzle": "rootwork", "n": 1}},
			{"kind": "tend", "want": {"verb": "water", "n": 6}},
			{"kind": "ritual", "want": {"rite": "roots"}},
		],
		"gift": "everbloom",
	},
	"quiet_rain": {
		"label": "the Quiet Rain", "blessing": "grow",
		"steps": [
			{"kind": "tend", "want": {"verb": "any", "n": 12}},
			{"kind": "witness", "want": {"event": "bloomtide"}},
			{"kind": "bring", "want": {"mat": "dewdrop", "n": 3}},
			{"kind": "ritual", "want": {"rite": "rain"}},
		],
		"gift": "rainkeeping",
	},
	"seed_library": {
		"label": "the Seed Library", "blessing": "luck",
		"steps": [
			{"kind": "plant", "want": {"distinct": 6, "radius": 0.0}},
			{"kind": "find", "want": {"what": "hybrid", "n": 1}},
			{"kind": "find", "want": {"what": "radiant", "n": 1}},
			{"kind": "ritual", "want": {"rite": "finding"}},
		],
		"gift": "second_trunk",
	},
	"long_table": {
		"label": "the Long Table", "blessing": "bond",
		"steps": [
			{"kind": "craft", "want": {"recipe": "grainloaf"}},
			{"kind": "craft", "want": {"recipe": "honeycake"}},
			{"kind": "befriend", "want": {"bond": 0.45, "n": 2}},
			{"kind": "witness", "want": {"event": "festival"}},
		],
		"gift": "festival_lanterns",
	},
	"star_vigil": {
		"label": "the Star Vigil", "blessing": "cadence",
		"steps": [
			{"kind": "witness", "want": {"event": "meteor"}},
			{"kind": "bring", "want": {"mat": "moonsilver", "n": 1}},
			{"kind": "vigil", "want": {"n": 3}},
			{"kind": "ritual", "want": {"rite": "long_year"}},
		],
		"gift": "ascension",
	},
}
const ARC_IDS := ["lantern_road", "deep_root", "quiet_rain", "seed_library",
	"long_table", "star_vigil"]

# Poetic whisper lines, chosen seeded. Never a demand — always an observation.
const LINE_BRING := [
	"%s is thinking of %s — %s would be plenty.",
	"%s keeps glancing toward where %s is kept. %s, perhaps.",
]
const LINE_CRAFT := [
	"%s is dreaming of %s, warm from the hearth.",
	"%s would like to taste %s, just once.",
]
const LINE_PLANT := [
	"%s dreams of %s growing nearby.",
	"%s wants %s close enough to touch.",
]
const LINE_TEND := [
	"%s wishes the garden were tended — a little %s would do.",
	"%s is watching the garden, hoping for some %s.",
]
const LINE_BEFRIEND := [
	"%s is lonely in a small, hopeful way.",
	"%s would like someone to walk beside.",
]
const LINE_HOST := [
	"%s wishes %s stood somewhere near.",
	"%s keeps pacing out the shape of %s on the grass.",
]
const LINE_WITNESS := [
	"%s is waiting for %s, face turned to the sky.",
	"%s wants to be awake when %s comes.",
]
const LINE_RITUAL := [
	"%s longs to see %s kept at the stones.",
	"%s hums the old tune of %s under its breath.",
]
const LINE_PUZZLE := [
	"%s can feel sleeping ground at the edge, waiting for roots.",
	"%s dreams of the island being wider than it is.",
]
const LINE_FIND := [
	"%s wonders what else the island is hiding.",
	"%s wants to meet something nobody has met yet.",
]
const LINE_VIGIL := [
	"%s keeps three quiet nights in mind.",
	"%s is counting nights, not hours.",
]
const LINE_DONE := [
	"A small joy, and it is enough.",
	"%s will remember this one.",
	"The island feels a little kinder.",
	"%s is quietly, completely pleased.",
]

# =============================================================================
# RUNTIME
# =============================================================================
var world_seed: int = 1

var _space: Node = null            # WorldSpace
var _interact: Node = null
var _sim: Node = null
var _puzzles: Node = null

var _acc := 0.0
var _bubble_t := 0.0
var _last_whisper := -999.0
var _booted := false

# runtime-only mirrors (never serialised)
var _live: Dictionary = {}         # wish_id -> {bubble: Node2D, ring: Node, glow: Node}
var _mirror: Dictionary = {}       # place_id -> {node, entry, tx}   (fallback registry)
var _tap_mem: Dictionary = {}      # wish_id -> last tap time (double-tap shelve)
var _hint_place := ""              # Nurture's "ask" pick, used to aim tend wishes
var _trails: Array = []            # live trail motes
var _creature_pool_cache: Array = []
var _cache_t := -999.0
# De-dupe for care reports: Nurture can report the same care twice (dyn_event +
# direct note_progress), so collapse repeats of one (verb, thing) within a second.
var _last_care_key := ""
var _last_care_at := -999.0


# =============================================================================
# STATE  (DYNAMICS §3 — one key, every field backfilled, legacy saves load clean)
# =============================================================================
func _st() -> Dictionary:
	if Game == null or not (Game.state is Dictionary):
		return {}
	if not Game.state.has(SYS_KEY) or not (Game.state[SYS_KEY] is Dictionary):
		Game.state[SYS_KEY] = {}
	var st: Dictionary = Game.state[SYS_KEY]
	st["version"] = int(st.get("version", SYS_VERSION))
	st["seq"] = int(st.get("seq", 0))
	if not (st.get("pity") is Dictionary):
		st["pity"] = {}
	if not (st.get("active") is Array):
		st["active"] = []
	if not (st.get("done") is Dictionary):
		st["done"] = {}
	# legacy/spec shape allowed an Array of shelved ids; we keep timestamps
	if st.get("shelved") is Array:
		var conv: Dictionary = {}
		for item in (st["shelved"] as Array):
			conv[String(item)] = 0.0
		st["shelved"] = conv
	if not (st.get("shelved") is Dictionary):
		st["shelved"] = {}
	if not (st.get("arcs") is Dictionary):
		st["arcs"] = {}
	if not (st.get("givers") is Dictionary):
		st["givers"] = {}
	if not (st.get("permanent") is Dictionary):
		st["permanent"] = {}
	if not (st.get("seen") is Dictionary):
		st["seen"] = {}
	st["last_offer"] = float(st.get("last_offer", 0.0))
	st["play"] = float(st.get("play", 0.0))
	st["granted"] = int(st.get("granted", 0))
	return st


func _arc_state(arc_id: String) -> Dictionary:
	var st: Dictionary = _st()
	if st.is_empty():
		return {"step": 0, "done": false}
	var arcs: Dictionary = st["arcs"]
	if not (arcs.get(arc_id) is Dictionary):
		arcs[arc_id] = {"step": 0, "done": false}
	var a: Dictionary = arcs[arc_id]
	a["step"] = int(a.get("step", 0))
	a["done"] = bool(a.get("done", false))
	return a


func _active() -> Array:
	var st: Dictionary = _st()
	if st.is_empty():
		return []
	return st["active"] as Array


# Deterministic roll from a persisted counter (DYNAMICS §2.5).
func _rand(tag: String) -> float:
	var st: Dictionary = _st()
	if st.is_empty():
		return Proc.hashf(world_seed, "%s:%s" % [SYS_KEY, tag])
	var n: int = int(st.get("seq", 0))
	st["seq"] = n + 1
	return Proc.hashf(world_seed, "%s:%s:%d" % [SYS_KEY, tag, n])


# Stable (counter-free) roll — layout, arc order, anything that must be the same
# in this world forever.
func _fixed(tag: String) -> float:
	return Proc.hashf(world_seed, "%s:fix:%s" % [SYS_KEY, tag])


func _pick(arr: Array, tag: String) -> Variant:
	if arr.is_empty():
		return null
	var i: int = int(_rand(tag) * float(arr.size()))
	return arr[clampi(i, 0, arr.size() - 1)]


func _pick_fixed(arr: Array, tag: String) -> Variant:
	if arr.is_empty():
		return null
	var i: int = int(_fixed(tag) * float(arr.size()))
	return arr[clampi(i, 0, arr.size() - 1)]


func _now() -> float:
	return float(Time.get_unix_time_from_system())


# =============================================================================
# LIFECYCLE
# =============================================================================
func setup(seed_value: int, ctx: Dictionary) -> void:
	world_seed = seed_value
	z_index = 32
	_space = ctx.get("space") as Node
	_interact = ctx.get("interact") as Node
	_sim = ctx.get("sim") as Node
	_puzzles = ctx.get("puzzles") as Node
	var st: Dictionary = _st()
	if not st.is_empty() and float(st.get("last_offer", 0.0)) <= 0.0:
		# a brand-new world: let the first wish arrive soon, but not instantly
		st["last_offer"] = _now() - MIN_GAP * 0.55
	_seed_mirror()
	_rebuild_bubbles()
	_booted = true
	set_process(true)


# Build the fallback registry once from whatever the world can tell us.
func _seed_mirror() -> void:
	for item in _records_list():
		var r: Dictionary = item
		var pid: String = String(r.get("id", ""))
		if pid == "":
			continue
		_mirror[pid] = {"node": r.get("node"), "entry": r.get("entry", {}),
			"tx": float(r.get("tx", 0.0))}


# Offline / resume: wishes never expire, so catch-up only credits patience and
# refreshes the progress arcs against the world as it now stands.
func catch_up(elapsed: float) -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	var e: float = _effective(maxf(0.0, elapsed))
	if int(_active().size()) < MAX_ACTIVE:
		st["play"] = float(st.get("play", 0.0)) + e
	_refresh_all_progress()
	_rebuild_bubbles()


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
		var h: float = float(r.call("blessing", "offline"))
		if h > OFFLINE_FULL_HOURS and h <= CAP["offline"]:
			return h
	return OFFLINE_FULL_HOURS


# =============================================================================
# SIBLING ACCESS  (DYNAMICS §4.1/§4.4 — every call optional + guarded)
# =============================================================================
func _sib(n: String) -> Node:
	var p: Node = get_parent()
	if p == null:
		return null
	return p.get_node_or_null(n)


func _mult(key: String, place_id: String) -> float:
	var m := 1.0
	var s: Node = _sib("SeasonsEvents")
	if s != null and s.has_method("modifier"):
		m *= float(s.call("modifier", key))
	var r: Node = _sib("Rituals")
	var rituals_has_perm := false
	if r != null and r.has_method("blessing"):
		m *= float(r.call("blessing", key))
		rituals_has_perm = r.has_method("register_permanent")
	var nu: Node = _sib("Nurture")
	if nu != null and nu.has_method("care_mult") and place_id != "":
		m *= float(nu.call("care_mult", place_id, key))
	var cl: Node = _sib("CreatureLife")
	if cl != null and place_id != "":
		if cl.has_method("job_mult"):
			m *= float(cl.call("job_mult", place_id, key))
		if cl.has_method("bond_mult"):
			m *= float(cl.call("bond_mult", place_id, key))
	var dc: Node = _sib("Discovery")
	if dc != null and dc.has_method("variant_mult") and place_id != "":
		m *= float(dc.call("variant_mult", place_id, key))
	if not rituals_has_perm:
		m *= 1.0 + permanent(key)
	return clampf(m, FLOOR_MULT, float(CAP.get(key, 1.5)))


# Arc blessings we hold ourselves when Rituals is not mounted.
func permanent(key: String) -> float:
	var st: Dictionary = _st()
	if st.is_empty():
		return 0.0
	var p: Dictionary = st["permanent"]
	return clampf(float(p.get(key, 0.0)), 0.0, PERM_MAX)


func _records_list() -> Array:
	if _space != null and _space.has_method("records"):
		var arr: Variant = _space.call("records")
		if arr is Array:
			return arr as Array
	var out: Array = []
	for pid in _mirror.keys():
		var m: Dictionary = _mirror[pid]
		out.append({"id": String(pid), "node": m.get("node"),
			"entry": m.get("entry", {}), "tx": float(m.get("tx", 0.0))})
	return out


func _record(place_id: String) -> Dictionary:
	if place_id == "":
		return {}
	if _space != null and _space.has_method("record_by_id"):
		var r: Variant = _space.call("record_by_id", place_id)
		if r is Dictionary and not (r as Dictionary).is_empty():
			return r as Dictionary
	for item in _records_list():
		var rr: Dictionary = item
		if String(rr.get("id", "")) == place_id:
			return rr
	return {}


func _node_of(place_id: String) -> Node2D:
	var r: Dictionary = _record(place_id)
	var n: Variant = r.get("node")
	if n is Node2D and is_instance_valid(n as Node2D):
		return n as Node2D
	return null


func _heart_pos() -> Vector2:
	if _space != null and _space.has_method("heart_foot"):
		var p: Variant = _space.call("heart_foot")
		if p is Vector2:
			return p as Vector2
	return Vector2.ZERO


func _heart_height() -> float:
	if _space != null and _space.has_method("heart_node"):
		var hn: Variant = _space.call("heart_node")
		if hn is Node2D and is_instance_valid(hn as Node2D):
			return maxf(180.0, _prop_f(hn as Node2D, "footprint_radius", 160.0) * 1.5)
	return 280.0


func _prop_f(o: Object, pname: String, fallback: float) -> float:
	if o == null:
		return fallback
	for p in o.get_property_list():
		if String(p.get("name", "")) == pname:
			return float(o.get(pname))
	return fallback


func _inventory() -> Dictionary:
	if Game == null or not (Game.state is Dictionary):
		return {}
	if not (Game.state.get("inventory") is Dictionary):
		Game.state["inventory"] = {}
	return Game.state["inventory"] as Dictionary


# =============================================================================
# §4.4 READ-ONLY QUERY SURFACE
# =============================================================================
func active_wishes() -> Array:
	var out: Array = []
	for item in _active():
		var w: Dictionary = item
		out.append({
			"id": String(w.get("id", "")),
			"kind": String(w.get("kind", "")),
			"giver": String(w.get("giver", "")),
			"want": (w.get("want", {}) as Dictionary).duplicate(true),
			"prog": float(w.get("prog", 0.0)),
			"arc": String(w.get("arc", "")),
		})
	return out


# Does anything on the island currently want this material / recipe / species?
func wants(mat_or_key: String) -> bool:
	if mat_or_key == "":
		return false
	for item in _active():
		var w: Dictionary = item
		var want: Dictionary = w.get("want", {}) as Dictionary
		for k in ["mat", "recipe", "species", "building_id", "event", "rite"]:
			if String(want.get(k, "")) == mat_or_key:
				return true
	return false


# Public mirror of notify(), for siblings that prefer a direct call.
func note_progress(kind: String, payload: Dictionary) -> void:
	notify(kind, payload)


# Nurture hands us the thing that is "asking" so a tend wish lands on something
# the player can already see glowing.
func offer_hint(place_id: String) -> void:
	_hint_place = place_id


# =============================================================================
# THE TICK
# =============================================================================
func _process(delta: float) -> void:
	if not _booted:
		return
	_bubble_t += delta
	_follow_bubbles(delta)
	_advance_trails(delta)
	_acc += delta
	if _acc < TICK:
		return
	var step: float = _acc
	_acc = 0.0
	if Game == null or not Game.booted:
		return
	var st: Dictionary = _st()
	if st.is_empty():
		return
	# patience accrues only while there is room for another wish
	if _active().size() < MAX_ACTIVE:
		st["play"] = float(st.get("play", 0.0)) + step
	_refresh_all_progress()
	_settle_complete()
	_maybe_offer()


func _maybe_offer() -> void:
	var st: Dictionary = _st()
	if st.is_empty() or _active().size() >= MAX_ACTIVE:
		return
	var gap: float = maxf(MIN_GAP_FLOOR, MIN_GAP / maxf(0.5, _mult("cadence", "")))
	var since: float = _now() - float(st.get("last_offer", 0.0))
	var pity: bool = float(st.get("play", 0.0)) >= PITY_OFFER
	if since < gap and not pity:
		return
	var w: Dictionary = _compose_wish(pity)
	if w.is_empty():
		return
	_add_wish(w)
	st["last_offer"] = _now()
	st["play"] = 0.0


# =============================================================================
# COMPOSING A WISH  (the "never impossible" law, §6.2)
# =============================================================================
# Pick a giver, prove a want reachable, and build the wish. Returns {} if the
# island has nothing honest to ask for right now (then it simply doesn't ask).
func _compose_wish(force_easy: bool) -> Dictionary:
	var givers: Array = _candidate_givers()
	if givers.is_empty():
		return {}
	# order givers by bond (fonder creatures speak up first), heart last
	givers.sort_custom(_giver_sort)
	for item in givers:
		var gv: Dictionary = item
		var gid: String = String(gv.get("id", ""))
		if _has_wish_from(gid):
			continue
		var level: String = String(gv.get("level", "shy"))
		# 1. an arc step, if this giver is trusted enough to carry the story
		if not force_easy and (level == "devoted" or level == "kindred" or gid == "heart"):
			var arc_w: Dictionary = _compose_arc_step(gid, gv)
			if not arc_w.is_empty():
				return arc_w
		# 2. a plain wish from the kinds this bond level unlocks
		if not force_easy:
			var pool: Array = _reachable_wishes(gid, gv, level)
			if not pool.is_empty():
				var chosen: Variant = _pick(pool, "pickwish:%s" % gid)
				if chosen is Dictionary:
					return chosen as Dictionary
		# 3. EASY_POOL — a tend wish is always reachable
		var easy: Dictionary = _make_tend_wish(gid, gv, 2 if level == "shy" else 3)
		if not easy.is_empty():
			return easy
	return {}


func _giver_sort(a: Dictionary, b: Dictionary) -> bool:
	return float(a.get("bond", 0.0)) > float(b.get("bond", 0.0))


func _has_wish_from(gid: String) -> bool:
	for item in _active():
		var w: Dictionary = item
		if String(w.get("giver", "")) == gid:
			return true
	return false


# Who can wish: every placed creature (bond-ranked), a visiting merchant, and —
# always — the island itself, speaking through the Heart Tree.
func _candidate_givers() -> Array:
	var out: Array = []
	var cl: Node = _sib("CreatureLife")
	if cl != null and cl.has_method("creatures"):
		var arr: Variant = cl.call("creatures")
		if arr is Array:
			for item in (arr as Array):
				var c: Dictionary = item
				var pid: String = String(c.get("place_id", ""))
				if pid == "":
					continue
				out.append({"id": pid, "bond": float(c.get("bond", 0.0)),
					"level": _bond_level(pid), "species": String(c.get("species", "")),
					"creature": true})
	if out.is_empty():
		# no CreatureLife (or no kin yet): read creatures straight off the world
		for item in _records_list():
			var r: Dictionary = item
			var entry: Dictionary = r.get("entry", {}) as Dictionary
			if String(entry.get("kind", "")) != "creature":
				continue
			var pid2: String = String(r.get("id", ""))
			if pid2 == "":
				continue
			out.append({"id": pid2, "bond": _bond(pid2), "level": _bond_level(pid2),
				"species": String(entry.get("species", "")), "creature": true})
	# a merchant passing through is a giver with one richer wish
	var se: Node = _sib("SeasonsEvents")
	if se != null and se.has_method("event_kind") and String(se.call("event_kind")) == "merchant":
		out.append({"id": "merchant", "bond": 0.6, "level": "fond",
			"species": "", "creature": true, "rich": true})
	# the land itself always has something it would like
	out.append({"id": "heart", "bond": 0.75, "level": "devoted", "species": "",
		"creature": false})
	return out


func _bond(place_id: String) -> float:
	var cl: Node = _sib("CreatureLife")
	if cl != null and cl.has_method("bond"):
		return clampf(float(cl.call("bond", place_id)), 0.0, 1.0)
	return 0.0


func _bond_level(place_id: String) -> String:
	var cl: Node = _sib("CreatureLife")
	if cl != null and cl.has_method("bond_level"):
		return String(cl.call("bond_level", place_id))
	var b: float = _bond(place_id)
	if b >= 0.90:
		return "kindred"
	if b >= 0.70:
		return "devoted"
	if b >= 0.45:
		return "fond"
	if b >= 0.20:
		return "friendly"
	return "shy"


# Which wish kinds a bond level is willing to voice (§6.1 bond gating).
func _kinds_for(level: String, rich: bool) -> Array:
	var out: Array = ["plant", "tend", "witness"]
	if level == "friendly":
		out.append("host")
	if level == "fond" or level == "devoted" or level == "kindred" or rich:
		out.append_array(["bring", "craft", "host", "befriend"])
	if level == "devoted" or level == "kindred":
		out.append_array(["ritual", "find"])
	return out


# Build every wish this giver could honestly ask for right now.
func _reachable_wishes(gid: String, gv: Dictionary, level: String) -> Array:
	var out: Array = []
	var kinds: Array = _kinds_for(level, bool(gv.get("rich", false)))
	for item in kinds:
		var k: String = String(item)
		var w: Dictionary = {}
		match k:
			"bring": w = _make_bring_wish(gid, gv)
			"craft": w = _make_craft_wish(gid, gv)
			"plant": w = _make_plant_wish(gid, gv)
			"tend": w = _make_tend_wish(gid, gv, 3)
			"befriend": w = _make_befriend_wish(gid, gv)
			"host": w = _make_host_wish(gid, gv)
			"witness": w = _make_witness_wish(gid, gv)
			"ritual": w = _make_ritual_wish(gid, gv, "")
			"find": w = _make_find_wish(gid, gv, "")
		if not w.is_empty() and not _blocked(String(w.get("tkey", ""))):
			out.append(w)
	return out


func _blocked(tkey: String) -> bool:
	if tkey == "":
		return true
	var st: Dictionary = _st()
	if st.is_empty():
		return false
	var shelved: Dictionary = st["shelved"]
	if shelved.has(tkey) and _now() - float(shelved[tkey]) < SHELF_COOLDOWN:
		return true
	for item in _active():
		var w: Dictionary = item
		if String(w.get("tkey", "")) == tkey:
			return true
	return false


# --- per-kind builders -------------------------------------------------------
func _make_bring_wish(gid: String, gv: Dictionary) -> Dictionary:
	# only ask for a material the player can already see the source of
	var pool: Array = []
	for mid in MATS.keys():
		var m: String = String(mid)
		if _stock(m) > 0 or _produced(m) > 0:
			pool.append(m)
	if pool.is_empty():
		return {}
	var mat: Variant = _pick(pool, "bringmat:%s" % gid)
	if not (mat is String):
		return {}
	var mid2: String = mat as String
	var n: int = 2 if bool(gv.get("rich", false)) else (1 + int(_rand("bringn:%s" % gid) * 2.0))
	return _wish(gid, "bring", {"mat": mid2, "n": n},
		"bring:%s:%d" % [mid2, n], String(MATS[mid2]["glyph"]))


func _make_craft_wish(gid: String, _gv: Dictionary) -> Dictionary:
	var ch: Node = _sib("Chains")
	if ch == null or not ch.has_method("knows"):
		return {}
	var pool: Array = []
	for rid in GOODS.keys():
		if bool(ch.call("knows", String(rid))):
			pool.append(String(rid))
	if pool.is_empty():
		return {}
	var r: Variant = _pick(pool, "craft:%s" % gid)
	if not (r is String):
		return {}
	var rid2: String = r as String
	return _wish(gid, "craft", {"recipe": rid2},
		"craft:%s" % rid2, String(GOODS[rid2]["glyph"]))


func _make_plant_wish(gid: String, _gv: Dictionary) -> Dictionary:
	# only ask for something the player holds (or has met): a dream, not a riddle
	var pool: Array = _plantable_pool()
	if pool.is_empty():
		return {}
	var c: Variant = _pick(pool, "plant:%s" % gid)
	if not (c is Dictionary):
		return {}
	var cand: Dictionary = c as Dictionary
	var n: int = 1 + int(_rand("plantn:%s" % gid) * 2.0)
	var want: Dictionary = {"kind": String(cand.get("kind", "plant")),
		"species": String(cand.get("species", "")), "n": n, "radius": 420.0,
		"label": String(cand.get("label", ""))}
	var glyph: String = "sprout"
	match String(cand.get("kind", "")):
		"tree": glyph = "tree"
		"decor": glyph = "lantern" if String(cand.get("species", "")) == "lantern" else "stone"
		"crystal": glyph = "shard"
		"fungus": glyph = "mushroom"
		"water": glyph = "droplet"
	return _wish(gid, "plant", want,
		"plant:%s:%s:%d" % [String(cand.get("kind", "")), String(cand.get("species", "")), n], glyph)


# Species the player can actually plant: what is in the basket, filtered to
# concrete species (a "wild" seed could become anything, so we never ask for it).
func _plantable_pool() -> Array:
	var out: Array = []
	var inv: Dictionary = _inventory()
	for key in inv.keys():
		var e: Variant = inv[key]
		if not (e is Dictionary):
			continue
		var entry: Dictionary = e as Dictionary
		if int(entry.get("count", 0)) <= 0:
			continue
		var kind: String = String(entry.get("kind", ""))
		if kind == "" or kind == "building" or kind == "creature" or kind == "material":
			continue
		var sp: String = String(entry.get("species", ""))
		if sp == "" or sp == "random":
			continue
		out.append({"kind": kind, "species": sp,
			"label": String(entry.get("label", sp.capitalize()))})
	# anything we have already discovered widens the dream pool as the game grows
	var dc: Node = _sib("Discovery")
	if dc != null and dc.has_method("is_found"):
		for sp2 in ItemCatalog.WILD_TREES:
			if bool(dc.call("is_found", "species:%s" % String(sp2))):
				out.append({"kind": "tree", "species": String(sp2),
					"label": String(sp2).capitalize()})
		for sp3 in ItemCatalog.WILD_PLANTS:
			if bool(dc.call("is_found", "species:%s" % String(sp3))):
				out.append({"kind": "plant", "species": String(sp3),
					"label": String(sp3).capitalize()})
	return out


func _make_tend_wish(gid: String, _gv: Dictionary, n: int) -> Dictionary:
	# With Nurture mounted we can ask for a specific kind of care. Without it the
	# only care the world reports is the base game's own nurture verb, so the wish
	# asks for care of *any* kind — the EASY_POOL must never be unreachable.
	var verb: String = "any"
	var nu: Node = _sib("Nurture")
	if nu != null:
		verb = "water"
		var choices: Array = ["water", "water", "prune", "feed"]
		var se: Node = _sib("SeasonsEvents")
		if se != null and se.has_method("season_id") and String(se.call("season_id")) == "stillfrost":
			choices.append("warm")
		var v: Variant = _pick(choices, "tendverb:%s" % gid)
		if v is String:
			verb = v as String
		# Nurture knows which thing is visibly asking for care right now — aim the
		# wish at that one, and at the verb it is asking for, so the whisper and
		# the glowing thing agree (DYNAMICS §5.1, Nurture → Wishes).
		if nu.has_method("offer_hint"):
			var hv: Variant = nu.call("offer_hint")
			if hv is Dictionary:
				var hint: Dictionary = hv as Dictionary
				if String(hint.get("place_id", "")) != "":
					_hint_place = String(hint.get("place_id", ""))
					var hverb: String = String(hint.get("verb", ""))
					if CARE_VERBS.has(hverb):
						verb = hverb
	var want: Dictionary = {"verb": verb, "n": maxi(1, n)}
	if _hint_place != "" and _node_of(_hint_place) != null:
		want["focus"] = _hint_place
	var glyph: String = "droplet"
	match verb:
		"prune": glyph = "shears"
		"feed": glyph = "bowl"
		"warm": glyph = "ember"
	return _wish(gid, "tend", want, "tend:%s:%d" % [verb, maxi(1, n)], glyph)


func _make_befriend_wish(gid: String, _gv: Dictionary) -> Dictionary:
	var cl: Node = _sib("CreatureLife")
	if cl == null or not cl.has_method("creatures"):
		return {}
	var arr: Variant = cl.call("creatures")
	if not (arr is Array) or (arr as Array).size() < 2:
		return {}
	return _wish(gid, "befriend", {"bond": 0.45, "n": 1}, "befriend:0.45", "twohearts")


func _make_host_wish(gid: String, _gv: Dictionary) -> Dictionary:
	# only ask for a building the player is holding a plan for
	var inv: Dictionary = _inventory()
	var pool: Array = []
	for key in inv.keys():
		var e: Variant = inv[key]
		if not (e is Dictionary):
			continue
		var entry: Dictionary = e as Dictionary
		if String(entry.get("kind", "")) != "building" or int(entry.get("count", 0)) <= 0:
			continue
		var bid: String = String(entry.get("building_id", ""))
		if bid == "":
			continue
		pool.append({"building_id": bid, "label": String(entry.get("label", "a home"))})
	if pool.is_empty():
		return {}
	var p: Variant = _pick(pool, "host:%s" % gid)
	if not (p is Dictionary):
		return {}
	var cand: Dictionary = p as Dictionary
	return _wish(gid, "host",
		{"building_id": String(cand.get("building_id", "")), "radius": 420.0,
		 "label": String(cand.get("label", ""))},
		"host:%s" % String(cand.get("building_id", "")), "house")


func _make_witness_wish(gid: String, _gv: Dictionary) -> Dictionary:
	var se: Node = _sib("SeasonsEvents")
	if se == null:
		return {}
	# seasons turn whether or not anyone watches, so a season wish is always kind
	var pool: Array = ["season", "meteor", "festival", "bloomtide", "aurora", "migration"]
	var p: Variant = _pick(pool, "witness:%s" % gid)
	if not (p is String):
		return {}
	var what: String = p as String
	if what == "season":
		var cur: int = 0
		if se.has_method("season"):
			cur = int(se.call("season"))
		var nxt: int = (cur + 1) % 4
		return _wish(gid, "witness", {"season": nxt, "label": _season_word(nxt)},
			"witness:season:%d" % nxt, "leaf")
	var glyph: String = "star"
	match what:
		"festival": glyph = "lantern"
		"bloomtide": glyph = "rain"
		"migration": glyph = "bird"
		"aurora": glyph = "moon"
	return _wish(gid, "witness", {"event": what, "label": _event_word(what)},
		"witness:%s" % what, glyph)


func _make_ritual_wish(gid: String, _gv: Dictionary, forced_rite: String) -> Dictionary:
	var r: Node = _sib("Rituals")
	if r == null:
		return {}
	if r.has_method("circle_planted") and not bool(r.call("circle_planted")):
		return {}
	if not r.has_method("cost_for"):
		return {}
	var rite: String = forced_rite
	if rite == "":
		var pool: Array = ["rain", "warmth", "light", "roots", "kinship", "finding"]
		var p: Variant = _pick(pool, "rite:%s" % gid)
		if p is String:
			rite = p as String
	if rite == "":
		return {}
	var cost: Variant = r.call("cost_for", rite)
	if not (cost is Dictionary) or (cost as Dictionary).is_empty():
		return {}
	return _wish(gid, "ritual", {"rite": rite, "label": _rite_word(rite)},
		"ritual:%s" % rite, "stones")


func _make_find_wish(gid: String, _gv: Dictionary, what: String) -> Dictionary:
	var dc: Node = _sib("Discovery")
	if dc == null:
		return {}
	var w: String = what
	if w == "":
		var p: Variant = _pick(["hybrid", "radiant"], "find:%s" % gid)
		if p is String:
			w = p as String
	if w == "":
		return {}
	return _wish(gid, "find", {"what": w, "n": 1, "label": _find_word(w)},
		"find:%s" % w, "spiral")


# --- arc steps ---------------------------------------------------------------
# Step order is a pure function of the world seed, so two islands tell the six
# stories in a different order — but the closing step always closes the arc.
func _arc_order(arc_id: String) -> Array:
	var steps: Array = (ARCS[arc_id] as Dictionary)["steps"] as Array
	var n: int = steps.size()
	if n <= 2:
		return range(n)
	var head: Array = []
	for i in range(n - 1):
		head.append({"i": i, "r": _fixed("arc:%s:%d" % [arc_id, i])})
	head.sort_custom(_by_r)
	var out: Array = []
	for item in head:
		var d: Dictionary = item
		out.append(int(d["i"]))
	out.append(n - 1)
	return out


func _by_r(a: Dictionary, b: Dictionary) -> bool:
	return float(a.get("r", 0.0)) < float(b.get("r", 0.0))


func _compose_arc_step(gid: String, gv: Dictionary) -> Dictionary:
	for item in ARC_IDS:
		var arc_id: String = String(item)
		var a: Dictionary = _arc_state(arc_id)
		if bool(a.get("done", false)):
			continue
		var order: Array = _arc_order(arc_id)
		var si: int = int(a.get("step", 0))
		if si >= order.size():
			continue
		var steps: Array = (ARCS[arc_id] as Dictionary)["steps"] as Array
		var tpl: Dictionary = steps[int(order[si])] as Dictionary
		var w: Dictionary = _resolve_arc_step(gid, gv, arc_id, si, tpl)
		if w.is_empty():
			continue
		if _blocked(String(w.get("tkey", ""))):
			continue
		return w
	return {}


# Turn an arc step template into a concrete, reachable wish (or {} to wait).
func _resolve_arc_step(gid: String, gv: Dictionary, arc_id: String, si: int, tpl: Dictionary) -> Dictionary:
	var kind: String = String(tpl.get("kind", ""))
	var twant: Dictionary = (tpl.get("want", {}) as Dictionary).duplicate(true)
	var w: Dictionary = {}
	match kind:
		"bring":
			var mat: String = String(twant.get("mat", ""))
			if _stock(mat) <= 0 and _produced(mat) <= 0:
				return {}
			w = _wish(gid, "bring", {"mat": mat, "n": int(twant.get("n", 1))},
				"arc:%s:%d" % [arc_id, si], String((MATS.get(mat, {}) as Dictionary).get("glyph", "bundle")))
		"craft":
			var ch: Node = _sib("Chains")
			var rid: String = String(twant.get("recipe", ""))
			if ch == null or not ch.has_method("knows") or not bool(ch.call("knows", rid)):
				return {}
			w = _wish(gid, "craft", {"recipe": rid},
				"arc:%s:%d" % [arc_id, si], String((GOODS.get(rid, {}) as Dictionary).get("glyph", "loaf")))
		"plant":
			if int(twant.get("distinct", 0)) > 0:
				w = _wish(gid, "plant", {"distinct": int(twant.get("distinct", 6))},
					"arc:%s:%d" % [arc_id, si], "sprout")
			else:
				var sp: String = String(twant.get("species", ""))
				if not _can_reach_species(String(twant.get("kind", "")), sp):
					return {}
				twant["radius"] = float(twant.get("radius", 460.0))
				twant["label"] = sp.capitalize()
				w = _wish(gid, "plant", twant, "arc:%s:%d" % [arc_id, si],
					"lantern" if sp == "lantern" else "sprout")
		"tend":
			w = _wish(gid, "tend", twant, "arc:%s:%d" % [arc_id, si],
				"droplet" if String(twant.get("verb", "water")) != "prune" else "shears")
		"befriend":
			var cl: Node = _sib("CreatureLife")
			if cl == null or not cl.has_method("creatures"):
				return {}
			var arr: Variant = cl.call("creatures")
			if not (arr is Array) or (arr as Array).size() < 2:
				return {}
			w = _wish(gid, "befriend", twant, "arc:%s:%d" % [arc_id, si], "twohearts")
		"host":
			var bid: String = String(twant.get("building_id", "any"))
			if bid == "any":
				var hw: Dictionary = _make_host_wish(gid, gv)
				if hw.is_empty():
					return {}
				hw["tkey"] = "arc:%s:%d" % [arc_id, si]
				w = hw
			else:
				w = _wish(gid, "host", twant, "arc:%s:%d" % [arc_id, si], "house")
		"witness":
			if _sib("SeasonsEvents") == null:
				return {}
			twant["label"] = _event_word(String(twant.get("event", "")))
			w = _wish(gid, "witness", twant, "arc:%s:%d" % [arc_id, si], "star")
		"ritual":
			var rw: Dictionary = _make_ritual_wish(gid, gv, String(twant.get("rite", "")))
			if rw.is_empty():
				return {}
			rw["tkey"] = "arc:%s:%d" % [arc_id, si]
			w = rw
		"puzzle":
			if _puzzles == null:
				return {}
			w = _wish(gid, "puzzle", twant, "arc:%s:%d" % [arc_id, si], "root")
		"find":
			var fw: Dictionary = _make_find_wish(gid, gv, String(twant.get("what", "")))
			if fw.is_empty():
				return {}
			fw["tkey"] = "arc:%s:%d" % [arc_id, si]
			w = fw
		"vigil":
			if _sib("Rituals") == null:
				return {}
			w = _wish(gid, "vigil", twant, "arc:%s:%d" % [arc_id, si], "moon")
	if w.is_empty():
		return {}
	w["arc"] = arc_id
	w["arc_step"] = si
	return w


func _can_reach_species(kind: String, species: String) -> bool:
	if species == "":
		return false
	for item in _plantable_pool():
		var c: Dictionary = item
		if String(c.get("species", "")) == species:
			return true
	# decor/lanterns may also come from the Lantern Road's own gift set
	return kind == "decor" and species == "lantern" and _stock_item("decor:lantern") > 0


# --- wish construction -------------------------------------------------------
func _wish(gid: String, kind: String, want: Dictionary, tkey: String, glyph: String) -> Dictionary:
	var st: Dictionary = _st()
	var n: int = int(st.get("seq", 0)) if not st.is_empty() else 0
	return {
		"id": "wsh_%d_%s" % [n, kind],
		"kind": kind,
		"giver": gid,
		"want": want.duplicate(true),
		"tkey": tkey,
		"glyph": glyph,
		"prog": 0.0,
		"count": 0,
		"created": _now(),
		"arc": "",
		"arc_step": -1,
		"seen": {},
	}


func _add_wish(w: Dictionary) -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	(st["active"] as Array).append(w)
	var gv: Dictionary = st["givers"]
	gv[String(w.get("giver", ""))] = int(gv.get(String(w.get("giver", "")), 0))
	_spawn_bubble(w)
	_refresh_progress(w)
	_say(_wish_line(w))
	emit_signal("dyn_event", "wish_offered", {"id": String(w.get("id", "")),
		"kind": String(w.get("kind", "")), "giver": String(w.get("giver", "")),
		"prog": 0.0})
	if Game:
		Game.emit_signal("state_dirty")


# =============================================================================
# PROGRESS
# =============================================================================
func _refresh_all_progress() -> void:
	for item in _active():
		var w: Dictionary = item
		_refresh_progress(w)


func _refresh_progress(w: Dictionary) -> void:
	var want: Dictionary = w.get("want", {}) as Dictionary
	var kind: String = String(w.get("kind", ""))
	var prog: float = float(w.get("prog", 0.0))
	match kind:
		"bring":
			var n: int = maxi(1, int(want.get("n", 1)))
			prog = clampf(float(_stock(String(want.get("mat", "")))) / float(n), 0.0, 1.0)
		"craft":
			prog = clampf(float(_stock(String(want.get("recipe", "")))), 0.0, 1.0)
		"plant":
			if int(want.get("distinct", 0)) > 0:
				prog = clampf(float(_distinct_species()) / float(maxi(1, int(want.get("distinct", 6)))), 0.0, 1.0)
			else:
				var have: int = _count_planted(w)
				prog = clampf(float(have) / float(maxi(1, int(want.get("n", 1)))), 0.0, 1.0)
		"host":
			prog = 1.0 if _has_building_near(w) else 0.0
		"tend", "befriend", "witness", "ritual", "puzzle", "find", "vigil":
			prog = clampf(float(int(w.get("count", 0))) / float(maxi(1, int(want.get("n", 1)))), 0.0, 1.0)
			if kind == "befriend":
				prog = maxf(prog, _befriend_prog(want))
	w["prog"] = prog
	var bn: _WishBubble = _bubble_of(String(w.get("id", "")))
	if bn != null:
		bn.prog = prog
		var sat: bool = _satisfiable(w)
		if bn.ready_state != sat:
			bn.ready_state = sat
			_set_ready_glow(String(w.get("id", "")), sat)


# The live bubble node for a wish id, or null (never cache these across frames).
func _bubble_of(wid: String) -> _WishBubble:
	var live: Dictionary = _live.get(wid, {}) as Dictionary
	if live.is_empty():
		return null
	var b: Variant = live.get("bubble")
	if b is _WishBubble and is_instance_valid(b as _WishBubble):
		return b as _WishBubble
	return null


func _befriend_prog(want: Dictionary) -> float:
	var cl: Node = _sib("CreatureLife")
	if cl == null or not cl.has_method("creatures"):
		return 0.0
	var arr: Variant = cl.call("creatures")
	if not (arr is Array):
		return 0.0
	var need: float = float(want.get("bond", 0.45))
	var n: int = maxi(1, int(want.get("n", 1)))
	var hits: int = 0
	for item in (arr as Array):
		var c: Dictionary = item
		if float(c.get("bond", 0.0)) >= need:
			hits += 1
	return clampf(float(hits) / float(n), 0.0, 1.0)


func _count_planted(w: Dictionary) -> int:
	var want: Dictionary = w.get("want", {}) as Dictionary
	var kind: String = String(want.get("kind", ""))
	var species: String = String(want.get("species", ""))
	var radius: float = float(want.get("radius", 420.0))
	var origin: Vector2 = _giver_anchor(String(w.get("giver", "")))
	var hits: int = 0
	for item in _records_list():
		var r: Dictionary = item
		var entry: Dictionary = r.get("entry", {}) as Dictionary
		if kind != "" and String(entry.get("kind", "")) != kind:
			continue
		if species != "" and String(entry.get("species", "")) != species:
			continue
		var nd: Variant = r.get("node")
		if radius > 0.0 and nd is Node2D and is_instance_valid(nd as Node2D):
			if (nd as Node2D).position.distance_to(origin) > radius:
				continue
		hits += 1
	return hits


func _distinct_species() -> int:
	var seen: Dictionary = {}
	for item in _records_list():
		var r: Dictionary = item
		var entry: Dictionary = r.get("entry", {}) as Dictionary
		var sp: String = String(entry.get("species", ""))
		if sp != "" and sp != "random":
			seen[sp] = true
	return seen.size()


func _has_building_near(w: Dictionary) -> bool:
	var want: Dictionary = w.get("want", {}) as Dictionary
	var bid: String = String(want.get("building_id", ""))
	var radius: float = float(want.get("radius", 420.0))
	var origin: Vector2 = _giver_anchor(String(w.get("giver", "")))
	for item in _records_list():
		var r: Dictionary = item
		var entry: Dictionary = r.get("entry", {}) as Dictionary
		if String(entry.get("kind", "")) != "building":
			continue
		if bid != "" and bid != "any" and String(entry.get("building_id", "")) != bid:
			continue
		var nd: Variant = r.get("node")
		if nd is Node2D and is_instance_valid(nd as Node2D):
			if (nd as Node2D).position.distance_to(origin) <= radius:
				return true
	return false


# A wish the player can satisfy with one gesture right now (bring / craft).
func _satisfiable(w: Dictionary) -> bool:
	var kind: String = String(w.get("kind", ""))
	var want: Dictionary = w.get("want", {}) as Dictionary
	if kind == "bring":
		return _stock(String(want.get("mat", ""))) >= maxi(1, int(want.get("n", 1)))
	if kind == "craft":
		return _stock(String(want.get("recipe", ""))) >= 1
	return float(w.get("prog", 0.0)) >= 1.0


# Wishes the world itself completes (you planted it, you tended it, you were
# there) resolve on their own — a wish is never homework waiting for a button.
func _settle_complete() -> void:
	var done: Array = []
	for item in _active():
		var w: Dictionary = item
		var kind: String = String(w.get("kind", ""))
		if kind == "bring" or kind == "craft":
			continue
		if float(w.get("prog", 0.0)) >= 1.0:
			done.append(w)
	for item2 in done:
		_fulfil(item2 as Dictionary, false)


# =============================================================================
# FULFILMENT, REWARDS, CELEBRATION
# =============================================================================
# `handed` = the player physically gave something (bring/craft), so inputs are
# consumed. Observed wishes (plant/tend/witness…) consume nothing.
func _fulfil(w: Dictionary, handed: bool) -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	var wid: String = String(w.get("id", ""))
	var kind: String = String(w.get("kind", ""))
	var want: Dictionary = w.get("want", {}) as Dictionary
	if handed:
		if kind == "bring":
			if not _take(String(want.get("mat", "")), maxi(1, int(want.get("n", 1)))):
				_say("It is not quite gathered yet.")
				return
		elif kind == "craft":
			if not _take(String(want.get("recipe", "")), 1):
				_say("The hearth has not finished it yet.")
				return
	# remove from active
	var arr: Array = st["active"] as Array
	for i in range(arr.size()):
		var a: Dictionary = arr[i]
		if String(a.get("id", "")) == wid:
			arr.remove_at(i)
			break
	(st["done"] as Dictionary)[String(w.get("tkey", ""))] = _now()
	st["granted"] = int(st.get("granted", 0)) + 1
	var gid: String = String(w.get("giver", ""))
	var gcount: Dictionary = st["givers"]
	gcount[gid] = int(gcount.get(gid, 0)) + 1

	var anchor: Vector2 = _giver_anchor(gid)
	_celebrate(anchor, gid)
	_despawn_bubble(wid, true)

	# the reward (always real, never just a number going up)
	var reward: Dictionary = _grant_reward(w, anchor)

	emit_signal("dyn_event", "wish_done", {"id": wid, "kind": kind, "giver": gid,
		"prog": 1.0, "bond_gift": 0.20, "reward": reward})
	_say(_done_line(gid))

	# three wishes from one creature → it gifts you its own rare variant seed
	if gid != "heart" and gid != "merchant" and int(gcount.get(gid, 0)) % 3 == 0:
		_gift_variant_seed(gid, anchor)

	# arcs advance only through the wishes that belong to them
	if String(w.get("arc", "")) != "":
		_advance_arc(String(w.get("arc", "")))
	if Game:
		Game.save_now()


func _advance_arc(arc_id: String) -> void:
	if not ARCS.has(arc_id):
		return
	var a: Dictionary = _arc_state(arc_id)
	if bool(a.get("done", false)):
		return                      # an arc is only ever completed once
	var steps: Array = (ARCS[arc_id] as Dictionary)["steps"] as Array
	a["step"] = mini(int(a.get("step", 0)) + 1, steps.size())
	emit_signal("dyn_event", "arc_step", {"arc": arc_id, "step": int(a["step"]),
		"of": steps.size()})
	if int(a["step"]) < steps.size():
		return
	a["done"] = true
	var def: Dictionary = ARCS[arc_id] as Dictionary
	var key: String = String(def.get("blessing", "yield"))
	_register_permanent(key, ARC_BLESSING)
	_arc_gift(String(def.get("gift", "")), arc_id)
	var dc: Node = _sib("Discovery")
	if dc != null and dc.has_method("discover"):
		dc.call("discover", "arc:%s" % arc_id, {"category": "arcs",
			"label": String(def.get("label", arc_id)), "tier": "blossom"})
	emit_signal("dyn_event", "arc_done", {"arc": arc_id, "blessing": key})
	_say("%s is complete. The island will keep it." % String(def.get("label", arc_id)).capitalize())


func _register_permanent(key: String, amount: float) -> void:
	var r: Node = _sib("Rituals")
	if r != null and r.has_method("register_permanent"):
		r.call("register_permanent", key, amount)
		return
	var st: Dictionary = _st()
	if st.is_empty():
		return
	var p: Dictionary = st["permanent"]
	var total := 0.0
	for k in p.keys():
		total += float(p[k])
	var room: float = maxf(0.0, PERM_MAX - total)
	p[key] = clampf(float(p.get(key, 0.0)) + minf(amount, room), 0.0, PERM_MAX)


# Each arc leaves something behind that you can see and touch.
func _arc_gift(gift: String, arc_id: String) -> void:
	match gift:
		"lanterns":
			_grant("decor:lantern", {"kind": "decor", "species": "lantern",
				"label": "Road Lantern", "growth": -1.0, "minted": false}, 3)
		"everbloom":
			# the keepsake slot is Rituals' to hold; tell it, and leave a rootbalm
			var r: Node = _sib("Rituals")
			if r != null and r.has_method("notify"):
				r.call("notify", "arc_gift", {"arc": arc_id, "gift": "everbloom_slot"})
			_grant("mat:rootbalm", _mat_entry("rootbalm", "Rootbalm"), 1)
		"rainkeeping":
			var nu: Node = _sib("Nurture")
			if nu != null and nu.has_method("notify"):
				nu.call("notify", "arc_gift", {"arc": arc_id, "gift": "auto_water_daily"})
			_grant("mat:dewdrop", _mat_entry("dewdrop", "Dewdrop"), 3)
		"second_trunk":
			var dc: Node = _sib("Discovery")
			if dc != null and dc.has_method("notify"):
				dc.call("notify", "arc_gift", {"arc": arc_id, "gift": "second_trunk"})
			_grant_rare_seed("arcgift:%s" % arc_id)
		"festival_lanterns":
			var se: Node = _sib("SeasonsEvents")
			if se != null and se.has_method("notify"):
				se.call("notify", "arc_gift", {"arc": arc_id, "gift": "permanent_lanterns"})
			_grant("mat:honeycomb", _mat_entry("honeycomb", "Honeycomb"), 2)
		"ascension":
			var r2: Node = _sib("Rituals")
			if r2 != null and r2.has_method("notify"):
				r2.call("notify", "arc_gift", {"arc": arc_id, "gift": "ascension_unlocked"})


# --- rewards -----------------------------------------------------------------
func _grant_reward(w: Dictionary, anchor: Vector2) -> Dictionary:
	var kind: String = String(w.get("kind", ""))
	var gid: String = String(w.get("giver", ""))
	var arc: bool = String(w.get("arc", "")) != ""
	var roll: float = _rand("reward:%s" % String(w.get("id", "")))
	var out: Dictionary = {}
	# a surge of essence, visible as a rush of motes into the root-pool
	var surge: float = _essence_surge(arc)
	if surge > 0.0 and Game != null:
		Game.add_resource("essence", surge)
		out["essence"] = surge
		_mote_rush(anchor, surge)
	# the second half of the reward depends on what was wished for
	if kind == "bring" or kind == "craft":
		if roll < 0.55:
			out["seed"] = _grant_rare_seed("rw:%s" % String(w.get("id", "")))
		else:
			out["material"] = _grant_random_material("rw:%s" % String(w.get("id", "")))
	elif kind == "plant" or kind == "find":
		out["seed"] = _grant_rare_seed("rw:%s" % String(w.get("id", "")))
	elif kind == "tend":
		out["material"] = _grant_random_material("rw:%s" % String(w.get("id", "")))
	elif kind == "befriend" or kind == "host":
		if _arrive_creature(gid):
			out["creature"] = true
		else:
			out["egg"] = _grant_egg("rw:%s" % String(w.get("id", "")))
	elif kind == "witness" or kind == "vigil":
		_grant("mat:skyshard", _mat_entry("skyshard", "Skyshard"), 1)
		out["material"] = "skyshard"
	elif kind == "ritual" or kind == "puzzle":
		out["seed"] = _grant_rare_seed("rw:%s" % String(w.get("id", "")))
		out["material"] = _grant_random_material("rw2:%s" % String(w.get("id", "")))
	if arc:
		out["arc_step"] = String(w.get("arc", ""))
	return out


func _essence_surge(arc: bool) -> float:
	var rate := 1.0
	if _sim != null and _sim.has_method("rates"):
		var rs: Variant = _sim.call("rates")
		if rs is Dictionary:
			rate = maxf(0.4, float((rs as Dictionary).get("essence", 1.0)))
	var mins: float = 5.0 if not arc else 9.0
	return clampf(mins * 60.0 * rate, 30.0, 4000.0)


func _grant_rare_seed(tag: String) -> String:
	var pools: Array = [
		{"kind": "tree", "pool": ItemCatalog.WILD_TREES},
		{"kind": "plant", "pool": ItemCatalog.WILD_PLANTS},
		{"kind": "fungus", "pool": ItemCatalog.WILD_FUNGI},
		{"kind": "crystal", "pool": ItemCatalog.WILD_CRYSTALS},
	]
	var pv: Variant = _pick(pools, "seedpool:%s" % tag)
	if not (pv is Dictionary):
		return ""
	var p: Dictionary = pv as Dictionary
	var pool: Array = p.get("pool", []) as Array
	var sv: Variant = _pick(pool, "seedsp:%s" % tag)
	if not (sv is String):
		return ""
	var sp: String = sv as String
	var kind: String = String(p.get("kind", "plant"))
	var key: String = "seed:%s" % sp
	if kind == "fungus":
		key = "spore:%s" % sp
	elif kind == "crystal":
		key = "shard:%s" % sp
	_grant(key, {"kind": kind, "species": sp, "label": "%s Seed" % sp.capitalize(),
		"growth": -1.0, "minted": false}, 1)
	return sp


func _grant_random_material(tag: String) -> String:
	var keys: Array = MATS.keys()
	var v: Variant = _pick(keys, "mat:%s" % tag)
	if not (v is String):
		return ""
	var mid: String = v as String
	var label: String = String(MATS[mid]["label"]).capitalize()
	_grant("mat:%s" % mid, _mat_entry(mid, label), 1 + int(_rand("matn:%s" % tag) * 2.0))
	return mid


func _grant_egg(tag: String) -> String:
	var pool: Array = []
	for b in GameData.blocklings:
		var d: Dictionary = b
		pool.append(String(d.get("id", "")))
	if pool.is_empty():
		pool = ["pip"]
	var v: Variant = _pick(pool, "egg:%s" % tag)
	var sp: String = String(v) if v != null else "pip"
	_grant("egg:%s" % sp, {"kind": "creature", "species": sp,
		"label": "%s (egg)" % sp.capitalize(), "growth": -1.0, "minted": false}, 1)
	return sp


# The loveliest reward: a creature actually WALKS IN and stays. Uses only the
# world's existing public placement API, so it works with no hooks wired.
func _arrive_creature(gid: String) -> bool:
	if _space == null or not _space.has_method("place") or not _space.has_method("snap_ground"):
		return false
	if not _space.has_method("can_place"):
		return false
	var cl: Node = _sib("CreatureLife")
	if cl != null and cl.has_method("home_capacity") and int(cl.call("home_capacity")) <= 0:
		return false
	var pool: Array = []
	for b in GameData.blocklings:
		var d: Dictionary = b
		pool.append(String(d.get("id", "")))
	if pool.is_empty():
		pool = ["pip"]
	var sv: Variant = _pick(pool, "arrive:%s" % gid)
	var sp: String = String(sv) if sv != null else "pip"
	var entry: Dictionary = {"kind": "creature", "species": sp,
		"label": sp.capitalize(), "growth": 0.55, "minted": false}
	var origin: Vector2 = _giver_anchor(gid)
	var ghost: ProcNode = ItemCatalog.make_node(world_seed, "wish_arrive", entry, {}, 0.55)
	ghost.grow_rate = 0.0
	var placed := false
	for i in range(10):
		var side: float = 1.0 if _rand("arriveside:%s:%d" % [gid, i]) < 0.5 else -1.0
		var dist: float = 140.0 + 90.0 * float(i)
		var probe: Vector2 = Vector2(origin.x + side * dist, origin.y - 40.0)
		var snapv: Variant = _space.call("snap_ground", probe)
		if not (snapv is Vector2):
			break
		var snap: Vector2 = snapv
		var resv: Variant = _space.call("can_place", entry, ghost, snap)
		if not (resv is Dictionary):
			break
		var res: Dictionary = resv
		if bool(res.get("ok", false)):
			var st: Dictionary = _st()
			var pid: String = "wsh_kin_%d" % int(st.get("seq", 0))
			var at: Vector2 = snap
			if res.get("snap") is Vector2:
				at = res["snap"]
			_space.call("place", entry, pid, at, 0.18, false)
			_walk_in_glow(at)
			placed = true
			break
	ghost.queue_free()
	if placed:
		_say("Someone small is walking in from the edge of the world.")
	return placed


# After three wishes, a creature presses its own rare variant seed into your hand.
func _gift_variant_seed(gid: String, anchor: Vector2) -> void:
	var sp: String = ""
	var r: Dictionary = _record(gid)
	var entry: Dictionary = r.get("entry", {}) as Dictionary
	sp = String(entry.get("species", ""))
	if sp == "":
		sp = "pip"
	var key: String = "seed:kin_%s" % sp
	_grant(key, {"kind": "creature", "species": sp,
		"label": "%s's Own Seed" % sp.capitalize(), "growth": -1.0, "minted": false}, 1)
	_joy(anchor, 1.25)
	emit_signal("dyn_event", "wish_gift", {"giver": gid, "species": sp, "item_key": key})
	_say("A seed, pressed into your hand — its own kind, kept for you.")


# --- inventory / materials ---------------------------------------------------
func _mat_entry(mid: String, label: String) -> Dictionary:
	return {"kind": "material", "species": mid, "label": label,
		"growth": -1.0, "minted": false}


# The one shared grant pattern (DYNAMICS §7.3) — counts must never diverge.
func _grant(item_key: String, entry: Dictionary, n: int = 1) -> void:
	if Game == null or not (Game.state is Dictionary):
		return
	if not (Game.state.get("inventory") is Dictionary):
		Game.state["inventory"] = {}
	var inv: Dictionary = Game.state["inventory"]
	if not (inv.get(item_key) is Dictionary):
		var e: Dictionary = entry.duplicate(true)
		e["count"] = 0
		inv[item_key] = e
	var cur: Dictionary = inv[item_key]
	cur["count"] = int(cur.get("count", 0)) + maxi(1, n)
	var tray: Node = _tray()
	if tray != null and tray.has_method("refresh"):
		tray.call("refresh")
	Game.emit_signal("state_dirty")


func _tray() -> Node:
	if _interact != null and _interact.has_method("tray"):
		var t: Variant = _interact.call("tray")
		if t is Node:
			return t as Node
	return null


# Stock of a material/good: Chains first (inventory + piles), else the basket.
func _stock(mat: String) -> int:
	if mat == "":
		return 0
	var ch: Node = _sib("Chains")
	if ch != null and ch.has_method("stock"):
		return int(ch.call("stock", mat))
	return _stock_item("mat:%s" % mat)


func _stock_item(item_key: String) -> int:
	var inv: Dictionary = _inventory()
	var e: Variant = inv.get(item_key)
	if e is Dictionary:
		return int((e as Dictionary).get("count", 0))
	return 0


func _produced(mat: String) -> int:
	if Game == null or not (Game.state is Dictionary):
		return 0
	var ch: Dictionary = Game.state.get("chains", {}) as Dictionary
	var prod: Dictionary = ch.get("produced", {}) as Dictionary
	return int(prod.get(mat, 0))


func _take(mat: String, n: int) -> bool:
	if mat == "" or n <= 0:
		return false
	var ch: Node = _sib("Chains")
	if ch != null and ch.has_method("take"):
		return bool(ch.call("take", mat, n))
	var inv: Dictionary = _inventory()
	var key: String = "mat:%s" % mat
	var e: Variant = inv.get(key)
	if not (e is Dictionary):
		return false
	var entry: Dictionary = e as Dictionary
	var have: int = int(entry.get("count", 0))
	if have < n:
		return false
	entry["count"] = have - n
	if int(entry["count"]) <= 0:
		inv.erase(key)
	var tray: Node = _tray()
	if tray != null and tray.has_method("refresh"):
		tray.call("refresh")
	return true


# =============================================================================
# GESTURES  (DYNAMICS §4.2 — Wishes sits fifth in consumption priority)
# =============================================================================
# Tap the giver → listen, and hand over when the want is in reach.
func extra_actions(record: Dictionary) -> Array:
	var pid: String = String(record.get("id", ""))
	if pid == "":
		return []
	var w: Dictionary = _wish_of(pid)
	if w.is_empty():
		return []
	var out: Array = ["hear"]
	if _satisfiable(w) and (String(w.get("kind", "")) == "bring" or String(w.get("kind", "")) == "craft"):
		out.append("grant")
	return out


func handle_action(action: String, record: Dictionary) -> bool:
	var pid: String = String(record.get("id", ""))
	var w: Dictionary = _wish_of(pid)
	if w.is_empty():
		return false
	match action:
		"hear":
			_say(_wish_line(w))
			_trail_to_answer(w)
			return true
		"grant":
			if not _satisfiable(w):
				_say("Not quite yet — but soon.")
				return true
			_fulfil(w, true)
			return true
	return false


# Drag the very thing onto the wisher and it is given. The most tactile way to
# grant a wish, and it beats dropping it on the soil.
func handle_drop(entry: Dictionary, _inst_key: String, world_pos: Vector2) -> bool:
	if entry.is_empty():
		return false
	var sp: String = String(entry.get("species", ""))
	var kind: String = String(entry.get("kind", ""))
	for item in _active():
		var w: Dictionary = item
		var k: String = String(w.get("kind", ""))
		if k != "bring" and k != "craft":
			continue
		var want: Dictionary = w.get("want", {}) as Dictionary
		var target: String = String(want.get("mat", "")) if k == "bring" else String(want.get("recipe", ""))
		if target == "" or sp != target:
			continue
		if kind != "material" and kind != "":
			continue
		var anchor: Vector2 = _giver_anchor(String(w.get("giver", "")))
		if anchor.distance_to(world_pos) > HAND_OVER_R:
			continue
		var n: int = maxi(1, int(want.get("n", 1))) if k == "bring" else 1
		# the dragged chip counts as one of them; the rest come from the stock
		if _stock(target) < n:
			_say("One more, and the wish is answered.")
			return false
		_fulfil(w, true)
		return true
	return false


# Tap a bubble: hear the wish and see a trail toward its answer. Tap twice and it
# is shelved — no penalty, no scolding, it drifts back into the pool.
func handle_tap(_screen_pos: Vector2, world_pos: Vector2) -> bool:
	var best: Dictionary = {}
	var best_d: float = BUBBLE_TAP_R
	for item in _active():
		var w: Dictionary = item
		var bn: _WishBubble = _bubble_of(String(w.get("id", "")))
		if bn == null:
			continue
		var d: float = bn.position.distance_to(world_pos)
		if d < best_d:
			best_d = d
			best = w
	if best.is_empty():
		return false
	var wid: String = String(best.get("id", ""))
	var last: float = float(_tap_mem.get(wid, -999.0))
	var now: float = _nowf()
	_tap_mem[wid] = now
	if now - last <= DOUBLE_TAP:
		_shelve(best)
		return true
	_say(_wish_line(best))
	_trail_to_answer(best)
	return true


func _shelve(w: Dictionary) -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	var wid: String = String(w.get("id", ""))
	var arr: Array = st["active"] as Array
	for i in range(arr.size()):
		var a: Dictionary = arr[i]
		if String(a.get("id", "")) == wid:
			arr.remove_at(i)
			break
	(st["shelved"] as Dictionary)[String(w.get("tkey", ""))] = _now()
	_despawn_bubble(wid, false)
	_say("Another time, then.")
	emit_signal("dyn_event", "wish_shelved", {"id": wid,
		"kind": String(w.get("kind", "")), "giver": String(w.get("giver", ""))})


func _wish_of(place_id: String) -> Dictionary:
	if place_id == "":
		return {}
	for item in _active():
		var w: Dictionary = item
		if String(w.get("giver", "")) == place_id:
			return w
	return {}


# =============================================================================
# INBOUND EVENTS  (the §4.3 shared language)
# =============================================================================
func notify(kind: String, payload: Dictionary) -> void:
	match kind:
		"placed":
			var pid: String = String(payload.get("place_id", payload.get("id", "")))
			if pid != "":
				_mirror[pid] = {"node": payload.get("node"),
					"entry": payload.get("entry", {}), "tx": float(payload.get("tx", 0.0))}
			_refresh_all_progress()
			_settle_complete()
		"removed":
			var rid: String = String(payload.get("place_id", ""))
			if rid != "":
				_mirror.erase(rid)
				_drop_wishes_from(rid)
			_refresh_all_progress()
		"watered", "pruned", "fed", "warmed":
			_bump_tend(_verb_of(kind), payload)
		"nurtured":
			_bump_tend("feed", payload)
		"tend":
			# Nurture may also call note_progress("tend", {place_id, verb}) directly;
			# _bump_tend de-dupes so a care event is never counted twice.
			_bump_tend(String(payload.get("verb", "")), payload)
		"care_asked":
			# the thing Nurture is making glow becomes the focus of the next tend wish
			_hint_place = String(payload.get("place_id", ""))
		"material_gained", "craft_done", "stock_full":
			_refresh_all_progress()
		"bond_up", "friendship":
			_refresh_all_progress()
			_settle_complete()
		"event_started":
			_bump_witness(String(payload.get("kind", "")))
		"season_changed":
			_bump_season(int(payload.get("season", -1)))
		"rite_done":
			_bump_counter("ritual", "rite", String(payload.get("rite", "")))
		"vigil":
			_set_counter("vigil", int(payload.get("n", 0)))
		"puzzle_solved":
			_bump_counter("puzzle", "puzzle", _puzzle_kind(String(payload.get("id", ""))))
		"hybrid":
			_bump_counter("find", "what", "hybrid")
		"variant":
			var tier: String = String(payload.get("tier", "common"))
			if tier == "radiant" or tier == "ancient":
				_bump_counter("find", "what", "radiant")
		"discovered":
			_refresh_all_progress()
		"ascended":
			_on_ascended()


func _verb_of(kind: String) -> String:
	match kind:
		"watered": return "water"
		"pruned": return "prune"
		"fed": return "feed"
		"warmed": return "warm"
	return ""


func _bump_tend(verb: String, payload: Dictionary) -> void:
	if verb == "":
		return
	# One care = one tick. Nurture reports a care both as a dyn_event and (when it
	# prefers a direct call) through note_progress, so collapse repeats of the same
	# (verb, thing) inside a second.
	var dedupe: String = "%s@%s" % [verb, String(payload.get("place_id", payload.get("id", "")))]
	var now: float = _nowf()
	if String(_last_care_key) == dedupe and now - _last_care_at < 1.0:
		return
	_last_care_key = dedupe
	_last_care_at = now
	for item in _active():
		var w: Dictionary = item
		if String(w.get("kind", "")) != "tend":
			continue
		var want: String = String((w.get("want", {}) as Dictionary).get("verb", "any"))
		if want != "any" and want != verb:
			continue
		w["count"] = int(w.get("count", 0)) + 1
		_refresh_progress(w)
		_progress_ping(w)
	_settle_complete()


func _bump_witness(event_kind: String) -> void:
	if event_kind == "":
		return
	for item in _active():
		var w: Dictionary = item
		if String(w.get("kind", "")) != "witness":
			continue
		if String((w.get("want", {}) as Dictionary).get("event", "")) != event_kind:
			continue
		w["count"] = maxi(1, int((w.get("want", {}) as Dictionary).get("n", 1)))
		_refresh_progress(w)
		_progress_ping(w)
	_settle_complete()


func _bump_season(season: int) -> void:
	if season < 0:
		return
	for item in _active():
		var w: Dictionary = item
		if String(w.get("kind", "")) != "witness":
			continue
		var want: Dictionary = w.get("want", {}) as Dictionary
		if not want.has("season"):
			continue
		if int(want.get("season", -1)) != season:
			continue
		w["count"] = 1
		_refresh_progress(w)
		_progress_ping(w)
	_settle_complete()


func _bump_counter(wish_kind: String, want_field: String, value: String) -> void:
	if value == "":
		return
	for item in _active():
		var w: Dictionary = item
		if String(w.get("kind", "")) != wish_kind:
			continue
		if String((w.get("want", {}) as Dictionary).get(want_field, "")) != value:
			continue
		w["count"] = int(w.get("count", 0)) + 1
		_refresh_progress(w)
		_progress_ping(w)
	_settle_complete()


func _set_counter(wish_kind: String, n: int) -> void:
	for item in _active():
		var w: Dictionary = item
		if String(w.get("kind", "")) != wish_kind:
			continue
		w["count"] = maxi(int(w.get("count", 0)), n)
		_refresh_progress(w)
		_progress_ping(w)
	_settle_complete()


func _puzzle_kind(puzzle_id: String) -> String:
	var lid: String = puzzle_id.to_lower()
	if lid.find("rootwork") >= 0:
		return "rootwork"
	if lid.find("lightweave") >= 0:
		return "lightweave"
	if lid.find("bloomtide") >= 0:
		return "bloomtide"
	return ""


# A giver that leaves the world takes its wish with it, gently (shelved, not lost).
func _drop_wishes_from(place_id: String) -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	var arr: Array = st["active"] as Array
	var keep: Array = []
	for item in arr:
		var w: Dictionary = item
		if String(w.get("giver", "")) == place_id:
			(st["shelved"] as Dictionary)[String(w.get("tkey", ""))] = _now()
			_despawn_bubble(String(w.get("id", "")), false)
			continue
		keep.append(w)
	st["active"] = keep


# Ascension keeps the arcs and shelves the open wishes (DYNAMICS §6.5 step 4).
func _on_ascended() -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	for item in (st["active"] as Array):
		var w: Dictionary = item
		(st["shelved"] as Dictionary)[String(w.get("tkey", ""))] = _now()
		_despawn_bubble(String(w.get("id", "")), false)
	st["active"] = []
	_mirror.clear()
	st["last_offer"] = _now()


# =============================================================================
# WHISPERS  (§2.6 budget: one line every 8 s, never mid-drag)
# =============================================================================
func _say(text: String) -> void:
	if text == "":
		return
	var now: float = _nowf()
	if now - _last_whisper < WHISPER_GAP:
		return
	if _interact != null and _interact.has_method("is_placing") and bool(_interact.call("is_placing")):
		return
	_last_whisper = now
	emit_signal("whisper", text)


func _giver_name(gid: String) -> String:
	if gid == "heart":
		return "The island"
	if gid == "merchant":
		return "The trader"
	var r: Dictionary = _record(gid)
	var entry: Dictionary = r.get("entry", {}) as Dictionary
	if not entry.is_empty():
		return ItemCatalog.display_label(entry)
	return "Someone"


func _wish_line(w: Dictionary) -> String:
	var who: String = _giver_name(String(w.get("giver", "")))
	var want: Dictionary = w.get("want", {}) as Dictionary
	var kind: String = String(w.get("kind", ""))
	match kind:
		"bring":
			var mid: String = String(want.get("mat", ""))
			var ml: String = String((MATS.get(mid, {}) as Dictionary).get("label", mid))
			var nw: String = _count_word(int(want.get("n", 1)))
			return _line(LINE_BRING, "l:%s" % String(w.get("id", ""))) % [who, ml, nw]
		"craft":
			var rid: String = String(want.get("recipe", ""))
			var rl: String = String((GOODS.get(rid, {}) as Dictionary).get("label", rid))
			return _line(LINE_CRAFT, "l:%s" % String(w.get("id", ""))) % [who, rl]
		"plant":
			var what: String = String(want.get("label", ""))
			if int(want.get("distinct", 0)) > 0:
				return "%s dreams of a garden of six different kinds." % who
			if what == "":
				what = String(want.get("species", "something green"))
			var nn: int = int(want.get("n", 1))
			var phrase: String = what.to_lower() if nn <= 1 else "%s %s" % [_count_word(nn), what.to_lower()]
			return _line(LINE_PLANT, "l:%s" % String(w.get("id", ""))) % [who, phrase]
		"tend":
			var v: String = String(want.get("verb", "water"))
			return _line(LINE_TEND, "l:%s" % String(w.get("id", ""))) % [who, String(CARE_WORD.get(v, "care"))]
		"befriend":
			return _line(LINE_BEFRIEND, "l:%s" % String(w.get("id", ""))) % [who]
		"host":
			var bl: String = String(want.get("label", "a home"))
			return _line(LINE_HOST, "l:%s" % String(w.get("id", ""))) % [who, bl.to_lower()]
		"witness":
			var lab: String = String(want.get("label", "the sky to change"))
			return _line(LINE_WITNESS, "l:%s" % String(w.get("id", ""))) % [who, lab]
		"ritual":
			return _line(LINE_RITUAL, "l:%s" % String(w.get("id", ""))) % [who, String(want.get("label", "the old rite"))]
		"puzzle":
			return _line(LINE_PUZZLE, "l:%s" % String(w.get("id", ""))) % [who]
		"find":
			return _line(LINE_FIND, "l:%s" % String(w.get("id", ""))) % [who]
		"vigil":
			return _line(LINE_VIGIL, "l:%s" % String(w.get("id", ""))) % [who]
	return "%s is wishing for something." % who


func _line(pool: Array, tag: String) -> String:
	var v: Variant = _pick_fixed(pool, tag)
	return String(v) if v != null else ""


func _done_line(gid: String) -> String:
	var v: Variant = _pick(LINE_DONE, "done:%s" % gid)
	var s: String = String(v) if v != null else "A small joy, and it is enough."
	if s.find("%s") >= 0:
		return s % _giver_name(gid)
	return s


func _count_word(n: int) -> String:
	match n:
		1: return "one"
		2: return "two"
		3: return "three"
		4: return "four"
		5: return "five"
		6: return "six"
	return str(n)


func _season_word(s: int) -> String:
	match s:
		0: return "Greenrise"
		1: return "Highsun"
		2: return "Emberfall"
		3: return "Stillfrost"
	return "the turning season"


func _event_word(e: String) -> String:
	match e:
		"meteor": return "a shower of falling stars"
		"festival": return "a festival"
		"merchant": return "a trader from somewhere else"
		"migration": return "the great crossing"
		"bloomtide": return "the bloomtide rain"
		"aurora": return "a quiet, shining night"
	return "something in the sky"


func _rite_word(r: String) -> String:
	match r:
		"rain": return "the Rite of Rain"
		"warmth": return "the Rite of Warmth"
		"light": return "the Rite of Light"
		"roots": return "the Rite of Roots"
		"kinship": return "the Rite of Kinship"
		"finding": return "the Rite of Finding"
		"plenty": return "the Rite of Plenty"
		"stillness": return "the Rite of Stillness"
		"long_year": return "the Rite of the Long Year"
	return "an old rite"


func _find_word(w: String) -> String:
	if w == "hybrid":
		return "a crossing of two kinds"
	return "something radiant"


# =============================================================================
# BUBBLES + CELEBRATION  (all Proc toolkit, all in-world)
# =============================================================================
func _rebuild_bubbles() -> void:
	for wid in _live.keys():
		_despawn_bubble(String(wid), false)
	_live.clear()
	for item in _active():
		_spawn_bubble(item as Dictionary)


func _spawn_bubble(w: Dictionary) -> void:
	var wid: String = String(w.get("id", ""))
	if wid == "" or _live.has(wid):
		return
	var b: _WishBubble = _WishBubble.new()
	b.seedv = hash("%d:wish:%s" % [world_seed, wid])
	b.growth = 1.0
	b.grow_rate = 0.0
	b.glyph = String(w.get("glyph", "sprout"))
	b.prog = float(w.get("prog", 0.0))
	b.is_arc = String(w.get("arc", "")) != ""
	b.z_index = 34
	b.position = _bubble_anchor(String(w.get("giver", "")))
	b.scale = Vector2(0.2, 0.2)
	add_child(b)
	var tw: Tween = b.create_tween().set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
	tw.tween_property(b, "scale", Vector2.ONE, 0.26)
	var live: Dictionary = {"bubble": b, "ring": null, "glow": null}
	_live[wid] = live
	_set_giver_ring(wid, String(w.get("giver", "")), true)


func _despawn_bubble(wid: String, celebrate: bool) -> void:
	var live: Dictionary = _live.get(wid, {}) as Dictionary
	if live.is_empty():
		return
	var bn: _WishBubble = _bubble_of(wid)
	if bn != null:
		if celebrate:
			bn.bloom_away()
		else:
			var tw: Tween = bn.create_tween()
			tw.tween_property(bn, "scale", Vector2(0.1, 0.1), 0.22)
			tw.parallel().tween_property(bn, "modulate:a", 0.0, 0.22)
			tw.tween_callback(bn.queue_free)
	var ring: Variant = live.get("ring")
	if ring is Node and is_instance_valid(ring as Node) and (ring as Node).has_method("fade_out"):
		(ring as Node).call("fade_out", 0.4)
	var glow: Variant = live.get("glow")
	if glow is Node and is_instance_valid(glow as Node) and (glow as Node).has_method("fade_out"):
		(glow as Node).call("fade_out", 0.3)
	_live.erase(wid)
	_tap_mem.erase(wid)


func _set_giver_ring(wid: String, gid: String, on: bool) -> void:
	var live: Dictionary = _live.get(wid, {}) as Dictionary
	if live.is_empty():
		return
	if not on:
		return
	var host: Node2D = _node_of(gid)
	if host == null:
		return
	var fr: float = _prop_f(host, "footprint_radius", 34.0)
	var ring: ProcNode = ProcEffects.make_selection_ring(world_seed, "wish:%s" % wid,
		{"radius": fr * 1.3, "style": "rune", "ground": true, "z": 0,
		 "color": Color(1.0, 0.88, 0.52)})
	ring.modulate.a = 0.35
	host.add_child(ring)
	live["ring"] = ring


# A satisfiable wish wears a soft bloom — the only "do it now" the game will ever
# show, and it is a glow, not a badge.
func _set_ready_glow(wid: String, on: bool) -> void:
	var live: Dictionary = _live.get(wid, {}) as Dictionary
	if live.is_empty():
		return
	var cur: Variant = live.get("glow")
	if on:
		if cur is Node and is_instance_valid(cur as Node):
			return
		var bn: _WishBubble = _bubble_of(wid)
		if bn == null:
			return
		var glow: ProcNode = ProcEffects.make_selection_ring(world_seed, "wishglow:%s" % wid,
			{"radius": 74.0, "style": "bloom", "ground": false, "z": -1,
			 "color": Color(1.0, 0.94, 0.70)})
		glow.modulate.a = 0.42
		bn.add_child(glow)
		live["glow"] = glow
	else:
		if cur is Node and is_instance_valid(cur as Node) and (cur as Node).has_method("fade_out"):
			(cur as Node).call("fade_out", 0.3)
		live["glow"] = null


# Bubbles ride above their wisher, bobbing — one transform per bubble per frame.
func _follow_bubbles(_delta: float) -> void:
	if _live.is_empty():
		return
	for item in _active():
		var w: Dictionary = item
		var bn: _WishBubble = _bubble_of(String(w.get("id", "")))
		if bn == null:
			continue
		var target: Vector2 = _bubble_anchor(String(w.get("giver", "")))
		target.y += sin(_bubble_t * 1.1 + float(absi(bn.seedv) % 100) * 0.06) * 5.0
		bn.position = bn.position.lerp(target, 0.18)


func _bubble_anchor(gid: String) -> Vector2:
	var p: Vector2 = _giver_anchor(gid)
	if gid == "heart":
		return p + Vector2(96.0, -_heart_height() * 0.92)
	var host: Node2D = _node_of(gid)
	var fr: float = _prop_f(host, "footprint_radius", 34.0) if host != null else 34.0
	return p + Vector2(0.0, -maxf(fr * 2.4, 96.0) - 48.0)


func _giver_anchor(gid: String) -> Vector2:
	if gid == "heart" or gid == "merchant":
		return _heart_pos()
	var host: Node2D = _node_of(gid)
	if host != null:
		return host.position
	return _heart_pos()


# A small bright pulse on the bubble whenever its arc ticks up.
func _progress_ping(w: Dictionary) -> void:
	var bn: _WishBubble = _bubble_of(String(w.get("id", "")))
	if bn != null:
		var tw: Tween = bn.create_tween().set_trans(Tween.TRANS_SINE)
		tw.tween_property(bn, "scale", Vector2(1.12, 1.12), 0.12)
		tw.tween_property(bn, "scale", Vector2.ONE, 0.18)
	emit_signal("dyn_event", "wish_progress", {"id": String(w.get("id", "")),
		"kind": String(w.get("kind", "")), "giver": String(w.get("giver", "")),
		"prog": float(w.get("prog", 0.0))})


# The joy: petals, a wave of light, rising motes. No popup, no "+1 Quest".
func _celebrate(anchor: Vector2, gid: String) -> void:
	_joy(anchor, 1.0)
	var host: Node2D = _node_of(gid)
	if host != null:
		var tw: Tween = host.create_tween().set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
		var base: Vector2 = host.scale
		tw.tween_property(host, "scale", base * 1.08, 0.14)
		tw.tween_property(host, "scale", base, 0.3)
	if _space != null and _space.has_method("spawn_world_fx"):
		_space.call("spawn_world_fx", anchor + Vector2(0, -40.0), "sparkle", "light", "")


func _joy(anchor: Vector2, strength: float) -> void:
	var j: _JoyBloom = _JoyBloom.new()
	j.seedv = hash("%d:joy:%d" % [world_seed, int(_nowf() * 1000.0)])
	j.growth = 1.0
	j.grow_rate = 0.0
	j.power = clampf(strength, 0.5, 2.0)
	j.z_index = 33
	j.position = anchor + Vector2(0.0, -60.0)
	add_child(j)


func _walk_in_glow(at: Vector2) -> void:
	var j: _JoyBloom = _JoyBloom.new()
	j.seedv = hash("%d:arrive:%d" % [world_seed, int(_nowf() * 1000.0)])
	j.growth = 1.0
	j.grow_rate = 0.0
	j.power = 0.8
	j.petals_only = true
	j.z_index = 33
	j.position = at + Vector2(0.0, -30.0)
	add_child(j)


# A rush of motes from the wisher toward the Heart Tree's root-pool: the essence
# surge made visible, using the world's own mote channel when it is available.
func _mote_rush(from: Vector2, amount: float) -> void:
	if _space != null and _space.has_method("drift_mote_pub"):
		var n: int = clampi(int(amount / 60.0) + 2, 2, 5)
		for i in range(n):
			_space.call("drift_mote_pub", from + Vector2(float(i) * 14.0 - 28.0, -50.0),
				"essence", clampf(amount / float(n), 0.2, 4.0))
		return
	_trail(from + Vector2(0, -50.0), _heart_pos() + Vector2(0, -14.0), Color(0.62, 0.98, 0.76), 3)


# The whole navigation UI: motes drift from the bubble toward where the answer is.
func _trail_to_answer(w: Dictionary) -> void:
	var from: Vector2 = _bubble_anchor(String(w.get("giver", "")))
	var to: Vector2 = _answer_pos(w)
	if to == Vector2.INF:
		return
	_trail(from, to, Color(1.0, 0.9, 0.58), 4)


func _answer_pos(w: Dictionary) -> Vector2:
	var kind: String = String(w.get("kind", ""))
	var want: Dictionary = w.get("want", {}) as Dictionary
	match kind:
		"bring", "craft":
			# toward a stockpile / craft site if one stands, else the basket (down)
			var site: Vector2 = _nearest_entry_pos(["stockpile", "hearth", "craftlog"])
			if site != Vector2.INF:
				return site
			return _bubble_anchor(String(w.get("giver", ""))) + Vector2(0.0, 520.0)
		"plant":
			var sp: String = String(want.get("species", ""))
			var cousin: Vector2 = _nearest_entry_pos([sp]) if sp != "" else Vector2.INF
			if cousin != Vector2.INF:
				return cousin
			return _giver_anchor(String(w.get("giver", ""))) + Vector2(240.0, 0.0)
		"tend":
			var focus: String = String(want.get("focus", ""))
			var fn: Node2D = _node_of(focus)
			if fn != null:
				return fn.position + Vector2(0, -40.0)
			return _nearest_entry_pos(["oak", "willow", "birch", "pine", "maple", "blossom"])
		"ritual", "vigil":
			return _nearest_entry_pos(["ritual_circle", "stones"])
		"witness":
			return _bubble_anchor(String(w.get("giver", ""))) + Vector2(0.0, -420.0)
		"puzzle":
			return _giver_anchor(String(w.get("giver", ""))) + Vector2(760.0, -60.0)
	return _heart_pos() + Vector2(0, -_heart_height() * 0.5)


func _nearest_entry_pos(species_any: Array) -> Vector2:
	var best: Vector2 = Vector2.INF
	var best_d: float = INF
	var origin: Vector2 = _heart_pos()
	for item in _records_list():
		var r: Dictionary = item
		var entry: Dictionary = r.get("entry", {}) as Dictionary
		var sp: String = String(entry.get("species", ""))
		if not species_any.has(sp):
			continue
		var nd: Variant = r.get("node")
		if not (nd is Node2D) or not is_instance_valid(nd as Node2D):
			continue
		var d: float = (nd as Node2D).position.distance_to(origin)
		if d < best_d:
			best_d = d
			best = (nd as Node2D).position + Vector2(0, -30.0)
	return best


func _trail(from: Vector2, to: Vector2, col: Color, n: int) -> void:
	for i in range(n):
		if _trails.size() >= MAX_TRAIL_MOTES:
			return
		var m: _TrailMote = _TrailMote.new()
		m.seedv = hash("%d:trail:%d:%d" % [world_seed, int(_nowf() * 100.0), i])
		m.growth = 1.0
		m.grow_rate = 0.0
		m.from_p = from
		m.to_p = to
		m.tint = col
		m.delay = float(i) * 0.16
		m.z_index = 33
		m.position = from
		add_child(m)
		_trails.append(m)


func _advance_trails(_delta: float) -> void:
	if _trails.is_empty():
		return
	var keep: Array = []
	for item in _trails:
		if item is Node and is_instance_valid(item as Node):
			keep.append(item)
	_trails = keep


func _nowf() -> float:
	return float(Time.get_ticks_msec()) / 1000.0


# =============================================================================
#  _WishBubble — the soft parchment thought-cloud with a gold progress arc.
#  One shared visual family with CreatureLife's mood bubbles (§7.4): a smooth
#  Catmull-Rom cloud, two trailing dots toward the speaker, a 3 px ink line, and
#  a generated glyph of the thing wished for. Redraws only when the arc moves.
# =============================================================================
class _WishBubble extends ProcNode:
	const PARCH := Color("#FBF6E9")
	const PARCH2 := Color("#F2E7CE")
	const INK := Color("#3A2E22")
	const GOLD := Color(1.0, 0.84, 0.42)
	const GOLD_HI := Color(1.0, 0.97, 0.80)

	var prog: float = 0.0
	var glyph: String = "sprout"
	var ready_state: bool = false
	var is_arc: bool = false
	var radius: float = 58.0

	var _shown: float = 0.0
	var _cloud: PackedVector2Array = PackedVector2Array()
	var _sheen: PackedVector2Array = PackedVector2Array()

	func _on_built() -> void:
		_build_cloud()

	func _build_cloud() -> void:
		# a cloud: a ring of control points with three fuller lobes on top
		var ctrl := PackedVector2Array()
		var lobes := 11
		for i in range(lobes):
			var a: float = TAU * float(i) / float(lobes) - PI * 0.5
			var up: float = maxf(0.0, -sin(a))
			var wob: float = Proc.hashf(seedv, "cl:%d" % i) * 0.16
			var rr: float = radius * (0.86 + up * 0.26 + wob)
			ctrl.append(Vector2(cos(a) * rr * 1.14, sin(a) * rr * 0.92))
		_cloud = Proc.smooth_loop(ctrl, 7)
		var sh := PackedVector2Array()
		for i in range(14):
			var a2: float = PI * 1.08 + PI * 0.52 * float(i) / 13.0
			sh.append(Vector2(cos(a2), sin(a2)) * radius * 0.78 + Vector2(0, -radius * 0.06))
		_sheen = sh

	func _animate(_delta: float) -> void:
		if absf(_shown - prog) > 0.004:
			_shown = lerpf(_shown, prog, 0.14)
			queue_redraw()

	func bloom_away() -> void:
		# the bubble opens like a flower and lets go
		var tw := create_tween().set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
		tw.tween_property(self, "scale", Vector2(1.5, 1.5), 0.3)
		tw.parallel().tween_property(self, "modulate:a", 0.0, 0.34)
		tw.tween_callback(queue_free)

	func _draw() -> void:
		if _cloud.is_empty():
			_build_cloud()
		# soft shadow
		var shadow := PackedVector2Array()
		for p in _cloud:
			shadow.append(p + Vector2(3.0, 5.0))
		draw_colored_polygon(shadow, Color(0.15, 0.11, 0.08, 0.16))
		# parchment body with a gentle vertical gradient
		draw_polygon(_cloud, Proc.grad_fill(_cloud, PARCH, PARCH2))
		# trailing dots toward the speaker below
		draw_circle(Vector2(-radius * 0.26, radius * 0.86), radius * 0.15, PARCH)
		draw_circle(Vector2(-radius * 0.40, radius * 1.16), radius * 0.09, PARCH)
		# ink outline
		var ring := _cloud
		ring.append(_cloud[0])
		draw_polyline(ring, Color(INK.r, INK.g, INK.b, 0.82), 3.0, true)
		draw_arc(Vector2(-radius * 0.26, radius * 0.86), radius * 0.15, 0, TAU, 14,
			Color(INK.r, INK.g, INK.b, 0.6), 2.0, true)
		# inner sheen
		draw_polyline(_sheen, Color(1, 1, 1, 0.42), 4.0, true)
		# the gold progress arc (track + sweep + a bead at the leading edge)
		var ar: float = radius * 1.30
		draw_arc(Vector2.ZERO, ar, 0.0, TAU, 44, Color(INK.r, INK.g, INK.b, 0.14), 4.0, true)
		var sweep: float = clampf(_shown, 0.0, 1.0)
		if sweep > 0.004:
			var a0: float = -PI * 0.5
			var a1: float = a0 + TAU * sweep
			var col: Color = GOLD if not is_arc else Color(0.78, 0.92, 1.0)
			draw_arc(Vector2.ZERO, ar, a0, a1, maxi(8, int(44.0 * sweep)), col, 6.0, true)
			var bead: Vector2 = Vector2(cos(a1), sin(a1)) * ar
			draw_circle(bead, 6.5, GOLD_HI)
			draw_circle(bead, 3.0, Color(1, 1, 1, 0.9))
		if ready_state:
			draw_arc(Vector2.ZERO, ar + 7.0, 0.0, TAU, 44, Color(GOLD.r, GOLD.g, GOLD.b, 0.3), 3.0, true)
		_draw_glyph()

	# ---- the generated glyph of the thing wished for -------------------------
	func _draw_glyph() -> void:
		var s: float = radius * 0.62
		var ink: Color = Color(INK.r, INK.g, INK.b, 0.92)
		match glyph:
			"droplet": _g_droplet(s, ink)
			"wood": _g_wood(s, ink)
			"ember": _g_ember(s, ink)
			"shard": _g_shard(s, ink)
			"star": _g_star(s, ink)
			"coil": _g_coil(s, ink)
			"comb": _g_comb(s, ink)
			"clay": _g_clay(s, ink)
			"loaf": _g_loaf(s, ink, false)
			"cake": _g_loaf(s, ink, true)
			"glass": _g_glass(s, ink)
			"balm": _g_balm(s, ink)
			"sprout": _g_sprout(s, ink)
			"tree": _g_tree(s, ink)
			"mushroom": _g_mushroom(s, ink)
			"lantern": _g_lantern(s, ink)
			"stone": _g_stone(s, ink)
			"shears": _g_shears(s, ink)
			"bowl": _g_bowl(s, ink)
			"twohearts": _g_hearts(s, ink)
			"house": _g_house(s, ink)
			"leaf": _g_leaf(s, ink)
			"rain": _g_rain(s, ink)
			"bird": _g_bird(s, ink)
			"moon": _g_moon(s, ink)
			"stones": _g_stones(s, ink)
			"root": _g_root(s, ink)
			"spiral": _g_spiral(s, ink)
			_: _g_sprout(s, ink)

	func _fill_outline(pts: PackedVector2Array, fill: Color, ink: Color, w: float = 2.4) -> void:
		if pts.size() < 3:
			return
		draw_colored_polygon(pts, fill)
		var r := pts
		r.append(pts[0])
		draw_polyline(r, ink, w, true)

	func _g_droplet(s: float, ink: Color) -> void:
		var ctrl := PackedVector2Array([
			Vector2(0, -s * 0.95), Vector2(s * 0.52, -s * 0.05),
			Vector2(s * 0.36, s * 0.62), Vector2(0, s * 0.82),
			Vector2(-s * 0.36, s * 0.62), Vector2(-s * 0.52, -s * 0.05)])
		var p := Proc.smooth_loop(ctrl, 8)
		_fill_outline(p, Color(0.56, 0.82, 0.96, 0.95), ink)
		draw_circle(Vector2(-s * 0.16, s * 0.18), s * 0.14, Color(1, 1, 1, 0.75))

	func _g_wood(s: float, ink: Color) -> void:
		var p := Proc.superellipse(s * 0.78, s * 0.46, 3.2, 28)
		_fill_outline(p, Color(0.62, 0.44, 0.28, 1.0), ink)
		for i in range(3):
			draw_arc(Vector2(-s * 0.1, 0), s * (0.12 + 0.11 * float(i)), 0, TAU, 20,
				Color(0.36, 0.24, 0.15, 0.75), 2.0, true)

	func _g_ember(s: float, ink: Color) -> void:
		var ctrl := PackedVector2Array([
			Vector2(0, -s * 0.95), Vector2(s * 0.44, -s * 0.22), Vector2(s * 0.3, s * 0.6),
			Vector2(0, s * 0.8), Vector2(-s * 0.3, s * 0.6), Vector2(-s * 0.44, -s * 0.22)])
		var p := Proc.smooth_loop(ctrl, 8)
		_fill_outline(p, Color(1.0, 0.62, 0.28, 1.0), ink)
		draw_circle(Vector2(0, s * 0.18), s * 0.22, Color(1.0, 0.92, 0.6, 0.9))

	func _g_shard(s: float, ink: Color) -> void:
		var p := PackedVector2Array([
			Vector2(0, -s * 0.98), Vector2(s * 0.42, -s * 0.18),
			Vector2(s * 0.2, s * 0.82), Vector2(-s * 0.24, s * 0.74),
			Vector2(-s * 0.44, -s * 0.24)])
		_fill_outline(p, Color(0.72, 0.86, 1.0, 0.95), ink)
		draw_polyline(PackedVector2Array([Vector2(0, -s * 0.9), Vector2(-s * 0.06, s * 0.7)]),
			Color(1, 1, 1, 0.7), 2.4, true)

	func _g_star(s: float, ink: Color) -> void:
		var p := PackedVector2Array()
		for i in range(10):
			var a: float = -PI * 0.5 + TAU * float(i) / 10.0
			var rr: float = s * (0.98 if i % 2 == 0 else 0.42)
			p.append(Vector2(cos(a), sin(a)) * rr)
		_fill_outline(p, Color(1.0, 0.92, 0.6, 1.0), ink, 2.0)

	func _g_coil(s: float, ink: Color) -> void:
		var p := PackedVector2Array()
		for i in range(46):
			var u: float = float(i) / 45.0
			var a: float = u * TAU * 2.2
			var rr: float = s * (0.18 + 0.72 * u)
			p.append(Vector2(cos(a), sin(a) * 0.72) * rr)
		draw_polyline(p, Color(0.76, 0.78, 0.62, 1.0), 6.0, true)
		draw_polyline(p, ink, 2.0, true)

	func _g_comb(s: float, ink: Color) -> void:
		for i in range(4):
			var cx: float = (-0.5 + float(i % 2)) * s * 0.74
			var cy: float = (-0.42 + float(i / 2)) * s * 0.9
			var hex := PackedVector2Array()
			for k in range(6):
				var a: float = TAU * float(k) / 6.0 + PI / 6.0
				hex.append(Vector2(cx, cy) + Vector2(cos(a), sin(a)) * s * 0.36)
			_fill_outline(hex, Color(1.0, 0.82, 0.38, 1.0), ink, 2.0)

	func _g_clay(s: float, ink: Color) -> void:
		var ctrl := PackedVector2Array([
			Vector2(-s * 0.4, -s * 0.5), Vector2(s * 0.4, -s * 0.56),
			Vector2(s * 0.62, s * 0.34), Vector2(0, s * 0.78), Vector2(-s * 0.62, s * 0.34)])
		var p := Proc.smooth_loop(ctrl, 8)
		_fill_outline(p, Color(0.68, 0.46, 0.36, 1.0), ink)
		draw_polyline(PackedVector2Array([Vector2(-s * 0.36, -s * 0.46), Vector2(s * 0.36, -s * 0.5)]),
			Color(0.42, 0.28, 0.22, 0.9), 3.0, true)

	func _g_loaf(s: float, ink: Color, iced: bool) -> void:
		var ctrl := PackedVector2Array([
			Vector2(-s * 0.84, s * 0.4), Vector2(-s * 0.7, -s * 0.3),
			Vector2(0, -s * 0.72), Vector2(s * 0.7, -s * 0.3), Vector2(s * 0.84, s * 0.4)])
		var p := Proc.smooth_loop(ctrl, 8)
		_fill_outline(p, Color(0.86, 0.66, 0.38, 1.0), ink)
		if iced:
			draw_arc(Vector2(0, -s * 0.1), s * 0.5, PI * 1.04, TAU, 20, Color(1, 0.96, 0.9, 0.95), 7.0, true)
			draw_circle(Vector2(0, -s * 0.62), s * 0.14, Color(0.95, 0.45, 0.5, 1.0))
		else:
			for i in range(3):
				var x: float = (-1.0 + float(i)) * s * 0.34
				draw_polyline(PackedVector2Array([Vector2(x - s * 0.1, -s * 0.3), Vector2(x + s * 0.1, -s * 0.5)]),
					Color(0.56, 0.4, 0.22, 0.85), 2.6, true)

	func _g_glass(s: float, ink: Color) -> void:
		var p := Proc.superellipse(s * 0.56, s * 0.86, 3.6, 28)
		_fill_outline(p, Color(0.78, 0.94, 0.98, 0.85), ink)
		draw_circle(Vector2(0, -s * 0.1), s * 0.3, Color(1, 1, 0.9, 0.55))
		draw_polyline(PackedVector2Array([Vector2(-s * 0.22, -s * 0.5), Vector2(-s * 0.3, s * 0.3)]),
			Color(1, 1, 1, 0.8), 2.6, true)

	func _g_balm(s: float, ink: Color) -> void:
		var p := Proc.superellipse(s * 0.62, s * 0.52, 3.0, 26)
		var moved := PackedVector2Array()
		for q in p:
			moved.append(q + Vector2(0, s * 0.2))
		_fill_outline(moved, Color(0.52, 0.66, 0.44, 1.0), ink)
		draw_polyline(PackedVector2Array([Vector2(-s * 0.4, -s * 0.3), Vector2(s * 0.4, -s * 0.3)]),
			Color(0.36, 0.3, 0.2, 0.95), 5.0, true)
		draw_circle(Vector2(0, -s * 0.52), s * 0.14, Color(0.78, 0.86, 0.6, 1.0))

	func _g_sprout(s: float, ink: Color) -> void:
		draw_polyline(PackedVector2Array([Vector2(0, s * 0.8), Vector2(0, -s * 0.2)]),
			Color(0.42, 0.62, 0.3, 1.0), 4.0, true)
		for side in [-1.0, 1.0]:
			var leaf := PackedVector2Array()
			var ctrl := PackedVector2Array([
				Vector2(0, -s * 0.1), Vector2(side * s * 0.42, -s * 0.46),
				Vector2(side * s * 0.76, -s * 0.04), Vector2(side * s * 0.3, s * 0.12)])
			leaf = Proc.smooth_loop(ctrl, 7)
			_fill_outline(leaf, Color(0.5, 0.76, 0.38, 1.0), ink, 2.0)
		draw_circle(Vector2(0, -s * 0.3), s * 0.1, Color(0.96, 0.92, 0.6, 0.9))

	func _g_tree(s: float, ink: Color) -> void:
		draw_polyline(PackedVector2Array([Vector2(0, s * 0.86), Vector2(0, s * 0.1)]),
			Color(0.46, 0.34, 0.22, 1.0), 6.0, true)
		var canopy := Proc.blob(seedv, "glyphtree", s * 0.74, 8, 0.2)
		var moved := PackedVector2Array()
		for q in canopy:
			moved.append(q + Vector2(0, -s * 0.24))
		_fill_outline(moved, Color(0.42, 0.7, 0.38, 1.0), ink)

	func _g_mushroom(s: float, ink: Color) -> void:
		var stem := PackedVector2Array([
			Vector2(-s * 0.18, s * 0.78), Vector2(-s * 0.14, 0), Vector2(s * 0.14, 0),
			Vector2(s * 0.18, s * 0.78)])
		_fill_outline(stem, Color(0.94, 0.9, 0.78, 1.0), ink, 2.0)
		var cap := PackedVector2Array()
		for i in range(22):
			var a: float = PI + PI * float(i) / 21.0
			cap.append(Vector2(cos(a) * s * 0.82, sin(a) * s * 0.62))
		cap.append(Vector2(s * 0.82, 0))
		cap.append(Vector2(-s * 0.82, 0))
		_fill_outline(cap, Color(0.86, 0.34, 0.3, 1.0), ink)
		draw_circle(Vector2(-s * 0.2, -s * 0.24), s * 0.12, Color(1, 0.96, 0.9, 0.9))

	func _g_lantern(s: float, ink: Color) -> void:
		draw_arc(Vector2(0, -s * 0.72), s * 0.22, PI, TAU, 14, ink, 2.6, true)
		var body := Proc.superellipse(s * 0.44, s * 0.56, 3.4, 26)
		var moved := PackedVector2Array()
		for q in body:
			moved.append(q + Vector2(0, s * 0.08))
		_fill_outline(moved, Color(1.0, 0.86, 0.5, 1.0), ink)
		draw_circle(Vector2(0, s * 0.06), s * 0.24, Color(1, 0.98, 0.78, 0.95))

	func _g_stone(s: float, ink: Color) -> void:
		var p := Proc.blob(seedv, "glyphstone", s * 0.74, 7, 0.22)
		var moved := PackedVector2Array()
		for q in p:
			moved.append(Vector2(q.x, q.y * 0.72) + Vector2(0, s * 0.14))
		_fill_outline(moved, Color(0.62, 0.62, 0.58, 1.0), ink)
		draw_arc(Vector2(-s * 0.18, -s * 0.06), s * 0.22, PI * 1.1, PI * 1.9, 14, Color(1, 1, 1, 0.4), 2.4, true)

	func _g_shears(s: float, ink: Color) -> void:
		for side in [-1.0, 1.0]:
			draw_polyline(PackedVector2Array([
				Vector2(side * s * 0.1, s * 0.1), Vector2(side * s * 0.6, -s * 0.78)]),
				Color(0.78, 0.8, 0.84, 1.0), 6.0, true)
			draw_arc(Vector2(side * s * 0.26, s * 0.5), s * 0.26, 0, TAU, 18, ink, 3.0, true)
		draw_circle(Vector2.ZERO, s * 0.1, ink)

	func _g_bowl(s: float, ink: Color) -> void:
		var bowl := PackedVector2Array()
		for i in range(20):
			var a: float = PI * float(i) / 19.0
			bowl.append(Vector2(cos(a) * s * 0.78, sin(a) * s * 0.52))
		_fill_outline(bowl, Color(0.8, 0.68, 0.52, 1.0), ink)
		draw_arc(Vector2(0, -s * 0.04), s * 0.5, PI, TAU, 18, Color(0.95, 0.82, 0.5, 0.9), 6.0, true)
		draw_circle(Vector2(s * 0.1, -s * 0.34), s * 0.1, Color(1, 0.96, 0.84, 0.8))

	func _g_hearts(s: float, ink: Color) -> void:
		for side in [-1.0, 1.0]:
			var ctrl := PackedVector2Array([
				Vector2(side * s * 0.34, s * 0.42),
				Vector2(side * s * 0.34 - s * 0.38, -s * 0.06),
				Vector2(side * s * 0.34 - s * 0.14, -s * 0.44),
				Vector2(side * s * 0.34, -s * 0.16),
				Vector2(side * s * 0.34 + s * 0.14, -s * 0.44),
				Vector2(side * s * 0.34 + s * 0.38, -s * 0.06)])
			var p := Proc.smooth_loop(ctrl, 8)
			var col: Color = Color(0.94, 0.48, 0.52, 1.0) if side < 0.0 else Color(1.0, 0.68, 0.56, 1.0)
			_fill_outline(p, col, ink, 2.0)

	func _g_house(s: float, ink: Color) -> void:
		var body := PackedVector2Array([
			Vector2(-s * 0.62, s * 0.74), Vector2(-s * 0.62, -s * 0.06),
			Vector2(s * 0.62, -s * 0.06), Vector2(s * 0.62, s * 0.74)])
		_fill_outline(body, Color(0.92, 0.86, 0.72, 1.0), ink)
		var roof := PackedVector2Array([
			Vector2(-s * 0.8, -s * 0.02), Vector2(0, -s * 0.84), Vector2(s * 0.8, -s * 0.02)])
		_fill_outline(roof, Color(0.72, 0.4, 0.34, 1.0), ink)
		var door := Proc.superellipse(s * 0.16, s * 0.26, 3.0, 20)
		var moved := PackedVector2Array()
		for q in door:
			moved.append(q + Vector2(0, s * 0.48))
		_fill_outline(moved, Color(0.5, 0.36, 0.24, 1.0), ink, 2.0)

	func _g_leaf(s: float, ink: Color) -> void:
		var ctrl := PackedVector2Array([
			Vector2(-s * 0.72, s * 0.3), Vector2(-s * 0.2, -s * 0.6),
			Vector2(s * 0.68, -s * 0.44), Vector2(s * 0.2, s * 0.52)])
		var p := Proc.smooth_loop(ctrl, 8)
		_fill_outline(p, Color(0.88, 0.58, 0.28, 1.0), ink)
		draw_polyline(PackedVector2Array([Vector2(-s * 0.56, s * 0.26), Vector2(s * 0.5, -s * 0.36)]),
			Color(0.6, 0.36, 0.18, 0.9), 2.6, true)

	func _g_rain(s: float, ink: Color) -> void:
		var cloud := Proc.blob(seedv, "glyphcloud", s * 0.62, 8, 0.24)
		var moved := PackedVector2Array()
		for q in cloud:
			moved.append(Vector2(q.x * 1.2, q.y * 0.6) + Vector2(0, -s * 0.34))
		_fill_outline(moved, Color(0.78, 0.84, 0.9, 1.0), ink)
		for i in range(3):
			var x: float = (-1.0 + float(i)) * s * 0.4
			draw_polyline(PackedVector2Array([Vector2(x, s * 0.08), Vector2(x - s * 0.08, s * 0.66)]),
				Color(0.5, 0.74, 0.92, 0.95), 3.4, true)

	func _g_bird(s: float, ink: Color) -> void:
		for side in [-1.0, 1.0]:
			var pts := PackedVector2Array()
			for i in range(14):
				var u: float = float(i) / 13.0
				pts.append(Vector2(side * u * s * 0.82, -sin(u * PI) * s * 0.42 + s * 0.1))
			draw_polyline(pts, ink, 4.0, true)
		draw_circle(Vector2(0, s * 0.12), s * 0.1, ink)

	func _g_moon(s: float, ink: Color) -> void:
		var p := PackedVector2Array()
		for i in range(22):
			var a: float = PI * 0.35 + PI * 1.3 * float(i) / 21.0
			p.append(Vector2(cos(a), sin(a)) * s * 0.84)
		for i in range(18):
			var a2: float = PI * 1.65 - PI * 1.3 * float(i) / 17.0
			p.append(Vector2(cos(a2) * s * 0.52 + s * 0.2, sin(a2) * s * 0.74))
		_fill_outline(p, Color(0.96, 0.95, 0.82, 1.0), ink)

	func _g_stones(s: float, ink: Color) -> void:
		for i in range(3):
			var x: float = (-1.0 + float(i)) * s * 0.52
			var h: float = s * (0.6 + 0.22 * Proc.hashf(seedv, "gs:%d" % i))
			var p := PackedVector2Array([
				Vector2(x - s * 0.16, s * 0.72), Vector2(x - s * 0.12, -h),
				Vector2(x + s * 0.12, -h), Vector2(x + s * 0.16, s * 0.72)])
			_fill_outline(p, Color(0.66, 0.64, 0.6, 1.0), ink, 2.0)
		draw_arc(Vector2(0, s * 0.74), s * 0.8, PI, TAU, 22, Color(0.72, 0.6, 0.4, 0.7), 2.6, true)

	func _g_root(s: float, ink: Color) -> void:
		var main := PackedVector2Array()
		for i in range(18):
			var u: float = float(i) / 17.0
			main.append(Vector2(-s * 0.7 + u * s * 1.4, sin(u * PI * 1.4) * s * 0.3))
		draw_polyline(main, Color(0.56, 0.42, 0.28, 1.0), 5.0, true)
		for k in range(3):
			var u2: float = 0.25 + 0.25 * float(k)
			var base: Vector2 = Vector2(-s * 0.7 + u2 * s * 1.4, sin(u2 * PI * 1.4) * s * 0.3)
			draw_polyline(PackedVector2Array([base, base + Vector2(s * 0.14, s * 0.46)]),
				Color(0.56, 0.42, 0.28, 0.9), 3.0, true)
		draw_circle(Vector2(s * 0.66, -s * 0.12), s * 0.14, Color(0.78, 0.95, 0.7, 0.95))
		draw_arc(Vector2(s * 0.66, -s * 0.12), s * 0.14, 0, TAU, 16, ink, 2.0, true)

	func _g_spiral(s: float, ink: Color) -> void:
		var p := PackedVector2Array()
		for i in range(46):
			var u: float = float(i) / 45.0
			var a: float = u * TAU * 1.8
			p.append(Vector2(cos(a), sin(a)) * s * (0.12 + 0.76 * u))
		draw_polyline(p, ink, 3.4, true)
		draw_circle(p[p.size() - 1], s * 0.1, Color(1.0, 0.92, 0.62, 0.95))


# =============================================================================
#  _JoyBloom — the celebration: a wave of light, a ring of petals that fly out
#  and tumble, and a few rising sparks. One short-lived node, then gone.
# =============================================================================
class _JoyBloom extends ProcNode:
	var power: float = 1.0
	var petals_only: bool = false
	var life: float = 1.5
	var _petals: Array = []
	var _sparks: Array = []

	func _on_built() -> void:
		animate_draw = true
		var n: int = 10 if not petals_only else 7
		for i in range(n):
			var a: float = TAU * float(i) / float(n) + Proc.hashf(seedv, "pa:%d" % i) * 0.5
			_petals.append({
				"dir": Vector2(cos(a), sin(a) * 0.7),
				"reach": (70.0 + 54.0 * Proc.hashf(seedv, "pr:%d" % i)) * power,
				"spin": (Proc.hashf(seedv, "ps:%d" % i) - 0.5) * 7.0,
				"size": (9.0 + 7.0 * Proc.hashf(seedv, "pz:%d" % i)) * power,
				"hue": Proc.hashf(seedv, "ph:%d" % i),
			})
		for i in range(6):
			_sparks.append({
				"x": (Proc.hashf(seedv, "sx:%d" % i) - 0.5) * 92.0 * power,
				"rise": (80.0 + 70.0 * Proc.hashf(seedv, "sr:%d" % i)) * power,
				"dl": Proc.hashf(seedv, "sd:%d" % i) * 0.4,
			})

	func _animate(_delta: float) -> void:
		if t >= life:
			queue_free()

	func _draw() -> void:
		var u: float = clampf(t / life, 0.0, 1.0)
		var ease_out: float = 1.0 - pow(1.0 - u, 2.4)
		var fade: float = clampf(1.0 - u * u, 0.0, 1.0)
		if not petals_only:
			# the wave of light
			var r: float = 26.0 + 150.0 * ease_out * power
			draw_arc(Vector2.ZERO, r, 0.0, TAU, 40,
				Color(1.0, 0.95, 0.74, 0.5 * fade), 7.0 * fade + 1.0, true)
			draw_circle(Vector2.ZERO, r * 0.42, Color(1.0, 0.98, 0.84, 0.16 * fade))
		for item in _petals:
			var p: Dictionary = item
			var dir: Vector2 = p["dir"]
			var at: Vector2 = dir * float(p["reach"]) * ease_out
			at.y += ease_out * ease_out * 26.0
			var ang: float = float(p["spin"]) * ease_out * TAU * 0.25
			var sz: float = float(p["size"]) * (1.0 - 0.35 * u)
			var hue: float = float(p["hue"])
			var col: Color = Color.from_hsv(fposmod(0.08 + hue * 0.14, 1.0), 0.42, 1.0, 0.92 * fade)
			var pts := PackedVector2Array()
			for k in range(10):
				var a2: float = TAU * float(k) / 10.0
				var local: Vector2 = Vector2(cos(a2) * sz, sin(a2) * sz * 0.56)
				pts.append(at + local.rotated(ang))
			draw_colored_polygon(pts, col)
		for item2 in _sparks:
			var s: Dictionary = item2
			var su: float = clampf((u - float(s["dl"])) / maxf(0.1, 1.0 - float(s["dl"])), 0.0, 1.0)
			if su <= 0.0:
				continue
			var y: float = -float(s["rise"]) * su
			draw_circle(Vector2(float(s["x"]), y), 3.4 * (1.0 - su * 0.6),
				Color(1.0, 0.98, 0.82, 0.85 * (1.0 - su)))


# =============================================================================
#  _TrailMote — the "where the answer is" mote: a little golden bead with a
#  tail that drifts along an arc from the wish bubble toward the answer, then
#  dissolves. This is the entire navigation UI of the game.
# =============================================================================
class _TrailMote extends ProcNode:
	var from_p: Vector2 = Vector2.ZERO
	var to_p: Vector2 = Vector2.ZERO
	var tint: Color = Color(1.0, 0.9, 0.58)
	var delay: float = 0.0
	var life: float = 1.5
	var _u: float = 0.0

	func _on_built() -> void:
		animate_draw = true

	func _animate(_delta: float) -> void:
		var tt: float = t - delay
		if tt < 0.0:
			_u = 0.0
			return
		_u = clampf(tt / life, 0.0, 1.0)
		var ue: float = _u * _u * (3.0 - 2.0 * _u)
		var mid: Vector2 = from_p.lerp(to_p, ue)
		mid.y -= sin(_u * PI) * 58.0
		position = mid
		if _u >= 1.0:
			queue_free()

	func _draw() -> void:
		if _u <= 0.0:
			return
		var fade: float = sin(clampf(_u, 0.0, 1.0) * PI)
		var dir: Vector2 = (to_p - from_p).normalized()
		for i in range(4):
			var back: Vector2 = -dir * float(i) * 7.0
			var a: float = (0.85 - 0.2 * float(i)) * fade
			draw_circle(back, 5.4 - float(i) * 1.0, Color(tint.r, tint.g, tint.b, a))
		draw_circle(Vector2.ZERO, 2.4, Color(1, 1, 1, 0.9 * fade))
