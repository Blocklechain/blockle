class_name PlaceholderArt
extends RefCounted

# Hand-made-looking PROGRAMMATIC placeholder art. No emoji, no imported images:
# every entity is drawn from simple storybook shapes (circles, polygons, soft
# shadows) using the "shape" + "palette" each entity carries in data. A single
# inner _Painter node does all the custom _draw work so the rest of the game can
# treat art as plain Node2Ds it positions and animates. The look is deliberately
# soft and crayon-like so it reads as "friendly stand-in", never final art.

const DEFAULT_PAL := ["#86C06C", "#C9E8B0", "#C9955B"]

# ---- public builders --------------------------------------------------------

# A floating realm sky: a soft vertical gradient from the realm's sky[] stops,
# plus a glow orb (sun/moon) tinted by the realm accent. Caller sizes it.
# Load hand-painted art from res://art/... when present, else null (caller falls
# back to the programmatic placeholder). Sprites anchor bottom-centre at the
# origin (matching the painter's feet-at-origin convention); backgrounds fill
# `target` from the top-left.
static func _real_art(path: String, target: Vector2, bg: bool) -> Node2D:
	if not ResourceLoader.exists(path):
		return null
	var tex = load(path)
	if tex == null or not (tex is Texture2D):
		return null
	var ts: Vector2 = tex.get_size()
	if ts.x <= 0.0 or ts.y <= 0.0:
		return null
	var s := Sprite2D.new()
	s.texture = tex
	s.centered = false
	if bg:
		s.position = Vector2.ZERO
		s.scale = Vector2(target.x / ts.x, target.y / ts.y)
	else:
		var k: float = target.y / ts.y
		s.scale = Vector2(k, k)
		s.offset = Vector2(-ts.x / 2.0, -ts.y)
	return s

static func _has_real_art() -> bool:
	return ResourceLoader.exists("res://art/buildings/heart_tree.png")

static func realm_sky(size: Vector2, realm_def: Dictionary) -> Node2D:
	var rid: String = realm_def.get("id", "")
	var rv := WorldGen.realm_bg_variant(rid)
	var art := _real_art(_variant_path("realms", rid + "_bg", rv), size, true)
	if art == null and rv > 1:
		art = _real_art(_variant_path("realms", rid + "_bg", 1), size, true)
	if art != null:
		return art
	var p := _Painter.new()
	p.kind = "sky"
	p.dims = size
	p.cols = _pal(realm_def.get("sky", ["#8FD3C4", "#D9F2E6", "#FBF6E9"]))
	p.accent = _col(realm_def.get("accent", "#FFC978"))
	return p

static func build_heart_tree(def: Dictionary) -> Node2D:
	var id: String = def.get("id", "heart_tree")
	var bv := WorldGen.building_variant(id)
	var art := _real_art(_variant_path("buildings", id, bv), Vector2(360, 460), false)
	if art == null and bv > 1:
		art = _real_art(_variant_path("buildings", id, 1), Vector2(360, 460), false)
	if art != null:
		return art
	var p := _Painter.new()
	p.kind = "tree"
	p.shape = "tree"
	p.cols = _pal(def.get("art", {}).get("palette", DEFAULT_PAL))
	p.dims = Vector2(360, 460)
	return p

static func build_building(def: Dictionary) -> Node2D:
	var id: String = def.get("id", "")
	var bv := WorldGen.building_variant(id)
	var art := _real_art(_variant_path("buildings", id, bv), Vector2(132, 132), false)
	if art == null and bv > 1:
		art = _real_art(_variant_path("buildings", id, 1), Vector2(132, 132), false)
	if art != null:
		return art
	var p := _Painter.new()
	p.kind = "building"
	p.shape = def.get("art", {}).get("shape", "homes")
	p.cols = _pal(def.get("art", {}).get("palette", DEFAULT_PAL))
	p.dims = Vector2(132, 132)
	return p

static func build_blockling(def: Dictionary) -> Node2D:
	var art := _real_art("res://art/blocklings/%s.png" % def.get("id", ""), Vector2(64, 64), false)
	if art != null:
		return art
	var p := _Painter.new()
	p.kind = "blockling"
	p.shape = def.get("shape", "sprout")
	p.cols = _pal(def.get("palette", ["#86C06C", "#3F6B3A"]))
	p.dims = Vector2(64, 64)
	return p

