class_name CreatureLife
extends Node2D
# CreatureLife — the dynamics system that turns placed Blocklings into the little
# PEOPLE of the island (docs/DYNAMICS.md §6.1).
#
# Everything here is diegetic. There is no panel, no list, no meter, no HUD. A
# creature's inner life is readable only from what it DOES and from the tiny drawn
# thought-bubbles it raises:
#
#   • BEHAVIOUR  — a seeded personality drives a calm state machine
#                  (idle → stroll → visit → work → carry → play → greet → sleep →
#                  shelter). They stroll the ground contour, wander out to the things
#                  their profession loves, pause to admire a flower, drift over to
#                  watch a puzzle breathe, visit the Heart Tree, curl up near the
#                  homes at dusk and huddle under cover in a storm.
#   • MOODS      — content / curious / sleepy / playful / wistful emerge from the
#                  SURROUNDINGS (a friend nearby, a new thing planted, night, care,
#                  the season) and show as a parchment thought-bubble with a drawn
#                  glyph plus a change of posture. A mood is never a problem to
#                  solve; `wistful` is an invitation, not a debuff.
#   • BONDS      — petting, feeding, tending near them and granting their wishes
#                  grow `bond ∈ [0,1]` with diminishing returns. Levels (shy →
#                  friendly → fond → devoted → kindred) unlock behaviour, wish
#                  quality, gifts, and a GENTLE, CAPPED production halo on the
#                  things they live among.
#   • FRIENDSHIP — two playful creatures that keep meeting become a kin-pair; they
#                  greet each other, a ring of petals is drawn between them once,
#                  and the pair is published for Discovery's breeding precondition.
#   • JOBS       — the existing tap-creature-then-tap-building assign becomes
#                  VISIBLE: an assigned creature walks to its workplace, works
#                  there, and carries little resource bundles home to the Heart
#                  Tree. Its profession boosts neighbours within 220 px (best two
#                  boosts per thing, hard-capped at ×1.25).
#
# Nothing here punishes, expires harshly, or demands a return at a particular
# minute. All randomness is seeded through a persisted counter and pity-timered.
# All state lives under the single top-level save key `creature_life`.
#
# PUBLIC API (the Dyn contract, docs/DYNAMICS.md §4.2 / §4.4)
#   setup(world_seed: int, ctx: Dictionary) -> void
#   catch_up(elapsed: float) -> void
#   notify(kind: String, payload: Dictionary) -> void
#   extra_actions(record: Dictionary) -> Array
#   handle_action(action: String, record: Dictionary) -> bool
#   handle_tap(screen_pos: Vector2, world_pos: Vector2) -> bool
#   bond(place_id) / bond_level(place_id) / mood(place_id)
#   bond_mult(place_id, key) / job_mult(place_id, key)
#   creatures() / nearest(world_pos, job) / avg_bond() / home_capacity()
#   + extras siblings may use: profession_near / guardian_near /
#     astral_keeper_near / kin_pairs / is_kin_pair / gather
#   signals: whisper(text), dyn_event(kind, payload)

signal whisper(text: String)
signal dyn_event(kind: String, payload: Dictionary)

# =============================================================================
# CONTRACT CONSTANTS (DYNAMICS §2 — copied, never re-invented)
# =============================================================================
const SYS_KEY := "creature_life"
const SYS_VERSION := 1

const FLOOR := 0.92
const CAP := {
	"grow": 1.60, "yield": 1.60, "bond": 2.00, "luck": 3.00,
	"cadence": 1.50, "craft": 1.50, "offline": 12.0,
}
const OFFLINE_FULL_HOURS := 8.0
const OFFLINE_CAP_HOURS := 48.0
const OFFLINE_FLOOR := 0.5

# --- simulation budget (DYNAMICS §6.1 / §8) ----------------------------------
const MAX_SIM := 24                  # creatures that fully walk/think; extras idle-animate
const LOGIC_PERIOD := 1.0            # seconds between behaviour/mood ticks
const JOB_PERIOD := 5.0              # seconds between job-boost + grow-mult recomputes
const SNAP_PERIOD := 0.5             # re-snap a standing creature's feet this often
const MAX_BUBBLES := 6               # live thought bubbles from this system
const MAX_TRAIL := 3                 # live explorer trail motes
const WHISPER_GAP := 20.0            # DYNAMICS §2.6 budget for CreatureLife

# --- movement ----------------------------------------------------------------
const SPEED_MIN := 18.0
const SPEED_MAX := 34.0
const LEG_MIN := 60.0
const LEG_MAX := 220.0
const PAUSE_MIN := 3.0
const PAUSE_MAX := 12.0
const ROAM_RADIUS := 420.0
const ROAM_RADIUS_EXPLORER := 900.0
const ARRIVE_EPS := 4.0

# --- social radii ------------------------------------------------------------
const FRIEND_RADIUS := 120.0         # close enough to play / log a meeting
const LONELY_RADIUS := 420.0         # no one within this = a wistful nudge
const CARE_RADIUS := 200.0           # a care verb this close warms a creature
const CURIOUS_RADIUS := 300.0        # a newly planted thing this close intrigues them
const JOB_RADIUS := 220.0            # a job boosts things within this
const HALO_RADIUS := 240.0           # a bond's gentle production halo
const MEETING_GAP := 600.0           # at most one meeting per pair per 10 min
const MEETINGS_FOR_PAIR := 3

# --- bonds -------------------------------------------------------------------
const BOND_XP_SCALE := 2.2           # bond = 1 - exp(-xp / 2.2)
const XP_NURTURE := 0.05
const XP_FEED := 0.09
const XP_PET := 0.03
const XP_CARE_NEAR := 0.02
const XP_WISH := 0.20
const XP_FESTIVAL := 0.08
const XP_WARM := 0.04
const XP_IDLE_PER_MIN := 0.002
const XP_PAIR := 0.05
const XP_PLAY := 0.02
const PETS_PER_DAY := 6
const BOND_HALO_CAP := 0.30
const BOND_MEMORY_KEEP := 0.5        # a returning species remembers half its bond

const LEVELS := ["shy", "friendly", "fond", "devoted", "kindred"]
const LEVEL_AT := {"shy": 0.0, "friendly": 0.20, "fond": 0.45, "devoted": 0.70, "kindred": 0.90}
const FORAGE_AT := {"shy": 1.00, "friendly": 1.08, "fond": 1.15, "devoted": 1.24, "kindred": 1.30}

# --- gifts (kindred) ---------------------------------------------------------
const GIFT_PERIOD := 600.0           # one attempt every 10 minutes
const GIFT_CHANCE := 0.06
const GIFT_PITY := 8
const GIFT_FALLBACK := ["dewdrop", "heartwood", "emberbloom", "moonsilver",
	"lichen_wool", "honeycomb", "river_clay"]

# --- moods -------------------------------------------------------------------
const MOODS := ["content", "curious", "sleepy", "playful", "wistful"]
const MOOD_GLYPH := {
	"content": "heart", "curious": "spiral", "sleepy": "zzz",
	"playful": "dots", "wistful": "leaf",
}
const MOOD_MIN_HOLD := 60.0
const MOOD_MAX_HOLD := 120.0
const MOOD_BOND_GAIN := {
	"content": 1.15, "curious": 1.05, "playful": 1.10, "sleepy": 0.95, "wistful": 1.0,
}
const MOOD_HALO := {           # how much of a bond's halo a mood lets through
	"content": 1.0, "playful": 1.0, "curious": 0.9, "wistful": 0.8, "sleepy": 0.7,
}
const WISTFUL_CARE_GAP := 2400.0     # 40 min with no care anywhere

# --- jobs: profession → (key, multiplier, which kinds it helps) --------------
# Magnitudes are the DYNAMICS §6.1 table; each is additionally scaled by bond
# (0.6 + 0.4*bond) so a trusted worker helps more, and hard-clamped at 1.25.
const JOBS := {
	"gatherer":      {"key": "yield",   "mult": 1.12, "kinds": ["tree", "plant", "fungus"]},
	"gardener":      {"key": "grow",    "mult": 1.15, "kinds": ["plant", "tree", "fungus"]},
	"miner":         {"key": "yield",   "mult": 1.12, "kinds": ["crystal", "decor"]},
	"scholar":       {"key": "luck",    "mult": 1.05, "kinds": ["*"]},
	"explorer":      {"key": "cadence", "mult": 1.10, "kinds": ["*"]},
	"artisan":       {"key": "craft",   "mult": 1.20, "kinds": ["*"]},
	"guardian":      {"key": "grow",    "mult": 1.05, "kinds": ["*"]},
	"astral_keeper": {"key": "luck",    "mult": 1.08, "kinds": ["*"]},
}
# What each profession wanders out to admire (visit targets, by placed `kind`).
const LIKES := {
	"gatherer":      ["tree", "plant"],
	"gardener":      ["plant", "fungus"],
	"miner":         ["crystal", "decor"],
	"scholar":       ["building", "puzzle"],
	"explorer":      ["edge", "puzzle"],
	"artisan":       ["decor", "building"],
	"guardian":      ["building", "creature"],
	"astral_keeper": ["crystal", "heart"],
}
const ADMIRE_GLYPH := {
	"tree": "leaf", "plant": "flower", "fungus": "sprout", "crystal": "star",
	"decor": "note", "building": "book", "creature": "heart", "puzzle": "puzzle",
	"heart": "heart", "edge": "compass",
}

const WORK_STAND_MIN := 24.0
const WORK_STAND_MAX := 64.0
const CARRY_MIN := 90.0              # seconds between bundle deliveries
const CARRY_MAX := 150.0
const DELIVER_MIN := 1.0
const DELIVER_MAX := 3.0

const PARCH := Color("#FBF6E9")
const INK := Color("#3A2E22")


# =============================================================================
# RUNTIME
# =============================================================================
var world_seed: int = 1

var _space: Node = null              # WorldSpace (duck-typed, never required)
var _interact: Node = null
var _sim: Node = null
var _puzzles: Node = null
var _sky: Node = null

var _layer: Node2D = null            # my own cam-local FX/bubble layer
var _kin: Dictionary = {}            # place_id -> _Kin (runtime only)
var _job_boosts: Dictionary = {}     # place_id -> Array[{key, mult, from}]
var _bubbles: Array = []             # live _ThoughtBubble nodes
var _trails: Array = []              # live _TrailMote nodes
var _logic_acc: float = 0.0
var _job_acc: float = 0.0
var _last_whisper: float = -999.0
var _booted := false
var _origin_cache := Vector2.ZERO
var _origin_ok := false
var _curious_until: float = 0.0      # a world-event window that makes kin curious
var _curious_at: float = 0.0         # terrain-x the interesting thing happened at
var _gather_tx: float = 0.0
var _gather_until: float = 0.0
var _scholar_acc: float = 0.0
var _pos_cache: Dictionary = {}      # place_id -> cam-local position (1 s TTL)
var _pos_cache_at: float = -999.0
var _snap: Array = []                # [{id, kind, pos, tx, fr, building_id}] once per logic tick


# =============================================================================
# THE DYN CONTRACT
# =============================================================================
func setup(seed_value: int, ctx: Dictionary) -> void:
	world_seed = seed_value
	_space = ctx.get("space", null) as Node
	_interact = ctx.get("interact", null) as Node
	_sim = ctx.get("sim", null) as Node
	_puzzles = ctx.get("puzzles", null) as Node
	_sky = ctx.get("sky", null) as Node

	_layer = Node2D.new()
	_layer.name = "CreatureLifeFX"
	_layer.z_index = 12
	add_child(_layer)

	var st: Dictionary = _st()
	_roll_day(st)
	# adopt everything already standing in the world
	for item in _records_list():
		var r: Dictionary = item
		_adopt(r)
	_booted = true
	_refresh_snap()
	_recompute_jobs()


# Boot + resume: advance the wall-clock half of every creature's life through the
# same soft offline curve the rest of the game uses. Nothing is ever lost by being
# away; a creature simply had a quiet few hours.
func catch_up(elapsed: float) -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	var eff: float = _effective(elapsed)
	if eff < 1.0:
		return
	var mins: float = eff / 60.0
	var kin_st: Dictionary = st.get("kin", {}) as Dictionary
	for key in kin_st.keys():
		var k: Dictionary = kin_st[key] as Dictionary
		# the slow, patient bond of simply living somewhere they love
		var gain: float = minf(0.25, XP_IDLE_PER_MIN * mins * _bond_gain_mult())
		k["bond_xp"] = float(k.get("bond_xp", 0.0)) + gain
		k["bond"] = _bond_from_xp(float(k["bond_xp"]))
		# naps, for the journal's sake
		k["naps"] = int(k.get("naps", 0)) + int(floor(mins / 180.0))
		k["last_tick"] = _unix()
		# kindred gift attempts that happened while away (pity-timered, never lost)
		if _bond_from_xp(float(k["bond_xp"])) >= LEVEL_AT["kindred"] and String(k.get("gift", "")) == "":
			var tries: int = clampi(int(floor(eff / GIFT_PERIOD)), 0, 6)
			for i in range(tries):
				if _roll("gift:%s:%d" % [key, i], GIFT_CHANCE, "gift", GIFT_PITY):
					k["gift"] = _pick_gift_material(key)
					break
	# a single, calm line — never a catch-up report
	if eff > 1800.0:
		_say("Your kin kept the island company while you were away.")


