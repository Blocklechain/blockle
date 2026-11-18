extends Control
# Main — builds and drives the ENTIRE portrait game UI in code. One Control scene,
# everything else assembled here: an animated storybook world (sky, floating
# island, tappable Heart Tree, wandering Blocklings) behind a resource bar, a
# realm strip, a five-tab slide-up panel stack, light coachmark tutorial, toasts,
# and the offline "while you were away" popup. Numbers always go through Fmt; the
# palette follows the current realm. Art is PlaceholderArt (drawn, never emoji).

# ---- look & feel ------------------------------------------------------------
const PARCH := Color("#FBF6E9")
const PARCH2 := Color("#F2E7CE")
const INK := Color("#3A2E22")
const INK_SOFT := Color("#6E5B46")
const SHADE := Color(0, 0, 0, 0.45)
const TAB_IDS := ["world", "blocklings", "buildings", "research", "collection"]
const TAB_LABELS := { "world": "World", "blocklings": "Kin", "buildings": "Build",
	"research": "Research", "collection": "Journal" }
const TAB_GLYPH := { "world": "nav_world", "blocklings": "nav_block",
	"buildings": "nav_build", "research": "nav_research", "collection": "nav_collect" }

# ---- layout state -----------------------------------------------------------
var _vp := Vector2(1080, 1920)
var _inset_top := 24.0
var _inset_bot := 16.0
var _nav_h := 84.0
var _bar_h := 92.0
var _strip_h := 44.0

# ---- world ------------------------------------------------------------------
var _world: Node2D
var _sky: Node2D
var _island: Node2D
var _tree: Node2D
var _stamp: Node2D
var _tree_pos := Vector2.ZERO
var _tree_hit := 150.0
var _ent_layer: Node2D           # buildings + blocklings (rebuilt on change)
var _fx_layer: Node2D            # clouds + motes
var _blockling_nodes: Array = [] # {node, base, phase, amp, speed}
var _introduced: Dictionary = {} # entity keys that have already played their entrance
var _cloud_nodes: Array = []     # {node, speed, span}
var _mote_nodes: Array = []      # {node, speed, phase, base}
var _anim_t := 0.0

# ---- ui refs ----------------------------------------------------------------
var _bar: Control
var _chips := {}                 # res_id -> { root, amt, rate }
var _strip: Control
var _strip_realm: Label
var _strip_weather: Label
var _strip_know: Label
var _nav: Control
var _nav_items := {}             # tab -> { root, label, glyph }
var _panel: PanelContainer
var _panel_title: Label
var _panel_body: VBoxContainer
var _coach: Control
var _coach_label: Label
var _toast: Label
var _toast_tween: Tween

var _panel_open := false
var _current_tab := "world"
var _weather_word := "Calm"
var _dyn: Array = []             # Callables run on resources_changed (affordability)

# =============================================================================
func _ready() -> void:
	anchor_right = 1.0
	anchor_bottom = 1.0
	_vp = get_viewport_rect().size
	_build_world()
	_build_bar()
	_build_strip()
	_build_panel()
	_build_coach()
	_build_nav()
	_build_toast()
	_connect_signals()
	get_viewport().size_changed.connect(_on_resized)
	_recompute_insets()
	_layout()
	if Game.booted:
		_on_state_dirty()
		_on_resources_changed()
		_on_realm_changed()

func _connect_signals() -> void:
	Game.resources_changed.connect(_on_resources_changed)
	Game.state_dirty.connect(_on_state_dirty)
	Game.toast.connect(_show_toast)
	Game.recruited.connect(_on_recruited)
	Game.realm_changed.connect(_on_realm_changed)
	Game.offline_ready.connect(_on_offline_ready)

func _on_resized() -> void:
	_vp = get_viewport_rect().size
	_recompute_insets()
	_layout()

func _recompute_insets() -> void:
	# Respect device notches/home-indicators where the platform reports them.
	var sa := DisplayServer.get_display_safe_area()
	var win := DisplayServer.window_get_size()
	if win.y > 0 and sa.size.y > 0 and sa.size.y <= win.y:
		var sc := _vp.y / float(win.y)
		_inset_top = clamp(sa.position.y * sc, 18.0, 140.0)
		_inset_bot = clamp((win.y - (sa.position.y + sa.size.y)) * sc, 12.0, 120.0)
	else:
		_inset_top = 24.0
		_inset_bot = 16.0
	_nav_h = 64.0 + _inset_bot
	_bar_h = 80.0 + _inset_top

# =============================================================================
# World
# =============================================================================
func _build_world() -> void:
	_world = Node2D.new()
	add_child(_world)
	move_child(_world, 0)
	# Per-player palette: a subtle whole-world tint unique to this save's seed.
	_world.modulate = WorldGen.world_tint()
	_sky = PlaceholderArt.realm_sky(_vp, Realms.current_def())
	_world.add_child(_sky)
	_island = _make_island()
	_world.add_child(_island)
	_tree = PlaceholderArt.build_heart_tree(GameData.buildings_by_id.get("heart_tree", {}))
	_world.add_child(_tree)
	_fx_layer = Node2D.new()
	_world.add_child(_fx_layer)
	_ent_layer = Node2D.new()
	_world.add_child(_ent_layer)
	_stamp = PlaceholderArt.placeholder_label()
	_world.add_child(_stamp)
	_build_fx()
	_layout_world()

# Optional hand-painted texture loader (null when the art file is absent).
func _opt_tex(path: String) -> Texture2D:
	if not ResourceLoader.exists(path):
		return null
	var t = load(path)
	return t if t is Texture2D else null

func _make_island() -> Node2D:
	# Prefer the hand-painted island; a slight seed-based scale/flip keeps even
	# the shared painting feeling personal.
	var tex := _opt_tex("res://art/world/island.png")
	if tex != null:
		var wn := Node2D.new()
		var s := Sprite2D.new()
		s.texture = tex
		var tw: float = tex.get_size().x
		var k: float = (380.0 / tw) if tw > 0.0 else 1.0
		var jr := WorldGen._rng("island_scale")
		var jk: float = k * jr.randf_range(0.94, 1.08)
		s.scale = Vector2(jk * (-1.0 if jr.randf() < 0.5 else 1.0), jk)
		wn.add_child(s)
		return wn
	# The silhouette is jittered by the player's world seed, so no two islands
	# share a shape; ground + soil colours are seed-chosen too.
	var n := Node2D.new()
	var soil := WorldGen.soil_color()
	var grass_col := WorldGen.grass_color()
	var under := Polygon2D.new()
	under.polygon = PackedVector2Array([
		Vector2(-170, 0), Vector2(170, 0), Vector2(90, 120), Vector2(0, 190), Vector2(-90, 120)])
	under.color = soil.darkened(0.08)
	n.add_child(under)
	var under2 := Polygon2D.new()
	under2.polygon = PackedVector2Array([
		Vector2(-120, 10), Vector2(120, 10), Vector2(50, 90), Vector2(-50, 90)])
	under2.color = soil.darkened(0.22)
	n.add_child(under2)
	var top := _blob_poly(176.0, grass_col.darkened(0.22), 26, "top")
	top.scale = Vector2(1.0, 0.34)
	n.add_child(top)
	var grass := _blob_poly(176.0, grass_col, 26, "grass")
	grass.scale = Vector2(1.0, 0.30)
	grass.position = Vector2(0, -6)
	n.add_child(grass)
	return n

# A circle whose radius wobbles per vertex using the world seed — the unique
# island outline. `key` gives the two layers slightly different wobble.
func _blob_poly(radius: float, color: Color, segs: int, key: String) -> Polygon2D:
	var jit := WorldGen.island_jitter(segs)
	var pts := PackedVector2Array()
	var salt := 0.0 if key == "grass" else 0.5
	for i in range(segs):
		var ang := TAU * float(i) / float(segs)
		var j: Vector2 = jit[i]
		var rr := radius * (1.0 + j.x + salt * j.y * 0.4)
		pts.append(Vector2(cos(ang), sin(ang)) * rr)
	var p := Polygon2D.new()
	p.polygon = pts
	p.color = color
	return p

