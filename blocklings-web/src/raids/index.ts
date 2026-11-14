/**
 * RAIDS — the apex world-boss fights (core).
 *
 * Four giant, multi-phase bosses sleep at summon altars in the far outer
 * zones (see ./bosses + ./altar). Walk to a ready altar, tap Summon, and the
 * boss rises IN THE OPEN WORLD (no instancing): a telegraphed, add-spitting,
 * enrage-timered fight with a shared HP bar pinned to the top of the screen.
 *
 * Combat is REUSED the way pets/dungeon reuse it — mob VISUALS for the adds
 * come from the injected combat MobRig (setMobRigSource), the player's swing
 * damage mirrors combat's formula, and the player's existing swing path feeds
 * us via onAttack(() => raids.onPlayerStrike()). Everything else — the giant
 * boss rig, phase machine, AoE telegraphs, loot and death — is self-contained.
 *
 * Talks to the rest of the game ONLY through the event bus + GameAPI +
 * integrator setters (+ the one sanctioned saveRegistry leaf import). Places
 * its altar props directly into api.scene and registers their collision by
 * wrapping world.isBlocked (the same technique the dungeon uses; the World
 * grid itself is closed over and never touched). Persists per-boss cooldowns
 * via the save registry ('raids'). Self-drives its own RAF tick.
 *
 * MUSIC: on boss hits we emit 'mob:hit' with { boss:true, bossId: themeSong }
 * where themeSong is an EXISTING registered boss theme — the music director
 * then swells that theme for the fight and releases it on the 'mob:killed' we
 * emit at the end. No new audio asset, no fighting the director.
 *
 * ASCENDED PET: the kill emits 'mob:killed' {species: petSpecies, boss:true}
 * so the pets module rolls that species' rare `.boss` baby (1/40) — the
 * closest thing to an "ascended" variant the frozen PetVariant union permits
 * today. A true 'ascended' tier would need a PET_VARIANTS append (noted).
 */
import * as THREE from 'three'
import type { GameAPI } from '../types'
import { events } from '../events'
import { saveRegistry } from '../save/registry'
import { RAID_BOSSES, raidBossById, type RaidBossDef, type RaidPattern } from './bosses'
import { RaidBossRig } from './model'
import { RaidFx } from './fx'
import { buildAltar, type AltarHandle } from './altar'
import { RaidAdd, type MobRigSource } from './adds'
import { RaidsUI } from './ui'
import { flavor } from './flavor'

// ---------------------------------------------------------------------------
// Public contract (integrator-wired setters; mirrors combat/dungeon wiring)
// ---------------------------------------------------------------------------

export interface RaidStats {
  atk: number
  def: number
  str: number
  int: number
  agi: number
}

/** Nearby multiplayer presence, read for the shared-raid credit/headcount. */
export interface RaiderPresence {
  x: number
  z: number
}

