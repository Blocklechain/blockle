/**
 * src/world/zones/batch15.ts — ZONE_BATCHES[14]: the SOUTHEAST CORNER —
 * canyon into volcano country.
 *
 *   switchback_spite  canyon   46-60  one thousand hairpins, zero closure
 *   simmering_steps   volcanic 60-76  "dormant" terraces (waystone zone)
 *   magma_mia         volcanic 64-80  the coast that boils the sea
 *   cinderchoke       volcanic 68-84  ashfall country; the air chews back
 *   mount_tantrum     volcanic 78-95  the realm's angriest volcano
 *   obsidian_strand   beach    65-80  black-glass beach, freshly bottled
 *
 * Contract per builder: stamp surfaces FIRST (kitPath / setSurface), then
 * streamGroundPass, then props (kit builders mark their own collision).
 * Everything draws from ctx.rng (seeded per-zone by the stream) so re-entry
 * rebuilds the identical zone. Placement never consults the collision grid
 * (marks are permanent — grid checks would dedupe a rebuild into an empty
 * zone); overlap is avoided with a per-run local set.
 *
 * SE arterial through this batch: [360,360]→[420,430]→[500,500]→[570,580]→
 * [650,650] (ends on the Strand). Spurs below CROSS that corridor so the
 * connection survives the Catmull-Rom wobble.
 */
import { registerZoneBuilder, streamGroundPass } from '../stream'
import {
  BONE_WHITE,
  CANYON_GROUND,
  DEAD_WOOD,
  EMBER,
  PLASTER,
  STONE,
  WOOD,
  WOOD_DARK,
  isLand,
  kitBone,
  kitCactus,
  kitCampfire,
  kitDeadTree,
  kitFenceRun,
  kitHut,
  kitLantern,
  kitPalm,
  kitPath,
  kitRock,
  kitTotem
} from '../kit'
import { S_GRASS, surfaceAt, type Ctx } from '../layout'

// ---------------------------------------------------------------------------
// Deterministic scatter helpers (no grid reads — see file docs)
// ---------------------------------------------------------------------------

interface Clear {
  x: number
  z: number
  r: number
}

const key = (ix: number, iz: number): number => (ix + 720) * 1441 + (iz + 720)

function okCell(ctx: Ctx, ix: number, iz: number, used: Set<number>, clears: readonly Clear[]): boolean {
  if (!isLand(ix + 0.5, iz + 0.5)) return false
  if (surfaceAt(ctx, ix, iz) !== S_GRASS) return false
  if (used.has(key(ix, iz))) return false
  for (const c of clears) {
    const dx = ix - c.x
    const dz = iz - c.z
    if (dx * dx + dz * dz < c.r * c.r) return false
  }
  return true
}

function take(used: Set<number>, ix: number, iz: number): void {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) used.add(key(ix + dx, iz + dz))
  }
}

type Placer = (ix: number, iz: number) => void

/** Sparse fill across a rect — tries `count` spots, skips bad ones. */
function scatter(
  ctx: Ctx,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  count: number,
  used: Set<number>,
  clears: readonly Clear[],
  fn: Placer
): void {
  for (let i = 0; i < count; i++) {
    const ix = Math.floor(ctx.rng.range(x0, x1))
    const iz = Math.floor(ctx.rng.range(z0, z1))
    if (!okCell(ctx, ix, iz, used, clears)) continue
    take(used, ix, iz)
    fn(ix, iz)
  }
}

/** Cozy-dense ring of props around a landmark. */
function cluster(
  ctx: Ctx,
  cx: number,
  cz: number,
  r: number,
  count: number,
  used: Set<number>,
  clears: readonly Clear[],
  fn: Placer
): void {
  for (let i = 0; i < count; i++) {
    const a = ctx.rng.range(0, Math.PI * 2)
    const d = ctx.rng.range(r * 0.3, r)
    const ix = Math.floor(cx + Math.cos(a) * d)
    const iz = Math.floor(cz + Math.sin(a) * d)
    if (!okCell(ctx, ix, iz, used, clears)) continue
    take(used, ix, iz)
    fn(ix, iz)
  }
}

// ---------------------------------------------------------------------------
// Shared micro-props (southeast flavor)
// ---------------------------------------------------------------------------