func _build_fx() -> void:
	var cloud_tex := _opt_tex("res://art/world/cloud.png")
	var mote_tex := _opt_tex("res://art/fx/mote.png")
	for i in range(4):
		var c := Node2D.new()
		if cloud_tex != null:
			var cs := Sprite2D.new()
			cs.texture = cloud_tex
			var cw: float = cloud_tex.get_size().x
			var ck: float = (150.0 / cw) if cw > 0.0 else 1.0
			cs.scale = Vector2(ck, ck)
			cs.modulate = Color(1, 1, 1, 0.9)
			c.add_child(cs)
		else:
			for off in [Vector2(-26, 2), Vector2(0, -8), Vector2(28, 4), Vector2(6, 6)]:
				var p := _circle_poly(22.0, Color(1, 1, 1, 0.82), 14)
				p.position = off
				c.add_child(p)
		_fx_layer.add_child(c)
		_cloud_nodes.append({ "node": c, "speed": 10.0 + i * 6.0, "span": 0.0 })
	for i in range(9):
		var m: Node2D
		if mote_tex != null:
			var ms := Sprite2D.new()
			ms.texture = mote_tex
			var mw: float = mote_tex.get_size().x
			var mk: float = (16.0 / mw) if mw > 0.0 else 1.0
			ms.scale = Vector2(mk, mk)
			m = ms
		else:
			m = _circle_poly(3.0 + randf() * 2.0, Color("#FFF4D6"), 10)
		_fx_layer.add_child(m)
		_mote_nodes.append({ "node": m, "speed": 14.0 + randf() * 16.0,
			"phase": randf() * TAU, "base": Vector2.ZERO })

func _layout_world() -> void:
	if _sky == null:
		return
	_sky.position = Vector2.ZERO
	var painter := _sky as Object
	if painter.has_method("set"):
		_sky.set("dims", _vp)
	_sky.queue_redraw()
	var cx := _vp.x * 0.5
	var ground := _vp.y * 0.56
	_island.position = Vector2(cx, ground)
	var isc: float = clamp(_vp.x / 760.0, 0.7, 1.4)
	_island.scale = Vector2(isc, isc)
	_tree.position = Vector2(cx, ground - 6 * isc)
	_tree.scale = Vector2(isc, isc)
	_tree_pos = _tree.position + Vector2(0, -230 * isc)
	_tree_hit = 170.0 * isc
	_stamp.position = Vector2(14, _vp.y - _nav_h - 14)
	for c in _cloud_nodes:
		c["span"] = _vp.x + 120.0
	for m in _mote_nodes:
		m["base"] = Vector2(cx + randf_range(-200, 200) * isc, ground - randf_range(40, 260) * isc)
	# scatter clouds across the sky band
	var i := 0
	for c in _cloud_nodes:
		c["node"].position = Vector2(randf() * _vp.x, _vp.y * (0.12 + 0.08 * (i % 3)))
		i += 1
	_place_entities()

func _rebuild_entities() -> void:
	for ch in _ent_layer.get_children():
		ch.queue_free()
	_blockling_nodes.clear()
	if not Game.booted:
		return
	var cx := _vp.x * 0.5
	var ground := _vp.y * 0.56
	var isc: float = clamp(_vp.x / 760.0, 0.7, 1.4)
	# placed buildings (skip heart tree, it is the centerpiece), in a shallow arc
	var owned: Array = []
	for b in GameData.buildings:
		if b["id"] == "heart_tree":
			continue
		if Buildings.is_owned(b["id"]):
			owned.append(b)
	var n := owned.size()
	for idx in range(n):
		var def: Dictionary = owned[idx]
		var node := PlaceholderArt.build_building(def)
		var pl := WorldGen.plot(def["id"])     # seed-stable per-plot placement
		var spread: float = 150.0 * isc
		var t := 0.0 if n <= 1 else (float(idx) / float(n - 1) - 0.5) * 2.0
		node.position = Vector2(cx + (t + pl["dx"]) * spread, ground + (70.0 + pl["dy"] * 60.0) * isc + absf(t) * 10 * isc)
		var bsc: float = 0.72 * isc * pl["sc"]
		node.scale = Vector2(bsc * (-1.0 if pl["flip"] else 1.0), bsc)
		_ent_layer.add_child(node)
		# tiny level pip
		var pip := Label.new()
		pip.text = str(Buildings.level(def["id"]))
		pip.add_theme_font_size_override("font_size", 18)
		pip.add_theme_color_override("font_color", PARCH)
		pip.add_theme_color_override("font_outline_color", INK)
		pip.add_theme_constant_override("outline_size", 5)
		pip.position = node.position + Vector2(-8, -128 * bsc)
		_ent_layer.add_child(pip)
		# cool entrance the first time a building appears in the world
		if not _introduced.has("b:" + def["id"]):
			_introduced["b:" + def["id"]] = true
			_pop_in(node, node.scale, idx * 0.05)
			_fade_in(pip, idx * 0.05 + 0.3)
			_spawn_puff(node.position + Vector2(0, -40 * bsc))
	# wandering blocklings
	var uids: Array = Game.state.get("blocklings", {}).keys()
	var shown: int = min(uids.size(), 8)
	for i in range(shown):
		var uid: String = uids[i]
		var sp := Blocklings.species_of(uid)
		if sp.is_empty():
			continue
		var bn := PlaceholderArt.build_blockling_individual(sp, uid)  # species + unique trait stack
		var base := Vector2(cx + randf_range(-150, 150) * isc, ground + randf_range(10, 60) * isc)
		bn.position = base
		bn.scale *= Vector2(0.9 * isc, 0.9 * isc)   # keep the trait size/flip, fit to the view
		_ent_layer.add_child(bn)
		_blockling_nodes.append({ "node": bn, "base": base, "phase": randf() * TAU,
			"amp": randf_range(30, 80) * isc, "speed": randf_range(0.3, 0.7) })
		# a new Blockling springs into the world with a little sparkle
		if not _introduced.has("k:" + uid):
			_introduced["k:" + uid] = true
			_pop_in(bn, bn.scale, i * 0.04)
			_spawn_puff(base + Vector2(0, -20 * isc))

func _place_entities() -> void:
	_rebuild_entities()

# ---- entrance animations ----------------------------------------------------

# Spring a node up from nothing with a soft overshoot (elastic "pop").
func _pop_in(node: Node2D, final_scale: Vector2, delay: float) -> void:
	node.scale = Vector2.ZERO
	var tw := create_tween()
	if delay > 0.0:
		tw.tween_interval(delay)
	tw.tween_property(node, "scale", final_scale, 0.5).set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)

func _fade_in(node: CanvasItem, delay: float) -> void:
	var c := node.modulate
	c.a = 0.0
	node.modulate = c
	var tw := create_tween()
	if delay > 0.0:
		tw.tween_interval(delay)
	tw.tween_property(node, "modulate:a", 1.0, 0.3)

# A quick burst of fading sparkles where something just appeared.
func _spawn_puff(pos: Vector2) -> void:
	for i in range(6):
		var dot := _circle_poly(5.0, Color("#FFF4D6"), 10)
		dot.position = pos
		_fx_layer.add_child(dot)
		var ang := TAU * float(i) / 6.0 + randf() * 0.6
		var dest := pos + Vector2(cos(ang), sin(ang)) * randf_range(28.0, 58.0)
		var tw := create_tween().set_parallel(true)
		tw.tween_property(dot, "position", dest, 0.5).set_ease(Tween.EASE_OUT)
		tw.tween_property(dot, "scale", Vector2(0.2, 0.2), 0.5)
		tw.tween_property(dot, "modulate:a", 0.0, 0.5)
		tw.chain().tween_callback(dot.queue_free)

func _process(delta: float) -> void:
	# Keep the world cheap: only animate when the player is looking at it.
	if _panel_open or not Game.booted:
		return
	_anim_t += delta
	if is_instance_valid(_tree):
		_tree.rotation = sin(_anim_t * 0.7) * 0.012
	for c in _cloud_nodes:
		var node: Node2D = c["node"]
		node.position.x += c["speed"] * delta
		if node.position.x > c["span"]:
			node.position.x = -120.0
			node.position.y = _vp.y * (0.10 + randf() * 0.16)
	for m in _mote_nodes:
		var node: Node2D = m["node"]
		node.position.y -= m["speed"] * delta
		node.position.x = m["base"].x + sin(_anim_t * 1.3 + m["phase"]) * 16.0
		if node.position.y < _vp.y * 0.18:
			node.position.y = m["base"].y
	for b in _blockling_nodes:
		var node: Node2D = b["node"]
		var nx: float = b["base"].x + sin(_anim_t * b["speed"] + b["phase"]) * b["amp"]
		var dir: float = cos(_anim_t * b["speed"] + b["phase"])
		node.position.x = nx
		node.position.y = b["base"].y + absf(sin(_anim_t * 2.0 + b["phase"])) * 4.0
		var s: float = node.scale.y
		node.scale.x = (s if dir >= 0.0 else -s)

