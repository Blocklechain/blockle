class_name IdleSim extends Node2D
# IdleSim — the IDLE SIMULATION LOOP of Blockle Idle.
#
# This is the systems spine of IDLE-DESIGN.md §1: "arrange beautiful living things,
# then let time make them beautiful-er." It is NOT a drawing module and not a menu;
# it is the quiet engine that makes the world PRODUCE ON ITS OWN, from the living
# things in it, continuously and offline, with soft diminishing returns and no grind:
#
#   * A LIT BUILDING EMITS ESSENCE / its resource — a grove sheds timber, a quarry
#     sheds stone, the Heart Tree and gardens breathe essence.
#   * A MATURE TREE DROPS SEEDS — every so often a grown tree lets a seed fall into
#     your basket (the Tray's inventory), so your garden can spread without a shop.
#   * CREATURES FORAGE — wandering Blocklings gather a little essence as they roam.
#
# Every unit of output is DIEGETIC (§2.4): a producer sheds a soft IdleMote that
# drifts across the island and is drawn into the Heart Tree's root-pool, and the
# resource is credited ONLY when the mote lands. There are no numbers, no bars —
# you read your economy by watching the traffic of light. A busy thing sheds motes
# faster; a half-grown or stalled thing goes quiet.
#
# GROWTH IS THE SPINE (§4). A producer's rate is a readout of its life stage: a
# Lumber Grove that is 40% grown produces ~40% of its mature rate. IdleSim reads
# each source's `growth` live (via its ProcNode), so planting-and-tending IS the
# progression — never a buy button.
#
# CONTINUOUS + OFFLINE (§1.2). It accrues every frame while you watch; and on wake
# `catch_up_offline(elapsed)` advances every living thing's growth and credits the
# resources that accrued while you were away, under a SOFT DIMINISHING CURVE (full
# credit the first ~8h, tapering toward ~50% out to a ~48h cap) so checking in twice
# a day feels rewarded, never obliged. The wake is shown as a short mote time-lapse,
# not a spreadsheet popup.
#
# PERFORMANCE (CONVENTIONS rule 6). Accrual is a few float ops per source per frame.
# Motes are capped globally; past the cap, accrual is credited silently so the
# economy never stalls while the screen stays smooth. No per-frame allocation on the
# hot path beyond the (cheap, few) motes themselves.
#
# ===========================================================================
# PUBLIC API  (everything Main / boot needs — see the integration note)
# ===========================================================================
#   static make(world_seed:int) -> IdleSim
#
#   -- wiring -------------------------------------------------------------------
#   set_collect_target(node:Node2D, local_offset:Vector2=Vector2.ZERO)   where motes fly (Heart-Tree root-pool)
#   set_seed_target(global_pos:Vector2)          where dropped seeds drift (the Tray); optional
#   set_heart(node:Node2D)                        the Heart Tree (gets its essence-pool glow driven)
#   set_paused(b:bool)
#
#   -- registering living producers --------------------------------------------
#   register(node:ProcNode, spec:Dictionary) -> IdleSource
#       spec: {resource, base_rate, kind, building_id, species, drops_seeds, seed_species, enabled}
#   register_building(node, building_id:String) -> IdleSource     (reads GameData base_prod/produces)
#   register_heart(node) -> IdleSource
#   register_tree(node, opts:={}) -> IdleSource                   (sheds its realm resource + drops seeds)
#   register_creature(node, uid:="") -> IdleSource               (forages essence)
#   unregister(node) -> void
#   clear() -> void
#   scan(root:Node) -> int        auto-register any ProcNode under root exposing idle_spec()->Dictionary
#
#   -- offline ------------------------------------------------------------------
#   catch_up_offline(elapsed_seconds:float, opts:={}) -> Dictionary
#       opts: {credit_resources=true, advance_growth=true, play_timelapse=true, mult=1.0}
#       returns {elapsed, effective, earnings:{res:amt}, grown:int, whisper:String}
#
#   -- queries ------------------------------------------------------------------
#   collect_point() -> Vector2                    (local space)
#   rates() -> Dictionary                         per-resource live rate (for debug/other systems)
#   source_count() -> int
#
#   signals:
#       mote_collected(resource:String, amount:float)
#       seed_dropped(species:String, item_key:String)
#       produced(resource:String, amount:float)   (fires when a producer sheds — pre-landing)