# Inbound sibling / world events. Everything is optional; unknown kinds are ignored.
func notify(kind: String, payload: Dictionary) -> void:
	match kind:
		"placed":
			_on_placed(payload)
		"removed":
			_on_removed(payload)
		"nurtured":
			_on_nurtured(payload)
		"harvested":
			_mark_curious(_payload_tx(payload), 60.0)
		"watered", "pruned", "fed", "warmed":
			_on_care(kind, payload)
		"tended_milestone":
			_credit_care_near(String(payload.get("place_id", "")), XP_CARE_NEAR)
		"event_started":
			_on_event(payload)
		"event_ended":
			_refresh_all_moods()
		"season_changed":
			_refresh_all_moods()
		"weather_changed":
			_refresh_all_moods()
		"gather":
			var gp: Vector2 = payload.get("pos", Vector2.ZERO) as Vector2
			gather(gp, float(payload.get("seconds", 600.0)))
		"wish_done":
			_on_wish_done(payload)
		"discovered", "hybrid", "egg", "journal_grew":
			_mark_curious(_heart_tx(), 90.0)
		"puzzle_solved":
			_on_puzzle_solved(payload)
		"migration_settled":
			_say("Someone new is walking in from the island's edge.")
		_:
			pass


# =============================================================================
# STATE  (one top-level key, every field backfilled — legacy saves just work)
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
	if not (st.get("kin") is Dictionary):
		st["kin"] = {}
	if not (st.get("play") is Dictionary):
		st["play"] = {}
	if not (st.get("mem") is Dictionary):
		st["mem"] = {}
	if not (st.get("meta") is Dictionary):
		st["meta"] = {}
	var play: Dictionary = st["play"]
	play["date"] = int(play.get("date", 0))
	play["pets"] = int(play.get("pets", 0))
	var meta: Dictionary = st["meta"]
	meta["last_care"] = float(meta.get("last_care", 0.0))
	meta["festival_until"] = float(meta.get("festival_until", 0.0))
	meta["last_gift_try"] = float(meta.get("last_gift_try", 0.0))
	return st


# Per-creature record, keyed `cl_<place_id>` exactly as the design specifies.
func _kin_st(place_id: String) -> Dictionary:
	var st: Dictionary = _st()
	if st.is_empty():
		return {}
	var all: Dictionary = st["kin"]
	var key: String = "cl_" + place_id
	if not (all.get(key) is Dictionary):
		all[key] = {}
	var k: Dictionary = all[key]
	k["species"] = String(k.get("species", ""))
	k["mood"] = String(k.get("mood", "content"))
	k["mood_until"] = float(k.get("mood_until", 0.0))
	k["bond"] = float(k.get("bond", 0.0))
	k["bond_xp"] = float(k.get("bond_xp", 0.0))
	k["job"] = String(k.get("job", ""))
	k["home_place"] = String(k.get("home_place", ""))
	k["fed_at"] = float(k.get("fed_at", 0.0))
	k["warmed_at"] = float(k.get("warmed_at", 0.0))
	if not (k.get("friends") is Dictionary):
		k["friends"] = {}
	k["naps"] = int(k.get("naps", 0))
	k["last_tick"] = float(k.get("last_tick", _unix()))
	k["home_tx"] = float(k.get("home_tx", 0.0))
	k["gift"] = String(k.get("gift", ""))
	k["festival_at"] = float(k.get("festival_at", 0.0))
	k["pets_total"] = int(k.get("pets_total", 0))
	return k


func _rand(tag: String) -> float:
	var st: Dictionary = _st()
	if st.is_empty():
		return Proc.hashf(world_seed, "%s:%s" % [SYS_KEY, tag])
	var n: int = int(st.get("seq", 0))
	st["seq"] = n + 1
	return Proc.hashf(world_seed, "%s:%s:%d" % [SYS_KEY, tag, n])


func _roll(tag: String, chance: float, pity_field: String, pity_max: int) -> bool:
	var st: Dictionary = _st()
	if st.is_empty():
		return false
	var pity: Dictionary = st["pity"]
	var n: int = int(pity.get(pity_field, 0))
	var forced: bool = n >= pity_max
	var hit: bool = forced or _rand(tag) < chance * _mult("luck", "")
	pity[pity_field] = 0 if hit else n + 1
	return hit


func _roll_day(st: Dictionary) -> void:
	if st.is_empty():
		return
	var day: int = int(floor(_unix() / 86400.0))
	var play: Dictionary = st["play"]
	if int(play.get("date", 0)) != day:
		play["date"] = day
		play["pets"] = 0


# =============================================================================
# THE SHARED MULTIPLIER FORMULA  (DYNAMICS §2.1 — one formula, clamped)
# =============================================================================
func _sib(n: String) -> Node:
	var p: Node = get_parent()
	if p == null:
		return null
	return p.get_node_or_null(NodePath(n))


func _mult(key: String, place_id: String) -> float:
	var m: float = 1.0
	var se: Node = _sib("SeasonsEvents")
	if se != null and se.has_method("modifier"):
		m *= float(se.call("modifier", key))
	var ri: Node = _sib("Rituals")
	if ri != null and ri.has_method("blessing"):
		m *= float(ri.call("blessing", key))
	var nu: Node = _sib("Nurture")
	if nu != null and nu.has_method("care_mult"):
		m *= float(nu.call("care_mult", place_id, key))
	var di: Node = _sib("Discovery")
	if di != null and di.has_method("variant_mult"):
		m *= float(di.call("variant_mult", place_id, key))
	m *= job_mult(place_id, key)
	m *= bond_mult(place_id, key)
	return clampf(m, FLOOR, float(CAP.get(key, 1.6)))


# Bond GAIN must never be multiplied by our own bond output (that would run away),
# so it reads only the world-wide sources.
func _bond_gain_mult() -> float:
	var m: float = 1.0
	var se: Node = _sib("SeasonsEvents")
	if se != null and se.has_method("modifier"):
		m *= float(se.call("modifier", "bond"))
	var ri: Node = _sib("Rituals")
	if ri != null and ri.has_method("blessing"):
		m *= float(ri.call("blessing", "bond"))
	return clampf(m, FLOOR, float(CAP["bond"]))


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
	var ri: Node = _sib("Rituals")
	if ri != null and ri.has_method("blessing"):
		var b: float = float(ri.call("blessing", "offline"))
		if b > 1.5:                       # Rituals reports hours for this key
			return clampf(b, OFFLINE_FULL_HOURS, float(CAP["offline"]))
	return OFFLINE_FULL_HOURS


# =============================================================================
# READ-ONLY QUERY SURFACE  (DYNAMICS §4.4)
# =============================================================================
func bond(place_id: String) -> float:
	var st: Dictionary = _st()
	if st.is_empty():
		return 0.0
	var all: Dictionary = st["kin"]
	var k: Variant = all.get("cl_" + place_id, null)
	if k is Dictionary:
		return clampf(float((k as Dictionary).get("bond", 0.0)), 0.0, 1.0)
	return 0.0


func bond_level(place_id: String) -> String:
	return _level_for(bond(place_id))


func mood(place_id: String) -> String:
	var st: Dictionary = _st()
	if st.is_empty():
		return "content"
	var all: Dictionary = st["kin"]
	var k: Variant = all.get("cl_" + place_id, null)
	if k is Dictionary:
		return String((k as Dictionary).get("mood", "content"))
	return "content"


# A creature's own forage bonus (+30% at kindred, exactly the cap), and for a NON
# creature thing the gentle, capped halo of the bonded kin living around it.
func bond_mult(place_id: String, key: String) -> float:
	if place_id == "":
		# world-wide: only cadence responds (a curious island asks more questions)
		if key == "cadence":
			for pid in _kin.keys():
				var kk: _Kin = _kin[pid]
				if kk.mood == "curious":
					return 1.20
		return 1.0
	if _kin.has(place_id):
		if key == "yield" or key == "bond":
			return clampf(1.0 + 0.30 * bond(place_id), 1.0, 1.30)
		return 1.0
	if key != "yield" and key != "grow":
		return 1.0
	var pos: Vector2 = _pos_of_place(place_id)
	if pos.x == INF:
		return 1.0
	var sum: float = 0.0
	for pid in _kin.keys():
		var k: _Kin = _kin[pid]
		if not is_instance_valid(k.node):
			continue
		if k.node.position.distance_to(pos) > HALO_RADIUS:
			continue
		var b: float = bond(pid)
		if b < 0.05:
			continue
		var per: float = (0.05 if b >= LEVEL_AT["fond"] else 0.02)
		sum += per * b * float(MOOD_HALO.get(k.mood, 1.0))
	if key == "grow":
		sum *= 0.5
	return clampf(1.0 + minf(sum, BOND_HALO_CAP), 1.0, 1.30)


# The best TWO job boosts for this key on this thing, clamped at ×1.25.
func job_mult(place_id: String, key: String) -> float:
	if place_id == "":
		return 1.0
	var list: Variant = _job_boosts.get(place_id, null)
	if not (list is Array):
		return 1.0
	var mags: Array = []
	for item in (list as Array):
		var b: Dictionary = item
		if String(b.get("key", "")) != key:
			continue
		mags.append(float(b.get("mult", 1.0)))
	if mags.is_empty():
		return 1.0
	mags.sort()
	mags.reverse()
	var m: float = 1.0
	var n: int = mini(2, mags.size())
	for i in range(n):
		m *= float(mags[i])
	return clampf(m, FLOOR, 1.25)


func creatures() -> Array:
	var out: Array = []
	for pid in _kin.keys():
		var k: _Kin = _kin[pid]
		if not is_instance_valid(k.node):
			continue
		out.append({
			"place_id": pid, "species": k.species, "job": k.profession,
			"bond": bond(pid), "pos": k.node.position, "mood": k.mood,
			"state": k.state, "name": k.pretty,
		})
	return out


func nearest(world_pos: Vector2, job: String = "") -> Dictionary:
	var best: Dictionary = {}
	var best_d: float = INF
	for pid in _kin.keys():
		var k: _Kin = _kin[pid]
		if not is_instance_valid(k.node):
			continue
		if job != "" and k.profession != job:
			continue
		var d: float = k.node.position.distance_to(world_pos)
		if d < best_d:
			best_d = d
			best = {"place_id": pid, "species": k.species, "job": k.profession,
				"bond": bond(pid), "pos": k.node.position, "dist": d, "name": k.pretty}
	return best


func avg_bond() -> float:
	if _kin.is_empty():
		return 0.0
	var s: float = 0.0
	for pid in _kin.keys():
		s += bond(pid)
	return s / float(_kin.size())


# Room for new kin: 2 per placed Blockling Homes (the building's own
# `special.per_level`), plus the one the Heart Tree always shelters.
func home_capacity() -> int:
	var cap: int = 1
	var per: int = 2
	if GameData != null and GameData.buildings_by_id.has("blockling_homes"):
		var bd: Dictionary = GameData.buildings_by_id["blockling_homes"] as Dictionary
		var sp: Dictionary = bd.get("special", {}) as Dictionary
		per = int(sp.get("per_level", 2))
	for item in _records_list():
		var r: Dictionary = item
		var entry: Dictionary = r.get("entry", {}) as Dictionary
		if String(entry.get("building_id", "")) == "blockling_homes":
			cap += per
	return maxi(0, cap - _kin.size())


# --- extras siblings may ask (all optional, all guarded on their side) -------
func profession_near(world_pos: Vector2, profession: String, radius: float = JOB_RADIUS) -> bool:
	for pid in _kin.keys():
		var k: _Kin = _kin[pid]
		if k.profession != profession or not is_instance_valid(k.node):
			continue
		if k.node.position.distance_to(world_pos) <= radius:
			return true
	return false


func guardian_near(world_pos: Vector2) -> bool:
	return profession_near(world_pos, "guardian", JOB_RADIUS)


