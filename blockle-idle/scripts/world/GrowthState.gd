class_name GrowthState extends Node
# ============================================================================
# GrowthState — the persistent GROWTH + MINT-FREEZE spine of Blockle Idle.
# (Suggested autoload singleton name: `Growth`.)
# ============================================================================
#
# This is the gameplay/systems module behind the design's headline promise
# (IDLE-DESIGN §4 + §5): *every placed thing keeps growing, continuously and
# very slowly, online and offline — and minting an NFT presses that flower in a
# book, freezing its growth until it is placed back into a world.*
#
# It owns three responsibilities, and nothing else (it is menu-less, diegetic,
# seeded — it never draws chrome, never touches the economy balance):
#
#   1. PERSIST GROWTH PER ENTITY.  Every placed ProcNode is registered under a
#      stable `entity_id`. Its growth stage (plus everything needed to regenerate
#      it identically — seed, kind, species/building_id, variant, palette drift,
#      phase) lives in `Game.state["growth"]`, so Save.gd serialises it for free.
#      While the node is alive in the world its `ProcNode.growth` creeps upward on
#      its own (ProcNode._process); GrowthState mirrors that back to the store a
#      few times a second so it is never lost.
#
#   2. GROW OFFLINE (continuous + very slow, generous but curved).  Each entry
#      stores a `last_grown` wall-clock stamp. On register — and via the one-shot
#      `apply_offline()` at boot — GrowthState advances growth by the elapsed time
#      since `last_grown`, through the same generous-then-tapering curve the idle
#      economy uses (full credit for the first ~8h, easing to ~50% out to a 48h
#      cap; §1.2). This is order-independent and idempotent: it stamps `last_grown`
#      forward every time, so nothing is ever double-counted.
#
#   3. MINT FREEZES GROWTH; PLACEMENT RESUMES IT.  `mint_entity()` snapshots the
#      entity's full generative identity (§5 meta), freezes it (`grow_rate = 0`,
#      a glassy MintFrost cue, damped animation), and hands the request to the
#      existing `Wallet.mint_cosmetic()` path — correlating the async relay result
#      by signal, so NO edit to Wallet.gd is required to work. On success the
#      frozen snapshot is preserved; on failure the thing simply thaws and lives
#      on. A minted keepsake only RESUMES growing — from exactly the frozen stage —
#      when it is registered back into a world (placed from the tray / wallet).
#
# Public API (all stable; see the integration note returned with this file):
#   register_new(node, spec) -> String           # freshly planted thing
#   register(node, entity_id, spec={}, opts={}) -> String   # re-attach / re-place
#   uproot(entity_id)                             # pick up to tray, KEEP growth
#   remove(entity_id)                             # delete entirely
#   freeze(entity_id) / resume(entity_id)         # the raw freeze/thaw verbs
#   is_frozen(entity_id) -> bool
#   can_mint(entity_id) -> bool
#   mint_entity(entity_id, cosmetic_id) -> bool   # the whole Wallet-minting flow
#   snapshot(entity_id) -> Dictionary             # §5 regeneration meta
#   growth_of(entity_id) -> float
#   entity(entity_id) -> Dictionary / all_entities() -> Dictionary
#   apply_offline() -> Dictionary                 # boot catch-up + time-lapse data
#
# Signals let the diegetic world react (glow, time-lapse, action bubbles) without
# GrowthState knowing anything about the UI.

signal entity_registered(entity_id: String)
signal entity_frozen(entity_id: String)
signal entity_resumed(entity_id: String)
signal entity_minted(entity_id: String, token: String, tx: String)
signal entity_mint_failed(entity_id: String, reason: String)
signal entity_grew(entity_id: String, from: float, to: float)   # offline / catch-up
signal offline_grown(summary: Dictionary)

# ---- tuning -----------------------------------------------------------------

const MINT_MATURITY := 0.85        # only things you truly grew can be pressed (§5)
const DEFAULT_GROW_MINUTES := 25.0 # ProcNode default pace (§4.2 "across a session")
const OFFLINE_CAP_HOURS := 48.0    # hard cap on a single away-stretch (§1.2)
const FLUSH_INTERVAL := 3.0        # how often live growth is mirrored to the store
const MIN_CATCHUP_SECONDS := 1.0   # ignore sub-second noise / clock jitter

