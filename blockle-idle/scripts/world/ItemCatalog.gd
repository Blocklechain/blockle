class_name ItemCatalog
extends RefCounted
# ItemCatalog — the glue between an INVENTORY ITEM and the procedural art that
# represents it. The whole diegetic interaction layer (Interact.gd) never talks to
# the proc modules directly: it hands an inventory ENTRY to this catalog and gets
# back a living ProcNode, plus the handful of facts placement needs (what ground it
# can stand on, what it produces, what to call it). Keeping that routing in one
# place means the tray, the drag-ghost and a placed thing are guaranteed to be the
# SAME generated creature at three different moments of its life.
#
# An inventory ENTRY (one value in Game.state["inventory"]) looks like:
#   {
#     "count":  int,        # how many you hold (stackable fresh seeds stack)
#     "kind":   String,     # tree|plant|fungus|crystal|decor|creature|building|water
#     "species":String,     # species/type id: "oak","poppy","mushroom","lantern","pip"…
#     "building_id":String, # for kind=="building"
#     "label":  String,     # display name shown on the chip / inspect whisper
#     "growth": float,      # resume-from growth (−1 = brand-new seed, grows from sprout)
#     "minted": bool,       # a pressed-flower keepsake: placed frozen, resumes on replace
#     "realm":  String,     # realm the building belongs to (optional)
#   }
#
# Everything is a pure function of (world_seed, item instance key) so the chip in the
# tray, the ghost under the finger and the thing finally rooted in the ground all
# regenerate as one identical individual (CONVENTIONS rule 3).

const SEED_GROWTH := 0.08          # the sprout stage a freshly-planted seed unfurls to
const KINDS := ["tree", "plant", "fungus", "crystal", "decor", "creature", "building", "water"]

# Which ground a kind may stand on. Water features + water flora want water; the rest
# want land; a wishing-well style decor is happy anywhere its base can rest.
const WATER_SPECIES := {"lilypad": true, "pond": true, "reed": true, "well": true}

# Species pools used when a seed is "wild" (species == "" or "random"), so a generic
# "Wildseed" in the tray becomes a different plant every time you plant one — but
# deterministically, keyed by the instance.
const WILD_TREES := ["oak", "willow", "birch", "pine", "maple", "blossom"]
const WILD_PLANTS := ["flower", "poppy", "tulip", "bluebell", "sunflower", "daisy", "clover", "fern"]
const WILD_FUNGI := ["mushroom", "toadstool", "bluecap"]
const WILD_CRYSTALS := ["crystal", "crystalpink", "gem", "geode"]
const WILD_DECOR := ["lantern", "rock", "signpost", "birdhouse", "statue", "pebbles"]

# Resource a producing thing sheds (diegetically) while it lives. Empty = pure decor.
const PRODUCES := {
	"tree": "timber", "building": "", "crystal": "crystal", "fungus": "essence",
	"plant": "essence", "decor": "", "creature": "", "water": "essence",
}

# -----------------------------------------------------------------------------
# Node construction
# -----------------------------------------------------------------------------

