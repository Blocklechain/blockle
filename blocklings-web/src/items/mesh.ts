/**
 * Items — 3D voxel model builders.
 *
 * Every catalog item gets a real little model assembled from flat-color
 * Lambert boxes (the same cozy VoxelBatch look as the world — NO textures).
 * All models: fresh THREE.Group, ~0.5-1.2 units tall, origin at the
 * grip/base, front facing +Z, well under 40 boxes each.
 *
 * Geometry is one shared unit BoxGeometry (scaled per mesh); materials are
 * cached by color+opts so repeated builds stay cheap.
 */
import * as THREE from 'three'
import type { ItemDef } from '../types'
import { MATERIALS } from '../ids'
import { mountSpec, type MountFeature } from './mounts'
import {
  TIER_PALETTES, tierOpts, faintGlow, type TierPalette, type VoxOpts,
  WOOD, WOOD_DARK, WOOD_LIGHT, LEATHER, STRING, STONE, STONE_DARK, LEAF, LEAF_DARK,
} from './palette'

// ---------------------------------------------------------------------------
// Box helper (center-based) + material cache
// ---------------------------------------------------------------------------

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1)
const matCache = new Map<string, THREE.MeshLambertMaterial>()

function material(color: number, opts: VoxOpts = {}): THREE.MeshLambertMaterial {
  const key = `${color}|${opts.emissive ?? -1}|${opts.emissiveIntensity ?? 1}|${opts.opacity ?? 1}`
  let m = matCache.get(key)
  if (!m) {
    m = new THREE.MeshLambertMaterial({
      color,
      emissive: opts.emissive ?? 0x000000,
      emissiveIntensity: opts.emissiveIntensity ?? 1,
      transparent: (opts.opacity ?? 1) < 1,
      opacity: opts.opacity ?? 1,
    })
    matCache.set(key, m)
  }
  return m
}

/** Add a box with CENTER (x, y, z) and size (sx, sy, sz). */
function box(
  g: THREE.Group,
  x: number, y: number, z: number,
  sx: number, sy: number, sz: number,
  color: number, opts?: VoxOpts
): THREE.Mesh {
  const mesh = new THREE.Mesh(UNIT_BOX, material(color, opts))
  mesh.position.set(x, y, z)
  mesh.scale.set(sx, sy, sz)
  mesh.castShadow = true
  g.add(mesh)
  return mesh
}

function group(): THREE.Group {
  return new THREE.Group()
}

function tierOf(id: string): number {
  const tail = id.slice(id.lastIndexOf('_') + 1)
  const t = (MATERIALS as readonly string[]).indexOf(tail)
  return t >= 0 ? t : 0
}

function pal(t: number): TierPalette {
  // Clamp across the FULL ladder (now 12 tiers), not just the first six, so the
  // late-game tiers (obsidian..runic) resolve to their own palettes instead of
  // collapsing onto mythic.
  return TIER_PALETTES[Math.min(Math.max(t, 0), TIER_PALETTES.length - 1)]!
}

// ---------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------

function buildSword(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  box(g, 0, -0.16, 0, 0.11, 0.07, 0.11, p.dark) // pommel
  box(g, 0, 0, 0, 0.09, 0.26, 0.09, LEATHER) // grip (origin)
  box(g, 0, 0.16, 0, 0.3, 0.06, 0.12, p.accent) // crossguard
  box(g, 0, 0.52, 0, 0.12, 0.66, 0.05, p.main, glow) // blade
  box(g, 0, 0.54, 0, 0.04, 0.68, 0.055, p.light, glow) // fuller
  box(g, 0, 0.9, 0, 0.07, 0.1, 0.05, p.main, glow) // tip
  return g
}

function buildAxe(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  box(g, 0, 0.42, 0, 0.07, 0.84, 0.07, WOOD) // haft
  box(g, 0, 0.04, 0, 0.09, 0.08, 0.09, WOOD_DARK) // butt
  box(g, 0, 0.72, 0, 0.12, 0.16, 0.1, p.dark) // collar
  box(g, 0.19, 0.72, 0, 0.26, 0.2, 0.08, p.main, glow) // right cheek
  box(g, 0.34, 0.72, 0, 0.05, 0.28, 0.09, p.light, glow) // right edge
  box(g, -0.19, 0.72, 0, 0.26, 0.2, 0.08, p.main, glow) // left cheek
  box(g, -0.34, 0.72, 0, 0.05, 0.28, 0.09, p.light, glow) // left edge
  return g
}

function buildStaff(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  box(g, 0, 0.5, 0, 0.07, 1.0, 0.07, t >= 4 ? p.dark : WOOD) // shaft
  box(g, 0, 0.22, 0, 0.09, 0.14, 0.09, LEATHER) // grip wrap
  box(g, 0.09, 0.95, 0, 0.04, 0.14, 0.04, p.accent) // prong
  box(g, -0.09, 0.95, 0, 0.04, 0.14, 0.04, p.accent) // prong
  box(g, 0, 1.06, 0, 0.18, 0.18, 0.18, p.main, { emissive: p.emissive ?? p.dark, emissiveIntensity: 0.45, ...(p.opacity !== undefined ? { opacity: p.opacity } : {}) }) // orb — always a little alive
  box(g, 0, 1.06, 0.08, 0.07, 0.07, 0.04, p.light) // orb glint
  return g
}

function buildBow(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  box(g, 0, 0, 0, 0.07, 0.2, 0.09, LEATHER) // grip (origin)
  for (const s of [1, -1]) {
    box(g, 0, s * 0.18, -0.02, 0.06, 0.18, 0.07, p.main, glow)
    box(g, 0, s * 0.33, -0.08, 0.06, 0.16, 0.06, p.main, glow)
    box(g, 0, s * 0.45, -0.15, 0.05, 0.14, 0.05, p.dark, glow)
    box(g, 0, s * 0.53, -0.2, 0.045, 0.07, 0.045, p.accent) // tip nock
  }
  box(g, 0, 0, -0.22, 0.015, 1.04, 0.015, t >= 4 ? p.light : STRING, t >= 4 ? glow : undefined) // string
  return g
}

// ---------------------------------------------------------------------------
// Armor + shield
// ---------------------------------------------------------------------------

function buildShield(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  // Kite shield, plate centered on origin, face toward +Z.
  box(g, 0, 0.3, 0, 0.52, 0.16, 0.07, p.main, glow)
  box(g, 0, 0.16, 0, 0.58, 0.14, 0.07, p.main, glow)
  box(g, 0, 0.02, 0, 0.5, 0.14, 0.07, p.main, glow)
  box(g, 0, -0.12, 0, 0.38, 0.14, 0.07, p.main, glow)
  box(g, 0, -0.24, 0, 0.26, 0.12, 0.07, p.dark, glow)
  box(g, 0, -0.34, 0, 0.12, 0.1, 0.07, p.dark, glow) // point
  box(g, 0, 0.39, 0, 0.44, 0.06, 0.075, p.light, glow) // top rim
  box(g, 0, 0.1, 0.05, 0.16, 0.16, 0.05, p.accent) // boss
  return g
}

function buildHelm(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  // Sized to FULLY wrap the big 0.72 voxel head: the band drops to the brow
  // and overhangs the head on every side, with cheek guards framing the face —
  // not a skullcap perched on top.
  box(g, 0, 0.06, 0, 0.56, 0.36, 0.56, p.main, glow) // skull band (brow -> crown)
  box(g, 0, 0.28, 0, 0.48, 0.16, 0.48, p.light, glow) // dome
  for (const s of [1, -1]) {
    box(g, s * 0.27, -0.04, 0.12, 0.06, 0.28, 0.34, p.main, glow) // cheek guard
  }
  box(g, 0, -0.02, 0.3, 0.09, 0.3, 0.05, p.dark) // nose guard
  box(g, 0, -0.1, 0, 0.58, 0.07, 0.58, p.dark, glow) // brim
  box(g, 0, 0.44, -0.04, 0.09, 0.18, 0.3, p.accent) // plume crest
  box(g, 0, 0.3, -0.32, 0.09, 0.14, 0.18, p.accent) // plume tail
  return g
}

function buildChest(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  // Torso plate: sized to FULLY wrap the character torso (incl. the broad
  // frame) from the belt line up over the shoulders — no tunic poking out.
  box(g, 0, 0.3, 0, 0.58, 0.64, 0.38, p.main, glow) // torso
  box(g, 0, 0.46, 0.2, 0.34, 0.24, 0.02, p.light, glow) // chest shine
  box(g, 0.32, 0.56, 0, 0.18, 0.14, 0.32, p.dark, glow) // pauldron R
  box(g, -0.32, 0.56, 0, 0.18, 0.14, 0.32, p.dark, glow) // pauldron L
  box(g, 0, 0.6, 0, 0.3, 0.06, 0.2, p.dark) // collar
  box(g, 0, 0.08, 0, 0.52, 0.09, 0.32, LEATHER) // belt
  box(g, 0, 0.08, 0.17, 0.09, 0.09, 0.02, p.accent) // buckle
  return g
}

function buildBoots(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  for (const s of [1, -1]) {
    const x = s * 0.15
    box(g, x, 0.03, 0.05, 0.2, 0.04, 0.38, p.accent) // sole
    box(g, x, 0.11, 0.09, 0.18, 0.12, 0.32, p.dark, glow) // foot
    // Full greave: wraps the shin + lower thigh up to the hip (not just the ankle).
    box(g, x, 0.27, -0.01, 0.21, 0.4, 0.24, p.main, glow) // greave
    box(g, x, 0.46, -0.01, 0.23, 0.08, 0.26, p.light, glow) // thigh cuff (under hip)
    box(g, x, 0.3, 0.1, 0.05, 0.22, 0.03, p.light, glow) // shin shine
  }
  return g
}

// ---------------------------------------------------------------------------
// Ranger set — light leather (helm=hood, chest=leathers, boots=treads).
// Leather base, tier metal only in studs/trim so it reads "light" not "plate".
// ---------------------------------------------------------------------------

const LEATHER_DARK = 0x5a4229

function buildHood(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  box(g, 0, 0.14, -0.02, 0.44, 0.3, 0.42, LEATHER) // hood shell
  box(g, 0, 0.32, -0.06, 0.32, 0.16, 0.34, LEATHER_DARK) // crown fold
  box(g, 0, 0.18, 0.21, 0.3, 0.3, 0.05, 0x1c1a18) // shadowed face opening
  box(g, 0, 0.04, 0, 0.46, 0.06, 0.44, p.dark, glow) // tier trim band
  box(g, 0, 0.1, 0.22, 0.07, 0.07, 0.03, p.accent, glow) // brow stud
  box(g, 0, 0.38, -0.18, 0.08, 0.1, 0.12, LEATHER_DARK) // droop tip
  return g
}

function buildLeathers(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  box(g, 0, 0.3, 0, 0.56, 0.62, 0.36, LEATHER) // jerkin torso (wraps the full body)
  box(g, 0, 0.44, 0.145, 0.28, 0.26, 0.02, LEATHER_DARK) // lace panel
  box(g, 0.26, 0.5, 0, 0.12, 0.3, 0.26, LEATHER_DARK) // shoulder strap R
  box(g, -0.26, 0.5, 0, 0.12, 0.3, 0.26, LEATHER_DARK) // shoulder strap L
  box(g, 0.1, 0.46, 0.15, 0.015, 0.22, 0.01, STRING) // lacing R
  box(g, -0.1, 0.46, 0.15, 0.015, 0.22, 0.01, STRING) // lacing L
  box(g, 0, 0.1, 0, 0.5, 0.08, 0.3, p.dark, glow) // studded belt (tier)
  box(g, 0, 0.1, 0.16, 0.08, 0.08, 0.02, p.accent, glow) // buckle
  box(g, 0.18, 0.5, 0.14, 0.04, 0.04, 0.02, p.accent, glow) // chest stud R
  box(g, -0.18, 0.5, 0.14, 0.04, 0.04, 0.02, p.accent, glow) // chest stud L
  return g
}