func astral_keeper_near(world_pos: Vector2) -> bool:
	return profession_near(world_pos, "astral_keeper", JOB_RADIUS)


func kin_pairs() -> Array:
	var out: Array = []
	var seen: Dictionary = {}
	var st: Dictionary = _st()
	if st.is_empty():
		return out
	var all: Dictionary = st["kin"]
	for key in all.keys():
		var k: Dictionary = all[key] as Dictionary
		var a: String = String(key).substr(3)
		var friends: Dictionary = k.get("friends", {}) as Dictionary
		for b in friends.keys():
			var f: Dictionary = friends[b] as Dictionary
			if not bool(f.get("kin", false)):
				continue
			var pair: String = a + "|" + String(b)
			if String(b) < a:
				pair = String(b) + "|" + a
			if seen.has(pair):
				continue
			seen[pair] = true
			out.append({"a": a, "b": String(b), "meetings": int(f.get("meetings", 0))})
	return out


func is_kin_pair(a: String, b: String) -> bool:
	var k: Dictionary = _kin_st(a)
	if k.is_empty():
		return false
	var friends: Dictionary = k.get("friends", {}) as Dictionary
	var f: Variant = friends.get(b, null)
	return f is Dictionary and bool((f as Dictionary).get("kin", false))


# A festival (or any sibling) may ask everyone to come together somewhere.
func gather(world_pos: Vector2, seconds: float = 600.0) -> void:
	_gather_tx = _tx_of(world_pos)
	_gather_until = _t_now() + maxf(10.0, seconds)
	for pid in _kin.keys():
		var k: _Kin = _kin[pid]
		k.state = "idle"
		k.state_until = 0.0


# =============================================================================
# ADOPTION / RELEASE
# =============================================================================
func _on_placed(payload: Dictionary) -> void:
	var rec: Dictionary = payload
	if payload.has("record") and payload["record"] is Dictionary:
		rec = payload["record"] as Dictionary
	_pos_cache_at = -999.0
	var entry: Dictionary = rec.get("entry", {}) as Dictionary
	if String(entry.get("kind", "")) == "creature":
		_adopt(rec)
		return
	# something new and interesting appeared: nearby kin perk up
	var node: Variant = rec.get("node", null)
	if node is Node2D:
		_mark_curious(_tx_of((node as Node2D).position), 180.0)


func _on_removed(payload: Dictionary) -> void:
	var pid: String = String(payload.get("place_id", ""))
	if pid == "" or not _kin.has(pid):
		return
	var k: _Kin = _kin[pid]
	# remember the bond so a creature put back later is not a stranger
	var st: Dictionary = _st()
	if not st.is_empty() and k.species != "":
		var mem: Dictionary = st["mem"]
		var kst: Dictionary = _kin_st(pid)
		var xp: float = float(kst.get("bond_xp", 0.0))
		mem[k.species] = maxf(float(mem.get(k.species, 0.0)), xp)
	_drop_bubble(k)
	if is_instance_valid(k.carry):
		k.carry.queue_free()
	_restore_posture(k)
	_kin.erase(pid)
	_job_boosts.clear()
	_pos_cache_at = -999.0


func _adopt(record: Dictionary) -> void:
	var entry: Dictionary = record.get("entry", {}) as Dictionary
	if String(entry.get("kind", "")) != "creature":
		return
	var pid: String = String(record.get("id", ""))
	if pid == "" or _kin.has(pid):
		return
	var node_v: Variant = record.get("node", null)
	if not is_instance_valid(node_v) or not (node_v is ProcNode):
		return
	var node: ProcNode = node_v

	var species: String = String(entry.get("species", ""))
	if species == "" or species == "random":
		species = String(node.get("bl_id")) if _has_prop(node, "bl_id") else ""
	var data: Dictionary = {}
	if GameData != null and GameData.blocklings_by_id.has(species):
		data = GameData.blocklings_by_id[species] as Dictionary

	var k := _Kin.new()
	k.pid = pid
	k.node = node
	k.species = species
	k.profession = String(data.get("profession", "gatherer"))
	k.pretty = String(data.get("name", ItemCatalog.display_label(entry)))
	k.rarity = String(data.get("rarity", "common"))
	k.footprint = float(record.get("footprint", 34.0))
	k.speed = Proc.rangef(world_seed, "spd:" + pid, SPEED_MIN, SPEED_MAX)
	k.base_rot = node.rotation
	k.base_scale = node.scale
	k.dir = 1.0 if Proc.hashf(world_seed, "dir:" + pid) > 0.5 else -1.0
	var likes: Array = LIKES.get(k.profession, ["plant"]) as Array
	k.likes = likes.duplicate()
	k.roam = ROAM_RADIUS_EXPLORER if k.profession == "explorer" else ROAM_RADIUS

	var kst: Dictionary = _kin_st(pid)
	if String(kst.get("species", "")) == "":
		kst["species"] = species
		kst["home_tx"] = float(record.get("tx", _tx_of(node.position)))
		# a species we have loved before comes back already a little fond
		var st: Dictionary = _st()
		if not st.is_empty():
			var mem: Dictionary = st["mem"]
			var remembered: float = float(mem.get(species, 0.0))
			if remembered > 0.0:
				kst["bond_xp"] = remembered * BOND_MEMORY_KEEP
				kst["bond"] = _bond_from_xp(float(kst["bond_xp"]))
		kst["tx"] = float(record.get("tx", _tx_of(node.position)))
	k.home_tx = float(kst.get("home_tx", _tx_of(node.position)))
	k.tx = float(kst.get("tx", _tx_of(node.position)))
	k.target_tx = k.tx
	k.mood = String(kst.get("mood", "content"))
	k.job_place = String(kst.get("home_place", ""))
	k.carry_at = _t_now() + Proc.rangef(world_seed, "carry0:" + pid, 20.0, CARRY_MAX)
	k.mood_next = _t_now() + Proc.rangef(world_seed, "mood0:" + pid, 4.0, 40.0)
	k.snap_at = 0.0

	_kin[pid] = k
	node.position = _ground_point(k.tx)
	_apply_level_cue(k)


# =============================================================================
# TICK  (1 s logic, per-frame movement only)
# =============================================================================
func _process(delta: float) -> void:
	if not _booted or Game == null or not Game.booted:
		return
	_move_all(delta)
	_follow_bubbles()
	_logic_acc += delta
	if _logic_acc >= LOGIC_PERIOD:
		var step: float = _logic_acc
		_logic_acc = 0.0
		_logic(step)
	_job_acc += delta
	if _job_acc >= JOB_PERIOD:
		_job_acc = 0.0
		_recompute_jobs()
		_apply_grow_mults()


func _logic(step: float) -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	_roll_day(st)
	_prune_fx()
	_refresh_snap()
	var now: float = _t_now()
	var i: int = 0
	for pid in _kin.keys():
		var k: _Kin = _kin[pid]
		if not is_instance_valid(k.node):
			continue
		i += 1
		if i > MAX_SIM:
			continue                        # beyond the budget they just idle-animate
		if now >= k.mood_next:
			_update_mood(k)
		if now >= k.state_until:
			_choose_state(k)
		_accrue_idle_bond(k, step)
		_tick_work(k, now)
	_tick_friendships(now)
	_tick_gifts(now)
	_tick_scholar(step)
	_persist_positions()


# --- behaviour ---------------------------------------------------------------
func _choose_state(k: _Kin) -> void:
	var now: float = _t_now()
	# 1. shelter from a storm — cover first, always
	if _weather() == "storm":
		var cover: float = _nearest_kind_tx(k, ["building", "tree"])
		if cover != INF:
			_enter(k, "shelter", cover, Proc.rangef(world_seed, "sh:%s:%d" % [k.pid, int(now)], 20.0, 50.0))
			_maybe_bubble(k, "droplet", 0.35)
			return
	# 2. a festival / gather request wins over private plans
	if now < _gather_until:
		_enter(k, "play", _gather_tx + Proc.rangef(world_seed, "gx:" + k.pid, -90.0, 90.0), 14.0)
		_maybe_bubble(k, "dots", 0.3)
		return
	# 3. dusk: walk to the homes (else the Heart Tree's roots) and curl up there
	if _is_night():
		var bed: float = _nearest_kind_tx(k, ["building"])
		if bed == INF:
			bed = _heart_tx() + Proc.rangef(world_seed, "bed:" + k.pid, -110.0, 110.0)
		if absf(bed - k.tx) > ARRIVE_EPS:
			_enter(k, "bedward", bed, 150.0)
		else:
			_enter(k, "sleep", k.tx, 120.0)
		return
	# 4. a job: be at work, and now and then carry something home
	if k.job_place != "":
		var wp: Vector2 = _pos_of_place(k.job_place)
		if wp != Vector2.INF:
			if now >= k.carry_at and _t_now() - k.delivered_at > CARRY_MIN:
				_begin_carry(k)
				return
			_enter(k, "work", _tx_of(wp) + k.dir * (k.footprint + 18.0),
				Proc.rangef(world_seed, "wk:%s:%d" % [k.pid, int(now)], WORK_STAND_MIN, WORK_STAND_MAX))
			return
		k.job_place = ""
	# 5. a friend close by and both in the mood → play together
	if k.mood == "playful":
		var mate: _Kin = _nearest_playful(k)
		if mate != null:
			_enter(k, "greet", mate.tx + (18.0 if mate.tx < k.tx else -18.0), 7.0)
			return
	# 6. otherwise: wander, or set out to admire something they love
	var roll: float = _rand("plan:" + k.pid)
	if roll < 0.42:
		var tgt: float = _pick_visit(k)
		if tgt != INF:
			_enter(k, "visit", tgt, 30.0)
			return
	if roll < 0.88:
		var leg: float = Proc.rangef(world_seed, "leg:%s:%d" % [k.pid, int(now)], LEG_MIN, LEG_MAX)
		var dir: float = 1.0 if _rand("legdir:" + k.pid) > 0.5 else -1.0
		var want: float = clampf(k.tx + dir * leg, k.home_tx - k.roam, k.home_tx + k.roam)
		_enter(k, "stroll", want, 40.0)
		return
	_enter(k, "idle", k.tx, Proc.rangef(world_seed, "idl:%s:%d" % [k.pid, int(now)], PAUSE_MIN, PAUSE_MAX))


func _enter(k: _Kin, state: String, target_tx: float, seconds: float) -> void:
	var was: String = k.state
	k.state = state
	k.target_tx = _clamp_tx(target_tx)
	k.state_until = _t_now() + maxf(1.0, seconds)
	k.admire_said = false
	if was == "sleep" and state != "sleep":
		_restore_posture(k)
	_apply_posture(k)


func _pick_visit(k: _Kin) -> float:
	# the things this personality is drawn to, nearest-first within its roam
	var want: Array = k.likes
	var pick: float = INF
	var pick_kind: String = ""
	var best: float = INF
	for w in want:
		var kind: String = String(w)
		var tx: float = INF
		match kind:
			"edge":
				var span: Vector2 = _ground_span()
				tx = (span.y - 40.0) if k.dir > 0.0 else (span.x + 40.0)
			"heart":
				tx = _heart_tx() + Proc.rangef(world_seed, "ht:" + k.pid, -90.0, 90.0)
			"puzzle":
				tx = _nearest_puzzle_tx(k)
			_:
				tx = _nearest_kind_tx(k, [kind])
		if tx == INF:
			continue
		var d: float = absf(tx - k.tx)
		if d < best:
			best = d
			pick = tx
			pick_kind = kind
	if pick == INF:
		return INF
	if absf(pick - k.home_tx) > k.roam * 1.4:
		return INF
	k.admire_glyph = String(ADMIRE_GLYPH.get(pick_kind, "flower"))
	return pick


func _move_all(delta: float) -> void:
	var i: int = 0
	for pid in _kin.keys():
		var k: _Kin = _kin[pid]
		if not is_instance_valid(k.node):
			continue
		i += 1
		if i > MAX_SIM:
			continue
		var d: float = k.target_tx - k.tx
		if absf(d) > ARRIVE_EPS and k.state != "sleep":
			var want_dir: float = signf(d)
			var pace: float = k.speed * (0.8 if k.state == "bedward" else 1.0)
			if k.state == "greet" or k.state == "carry" or k.state == "deliver":
				pace *= 1.18
			k.tx += want_dir * pace * delta
			if absf(k.target_tx - k.tx) < ARRIVE_EPS:
				k.tx = k.target_tx
			k.node.position = _ground_point(k.tx)
			_face(k, want_dir)
			k.walking = true
			k.snap_at = 0.0
		else:
			if k.walking:
				k.walking = false
				_on_arrive(k)
			# a standing creature still needs its feet on the (possibly grown) ground
			if _t_now() >= k.snap_at:
				k.snap_at = _t_now() + SNAP_PERIOD
				k.node.position = _ground_point(k.tx)
			_idle_posture(k, delta)


