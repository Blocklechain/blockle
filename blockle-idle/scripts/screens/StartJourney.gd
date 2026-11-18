class_name StartJourney
extends Control
# StartJourney — the menu-less OPENING EXPERIENCE for Blockle Idle.
#
# There is no title screen, no "New Game" button, no settings wall. The player
# wakes into a vast, slow, procedural void — a breathing night-sky of drifting
# cloud and soft motes — and is asked exactly ONE poetic question:
#
#       "Where do you start your journey?"
#
# Whatever they type is fed through Proc.seed_from_text() → a 63-bit world_seed
# that is written into Game.state.world_seed. From that single sentence the whole
# world is born, and this screen PLAYS that birth as a gorgeous one-shot cinematic:
#
#   the typed words gather into a single glowing seed ·
#   the seed falls into the dark and blooms ·
#   a tiny island unfurls out of the light ·
#   the Heart Tree sprouts from its crown and wakes ·
#   the first flower opens, the first little Blockling hops into being ·
#   fireflies rise · and the world is handed off to the live stage.
#
# Everything obeys the seven hard rules (CONVENTIONS.md): seeded + limitless,
# smooth storybook shapes, continuous growth (we drive ProcNode.grow_to across the
# cinematic), alive (slow drift / twinkle / sway), cheap (tween + shader + a few
# analytic _draw overlays), portrait, feet-at-origin for the standing things.
#
# It composes the existing proc modules rather than re-drawing the world:
#   ProcSky · ProcTerrain · ProcHeartTree · ProcPlants · ProcCreatures ·
#   ProcAmbience · ProcEffects.make_world_birth.
#
# ---------------------------------------------------------------------------
# PUBLIC API
# ---------------------------------------------------------------------------
#   signal journey_begun(world_seed: int)     # fired the instant the seed is chosen
#   signal world_ready(world_seed: int)       # fired when the birth cinematic ends
#
#   static func needs_intro() -> bool          # true for a brand-new, unseeded world
#   static func mark_done() -> void            # stamp Game.state so it never shows again
#   static func attach(parent: Node) -> StartJourney   # convenience mount
#
#   func skip() -> void                        # fast-forward the cinematic to the hand-off
#
# See the INTEGRATION NOTE returned to Main's owner for wiring.

signal journey_begun(world_seed: int)
signal world_ready(world_seed: int)

# ---- state keys we own inside Game.state (free-form dict; no autoload edits) -
const K_DONE := "journey_done"         # bool  — intro has been completed
const K_GENESIS := "world_genesis"     # float — unix time the world was born (age clock)
const K_ORIGIN := "journey_origin"     # String — the exact phrase the player typed

# ---- palette (diegetic ink-on-parchment, but luminous for the void) ---------
const INK := Color("#EAE4D3")
const INK_SOFT := Color(0.92, 0.90, 0.82, 0.62)
const GOLD := Color(1.0, 0.92, 0.66, 1.0)
const GOLD_HI := Color(1.0, 0.99, 0.90, 1.0)

# A stable "before the world exists" seed so the empty void always looks the same
# calm way until the player's words give it a true identity.
const VOID_SEED := 880011

# Gentle example phrasings that ghost through the field to invite an answer. They
# never pre-fill; they only whisper what kind of thing one might say.
const INVITATIONS := [
	"a quiet northern shore",
	"under the twin moons",
	"where the last river ends",
	"a warm hollow in the hills",
	"the first morning",
	"somewhere the light pools",
	"beneath an old, kind tree",
	"at the edge of the map",
]

# ---- layout -----------------------------------------------------------------
var _vp := Vector2(1080, 1920)
var _birth := Vector2(540, 1180)        # where the world is born on screen

# ---- nodes ------------------------------------------------------------------
var _sky_void: ProcNode                 # the pre-world night sky
var _sky_world: ProcNode                # the typed world's own sky (fades in)
var _stars: _Starfield                  # drifting mote/star field overlay
var _veil: _Veil                        # vignette + horizon glow + flash overlay
var _ask_wrap: Control                  # holds the question + the field
var _q_label: Label                     # the question
var _q_glow: Label                      # a soft duplicate behind it for bloom
var _field: LineEdit
var _underline: _Underline
var _hint: Label                        # ghosting invitation
var _begin_dot: _BeginDot               # the glowing "press to begin" affordance
var _echo: Label                        # the typed words, echoed as they dissolve

var _stage: Node2D                      # the cinematic world layer (feet-at-origin here)
var _seed_mote: _SeedMote
var _island: ProcNode
var _tree: ProcNode
var _life: Array = []                   # first flowers + creature
var _whisper_layer: Control

# ---- flow -------------------------------------------------------------------
var _world_seed := 0
var _phase := 0                         # 0 asking · 1..6 cinematic · 9 done
var _master: Tween
var _hint_tw: Tween
var _finished := false
var _skippable := false

