extends Node
# RealmManager — the 7 realms. Each is a production-multiplier tier the player
# unlocks with Stardust/Relics and can travel between.

func current() -> String:
	return Game.state.get("realm", "verdant")

func current_def() -> Dictionary:
	return GameData.realms_by_id.get(current(), {})

func is_unlocked(id: String) -> bool:
	return Game.state.get("unlocked_realms", []).has(id)

func unlocked_list() -> Array:
	return Game.state.get("unlocked_realms", [])

func can_unlock(id: String) -> bool:
	if is_unlocked(id):
		return false
	var def: Dictionary = GameData.realms_by_id.get(id, {})
	# must unlock in order
	var order := int(def.get("order", 99))
	for r in GameData.realms:
		if int(r["order"]) < order and not is_unlocked(r["id"]):
			return false
	return Game.can_afford(def.get("unlock_cost", {}))

func unlock(id: String) -> bool:
	if not can_unlock(id):
		return false
	var def: Dictionary = GameData.realms_by_id.get(id, {})
	if not Game.spend(def.get("unlock_cost", {})):
		return false
	Game.state["unlocked_realms"].append(id)
	Game.toast_msg("Unlocked %s!" % def["name"])
	Game.emit_signal("state_dirty")
	return true

func switch_to(id: String) -> bool:
	if not is_unlocked(id):
		return false
	Game.state["realm"] = id
	Game.emit_signal("realm_changed")
	Game.emit_signal("state_dirty")
	Game.emit_signal("resources_changed")
	return true

func next_locked() -> Dictionary:
	for r in GameData.realms:
		if not is_unlocked(r["id"]):
			return r
	return {}