func _on_arrive(k: _Kin) -> void:
	match k.state:
		"visit":
			if not k.admire_said:
				k.admire_said = true
				_maybe_bubble(k, k.admire_glyph, 0.55)
		"carry":
			_deliver(k)
		"deliver":
			k.state = "work"
			k.state_until = _t_now() + 6.0
		"greet":
			_greet_here(k)
		"bedward":
			k.state = "sleep"
			k.state_until = _t_now() + 120.0
			k.zzz_at = _t_now() + 6.0
			_apply_posture(k)
		"shelter":
			_maybe_bubble(k, "droplet", 0.25)
		_:
			pass


# --- posture: the body language of a mood -----------------------------------
func _apply_posture(k: _Kin) -> void:
	if not is_instance_valid(k.node):
		return
	var lean: float = 0.0
	match k.state:
		"sleep":
			lean = 0.10
			if not k.sleeping:
				# capture the rest pose ONCE, so a graphics/variant owner may still
				# re-scale this node freely and our breathing follows it
				k.base_scale = k.node.scale
				k.sleeping = true
		"shelter":
			lean = -0.06
		_:
			match k.mood:
				"sleepy": lean = 0.06
				"wistful": lean = -0.05
				"curious": lean = 0.03
				_: lean = 0.0
	k.node.rotation = k.base_rot + lean * (1.0 if k.dir > 0.0 else -1.0)


func _idle_posture(k: _Kin, _delta: float) -> void:
	if not is_instance_valid(k.node):
		return
	if k.state == "sleep":
		# a slow, deep breathing — the only place we touch scale, and we always
		# re-read the base so a variant/graphics owner can still re-scale freely
		var br: float = sin(_t_now() * 0.9 + k.phase_of()) * 0.014
		k.node.scale = Vector2(k.base_scale.x * (1.0 + br), k.base_scale.y * (1.0 - br))
		if _t_now() >= k.zzz_at:
			k.zzz_at = _t_now() + Proc.rangef(world_seed, "zzz:%s:%d" % [k.pid, int(_t_now())], 20.0, 32.0)
			_maybe_bubble(k, "zzz", 1.0)
			var kst: Dictionary = _kin_st(k.pid)
			kst["naps"] = int(kst.get("naps", 0)) + 1


func _restore_posture(k: _Kin) -> void:
	k.sleeping = false
	if not is_instance_valid(k.node):
		return
	k.node.scale = k.base_scale
	k.node.rotation = k.base_rot


func _face(k: _Kin, dir: float) -> void:
	if dir == 0.0 or absf(dir - k.dir) < 0.01:
		return
	if _t_now() - k.face_at < 0.45:
		return
	k.face_at = _t_now()
	k.dir = signf(dir)
	if is_instance_valid(k.node) and k.node.has_method("set_facing"):
		k.node.call("set_facing", k.dir)


# =============================================================================
# MOODS  (emergent, from the surroundings — never a problem to solve)
# =============================================================================
func _update_mood(k: _Kin) -> void:
	var now: float = _t_now()
	k.mood_next = now + Proc.rangef(world_seed, "mh:%s:%d" % [k.pid, int(now)], MOOD_MIN_HOLD, MOOD_MAX_HOLD)
	var was: String = k.mood
	var next: String = _sense_mood(k)
	if next == was:
		return
	k.mood = next
	var kst: Dictionary = _kin_st(k.pid)
	kst["mood"] = next
	kst["mood_until"] = _unix() + (k.mood_next - now)
	_apply_posture(k)
	_maybe_bubble(k, String(MOOD_GLYPH.get(next, "heart")), 0.8)
	dyn_event.emit("mood", {"place_id": k.pid, "mood": next})


func _sense_mood(k: _Kin) -> String:
	var st: Dictionary = _st()
	var now_u: float = _unix()
	var kst: Dictionary = _kin_st(k.pid)
	# a festival, or a full belly, is simple happiness
	if not st.is_empty():
		var meta: Dictionary = st["meta"]
		if now_u < float(meta.get("festival_until", 0.0)):
			return "playful" if _rand("fm:" + k.pid) > 0.4 else "content"
	if now_u - float(kst.get("fed_at", 0.0)) < 600.0:
		return "content"
	# a friend within arm's reach
	if _count_near(k, FRIEND_RADIUS) > 0:
		return "playful"
	# night, or a very long sitting
	if _is_night():
		return "sleepy"
	# something new nearby
	if _t_now() < _curious_until and absf(_curious_at - k.tx) < CURIOUS_RADIUS:
		return "curious"
	# nobody around and nothing tended for a long while — an invitation, not a debuff
	var last_care: float = 0.0
	if not st.is_empty():
		var meta2: Dictionary = st["meta"]
		last_care = float(meta2.get("last_care", 0.0))
	var lonely: bool = _count_near(k, LONELY_RADIUS) == 0
	if (last_care > 0.0 and now_u - last_care > WISTFUL_CARE_GAP) or (lonely and _season_id() == "emberfall"):
		return "wistful"
	if _season_id() == "greenrise" and _rand("gr:" + k.pid) > 0.6:
		return "curious"
	return "content"


func _refresh_all_moods() -> void:
	for pid in _kin.keys():
		var k: _Kin = _kin[pid]
		k.mood_next = 0.0


func _count_near(k: _Kin, radius: float) -> int:
	var n: int = 0
	for pid in _kin.keys():
		if pid == k.pid:
			continue
		var o: _Kin = _kin[pid]
		if not is_instance_valid(o.node) or not is_instance_valid(k.node):
			continue
		if o.node.position.distance_to(k.node.position) <= radius:
			n += 1
	return n


# =============================================================================
# BONDS
# =============================================================================
func _bond_from_xp(xp: float) -> float:
	return clampf(1.0 - exp(-maxf(0.0, xp) / BOND_XP_SCALE), 0.0, 1.0)


func _level_for(b: float) -> String:
	var out: String = "shy"
	for lv in LEVELS:
		if b >= float(LEVEL_AT[lv]):
			out = String(lv)
	return out


func _add_bond(place_id: String, xp: float, reason: String) -> void:
	if place_id == "" or xp <= 0.0:
		return
	var kst: Dictionary = _kin_st(place_id)
	if kst.is_empty():
		return
	var mood_mult: float = 1.0
	if _kin.has(place_id):
		var k: _Kin = _kin[place_id]
		mood_mult = float(MOOD_BOND_GAIN.get(k.mood, 1.0))
	var before: float = float(kst.get("bond", 0.0))
	var lv_before: String = _level_for(before)
	kst["bond_xp"] = float(kst.get("bond_xp", 0.0)) + xp * mood_mult * _bond_gain_mult()
	var after: float = _bond_from_xp(float(kst["bond_xp"]))
	kst["bond"] = after
	dyn_event.emit("bond_up", {"place_id": place_id, "bond": after, "level": _level_for(after)})
	var lv_after: String = _level_for(after)
	if lv_after != lv_before:
		_on_level_up(place_id, lv_after, reason)


func _on_level_up(place_id: String, level: String, _reason: String) -> void:
	if _kin.has(place_id):
		var k: _Kin = _kin[place_id]
		_apply_level_cue(k)
		_maybe_bubble(k, "heart", 1.0)
		match level:
			"friendly":
				_say("%s has decided you are alright." % k.pretty)
			"fond":
				_say("%s is fond of you now." % k.pretty)
			"devoted":
				_say("%s would follow you anywhere." % k.pretty)
			"kindred":
				_say("%s is kindred — they will start bringing you things." % k.pretty)
			_:
				pass


# A kindred creature wears a soft, low-opacity bloom. Nothing else is adorned, so
# the island never looks like a Christmas tree (DYNAMICS §7.4).
func _apply_level_cue(k: _Kin) -> void:
	if not is_instance_valid(k.node):
		return
	var want: bool = bond(k.pid) >= float(LEVEL_AT["kindred"])
	if want and not is_instance_valid(k.halo):
		var ring: ProcNode = ProcEffects.make_selection_ring(world_seed, "kindred:" + k.pid, {
			"radius": k.footprint * 1.15, "style": "bloom", "ground": true, "z": -1,
			"color": Color(1.0, 0.92, 0.70), "strength": 0.45})
		ring.modulate.a = 0.42
		k.node.add_child(ring)
		k.halo = ring
	elif not want and is_instance_valid(k.halo):
		if k.halo.has_method("fade_out"):
			k.halo.call("fade_out", 0.4)
		k.halo = null


func _accrue_idle_bond(k: _Kin, step: float) -> void:
	# simply living beside a thing of their favourite kind is its own slow affection
	if k.state != "visit" and k.state != "work" and k.state != "idle":
		return
	var near_liked: bool = false
	for item in _snap:
		var s: Dictionary = item
		if not k.likes.has(String(s.get("kind", ""))):
			continue
		var p: Vector2 = s.get("pos", Vector2.ZERO) as Vector2
		if p.distance_to(k.node.position) < 120.0:
			near_liked = true
			break
	if near_liked:
		_add_bond(k.pid, XP_IDLE_PER_MIN * (step / 60.0), "dwell")


func _on_nurtured(payload: Dictionary) -> void:
	var rec: Dictionary = payload
	if payload.has("record") and payload["record"] is Dictionary:
		rec = payload["record"] as Dictionary
	var pid: String = String(rec.get("id", payload.get("place_id", "")))
	var entry: Dictionary = rec.get("entry", {}) as Dictionary
	_touch_care()
	if String(entry.get("kind", "")) == "creature" and _kin.has(pid):
		_add_bond(pid, XP_NURTURE, "nurture")
		var k: _Kin = _kin[pid]
		k.mood = "content"
		_kin_st(pid)["mood"] = "content"
		_maybe_bubble(k, "heart", 1.0)
		return
	_credit_care_near(pid, XP_CARE_NEAR)


func _on_care(verb: String, payload: Dictionary) -> void:
	_touch_care()
	var pid: String = String(payload.get("place_id", ""))
	var entry: Dictionary = payload.get("entry", {}) as Dictionary
	if String(entry.get("kind", "")) == "creature" and _kin.has(pid):
		var kst: Dictionary = _kin_st(pid)
		match verb:
			"fed":
				kst["fed_at"] = _unix()
				_add_bond(pid, XP_FEED, "feed")
			"warmed":
				kst["warmed_at"] = _unix()
				_add_bond(pid, XP_WARM, "warm")
			_:
				_add_bond(pid, XP_CARE_NEAR, verb)
		var k: _Kin = _kin[pid]
		k.mood = "content"
		kst["mood"] = "content"
		_maybe_bubble(k, "heart", 1.0)
		return
	_credit_care_near(pid, XP_CARE_NEAR)


# Any care done near a creature warms it a little, and a gardener standing by
# takes it personally.
func _credit_care_near(place_id: String, xp: float) -> void:
	var at: Vector2 = _pos_of_place(place_id)
	if at == Vector2.INF:
		return
	for pid in _kin.keys():
		var k: _Kin = _kin[pid]
		if not is_instance_valid(k.node):
			continue
		if k.node.position.distance_to(at) > CARE_RADIUS:
			continue
		var gain: float = xp * (1.4 if k.profession == "gardener" else 1.0)
		_add_bond(pid, gain, "care_near")
		k.mood = "content"
		_kin_st(pid)["mood"] = "content"


func _touch_care() -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	var meta: Dictionary = st["meta"]
	meta["last_care"] = _unix()


func _on_wish_done(payload: Dictionary) -> void:
	var giver: String = String(payload.get("giver", ""))
	if giver != "" and _kin.has(giver):
		_add_bond(giver, XP_WISH, "wish")
		var k: _Kin = _kin[giver]
		_maybe_bubble(k, "star", 1.0)


func _on_event(payload: Dictionary) -> void:
	var kind: String = String(payload.get("kind", ""))
	match kind:
		"festival":
			var st: Dictionary = _st()
			if not st.is_empty():
				var meta: Dictionary = st["meta"]
				meta["festival_until"] = float(payload.get("ends", _unix() + 5400.0))
			for pid in _kin.keys():
				var kst: Dictionary = _kin_st(pid)
				if _unix() - float(kst.get("festival_at", 0.0)) > 3600.0:
					kst["festival_at"] = _unix()
					_add_bond(pid, XP_FESTIVAL, "festival")
				kst["mood"] = "content"
				var k: _Kin = _kin[pid]
				k.mood = "content"
			gather(_ground_point(_heart_tx()), 900.0)
			_say("Lanterns, and everyone walking toward the tree.")
		"meteor", "aurora", "merchant", "migration":
			_mark_curious(_heart_tx(), 240.0)
		_:
			_refresh_all_moods()


