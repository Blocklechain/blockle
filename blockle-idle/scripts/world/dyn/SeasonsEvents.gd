class_name SeasonsEvents
extends Node2D
# SeasonsEvents — the slow turning year, and the gentle occasions it brings.
#
# DYNAMICS §6.4. This is the "weather and occasion" layer of the dynamics stack: a
# 12-day year of four seasons that retints the world, changes WHAT THRIVES, and
# opens soft windows of opportunity — a meteor shower you can pluck stars out of, a
# bloom festival where the whole island flowers at once, a travelling merchant
# creature who walks in from the edge and trades out of the bundles at his feet, a
# migration crossing the sky, a bloomtide swell that rains on everything, an aurora
# that just wants to be looked at.
#
# Nothing here is a menu, a banner, a countdown or an obligation:
#   • the season announces itself with ONE whisper, a slow sky/ambience cross-fade
#     and a soft wash of colour over the world;
#   • an event announces itself with ONE whisper and something you can SEE arrive;
#   • every window closes softly — whatever you could have collected is mailed into
#     your basket, and uncaught stars LAND and wait on the grass for six hours;
#   • you can ignore all of it forever and lose exactly nothing.
#
# MENU-LESS: the only readouts are drawn, in-world, touchable things (falling stars,
# star pebbles, festival lanterns, the merchant and his offer bundles, migrating
# birds, the season wash) plus the one whisper line.
#
# PUBLIC API (DYNAMICS §4.2 / §4.4)
#   setup(world_seed:int, ctx:Dictionary)   ctx: {space, interact, sim, puzzles, sky}
#   catch_up(elapsed:float)                 boot + resume wall-clock advance
#   notify(kind:String, payload:Dictionary) inbound sibling events
#   handle_tap(screen_pos, world_pos) -> bool          stars / pebbles / bundles / birds
#   handle_action(action:String, record:Dictionary) -> bool   offer1..offer3
#   season() -> int           season_id() -> String   season_phase() -> float
#   year() -> int             weather() -> String      is_night() -> bool
#   daylight() -> float       event_kind() -> String   event_ends() -> float
#   modifier(key:String) -> float            0.92 .. 1.25, the §2.1 seasons_mod
#   -- extra read-only helpers siblings may use (all guarded on their side) --
#   thrive_mult(kind:String) -> float        per-kind seasonal growth affinity
#   is_raining() -> bool      rain_until() -> float    pollen_mult() -> float
#   breeding_mult() -> float  seed_drop_mult() -> float
#   crystal_yield_mult() -> float            season_tint() -> Color
#   season_label() -> String  season_ctx() -> Dictionary
#   event_data() -> Dictionary                caught() -> int
#
# STATE: Game.state["seasons"] — one key, every field backfilled with .get defaults,
# legacy saves (no key at all) load clean.

signal whisper(text: String)
signal dyn_event(kind: String, payload: Dictionary)

# =============================================================================
# TUNING  (DYNAMICS §2 — copied, never reinvented)
# =============================================================================
const SYS_KEY := "seasons"
const SYS_VERSION := 1

const SEASON_HOURS := 72.0              # 3 real days per season → a 12-day year
const YEAR_HOURS := 288.0
const BLEND_PHASE := 0.04               # first 4% of a season cross-fades from the last

const TICK := 10.0                      # logic tick (§8 budget)
const WHISPER_GAP := 25.0               # §2.6 whisper budget for this system

const EVENT_GAP_LO := 3.5 * 3600.0      # §6.4 soft scheduling
const EVENT_GAP_HI := 7.0 * 3600.0
const EVENT_GAP_FLOOR := 2.5 * 3600.0
const PITY_PER_KIND := 36.0 * 3600.0    # of PLAY time
const PITY_MERCHANT := 24.0 * 3600.0
const FESTIVAL_COOLDOWN := 20.0 * 3600.0
const FESTIVAL_MIN_KIN := 4
const FESTIVAL_MIN_BOND := 0.45

const PEBBLE_HOURS := 6.0               # an uncaught star waits this long on the grass
const MAX_STARS := 4                    # live falling stars at once
const MAX_PEBBLES := 6
const MAX_LANTERNS := 10
const MAX_MIGRANTS := 5
const MAX_AMBIENCE := 3                 # live ProcAmbience effects from this system

const OFFLINE_FULL_HOURS := 8.0         # §2.3 — the IdleSim curve, shared
const OFFLINE_CAP_HOURS := 48.0
const OFFLINE_FLOOR := 0.5

const TAP_STAR := 48.0
const TAP_PEBBLE := 46.0
const TAP_BUNDLE := 62.0
const TAP_BIRD := 58.0
const TAP_MERCHANT := 74.0

const PARCH := Color("#FBF6E9")
const INK := Color("#3A2E22")

const SEASON_IDS := ["greenrise", "highsun", "emberfall", "stillfrost"]
const SEASON_LABELS := ["Greenrise", "Highsun", "Emberfall", "Stillfrost"]
const EVENT_KINDS := ["meteor", "festival", "merchant", "migration", "bloomtide", "aurora"]

# The §2.1 seasons_mod table. Only `grow` in Stillfrost may dip below 1.0 (the floor
# law); everything else is an opportunity, never a penalty.
const SEASON_MOD := {
	"greenrise": {"grow": 1.10, "luck": 1.20, "cadence": 1.06, "bond": 1.06},
	"highsun": {"yield": 1.10, "craft": 1.10, "cadence": 1.02},
	"emberfall": {"yield": 1.08, "luck": 1.06, "cadence": 1.10},
	"stillfrost": {"grow": 0.92, "luck": 1.08, "bond": 1.10, "craft": 1.04},
}

# What thrives. A per-kind growth affinity, folded into `grow` for placed things.
const SEASON_THRIVE := {
	"greenrise": {"plant": 1.14, "tree": 1.06, "fungus": 1.04, "water": 1.06, "creature": 1.02},
	"highsun": {"plant": 1.06, "tree": 1.06, "crystal": 1.04, "building": 1.04},
	"emberfall": {"tree": 1.14, "fungus": 1.10, "plant": 1.02, "crystal": 1.02},
	"stillfrost": {"crystal": 1.14, "fungus": 1.04, "plant": 0.92, "tree": 0.96, "water": 0.94},
}

# Weather weights per season: clear / mist / overcast / storm. Rain and snow are the
# season's own ambience, driven separately (snow in Stillfrost, rain in a swell).
const SEASON_WEATHER := {
	"greenrise": [0.50, 0.20, 0.20, 0.10],
	"highsun": [0.78, 0.07, 0.13, 0.02],
	"emberfall": [0.42, 0.28, 0.24, 0.06],
	"stillfrost": [0.38, 0.22, 0.32, 0.08],
}

# Night is longer in the dark half of the year — this is a real gameplay fact
# (warm matters, moonsilver flows, meteors fall), not a cosmetic.
const SEASON_NIGHT := {
	"greenrise": Vector2(0.80, 0.11),
	"highsun": Vector2(0.84, 0.07),
	"emberfall": Vector2(0.78, 0.12),
	"stillfrost": Vector2(0.74, 0.15),
}

const SEASON_TINT := {
	"greenrise": Color(0.62, 0.92, 0.70),
	"highsun": Color(1.00, 0.88, 0.52),
	"emberfall": Color(0.98, 0.62, 0.34),
	"stillfrost": Color(0.68, 0.82, 1.00),
}
const SEASON_WASH_A := {"greenrise": 0.055, "highsun": 0.065, "emberfall": 0.085, "stillfrost": 0.090}

const SEASON_WHISPER := {
	"greenrise": "Greenrise. The island leans into the light.",
	"highsun": "Highsun. The days run long and golden.",
	"emberfall": "Emberfall. The leaves let go, one by one.",
	"stillfrost": "Stillfrost. The world holds its breath, and listens.",
}

# Event modifiers — layered on top of the season while the window is open.
const EVENT_MOD := {
	"meteor": {"luck": 1.12},
	"festival": {"yield": 1.15, "bond": 1.20, "cadence": 1.15},
	"merchant": {"cadence": 1.10},
	"migration": {"bond": 1.10, "cadence": 1.05},
	"bloomtide": {"grow": 1.15, "luck": 1.10},
	"aurora": {"yield": 1.08, "luck": 1.10},
}

# window length, in minutes: [lo, hi]
const EVENT_WINDOW := {
	"meteor": Vector2(40.0, 70.0),
	"festival": Vector2(90.0, 180.0),
	"merchant": Vector2(60.0, 120.0),
	"migration": Vector2(75.0, 150.0),
	"bloomtide": Vector2(30.0, 90.0),
	"aurora": Vector2(60.0, 60.0),
}

# base pick weight, and the per-season multiplier on it
const EVENT_WEIGHT := {
	"meteor": 1.0, "festival": 0.6, "merchant": 1.0,
	"migration": 1.0, "bloomtide": 1.0, "aurora": 0.9,
}
const EVENT_SEASON_WEIGHT := {
	"greenrise": {"bloomtide": 1.5, "migration": 1.1, "festival": 1.2},
	"highsun": {"merchant": 1.3, "bloomtide": 0.8, "meteor": 0.8},
	"emberfall": {"migration": 1.4, "merchant": 1.1, "aurora": 1.1},
	"stillfrost": {"meteor": 2.0, "aurora": 1.6, "bloomtide": 0.6},
}

const EVENT_OPEN_WHISPER := {
	"meteor": "The sky is shedding. Reach out and catch one.",
	"festival": "Everything is flowering at once. Lanterns, all down the island.",
	"merchant": "Someone is walking in from the edge of the world, carrying bundles.",
	"migration": "Wings, high up, all going the same way.",
	"bloomtide": "A warm rain. Everything drinks.",
	"aurora": "Quiet light, moving across the dark. Nothing to do but look.",
}
const EVENT_CLOSE_WHISPER := {
	"meteor": "The sky put its leftovers in your basket.",
	"festival": "The lanterns gutter out, one by one. It was good.",
	"merchant": "He shoulders what is left and walks on. He left you something.",
	"migration": "The last of them clears the far ridge.",
	"bloomtide": "The rain thins. Everything is heavier with water.",
	"aurora": "The light folds away. The stars come back.",
}

# =============================================================================
# RUNTIME
# =============================================================================
var world_seed: int = 1

var _space: Node = null
var _interact: Node = null
var _sim: Node = null
var _puzzles: Node = null
var _sky: Node = null

var _screen: Node2D = null              # counter-panned layer: wash + ambience
var _wfx: Node2D = null                 # world-space layer: stars, pebbles, lanterns…
var _wash: _SeasonWash = null

var _vp: Vector2 = Vector2(1080.0, 1920.0)
var _origin_x: float = 0.0
var _ext: Vector2 = Vector2(-600.0, 600.0)
var _heart_tx: float = 0.0
var _geom_ok := false

var _stars: Array = []                  # [{node, pos, vel, life, max_life, hue}]
var _pebbles: Array = []                # [{node, pid, tx, until}]
var _lanterns: Array = []               # [ProcNode]
var _migrants: Array = []               # [{node, pos, vel, beat, greeted}]
var _merchant: Dictionary = {}          # {holder, pack, tx, stop_tx, state, t, bundles:[]}
var _ambience: Dictionary = {}          # kind -> ProcNode

var _acc := 0.0
var _star_acc := 0.0
var _last_whisper := -999.0
var _rr := 0
var _amb_sig := ""
var _kin_cache: Dictionary = {}
var _kin_cache_at := -999.0
var _shown_season := -1
var _live := false


# =============================================================================
# BOOT
# =============================================================================
func setup(seed_value: int, ctx: Dictionary) -> void:
	world_seed = seed_value
	name = "SeasonsEvents"
	z_index = 3
	_space = _as_node(ctx.get("space", null))
	_interact = _as_node(ctx.get("interact", null))
	_sim = _as_node(ctx.get("sim", null))
	_puzzles = _as_node(ctx.get("puzzles", null))
	_sky = _as_node(ctx.get("sky", null))
	if _sky == null:
		_sky = _find_sky()

	_screen = Node2D.new()
	_screen.name = "SeasonScreen"
	_screen.z_index = 20
	add_child(_screen)

	_wfx = Node2D.new()
	_wfx.name = "SeasonWorld"
	_wfx.z_index = 2
	add_child(_wfx)

	_measure_geometry()

	_wash = _SeasonWash.new()
	_wash.seedv = hash("%d:wash" % world_seed)
	_wash.size = _vp
	_wash.z_index = 6
	_screen.add_child(_wash)

	var st: Dictionary = _st()
	if float(st.get("epoch", 0.0)) <= 0.0:
		st["epoch"] = _unix()
	if float(st.get("next_event", 0.0)) <= 0.0:
		st["next_event"] = _unix() + Proc.rangef(world_seed, "ev:first", 900.0, 2400.0)
	_live = true
	catch_up(0.0)
	set_process(true)


func _as_node(v: Variant) -> Node:
	if v is Node:
		return v as Node
	return null


# The living ProcSky — preferred from ctx (space.sky_node()), else found by duck type.
func _find_sky() -> Node:
	if _space == null:
		return null
	if _space.has_method("sky_node"):
		var n: Node = _space.call("sky_node")
		if n != null:
			return n
	for c in _space.get_children():
		if c is Node and c.has_method("set_weather") and c.has_method("get_time_of_day"):
			return c as Node
	return null


# Everything spatial is derived from WorldSpace's EXISTING public API, so this
# system works whether or not the §9.2 accessors have been wired yet.
func _measure_geometry() -> void:
	if _space == null:
		return
	var v: Variant = _space.get("vp")
	if v is Vector2:
		_vp = v as Vector2
	if not _space.has_method("terrain_x") or not _space.has_method("snap_ground"):
		return
	var tx0: float = float(_space.call("terrain_x", Vector2.ZERO))
	var sg0: Vector2 = _space.call("snap_ground", Vector2.ZERO)
	_origin_x = sg0.x - tx0
	_ext = Vector2(
		float(_space.call("terrain_x", Vector2(_origin_x - 1.0e7, 0.0))),
		float(_space.call("terrain_x", Vector2(_origin_x + 1.0e7, 0.0))))
	if _space.has_method("heart_tx"):
		_heart_tx = float(_space.call("heart_tx"))
	elif _space.has_method("heart_foot"):
		var hf: Vector2 = _space.call("heart_foot")
		_heart_tx = float(_space.call("terrain_x", hf))
	_geom_ok = true


# The ground point (cam-local) at a terrain-x. Prefers the §9.2 accessors.
func _ground_at(tx: float) -> Vector2:
	var cx: float = clampf(tx, _ext.x + 8.0, _ext.y - 8.0)
	if _space == null:
		return Vector2(cx, 0.0)
	if _space.has_method("ground_origin") and _space.has_method("ground_surface_at"):
		var o: Vector2 = _space.call("ground_origin")
		return o + Vector2(cx, float(_space.call("ground_surface_at", cx)))
	if _space.has_method("snap_ground"):
		return _space.call("snap_ground", Vector2(_origin_x + cx, 0.0))
	return Vector2(cx, 0.0)


