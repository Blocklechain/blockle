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
import type { GameAPI, ItemDef, ItemSpecial } from '../types'
import { events } from '../events'
import { BOSSES, SPECIES, WAYSTONES, type SpeciesDef } from '../ids'
import {
  animOf, createSpecialButton, fallbackSpecial, tierFxColor, tierOfId,
  type SpecialButton,
} from './specials'
import { SpecialFx, makeArrow, makeOrb, disposeProjectile } from './specialfx'
// PURE heart-region + streamed-zone lookup (NO stream-focus side channel —
// spawn probes must never yank zone streaming away from the player).
import { regionOrZoneAt as regionAt } from '../world/index'
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
  /**
   * Swing trigger for auto-retaliate — integrator wires the player module's
   * animation entry point: combat.setAttackTrigger(() => triggerAttack()).
   * That plays the arm swing, which fires onAttack -> playerStrike at the
   * strike frame (the existing resolution path). Until wired, auto-retaliate
   * falls back to calling playerStrike() directly (damage, no animation).
   */
  setAttackTrigger(fn: () => void): void
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

  /* -- wave-2: tap-to-attack + weapon specials + skill-tree modifiers ------ */

  /**
   * Fire the equipped weapon's special ability (combat also binds Q /
   * right-click / the mobile SPC button itself — this is for extra UI).
   */
  useSpecial(): void
  /**
   * Current special for HUD use: null when no special weapon is equipped.
   * cdLeft/cdTotal in seconds (cdLeft 0 = ready).
   */
  specialStatus(): { id: string; name: string; cdLeft: number; cdTotal: number } | null
  /**
   * Tap-to-attack walking — integrator wires the player module's walker:
   *   combat.setAutoWalk((t) => setAutoWalk(t))
   * Without it, combat glides the hero itself (moves, but no walk cycle).
   */
  setAutoWalk(fn: (target: { x: number; z: number; arrive: number } | null) => void): void
  /**
   * Special-move animations — integrator wires the player module:
   *   combat.setSpecialAnimTrigger((kind, onStrike) => triggerSpecial(kind, onStrike))
   * fn returns false when the rig is busy (the ability is then not spent).
   * Without it, abilities still fire (no bespoke animation).
   */
  setSpecialAnimTrigger(fn: (kind: string, onStrike: () => void) => boolean): void
  /** Item catalog lookup (integrator passes items.def) for ItemSpecial data. */
  setDefSource(fn: (id: string) => ItemDef | undefined): void
  /** Equipped-ids snapshot (integrator passes inventory.equipment). */
  setEquipmentSource(fn: () => Readonly<Record<string, string | null>>): void
  /**
   * Skill-tree modifier lookup (integrator passes skillTree.modifier).
   * Keys combat respects: 'combat.damage', 'combat.crit', 'combat.defense',
   * 'combat.special_damage', 'combat.special_cooldown' (all additive
   * fractions; cooldown reduction capped at 50%).
   */
  setModifierSource(fn: (key: string) => number): void
  /**
   * The player's current fight (tap target, else the auto-retaliate grudge)
   * exposed for the pet companion — integrator wires:
   *   pets.setTargetSource(() => combat.petTarget())
   * hit() applies the pet's damage through combat's own pipeline
   * (damage numbers, 'mob:hit', death flow). null = not fighting.
   */
  petTarget(): {
    x: number
    z: number
    radius: number
    alive: boolean
    hit(amount: number): void
  } | null
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
const RETALIATE_COOLDOWN = 0.8 // seconds between automatic counter-swings
const RETALIATE_BREAK_DIST = 2.5 // walked this far past reach = you left the fight
const TAP_CHASE_RANGE = 6 // tap-to-attack walks into range from this close
const TAP_ATTACK_COOLDOWN = 0.8 // seconds between automatic tap-target swings
const TAP_MAX_MS = 350 // press longer than this = not a tap
const TAP_MAX_PX = 16 // moved farther than this = a drag, not a tap

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

/**
 * Biome -> weighted species mix, the fallback for the 90 streamed wilderness
 * zones (REGION_MIX wins for the 5 heart combat regions). The zone's level
 * band carries the difficulty; the mix just carries the vibe.
 */
