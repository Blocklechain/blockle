class_name ProcAtmosphere
extends RefCounted
# ProcAtmosphere — the AIR between the depth bands (GFX-2.5D §3).
#
# Where `ProcDepth.tint` bakes distance-fog INTO each entity's palette, this
# module draws the VOLUME of the atmosphere itself:
#
#   • depth FOG BANDS — scrolling noise-shader strips with an undulating
#     fog-bank crest, plus drifting soft puff shells, mounted between the
#     parallax planes so the island reads as air-separated layers;
#   • GOD RAYS — a fan of soft-edged crepuscular shafts pouring from the sun's
#     real screen position (the same arc ProcSky draws its disc on), gated to
#     clear weather and a high sun, easing in/out over ~2 s;
#   • HORIZON GLOW — a sun-anchored additive bloom with a lateral lobe, a
#     stacked-ellipse sun swell and lit-from-below cloud bars, strongest at
#     dawn and dusk, mounted behind the P1 islets;
#   • HEAT SHIMMER — an optional screen-UV wobble strip for ember/desert
#     realms (default OFF; only instanced when the realm opts ask).
#
# Everything is pure math: seeded quads, Catmull puff shells, vertex-alpha
# gradients and four tiny fragment shaders. No textures, no particles — dust
# motes stay in `ProcAmbience` (WorldSpace instances `make_dust` per band so
# motes inherit that band's parallax); this module never duplicates them.
#
# ── Factories (WorldSpace mounts these between its parallax planes) ─────────
#   ProcAtmosphere.make_haze_band(seed, key, size, depth, opts)  -> ProcNode
#       One drifting fog volume. Mount one per plane (spec §3):
#         P3 mid  : depth 0.60                      — the main volume
#         P1 far  : depth 0.95, {"layers": 1}       — thin, almost sky
#         P5 front: depth 0.08, {"alpha": 0.04}     — near-invisible tie-in
#   ProcAtmosphere.make_god_rays(seed, key, size, opts)          -> ProcNode
#       Soft additive shaft fan from the sun; mount just above P4 so the rays
#       fall BEHIND the front-band trees.
#   ProcAtmosphere.make_horizon_glow(seed, key, size, opts)      -> ProcNode
#       Dawn/dusk horizon bloom; mount behind the P1 islet band.
#   ProcAtmosphere.make_heat_shimmer(seed, key, size, opts)      -> ProcNode
#       Screen-texture wobble strip above the back band — realm-gated.
#
# ── Shared node API (EVERY returned node) ───────────────────────────────────
#   set_strength(s: float)                  # 0..2 master fade (weather blends)
#   set_light_ctx(lc: Dictionary)           # push a full LightCtx (§2.2)
#   set_sky_state(tod: float, weather)      # or feed raw ProcSky state and a
#                                           # full LightCtx is synthesised here
#   plus the whole ProcNode contract: growth in [0,1] thins the volume
#   believably, `pop_in()` breathes it in, `set_growth()` is safe pre-tree.
#
# ── Lighting without coupling ───────────────────────────────────────────────
# When ProcLighting is in the project the nodes self-subscribe: they poll
# `ProcLighting.version()` at 4 Hz (duck-typed through the global class list, so
# this file parses and runs even before/without ProcLighting) and re-apply the
# shared LightCtx on change — uniform pushes and child transforms only, never a
# redraw, never an allocation. Standalone (tests, previews) everything renders
# under a deterministic noon default per spec §7.10. WorldSpace may also drive
# them directly:   atmo.set_sky_state(_sky.call("get_time_of_day"), weather_id)
#
# ── Cost budget (all four nodes together, per frame) ────────────────────────
#   ≤ 6 shader quads (haze strips + rays + glow) with trivial fragments,
#   ≤ 26 cached static polygons animated by transform/modulate only,
#   ≤ 6 uniform pushes, zero redraws after build, zero per-frame allocation.

# ===========================================================================
#  PUBLIC FACTORIES
# ===========================================================================

# A drifting depth-fog volume for one parallax plane.
# `size` is the strip rect (top-left origin, per CONVENTIONS rule 7).
# `depth` in [0,1] drives alpha (spec §1.4 fog curve), drift speed (slower the
# farther back) and the puff count.
# opts:
#   alpha      float  base alpha             (default 0.10 + 0.14*fog_mix(depth))
#   layers     int    1..3 shader strips     (default 2, 1 at depth > 0.85)
#   puffs      int    soft puff shells, -1 = auto from lod/depth  (default -1)
#   lod        int    0/1/2 — LOD2 drops the puffs entirely       (default auto)
#   soft_top   float  top feather fraction   (default 0.35)
#   soft_bot   float  bottom feather         (default 0.35)
#   shelf      float  fog-bank crest wobble  (default 0.55)
#   warm       float  sun-side warm bias     (default 0.5)
#   clump      float  noise contrast         (default 1.0)
static func make_haze_band(world_seed: int, key: String, size: Vector2,
		depth: float, opts: Dictionary = {}) -> ProcNode:
	var n := _HazeBand.new()
	n.seedv = hash("%d:atmo-haze:%s" % [world_seed, key])
	n.size = _safe_size(size)
	n.depth = clampf(depth, 0.0, 1.0)
	n.opts = opts
	return n

# The crepuscular shaft fan. `size` is the rect the fan should cover (normally
# the viewport). opts:
#   count   int    3..9 shafts                       (default seeded 5..9)
#   spread  float  fan angular spread in radians     (default 0.62)
#   length  float  shaft length multiplier           (default 1.0)
#   width   float  shaft width multiplier            (default 1.0)
#   root    bool   wide binding glow at the apex     (default true)
#   gate_e  float  sun_energy gate                   (default 0.55, spec §3)
static func make_god_rays(world_seed: int, key: String, size: Vector2,
		opts: Dictionary = {}) -> ProcNode:
	var n := _GodRays.new()
	n.seedv = hash("%d:atmo-rays:%s" % [world_seed, key])
	n.size = _safe_size(size)
	n.opts = opts
	return n

# Optional heat shimmer (ember/desert realms). Default-OFF at the call site:
# WorldSpace only instances this when the realm asks ({"shimmer": true}).
# opts: amp float px displacement (default 1.5) · warm float tint (default 0.35)
#       gate_lo/gate_hi floats — the sun_energy ramp (default 0.45 / 0.70)
static func make_heat_shimmer(world_seed: int, key: String, size: Vector2,
		opts: Dictionary = {}) -> ProcNode:
	var n := _HeatShimmer.new()
	n.seedv = hash("%d:atmo-shimmer:%s" % [world_seed, key])
	n.size = _safe_size(size)
	n.opts = opts
	return n

# The dawn/dusk horizon bloom that sits behind the distant islets. `size` is the
# glow rect; its BOTTOM edge should sit on the horizon line.
# opts:
#   bloom  float  sun-swell radius as a fraction of width (default 0.5)
#   spread float  lateral lobe width in UV              (default 0.34)
#   bars   int    lit-from-below cloud bars, 0 disables (default 4)
#   floor  float  daytime glow floor                    (default 0.10)
static func make_horizon_glow(world_seed: int, key: String, size: Vector2,
		opts: Dictionary = {}) -> ProcNode:
	var n := _HorizonGlow.new()
	n.seedv = hash("%d:atmo-glow:%s" % [world_seed, key])
	n.size = _safe_size(size)
	n.opts = opts
	return n

static func _safe_size(s: Vector2) -> Vector2:
	return Vector2(maxf(8.0, s.x), maxf(8.0, s.y))

# ===========================================================================
#  LIGHT + SUN MATH  (shared, pure, allocation-free)
# ===========================================================================