signal mote_collected(resource, amount)
signal seed_dropped(species, item_key)
signal produced(resource, amount)

# ---- tuning (safe to retune; see §4.2 pacing + §1.2 diminishing returns) ----
const MOTE_CAP := 90                 # max live motes; overflow is credited silently
const NICE_RATE := 1.0               # a "normal" per-source rate (sets mote cadence)
const EMIT_MIN := 0.5                # fastest a single source sheds a mote (s)
const EMIT_MAX := 2.8                # slowest cadence (s) for a trickle producer
const MOTE_TRAVEL := 1.25            # base flight time to the pool (s)
const SOFT_REF := 55.0               # per-resource soft-compression reference rate
const SOFT_FLOOR := 0.55             # returns never compress below this fraction
const SEED_MIN_MINUTES := 6.0        # a mature tree drops a seed every ~6..13 min
const SEED_MAX_MINUTES := 13.0
const SEED_GROWTH_GATE := 0.82       # a tree must be ~mature to bear seed
const OFFLINE_FULL_HOURS := 8.0      # full-credit window
const OFFLINE_CAP_HOURS := 48.0      # hard cap
const OFFLINE_FLOOR := 0.5           # effective rate at the cap edge
const AMBIENCE_MINUTES := 2.2        # lit non-producers breathe a faint essence spark

# ---- state ------------------------------------------------------------------
var world_seed: int = 1
var _sources: Array = []                 # Array[IdleSource]
var _by_node: Dictionary = {}            # instance_id -> IdleSource
var _collect_node: Node2D = null
var _collect_offset := Vector2.ZERO
var _seed_target_global := Vector2.INF   # unset => seeds just pop into the basket
var _heart: Node2D = null
var _paused := false
var _live_motes := 0
var _mote_n := 0                         # monotonic key counter for deterministic-ish keys
var _rate_cache: Dictionary = {}         # resource -> summed raw rate (refreshed per tick)
var _pool01 := 0.0                       # smoothed essence-pool fill driving the Heart glow

# ===========================================================================
# construction
# ===========================================================================
static func make(world_seed: int) -> IdleSim:
	var s := IdleSim.new()
	s.world_seed = world_seed
	s.name = "IdleSim"
	return s

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS   # keep simulating even if the game pauses UI

# ===========================================================================
# wiring
# ===========================================================================
func set_collect_target(node: Node2D, local_offset: Vector2 = Vector2.ZERO) -> void:
	_collect_node = node
	_collect_offset = local_offset

func set_seed_target(global_pos: Vector2) -> void:
	_seed_target_global = global_pos

func set_heart(node: Node2D) -> void:
	_heart = node
	if _collect_node == null:
		_collect_node = node

func set_paused(b: bool) -> void:
	_paused = b

# Where motes fly, in THIS node's local space.
func collect_point() -> Vector2:
	if _collect_node != null and is_instance_valid(_collect_node):
		return to_local(_collect_node.global_position) + _collect_offset
	return _collect_offset

func source_count() -> int:
	return _sources.size()

# ===========================================================================
# registration
# ===========================================================================
func register(node: ProcNode, spec: Dictionary) -> IdleSource:
	if node == null or not is_instance_valid(node):
		return null
	var id := node.get_instance_id()
	if _by_node.has(id):
		# update the existing registration in place
		var ex: IdleSource = _by_node[id]
		ex.apply_spec(spec)
		return ex
	var src := IdleSource.new()
	src.node = node
	src.sim = self
	src.apply_spec(spec)
	src.seed_phase(world_seed)
	_sources.append(src)
	_by_node[id] = src
	return src

func register_building(node: ProcNode, building_id: String) -> IdleSource:
	var def: Dictionary = {}
	if typeof(GameData) == TYPE_OBJECT and GameData.buildings_by_id is Dictionary:
		def = GameData.buildings_by_id.get(building_id, {})
	var produces := String(def.get("produces", ""))
	var base: float = float(def.get("base_prod", 0.0))
	# a non-producing but "lit" building (homes/library/lodge) still breathes ambience
	var kind := "building"
	if produces == "" or base <= 0.0:
		kind = "lit"
	return register(node, {
		"resource": produces,
		"base_rate": base,
		"kind": kind,
		"building_id": building_id,
	})

