/**
 * Structure pass — buildings (stone + timber, green tiled roofs, glowing
 * windows), the plaza well, market stall, farm plot, training dummies,
 * perimeter fences with gates, and lantern posts (the warm point lights).
 */
import * as THREE from 'three'
import {
  BUILDINGS,
  DUMMIES,
  FARM,
  FENCE_R,
  GATE_HALF,
  LANTERNS,
  STALL,
  WELL,
  type BuildingSpec,
  type Ctx
} from './layout'
import * as P from './palette'

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

function buildBuilding(ctx: Ctx, b: BuildingSpec): void {
  const { rng, grid, batches } = ctx
  const x1 = b.x0 + b.w - 1 // last cell
  const z1 = b.z0 + b.d - 1

  // Door: 2 cells wide, centred on the chosen wall
  const doorAlongX = b.door === 'N' || b.door === 'S'
  const doorLo = doorAlongX ? b.x0 + Math.floor(b.w / 2) - 1 : b.z0 + Math.floor(b.d / 2) - 1
  const doorHi = doorLo + 1

  const isDoorCell = (ix: number, iz: number): boolean => {
    switch (b.door) {
      case 'S':
        return iz === b.z0 && ix >= doorLo && ix <= doorHi
      case 'N':
        return iz === z1 && ix >= doorLo && ix <= doorHi
      case 'W':
        return ix === b.x0 && iz >= doorLo && iz <= doorHi
      case 'E':
        return ix === x1 && iz >= doorLo && iz <= doorHi
    }
  }

  // Walls: stone base course, then timber corners/studs + plaster infill
  for (let ix = b.x0; ix <= x1; ix++) {
    for (let iz = b.z0; iz <= z1; iz++) {
      const isWall = ix === b.x0 || ix === x1 || iz === b.z0 || iz === z1
      if (!isWall) continue
      const door = isDoorCell(ix, iz)
      const corner = (ix === b.x0 || ix === x1) && (iz === b.z0 || iz === z1)
      const stud = corner || (ix + iz) % 3 === 0

      // base course
      if (door) {
        batches.stone.add(ix, 0, iz, 1, 0.12, 1, rng.pick(P.STONE)) // threshold
      } else {
        batches.stone.voxel(ix, 0, iz, rng.pick(P.STONE))
      }

      // upper courses
      for (let y = 1; y < b.wallH; y++) {
        if (door && y <= 2) continue // opening (door leaf added below)
        const isWindow = y === 2 && !corner && !stud && rng.next() < 0.55
        if (isWindow) {
          batches.window.voxel(ix, y, iz, P.WINDOW_GLOW)
        } else if (stud) {
          batches.wood.voxel(ix, y, iz, P.WOOD_DARK)
        } else {
          batches.plaster.voxel(ix, y, iz, rng.pick(P.PLASTER))
        }
      }
    }
  }

  // Door leaf — a dark wooden slab filling the 2x2 opening
  switch (b.door) {
    case 'S':
      batches.wood.add(doorLo, 0.12, b.z0 + 0.35, 2, 2.1, 0.3, P.WOOD_DARK)
      break
    case 'N':
      batches.wood.add(doorLo, 0.12, z1 + 0.35, 2, 2.1, 0.3, P.WOOD_DARK)
      break
    case 'W':
      batches.wood.add(b.x0 + 0.35, 0.12, doorLo, 0.3, 2.1, 2, P.WOOD_DARK)
      break
    case 'E':
      batches.wood.add(x1 + 0.35, 0.12, doorLo, 0.3, 2.1, 2, P.WOOD_DARK)
      break
  }

  // Green tiled hip roof — layered slabs stepping in on both axes
  let rx0 = b.x0 - 1
  let rz0 = b.z0 - 1
  let rw = b.w + 2
  let rd = b.d + 2
  let layer = 0
  while (rw >= 1 && rd >= 1) {
    const y = b.wallH + layer * 0.62
    for (let ix = rx0; ix < rx0 + rw; ix++) {
      for (let iz = rz0; iz < rz0 + rd; iz++) {
        // only instance the visible ring of each slab (plus full top layer)
        const ring = ix === rx0 || ix === rx0 + rw - 1 || iz === rz0 || iz === rz0 + rd - 1
        if (ring || (rw <= 3 && rd <= 3)) {
          batches.roof.add(ix, y, iz, 1, 0.62, 1, rng.pick(P.ROOF))
        }
      }
    }
    rx0++
    rz0++
    rw -= 2
    rd -= 2
    layer++
  }

  // Chimney
  if (b.chimney) {
    const cy = b.wallH + layer * 0.62
    batches.stone.add(x1 - 1, b.wallH, z1 - 1, 1, cy - b.wallH + 1.1, 1, rng.pick(P.STONE))
  }

  grid.blockRect(b.x0, b.z0, b.w, b.d)
}

