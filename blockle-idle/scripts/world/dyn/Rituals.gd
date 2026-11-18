class_name Rituals
extends Node2D
# Rituals — THE ESSENCE SINK AND THE LATE GAME.  (DYNAMICS §6.5)
#
# Everything else in this world makes things. This is the one place that SPENDS
# them, and it spends them on the whole island at once.
#
# At the Heart Tree's roots a ring of standing stones rises out of the soil the
# first time you hold a little essence. You offer things to it — a dewdrop, a
# heartwood, a shard out of a meteor shower — by dragging them onto the stones.
# Each offering rests on a stone where you can see it, and one more carved rune
# lights on the worn earth ring. When the stones hold everything a rite wants, and
# the essence pool at the roots is deep enough, the runes complete on their own and
# a ceremony begins: a column of soft light stands in the circle for anywhere from
# 25 seconds to four minutes. You can watch it, or wander off, or close the game —
# the ceremony finishes on wall-clock time either way. When it lands, a wave of
# light crosses the island and the whole world is BLESSED for a few hours.
#
# Nine rites, all of them opportunities and none of them obligations:
#
#   rain      gentle rain waters everything          grow  ×1.08    2 h
#   warmth    the frost loses its grip               warm everything 3 h
#   light     a day of golden light                  yield ×1.10    3 h
#   roots     the land itself deepens — dormant seed-nodes drift out of the mist
#             at the island's edge, ready to be woven into new ground
#   kinship   a companion comes looking for the light bond ×1.5     6 h
#   finding   luck leans your way                    luck  ×2.0     2 h
#   plenty    the harvest runs over                  yield ×1.18    4 h
#   stillness time is kinder while you are away      offline 8 h → 12 h
#   long_year every blessing at once, at half strength              24 h
#
# And then the last one, which is not a confirm button: the ASCENSION CEREMONY.
# When the Heart Tree is ready it gains a slow golden bloom and the circle grows an
# eighth stone. It asks for THREE NIGHTS — three ten-minute vigils, one per
# in-world night, each lighting one lantern around the ring. When the third lantern
# burns, a long press on the Heart Tree folds the whole world into a single seed
# and opens it again, and the island keeps what it learned.
#
# SACRED CONSTRAINTS honoured here:
#   • MENU-LESS. There is no rite list, no recipe book, no progress bar and no
#     confirm dialog. The readouts are: the runes (charge), the stones (history),
#     the lanterns (vigils), the light column (a ceremony running), the brightness
#     (blessings live), the keepsake rings (what the next world will remember), and
#     the whisper line. That is all.
#   • CALM. Nothing expires harshly — a blessing simply fades and can be earned
#     again. A wrong offering just sits on its stone forever; tap the circle twice
#     and everything comes back to your basket. Nothing is ever consumed until a
#     rite actually begins. A vigil you never finish waits for you.
#   • SEEDED. Where the circle stands, which runes are carved on it, which rite the
#     stones murmur about — all pure functions of (world_seed, stable key). Every
#     roll goes through the persisted-counter pattern (DYNAMICS §2.5).
#   • ONE STATE KEY, migrate-safe: Game.state["rituals"], every field backfilled
#     with .get defaults so a legacy save loads without a single error.
#   • Rituals owns the CLAMP TABLE (DYNAMICS §2.1) and is the single authority for
#     every temporary world-wide multiplier, including the permanent arc grants
#     Wishes registers through register_permanent().
#
# PUBLIC API
#   setup(world_seed: int, ctx: Dictionary) -> void      ctx: {space, interact, sim, puzzles, sky}
#   catch_up(elapsed: float) -> void
#   notify(kind: String, payload: Dictionary) -> void
#   -- queries (DYNAMICS §4.4) ------------------------------------------------
#   blessing(key: String) -> float                  1.0 .. BLESS_CAP[key]  (hours for "offline")
#   blessing_for(key: String, kind: String) -> float   kind-aware (rites with an `only` filter)
#   is_active(rite_id: String) -> bool
#   cost_for(rite_id: String) -> Dictionary         {essence: float, materials: {mat: n}}
#   is_everbloom(place_id: String) -> bool
#   circle_planted() -> bool                        (Wishes gates `ritual` wishes on this)
#   register_permanent(key: String, amount: float) -> void    (arc grants, ≤ +12% total)
#   permanent(key: String) -> float
#   effective(key: String, place_id: String) -> float          the shared §2.1 formula
#   offline_full_hours() -> float
#   active_rites() -> Array ; vigil_count() -> int ; done_count(rite_id) -> int
#   rite_ids() -> Array ; rite_label(rite_id) -> String
#   -- gestures ---------------------------------------------------------------
#   extra_actions(record) -> Array                  adds `everbloom` to a keepsake
#   handle_action(action, record) -> bool           owns `everbloom`
#   handle_drop(entry, inst_key, world_pos) -> bool offerings land on the stones
#   handle_tap(screen_pos, world_pos) -> bool       the circle speaks / reclaims / vigil
#   handle_heart_hold() -> bool                     the Ascension ceremony
#   signals: whisper(text), dyn_event(kind, payload)

signal whisper(text: String)
signal dyn_event(kind: String, payload: Dictionary)

# =============================================================================
# TUNING
# =============================================================================
const SYS_KEY := "rituals"
const SYS_VERSION := 1

const TICK := 5.0                      # logic period (DYNAMICS §8 budget: 0.10 ms)
const VIS_TICK := 0.5                  # how often the ceremony's visual u is refreshed
const WHISPER_GAP := 12.0              # Rituals' whisper budget (§2.6)
const FLOOR_MULT := 0.92               # no key may ever resolve below this (§2.1)
const PERM_MAX := 0.12                 # all six arcs together: at most +12%

# The clamp table. Rituals owns it; everyone resolves through it (§2.1).
const CAP := {
	"grow": 1.60, "yield": 1.60, "bond": 2.00, "luck": 3.00,
	"cadence": 1.50, "craft": 1.50, "offline": 12.0,
}
# What a BLESSING alone may be worth (a blessing is 1.00..1.30 for grow/yield; the
# sky-wide keys are allowed their published rite values).
const BLESS_CAP := {
	"grow": 1.30, "yield": 1.30, "bond": 2.00, "luck": 3.00,
	"cadence": 1.50, "craft": 1.50, "offline": 12.0,
}

const MAX_ACTIVE_RITES := 3            # a fourth replaces the weakest, with a whisper
const MAX_EVERBLOOM := 4               # keepsakes the next world remembers
const BASE_EVERBLOOM := 3              # +1 from the deep_root arc gift

const CIRCLE_ESSENCE_GATE := 120.0     # the circle rises the first time you hold this
const CIRCLE_OFFSET := 300.0           # terrain-x past the Heart Tree (seeded ±50)
const CIRCLE_RADIUS := 104.0
const CIRCLE_UNFURL := 8.0             # seconds of rising out of the soil
const TAP_REACH := 1.5                 # how forgiving a tap on the circle is

const VIGIL_SECONDS := 600.0           # ten quiet minutes
const VIGIL_MIN_GAP := 2.0 * 3600.0    # at most one vigil per in-world night
const VIGIL_GAP_NO_SEASONS := 6.0 * 3600.0
const VIGILS_NEEDED := 3

const OFFLINE_FULL_HOURS := 8.0
const RECLAIM_WINDOW := 2.2            # a second tap this soon means "take it back"
const ASCEND_ARM_WINDOW := 12.0        # hold the trunk twice; nothing irreversible on one
const RUNES := 7                       # carved marks on the ring = the charge readout
const MOTE_BUDGET := 10                # this system's slice of the §7.4 mote budget

