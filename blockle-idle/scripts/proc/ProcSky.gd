class_name ProcSky extends RefCounted
# ProcSky — a living, painterly sky backdrop generated entirely from math.
#
# No imported images: the whole firmament is synthesised on the GPU from seeded
# colour harmonies (Proc.palette) + domain-warped FBM. One full-screen atmosphere
# layer paints the sky gradient, soft cloudbank haze, a sun or moon with a warm
# bloom, a dusk horizon glow, a twinkling star field and (optionally) an aurora.
# Over it drift several parallax cloud layers (child ColorRects) at different
# scales and speeds so the sky reads as deep and breathing.
#
# It extends ProcNode so it obeys the four hard rules:
#   * SEEDED    — every colour, cloud style and star is a pure function of the seed.
#   * GROWING   — `growth` is the sky "ripening": at 0 it is a tender, washed-out
#                 dawn haze with few clouds and faint stars; as it creeps to 1 the
#                 gradient deepens, cloudbanks thicken, the star field fills in and
#                 the sun/moon bloom swells. Every shader reads u_growth so ANY
#                 value renders a believable stage.
#   * ALIVE     — a very slow day<->dusk<->night cycle advances continuously; clouds
#                 drift forever; stars twinkle; the aurora sways; weather eases in
#                 and out. All of it is cheap shader-uniform animation — no redraws.
#
# Usage (a world builder):
#   var sky := ProcSky.make(world_seed, "sky", Vector2(1080, 1920))
#   add_child(sky)                       # mount behind the world, z_index low
#   sky.set_time_of_day(0.30)            # 0=midnight .25=dawn .5=noon .75=dusk
#   sky.set_weather("overcast")          # clear / overcast / storm / mist
#   sky.set_parallax(camera_offset)      # call while panning for depth
# or, matched to a realm's own sky colours from data/realms.json:
#   var sky := ProcSky.make_for_realm(world_seed, "crystal_hollow", Vector2(1080,1920))

# ============================================================================
#  FACTORY FUNCTIONS
# ============================================================================

# The main factory. `opts` (all optional) may contain:
#   sky:Array<String>  three "#rrggbb" day colours [top,mid,bottom] (overrides palette)
#   accent:String      "#rrggbb" aurora / glow accent
#   weather:String     "clear" | "overcast" | "storm" | "mist"
#   aurora:bool        force an aurora on/off (else seed-chosen)
#   cloud_style:String "cumulus" | "cirrus" | "stratus" | "scattered" (else seed-chosen)
#   time_of_day:float  initial time in [0,1)
#   auto_advance:bool  whether the day cycle advances (default true)
#   day_minutes:float  real minutes for one full day<->night cycle (default 28)
#   start_growth:float initial growth in [0,1] (default 1.0)
#   grow_minutes:float minutes to ripen from seed to full sky (default 50)
static func make(world_seed: int, key: String = "sky", size: Vector2 = Vector2(1080, 1920), opts: Dictionary = {}) -> ProcNode:
	var n := _Sky.new()
	n.seedv = hash("%d:%s" % [world_seed, key])
	n.res = size
	n.tod = float(opts.get("time_of_day", 0.32))
	n.auto_advance = bool(opts.get("auto_advance", true))
	n.day_seconds = max(30.0, float(opts.get("day_minutes", 28.0)) * 60.0)
	n.weather = String(opts.get("weather", "clear"))

	# Cloud style + aurora — seed-chosen unless overridden.
	var styles := ["cumulus", "cirrus", "stratus", "scattered"]
	n.cloud_style = String(opts.get("cloud_style", styles[int(Proc.hashf(n.seedv, "cstyle") * styles.size()) % styles.size()]))
	if opts.has("aurora"):
		n.aurora = bool(opts["aurora"])
	else:
		n.aurora = Proc.hashf(n.seedv, "aurora") < 0.28

	n.cols = _derive_colors(n.seedv, key, opts.get("sky", []), opts.get("accent", ""))
	n.star_amt = Proc.rangef(n.seedv, "stars", 0.35, 1.0)

	n.set_grow_minutes(float(opts.get("grow_minutes", 50.0)))
	n.growth = clampf(float(opts.get("start_growth", 1.0)), 0.0, 1.0)
	n._init_weather_targets()
	return n

