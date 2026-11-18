class_name ProcAmbience
extends RefCounted
# ProcAmbience — the AMBIENT LIFE of a Blockle Idle world, generated from math.
#
# This is the air of the world: the things that are never placed and never tended,
# but that make a still island feel ALIVE and breathing. Two families, both drawn
# entirely from procedural math (CONVENTIONS.md), no imported images:
#
#   PARTICLE FIELDS — great soft clouds of tiny life handled on the GPU with
#       GPUParticles2D so a screen can hold thousands for almost no CPU cost:
#         · dust      — fine motes hanging in the daylight / sunbeams
#         · pollen    — heavier golden grains drifting on the warm air
#         · fireflies — blinking warm glows that come out at dusk and night
#         · leaves    — real little leaf shapes tumbling down on the wind
#         · rain      — fast bluish streaks (a weather effect, off by default)
#         · snow      — slow soft flakes swaying down (a weather effect)
#         · spores    — dim luminous drifting seeds of the deep / fungal realms
#       Each field's texture (a soft radial mote, a vertical streak, a hand-shaped
#       leaf) is RASTERISED FROM MATH at build time — nothing is loaded from disk.
#
#   WANDERING AGENTS — a handful of cheap procedural fliers that each trace a
#       smooth, organic path across the world, flapping as they go:
#         · butterflies — slow fluttering wanderers, many vivid species
#         · bees        — small fast buzzing zig-zaggers
#         · birds       — gliding silhouettes that cross the high sky, flap→glide
#         · fish        — ripple rings blooming on a water surface + darting shadows
#       Agents move by TRANSFORM only (position / rotation / child-wing scale), so
#       a flock costs a few sines per frame and never redraws its silhouette.
#
# Everything is SEEDED + TIME-OF-DAY AWARE + GROWS:
#   * SEEDED  — counts, colours, paths, blink timings, spawn layout are pure
#               functions of (world_seed, key). Same world → same life forever.
#   * ALIVE   — fields drift and twinkle forever; agents wander and flap forever;
#               ripples bloom and fade. Driven by the engine (GPU) and by cheap
#               per-frame transforms — the only effect that redraws each frame is
#               the fish-ripple surface (whose shape genuinely must change).
#   * TIME    — the manager knows the time of day. Fireflies and spores swell at
#               dusk and night; butterflies, bees, birds and dust fade with the
#               light. Call set_time_of_day() every frame (sync it to ProcSky) or
#               let it auto-advance.
#   * GROWS   — a world that is just waking has sparse life; as `growth` creeps to
#               1 the air fills in (GPUParticles2D.amount_ratio and agent count
#               ramp up smoothly), so the first morning is quiet and a mature world
#               hums with life. Any growth in [0,1] renders a believable amount.
#
# Module shape per CONVENTIONS: `class_name ProcAmbience extends RefCounted` with
# static factories returning ProcNode subclasses defined below.
#
# ── Usage (a world builder) ────────────────────────────────────────────────
#   var air := ProcAmbience.make_for_realm(world_seed, "verdant", Vector2(1080,1920),
#               {"water_y": 1500.0})
#   add_child(air)                       # mount over the world, high z
#   air.set_time_of_day(sky.get_time_of_day())   # every frame, to match the sky
#   air.set_weather("rain")              # clear / rain / snow / storm
#   air.set_wind(Vector2(0.4, 0.0))      # bias drift / leaf fall direction
#   air.stop("bees"); air.start("fireflies")     # toggle any single effect
# or build a single field / swarm on its own:
#   add_child(ProcAmbience.make_fireflies(world_seed, "dell:ff", Vector2(600,400)))

# ===========================================================================
#  CATALOGUES  (the public vocabulary a world builder can ask for)
# ===========================================================================
const PARTICLE_KINDS := ["dust", "pollen", "fireflies", "leaves", "rain", "snow", "spores"]
const AGENT_KINDS := ["butterflies", "bees", "birds", "fish"]
const ALL_KINDS := ["dust", "pollen", "fireflies", "leaves", "rain", "snow", "spores",
	"butterflies", "bees", "birds", "fish"]

# Butterfly / moth species — each a seeded, recognisable colour story.
const BUTTERFLY_SPECIES := [
	"monarch", "morpho", "swallowtail", "cabbage", "rose", "emperor", "moth",
]
# Bird species — small storybook silhouettes with their own colouring.
const BIRD_SPECIES := [
	"sparrow", "bluebird", "robin", "gull", "crow", "cardinal", "finch",
]

# ===========================================================================
#  PUBLIC FACTORIES
# ===========================================================================

# The main factory: a full ambience MANAGER holding a seed/realm-appropriate set
# of effects. `opts` (all optional):
#   effects:Array<String>   explicit kinds to include (else seed/realm default)
#   water_y:float           surface y (local) for fish ripples; enables "fish"
#   time_of_day:float       0 midnight .25 dawn .5 noon .75 dusk  (default .35)
#   auto_advance:bool       advance the day cycle itself (default false — sync to sky)
#   day_minutes:float       real minutes per day cycle if auto-advancing (default 28)
#   weather:String          "clear" | "rain" | "snow" | "storm"
#   wind:Vector2            drift bias in [-1,1] (default seed-chosen breeze)
#   density:float           global life density multiplier (default 1.0)
#   palette:Dictionary      colour overrides (see _derive_colors)
#   accent:String / sky:Array  realm accent / sky to tint life (see make_for_realm)
#   start_growth:float      initial growth (default 1.0)
#   grow_minutes:float      minutes for the air to fill in (default 18)
static func make(world_seed: int, key: String = "air", size: Vector2 = Vector2(1080, 1920), opts: Dictionary = {}) -> ProcNode:
	var mgr := _Ambience.new()
	mgr.seedv = _seed(world_seed, key)
	mgr.size = size
	mgr.base_key = key
	mgr.world_seed = world_seed
	mgr.tod = float(opts.get("time_of_day", 0.35))
	mgr.auto_advance = bool(opts.get("auto_advance", false))
	mgr.day_seconds = max(30.0, float(opts.get("day_minutes", 28.0)) * 60.0)
	mgr.density = float(opts.get("density", 1.0))
	mgr.weather = String(opts.get("weather", "clear"))
	mgr.water_y = float(opts.get("water_y", -1.0))
	mgr.cols = _derive_colors(mgr.seedv, opts)
	if opts.has("wind"):
		mgr.wind = opts["wind"]
	else:
		mgr.wind = Vector2(Proc.rangef(mgr.seedv, "wind", -0.5, 0.5), 0.0)

	# which effects to build
	var kinds: Array = opts.get("effects", _default_effects(mgr.seedv))
	# weather fields are always present (idle, off) so set_weather() can reach them
	for w in ["rain", "snow"]:
		if not (w in kinds):
			kinds = kinds + [w]
	if mgr.water_y >= 0.0 and not ("fish" in kinds):
		kinds = kinds + ["fish"]
	mgr.kinds = kinds

	mgr.set_grow_minutes(float(opts.get("grow_minutes", 18.0)))
	mgr.growth = clampf(float(opts.get("start_growth", 1.0)), 0.0, 1.0)
	return mgr

# Build ambience tuned to one of the game's realms, pulling its accent + sky from
# GameData so the life takes on the realm's mood and picking a fitting effect mix.
static func make_for_realm(world_seed: int, realm_id: String, size: Vector2 = Vector2(1080, 1920), opts: Dictionary = {}) -> ProcNode:
	var o := opts.duplicate()
	var realm: Dictionary = GameData.realms_by_id.get(realm_id, {})
	if realm.has("accent"):
		o["accent"] = realm["accent"]
	if realm.has("sky"):
		o["sky"] = realm["sky"]
	if not o.has("effects"):
		o["effects"] = _realm_effects(realm_id, _seed(world_seed, "air:" + realm_id))
	if not o.has("weather"):
		match realm_id:
			"frostfall": o["weather"] = "snow"
			_: o["weather"] = "clear"
	return make(world_seed, "air:" + realm_id, size, o)

