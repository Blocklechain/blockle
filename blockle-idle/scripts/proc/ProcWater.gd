class_name ProcWater
extends RefCounted
# ProcWater — procedural, living WATER features for Blockle Idle.
#
# Everything here is synthesised from (world_seed, key): ponds, wells, streams,
# and waterfalls that spill off the island edge into cloud — plus a generic
# animated-water surface you can lay over ANY polygon (puzzle lakes, Bloomtide
# terraces). No imported images, no textures: the shimmer, caustics, sky
# reflection and foam are all one cheap inline canvas shader driven by TIME, so a
# hundred ripples cost almost nothing on the CPU.
#
# Growth (ProcNode.growth in [0,1]) is first-class and continuous:
#   • a pond is a damp puddle that slowly fills to a full mirror of water,
#     sprouting reeds then lily pads as it matures;
#   • a well rises stone-by-stone from the ground, fills, then gains its posts,
#     roof, rope and bucket;
#   • a stream widens from a dry channel to a thin trickle to a full flowing
#     ribbon;
#   • a waterfall thickens from a thread to a full roaring sheet dissolving into
#     mist and cloud at its foot.
# Draw code renders a believable stage for ANY growth value, eased through g().
#
# Animation is almost entirely free: the water surface is a static mesh whose
# ripples/caustics/reflection/foam animate in the GPU shader via TIME + a
# per-instance phase; only the small decor (lily pads bob, reeds sway, mist
# rises) moves, and each does so with cheap per-frame TRANSFORM changes in its
# own _process — never a per-frame redraw of the water itself.
#
# Factory functions (a world/puzzle builder calls these):
#   make(world_seed, key, kind:="pond", opts:={})            -> ProcNode   (dispatcher)
#   make_pond(world_seed, key, radius:=120.0, opts:={})      -> ProcNode
#   make_well(world_seed, key, scale:=1.0, opts:={})         -> ProcNode
#   make_stream(world_seed, key, path, width:=46.0, opts:={})-> ProcNode
#   make_waterfall(world_seed, key, width:=90.0, drop:=520.0, opts:={}) -> ProcNode
#   make_surface(world_seed, key, polygon, opts:={})         -> ProcNode
#
# opts may carry: {sky_top:Color|hex, realm:String, context:Dictionary,
#   lily:bool, reeds:bool, stones:bool, lobes:int, drop:float, growth:float}.
# Every node exposes footprint_radius:float and accepts context (local_palette,
# light_dir, elevation) per the build contract.

# =====================================================================
#  SHARED INLINE WATER SHADER (canvas_item)
# =====================================================================
# interior = COLOR.r : 1 at the deep centre / spine, 0 at the water's edge.
# UV       : normalised across the surface (y small = far/reflective edge).
const SHADER_CODE := """
shader_type canvas_item;
render_mode blend_mix;

uniform vec4  u_shallow : source_color = vec4(0.45, 0.80, 0.82, 1.0);
uniform vec4  u_deep    : source_color = vec4(0.09, 0.33, 0.52, 1.0);
uniform vec4  u_sky     : source_color = vec4(0.80, 0.92, 0.98, 1.0);
uniform vec4  u_foam    : source_color = vec4(1.0, 1.0, 1.0, 1.0);
uniform vec4  u_caustic : source_color = vec4(0.85, 1.0, 0.98, 1.0);
uniform float u_phase   = 0.0;
uniform float u_speed   = 1.0;
uniform float u_ripple  = 1.0;
uniform float u_caust   = 1.0;
uniform float u_scale   = 1.0;
uniform float u_edge    = 0.14;
uniform float u_fill    = 1.0;
uniform float u_glint   = 1.0;
uniform vec2  u_flow    = vec2(0.0, 0.0);
uniform int   u_mode    = 0;    // 0 pond/lake, 1 stream, 2 waterfall

float hash12(vec2 p) {
	vec3 p3 = fract(vec3(p.xyx) * 0.1031);
	p3 += dot(p3, p3.yzx + 33.33);
	return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
	vec2 i = floor(p);
	vec2 f = fract(p);
	vec2 u = f * f * (3.0 - 2.0 * f);
	float a = hash12(i);
	float b = hash12(i + vec2(1.0, 0.0));
	float c = hash12(i + vec2(0.0, 1.0));
	float d = hash12(i + vec2(1.0, 1.0));
	return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
	float s = 0.0;
	float a = 0.5;
	for (int i = 0; i < 4; i++) {
		s += a * vnoise(p);
		p = p * 2.02 + vec2(7.3, 3.1);
		a *= 0.5;
	}
	return s;
}

void fragment() {
	float t = (TIME + u_phase) * u_speed;
	vec2 uv = UV;
	float interior = COLOR.r;              // 1 deep -> 0 edge
	vec2 flow = u_flow * t;

	// domain-warped ripple field
	vec2 q = uv * (6.0 * u_scale) + flow;
	float w1 = fbm(q + vec2(t * 0.17, -t * 0.11));
	float w2 = fbm(q * 1.9 + vec2(-t * 0.13, t * 0.19) + 11.0);
	vec2 warp = (vec2(w1, w2) - 0.5) * (0.6 * u_ripple);

	// caustic interference network (bright thin veins)
	vec2 cp = uv * (9.0 * u_scale) + warp * 3.0 + flow * 1.5;
	float caus = 0.0;
	float amp = 1.0;
	for (int i = 0; i < 3; i++) {
		float fi = float(i);
		float v = sin(cp.x * 1.3 + t * 1.1 + fi * 2.1) + cos(cp.y * 1.15 - t * 0.9 + fi * 1.3);
		caus += (1.0 - abs(v) * 0.5) * amp;
		cp = cp * 1.7 + vec2(2.3, -1.7);
		amp *= 0.55;
	}
	caus = clamp(pow(max(caus - 0.9, 0.0), 2.0) * 0.6 * u_caust, 0.0, 1.5);

	// depth gradient + mirrored-sky reflection toward the far edge
	float depth = smoothstep(0.0, 0.75, interior);
	vec3 water = mix(u_shallow.rgb, u_deep.rgb, depth);
	float sky_f = clamp(1.0 - uv.y + warp.y * 0.3, 0.0, 1.0);
	sky_f = pow(sky_f, 1.6) * 0.5;
	water = mix(water, u_sky.rgb, sky_f * (0.4 + 0.6 * depth));

	// travelling specular glint band
	float band = sin(uv.x * 3.0 + uv.y * 2.0 - t * 0.8 + warp.x * 2.0);
	float glint = smoothstep(0.86, 1.0, band) * u_glint * (0.5 + 0.5 * depth);

	// per-mode character
	if (u_mode == 2) {
		float streak = fbm(vec2(uv.x * 22.0 * u_scale, uv.y * 3.0 - t * 4.0));
		caus += smoothstep(0.55, 0.9, streak) * 0.8;
		water = mix(water, u_foam.rgb, smoothstep(0.6, 1.0, streak) * 0.5);
	} else if (u_mode == 1) {
		float rif = fbm(uv * vec2(10.0, 5.0) * u_scale + flow * 2.0);
		caus += smoothstep(0.62, 0.9, rif) * 0.5;
	} else {
		vec2 d = uv - vec2(0.5);
		float rings = sin(length(d) * 34.0 * u_scale - t * 2.2);
		caus += smoothstep(0.7, 1.0, rings) * 0.25 * u_ripple;
	}

	vec3 col = water + caus * u_caustic.rgb * 0.9 + vec3(glint);

	// foam lacing at the water's edge
	float foam = 1.0 - smoothstep(0.0, u_edge, interior);
	float foam_tex = fbm(uv * 14.0 * u_scale + flow + vec2(t * 0.4, -t * 0.3));
	foam *= smoothstep(0.25, 0.8, foam_tex + 0.35);
	col = mix(col, u_foam.rgb, clamp(foam, 0.0, 1.0));

	// translucent water with a soft antialiased lip; foam stays opaque
	float a;
	if (u_mode == 2) {
		a = mix(0.0, 0.92, smoothstep(0.0, 0.12, interior));
	} else {
		a = mix(0.0, 0.95, smoothstep(0.0, 0.06, interior));
	}
	a = max(a, foam * 0.95);
	a *= u_fill;
	COLOR = vec4(col, a);
}
"""