# Build a sky matched to one of the game's realms (reads its sky + accent from
# GameData, and turns the aurora on for the cold / magical / cavern realms).
static func make_for_realm(world_seed: int, realm_id: String, size: Vector2 = Vector2(1080, 1920), opts: Dictionary = {}) -> ProcNode:
	var o := opts.duplicate()
	var realm: Dictionary = GameData.realms_by_id.get(realm_id, {})
	if realm.has("sky"):
		o["sky"] = realm["sky"]
	if realm.has("accent"):
		o["accent"] = realm["accent"]
	if not o.has("aurora"):
		o["aurora"] = realm_id in ["crystal_hollow", "forgotten_wilds", "astral", "frostfall"]
	if not o.has("cloud_style"):
		match realm_id:
			"skylands": o["cloud_style"] = "cumulus"
			"frostfall": o["cloud_style"] = "stratus"
			"astral", "crystal_hollow": o["cloud_style"] = "cirrus"
			"forgotten_wilds": o["cloud_style"] = "scattered"
	return make(world_seed, "sky:" + realm_id, size, o)

# A quick fixed-mood night sky (handy for menus / intros).
static func make_night(world_seed: int, size: Vector2 = Vector2(1080, 1920), opts: Dictionary = {}) -> ProcNode:
	var o := opts.duplicate()
	o["time_of_day"] = 0.0
	o["auto_advance"] = o.get("auto_advance", false)
	return make(world_seed, "sky:night", size, o)

# ============================================================================
#  COLOUR DERIVATION  (seed-cohesive day / dusk / night / cloud / sun palettes)
# ============================================================================

static func _derive_colors(seedv: int, key: String, realm_sky: Array, accent_hex: String) -> Dictionary:
	var pal: Dictionary = Proc.palette(seedv, key)
	var hue: float = pal["hue"]

	# ---- day gradient (realm sky overrides the palette if present) -----------
	var day_top: Color = pal["sky_top"]
	var day_bot: Color = pal["sky_bot"]
	var day_mid: Color = day_top.lerp(day_bot, 0.5)
	if realm_sky.size() >= 3:
		day_top = Color.html(String(realm_sky[0]))
		day_mid = Color.html(String(realm_sky[1]))
		day_bot = Color.html(String(realm_sky[2]))
	elif realm_sky.size() == 2:
		day_top = Color.html(String(realm_sky[0]))
		day_bot = Color.html(String(realm_sky[1]))
		day_mid = day_top.lerp(day_bot, 0.5)

	# ---- dusk (warm horizon, cool-violet crown) ------------------------------
	var warm_h := Proc.rangef(seedv, "duskwarm", 0.015, 0.075)      # orange..amber
	var dusk_bot := Color.from_hsv(warm_h, 0.78, 1.0)
	var dusk_top := Color.from_hsv(fposmod(hue + 0.52, 1.0), 0.52, 0.46)
	var dusk_glow := Color.from_hsv(fposmod(warm_h + 0.02, 1.0), 0.88, 1.0)

	# ---- night (deep cool firmament) -----------------------------------------
	var night_h := fposmod(hue + Proc.rangef(seedv, "nighthue", 0.46, 0.56), 1.0)
	var night_top := Color.from_hsv(night_h, 0.62, 0.075)
	var night_bot := Color.from_hsv(fposmod(night_h + 0.03, 1.0), 0.5, 0.20)

	# ---- celestial bodies -----------------------------------------------------
	var sun_col := Color.from_hsv(Proc.rangef(seedv, "sunhue", 0.08, 0.13), 0.22, 1.0)
	var moon_col := Color.from_hsv(fposmod(night_h + 0.02, 1.0), 0.10, 0.98)

	# ---- clouds (neutral, gently tinted by the sky; day + night sets) --------
	var cl_light := Color(1, 1, 1).lerp(day_bot, 0.16)
	var cl_dark := Color(0.60, 0.65, 0.74).lerp(day_top, 0.32)
	var cn_light := Color(0.70, 0.76, 0.90).lerp(night_bot, 0.30)
	var cn_dark := Color(0.12, 0.15, 0.26).lerp(night_top, 0.55)

	# ---- aurora + haze --------------------------------------------------------
	var aurora_col: Color = pal["accent"]
	if accent_hex != "":
		aurora_col = Color.html(accent_hex)
	var haze_col := day_bot.lightened(0.18)

	return {
		"day_top": day_top, "day_mid": day_mid, "day_bot": day_bot,
		"dusk_top": dusk_top, "dusk_bot": dusk_bot, "dusk_glow": dusk_glow,
		"night_top": night_top, "night_bot": night_bot,
		"sun_col": sun_col, "moon_col": moon_col,
		"cl_light": cl_light, "cl_dark": cl_dark,
		"cn_light": cn_light, "cn_dark": cn_dark,
		"aurora_col": aurora_col, "haze_col": haze_col,
	}

