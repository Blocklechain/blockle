extends Node
# AchievementManager — passively watches a handful of lifetime metrics and, when
# one crosses a data-defined threshold, marks the achievement earned and pays its
# reward. Rewards are either a flat resource grant or a permanent "global_prod"
# bonus; the latter is summed live by global_bonus() (Production.global_mult reads
# it), so we never bake multipliers into state and migrations stay trivial.

func _stats() -> Dictionary:
	var s = Game.state.get("stats", {})
	return s if typeof(s) == TYPE_DICTIONARY else {}

# Current value of the lifetime metric an achievement tracks.
func _metric(a: Dictionary) -> float:
	match a.get("metric", ""):
		"taps":
			return float(_stats().get("taps", 0))
		"buildings_built":
			return float(Buildings.owned_count())
		"blocklings_owned":
			return float(Blocklings.count())
		"discovered":
			return float(Blocklings.discovered_count())
		"essence_held":
			return Game.res("essence")
		"total_essence":
			return float(_stats().get("total_essence", 0.0))
		"research_done":
			return float(_stats().get("research_done", 0))
		"realms":
			return float(Game.state.get("unlocked_realms", []).size())
		"ascensions":
			return float(_stats().get("ascensions", 0))
		_:
			return 0.0

func check() -> void:
	if not Game.booted:
		return
	var earned: Dictionary = Game.state.get("achievements", {})
	var newly := false
	for a in GameData.achievements:
		var id: String = a.get("id", "")
		if id == "" or earned.has(id):
			continue
		if _metric(a) >= float(a.get("threshold", 0.0)):
			earned[id] = true
			_grant(a.get("reward", {}))
			Game.toast_msg("Achievement: " + str(a.get("name", id)))
			newly = true
	if newly:
		Game.emit_signal("state_dirty")

# Resource rewards pay out immediately; global_prod is a standing bonus that
# global_bonus() recomputes from the earned set, so nothing to apply here.
func _grant(reward: Dictionary) -> void:
	for key in reward.keys():
		if key == "global_prod":
			continue
		Game.add_resource(key, float(reward[key]))

# Summed permanent production bonus from every earned achievement. Production's
# global_mult() calls this each tick, so it is the single source of truth.
func global_bonus() -> float:
	var total := 0.0
	var earned: Dictionary = Game.state.get("achievements", {})
	for id in earned.keys():
		var a := _find(id)
		total += float(a.get("reward", {}).get("global_prod", 0.0))
	return total

# GameData indexes most content but not achievements; linear scan is fine for ~15.
func _find(id: String) -> Dictionary:
	for a in GameData.achievements:
		if a.get("id", "") == id:
			return a
	return {}

func earned_count() -> int:
	var earned: Dictionary = Game.state.get("achievements", {})
	return earned.size()
