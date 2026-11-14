/**
 * src/world/zones/batch2.ts — ZONE BATCH 2: North-center-west.
 * The tundra ridge above Ironhold — six cold, cranky zones:
 *
 *   windchill_nine  tundra   58-72  (-480,-720)..(-360,-520)
 *   shiverspikes    mountain 62-78  (-360,-720)..(-240,-520)
 *   snowblind       tundra   46-58  (-480,-520)..(-360,-360)
 *   ironhold_attic  mountain 46-60  (-360,-520)..(-240,-360)
 *   avalanche_alley mountain 30-45  (-480,-360)..(-360,-240)
 *   upper_ironhold  mountain 14-22  (-360,-360)..(-240,-240)
 *
 * Builder contract (see src/world/stream.ts): stamp surfaces first
 * (kitPath), then streamGroundPass, then props. Deterministic — only the
 * per-zone ctx.rng is used. All collision via the kit builders / grid.
 */
import { registerZoneBuilder, streamGroundPass } from '../stream'
import {
  ICE,
  isLand,
  kitCampfire,
  kitDeadTree,
  kitFenceRun,
  kitHouseShell,
  kitHut,
  kitIceSpike,
  kitLantern,
  kitPath,
  kitPine,
  kitRock,
  FLOWER,
  PLASTER,
  ROOF,
  SNOW,
  STONE,
  STRAW,
  WOOD,
  WOOD_DARK,
  WINDOW_GLOW
} from '../kit'
import { S_GRASS, surfaceAt, type Ctx } from '../layout'

/** Pitch-dark mine-opening color (flat, no texture — just a very dark box). */
const DARK_OPENING = 0x17171c

// ---------------------------------------------------------------------------
// Local helpers (deterministic; props self-mark collision via kit/grid)
// ---------------------------------------------------------------------------

/** Scatter `n` attempts over a rect; places only on untouched open land. */
function scatter(
  ctx: Ctx,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  n: number,
  place: (ix: number, iz: number) => void
): void {
  const { rng } = ctx
  for (let i = 0; i < n; i++) {
    const ix = x0 + rng.int(x1 - x0)
    const iz = z0 + rng.int(z1 - z0)
    if (!isLand(ix + 0.5, iz + 0.5)) continue
    if (surfaceAt(ctx, ix, iz) !== S_GRASS) continue
    place(ix, iz)
  }
}

/** Low wind-blown snowdrift — pure decoration, never blocks. */
function drift(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches } = ctx
  const w = rng.range(1, 2.4)
  batches.misc.add(ix + rng.range(-0.3, 0.3), 0, iz + rng.range(-0.3, 0.3), w, 0.14, w * rng.range(0.5, 0.9), SNOW)
}

/** Leaning wooden signpost with a plank sign. Blocks its cell. */
function signpost(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  batches.wood.add(ix + 0.4, 0, iz + 0.4, 0.2, 2, 0.2, rng.pick(WOOD))
  if (rng.next() < 0.5) {
    batches.wood.add(ix - 0.1, 1.4, iz + 0.36, 1.2, 0.4, 0.12, WOOD_DARK)
  } else {
    batches.wood.add(ix + 0.36, 1.4, iz - 0.1, 0.12, 0.4, 1.2, WOOD_DARK)
  }
  grid.block(ix, iz)
}

/** Collapsed two-step canvas tent (abandoned-camp furniture). Blocks 2x2. */
function tent(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  const c = rng.pick(PLASTER)
  batches.plaster.add(ix, 0, iz, 2, 0.8, 2.2, c)
  batches.plaster.add(ix + 0.5, 0.8, iz + 0.2, 1, 0.6, 1.8, c)
  batches.wood.add(ix + 0.9, 0, iz - 0.2, 0.18, 1.6, 0.18, WOOD_DARK) // front pole
  grid.blockRect(ix, iz, 2, 2)
}

