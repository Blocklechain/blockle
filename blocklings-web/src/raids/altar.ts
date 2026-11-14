/**
 * Raid-summon altar — a standalone voxel prop, one per world boss, placed in
 * a fitting far zone. Built in the same flat-color Lambert voxel vocabulary as
 * the village + the dungeon gate: a stepped dais, four rune pillars, and a
 * central focus that glows in the boss's theme color. Returns a self-contained
 * THREE.Group (own geometry + materials + ONE theme-colored PointLight, within
 * the 2-light budget) plus its blocked footprint so the raids module can
 * register collision solids (the World grid is closed over; we never touch it).
 *
 * Origin at the base centre; the summon stand is the open cell just south (+Z)
 * of the dais, which is intentionally left walkable.
 */
import * as THREE from 'three'

export interface AltarHandle {
  group: THREE.Group
  /** Cells to mark blocked, world-space integer [ix, iz] pairs. */
  solids: ReadonlyArray<readonly [number, number]>
  /** Gentle idle pulse of the focus glow. */
  update(dt: number): void
  dispose(): void
}

export interface AltarSpec {
  cx: number
  cz: number
  color: number
  dark: number
  glow: number
}

export function buildAltar(spec: AltarSpec): AltarHandle {
  const group = new THREE.Group()
  group.position.set(spec.cx, 0, spec.cz)

  const mats: THREE.MeshLambertMaterial[] = []
  const glowMats: THREE.MeshLambertMaterial[] = []
  const mat = (c: number, emissive = 0): THREE.MeshLambertMaterial => {
    const m = new THREE.MeshLambertMaterial({ color: c })
    if (emissive) {
      m.emissive.setHex(emissive)
      glowMats.push(m)
    }
    mats.push(m)
    return m
  }
  const stone = mat(0x6b6b74)
  const stoneDark = mat(0x44444b)
  const trim = mat(spec.dark)
  const focus = mat(spec.glow, spec.glow)
  const rune = mat(spec.color, spec.glow)

  const box = (
    x: number, y: number, z: number,
    w: number, h: number, d: number,
    m: THREE.MeshLambertMaterial
  ): void => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m)
    mesh.position.set(x, y + h / 2, z)
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)
  }

  // stepped circular-ish dais (two square tiers)
  box(0, -0.1, 0, 7, 0.3, 7, stone)
  box(0, 0.2, 0, 5, 0.3, 5, stoneDark)
  box(0, 0.5, 0, 3, 0.3, 3, stone)

  // four rune pillars at the corners
  for (const [sx, sz] of [[-2.2, -2.2], [2.2, -2.2], [-2.2, 2.2], [2.2, 2.2]] as const) {
    box(sx, 0.5, sz, 0.8, 2.6, 0.8, trim)
    box(sx, 3.1, sz, 1.0, 0.4, 1.0, stoneDark) // cap
    box(sx, 1.7, sz + Math.sign(sz) * 0.42, 0.4, 0.8, 0.08, rune) // glowing rune face
  }

  // central focus: a floating glowing shard on a plinth
  box(0, 0.8, 0, 1.2, 0.5, 1.2, stoneDark)
  const shard = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.4, 0.7), focus)
  shard.position.set(0, 2.2, 0)
  shard.castShadow = true
  group.add(shard)
  const shardTop = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.7, 0.36), focus)
  shardTop.position.set(0, 3.1, 0)
  group.add(shardTop)

  // theme light (ONE PointLight — within budget; no shadow cost)
  const light = new THREE.PointLight(spec.glow, 11, 13, 1.8)
  light.position.set(0, 2.6, 0)
  group.add(light)

  // blocked footprint: the dais core (keep the south approach cell open)
  const solids: Array<readonly [number, number]> = []
  const bx = Math.floor(spec.cx)
  const bz = Math.floor(spec.cz)
  for (let ix = bx - 3; ix <= bx + 3; ix++) {
    for (let iz = bz - 3; iz <= bz + 3; iz++) {
      if (iz >= bz + 2) continue // leave the +Z approach walkable
      solids.push([ix, iz] as const)
    }
  }

  let t = Math.random() * 10
  return {
    group,
    solids,
    update(dt: number): void {
      t += dt
      const pulse = 0.8 + Math.sin(t * 2.2) * 0.2
      for (const g of glowMats) g.emissiveIntensity = pulse
      light.intensity = 9 + Math.sin(t * 2.2) * 3
      shard.rotation.y += dt * 0.6
      shardTop.rotation.y -= dt * 0.9
      shard.position.y = 2.2 + Math.sin(t * 1.6) * 0.08
    },
    dispose(): void {
      group.removeFromParent()
      group.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (mesh.isMesh) mesh.geometry.dispose()
      })
      for (const m of mats) m.dispose()
    }
  }
}