# =============================================================================
# STATE  (§3 — one key, every field backfilled, legacy-safe)
# =============================================================================
func _st() -> Dictionary:
	if Game == null or not (Game.state is Dictionary):
		return {}
	if not Game.state.has(SYS_KEY) or not (Game.state[SYS_KEY] is Dictionary):
		Game.state[SYS_KEY] = {}
	var st: Dictionary = Game.state[SYS_KEY]
	st["version"] = int(st.get("version", SYS_VERSION))
	st["seq"] = int(st.get("seq", 0))
	st["pity"] = st.get("pity", {}) if (st.get("pity", {}) is Dictionary) else {}
	st["pb_n"] = int(st.get("pb_n", 0))
	st["epoch"] = float(st.get("epoch", 0.0))
	st["last_tick"] = float(st.get("last_tick", 0.0))
	st["season"] = int(st.get("season", -1))
	st["year"] = int(st.get("year", 0))
	st["seen"] = st.get("seen", {}) if (st.get("seen", {}) is Dictionary) else {}
	st["event"] = st.get("event", {}) if (st.get("event", {}) is Dictionary) else {}
	st["queued"] = st.get("queued", {}) if (st.get("queued", {}) is Dictionary) else {}
	st["history"] = st.get("history", []) if (st.get("history", []) is Array) else []
	st["caught"] = int(st.get("caught", 0))
	st["ev_n"] = int(st.get("ev_n", 0))
	st["next_event"] = float(st.get("next_event", 0.0))
	st["play"] = float(st.get("play", 0.0))
	st["kind_play"] = st.get("kind_play", {}) if (st.get("kind_play", {}) is Dictionary) else {}
	st["pebbles"] = st.get("pebbles", []) if (st.get("pebbles", []) is Array) else []
	st["weather"] = String(st.get("weather", ""))
	st["weather_until"] = float(st.get("weather_until", 0.0))
	st["weather_step"] = int(st.get("weather_step", 0))
	st["last_festival"] = float(st.get("last_festival", 0.0))
	st["lanterns_forever"] = bool(st.get("lanterns_forever", false))
	st["traded"] = int(st.get("traded", 0))
	return st


# §2.5 — the persisted-counter RNG. Reproducible from the save, never from the clock.
func _rand(tag: String) -> float:
	var st: Dictionary = _st()
	if st.is_empty():
		return Proc.hashf(world_seed, "%s:%s" % [SYS_KEY, tag])
	var n: int = int(st.get("seq", 0))
	st["seq"] = n + 1
	return Proc.hashf(world_seed, "%s:%s:%d" % [SYS_KEY, tag, n])


# Layout rolls carry NO counter: same world, same island, same arrangement.
func _fixed(key: String) -> float:
	return Proc.hashf(world_seed, "%s:fix:%s" % [SYS_KEY, key])


func _fixed_range(key: String, lo: float, hi: float) -> float:
	return lo + _fixed(key) * (hi - lo)


func _unix() -> float:
	return float(Time.get_unix_time_from_system())


func _mono() -> float:
	return float(Time.get_ticks_msec()) / 1000.0


# =============================================================================
# SEASONS  (§6.4 — purely derived from the clock, so it turns while you sleep)
# =============================================================================
func _elapsed_hours() -> float:
	var st: Dictionary = _st()
	var ep: float = float(st.get("epoch", 0.0))
	if ep <= 0.0:
		return 0.0
	return maxf(0.0, (_unix() - ep) / 3600.0)


func season() -> int:
	return int(floor(_elapsed_hours() / SEASON_HOURS)) % 4


func season_id() -> String:
	return String(SEASON_IDS[season()])


func season_label() -> String:
	return String(SEASON_LABELS[season()])


func season_phase() -> float:
	return clampf(fmod(_elapsed_hours(), SEASON_HOURS) / SEASON_HOURS, 0.0, 1.0)


func year() -> int:
	return int(floor(_elapsed_hours() / YEAR_HOURS))


func _prev_season_id() -> String:
	return String(SEASON_IDS[(season() + 3) % 4])


# 0 at the very start of a season → 1 once the cross-fade has finished.
func _blend() -> float:
	var p: float = season_phase()
	if p >= BLEND_PHASE:
		return 1.0
	var u: float = clampf(p / maxf(0.0001, BLEND_PHASE), 0.0, 1.0)
	return u * u * (3.0 - 2.0 * u)


func season_tint() -> Color:
	var a: Color = SEASON_TINT.get(_prev_season_id(), Color.WHITE)
	var b: Color = SEASON_TINT.get(season_id(), Color.WHITE)
	return a.lerp(b, _blend())


func _wash_alpha() -> float:
	var a: float = float(SEASON_WASH_A.get(_prev_season_id(), 0.06))
	var b: float = float(SEASON_WASH_A.get(season_id(), 0.06))
	return lerpf(a, b, _blend())


# The adaptation context this system contributes (§7.4 — art modules decide, we
# never recolour a thing ourselves).
func season_ctx() -> Dictionary:
	return {
		"season": season(),
		"season_id": season_id(),
		"season_phase": season_phase(),
		"season_tint": season_tint(),
		"season_blend": _blend(),
		"weather": weather(),
		"night": is_night(),
		"daylight": daylight(),
		"event": event_kind(),
	}


# =============================================================================
# MODIFIERS  (§2.1 — clamped to 0.92 .. 1.25, the seasons_mod slot)
# =============================================================================
func modifier(key: String) -> float:
	var a: float = _season_mod_raw(_prev_season_id(), key)
	var b: float = _season_mod_raw(season_id(), key)
	var m: float = lerpf(a, b, _blend())
	var ek: String = event_kind()
	if ek != "":
		var tbl: Dictionary = EVENT_MOD.get(ek, {})
		m *= float(tbl.get(key, 1.0))
	if key == "grow":
		return clampf(m, 0.92, 1.25)
	return clampf(m, 1.0, 1.25)


func _season_mod_raw(sid: String, key: String) -> float:
	var tbl: Dictionary = SEASON_MOD.get(sid, {})
	return float(tbl.get(key, 1.0))


# Per-kind seasonal affinity — the honest answer to "what thrives right now".
func thrive_mult(kind: String) -> float:
	var ka: Dictionary = SEASON_THRIVE.get(_prev_season_id(), {})
	var kb: Dictionary = SEASON_THRIVE.get(season_id(), {})
	var m: float = lerpf(float(ka.get(kind, 1.0)), float(kb.get(kind, 1.0)), _blend())
	return clampf(m, 0.92, 1.20)


func pollen_mult() -> float:
	var m: float = 1.0
	if season_id() == "greenrise":
		m *= 1.5
	if event_kind() == "bloomtide":
		m *= 1.5
	return clampf(m, 1.0, 2.25)


func breeding_mult() -> float:
	var m: float = 1.0
	if season_id() == "greenrise":
		m *= 1.5
	if event_kind() == "festival":
		m *= 2.0
	return clampf(m, 1.0, 3.0)


func seed_drop_mult() -> float:
	var m: float = 1.0
	if season_id() == "emberfall":
		m *= 1.4
	return clampf(m, 1.0, 1.5)


func crystal_yield_mult() -> float:
	var m: float = 1.0
	if season_id() == "stillfrost":
		m *= 1.05
	return clampf(m, 1.0, 1.25)


func caught() -> int:
	return int(_st().get("caught", 0))


# =============================================================================
# WEATHER / LIGHT
# =============================================================================
func weather() -> String:
	if event_kind() == "bloomtide":
		return "rain"
	var w: String = String(_st().get("weather", ""))
	if w == "":
		return "clear"
	return w


func is_raining() -> bool:
	var w: String = weather()
	return w == "rain" or w == "storm"


# While a bloomtide swell runs the whole island counts as watered (Nurture reads
# this; it also keeps its own auto.rain_until for rites).
func rain_until() -> float:
	if event_kind() == "bloomtide":
		return event_ends()
	if weather() == "storm":
		return _unix() + 120.0
	return 0.0


func _tod() -> float:
	if _sky != null and _sky.has_method("get_time_of_day"):
		return fposmod(float(_sky.call("get_time_of_day")), 1.0)
	# no sky: derive a plausible cycle from the season phase so night still exists
	return fposmod(season_phase() * 24.0, 1.0)


func is_night() -> bool:
	var tod: float = _tod()
	var band: Vector2 = SEASON_NIGHT.get(season_id(), Vector2(0.78, 0.10))
	return tod > band.x or tod < band.y


func daylight() -> float:
	var d: float = 0.5 - 0.5 * cos(TAU * _tod())
	var u: float = clampf((d - 0.10) / 0.52, 0.0, 1.0)
	return u * u * (3.0 - 2.0 * u)


# This system takes ownership of the sky's weather by setting it more recently than
# WorldSpace's own wander (§6.4). Its plan is seeded per season step.
func _drive_weather(now: float) -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	if now >= float(st.get("weather_until", 0.0)):
		var step: int = int(st.get("weather_step", 0)) + 1
		st["weather_step"] = step
		st["weather"] = _roll_weather(step)
		st["weather_until"] = now + Proc.rangef(world_seed, "%s:wdur:%d" % [SYS_KEY, step], 540.0, 1320.0)
	if _sky != null and _sky.has_method("set_weather"):
		_sky.call("set_weather", _sky_weather())


func _roll_weather(step: int) -> String:
	var w: Array = SEASON_WEATHER.get(season_id(), [1.0, 0.0, 0.0, 0.0])
	var names: Array = ["clear", "mist", "overcast", "storm"]
	var total: float = 0.0
	for v in w:
		total += float(v)
	var r: float = Proc.hashf(world_seed, "%s:wx:%s:%d" % [SYS_KEY, season_id(), step]) * maxf(0.0001, total)
	var acc: float = 0.0
	for i in range(names.size()):
		acc += float(w[i])
		if r <= acc:
			return String(names[i])
	return "clear"


# Map our richer plan onto the four moods ProcSky understands.
func _sky_weather() -> String:
	var w: String = weather()
	match w:
		"rain": return "storm"
		"snow": return "mist"
		"clear", "mist", "overcast", "storm": return w
		_: return "clear"


# =============================================================================
# EVENTS — read-only surface
# =============================================================================
func event_kind() -> String:
	var ev: Dictionary = _st().get("event", {}) if (_st().get("event", {}) is Dictionary) else {}
	return String(ev.get("kind", ""))


func event_ends() -> float:
	var ev: Dictionary = _st().get("event", {}) if (_st().get("event", {}) is Dictionary) else {}
	return float(ev.get("ends", 0.0))


func event_data() -> Dictionary:
	var ev: Dictionary = _st().get("event", {}) if (_st().get("event", {}) is Dictionary) else {}
	var d: Variant = ev.get("data", {})
	return d if (d is Dictionary) else {}


# =============================================================================
# TICK
# =============================================================================
func _process(delta: float) -> void:
	if not _live:
		return
	# screen-locked layers counter-pan so the wash and the ambience stay put
	if _screen != null and _space != null and _space.has_method("cam_node"):
		var cam: Node = _space.call("cam_node")
		if cam is Node2D:
			_screen.position = -(cam as Node2D).position
	_animate_actors(delta)
	_acc += delta
	if _acc < TICK:
		return
	var dt: float = _acc
	_acc = 0.0
	_tick(dt)


func _tick(dt: float) -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	if not _geom_ok:
		_measure_geometry()
	var now: float = _unix()
	st["last_tick"] = now
	st["play"] = float(st.get("play", 0.0)) + dt
	_accrue_kind_pity(dt)
	_advance_season(now)
	_drive_weather(now)
	_drive_events(now)
	_expire_pebbles(now)
	_refresh_ambience()
	_apply_growth_round()
	if _wash != null:
		_wash.set_look(season_tint(), _wash_alpha(), daylight())


func _advance_season(now: float) -> void:
	var st: Dictionary = _st()
	var s: int = season()
	var y: int = year()
	var prev: int = int(st.get("season", -1))
	st["year"] = y
	if prev == s:
		return
	st["season"] = s
	var seen: Dictionary = st.get("seen", {})
	var first: bool = not seen.has(str(s))
	seen[str(s)] = true
	st["seen"] = seen
	if prev >= 0:
		_whisper(String(SEASON_WHISPER.get(season_id(), "The season turns.")))
	_announce_season(first)
	_retint_world()
	_apply_sky_season()
	emit_signal("dyn_event", "season_changed", {"season": s, "id": season_id(), "year": y})
	emit_signal("dyn_event", "weather_changed", {"weather": weather()})
	_discover("season:%s" % season_id(), {"category": "events", "label": season_label(),
		"line": "%s — one quarter of the turning year." % season_label()})
	if Game != null:
		Game.save_now()


func _announce_season(first: bool) -> void:
	# a soft bloom of motes across the island crown: the season arriving, seen
	var n: int = 7 if first else 5
	for i in range(n):
		var tx: float = lerpf(_ext.x * 0.7, _ext.y * 0.7, float(i) / maxf(1.0, float(n - 1)))
		var p: Vector2 = _ground_at(tx) + Vector2(0.0, -70.0 - _fixed("seabloom:%d" % i) * 90.0)
		_fx(p, "sparkle", _season_fx_material())
	_shown_season = season()


func _season_fx_material() -> String:
	match season_id():
		"greenrise": return "plant"
		"highsun": return "light"
		"emberfall": return "wood"
		"stillfrost": return "crystal"
		_: return "light"


func _apply_sky_season() -> void:
	if _sky == null:
		return
	if _sky.has_method("set_auto_advance"):
		var mins: float = 28.0
		match season_id():
			"greenrise": mins = 28.0
			"highsun": mins = 32.0
			"emberfall": mins = 26.0
			"stillfrost": mins = 24.0
		_sky.call("set_auto_advance", true, mins)
	if _sky.has_method("set_aurora"):
		_sky.call("set_aurora", event_kind() == "aurora")


# Re-adapt every placed thing with the season context. We never touch a thing's
# colours ourselves — the art module decides what a season means for it (§7.4).
func _retint_world() -> void:
	if _space == null or not _space.has_method("build_context"):
		return
	var ctx_season: Dictionary = season_ctx()
	for item in _live_records():
		var rec: Dictionary = item
		var node: Variant = rec.get("node", null)
		if not (node is ProcNode) or not is_instance_valid(node as ProcNode):
			continue
		var pn: ProcNode = node as ProcNode
		var fr: float = float(rec.get("footprint", 24.0))
		var ctx: Dictionary = _space.call("build_context", pn.position, fr)
		for k in ctx_season.keys():
			ctx[k] = ctx_season[k]
		ItemCatalog.adapt(pn, ctx)


# =============================================================================
# EVENT SCHEDULING  (soft windows, pity-floored, never an obligation)
# =============================================================================
func _accrue_kind_pity(dt: float) -> void:
	var st: Dictionary = _st()
	var kp: Dictionary = st.get("kind_play", {})
	var boost: float = 1.0 + (0.25 if _has_job("explorer") else 0.0)
	for k in EVENT_KINDS:
		var kid: String = String(k)
		kp[kid] = float(kp.get(kid, 0.0)) + dt * boost
	st["kind_play"] = kp


func _credit_offline_pity(elapsed: float) -> void:
	# a long absence nudges the next occasion a little closer — never further away
	if elapsed <= 0.0:
		return
	var eff: float = _effective(elapsed) * 0.25
	var st: Dictionary = _st()
	var kp: Dictionary = st.get("kind_play", {})
	for k in EVENT_KINDS:
		var kid: String = String(k)
		kp[kid] = float(kp.get(kid, 0.0)) + eff
	st["kind_play"] = kp


func _effective(elapsed: float) -> float:
	var e: float = maxf(0.0, elapsed)
	var full: float = OFFLINE_FULL_HOURS * 3600.0
	var cap: float = OFFLINE_CAP_HOURS * 3600.0
	if e <= full:
		return e
	var span: float = maxf(1.0, cap - full)
	var over: float = minf(e, cap) - full
	var avg: float = 1.0 - (1.0 - OFFLINE_FLOOR) * 0.5 * (over / span)
	return full + over * avg


