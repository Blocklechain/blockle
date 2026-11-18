class_name ProcDepth extends RefCounted
# ProcDepth — the pure-math DEPTH MODEL of the 2.5D upgrade (GFX-2.5D §1, §6, §7.1).
#
# The island keeps its authoritative front contour (`ProcTerrain._Island.surface_y`)
# as the d=0 edge; behind it the ground becomes a BAND with continuous depth
# d ∈ [0,1] (0 = front edge nearest the player, 1 = the horizon). This module is
# the single source of truth for how depth becomes screen-space, and the shared
# vocabulary every other graphics module speaks:
#
#   PROJECTION (§1.2)   depth_y / depth_scale / parallax — the only three formulas
#                       anyone may use — plus contour_flatten, project, band_snap
#                       and the exact inverse depth_from_lift (tap → depth).
#   SORTING (§1.3)      z_for / z_tiebreak / z_for_place / sort_key.
#   FOG (§1.4)          fog_mix / tint / tint_palette — baked into palettes ONCE
#                       at build/adapt time, never per frame — plus fog_modulate
#                       for nodes that can only be dressed by `modulate`.
#   ROWS + CTX (§1.5)   row_of / row_d / row_span / jitter_d / row_pick, the
#                       DepthCtx builder make_ctx, and the ctx_* readers every
#                       entity module uses to consume `context.depth` safely.
#   PLACEMENT (§1.6)    collides_depth / legacy_d / apply_depth / apply_place.
#   BANDS (§1.7)        band_of / band_parallax / band_z + make_plane(rate):
#                       the P-plane containers, one line of work per pan event.
#   LOD (§6)            lod_for plus the whole §6 drop table expressed as cheap
#                       statics (samples_for, detail_count, wants_rim, …) so ten
#                       entity modules cannot drift apart on what "LOD1" means.
#   GUARDS              poly_ok / poly_area / clean_poly / triangulable — the
#                       degenerate-polygon screen every _draw should run its
#                       generated outlines through (a <3-point, self-retracing,
#                       zero-area or SELF-CROSSING polygon silently kills the
#                       whole draw_polygon call: Godot logs "triangulation
#                       failed" and renders nothing at all).
#   SAFE GEOMETRY       safe_loop / ribbon_loop / safe_line / resample_ring:
#                       Catmull-Rom knots itself whenever control spacing is
#                       uneven, which is EXACTLY what a contour band (top
#                       contour left→right + bottom contour right→left) hands
#                       it at its two seams. These build the band properly —
#                       even out the ring, smooth, then verify with the very
#                       triangulator draw_polygon uses — so terrain, soil,
#                       grass, water, cliffs and canopy masses all fill.
#   COMPOSITION         make_islet_band(): the distant-islet skyline strip built
#                       from real ProcTerrain islets at d≈0.9, fog-tinted, each
#                       backed by a fully-modelled atmospheric island (wash,
#                       rock mass, keel volume, meadow cap, crest, bedding
#                       lines) that is guaranteed drawable, bobbing on desynced
#                       slow clocks (child transforms only, no redraws).
#
# Everything here is deterministic (Proc.hashf/rangef only — no Time, no randf),
# allocation-free per frame, and ADDITIVE: no existing public factory or API
# signature changes anywhere. Standalone use needs no context and no lighting.

# ---- §1.1 the ground band ----------------------------------------------------
const BAND_H := 340.0          # full front→back rise in px at the front row's scale
const SCALE_BACK := 0.55       # entity scale at d=1 (front = 1.0)
const ROWS := 5                # planting rows derived from d
const ROW_D: Array[float] = [0.04, 0.26, 0.50, 0.74, 0.96]   # row centre depths
const PARALLAX_BACK := 0.25    # camera-x multiplier at d=1 (front = 1.0)

# Perspective exponent: rows compress toward the back (ease-out foreshortening).
const _PERSP := 1.45
# The front contour flattens toward the horizon by this fraction (§1.2).
const CONTOUR_FLATTEN := 0.65
# Two records only collide when their depths are this close AND x overlaps (§1.6).
const DEPTH_COLLIDE := 0.18
# Row jitter half-range used by jitter_d (§1.5).
const ROW_JITTER := 0.06
# Fog ceiling at the back edge (§1.4) — the distance never fully erases a thing.
const FOG_MAX := 0.42

# §1.7 canonical plane parallax rates (back → front).
const PLANE_SKY := 0.06
const PLANE_FAR := 0.18        # P1 distant islets
const PLANE_BACK := 0.55       # P2 back band (rows 3–4)
const PLANE_HAZE := 0.65       # P3 mid haze
const PLANE_MID := 0.80        # P4 mid band (row 2)
const PLANE_FRONT := 1.0       # P5 front band (rows 0–1)
const PLANE_FG := 1.25         # P7 foreground framing (overshoots the camera)

# Band indices for band_of()/band_parallax()/band_z(): 0 front, 1 mid, 2 back.
const BAND_FRONT := 0
const BAND_MID := 1
const BAND_BACK := 2

# §6 LOD tiers, named so module code reads like the spec table.
const LOD_HERO := 0            # front / large: every material recipe, rim light, FX
const LOD_MID := 1             # reduced detail, pools only, half-rate animation
const LOD_FAR := 2             # silhouette + gradient, no shadow, breathing only

# The fallback horizon tint used when nobody has supplied a LightCtx yet: a pale
# daylight haze, so standalone instancing looks right with zero wiring.
const DEFAULT_HORIZON := Color(0.78, 0.86, 0.94)


# =============================================================================
# §1.2 PROJECTION — the only three formulas anyone may use
# =============================================================================

# Vertical lift of the ground under a thing at depth d (NEGATIVE = up-screen).
static func depth_y(d: float) -> float:
	var e := clampf(d, 0.0, 1.0)
	return -BAND_H * (1.0 - pow(1.0 - e, _PERSP))   # perspective: rows compress toward back


# Uniform scale applied to a thing's root node at depth d.
static func depth_scale(d: float) -> float:
	return lerpf(1.0, SCALE_BACK, clampf(d, 0.0, 1.0))


# Horizontal camera parallax multiplier for a thing (or band container) at depth d.
static func parallax(d: float) -> float:
	return lerpf(1.0, PARALLAX_BACK, clampf(d, 0.0, 1.0))


# How much of the front contour's relief survives at depth d (so the horizon
# reads straight): multiply surface_y(tx) by this before adding depth_y(d).
static func contour_flatten(d: float) -> float:
	return 1.0 - clampf(d, 0.0, 1.0) * CONTOUR_FLATTEN


# The full §1.2 placement projection, cam-local relative to the ground origin:
# a thing at terrain-x `tx` whose front-contour height is `surface_y_val` sits at
# this offset when planted at depth d.
static func project(tx: float, surface_y_val: float, d: float) -> Vector2:
	return Vector2(tx, surface_y_val * contour_flatten(d) + depth_y(d))


