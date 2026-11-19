/**
 * src/world/height.ts — the world's TERRAIN HEIGHTFIELD.
 *
 * A pure, deterministic `heightAt(x, z)` (layered sines + value-noise, no
 * per-call rng) that gives the continent gentle rolling elevation: broad hills
 * and shallow basins, roughly -3..+4 voxels around sea level (y = 0). Low
 * frequency on purpose — it reads as landscape, not spikes.
 *
 * WHERE IT STAYS FLAT (so the hand-built world keeps working):
 *   - the whole 6-region HEART (|x|,|z| <= HEART_HALF): the village, plaza,
 *     capital, river, bridges and every hand-placed structure sit at y = 0
 *     exactly as built. Elevation EASES IN over ~RAMP units just outside the
 *     heart so there is no cliff at the boundary.
 *   - water: river / lake / bank / boardwalk cells (and a one-cell lip around
 *     open water) clamp to 0 so water planes never float above or below their
 *     banks, and fishing waterlines (gather/placement) stay correct.
 *   - the coast: beaches ramp smoothly down to sea level.
 *
 * WHERE IT ROLLS (and how hard): the streamed outer continent. Amplitude is
 * biome-biased — mountain / volcanic / canyon / glacier get the roughest, most
 * raised ground; meadow / beach / city / savanna / cherry stay nearly flat;
 * everything else is in between. A very-low-frequency "continental" term pushes
 * whole swathes up into highlands or down into lowland basins ("varying depth").
 *
 * groundHeight(x, z) on the World delegates straight here, so the player, pets,
 * mobs, NPCs, raids, dropped items and remote players (all of which already
 * sample groundHeight) walk the contours for free. The two ground-voxel bake
 * sites feed `heightAt` to VoxelBatch as a per-column y offset, so the ground
 * cubes AND the props/trees/huts baked on them rise together.
 */
import { HALF, HEART_HALF } from './collision'
import { isLand } from './kit'
import { S_BANK, S_BRIDGE, S_RIVER } from './layout'
import { surfaceTypeAt } from './surface'
import { ZONES, type ZoneBiome, type ZoneDef } from './zones/registry'

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Elevation eases from flat (0) at the heart edge to full over this many units. */
const HEART_RAMP = 90
/** Beyond this |x|,|z| a cell MIGHT be near the coast and needs shore probing;
 *  inside it, every cell is deep inland (coast base ≈ 1876 − wobble). */
const INLAND_SAFE = 1500
/** Hard clamp — keeps it gentle no matter how the sines stack. Land never dips
 *  below sea level (0): the ocean is a single translucent plane at y=-0.42 that
 *  spans the whole world, so ANY ground below it gets blanketed blue. Keeping
 *  land >= 0 means the ocean plane only ever shows through true ocean cells
 *  (which have no ground voxel). "Varying depth" lives in the 0..+4 range as
 *  lowland valleys vs. raised hills — no submerged terrain. */
const H_MIN = 0
const H_MAX = 4

// ---------------------------------------------------------------------------
// Biome → how rough / how raised its ground is
// ---------------------------------------------------------------------------

/** Peak noise amplitude per biome (voxels) — flat towns vs rugged highlands. */
const BIOME_AMP: Record<ZoneBiome, number> = {
  meadow: 0.9,
  beach: 0.7,
  city: 0.7,
  savanna: 1.0,
  cherry: 1.0,
  lagoon: 0.8,
  forest: 1.5,
  swamp: 1.2,
  desert: 1.4,
  tundra: 1.3,
  ruins: 1.4,
  mushroom: 1.4,
  graveyard: 1.3,
  wastes: 1.6,
  dungeon: 1.5,
  crystal: 1.6,
  mountain: 2.2,
  volcanic: 2.1,
  canyon: 2.2,
  glacier: 2.0
}

/** Mean lift per biome — the rough highlands ride a touch above sea level. */
const BIOME_BIAS: Record<ZoneBiome, number> = {
  meadow: 0,
  beach: -0.1,
  city: 0,
  savanna: 0,
  cherry: 0,
  lagoon: -0.2,
  forest: 0.1,
  swamp: -0.4,
  desert: 0.1,
  tundra: 0.1,
  ruins: 0.1,
  mushroom: 0,
  graveyard: -0.2,
  wastes: 0.2,
  dungeon: 0.1,
  crystal: 0.3,
  mountain: 0.7,
  volcanic: 0.6,
  canyon: 0.5,
  glacier: 0.5
}