const BIOME_MIX: Record<string, readonly (readonly [string, number])[]> = {
  meadow: [['slime', 5], ['mushroom', 3], ['crab', 2], ['wolf', 2]],
  forest: [['wolf', 4], ['goblin', 4], ['spider', 3], ['mushroom', 2]],
  mountain: [['golem', 4], ['bat', 4], ['wolf', 3], ['bandit', 2]],
  dungeon: [['skeleton', 4], ['bat', 4], ['imp', 3], ['spider', 2]],
  city: [['bandit', 5], ['goblin', 3], ['skeleton', 2]],
  wastes: [['orc', 4], ['bandit', 3], ['skeleton', 3], ['golem', 2]],
  swamp: [['slime', 5], ['spider', 4], ['mushroom', 3], ['wisp', 2]],
  desert: [['crab', 4], ['bandit', 4], ['skeleton', 3], ['orc', 2]],
  tundra: [['wolf', 5], ['bat', 3], ['golem', 2], ['wisp', 2]],
  volcanic: [['imp', 5], ['golem', 4], ['skeleton', 2], ['bat', 2]],
  crystal: [['wisp', 5], ['golem', 3], ['bat', 3], ['slime', 2]],
  ruins: [['skeleton', 4], ['bandit', 4], ['wisp', 3], ['spider', 2]],
  beach: [['crab', 6], ['slime', 3], ['bandit', 2]],
  mushroom: [['mushroom', 6], ['slime', 3], ['spider', 2]],
  cherry: [['slime', 4], ['wolf', 3], ['goblin', 3], ['wisp', 1]],
  savanna: [['wolf', 4], ['crab', 3], ['orc', 3], ['bandit', 2]],
  canyon: [['bat', 4], ['bandit', 4], ['golem', 3], ['orc', 2]],
  lagoon: [['crab', 5], ['slime', 4], ['wisp', 2]],
  graveyard: [['skeleton', 5], ['wisp', 4], ['bat', 3]],
  glacier: [['wolf', 4], ['golem', 3], ['wisp', 3], ['bat', 2]],
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
  /** Wall-clock second a shield-bash stun wears off (0 = not stunned). */
  stunUntil: number
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

// ---------------------------------------------------------------------------
// Auto-retaliate setting (default ON) — integrator may surface in settings
// ---------------------------------------------------------------------------

let autoRetaliateOn = true

/** Turn auto-retaliate on/off (hitting back when hit). Default ON. */
export function setAutoRetaliate(on: boolean): void {
  autoRetaliateOn = on
}

/** Whether the hero currently believes in consequences. */
export function getAutoRetaliate(): boolean {
  return autoRetaliateOn
}

export function initCombat(api: GameAPI): CombatModule {
  const { scene, camera, world, player } = api
  const rng = Math.random

  const blood = new BloodSystem(scene)
  const numbers = new DamageNumbers(scene)
  const fxPool = new SpecialFx(scene)

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
  let attackTriggerFn: (() => void) | null = null
  let autoWalkFn: ((target: { x: number; z: number; arrive: number } | null) => void) | null = null
  let specialAnimFn: ((kind: string, onStrike: () => void) => boolean) | null = null
  let defSource: ((id: string) => ItemDef | undefined) | null = null
  let equipmentSource: (() => Readonly<Record<string, string | null>>) | null = null
  let modifierSource: ((key: string) => number) | null = null

  /** Skill-tree modifier (0 until the integrator wires skillTree.modifier). */
  const mod = (key: string): number => modifierSource?.(key) ?? 0

  // --- auto-retaliate state --------------------------------------------------
  /** The mob the hero is automatically hitting back (null = at peace). */
  let retaliateTarget: Mob | null = null
  /** Wall-clock second the next automatic counter-swing may fire. */
  let nextRetaliateAt = 0

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

  const pickSpecies = (region: { id: string; biome: string }): SpeciesDef | null => {
    const mix = REGION_MIX[region.id] ?? BIOME_MIX[region.biome]
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
      stunUntil: 0,
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
      const sp = pickSpecies(region)
      if (!sp) continue
      // Zone bands run all the way to the lv-99 coast; clamp the span so a
      // band like 72-88 never goes negative against a cap.
      const hi = Math.max(region.minLevel, Math.min(region.maxLevel, 99))
      const level = region.minLevel + Math.floor(rng() * (hi - region.minLevel + 1))
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
    if (m === retaliateTarget) retaliateTarget = null
    if (m === tapTarget) {
      tapTarget = null
      autoWalk(null)
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
  // Player strike resolution (range 2.2, 90° front arc) + shared hit applier
  // -------------------------------------------------------------------------

  /**
   * THE player-damage path: every swing and special flows through here.
   * `mult` scales the base roll (1 = plain swing); `useInt` adds staff
   * int-scaling; `special` adds the skill-tree special-damage modifier.
   */
  const applyHit = (m: Mob, mult: number, opts: { useInt?: boolean; special?: boolean } = {}): void => {
    if (!m.rig.alive) return
    const stats = statsSource?.() ?? { atk: 0, def: 0, str: 0, int: 0, agi: 0 }
    const atkLevel = skillsSource?.('attack') ?? 1

    const base = 3 + stats.atk + 0.4 * stats.str + (opts.useInt ? 0.6 * stats.int : 0)
    const crit = rng() < 0.1 + stats.agi * 0.002 + mod('combat.crit')
    let dmg = base * (1 + (atkLevel - 1) * 0.04) * (0.85 + rng() * 0.3) * mult
    dmg *= 1 + mod('combat.damage') + (opts.special ? mod('combat.special_damage') : 0)
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

  /**
   * Pet-companion damage: a fixed amount through the same pipeline as the
   * player's hits (hurt flash, bar, 'mob:hit', numbers, death flow) — no
   * player-stat scaling, no crits; the pet is 25% moxie and 75% heart.
   */
  const applyPetHit = (m: Mob, amount: number): void => {
    if (!m.rig.alive) return
    const dealt = Math.max(1, Math.round(amount))
    m.hp -= dealt
    m.rig.flashHurt()
    m.bar.set(m.hp / m.maxHp)
    const hitPos = new THREE.Vector3(m.x, m.y + m.rig.height * 0.5, m.z)
    events.emit('mob:hit', { species: m.sp.id, amount: dealt, crit: false, pos: hitPos })
    numbers.show(hitPos, String(dealt), {})
    if (m.state === 'wander') {
      m.state = 'chase'
      m.windupUntil = 0
    }
    if (m.hp <= 0) killMob(m)
  }

  const playerStrike = (): void => {
    if (playerDead) return
    const fx = Math.sin(player.facing)
    const fz = Math.cos(player.facing)

    let struckRetaliateTarget = false
    let struckOther: Mob | null = null

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

      applyHit(m, 1)

      if (m === retaliateTarget) struckRetaliateTarget = true
      else if (m.hp > 0) struckOther = m
    }

    // manual target switch: the player swung into a different mob while
    // auto-retaliating — follow their lead and hold the new grudge instead
    if (retaliateTarget && !struckRetaliateTarget && struckOther) {
      retaliateTarget = struckOther
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
    return Math.min(0.75, stats.def * 0.012 + (defLevel - 1) * 0.004 + mod('combat.defense'))
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
    // getting smacked is an even better argument for violence — hit back
    else if (autoRetaliateOn) retaliateTarget = m
  }

  const beginPlayerDeath = (): void => {
    playerDead = true
    retaliateTarget = null // corpses hold no grudges
    tapTarget = null
    dash = null
    autoWalk(null)
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
  // TAP-TO-ATTACK: tap/click a mob to target it — the hero faces it, walks
  // into range (if within TAP_CHASE_RANGE), swings, and keeps swinging while
  // it's targeted. Tap anywhere else to let the grudge go. Hit targets are
  // screen-space + enlarged, so stubby thumbs on phones still land taps.
  // -------------------------------------------------------------------------

  let tapTarget: Mob | null = null
  let nextTapAttackAt = 0
  /** Fallback glide target used only when the player-module walker isn't wired. */
  let glideTarget: { x: number; z: number; arrive: number } | null = null

  const autoWalk = (t: { x: number; z: number; arrive: number } | null): void => {
    if (autoWalkFn) autoWalkFn(t)
    else glideTarget = t
  }

  const projCenter = new THREE.Vector3()
  const projEdge = new THREE.Vector3()
  const camRight = new THREE.Vector3()

  /** Nearest live mob under a screen point, with mobile-fat hit circles. */
  const pickMobAt = (clientX: number, clientY: number): Mob | null => {
    const w = window.innerWidth
    const h = window.innerHeight
    camRight.setFromMatrixColumn(camera.matrixWorld, 0)
    let best: Mob | null = null
    let bestD = Infinity
    for (const m of mobs) {
      if (!m.rig.alive) continue
      projCenter.set(m.x, m.y + m.rig.height * 0.55, m.z)
      projEdge.copy(projCenter).addScaledVector(camRight, m.radius + 0.5)
      projCenter.project(camera)
      projEdge.project(camera)
      if (projCenter.z > 1) continue // behind the camera
      const sx = ((projCenter.x + 1) / 2) * w
      const sy = ((1 - projCenter.y) / 2) * h
      const pxR = Math.hypot(
        ((projEdge.x + 1) / 2) * w - sx,
        ((1 - projEdge.y) / 2) * h - sy
      )
      const d = Math.hypot(clientX - sx, clientY - sy)
      if (d <= Math.max(34, pxR * 1.4) && d < bestD) {
        best = m
        bestD = d
      }
    }
    return best
  }

  // tap detection: single pointer, short press, little movement, on-canvas.
  // The joystick/buttons stopPropagation, so their touches never reach here.
  let tapDownId = -1
  let tapDownX = 0
  let tapDownY = 0
  let tapDownT = 0
  let tapMulti = false
  let downCount = 0

  const onTapDown = (e: PointerEvent): void => {
    downCount++
    if (downCount > 1) {
      tapMulti = true // a pinch, not a tap
      return
    }
    if (!(e.target instanceof HTMLCanvasElement)) {
      tapDownId = -1
      return
    }
    tapDownId = e.pointerId
    tapDownX = e.clientX
    tapDownY = e.clientY
    tapDownT = performance.now()
    tapMulti = false
  }
  const onTapUp = (e: PointerEvent): void => {
    downCount = Math.max(0, downCount - 1)
    if (e.pointerId !== tapDownId) return
    tapDownId = -1
    if (tapMulti || playerDead) return
    if (performance.now() - tapDownT > TAP_MAX_MS) return
    if (Math.hypot(e.clientX - tapDownX, e.clientY - tapDownY) > TAP_MAX_PX) return
    const hit = pickMobAt(e.clientX, e.clientY)
    if (hit) {
      tapTarget = hit
      retaliateTarget = null // the player picked a fight; drop the old grudge
      nextTapAttackAt = 0 // first swing lands immediately
    } else if (tapTarget) {
      tapTarget = null // tapped elsewhere: stand down
      autoWalk(null)
    }
  }
  window.addEventListener('pointerdown', onTapDown)
  window.addEventListener('pointerup', onTapUp)
  window.addEventListener('pointercancel', onTapUp)

  // -------------------------------------------------------------------------
  // WEAPON SPECIALS: steel+ weapons grant an active ability (see the item
  // catalog). Desktop Q / right-click, mobile SPC button w/ cooldown ring.
  // Damage flows through applyHit (the existing resolution path) x mults.
  // -------------------------------------------------------------------------

  const specialCdUntil = new Map<string, number>()
  const specialCdTotal = new Map<string, number>()

  // equipped weapon/shield ids: equipment snapshot when wired, else events
  const trackedEquip: Record<'weapon' | 'shield', string | null> = { weapon: null, shield: null }
  const offEquipTracked = events.on('item:equipped', ({ slot, id }) => {
    if (slot === 'weapon' || slot === 'shield') trackedEquip[slot] = id
  })
  const equippedId = (slot: 'weapon' | 'shield'): string | null =>
    equipmentSource ? equipmentSource()[slot] ?? null : trackedEquip[slot]

  const specialOfItem = (id: string): ItemSpecial | undefined =>
    defSource ? defSource(id)?.special : fallbackSpecial(id)

  /** The active special: the weapon's, else the shield's. */
  const currentSpecial = (): { def: ItemSpecial; tier: number } | null => {
    for (const slot of ['weapon', 'shield'] as const) {
      const id = equippedId(slot)
      if (!id) continue
      const sp = specialOfItem(id)
      if (sp) return { def: sp, tier: Math.max(0, tierOfId(id)) }
    }
    return null
  }

  interface DashState {
    dx: number
    dz: number
    remaining: number
    nova: boolean
    color: number
    hit: Set<Mob>
  }
  let dash: DashState | null = null

  interface Projectile {
    group: THREE.Group
    x: number
    y: number
    z: number
    dx: number
    dz: number
    speed: number
    traveled: number
    maxDist: number
    kind: 'fire' | 'arrow'
    nova: boolean
    color: number
  }
  const projectiles: Projectile[] = []

  /** Aim at the tap target when there is one, else where the hero faces. */
  const aimDir = (): { dx: number; dz: number } => {
    if (tapTarget && tapTarget.rig.alive) {
      const dx = tapTarget.x - player.pos.x
      const dz = tapTarget.z - player.pos.z
      const d = Math.hypot(dx, dz)
      if (d > 0.01) return { dx: dx / d, dz: dz / d }
    }
    return { dx: Math.sin(player.facing), dz: Math.cos(player.facing) }
  }

  /** Shove a mob `dist` units along (dx,dz), stopping at walls. */
  const knockbackMob = (m: Mob, dx: number, dz: number, dist: number): void => {
    m.windupUntil = 0
    m.rig.setWindup(-1)
    const steps = 6
    for (let i = 0; i < steps; i++) {
      const nx = m.x + (dx * dist) / steps
      const nz = m.z + (dz * dist) / steps
      if (mobBlocked(nx, nz)) break
      m.x = nx
      m.z = nz
    }
  }

  const executeSpecial = (id: string, tier: number): void => {
    if (playerDead) return
    const color = tierFxColor(tier)
    const { dx, dz } = aimDir()
    const px = player.pos.x
    const py = player.pos.y
    const pz = player.pos.z
    const nowS = performance.now() / 1000

    switch (id) {
      case 'whirlwind':
      case 'whirlwind_nova': {
        // 360° AoE spin around the hero
        const nova = id === 'whirlwind_nova'
        const radius = nova ? 4.2 : 3.2
        for (const m of [...mobs]) {
          if (!m.rig.alive) continue
          if (Math.hypot(m.x - px, m.z - pz) <= radius + m.radius) {
            applyHit(m, nova ? 2.0 : 1.5, { special: true })
          }
        }
        fxPool.ring(px, py, pz, color, radius)
        if (nova) fxPool.nova(px, py, pz, color, radius)
        break
      }

      case 'lunge':
      case 'lunge_nova': {
        // dash-pierce with a motion trail (moved + resolved by the tick)
        autoWalk(null)
        player.facing = Math.atan2(dx, dz)
        dash = { dx, dz, remaining: 4.5, nova: id === 'lunge_nova', color, hit: new Set() }
        break
      }

      case 'fireball':
      case 'fireball_nova': {
        const nova = id === 'fireball_nova'
        const group = makeOrb(nova ? 0x7f6cf0 : 0xff8c3a, nova ? color : 0xffd23e)
        const x = px + dx * 0.7
        const z = pz + dz * 0.7
        const y = world.groundHeight(x, z) + 1.0
        group.position.set(x, y, z)
        scene.add(group)
        projectiles.push({
          group, x, y, z, dx, dz,
          speed: 11, traveled: 0, maxDist: nova ? 14 : 12,
          kind: 'fire', nova, color,
        })
        break
      }

      case 'volley':
      case 'volley_storm': {
        // arrow fan
        const storm = id === 'volley_storm'
        const n = storm ? 9 : 5
        const spread = storm ? 1.0 : 0.55
        const base = Math.atan2(dx, dz)
        for (let i = 0; i < n; i++) {
          const a = base - spread / 2 + (spread * i) / (n - 1)
          const adx = Math.sin(a)
          const adz = Math.cos(a)
          const group = makeArrow(color)
          const x = px + adx * 0.6
          const z = pz + adz * 0.6
          const y = world.groundHeight(x, z) + 0.9
          group.position.set(x, y, z)
          group.rotation.y = a
          scene.add(group)
          projectiles.push({
            group, x, y, z, dx: adx, dz: adz,
            speed: 14, traveled: 0, maxDist: 10,
            kind: 'arrow', nova: storm, color,
          })
        }
        break
      }

      case 'bash':
      case 'bash_shockwave': {
        // cone (or full-circle shockwave) knockback + stun
        const wave = id === 'bash_shockwave'
        const range = wave ? 3.5 : 2.8
        const facing = Math.atan2(dx, dz)
        for (const m of [...mobs]) {
          if (!m.rig.alive) continue
          const mdx = m.x - px
          const mdz = m.z - pz
          const d = Math.hypot(mdx, mdz)
          if (d > range + m.radius) continue
          if (!wave) {
            let diff = Math.atan2(mdx, mdz) - facing
            while (diff > Math.PI) diff -= Math.PI * 2
            while (diff < -Math.PI) diff += Math.PI * 2
            if (Math.abs(diff) > 0.9) continue // ~100° front cone
          }
          applyHit(m, wave ? 1.2 : 1.0, { special: true })
          if (m.rig.alive && m.hp > 0) {
            const kd = Math.max(0.01, d)
            knockbackMob(m, mdx / kd, mdz / kd, wave ? 4 : 3)
            m.stunUntil = nowS + (wave ? 2 : 1.5)
          }
        }
        if (wave) {
          fxPool.ring(px, py, pz, color, range)
          fxPool.nova(px, py, pz, color, range)
        } else {
          fxPool.cone(px, py, pz, facing, color, range)
        }
        break
      }
    }
  }

  const useSpecial = (): void => {
    if (playerDead) return
    const cur = currentSpecial()
    if (!cur) return
    const nowS = performance.now() / 1000
    if (nowS < (specialCdUntil.get(cur.def.id) ?? 0)) return // still cooling

    const fire = (): void => executeSpecial(cur.def.id, cur.tier)
    let started = true
    if (specialAnimFn) started = specialAnimFn(animOf(cur.def.id), fire)
    else window.setTimeout(fire, 140) // unwired: no anim, strike still lands
    if (!started) return // rig busy mid-swing — nothing spent

    const cd = cur.def.cooldownS * (1 - Math.min(0.5, mod('combat.special_cooldown')))
    specialCdUntil.set(cur.def.id, nowS + cd)
    specialCdTotal.set(cur.def.id, cd)
    events.emit('special:used', { id: cur.def.id })
  }

  const specialStatus = (): { id: string; name: string; cdLeft: number; cdTotal: number } | null => {
    const cur = currentSpecial()
    if (!cur) return null
    const nowS = performance.now() / 1000
    const cdLeft = Math.max(0, (specialCdUntil.get(cur.def.id) ?? 0) - nowS)
    const cdTotal = specialCdTotal.get(cur.def.id) ?? cur.def.cooldownS
    return { id: cur.def.id, name: cur.def.name, cdLeft, cdTotal }
  }

  // --- special inputs: Q key, right-click on the canvas, mobile SPC button --
  const specialTypingInField = (e: KeyboardEvent): boolean => {
    const t = e.target
    return (
      t instanceof HTMLInputElement ||
      t instanceof HTMLTextAreaElement ||
      (t instanceof HTMLElement && t.isContentEditable)
    )
  }
  const onSpecialKey = (e: KeyboardEvent): void => {
    if (e.code !== 'KeyQ' || e.repeat || specialTypingInField(e)) return
    useSpecial()
  }
  const onSpecialContext = (e: MouseEvent): void => {
    if (!(e.target instanceof HTMLCanvasElement)) return
    e.preventDefault()
    useSpecial()
  }
  window.addEventListener('keydown', onSpecialKey)
  window.addEventListener('contextmenu', onSpecialContext)

  let specialBtn: SpecialButton | null = null
  const specialUiRoot = document.getElementById('ui')
  const specialTouchy =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window
      : 'ontouchstart' in window
  if (specialUiRoot && specialTouchy) {
    specialBtn = createSpecialButton(specialUiRoot, useSpecial)
  }
  let specialBtnT = 0

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

    // shield-bash stun: no AI, no windup — just a dazed little wobble
    const stunned = now < m.stunUntil
    if (stunned && m.windupUntil > 0) {
      m.windupUntil = 0
      m.rig.setWindup(-1)
    }
    if (stunned) {
      m.facing += Math.sin(now * 18 + m.homeX) * dt * 2.2
    } else switch (m.state) {
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

    // --- tap-to-attack: chase the tapped mob + keep swinging -----------------
    if (tapTarget) {
      const t = tapTarget
      if (playerDead || !t.rig.alive || t.hp <= 0) {
        tapTarget = null
        autoWalk(null)
      } else {
        const dx = t.x - player.pos.x
        const dz = t.z - player.pos.z
        const d = Math.hypot(dx, dz)
        const reach = PLAYER_RANGE + t.radius
        if (d <= reach + 0.1) {
          autoWalk(null)
          player.facing = Math.atan2(dx, dz)
          if (now >= nextTapAttackAt) {
            nextTapAttackAt = now + TAP_ATTACK_COOLDOWN
            // existing resolution path: swing anim -> onAttack -> playerStrike
            if (attackTriggerFn) attackTriggerFn()
            else playerStrike()
          }
        } else if (d <= TAP_CHASE_RANGE) {
          autoWalk({ x: t.x, z: t.z, arrive: Math.max(0.6, reach - 0.25) })
        } else {
          autoWalk(null)
          if (!player.moving) player.facing = Math.atan2(dx, dz)
        }
      }
    }

    // --- glide fallback (player-module walker unwired): slide, no walk cycle -
    if (glideTarget && !playerDead) {
      const g = glideTarget
      const gdx = g.x - player.pos.x
      const gdz = g.z - player.pos.z
      const gd = Math.hypot(gdx, gdz)
      if (gd <= g.arrive) glideTarget = null
      else {
        const step = Math.min(gd, 3.8 * dt)
        const nx = player.pos.x + (gdx / gd) * step
        const nz = player.pos.z + (gdz / gd) * step
        if (!world.isBlocked(nx, player.pos.z)) player.pos.x = nx
        if (!world.isBlocked(player.pos.x, nz)) player.pos.z = nz
        player.facing = Math.atan2(gdx, gdz)
      }
    }

    // --- lunge dash: pierce along the line, trail the whole way --------------
    if (dash) {
      if (playerDead) dash = null
      else {
        const dsh = dash
        const step = Math.min(dsh.remaining, 16 * dt)
        const sub = Math.max(1, Math.ceil(step / 0.3))
        for (let i = 0; i < sub; i++) {
          const s = step / sub
          const nx = player.pos.x + dsh.dx * s
          const nz = player.pos.z + dsh.dz * s
          if (world.isBlocked(nx, nz)) {
            dsh.remaining = 0
            break
          }
          player.pos.x = nx
          player.pos.z = nz
        }
        dsh.remaining -= step
        player.facing = Math.atan2(dsh.dx, dsh.dz)
        fxPool.trail(player.pos.x, player.pos.y + 0.7, player.pos.z, dsh.color, 0.2)
        fxPool.trail(player.pos.x, player.pos.y + 0.3, player.pos.z, dsh.color, 0.15)
        for (const m of [...mobs]) {
          if (!m.rig.alive || dsh.hit.has(m)) continue
          if (Math.hypot(m.x - player.pos.x, m.z - player.pos.z) <= 1.3 + m.radius) {
            dsh.hit.add(m)
            applyHit(m, dsh.nova ? 2.2 : 1.8, { special: true })
          }
        }
        if (dsh.remaining <= 0.001) {
          if (dsh.nova) {
            // crystal/mythic: arrive with a nova
            fxPool.nova(player.pos.x, player.pos.y, player.pos.z, dsh.color, 2.6)
            for (const m of [...mobs]) {
              if (!m.rig.alive) continue
              if (Math.hypot(m.x - player.pos.x, m.z - player.pos.z) <= 2.6 + m.radius) {
                applyHit(m, 1.2, { special: true })
              }
            }
          }
          dash = null
        }
      }
    }

    // --- special projectiles (fireballs + arrows) ----------------------------
    for (const p of [...projectiles]) {
      const step = p.speed * dt
      p.x += p.dx * step
      p.z += p.dz * step
      p.traveled += step
      const gy = world.groundHeight(p.x, p.z)
      p.y = gy + (p.kind === 'fire' ? 1.0 : 0.9)
      p.group.position.set(p.x, p.y, p.z)
      if (p.kind === 'fire') {
        p.group.rotation.y += dt * 7
        p.group.rotation.x += dt * 5
        fxPool.trail(p.x, p.y, p.z, p.nova ? p.color : 0xff8c3a, 0.12)
      } else if (rng() < 0.45) {
        fxPool.trail(p.x, p.y, p.z, p.color, 0.08)
      }

      let hitMob: Mob | null = null
      for (const m of mobs) {
        if (!m.rig.alive) continue
        if (Math.hypot(m.x - p.x, m.z - p.z) <= 0.5 + m.radius) {
          hitMob = m
          break
        }
      }
      const done = hitMob !== null || world.isBlocked(p.x, p.z) || p.traveled >= p.maxDist
      if (!done) continue

      if (p.kind === 'fire') {
        // voxel-chunk explosion (chunky burst via the blood pool, recolored)
        const radius = p.nova ? 3.2 : 2.2
        blood.burst(new THREE.Vector3(p.x, p.y, p.z), gy, 3.2, p.nova ? p.color : 0xff6a2a)
        fxPool.ring(p.x, gy, p.z, p.nova ? p.color : 0xffb13a, radius)
        if (p.nova) fxPool.nova(p.x, gy, p.z, p.color, radius)
        for (const m of [...mobs]) {
          if (!m.rig.alive) continue
          if (Math.hypot(m.x - p.x, m.z - p.z) <= radius + m.radius) {
            applyHit(m, p.nova ? 2.2 : 1.6, { useInt: true, special: true })
          }
        }
      } else if (hitMob) {
        applyHit(hitMob, p.nova ? 0.8 : 0.7, { special: true })
        fxPool.trail(p.x, p.y, p.z, p.color, 0.14)
      } else {
        fxPool.trail(p.x, p.y, p.z, 0x9aa0a8, 0.1)
      }
      disposeProjectile(p.group)
      const pi = projectiles.indexOf(p)
      if (pi >= 0) projectiles.splice(pi, 1)
    }

    fxPool.update(dt)

    // --- mobile SPC button: visibility + cooldown ring (throttled) -----------
    specialBtnT += dt
    if (specialBtn && specialBtnT >= 0.1) {
      specialBtnT = 0
      const st = specialStatus()
      specialBtn.set(st !== null, st !== null && st.cdTotal > 0 ? st.cdLeft / st.cdTotal : 0)
    }

    // --- auto-retaliate: hit back while the grudge stays warm ----------------
    // (the tap target owns the fight while one is set)
    if (retaliateTarget && (!autoRetaliateOn || playerDead || tapTarget)) retaliateTarget = null
    if (retaliateTarget) {
      const t = retaliateTarget
      const d = Math.hypot(t.x - player.pos.x, t.z - player.pos.z)
      if (!t.rig.alive || t.hp <= 0 || t.state !== 'chase') {
        retaliateTarget = null // it died, leashed, or lost interest — we're done
      } else if (d > PLAYER_RANGE + t.radius + RETALIATE_BREAK_DIST) {
        retaliateTarget = null // the player walked away; let it go
      } else if (d <= PLAYER_RANGE + t.radius && now >= nextRetaliateAt) {
        nextRetaliateAt = now + RETALIATE_COOLDOWN
        // square up to the attacker (movement input still overrides facing)
        player.facing = Math.atan2(t.x - player.pos.x, t.z - player.pos.z)
        // existing resolution path: swing animation -> onAttack -> playerStrike.
        // triggerAttack no-ops mid-swing; the next tick past cooldown retries.
        if (attackTriggerFn) attackTriggerFn()
        else playerStrike()
      }
    }

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
    setAttackTrigger(fn) {
      attackTriggerFn = fn
    },
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
    useSpecial,
    specialStatus,
    setAutoWalk(fn) {
      autoWalkFn = fn
      glideTarget = null // the real walker owns movement from here on
    },
    setSpecialAnimTrigger(fn) {
      specialAnimFn = fn
    },
    setDefSource(fn) {
      defSource = fn
    },
    setEquipmentSource(fn) {
      equipmentSource = fn
    },
    setModifierSource(fn) {
      modifierSource = fn
    },
    petTarget() {
      const t = tapTarget ?? retaliateTarget
      if (!t || !t.rig.alive || t.hp <= 0) return null
      return {
        x: t.x,
        z: t.z,
        radius: t.radius,
        alive: t.rig.alive && t.hp > 0,
        hit: (amount: number) => applyPetHit(t, amount),
      }
    },
    dispose() {
      cancelAnimationFrame(raf)
      offAttuned()
      offTraveled()
      offEquipTracked()
      window.removeEventListener('pointerdown', onTapDown)
      window.removeEventListener('pointerup', onTapUp)
      window.removeEventListener('pointercancel', onTapUp)
      window.removeEventListener('keydown', onSpecialKey)
      window.removeEventListener('contextmenu', onSpecialContext)
      specialBtn?.dispose()
      for (const p of [...projectiles]) disposeProjectile(p.group)
      projectiles.length = 0
      for (const m of [...mobs]) removeMob(m)
      for (const d of [...drops]) removeDrop(d)
      blood.dispose()
      numbers.dispose()
      fxPool.dispose()
    },
  }
}