func _cadence() -> float:
	var m: float = modifier("cadence")
	var r: Node = _sib("Rituals")
	if r != null and r.has_method("blessing"):
		m *= float(r.call("blessing", "cadence"))
	return clampf(m, 1.0, 1.5)


func _drive_events(now: float) -> void:
	var st: Dictionary = _st()
	var ev: Dictionary = st.get("event", {})
	if not ev.is_empty():
		if now >= float(ev.get("ends", 0.0)):
			_end_event(now)
		else:
			_sustain_event(now)
		return
	# a queued event (a meteor shower waiting for nightfall) takes priority
	var q: Dictionary = st.get("queued", {})
	if not q.is_empty():
		var qk: String = String(q.get("kind", ""))
		if qk != "" and _can_open(qk):
			st["queued"] = {}
			_start_event(qk, now)
			return
	# the festival is its own invitation: it fires when the island is fond of you
	if _festival_ready(now):
		_start_event("festival", now)
		return
	if now < float(st.get("next_event", 0.0)):
		return
	var kind: String = _pick_event()
	if kind == "":
		st["next_event"] = now + 900.0
		return
	if _can_open(kind):
		_start_event(kind, now)
	else:
		st["queued"] = {"kind": kind, "at": now}
		st["next_event"] = now + 600.0


func _can_open(kind: String) -> bool:
	match kind:
		"meteor": return is_night()
		"aurora": return is_night()
		_: return true


func _pick_event() -> String:
	var st: Dictionary = _st()
	var kp: Dictionary = st.get("kind_play", {})
	# pity first: a kind the player has never been shown in 36 h of play is forced
	for k in EVENT_KINDS:
		var kid: String = String(k)
		var ceil_s: float = PITY_MERCHANT if kid == "merchant" else PITY_PER_KIND
		if float(kp.get(kid, 0.0)) >= ceil_s:
			kp[kid] = 0.0
			st["kind_play"] = kp
			return kid
	var sw: Dictionary = EVENT_SEASON_WEIGHT.get(season_id(), {})
	var weights: Array = []
	var total: float = 0.0
	for k in EVENT_KINDS:
		var kid2: String = String(k)
		var w: float = float(EVENT_WEIGHT.get(kid2, 1.0)) * float(sw.get(kid2, 1.0))
		if kid2 == "festival":
			w *= 0.35                       # the festival mostly arrives on its own terms
		if kid2 == "merchant" and _has_job("explorer"):
			w += 1.0                        # an explorer brings travellers in
		w *= 1.0 + 0.6 * clampf(float(kp.get(kid2, 0.0)) / maxf(1.0, PITY_PER_KIND), 0.0, 1.0)
		weights.append(w)
		total += w
	if total <= 0.0:
		return ""
	var r: float = _rand("pick") * total
	var acc: float = 0.0
	for i in range(EVENT_KINDS.size()):
		acc += float(weights[i])
		if r <= acc:
			return String(EVENT_KINDS[i])
	return String(EVENT_KINDS[0])


func _festival_ready(now: float) -> bool:
	var st: Dictionary = _st()
	if now - float(st.get("last_festival", 0.0)) < FESTIVAL_COOLDOWN:
		return false
	var kin: Dictionary = _kin_summary()
	return int(kin.get("fond", 0)) >= FESTIVAL_MIN_KIN


func _start_event(kind: String, now: float) -> void:
	var st: Dictionary = _st()
	var n: int = int(st.get("ev_n", 0)) + 1
	st["ev_n"] = n
	var eid: String = "ev%d:%s" % [n, kind]
	var win: Vector2 = EVENT_WINDOW.get(kind, Vector2(60.0, 60.0))
	var mins: float = lerpf(win.x, win.y, _rand("win:%s" % kind))
	var ends: float = now + mins * 60.0
	var data: Dictionary = _build_event_data(kind, eid, ends)
	st["event"] = {"id": eid, "kind": kind, "started": now, "ends": ends, "data": data}
	var kp: Dictionary = st.get("kind_play", {})
	kp[kind] = 0.0
	st["kind_play"] = kp
	var hist: Array = st.get("history", [])
	hist.append({"kind": kind, "at": now})
	while hist.size() > 24:
		hist.remove_at(0)
	st["history"] = hist
	if kind == "festival":
		st["last_festival"] = now
	st["next_event"] = ends + maxf(EVENT_GAP_FLOOR, lerpf(EVENT_GAP_LO, EVENT_GAP_HI, _rand("gap")) / _cadence())
	_build_event_actors(kind, eid, data)
	_on_event_open(kind, eid, data)
	_whisper(String(EVENT_OPEN_WHISPER.get(kind, "Something is happening.")))
	emit_signal("dyn_event", "event_started", {"kind": kind, "id": eid, "ends": ends, "data": data})
	_discover("event:%s" % kind, {"category": "events", "label": _event_label(kind),
		"line": String(EVENT_OPEN_WHISPER.get(kind, ""))})
	if Game != null:
		Game.save_now()


func _event_label(kind: String) -> String:
	match kind:
		"meteor": return "Meteor Shower"
		"festival": return "Bloom Festival"
		"merchant": return "Travelling Merchant"
		"migration": return "Migration"
		"bloomtide": return "Bloomtide Swell"
		"aurora": return "Aurora"
		_: return kind.capitalize()


func _build_event_data(kind: String, eid: String, ends: float) -> Dictionary:
	var d: Dictionary = {}
	match kind:
		"meteor":
			d["hue"] = _fixed_range("%s:hue" % eid, 0.52, 0.72)
			d["cadence"] = _fixed_range("%s:cad" % eid, 9.0, 18.0)
		"festival":
			d["gather"] = _heart_tx
			d["lanterns"] = clampi(int(_fixed_range("%s:lan" % eid, 6.0, float(MAX_LANTERNS) + 0.9)), 6, MAX_LANTERNS)
			d["recipes"] = ["honeycake"]
		"merchant":
			var from_left: bool = _fixed("%s:side" % eid) < 0.5
			d["from_left"] = from_left
			d["stop_tx"] = _heart_tx + (-1.0 if from_left else 1.0) * _fixed_range("%s:stop" % eid, 180.0, 300.0)
			d["species"] = _merchant_species(eid)
			d["offers"] = _build_offers(eid)
			d["taken"] = {}
		"migration":
			d["species"] = _migrant_flavour(eid)
			d["settle"] = _fixed("%s:settle" % eid) < 0.45
		"bloomtide":
			d["rain_until"] = ends
		"aurora":
			d["hue"] = _fixed_range("%s:ahue" % eid, 0.38, 0.62)
	return d


func _sustain_event(now: float) -> void:
	var kind: String = event_kind()
	match kind:
		"meteor":
			if not is_night():
				# dawn catches the shower: close it softly, early, with its gifts
				_end_event(now)
		"merchant":
			pass
		"festival":
			_festival_bloom_round()
	if kind == "aurora" and _sky != null and _sky.has_method("set_aurora"):
		_sky.call("set_aurora", true)


func _on_event_open(kind: String, _eid: String, data: Dictionary) -> void:
	match kind:
		"festival":
			# the feast recipes become real, for good, the first time you see one
			var ch: Node = _sib("Chains")
			if ch != null and ch.has_method("learn"):
				var recs: Array = data.get("recipes", []) if (data.get("recipes", []) is Array) else []
				for r in recs:
					ch.call("learn", String(r))
		"aurora":
			var ri: Node = _sib("Rituals")
			if ri != null and ri.has_method("grant_vigil_charge"):
				ri.call("grant_vigil_charge")
		"bloomtide":
			var nu: Node = _sib("Nurture")
			if nu != null and nu.has_method("set_auto_rain"):
				nu.call("set_auto_rain", event_ends())
	_apply_sky_season()
	_refresh_ambience()


func _end_event(now: float) -> void:
	var st: Dictionary = _st()
	var ev: Dictionary = st.get("event", {})
	var kind: String = String(ev.get("kind", ""))
	var eid: String = String(ev.get("id", ""))
	var data: Dictionary = ev.get("data", {}) if (ev.get("data", {}) is Dictionary) else {}
	st["event"] = {}
	_mail_leftovers(kind, eid, data)
	_clear_event_actors(kind)
	if kind == "aurora" and _sky != null and _sky.has_method("set_aurora"):
		_sky.call("set_aurora", false)
	_whisper(String(EVENT_CLOSE_WHISPER.get(kind, "It passes, gently.")))
	emit_signal("dyn_event", "event_ended", {"kind": kind, "id": eid, "ends": now, "data": data})
	_refresh_ambience()
	if Game != null:
		Game.save_now()


# §2.3 — nothing is lost by being away. The window closes into your basket.
func _mail_leftovers(kind: String, eid: String, data: Dictionary) -> void:
	match kind:
		"meteor":
			var got: int = int(_st().get("caught", 0))
			var owed: int = maxi(0, 3 - mini(3, got))
			if owed > 0 and Game != null:
				Game.add_resource("stardust", 2.0 * float(owed))
			_give_mat("skyshard", 1)
		"festival":
			_give_mat("honeycomb", 2)
		"merchant":
			var taken: Dictionary = data.get("taken", {}) if (data.get("taken", {}) is Dictionary) else {}
			if taken.size() < 3:
				var sp: String = _wild_pick(ItemCatalog.WILD_PLANTS, "%s:gift" % eid)
				_grant("seed:%s" % sp, _seed_entry("plant", sp), 1)
		"migration":
			_give_mat("lichen_wool", 1)
			_give_mat("honeycomb", 1)
			_maybe_settle(eid, data)
		"bloomtide":
			_give_mat("dewdrop", 2)
		"aurora":
			_give_mat("moonsilver", 1)
			if Game != null:
				Game.add_resource("stardust", 3.0)


func _maybe_settle(eid: String, data: Dictionary) -> void:
	if not bool(data.get("settle", false)):
		return
	var cl: Node = _sib("CreatureLife")
	var cap: int = 1
	var avg: float = 0.5
	if cl != null:
		if cl.has_method("home_capacity"):
			cap = int(cl.call("home_capacity"))
		if cl.has_method("avg_bond"):
			avg = float(cl.call("avg_bond"))
	if cap <= 0 or avg < 0.4:
		return
	var sp: String = _creature_pick("%s:settler" % eid)
	_grant("egg:%s" % sp, {"count": 0, "kind": "creature", "species": sp,
		"label": "%s (egg)" % sp.capitalize(), "growth": -1.0, "minted": false}, 1)
	_whisper("One of them stayed. It is sleeping in your basket.")
	emit_signal("dyn_event", "migration_settled", {"species": sp, "item_key": "egg:%s" % sp})
	_discover("creature:%s" % sp, {"category": "creatures", "label": sp.capitalize(),
		"line": "Came in on the migration, and chose to stay."})


# =============================================================================
# ACTORS — build / restore / clear
# =============================================================================
func _build_event_actors(kind: String, eid: String, data: Dictionary) -> void:
	match kind:
		"festival":
			_build_lanterns(eid, int(data.get("lanterns", 6)))
		"merchant":
			_build_merchant(eid, data)
		"migration":
			_build_migrants(eid)
		_:
			pass


func _clear_event_actors(kind: String) -> void:
	match kind:
		"festival":
			if not bool(_st().get("lanterns_forever", false)):
				_fade_free_all(_lanterns)
				_lanterns = []
		"merchant":
			_merchant_depart()
		"migration":
			for item in _migrants:
				var m: Dictionary = item
				_fade_free(m.get("node", null))
			_migrants = []
		"meteor":
			# live stars land rather than vanish — the sky finishes what it started
			for item2 in _stars:
				var s: Dictionary = item2
				_land_star(s)
			_stars = []
		_:
			pass


func _fade_free_all(arr: Array) -> void:
	for n in arr:
		_fade_free(n)


func _fade_free(n: Variant) -> void:
	if not (n is Node2D) or not is_instance_valid(n as Node2D):
		return
	var node: Node2D = n as Node2D
	var tw: Tween = node.create_tween()
	tw.tween_property(node, "modulate:a", 0.0, 0.8)
	tw.tween_callback(node.queue_free)


# =============================================================================
# FESTIVAL — lanterns, and everything flowering at once
# =============================================================================
func _build_lanterns(eid: String, n: int) -> void:
	_fade_free_all(_lanterns)
	_lanterns = []
	if _wfx == null:
		return
	var count: int = clampi(n, 3, MAX_LANTERNS)
	for i in range(count):
		var u: float = (float(i) + 0.5) / float(count)
		var tx: float = lerpf(_ext.x * 0.82, _ext.y * 0.82, u)
		tx += (_fixed("%s:lx:%d" % [eid, i]) - 0.5) * 70.0
		var lan: _FestivalLantern = _FestivalLantern.new()
		lan.seedv = hash("%d:%s:lan:%d" % [world_seed, eid, i])
		lan.hue = _fixed_range("%s:lh:%d" % [eid, i], 0.03, 0.14)
		lan.position = _ground_at(tx)
		lan.z_index = 1
		_wfx.add_child(lan)
		lan.set_grow_minutes(0.6)
		lan.pop_in(1.2 + _fixed("%s:lp:%d" % [eid, i]) * 0.8)
		_lanterns.append(lan)


# A gentle round of blooming: a handful of young things nudged a little further
# open each tick while the festival runs. Never a reset, never a jump.
func _festival_bloom_round() -> void:
	var recs: Array = _live_records()
	if recs.is_empty():
		return
	var n: int = mini(4, recs.size())
	for i in range(n):
		var idx: int = (_rr + i) % recs.size()
		var rec: Dictionary = recs[idx]
		var nv: Variant = rec.get("node", null)
		if not (nv is ProcNode) or not is_instance_valid(nv as ProcNode):
			continue
		var pn: ProcNode = nv as ProcNode
		if bool(rec.get("minted", false)) or pn.grow_rate <= 0.0:
			continue
		if pn.growth >= 0.995 or pn.growth < 0.04:
			continue
		var k: String = _kind_of(pn, rec)
		if k != "plant" and k != "tree" and k != "fungus":
			continue
		pn.grow_to(minf(1.0, pn.growth + 0.02), 1.6)
		if _rand("bloomfx") < 0.3:
			_fx(pn.position + Vector2(0.0, -float(rec.get("footprint", 24.0))), "sparkle", "plant")
	_rr = (_rr + n) % maxi(1, recs.size())


# =============================================================================
# MERCHANT — he walks in, he stands, you trade out of the bundles at his feet
# =============================================================================
func _merchant_species(eid: String) -> String:
	return _creature_pick("%s:who" % eid)


func _build_merchant(eid: String, data: Dictionary) -> void:
	_dismiss_merchant()
	if _wfx == null:
		return
	var from_left: bool = bool(data.get("from_left", true))
	var start_tx: float = (_ext.x + 24.0) if from_left else (_ext.y - 24.0)
	var stop_tx: float = float(data.get("stop_tx", _heart_tx + 220.0))
	stop_tx = clampf(stop_tx, _ext.x + 140.0, _ext.y - 140.0)

	var holder: Node2D = Node2D.new()
	holder.name = "Merchant"
	holder.z_index = 2
	holder.position = _ground_at(start_tx)
	_wfx.add_child(holder)

	var species: String = String(data.get("species", "pip"))
	var ctx: Dictionary = {}
	if _space != null and _space.has_method("build_context"):
		ctx = _space.call("build_context", holder.position, 30.0)
	var body: ProcNode = ProcCreatures.make(world_seed, "%s:merch" % eid, species, ctx)
	body.grow_rate = 0.0
	body.set_growth(1.0)
	holder.add_child(body)

	var fr: float = 30.0
	if "footprint_radius" in body:
		fr = maxf(16.0, float(body.get("footprint_radius")))
	var pack: _MerchantPack = _MerchantPack.new()
	pack.seedv = hash("%d:%s:pack" % [world_seed, eid])
	pack.span = fr
	pack.position = Vector2(-fr * 0.42, -fr * 1.05)
	pack.grow_rate = 0.0
	pack.set_growth(1.0)
	holder.add_child(pack)

	_merchant = {
		"holder": holder, "body": body, "pack": pack,
		"tx": start_tx, "stop_tx": stop_tx, "dir": 1.0 if from_left else -1.0,
		"state": "walk", "t": 0.0, "eid": eid, "bundles": [],
	}
	if body.has_method("set_facing"):
		body.call("set_facing", 1 if from_left else -1)
	else:
		body.scale.x = 1.0 if from_left else -1.0


