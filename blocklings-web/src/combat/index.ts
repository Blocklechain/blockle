/**
 * Combat core — the monster kingdom.
 *
 * Spawns boxy voxel mobs around the player (region level bands from
 * src/ids.ts, ~1 mob per 18x18 near the player, cap ~40, never in the
 * village plaza or the Royal Capital), runs their wander/aggro/chase/melee
 * AI with leashing + ~25s respawns, resolves the player's sword swings
 * (range 2.2, 90° front arc), rains pixelated blood, floats damage
 * numbers, drops spinning loot meshes, and handles player death/respawn.
 *
 * Contract compliance: talks to the rest of the game ONLY via the event
 * bus + GameAPI + integrator-wired setters. Loot enters the inventory
 * exclusively by emitting 'item:gained' when the player walks over a drop.
 */
import * as THREE from 'three'
import type { GameAPI } from '../types'
import { events } from '../events'
import { BOSSES, SPECIES, WAYSTONES, regionAt, type SpeciesDef } from '../ids'
import { MobRig } from './mobs'
import { BloodSystem } from './blood'
import { DamageNumbers, HealthBar, makeBossLabel } from './fx'
import { rollLoot } from './loot'
import { bossAggroLine, bossKillLine, deathLine, killQuip } from './flavor'

// ---------------------------------------------------------------------------
// Public module interface (wired by the integrator in main.ts)
// ---------------------------------------------------------------------------

export interface EquippedStats {
  atk: number
  def: number
  str: number
  int: number
  agi: number
}