# The nine rites. `minutes` is minutes of the player's CURRENT essence income, so a
# rite costs the same *felt* amount at every stage of the game; `min_abs`/`max_abs`
# are the guard rails. `only` restricts a blessing to one entity kind.
const RITE := {
	"rain": {
		"label": "Rite of Rain", "minutes": 6.0, "min_abs": 150.0, "max_abs": 2500.0,
		"mats": {"dewdrop": 2}, "ceremony": 25.0, "hours": 2.0, "strength": 1.0,
		"blessing": {"grow": 1.08}, "only": "",
		"want": "The stones are thirsty. Two dewdrops and a breath of essence.",
		"done": "Rain, the gentle kind. Everything on the island drinks.",
	},
	"warmth": {
		"label": "Rite of Warmth", "minutes": 7.0, "min_abs": 180.0, "max_abs": 3000.0,
		"mats": {"emberbloom": 2}, "ceremony": 30.0, "hours": 3.0, "strength": 1.0,
		"blessing": {"grow": 1.06}, "only": "",
		"want": "Two emberblooms, and the frost will loosen its hold.",
		"done": "Warmth settles over the island. Nothing is cold tonight.",
	},
	"light": {
		"label": "Rite of Light", "minutes": 9.0, "min_abs": 240.0, "max_abs": 4000.0,
		"mats": {"lightwell_glass": 1}, "ceremony": 45.0, "hours": 3.0, "strength": 1.0,
		"blessing": {"yield": 1.10}, "only": "",
		"want": "One pane of lightwell glass. The circle wants to look at the sun.",
		"done": "A day of golden light. Every living thing gives a little more.",
	},
	"roots": {
		"label": "Rite of Roots", "minutes": 11.0, "min_abs": 300.0, "max_abs": 5000.0,
		"mats": {"heartwood": 3}, "ceremony": 60.0, "hours": 4.0, "strength": 1.0,
		"blessing": {"grow": 1.12}, "only": "tree",
		"want": "Three heartwoods. The deep roots are listening for them.",
		"done": "The land deepens. Dormant seeds drift out of the mist at the edge.",
	},
	"kinship": {
		"label": "Rite of Kinship", "minutes": 13.0, "min_abs": 360.0, "max_abs": 6000.0,
		"mats": {"honeycake": 1}, "ceremony": 60.0, "hours": 6.0, "strength": 1.0,
		"blessing": {"bond": 1.50, "cadence": 1.35}, "only": "",
		"want": "A honeycake, set on the stones. Someone may come for it.",
		"done": "Kinship. Something out there turned toward the light.",
	},
	"finding": {
		"label": "Rite of Finding", "minutes": 15.0, "min_abs": 420.0, "max_abs": 7000.0,
		"mats": {"skyshard": 1}, "ceremony": 75.0, "hours": 2.0, "strength": 1.0,
		"blessing": {"luck": 2.00}, "only": "",
		"want": "A skyshard. The circle would like to look for rare things.",
		"done": "Finding. For a while, the island hands you its secrets.",
	},
	"plenty": {
		"label": "Rite of Plenty", "minutes": 18.0, "min_abs": 500.0, "max_abs": 9000.0,
		"mats": {"grainloaf": 2}, "ceremony": 90.0, "hours": 4.0, "strength": 1.0,
		"blessing": {"yield": 1.18}, "only": "",
		"want": "Two grainloaves. Plenty asks to be fed before it feeds.",
		"done": "Plenty. The baskets will run over for a while.",
	},
	"stillness": {
		"label": "Rite of Stillness", "minutes": 20.0, "min_abs": 560.0, "max_abs": 10000.0,
		"mats": {"moonsilver": 1}, "ceremony": 90.0, "hours": 8.0, "strength": 1.0,
		"blessing": {"offline": 12.0}, "only": "",
		"want": "Moonsilver. Stillness keeps better time than you do.",
		"done": "Stillness. Time will be kinder while you are away.",
	},
	"long_year": {
		"label": "Rite of the Long Year", "minutes": 40.0, "min_abs": 1200.0, "max_abs": 24000.0,
		"mats": {"grainloaf": 1, "honeycake": 1, "lightwell_glass": 1, "rootbalm": 1},
		"ceremony": 240.0, "hours": 24.0, "strength": 0.5,
		"blessing": {"grow": 1.12, "yield": 1.18, "bond": 1.50, "luck": 2.00,
			"cadence": 1.35, "craft": 1.20, "offline": 12.0}, "only": "",
		"want": "A loaf, a cake, a pane of glass and a jar of balm. The long year wants all of it.",
		"done": "The Long Year turns. A little of every blessing, for a whole day.",
	},
}

# Only used for whispers + the offering glyphs; Chains owns the real definitions.
const MAT_LABEL := {
	"dewdrop": "Dewdrop", "heartwood": "Heartwood", "emberbloom": "Emberbloom",
	"moonsilver": "Moonsilver", "skyshard": "Skyshard", "lichen_wool": "Lichen Wool",
	"honeycomb": "Honeycomb", "river_clay": "River Clay", "grainloaf": "Grainloaf",
	"honeycake": "Honeycake", "lightwell_glass": "Lightwell Glass", "rootbalm": "Rootbalm",
	"kindling_lamp": "Kindling Lamp", "starcloth": "Starcloth",
}

# =============================================================================
# STATE (runtime only — everything persistent lives in Game.state["rituals"])
# =============================================================================
var world_seed: int = 1

var _space: Node = null
var _interact: Node = null
var _sim: Node = null
var _puzzles: Node = null

var _circle: ProcNode = null
var _heart_bloom: ProcNode = null
var _halos: Dictionary = {}              # place_id -> ProcNode keepsake ring
var _rite_order: Array = []              # rite ids, most-materials first (match priority)

var _acc: float = 0.0
var _vis_acc: float = 0.0
var _last_whisper: float = -999.0
var _last_tap: float = -999.0
var _ascend_armed_until: float = -999.0
var _ymult: Dictionary = {}              # place_id -> cached yield multiplier
var _motes_live: int = 0
var _booted: bool = false
var _rate_cache: float = 0.0             # cached essence income (cost_for)
var _rate_at: float = -999.0
var _bloom_shown: float = -1.0           # last target driven into the heart's bloom


# =============================================================================
# LIFECYCLE
# =============================================================================
func setup(seed_value: int, ctx: Dictionary) -> void:
	world_seed = seed_value
	name = "Rituals"
	var sp: Variant = ctx.get("space", null)
	if sp is Node:
		_space = sp as Node
	var it: Variant = ctx.get("interact", null)
	if it is Node:
		_interact = it as Node
	var sm: Variant = ctx.get("sim", null)
	if sm is Node:
		_sim = sm as Node
	var pz: Variant = ctx.get("puzzles", null)
	if pz is Node:
		_puzzles = pz as Node

	# match priority: the rite that eats the most offerings wins a tie
	var ids: Array = RITE.keys()
	ids.sort_custom(_by_mat_weight)
	_rite_order = ids

	var st: Dictionary = _st()
	if st.is_empty():
		return
	_booted = true

	# the honest yield seam (DYNAMICS §7.2) — optional, degrades to "no yield effect"
	if _space != null and _space.has_method("set_yield_mult_fn"):
		_space.call("set_yield_mult_fn", Callable(self, "_yield_mult_for"))

	if bool(_dict(st, "circle").get("planted", false)):
		_build_circle(false)
	_resolve_timers(true)
	_rebuild_halos()
	_sync_circle()
	_check_ascension_ready(true)
	set_process(true)


# Everything this system schedules is an ABSOLUTE wall-clock stamp (a ceremony's
# `ends`, a blessing's `ends`, a vigil's `ends`), so the away-time curve does not
# apply here: the rites simply resolve. We only have to ANNOUNCE what landed.
func catch_up(_elapsed: float) -> void:
	if not _booted:
		var st: Dictionary = _st()
		if st.is_empty():
			return
		_booted = true
	_resolve_timers(true)
	_sync_circle()
	_check_ascension_ready(true)


func notify(kind: String, payload: Dictionary) -> void:
	match kind:
		"placed":
			var pid: String = String(payload.get("id", payload.get("place_id", "")))
			if pid != "" and is_everbloom(pid):
				_attach_halo(pid)
		"removed":
			var rid: String = String(payload.get("place_id", ""))
			if rid != "":
				_drop_halo(rid)
				_forget_everbloom(rid)
		"event_started":
			if String(payload.get("kind", "")) == "aurora":
				_grant_vigil_charge()
		"arc_gift":
			if String(payload.get("gift", "")) == "everbloom_slot":
				_grant_everbloom_slot()
			elif String(payload.get("gift", "")) == "ritual_circle":
				_plant_circle("a wish")
		"wish_offered":
			# a wish that names a rite needs the circle to exist to be answerable
			if String(payload.get("kind", "")) == "ritual":
				_plant_circle("a wish")
		"material_gained":
			# the first thing you ever gather is reason enough for the stones to rise
			if not circle_planted() and _essence() >= CIRCLE_ESSENCE_GATE * 0.5:
				_plant_circle("the first gathering")
		_:
			pass


# =============================================================================
# STATE  (one key, every field backfilled — a legacy save must load clean)
# =============================================================================
func _st() -> Dictionary:
	if Game == null or not (Game.state is Dictionary):
		return {}
	if not (Game.state.get(SYS_KEY) is Dictionary):
		Game.state[SYS_KEY] = {}
	var st: Dictionary = Game.state[SYS_KEY]
	st["version"] = int(st.get("version", SYS_VERSION))
	st["seq"] = int(st.get("seq", 0))
	if not (st.get("pity") is Dictionary):
		st["pity"] = {}
	var pity: Dictionary = st["pity"]
	pity["hint"] = int(pity.get("hint", 0))
	if not (st.get("circle") is Dictionary):
		st["circle"] = {}
	var circle: Dictionary = st["circle"]
	circle["planted"] = bool(circle.get("planted", false))
	circle["tx"] = float(circle.get("tx", 0.0))
	circle["stones"] = int(circle.get("stones", 3))
	if not (st.get("pending") is Dictionary):
		st["pending"] = {}
	var pending: Dictionary = st["pending"]
	pending["rite"] = String(pending.get("rite", ""))
	if not (pending.get("inputs") is Dictionary):
		pending["inputs"] = {}
	if not (st.get("running") is Dictionary):
		st["running"] = {}
	var running: Dictionary = st["running"]
	running["rite"] = String(running.get("rite", ""))
	running["started"] = float(running.get("started", 0.0))
	running["ends"] = float(running.get("ends", 0.0))
	running["strength"] = float(running.get("strength", 1.0))
	if not (st.get("active") is Dictionary):
		st["active"] = {}
	if not (st.get("done") is Dictionary):
		st["done"] = {}
	if not (st.get("seen") is Dictionary):
		st["seen"] = {}
	if not (st.get("vigils") is Dictionary):
		st["vigils"] = {}
	var vig: Dictionary = st["vigils"]
	vig["n"] = int(vig.get("n", 0))
	vig["last"] = float(vig.get("last", 0.0))
	if not (vig.get("run") is Dictionary):
		vig["run"] = {}
	var vrun: Dictionary = vig["run"]
	vrun["started"] = float(vrun.get("started", 0.0))
	vrun["ends"] = float(vrun.get("ends", 0.0))
	if not (st.get("everbloom") is Array):
		st["everbloom"] = []
	st["slots"] = clampi(int(st.get("slots", BASE_EVERBLOOM)), BASE_EVERBLOOM, MAX_EVERBLOOM)
	if not (st.get("perm") is Dictionary):
		st["perm"] = {}
	if not (st.get("asc") is Dictionary):
		st["asc"] = {}
	var asc: Dictionary = st["asc"]
	asc["announced"] = bool(asc.get("announced", false))
	return st