export interface RaidsModule {
  /** Adds' voxel rigs (integrator passes combat's MobRig; same as pets/dungeon). */
  setMobRigSource(fn: MobRigSource): void
  /** Equipped-gear stats (integrator passes inventory.equippedStats). */
  setStatsSource(fn: () => RaidStats): void
  /** Skill levels (integrator passes skills.level). */
  setSkillsSource(fn: (skill: string) => number): void
  /** Skill-tree combat modifiers (integrator passes skillTree.modifier + mastery). */
  setModifierSource(fn: (key: string) => number): void
  /** Grant loot (integrator passes the inventory module — the ONLY stack mutator). */
  setInventory(inv: { add: (id: string, qty: number, source?: string) => void }): void
  /** Apply boss/add damage to the player (integrator: hp mutate + hurt flash). */
  setPlayerDamage(fn: (amount: number, from: string) => void): void
  /** Player death animation (integrator: (onDown)=>playerDie(onDown)). */
  setPlayerDeath(fn: (onDown: (revive: () => void) => void) => void): void
  /** Swing-animation trigger for forgiving auto-attack (integrator: triggerAttack). */
  setAttackTrigger(fn: () => void): void
  /** Nearby remote players (integrator: () => [...net.remotes.values()]). */
  setPresenceSource(fn: () => readonly RaiderPresence[]): void
  /** Strike frame — integrator wires onAttack(() => raids.onPlayerStrike()). */
  onPlayerStrike(): void
  /** True while a boss fight (or its summon transition) is live. */
  active(): boolean
  dispose(): void
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const SUMMON_RANGE = 4.5
const STRIKE_RANGE = 2.2
const STRIKE_ARC = Math.PI / 4 // ±45°
const AUTO_SWING_CD = 0.75
const FLEE_DIST = 78 // wander this far from the boss = you fled
const ADD_CAP = 6
const BOSS_DRIFT_SPEED = 1.7 // the giant lumbers toward you for melee
const TELEGRAPH_SECS = 1.2
const PRESENCE_RANGE = 62 // remotes within this of the boss count as raiders

interface PendingAoe {
  at: number
  x: number
  z: number
  radius: number
  /** Donut inner radius (0 = filled circle). */
  inner: number
  dmg: number
}

interface Fight {
  def: RaidBossDef
  rig: RaidBossRig
  hp: number
  maxHp: number
  atk: number
  phase: number
  x: number
  z: number
  facing: number
  startedAt: number
  enraged: boolean
  nextCastAt: number
  nextMeleeAt: number
  meleeWindupUntil: number
  adds: RaidAdd[]
  pending: PendingAoe[]
  ending: boolean
}

interface RaidSave {
  v: 1
  /** bossId -> earliest next-summon epoch ms. */
  cd: Record<string, number>
}

let inited: RaidsModule | null = null

export function initRaids(api: GameAPI): RaidsModule {
  if (inited) return inited

  const { scene, player, world } = api
  const uiMount = document.getElementById('ui') ?? document.body
  const rng = (): number => Math.random()
  const scratch = new THREE.Vector3()

  // --- injected sources -----------------------------------------------------
  let mobRigFn: MobRigSource | null = null
  let statsFn: (() => RaidStats) | null = null
  let skillsFn: ((skill: string) => number) | null = null
  let modFn: ((key: string) => number) | null = null
  let inventory: { add: (id: string, qty: number, source?: string) => void } | null = null
  let playerDamageFn: ((amount: number, from: string) => void) | null = null
  let playerDeathFn: ((onDown: (revive: () => void) => void) => void) | null = null
  let attackTriggerFn: (() => void) | null = null
  let presenceFn: (() => readonly RaiderPresence[]) | null = null
  const mod = (key: string): number => modFn?.(key) ?? 0

  // --- cooldown persistence -------------------------------------------------
  const cooldowns: Record<string, number> = {}
  saveRegistry.register('raids', {
    dump: (): RaidSave => ({ v: 1, cd: { ...cooldowns } }),
    load: (data: unknown): void => {
      const d = data as Partial<RaidSave> | null
      if (!d || typeof d !== 'object' || !d.cd || typeof d.cd !== 'object') return
      for (const [k, v] of Object.entries(d.cd)) {
        if (raidBossById(k) && typeof v === 'number' && Number.isFinite(v)) cooldowns[k] = v
      }
    }
  })

  // --- altar props + collision ----------------------------------------------
  const altars = new Map<string, AltarHandle>()
  const solidCells = new Set<string>()
  const cellKey = (ix: number, iz: number): string => `${ix},${iz}`
  for (const b of RAID_BOSSES) {
    const gy = world.groundHeight(b.altar.x, b.altar.z)
    const altar = buildAltar({ cx: b.altar.x, cz: b.altar.z, color: b.color, dark: b.dark, glow: b.glow })
    altar.group.position.y = gy
    scene.add(altar.group)
    altars.set(b.id, altar)
    for (const [ix, iz] of altar.solids) solidCells.add(cellKey(ix, iz))
  }
  // register the altar footprints as world solids (chain through whatever
  // isBlocked is current so we compose with any other wrapper, e.g. dungeon)
  const prevIsBlocked = world.isBlocked.bind(world)
  world.isBlocked = (x: number, z: number): boolean =>
    solidCells.has(cellKey(Math.floor(x), Math.floor(z))) || prevIsBlocked(x, z)

  // --- UI -------------------------------------------------------------------
  const fx = new RaidFx(scene)
  const ui = new RaidsUI(uiMount)
  ui.onSummon = () => trySummon()

  let fight: Fight | null = null
  let nearAltar: RaidBossDef | null = null
  let playerDead = false

  // -------------------------------------------------------------------------
  // Summon
  // -------------------------------------------------------------------------

  function minsLeft(bossId: string): number {
    const left = (cooldowns[bossId] ?? 0) - Date.now()
    return left > 0 ? Math.ceil(left / 60000) : 0
  }

  function trySummon(): void {
    if (fight) {
      events.emit('chat:system', { text: flavor.busy() })
      return
    }
    const b = nearAltar
    if (!b) return
    const d = Math.hypot(player.pos.x - b.altar.x, player.pos.z - b.altar.z)
    if (d > SUMMON_RANGE + 1) return
    if (minsLeft(b.id) > 0) {
      events.emit('chat:system', { text: flavor.cooldown(b.name, minsLeft(b.id)) })
      return
    }
    if (player.level < b.level - 8) {
      // a kindness, not a hard gate — warn and let them try next approach
      events.emit('chat:system', { text: flavor.tooLow(b.name, b.level) })
    }
    beginFight(b)
  }

  function beginFight(b: RaidBossDef): void {
    const spawnX = b.altar.x
    const spawnZ = b.altar.z - 7 // rise just north of the altar, in the open
    const rig = new RaidBossRig({ archetype: b.archetype, color: b.color, dark: b.dark, glow: b.glow })
    rig.group.position.set(spawnX, world.groundHeight(spawnX, spawnZ), spawnZ)
    scene.add(rig.group)

    const nowS = performance.now() / 1000
    fight = {
      def: b,
      rig,
      hp: b.baseHp,
      maxHp: b.baseHp,
      atk: b.baseAtk,
      phase: 0,
      x: spawnX,
      z: spawnZ,
      facing: 0,
      startedAt: nowS,
      enraged: false,
      nextCastAt: nowS + 2.5,
      nextMeleeAt: nowS + 1.5,
      meleeWindupUntil: 0,
      adds: [],
      pending: [],
      ending: false
    }
    rig.setPhase(0)
    ui.setSummon(null)
    ui.setBarVisible(true)
    refreshBar()
    events.emit('chat:system', { text: flavor.aggro(b.id) })
    // kick the boss theme right on the roar (amount 0 renders no number; it
    // just tells the music director which theme to swell)
    emitBossHit(0, false)
  }

  // -------------------------------------------------------------------------
  // Phase + enrage
  // -------------------------------------------------------------------------

  function phaseFor(f: Fight, frac: number): number {
    let idx = 0
    for (let i = 0; i < f.def.phases.length; i++) {
      if (frac <= (f.def.phases[i]?.at ?? 0)) idx = i
    }
    return idx
  }

  function checkPhase(f: Fight): void {
    const frac = f.hp / f.maxHp
    const want = phaseFor(f, frac)
    if (want > f.phase) {
      f.phase = want
      f.rig.setPhase(want)
      const gy = world.groundHeight(f.x, f.z)
      fx.nova(f.x, gy, f.z, f.def.glow, 5)
      const line = flavor.phase(f.def.id, want)
      if (line) events.emit('chat:system', { text: line })
      emitBossHit(0, false) // re-touch the theme so it never lapses on a lull
    }
  }

  function checkEnrage(f: Fight, nowS: number): void {
    if (f.enraged) return
    if (nowS - f.startedAt >= f.def.enrageSecs) {
      f.enraged = true
      events.emit('chat:system', { text: flavor.enrage(f.def.id) })
    }
  }

  /** Current boss damage (phase + soft-enrage ramp). */
  function bossDamage(f: Fight, nowS: number): number {
    let a = f.atk * (1 + f.phase * 0.12)
    if (f.enraged) {
      const over = nowS - f.startedAt - f.def.enrageSecs
      a *= 1.8 + Math.min(2.5, over * 0.03) // ramps the longer you drag it out
    }
    return a
  }

  // -------------------------------------------------------------------------
  // Pattern executor (telegraph now, resolve on the timer)
  // -------------------------------------------------------------------------

  function castPattern(f: Fight, kind: RaidPattern, nowS: number): void {
    const gy = world.groundHeight(f.x, f.z)
    const dmg = bossDamage(f, nowS)
    switch (kind) {
      case 'slam': {
        // drop a warning circle under the player's current feet
        const tx = player.pos.x
        const tz = player.pos.z
        fx.warning(tx, world.groundHeight(tx, tz), tz, 3.6, f.def.glow, TELEGRAPH_SECS)
        f.pending.push({ at: nowS + TELEGRAPH_SECS, x: tx, z: tz, radius: 3.6, inner: 0, dmg: dmg * 1.7 })
        break
      }
      case 'rings': {
        // expanding donut around the boss — sprint IN toward it to survive
        fx.warning(f.x, gy, f.z, 7.5, f.def.glow, TELEGRAPH_SECS)
        f.pending.push({ at: nowS + TELEGRAPH_SECS, x: f.x, z: f.z, radius: 7.8, inner: 2.6, dmg: dmg * 1.3 })
        break
      }
      case 'breath': {
        // a swept line of warnings toward the player (cone-ish)
        const dx = player.pos.x - f.x
        const dz = player.pos.z - f.z
        const d = Math.hypot(dx, dz) || 1
        const ux = dx / d
        const uz = dz / d
        for (let step = 1; step <= 4; step++) {
          const bx = f.x + ux * step * 2.4
          const bz = f.z + uz * step * 2.4
          fx.warning(bx, world.groundHeight(bx, bz), bz, 2.2, f.def.glow, TELEGRAPH_SECS)
          f.pending.push({ at: nowS + TELEGRAPH_SECS, x: bx, z: bz, radius: 2.2, inner: 0, dmg: dmg * 1.1 })
        }
        break
      }
      case 'adds': {
        spawnAdds(f, nowS)
        break
      }
    }
  }

  function resolvePending(f: Fight, nowS: number): void {
    if (f.pending.length === 0) return
    const px = player.pos.x
    const pz = player.pos.z
    for (let i = f.pending.length - 1; i >= 0; i--) {
      const p = f.pending[i]!
      if (nowS < p.at) continue
      const gy = world.groundHeight(p.x, p.z)
      fx.ring(p.x, gy, p.z, f.def.glow, p.radius)
      fx.burst(p.x, gy, p.z, f.def.glow, 1.2)
      if (!playerDead && !f.ending) {
        const d = Math.hypot(px - p.x, pz - p.z)
        const hit = p.inner > 0 ? d >= p.inner && d <= p.radius : d <= p.radius
        if (hit) hurtPlayer(p.dmg, f.def.name)
      }
      f.pending.splice(i, 1)
    }
  }

  // -------------------------------------------------------------------------
  // Adds (reuse the combat MobRig)
  // -------------------------------------------------------------------------

  function spawnAdds(f: Fight, _nowS: number): void {
    const live = f.adds.filter((a) => a.alive).length
    const room = ADD_CAP - live
    if (room <= 0 || !mobRigFn) return
    const n = Math.min(room, 2 + Math.floor(rng() * 2))
    // adds scale off the boss level; thematic species per phase cap
    const species = addSpeciesFor(f.def)
    for (let i = 0; i < n; i++) {
      const sp = species[Math.floor(rng() * species.length)] ?? 'skeleton'
      const rig = mobRigFn(sp, false)
      if (!rig) continue
      const a = rng() * Math.PI * 2
      const r = 4 + rng() * 3
      const ax = f.x + Math.cos(a) * r
      const az = f.z + Math.sin(a) * r
      const lvl = Math.max(1, Math.round(f.def.level * 0.5))
      const add = new RaidAdd({
        rig,
        species: sp,
        level: lvl,
        maxHp: Math.round(40 + lvl * 10),
        atk: Math.round(f.atk * 0.4),
        x: ax,
        z: az,
        homeX: f.x,
        homeZ: f.z,
        groundY: world.groundHeight(ax, az)
      })
      add.addToScene(scene)
      f.adds.push(add)
    }
  }

  function addSpeciesFor(def: RaidBossDef): readonly string[] {
    switch (def.archetype) {
      case 'wyrm': return ['bat', 'wolf', 'wisp']
      case 'colossus': return ['golem', 'imp', 'bat']
      case 'tyrant': return ['skeleton', 'bat', 'wisp']
      case 'warlord': return ['orc', 'goblin', 'bandit']
    }
  }

  function killAdd(f: Fight, add: RaidAdd): void {
    scratch.set(add.x, 0, add.z)
    events.emit('mob:killed', { species: add.species, level: add.level, pos: scratch.clone() })
    const xp = Math.round((10 + add.level * 5))
    events.emit('xp:gained', { skill: 'attack', amount: xp })
    events.emit('xp:gained', { skill: 'vitality', amount: Math.ceil(xp * 0.4) })
    add.kill(() => {
      const i = f.adds.indexOf(add)
      if (i >= 0) {
        f.adds.splice(i, 1)
        add.dispose()
      }
    })
  }

  // -------------------------------------------------------------------------
  // Player swing resolution (mirrors combat.applyHit)
  // -------------------------------------------------------------------------

  function strikeDamage(): { dmg: number; crit: boolean } {
    const s = statsFn?.() ?? { atk: 0, def: 0, str: 0, int: 0, agi: 0 }
    const atkLevel = skillsFn?.('attack') ?? 1
    const base = 3 + s.atk + 0.4 * s.str
    const crit = rng() < 0.1 + s.agi * 0.002 + mod('combat.crit')
    let dmg = base * (1 + (atkLevel - 1) * 0.04) * (0.85 + rng() * 0.3)
    dmg *= 1 + mod('combat.damage')
    if (crit) dmg *= 1.75
    return { dmg: Math.max(1, Math.round(dmg)), crit }
  }

  function emitBossHit(amount: number, crit: boolean): void {
    const f = fight
    if (!f) return
    scratch.set(f.x, f.rig.height * 0.5, f.z)
    events.emit('mob:hit', {
      species: f.def.petSpecies,
      amount,
      crit,
      pos: scratch.clone(),
      boss: true,
      bossId: f.def.themeSong
    })
  }

  function onPlayerStrike(): void {
    const f = fight
    if (!f || playerDead || f.ending) return
    const fxd = Math.sin(player.facing)
    const fzd = Math.cos(player.facing)
    const baseAng = Math.atan2(fxd, fzd)

    const inArc = (dx: number, dz: number, dist: number, radius: number): boolean => {
      if (dist > STRIKE_RANGE + radius) return false
      let diff = Math.atan2(dx, dz) - baseAng
      while (diff > Math.PI) diff -= Math.PI * 2
      while (diff < -Math.PI) diff += Math.PI * 2
      return Math.abs(diff) <= STRIKE_ARC || dist <= radius + 0.5
    }

    // boss
    const bdx = f.x - player.pos.x
    const bdz = f.z - player.pos.z
    const bdist = Math.hypot(bdx, bdz)
    if (f.rig.alive && inArc(bdx, bdz, bdist, f.rig.radius)) {
      const { dmg, crit } = strikeDamage()
      f.hp = Math.max(0, f.hp - dmg)
      f.rig.flashHurt()
      emitBossHit(dmg, crit)
      checkPhase(f)
      if (f.hp <= 0) {
        bossDown(f)
        return
      }
    }

    // adds in the swing
    for (const add of [...f.adds]) {
      if (!add.alive) continue
      const dx = add.x - player.pos.x
      const dz = add.z - player.pos.z
      const dist = Math.hypot(dx, dz)
      if (!inArc(dx, dz, dist, add.radius)) continue
      const { dmg, crit } = strikeDamage()
      const killed = add.takeHit(dmg)
      scratch.set(add.x, 1, add.z)
      events.emit('mob:hit', { species: add.species, amount: dmg, crit, pos: scratch.clone() })
      if (killed) killAdd(f, add)
    }
  }

  // -------------------------------------------------------------------------
  // Boss hurts player + the death / wipe flow
  // -------------------------------------------------------------------------

  function defenseReduction(s: RaidStats): number {
    const defLevel = skillsFn?.('defense') ?? 1
    return Math.min(0.75, s.def * 0.012 + (defLevel - 1) * 0.004 + mod('combat.defense'))
  }

  function hurtPlayer(raw: number, from: string): void {
    if (playerDead) return
    const s = statsFn?.() ?? { atk: 0, def: 0, str: 0, int: 0, agi: 0 }
    const dealt = Math.max(1, Math.round(raw * (0.9 + rng() * 0.2) * (1 - defenseReduction(s))))
    if (playerDamageFn) playerDamageFn(dealt, from)
    else player.hp = Math.max(0, player.hp - dealt)
    events.emit('player:damaged', { amount: dealt, from })
    if (player.hp <= 0) beginWipe()
  }

  function beginWipe(): void {
    const f = fight
    if (!f || playerDead || f.ending) return
    playerDead = true
    f.ending = true
    events.emit('player:died', { at: player.pos.clone() })
    events.emit('chat:system', { text: flavor.wipe() })
    const finish = (revive?: () => void): void => {
      player.hp = player.maxHp
      playerDead = false
      endFight(false) // wipe: no cooldown, altar ready for a retry
      revive?.()
    }
    if (playerDeathFn) playerDeathFn((revive) => window.setTimeout(() => finish(revive), 900))
    else window.setTimeout(() => finish(), 1400)
  }

  // -------------------------------------------------------------------------
  // Boss death + loot
  // -------------------------------------------------------------------------

  function bossDown(f: Fight): void {
    if (f.ending) return
    f.ending = true
    const gy = world.groundHeight(f.x, f.z)
    scratch.set(f.x, gy, f.z)
    const pos = scratch.clone()

    // the kill event: pets roll the ascended boss-baby, director releases the
    // theme, achievements + quests count the boss kill
    events.emit('mob:killed', { species: f.def.petSpecies, level: f.def.level, pos, boss: true })
    const xp = Math.round((10 + f.def.level * 5) * 8) // apex payout
    events.emit('xp:gained', { skill: 'attack', amount: xp })
    events.emit('xp:gained', { skill: 'vitality', amount: Math.ceil(xp * 0.5) })

    // raid credit for nearby presence (presence-only relay: each client runs
    // its own instance, so this is a shout-out + a small bonus token, not a
    // shared-HP settlement)
    const raiders = nearbyRaiders(f)

    fx.nova(f.x, gy, f.z, f.def.glow, 6)
    fx.burst(f.x, gy + 1, f.z, f.def.glow, 4)

    grantLoot(f.def, raiders)
    events.emit('chat:system', { text: flavor.death(f.def.id) })
    if (raiders > 0) {
      events.emit('chat:system', {
        text: `${raiders} nearby raider${raiders === 1 ? '' : 's'} shared the glory — everyone banks the haul.`
      })
    }

    cooldowns[f.def.id] = Date.now() + f.def.cooldownMs
    events.emit('save:dirty', { why: 'raid cleared' })

    f.rig.die(() => {
      window.setTimeout(() => {
        f.rig.group.removeFromParent()
        f.rig.dispose()
      }, 400)
    })
    for (const a of f.adds) a.dispose()
    f.adds.length = 0
    f.pending.length = 0
    fight = null
    ui.setBarVisible(false)
  }

  function grantLoot(def: RaidBossDef, raiders: number): void {
    if (!inventory) return
    const L = def.loot
    const pullEpic = (): void => {
      const id = L.epicPool[Math.floor(rng() * L.epicPool.length)]
      if (id) inventory!.add(id, 1, 'loot')
    }
    for (let i = 0; i < L.guaranteed; i++) pullEpic()
    if (rng() < 0.5) pullEpic() // bonus epic
    if (rng() < L.legendaryChance) {
      inventory.add(L.legendaryId, 1, 'loot')
      events.emit('chat:system', {
        text: `★ LEGENDARY: ${def.name} dropped ${L.legendaryName}. Frame it. Fight in it. Flex it.`
      })
    }
    const [lo, hi] = L.tokenQty
    let tokens = lo + Math.floor(rng() * (hi - lo + 1))
    if (raiders > 0) tokens += raiders // small shared bonus for showing up
    inventory.add(L.tokenId, tokens, 'loot')
    inventory.add(L.treat, 1, 'loot')
  }

  // -------------------------------------------------------------------------
  // Presence (nearby remote raiders)
  // -------------------------------------------------------------------------

  function nearbyRaiders(f: Fight): number {
    const list = presenceFn?.() ?? []
    let n = 0
    for (const r of list) {
      if (Math.hypot(r.x - f.x, r.z - f.z) <= PRESENCE_RANGE) n++
    }
    return n
  }

  // -------------------------------------------------------------------------
  // Self-driven tick
  // -------------------------------------------------------------------------

  let raf = 0
  let last = performance.now()

  function tick(now: number): void {
    raf = requestAnimationFrame(tick)
    const dt = Math.min((now - last) / 1000, 0.1)
    last = now
    const nowS = now / 1000

    for (const a of altars.values()) a.update(dt)
    fx.update(dt)

    if (!fight) {
      // proximity: show the Summon prompt for the nearest ready-ish altar
      let best: RaidBossDef | null = null
      let bestD = Infinity
      for (const b of RAID_BOSSES) {
        const d = Math.hypot(player.pos.x - b.altar.x, player.pos.z - b.altar.z)
        if (d <= SUMMON_RANGE && d < bestD) {
          best = b
          bestD = d
        }
      }
      nearAltar = best
      if (best) {
        const cd = minsLeft(best.id)
        ui.setSummon(cd > 0 ? `${best.name} — ${cd}m` : `Summon ${best.name}`)
      } else {
        ui.setSummon(null)
      }
      return
    }

    const f = fight
    if (f.ending) {
      f.rig.update(dt)
      return
    }

    // fled too far? the boss loses interest (no cooldown — come back and retry)
    if (Math.hypot(player.pos.x - f.x, player.pos.z - f.z) > FLEE_DIST) {
      events.emit('chat:system', { text: flavor.wipe() })
      endFight(false)
      return
    }

    checkEnrage(f, nowS)
    resolvePending(f, nowS)

    // boss lumbers toward the player for melee range, else pattern-casts
    const dx = player.pos.x - f.x
    const dz = player.pos.z - f.z
    const dist = Math.hypot(dx, dz)
    const reach = f.rig.radius + 1.6
    f.facing = Math.atan2(dx, dz)
    if (f.meleeWindupUntil > 0) {
      if (nowS >= f.meleeWindupUntil) {
        f.meleeWindupUntil = 0
        f.nextMeleeAt = nowS + 2.0
        f.rig.strike()
        if (dist < reach + 1.0 && !playerDead) hurtPlayer(bossDamage(f, nowS), f.def.name)
      }
    } else if (dist > reach) {
      const step = BOSS_DRIFT_SPEED * dt
      f.x += (dx / (dist || 1)) * step
      f.z += (dz / (dist || 1)) * step
    } else if (nowS >= f.nextMeleeAt) {
      f.meleeWindupUntil = nowS + 0.45
      f.rig.telegraph(1)
    }

    // pattern scheduler
    if (nowS >= f.nextCastAt && f.meleeWindupUntil === 0) {
      const phase = f.def.phases[f.phase] ?? f.def.phases[0]!
      const pat = phase.patterns[Math.floor(rng() * phase.patterns.length)] ?? 'slam'
      castPattern(f, pat, nowS)
      f.nextCastAt = nowS + phase.castEvery
    }

    // position + animate the giant
    const gy = world.groundHeight(f.x, f.z)
    f.rig.group.position.set(f.x, gy, f.z)
    f.rig.group.rotation.y = f.facing
    if (f.meleeWindupUntil === 0 && f.rig.alive) f.rig.telegraph(-1)
    f.rig.update(dt)

    // adds AI
    for (const add of f.adds) {
      add.update(dt, nowS, player.pos.x, player.pos.z, !playerDead, (amt, from) => hurtPlayer(amt, from))
    }

    // forgiving auto-attack when the boss or an add is in reach (mobile-safe)
    if (!playerDead && nowS >= nextAutoSwingAt && anyTargetInReach(f)) {
      nextAutoSwingAt = nowS + AUTO_SWING_CD
      if (!player.moving) player.facing = f.facing // square up to the boss
      if (attackTriggerFn) attackTriggerFn()
      else onPlayerStrike()
    }

    refreshBar()
  }

  let nextAutoSwingAt = 0

  function anyTargetInReach(f: Fight): boolean {
    if (f.rig.alive && Math.hypot(f.x - player.pos.x, f.z - player.pos.z) <= STRIKE_RANGE + f.rig.radius + 0.3) {
      return true
    }
    for (const add of f.adds) {
      if (!add.alive) continue
      if (Math.hypot(add.x - player.pos.x, add.z - player.pos.z) <= STRIKE_RANGE + add.radius + 0.3) return true
    }
    return false
  }

  function refreshBar(): void {
    const f = fight
    if (!f) return
    const nowS = performance.now() / 1000
    ui.setBar({
      name: f.def.name,
      title: f.def.title,
      hp: f.hp / f.maxHp,
      tint: f.def.tint,
      phase: f.phase,
      phaseCount: f.def.phases.length,
      enrageIn: f.def.enrageSecs - (nowS - f.startedAt),
      enraged: f.enraged,
      raiders: nearbyRaiders(f)
    })
  }

  /** Tear down the live fight (wipe/flee/dispose). `_kept` is unused today. */
  function endFight(_kept: boolean): void {
    const f = fight
    if (!f) return
    f.rig.group.removeFromParent()
    f.rig.dispose()
    for (const a of f.adds) a.dispose()
    f.adds.length = 0
    f.pending.length = 0
    fight = null
    ui.setBarVisible(false)
  }

  raf = requestAnimationFrame(tick)

  // -------------------------------------------------------------------------
  // Module handle
  // -------------------------------------------------------------------------

  inited = {
    setMobRigSource(fn) { mobRigFn = fn },
    setStatsSource(fn) { statsFn = fn },
    setSkillsSource(fn) { skillsFn = fn },
    setModifierSource(fn) { modFn = fn },
    setInventory(inv) { inventory = inv },
    setPlayerDamage(fn) { playerDamageFn = fn },
    setPlayerDeath(fn) { playerDeathFn = fn },
    setAttackTrigger(fn) { attackTriggerFn = fn },
    setPresenceSource(fn) { presenceFn = fn },
    onPlayerStrike,
    active() { return fight !== null },
    dispose() {
      cancelAnimationFrame(raf)
      if (fight) endFight(false)
      world.isBlocked = prevIsBlocked
      for (const a of altars.values()) a.dispose()
      altars.clear()
      fx.dispose()
      ui.dispose()
      inited = null
    }
  }
  return inited
}