export interface CombatModule {
  /** Resolve one player swing — integrator wires: onAttack(() => combat.playerStrike()). */
  playerStrike(): void
  /** Equipped-gear stats (integrator passes inventory.equippedStats). */
  setStatsSource(fn: () => EquippedStats): void
  /** Skill levels (integrator passes skills.level). */
  setSkillsSource(fn: (skill: string) => number): void
  /** Item voxel meshes for loot drops (integrator passes items.buildMesh). */
  setMeshSource(fn: (id: string) => THREE.Group): void
  /**
   * How mobs hurt the player: fn applies `amount` to the player (mutate
   * hp + hurt flash/knockback). Combat emits 'player:damaged' and runs
   * the death flow itself. Without a fn, combat mutates api.player.hp.
   */
  setPlayerDamage(fn: (amount: number, from: string) => void): void
  /**
   * The player-module topple: fn plays the death animation and calls
   * `onDown` when the body hits the dirt (combat then teleports to the
   * respawn point, restores hp and revives). Integrator wires:
   *   combat.setPlayerDeath((onDown) => playerDie(onDown))
   */
  setPlayerDeath(fn: (onDown: (revive: () => void) => void) => void): void
  /** Override the respawn point (village by default, last waystone after). */
  setRespawnPoint(x: number, z: number, label?: string): void
  /** Live tallies (debug/balance peek). */
  counts(): { mobs: number; bosses: number; drops: number }
  dispose(): void
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const MOB_CAP = 40
const SPAWN_RING_MIN = 16
const SPAWN_RING_MAX = 44
const DESPAWN_DIST = 75
const RESPAWN_SECS = 25
const BOSS_RESPAWN_SECS = 75
const LEASH_DIST = 18
const AGGRO_RANGE = 8
const BOSS_AGGRO_RANGE = 12
const PLAYER_RANGE = 2.2
const PLAYER_ARC = Math.PI / 4 // ±45° = 90° front arc
const DROP_TTL = 20
const PICKUP_RANGE = 1.0
const PLAZA_KEEPOUT = 24 // radius around the village well — no spawns
const COLLIDE_RADIUS = 0.35

const SHAPE_SPEED: Record<SpeciesDef['shape'], number> = {
  blob: 1.7,
  quadruped: 3.0,
  biped: 2.3,
  crawler: 2.6,
  flyer: 2.9,
}
const SHAPE_RADIUS: Record<SpeciesDef['shape'], number> = {
  blob: 0.45,
  quadruped: 0.5,
  biped: 0.4,
  crawler: 0.5,
  flyer: 0.4,
}

/** Region id -> weighted species mix (tier-appropriate per the level bands). */
const REGION_MIX: Record<string, readonly (readonly [string, number])[]> = {
  beginnings: [['slime', 5], ['mushroom', 4], ['crab', 3]],
  greenwood: [['wolf', 4], ['goblin', 4], ['spider', 3], ['slime', 2], ['mushroom', 2]],
  ironhold: [['bat', 4], ['goblin', 3], ['wolf', 3], ['bandit', 3], ['golem', 1]],
  ashen: [['skeleton', 4], ['imp', 4], ['bat', 3], ['spider', 2], ['wisp', 1]],
  forgotten: [['orc', 4], ['golem', 3], ['wisp', 3], ['bandit', 2], ['skeleton', 2]],
}

/** Boss dens — fixed lairs inside each combat region, away from waystones. */
const BOSS_DENS: Record<string, { x: number; z: number }> = {
  boss_greenwood: { x: 200, z: 70 },
  boss_ironhold: { x: -200, z: 70 },
  boss_ashen: { x: -170, z: 200 },
  boss_forgotten: { x: 170, z: 205 },
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface Mob {
  rig: MobRig
  sp: SpeciesDef
  level: number
  boss: boolean
  bossId: string | null
  name: string
  hp: number
  maxHp: number
  atk: number
  x: number
  z: number
  y: number
  facing: number
  homeX: number
  homeZ: number
  state: 'wander' | 'chase' | 'return'
  targetX: number
  targetZ: number
  nextWanderAt: number
  cooldownUntil: number
  /** >0 while winding up: the wall-clock second the strike lands. */
  windupUntil: number
  windupDur: number
  bar: HealthBar
  label: THREE.Sprite | null
  radius: number
  speed: number
  aggro: number
  announced: boolean
}

interface Drop {
  id: string
  qty: number
  group: THREE.Group
  x: number
  z: number
  groundY: number
  spin: number
  expireAt: number
  fallback: boolean
}

const speciesById = new Map(SPECIES.map((s) => [s.id, s] as const))

export function initCombat(api: GameAPI): CombatModule {
  const { scene, world, player } = api
  const rng = Math.random

  const blood = new BloodSystem(scene)
  const numbers = new DamageNumbers(scene)

  const mobs: Mob[] = []
  const drops: Drop[] = []
  /** Death-delayed spawn credits: wall-clock seconds when a slot reopens. */
  const respawnQueue: number[] = []
  let spawnBudget = MOB_CAP
  const bossRespawnAt = new Map<string, number>() // bossId -> earliest respawn

  // --- integrator-wired sources ---------------------------------------------
  let statsSource: (() => EquippedStats) | null = null
  let skillsSource: ((skill: string) => number) | null = null
  let meshSource: ((id: string) => THREE.Group) | null = null
  let playerDamageFn: ((amount: number, from: string) => void) | null = null
  let playerDeathFn: ((onDown: (revive: () => void) => void) => void) | null = null

  // --- respawn point: village by default, last-touched waystone after -------
  let respawn = { x: world.spawn.x, z: world.spawn.z, label: 'the village' }
  const stoneById = new Map(WAYSTONES.map((w) => [w.id, w] as const))
  const setStoneRespawn = (stoneId: string): void => {
    const s = stoneById.get(stoneId)
    if (s) respawn = { x: s.x + 1.5, z: s.z + 1.5, label: s.name }
  }
  const offAttuned = events.on('waystone:attuned', ({ stoneId }) => setStoneRespawn(stoneId))
  const offTraveled = events.on('waystone:traveled', ({ to }) => setStoneRespawn(to))

  let playerDead = false
  let lastQuipAt = 0

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  const spotBlocked = (x: number, z: number): boolean => {
    const r = regionAt(x, z)
    if (!r || r.id === 'capital') return true // the capital guards work hard
    if (Math.hypot(x, z) < PLAZA_KEEPOUT) return true // village plaza is sacred
    for (const w of WAYSTONES) {
      if (Math.hypot(x - w.x, z - w.z) < 8) return true
    }
    return world.isBlocked(x, z)
  }

  const pickSpecies = (regionId: string): SpeciesDef | null => {
    const mix = REGION_MIX[regionId]
    if (!mix) return null
    let total = 0
    for (const [, w] of mix) total += w
    let roll = rng() * total
    for (const [id, w] of mix) {
      roll -= w
      if (roll <= 0) return speciesById.get(id) ?? null
    }
    return null
  }

  const makeMob = (sp: SpeciesDef, level: number, x: number, z: number, bossId: string | null): Mob => {
    const boss = bossId !== null
    const rig = new MobRig(sp, boss)
    const y = world.groundHeight(x, z)
    rig.group.position.set(x, y, z)
    scene.add(rig.group)

    const scale = boss ? 2.2 : 1
    const bar = new HealthBar(scale)
    bar.sprite.position.set(x, y + rig.height + 0.25, z)
    scene.add(bar.sprite)

    const bossDef = boss ? BOSSES.find((b) => b.id === bossId) : undefined
    const name = bossDef?.name ?? sp.name
    let label: THREE.Sprite | null = null
    if (boss) {
      label = makeBossLabel(`${name}  Lv.${level}`)
      label.position.set(x, y + rig.height + 0.72, z)
      scene.add(label)
    }

    return {
      rig,
      sp,
      level,
      boss,
      bossId,
      name,
      maxHp: Math.round((12 + level * 6) * (boss ? 5 : 1)),
      hp: Math.round((12 + level * 6) * (boss ? 5 : 1)),
      atk: (2 + level * 1.1) * (boss ? 1.5 : 1),
      x,
      z,
      y,
      facing: rng() * Math.PI * 2,
      homeX: x,
      homeZ: z,
      state: 'wander',
      targetX: x,
      targetZ: z,
      nextWanderAt: 0,
      cooldownUntil: 0,
      windupUntil: 0,
      windupDur: boss ? 0.6 : 0.4,
      bar,
      label,
      radius: SHAPE_RADIUS[sp.shape] * scale,
      speed: SHAPE_SPEED[sp.shape] * (boss ? 0.85 : 1),
      aggro: boss ? BOSS_AGGRO_RANGE : AGGRO_RANGE,
      announced: false,
    }
  }

  const trySpawnOne = (): boolean => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const a = rng() * Math.PI * 2
      const r = SPAWN_RING_MIN + rng() * (SPAWN_RING_MAX - SPAWN_RING_MIN)
      const x = player.pos.x + Math.cos(a) * r
      const z = player.pos.z + Math.sin(a) * r
      if (spotBlocked(x, z)) continue
      const region = regionAt(x, z)
      if (!region) continue
      const sp = pickSpecies(region.id)
      if (!sp) continue
      const level =
        region.minLevel + Math.floor(rng() * (Math.min(region.maxLevel, 45) - region.minLevel + 1))
      mobs.push(makeMob(sp, level, x, z, null))
      return true
    }
    return false
  }

