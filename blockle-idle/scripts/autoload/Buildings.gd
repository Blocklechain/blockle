extends Node
# BuildingManager — construction, upgrades, and Blockling work assignment.

func is_owned(id: String) -> bool:
	return Game.state.get("buildings", {}).has(id) and level(id) > 0

func level(id: String) -> int:
	return int(Game.state.get("buildings", {}).get(id, {}).get("level", 0))

func max_level(id: String) -> int:
	return int(GameData.buildings_by_id.get(id, {}).get("max_level", 999))

func at_max(id: String) -> bool:
	return level(id) >= max_level(id)

func add_level(id: String) -> void:
	var fresh := not is_owned(id)
	if at_max(id):
		return
	if fresh:
		Game.state["buildings"][id] = { "level": 1, "assigned": [] }
		Game.toast_msg("Built %s!" % GameData.buildings_by_id[id]["name"])
		Game.emit_signal("state_dirty")
	else:
		Game.state["buildings"][id]["level"] = level(id) + 1
	Game.emit_signal("resources_changed")

func owned_count() -> int:
	var n := 0
	for id in Game.state.get("buildings", {}).keys():
		if level(id) > 0:
			n += 1
	return n

# ---- worker assignment ------------------------------------------------------

func slots(id: String) -> int:
	return int(GameData.buildings_by_id.get(id, {}).get("slots", 0))

func assigned_to(id: String) -> Array:
	var raw: Array = Game.state.get("buildings", {}).get(id, {}).get("assigned", [])
	# keep only uids that still exist
	var valid := []
	for uid in raw:
		if Game.state.get("blocklings", {}).has(uid):
			valid.append(uid)
	return valid

func free_slots(id: String) -> int:
	return max(0, slots(id) - assigned_to(id).size())

func unassign(uid: String) -> void:
	var bk: Dictionary = Game.state.get("blocklings", {}).get(uid, {})
	var prev: String = bk.get("assigned_to", "")
	if prev != "" and Game.state["buildings"].has(prev):
		var arr: Array = Game.state["buildings"][prev]["assigned"]
		arr.erase(uid)
	if not bk.is_empty():
		bk["assigned_to"] = ""
	Game.emit_signal("state_dirty")

func assign(uid: String, building_id: String) -> bool:
	if not Game.state.get("blocklings", {}).has(uid):
		return false
	if not is_owned(building_id) or slots(building_id) == 0:
		return false
	if free_slots(building_id) <= 0:
		return false
	unassign(uid)
	Game.state["blocklings"][uid]["assigned_to"] = building_id
	Game.state["buildings"][building_id]["assigned"].append(uid)
	Game.emit_signal("state_dirty")
	Game.emit_signal("resources_changed")
	return true