function buildTreads(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  for (const s of [1, -1]) {
    const x = s * 0.15
    box(g, x, 0.03, 0.05, 0.17, 0.04, 0.34, 0x3a2a1a) // sole
    box(g, x, 0.11, 0.08, 0.15, 0.12, 0.28, LEATHER) // foot
    box(g, x, 0.24, -0.02, 0.14, 0.16, 0.18, LEATHER_DARK) // ankle
    box(g, x, 0.31, -0.01, 0.15, 0.05, 0.2, p.dark, glow) // tier cuff
    box(g, x, 0.2, 0.13, 0.025, 0.1, 0.02, STRING) // lace
  }
  return g
}

// ---------------------------------------------------------------------------
// Mage set — cloth robes (helm=mhat, chest=robe, boots=slippers).
// Cloth IS the tier color (p.main) so robes clearly read copper..mythic.
// ---------------------------------------------------------------------------

function buildMhat(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  box(g, 0, 0.04, 0, 0.58, 0.05, 0.58, p.main, glow) // wide brim
  box(g, 0, 0.1, 0, 0.38, 0.05, 0.38, p.dark) // hat band
  box(g, 0, 0.1, 0.19, 0.06, 0.05, 0.02, p.accent, glow) // band jewel
  box(g, 0, 0.2, -0.01, 0.32, 0.2, 0.32, p.main, glow) // lower cone
  box(g, 0, 0.37, -0.03, 0.2, 0.18, 0.2, p.main, glow) // mid cone
  box(g, 0, 0.52, -0.06, 0.11, 0.18, 0.11, p.main, glow) // upper cone
  box(g, 0, 0.64, -0.1, 0.05, 0.1, 0.05, p.accent, glow) // bent tip
  return g
}

function buildRobe(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  box(g, 0, 0.36, 0, 0.46, 0.52, 0.26, p.main, glow) // robe torso
  box(g, 0, 0.12, 0, 0.52, 0.22, 0.3, p.main, glow) // skirt flare
  box(g, 0, 0.42, 0.14, 0.1, 0.42, 0.02, p.light, glow) // front trim stripe
  box(g, 0.27, 0.5, 0, 0.12, 0.16, 0.27, p.dark, glow) // shoulder R
  box(g, -0.27, 0.5, 0, 0.12, 0.16, 0.27, p.dark, glow) // shoulder L
  box(g, 0, 0.6, 0, 0.3, 0.08, 0.22, p.dark) // collar
  box(g, 0, 0.2, 0, 0.5, 0.06, 0.3, p.accent, glow) // mana sash
  box(g, 0, 0.2, 0.16, 0.06, 0.06, 0.02, p.light, glow) // sash gem
  return g
}

function buildSlippers(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  for (const s of [1, -1]) {
    const x = s * 0.15
    box(g, x, 0.05, 0.03, 0.15, 0.1, 0.32, p.main, glow) // slipper body
    box(g, x, 0.04, 0.21, 0.12, 0.07, 0.1, p.main, glow) // toe
    box(g, x, 0.11, 0.27, 0.05, 0.08, 0.05, p.accent, glow) // curled tip
    box(g, x, 0.14, -0.05, 0.13, 0.08, 0.14, p.dark) // ankle cuff
  }
  return g
}

// ===========================================================================
// NEW ARMOR FAMILIES (content-phase foundation).
//
// Seven extra set styles beyond plate / ranger-leather / mage-cloth. Each set
// has a helm / chest / boots builder, keyed by its own family prefix (one
// prefix per piece — see SLOT_BY_PREFIX in inventory/defs.ts and the dispatch
// switch at the bottom of this file). All share the plate set's body-wrapping
// sizing (big 0.72 head, broad torso, hip-length greaves) so none of them
// leaves the character poking out, and all tint from pal(t) so they render at
// every material tier (copper..runic). Content packs mint `<prefix>_<tier>`.
//
//   family      helm         chest         boots
//   knight      greathelm    cuirass       sabatons
//   samurai     kabuto       doumaru       suneate
//   barbarian   horned       furplate      furboots
//   royal       crown        regalia       regalboots
//   assassin    cowl         shroud        creepers
//   shaman      totemmask    spiritweave   spiritboots
//   dragoon     wyrmhelm     wyrmscale     wyrmboots
// ---------------------------------------------------------------------------

const BONE = 0xe8dcc2
const DARK_CLOTH = 0x26242e
const DARK_CLOTH_2 = 0x16151a
const FUR_LIGHT = 0x6a4a30

/** Shared heavy greaves (hip-length, fully wrapping) used by several sets. */
function greaves(
  g: THREE.Group, p: TierPalette, glow: VoxOpts,
  soleColor: number, footColor: number
): void {
  for (const s of [1, -1]) {
    const x = s * 0.15
    box(g, x, 0.03, 0.05, 0.2, 0.04, 0.38, soleColor) // sole
    box(g, x, 0.11, 0.09, 0.18, 0.12, 0.32, footColor, glow) // foot
    box(g, x, 0.27, -0.01, 0.21, 0.4, 0.24, p.main, glow) // greave
    box(g, x, 0.46, -0.01, 0.23, 0.08, 0.26, p.light, glow) // thigh cuff
  }
}

// --- KNIGHT — heavy plate: visored great helm, bulked cuirass, sabatons ----

function buildGreathelm(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  box(g, 0, 0.08, 0, 0.58, 0.42, 0.58, p.main, glow) // big bucket skull
  box(g, 0, 0.32, 0, 0.5, 0.16, 0.5, p.light, glow) // flat crown
  box(g, 0, -0.03, 0.31, 0.5, 0.28, 0.05, p.dark, glow) // visor face
  box(g, 0, 0.0, 0.345, 0.4, 0.035, 0.02, 0x14161c) // visor sight slit
  box(g, 0, -0.12, 0, 0.6, 0.08, 0.6, p.dark, glow) // brim overhang
  box(g, 0, 0.48, -0.02, 0.07, 0.22, 0.16, p.accent, glow) // crest fin
  box(g, 0, 0.3, -0.3, 0.07, 0.14, 0.14, p.accent, glow) // crest tail
  return g
}

function buildCuirass(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  box(g, 0, 0.3, 0, 0.6, 0.66, 0.4, p.main, glow) // heavy torso (wraps body)
  box(g, 0, 0.44, 0.21, 0.4, 0.3, 0.02, p.light, glow) // breastplate ridge
  box(g, 0.36, 0.56, 0, 0.22, 0.18, 0.36, p.dark, glow) // big pauldron R
  box(g, -0.36, 0.56, 0, 0.22, 0.18, 0.36, p.dark, glow) // big pauldron L
  box(g, 0.38, 0.64, 0, 0.1, 0.08, 0.2, p.accent, glow) // pauldron spike R
  box(g, -0.38, 0.64, 0, 0.1, 0.08, 0.2, p.accent, glow) // pauldron spike L
  box(g, 0, 0.62, 0, 0.34, 0.08, 0.22, p.dark) // gorget collar
  box(g, 0, 0.04, 0, 0.56, 0.12, 0.36, p.dark, glow) // fauld (waist plate)
  return g
}

function buildSabatons(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  for (const s of [1, -1]) {
    const x = s * 0.15
    box(g, x, 0.03, 0.08, 0.2, 0.05, 0.44, p.dark, glow) // pointed armored sole
    box(g, x, 0.03, 0.3, 0.14, 0.05, 0.1, p.accent, glow) // pointed toe
    box(g, x, 0.12, 0.08, 0.19, 0.14, 0.32, p.main, glow) // armored foot
    box(g, x, 0.27, -0.01, 0.21, 0.4, 0.24, p.main, glow) // greave
    box(g, x, 0.3, 0.1, 0.06, 0.1, 0.03, p.accent, glow) // knee cop
    box(g, x, 0.46, -0.01, 0.23, 0.08, 0.26, p.light, glow) // thigh cuff
  }
  return g
}

// --- SAMURAI — kabuto, lamellar do, suneate --------------------------------

function buildKabuto(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  box(g, 0, 0.08, 0, 0.54, 0.34, 0.54, p.main, glow) // bowl
  box(g, 0, 0.28, 0, 0.44, 0.12, 0.44, p.light, glow) // riveted crown
  box(g, 0, -0.1, -0.02, 0.72, 0.1, 0.52, p.dark, glow) // flared neck guard (shikoro)
  box(g, 0, -0.14, 0.28, 0.5, 0.14, 0.08, p.dark, glow) // front flare
  for (const s of [1, -1]) {
    box(g, s * 0.16, 0.42, 0.12, 0.05, 0.26, 0.05, p.accent, glow) // golden horn (kuwagata)
  }
  box(g, 0, 0.1, 0.3, 0.12, 0.14, 0.05, p.dark) // menpo (face mask)
  box(g, 0, 0.0, 0.32, 0.08, 0.06, 0.03, p.accent) // mask snarl
  return g
}

function buildDoumaru(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  box(g, 0, 0.3, 0, 0.56, 0.64, 0.38, p.dark, glow) // lacquered under-torso
  for (const y of [0.1, 0.24, 0.38, 0.52]) {
    box(g, 0, y, 0.2, 0.5, 0.09, 0.03, p.main, glow) // lamellar plate row
  }
  box(g, 0.3, 0.52, 0, 0.16, 0.2, 0.3, p.main, glow) // sode (shoulder) R
  box(g, -0.3, 0.52, 0, 0.16, 0.2, 0.3, p.main, glow) // sode (shoulder) L
  box(g, 0, 0.1, 0, 0.5, 0.1, 0.34, LEATHER) // obi sash
  box(g, 0, 0.1, 0.17, 0.09, 0.1, 0.03, p.accent, glow) // sash knot
  return g
}

function buildSuneate(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  for (const s of [1, -1]) {
    const x = s * 0.15
    box(g, x, 0.03, 0.05, 0.18, 0.04, 0.36, LEATHER) // sole
    box(g, x, 0.11, 0.09, 0.16, 0.12, 0.3, p.dark, glow) // tabi foot
    box(g, x, 0.27, -0.01, 0.2, 0.4, 0.22, p.dark, glow) // shin splint base
    for (const sp of [-0.05, 0.05]) {
      box(g, x + sp, 0.3, 0.1, 0.03, 0.34, 0.03, p.main, glow) // vertical splint
    }
    box(g, x, 0.46, -0.01, 0.22, 0.08, 0.24, p.light, glow) // knee cuff
  }
  return g
}

// --- BARBARIAN — horned fur helm, fur harness, fur boots -------------------

function buildHorned(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  box(g, 0, 0.1, 0, 0.52, 0.32, 0.52, FUR_LIGHT) // fur cap
  box(g, 0, -0.02, 0, 0.56, 0.1, 0.56, LEATHER_DARK) // fur brim
  for (const s of [1, -1]) {
    box(g, s * 0.26, 0.2, -0.02, 0.09, 0.2, 0.09, p.light, glow) // horn base
    box(g, s * 0.34, 0.36, -0.04, 0.07, 0.16, 0.07, p.main, glow) // horn mid
    box(g, s * 0.39, 0.48, -0.02, 0.06, 0.12, 0.06, p.accent, glow) // horn tip
  }
  box(g, 0, 0.28, -0.06, 0.2, 0.16, 0.2, FUR_LIGHT) // top fur tuft
  box(g, 0, 0.08, 0.24, 0.1, 0.1, 0.03, p.accent, glow) // brow stud
  return g
}

