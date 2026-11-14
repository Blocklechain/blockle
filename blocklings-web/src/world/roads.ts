/**
 * Continental roads — winding cobble from the village plaza/gates out to
 * every region's waystone anchor (WAYSTONES in ../ids). Hand-placed
 * waypoints smoothed through Catmull-Rom (kitPath) so nothing reads as a
 * ruler line. Runs BEFORE buildGround so the stamps become cobble voxels.
 *
 * The road to the Forgotten Lands crosses the river on SOUTH_BRIDGE
 * (layout.ts); kitPath leaves river/bridge cells alone, so the deck IS the
 * crossing.
 */
import type { Ctx } from './layout'
import { kitPath } from './kit'

/** [x, z] waypoint chains. First point sits on an existing village road/gate;
 *  last point is the region's waystone anchor. */
const ROUTES: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  // East over the bridge → Greenwood Waystone (130, 10)
  [
    [54, 0],
    [68, 6],
    [86, -4],
    [104, 14],
    [120, 2],
    [130, 10]
  ],
  // West gate → Ironhold Waystone (-130, 10)
  [
    [-40, 0],
    [-58, 8],
    [-76, -6],
    [-96, 10],
    [-116, -2],
    [-130, 10]
  ],
  // North gate → Capital Waystone (6, -140)
  [
    [0, -40],
    [7, -62],
    [-5, -86],
    [9, -108],
    [-2, -126],
    [6, -140]
  ],
  // South gate → south-west → Ashen Waystone (-110, 150)
  [
    [-1, 40],
    [-14, 58],
    [-30, 74],
    [-52, 90],
    [-72, 108],
    [-88, 126],
    [-102, 140],
    [-110, 150]
  ],
  // South gate → south-east over SOUTH_BRIDGE → Forgotten Waystone (110, 150)
  [
    [1, 40],
    [12, 58],
    [26, 72],
    [38, 84],
    [48, 91],
    [58, 94],
    [72, 104],
    [88, 122],
    [100, 138],
    [110, 150]
  ]
]

/**
 * ARTERIALS — 8 compass highways from the heart's edge out toward the coast
 * (~±680). Stamped EAGERLY at boot (before any zone streams in) so the
 * roads exist world-wide from frame one; streamGroundPass renders the
 * pre-stamped cells as cobble when each zone's ground streams in.
 *
 * NE/NW leave from the heart's east/west edges at z=-100 (south of the
 * preserved ocean bays); the diagonals leave from the heart corners.
 */
const ARTERIALS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  // N — continues the Capital road past the north rim
  [[6, -240], [14, -300], [-6, -370], [10, -440], [-4, -520], [8, -600], [0, -680]],
  // NE — skirts the NE bay, then winds to the icy corner
  [[240, -100], [310, -160], [370, -240], [430, -320], [500, -410], [570, -500], [640, -600], [660, -660]],
  // E — out of Greenwood toward the sunrise coast
  [[240, 8], [300, -6], [370, 10], [440, -8], [520, 6], [600, -4], [680, 2]],
  // SE — from the Forgotten corner to the far shore
  [[236, 236], [300, 290], [360, 360], [420, 430], [500, 500], [570, 580], [650, 650]],
  // S — straight(ish) run south between the dunes
  [[1, 240], [-10, 300], [8, 370], [-6, 440], [12, 520], [-2, 600], [4, 680]],
  // SW — out of the Ashen corner
  [[-236, 236], [-300, 290], [-360, 360], [-420, 430], [-500, 500], [-570, 580], [-650, 650]],
  // W — past Ironhold into the far ranges
  [[-240, 6], [-300, 16], [-370, -4], [-440, 10], [-520, -8], [-600, 6], [-680, 0]],
  // NW — skirts the NW bay toward the glacier coast
  [[-240, -100], [-310, -160], [-370, -240], [-430, -320], [-500, -410], [-570, -500], [-640, -600], [-660, -660]]
]

/** Stamp every continental road + arterial into the surface map. */
export function paintRoads(ctx: Ctx): void {
  for (const route of ROUTES) kitPath(ctx, route)
  for (const route of ARTERIALS) kitPath(ctx, route, 1.6)
}