/** Stack of supply crates. Blocks the cell. */
function crates(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  batches.wood.add(ix, 0, iz, 0.9, 0.9, 0.9, rng.pick(WOOD))
  batches.wood.add(ix + 0.5, 0, iz + 0.6, 0.7, 0.7, 0.7, rng.pick(WOOD))
  if (rng.next() < 0.6) batches.wood.add(ix + 0.2, 0.9, iz + 0.15, 0.7, 0.7, 0.7, rng.pick(WOOD))
  grid.block(ix, iz)
}

/** Wrecked supply cart — tipped bed, spilled wheel, cargo. Blocks 3x2. */
function wreckedCart(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  const w = rng.pick(WOOD)
  batches.wood.add(ix, 0.3, iz, 2.4, 0.5, 1.6, w) // tipped bed
  batches.wood.add(ix - 0.5, 0, iz + 0.3, 0.5, 0.5, 0.9, WOOD_DARK) // snapped shaft
  batches.misc.add(ix + 0.3, 0, iz - 0.5, 0.9, 0.9, 0.24, WOOD_DARK) // fallen wheel
  batches.misc.add(ix + 2.1, 0, iz + 1.5, 0.9, 0.24, 0.9, WOOD_DARK) // other wheel, flat
  batches.wood.add(ix + 0.5, 0.8, iz + 0.3, 0.8, 0.8, 0.8, rng.pick(WOOD)) // cargo crate
  grid.blockRect(ix, iz, 3, 2)
}

/** Timbered mine portal set into a rubble mound, opening facing +z (south).
 *  The money-maker for the two Ironhold zones. Blocks its 7x4 footprint. */
function mineMouth(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  // rubble mound hugging the portal
  batches.stone.add(ix, 0, iz, 7, 3.2, 3, rng.pick(STONE))
  batches.stone.add(ix + 0.6, 3.2, iz + 0.4, 5.8, 1.4, 2.2, rng.pick(STONE))
  batches.stone.add(ix + 1.8, 4.6, iz + 0.8, 3.4, 1, 1.4, rng.pick(STONE))
  batches.misc.add(ix + 1.2, 5.6, iz + 1, 1.2, 0.3, 1, SNOW) // snow cap
  // dark opening + timber frame on the south face
  batches.misc.add(ix + 2.4, 0, iz + 2.6, 2.2, 2.2, 0.5, DARK_OPENING)
  batches.wood.add(ix + 2, 0, iz + 2.7, 0.45, 2.6, 0.45, WOOD_DARK)
  batches.wood.add(ix + 4.55, 0, iz + 2.7, 0.45, 2.6, 0.45, WOOD_DARK)
  batches.wood.add(ix + 1.8, 2.6, iz + 2.65, 3.4, 0.5, 0.55, rng.pick(WOOD))
  // plank rails running out of the mouth + a loaded ore cart
  batches.wood.add(ix + 2.6, 0, iz + 3.1, 0.18, 0.1, 4.4, WOOD_DARK)
  batches.wood.add(ix + 4.2, 0, iz + 3.1, 0.18, 0.1, 4.4, WOOD_DARK)
  batches.wood.add(ix + 2.7, 0.1, iz + 5.4, 1.6, 0.8, 1.1, rng.pick(WOOD)) // cart
  batches.stone.add(ix + 2.9, 0.9, iz + 5.6, 1.2, 0.5, 0.7, rng.pick(STONE)) // ore load
  batches.misc.add(ix + 2.55, 0.05, iz + 5.5, 0.24, 0.5, 0.5, WOOD_DARK) // wheels
  batches.misc.add(ix + 4.2, 0.05, iz + 5.5, 0.24, 0.5, 0.5, WOOD_DARK)
  grid.blockRect(ix, iz, 7, 4)
  grid.blockRect(ix + 2, iz + 5, 3, 2) // the cart
}

