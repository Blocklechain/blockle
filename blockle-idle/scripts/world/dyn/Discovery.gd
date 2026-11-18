class_name Discovery
extends Node2D
# Discovery — the COLLECTION + BREEDING depth of the dynamics layer (DYNAMICS §6.3).
#
# This is the "things to do" system that never asks you to do anything. It turns a
# garden you arranged into a garden that keeps surprising you:
#
#   • RARE VARIANTS. Every thing you plant is rolled once against a gentle,
#     pity-timered ladder (common / lush / radiant / ancient). A rare morph is never
#     announced by a badge — it is bigger, brighter, haloed, or shimmering gold, and
#     it quietly makes itself a little more productive.
#   • CROSS-POLLINATION. Two mature plants of different species standing close, both
#     watered, slowly court each other. A faint golden thread arcs between them while
#     it happens. When it takes, a puff of pollen crosses the gap and a HYBRID SEED
#     drops into your basket — fourteen crossings have real names, the rest are named
#     by the island itself.
#   • BREEDING. A pair of fond creatures who have become friends, loitering near a
#     full-grown home, eventually leave an EGG of a species you may never have seen.
#     A woven nest-glow on the ground is the only readout.
#   • WEATHER-BORN RARITIES. A storm does not damage anything — it leaves something.
#     The most exposed plant on the island comes out of it STORM-TOUCHED, one tier
#     rarer, wearing a pale crackle, and sheds a seed of itself.
#   • THE JOURNAL TREE. The only collection screen this game will ever have is a
#     second tree beside the Heart Tree. It has eight boughs, one per category, and
#     it grows one leaf per discovery and one blossom per completed arc. Its `growth`
#     IS your collection fraction, so the monument fills out as you play. Tap the
#     trunk and it tells you how many leaves it carries; tap a leaf and it tells you
#     that one find, in one line.
#
# Nothing here expires, punishes or nags. Every probabilistic grant carries a pity
# counter, so progress always arrives. Every window is soft: a pollen pair you walk
# away from keeps its dwell, an egg keeps forming offline, a storm's gift waits in
# the basket. (DYNAMICS §2.2, §2.3.)
#
# CONTRACT  (DYNAMICS §4.2 / §4.4)
#   setup(world_seed, ctx)      ctx: {space, interact, sim, puzzles, sky}
#   catch_up(elapsed)           wall-clock advance on boot/resume (curved, §2.3)
#   notify(kind, payload)       inbound sibling + relayed world events
#   extra_actions(record)       adds the `admire` verb to a rare thing
#   handle_action(action, rec)  owns `admire`
#   handle_tap(screen, world)   owns taps on the Journal Tree (trunk / leaf / blossom)
#   queries: is_found, discover, variant_tier, variant_mult, luck_mult,
#            journal_progress  (+ found_count/total_count/newest/hybrid_count)
#
# STATE: Game.state["discovery"] only. Every field is backfilled with `.get`
# defaults, so a legacy save with no dyn keys at all loads without a single error.
#
# DEGRADATION: works with ONLY the mount hook wired. It discovers newly placed
# things by polling if the `placed` relay is absent, reads the ground through the
# already-public snap_ground(), and draws into its own layer. Without the tap
# dispatch the Journal Tree still grows and still whispers on every find — it just
# cannot be read by touch. Nothing in this file requires a sibling system to exist.

signal whisper(text: String)
signal dyn_event(kind: String, payload: Dictionary)

const SYS_KEY := "discovery"
const SYS_VERSION := 1

const TICK := 5.0                      # logic period (DYNAMICS §8: 0.15 ms budget)

# ---- the variant ladder (DYNAMICS §6.3) -------------------------------------
const TIERS := ["common", "lush", "radiant", "ancient"]
const LUSH_CHANCE := 0.115             # P(lush)
const RARE_CHANCE := 0.030             # P(radiant or better)
const ANCIENT_SHARE := 0.10            # of the rare band → P(ancient) = 0.003
const PITY_PLACE := 25                 # a non-common within 25 placements
const PITY_RARE := 120                 # a radiant-or-better within 120
const VARIANT_MULT := {"common": 1.00, "lush": 1.08, "radiant": 1.18, "ancient": 1.30}
const VARIANT_SCALE := {"common": 1.00, "lush": 1.08, "radiant": 1.06, "ancient": 1.14}
const VARIANT_TINT := {
	"common": Color(1, 1, 1, 0),
	"lush": Color(0.74, 1.00, 0.76, 1),
	"radiant": Color(0.92, 0.99, 1.00, 1),
	"ancient": Color(1.00, 0.90, 0.62, 1),
}
const VARIANT_TINT_W := {"common": 0.0, "lush": 0.07, "radiant": 0.10, "ancient": 0.12}

# ---- cross-pollination ------------------------------------------------------
const POLLEN_RANGE := 180.0
const POLLEN_MATURE := 0.85
const POLLEN_DWELL := 18.0 * 60.0      # courting time before the first attempt
const POLLEN_PITY := 45.0 * 60.0       # guaranteed by here
const POLLEN_ATTEMPT_GAP := 60.0       # one attempt per minute of dwell past the gate
const POLLEN_CHANCE := 0.5
const PAIR_COOLDOWN := 2.0 * 3600.0
const MAX_PAIRS := 8
const MAX_THREADS := 2                 # live courting-arc visuals (mote budget §7.4)
const WATER_WINDOW := 30.0 * 60.0

# ---- breeding ---------------------------------------------------------------
const EGG_RANGE := 300.0
const EGG_DWELL := 35.0 * 60.0
const EGG_PITY := 90.0 * 60.0
const EGG_COOLDOWN := 6.0 * 3600.0
const BOND_FOND := 0.45
const BOND_DEVOTED := 0.70

# ---- weather-born -----------------------------------------------------------
const STORM_SOAK := 120.0              # seconds of storm before it leaves a mark
const STORM_COOLDOWN := 6.0 * 3600.0
const STORM_PITY := 6.0 * 3600.0       # after this, gentler weather counts too

# ---- luck / caps (DYNAMICS §2.1) --------------------------------------------
const CAP := {"grow": 1.60, "yield": 1.60, "bond": 2.00, "luck": 3.00,
			  "cadence": 1.50, "craft": 1.50, "offline": 12.0}
const FLOOR := 0.92
const LIGHTWELL_RANGE := 220.0
const LIGHTWELL_BONUS := 1.60

# ---- offline curve (identical to IdleSim.effective_seconds) -----------------
const OFFLINE_FULL_HOURS := 8.0
const OFFLINE_CAP_HOURS := 48.0
const OFFLINE_FLOOR := 0.5

# ---- journal ----------------------------------------------------------------
const JOURNAL_TX := -260.0             # terrain-x offset from the Heart Tree
const JOURNAL_JITTER := 40.0
const JOURNAL_CLEAR := 70.0            # min clearance from an existing placement
const GLOW_SECONDS := 600.0            # the newest leaf glows for ten minutes
const GIFT_EVERY := 8                  # leaves between the tree letting a seed fall

const WHISPER_GAP := 12.0              # DYNAMICS §2.6 budget for this system
const INSIGHT_GAP := 20.0 * 60.0       # a scholar's hint, at most this often

var world_seed: int = 1

# ---- wiring -----------------------------------------------------------------
var _space: Node = null
var _interact: Node = null
var _sim: Node = null
var _puzzles: Node = null
var _sky: Node = null
var _booted := false

# ---- scene graph we own -----------------------------------------------------
var _fx: Node2D                        # pollen motes / blooms (cam-local = world)
var _tree: ProcNode                    # the Journal Tree
var _auras: Dictionary = {}            # place_id -> aura ProcNode
var _threads: Dictionary = {}          # pair_key  -> _PollenThread
var _nests: Dictionary = {}            # pair_key  -> _NestGlow
var _marks: Dictionary = {}            # place_id  -> storm mark

# ---- tick state -------------------------------------------------------------
var _acc: float = 0.0
var _known: Dictionary = {}            # place_id -> entry signature (poll fallback)
var _rec_cache: Array = []
var _rec_at: float = -999.0
var _tot_cache: Dictionary = {}
var _tot_at: float = -999.0
var _last_whisper: float = -999.0
var _fx_count: int = 0

# spelled numbers, so the journal never reads like a spreadsheet
const _ONES := ["no", "one", "two", "three", "four", "five", "six", "seven", "eight",
	"nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
	"seventeen", "eighteen", "nineteen"]
const _TENS := ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy",
	"eighty", "ninety"]