func _dict(st: Dictionary, key: String) -> Dictionary:
	var v: Variant = st.get(key, null)
	if v is Dictionary:
		return v as Dictionary
	return {}


# Deterministic, reproducible from the SAVE (not from the clock) — DYNAMICS §2.5.
func _rand(tag: String) -> float:
	var st: Dictionary = _st()
	if st.is_empty():
		return 0.5
	var n: int = int(st.get("seq", 0))
	st["seq"] = n + 1
	return Proc.hashf(world_seed, "%s:%s:%d" % [SYS_KEY, tag, n])


# Layout + anything that must be identical in the same world forever: no counter.
func _fixed(tag: String) -> float:
	return Proc.hashf(world_seed, "%s:fix:%s" % [SYS_KEY, tag])


func _now() -> float:
	return float(Time.get_unix_time_from_system())


func _nowf() -> float:
	return float(Time.get_ticks_msec()) / 1000.0


func _by_mat_weight(a: Variant, b: Variant) -> bool:
	return _mat_weight(String(a)) > _mat_weight(String(b))


func _mat_weight(rite_id: String) -> int:
	var mats: Dictionary = _def(rite_id).get("mats", {}) as Dictionary
	var n: int = 0
	for k in mats.keys():
		n += int(mats[k])
	return n


func _def(rite_id: String) -> Dictionary:
	var v: Variant = RITE.get(rite_id, null)
	if v is Dictionary:
		return v as Dictionary
	return {}


# =============================================================================
# SIBLINGS  (node name + duck typing; every call optional — DYNAMICS §4.1)
# =============================================================================
func _sib(n: String) -> Node:
	var p: Node = get_parent()
	if p == null:
		return null
	return p.get_node_or_null(n)


func _chains() -> Node:
	var c: Node = _sib("Chains")
	if c != null and c.has_method("stock"):
		return c
	return null


func _discovery() -> Node:
	var d: Node = _sib("Discovery")
	if d != null and d.has_method("discover"):
		return d
	return null


func _seasons() -> Node:
	return _sib("SeasonsEvents")


# The one shared formula (DYNAMICS §2.1). Works with any or all siblings absent.
func effective(key: String, place_id: String) -> float:
	var m: float = 1.0
	var s: Node = _seasons()
	if s != null and s.has_method("modifier"):
		m *= float(s.call("modifier", key))
	m *= blessing_for(key, _kind_of(place_id))
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
	return clampf(m, FLOOR_MULT, float(CAP.get(key, 1.5)))


# =============================================================================
# QUERIES  (DYNAMICS §4.4 — Rituals' half of the read-only surface)
# =============================================================================

# The single authority for temporary world-wide multipliers + permanent arc grants.
# NOTE: "offline" is special and returns HOURS of full offline credit (8.0 base,
# up to 12.0 under the Rite of Stillness), exactly as the siblings' _full_hours()
# helpers expect.
func blessing(key: String) -> float:
	return blessing_for(key, "")


# Kind-aware: a rite with an `only` filter (Rite of Roots → trees) is counted only
# for that kind. Pass "" to get the unrestricted, world-wide value.
func blessing_for(key: String, kind: String) -> float:
	var offline: bool = key == "offline"
	var st: Dictionary = _st()
	if st.is_empty():
		return OFFLINE_FULL_HOURS if offline else 1.0
	var hours: float = OFFLINE_FULL_HOURS
	var m: float = 1.0
	var active: Dictionary = _dict(st, "active")
	var now: float = _now()
	for rid_v in active.keys():
		var row: Dictionary = active[rid_v] if active[rid_v] is Dictionary else {}
		if float(row.get("ends", 0.0)) <= now:
			continue
		var def: Dictionary = _def(String(rid_v))
		if def.is_empty():
			continue
		# a rite with an `only` filter counts for that kind and nothing else
		var only: String = String(def.get("only", ""))
		if only != "" and only != kind:
			continue
		var bl: Dictionary = def.get("blessing", {}) as Dictionary
		if not bl.has(key):
			continue
		var v: float = float(bl[key])
		var strength: float = clampf(float(row.get("strength", 1.0)), 0.1, 1.0)
		if offline:
			# hours interpolate toward the rite's value rather than multiplying
			hours = maxf(hours, OFFLINE_FULL_HOURS + (v - OFFLINE_FULL_HOURS) * strength)
		else:
			m *= pow(v, strength)
	if offline:
		return clampf(hours, OFFLINE_FULL_HOURS, float(BLESS_CAP.get("offline", 12.0)))
	m *= 1.0 + permanent(key)
	return clampf(m, FLOOR_MULT, float(BLESS_CAP.get(key, 1.30)))


func is_active(rite_id: String) -> bool:
	var st: Dictionary = _st()
	if st.is_empty():
		return false
	var row: Variant = _dict(st, "active").get(rite_id, null)
	if not (row is Dictionary):
		return false
	return float((row as Dictionary).get("ends", 0.0)) > _now()


func active_rites() -> Array:
	var out: Array = []
	var st: Dictionary = _st()
	if st.is_empty():
		return out
	var now: float = _now()
	var active: Dictionary = _dict(st, "active")
	for rid_v in active.keys():
		var row: Dictionary = active[rid_v] if active[rid_v] is Dictionary else {}
		if float(row.get("ends", 0.0)) > now:
			out.append({"rite": String(rid_v), "ends": float(row.get("ends", 0.0)),
				"strength": float(row.get("strength", 1.0))})
	return out


func cost_for(rite_id: String) -> Dictionary:
	var def: Dictionary = _def(rite_id)
	if def.is_empty():
		return {}
	var mins: float = float(def.get("minutes", 6.0))
	var ess: float = clampf(mins * 60.0 * _essence_rate(),
		float(def.get("min_abs", 150.0)), float(def.get("max_abs", 2500.0)))
	ess *= 1.0 + 0.30 * float(_asc_count())
	ess *= _astral_discount()
	var mats: Dictionary = {}
	var ch: Node = _chains()
	if ch != null:
		var raw: Dictionary = def.get("mats", {}) as Dictionary
		for k in raw.keys():
			mats[String(k)] = int(raw[k])
	else:
		# no material layer mounted: the rite is essence-only, at a fair surcharge
		ess *= 1.5
	return {"essence": ess, "materials": mats}


func is_everbloom(place_id: String) -> bool:
	var st: Dictionary = _st()
	if st.is_empty():
		return false
	var arr: Array = st.get("everbloom", []) as Array
	return arr.has(place_id)


func circle_planted() -> bool:
	var st: Dictionary = _st()
	if st.is_empty():
		return false
	return bool(_dict(st, "circle").get("planted", false))


func vigil_count() -> int:
	var st: Dictionary = _st()
	if st.is_empty():
		return 0
	return int(_dict(st, "vigils").get("n", 0))


func done_count(rite_id: String) -> int:
	var st: Dictionary = _st()
	if st.is_empty():
		return 0
	return int(_dict(st, "done").get(rite_id, 0))


func rite_ids() -> Array:
	return RITE.keys()


func rite_label(rite_id: String) -> String:
	return String(_def(rite_id).get("label", "an old rite"))


func offline_full_hours() -> float:
	return blessing("offline")


# Wishes' arc completions land here so they sit inside the §2.1 clamps.
func register_permanent(key: String, amount: float) -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	var p: Dictionary = _dict(st, "perm")
	var total: float = 0.0
	for k in p.keys():
		total += float(p[k])
	var room: float = maxf(0.0, PERM_MAX - total)
	if room <= 0.0:
		return
	p[String(key)] = clampf(float(p.get(key, 0.0)) + minf(maxf(0.0, amount), room), 0.0, PERM_MAX)
	emit_signal("dyn_event", "blessing_changed",
		{"key": key, "mult": blessing(key), "until": 0.0})


func permanent(key: String) -> float:
	var st: Dictionary = _st()
	if st.is_empty():
		return 0.0
	return clampf(float(_dict(st, "perm").get(key, 0.0)), 0.0, PERM_MAX)


# =============================================================================
# TICK
# =============================================================================
func _process(delta: float) -> void:
	if not _booted:
		return
	if Game == null or not Game.booted:
		return
	_vis_acc += delta
	if _vis_acc >= VIS_TICK:
		_vis_acc = 0.0
		_refresh_running_visual()
	_acc += delta
	if _acc < TICK:
		return
	var step: float = _acc
	_acc = 0.0
	_logic(step)


func _logic(_step: float) -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	_maybe_plant_circle()
	_resolve_timers(false)
	_try_begin_rite()
	_check_ascension_ready(false)
	_refresh_mult_cache()
	_apply_grow_blessings()
	_sync_circle()