# One Blockling INDIVIDUAL: the species base + its hand-painted trait stack
# (hue wash, marking, accessory, aura) + size/flip, keyed by uid via Traits.
# This is what makes the roster space millions of distinct creatures. Overlays
# load from res://art/traits/... when present and are skipped otherwise, so it
# degrades cleanly before the overlay art exists.
static func build_blockling_individual(def: Dictionary, uid: String) -> Node2D:
	var t: Dictionary = Traits.traits_for(uid)
	var id: String = def.get("id", "")
	var root := Node2D.new()
	# wings + tail go BEHIND the body (added first).
	_overlay_v(root, "traits/wings", t["wings"], t["wings_variant"], Vector2(0, -32), 98.0, Color.WHITE)
	_overlay_v(root, "traits/tails", t["tail"], t["tail_variant"], Vector2(0, -14), 46.0, Color.WHITE)
	# species base, using one of its painted variants, hue-washed.
	var base := _real_art(_variant_path("blocklings", id, int(t["species_variant"])), Vector2(64, 64), false)
	if base == null:
		base = build_blockling(def)   # falls back to variant 1 / the painter
	base.modulate = t["hue"]
	root.add_child(base)
	# front layers.
	_overlay_v(root, "traits/markings", t["marking"], t["marking_variant"], Vector2(0, -34), 56.0, t["hue"])
	_overlay_v(root, "traits/accessories", t["accessory"], t["accessory_variant"], Vector2(0, -50), 46.0, Color.WHITE)
	_overlay_v(root, "traits/hats", t["hat"], t["hat_variant"], Vector2(0, -58), 50.0, Color.WHITE)
	_overlay_v(root, "traits/auras", t["aura"], t["aura_variant"], Vector2(0, -34), 94.0, Color.WHITE)
	var k: float = t["size"]
	root.scale = Vector2(k * (-1.0 if t["flip"] else 1.0), k)
	return root

# Path for a painted variant: variant 1 is the base name, 2+ get a _vN suffix.
static func _variant_path(folder: String, name: String, v: int) -> String:
	if v <= 1:
		return "res://art/%s/%s.png" % [folder, name]
	return "res://art/%s/%s_v%d.png" % [folder, name, v]

# Overlay a named trait layer (skipping "none"), honouring its painted variant.
static func _overlay_v(root: Node2D, folder: String, name: String, variant: int, at: Vector2, target_w: float, tint: Color) -> void:
	if name == "" or name == "none":
		return
	var path := _variant_path(folder, name, variant)
	if not ResourceLoader.exists(path):   # fall back to the base variant if that one isn't painted yet
		path = _variant_path(folder, name, 1)
	_overlay(root, path, at, target_w, tint)

# One hand-painted island decoration (bottom-anchored), or a small procedural
# mound before its art exists.
static func build_decoration(type: String, variant: int) -> Node2D:
	var art := _real_art("res://art/decorations/%s_%02d.png" % [type, variant], Vector2(60, 60), false)
	if art != null:
		return art
	var n := Node2D.new()
	var dot := Polygon2D.new()
	var pts := PackedVector2Array()
	for i in range(12):
		var a := TAU * i / 12.0
		pts.append(Vector2(cos(a), sin(a)) * 13.0)
	dot.polygon = pts
	dot.color = Color("#6FA86B")
	dot.position = Vector2(0, -11)
	n.add_child(dot)
	return n

static func _overlay(root: Node2D, path: String, at: Vector2, target_w: float, tint: Color) -> void:
	if not ResourceLoader.exists(path):
		return
	var tex = load(path)
	if tex == null or not (tex is Texture2D):
		return
	var s := Sprite2D.new()
	s.texture = tex
	var tw: float = tex.get_size().x
	s.scale = Vector2(target_w / tw, target_w / tw) if tw > 0.0 else Vector2.ONE
	s.position = at
	s.modulate = tint
	root.add_child(s)

# The subtle corner stamp so placeholder art is never mistaken for final art.
# Vanishes automatically once real hand-painted art is present.
static func placeholder_label() -> Node2D:
	var p := _Painter.new()
	p.kind = "none" if _has_real_art() else "stamp"
	return p

# ---- helpers ----------------------------------------------------------------