# =============================================================================
# STATE  (one top-level key, every field backfilled — DYNAMICS §3)
# =============================================================================
func _st() -> Dictionary:
	if typeof(Game) != TYPE_OBJECT or not (Game.state is Dictionary):
		return {}
	if not Game.state.has(SYS_KEY) or not (Game.state[SYS_KEY] is Dictionary):
		Game.state[SYS_KEY] = {}
	var st: Dictionary = Game.state[SYS_KEY]
	st["version"] = int(st.get("version", SYS_VERSION))
	st["seq"] = int(st.get("seq", 0))
	if not (st.get("pity") is Dictionary):
		st["pity"] = {}
	var pity: Dictionary = st["pity"]
	pity["place"] = int(pity.get("place", 0))
	pity["rare"] = int(pity.get("rare", 0))
	if not (st.get("found") is Dictionary):
		st["found"] = {}
	if not (st.get("variants") is Dictionary):
		st["variants"] = {}
	if not (st.get("pollen") is Dictionary):
		st["pollen"] = {}
	if not (st.get("hybrids") is Dictionary):
		st["hybrids"] = {}
	if not (st.get("eggs") is Dictionary):
		st["eggs"] = {}
	if not (st.get("carry") is Dictionary):
		st["carry"] = {}
	if not (st.get("admired") is Dictionary):
		st["admired"] = {}
	if not (st.get("journal") is Dictionary):
		st["journal"] = {}
	var j: Dictionary = st["journal"]
	j["planted"] = bool(j.get("planted", false))
	j["place_id"] = String(j.get("place_id", "journal_tree"))
	j["tx"] = float(j.get("tx", 0.0))
	j["newest"] = float(j.get("newest", 0.0))
	j["gifts"] = int(j.get("gifts", 0))
	j["twin"] = bool(j.get("twin", false))
	if not (j.get("blossoms") is Array):
		j["blossoms"] = []
	if not (st.get("storm") is Dictionary):
		st["storm"] = {}
	var sm: Dictionary = st["storm"]
	sm["soak"] = float(sm.get("soak", 0.0))
	sm["last"] = float(sm.get("last", 0.0))
	sm["pity"] = float(sm.get("pity", 0.0))
	if not (st.get("stats") is Dictionary):
		st["stats"] = {}
	var stats: Dictionary = st["stats"]
	stats["placements"] = int(stats.get("placements", 0))
	stats["hybrids"] = int(stats.get("hybrids", 0))
	stats["eggs"] = int(stats.get("eggs", 0))
	stats["storms"] = int(stats.get("storms", 0))
	st["insight"] = float(st.get("insight", 0.0))
	st["backfilled"] = bool(st.get("backfilled", false))
	return st


# Deterministic "random" from the save, never from the clock (DYNAMICS §2.5).
func _rand(tag: String) -> float:
	var st := _st()
	if st.is_empty():
		return Proc.hashf(world_seed, "%s:%s" % [SYS_KEY, tag])
	var n := int(st.get("seq", 0))
	st["seq"] = n + 1
	return Proc.hashf(world_seed, "%s:%s:%d" % [SYS_KEY, tag, n])


# Roll with pity: after `pity_max` misses the next roll is forced (DYNAMICS §2.2).
func _roll(tag: String, chance: float, pity_field: String, pity_max: int) -> bool:
	var st := _st()
	if st.is_empty():
		return false
	var pity: Dictionary = st["pity"]
	var n := int(pity.get(pity_field, 0))
	var forced: bool = n >= pity_max
	var hit: bool = forced or (_rand(tag) < chance * luck_mult())
	pity[pity_field] = 0 if hit else n + 1
	return hit


func _now() -> float:
	return Time.get_unix_time_from_system()


func _full_hours() -> float:
	var r := _sib("Rituals")
	if r != null and r.has_method("blessing"):
		var b := float(r.call("blessing", "offline"))
		if b > 1.5:                            # the rite reports hours, not a ratio
			return clampf(b, OFFLINE_FULL_HOURS, float(CAP["offline"]))
	return OFFLINE_FULL_HOURS


# The shared soft-diminishing offline curve (DYNAMICS §2.3).
func _effective(elapsed: float) -> float:
	var e: float = maxf(0.0, elapsed)
	var full: float = _full_hours() * 3600.0
	var cap: float = OFFLINE_CAP_HOURS * 3600.0
	if e <= full:
		return e
	var span: float = maxf(1.0, cap - full)
	var over: float = minf(e, cap) - full
	var avg: float = 1.0 - (1.0 - OFFLINE_FLOOR) * 0.5 * (over / span)
	return full + over * avg


# =============================================================================
# SETUP
# =============================================================================
func setup(seed_value: int, ctx: Dictionary = {}) -> void:
	world_seed = seed_value
	_space = ctx.get("space", null) as Node
	_interact = ctx.get("interact", null) as Node
	_sim = ctx.get("sim", null) as Node
	_puzzles = ctx.get("puzzles", null) as Node
	_sky = ctx.get("sky", null) as Node
	if _sky == null:
		_sky = _find_sky()
	z_index = 0
	_fx = Node2D.new()
	_fx.name = "DiscoveryFX"
	_fx.z_index = 29
	add_child(_fx)
	_backfill()
	_seed_known()
	var st := _st()
	if not st.is_empty():
		var j: Dictionary = st["journal"]
		if bool(j.get("planted", false)):
			_plant_journal(true)
	_refresh_journal(false)
	_booted = true


func _sib(n: String) -> Node:
	var p := get_parent()
	if p == null:
		return null
	return p.get_node_or_null(n)


# The sky node is unnamed inside WorldSpace; find it by capability, not by name.
func _find_sky() -> Node:
	if _space == null:
		return null
	if _space.has_method("sky_node"):
		var s = _space.call("sky_node")
		if s is Node:
			return s
	for ch in _space.get_children():
		if ch.has_method("set_weather"):
			return ch
	return null


# One-time, silent import of what the player already met before this layer existed.
func _backfill() -> void:
	var st := _st()
	if st.is_empty() or bool(st.get("backfilled", false)):
		return
	st["backfilled"] = true
	var added := 0
	var legacy: Dictionary = Game.state.get("discovered", {}) if (Game.state.get("discovered") is Dictionary) else {}
	for k in legacy.keys():
		var sp := String(k)
		if sp == "":
			continue
		if _record_found("creature:" + sp, {"cat": "creatures", "quiet": true}):
			added += 1
	var placed: Dictionary = Game.state.get("placements", {}) if (Game.state.get("placements") is Dictionary) else {}
	for pid in placed.keys():
		var rec: Dictionary = placed[pid]
		var sp2 := String(rec.get("species", ""))
		var kind := String(rec.get("kind", "plant"))
		if sp2 == "":
			continue
		var key := ("creature:" + sp2) if kind == "creature" else ("species:" + sp2)
		if _record_found(key, {"quiet": true}):
			added += 1
	if added > 0:
		_say("The journal remembers what you have already met.")


# Adopt whatever is already standing: remember it (so the poll does not re-fire),
# and give anything that has never been looked at its one variant roll. On the very
# first boot of this layer that is the island quietly revealing which of the things
# you already grew turned out to be special.
func _seed_known() -> void:
	var st := _st()
	var variants: Dictionary = st["variants"] if not st.is_empty() else {}
	for item in _records():
		var r: Dictionary = item
		var pid := String(r.get("id", ""))
		if pid == "":
			continue
		_known[pid] = _sig(r.get("entry", {}) as Dictionary)
		if variants.has(pid):
			_apply_variant(r, String(variants[pid]))      # restore the look after a reload
		else:
			_on_placed(r)


# =============================================================================
# PUBLIC QUERY SURFACE  (DYNAMICS §4.4)
# =============================================================================
func is_found(key: String) -> bool:
	var st := _st()
	if st.is_empty():
		return false
	return (st["found"] as Dictionary).has(key)


# Record a discovery. Returns true if it was NEW. `meta` may carry
# {cat, label, line, tier, quiet} — the category is inferred from the key prefix.
func discover(key: String, meta: Dictionary = {}) -> bool:
	if key == "":
		return false
	var fresh := _record_found(key, meta)
	if not fresh:
		return false
	_refresh_journal(true)
	if not bool(meta.get("quiet", false)):
		var label := _label_for(key, meta)
		_say("%s — new to the journal." % label)
	emit_signal("dyn_event", "discovered", {
		"key": key, "category": _cat_of(key, meta), "tier": String(meta.get("tier", "")),
		"label": _label_for(key, meta),
	})
	return true


func variant_tier(place_id: String) -> String:
	var st := _st()
	if st.is_empty():
		return "common"
	return String((st["variants"] as Dictionary).get(place_id, "common"))


func variant_mult(place_id: String, key: String) -> float:
	if key != "grow" and key != "yield":
		return 1.0
	var m := float(VARIANT_MULT.get(variant_tier(place_id), 1.0))
	return clampf(m, 1.0, 1.30)


# The shared luck multiplier: season + blessings + lightwell glass + meteor credit.
func luck_mult() -> float:
	return _mult("luck", "")


func journal_progress() -> float:
	var tot := total_count()
	if tot <= 0:
		return 0.0
	return clampf(float(found_count()) / float(tot), 0.0, 1.0)


func found_count() -> int:
	var st := _st()
	if st.is_empty():
		return 0
	return (st["found"] as Dictionary).size()


func total_count() -> int:
	var t := _totals()
	var n := 0
	for k in t.keys():
		n += int(t[k])
	return maxi(1, n)


func hybrid_count() -> int:
	var st := _st()
	if st.is_empty():
		return 0
	return (st["hybrids"] as Dictionary).size()


# The most recent find, as {key, cat, label, line, at} — {} if nothing yet.
func newest() -> Dictionary:
	var ordered := _ordered_leaves()
	if ordered.is_empty():
		return {}
	return ordered[ordered.size() - 1] as Dictionary


func journal_node() -> ProcNode:
	return _tree


# =============================================================================
# THE SHARED MULTIPLIER FORMULA  (DYNAMICS §2.1 — every query guarded)
# =============================================================================
func _mult(key: String, place_id: String) -> float:
	var m := 1.0
	var s := _sib("SeasonsEvents")
	if s != null and s.has_method("modifier"):
		m *= float(s.call("modifier", key))
	var r := _sib("Rituals")
	if r != null and r.has_method("blessing") and key != "offline":
		m *= float(r.call("blessing", key))
	if place_id != "":
		var nu := _sib("Nurture")
		if nu != null and nu.has_method("care_mult"):
			m *= float(nu.call("care_mult", place_id, key))
		var cl := _sib("CreatureLife")
		if cl != null:
			if cl.has_method("job_mult"):
				m *= float(cl.call("job_mult", place_id, key))
			if cl.has_method("bond_mult"):
				m *= float(cl.call("bond_mult", place_id, key))
		m *= variant_mult(place_id, key)
	if key == "luck":
		m *= _lightwell_mult(place_id)
		m *= _meteor_luck()
	return clampf(m, FLOOR, float(CAP.get(key, 1.60)))