# Resolve every absolute wall-clock stamp: a ceremony finishing, a blessing fading,
# a vigil completing. Safe to call at boot, on wake, and every tick.
func _resolve_timers(quiet: bool) -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	var now: float = _now()
	# 1. a ceremony that finished (possibly while the app was closed)
	var running: Dictionary = _dict(st, "running")
	var rid: String = String(running.get("rite", ""))
	if rid != "" and float(running.get("ends", 0.0)) <= now:
		_complete_rite(rid, float(running.get("strength", 1.0)), quiet)
		running["rite"] = ""
		running["started"] = 0.0
		running["ends"] = 0.0
		running["strength"] = 1.0
	# 2. blessings that have quietly faded
	var active: Dictionary = _dict(st, "active")
	var expired: Array = []
	for k in active.keys():
		var row: Dictionary = active[k] if active[k] is Dictionary else {}
		if float(row.get("ends", 0.0)) <= now:
			expired.append(String(k))
	for k2 in expired:
		active.erase(k2)
		emit_signal("dyn_event", "blessing_changed",
			{"key": "", "mult": 1.0, "until": 0.0, "rite": k2, "faded": true})
	if not expired.is_empty() and not quiet:
		_say("The light settles. The island keeps what it grew.")
	# 3. a vigil that burned down to its end
	var vig: Dictionary = _dict(st, "vigils")
	var vrun: Dictionary = _dict(vig, "run")
	if float(vrun.get("ends", 0.0)) > 0.0 and float(vrun.get("ends", 0.0)) <= now:
		vrun["started"] = 0.0
		vrun["ends"] = 0.0
		vig["n"] = clampi(int(vig.get("n", 0)) + 1, 0, VIGILS_NEEDED)
		vig["last"] = now
		_on_vigil_done(int(vig["n"]), quiet)


# =============================================================================
# THE CIRCLE — raising it, keeping it in sync with the state
# =============================================================================
func _maybe_plant_circle() -> void:
	if circle_planted():
		return
	if _essence() >= CIRCLE_ESSENCE_GATE:
		_plant_circle("essence enough")


func _plant_circle(_why: String) -> void:
	if circle_planted():
		return
	var st: Dictionary = _st()
	if st.is_empty() or _space == null:
		return
	var circle: Dictionary = _dict(st, "circle")
	circle["tx"] = _choose_circle_tx()
	circle["planted"] = true
	circle["stones"] = 3
	_build_circle(true)
	_sync_circle()
	_say("Stones rise out of the soil at the roots. They are listening.")
	if Game != null:
		Game.save_now()


# Seeded, stable, and nudged outward past anything already standing there.
func _choose_circle_tx() -> float:
	var base: float = _heart_tx() + CIRCLE_OFFSET + (_fixed("circle:tx") - 0.5) * 100.0
	for _i in range(6):
		if not _occupied_at(base):
			break
		base += 92.0
	return base


func _occupied_at(tx: float) -> bool:
	var recs: Array = _records()
	for item in recs:
		var r: Dictionary = item
		if absf(float(r.get("tx", 0.0)) - tx) < CIRCLE_RADIUS * 1.1:
			return true
	return false


func _build_circle(fresh: bool) -> void:
	if _circle != null and is_instance_valid(_circle):
		return
	var st: Dictionary = _st()
	if st.is_empty():
		return
	var tx: float = float(_dict(st, "circle").get("tx", 0.0))
	_circle = RitualArt.make_circle(world_seed, "circle", {
		"radius": CIRCLE_RADIUS, "palette": Proc.palette(world_seed, "ritual")})
	_circle.position = _ground_point(tx)
	add_child(_circle)
	if fresh:
		# it unfurls out of the soil over 8 seconds — never a pop
		_circle.set_growth(0.0)
		_circle.grow_to(1.0, CIRCLE_UNFURL)
	else:
		_circle.set_growth(1.0)


func _sync_circle() -> void:
	if _circle == null or not is_instance_valid(_circle):
		return
	var st: Dictionary = _st()
	if st.is_empty():
		return
	var total_done: int = 0
	var done: Dictionary = _dict(st, "done")
	for k in done.keys():
		total_done += int(done[k])
	var stones: int = clampi(3 + int(total_done / 3), 3, 7)
	if _ascension_ready():
		stones = 8                       # the eighth stone: the ceremony is possible
	_circle.call("set_stones", stones)
	var circle: Dictionary = _dict(st, "circle")
	circle["stones"] = stones
	# offerings resting on the stones
	var offerings: Array = []
	var inputs: Dictionary = _dict(_dict(st, "pending"), "inputs")
	for k2 in inputs.keys():
		offerings.append({"mat": String(k2), "n": int(inputs[k2])})
	_circle.call("set_offerings", offerings)
	# the runes ARE the progress bar
	var running: Dictionary = _dict(st, "running")
	var rid: String = String(running.get("rite", ""))
	if rid != "":
		_circle.call("set_runes", RUNES, RUNES)
		_circle.call("set_running", true, _run_u(running))
	else:
		var ch: Dictionary = _charge()
		_circle.call("set_runes", int(round(float(ch.get("prog", 0.0)) * float(RUNES))), RUNES)
		_circle.call("set_running", false, 0.0)
	_circle.call("set_vigils", vigil_count())
	_circle.call("set_blessings", active_rites().size())


func _refresh_running_visual() -> void:
	if _circle == null or not is_instance_valid(_circle):
		return
	var st: Dictionary = _st()
	if st.is_empty():
		return
	var running: Dictionary = _dict(st, "running")
	if String(running.get("rite", "")) == "":
		return
	_circle.call("set_running", true, _run_u(running))


func _run_u(running: Dictionary) -> float:
	var a: float = float(running.get("started", 0.0))
	var b: float = float(running.get("ends", 0.0))
	if b <= a:
		return 1.0
	return clampf((_now() - a) / (b - a), 0.0, 1.0)


# How close the stones are to a rite right now: the one thing the runes draw.
func _charge() -> Dictionary:
	var st: Dictionary = _st()
	if st.is_empty():
		return {"rite": "", "prog": 0.0}
	var inputs: Dictionary = _dict(_dict(st, "pending"), "inputs")
	var best: String = ""
	var best_mat: float = -1.0
	for rid_v in _rite_order:
		var rid: String = String(rid_v)
		var mats: Dictionary = _def(rid).get("mats", {}) as Dictionary
		var need: float = 0.0
		var have: float = 0.0
		for m in mats.keys():
			var n: int = int(mats[m])
			need += float(n)
			have += float(mini(int(inputs.get(m, 0)), n))
		if need <= 0.0:
			continue
		var frac: float = have / need
		if frac > best_mat:
			best_mat = frac
			best = rid
	if best == "" or best_mat <= 0.0:
		best = _hint_rite()
		best_mat = 0.0
	var cost: Dictionary = cost_for(best)
	var ess_need: float = float(cost.get("essence", 1.0))
	var ess_prog: float = clampf(_essence() / maxf(1.0, ess_need), 0.0, 1.0)
	return {"rite": best, "prog": clampf(best_mat * 0.7 + ess_prog * 0.3, 0.0, 1.0),
		"mat": best_mat, "ess": ess_prog}


# The rite the stones murmur about: something the player can actually reach.
# Pity-guarded so the hint eventually names an affordable rite rather than a dream.
func _hint_rite() -> String:
	var st: Dictionary = _st()
	if st.is_empty():
		return "rain"
	var reachable: Array = []
	var affordable: Array = []
	for rid_v in RITE.keys():
		var rid: String = String(rid_v)
		var cost: Dictionary = cost_for(rid)
		var mats: Dictionary = cost.get("materials", {}) as Dictionary
		var ok := true
		var ch: Node = _chains()
		if ch != null:
			for m in mats.keys():
				if int(ch.call("stock", String(m))) < int(mats[m]):
					ok = false
					break
		if ok:
			reachable.append(rid)
			if _essence() >= float(cost.get("essence", 0.0)):
				affordable.append(rid)
	var pity: Dictionary = _dict(st, "pity")
	var misses: int = int(pity.get("hint", 0))
	if not affordable.is_empty() and (misses >= 4 or reachable.size() == affordable.size()):
		pity["hint"] = 0
		return String(affordable[int(_rand("hint:aff") * float(affordable.size())) % affordable.size()])
	pity["hint"] = misses + 1
	if not reachable.is_empty():
		return String(reachable[int(_rand("hint:reach") * float(reachable.size())) % reachable.size()])
	return "rain"


# =============================================================================
# PERFORMING A RITE  (drag an offering onto the stones — no recipe list, ever)
# =============================================================================

# A rite begins on its own the moment the stones hold everything it wants AND the
# essence pool is deep enough. Nothing is consumed before that instant.
func _try_begin_rite() -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	if String(_dict(st, "running").get("rite", "")) != "":
		return
	if float(_dict(_dict(st, "vigils"), "run").get("ends", 0.0)) > 0.0:
		return
	var inputs: Dictionary = _dict(_dict(st, "pending"), "inputs")
	if inputs.is_empty():
		return
	for rid_v in _rite_order:
		var rid: String = String(rid_v)
		var mats: Dictionary = _def(rid).get("mats", {}) as Dictionary
		if mats.is_empty():
			continue
		var complete := true
		for m in mats.keys():
			if int(inputs.get(m, 0)) < int(mats[m]):
				complete = false
				break
		if not complete:
			continue
		var cost: Dictionary = cost_for(rid)
		var ess: float = float(cost.get("essence", 0.0))
		if _essence() < ess:
			# it is ready but hungry — say so once, gently, and wait forever
			_say("%s waits on the stones. It wants one more breath of essence." % rite_label(rid))
			return
		# consume: the materials off the stones, the essence out of the pool
		for m2 in mats.keys():
			var left: int = int(inputs.get(m2, 0)) - int(mats[m2])
			if left > 0:
				inputs[String(m2)] = left
			else:
				inputs.erase(m2)
		if Game != null:
			Game.spend({"essence": ess})
		_begin_ceremony(rid)
		return