// ---------------------------------------------------------------------------
// Plaza well
// ---------------------------------------------------------------------------

function buildWell(ctx: Ctx): void {
  const { rng, grid, batches } = ctx
  const { x0, z0, w, d } = WELL
  for (let ix = x0; ix < x0 + w; ix++) {
    for (let iz = z0; iz < z0 + d; iz++) {
      const ring = ix === x0 || ix === x0 + w - 1 || iz === z0 || iz === z0 + d - 1
      if (ring) batches.stone.voxel(ix, 0, iz, rng.pick(P.STONE))
      else batches.misc.add(ix, 0, iz, 1, 0.55, 1, P.WATER) // water inside
    }
  }
  // posts + windlass + mini green roof
  batches.wood.add(x0 + 0.35, 1, z0 + 1.35, 0.3, 2, 0.3, P.WOOD_DARK)
  batches.wood.add(x0 + w - 0.65, 1, z0 + 1.35, 0.3, 2, 0.3, P.WOOD_DARK)
  batches.wood.add(x0, 2.6, z0 + 1.4, w, 0.2, 0.2, P.WOOD_DARK)
  batches.roof.add(x0 - 0.4, 2.9, z0 - 0.4, w + 0.8, 0.5, d + 0.8, P.ROOF[0])
  batches.roof.add(x0 + 0.4, 3.4, z0 + 0.4, w - 0.8, 0.5, d - 0.8, P.ROOF[2])
  grid.blockRect(x0, z0, w, d)
}

// ---------------------------------------------------------------------------
// Market stall (striped awning)
// ---------------------------------------------------------------------------

function buildStall(ctx: Ctx): void {
  const { rng, grid, batches } = ctx
  const { x0, z0, w, d } = STALL
  // counter
  for (let ix = x0; ix < x0 + w; ix++) {
    for (let iz = z0; iz < z0 + d; iz++) {
      batches.wood.voxel(ix, 0, iz, rng.pick(P.WOOD))
    }
  }
  // goods on the counter
  batches.misc.add(x0 + 0.5, 1, z0 + 0.5, 0.5, 0.5, 0.5, 0xd93b3b) // apples
  batches.misc.add(x0 + 1.6, 1, z0 + 1.4, 0.6, 0.4, 0.6, 0xf0c33c) // cheese
  batches.misc.add(x0 + 2.8, 1, z0 + 0.6, 0.5, 0.6, 0.5, 0x7a4e26) // bread
  // corner posts
  for (const [px, pz] of [
    [x0 + 0.1, z0 + 0.1],
    [x0 + w - 0.4, z0 + 0.1],
    [x0 + 0.1, z0 + d - 0.4],
    [x0 + w - 0.4, z0 + d - 0.4]
  ] as const) {
    batches.wood.add(px, 1, pz, 0.3, 2, 0.3, P.WOOD_DARK)
  }
  // striped awning, red/white along x
  for (let ix = x0 - 1; ix < x0 + w + 1; ix++) {
    const color = (ix - x0) % 2 === 0 ? 0xd94040 : 0xf2ede2
    batches.misc.add(ix, 3, z0 - 1, 1, 0.28, d + 2, color)
  }
  grid.blockRect(x0, z0, w, d)
}

