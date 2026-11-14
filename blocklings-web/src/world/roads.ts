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

/** Stamp every continental road into the surface map. */
export function paintRoads(ctx: Ctx): void {
  for (const route of ROUTES) kitPath(ctx, route)
}