static var _shader: Shader
static var _white_tex: Texture2D

static func _get_shader() -> Shader:
	if _shader == null:
		_shader = Shader.new()
		_shader.code = SHADER_CODE
	return _shader

static func _white() -> Texture2D:
	if _white_tex == null:
		var img := Image.create(2, 2, false, Image.FORMAT_RGBA8)
		img.fill(Color.WHITE)
		_white_tex = ImageTexture.create_from_image(img)
	return _white_tex


# =====================================================================
#  PUBLIC FACTORIES
# =====================================================================

static func make(world_seed: int, key: String, kind: String = "pond", opts: Dictionary = {}) -> ProcNode:
	match kind:
		"well":
			return make_well(world_seed, key, float(opts.get("scale", 1.0)), opts)
		"stream", "creek", "brook":
			var path: PackedVector2Array = opts.get("path", _default_stream_path())
			return make_stream(world_seed, key, path, float(opts.get("width", 46.0)), opts)
		"waterfall", "falls", "cascade":
			return make_waterfall(world_seed, key, float(opts.get("width", 90.0)), float(opts.get("drop", 520.0)), opts)
		"surface", "lake", "water":
			var poly: PackedVector2Array = opts.get("polygon", _default_lake_poly(world_seed, key))
			return make_surface(world_seed, key, poly, opts)
		_:
			return make_pond(world_seed, key, float(opts.get("radius", 120.0)), opts)


static func make_pond(world_seed: int, key: String, radius: float = 120.0, opts: Dictionary = {}) -> ProcNode:
	var n := _Pond.new()
	_init_common(n, world_seed, key, opts)
	n.radius = maxf(24.0, radius)
	n.lobes = int(opts.get("lobes", 9))
	n.want_lily = bool(opts.get("lily", true))
	n.want_reeds = bool(opts.get("reeds", true))
	n.lily_count = int(opts.get("lily_count", 3))
	n.set_grow_minutes(float(opts.get("grow_minutes", 25.0)))
	n.footprint_radius = radius
	return n


static func make_well(world_seed: int, key: String, scale: float = 1.0, opts: Dictionary = {}) -> ProcNode:
	var n := _Well.new()
	_init_common(n, world_seed, key, opts)
	n.wscale = clampf(scale, 0.4, 3.0)
	n.set_grow_minutes(float(opts.get("grow_minutes", 180.0)))
	n.footprint_radius = 46.0 * n.wscale
	return n


static func make_stream(world_seed: int, key: String, path: PackedVector2Array, width: float = 46.0, opts: Dictionary = {}) -> ProcNode:
	var n := _Stream.new()
	_init_common(n, world_seed, key, opts)
	n.path = _densify_open(path, 5) if path.size() >= 2 else _default_stream_path()
	n.width = maxf(10.0, width)
	n.want_stones = bool(opts.get("stones", true))
	n.mode = 1
	n.set_grow_minutes(float(opts.get("grow_minutes", 30.0)))
	n.footprint_radius = width
	return n


static func make_waterfall(world_seed: int, key: String, width: float = 90.0, drop: float = 520.0, opts: Dictionary = {}) -> ProcNode:
	var n := _Waterfall.new()
	_init_common(n, world_seed, key, opts)
	n.width = maxf(24.0, width)
	n.drop = maxf(120.0, drop)
	n.mode = 2
	n.set_grow_minutes(float(opts.get("grow_minutes", 60.0)))
	n.footprint_radius = width * 0.8
	return n


static func make_surface(world_seed: int, key: String, polygon: PackedVector2Array, opts: Dictionary = {}) -> ProcNode:
	var n := _Surface.new()
	_init_common(n, world_seed, key, opts)
	n.poly = polygon if polygon.size() >= 3 else _default_lake_poly(world_seed, key)
	n.set_grow_minutes(float(opts.get("grow_minutes", 20.0)))
	# footprint ~ polygon extent
	var ext := 0.0
	var c := _centroid(n.poly)
	for p in n.poly:
		ext = maxf(ext, p.distance_to(c))
	n.footprint_radius = ext
	return n


# =====================================================================
#  SHARED SET-UP HELPERS
# =====================================================================

static func _init_common(n: _Water, world_seed: int, key: String, opts: Dictionary) -> void:
	n.seedv = hash("%d:%s" % [world_seed, key])
	n.wseed = world_seed
	n.wkey = key
	n.cols = _water_cols(world_seed, key, opts)
	n.context = opts.get("context", {})
	if opts.has("growth"):
		n.growth = clampf(float(opts["growth"]), 0.0, 1.0)