# Lightwell glass placed near a thing lifts its variant roll (DYNAMICS §5.1).
func _lightwell_mult(place_id: String) -> float:
	var here := Vector2.ZERO
	var have_point := false
	if place_id != "":
		var rec := _record(place_id)
		if not rec.is_empty() and _node_of(rec) != null:
			here = (_node_of(rec) as Node2D).position
			have_point = true
	for item in _records():
		var r: Dictionary = item
		var sp := String((r.get("entry", {}) as Dictionary).get("species", ""))
		if not (sp.begins_with("lightwell") or sp == "lightwell_glass"):
			continue
		if not have_point:
			return LIGHTWELL_BONUS
		var n := _node_of(r)
		if n != null and (n as Node2D).position.distance_to(here) <= LIGHTWELL_RANGE:
			return LIGHTWELL_BONUS
	return 1.0


# Caught meteors bank a little luck as well as pity credit.
func _meteor_luck() -> float:
	var st := _st()
	if st.is_empty():
		return 1.0
	var credits := int((st["pity"] as Dictionary).get("meteor", 0))
	return clampf(1.0 + 0.04 * float(credits), 1.0, 1.4)


# =============================================================================
# TICK
# =============================================================================
func _process(delta: float) -> void:
	if not _booted or typeof(Game) != TYPE_OBJECT or not Game.booted:
		return
	_acc += delta
	if _acc < TICK:
		return
	var dt := _acc
	_acc = 0.0
	_rec_at = -999.0                                # one fresh record scan per tick
	_sync_placements()
	_tick_variants()
	_tick_pollen(dt)
	_tick_eggs(dt)
	_tick_weather(dt)
	_tick_journal(dt)
	_tick_insight(dt)


# Detect placements/removals. The `placed`/`removed` relays (§9.2) make this
# instant; without them this poll still catches everything within one tick.
func _sync_placements() -> void:
	var live: Dictionary = {}
	for item in _records():
		var r: Dictionary = item
		var pid := String(r.get("id", ""))
		if pid != "":
			live[pid] = true
	# removals FIRST, so a thing uprooted and replanted in the same breath finds its
	# own tier waiting in `carry` instead of being rolled again
	for gone in _known.keys():
		var gid := String(gone)
		if not live.has(gid):
			_on_removed(gid)
			_known.erase(gid)
	for item2 in _records():
		var r2: Dictionary = item2
		var pid2 := String(r2.get("id", ""))
		if pid2 == "" or _known.has(pid2):
			continue
		_known[pid2] = _sig(r2.get("entry", {}) as Dictionary)
		_on_placed(r2)


# ---- variants upkeep: keep grow-rates honest and auras attached -------------
func _tick_variants() -> void:
	var st := _st()
	if st.is_empty():
		return
	var variants: Dictionary = st["variants"]
	for item in _records():
		var r: Dictionary = item
		var pid := String(r.get("id", ""))
		var node := _node_of(r)
		if pid == "" or node == null:
			continue
		_apply_grow(pid, node, bool(r.get("minted", false)))
		var tier := String(variants.get(pid, "common"))
		if tier == "radiant" or tier == "ancient":
			_ensure_aura(pid, node, tier, float(r.get("footprint", 32.0)))
	# drop auras whose thing is gone
	for pid in _auras.keys():
		var n = _auras[pid]
		if not is_instance_valid(n):
			_auras.erase(pid)


func _apply_grow(pid: String, node: ProcNode, minted: bool) -> void:
	if minted:
		return
	if typeof(Growth) == TYPE_OBJECT and Growth.has_method("is_frozen"):
		if bool(Growth.call("is_frozen", pid)):
			return
	var base := 0.0
	if node.has_meta("dyn_base_grow"):
		base = float(node.get_meta("dyn_base_grow"))
	if base <= 0.0:
		if node.grow_rate <= 0.0:
			return                                   # frozen keepsake — leave it still
		base = node.grow_rate
		node.set_meta("dyn_base_grow", base)
	# recomputed from the base every time, never accumulated (DYNAMICS §7.2)
	node.grow_rate = base * _mult("grow", pid)


# =============================================================================
# PLACEMENT → a variant, and a leaf for a species never seen before
# =============================================================================
func _on_placed(record: Dictionary) -> void:
	var pid := String(record.get("id", ""))
	if pid == "" or pid == "journal_tree":
		return
	var entry: Dictionary = record.get("entry", {})
	var kind := String(entry.get("kind", "plant"))
	var sp := String(entry.get("species", ""))
	var st := _st()
	if st.is_empty():
		return
	# a species' first appearance is a find in its own right (buildings are not
	# growing things and have no bough on the journal tree)
	if sp != "" and kind != "building":
		if kind == "creature":
			discover("creature:" + sp, {})
		else:
			discover("species:" + sp, {})
	# a crossing planted for the first time earns its own leaf
	var hyb := String(entry.get("hybrid", ""))
	if hyb != "":
		(st["hybrids"] as Dictionary)[hyb] = true
		discover("hybrid:" + hyb, {})
	# exactly one variant tier per placed thing, rolled once
	var variants: Dictionary = st["variants"]
	if not variants.has(pid):
		var tier := _inherit_or_roll(pid, entry)
		variants[pid] = tier
		var stats: Dictionary = st["stats"]
		stats["placements"] = int(stats.get("placements", 0)) + 1
		if tier != "common":
			discover("variant:" + tier, {"tier": tier})
			emit_signal("dyn_event", "variant", {"place_id": pid, "tier": tier})
	_apply_variant(record, String(variants.get(pid, "common")))


# A thing you merely MOVED keeps the form it had — rarity is identity, not a reroll.
func _inherit_or_roll(pid: String, entry: Dictionary) -> String:
	var st := _st()
	var carry: Dictionary = st["carry"]
	var sig := _sig(entry)
	if carry.has(sig):
		var list: Array = carry[sig]
		if not list.is_empty():
			var tier := String(list.pop_back())
			if list.is_empty():
				carry.erase(sig)
			return tier
	return _roll_variant(pid)


func _roll_variant(pid: String) -> String:
	if _roll("rare:" + pid, RARE_CHANCE, "rare", PITY_RARE):
		if _rand("anc:" + pid) < ANCIENT_SHARE:
			return "ancient"
		return "radiant"
	if _roll("lush:" + pid, LUSH_CHANCE, "place", PITY_PLACE):
		return "lush"
	return "common"


# Variants are applied by RE-ADAPTING the node plus our own overlay — the art
# modules are never edited (DYNAMICS §6.3).
func _apply_variant(record: Dictionary, tier: String) -> void:
	var node := _node_of(record)
	if node == null or tier == "common":
		return
	var pid := String(record.get("id", ""))
	var fr := float(record.get("footprint", 32.0))
	var ctx: Dictionary = {}
	if _space != null and _space.has_method("build_context"):
		ctx = _space.call("build_context", (node as Node2D).position, fr)
	ctx = _normalise_ctx(ctx)
	ctx["variant"] = tier
	ctx["variant_scale"] = float(VARIANT_SCALE.get(tier, 1.0))
	ctx["variant_tint"] = VARIANT_TINT.get(tier, Color(1, 1, 1, 0))
	ItemCatalog.adapt(node, ctx)
	node.scale = Vector2.ONE * float(VARIANT_SCALE.get(tier, 1.0))
	# until an art module reads variant_tint, carry the morph in modulate — gently
	var w := float(VARIANT_TINT_W.get(tier, 0.0))
	if w > 0.0:
		var tint: Color = VARIANT_TINT.get(tier, Color(1, 1, 1, 0))
		var base := Color(1, 1, 1, node.modulate.a)
		node.modulate = base.lerp(Color(tint.r, tint.g, tint.b, node.modulate.a), w)
	if tier == "radiant" or tier == "ancient":
		_ensure_aura(pid, node, tier, fr)


# WorldSpace.build_context() hands `neighbours` back as an ARRAY of neighbour
# descriptions, but ProcPlants / ProcTrees / ProcFungiCrystals all read it as an
# int count (`int(ctx["neighbours"])`), which throws on an Array. That mismatch is
# pre-existing and both files are off-limits to this layer, so we hand our own
# re-adapt a context those modules can actually read, keeping the detail under a
# second key for anything that wants it.
func _normalise_ctx(ctx: Dictionary) -> Dictionary:
	var out := ctx.duplicate(true)
	var nb = out.get("neighbours", 0)
	if nb is Array:
		out["neighbour_list"] = nb
		out["neighbours"] = (nb as Array).size()
	return out


func _ensure_aura(pid: String, node: ProcNode, tier: String, fr: float) -> void:
	if _auras.has(pid) and is_instance_valid(_auras[pid]):
		return
	var aura := DiscoveryArt.make_variant_aura(world_seed, "aura:" + pid, tier, maxf(18.0, fr))
	node.add_child(aura)
	_auras[pid] = aura


func _on_removed(pid: String) -> void:
	var st := _st()
	if st.is_empty():
		return
	var variants: Dictionary = st["variants"]
	var tier := String(variants.get(pid, "common"))
	variants.erase(pid)
	if _auras.has(pid):
		var a = _auras[pid]
		if is_instance_valid(a):
			a.queue_free()
		_auras.erase(pid)
	if _marks.has(pid):
		var m = _marks[pid]
		if is_instance_valid(m):
			m.queue_free()
		_marks.erase(pid)
	if tier == "common":
		return
	# park the tier against this entry's signature so replanting restores it
	var sig := String(_known.get(pid, ""))
	if sig == "":
		return
	var carry: Dictionary = st["carry"]
	if not (carry.get(sig) is Array):
		carry[sig] = []
	var list: Array = carry[sig]
	list.append(tier)
	while list.size() > 6:
		list.pop_front()