func _unhandled_input(event: InputEvent) -> void:
	if _panel_open or not Game.booted:
		return
	var p := Vector2.INF
	if event is InputEventScreenTouch and event.pressed:
		p = event.position
	elif event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
		p = event.position
	if p == Vector2.INF:
		return
	if p.distance_to(_tree_pos) <= _tree_hit:
		_tap_tree()
		get_viewport().set_input_as_handled()

func _tap_tree() -> void:
	var amt := Production.tap_value()
	Game.add_resource("essence", amt)
	Game.state["stats"]["taps"] = int(Game.state["stats"].get("taps", 0)) + 1
	_play_sfx("tap")
	_spawn_float("+" + Fmt.short(amt), _tree_pos, Color("#7FE3B0"))
	if is_instance_valid(_tree):
		var tw := create_tween()
		tw.tween_property(_tree, "scale", _tree.scale * 1.04, 0.07)
		tw.tween_property(_tree, "scale", _tree.scale, 0.12)
	_advance_tutorial(1)

func _spawn_float(text: String, world_pos: Vector2, col: Color) -> void:
	var l := Label.new()
	l.text = text
	l.add_theme_font_size_override("font_size", 40)
	l.add_theme_color_override("font_color", col)
	l.add_theme_color_override("font_outline_color", INK)
	l.add_theme_constant_override("outline_size", 6)
	l.position = world_pos - Vector2(30, 0)
	l.z_index = 50
	_world.add_child(l)
	var tw := create_tween()
	tw.set_parallel(true)
	tw.tween_property(l, "position:y", l.position.y - 120.0, 0.9)
	tw.tween_property(l, "modulate:a", 0.0, 0.9).set_delay(0.2)
	tw.chain().tween_callback(l.queue_free)

# =============================================================================
# Resource bar
# =============================================================================
func _build_bar() -> void:
	_bar = Control.new()
	add_child(_bar)
	var bg := Panel.new()
	bg.add_theme_stylebox_override("panel", _sb(Color(PARCH.r, PARCH.g, PARCH.b, 0.94), 0, 0))
	bg.set_anchors_preset(Control.PRESET_FULL_RECT)
	_bar.add_child(bg)
	var row := HBoxContainer.new()
	row.name = "row"
	row.add_theme_constant_override("separation", 4)
	row.set_anchors_preset(Control.PRESET_FULL_RECT)
	row.alignment = BoxContainer.ALIGNMENT_CENTER
	_bar.add_child(row)
	for r in GameData.resources:
		var chip := _make_chip(r)
		row.add_child(chip["root"])
		_chips[r["id"]] = chip

func _make_chip(r: Dictionary) -> Dictionary:
	var root := VBoxContainer.new()
	root.add_theme_constant_override("separation", 0)
	root.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	var top := HBoxContainer.new()
	top.add_theme_constant_override("separation", 4)
	top.alignment = BoxContainer.ALIGNMENT_CENTER
	var g := _glyph(r.get("shape", "gem"), Color(r["color"]), Vector2(20, 20))
	top.add_child(g)
	var amt := Label.new()
	amt.add_theme_font_size_override("font_size", 24)
	amt.add_theme_color_override("font_color", INK)
	amt.text = "0"
	top.add_child(amt)
	root.add_child(top)
	var rate := Label.new()
	rate.add_theme_font_size_override("font_size", 16)
	rate.add_theme_color_override("font_color", INK_SOFT)
	rate.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	rate.text = ""
	root.add_child(rate)
	return { "root": root, "amt": amt, "rate": rate, "id": r["id"] }

func _refresh_bar() -> void:
	if not Game.booted:
		return
	var rates := Production.total_rates()
	for id in _chips.keys():
		var chip = _chips[id]
		var have := Game.res(id)
		var rate: float = rates.get(id, 0.0)
		var show: bool = id == "essence" or have > 0.0 or rate > 0.0
		chip["root"].visible = show
		if not show:
			continue
		chip["amt"].text = Fmt.short(have)
		chip["rate"].text = Fmt.rate(rate) if rate > 0.0 else ""

# =============================================================================
# Realm strip
# =============================================================================
func _build_strip() -> void:
	_strip = Control.new()
	add_child(_strip)
	var bg := Panel.new()
	bg.add_theme_stylebox_override("panel", _sb(Color(0, 0, 0, 0.22), 0, 0))
	bg.set_anchors_preset(Control.PRESET_FULL_RECT)
	_strip.add_child(bg)
	var row := HBoxContainer.new()
	row.set_anchors_preset(Control.PRESET_FULL_RECT)
	row.add_theme_constant_override("separation", 10)
	row.alignment = BoxContainer.ALIGNMENT_CENTER
	_strip.add_child(row)
	_strip_realm = _wlabel("", 22, PARCH)
	_strip_weather = _wlabel("", 18, Color(1, 1, 1, 0.82))
	_strip_know = _wlabel("", 18, Color("#FFC978"))
	row.add_child(_strip_realm)
	row.add_child(_vsep())
	row.add_child(_strip_weather)
	row.add_child(_vsep())
	row.add_child(_strip_know)

func _refresh_strip() -> void:
	if not Game.booted:
		return
	# Show the realm plus THIS player's unique procedurally-named world.
	_strip_realm.text = "%s · %s" % [Realms.current_def().get("name", "The Verdant Beginning"), WorldGen.world_name()]
	_strip_weather.text = _weather_word
	_strip_know.text = "Ancient Knowledge  " + Fmt.short(float(Ascension.ancient_knowledge()))

func _pick_weather() -> void:
	var sets := {
		"verdant": ["Clear morning", "Soft breeze", "Golden noon", "Gentle rain"],
		"crystal_hollow": ["Glittering dark", "Still air", "Humming glow"],
		"skylands": ["High winds", "Bright sky", "Drifting cloud"],
		"forgotten_wilds": ["Misty dusk", "Glowing night", "Wild bloom"],
		"frostfall": ["Light snow", "Crisp cold", "Frozen hush"],
		"astral": ["Starfall", "Cosmic calm", "Shimmering void"],
		"first_kingdom": ["Amber dawn", "Timeless light", "Old magic"],
	}
	var list: Array = sets.get(Realms.current(), ["Calm"])
	_weather_word = list[randi() % list.size()]

# =============================================================================
# Bottom nav
# =============================================================================
func _build_nav() -> void:
	_nav = Control.new()
	add_child(_nav)
	var bg := Panel.new()
	bg.add_theme_stylebox_override("panel", _sb(PARCH2, 0, 0))
	bg.set_anchors_preset(Control.PRESET_FULL_RECT)
	_nav.add_child(bg)
	var row := HBoxContainer.new()
	row.name = "row"
	row.set_anchors_preset(Control.PRESET_FULL_RECT)
	row.add_theme_constant_override("separation", 0)
	_nav.add_child(row)
	for tab in TAB_IDS:
		var cell := Control.new()
		cell.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		cell.custom_minimum_size = Vector2(44, 44)
		var vb := VBoxContainer.new()
		vb.set_anchors_preset(Control.PRESET_FULL_RECT)
		vb.alignment = BoxContainer.ALIGNMENT_CENTER
		vb.add_theme_constant_override("separation", 2)
		vb.mouse_filter = Control.MOUSE_FILTER_IGNORE
		var g := _glyph(TAB_GLYPH[tab], INK_SOFT, Vector2(30, 30))
		g.size_flags_horizontal = Control.SIZE_SHRINK_CENTER
		vb.add_child(g)
		var lbl := Label.new()
		lbl.text = TAB_LABELS[tab]
		lbl.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		lbl.add_theme_font_size_override("font_size", 16)
		lbl.add_theme_color_override("font_color", INK_SOFT)
		vb.add_child(lbl)
		cell.add_child(vb)
		var btn := Button.new()
		btn.flat = true
		btn.set_anchors_preset(Control.PRESET_FULL_RECT)
		btn.focus_mode = Control.FOCUS_NONE
		btn.pressed.connect(_on_nav.bind(tab))
		cell.add_child(btn)
		row.add_child(cell)
		_nav_items[tab] = { "root": cell, "label": lbl, "glyph": g }

