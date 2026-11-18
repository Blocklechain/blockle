extends Node
# BlocklingManager — recruiting (discovery), levelling, and the production bonus
# each Blockling contributes when assigned to a building.

const BASE_CAP := 3

func count() -> int:
	return Game.state.get("blocklings", {}).size()

func cap() -> int:
	return BASE_CAP + Buildings.level("blockling_homes") * 2

func discovered_count() -> int:
	return Game.state.get("discovered", {}).size()

func recruit_cost() -> Dictionary:
	var c := count()
	return { "essence": ceil(50.0 * pow(1.18, c)) }

func can_recruit() -> bool:
	return count() < cap() and Game.can_afford(recruit_cost())

# How strongly discovery is biased toward rarer Blocklings (research + lodge).
func discovery_power() -> float:
	var lodge := 0.0
	if Buildings.is_owned("explorers_lodge"):
		lodge = Buildings.level("explorers_lodge") * 0.04
	return Research.discovery_bonus() + lodge

func _roll_rarity() -> String:
	var total := 0.0
	for r in GameData.rarities:
		total += float(r["weight"])
	var pick := randf() * total
	for r in GameData.rarities:
		pick -= float(r["weight"])
		if pick <= 0.0:
			return r["id"]
	return GameData.rarities[0]["id"]

func _rarity_rank(id: String) -> int:
	for i in GameData.rarities.size():
		if GameData.rarities[i]["id"] == id:
			return i
	return 0

func recruit() -> String:
	if not can_recruit():
		return ""
	Game.spend(recruit_cost())
	# Discovery lets us roll several times and keep the rarest result.
	var rolls := 1 + int(floor(discovery_power()))
	if randf() < (discovery_power() - floor(discovery_power())):
		rolls += 1
	var best := _roll_rarity()
	for i in range(rolls - 1):
		var r := _roll_rarity()
		if _rarity_rank(r) > _rarity_rank(best):
			best = r
	# pick a random Blockling species of that rarity
	var pool := []
	for b in GameData.blocklings:
		if b["rarity"] == best:
			pool.append(b["id"])
	if pool.is_empty():
		pool = [GameData.blocklings[0]["id"]]
	var species: String = pool[randi() % pool.size()]
	var uid := "bk_%d" % int(Game.state["uid_counter"])
	Game.state["uid_counter"] = int(Game.state["uid_counter"]) + 1
	Game.state["blocklings"][uid] = { "id": species, "level": 1, "assigned_to": "" }
	Game.state["discovered"][species] = true
	Game.emit_signal("recruited", uid)
	Game.emit_signal("state_dirty")
	Game.toast_msg("Recruited %s (%s)!" % [GameData.blocklings_by_id[species]["name"], GameData.rarities_by_id[best]["name"]])
	return uid

func species_of(uid: String) -> Dictionary:
	var id: String = Game.state.get("blocklings", {}).get(uid, {}).get("id", "")
	return GameData.blocklings_by_id.get(id, {})

func level_of(uid: String) -> int:
	return int(Game.state.get("blocklings", {}).get(uid, {}).get("level", 1))

# Production bonus (a fraction added to a building's blockling_factor).
func bonus_for(uid: String) -> float:
	var sp := species_of(uid)
	if sp.is_empty():
		return 0.0
	var rar: Dictionary = GameData.rarities_by_id.get(sp["rarity"], {})
	var base: float = rar.get("base_bonus", 0.1)
	var lvl := level_of(uid)
	return base * (1.0 + 0.5 * (lvl - 1)) * (1.0 + Research.blockling_bonus_mult())

func level_cost(uid: String) -> Dictionary:
	var lvl := level_of(uid)
	var mult: float = 1.0 + Research.level_cost_mult()  # mult is <= 1.0 (discount)
	return { "essence": ceil(120.0 * pow(1.32, lvl) * mult),
			 "crystal": ceil(5.0 * pow(1.25, lvl) * mult) }

func level_up(uid: String) -> bool:
	if not Game.state.get("blocklings", {}).has(uid):
		return false
	if not Game.spend(level_cost(uid)):
		return false
	Game.state["blocklings"][uid]["level"] = level_of(uid) + 1
	Game.emit_signal("resources_changed")
	return true