# ── single-effect factories (handy for puzzles, dells, a water feature …) ──

static func make_dust(world_seed: int, key: String, size: Vector2, opts: Dictionary = {}) -> ProcNode:
	return _make_particle(world_seed, key, "dust", size, opts)

static func make_pollen(world_seed: int, key: String, size: Vector2, opts: Dictionary = {}) -> ProcNode:
	return _make_particle(world_seed, key, "pollen", size, opts)

static func make_fireflies(world_seed: int, key: String, size: Vector2, opts: Dictionary = {}) -> ProcNode:
	return _make_particle(world_seed, key, "fireflies", size, opts)

static func make_leaves(world_seed: int, key: String, size: Vector2, opts: Dictionary = {}) -> ProcNode:
	return _make_particle(world_seed, key, "leaves", size, opts)

static func make_rain(world_seed: int, key: String, size: Vector2, opts: Dictionary = {}) -> ProcNode:
	return _make_particle(world_seed, key, "rain", size, opts)

static func make_snow(world_seed: int, key: String, size: Vector2, opts: Dictionary = {}) -> ProcNode:
	return _make_particle(world_seed, key, "snow", size, opts)

static func make_spores(world_seed: int, key: String, size: Vector2, opts: Dictionary = {}) -> ProcNode:
	return _make_particle(world_seed, key, "spores", size, opts)

static func make_butterflies(world_seed: int, key: String, size: Vector2, opts: Dictionary = {}) -> ProcNode:
	return _make_agents(world_seed, key, "butterflies", size, opts)

static func make_bees(world_seed: int, key: String, size: Vector2, opts: Dictionary = {}) -> ProcNode:
	return _make_agents(world_seed, key, "bees", size, opts)

static func make_birds(world_seed: int, key: String, size: Vector2, opts: Dictionary = {}) -> ProcNode:
	return _make_agents(world_seed, key, "birds", size, opts)

# Fish ripples on a water surface. `opts.water_y` = local y of the surface
# (defaults to 70% down the given size).
static func make_fish_ripples(world_seed: int, key: String, size: Vector2, opts: Dictionary = {}) -> ProcNode:
	return _make_agents(world_seed, key, "fish", size, opts)

# Generic dispatch: build any one effect by kind.
static func make_effect(world_seed: int, key: String, kind: String, size: Vector2, opts: Dictionary = {}) -> ProcNode:
	if kind in AGENT_KINDS:
		return _make_agents(world_seed, key, kind, size, opts)
	return _make_particle(world_seed, key, kind, size, opts)

# ===========================================================================
#  small shared helpers
# ===========================================================================
static func _seed(world_seed: int, key: String) -> int:
	return hash("%d:%s" % [world_seed, key])

static func _default_effects(seedv: int) -> Array:
	# a lively temperate daytime world
	var e := ["dust", "pollen", "leaves", "butterflies", "bees", "birds", "fireflies"]
	if Proc.hashf(seedv, "hasspore") < 0.3:
		e.append("spores")
	return e

static func _realm_effects(realm_id: String, _seedv: int) -> Array:
	match realm_id:
		"verdant":
			return ["dust", "pollen", "leaves", "butterflies", "bees", "birds", "fireflies"]
		"crystal_hollow":
			return ["spores", "fireflies", "dust"]
		"skylands":
			return ["dust", "pollen", "birds", "butterflies"]
		"forgotten_wilds":
			return ["spores", "fireflies", "leaves", "butterflies"]
		"frostfall":
			return ["snow", "dust", "birds"]
		"astral":
			return ["fireflies", "spores", "dust"]
		"first_kingdom":
			return ["dust", "pollen", "fireflies", "butterflies"]
		_:
			return ["dust", "pollen", "butterflies", "bees", "fireflies"]

# A cohesive, seed-drifted set of natural tints for every effect. Realm accent /
# sky (if supplied) nudge the glowing life (fireflies / spores) toward the realm's
# colour, while dust / pollen / snow keep their believable natural hue.
static func _derive_colors(seedv: int, opts: Dictionary) -> Dictionary:
	var jh := Proc.rangef(seedv, "ajh", -0.03, 0.03)
	var accent := Color(0.6, 0.9, 0.5)
	if opts.has("accent") and String(opts["accent"]) != "":
		accent = Color.html(String(opts["accent"]))
	elif opts.has("palette") and opts["palette"] is Dictionary and (opts["palette"] as Dictionary).has("accent"):
		accent = opts["palette"]["accent"]

	var firefly := Color.from_hsv(fposmod(0.14 + jh, 1.0), 0.72, 1.0)          # warm amber-green
	# bias firefly toward the realm accent a little so caves glow blue, wilds green…
	firefly = firefly.lerp(accent, 0.35)
	var spore := Color.from_hsv(fposmod(0.42 + jh, 1.0), 0.55, 1.0).lerp(accent, 0.5)

	var dust := Color(1.0, 0.97, 0.88, 1.0)
	var pollen := Color.from_hsv(fposmod(0.12 + jh, 1.0), 0.55, 1.0)
	var rain := Color(0.78, 0.86, 1.0, 1.0)
	var snow := Color(0.96, 0.98, 1.0, 1.0)
	var water := Color(0.85, 0.95, 1.0, 1.0)
	if opts.has("sky") and opts["sky"] is Array and (opts["sky"] as Array).size() >= 1:
		water = Color.html(String((opts["sky"] as Array)[0])).lightened(0.3)

	# autumn leaf palette (three seeded warm tints — one per leaf sub-system)
	var lh := Proc.rangef(seedv, "leafh", 0.02, 0.11)
	var leaf := [
		Color.from_hsv(fposmod(lh, 1.0), 0.72, 0.86),
		Color.from_hsv(fposmod(lh + 0.04, 1.0), 0.80, 0.72),
		Color.from_hsv(fposmod(lh - 0.03, 1.0), 0.55, 0.60),
	]
	return {
		"dust": dust, "pollen": pollen, "firefly": firefly, "spore": spore,
		"rain": rain, "snow": snow, "water": water, "leaf": leaf, "accent": accent,
	}

# ===========================================================================
#  PROCEDURAL TEXTURES  (rasterised from math at build time — never from disk)
# ===========================================================================

# A soft round mote: a radial gradient from an opaque centre to transparent edge.
static func _soft_dot(col: Color, px: int = 64, hardness: float = 0.0) -> GradientTexture2D:
	var g := _gradient(
		PackedFloat32Array([0.0, clampf(0.15 + hardness * 0.5, 0.0, 0.9), 1.0]),
		PackedColorArray([
			Color(col.r, col.g, col.b, 1.0),
			Color(col.r, col.g, col.b, 0.55),
			Color(col.r, col.g, col.b, 0.0)]))
	var t := GradientTexture2D.new()
	t.gradient = g
	t.width = px
	t.height = px
	t.fill = GradientTexture2D.FILL_RADIAL
	t.fill_from = Vector2(0.5, 0.5)
	t.fill_to = Vector2(1.0, 0.5)
	return t

# A thin vertical rain streak: a soft-ended vertical bar.
static func _streak(col: Color, w: int = 4, h: int = 64) -> GradientTexture2D:
	var g := _gradient(
		PackedFloat32Array([0.0, 0.3, 0.75, 1.0]),
		PackedColorArray([
			Color(col.r, col.g, col.b, 0.0),
			Color(col.r, col.g, col.b, 0.85),
			Color(col.r, col.g, col.b, 0.85),
			Color(col.r, col.g, col.b, 0.0)]))
	var t := GradientTexture2D.new()
	t.gradient = g
	t.width = w
	t.height = h
	t.fill = GradientTexture2D.FILL_LINEAR
	t.fill_from = Vector2(0.5, 0.0)
	t.fill_to = Vector2(0.5, 1.0)
	return t