func _sig(entry: Dictionary) -> String:
	return "%s|%s|%s" % [String(entry.get("kind", "")), String(entry.get("species", "")),
		String(entry.get("hybrid", ""))]


# =============================================================================
# CROSS-POLLINATION  (DYNAMICS §6.3)
# =============================================================================
func _tick_pollen(dt: float) -> void:
	var st := _st()
	if st.is_empty():
		return
	var pollen: Dictionary = st["pollen"]
	var now := _now()
	var mature := _mature_flora()
	var seen: Dictionary = {}
	var ranked: Array = []
	var n := mature.size()
	for i in range(n):
		var a: Dictionary = mature[i]
		for k in range(i + 1, n):
			var b: Dictionary = mature[k]
			if String(a["species"]) == String(b["species"]):
				continue
			var d: float = (a["pos"] as Vector2).distance_to(b["pos"] as Vector2)
			if d > POLLEN_RANGE:
				continue
			var pkey := _pair_key(String(a["pid"]), String(b["pid"]))
			seen[pkey] = {"a": a, "b": b, "d": d}
			ranked.append({"key": pkey, "d": d})
	ranked.sort_custom(func(x, y): return float(x["d"]) < float(y["d"]))
	# prune pairs that have drifted apart (their dwell is kept while a cooldown runs)
	for okey in pollen.keys():
		var oid := String(okey)
		var e: Dictionary = pollen[oid]
		if seen.has(oid):
			continue
		if float(e.get("cd", 0.0)) > now:
			continue
		pollen.erase(oid)
		_drop_thread(oid)
	var tracked := 0
	for item in ranked:
		var row: Dictionary = item
		var rkey := String(row["key"])
		if tracked >= MAX_PAIRS:
			break
		var pair: Dictionary = seen[rkey]
		var a2: Dictionary = pair["a"]
		var b2: Dictionary = pair["b"]
		if not (pollen.get(rkey) is Dictionary):
			pollen[rkey] = {"dwell": 0.0, "at": 0.0, "cd": 0.0}
		var e2: Dictionary = pollen[rkey]
		tracked += 1
		if float(e2.get("cd", 0.0)) > now:
			continue
		if not (_watered(String(a2["pid"])) and _watered(String(b2["pid"]))):
			continue
		var rate := luck_mult() * _pollen_season()
		e2["dwell"] = float(e2.get("dwell", 0.0)) + dt * rate
		var dwell := float(e2["dwell"])
		_show_thread(rkey, a2, b2, clampf(dwell / POLLEN_DWELL, 0.0, 1.0), tracked)
		if dwell < POLLEN_DWELL:
			continue
		if now - float(e2.get("at", 0.0)) < POLLEN_ATTEMPT_GAP:
			continue
		e2["at"] = now
		var forced: bool = dwell >= POLLEN_PITY
		if not (forced or _rand("pol:" + rkey) < POLLEN_CHANCE):
			continue
		_make_hybrid(a2, b2, rkey)


func _pollen_season() -> float:
	var s := _sib("SeasonsEvents")
	var m := 1.0
	if s != null:
		if s.has_method("season_id") and String(s.call("season_id")) == "greenrise":
			m *= 1.5
		if s.has_method("event_kind"):
			var ek := String(s.call("event_kind"))
			if ek == "bloomtide" or ek == "bloomtide_swell":
				m *= 1.5
	elif _weather() == "rain":
		m *= 1.25
	return m


func _watered(place_id: String) -> bool:
	var nu := _sib("Nurture")
	if nu != null and nu.has_method("is_watered"):
		return bool(nu.call("is_watered", place_id))
	# no Nurture in this build: rain still counts, and otherwise the island is
	# assumed tended — the system must never be unreachable.
	return true


func _mature_flora() -> Array:
	var out: Array = []
	for item in _records():
		var r: Dictionary = item
		if bool(r.get("minted", false)):
			continue
		var entry: Dictionary = r.get("entry", {})
		var kind := String(entry.get("kind", ""))
		if kind != "plant" and kind != "tree" and kind != "fungus":
			continue
		var node := _node_of(r)
		if node == null or node.growth < POLLEN_MATURE:
			continue
		var sp := String(entry.get("species", ""))
		if sp == "":
			continue
		out.append({"pid": String(r.get("id", "")), "species": sp, "kind": kind,
			"pos": (node as Node2D).position, "rec": r})
		if out.size() >= 24:                         # perf guard: 24² / 2 comparisons
			break
	return out


func _pair_key(a: String, b: String) -> String:
	var pair: Array = [a, b]
	pair.sort()
	return "%s|%s" % [String(pair[0]), String(pair[1])]


func _make_hybrid(a: Dictionary, b: Dictionary, key: String) -> void:
	var st := _st()
	var sa := String(a["species"])
	var sb := String(b["species"])
	var species := ItemCatalog.hybrid_species(sa, sb)
	var def := ItemCatalog.hybrid_def(species, world_seed)
	var item_key := "seed:" + species
	_grant(item_key, ItemCatalog.hybrid_entry(species, world_seed, 1), 1)
	(st["hybrids"] as Dictionary)[species] = true
	var stats: Dictionary = st["stats"]
	stats["hybrids"] = int(stats.get("hybrids", 0)) + 1
	# the visible moment: pollen crosses the gap, then a flourish of petals
	var from_p: Vector2 = (a["pos"] as Vector2) + Vector2(0, -26.0)
	var to_p: Vector2 = (b["pos"] as Vector2) + Vector2(0, -26.0)
	_spawn_fx(DiscoveryArt.make_pollen_mote(world_seed, "pm:" + key, from_p, to_p, {"life": 3.0}))
	_spawn_fx(DiscoveryArt.make_hybrid_bloom(world_seed, "hb:" + key, 74.0), to_p)
	_world_fx(to_p, "sparkle")
	# a crossing teaches the island one making, if there is a Chains to teach
	_teach_from_hybrid(species)
	var fresh := discover("hybrid:" + species, {"label": String(def.get("label", "Crossing")),
		"line": String(def.get("line", "")), "cat": "hybrids"})
	if not fresh:
		_say("%s again — its seed is in your basket." % String(def.get("label", "A crossing")))
	emit_signal("dyn_event", "hybrid", {"species": species, "parents": [sa, sb],
		"item_key": item_key})
	var e: Dictionary = (st["pollen"] as Dictionary)[key]
	e["dwell"] = 0.0
	e["cd"] = _now() + PAIR_COOLDOWN
	_drop_thread(key)


func _teach_from_hybrid(species: String) -> void:
	var ch := _sib("Chains")
	if ch == null or not (ch.has_method("recipes") and ch.has_method("learn") and ch.has_method("knows")):
		return
	var list = ch.call("recipes")
	if not (list is Array) or (list as Array).is_empty():
		return
	var arr: Array = list
	var unknown: Array = []
	for item in arr:
		var rid := String(item)
		if not bool(ch.call("knows", rid)):
			unknown.append(rid)
	if unknown.is_empty():
		return
	var i := int(_rand("teach:" + species) * float(unknown.size()))
	var pick := String(unknown[clampi(i, 0, unknown.size() - 1)])
	ch.call("learn", pick)


# ---- the courting arc (the only readout cross-pollination gets) -------------
func _show_thread(key: String, a: Dictionary, b: Dictionary, strength: float, rank: int) -> void:
	if strength < 0.22 or rank > MAX_THREADS:
		if strength < 0.22:
			_drop_thread(key)
		return
	var from_p: Vector2 = (a["pos"] as Vector2) + Vector2(0, -24.0)
	var to_p: Vector2 = (b["pos"] as Vector2) + Vector2(0, -24.0)
	if _threads.has(key) and is_instance_valid(_threads[key]):
		var th = _threads[key]
		th.call("set_ends", from_p, to_p)
		th.call("set_strength", strength)
		return
	if _threads.size() >= MAX_THREADS:
		return
	var node := DiscoveryArt.make_pollen_thread(world_seed, "th:" + key, from_p, to_p)
	_fx.add_child(node)
	node.call("set_strength", strength)
	_threads[key] = node


func _drop_thread(key: String) -> void:
	if not _threads.has(key):
		return
	var th = _threads[key]
	if is_instance_valid(th) and th.has_method("fade_out"):
		th.call("fade_out", 0.5)
	elif is_instance_valid(th):
		th.queue_free()
	_threads.erase(key)


# =============================================================================
# BREEDING  (DYNAMICS §6.3)
# =============================================================================
func _tick_eggs(dt: float) -> void:
	var st := _st()
	if st.is_empty():
		return
	var eggs: Dictionary = st["eggs"]
	var now := _now()
	var pairs := _breeding_pairs()
	var seen: Dictionary = {}
	for item in pairs:
		var p: Dictionary = item
		seen[String(p["key"])] = p
	for ekey in eggs.keys():
		var eid := String(ekey)
		var e: Dictionary = eggs[eid]
		if seen.has(eid) or float(e.get("cd", 0.0)) > now:
			continue
		eggs.erase(eid)
		_drop_nest(eid)
	for item2 in pairs:
		var p2: Dictionary = item2
		var key2 := String(p2["key"])
		if not (eggs.get(key2) is Dictionary):
			eggs[key2] = {"dwell": 0.0, "at": 0.0, "cd": 0.0}
		var e2: Dictionary = eggs[key2]
		if float(e2.get("cd", 0.0)) > now:
			continue
		e2["dwell"] = float(e2.get("dwell", 0.0)) + dt * float(p2["rate"]) * _egg_season()
		var dwell := float(e2["dwell"])
		_show_nest(key2, p2["home"] as Vector2, clampf(dwell / EGG_DWELL, 0.0, 1.0))
		if dwell < EGG_DWELL:
			continue
		if now - float(e2.get("at", 0.0)) < POLLEN_ATTEMPT_GAP:
			continue
		e2["at"] = now
		var forced: bool = dwell >= EGG_PITY
		if not (forced or _rand("egg:" + key2) < 0.5):
			continue
		_make_egg(p2, key2)