# ============================================================================
#  SHARED GLSL  (hash -> value noise -> fbm -> iq domain warp)
# ============================================================================

const NOISE_GLSL := """
float hash21(vec2 p){
	p = fract(p * vec2(123.34, 345.45));
	p += dot(p, p + 34.345);
	return fract(p.x * p.y);
}
float vnoise(vec2 p){
	vec2 i = floor(p);
	vec2 f = fract(p);
	vec2 u = f * f * (3.0 - 2.0 * f);
	float a = hash21(i);
	float b = hash21(i + vec2(1.0, 0.0));
	float c = hash21(i + vec2(0.0, 1.0));
	float d = hash21(i + vec2(1.0, 1.0));
	return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p){
	float s = 0.0;
	float a = 0.5;
	mat2 m = mat2(vec2(1.6, 1.2), vec2(-1.2, 1.6));
	for (int i = 0; i < 6; i++){
		s += a * vnoise(p);
		p = m * p;
		a *= 0.5;
	}
	return s;
}
// Inigo-Quilez style domain warp -> billowing, painterly cloudbanks.
float warp(vec2 p){
	vec2 q = vec2(fbm(p), fbm(p + vec2(5.2, 1.3)));
	vec2 r = vec2(fbm(p + 3.0 * q + vec2(1.7, 9.2)), fbm(p + 3.0 * q + vec2(8.3, 2.8)));
	return fbm(p + 3.0 * r);
}
"""

const ATMO_UNIFORMS := """
uniform float u_time;
uniform vec2  u_res;
uniform float u_growth;
uniform float u_daylight;
uniform float u_dusk;
uniform float u_overcast;
uniform float u_mist;
uniform vec2  u_par;
uniform vec2  u_sun_pos;
uniform vec2  u_moon_pos;
uniform float u_star_amt;
uniform float u_aurora;
uniform float u_seed;
uniform vec4  u_sun_col : source_color;
uniform vec4  u_moon_col : source_color;
uniform vec4  u_day_top : source_color;
uniform vec4  u_day_mid : source_color;
uniform vec4  u_day_bot : source_color;
uniform vec4  u_dusk_top : source_color;
uniform vec4  u_dusk_bot : source_color;
uniform vec4  u_dusk_glow : source_color;
uniform vec4  u_night_top : source_color;
uniform vec4  u_night_bot : source_color;
uniform vec4  u_haze_col : source_color;
uniform vec4  u_aurora_col : source_color;
"""