func _on_puzzle_solved(payload: Dictionary) -> void:
	var pid: String = String(payload.get("id", ""))
	var at: float = _puzzle_tx_by_id(pid)
	_mark_curious(at if at != INF else _heart_tx(), 240.0)
	for k_pid in _kin.keys():
		var k: _Kin = _kin[k_pid]
		if at == INF or not is_instance_valid(k.node):
			continue
		if absf(k.tx - at) < CURIOUS_RADIUS:
			_add_bond(k_pid, XP_CARE_NEAR, "puzzle")
			_maybe_bubble(k, "puzzle", 0.5)


func _mark_curious(tx: float, seconds: float) -> void:
	if tx == INF:
		return
	_curious_at = tx
	_curious_until = _t_now() + seconds
	for pid in _kin.keys():
		var k: _Kin = _kin[pid]
		if absf(k.tx - tx) < CURIOUS_RADIUS:
			k.mood_next = 0.0


# =============================================================================
# FRIENDSHIPS
# =============================================================================
func _nearest_playful(k: _Kin) -> _Kin:
	var best: _Kin = null
	var best_d: float = FRIEND_RADIUS * 2.2
	for pid in _kin.keys():
		if pid == k.pid:
			continue
		var o: _Kin = _kin[pid]
		if o.mood != "playful" or not is_instance_valid(o.node) or not is_instance_valid(k.node):
			continue
		var d: float = absf(o.tx - k.tx)
		if d < best_d:
			best_d = d
			best = o
	return best


func _greet_here(k: _Kin) -> void:
	var mate: _Kin = _nearest_playful(k)
	if mate == null:
		return
	if absf(mate.tx - k.tx) > FRIEND_RADIUS:
		return
	_maybe_bubble(k, "dots", 0.6)
	_add_bond(k.pid, XP_PLAY, "play")
	_log_meeting(k, mate)


func _tick_friendships(now: float) -> void:
	var keys: Array = _kin.keys()
	for a in range(keys.size()):
		var ka: _Kin = _kin[keys[a]]
		if ka.mood != "playful" or not is_instance_valid(ka.node):
			continue
		for b in range(a + 1, keys.size()):
			var kb: _Kin = _kin[keys[b]]
			if kb.mood != "playful" or not is_instance_valid(kb.node):
				continue
			if ka.node.position.distance_to(kb.node.position) > FRIEND_RADIUS:
				continue
			_log_meeting(ka, kb)
	# gently expire the gather window
	if _gather_until > 0.0 and now > _gather_until:
		_gather_until = 0.0


func _log_meeting(a: _Kin, b: _Kin) -> void:
	var sa: Dictionary = _kin_st(a.pid)
	var sb: Dictionary = _kin_st(b.pid)
	if sa.is_empty() or sb.is_empty():
		return
	var fa: Dictionary = sa["friends"]
	var rec: Dictionary = fa.get(b.pid, {}) as Dictionary
	var last: float = float(rec.get("last", 0.0))
	if _unix() - last < MEETING_GAP:
		return
	var n: int = int(rec.get("meetings", 0)) + 1
	var was_kin: bool = bool(rec.get("kin", false))
	var is_kin: bool = was_kin or n >= MEETINGS_FOR_PAIR
	fa[b.pid] = {"meetings": n, "last": _unix(), "kin": is_kin}
	var fb: Dictionary = sb["friends"]
	var rb: Dictionary = fb.get(a.pid, {}) as Dictionary
	fb[a.pid] = {"meetings": maxi(n, int(rb.get("meetings", 0))), "last": _unix(), "kin": is_kin}
	dyn_event.emit("friendship", {"a": a.pid, "b": b.pid, "meetings": n})
	if is_kin and not was_kin:
		_add_bond(a.pid, XP_PAIR, "pair")
		_add_bond(b.pid, XP_PAIR, "pair")
		_petals_between(a, b)
		_say("%s and %s have become friends." % [a.pretty, b.pretty])


# =============================================================================
# JOBS  (the assign mechanic, finally visible)
# =============================================================================
# Jobs are discovered the way everything else in this game is: by looking at the
# world. A creature standing at a building IS working there — which is exactly what
# the existing tap-creature → tap-building assign leaves behind. No hook needed.
func _tick_work(k: _Kin, now: float) -> void:
	if k.state == "carry" or k.state == "deliver":
		return
	var found: String = ""
	for item in _snap:
		var s: Dictionary = item
		if String(s.get("kind", "")) != "building":
			continue
		var fr: float = float(s.get("fr", 40.0))
		var p: Vector2 = s.get("pos", Vector2.ZERO) as Vector2
		if p.distance_to(k.node.position) <= fr * 1.5 + 24.0:
			found = String(s.get("id", ""))
			break
	if found != "" and found != k.job_place:
		k.job_place = found
		var kst: Dictionary = _kin_st(k.pid)
		kst["home_place"] = found
		kst["job"] = k.profession
		k.carry_at = now + Proc.rangef(world_seed, "c1:%s:%d" % [k.pid, int(now)], CARRY_MIN, CARRY_MAX)
		dyn_event.emit("job_set", {"place_id": k.pid, "job": k.profession})
		_maybe_bubble(k, _job_glyph(k.profession), 0.7)


func _job_glyph(profession: String) -> String:
	match profession:
		"gatherer": return "bundle"
		"gardener": return "flower"
		"miner": return "star"
		"scholar": return "book"
		"explorer": return "compass"
		"artisan": return "note"
		"guardian": return "shield"
		"astral_keeper": return "star"
		_: return "bundle"


func _begin_carry(k: _Kin) -> void:
	var wp: Vector2 = _pos_of_place(k.job_place)
	if wp == Vector2.INF:
		k.job_place = ""
		return
	k.carry_res = _res_of_place(k.job_place)
	if is_instance_valid(k.carry):
		k.carry.queue_free()
	var bundle := _Bundle.new()
	bundle.seedv = hash("%d:bundle:%s" % [world_seed, k.pid])
	bundle.res = k.carry_res
	bundle.reach = k.footprint
	bundle.side = k.dir
	bundle.z_index = 2
	bundle.position = Vector2(k.dir * k.footprint * 0.62, -k.footprint * 1.18)
	k.node.add_child(bundle)
	bundle.pop_in(0.4)
	k.carry = bundle
	_enter(k, "carry", _heart_tx() + Proc.rangef(world_seed, "hc:" + k.pid, -60.0, 60.0), 120.0)
	_maybe_bubble(k, "bundle", 0.3)


func _deliver(k: _Kin) -> void:
	var amount: float = clampf(DELIVER_MIN + 2.0 * bond(k.pid), DELIVER_MIN, DELIVER_MAX)
	amount *= _mult("yield", k.job_place)
	if is_instance_valid(k.carry):
		var c: Node2D = k.carry
		var tw: Tween = c.create_tween()
		tw.tween_property(c, "modulate:a", 0.0, 0.35)
		tw.parallel().tween_property(c, "position:y", c.position.y + 18.0, 0.35)
		tw.tween_callback(c.queue_free)
		k.carry = null
	_drift(k.node.position + Vector2(0, -k.footprint), k.carry_res, amount)
	if Game != null and Game.has_method("add_resource"):
		Game.add_resource(k.carry_res, amount)
	k.delivered_at = _t_now()
	k.carry_at = _t_now() + Proc.rangef(world_seed, "c2:%s:%d" % [k.pid, int(_t_now())], CARRY_MIN, CARRY_MAX)
	_add_bond(k.pid, 0.004, "work")
	var back: Vector2 = _pos_of_place(k.job_place)
	_enter(k, "deliver", (_tx_of(back) if back != Vector2.INF else k.home_tx), 90.0)


# Rebuild the job-boost map: each working creature lends its profession to the
# things around it, scaled by bond, best-two-per-thing, clamped at ×1.25.
func _recompute_jobs() -> void:
	_job_boosts.clear()
	if _kin.is_empty():
		return
	var recs: Array = _records_list()
	for pid in _kin.keys():
		var k: _Kin = _kin[pid]
		if not is_instance_valid(k.node):
			continue
		var job: Variant = JOBS.get(k.profession, null)
		if not (job is Dictionary):
			continue
		var jd: Dictionary = job
		var key: String = String(jd.get("key", "yield"))
		var base: float = float(jd.get("mult", 1.0))
		var kinds: Array = jd.get("kinds", ["*"]) as Array
		var scale: float = 0.6 + 0.4 * bond(pid)
		var mult: float = clampf(1.0 + (base - 1.0) * scale, 1.0, 1.25)
		if mult <= 1.0005:
			continue
		for item in recs:
			var r: Dictionary = item
			var node_v: Variant = r.get("node", null)
			if not is_instance_valid(node_v) or not (node_v is Node2D):
				continue
			var rid: String = String(r.get("id", ""))
			if rid == "" or rid == pid:
				continue
			var entry: Dictionary = r.get("entry", {}) as Dictionary
			var kind: String = String(entry.get("kind", ""))
			if not (kinds.has("*") or kinds.has(kind)):
				continue
			if (node_v as Node2D).position.distance_to(k.node.position) > JOB_RADIUS:
				continue
			if not (_job_boosts.get(rid) is Array):
				_job_boosts[rid] = []
			var list: Array = _job_boosts[rid]
			list.append({"key": key, "mult": mult, "from": pid})


# The honest `grow` seam (DYNAMICS §7.2): always recompute from a stored base, so
# repeated passes (ours or a sibling's) can never accumulate.
func _apply_grow_mults() -> void:
	for item in _records_list():
		var r: Dictionary = item
		var node_v: Variant = r.get("node", null)
		if not is_instance_valid(node_v) or not (node_v is ProcNode):
			continue
		var node: ProcNode = node_v
		if bool(r.get("minted", false)):
			continue
		var pid: String = String(r.get("id", ""))
		if pid == "":
			continue
		if not node.has_meta("dyn_base_grow"):
			if node.grow_rate <= 0.0:
				continue                 # frozen / minted by another owner: leave it be
			node.set_meta("dyn_base_grow", node.grow_rate)
		var base: float = float(node.get_meta("dyn_base_grow", node.grow_rate))
		if base <= 0.0:
			continue
		node.grow_rate = base * _mult("grow", pid)


# A scholar quietly turns time into a hint for the Journal.
func _tick_scholar(step: float) -> void:
	var has_scholar: bool = false
	for pid in _kin.keys():
		var k: _Kin = _kin[pid]
		if k.profession == "scholar" and is_instance_valid(k.node):
			has_scholar = true
			break
	if not has_scholar:
		return
	_scholar_acc += step
	if _scholar_acc < 1200.0:
		return
	_scholar_acc = 0.0
	var di: Node = _sib("Discovery")
	if di != null and di.has_method("discover"):
		di.call("discover", "insight:%d" % int(_unix() / 1200.0), {"category": "insight", "label": "A scholar's note"})


# =============================================================================
# GIFTS  (kindred only) + the explorer's trail motes
# =============================================================================
func _tick_gifts(now: float) -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	var meta: Dictionary = st["meta"]
	if _unix() - float(meta.get("last_gift_try", 0.0)) < GIFT_PERIOD:
		return
	meta["last_gift_try"] = _unix()
	for pid in _kin.keys():
		var k: _Kin = _kin[pid]
		if bond(pid) < float(LEVEL_AT["kindred"]):
			continue
		var kst: Dictionary = _kin_st(pid)
		if String(kst.get("gift", "")) != "":
			continue
		if _roll("gift:" + pid, GIFT_CHANCE, "gift", GIFT_PITY):
			kst["gift"] = _pick_gift_material(pid)
			_maybe_bubble(k, "gift", 1.0)
			_say("%s found something, and is holding it out to you." % k.pretty)
	# an explorer leaves a trail mote now and then
	for pid in _kin.keys():
		var k2: _Kin = _kin[pid]
		if k2.profession != "explorer" or not is_instance_valid(k2.node):
			continue
		if _trails.size() >= MAX_TRAIL:
			break
		if now - k2.trail_at < 420.0:
			continue
		k2.trail_at = now
		_drop_trail(k2)