# Deterministic noon-clear LightCtx — what every node shades under when no
# lighting has ever been pushed (standalone factories must still render).
static func default_light() -> Dictionary:
	return ProcAtmosphere.light_from_tod(0.5, "clear")

# Synthesise a full LightCtx (GFX-2.5D §2.2 shape, ALL fields present) from raw
# ProcSky state. Pure math — a mirror of the ProcLighting._Driver derivation, so
# a world that only wires set_sky_state() still gets the same dawn/noon/dusk/
# night response as one running the full lighting driver.
static func light_from_tod(tod: float, weather: String = "clear") -> Dictionary:
	var td: float = fposmod(tod, 1.0)
	var el: float = sin(td * TAU - PI * 0.5) * 0.5 + 0.5
	var ax: float = -cos(td * TAU - PI * 0.5)
	var sun_dir: Vector2 = Vector2(ax * 0.78, maxf(0.25, el)).normalized()
	var damp: float = 1.0
	match weather:
		"overcast", "mist":
			damp = 0.55
		"storm":
			damp = 0.35
	var energy: float = smoothstep(0.08, 0.35, el) * damp
	# Anchored colour stops: night slate → dawn rose → noon warm white → dusk amber.
	var c_night := Color("2d3350")
	var c_dawn := Color("ffb48c")
	var c_noon := Color("fff6e0")
	var c_dusk := Color("ff9a5c")
	var sun_color: Color
	if td < 0.25:
		sun_color = c_night.lerp(c_dawn, smoothstep(0.10, 0.25, td))
	elif td < 0.5:
		sun_color = c_dawn.lerp(c_noon, smoothstep(0.27, 0.45, td))
	elif td < 0.75:
		sun_color = c_noon.lerp(c_dusk, smoothstep(0.55, 0.73, td))
	else:
		sun_color = c_dusk.lerp(c_night, smoothstep(0.77, 0.92, td))
	var hz_day := Color("dce7f2")
	var hz_night := Color("272c44")
	var horizon: Color = hz_night.lerp(hz_day, smoothstep(0.05, 0.45, el)).lerp(sun_color, 0.30)
	var ambient: Color = horizon.lerp(c_night, 0.40).lerp(Color.WHITE, 0.15 * energy)
	return {
		"tod": td,
		"sun_dir": sun_dir,
		"sun_color": sun_color,
		"sun_energy": energy,
		"ambient": ambient,
		"horizon": horizon,
		"is_night": energy < 0.18,
		"weather": weather,
		"version": 0,
	}

# How close `tod` is to dawn (0.25) or dusk (0.75): 1 at the moment itself,
# fading to 0 over ±0.09 of the cycle. Drives the horizon glow + warm haze tint.
static func duskiness(tod: float) -> float:
	var td: float = fposmod(tod, 1.0)
	return 1.0 - clampf(absf(absf(td - 0.5) - 0.25) / 0.09, 0.0, 1.0)

# The sun's SCREEN position in 0..1 viewport UV, using the exact arc ProcSky
# draws its disc on (`0.5 − 0.42·cos((tod−0.25)·TAU)` / `0.86 − 0.66·alt`). Every
# atmosphere node anchors to THIS, not to `sun_dir`, so glow + shafts line up
# with the disc the player can actually see. (`sun_dir` is a shading direction;
# its sign convention is set by spec §2.2 and is not a screen position.)
static func sun_screen_uv(tod: float) -> Vector2:
	var arg: float = (fposmod(tod, 1.0) - 0.25) * TAU
	var alt: float = sin(arg)
	return Vector2(0.5 - 0.42 * cos(arg), 0.86 - 0.66 * clampf(alt, -0.25, 1.0))

# The unit direction light travels ON SCREEN from the sun through the scene —
# what the shaft fan points along. Derived from `sun_screen_uv`, so it always
# agrees with the visible disc; aspect is folded in by the caller's rect.
static func sun_fall_dir(tod: float) -> Vector2:
	var s: Vector2 = ProcAtmosphere.sun_screen_uv(tod)
	var v: Vector2 = Vector2(0.5, 1.25) - s
	if v.length() < 0.001:
		return Vector2(0.0, 1.0)
	return v.normalized()

# Local mirror of ProcDepth.fog_mix (spec §1.4) so this file carries no
# parse-order dependency: 0 at the front, 0.42 at the back edge.
static func _fog_mix(d: float) -> float:
	var e: float = clampf(d, 0.0, 1.0)
	return 0.42 * pow(e, 1.5)

# Local mirror of ProcDepth.parallax — used to slow the far bands' drift.
static func _parallax(d: float) -> float:
	return lerpf(1.0, 0.25, clampf(d, 0.0, 1.0))

# Weather multiplier for fog volume (thicker when wet) — one table, shared.
static func _weather_fog(weather: String) -> float:
	match weather:
		"mist":
			return 1.85
		"overcast":
			return 1.30
		"storm":
			return 1.50
		_:
			return 1.0

# ---- soft runtime binding to ProcLighting (no hard class reference) ---------

static var _lgt: Object = null
static var _lgt_checked: bool = false

static func _lighting() -> Object:
	if not _lgt_checked:
		_lgt_checked = true
		for info in ProjectSettings.get_global_class_list():
			var d: Dictionary = info
			if String(d.get("class", "")) == "ProcLighting":
				var res: Resource = load(String(d.get("path", "")))
				if res is Script:
					_lgt = res
				break
	return _lgt

# ===========================================================================
#  SHADERS  (four tiny fragments; Shader resources are cached + shared)
# ===========================================================================

const _NOISE_GLSL := """
float ah2(vec2 p) {
	return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float vnoise(vec2 p) {
	vec2 i = floor(p);
	vec2 f = fract(p);
	vec2 u = f * f * (3.0 - 2.0 * f);
	float a = ah2(i);
	float b = ah2(i + vec2(1.0, 0.0));
	float c = ah2(i + vec2(0.0, 1.0));
	float d = ah2(i + vec2(1.0, 1.0));
	return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
"""

# FOG STRIP — two scrolling value-noise octaves, a swirled domain, an undulating
# fog-bank crest and a warm sun-side lobe. Two noise taps per fragment.
const _HAZE_SHADER := "shader_type canvas_item;\n" + """
uniform vec4 u_color : source_color = vec4(0.85, 0.89, 0.95, 1.0);
uniform vec4 u_warm : source_color = vec4(1.0, 0.86, 0.68, 1.0);
uniform float u_alpha = 0.16;
uniform float u_strength = 1.0;
uniform float u_t = 0.0;
uniform vec2 u_scroll = vec2(0.016, 0.009);
uniform float u_scale = 2.8;
uniform vec2 u_seed = vec2(0.0, 0.0);
uniform float u_soft_top = 0.35;
uniform float u_soft_bot = 0.35;
uniform float u_shelf = 0.55;
uniform float u_sun_x = 0.5;
uniform float u_sun_warm = 0.5;
uniform float u_clump = 1.0;
""" + _NOISE_GLSL + """
void fragment() {
	vec4 mc = COLOR;
	vec2 uv = UV;
	// cheap domain swirl: curls the fog without a third noise tap
	float sw = sin(uv.y * 5.3 + u_t * 0.11 + u_seed.x) * 0.06;
	float n1 = vnoise(vec2((uv.x + sw) * u_scale * 3.0 + u_t * u_scroll.x * 10.0,
		uv.y * u_scale * 1.1) + u_seed);
	float n2 = vnoise(vec2(uv.x * u_scale * 7.1 - u_t * u_scroll.y * 10.0,
		uv.y * u_scale * 2.4 + 3.7) + u_seed * 1.71);
	float n = n1 * 0.65 + n2 * 0.35;
	// the crest of the bank rolls with the coarse octave: a fog BANK, not a bar
	float top = clamp(u_soft_top * (1.0 + u_shelf * (n1 * 2.0 - 1.0)), 0.02, 0.92);
	float band = smoothstep(0.0, top, uv.y)
		* (1.0 - smoothstep(1.0 - u_soft_bot, 1.0, uv.y));
	float dx = (uv.x - u_sun_x) * 2.1;
	float lobe = exp(-dx * dx);
	vec3 col = mix(u_color.rgb, u_warm.rgb, clamp(u_sun_warm * lobe, 0.0, 1.0));
	float a = u_alpha * u_strength * band
		* mix(1.0, 0.42 + 0.58 * n, clamp(u_clump, 0.0, 1.0))
		* (1.0 + 0.35 * u_sun_warm * lobe);
	COLOR = vec4(col * mc.rgb, a * mc.a);
}
"""