func _merchant_arrived() -> void:
	if _merchant.is_empty():
		return
	_merchant["state"] = "stand"
	var eid: String = String(_merchant.get("eid", ""))
	var data: Dictionary = event_data()
	var offers: Array = data.get("offers", []) if (data.get("offers", []) is Array) else []
	var taken: Dictionary = data.get("taken", {}) if (data.get("taken", {}) is Dictionary) else {}
	var stop_tx: float = float(_merchant.get("stop_tx", _heart_tx))
	var dir: float = float(_merchant.get("dir", 1.0))
	var bundles: Array = []
	for i in range(offers.size()):
		if taken.has(str(i)):
			continue
		var off: Dictionary = offers[i]
		var tx: float = stop_tx + dir * (56.0 + 64.0 * float(i))
		var b: _OfferBundle = _OfferBundle.new()
		b.seedv = hash("%d:%s:bun:%d" % [world_seed, eid, i])
		b.glyph = String(off.get("glyph", "seed"))
		b.price_glyph = String(off.get("price_glyph", "coin"))
		b.price_pips = clampi(int(off.get("pips", 2)), 1, 5)
		b.position = _ground_at(tx)
		b.z_index = 2
		_wfx.add_child(b)
		b.set_grow_minutes(0.4)
		b.pop_in(0.9)
		bundles.append({"node": b, "idx": i, "tx": tx})
	_merchant["bundles"] = bundles
	_whisper("He sets three bundles down on the grass and waits.")
	_refresh_bundle_affordability()


func _refresh_bundle_affordability() -> void:
	if _merchant.is_empty():
		return
	var data: Dictionary = event_data()
	var offers: Array = data.get("offers", []) if (data.get("offers", []) is Array) else []
	var bundles: Array = _merchant.get("bundles", []) if (_merchant.get("bundles", []) is Array) else []
	for item in bundles:
		var b: Dictionary = item
		var nv: Variant = b.get("node", null)
		if not (nv is _OfferBundle) or not is_instance_valid(nv as _OfferBundle):
			continue
		var idx: int = int(b.get("idx", 0))
		if idx < 0 or idx >= offers.size():
			continue
		var off: Dictionary = offers[idx]
		(nv as _OfferBundle).set_affordable(_can_pay(off))


# He does not blink out of existence — he picks his bundles up and walks on.
func _merchant_depart() -> void:
	if _merchant.is_empty():
		return
	var bundles: Array = _merchant.get("bundles", []) if (_merchant.get("bundles", []) is Array) else []
	for item in bundles:
		var b: Dictionary = item
		_fade_free(b.get("node", null))
	_merchant["bundles"] = []
	_merchant["state"] = "leave"
	var body: Variant = _merchant.get("body", null)
	if body is Node2D and is_instance_valid(body as Node2D):
		(body as Node2D).scale.x = -float(_merchant.get("dir", 1.0))


func _dismiss_merchant() -> void:
	if _merchant.is_empty():
		return
	var bundles: Array = _merchant.get("bundles", []) if (_merchant.get("bundles", []) is Array) else []
	for item in bundles:
		var b: Dictionary = item
		_fade_free(b.get("node", null))
	_fade_free(_merchant.get("holder", null))
	_merchant = {}


# --- the three seeded offers -------------------------------------------------
func _build_offers(eid: String) -> Array:
	# A seeded walk over the archetypes: same world, same merchant, same bundles.
	# An archetype that cannot be honoured right now (no Chains, no home for an egg)
	# is skipped and the walk carries on, so there are always three.
	var pool: Array = ["tree_seed", "flower_seed", "crystal", "recipe", "egg", "decor", "spore"]
	var start: int = int(_fixed("%s:op" % eid) * float(pool.size()))
	var offers: Array = []
	var tried: Array = []
	for step in range(pool.size()):
		var idx: int = (start + step) % pool.size()
		var key: String = String(pool[idx])
		tried.append(key)
		var off: Dictionary = _make_offer(key, eid, offers.size())
		if off.is_empty():
			continue
		off["key"] = key
		offers.append(off)
		if offers.size() >= 3:
			break
	var guard: int = 0
	while offers.size() < 3 and guard < 4:
		guard += 1
		var fb: Dictionary = _make_offer("flower_seed", eid, offers.size())
		if fb.is_empty():
			break
		fb["key"] = "flower_seed"
		offers.append(fb)
	return offers


func _make_offer(key: String, eid: String, slot: int) -> Dictionary:
	var asc: float = 1.0
	if Game != null and Game.state is Dictionary:
		var a: Dictionary = Game.state.get("ascension", {}) if (Game.state.get("ascension", {}) is Dictionary) else {}
		asc = 1.0 + 0.3 * float(a.get("count", 0))
	match key:
		"tree_seed":
			var sp: String = _wild_pick(ItemCatalog.WILD_TREES, "%s:ts:%d" % [eid, slot])
			return {
				"give": {"kind": "res", "id": "timber", "n": _essence_cost(2.0, 40.0, 900.0) * 0.6 * asc},
				"get": {"item": "seed:%s" % sp, "entry": _seed_entry("tree", sp), "n": 2,
						"label": "%s seed" % sp.capitalize()},
				"glyph": "seed", "price_glyph": "wood", "pips": 3,
			}
		"flower_seed":
			var fp: String = _wild_pick(ItemCatalog.WILD_PLANTS, "%s:fs:%d" % [eid, slot])
			return {
				"give": {"kind": "res", "id": "essence", "n": _essence_cost(3.0, 60.0, 1800.0) * asc},
				"get": {"item": "seed:%s" % fp, "entry": _seed_entry("plant", fp), "n": 3,
						"label": "%s seed" % fp.capitalize()},
				"glyph": "flower", "price_glyph": "coin", "pips": 2,
			}
		"crystal":
			var cp: String = _wild_pick(ItemCatalog.WILD_CRYSTALS, "%s:cs:%d" % [eid, slot])
			return {
				"give": {"kind": "res", "id": "stone", "n": _essence_cost(4.0, 60.0, 1400.0) * 0.7 * asc},
				"get": {"item": "shard:%s" % cp, "entry": _seed_entry("crystal", cp), "n": 1,
						"label": "%s shard" % cp.capitalize()},
				"glyph": "crystal", "price_glyph": "stone", "pips": 3,
			}
		"recipe":
			var ch: Node = _sib("Chains")
			if ch == null or not ch.has_method("learn") or not ch.has_method("knows"):
				return {}
			var rid: String = "rootbalm"
			if bool(ch.call("knows", rid)):
				rid = "kindling_lamp"
				if bool(ch.call("knows", rid)):
					return {}
			return {
				"give": {"kind": "res", "id": "stardust", "n": maxf(2.0, 4.0 * asc)},
				"get": {"recipe": rid, "label": "a way of making %s" % rid.replace("_", " ")},
				"glyph": "scroll", "price_glyph": "star", "pips": 2,
			}
		"egg":
			var cl: Node = _sib("CreatureLife")
			if cl != null and cl.has_method("home_capacity") and int(cl.call("home_capacity")) <= 0:
				return {}
			var sp2: String = _creature_pick("%s:eg:%d" % [eid, slot])
			return {
				"give": {"kind": "res", "id": "stardust", "n": maxf(4.0, 8.0 * asc)},
				"get": {"item": "egg:%s" % sp2, "entry": {"count": 0, "kind": "creature",
						"species": sp2, "label": "%s (egg)" % sp2.capitalize(),
						"growth": -1.0, "minted": false}, "n": 1,
						"label": "a sleeping %s" % sp2.capitalize()},
				"glyph": "egg", "price_glyph": "star", "pips": 4,
			}
		"decor":
			var dp: String = _wild_pick(ItemCatalog.WILD_DECOR, "%s:dc:%d" % [eid, slot])
			return {
				"give": {"kind": "res", "id": "essence", "n": _essence_cost(5.0, 90.0, 2600.0) * asc},
				"get": {"item": "decor:%s" % dp, "entry": _seed_entry("decor", dp), "n": 1,
						"label": dp.capitalize()},
				"glyph": "lantern", "price_glyph": "coin", "pips": 3,
			}
		"spore":
			var gp: String = _wild_pick(ItemCatalog.WILD_FUNGI, "%s:sp:%d" % [eid, slot])
			return {
				"give": {"kind": "mat", "id": "lichen_wool", "n": 1},
				"get": {"item": "spore:%s" % gp, "entry": _seed_entry("fungus", gp), "n": 3,
						"label": "%s spores" % gp.capitalize()},
				"glyph": "mushroom", "price_glyph": "wool", "pips": 1,
			}
	return {}


# Costs read as "minutes of your current income", so the merchant stays meaningful
# at every stage (the Rituals pattern), with absolute guard rails.
func _essence_cost(mins: float, lo: float, hi: float) -> float:
	var rate: float = 1.0
	if _sim != null and _sim.has_method("rates"):
		var rr: Variant = _sim.call("rates")
		if rr is Dictionary:
			rate = maxf(0.5, float((rr as Dictionary).get("essence", 1.0)))
	return clampf(mins * 60.0 * rate, lo, hi)


func _can_pay(off: Dictionary) -> bool:
	var give: Dictionary = off.get("give", {}) if (off.get("give", {}) is Dictionary) else {}
	var k: String = String(give.get("kind", "res"))
	var id: String = String(give.get("id", "essence"))
	var n: float = float(give.get("n", 1.0))
	if k == "mat":
		var ch: Node = _sib("Chains")
		if ch == null or not ch.has_method("stock"):
			return false
		return int(ch.call("stock", id)) >= int(ceil(n))
	if Game == null:
		return false
	return Game.res(id) >= n


func _take_payment(off: Dictionary) -> bool:
	var give: Dictionary = off.get("give", {}) if (off.get("give", {}) is Dictionary) else {}
	var k: String = String(give.get("kind", "res"))
	var id: String = String(give.get("id", "essence"))
	var n: float = float(give.get("n", 1.0))
	if k == "mat":
		var ch: Node = _sib("Chains")
		if ch == null or not ch.has_method("take"):
			return false
		return bool(ch.call("take", id, int(ceil(n))))
	if Game == null:
		return false
	return bool(Game.spend({id: n}))


func _accept_offer(idx: int, at: Vector2) -> bool:
	if event_kind() != "merchant":
		return false
	var st: Dictionary = _st()
	var ev: Dictionary = st.get("event", {})
	var data: Dictionary = ev.get("data", {}) if (ev.get("data", {}) is Dictionary) else {}
	var offers: Array = data.get("offers", []) if (data.get("offers", []) is Array) else []
	if idx < 0 or idx >= offers.size():
		return false
	var taken: Dictionary = data.get("taken", {}) if (data.get("taken", {}) is Dictionary) else {}
	if taken.has(str(idx)):
		return false
	var off: Dictionary = offers[idx]
	if not _can_pay(off):
		_whisper("He shakes his head, kindly. Not yet.")
		return true
	if not _take_payment(off):
		_whisper("He shakes his head, kindly. Not yet.")
		return true
	var get_d: Dictionary = off.get("get", {}) if (off.get("get", {}) is Dictionary) else {}
	var got: Dictionary = {}
	if get_d.has("recipe"):
		var ch: Node = _sib("Chains")
		var rid: String = String(get_d.get("recipe", ""))
		if ch != null and ch.has_method("learn"):
			ch.call("learn", rid)
		got["recipe"] = rid
		_discover("recipe:%s" % rid, {"category": "recipes", "label": rid.capitalize(),
			"line": "Traded for, on a grey afternoon, from a stranger."})
	else:
		var item: String = String(get_d.get("item", ""))
		var entry: Dictionary = get_d.get("entry", {}) if (get_d.get("entry", {}) is Dictionary) else {}
		var n: int = maxi(1, int(get_d.get("n", 1)))
		if item != "" and not entry.is_empty():
			_grant(item, entry, n)
			got[item] = n
	taken[str(idx)] = true
	data["taken"] = taken
	ev["data"] = data
	st["event"] = ev
	st["traded"] = int(st.get("traded", 0)) + 1
	# the bundle lifts, puffs, and is gone
	var bundles: Array = _merchant.get("bundles", []) if (_merchant.get("bundles", []) is Array) else []
	var keep: Array = []
	for b_item in bundles:
		var b: Dictionary = b_item
		if int(b.get("idx", -1)) == idx:
			_fade_free(b.get("node", null))
		else:
			keep.append(b)
	_merchant["bundles"] = keep
	_fx(at + Vector2(0.0, -26.0), "puff", "light")
	_whisper("A fair trade. He tucks your payment away. — %s" % String(get_d.get("label", "something good")))
	var give: Dictionary = off.get("give", {}) if (off.get("give", {}) is Dictionary) else {}
	emit_signal("dyn_event", "merchant_traded", {"gave": give, "got": got})
	_refresh_bundle_affordability()
	if Game != null:
		Game.save_now()
	return true


# =============================================================================
# MIGRATION
# =============================================================================
func _migrant_flavour(eid: String) -> String:
	var pool: Array = ["longwing", "tern", "sparrow", "crane", "swift"]
	var i: int = int(_fixed("%s:mf" % eid) * float(pool.size()))
	return String(pool[clampi(i, 0, pool.size() - 1)])


func _build_migrants(eid: String) -> void:
	for item in _migrants:
		var m: Dictionary = item
		_fade_free(m.get("node", null))
	_migrants = []
	if _wfx == null:
		return
	var n: int = clampi(int(_fixed_range("%s:mn" % eid, 3.0, float(MAX_MIGRANTS) + 0.9)), 3, MAX_MIGRANTS)
	var left: bool = _fixed("%s:mdir" % eid) < 0.5
	for i in range(n):
		var b: _Migrant = _Migrant.new()
		b.seedv = hash("%d:%s:bird:%d" % [world_seed, eid, i])
		b.hue = _fixed_range("%s:mh" % eid, 0.02, 0.12)
		b.grow_rate = 0.0
		b.set_growth(1.0)
		b.z_index = 4
		var gy: float = _ground_at(_heart_tx).y
		var high: float = gy - 420.0 - _fixed("%s:my:%d" % [eid, i]) * 260.0
		var start_x: float = (_ext.x - 240.0) if left else (_ext.y + 240.0)
		b.position = Vector2(start_x - float(i) * (90.0 if left else -90.0), high + float(i) * 26.0)
		_wfx.add_child(b)
		var spd: float = _fixed_range("%s:ms:%d" % [eid, i], 38.0, 62.0)
		_migrants.append({
			"node": b, "vel": Vector2(spd if left else -spd, _fixed_range("%s:mv:%d" % [eid, i], -4.0, 4.0)),
			"greeted": false, "bob": _fixed("%s:mb:%d" % [eid, i]) * TAU,
		})