# Build the living ProcNode for an inventory entry. `context` (built by WorldSpace)
# carries local_palette / light_dir / elevation / neighbours so the thing adapts to
# where it is planted (IDLE-DESIGN §2.3a). Pass stage<0 to leave growth at the node's
# own default (used for already-grown keepsakes / thumbnails at full form).
static func make_node(world_seed: int, inst_key: String, entry: Dictionary, context: Dictionary = {}, stage: float = -1.0) -> ProcNode:
	var kind := String(entry.get("kind", "plant"))
	var species := _resolve_species(world_seed, inst_key, kind, String(entry.get("species", "")))
	var ctx := context.duplicate(true)
	var node: ProcNode = null
	match kind:
		"tree":
			node = ProcTrees.make(world_seed, inst_key, species)
			_apply_ctx(node, ctx)
		"plant":
			node = ProcPlants.make(world_seed, inst_key, species, ctx)
		"fungus":
			node = ProcFungiCrystals.make_fungus(world_seed, inst_key, species, ctx)
		"crystal":
			node = ProcFungiCrystals.make_crystal(world_seed, inst_key, species, ctx)
		"decor":
			node = ProcDecor.make(world_seed, inst_key, species, ctx)
		"creature":
			node = ProcCreatures.make(world_seed, inst_key, species, ctx)
		"building":
			var bid := String(entry.get("building_id", species if species != "" else "blockling_homes"))
			var realm := String(entry.get("realm", "verdant"))
			node = ProcBuildings.make(world_seed, inst_key, bid, realm)
			_apply_ctx(node, ctx)
		"water":
			node = ProcWater.make(world_seed, inst_key, species, {"context": ctx})
		_:
			node = ProcPlants.make(world_seed, inst_key, "flower", ctx)
	if node == null:
		node = ProcPlants.make(world_seed, inst_key, "flower", ctx)
	if stage >= 0.0:
		node.set_growth(stage)
	return node

# Re-adapt an already-placed node to a freshly-measured neighbourhood (called when a
# neighbour is added/removed nearby). Honours whichever contract the module exposes.
static func adapt(node: ProcNode, context: Dictionary) -> void:
	if node == null:
		return
	if node.has_method("apply_context"):
		node.call("apply_context", context)
	else:
		# modules that read a plain property do so on their next build/redraw
		if _has_prop(node, "ctx"):
			node.set("ctx", context)
		elif _has_prop(node, "_ctx"):
			node.set("_ctx", context)
		node.queue_redraw()

# Freeze / thaw a thing's life clock (minting / replacing a keepsake, §5).
static func set_frozen(node: ProcNode, frozen: bool) -> void:
	if node == null:
		return
	if node.has_method("set_minted"):
		node.call("set_minted", frozen)
	elif node.has_method("set_frozen"):
		node.call("set_frozen", frozen)
	else:
		# universal fallback: stop the slow growth clock; Interact draws the sheen.
		node.set_meta("_saved_grow_rate", node.grow_rate if frozen else node.get_meta("_saved_grow_rate", node.grow_rate))
		node.grow_rate = 0.0 if frozen else float(node.get_meta("_saved_grow_rate", 1.0 / 1500.0))

# -----------------------------------------------------------------------------
# Facts placement / actions need
# -----------------------------------------------------------------------------

static func ground_type(entry: Dictionary) -> String:
	var kind := String(entry.get("kind", "plant"))
	var sp := String(entry.get("species", ""))
	if kind == "water":
		return "water"
	if WATER_SPECIES.has(sp):
		return "water" if sp != "well" else "any"
	if kind == "building":
		return "level"              # wants a flattenable patch
	return "land"

static func produces(entry: Dictionary) -> String:
	var kind := String(entry.get("kind", "plant"))
	if kind == "building":
		var bd: Dictionary = GameData.buildings_by_id.get(String(entry.get("building_id", "")), {})
		return String(bd.get("produces", ""))
	# only the clearly productive kinds shed resources; a lone wildflower is just pretty
	if kind == "tree" or kind == "crystal":
		return String(PRODUCES.get(kind, ""))
	return ""

# A gentle per-second yield used by this module's own diegetic accrual (not the
# economy autoload). Scaled by g(growth) at harvest time.
static func base_yield(entry: Dictionary) -> float:
	match String(entry.get("kind", "plant")):
		"tree": return 0.6
		"crystal": return 0.3
		"building":
			var bd: Dictionary = GameData.buildings_by_id.get(String(entry.get("building_id", "")), {})
			return float(bd.get("base_prod", 0.0))
		_: return 0.0