static func _water_cols(world_seed: int, key: String, opts: Dictionary) -> Dictionary:
	# Bluish-teal water, hue nudged by seed and tinted toward the local realm.
	var h := Proc.rangef(world_seed, "wh:" + key, 0.48, 0.60)
	var shallow := Color.from_hsv(fposmod(h - 0.02, 1.0), 0.42, 0.93, 0.9)
	var deep := Color.from_hsv(fposmod(h + 0.02, 1.0), 0.70, 0.52, 1.0)
	var caustic := Color.from_hsv(fposmod(h - 0.06, 1.0), 0.22, 1.0, 1.0)
	var foam := Color(0.96, 0.99, 1.0, 1.0)
	var sky := Color(0.82, 0.92, 0.98, 1.0)

	# sky-reflection colour: explicit override, else the realm's top sky band
	if opts.has("sky_top"):
		sky = _as_color(opts["sky_top"], sky)
	elif opts.has("realm"):
		var rs = _realm_sky(String(opts["realm"]))
		if rs != null:
			sky = rs

	# local palette drift (context) — keep water recognisably water (25% blend)
	var ctx: Dictionary = opts.get("context", {})
	if ctx.has("local_palette") and typeof(ctx["local_palette"]) == TYPE_DICTIONARY:
		var lp: Dictionary = ctx["local_palette"]
		if lp.has("base") and lp["base"] is Color:
			var b: Color = lp["base"]
			shallow = shallow.lerp(Color(b.r, b.g, b.b, shallow.a), 0.2)
			deep = deep.lerp(Color(b.r, b.g, b.b, deep.a), 0.18)
		if lp.has("sky_top") and lp["sky_top"] is Color:
			sky = sky.lerp(lp["sky_top"], 0.35)

	return {"shallow": shallow, "deep": deep, "sky": sky, "foam": foam, "caustic": caustic}

static func _realm_sky(realm_id: String):
	# Pull the first sky band from GameData.realms if the autoload is present.
	if not Engine.has_singleton("GameData") and typeof(GameData) != TYPE_OBJECT:
		return null
	var gd = GameData
	if gd == null or not (gd.realms_by_id is Dictionary):
		return null
	if not gd.realms_by_id.has(realm_id):
		return null
	var r = gd.realms_by_id[realm_id]
	if typeof(r) == TYPE_DICTIONARY and r.has("sky") and r["sky"] is Array and r["sky"].size() > 0:
		return _as_color(r["sky"][0], Color(0.82, 0.92, 0.98))
	return null

static func _as_color(v, fallback: Color) -> Color:
	if v is Color:
		return v
	if v is String:
		var s := String(v)
		if s.length() >= 4:
			return Color(s)
	return fallback

static func _centroid(poly: PackedVector2Array) -> Vector2:
	if poly.is_empty():
		return Vector2.ZERO
	var c := Vector2.ZERO
	for p in poly:
		c += p
	return c / float(poly.size())

static func _default_stream_path() -> PackedVector2Array:
	return PackedVector2Array([
		Vector2(-160, -40), Vector2(-80, 0), Vector2(0, 10),
		Vector2(90, -10), Vector2(170, 30)])

static func _default_lake_poly(world_seed: int, key: String) -> PackedVector2Array:
	var pts := Proc.blob(world_seed, "lake:" + key, 140.0, 9, 0.24)
	var out := PackedVector2Array()
	for p in pts:
		out.append(Vector2(p.x, p.y * 0.6))
	return out

# Open Catmull-Rom densify for finger-drawn / sparse paths (keeps endpoints).
static func _densify_open(path: PackedVector2Array, samples: int) -> PackedVector2Array:
	var n := path.size()
	if n < 3:
		return path
	var out := PackedVector2Array()
	for i in range(n - 1):
		var p0 := path[maxi(i - 1, 0)]
		var p1 := path[i]
		var p2 := path[i + 1]
		var p3 := path[mini(i + 2, n - 1)]
		for s in range(samples):
			var u := float(s) / float(samples)
			out.append(_catmull(p0, p1, p2, p3, u))
	out.append(path[n - 1])
	return out