function buildFurplate(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  box(g, 0, 0.3, 0, 0.58, 0.64, 0.38, LEATHER_DARK) // fur vest torso (wraps body)
  box(g, 0, 0.4, 0.18, 0.5, 0.42, 0.04, FUR_LIGHT) // shaggy front pelt
  box(g, 0.28, 0.54, 0, 0.16, 0.16, 0.3, BONE) // bone pauldron R
  box(g, -0.28, 0.54, 0, 0.16, 0.16, 0.3, BONE) // bone pauldron L
  box(g, 0, 0.5, 0.2, 0.06, 0.18, 0.04, p.main, glow) // tier medallion
  box(g, 0, 0.1, 0, 0.52, 0.1, 0.34, LEATHER) // wide belt
  box(g, 0, 0.1, 0.17, 0.1, 0.1, 0.03, p.accent, glow) // tier buckle
  return g
}

function buildFurboots(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  for (const s of [1, -1]) {
    const x = s * 0.15
    box(g, x, 0.03, 0.05, 0.18, 0.04, 0.36, 0x3a2a1a) // sole
    box(g, x, 0.13, 0.09, 0.17, 0.16, 0.3, LEATHER) // hide foot
    box(g, x, 0.3, -0.01, 0.21, 0.36, 0.24, FUR_LIGHT) // shaggy fur leg
    box(g, x, 0.46, -0.01, 0.23, 0.1, 0.26, LEATHER_DARK) // fur cuff
    box(g, x, 0.24, 0.13, 0.04, 0.1, 0.03, p.accent, glow) // tier strap stud
  }
  return g
}

// --- ROYAL — crown, gilded regalia, jeweled boots --------------------------

function buildCrown(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  box(g, 0, 0.06, 0, 0.5, 0.32, 0.5, 0x3a2a5a) // velvet cap (under crown)
  box(g, 0, -0.02, 0, 0.56, 0.14, 0.56, p.main, glow) // gold band
  for (const x of [-0.18, -0.06, 0.06, 0.18]) {
    box(g, x, 0.14, 0.24, 0.05, 0.14, 0.05, p.main, glow) // front point
    box(g, x, 0.22, 0.24, 0.04, 0.04, 0.04, p.accent, glow) // point jewel
  }
  box(g, 0, 0.2, 0.26, 0.06, 0.2, 0.06, p.light, glow) // tall center point
  box(g, 0, 0.31, 0.28, 0.06, 0.06, 0.05, p.accent, glow) // crown jewel
  return g
}

function buildRegalia(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  box(g, 0, 0.3, -0.21, 0.5, 0.6, 0.04, 0x7a2a4a) // royal cape (behind)
  box(g, 0, 0.3, 0, 0.58, 0.64, 0.38, p.main, glow) // gilded torso
  box(g, 0, 0.44, 0.2, 0.12, 0.42, 0.03, p.light, glow) // jeweled center stripe
  box(g, 0.1, 0.5, 0.21, 0.05, 0.05, 0.03, p.accent, glow) // jewel R
  box(g, -0.1, 0.5, 0.21, 0.05, 0.05, 0.03, p.accent, glow) // jewel L
  box(g, 0.32, 0.58, 0, 0.18, 0.12, 0.34, p.light, glow) // ornate epaulette R
  box(g, -0.32, 0.58, 0, 0.18, 0.12, 0.34, p.light, glow) // ornate epaulette L
  box(g, 0, 0.64, 0, 0.34, 0.1, 0.24, 0x7a2a4a) // high fur collar
  box(g, 0, 0.08, 0, 0.54, 0.1, 0.34, p.dark) // gilt belt
  return g
}

function buildRegalboots(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  greaves(g, p, glow, p.dark, p.main)
  for (const s of [1, -1]) {
    const x = s * 0.15
    box(g, x, 0.11, 0.24, 0.06, 0.06, 0.04, p.accent, glow) // toe jewel
    box(g, x, 0.46, 0.11, 0.06, 0.06, 0.03, p.accent, glow) // cuff jewel
  }
  return g
}

// --- ASSASSIN — cowl + mask, wrapped shroud, soft creepers -----------------

function buildCowl(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  box(g, 0, 0.14, -0.02, 0.44, 0.32, 0.44, DARK_CLOTH) // hood shell
  box(g, 0, 0.32, -0.06, 0.3, 0.16, 0.32, DARK_CLOTH_2) // crown fold
  box(g, 0, 0.16, 0.2, 0.34, 0.3, 0.06, DARK_CLOTH_2) // shadowed face opening
  box(g, 0, 0.1, 0.23, 0.3, 0.14, 0.04, 0x3a3842) // mask over nose/mouth
  for (const s of [1, -1]) {
    box(g, s * 0.06, 0.2, 0.25, 0.05, 0.03, 0.02, p.accent, glow) // glowing eye
  }
  box(g, 0, 0.04, 0, 0.46, 0.05, 0.44, p.dark, glow) // tier trim band
  box(g, 0, 0.36, -0.2, 0.08, 0.1, 0.12, DARK_CLOTH_2) // droop tip
  return g
}

function buildShroud(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  box(g, 0, 0.3, 0, 0.56, 0.62, 0.36, DARK_CLOTH) // wrapped torso (full body)
  box(g, 0, 0.3, -0.19, 0.46, 0.56, 0.04, DARK_CLOTH_2) // back cloak
  box(g, -0.06, 0.4, 0.17, 0.3, 0.46, 0.03, DARK_CLOTH_2) // diagonal chest wrap
  box(g, 0.26, 0.5, 0, 0.12, 0.3, 0.26, DARK_CLOTH_2) // shoulder wrap R
  box(g, -0.26, 0.5, 0, 0.12, 0.3, 0.26, DARK_CLOTH_2) // shoulder wrap L
  box(g, 0, 0.1, 0, 0.5, 0.08, 0.3, DARK_CLOTH_2) // sash belt
  box(g, -0.14, 0.14, 0.17, 0.05, 0.14, 0.03, p.main, glow) // tucked dagger hilt (tier)
  box(g, 0.16, 0.44, 0.15, 0.04, 0.04, 0.02, p.accent, glow) // tier buckle stud
  return g
}

function buildCreepers(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  for (const s of [1, -1]) {
    const x = s * 0.15
    box(g, x, 0.03, 0.05, 0.16, 0.04, 0.34, DARK_CLOTH_2) // soft sole
    box(g, x, 0.11, 0.08, 0.15, 0.12, 0.28, DARK_CLOTH) // wrapped foot
    box(g, x, 0.28, -0.02, 0.16, 0.36, 0.2, DARK_CLOTH) // tall shin wrap
    box(g, x, 0.44, -0.01, 0.17, 0.06, 0.22, DARK_CLOTH_2) // top fold
    box(g, x, 0.2, 0.12, 0.04, 0.04, 0.03, p.accent, glow) // tier anklet charm
  }
  return g
}

// --- SHAMAN — totem mask, woven spirit robe, hide boots --------------------

function buildTotemmask(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  box(g, 0, 0.1, 0, 0.5, 0.42, 0.42, WOOD) // carved wood mask head
  box(g, 0, 0.1, 0.22, 0.42, 0.34, 0.05, 0x8a6a3a) // mask face front
  for (const s of [1, -1]) {
    box(g, s * 0.1, 0.16, 0.25, 0.08, 0.06, 0.02, p.main, glow) // tier eye gem
  }
  box(g, 0, 0.0, 0.26, 0.12, 0.08, 0.03, 0x4a3522) // snarling mouth
  box(g, 0, 0.36, -0.02, 0.4, 0.1, 0.12, BONE) // bone crest row
  for (const x of [-0.14, 0, 0.14]) {
    box(g, x, 0.5, -0.06, 0.04, 0.2, 0.02, x === 0 ? p.accent : 0xd94a3a, x === 0 ? glow : undefined) // feather
  }
  box(g, 0, 0.3, 0.2, 0.06, 0.08, 0.04, p.accent, glow) // forehead gem
  return g
}

function buildSpiritweave(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  box(g, 0, 0.32, 0, 0.56, 0.6, 0.36, 0x4a5a3f) // woven robe torso (wraps body)
  box(g, 0, 0.12, 0, 0.52, 0.24, 0.3, 0x3f4a35) // skirt flare
  box(g, 0, 0.44, 0.16, 0.4, 0.3, 0.03, 0x6a7a4f) // woven front panel
  box(g, 0.26, 0.52, 0, 0.14, 0.16, 0.28, BONE) // bone shoulder R
  box(g, -0.26, 0.52, 0, 0.14, 0.16, 0.28, BONE) // bone shoulder L
  box(g, 0, 0.5, 0.2, 0.06, 0.12, 0.05, p.main, glow) // tier spirit-gem pendant
  box(g, 0.14, 0.3, 0.17, 0.03, 0.2, 0.02, 0xd94a3a) // hanging red feather
  box(g, -0.14, 0.28, 0.17, 0.03, 0.18, 0.02, p.accent, glow) // tier charm
  box(g, 0, 0.1, 0, 0.5, 0.08, 0.32, LEATHER) // hide belt
  return g
}

function buildSpiritboots(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  for (const s of [1, -1]) {
    const x = s * 0.15
    box(g, x, 0.03, 0.05, 0.17, 0.04, 0.34, 0x3a2a1a) // sole
    box(g, x, 0.12, 0.08, 0.16, 0.14, 0.28, LEATHER) // hide foot
    box(g, x, 0.28, -0.02, 0.17, 0.36, 0.2, 0x4a5a3f) // woven wrap leg
    box(g, x, 0.44, -0.01, 0.18, 0.06, 0.22, BONE) // bone anklet ring
    box(g, x, 0.2, 0.12, 0.04, 0.04, 0.03, p.accent, glow) // tier spirit bead
  }
  return g
}

// --- DRAGOON — scaled dragon-knight set (crest, scales, clawed boots) -------

function buildWyrmhelm(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  box(g, 0, 0.06, 0, 0.54, 0.36, 0.54, p.main, glow) // scaled skull
  box(g, 0, 0.26, 0, 0.46, 0.16, 0.46, p.light, glow) // dome
  box(g, 0, -0.08, 0, 0.56, 0.08, 0.56, p.dark, glow) // brim
  box(g, 0, -0.02, 0.3, 0.1, 0.3, 0.05, p.dark) // face/nose guard
  box(g, 0, 0.42, -0.02, 0.05, 0.22, 0.3, p.accent, glow) // tall dragon crest
  box(g, 0, 0.3, -0.32, 0.05, 0.14, 0.16, p.accent, glow) // crest tail
  for (const s of [1, -1]) {
    box(g, s * 0.3, 0.2, -0.08, 0.1, 0.05, 0.26, p.light, glow) // swept wing-horn
  }
  return g
}