static func display_label(entry: Dictionary) -> String:
	if entry.has("label") and String(entry["label"]) != "":
		return String(entry["label"])
	var kind := String(entry.get("kind", "plant"))
	if kind == "building":
		var bd: Dictionary = GameData.buildings_by_id.get(String(entry.get("building_id", "")), {})
		return String(bd.get("name", "Building"))
	if kind == "creature":
		var sp: Dictionary = GameData.blocklings_by_id.get(String(entry.get("species", "")), {})
		if not sp.is_empty():
			return String(sp.get("name", "Blockling"))
		return "Blockling"
	var s := String(entry.get("species", kind))
	return s.capitalize() if s != "" else kind.capitalize()

# A poetic one-liner for the Inspect whisper (diegetic, no panel).
static func inspect_line(entry: Dictionary, growth: float) -> String:
	var name := display_label(entry)
	var stage := _stage_word(growth)
	if String(entry.get("kind", "")) == "creature":
		var sp: Dictionary = GameData.blocklings_by_id.get(String(entry.get("species", "")), {})
		var desc := String(sp.get("desc", ""))
		if desc != "":
			return name + " — " + desc
	if bool(entry.get("minted", false)):
		return name + " — held timeless, pressed like a flower."
	return "%s — %s" % [name, stage]

static func _stage_word(g: float) -> String:
	if g < 0.16: return "a tender sprout, just waking"
	if g < 0.5: return "young and slender, reaching up"
	if g < 0.85: return "filling out, nearly grown"
	return "fully grown, alive and swaying"

# Which in-world actions a tapped thing offers (IDLE-DESIGN §2.3). Order = priority.
static func actions_for(entry: Dictionary, growth: float) -> Array:
	if bool(entry.get("minted", false)):
		return ["inspect", "pickup"]
	var kind := String(entry.get("kind", "plant"))
	var out: Array = ["nurture"]
	if produces(entry) != "" and growth >= 0.45:
		out.append("harvest")
	if kind == "creature":
		out.append("assign")
	out.append("inspect")
	if growth >= 0.85 and (kind == "tree" or kind == "creature" or kind == "building" or kind == "crystal"):
		out.append("mint")
	out.append("pickup")
	return out

# -----------------------------------------------------------------------------
# A generous starter inventory so the one menu is never empty on a fresh world.
# Interact seeds this into Game.state["inventory"] only if none exists yet.
# -----------------------------------------------------------------------------
static func starter_inventory() -> Dictionary:
	return {
		"seed:oak":     {"count": 3, "kind": "tree",   "species": "oak",     "label": "Oak Seed",      "growth": -1.0, "minted": false},
		"seed:blossom": {"count": 2, "kind": "tree",   "species": "blossom", "label": "Blossom Seed",  "growth": -1.0, "minted": false},
		"seed:wild":    {"count": 6, "kind": "plant",  "species": "random",  "label": "Wildflower",    "growth": -1.0, "minted": false},
		"seed:poppy":   {"count": 4, "kind": "plant",  "species": "poppy",   "label": "Poppy",         "growth": -1.0, "minted": false},
		"seed:fern":    {"count": 3, "kind": "plant",  "species": "fern",    "label": "Fern",          "growth": -1.0, "minted": false},
		"spore:mush":   {"count": 3, "kind": "fungus", "species": "mushroom","label": "Mushrooms",     "growth": -1.0, "minted": false},
		"shard:crystal":{"count": 2, "kind": "crystal","species": "crystal", "label": "Crystal Shard", "growth": -1.0, "minted": false},
		"decor:lantern":{"count": 2, "kind": "decor",  "species": "lantern", "label": "Lantern",       "growth": -1.0, "minted": false},
		"decor:rock":   {"count": 3, "kind": "decor",  "species": "rock",    "label": "Mossy Rock",    "growth": -1.0, "minted": false},
		"decor:lily":   {"count": 2, "kind": "water",  "species": "lilypad", "label": "Lily Pad",      "growth": -1.0, "minted": false},
		"egg:pip":      {"count": 1, "kind": "creature","species": "pip",    "label": "Pip (egg)",     "growth": -1.0, "minted": false},
		"plan:garden":  {"count": 1, "kind": "building","building_id": "essence_garden", "species": "garden", "label": "Essence Garden", "growth": -1.0, "minted": false},
	}