const ATMO_FRAGMENT := """
void fragment(){
	vec2 uv = UV;
	float asp = u_res.x / max(1.0, u_res.y);
	vec2 P = vec2(uv.x * asp, uv.y);
	float night = 1.0 - u_daylight;
	float horizon = smoothstep(0.35, 1.0, uv.y);
	float sky_up = smoothstep(1.0, 0.22, uv.y);

	// ---- base phase gradients ------------------------------------------------
	vec3 day = mix(mix(u_day_top.rgb, u_day_mid.rgb, smoothstep(0.0, 0.55, uv.y)),
				   u_day_bot.rgb, smoothstep(0.5, 1.0, uv.y));
	vec3 ngt = mix(u_night_top.rgb, u_night_bot.rgb, smoothstep(0.0, 1.0, uv.y));
	vec3 dsk = mix(u_dusk_top.rgb, u_dusk_bot.rgb, smoothstep(0.0, 1.0, uv.y));

	vec3 col = mix(ngt, day, u_daylight);
	col = mix(col, dsk, u_dusk * 0.80);

	// ---- high painterly haze (domain-warped, slow drift) --------------------
	vec2 hp = P * 1.55 + vec2(u_time * 0.011 + u_par.x * 0.04, u_time * 0.004);
	float h = warp(hp);
	float hmask = smoothstep(0.44, 0.96, h) * (0.35 + 0.65 * u_growth) * (1.0 - u_daylight * 0.22);
	vec3 hazecol = mix(u_haze_col.rgb, u_sun_col.rgb, u_dusk * 0.5);
	col = mix(col, col * 1.04 + hazecol * 0.5, hmask * 0.45);

	// ---- dusk horizon glow ---------------------------------------------------
	col += u_dusk_glow.rgb * u_dusk * horizon * 0.55;

	// ---- sun: warm disc + layered bloom -------------------------------------
	vec2 S = vec2(u_sun_pos.x * asp, u_sun_pos.y);
	float ds = distance(P, S);
	float sbloom = exp(-ds * 6.0) + 0.42 * exp(-ds * 2.2) + 0.15 * exp(-ds * 0.9);
	col += u_sun_col.rgb * sbloom * u_daylight * (0.55 + 0.45 * u_growth);
	float sdisc = smoothstep(0.046, 0.030, ds);
	col = mix(col, u_sun_col.rgb * 1.25, sdisc * u_daylight);

	// ---- moon: pale disc + soft craters + bloom -----------------------------
	vec2 M = vec2(u_moon_pos.x * asp, u_moon_pos.y);
	float dm = distance(P, M);
	float mbloom = exp(-dm * 7.5) + 0.30 * exp(-dm * 2.6);
	col += u_moon_col.rgb * mbloom * night * (0.40 + 0.50 * u_growth);
	float mdisc = smoothstep(0.042, 0.028, dm);
	float crater = warp((P - M) * 34.0) * 0.16;
	col = mix(col, u_moon_col.rgb * (1.08 - crater), mdisc * night);

	// ---- star field (grid hash + twinkle), densest high, fades to horizon ---
	vec2 g = P * 42.0;
	vec2 gi = floor(g);
	vec2 gf = fract(g) - 0.5;
	float rnd = hash21(gi + vec2(u_seed));
	float present = step(0.90 - u_star_amt * 0.12 - u_growth * 0.03, rnd);
	vec2 soff = (vec2(hash21(gi + 1.3), hash21(gi + 2.7)) - 0.5) * 0.6;
	float sdst = length(gf - soff);
	float star = present * smoothstep(0.085, 0.0, sdst);
	float tw = 0.45 + 0.55 * sin(u_time * (0.8 + rnd * 3.5) + rnd * 40.0);
	col += vec3(0.90, 0.95, 1.0) * star * tw * night * sky_up * (0.55 + 0.60 * u_growth);
	// a sparse second layer of tiny distant stars
	vec2 g2 = P * 96.0;
	float rnd2 = hash21(floor(g2) + vec2(u_seed + 7.0));
	float faint = step(0.965, rnd2) * smoothstep(0.06, 0.0, length(fract(g2) - 0.5));
	col += vec3(0.8, 0.85, 1.0) * faint * night * sky_up * 0.4;

	// ---- aurora (optional): swaying curtain, colour from the accent ---------
	if (u_aurora > 0.5){
		float curt = warp(vec2(uv.x * 3.0 + u_time * 0.05, u_time * 0.03)) * 0.14;
		float center = 0.30 + curt;
		float width = 0.12;
		float au = exp(-pow((uv.y - center) / width, 2.0));
		au *= 0.5 + 0.5 * sin(uv.x * 24.0 + u_time * 0.5);
		au *= 0.5 + 0.5 * warp(vec2(uv.x * 8.0, u_time * 0.1));
		col += u_aurora_col.rgb * au * night * u_growth * 0.70 * sky_up;
	}

	// ---- weather: overcast desaturated veil, mist lift near ground ----------
	float lum = dot(col, vec3(0.299, 0.587, 0.114));
	vec3 overc = mix(col, vec3(lum) * vec3(0.80, 0.82, 0.86), 0.70);
	col = mix(col, overc, u_overcast * 0.70);
	col *= (1.0 - u_overcast * 0.12);
	col = mix(col, col * 0.82 + vec3(0.55, 0.57, 0.60) * 0.30, u_mist * horizon * 0.6);

	// ---- growth ripens the whole sky's saturation ---------------------------
	float gq = mix(0.72, 1.0, u_growth);
	float l2 = dot(col, vec3(0.299, 0.587, 0.114));
	col = mix(vec3(l2), col, gq);

	COLOR = vec4(col, 1.0);
}
"""