// ---------------------------------------------------------------------------
// Cached zone biome lookup (callers sweep contiguous cells → near-100% hits)
// ---------------------------------------------------------------------------

let lastZone: ZoneDef | null = null

function zoneBiomeAt(x: number, z: number): ZoneBiome | null {
  const lz = lastZone
  if (lz && x >= lz.x0 && x <= lz.x1 && z >= lz.z0 && z <= lz.z1) return lz.biome
  for (const zn of ZONES) {
    if (x >= zn.x0 && x <= zn.x1 && z >= zn.z0 && z <= zn.z1) {
      lastZone = zn
      return zn.biome
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

/** Smooth 0→1 ramp between edges a and b. */
function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Layered sines, normalized to ~[-1, 1]. Low frequency = broad hills. */
function baseNoise(x: number, z: number): number {
  const h =
    Math.sin(x * 0.011 + z * 0.006) +
    Math.sin(z * 0.009 - x * 0.005 + 1.7) * 0.6 +
    Math.sin((x + z) * 0.0075 + 0.5) * 0.4 +
    Math.sin((x - z) * 0.013 + 2.3) * 0.25
  return h / 2.25
}

/** Very-low-frequency swell: whole regions become highland (+) or basin (−). */
function continental(x: number, z: number): number {
  return Math.sin(x * 0.0022 + 1.1) * Math.sin(z * 0.0019 - 0.6)
}

/** Distance-to-shore ramp: 0 at the waterline, 1 a dozen cells inland. */
function shoreRamp(ix: number, iz: number): number {
  if (Math.max(Math.abs(ix), Math.abs(iz)) < INLAND_SAFE) return 1
  let s = 1
  const cx = ix + 0.5
  const cz = iz + 0.5
  const dirs = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [-1, -1], [1, -1], [-1, 1]
  ] as const
  for (const [dx, dz] of dirs) {
    for (const r of [2, 5, 9]) {
      if (!isLand(cx + dx * r, cz + dz * r)) {
        s = Math.min(s, r / 11)
        break
      }
    }
  }
  return s
}

/** True when this cell is water, a bank, a boardwalk, or touches one (1 ring). */
function nearWater(ix: number, iz: number): boolean {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const s = surfaceTypeAt(ix + dx + 0.5, iz + dz + 0.5)
      if (s === S_RIVER || s === S_BANK || s === S_BRIDGE) return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// The heightfield
// ---------------------------------------------------------------------------

/**
 * Terrain surface height (world units) at (x, z). Pure + deterministic.
 * 0 across the heart, water and towns-on-water; gentle rolling elevation on
 * the streamed outer continent, biome-biased. Safe to call per voxel.
 */
export function heightAt(x: number, z: number): number {
  const ix = Math.floor(x)
  const iz = Math.floor(z)
  if (ix < -HALF || ix >= HALF || iz < -HALF || iz >= HALF) return 0

  // Flat heart (+ ease-in band just outside it). Cheap short-circuit before
  // any zone lookup, so the always-resident heart bake costs almost nothing.
  const mMax = Math.max(Math.abs(x), Math.abs(z))
  const ramp = smoothstep(HEART_HALF, HEART_HALF + HEART_RAMP, mMax)
  if (ramp <= 0) return 0

  // Water and its banks/boardwalks stay at sea level so planes sit right.
  const s = surfaceTypeAt(x, z)
  if (s === S_RIVER || s === S_BANK || s === S_BRIDGE) return 0

  const biome = zoneBiomeAt(x, z) ?? 'meadow'
  const amp = BIOME_AMP[biome]
  const bias = BIOME_BIAS[biome]

  let h = continental(x, z) * 1.4 + baseNoise(x, z) * amp + bias
  h *= ramp * shoreRamp(ix, iz)

  // Keep land at/above sea level right at the water's edge — no spilled water,
  // and the fishing-waterline check (gather/placement) still reads low ground.
  if (h < 0 && nearWater(ix, iz)) h = 0

  return Math.min(H_MAX, Math.max(H_MIN, h))
}