func _egg_season() -> float:
	var s := _sib("SeasonsEvents")
	var m := 1.0
	if s != null:
		if s.has_method("season_id") and String(s.call("season_id")) == "greenrise":
			m *= 1.5
		if s.has_method("event_kind") and String(s.call("event_kind")) == "festival":
			m *= 2.0
	return m


# Two creatures who are friends (or, with no CreatureLife, simply two different
# species keeping company) near a full-grown home.
func _breeding_pairs() -> Array:
	var homes: Array = []
	var creatures: Array = []
	for item in _records():
		var r: Dictionary = item
		var entry: Dictionary = r.get("entry", {})
		var node := _node_of(r)
		if node == null:
			continue
		var kind := String(entry.get("kind", ""))
		if kind == "building":
			var bid := String(entry.get("building_id", ""))
			if bid == "blockling_homes" or bid.ends_with("homes"):
				if node.growth >= 0.85:
					homes.append((node as Node2D).position)
			continue
		if kind != "creature" or bool(r.get("minted", false)):
			continue
		creatures.append({"pid": String(r.get("id", "")), "species": String(entry.get("species", "")),
			"pos": (node as Node2D).position, "growth": float(node.growth)})
	if homes.is_empty() or creatures.size() < 2:
		return []
	if not _home_room():
		return []
	var cl := _sib("CreatureLife")
	var out: Array = []
	var n := creatures.size()
	for i in range(mini(n, 16)):
		var a: Dictionary = creatures[i]
		for k in range(i + 1, mini(n, 16)):
			var b: Dictionary = creatures[k]
			if String(a["species"]) == String(b["species"]):
				continue
			var mid: Vector2 = ((a["pos"] as Vector2) + (b["pos"] as Vector2)) * 0.5
			var home := _nearest(homes, mid)
			if home.distance_to(mid) > EGG_RANGE:
				continue
			var rate := 0.5                                   # no CreatureLife: half pace
			var ba := 0.5
			var bb := 0.5
			if cl != null and cl.has_method("bond"):
				ba = float(cl.call("bond", String(a["pid"])))
				bb = float(cl.call("bond", String(b["pid"])))
				if ba < BOND_FOND or bb < BOND_FOND:
					continue
				rate = 1.0
			elif float(a["growth"]) < 0.85 or float(b["growth"]) < 0.85:
				continue
			out.append({"key": _pair_key(String(a["pid"]), String(b["pid"])),
				"a": a, "b": b, "home": home, "rate": rate,
				"devoted": ba >= BOND_DEVOTED and bb >= BOND_DEVOTED})
	return out


func _home_room() -> bool:
	var cl := _sib("CreatureLife")
	if cl != null and cl.has_method("home_capacity"):
		return int(cl.call("home_capacity")) > 0
	# fallback: two kin per grown home
	var homes := 0
	var kin := 0
	for item in _records():
		var r: Dictionary = item
		var entry: Dictionary = r.get("entry", {})
		if String(entry.get("kind", "")) == "creature":
			kin += 1
		elif String(entry.get("building_id", "")).ends_with("homes"):
			homes += 1
	return kin < homes * 2 + 2


func _make_egg(pair: Dictionary, key: String) -> void:
	var st := _st()
	var a: Dictionary = pair["a"]
	var b: Dictionary = pair["b"]
	var species := _pick_egg_species(String(a["species"]), String(b["species"]),
		bool(pair.get("devoted", false)), key)
	if species == "":
		return
	var def: Dictionary = GameData.blocklings_by_id.get(species, {}) if typeof(GameData) == TYPE_OBJECT else {}
	var nm := String(def.get("name", species.capitalize()))
	var item_key := "egg:" + species
	_grant(item_key, {
		"count": 1, "kind": "creature", "species": species,
		"label": "%s (egg)" % nm, "growth": -1.0, "minted": false,
	}, 1)
	var stats: Dictionary = st["stats"]
	stats["eggs"] = int(stats.get("eggs", 0)) + 1
	var where: Vector2 = pair["home"] as Vector2
	_spawn_fx(DiscoveryArt.make_hybrid_bloom(world_seed, "eb:" + key, 56.0), where + Vector2(0, -18.0))
	_world_fx(where + Vector2(0, -18.0), "sparkle")
	var fresh := discover("creature:" + species, {"label": nm, "cat": "creatures",
		"line": String(def.get("desc", ""))})
	if not fresh:
		_say("An egg, left warm by the nest. Another %s is coming." % nm)
	else:
		_say("An egg no-one has seen before. The nest is warm.")
	emit_signal("dyn_event", "egg", {"species": species,
		"parents": [String(a["species"]), String(b["species"])], "item_key": item_key})
	var eggs: Dictionary = st["eggs"]
	if eggs.get(key) is Dictionary:
		var e: Dictionary = eggs[key]
		e["dwell"] = 0.0
		e["cd"] = _now() + EGG_COOLDOWN
	_drop_nest(key)


# 60% toward the parents' shape, 25% toward their profession, 15% free — climbing
# the rarity ladder at most one step, and only for a devoted pair.
func _pick_egg_species(sa: String, sb: String, devoted: bool, key: String) -> String:
	if typeof(GameData) != TYPE_OBJECT or GameData.blocklings.is_empty():
		return sa
	var da: Dictionary = GameData.blocklings_by_id.get(sa, {})
	var db: Dictionary = GameData.blocklings_by_id.get(sb, {})
	var roll := _rand("eggsp:" + key)
	var want_shape: Array = [String(da.get("shape", "")), String(db.get("shape", ""))]
	var want_prof: Array = [String(da.get("profession", "")), String(db.get("profession", ""))]
	var ladder := maxi(_rarity_rank(String(da.get("rarity", "common"))),
		_rarity_rank(String(db.get("rarity", "common"))))
	if devoted:
		ladder += 1
	var pool: Array = []
	for item in GameData.blocklings:
		var d: Dictionary = item
		var id := String(d.get("id", ""))
		if id == "":
			continue
		if _rarity_rank(String(d.get("rarity", "common"))) > ladder:
			continue
		var match_shape: bool = want_shape.has(String(d.get("shape", "")))
		var match_prof: bool = want_prof.has(String(d.get("profession", "")))
		if roll < 0.60:
			if match_shape:
				pool.append(id)
		elif roll < 0.85:
			if match_prof:
				pool.append(id)
		else:
			pool.append(id)
	if pool.is_empty():
		for item2 in GameData.blocklings:
			var d2: Dictionary = item2
			if _rarity_rank(String(d2.get("rarity", "common"))) <= ladder:
				pool.append(String(d2.get("id", "")))
	if pool.is_empty():
		return sa
	# prefer something the player has not met, so breeding widens the collection
	var fresh: Array = []
	for item3 in pool:
		var id3 := String(item3)
		if not is_found("creature:" + id3):
			fresh.append(id3)
	var use: Array = fresh if not fresh.is_empty() else pool
	var i := int(_rand("eggpick:" + key) * float(use.size()))
	return String(use[clampi(i, 0, use.size() - 1)])


func _rarity_rank(rarity: String) -> int:
	if typeof(GameData) != TYPE_OBJECT:
		return 0
	for i in range(GameData.rarities.size()):
		var d: Dictionary = GameData.rarities[i]
		if String(d.get("id", "")) == rarity:
			return i
	return 0


func _show_nest(key: String, where: Vector2, strength: float) -> void:
	if strength < 0.25:
		_drop_nest(key)
		return
	if _nests.has(key) and is_instance_valid(_nests[key]):
		var n = _nests[key]
		(n as Node2D).position = where
		n.call("set_strength", strength)
		return
	if _nests.size() >= 2:
		return
	var node := DiscoveryArt.make_nest_glow(world_seed, "nest:" + key, 54.0)
	node.position = where
	_fx.add_child(node)
	node.call("set_strength", strength)
	_nests[key] = node


func _drop_nest(key: String) -> void:
	if not _nests.has(key):
		return
	var n = _nests[key]
	if is_instance_valid(n):
		n.queue_free()
	_nests.erase(key)


# =============================================================================
# WEATHER-BORN RARITIES  (a storm leaves something, it never takes something)
# =============================================================================
func _tick_weather(dt: float) -> void:
	var st := _st()
	if st.is_empty():
		return
	var sm: Dictionary = st["storm"]
	var w := _weather()
	var now := _now()
	var patient: bool = (now - float(sm.get("last", 0.0))) > STORM_PITY
	var soaking: bool = (w == "storm") or (patient and (w == "rain" or w == "mist" or w == "overcast"))
	if soaking:
		sm["soak"] = float(sm.get("soak", 0.0)) + dt
	else:
		sm["soak"] = maxf(0.0, float(sm.get("soak", 0.0)) - dt * 0.25)
	if float(sm["soak"]) < STORM_SOAK:
		return
	if now - float(sm.get("last", 0.0)) < STORM_COOLDOWN:
		return
	sm["soak"] = 0.0
	sm["last"] = now
	_storm_touch(w)


func _weather() -> String:
	var s := _sib("SeasonsEvents")
	if s != null and s.has_method("weather"):
		return String(s.call("weather"))
	if _sky == null:
		_sky = _find_sky()
	if _sky != null:
		var v = _sky.get("weather")
		if v != null:
			return String(v)
	return "clear"