// ---------------------------------------------------------------------------
// windchill_nine — Windchill Factor Nine (tundra 58-72)
// ---------------------------------------------------------------------------
registerZoneBuilder('windchill_nine', (ctx, _scene, zone) => {
  // trail in from the west edge (faces the NW arterial over in Longjohns),
  // past the frozen caravan, ending at the Complaints Department
  kitPath(ctx, [
    [-480, -586], [-466, -580], [-452, -568], [-444, -596], [-432, -612], [-423, -617]
  ], 1.3)
  streamGroundPass(ctx, zone)

  // LANDMARK: "The Complaints Department" — a ring of leaning signposts
  // around a great stone cairn, where the wind files its paperwork in
  // triplicate and adventurers nail up their grievances.
  {
    const cx = -420
    const cz = -620
    const { rng, batches, grid } = ctx
    batches.stone.add(cx - 1, 0, cz - 1, 3, 1.1, 3, rng.pick(STONE))
    batches.stone.add(cx - 0.5, 1.1, cz - 0.5, 2, 1, 2, rng.pick(STONE))
    batches.stone.add(cx, 2.1, cz, 1.1, 1, 1.1, rng.pick(STONE))
    batches.misc.add(cx + 0.1, 3.1, cz + 0.1, 0.9, 0.2, 0.9, SNOW)
    grid.blockRect(cx - 1, cz - 1, 3, 3)
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2
      signpost(ctx, cx + Math.round(Math.cos(a) * 6), cz + Math.round(Math.sin(a) * 6))
    }
    // grievances blow loose and pile up downwind
    for (let i = 0; i < 6; i++) {
      batches.misc.add(cx + 7 + rng.range(0, 5), 0, cz + rng.range(-4, 4), 0.4, 0.06, 0.5, rng.pick(PLASTER))
    }
  }

  // LANDMARK: "The Flash-Frozen Caravan" — a supply run that stopped for
  // five minutes, tops, and has been here forty years. Ice owns it now.
  wreckedCart(ctx, -452, -566)
  wreckedCart(ctx, -446, -572)
  crates(ctx, -448, -563)
  kitIceSpike(ctx, -453, -569)
  kitIceSpike(ctx, -444, -567)
  kitIceSpike(ctx, -449, -574)

  // cozy-dense around the landmarks, sparse elsewhere
  scatter(ctx, -432, -632, -408, -608, 14, (x, z) => kitIceSpike(ctx, x, z))
  scatter(ctx, -462, -582, -436, -554, 10, (x, z) => drift(ctx, x, z))
  scatter(ctx, -478, -718, -362, -522, 26, (x, z) => kitIceSpike(ctx, x, z))
  scatter(ctx, -478, -718, -362, -522, 22, (x, z) => kitRock(ctx, x, z, ctx.rng.next() < 0.3 ? 2 : 1))
  scatter(ctx, -478, -700, -362, -540, 12, (x, z) => kitDeadTree(ctx, x, z))
  scatter(ctx, -478, -718, -362, -522, 40, (x, z) => drift(ctx, x, z))
})