# A hand-shaped leaf, rasterised pixel-by-pixel: a pointed teardrop blade with a
# soft edge, a darker mid-rib and a couple of lateral veins, drawn in near-white
# so a per-system tint (pm.color) can make it any autumn colour.
static func _leaf_texture(seedv: int) -> ImageTexture:
	var w := 40
	var h := 56
	var img := Image.create(w, h, false, Image.FORMAT_RGBA8)
	img.fill(Color(0, 0, 0, 0))
	var curve := Proc.rangef(seedv, "lfcurve", -0.18, 0.18)     # a gentle sickle bend
	for y in range(h):
		var v := float(y) / float(h - 1) * 2.0 - 1.0            # -1 tip .. +1 base
		# half-width profile: pointed at both ends, fattest a touch above middle
		var prof: float = pow(clampf(1.0 - absf(v), 0.0, 1.0), 0.62)
		var hw := prof * (w * 0.42)
		var bend := curve * (1.0 - v * v) * (w * 0.5)           # sideways sickle
		for x in range(w):
			var u := float(x) - (w * 0.5) - bend
			var d := absf(u) - hw
			var a := clampf(-d, 0.0, 1.5) / 1.5                 # 1px soft edge
			if a <= 0.0:
				continue
			# shade: dark mid-rib, lighter toward the tip, faint lateral veins
			var rib := 1.0 - 0.45 * exp(-pow(u / 2.2, 2.0))
			var lat := 0.12 * maxf(0.0, sin(absf(u) * 0.55 + v * 5.0)) * prof
			var lum := clampf(rib - lat, 0.35, 1.0) * (0.82 + 0.18 * (0.5 - v * 0.5))
			img.set_pixel(x, y, Color(lum, lum, lum, a))
	return ImageTexture.create_from_image(img)

# Build a Gradient safely (rebuild from the default 2 points to avoid length races).
static func _gradient(offs: PackedFloat32Array, cols: PackedColorArray) -> Gradient:
	var g := Gradient.new()
	while g.get_point_count() > 1:
		g.remove_point(g.get_point_count() - 1)
	g.set_offset(0, offs[0])
	g.set_color(0, cols[0])
	for i in range(1, offs.size()):
		g.add_point(offs[i], cols[i])
	return g

# A per-life alpha RAMP as a GradientTexture1D for the particle colour_ramp:
#   "fade"  — 0 → 1 → 0 so motes gently appear and vanish
#   "blink" — several alpha peaks so fireflies pulse on and off during their life
#   "solid" — flat (used for falling things that just need to exist)
static func _ramp(kind: String) -> GradientTexture1D:
	var offs: PackedFloat32Array
	var alphas: Array
	match kind:
		"blink":
			offs = PackedFloat32Array([0.0, 0.08, 0.16, 0.3, 0.42, 0.56, 0.68, 0.82, 0.92, 1.0])
			alphas = [0.0, 0.15, 1.0, 0.1, 0.9, 0.05, 1.0, 0.2, 0.6, 0.0]
		"solid":
			offs = PackedFloat32Array([0.0, 0.12, 0.85, 1.0])
			alphas = [0.0, 1.0, 1.0, 0.0]
		_:  # "fade"
			offs = PackedFloat32Array([0.0, 0.2, 0.8, 1.0])
			alphas = [0.0, 1.0, 1.0, 0.0]
	var cols := PackedColorArray()
	for a in alphas:
		cols.append(Color(1, 1, 1, float(a)))
	var t := GradientTexture1D.new()
	t.gradient = _gradient(offs, cols)
	t.width = 128
	return t

# ===========================================================================
#  PARTICLE FIELD  (one _Effect wrapping one or more GPUParticles2D)
# ===========================================================================

static func _make_particle(world_seed: int, key: String, kind: String, size: Vector2, opts: Dictionary) -> ProcNode:
	var fx := _ParticleEffect.new()
	fx.seedv = _seed(world_seed, key + ":" + kind)
	fx.kind = kind
	fx.size = size
	fx.cols = (opts["colours"] if opts.has("colours") else _derive_colors(fx.seedv, opts))
	fx.density = float(opts.get("density", 1.0))
	if opts.has("wind"):
		fx.wind = opts["wind"]
	if opts.has("start_growth"):
		fx.growth = clampf(float(opts["start_growth"]), 0.0, 1.0)
	if opts.has("grow_minutes"):
		fx.set_grow_minutes(float(opts["grow_minutes"]))
	else:
		fx.set_grow_minutes(12.0)
	return fx

# Per-kind field recipe (everything size-independent; the box is placed in build).
static func _particle_spec(kind: String, seedv: int, cols: Dictionary) -> Dictionary:
	# Shared default field.
	var s := {
		"systems": 1, "amount": 48, "lifetime": 8.0, "preprocess": true,
		"add": false, "tex": "dot", "dot_px": 64, "hardness": 0.0,
		"col": Color(1, 1, 1, 1), "cols": [],
		"scale_min": 0.08, "scale_max": 0.18,
		"vel_min": 6.0, "vel_max": 18.0, "dir": Vector3(0, -1, 0), "spread": 180.0,
		"gravity": Vector3(0, 0, 0),
		"turb": 8.0, "turb_scale": 0.2, "turb_lo": 0.08, "turb_hi": 0.28,
		"ang_min": 0.0, "ang_max": 0.0, "ramp": "fade",
		"band": Vector2(0.0, 1.0),           # vertical band of the emission box (0=top)
		"top_fall": false, "emitting": true,
		"mode": "always", "min_vis": 0.0, "alpha": 0.7,
	}
	match kind:
		"dust":
			s.merge({
				"add": true, "amount": 70, "lifetime": 11.0, "col": cols["dust"],
				"scale_min": 0.03, "scale_max": 0.12, "vel_min": 4.0, "vel_max": 12.0,
				"gravity": Vector3(0, -3.0, 0), "turb": 5.0, "turb_scale": 0.22,
				"mode": "day", "alpha": 0.5, "band": Vector2(0.0, 1.0),
			}, true)
		"pollen":
			s.merge({
				"add": true, "amount": 46, "lifetime": 10.0, "col": cols["pollen"],
				"scale_min": 0.06, "scale_max": 0.16, "vel_min": 5.0, "vel_max": 14.0,
				"gravity": Vector3(0, 7.0, 0), "turb": 7.0, "turb_scale": 0.18,
				"mode": "day", "alpha": 0.65, "band": Vector2(0.1, 1.0),
			}, true)
		"fireflies":
			s.merge({
				"add": true, "amount": 28, "lifetime": 7.5, "col": cols["firefly"],
				"scale_min": 0.09, "scale_max": 0.2, "hardness": 0.1,
				"vel_min": 9.0, "vel_max": 26.0, "gravity": Vector3(0, 0, 0),
				"turb": 13.0, "turb_scale": 0.14, "turb_lo": 0.1, "turb_hi": 0.4,
				"ramp": "blink", "mode": "dusk", "alpha": 1.0, "band": Vector2(0.28, 1.0),
			}, true)
		"spores":
			s.merge({
				"add": true, "amount": 44, "lifetime": 10.0, "col": cols["spore"],
				"scale_min": 0.04, "scale_max": 0.12, "hardness": 0.05,
				"vel_min": 5.0, "vel_max": 16.0, "gravity": Vector3(0, -4.0, 0),
				"turb": 9.0, "turb_scale": 0.16, "mode": "night", "min_vis": 0.32,
				"alpha": 0.75, "band": Vector2(0.0, 1.0),
			}, true)
		"leaves":
			s.merge({
				"systems": 3, "add": false, "amount": 12, "lifetime": 22.0,
				"tex": "leaf", "cols": cols["leaf"],
				"scale_min": 0.3, "scale_max": 0.62,
				"vel_min": 26.0, "vel_max": 60.0, "dir": Vector3(0.25, 1.0, 0), "spread": 35.0,
				"gravity": Vector3(0, 26.0, 0), "turb": 20.0, "turb_scale": 0.1,
				"turb_lo": 0.2, "turb_hi": 0.7, "ang_min": -140.0, "ang_max": 140.0,
				"ramp": "solid", "top_fall": true, "mode": "always", "alpha": 0.95,
			}, true)
		"rain":
			s.merge({
				"add": false, "amount": 230, "lifetime": 2.1, "preprocess": true,
				"tex": "streak", "col": cols["rain"],
				"scale_min": 0.5, "scale_max": 1.1,
				"vel_min": 900.0, "vel_max": 1250.0, "dir": Vector3(0.12, 1.0, 0), "spread": 4.0,
				"gravity": Vector3(0, 400.0, 0), "turb": 0.0, "ramp": "solid",
				"top_fall": true, "emitting": false, "mode": "always", "alpha": 0.55,
			}, true)
		"snow":
			s.merge({
				"add": false, "amount": 120, "lifetime": 14.0, "col": cols["snow"],
				"scale_min": 0.06, "scale_max": 0.18, "hardness": 0.1,
				"vel_min": 40.0, "vel_max": 90.0, "dir": Vector3(0, 1.0, 0), "spread": 18.0,
				"gravity": Vector3(0, 10.0, 0), "turb": 22.0, "turb_scale": 0.1,
				"turb_lo": 0.2, "turb_hi": 0.6, "ramp": "solid",
				"top_fall": true, "emitting": false, "mode": "always", "alpha": 0.9,
			}, true)
	return s