# live ProcNodes currently in the world, by entity_id (store survives them)
var _live: Dictionary = {}
var _flush_accum := 0.0
var _pending_mint := {}            # {id, cosmetic} while a Wallet relay is in flight
var _wallet_wired := false

# ===========================================================================
# boot / lifecycle
# ===========================================================================

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS   # keep mirroring while paused/backgrounded
	_ensure_store()
	_wire_wallet()

func _process(delta: float) -> void:
	_flush_accum += delta
	if _flush_accum >= FLUSH_INTERVAL:
		_flush_accum = 0.0
		_flush_live()

func _notification(what: int) -> void:
	if what == NOTIFICATION_APPLICATION_PAUSED or what == NOTIFICATION_WM_CLOSE_REQUEST \
			or what == NOTIFICATION_APPLICATION_FOCUS_OUT or what == NOTIFICATION_PREDELETE:
		_flush_live()

# ===========================================================================
# the store  (Game.state["growth"] = {entities:{}, seq:int, last_world:unix})
# ===========================================================================

func _ensure_store() -> Dictionary:
	if not Game.state.has("growth"):
		Game.state["growth"] = {}
	var g: Dictionary = Game.state["growth"]
	if not g.has("entities"): g["entities"] = {}
	if not g.has("seq"): g["seq"] = 0
	if not g.has("last_world"): g["last_world"] = _now()
	return g

func _entities() -> Dictionary:
	return _ensure_store()["entities"]

func _now() -> float:
	return Time.get_unix_time_from_system()

func exists(entity_id: String) -> bool:
	return _entities().has(entity_id)

func entity(entity_id: String) -> Dictionary:
	return _entities().get(entity_id, {})

func all_entities() -> Dictionary:
	return _entities()

func growth_of(entity_id: String) -> float:
	return float(entity(entity_id).get("growth", 0.0))

func is_frozen(entity_id: String) -> bool:
	return bool(entity(entity_id).get("frozen", false))

func is_minted(entity_id: String) -> bool:
	return bool(entity(entity_id).get("minted", false))

func _alloc_id() -> String:
	var g := _ensure_store()
	var n := int(g["seq"])
	g["seq"] = n + 1
	return "ent_%d" % n

# A fresh store entry built from a placement spec. The spec is OPAQUE to us — it
# is whatever the placement/tray system needs to regenerate the node identically.
func _new_entry(spec: Dictionary) -> Dictionary:
	var gm := float(spec.get("grow_minutes", DEFAULT_GROW_MINUTES))
	return {
		"kind": String(spec.get("kind", "thing")),
		"growth": clampf(float(spec.get("growth", 0.0)), 0.0, 1.0),
		"grow_minutes": gm,
		"frozen": false,
		"minted": false,
		"mint": {},                                   # §5 meta once minted
		"spec": _clean_spec(spec),                    # regeneration identity
		"world": String(spec.get("world", Game.state.get("realm", ""))),
		"last_grown": _now(),
		"placed_at": _now(),
	}

# Keep the spec serialisable + identity-focused (strip transient hints).
func _clean_spec(spec: Dictionary) -> Dictionary:
	var s := spec.duplicate(true)
	for transient in ["pop_in", "growth", "grow_minutes", "world"]:
		s.erase(transient)
	if not s.has("world_seed"):
		s["world_seed"] = int(Game.state.get("world_seed", 0))
	return s

# ===========================================================================
# register / re-place
# ===========================================================================

# A brand-new, freshly-planted thing. Allocates an id, stores it, binds the node,
# and plays the seed-unfurl (pop_in) unless spec.pop_in == false.
func register_new(node: Node, spec: Dictionary) -> String:
	var id := _alloc_id()
	_entities()[id] = _new_entry(spec)
	_adopt(node, id, {"pop_in": bool(spec.get("pop_in", true)), "resume": true})
	Game.emit_signal("state_dirty")
	emit_signal("entity_registered", id)
	return id

