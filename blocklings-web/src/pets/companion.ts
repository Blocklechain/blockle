/**
 * The active pet companion — a mini (0.45x) rebuild of its species voxel
 * model in the variant palette that follows at the player's heel, joins
 * fights against the player's current target at ~25% of the player's dps
 * (same cute swing/bob as the species rig), and cowers instead of dying
 * when morale breaks, rejoining after 10 seconds.
 *
 * The species rig itself comes from an integrator-wired mesh source
 * (combat's species builder, see MobMeshSource) so the pet is ALWAYS the
 * real model — this module only shrinks, recolors and drives it. Until the
 * source is wired a cute fallback blob stands in, honestly.
 */
import * as THREE from 'three'
import type { PetVariant, PlayerState, World } from '../types'
import { events } from '../events'
import { applyVariantPalette, buildAura, disposeAura, type AuraKind } from './palette'
import { cowerLine } from './flavor'

// ---------------------------------------------------------------------------
// Wiring contracts (exposed through the pets module's setters)
// ---------------------------------------------------------------------------

/**
 * What the pet needs from a built species model. Combat's MobRig satisfies
 * this structurally, so the integrator wires:
 *   pets.setMobMeshSource((species, boss) => {
 *     const def = SPECIES.find((s) => s.id === species)
 *     return def ? new MobRig(def, boss) : null
 *   })
 */
export interface PetRig {
  /** Scene node; position = feet, rotation.y = facing. */
  group: THREE.Group
  /** Top-of-head height in world units (at the rig's own scale). */
  height: number
  /** Per-frame procedural animation (the cute bob/waddle/flap). */
  update(dt: number, moving: boolean, speed01: number): void
  /** Optional attack snap (MobRig.strikeLunge). */
  strikeLunge?(): void
  dispose?(): void
}

/** Builds a FRESH species voxel rig ('boss' = with the boss flair). */
export type MobMeshSource = (species: string, boss: boolean) => PetRig | null

/**
 * The player's current combat target, as combat exposes it to the
 * integrator. hit() applies the pet's damage through combat's own
 * pipeline (damage numbers, 'mob:hit', death flow).
 */
export interface PetTarget {
  x: number
  z: number
  /** Body radius (reach = radius + pet arm). */
  radius: number
  alive: boolean
  hit(amount: number): void
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const PET_SCALE = 0.45
const HEEL_DIST = 1.15
const HEEL_ANGLE = 2.45 // radians off the player's facing: behind-left
const MOVE_SPEED = 4.4
const TELEPORT_DIST = 16 // fell too far behind (waystone travel) -> pop to heel
const SWING_COOLDOWN = 1.4
const PET_DPS_FRACTION = 0.25
const FALLBACK_PLAYER_DPS = 4
const COWER_SECS = 10
const COWER_ENTER = 0.3
const COWER_EXIT_MORALE = 0.85
const MORALE_REGEN = 0.05

interface FollowDeps {
  scene: THREE.Scene
  world: World
  player: PlayerState
  rigSource(): MobMeshSource | null
  target(): PetTarget | null
  playerDps(): number
}

// ---------------------------------------------------------------------------
// Fallback rig (pre-wiring): a bouncy little voxel blob with a face-less
// lighter top-blob — same silhouette language, zero pretence.
// ---------------------------------------------------------------------------

class FallbackRig implements PetRig {
  readonly group = new THREE.Group()
  readonly height = 0.85
  private readonly body = new THREE.Group()
  private readonly mats: THREE.MeshLambertMaterial[] = []
  private phase = Math.random() * Math.PI * 2
  private t = 0

  constructor(color: number) {
    const mk = (w: number, h: number, d: number, c: number): THREE.Mesh => {
      const mat = new THREE.MeshLambertMaterial({ color: c })
      this.mats.push(mat)
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
      mesh.castShadow = true
      return mesh
    }
    const base = new THREE.Color(color)
    const body = mk(0.7, 0.7, 0.7, color)
    body.position.y = 0.35
    const top = mk(0.34, 0.18, 0.34, base.clone().offsetHSL(0, 0, 0.1).getHex())
    top.position.set(-0.1, 0.72, -0.06)
    const eyeL = mk(0.1, 0.12, 0.04, 0x20242e)
    eyeL.position.set(-0.15, 0.45, 0.36)
    const eyeR = mk(0.1, 0.12, 0.04, 0x20242e)
    eyeR.position.set(0.15, 0.45, 0.36)
    this.body.add(body, top, eyeL, eyeR)
    this.group.add(this.body)
  }

  update(dt: number, moving: boolean, speed01: number): void {
    this.t += dt
    const damp = Math.min(1, dt * 10)
    if (moving) {
      this.phase += dt * 9 * (0.4 + 0.6 * speed01)
      const hop = Math.abs(Math.sin(this.phase))
      this.body.position.y = hop * 0.2
      this.body.scale.y = 0.92 + hop * 0.16
    } else {
      const j = Math.sin(this.t * 5.2)
      this.body.scale.y += (1 + j * 0.05 - this.body.scale.y) * damp
      this.body.position.y *= 1 - damp
    }
    this.body.scale.z += (1 - this.body.scale.z) * damp // lunge snap eases back
  }