function buildWyrmscale(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  box(g, 0, 0.3, 0, 0.58, 0.64, 0.38, p.main, glow) // scaled torso (wraps body)
  for (const y of [0.12, 0.28, 0.44]) {
    box(g, 0, y, 0.2, 0.5, 0.06, 0.03, p.dark, glow) // overlapping scale row
  }
  box(g, 0.34, 0.56, 0, 0.18, 0.16, 0.32, p.dark, glow) // spiked pauldron R
  box(g, -0.34, 0.56, 0, 0.18, 0.16, 0.32, p.dark, glow) // spiked pauldron L
  box(g, 0.36, 0.64, 0, 0.06, 0.12, 0.1, p.accent, glow) // pauldron spike R
  box(g, -0.36, 0.64, 0, 0.06, 0.12, 0.1, p.accent, glow) // pauldron spike L
  for (const s of [1, -1]) {
    box(g, s * 0.2, 0.5, -0.2, 0.12, 0.3, 0.04, p.light, glow) // folded wing nub
  }
  box(g, 0, 0.6, 0, 0.3, 0.06, 0.2, p.dark) // collar
  box(g, 0, 0.08, 0, 0.52, 0.1, 0.34, p.dark) // belt
  return g
}

function buildWyrmboots(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  for (const s of [1, -1]) {
    const x = s * 0.15
    box(g, x, 0.11, 0.08, 0.18, 0.14, 0.3, p.main, glow) // scaled foot
    for (const cx of [-0.06, 0, 0.06]) {
      box(g, x + cx, 0.04, 0.26, 0.04, 0.05, 0.1, p.accent, glow) // dragon claw
    }
    box(g, x, 0.27, -0.01, 0.21, 0.4, 0.24, p.main, glow) // scaled greave
    box(g, x, 0.3, 0.1, 0.05, 0.3, 0.03, p.dark, glow) // shin scale ridge
    box(g, x, 0.46, -0.01, 0.23, 0.08, 0.26, p.light, glow) // thigh cuff
  }
  return g
}

// ---------------------------------------------------------------------------
// Mounts — ULTRA-RARE rideable voxel creatures (+40% move speed). Each faces
// +Z with its origin at the ground so it reads as a standing mount in the
// inventory viewer and under the player when ridden.
// ---------------------------------------------------------------------------

interface MountPal { body: number; dark: number; belly: number; accent: number; glow?: VoxOpts }

function mountPalOf(id: string): MountPal {
  const s = mountSpec(id)
  if (!s) return { body: 0x8a8a8a, dark: 0x5a5a5a, belly: 0xb0b0b0, accent: 0xe0e0e0 }
  const [b, d, be, a] = s.pal
  return { body: b, dark: d, belly: be, accent: a, ...(s.glow ? { glow: faintGlow(a) } : {}) }
}

/** Four legs at the body corners (quad/drake). */
function mountLegs(g: THREE.Group, p: MountPal, h: number): void {
  for (const sx of [1, -1]) for (const sz of [1, -1]) {
    box(g, sx * 0.17, h * 0.5, sz * 0.26, 0.11, h, 0.11, p.dark)
    box(g, sx * 0.17, 0.03, sz * 0.26, 0.13, 0.06, 0.15, p.accent) // hoof/paw
  }
}

/** Head-mounted features (antlers/horn/tusks/ears/plume/frill) at (hy, hz). */
function mountHeadFeatures(
  g: THREE.Group, p: MountPal, feats: readonly MountFeature[], hy: number, hz: number
): void {
  if (feats.includes('antlers')) for (const sx of [1, -1]) {
    box(g, sx * 0.08, hy + 0.22, hz - 0.04, 0.03, 0.22, 0.03, p.accent, p.glow)
    box(g, sx * 0.15, hy + 0.3, hz - 0.06, 0.12, 0.03, 0.03, p.accent, p.glow)
    box(g, sx * 0.09, hy + 0.36, hz - 0.1, 0.03, 0.09, 0.03, p.accent, p.glow)
  }
  if (feats.includes('horn')) box(g, 0, hy + 0.16, hz + 0.08, 0.05, 0.16, 0.06, p.accent, p.glow)
  if (feats.includes('tusks')) for (const sx of [1, -1]) box(g, sx * 0.1, hy - 0.06, hz + 0.14, 0.04, 0.04, 0.12, p.accent)
  if (feats.includes('ears')) for (const sx of [1, -1]) box(g, sx * 0.07, hy + 0.16, hz - 0.06, 0.05, 0.1, 0.04, p.body)
  if (feats.includes('plume')) box(g, 0, hy + 0.04, hz - 0.1, 0.22, 0.14, 0.06, p.accent, p.glow)
  if (feats.includes('frill')) box(g, 0, hy + 0.1, hz - 0.08, 0.32, 0.22, 0.04, p.accent, p.glow)
}