# ===========================================================================
#  AGENT SWARM / RIPPLE FIELD
# ===========================================================================

static func _make_agents(world_seed: int, key: String, kind: String, size: Vector2, opts: Dictionary) -> ProcNode:
	if kind == "fish":
		var rf := _RippleField.new()
		rf.seedv = _seed(world_seed, key + ":fish")
		rf.size = size
		rf.cols = (opts["colours"] if opts.has("colours") else _derive_colors(rf.seedv, opts))
		rf.water_y = float(opts.get("water_y", size.y * 0.7))
		rf.density = float(opts.get("density", 1.0))
		rf.set_grow_minutes(float(opts.get("grow_minutes", 12.0)))
		if opts.has("start_growth"):
			rf.growth = clampf(float(opts["start_growth"]), 0.0, 1.0)
		return rf

	var sw := _AgentSwarm.new()
	sw.seedv = _seed(world_seed, key + ":" + kind)
	sw.kind = kind
	sw.size = size
	sw.cols = (opts["colours"] if opts.has("colours") else _derive_colors(sw.seedv, opts))
	sw.density = float(opts.get("density", 1.0))
	sw.set_grow_minutes(float(opts.get("grow_minutes", 12.0)))
	if opts.has("start_growth"):
		sw.growth = clampf(float(opts["start_growth"]), 0.0, 1.0)
	# per-kind swarm sizing + vertical band + motion feel
	match kind:
		"butterflies":
			sw.max_count = int(opts.get("count", 5)); sw.min_count = 1
			sw.band = Vector2(0.42, 0.82); sw.mode = "day"
		"bees":
			sw.max_count = int(opts.get("count", 7)); sw.min_count = 1
			sw.band = Vector2(0.5, 0.88); sw.mode = "day"
		"birds":
			sw.max_count = int(opts.get("count", 4)); sw.min_count = 0
			sw.band = Vector2(0.06, 0.32); sw.mode = "day"
	return sw

# ===========================================================================
#  BASE EFFECT  (common seed / size / growth / time-of-day / density contract)
# ===========================================================================

class _Effect extends ProcNode:
	var kind: String = ""
	var size: Vector2 = Vector2(1080, 1920)
	var cols: Dictionary = {}
	var density: float = 1.0
	var wind: Vector2 = Vector2.ZERO
	var _daylight: float = 1.0        # 0 night .. 1 full day
	var _dusk: float = 0.0            # warm band at each horizon crossing
	var mode: String = "always"       # day | night | dusk | always
	var min_vis: float = 0.0
	var _managed: bool = false        # true when a manager drives growth + light

	# Visibility from the time of day given this effect's mode (0..1).
	func visibility() -> float:
		var night := 1.0 - _daylight
		var v := 1.0
		match mode:
			"day": v = _daylight
			"night": v = night
			"dusk": v = clampf(_dusk * 1.25 + night * 0.55, 0.0, 1.0)
			_: v = 1.0
		return maxf(min_vis, v)

	# Called by the manager each frame (or directly when used stand-alone).
	func set_daylight(daylight: float, dusk: float) -> void:
		_daylight = clampf(daylight, 0.0, 1.0)
		_dusk = clampf(dusk, 0.0, 1.0)
		_apply()

	func set_density(d: float) -> void:
		density = maxf(0.0, d)
		_apply()

	func set_wind(w: Vector2) -> void:
		wind = w
		_apply()

	# Start / stop this single effect (fields toggle emission; swarms hide agents).
	func start() -> void:
		pass

	func stop() -> void:
		pass

	# Subclasses push their state to the GPU / children here.
	func _apply() -> void:
		pass

	func _on_growth() -> void:
		_apply()

# ===========================================================================
#  PARTICLE FIELD IMPLEMENTATION
# ===========================================================================

class _ParticleEffect extends _Effect:
	var _systems: Array = []          # Array[GPUParticles2D]
	var _spec: Dictionary = {}
	var _want_on: bool = true         # user/weather intent (start/stop)

	func _on_built() -> void:
		_spec = ProcAmbience._particle_spec(kind, seedv, cols)
		mode = String(_spec["mode"])
		min_vis = float(_spec["min_vis"])
		_want_on = bool(_spec["emitting"])

		var sys_n := int(_spec["systems"])
		for i in range(sys_n):
			var p := _build_system(i)
			add_child(p)
			_systems.append(p)
		_apply()

	func _build_system(i: int) -> GPUParticles2D:
		var p := GPUParticles2D.new()
		p.amount = maxi(1, int(_spec["amount"]))
		p.lifetime = float(_spec["lifetime"])
		p.preprocess = (p.lifetime if bool(_spec["preprocess"]) else 0.0)
		p.randomness = 1.0
		p.local_coords = true
		p.explosiveness = 0.0
		p.fixed_fps = 30
		p.z_index = 1

		# texture (rasterised from math per kind)
		match String(_spec["tex"]):
			"leaf":
				p.texture = ProcAmbience._leaf_texture(seedv + i * 97)
			"streak":
				p.texture = ProcAmbience._streak(Color(_spec["col"]))
			_:
				p.texture = ProcAmbience._soft_dot(Color(_spec["col"]), int(_spec["dot_px"]), float(_spec["hardness"]))

		# additive glow for luminous life
		if bool(_spec["add"]):
			var cm := CanvasItemMaterial.new()
			cm.blend_mode = CanvasItemMaterial.BLEND_MODE_ADD
			p.material = cm

		p.process_material = _build_process(i)
		# place the emission box within `size`
		_place_box(p)
		return p

	func _build_process(i: int) -> ParticleProcessMaterial:
		var pm := ParticleProcessMaterial.new()
		pm.emission_shape = ParticleProcessMaterial.EMISSION_SHAPE_BOX
		pm.direction = _spec["dir"]
		pm.spread = float(_spec["spread"])
		pm.initial_velocity_min = float(_spec["vel_min"])
		pm.initial_velocity_max = float(_spec["vel_max"])
		pm.gravity = _spec["gravity"]
		pm.scale_min = float(_spec["scale_min"])
		pm.scale_max = float(_spec["scale_max"])
		pm.angle_min = float(_spec["ang_min"])
		pm.angle_max = float(_spec["ang_max"])
		if float(_spec["ang_min"]) != 0.0 or float(_spec["ang_max"]) != 0.0:
			pm.angular_velocity_min = float(_spec["ang_min"])
			pm.angular_velocity_max = float(_spec["ang_max"])

		# per-particle colour + a life-long alpha ramp (fade / blink / solid)
		var base: Color = _spec["col"]
		var sub_cols: Array = _spec["cols"]
		if sub_cols.size() > 0:
			base = sub_cols[i % sub_cols.size()]
		pm.color = Color(base.r, base.g, base.b, 1.0)
		pm.color_ramp = ProcAmbience._ramp(String(_spec["ramp"]))

		# gentle turbulence for drifting / swaying
		var tb := float(_spec["turb"])
		if tb > 0.0:
			pm.turbulence_enabled = true
			pm.turbulence_noise_strength = tb
			pm.turbulence_noise_scale = float(_spec["turb_scale"])
			pm.turbulence_influence_min = float(_spec["turb_lo"])
			pm.turbulence_influence_max = float(_spec["turb_hi"])
		return pm

	func _place_box(p: GPUParticles2D) -> void:
		var band: Vector2 = _spec["band"]
		var y0 := size.y * band.x
		var y1 := size.y * band.y
		if bool(_spec["top_fall"]):
			# emit in a thin ribbon just above the top edge; gravity carries them down
			p.position = Vector2(size.x * 0.5, -40.0)
			_set_box(p, size.x * 0.5 + 60.0, 30.0)
			# live long enough to fall past the bottom
			var fall_v := maxf(40.0, float(_spec["vel_max"]))
			p.lifetime = maxf(p.lifetime, (size.y + 220.0) / fall_v)
			p.preprocess = p.lifetime
		else:
			p.position = Vector2(size.x * 0.5, (y0 + y1) * 0.5)
			_set_box(p, size.x * 0.5 + 20.0, maxf(10.0, (y1 - y0) * 0.5))

	func _set_box(p: GPUParticles2D, ex: float, ey: float) -> void:
		var pm := p.process_material as ParticleProcessMaterial
		if pm:
			pm.emission_box_extents = Vector3(ex, ey, 1.0)

	# push growth(density)+visibility to amount_ratio and alpha to modulate
	func _apply() -> void:
		if _systems.is_empty():
			return
		var vis := visibility()
		var count_ratio := clampf(density * (0.12 + 0.88 * g()), 0.0, 1.0)
		var tint := Color(1, 1, 1, clampf(float(_spec["alpha"]) * (0.25 + 0.75 * vis), 0.0, 1.0))
		var on := _want_on and vis > 0.015
		for p in _systems:
			p.amount_ratio = count_ratio
			p.modulate = tint
			p.emitting = on
			# nudge the drift direction with the wind
			var pm := p.process_material as ParticleProcessMaterial
			if pm and float(_spec["turb"]) >= 0.0:
				var d: Vector3 = _spec["dir"]
				pm.direction = (d + Vector3(wind.x * 0.8, wind.y * 0.4, 0)).normalized()

	func start() -> void:
		_want_on = true
		_apply()

	func stop() -> void:
		_want_on = false
		_apply()