# Convenience for WorldSpace.snap_ground_band: the absolute cam-local snap point.
static func band_snap(ground_origin: Vector2, tx: float, surface_y_val: float, d: float) -> Vector2:
	return ground_origin + project(tx, surface_y_val, d)


# INVERSE projection: a tap `lift` px ABOVE the front contour (positive = up-screen)
# maps back to the depth whose depth_y equals that lift. Exact inverse of depth_y,
# so tapping the band and reading the depth back is lossless.
static func depth_from_lift(lift: float) -> float:
	var k := clampf(lift, 0.0, BAND_H) / BAND_H
	return clampf(1.0 - pow(1.0 - k, 1.0 / _PERSP), 0.0, 1.0)


# Positive-up lift of a depth (the mirror of depth_y, for code that thinks in
# "how far above the front edge is this row").
static func lift_of(d: float) -> float:
	return -depth_y(d)


# Screen y of the band's back edge (the horizon ground line) given the front
# ground origin's y. Atmosphere/silhouette layers anchor against this.
static func horizon_y(ground_origin_y: float) -> float:
	return ground_origin_y + depth_y(1.0)


# On-screen body height of a thing whose local body height is `body_h` once the
# depth scale is applied — the px_h that feeds the LOD decision.
static func px_h_at(body_h: float, d: float) -> float:
	return maxf(0.0, body_h) * depth_scale(d)


# =============================================================================
# §1.3 Y-SORT / Z-INDEX
# =============================================================================

static func z_for(d: float) -> int:
	return 1000 - int(round(clampf(d, 0.0, 1.0) * 1000.0))   # 0..1000, front-over-back


# Deterministic tie-break for two things on the same row (§1.3): a small negative
# nudge hashed from the place-id so draw order is stable across sessions.
static func z_tiebreak(seed: int, place_id: String) -> int:
	return -int(Proc.hashf(seed, "ztb:" + place_id) * 3.0)


# z_for + tie-break in one call — what WorldSpace.place() assigns.
static func z_for_place(d: float, seed: int, place_id: String) -> int:
	return z_for(d) + z_tiebreak(seed, place_id)


# A stable float sort key for ARRAYS of records (back first, then left-to-right).
# Depth dominates; tx only breaks ties inside a row. Use with Array.sort_custom
# when a module must emit several things from a single _draw in the right order.
static func sort_key(d: float, tx: float) -> float:
	return -clampf(d, 0.0, 1.0) * 100000.0 + clampf(tx, -40000.0, 40000.0) * 0.001


# =============================================================================
# §1.4 ATMOSPHERIC DEPTH TINT  (palette-time only — NEVER per frame)
# =============================================================================

static func fog_mix(d: float) -> float:
	var e := clampf(d, 0.0, 1.0)
	return FOG_MAX * pow(e, 1.5)                  # 0 at front, 0.42 at the back edge


# Fade a color into the distance: desaturate, then pull toward the horizon tint.
# Modules call this on their derived palette ONCE in _on_built/adapt and cache.
static func tint(c: Color, d: float, horizon: Color) -> Color:
	var m := fog_mix(d)
	var g := c.v                                  # brighter colors catch more haze
	var desat := Color.from_hsv(c.h, c.s * (1.0 - m * 0.6), c.v, c.a)
	return desat.lerp(Color(horizon.r, horizon.g, horizon.b, c.a), m * (0.8 + 0.2 * g))


# Fog a WHOLE palette dictionary in one call: every Color value is tinted, every
# other value (floats, strings, bools, nested data) is copied verbatim. Returns a
# NEW dictionary — the caller's source palette is never mutated.
static func tint_palette(pal: Dictionary, d: float, horizon: Color) -> Dictionary:
	var out: Dictionary = {}
	for k: Variant in pal.keys():
		var v: Variant = pal[k]
		if v is Color:
			out[k] = tint(v, d, horizon)
		else:
			out[k] = v
	return out


# Fog a vertex-color array (e.g. a cached grad_fill) in one pass.
static func tint_colors(cols: PackedColorArray, d: float, horizon: Color) -> PackedColorArray:
	var out := PackedColorArray()
	out.resize(cols.size())
	for i in range(cols.size()):
		out[i] = tint(cols[i], d, horizon)
	return out


# A multiplicative fog tint safe for `modulate`: hue-biased toward the horizon
# but normalized to peak channel 1.0, so it shifts temperature without darkening.
# For nodes whose internals cannot be re-palletised (third-party/legacy draws).
static func fog_modulate(d: float, horizon: Color) -> Color:
	var m := fog_mix(d)
	var mx := maxf(horizon.r, maxf(horizon.g, horizon.b))
	var hue_only := Color(1, 1, 1, 1)
	if mx > 0.01:
		hue_only = Color(horizon.r / mx, horizon.g / mx, horizon.b / mx, 1.0)
	return Color(1, 1, 1, 1).lerp(hue_only, m * 0.7)


# Suggested alpha for a VOLUME of haze sitting at depth d (§3 haze bands): the
# atmosphere layers use this so the band stack reads continuous front-to-back.
static func haze_alpha(d: float) -> float:
	return 0.10 + 0.14 * (fog_mix(d) / FOG_MAX)


# =============================================================================
# §1.5 ROWS + DepthCtx
# =============================================================================

# Nearest ROW_D index for a depth, 0..4.
static func row_of(d: float) -> int:
	var e := clampf(d, 0.0, 1.0)
	var best := 0
	var best_err := absf(e - ROW_D[0])
	for i in range(1, ROWS):
		var err := absf(e - ROW_D[i])
		if err < best_err:
			best_err = err
			best = i
	return best


static func row_d(row: int) -> float:
	return ROW_D[clampi(row, 0, ROWS - 1)]


# The depth interval a row owns: midpoints to its neighbours, clamped to [0,1].
# Used for picking (which row did a tap land on) and for scattering decor inside
# a row without crossing into the next rank.
static func row_span(row: int) -> Vector2:
	var r := clampi(row, 0, ROWS - 1)
	var lo := 0.0
	var hi := 1.0
	if r > 0:
		lo = (ROW_D[r - 1] + ROW_D[r]) * 0.5
	if r < ROWS - 1:
		hi = (ROW_D[r] + ROW_D[r + 1]) * 0.5
	return Vector2(clampf(lo, 0.0, 1.0), clampf(hi, 0.0, 1.0))


# Which row a tap `lift` px above the front contour belongs to.
static func row_of_lift(lift: float) -> int:
	return row_of(depth_from_lift(lift))


# A believable depth on a row: the row centre plus a seeded nudge so plantings
# on one row never form a perfectly straight rank.
static func jitter_d(seed: int, key: String, row: int) -> float:
	return clampf(row_d(row) + Proc.rangef(seed, "dj:" + key, -ROW_JITTER, ROW_JITTER), 0.0, 1.0)