# Re-attach a KNOWN entity to a (possibly new) node — on world rebuild, on
# placing a picked-up thing back down, or on re-placing a minted keepsake from
# the tray/wallet. If the id is unknown it is created from `spec` (so this is
# also safe as a general "ensure tracked" call).
#
# opts: { pop_in:bool=false, resume:bool=true, keep_frozen:bool=false }
#   resume      — placing into a world resumes growth (§5). true by default.
#   keep_frozen — override: keep a minted thing glassy even while shown in-world.
func register(node: Node, entity_id: String, spec: Dictionary = {}, opts: Dictionary = {}) -> String:
	var ents := _entities()
	if not ents.has(entity_id):
		ents[entity_id] = _new_entry(spec)
	elif not spec.is_empty():
		# merge fresh identity hints (e.g. new palette_drift for a cross-world
		# re-place, §5 "adapting its palette drift to the new locale").
		var e: Dictionary = ents[entity_id]
		var merged: Dictionary = e["spec"]
		for k in _clean_spec(spec).keys():
			merged[k] = spec[k]
		e["spec"] = merged
		if spec.has("grow_minutes"):
			e["grow_minutes"] = float(spec["grow_minutes"])
	# time away while it was NOT frozen counts toward growth.
	_catch_up(entity_id)
	var resume_it := bool(opts.get("resume", true)) and not bool(opts.get("keep_frozen", false))
	if resume_it and bool(ents[entity_id].get("frozen", false)):
		# placing a frozen/minted keepsake back into the world wakes it.
		ents[entity_id]["frozen"] = false
		ents[entity_id]["last_grown"] = _now()
		emit_signal("entity_resumed", entity_id)
	_adopt(node, entity_id, {"pop_in": bool(opts.get("pop_in", false)), "resume": resume_it})
	Game.emit_signal("state_dirty")
	emit_signal("entity_registered", entity_id)
	return entity_id

# Bind a node to an entry: restore its growth stage + pace + freeze cue, start
# tracking it for periodic flush, and clean up automatically if it leaves the tree.
func _adopt(node: Node, entity_id: String, flags: Dictionary) -> void:
	if not is_instance_valid(node):
		return
	_live[entity_id] = node
	var e: Dictionary = _entities()[entity_id]
	# pace
	var gm := float(e.get("grow_minutes", DEFAULT_GROW_MINUTES))
	if node.has_method("set_grow_minutes"):
		node.call("set_grow_minutes", gm)
	elif "grow_rate" in node:
		node.set("grow_rate", (1.0 / (gm * 60.0)) if gm > 0.0 else 0.0)
	# stage
	var target := clampf(float(e.get("growth", 0.0)), 0.0, 1.0)
	if bool(flags.get("pop_in", false)) and node.has_method("pop_in"):
		# unfurl from seed up to the stored stage, then let it creep on
		if "growth" in node: node.set("growth", 0.0)
		node.call("pop_in", 1.0)
		if node.has_method("grow_to") and target > 0.02:
			node.call("grow_to", target, 1.1)
	else:
		_set_node_growth(node, target)
	# freeze cue (and hard-stop pace if frozen)
	_apply_freeze_cue(node, bool(e.get("frozen", false)), e)
	# auto-untrack when the node is freed / removed from the world
	if not node.tree_exiting.is_connected(_on_node_exiting):
		node.tree_exiting.connect(_on_node_exiting.bind(entity_id))

func _on_node_exiting(entity_id: String) -> void:
	# mirror its final growth, then drop the live ref (store entry survives).
	if _live.has(entity_id):
		var node = _live[entity_id]
		if is_instance_valid(node):
			_mirror(entity_id, node)
		_live.erase(entity_id)

func _set_node_growth(node: Node, v: float) -> void:
	if node.has_method("set_growth"):
		node.call("set_growth", v)         # clamps + redraw + relayout
	elif "growth" in node:
		node.set("growth", v)

# ===========================================================================
# uproot / remove
# ===========================================================================

# Pick a placed thing up into the tray, PRESERVING its current growth (§2.3
# "Pick up / Uproot"). The caller frees the node; we keep the store entry and
# mark it as out of any world (so re-placement resumes it from here).
func uproot(entity_id: String) -> Dictionary:
	if not exists(entity_id):
		return {}
	if _live.has(entity_id) and is_instance_valid(_live[entity_id]):
		_mirror(entity_id, _live[entity_id])
	_live.erase(entity_id)
	var e: Dictionary = _entities()[entity_id]
	e["world"] = ""                       # now in the tray, not a world
	e["last_grown"] = _now()              # time in the tray does not age it
	Game.emit_signal("state_dirty")
	return snapshot(entity_id)