# ===========================================================================
#  AGENT SWARM  (butterflies / bees / birds)  — cheap smooth-path fliers
# ===========================================================================

class _AgentSwarm extends _Effect:
	var min_count: int = 0
	var max_count: int = 5
	var band: Vector2 = Vector2(0.45, 0.85)     # vertical band (fraction of size.y)
	var _fliers: Array = []                      # Array[_Flier]

	func _on_built() -> void:
		for i in range(max_count):
			var f := _Flier.new()
			f.kind = kind
			f.seedv = seedv + i * 131
			f.idx = i
			f.region = size
			f.band = band
			f.cols = cols
			f.wind = wind
			add_child(f)
			f.reconfigure(0)
			_fliers.append(f)
		_apply()

	func _apply() -> void:
		if _fliers.is_empty():
			return
		var vis := visibility()
		var want := int(round(lerpf(float(min_count), float(max_count), clampf(density * g(), 0.0, 1.0))))
		if vis <= 0.02:
			want = 0
		var a := clampf(0.15 + 0.85 * vis, 0.0, 1.0)
		for i in range(_fliers.size()):
			var f: _Flier = _fliers[i]
			var live := i < want
			f.set_active(live)
			f.wind = wind
			f.target_alpha = (a if live else 0.0)

	func start() -> void:
		set_density(maxf(density, 0.0001))

	func stop() -> void:
		for f in _fliers:
			f.set_active(false)