# =============================================================================
# STATIC — should this screen appear at all?
# =============================================================================

static func needs_intro() -> bool:
	if Game == null or typeof(Game.state) != TYPE_DICTIONARY:
		return true
	if bool(Game.state.get(K_DONE, false)):
		return false
	# A world with any placed/owned life beyond the gift-start has clearly been
	# played; only a truly fresh save gets the birth.
	return true

static func mark_done() -> void:
	if Game and typeof(Game.state) == TYPE_DICTIONARY:
		Game.state[K_DONE] = true
		if not Game.state.has(K_GENESIS):
			Game.state[K_GENESIS] = Time.get_unix_time_from_system()
		if Game.has_method("save_now"):
			Game.save_now()

# Convenience: build, mount on top of `parent`, return it (connect its signals).
static func attach(parent: Node) -> StartJourney:
	var sj := StartJourney.new()
	parent.add_child(sj)
	parent.move_child(sj, parent.get_child_count() - 1)   # top of the z-stack
	return sj

# =============================================================================
# BUILD
# =============================================================================

func _ready() -> void:
	set_anchors_preset(Control.PRESET_FULL_RECT)
	mouse_filter = Control.MOUSE_FILTER_STOP      # we own all input while open
	_vp = get_viewport_rect().size
	_birth = Vector2(_vp.x * 0.5, _vp.y * 0.60)
	process_mode = Node.PROCESS_MODE_ALWAYS

	_build_void_sky()
	_build_starfield()
	_build_stage_layer()
	_build_veil()
	_build_question()
	_build_whisper_layer()

	get_viewport().size_changed.connect(_on_resized)

	# Ease the whole screen up from black, then breathe the question in.
	modulate.a = 0.0
	var tw := create_tween()
	tw.tween_property(self, "modulate:a", 1.0, 1.4).set_trans(Tween.TRANS_SINE)
	tw.tween_callback(_reveal_question)

func _on_resized() -> void:
	_vp = get_viewport_rect().size
	_birth = Vector2(_vp.x * 0.5, _vp.y * 0.60)
	_layout()

func _build_void_sky() -> void:
	# A hushed, barely-advancing night: deep, cool, a thin mist. This is the world
	# "before it has a name" — it gains its true colours only once the seed is cast.
	var opts := {
		"time_of_day": 0.04,
		"auto_advance": false,
		"weather": "mist",
		"cloud_style": "stratus",
		"aurora": true,
		"start_growth": 0.72,
		"grow_minutes": 999.0,
		"sky": ["#0B1026", "#171B3A", "#2A2E55"],
		"accent": "#9FB4FF",
	}
	_sky_void = ProcSky.make(VOID_SEED, "void", _vp, opts)
	_sky_void.z_index = -100
	add_child(_sky_void)

func _build_starfield() -> void:
	_stars = _Starfield.new()
	_stars.vp = _vp
	_stars.seedv = VOID_SEED
	_stars.z_index = -60
	add_child(_stars)

func _build_stage_layer() -> void:
	_stage = Node2D.new()
	_stage.z_index = 0
	_stage.position = _birth
	add_child(_stage)

func _build_veil() -> void:
	# A single cheap overlay for the vignette, a warm pool of ground-light, and the
	# white birth-flash. It reads one shared value `flash` the cinematic drives.
	_veil = _Veil.new()
	_veil.vp = _vp
	_veil.z_index = 80
	add_child(_veil)