func _on_nav(tab: String) -> void:
	_play_sfx("tap")
	if _panel_open and _current_tab == tab:
		_close_panel()
		return
	_current_tab = tab
	_open_panel(tab)
	if tab == "buildings":
		_advance_tutorial(2)

func _refresh_nav() -> void:
	for tab in _nav_items.keys():
		var sel: bool = _panel_open and _current_tab == tab
		var col := _accent() if sel else INK_SOFT
		_nav_items[tab]["label"].add_theme_color_override("font_color", col)
		var g = _nav_items[tab]["glyph"]
		g.set("col", col)
		g.queue_redraw()

# =============================================================================
# Panel frame + tab content
# =============================================================================
func _build_panel() -> void:
	_panel = PanelContainer.new()
	_panel.add_theme_stylebox_override("panel", _sb(PARCH, 26, 0))
	_panel.visible = false
	add_child(_panel)
	var outer := VBoxContainer.new()
	outer.add_theme_constant_override("separation", 0)
	_panel.add_child(outer)
	# header
	var head := PanelContainer.new()
	head.add_theme_stylebox_override("panel", _sb(PARCH2, 26, 10))
	outer.add_child(head)
	var hrow := HBoxContainer.new()
	head.add_child(hrow)
	_panel_title = _wlabel("", 30, INK)
	_panel_title.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	hrow.add_child(_panel_title)
	var close := _icon_button("close")
	close.pressed.connect(_close_panel)
	hrow.add_child(close)
	# scrollable body
	var scroll := ScrollContainer.new()
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	outer.add_child(scroll)
	_panel_body = VBoxContainer.new()
	_panel_body.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_panel_body.add_theme_constant_override("separation", 10)
	scroll.add_child(_panel_body)

func _open_panel(tab: String) -> void:
	_panel_open = true
	_panel.visible = true
	_panel_title.text = _tab_title(tab)
	_rebuild_panel_body()
	_refresh_nav()
	_layout()
	_panel.position.y = _vp.y
	var tw := create_tween().set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_OUT)
	tw.tween_property(_panel, "position:y", _panel_top(), 0.22)

func _close_panel() -> void:
	if not _panel_open:
		return
	_panel_open = false
	_clear_dyn()
	_refresh_nav()
	var tw := create_tween().set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_IN)
	tw.tween_property(_panel, "position:y", _vp.y, 0.18)
	tw.tween_callback(func(): _panel.visible = false)
	_update_coach()

func _tab_title(tab: String) -> String:
	match tab:
		"world": return "Your World"
		"blocklings": return "Blockling Kin"
		"buildings": return "Buildings"
		"research": return "Research"
		"collection": return "Journal"
	return ""

func _rebuild_panel_body() -> void:
	_clear_dyn()
	for ch in _panel_body.get_children():
		ch.queue_free()
	if not Game.booted:
		return
	match _current_tab:
		"world": _fill_world_panel()
		"blocklings": _fill_blocklings_panel()
		"buildings": _fill_buildings_panel()
		"research": _fill_research_panel()
		"collection": _fill_collection_panel()

# ---- Buildings --------------------------------------------------------------
func _fill_buildings_panel() -> void:
	for def in _realm_buildings():
		var id: String = def["id"]
		_panel_body.add_child(_building_card(def, id))

func _building_card(def: Dictionary, id: String) -> Control:
	var card := _card()
	var vb := VBoxContainer.new()
	vb.add_theme_constant_override("separation", 6)
	card.add_child(vb)
	var top := HBoxContainer.new()
	top.add_theme_constant_override("separation", 8)
	vb.add_child(top)
	var thumb := _art_thumb(PlaceholderArt.build_building(def), 56)
	top.add_child(thumb)
	var info := VBoxContainer.new()
	info.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	info.add_theme_constant_override("separation", 1)
	top.add_child(info)
	var owned := Buildings.is_owned(id)
	var title := _wlabel(def["name"] + ("  Lv " + str(Buildings.level(id)) if owned else ""), 24, INK)
	info.add_child(title)
	var produces: String = def.get("produces", "")
	var sub := _wlabel("", 17, INK_SOFT)
	sub.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	if produces != "":
		sub.text = Fmt.rate(Production.rate_for_building(id)) + " " + GameData.resources_by_id.get(produces, {}).get("name", produces)
	else:
		sub.text = def.get("desc", "")
	info.add_child(sub)
	# build / upgrade button
	var btn := _btn("")
	vb.add_child(btn)
	var upd := func():
		if not is_instance_valid(btn):
			return
		var o := Buildings.is_owned(id)
		if Buildings.at_max(id):
			btn.text = "Maxed"
			btn.disabled = true
			return
		var cost := Economy.cost_for_building(id)
		btn.text = ("Upgrade" if o else "Build") + "   " + _cost_str(cost)
		btn.disabled = not Game.can_afford(cost)
	btn.pressed.connect(func():
		if Economy.buy_building(id):
			_play_sfx("build")
	)
	upd.call()
	_dyn.append(upd)
	# assignment expander
	if Buildings.slots(id) > 0 and Buildings.is_owned(id):
		var exp := _btn("Workers  " + str(Buildings.assigned_to(id).size()) + "/" + str(Buildings.slots(id)))
		exp.add_theme_color_override("font_color", INK)
		vb.add_child(exp)
		var box := VBoxContainer.new()
		box.visible = false
		box.add_theme_constant_override("separation", 4)
		vb.add_child(box)
		exp.pressed.connect(func(): box.visible = not box.visible; _fill_assign_box(box, id))
	return card

func _fill_assign_box(box: VBoxContainer, id: String) -> void:
	for ch in box.get_children():
		ch.queue_free()
	for uid in Buildings.assigned_to(id):
		var sp := Blocklings.species_of(uid)
		var row := HBoxContainer.new()
		row.add_theme_constant_override("separation", 6)
		var nm := _wlabel(sp.get("name", "?") + "  Lv " + str(Blocklings.level_of(uid)), 17, INK)
		nm.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		row.add_child(nm)
		var rm := _btn("Unassign")
		rm.custom_minimum_size = Vector2(0, 44)
		rm.pressed.connect(func(): Buildings.unassign(uid))
		row.add_child(rm)
		box.add_child(row)
	var free := Buildings.free_slots(id)
	if free > 0:
		var cand := _free_blockling()
		var add := _btn("Assign a Blockling   (" + str(free) + " free)")
		add.disabled = cand == ""
		add.pressed.connect(func():
			var c := _free_blockling()
			if c != "" and Buildings.assign(c, id):
				_advance_tutorial(5)
		)
		box.add_child(add)

func _realm_buildings() -> Array:
	var cur := Realms.current()
	var list: Array = []
	for b in GameData.buildings:
		if b.get("realm", "") == cur:
			list.append(b)
	if list.is_empty():
		list = GameData.buildings
	return list

func _free_blockling() -> String:
	for uid in Game.state.get("blocklings", {}).keys():
		if Game.state["blocklings"][uid].get("assigned_to", "") == "":
			return uid
	return ""

# ---- Blocklings -------------------------------------------------------------
func _fill_blocklings_panel() -> void:
	var rec := _card()
	var rv := VBoxContainer.new()
	rv.add_theme_constant_override("separation", 4)
	rec.add_child(rv)
	var rbtn := _btn("")
	var cnt := _wlabel("", 18, INK_SOFT)
	rv.add_child(cnt)
	rv.add_child(rbtn)
	var upd := func():
		if not is_instance_valid(rbtn):
			return
		cnt.text = "Living here: " + str(Blocklings.count()) + " / " + str(Blocklings.cap())
		if Blocklings.count() >= Blocklings.cap():
			rbtn.text = "Build more Homes for room"
			rbtn.disabled = true
		else:
			rbtn.text = "Recruit a Blockling   " + _cost_str(Blocklings.recruit_cost())
			rbtn.disabled = not Game.can_afford(Blocklings.recruit_cost())
	rbtn.pressed.connect(func():
		if Blocklings.recruit() != "":
			_play_sfx("recruit")
	)
	upd.call()
	_dyn.append(upd)
	_panel_body.add_child(rec)
	for uid in Game.state.get("blocklings", {}).keys():
		_panel_body.add_child(_blockling_card(uid))