  const maybeSpawnBosses = (now: number): void => {
    for (const b of BOSSES) {
      const den = BOSS_DENS[b.id]
      if (!den) continue
      if (mobs.some((m) => m.bossId === b.id)) continue
      if (now < (bossRespawnAt.get(b.id) ?? 0)) continue
      // only spin the boss up when the player is in the neighborhood
      const d = Math.hypot(player.pos.x - den.x, player.pos.z - den.z)
      if (d > 110 || d < 6) continue
      const sp = speciesById.get(b.species)
      if (!sp) continue
      // nudge off blocked ground
      let bx = den.x
      let bz = den.z
      for (let i = 0; i < 12 && world.isBlocked(bx, bz); i++) {
        bx = den.x + (rng() - 0.5) * 10
        bz = den.z + (rng() - 0.5) * 10
      }
      mobs.push(makeMob(sp, b.level, bx, bz, b.id))
    }
  }

  const removeMob = (m: Mob): void => {
    m.rig.group.removeFromParent()
    m.rig.dispose()
    m.bar.dispose()
    if (m.label) {
      m.label.removeFromParent()
      ;(m.label.material as THREE.SpriteMaterial).map?.dispose()
      ;(m.label.material as THREE.SpriteMaterial).dispose()
    }
    const i = mobs.indexOf(m)
    if (i >= 0) mobs.splice(i, 1)
  }