/** Canyon hoodoo — tapering red stone stack with a too-big cap. Blocks. */
function hoodoo(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  const h = 1.6 + rng.range(0, 2.2)
  batches.stone.add(ix - 0.15, 0, iz - 0.15, 1.3, h * 0.45, 1.3, rng.pick(CANYON_GROUND))
  batches.stone.add(ix + 0.05, h * 0.45, iz + 0.05, 0.9, h * 0.4, 0.9, rng.pick(CANYON_GROUND))
  batches.stone.add(ix + 0.2, h * 0.85, iz + 0.2, 0.6, h * 0.25, 0.6, rng.pick(CANYON_GROUND))
  batches.stone.add(ix - 0.1, h * 1.1, iz - 0.1, 1.2, 0.45, 1.2, rng.pick(STONE)) // the hat it refuses to lose
  grid.block(ix, iz)
}

/** Low drift of pale ash — walkable, like fallen petals. */
function ashDrift(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches } = ctx
  const w = 1 + rng.range(0, 1.4)
  batches.misc.add(ix - w * 0.2, 0, iz - w * 0.2, w, 0.22, w, rng.next() < 0.5 ? 0x8d8884 : 0x7b7672)
  if (rng.next() < 0.5) {
    batches.misc.add(ix + rng.range(-0.8, 0.8), 0, iz + rng.range(-0.8, 0.8), 0.6, 0.3, 0.6, 0x97928d)
  }
}

/** Black volcanic-glass shard cluster — matte, NOT on the glow batch. Blocks. */
function obsidianShard(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  const h = 0.9 + rng.range(0, 1.4)
  const c = rng.next() < 0.5 ? 0x1c1b24 : 0x14131a
  batches.misc.add(ix + 0.12, 0, iz + 0.12, 0.76, h, 0.76, c)
  batches.misc.add(ix + 0.3, h, iz + 0.3, 0.4, h * 0.35, 0.4, 0x242230)
  if (rng.next() < 0.6) {
    batches.misc.add(ix + rng.range(-0.3, 0.8), 0, iz + rng.range(-0.3, 0.8), 0.34, 0.4 + rng.range(0, 0.5), 0.34, c)
  }
  grid.block(ix, iz)
}