func _begin_ceremony(rid: String) -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	var def: Dictionary = _def(rid)
	var now: float = _now()
	var secs: float = maxf(5.0, float(def.get("ceremony", 30.0)))
	var running: Dictionary = _dict(st, "running")
	running["rite"] = rid
	running["started"] = now
	running["ends"] = now + secs
	running["strength"] = clampf(float(def.get("strength", 1.0)), 0.1, 1.0)
	_dict(st, "pending")["rite"] = rid
	_sync_circle()
	_essence_motes_to_circle(6)
	_say("%s begins. The runes are complete." % rite_label(rid))
	emit_signal("dyn_event", "rite_started",
		{"rite": rid, "ends": running["ends"], "strength": running["strength"],
		 "blessing": (def.get("blessing", {}) as Dictionary).duplicate(),
		 "hours": float(def.get("hours", 2.0))})
	if Game != null:
		Game.save_now()


func _complete_rite(rid: String, strength: float, quiet: bool) -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	var def: Dictionary = _def(rid)
	if def.is_empty():
		return
	var now: float = _now()
	var active: Dictionary = _dict(st, "active")
	# only three blessings may burn at once; a fourth replaces the weakest, out loud
	if not active.has(rid) and active.size() >= MAX_ACTIVE_RITES:
		var weakest: String = _weakest_active()
		if weakest != "":
			active.erase(weakest)
			if not quiet:
				_say("%s makes room for %s." % [rite_label(weakest), rite_label(rid)])
	active[rid] = {"started": now, "ends": now + float(def.get("hours", 2.0)) * 3600.0,
		"strength": clampf(strength, 0.1, 1.0)}
	var done: Dictionary = _dict(st, "done")
	done[rid] = int(done.get(rid, 0)) + 1
	_dict(st, "pending")["rite"] = ""
	# the wave of light that crosses the island
	if not quiet:
		_light_wave()
		_say(String(def.get("done", "The rite lands. The island is blessed.")))
	# a first performance is a leaf on the Journal Tree
	var seen: Dictionary = _dict(st, "seen")
	if not bool(seen.get(rid, false)):
		seen[rid] = true
		var dc: Node = _discovery()
		if dc != null:
			dc.call("discover", "rite:%s" % rid, {
				"category": "rites", "label": rite_label(rid), "tier": "leaf",
				"line": String(def.get("done", ""))})
	if rid == "long_year":
		var dc2: Node = _discovery()
		if dc2 != null:
			dc2.call("discover", "rite:long_year:blossom", {
				"category": "rites", "label": "The Long Year", "tier": "blossom",
				"line": "A whole year of the island, held in one night."})
	emit_signal("dyn_event", "rite_done",
		{"rite": rid, "ends": float((active[rid] as Dictionary).get("ends", now)),
		 "strength": strength})
	for key in (def.get("blessing", {}) as Dictionary).keys():
		emit_signal("dyn_event", "blessing_changed", {"key": String(key),
			"mult": blessing(String(key)),
			"until": float((active[rid] as Dictionary).get("ends", now))})
	# the two rites that give something you can walk over and touch
	if rid == "roots":
		_deepen_the_land()
	elif rid == "kinship":
		_call_a_companion()
	if Game != null:
		Game.save_now()


func _weakest_active() -> String:
	var st: Dictionary = _st()
	if st.is_empty():
		return ""
	var active: Dictionary = _dict(st, "active")
	var worst: String = ""
	var worst_mag: float = INF
	for k in active.keys():
		var rid: String = String(k)
		var bl: Dictionary = _def(rid).get("blessing", {}) as Dictionary
		var mag: float = 0.0
		for key in bl.keys():
			if String(key) == "offline":
				mag += 0.1
			else:
				mag += absf(float(bl[key]) - 1.0)
		var row: Dictionary = active[k] if active[k] is Dictionary else {}
		mag *= clampf(float(row.get("strength", 1.0)), 0.1, 1.0)
		if mag < worst_mag:
			worst_mag = mag
			worst = rid
	return worst


# ---------------------------------------------------------------------------
# RITE OF ROOTS — "deepen the land".
# IDLE-DESIGN §3.4 keeps puzzles the ONLY way ground is won, so the rite does not
# hand over land: it calls the dormant seed-nodes out of the mist at the island's
# edge and leaves them there to be woven. If the puzzle layer is absent the rite
# wakes the ground directly instead, so the blessing is never a dead end.
# ---------------------------------------------------------------------------
func _deepen_the_land() -> void:
	var made := false
	if _puzzles != null and _puzzles.has_method("add_rootwork") and _space != null:
		var n: int = int(_puzzles.get("expansion_level")) if _has_prop(_puzzles, "expansion_level") else 0
		var side: float = 1.0 if _fixed("deepen:%d" % n) > 0.4 else -1.0
		var span: Vector2 = _ground_span()
		var tx: float = (span.y - 70.0) if side > 0.0 else (span.x + 70.0)
		tx += side * (40.0 + 90.0 * _rand("deepen:off"))
		var pos: Vector2 = _ground_point(tx) + Vector2(0.0, -70.0)
		# the puzzle layer lives in the same cam space as us
		var local: Vector2 = pos
		if _puzzles is Node2D:
			local = pos - (_puzzles as Node2D).position
		_puzzles.call("add_rootwork", "rite:roots:%d" % (done_count("roots")), local,
			clampi(4 + int(done_count("roots") / 2), 4, 7))
		made = true
	if not made and _space != null and _space.has_method("awaken_region"):
		_space.call("awaken_region", 1, "rite:roots:%d" % done_count("roots"))
		made = true
	if made:
		_say("Dormant seeds drift out of the mist at the island's edge.")
		emit_signal("dyn_event", "land_called", {"rite": "roots", "n": done_count("roots")})


# ---------------------------------------------------------------------------
# RITE OF KINSHIP — "call a companion". Someone out there turns toward the light
# and arrives as an egg in your basket (growth -1.0, so the existing placement
# path hatches it by growing it, exactly as the starter egg does).
# ---------------------------------------------------------------------------
func _call_a_companion() -> void:
	var pool: Array = []
	if GameData != null and GameData.blocklings is Array:
		for b in GameData.blocklings:
			var row: Dictionary = b
			var sid: String = String(row.get("id", ""))
			if sid != "":
				pool.append(sid)
	if pool.is_empty():
		pool = ["pip"]
	# prefer someone the player has already met, so the arrival feels like a return
	var known: Array = []
	if Game != null and Game.state is Dictionary and Game.state.get("discovered") is Dictionary:
		var disc: Dictionary = Game.state["discovered"]
		for sid2 in pool:
			if bool(disc.get(String(sid2), false)):
				known.append(sid2)
	var from: Array = known if (not known.is_empty() and _rand("comp:known") < 0.6) else pool
	var pick: String = String(from[int(_rand("comp:pick") * float(from.size())) % from.size()])
	var label: String = pick.capitalize()
	if GameData != null and GameData.blocklings_by_id is Dictionary:
		var def: Dictionary = GameData.blocklings_by_id.get(pick, {}) as Dictionary
		label = String(def.get("name", label))
	_grant("egg:%s" % pick, {"kind": "creature", "species": pick,
		"label": "%s (egg)" % label, "growth": -1.0, "minted": false}, 1)
	_say("Someone turned toward the light. %s is waiting in your basket." % label)
	emit_signal("dyn_event", "companion_called", {"species": pick, "item_key": "egg:%s" % pick})


# =============================================================================
# THE ASCENSION CEREMONY  (three nights, then the world folds into a seed)
# =============================================================================
func _ascension_ready() -> bool:
	if Ascension == null or not Ascension.has_method("can_ascend"):
		return false
	return bool(Ascension.can_ascend())


func _check_ascension_ready(quiet: bool) -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	var ready: bool = _ascension_ready()
	var asc: Dictionary = _dict(st, "asc")
	if ready and _heart_bloom == null:
		_attach_heart_bloom()
	if not ready and _heart_bloom != null and is_instance_valid(_heart_bloom):
		_heart_bloom.queue_free()
		_heart_bloom = null
	if ready and not bool(asc.get("announced", false)):
		asc["announced"] = true
		if not quiet:
			_say("The tree is ready to begin again. It asks for three nights.")
		emit_signal("dyn_event", "ascension_ready", {"vigils": vigil_count(), "of": VIGILS_NEEDED})


func _attach_heart_bloom() -> void:
	if _space == null or not _space.has_method("heart_node"):
		return
	var heart: Variant = _space.call("heart_node")
	if not (heart is Node2D) or not is_instance_valid(heart as Node2D):
		return
	var hr: float = 240.0
	if _has_prop(heart as Object, "footprint_radius"):
		hr = maxf(140.0, float((heart as Object).get("footprint_radius")))
	_heart_bloom = RitualArt.make_heart_bloom(world_seed, "asc", {"radius": hr, "ramp": 24.0})
	(heart as Node2D).add_child(_heart_bloom)