  // -------------------------------------------------------------------------
  // Loot drops — spinning voxel mesh at the corpse; walk over to collect
  // -------------------------------------------------------------------------

  const spawnDrop = (id: string, qty: number, x: number, z: number): void => {
    // scatter a touch so boss piles don't z-fight
    const dx = x + (rng() - 0.5) * 1.2
    const dz = z + (rng() - 0.5) * 1.2
    const gy = world.groundHeight(dx, dz)
    let group: THREE.Group
    let fallback = false
    if (meshSource) {
      group = meshSource(id)
    } else {
      // pre-wiring fallback: a mystery crate
      group = new THREE.Group()
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.4, 0.4, 0.4),
        new THREE.MeshLambertMaterial({ color: 0xc9a24b })
      )
      mesh.castShadow = true
      group.add(mesh)
      fallback = true
    }
    group.scale.setScalar(0.8)
    group.position.set(dx, gy + 0.35, dz)
    scene.add(group)
    drops.push({
      id,
      qty,
      group,
      x: dx,
      z: dz,
      groundY: gy,
      spin: rng() * Math.PI * 2,
      expireAt: performance.now() / 1000 + DROP_TTL,
      fallback,
    })
  }

  const removeDrop = (d: Drop): void => {
    d.group.removeFromParent()
    if (d.fallback) {
      // only dispose what WE built — item-module meshes share cached geometry
      d.group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose()
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
          for (const mat of mats) mat.dispose()
        }
      })
    }
    const i = drops.indexOf(d)
    if (i >= 0) drops.splice(i, 1)
  }

  // -------------------------------------------------------------------------
  // Player strike resolution (range 2.2, 90° front arc)
  // -------------------------------------------------------------------------

  const playerStrike = (): void => {
    if (playerDead) return
    const fx = Math.sin(player.facing)
    const fz = Math.cos(player.facing)
    const stats = statsSource?.() ?? { atk: 0, def: 0, str: 0, int: 0, agi: 0 }
    const atkLevel = skillsSource?.('attack') ?? 1

    for (const m of [...mobs]) {
      if (!m.rig.alive) continue
      const dx = m.x - player.pos.x
      const dz = m.z - player.pos.z
      const dist = Math.hypot(dx, dz)
      if (dist > PLAYER_RANGE + m.radius) continue
      const ang = Math.atan2(dx, dz)
      let diff = ang - Math.atan2(fx, fz)
      while (diff > Math.PI) diff -= Math.PI * 2
      while (diff < -Math.PI) diff += Math.PI * 2
      if (Math.abs(diff) > PLAYER_ARC && dist > m.radius + 0.5) continue

      // damage: gear + strength, scaled by the attack level
      const base = 3 + stats.atk + 0.4 * stats.str
      const crit = rng() < 0.1 + stats.agi * 0.002
      let dmg = base * (1 + (atkLevel - 1) * 0.04) * (0.85 + rng() * 0.3)
      if (crit) dmg *= 1.75
      const dealt = Math.max(1, Math.round(dmg))

      m.hp -= dealt
      m.rig.flashHurt()
      m.bar.set(m.hp / m.maxHp)

      const hitPos = new THREE.Vector3(m.x, m.y + m.rig.height * 0.5, m.z)
      events.emit('mob:hit', { species: m.sp.id, amount: dealt, crit, pos: hitPos })
      numbers.show(hitPos, String(dealt), { crit })
      blood.burst(hitPos, m.y, crit ? 1.6 : 1)
      if (crit || rng() < 0.25) blood.splat(m.x, m.y, m.z, crit)

      // getting smacked is an excellent argument for violence
      if (m.state === 'wander') {
        m.state = 'chase'
        m.windupUntil = 0
      }

      if (m.hp <= 0) killMob(m)
    }
  }

  const killMob = (m: Mob): void => {
    const now = performance.now() / 1000
    const pos = new THREE.Vector3(m.x, m.y, m.z)

    // cartoon-over-the-top: the fountain
    blood.burst(new THREE.Vector3(m.x, m.y + 0.3, m.z), m.y, m.boss ? 4 : 3)
    blood.splat(m.x, m.y, m.z, true)
    if (m.boss) {
      blood.splat(m.x + 0.8, m.y, m.z, true)
      blood.splat(m.x - 0.6, m.y, m.z + 0.5, true)
    }

    events.emit('mob:killed', {
      species: m.sp.id,
      level: m.level,
      pos,
      ...(m.boss ? { boss: true } : {}),
    })

    // XP: attack + vitality (fighting makes you hit harder AND thicker)
    const mult = m.boss ? 5 : 1
    const attackXp = Math.round((10 + m.level * 5) * mult)
    events.emit('xp:gained', { skill: 'attack', amount: attackXp })
    events.emit('xp:gained', { skill: 'vitality', amount: Math.ceil(attackXp * 0.4) })

    // loot -> spinning drop entities (item:gained fires on walk-over)
    for (const roll of rollLoot(m.sp.id, m.sp.tier, m.boss, rng)) {
      spawnDrop(roll.id, roll.qty, m.x, m.z)
    }

    if (m.boss && m.bossId) {
      bossRespawnAt.set(m.bossId, now + BOSS_RESPAWN_SECS)
      events.emit('chat:system', { text: bossKillLine(m.bossId, m.name) })
    } else {
      respawnQueue.push(now + RESPAWN_SECS)
      if (now - lastQuipAt > 9) {
        const quip = killQuip(m.sp.id, rng)
        if (quip) {
          lastQuipAt = now
          events.emit('chat:system', { text: quip })
        }
      }
    }

    // corpse squash-topple, then clean up
    m.bar.sprite.visible = false
    if (m.label) m.label.visible = false
    const dead = m
    m.rig.die(() => {
      window.setTimeout(() => removeMob(dead), 350)
    })
  }

  // -------------------------------------------------------------------------
  // Mobs hitting the player + the death flow
  // -------------------------------------------------------------------------

  const defenseReduction = (stats: EquippedStats): number => {
    const defLevel = skillsSource?.('defense') ?? 1
    return Math.min(0.65, stats.def * 0.012 + (defLevel - 1) * 0.004)
  }

  const hurtPlayer = (m: Mob): void => {
    const stats = statsSource?.() ?? { atk: 0, def: 0, str: 0, int: 0, agi: 0 }
    const raw = m.atk * (0.85 + rng() * 0.3)
    const dealt = Math.max(1, Math.round(raw * (1 - defenseReduction(stats))))
    if (playerDamageFn) playerDamageFn(dealt, m.name)
    else player.hp = Math.max(0, player.hp - dealt)
    events.emit('player:damaged', { amount: dealt, from: m.name })
    numbers.show(
      new THREE.Vector3(player.pos.x, player.pos.y + 0.6, player.pos.z),
      String(dealt),
      { color: '#ff8886' }
    )
    blood.burst(
      new THREE.Vector3(player.pos.x, player.pos.y + 0.6, player.pos.z),
      player.pos.y,
      0.8
    )
    if (player.hp <= 0 && !playerDead) beginPlayerDeath()
  }

  const beginPlayerDeath = (): void => {
    playerDead = true
    const at = player.pos.clone()
    blood.burst(at.clone().setY(at.y + 0.5), at.y, 3)
    blood.splat(at.x, at.y, at.z, true)
    events.emit('player:died', { at })
    events.emit('chat:system', { text: deathLine(rng) })

    // everyone loses interest in a corpse
    for (const m of mobs) {
      if (m.state === 'chase') {
        m.state = 'return'
        m.windupUntil = 0
        m.rig.setWindup(-1)
      }
    }

    const finish = (revive?: () => void): void => {
      player.pos.set(respawn.x, world.groundHeight(respawn.x, respawn.z), respawn.z)
      player.hp = player.maxHp
      playerDead = false
      events.emit('chat:system', {
        text: `You wake up at ${respawn.label}. The dirt tasted like failure.`,
      })
      revive?.()
    }

    if (playerDeathFn) {
      playerDeathFn((revive) => {
        window.setTimeout(() => finish(revive), 900)
      })
    } else {
      window.setTimeout(() => finish(), 1500)
    }
  }

  // -------------------------------------------------------------------------
  // Mob movement (axis-separated slide vs world.isBlocked, capital off-limits)
  // -------------------------------------------------------------------------

  const mobBlocked = (x: number, z: number): boolean => {
    if (world.isBlocked(x, z)) return true
    const r = regionAt(x, z)
    return !r || r.id === 'capital'
  }

  const stepMob = (m: Mob, tx: number, tz: number, speed: number, dt: number): void => {
    const dx = tx - m.x
    const dz = tz - m.z
    const d = Math.hypot(dx, dz)
    if (d < 0.05) return
    const vx = (dx / d) * speed
    const vz = (dz / d) * speed
    const nx = m.x + vx * dt
    const nz = m.z + vz * dt
    const rr = COLLIDE_RADIUS
    if (!mobBlocked(nx + Math.sign(vx) * rr, m.z)) m.x = nx
    if (!mobBlocked(m.x, nz + Math.sign(vz) * rr)) m.z = nz
    m.facing = Math.atan2(vx, vz)
  }

  // -------------------------------------------------------------------------
  // Per-frame tick (self-driven, like the gather module)
  // -------------------------------------------------------------------------

  let spawnTickT = 0
  let despawnSweepT = 0

  const updateMob = (m: Mob, dt: number, now: number): void => {
    if (!m.rig.alive) {
      m.rig.update(dt, false, 0)
      return
    }

    const pdx = player.pos.x - m.x
    const pdz = player.pos.z - m.z
    const pDist = Math.hypot(pdx, pdz)
    const homeDist = Math.hypot(m.x - m.homeX, m.z - m.homeZ)
    const reach = m.radius + 0.95

    let moving = false
    let speed01 = 0

    switch (m.state) {
      case 'wander': {
        if (!playerDead && pDist < m.aggro) {
          m.state = 'chase'
          if (m.boss && !m.announced && m.bossId) {
            m.announced = true
            events.emit('chat:system', { text: bossAggroLine(m.bossId, m.name) })
          }
          break
        }
        if (now >= m.nextWanderAt) {
          m.nextWanderAt = now + 2 + rng() * 4
          m.targetX = m.homeX + (rng() - 0.5) * 12
          m.targetZ = m.homeZ + (rng() - 0.5) * 12
        }
        const d = Math.hypot(m.targetX - m.x, m.targetZ - m.z)
        if (d > 0.4) {
          stepMob(m, m.targetX, m.targetZ, m.speed * 0.45, dt)
          moving = true
          speed01 = 0.45
        } else {
          // idle: face somewhere interesting occasionally
          m.facing += Math.sin(now * 0.3 + m.homeX) * dt * 0.2
        }
        break
      }

      case 'chase': {
        if (playerDead || homeDist > LEASH_DIST || pDist > m.aggro * 2.2) {
          m.state = 'return'
          m.windupUntil = 0
          m.rig.setWindup(-1)
          break
        }
        // face the player always
        m.facing = Math.atan2(pdx, pdz)

        if (m.windupUntil > 0) {
          // winding up the swipe — telegraph, then land it
          const p = 1 - Math.max(0, m.windupUntil - now) / m.windupDur
          m.rig.setWindup(Math.min(1, p))
          if (now >= m.windupUntil) {
            m.windupUntil = 0
            m.rig.strikeLunge()
            m.cooldownUntil = now + (m.boss ? 2.2 : 1.6)
            if (pDist < reach + 0.7 && !playerDead) hurtPlayer(m)
          }
        } else if (pDist > reach) {
          stepMob(m, player.pos.x, player.pos.z, m.speed, dt)
          moving = true
          speed01 = 1
        } else if (now >= m.cooldownUntil) {
          m.windupUntil = now + m.windupDur
        }
        break
      }

      case 'return': {
        if (homeDist < 1.2) {
          m.state = 'wander'
          m.hp = m.maxHp // leashing heals — no cheesing the poor critters
          m.bar.set(1)
          break
        }
        stepMob(m, m.homeX, m.homeZ, m.speed * 0.8, dt)
        moving = true
        speed01 = 0.8
        break
      }
    }

    // ground tracking + rig transform
    const gh = world.groundHeight(m.x, m.z)
    m.y += (gh - m.y) * Math.min(1, dt * 12)
    m.rig.group.position.set(m.x, m.y, m.z)
    m.rig.group.rotation.y = m.facing
    m.rig.update(dt, moving, speed01)

    // HP bar + boss label follow the head
    const barY = m.y + m.rig.height + 0.25
    m.bar.sprite.position.set(m.x, barY, m.z)
    m.bar.sprite.visible = m.hp < m.maxHp || m.state === 'chase'
    if (m.label) m.label.position.set(m.x, barY + 0.45, m.z)
  }

  let raf = 0
  let lastMs = performance.now()

  const tick = (nowMs: number): void => {
    raf = requestAnimationFrame(tick)
    const dt = Math.min((nowMs - lastMs) / 1000, 0.1)
    lastMs = nowMs
    const now = nowMs / 1000

    // --- spawner -----------------------------------------------------------
    spawnTickT += dt
    if (spawnTickT >= 0.9) {
      spawnTickT = 0
      while (respawnQueue.length > 0 && (respawnQueue[0] ?? Infinity) <= now) {
        respawnQueue.shift()
        spawnBudget++
      }
      const live = mobs.filter((m) => !m.boss).length
      if (live < MOB_CAP && spawnBudget > 0 && trySpawnOne()) spawnBudget--
      maybeSpawnBosses(now)
    }

    // --- despawn sweep (keep the kingdom near the player) --------------------
    despawnSweepT += dt
    if (despawnSweepT >= 2) {
      despawnSweepT = 0
      for (const m of [...mobs]) {
        if (m.boss || !m.rig.alive) continue
        const d = Math.hypot(m.homeX - player.pos.x, m.homeZ - player.pos.z)
        if (d > DESPAWN_DIST) {
          removeMob(m)
          spawnBudget++
        }
      }
    }

    // --- mobs ----------------------------------------------------------------
    for (const m of [...mobs]) updateMob(m, dt, now)

    // --- drops: spin, bob, expire, walk-over pickup --------------------------
    for (const d of [...drops]) {
      if (now >= d.expireAt) {
        removeDrop(d)
        continue
      }
      d.spin += dt * 2.6
      d.group.rotation.y = d.spin
      d.group.position.y = d.groundY + 0.35 + Math.sin(d.spin * 1.3) * 0.08
      if (!playerDead) {
        const dist = Math.hypot(d.x - player.pos.x, d.z - player.pos.z)
        if (dist < PICKUP_RANGE) {
          // THE pickup moment — the only place loot becomes inventory
          events.emit('item:gained', { id: d.id, qty: d.qty, source: 'loot' })
          blood.burst(
            new THREE.Vector3(d.x, d.groundY + 0.4, d.z),
            d.groundY,
            0.7,
            0xf2c43d // gold sparkle, not gore, we're not animals
          )
          removeDrop(d)
        }
      }
    }

    blood.update(dt)
    numbers.update(dt)
  }
  raf = requestAnimationFrame(tick)

  // -------------------------------------------------------------------------
  // Module handle
  // -------------------------------------------------------------------------

  return {
    playerStrike,
    setStatsSource(fn) {
      statsSource = fn
    },
    setSkillsSource(fn) {
      skillsSource = fn
    },
    setMeshSource(fn) {
      meshSource = fn
    },
    setPlayerDamage(fn) {
      playerDamageFn = fn
    },
    setPlayerDeath(fn) {
      playerDeathFn = fn
    },
    setRespawnPoint(x, z, label) {
      respawn = { x, z, label: label ?? 'somewhere you apparently chose' }
    },
    counts() {
      return {
        mobs: mobs.filter((m) => !m.boss).length,
        bosses: mobs.filter((m) => m.boss).length,
        drops: drops.length,
      }
    },
    dispose() {
      cancelAnimationFrame(raf)
      offAttuned()
      offTraveled()
      for (const m of [...mobs]) removeMob(m)
      for (const d of [...drops]) removeDrop(d)
      blood.dispose()
      numbers.dispose()
    },
  }
}