# ── one flier: traces a smooth wandering path; flaps via child-wing transforms ──
class _Flier extends Node2D:
	var kind: String = "butterflies"
	var seedv: int = 1
	var idx: int = 0
	var region: Vector2 = Vector2(1080, 1920)
	var band: Vector2 = Vector2(0.45, 0.85)
	var cols: Dictionary = {}
	var wind: Vector2 = Vector2.ZERO
	var target_alpha: float = 1.0

	var _active: bool = true
	var _cycle: int = 0
	var _u: float = 0.0               # progress 0..1 across the traverse
	var _dur: float = 6.0             # seconds to cross
	var _dir: float = 1.0             # +1 L→R, -1 R→L
	var _x0: float = 0.0
	var _x1: float = 0.0
	var _base_y: float = 0.0
	var _bob_a: float = 24.0
	var _bob_w: float = 2.2
	var _wander_a: float = 40.0
	var _wander_w: float = 0.6
	var _flap: float = 8.0
	var _t: float = 0.0
	var _phase: float = 0.0
	var _body_col: Color = Color(0.2, 0.2, 0.2)
	var _accent_col: Color = Color(0.9, 0.6, 0.2)
	var _wing_a: _Wing
	var _wing_b: _Wing
	var _size: float = 1.0

	func _ready() -> void:
		var cm := CanvasItemMaterial.new()
		cm.blend_mode = CanvasItemMaterial.BLEND_MODE_MIX
		# wings as two children, mirrored, so flapping is a pure transform
		_wing_a = _Wing.new()
		_wing_b = _Wing.new()
		_wing_b.scale.x = -1.0
		add_child(_wing_a)
		add_child(_wing_b)
		z_index = (0 if kind == "butterflies" or kind == "bees" else 2)
		reconfigure(0)

	func set_active(on: bool) -> void:
		_active = on
		visible = on
		set_process(on)

	# (Re)seed this flier's whole flight for a new crossing cycle.
	func reconfigure(cycle: int) -> void:
		_cycle = cycle
		var k := func(s: String) -> float:
			return Proc.hashf(seedv, "%s:%d:%d" % [s, idx, cycle])
		_phase = k.call("ph") * TAU
		_dir = (1.0 if k.call("dir") < 0.5 else -1.0)
		var margin := 120.0
		_x0 = (-margin if _dir > 0.0 else region.x + margin)
		_x1 = (region.x + margin if _dir > 0.0 else -margin)
		_base_y = lerpf(region.y * band.x, region.y * band.y, k.call("by"))
		_u = 0.0

		match kind:
			"butterflies":
				_size = lerpf(0.8, 1.25, k.call("sz"))
				_dur = lerpf(7.0, 13.0, k.call("du"))
				_bob_a = lerpf(26.0, 60.0, k.call("ba")); _bob_w = lerpf(1.4, 2.6, k.call("bw"))
				_wander_a = lerpf(30.0, 70.0, k.call("wa")); _wander_w = lerpf(0.5, 1.1, k.call("ww"))
				_flap = lerpf(6.0, 10.0, k.call("fl"))
				_setup_butterfly(k)
			"bees":
				_size = lerpf(0.55, 0.8, k.call("sz"))
				_dur = lerpf(4.0, 7.5, k.call("du"))
				_bob_a = lerpf(14.0, 34.0, k.call("ba")); _bob_w = lerpf(3.0, 5.5, k.call("bw"))
				_wander_a = lerpf(24.0, 60.0, k.call("wa")); _wander_w = lerpf(1.2, 2.4, k.call("ww"))
				_flap = lerpf(26.0, 40.0, k.call("fl"))
				_setup_bee(k)
			"birds":
				_size = lerpf(1.0, 1.7, k.call("sz"))
				_dur = lerpf(4.0, 8.0, k.call("du"))
				_bob_a = lerpf(18.0, 46.0, k.call("ba")); _bob_w = lerpf(0.4, 0.9, k.call("bw"))
				_wander_a = lerpf(14.0, 34.0, k.call("wa")); _wander_w = lerpf(0.3, 0.6, k.call("ww"))
				_flap = lerpf(3.0, 6.0, k.call("fl"))
				_setup_bird(k)
		scale = Vector2(_size, _size)
		queue_redraw()

	# position along the path at progress u (independent of frame delta, for heading)
	func _pos_at(u: float) -> Vector2:
		var x := lerpf(_x0, _x1, clampf(u, 0.0, 1.0))
		var yy := _base_y
		yy += sin(u * TAU * _bob_w + _phase) * _bob_a
		yy += sin(_t * _wander_w + _phase * 1.7) * _wander_a * 0.4
		yy += sin(u * TAU * (_bob_w * 0.37) + _phase * 2.1) * _bob_a * 0.35
		yy += wind.y * 30.0 * u
		return Vector2(x + wind.x * 40.0 * u, yy)

	func _process(delta: float) -> void:
		if not _active:
			return
		_t += delta
		_u += delta / maxf(0.5, _dur)
		if _u >= 1.0:
			reconfigure(_cycle + 1)
			return
		var here := _pos_at(_u)
		var ahead := _pos_at(minf(1.0, _u + 0.02))
		position = here
		var hv := ahead - here
		# face travel direction; keep the silhouette upright with a slight pitch
		scale.x = _size * _dir
		var pitch := clampf(hv.y / maxf(20.0, absf(hv.x) + 20.0), -0.5, 0.5)
		rotation = pitch * 0.6 * _dir

		# soft fade toward the swarm's target alpha
		modulate.a = move_toward(modulate.a, target_alpha, delta * 2.2)

		# wing animation — pure transform, per kind
		match kind:
			"butterflies":
				var o := 0.18 + 0.82 * absf(sin(_t * _flap + _phase))
				_wing_a.scale.x = o
				_wing_b.scale.x = -o
				var tilt := sin(_t * _flap * 0.5 + _phase) * 0.12
				_wing_a.rotation = tilt
				_wing_b.rotation = -tilt
			"bees":
				var o2 := 0.5 + 0.5 * sin(_t * _flap + _phase)
				_wing_a.scale = Vector2(0.6 + 0.4 * o2, 0.9)
				_wing_b.scale = Vector2(-(0.6 + 0.4 * o2), 0.9)
			"birds":
				# flap in bursts, then glide (a slow envelope gates the flap)
				var env := 0.35 + 0.65 * clampf(sin(_t * 0.5 + _phase) * 1.4, 0.0, 1.0)
				var ang := sin(_t * _flap + _phase) * 0.95 * env
				_wing_a.rotation = ang
				_wing_b.rotation = ang

	# ── body silhouettes (drawn once per cycle; wings live in children) ──
	func _draw() -> void:
		match kind:
			"butterflies": _draw_butterfly_body()
			"bees": _draw_bee_body()
			"birds": _draw_bird_body()

	func _draw_butterfly_body() -> void:
		var c := _body_col
		# slender abdomen + thorax
		var body := Proc.superellipse(2.4, 11.0, 2.2, 18)
		draw_colored_polygon(body, c)
		draw_circle(Vector2(0, -9.0), 3.0, c)            # head
		# antennae
		draw_polyline(PackedVector2Array([Vector2(0, -11), Vector2(-4, -18), Vector2(-5, -20)]), c, 1.2, true)
		draw_polyline(PackedVector2Array([Vector2(0, -11), Vector2(4, -18), Vector2(5, -20)]), c, 1.2, true)
		draw_circle(Vector2(-5, -20), 1.4, c)
		draw_circle(Vector2(5, -20), 1.4, c)

	func _draw_bee_body() -> void:
		var body := Proc.superellipse(6.0, 9.0, 2.6, 20)
		draw_colored_polygon(body, Color(0.12, 0.1, 0.08))
		# amber stripes
		for s in range(3):
			var y := -4.0 + s * 4.0
			var bar := PackedVector2Array([
				Vector2(-5.2, y), Vector2(5.2, y),
				Vector2(4.6, y + 2.2), Vector2(-4.6, y + 2.2)])
			draw_colored_polygon(bar, _accent_col)
		draw_circle(Vector2(0, -9.5), 3.4, Color(0.1, 0.09, 0.08))   # head
		draw_circle(Vector2(-1.2, -10.4), 0.9, Color(0.9, 0.9, 0.95, 0.8))

	func _draw_bird_body() -> void:
		var c := _body_col
		# plump body
		var body := Proc.superellipse(8.0, 5.0, 2.4, 22)
		draw_colored_polygon(body, c)
		draw_circle(Vector2(7.5, -1.5), 3.6, c)          # head toward +x
		# little beak + tail
		draw_colored_polygon(PackedVector2Array([
			Vector2(10.5, -2.2), Vector2(14.5, -0.8), Vector2(10.5, 0.6)]), _accent_col)
		draw_colored_polygon(PackedVector2Array([
			Vector2(-7.0, -2.0), Vector2(-14.0, -4.5), Vector2(-12.0, 2.5), Vector2(-7.0, 2.0)]),
			c.darkened(0.15))
		draw_circle(Vector2(8.6, -2.2), 0.9, Color(0.05, 0.05, 0.06))   # eye

	# ── per-species colouring + wing shapes ──
	func _setup_butterfly(k: Callable) -> void:
		var sp: String = ProcAmbience.BUTTERFLY_SPECIES[int(k.call("sp") * ProcAmbience.BUTTERFLY_SPECIES.size()) % ProcAmbience.BUTTERFLY_SPECIES.size()]
		var wing: Color
		var edge: Color
		var spot: Color
		match sp:
			"monarch":
				wing = Color(0.92, 0.45, 0.07); edge = Color(0.1, 0.07, 0.05); spot = Color(1, 1, 1)
				_body_col = Color(0.1, 0.08, 0.06)
			"morpho":
				wing = Color(0.2, 0.45, 0.95); edge = Color(0.06, 0.08, 0.2); spot = Color(0.7, 0.85, 1.0)
				_body_col = Color(0.08, 0.08, 0.14)
			"swallowtail":
				wing = Color(0.98, 0.86, 0.2); edge = Color(0.12, 0.1, 0.06); spot = Color(0.2, 0.4, 0.9)
				_body_col = Color(0.12, 0.1, 0.06)
			"cabbage":
				wing = Color(0.98, 0.98, 0.95); edge = Color(0.85, 0.85, 0.82); spot = Color(0.3, 0.3, 0.3)
				_body_col = Color(0.3, 0.3, 0.3)
			"rose":
				wing = Color(0.95, 0.5, 0.72); edge = Color(0.4, 0.12, 0.26); spot = Color(1, 0.95, 0.98)
				_body_col = Color(0.3, 0.12, 0.2)
			"emperor":
				wing = Color(0.55, 0.3, 0.75); edge = Color(0.2, 0.1, 0.3); spot = Color(1, 0.8, 0.3)
				_body_col = Color(0.15, 0.1, 0.2)
			_:  # "moth"
				wing = Color(0.7, 0.62, 0.5); edge = Color(0.35, 0.3, 0.24); spot = Color(0.9, 0.85, 0.7)
				_body_col = Color(0.3, 0.26, 0.2)
		# drift wing toward the local palette a touch (stay recognisable)
		wing = ProcAmbience._drift(wing, cols, 0.12)
		_accent_col = spot
		var fore := _wing_blob(16.0, 13.0, -2.0)
		var hind := _wing_blob(12.0, 11.0, 9.0)
		var shapes := [
			{"pts": hind, "col": wing.darkened(0.12)},
			{"pts": fore, "col": wing},
			{"pts": _wing_outline(fore), "col": Color(edge.r, edge.g, edge.b, 0.9), "line": 1.6},
			{"pts": _oval(Vector2(9, -1), 2.6), "col": Color(spot.r, spot.g, spot.b, 0.9)},
			{"pts": _oval(Vector2(7, 7), 2.0), "col": Color(spot.r, spot.g, spot.b, 0.8)},
		]
		_wing_a.set_shapes(shapes)
		_wing_b.set_shapes(shapes)

	func _setup_bee(_k: Callable) -> void:
		_accent_col = ProcAmbience._drift(Color(0.98, 0.78, 0.12), cols, 0.1)
		_body_col = Color(0.12, 0.1, 0.08)
		# soft translucent buzzing wings
		var w := _oval(Vector2(6, -3), 6.0)
		var shapes := [{"pts": w, "col": Color(0.9, 0.95, 1.0, 0.35)}]
		_wing_a.set_shapes(shapes)
		_wing_b.set_shapes(shapes)

	func _setup_bird(k: Callable) -> void:
		var sp: String = ProcAmbience.BIRD_SPECIES[int(k.call("sp") * ProcAmbience.BIRD_SPECIES.size()) % ProcAmbience.BIRD_SPECIES.size()]
		var body: Color
		var acc: Color
		match sp:
			"sparrow": body = Color(0.55, 0.42, 0.28); acc = Color(0.85, 0.7, 0.3)
			"bluebird": body = Color(0.25, 0.5, 0.85); acc = Color(0.95, 0.7, 0.3)
			"robin": body = Color(0.42, 0.34, 0.3); acc = Color(0.9, 0.45, 0.2)
			"gull": body = Color(0.95, 0.96, 0.98); acc = Color(0.95, 0.78, 0.2)
			"crow": body = Color(0.1, 0.1, 0.13); acc = Color(0.2, 0.2, 0.24)
			"cardinal": body = Color(0.85, 0.18, 0.15); acc = Color(0.95, 0.6, 0.2)
			_: body = Color(0.72, 0.6, 0.32); acc = Color(0.9, 0.72, 0.3)
		_body_col = body
		_accent_col = acc
		var wing := _bird_wing()
		var shapes := [
			{"pts": wing, "col": body.darkened(0.1)},
			{"pts": _wing_outline(wing), "col": Color(body.r * 0.5, body.g * 0.5, body.b * 0.5, 0.8), "line": 1.4},
		]
		_wing_a.set_shapes(shapes)
		_wing_b.set_shapes(shapes)

	# a soft rounded wing lobe centred out along +x
	func _wing_blob(rx: float, ry: float, oy: float) -> PackedVector2Array:
		var ctrl := PackedVector2Array([
			Vector2(0, oy - ry * 0.2),
			Vector2(rx * 0.7, oy - ry),
			Vector2(rx * 1.25, oy - ry * 0.3),
			Vector2(rx * 1.2, oy + ry * 0.6),
			Vector2(rx * 0.5, oy + ry),
			Vector2(0, oy + ry * 0.3),
		])
		return Proc.smooth_loop(ctrl, 7)

	func _bird_wing() -> PackedVector2Array:
		var ctrl := PackedVector2Array([
			Vector2(0, -1.5), Vector2(10, -6), Vector2(20, -5),
			Vector2(26, -1), Vector2(16, 2), Vector2(6, 2.5),
		])
		return Proc.smooth_loop(ctrl, 6)

	func _wing_outline(poly: PackedVector2Array) -> PackedVector2Array:
		var o := PackedVector2Array(poly)
		if poly.size() > 0:
			o.append(poly[0])
		return o

	func _oval(c: Vector2, r: float) -> PackedVector2Array:
		var pts := Proc.superellipse(r, r * 0.8, 2.2, 14)
		var out := PackedVector2Array()
		for p in pts:
			out.append(p + c)
		return out