# The most exposed living thing on the island comes out of the weather changed.
func _storm_touch(weather: String) -> void:
	var st := _st()
	var best: Dictionary = {}
	var best_x := -1.0
	for item in _mature_flora():
		var c: Dictionary = item
		var pos: Vector2 = c["pos"]
		var ex: float = absf(pos.x - _ground_origin().x)
		var tier := variant_tier(String(c["pid"]))
		if tier == "ancient":
			continue                                   # nothing to add to an ancient
		if ex > best_x:
			best_x = ex
			best = c
	if best.is_empty():
		return
	var pid := String(best["pid"])
	var rec: Dictionary = best["rec"]
	var was := variant_tier(pid)
	var now_tier := "lush" if was == "common" else "radiant"
	(st["variants"] as Dictionary)[pid] = now_tier
	_apply_variant(rec, now_tier)
	# the pale crackle it keeps
	var node := _node_of(rec)
	if node != null and not (_marks.has(pid) and is_instance_valid(_marks[pid])):
		var mark := DiscoveryArt.make_storm_mark(world_seed, "sm:" + pid,
			maxf(20.0, float(rec.get("footprint", 32.0))))
		node.add_child(mark)
		_marks[pid] = mark
	# and the seed it sheds
	var sp := String(best["species"])
	var kind := String(best["kind"])
	var label := "Storm-touched %s" % sp.capitalize()
	_grant("seed:storm:" + sp, {
		"count": 1, "kind": kind, "species": sp, "label": label,
		"growth": -1.0, "minted": false, "stormtouched": true,
	}, 1)
	var stats: Dictionary = st["stats"]
	stats["storms"] = int(stats.get("storms", 0)) + 1
	discover("variant:" + now_tier, {"tier": now_tier})
	discover("weather:" + weather, {"cat": "events", "label": _weather_label(weather),
		"line": "the sky left something behind instead of taking it"})
	emit_signal("dyn_event", "variant", {"place_id": pid, "tier": now_tier})
	_say("Where the wind bit hardest, something came out changed.")


func _weather_label(w: String) -> String:
	match w:
		"storm": return "A storm"
		"mist": return "A long mist"
		"rain": return "Steady rain"
		"overcast": return "A grey day"
		_: return "A clear sky"


# =============================================================================
# THE JOURNAL TREE
# =============================================================================
func _plant_journal(silent: bool = false) -> void:
	if _tree != null and is_instance_valid(_tree):
		return
	var st := _st()
	if st.is_empty():
		return
	var j: Dictionary = st["journal"]
	var tx := float(j.get("tx", 0.0))
	if not bool(j.get("planted", false)) or absf(tx) < 0.001:
		tx = _choose_journal_tx()
		j["tx"] = tx
	j["planted"] = true
	_tree = DiscoveryArt.make_journal_tree(world_seed, "journal", {
		"progress": maxf(0.03, journal_progress()),
		"twin": bool(j.get("twin", false)),
	})
	_tree.position = _ground_point(tx)
	_tree.z_index = 1
	add_child(_tree)
	if not silent:
		# it unfurls from the soil up to whatever the collection currently is —
		# never to "full", because full is a thing you have to go and find.
		_tree.set_growth(0.02)
		_tree.call("set_progress", maxf(0.03, journal_progress()))
		_world_fx(_tree.position, "puff")
		_say("A second tree is growing by the Heart. It keeps what you find.")


# Seeded spot, nudged outward past anything already standing there.
func _choose_journal_tx() -> float:
	var want: float = JOURNAL_TX + Proc.rangef(world_seed, "journal:tx", -JOURNAL_JITTER, JOURNAL_JITTER)
	var origin_x := _ground_origin().x
	for attempt in range(9):
		var probe: float = want - float(attempt) * 94.0
		var clear := true
		for item in _records():
			var r: Dictionary = item
			var node := _node_of(r)
			if node == null:
				continue
			var tx: float = (node as Node2D).position.x - origin_x
			if absf(tx - probe) < JOURNAL_CLEAR + float(r.get("footprint", 32.0)):
				clear = false
				break
		if clear:
			return probe
	return want


func _tick_journal(_dt: float) -> void:
	var st := _st()
	if st.is_empty():
		return
	var j: Dictionary = st["journal"]
	if not bool(j.get("planted", false)):
		return
	if _tree == null or not is_instance_valid(_tree):
		_plant_journal(true)
		return
	# the second trunk the seed_library arc awards
	if bool(j.get("twin", false)) and not bool(_tree.get("twin")):
		_tree.set("twin", true)
		_refresh_journal(false)
		return
	_tree.call("set_progress", maxf(0.03, journal_progress()))
	if float(j.get("newest", 0.0)) > 0.0 and _now() - float(j["newest"]) > GLOW_SECONDS:
		j["newest"] = 0.0
		_tree.call("clear_glow")


func _refresh_journal(fresh_leaf: bool) -> void:
	var st := _st()
	if st.is_empty():
		return
	var j: Dictionary = st["journal"]
	if found_count() <= 0:
		return
	if not bool(j.get("planted", false)):
		_plant_journal(false)
	if _tree == null or not is_instance_valid(_tree):
		return
	var leaves := _ordered_leaves()
	_tree.call("set_content", leaves, j.get("blossoms", []) as Array, leaves.size() - 1)
	_tree.call("set_progress", maxf(0.03, journal_progress()))
	if not fresh_leaf:
		return
	j["newest"] = _now()
	_tree.call("pop_newest")
	_world_fx((_tree as Node2D).position + Vector2(0, -60.0), "sparkle")
	emit_signal("dyn_event", "journal_grew", {"leaves": leaves.size(), "total": total_count()})
	# every eighth leaf the tree lets a seed fall — a gift, never a chore
	var gifts := int(j.get("gifts", 0))
	if leaves.size() / GIFT_EVERY > gifts:
		j["gifts"] = leaves.size() / GIFT_EVERY
		_journal_gift()


# A seed of something you have met, from the tree that remembers it.
func _journal_gift() -> void:
	var pool: Array = []
	var st := _st()
	for k in (st["found"] as Dictionary).keys():
		var key := String(k)
		if key.begins_with("species:"):
			pool.append(key.substr(8))
	if pool.is_empty():
		return
	var i := int(_rand("gift") * float(pool.size()))
	var sp := String(pool[clampi(i, 0, pool.size() - 1)])
	var kind := ItemCatalog.species_kind(sp)
	_grant("seed:%s:%s" % [kind, sp], {
		"count": 1, "kind": kind, "species": sp, "label": sp.capitalize(),
		"growth": -1.0, "minted": false,
	}, 1)
	if _tree != null and is_instance_valid(_tree):
		_world_fx((_tree as Node2D).position + Vector2(0, -40.0), "sparkle")
	_say("The journal tree lets something fall — a %s seed." % sp.capitalize())


# Every leaf, oldest first, ready for the tree to hang.
func _ordered_leaves() -> Array:
	var st := _st()
	if st.is_empty():
		return []
	var found: Dictionary = st["found"]
	var keys: Array = found.keys()
	keys.sort_custom(func(a, b):
		var da: Dictionary = found[a]
		var db: Dictionary = found[b]
		var ta := float(da.get("at", 0.0))
		var tb := float(db.get("at", 0.0))
		if absf(ta - tb) > 0.001:
			return ta < tb
		return String(a) < String(b))
	var out: Array = []
	for k in keys:
		var key := String(k)
		var d: Dictionary = found[key]
		out.append({
			"key": key, "cat": String(d.get("cat", _cat_of(key, {}))),
			"label": String(d.get("label", _label_for(key, {}))),
			"line": String(d.get("line", "")), "tier": String(d.get("tier", "")),
			"at": float(d.get("at", 0.0)),
		})
	return out


# =============================================================================
# DISCOVERY BOOKKEEPING
# =============================================================================
func _record_found(key: String, meta: Dictionary) -> bool:
	var st := _st()
	if st.is_empty():
		return false
	var found: Dictionary = st["found"]
	if found.has(key):
		var cur: Dictionary = found[key]
		cur["count"] = int(cur.get("count", 1)) + 1
		return false
	found[key] = {
		"at": _now(), "count": 1,
		"cat": _cat_of(key, meta),
		"tier": String(meta.get("tier", "")),
		"label": _label_for(key, meta),
		"line": _line_for(key, meta),
	}
	return true


func _cat_of(key: String, meta: Dictionary) -> String:
	if meta.has("cat"):
		return String(meta["cat"])
	if key.begins_with("species:"):
		return "species"
	if key.begins_with("creature:"):
		return "creatures"
	if key.begins_with("hybrid:"):
		return "hybrids"
	if key.begins_with("variant:"):
		return "variants"
	if key.begins_with("recipe:"):
		return "recipes"
	if key.begins_with("rite:"):
		return "rites"
	if key.begins_with("event:") or key.begins_with("season:") or key.begins_with("weather:"):
		return "events"
	if key.begins_with("ground:") or key.begins_with("puzzle:"):
		return "grounds"
	return "species"


func _suffix(key: String) -> String:
	var i := key.find(":")
	if i < 0:
		return key
	return key.substr(i + 1)


func _label_for(key: String, meta: Dictionary) -> String:
	if meta.has("label") and String(meta["label"]) != "":
		return String(meta["label"])
	var tail := _suffix(key)
	if key.begins_with("hybrid:"):
		return ItemCatalog.hybrid_label(tail, world_seed)
	if key.begins_with("variant:"):
		return ItemCatalog.variant_label(tail)
	if key.begins_with("creature:"):
		if typeof(GameData) == TYPE_OBJECT:
			var d: Dictionary = GameData.blocklings_by_id.get(tail, {})
			if not d.is_empty():
				return String(d.get("name", tail.capitalize()))
		return tail.capitalize()
	return tail.capitalize().replace("_", " ")


