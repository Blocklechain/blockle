extends Node
# ProductionManager — the beating heart of the idle loop. Computes per-building
# and total production rates from buildings + assigned Blocklings + research +
# ascension + realm + achievements, and adds resources each tick.

# Every 25 levels a building doubles — the classic idle "milestone" curve that
# keeps upgrading exciting without runaway exponential cost.
func milestone_mult(level: int) -> float:
	return pow(2.0, floor(level / 25.0))

func global_mult() -> float:
	return 1.0 + Research.sum_global() + Ascension.global_bonus() + Achievements.global_bonus()

func resource_mult(res_id: String) -> float:
	return 1.0 + Research.resource_prod(res_id)

func building_mult(id: String) -> float:
	return 1.0 + Research.building_prod(id)

func realm_mult() -> float:
	var r: Dictionary = GameData.realms_by_id.get(Game.state.get("realm", "verdant"), {})
	return float(r.get("prod_mult", 1.0))

# Combined effectiveness of the Blocklings assigned to a building (>= 1.0).
func blockling_factor(building_id: String) -> float:
	var assigned: Array = Buildings.assigned_to(building_id)
	var sum := 0.0
	for uid in assigned:
		sum += Blocklings.bonus_for(uid)
	return 1.0 + sum

# Production/second of a single building, in its output resource.
func rate_for_building(id: String) -> float:
	if not Buildings.is_owned(id):
		return 0.0
	var def: Dictionary = GameData.buildings_by_id.get(id, {})
	var res: String = def.get("produces", "")
	if res == "":
		return 0.0
	var level := Buildings.level(id)
	var base: float = def.get("base_prod", 0.0)
	return base * level * milestone_mult(level) \
		* building_mult(id) * blockling_factor(id) \
		* resource_mult(res) * global_mult() * realm_mult()

# Map of resource_id -> total production/second (for the UI and offline calc).
func total_rates() -> Dictionary:
	var out := {}
	for b in GameData.buildings:
		var id: String = b["id"]
		var res: String = b.get("produces", "")
		if res == "" or not Buildings.is_owned(id):
			continue
		out[res] = out.get(res, 0.0) + rate_for_building(id)
	return out

func tick(delta: float) -> void:
	var rates := total_rates()
	for res_id in rates.keys():
		Game.add_resource(res_id, rates[res_id] * delta)

# Value of one manual tap on the Heart Tree (gives a burst of Essence).
func tap_value() -> float:
	var base: float = max(1.0, rate_for_building("heart_tree") * 2.0 + 1.0)
	return base * Research.tap_mult()
