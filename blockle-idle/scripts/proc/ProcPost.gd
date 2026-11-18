class_name ProcPost extends RefCounted
# ProcPost — the POST STACK of the 2.5D upgrade (GFX-2.5D §4, §7.4).
#
# One full-screen CanvasLayer (layer 50) that WorldSpace.setup() adds LAST, so it
# grades everything beneath it: time-of-day color grade (teal-dawn / warm-noon /
# amber-dusk / blue-night lift+gain ramps), a gentle vignette, a soft bloom
# approximation (additive bright-source overlay — NO viewport feedback loops),
# optional weather desaturation, optional film grain (default OFF), and a
# reusable reward "screen-kiss" flash.
#
# It is the ONLY screen-texture read in the game: a single ColorRect with one
# cheap canvas_item shader (lift/gain grade + luma desaturate + radial vignette
# + optional grain). Bloom is NOT in the shader — it is ≤ 24 small additive
# quads cached once and moved by transform at 4 Hz. When every strength is zero
# (or set_intensity(0)) the layer degrades to fully transparent: the grade rect
# and bloom overlay are HIDDEN, so the mobile GPU pays nothing at all.
#
# Usage (WorldSpace.setup(), added last):
#   var post := ProcPost.make(world_seed, Vector2(1080, 1920))
#   add_child(post)
#   post.set_world_ref(_band_front)       # cam-local → screen mapping for bloom
#   post.set_time_of_day(0.32)            # or let it follow ProcLighting
#   post.set_weather("overcast")          # clear / overcast / mist / storm
#   post.flash(Color(1.0, 0.9, 0.6, 0.5), 0.5)   # reward kiss
#
# Lighting integration: _Post polls `ProcLighting.version()` every 0.25 s and
# follows the LightCtx (tod / weather / sun_energy) plus `ProcLighting.sources()`
# for bloom. ProcLighting.ctx() always returns a complete deterministic LightCtx
# even with no driver installed, so a standalone _Post still grades correctly.
# Manual overrides are STICKY — set_time_of_day / set_weather win over the
# driver until released (set_time_of_day(-1.0) / set_weather("")).
#
# Everything here is wall-clock gameplay animation (grade easing, grain time,
# flash tweens) — no generation randomness. The only seeded value is a tiny
# per-world warmth mood bias, drawn through Proc.rangef.

const LAYER_INDEX := 50
const MAX_BLOOM := 24                 # mirrors the ProcLighting source cap
const LIGHT_POLL_SEC := 0.25          # lighting version poll cadence (spec §2.4)
const BLOOM_POLL_SEC := 0.25          # bloom overlay refresh = 4 Hz (spec §4)
const SETTLE_RATE := 3.2              # exp ease-rate for grade transitions

# The factory. `opts` (all optional):
#   grain:bool         start with film grain on (default false)
#   intensity:float    master intensity 0..1 (default 1.0; 0 = transparent/off)
#   grade:float        grade strength multiplier 0..1 (default 1.0)
#   vignette:float     vignette strength multiplier 0..1 (default 1.0)
#   bloom:float        bloom overlay strength multiplier 0..1 (default 1.0)
#   time_of_day:float  manual tod in [0,1) (default: follow ProcLighting)
#   weather:String     manual weather id (default: follow ProcLighting)
#   weather_grade:bool let weather desaturate / dim the grade (default true)
#   layer:int          CanvasLayer layer (default 50)
static func make(world_seed: int, vp: Vector2, opts: Dictionary = {}) -> CanvasLayer:
	var n := _Post.new()
	n.seed_v = world_seed
	n.vp = vp
	n.layer = int(opts.get("layer", LAYER_INDEX))
	n.grain_on = bool(opts.get("grain", false))
	n.intensity = clampf(float(opts.get("intensity", 1.0)), 0.0, 1.0)
	n.grade_s = clampf(float(opts.get("grade", 1.0)), 0.0, 1.0)
	n.vig_s = clampf(float(opts.get("vignette", 1.0)), 0.0, 1.0)
	n.bloom_s = clampf(float(opts.get("bloom", 1.0)), 0.0, 1.0)
	n.weather_grade = bool(opts.get("weather_grade", true))
	if opts.has("time_of_day"):
		n.manual_tod = clampf(float(opts.get("time_of_day", 0.5)), 0.0, 0.999)
	if opts.has("weather"):
		n.manual_weather = String(opts.get("weather", "clear"))
	# Seeded mood: a whisper of per-world warmth so each seed keeps its own cast.
	n.mood_warmth = Proc.rangef(world_seed, "post:mood", -0.015, 0.022)
	return n