// ---------------------------------------------------------------------------
// shiverspikes — The Shiverspikes (mountain 62-78)
// ---------------------------------------------------------------------------
registerZoneBuilder('shiverspikes', (ctx, _scene, zone) => {
  // climbers' approach from the south edge (toward the North arterial side)
  kitPath(ctx, [
    [-302, -520], [-310, -548], [-298, -576], [-306, -600], [-300, -622]
  ], 1.3)
  streamGroundPass(ctx, zone)
  const { rng, batches, grid } = ctx

  // LANDMARK: "The Cloudpoker" — the peak so sharp the clouds filed a
  // restraining order. A stacked stone needle you can see from two zones.
  {
    const px = -303
    const pz = -648
    let w = 9
    let y = 0
    while (w >= 1) {
      const off = (9 - w) / 2
      batches.stone.add(px + off, y, pz + off, w, 2.4, w, rng.pick(STONE))
      y += 2.4
      w -= 2
    }
    batches.misc.add(px + 3.6, y, pz + 3.6, 1.8, 0.5, 1.8, SNOW) // snow tip
    batches.misc.add(px + 4.1, y + 0.5, pz + 4.1, 0.8, 0.7, 0.8, SNOW)
    grid.blockRect(px, pz, 9, 9)
    // shattered shoulder spikes around the base
    kitIceSpike(ctx, px - 3, pz + 2)
    kitIceSpike(ctx, px + 11, pz + 5)
    kitIceSpike(ctx, px + 4, pz + 11)
    kitRock(ctx, px - 4, pz + 7, 2)
    kitRock(ctx, px + 10, pz - 2, 3)
  }

  // LANDMARK: "Camp Bad Idea" — the climbers' last base camp. The summit
  // log has one entry and it just says "nope" in frozen ink. (1 ember use)
  {
    const cx = -300
    const cz = -626
    kitCampfire(ctx, cx, cz)
    tent(ctx, cx - 5, cz - 2)
    tent(ctx, cx + 3, cz - 4)
    crates(ctx, cx - 2, cz - 5)
    signpost(ctx, cx + 3, cz + 2)
    // ragged expedition flag, still technically flying
    batches.wood.add(cx - 3 + 0.4, 0, cz + 3 + 0.4, 0.18, 3.4, 0.18, WOOD_DARK)
    batches.misc.add(cx - 3 + 0.58, 2.6, cz + 3 + 0.4, 1.1, 0.6, 0.1, rng.pick(ROOF))
    grid.block(cx - 3, cz + 3)
  }

  // ridge spines + scatter: this zone is mostly teeth
  scatter(ctx, -358, -718, -322, -522, 20, (x, z) => kitRock(ctx, x, z, rng.next() < 0.5 ? 3 : 2))
  scatter(ctx, -286, -718, -242, -522, 20, (x, z) => kitRock(ctx, x, z, rng.next() < 0.5 ? 3 : 2))
  scatter(ctx, -358, -718, -242, -522, 24, (x, z) => kitIceSpike(ctx, x, z))
  scatter(ctx, -358, -700, -242, -540, 14, (x, z) => kitPine(ctx, x, z, { tall: true }))
  scatter(ctx, -358, -718, -242, -522, 30, (x, z) => drift(ctx, x, z))
})

// ---------------------------------------------------------------------------
// snowblind — Snowblind Steppe (tundra 46-58)
// ---------------------------------------------------------------------------
registerZoneBuilder('snowblind', (ctx, _scene, zone) => {
  // spur from the NW arterial (it clips this zone's SW shoulder ~(-466,-365))
  kitPath(ctx, [
    [-466, -365], [-452, -380], [-440, -400], [-430, -420], [-422, -438]
  ], 1.3)
  streamGroundPass(ctx, zone)
  const { rng, batches, grid } = ctx

  // LANDMARK: "The Squintern's Watchtower" — staffed by one apprentice
  // lookout who reports "white" every hour, on the hour, forever.
  {
    const tx = -422
    const tz = -444
    batches.stone.add(tx, 0, tz, 5, 1, 5, rng.pick(STONE)) // footing
    batches.stone.add(tx + 0.4, 1, tz + 0.4, 4.2, 7, 0.8, rng.pick(STONE)) // N wall
    batches.stone.add(tx + 0.4, 1, tz + 3.8, 4.2, 7, 0.8, rng.pick(STONE)) // S wall
    batches.stone.add(tx + 0.4, 1, tz + 1.2, 0.8, 7, 2.6, rng.pick(STONE)) // W wall
    batches.stone.add(tx + 3.8, 1, tz + 1.2, 0.8, 7, 2.6, rng.pick(STONE)) // E wall
    batches.wood.add(tx + 0.2, 8, tz + 0.2, 4.6, 0.5, 4.6, rng.pick(WOOD)) // deck
    for (let i = 0; i < 4; i++) {
      batches.stone.add(tx + 0.2 + i * 1.5, 8.5, tz + 0.2, 0.7, 0.8, 0.7, rng.pick(STONE))
      batches.stone.add(tx + 0.2 + i * 1.5, 8.5, tz + 4.1, 0.7, 0.8, 0.7, rng.pick(STONE))
    }
    // the watch light — shared flickering window batch, no PointLight
    batches.window.add(tx + 2, 6.4, tz - 0.1, 1, 1, 0.3, WINDOW_GLOW)
    batches.window.add(tx + 2, 6.4, tz + 4.4, 1, 1, 0.3, WINDOW_GLOW)
    grid.blockRect(tx, tz, 5, 5)
    kitFenceRun(ctx, tx - 3, tz - 3, 6, true)
    kitFenceRun(ctx, tx - 3, tz + 7, 2, true) // south fence, gate where
    kitFenceRun(ctx, tx + 4, tz + 7, 4, true) // the trail comes in
    kitFenceRun(ctx, tx - 3, tz - 2, 9, false)
    signpost(ctx, tx + 6, tz + 5)
  }

  // LANDMARK: "Lake Squint" — a flash-frozen pond, lumpy with the exact
  // silhouettes of fish who were mid-jump when winter said "and STAY down".
  {
    const px = -448
    const pz = -470
    for (let dx = -8; dx <= 8; dx++) {
      for (let dz = -6; dz <= 6; dz++) {
        if ((dx * dx) / 64 + (dz * dz) / 36 > 1) continue
        const ix = px + dx
        const iz = pz + dz
        if (surfaceAt(ctx, ix, iz) !== S_GRASS) continue
        if (rng.next() < 0.85) batches.misc.add(ix, 0, iz, 1, 0.1, 1, rng.pick(ICE))
      }
    }
    kitIceSpike(ctx, px - 2, pz + 1) // the fish
    kitIceSpike(ctx, px + 3, pz - 2)
    kitIceSpike(ctx, px + 1, pz + 3)
    kitHut(ctx, px + 10, pz - 3) // the ice-fisher's hut, catch count: zero
    crates(ctx, px + 9, pz + 2)
  }

  // whiteout steppe — sparse, wind-scoured, occasionally sneaky
  scatter(ctx, -478, -518, -362, -362, 24, (x, z) => drift(ctx, x, z))
  scatter(ctx, -478, -518, -362, -362, 16, (x, z) => kitIceSpike(ctx, x, z))
  scatter(ctx, -478, -518, -362, -362, 12, (x, z) => kitRock(ctx, x, z))
  scatter(ctx, -478, -518, -362, -362, 10, (x, z) => kitPine(ctx, x, z))
  scatter(ctx, -478, -518, -362, -362, 8, (x, z) => kitDeadTree(ctx, x, z))
})

