/**
 * Region-border transitions — natural edges along the internal region
 * boundaries: a pine/oak tree line into Greenwood, rock outcrops toward
 * Ironhold and the Ashen rim, a trimmed hedge line below the Capital and a
 * dead grove at the Forgotten rim. Props are jittered off the exact
 * boundary so nothing reads as a wall, and every road keeps an obvious
 * open gap (we skip anything within 2 cells of cobble/bridge).
 *
 * The river + the coast beaches are the remaining "border" features and
 * are handled by the terrain pass.
 */
import type * as THREE from 'three'
import { S_BRIDGE, S_COBBLE, S_GRASS, surfaceAt, type Ctx } from './layout'
import { isLand, kitDeadTree, kitPine, kitRock, kitTree } from './kit'

type Style = 'forest' | 'rocks' | 'dead' | 'hedge'

interface Seg {
  x0: number
  z0: number
  x1: number
  z1: number
  style: Style
}

const SEGS: readonly Seg[] = [
  // Kingdom of Beginnings | Greenwood Forest — tree line (forest side)
  { x0: 80, z0: -116, x1: 80, z1: 116, style: 'forest' },
  // Kingdom of Beginnings | Ironhold Mountains — rock outcrops
  { x0: -80, z0: -116, x1: -80, z1: 116, style: 'rocks' },
  // Kingdom of Beginnings | Royal Capital — trimmed hedge/tree line
  { x0: -76, z0: -80, x1: 76, z1: -80, style: 'hedge' },
  // Ashen Dungeons northern rim — rocks
  { x0: -236, z0: 120, x1: -6, z1: 120, style: 'rocks' },
  // Forgotten Lands northern rim — dead grove
  { x0: 6, z0: 120, x1: 236, z1: 120, style: 'dead' },
  // Ashen | Forgotten divider — rocks
  { x0: 0, z0: 126, x1: 0, z1: 236, style: 'rocks' }
]

function spotOk(ctx: Ctx, ix: number, iz: number): boolean {
  if (!isLand(ix + 0.5, iz + 0.5)) return false
  if (surfaceAt(ctx, ix, iz) !== S_GRASS) return false
  if (ctx.grid.isBlocked(ix + 0.5, iz + 0.5)) return false
  // keep an open gap wherever a road passes
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const s = surfaceAt(ctx, ix + dx, iz + dz)
      if (s === S_COBBLE || s === S_BRIDGE) return false
    }
  }
  return true
}

/** Scatter the transition props along every border segment. */
export function buildBorders(ctx: Ctx, _scene: THREE.Scene): void {
  const { rng } = ctx
  for (const seg of SEGS) {
    const alongX = Math.abs(seg.x1 - seg.x0) >= Math.abs(seg.z1 - seg.z0)
    const len = Math.max(Math.abs(seg.x1 - seg.x0), Math.abs(seg.z1 - seg.z0))
    const sx = Math.sign(seg.x1 - seg.x0)
    const sz = Math.sign(seg.z1 - seg.z0)
    for (let i = 0; i <= len; i += 2) {
      if (rng.next() < 0.3) continue // ragged, hand-placed feel
      const bx = seg.x0 + (alongX ? i * sx : 0)
      const bz = seg.z0 + (alongX ? 0 : i * sz)
      const ix = Math.round(bx + (alongX ? rng.range(-1, 1) : rng.range(-2.5, 2.5)))
      const iz = Math.round(bz + (alongX ? rng.range(-2.5, 2.5) : rng.range(-1, 1)))
      if (!spotOk(ctx, ix, iz)) continue
      switch (seg.style) {
        case 'forest':
          if (rng.next() < 0.6) kitPine(ctx, ix, iz, { tall: rng.next() < 0.5 })
          else kitTree(ctx, ix, iz)
          break
        case 'rocks':
          kitRock(ctx, ix, iz, (1 + rng.int(3)) as 1 | 2 | 3)
          break
        case 'dead':
          if (rng.next() < 0.7) kitDeadTree(ctx, ix, iz)
          else kitRock(ctx, ix, iz, 1)
          break
        case 'hedge':
          kitTree(ctx, ix, iz, { big: false })
          break
      }
    }
  }
}