function buildMount(id: string): THREE.Group {
  const g = group()
  const p = mountPalOf(id)
  const s = mountSpec(id)
  const feats = s?.features ?? []
  const arch = s?.arch ?? 'quad'

  if (arch === 'raptor') {
    box(g, 0, 0.5, -0.04, 0.26, 0.3, 0.6, p.body, p.glow) // body
    box(g, 0, 0.72, 0.3, 0.2, 0.22, 0.24, p.body, p.glow) // neck base
    box(g, 0, 0.9, 0.42, 0.18, 0.18, 0.26, p.body, p.glow) // head
    box(g, 0, 0.9, 0.58, 0.1, 0.09, 0.12, p.belly) // snout
    box(g, 0.05, 0.95, 0.5, 0.03, 0.03, 0.03, 0x20242e) // eye R
    box(g, -0.05, 0.95, 0.5, 0.03, 0.03, 0.03, 0x20242e) // eye L
    box(g, 0, 0.42, -0.5, 0.1, 0.1, 0.5, p.dark) // tail
    box(g, 0, 0.42, -0.78, 0.07, 0.07, 0.2, p.accent, p.glow) // tail tip
    for (const sx of [1, -1]) {
      box(g, sx * 0.14, 0.26, 0.1, 0.1, 0.52, 0.12, p.dark) // thigh
      box(g, sx * 0.14, 0.03, 0.18, 0.12, 0.06, 0.2, p.accent) // foot
    }
    if (feats.includes('spikes')) for (const z of [-0.1, 0.1, 0.3]) box(g, 0, 0.72, z, 0.05, 0.12, 0.05, p.accent, p.glow)
    mountHeadFeatures(g, p, feats, 0.9, 0.42)
    return g
  }

  // quadruped base (wolf/boar/stag/steed/bear/ram/ox/cat/beetle + drake)
  box(g, 0, 0.56, 0, 0.3, 0.3, 0.74, p.body, p.glow) // barrel
  box(g, 0, 0.5, 0.1, 0.26, 0.2, 0.5, p.belly) // underbelly
  box(g, 0, 0.62, 0.44, 0.24, 0.24, 0.2, p.body, p.glow) // neck/chest
  box(g, 0, 0.74, 0.56, 0.2, 0.22, 0.24, p.body, p.glow) // head
  box(g, 0, 0.7, 0.7, 0.14, 0.12, 0.12, p.belly) // muzzle
  box(g, 0.07, 0.8, 0.64, 0.03, 0.03, 0.03, 0x20242e) // eye R
  box(g, -0.07, 0.8, 0.64, 0.03, 0.03, 0.03, 0x20242e) // eye L
  box(g, 0, 0.56, -0.42, 0.1, 0.1, 0.3, p.dark) // tail
  mountLegs(g, p, 0.5)

  if (feats.includes('mane')) {
    box(g, 0, 0.86, 0.42, 0.06, 0.16, 0.26, p.accent, p.glow) // neck mane
    box(g, 0, 0.56, -0.5, 0.05, 0.1, 0.16, p.accent, p.glow) // tail flag
  }
  if (feats.includes('spikes')) for (const z of [-0.2, 0, 0.2]) box(g, 0, 0.74, z, 0.05, 0.12, 0.05, p.accent, p.glow) // back spikes
  if (arch === 'drake') {
    for (const sx of [1, -1]) {
      box(g, sx * 0.28, 0.78, -0.02, 0.06, 0.04, 0.4, p.dark, p.glow) // wing arm
      box(g, sx * 0.44, 0.72, -0.06, 0.26, 0.02, 0.36, p.accent, p.glow) // wing membrane
    }
    box(g, 0, 0.56, -0.56, 0.08, 0.12, 0.1, p.accent, p.glow) // tail spade
  }
  mountHeadFeatures(g, p, feats, 0.74, 0.56)
  return g
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function buildPick(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  box(g, 0, 0.36, 0, 0.07, 0.72, 0.07, WOOD) // handle
  box(g, 0, 0.66, 0, 0.11, 0.1, 0.11, p.dark) // collar
  box(g, 0, 0.74, 0, 0.6, 0.09, 0.09, p.main, glow) // head bar
  box(g, 0.34, 0.74, 0, 0.09, 0.07, 0.07, p.light, glow) // point R
  box(g, -0.34, 0.74, 0, 0.09, 0.07, 0.07, p.light, glow) // point L
  return g
}

function buildHatchet(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  box(g, 0, 0.3, 0, 0.06, 0.6, 0.06, WOOD) // handle
  box(g, 0, 0.52, 0, 0.1, 0.12, 0.09, p.dark) // collar
  box(g, 0.15, 0.52, 0, 0.2, 0.16, 0.07, p.main, glow) // cheek
  box(g, 0.27, 0.52, 0, 0.05, 0.22, 0.08, p.light, glow) // edge
  return g
}

function buildRod(id: string): THREE.Group {
  const g = group()
  const fittings = id === 'rod_golden' ? pal(3) : id === 'rod_sturdy' ? pal(2) : pal(0)
  box(g, 0, 0.5, 0, 0.05, 1.0, 0.05, WOOD) // rod
  box(g, 0, 0.09, 0, 0.07, 0.18, 0.07, LEATHER) // grip
  box(g, 0, 0.24, 0.06, 0.09, 0.09, 0.08, fittings.main) // reel
  box(g, 0.06, 0.24, 0.1, 0.03, 0.03, 0.03, fittings.dark) // reel knob
  box(g, 0, 0.72, 0, 0.065, 0.06, 0.065, fittings.light) // line guide
  box(g, 0, 0.97, 0.14, 0.015, 0.015, 0.3, STRING) // line out
  box(g, 0, 0.75, 0.29, 0.015, 0.44, 0.015, STRING) // line down
  box(g, 0, 0.5, 0.29, 0.06, 0.04, 0.06, 0xd94a3a) // bobber bottom
  box(g, 0, 0.54, 0.29, 0.06, 0.04, 0.06, 0xf0f0ec) // bobber top
  return g
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

function buildOre(id: string): THREE.Group {
  const g = group()
  const fleck =
    id === 'ore_copper' ? { c: 0xb87333 } :
    id === 'ore_iron' ? { c: 0xb7bdc4 } :
    id === 'ore_gold' ? { c: 0xf2c14e } :
    { c: 0x9b59d0, o: faintGlow(0x9b59d0) }
  box(g, 0, 0.1, 0, 0.3, 0.2, 0.28, STONE)
  box(g, 0.12, 0.2, 0.05, 0.16, 0.14, 0.16, STONE_DARK)
  box(g, -0.1, 0.19, -0.05, 0.14, 0.12, 0.14, STONE)
  box(g, 0.05, 0.14, 0.14, 0.07, 0.07, 0.04, fleck.c, fleck.o)
  box(g, -0.09, 0.22, 0.03, 0.06, 0.06, 0.06, fleck.c, fleck.o)
  box(g, 0.14, 0.27, 0.02, 0.05, 0.05, 0.05, fleck.c, fleck.o)
  return g
}

function buildBar(id: string): THREE.Group {
  const g = group()
  const p = id === 'bar_copper' ? pal(0) : id === 'bar_iron' ? pal(1) : id === 'bar_steel' ? pal(2) : id === 'bar_gold' ? pal(3) : pal(5)
  const glow = tierOpts(p)
  box(g, 0, 0.07, 0, 0.42, 0.14, 0.22, p.main, glow)
  box(g, 0, 0.16, 0, 0.32, 0.05, 0.15, p.light, glow)
  return g
}

function buildCrystal(id: string): THREE.Group {
  const g = group()
  const p = pal(4)
  const glow = tierOpts(p)
  if (id === 'crystal_shard') {
    box(g, 0, 0.22, 0, 0.1, 0.44, 0.1, p.main, glow)
    box(g, 0, 0.46, 0, 0.05, 0.1, 0.05, p.light, glow)
    return g
  }
  if (id === 'crystal_cut') {
    box(g, 0, 0.2, 0, 0.22, 0.4, 0.22, p.main, glow)
    box(g, 0, 0.45, 0, 0.13, 0.14, 0.13, p.light, glow)
    box(g, 0, 0.02, 0, 0.26, 0.05, 0.26, p.dark, glow)
    return g
  }
  // crystal_raw — a shard cluster on rock
  box(g, 0, 0.05, 0, 0.32, 0.1, 0.28, STONE)
  box(g, 0, 0.35, 0, 0.13, 0.56, 0.13, p.main, glow)
  box(g, 0.13, 0.25, 0.05, 0.1, 0.36, 0.1, p.light, glow)
  box(g, -0.12, 0.2, -0.04, 0.09, 0.28, 0.09, p.dark, glow)
  return g
}

function buildLog(id: string): THREE.Group {
  const g = group()
  const bark = id === 'wood_pine' ? 0x5e4028 : id === 'wood_ancient' ? 0x4a3a2f : WOOD_DARK
  box(g, 0, 0.13, 0, 0.26, 0.26, 0.72, bark)
  box(g, 0, 0.13, 0.37, 0.2, 0.2, 0.03, WOOD_LIGHT) // end ring
  box(g, 0, 0.13, -0.37, 0.2, 0.2, 0.03, WOOD_LIGHT)
  box(g, 0.08, 0.27, 0.12, 0.07, 0.05, 0.18, bark) // bark bump
  if (id === 'wood_ancient') {
    box(g, -0.08, 0.27, -0.1, 0.12, 0.04, 0.2, 0x5a7a3f) // moss
    box(g, 0.14, 0.18, -0.2, 0.04, 0.1, 0.1, 0x5a7a3f)
  }
  return g
}

function buildHerb(id: string): THREE.Group {
  const g = group()
  const bloom =
    id === 'herb_red' ? { c: 0xd94a3a } :
    id === 'herb_blue' ? { c: 0x4a6fd9 } :
    id === 'herb_gold' ? { c: 0xf2c14e, o: faintGlow(0xf2c14e) } :
    { c: 0x8ed06a }
  box(g, 0, 0.16, 0, 0.04, 0.32, 0.04, LEAF_DARK) // stem
  box(g, 0.09, 0.22, 0.02, 0.13, 0.03, 0.08, LEAF) // leaf R
  box(g, -0.08, 0.16, -0.02, 0.12, 0.03, 0.07, LEAF) // leaf L
  box(g, 0, 0.35, 0, 0.11, 0.09, 0.11, bloom.c, bloom.o) // bloom
  return g
}

function buildFish(id: string): THREE.Group {
  if (id === 'fish_boot') return buildBoot()
  const g = group()
  const body =
    id === 'fish_trout' ? 0x8aa06a :
    id === 'fish_salmon' ? 0xe08a7a :
    id === 'fish_puffer' ? 0xd9c46a :
    id === 'fish_golden' ? 0xf2c14e :
    0x9ab4c0
  const glow = id === 'fish_golden' ? faintGlow(0xf2c14e) : undefined
  box(g, 0, 0.13, 0.02, 0.16, 0.2, 0.42, body, glow) // body
  box(g, 0, 0.13, 0.26, 0.1, 0.12, 0.08, body, glow) // snout
  box(g, 0, 0.13, -0.26, 0.04, 0.16, 0.12, body, glow) // tail fin
  box(g, 0, 0.26, 0, 0.03, 0.08, 0.16, body, glow) // dorsal fin
  box(g, 0.085, 0.17, 0.16, 0.025, 0.035, 0.035, 0x20242e) // eye R
  box(g, -0.085, 0.17, 0.16, 0.025, 0.035, 0.035, 0x20242e) // eye L
  if (id === 'fish_puffer') {
    box(g, 0, 0.3, 0.06, 0.04, 0.08, 0.04, 0xb09a3f) // spikes
    box(g, 0.1, 0.2, -0.08, 0.08, 0.04, 0.04, 0xb09a3f)
    box(g, -0.1, 0.2, 0.06, 0.08, 0.04, 0.04, 0xb09a3f)
  }
  return g
}

function buildBoot(): THREE.Group {
  const g = group()
  const worn = 0x6e5236
  box(g, 0, 0.04, 0.08, 0.18, 0.05, 0.4, 0x4a3522) // sole
  box(g, 0, 0.12, 0.12, 0.16, 0.12, 0.3, worn) // foot
  box(g, 0, 0.26, -0.04, 0.15, 0.22, 0.18, worn) // shaft
  box(g, 0, 0.38, -0.04, 0.17, 0.05, 0.2, 0x5a4229) // floppy cuff
  box(g, 0.04, 0.16, 0.26, 0.06, 0.06, 0.03, 0x3a2a1a) // hole patch
  return g
}

function buildHide(id: string): THREE.Group {
  const g = group()
  const base = id === 'hide_boar' ? 0x6e4f38 : id === 'hide_tough' ? 0x5a4430 : 0x8a7560
  const dark = id === 'hide_boar' ? 0x52392a : id === 'hide_tough' ? 0x423122 : 0x6b5a48
  box(g, 0, 0.04, 0, 0.56, 0.07, 0.5, base)
  box(g, 0.15, 0.085, 0.1, 0.14, 0.02, 0.12, dark)
  box(g, -0.14, 0.085, -0.12, 0.12, 0.02, 0.14, dark)
  box(g, 0, 0.06, 0.29, 0.2, 0.06, 0.1, base) // neck flap
  return g
}

function buildWheat(): THREE.Group {
  const g = group()
  const stalk = 0xd9b45a
  const head = 0xf2d27a
  const xs = [-0.08, 0, 0.08, 0.03] as const
  const zs = [0.02, -0.04, 0.03, 0.08] as const
  for (let i = 0; i < 4; i++) {
    box(g, xs[i]!, 0.2, zs[i]!, 0.03, 0.4, 0.03, stalk)
    box(g, xs[i]!, 0.44, zs[i]!, 0.06, 0.12, 0.06, head)
  }
  box(g, 0, 0.14, 0.02, 0.28, 0.06, 0.16, LEATHER) // twine band
  return g
}

// ---------------------------------------------------------------------------
// Consumables
// ---------------------------------------------------------------------------

function buildPotion(id: string): THREE.Group {
  const g = group()
  // craft-expansion themed brews get their own tints; everything else falls
  // back to the hp(red)/mp(blue)/elixir/regret/mystery buckets.
  const THEMED: Record<string, number> = {
    potion_emberbrew: 0xff6a2a,
    potion_tidebrew: 0x2fb6c8,
    potion_mossmend: 0x5aa83f,
    potion_starwater: 0x5a6ae0,
    potion_ironblood: 0x8a1f2a,
    potion_dreamfizz: 0x9a5aba,
    potion_voidsip: 0x3a2a5a,
    potion_sunsap: 0xf2c14e,
    potion_dualcask: 0x8a3fb0,
    potion_phoenixdraught: 0xff8a2a,
    potion_secondwind: 0x7ed9c0,
    potion_warcry: 0xe0603a,
    potion_adrenagel: 0xd94a6a,
  }
  const liquid =
    THEMED[id] ??
    (id.startsWith('potion_hp') ? 0xd93a4a :
    id.startsWith('potion_mp') ? 0x3a6fd9 :
    id === 'potion_elixir' ? 0xf2c14e :
    id === 'potion_regret' ? 0x8a8d93 :
    0x6fc24a) // mystery
  const size =
    id.endsWith('_small') || id === 'potion_regret' ? 0.8 :
    id.endsWith('_large') || id.endsWith('_grand') ? 1.2 :
    id.endsWith('_huge') || id === 'potion_elixir' || id === 'potion_phoenixdraught' ? 1.45 :
    1.0
  const glow =
    id === 'potion_phoenixdraught' ? { emissive: 0xff8a2a, emissiveIntensity: 0.45, opacity: 0.85 } :
    id === 'potion_elixir' ? { emissive: 0xf2c14e, emissiveIntensity: 0.3, opacity: 0.8 } :
    { opacity: 0.8 }
  const s = size
  box(g, 0, 0.14 * s, 0, 0.26 * s, 0.26 * s, 0.26 * s, liquid, glow) // body
  box(g, 0, 0.3 * s, 0, 0.17 * s, 0.07 * s, 0.17 * s, liquid, glow) // shoulder
  box(g, 0, 0.38 * s, 0, 0.1 * s, 0.1 * s, 0.1 * s, 0xcfd8dc, { opacity: 0.6 }) // neck glass
  box(g, 0, 0.46 * s, 0, 0.09 * s, 0.07 * s, 0.09 * s, WOOD) // cork
  return g
}

function buildFood(id: string): THREE.Group {
  const g = group()
  switch (id) {
    case 'food_bread':
      box(g, 0, 0.1, 0, 0.4, 0.2, 0.24, 0xc98f4e)
      box(g, 0, 0.22, 0, 0.34, 0.06, 0.2, 0xe0b06a)
      box(g, 0.07, 0.26, 0, 0.04, 0.02, 0.16, 0xa06c38)
      box(g, -0.07, 0.26, 0, 0.04, 0.02, 0.16, 0xa06c38)
      return g
    case 'food_apple':
      box(g, 0, 0.12, 0, 0.24, 0.22, 0.24, 0xd93a3a)
      box(g, 0, 0.26, 0, 0.03, 0.08, 0.03, WOOD_DARK)
      box(g, 0.06, 0.29, 0, 0.1, 0.02, 0.06, LEAF)
      return g
    case 'food_cheese':
      box(g, 0, 0.08, 0, 0.34, 0.16, 0.3, 0xf0c75e)
      box(g, 0, 0.2, -0.03, 0.26, 0.09, 0.22, 0xf0c75e)
      box(g, 0.08, 0.1, 0.15, 0.05, 0.05, 0.02, 0xc29a35)
      box(g, -0.07, 0.07, 0.15, 0.04, 0.04, 0.02, 0xc29a35)
      return g
    case 'food_skewer':
    case 'food_kebab': {
      const n = id === 'food_kebab' ? 4 : 3
      box(g, 0, 0.3, 0, 0.03, 0.6, 0.03, WOOD)
      for (let i = 0; i < n; i++) {
        const c = i % 2 === 1 ? 0x6aa84f : 0x9a5a3a
        box(g, 0, 0.16 + i * 0.12, 0, 0.13, 0.1, 0.13, c)
      }
      return g
    }
    case 'food_fish': {
      box(g, 0, 0.1, 0, 0.14, 0.14, 0.4, 0x8a6a4a) // grilled body
      box(g, 0, 0.1, -0.24, 0.04, 0.12, 0.1, 0x8a6a4a)
      box(g, 0, 0.18, 0.05, 0.145, 0.02, 0.08, 0x4a3522) // char stripe
      box(g, 0, 0.18, -0.08, 0.145, 0.02, 0.08, 0x4a3522)
      return g
    }
    case 'food_jerky':
      box(g, 0, 0.04, 0, 0.14, 0.05, 0.4, 0x7a4a2d)
      box(g, 0, 0.09, 0.14, 0.12, 0.05, 0.14, 0x6b3f25)
      return g
    case 'food_honey':
      box(g, 0, 0.13, 0, 0.24, 0.26, 0.24, 0xe0a63a, { opacity: 0.85 })
      box(g, 0, 0.29, 0, 0.26, 0.05, 0.26, WOOD)
      box(g, 0, 0.13, 0.125, 0.14, 0.12, 0.01, 0xf0e8d0)
      return g
    case 'food_stew':
      box(g, 0, 0.08, 0, 0.32, 0.16, 0.32, 0x6b4a2d) // bowl
      box(g, 0, 0.17, 0, 0.25, 0.04, 0.25, 0x9a5a3a) // stew
      box(g, 0.06, 0.19, 0.04, 0.06, 0.03, 0.06, 0xd9b45a) // dumpling
      box(g, 0.11, 0.26, -0.06, 0.03, 0.16, 0.03, 0xcfd6de) // spoon
      return g
    case 'food_pie':
      box(g, 0, 0.07, 0, 0.34, 0.14, 0.34, 0xc98f4e)
      box(g, 0, 0.16, 0, 0.36, 0.05, 0.36, 0xe0b06a)
      box(g, 0, 0.19, 0, 0.1, 0.02, 0.04, 0x6b3f25) // vent
      return g
    case 'food_jelly':
      box(g, 0, 0.14, 0, 0.28, 0.28, 0.28, 0x7ed957, { opacity: 0.7 })
      box(g, 0, 0.12, 0, 0.14, 0.14, 0.14, 0x5aa83f, { opacity: 0.85 }) // core
      return g
    case 'food_block':
      box(g, 0, 0.17, 0, 0.03, 0.34, 0.03, 0xf0f0ec) // stick
      box(g, 0, 0.44, 0, 0.2, 0.2, 0.2, 0xf2a93b, faintGlow(0xf2a93b)) // BLOCK cube
      box(g, 0, 0.44, 0.102, 0.1, 0.1, 0.01, 0xfff0d0) // face glint
      return g
    case 'food_cake':
      box(g, 0, 0.08, 0, 0.34, 0.16, 0.34, 0xf0dcc8)
      box(g, 0, 0.21, 0, 0.3, 0.1, 0.3, 0xd98a9a)
      box(g, 0, 0.28, 0, 0.3, 0.04, 0.3, 0xf8f0f0)
      box(g, 0, 0.33, 0, 0.06, 0.06, 0.06, 0xd93a3a) // cherry
      return g
    case 'food_pufferfish':
      box(g, 0, 0.03, 0, 0.4, 0.04, 0.4, 0xdfe6ea) // plate
      box(g, -0.08, 0.08, 0, 0.1, 0.05, 0.24, 0xf0b8b0) // sashimi slices
      box(g, 0.04, 0.08, 0.05, 0.1, 0.05, 0.24, 0xf0c4bc)
      box(g, 0.14, 0.08, -0.06, 0.08, 0.04, 0.2, 0xf0b8b0)
      return g
    case 'food_feast':
      box(g, 0, 0.04, 0, 0.5, 0.06, 0.44, 0xf2c14e, faintGlow(0xf2c14e)) // gold platter
      box(g, 0, 0.16, 0, 0.26, 0.18, 0.22, 0xb0703a) // roast
      box(g, 0.1, 0.27, 0.05, 0.04, 0.06, 0.04, 0xf0e8d0) // bone R
      box(g, -0.1, 0.27, 0.05, 0.04, 0.06, 0.04, 0xf0e8d0) // bone L
      box(g, 0.19, 0.1, 0.12, 0.08, 0.07, 0.08, 0xd93a3a) // apple side
      box(g, -0.18, 0.1, -0.1, 0.1, 0.06, 0.08, 0x7ed957) // greens
      return g
    case 'food_burnt':
      box(g, 0, 0.1, 0, 0.26, 0.18, 0.22, 0x2e2a28)
      box(g, 0.09, 0.2, 0.05, 0.1, 0.08, 0.1, 0x1a1817)
      box(g, -0.08, 0.17, -0.05, 0.08, 0.1, 0.08, 0x1a1817)
      box(g, 0.02, 0.13, 0.11, 0.03, 0.03, 0.02, 0xd94a2b, faintGlow(0xd94a2b)) // ember
      return g

    // --- craft-expansion dishes (The Wandering Artificer) ----------------
    case 'food_omelette_deluxe':
      box(g, 0, 0.05, 0, 0.36, 0.08, 0.3, 0xf2d872) // folded egg
      box(g, 0, 0.12, 0.02, 0.22, 0.06, 0.2, 0xf6e49a) // fold highlight
      box(g, 0.06, 0.14, 0.04, 0.05, 0.04, 0.05, 0x7a4a2d) // mushroom bit
      box(g, -0.07, 0.13, -0.03, 0.05, 0.03, 0.05, 0x5aa83f) // herb
      return g
    case 'food_crab_cakes':
      box(g, -0.08, 0.07, 0, 0.18, 0.14, 0.18, 0xd98a52) // cake 1
      box(g, 0.1, 0.06, 0.03, 0.16, 0.12, 0.16, 0xc97a44) // cake 2
      box(g, -0.08, 0.15, 0, 0.14, 0.02, 0.14, 0xf0c090) // crumb top
      box(g, 0.02, 0.17, -0.02, 0.05, 0.02, 0.05, 0xe8605a) // crab fleck
      return g
    case 'food_dragon_chili':
      box(g, 0, 0.08, 0, 0.3, 0.16, 0.3, 0x3a2a24) // dark bowl
      box(g, 0, 0.17, 0, 0.24, 0.05, 0.24, 0x9a2a1a) // chili
      box(g, 0.06, 0.2, 0.04, 0.04, 0.03, 0.04, 0xf2a93b) // bean
      box(g, 0, 0.24, 0, 0.05, 0.08, 0.02, 0xff5a2b, faintGlow(0xff5a2b)) // flame curl
      return g
    case 'food_frostberry_pie':
      box(g, 0, 0.07, 0, 0.34, 0.14, 0.34, 0xcfe4ef) // frosted crust
      box(g, 0, 0.16, 0, 0.36, 0.05, 0.36, 0xeaf4fb) // icing lid
      box(g, 0.08, 0.2, 0.06, 0.05, 0.05, 0.05, 0x8a4a9a) // berry
      box(g, -0.06, 0.2, -0.05, 0.05, 0.05, 0.05, 0x6a3a8a) // berry
      return g
    case 'food_mushroom_risotto':
      box(g, 0, 0.08, 0, 0.32, 0.16, 0.32, 0xdfe6ea) // white bowl
      box(g, 0, 0.17, 0, 0.25, 0.05, 0.25, 0xf0e8cf) // creamy rice
      box(g, 0.07, 0.2, 0.03, 0.06, 0.05, 0.06, 0x8a6a4a) // mushroom cap
      box(g, -0.06, 0.2, -0.05, 0.05, 0.04, 0.05, 0x9a7a5a)
      return g
    case 'food_royal_roast':
      box(g, 0, 0.04, 0, 0.5, 0.06, 0.4, 0xdfe6ea) // silver platter
      box(g, 0, 0.17, 0, 0.3, 0.2, 0.24, 0x9a5a34) // big roast
      box(g, 0, 0.3, 0, 0.3, 0.05, 0.24, 0xb87a4a) // glaze top
      box(g, 0.12, 0.3, 0.06, 0.04, 0.07, 0.04, 0xf0e8d0) // bone R
      box(g, -0.12, 0.3, 0.06, 0.04, 0.07, 0.04, 0xf0e8d0) // bone L
      return g
    case 'food_sea_platter':
      box(g, 0, 0.03, 0, 0.44, 0.05, 0.4, 0xe8eef2) // shell plate
      box(g, -0.1, 0.09, 0.04, 0.12, 0.06, 0.26, 0xf0a0a0) // salmon
      box(g, 0.08, 0.09, -0.02, 0.1, 0.06, 0.24, 0xd98a6a) // trout
      box(g, 0.16, 0.08, 0.1, 0.06, 0.05, 0.06, 0xf2d872) // lemon
      return g
    case 'food_sugar_donut':
      box(g, 0, 0.1, 0, 0.3, 0.14, 0.3, 0xe0b06a) // ring body
      box(g, 0, 0.1, 0, 0.1, 0.16, 0.1, 0x0b0e14) // hole (dark)
      box(g, 0, 0.18, 0, 0.3, 0.03, 0.3, 0xf6c0d8) // pink glaze
      box(g, 0.08, 0.2, 0.05, 0.02, 0.02, 0.02, 0x6fe3e8) // sprinkle
      box(g, -0.07, 0.2, -0.04, 0.02, 0.02, 0.02, 0xf2d872) // sprinkle
      return g
    case 'food_trail_biscuit':
      box(g, 0, 0.07, 0, 0.26, 0.12, 0.26, 0xc9a86a) // square biscuit
      box(g, 0, 0.14, 0, 0.2, 0.02, 0.2, 0xb08c4e)
      box(g, 0.05, 0.14, 0.05, 0.02, 0.03, 0.02, 0x6b4a2d) // fork dimple
      box(g, -0.05, 0.14, -0.05, 0.02, 0.03, 0.02, 0x6b4a2d)
      return g
    case 'food_spicy_noodles':
      box(g, 0, 0.07, 0, 0.32, 0.14, 0.32, 0xd93a3a) // red bowl
      box(g, 0, 0.16, 0, 0.26, 0.05, 0.26, 0xf0d060) // noodles
      box(g, 0.02, 0.22, 0, 0.14, 0.04, 0.03, 0xeec84a) // noodle lift
      box(g, 0.12, 0.26, -0.05, 0.03, 0.18, 0.03, 0x6b3f25) // chopstick
      box(g, 0.16, 0.26, -0.03, 0.03, 0.18, 0.03, 0x6b3f25) // chopstick
      return g
    case 'food_berry_parfait':
      box(g, 0, 0.14, 0, 0.18, 0.3, 0.18, 0xd8c0e8, { opacity: 0.6 }) // glass
      box(g, 0, 0.08, 0, 0.14, 0.08, 0.14, 0x8a4a9a) // berry layer
      box(g, 0, 0.18, 0, 0.14, 0.06, 0.14, 0xf8f0f0) // cream layer
      box(g, 0, 0.3, 0, 0.06, 0.06, 0.06, 0xd93a5a) // berry crown
      return g
    case 'food_campfire_sausage':
      box(g, 0, 0.1, 0, 0.12, 0.12, 0.34, 0x8a4a2d) // sausage
      box(g, 0, 0.1, 0.0, 0.125, 0.02, 0.34, 0x5a2e1a) // char stripe
      box(g, 0, 0.02, -0.26, 0.02, 0.02, 0.5, WOOD) // skewer stick
      return g

    default:
      return buildFallback()
  }
}

// ---------------------------------------------------------------------------
// Accessories
// ---------------------------------------------------------------------------

function ringBase(g: THREE.Group, color: number, opts?: VoxOpts): void {
  // Hollow square band standing upright, face toward +Z.
  box(g, 0, 0.26, 0, 0.2, 0.05, 0.06, color, opts) // top
  box(g, 0, 0.05, 0, 0.2, 0.05, 0.06, color, opts) // bottom
  box(g, 0.1, 0.155, 0, 0.05, 0.26, 0.06, color, opts) // right
  box(g, -0.1, 0.155, 0, 0.05, 0.26, 0.06, color, opts) // left
}

function amuletBase(g: THREE.Group): void {
  // Chain loop (diamond of thin links) with the pendant hanging below center.
  box(g, 0, 0.62, 0, 0.3, 0.03, 0.03, 0xc9c9c9)
  box(g, 0.16, 0.48, 0, 0.03, 0.3, 0.03, 0xc9c9c9)
  box(g, -0.16, 0.48, 0, 0.03, 0.3, 0.03, 0xc9c9c9)
  box(g, 0.08, 0.36, 0, 0.18, 0.03, 0.03, 0xc9c9c9)
  box(g, -0.08, 0.36, 0, 0.18, 0.03, 0.03, 0xc9c9c9)
}

// ---------------------------------------------------------------------------
// Legendary accessories (endgame quest payoffs — see catalog.ts LEGENDARIES)
// ---------------------------------------------------------------------------

/** A draped cape on a shoulder yoke; tinted + faintly glowing per legendary. */
function buildCape(id: string): THREE.Group {
  const g = group()
  const ascended = id === 'cape_ascended'
  const cloth = ascended ? 0xf4ead0 : 0xe8c15a // radiant ivory vs Seal-gold
  const trim = ascended ? 0x9fe8ff : 0xb8860b
  const glow = faintGlow(ascended ? 0x9fe8ff : 0xffd98a)
  // shoulder yoke / clasp
  box(g, 0, 0.62, 0, 0.42, 0.07, 0.1, trim, glow)
  box(g, 0, 0.6, 0.06, 0.1, 0.1, 0.05, trim, glow) // clasp knot
  // the drape, tapering downward
  box(g, 0, 0.44, -0.02, 0.38, 0.22, 0.05, cloth)
  box(g, 0, 0.24, -0.03, 0.3, 0.22, 0.05, cloth)
  box(g, 0, 0.08, -0.04, 0.2, 0.18, 0.05, cloth)
  box(g, 0, 0.42, 0.015, 0.1, 0.5, 0.01, trim, glow) // center seam
  return g
}

/** A rune-struck raid sigil (token material): a glowing coin on edge. */
function buildToken(_id: string): THREE.Group {
  const g = group()
  const glow = faintGlow(0xffcb57)
  box(g, 0, 0.2, 0, 0.3, 0.3, 0.06, 0xb8860b) // coin body (standing on edge)
  box(g, 0, 0.2, 0.035, 0.2, 0.2, 0.01, 0xffcb57, glow) // engraved face
  box(g, 0, 0.2, 0.04, 0.06, 0.12, 0.01, 0x6a3a12) // rune slash
  return g
}

/** A floating heart-stone in a cut-crystal cradle — the Unending relic. */
function buildRelic(_id: string): THREE.Group {
  const g = group()
  const glow = faintGlow(0xff8a4a)
  // cradle arms
  box(g, 0.16, 0.22, 0, 0.05, 0.4, 0.05, 0x6cb8ff)
  box(g, -0.16, 0.22, 0, 0.05, 0.4, 0.05, 0x6cb8ff)
  box(g, 0, 0.04, 0, 0.3, 0.05, 0.1, 0x6cb8ff) // base
  // the warm heart, suspended + glowing
  box(g, 0, 0.3, 0, 0.18, 0.18, 0.18, 0xff8a4a, { emissive: 0xff8a4a, emissiveIntensity: 0.5 })
  box(g, 0, 0.3, 0.095, 0.08, 0.08, 0.01, 0xffd9b0, glow) // facet glint
  return g
}

/** Mini-boss trophy — a little voxel cup/statue on a pedestal, deterministically
 *  varied by the id (metal tint + crowning ornament) so every zone's trophy
 *  looks its own. One builder covers all ~980 trophy_* ids (no '?' fallback). */
function buildTrophy(id: string): THREE.Group {
  const g = group()
  let h = 2166136261 >>> 0
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  const METALS = [0xf4c430, 0xe8b923, 0xd4af37, 0xc0c0c0, 0xcd7f32, 0xb9f2ff, 0x9fe8d4, 0xff8fab]
  const metal = METALS[h % METALS.length]!
  const accent = METALS[(h >>> 5) % METALS.length]!
  const mglow = faintGlow(metal)
  const aglow = faintGlow(accent)
  box(g, 0, 0.04, 0, 0.42, 0.08, 0.42, 0x4a3b2a) // base
  box(g, 0, 0.14, 0, 0.3, 0.14, 0.3, 0x5a4a35) // pedestal
  box(g, 0, 0.3, 0, 0.08, 0.22, 0.08, metal, mglow) // stem
  box(g, 0, 0.46, 0, 0.3, 0.2, 0.22, metal, mglow) // bowl
  box(g, 0.18, 0.48, 0, 0.06, 0.16, 0.1, metal, mglow) // handle R
  box(g, -0.18, 0.48, 0, 0.06, 0.16, 0.1, metal, mglow) // handle L
  const orn = (h >>> 11) % 4
  const oy = 0.64
  if (orn === 0) box(g, 0, oy, 0, 0.1, 0.1, 0.1, accent, aglow) // orb
  else if (orn === 1) {
    box(g, 0, oy, 0, 0.16, 0.06, 0.16, accent, aglow) // star
    box(g, 0, oy, 0, 0.06, 0.16, 0.06, accent, aglow)
  } else if (orn === 2) box(g, 0, oy + 0.04, 0, 0.05, 0.2, 0.05, accent, aglow) // spike
  else box(g, 0, oy, 0, 0.12, 0.12, 0.12, accent, aglow) // cube
  return g
}

function buildAccessory(id: string): THREE.Group {
  const g = group()
  switch (id) {
    case 'ring_participation':
      ringBase(g, 0x9aa0a8)
      box(g, 0, 0.31, 0.02, 0.08, 0.06, 0.05, 0xbfc5cc) // sad little stone
      return g
    case 'ring_onion':
      ringBase(g, 0xe0c08a)
      box(g, 0, 0.155, 0.035, 0.16, 0.16, 0.01, 0xf0dcb0) // inner ring layer
      box(g, 0, 0.31, 0, 0.04, 0.08, 0.04, LEAF) // sprout
      return g
    case 'ring_mood':
      ringBase(g, 0x6a5a7a)
      box(g, 0, 0.31, 0.02, 0.09, 0.08, 0.06, 0x8a7aa0, faintGlow(0x8a7aa0)) // moody gem
      return g
    case 'acc_lucky_rock':
      box(g, 0, 0.1, 0, 0.26, 0.2, 0.24, STONE)
      box(g, 0.08, 0.21, 0.04, 0.12, 0.08, 0.12, STONE_DARK)
      box(g, -0.05, 0.14, 0.12, 0.04, 0.04, 0.02, 0x20242e) // disapproving eye
      box(g, 0.05, 0.14, 0.12, 0.04, 0.04, 0.02, 0x20242e)
      return g
    case 'acc_mustache':
      box(g, 0, 0.12, 0, 0.1, 0.07, 0.05, 0x2a2420)
      box(g, 0.1, 0.1, 0, 0.11, 0.06, 0.05, 0x2a2420)
      box(g, -0.1, 0.1, 0, 0.11, 0.06, 0.05, 0x2a2420)
      box(g, 0.18, 0.13, 0, 0.05, 0.04, 0.05, 0x2a2420) // curl R
      box(g, -0.18, 0.13, 0, 0.05, 0.04, 0.05, 0x2a2420) // curl L
      return g
    case 'acc_goggles':
      box(g, 0, 0.1, -0.03, 0.34, 0.05, 0.05, LEATHER) // strap
      box(g, 0.09, 0.1, 0.02, 0.13, 0.13, 0.07, 0xb08d57) // rim R
      box(g, -0.09, 0.1, 0.02, 0.13, 0.13, 0.07, 0xb08d57) // rim L
      box(g, 0.09, 0.1, 0.06, 0.09, 0.09, 0.02, 0x6fe3e8, { opacity: 0.7 }) // lens R
      box(g, -0.09, 0.1, 0.06, 0.09, 0.09, 0.02, 0x6fe3e8, { opacity: 0.7 }) // lens L
      return g
    case 'acc_tinfoil':
      box(g, 0, 0.06, 0, 0.4, 0.12, 0.4, 0xd9dde2)
      box(g, 0, 0.16, 0, 0.28, 0.1, 0.28, 0xeef1f4)
      box(g, 0, 0.26, 0, 0.16, 0.1, 0.16, 0xd9dde2)
      box(g, 0, 0.35, 0, 0.07, 0.1, 0.07, 0xeef1f4) // crinkled point
      return g
    case 'charm_rabbit':
      box(g, 0, 0.26, 0, 0.06, 0.06, 0.06, 0x9aa0a8) // clasp ring
      box(g, 0, 0.12, 0, 0.11, 0.22, 0.16, 0xe8e0d5) // foot
      box(g, 0, 0.02, 0.07, 0.11, 0.06, 0.08, 0xd8cec0) // toes
      return g
    case 'amulet_grandma':
      amuletBase(g)
      box(g, 0, 0.22, 0, 0.16, 0.16, 0.05, 0xf2c14e) // locket
      box(g, 0, 0.22, 0.03, 0.08, 0.08, 0.01, 0xc29226) // engraving
      box(g, 0, 0.12, 0, 0.06, 0.06, 0.05, 0xf2c14e) // locket tip
      return g
    case 'amulet_debt':
      amuletBase(g)
      box(g, 0, 0.2, 0, 0.18, 0.18, 0.05, 0x3d3d46) // grim coin
      box(g, 0, 0.2, 0.03, 0.07, 0.07, 0.01, 0xa33c3c, faintGlow(0xa33c3c)) // red seal
      return g
    case 'amulet_block':
      amuletBase(g)
      box(g, 0, 0.2, 0, 0.16, 0.16, 0.16, 0xf2a93b, { emissive: 0xf2a93b, emissiveIntensity: 0.35 }) // BLOCK cube
      box(g, 0, 0.2, 0.085, 0.08, 0.08, 0.01, 0xfff0d0) // face glint
      return g

    // --- craft-expansion: forged metal trinkets (blacksmithing) ----------
    case 'ring_signet':
      ringBase(g, 0x8a9199) // iron band
      box(g, 0, 0.31, 0.02, 0.1, 0.09, 0.05, 0xb8c0c8) // flat signet face
      box(g, 0, 0.31, 0.05, 0.05, 0.05, 0.01, 0x5a626a) // stamped crest
      return g
    case 'ring_bandit':
      ringBase(g, 0xb87333) // copper band
      box(g, 0, 0.31, 0.02, 0.07, 0.07, 0.05, 0x3a2a1a) // dark setting
      box(g, 0, 0.31, 0.05, 0.04, 0.04, 0.01, 0x6b3f25) // oaken inlay
      return g
    case 'acc_toolbelt':
      box(g, 0, 0.14, 0, 0.42, 0.1, 0.12, LEATHER) // belt strap
      box(g, 0, 0.14, 0.07, 0.1, 0.12, 0.03, 0x9aa0a8) // iron buckle
      box(g, -0.14, 0.06, 0.06, 0.07, 0.12, 0.04, 0x6b4a2d) // pouch L
      box(g, 0.13, 0.07, 0.06, 0.05, 0.14, 0.03, 0xc0c6cc) // hanging wrench
      return g
    case 'amulet_forgeheart':
      amuletBase(g)
      box(g, 0, 0.2, 0, 0.16, 0.16, 0.08, 0x3a3236) // iron casing
      box(g, 0, 0.2, 0.04, 0.09, 0.09, 0.03, 0xff6a2a, { emissive: 0xff6a2a, emissiveIntensity: 0.5 }) // glowing coal
      return g
    case 'ring_bulwark':
      ringBase(g, 0x9198a0) // heavy steel
      box(g, 0, 0.26, 0, 0.24, 0.08, 0.08, 0xaab0b8) // thick top guard
      box(g, 0, 0.31, 0.04, 0.06, 0.04, 0.02, 0xd0d6dc) // rivet
      return g
    case 'amulet_lodestone':
      amuletBase(g)
      box(g, 0, 0.2, 0, 0.14, 0.18, 0.06, 0x4a4f57) // dark stone
      box(g, 0, 0.27, 0.02, 0.05, 0.05, 0.05, 0xd9a93a) // gold cap N
      box(g, 0, 0.13, 0.02, 0.05, 0.05, 0.05, 0xd9a93a) // gold cap S
      return g
    case 'acc_warplate': {
      const glow = faintGlow(0xf2d060)
      box(g, 0, 0.3, 0, 0.3, 0.1, 0.22, 0xd9b24a, glow) // gold pauldron cap
      box(g, 0, 0.2, 0, 0.26, 0.1, 0.2, 0xc0a040) // mid tier
      box(g, 0, 0.1, 0, 0.2, 0.1, 0.18, 0x9aa0a8) // steel underplate
      box(g, 0, 0.37, 0.08, 0.06, 0.05, 0.05, 0xf2e090, glow) // crest spike
      return g
    }
    case 'ring_emberband': {
      const glow = faintGlow(0xff7a2a)
      ringBase(g, 0xd9a93a) // gold band
      box(g, 0, 0.155, 0, 0.14, 0.14, 0.03, 0xff7a2a, { emissive: 0xff7a2a, emissiveIntensity: 0.45 }) // ember core
      box(g, 0, 0.31, 0.02, 0.06, 0.06, 0.04, 0xffd090, glow) // top spark
      return g
    }

    // --- craft-expansion: stitched cloth trinkets (tailoring) ------------
    case 'acc_scarf':
      box(g, 0, 0.3, 0, 0.36, 0.1, 0.1, 0x8a5a4a) // wrapped loop
      box(g, 0, 0.24, 0.05, 0.1, 0.1, 0.06, 0x9a6a5a) // knot
      box(g, 0.02, 0.1, 0.06, 0.09, 0.22, 0.04, 0x8a5a4a) // hanging tail
      box(g, 0.02, 0.0, 0.06, 0.09, 0.04, 0.04, 0xe8d0b0) // fringe
      return g
    case 'acc_bandana':
      box(g, 0, 0.26, 0, 0.34, 0.12, 0.06, 0x8a2a2a) // headband wrap
      box(g, -0.14, 0.24, 0, 0.06, 0.06, 0.06, 0x7a2424) // side knot
      box(g, -0.18, 0.16, 0, 0.04, 0.14, 0.03, 0x8a2a2a) // tail 1
      box(g, -0.22, 0.17, 0, 0.04, 0.12, 0.03, 0x9a3434) // tail 2
      return g
    case 'acc_satchel_fine':
      box(g, 0, 0.14, 0, 0.3, 0.26, 0.12, 0x6b4a2d) // bag body
      box(g, 0, 0.26, 0.02, 0.32, 0.1, 0.13, 0x7a5636) // flap
      box(g, 0, 0.2, 0.08, 0.06, 0.05, 0.02, 0xd9a93a) // brass clasp
      box(g, 0, 0.32, -0.08, 0.3, 0.04, 0.03, 0x5a3f22) // shoulder strap
      return g
    case 'acc_sash':
      box(g, 0, 0.3, 0, 0.1, 0.3, 0.05, 0x3a5aa0) // diagonal band top
      box(g, -0.04, 0.12, 0, 0.1, 0.3, 0.05, 0x3a5aa0) // band bottom
      box(g, -0.06, 0.12, 0.03, 0.12, 0.1, 0.04, 0xd9a93a) // gold trim knot
      box(g, -0.08, 0.02, 0.03, 0.05, 0.1, 0.03, 0x2f4a88) // tassel
      return g
    case 'charm_feather':
      box(g, 0, 0.3, 0, 0.05, 0.05, 0.05, 0x9aa0a8) // clasp
      box(g, 0, 0.15, 0, 0.02, 0.26, 0.02, 0xe8e2d0) // quill shaft
      box(g, 0.04, 0.16, 0, 0.06, 0.16, 0.02, 0x5a9ae0, { opacity: 0.9 }) // vane R
      box(g, -0.04, 0.16, 0, 0.06, 0.16, 0.02, 0x5a9ae0, { opacity: 0.9 }) // vane L
      return g
    case 'acc_silkgloves':
      box(g, -0.1, 0.12, 0, 0.12, 0.2, 0.1, 0xe8dcc8) // glove L
      box(g, 0.1, 0.12, 0, 0.12, 0.2, 0.1, 0xe8dcc8) // glove R
      box(g, -0.1, 0.24, 0.02, 0.1, 0.06, 0.06, 0xd9a93a) // cuff L
      box(g, 0.1, 0.24, 0.02, 0.1, 0.06, 0.06, 0xd9a93a) // cuff R
      return g
    case 'amulet_silkknot':
      amuletBase(g)
      box(g, 0, 0.2, 0, 0.16, 0.16, 0.05, 0x7a3a9a) // silk medallion
      box(g, 0, 0.2, 0.03, 0.1, 0.1, 0.03, 0x9a5aba) // knot weave
      box(g, 0, 0.2, 0.05, 0.04, 0.04, 0.02, 0xd9a93a) // gold center
      return g
    case 'charm_clover':
      box(g, 0, 0.3, 0, 0.05, 0.05, 0.05, 0x9aa0a8) // clasp
      box(g, 0, 0.1, 0, 0.03, 0.14, 0.03, 0x3f7a2d) // stem
      box(g, 0.07, 0.2, 0, 0.1, 0.1, 0.02, 0x5aa83f) // leaf E
      box(g, -0.07, 0.2, 0, 0.1, 0.1, 0.02, 0x5aa83f) // leaf W
      box(g, 0, 0.27, 0, 0.1, 0.1, 0.02, 0x5aa83f) // leaf N
      box(g, 0, 0.13, 0, 0.1, 0.1, 0.02, 0x5aa83f) // leaf S (fourth)
      return g

    default:
      return buildFallback()
  }
}

// ---------------------------------------------------------------------------
// Fallback (unknown id — never expected for catalog items)
// ---------------------------------------------------------------------------

function buildFallback(): THREE.Group {
  const g = group()
  box(g, 0, 0.15, 0, 0.3, 0.3, 0.3, WOOD)
  box(g, 0, 0.15, 0, 0.32, 0.08, 0.32, WOOD_DARK)
  box(g, 0, 0.15, 0.16, 0.1, 0.1, 0.01, 0xe8e2d0) // "?" label patch
  return g
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Legendaries / tokens whose ids don't carry a copper..mythic tail. */
const NAMED_MESH: Record<string, () => THREE.Group> = {
  sword_seal_breaker: () => buildSword(5),
  relic_frostfang: () => buildSword(5),
  relic_cinderwall: () => buildShield(5),
  relic_bonecaller: () => buildStaff(5),
  relic_eternal_cleaver: () => buildAxe(5),
  raid_token: () => buildToken('raid_token'),
}

export function buildItemMesh(def: ItemDef | undefined): THREE.Group {
  if (!def) return buildFallback()
  const id = def.id
  // Named legendaries / tokens use non-material ids (no copper..mythic tail), so
  // they'd miss tierOf + the fam switch; route them explicitly to the right
  // builder at mythic tier so they render as real gear, never a fallback crate.
  const named = NAMED_MESH[id]
  if (named) return named()
  const fam = id.slice(0, id.indexOf('_') >= 0 ? id.indexOf('_') : id.length)
  switch (fam) {
    case 'cape': return buildCape(id)
    case 'relic': return buildRelic(id)
    case 'sword': return buildSword(tierOf(id))
    case 'axe': return buildAxe(tierOf(id))
    case 'staff': return buildStaff(tierOf(id))
    case 'bow': return buildBow(tierOf(id))
    case 'shield': return buildShield(tierOf(id))
    case 'helm': return buildHelm(tierOf(id))
    case 'chest': return buildChest(tierOf(id))
    case 'boots': return buildBoots(tierOf(id))
    case 'hood': return buildHood(tierOf(id))
    case 'leathers': return buildLeathers(tierOf(id))
    case 'treads': return buildTreads(tierOf(id))
    case 'mhat': return buildMhat(tierOf(id))
    case 'robe': return buildRobe(tierOf(id))
    case 'slippers': return buildSlippers(tierOf(id))
    // --- new armor families (helm / chest / boots per set) ---
    case 'greathelm': return buildGreathelm(tierOf(id)) // knight helm
    case 'cuirass': return buildCuirass(tierOf(id)) // knight chest
    case 'sabatons': return buildSabatons(tierOf(id)) // knight boots
    case 'kabuto': return buildKabuto(tierOf(id)) // samurai helm
    case 'doumaru': return buildDoumaru(tierOf(id)) // samurai chest
    case 'suneate': return buildSuneate(tierOf(id)) // samurai boots
    case 'horned': return buildHorned(tierOf(id)) // barbarian helm
    case 'furplate': return buildFurplate(tierOf(id)) // barbarian chest
    case 'furboots': return buildFurboots(tierOf(id)) // barbarian boots
    case 'crown': return buildCrown(tierOf(id)) // royal helm
    case 'regalia': return buildRegalia(tierOf(id)) // royal chest
    case 'regalboots': return buildRegalboots(tierOf(id)) // royal boots
    case 'cowl': return buildCowl(tierOf(id)) // assassin helm
    case 'shroud': return buildShroud(tierOf(id)) // assassin chest
    case 'creepers': return buildCreepers(tierOf(id)) // assassin boots
    case 'totemmask': return buildTotemmask(tierOf(id)) // shaman helm
    case 'spiritweave': return buildSpiritweave(tierOf(id)) // shaman chest
    case 'spiritboots': return buildSpiritboots(tierOf(id)) // shaman boots
    case 'wyrmhelm': return buildWyrmhelm(tierOf(id)) // dragoon helm
    case 'wyrmscale': return buildWyrmscale(tierOf(id)) // dragoon chest
    case 'wyrmboots': return buildWyrmboots(tierOf(id)) // dragoon boots
    case 'mount': return buildMount(id)
    case 'pick': return buildPick(tierOf(id))
    case 'hatchet': return buildHatchet(tierOf(id))
    case 'rod': return buildRod(id)
    case 'ore': return buildOre(id)
    case 'bar': return buildBar(id)
    case 'crystal': return buildCrystal(id)
    case 'wood': return buildLog(id)
    case 'herb': return buildHerb(id)
    case 'fish': return buildFish(id)
    case 'hide': return buildHide(id)
    case 'wheat': return buildWheat()
    case 'food': return buildFood(id)
    case 'potion': return buildPotion(id)
    case 'ring':
    case 'acc':
    case 'charm':
    case 'amulet': return buildAccessory(id)
    case 'trophy': return buildTrophy(id)
    default: return buildFallback()
  }
}
