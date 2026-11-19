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
 * ARTERIALS — compass highways from the heart's edge all the way out to the
 * far coast (~±2300). Stamped EAGERLY at boot (before any zone streams in) so
 * the roads exist world-wide from frame one; streamGroundPass renders the
 * pre-stamped cells as cobble when each zone's ground streams in.
 *
 * The 4 cardinal roads cross the whole continent to the new coast; the 4
 * diagonals strike out past the old ±720 ring toward the corner approaches.
 * NE/NW leave from the heart's east/west edges at z=-100 (south of the
 * preserved ocean bays); the diagonals leave from the heart corners.
 */
const ARTERIALS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  // N — continues the Capital road clear to the north coast
  [[6, -240], [14, -400], [-6, -600], [10, -820], [-8, -1040], [14, -1280],
   [-6, -1520], [12, -1760], [-4, -2000], [8, -2240]],
  // NE — skirts the NE bay, then runs to the icy corner approaches
  [[240, -100], [370, -240], [500, -410], [660, -620], [840, -840], [1040, -1060],
   [1260, -1280], [1500, -1520], [1760, -1760], [2040, -2020]],
  // E — out of Greenwood all the way to the sunrise coast
  [[240, 8], [400, -6], [600, 12], [820, -10], [1040, 10], [1280, -8], [1520, 10],
   [1760, -6], [2000, 8], [2260, -4]],
  // SE — from the Forgotten corner to the far shore
  [[236, 236], [360, 360], [500, 500], [680, 680], [880, 880], [1080, 1080],
   [1300, 1300], [1540, 1540], [1780, 1780], [2040, 2040]],
  // S — straight(ish) run south between the dunes to the south coast
  [[1, 240], [-10, 400], [8, 600], [-8, 820], [12, 1040], [-6, 1280], [10, 1520],
   [-4, 1760], [8, 2000], [-2, 2260]],
  // SW — out of the Ashen corner to the swamp-coast edge
  [[-236, 236], [-360, 360], [-500, 500], [-680, 680], [-880, 880], [-1080, 1080],
   [-1300, 1300], [-1540, 1540], [-1780, 1780], [-2040, 2040]],
  // W — past Ironhold and the far ranges to the western cliffs
  [[-240, 6], [-400, 16], [-600, -4], [-820, 10], [-1040, -8], [-1280, 8],
   [-1520, -6], [-1760, 10], [-2000, -4], [-2260, 6]],
  // NW — skirts the NW bay toward the glacier coast
  [[-240, -100], [-370, -240], [-500, -410], [-660, -620], [-840, -840], [-1040, -1060],
   [-1260, -1280], [-1500, -1520], [-1760, -1760], [-2040, -2020]]
]

/** Stamp every continental road + arterial into the surface map. */
export function paintRoads(ctx: Ctx): void {
  for (const route of ROUTES) kitPath(ctx, route)
  for (const route of ARTERIALS) kitPath(ctx, route, 1.6)
}
