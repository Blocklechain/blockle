/**
 * Fireflies — one small additive Points swarm around the player, alive only
 * at night in the cozy-wet biomes (forest / swamp / cherry).
 *
 * 84 motes scattered within ~22 units of the player, each hovering above the
 * walkable ground (groundHeight sampled once at scatter time, never per
 * frame). Per-frame motion is pure sin drift written into the preallocated
 * position buffer — zero allocations. The swarm fades with a single material
 * opacity and re-scatters around the player only while invisible or once the
 * player has walked far from the current anchor.
 */
import * as THREE from 'three'
import type { World } from '../types'

const COUNT = 84
const RADIUS = 22
/** Re-scatter when the player gets this far from the swarm anchor. */
const RESEAT_DIST = 26

export class Fireflies {
  readonly points: THREE.Points
  private readonly mat: THREE.PointsMaterial
  private readonly posAttr: THREE.BufferAttribute
  /** Per-mote rest position (x, y, z). */
  private readonly base = new Float32Array(COUNT * 3)
  /** Per-mote drift seeds (phase, bob freq, wander freq, wander radius). */
  private readonly seed = new Float32Array(COUNT * 4)
  private readonly anchor = new THREE.Vector3(0, -9999, 0)
  private opacity = 0
  private t = Math.random() * 100

  constructor(scene: THREE.Scene, private readonly world: World) {
    const pos = new Float32Array(COUNT * 3)
    const geo = new THREE.BufferGeometry()
    this.posAttr = new THREE.BufferAttribute(pos, 3)
    this.posAttr.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('position', this.posAttr)

    this.mat = new THREE.PointsMaterial({
      color: 0xd8f07a, // warm yellow-green lantern-bug glow
      size: 0.28,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false
    })

    for (let i = 0; i < COUNT; i++) {
      this.seed[i * 4] = Math.random() * Math.PI * 2
      this.seed[i * 4 + 1] = 0.6 + Math.random() * 0.9
      this.seed[i * 4 + 2] = 0.15 + Math.random() * 0.35
      this.seed[i * 4 + 3] = 0.5 + Math.random() * 1.1
    }

    this.points = new THREE.Points(geo, this.mat)
    this.points.visible = false
    this.points.frustumCulled = false
    scene.add(this.points)
  }

  /** Scatter the swarm's rest positions around `center` (not per-frame). */
  private scatter(center: THREE.Vector3): void {
    for (let i = 0; i < COUNT; i++) {
      const az = Math.random() * Math.PI * 2
      const r = 3 + Math.sqrt(Math.random()) * (RADIUS - 3)
      const x = center.x + Math.cos(az) * r
      const z = center.z + Math.sin(az) * r
      const y = this.world.groundHeight(x, z) + 0.5 + Math.random() * 1.6
      this.base[i * 3] = x
      this.base[i * 3 + 1] = y
      this.base[i * 3 + 2] = z
    }
    this.anchor.copy(center)
  }

  /**
   * @param playerPos  player feet position (swarm anchor source)
   * @param active     true when the biome wants fireflies AND it's night
   * @param dt         frame delta (seconds)
   */
  update(playerPos: THREE.Vector3, active: boolean, dt: number): void {
    this.t += dt

    // Fade toward the target, re-scattering only while fully invisible or
    // after the player has outwalked the swarm.
    const target = active ? 0.85 : 0
    const k = 1 - Math.exp(-dt * 1.5)
    this.opacity += (target - this.opacity) * k
    const far = playerPos.distanceTo(this.anchor) > RESEAT_DIST
    if ((this.opacity < 0.02 && target > 0) || (far && this.opacity < 0.06)) {
      this.scatter(playerPos)
    }

    this.mat.opacity = this.opacity
    this.points.visible = this.opacity > 0.015
    if (!this.points.visible) return

    // Sin-drift every mote around its rest position (no allocations).
    const arr = this.posAttr.array as Float32Array
    for (let i = 0; i < COUNT; i++) {
      const ph = this.seed[i * 4]!
      const bobF = this.seed[i * 4 + 1]!
      const wanF = this.seed[i * 4 + 2]!
      const wanR = this.seed[i * 4 + 3]!
      const wt = this.t * wanF + ph
      arr[i * 3] = this.base[i * 3]! + Math.sin(wt) * wanR
      arr[i * 3 + 1] = this.base[i * 3 + 1]! + Math.sin(this.t * bobF + ph * 2) * 0.35
      arr[i * 3 + 2] = this.base[i * 3 + 2]! + Math.cos(wt * 0.83) * wanR
    }
    this.posAttr.needsUpdate = true
  }
}
