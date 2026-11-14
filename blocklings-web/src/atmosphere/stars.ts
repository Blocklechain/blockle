/**
 * Star field — ONE Points cloud on a dome that follows the player.
 *
 * ~650 stars scattered on the upper hemisphere of a radius-230 dome (inside
 * the camera's 300 far plane), with per-star size jitter baked into a few
 * discrete size tiers via vertex colors (brightness jitter). Fog is disabled
 * on the material so the horizon doesn't eat them; visibility is a single
 * opacity ramp driven by the schedule. Zero per-frame allocations.
 */
import * as THREE from 'three'

const STAR_COUNT = 650
const DOME_RADIUS = 230

export class StarField {
  readonly points: THREE.Points
  private readonly mat: THREE.PointsMaterial

  constructor(scene: THREE.Scene) {
    const pos = new Float32Array(STAR_COUNT * 3)
    const col = new Float32Array(STAR_COUNT * 3)
    for (let i = 0; i < STAR_COUNT; i++) {
      // Uniform-ish on the upper hemisphere, biased a little off the horizon.
      const az = Math.random() * Math.PI * 2
      const el = Math.asin(0.08 + Math.random() * 0.92)
      const c = Math.cos(el)
      pos[i * 3] = Math.cos(az) * c * DOME_RADIUS
      pos[i * 3 + 1] = Math.sin(el) * DOME_RADIUS
      pos[i * 3 + 2] = Math.sin(az) * c * DOME_RADIUS
      // Brightness jitter + the occasional faintly warm or blue star.
      const b = 0.45 + Math.random() * 0.55
      const tint = Math.random()
      col[i * 3] = b * (tint > 0.9 ? 1 : 0.92)
      col[i * 3 + 1] = b * 0.95
      col[i * 3 + 2] = b * (tint < 0.1 ? 1 : 0.92)
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3))

    this.mat = new THREE.PointsMaterial({
      size: 1.6,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false
    })

    this.points = new THREE.Points(geo, this.mat)
    this.points.visible = false
    this.points.renderOrder = -1
    this.points.frustumCulled = false
    scene.add(this.points)
  }

  /** Follow the player and apply the schedule's star opacity. */
  update(anchor: THREE.Vector3, opacity: number): void {
    this.points.position.set(anchor.x, anchor.y, anchor.z)
    this.mat.opacity = opacity
    this.points.visible = opacity > 0.01
  }
}
