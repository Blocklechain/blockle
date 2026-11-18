extends Node
# Combinatorial Blockling appearance — how Blockle Idle has TRILLIONS of distinct
# Blocklings while every pixel is hand-painted.
#
# Each individual's look is a deterministic STACK of hand-painted layers chosen
# from trait pools, keyed by (world_seed, uid): a species base (one of several
# painted VARIANTS), a hue wash, body markings, an accessory, a hat, wings, a
# tail and an aura — and EACH of those layers also has multiple painted variants.
# The number of combinations is the product of the pool sizes times their variant
# counts times the species count — so the roster space is astronomically large,
# every layer is real art, and each player's individuals are stable + unique.

const HUES := [
	Color(1,1,1), Color(1.10,0.96,0.90), Color(0.92,1.06,0.96), Color(0.94,0.98,1.12),
	Color(1.08,1.00,0.92), Color(0.96,0.94,1.10), Color(1.06,0.92,0.98), Color(0.90,1.04,1.04),
	Color(1.12,1.04,0.90), Color(0.98,1.08,0.92), Color(1.00,0.92,1.06), Color(0.92,0.98,1.08),
	Color(1.08,0.98,1.00), Color(0.96,1.02,0.94), Color(1.04,1.08,1.00), Color(0.90,0.96,1.02),
	Color(1.10,1.00,1.06), Color(0.94,1.00,1.10), Color(1.02,0.94,0.92), Color(1.00,1.06,1.08)]
const MARKINGS := ["none", "spots", "stripes", "dapple", "swirl", "freckles", "starmark", "patch", "speckle", "ring"]
const ACCESSORIES := ["none", "flower", "scarf", "leaf", "lantern", "glasses", "bow", "acorn", "bell", "cloak", "backpack", "necklace", "umbrella", "balloon", "book", "staff"]
const AURAS := ["none", "sparkle", "glow", "petals", "embers", "frost", "bubbles", "leaves"]
const HATS := ["none", "strawhat", "tophat", "crown", "flowercrown", "cap", "beanie", "wizardhat", "bowhat", "leafhat", "mushroomcap", "acorncap"]
const WINGS := ["none", "butterfly", "moth", "bird", "dragon", "fairy", "bat", "leafwing"]
const TAILS := ["none", "foxtail", "cattail", "pufftail", "leaftail", "curltail", "fintail", "startail"]
const EXPRESSIONS := ["content", "happy", "sleepy", "curious", "determined", "surprised"]
const SIZES := [0.82, 0.9, 1.0, 1.12, 1.28]

# How many painted versions exist of each thing (must match what gen.py produces).
const SPECIES_VARIANTS := 4
const MARK_VAR := 4
const ACC_VAR := 4
const AURA_VAR := 4
const HAT_VAR := 3
const WING_VAR := 3
const TAIL_VAR := 3

func _species_count() -> int:
	return GameData.blocklings.size() if GameData and GameData.blocklings else 30

# The headline number — real, not marketing: the full combinatorial space.
func combination_count() -> int:
	return _species_count() * SPECIES_VARIANTS * HUES.size() \
		* (MARKINGS.size() * MARK_VAR) * (ACCESSORIES.size() * ACC_VAR) \
		* (AURAS.size() * AURA_VAR) * (HATS.size() * HAT_VAR) \
		* (WINGS.size() * WING_VAR) * (TAILS.size() * TAIL_VAR) \
		* EXPRESSIONS.size() * SIZES.size()

func _rng(uid: String, salt: String) -> RandomNumberGenerator:
	var r := RandomNumberGenerator.new()
	var ws := int(Game.state.get("world_seed", 1)) if (Game and Game.state) else 1
	r.seed = hash("%d:%s:%s" % [ws, uid, salt])
	return r

func _pick(uid: String, salt: String, pool: Array):
	return pool[_rng(uid, salt).randi() % pool.size()]

func _var(uid: String, salt: String, n: int) -> int:
	return 1 + _rng(uid, salt).randi() % max(1, n)

# Deterministic, stable trait stack (+ per-layer painted variant) for one Blockling.
func traits_for(uid: String) -> Dictionary:
	var r := _rng(uid, "base")
	return {
		"species_variant": _var(uid, "spv", SPECIES_VARIANTS),
		"hue": HUES[r.randi() % HUES.size()],
		"marking": _pick(uid, "mk", MARKINGS), "marking_variant": _var(uid, "mkv", MARK_VAR),
		"accessory": _pick(uid, "ac", ACCESSORIES), "accessory_variant": _var(uid, "acv", ACC_VAR),
		"aura": _pick(uid, "au", AURAS), "aura_variant": _var(uid, "auv", AURA_VAR),
		"hat": _pick(uid, "ht", HATS), "hat_variant": _var(uid, "htv", HAT_VAR),
		"wings": _pick(uid, "wg", WINGS), "wings_variant": _var(uid, "wgv", WING_VAR),
		"tail": _pick(uid, "tl", TAILS), "tail_variant": _var(uid, "tlv", TAIL_VAR),
		"expression": _pick(uid, "ex", EXPRESSIONS),
		"size": SIZES[_rng(uid, "sz").randi() % SIZES.size()],
		"flip": _rng(uid, "fl").randf() < 0.5,
	}

# A short human label for a Blockling's distinctive traits (for the journal).
func describe(uid: String) -> String:
	var t := traits_for(uid)
	var bits: Array = []
	if t["hat"] != "none":
		bits.append("wearing a " + String(t["hat"]).replace("hat", " hat"))
	if t["wings"] != "none":
		bits.append(String(t["wings"]) + " wings")
	if t["tail"] != "none":
		bits.append("a " + String(t["tail"]).replace("tail", " tail"))
	if t["accessory"] != "none":
		bits.append("with a " + String(t["accessory"]))
	if t["marking"] != "none":
		bits.append(String(t["marking"]) + " markings")
	if t["aura"] != "none":
		bits.append("a " + String(t["aura"]) + " aura")
	return (", ".join(bits)) if not bits.is_empty() else "plain-coated"
