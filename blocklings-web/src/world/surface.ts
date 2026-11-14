/**
 * Read-only surface sampling for map overlays (the mini-map terrain layer).
 *
 * The world build keeps one Uint8Array of S_* codes per ground cell (roads,
 * river, bridges, soil, sand — stamped eagerly for the heart + arterials,
 * then by zones as they stream in). `createWorld` publishes a reference here
 * once; consumers only ever READ through `surfaceTypeAt`. No three.js, no
 * build logic — this file is a leaf so overlays can import it without
 * pulling the renderer-side world modules.
 */
import { HALF, SIZE } from './collision'

export { S_GRASS, S_COBBLE, S_RIVER, S_BANK, S_SOIL, S_BRIDGE, S_SAND } from './layout'

let surf: Uint8Array | null = null

/** Called once by createWorld with the live surface map (shared reference). */
export function publishSurface(surface: Uint8Array): void {
  surf = surface
}

/**
 * S_* surface code at a world point, or -1 when the point is off the
 * continent grid (open sea) or the world hasn't been built yet.
 */
export function surfaceTypeAt(x: number, z: number): number {
  if (!surf) return -1
  const ix = Math.floor(x)
  const iz = Math.floor(z)
  if (ix < -HALF || ix >= HALF || iz < -HALF || iz >= HALF) return -1
  return surf[ix + HALF + (iz + HALF) * SIZE] ?? 0
}