const CLOUD_UNIFORMS := """
uniform float u_time;
uniform vec2  u_res;
uniform float u_growth;
uniform float u_daylight;
uniform float u_overcast;
uniform float u_mist;
uniform vec2  u_par;
uniform vec2  u_scale;
uniform float u_speed;
uniform float u_opacity;
uniform vec2  u_band;
uniform float u_cover;
uniform float u_par_factor;
uniform vec2  u_light_pos;
uniform vec4  u_light_col : source_color;
uniform vec4  u_cl_light : source_color;
uniform vec4  u_cl_dark : source_color;
uniform vec4  u_cn_light : source_color;
uniform vec4  u_cn_dark : source_color;
"""

const CLOUD_FRAGMENT := """
void fragment(){
	vec2 uv = UV;
	float asp = u_res.x / max(1.0, u_res.y);
	vec2 P = vec2(uv.x * asp, uv.y);

	// sample point: scaled, drifting, parallax-shifted
	vec2 p = P * u_scale;
	p.x += u_time * u_speed + u_par.x * u_par_factor;
	p.y += u_par.y * u_par_factor * 0.30;
	float n = warp(p);

	// coverage grows with overcast, thins slightly as the sky ripens (airier)
	float cover = u_cover + u_overcast * 0.18 - u_growth * 0.05;
	float m = smoothstep(cover, cover + 0.28, n);
	m = pow(m, 1.3);

	// keep each layer inside a soft vertical band
	float band = smoothstep(u_band.x, u_band.x + 0.12, uv.y) * smoothstep(u_band.y, u_band.y - 0.12, uv.y);
	float a = m * band * u_opacity * (0.25 + 0.75 * u_growth);
	a = clamp(a + u_overcast * band * 0.30, 0.0, 1.0);

	// colour: dark base -> light crest, blended day<->night
	vec3 light = mix(u_cn_light.rgb, u_cl_light.rgb, u_daylight);
	vec3 dark = mix(u_cn_dark.rgb, u_cl_dark.rgb, u_daylight);
	vec3 c = mix(dark, light, smoothstep(cover, cover + 0.5, n));

	// lit from the sun/moon: brighten toward the light source + a top rim
	vec2 L = vec2(u_light_pos.x * asp, u_light_pos.y);
	float prox = exp(-distance(P, L) * 2.2);
	c += u_light_col.rgb * prox * 0.50 * m;
	float rim = smoothstep(cover + 0.05, cover + 0.30, n) - smoothstep(cover + 0.30, cover + 0.60, n);
	c += u_light_col.rgb * rim * 0.25 * (0.4 + 0.6 * u_daylight);

	// overcast flattens cloud colour to a dim grey sheet
	float lum = dot(c, vec3(0.299, 0.587, 0.114));
	c = mix(c, vec3(lum) * vec3(0.85, 0.86, 0.90), u_overcast * 0.60);

	COLOR = vec4(c, a);
}
"""

# ============================================================================
#  THE LIVING SKY NODE
# ============================================================================

