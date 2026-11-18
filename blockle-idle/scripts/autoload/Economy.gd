extends Node
# EconomyManager — costs and affordability. All scaling comes from data
# (base_cost * cost_growth^level) and is reduced by Architecture research.

func cost_for_building(id: String) -> Dictionary:
	var def: Dictionary = GameData.buildings_by_id.get(id, {})
	if def.is_empty():
		return {}
	var level := Buildings.level(id)
	var growth: float = def.get("cost_growth", 1.17)
	var mult: float = pow(growth, level) * Research.build_cost_mult()
	var out := {}
	for k in def["base_cost"].keys():
		out[k] = ceil(float(def["base_cost"][k]) * mult)
	return out

func can_afford_building(id: String) -> bool:
	return Game.can_afford(cost_for_building(id))

func buy_building(id: String) -> bool:
	var cost := cost_for_building(id)
	if not Game.spend(cost):
		return false
	Buildings.add_level(id)
	return true
