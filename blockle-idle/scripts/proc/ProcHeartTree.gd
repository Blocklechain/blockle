class_name ProcHeartTree extends RefCounted
# ProcHeartTree — the grand central HEART TREE, majestic hero of the world.
#
# A colossal luminous world-tree, built entirely from math (no imported images):
#   * a massive smooth BUTTRESSED trunk that flares into sculpted root-fins,
#   * a sweeping, recursively-branching BOUGH system that sways in a living wind,
#   * a vast, layered, GLOWING canopy of overlapping foliage masses crowned with a
#     living shimmer (a GPU shader) and drifting LIGHT MOTES,
#   * lit SURFACE ROOTS crawling out across the ground to softly-glowing tips,
#   * a luminous ROOT-POOL of essence heaped at its base (the game's only resource UI),
#   * soft GOD-RAYS (a GPU shader) raking down out of the crown.
#
# It breathes and sways forever (cheap transform + shader-uniform animation; the
# shape is only redrawn when growth creeps past a threshold).
#
# GROWTH is first-class and VERY slow — the long game of the whole world. The full
# mature skeleton is built once; the tree scales up, its buttresses swell, its boughs
# APPEAR and extend, its canopy fills and brightens, and its god-rays strengthen as
# `growth` climbs from 0 to 1. At the earliest stages it is a tender GLOWING SAPLING
# — a slim luminous stem cradling a little heart of light — that smoothly unfurls into
# the ancient giant. Every stage is interpolated through g() (smootherstep) and never
# pops.
#
# Shape contract (CONVENTIONS.md): feet at origin (y=0), body drawn at negative y;
# portrait; seeded + deterministic from (world_seed, key); exposes footprint_radius
# and accepts a context Dictionary for local adaptation; mint freezes it glassy-still.
#
# -- public factory API -------------------------------------------------------
#   ProcHeartTree.make(world_seed, key:="heart", variant:="verdant") -> ProcNode
#   ProcHeartTree.make_for_realm(world_seed, key:="heart", realm_id:="verdant") -> ProcNode
#   ProcHeartTree.sprout(world_seed, key:="heart", variant:="verdant") -> ProcNode
#       (begins as a glowing seed and unfurls on spawn)
#   ProcHeartTree.variants() -> PackedStringArray
# -- public instance API (on the returned ProcNode) ---------------------------
#   .apply_context(ctx:Dictionary)   local palette / light-dir / elevation adapt
#   .set_essence(v01:float)          brightness/size of the root-pool of essence
#   .set_blooming(on:bool)           ascension-eligible golden bloom
#   .set_frozen(on:bool)             mint: stop growth, go glassy & timeless

const VARIANTS := ["verdant", "crystal", "wilds", "skyward", "frost", "astral", "kingdom", "autumn"]

# ---------------------------------------------------------------------------
# Factories
# ---------------------------------------------------------------------------

static func make(world_seed: int, key: String = "heart", variant: String = "verdant") -> ProcNode:
	var n := _Heart.new()
	n.seedv = hash("%d:heart:%s" % [world_seed, key])
	n.variant = variant if variant in VARIANTS else "verdant"
	return n

# Pick the world-tree look that fits a realm's mood (data/realms.json).
static func make_for_realm(world_seed: int, key: String = "heart", realm_id: String = "verdant") -> ProcNode:
	return make(world_seed, key, _realm_variant(realm_id))

# A Heart Tree that begins as a just-planted glowing seed and unfurls on spawn.
static func sprout(world_seed: int, key: String = "heart", variant: String = "verdant") -> ProcNode:
	var n := make(world_seed, key, variant)
	n.growth = 0.0
	(n as _Heart)._pop_on_ready = true
	return n

static func variants() -> PackedStringArray:
	return PackedStringArray(VARIANTS)

static func _realm_variant(realm_id: String) -> String:
	match realm_id:
		"crystal_hollow": return "crystal"
		"skylands": return "skyward"
		"forgotten_wilds": return "wilds"
		"frostfall": return "frost"
		"astral": return "astral"
		"first_kingdom": return "kingdom"
		_: return "verdant"

# ---------------------------------------------------------------------------
# shared GPU shaders (cached once, reused by every instance)
# ---------------------------------------------------------------------------

static var _ray_shader: Shader = null
static var _shimmer_shader: Shader = null
static var _trunkglow_shader: Shader = null

static func _rays() -> Shader:
	if _ray_shader == null:
		_ray_shader = Shader.new()
		_ray_shader.code = RAY_CODE
	return _ray_shader

static func _shimmer() -> Shader:
	if _shimmer_shader == null:
		_shimmer_shader = Shader.new()
		_shimmer_shader.code = SHIMMER_CODE
	return _shimmer_shader

static func _trunkglow() -> Shader:
	if _trunkglow_shader == null:
		_trunkglow_shader = Shader.new()
		_trunkglow_shader.code = TRUNKGLOW_CODE
	return _trunkglow_shader

# Soft volumetric god-rays raking down out of the crown. UV 0..1 over a quad whose
# top-centre sits at the crown. Shafts are angular noise, faded by vertical falloff.
const RAY_CODE := """
shader_type canvas_item;
render_mode blend_add;

uniform vec4  u_color : source_color = vec4(1.0, 0.95, 0.7, 1.0);
uniform float u_phase = 0.0;
uniform float u_intensity = 1.0;   // grows with the tree
uniform float u_origin_x = 0.5;    // crown x in UV
uniform float u_shafts = 9.0;

float hash11(float p){ p = fract(p*0.1031); p *= p+33.33; p *= p+p; return fract(p); }

void fragment(){
	vec2 uv = UV;
	vec2 d = uv - vec2(u_origin_x, -0.02);   // from just above crown
	float ang = atan(d.x, d.y + 0.0001);      // fan direction
	float dist = length(d);
	float t = TIME * 0.06 + u_phase;
	// layered angular shafts that slowly breathe
	float shaft = 0.0;
	for (int i = 0; i < 3; i++){
		float fi = float(i);
		float k = u_shafts * (1.0 + fi*0.37);
		float drift = (hash11(fi*7.0) - 0.5) * 0.6 + t * (0.15 + fi*0.05);
		float s = sin(ang * k + drift);
		shaft += smoothstep(0.55, 1.0, s) * (1.0 - fi*0.28);
	}
	shaft *= 0.6;
	// a gentle shimmer so the rays feel alive
	shaft *= 0.8 + 0.2 * sin(ang * 23.0 + t * 2.0);
	// fall off downward and radially; brightest near the crown
	float vfall = smoothstep(1.05, 0.0, uv.y);
	float rfall = smoothstep(0.95, 0.05, dist);
	float a = shaft * vfall * rfall * u_intensity;
	a *= smoothstep(0.0, 0.18, uv.y);          // hide the hard top seam
	COLOR = vec4(u_color.rgb, a * u_color.a);
}
"""