func _build_question() -> void:
	_ask_wrap = Control.new()
	_ask_wrap.set_anchors_preset(Control.PRESET_FULL_RECT)
	_ask_wrap.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_ask_wrap.z_index = 40
	add_child(_ask_wrap)

	# The soft bloom behind the words (a blurred twin via alpha + scale).
	_q_glow = _make_title_label(GOLD)
	_q_glow.modulate = Color(GOLD.r, GOLD.g, GOLD.b, 0.0)
	_q_glow.scale = Vector2(1.06, 1.06)
	_ask_wrap.add_child(_q_glow)

	_q_label = _make_title_label(INK)
	_q_label.modulate.a = 0.0
	_ask_wrap.add_child(_q_label)

	# The single text field — transparent, centered, diegetic. No box, no chrome;
	# just luminous letters over a drawn, shimmering underline.
	_field = LineEdit.new()
	_field.alignment = HORIZONTAL_ALIGNMENT_CENTER
	_field.placeholder_text = ""
	_field.context_menu_enabled = false
	_field.caret_blink = true
	_field.caret_blink_interval = 0.9
	_field.expand_to_text_length = false
	_field.max_length = 48
	_field.clear_button_enabled = false
	_field.flat = true
	_field.add_theme_color_override("font_color", GOLD_HI)
	_field.add_theme_color_override("font_placeholder_color", Color(1, 1, 1, 0.22))
	_field.add_theme_color_override("caret_color", GOLD)
	_field.add_theme_color_override("font_selected_color", Color(0.1, 0.12, 0.2))
	_field.add_theme_color_override("selection_color", Color(GOLD.r, GOLD.g, GOLD.b, 0.35))
	_field.add_theme_font_size_override("font_size", 52)
	var empty := StyleBoxEmpty.new()
	_field.add_theme_stylebox_override("normal", empty)
	_field.add_theme_stylebox_override("focus", empty)
	_field.add_theme_stylebox_override("read_only", empty)
	_field.modulate.a = 0.0
	_field.text_submitted.connect(_on_submit)
	_field.text_changed.connect(_on_text_changed)
	_ask_wrap.add_child(_field)

	_underline = _Underline.new()
	_underline.modulate.a = 0.0
	_ask_wrap.add_child(_underline)

	# A faint ghosting invitation under the line (cycles slowly, never pre-fills).
	_hint = Label.new()
	_hint.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_hint.add_theme_color_override("font_color", Color(1, 1, 1, 0.34))
	_hint.add_theme_font_size_override("font_size", 30)
	_hint.modulate.a = 0.0
	_ask_wrap.add_child(_hint)

	# The "begin" affordance — a quiet pulsing dot that only wakes once you've
	# written something. Tapping it (or pressing return) casts the seed.
	_begin_dot = _BeginDot.new()
	_begin_dot.modulate.a = 0.0
	_begin_dot.pressed.connect(_commit_from_field)
	_ask_wrap.add_child(_begin_dot)

	# The echo of the typed words as they lift off and dissolve into the seed.
	_echo = _make_title_label(GOLD_HI)
	_echo.add_theme_font_size_override("font_size", 56)
	_echo.modulate.a = 0.0
	_ask_wrap.add_child(_echo)

	_layout()

func _build_whisper_layer() -> void:
	_whisper_layer = Control.new()
	_whisper_layer.set_anchors_preset(Control.PRESET_FULL_RECT)
	_whisper_layer.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_whisper_layer.z_index = 70
	add_child(_whisper_layer)

func _make_title_label(col: Color) -> Label:
	var l := Label.new()
	l.text = "Where do you start\nyour journey?"
	l.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	l.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	l.autowrap_mode = TextServer.AUTOWRAP_OFF
	l.add_theme_color_override("font_color", col)
	l.add_theme_font_size_override("font_size", 66)
	l.add_theme_constant_override("line_spacing", 12)
	l.set_anchors_preset(Control.PRESET_FULL_RECT)
	l.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return l

func _layout() -> void:
	if _ask_wrap == null:
		return
	var cx := _vp.x * 0.5
	var qy := _vp.y * 0.30
	for lbl: Label in [_q_label, _q_glow]:
		lbl.size = Vector2(_vp.x, 220)
		lbl.position = Vector2(0, qy - 110)
		lbl.pivot_offset = lbl.size * 0.5
	var fy := _vp.y * 0.49
	_field.size = Vector2(_vp.x * 0.82, 86)
	_field.position = Vector2(cx - _field.size.x * 0.5, fy - 43)
	if _underline:
		_underline.span = _vp.x * 0.62
		_underline.position = Vector2(cx, fy + 46)
	_hint.size = Vector2(_vp.x, 44)
	_hint.position = Vector2(0, fy + 70)
	if _begin_dot:
		_begin_dot.position = Vector2(cx, fy + 168)
	_echo.size = Vector2(_vp.x, 120)
	_echo.position = Vector2(0, fy - 60)
	_echo.pivot_offset = Vector2(_vp.x * 0.5, 60)

# =============================================================================
# ASKING
# =============================================================================

func _reveal_question() -> void:
	_phase = 0
	var tw := create_tween().set_parallel(true)
	tw.tween_property(_q_label, "modulate:a", 1.0, 1.6).set_trans(Tween.TRANS_SINE)
	tw.tween_property(_q_glow, "modulate:a", 0.5, 1.8).set_trans(Tween.TRANS_SINE)
	tw.chain().tween_property(_field, "modulate:a", 1.0, 1.0)
	tw.parallel().tween_property(_underline, "modulate:a", 1.0, 1.0)
	tw.parallel().tween_property(_hint, "modulate:a", 1.0, 1.2)
	tw.chain().tween_callback(func():
		_field.grab_focus()
		_cycle_hint())