func _blockling_card(uid: String) -> Control:
	var sp := Blocklings.species_of(uid)
	var rar: Dictionary = GameData.rarities_by_id.get(sp.get("rarity", "common"), {})
	var card := _card()
	var vb := VBoxContainer.new()
	vb.add_theme_constant_override("separation", 5)
	card.add_child(vb)
	var top := HBoxContainer.new()
	top.add_theme_constant_override("separation", 8)
	vb.add_child(top)
	top.add_child(_art_thumb(PlaceholderArt.build_blockling(sp), 54))
	var info := VBoxContainer.new()
	info.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	info.add_theme_constant_override("separation", 1)
	top.add_child(info)
	info.add_child(_wlabel(sp.get("name", "?") + "  Lv " + str(Blocklings.level_of(uid)), 23, INK))
	info.add_child(_wlabel(rar.get("name", "Common") + "   +" + str(round(Blocklings.bonus_for(uid) * 100.0)) + "% work", 16, Color(rar.get("color", "#B9C2CC"))))
	# level up
	var lb := _btn("")
	vb.add_child(lb)
	var upd := func():
		if not is_instance_valid(lb):
			return
		lb.text = "Level Up   " + _cost_str(Blocklings.level_cost(uid))
		lb.disabled = not Game.can_afford(Blocklings.level_cost(uid))
	lb.pressed.connect(func(): Blocklings.level_up(uid))
	upd.call()
	_dyn.append(upd)
	# assignment cycler
	var ab := _btn(_assign_label(uid))
	ab.add_theme_color_override("font_color", INK)
	ab.pressed.connect(func(): _cycle_assign(uid); ab.text = _assign_label(uid))
	vb.add_child(ab)
	return card

func _assign_label(uid: String) -> String:
	var at: String = Game.state.get("blocklings", {}).get(uid, {}).get("assigned_to", "")
	if at == "":
		return "Working at:  Resting  (tap to change)"
	return "Working at:  " + GameData.buildings_by_id.get(at, {}).get("name", at) + "  (tap to change)"

func _cycle_assign(uid: String) -> void:
	# Cycle through: Resting -> each owned building with slots -> Resting.
	var opts: Array = [""]
	for b in GameData.buildings:
		if Buildings.is_owned(b["id"]) and Buildings.slots(b["id"]) > 0:
			opts.append(b["id"])
	var cur: String = Game.state.get("blocklings", {}).get(uid, {}).get("assigned_to", "")
	var i := opts.find(cur)
	for step in range(opts.size()):
		i = (i + 1) % opts.size()
		var target: String = opts[i]
		if target == "":
			Buildings.unassign(uid)
			return
		if Buildings.free_slots(target) > 0 or target == cur:
			if Buildings.assign(uid, target):
				_advance_tutorial(5)
				return
	Buildings.unassign(uid)

# ---- Research ---------------------------------------------------------------
func _fill_research_panel() -> void:
	for branch in GameData.research_branches:
		var header := _wlabel(branch["name"], 24, Color(branch.get("accent", "#C9955B")))
		header.add_theme_constant_override("outline_size", 4)
		header.add_theme_color_override("font_outline_color", INK)
		_panel_body.add_child(header)
		var nodes: Array = []
		for n in GameData.research_nodes:
			if n["branch"] == branch["id"]:
				nodes.append(n)
		nodes.sort_custom(func(a, b): return int(a.get("tier", 0)) < int(b.get("tier", 0)))
		for n in nodes:
			_panel_body.add_child(_research_card(n))

func _research_card(n: Dictionary) -> Control:
	var id: String = n["id"]
	var card := _card()
	var vb := VBoxContainer.new()
	vb.add_theme_constant_override("separation", 3)
	card.add_child(vb)
	vb.add_child(_wlabel(n["name"], 22, INK))
	var d := _wlabel(n.get("desc", ""), 16, INK_SOFT)
	d.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	vb.add_child(d)
	var btn := _btn("")
	vb.add_child(btn)
	var upd := func():
		if not is_instance_valid(btn):
			return
		if Research.is_done(id):
			btn.text = "Researched"
			btn.disabled = true
		elif not Research.requirements_met(id):
			btn.text = "Locked  -  needs earlier research"
			btn.disabled = true
		else:
			btn.text = "Unlock   " + _cost_str(Research.cost_of(id))
			btn.disabled = not Game.can_afford(Research.cost_of(id))
	btn.pressed.connect(func(): Research.unlock(id))
	upd.call()
	_dyn.append(upd)
	return card

# ---- Collection -------------------------------------------------------------
func _fill_collection_panel() -> void:
	_panel_body.add_child(_wlabel("Blockling Journal   " + str(Blocklings.discovered_count()) + " / " + str(GameData.blocklings.size()), 22, INK))
	var grid := GridContainer.new()
	grid.columns = 3
	grid.add_theme_constant_override("h_separation", 8)
	grid.add_theme_constant_override("v_separation", 8)
	_panel_body.add_child(grid)
	for sp in GameData.blocklings:
		grid.add_child(_journal_cell(sp))
	_panel_body.add_child(_wlabel("Achievements", 22, INK))
	for a in GameData.achievements:
		_panel_body.add_child(_achievement_row(a))

func _journal_cell(sp: Dictionary) -> Control:
	var found: bool = Game.state.get("discovered", {}).has(sp["id"])
	var rar: Dictionary = GameData.rarities_by_id.get(sp.get("rarity", "common"), {})
	var card := PanelContainer.new()
	card.add_theme_stylebox_override("panel", _sb(PARCH2, 16, 6))
	card.custom_minimum_size = Vector2(0, 118)
	var vb := VBoxContainer.new()
	vb.alignment = BoxContainer.ALIGNMENT_CENTER
	vb.add_theme_constant_override("separation", 2)
	card.add_child(vb)
	if found:
		var th := _art_thumb(PlaceholderArt.build_blockling(sp), 56)
		th.size_flags_horizontal = Control.SIZE_SHRINK_CENTER
		vb.add_child(th)
		var nm := _wlabel(sp["name"], 17, INK)
		nm.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		vb.add_child(nm)
		var rl := _wlabel(rar.get("name", ""), 13, Color(rar.get("color", "#B9C2CC")))
		rl.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		vb.add_child(rl)
	else:
		var sil := _art_thumb(PlaceholderArt.build_blockling(sp), 56)
		sil.modulate = Color(0.1, 0.1, 0.12, 1.0)
		sil.size_flags_horizontal = Control.SIZE_SHRINK_CENTER
		vb.add_child(sil)
		var q := _wlabel("? ? ?", 17, INK_SOFT)
		q.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		vb.add_child(q)
	return card

func _achievement_row(a: Dictionary) -> Control:
	var earned: bool = Game.state.get("achievements", {}).has(a["id"])
	var card := _card()
	var vb := VBoxContainer.new()
	vb.add_theme_constant_override("separation", 1)
	card.add_child(vb)
	var title := _wlabel(("Earned  -  " if earned else "") + a["name"], 20, (_accent() if earned else INK))
	vb.add_child(title)
	var d := _wlabel(a.get("desc", ""), 16, INK_SOFT)
	d.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	vb.add_child(d)
	if not earned:
		card.modulate = Color(1, 1, 1, 0.7)
	return card