# A living shimmer of light over the whole canopy silhouette. The crown is drawn as
# one soft blob; UV carries a radial coordinate (0.5 centre) so the glow fades at the
# leaf edge. Flowing fbm makes dappled light move through the foliage; sparkles twinkle.
const SHIMMER_CODE := """
shader_type canvas_item;
render_mode blend_add;

uniform vec4  u_glow : source_color = vec4(0.6, 1.0, 0.7, 1.0);
uniform vec4  u_hot  : source_color = vec4(1.0, 1.0, 0.9, 1.0);
uniform float u_phase = 0.0;
uniform float u_amount = 1.0;
uniform float u_scale = 1.0;

float h12(vec2 p){ vec3 p3=fract(vec3(p.xyx)*0.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
float vn(vec2 p){ vec2 i=floor(p),f=fract(p); vec2 u=f*f*(3.0-2.0*f);
	return mix(mix(h12(i),h12(i+vec2(1,0)),u.x),mix(h12(i+vec2(0,1)),h12(i+vec2(1,1)),u.x),u.y); }
float fbm(vec2 p){ float s=0.0,a=0.5; for(int i=0;i<4;i++){ s+=a*vn(p); p=p*2.03+vec2(5.1,9.2); a*=0.5; } return s; }

void fragment(){
	vec2 uv = UV;
	float r = length(uv - 0.5) * 2.0;          // 0 centre -> 1 rim
	float body = smoothstep(1.0, 0.25, r);     // soft leaf-edge falloff
	float t = TIME * 0.12 + u_phase;
	vec2 q = uv * (7.0 * u_scale);
	float f = fbm(q + vec2(t, -t*0.7));
	float f2 = fbm(q*1.8 + vec2(-t*0.5, t*0.3) + 13.0);
	float dapple = smoothstep(0.45, 0.95, f * 0.6 + f2 * 0.4);
	// a few bright travelling sparkles
	float spark = pow(max(0.0, sin((f2*9.0 + t*3.0))), 24.0);
	vec3 col = mix(u_glow.rgb, u_hot.rgb, dapple);
	float a = (0.22 + 0.5 * dapple + spark * 0.6) * body * u_amount;
	COLOR = vec4(col, a);
}
"""

# A soft inner luminance that lives WITHIN the trunk & limbs — veins of light under
# the bark. Drawn as an additive overlay quad over the trunk bounds.
const TRUNKGLOW_CODE := """
shader_type canvas_item;
render_mode blend_add;

uniform vec4  u_vein : source_color = vec4(0.7, 1.0, 0.8, 1.0);
uniform float u_phase = 0.0;
uniform float u_amount = 1.0;

float h12(vec2 p){ vec3 p3=fract(vec3(p.xyx)*0.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
float vn(vec2 p){ vec2 i=floor(p),f=fract(p); vec2 u=f*f*(3.0-2.0*f);
	return mix(mix(h12(i),h12(i+vec2(1,0)),u.x),mix(h12(i+vec2(0,1)),h12(i+vec2(1,1)),u.x),u.y); }

void fragment(){
	vec2 uv = UV;
	float edge = smoothstep(0.0, 0.14, uv.x) * smoothstep(1.0, 0.86, uv.x);
	float t = TIME * 0.25 + u_phase;
	// vertical sinuous veins, gently pulsing
	float v = sin(uv.x * 18.0 + vn(uv * vec2(3.0, 8.0)) * 6.0);
	v = smoothstep(0.75, 1.0, v);
	float pulse = 0.65 + 0.35 * sin(t + uv.y * 4.0);
	float a = v * edge * pulse * u_amount * smoothstep(0.02, 0.2, uv.y);
	COLOR = vec4(u_vein.rgb, a * 0.5);
}
"""

# ---------------------------------------------------------------------------
# small static geometry helpers (no per-frame allocation on the hot path)
# ---------------------------------------------------------------------------

static func _scaletr(pts: PackedVector2Array, s: float, off: Vector2) -> PackedVector2Array:
	var o := PackedVector2Array()
	o.resize(pts.size())
	for i in pts.size():
		o[i] = pts[i] * s + off
	return o

static func _flat(n: int, c: Color) -> PackedColorArray:
	var a := PackedColorArray()
	a.resize(n)
	for i in n:
		a[i] = c
	return a

static func _quad(a: Vector2, b: Vector2, c: Vector2, t: float) -> Vector2:
	var u := 1.0 - t
	return a * (u * u) + b * (2.0 * u * t) + c * (t * t)

static func _unit_blob(seedv: int, key: String, lobes: int, wobble: float) -> PackedVector2Array:
	return Proc.blob(seedv, "hcan:" + key, 1.0, lobes, wobble)

# A smooth upright heart outline of the given radius, centred at origin — the
# little "heart of light" the sapling cradles, and the soul of the whole tree.
static func _heart_shape(r: float) -> PackedVector2Array:
	var pts := PackedVector2Array()
	var steps := 40
	for i in steps:
		var a := TAU * float(i) / float(steps)
		# classic parametric heart, normalised to ~[-1,1] then scaled
		var x := 16.0 * pow(sin(a), 3.0)
		var y := 13.0 * cos(a) - 5.0 * cos(2.0 * a) - 2.0 * cos(3.0 * a) - cos(4.0 * a)
		pts.append(Vector2(x / 17.0, -y / 17.0) * r)
	return pts

# Radial UVs for a blob so a shader can fade it at the rim (0.5 at centre).
static func _radial_uv(pts: PackedVector2Array, center: Vector2, radius: float) -> PackedVector2Array:
	var uv := PackedVector2Array()
	uv.resize(pts.size())
	var inv := 0.5 / maxf(radius, 0.001)
	for i in pts.size():
		uv[i] = Vector2(0.5, 0.5) + (pts[i] - center) * inv
	return uv