# Permanently forget an entity (e.g. consumed, traded away).
func remove(entity_id: String) -> void:
	_live.erase(entity_id)
	if _entities().has(entity_id):
		_entities().erase(entity_id)
		Game.emit_signal("state_dirty")

# ===========================================================================
# growth over time  (offline + lazy per-entity catch-up)
# ===========================================================================

# Advance one entity's stored growth by the (curved) time since it last grew.
# Frozen / minted things do not age. Returns the growth delta applied.
func _catch_up(entity_id: String) -> float:
	if not exists(entity_id):
		return 0.0
	var e: Dictionary = _entities()[entity_id]
	if bool(e.get("frozen", false)):
		e["last_grown"] = _now()
		return 0.0
	var gm := float(e.get("grow_minutes", DEFAULT_GROW_MINUTES))
	var last := float(e.get("last_grown", _now()))
	var now := _now()
	e["last_grown"] = now
	if gm <= 0.0 or float(e.get("growth", 0.0)) >= 1.0:
		return 0.0
	var elapsed: float = max(0.0, now - last)         # clock-rewind safe
	if elapsed < MIN_CATCHUP_SECONDS:
		return 0.0
	var eff := _effective_seconds(elapsed)
	var rate := 1.0 / (gm * 60.0)
	var before := float(e["growth"])
	var after := clampf(before + rate * eff, 0.0, 1.0)
	e["growth"] = after
	if after - before > 0.0001:
		emit_signal("entity_grew", entity_id, before, after)
	return after - before

# The generous-but-curved offline model (§1.2): full credit for the first
# ~base_cap hours, then a linear taper of the effective rate down to ~50% out to
# the 48h cap. Reuses Offline.base_cap_hours() when present (research-boosted).
func _effective_seconds(elapsed: float) -> float:
	var full_h := 8.0
	if typeof(Offline) == TYPE_OBJECT and Offline.has_method("base_cap_hours"):
		full_h = float(Offline.base_cap_hours())
	var full := full_h * 3600.0
	var cap := OFFLINE_CAP_HOURS * 3600.0
	var e: float = min(elapsed, cap)
	if e <= full:
		return e
	var over := e - full
	var over_max: float = max(1.0, cap - full)
	var f := clampf(over / over_max, 0.0, 1.0)
	# effective rate falls linearly 1.0 -> 0.5 across the taper; integrate => avg.
	var avg_rate := 1.0 - 0.25 * f
	return full + over * avg_rate

# One-shot boot catch-up for EVERY stored entity (even those not yet rebuilt in
# the world), returning a time-lapse summary for the diegetic "grew while you
# were away" moment (§2.4). Idempotent — safe to call once at boot.
func apply_offline() -> Dictionary:
	var grown: Array = []
	var total := 0.0
	for id in _entities().keys():
		var d := _catch_up(id)
		if d > 0.0:
			total += d
			grown.append({"id": id, "delta": d, "growth": growth_of(id)})
	_ensure_store()["last_world"] = _now()
	var summary := {"count": grown.size(), "total_delta": total, "grown": grown}
	if total > 0.0:
		Game.emit_signal("state_dirty")
		emit_signal("offline_grown", summary)
	return summary

# ===========================================================================
# freeze / resume  (the raw verbs; mint_entity orchestrates them with the Wallet)
# ===========================================================================

# Press the flower: stop growth, go glassy-still. Does NOT itself mint — use
# mint_entity() for the full NFT flow; this is the local, instant freeze.
func freeze(entity_id: String) -> void:
	if not exists(entity_id):
		return
	_catch_up(entity_id)                   # bank the growth up to this instant
	var e: Dictionary = _entities()[entity_id]
	e["frozen"] = true
	e["last_grown"] = _now()
	if _live.has(entity_id) and is_instance_valid(_live[entity_id]):
		var node = _live[entity_id]
		if "grow_rate" in node: node.set("grow_rate", 0.0)
		_apply_freeze_cue(node, true, e)
	Game.emit_signal("state_dirty")
	emit_signal("entity_frozen", entity_id)

