/**
 * Trial of the Deep — a single arena combatant.
 *
 * Wraps a mob RIG (built by the open-world combat MobRig, injected via a
 * setter — never imported here, only its structural shape) with arena-local
 * HP, attack and a simple always-aggressive chase/telegraph/strike AI. The
 * player's swing damage is resolved in index.ts (which owns the stat sources);
 * this file owns mob movement and the mob-hits-player path.
 */
import * as THREE from 'three'
import type { SpeciesDef } from '../ids'

/** The subset of combat's MobRig the arena needs (pets reuses it the same way). */
export interface MobRigLike {
  readonly group: THREE.Group
  readonly height: number
  readonly flying: boolean
  readonly alive: boolean
  setWindup(p: number): void
  strikeLunge(): void
  flashHurt(): void
  die(onDone?: () => void): void
  update(dt: number, moving: boolean, speed01: number): void
  dispose(): void
}

const SHAPE_SPEED: Record<SpeciesDef['shape'], number> = {
  blob: 1.7, quadruped: 2.7, biped: 2.1, crawler: 1.9, flyer: 2.4
}
const SHAPE_RADIUS: Record<SpeciesDef['shape'], number> = {
  blob: 0.45, quadruped: 0.5, biped: 0.4, crawler: 0.5, flyer: 0.4
}

/** Tiny billboarded HP bar. */
class HpBar {
  readonly sprite: THREE.Sprite
  private readonly canvas = document.createElement('canvas')
  private readonly tex: THREE.CanvasTexture
  private readonly boss: boolean
  constructor(boss: boolean) {
    this.boss = boss
    this.canvas.width = 64
    this.canvas.height = 8
    this.tex = new THREE.CanvasTexture(this.canvas)
    this.tex.colorSpace = THREE.SRGBColorSpace
    const mat = new THREE.SpriteMaterial({ map: this.tex, depthTest: false, transparent: true })
    this.sprite = new THREE.Sprite(mat)
    this.sprite.scale.set(boss ? 2.2 : 1.1, boss ? 0.34 : 0.17, 1)
    this.set(1)
  }
  set(frac: number): void {
    const g = this.canvas.getContext('2d')
    if (!g) return
    const f = Math.max(0, Math.min(1, frac))
    g.clearRect(0, 0, 64, 8)
    g.fillStyle = '#1a1016'
    g.fillRect(0, 0, 64, 8)
    g.fillStyle = this.boss ? '#ffcb57' : f > 0.5 ? '#7ed957' : f > 0.25 ? '#e8b24d' : '#d9594f'
    g.fillRect(1, 1, Math.round(62 * f), 6)
    this.tex.needsUpdate = true
  }
  dispose(): void {
    this.tex.dispose()
    ;(this.sprite.material as THREE.SpriteMaterial).dispose()
    this.sprite.removeFromParent()
  }
}

export interface MobInit {
  rig: MobRigLike
  species: SpeciesDef
  level: number
  boss: boolean
  maxHp: number
  atk: number
  x: number
  z: number
  /** Arena centre + half-extent, so the mob stays off the walls. */
  centerX: number
  centerZ: number
  half: number
  /** Named-boss id for music theming (boss waves), else null. */
  bossId: string | null
}

export class DungeonMob {
  readonly rig: MobRigLike
  readonly species: string
  readonly level: number
  readonly boss: boolean
  readonly bossId: string | null
  readonly atk: number
  readonly radius: number
  readonly bar: HpBar
  hp: number
  maxHp: number
  x: number
  z: number
  private y = 0
  private facing = 0
  private readonly speed: number
  private windupUntil = 0
  private cooldownUntil = 0
  private readonly windupDur: number
  private dying = false
  private readonly cx: number
  private readonly cz: number
  private readonly lim: number

  constructor(o: MobInit) {
    this.rig = o.rig
    this.species = o.species.id
    this.level = o.level
    this.boss = o.boss
    this.bossId = o.bossId
    this.atk = o.atk
    this.maxHp = o.maxHp
    this.hp = o.maxHp
    this.x = o.x
    this.z = o.z
    this.cx = o.centerX
    this.cz = o.centerZ
    this.lim = o.half - 0.9
    const sc = o.boss ? 2.2 : 1
    this.radius = SHAPE_RADIUS[o.species.shape] * sc
    this.speed = SHAPE_SPEED[o.species.shape] * (o.boss ? 0.85 : 1)
    this.windupDur = o.boss ? 0.6 : 0.4
    this.bar = new HpBar(o.boss)
  }

  get alive(): boolean {
    return !this.dying && this.hp > 0
  }

  addToScene(scene: THREE.Scene): void {
    this.rig.group.position.set(this.x, 0, this.z)
    scene.add(this.rig.group)
    scene.add(this.bar.sprite)
  }

  /** Apply player-dealt damage (index.ts computes the amount). Returns dealt. */
  takeHit(amount: number): void {
    if (!this.alive) return
    this.hp -= amount
    this.rig.flashHurt()
    this.bar.set(this.hp / this.maxHp)
  }

  /**
   * One AI step. `reach` is the player's hurt radius. `onStrike` is called when
   * a telegraphed swing lands within reach (index applies the damage).
   */
  update(
    dt: number,
    now: number,
    px: number,
    pz: number,
    playerAlive: boolean,
    onStrike: (mob: DungeonMob) => void
  ): void {
    if (!this.alive) return
    const dx = px - this.x
    const dz = pz - this.z
    const pDist = Math.hypot(dx, dz)
    const reach = this.radius + 1.0
    let moving = false
    let speed01 = 0

    this.facing = Math.atan2(dx, dz)

    if (!playerAlive) {
      // nothing to hit — mill about near where you stand
      this.rig.setWindup(-1)
      this.windupUntil = 0
    } else if (this.windupUntil > 0) {
      const p = 1 - Math.max(0, this.windupUntil - now) / this.windupDur
      this.rig.setWindup(Math.min(1, p))
      if (now >= this.windupUntil) {
        this.windupUntil = 0
        this.rig.strikeLunge()
        this.cooldownUntil = now + (this.boss ? 2.2 : 1.6)
        if (pDist < reach + 0.7) onStrike(this)
      }
    } else if (pDist > reach) {
      // close the distance
      const step = this.speed * dt
      this.x += (dx / pDist) * step
      this.z += (dz / pDist) * step
      moving = true
      speed01 = 1
    } else if (now >= this.cooldownUntil) {
      this.windupUntil = now + this.windupDur
    }

    // keep off the walls
    this.x = Math.max(this.cx - this.lim, Math.min(this.cx + this.lim, this.x))
    this.z = Math.max(this.cz - this.lim, Math.min(this.cz + this.lim, this.z))

    this.rig.group.position.set(this.x, this.y, this.z)
    this.rig.group.rotation.y = this.facing
    this.rig.update(dt, moving, speed01)

    const barY = this.y + this.rig.height + 0.25
    this.bar.sprite.position.set(this.x, barY, this.z)
    this.bar.sprite.visible = this.hp < this.maxHp
  }

  /** Topple + cleanup. `onGone` fires after the death animation. */
  kill(onGone: () => void): void {
    if (this.dying) return
    this.dying = true
    this.bar.sprite.visible = false
    this.rig.die(() => window.setTimeout(onGone, 300))
  }

  dispose(): void {
    this.rig.group.removeFromParent()
    this.rig.dispose()
    this.bar.dispose()
  }
}
