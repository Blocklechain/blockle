extends Node
# GameManager — owns the authoritative game state, runs the production tick, and
# orchestrates boot / offline / autosave. Every other manager reads and mutates
# Game.state so saving is just serialising one dictionary.

const SAVE_VERSION := 1

signal resources_changed
signal state_dirty          # something structural changed (UI should rebuild)
signal toast(text: String)
signal recruited(uid: String)
signal realm_changed
signal offline_ready(summary: Dictionary)

var state: Dictionary = {}
var booted := false
var _autosave_accum := 0.0
var _ach_accum := 0.0

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	call_deferred("boot")

func boot() -> void:
	state = Save.load_or_new()
	var summary := Offline.apply_offline()
	booted = true
	emit_signal("state_dirty")
	emit_signal("resources_changed")
	if summary.get("elapsed", 0.0) > 5.0:
		emit_signal("offline_ready", summary)

func _process(delta: float) -> void:
	if not booted:
		return
	Production.tick(delta)
	state["stats"]["play_time"] = state["stats"].get("play_time", 0.0) + delta
	_autosave_accum += delta
	if _autosave_accum >= 15.0:
		_autosave_accum = 0.0
		save_now()
	_ach_accum += delta
	if _ach_accum >= 1.0:
		_ach_accum = 0.0
		Achievements.check()

func save_now() -> void:
	if booted:
		state["last_saved"] = Time.get_unix_time_from_system()
		Save.save(state)

func _notification(what: int) -> void:
	# Persist when the app is backgrounded or closing (mobile lifecycle).
	if what == NOTIFICATION_APPLICATION_PAUSED or what == NOTIFICATION_WM_CLOSE_REQUEST or what == NOTIFICATION_APPLICATION_FOCUS_OUT:
		save_now()

# ---- resource helpers -------------------------------------------------------

func res(id: String) -> float:
	return state["resources"].get(id, 0.0)

func add_resource(id: String, amt: float) -> void:
	state["resources"][id] = max(0.0, res(id) + amt)
	if id == "essence" and amt > 0.0:
		state["stats"]["total_essence"] = state["stats"].get("total_essence", 0.0) + amt
	emit_signal("resources_changed")

func can_afford(cost: Dictionary) -> bool:
	for k in cost.keys():
		if res(k) < cost[k]:
			return false
	return true

func spend(cost: Dictionary) -> bool:
	if not can_afford(cost):
		return false
	for k in cost.keys():
		state["resources"][k] = res(k) - cost[k]
	emit_signal("resources_changed")
	return true

func toast_msg(t: String) -> void:
	emit_signal("toast", t)

# ---- default new game -------------------------------------------------------

func new_state() -> Dictionary:
	var s := {
		"version": SAVE_VERSION,
		"realm": "verdant",
		"unlocked_realms": ["verdant"],
		"resources": {},
		"buildings": {},
		"blocklings": {},
		"research": {},
		"ascension": { "ancient_knowledge": 0, "count": 0 },
		"achievements": {},
		"discovered": {},
		"stats": { "total_essence": 0.0, "taps": 0, "play_time": 0.0,
				   "buildings_built": 0, "research_done": 0, "ascensions": 0 },
		"settings": { "music": 0.6, "sfx": 0.8 },
		"tutorial_step": 0,
		"uid_counter": 0,
		# Per-player procedural seed: shapes this player's island, palette, layout
		# and Blockling variants so every world forms uniquely (see WorldGen).
		"world_seed": WorldGen.fresh_seed(),
		"last_saved": Time.get_unix_time_from_system(),
	}
	for r in GameData.resources:
		s["resources"][r["id"]] = 0.0
	# the Heart Tree is already standing when the player arrives
	for b in GameData.buildings:
		if b.get("starts_owned", false):
			s["buildings"][b["id"]] = { "level": 1, "assigned": [] }
	# ...and one Blockling waiting to meet them
	var uid := "bk_%d" % s["uid_counter"]
	s["uid_counter"] += 1
	s["blocklings"][uid] = { "id": "pip", "level": 1, "assigned_to": "heart_tree" }
	s["discovered"]["pip"] = true
	if s["buildings"].has("heart_tree"):
		s["buildings"]["heart_tree"]["assigned"].append(uid)
	return s