func _cycle_hint() -> void:
	if _phase != 0:
		return
	if _hint_tw and _hint_tw.is_valid():
		_hint_tw.kill()
	var idx := int(Proc.hashf(VOID_SEED, "hint:%d" % int(Time.get_ticks_msec() / 1000.0)) * INVITATIONS.size())
	_hint.text = "“" + INVITATIONS[idx % INVITATIONS.size()] + "”"
	_hint.modulate.a = 0.0
	_hint_tw = create_tween()
	_hint_tw.tween_property(_hint, "modulate:a", 0.4, 1.4)
	_hint_tw.tween_interval(3.2)
	_hint_tw.tween_property(_hint, "modulate:a", 0.0, 1.4)
	_hint_tw.tween_callback(_cycle_hint)

func _on_text_changed(txt: String) -> void:
	var has := txt.strip_edges() != ""
	if _hint:
		_hint.visible = not has
	if _begin_dot:
		_begin_dot.set_ready(has)
		var tw := create_tween()
		tw.tween_property(_begin_dot, "modulate:a", (1.0 if has else 0.0), 0.5)
	if _underline:
		_underline.energize(has)

func _on_submit(_txt: String) -> void:
	_commit_from_field()

func _commit_from_field() -> void:
	if _phase != 0:
		return
	var phrase := _field.text.strip_edges()
	if phrase == "":
		phrase = INVITATIONS[int(Proc.hashf(VOID_SEED, "fallback") * INVITATIONS.size()) % INVITATIONS.size()]
	begin_journey(phrase)

# The one true entry point: turn a phrase into a world and play its birth.
func begin_journey(phrase: String) -> void:
	if _phase != 0:
		return
	_phase = 1
	_world_seed = Proc.seed_from_text(phrase)

	# Persist the identity of this world immediately (non-destructive keys only).
	if Game and typeof(Game.state) == TYPE_DICTIONARY:
		Game.state["world_seed"] = _world_seed
		Game.state[K_ORIGIN] = phrase
		Game.state[K_GENESIS] = Time.get_unix_time_from_system()
		if Game.has_method("save_now"):
			Game.save_now()

	emit_signal("journey_begun", _world_seed)

	_field.release_focus()
	_field.editable = false
	if _hint_tw and _hint_tw.is_valid():
		_hint_tw.kill()
	_play_birth(phrase)

# =============================================================================
# THE WORLD-BIRTH CINEMATIC
# =============================================================================

func _play_birth(phrase: String) -> void:
	_skippable = true

	# 1) The world's TRUE sky, derived from the seed, fades in beneath everything.
	var realm := "verdant"
	if Game and typeof(Game.state) == TYPE_DICTIONARY:
		realm = String(Game.state.get("realm", "verdant"))
	_sky_world = ProcSky.make_for_realm(_world_seed, realm, _vp, {
		"time_of_day": 0.26, "auto_advance": true, "start_growth": 0.55,
		"grow_minutes": 60.0, "weather": "clear",
	})
	_sky_world.z_index = -98
	_sky_world.modulate.a = 0.0
	add_child(_sky_world)
	move_child(_sky_world, 1)

	# 2) The typed words rise off the line, brighten, and gather to a single point.
	_echo.text = _wrap_phrase(phrase)
	_echo.modulate = Color(GOLD_HI.r, GOLD_HI.g, GOLD_HI.b, 0.0)
	_echo.scale = Vector2.ONE

	# 3) The seed-mote that the words become.
	_seed_mote = _SeedMote.new()
	_seed_mote.z_index = 50
	_seed_mote.position = Vector2(_vp.x * 0.5, _vp.y * 0.49)
	_seed_mote.brightness = 0.0
	add_child(_seed_mote)

	_master = create_tween()

	# --- fade the question furniture away -----------------------------------
	_master.set_parallel(true)
	_master.tween_property(_q_label, "modulate:a", 0.0, 0.9)
	_master.tween_property(_q_glow, "modulate:a", 0.0, 0.9)
	_master.tween_property(_underline, "modulate:a", 0.0, 0.7)
	_master.tween_property(_hint, "modulate:a", 0.0, 0.5)
	_master.tween_property(_begin_dot, "modulate:a", 0.0, 0.5)
	_master.tween_property(_field, "modulate:a", 0.0, 0.6)
	_master.tween_property(_sky_world, "modulate:a", 1.0, 2.6)
	_master.tween_property(_sky_void, "modulate:a", 0.25, 2.6)

	# --- the words bloom, then lift + shrink into the seed ------------------
	_master.chain().tween_property(_echo, "modulate:a", 1.0, 0.8)
	_master.parallel().tween_property(_seed_mote, "brightness", 0.35, 0.8)
	_master.chain().tween_interval(0.5)
	_master.chain().tween_property(_echo, "modulate:a", 0.0, 1.1).set_trans(Tween.TRANS_SINE)
	_master.parallel().tween_property(_echo, "scale", Vector2(0.12, 0.12), 1.1).set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_IN)
	_master.parallel().tween_property(_echo, "position:y", _echo.position.y - 30.0, 1.1)
	_master.parallel().tween_property(_seed_mote, "brightness", 1.0, 1.1)

	# --- the seed falls into the dark toward the birth point ----------------
	_master.chain().tween_property(_seed_mote, "position", _birth + Vector2(0, -60), 1.4).set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_IN_OUT)
	_master.parallel().tween_property(_seed_mote, "fall", 1.0, 1.4)
	_master.chain().tween_callback(_beat_bloom)