// ---------------------------------------------------------------------------
// Farm plot
// ---------------------------------------------------------------------------

function buildFarm(ctx: Ctx): void {
  const { rng, grid, batches } = ctx
  const { x0, z0, w, d } = FARM
  for (let iz = z0; iz < z0 + d; iz++) {
    const row = iz - z0
    if (row % 2 === 1) {
      for (let ix = x0 + 1; ix < x0 + w - 1; ix++) {
        // raised tilled ridge + a crop sprout
        batches.path.add(ix, 0, iz, 1, 0.25, 1, P.SOIL_TILLED)
        if (rng.next() < 0.85) {
          const h = rng.range(0.3, 0.7)
          batches.misc.add(ix + 0.3, 0.25, iz + 0.3, 0.4, h, 0.4, rng.pick(P.CROP))
        }
      }
    }
  }
  // low fence around the plot
  for (let ix = x0 - 1; ix <= x0 + w; ix++) {
    for (const iz of [z0 - 1, z0 + d]) {
      batches.wood.add(ix + 0.3, 0, iz + 0.3, 0.4, 0.8, 0.4, rng.pick(P.WOOD))
      ctx.grid.block(ix, iz)
    }
  }
  for (let iz = z0; iz < z0 + d; iz++) {
    for (const ix of [x0 - 1, x0 + w]) {
      batches.wood.add(ix + 0.3, 0, iz + 0.3, 0.4, 0.8, 0.4, rng.pick(P.WOOD))
      ctx.grid.block(ix, iz)
    }
  }
  grid.blockRect(x0, z0, w, d)
}

// ---------------------------------------------------------------------------
// Training dummies
// ---------------------------------------------------------------------------

function buildDummies(ctx: Ctx): void {
  const { grid, batches } = ctx
  for (const [ix, iz] of DUMMIES) {
    batches.wood.add(ix + 0.35, 0, iz + 0.35, 0.3, 1.9, 0.3, P.WOOD_DARK) // post
    batches.wood.add(ix - 0.3, 1.1, iz + 0.38, 1.6, 0.24, 0.24, P.WOOD[0] as number) // arms
    batches.misc.add(ix + 0.2, 1.9, iz + 0.2, 0.6, 0.6, 0.6, P.STRAW) // straw head
    batches.misc.add(ix + 0.15, 0.6, iz + 0.28, 0.7, 0.9, 0.5, P.STRAW) // straw body
    grid.block(ix, iz)
  }
}

// ---------------------------------------------------------------------------
// Perimeter fence + gates
// ---------------------------------------------------------------------------

function fenceCell(ctx: Ctx, ix: number, iz: number, alongX: boolean): void {
  const { rng, batches, grid } = ctx
  grid.block(ix, iz)
  if ((alongX ? ix : iz) % 2 === 0) {
    batches.wood.add(ix + 0.35, 0, iz + 0.35, 0.3, 1.2, 0.3, rng.pick(P.WOOD))
  }
  if (alongX) {
    batches.wood.add(ix, 0.45, iz + 0.4, 1, 0.14, 0.2, P.WOOD_DARK)
    batches.wood.add(ix, 0.9, iz + 0.4, 1, 0.14, 0.2, P.WOOD_DARK)
  } else {
    batches.wood.add(ix + 0.4, 0.45, iz, 0.2, 0.14, 1, P.WOOD_DARK)
    batches.wood.add(ix + 0.4, 0.9, iz, 0.2, 0.14, 1, P.WOOD_DARK)
  }
}