# ===========================================================================
# _Heart — the root ProcNode. Owns colours, the bough hierarchy, the glow
# children (god-rays, canopy shimmer, trunk veins, motes, root-pool) and the wind.
# ===========================================================================
class _Heart extends ProcNode:
	var variant := "verdant"
	var footprint_radius := 240.0
	var _pop_on_ready := false
	var _frozen := false

	var cfg := {}
	var _ctx := {}
	var _light_dir := Vector2(-0.3, -1.0).normalized()
	var _wind_seed := 0.0
	var _essence := 0.6                 # 0..1 size/brightness of the root-pool
	var _blooming := false              # ascension golden bloom

	# structure
	var _boughs_root: _Bough = null
	var _boughs: Array = []             # flat list for cheap per-frame sway
	var _global_size := 1.0

	# glow children
	var _rays_node: _RayField = null
	var _shimmer_node: _Shimmer = null
	var _veins_node: _TrunkVeins = null
	var _motes_node: Node2D = null
	var _motes: Array = []
	var _body_node: _Body = null

	# -----------------------------------------------------------------------
	func _on_built() -> void:
		_wind_seed = Proc.hashf(seedv, "wind") * TAU
		_build_cfg()
		if _ctx.size() > 0:
			_absorb_context(_ctx)
		_compute_colours()
		set_grow_minutes(float(cfg.get("grow_minutes", 840.0)))

		# god-rays sit furthest back
		_rays_node = _RayField.new()
		_rays_node._heart = self
		_rays_node.material = _make_ray_mat()
		add_child(_rays_node)

		# trunk-vein inner light (behind the solid body so it reads as glow under bark)
		_veins_node = _TrunkVeins.new()
		_veins_node._heart = self
		_veins_node.material = _make_vein_mat()
		add_child(_veins_node)

		# the solid body: roots, buttress, trunk, root-pool
		_body_node = _Body.new()
		_body_node._heart = self
		add_child(_body_node)

		# the branch hierarchy (draws limbs + glowing foliage clumps)
		_build_skeleton()

		# the canopy shimmer sits over the foliage
		_shimmer_node = _Shimmer.new()
		_shimmer_node._heart = self
		_shimmer_node.material = _make_shimmer_mat()
		add_child(_shimmer_node)

		# drifting motes of light, in front of it all
		_build_motes()

		_global_size = lerpf(0.06, 1.0, g())
		_relayout()
		if _pop_on_ready:
			pop_in(2.0)

	# ---- public adaptation / state ----------------------------------------

	func apply_context(ctx: Dictionary) -> void:
		_ctx = ctx.duplicate()
		if is_inside_tree() and cfg.size() > 0:
			_absorb_context(_ctx)
			_compute_colours()
			_refresh_materials()
			if _boughs_root:
				_relayout()
				_queue_all()

	func set_essence(v01: float) -> void:
		# Called every frame by the idle loop — only redraw the (complex, mostly
		# static) body when the pool level has moved enough to be visible.
		var nv := clampf(v01, 0.0, 1.0)
		if absf(nv - _essence) < 0.01:
			return
		_essence = nv
		if _body_node:
			_body_node.queue_redraw()

	func set_blooming(on: bool) -> void:
		_blooming = on
		_compute_colours()
		_refresh_materials()
		_queue_all()

	# Mint: press the flower in the book — stop growth, go glassy & timeless.
	func set_frozen(b: bool) -> void:
		_frozen = b
		grow_rate = 0.0 if b else (1.0 / (float(cfg.get("grow_minutes", 840.0)) * 60.0))
		_refresh_materials()
		_queue_all()

	func _absorb_context(ctx: Dictionary) -> void:
		if ctx.has("light_dir"):
			var ld: Vector2 = ctx["light_dir"]
			if ld.length() > 0.01:
				_light_dir = ld.normalized()
		if ctx.has("elevation"):
			var e := clampf(float(ctx["elevation"]), 0.0, 1.0)
			cfg["exposure"] = lerpf(1.0, 1.22, e)

	# ---- the genome (per-variant style) ------------------------------------

	func _build_cfg() -> void:
		var c := {
			"trunk_len": 560.0, "trunk_base_w": 150.0, "trunk_tip_w": 46.0,
			"buttress_flare": 160.0, "buttresses": 6, "surface_roots": 6,
			"lean": Proc.rangef(seedv, "lean", -0.03, 0.03),
			"curve": 0.03, "max_depth": 3, "children": [5, 3, 2],
			"spread": 1.15, "up_bias": 0.42, "len_falloff": 0.66, "w_falloff": 0.6,
			"clumps": 4, "canopy_scale": 0.62, "crown_lift": 0.9,
			"sway_amp": 0.013, "sway_speed": 0.5, "grow_minutes": 840.0,
			# colour roles (filled per-variant below)
			"leaf_hue": 0.33, "leaf_sat": 0.5, "leaf_val": 0.6,
			"glow": Color(0.7, 1.0, 0.72), "hot": Color(1.0, 1.0, 0.88),
			"ray": Color(1.0, 0.96, 0.72), "mote": Color(1.0, 1.0, 0.8),
			"vein": Color(0.72, 1.0, 0.82), "pool": Color(0.5, 1.0, 0.6),
			"bark_top": Color(0.5, 0.42, 0.32), "bark_bot": Color(0.26, 0.2, 0.15),
			"exposure": 1.0, "shimmer_scale": 1.0,
		}
		match variant:
			"verdant":
				c.leaf_hue = 0.32; c.leaf_sat = 0.52; c.leaf_val = 0.6
				c.glow = Color(0.62, 1.0, 0.68); c.hot = Color(1.0, 1.0, 0.82)
				c.ray = Color(1.0, 0.95, 0.66); c.mote = Color(0.9, 1.0, 0.72)
				c.vein = Color(0.7, 1.0, 0.78); c.pool = Color(0.5, 1.0, 0.62)
				c.bark_top = Color(0.52, 0.44, 0.33); c.bark_bot = Color(0.27, 0.21, 0.15)
			"crystal":
				c.leaf_hue = 0.57; c.leaf_sat = 0.46; c.leaf_val = 0.66
				c.glow = Color(0.55, 0.82, 1.0); c.hot = Color(0.85, 0.95, 1.0)
				c.ray = Color(0.72, 0.86, 1.0); c.mote = Color(0.75, 0.9, 1.0)
				c.vein = Color(0.62, 0.86, 1.0); c.pool = Color(0.55, 0.78, 1.0)
				c.bark_top = Color(0.4, 0.44, 0.52); c.bark_bot = Color(0.2, 0.23, 0.32)
				c.sway_speed = 0.42
			"wilds":
				c.leaf_hue = 0.44; c.leaf_sat = 0.55; c.leaf_val = 0.56
				c.glow = Color(0.4, 1.0, 0.7); c.hot = Color(0.75, 1.0, 0.85)
				c.ray = Color(0.6, 1.0, 0.78); c.mote = Color(0.6, 1.0, 0.82)
				c.vein = Color(0.5, 1.0, 0.78); c.pool = Color(0.42, 1.0, 0.72)
				c.bark_top = Color(0.4, 0.42, 0.34); c.bark_bot = Color(0.18, 0.22, 0.17)
				c.clumps = 5; c.canopy_scale = 0.66
			"skyward":
				c.leaf_hue = 0.3; c.leaf_sat = 0.4; c.leaf_val = 0.74
				c.glow = Color(0.72, 1.0, 0.84); c.hot = Color(1.0, 1.0, 0.94)
				c.ray = Color(0.95, 0.98, 1.0); c.mote = Color(1.0, 1.0, 0.92)
				c.vein = Color(0.8, 1.0, 0.9); c.pool = Color(0.7, 0.96, 0.88)
				c.bark_top = Color(0.56, 0.5, 0.42); c.bark_bot = Color(0.32, 0.27, 0.2)
				c.trunk_len = 600.0; c.sway_amp = 0.017
			"frost":
				c.leaf_hue = 0.55; c.leaf_sat = 0.22; c.leaf_val = 0.86
				c.glow = Color(0.78, 0.92, 1.0); c.hot = Color(0.96, 0.99, 1.0)
				c.ray = Color(0.85, 0.94, 1.0); c.mote = Color(0.9, 0.97, 1.0)
				c.vein = Color(0.82, 0.94, 1.0); c.pool = Color(0.78, 0.9, 1.0)
				c.bark_top = Color(0.5, 0.54, 0.6); c.bark_bot = Color(0.28, 0.32, 0.38)
				c.sway_speed = 0.36; c.clumps = 3
			"astral":
				c.leaf_hue = 0.76; c.leaf_sat = 0.5; c.leaf_val = 0.62
				c.glow = Color(0.78, 0.6, 1.0); c.hot = Color(1.0, 0.9, 1.0)
				c.ray = Color(0.85, 0.72, 1.0); c.mote = Color(0.92, 0.82, 1.0)
				c.vein = Color(0.82, 0.66, 1.0); c.pool = Color(0.72, 0.56, 1.0)
				c.bark_top = Color(0.32, 0.28, 0.42); c.bark_bot = Color(0.16, 0.13, 0.24)
			"kingdom":
				c.leaf_hue = 0.11; c.leaf_sat = 0.62; c.leaf_val = 0.68
				c.glow = Color(1.0, 0.82, 0.46); c.hot = Color(1.0, 0.95, 0.72)
				c.ray = Color(1.0, 0.86, 0.5); c.mote = Color(1.0, 0.9, 0.6)
				c.vein = Color(1.0, 0.82, 0.5); c.pool = Color(1.0, 0.8, 0.46)
				c.bark_top = Color(0.56, 0.42, 0.26); c.bark_bot = Color(0.3, 0.2, 0.11)
				c.trunk_base_w = 170.0; c.buttress_flare = 190.0
			"autumn":
				c.leaf_hue = 0.06; c.leaf_sat = 0.68; c.leaf_val = 0.7
				c.glow = Color(1.0, 0.72, 0.42); c.hot = Color(1.0, 0.9, 0.6)
				c.ray = Color(1.0, 0.8, 0.5); c.mote = Color(1.0, 0.84, 0.56)
				c.vein = Color(1.0, 0.76, 0.46); c.pool = Color(1.0, 0.72, 0.42)
				c.bark_top = Color(0.5, 0.4, 0.3); c.bark_bot = Color(0.28, 0.19, 0.13)
		# gentle per-instance variation so no two worlds' hero trees are identical
		c.trunk_len *= Proc.rangef(seedv, "tl", 0.92, 1.08)
		c.trunk_base_w *= Proc.rangef(seedv, "tw", 0.94, 1.08)
		c.children = [5 + int(Proc.hashf(seedv, "bc") * 2.0), 3, 2]
		cfg = c
		footprint_radius = c.trunk_len * c.canopy_scale * 1.15

	# ---- colour drift + mint/bloom tints -----------------------------------

	func _compute_colours() -> void:
		var h: float = cfg.leaf_hue
		var s: float = cfg.leaf_sat
		var v: float = cfg.leaf_val
		h = fposmod(h + Proc.rangef(seedv, "hvar", -0.015, 0.015), 1.0)

		var top := Color.from_hsv(h, s * 0.8, min(1.0, v + 0.2))
		var mid := Color.from_hsv(h, s, v)
		var bot := Color.from_hsv(fposmod(h + 0.02, 1.0), min(1.0, s + 0.12), v * 0.62)

		# blend 25% toward the local realm palette, keep the hero legible
		var local = _ctx.get("local_palette", null)
		if local is Dictionary and local.has("base"):
			var lb: Color = local["base"]
			top = top.lerp(lb.lightened(0.25), 0.22)
			mid = mid.lerp(lb, 0.2)
			bot = bot.lerp(lb.darkened(0.1), 0.2)

		var glow: Color = cfg.glow
		var hot: Color = cfg.hot
		var ray: Color = cfg.ray
		if _blooming:
			# ascension: wash everything toward molten gold
			var gold := Color(1.0, 0.86, 0.42)
			top = top.lerp(gold.lightened(0.2), 0.5)
			mid = mid.lerp(gold, 0.4)
			glow = glow.lerp(gold, 0.6); hot = hot.lerp(Color(1, 0.97, 0.8), 0.6); ray = ray.lerp(gold, 0.6)
		if _frozen:
			# mint: cool, glassy, desaturated stillness
			top = top.lerp(Color(0.86, 0.92, 1.0), 0.4)
			mid = mid.lerp(Color(0.72, 0.82, 0.96), 0.4)
			bot = bot.lerp(Color(0.5, 0.6, 0.78), 0.35)
			glow = glow.lerp(Color(0.85, 0.92, 1.0), 0.5)

		cfg["leaf_top"] = top
		cfg["leaf_mid"] = mid
		cfg["leaf_bot"] = bot
		cfg["leaf_under"] = bot.darkened(0.3)
		cfg["glow_c"] = glow
		cfg["hot_c"] = hot
		cfg["ray_c"] = ray
		cfg["light"] = _light_dir

	# ---- materials ---------------------------------------------------------

	func _make_ray_mat() -> ShaderMaterial:
		var m := ShaderMaterial.new()
		m.shader = ProcHeartTree._rays()
		m.set_shader_parameter("u_color", cfg.get("ray_c", cfg.ray))
		m.set_shader_parameter("u_phase", phase * 3.0)
		m.set_shader_parameter("u_intensity", 0.0)
		m.set_shader_parameter("u_origin_x", 0.5)
		m.set_shader_parameter("u_shafts", 7.0 + Proc.hashf(seedv, "shafts") * 5.0)
		return m

	func _make_shimmer_mat() -> ShaderMaterial:
		var m := ShaderMaterial.new()
		m.shader = ProcHeartTree._shimmer()
		m.set_shader_parameter("u_glow", cfg.get("glow_c", cfg.glow))
		m.set_shader_parameter("u_hot", cfg.get("hot_c", cfg.hot))
		m.set_shader_parameter("u_phase", phase)
		m.set_shader_parameter("u_amount", 0.0)
		m.set_shader_parameter("u_scale", float(cfg.get("shimmer_scale", 1.0)))
		return m

	func _make_vein_mat() -> ShaderMaterial:
		var m := ShaderMaterial.new()
		m.shader = ProcHeartTree._trunkglow()
		m.set_shader_parameter("u_vein", cfg.vein)
		m.set_shader_parameter("u_phase", phase * 2.0)
		m.set_shader_parameter("u_amount", 0.0)
		return m

	func _refresh_materials() -> void:
		if _rays_node and _rays_node.material:
			_rays_node.material.set_shader_parameter("u_color", cfg.get("ray_c", cfg.ray))
		if _shimmer_node and _shimmer_node.material:
			_shimmer_node.material.set_shader_parameter("u_glow", cfg.get("glow_c", cfg.glow))
			_shimmer_node.material.set_shader_parameter("u_hot", cfg.get("hot_c", cfg.hot))
		if _veins_node and _veins_node.material:
			_veins_node.material.set_shader_parameter("u_vein", cfg.vein)

	# ---- build the mature bough skeleton once ------------------------------

	func _build_skeleton() -> void:
		_boughs.clear()
		_boughs_root = _Bough.new()
		_boughs_root._heart = self
		_boughs_root.cfg = cfg
		_boughs_root.depth = 0
		_boughs_root.grow_in = -1.0
		# the "root" bough is the trunk column the boughs spring from (not drawn as a limb)
		_boughs_root.full_length = float(cfg.trunk_len)
		_boughs_root.base_w = float(cfg.trunk_base_w)
		_boughs_root.tip_w = float(cfg.trunk_tip_w)
		_boughs_root.is_trunk = true
		_boughs_root.rest_angle = float(cfg.lean)
		_boughs_root._bp = Proc.hashf(seedv, "bp0") * TAU
		_boughs_root.sway_k = float(cfg.sway_amp) * 0.25
		add_child(_boughs_root)
		_boughs.append(_boughs_root)
		_grow_children(_boughs_root, 1, "b")

	func _grow_children(parent: _Bough, depth: int, key: String) -> void:
		var maxd: int = int(cfg.max_depth)
		if depth > maxd:
			return
		var counts: Array = cfg.children
		var n := 0
		if depth - 1 < counts.size():
			n = int(counts[depth - 1])
		if n <= 0:
			return
		var spread: float = float(cfg.spread) * (1.0 - 0.14 * float(depth - 1))
		var lf: float = float(cfg.len_falloff)
		var wf: float = float(cfg.w_falloff)
		var up: float = float(cfg.up_bias)
		var gin := 0.2 + float(depth - 1) * 0.22
		var light_lean := -atan2(_light_dir.x, -_light_dir.y) * 0.12
		for i in n:
			var frac := (float(i) + 0.5) / float(n) - 0.5          # -0.5..0.5
			var ang := frac * spread * 2.0
			ang += Proc.rangef(seedv, "%s:%d:%d:j" % [key, depth, i], -0.14, 0.14)
			ang *= (1.0 - up * 0.45)
			ang += light_lean
			var child := _Bough.new()
			child._heart = self
			child.cfg = cfg
			child.depth = depth
			child.grow_in = gin + Proc.rangef(seedv, "%s:%d:%d:gi" % [key, depth, i], 0.0, 0.06)
			child.full_length = parent.full_length * lf * Proc.rangef(seedv, "%s:%d:%d:l" % [key, depth, i], 0.84, 1.12)
			child.base_w = maxf(3.0, parent.tip_w * Proc.rangef(seedv, "%s:%d:%d:w0" % [key, depth, i], 0.8, 1.0))
			child.tip_w = maxf(2.0, child.base_w * wf)
			child.curve = Proc.rangef(seedv, "%s:%d:%d:c" % [key, depth, i], -0.16, 0.16)
			child.rest_angle = ang
			child.is_tip = (depth >= maxd)
			# where on the trunk/parent this bough springs from (upper portion)
			if parent.is_trunk:
				child.mount = Proc.rangef(seedv, "%s:%d:mt" % [key, i], 0.62, 1.0)
			else:
				child.mount = Proc.rangef(seedv, "%s:%d:%d:mt" % [key, depth, i], 0.55, 1.0)
			child._bp = Proc.hashf(seedv, "%s:%d:%d:bp" % [key, depth, i]) * TAU
			child.sway_k = float(cfg.sway_amp) * (0.5 + 0.8 * float(depth)) * (1.0 + 0.3 * absf(frac))
			child.bears_canopy = child.is_tip or (depth >= maxd - 1 and Proc.hashf(seedv, "%s:%d:%d:bc" % [key, depth, i]) < 0.6)
			if child.bears_canopy:
				_setup_clumps(child, "%s:%d:%d" % [key, depth, i])
			parent.add_child(child)
			parent.kids.append(child)
			_boughs.append(child)
			_grow_children(child, depth + 1, key + "x")

	func _setup_clumps(limb: _Bough, key: String) -> void:
		var count := int(cfg.get("clumps", 4))
		limb.clumps.clear()
		for k in count:
			var lobes := 8 + int(Proc.hashf(seedv, "%s:%d:lo" % [key, k]) * 5.0)
			var wob := Proc.rangef(seedv, "%s:%d:wo" % [key, k], 0.16, 0.3)
			var off := Vector2(
				Proc.rangef(seedv, "%s:%d:ox" % [key, k], -0.6, 0.6),
				Proc.rangef(seedv, "%s:%d:oy" % [key, k], -0.7, 0.25))
			var rsc := Proc.rangef(seedv, "%s:%d:rs" % [key, k], 0.6, 1.0)
			if k == 0:
				off = Vector2.ZERO
				rsc = 1.0
			limb.clumps.append({
				"pts": ProcHeartTree._unit_blob(seedv, "%s:%d" % [key, k], lobes, wob),
				"off": off, "r": rsc,
				"lit": Proc.hashf(seedv, "%s:%d:li" % [key, k]) < 0.4,
			})
		limb.dots.clear()
		for k in 7:
			limb.dots.append(Vector2(
				Proc.rangef(seedv, "%s:%d:dx" % [key, k], -0.8, 0.8),
				Proc.rangef(seedv, "%s:%d:dy" % [key, k], -0.75, 0.35)))

	# ---- drifting light motes ----------------------------------------------

	func _build_motes() -> void:
		_motes_node = Node2D.new()
		add_child(_motes_node)
		_motes.clear()
		var count := 26
		for i in count:
			var m := _Mote.new()
			m.base_col = cfg.mote
			# an orbit within the crown region, seeded per mote
			m.orbit = Vector2(
				Proc.rangef(seedv, "mo%d:rx" % i, 60.0, 260.0),
				Proc.rangef(seedv, "mo%d:ry" % i, 50.0, 200.0))
			m.center = Vector2(
				Proc.rangef(seedv, "mo%d:cx" % i, -0.4, 0.4),
				Proc.rangef(seedv, "mo%d:cy" % i, -0.9, -0.45))
			m.sp = Proc.rangef(seedv, "mo%d:sp" % i, 0.08, 0.26)
			m.ph = Proc.hashf(seedv, "mo%d:ph" % i) * TAU
			m.ph2 = Proc.hashf(seedv, "mo%d:p2" % i) * TAU
			m.rad = Proc.rangef(seedv, "mo%d:r" % i, 2.0, 6.5)
			m.base_col.a = 0.0
			_motes_node.add_child(m)
			m._build()
			_motes.append(m)

	# ---- growth ------------------------------------------------------------

	func _on_growth() -> void:
		_global_size = lerpf(0.06, 1.0, g())
		if _boughs_root:
			_relayout()
		if _shimmer_node:
			_shimmer_node.queue_redraw()
		if _veins_node:
			_veins_node.queue_redraw()
		if _body_node:
			_body_node.queue_redraw()

	func _relayout() -> void:
		_relayout_bough(_boughs_root, float(cfg.trunk_len) * _global_size)

	func _relayout_bough(limb: _Bough, trunk_len: float) -> void:
		limb._update_dims()
		for c in limb.kids:
			# mount child up the parent's current length
			var mount_len := (limb.current_length if not limb.is_trunk else trunk_len)
			c.position = Vector2(0, -mount_len * c.mount)
			c.rotation = c.rest_angle
			_relayout_bough(c, trunk_len)

	func _queue_all() -> void:
		for b in _boughs:
			(b as _Bough).queue_redraw()

	# ---- the wind + breathing: pure transform / uniform animation ----------

	func _animate(delta: float) -> void:
		var sp: float = float(cfg.sway_speed)
		var ph := phase + _wind_seed
		var wind := sin(t * sp + ph) * 0.68 + sin(t * sp * 0.41 + ph * 1.7) * 0.32
		var gust := 1.0 + 0.4 * maxf(0.0, sin(t * 0.13 + ph * 0.6))
		var expo: float = cfg.get("exposure", 1.0)
		var fm := 0.1 if _frozen else 1.0
		var amp := wind * gust * expo * fm

		# sway the whole bough hierarchy (compounding)
		for item in _boughs:
			var limb: _Bough = item
			limb.rotation = limb.rest_angle + amp * limb.sway_k
			if limb.is_tip:
				var b := 1.0 + 0.02 * sin(t * sp * 1.3 + limb._bp) * fm
				limb.scale = Vector2(b, b)

		# the tree breathes: a slow vertical swell of the crown + shimmer pulse
		var breath := 0.5 + 0.5 * sin(t * 0.33 + ph)
		var gv := g()
		var intensity := clampf(gv * (0.55 + 0.45 * breath), 0.0, 1.5) * fm
		if _frozen:
			intensity = clampf(gv * 0.25, 0.0, 0.4)
		if _blooming:
			intensity *= 1.4

		if _rays_node and _rays_node.material:
			_rays_node.material.set_shader_parameter("u_intensity", intensity * (0.5 + 0.5 * gv))
		if _shimmer_node and _shimmer_node.material:
			_shimmer_node.material.set_shader_parameter("u_amount", clampf(gv * (0.6 + 0.4 * breath), 0.0, 1.3) * fm)
		if _veins_node and _veins_node.material:
			var veinamt := clampf((0.3 + 0.7 * gv) * (0.6 + 0.4 * breath), 0.0, 1.0) * (0.4 if _frozen else 1.0)
			_veins_node.material.set_shader_parameter("u_amount", veinamt)

		# motes rise, orbit and twinkle (cheap transforms only)
		var mg := clampf((gv - 0.2) / 0.6, 0.0, 1.0)
		for item in _motes:
			var mo: _Mote = item
			mo.tick(t, mg, _global_size, fm)

	# the root node itself draws nothing (children do); keeps z-order explicit.
	func _draw() -> void:
		pass