func _vigil_ready() -> Dictionary:
	var st: Dictionary = _st()
	if st.is_empty():
		return {"ok": false, "why": ""}
	if not _ascension_ready():
		return {"ok": false, "why": ""}
	var vig: Dictionary = _dict(st, "vigils")
	if int(vig.get("n", 0)) >= VIGILS_NEEDED:
		return {"ok": false, "why": "The three lanterns are lit. The tree is waiting for your hand."}
	if float(_dict(vig, "run").get("ends", 0.0)) > 0.0:
		return {"ok": false, "why": "The vigil is already burning. Let it."}
	if String(_dict(st, "running").get("rite", "")) != "":
		return {"ok": false, "why": "One ceremony at a time."}
	var now: float = _now()
	var s: Node = _seasons()
	if s != null and s.has_method("is_night"):
		if not bool(s.call("is_night")):
			return {"ok": false, "why": "A vigil belongs to the night. Come back when it is dark."}
		if now - float(vig.get("last", 0.0)) < VIGIL_MIN_GAP:
			return {"ok": false, "why": "One vigil a night. This one has had its vigil."}
	elif now - float(vig.get("last", 0.0)) < VIGIL_GAP_NO_SEASONS:
		return {"ok": false, "why": "Not yet. The tree keeps its own hours."}
	return {"ok": true, "why": ""}


func _begin_vigil() -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	var now: float = _now()
	var vrun: Dictionary = _dict(_dict(st, "vigils"), "run")
	vrun["started"] = now
	vrun["ends"] = now + VIGIL_SECONDS
	_sync_circle()
	_essence_motes_to_circle(4)
	_say("The first vigil of the night begins. Stay, or don't — it will keep.")
	emit_signal("dyn_event", "vigil_started", {"n": vigil_count(), "of": VIGILS_NEEDED})
	if Game != null:
		Game.save_now()


func _on_vigil_done(n: int, quiet: bool) -> void:
	_sync_circle()
	if not quiet:
		_motes_to_heart(5)
		if n >= VIGILS_NEEDED:
			_say("Three lanterns. Hold the Heart Tree's trunk when you are ready.")
		else:
			_say("A lantern catches. %d of three nights." % n)
	emit_signal("dyn_event", "vigil", {"n": n, "of": VIGILS_NEEDED})
	if Game != null:
		Game.save_now()


# An Aurora is a free night of vigil — the sky did the ceremony for you.
func _grant_vigil_charge() -> void:
	var st: Dictionary = _st()
	if st.is_empty() or not _ascension_ready():
		return
	var vig: Dictionary = _dict(st, "vigils")
	if int(vig.get("n", 0)) >= VIGILS_NEEDED:
		return
	vig["n"] = clampi(int(vig.get("n", 0)) + 1, 0, VIGILS_NEEDED)
	vig["last"] = _now()
	_say("The aurora keeps the vigil for you. A lantern lights itself.")
	_on_vigil_done(int(vig["n"]), false)


func _do_ascend() -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	if not _ascension_ready():
		_say("Not yet. The tree is still gathering.")
		return
	if vigil_count() < VIGILS_NEEDED:
		_say("Three nights first. The tree is not in a hurry.")
		return
	# the ceremony you can see: the world folds into one seed, and opens again
	var at: Vector2 = _heart_point()
	var fold: ProcNode = RitualArt.make_seed_fold(world_seed, "ascend:%d" % _asc_count(),
		{"radius": 620.0, "life": 5.0})
	fold.position = at + Vector2(0.0, -220.0)
	add_child(fold)
	_light_wave()
	# what the next world remembers
	var kept: Array = []
	var arr: Array = st.get("everbloom", []) as Array
	for pid_v in arr:
		var label: String = _label_of(String(pid_v))
		if label != "":
			kept.append(label)
	if Ascension != null and Ascension.has_method("ascend"):
		Ascension.ascend()
	# our own reset: the blessings and the half-made offerings go; the KNOWLEDGE
	# (which rites you have performed, the arc grants, the keepsake list) stays.
	_dict(st, "active").clear()
	var pending: Dictionary = _dict(st, "pending")
	pending["rite"] = ""
	_dict(pending, "inputs").clear()
	var running: Dictionary = _dict(st, "running")
	running["rite"] = ""
	running["started"] = 0.0
	running["ends"] = 0.0
	var vig: Dictionary = _dict(st, "vigils")
	vig["n"] = 0
	vig["last"] = _now()
	_dict(vig, "run")["started"] = 0.0
	_dict(vig, "run")["ends"] = 0.0
	_dict(st, "asc")["announced"] = false
	if _heart_bloom != null and is_instance_valid(_heart_bloom):
		_heart_bloom.queue_free()
		_heart_bloom = null
	_sync_circle()
	if kept.is_empty():
		_say("The world folds into a seed, and opens again.")
	else:
		_say("The world folds into a seed. It remembers %s." % _join_words(kept))
	emit_signal("dyn_event", "ascended", {"count": _asc_count(), "kept": kept})
	if Game != null:
		Game.save_now()


# =============================================================================
# EVERBLOOM — the keepsakes the next world remembers
# =============================================================================
func _everbloom_slots() -> int:
	var st: Dictionary = _st()
	if st.is_empty():
		return BASE_EVERBLOOM
	return clampi(int(st.get("slots", BASE_EVERBLOOM)), BASE_EVERBLOOM, MAX_EVERBLOOM)


func _grant_everbloom_slot() -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	var cur: int = _everbloom_slots()
	if cur >= MAX_EVERBLOOM:
		return
	st["slots"] = cur + 1
	_say("The deep roots make room for one more keepsake.")


func _everbloom_eligible(record: Dictionary) -> bool:
	if record.is_empty():
		return false
	var pid: String = String(record.get("id", ""))
	if pid == "":
		return false
	if is_everbloom(pid):
		return true
	if _everbloom_count() >= _everbloom_slots():
		return false
	# only something you grew and kept: Beloved (Nurture), minted, or fully mature
	if bool(record.get("minted", false)):
		return true
	var nu: Node = _sib("Nurture")
	if nu != null and nu.has_method("is_beloved") and bool(nu.call("is_beloved", pid)):
		return true
	var node: Variant = record.get("node", null)
	if node is ProcNode and is_instance_valid(node as ProcNode):
		return float((node as ProcNode).growth) >= 0.999
	return false


func _everbloom_count() -> int:
	var st: Dictionary = _st()
	if st.is_empty():
		return 0
	return (st.get("everbloom", []) as Array).size()


func _toggle_everbloom(record: Dictionary) -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	var pid: String = String(record.get("id", ""))
	if pid == "":
		return
	var arr: Array = st.get("everbloom", []) as Array
	if arr.has(pid):
		arr.erase(pid)
		_drop_halo(pid)
		_say("Let go. It will live this world and no further.")
	else:
		if arr.size() >= _everbloom_slots():
			_say("The circle can only carry %d keepsakes across." % _everbloom_slots())
			return
		arr.append(pid)
		_attach_halo(pid)
		_say("%s will be remembered by the next world." % _label_of(pid))
	emit_signal("dyn_event", "everbloom", {"place_id": pid, "kept": arr.has(pid),
		"of": _everbloom_slots()})
	if Game != null:
		Game.save_now()


func _forget_everbloom(place_id: String) -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	var arr: Array = st.get("everbloom", []) as Array
	if arr.has(place_id):
		arr.erase(place_id)


func _rebuild_halos() -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	for pid_v in (st.get("everbloom", []) as Array):
		_attach_halo(String(pid_v))


func _attach_halo(place_id: String) -> void:
	if _halos.has(place_id) and is_instance_valid(_halos[place_id]):
		return
	var rec: Dictionary = _record(place_id)
	if rec.is_empty():
		return
	var node: Variant = rec.get("node", null)
	if not (node is Node2D) or not is_instance_valid(node as Node2D):
		return
	var fr: float = maxf(26.0, float(rec.get("footprint", 30.0)))
	var halo: ProcNode = RitualArt.make_keepsake(world_seed, "keep:%s" % place_id,
		{"radius": fr * 1.25, "z": 0})
	(node as Node2D).add_child(halo)
	_halos[place_id] = halo


func _drop_halo(place_id: String) -> void:
	if not _halos.has(place_id):
		return
	var h: Variant = _halos[place_id]
	if h is Node and is_instance_valid(h as Node) and (h as Node).has_method("fade_out"):
		(h as Node).call("fade_out", 0.4)
	_halos.erase(place_id)


# =============================================================================
# MULTIPLIER APPLICATION  (DYNAMICS §7.2 — recompute from base, never accumulate)
# =============================================================================
func _refresh_mult_cache() -> void:
	_ymult.clear()
	for item in _records():
		var r: Dictionary = item
		var pid: String = String(r.get("id", ""))
		if pid == "":
			continue
		_ymult[pid] = effective("yield", pid)


# WorldSpace's optional per-record yield hook. Reads a cache refreshed every tick,
# so this stays free even when it is called for every record every frame.
func _yield_mult_for(record: Dictionary) -> float:
	var pid: String = String(record.get("id", ""))
	if pid == "" or not _ymult.has(pid):
		return 1.0
	return clampf(float(_ymult[pid]), FLOOR_MULT, float(CAP.get("yield", 1.6)))