func register_heart(node: ProcNode) -> IdleSource:
	set_heart(node)
	var base := 1.0
	if typeof(GameData) == TYPE_OBJECT and GameData.buildings_by_id is Dictionary:
		base = float(GameData.buildings_by_id.get("heart_tree", {}).get("base_prod", 1.0))
	return register(node, {
		"resource": "essence",
		"base_rate": base,
		"kind": "heart",
		"building_id": "heart_tree",
	})

# A planted tree: sheds a gentle essence/timber trickle and, once mature, drops seeds.
func register_tree(node: ProcNode, opts: Dictionary = {}) -> IdleSource:
	var resource := String(opts.get("resource", "essence"))
	return register(node, {
		"resource": resource,
		"base_rate": float(opts.get("base_rate", 0.35)),
		"kind": "tree",
		"drops_seeds": bool(opts.get("drops_seeds", true)),
		"seed_species": String(opts.get("seed_species", opts.get("species", "sapling"))),
	})

func register_creature(node: ProcNode, uid: String = "") -> IdleSource:
	return register(node, {
		"resource": "essence",
		"base_rate": float(0.16),
		"kind": "creature",
		"uid": uid,
	})

func unregister(node: Node) -> void:
	if node == null:
		return
	var id := node.get_instance_id()
	if _by_node.has(id):
		var src: IdleSource = _by_node[id]
		_sources.erase(src)
		_by_node.erase(id)

func clear() -> void:
	_sources.clear()
	_by_node.clear()

# Auto-register everything under `root` that self-describes via idle_spec().
# A future proc module can expose `func idle_spec() -> Dictionary` to opt in.
func scan(root: Node) -> int:
	var added := 0
	if root == null or not is_instance_valid(root):
		return 0
	for child in _walk(root):
		if child is ProcNode and child.has_method("idle_spec"):
			if not _by_node.has(child.get_instance_id()):
				var spec = child.idle_spec()
				if spec is Dictionary and not spec.is_empty():
					register(child, spec)
					added += 1
	return added

func _walk(n: Node) -> Array:
	var out: Array = [n]
	for c in n.get_children():
		out.append_array(_walk(c))
	return out

# ===========================================================================
# the loop
# ===========================================================================
func _process(delta: float) -> void:
	if _paused or delta <= 0.0:
		return
	if typeof(Game) == TYPE_OBJECT and ("booted" in Game) and not Game.booted:
		return
	delta = minf(delta, 0.25)             # guard against huge frame hitches
	_prune()
	_refresh_rate_cache()
	var mult := _global_mult()
	var realm := _realm_mult()
	for item in _sources:
		var src: IdleSource = item
		src.tick(delta, mult, realm)
	_update_pool(delta)

func _prune() -> void:
	var dead: Array = []
	for item in _sources:
		var src: IdleSource = item
		if src.node == null or not is_instance_valid(src.node):
			dead.append(src)
	for src in dead:
		_sources.erase(src)
		_by_node.erase(src.node_id)

# Sum raw per-resource rates once per tick so soft-compression is shared & cheap.
func _refresh_rate_cache() -> void:
	_rate_cache.clear()
	var mult := _global_mult()
	var realm := _realm_mult()
	for item in _sources:
		var src: IdleSource = item
		var res := src.resource
		if res == "":
			continue
		var r := src.raw_rate(mult, realm)
		_rate_cache[res] = float(_rate_cache.get(res, 0.0)) + r

# Gentle diminishing returns: the more of a resource the whole world already pours,
# the slightly softer each additional stream — never below SOFT_FLOOR (no punishment,
# just a soft cap so the economy curves). IDLE-DESIGN §1.2.
func diminish(resource: String) -> float:
	var total := float(_rate_cache.get(resource, 0.0))
	if total <= 0.0:
		return 1.0
	var f: float = pow(SOFT_REF / (SOFT_REF + total), 0.35)
	return clampf(f, SOFT_FLOOR, 1.0)