# ===========================================================================
# _Body — roots, buttressed trunk, and the luminous root-pool of essence.
# Drawn beneath the boughs; redraws only on growth / essence change.
# ===========================================================================
class _Body extends Node2D:
	var _heart: _Heart = null

	func _draw() -> void:
		if _heart == null or _heart.cfg.is_empty():
			return
		var cfg := _heart.cfg
		var gs := _heart._global_size
		var gv := _heart.g()
		var tl := float(cfg.trunk_len) * gs
		var bw := float(cfg.trunk_base_w) * gs
		var tw := float(cfg.trunk_tip_w) * gs
		var flare := float(cfg.buttress_flare) * gs * smoothstep(0.1, 0.7, gv)
		var light: Vector2 = cfg.light

		# 1) wide soft contact shadow on the ground
		var fr := _heart.footprint_radius * gs * 0.9
		if fr > 3.0:
			var sh := Proc.superellipse(fr, fr * 0.2, 2.4, 30)
			draw_colored_polygon(sh, Color(0.03, 0.06, 0.04, 0.26))

		# 2) the root-pool of essence pooled at the base (the only resource UI)
		_draw_root_pool(bw, flare)

		# 3) lit surface roots crawling out across the ground
		if gv > 0.14:
			_draw_surface_roots(bw, flare, light)

		# the very young stage is a glowing sapling, not a trunk
		if gv < 0.2:
			_draw_sapling(tl, bw, gv, light)
			return

		# 4) buttress root-fins sculpting the trunk base
		if flare > 2.0:
			_draw_buttresses(tl, bw, flare, light)

		# 5) the massive tapered, gently-curved trunk
		_draw_trunk(tl, bw, tw, flare, light)

	# ------------------------------------------------------------------
	func _draw_root_pool(bw: float, flare: float) -> void:
		var e := _heart._essence
		if e <= 0.001:
			return
		var pool_col: Color = _heart.cfg.pool
		var r := (bw * 0.9 + flare * 0.7) * (0.6 + 0.6 * e)
		# layered luminous heap, brightest at the centre
		for i in 4:
			var f := float(i) / 3.0
			var rr := r * (1.0 - f * 0.55)
			var blob := Proc.superellipse(rr, rr * 0.4, 2.6, 26)
			var c := pool_col
			c.a = (0.14 + 0.26 * e) * (1.0 - f * 0.2)
			var off := Vector2(0, -rr * 0.18)
			var pts := ProcHeartTree._scaletr(blob, 1.0, off)
			draw_colored_polygon(pts, c)
		# a scatter of bright essence motes resting on the heap
		var n := 5 + int(e * 7.0)
		for i in n:
			var p := Vector2(
				Proc.rangef(_heart.seedv, "pm%d:x" % i, -1.0, 1.0) * r * 0.7,
				-Proc.rangef(_heart.seedv, "pm%d:y" % i, 0.05, 0.4) * r * 0.5)
			var mc := pool_col.lightened(0.3)
			mc.a = 0.5 * e
			draw_circle(p, r * 0.05, mc)

	func _draw_surface_roots(bw: float, flare: float, light: Vector2) -> void:
		var cfg := _heart.cfg
		var n := int(cfg.surface_roots)
		var reach := (bw * 1.6 + flare) * 1.3
		var bt: Color = cfg.bark_top
		var bb: Color = cfg.bark_bot
		for i in n:
			var side := 1.0 if i % 2 == 0 else -1.0
			var t0 := (float(i) + 0.5) / float(n)
			var dir := side * lerpf(0.5, 1.3, Proc.hashf(_heart.seedv, "sr%d:d" % i))
			var len_r := reach * Proc.rangef(_heart.seedv, "sr%d:l" % i, 0.6, 1.1)
			var w := (bw * 0.16) * Proc.rangef(_heart.seedv, "sr%d:w" % i, 0.7, 1.2)
			var start := Vector2(side * bw * 0.4 * Proc.rangef(_heart.seedv, "sr%d:s" % i, 0.4, 1.0), -bw * 0.1)
			var end := start + Vector2(dir * len_r, -2.0)
			var ctrl := start + Vector2(dir * len_r * 0.5, -w * 1.6 - len_r * 0.08)
			var m := 9
			var spine := []
			spine.resize(m)
			for s in m:
				spine[s] = ProcHeartTree._quad(start, ctrl, end, float(s) / float(m - 1))
			var L := PackedVector2Array()
			var R := PackedVector2Array()
			L.resize(m); R.resize(m)
			for s in m:
				var tt := float(s) / float(m - 1)
				var ww := lerpf(w, w * 0.12, tt)
				var pn: Vector2 = spine[mini(s + 1, m - 1)]
				var pp: Vector2 = spine[maxi(s - 1, 0)]
				var tang := (pn - pp).normalized()
				var nrm := Vector2(-tang.y, tang.x)
				L[s] = spine[s] + nrm * ww
				R[s] = spine[s] - nrm * ww
			var poly := PackedVector2Array()
			poly.append_array(L)
			for s in m:
				poly.append(R[m - 1 - s])
			draw_polygon(poly, Proc.grad_fill(poly, bt.darkened(0.05), bb))
			# a soft glowing tip where the root dips into the earth
			var tip: Vector2 = spine[m - 1]
			var gc: Color = cfg.glow_c
			gc.a = 0.35
			draw_circle(tip, w * 1.3, gc)
			gc.a = 0.7
			draw_circle(tip, w * 0.6, gc.lightened(0.2))

	func _draw_buttresses(tl: float, bw: float, flare: float, light: Vector2) -> void:
		var cfg := _heart.cfg
		var n := int(cfg.buttresses)
		var bt: Color = cfg.bark_top
		var bb: Color = cfg.bark_bot
		for i in n:
			var side := 1.0 if i % 2 == 0 else -1.0
			var spread := (float(i / 2) + 1.0) / float((n / 2) + 1)
			var fx := side * flare * spread
			var fy := -tl * lerpf(0.1, 0.34, 1.0 - spread)   # higher fins meet trunk higher
			var footx := side * (flare * spread * 1.25 + bw * 0.3)
			var controls := PackedVector2Array([
				Vector2(side * bw * 0.35, fy),                  # where it joins the trunk
				Vector2(fx * 0.7, fy * 0.55),
				Vector2(fx, -flare * 0.08),                     # mid flare
				Vector2(footx, -2.0),                           # foot on the ground
				Vector2(side * bw * 0.2, 0.0),                  # back at the trunk foot
				Vector2(side * bw * 0.3, fy * 0.3)])
			var fin := Proc.smooth_loop(controls, 8)
			# gradient: lit on the light-facing side
			var face_lit: bool = (side < 0.0) == (light.x < 0.0)
			var topc := bt if face_lit else bt.darkened(0.12)
			draw_polygon(fin, Proc.grad_fill(fin, topc, bb))
			# a soft rim highlight along the leading edge
			var rim := Proc.smooth_loop(PackedVector2Array([
				Vector2(side * bw * 0.35, fy),
				Vector2(fx * 0.7, fy * 0.55),
				Vector2(fx, -flare * 0.08),
				Vector2(footx, -2.0)]), 7)
			var rc := (bt.lightened(0.18) if face_lit else bb)
			draw_polyline(rim, rc, maxf(1.5, bw * 0.03), true)

	func _draw_trunk(tl: float, bw: float, tw: float, flare: float, light: Vector2) -> void:
		var cfg := _heart.cfg
		var curve := float(cfg.curve) * (1.0 if Proc.hashf(_heart.seedv, "tc") < 0.5 else -1.0)
		var n := 16
		var a := Vector2.ZERO
		var tip := Vector2(0, -tl)
		var ctrl := Vector2(curve * tl, -tl * 0.5)
		var spine := []
		spine.resize(n)
		for i in n:
			spine[i] = ProcHeartTree._quad(a, ctrl, tip, float(i) / float(n - 1))
		var L := PackedVector2Array()
		var R := PackedVector2Array()
		L.resize(n); R.resize(n)
		for i in n:
			var tt := float(i) / float(n - 1)
			# base width + buttress swell near the ground (strong, smooth)
			var w := lerpf(bw, tw, smoothstep(0.0, 1.0, tt)) * 0.5
			w += flare * 0.5 * pow(maxf(0.0, 1.0 - tt * 3.2), 2.2)
			# subtle organic bulges up the trunk
			w *= 1.0 + 0.05 * sin(tt * 7.0 + _heart._wind_seed)
			var pprev: Vector2 = spine[maxi(i - 1, 0)]
			var pnext: Vector2 = spine[mini(i + 1, n - 1)]
			var tangent := (pnext - pprev)
			if tangent.length() < 0.001:
				tangent = Vector2(0, -1)
			tangent = tangent.normalized()
			var normal := Vector2(-tangent.y, tangent.x)
			L[i] = spine[i] + normal * w
			R[i] = spine[i] - normal * w
		var poly := PackedVector2Array()
		poly.append_array(L)
		for i in n:
			poly.append(R[n - 1 - i])
		var bt: Color = cfg.bark_top
		var bb: Color = cfg.bark_bot
		draw_polygon(poly, Proc.grad_fill(poly, bt, bb))

		# a shaded side + lit side to give the trunk volume
		var lit_left := light.x < 0.0
		var shade := PackedVector2Array()
		var src := L if lit_left else R
		for i in n:
			shade.append(src[i])
		for i in n:
			var tt := float(i) / float(n - 1)
			var w := lerpf(bw, tw, tt) * 0.5 * 0.42
			w += flare * 0.5 * pow(maxf(0.0, 1.0 - tt * 3.2), 2.2) * 0.42
			var s: Vector2 = spine[n - 1 - i]
			shade.append(s + Vector2((-w if lit_left else w), 0))
		draw_colored_polygon(shade, Color(0, 0, 0, 0.12))

		# flowing bark seams
		var seamc := bb.darkened(0.2)
		for k in 3:
			var seam := PackedVector2Array()
			var xoff := Proc.rangef(_heart.seedv, "seam%d" % k, -0.35, 0.35)
			for i in n:
				var tt := float(i) / float(n - 1)
				var w := lerpf(bw, tw, tt) * 0.5
				w += flare * 0.5 * pow(maxf(0.0, 1.0 - tt * 3.2), 2.2)
				seam.append(spine[i] + Vector2(xoff * w * (1.0 - tt * 0.4) + sin(tt * 9.0 + k) * w * 0.12, 0))
			draw_polyline(seam, seamc, maxf(1.0, bw * 0.02), true)

		# a mouth-of-light hollow in the heartwood for mature trees
		if _heart.g() > 0.6:
			var hc := Vector2(curve * tl * 0.2, -tl * 0.33)
			var hr := bw * 0.22
			var hollow := Proc.superellipse(hr * 0.7, hr, 2.2, 22)
			var gc: Color = cfg.glow_c
			gc.a = 0.5
			draw_colored_polygon(ProcHeartTree._scaletr(hollow, 1.0, hc), gc)
			gc.a = 0.85
			draw_colored_polygon(ProcHeartTree._scaletr(hollow, 0.5, hc), gc.lightened(0.3))

	# the tender glowing-sapling stage (growth < ~0.2)
	func _draw_sapling(tl: float, bw: float, gv: float, light: Vector2) -> void:
		var cfg := _heart.cfg
		var h := tl * 1.4                       # the sapling is slim & tall-ish for its scale
		var w := maxf(2.0, bw * 0.5)
		var stem := PackedVector2Array([
			Vector2(-w * 0.5, 0),
			Vector2(-w * 0.3, -h * 0.5),
			Vector2(-w * 0.18, -h),
			Vector2(w * 0.18, -h),
			Vector2(w * 0.3, -h * 0.5),
			Vector2(w * 0.5, 0)])
		stem = Proc.smooth_loop(stem, 7)
		draw_polygon(stem, Proc.grad_fill(stem, cfg.bark_top.lightened(0.1), cfg.bark_bot))

		# a little heart of light cradled at the top
		var crown := Vector2(0, -h)
		var hr := maxf(6.0, h * 0.4)
		var heart := ProcHeartTree._heart_shape(hr)
		var gc: Color = cfg.glow_c
		var hot: Color = cfg.hot_c
		for layer in 3:
			var f := float(layer) / 2.0
			var c := gc.lerp(hot, 1.0 - f)
			c.a = 0.35 + 0.3 * (1.0 - f)
			draw_colored_polygon(ProcHeartTree._scaletr(heart, 1.0 - f * 0.45, crown), c)
		# two first leaves
		for s in [-1.0, 1.0]:
			var leaf := PackedVector2Array([
				crown,
				crown + Vector2(s * hr * 0.6, -hr * 0.4),
				crown + Vector2(s * hr * 1.1, -hr * 0.1),
				crown + Vector2(s * hr * 0.7, hr * 0.25),
				crown + Vector2(s * hr * 0.2, hr * 0.1)])
			leaf = Proc.smooth_loop(leaf, 7)
			draw_polygon(leaf, Proc.grad_fill(leaf, cfg.leaf_top, cfg.leaf_bot))