  strikeLunge(): void {
    this.body.scale.z = 1.3 // snap forward; eases back in update()
  }

  dispose(): void {
    this.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.geometry.dispose()
    })
    for (const mat of this.mats) mat.dispose()
    this.mats.length = 0
  }
}

// ---------------------------------------------------------------------------
// Companion
// ---------------------------------------------------------------------------

export class Companion {
  private readonly deps: FollowDeps
  private rig: PetRig | null = null
  private aura: { group: THREE.Group; kind: AuraKind } | null = null
  private petSpecies: string | null = null
  private petVariant: PetVariant = 'base'
  private speciesColor = 0x7ed957
  private builtWithFallback = false

  private x = 0
  private z = 0
  private y = 0
  private facing = 0
  private placed = false

  private state: 'heel' | 'cower' = 'heel'
  private morale = 1
  private cowerUntil = 0
  private nextSwingAt = 0
  private auraT = Math.random() * 10

  private readonly offDamaged: () => void
  private readonly offDied: () => void
  private raf = 0
  private lastMs = performance.now()

  constructor(deps: FollowDeps) {
    this.deps = deps
    // morale: the pet shares the player's pain (vicariously, loudly)
    this.offDamaged = events.on('player:damaged', ({ amount }) => {
      const frac = amount / Math.max(1, deps.player.maxHp)
      this.morale = Math.max(0, this.morale - frac * 1.4)
    })
    this.offDied = events.on('player:died', () => {
      this.morale = 0
    })
    const tick = (nowMs: number): void => {
      this.raf = requestAnimationFrame(tick)
      const dt = Math.min((nowMs - this.lastMs) / 1000, 0.1)
      this.lastMs = nowMs
      this.update(dt, nowMs / 1000)
    }
    this.raf = requestAnimationFrame(tick)
  }

  /** Swap the active pet (null dismisses). Rebuilds the mini rig. */
  setPet(pet: { species: string; variant: PetVariant; speciesColor: number } | null): void {
    this.teardownRig()
    if (!pet) {
      this.petSpecies = null
      return
    }
    this.petSpecies = pet.species
    this.petVariant = pet.variant
    this.speciesColor = pet.speciesColor
    this.buildRig()
  }

  /** A mesh source wired after the pet was set: upgrade the fallback blob. */
  refreshRig(): void {
    if (this.petSpecies && (this.builtWithFallback || !this.rig)) {
      this.teardownRig()
      this.buildRig()
    }
  }

  private buildRig(): void {
    if (!this.petSpecies) return
    const source = this.deps.rigSource()
    const built = source ? source(this.petSpecies, this.petVariant === 'boss') : null
    this.rig = built ?? new FallbackRig(this.speciesColor)
    this.builtWithFallback = !built

    // mini pet: normalize whatever scale the builder used (boss rigs come
    // pre-scaled) down to PET_SCALE total
    const orig = this.rig.group.scale.x || 1
    this.rig.group.scale.setScalar(PET_SCALE)
    const localHeadY = this.rig.height / orig // head height in the rig's local units

    applyVariantPalette(this.rig.group, this.petVariant)
    this.aura = buildAura(this.petVariant)
    if (this.aura) {
      // parented inside the scaled group: position in LOCAL units, and undo
      // the scale on the aura itself so the motes keep their world size
      this.aura.group.position.y = localHeadY + 0.35
      this.aura.group.scale.setScalar(1 / PET_SCALE)
      this.rig.group.add(this.aura.group)
    }

    // appear at the heel with a soft pop
    const p = this.deps.player
    this.x = p.pos.x
    this.z = p.pos.z
    this.placed = false
    this.deps.scene.add(this.rig.group)
  }

  private teardownRig(): void {
    if (this.aura) {
      disposeAura(this.aura.group)
      this.aura.group.removeFromParent()
      this.aura = null
    }
    if (this.rig) {
      this.rig.group.removeFromParent()
      this.rig.dispose?.()
      this.rig = null
    }
    this.builtWithFallback = false
  }

  // -------------------------------------------------------------------------

  private heelGoal(): { x: number; z: number } {
    const p = this.deps.player
    const a = p.facing + HEEL_ANGLE
    return { x: p.pos.x + Math.sin(a) * HEEL_DIST, z: p.pos.z + Math.cos(a) * HEEL_DIST }
  }

  /** Axis-separated slide so the pet politely goes around fences. */
  private stepTowards(tx: number, tz: number, speed: number, dt: number): boolean {
    const dx = tx - this.x
    const dz = tz - this.z
    const d = Math.hypot(dx, dz)
    if (d < 0.08) return false
    const step = Math.min(d, speed * dt)
    const nx = this.x + (dx / d) * step
    const nz = this.z + (dz / d) * step
    const { world } = this.deps
    if (!world.isBlocked(nx, this.z)) this.x = nx
    if (!world.isBlocked(this.x, nz)) this.z = nz
    this.facing = Math.atan2(dx, dz)
    return true
  }