func _line_for(key: String, meta: Dictionary) -> String:
	if meta.has("line") and String(meta["line"]) != "":
		return String(meta["line"])
	var tail := _suffix(key)
	if key.begins_with("hybrid:"):
		return String(ItemCatalog.hybrid_def(tail, world_seed).get("line", ""))
	if key.begins_with("variant:"):
		return ItemCatalog.variant_line(tail)
	if key.begins_with("creature:") and typeof(GameData) == TYPE_OBJECT:
		var d: Dictionary = GameData.blocklings_by_id.get(tail, {})
		if not d.is_empty():
			return String(d.get("desc", ""))
	if key.begins_with("species:"):
		return "it grows here now, and seems to like it"
	if key.begins_with("recipe:"):
		return "a making the island taught you"
	if key.begins_with("rite:"):
		return "a rite performed, and remembered"
	if key.begins_with("ground:"):
		return "ground that was sleeping, and woke"
	return "something new"


# Per-category denominators, all computed from live data (DYNAMICS §6.3).
func _totals() -> Dictionary:
	var now := _now()
	if not _tot_cache.is_empty() and now - _tot_at < 60.0:
		return _tot_cache
	_tot_at = now
	var species := ItemCatalog.species_pool().size()
	var creatures := GameData.blocklings.size() if typeof(GameData) == TYPE_OBJECT else 1
	var recipes := 0
	var ch := _sib("Chains")
	if ch != null and ch.has_method("recipes"):
		var l = ch.call("recipes")
		if l is Array:
			recipes = (l as Array).size()
	var grounds := 3
	if _puzzles != null and _puzzles.has_method("total_count"):
		grounds = maxi(1, int(_puzzles.call("total_count")))
	_tot_cache = {
		"species": maxi(1, species),
		"creatures": maxi(1, creatures),
		"hybrids": maxi(1, ItemCatalog.hybrid_count()),
		"variants": 3,                               # lush / radiant / ancient
		"recipes": recipes,
		"rites": 9,
		"events": 10,                                # 6 event kinds + 4 seasons
		"grounds": grounds,
	}
	return _tot_cache


# =============================================================================
# GESTURES
# =============================================================================
# One extra verb, and only on a thing that has earned it.
func extra_actions(record: Dictionary) -> Array:
	var out: Array = []
	var pid := String(record.get("id", ""))
	if pid == "":
		return out
	if variant_tier(pid) != "common":
		out.append("admire")
	return out


func handle_action(action: String, record: Dictionary) -> bool:
	if action != "admire":
		return false
	var pid := String(record.get("id", ""))
	if pid == "":
		return false
	var tier := variant_tier(pid)
	if tier == "common":
		return false                                 # let another system own the verb
	var entry: Dictionary = record.get("entry", {})
	var label := ItemCatalog.display_label(entry)
	_say("%s — %s." % [label, ItemCatalog.variant_line(tier)], true)
	var node := _node_of(record)
	if node != null:
		_world_fx((node as Node2D).position + Vector2(0, -float(record.get("footprint", 30.0))), "sparkle")
	# standing and looking at a rare thing nudges the next find a little closer
	var st := _st()
	if not st.is_empty():
		var admired: Dictionary = st["admired"]
		if _now() - float(admired.get(pid, 0.0)) > 2.0 * 3600.0:
			admired[pid] = _now()
			var pity: Dictionary = st["pity"]
			pity["place"] = int(pity.get("place", 0)) + 1
	return true


# The Journal Tree is read by TOUCHING it — trunk for the count, a leaf for the
# find, a blossom for the arc. There is no page, no grid and no list.
func handle_tap(_screen_pos: Vector2, world_pos: Vector2) -> bool:
	if _tree == null or not is_instance_valid(_tree):
		return false
	var local: Vector2 = world_pos - (_tree as Node2D).position
	var rect: Rect2 = _tree.call("canopy_rect")
	if not rect.has_point(local):
		return false
	var blossom: Dictionary = _tree.call("blossom_at", local, 30.0)
	if not blossom.is_empty():
		var bl := String(blossom.get("line", ""))
		var bn := String(blossom.get("label", "An arc"))
		_say(bn if bl == "" else "%s — %s." % [bn, bl], true)
		return true
	var leaf: Dictionary = _tree.call("leaf_at", local, 28.0)
	if not leaf.is_empty():
		var ln := String(leaf.get("line", ""))
		var lb := String(leaf.get("label", "Something"))
		_say(lb if ln == "" else "%s — %s." % [lb, ln], true)
		return true
	_say(_trunk_line(), true)
	return true


func _trunk_line() -> String:
	var n := found_count()
	if n <= 0:
		return "Bare branches, waiting for a first find."
	var word := _spell(n)
	var nw := newest()
	var tail := ""
	if not nw.is_empty():
		tail = " The newest is %s." % String(nw.get("label", "something"))
	var p := journal_progress()
	var middle := "and the branches still reaching"
	if p > 0.85:
		middle = "and barely room for another"
	elif p > 0.55:
		middle = "and the crown is filling in"
	elif p < 0.12:
		middle = "and so much ground still unwalked"
	return "%s %s, %s.%s" % [_upper_first(word), "leaf" if n == 1 else "leaves", middle, tail]


# capitalize() would turn "twenty-five" into "Twenty Five" — we only want the first
# letter raised, so the spelled numbers stay hyphenated and human.
func _upper_first(s: String) -> String:
	if s == "":
		return s
	return s.substr(0, 1).to_upper() + s.substr(1)


func _spell(n: int) -> String:
	if n < 0:
		return "no"
	if n < _ONES.size():
		return _ONES[n]
	if n < 100:
		var tens := String(_TENS[int(n / 10)])
		if n % 10 == 0:
			return tens
		return "%s-%s" % [tens, _ONES[n % 10]]
	return str(n)


# =============================================================================
# INBOUND EVENTS  (DYNAMICS §4.3)
# =============================================================================
func notify(kind: String, payload: Dictionary) -> void:
	match kind:
		"placed":
			var rec: Dictionary = payload
			if payload.has("record") and payload["record"] is Dictionary:
				rec = payload["record"]
			var pid := String(rec.get("id", rec.get("place_id", "")))
			if pid != "":
				_known[pid] = _sig(rec.get("entry", {}) as Dictionary)
				_on_placed(rec)
		"removed":
			var pid2 := String(payload.get("place_id", ""))
			if pid2 != "":
				_on_removed(pid2)
				_known.erase(pid2)
		"friendship":
			_note_friendship(payload)
		"meteor_caught":
			var st := _st()
			if not st.is_empty():
				var pity: Dictionary = st["pity"]
				var n := maxi(1, int(payload.get("n", 1)))
				pity["rare"] = maxi(0, int(pity.get("rare", 0)) + n)
				pity["meteor"] = mini(10, int(pity.get("meteor", 0)) + n)
		"season_changed":
			var sid := String(payload.get("id", ""))
			if sid != "":
				discover("season:" + sid, {"cat": "events",
					"label": sid.capitalize(), "line": "a turn of the island's year"})
		"event_started":
			var ek := String(payload.get("kind", ""))
			if ek != "":
				discover("event:" + ek, {"cat": "events",
					"label": ek.capitalize().replace("_", " "),
					"line": "the sky did this, and you were there to see it"})
		"craft_done":
			var rid := String(payload.get("recipe", ""))
			if rid != "":
				discover("recipe:" + rid, {"cat": "recipes"})
		"rite_done":
			var rt := String(payload.get("rite", ""))
			if rt != "":
				discover("rite:" + rt, {"cat": "rites"})
		"arc_done":
			_add_blossom(String(payload.get("arc", "")), String(payload.get("blessing", "")))
		"puzzle_solved":
			var gid := String(payload.get("id", ""))
			if gid != "":
				discover("ground:" + gid, {"cat": "grounds"})
		"migration_settled":
			var msp := String(payload.get("species", ""))
			if msp != "":
				discover("creature:" + msp, {})
		"weather_changed":
			pass                                     # read live in _tick_weather


func _note_friendship(payload: Dictionary) -> void:
	var a := String(payload.get("a", ""))
	var b := String(payload.get("b", ""))
	if a == "" or b == "":
		return
	var st := _st()
	if st.is_empty():
		return
	var eggs: Dictionary = st["eggs"]
	var key := _pair_key(a, b)
	if not (eggs.get(key) is Dictionary):
		eggs[key] = {"dwell": 0.0, "at": 0.0, "cd": 0.0}
	var e: Dictionary = eggs[key]
	# friends start their nest a quarter of the way along — being friends matters
	e["dwell"] = maxf(float(e.get("dwell", 0.0)), EGG_DWELL * 0.25)


# A completed arc is a blossom on the bough it belongs to, forever.
func _add_blossom(arc: String, blessing: String) -> void:
	if arc == "":
		return
	var st := _st()
	if st.is_empty():
		return
	var j: Dictionary = st["journal"]
	var list: Array = j["blossoms"]
	for item in list:
		var d: Dictionary = item
		if String(d.get("arc", "")) == arc:
			return
	var cat := "rites"
	if arc == "seed_library":
		cat = "hybrids"
		j["twin"] = true                             # the second trunk this arc grows
	elif arc == "long_table":
		cat = "creatures"
	elif arc == "lantern_road":
		cat = "species"
	elif arc == "quiet_rain":
		cat = "events"
	elif arc == "deep_root":
		cat = "grounds"
	list.append({
		"arc": arc, "cat": cat,
		"label": arc.capitalize().replace("_", " "),
		"line": "an arc finished — the island keeps %s a little better now" % (
			blessing if blessing != "" else "itself"),
		"at": _now(),
	})
	_refresh_journal(true)
	_say("A blossom opens on the journal tree.")