# ===========================================================================
# _Bough — one limb of the sweeping branch system (and the invisible trunk-
# mount at depth 0). Draws its tapered limb + any glowing foliage masses.
# ===========================================================================
class _Bough extends Node2D:
	var _heart: _Heart = null
	var cfg := {}
	var depth := 0
	var grow_in := 0.0
	var full_length := 100.0
	var base_w := 10.0
	var tip_w := 6.0
	var curve := 0.05
	var rest_angle := 0.0
	var mount := 0.8                 # fraction up the parent it springs from
	var is_tip := false
	var is_trunk := false
	var bears_canopy := false
	var sway_k := 0.02
	var _bp := 0.0

	var current_length := 0.0
	var kids: Array = []
	var clumps: Array = []
	var dots: Array = []

	func _appear() -> float:
		if depth == 0:
			return 1.0
		return smoothstep(grow_in, grow_in + 0.28, _heart.g())

	func _update_dims() -> void:
		var gs := _heart._global_size
		var af := _appear()
		current_length = full_length * gs * (0.25 + 0.75 * af)
		visible = depth == 0 or af > 0.004
		queue_redraw()

	func _draw() -> void:
		if _heart == null or cfg.is_empty() or is_trunk:
			return
		var gs := _heart._global_size
		var af := _appear()
		var cl := current_length
		if cl <= 1.0:
			return
		var bw := base_w * gs * af
		var tw := tip_w * gs * af
		_draw_limb(cl, bw, tw)
		if bears_canopy:
			_draw_foliage(gs, af)

	func _draw_limb(cl: float, bw: float, tw: float) -> void:
		var n := 10
		var a := Vector2.ZERO
		var tip := Vector2(0, -cl)
		var ctrl := Vector2(curve * cl, -cl * 0.5)
		var spine := []
		spine.resize(n)
		for i in n:
			spine[i] = ProcHeartTree._quad(a, ctrl, tip, float(i) / float(n - 1))
		var L := PackedVector2Array()
		var R := PackedVector2Array()
		L.resize(n); R.resize(n)
		for i in n:
			var tt := float(i) / float(n - 1)
			var w := lerpf(bw, tw, tt) * 0.5
			var pprev: Vector2 = spine[maxi(i - 1, 0)]
			var pnext: Vector2 = spine[mini(i + 1, n - 1)]
			var tangent := (pnext - pprev)
			if tangent.length() < 0.001:
				tangent = Vector2(0, -1)
			tangent = tangent.normalized()
			var normal := Vector2(-tangent.y, tangent.x)
			L[i] = spine[i] + normal * w
			R[i] = spine[i] - normal * w
		var poly := PackedVector2Array()
		poly.append_array(L)
		for i in n:
			poly.append(R[n - 1 - i])
		draw_polygon(poly, Proc.grad_fill(poly, cfg.bark_top, cfg.bark_bot))
		if bw > 3.0:
			var edge := PackedVector2Array()
			edge.append_array(poly)
			edge.append(poly[0])
			draw_polyline(edge, cfg.bark_bot.darkened(0.25), maxf(1.0, bw * 0.05), true)

	# glowing, layered foliage masses at the limb tip
	func _draw_foliage(gs: float, af: float) -> void:
		var tip := Vector2(0, -current_length)
		var radius: float = full_length * float(cfg.canopy_scale) * gs * af
		if radius < 4.0:
			return
		var top: Color = cfg.leaf_top
		var mid: Color = cfg.leaf_mid
		var bot: Color = cfg.leaf_bot
		var under: Color = cfg.leaf_under
		var light: Vector2 = cfg.light
		for clump in clumps:
			var cr := radius * float(clump.r)
			var off := tip + Vector2(clump.off) * radius
			var base: PackedVector2Array = clump.pts
			# under-shadow
			var u := ProcHeartTree._scaletr(base, cr * 1.05, off + Vector2(0, cr * 0.12))
			draw_colored_polygon(u, under)
			# main gradient body
			var ctop := top if bool(clump.lit) else mid
			var m := ProcHeartTree._scaletr(base, cr, off)
			draw_polygon(m, Proc.grad_fill(m, ctop, bot))
			# highlight toward the light
			var hl := ProcHeartTree._scaletr(base, cr * 0.55, off - light * cr * 0.34)
			draw_colored_polygon(hl, top.lightened(0.2))
		# glowing leaf-dots (little lights nestled in the foliage)
		var gc: Color = cfg.glow_c
		for d in dots:
			var p := tip + Vector2(d) * radius
			var dc := gc
			dc.a = 0.5
			draw_circle(p, radius * 0.07, dc)
			dc.a = 0.9
			draw_circle(p, radius * 0.03, gc.lightened(0.3))