# ---- a producer sheds output: spawn a mote (or credit silently if capped) ----
func shed(src: IdleSource, amount: float) -> void:
	if amount <= 0.0 or src.resource == "":
		return
	emit_signal("produced", src.resource, amount)
	if _live_motes >= MOTE_CAP or not _can_fly():
		_credit(src.resource, amount)      # overflow / no target: keep the economy honest
		return
	_fly_mote(src.node_global(), collect_point(), src.resource, amount, "resource", false)

func shed_forage(src: IdleSource, amount: float) -> void:
	if amount <= 0.0:
		return
	emit_signal("produced", "essence", amount)
	if _live_motes >= MOTE_CAP or not _can_fly():
		_credit("essence", amount)
		return
	_fly_mote(src.node_global(), collect_point(), "essence", amount, "forage", false)

# A lit building's faint breath — pure ambience, credits nothing, strictly capped.
func shed_ambience(src: IdleSource) -> void:
	if _live_motes >= MOTE_CAP - 20 or not _can_fly():
		return
	var col := IdleMote.resource_color("essence")
	col = col.lerp(Color(1, 1, 1, 1), 0.35)
	_mote_n += 1
	IdleMote.spawn(self, world_seed, "amb%d" % _mote_n, src.node_global(), collect_point(), {
		"color": col, "shape": "spark", "amount": 0.4, "kind": "ambience",
		"travel": MOTE_TRAVEL * 1.2, "z": 15,
		"on_arrive": Callable(self, "_on_mote_gone"),
	})
	_live_motes += 1

# A mature tree lets a seed fall into the basket.
func drop_seed(src: IdleSource) -> void:
	var species := src.seed_species
	var item_key := _add_seed_to_inventory(species)
	emit_signal("seed_dropped", species, item_key)
	if not _can_fly():
		return
	var target := collect_point()
	if _seed_target_global != Vector2.INF:
		target = to_local(_seed_target_global)
	_mote_n += 1
	var col := Color(0.76, 0.86, 0.5)     # pale seed-husk green-gold
	IdleMote.spawn(self, world_seed, "seed%d" % _mote_n, src.node_global(), target, {
		"color": col, "shape": "seed", "amount": 1.0, "kind": "seed",
		"travel": MOTE_TRAVEL * 1.5, "arc": 70.0, "z": 18,
		"on_arrive": Callable(self, "_on_mote_gone"),
	})
	_live_motes += 1

func _fly_mote(from_g: Vector2, to_l: Vector2, resource: String, amount: float, kind: String, _creditless: bool) -> void:
	_mote_n += 1
	var col := IdleMote.resource_color(resource)
	var shp := IdleMote.resource_shape(resource)
	if kind == "forage":
		shp = "leaf"
		col = col.lerp(Color(0.6, 1.0, 0.7), 0.25)
	IdleMote.spawn(self, world_seed, "m%d" % _mote_n, from_g, to_l, {
		"color": col, "shape": shp, "amount": amount, "kind": kind,
		"travel": MOTE_TRAVEL * (0.85 + 0.4 * clampf(amount / (NICE_RATE * 2.0), 0.0, 1.0)),
		"on_arrive": Callable(self, "_on_resource_mote").bind(resource, amount),
	})
	_live_motes += 1

func _on_resource_mote(_amount_from_mote: float, resource: String, amount: float) -> void:
	_live_motes = maxi(0, _live_motes - 1)
	_credit(resource, amount)
	_pool01 = minf(1.0, _pool01 + (0.03 if resource == "essence" else 0.012))
	emit_signal("mote_collected", resource, amount)

func _on_mote_gone(_a: float) -> void:
	_live_motes = maxi(0, _live_motes - 1)

func _credit(resource: String, amount: float) -> void:
	if resource == "" or amount <= 0.0:
		return
	if typeof(Game) == TYPE_OBJECT and Game.has_method("add_resource"):
		Game.add_resource(resource, amount)

func _can_fly() -> bool:
	return is_inside_tree() and (_collect_node != null or _collect_offset != Vector2.ZERO)