function gatePillars(ctx: Ctx, cells: ReadonlyArray<readonly [number, number]>): void {
  for (const [ix, iz] of cells) {
    ctx.batches.stone.add(ix, 0, iz, 1, 2.2, 1, P.STONE[0] as number)
    ctx.batches.stone.add(ix - 0.12, 2.2, iz - 0.12, 1.24, 0.4, 1.24, P.STONE[1] as number)
    ctx.grid.block(ix, iz)
  }
}

function buildFence(ctx: Ctx): void {
  const R = FENCE_R
  for (let i = -R; i <= R; i++) {
    const inGate = Math.abs(i) <= GATE_HALF
    // north + south walls (fixed z, varying x)
    if (!inGate) {
      fenceCell(ctx, i, -R, true)
      fenceCell(ctx, i, R, true)
      // east + west walls (fixed x, varying z)
      fenceCell(ctx, -R, i, false)
      fenceCell(ctx, R, i, false)
    }
  }
  gatePillars(ctx, [
    [-GATE_HALF - 1, -R],
    [GATE_HALF + 1, -R],
    [-GATE_HALF - 1, R],
    [GATE_HALF + 1, R],
    [-R, -GATE_HALF - 1],
    [-R, GATE_HALF + 1],
    [R, -GATE_HALF - 1],
    [R, GATE_HALF + 1]
  ])
}

// ---------------------------------------------------------------------------
// Lantern posts (the only point lights — keep LANTERNS short)
// ---------------------------------------------------------------------------

function buildLanterns(ctx: Ctx, scene: THREE.Scene): void {
  for (const [ix, iz] of LANTERNS) {
    ctx.batches.wood.add(ix + 0.38, 0, iz + 0.38, 0.24, 2.3, 0.24, P.WOOD_DARK)
    ctx.batches.wood.add(ix + 0.38, 2.3, iz + 0.1, 0.24, 0.16, 0.8, P.WOOD_DARK)
    ctx.batches.window.add(ix + 0.3, 1.95, iz + 0.02, 0.4, 0.45, 0.4, P.WINDOW_GLOW)
    const light = new THREE.PointLight(0xffb45e, 14, 10, 1.8)
    light.position.set(ix + 0.5, 2.2, iz + 0.2)
    scene.add(light)
    ctx.grid.block(ix, iz)
  }
}

// ---------------------------------------------------------------------------
// Plaza benches
// ---------------------------------------------------------------------------

function buildBenches(ctx: Ctx): void {
  const spots: ReadonlyArray<readonly [number, number, boolean]> = [
    [-5, 4, true],
    [4, -6, true],
    [-6, -4, false]
  ]
  for (const [ix, iz, alongX] of spots) {
    if (alongX) ctx.batches.wood.add(ix, 0.35, iz + 0.25, 1.8, 0.18, 0.6, P.WOOD[1] as number)
    else ctx.batches.wood.add(ix + 0.25, 0.35, iz, 0.6, 0.18, 1.8, P.WOOD[1] as number)
    ctx.batches.wood.add(ix + 0.15, 0, iz + 0.3, 0.25, 0.35, 0.4, P.WOOD_DARK)
    ctx.batches.wood.add(ix + (alongX ? 1.4 : 0.15), 0, iz + (alongX ? 0.3 : 1.4), 0.25, 0.35, 0.4, P.WOOD_DARK)
    ctx.grid.block(ix, iz)
    ctx.grid.block(ix + (alongX ? 1 : 0), iz + (alongX ? 0 : 1))
  }
}

/** Build every structure in the village. */
export function buildVillage(ctx: Ctx, scene: THREE.Scene): void {
  for (const b of BUILDINGS) buildBuilding(ctx, b)
  buildWell(ctx)
  buildStall(ctx)
  buildFarm(ctx)
  buildDummies(ctx)
  buildFence(ctx)
  buildLanterns(ctx, scene)
  buildBenches(ctx)
}