# GOD-RAY SHAFT — soft lateral falloff + head/tail feather + a slow spine
# wobble. One shared material drives all shafts; per-shaft variety is geometry
# (rotation / size / scale) and `self_modulate`, so there is one uniform push
# per frame for the whole fan.
const _RAY_SHADER := "shader_type canvas_item;\nrender_mode blend_add;\n" + """
uniform vec4 u_core : source_color = vec4(1.0, 0.97, 0.88, 1.0);
uniform vec4 u_edge : source_color = vec4(1.0, 0.86, 0.66, 1.0);
uniform float u_t = 0.0;
uniform float u_taper = 2.1;
uniform float u_head = 0.07;
uniform float u_tail = 0.46;
uniform float u_wobble = 0.045;
void fragment() {
	vec4 mc = COLOR;
	float wob = sin(UV.y * 7.0 + u_t * 0.5) * u_wobble;
	float x = clamp(abs(UV.x - 0.5 + wob) * 2.0, 0.0, 1.0);
	float lat = pow(1.0 - x, u_taper);
	float along = smoothstep(0.0, u_head, UV.y) * (1.0 - smoothstep(u_tail, 1.0, UV.y));
	COLOR = vec4(mix(u_edge.rgb, u_core.rgb, lat) * mc.rgb, lat * along * mc.a);
}
"""

# HORIZON GLOW — vertical ramp toward the horizon line × a lateral lobe centred
# on the sun's real screen x, with faint stratified banding for dawn air.
const _GLOW_SHADER := "shader_type canvas_item;\nrender_mode blend_add;\n" + """
uniform vec4 u_color : source_color = vec4(1.0, 0.92, 0.78, 1.0);
uniform float u_alpha = 0.3;
uniform float u_strength = 1.0;
uniform float u_sun_x = 0.5;
uniform float u_spread = 0.34;
uniform float u_floor = 0.18;
uniform float u_bands = 0.4;
uniform float u_t = 0.0;
void fragment() {
	vec4 mc = COLOR;
	float v = pow(UV.y, 2.0);                               // brightest at the horizon
	float dx = (UV.x - u_sun_x) / max(0.04, u_spread);
	float lobe = exp(-dx * dx);
	float lateral = u_floor + (1.0 - u_floor) * lobe;
	float bands = 1.0 + u_bands * 0.30 * sin(UV.y * 21.0 + u_t * 0.13)
		* smoothstep(0.45, 1.0, UV.y);
	COLOR = vec4(u_color.rgb * mc.rgb, u_alpha * u_strength * v * lateral * bands * mc.a);
}
"""

# HEAT SHIMMER — screen read displaced by two travelling sines (both axes) with
# a warm bias, feathered top and bottom. The only screen-texture read outside
# ProcPost, and only ever instanced for realms that ask for it.
const _SHIMMER_SHADER := "shader_type canvas_item;\n" + """
uniform sampler2D u_screen : hint_screen_texture, filter_linear;
uniform float u_t = 0.0;
uniform float u_amp_px = 1.5;
uniform float u_strength = 0.0;
uniform float u_warm_amt = 0.35;
uniform vec4 u_warm : source_color = vec4(1.0, 0.88, 0.72, 1.0);
void fragment() {
	float edge = smoothstep(0.0, 0.30, UV.y) * (1.0 - smoothstep(0.70, 1.0, UV.y));
	float s = edge * clamp(u_strength, 0.0, 1.0);
	float w = sin(UV.x * 52.0 + u_t * 2.6) * 0.6 + sin(UV.x * 23.0 - u_t * 1.7) * 0.4;
	float h = sin(UV.y * 31.0 + u_t * 1.9) * 0.5;
	vec2 suv = SCREEN_UV;
	suv.y += w * u_amp_px * SCREEN_PIXEL_SIZE.y * s;
	suv.x += h * u_amp_px * 0.6 * SCREEN_PIXEL_SIZE.x * s;
	vec3 scr = texture(u_screen, suv).rgb;
	scr = mix(scr, scr * u_warm.rgb + u_warm.rgb * 0.05, clamp(u_warm_amt * s, 0.0, 1.0));
	COLOR = vec4(scr, s);
}
"""

static var _sh_haze: Shader = null
static var _sh_ray: Shader = null
static var _sh_glow: Shader = null
static var _sh_shimmer: Shader = null

static func _shader_of(code: String, cache: int) -> Shader:
	match cache:
		0:
			if _sh_haze == null:
				_sh_haze = Shader.new()
				_sh_haze.code = code
			return _sh_haze
		1:
			if _sh_ray == null:
				_sh_ray = Shader.new()
				_sh_ray.code = code
			return _sh_ray
		2:
			if _sh_glow == null:
				_sh_glow = Shader.new()
				_sh_glow.code = code
			return _sh_glow
		_:
			if _sh_shimmer == null:
				_sh_shimmer = Shader.new()
				_sh_shimmer.code = code
			return _sh_shimmer

static func haze_shader() -> Shader:
	return ProcAtmosphere._shader_of(ProcAtmosphere._HAZE_SHADER, 0)

static func ray_shader() -> Shader:
	return ProcAtmosphere._shader_of(ProcAtmosphere._RAY_SHADER, 1)

static func glow_shader() -> Shader:
	return ProcAtmosphere._shader_of(ProcAtmosphere._GLOW_SHADER, 2)

static func shimmer_shader() -> Shader:
	return ProcAtmosphere._shader_of(ProcAtmosphere._SHIMMER_SHADER, 3)

# ===========================================================================
#  SHARED BASE NODE
# ===========================================================================