# ===========================================================================
# _Shimmer — a translucent living haze of light over the whole crown
# (GPU shader). Redraws only when the crown's size/position changes (growth).
# ===========================================================================
class _Shimmer extends Node2D:
	var _heart: _Heart = null

	func _draw() -> void:
		if _heart == null or _heart.cfg.is_empty():
			return
		var gv := _heart.g()
		if gv < 0.16:
			return
		var cfg := _heart.cfg
		var gs := _heart._global_size
		var tl := float(cfg.trunk_len) * gs
		# crown centre + radius grow with the tree
		var cy := -tl * float(cfg.crown_lift)
		var cr := _heart.footprint_radius * gs * 1.05
		if cr < 8.0:
			return
		var center := Vector2(0, cy)
		var blob := Proc.blob(_heart.seedv, "shimmer", cr, 11, 0.22)
		var pts := ProcHeartTree._scaletr(blob, 1.0, center)
		var uvs := ProcHeartTree._radial_uv(pts, center, cr)
		var cols := ProcHeartTree._flat(pts.size(), Color.WHITE)
		draw_polygon(pts, cols, uvs)


# ===========================================================================
# _TrunkVeins — inner veins of light under the bark (GPU shader), drawn behind
# the solid body so it reads as luminance glowing out through the trunk.
# ===========================================================================
class _TrunkVeins extends Node2D:
	var _heart: _Heart = null

	func _draw() -> void:
		if _heart == null or _heart.cfg.is_empty():
			return
		var gv := _heart.g()
		if gv < 0.2:
			return
		var cfg := _heart.cfg
		var gs := _heart._global_size
		var tl := float(cfg.trunk_len) * gs
		var bw := float(cfg.trunk_base_w) * gs
		var flare := float(cfg.buttress_flare) * gs * smoothstep(0.1, 0.7, gv)
		var halfw := bw * 0.5 + flare * 0.35
		# a rectangle tightly bounding the trunk; the shader paints veins within
		var rect := PackedVector2Array([
			Vector2(-halfw, 0),
			Vector2(halfw, 0),
			Vector2(halfw, -tl),
			Vector2(-halfw, -tl)])
		var uvs := PackedVector2Array([
			Vector2(0, 1), Vector2(1, 1), Vector2(1, 0), Vector2(0, 0)])
		var cols := ProcHeartTree._flat(4, Color.WHITE)
		draw_polygon(rect, cols, uvs)