func _greet_migrant(m: Dictionary) -> bool:
	if bool(m.get("greeted", false)):
		return false
	m["greeted"] = true
	var nv: Variant = m.get("node", null)
	if nv is Node2D and is_instance_valid(nv as Node2D):
		var nd: Node2D = nv as Node2D
		_fx(nd.position, "sparkle", "light")
		if nd is _Migrant:
			(nd as _Migrant).flourish()
	_whisper("It tips a wing at you on the way past.")
	emit_signal("dyn_event", "migration_greeted", {"n": 1})
	var cl: Node = _sib("CreatureLife")
	if cl != null and cl.has_method("notify"):
		cl.call("notify", "migration_greeted", {"n": 1})
	if _rand("greetgift") < 0.4:
		_give_mat("lichen_wool", 1)
	return true


# =============================================================================
# METEOR SHOWER
# =============================================================================
func _spawn_star() -> void:
	if _wfx == null or _stars.size() >= MAX_STARS:
		return
	var data: Dictionary = event_data()
	var hue: float = float(data.get("hue", 0.6))
	var s: _FallingStar = _FallingStar.new()
	var n: int = int(_st().get("seq", 0))
	s.seedv = hash("%d:star:%d" % [world_seed, n])
	s.hue = fposmod(hue + (_rand("sh") - 0.5) * 0.14, 1.0)
	s.grow_rate = 0.0
	s.set_growth(1.0)
	s.z_index = 5
	var tx: float = lerpf(_ext.x * 0.9, _ext.y * 0.9, _rand("stx"))
	var gy: float = _ground_at(tx).y
	var from: Vector2 = Vector2(_ground_at(tx).x, gy - 980.0 - _rand("sy") * 240.0)
	var drift: float = (_rand("sd") - 0.5) * 2.0
	var vel: Vector2 = Vector2(drift * 120.0, 210.0 + _rand("sv") * 120.0)
	s.position = from
	s.rotation = vel.angle()
	_wfx.add_child(s)
	var fall: float = (gy - 40.0 - from.y) / maxf(40.0, vel.y)
	_stars.append({"node": s, "vel": vel, "life": 0.0, "max_life": maxf(2.0, fall), "tx": tx})


func _catch_star(s: Dictionary) -> void:
	var st: Dictionary = _st()
	st["caught"] = int(st.get("caught", 0)) + 1
	var nv: Variant = s.get("node", null)
	var at: Vector2 = Vector2.ZERO
	if nv is Node2D and is_instance_valid(nv as Node2D):
		at = (nv as Node2D).position
		(nv as Node2D).queue_free()
	var dust: float = 2.0 + floor(_rand("dust") * 4.0)
	if Game != null:
		Game.add_resource("stardust", dust)
	_fx(at, "harvest", "light", "stardust")
	var total: int = int(st.get("caught", 0))
	if total % 3 == 0:
		_give_mat("skyshard", 1)
		_whisper("A shard of it survived the fall. It is cold, and it hums.")
	else:
		_whisper("Caught. A pinch of stardust, still warm.")
	emit_signal("dyn_event", "meteor_caught", {"n": 1, "total": total})
	_discover("event:meteor", {"category": "events", "label": "Meteor Shower",
		"line": "You stood outside and caught one in your hands."})


# An uncaught star does not vanish — it lands and waits on the grass.
func _land_star(s: Dictionary) -> void:
	var nv: Variant = s.get("node", null)
	var tx: float = float(s.get("tx", 0.0))
	if nv is Node2D and is_instance_valid(nv as Node2D):
		var at: Vector2 = (nv as Node2D).position
		(nv as Node2D).queue_free()
		_fx(Vector2(at.x, _ground_at(tx).y), "puff", "crystal")
	if _pebbles.size() >= MAX_PEBBLES:
		return
	var st: Dictionary = _st()
	var n: int = int(st.get("pb_n", 0)) + 1
	st["pb_n"] = n
	var until: float = _unix() + PEBBLE_HOURS * 3600.0
	var pid: String = "pb%d" % n
	_add_pebble(pid, tx, until, true)
	var arr: Array = st.get("pebbles", [])
	arr.append({"id": pid, "tx": tx, "until": until})
	st["pebbles"] = arr


func _add_pebble(pid: String, tx: float, until: float, fresh: bool) -> void:
	if _wfx == null or _pebbles.size() >= MAX_PEBBLES:
		return
	var p: _StarPebble = _StarPebble.new()
	p.seedv = hash("%d:peb:%s" % [world_seed, pid])
	p.hue = Proc.hashf(world_seed, "peb:hue:%s" % pid) * 0.2 + 0.52
	p.position = _ground_at(tx)
	p.z_index = 1
	_wfx.add_child(p)
	p.set_grow_minutes(0.5)
	if fresh:
		p.pop_in(0.8)
		_fx(p.position, "puff", "crystal")
	else:
		p.set_growth(1.0)
	_pebbles.append({"node": p, "pid": pid, "tx": tx, "until": until})


func _restore_pebbles() -> void:
	for item in _pebbles:
		var p: Dictionary = item
		_fade_free(p.get("node", null))
	_pebbles = []
	var st: Dictionary = _st()
	var arr: Array = st.get("pebbles", [])
	var now: float = _unix()
	for item2 in arr:
		var d: Dictionary = item2
		if float(d.get("until", 0.0)) <= now:
			continue
		_add_pebble(String(d.get("id", "p")), float(d.get("tx", 0.0)), float(d.get("until", 0.0)), false)


func _expire_pebbles(now: float) -> void:
	var st: Dictionary = _st()
	var arr: Array = st.get("pebbles", [])
	var keep_s: Array = []
	for item in arr:
		var d: Dictionary = item
		if float(d.get("until", 0.0)) > now:
			keep_s.append(d)
	st["pebbles"] = keep_s
	var keep: Array = []
	for item2 in _pebbles:
		var p: Dictionary = item2
		if float(p.get("until", 0.0)) <= now:
			_fade_free(p.get("node", null))
		else:
			keep.append(p)
	_pebbles = keep


func _take_pebble(p: Dictionary) -> void:
	var nv: Variant = p.get("node", null)
	var at: Vector2 = Vector2.ZERO
	if nv is Node2D and is_instance_valid(nv as Node2D):
		at = (nv as Node2D).position
		_fade_free(nv)
	var pid: String = String(p.get("pid", ""))
	var st: Dictionary = _st()
	var arr: Array = st.get("pebbles", [])
	var keep_s: Array = []
	for item in arr:
		var d: Dictionary = item
		if String(d.get("id", "")) != pid:
			keep_s.append(d)
	st["pebbles"] = keep_s
	var keep: Array = []
	for item2 in _pebbles:
		var q: Dictionary = item2
		if String(q.get("pid", "")) != pid:
			keep.append(q)
	_pebbles = keep
	if Game != null:
		Game.add_resource("stardust", 2.0 + floor(_rand("pbd") * 3.0))
	_fx(at, "harvest", "crystal", "stardust")
	_whisper("Still warm from the fall. You pocket it.")
	emit_signal("dyn_event", "meteor_caught", {"n": 1, "total": int(st.get("caught", 0))})


# =============================================================================
# PER-FRAME ACTORS  (§8 — early-returns to nothing when the sky is quiet)
# =============================================================================
func _animate_actors(delta: float) -> void:
	var kind: String = event_kind()
	if kind == "meteor":
		_tick_stars(delta)
	if not _migrants.is_empty():
		_tick_migrants(delta)
	if not _merchant.is_empty():
		_tick_merchant(delta)


func _tick_stars(delta: float) -> void:
	var data: Dictionary = event_data()
	var cad: float = maxf(4.0, float(data.get("cadence", 12.0)))
	_star_acc += delta
	if _star_acc >= cad and _stars.size() < MAX_STARS:
		_star_acc = 0.0
		_spawn_star()
	if _stars.is_empty():
		return
	var keep: Array = []
	for item in _stars:
		var s: Dictionary = item
		var nv: Variant = s.get("node", null)
		if not (nv is Node2D) or not is_instance_valid(nv as Node2D):
			continue
		var nd: Node2D = nv as Node2D
		var life: float = float(s.get("life", 0.0)) + delta
		s["life"] = life
		var vel: Vector2 = s.get("vel", Vector2(0.0, 200.0))
		nd.position += vel * delta
		if life >= float(s.get("max_life", 3.0)):
			_land_star(s)
			continue
		keep.append(s)
	_stars = keep


func _tick_migrants(delta: float) -> void:
	var keep: Array = []
	for item in _migrants:
		var m: Dictionary = item
		var nv: Variant = m.get("node", null)
		if not (nv is Node2D) or not is_instance_valid(nv as Node2D):
			continue
		var nd: Node2D = nv as Node2D
		var vel: Vector2 = m.get("vel", Vector2(40.0, 0.0))
		nd.position += vel * delta
		nd.position.y += sin(nd.position.x * 0.004 + float(m.get("bob", 0.0))) * 6.0 * delta
		if nd.position.x < _ext.x - 420.0 or nd.position.x > _ext.y + 420.0:
			nd.queue_free()
			continue
		keep.append(m)
	_migrants = keep


func _tick_merchant(delta: float) -> void:
	var holder: Variant = _merchant.get("holder", null)
	if not (holder is Node2D) or not is_instance_valid(holder as Node2D):
		_merchant = {}
		return
	var nd: Node2D = holder as Node2D
	var state: String = String(_merchant.get("state", "walk"))
	var tx: float = float(_merchant.get("tx", 0.0))
	var dir: float = float(_merchant.get("dir", 1.0))
	_merchant["t"] = float(_merchant.get("t", 0.0)) + delta
	match state:
		"walk":
			var stop_tx: float = float(_merchant.get("stop_tx", 0.0))
			var step: float = 26.0 * delta * dir
			tx += step
			if (dir > 0.0 and tx >= stop_tx) or (dir < 0.0 and tx <= stop_tx):
				tx = stop_tx
				_merchant["tx"] = tx
				nd.position = _ground_at(tx)
				_merchant_arrived()
				return
			_merchant["tx"] = tx
			nd.position = _ground_at(tx)
		"stand":
			nd.position = _ground_at(tx)
			nd.position.y -= absf(sin(float(_merchant.get("t", 0.0)) * 1.1)) * 1.6
		"leave":
			tx -= 30.0 * delta * dir          # back out the way he came in
			_merchant["tx"] = tx
			nd.position = _ground_at(tx)
			if tx <= _ext.x + 14.0 or tx >= _ext.y - 14.0:
				_dismiss_merchant()


# =============================================================================
# AMBIENCE  (season life: pollen, butterflies, leaves, snow, rain, fireflies…)
# =============================================================================
func _wanted_ambience() -> Array:
	var out: Array = []
	var ek: String = event_kind()
	var night: bool = is_night()
	if ek == "bloomtide" or weather() == "storm":
		out.append("rain")
	if ek == "migration":
		out.append("birds")
	match season_id():
		"greenrise":
			if not out.has("pollen"):
				out.append("pollen")
			if not night:
				out.append("butterflies")
		"highsun":
			out.append("dust")
			if not night:
				out.append("bees")
		"emberfall":
			out.append("leaves")
			if weather() == "mist":
				out.append("spores")
		"stillfrost":
			out.append("snow")
	if night and not out.has("fireflies") and out.size() < MAX_AMBIENCE:
		out.append("fireflies")
	while out.size() > MAX_AMBIENCE:
		out.remove_at(out.size() - 1)
	return out


func _refresh_ambience() -> void:
	if _screen == null:
		return
	var want: Array = _wanted_ambience()
	var sig: String = "|".join(PackedStringArray(want))
	if sig == _amb_sig:
		return
	_amb_sig = sig
	# retire what is no longer wanted
	for k in _ambience.keys():
		var kid: String = String(k)
		if want.has(kid):
			continue
		var n: Variant = _ambience[kid]
		_fade_free(n)
		_ambience.erase(kid)
	# raise what is newly wanted
	for k2 in want:
		var kid2: String = String(k2)
		if _ambience.has(kid2) and is_instance_valid(_ambience[kid2]):
			continue
		var opts: Dictionary = {"density": _ambience_density(kid2)}
		var eff: ProcNode = ProcAmbience.make_effect(world_seed, "dynseason:%s" % kid2, kid2, _vp, opts)
		if eff == null:
			continue
		eff.z_index = 5 if kid2 == "birds" else 4
		eff.modulate.a = 0.0
		_screen.add_child(eff)
		var tw: Tween = eff.create_tween()
		tw.tween_property(eff, "modulate:a", 1.0, 14.0)      # the §6.4 cross-fade
		_ambience[kid2] = eff


func _ambience_density(kind: String) -> float:
	match kind:
		"rain": return 1.0 if event_kind() == "bloomtide" else 0.65
		"snow": return 0.85
		"pollen": return 0.9
		"leaves": return 1.0
		"birds": return 1.2
		"butterflies": return 0.8
		"fireflies": return 0.8
		"dust": return 0.7
		_: return 0.7


# =============================================================================
# THE GROW SEAM  (§7.2 — what thrives, applied honestly, round-robin)
# =============================================================================
func _apply_growth_round() -> void:
	var recs: Array = _live_records()
	if recs.is_empty():
		return
	var n: int = mini(24, recs.size())
	for i in range(n):
		var idx: int = (_rr + i) % recs.size()
		var rec: Dictionary = recs[idx]
		var nv: Variant = rec.get("node", null)
		if not (nv is ProcNode) or not is_instance_valid(nv as ProcNode):
			continue
		var pn: ProcNode = nv as ProcNode
		if bool(rec.get("minted", false)):
			continue
		var base: float = 0.0
		if pn.has_meta("dyn_base_grow"):
			base = float(pn.get_meta("dyn_base_grow"))
		elif pn.grow_rate > 0.0:
			base = pn.grow_rate
			pn.set_meta("dyn_base_grow", base)
		if base <= 0.0:
			continue                       # frozen / minted / keepsake: leave it still
		var pid: String = String(rec.get("id", ""))
		pn.grow_rate = base * _effective_grow(pid, _kind_of(pn, rec))
	_rr = (_rr + n) % maxi(1, recs.size())


# The §2.1 shared formula. Every sibling query is optional and guarded; the
# product is clamped to CAP["grow"] with the 0.92 floor.
func _effective_grow(pid: String, kind: String) -> float:
	var m: float = modifier("grow") * thrive_mult(kind)
	var r: Node = _sib("Rituals")
	if r != null and r.has_method("blessing"):
		m *= float(r.call("blessing", "grow"))
	var nu: Node = _sib("Nurture")
	if nu != null and nu.has_method("care_mult"):
		m *= float(nu.call("care_mult", pid, "grow"))
	var cl: Node = _sib("CreatureLife")
	if cl != null and cl.has_method("job_mult"):
		m *= float(cl.call("job_mult", pid, "grow"))
	var di: Node = _sib("Discovery")
	if di != null and di.has_method("variant_mult"):
		m *= float(di.call("variant_mult", pid, "grow"))
	return clampf(m, 0.92, 1.60)