class _AtmoNode extends ProcNode:
	# Common contract for every atmosphere node: a rect, an opts dict, a master
	# strength and a cached LightCtx that is re-applied (uniforms + transforms
	# only, never a redraw) whenever lighting, strength or growth changes.
	const POLL_SEC := 0.25

	var size: Vector2 = Vector2(1080.0, 1920.0)
	var opts: Dictionary = {}
	var strength: float = 1.0
	var _lc: Dictionary = {}
	var _built: bool = false
	var _lit_version: int = -2147483647
	var _poll_accum: float = 0.0

	func _init() -> void:
		grow_rate = 0.0           # atmosphere does not creep-grow; pop_in still works
		_lc = ProcAtmosphere.default_light()

	# --- public, identical on all four nodes --------------------------------

	func set_strength(s: float) -> void:
		strength = clampf(s, 0.0, 2.0)
		if _built:
			_on_light(_lc)

	func set_light_ctx(lc: Dictionary) -> void:
		if lc.is_empty():
			return
		_lc = lc
		if _built:
			_on_light(_lc)

	func set_sky_state(tod: float, weather: String = "clear") -> void:
		set_light_ctx(ProcAtmosphere.light_from_tod(tod, weather))

	# --- shared internals ---------------------------------------------------

	# Effective master fade: strength × eased growth, so pop_in() breathes the
	# volume in and ANY growth in [0,1] reads as thinner-but-believable air.
	func _eff() -> float:
		return strength * g()

	func _on_built() -> void:
		_build()
		_built = true
		_on_light(_lc)

	func _on_growth() -> void:
		if _built:
			_on_light(_lc)

	func _animate(delta: float) -> void:
		if not _built:
			return
		# 4 Hz duck-typed poll of ProcLighting (when the project has it): re-apply
		# only on version change (~every 7 s of the 28-min day cycle) — uniform
		# pushes and child transforms, never redraws.
		_poll_accum += delta
		if _poll_accum >= POLL_SEC:
			_poll_accum = 0.0
			var lgt: Object = ProcAtmosphere._lighting()
			if lgt != null:
				var vv: Variant = lgt.call("version")
				if vv is int and int(vv) != _lit_version:
					_lit_version = int(vv)
					var cv: Variant = lgt.call("ctx")
					if cv is Dictionary:
						set_light_ctx(cv)
		_tick(delta)

	# Subclass hooks.
	func _build() -> void:
		pass
	func _on_light(_lc2: Dictionary) -> void:
		pass
	func _tick(_delta: float) -> void:
		pass

	# Typed pulls out of the LightCtx with safe defaults (never Variant).
	func _lc_color(k: String, def: Color) -> Color:
		var v: Variant = _lc.get(k, def)
		return v if v is Color else def
	func _lc_float(k: String, def: float) -> float:
		var v: Variant = _lc.get(k, def)
		return float(v) if (v is float or v is int) else def
	func _lc_vec(k: String, def: Vector2) -> Vector2:
		var v: Variant = _lc.get(k, def)
		return v if v is Vector2 else def
	func _lc_str(k: String, def: String) -> String:
		var v: Variant = _lc.get(k, def)
		return String(v) if v is String else def

	func _opt_f(k: String, def: float) -> float:
		var v: Variant = opts.get(k, def)
		return float(v) if (v is float or v is int) else def
	func _opt_i(k: String, def: int) -> int:
		var v: Variant = opts.get(k, def)
		return int(v) if (v is int or v is float) else def
	func _opt_b(k: String, def: bool) -> bool:
		var v: Variant = opts.get(k, def)
		return bool(v) if v is bool else def
	func _opt_str(k: String, def: String) -> String:
		var v: Variant = opts.get(k, def)
		return String(v) if v is String else def
	func _opt_v2(k: String, def: Vector2) -> Vector2:
		var v: Variant = opts.get(k, def)
		return v if v is Vector2 else def
	func _opt_col(k: String, def: Color) -> Color:
		var v: Variant = opts.get(k, def)
		return v if v is Color else def

	# A shader quad child, sized to a sub-rect of this node, sharing one Shader.
	func _quad(sh: Shader, at: Vector2, rect: Vector2) -> ColorRect:
		var mat := ShaderMaterial.new()
		mat.shader = sh
		var r := ColorRect.new()
		r.material = mat
		r.position = at
		r.size = Vector2(maxf(1.0, rect.x), maxf(1.0, rect.y))
		r.mouse_filter = Control.MOUSE_FILTER_IGNORE
		add_child(r)
		return r

	# Sun screen x in 0..1 for the CURRENT light context, anchored to the arc
	# ProcSky draws on and nudged by sun_dir so a custom LightCtx still steers it.
	func _sun_x() -> float:
		var tod: float = _lc_float("tod", 0.5)
		var sx: float = ProcAtmosphere.sun_screen_uv(tod).x
		var sd: Vector2 = _lc_vec("sun_dir", Vector2(0.12, 0.99))
		return clampf(sx - sd.x * 0.04, -0.15, 1.15)


# A Node2D that draws a cached list of {pts, cols} polygons exactly ONCE. Shapes
# never change after build — all animation is transform/modulate on the node.
# Reused by the fog puffs, the sun swell and the horizon cloud bars.
class _PolyLayer extends Node2D:
	var polys: Array = []        # Array of {"pts": PackedVector2Array, "cols": PackedColorArray}

	func _draw() -> void:
		for e in polys:
			var d: Dictionary = e
			var pts: PackedVector2Array = d.get("pts", PackedVector2Array())
			if pts.size() < 3:
				continue          # degenerate guard — never draw < 3 points
			var cols: PackedColorArray = d.get("cols", PackedColorArray())
			if cols.size() == pts.size():
				draw_polygon(pts, cols)
			else:
				draw_polygon(pts, PackedColorArray([Color.WHITE]))

	# Build a soft shell: a squashed Catmull blob with a vertical alpha ramp.
	# Returns an empty dict when the shape would be degenerate (never drawn).
	static func shell(seedv: int, key: String, radius: float, stretch: float,
			squash: float, a_top: float, a_bot: float) -> Dictionary:
		if radius <= 0.5:
			return {}
		var raw: PackedVector2Array = Proc.blob(seedv, key, radius, 9, 0.30)
		if raw.size() < 3:
			return {}
		var pts := PackedVector2Array()
		pts.resize(raw.size())
		for i in range(raw.size()):
			pts[i] = Vector2(raw[i].x * stretch, raw[i].y * squash)
		var cols: PackedColorArray = Proc.grad_fill(pts,
			Color(1.0, 1.0, 1.0, a_top), Color(1.0, 1.0, 1.0, a_bot))
		return {"pts": pts, "cols": cols}

	# A rising fog WISP: a tall tapering ribbon that is dense at its foot and
	# dissolves at its crown, so mist reads as rising air rather than a flat veil.
	# Anchored foot-at-origin (grows up-screen, per CONVENTIONS rule 7).
	# Returns {} when the shape would be degenerate.
	static func wisp(seedv: int, key: String, w: float, h: float,
			a_foot: float, a_crown: float) -> Dictionary:
		if w <= 1.0 or h <= 4.0:
			return {}
		var lean: float = Proc.rangef(seedv, key + ":lean", -0.34, 0.34)
		var bulge: float = Proc.rangef(seedv, key + ":bulge", 0.55, 1.15)
		# Controls run up the right flank and back down the left, so the Catmull
		# loop never retraces itself (a self-retracing outline is a bug per spec).
		var controls := PackedVector2Array([
			Vector2(w * 0.42, -h * 0.02),
			Vector2(w * 0.50 * bulge, -h * 0.30),
			Vector2(w * 0.30 + lean * w, -h * 0.63),
			Vector2(w * 0.10 + lean * w * 1.6, -h * 0.98),
			Vector2(-w * 0.14 + lean * w * 1.6, -h * 0.92),
			Vector2(-w * 0.34 + lean * w, -h * 0.58),
			Vector2(-w * 0.52 * bulge, -h * 0.26),
			Vector2(-w * 0.40, -h * 0.02),
		])
		var pts: PackedVector2Array = Proc.smooth_loop(controls, 7)
		if pts.size() < 3:
			return {}
		# grad_fill ramps by y: min_y is the crown (faint), max_y the foot (dense).
		var cols: PackedColorArray = Proc.grad_fill(pts,
			Color(1.0, 1.0, 1.0, a_crown), Color(1.0, 1.0, 1.0, a_foot))
		return {"pts": pts, "cols": cols}

	# A crepuscular PILLAR: the soft vertical light column that stands over the
	# sun at dawn and dusk. Base at the origin (the horizon line), fading up.
	static func pillar(w: float, h: float, a_base: float, a_top: float) -> Dictionary:
		if w <= 1.0 or h <= 4.0:
			return {}
		var raw: PackedVector2Array = Proc.superellipse(w * 0.5, h * 0.5, 1.5, 40)
		if raw.size() < 3:
			return {}
		var pts := PackedVector2Array()
		pts.resize(raw.size())
		for i in range(raw.size()):
			# lift so the lens' bottom tip sits on the origin, and widen the base
			var yy: float = raw[i].y - h * 0.5
			var flare: float = 1.0 + 0.45 * clampf(raw[i].y / maxf(1.0, h * 0.5), 0.0, 1.0)
			pts[i] = Vector2(raw[i].x * flare, yy)
		var cols: PackedColorArray = Proc.grad_fill(pts,
			Color(1.0, 1.0, 1.0, a_top), Color(1.0, 1.0, 1.0, a_base))
		return {"pts": pts, "cols": cols}

	# A squashed ellipse (used for the sun swell + cloud bars), alpha-ramped.
	static func ellipse(rx: float, ry: float, a_top: float, a_bot: float,
			steps: int = 36) -> Dictionary:
		if rx <= 0.5 or ry <= 0.25:
			return {}
		var pts: PackedVector2Array = Proc.superellipse(rx, ry, 2.0, maxi(12, steps))
		if pts.size() < 3:
			return {}
		var cols: PackedColorArray = Proc.grad_fill(pts,
			Color(1.0, 1.0, 1.0, a_top), Color(1.0, 1.0, 1.0, a_bot))
		return {"pts": pts, "cols": cols}