/** Signpost with 1-3 boards pointing in frankly unhelpful directions. Blocks. */
function signPost(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  batches.wood.add(ix + 0.38, 0, iz + 0.38, 0.24, 2.4, 0.24, WOOD_DARK)
  const boards = 1 + rng.int(3)
  for (let b = 0; b < boards; b++) {
    const y = 1.2 + b * 0.5
    if (rng.next() < 0.5) {
      batches.plaster.add(ix + (rng.next() < 0.5 ? -0.7 : 0.4), y, iz + 0.32, 1.3, 0.34, 0.16, rng.pick(PLASTER))
    } else {
      batches.plaster.add(ix + 0.32, y, iz + (rng.next() < 0.5 ? -0.7 : 0.4), 0.16, 0.34, 1.3, rng.pick(PLASTER))
    }
  }
  grid.block(ix, iz)
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function registerBatch15(): void {
  // -------------------------------------------------------------------------
  // SWITCHBACK SPITE (canyon 46-60, x 360..480, z 360..520)
  // -------------------------------------------------------------------------
  registerZoneBuilder('switchback_spite', (ctx, _scene, zone) => {
    const { rng, batches, grid } = ctx
    const used = new Set<number>()

    // Spur off the SE arterial at its (420,430) waypoint — then every single
    // hairpin the trail designer billed for, up to the split mesa.
    kitPath(ctx, [
      [420, 430], [400, 438], [382, 430], [400, 420], [380, 410],
      [398, 400], [378, 392], [386, 386]
    ])
    kitPath(ctx, [[420, 430], [428, 452], [422, 468]], 1.1) // side trip to the sign thicket

    streamGroundPass(ctx, zone)

    // LANDMARK 1 — "The Settlement": one mesa, split clean down the middle
    // during proceedings. Each party kept half the caravan; neither half rolls.
    const mx = 372
    const mz = 374
    // her half (west) — slightly taller, out of spite
    batches.stone.add(mx, 0, mz, 7, 6.4, 11, rng.pick(CANYON_GROUND))
    batches.stone.add(mx + 1, 6.4, mz + 1.5, 5, 2.4, 8, rng.pick(CANYON_GROUND))
    // his half (east) — across a gap exactly one argument wide
    batches.stone.add(mx + 10, 0, mz, 7, 5.6, 11, rng.pick(CANYON_GROUND))
    batches.stone.add(mx + 11, 5.6, mz + 1.5, 5, 2.2, 8, rng.pick(CANYON_GROUND))
    grid.blockRect(mx, mz, 7, 11)
    grid.blockRect(mx + 10, mz, 7, 11)
    // the caravan, sawn in half; front half hers, back half his
    batches.wood.add(mx + 1.4, 8.8, mz + 4, 2.6, 1.6, 2.2, rng.pick(WOOD)) // front box
    batches.roof.add(mx + 1.1, 10.4, mz + 3.7, 3.2, 0.5, 2.8, rng.pick(WOOD)) // canopy stub
    batches.stone.add(mx + 1.8, 8.3, mz + 6.1, 0.55, 0.55, 0.55, WOOD_DARK) // front wheel
    batches.wood.add(mx + 12.4, 7.8, mz + 4, 2.6, 1.6, 2.4, rng.pick(WOOD)) // back box
    batches.roof.add(mx + 12.1, 9.4, mz + 3.9, 3.2, 0.5, 3, rng.pick(WOOD))
    batches.stone.add(mx + 12.6, 7.3, mz + 3.4, 0.55, 0.55, 0.55, WOOD_DARK) // back wheel
    batches.wood.add(mx + 14.6, 7.8, mz + 6.6, 0.3, 1.3, 0.3, WOOD_DARK) // tow bar, pointing at her half

    // LANDMARK 2 — "The Second Opinions": a thicket of signposts at the big
    // hairpin, every board contradicting the last. A camp for the lost, which
    // is everyone. (1 ember use)
    const sx = 424
    const sz = 474
    signPost(ctx, sx, sz)
    signPost(ctx, sx - 3, sz + 2)
    signPost(ctx, sx + 2, sz + 4)
    signPost(ctx, sx - 1, sz - 3)
    kitCampfire(ctx, sx + 4, sz)
    batches.wood.add(sx + 5.9, 0, sz + 2, 0.6, 0.8, 0.6, WOOD_DARK) // water barrel, "EMOTIONAL SUPPORT"
    grid.block(sx + 5, sz + 2)

    const clears: Clear[] = [
      { x: mx + 8, z: mz + 5, r: 13 },
      { x: sx, z: sz, r: 8 }
    ]
    cluster(ctx, mx + 8, mz + 5, 20, 12, used, clears, (x, z) => hoodoo(ctx, x, z))
    cluster(ctx, sx, sz, 14, 8, used, clears, (x, z) => kitCactus(ctx, x, z))
    scatter(ctx, 364, 364, 476, 516, 30, used, clears, (x, z) => hoodoo(ctx, x, z))
    scatter(ctx, 364, 364, 476, 516, 26, used, clears, (x, z) => kitRock(ctx, x, z, (1 + rng.int(2)) as 1 | 2))
    scatter(ctx, 364, 364, 476, 516, 18, used, clears, (x, z) => kitCactus(ctx, x, z))
    scatter(ctx, 364, 364, 476, 516, 10, used, clears, (x, z) => kitDeadTree(ctx, x, z))
  })

  // -------------------------------------------------------------------------
  // THE SIMMERING STEPS (volcanic 60-76, x 480..600, z 360..520, ws 540,440)
  // -------------------------------------------------------------------------
  registerZoneBuilder('simmering_steps', (ctx, _scene, zone) => {
    const { rng, batches, grid } = ctx
    const used = new Set<number>()

    // Spur CROSSES the SE arterial near (505,505) and climbs to the waystone;
    // branches east (handed to magma_mia at exactly (600,440)) and up the
    // terraces.
    kitPath(ctx, [[516, 512], [500, 496], [520, 476], [534, 458], [540, 448]])
    kitPath(ctx, [[544, 436], [564, 442], [584, 436], [600, 440]])
    kitPath(ctx, [[536, 432], [530, 414], [524, 400]], 1.1)

    streamGroundPass(ctx, zone)

    // LANDMARK 1 — "The Liar's Terraces": three stone steps of certified-
    // dormant lava field. The certificate is on fire. (1 ember use)
    const tx = 508
    const tz = 376
    batches.stone.add(tx, 0, tz, 20, 2, 14, rng.pick(STONE))
    batches.stone.add(tx + 2.5, 2, tz + 2, 15, 2, 10, rng.pick(STONE))
    batches.stone.add(tx + 5, 4, tz + 4, 10, 2, 6, rng.pick(STONE))
    grid.blockRect(tx, tz, 20, 14)
    // the "dormant" pool on the top step + the dribble it swears is sweat
    batches.window.add(tx + 7, 6, tz + 5.5, 6, 0.35, 3, EMBER)
    batches.window.add(tx + 9.4, 4.1, tz + 10, 1.4, 2, 0.6, EMBER)
    batches.window.add(tx + 9.6, 2.1, tz + 11.6, 1, 2, 0.5, EMBER)
    batches.window.add(tx + 9.7, 0, tz + 13.2, 0.8, 2.1, 0.5, EMBER)
    // official signage, scorched around the edges
    signPost(ctx, tx + 22, tz + 12)

    // LANDMARK 2 — "The Dormancy Verification Station": a survey hut whose
    // staff verify, nightly, that the ground is lying. Equipment: one fire,
    // one fence, dwindling optimism. (1 ember use)
    const vx = 560
    const vz = 468
    kitHut(ctx, vx, vz)
    kitCampfire(ctx, vx - 4, vz + 3)
    kitFenceRun(ctx, vx - 1, vz - 3, 6, true)
    batches.wood.add(vx + 5.1, 0, vz + 1, 0.6, 0.8, 0.6, WOOD_DARK) // sample barrel, warm to the touch
    grid.block(vx + 5, vz + 1)

    const clears: Clear[] = [
      { x: 540, z: 440, r: 7 }, // Simmering Waystone stays clear + reachable
      { x: tx + 10, z: tz + 7, r: 15 },
      { x: vx + 2, z: vz + 2, r: 8 }
    ]
    cluster(ctx, tx + 10, tz + 7, 22, 12, used, clears, (x, z) => kitRock(ctx, x, z, (1 + rng.int(2)) as 1 | 2))
    cluster(ctx, vx + 2, vz + 2, 13, 7, used, clears, (x, z) => kitDeadTree(ctx, x, z))
    scatter(ctx, 484, 364, 596, 516, 28, used, clears, (x, z) => kitRock(ctx, x, z, (1 + rng.int(3)) as 1 | 2 | 3))
    scatter(ctx, 484, 364, 596, 516, 20, used, clears, (x, z) => kitDeadTree(ctx, x, z))
    scatter(ctx, 484, 364, 596, 516, 16, used, clears, (x, z) => ashDrift(ctx, x, z))
    scatter(ctx, 484, 364, 596, 516, 6, used, clears, (x, z) => kitBone(ctx, x, z))
  })

  // -------------------------------------------------------------------------
  // MAGMA MIA (volcanic 64-80, x 600..720, z 360..520 — east coast)
  // -------------------------------------------------------------------------
  registerZoneBuilder('magma_mia', (ctx, _scene, zone) => {
    const { rng, batches, grid } = ctx
    const used = new Set<number>()

    // Continues simmering_steps' hand-off at (600,440); forks north to the
    // flow and on to the wreck in the boiling shallows.
    kitPath(ctx, [[600, 440], [620, 444], [640, 434], [658, 440]])
    kitPath(ctx, [[640, 434], [648, 418], [652, 404]], 1.1)
    kitPath(ctx, [[658, 440], [670, 452], [678, 462]], 1.1)

    streamGroundPass(ctx, zone)

    // LANDMARK 1 — "The Boiling Point": a lava flow marching into the sea down
    // a stone channel, with a permanent steam tantrum where they meet. The sea
    // has lost this argument daily for a thousand years. (1 ember use)
    const fz = 398
    batches.stone.add(644, 0, fz - 2.6, 46, 1.1, 2, rng.pick(STONE)) // channel banks
    batches.stone.add(644, 0, fz + 2.6, 46, 1.1, 2, rng.pick(STONE))
    batches.window.add(646, 0.15, fz - 1, 42, 0.5, 3.4, EMBER) // the flow itself
    grid.blockRect(644, fz - 3, 46, 2)
    grid.blockRect(644, fz + 2, 46, 2)
    for (let i = 0; i < 6; i++) { // steam, filed under "sea's problem"
      const px = 682 + rng.range(0, 10)
      batches.misc.add(px, 1 + rng.range(0, 2.4), fz - 2 + rng.range(0, 4), 1 + rng.range(0, 1.2), 0.9, 1 + rng.range(0, 1.2), 0xe8e4da)
    }

    // LANDMARK 2 — "The Overcooked": a trading sloop that anchored in the one
    // bay that simmers. Everything aboard is done. Well done. (1 ember use)
    const hx = 672
    const hz = 468
    batches.wood.add(hx, 0, hz, 9, 1.1, 4.6, rng.pick(DEAD_WOOD)) // charred hull
    batches.wood.add(hx - 0.5, 1.1, hz - 0.4, 10, 0.8, 5.4, rng.pick(DEAD_WOOD))
    batches.wood.add(hx + 9, 0.5, hz + 1, 1.4, 1.4, 2.4, rng.pick(DEAD_WOOD)) // bow jut
    for (let y = 0; y < 5; y++) {
      batches.wood.add(hx + 4 - y * 0.3, 1.9 + y * 0.85, hz + 2, 0.45, 0.9, 0.45, rng.pick(DEAD_WOOD)) // listing mast
    }
    batches.wood.add(hx + 1.6, 5.2, hz + 2.1, 3.4, 0.26, 0.26, rng.pick(DEAD_WOOD)) // bare yard; sail cooked off
    batches.window.add(hx + 3, 1.3, hz + 1.4, 1.6, 0.5, 1.4, EMBER) // the galley, still going
    grid.blockRect(hx - 1, hz - 1, 12, 7)
    kitBone(ctx, hx + 2, hz + 7) // the ship's cook. probably.

    const clears: Clear[] = [
      { x: 666, z: fz, r: 9 },
      { x: hx + 4, z: hz + 2, r: 10 }
    ]
    cluster(ctx, 666, fz, 16, 10, used, clears, (x, z) => kitRock(ctx, x, z, (1 + rng.int(2)) as 1 | 2))
    cluster(ctx, hx + 4, hz + 2, 15, 7, used, clears, (x, z) => obsidianShard(ctx, x, z))
    scatter(ctx, 604, 364, 712, 516, 26, used, clears, (x, z) => kitRock(ctx, x, z, (1 + rng.int(2)) as 1 | 2))
    scatter(ctx, 604, 364, 712, 516, 18, used, clears, (x, z) => kitDeadTree(ctx, x, z))
    scatter(ctx, 604, 364, 712, 516, 16, used, clears, (x, z) => ashDrift(ctx, x, z))
    scatter(ctx, 604, 364, 712, 516, 8, used, clears, (x, z) => obsidianShard(ctx, x, z))
  })

  // -------------------------------------------------------------------------
  // CINDERCHOKE (volcanic 68-84, x 360..480, z 520..720)
  // -------------------------------------------------------------------------
  registerZoneBuilder('cinderchoke', (ctx, _scene, zone) => {
    const { rng, batches, grid } = ctx
    const used = new Set<number>()

    // Spur CROSSES the SE arterial just south of (500,500) and gropes
    // southwest through the ashfall, shrine first, then the big fella.
    kitPath(ctx, [[524, 528], [496, 538], [468, 550], [446, 566], [432, 584]])
    kitPath(ctx, [[446, 566], [436, 556]], 1.1)

    streamGroundPass(ctx, zone)

    // LANDMARK 1 — "Big Greg": a colossal skeleton half-buried in ash, mid-
    // crawl toward the exit. He didn't make it, and neither did his landlord's
    // deposit. Skull, spine, ribcage, one last optimistic arm.
    const kx = 414
    const kz = 596
    batches.misc.add(kx, 0, kz + 1, 3.2, 2.4, 3, rng.pick(BONE_WHITE)) // skull, jaw in the ash
    batches.misc.add(kx + 0.4, 1.5, kz + 0.6, 0.8, 0.6, 0.5, 0x2a2622) // eye sockets (judging the air)
    batches.misc.add(kx + 2, 1.5, kz + 0.6, 0.8, 0.6, 0.5, 0x2a2622)
    batches.misc.add(kx + 0.2, 2.4, kz + 0.8, 2.8, 0.5, 2.6, rng.pick(BONE_WHITE)) // brow plate
    for (let i = 0; i < 6; i++) { // spine, trailing east
      batches.misc.add(kx + 4 + i * 2.1, 0.1, kz + 2, 1.4, 0.8 - i * 0.06, 1.2, rng.pick(BONE_WHITE))
    }
    for (let i = 0; i < 4; i++) { // rib arches, sinking as they go
      const rx = kx + 5 + i * 2.1
      const rh = 3.2 - i * 0.4
      batches.misc.add(rx, 0, kz - 1.4, 0.6, rh, 0.6, rng.pick(BONE_WHITE))
      batches.misc.add(rx + 0.05, rh, kz - 0.9, 0.5, 0.5, 1.6, rng.pick(BONE_WHITE))
      batches.misc.add(rx, 0, kz + 5, 0.6, rh, 0.6, rng.pick(BONE_WHITE))
      batches.misc.add(rx + 0.05, rh, kz + 4.4, 0.5, 0.5, 1.6, rng.pick(BONE_WHITE))
    }
    batches.misc.add(kx + 13, 0, kz + 0.6, 2.6, 1.3, 4, rng.pick(BONE_WHITE)) // pelvis, dignity not included
    batches.misc.add(kx - 2.6, 0.2, kz - 2.6, 4.2, 0.7, 1, rng.pick(BONE_WHITE)) // the arm, reaching for fresh air
    for (let f = 0; f < 3; f++) {
      batches.misc.add(kx - 4 - f * 0.1, 0.2, kz - 3.4 + f * 0.9, 1.3, 0.45, 0.45, rng.pick(BONE_WHITE)) // fingers
    }
    grid.blockRect(kx - 5, kz - 4, 22, 10)

    // LANDMARK 2 — "The Coughing Shrine": a totem wearing a carved breathing
    // mask, ringed with offering stones and one wheezing vent. Leave a lozenge,
    // take a blessing. (1 ember use)
    const cx = 434
    const cz = 552
    kitTotem(ctx, cx, cz)
    batches.plaster.add(cx - 0.1, 2.1, cz - 0.35, 0.9, 0.8, 0.4, rng.pick(BONE_WHITE)) // the mask (filters nothing)
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2
      const ox = Math.round(cx + Math.cos(a) * 4)
      const oz = Math.round(cz + Math.sin(a) * 4)
      batches.stone.add(ox + 0.2, 0, oz + 0.2, 0.6, 0.5 + rng.range(0, 0.4), 0.6, rng.pick(STONE))
      grid.block(ox, oz)
    }
    batches.stone.add(cx + 2.8, 0, cz + 2.8, 1.4, 0.5, 1.4, rng.pick(STONE)) // the vent
    batches.window.add(cx + 3.15, 0.4, cz + 3.15, 0.7, 0.35, 0.7, EMBER)
    grid.block(cx + 3, cz + 3)

    const clears: Clear[] = [
      { x: kx + 7, z: kz + 1, r: 15 },
      { x: cx, z: cz, r: 8 }
    ]
    cluster(ctx, kx + 7, kz + 1, 22, 12, used, clears, (x, z) => kitBone(ctx, x, z))
    cluster(ctx, cx, cz, 13, 8, used, clears, (x, z) => kitDeadTree(ctx, x, z))
    scatter(ctx, 364, 524, 476, 716, 30, used, clears, (x, z) => ashDrift(ctx, x, z))
    scatter(ctx, 364, 524, 476, 716, 26, used, clears, (x, z) => kitDeadTree(ctx, x, z))
    scatter(ctx, 364, 524, 476, 716, 22, used, clears, (x, z) => kitRock(ctx, x, z, (1 + rng.int(3)) as 1 | 2 | 3))
    scatter(ctx, 364, 524, 476, 716, 8, used, clears, (x, z) => kitBone(ctx, x, z))
  })

  // -------------------------------------------------------------------------
  // MOUNT TANTRUM (volcanic 78-95, x 480..600, z 520..720)
  // -------------------------------------------------------------------------
  registerZoneBuilder('mount_tantrum', (ctx, _scene, zone) => {
    const { rng, batches, grid } = ctx
    const used = new Set<number>()

    // Spur off the SE arterial at its (570,580) waypoint, down to the only
    // public service within screaming distance of the summit.
    kitPath(ctx, [[570, 580], [558, 596], [550, 608], [546, 616]])

    streamGroundPass(ctx, zone)

    // LANDMARK 1 — "Mount Tantrum": the realm's angriest volcano, four tiers
    // of pure grievance with a glowing caldera and one lava dribble it insists
    // is "venting, actually". Erupts whenever. (2 ember uses: caldera + dribble)
    const vx = 514
    const vz = 624
    batches.stone.add(vx, 0, vz, 28, 4, 28, rng.pick(STONE))
    batches.stone.add(vx + 4, 4, vz + 4, 20, 4, 20, rng.pick(STONE))
    batches.stone.add(vx + 8, 8, vz + 8, 12, 3.4, 12, rng.pick(STONE))
    batches.stone.add(vx + 10.5, 11.4, vz + 10.5, 7, 2.6, 7, rng.pick(CANYON_GROUND)) // scorched rim
    batches.window.add(vx + 12, 13.4, vz + 12, 4, 0.7, 4, EMBER) // the caldera (do not lean in)
    // the dribble, south face, heading for the suggestion box
    batches.window.add(vx + 13.2, 9.5, vz + 17.4, 1.6, 2.4, 0.7, EMBER)
    batches.window.add(vx + 13.4, 5.5, vz + 21.4, 1.2, 2.6, 0.7, EMBER)
    batches.window.add(vx + 13.5, 1.5, vz + 25.4, 1, 2.8, 0.7, EMBER)
    batches.window.add(vx + 13.3, 0, vz + 28.2, 1.4, 0.5, 2.2, EMBER)
    grid.blockRect(vx - 1, vz - 1, 30, 30)
    // boulders it has thrown over the years (it does not apologize)
    kitRock(ctx, vx - 6, vz + 8, 3)
    kitRock(ctx, vx + 32, vz + 14, 3)
    kitRock(ctx, vx + 10, vz - 7, 2)

    // LANDMARK 2 — "The Complaints Department": one hut, one queue fence, zero
    // staff. The complaint box melted in '04; the fire pit is where submissions
    // go now. Cold today. Like the department's enthusiasm.
    const hx2 = 548
    const hz2 = 620
    kitHut(ctx, hx2, hz2)
    kitFenceRun(ctx, hx2 - 2, hz2 + 5, 7, true) // the queue
    kitFenceRun(ctx, hx2 + 5, hz2 + 7, 5, true) // the overflow queue
    signPost(ctx, hx2 + 5, hz2 - 2)
    batches.stone.add(hx2 - 2.8, 0, hz2 + 1, 0.4, 0.3, 0.4, rng.pick(STONE)) // dead fire pit (no ember — it quit)
    batches.stone.add(hx2 - 1.7, 0, hz2 + 1, 0.4, 0.3, 0.4, rng.pick(STONE))
    batches.stone.add(hx2 - 2.25, 0, hz2 + 0.45, 0.4, 0.3, 0.4, rng.pick(STONE))
    batches.stone.add(hx2 - 2.25, 0, hz2 + 1.55, 0.4, 0.3, 0.4, rng.pick(STONE))
    batches.misc.add(hx2 - 2.1, 0, hz2 + 0.9, 0.55, 0.3, 0.55, 0x4a4442) // cold coals
    grid.block(hx2 - 3, hz2 + 1)

    const clears: Clear[] = [
      { x: vx + 14, z: vz + 14, r: 22 },
      { x: hx2 + 2, z: hz2 + 2, r: 9 }
    ]
    cluster(ctx, vx + 14, vz + 14, 30, 14, used, clears, (x, z) => kitRock(ctx, x, z, (1 + rng.int(3)) as 1 | 2 | 3))
    cluster(ctx, hx2 + 2, hz2 + 2, 14, 6, used, clears, (x, z) => kitDeadTree(ctx, x, z))
    scatter(ctx, 484, 524, 596, 716, 26, used, clears, (x, z) => ashDrift(ctx, x, z))
    scatter(ctx, 484, 524, 596, 716, 22, used, clears, (x, z) => kitRock(ctx, x, z, (1 + rng.int(2)) as 1 | 2))
    scatter(ctx, 484, 524, 596, 716, 16, used, clears, (x, z) => kitDeadTree(ctx, x, z))
    scatter(ctx, 484, 524, 596, 716, 6, used, clears, (x, z) => kitBone(ctx, x, z))
  })

  // -------------------------------------------------------------------------
  // THE OBSIDIAN STRAND (beach 65-80, x 600..720, z 520..720 — SE corner)
  // -------------------------------------------------------------------------
  registerZoneBuilder('obsidian_strand', (ctx, scene, zone) => {
    const { rng, batches, grid } = ctx
    const used = new Set<number>()

    // The SE arterial ENDS here at (650,650). Forks: north to the resort,
    // on toward the corner to the wreck.
    kitPath(ctx, [[650, 650], [660, 634], [666, 618]], 1.1)
    kitPath(ctx, [[650, 650], [660, 660], [670, 668]], 1.1)

    streamGroundPass(ctx, zone)

    // LANDMARK 1 — "The Uninsurable": a pirate sloop that beached on sand so
    // fresh it was still technically lava. Glassed in place, hull and all —
    // adjusters refuse to attend in person. (1 ember use: the cooling seam)
    const wx = 668
    const wz = 672
    batches.wood.add(wx, 0, wz, 9, 1.1, 4.4, rng.pick(DEAD_WOOD))
    batches.wood.add(wx - 0.5, 1.1, wz - 0.4, 10, 0.8, 5.2, rng.pick(DEAD_WOOD))
    batches.wood.add(wx - 1.6, 0.5, wz + 1, 1.6, 1.5, 2.4, rng.pick(DEAD_WOOD)) // stern castle stub
    for (let y = 0; y < 5; y++) {
      batches.wood.add(wx + 4.5 + y * 0.25, 1.9 + y * 0.85, wz + 2, 0.45, 0.9, 0.45, rng.pick(DEAD_WOOD))
    }
    batches.plaster.add(wx + 5.4, 4.4, wz + 2.2, 1.4, 1.8, 0.14, 0x2a2834) // sail, flash-tinted black
    // the glass that owns it now
    batches.misc.add(wx - 1, 0, wz - 1.6, 4.5, 2.2, 1.4, 0x1c1b24)
    batches.misc.add(wx + 6, 0, wz + 4.6, 4, 1.8, 1.4, 0x14131a)
    batches.misc.add(wx + 9.6, 0, wz + 0.2, 1.4, 2.6, 3, 0x242230)
    batches.window.add(wx + 3, 0, wz + 5.6, 3.4, 0.3, 0.8, EMBER) // the seam, still cooling since Tuesday
    grid.blockRect(wx - 2, wz - 2, 14, 9)

    // LANDMARK 2 — "The Sharp End Resort": the realm's only black-glass beach
    // club. Loungers, one brave umbrella, a tiki bar, and signage that is less
    // a suggestion than a waiver. NO BARE FEET. (zone's 1 lantern)
    const bx = 664
    const bz = 608
    kitHut(ctx, bx, bz) // the tiki bar (no tiki, no bar, great view)
    kitLantern(ctx, scene, bx + 5, bz + 2) // lit so the night swimmers can find their regrets
    signPost(ctx, bx - 2, bz + 5)
    // loungers, angled at the sea like an apology
    for (let i = 0; i < 3; i++) {
      const lx = bx - 1 + i * 3
      const lz = bz + 8
      batches.wood.add(lx, 0.25, lz, 1, 0.2, 2.2, rng.pick(WOOD))
      batches.wood.add(lx, 0.4, lz - 0.6, 1, 0.9, 0.3, rng.pick(WOOD)) // backrest
      grid.block(lx, lz)
    }
    // the umbrella (it believes in itself)
    batches.wood.add(bx + 7.4, 0, bz + 8.4, 0.22, 2.6, 0.22, WOOD_DARK)
    batches.roof.add(bx + 6.3, 2.6, bz + 7.3, 2.4, 0.4, 2.4, 0xd96459)
    batches.roof.add(bx + 6.9, 3, bz + 7.9, 1.2, 0.35, 1.2, 0xe8786d)
    grid.block(bx + 7, bz + 8)

    const clears: Clear[] = [
      { x: wx + 4, z: wz + 2, r: 11 },
      { x: bx + 3, z: bz + 5, r: 11 }
    ]
    cluster(ctx, wx + 4, wz + 2, 17, 10, used, clears, (x, z) => obsidianShard(ctx, x, z))
    cluster(ctx, bx + 3, bz + 5, 16, 8, used, clears, (x, z) => kitPalm(ctx, x, z))
    scatter(ctx, 604, 524, 712, 716, 26, used, clears, (x, z) => obsidianShard(ctx, x, z))
    scatter(ctx, 604, 524, 712, 716, 16, used, clears, (x, z) => kitPalm(ctx, x, z))
    scatter(ctx, 604, 524, 712, 716, 14, used, clears, (x, z) => kitRock(ctx, x, z, 1))
    scatter(ctx, 604, 524, 712, 716, 6, used, clears, (x, z) => kitBone(ctx, x, z))
  })
}