# =============================================================================
# GESTURES  (§4.2 — first system to return true consumes)
# =============================================================================
func handle_tap(_screen_pos: Vector2, world_pos: Vector2) -> bool:
	# a falling star beats everything else on the island
	for i in range(_stars.size()):
		var s: Dictionary = _stars[i]
		var nv: Variant = s.get("node", null)
		if nv is Node2D and is_instance_valid(nv as Node2D):
			if (nv as Node2D).position.distance_to(world_pos) <= TAP_STAR:
				_stars.remove_at(i)
				_catch_star(s)
				return true
	for j in range(_pebbles.size()):
		var p: Dictionary = _pebbles[j]
		var nv2: Variant = p.get("node", null)
		if nv2 is Node2D and is_instance_valid(nv2 as Node2D):
			if (nv2 as Node2D).position.distance_to(world_pos) <= TAP_PEBBLE:
				_take_pebble(p)
				return true
	if not _merchant.is_empty():
		var bundles: Array = _merchant.get("bundles", []) if (_merchant.get("bundles", []) is Array) else []
		for item3 in bundles:
			var b: Dictionary = item3
			var nv3: Variant = b.get("node", null)
			if nv3 is Node2D and is_instance_valid(nv3 as Node2D):
				if (nv3 as Node2D).position.distance_to(world_pos) <= TAP_BUNDLE:
					return _accept_offer(int(b.get("idx", -1)), (nv3 as Node2D).position)
		var holder: Variant = _merchant.get("holder", null)
		if holder is Node2D and is_instance_valid(holder as Node2D):
			var hp: Vector2 = (holder as Node2D).position
			if absf(world_pos.x - hp.x) <= TAP_MERCHANT and world_pos.y < hp.y + 20.0 and world_pos.y > hp.y - 180.0:
				_whisper(_merchant_line())
				return true
	for item4 in _migrants:
		var m: Dictionary = item4
		var nv4: Variant = m.get("node", null)
		if nv4 is Node2D and is_instance_valid(nv4 as Node2D):
			if (nv4 as Node2D).position.distance_to(world_pos) <= TAP_BIRD:
				if _greet_migrant(m):
					return true
	for item5 in _lanterns:
		if item5 is Node2D and is_instance_valid(item5 as Node2D):
			var lp: Vector2 = (item5 as Node2D).position
			if absf(world_pos.x - lp.x) < 42.0 and world_pos.y < lp.y + 16.0 and world_pos.y > lp.y - 150.0:
				_whisper("Paper, a wick, and somebody's good mood.")
				return true
	return false


func _merchant_line() -> String:
	var data: Dictionary = event_data()
	var offers: Array = data.get("offers", []) if (data.get("offers", []) is Array) else []
	var taken: Dictionary = data.get("taken", {}) if (data.get("taken", {}) is Dictionary) else {}
	if taken.size() >= offers.size() and offers.size() > 0:
		return "His bundles are empty. He seems pleased about it."
	var parts: Array = []
	for i in range(offers.size()):
		if taken.has(str(i)):
			continue
		var off: Dictionary = offers[i]
		var g: Dictionary = off.get("get", {}) if (off.get("get", {}) is Dictionary) else {}
		parts.append(String(g.get("label", "something")))
	if parts.is_empty():
		return "He has nothing left to give."
	return "He is carrying " + ", ".join(PackedStringArray(parts)) + ". Touch a bundle to trade."


# The offer verbs, in case the maintainer ever routes the merchant through the
# ActionBubble as well. Tapping the bundles is the real, diegetic path.
func handle_action(action: String, _record: Dictionary) -> bool:
	match action:
		"offer1": return _accept_offer(0, _merchant_pos())
		"offer2": return _accept_offer(1, _merchant_pos())
		"offer3": return _accept_offer(2, _merchant_pos())
	return false


func _merchant_pos() -> Vector2:
	var holder: Variant = _merchant.get("holder", null)
	if holder is Node2D and is_instance_valid(holder as Node2D):
		return (holder as Node2D).position
	return Vector2.ZERO


# =============================================================================
# INBOUND  (§4.3 — we only ever listen; we never import a sibling to hear it)
# =============================================================================
func notify(kind: String, payload: Dictionary) -> void:
	match kind:
		"placed":
			if event_kind() == "festival":
				var nv: Variant = payload.get("node", null)
				if nv is ProcNode and is_instance_valid(nv as ProcNode):
					_fx((nv as ProcNode).position, "sparkle", "plant")
			_kin_cache_at = -999.0
		"removed", "bond_up", "job_set":
			_kin_cache_at = -999.0
		"arc_done":
			var arc: String = String(payload.get("arc", ""))
			if arc == "long_table":
				var st: Dictionary = _st()
				st["lanterns_forever"] = true
				_whisper("The festival lanterns stay lit now. Someone keeps them.")
			# an arc closing is reason enough for the island to celebrate
			if event_kind() == "" and _unix() - float(_st().get("last_festival", 0.0)) > FESTIVAL_COOLDOWN * 0.5:
				_start_event("festival", _unix())
		"puzzle_solved":
			# waking new ground pulls the next occasion a little closer
			var st2: Dictionary = _st()
			st2["next_event"] = maxf(_unix() + 300.0, float(st2.get("next_event", 0.0)) - 1200.0)
		"rite_done":
			if String(payload.get("rite", "")) == "rain":
				_kin_cache_at = -999.0
		_:
			pass


# =============================================================================
# CATCH-UP  (boot + resume; seasons turn whether you watched or not)
# =============================================================================
func catch_up(elapsed: float) -> void:
	var st: Dictionary = _st()
	if st.is_empty():
		return
	if not _geom_ok:
		_measure_geometry()
	var now: float = _unix()
	if float(st.get("epoch", 0.0)) <= 0.0:
		st["epoch"] = now
	_credit_offline_pity(elapsed)

	# 1. the season is derived, so it has already turned. Announce, don't replay.
	var s: int = season()
	var prev: int = int(st.get("season", -1))
	st["season"] = s
	st["year"] = year()
	var seen: Dictionary = st.get("seen", {})
	var first: bool = not seen.has(str(s))
	seen[str(s)] = true
	st["seen"] = seen
	if prev >= 0 and prev != s:
		_whisper(String(SEASON_WHISPER.get(season_id(), "The season turned while you were away.")))
		emit_signal("dyn_event", "season_changed", {"season": s, "id": season_id(), "year": year()})
	_shown_season = s
	_discover("season:%s" % season_id(), {"category": "events", "label": season_label(),
		"line": "%s — one quarter of the turning year." % season_label()})

	# 2. the weather plan, re-asserted onto the sky
	if now >= float(st.get("weather_until", 0.0)) or String(st.get("weather", "")) == "":
		var step: int = int(st.get("weather_step", 0)) + 1
		st["weather_step"] = step
		st["weather"] = _roll_weather(step)
		st["weather_until"] = now + Proc.rangef(world_seed, "%s:wdur:%d" % [SYS_KEY, step], 540.0, 1320.0)
	if _sky != null and _sky.has_method("set_weather"):
		_sky.call("set_weather", _sky_weather())
	_apply_sky_season()

	# 3. an event whose window closed while away ends softly, once
	var ev: Dictionary = st.get("event", {})
	if not ev.is_empty():
		if now >= float(ev.get("ends", 0.0)):
			_end_event(now)
		else:
			_build_event_actors(String(ev.get("kind", "")),
				String(ev.get("id", "")),
				ev.get("data", {}) if (ev.get("data", {}) is Dictionary) else {})
			_restore_merchant_progress()
	# 4. never a burst of events on return: if the clock ran past, arrive shortly
	if float(st.get("next_event", 0.0)) < now:
		st["next_event"] = now + Proc.rangef(world_seed, "%s:resume:%d" % [SYS_KEY, int(st.get("ev_n", 0))], 300.0, 1500.0)

	_restore_pebbles()
	if bool(st.get("lanterns_forever", false)) and _lanterns.is_empty():
		_build_lanterns("forever", 7)
	_refresh_ambience()
	if _wash != null:
		_wash.set_look(season_tint(), _wash_alpha(), daylight())
	_retint_world()
	if first and prev >= 0:
		_discover("season:%s" % season_id(), {"category": "events", "label": season_label(),
			"line": "Your first %s." % season_label()})


# If the merchant's walk-in finished while the app was closed, put him where he
# would be standing — he does not re-enter from the edge every time you look.
func _restore_merchant_progress() -> void:
	if _merchant.is_empty():
		return
	var ev: Dictionary = _st().get("event", {})
	var started: float = float(ev.get("started", 0.0))
	if _unix() - started < 60.0:
		return
	_merchant["tx"] = float(_merchant.get("stop_tx", _heart_tx))
	var holder: Variant = _merchant.get("holder", null)
	if holder is Node2D and is_instance_valid(holder as Node2D):
		(holder as Node2D).position = _ground_at(float(_merchant["tx"]))
	_merchant_arrived()


# =============================================================================
# SIBLINGS / WORLD HELPERS
# =============================================================================
func _sib(n: String) -> Node:
	var p: Node = get_parent()
	if p == null:
		return null
	return p.get_node_or_null(n)


func _kin_summary() -> Dictionary:
	if _mono() - _kin_cache_at < 60.0:
		return _kin_cache
	_kin_cache_at = _mono()
	var out: Dictionary = {"n": 0, "fond": 0, "jobs": {}}
	var cl: Node = _sib("CreatureLife")
	if cl == null or not cl.has_method("creatures"):
		_kin_cache = out
		return out
	var arr: Variant = cl.call("creatures")
	if not (arr is Array):
		_kin_cache = out
		return out
	var jobs: Dictionary = {}
	var n: int = 0
	var fond: int = 0
	for item in (arr as Array):
		if not (item is Dictionary):
			continue
		var c: Dictionary = item
		n += 1
		if float(c.get("bond", 0.0)) >= FESTIVAL_MIN_BOND:
			fond += 1
		var j: String = String(c.get("job", ""))
		if j != "":
			jobs[j] = int(jobs.get(j, 0)) + 1
	out["n"] = n
	out["fond"] = fond
	out["jobs"] = jobs
	_kin_cache = out
	return out


func _has_job(job: String) -> bool:
	var jobs: Dictionary = _kin_summary().get("jobs", {})
	return int(jobs.get(job, 0)) > 0


# Prefer the §9.2 records() accessor; fall back to walking the entity layer so the
# system is fully functional before the hook lands.
func _live_records() -> Array:
	if _space == null:
		return []
	if _space.has_method("records"):
		var r: Variant = _space.call("records")
		if r is Array:
			return r as Array
	var out: Array = []
	if not _space.has_method("entity_layer"):
		return out
	var layer: Node = _space.call("entity_layer")
	if layer == null:
		return out
	for c in layer.get_children():
		if c is ProcNode:
			out.append({"id": String(c.name), "node": c, "footprint": 24.0,
				"minted": false, "entry": {}})
	return out


func _kind_of(node: ProcNode, rec: Dictionary) -> String:
	var entry: Variant = rec.get("entry", null)
	if entry is Dictionary:
		var k: String = String((entry as Dictionary).get("kind", ""))
		if k != "":
			return k
	var sc: Script = node.get_script() as Script
	var path: String = String(sc.resource_path) if sc != null else ""
	if path.find("ProcTrees") >= 0:
		return "tree"
	if path.find("ProcPlants") >= 0:
		return "plant"
	if path.find("ProcCreatures") >= 0:
		return "creature"
	if path.find("ProcBuildings") >= 0:
		return "building"
	if path.find("ProcWater") >= 0:
		return "water"
	if path.find("ProcDecor") >= 0:
		return "decor"
	if path.find("ProcFungiCrystals") >= 0:
		var sp: String = ""
		if "species" in node:
			sp = String(node.get("species"))
		if ItemCatalog.WILD_CRYSTALS.has(sp):
			return "crystal"
		return "fungus"
	return "plant"


# =============================================================================
# GRANTS / FX / WHISPERS
# =============================================================================
# §7.3 — the one shared tray-grant pattern, copied verbatim so counts never diverge.
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


# Materials belong to Chains. If Chains is absent the gift becomes essence, so a
# grant is never silently swallowed.
func _give_mat(mat: String, n: int) -> void:
	var ch: Node = _sib("Chains")
	if ch != null and ch.has_method("give"):
		ch.call("give", mat, n)
		emit_signal("dyn_event", "material_gained", {"mat": mat, "n": n, "from_place": "sky"})
		return
	if Game != null:
		Game.add_resource("essence", 12.0 * float(n))


func _tray() -> Node:
	if _interact == null:
		return null
	if _interact.has_method("tray"):
		var t: Variant = _interact.call("tray")
		if t is Node:
			return t as Node
	return _find_tray(_interact)


func _find_tray(n: Node) -> Node:
	if n == null:
		return null
	for c in n.get_children():
		if c is InventoryTray:
			return c as Node
		var deep: Node = _find_tray(c)
		if deep != null:
			return deep
	return null


func _seed_entry(kind: String, species: String) -> Dictionary:
	var label: String = species.capitalize()
	match kind:
		"tree": label = "%s Seed" % species.capitalize()
		"plant": label = "%s Seed" % species.capitalize()
		"fungus": label = "%s Spores" % species.capitalize()
		"crystal": label = "%s Shard" % species.capitalize()
	return {"count": 0, "kind": kind, "species": species, "label": label,
		"growth": -1.0, "minted": false}


func _wild_pick(pool: Array, key: String) -> String:
	if pool.is_empty():
		return "flower"
	var i: int = int(_fixed(key) * float(pool.size()))
	return String(pool[clampi(i, 0, pool.size() - 1)])


func _creature_pick(key: String) -> String:
	var pool: Array = []
	if GameData != null:
		for b in GameData.blocklings:
			if b is Dictionary:
				pool.append(String((b as Dictionary).get("id", "")))
	if pool.is_empty():
		pool = ["pip"]
	var i: int = int(_fixed(key) * float(pool.size()))
	return String(pool[clampi(i, 0, pool.size() - 1)])


func _discover(key: String, meta: Dictionary) -> void:
	var d: Node = _sib("Discovery")
	if d != null and d.has_method("discover"):
		d.call("discover", key, meta)


func _fx(world_pos: Vector2, kind: String, material: String = "", res: String = "") -> void:
	if _wfx == null:
		return
	var opts: Dictionary = {"z": 28}
	if material != "":
		opts["material"] = material
	if res != "":
		opts["resource"] = res
	var n: int = int(_st().get("seq", 0))
	var fx: ProcNode = ProcEffects.make(world_seed, "%s:fx:%d" % [SYS_KEY, n], kind, opts)
	if fx == null:
		return
	fx.position = world_pos
	_wfx.add_child(fx)


func _whisper(text: String) -> void:
	if text == "":
		return
	if _interact != null and _interact.has_method("is_placing") and bool(_interact.call("is_placing")):
		return                      # never speak over a drag — drop the line, don't queue
	var now: float = _mono()
	if now - _last_whisper < WHISPER_GAP:
		return
	_last_whisper = now
	emit_signal("whisper", text)