# ===========================================================================
#  HAZE BAND — the drifting fog volume between two parallax planes
# ===========================================================================
#
# Three cooperating parts, all cached at build:
#   1. 1–3 noise-shader STRIPS (scrolling, swirled, with a rolling bank crest);
#   2. 0–8 soft PUFF shells (two nested Catmull blobs each) that drift across
#      the strip, wrap seamlessly and fade at the wrap edges;
#   3. one tint pass on lighting change (horizon colour, warmed at dawn/dusk,
#      thickened by weather) — uniform + modulate pushes only.
class _HazeBand extends _AtmoNode:
	const U_T := &"u_t"
	const U_COLOR := &"u_color"
	const U_WARM := &"u_warm"
	const U_ALPHA := &"u_alpha"
	const U_STRENGTH := &"u_strength"
	const U_SUN_X := &"u_sun_x"

	var depth: float = 0.6

	var _rects: Array[ColorRect] = []
	var _mats: Array[ShaderMaterial] = []
	var _layer_fade: PackedFloat32Array = PackedFloat32Array()
	var _sway_amp: PackedFloat32Array = PackedFloat32Array()
	var _sway_spd: PackedFloat32Array = PackedFloat32Array()
	var _sway_ph: PackedFloat32Array = PackedFloat32Array()
	var _base_x: PackedFloat32Array = PackedFloat32Array()

	var _puff_root: Node2D = null
	var _puffs: Array[_PolyLayer] = []
	var _puff_x: PackedFloat32Array = PackedFloat32Array()
	var _puff_y: PackedFloat32Array = PackedFloat32Array()
	var _puff_spd: PackedFloat32Array = PackedFloat32Array()
	var _puff_bob: PackedFloat32Array = PackedFloat32Array()
	var _puff_bsp: PackedFloat32Array = PackedFloat32Array()
	var _puff_ph: PackedFloat32Array = PackedFloat32Array()
	var _puff_a: PackedFloat32Array = PackedFloat32Array()

	var _wisp_root: Node2D = null
	var _wisps: Array[_PolyLayer] = []
	var _wisp_x: PackedFloat32Array = PackedFloat32Array()
	var _wisp_spd: PackedFloat32Array = PackedFloat32Array()
	var _wisp_lean: PackedFloat32Array = PackedFloat32Array()
	var _wisp_lsp: PackedFloat32Array = PackedFloat32Array()
	var _wisp_ph: PackedFloat32Array = PackedFloat32Array()
	var _wisp_a: PackedFloat32Array = PackedFloat32Array()
	var _wisp_sy: PackedFloat32Array = PackedFloat32Array()
	var _wisp_y: float = 0.0

	var _base_alpha: float = 0.16
	var _span: float = 1.0        # puff wrap span
	var _slow: float = 1.0        # parallax-derived drift damping
	var _wisp_swell: float = 1.0  # weather-driven vertical swell (cached in _on_light)

	func _build() -> void:
		_slow = ProcAtmosphere._parallax(depth)
		_base_alpha = _opt_f("alpha", 0.10 + 0.14 * ProcAtmosphere._fog_mix(depth))
		var want_layers: int = _opt_i("layers", 1 if depth > 0.85 else 2)
		var layers: int = clampi(want_layers, 1, 3)
		var sh: Shader = ProcAtmosphere.haze_shader()
		var soft_top: float = clampf(_opt_f("soft_top", 0.35), 0.02, 0.9)
		var soft_bot: float = clampf(_opt_f("soft_bot", 0.35), 0.02, 0.9)
		var shelf: float = clampf(_opt_f("shelf", 0.55), 0.0, 1.0)
		var clump: float = clampf(_opt_f("clump", 1.0), 0.0, 1.0)
		for i in range(layers):
			var kk := "hz%d" % i
			# Each strip is 8% wider than asked so its slow sway never exposes an edge.
			var rect: ColorRect = _quad(sh, Vector2(-size.x * 0.04, 0.0),
				Vector2(size.x * 1.08, size.y))
			var mat: ShaderMaterial = rect.material as ShaderMaterial
			mat.set_shader_parameter(&"u_scale",
				Proc.rangef(seedv, kk + ":scale", 2.0, 3.6) * (1.0 + 0.6 * float(i)))
			mat.set_shader_parameter(&"u_scroll", Vector2(
				Proc.rangef(seedv, kk + ":sx", 0.010, 0.024) * (1.0 if i == 0 else -0.6) * _slow,
				Proc.rangef(seedv, kk + ":sy", 0.005, 0.014) * _slow))
			mat.set_shader_parameter(&"u_seed", Vector2(
				Proc.rangef(seedv, kk + ":ox", 0.0, 37.0),
				Proc.rangef(seedv, kk + ":oy", 0.0, 37.0)))
			mat.set_shader_parameter(&"u_soft_top", soft_top * (1.0 - 0.25 * float(i)))
			mat.set_shader_parameter(&"u_soft_bot", soft_bot)
			mat.set_shader_parameter(&"u_shelf", shelf * (1.0 if i == 0 else 0.7))
			mat.set_shader_parameter(&"u_clump", clump)
			_rects.append(rect)
			_mats.append(mat)
			_base_x.append(rect.position.x)
			_layer_fade.append(1.0 - 0.35 * (float(i) / maxf(1.0, float(layers - 1)) if layers > 1 else 0.0))
			_sway_amp.append(size.x * Proc.rangef(seedv, kk + ":swa", 0.008, 0.020))
			_sway_spd.append(Proc.rangef(seedv, kk + ":sws", 0.035, 0.07) * _slow)
			_sway_ph.append(Proc.rangef(seedv, kk + ":swp", 0.0, TAU))
		_build_puffs()
		_build_wisps()

	# Soft drifting shells give the fog READABLE volume (the shader alone reads as
	# a flat veil). Count is LOD/depth gated: the back bands get fewer, LOD2 none.
	func _build_puffs() -> void:
		var lod: int = clampi(_opt_i("lod", 1 if depth > 0.55 else 0), 0, 2)
		var auto_count: int = 0
		match lod:
			0:
				auto_count = 8
			1:
				auto_count = 5
			_:
				auto_count = 0
		var count: int = _opt_i("puffs", -1)
		if count < 0:
			count = auto_count
		count = clampi(count, 0, 10)
		if count == 0 or size.y < 24.0:
			return
		_puff_root = Node2D.new()
		var mm := CanvasItemMaterial.new()
		mm.blend_mode = CanvasItemMaterial.BLEND_MODE_MIX
		_puff_root.material = mm
		add_child(_puff_root)
		_span = size.x * 1.5
		for i in range(count):
			var kk := "pf%d" % i
			var r: float = size.y * Proc.rangef(seedv, kk + ":r", 0.30, 0.62)
			var layer := _PolyLayer.new()
			# Two nested shells: a wide faint outer veil + a tighter brighter core.
			var outer: Dictionary = _PolyLayer.shell(seedv, kk + ":o", r,
				Proc.rangef(seedv, kk + ":sx", 2.0, 3.1), 0.52, 0.30, 0.03)
			var inner: Dictionary = _PolyLayer.shell(seedv, kk + ":i", r * 0.62,
				Proc.rangef(seedv, kk + ":ix", 1.7, 2.5), 0.46, 0.46, 0.06)
			if not outer.is_empty():
				layer.polys.append(outer)
			if not inner.is_empty():
				layer.polys.append(inner)
			if layer.polys.is_empty():
				layer.free()
				continue
			layer.use_parent_material = true
			_puff_root.add_child(layer)
			_puffs.append(layer)
			_puff_x.append(Proc.rangef(seedv, kk + ":x", 0.0, _span))
			_puff_y.append(size.y * Proc.rangef(seedv, kk + ":y", 0.34, 0.80))
			_puff_spd.append(Proc.rangef(seedv, kk + ":spd", 2.2, 7.5) * _slow
				* (1.0 if Proc.hashf(seedv, kk + ":dir") < 0.72 else -1.0))
			_puff_bob.append(size.y * Proc.rangef(seedv, kk + ":bob", 0.01, 0.035))
			_puff_bsp.append(Proc.rangef(seedv, kk + ":bsp", 0.07, 0.18))
			_puff_ph.append(Proc.rangef(seedv, kk + ":ph", 0.0, TAU))
			_puff_a.append(Proc.rangef(seedv, kk + ":a", 0.55, 1.0))

	# Rising fog WISPS: slim tapering ribbons standing on the band's lower edge
	# that lean and breathe. They give the volume a vertical dimension (the puffs
	# only read horizontally) and swell hard in mist/storm weather. Cached polys,
	# animated by transform + modulate only; LOD2 and tiny strips get none.
	func _build_wisps() -> void:
		var lod: int = clampi(_opt_i("lod", 1 if depth > 0.55 else 0), 0, 2)
		var auto_count: int = 0
		match lod:
			0:
				auto_count = 5
			1:
				auto_count = 3
			_:
				auto_count = 0
		var count: int = _opt_i("wisps", -1)
		if count < 0:
			count = auto_count
		count = clampi(count, 0, 8)
		if count == 0 or size.y < 60.0 or size.x < 60.0:
			return
		_wisp_root = Node2D.new()
		var mm := CanvasItemMaterial.new()
		mm.blend_mode = CanvasItemMaterial.BLEND_MODE_MIX
		_wisp_root.material = mm
		add_child(_wisp_root)
		_wisp_y = size.y * clampf(_opt_f("wisp_base", 0.97), 0.3, 1.0)
		if _span <= 1.0:
			_span = size.x * 1.5
		for i in range(count):
			var kk := "wp%d" % i
			var w: float = size.x * Proc.rangef(seedv, kk + ":w", 0.05, 0.13)
			var h: float = size.y * Proc.rangef(seedv, kk + ":h", 0.42, 0.88)
			var shp: Dictionary = _PolyLayer.wisp(seedv, kk, w, h, 0.42, 0.015)
			if shp.is_empty():
				continue
			var layer := _PolyLayer.new()
			layer.polys.append(shp)
			layer.use_parent_material = true
			_wisp_root.add_child(layer)
			_wisps.append(layer)
			_wisp_x.append(Proc.rangef(seedv, kk + ":x", 0.0, _span))
			_wisp_spd.append(Proc.rangef(seedv, kk + ":spd", 1.4, 4.6) * _slow
				* (1.0 if Proc.hashf(seedv, kk + ":dir") < 0.68 else -1.0))
			_wisp_lean.append(Proc.rangef(seedv, kk + ":lean", 0.03, 0.09))
			_wisp_lsp.append(Proc.rangef(seedv, kk + ":lsp", 0.09, 0.24))
			_wisp_ph.append(Proc.rangef(seedv, kk + ":ph", 0.0, TAU))
			_wisp_a.append(Proc.rangef(seedv, kk + ":a", 0.5, 1.0))
			_wisp_sy.append(Proc.rangef(seedv, kk + ":sy", 0.05, 0.13))

	func _on_light(_lc2: Dictionary) -> void:
		var horizon: Color = _lc_color("horizon", Color("dce7f2"))
		var sun: Color = _lc_color("sun_color", Color("fff6e0"))
		var tod: float = _lc_float("tod", 0.5)
		var energy: float = _lc_float("sun_energy", 1.0)
		var weather: String = _lc_str("weather", "clear")
		var dusk: float = ProcAtmosphere.duskiness(tod)
		# The volume warms toward the sun at dawn/dusk and thickens when wet.
		var col: Color = horizon.lerp(sun, 0.22 * dusk)
		var warm: Color = sun.lerp(Color.WHITE, 0.15)
		var wx: float = ProcAtmosphere._weather_fog(weather)
		var sun_warm: float = clampf(_opt_f("warm", 0.5) * (0.35 + 0.65 * dusk) * energy, 0.0, 1.0)
		var sx: float = _sun_x()
		var eff: float = _eff()
		for i in range(_mats.size()):
			var m: ShaderMaterial = _mats[i]
			m.set_shader_parameter(U_COLOR, Color(col.r, col.g, col.b, 1.0))
			m.set_shader_parameter(U_WARM, Color(warm.r, warm.g, warm.b, 1.0))
			m.set_shader_parameter(U_ALPHA, _base_alpha * _layer_fade[i])
			m.set_shader_parameter(U_STRENGTH, eff * wx)
			m.set_shader_parameter(U_SUN_X, sx)
			m.set_shader_parameter(&"u_sun_warm", sun_warm)
		if _puff_root != null:
			# Puffs carry the same tint; they ride a touch brighter than the veil.
			var pc: Color = col.lerp(warm, 0.18 * dusk)
			_puff_root.modulate = Color(pc.r, pc.g, pc.b,
				clampf(_base_alpha * 2.1 * eff * wx, 0.0, 0.62))

	func _tick(_delta: float) -> void:
		for i in range(_mats.size()):
			_mats[i].set_shader_parameter(U_T, t)
			_rects[i].position.x = _base_x[i] \
				+ sin(t * _sway_spd[i] + phase + _sway_ph[i]) * _sway_amp[i]
		if _puff_root == null:
			return
		var feather: float = maxf(1.0, size.x * 0.20)
		for i in range(_puffs.size()):
			var u: float = fposmod(_puff_x[i] + t * _puff_spd[i], _span)
			var layer: _PolyLayer = _puffs[i]
			layer.position.x = u - size.x * 0.25
			layer.position.y = _puff_y[i] + sin(t * _puff_bsp[i] + phase + _puff_ph[i]) * _puff_bob[i]
			# fade in/out across the wrap seam so the loop is invisible
			var edge: float = clampf(minf(u, _span - u) / feather, 0.0, 1.0)
			layer.self_modulate.a = _puff_a[i] * edge


