/**
 * Raid adds — the little minions a boss spits out mid-fight.
 *
 * Visuals come from the OPEN-WORLD combat MobRig, injected by the integrator
 * exactly as the pets + dungeon modules consume it (setMobRigSource). We only
 * describe the structural slice we use so this module imports nothing from
 * combat. Each add gets a dead-simple chase/melee brain; death routes back to
 * the raid core (xp + a 'mob:killed' so pets/achievements/quests react).
 */
import type * as THREE from 'three'

/** The slice of combat's MobRig we rely on (structural — no import). */
export interface MobRigLike {
  readonly group: THREE.Group
  readonly height: number
  readonly alive: boolean
  update(dt: number, moving: boolean, speed01: number): void
  flashHurt(): void
  die(onDone?: () => void): void
  dispose(): void
}

export type MobRigSource = (species: string, boss: boolean) => MobRigLike | null

export interface RaidAddOpts {
  rig: MobRigLike
  species: string
  level: number
  maxHp: number
  atk: number
  x: number
  z: number
  /** The add leashes to the boss altar so stragglers don't wander the zone. */
  homeX: number
  homeZ: number
  groundY: number
}

const SPEED = 2.6
const REACH = 1.1
const SWING_CD = 1.5
const WINDUP = 0.4

export class RaidAdd {
  readonly species: string
  readonly level: number
  private readonly rig: MobRigLike
  private readonly atk: number
  private readonly homeX: number
  private readonly homeZ: number
  private readonly groundY: number
  private hp: number
  x: number
  z: number
  private facing = 0
  private cooldownUntil = 0
  private windupUntil = 0

  constructor(o: RaidAddOpts) {
    this.rig = o.rig
    this.species = o.species
    this.level = o.level
    this.hp = o.maxHp
    this.atk = o.atk
    this.x = o.x
    this.z = o.z
    this.homeX = o.homeX
    this.homeZ = o.homeZ
    this.groundY = o.groundY
    this.rig.group.position.set(o.x, o.groundY, o.z)
  }

  addToScene(scene: THREE.Scene): void {
    scene.add(this.rig.group)
  }

  get alive(): boolean {
    return this.rig.alive && this.hp > 0
  }

  get radius(): number {
    return 0.5
  }

  /** Apply damage; returns true if this hit was the kill. */
  takeHit(amount: number): boolean {
    if (!this.alive) return false
    this.hp -= Math.max(1, Math.round(amount))
    this.rig.flashHurt()
    return this.hp <= 0
  }

  /**
   * Chase the player and melee. `hurt(amount, from)` applies damage to the
   * player when a swing lands. Returns nothing; death is driven by takeHit.
   */
  update(
    dt: number,
    now: number,
    px: number,
    pz: number,
    playerAlive: boolean,
    hurt: (amount: number, from: string) => void
  ): void {
    if (!this.rig.alive) {
      this.rig.update(dt, false, 0)
      return
    }
    const dx = px - this.x
    const dz = pz - this.z
    const dist = Math.hypot(dx, dz)
    const homeDist = Math.hypot(this.x - this.homeX, this.z - this.homeZ)
    let moving = false
    let speed01 = 0

    if (!playerAlive || homeDist > 40) {
      // drift home
      const hx = this.homeX - this.x
      const hz = this.homeZ - this.z
      const hd = Math.hypot(hx, hz)
      if (hd > 0.5) {
        this.x += (hx / hd) * SPEED * 0.8 * dt
        this.z += (hz / hd) * SPEED * 0.8 * dt
        this.facing = Math.atan2(hx, hz)
        moving = true
        speed01 = 0.8
      }
    } else if (this.windupUntil > 0) {
      if (now >= this.windupUntil) {
        this.windupUntil = 0
        this.cooldownUntil = now + SWING_CD
        if (dist < REACH + 0.6) hurt(this.atk, this.species)
      }
    } else if (dist > REACH) {
      this.x += (dx / dist) * SPEED * dt
      this.z += (dz / dist) * SPEED * dt
      this.facing = Math.atan2(dx, dz)
      moving = true
      speed01 = 1
    } else if (now >= this.cooldownUntil) {
      this.windupUntil = now + WINDUP
      this.facing = Math.atan2(dx, dz)
    }

    this.rig.group.position.set(this.x, this.groundY, this.z)
    this.rig.group.rotation.y = this.facing
    this.rig.update(dt, moving, speed01)
  }

  kill(onDone: () => void): void {
    this.rig.die(onDone)
  }

  dispose(): void {
    this.rig.group.removeFromParent()
    this.rig.dispose()
  }
}
