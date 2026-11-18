extends Node
# Loads the data-driven content (res://data/*.json) once at boot and exposes it
# as ordered arrays + id->dict lookups. NOTHING in the game hardcodes balance;
# it all comes from here, so design/economy can be tuned without touching code.

var resources: Array = []          # ordered
var resources_by_id: Dictionary = {}
var buildings: Array = []
var buildings_by_id: Dictionary = {}
var realms: Array = []
var realms_by_id: Dictionary = {}
var research_branches: Array = []
var research_nodes: Array = []
var research_by_id: Dictionary = {}
var rarities: Array = []
var rarities_by_id: Dictionary = {}
var blocklings: Array = []
var blocklings_by_id: Dictionary = {}
var achievements: Array = []
var decoration_types: Array = []    # hand-painted island set-dressing (with material)
var decoration_variants := 8

func _ready() -> void:
	_load_resources()
	_load_buildings()
	_load_realms()
	_load_research()
	_load_blocklings()
	_load_achievements()
	_load_decorations()

func _load_decorations() -> void:
	var d := _read_json("res://data/decorations.json")
	decoration_types = d.get("types", [])
	decoration_variants = int(d.get("variants", 8))

func _read_json(path: String) -> Dictionary:
	if not FileAccess.file_exists(path):
		push_error("GameData: missing data file " + path)
		return {}
	var text := FileAccess.get_file_as_string(path)
	var parsed = JSON.parse_string(text)
	if typeof(parsed) != TYPE_DICTIONARY:
		push_error("GameData: bad JSON in " + path)
		return {}
	return parsed

func _index(arr: Array, key := "id") -> Dictionary:
	var d := {}
	for item in arr:
		d[item[key]] = item
	return d

func _load_resources() -> void:
	resources = _read_json("res://data/resources.json").get("resources", [])
	resources_by_id = _index(resources)

func _load_buildings() -> void:
	buildings = _read_json("res://data/buildings.json").get("buildings", [])
	buildings_by_id = _index(buildings)

func _load_realms() -> void:
	realms = _read_json("res://data/realms.json").get("realms", [])
	realms_by_id = _index(realms)

func _load_research() -> void:
	var d := _read_json("res://data/research.json")
	research_branches = d.get("branches", [])
	research_nodes = d.get("nodes", [])
	research_by_id = _index(research_nodes)

func _load_blocklings() -> void:
	var d := _read_json("res://data/blocklings.json")
	rarities = d.get("rarities", [])
	rarities_by_id = _index(rarities)
	blocklings = d.get("blocklings", [])
	blocklings_by_id = _index(blocklings)

func _load_achievements() -> void:
	achievements = _read_json("res://data/achievements.json").get("achievements", [])

func resource_ids() -> Array:
	var ids := []
	for r in resources:
		ids.append(r["id"])
	return ids