# ===========================================================================
#  GOD RAYS — soft crepuscular shafts from the sun's real screen position
# ===========================================================================
#
# The fan is one Node2D placed at the sun's screen point and rotated along the
# screen-space fall direction; each shaft is a rotated quad running the shared
# ray shader (soft lateral falloff, head/tail feather, spine wobble). Per frame:
# ONE uniform push (u_t) plus ≤10 transform/modulate writes.
class _GodRays extends _AtmoNode:
	const U_T := &"u_t"

	var _fan: Node2D = null
	var _mat: ShaderMaterial = null
	var _arms: Array[Node2D] = []
	var _arm_amp: PackedFloat32Array = PackedFloat32Array()
	var _arm_spd: PackedFloat32Array = PackedFloat32Array()
	var _arm_ph: PackedFloat32Array = PackedFloat32Array()
	var _arm_a: PackedFloat32Array = PackedFloat32Array()
	var _vis: float = 0.0          # eased visibility (≈2 s per spec §3)
	var _gate: float = 0.0         # target from weather + sun height
	var _sun_col: Color = Color("fff6e0")
	var _edge_col: Color = Color("ffd9a8")

	func _build() -> void:
		_fan = Node2D.new()
		add_child(_fan)
		var sh: Shader = ProcAtmosphere.ray_shader()
		_mat = ShaderMaterial.new()
		_mat.shader = sh
		_mat.set_shader_parameter(&"u_taper", clampf(_opt_f("taper", 2.1), 0.6, 6.0))
		_mat.set_shader_parameter(&"u_head", clampf(_opt_f("head", 0.07), 0.01, 0.5))
		_mat.set_shader_parameter(&"u_tail", clampf(_opt_f("tail", 0.46), 0.1, 0.95))
		_mat.set_shader_parameter(&"u_wobble", clampf(_opt_f("wobble", 0.045), 0.0, 0.2))
		var seeded: int = 5 + int(Proc.hashf(seedv, "rayn") * 5.0)
		var count: int = clampi(_opt_i("count", seeded), 3, 9)
		var spread: float = clampf(_opt_f("spread", 0.62), 0.05, 1.6)
		var len_mul: float = maxf(0.1, _opt_f("length", 1.0))
		var wid_mul: float = maxf(0.1, _opt_f("width", 1.0))
		# A wide, short "root" shaft binds the fan together at the apex.
		if _opt_b("root", true):
			_add_arm("root", 0.0, size.y * 0.42 * len_mul, size.x * 0.55 * wid_mul, 0.42,
				0.05, 0.10, 0.0)
		for i in range(count):
			var kk := "ray%d" % i
			var span: float = (float(i) / maxf(1.0, float(count - 1)) - 0.5) * spread
			var ang: float = span + Proc.rangef(seedv, kk + ":aj", -0.045, 0.045)
			var ray_len: float = maxf(48.0,
				size.y * Proc.rangef(seedv, kk + ":len", 0.62, 1.05) * len_mul)
			var ray_w: float = maxf(16.0,
				size.x * Proc.rangef(seedv, kk + ":w", 0.055, 0.15) * wid_mul)
			var a0: float = Proc.rangef(seedv, kk + ":a", 0.55, 1.0)
			_add_arm(kk, ang, ray_len, ray_w, a0,
				Proc.rangef(seedv, kk + ":ba", 0.08, 0.20),
				Proc.rangef(seedv, kk + ":bs", 0.12, 0.30),
				Proc.rangef(seedv, kk + ":bp", 0.0, TAU))
		_fan.visible = false

	# One shaft: a pivot Node2D (rotation + width breathing) holding a quad whose
	# top-centre is the apex, so all shafts share the sun as their origin.
	func _add_arm(_key: String, ang: float, ray_len: float, ray_w: float, a0: float,
			amp: float, spd: float, ph: float) -> void:
		var pivot := Node2D.new()
		pivot.rotation = ang
		var r := ColorRect.new()
		r.material = _mat                    # ONE shared material for the whole fan
		r.size = Vector2(ray_w, ray_len)
		r.position = Vector2(-ray_w * 0.5, 0.0)
		r.mouse_filter = Control.MOUSE_FILTER_IGNORE
		pivot.add_child(r)
		_fan.add_child(pivot)
		_arms.append(pivot)
		_arm_a.append(a0)
		_arm_amp.append(amp)
		_arm_spd.append(spd)
		_arm_ph.append(ph)

	func _on_light(_lc2: Dictionary) -> void:
		if _fan == null:
			return
		var tod: float = _lc_float("tod", 0.5)
		var energy: float = _lc_float("sun_energy", 1.0)
		var weather: String = _lc_str("weather", "clear")
		_sun_col = _lc_color("sun_color", Color("fff6e0"))
		_edge_col = _sun_col.lerp(_lc_color("horizon", Color("dce7f2")), 0.45)
		_mat.set_shader_parameter(&"u_core", Color(_sun_col.r, _sun_col.g, _sun_col.b, 1.0))
		_mat.set_shader_parameter(&"u_edge", Color(_edge_col.r, _edge_col.g, _edge_col.b, 1.0))
		# Apex at the sun's own screen point; shafts stream along the screen-space
		# fall direction, so the fan always agrees with the visible disc.
		var suv: Vector2 = ProcAtmosphere.sun_screen_uv(tod)
		_fan.position = Vector2(size.x * suv.x, size.y * (suv.y - 0.10))
		var fall: Vector2 = ProcAtmosphere.sun_fall_dir(tod)
		_fan.rotation = fall.angle() - PI * 0.5
		# Gate per spec §3: clear weather AND sun_energy above the gate, else fade.
		var gate_e: float = clampf(_opt_f("gate_e", 0.55), 0.0, 1.0)
		_gate = energy if (weather == "clear" and energy > gate_e) else 0.0

	func _tick(delta: float) -> void:
		if _fan == null:
			return
		var target: float = _gate * _eff()
		_vis = move_toward(_vis, target, delta * 0.5)   # ≈2 s full fade either way
		var on: bool = _vis > 0.004
		if _fan.visible != on:
			_fan.visible = on
		if not on:
			return
		_fan.modulate = Color(_sun_col.r, _sun_col.g, _sun_col.b, _vis)
		_mat.set_shader_parameter(U_T, t)
		for i in range(_arms.size()):
			var w: float = sin(t * _arm_spd[i] + phase + _arm_ph[i])
			var arm: Node2D = _arms[i]
			arm.scale.x = 1.0 + _arm_amp[i] * w            # slow width breathing
			arm.self_modulate.a = _arm_a[i] * (0.80 + 0.20 * w)


