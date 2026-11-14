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
  return TIER_PALETTES[Math.min(Math.max(t, 0), 5)]!
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
  box(g, 0, 0.12, 0, 0.46, 0.24, 0.46, p.main, glow) // skull band
  box(g, 0, 0.3, 0, 0.38, 0.14, 0.38, p.light, glow) // dome
  box(g, 0, 0.1, 0.24, 0.08, 0.2, 0.04, p.dark) // nose guard
  box(g, 0, 0.03, 0, 0.48, 0.06, 0.48, p.dark, glow) // brim
  box(g, 0, 0.44, -0.04, 0.08, 0.14, 0.26, p.accent) // plume crest
  box(g, 0, 0.34, -0.26, 0.08, 0.12, 0.14, p.accent) // plume tail
  return g
}

function buildChest(t: number): THREE.Group {
  const g = group()
  const p = pal(t)
  const glow = tierOpts(p)
  box(g, 0, 0.32, 0, 0.5, 0.5, 0.3, p.main, glow) // torso
  box(g, 0, 0.44, 0.16, 0.3, 0.2, 0.02, p.light, glow) // chest shine
  box(g, 0.3, 0.54, 0, 0.16, 0.12, 0.28, p.dark, glow) // pauldron R
  box(g, -0.3, 0.54, 0, 0.16, 0.12, 0.28, p.dark, glow) // pauldron L
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
    box(g, x, 0.03, 0.05, 0.19, 0.04, 0.36, p.accent) // sole
    box(g, x, 0.1, 0.09, 0.17, 0.11, 0.3, p.dark, glow) // foot
    box(g, x, 0.22, -0.02, 0.16, 0.18, 0.2, p.main, glow) // shaft
    box(g, x, 0.33, -0.02, 0.18, 0.06, 0.22, p.light, glow) // cuff
  }
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
  const liquid =
    id.startsWith('potion_hp') ? 0xd93a4a :
    id.startsWith('potion_mp') ? 0x3a6fd9 :
    id === 'potion_elixir' ? 0xf2c14e :
    id === 'potion_regret' ? 0x8a8d93 :
    0x6fc24a // mystery
  const size =
    id.endsWith('_small') || id === 'potion_regret' ? 0.8 :
    id.endsWith('_large') ? 1.2 :
    id.endsWith('_huge') || id === 'potion_elixir' ? 1.45 :
    1.0
  const glow = id === 'potion_elixir' ? { emissive: 0xf2c14e, emissiveIntensity: 0.3, opacity: 0.8 } : { opacity: 0.8 }
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

export function buildItemMesh(def: ItemDef | undefined): THREE.Group {
  if (!def) return buildFallback()
  const id = def.id
  const fam = id.slice(0, id.indexOf('_') >= 0 ? id.indexOf('_') : id.length)
  switch (fam) {
    case 'sword': return buildSword(tierOf(id))
    case 'axe': return buildAxe(tierOf(id))
    case 'staff': return buildStaff(tierOf(id))
    case 'bow': return buildBow(tierOf(id))
    case 'shield': return buildShield(tierOf(id))
    case 'helm': return buildHelm(tierOf(id))
    case 'chest': return buildChest(tierOf(id))
    case 'boots': return buildBoots(tierOf(id))
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
    default: return buildFallback()
  }
}