// ---------------------------------------------------------------------------
// ironhold_attic — Ironhold's Attic (mountain 46-60)
// ---------------------------------------------------------------------------
registerZoneBuilder('ironhold_attic', (ctx, scene, zone) => {
  // haul road up from the SW corner (nearest NW-arterial bend) to the shaft
  kitPath(ctx, [
    [-356, -364], [-342, -382], [-326, -398], [-310, -414], [-300, -424]
  ], 1.4)
  // spur from the haul road up to the Hoard Shed door (surface stamps must
  // land BEFORE the ground pass paints)
  kitPath(ctx, [[-285, -436], [-292, -431], [-298, -428]], 1.1)
  streamGroundPass(ctx, zone)
  const { rng, batches, grid } = ctx

  // LANDMARK: "The Attic Door" — the old top shaft of Ironhold. Everything
  // the mountain didn't want downstairs got hauled up here and forgotten.
  mineMouth(ctx, -304, -434)
  kitLantern(ctx, scene, -297, -430) // the one lamp nobody remembers lighting
  crates(ctx, -309, -429)
  crates(ctx, -295, -426)
  batches.stone.add(-311, 0, -426, 1.4, 0.9, 1.4, rng.pick(STONE)) // ore heap
  batches.stone.add(-310.6, 0.9, -425.6, 0.7, 0.5, 0.7, rng.pick(STONE))
  grid.block(-311, -426)

  // LANDMARK: "Grandpa Ironhold's Hoard Shed" — boarded up, triple-locked,
  // and according to the sign, full of 'ABSOLUTELY NOTHING, GO AWAY'.
  // (door = 'N' → the z1 wall, facing south toward the haul road)
  kitHouseShell(ctx, { x0: -288, z0: -442, w: 7, d: 6, wallH: 3, door: 'N', chimney: true }, { plaster: STONE })
  kitFenceRun(ctx, -290, -444, 11, true) // windbreak behind the shed
  signpost(ctx, -282, -434)

  // high-shelf pines + boulders, thin air, thinner guardrails
  scatter(ctx, -316, -448, -282, -418, 10, (x, z) => kitPine(ctx, x, z, { tall: true }))
  scatter(ctx, -358, -518, -242, -362, 22, (x, z) => kitPine(ctx, x, z, { tall: rng.next() < 0.5 }))
  scatter(ctx, -358, -518, -242, -362, 20, (x, z) => kitRock(ctx, x, z, rng.next() < 0.4 ? 2 : 1))
  scatter(ctx, -358, -518, -242, -362, 8, (x, z) => kitIceSpike(ctx, x, z))
  scatter(ctx, -358, -518, -242, -440, 20, (x, z) => drift(ctx, x, z))
})

