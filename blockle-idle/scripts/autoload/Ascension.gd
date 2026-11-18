extends Node
# AscensionManager — "World Ascension" (prestige). Reset the civilization for
# Ancient Knowledge, a permanent +2% global production each. What resets and what
# stays is spelled out in ascension_summary() so the player always knows.

const PER_KNOWLEDGE := 0.02
const THRESHOLD := 1_000_000.0   # total Essence this run per unit of knowledge (pre-sqrt)

func ancient_knowledge() -> int:
	return int(Game.state.get("ascension", {}).get("ancient_knowledge", 0))

func count() -> int:
	return int(Game.state.get("ascension", {}).get("count", 0))

func global_bonus() -> float:
	return ancient_knowledge() * PER_KNOWLEDGE

# Ancient Knowledge you'd gain by ascending right now.
func knowledge_preview() -> int:
	var total: float = Game.state.get("stats", {}).get("total_essence", 0.0)
	var raw := sqrt(total / THRESHOLD) * (1.0 + Research.ascension_mult())
	return int(floor(raw))

func can_ascend() -> bool:
	return knowledge_preview() >= 1

func ascension_summary() -> Dictionary:
	return {
		"gain": knowledge_preview(),
		"resets": ["All resources", "All buildings (except the Heart Tree)",
				   "All research", "Recruited Blocklings", "Back to The Verdant Beginning"],
		"keeps": ["Ancient Knowledge (+%d%% production each)" % int(PER_KNOWLEDGE * 100),
				  "Discovered Blockling collection", "Achievements", "Unlocked realms"],
	}

func ascend() -> bool:
	if not can_ascend():
		return false
	var gain := knowledge_preview()
	var asc: Dictionary = Game.state["ascension"]
	asc["ancient_knowledge"] = ancient_knowledge() + gain
	asc["count"] = count() + 1
	Game.state["stats"]["ascensions"] = int(Game.state["stats"].get("ascensions", 0)) + 1

	# ---- the reset (keeps: discovered, achievements, ancient_knowledge, realms)
	Game.state["resources"] = {}
	for r in GameData.resources:
		Game.state["resources"][r["id"]] = 0.0
	Game.state["buildings"] = {}
	Game.state["research"] = {}
	Game.state["blocklings"] = {}
	Game.state["realm"] = "verdant"
	Game.state["stats"]["total_essence"] = 0.0

	# re-seed the starting Heart Tree + first Blockling
	for b in GameData.buildings:
		if b.get("starts_owned", false):
			Game.state["buildings"][b["id"]] = { "level": 1, "assigned": [] }
	var uid := "bk_%d" % int(Game.state["uid_counter"])
	Game.state["uid_counter"] = int(Game.state["uid_counter"]) + 1
	Game.state["blocklings"][uid] = { "id": "pip", "level": 1, "assigned_to": "heart_tree" }
	Game.state["discovered"]["pip"] = true
	if Game.state["buildings"].has("heart_tree"):
		Game.state["buildings"]["heart_tree"]["assigned"].append(uid)

	Game.toast_msg("Ascended! +%d Ancient Knowledge." % gain)
	Game.emit_signal("state_dirty")
	Game.emit_signal("resources_changed")
	Game.save_now()
	return true