# -----------------------------------------------------------------------------
# helpers
# -----------------------------------------------------------------------------
static func _resolve_species(world_seed: int, inst_key: String, kind: String, species: String) -> String:
	var s := species.strip_edges().to_lower()
	if s != "" and s != "random":
		return s
	var pool: Array
	match kind:
		"tree": pool = WILD_TREES
		"fungus": pool = WILD_FUNGI
		"crystal": pool = WILD_CRYSTALS
		"decor": pool = WILD_DECOR
		"creature": pool = _creature_pool()
		_: pool = WILD_PLANTS
	if pool.is_empty():
		return "flower"
	var i := int(Proc.hashf(hash("%d:%s" % [world_seed, inst_key]), "wild") * pool.size())
	return String(pool[clampi(i, 0, pool.size() - 1)])

static func _creature_pool() -> Array:
	var out: Array = []
	for b in GameData.blocklings:
		out.append(String(b.get("id", "")))
	if out.is_empty():
		out = ["pip"]
	return out

static func _apply_ctx(node: ProcNode, ctx: Dictionary) -> void:
	if node != null and not ctx.is_empty() and node.has_method("apply_context"):
		node.call("apply_context", ctx)

static func _has_prop(o: Object, name: String) -> bool:
	for p in o.get_property_list():
		if String(p.get("name", "")) == name:
			return true
	return false


# =============================================================================
# --- dyn:discovery (additive) ------------------------------------------------
# Owned by scripts/world/dyn/Discovery.gd (DYNAMICS §9.6). APPEND-ONLY: nothing
# above this line is modified by this block. It gives the collection/breeding
# layer stable names, art routing and journal prose for rare variants and for
# cross-pollinated hybrids, so Discovery never has to hardcode content.
# =============================================================================

const VARIANT_TIERS := ["common", "lush", "radiant", "ancient"]

const VARIANT_LABELS := {
	"common": "Common", "lush": "Lush", "radiant": "Radiant", "ancient": "Ancient",
}

const VARIANT_LINES := {
	"common": "an ordinary one, and no less loved for it",
	"lush": "fuller than its kin, greener at the heart",
	"radiant": "it carries a light of its own, and the air bends to it",
	"ancient": "older than the island remembers — gold runs under its skin",
}

# How strongly a species' own art reads, used to pick which parent a crossing
# inherits its silhouette from (a tree beats a flower).
const _KIND_RANK := {"tree": 5, "fungus": 4, "crystal": 3, "water": 2, "plant": 2, "decor": 1}