func _beat_bloom() -> void:
	# The seed touches down and BLOOMS: a white flash + the grand birth burst.
	_phase = 2
	_flash(0.9, 0.12, 0.9)
	var birth := ProcEffects.make_world_birth(_world_seed, "genesis", {
		"radius": max(_vp.x, _vp.y) * 0.62, "life": 2.9, "z": 60,
	})
	birth.position = _birth
	add_child(birth)
	if _seed_mote:
		var tw := create_tween()
		tw.tween_property(_seed_mote, "brightness", 0.0, 0.5)
		tw.tween_callback(_seed_mote.queue_free)
		_seed_mote = null

	# The island begins to unfurl out of the light a half-beat later.
	var t := create_tween()
	t.tween_interval(0.55)
	t.tween_callback(_beat_island)

func _beat_island() -> void:
	_phase = 3
	var realm := "verdant"
	if Game and typeof(Game.state) == TYPE_DICTIONARY:
		realm = String(Game.state.get("realm", "verdant"))
	_island = ProcTerrain.make(_world_seed, "genesis", 300.0, realm, 0)
	_island.growth = 0.0
	_island.modulate.a = 0.0
	_stage.add_child(_island)
	_stage.scale = Vector2(0.84, 0.84)      # the whole little world swells in
	var t := create_tween().set_parallel(true)
	t.tween_property(_island, "modulate:a", 1.0, 1.0)
	t.tween_property(_stage, "scale", Vector2.ONE, 2.2).set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
	# unfurl the land over ~2.4s (its own grow_rate is 8h; we drive it by hand here)
	_island.grow_to(1.0, 2.4)
	_whisper("From “" + _origin_phrase() + "”, an island.", 2.2, 0.56)
	t.chain().tween_interval(1.4)
	t.chain().tween_callback(_beat_tree)

func _beat_tree() -> void:
	_phase = 4
	var realm := "verdant"
	if Game and typeof(Game.state) == TYPE_DICTIONARY:
		realm = String(Game.state.get("realm", "verdant"))
	_tree = ProcHeartTree.make_for_realm(_world_seed, "genesis", realm)
	_tree.growth = 0.0
	_tree.position = Vector2(0, -6)          # feet at the island's crown
	_stage.add_child(_tree)
	_tree.grow_to(1.0, 2.6)
	_flash(0.4, 0.2, 1.1)                     # a gentle pulse of the tree's first light
	_whisper("The Heart Tree wakes.", 2.2, 0.7)
	var t := create_tween()
	t.tween_interval(2.0)
	t.tween_callback(_beat_life)

func _beat_life() -> void:
	_phase = 5
	# The first flower opens beside the roots, then the first little Blockling hops
	# into being — the world is no longer empty.
	var ctx := { "light_dir": Vector2(-0.4, -1).normalized() }
	var flower := ProcPlants.wildflower(_world_seed, "first_bloom", ctx)
	flower.position = Vector2(-70, 2)
	flower.growth = 0.0
	_stage.add_child(flower)
	flower.grow_to(1.0, 1.6)
	_life.append(flower)

	var sprout2 := ProcPlants.make(_world_seed, "first_tuft", "grasstuft", ctx)
	sprout2.position = Vector2(64, 4)
	sprout2.growth = 0.0
	_stage.add_child(sprout2)
	sprout2.grow_to(1.0, 1.4)
	_life.append(sprout2)

	var t := create_tween()
	t.tween_interval(0.7)
	t.tween_callback(func():
		var pip := ProcCreatures.make(_world_seed, "firstborn", "pip", {})
		pip.position = Vector2(40, 2)
		pip.growth = 0.0
		_stage.add_child(pip)
		pip.pop_in(1.1)
		_life.append(pip)
		_spawn_fireflies())
	t.tween_interval(1.1)
	t.tween_callback(func(): _whisper("And something small, alive.", 2.0, 0.6))
	t.tween_interval(1.8)
	t.tween_callback(_beat_handoff)

func _spawn_fireflies() -> void:
	var fld := ProcAmbience.make_fireflies(_world_seed, "genesis_glow",
		Vector2(_vp.x, _vp.y * 0.5), { "count": 14 })
	fld.position = Vector2(_vp.x * 0.5 - _birth.x, _vp.y * 0.28 - _birth.y)
	fld.z_index = 6
	_stage.add_child(fld)