# ---- World panel (travel, ascension, store, settings) -----------------------
func _fill_world_panel() -> void:
	_panel_body.add_child(_wlabel("Travel", 22, INK))
	for r in GameData.realms:
		_panel_body.add_child(_realm_row(r))
	_panel_body.add_child(_hsep())
	# ascension
	var asc := _card()
	var av := VBoxContainer.new()
	av.add_theme_constant_override("separation", 4)
	asc.add_child(av)
	av.add_child(_wlabel("World Ascension", 22, INK))
	var ad := _wlabel("Return the world to its beginning to gain Ancient Knowledge  -  a permanent boost to all production.", 16, INK_SOFT)
	ad.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	av.add_child(ad)
	var abtn := _btn("Ascend   (+" + str(Ascension.knowledge_preview()) + " Knowledge)")
	abtn.disabled = not Ascension.can_ascend()
	abtn.pressed.connect(_confirm_ascend)
	av.add_child(abtn)
	_panel_body.add_child(asc)
	# cosmetic store
	var store_btn := _btn("Cosmetic Store")
	store_btn.pressed.connect(_open_store)
	_panel_body.add_child(store_btn)
	_panel_body.add_child(_hsep())
	# settings
	_panel_body.add_child(_wlabel("Settings", 22, INK))
	_panel_body.add_child(_slider_row("Music", float(Game.state.get("settings", {}).get("music", 0.6)), func(v):
		Game.state["settings"]["music"] = v
		if _has(Audio, "set_music_volume"): Audio.set_music_volume(v)
	))
	_panel_body.add_child(_slider_row("Sound", float(Game.state.get("settings", {}).get("sfx", 0.8)), func(v):
		Game.state["settings"]["sfx"] = v
		if _has(Audio, "set_sfx_volume"): Audio.set_sfx_volume(v)
	))
	var reset := _btn("Reset Game")
	reset.add_theme_color_override("font_color", Color("#B5473A"))
	reset.pressed.connect(_confirm_reset)
	_panel_body.add_child(reset)

func _realm_row(r: Dictionary) -> Control:
	var id: String = r["id"]
	var card := _card()
	var vb := VBoxContainer.new()
	vb.add_theme_constant_override("separation", 3)
	card.add_child(vb)
	vb.add_child(_wlabel(r["name"] + "   x" + str(r.get("prod_mult", 1.0)) + " production", 21, Color(r.get("accent", "#C9955B"))))
	var desc := _wlabel(r.get("desc", ""), 15, INK_SOFT)
	desc.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	vb.add_child(desc)
	if Realms.current() == id:
		vb.add_child(_wlabel("You are here", 17, _accent()))
	elif Realms.is_unlocked(id):
		var b := _btn("Travel here")
		b.pressed.connect(func(): Realms.switch_to(id); _close_panel())
		vb.add_child(b)
	else:
		var b2 := _btn("Unlock   " + _cost_str(r.get("unlock_cost", {})))
		b2.disabled = not Realms.can_unlock(id)
		b2.pressed.connect(func(): Realms.unlock(id))
		vb.add_child(b2)
	return card

# =============================================================================
# Cosmetic store (cosmetic-only monetization)
# =============================================================================
func _open_store() -> void:
	var body := _show_modal("Cosmetic Store")
	var intro := _wlabel("Looks only  -  never power. Support the island if you like it.", 16, INK_SOFT)
	intro.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	body.add_child(intro)
	var available := _iap_available()
	if not available:
		body.add_child(_wlabel("Store unavailable in this build.", 17, Color("#B5473A")))
	var items := _cosmetic_items()
	if items.is_empty():
		body.add_child(_wlabel("New cosmetics are on the way.", 18, INK))
	# Grouped by type so the catalog reads as tidy sections.
	var groups: Array = []            # preserve first-seen order
	var by_type := {}
	for it in items:
		var t: String = str(it.get("type", "cosmetic"))
		if not by_type.has(t):
			by_type[t] = []
			groups.append(t)
		by_type[t].append(it)
	for t in groups:
		body.add_child(_wlabel(_titleize(t), 20, _accent()))
		for it in by_type[t]:
			body.add_child(_store_row(it, available))
	var restore := _btn("Restore Purchases")
	restore.disabled = not available
	restore.pressed.connect(func():
		if _has(IAP, "restore_purchases"): IAP.restore_purchases()
	)
	body.add_child(restore)

func _store_row(it: Dictionary, available: bool) -> Control:
	var card := _card()
	var vb := VBoxContainer.new()
	vb.add_theme_constant_override("separation", 2)
	card.add_child(vb)
	vb.add_child(_wlabel(str(it.get("name", "Cosmetic")), 21, INK))
	if it.has("desc"):
		var d := _wlabel(str(it["desc"]), 15, INK_SOFT)
		d.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		vb.add_child(d)
	var owned: bool = _cosmetic_owned(str(it.get("id", "")))
	var pid := str(it.get("product_id", it.get("id", "")))
	if owned:
		vb.add_child(_wlabel("Owned", 17, _accent()))
	else:
		var price := _price_str(it)
		var buy := _btn("Buy" + ("   " + price if price != "" else ""))
		buy.disabled = not available
		buy.pressed.connect(func():
			if _has(IAP, "purchase"): IAP.purchase(pid)
		)
		vb.add_child(buy)
	return card

func _price_str(it: Dictionary) -> String:
	if it.has("price_usd"):
		return "$" + String.num(float(it["price_usd"]), 2)
	if it.has("price"):
		return str(it["price"])
	return ""

func _titleize(s: String) -> String:
	return s.replace("_", " ").capitalize()

# =============================================================================
# Modals: ascension confirm, reset confirm, offline popup, store
# =============================================================================
func _show_modal(title: String) -> VBoxContainer:
	var overlay := Control.new()
	overlay.set_anchors_preset(Control.PRESET_FULL_RECT)
	overlay.mouse_filter = Control.MOUSE_FILTER_STOP
	var dim := ColorRect.new()
	dim.color = SHADE
	dim.set_anchors_preset(Control.PRESET_FULL_RECT)
	overlay.add_child(dim)
	var center := CenterContainer.new()
	center.set_anchors_preset(Control.PRESET_FULL_RECT)
	overlay.add_child(center)
	var card := PanelContainer.new()
	card.add_theme_stylebox_override("panel", _sb(PARCH, 24, 18))
	card.custom_minimum_size = Vector2(min(_vp.x * 0.86, 640), 0)
	center.add_child(card)
	var scroll := ScrollContainer.new()
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	scroll.custom_minimum_size = Vector2(0, min(_vp.y * 0.66, 900))
	card.add_child(scroll)
	var vb := VBoxContainer.new()
	vb.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	vb.add_theme_constant_override("separation", 10)
	scroll.add_child(vb)
	var head := HBoxContainer.new()
	var t := _wlabel(title, 28, INK)
	t.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	head.add_child(t)
	var x := _icon_button("close")
	x.pressed.connect(overlay.queue_free)
	head.add_child(x)
	vb.add_child(head)
	add_child(overlay)
	return vb

func _confirm_ascend() -> void:
	var s := Ascension.ascension_summary()
	var body := _show_modal("Ascend the World?")
	body.add_child(_wlabel("You will gain +" + str(s.get("gain", 0)) + " Ancient Knowledge.", 20, _accent()))
	body.add_child(_wlabel("This resets:", 18, INK))
	for r in s.get("resets", []):
		body.add_child(_wlabel("  -  " + str(r), 16, INK_SOFT))
	body.add_child(_wlabel("You keep:", 18, INK))
	for k in s.get("keeps", []):
		body.add_child(_wlabel("  -  " + str(k), 16, INK_SOFT))
	var confirm := _btn("Ascend")
	confirm.disabled = not Ascension.can_ascend()
	confirm.pressed.connect(func():
		if Ascension.ascend():
			Game.emit_signal("realm_changed")
		_close_all_modals()
		_close_panel()
	)
	body.add_child(confirm)

func _confirm_reset() -> void:
	var body := _show_modal("Reset the World?")
	var w := _wlabel("This erases ALL progress  -  buildings, kin, research, knowledge and realms  -  and begins again. This cannot be undone.", 17, INK)
	w.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	body.add_child(w)
	var confirm := _btn("Erase everything and start over")
	confirm.add_theme_color_override("font_color", Color("#B5473A"))
	confirm.pressed.connect(func():
		Save.wipe()
		Game.state = Game.new_state()
		Game.save_now()
		Game.emit_signal("realm_changed")
		Game.emit_signal("state_dirty")
		Game.emit_signal("resources_changed")
		_close_all_modals()
		_close_panel()
	)
	body.add_child(confirm)

func _on_offline_ready(summary: Dictionary) -> void:
	var body := _show_modal("While You Were Away")
	body.add_child(_wlabel("You were gone " + Fmt.time_span(summary.get("elapsed", 0.0)) + ".", 20, INK))
	var capped: float = summary.get("capped", 0.0)
	var elapsed: float = summary.get("elapsed", 0.0)
	if capped < elapsed - 1.0:
		body.add_child(_wlabel("(rewarded for " + Fmt.time_span(capped) + "  -  the current cap)", 15, INK_SOFT))
	var earnings: Dictionary = summary.get("earnings", {})
	if earnings.is_empty():
		body.add_child(_wlabel("The island rested quietly.", 17, INK_SOFT))
	else:
		body.add_child(_wlabel("Your kin gathered:", 18, INK))
		for id in earnings.keys():
			var nm: String = GameData.resources_by_id.get(id, {}).get("name", id)
			body.add_child(_wlabel("  +" + Fmt.short(earnings[id]) + "  " + nm, 18, Color(GameData.resources_by_id.get(id, {}).get("color", "#FFFFFF"))))
	var ok := _btn("Welcome back")
	ok.pressed.connect(_close_all_modals)
	body.add_child(ok)