# The fourteen crossings that earned real names. Everything else gets a seeded
# two-part name (see hybrid_label) so no find is ever called "Hybrid #7".
const HYBRIDS := {
	"x:poppy+sunflower": {"label": "Dawnpoppy", "dominant": "poppy", "accent": "sunflower",
		"line": "a poppy that opens facing the first light, and closes at noon"},
	"x:bluebell+fern": {"label": "Mistbell", "dominant": "bluebell", "accent": "fern",
		"line": "its bells hold morning mist long after the rest of the island dries"},
	"x:clover+poppy": {"label": "Emberclover", "dominant": "clover", "accent": "poppy",
		"line": "three leaves and one coal-red fourth, warm to the touch"},
	"x:bluecap+fern": {"label": "Moonfern", "dominant": "fern", "accent": "bluecap",
		"line": "fronds that curl shut by day and unroll under the moon"},
	"x:crystal+lilypad": {"label": "Glasslily", "dominant": "lilypad", "accent": "crystal",
		"line": "a pad so clear you can count the stones beneath it"},
	"x:blossom+toadstool": {"label": "Ashblossom", "dominant": "blossom", "accent": "toadstool",
		"line": "pale petals with a dusting of spore, and a faint, good smell of rain"},
	"x:lantern+willow": {"label": "Willowlight", "dominant": "willow", "accent": "lantern",
		"line": "a willow whose catkins glow, so the path under it is never dark"},
	"x:clover+mushroom": {"label": "Stoneclover", "dominant": "clover", "accent": "mushroom",
		"line": "it roots in bare rock and makes soil out of patience"},
	"x:crystalpink+daisy": {"label": "Starthistle", "dominant": "daisy", "accent": "crystalpink",
		"line": "a daisy with a hard bright heart that chimes in wind"},
	"x:birch+fern": {"label": "Dewbirch", "dominant": "birch", "accent": "fern",
		"line": "silver bark that beads with water every single dawn"},
	"x:berrybush+maple": {"label": "Thornapple", "dominant": "maple", "accent": "berrybush",
		"line": "small sharp fruit, sweet once the frost has been through it"},
	"x:bluecap+mushroom": {"label": "Lanternmoss", "dominant": "mushroom", "accent": "bluecap",
		"line": "a cap that keeps a low blue light burning all night"},
	"x:blossom+geode": {"label": "Frostbloom", "dominant": "blossom", "accent": "geode",
		"line": "petals that keep their shape like something carved and left out in winter"},
	"x:oak+sunflower": {"label": "Sunoak", "dominant": "oak", "accent": "sunflower",
		"line": "an oak whose crown turns, very slowly, to follow the day"},
}

# Seeded name parts for unnamed crossings — "Dew-Fern", "Ember-Clover".
const _HYBRID_PREFIX := ["Dew", "Ember", "Moon", "Mist", "Dusk", "Glass", "Ash",
	"Stone", "Star", "Frost", "Sun", "Thorn", "Lantern", "Amber", "Hollow", "Brook",
	"Quiet", "Copper", "Rain", "Cinder"]

const _HYBRID_LINES := ["a crossing the island made up on its own",
	"neither parent, and somehow more like the place than either",
	"it took the shape of one and the colour of the other",
	"the first of its kind to stand on this ground"]


# Which kind of thing a species is, for the pools this catalog already owns.
static func species_kind(species: String) -> String:
	var s := species.strip_edges().to_lower()
	if s == "":
		return "plant"
	if WILD_TREES.has(s):
		return "tree"
	if WILD_FUNGI.has(s):
		return "fungus"
	if WILD_CRYSTALS.has(s):
		return "crystal"
	if WATER_SPECIES.has(s):
		return "water" if s != "well" else "decor"
	if WILD_DECOR.has(s):
		return "decor"
	if WILD_PLANTS.has(s):
		return "plant"
	# fall back to the decoration data's own material tagging
	var mat := ""
	if typeof(GameData) == TYPE_OBJECT:
		for item in GameData.decoration_types:
			var d: Dictionary = item
			if String(d.get("id", "")) == s:
				mat = String(d.get("material", ""))
				break
	match mat:
		"fungus": return "fungus"
		"crystal": return "crystal"
		"water": return "water"
		"light", "stone", "wood": return "decor"
		_: return "plant"


# Every species this catalog can ever produce — the Journal's "growing things"
# denominator. Computed from live data, never a hardcoded number.
static func species_pool() -> Array:
	var seen := {}
	var out: Array = []
	var pools: Array = [WILD_TREES, WILD_PLANTS, WILD_FUNGI, WILD_CRYSTALS, WILD_DECOR]
	for item in pools:
		var pool: Array = item
		for sp in pool:
			var s := String(sp)
			if not seen.has(s):
				seen[s] = true
				out.append(s)
	for k in WATER_SPECIES.keys():
		var s2 := String(k)
		if not seen.has(s2):
			seen[s2] = true
			out.append(s2)
	if typeof(GameData) == TYPE_OBJECT:
		for item2 in GameData.decoration_types:
			var d: Dictionary = item2
			var s3 := String(d.get("id", ""))
			if s3 != "" and not seen.has(s3):
				seen[s3] = true
				out.append(s3)
	return out