class _Sky extends ProcNode:
	var res: Vector2 = Vector2(1080, 1920)
	var tod: float = 0.32                 # time of day in [0,1): 0 midnight .5 noon
	var auto_advance: bool = true
	var day_seconds: float = 1680.0       # one full cycle (28 min default)
	var weather: String = "clear"
	var aurora: bool = false
	var cloud_style: String = "cumulus"
	var star_amt: float = 0.7
	var cols: Dictionary = {}

	var _atmo: ColorRect
	var _atmo_mat: ShaderMaterial
	var _clouds: Array = []               # [{rect, mat, par_factor}]
	var _par: Vector2 = Vector2.ZERO
	var _overcast: float = 0.0
	var _overcast_t: float = 0.0
	var _mist: float = 0.0
	var _mist_t: float = 0.0

	# cached dynamic state so cloud layers reuse the atmosphere's computation
	var _sun_pos: Vector2 = Vector2(0.5, 0.3)
	var _moon_pos: Vector2 = Vector2(0.5, 1.2)
	var _daylight: float = 1.0
	var _dusk: float = 0.0

	func _init_weather_targets() -> void:
		var wt := _weather_values(weather)
		_overcast = wt.x
		_overcast_t = wt.x
		_mist = wt.y
		_mist_t = wt.y

	func _weather_values(w: String) -> Vector2:
		match w:
			"overcast": return Vector2(0.85, 0.08)
			"storm": return Vector2(1.0, 0.22)
			"mist": return Vector2(0.30, 0.80)
			_: return Vector2(0.0, 0.0)   # clear

	# ---- build the layer stack once -----------------------------------------
	func _on_built() -> void:
		_atmo = _make_rect(0)
		_atmo_mat = _make_mat(ProcSky.ATMO_UNIFORMS, ProcSky.ATMO_FRAGMENT)
		_atmo.material = _atmo_mat
		add_child(_atmo)

		for i in range(ProcSky._cloud_layers(cloud_style).size()):
			var layer: Dictionary = ProcSky._cloud_layers(cloud_style)[i]
			var rect := _make_rect(1 + i)
			var mat := _make_mat(ProcSky.CLOUD_UNIFORMS, ProcSky.CLOUD_FRAGMENT)
			rect.material = mat
			add_child(rect)
			mat.set_shader_parameter("u_scale", layer["scale"])
			mat.set_shader_parameter("u_speed", layer["speed"])
			mat.set_shader_parameter("u_opacity", layer["opacity"])
			mat.set_shader_parameter("u_band", layer["band"])
			mat.set_shader_parameter("u_cover", layer["cover"])
			mat.set_shader_parameter("u_par_factor", layer["par"])
			_clouds.append({"rect": rect, "mat": mat, "par": layer["par"]})

		_push_static()
		_push_dynamic(0.0)

	func _make_rect(z: int) -> ColorRect:
		var r := ColorRect.new()
		r.position = Vector2.ZERO
		r.size = res
		r.color = Color(0, 0, 0, 0)
		r.z_index = z
		r.mouse_filter = Control.MOUSE_FILTER_IGNORE
		return r

	func _make_mat(uniforms: String, frag: String) -> ShaderMaterial:
		var sh := Shader.new()
		sh.code = "shader_type canvas_item;\n" + uniforms + ProcSky.NOISE_GLSL + frag
		var m := ShaderMaterial.new()
		m.shader = sh
		return m

	# ---- static (seed-fixed) uniforms: colours, resolution, flags -----------
	func _push_static() -> void:
		var mats := [_atmo_mat]
		for c in _clouds:
			mats.append(c["mat"])
		for m in mats:
			m.set_shader_parameter("u_res", res)
			m.set_shader_parameter("u_seed", float(abs(seedv) % 997) * 0.173)

		_atmo_mat.set_shader_parameter("u_star_amt", star_amt)
		_atmo_mat.set_shader_parameter("u_aurora", 1.0 if aurora else 0.0)
		_atmo_mat.set_shader_parameter("u_sun_col", cols["sun_col"])
		_atmo_mat.set_shader_parameter("u_moon_col", cols["moon_col"])
		_atmo_mat.set_shader_parameter("u_day_top", cols["day_top"])
		_atmo_mat.set_shader_parameter("u_day_mid", cols["day_mid"])
		_atmo_mat.set_shader_parameter("u_day_bot", cols["day_bot"])
		_atmo_mat.set_shader_parameter("u_dusk_top", cols["dusk_top"])
		_atmo_mat.set_shader_parameter("u_dusk_bot", cols["dusk_bot"])
		_atmo_mat.set_shader_parameter("u_dusk_glow", cols["dusk_glow"])
		_atmo_mat.set_shader_parameter("u_night_top", cols["night_top"])
		_atmo_mat.set_shader_parameter("u_night_bot", cols["night_bot"])
		_atmo_mat.set_shader_parameter("u_haze_col", cols["haze_col"])
		_atmo_mat.set_shader_parameter("u_aurora_col", cols["aurora_col"])

		for c in _clouds:
			var m: ShaderMaterial = c["mat"]
			m.set_shader_parameter("u_cl_light", cols["cl_light"])
			m.set_shader_parameter("u_cl_dark", cols["cl_dark"])
			m.set_shader_parameter("u_cn_light", cols["cn_light"])
			m.set_shader_parameter("u_cn_dark", cols["cn_dark"])

	# ---- per-frame animation: day cycle, weather ease, parallax, time -------
	func _animate(delta: float) -> void:
		if auto_advance and day_seconds > 0.0:
			tod = fposmod(tod + delta / day_seconds, 1.0)
		# ease weather toward its target so a change is a soft roll-in, not a snap
		var k := 1.0 - exp(-delta * 0.6)
		_overcast = lerp(_overcast, _overcast_t, k)
		_mist = lerp(_mist, _mist_t, k)
		_push_dynamic(delta)

	func _push_dynamic(_delta: float) -> void:
		if _atmo_mat == null:
			return
		# celestial geometry: a continuous arc for sun (and its antipode moon).
		var arg := (tod - 0.25) * TAU
		var sun_alt := sin(arg)
		_sun_pos = Vector2(0.5 - 0.42 * cos(arg), 0.86 - 0.66 * clampf(sun_alt, -0.25, 1.0))
		var marg := arg + PI
		var moon_alt := sin(marg)
		_moon_pos = Vector2(0.5 - 0.42 * cos(marg), 0.86 - 0.66 * clampf(moon_alt, -0.25, 1.0))
		_daylight = smoothstep(-0.05, 0.22, sun_alt)
		_dusk = exp(-pow(sun_alt / 0.20, 2.0))         # warm band at each horizon crossing

		_atmo_mat.set_shader_parameter("u_time", t)
		_atmo_mat.set_shader_parameter("u_growth", g())
		_atmo_mat.set_shader_parameter("u_daylight", _daylight)
		_atmo_mat.set_shader_parameter("u_dusk", _dusk)
		_atmo_mat.set_shader_parameter("u_overcast", _overcast)
		_atmo_mat.set_shader_parameter("u_mist", _mist)
		_atmo_mat.set_shader_parameter("u_par", _par)
		_atmo_mat.set_shader_parameter("u_sun_pos", _sun_pos)
		_atmo_mat.set_shader_parameter("u_moon_pos", _moon_pos)

		# clouds are lit by whichever body is up (smoothly blended at dawn/dusk)
		var light_pos := _moon_pos.lerp(_sun_pos, _daylight)
		var light_col: Color = Color(cols["moon_col"]).lerp(cols["sun_col"], _daylight)
		light_col.a = 1.0
		for c in _clouds:
			var m: ShaderMaterial = c["mat"]
			m.set_shader_parameter("u_time", t)
			m.set_shader_parameter("u_growth", g())
			m.set_shader_parameter("u_daylight", _daylight)
			m.set_shader_parameter("u_overcast", _overcast)
			m.set_shader_parameter("u_mist", _mist)
			m.set_shader_parameter("u_par", _par)
			m.set_shader_parameter("u_light_pos", light_pos)
			m.set_shader_parameter("u_light_col", light_col)

	# growth changes are slow; nothing to redraw (all GPU) — just refresh uniforms
	func _on_growth() -> void:
		_push_dynamic(0.0)

	# ---- public controls -----------------------------------------------------

	# Set the time of day directly. 0 = midnight, .25 = dawn, .5 = noon, .75 = dusk.
	func set_time_of_day(v: float) -> void:
		tod = fposmod(v, 1.0)
		_push_dynamic(0.0)

	func get_time_of_day() -> float:
		return tod

	# Turn the automatic slow day<->night cycle on/off, optionally retiming it.
	func set_auto_advance(on: bool, minutes: float = -1.0) -> void:
		auto_advance = on
		if minutes > 0.0:
			day_seconds = minutes * 60.0

	# Weather eases in smoothly: "clear" | "overcast" | "storm" | "mist".
	func set_weather(w: String) -> void:
		weather = w
		var v := _weather_values(w)
		_overcast_t = v.x
		_mist_t = v.y

	# Push a camera / world offset so cloud layers (and the haze) parallax with depth.
	func set_parallax(offset: Vector2) -> void:
		# normalise against screen size so factors read in ~[-1,1]
		_par = Vector2(offset.x / max(1.0, res.x), offset.y / max(1.0, res.y))
		_push_dynamic(0.0)

	# Toggle / colour the aurora at runtime.
	func set_aurora(on: bool) -> void:
		aurora = on
		if _atmo_mat:
			_atmo_mat.set_shader_parameter("u_aurora", 1.0 if on else 0.0)

	# Resize the whole backdrop (e.g. on a resolution / safe-area change).
	func set_size(new_size: Vector2) -> void:
		res = new_size
		if _atmo:
			_atmo.size = res
		for c in _clouds:
			c["rect"].size = res
		_push_static()
		_push_dynamic(0.0)