# A seeded depth anywhere INSIDE a row's span (wider spread than jitter_d, still
# never crossing into the neighbouring rank). For scattered decor/grass fills.
static func scatter_d(seed: int, key: String, row: int) -> float:
	var span := row_span(row)
	var c := row_d(row)
	var lo := lerpf(span.x, c, 0.35)
	var hi := lerpf(span.y, c, 0.35)
	return clampf(Proc.rangef(seed, "ds:" + key, lo, hi), 0.0, 1.0)


# Seeded weighted row choice (uniform when `weights` is empty or degenerate):
# lets a scatter pass say "mostly mid rows, rarely the very front".
static func row_pick(seed: int, key: String, weights: PackedFloat32Array = PackedFloat32Array()) -> int:
	var total := 0.0
	var n := mini(weights.size(), ROWS)
	for i in range(n):
		total += maxf(0.0, weights[i])
	if total <= 0.0:
		return clampi(int(Proc.hashf(seed, "rp:" + key) * float(ROWS)), 0, ROWS - 1)
	var pick := Proc.hashf(seed, "rp:" + key) * total
	var acc := 0.0
	for i in range(n):
		acc += maxf(0.0, weights[i])
		if pick < acc:
			return i
	return n - 1


# Deterministic depth for records saved BEFORE the band existed (§1.6): the same
# place-id always re-lands on the same believable row forever.
static func legacy_d(seed: int, place_id: String) -> float:
	return jitter_d(seed, place_id, row_of(Proc.hashf(seed, "dlegacy:" + place_id) * 0.99))


# Per-row convenience (what a row-major layout pass needs without touching d).
static func row_scale(row: int) -> float:
	return depth_scale(row_d(row))


static func row_y(row: int) -> float:
	return depth_y(row_d(row))


static func row_parallax(row: int) -> float:
	return parallax(row_d(row))


# The shared DepthCtx dictionary (§1.5) — merged into build_context() under key
# "depth". ALL fields always present; px_h is the thing's on-screen body height
# AFTER depth_scale (feeds the fixed LOD decision).
static func make_ctx(d: float, px_h: float, horizon: Color) -> Dictionary:
	var e := clampf(d, 0.0, 1.0)
	return {
		"d": e,
		"row": row_of(e),
		"scale": depth_scale(e),
		"y_off": depth_y(e),
		"fog": fog_mix(e),
		"horizon": horizon,
		"parallax": parallax(e),
		"lod": lod_for(e, px_h),
	}


# The front-row default DepthCtx modules fall back to when no context arrives —
# keeps every existing standalone call site rendering identically.
static func default_ctx() -> Dictionary:
	return make_ctx(0.0, 999.0, DEFAULT_HORIZON)


# THE consumption helper. Every entity module starts its _on_built with
#     var dc := ProcDepth.ctx_of(context)
# and gets a COMPLETE, correctly-typed DepthCtx: present fields are honoured,
# missing ones are derived from `d` (or default to the front row), so a partial
# dict like {"d": 0.6} is as safe as the full one and a missing "depth" key
# behaves exactly like the pre-2.5D world.
static func ctx_of(context: Dictionary) -> Dictionary:
	var raw: Variant = context.get("depth", null)
	if not (raw is Dictionary):
		return default_ctx()
	var src: Dictionary = raw
	var d := clampf(_num(src.get("d", 0.0), 0.0), 0.0, 1.0)
	var hz := DEFAULT_HORIZON
	if src.get("horizon", null) is Color:
		var hc: Color = src["horizon"]
		hz = hc
	# Rebuild from d so every derived field is self-consistent...
	var out := make_ctx(d, px_h_at(_num(src.get("px_h", 999.0), 999.0), d), hz)
	# ...then honour any field the producer stated explicitly.
	if src.has("row"):
		out["row"] = clampi(int(_num(src["row"], float(out["row"]))), 0, ROWS - 1)
	if src.has("scale"):
		out["scale"] = maxf(0.01, _num(src["scale"], float(out["scale"])))
	if src.has("y_off"):
		out["y_off"] = _num(src["y_off"], float(out["y_off"]))
	if src.has("fog"):
		out["fog"] = clampf(_num(src["fog"], float(out["fog"])), 0.0, 1.0)
	if src.has("parallax"):
		out["parallax"] = _num(src["parallax"], float(out["parallax"]))
	if src.has("lod"):
		out["lod"] = clampi(int(_num(src["lod"], float(out["lod"]))), 0, 2)
	return out


# Single-field readers for modules that only need one number (no dict dancing,
# no crash when the key is absent or the wrong type).
static func ctx_d(context: Dictionary) -> float:
	return float(ctx_of(context)["d"])


static func ctx_row(context: Dictionary) -> int:
	return int(ctx_of(context)["row"])


static func ctx_lod(context: Dictionary) -> int:
	return int(ctx_of(context)["lod"])


static func ctx_fog(context: Dictionary) -> float:
	return float(ctx_of(context)["fog"])


static func ctx_parallax(context: Dictionary) -> float:
	return float(ctx_of(context)["parallax"])


static func ctx_horizon(context: Dictionary) -> Color:
	var c: Color = ctx_of(context)["horizon"]
	return c


# Merge a DepthCtx into a build context WITHOUT mutating the caller's dictionary
# (WorldSpace builds one context per world and hands out per-placement copies).
static func merge_ctx(context: Dictionary, depth_ctx: Dictionary) -> Dictionary:
	var out := context.duplicate()
	out["depth"] = depth_ctx
	return out


# make_ctx + merge in one call: the one line WorldSpace.place() needs before it
# forwards `context` to ItemCatalog.make_node / adapt.
static func with_depth(context: Dictionary, d: float, px_h: float, horizon: Color) -> Dictionary:
	return merge_ctx(context, make_ctx(d, px_h, horizon))


# Tolerant numeric read (ints, floats and numeric strings all land safely), so a
# hand-written or legacy-save context can never crash a placement.
static func _num(v: Variant, fallback: float) -> float:
	match typeof(v):
		TYPE_FLOAT:
			return float(v)
		TYPE_INT:
			return float(v)
		TYPE_BOOL:
			return 1.0 if bool(v) else 0.0
		TYPE_STRING:
			var s := String(v)
			return s.to_float() if s.is_valid_float() else fallback
	return fallback


# =============================================================================
# §1.6 PLACEMENT RULES
# =============================================================================

# Depth gate for can_place overlap tests: two records only x-collide when their
# depths are close enough to actually share ground, so rows may overlap on screen
# while still nestling believably.
static func collides_depth(d1: float, d2: float) -> bool:
	return absf(d1 - d2) < DEPTH_COLLIDE


# =============================================================================
# §1.7 BANDS  (rows → the three entity planes)
# =============================================================================

# Which entity band a row parents into: rows 0–1 front, row 2 mid, rows 3–4 back.
static func band_for_row(row: int) -> int:
	var r := clampi(row, 0, ROWS - 1)
	if r <= 1:
		return BAND_FRONT
	if r == 2:
		return BAND_MID
	return BAND_BACK


static func band_of(d: float) -> int:
	return band_for_row(row_of(d))


