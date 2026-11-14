/**
 * Trial of the Deep — the instanced arena room.
 *
 * A self-contained voxel chamber built FRESH on entry at a far, out-of-world
 * centre (where the open-world combat spawner is dormant — see index.ts). The
 * floor and walls are each ONE InstancedMesh (one draw call each); braziers add
 * at most two ember PointLights. Nothing here touches the world collision grid
 * — the dungeon module overrides world.isBlocked with this room's walls for the
 * duration of a run and restores it on exit.
 *
 * Local space: origin at the room centre, floor at y≈0, +Z toward the camera-
 * near side. The group is positioned at the world centre; collision/clamp
 * helpers take WORLD coordinates.
 */
import * as THREE from 'three'

/** Floor palette per tier (darker + cooler as you descend). */
const FLOOR_PALETTES: readonly (readonly number[])[] = [
  [0x3a3a40, 0x33333a, 0x44444b, 0x2d2d33],
  [0x313138, 0x2b2b31, 0x3a3a42, 0x26262c],
  [0x2b2730, 0x262229, 0x332e3a, 0x201d24],
  [0x2a2028, 0x241a22, 0x342532, 0x1d141b]
]
const WALL_COLORS: readonly number[] = [0x24242b, 0x201d26, 0x2a1f28, 0x271a24]
const EMBER = 0xff6a2a

export interface Arena {
  group: THREE.Group
  /** World-space centre (player teleports here). */
  center: THREE.Vector3
  /** Interior half-extent in cells (square room is 2*half across). */
  half: number
  /** World-space wall collision (fed into the overridden world.isBlocked). */
  isBlocked(x: number, z: number): boolean
  /** Hard-clamp a world-space position just inside the walls (belt + braces). */
  clamp(pos: THREE.Vector3): void
  /** A world-space point on the spawn ring near the walls. */
  spawnPoint(rng: () => number): { x: number; z: number }
  dispose(): void
}

export function buildArena(center: THREE.Vector3, tierId: number): Arena {
  const group = new THREE.Group()
  group.position.copy(center)

  const half = 13 // 26x26 cells; interior walkable ~24x24
  const pal = FLOOR_PALETTES[Math.min(tierId, FLOOR_PALETTES.length - 1)] ?? FLOOR_PALETTES[0]!
  const wallColor = WALL_COLORS[Math.min(tierId, WALL_COLORS.length - 1)] ?? WALL_COLORS[0]!
  const disposables: { dispose(): void }[] = []

  // --- floor: one InstancedMesh, dappled flat colors ----------------------
  const floorGeo = new THREE.BoxGeometry(1, 0.2, 1)
  const floorMat = new THREE.MeshLambertMaterial({ vertexColors: true })
  disposables.push(floorGeo, floorMat)
  const floorCount = (half * 2) * (half * 2)
  const floor = new THREE.InstancedMesh(floorGeo, floorMat, floorCount)
  floor.receiveShadow = true
  const dummy = new THREE.Object3D()
  const col = new THREE.Color()
  let fi = 0
  for (let ix = -half; ix < half; ix++) {
    for (let iz = -half; iz < half; iz++) {
      dummy.position.set(ix + 0.5, -0.1, iz + 0.5)
      dummy.updateMatrix()
      floor.setMatrixAt(fi, dummy.matrix)
      col.setHex(pal[(ix * 7 + iz * 13 + 1000) % pal.length] ?? pal[0]!)
      floor.setColorAt(fi, col)
      fi++
    }
  }
  floor.instanceMatrix.needsUpdate = true
  if (floor.instanceColor) floor.instanceColor.needsUpdate = true
  group.add(floor)

  // --- walls: one InstancedMesh ring, 3 tall, one cell thick ---------------
  const wallCells: [number, number][] = []
  for (let ix = -half - 1; ix <= half; ix++) {
    wallCells.push([ix, -half - 1], [ix, half])
  }
  for (let iz = -half; iz < half; iz++) {
    wallCells.push([-half - 1, iz], [half, iz])
  }
  const wallGeo = new THREE.BoxGeometry(1, 3, 1)
  const wallMat = new THREE.MeshLambertMaterial({ color: wallColor })
  disposables.push(wallGeo, wallMat)
  const walls = new THREE.InstancedMesh(wallGeo, wallMat, wallCells.length)
  walls.castShadow = true
  walls.receiveShadow = true
  wallCells.forEach(([ix, iz], i) => {
    dummy.position.set(ix + 0.5, 1.5, iz + 0.5)
    dummy.updateMatrix()
    walls.setMatrixAt(i, dummy.matrix)
  })
  walls.instanceMatrix.needsUpdate = true
  group.add(walls)

  // --- braziers: ember glow in all four corners, LIGHTS in only two --------
  const emberMat = new THREE.MeshLambertMaterial({ color: EMBER, emissive: EMBER, emissiveIntensity: 0.9 })
  const stoneMat = new THREE.MeshLambertMaterial({ color: 0x1c1c22 })
  const bowlGeo = new THREE.BoxGeometry(0.9, 0.5, 0.9)
  const postGeo = new THREE.BoxGeometry(0.4, 1.3, 0.4)
  const fireGeo = new THREE.BoxGeometry(0.6, 0.6, 0.6)
  disposables.push(emberMat, stoneMat, bowlGeo, postGeo, fireGeo)
  const corners: [number, number, boolean][] = [
    [-(half - 2), -(half - 2), true],
    [half - 2, half - 2, true],
    [-(half - 2), half - 2, false],
    [half - 2, -(half - 2), false]
  ]
  for (const [lx, lz, lit] of corners) {
    const post = new THREE.Mesh(postGeo, stoneMat)
    post.position.set(lx, 0.65, lz)
    post.castShadow = true
    const bowl = new THREE.Mesh(bowlGeo, stoneMat)
    bowl.position.set(lx, 1.35, lz)
    const fire = new THREE.Mesh(fireGeo, emberMat)
    fire.position.set(lx, 1.75, lz)
    group.add(post, bowl, fire)
    if (lit) {
      const light = new THREE.PointLight(EMBER, 16, 26, 1.7)
      light.position.set(lx, 2.0, lz)
      group.add(light)
    }
  }

  const minL = -half + 0.6
  const maxL = half - 0.6

  return {
    group,
    center: center.clone(),
    half,
    isBlocked(x: number, z: number): boolean {
      const lx = x - center.x
      const lz = z - center.z
      return lx <= minL || lx >= maxL || lz <= minL || lz >= maxL
    },
    clamp(pos: THREE.Vector3): void {
      pos.x = Math.max(center.x + minL, Math.min(center.x + maxL, pos.x))
      pos.z = Math.max(center.z + minL, Math.min(center.z + maxL, pos.z))
    },
    spawnPoint(rng: () => number): { x: number; z: number } {
      const a = rng() * Math.PI * 2
      const r = (half - 2) * (0.75 + rng() * 0.2)
      return { x: center.x + Math.cos(a) * r, z: center.z + Math.sin(a) * r }
    },
    dispose(): void {
      group.removeFromParent()
      floor.dispose()
      walls.dispose()
      for (const d of disposables) d.dispose()
    }
  }
}