func _pick_gift_material(tag: String) -> String:
	var pool: Array = GIFT_FALLBACK
	var ch: Node = _sib("Chains")
	if ch != null and ch.has_method("materials"):
		var m: Variant = ch.call("materials")
		if m is Array and not (m as Array).is_empty():
			pool = m as Array
	var i: int = int(_rand("gm:" + tag) * pool.size())
	return String(pool[clampi(i, 0, pool.size() - 1)])


func _drop_trail(k: _Kin) -> void:
	var mote := _TrailMote.new()
	mote.seedv = hash("%d:trail:%s:%d" % [world_seed, k.pid, int(_t_now())])
	mote.mat = _pick_gift_material("trail:" + k.pid)
	mote.z_index = 14
	mote.position = _ground_point(k.tx) + Vector2(0, -26.0)
	_layer.add_child(mote)
	mote.pop_in(0.5)
	_trails.append(mote)


func _collect_trail(mote: Node2D) -> void:
	var mat: String = String(mote.get("mat")) if _has_prop(mote, "mat") else "dewdrop"
	_grant_material(mat, 1)
	_fx(mote.position, "harvest", "light")
	mote.queue_free()
	_say("A little find, left on the path.")


# =============================================================================
# GESTURES  (new ActionBubble verbs; no menus, no panels)
# =============================================================================
func extra_actions(record: Dictionary) -> Array:
	var out: Array = []
	var entry: Dictionary = record.get("entry", {}) as Dictionary
	if String(entry.get("kind", "")) != "creature":
		return out
	if bool(record.get("minted", false)):
		return out
	var pid: String = String(record.get("id", ""))
	if pid == "" or not _kin.has(pid):
		return out
	var k: _Kin = _kin[pid]
	out.append("pet")
	if k.mood == "playful" or _nearest_playful(k) != null:
		out.append("play")
	if String(_kin_st(pid).get("gift", "")) != "":
		out.append("gift")
	return out


func handle_action(action: String, record: Dictionary) -> bool:
	var pid: String = String(record.get("id", ""))
	if pid == "" or not _kin.has(pid):
		return false
	var k: _Kin = _kin[pid]
	match action:
		"pet":
			_do_pet(k)
			return true
		"play":
			_do_play(k)
			return true
		"gift":
			_do_gift(k)
			return true
		_:
			return false


func _do_pet(k: _Kin) -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	_roll_day(st)
	var play: Dictionary = st["play"]
	var n: int = int(play.get("pets", 0))
	if n >= PETS_PER_DAY:
		# a soft cap, never a refusal with teeth
		_maybe_bubble(k, "heart", 1.0)
		_say("%s has had all the fussing they can take today — and is very content." % k.pretty)
		return
	play["pets"] = n + 1
	var kst: Dictionary = _kin_st(k.pid)
	kst["pets_total"] = int(kst.get("pets_total", 0)) + 1
	_add_bond(k.pid, XP_PET, "pet")
	k.mood = "content"
	kst["mood"] = "content"
	_maybe_bubble(k, "heart", 1.0)
	# "ripple", not "sparkle": the growth-sparkle effect in ProcEffects currently
	# draws onto the wrong canvas (ProcEffects.gd:653) and logs an error.
	_fx(k.node.position, "ripple", "light")


func _do_play(k: _Kin) -> void:
	k.mood = "playful"
	_kin_st(k.pid)["mood"] = "playful"
	var mate: _Kin = _nearest_playful(k)
	if mate != null:
		_enter(k, "greet", mate.tx + (18.0 if mate.tx < k.tx else -18.0), 10.0)
		_enter(mate, "greet", k.tx + (18.0 if k.tx < mate.tx else -18.0), 10.0)
	else:
		_enter(k, "play", k.tx + Proc.rangef(world_seed, "pl:" + k.pid, -70.0, 70.0), 12.0)
	_add_bond(k.pid, XP_PLAY, "play")
	_maybe_bubble(k, "dots", 1.0)


func _do_gift(k: _Kin) -> void:
	var kst: Dictionary = _kin_st(k.pid)
	var mat: String = String(kst.get("gift", ""))
	if mat == "":
		return
	kst["gift"] = ""
	_grant_material(mat, 1)
	dyn_event.emit("gift", {"place_id": k.pid, "material": mat})
	_maybe_bubble(k, "gift", 1.0)
	_fx(k.node.position + Vector2(0, -k.footprint), "harvest", "light")
	_say("%s presses %s into your hand." % [k.pretty, _pretty_material(mat)])


# Taps are only ever consumed for a trail mote the player can plainly see.
func handle_tap(_screen_pos: Vector2, world_pos: Vector2) -> bool:
	for item in _trails:
		var m: Variant = item
		if not is_instance_valid(m) or not (m is Node2D):
			continue
		if (m as Node2D).position.distance_to(world_pos) <= 48.0:
			_collect_trail(m as Node2D)
			return true
	return false


# =============================================================================
# GRANTS  (the shared tray pattern, DYNAMICS §7.3 — copied exactly)
# =============================================================================
func _grant_material(mat: String, n: int = 1) -> void:
	var ch: Node = _sib("Chains")
	if ch != null and ch.has_method("give"):
		ch.call("give", mat, n)
		return
	_grant("mat:" + mat, {
		"count": 0, "kind": "material", "species": mat,
		"label": _pretty_material(mat), "growth": -1.0, "minted": false,
	}, n)


func _grant(item_key: String, entry: Dictionary, n: int = 1) -> void:
	if Game == null or not (Game.state is Dictionary):
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
	Game.emit_signal("state_dirty")


func _tray() -> Node:
	if _interact != null and _interact.has_method("tray"):
		var tr: Variant = _interact.call("tray")
		if tr is Node:
			return tr
	return null


func _pretty_material(mat: String) -> String:
	return mat.replace("_", " ").capitalize()


# =============================================================================
# VISUAL HELPERS
# =============================================================================
# A thought bubble: the shared visual language of this layer (DYNAMICS §7.4).
func _maybe_bubble(k: _Kin, glyph: String, importance: float) -> void:
	if not is_instance_valid(k.node) or _layer == null:
		return
	if _t_now() - k.bubble_at < 12.0 and importance < 0.9:
		return
	_prune_fx()
	if _bubbles.size() >= MAX_BUBBLES:
		if importance < 0.9:
			return
		var oldest: Variant = _bubbles.pop_front()
		if is_instance_valid(oldest):
			(oldest as Node).queue_free()
	_drop_bubble(k)
	k.bubble_at = _t_now()
	var b := _ThoughtBubble.new()
	b.seedv = hash("%d:bub:%s:%s" % [world_seed, k.pid, glyph])
	b.glyph = glyph
	b.life = Proc.rangef(world_seed, "blife:%s:%s" % [k.pid, glyph], 4.0, 6.0)
	b.z_index = 18
	b.anchor = k.node.position + Vector2(k.dir * k.footprint * 0.55, -k.footprint * 2.05 - 18.0)
	b.position = b.anchor
	_layer.add_child(b)
	b.pop_in(0.18)
	k.bubble = b
	_bubbles.append(b)


func _drop_bubble(k: _Kin) -> void:
	if is_instance_valid(k.bubble):
		if k.bubble.has_method("dismiss"):
			k.bubble.call("dismiss")
		else:
			k.bubble.queue_free()
	k.bubble = null


func _follow_bubbles() -> void:
	for pid in _kin.keys():
		var k: _Kin = _kin[pid]
		if not is_instance_valid(k.bubble) or not is_instance_valid(k.node):
			continue
		var want: Vector2 = k.node.position + Vector2(k.dir * k.footprint * 0.55, -k.footprint * 2.05 - 18.0)
		k.bubble.set("anchor", want)


func _petals_between(a: _Kin, b: _Kin) -> void:
	if _layer == null or not is_instance_valid(a.node) or not is_instance_valid(b.node):
		return
	var ring := _PetalRing.new()
	ring.seedv = hash("%d:pair:%s:%s" % [world_seed, a.pid, b.pid])
	ring.span = b.node.position - a.node.position
	ring.z_index = 16
	ring.position = a.node.position.lerp(b.node.position, 0.5) + Vector2(0, -26.0)
	_layer.add_child(ring)


func _prune_fx() -> void:
	var keep: Array = []
	for item in _bubbles:
		if is_instance_valid(item):
			keep.append(item)
	_bubbles = keep
	var keep2: Array = []
	for item in _trails:
		if is_instance_valid(item):
			keep2.append(item)
	_trails = keep2


func _fx(world_pos: Vector2, kind: String, material: String = "", res: String = "") -> void:
	if _space != null and _space.has_method("spawn_world_fx"):
		_space.call("spawn_world_fx", world_pos, kind, material, res)
		return
	if _layer == null:
		return
	var opts: Dictionary = {"z": 20}
	if material != "":
		opts["material"] = material
	if res != "":
		opts["resource"] = res
	var fx: ProcNode = ProcEffects.make(world_seed, "clfx:%d" % Time.get_ticks_usec(), kind, opts)
	fx.position = world_pos
	_layer.add_child(fx)


# A delivered bundle becomes a resource mote streaming into the root-pool.
func _drift(from: Vector2, res: String, amount: float) -> void:
	if _space != null and _space.has_method("drift_mote_pub"):
		_space.call("drift_mote_pub", from, res, amount)
		return
	if _layer == null:
		return
	var m: ProcNode = ProcEffects.make_pickup_float(world_seed, "clm:%d" % Time.get_ticks_usec(),
		res, clampf(amount, 0.1, 4.0), {"scale": 0.7, "z": 25})
	m.position = from
	_layer.add_child(m)
	var to: Vector2 = _ground_point(_heart_tx()) + Vector2(0, -12.0)
	var tw: Tween = m.create_tween().set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_IN_OUT)
	tw.tween_property(m, "position", to, 1.1)


func _say(text: String) -> void:
	if _t_now() - _last_whisper < WHISPER_GAP:
		return
	if _interact != null and _interact.has_method("is_placing") and bool(_interact.call("is_placing")):
		return                              # never speak over a drag; drop the line
	_last_whisper = _t_now()
	whisper.emit(text)


# =============================================================================
# WORLD READS  (all degrade gracefully — the designed accessors are preferred,
# the private fields are a read-only fallback so nothing is blocked if §9.2 of
# the integration note has not been wired yet)
# =============================================================================
func _records_list() -> Array:
	if _space == null:
		return []
	if _space.has_method("records"):
		var v: Variant = _space.call("records")
		if v is Array:
			return v
	var p: Variant = _space.get("_records")
	if p is Array:
		return p
	return []


func _origin() -> Vector2:
	if _origin_ok:
		return _origin_cache
	if _space == null:
		return Vector2.ZERO
	if _space.has_method("ground_origin"):
		var v: Variant = _space.call("ground_origin")
		if v is Vector2:
			_origin_cache = v
			_origin_ok = true
			return _origin_cache
	var p: Variant = _space.get("_ground_origin")
	if p is Vector2:
		_origin_cache = p
		_origin_ok = true
	return _origin_cache


func _ground_point(tx: float) -> Vector2:
	if _space == null:
		return Vector2(tx, 0.0)
	var o: Vector2 = _origin()
	if _space.has_method("ground_surface_at"):
		return o + Vector2(tx, float(_space.call("ground_surface_at", tx)))
	if _space.has_method("snap_ground"):
		var v: Variant = _space.call("snap_ground", Vector2(o.x + tx, o.y))
		if v is Vector2:
			return v
	return o + Vector2(tx, 0.0)


func _tx_of(world_pos: Vector2) -> float:
	if _space != null and _space.has_method("terrain_x"):
		return float(_space.call("terrain_x", world_pos))
	return world_pos.x - _origin().x


func _ground_span() -> Vector2:
	if _space != null and _space.has_method("ground_span"):
		var v: Variant = _space.call("ground_span")
		if v is Vector2:
			return v
	return Vector2(-900.0, 900.0)


func _clamp_tx(tx: float) -> float:
	var span: Vector2 = _ground_span()
	return clampf(tx, span.x + 30.0, span.y - 30.0)


func _heart_tx() -> float:
	if _space == null:
		return 0.0
	if _space.has_method("heart_tx"):
		return float(_space.call("heart_tx"))
	if _space.has_method("heart_foot"):
		var v: Variant = _space.call("heart_foot")
		if v is Vector2:
			return _tx_of(v)
	return 0.0