# a wing (or any decoration) — a list of filled polys + optional outlines, drawn
# once; the parent flier animates it by scale / rotation only.
class _Wing extends Node2D:
	var _shapes: Array = []
	func set_shapes(s: Array) -> void:
		_shapes = s
		queue_redraw()
	func _draw() -> void:
		for d in _shapes:
			if d.has("line"):
				draw_polyline(d["pts"], d["col"], float(d["line"]), true)
			else:
				draw_colored_polygon(d["pts"], d["col"])

# ===========================================================================
#  FISH-RIPPLE FIELD  (expanding rings + darting shadows on a water surface)
# ===========================================================================

class _RippleField extends _Effect:
	var water_y: float = 1300.0
	var _rings: Array = []            # pool of ring descriptors
	var _fish: Array = []             # pool of darting-shadow descriptors
	var _next_ring: float = 0.0
	var _next_fish: float = 0.0
	var _ri: int = 0
	var _fi: int = 0

	func _on_built() -> void:
		mode = "always"
		animate_draw = true            # the ripple surface genuinely re-shapes each frame
		z_index = 1
		for i in range(8):
			_rings.append({"on": false, "x": 0.0, "age": 0.0, "dur": 2.0, "rmax": 60.0, "col": Color.WHITE})
		for i in range(3):
			_fish.append({"on": false, "x": 0.0, "y": 0.0, "vx": 0.0, "age": 0.0, "dur": 2.5, "sz": 10.0, "col": Color(0.1, 0.12, 0.16)})
		_next_ring = Proc.rangef(seedv, "r0", 0.4, 1.4)
		_next_fish = Proc.rangef(seedv, "f0", 1.2, 3.0)

	func _apply() -> void:
		modulate.a = clampf(0.25 + 0.75 * visibility(), 0.0, 1.0)

	func _animate(delta: float) -> void:
		var vis := visibility()
		var rate := clampf(density * g() * (0.35 + 0.65 * vis), 0.05, 1.5)
		# spawn ripples on a seeded interval
		if t >= _next_ring:
			_spawn_ring()
			_ri += 1
			_next_ring = t + Proc.rangef(seedv, "ri%d" % _ri, 1.4, 4.0) / rate
		if t >= _next_fish:
			_spawn_fish()
			_fi += 1
			_next_fish = t + Proc.rangef(seedv, "fi%d" % _fi, 3.0, 8.0) / rate
		# advance pools
		for r in _rings:
			if r["on"]:
				r["age"] += delta
				if r["age"] >= r["dur"]:
					r["on"] = false
		for f in _fish:
			if f["on"]:
				f["age"] += delta
				f["x"] += f["vx"] * delta
				if f["age"] >= f["dur"]:
					f["on"] = false
					_spawn_ring_at(f["x"], f["col"])   # the fish breaks the surface

	func _spawn_ring() -> void:
		_spawn_ring_at(Proc.rangef(seedv, "rx%d" % _ri, size.x * 0.1, size.x * 0.9),
			Color(cols.get("water", Color(0.85, 0.95, 1.0))))

	func _spawn_ring_at(x: float, col: Color) -> void:
		for r in _rings:
			if not r["on"]:
				r["on"] = true
				r["x"] = x
				r["age"] = 0.0
				r["dur"] = Proc.rangef(seedv, "rd%d" % _ri, 1.6, 3.0)
				r["rmax"] = Proc.rangef(seedv, "rm%d" % _ri, 46.0, 92.0)
				r["col"] = col
				return

	func _spawn_fish() -> void:
		for f in _fish:
			if not f["on"]:
				var dir := (1.0 if Proc.hashf(seedv, "fd%d" % _fi) < 0.5 else -1.0)
				f["on"] = true
				f["x"] = (size.x * 0.2 if dir > 0.0 else size.x * 0.8)
				f["y"] = water_y + Proc.rangef(seedv, "fy%d" % _fi, 6.0, 22.0)
				f["vx"] = dir * Proc.rangef(seedv, "fv%d" % _fi, 60.0, 130.0)
				f["age"] = 0.0
				f["dur"] = Proc.rangef(seedv, "ff%d" % _fi, 1.4, 2.6)
				f["sz"] = Proc.rangef(seedv, "fs%d" % _fi, 8.0, 16.0)
				f["col"] = Color(cols.get("water", Color(0.8, 0.9, 1.0))).darkened(0.65)
				return

	func _draw() -> void:
		# darting shadows under the surface (drawn first, below the rings)
		for f in _fish:
			if not f["on"]:
				continue
			var fa := clampf(sin(f["age"] / f["dur"] * PI), 0.0, 1.0) * 0.5
			var sx: float = f["x"]
			var sy: float = f["y"]
			var sz: float = f["sz"]
			var d := signf(f["vx"])
			var fish := PackedVector2Array([
				Vector2(sx - d * sz, sy),
				Vector2(sx, sy - sz * 0.42),
				Vector2(sx + d * sz * 0.9, sy),
				Vector2(sx, sy + sz * 0.42),
			])
			var fc: Color = f["col"]
			draw_colored_polygon(fish, Color(fc.r, fc.g, fc.b, fa))
			# tail flick
			draw_colored_polygon(PackedVector2Array([
				Vector2(sx - d * sz, sy),
				Vector2(sx - d * sz * 1.5, sy - sz * 0.4),
				Vector2(sx - d * sz * 1.5, sy + sz * 0.4)]),
				Color(fc.r, fc.g, fc.b, fa * 0.8))

		# expanding concentric ripple rings
		for r in _rings:
			if not r["on"]:
				continue
			var p: float = r["age"] / r["dur"]
			var ease := 1.0 - pow(1.0 - p, 2.0)
			var base_r: float = float(r["rmax"]) * ease
			var a := (1.0 - p) * 0.55
			var col: Color = r["col"]
			for ring in range(2):
				var rr: float = base_r - float(ring) * float(r["rmax"]) * 0.22
				if rr <= 2.0:
					continue
				var ra := a * (1.0 - ring * 0.4)
				_draw_ring(Vector2(r["x"], water_y), rr, Color(col.r, col.g, col.b, ra))
			# a bright pluck at the centre early on
			if p < 0.25:
				draw_circle(Vector2(r["x"], water_y), 2.5 * (1.0 - p * 4.0),
					Color(1, 1, 1, (0.25 - p) * 2.0))

	func _draw_ring(c: Vector2, r: float, col: Color) -> void:
		var pts := PackedVector2Array()
		var steps := 28
		for i in range(steps + 1):
			var a := TAU * float(i) / float(steps)
			pts.append(c + Vector2(cos(a) * r, sin(a) * r * 0.34))     # flattened = perspective
		draw_polyline(pts, col, maxf(1.0, 2.2 - r * 0.012), true)