# Let it live again — growth resumes from exactly the frozen stage (§5).
func resume(entity_id: String) -> void:
	if not exists(entity_id):
		return
	var e: Dictionary = _entities()[entity_id]
	e["frozen"] = false
	e["last_grown"] = _now()               # no retroactive aging for frozen time
	if _live.has(entity_id) and is_instance_valid(_live[entity_id]):
		var node = _live[entity_id]
		var gm := float(e.get("grow_minutes", DEFAULT_GROW_MINUTES))
		if node.has_method("set_grow_minutes"):
			node.call("set_grow_minutes", gm)
		elif "grow_rate" in node:
			node.set("grow_rate", (1.0 / (gm * 60.0)) if gm > 0.0 else 0.0)
		_apply_freeze_cue(node, false, e)
	Game.emit_signal("state_dirty")
	emit_signal("entity_resumed", entity_id)

# Apply / remove the glassy "pressed flower" cue on a live node. Prefers the
# module's own set_frozen() (ProcTrees / ProcBuildings have richer damping), and
# always adds a uniform MintFrost glass case so EVERY kind reads as held.
func _apply_freeze_cue(node: Node, frozen: bool, e: Dictionary) -> void:
	if not is_instance_valid(node):
		return
	if node.has_method("set_frozen"):
		node.call("set_frozen", frozen)
	var existing = node.get_node_or_null("__mint_frost")
	if frozen:
		if existing == null and node is Node2D:
			var f := MintFrost.new()
			f.name = "__mint_frost"
			var fr := 40.0
			if "footprint_radius" in node:
				fr = float(node.get("footprint_radius"))
			var h := fr * 2.6
			if node.has_method("mint_height"):
				h = float(node.call("mint_height"))
			var tint := Color(0.74, 0.87, 1.0)
			var spec: Dictionary = e.get("spec", {})
			if spec.has("frost_tint"):
				tint = spec["frost_tint"]
			node.add_child(f)
			f.setup(fr, h, tint)
	elif existing != null:
		# gentle thaw: fade the glass out, then free it
		if existing.has_method("set_strength"):
			var tw := existing.create_tween()
			tw.tween_method(existing.set_strength, 1.0, 0.0, 0.6)
			tw.tween_callback(existing.queue_free)
		else:
			existing.queue_free()

# ===========================================================================
# mint — freeze + hand off to the existing Wallet.mint_cosmetic path
# ===========================================================================

# Can this thing be pressed? Only something you truly grew (§5), not already
# minted, and only where the platform permits the mint handoff (Wallet gating).
func can_mint(entity_id: String) -> bool:
	if not exists(entity_id):
		return false
	var e: Dictionary = _entities()[entity_id]
	if bool(e.get("minted", false)):
		return false
	if growth_of(entity_id) < MINT_MATURITY:
		return false
	if typeof(Wallet) == TYPE_OBJECT and Wallet.has_method("can_mint"):
		return bool(Wallet.can_mint())
	return true

# The whole mint flow. Snapshots identity, freezes immediately (the flower is
# pressed the moment you commit), then hands `cosmetic_id` to the UNMODIFIED
# Wallet.mint_cosmetic() relay. We correlate the async result by Wallet signal:
#   - approved  -> keep frozen, record token/tx into the §5 snapshot, mark minted
#   - rejected / failed -> thaw (resume) so the thing simply lives on
# `cosmetic_id` is the Cosmetics catalog item that represents this keepsake
# collection (Wallet requires a real item); the placement/tray layer supplies it.
func mint_entity(entity_id: String, cosmetic_id: String) -> bool:
	if not can_mint(entity_id):
		emit_signal("entity_mint_failed", entity_id, "not mintable")
		return false
	if not _pending_mint.is_empty():
		emit_signal("entity_mint_failed", entity_id, "a mint is already in progress")
		return false
	_wire_wallet()
	# stamp the §5 snapshot into the entry now, pending confirmation.
	var e: Dictionary = _entities()[entity_id]
	e["mint"] = snapshot(entity_id)
	e["mint"]["cosmetic"] = cosmetic_id
	e["mint"]["status"] = "pending"
	# press the flower immediately (diegetic: it goes glassy the instant you mint).
	freeze(entity_id)
	_pending_mint = {"id": entity_id, "cosmetic": cosmetic_id}
	if typeof(Wallet) == TYPE_OBJECT and Wallet.has_method("mint_cosmetic"):
		Wallet.mint_cosmetic(cosmetic_id)
		return true
	# No wallet available — treat as a local-only keepsake (still frozen).
	_on_wallet_mint_done(cosmetic_id, "local", "")
	return true