# One flat snapshot of the placed registry per logic tick. Every per-creature
# neighbourhood question (where is cover, what do I like nearby, am I standing at a
# building) reads this instead of re-walking the registry per creature per second.
func _refresh_snap() -> void:
	_snap.clear()
	for item in _records_list():
		var r: Dictionary = item
		var node_v: Variant = r.get("node", null)
		if not is_instance_valid(node_v) or not (node_v is Node2D):
			continue
		var n: Node2D = node_v
		var entry: Dictionary = r.get("entry", {}) as Dictionary
		_snap.append({
			"id": String(r.get("id", "")),
			"kind": String(entry.get("kind", "")),
			"building_id": String(entry.get("building_id", "")),
			"pos": n.position,
			"tx": _tx_of(n.position),
			"fr": float(r.get("footprint", 30.0)),
		})


# Position lookups happen a lot (every grow-mult pass asks for every record), so
# they are served from a 1-second cache instead of re-walking the registry.
func _refresh_pos_cache() -> void:
	if _t_now() - _pos_cache_at < 1.0:
		return
	_pos_cache_at = _t_now()
	_pos_cache.clear()
	for item in _records_list():
		var r: Dictionary = item
		var node_v: Variant = r.get("node", null)
		if is_instance_valid(node_v) and node_v is Node2D:
			_pos_cache[String(r.get("id", ""))] = (node_v as Node2D).position


func _pos_of_place(place_id: String) -> Vector2:
	if place_id == "":
		return Vector2.INF
	_refresh_pos_cache()
	var v: Variant = _pos_cache.get(place_id, null)
	if v is Vector2:
		return v
	return Vector2.INF


func _res_of_place(place_id: String) -> String:
	for item in _records_list():
		var r: Dictionary = item
		if String(r.get("id", "")) != place_id:
			continue
		var entry: Dictionary = r.get("entry", {}) as Dictionary
		var res: String = String(ItemCatalog.produces(entry))
		if res != "":
			return res
	return "essence"


func _nearest_kind_tx(k: _Kin, kinds: Array) -> float:
	var best: float = INF
	var best_d: float = INF
	for item in _snap:
		var s: Dictionary = item
		if not kinds.has(String(s.get("kind", ""))):
			continue
		if String(s.get("id", "")) == k.pid:
			continue
		var tx: float = float(s.get("tx", 0.0))
		var d: float = absf(tx - k.tx)
		if d < best_d:
			best_d = d
			# stand BESIDE it, never inside it
			best = tx + (float(s.get("fr", 30.0)) + 14.0) * (1.0 if tx < k.tx else -1.0)
	return best


func _nearest_puzzle_tx(k: _Kin) -> float:
	if _puzzles == null or not _puzzles.has_method("all_puzzles"):
		return INF
	var v: Variant = _puzzles.call("all_puzzles")
	if not (v is Array):
		return INF
	var best: float = INF
	var best_d: float = INF
	for item in (v as Array):
		if not is_instance_valid(item) or not (item is Node2D):
			continue
		var n: Node2D = item
		var tx: float = _tx_of(to_local(n.global_position))
		var d: float = absf(tx - k.tx)
		if d < best_d:
			best_d = d
			best = tx + Proc.rangef(world_seed, "pzo:" + k.pid, -70.0, 70.0)
	return best


func _puzzle_tx_by_id(id: String) -> float:
	if id == "" or _puzzles == null or not _puzzles.has_method("get_puzzle"):
		return INF
	var p: Variant = _puzzles.call("get_puzzle", id)
	if is_instance_valid(p) and p is Node2D:
		return _tx_of(to_local((p as Node2D).global_position))
	return INF


func _payload_tx(payload: Dictionary) -> float:
	var pid: String = String(payload.get("place_id", ""))
	if pid == "" and payload.has("record") and payload["record"] is Dictionary:
		pid = String((payload["record"] as Dictionary).get("id", ""))
	var p: Vector2 = _pos_of_place(pid)
	if p == Vector2.INF:
		return INF
	return _tx_of(p)


# --- world mood reads (SeasonsEvents first, then the live sky, then a default) --
func _is_night() -> bool:
	var se: Node = _sib("SeasonsEvents")
	if se != null and se.has_method("is_night"):
		return bool(se.call("is_night"))
	var sky: Node = _sky_node()
	if sky != null and sky.has_method("get_time_of_day"):
		var tod: float = float(sky.call("get_time_of_day"))
		return tod > 0.78 or tod < 0.10
	return false


func _weather() -> String:
	var se: Node = _sib("SeasonsEvents")
	if se != null and se.has_method("weather"):
		return String(se.call("weather"))
	var sky: Node = _sky_node()
	if sky != null and _has_prop(sky, "weather"):
		return String(sky.get("weather"))
	return "clear"


func _season_id() -> String:
	var se: Node = _sib("SeasonsEvents")
	if se != null and se.has_method("season_id"):
		return String(se.call("season_id"))
	return ""


func _sky_node() -> Node:
	if _sky != null and is_instance_valid(_sky):
		return _sky
	if _space != null and _space.has_method("sky_node"):
		var v: Variant = _space.call("sky_node")
		if v is Node:
			_sky = v
			return _sky
	if _space != null:
		var p: Variant = _space.get("_sky")
		if p is Node:
			_sky = p
	return _sky


# =============================================================================
# PERSISTENCE OF WALKING  (we own our own tx so we never write another owner's
# record; WorldSpace keeps the planting spot, we keep where they wandered to)
# =============================================================================
func _persist_positions() -> void:
	for pid in _kin.keys():
		var k: _Kin = _kin[pid]
		var kst: Dictionary = _kin_st(pid)
		if kst.is_empty():
			continue
		kst["tx"] = k.tx
		kst["mood"] = k.mood
		kst["last_tick"] = _unix()


# =============================================================================
# TINY UTILITIES
# =============================================================================
func _t_now() -> float:
	return float(Time.get_ticks_msec()) / 1000.0


func _unix() -> float:
	return Time.get_unix_time_from_system()


func _has_prop(o: Object, pname: String) -> bool:
	if o == null:
		return false
	for p in o.get_property_list():
		if String(p.get("name", "")) == pname:
			return true
	return false


# =============================================================================
#  _Kin — the live, per-creature runtime (never serialised; state lives in
#  Game.state.creature_life.kin)
# =============================================================================
class _Kin extends RefCounted:
	var pid: String = ""
	var node: ProcNode = null
	var species: String = ""
	var profession: String = "gatherer"
	var pretty: String = "Blockling"
	var rarity: String = "common"
	var footprint: float = 34.0
	var speed: float = 24.0
	var dir: float = 1.0
	var tx: float = 0.0
	var target_tx: float = 0.0
	var home_tx: float = 0.0
	var roam: float = 420.0
	var state: String = "idle"
	var state_until: float = 0.0
	var mood: String = "content"
	var mood_next: float = 0.0
	var likes: Array = []
	var admire_glyph: String = "flower"
	var admire_said: bool = false
	var walking: bool = false
	var snap_at: float = 0.0
	var face_at: float = 0.0
	var bubble_at: float = -999.0
	var zzz_at: float = 0.0
	var trail_at: float = -999.0
	var carry_at: float = 0.0
	var carry_res: String = "essence"
	var delivered_at: float = -999.0
	var job_place: String = ""
	var base_rot: float = 0.0
	var base_scale: Vector2 = Vector2.ONE
	var sleeping: bool = false
	var bubble: Node2D = null
	var carry: Node2D = null
	var halo: Node2D = null

	func phase_of() -> float:
		return float(absi(hash(pid)) % 1000) / 1000.0 * TAU