func _beat_handoff() -> void:
	_phase = 6
	_whisper("Your world begins.", 2.4, 0.9)
	var t := create_tween()
	t.tween_interval(1.7)
	t.tween_callback(_finish)

# =============================================================================
# FINISH / SKIP
# =============================================================================

# Fast-forward straight to the hand-off (a calm tap anywhere, like the offline wake).
func skip() -> void:
	if not _skippable or _finished or _phase >= 6:
		return
	if _master and _master.is_valid():
		_master.kill()
	# Snap the world into its fully-born state so the hand-off is seamless.
	if _sky_world:
		_sky_world.modulate.a = 1.0
	if _sky_void:
		_sky_void.modulate.a = 0.22
	if _seed_mote:
		_seed_mote.queue_free()
		_seed_mote = null
	if _echo:
		_echo.modulate.a = 0.0
	for c: CanvasItem in [_q_label, _q_glow, _underline, _hint, _begin_dot, _field]:
		if c:
			c.modulate.a = 0.0
	_stage.scale = Vector2.ONE
	if _island == null:
		var realm := String(Game.state.get("realm", "verdant")) if (Game and typeof(Game.state) == TYPE_DICTIONARY) else "verdant"
		_island = ProcTerrain.make(_world_seed, "genesis", 300.0, realm, 0)
		_stage.add_child(_island)
	_island.set_growth(1.0)
	if _tree == null:
		var realm2 := String(Game.state.get("realm", "verdant")) if (Game and typeof(Game.state) == TYPE_DICTIONARY) else "verdant"
		_tree = ProcHeartTree.make_for_realm(_world_seed, "genesis", realm2)
		_tree.position = Vector2(0, -6)
		_stage.add_child(_tree)
	_tree.set_growth(1.0)
	_phase = 6
	_finish()

func _finish() -> void:
	if _finished:
		return
	_finished = true
	_phase = 9
	StartJourney.mark_done()
	emit_signal("world_ready", _world_seed)
	# Dissolve the cinematic away so whatever Main reveals underneath takes over.
	var tw := create_tween()
	tw.tween_property(self, "modulate:a", 0.0, 1.2).set_trans(Tween.TRANS_SINE)
	tw.tween_callback(queue_free)

# =============================================================================
# HELPERS
# =============================================================================

func _unhandled_input(ev: InputEvent) -> void:
	# A tap anywhere during the cinematic gently skips to the hand-off.
	if not (_phase >= 1 and _phase < 6 and _skippable):
		return
	var tapped := false
	if ev is InputEventScreenTouch and (ev as InputEventScreenTouch).pressed:
		tapped = true
	elif ev is InputEventMouseButton and (ev as InputEventMouseButton).pressed:
		tapped = true
	if tapped:
		skip()
		accept_event()

func _flash(peak: float, up: float, down: float) -> void:
	if _veil == null:
		return
	var tw := create_tween()
	tw.tween_property(_veil, "flash", peak, up).set_trans(Tween.TRANS_SINE)
	tw.tween_property(_veil, "flash", 0.0, down).set_trans(Tween.TRANS_SINE)

func _whisper(text: String, hold: float = 2.0, rise: float = 0.6) -> void:
	if _whisper_layer == null:
		return
	var l := Label.new()
	l.text = text
	l.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	l.add_theme_color_override("font_color", INK)
	l.add_theme_color_override("font_outline_color", Color(0, 0, 0, 0.5))
	l.add_theme_constant_override("outline_size", 6)
	l.add_theme_font_size_override("font_size", 40)
	l.size = Vector2(_vp.x, 60)
	l.position = Vector2(0, _vp.y * 0.80)
	l.modulate = Color(1, 1, 1, 0.0)
	_whisper_layer.add_child(l)
	var y0 := l.position.y
	var tw := create_tween()
	tw.tween_property(l, "modulate:a", rise, 0.9)
	tw.parallel().tween_property(l, "position:y", y0 - 26.0, 0.9)
	tw.tween_interval(hold)
	tw.tween_property(l, "modulate:a", 0.0, 1.0)
	tw.parallel().tween_property(l, "position:y", y0 - 56.0, 1.0)
	tw.tween_callback(l.queue_free)

func _origin_phrase() -> String:
	if Game and typeof(Game.state) == TYPE_DICTIONARY:
		return String(Game.state.get(K_ORIGIN, "the first morning"))
	return "the first morning"

func _wrap_phrase(p: String) -> String:
	# Keep the echoed phrase to a tidy two-line block.
	if p.length() <= 22:
		return p
	var words := p.split(" ")
	var a := ""
	var b := ""
	for w in words:
		if a.length() < p.length() / 2.0:
			a += (" " if a != "" else "") + w
		else:
			b += (" " if b != "" else "") + w
	return a + "\n" + b