# The §5 snapshot of the mint currently in flight (or {} if none). Exposed so the
# Wallet.mint_cosmetic() payload can optionally embed it into the NFT metadata —
# see the OPTIONAL Wallet.gd hook in the integration note. Safe to call anytime.
func pending_mint_meta() -> Dictionary:
	if _pending_mint.is_empty():
		return {}
	var id := String(_pending_mint.get("id", ""))
	if not exists(id):
		return {}
	return _entities()[id].get("mint", {}).duplicate(true)

func _wire_wallet() -> void:
	if _wallet_wired or typeof(Wallet) != TYPE_OBJECT:
		return
	if Wallet.has_signal("mint_done") and not Wallet.mint_done.is_connected(_on_wallet_mint_done):
		Wallet.mint_done.connect(_on_wallet_mint_done)
	if Wallet.has_signal("mint_failed") and not Wallet.mint_failed.is_connected(_on_wallet_mint_failed):
		Wallet.mint_failed.connect(_on_wallet_mint_failed)
	_wallet_wired = true

func _on_wallet_mint_done(cosmetic_id: String, token: String, tx: String) -> void:
	if _pending_mint.is_empty() or String(_pending_mint.get("cosmetic", "")) != cosmetic_id:
		return   # not ours (Wallet signals are global)
	var id := String(_pending_mint["id"])
	_pending_mint = {}
	if not exists(id):
		return
	var e: Dictionary = _entities()[id]
	e["minted"] = true
	e["frozen"] = true                    # stays pressed until re-placed
	e["mint"]["status"] = "minted"
	e["mint"]["token"] = token
	e["mint"]["tx"] = tx
	Game.emit_signal("state_dirty")
	emit_signal("entity_minted", id, token, tx)

func _on_wallet_mint_failed(reason: String) -> void:
	if _pending_mint.is_empty():
		return
	var id := String(_pending_mint["id"])
	_pending_mint = {}
	if exists(id):
		_entities()[id]["mint"] = {}      # discard the pending snapshot
		resume(id)                        # thaw — the flower was never pressed
	emit_signal("entity_mint_failed", id, reason)

# ===========================================================================
# snapshot — the §5 regeneration meta (everything to rebuild it exactly)
# ===========================================================================

# A complete, serialisable identity for an entity, matching the IDLE-DESIGN §5
# mint metadata: {world_seed, entity_key, species/building_id, growth_snapshot,
# palette_drift, variant, phase, ...}. Used as NFT meta and to re-place a keepsake.
func snapshot(entity_id: String) -> Dictionary:
	if not exists(entity_id):
		return {}
	var e: Dictionary = _entities()[entity_id]
	var spec: Dictionary = e.get("spec", {})
	return {
		"entity_id": entity_id,
		"world_seed": int(spec.get("world_seed", Game.state.get("world_seed", 0))),
		"entity_key": String(spec.get("key", entity_id)),
		"kind": String(e.get("kind", "thing")),
		"species": spec.get("species", ""),
		"building_id": spec.get("building_id", ""),
		"variant": spec.get("variant", 0),
		"palette_drift": spec.get("palette_drift", 0.0),
		"phase": spec.get("phase", 0.0),
		"realm": String(e.get("world", "")),
		"growth_snapshot": float(e.get("growth", 0.0)),
		"grow_minutes": float(e.get("grow_minutes", DEFAULT_GROW_MINUTES)),
		"frozen": bool(e.get("frozen", false)),
		"minted": bool(e.get("minted", false)),
	}

# ===========================================================================
# live mirroring — keep the store in step with living ProcNodes
# ===========================================================================

func _flush_live() -> void:
	if _live.is_empty():
		return
	var dead: Array = []
	for id in _live.keys():
		var node = _live[id]
		if not is_instance_valid(node):
			dead.append(id)
			continue
		_mirror(id, node)
	for id in dead:
		_live.erase(id)

func _mirror(entity_id: String, node: Node) -> void:
	if not exists(entity_id) or not is_instance_valid(node):
		return
	var e: Dictionary = _entities()[entity_id]
	if bool(e.get("frozen", false)):
		return                              # frozen things don't advance
	if "growth" in node:
		e["growth"] = clampf(float(node.get("growth")), 0.0, 1.0)
	e["last_grown"] = _now()
