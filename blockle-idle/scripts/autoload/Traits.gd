extends Node
# Combinatorial Blockling appearance — how Blockle Idle has hundreds of thousands
# (in fact millions) of distinct Blocklings while every pixel is hand-painted.
#
# Each individual's look is a deterministic STACK of hand-painted layers chosen
# from trait pools, keyed by (world_seed, uid): a species base, a hue wash, a
# body marking, an accessory, an aura, an expression and a size. The number of
# distinct combinations is the product of the pool sizes times the species
# count — so the roster space is enormous, every layer is real art, and each
# player's individuals are stable + unique to them.
#
#   species(30) × hues(20) × markings(8) × accessories(12) × auras(6)
#   × expressions(6) × sizes(5)  =  10,368,000 possible Blocklings.

const HUES := [
	Color(1,1,1), Color(1.10,0.96,0.90), Color(0.92,1.06,0.96), Color(0.94,0.98,1.12),
	Color(1.08,1.00,0.92), Color(0.96,0.94,1.10), Color(1.06,0.92,0.98), Color(0.90,1.04,1.04),
	Color(1.12,1.04,0.90), Color(0.98,1.08,0.92), Color(1.00,0.92,1.06), Color(0.92,0.98,1.08),
	Color(1.08,0.98,1.00), Color(0.96,1.02,0.94), Color(1.04,1.08,1.00), Color(0.90,0.96,1.02),
	Color(1.10,1.00,1.06), Color(0.94,1.00,1.10), Color(1.02,0.94,0.92), Color(1.00,1.06,1.08)]
const MARKINGS := ["none", "spots", "stripes", "dapple", "swirl", "freckles", "starmark", "patch"]
const ACCESSORIES := ["none", "flower", "scarf", "hat", "leaf", "lantern", "glasses", "bow", "acorn", "crown", "bell", "cloak"]
const AURAS := ["none", "sparkle", "glow", "petals", "embers", "frost"]
const EXPRESSIONS := ["content", "happy", "sleepy", "curious", "determined", "surprised"]
const SIZES := [0.82, 0.9, 1.0, 1.12, 1.28]

func _species_count() -> int:
	return GameData.blocklings.size() if GameData and GameData.blocklings else 30

# The headline number — real, not marketing: the full combinatorial space.
func combination_count() -> int:
	return _species_count() * HUES.size() * MARKINGS.size() * ACCESSORIES.size() \
		* AURAS.size() * EXPRESSIONS.size() * SIZES.size()

func _rng(uid: String, salt: String) -> RandomNumberGenerator:
	var r := RandomNumberGenerator.new()
	var ws := int(Game.state.get("world_seed", 1)) if (Game and Game.state) else 1
	r.seed = hash("%d:%s:%s" % [ws, uid, salt])
	return r

# Deterministic, stable trait stack for one Blockling individual.
func traits_for(uid: String) -> Dictionary:
	var r := _rng(uid, "traits")
	return {
		"hue": HUES[r.randi() % HUES.size()],
		"marking": MARKINGS[r.randi() % MARKINGS.size()],
		"accessory": ACCESSORIES[r.randi() % ACCESSORIES.size()],
		"aura": AURAS[r.randi() % AURAS.size()],
		"expression": EXPRESSIONS[r.randi() % EXPRESSIONS.size()],
		"size": SIZES[r.randi() % SIZES.size()],
		"flip": r.randf() < 0.5,
	}

# A short human label for a Blockling's distinctive traits (for the journal).
func describe(uid: String) -> String:
	var t := traits_for(uid)
	var bits: Array = []
	if t["accessory"] != "none":
		bits.append("with a " + String(t["accessory"]))
	if t["marking"] != "none":
		bits.append(String(t["marking"]) + " markings")
	if t["aura"] != "none":
		bits.append("a " + String(t["aura"]) + " aura")
	return (", ".join(bits)) if not bits.is_empty() else "plain-coated"