# =============================================================================
# INNER VISUAL CLASSES  (all math-drawn, cheap, alive)
# =============================================================================

# ---- drifting star / mote field --------------------------------------------
class _Starfield extends Node2D:
	var vp := Vector2(1080, 1920)
	var seedv := 1
	var _stars: Array = []            # {pos, r, tw, sp, col, drift}
	var _t := 0.0

	func _ready() -> void:
		var r := Proc.rng(seedv, "stars")
		var n := 150
		for i in range(n):
			var deep := r.randf()
			_stars.append({
				"pos": Vector2(r.randf() * vp.x, r.randf() * vp.y),
				"r": lerpf(0.8, 2.6, deep * deep),
				"tw": r.randf() * TAU,
				"sp": r.randf_range(0.6, 2.2),
				"drift": r.randf_range(2.0, 10.0) * (0.4 + deep),
				"col": Color.from_hsv(r.randf_range(0.55, 0.72), r.randf_range(0.0, 0.3),
					r.randf_range(0.7, 1.0)),
			})
		# a few soft nebula puffs for depth
		for i in range(5):
			_stars.append({
				"pos": Vector2(r.randf() * vp.x, r.randf() * vp.y * 0.7),
				"r": r.randf_range(90.0, 180.0), "tw": r.randf() * TAU,
				"sp": r.randf_range(0.2, 0.5), "drift": r.randf_range(1.0, 3.0),
				"col": Color.from_hsv(r.randf_range(0.6, 0.8), 0.5, 0.5, 0.05),
			})
		set_process(true)

	func _process(delta: float) -> void:
		_t += delta
		queue_redraw()

	func _draw() -> void:
		for s in _stars:
			var tw: float = 0.5 + 0.5 * sin(_t * s["sp"] + s["tw"])
			var p: Vector2 = s["pos"]
			p.x = fposmod(p.x + _t * s["drift"] * 0.3, vp.x)
			var col: Color = s["col"]
			if s["r"] > 40.0:
				# nebula puff
				for k in range(3):
					var rr: float = s["r"] * (1.0 - k * 0.3)
					draw_circle(p, rr, Color(col.r, col.g, col.b, col.a * (0.6 + 0.4 * tw)))
			else:
				var a := col.a * (0.35 + 0.65 * tw)
				draw_circle(p, s["r"] * 2.2, Color(col.r, col.g, col.b, a * 0.18))
				draw_circle(p, s["r"], Color(col.r, col.g, col.b, a))

# ---- vignette + ground-glow + birth flash -----------------------------------
class _Veil extends Node2D:
	var vp := Vector2(1080, 1920)
	var flash := 0.0                  # 0..1, driven by the cinematic

	func _ready() -> void:
		set_process(true)

	func _process(_delta: float) -> void:
		if flash > 0.0:
			queue_redraw()

	func _draw() -> void:
		# soft dark vignette corners (cheap stacked rings from the edge)
		var cx := vp * 0.5
		var maxr := vp.length() * 0.62
		for i in range(6):
			var k := float(i) / 5.0
			var rr: float = lerpf(maxr, maxr * 0.55, k)
			draw_circle(cx, rr, Color(0, 0, 0, 0.05 * (1.0 - k)))
		if flash > 0.001:
			draw_rect(Rect2(Vector2.ZERO, vp), Color(1, 1, 1, clampf(flash, 0.0, 1.0) * 0.9))

# ---- the shimmering underline beneath the field -----------------------------
class _Underline extends Node2D:
	const _GOLD := Color(1.0, 0.92, 0.66, 1.0)
	var span := 640.0
	var _t := 0.0
	var _energy := 0.35

	func _ready() -> void:
		set_process(true)

	func energize(on: bool) -> void:
		var tw := create_tween()
		tw.tween_property(self, "_energy", (1.0 if on else 0.35), 0.5)

	func _process(delta: float) -> void:
		_t += delta
		queue_redraw()

	func _draw() -> void:
		var half := span * 0.5
		# base line
		draw_line(Vector2(-half, 0), Vector2(half, 0), Color(1, 1, 1, 0.14 + _energy * 0.1), 2.0, true)
		# a travelling glint
		var gx := lerpf(-half, half, 0.5 + 0.5 * sin(_t * 1.1))
		var glow := _GOLD
		for i in range(5):
			var rr := lerpf(44.0, 8.0, float(i) / 4.0)
			draw_circle(Vector2(gx, 0), rr * 0.3, Color(glow.r, glow.g, glow.b, 0.04 * _energy * (i + 1)))
		draw_circle(Vector2(gx, 0), 4.0, Color(glow.r, glow.g, glow.b, 0.5 * _energy))
		# soft end-caps
		for s: float in [-1.0, 1.0]:
			draw_circle(Vector2(half * s, 0), 3.0, Color(1, 1, 1, 0.2 * _energy))