# A scholar in the garden offers a HINT, never a free find (DYNAMICS §6.1).
func _tick_insight(_dt: float) -> void:
	var st := _st()
	if st.is_empty():
		return
	if _now() - float(st.get("insight", 0.0)) < INSIGHT_GAP:
		return
	var cl := _sib("CreatureLife")
	if cl == null or not cl.has_method("creatures"):
		return
	var list = cl.call("creatures")
	if not (list is Array):
		return
	var has_scholar := false
	for item in (list as Array):
		var d: Dictionary = item
		if String(d.get("job", "")) == "scholar":
			has_scholar = true
			break
	if not has_scholar:
		return
	st["insight"] = _now()
	var hint := _insight_hint()
	if hint != "":
		_say(hint)


# A poetic nudge toward something reachable but unseen.
func insight_hint() -> String:
	return _insight_hint()


func _insight_hint() -> String:
	var pool: Array = []
	for item in ItemCatalog.species_pool():
		var sp := String(item)
		if sp != "" and not is_found("species:" + sp):
			pool.append(sp)
	if not pool.is_empty():
		var i := int(_rand("hint") * float(pool.size()))
		var sp2 := String(pool[clampi(i, 0, pool.size() - 1)])
		var kind := ItemCatalog.species_kind(sp2)
		match kind:
			"tree": return "Someone has been reading. There is a tree this island has not grown yet."
			"fungus": return "Someone has been reading. Something soft grows where stone stays cool."
			"crystal": return "Someone has been reading. There is a light still asleep in the rock."
			"water": return "Someone has been reading. Still water would suit the low ground."
			_: return "Someone has been reading. A flower this island has never held would like a place."
	if hybrid_count() < ItemCatalog.hybrid_count():
		return "Someone has been reading. Two grown things of different kinds, standing close — that is how crossings begin."
	return "Someone has been reading, and smiling, and saying nothing."


# =============================================================================
# OFFLINE CATCH-UP  (DYNAMICS §2.3 — nothing is lost by being away)
# =============================================================================
func catch_up(elapsed: float) -> void:
	var st := _st()
	if st.is_empty() or elapsed <= 1.0:
		return
	var eff := _effective(elapsed)
	var now := _now()
	# courting and nesting continued while you were away — but at most one step
	var pollen: Dictionary = st["pollen"]
	for pkey in pollen.keys():
		var e: Dictionary = pollen[String(pkey)]
		if float(e.get("cd", 0.0)) > now:
			continue
		e["dwell"] = float(e.get("dwell", 0.0)) + minf(eff, POLLEN_DWELL)
	var eggs: Dictionary = st["eggs"]
	for ekey in eggs.keys():
		var e2: Dictionary = eggs[String(ekey)]
		if float(e2.get("cd", 0.0)) > now:
			continue
		e2["dwell"] = float(e2.get("dwell", 0.0)) + minf(eff, EGG_DWELL)
	# the weather kept happening too
	var sm: Dictionary = st["storm"]
	sm["soak"] = minf(float(sm.get("soak", 0.0)) + eff * 0.02, STORM_SOAK)
	if not _booted:
		return
	_rec_at = -999.0
	_sync_placements()
	_tick_pollen(0.0)
	_tick_eggs(0.0)
	_tick_journal(0.0)


# =============================================================================
# TRAY GRANTS  (DYNAMICS §7.3 — the exact shared pattern, so counts never diverge)
# =============================================================================
func _grant(item_key: String, entry: Dictionary, n: int = 1) -> void:
	if typeof(Game) != TYPE_OBJECT or not (Game.state is Dictionary):
		return
	if not Game.state.has("inventory") or not (Game.state["inventory"] is Dictionary):
		Game.state["inventory"] = {}
	var inv: Dictionary = Game.state["inventory"]
	if not (inv.get(item_key) is Dictionary):
		var e: Dictionary = entry.duplicate(true)
		e["count"] = 0
		inv[item_key] = e
	var cur: Dictionary = inv[item_key]
	cur["count"] = int(cur.get("count", 0)) + n
	var tray := _tray()
	if tray != null and tray.has_method("refresh"):
		tray.call("refresh")
	Game.emit_signal("state_dirty")


func _tray() -> Node:
	if _interact == null:
		return null
	if _interact.has_method("tray"):
		var t = _interact.call("tray")
		if t is Node:
			return t
	return _find_tray(_interact, 0)


func _find_tray(n: Node, depth: int) -> Node:
	if n == null or depth > 4:
		return null
	for ch in n.get_children():
		if ch is InventoryTray:
			return ch
		var deep := _find_tray(ch, depth + 1)
		if deep != null:
			return deep
	return null


# =============================================================================
# WORLD ACCESS  (every call guarded; falls back to what WorldSpace exposes today)
# =============================================================================
func _records() -> Array:
	var now := _now()
	if now - _rec_at < TICK * 0.5:
		return _rec_cache
	_rec_at = now
	_rec_cache = []
	if _space == null:
		return _rec_cache
	if _space.has_method("records"):
		var r = _space.call("records")
		if r is Array:
			_rec_cache = r
			return _rec_cache
	_rec_cache = _synth_records()
	return _rec_cache


# Without the records() accessor, rebuild the registry from the entity layer plus
# the saved placement table (both already public / already persisted).
func _synth_records() -> Array:
	var out: Array = []
	if _space == null or not _space.has_method("entity_layer"):
		return out
	var layer = _space.call("entity_layer")
	if not (layer is Node):
		return out
	var saved: Dictionary = {}
	if typeof(Game) == TYPE_OBJECT and Game.state is Dictionary and Game.state.get("placements") is Dictionary:
		saved = Game.state["placements"]
	var origin_x := _ground_origin().x
	var used: Dictionary = {}
	for ch in (layer as Node).get_children():
		if not (ch is ProcNode):
			continue
		var node: ProcNode = ch
		var tx: float = (node as Node2D).position.x - origin_x
		var best_id := ""
		var best_d := 4.0
		for pid in saved.keys():
			if used.has(pid):
				continue
			var rec: Dictionary = saved[pid]
			var d: float = absf(float(rec.get("tx", 0.0)) - tx)
			if d < best_d:
				best_d = d
				best_id = String(pid)
		if best_id == "":
			continue
		used[best_id] = true
		var src: Dictionary = saved[best_id]
		var fr := 24.0
		var v = node.get("footprint_radius")
		if v != null:
			fr = maxf(8.0, float(v))
		out.append({
			"id": best_id, "inst_key": best_id, "node": node, "tx": tx, "footprint": fr,
			"minted": bool(src.get("minted", false)), "stock": {}, "ready": false,
			"entry": {
				"kind": String(src.get("kind", "plant")),
				"species": String(src.get("species", "")),
				"building_id": String(src.get("building_id", "")),
				"label": String(src.get("label", "")),
				"minted": bool(src.get("minted", false)),
			},
		})
	return out


func _record(place_id: String) -> Dictionary:
	if _space != null and _space.has_method("record_by_id"):
		var r = _space.call("record_by_id", place_id)
		if r is Dictionary:
			return r
	for item in _records():
		var rec: Dictionary = item
		if String(rec.get("id", "")) == place_id:
			return rec
	return {}


func _node_of(record: Dictionary) -> ProcNode:
	var n = record.get("node", null)
	if n is ProcNode and is_instance_valid(n):
		return n
	return null


func _ground_origin() -> Vector2:
	if _space == null:
		return Vector2.ZERO
	if _space.has_method("ground_origin"):
		var o = _space.call("ground_origin")
		if o is Vector2:
			return o
	if _space.has_method("heart_foot"):
		var hf = _space.call("heart_foot")
		if hf is Vector2:
			return hf
	return Vector2.ZERO


# The exact point on the ground contour at a terrain-x (cam-local == our space).
func _ground_point(tx: float) -> Vector2:
	var o := _ground_origin()
	if _space != null and _space.has_method("ground_surface_at"):
		return o + Vector2(tx, float(_space.call("ground_surface_at", tx)))
	if _space != null and _space.has_method("snap_ground"):
		var p = _space.call("snap_ground", Vector2(o.x + tx, o.y))
		if p is Vector2:
			return p
	return o + Vector2(tx, 0.0)


func _nearest(points: Array, to: Vector2) -> Vector2:
	var best := Vector2.ZERO
	var bd := INF
	for item in points:
		var p: Vector2 = item
		var d := p.distance_squared_to(to)
		if d < bd:
			bd = d
			best = p
	return best


# ---- our own small FX layer (budget: a handful of nodes at a time, §7.4) ----
func _spawn_fx(node: ProcNode, at: Vector2 = Vector2.INF) -> void:
	if node == null:
		return
	if _fx == null or _fx.get_child_count() > 14:
		node.queue_free()
		return
	if at != Vector2.INF:
		node.position = at
	_fx.add_child(node)


# Reuse the world's own effects when the public wrapper exists; otherwise ours.
func _world_fx(world_pos: Vector2, kind: String) -> void:
	if _space != null and _space.has_method("spawn_world_fx"):
		_space.call("spawn_world_fx", world_pos, kind, "plant", "")
		return
	if _fx == null or _fx.get_child_count() > 14:
		return
	var fx := ProcEffects.make(world_seed, "dfx:%d" % _fx_count, kind, {"z": 29, "scale": 0.9})
	_fx_count += 1
	fx.position = world_pos
	_fx.add_child(fx)


# =============================================================================
# WHISPER  (shared precious channel — 12 s gap, never mid-drag; DYNAMICS §2.6)
# =============================================================================
func _say(text: String, force: bool = false) -> void:
	if text == "":
		return
	if _interact != null and _interact.has_method("is_placing"):
		if bool(_interact.call("is_placing")):
			return                                   # drop the line, never queue it
	var now := _now()
	if not force and now - _last_whisper < WHISPER_GAP:
		return
	_last_whisper = now
	emit_signal("whisper", text)