# =============================================================================
#  _ThoughtBubble — a soft parchment cloud with two trailing dots and a drawn
#  glyph. This is the whole readout surface for a creature's inner life: it pops
#  in with a back-ease over 0.18 s, holds 4–6 s, and fades. No text, ever.
# =============================================================================
class _ThoughtBubble extends ProcNode:
	var glyph: String = "heart"
	var life: float = 5.0
	var anchor: Vector2 = Vector2.ZERO
	var _fading: bool = false
	var _cloud: PackedVector2Array = PackedVector2Array()
	var _ink: Color = Color("#3A2E22")
	var _parch: Color = Color("#FBF6E9")
	var _accent: Color = Color(0.95, 0.62, 0.58)
	var _r: float = 26.0

	func _on_built() -> void:
		grow_rate = 0.0
		growth = 0.0
		_r = 24.0 + Proc.hashf(seedv, "r") * 5.0
		_cloud = Proc.blob(seedv, "cloud", _r, 8, 0.13)
		_accent = _glyph_colour()

	func dismiss() -> void:
		if _fading:
			return
		_fading = true
		var tw := create_tween()
		tw.tween_property(self, "modulate:a", 0.0, 0.25)
		tw.tween_callback(queue_free)

	func _animate(_delta: float) -> void:
		position = anchor + Vector2(sin(t * 0.9 + phase) * 1.6, -3.0 - sin(t * 1.6 + phase) * 2.4)
		if not _fading and t >= life:
			_fading = true
			var tw := create_tween()
			tw.tween_property(self, "modulate:a", 0.0, 0.4)
			tw.tween_callback(queue_free)

	func _draw() -> void:
		var s: float = g()
		if s <= 0.01:
			return
		# two trailing thought-dots leading down toward the speaker
		var dot_a: Vector2 = Vector2(-_r * 0.26, _r * 0.78) * s
		var dot_b: Vector2 = Vector2(-_r * 0.46, _r * 1.14) * s
		draw_circle(dot_b, _r * 0.11 * s, _parch)
		_ring(dot_b, _r * 0.11 * s)
		draw_circle(dot_a, _r * 0.17 * s, _parch)
		_ring(dot_a, _r * 0.17 * s)
		# the cloud itself
		var pts := PackedVector2Array()
		for p in _cloud:
			pts.append(p * s)
		var top: Color = _parch.lightened(0.05)
		var bot: Color = Color(_parch.r * 0.93, _parch.g * 0.90, _parch.b * 0.84, 1.0)
		draw_polygon(pts, Proc.grad_fill(pts, top, bot))
		var outline := pts
		if outline.size() > 1:
			outline.append(pts[0])
			draw_polyline(outline, Color(_ink.r, _ink.g, _ink.b, 0.85), 1.5, true)
		_draw_glyph(_r * 0.56 * s)

	func _ring(c: Vector2, r: float) -> void:
		var pts := PackedVector2Array()
		for i in range(13):
			var a: float = TAU * float(i) / 12.0
			pts.append(c + Vector2(cos(a), sin(a)) * r)
		draw_polyline(pts, Color(_ink.r, _ink.g, _ink.b, 0.8), 1.3, true)

	func _glyph_colour() -> Color:
		match glyph:
			"heart": return Color(0.93, 0.47, 0.52)
			"spiral": return Color(0.47, 0.72, 0.92)
			"zzz": return Color(0.55, 0.58, 0.78)
			"dots": return Color(0.96, 0.75, 0.38)
			"leaf": return Color(0.52, 0.72, 0.45)
			"flower": return Color(0.95, 0.60, 0.72)
			"sprout": return Color(0.58, 0.80, 0.50)
			"star": return Color(0.76, 0.68, 0.98)
			"bundle": return Color(0.80, 0.62, 0.38)
			"gift": return Color(0.95, 0.70, 0.45)
			"note": return Color(0.68, 0.74, 0.88)
			"book": return Color(0.78, 0.60, 0.44)
			"compass": return Color(0.52, 0.76, 0.80)
			"shield": return Color(0.66, 0.72, 0.80)
			"puzzle": return Color(0.85, 0.72, 0.46)
			"droplet": return Color(0.52, 0.76, 0.94)
			_: return Color(0.90, 0.60, 0.55)

	func _draw_glyph(r: float) -> void:
		if r <= 1.0:
			return
		var c: Color = _accent
		var dk: Color = Color(c.r * 0.6, c.g * 0.55, c.b * 0.55, 1.0)
		match glyph:
			"heart":
				var h := PackedVector2Array()
				for i in range(34):
					var a: float = TAU * float(i) / 34.0
					var x: float = 16.0 * pow(sin(a), 3.0)
					var y: float = -(13.0 * cos(a) - 5.0 * cos(2.0 * a) - 2.0 * cos(3.0 * a) - cos(4.0 * a))
					h.append(Vector2(x, y) * (r / 16.0))
				draw_polygon(h, Proc.grad_fill(h, c.lightened(0.2), dk))
			"spiral":
				var sp := PackedVector2Array()
				for i in range(30):
					var u: float = float(i) / 29.0
					var a2: float = u * TAU * 1.7
					sp.append(Vector2(cos(a2), sin(a2)) * r * (0.18 + u * 0.82))
				draw_polyline(sp, c, maxf(1.6, r * 0.16), true)
			"zzz":
				for i in range(3):
					var sz: float = r * (0.46 - float(i) * 0.1)
					var o: Vector2 = Vector2(-r * 0.4 + float(i) * r * 0.42, r * 0.34 - float(i) * r * 0.42)
					var z := PackedVector2Array([
						o + Vector2(-sz, -sz), o + Vector2(sz, -sz),
						o + Vector2(-sz, sz), o + Vector2(sz, sz)])
					draw_polyline(z, c, maxf(1.4, r * 0.13), true)
			"dots":
				draw_circle(Vector2(-r * 0.42, r * 0.1), r * 0.3, c)
				draw_circle(Vector2(r * 0.42, -r * 0.16), r * 0.34, c.lightened(0.18))
			"leaf":
				var lf := PackedVector2Array()
				for i in range(22):
					var u2: float = float(i) / 21.0
					lf.append(Vector2(sin(u2 * PI) * r * 0.52, (u2 - 0.5) * r * 1.7))
				for i in range(21, -1, -1):
					var u3: float = float(i) / 21.0
					lf.append(Vector2(-sin(u3 * PI) * r * 0.2, (u3 - 0.5) * r * 1.7))
				draw_polygon(lf, Proc.grad_fill(lf, c.lightened(0.2), dk))
				draw_line(Vector2(0, -r * 0.85), Vector2(0, r * 0.85), dk, maxf(1.0, r * 0.1), true)
			"flower":
				for i in range(5):
					var a3: float = TAU * float(i) / 5.0 - PI * 0.5
					var pc: Vector2 = Vector2(cos(a3), sin(a3)) * r * 0.52
					var pet := PackedVector2Array()
					for j in range(10):
						var aa: float = TAU * float(j) / 10.0
						pet.append(pc + Vector2(cos(aa) * r * 0.34, sin(aa) * r * 0.26).rotated(a3))
					draw_colored_polygon(pet, c)
				draw_circle(Vector2.ZERO, r * 0.26, Color(1.0, 0.92, 0.55))
			"sprout":
				draw_line(Vector2(0, r * 0.8), Vector2(0, -r * 0.3), dk, maxf(1.2, r * 0.12), true)
				for sgn in [-1.0, 1.0]:
					var lv := PackedVector2Array()
					for i in range(12):
						var u4: float = float(i) / 11.0
						lv.append(Vector2(sgn * u4 * r * 0.8, -r * 0.3 - sin(u4 * PI) * r * 0.42))
					for i in range(11, -1, -1):
						var u5: float = float(i) / 11.0
						lv.append(Vector2(sgn * u5 * r * 0.62, -r * 0.3 - sin(u5 * PI) * r * 0.12))
					draw_colored_polygon(lv, c)
			"star":
				var stp := PackedVector2Array()
				for i in range(10):
					var a4: float = -PI * 0.5 + TAU * float(i) / 10.0
					var rr: float = r if i % 2 == 0 else r * 0.42
					stp.append(Vector2(cos(a4), sin(a4)) * rr)
				draw_polygon(stp, Proc.grad_fill(stp, c.lightened(0.25), dk))
			"bundle":
				var bd := Proc.superellipse(r * 0.78, r * 0.66, 3.0, 20)
				draw_polygon(bd, Proc.grad_fill(bd, c.lightened(0.2), dk))
				draw_line(Vector2(-r * 0.78, 0), Vector2(r * 0.78, 0), dk, maxf(1.2, r * 0.12), true)
				draw_line(Vector2(0, -r * 0.66), Vector2(0, r * 0.66), dk, maxf(1.0, r * 0.1), true)
			"gift":
				var bx := Proc.superellipse(r * 0.76, r * 0.62, 4.0, 20)
				draw_polygon(bx, Proc.grad_fill(bx, c.lightened(0.2), dk))
				draw_line(Vector2(0, -r * 0.62), Vector2(0, r * 0.62), Color(1, 1, 1, 0.8), maxf(1.2, r * 0.14), true)
				draw_circle(Vector2(-r * 0.2, -r * 0.7), r * 0.2, c.lightened(0.3))
				draw_circle(Vector2(r * 0.2, -r * 0.7), r * 0.2, c.lightened(0.3))
			"note":
				draw_circle(Vector2(-r * 0.2, r * 0.46), r * 0.26, c)
				draw_line(Vector2(r * 0.04, r * 0.46), Vector2(r * 0.04, -r * 0.7), c, maxf(1.3, r * 0.13), true)
				draw_line(Vector2(r * 0.04, -r * 0.7), Vector2(r * 0.6, -r * 0.52), c, maxf(1.3, r * 0.13), true)
			"book":
				var pg := PackedVector2Array([
					Vector2(-r * 0.8, -r * 0.6), Vector2(0, -r * 0.46),
					Vector2(r * 0.8, -r * 0.6), Vector2(r * 0.8, r * 0.6),
					Vector2(0, r * 0.46), Vector2(-r * 0.8, r * 0.6)])
				draw_polygon(pg, Proc.grad_fill(pg, c.lightened(0.2), dk))
				draw_line(Vector2(0, -r * 0.46), Vector2(0, r * 0.46), dk, maxf(1.0, r * 0.1), true)
			"compass":
				_circle_outline(r * 0.84, c, maxf(1.4, r * 0.13))
				var nd := PackedVector2Array([
					Vector2(0, -r * 0.6), Vector2(r * 0.2, 0),
					Vector2(0, r * 0.6), Vector2(-r * 0.2, 0)])
				draw_colored_polygon(nd, c)
			"shield":
				var sh := PackedVector2Array([
					Vector2(-r * 0.66, -r * 0.62), Vector2(r * 0.66, -r * 0.62),
					Vector2(r * 0.52, r * 0.3), Vector2(0, r * 0.82), Vector2(-r * 0.52, r * 0.3)])
				draw_polygon(sh, Proc.grad_fill(sh, c.lightened(0.22), dk))
			"puzzle":
				var pz := Proc.superellipse(r * 0.7, r * 0.7, 4.0, 18)
				draw_polygon(pz, Proc.grad_fill(pz, c.lightened(0.2), dk))
				draw_circle(Vector2(r * 0.7, 0), r * 0.26, c.lightened(0.25))
				draw_circle(Vector2(0, -r * 0.7), r * 0.26, Color(_parch.r, _parch.g, _parch.b, 1.0))
			"droplet":
				var dp := PackedVector2Array()
				for i in range(20):
					var a5: float = PI * float(i) / 19.0
					dp.append(Vector2(sin(a5) * r * 0.56, cos(a5) * r * 0.56 + r * 0.22))
				dp.append(Vector2(0, -r * 0.86))
				draw_polygon(dp, Proc.grad_fill(dp, c.lightened(0.3), dk))
			_:
				draw_circle(Vector2.ZERO, r * 0.6, c)

	func _circle_outline(r: float, col: Color, w: float) -> void:
		var pts := PackedVector2Array()
		for i in range(25):
			var a: float = TAU * float(i) / 24.0
			pts.append(Vector2(cos(a), sin(a)) * r)
		draw_polyline(pts, col, w, true)


# =============================================================================
#  _Bundle — the little carried load a working creature takes to the Heart Tree:
#  a tied sack with a resource-coloured peek, shaped by what it carries.
# =============================================================================
class _Bundle extends ProcNode:
	var res: String = "essence"
	var reach: float = 34.0
	var side: float = 1.0
	var _col: Color = Color(0.86, 0.72, 0.46)
	var _sack: PackedVector2Array = PackedVector2Array()

	func _on_built() -> void:
		grow_rate = 0.0
		_col = _res_colour(res)
		var r: float = maxf(10.0, reach * 0.42)
		_sack = Proc.blob(seedv, "sack", r, 7, 0.16)

	func _res_colour(id: String) -> Color:
		if GameData != null and GameData.resources_by_id.has(id):
			var d: Dictionary = GameData.resources_by_id[id] as Dictionary
			if d.has("color"):
				return Color(String(d["color"]))
		return Color(0.86, 0.72, 0.46)

	func _animate(_delta: float) -> void:
		rotation = sin(t * 3.1 + phase) * 0.07
		position.y = -reach * 1.18 + sin(t * 3.1 + phase) * 1.6

	func _draw() -> void:
		var s: float = g()
		if s <= 0.02:
			return
		var cloth := Color(0.82, 0.70, 0.52)
		var pts := PackedVector2Array()
		for p in _sack:
			pts.append(p * s)
		# contact shadow, body, highlight, tie
		draw_circle(Vector2(0, reach * 0.34 * s), reach * 0.3 * s, Color(0, 0, 0, 0.14))
		draw_polygon(pts, Proc.grad_fill(pts, cloth.lightened(0.16), Color(cloth.r * 0.68, cloth.g * 0.6, cloth.b * 0.5)))
		var outline := pts
		if outline.size() > 1:
			outline.append(pts[0])
			draw_polyline(outline, Color(0.24, 0.19, 0.14, 0.75), 1.3, true)
		var peek := reach * 0.2 * s
		draw_circle(Vector2(0, -reach * 0.1 * s), peek, Color(_col.r, _col.g, _col.b, 0.9))
		draw_circle(Vector2(-peek * 0.3, -reach * 0.16 * s), peek * 0.4, Color(1, 1, 1, 0.5))
		var knot := reach * 0.3 * s
		draw_line(Vector2(-knot, -reach * 0.3 * s), Vector2(knot, -reach * 0.3 * s),
			Color(0.42, 0.32, 0.22), maxf(1.2, reach * 0.06 * s), true)


# =============================================================================
#  _PetalRing — the one-shot ring of petals drawn between two creatures the
#  moment they become friends. 1.4 s, then gone.
# =============================================================================
class _PetalRing extends ProcNode:
	var span: Vector2 = Vector2(80, 0)
	var life: float = 1.4
	var _col: Color = Color(0.96, 0.72, 0.80)

	func _on_built() -> void:
		grow_rate = 0.0
		growth = 1.0
		animate_draw = true
		_col = Color.from_hsv(Proc.hashf(seedv, "hue") * 0.12 + 0.92, 0.42, 1.0)

	func _animate(_delta: float) -> void:
		if t >= life:
			queue_free()

	func _draw() -> void:
		var u: float = clampf(t / life, 0.0, 1.0)
		var fade: float = 1.0 - u * u
		var half: Vector2 = span * 0.5
		var n: int = 9
		for i in range(n):
			var p: float = float(i) / float(n - 1)
			var base: Vector2 = (-half).lerp(half, p)
			var lift: float = -sin(p * PI) * 26.0 - u * 18.0
			var swirl: float = sin(u * TAU + p * 4.0) * 7.0
			var pos: Vector2 = base + Vector2(swirl, lift)
			var r: float = 6.0 + 3.0 * sin(p * PI)
			var pet := PackedVector2Array([
				Vector2(0, -r), Vector2(r * 0.6, 0), Vector2(0, r), Vector2(-r * 0.6, 0)])
			var out := PackedVector2Array()
			for q in pet:
				out.append(pos + q.rotated(u * TAU * 0.4 + p * 2.0))
			draw_colored_polygon(out, Color(_col.r, _col.g, _col.b, 0.75 * fade))


# =============================================================================
#  _TrailMote — the small find an explorer leaves on the path. It drifts, it
#  glows, and it waits (it is never lost; it simply sits until tapped).
# =============================================================================
class _TrailMote extends ProcNode:
	var mat: String = "dewdrop"
	var _col: Color = Color(0.96, 0.88, 0.58)

	func _on_built() -> void:
		grow_rate = 0.0
		animate_draw = true
		_col = Color.from_hsv(Proc.hashf(seedv, "h") * 0.18 + 0.1, 0.35, 1.0)

	func _draw() -> void:
		var s: float = maxf(0.05, g())
		var pulse: float = 0.72 + 0.28 * sin(t * 2.1 + phase)
		var r: float = 9.0 * s
		draw_circle(Vector2.ZERO, r * 2.5 * pulse, Color(_col.r, _col.g, _col.b, 0.10))
		draw_circle(Vector2.ZERO, r * 1.5 * pulse, Color(_col.r, _col.g, _col.b, 0.18))
		draw_circle(Vector2.ZERO, r, Color(_col.r, _col.g, _col.b, 0.92))
		draw_circle(Vector2(-r * 0.3, -r * 0.3), r * 0.35, Color(1, 1, 1, 0.8))
		for i in range(4):
			var a: float = t * 0.7 + TAU * float(i) / 4.0
			var p: Vector2 = Vector2(cos(a), sin(a) * 0.5) * r * 2.2
			draw_circle(p, r * 0.22 * pulse, Color(_col.r, _col.g, _col.b, 0.55))

	func _animate(_delta: float) -> void:
		position.y += sin(t * 1.3 + phase) * 0.08