# ---- the glowing seed the words become --------------------------------------
class _SeedMote extends Node2D:
	const _GOLD := Color(1.0, 0.92, 0.66, 1.0)
	const _GOLD_HI := Color(1.0, 0.99, 0.90, 1.0)
	var brightness := 0.0             # 0..1 overall luminosity
	var fall := 0.0                   # 0..1 how far it has dropped (adds a trail)
	var _t := 0.0
	var _trail: Array[Vector2] = []   # recent positions for a comet tail

	func _ready() -> void:
		set_process(true)

	func _process(delta: float) -> void:
		_t += delta
		_trail.push_front(position)
		if _trail.size() > 16:
			_trail.resize(16)
		queue_redraw()

	func _draw() -> void:
		if brightness <= 0.001:
			return
		var g := _GOLD
		var hi := _GOLD_HI
		# comet trail (drawn in local space; positions are global, so offset back)
		if fall > 0.05 and _trail.size() > 2:
			for i in range(1, _trail.size()):
				var k := 1.0 - float(i) / float(_trail.size())
				var lp: Vector2 = _trail[i] - position
				draw_circle(lp, lerpf(6.0, 1.0, 1.0 - k) * fall,
					Color(g.r, g.g, g.b, 0.10 * k * brightness))
		var pulse := 1.0 + 0.12 * sin(_t * 5.0)
		var r := (18.0 + 6.0 * fall) * pulse
		# layered bloom
		for i in range(5):
			var ti := float(i) / 4.0
			var rr: float = lerpf(r * 2.8, r * 0.5, ti)
			var aa: float = lerpf(0.05, 0.4, ti) * brightness
			draw_circle(Vector2.ZERO, rr, Color(g.r, g.g, g.b, aa))
		# bright core + a four-point glint
		draw_circle(Vector2.ZERO, r * 0.35, Color(hi.r, hi.g, hi.b, brightness))
		var pts := PackedVector2Array()
		for i in range(8):
			var a := _t * 0.6 + TAU * float(i) / 8.0
			var rad: float = r * (1.5 if i % 2 == 0 else 0.5)
			pts.append(Vector2(cos(a), sin(a)) * rad)
		draw_colored_polygon(pts, Color(hi.r, hi.g, hi.b, 0.5 * brightness))

# ---- the quiet "begin" affordance -------------------------------------------
class _BeginDot extends Control:
	const _GOLD := Color(1.0, 0.92, 0.66, 1.0)
	signal pressed
	var _t := 0.0
	var _ready_amt := 0.0

	func _ready() -> void:
		custom_minimum_size = Vector2(120, 120)
		size = Vector2(120, 120)
		pivot_offset = size * 0.5
		mouse_filter = Control.MOUSE_FILTER_STOP
		position -= size * 0.5
		set_process(true)

	func set_ready(on: bool) -> void:
		var tw := create_tween()
		tw.tween_property(self, "_ready_amt", (1.0 if on else 0.0), 0.5)

	func _process(delta: float) -> void:
		_t += delta
		queue_redraw()

	func _gui_input(ev: InputEvent) -> void:
		if _ready_amt < 0.5:
			return
		var tapped := false
		if ev is InputEventMouseButton and (ev as InputEventMouseButton).pressed:
			tapped = true
		elif ev is InputEventScreenTouch and (ev as InputEventScreenTouch).pressed:
			tapped = true
		if tapped:
			emit_signal("pressed")
			accept_event()

	func _draw() -> void:
		var c := size * 0.5
		var g := _GOLD
		var pulse := 0.5 + 0.5 * sin(_t * 2.2)
		# breathing halo
		for i in range(4):
			var rr := lerpf(52.0, 20.0, float(i) / 3.0) * (1.0 + 0.06 * pulse)
			draw_circle(c, rr, Color(g.r, g.g, g.b, (0.04 + 0.05 * _ready_amt) * (i + 1) * 0.5))
		# expanding ripple ring when ready
		if _ready_amt > 0.05:
			var rp: float = fmod(_t * 0.6, 1.0)
			draw_arc(c, lerpf(18.0, 54.0, rp), 0, TAU, 40,
				Color(g.r, g.g, g.b, (1.0 - rp) * 0.4 * _ready_amt), 2.0, true)
		# a soft downward chevron ("step through")
		var col := Color(1, 1, 1, 0.35 + 0.5 * _ready_amt)
		var w := 14.0
		draw_line(c + Vector2(-w, -4), c + Vector2(0, 8), col, 3.0, true)
		draw_line(c + Vector2(w, -4), c + Vector2(0, 8), col, 3.0, true)
		draw_circle(c, 5.0 + 1.5 * pulse * _ready_amt, Color(g.r, g.g, g.b, 0.6 + 0.4 * _ready_amt))