# ---- drive the Heart Tree's essence-pool glow from the live essence reserve ----
func _update_pool(delta: float) -> void:
	if _heart == null or not is_instance_valid(_heart) or not _heart.has_method("set_essence"):
		return
	# target fill is a gentle log-mapping of the essence reserve (the "only resource UI")
	var have := 0.0
	if typeof(Game) == TYPE_OBJECT and Game.has_method("res"):
		have = Game.res("essence")
	var target := clampf(log(have + 1.0) / log(50000.0 + 1.0), 0.08, 1.0)
	# blend the running mote-bump toward the reserve-based target so it settles
	_pool01 = lerp(_pool01, target, clampf(delta * 0.6, 0.0, 1.0))
	_heart.set_essence(_pool01)

# ===========================================================================
# multipliers (cooperate with the economy autoloads when present)
# ===========================================================================
func _global_mult() -> float:
	if typeof(Production) == TYPE_OBJECT and Production.has_method("global_mult"):
		return Production.global_mult()
	return 1.0

func _realm_mult() -> float:
	if typeof(Production) == TYPE_OBJECT and Production.has_method("realm_mult"):
		return Production.realm_mult()
	if typeof(GameData) == TYPE_OBJECT and typeof(Game) == TYPE_OBJECT:
		var rid := String(Game.state.get("realm", "verdant")) if Game.state is Dictionary else "verdant"
		return float(GameData.realms_by_id.get(rid, {}).get("prod_mult", 1.0))
	return 1.0

func kin_bonus(building_id: String) -> float:
	if building_id == "":
		return 1.0
	if typeof(Production) == TYPE_OBJECT and Production.has_method("blockling_factor"):
		return Production.blockling_factor(building_id)
	return 1.0

func building_level(building_id: String) -> int:
	if building_id == "":
		return 1
	if typeof(Buildings) == TYPE_OBJECT and Buildings.has_method("level"):
		return maxi(1, Buildings.level(building_id))
	return 1

func rates() -> Dictionary:
	# a fresh per-resource readout (growth-aware, post-compression)
	var mult := _global_mult()
	var realm := _realm_mult()
	_refresh_rate_cache()
	var out := {}
	for item in _sources:
		var src: IdleSource = item
		if src.resource == "":
			continue
		var r := src.raw_rate(mult, realm) * diminish(src.resource)
		out[src.resource] = float(out.get(src.resource, 0.0)) + r
	return out

# ===========================================================================
# OFFLINE catch-up (§1.2)
# ===========================================================================
# Effective seconds under the soft diminishing curve: full credit for the first
# OFFLINE_FULL_HOURS, then a linear taper (1.0 -> OFFLINE_FLOOR) out to OFFLINE_CAP_HOURS,
# and nothing beyond the cap.
func effective_seconds(elapsed: float) -> float:
	var e: float = maxf(0.0, elapsed)
	var full := OFFLINE_FULL_HOURS * 3600.0
	var cap := OFFLINE_CAP_HOURS * 3600.0
	if e <= full:
		return e
	var taper_span: float = maxf(1.0, cap - full)
	var over: float = minf(e, cap) - full
	var x := over / taper_span                      # 0..1 across the taper
	# integral of a line from 1.0 down to OFFLINE_FLOOR over [0,1], scaled to seconds
	var avg: float = 1.0 - (1.0 - OFFLINE_FLOOR) * 0.5 * x
	return full + over * avg

func catch_up_offline(elapsed_seconds: float, opts: Dictionary = {}) -> Dictionary:
	var credit := bool(opts.get("credit_resources", true))
	var advance := bool(opts.get("advance_growth", true))
	var timelapse := bool(opts.get("play_timelapse", true))
	var extra_mult := float(opts.get("mult", 1.0))
	var eff := effective_seconds(elapsed_seconds)

	# 1) the headline: the world GREW while you were away — advance every living
	#    thing's growth by the FULL elapsed time (growth is generous; §1.2).
	var grown := 0
	if advance and elapsed_seconds > 0.0:
		for item in _sources:
			var src: IdleSource = item
			if src.node == null or not is_instance_valid(src.node):
				continue
			if ("growth" in src.node) and ("grow_rate" in src.node):
				var gr := float(src.node.grow_rate)
				if gr > 0.0 and src.node.growth < 1.0:
					var before := float(src.node.growth)
					src.node.growth = minf(1.0, before + gr * elapsed_seconds)
					if src.node.has_method("_on_growth"):
						src.node._on_growth()
					if src.node.growth > before + 0.0001:
						grown += 1

	# 2) credit the resources that accrued while away, using the NOW-matured rates
	#    (so a seedling that finished unfurling pays its grown rate) × the soft curve.
	var earnings := {}
	if credit:
		var r := rates()
		for res in r.keys():
			var amt: float = float(r[res]) * eff * extra_mult
			if amt > 0.0:
				_credit(res, amt)
				earnings[res] = amt

	# 3) show it diegetically: a short, capped time-lapse of motes streaming into the
	#    pool (cosmetic — the credit already happened above).
	if timelapse and is_inside_tree() and _can_fly():
		_play_timelapse(earnings)

	return {
		"elapsed": elapsed_seconds,
		"effective": eff,
		"earnings": earnings,
		"grown": grown,
		"whisper": _wake_whisper(elapsed_seconds, grown),
	}