# The §1.7 camera-x multiplier of each entity band container.
static func band_parallax(band: int) -> float:
	match clampi(band, 0, 2):
		BAND_FRONT:
			return PLANE_FRONT
		BAND_MID:
			return PLANE_MID
		_:
			return PLANE_BACK


# The §1.7 z_index of each entity band container.
static func band_z(band: int) -> int:
	match clampi(band, 0, 2):
		BAND_FRONT:
			return 1
		BAND_MID:
			return 0
		_:
			return -4


# Stable container names so WorldSpace's scene graph is readable in the debugger.
static func band_name(band: int) -> String:
	match clampi(band, 0, 2):
		BAND_FRONT:
			return "BandFront"
		BAND_MID:
			return "BandMid"
		_:
			return "BandBack"


# =============================================================================
# §6 LOD  (fixed at placement — depth never changes, so no per-frame switching)
# =============================================================================

static func lod_for(d: float, px_h: float) -> int:
	var e := clampf(d, 0.0, 1.0)
	if e < 0.35 and px_h >= 110.0:
		return LOD_HERO
	if e > 0.70 or px_h < 44.0:
		return LOD_FAR
	return LOD_MID


# -- the §6 drop table, as statics so no two modules disagree ------------------

# Outline samples per smooth_loop segment: ×1.0 / ×0.6 (min 4) / ×0.4 (min 3).
# Never returns MORE than `base_samples`, and never fewer than 3 (below that
# Proc.smooth_loop would hand back a polygon too sparse to read as smooth).
static func samples_for(base_samples: int, lod: int) -> int:
	var base := maxi(3, base_samples)
	match clampi(lod, 0, 2):
		LOD_HERO:
			return base
		LOD_MID:
			return mini(base, maxi(4, int(round(float(base) * 0.6))))
		_:
			return mini(base, maxi(3, int(round(float(base) * 0.4))))


# Count of a repeated material detail (bark ridges, stone facets, leaf scallops,
# window rows…): full at LOD0, roughly halved at LOD1, gone at LOD2.
static func detail_count(base: int, lod: int) -> int:
	var b := maxi(0, base)
	if b == 0:
		return 0
	match clampi(lod, 0, 2):
		LOD_HERO:
			return b
		LOD_MID:
			return clampi(int(round(float(b) * 0.5)), 1, b)
		_:
			return 0


# Warm rim light along the lit silhouette edge (§2.5) — hero tier only.
static func wants_rim(lod: int) -> bool:
	return lod <= LOD_HERO


# The small "jewellery" passes: highlight polylines, AO creases, scallop arcs.
static func wants_highlight(lod: int) -> bool:
	return lod <= LOD_HERO


# Blob-shadow complexity (§2.6): 3 stacked half-ellipses / 1 ellipse / none.
static func shadow_layers(lod: int) -> int:
	match clampi(lod, 0, 2):
		LOD_HERO:
			return 3
		LOD_MID:
			return 1
		_:
			return 0


# Child FX nodes (sparks, flames, falling leaves) — hero tier only.
static func wants_child_fx(lod: int) -> bool:
	return lod <= LOD_HERO


# Night light pools survive one tier longer than other FX: they ARE the night
# composition, and they cost one additive quad.
static func wants_light_pool(lod: int) -> bool:
	return lod <= LOD_MID


# Does this tier respond to LOCAL light sources at all (else: sun only)?
static func wants_local_light(lod: int) -> bool:
	return lod <= LOD_MID


# Seconds between local-light re-samples: 0 = react on every LightCtx version
# bump, 0.25 = the 4 Hz mid tier, negative = never sample (sun-only).
static func local_light_interval(lod: int) -> float:
	match clampi(lod, 0, 2):
		LOD_HERO:
			return 0.0
		LOD_MID:
			return 0.25
		_:
			return -1.0


# Frame stride for _animate work: every frame / every 2nd / every 4th (the LOD2
# "breathing only" tier). Modules gate with:
#     _tick += 1
#     if _tick % ProcDepth.anim_stride(lod) != 0: return
static func anim_stride(lod: int) -> int:
	match clampi(lod, 0, 2):
		LOD_HERO:
			return 1
		LOD_MID:
			return 2
		_:
			return 4


# Amplitude multiplier for motion at distance: far things must not swing as many
# screen pixels as near ones, or the parallax illusion breaks.
static func anim_amount(lod: int) -> float:
	match clampi(lod, 0, 2):
		LOD_HERO:
			return 1.0
		LOD_MID:
			return 0.7
		_:
			return 0.4


static func lod_name(lod: int) -> String:
	match clampi(lod, 0, 2):
		LOD_HERO:
			return "hero"
		LOD_MID:
			return "mid"
		_:
			return "far"


# =============================================================================
# GEOMETRY GUARDS — the degenerate-polygon screen (hard check §7.10)
# =============================================================================

# Signed-area ×2 shoelace, absolute. Zero for a line, a point, or a polygon that
# retraces itself exactly — all of which make draw_polygon fail silently.
static func poly_area(pts: PackedVector2Array) -> float:
	var n := pts.size()
	if n < 3:
		return 0.0
	var acc := 0.0
	for i in range(n):
		var a := pts[i]
		var b := pts[(i + 1) % n]
		acc += a.x * b.y - b.x * a.y
	return absf(acc) * 0.5


# Is this polygon safe to hand to draw_polygon? ≥3 points, ≥3 DISTINCT points,
# and a real area. Call it on every generated outline before filling:
#     if ProcDepth.poly_ok(outline): draw_polygon(outline, cols)
static func poly_ok(pts: PackedVector2Array, min_area: float = 0.75) -> bool:
	if pts.size() < 3:
		return false
	var distinct := 0
	var prev := Vector2(INF, INF)
	for p: Vector2 in pts:
		if p.distance_squared_to(prev) > 0.0001:
			distinct += 1
			prev = p
			if distinct >= 3:
				break
	if distinct < 3:
		return false
	return poly_area(pts) >= min_area


# Drop consecutive duplicate points (and the closing duplicate) from a generated
# outline: the usual cause of a self-retracing loop is a sampler that emits the
# same vertex twice at a seam.
static func clean_poly(pts: PackedVector2Array, eps: float = 0.01) -> PackedVector2Array:
	var out := PackedVector2Array()
	var e2 := maxf(0.000001, eps * eps)
	for p: Vector2 in pts:
		if out.is_empty() or p.distance_squared_to(out[out.size() - 1]) > e2:
			out.append(p)
	while out.size() >= 2 and out[0].distance_squared_to(out[out.size() - 1]) <= e2:
		out.resize(out.size() - 1)
	return out


# Is this polyline worth stroking? (draw_polyline with <2 points is a no-op that
# still costs a canvas item.)
static func line_ok(pts: PackedVector2Array) -> bool:
	if pts.size() < 2:
		return false
	return pts[0].distance_squared_to(pts[pts.size() - 1]) > 0.0001 or pts.size() > 2


