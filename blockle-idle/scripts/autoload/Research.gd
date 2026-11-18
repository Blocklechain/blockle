extends Node
# ResearchManager — a 7-branch tech tree. Each unlocked node contributes typed
# effects that the economy/production managers aggregate. Research is about
# meaningful choices: you unlock along branches, gated by prerequisites + cost.

func done() -> Dictionary:
	return Game.state.get("research", {})

func is_done(id: String) -> bool:
	return done().has(id)

func done_count() -> int:
	return done().size()

func requirements_met(id: String) -> bool:
	var node: Dictionary = GameData.research_by_id.get(id, {})
	for req in node.get("requires", []):
		if not is_done(req):
			return false
	return true

func cost_of(id: String) -> Dictionary:
	var node: Dictionary = GameData.research_by_id.get(id, {})
	var discount: float = clamp(research_speed(), 0.0, 0.6)
	var out := {}
	for k in node.get("cost", {}).keys():
		out[k] = ceil(float(node["cost"][k]) * (1.0 - discount))
	return out

func can_unlock(id: String) -> bool:
	if is_done(id) or not GameData.research_by_id.has(id):
		return false
	return requirements_met(id) and Game.can_afford(cost_of(id))

func unlock(id: String) -> bool:
	if not can_unlock(id):
		return false
	if not Game.spend(cost_of(id)):
		return false
	Game.state["research"][id] = true
	Game.state["stats"]["research_done"] = int(Game.state["stats"].get("research_done", 0)) + 1
	Game.toast_msg("Researched: %s" % GameData.research_by_id[id]["name"])
	Game.emit_signal("state_dirty")
	return true

# ---- typed effect aggregation ----------------------------------------------

func _sum(type: String) -> float:
	var total := 0.0
	for id in done().keys():
		var e: Dictionary = GameData.research_by_id.get(id, {}).get("effect", {})
		if e.get("type", "") == type:
			total += float(e.get("value", 0.0))
	return total

func _sum_keyed(type: String, key_field: String, key_value: String) -> float:
	var total := 0.0
	for id in done().keys():
		var e: Dictionary = GameData.research_by_id.get(id, {}).get("effect", {})
		if e.get("type", "") == type and e.get(key_field, "") == key_value:
			total += float(e.get("value", 0.0))
	return total

func sum_global() -> float: return _sum("global_prod")
func resource_prod(res_id: String) -> float: return _sum_keyed("resource_prod", "resource", res_id)
func building_prod(bld_id: String) -> float: return _sum_keyed("building_prod", "building", bld_id)
func tap_mult() -> float: return 1.0 + _sum("tap_mult")
func blockling_bonus_mult() -> float: return _sum("blockling_bonus")
func discovery_bonus() -> float: return _sum("discovery")
func offline_mult() -> float: return _sum("offline_mult")
func offline_cap_hours_bonus() -> float: return _sum("offline_cap_hours")
func ascension_mult() -> float: return _sum("ascension_mult")
func research_speed() -> float: return _sum("research_speed")
func level_cost_mult() -> float: return _sum("level_cost")      # negative = discount
func build_cost_mult() -> float: return max(0.2, 1.0 + _sum("build_cost"))  # negative = discount