func _play_timelapse(earnings: Dictionary) -> void:
	# pick a handful of resources with real earnings and stream a few motes each,
	# staggered, from random producers of that resource toward the pool.
	var budget := 44
	var by_res := {}
	for item in _sources:
		var src: IdleSource = item
		if src.resource != "" and earnings.has(src.resource):
			if not by_res.has(src.resource):
				by_res[src.resource] = []
			by_res[src.resource].append(src)
	var delay := 0.0
	for res in by_res.keys():
		var list: Array = by_res[res]
		if list.is_empty():
			continue
		var n: int = clampi(int(budget / maxi(1, by_res.size())), 4, 18)
		for i in range(n):
			if _live_motes >= MOTE_CAP:
				break
			var src: IdleSource = list[i % list.size()]
			delay += 0.06
			_timelapse_one(src, res, delay)

func _timelapse_one(src: IdleSource, resource: String, delay: float) -> void:
	# a cosmetic mote after `delay` seconds (uses a short SceneTreeTimer; no credit)
	var tree := get_tree()
	if tree == null:
		return
	var tm := tree.create_timer(delay)
	tm.timeout.connect(func():
		if not is_instance_valid(self) or not is_inside_tree():
			return
		if _live_motes >= MOTE_CAP:
			return
		_mote_n += 1
		var col := IdleMote.resource_color(resource)
		IdleMote.spawn(self, world_seed, "tl%d" % _mote_n, src.node_global(), collect_point(), {
			"color": col, "shape": IdleMote.resource_shape(resource),
			"amount": 1.2, "kind": "resource", "travel": MOTE_TRAVEL * 1.1,
			"on_arrive": Callable(self, "_on_mote_gone"),
		})
		_live_motes += 1
	)

func _wake_whisper(elapsed: float, grown: int) -> String:
	if elapsed < 90.0:
		return ""
	if grown > 0:
		return "The island grew while you were away."
	return "The island kept its quiet watch while you were away."

# Lazily ensure Game.state.inventory exists (shape owned by the Tray agent; §2.2),
# then drop a seed in. Returns the inventory key.
func _add_seed_to_inventory(species: String) -> String:
	var key := "seed_" + species
	if typeof(Game) != TYPE_OBJECT or not (Game.state is Dictionary):
		return key
	if not Game.state.has("inventory") or not (Game.state["inventory"] is Dictionary):
		Game.state["inventory"] = {}
	var inv: Dictionary = Game.state["inventory"]
	if not inv.has(key) or not (inv[key] is Dictionary):
		inv[key] = {"count": 0, "kind": "seed", "species": species, "growth_snapshot": 0.0}
	inv[key]["count"] = int(inv[key].get("count", 0)) + 1
	return key