# =============================================================================
# SAFE SMOOTH GEOMETRY — closed contour bands that ALWAYS fill
# =============================================================================
#
# The one failure mode `poly_ok` cannot see: a polygon with plenty of distinct
# points and plenty of area that still crosses ITSELF. `draw_polygon` cannot
# triangulate those, so the fill is dropped silently and the thing renders as a
# bare outline. The classic generator that produces them is the CONTOUR BAND:
#
#     top contour left→right, then the bottom contour right→left, Catmull-smoothed
#
# because at each seam the two contours meet only a couple of px apart while the
# rest of the ring strides 60–120 px. Catmull-Rom with that spacing ratio
# overshoots and ties a knot at both ends. Terrain silhouettes, soil bands, grass
# crowns, water bodies, cliff skins and canopy masses are all contour bands, so
# the fix lives here once: EVEN OUT the control spacing, smooth, then VERIFY —
# and if the verification still fails, hand back something fillable rather than
# something invisible. All build-time only (never per frame).

# Total length of a closed point ring.
static func ring_perimeter(pts: PackedVector2Array) -> float:
	var n := pts.size()
	if n < 2:
		return 0.0
	var acc := 0.0
	for i in range(n):
		acc += pts[i].distance_to(pts[(i + 1) % n])
	return acc


# The ring's representative stride: the mean length of its non-degenerate edges
# (a plain mean would be dragged down by exactly the 2-px seam edges we want to
# normalise away).
static func ring_step(pts: PackedVector2Array) -> float:
	var n := pts.size()
	if n < 2:
		return 0.0
	var acc := 0.0
	var cnt := 0
	for i in range(n):
		var l := pts[i].distance_to(pts[(i + 1) % n])
		if l > 0.001:
			acc += l
			cnt += 1
	if cnt == 0:
		return 0.0
	return acc / float(cnt)


# Resample a closed ring to even arc-length spacing of ~`step` px. Linear along
# the ring (so it never invents geometry), monotone (so it never reorders), and
# capped at 2048 points. This is what turns an uneven control ring into one
# Catmull-Rom can smooth without knotting.
static func resample_ring(controls: PackedVector2Array, step: float) -> PackedVector2Array:
	var n := controls.size()
	if n < 3 or step <= 0.01:
		return controls
	var cum := PackedFloat32Array()
	cum.resize(n + 1)
	cum[0] = 0.0
	for i in range(n):
		cum[i + 1] = cum[i] + controls[i].distance_to(controls[(i + 1) % n])
	var total: float = cum[n]
	if total < 0.05:
		return controls
	var count := clampi(int(round(total / step)), 3, 2048)
	var out := PackedVector2Array()
	out.resize(count)
	var ei := 0
	for k in range(count):
		var s := total * float(k) / float(count)
		while ei < n - 1 and float(cum[ei + 1]) < s:
			ei += 1
		var seg_len: float = float(cum[ei + 1]) - float(cum[ei])
		var tt := 0.0
		if seg_len > 0.0001:
			tt = clampf((s - float(cum[ei])) / seg_len, 0.0, 1.0)
		out[k] = controls[ei].lerp(controls[(ei + 1) % n], tt)
	return out


# Does this closed polygon avoid crossing itself? Overshoot knots are LOCAL (a
# loop closes within a few samples of where it opened), so by default each edge
# is only tested against the next `window` edges — O(n·window) instead of O(n²),
# a few thousand cheap tests for a 200-point outline. Pass window <= 0 for the
# exhaustive test (use it only on small control rings).
static func poly_simple(pts: PackedVector2Array, window: int = 14) -> bool:
	var n := pts.size()
	if n < 4:
		return true
	var w := window if window > 0 else n
	for i in range(n):
		var a1 := pts[i]
		var a2 := pts[(i + 1) % n]
		var jmax := mini(i + 2 + w, i + n - 1)
		for j in range(i + 2, jmax):
			var k := j % n
			var hit: Variant = Geometry2D.segment_intersects_segment(a1, a2, pts[k], pts[(k + 1) % n])
			if hit != null:
				return false
	return true


# THE authoritative fill test: `draw_polygon` triangulates with exactly this
# routine, so a polygon that fails here renders as NOTHING (Godot logs
# "Invalid polygon data, triangulation failed" and drops the call). Use it as the
# final gate on any generated fill whose outline could possibly knot:
#     if ProcDepth.triangulable(o): draw_polygon(o, cols)
static func triangulable(pts: PackedVector2Array) -> bool:
	if pts.size() < 3:
		return false
	var tris := Geometry2D.triangulate_polygon(pts)
	return tris.size() >= 3


# THE smoothing call for any closed generated outline: clean → even out the
# control spacing → Catmull-Rom → verify fillable AND simple, degrading sample
# density before it degrades to the (faceted but always fillable) control ring.
# Returns an EMPTY array only when the controls describe nothing drawable, so
#     var o := ProcDepth.safe_loop(ctrl, 6)
#     if o.size() >= 3: draw_polygon(o, Proc.grad_fill(o, top, bot))
# can never silently lose a fill again.
static func safe_loop(controls: PackedVector2Array, samples: int = 6,
		min_area: float = 0.75) -> PackedVector2Array:
	var ctrl := clean_poly(controls, 0.01)
	if ctrl.size() < 3:
		return PackedVector2Array()
	var step := ring_step(ctrl)
	var even := ctrl
	if step > 0.5:
		even = clean_poly(resample_ring(ctrl, step), 0.01)
	if even.size() < 3:
		even = ctrl
	var tries: Array[int] = [maxi(2, samples), maxi(2, int(round(float(samples) * 0.5))), 2]
	for s in tries:
		var loop := clean_poly(Proc.smooth_loop(even, s), 0.01)
		if poly_ok(loop, min_area) and triangulable(loop):
			return loop
	if poly_ok(even, min_area) and triangulable(even):
		return even
	if poly_ok(ctrl, min_area) and triangulable(ctrl):
		return ctrl
	return PackedVector2Array()


# A closed CONTOUR BAND from two open contours, BOTH given left→right (`bottom`
# is reversed internally so callers never have to think about winding). This is
# the terrain/soil/grass/water/cliff workhorse — seams are de-duplicated, the
# ring is evened, the result is verified fillable.
static func ribbon_loop(top: PackedVector2Array, bottom: PackedVector2Array,
		samples: int = 6, min_area: float = 0.75) -> PackedVector2Array:
	var ctrl := PackedVector2Array()
	for p: Vector2 in top:
		ctrl.append(p)
	for i in range(bottom.size() - 1, -1, -1):
		ctrl.append(bottom[i])
	return safe_loop(ctrl, samples, min_area)