static func _col(hex) -> Color:
	if hex is Color:
		return hex
	return Color(String(hex))

static func _pal(arr) -> Array:
	var out: Array = []
	if arr is Array:
		for c in arr:
			out.append(_col(c))
	if out.is_empty():
		out = [Color("#86C06C"), Color("#C9E8B0"), Color("#C9955B")]
	while out.size() < 3:
		out.append(out[out.size() - 1].lightened(0.2))
	return out


# =============================================================================
# The painter: one CanvasItem that renders any entity kind from its stored data.
# =============================================================================
class _Painter extends Node2D:
	var kind := "blockling"
	var shape := "sprout"
	var cols: Array = [Color("#86C06C"), Color("#C9E8B0"), Color("#C9955B")]
	var accent := Color("#FFC978")
	var dims := Vector2(64, 64)

	func _draw() -> void:
		match kind:
			"sky": _draw_sky()
			"tree": _draw_tree()
			"building": _draw_building()
			"blockling": _draw_creature()
			"stamp": _draw_stamp()

	# -- shared primitives ----------------------------------------------------

	func _shadow(center: Vector2, rx: float, ry: float) -> void:
		# Soft contact shadow under a standing thing.
		draw_set_transform(center, 0.0, Vector2(1, ry / rx))
		draw_circle(Vector2.ZERO, rx, Color(0, 0, 0, 0.14))
		draw_set_transform(Vector2.ZERO, 0.0, Vector2.ONE)

	func _rounded(center: Vector2, half: Vector2, col: Color, r: float) -> void:
		# A rounded rectangle from one rect + four corner circles. Cheap + soft.
		draw_rect(Rect2(center - Vector2(half.x, half.y - r), Vector2(half.x * 2, (half.y - r) * 2)), col)
		draw_rect(Rect2(center - Vector2(half.x - r, half.y), Vector2((half.x - r) * 2, half.y * 2)), col)
		draw_circle(center + Vector2(-half.x + r, -half.y + r), r, col)
		draw_circle(center + Vector2(half.x - r, -half.y + r), r, col)
		draw_circle(center + Vector2(-half.x + r, half.y - r), r, col)
		draw_circle(center + Vector2(half.x - r, half.y - r), r, col)

	func _tri(a: Vector2, b: Vector2, c: Vector2, col: Color) -> void:
		draw_colored_polygon(PackedVector2Array([a, b, c]), col)

	func _eyes(cx: float, cy: float, spread: float, r: float) -> void:
		for s in [-1.0, 1.0]:
			draw_circle(Vector2(cx + spread * s, cy), r, Color("#2A241E"))
			draw_circle(Vector2(cx + spread * s - r * 0.3, cy - r * 0.3), r * 0.35, Color(1, 1, 1, 0.9))

	# -- sky ------------------------------------------------------------------

	func _draw_sky() -> void:
		var w := dims.x
		var h := dims.y
		var top: Color = cols[0]
		var mid: Color = cols[1] if cols.size() > 1 else cols[0]
		var bot: Color = cols[2] if cols.size() > 2 else mid
		# Two vertically-interpolated quads = a smooth 3-stop gradient, drawn with
		# per-vertex colours so there is zero per-frame cost.
		var midY := h * 0.55
		_grad_quad(Vector2(0, 0), Vector2(w, midY), top, mid)
		_grad_quad(Vector2(0, midY), Vector2(w, h), mid, bot)
		# A soft glow orb high in the sky.
		var orb := Vector2(w * 0.76, h * 0.2)
		for i in range(4, 0, -1):
			draw_circle(orb, 26.0 + i * 10.0, Color(accent.r, accent.g, accent.b, 0.06))
		draw_circle(orb, 26.0, Color(accent.r, accent.g, accent.b, 0.9))

	func _grad_quad(a: Vector2, b: Vector2, top: Color, bottom: Color) -> void:
		var pts := PackedVector2Array([
			Vector2(a.x, a.y), Vector2(b.x, a.y), Vector2(b.x, b.y), Vector2(a.x, b.y)])
		var vc := PackedColorArray([top, top, bottom, bottom])
		draw_polygon(pts, vc)

	# -- heart tree -----------------------------------------------------------

	func _draw_tree() -> void:
		var leaf: Color = cols[0]
		var leaf_hi: Color = cols[1]
		var bark: Color = cols[2]
		_shadow(Vector2(0, 0), 120, 34)
		# Roots first (separate simple triangles so nothing self-intersects).
		_tri(Vector2(-54, 8), Vector2(-24, -6), Vector2(-18, 8), bark.darkened(0.12))
		_tri(Vector2(54, 8), Vector2(24, -6), Vector2(18, 8), bark.darkened(0.12))
		# Trunk: a single simple tapered quad.
		var trunk := PackedVector2Array([
			Vector2(-36, 6), Vector2(-22, -170), Vector2(22, -170), Vector2(36, 6)])
		draw_colored_polygon(trunk, bark)
		draw_line(Vector2(0, -20), Vector2(0, -150), bark.darkened(0.25), 4.0)
		# Canopy: overlapping soft blobs, darker base + lighter highlight.
		var blobs := [
			Vector2(0, -250), Vector2(-90, -210), Vector2(90, -210),
			Vector2(-55, -300), Vector2(55, -300), Vector2(0, -340)]
		for b in blobs:
			draw_circle(b, 86, leaf.darkened(0.12))
		for b in blobs:
			draw_circle(b + Vector2(-14, -16), 54, leaf)
			draw_circle(b + Vector2(10, -28), 26, leaf_hi.lightened(0.05))
		# A few hanging motes of magic.
		for m in [Vector2(-70, -180), Vector2(64, -160), Vector2(0, -150), Vector2(-20, -120)]:
			draw_circle(m, 5, Color(leaf_hi.r, leaf_hi.g, leaf_hi.b, 0.9))

	# -- buildings ------------------------------------------------------------

	func _draw_building() -> void:
		var body: Color = cols[0]
		var roof: Color = cols[1]
		var trim: Color = cols[2]
		_shadow(Vector2(0, 0), 60, 18)
		match shape:
			"grove":
				# A cluster of tended trees.
				for off in [Vector2(-34, 0), Vector2(0, -4), Vector2(34, 0)]:
					draw_rect(Rect2(off + Vector2(-5, -40), Vector2(10, 40)), trim)
					draw_circle(off + Vector2(0, -52), 30, body)
					draw_circle(off + Vector2(-8, -60), 16, roof)
			"quarry":
				# Stepped stone pit.
				for i in range(3):
					var w := 96 - i * 24
					draw_rect(Rect2(Vector2(-w / 2.0, -20 - i * 22), Vector2(w, 22)), body.darkened(i * 0.08))
				draw_circle(Vector2(18, -30), 10, trim)
				draw_circle(Vector2(-14, -52), 8, trim)
			"mine":
				# Hillside with a timber-framed entrance + crystal glow.
				_tri(Vector2(-64, 2), Vector2(0, -78), Vector2(64, 2), body)
				draw_rect(Rect2(Vector2(-20, -44), Vector2(40, 46)), trim.darkened(0.3))
				draw_rect(Rect2(Vector2(-24, -48), Vector2(48, 8)), trim)
				draw_circle(Vector2(0, -22), 10, roof.lightened(0.1))
			"garden":
				# Terraced flower beds.
				for i in range(3):
					draw_rect(Rect2(Vector2(-54 + i * 6, -14 - i * 20), Vector2(108 - i * 12, 16)), trim.lightened(0.1 * i))
				for fx in [-36, -12, 12, 36]:
					draw_circle(Vector2(fx, -58), 7, roof)
					draw_circle(Vector2(fx + 6, -64), 5, body.lightened(0.3))
			"homes":
				# Two round cottages with warm windows.
				for off in [Vector2(-28, 0), Vector2(30, -6)]:
					draw_circle(off + Vector2(0, -26), 28, body)
					_tri(off + Vector2(-30, -40), off + Vector2(0, -74), off + Vector2(30, -40), roof)
					draw_circle(off + Vector2(0, -24), 7, Color("#FFE8A8"))
			"library":
				_building_hall(body, roof, trim)
				# book-spine stripes
				for i in range(5):
					draw_rect(Rect2(Vector2(-42 + i * 18, -48), Vector2(10, 40)), trim.lightened(0.08 * i))
			"lodge":
				# A-frame cabin.
				_tri(Vector2(-58, 2), Vector2(0, -84), Vector2(58, 2), roof)
				_tri(Vector2(-40, 2), Vector2(0, -60), Vector2(40, 2), body)
				draw_rect(Rect2(Vector2(-10, -34), Vector2(20, 36)), trim.darkened(0.2))
			"observatory":
				# Tower with a dome + lens.
				draw_rect(Rect2(Vector2(-26, -70), Vector2(52, 72)), body)
				draw_circle(Vector2(0, -70), 30, roof)
				draw_line(Vector2(0, -70), Vector2(34, -104), trim, 7.0)
				draw_circle(Vector2(34, -104), 8, accent_or(trim))
			"temple":
				# Columned shrine with a pediment.
				draw_rect(Rect2(Vector2(-56, -16), Vector2(112, 16)), trim)
				for cx in [-44, -22, 0, 22, 44]:
					draw_rect(Rect2(Vector2(cx - 5, -58), Vector2(10, 44)), body)
				_tri(Vector2(-62, -58), Vector2(0, -92), Vector2(62, -58), roof)
			_:
				_building_hall(body, roof, trim)

	func _building_hall(body: Color, roof: Color, trim: Color) -> void:
		draw_rect(Rect2(Vector2(-48, -60), Vector2(96, 60)), body)
		_tri(Vector2(-58, -58), Vector2(0, -98), Vector2(58, -58), roof)
		draw_rect(Rect2(Vector2(-14, -34), Vector2(28, 34)), trim.darkened(0.25))

	func accent_or(fallback: Color) -> Color:
		return Color("#FFF4D6")

	# -- creatures ------------------------------------------------------------

	func _draw_creature() -> void:
		var body: Color = cols[0]
		var belly: Color = cols[1]
		_shadow(Vector2(0, 2), 22, 7)
		match shape:
			"bird", "breeze":
				draw_circle(Vector2(0, -20), 18, body)
				_tri(Vector2(-18, -22), Vector2(-40, -14), Vector2(-16, -8), body.darkened(0.1))
				_tri(Vector2(18, -22), Vector2(40, -14), Vector2(16, -8), body.darkened(0.1))
				_tri(Vector2(14, -20), Vector2(30, -18), Vector2(14, -12), belly) # beak
				_eyes(0, -24, 6, 3)
			"moth":
				for s in [-1.0, 1.0]:
					draw_colored_polygon(PackedVector2Array([
						Vector2(0, -18), Vector2(28 * s, -30), Vector2(30 * s, -6), Vector2(0, -8)]), belly)
				draw_circle(Vector2(0, -18), 12, body)
				_eyes(0, -20, 4, 2.5)
			"turtle":
				draw_circle(Vector2(0, -14), 20, belly) # shell dome
				draw_circle(Vector2(0, -14), 20, body.darkened(0.05)) # outline-ish
				draw_circle(Vector2(0, -16), 16, body)
				draw_circle(Vector2(18, -10), 8, belly) # head
				_eyes(20, -11, 3, 2)
			"frog":
				_rounded(Vector2(0, -12), Vector2(20, 14), body, 10)
				for s in [-1.0, 1.0]:
					draw_circle(Vector2(10 * s, -26), 7, belly)
					draw_circle(Vector2(10 * s, -26), 3, Color("#2A241E"))
				draw_arc(Vector2(0, -8), 12, 0.2, PI - 0.2, 10, belly.darkened(0.3), 2.0)
			"cat", "fox", "mooncat":
				_rounded(Vector2(0, -14), Vector2(16, 16), body, 9)
				_tri(Vector2(-16, -24), Vector2(-20, -40), Vector2(-4, -28), body)
				_tri(Vector2(16, -24), Vector2(20, -40), Vector2(4, -28), body)
				draw_circle(Vector2(0, -8), 11, belly) # muzzle/chest
				_eyes(0, -16, 6, 3)
				if shape == "fox":
					_tri(Vector2(18, -6), Vector2(40, -14), Vector2(20, 2), body) # bushy tail
			"deer", "greatdeer":
				var sc := 1.0 if shape == "deer" else 1.25
				draw_set_transform(Vector2.ZERO, 0.0, Vector2(sc, sc))
				_rounded(Vector2(0, -16), Vector2(13, 18), body, 8)
				for s in [-1.0, 1.0]:
					draw_line(Vector2(6 * s, -32), Vector2(12 * s, -48), belly, 3)
					draw_line(Vector2(10 * s, -42), Vector2(18 * s, -46), belly, 3)
				_eyes(0, -18, 5, 2.5)
				draw_set_transform(Vector2.ZERO, 0.0, Vector2.ONE)
			"owlet":
				_rounded(Vector2(0, -16), Vector2(16, 18), body, 10)
				_tri(Vector2(-16, -30), Vector2(-10, -40), Vector2(-4, -30), body) # ear tuft
				_tri(Vector2(16, -30), Vector2(10, -40), Vector2(4, -30), body)
				for s in [-1.0, 1.0]:
					draw_circle(Vector2(7 * s, -18), 7, Color("#FFF4D6"))
					draw_circle(Vector2(7 * s, -18), 4, Color("#2A241E"))
				_tri(Vector2(-4, -14), Vector2(4, -14), Vector2(0, -8), belly)
			"golem", "pebble":
				_rounded(Vector2(0, -14), Vector2(18, 16), body, 6)
				draw_rect(Rect2(Vector2(-18, -6), Vector2(8, 10)), body.darkened(0.15))
				draw_rect(Rect2(Vector2(10, -6), Vector2(8, 10)), body.darkened(0.15))
				draw_circle(Vector2(-2, -18), 7, belly)
				_eyes(0, -16, 6, 2.5)
			"mole":
				_rounded(Vector2(0, -12), Vector2(16, 13), body, 9)
				_tri(Vector2(-18, -10), Vector2(-28, -8), Vector2(-16, -4), belly) # snout
				draw_circle(Vector2(-14, -14), 2, Color("#2A241E"))
			"stickbug":
				draw_line(Vector2(0, 0), Vector2(0, -34), body, 5)
				for yy in [-10, -20, -28]:
					draw_line(Vector2(0, yy), Vector2(-14, yy - 8), body, 2)
					draw_line(Vector2(0, yy), Vector2(14, yy - 8), body, 2)
				draw_circle(Vector2(0, -36), 7, belly)
				_eyes(0, -37, 3, 1.6)
			"star":
				_draw_star(Vector2(0, -20), 20, 9, body)
				_eyes(0, -20, 6, 2.6)
			"dragon":
				_rounded(Vector2(0, -16), Vector2(16, 16), body, 8)
				for s in [-1.0, 1.0]:
					draw_colored_polygon(PackedVector2Array([
						Vector2(6 * s, -20), Vector2(30 * s, -34), Vector2(26 * s, -10)]), belly)
					_tri(Vector2(6 * s, -30), Vector2(10 * s, -42), Vector2(2 * s, -30), body) # horn
				draw_circle(Vector2(0, -8), 9, belly)
				_eyes(0, -18, 6, 3)
			"sprout", "mossling", _:
				_rounded(Vector2(0, -12), Vector2(14, 14), body, 9)
				draw_line(Vector2(0, -22), Vector2(0, -34), belly.darkened(0.2), 3)
				_tri(Vector2(0, -30), Vector2(-12, -40), Vector2(0, -44), belly) # leaf
				_tri(Vector2(0, -30), Vector2(12, -40), Vector2(0, -44), belly.lightened(0.1))
				_eyes(0, -12, 5, 2.4)

	func _draw_star(c: Vector2, outer: float, inner: float, col: Color) -> void:
		var pts := PackedVector2Array()
		for i in range(10):
			var ang := -PI / 2 + i * PI / 5
			var r := outer if i % 2 == 0 else inner
			pts.append(c + Vector2(cos(ang), sin(ang)) * r)
		draw_colored_polygon(pts, col)

	# -- corner stamp ---------------------------------------------------------

	func _draw_stamp() -> void:
		var txt := "placeholder art"
		var font := ThemeDB.fallback_font
		var fs := 22
		var w := font.get_string_size(txt, HORIZONTAL_ALIGNMENT_LEFT, -1, fs).x
		draw_rect(Rect2(Vector2(-6, -20), Vector2(w + 14, 30)), Color(0, 0, 0, 0.22), true)
		draw_string(font, Vector2(2, 2), txt, HORIZONTAL_ALIGNMENT_LEFT, -1, fs, Color(1, 1, 1, 0.7))