# ===========================================================================
# IdleSource — one living producer's accrual state (a lightweight handle).
# ===========================================================================
class IdleSource extends RefCounted:
	var sim: IdleSim = null
	var node: ProcNode = null
	var node_id: int = 0
	var resource := ""                   # "" = non-producing (lit/ambience only)
	var base_rate := 0.0
	var kind := "building"               # building|lit|heart|tree|creature
	var building_id := ""
	var uid := ""
	var seed_species := "sapling"
	var drops_seeds := false
	var enabled := true

	# accrual timers
	var _emit_t := 0.0
	var _emit_interval := 1.5
	var _seed_t := 0.0
	var _seed_interval := 480.0
	var _amb_t := 0.0
	var _amb_interval := AMBIENCE_MINUTES * 60.0
	var _phase := 0.0

	func apply_spec(spec: Dictionary) -> void:
		resource = String(spec.get("resource", resource))
		base_rate = float(spec.get("base_rate", base_rate))
		kind = String(spec.get("kind", kind))
		building_id = String(spec.get("building_id", building_id))
		uid = String(spec.get("uid", uid))
		seed_species = String(spec.get("seed_species", spec.get("species", seed_species)))
		drops_seeds = bool(spec.get("drops_seeds", drops_seeds or kind == "tree"))
		enabled = bool(spec.get("enabled", enabled))

	func seed_phase(world_seed: int) -> void:
		if node != null:
			node_id = node.get_instance_id()
		var k := "%s:%s:%d" % [kind, building_id + uid, node_id]
		_phase = Proc.hashf(world_seed, "sp:" + k) * TAU
		_emit_t = Proc.rangef(world_seed, "et:" + k, 0.0, 1.2)
		_seed_interval = Proc.rangef(world_seed, "si:" + k, SEED_MIN_MINUTES, SEED_MAX_MINUTES) * 60.0
		_seed_t = Proc.rangef(world_seed, "st:" + k, 0.0, _seed_interval * 0.6)
		_amb_t = Proc.rangef(world_seed, "at:" + k, 0.0, _amb_interval)

	# live life-stage [0,1] read from the node's growth (growth IS the progression).
	func growth01() -> float:
		if node == null or not is_instance_valid(node):
			return 0.0
		if node.has_method("g"):
			return node.g()
		if "growth" in node:
			var x: float = clampf(float(node.growth), 0.0, 1.0)
			return x * x * x * (x * (x * 6.0 - 15.0) + 10.0)
		return 1.0

	# the raw (pre-compression) production rate/sec in `resource` units.
	func raw_rate(global_mult: float, realm_mult: float) -> float:
		if not enabled or resource == "" or base_rate <= 0.0:
			return 0.0
		var g01 := growth01()
		if g01 <= 0.001:
			return 0.0
		var lvl := 1.0
		var kin := 1.0
		if sim != null and (kind == "building" or kind == "heart"):
			lvl = float(sim.building_level(building_id))
			kin = sim.kin_bonus(building_id)
		return base_rate * lvl * kin * g01 * global_mult * realm_mult

	# the effective rate (after the world's soft diminishing returns).
	func rate() -> float:
		if sim == null:
			return 0.0
		var r := raw_rate(sim._global_mult(), sim._realm_mult())
		return r * sim.diminish(resource)

	# advance this source one frame.
	func tick(delta: float, global_mult: float, realm_mult: float) -> void:
		if node == null or not is_instance_valid(node) or sim == null:
			return
		var g01 := growth01()

		# --- resource / forage shedding ---
		if resource != "" and base_rate > 0.0 and g01 > 0.001:
			var r := raw_rate(global_mult, realm_mult) * sim.diminish(resource)
			if r > 0.0:
				# cadence: busier producers shed a touch faster (reads as "flow"),
				# clamped so a 1000× grove sheds FATTER motes, not 1000× more.
				var f := clampf(r / (NICE_RATE), 0.0, 1.0)
				_emit_interval = lerp(EMIT_MAX, EMIT_MIN, smoothstep(0.0, 1.0, f))
				_emit_t += delta
				if _emit_t >= _emit_interval:
					var amt := r * _emit_interval
					_emit_t = 0.0
					if kind == "creature":
						sim.shed_forage(self, amt)
					else:
						sim.shed(self, amt)

		# --- mature trees drop seeds into the basket ---
		if drops_seeds and g01 >= SEED_GROWTH_GATE:
			_seed_t += delta
			if _seed_t >= _seed_interval:
				_seed_t = 0.0
				sim.drop_seed(self)

		# --- lit non-producers breathe a faint ambience spark ---
		if kind == "lit" and g01 > 0.3:
			_amb_t += delta
			if _amb_t >= _amb_interval:
				_amb_t = 0.0
				sim.shed_ambience(self)

	func node_global() -> Vector2:
		if node != null and is_instance_valid(node):
			return node.global_position
		return Vector2.ZERO