# A smoothed open polyline (no wrap-around seam): for crest lines, rim lights,
# bark ridges and ground edges that must NOT close. Duplicates the end controls
# so the spline reaches the real first/last point, then drops the closing run.
static func safe_line(controls: PackedVector2Array, samples: int = 6) -> PackedVector2Array:
	var ctrl := clean_poly(controls, 0.01)
	var n := ctrl.size()
	if n < 2:
		return PackedVector2Array()
	if n == 2:
		return ctrl
	var out := PackedVector2Array()
	var s := maxi(2, samples)
	for i in range(n - 1):
		var p0 := ctrl[maxi(0, i - 1)]
		var p1 := ctrl[i]
		var p2 := ctrl[i + 1]
		var p3 := ctrl[mini(n - 1, i + 2)]
		for k in range(s):
			var tt := float(k) / float(s)
			var t2 := tt * tt
			var t3 := t2 * tt
			out.append(0.5 * ((2.0 * p1) + (-p0 + p2) * tt
				+ (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
				+ (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3))
	out.append(ctrl[n - 1])
	var cleaned := PackedVector2Array()
	for p: Vector2 in out:
		if cleaned.is_empty() or p.distance_squared_to(cleaned[cleaned.size() - 1]) > 0.0001:
			cleaned.append(p)
	return cleaned if line_ok(cleaned) else PackedVector2Array()


# =============================================================================
# DEPTH-AWARE NODE WRAPPER  — one call dresses any ProcNode/Node2D for its depth
# =============================================================================

# Apply the depth model to a node's TRANSFORM-level properties: uniform scale,
# y-sort z, and a "depth_d" meta so depth_of_node()/WorldSpace.depth_of can read
# it back. Pass a horizon color (alpha > 0) to ALSO apply the cheap modulate fog
# path for nodes that do not read the DepthCtx and re-tint their own palettes
# (modulate keeps value ≤ 1, so it cools and softens without crushing).
# Palette-aware modules should fog via ProcDepth.tint instead and omit `horizon`.
static func apply_depth(node: Node2D, d: float, horizon: Color = Color(0, 0, 0, 0)) -> void:
	if node == null:
		return
	var e := clampf(d, 0.0, 1.0)
	node.scale = Vector2.ONE * depth_scale(e)
	node.z_index = z_for(e)
	node.z_as_relative = true
	node.set_meta("depth_d", e)
	if horizon.a > 0.0:
		node.modulate = fog_modulate(e, horizon)


# apply_depth + the §1.3 per-place z tie-break: what WorldSpace.place() calls so
# two things on one row keep a stable, seeded front/back relationship forever.
static func apply_place(node: Node2D, d: float, seed: int, place_id: String,
		horizon: Color = Color(0, 0, 0, 0)) -> void:
	if node == null:
		return
	apply_depth(node, d, horizon)
	node.z_index = z_for_place(d, seed, place_id)


# Read back the depth apply_depth stamped on a node (0.0 = front, for anything
# never depth-dressed — every legacy node keeps rendering at the front edge).
static func depth_of_node(node: Node2D) -> float:
	if node == null or not node.has_meta("depth_d"):
		return 0.0
	return clampf(_num(node.get_meta("depth_d"), 0.0), 0.0, 1.0)


# =============================================================================
# PARALLAX PLANES  (§1.7 — one container per plane, one line per pan event)
# =============================================================================

# Pure helper: the container x-offset that makes a plane with camera-x multiplier
# `rate` visually move at `rate` × camera speed (rate 1.0 → 0, 0.55 → counter-
# shifts to 55% apparent speed, 1.25 → overshoots like true foreground).
static func plane_offset_x(rate: float, cam_x: float) -> float:
	return cam_x * (rate - 1.0) * -1.0


# A parallax plane container. Parent it under the pan camera, parent content under
# it, and call set_cam(cam.position) after each pan — zero per-frame cost when
# the camera is still. Vertical parallax is damped (the world is wide, not tall).
static func make_plane(rate: float, plane_name: String = "") -> Node2D:
	var p := _Plane.new()
	p.rate = rate
	p.name = plane_name if plane_name != "" else "Plane_%d" % int(round(rate * 100.0))
	return p


# The plane a thing at depth d would ride on, if you need a one-off container
# rather than one of the canonical P-planes.
static func make_plane_for_depth(d: float, plane_name: String = "") -> Node2D:
	return make_plane(parallax(d), plane_name)


class _Plane extends Node2D:
	var rate := 1.0
	var y_damp := 0.35

	# Call once per pan event (NOT per frame).
	func set_cam(cam_pos: Vector2) -> void:
		position = Vector2(
			ProcDepth.plane_offset_x(rate, cam_pos.x),
			ProcDepth.plane_offset_x(rate, cam_pos.y) * y_damp)

	func set_cam_x(cam_x: float) -> void:
		position.x = ProcDepth.plane_offset_x(rate, cam_x)

	func set_y_damp(k: float) -> void:
		y_damp = clampf(k, 0.0, 1.0)


# =============================================================================
# DISTANT ISLET BAND  — the P1 skyline strip composed from ProcTerrain islets
# =============================================================================

# A horizontal strip of 1–5 distant floating islets hugging the horizon. Each is
# a real `ProcTerrain.make_islet` (lod 2, self-hazing) riding a holder that also
# carries a guaranteed-drawable HAZE MASS behind it — a soft fog-tinted
# silhouette + ground-wash that reads as the islet's atmospheric body, so the
# skyline is legible even where a complex island outline cannot be filled.
# Layout is seeded stratified slots; depth comes from a seeded rank permutation
# in [d_min, d_max], driving scale, lift, fog and draw order (z_for). Motion is
# a slow desynced bob + a barely-there drift, written as holder transforms only —
# no redraws, no allocation per frame.
#
# `size` is the strip rect (origin top-left per CONVENTIONS rule 7 backgrounds).
# opts: {horizon: Color, realm: String, d_min: float, d_max: float, bob: float}
static func make_islet_band(world_seed: int, key: String, size: Vector2,
		count: int = 3, opts: Dictionary = {}) -> ProcNode:
	var n := _IsletBand.new()
	n.seedv = hash("%d:isletband:%s" % [world_seed, key])
	n.world_seed = world_seed
	n.key = key
	n.band_size = Vector2(maxf(120.0, size.x), maxf(80.0, size.y))
	n.count = clampi(count, 1, 5)
	n.realm_id = String(opts.get("realm", "verdant"))
	var hz: Color = opts.get("horizon", DEFAULT_HORIZON)
	n.horizon = hz
	n.d_min = clampf(_num(opts.get("d_min", 0.82), 0.82), 0.0, 1.0)
	n.d_max = clampf(_num(opts.get("d_max", 0.97), 0.97), n.d_min, 1.0)
	n.bob_scale = maxf(0.0, _num(opts.get("bob", 1.0), 1.0))
	n.set_grow_minutes(0.0)          # the skyline is ancient; arrives fully formed
	return n


class _IsletBand extends ProcNode:
	var world_seed: int = 0
	var key: String = "far"
	var band_size := Vector2(1080, 420)
	var count: int = 3
	var realm_id: String = "verdant"
	var horizon := ProcDepth.DEFAULT_HORIZON
	var d_min: float = 0.82
	var d_max: float = 0.97
	var bob_scale: float = 1.0
	var strength: float = 1.0

	# Per-islet caches (built once in _on_built; _animate only reads + transforms).
	var _holders: Array[Node2D] = []
	var _masses: Array[_IsletMass] = []
	var _depths: PackedFloat32Array = PackedFloat32Array()
	var _base_x: PackedFloat32Array = PackedFloat32Array()
	var _base_y: PackedFloat32Array = PackedFloat32Array()
	var _bob_amp: PackedFloat32Array = PackedFloat32Array()
	var _bob_spd: PackedFloat32Array = PackedFloat32Array()
	var _bob_ph: PackedFloat32Array = PackedFloat32Array()
	var _drift_amp: PackedFloat32Array = PackedFloat32Array()
	var _drift_ph: PackedFloat32Array = PackedFloat32Array()

	func _on_built() -> void:
		# Stratified slots across the strip so islets spread without clumping; a
		# seeded order permutation keeps near/far mixing lively between worlds.
		var slot_w := band_size.x / float(count)
		var order: Array[int] = []
		for i in range(count):
			order.append(i)
		# seeded Fisher-Yates so depth assignment varies per world (pure Proc math)
		for i in range(count - 1, 0, -1):
			var j := int(Proc.hashf(world_seed, "ibshuf:%s:%d" % [key, i]) * float(i + 1))
			j = clampi(j, 0, i)
			var tmp := order[i]
			order[i] = order[j]
			order[j] = tmp
		# One islet per slot; its depth comes from the shuffled rank, so near and
		# far islets interleave across the strip. Draw order is pure z_index, so
		# no child sorting is needed — front-over-back is automatic.
		for i in range(count):
			var dn: float = 0.5 if count <= 1 else float(order[i]) / float(count - 1)
			var d := lerpf(d_min, d_max, dn)   # rank 0 → nearest, rank max → horizon
			var ikey := "%s#%d" % [key, i]
			# Smaller + higher the farther back; all seeded.
			var half_w := Proc.rangef(world_seed, "ibw:" + ikey, 62.0, 150.0) * lerpf(1.0, 0.55, dn)
			var x := slot_w * (float(i) + Proc.rangef(world_seed, "ibx:" + ikey, 0.22, 0.78))
			var y := band_size.y * lerpf(0.72, 0.30, dn) \
				+ Proc.rangef(world_seed, "iby:" + ikey, -band_size.y * 0.06, band_size.y * 0.06)

			# The holder carries depth scale + z + fog modulate for the pair, so
			# animation is ONE transform write per islet per frame.
			var holder := Node2D.new()
			holder.name = "Islet%d" % i
			holder.position = Vector2(x, y)
			holder.scale = Vector2.ONE * ProcDepth.depth_scale(d)
			holder.z_index = ProcDepth.z_for(d)
			holder.z_as_relative = true
			holder.set_meta("depth_d", d)
			add_child(holder)

			# 1) the atmospheric mass: always drawable, carries the silhouette.
			var mass := _IsletMass.new()
			mass.z_index = -1
			mass.z_as_relative = true
			mass.configure(world_seed, "ibm:" + ikey, half_w, d, horizon, realm_id)
			holder.add_child(mass)

			# 2) the real island on top, hazed by its own distance fade.
			var islet := ProcTerrain.make_islet(world_seed, "band:" + ikey, half_w, realm_id, 2)
			islet.z_index = 0
			islet.z_as_relative = true
			islet.set("haze", clampf(0.22 + 0.42 * dn, 0.0, 0.6))
			holder.add_child(islet)

			_holders.append(holder)
			_masses.append(mass)
			_depths.append(d)
			_base_x.append(x)
			_base_y.append(y)
			_bob_amp.append(lerpf(9.0, 3.5, dn) * bob_scale)
			_bob_spd.append(Proc.rangef(world_seed, "ibs:" + ikey, 0.32, 0.55))
			_bob_ph.append(Proc.hashf(world_seed, "ibp:" + ikey) * TAU)
			_drift_amp.append(lerpf(4.0, 1.5, dn) * bob_scale)
			_drift_ph.append(Proc.hashf(world_seed, "ibq:" + ikey) * TAU)
		_retint()

	# Slow 10–20 s bob + a barely-there sideways drift: pure transform writes over
	# the caches, no allocation, no redraws.
	func _animate(_delta: float) -> void:
		for i in range(_holders.size()):
			var sp := _bob_spd[i]
			_holders[i].position = Vector2(
				_base_x[i] + sin(t * sp * 0.37 + _drift_ph[i]) * _drift_amp[i],
				_base_y[i] + sin(t * sp + _bob_ph[i]) * _bob_amp[i])

	# Re-fog toward a new horizon tint (time-of-day / weather drives this, at most
	# a handful of times a minute). Modulate for the islets, one cheap redraw for
	# the masses — and only when the tint actually moved.
	func set_horizon(c: Color) -> void:
		if absf(c.r - horizon.r) + absf(c.g - horizon.g) + absf(c.b - horizon.b) < 0.012:
			return
		horizon = c
		for i in range(_masses.size()):
			_masses[i].set_fog(_depths[i], horizon)
		_retint()

	# Weather/dim blending hook (0 hides the skyline, 1 full). Modulate-only.
	func set_strength(s: float) -> void:
		strength = clampf(s, 0.0, 1.0)
		_retint()

	func _retint() -> void:
		for i in range(_holders.size()):
			var m := ProcDepth.fog_modulate(_depths[i], horizon)
			m.a = strength
			_holders[i].modulate = m


# ONE distant islet, rendered as a real floating island rather than a smudge:
#
#   wash   a wide flat ellipse of pure horizon colour hugging the land line, so
#          the islet sits IN the air instead of being pasted onto the sky
#   mass   the rock body — a contour band between an analytic crown and an
#          analytic keel, built through ribbon_loop so it is always fillable
#   keel   the underside volume (waist → keel) overlaid darker: the one cue that
#          makes a silhouette read as a floating island with weight
#   cap    a thin meadow/snow crown riding the crest, brighter than the rock
#   crest  a pale open polyline along the lit top edge (safe_line, never closed)
#   strata 2 faint bedding lines, nearest islet only — pure depth-gated detail
#
# Every polygon comes out of safe_loop/ribbon_loop and is re-verified before it
# is drawn, so nothing here can ever be a silent triangulation failure. All five
# caches are built ONCE; set_fog only swaps colours (one redraw, no geometry),
# and the band animates by moving this node's parent, never by redrawing it.
class _IsletMass extends Node2D:
	var w := 120.0
	var h := 80.0
	var col_top := Color(0.82, 0.88, 0.95)
	var col_bot := Color(0.68, 0.74, 0.85)
	var col_keel_top := Color(0.62, 0.68, 0.80, 0.55)
	var col_keel_bot := Color(0.52, 0.57, 0.70, 0.30)
	var col_cap_top := Color(0.90, 0.95, 0.99)
	var col_cap_bot := Color(0.80, 0.87, 0.94)
	var col_wash := Color(0.85, 0.9, 0.96, 0.16)
	var col_crest := Color(1, 1, 1, 0.35)
	var col_strata := Color(0.5, 0.55, 0.66, 0.26)
	var _poly := PackedVector2Array()
	var _keel := PackedVector2Array()
	var _cap := PackedVector2Array()
	var _wash := PackedVector2Array()
	var _crest := PackedVector2Array()
	var _strata: Array[PackedVector2Array] = []
	var _base_top := Color(0.82, 0.88, 0.95)
	var _base_bot := Color(0.68, 0.74, 0.85)
	var _base_cap := Color(0.88, 0.94, 0.98)

	func configure(world_seed: int, key: String, half_w: float, d: float,
			horizon: Color, realm_id: String) -> void:
		w = maxf(28.0, half_w) * 1.07
		h = w * Proc.rangef(world_seed, key + ":hh", 0.62, 0.92)
		# Colours come from the world palette, pushed deep into the fog by depth —
		# a distant islet is 80% atmosphere and 20% rock.
		var pal := Proc.palette(world_seed, "terr:" + realm_id)
		var lt: Color = pal["base_lt"]
		var so: Color = pal["soil"]
		var bs: Color = pal["base"]
		_base_top = lt
		_base_bot = so
		_base_cap = bs.lerp(lt, 0.55)
		_build(world_seed, key, d)
		set_fog(d, horizon)

	# Three analytic contours, all sampled left→right so ribbon_loop can pair any
	# two of them. Seeded undulation keeps every islet its own shape; the envelopes
	# guarantee the ordering (crown above waist above keel) at every x, so no pair
	# can ever cross and no band can ever be zero-area.
	func _build(world_seed: int, key: String, d: float) -> void:
		var samples := 9
		var crown := PackedVector2Array()
		var waist := PackedVector2Array()
		var keel := PackedVector2Array()
		var cap_low := PackedVector2Array()
		var cap_h := h * Proc.rangef(world_seed, key + ":cap", 0.07, 0.13)
		for i in range(samples):
			var k := float(i) / float(samples - 1)
			var x := lerpf(-w, w, k)
			var arch := sin(k * PI)                       # 0 at the shoulders, 1 mid
			# crown: a soft dome with a seeded ridge, drooping to both shoulders
			var dome := -h * 0.22 * pow(arch, 1.25)
			var bump := Proc.rangef(world_seed, "%s:tb%d" % [key, i], -h * 0.04, h * 0.04) * arch
			var cy := dome + bump
			crown.append(Vector2(x, cy))
			cap_low.append(Vector2(x, cy + cap_h * (0.38 + 0.62 * arch)))
			waist.append(Vector2(x, h * 0.17 + Proc.rangef(world_seed, "%s:wb%d" % [key, i], -h * 0.02, h * 0.02) * arch))
			# keel: shoulders at the waist line, plunging to a seeded central point
			var kd := h * (0.20 + 0.76 * pow(arch, 0.80))
			var kb := Proc.rangef(world_seed, "%s:kb%d" % [key, i], -h * 0.055, h * 0.055) * arch
			keel.append(Vector2(x, kd + kb))
		# The rock body and its two sub-volumes, all guaranteed fillable.
		_poly = ProcDepth.ribbon_loop(crown, keel, 5, 4.0)
		_keel = ProcDepth.ribbon_loop(waist, keel, 5, 4.0)
		_cap = ProcDepth.ribbon_loop(crown, cap_low, 5, 2.0)
		# Ground wash: a wide, very flat ellipse hugging the land line.
		var wash := Proc.superellipse(w * 1.42, h * 0.20, 2.0, 26)
		for i in range(wash.size()):
			wash[i] = wash[i] + Vector2(0.0, h * 0.10)
		_wash = wash if ProcDepth.poly_ok(wash, 4.0) else PackedVector2Array()
		# Crest: the top edge as an OPEN smoothed polyline (no closing seam).
		_crest = ProcDepth.safe_line(crown, 4)
		# Bedding lines: only the nearest rank earns them (at d>0.90 the fog would
		# eat them anyway, and a 5-islet band must stay nearly free).
		_strata.clear()
		if d <= 0.90:
			for s in range(2):
				var frac := lerpf(0.40, 0.66, float(s) / 1.0)
				var line := PackedVector2Array()
				for i in range(samples):
					var k := float(i) / float(samples - 1)
					var arch := sin(k * PI)
					if arch < 0.18:
						continue                           # keep the ends off the rim
					var wy: float = waist[i].y
					var ky: float = keel[i].y
					line.append(Vector2(waist[i].x, lerpf(wy, ky, frac)))
				var sm := ProcDepth.safe_line(line, 3)
				if ProcDepth.line_ok(sm):
					_strata.append(sm)

	# Re-fog for a new horizon / time of day: colours only, one redraw, no geometry.
	func set_fog(d: float, horizon: Color) -> void:
		col_top = ProcDepth.tint(_base_top, minf(1.0, d + 0.06), horizon).lerp(horizon, 0.30)
		col_bot = ProcDepth.tint(_base_bot, minf(1.0, d + 0.10), horizon).lerp(horizon, 0.18)
		var keel_base := ProcDepth.tint(_base_bot, minf(1.0, d + 0.04), horizon)
		col_keel_top = Color(keel_base.r, keel_base.g, keel_base.b, 0.42)
		var keel_deep := keel_base.darkened(0.22).lerp(horizon, 0.34)
		col_keel_bot = Color(keel_deep.r, keel_deep.g, keel_deep.b, 0.16)
		var cap := ProcDepth.tint(_base_cap, minf(1.0, d + 0.02), horizon)
		col_cap_top = cap.lightened(0.10)
		col_cap_bot = cap.lerp(col_top, 0.55)
		col_wash = Color(horizon.r, horizon.g, horizon.b, 0.16)
		col_crest = Color(1, 1, 1, 1).lerp(horizon, 0.55)
		col_crest.a = 0.34
		var st := col_bot.darkened(0.18).lerp(horizon, 0.30)
		col_strata = Color(st.r, st.g, st.b, 0.22)
		queue_redraw()

	func _draw() -> void:
		if _wash.size() >= 3:
			draw_polygon(_wash, PackedColorArray([col_wash]))
		if _poly.size() >= 3:
			draw_polygon(_poly, Proc.grad_fill(_poly, col_top, col_bot))
		if _keel.size() >= 3:
			draw_polygon(_keel, Proc.grad_fill(_keel, col_keel_top, col_keel_bot))
		for s: PackedVector2Array in _strata:
			draw_polyline(s, col_strata, 1.5, true)
		if _cap.size() >= 3:
			draw_polygon(_cap, Proc.grad_fill(_cap, col_cap_top, col_cap_bot))
		if _crest.size() >= 2:
			draw_polyline(_crest, col_crest, 2.0, true)
