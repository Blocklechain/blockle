/**
 * Coarse walkability grid — 1 cell per voxel column over the full
 * 1440x1440 world. Cell (ix, iz) covers world-space [ix, ix+1) x [iz, iz+1).
 * Outside the grid is always blocked (the open ocean).
 *
 * The ORIGINAL 6-region continent (the "heart") is the central
 * |x|,|z| <= HEART_HALF square and stays eagerly built; the ring beyond it
 * out to the coast is streamed in zone-by-zone (see ./stream). Collision
 * marks are GLOBAL and PERMANENT: once a streamed zone has built at least
 * once, its marks stay even after its visuals are disposed.
 */
export const HALF = 720
export const SIZE = HALF * 2

/** Half-extent of the original, always-resident 6-region heart. */
export const HEART_HALF = 240

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

  // -------------------------------------------------------------------------
  // Streaming-rebuild support (see ./stream): zone builders consult the grid
  // (isBlocked scatter skips), so a REBUILD must see the exact pre-first-build
  // cell state or its rng stream drifts and it blocks NEW cells forever.
  // The stream snapshots a zone rect before its first build, and re-runs the
  // builder against a throwaway clone restored to that snapshot.
  // -------------------------------------------------------------------------

  /** Copy raw cell bytes of cell rect [x0..x1] x [z0..z1] (incl., clamped). */
  snapshotRect(x0: number, z0: number, x1: number, z1: number): Uint8Array {
    const ax0 = Math.max(x0, -HALF), az0 = Math.max(z0, -HALF)
    const ax1 = Math.min(x1, HALF - 1), az1 = Math.min(z1, HALF - 1)
    const w = Math.max(ax1 - ax0 + 1, 0)
    const h = Math.max(az1 - az0 + 1, 0)
    const out = new Uint8Array(w * h)
    for (let iz = az0, r = 0; iz <= az1; iz++, r++) {
      const base = this.idx(ax0, iz)
      out.set(this.cells.subarray(base, base + w), r * w)
    }
    return out
  }

  /** Write a snapshotRect result back over the same (clamped) rect. */
  restoreRect(x0: number, z0: number, x1: number, z1: number, snap: Uint8Array): void {
    const ax0 = Math.max(x0, -HALF), az0 = Math.max(z0, -HALF)
    const ax1 = Math.min(x1, HALF - 1), az1 = Math.min(z1, HALF - 1)
    const w = Math.max(ax1 - ax0 + 1, 0)
    for (let iz = az0, r = 0; iz <= az1; iz++, r++) {
      this.cells.set(snap.subarray(r * w, r * w + w), this.idx(ax0, iz))
    }
  }

  /** Deep copy — rebuilds run against a clone so their writes are discarded. */
  clone(): CollisionGrid {
    const g = new CollisionGrid()
    g.cells.set(this.cells)
    return g
  }
}