// ---------------------------------------------------------------------------
// avalanche_alley — Avalanche Alley (mountain 30-45)
// ---------------------------------------------------------------------------
registerZoneBuilder('avalanche_alley', (ctx, _scene, zone) => {
  // spur off the NW arterial (which runs right through this zone) to the
  // rescue station, then on down to the pins
  kitPath(ctx, [
    [-428, -318], [-438, -308], [-444, -298], [-440, -286], [-432, -280]
  ], 1.3)
  streamGroundPass(ctx, zone)
  const { rng, batches, grid } = ctx

  // LANDMARK: "The Pins" — ten house-sized boulders the last avalanche
  // racked into a perfect triangle at the bottom of the chute. Gravity is
  // currently warming up its next throw. You're the sweep.
  {
    const rows: ReadonlyArray<readonly [number, number]> = [
      [-432, -270], [-427, -272], [-437, -272], [-423, -275], [-432, -275],
      [-441, -275], [-419, -278], [-428, -278], [-436, -278], [-445, -278]
    ]
    for (const [bx, bz] of rows) {
      const c = rng.pick(PLASTER)
      batches.plaster.add(bx, 0, bz, 1.6, 1.6, 1.6, c) // body
      batches.plaster.add(bx + 0.3, 1.6, bz + 0.3, 1, 0.8, 1, c) // shoulder
      batches.misc.add(bx + 0.25, 2.4, bz + 0.25, 1.1, 0.3, 1.1, rng.pick(FLOWER)) // stripe
      batches.plaster.add(bx + 0.45, 2.7, bz + 0.45, 0.7, 0.6, 0.7, c) // head
      grid.blockRect(bx, bz, 2, 2)
    }
  }

  // LANDMARK: "Rescue Station 7½" — half a hut, half a prayer. The bell
  // rope is pre-frayed for your convenience. (1 ember use)
  {
    kitHut(ctx, -450, -296) // west of the trail, uphill of the pins
    kitCampfire(ctx, -444, -304)
    crates(ctx, -445, -291)
    // the avalanche bell on its gallows
    batches.wood.add(-451 + 0.3, 0, -291, 0.4, 3, 0.4, WOOD_DARK)
    batches.wood.add(-451 + 0.3, 3, -291.6, 0.4, 0.4, 1.6, WOOD_DARK)
    batches.misc.add(-451 + 0.22, 2.2, -291.5, 0.6, 0.7, 0.6, STRAW) // brass-ish bell
    grid.block(-451, -291)
    signpost(ctx, -437, -294)
  }

  // the chute itself — a diagonal scree band of tumbled boulders, NW→SE
  for (let i = 0; i < 26; i++) {
    const t = i / 26
    const bx = Math.round(-472 + t * 36 + ctx.rng.range(-5, 5))
    const bz = Math.round(-352 + t * 74 + ctx.rng.range(-4, 4))
    if (surfaceAt(ctx, bx, bz) !== S_GRASS) continue
    kitRock(ctx, bx, bz, ctx.rng.next() < 0.45 ? 2 : 1)
  }

  // treeline survivors along the flanks (the smart trees moved out years ago)
  scatter(ctx, -478, -358, -452, -242, 14, (x, z) => kitPine(ctx, x, z, { tall: true }))
  scatter(ctx, -392, -358, -362, -242, 14, (x, z) => kitPine(ctx, x, z, { tall: true }))
  scatter(ctx, -478, -358, -362, -242, 10, (x, z) => kitDeadTree(ctx, x, z))
  scatter(ctx, -478, -358, -362, -242, 12, (x, z) => kitRock(ctx, x, z))
  scatter(ctx, -478, -358, -362, -242, 22, (x, z) => drift(ctx, x, z))
})