func _apply_grow_blessings() -> void:
	for item in _records():
		var r: Dictionary = item
		var node_v: Variant = r.get("node", null)
		if not (node_v is ProcNode) or not is_instance_valid(node_v as ProcNode):
			continue
		var node: ProcNode = node_v as ProcNode
		var pid: String = String(r.get("id", ""))
		# a pressed flower keeps its clock stopped — never thaw what the player froze
		if bool(r.get("minted", false)):
			continue
		if Growth != null and Growth.has_method("is_frozen") and bool(Growth.call("is_frozen", pid)):
			continue
		if not node.has_meta("dyn_base_grow"):
			node.set_meta("dyn_base_grow", float(node.grow_rate))
		var base: float = float(node.get_meta("dyn_base_grow", node.grow_rate))
		if base <= 0.0:
			continue
		node.grow_rate = base * effective("grow", pid)


func _kind_of(place_id: String) -> String:
	if place_id == "":
		return ""
	var r: Dictionary = _record(place_id)
	if r.is_empty():
		return ""
	var entry: Dictionary = r.get("entry", {}) as Dictionary
	return String(entry.get("kind", ""))


# =============================================================================
# GESTURES
# =============================================================================

# One new verb, and only where it means something.
func extra_actions(record: Dictionary) -> Array:
	var out: Array = []
	if not _ascension_ready():
		return out
	if _everbloom_eligible(record):
		out.append("everbloom")
	return out


func handle_action(action: String, record: Dictionary) -> bool:
	if action != "everbloom":
		return false
	_toggle_everbloom(record)
	return true


# An offering dragged out of the basket onto the stones. Materials rest there and
# light a rune; anything living is simply not our business (we return false and the
# ordinary placement path plants it).
func handle_drop(entry: Dictionary, _inst_key: String, world_pos: Vector2) -> bool:
	if not circle_planted() or _circle == null or not is_instance_valid(_circle):
		return false
	if not _near_circle(world_pos, 1.0):
		return false
	if String(entry.get("kind", "")) != "material":
		return false
	var mid: String = String(entry.get("species", ""))
	if mid == "":
		return false
	var st: Dictionary = _st()
	if st.is_empty():
		return false
	var inputs: Dictionary = _dict(_dict(st, "pending"), "inputs")
	inputs[mid] = int(inputs.get(mid, 0)) + 1
	_offer_mote(world_pos, mid)
	_sync_circle()
	_say(_offer_line(mid))
	emit_signal("dyn_event", "offering_laid", {"mat": mid, "n": int(inputs[mid])})
	if Game != null:
		Game.save_now()
	return true


# A tap on the circle. First tap: the stones tell you where they are. Second tap
# within a couple of seconds: take everything back, or begin the night's vigil, or
# (when there is no material layer) perform what the stones are murmuring about.
func handle_tap(_screen_pos: Vector2, world_pos: Vector2) -> bool:
	if not circle_planted() or _circle == null or not is_instance_valid(_circle):
		return false
	if not _near_circle(world_pos, TAP_REACH):
		return false
	var st: Dictionary = _st()
	if st.is_empty():
		return false
	var now: float = _nowf()
	var double_tap: bool = (now - _last_tap) < RECLAIM_WINDOW
	_last_tap = now
	var running: Dictionary = _dict(st, "running")
	if String(running.get("rite", "")) != "":
		_say(_ceremony_line(String(running.get("rite", "")), _run_u(running)))
		return true
	var vrun: Dictionary = _dict(_dict(st, "vigils"), "run")
	if float(vrun.get("ends", 0.0)) > 0.0:
		_say("The vigil is burning. Nothing to do but be here, or not.")
		return true
	if not double_tap:
		_say(_circle_line())
		return true
	# --- the second tap ---
	var inputs: Dictionary = _dict(_dict(st, "pending"), "inputs")
	if not inputs.is_empty():
		_reclaim()
		return true
	var vr: Dictionary = _vigil_ready()
	if bool(vr.get("ok", false)):
		_begin_vigil()
		return true
	if String(vr.get("why", "")) != "":
		_say(String(vr["why"]))
		return true
	if _try_from_stock():
		return true
	_say(_circle_line())
	return true


# The long press on the Heart Tree. Two holds, never one — nothing in this game
# should be irreversible on a single gesture.
func handle_heart_hold() -> bool:
	if not _ascension_ready():
		return false
	if vigil_count() < VIGILS_NEEDED:
		var vr: Dictionary = _vigil_ready()
		if bool(vr.get("ok", false)):
			_say("The circle is ready for tonight's vigil. Touch the stones twice.")
		else:
			_say("The tree asks for three nights. %d of them are kept." % vigil_count())
		return true
	var now: float = _nowf()
	if now < _ascend_armed_until:
		_ascend_armed_until = -999.0
		_do_ascend()
		return true
	_ascend_armed_until = now + ASCEND_ARM_WINDOW
	_say("Hold the trunk once more, and the world will fold into a seed.")
	return true


# Pull a fully-stocked rite straight out of the basket (Chains.take), for players
# who would rather not drag four things onto four stones.
func _try_from_stock() -> bool:
	var ch: Node = _chains()
	if ch == null or not ch.has_method("take"):
		# no material layer at all: rites are essence-only (at ×1.5, see cost_for)
		var rid0: String = _hint_rite()
		var cost0: Dictionary = cost_for(rid0)
		if _essence() >= float(cost0.get("essence", 0.0)):
			if Game != null:
				Game.spend({"essence": float(cost0.get("essence", 0.0))})
			_begin_ceremony(rid0)
			return true
		_say("%s. There is not enough essence pooled at the roots yet." % rite_label(rid0))
		return true
	var best: String = ""
	var best_w: int = -1
	for rid_v in _rite_order:
		var rid: String = String(rid_v)
		var cost: Dictionary = cost_for(rid)
		if _essence() < float(cost.get("essence", 0.0)):
			continue
		var mats: Dictionary = cost.get("materials", {}) as Dictionary
		var ok := true
		for m in mats.keys():
			if int(ch.call("stock", String(m))) < int(mats[m]):
				ok = false
				break
		if ok and _mat_weight(rid) > best_w:
			best_w = _mat_weight(rid)
			best = rid
	if best == "":
		return false
	var cost2: Dictionary = cost_for(best)
	var mats2: Dictionary = cost2.get("materials", {}) as Dictionary
	var taken: Dictionary = {}
	for m2 in mats2.keys():
		if bool(ch.call("take", String(m2), int(mats2[m2]))):
			taken[String(m2)] = int(mats2[m2])
		else:
			# put back whatever we already took: nothing is ever lost here
			if ch.has_method("give"):
				for m3 in taken.keys():
					ch.call("give", String(m3), int(taken[m3]))
			return false
	if Game != null:
		Game.spend({"essence": float(cost2.get("essence", 0.0))})
	for m4 in taken.keys():
		_offer_mote(_circle_point() + Vector2(0.0, -140.0), String(m4))
	_begin_ceremony(best)
	return true


func _reclaim() -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	var inputs: Dictionary = _dict(_dict(st, "pending"), "inputs")
	if inputs.is_empty():
		return
	var ch: Node = _chains()
	var n: int = 0
	for m in inputs.keys():
		var mid: String = String(m)
		var count: int = int(inputs[m])
		n += count
		if ch != null and ch.has_method("give"):
			ch.call("give", mid, count)
		else:
			_grant("mat:%s" % mid, _mat_entry(mid), count)
	inputs.clear()
	_sync_circle()
	_say("Taken back. The stones never minded." if n > 1 else "Taken back.")
	if Game != null:
		Game.save_now()


# =============================================================================
# DIEGETIC FX  (motes, the wave of light; all inside the §7.4 budget)
# =============================================================================
func _offer_mote(from: Vector2, mid: String) -> void:
	if _motes_live >= MOTE_BUDGET:
		return
	var m: ProcNode = RitualArt.make_offer_mote(world_seed, "o:%d" % int(_nowf() * 1000.0), mid, {
		"from": from, "to": _circle_point() + Vector2(0.0, -26.0),
		"life": 0.9, "arc": 72.0, "size": 12.0,
		"on_arrive": Callable(self, "_on_mote_gone")})
	add_child(m)
	_motes_live += 1


func _essence_motes_to_circle(n: int) -> void:
	var to: Vector2 = _circle_point() + Vector2(0.0, -20.0)
	var from: Vector2 = _heart_point() + Vector2(0.0, -30.0)
	for i in range(n):
		if _motes_live >= MOTE_BUDGET:
			return
		var mote: ProcNode = ProcEffects.make_pickup_float(world_seed, "rm:%d:%d" % [i, int(_nowf() * 100.0)],
			"essence", 1.0, {"scale": 0.72, "z": 30})
		mote.position = from + Vector2(_fixed("em:%d" % i) * 60.0 - 30.0, 0.0)
		add_child(mote)
		var tw: Tween = mote.create_tween().set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_IN_OUT)
		tw.tween_property(mote, "position", to, 0.9 + 0.12 * float(i))
		_motes_live += 1
		tw.tween_callback(_on_mote_gone)


func _motes_to_heart(n: int) -> void:
	var from: Vector2 = _circle_point() + Vector2(0.0, -30.0)
	var to: Vector2 = _heart_point() + Vector2(0.0, -140.0)
	for i in range(n):
		if _motes_live >= MOTE_BUDGET:
			return
		var mote: ProcNode = ProcEffects.make_pickup_float(world_seed, "vm:%d:%d" % [i, int(_nowf() * 100.0)],
			"essence", 0.8, {"scale": 0.6, "z": 30})
		mote.position = from
		add_child(mote)
		var tw: Tween = mote.create_tween().set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_IN_OUT)
		tw.tween_property(mote, "position", to, 1.2 + 0.15 * float(i))
		_motes_live += 1
		tw.tween_callback(_on_mote_gone)


