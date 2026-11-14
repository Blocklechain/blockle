/**
 * Region dispatch — runs every region builder after the base continent
 * passes (surfaces, roads, village, nature, borders) and BEFORE the ground
 * instancing + batch bake, so region voxels land in the same InstancedMesh
 * batches and surface stamps (kitPath) still take effect.
 *
 * Region agents own the BODIES of ./<id>.ts; this call order is the
 * integrator's.
 */
import type * as THREE from 'three'
import type { Ctx } from '../layout'
import { buildRegion as buildGreenwood } from './greenwood'
import { buildRegion as buildIronhold } from './ironhold'
import { buildRegion as buildCapital } from './capital'
import { buildRegion as buildAshen } from './ashen'
import { buildRegion as buildForgotten } from './forgotten'

export function buildRegions(ctx: Ctx, scene: THREE.Scene): void {
  buildGreenwood(ctx, scene)
  buildIronhold(ctx, scene)
  buildCapital(ctx, scene)
  buildAshen(ctx, scene)
  buildForgotten(ctx, scene)
}