# =============================================================================
#  GLYPHS — one shared little vocabulary of drawn signs, used by the bundles and
#  the wares on the merchant's back. Recognisable, never abstract, never a font.
# =============================================================================
static func draw_glyph(ci: CanvasItem, kind: String, at: Vector2, r: float, col: Color, ink: Color) -> void:
	match kind:
		"seed":
			var pts: PackedVector2Array = Proc.superellipse(r * 0.52, r * 0.78, 2.4, 26)
			var poly: PackedVector2Array = PackedVector2Array()
			for p in pts:
				poly.append(p.rotated(0.32) + at)
			ci.draw_polygon(poly, Proc.grad_fill(poly, col.lightened(0.22), col.darkened(0.25)))
			ci.draw_polyline(_arc_pts(at + Vector2(0.0, r * 0.1), r * 0.5, PI * 1.15, PI * 1.85, 10),
				ink, maxf(1.0, r * 0.11), true)
		"flower":
			for i in range(6):
				var a: float = TAU * float(i) / 6.0
				var c: Vector2 = at + Vector2(cos(a), sin(a)) * r * 0.5
				var pet: PackedVector2Array = PackedVector2Array()
				var e: PackedVector2Array = Proc.superellipse(r * 0.34, r * 0.22, 2.2, 18)
				for p in e:
					pet.append(p.rotated(a) + c)
				ci.draw_colored_polygon(pet, col.lightened(0.1 + 0.05 * float(i % 2)))
			ci.draw_circle(at, r * 0.26, Color(1.0, 0.92, 0.62, 0.95))
		"crystal":
			var k: PackedVector2Array = PackedVector2Array([
				at + Vector2(0.0, -r), at + Vector2(r * 0.52, -r * 0.18),
				at + Vector2(r * 0.3, r * 0.82), at + Vector2(-r * 0.3, r * 0.82),
				at + Vector2(-r * 0.52, -r * 0.18)])
			ci.draw_polygon(k, Proc.grad_fill(k, col.lightened(0.34), col.darkened(0.22)))
			ci.draw_line(at + Vector2(0.0, -r * 0.92), at + Vector2(0.0, r * 0.74),
				Color(1, 1, 1, 0.4), maxf(1.0, r * 0.08), true)
		"scroll":
			var body: PackedVector2Array = Proc.superellipse(r * 0.72, r * 0.52, 3.4, 26)
			var sp: PackedVector2Array = PackedVector2Array()
			for p in body:
				sp.append(p + at)
			ci.draw_polygon(sp, Proc.grad_fill(sp, PARCH, PARCH.darkened(0.18)))
			for i in range(3):
				var y: float = at.y - r * 0.2 + float(i) * r * 0.22
				ci.draw_line(Vector2(at.x - r * 0.42, y), Vector2(at.x + r * 0.42, y),
					Color(ink.r, ink.g, ink.b, 0.6), maxf(1.0, r * 0.07), true)
		"egg":
			var eg: PackedVector2Array = PackedVector2Array()
			for i in range(26):
				var a2: float = TAU * float(i) / 26.0
				var rr: float = r * (0.62 + 0.14 * cos(a2))
				eg.append(at + Vector2(cos(a2) * rr * 0.86, sin(a2) * rr * 1.12))
			ci.draw_polygon(eg, Proc.grad_fill(eg, PARCH.lightened(0.1), col.darkened(0.1)))
			for i in range(4):
				var a3: float = TAU * float(i) / 4.0 + 0.4
				ci.draw_circle(at + Vector2(cos(a3), sin(a3)) * r * 0.36, r * 0.1,
					Color(col.r, col.g, col.b, 0.75))
		"lantern":
			var lp: PackedVector2Array = Proc.superellipse(r * 0.52, r * 0.68, 3.0, 24)
			var lb: PackedVector2Array = PackedVector2Array()
			for p in lp:
				lb.append(p + at)
			ci.draw_polygon(lb, Proc.grad_fill(lb, Color(1.0, 0.92, 0.66), Color(0.95, 0.68, 0.34)))
			ci.draw_line(at + Vector2(0.0, -r * 0.7), at + Vector2(0.0, -r * 1.05), ink, maxf(1.0, r * 0.1), true)
			ci.draw_circle(at, r * 0.22, Color(1.0, 0.98, 0.8, 0.9))
		"mushroom":
			var cap: PackedVector2Array = _arc_pts(at + Vector2(0.0, r * 0.1), r * 0.74, PI, TAU, 18)
			var capp: PackedVector2Array = PackedVector2Array(cap)
			capp.append(at + Vector2(r * 0.74, r * 0.1))
			capp.append(at + Vector2(-r * 0.74, r * 0.1))
			ci.draw_polygon(capp, Proc.grad_fill(capp, col.lightened(0.26), col.darkened(0.2)))
			var stem: PackedVector2Array = PackedVector2Array([
				at + Vector2(-r * 0.2, r * 0.08), at + Vector2(r * 0.2, r * 0.08),
				at + Vector2(r * 0.14, r * 0.8), at + Vector2(-r * 0.14, r * 0.8)])
			ci.draw_colored_polygon(stem, PARCH.darkened(0.08))
		"wood":
			var lg: PackedVector2Array = Proc.superellipse(r * 0.78, r * 0.34, 3.6, 22)
			var lgp: PackedVector2Array = PackedVector2Array()
			for p in lg:
				lgp.append(p.rotated(-0.22) + at)
			ci.draw_polygon(lgp, Proc.grad_fill(lgp, Color(0.66, 0.46, 0.28), Color(0.38, 0.25, 0.15)))
			ci.draw_arc(at + Vector2(r * 0.52, -r * 0.14), r * 0.2, 0.0, TAU, 16, Color(0.85, 0.7, 0.5, 0.8), maxf(1.0, r * 0.07), true)
		"stone":
			var sb: PackedVector2Array = Proc.blob(int(ci.get_instance_id() % 9973), "gl", r * 0.74, 7, 0.18)
			var sbp: PackedVector2Array = PackedVector2Array()
			for p in sb:
				sbp.append(Vector2(p.x, p.y * 0.72) + at)
			ci.draw_polygon(sbp, Proc.grad_fill(sbp, Color(0.74, 0.74, 0.78), Color(0.42, 0.43, 0.48)))
		"star":
			_draw_star(ci, at, r * 0.95, r * 0.34, Color(1.0, 0.96, 0.74), 5)
		"wool":
			ci.draw_circle(at, r * 0.66, Color(0.80, 0.84, 0.72))
			for i in range(3):
				ci.draw_arc(at, r * (0.26 + 0.18 * float(i)), 0.4, 0.4 + PI * 1.5, 20,
					Color(0.55, 0.62, 0.5, 0.8), maxf(1.0, r * 0.07), true)
		_:
			ci.draw_circle(at, r * 0.6, col)


static func _arc_pts(c: Vector2, r: float, a0: float, a1: float, steps: int) -> PackedVector2Array:
	var out: PackedVector2Array = PackedVector2Array()
	for i in range(steps + 1):
		var a: float = lerpf(a0, a1, float(i) / float(steps))
		out.append(c + Vector2(cos(a), sin(a)) * r)
	return out


static func _draw_star(ci: CanvasItem, c: Vector2, outer: float, inner: float, col: Color, points: int) -> void:
	var pts: PackedVector2Array = PackedVector2Array()
	var n: int = maxi(3, points) * 2
	for i in range(n):
		var a: float = -PI * 0.5 + TAU * float(i) / float(n)
		var r: float = outer if (i % 2 == 0) else inner
		pts.append(c + Vector2(cos(a), sin(a)) * r)
	ci.draw_polygon(pts, Proc.grad_fill(pts, col.lightened(0.3), col.darkened(0.12)))


# =============================================================================
#  _SeasonWash — the season's colour over the whole world. A very soft vertical
#  wash plus a breathing vignette, cross-faded on the turn. During an
#  astral_keeper's early warning it also carries a slow sky shimmer.
# =============================================================================
class _SeasonWash extends ProcNode:
	var size: Vector2 = Vector2(1080.0, 1920.0)
	var tint: Color = Color(1, 1, 1)
	var amount: float = 0.06
	var light: float = 1.0
	var shimmer: bool = false
	var _shown: Color = Color(1, 1, 1)
	var _shown_a: float = 0.0

	func _on_built() -> void:
		z_as_relative = true
		set_grow_minutes(0.0)
		growth = 1.0

	func set_look(c: Color, a: float, daylight_v: float) -> void:
		tint = c
		amount = a
		light = clampf(daylight_v, 0.0, 1.0)

	func set_shimmer(on: bool) -> void:
		shimmer = on
		animate_draw = on

	func _animate(delta: float) -> void:
		var k: float = clampf(delta * 0.6, 0.0, 1.0)
		var before_a: float = _shown_a
		var moved: float = absf(_shown.r - tint.r) + absf(_shown.g - tint.g) + absf(_shown.b - tint.b)
		_shown = _shown.lerp(tint, k)
		_shown_a = lerpf(_shown_a, amount, k)
		if absf(_shown_a - before_a) > 0.0008 or moved > 0.002:
			queue_redraw()

	func _draw() -> void:
		var a: float = _shown_a * (0.6 + 0.4 * (1.0 - light))
		if a <= 0.002:
			return
		var w: float = size.x
		var h: float = size.y
		var poly: PackedVector2Array = PackedVector2Array([
			Vector2(-w * 0.25, -h * 0.25), Vector2(w * 1.25, -h * 0.25),
			Vector2(w * 1.25, h * 1.25), Vector2(-w * 0.25, h * 1.25)])
		var top: Color = Color(_shown.r, _shown.g, _shown.b, a * 1.25)
		var bot: Color = Color(_shown.r, _shown.g, _shown.b, a * 0.35)
		draw_polygon(poly, Proc.grad_fill(poly, top, bot))
		# a soft upper band so the season reads as light, not as a filter
		var vig: Color = Color(_shown.r * 0.5, _shown.g * 0.5, _shown.b * 0.6, a * 0.9)
		for i in range(3):
			var band: float = h * (0.07 + 0.05 * float(i))
			var strip: PackedVector2Array = PackedVector2Array([
				Vector2(-w * 0.25, -h * 0.25), Vector2(w * 1.25, -h * 0.25),
				Vector2(w * 1.25, band), Vector2(-w * 0.25, band)])
			draw_polygon(strip, Proc.grad_fill(strip,
				Color(vig.r, vig.g, vig.b, vig.a * 0.5), Color(vig.r, vig.g, vig.b, 0.0)))
		if shimmer:
			var sh: float = 0.10 + 0.06 * sin(t * 0.8)
			for i in range(3):
				var y0: float = h * (0.10 + 0.08 * float(i)) + sin(t * 0.5 + float(i)) * 22.0
				var pts: PackedVector2Array = PackedVector2Array()
				for j in range(18):
					var u: float = float(j) / 17.0
					pts.append(Vector2(u * w, y0 + sin(u * 6.0 + t * 0.9 + float(i)) * 16.0))
				draw_polyline(pts, Color(0.86, 0.94, 1.0, sh), 7.0, true)


# =============================================================================
#  _FallingStar — a bright head with a tapering, luminous tail and a four-point
#  sparkle. Drawn once; the node is rotated to its velocity and the head twinkles
#  through a child transform, so a sky full of them costs almost nothing.
# =============================================================================
class _FallingStar extends ProcNode:
	var hue: float = 0.6
	var _len: float = 150.0
	var _wid: float = 11.0

	func _on_built() -> void:
		_len = 110.0 + Proc.hashf(seedv, "len") * 110.0
		_wid = 8.0 + Proc.hashf(seedv, "wid") * 7.0
		growth = 1.0
		animate_draw = true          # it is on screen for ~4 s, and it twinkles

	func _draw() -> void:
		var core: Color = Color.from_hsv(hue, 0.28, 1.0)
		var warm: Color = Color.from_hsv(fposmod(hue + 0.08, 1.0), 0.55, 1.0)
		# the tail: a smooth tapering lens behind the head (local -x)
		var top: PackedVector2Array = PackedVector2Array()
		var bot: PackedVector2Array = PackedVector2Array()
		var segs: int = 16
		for i in range(segs + 1):
			var u: float = float(i) / float(segs)
			var x: float = -u * _len
			var hw: float = _wid * 0.5 * pow(1.0 - u, 1.6)
			top.append(Vector2(x, -hw))
			bot.append(Vector2(x, hw))
		var tail: PackedVector2Array = PackedVector2Array(top)
		for i in range(bot.size()):
			tail.append(bot[bot.size() - 1 - i])
		var cols: PackedColorArray = PackedColorArray()
		for p in tail:
			var u2: float = clampf(-p.x / maxf(1.0, _len), 0.0, 1.0)
			cols.append(Color(warm.r, warm.g, warm.b, (1.0 - u2) * 0.72))
		draw_polygon(tail, cols)
		# the glowing head + a slow four-point twinkle
		var tw: float = 0.86 + 0.14 * sin(t * 7.0 + phase)
		for i in range(3):
			var r: float = _wid * (1.5 - 0.42 * float(i)) * tw
			draw_circle(Vector2.ZERO, r, Color(core.r, core.g, core.b, 0.22 + 0.3 * float(i)))
		SeasonsEvents._draw_star(self, Vector2.ZERO, _wid * 1.9 * tw, _wid * 0.4,
			Color(1, 1, 1, 0.9), 4)
		draw_circle(Vector2.ZERO, _wid * 0.42, Color(1, 1, 1, 0.98))


# =============================================================================
#  _StarPebble — what a star becomes when nobody catches it: a small bright stone
#  resting on the grass, breathing, with two slow motes turning around it. It
#  waits six hours and costs you nothing to ignore.
# =============================================================================
class _StarPebble extends ProcNode:
	var hue: float = 0.58
	var _motes: Array = []
	var _shape: PackedVector2Array = PackedVector2Array()

	func _on_built() -> void:
		_shape = Proc.blob(seedv, "peb", 15.0, 8, 0.2)
		for i in range(2):
			var m: Node2D = Node2D.new()
			add_child(m)
			_motes.append(m)

	func _animate(_delta: float) -> void:
		for i in range(_motes.size()):
			var m: Node2D = _motes[i]
			if not is_instance_valid(m):
				continue
			var a: float = t * (0.8 + 0.3 * float(i)) + phase + PI * float(i)
			var gv: float = g()
			m.position = Vector2(cos(a) * 20.0 * gv, -16.0 * gv + sin(a * 1.3) * 6.0 * gv)
			m.scale = Vector2.ONE * (0.7 + 0.3 * sin(t * 3.0 + float(i)))
			m.queue_redraw()
		queue_redraw()

	func _draw() -> void:
		var gv: float = g()
		if gv <= 0.01:
			return
		var col: Color = Color.from_hsv(hue, 0.34, 0.98)
		var breathe: float = 0.94 + 0.06 * sin(t * 1.4 + phase)
		# halo
		for i in range(3):
			var r: float = (30.0 - 7.0 * float(i)) * gv * breathe
			draw_circle(Vector2(0.0, -8.0 * gv), r, Color(col.r, col.g, col.b, 0.07 + 0.05 * float(i)))
		# the stone itself, flattened onto the ground (feet at origin)
		var poly: PackedVector2Array = PackedVector2Array()
		for p in _shape:
			poly.append(Vector2(p.x * gv, p.y * 0.72 * gv - 10.0 * gv))
		draw_polygon(poly, Proc.grad_fill(poly, col.lightened(0.32), col.darkened(0.42)))
		# a lighter top facet + a contact shadow
		var top: PackedVector2Array = PackedVector2Array()
		for i in range(_shape.size()):
			var p2: Vector2 = _shape[i]
			if p2.y < 0.0:
				top.append(Vector2(p2.x * 0.72 * gv, p2.y * 0.5 * gv - 12.0 * gv))
		if top.size() >= 3:
			draw_colored_polygon(top, Color(1, 1, 1, 0.3))
		draw_circle(Vector2(0.0, -1.0), 15.0 * gv, Color(0.1, 0.12, 0.16, 0.14))
		# the four-point spark on its crown
		SeasonsEvents._draw_star(self, Vector2(0.0, -14.0 * gv), 8.0 * gv * breathe, 2.4 * gv,
			Color(1, 1, 1, 0.85), 4)
		# the motes
		for m in _motes:
			if is_instance_valid(m):
				draw_circle((m as Node2D).position, 2.6 * gv, Color(col.r, col.g, col.b, 0.8))