  private update(dt: number, now: number): void {
    if (!this.rig || !this.petSpecies) return
    const { player, world } = this.deps

    // --- morale --------------------------------------------------------------
    if (this.state !== 'cower') {
      this.morale = Math.min(1, this.morale + MORALE_REGEN * dt)
      if (this.morale < COWER_ENTER) {
        this.state = 'cower'
        this.cowerUntil = now + COWER_SECS
        events.emit('chat:system', { text: cowerLine(Math.random) })
      }
    } else if (now >= this.cowerUntil) {
      this.state = 'heel'
      this.morale = COWER_EXIT_MORALE
      this.rig.group.rotation.z = 0
    }

    // --- pick a goal ---------------------------------------------------------
    const target = this.state === 'heel' ? this.deps.target() : null
    let moving = false
    let speed01 = 0

    const heel = this.heelGoal()
    const heelDist = Math.hypot(heel.x - this.x, heel.z - this.z)
    if (!this.placed || heelDist > TELEPORT_DIST) {
      // way behind (teleport / first frame): pop in at the heel, no drama
      this.x = heel.x
      this.z = heel.z
      this.y = world.groundHeight(this.x, this.z)
      this.placed = true
    }

    if (this.state === 'cower') {
      // scurry behind the player and tremble
      const away = player.facing + Math.PI
      const gx = player.pos.x + Math.sin(away) * 2.6
      const gz = player.pos.z + Math.cos(away) * 2.6
      moving = this.stepTowards(gx, gz, MOVE_SPEED * 1.15, dt)
      speed01 = moving ? 1 : 0
      if (!moving) {
        this.rig.group.rotation.z = Math.sin(now * 40) * 0.07 // the tremble
        this.facing = Math.atan2(player.pos.x - this.x, player.pos.z - this.z)
      }
    } else if (target && target.alive) {
      // join the fight: close to reach, then swing on cooldown
      const reach = target.radius + 0.75
      const d = Math.hypot(target.x - this.x, target.z - this.z)
      if (d > reach) {
        moving = this.stepTowards(target.x, target.z, MOVE_SPEED, dt)
        speed01 = 1
      } else {
        this.facing = Math.atan2(target.x - this.x, target.z - this.z)
        if (now >= this.nextSwingAt) {
          this.nextSwingAt = now + SWING_COOLDOWN
          this.rig.strikeLunge?.()
          const dps = this.deps.playerDps() || FALLBACK_PLAYER_DPS
          const dmg = Math.max(
            1,
            Math.round(dps * PET_DPS_FRACTION * SWING_COOLDOWN * (0.85 + Math.random() * 0.3))
          )
          target.hit(dmg)
        }
      }
    } else if (heelDist > 0.35) {
      // smooth heel-follow; trot harder the further behind it is
      const urgency = Math.min(1, heelDist / 4)
      moving = this.stepTowards(heel.x, heel.z, MOVE_SPEED * (0.55 + 0.45 * urgency), dt)
      speed01 = 0.5 + 0.5 * urgency
    } else {
      // at heel: face where the player faces, hang out, be adorable
      this.facing += (player.facing - this.facing) * Math.min(1, dt * 4)
    }

    // --- ground + transform --------------------------------------------------
    const gh = world.groundHeight(this.x, this.z)
    this.y += (gh - this.y) * Math.min(1, dt * 12)
    this.rig.group.position.set(this.x, this.y, this.z)
    this.rig.group.rotation.y = this.facing
    if (this.state !== 'cower') this.rig.group.rotation.z *= 1 - Math.min(1, dt * 8)
    this.rig.update(dt, moving, speed01)

    // --- aura animation ------------------------------------------------------
    if (this.aura) {
      this.auraT += dt
      const t = this.auraT
      const parts = this.aura.group.children
      switch (this.aura.kind) {
        case 'glint': {
          // orbiting sparkle glint with a twinkle pulse
          parts.forEach((p, i) => {
            const a = t * 2.2 + i * Math.PI
            p.position.set(Math.cos(a) * 0.28, Math.sin(t * 3.1 + i) * 0.08, Math.sin(a) * 0.28)
            p.scale.setScalar(0.7 + Math.abs(Math.sin(t * 5 + i * 1.7)) * 0.8)
          })
          break
        }
        case 'wisp': {
          // slow purple drift
          parts.forEach((p, i) => {
            const a = t * 1.1 + i * 2.4
            p.position.set(Math.cos(a) * 0.22, Math.sin(t * 1.7 + i) * 0.12, Math.sin(a) * 0.22)
          })
          break
        }
        case 'ember': {
          // motes rising on a loop, like a tiny campfire with opinions
          parts.forEach((p, i) => {
            const k = (t * 0.8 + i * 0.5) % 1
            p.position.set(Math.sin(t * 3 + i * 2) * 0.1, -0.15 + k * 0.45, Math.cos(t * 2.3 + i) * 0.1)
            p.scale.setScalar(1 - k * 0.7)
          })
          break
        }
        case 'none':
          break
      }
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.raf)
    this.offDamaged()
    this.offDied()
    this.teardownRig()
  }
}
