extends Node
# Per-player procedural world generation. One `world_seed` (rolled once at new
# game) deterministically shapes EVERY cosmetic choice through a seeded RNG, so
# each player's island silhouette, palette, building layout, Blockling variants,
# world name and daily discovery are uniquely theirs — a world that forms
# differently for everyone — while sharing the same hand-painted base content.
#
# Pure function of (world_seed, key): the same inputs always yield the same
# output, so nothing extra is stored and saves stay stable. Cosmetic only — it
# never changes balance or production (single-player, but we keep it fair/honest).

const ADJ := ["Verdant", "Quiet", "Golden", "Whispering", "Hidden", "Gentle",
	"Ancient", "Sunlit", "Misty", "Floating", "Emerald", "Dawnlit", "Wandering", "Starlit"]
const NOUN := ["Isle", "Reach", "Haven", "Hollow", "Shore", "Expanse", "Refuge",
	"Glade", "Sanctuary", "Rise", "Vale", "Cradle"]
const PERSONS := ["curious", "sleepy", "cheerful", "brave", "shy", "mischievous",
	"wise", "dreamy", "bold", "tender", "patient", "sprightly"]
const EPITHETS := ["the Kind", "the Swift", "the Dreamer", "the Curious", "the Bright",
	"the Patient", "the Gentle", "of the Glade", "of Dawn", "the Bold", "the Small", "the Elder"]
const DISCOVERIES := [
	"A warm wind carries seeds from a far realm.",
	"The Heart Tree hums a little brighter today.",
	"A hidden spring was found beneath the roots.",
	"Fireflies gathered to map the night sky.",
	"An old path to the ruins cleared itself.",
	"The crystals sang in a new key this morning.",
	"A shy visitor left a gift at the shore.",
	"Clouds drifted into the shape of a sleeping beast.",
	"The gardens bloomed a colour no one had named.",
	"A relic stirred, remembering the First Kingdom."]

func wseed() -> int:
	if Game and Game.state:
		return int(Game.state.get("world_seed", 1))
	return 1

func _rng(key: String) -> RandomNumberGenerator:
	var r := RandomNumberGenerator.new()
	r.seed = hash("%d:%s" % [wseed(), key])
	return r

# A subtle whole-world palette shift unique to the player (near-white modulate).
func world_tint() -> Color:
	var r := _rng("tint")
	return Color(r.randf_range(0.9, 1.08), r.randf_range(0.92, 1.08), r.randf_range(0.9, 1.1), 1.0)

# Per-vertex jitter multipliers for the island silhouette (so no two islands
# share a shape). Returned as fractional offsets of the vertex radius.
func island_jitter(n: int) -> Array:
	var r := _rng("island")
	var out: Array = []
	for i in range(n):
		out.append(Vector2(r.randf_range(-0.14, 0.14), r.randf_range(-0.1, 0.16)))
	return out

func grass_color() -> Color:
	var r := _rng("grass")
	return Color.from_hsv(r.randf_range(0.22, 0.40), r.randf_range(0.38, 0.62), r.randf_range(0.55, 0.82))

func soil_color() -> Color:
	var r := _rng("soil")
	return Color.from_hsv(r.randf_range(0.06, 0.11), r.randf_range(0.35, 0.6), r.randf_range(0.3, 0.5))

# Stable placement tweak for a building plot.
func plot(id: String) -> Dictionary:
	var r := _rng("plot:" + id)
	return { "dx": r.randf_range(-0.2, 0.2), "dy": r.randf_range(-0.05, 0.14),
		"sc": r.randf_range(0.9, 1.14), "flip": r.randf() < 0.5 }

# Stable per-Blockling look + personality (keyed by uid so it never changes for
# that individual, and differs per player even for the same species).
func blockling_variant(uid: String) -> Dictionary:
	var r := _rng("bk:" + uid)
	var tint := Color(r.randf_range(0.86, 1.12), r.randf_range(0.86, 1.12), r.randf_range(0.86, 1.12), 1.0)
	return { "tint": tint, "sc": r.randf_range(0.82, 1.16), "flip": r.randf() < 0.5,
		"personality": PERSONS[r.randi() % PERSONS.size()],
		"epithet": EPITHETS[r.randi() % EPITHETS.size()] }

# Deterministic island set-dressing: a seed-chosen scatter of hand-painted
# decorations across the island so no two players' islands look alike. Positions
# are island-local offsets (u,v); Main places + animates them by material.
func island_decorations() -> Array:
	var types: Array = GameData.decoration_types
	if types.is_empty():
		return []
	var r := _rng("decor")
	var out: Array = []
	var n := 12 + r.randi() % 12   # 12..23, unique per seed
	for i in range(n):
		var t: Dictionary = types[r.randi() % types.size()]
		var ang := r.randf() * TAU
		var rad := 0.5 + r.randf() * 0.55
		out.append({
			"type": t.get("id", ""), "material": t.get("material", "plant"),
			"variant": 1 + r.randi() % max(1, GameData.decoration_variants),
			"u": cos(ang) * 150.0 * rad,
			"v": sin(ang) * 44.0 * rad + 28.0,
			"scale": r.randf_range(0.5, 1.0), "flip": r.randf() < 0.5,
			"phase": r.randf() * TAU })
	out.sort_custom(func(a, b): return a["v"] < b["v"])   # nearer draws in front
	return out

# Which painted variant of a building / realm background this player sees.
func building_variant(id: String) -> int:
	return 1 + _rng("bv:" + id).randi() % 3

func realm_bg_variant(realm_id: String) -> int:
	return 1 + _rng("rbv:" + realm_id).randi() % 3

func world_name() -> String:
	var r := _rng("name")
	return "The %s %s" % [ADJ[r.randi() % ADJ.size()], NOUN[r.randi() % NOUN.size()]]

func daily_discovery(day: int) -> String:
	var r := _rng("day:%d" % day)
	return DISCOVERIES[r.randi() % DISCOVERIES.size()]

# Roll a fresh unique seed (called once when a new game starts).
static func fresh_seed() -> int:
	var r := RandomNumberGenerator.new()
	r.randomize()
	return int(r.randi()) ^ (int(Time.get_unix_time_from_system()) << 8)