# ===========================================================================
# _RayField — soft god-rays raking down out of the crown (GPU shader on a quad).
# Static geometry; all motion lives in the shader + the u_intensity uniform.
# ===========================================================================
class _RayField extends Node2D:
	var _heart: _Heart = null

	func _draw() -> void:
		if _heart == null or _heart.cfg.is_empty():
			return
		var gs := _heart._global_size
		var tl := float(_heart.cfg.trunk_len) * gs
		var w := _heart.footprint_radius * gs * 2.6
		var top := -tl * 1.35
		var bot := 40.0
		var rect := PackedVector2Array([
			Vector2(-w * 0.5, top),
			Vector2(w * 0.5, top),
			Vector2(w * 0.5, bot),
			Vector2(-w * 0.5, bot)])
		var uvs := PackedVector2Array([
			Vector2(0, 0), Vector2(1, 0), Vector2(1, 1), Vector2(0, 1)])
		var cols := ProcHeartTree._flat(4, Color.WHITE)
		draw_polygon(rect, cols, uvs)


# ===========================================================================
# _Mote — one drifting light mote. Draws a soft glow once; the parent moves &
# fades it every frame via cheap transform + self_modulate (no per-frame redraw).
# ===========================================================================
class _Mote extends Node2D:
	var base_col := Color(1, 1, 1, 0)
	var orbit := Vector2(120, 100)
	var center := Vector2(0, -0.6)     # fraction of trunk_len (x), fraction (y)
	var sp := 0.15
	var ph := 0.0
	var ph2 := 0.0
	var rad := 4.0

	func _build() -> void:
		# a static soft radial glow (two discs); recoloured/moved by transform only
		z_index = 1
		queue_redraw()

	func _draw() -> void:
		var c := base_col
		c.a = 0.4
		draw_circle(Vector2.ZERO, rad * 2.0, c)
		c.a = 0.9
		draw_circle(Vector2.ZERO, rad, Color(c.r, c.g, c.b, 1.0).lightened(0.2))

	func tick(t: float, mg: float, gs: float, fm: float) -> void:
		if mg <= 0.001:
			self_modulate.a = 0.0
			return
		var ox := center.x * 520.0        # map fraction to world-ish units
		var oy := center.y * 540.0
		var x := ox + sin(t * sp + ph) * orbit.x
		var y := oy + cos(t * sp * 0.8 + ph2) * orbit.y - t * 0.0   # gentle hover
		# slow vertical bob so motes seem to rise and settle in the light
		y += sin(t * 0.3 + ph) * orbit.y * 0.12
		position = Vector2(x, y) * gs
		var tw := 0.45 + 0.55 * (0.5 + 0.5 * sin(t * 1.3 + ph2 * 2.0))
		var sc := gs * (0.7 + 0.5 * tw)
		scale = Vector2(sc, sc)
		self_modulate.a = mg * tw * fm