# ============================================================================
#  _Post — the CanvasLayer
# ============================================================================
class _Post extends CanvasLayer:
	var seed_v: int = 1
	var vp: Vector2 = Vector2(1080, 1920)
	var mood_warmth: float = 0.0

	# ---- public knobs -------------------------------------------------------
	var grain_on: bool = false
	var intensity: float = 1.0            # master 0..1; 0 degrades to transparent
	var grade_s: float = 1.0
	var vig_s: float = 1.0
	var bloom_s: float = 1.0
	var manual_tod: float = -1.0          # >= 0 → sticky manual time of day
	var manual_weather: String = ""       # non-empty → sticky manual weather
	var weather_grade: bool = true        # weather desaturation / dimming on|off

	# ---- internals ----------------------------------------------------------
	var _rect: ColorRect                  # the single screen-texture grade pass
	var _mat: ShaderMaterial
	var _bloom_root: Node2D               # additive bright-source overlay
	var _dots: Array[_BloomDot] = []      # pooled, cached-quad bloom sprites
	var _flash_rect: ColorRect
	var _flash_tw: Tween
	var _world_ref: Node2D = null         # cam-local → screen mapping for bloom
	var _vis_rect := Rect2()              # cached off-screen cull rect for bloom

	var _t: float = 0.0                   # gameplay clock for grain (allowed)
	var _poll_acc: float = 0.0
	var _bloom_acc: float = 0.0
	var _light_version: int = -2147483648

	# Grade state: _cur eases toward _tgt (exp smoothing) so tod steps and
	# weather rolls read silky. While settled, _process pushes NOTHING.
	var _cur_lift := Vector3.ZERO
	var _cur_gain := Vector3.ONE
	var _cur_warmth: float = 0.0
	var _cur_vig: float = 0.0
	var _cur_sat: float = 1.0
	var _tgt_lift := Vector3.ZERO
	var _tgt_gain := Vector3.ONE
	var _tgt_warmth: float = 0.0
	var _tgt_vig: float = 0.0
	var _tgt_sat: float = 1.0
	var _settling: bool = true
	var _tod: float = 0.5                 # resolved time of day actually in use
	var _weather: String = "clear"        # resolved weather actually in use
	var _sun_energy: float = 1.0          # damps bloom at noon per spec §4

	# Time-of-day grade keyframes: {tod, lift, gain, warmth, vig, sat}.
	# blue-night → teal-dawn → warm-noon → amber-dusk → blue-hour → night.
	const _STOPS: Array[Dictionary] = [
		{"tod": 0.00, "lift": Vector3(0.050, 0.068, 0.150), "gain": Vector3(0.80, 0.85, 1.00),
			"warmth": -0.14, "vig": 0.30, "sat": 0.86},
		{"tod": 0.19, "lift": Vector3(0.048, 0.078, 0.128), "gain": Vector3(0.88, 0.92, 1.00),
			"warmth": -0.08, "vig": 0.26, "sat": 0.90},
		{"tod": 0.27, "lift": Vector3(0.020, 0.085, 0.088), "gain": Vector3(1.06, 1.00, 0.96),
			"warmth": 0.04, "vig": 0.20, "sat": 1.00},
		{"tod": 0.50, "lift": Vector3(0.012, 0.010, 0.004), "gain": Vector3(1.035, 1.012, 0.985),
			"warmth": 0.055, "vig": 0.15, "sat": 1.04},
		{"tod": 0.73, "lift": Vector3(0.065, 0.032, 0.015), "gain": Vector3(1.09, 0.99, 0.90),
			"warmth": 0.16, "vig": 0.21, "sat": 1.05},
		{"tod": 0.85, "lift": Vector3(0.050, 0.060, 0.128), "gain": Vector3(0.90, 0.92, 1.02),
			"warmth": -0.06, "vig": 0.26, "sat": 0.92},
	]

	const _SHADER_CODE := """
shader_type canvas_item;
uniform sampler2D screen_tex : hint_screen_texture, filter_linear;
uniform vec3 u_lift = vec3(0.0);     // shadow tint (time-of-day graded)
uniform vec3 u_gain = vec3(1.0);     // highlight tint
uniform float u_warmth = 0.0;        // -0.2..0.2 channel push
uniform float u_vig = 0.0;           // 0..0.35 vignette strength
uniform float u_sat = 1.0;           // weather desaturation (1 = full color)
uniform float u_grain = 0.0;         // 0 default (branch skipped)
uniform float u_t = 0.0;
void fragment() {
	vec3 c = texture(screen_tex, SCREEN_UV).rgb;
	c = c * u_gain + u_lift * (1.0 - c);                    // cheap lift/gain grade
	c.r += u_warmth * 0.06; c.b -= u_warmth * 0.05;
	float l = dot(c, vec3(0.299, 0.587, 0.114));            // weather desaturation
	c = mix(vec3(l), c, u_sat);
	float d = distance(SCREEN_UV, vec2(0.5, 0.46));
	c *= 1.0 - u_vig * smoothstep(0.42, 0.85, d);           // gentle vignette
	if (u_grain > 0.001) {
		float n = fract(sin(dot(SCREEN_UV * 1021.0, vec2(12.9898, 78.233)) + u_t) * 43758.5);
		c += (n - 0.5) * u_grain * 0.035;
	}
	COLOR = vec4(c, 1.0);
}
"""

	# ---- build --------------------------------------------------------------
	func _ready() -> void:
		layer = layer if layer != 0 else ProcPost.LAYER_INDEX
		# Grain time starts at a seeded offset so two worlds never sparkle alike.
		_t = Proc.hashf(seed_v, "post:t0") * 64.0
		if vp.x < 2.0 or vp.y < 2.0:
			vp = get_viewport().get_visible_rect().size
		_vis_rect = Rect2(Vector2.ZERO, vp).grow(220.0)

		var sh := Shader.new()
		sh.code = _SHADER_CODE
		_mat = ShaderMaterial.new()
		_mat.shader = sh

		_rect = ColorRect.new()
		_rect.name = "Grade"
		_rect.material = _mat
		_rect.mouse_filter = Control.MOUSE_FILTER_IGNORE
		_rect.set_anchors_preset(Control.PRESET_FULL_RECT)
		add_child(_rect)

		_bloom_root = Node2D.new()
		_bloom_root.name = "Bloom"
		add_child(_bloom_root)

		_flash_rect = ColorRect.new()
		_flash_rect.name = "Flash"
		_flash_rect.mouse_filter = Control.MOUSE_FILTER_IGNORE
		_flash_rect.set_anchors_preset(Control.PRESET_FULL_RECT)
		_flash_rect.color = Color(1, 1, 1, 0)
		_flash_rect.visible = false
		add_child(_flash_rect)

		_mat.set_shader_parameter("u_grain", 0.55 if grain_on else 0.0)
		_light_version = ProcLighting.version()
		_resolve_inputs()
		_retarget()
		# First frame lands on the target instantly — no fade-in from neutral.
		_snap_to_target()
		_apply_uniforms()
		_refresh_bloom()

	# ---- public API (spec §4 + manual drive) --------------------------------

	func set_grain(on: bool) -> void:
		grain_on = on
		if _mat != null:
			_mat.set_shader_parameter("u_grain", 0.55 if on else 0.0)
		_update_visibility()

	func set_strengths(grade: float, vignette: float, bloom: float) -> void:
		grade_s = clampf(grade, 0.0, 1.0)
		vig_s = clampf(vignette, 0.0, 1.0)
		bloom_s = clampf(bloom, 0.0, 1.0)
		_settling = true
		_apply_uniforms()
		_refresh_bloom()

	# A reusable screen-kiss for rewards: an instant soft wash of `color` that
	# decays out over `dur`. Alpha of `color` scales the peak (capped gently).
	func flash(color: Color, dur: float) -> void:
		if _flash_rect == null:
			return
		var peak: float = clampf(color.a * 0.55, 0.0, 0.85) * clampf(intensity, 0.0, 1.0)
		if peak <= 0.001 or dur <= 0.0:
			return
		if _flash_tw != null and _flash_tw.is_valid():
			_flash_tw.kill()
		_flash_rect.color = Color(color.r, color.g, color.b, peak)
		_flash_rect.visible = true
		_flash_tw = create_tween().set_trans(Tween.TRANS_EXPO).set_ease(Tween.EASE_OUT)
		_flash_tw.tween_property(_flash_rect, "color:a", 0.0, maxf(0.05, dur))
		_flash_tw.tween_callback(_hide_flash)

	# Manual time of day in [0,1) — STICKY over the lighting driver.
	# Pass a negative value to release back to ProcLighting control.
	func set_time_of_day(tod: float) -> void:
		manual_tod = clampf(tod, 0.0, 0.999) if tod >= 0.0 else -1.0
		_light_version = -2147483648      # force a re-resolve on the next poll
		_resolve_inputs()
		_retarget()

	# Manual weather ("clear"/"overcast"/"mist"/"storm") — STICKY; "" releases.
	func set_weather(weather: String) -> void:
		manual_weather = weather
		_light_version = -2147483648
		_resolve_inputs()
		_retarget()

	# Turn the weather desaturation / dimming response on or off.
	func set_weather_grade(on: bool) -> void:
		weather_grade = on
		_retarget()

	# Master intensity 0..1. At 0 the whole stack hides (degrades to transparent:
	# no screen-texture read, no bloom quads — the GPU pays nothing).
	func set_intensity(s: float) -> void:
		intensity = clampf(s, 0.0, 1.0)
		_settling = true
		_apply_uniforms()
		_refresh_bloom()

	# Re-fit the stack after a viewport / orientation change (additive helper).
	func set_viewport_size(size: Vector2) -> void:
		vp = Vector2(maxf(1.0, size.x), maxf(1.0, size.y))
		_vis_rect = Rect2(Vector2.ZERO, vp).grow(220.0)
		_refresh_bloom()

	# Cam-local → screen mapping for the bloom overlay: pass the band container
	# that ProcLighting source positions live in (WorldSpace wires this once).
	func set_world_ref(node: Node2D) -> void:
		_world_ref = node
		_refresh_bloom()

	# ---- per-frame ----------------------------------------------------------
	func _process(delta: float) -> void:
		_t += delta
		if grain_on and _rect != null and _rect.visible:
			_mat.set_shader_parameter("u_t", _t)

		# Ease the grade toward its target; pushes uniforms ONLY while settling.
		if _settling:
			var k: float = 1.0 - exp(-delta * SETTLE_RATE)
			_cur_lift = _cur_lift.lerp(_tgt_lift, k)
			_cur_gain = _cur_gain.lerp(_tgt_gain, k)
			_cur_warmth = lerpf(_cur_warmth, _tgt_warmth, k)
			_cur_vig = lerpf(_cur_vig, _tgt_vig, k)
			_cur_sat = lerpf(_cur_sat, _tgt_sat, k)
			var dist: float = (_cur_lift - _tgt_lift).length() + (_cur_gain - _tgt_gain).length() \
				+ absf(_cur_warmth - _tgt_warmth) + absf(_cur_vig - _tgt_vig) + absf(_cur_sat - _tgt_sat)
			if dist < 0.0015:
				_cur_lift = _tgt_lift
				_cur_gain = _tgt_gain
				_cur_warmth = _tgt_warmth
				_cur_vig = _tgt_vig
				_cur_sat = _tgt_sat
				_settling = false
			_apply_uniforms()

		# Poll the lighting driver (0.25 s cadence, version-gated — spec §2.4).
		_poll_acc += delta
		if _poll_acc >= ProcPost.LIGHT_POLL_SEC:
			_poll_acc = 0.0
			var v: int = ProcLighting.version()
			if v != _light_version:
				_light_version = v
				_resolve_inputs()
				_retarget()

		# Bloom overlay at 4 Hz: transform + modulate moves on cached quads only.
		_bloom_acc += delta
		if _bloom_acc >= ProcPost.BLOOM_POLL_SEC:
			_bloom_acc = 0.0
			_refresh_bloom()

	# ---- lighting input -----------------------------------------------------

	# Resolve the tod / weather / sun_energy actually in use this moment:
	# the LightCtx, with sticky manual overrides layered on top. ProcLighting.ctx()
	# is always complete (noon-clear default when no driver is installed), so this
	# never branches on "is lighting ready" — spec §2.1.
	func _resolve_inputs() -> void:
		var lc: Dictionary = ProcLighting.ctx()
		var tod: float = clampf(float(lc.get("tod", _tod)), 0.0, 0.999)
		var weather: String = String(lc.get("weather", _weather))
		var energy: float = clampf(float(lc.get("sun_energy", 1.0)), 0.0, 1.0)
		var derived: bool = false
		if manual_tod >= 0.0:
			tod = manual_tod
			# A manual tod must also drive bloom day-damping, so re-derive energy
			# from it the same way §2.2 does instead of trusting the driver's.
			var el: float = sin(tod * TAU - PI * 0.5) * 0.5 + 0.5
			energy = smoothstep(0.08, 0.35, el)
			derived = true
		if manual_weather != "":
			weather = manual_weather
		_tod = tod
		_weather = weather if weather != "" else "clear"
		if derived:
			# Only damp what WE derived — the driver's own sun_energy is already
			# weather-damped, and double-damping would kill the night pools.
			if _weather == "overcast":
				energy *= 0.55
			elif _weather == "storm":
				energy *= 0.35
		_sun_energy = clampf(energy, 0.0, 1.0)

	# ---- grade math (runs only when tod/weather/strengths change) -----------

	# Cyclic interpolation through the keyframe table at `tod`.
	func _grade_at(tod: float) -> Dictionary:
		var n: int = _STOPS.size()
		var e: float = fposmod(tod, 1.0)
		var i0: int = n - 1
		for i in range(n):
			var st: float = float(_STOPS[i].get("tod", 0.0))
			if st <= e:
				i0 = i
		var a: Dictionary = _STOPS[i0]
		var b: Dictionary = _STOPS[(i0 + 1) % n]
		var t0: float = float(a.get("tod", 0.0))
		var t1: float = float(b.get("tod", 0.0))
		if i0 == n - 1:
			t1 += 1.0                      # wrap blue-hour → midnight
			if e < t0:
				e += 1.0
		var u: float = 0.0
		if t1 - t0 > 0.0001:
			u = clampf((e - t0) / (t1 - t0), 0.0, 1.0)
		u = u * u * (3.0 - 2.0 * u)       # smoothstep between stops
		var lift_a: Vector3 = a.get("lift", Vector3.ZERO)
		var lift_b: Vector3 = b.get("lift", Vector3.ZERO)
		var gain_a: Vector3 = a.get("gain", Vector3.ONE)
		var gain_b: Vector3 = b.get("gain", Vector3.ONE)
		return {
			"lift": lift_a.lerp(lift_b, u),
			"gain": gain_a.lerp(gain_b, u),
			"warmth": lerpf(float(a.get("warmth", 0.0)), float(b.get("warmth", 0.0)), u),
			"vig": lerpf(float(a.get("vig", 0.0)), float(b.get("vig", 0.0)), u),
			"sat": lerpf(float(a.get("sat", 1.0)), float(b.get("sat", 1.0)), u),
		}

	# Recompute the target grade from (_tod, _weather) and start easing to it.
	func _retarget() -> void:
		var gr: Dictionary = _grade_at(_tod)
		var lift: Vector3 = gr.get("lift", Vector3.ZERO)
		var gain: Vector3 = gr.get("gain", Vector3.ONE)
		var warmth: float = float(gr.get("warmth", 0.0)) + mood_warmth
		var vig: float = float(gr.get("vig", 0.0))
		var sat: float = float(gr.get("sat", 1.0))
		# Weather: optional desaturation + dimming veils (spec §4 storm rule).
		match (_weather if weather_grade else "clear"):
			"overcast":
				sat *= 0.86
				gain *= 0.96
				lift += Vector3(0.010, 0.010, 0.012)
				vig += 0.02
			"mist":
				sat *= 0.90
				gain *= 0.99
				lift += Vector3(0.020, 0.022, 0.025)
				warmth -= 0.02
			"storm":
				sat *= 0.74
				gain *= 0.90
				lift += Vector3(0.012, 0.014, 0.020)
				vig += 0.07
				warmth -= 0.05
			_:
				pass
		_tgt_lift = lift
		_tgt_gain = gain
		_tgt_warmth = warmth
		_tgt_vig = clampf(vig, 0.0, 0.35)
		_tgt_sat = clampf(sat, 0.0, 1.2)
		_settling = true

	func _snap_to_target() -> void:
		_cur_lift = _tgt_lift
		_cur_gain = _tgt_gain
		_cur_warmth = _tgt_warmth
		_cur_vig = _tgt_vig
		_cur_sat = _tgt_sat
		_settling = false

	# Push the effective (strength- and intensity-scaled) uniforms.
	func _apply_uniforms() -> void:
		if _mat == null:
			return
		var gs: float = grade_s * intensity
		var lift: Vector3 = _cur_lift * gs
		var gain: Vector3 = Vector3.ONE.lerp(_cur_gain, gs)
		var warmth: float = _cur_warmth * gs
		var sat: float = lerpf(1.0, _cur_sat, gs)
		var vig: float = _cur_vig * vig_s * intensity
		_mat.set_shader_parameter("u_lift", lift)
		_mat.set_shader_parameter("u_gain", gain)
		_mat.set_shader_parameter("u_warmth", warmth)
		_mat.set_shader_parameter("u_sat", sat)
		_mat.set_shader_parameter("u_vig", vig)
		_update_visibility()

	# Degrade-to-transparent: hide the screen-texture pass when it would be a
	# no-op so a disabled post stack costs the GPU literally nothing.
	func _update_visibility() -> void:
		if _rect == null:
			return
		var gs: float = grade_s * intensity
		var neutral: bool = gs <= 0.001 and _cur_vig * vig_s * intensity <= 0.001 \
			and not grain_on
		if intensity <= 0.001:
			neutral = true
		_rect.visible = not neutral
		if _bloom_root != null:
			_bloom_root.visible = bloom_s * intensity > 0.001

	# ---- bloom overlay (spec §4: cached additive quads, 4 Hz, ≤ 24) ---------
	func _refresh_bloom() -> void:
		if _bloom_root == null:
			return
		if bloom_s * intensity <= 0.001:
			for d in _dots:
				d.visible = false
			return
		var srcs: Array = ProcLighting.sources()
		var xf := Transform2D.IDENTITY
		if _world_ref != null and _world_ref.is_inside_tree():
			xf = _world_ref.get_global_transform_with_canvas()
		var count: int = mini(srcs.size(), ProcPost.MAX_BLOOM)
		# Grow the pool once; afterwards updates are transform/modulate only.
		while _dots.size() < count:
			var dot := _BloomDot.new()
			_bloom_root.add_child(dot)
			_dots.append(dot)
		var day_damp: float = 1.0 - _sun_energy * 0.6
		for i in range(_dots.size()):
			var dot: _BloomDot = _dots[i]
			if i >= count:
				dot.visible = false
				continue
			var sv: Variant = srcs[i]
			if not (sv is Dictionary):
				dot.visible = false
				continue
			var src: Dictionary = sv
			var pos: Vector2 = src.get("pos", Vector2.ZERO)
			var radius: float = maxf(1.0, float(src.get("radius", 40.0)))
			var strength: float = clampf(float(src.get("strength", 1.0)), 0.0, 2.0)
			var col: Color = src.get("color", Color(1.0, 0.9, 0.7))
			var screen_pos: Vector2 = xf * pos
			var alpha: float = 0.10 * strength * day_damp * bloom_s * intensity
			if alpha <= 0.004 or not _vis_rect.has_point(screen_pos):
				dot.visible = false
				continue
			dot.visible = true
			dot.position = screen_pos
			dot.scale = Vector2.ONE * (radius * 1.6 / _BloomDot.UNIT_R)
			dot.modulate = Color(col.r, col.g, col.b, alpha)

	func _hide_flash() -> void:
		if _flash_rect != null:
			_flash_rect.visible = false


# ============================================================================
#  _BloomDot — one soft additive glow quad, drawn ONCE at unit size, then only
#  ever moved/scaled/tinted. Concentric falloff discs fake a radial gradient.
# ============================================================================
class _BloomDot extends Node2D:
	const UNIT_R := 64.0

	func _ready() -> void:
		var m := CanvasItemMaterial.new()
		m.blend_mode = CanvasItemMaterial.BLEND_MODE_ADD
		material = m
		queue_redraw()

	func _draw() -> void:
		# Soft radial falloff from 4 stacked discs; modulate carries color+alpha.
		draw_circle(Vector2.ZERO, UNIT_R, Color(1, 1, 1, 0.16))
		draw_circle(Vector2.ZERO, UNIT_R * 0.66, Color(1, 1, 1, 0.22))
		draw_circle(Vector2.ZERO, UNIT_R * 0.38, Color(1, 1, 1, 0.30))
		draw_circle(Vector2.ZERO, UNIT_R * 0.16, Color(1, 1, 1, 0.42))
