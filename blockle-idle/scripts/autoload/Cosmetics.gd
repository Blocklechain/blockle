extends Node
# CosmeticsManager — owns the catalog of cosmetic-only items and the player's
# owned/equipped state. Loads data/cosmetics.json itself (same _read_json pattern
# as GameData) because cosmetics are a monetization concern separate from the
# balance-driving content GameData holds.
#
# purely visual; the art/UI layer reads equipped() to pick a skin. NOTHING here
# touches production, costs, rates or any economy value — reskins only. There are
# no loot boxes: every item is a known, named, directly-purchased cosmetic.

var items: Array = []            # ordered catalog
var items_by_id: Dictionary = {}

func _ready() -> void:
	items = _read_json("res://data/cosmetics.json").get("items", [])
	items_by_id = _index(items)

func _read_json(path: String) -> Dictionary:
	if not FileAccess.file_exists(path):
		push_error("Cosmetics: missing data file " + path)
		return {}
	var text := FileAccess.get_file_as_string(path)
	var parsed = JSON.parse_string(text)
	if typeof(parsed) != TYPE_DICTIONARY:
		push_error("Cosmetics: bad JSON in " + path)
		return {}
	return parsed

func _index(arr: Array) -> Dictionary:
	var d := {}
	for item in arr:
		d[item["id"]] = item
	return d

# ---- state ------------------------------------------------------------------

# Ensures Game.state.cosmetics exists so older saves upgrade cleanly.
func ensure_state() -> void:
	if not Game.state.has("cosmetics"):
		Game.state["cosmetics"] = {}
	var c: Dictionary = Game.state["cosmetics"]
	if not c.has("owned"):
		c["owned"] = {}
	if not c.has("equipped"):
		c["equipped"] = {}
	if not c.has("nameplate"):
		c["nameplate"] = ""

func _store() -> Dictionary:
	ensure_state()
	return Game.state["cosmetics"]

# ---- ownership --------------------------------------------------------------

func is_owned(id: String) -> bool:
	return _store()["owned"].get(id, false) == true

# Marks an item owned. Bundles (items with a "grants" array) also grant every
# child id so the player immediately owns everything the bundle promised.
func grant(id: String) -> void:
	if not items_by_id.has(id):
		push_warning("Cosmetics.grant: unknown item " + id)
		return
	var store := _store()
	store["owned"][id] = true
	var def: Dictionary = items_by_id[id]
	for child in def.get("grants", []):
		if items_by_id.has(child):
			store["owned"][child] = true
	Game.emit_signal("state_dirty")

# ---- equipping --------------------------------------------------------------

# Equips an owned item into a slot, but only if the item actually reskins that
# slot (prevents, e.g., a Heart Tree skin landing on a building slot).
func equip(slot: String, id: String) -> bool:
	if not is_owned(id):
		return false
	var def: Dictionary = items_by_id.get(id, {})
	if def.get("slot", "") != slot:
		return false
	_store()["equipped"][slot] = id
	Game.emit_signal("state_dirty")
	return true

# Removes whatever is equipped in a slot (reverts to the default look).
func unequip(slot: String) -> void:
	var store := _store()
	if store["equipped"].has(slot):
		store["equipped"].erase(slot)
		Game.emit_signal("state_dirty")

func equipped(slot: String) -> String:
	return _store()["equipped"].get(slot, "")

# Convenience for the art layer: the equipped item id for a slot, or "" to mean
# "use the built-in default art for default_slot".
func equipped_for(default_slot: String) -> String:
	return equipped(default_slot)

func set_nameplate(id: String) -> void:
	if not is_owned(id):
		return
	_store()["nameplate"] = id
	Game.emit_signal("state_dirty")

func nameplate() -> String:
	return _store()["nameplate"]

# ---- catalog queries --------------------------------------------------------

func all_items() -> Array:
	return items

func item(id: String) -> Dictionary:
	return items_by_id.get(id, {})

func items_by_type(t: String) -> Array:
	var out := []
	for it in items:
		if it.get("type", "") == t:
			out.append(it)
	return out

# Product-id -> item id, used by the IAP bridge to map a store purchase back to
# the cosmetic it grants.
func item_id_for_product(product_id: String) -> String:
	for it in items:
		if it.get("product_id", "") == product_id:
			return it["id"]
	return ""