# ============================================================================
#  CLOUD-STYLE PRESETS  (each a 3-layer parallax stack)
# ============================================================================

static func _cloud_layers(style: String) -> Array:
	match style:
		"cirrus":   # thin, stretched, high, fast wisps
			return [
				{"scale": Vector2(1.2, 5.0), "speed": 0.020, "opacity": 0.40, "band": Vector2(0.08, 0.55), "cover": 0.60, "par": 0.80},
				{"scale": Vector2(1.6, 6.5), "speed": 0.030, "opacity": 0.32, "band": Vector2(0.04, 0.45), "cover": 0.62, "par": 1.00},
				{"scale": Vector2(2.0, 4.0), "speed": 0.015, "opacity": 0.30, "band": Vector2(0.18, 0.60), "cover": 0.58, "par": 0.65},
			]
		"stratus":  # broad, soft, low-contrast sheets
			return [
				{"scale": Vector2(1.2, 1.8), "speed": 0.004, "opacity": 0.85, "band": Vector2(0.40, 1.00), "cover": 0.42, "par": 0.30},
				{"scale": Vector2(1.8, 2.4), "speed": 0.007, "opacity": 0.58, "band": Vector2(0.28, 0.85), "cover": 0.46, "par": 0.50},
				{"scale": Vector2(2.6, 3.2), "speed": 0.012, "opacity": 0.40, "band": Vector2(0.14, 0.60), "cover": 0.50, "par": 0.70},
			]
		"scattered":  # a few discrete puffs across clear sky
			return [
				{"scale": Vector2(2.2, 3.0), "speed": 0.009, "opacity": 0.80, "band": Vector2(0.34, 0.90), "cover": 0.66, "par": 0.50},
				{"scale": Vector2(3.0, 4.0), "speed": 0.014, "opacity": 0.60, "band": Vector2(0.20, 0.70), "cover": 0.68, "par": 0.75},
				{"scale": Vector2(4.5, 5.5), "speed": 0.022, "opacity": 0.45, "band": Vector2(0.05, 0.50), "cover": 0.70, "par": 1.00},
			]
		_:  # "cumulus" — classic billowing storybook clouds
			return [
				{"scale": Vector2(1.6, 2.6), "speed": 0.006, "opacity": 0.90, "band": Vector2(0.45, 0.98), "cover": 0.52, "par": 0.35},
				{"scale": Vector2(2.4, 3.4), "speed": 0.011, "opacity": 0.75, "band": Vector2(0.25, 0.78), "cover": 0.55, "par": 0.60},
				{"scale": Vector2(3.8, 5.0), "speed": 0.020, "opacity": 0.50, "band": Vector2(0.05, 0.52), "cover": 0.60, "par": 0.90},
			]