# ===========================================================================
#  THE AMBIENCE MANAGER  (holds + drives every effect; the single public node)
# ===========================================================================

class _Ambience extends ProcNode:
	var size: Vector2 = Vector2(1080, 1920)
	var base_key: String = "air"
	var world_seed: int = 0
	var kinds: Array = []
	var cols: Dictionary = {}
	var tod: float = 0.35
	var auto_advance: bool = false
	var day_seconds: float = 1680.0
	var density: float = 1.0
	var weather: String = "clear"
	var water_y: float = -1.0
	var wind: Vector2 = Vector2.ZERO

	var _effects: Dictionary = {}     # kind -> _Effect
	var _daylight: float = 1.0
	var _dusk: float = 0.0

	func _on_built() -> void:
		for kind in kinds:
			var opts := {
				"colours": cols, "density": density, "wind": wind,
				"start_growth": growth,
			}
			var fx: _Effect
			if kind == "fish":
				opts["water_y"] = (water_y if water_y >= 0.0 else size.y * 0.72)
				fx = ProcAmbience._make_agents(world_seed, base_key, "fish", size, opts) as _Effect
			elif kind in ProcAmbience.AGENT_KINDS:
				fx = ProcAmbience._make_agents(world_seed, base_key, kind, size, opts) as _Effect
			else:
				fx = ProcAmbience._make_particle(world_seed, base_key, kind, size, opts) as _Effect
			fx._managed = true
			fx.grow_rate = 0.0                 # the manager is the single growth authority
			add_child(fx)
			_effects[kind] = fx

		_compute_light()
		_push_light()
		_push_growth()
		set_weather(weather)

	func _animate(delta: float) -> void:
		if auto_advance and day_seconds > 0.0:
			tod = fposmod(tod + delta / day_seconds, 1.0)
		_compute_light()
		_push_light()

	func _on_growth() -> void:
		_push_growth()

	func _compute_light() -> void:
		var arg := (tod - 0.25) * TAU
		var sun_alt := sin(arg)
		_daylight = smoothstep(-0.05, 0.22, sun_alt)
		_dusk = exp(-pow(sun_alt / 0.20, 2.0))

	func _push_light() -> void:
		for k in _effects:
			(_effects[k] as _Effect).set_daylight(_daylight, _dusk)

	func _push_growth() -> void:
		for k in _effects:
			(_effects[k] as _Effect).set_growth(growth)

	# ── public controls ──────────────────────────────────────────────────

	# Sync to the sky's clock (0 midnight, .25 dawn, .5 noon, .75 dusk). Call every
	# frame with sky.get_time_of_day() so the life follows the light.
	func set_time_of_day(v: float) -> void:
		tod = fposmod(v, 1.0)
		_compute_light()
		_push_light()

	func get_time_of_day() -> float:
		return tod

	# Drive the day cycle internally instead of syncing to a sky.
	func set_auto_advance(on: bool, minutes: float = -1.0) -> void:
		auto_advance = on
		if minutes > 0.0:
			day_seconds = minutes * 60.0

	# Weather drives the rain / snow fields on or off.
	func set_weather(w: String) -> void:
		weather = w
		match w:
			"rain", "storm":
				start("rain"); stop("snow")
				if _effects.has("rain"):
					(_effects["rain"] as _Effect).set_density(density * (1.6 if w == "storm" else 1.0))
			"snow":
				start("snow"); stop("rain")
			_:  # clear
				stop("rain"); stop("snow")

	# Bias the drift of airborne life (and the lean of flight paths).
	func set_wind(w: Vector2) -> void:
		wind = w
		for k in _effects:
			(_effects[k] as _Effect).set_wind(w)

	# Global life-density multiplier (0 = still, 1 = normal, >1 = teeming).
	func set_density(d: float) -> void:
		density = maxf(0.0, d)
		for k in _effects:
			var fx := _effects[k] as _Effect
			# don't trample a weather field that is currently off
			if (k == "rain" or k == "snow") and not _weather_wants(k):
				continue
			fx.set_density(density)

	func _weather_wants(k: String) -> bool:
		if k == "rain":
			return weather == "rain" or weather == "storm"
		if k == "snow":
			return weather == "snow"
		return true

	# Start / stop any single effect by kind.
	func start(kind: String) -> void:
		if _effects.has(kind):
			(_effects[kind] as _Effect).start()

	func stop(kind: String) -> void:
		if _effects.has(kind):
			(_effects[kind] as _Effect).stop()

	# Fetch an effect node to tweak it directly (or null).
	func get_effect(kind: String):
		return _effects.get(kind, null)

	func has_effect(kind: String) -> bool:
		return _effects.has(kind)

	func effect_kinds() -> Array:
		return _effects.keys()

	# Resize the whole ambience region (e.g. on a safe-area / resolution change).
	func set_size(new_size: Vector2) -> void:
		size = new_size
		for k in _effects:
			var fx := _effects[k] as _Effect
			fx.size = new_size
			if fx is _ParticleEffect:
				for p in (fx as _ParticleEffect)._systems:
					(fx as _ParticleEffect)._place_box(p)
			elif fx is _AgentSwarm:
				for f in (fx as _AgentSwarm)._fliers:
					(f as _Flier).region = new_size

# ===========================================================================
#  colour-drift helper (blend a species tint toward the local palette, §2.3a)
# ===========================================================================
static func _drift(c: Color, cols: Dictionary, amt: float) -> Color:
	if cols.has("accent") and cols["accent"] is Color:
		return c.lerp(cols["accent"], clampf(amt, 0.0, 1.0))
	return c