static func _catmull(p0: Vector2, p1: Vector2, p2: Vector2, p3: Vector2, u: float) -> Vector2:
	var u2 := u * u
	var u3 := u2 * u
	return 0.5 * ((2.0 * p1) + (-p0 + p2) * u
		+ (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * u2
		+ (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * u3)


# =====================================================================
#  MESH BUILDERS (one draw call per water surface)
# =====================================================================

static func _mesh_from(verts: PackedVector2Array, cols: PackedColorArray, uvs: PackedVector2Array, idx: PackedInt32Array) -> ArrayMesh:
	var arr := []
	arr.resize(Mesh.ARRAY_MAX)
	arr[Mesh.ARRAY_VERTEX] = verts
	arr[Mesh.ARRAY_COLOR] = cols
	arr[Mesh.ARRAY_TEX_UV] = uvs
	arr[Mesh.ARRAY_INDEX] = idx
	var m := ArrayMesh.new()
	m.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arr)
	return m

# A triangle FAN: centre (interior=1) + rim loop (interior=0). COLOR.r carries
# the edge-distance so the shader can lace foam around the rim and deepen the
# middle. UV is the bounding-box-normalised position.
static func _fan_mesh(rim: PackedVector2Array, centre: Vector2) -> ArrayMesh:
	var n := rim.size()
	if n < 3:
		return null
	var mn := Vector2(INF, INF)
	var mx := Vector2(-INF, -INF)
	for p in rim:
		mn = mn.min(p)
		mx = mx.max(p)
	mn = mn.min(centre)
	mx = mx.max(centre)
	var span := (mx - mn)
	span.x = maxf(span.x, 0.001)
	span.y = maxf(span.y, 0.001)

	var verts := PackedVector2Array()
	var cols := PackedColorArray()
	var uvs := PackedVector2Array()
	var idx := PackedInt32Array()

	verts.append(centre)
	cols.append(Color(1, 1, 1, 1))
	uvs.append((centre - mn) / span)
	for p in rim:
		verts.append(p)
		cols.append(Color(0, 0, 0, 1))
		uvs.append((p - mn) / span)
	for i in range(n):
		idx.append(0)
		idx.append(1 + i)
		idx.append(1 + ((i + 1) % n))
	return _mesh_from(verts, cols, uvs, idx)

# A RIBBON: rows of [left(edge 0), centre(edge 1), right(edge 0)] stitched along
# a path. UV u = across (0..1), v = along length (0..1). Used by streams + falls.
static func _ribbon_mesh(rows: Array) -> ArrayMesh:
	# rows: Array of { "l":Vector2, "c":Vector2, "r":Vector2, "v":float }
	var rn := rows.size()
	if rn < 2:
		return null
	var verts := PackedVector2Array()
	var cols := PackedColorArray()
	var uvs := PackedVector2Array()
	var idx := PackedInt32Array()
	for row in rows:
		verts.append(row["l"]); cols.append(Color(0, 0, 0, 1)); uvs.append(Vector2(0.0, row["v"]))
		verts.append(row["c"]); cols.append(Color(1, 1, 1, 1)); uvs.append(Vector2(0.5, row["v"]))
		verts.append(row["r"]); cols.append(Color(0, 0, 0, 1)); uvs.append(Vector2(1.0, row["v"]))
	for i in range(rn - 1):
		var a := i * 3
		var b := (i + 1) * 3
		# left half (l,c)
		idx.append(a + 0); idx.append(a + 1); idx.append(b + 1)
		idx.append(a + 0); idx.append(b + 1); idx.append(b + 0)
		# right half (c,r)
		idx.append(a + 1); idx.append(a + 2); idx.append(b + 2)
		idx.append(a + 1); idx.append(b + 2); idx.append(b + 1)
	return _mesh_from(verts, cols, uvs, idx)


# =====================================================================
#  BASE LIVING-WATER NODE
# =====================================================================

class _Water extends ProcNode:
	var wseed: int = 0
	var wkey: String = "w"
	var cols: Dictionary = {}
	var mode: int = 0
	var flow: Vector2 = Vector2.ZERO
	var speed: float = 0.8
	var pattern_scale: float = 1.0
	var footprint_radius: float = 80.0
	var context: Dictionary = {}
	var light_dir: Vector2 = Vector2(-0.4, -0.9)

	var surf: ProcWaterSurface
	var mat: ShaderMaterial

	func _on_built() -> void:
		if context.has("light_dir") and context["light_dir"] is Vector2:
			light_dir = (context["light_dir"] as Vector2).normalized()
		surf = ProcWaterSurface.new()
		mat = _make_material()
		surf.material = mat
		add_child(surf)
		_build()
		_rebuild()

	func _make_material() -> ShaderMaterial:
		var m := ShaderMaterial.new()
		m.shader = ProcWater._get_shader()
		m.set_shader_parameter("u_shallow", cols.get("shallow", Color(0.45, 0.8, 0.82, 0.9)))
		m.set_shader_parameter("u_deep", cols.get("deep", Color(0.09, 0.33, 0.52)))
		m.set_shader_parameter("u_sky", cols.get("sky", Color(0.82, 0.92, 0.98)))
		m.set_shader_parameter("u_foam", cols.get("foam", Color.WHITE))
		m.set_shader_parameter("u_caustic", cols.get("caustic", Color(0.85, 1.0, 0.98)))
		m.set_shader_parameter("u_phase", phase)
		m.set_shader_parameter("u_speed", speed)
		m.set_shader_parameter("u_ripple", 1.0)
		m.set_shader_parameter("u_caust", 1.0)
		m.set_shader_parameter("u_scale", pattern_scale)
		m.set_shader_parameter("u_edge", 0.14)
		m.set_shader_parameter("u_fill", 1.0)
		m.set_shader_parameter("u_glint", 1.0)
		m.set_shader_parameter("u_flow", flow)
		m.set_shader_parameter("u_mode", mode)
		return m

	func _u(name: String, v) -> void:
		if mat:
			mat.set_shader_parameter(name, v)

	# Subclasses build persistent children once here.
	func _build() -> void:
		pass

	# Rebuild the water mesh + stage the decor for the current growth.
	func _rebuild() -> void:
		pass

	func _on_growth() -> void:
		_rebuild()

	# Shared soft shadow + damp bank behind the water (drawn before children).
	func _draw_bank(rim: PackedVector2Array, scale: float, soil: Color) -> void:
		if rim.size() < 3:
			return
		var bank := PackedVector2Array()
		var c := ProcWater._centroid(rim)
		for p in rim:
			bank.append(c + (p - c) * scale)
		# drop shadow
		var sh := PackedVector2Array()
		for p in bank:
			sh.append(p + Vector2(4, 7))
		draw_colored_polygon(sh, Color(0, 0, 0, 0.14))
		# damp earth ring
		var dk := soil.darkened(0.25)
		draw_polygon(bank, Proc.grad_fill(bank, soil, dk))


# A dedicated child that holds the water ShaderMaterial and draws the mesh.
# Kept separate so the parent can draw bank/decor above or below it cheaply.
class ProcWaterSurface extends Node2D:
	var mesh: ArrayMesh = null
	func set_mesh(m: ArrayMesh) -> void:
		mesh = m
		queue_redraw()
	func _draw() -> void:
		if mesh != null:
			draw_mesh(mesh, ProcWater._white())


# =====================================================================
#  POND  — a still mirror that fills, then grows reeds + lily pads
# =====================================================================

class _Pond extends _Water:
	var radius: float = 120.0
	var lobes: int = 9
	var want_lily: bool = true
	var want_reeds: bool = true
	var lily_count: int = 3

	var _rim: PackedVector2Array = PackedVector2Array()
	var _centre: Vector2 = Vector2.ZERO
	var _lilies: Array = []
	var _reeds: Array = []

	func _build() -> void:
		pattern_scale = clampf(radius / 90.0, 0.6, 2.2)
		speed = 0.55
		_u("u_scale", pattern_scale)
		_u("u_speed", speed)

	func _rebuild() -> void:
		var gg := g()
		var R := radius * lerpf(0.34, 1.0, gg)
		# organic rim, squashed for top-down perspective, front lip at y = 0
		var raw := Proc.blob(seedv, wkey + ":pond", R, lobes, 0.22)
		var maxy := -INF
		_rim = PackedVector2Array()
		for p in raw:
			var q := Vector2(p.x, p.y * 0.56)
			maxy = maxf(maxy, q.y)
			_rim.append(q)
		for i in range(_rim.size()):
			var q := _rim[i]
			q.y -= maxy
			_rim[i] = q
		_centre = ProcWater._centroid(_rim)
		surf.set_mesh(ProcWater._fan_mesh(_rim, _centre))

		footprint_radius = R
		_u("u_fill", clampf(gg * 1.4, 0.0, 1.0))
		_u("u_ripple", lerpf(0.5, 1.15, gg))
		_u("u_caust", lerpf(0.5, 1.0, gg))
		_u("u_scale", clampf(radius / 90.0, 0.6, 2.2))
		queue_redraw()

		_stage_reeds(gg, R)
		_stage_lilies(gg, R)

	func _stage_reeds(gg: float, R: float) -> void:
		if not want_reeds:
			return
		if _reeds.is_empty() and gg > 0.33:
			var cnt := 2 + int(Proc.rangef(seedv, "reedn:" + wkey, 0.0, 2.9))
			for i in range(cnt):
				var ang := Proc.rangef(seedv, "ra:%d:%s" % [i, wkey], PI * 0.9, PI * 2.1)
				var rr := R * 0.92
				var rd := ProcWater.ProcWater_make_reed(seedv, wkey + ":reed%d" % i,
					Vector2(cos(ang) * rr, _centre.y + sin(ang) * rr * 0.45),
					cols)
				add_child(rd)
				_reeds.append(rd)
		var rg := smoothstep(0.33, 0.7, gg)
		for rd in _reeds:
			rd.set_grow(rg)

	func _stage_lilies(gg: float, R: float) -> void:
		if not want_lily:
			return
		if _lilies.is_empty() and gg > 0.46:
			for i in range(maxi(1, lily_count)):
				var a := Proc.rangef(seedv, "la:%d:%s" % [i, wkey], 0.0, TAU)
				var rr := Proc.rangef(seedv, "lr:%d:%s" % [i, wkey], 0.25, 0.72) * R
				var pos := _centre + Vector2(cos(a) * rr, sin(a) * rr * 0.5)
				var ly := ProcWater.ProcWater_make_lily(seedv, wkey + ":lily%d" % i, pos,
					Proc.rangef(seedv, "ls:%d:%s" % [i, wkey], 14.0, 24.0), cols)
				add_child(ly)
				_lilies.append(ly)
		var lg := smoothstep(0.46, 0.74, gg)
		for ly in _lilies:
			ly.set_base_scale(lg)

	func _draw() -> void:
		if _rim.size() < 3:
			return
		var soil := Color(0.30, 0.24, 0.18)
		if cols.get("deep") is Color:
			soil = (cols["deep"] as Color).darkened(0.45)
		_draw_bank(_rim, 1.14, soil)


# =====================================================================
#  WELL  — rises stone-by-stone, fills, then gains posts, roof + bucket
# =====================================================================

class _Well extends _Water:
	var wscale: float = 1.0
	var _overlay: _WellFront
	var _rope: _WellRope
	var _rim_pts: PackedVector2Array = PackedVector2Array()

	func _build() -> void:
		mode = 0
		speed = 0.35
		pattern_scale = 1.6
		_u("u_mode", 0)
		_u("u_speed", speed)
		_u("u_scale", pattern_scale)
		_overlay = _WellFront.new()
		_overlay.well = self
		# rope+bucket swings gently; its own node so we can rotate it cheaply
		_rope = _WellRope.new()
		_rope.well = self

	func _rebuild() -> void:
		var gg := g()
		var rx := 40.0 * wscale
		var ry := 16.0 * wscale
		var lip_y := -58.0 * wscale   # height of the stone rim top
		footprint_radius = rx + 6.0

		# water disc sitting in the throat, revealed from g ~ 0.4
		if gg > 0.4:
			var wfill := smoothstep(0.4, 0.72, gg)
			var wrx := rx * 0.74
			var wry := ry * 0.74
			var wy := lip_y + (1.0 - wfill) * 10.0
			var rim := PackedVector2Array()
			var steps := 26
			for i in range(steps):
				var a := TAU * i / steps
				rim.append(Vector2(cos(a) * wrx, wy + sin(a) * wry))
			surf.set_mesh(ProcWater._fan_mesh(rim, Vector2(0, wy)))
			_u("u_fill", wfill)
		else:
			surf.set_mesh(null)

		# attach front overlay + rope once the structure is tall enough
		if _overlay.get_parent() == null:
			add_child(_overlay)
		if gg > 0.62 and _rope.get_parent() == null:
			add_child(_rope)
		_overlay.queue_redraw()
		queue_redraw()

	func _animate(_d: float) -> void:
		if _rope and _rope.get_parent() != null:
			_rope.rotation = sin(t * 0.9 + phase) * 0.06

	# Shared stone geometry used by back (_draw) + front (_overlay).
	func stone_ring(top: bool, gg: float) -> void:
		pass

	func _draw() -> void:
		# BACK half of the stone rim + the dark shaft (behind the water child).
		var gg := g()
		var rx := 40.0 * wscale
		var ry := 16.0 * wscale
		var build_h := 58.0 * wscale * smoothstep(0.0, 0.4, gg)
		var lip_y := -build_h
		var stone := Color(0.62, 0.60, 0.56)
		var stone_dk := stone.darkened(0.4)

		# cylindrical body (front face band from lip down to ground)
		var body := PackedVector2Array([
			Vector2(-rx, lip_y + ry), Vector2(-rx, 0),
			Vector2(rx, 0), Vector2(rx, lip_y + ry)])
		draw_polygon(body, Proc.grad_fill(body, stone.darkened(0.12), stone_dk))
		# mortar courses
		var courses := int(build_h / (9.0 * wscale))
		for c in range(courses):
			var yy := lip_y + ry + (c + 1) * 9.0 * wscale
			if yy < -1.0:
				draw_line(Vector2(-rx * 0.96, yy), Vector2(rx * 0.96, yy), stone_dk, 1.5, true)
		# dark inner shaft (behind water)
		var shaft := PackedVector2Array()
		var steps := 24
		for i in range(steps):
			var a := TAU * i / steps
			shaft.append(Vector2(cos(a) * rx * 0.82, lip_y + sin(a) * ry * 0.82))
		draw_colored_polygon(shaft, Color(0.05, 0.07, 0.10))
		# back rim stones (upper arc)
		_rim_stones(rx, ry, lip_y, stone, stone_dk, true)

	func _rim_stones(rx: float, ry: float, lip_y: float, stone: Color, stone_dk: Color, back: bool) -> void:
		var n := 14
		for i in range(n):
			var a := TAU * i / n
			var on_back := sin(a) < 0.0
			if on_back != back:
				continue
			var cx := cos(a) * rx
			var cy := lip_y + sin(a) * ry
			var sr := 7.0 * wscale * (0.9 + 0.2 * Proc.hashf(seedv, "st%d%s" % [i, wkey]))
			var blob := Proc.blob(seedv, "stone%d%s" % [i, wkey], sr, 6, 0.25)
			var sp := PackedVector2Array()
			for p in blob:
				sp.append(Vector2(cx, cy) + p)
			draw_polygon(sp, Proc.grad_fill(sp, stone.lightened(0.12), stone_dk))
			# a touch of moss on top-facing stones
			if sin(a) < -0.2:
				draw_colored_polygon(sp, Color(0.36, 0.52, 0.30, 0.28))


class _WellFront extends Node2D:
	var well: _Well
	func _draw() -> void:
		if well == null:
			return
		var gg := well.g()
		var ws := well.wscale
		var rx := 40.0 * ws
		var ry := 16.0 * ws
		var lip_y := -58.0 * ws * smoothstep(0.0, 0.4, gg)
		var stone := Color(0.62, 0.60, 0.56)
		var stone_dk := stone.darkened(0.4)
		# FRONT rim stones (lower arc) — drawn above the water child
		well._rim_stones(rx, ry, lip_y, stone, stone_dk, false)
		if gg <= 0.6:
			return
		# posts + roof + crossbeam grow in from g ~ 0.6
		var pg := smoothstep(0.6, 0.9, gg)
		var post_h := 70.0 * ws * pg
		var wood := Color(0.52, 0.36, 0.22)
		var wood_dk := wood.darkened(0.35)
		var post_top := lip_y - post_h
		for sx in [-1.0, 1.0]:
			var px: float = sx * rx * 0.82
			var post := PackedVector2Array([
				Vector2(px - 4 * ws, lip_y), Vector2(px - 4 * ws, post_top),
				Vector2(px + 4 * ws, post_top), Vector2(px + 4 * ws, lip_y)])
			draw_polygon(post, Proc.grad_fill(post, wood, wood_dk))
		if pg > 0.5:
			var rg := smoothstep(0.75, 1.0, gg)
			# crossbeam
			draw_line(Vector2(-rx * 0.9, post_top + 4 * ws), Vector2(rx * 0.9, post_top + 4 * ws), wood_dk, 5.0 * ws, true)
			# peaked roof
			var apex := Vector2(0, post_top - 34.0 * ws * rg)
			var roof := PackedVector2Array([
				Vector2(-rx * 1.15, post_top), apex, Vector2(rx * 1.15, post_top)])
			var rc := Color(0.46, 0.30, 0.20)
			draw_polygon(roof, Proc.grad_fill(roof, rc.lightened(0.1), rc.darkened(0.3)))
			draw_polyline(roof, rc.darkened(0.45), 2.0, true)


class _WellRope extends Node2D:
	var well: _Well
	func _draw() -> void:
		if well == null:
			return
		var ws := well.wscale
		var lip_y := -58.0 * ws
		var top := lip_y - 60.0 * ws
		# rope
		draw_line(Vector2(0, top), Vector2(0, lip_y - 6 * ws), Color(0.80, 0.68, 0.42), 2.0, true)
		# little bucket
		var by := lip_y - 6 * ws
		var buck := PackedVector2Array([
			Vector2(-6 * ws, by), Vector2(-5 * ws, by + 10 * ws),
			Vector2(5 * ws, by + 10 * ws), Vector2(6 * ws, by)])
		var bc := Color(0.45, 0.31, 0.19)
		draw_polygon(buck, Proc.grad_fill(buck, bc.lightened(0.12), bc.darkened(0.25)))
		draw_polyline(PackedVector2Array([Vector2(-6 * ws, by), Vector2(6 * ws, by)]), bc.lightened(0.2), 2.0, true)


# =====================================================================
#  STREAM  — a flowing ribbon that widens from channel to full flow
# =====================================================================

class _Stream extends _Water:
	var path: PackedVector2Array = PackedVector2Array()
	var width: float = 46.0
	var want_stones: bool = true
	var _banks: PackedVector2Array = PackedVector2Array()

	func _build() -> void:
		mode = 1
		speed = 1.0
		flow = Vector2(0, -0.55)
		pattern_scale = 1.1
		_u("u_mode", 1)
		_u("u_speed", speed)
		_u("u_flow", flow)
		_u("u_scale", pattern_scale)

	func _rebuild() -> void:
		var gg := g()
		var wfrac := lerpf(0.2, 1.0, gg)
		var rows: Array = []
		var total := _path_length()
		var acc := 0.0
		var n := path.size()
		var left := PackedVector2Array()
		var right := PackedVector2Array()
		for i in range(n):
			if i > 0:
				acc += path[i].distance_to(path[i - 1])
			var tan := _tangent(i)
			var nrm := Vector2(-tan.y, tan.x)
			# gentle meander in half-width for life
			var mw := 1.0 + 0.12 * sin(float(i) * 0.7 + phase)
			var half := width * 0.5 * wfrac * mw
			var c := path[i]
			var l := c - nrm * half
			var r := c + nrm * half
			rows.append({"l": l, "c": c, "r": r, "v": (acc / total) if total > 0.0 else 0.0})
			left.append(l)
			right.append(r)
		surf.set_mesh(ProcWater._ribbon_mesh(rows))

		# store banks (left forward + right backward) for the damp channel fill
		_banks = PackedVector2Array()
		for p in left:
			_banks.append(p)
		for i in range(right.size()):
			_banks.append(right[right.size() - 1 - i])

		footprint_radius = width
		_u("u_fill", clampf(gg * 1.5, 0.0, 1.0))
		_u("u_ripple", lerpf(0.6, 1.2, gg))
		queue_redraw()

	func _path_length() -> float:
		var l := 0.0
		for i in range(1, path.size()):
			l += path[i].distance_to(path[i - 1])
		return l

	func _tangent(i: int) -> Vector2:
		var n := path.size()
		if n < 2:
			return Vector2.RIGHT
		var a := path[maxi(i - 1, 0)]
		var b := path[mini(i + 1, n - 1)]
		var d := b - a
		return d.normalized() if d.length() > 0.001 else Vector2.RIGHT

	func _draw() -> void:
		if _banks.size() < 4:
			return
		# damp channel just outside the water
		var soil := Color(0.28, 0.22, 0.17)
		if cols.get("deep") is Color:
			soil = (cols["deep"] as Color).darkened(0.5)
		var wide := PackedVector2Array()
		var mid := _path_centre()
		for p in _banks:
			wide.append(mid + (p - mid) * 1.18)
		draw_colored_polygon(wide, soil)
		# a few rounded stepping / riffle stones
		if want_stones:
			var sn := 2 + int(Proc.rangef(seedv, "stn:" + wkey, 0.0, 2.9))
			for i in range(sn):
				var ti := Proc.rangef(seedv, "sti%d:%s" % [i, wkey], 0.15, 0.85)
				var idx := clampi(int(ti * (path.size() - 1)), 0, path.size() - 1)
				var sp := path[idx]
				var off := Proc.rangef(seedv, "sto%d:%s" % [i, wkey], -0.3, 0.3) * width
				var tan := _tangent(idx)
				var nrm := Vector2(-tan.y, tan.x)
				var pos := sp + nrm * off
				var blob := Proc.blob(seedv, "stnb%d:%s" % [i, wkey], Proc.rangef(seedv, "sts%d:%s" % [i, wkey], 7.0, 12.0), 6, 0.28)
				var poly := PackedVector2Array()
				for q in blob:
					poly.append(pos + Vector2(q.x, q.y * 0.6))
				var rk := Color(0.55, 0.53, 0.5)
				draw_polygon(poly, Proc.grad_fill(poly, rk.lightened(0.1), rk.darkened(0.35)))

	func _path_centre() -> Vector2:
		return ProcWater._centroid(path)


# =====================================================================
#  WATERFALL  — spills off the island lip (origin) downward into cloud
# =====================================================================

class _Waterfall extends _Water:
	var width: float = 90.0
	var drop: float = 520.0
	var _mists: Array = []
	var _sheet_bottom: float = 0.0
	var _bottom_w: float = 0.0

	func _build() -> void:
		mode = 2
		speed = 1.8
		flow = Vector2(0, -1.4)
		pattern_scale = 1.0
		_u("u_mode", 2)
		_u("u_speed", speed)
		_u("u_flow", flow)
		_u("u_scale", pattern_scale)

	func _rebuild() -> void:
		var gg := g()
		var wfrac := lerpf(0.14, 1.0, gg)
		var sheet_drop := drop * lerpf(0.5, 1.0, gg)
		var rows: Array = []
		var k := 16
		var noise := Proc.noise(seedv, "fall:" + wkey, 0.02, 2)
		for i in range(k + 1):
			var yf := float(i) / float(k)
			var y := yf * sheet_drop
			# neck slightly at the lip, flare + break toward the foot
			var prof := 0.82 + 0.5 * smoothstep(0.35, 1.0, yf)
			var half := width * 0.5 * wfrac * prof
			var drift := noise.get_noise_1d(yf * 180.0) * width * 0.14 * yf
			var c := Vector2(drift, y)
			rows.append({"l": Vector2(drift - half, y), "c": c, "r": Vector2(drift + half, y), "v": yf})
		surf.set_mesh(ProcWater._ribbon_mesh(rows))
		_sheet_bottom = sheet_drop
		_bottom_w = width * wfrac * (0.82 + 0.5)

		footprint_radius = width
		_u("u_fill", clampf(0.3 + gg * 0.8, 0.0, 1.0))
		_u("u_ripple", lerpf(0.7, 1.3, gg))
		queue_redraw()
		_stage_mist(gg)

	func _stage_mist(gg: float) -> void:
		var want := 0 if gg < 0.25 else (3 + int(gg * 3.0))
		while _mists.size() < want:
			var i := _mists.size()
			var m := _WaterMist.new()
			m.seedv = seedv
			m.mkey = "mist%d:%s" % [i, wkey]
			m.base = Color(0.92, 0.96, 1.0)
			add_child(m)
			_mists.append(m)
		for i in range(_mists.size()):
			var m = _mists[i]
			var sx := Proc.rangef(seedv, "mx%d:%s" % [i, wkey], -0.55, 0.55) * _bottom_w
			m.position = Vector2(sx, _sheet_bottom)
			m.spread = _bottom_w * 0.5 + 18.0
			m.active = i < want

	func _draw() -> void:
		var gg := g()
		if gg < 0.1:
			return
		# soft back-glow of the falling water (reads as spray haze)
		var glow := cols.get("shallow", Color(0.6, 0.85, 0.9)) as Color
		var halo := PackedVector2Array([
			Vector2(-width * 0.7, 0), Vector2(-_bottom_w * 0.7, _sheet_bottom),
			Vector2(_bottom_w * 0.7, _sheet_bottom), Vector2(width * 0.7, 0)])
		draw_colored_polygon(halo, Color(glow.r, glow.g, glow.b, 0.10))
		# the cloud bank it spills into, at the foot
		var cloud_y := _sheet_bottom + 6.0
		for i in range(5):
			var cx := Proc.rangef(seedv, "cl%d:%s" % [i, wkey], -1.0, 1.0) * _bottom_w * 0.85
			var cr := Proc.rangef(seedv, "clr%d:%s" % [i, wkey], 26.0, 46.0)
			var blob := Proc.blob(seedv, "clb%d:%s" % [i, wkey], cr, 7, 0.3)
			var poly := PackedVector2Array()
			for p in blob:
				poly.append(Vector2(cx + p.x, cloud_y + p.y * 0.55))
			draw_colored_polygon(poly, Color(0.95, 0.97, 1.0, 0.5))
		# foam crest at the lip
		var lipw := width * lerpf(0.14, 1.0, gg) * 0.5
		var crest := PackedVector2Array()
		for i in range(10):
			var u := float(i) / 9.0
			var x := lerpf(-lipw, lipw, u)
			crest.append(Vector2(x, -4.0 + sin(u * PI) * -4.0))
		for i in range(9, -1, -1):
			var u2 := float(i) / 9.0
			crest.append(Vector2(lerpf(-lipw, lipw, u2), 3.0))
		draw_colored_polygon(crest, Color(1, 1, 1, 0.7))


# =====================================================================
#  GENERIC WATER SURFACE  — shader water over any supplied polygon
# =====================================================================

class _Surface extends _Water:
	var poly: PackedVector2Array = PackedVector2Array()

	func _build() -> void:
		mode = 0
		speed = 0.6
		pattern_scale = 1.0
		_u("u_speed", speed)
		_u("u_scale", pattern_scale)

	func _rebuild() -> void:
		var gg := g()
		if poly.size() < 3:
			return
		var c := ProcWater._centroid(poly)
		# fill up from the centre as growth rises
		var shaped := PackedVector2Array()
		for p in poly:
			shaped.append(c + (p - c) * lerpf(0.4, 1.0, gg))
		surf.set_mesh(ProcWater._fan_mesh(shaped, c))
		_u("u_fill", clampf(gg * 1.4, 0.0, 1.0))
		_u("u_ripple", lerpf(0.5, 1.1, gg))
		queue_redraw()

	func _draw() -> void:
		if poly.size() < 3:
			return
		var soil := Color(0.28, 0.23, 0.18)
		if cols.get("deep") is Color:
			soil = (cols["deep"] as Color).darkened(0.5)
		_draw_bank(poly, 1.1, soil)


# =====================================================================
#  SELF-ANIMATING DECOR  (plain Node2D; cheap per-frame transforms only)
# =====================================================================

class _Lily extends Node2D:
	var seedv: int = 0
	var lkey: String = "l"
	var size: float = 18.0
	var cols: Dictionary = {}
	var ph: float = 0.0
	var base_pos: Vector2 = Vector2.ZERO
	var base_scale: float = 1.0
	var has_flower: bool = false
	var _tt: float = 0.0

	func _ready() -> void:
		ph = Proc.hashf(seedv, "lp:" + lkey) * TAU
		base_pos = position
		has_flower = Proc.hashf(seedv, "lf:" + lkey) > 0.45

	func set_base_scale(s: float) -> void:
		var prev := base_scale
		base_scale = clampf(s, 0.0, 1.0)
		# _process only animates the transform; the pad/vein/flower geometry
		# is emitted in _draw, so we must re-trigger it when growth changes
		# (otherwise the first draw at base_scale 0 early-returns forever).
		if prev != base_scale:
			queue_redraw()

	func _process(delta: float) -> void:
		_tt += delta
		var breath := 1.0 + 0.05 * sin(_tt * 1.3 + ph)
		scale = Vector2(base_scale, base_scale) * breath
		position = base_pos + Vector2(sin(_tt * 0.7 + ph) * 1.5, cos(_tt * 0.9 + ph) * 1.2)
		rotation = sin(_tt * 0.5 + ph) * 0.04

	func _draw() -> void:
		if base_scale <= 0.01:
			return
		# pad: squashed blob with a wedge cleft
		var pad := Proc.blob(seedv, "pad:" + lkey, size, 7, 0.14)
		var poly := PackedVector2Array()
		for p in pad:
			poly.append(Vector2(p.x, p.y * 0.62))
		var green := Color(0.28, 0.55, 0.30)
		if cols.has("deep"):
			green = (cols["deep"] as Color).lerp(Color(0.3, 0.6, 0.32), 0.7)
		draw_polygon(poly, Proc.grad_fill(poly, green.lightened(0.15), green.darkened(0.2)))
		# cleft
		draw_line(Vector2.ZERO, Vector2(size * 0.9, 0).rotated(ph), green.darkened(0.4), 1.5, true)
		# veins
		for i in range(5):
			var a := ph + PI + (i - 2) * 0.32
			draw_line(Vector2.ZERO, Vector2(cos(a) * size * 0.85, sin(a) * size * 0.5), green.darkened(0.28), 1.0, true)
		# flower
		if has_flower:
			var fc := Color(0.98, 0.86, 0.9)
			if cols.has("caustic"):
				fc = (cols["caustic"] as Color).lerp(Color(1, 0.8, 0.85), 0.5)
			for i in range(6):
				var a := TAU * i / 6.0 + ph
				var pet := PackedVector2Array([
					Vector2(0, -size * 0.1),
					Vector2(cos(a - 0.3), sin(a - 0.3)) * size * 0.4 + Vector2(0, -size * 0.1),
					Vector2(cos(a), sin(a)) * size * 0.55 + Vector2(0, -size * 0.1),
					Vector2(cos(a + 0.3), sin(a + 0.3)) * size * 0.4 + Vector2(0, -size * 0.1)])
				draw_colored_polygon(pet, fc)
			draw_circle(Vector2(0, -size * 0.1), size * 0.12, Color(1.0, 0.82, 0.3))


class _Reed extends Node2D:
	var seedv: int = 0
	var rkey: String = "r"
	var cols: Dictionary = {}
	var grow: float = 0.0
	var ph: float = 0.0
	var _blades: int = 4
	var _tt: float = 0.0

	func _ready() -> void:
		ph = Proc.hashf(seedv, "rp:" + rkey) * TAU
		_blades = 3 + int(Proc.hashf(seedv, "rb:" + rkey) * 3.0)

	func set_grow(gv: float) -> void:
		grow = clampf(gv, 0.0, 1.0)
		queue_redraw()

	func _process(delta: float) -> void:
		_tt += delta
		skew = sin(_tt * 1.1 + ph) * 0.08

	func _draw() -> void:
		if grow <= 0.02:
			return
		var green := Color(0.34, 0.52, 0.28)
		if cols.has("deep"):
			green = (cols["deep"] as Color).lerp(Color(0.35, 0.55, 0.3), 0.65)
		for i in range(_blades):
			var bx := (i - _blades * 0.5) * 3.0 + Proc.rangef(seedv, "bx%d:%s" % [i, rkey], -1.5, 1.5)
			var h := grow * Proc.rangef(seedv, "bh%d:%s" % [i, rkey], 26.0, 44.0)
			var bend := Proc.rangef(seedv, "bd%d:%s" % [i, rkey], -6.0, 6.0)
			var tip := Vector2(bx + bend, -h)
			var blade := PackedVector2Array([
				Vector2(bx - 1.6, 0), Vector2(bx + 1.6, 0),
				tip + Vector2(1.0, 0), tip, tip + Vector2(-1.0, 0)])
			draw_polygon(blade, Proc.grad_fill(blade, green.darkened(0.1), green.lightened(0.18)))
			# cattail on some blades
			if Proc.hashf(seedv, "ct%d:%s" % [i, rkey]) > 0.6 and grow > 0.6:
				var cat := Color(0.45, 0.3, 0.18)
				draw_line(tip, tip + Vector2(0, -8), cat, 3.0, true)


class _WaterMist extends Node2D:
	var seedv: int = 0
	var mkey: String = "m"
	var base: Color = Color(0.95, 0.97, 1.0)
	var spread: float = 40.0
	var active: bool = true
	var ph: float = 0.0
	var _tt: float = 0.0

	func _ready() -> void:
		ph = Proc.hashf(seedv, "mp:" + mkey) * TAU

	func _process(delta: float) -> void:
		_tt += delta
		var cyc := fposmod(_tt * 0.4 + ph, TAU)
		var rise := (cyc / TAU)
		# soft rise + fade loop
		position.y = -rise * 26.0
		var fade := sin(rise * PI)
		modulate = Color(1, 1, 1, (0.0 if not active else fade * 0.6))
		var s := 0.7 + rise * 0.6
		scale = Vector2(s, s)

	func _draw() -> void:
		for i in range(4):
			var a := Proc.rangef(seedv, "ma%d:%s" % [i, mkey], 0.0, TAU)
			var rr := Proc.rangef(seedv, "mr%d:%s" % [i, mkey], 0.2, 1.0) * spread
			var cr := Proc.rangef(seedv, "mcr%d:%s" % [i, mkey], 14.0, 26.0)
			var blob := Proc.blob(seedv, "mb%d:%s" % [i, mkey], cr, 7, 0.3)
			var poly := PackedVector2Array()
			var off := Vector2(cos(a) * rr, sin(a) * rr * 0.5)
			for p in blob:
				poly.append(off + Vector2(p.x, p.y * 0.7))
			draw_colored_polygon(poly, Color(base.r, base.g, base.b, 0.22))


# ---- decor builder shims (keep factories readable) -----------------
static func ProcWater_make_lily(sv: int, key: String, pos: Vector2, size: float, cols: Dictionary) -> Node2D:
	var l := _Lily.new()
	l.seedv = sv
	l.lkey = key
	l.size = size
	l.cols = cols
	l.position = pos
	l.base_scale = 0.0
	return l

static func ProcWater_make_reed(sv: int, key: String, pos: Vector2, cols: Dictionary) -> Node2D:
	var r := _Reed.new()
	r.seedv = sv
	r.rkey = key
	r.cols = cols
	r.position = pos
	return r
