/**
 * Coarse walkability grid — 1 cell per voxel column over the 120x120 world.
 * Cell (ix, iz) covers world-space [ix, ix+1) x [iz, iz+1).
 */
export const HALF = 60
export const SIZE = HALF * 2

export class CollisionGrid {
  private cells = new Uint8Array(SIZE * SIZE)

  private idx(ix: number, iz: number): number {
    return ix + HALF + (iz + HALF) * SIZE
  }

  private inside(ix: number, iz: number): boolean {
    return ix >= -HALF && ix < HALF && iz >= -HALF && iz < HALF
  }

  block(ix: number, iz: number): void {
    if (this.inside(ix, iz)) this.cells[this.idx(ix, iz)] = 1
  }

  unblock(ix: number, iz: number): void {
    if (this.inside(ix, iz)) this.cells[this.idx(ix, iz)] = 0
  }

  /** Block the rect of cells [x0, x0+w) x [z0, z0+d). */
  blockRect(x0: number, z0: number, w: number, d: number): void {
    for (let ix = x0; ix < x0 + w; ix++) {
      for (let iz = z0; iz < z0 + d; iz++) this.block(ix, iz)
    }
  }

  /** World-space query (matches World.isBlocked semantics). */
  isBlocked(x: number, z: number): boolean {
    const ix = Math.floor(x)
    const iz = Math.floor(z)
    if (!this.inside(ix, iz)) return true
    return this.cells[this.idx(ix, iz)] === 1
  }
}