func _close_all_modals() -> void:
	for ch in get_children():
		if ch is Control and ch != _panel and ch != _bar and ch != _strip and ch != _nav and ch != _coach and ch != _toast and not (ch is PanelContainer and ch == _panel):
			if ch.mouse_filter == Control.MOUSE_FILTER_STOP and ch.get_child_count() > 0 and ch.get_child(0) is ColorRect:
				ch.queue_free()

# =============================================================================
# Tutorial
# =============================================================================
func _build_coach() -> void:
	_coach = Control.new()
	add_child(_coach)
	var card := PanelContainer.new()
	card.add_theme_stylebox_override("panel", _sb(Color(INK.r, INK.g, INK.b, 0.92), 18, 12))
	card.set_anchors_preset(Control.PRESET_FULL_RECT)
	_coach.add_child(card)
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 8)
	card.add_child(row)
	_coach_label = _wlabel("", 18, PARCH)
	_coach_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_coach_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	row.add_child(_coach_label)
	var skip := _btn("Skip")
	skip.custom_minimum_size = Vector2(90, 44)
	skip.pressed.connect(func():
		Game.state["tutorial_step"] = 99
		Game.save_now()
		_update_coach()
	)
	row.add_child(skip)
	_coach.visible = false

func _tutorial_text() -> String:
	match int(Game.state.get("tutorial_step", 0)):
		0: return "Welcome. Tap the Heart Tree to wake its magic and gather Essence."
		1: return "Wonderful. Now open Build below to raise your first structure."
		2: return "Build a Lumber Grove  -  the island's first industry."
		3: return "Meet your neighbours. Open Kin and recruit a Blockling."
		4: return "Put your new friend to work  -  assign them to a building."
	return ""

func _update_coach() -> void:
	var step := int(Game.state.get("tutorial_step", 0))
	if step >= 5 or step == 99 or not Game.booted:
		_coach.visible = false
		return
	# Hide the coachmark while a panel covers the lower screen, except when the
	# step is asking the player to act inside that panel.
	if _panel_open and step not in [1]:
		_coach.visible = false
		return
	_coach_label.text = _tutorial_text()
	_coach.visible = _tutorial_text() != ""
	_layout()

func _advance_tutorial(to: int) -> void:
	var step := int(Game.state.get("tutorial_step", 0))
	if step == 99:
		return
	if step < to:
		Game.state["tutorial_step"] = to
		Game.save_now()
		_update_coach()

func _check_tutorial_progress() -> void:
	var step := int(Game.state.get("tutorial_step", 0))
	if step == 2 and Buildings.is_owned("lumber_grove"):
		_advance_tutorial(3)
	elif step == 4:
		var assigned := 0
		for uid in Game.state.get("blocklings", {}).keys():
			if Game.state["blocklings"][uid].get("assigned_to", "") != "":
				assigned += 1
		if assigned >= 2:
			_advance_tutorial(5)

# =============================================================================
# Signal handlers
# =============================================================================
func _on_resources_changed() -> void:
	_refresh_bar()
	_refresh_dynamic()

func _on_state_dirty() -> void:
	_refresh_bar()
	_refresh_strip()
	_rebuild_entities()
	if _panel_open:
		_rebuild_panel_body()
	_check_tutorial_progress()
	_update_coach()
	_refresh_nav()

func _on_realm_changed() -> void:
	if _sky != null:
		_sky.queue_free()
	_sky = PlaceholderArt.realm_sky(_vp, Realms.current_def())
	_world.add_child(_sky)
	_world.move_child(_sky, 0)
	_pick_weather()
	if _has(Audio, "play_music"):
		Audio.play_music(Realms.current())
	_layout_world()
	_refresh_strip()
	_refresh_bar()
	if _panel_open and _current_tab == "world":
		_rebuild_panel_body()

func _on_recruited(_uid: String) -> void:
	_advance_tutorial(4)

func _refresh_dynamic() -> void:
	var alive: Array = []
	for cb in _dyn:
		if cb is Callable and cb.is_valid():
			cb.call()
			alive.append(cb)
	_dyn = alive

func _clear_dyn() -> void:
	_dyn.clear()

# =============================================================================
# Toast
# =============================================================================
func _build_toast() -> void:
	_toast = Label.new()
	_toast.add_theme_font_size_override("font_size", 22)
	_toast.add_theme_color_override("font_color", PARCH)
	_toast.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_toast.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	var sb := _sb(Color(INK.r, INK.g, INK.b, 0.92), 16, 12)
	_toast.add_theme_stylebox_override("normal", sb)
	_toast.modulate.a = 0.0
	add_child(_toast)

func _show_toast(text: String) -> void:
	_toast.text = text
	var w: float = min(_vp.x * 0.86, 680)
	_toast.size = Vector2(w, 0)
	_toast.position = Vector2((_vp.x - w) * 0.5, _vp.y * 0.5)
	if _toast_tween and _toast_tween.is_valid():
		_toast_tween.kill()
	_toast.modulate.a = 1.0
	_toast_tween = create_tween()
	_toast_tween.tween_interval(1.6)
	_toast_tween.tween_property(_toast, "modulate:a", 0.0, 0.5)

# =============================================================================
# Layout (manual, recomputed on resize)
# =============================================================================
func _layout() -> void:
	_bar.position = Vector2(0, 0)
	_bar.size = Vector2(_vp.x, _bar_h)
	var row := _bar.get_node_or_null("row")
	if row:
		row.position = Vector2(8, _inset_top)
		row.size = Vector2(_vp.x - 16, _bar_h - _inset_top)
	_strip.position = Vector2(0, _bar_h)
	_strip.size = Vector2(_vp.x, _strip_h)
	_nav.position = Vector2(0, _vp.y - _nav_h)
	_nav.size = Vector2(_vp.x, _nav_h)
	var nrow := _nav.get_node_or_null("row")
	if nrow:
		nrow.position = Vector2(0, 0)
		nrow.size = Vector2(_vp.x, _nav_h - _inset_bot)
	# panel occupies the lower area but leaves the nav exposed
	var ptop := _panel_top()
	_panel.size = Vector2(_vp.x, _vp.y - _nav_h - ptop + 2)
	_panel.position = Vector2(0, (ptop if _panel_open else _vp.y))
	# coachmark sits just above the nav
	if _coach and _coach.visible:
		var cw: float = _vp.x - 24
		_coach.size = Vector2(cw, 76)
		_coach.position = Vector2(12, _vp.y - _nav_h - 88)
	if _sky:
		_layout_world()

func _panel_top() -> float:
	return _vp.y * 0.40

# =============================================================================
# Small builders / helpers
# =============================================================================
func _accent() -> Color:
	return Color(Realms.current_def().get("accent", "#C9955B"))

func _sb(bg: Color, radius: int, pad: int) -> StyleBoxFlat:
	var s := StyleBoxFlat.new()
	s.bg_color = bg
	s.corner_radius_top_left = radius
	s.corner_radius_top_right = radius
	s.corner_radius_bottom_left = radius
	s.corner_radius_bottom_right = radius
	s.content_margin_left = pad
	s.content_margin_right = pad
	s.content_margin_top = pad
	s.content_margin_bottom = pad
	return s

func _card() -> PanelContainer:
	var c := PanelContainer.new()
	c.add_theme_stylebox_override("panel", _sb(PARCH2, 18, 12))
	c.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	return c

func _wlabel(text: String, fs: int, col: Color) -> Label:
	var l := Label.new()
	l.text = text
	l.add_theme_font_size_override("font_size", fs)
	l.add_theme_color_override("font_color", col)
	return l