# ===========================================================================
#  HORIZON GLOW — the dawn/dusk bloom behind the distant islets
# ===========================================================================
#
# Three parts: a shader quad (vertical ramp × sun-centred lateral lobe × faint
# stratified banding), a stacked-ellipse sun swell that tracks the sun's x, and
# a few lit-from-below cloud bars drifting on the horizon line. ProcSky still
# owns the sun DISC — this is only the air around it.
class _HorizonGlow extends _AtmoNode:
	const U_T := &"u_t"

	var _mat: ShaderMaterial = null
	var _swell: _PolyLayer = null
	var _bars_root: Node2D = null
	var _bars: Array[_PolyLayer] = []
	var _bar_x: PackedFloat32Array = PackedFloat32Array()
	var _bar_spd: PackedFloat32Array = PackedFloat32Array()
	var _bar_y: PackedFloat32Array = PackedFloat32Array()
	var _bar_a: PackedFloat32Array = PackedFloat32Array()
	var _span: float = 1.0
	var _glow_a: float = 0.0        # cached alpha; _tick breathes around it

	func _build() -> void:
		var rect: ColorRect = _quad(ProcAtmosphere.glow_shader(), Vector2.ZERO, size)
		_mat = rect.material as ShaderMaterial
		_mat.set_shader_parameter(&"u_spread", clampf(_opt_f("spread", 0.34), 0.05, 1.5))
		_mat.set_shader_parameter(&"u_floor", clampf(_opt_f("floor_lat", 0.18), 0.0, 1.0))
		_mat.set_shader_parameter(&"u_bands", clampf(_opt_f("bands_amt", 0.4), 0.0, 1.0))
		# Sun swell: 5 stacked squashed ellipses — their overlap builds a smooth
		# radial falloff hugging the horizon line without a single gradient texture.
		var add_mat := CanvasItemMaterial.new()
		add_mat.blend_mode = CanvasItemMaterial.BLEND_MODE_ADD
		_swell = _PolyLayer.new()
		_swell.material = add_mat
		var rx0: float = size.x * clampf(_opt_f("bloom", 0.5), 0.05, 1.5)
		for i in range(5):
			var k: float = 1.0 - float(i) * 0.19
			var e: Dictionary = _PolyLayer.ellipse(rx0 * k, rx0 * k * 0.38, 0.055, 0.095, 40)
			if not e.is_empty():
				_swell.polys.append(e)
		_swell.position = Vector2(size.x * 0.5, size.y * 0.98)
		add_child(_swell)
		# Cloud bars: thin ellipses lit from beneath, drifting across the horizon.
		var bars: int = clampi(_opt_i("bars", 4), 0, 6)
		if bars == 0:
			return
		_bars_root = Node2D.new()
		_bars_root.material = add_mat
		add_child(_bars_root)
		_span = size.x * 1.4
		for i in range(bars):
			var kk := "bar%d" % i
			var bw: float = size.x * Proc.rangef(seedv, kk + ":w", 0.16, 0.44)
			var bh: float = maxf(2.5, size.y * Proc.rangef(seedv, kk + ":h", 0.008, 0.022))
			var e2: Dictionary = _PolyLayer.ellipse(bw * 0.5, bh, 0.10, 0.52, 28)
			if e2.is_empty():
				continue
			var layer := _PolyLayer.new()
			layer.polys.append(e2)
			layer.use_parent_material = true
			_bars_root.add_child(layer)
			_bars.append(layer)
			_bar_x.append(Proc.rangef(seedv, kk + ":x", 0.0, _span))
			_bar_spd.append(Proc.rangef(seedv, kk + ":spd", 1.2, 4.0)
				* (1.0 if Proc.hashf(seedv, kk + ":dir") < 0.7 else -1.0))
			_bar_y.append(size.y * Proc.rangef(seedv, kk + ":y", 0.74, 0.97))
			_bar_a.append(Proc.rangef(seedv, kk + ":a", 0.5, 1.0))

	func _on_light(_lc2: Dictionary) -> void:
		if _mat == null:
			return
		var sun: Color = _lc_color("sun_color", Color("fff6e0"))
		var tod: float = _lc_float("tod", 0.5)
		var energy: float = _lc_float("sun_energy", 1.0)
		var weather: String = _lc_str("weather", "clear")
		var dusk: float = ProcAtmosphere.duskiness(tod)
		var wx: float = 1.0
		match weather:
			"overcast", "mist":
				wx = 0.5
			"storm":
				wx = 0.25
		# Strongest at dawn/dusk (spec §3); a faint daytime floor keeps air alive.
		var a: float = (0.35 * dusk + clampf(_opt_f("floor", 0.10), 0.0, 0.5) * energy) \
			* wx * _eff()
		_glow_a = a
		_mat.set_shader_parameter(&"u_color", Color(sun.r, sun.g, sun.b, 1.0))
		_mat.set_shader_parameter(&"u_alpha", a)
		_mat.set_shader_parameter(&"u_strength", 1.0)
		_mat.set_shader_parameter(&"u_sun_x", _sun_x())
		var sx: float = clampf(_sun_x(), -0.1, 1.1)
		if _swell != null:
			_swell.modulate = Color(sun.r, sun.g, sun.b, minf(1.0, a * 1.4))
			_swell.position.x = size.x * sx
		if _bars_root != null:
			# Bars catch the light from below: brightest exactly at dawn/dusk.
			var bc: Color = sun.lerp(Color.WHITE, 0.12)
			_bars_root.modulate = Color(bc.r, bc.g, bc.b,
				clampf((0.30 * dusk + 0.06 * energy) * wx * _eff(), 0.0, 0.7))

	func _tick(_delta: float) -> void:
		if _mat == null:
			return
		_mat.set_shader_parameter(U_T, t)
		if _swell != null:
			var s: float = 1.0 + 0.045 * sin(t * 0.30 + phase)
			_swell.scale = Vector2(s, s)
			_swell.self_modulate.a = 0.92 + 0.08 * sin(t * 0.22 + phase * 0.7)
		if _bars_root == null:
			return
		var feather: float = maxf(1.0, size.x * 0.18)
		for i in range(_bars.size()):
			var u: float = fposmod(_bar_x[i] + t * _bar_spd[i], _span)
			var layer: _PolyLayer = _bars[i]
			layer.position.x = u - size.x * 0.2
			layer.position.y = _bar_y[i]
			var edge: float = clampf(minf(u, _span - u) / feather, 0.0, 1.0)
			layer.self_modulate.a = _bar_a[i] * edge
		# cache-driven breathing of the whole glow (no redraws)
		_mat.set_shader_parameter(&"u_alpha", _glow_a * (0.93 + 0.07 * sin(t * 0.21 + phase)))