func _on_mote_gone() -> void:
	_motes_live = maxi(0, _motes_live - 1)


func _light_wave() -> void:
	var span: Vector2 = _ground_span()
	var wave: ProcNode = RitualArt.make_wave(world_seed, "w:%d" % int(_nowf()), {
		"span": maxf(900.0, (span.y - span.x) * 0.72), "height": 820.0,
		"life": 2.8, "dir": 1.0})
	wave.position = _circle_point() + Vector2(0.0, -60.0)
	add_child(wave)


# =============================================================================
# WHISPER LINES  (the one shared text channel — 12 s gap, never while placing)
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


func _mat_word(mid: String) -> String:
	var ch: Node = _chains()
	if ch != null and ch.has_method("material_label"):
		var s: String = String(ch.call("material_label", mid))
		if s != "":
			return s
	return String(MAT_LABEL.get(mid, mid.capitalize().replace("_", " ")))


# What the circle murmurs when an offering lands on a stone.
func _offer_line(mid: String) -> String:
	var ch: Dictionary = _charge()
	var rid: String = String(ch.get("rite", ""))
	var word: String = _mat_word(mid)
	if rid == "":
		return "%s, set down on the stones." % word
	var mat_p: float = float(ch.get("mat", 0.0))
	var ess_p: float = float(ch.get("ess", 0.0))
	if mat_p >= 0.999 and ess_p < 0.999:
		return "%s. It wants one more breath of essence." % word
	if mat_p >= 0.999:
		return "%s — and that is everything %s asked for." % [word, rite_label(rid)]
	if mat_p >= 0.5:
		return "%s. Nearly. %s" % [word, String(_def(rid).get("want", ""))]
	return "%s. The runes shift a little." % word


func _circle_line() -> String:
	var st: Dictionary = _st()
	if st.is_empty():
		return ""
	var inputs: Dictionary = _dict(_dict(st, "pending"), "inputs")
	var ch: Dictionary = _charge()
	var rid: String = String(ch.get("rite", ""))
	if inputs.is_empty():
		var vr: Dictionary = _vigil_ready()
		if bool(vr.get("ok", false)):
			return "Three stones for three nights. Touch them again to keep the vigil."
		if rid != "":
			return String(_def(rid).get("want", "The stones are quiet."))
		return "Worn stones, old marks, and a great deal of patience."
	var words: Array = []
	for m in inputs.keys():
		var n: int = int(inputs[m])
		words.append(_mat_word(String(m)) if n <= 1 else "%s ×%d" % [_mat_word(String(m)), n])
	var held: String = _join_words(words)
	if rid == "":
		return "%s rest on the stones." % held
	var mat_p: float = float(ch.get("mat", 0.0))
	var ess_p: float = float(ch.get("ess", 0.0))
	if mat_p >= 0.999 and ess_p < 0.999:
		return "%s. It wants one more breath of essence." % held
	if mat_p >= 0.999:
		return "%s. %s is about to begin." % [held, rite_label(rid)]
	return "%s. %s" % [held, String(_def(rid).get("want", ""))]


func _ceremony_line(rid: String, u: float) -> String:
	if u < 0.35:
		return "%s has begun. The runes are going round." % rite_label(rid)
	if u < 0.8:
		return "The light stands in the circle. It is working."
	return "Almost. Hold still."


func _join_words(arr: Array) -> String:
	if arr.is_empty():
		return ""
	if arr.size() == 1:
		return String(arr[0])
	var head: Array = []
	for i in range(arr.size() - 1):
		head.append(String(arr[i]))
	return "%s and %s" % [", ".join(head), String(arr[arr.size() - 1])]


# =============================================================================
# WORLD ACCESS  (everything guarded; every accessor has a no-hook fallback)
# =============================================================================
func _records() -> Array:
	if _space != null and _space.has_method("records"):
		var v: Variant = _space.call("records")
		if v is Array:
			return v as Array
	return []


func _record(place_id: String) -> Dictionary:
	if _space != null and _space.has_method("record_by_id"):
		var v: Variant = _space.call("record_by_id", place_id)
		if v is Dictionary:
			return v as Dictionary
	for item in _records():
		var r: Dictionary = item
		if String(r.get("id", "")) == place_id:
			return r
	return {}


func _label_of(place_id: String) -> String:
	var r: Dictionary = _record(place_id)
	if r.is_empty():
		return "something you grew"
	var entry: Dictionary = r.get("entry", {}) as Dictionary
	return ItemCatalog.display_label(entry)


func _ground_origin() -> Vector2:
	if _space != null and _space.has_method("ground_origin"):
		var v: Variant = _space.call("ground_origin")
		if v is Vector2:
			return v as Vector2
	# the Heart Tree's foot sits exactly on the terrain origin's x
	return _heart_point()


func _ground_surface_at(tx: float) -> float:
	if _space != null and _space.has_method("ground_surface_at"):
		return float(_space.call("ground_surface_at", tx))
	if _space != null and _space.has_method("snap_ground"):
		var o: Vector2 = _ground_origin()
		var p: Variant = _space.call("snap_ground", Vector2(o.x + tx, o.y))
		if p is Vector2:
			return (p as Vector2).y - o.y
	return 0.0


# A cam-local point standing on the ground at terrain-x `tx`. We live under the
# same pan container as the world, so our local space IS world space.
func _ground_point(tx: float) -> Vector2:
	if _space != null and _space.has_method("snap_ground"):
		var o: Vector2 = _ground_origin()
		var v: Variant = _space.call("snap_ground", Vector2(o.x + tx, o.y))
		if v is Vector2:
			return v as Vector2
	var og: Vector2 = _ground_origin()
	return Vector2(og.x + tx, og.y + _ground_surface_at(tx))


func _heart_point() -> Vector2:
	if _space != null and _space.has_method("heart_foot"):
		var v: Variant = _space.call("heart_foot")
		if v is Vector2:
			return v as Vector2
	return Vector2.ZERO


func _heart_tx() -> float:
	if _space != null and _space.has_method("heart_tx"):
		return float(_space.call("heart_tx"))
	if _space != null and _space.has_method("terrain_x"):
		return float(_space.call("terrain_x", _heart_point()))
	return 0.0


func _ground_span() -> Vector2:
	if _space != null and _space.has_method("ground_span"):
		var v: Variant = _space.call("ground_span")
		if v is Vector2:
			return v as Vector2
	return Vector2(-700.0, 700.0)


func _circle_point() -> Vector2:
	if _circle != null and is_instance_valid(_circle):
		return _circle.position
	var st: Dictionary = _st()
	if st.is_empty():
		return Vector2.ZERO
	return _ground_point(float(_dict(st, "circle").get("tx", 0.0)))


func _near_circle(world_pos: Vector2, k: float) -> bool:
	var c: Vector2 = _circle_point()
	var r: float = CIRCLE_RADIUS * 1.45 * maxf(0.5, k)
	if absf(world_pos.x - c.x) > r:
		return false
	return world_pos.y < c.y + CIRCLE_RADIUS * 0.7 and world_pos.y > c.y - CIRCLE_RADIUS * 2.6


func _essence() -> float:
	if Game != null and Game.has_method("res"):
		return float(Game.call("res", "essence"))
	return 0.0


# The island's live essence income, cached for a tick: IdleSim.rates() walks every
# producer, and cost_for() is called nine times in a row by the hint picker.
func _essence_rate() -> float:
	var now: float = _nowf()
	if now - _rate_at < TICK and _rate_cache > 0.0:
		return _rate_cache
	_rate_at = now
	_rate_cache = 1.0
	if _sim != null and _sim.has_method("rates"):
		var r: Variant = _sim.call("rates")
		if r is Dictionary:
			_rate_cache = maxf(0.5, float((r as Dictionary).get("essence", 1.0)))
	return _rate_cache


func _asc_count() -> int:
	if Game == null or not (Game.state is Dictionary):
		return 0
	var asc: Variant = Game.state.get("ascension", null)
	if asc is Dictionary:
		return int((asc as Dictionary).get("count", 0))
	return 0


# An astral_keeper standing near the stones keeps the rite a little cheaper.
func _astral_discount() -> float:
	var cl: Node = _sib("CreatureLife")
	if cl == null:
		return 1.0
	if cl.has_method("astral_keeper_near") and bool(cl.call("astral_keeper_near", _circle_point())):
		return 0.9
	if cl.has_method("nearest"):
		var v: Variant = cl.call("nearest", _circle_point(), "astral_keeper")
		if v is Dictionary and not (v as Dictionary).is_empty():
			return 0.9
	return 1.0


func _has_prop(o: Object, pname: String) -> bool:
	if o == null:
		return false
	for p in o.get_property_list():
		if String(p.get("name", "")) == pname:
			return true
	return false


# =============================================================================
# INVENTORY  (DYNAMICS §7.3 — the one shared grant pattern, byte for byte)
# =============================================================================
func _mat_entry(mid: String) -> Dictionary:
	return {"kind": "material", "species": mid, "label": _mat_word(mid),
		"growth": -1.0, "minted": false}


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