func _btn(text: String) -> Button:
	var b := Button.new()
	b.text = text
	b.focus_mode = Control.FOCUS_NONE
	b.custom_minimum_size = Vector2(0, 52)
	b.add_theme_font_size_override("font_size", 20)
	b.add_theme_color_override("font_color", INK)
	b.add_theme_color_override("font_disabled_color", Color(INK.r, INK.g, INK.b, 0.4))
	b.add_theme_color_override("font_hover_color", INK)
	b.add_theme_color_override("font_pressed_color", INK)
	b.add_theme_stylebox_override("normal", _sb(Color("#E7D4A8"), 14, 10))
	b.add_theme_stylebox_override("hover", _sb(Color("#EEDFB8"), 14, 10))
	b.add_theme_stylebox_override("pressed", _sb(Color("#D8C291"), 14, 10))
	b.add_theme_stylebox_override("disabled", _sb(Color("#DED2BC"), 14, 10))
	return b

func _icon_button(glyph_name: String) -> Button:
	var b := Button.new()
	b.flat = true
	b.focus_mode = Control.FOCUS_NONE
	b.custom_minimum_size = Vector2(48, 48)
	var g := _glyph(glyph_name, INK, Vector2(26, 26))
	g.set_anchors_preset(Control.PRESET_CENTER)
	g.position = Vector2(11, 11)
	g.mouse_filter = Control.MOUSE_FILTER_IGNORE
	b.add_child(g)
	return b

func _slider_row(label: String, value: float, on_change: Callable) -> Control:
	var card := _card()
	var vb := VBoxContainer.new()
	card.add_child(vb)
	vb.add_child(_wlabel(label, 19, INK))
	var sl := HSlider.new()
	sl.min_value = 0.0
	sl.max_value = 1.0
	sl.step = 0.05
	sl.value = value
	sl.custom_minimum_size = Vector2(0, 44)
	sl.value_changed.connect(func(v): on_change.call(v))
	vb.add_child(sl)
	return card

func _hsep() -> Control:
	var c := Control.new()
	c.custom_minimum_size = Vector2(0, 6)
	return c

func _vsep() -> Control:
	var c := ColorRect.new()
	c.color = Color(1, 1, 1, 0.25)
	c.custom_minimum_size = Vector2(2, 20)
	return c

func _cost_str(cost: Dictionary) -> String:
	if cost.is_empty():
		return "free"
	var parts: Array = []
	for k in cost.keys():
		var nm: String = GameData.resources_by_id.get(k, {}).get("name", k)
		parts.append(Fmt.short(float(cost[k])) + " " + nm)
	return "  ".join(parts)

func _art_thumb(node2d: Node2D, box: float) -> Control:
	var c := Control.new()
	c.custom_minimum_size = Vector2(box, box)
	node2d.position = Vector2(box * 0.5, box * 0.86)
	var s: float = box / 70.0
	node2d.scale = Vector2(s, s)
	c.add_child(node2d)
	return c

func _circle_poly(radius: float, color: Color, segs: int) -> Polygon2D:
	var p := Polygon2D.new()
	var pts := PackedVector2Array()
	for i in range(segs):
		var a := TAU * float(i) / float(segs)
		pts.append(Vector2(cos(a), sin(a)) * radius)
	p.polygon = pts
	p.color = color
	return p

func _glyph(name: String, col: Color, box: Vector2) -> Control:
	var g := _Glyph.new()
	g.g = name
	g.col = col
	g.custom_minimum_size = box
	g.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return g

func _has(obj, method: String) -> bool:
	return is_instance_valid(obj) and obj.has_method(method)

func _play_sfx(name: String) -> void:
	if _has(Audio, "play_sfx"):
		Audio.play_sfx(name)

# ---- cosmetics / IAP (defensive: those autoloads are built elsewhere) -------
func _iap_available() -> bool:
	if _has(IAP, "available"):
		return bool(IAP.available())
	return false

func _cosmetic_items() -> Array:
	for m in ["all_items", "catalog", "items", "all", "list"]:
		if _has(Cosmetics, m):
			var r = Cosmetics.call(m)
			if r is Array:
				return r
	return []

func _cosmetic_owned(id: String) -> bool:
	if id == "":
		return false
	if Game.state.get("cosmetics", {}).get(id, false):
		return true
	for m in ["is_owned", "owned"]:
		if _has(Cosmetics, m):
			return bool(Cosmetics.call(m, id))
	return false


# =============================================================================
# Inline vector glyphs (nav icons, resource swatches, close button)
# =============================================================================
class _Glyph extends Control:
	var g := ""
	var col := Color.WHITE

	func _draw() -> void:
		var s := size
		var c := s * 0.5
		var u: float = min(s.x, s.y)
		match g:
			"spark", "star":
				_star(c, u * 0.48, u * 0.2)
			"log":
				draw_rect(Rect2(c - Vector2(u * 0.42, u * 0.16), Vector2(u * 0.84, u * 0.32)), col)
				draw_circle(c + Vector2(u * 0.42, 0), u * 0.16, col.lightened(0.2))
			"block":
				draw_rect(Rect2(c - Vector2(u * 0.34, u * 0.3), Vector2(u * 0.68, u * 0.6)), col)
			"gem":
				draw_colored_polygon(PackedVector2Array([
					c + Vector2(0, -u * 0.42), c + Vector2(u * 0.36, -u * 0.1),
					c + Vector2(0, u * 0.42), c + Vector2(-u * 0.36, -u * 0.1)]), col)
			"rune":
				draw_circle(c, u * 0.4, Color(col.r, col.g, col.b, 0.35))
				draw_arc(c, u * 0.4, 0, TAU, 20, col, u * 0.08)
				draw_line(c + Vector2(0, -u * 0.22), c + Vector2(0, u * 0.22), col, u * 0.08)
			"close":
				draw_line(c + Vector2(-u * 0.26, -u * 0.26), c + Vector2(u * 0.26, u * 0.26), col, 4.0)
				draw_line(c + Vector2(u * 0.26, -u * 0.26), c + Vector2(-u * 0.26, u * 0.26), col, 4.0)
			"nav_world":
				draw_arc(c, u * 0.4, 0, TAU, 24, col, 3.0)
				draw_line(c + Vector2(-u * 0.4, 0), c + Vector2(u * 0.4, 0), col, 2.0)
				_leaf(c + Vector2(0, -u * 0.08), u * 0.22)
			"nav_block":
				draw_circle(c + Vector2(0, u * 0.05), u * 0.3, col)
				_tri(c + Vector2(-u * 0.28, -u * 0.12), c + Vector2(-u * 0.38, -u * 0.4), c + Vector2(-u * 0.08, -u * 0.22))
				_tri(c + Vector2(u * 0.28, -u * 0.12), c + Vector2(u * 0.38, -u * 0.4), c + Vector2(u * 0.08, -u * 0.22))
			"nav_build":
				draw_rect(Rect2(c - Vector2(u * 0.3, 0), Vector2(u * 0.6, u * 0.36)), col)
				_tri(c + Vector2(-u * 0.38, 0), c + Vector2(0, -u * 0.34), c + Vector2(u * 0.38, 0))
			"nav_research":
				draw_rect(Rect2(c - Vector2(u * 0.32, u * 0.3), Vector2(u * 0.64, u * 0.6)), col)
				draw_line(c + Vector2(0, -u * 0.3), c + Vector2(0, u * 0.3), col.lightened(0.4), 2.0)
			"nav_collect":
				for ix in [-1, 0, 1]:
					for iy in [-1, 1]:
						draw_rect(Rect2(c + Vector2(ix * u * 0.26 - u * 0.1, iy * u * 0.2 - u * 0.1), Vector2(u * 0.2, u * 0.2)), col)
			_:
				draw_circle(c, u * 0.3, col)

	func _star(ctr: Vector2, outer: float, inner: float) -> void:
		var pts := PackedVector2Array()
		for i in range(10):
			var a := -PI / 2 + i * PI / 5
			var r := outer if i % 2 == 0 else inner
			pts.append(ctr + Vector2(cos(a), sin(a)) * r)
		draw_colored_polygon(pts, col)

	func _tri(a: Vector2, b: Vector2, cc: Vector2) -> void:
		draw_colored_polygon(PackedVector2Array([a, b, cc]), col)

	func _leaf(ctr: Vector2, r: float) -> void:
		draw_colored_polygon(PackedVector2Array([
			ctr + Vector2(0, -r), ctr + Vector2(r * 0.7, 0), ctr + Vector2(0, r), ctr + Vector2(-r * 0.7, 0)]), col)