# =============================================================================
#  _FestivalLantern — a paper lantern on a slender stake. Growth-staged: a bare
#  stake, then an unlit lantern, then a lit one with a warm pool of light. It
#  sways from the crossarm, never from the base.
# =============================================================================
class _FestivalLantern extends ProcNode:
	var hue: float = 0.07
	var _h: float = 92.0
	var _body: PackedVector2Array = PackedVector2Array()

	func _on_built() -> void:
		_h = 78.0 + Proc.hashf(seedv, "h") * 36.0
		_body = Proc.superellipse(17.0, 22.0, 3.0, 26)

	func _animate(_delta: float) -> void:
		rotation = sin(t * 0.9 + phase) * 0.045 * g()
		queue_redraw()

	func _draw() -> void:
		var gv: float = g()
		if gv <= 0.01:
			return
		var ink: Color = Color(0.24, 0.19, 0.14)
		var h: float = _h * (0.35 + 0.65 * gv)
		# the stake
		var stake: PackedVector2Array = PackedVector2Array([
			Vector2(-2.6, 0.0), Vector2(2.6, 0.0), Vector2(1.8, -h), Vector2(-1.8, -h)])
		draw_polygon(stake, Proc.grad_fill(stake, Color(0.46, 0.34, 0.22), Color(0.26, 0.19, 0.12)))
		draw_circle(Vector2(0.0, -1.0), 9.0 * gv, Color(0.1, 0.12, 0.1, 0.16))
		if gv < 0.3:
			return
		# the crossarm + hanger
		var open: float = clampf((gv - 0.3) / 0.45, 0.0, 1.0)
		draw_line(Vector2(0.0, -h), Vector2(16.0 * open, -h), ink, 2.4, true)
		draw_line(Vector2(16.0 * open, -h), Vector2(16.0 * open, -h + 9.0 * open), ink, 1.8, true)
		# the lantern body
		var c: Vector2 = Vector2(16.0 * open, -h + 9.0 * open + 22.0 * open)
		var warm: Color = Color.from_hsv(hue, 0.52, 1.0)
		var poly: PackedVector2Array = PackedVector2Array()
		for p in _body:
			poly.append(Vector2(p.x * open, p.y * open) + c)
		draw_polygon(poly, Proc.grad_fill(poly, Color(1.0, 0.95, 0.78), warm.darkened(0.08)))
		# paper ribs
		for i in range(3):
			var u: float = -0.5 + 0.5 * float(i)
			draw_line(c + Vector2(u * 15.0 * open, -20.0 * open), c + Vector2(u * 15.0 * open, 20.0 * open),
				Color(ink.r, ink.g, ink.b, 0.22), 1.3, true)
		draw_polyline(SeasonsEvents._arc_pts(c, 18.0 * open, 0.0, TAU, 28), Color(ink.r, ink.g, ink.b, 0.5), 1.6, true)
		if gv < 0.7:
			return
		# the flame + its pool of light
		var lit: float = clampf((gv - 0.7) / 0.3, 0.0, 1.0)
		var flick: float = 0.88 + 0.12 * sin(t * 6.0 + phase * 2.0)
		for i in range(3):
			draw_circle(c, (34.0 - 9.0 * float(i)) * lit * flick,
				Color(1.0, 0.86, 0.56, (0.07 + 0.06 * float(i)) * lit))
		draw_circle(c, 5.6 * lit * flick, Color(1.0, 0.98, 0.84, 0.95 * lit))
		# a warm circle of light on the ground beneath
		var pool: PackedVector2Array = PackedVector2Array()
		for i in range(22):
			var a: float = TAU * float(i) / 22.0
			pool.append(Vector2(cos(a) * 44.0 * lit, sin(a) * 13.0 * lit - 3.0))
		draw_colored_polygon(pool, Color(1.0, 0.86, 0.55, 0.10 * lit))
		# a ribbon tail
		var rib: PackedVector2Array = PackedVector2Array()
		for i in range(10):
			var u2: float = float(i) / 9.0
			rib.append(c + Vector2(sin(u2 * 3.4 + t * 1.6) * 5.0 * u2, 20.0 * open + u2 * 24.0 * lit))
		draw_polyline(rib, Color(warm.r, warm.g, warm.b, 0.8 * lit), 2.6, true)


# =============================================================================
#  _Migrant — one bird of the migration. A readable storybook silhouette: a smooth
#  body, a small head and beak, a fanned tail, and two wings that beat as child
#  transforms (the only per-frame cost).
# =============================================================================
class _Migrant extends ProcNode:
	var hue: float = 0.06
	var _wl: _Wing = null
	var _wr: _Wing = null
	var _beat: float = 3.4
	var _flourish: float = 0.0

	func _on_built() -> void:
		_beat = 2.6 + Proc.hashf(seedv, "beat") * 1.8
		var col: Color = Color.from_hsv(hue, 0.42, 0.86)
		_wl = _Wing.new()
		_wl.col = col
		_wl.flip = -1.0
		add_child(_wl)
		_wr = _Wing.new()
		_wr.col = col.darkened(0.12)
		_wr.flip = 1.0
		add_child(_wr)

	func flourish() -> void:
		_flourish = 1.0

	func _animate(delta: float) -> void:
		_flourish = maxf(0.0, _flourish - delta * 0.7)
		var a: float = sin(t * _beat + phase) * (0.75 + 0.5 * _flourish)
		if _wl != null:
			_wl.rotation = -a
		if _wr != null:
			_wr.rotation = a
		rotation = sin(t * 0.7 + phase) * 0.06

	func _draw() -> void:
		var col: Color = Color.from_hsv(hue, 0.44, 0.84)
		var pale: Color = Color.from_hsv(hue, 0.22, 0.97)
		# body
		var body: PackedVector2Array = PackedVector2Array()
		var e: PackedVector2Array = Proc.superellipse(19.0, 8.4, 2.5, 30)
		for p in e:
			body.append(p)
		draw_polygon(body, Proc.grad_fill(body, pale, col.darkened(0.2)))
		# tail fan
		var tail: PackedVector2Array = PackedVector2Array([
			Vector2(-17.0, -3.0), Vector2(-31.0, -8.0), Vector2(-34.0, 0.0),
			Vector2(-30.0, 7.0), Vector2(-17.0, 3.4)])
		draw_polygon(tail, Proc.grad_fill(tail, col, col.darkened(0.34)))
		# head + beak
		draw_circle(Vector2(17.0, -3.4), 6.4, pale)
		draw_circle(Vector2(17.6, -4.6), 1.5, Color(0.12, 0.1, 0.09))
		var beak: PackedVector2Array = PackedVector2Array([
			Vector2(22.0, -4.4), Vector2(30.0, -2.6), Vector2(22.0, -0.8)])
		draw_colored_polygon(beak, Color(0.96, 0.74, 0.3))
		if _flourish > 0.01:
			draw_circle(Vector2(6.0, -2.0), 26.0 * _flourish, Color(1.0, 0.95, 0.72, 0.16 * _flourish))


class _Wing extends Node2D:
	var col: Color = Color(0.6, 0.5, 0.4)
	var flip: float = 1.0

	func _draw() -> void:
		# one smooth, swept wing, feet-free (it hangs off the body origin)
		var ctrl: PackedVector2Array = PackedVector2Array([
			Vector2(2.0, 0.0), Vector2(-6.0, -7.0 * flip), Vector2(-22.0, -17.0 * flip),
			Vector2(-34.0, -8.0 * flip), Vector2(-18.0, 2.0 * flip)])
		var poly: PackedVector2Array = Proc.smooth_loop(ctrl, 8)
		draw_polygon(poly, Proc.grad_fill(poly, col.lightened(0.2), col.darkened(0.24)))
		draw_polyline(poly, Color(col.r * 0.5, col.g * 0.45, col.b * 0.4, 0.5), 1.3, true)


# =============================================================================
#  _MerchantPack — what the traveller carries: a rolled blanket, a small crate and
#  a swinging lantern, strapped together. It rides on his shoulders and sways a
#  half-beat behind his walk.
# =============================================================================
class _MerchantPack extends ProcNode:
	var span: float = 30.0
	var _lan: Node2D = null

	func _on_built() -> void:
		_lan = Node2D.new()
		add_child(_lan)

	func _animate(_delta: float) -> void:
		rotation = sin(t * 2.1 + phase) * 0.035
		if _lan != null:
			_lan.rotation = sin(t * 2.4 + phase + 0.6) * 0.22
			_lan.queue_redraw()

	func _draw() -> void:
		var s: float = clampf(span / 30.0, 0.6, 1.6)
		var cloth: Color = Color(0.72, 0.42, 0.30)
		var cloth2: Color = Color(0.46, 0.26, 0.19)
		# the rolled blanket
		var roll: PackedVector2Array = PackedVector2Array()
		for p in Proc.superellipse(22.0 * s, 9.0 * s, 4.0, 26):
			roll.append(p.rotated(-0.18))
		draw_polygon(roll, Proc.grad_fill(roll, cloth.lightened(0.18), cloth2))
		draw_polyline(SeasonsEvents._arc_pts(Vector2(-19.0 * s, 3.4 * s), 8.4 * s, 0.0, TAU, 20),
			cloth2.darkened(0.2), 1.6, true)
		# a little crate
		var crate: PackedVector2Array = PackedVector2Array()
		for p in Proc.superellipse(11.0 * s, 10.0 * s, 6.0, 20):
			crate.append(p + Vector2(10.0 * s, -13.0 * s))
		draw_polygon(crate, Proc.grad_fill(crate, Color(0.70, 0.52, 0.30), Color(0.42, 0.30, 0.17)))
		draw_line(Vector2(0.0, -13.0 * s), Vector2(20.0 * s, -13.0 * s), Color(0.3, 0.21, 0.12, 0.8), 1.8, true)
		# straps
		draw_line(Vector2(-14.0 * s, -4.0 * s), Vector2(6.0 * s, 10.0 * s), Color(0.34, 0.24, 0.16), 2.6, true)
		draw_line(Vector2(6.0 * s, -8.0 * s), Vector2(16.0 * s, 8.0 * s), Color(0.34, 0.24, 0.16), 2.2, true)
		# the hanging lantern's arm
		draw_line(Vector2(16.0 * s, -18.0 * s), Vector2(24.0 * s, -20.0 * s), Color(0.3, 0.22, 0.14), 1.8, true)
		if _lan != null:
			_lan.position = Vector2(24.0 * s, -20.0 * s)
		SeasonsEvents.draw_glyph(self, "lantern", Vector2(24.0 * s, -11.0 * s), 8.0 * s,
			Color(1.0, 0.86, 0.5), Color(0.25, 0.19, 0.13))


# =============================================================================
#  _OfferBundle — one of the three cloth bundles the merchant sets down. It shows
#  WHAT it is (a glyph above the knot) and WHAT IT COSTS (a little row of price
#  pips), wears a soft rune ring when you can afford it, and dims when you cannot.
#  Touching it IS the trade. No menu, no list, no numbers.
# =============================================================================
class _OfferBundle extends ProcNode:
	var glyph: String = "seed"
	var price_glyph: String = "coin"
	var price_pips: int = 2
	var affordable: bool = true
	var _shape: PackedVector2Array = PackedVector2Array()
	var _ring: Node2D = null

	func _on_built() -> void:
		var ctrl: PackedVector2Array = PackedVector2Array([
			Vector2(-26.0, 0.0), Vector2(-21.0, -22.0), Vector2(0.0, -30.0),
			Vector2(21.0, -22.0), Vector2(26.0, 0.0)])
		_shape = Proc.smooth_loop(ctrl, 9)

	func set_affordable(on: bool) -> void:
		affordable = on
		modulate = Color(1, 1, 1, 1.0) if on else Color(0.82, 0.82, 0.86, 0.82)
		queue_redraw()

	func _animate(_delta: float) -> void:
		var bob: float = sin(t * 1.5 + phase) * 1.4 * g()
		scale = Vector2(1.0, 1.0 + 0.012 * sin(t * 1.5 + phase))
		position.y += 0.0
		if affordable:
			queue_redraw()
		else:
			if absf(bob) < 0.02:
				queue_redraw()

	func _draw() -> void:
		var gv: float = g()
		if gv <= 0.02:
			return
		var cloth: Color = Color(0.86, 0.74, 0.52)
		var cloth_dk: Color = Color(0.56, 0.44, 0.30)
		var ink: Color = Color(0.24, 0.19, 0.14)
		draw_circle(Vector2(0.0, -2.0), 26.0 * gv, Color(0.1, 0.12, 0.1, 0.16))
		# the bundle
		var poly: PackedVector2Array = PackedVector2Array()
		for p in _shape:
			poly.append(Vector2(p.x * gv, p.y * gv))
		draw_polygon(poly, Proc.grad_fill(poly, cloth.lightened(0.14), cloth_dk))
		draw_polyline(poly, Color(ink.r, ink.g, ink.b, 0.45), 1.5, true)
		# folds
		for i in range(3):
			var u: float = -0.6 + 0.6 * float(i)
			var a: Vector2 = Vector2(u * 18.0 * gv, -2.0 * gv)
			var b: Vector2 = Vector2(u * 9.0 * gv, -24.0 * gv)
			draw_line(a, b, Color(cloth_dk.r, cloth_dk.g, cloth_dk.b, 0.5), 1.6, true)
		# the knot
		var knot: PackedVector2Array = Proc.superellipse(9.0 * gv, 6.0 * gv, 2.4, 18)
		var kp: PackedVector2Array = PackedVector2Array()
		for p in knot:
			kp.append(p + Vector2(0.0, -31.0 * gv))
		draw_polygon(kp, Proc.grad_fill(kp, cloth.lightened(0.22), cloth_dk))
		draw_line(Vector2(-11.0 * gv, -31.0 * gv), Vector2(-20.0 * gv, -40.0 * gv), cloth_dk, 2.2, true)
		draw_line(Vector2(11.0 * gv, -31.0 * gv), Vector2(20.0 * gv, -40.0 * gv), cloth_dk, 2.2, true)
		if gv < 0.5:
			return
		# WHAT it is: the glyph floats just above the knot, breathing
		var lift: float = -58.0 * gv + sin(t * 1.4 + phase) * 2.4
		var halo: float = 0.12 if affordable else 0.05
		draw_circle(Vector2(0.0, lift), 22.0 * gv, Color(1.0, 0.94, 0.72, halo))
		SeasonsEvents.draw_glyph(self, glyph, Vector2(0.0, lift), 15.0 * gv,
			Color(0.58, 0.80, 0.56), ink)
		# WHAT it costs: a small row of price pips under the bundle
		var pw: float = 13.0 * gv
		var x0: float = -pw * (float(price_pips) - 1.0) * 0.5
		for i in range(price_pips):
			SeasonsEvents.draw_glyph(self, price_glyph, Vector2(x0 + pw * float(i), 14.0 * gv),
				5.4 * gv, Color(0.95, 0.86, 0.6), ink)
		if affordable:
			# a quiet rune ring: "this one is within reach"
			var r: float = 34.0 * gv + sin(t * 1.1 + phase) * 1.6
			var ring: PackedVector2Array = PackedVector2Array()
			for i in range(26):
				var a2: float = TAU * float(i) / 26.0
				ring.append(Vector2(cos(a2) * r * 1.25, sin(a2) * r * 0.42 - 2.0))
			var closed: PackedVector2Array = PackedVector2Array(ring)
			closed.append(ring[0])
			draw_polyline(closed, Color(1.0, 0.92, 0.66, 0.38), 2.0, true)