# The stable identity of a crossing: "x:" + the two parents, sorted.
static func hybrid_species(a: String, b: String) -> String:
	var pair: Array = [a.strip_edges().to_lower(), b.strip_edges().to_lower()]
	pair.sort()
	return "x:%s+%s" % [String(pair[0]), String(pair[1])]


static func hybrid_parents(species: String) -> Array:
	var s := species
	if s.begins_with("x:"):
		s = s.substr(2)
	var parts := s.split("+")
	if parts.size() < 2:
		return [s, s]
	return [String(parts[0]), String(parts[1])]


static func hybrid_count() -> int:
	return HYBRIDS.size()


# A full description of a crossing: which parent's art it wears, which parent
# only tints it, its name and its journal line. Works for unnamed crossings too.
static func hybrid_def(species: String, world_seed: int = 0) -> Dictionary:
	if HYBRIDS.has(species):
		var named: Dictionary = (HYBRIDS[species] as Dictionary).duplicate(true)
		named["parents"] = hybrid_parents(species)
		named["named"] = true
		named["kind"] = species_kind(String(named.get("dominant", "flower")))
		return named
	var ps := hybrid_parents(species)
	var a := String(ps[0])
	var b := String(ps[1])
	var ra := int(_KIND_RANK.get(species_kind(a), 2))
	var rb := int(_KIND_RANK.get(species_kind(b), 2))
	var dom := a
	var acc := b
	if rb > ra:
		dom = b
		acc = a
	var li := int(Proc.hashf(world_seed, "hybline:" + species) * float(_HYBRID_LINES.size()))
	return {
		"label": hybrid_label(species, world_seed),
		"dominant": dom, "accent": acc, "parents": [a, b], "named": false,
		"kind": species_kind(dom),
		"line": String(_HYBRID_LINES[clampi(li, 0, _HYBRID_LINES.size() - 1)]),
	}


static func hybrid_label(species: String, world_seed: int = 0) -> String:
	if HYBRIDS.has(species):
		return String((HYBRIDS[species] as Dictionary).get("label", "Crossing"))
	var ps := hybrid_parents(species)
	var a := String(ps[0])
	var b := String(ps[1])
	var ra := int(_KIND_RANK.get(species_kind(a), 2))
	var rb := int(_KIND_RANK.get(species_kind(b), 2))
	var dom := a if ra >= rb else b
	var i := int(Proc.hashf(world_seed, "hybname:" + species) * float(_HYBRID_PREFIX.size()))
	var pre := String(_HYBRID_PREFIX[clampi(i, 0, _HYBRID_PREFIX.size() - 1)])
	return "%s-%s" % [pre, dom.capitalize()]


# A tray entry for a crossing's seed. It carries the DOMINANT parent as `species`
# so the existing art path draws it correctly with no new routing, plus the
# hybrid identity so Discovery (and adapt()) can tint it with the other parent.
static func hybrid_entry(species: String, world_seed: int = 0, count: int = 1) -> Dictionary:
	var def := hybrid_def(species, world_seed)
	return {
		"count": maxi(1, count),
		"kind": String(def.get("kind", "plant")),
		"species": String(def.get("dominant", "flower")),
		"label": String(def.get("label", "Crossing")),
		"hybrid": species,
		"hybrid_accent": String(def.get("accent", "")),
		"growth": -1.0,
		"minted": false,
	}


static func is_hybrid(entry: Dictionary) -> bool:
	return String(entry.get("hybrid", "")) != ""


static func variant_label(tier: String) -> String:
	return String(VARIANT_LABELS.get(tier, tier.capitalize()))


static func variant_line(tier: String) -> String:
	return String(VARIANT_LINES.get(tier, "a shape all its own"))