// ---------------------------------------------------------------------------
// upper_ironhold — Upper Ironhold (mountain 14-22, the friendly frontier)
// ---------------------------------------------------------------------------
registerZoneBuilder('upper_ironhold', (ctx, scene, zone) => {
  // frontier track in from the NW arterial grazing the NW corner, down
  // past Payday Camp to the mine
  kitPath(ctx, [
    [-359, -241], [-348, -252], [-337, -263], [-330, -272], [-316, -286], [-304, -296]
  ], 1.4)
  streamGroundPass(ctx, zone)
  const { rng, batches, grid } = ctx

  // LANDMARK: "The Guardrail-Free Mine" — ore so rich and oversight so
  // absent. The headframe wheel still turns when nobody's looking.
  mineMouth(ctx, -306, -310)
  {
    const hx = -296
    const hz = -310
    batches.wood.add(hx, 0, hz, 0.5, 6, 0.5, WOOD_DARK) // four legs
    batches.wood.add(hx + 3.5, 0, hz, 0.5, 6, 0.5, WOOD_DARK)
    batches.wood.add(hx, 0, hz + 3.5, 0.5, 6, 0.5, WOOD_DARK)
    batches.wood.add(hx + 3.5, 0, hz + 3.5, 0.5, 6, 0.5, WOOD_DARK)
    batches.wood.add(hx - 0.2, 3, hz + 1.7, 4.4, 0.4, 0.6, rng.pick(WOOD)) // crossbraces
    batches.wood.add(hx + 1.7, 3.8, hz - 0.2, 0.6, 0.4, 4.4, rng.pick(WOOD))
    batches.wood.add(hx - 0.3, 6, hz - 0.3, 4.6, 0.5, 4.6, rng.pick(WOOD)) // platform
    batches.misc.add(hx + 1.4, 6.5, hz + 1.55, 1.2, 1.2, 0.3, WOOD_DARK) // the wheel
    grid.blockRect(hx, hz, 4, 4)
  }

  // LANDMARK: "Payday Camp" — where the miners spend wages they haven't
  // technically survived long enough to earn yet. Sits NORTH of the track,
  // which bends past around (-322,-280). (1 ember use)
  {
    kitHut(ctx, -322, -288)
    kitCampfire(ctx, -318, -291)
    kitLantern(ctx, scene, -314, -284) // trackside lamp — kept lit, union rules
    tent(ctx, -327, -294)
    tent(ctx, -314, -294)
    crates(ctx, -317, -296)
    crates(ctx, -324, -292)
    kitFenceRun(ctx, -326, -298, 9, true) // windbreak uphill of camp
    kitFenceRun(ctx, -328, -297, 7, false)
    signpost(ctx, -313, -281)
    // payday ore pile, guarded by absolutely no one
    batches.stone.add(-312, 0, -298, 1.6, 1, 1.6, rng.pick(STONE))
    batches.stone.add(-311.6, 1, -297.6, 0.8, 0.6, 0.8, rng.pick(STONE))
    grid.blockRect(-312, -298, 2, 2)
  }

  // gentle lower slopes: proper pines, friendly boulders, learner's terrain
  scatter(ctx, -334, -300, -286, -270, 12, (x, z) => kitPine(ctx, x, z, { tall: rng.next() < 0.6 }))
  scatter(ctx, -358, -358, -242, -242, 26, (x, z) => kitPine(ctx, x, z, { tall: rng.next() < 0.4 }))
  scatter(ctx, -358, -358, -242, -242, 18, (x, z) => kitRock(ctx, x, z, rng.next() < 0.3 ? 2 : 1))
  scatter(ctx, -358, -358, -242, -242, 10, (x, z) => drift(ctx, x, z))
})

/**
 * Barrel hook — the zones/index barrel calls this; the registerZoneBuilder
 * calls above have already run at import time, so this only needs to exist
 * (and keeps the import from being tree-shaken).
 */
export function registerBatch2(): void {
  // registration happens at module import; nothing further to do
}