# ===========================================================================
#  HEAT SHIMMER — screen-UV wobble strip (ember/desert realms, default OFF)
# ===========================================================================
class _HeatShimmer extends _AtmoNode:
	const U_T := &"u_t"
	const U_STRENGTH := &"u_strength"

	var _mat: ShaderMaterial = null
	var _gate: float = 0.0
	var _cur: float = -1.0

	func _build() -> void:
		var rect: ColorRect = _quad(ProcAtmosphere.shimmer_shader(), Vector2.ZERO, size)
		_mat = rect.material as ShaderMaterial
		_mat.set_shader_parameter(&"u_amp_px", maxf(0.0, _opt_f("amp", 1.5)))
		_mat.set_shader_parameter(&"u_warm_amt", clampf(_opt_f("warm", 0.35), 0.0, 1.0))

	func _on_light(_lc2: Dictionary) -> void:
		if _mat == null:
			return
		var energy: float = _lc_float("sun_energy", 1.0)
		var weather: String = _lc_str("weather", "clear")
		var sun: Color = _lc_color("sun_color", Color("fff6e0"))
		_mat.set_shader_parameter(&"u_warm", Color(sun.r, sun.g, sun.b, 1.0))
		# Shimmer needs a hot, high, unobstructed sun.
		var lo: float = clampf(_opt_f("gate_lo", 0.45), 0.0, 1.0)
		var hi: float = maxf(lo + 0.01, clampf(_opt_f("gate_hi", 0.70), 0.0, 1.0))
		_gate = smoothstep(lo, hi, energy) if weather == "clear" else 0.0

	func _tick(_delta: float) -> void:
		if _mat == null:
			return
		var s: float = _gate * _eff()
		if s > 0.001 or _cur > 0.001:
			_mat.set_shader_parameter(U_T, t + phase)
		if absf(s - _cur) > 0.003:            # push only on meaningful change
			_cur = s
			_mat.set_shader_parameter(U_STRENGTH, s)
