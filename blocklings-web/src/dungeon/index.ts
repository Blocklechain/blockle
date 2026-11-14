/**
 * Trial of the Deep — repeatable wave-survival dungeon (core).
 *
 * ARENA APPROACH (the simplest safe instancing). The world is one always-
 * resident scene; waystones "teleport" the player by writing api.player.pos.
 * We do the same: on entry we remember where the player stood, then move them
 * to a self-contained voxel arena built FRESH at a far, OUT-OF-WORLD centre
 * (3000,3000). Two facts make that safe and self-contained:
 *   1. The world collision grid reports everything outside |x|,|z|<720 as
 *      blocked, and the open-world combat spawner bails wherever regionAt is
 *      null (both true out there) — so no wild mobs spawn in the arena and
 *      far-away mobs despawn. The continent is 1280+ units away: beyond the
 *      camera far-plane and fully fogged, so the player sees ONLY the arena.
 *   2. We wrap api.world.isBlocked ONCE at init with a pass-through that only
 *      diverts to the arena's own walls while a run is live (arena != null);
 *      idle, it is byte-identical to the original. The player module calls
 *      world.isBlocked live each frame, so this gives the arena real walls and
 *      a walkable floor without ever mutating the shared collision grid.
 * On exit we null the arena (collision reverts), dispose the room + mobs, and
 * write the player back to the exact spot they entered from.
 *
 * Combat is REUSED structurally: mob VISUALS come from the open-world MobRig
 * (injected via setMobRigSource, exactly as pets consumes it), the damage
 * formula mirrors combat's, and the player's swing animation path is the
 * shared one (onAttack -> onPlayerStrike). Everything else — waves, AI, loot,
 * death/return — is self-contained here.
 *
 * Self-drives its own RAF tick (proximity + run loop), like waystones. Persists
 * per-tier bests, banked Deep Shards and cosmetics via the save registry
 * ('dungeon'). Emits 'dungeon:cleared', plus 'mob:hit'/'mob:killed'/'xp:gained'
 * so music, pets, achievements and quests react to arena fights too.
 */
import * as THREE from 'three'
import type { GameAPI } from '../types'
import { SPECIES, type SpeciesDef } from '../ids'
import { events } from '../events'
import { saveRegistry } from '../save/registry'
import { kitDungeonEntrance } from '../world/kit'
import { buildArena, type Arena } from './arena'
import { DungeonMob, type MobRigLike } from './mob'
import {
  TIERS, planWave, mobStats, waveRewards, tierUnlocked,
  BREATHER_SECS, INTRO_SECS, type TierDef, type WavePlan
} from './waves'
import * as flavor from './flavor'
import { DungeonUI, type TierRow } from './ui'

// ---------------------------------------------------------------------------
// Public contract (integrator-wired setters; mirrors combat's wiring)
// ---------------------------------------------------------------------------

export interface DungeonStats {
  atk: number
  def: number
  str: number
  int: number
  agi: number
}

export interface DungeonModule {
  /** Build a mob rig (integrator passes combat's MobRig; pets wires the same). */
  setMobRigSource(fn: (species: string, boss: boolean) => MobRigLike | null): void
  /** Equipped-gear stats (integrator passes inventory.equippedStats). */
  setStatsSource(fn: () => DungeonStats): void
  /** Skill levels (integrator passes skills.level). */
  setSkillsSource(fn: (skill: string) => number): void
  /** Skill-tree combat modifiers (integrator passes skillTree.modifier). */
  setModifierSource(fn: (key: string) => number): void
  /** Grant rewards (integrator passes the inventory module — the ONLY mutator). */
  setInventory(inv: { add: (id: string, qty: number, source?: string) => void; count: (id: string) => number }): void
  /** Apply mob damage to the player (integrator: hp mutate + hurt flash). */
  setPlayerDamage(fn: (amount: number, from: string) => void): void
  /** Player death animation (integrator: (onDown)=>playerDie(onDown)). */
  setPlayerDeath(fn: (onDown: (revive: () => void) => void) => void): void
  /** Swing-animation trigger for arena auto-attack (integrator: triggerAttack). */
  setAttackTrigger(fn: () => void): void
  /** Strike frame — integrator wires onAttack(() => dungeon.onPlayerStrike()). */
  onPlayerStrike(): void
  /** True while a run or its enter/exit transition is in flight. */
  active(): boolean
  /** Banked Deep Shards (a gear-upgrade material; never a currency). */
  dispose(): void
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const ARENA_CENTER = new THREE.Vector3(3000, 0, 3000) // far out-of-world
const ENTRANCE = new THREE.Vector3(-150, 0, 196) // in the Ashen Dungeons region
const USE_RANGE = 3.0
const STRIKE_RANGE = 2.2
const STRIKE_ARC = Math.PI / 4 // ±45°
const AUTO_SWING_CD = 0.8 // s between forgiving auto-attacks when swarmed

type Phase = 'idle' | 'enter' | 'intro' | 'wave' | 'breather' | 'exit'

interface DungeonSave {
  v: 1
  best: number[]
  cosmetics: string[]
}

let inited: DungeonModule | null = null

export function initDungeon(api: GameAPI): DungeonModule {
  if (inited) return inited

  const { scene, player, world } = api
  const uiMount = document.getElementById('ui') ?? document.body
  const rng = (): number => Math.random()
  const speciesById = new Map(SPECIES.map((s) => [s.id, s]))

  // --- injected sources -----------------------------------------------------
  let mobRigFn: ((species: string, boss: boolean) => MobRigLike | null) | null = null
  let statsFn: (() => DungeonStats) | null = null
  let skillsFn: ((skill: string) => number) | null = null
  let modFn: ((key: string) => number) | null = null
  let inventory: { add: (id: string, qty: number, source?: string) => void; count: (id: string) => number } | null = null
  let playerDamageFn: ((amount: number, from: string) => void) | null = null
  let playerDeathFn: ((onDown: (revive: () => void) => void) => void) | null = null
  let attackTriggerFn: (() => void) | null = null
  const mod = (key: string): number => modFn?.(key) ?? 0

  // --- persistent state -----------------------------------------------------
  const best: number[] = TIERS.map(() => 0)
  const cosmetics = new Set<string>()

  saveRegistry.register('dungeon', {
    dump: (): DungeonSave => ({ v: 1, best: [...best], cosmetics: [...cosmetics] }),
    load: (data: unknown): void => {
      const d = data as Partial<DungeonSave> | null
      if (!d || typeof d !== 'object') return
      if (Array.isArray(d.best)) {
        for (let i = 0; i < best.length; i++) {
          const v = d.best[i]
          best[i] = typeof v === 'number' && v >= 0 ? Math.floor(v) : 0
        }
      }
      cosmetics.clear()
      if (Array.isArray(d.cosmetics)) {
        for (const c of d.cosmetics) if (typeof c === 'string') cosmetics.add(c)
      }
    }
  })

  // --- entrance prop (placed by us, like waystones place their monoliths) ---
  const entranceGroup = kitDungeonEntrance()
  entranceGroup.position.set(ENTRANCE.x, world.groundHeight(ENTRANCE.x, ENTRANCE.z), ENTRANCE.z)
  scene.add(entranceGroup)

  // --- collision override (installed once; diverts only while in a run) -----
  const origIsBlocked = world.isBlocked.bind(world)
  world.isBlocked = (x: number, z: number): boolean =>
    arena ? arena.isBlocked(x, z) : origIsBlocked(x, z)

  // --- UI -------------------------------------------------------------------
  const ui = new DungeonUI(uiMount)
  ui.onEnter = () => openPicker()
  ui.onPickTier = (id) => void enterRun(id)
  ui.onFlee = () => endRun('flee')

  // --- run state ------------------------------------------------------------
  let phase: Phase = 'idle'
  let arena: Arena | null = null
  let tier: TierDef = TIERS[0]!
  let waveNum = 0
  let score = 0
  let runShards = 0
  const mobs: DungeonMob[] = []
  let timer = 0
  const entryReturn = new THREE.Vector3()
  let playerDead = false
  let nextAutoSwing = 0

  // -------------------------------------------------------------------------
  // Difficulty picker
  // -------------------------------------------------------------------------

  function openPicker(): void {
    if (phase !== 'idle') return
    const rows: TierRow[] = TIERS.map((t) => {
      const unlocked = tierUnlocked(best, t.id)
      const prev = TIERS[t.id - 1]
      return {
        id: t.id,
        name: t.name,
        blurb: t.blurb,
        best: best[t.id] ?? 0,
        unlocked,
        unlockHint: prev ? `clear wave ${t.unlockBestPrev} on ${prev.name}` : ''
      }
    })
    ui.setEnterVisible(false)
    ui.openPicker(rows, inventory?.count('crystal_shard') ?? 0)
  }

  // -------------------------------------------------------------------------
  // Enter / exit transitions (fade like the waystone veil)
  // -------------------------------------------------------------------------

  async function enterRun(tierId: number): Promise<void> {
    if (phase !== 'idle') return
    const t = TIERS[tierId]
    if (!t || !tierUnlocked(best, tierId)) return
    phase = 'enter'
    tier = t
    ui.closeModal()
    await ui.fade(true)

    entryReturn.copy(player.pos)
    arena = buildArena(ARENA_CENTER, t.id)
    scene.add(arena.group)
    player.pos.set(ARENA_CENTER.x, 0, ARENA_CENTER.z)

    waveNum = 0
    score = 0
    runShards = 0
    playerDead = false
    nextAutoSwing = 0
    clearMobs()

    ui.setHudVisible(true)
    timer = INTRO_SECS
    phase = 'intro'
    updateHud(`Descending… Wave 1 in ${Math.ceil(timer)}s`)
    events.emit('chat:system', { text: flavor.enterLine(rng) })
    await ui.fade(false)
  }

  function endRun(reason: 'death' | 'flee', revive?: () => void): void {
    if (phase === 'idle' || phase === 'enter' || phase === 'exit') {
      // death may arrive once; ignore re-entry
      if (!(reason === 'death' && phase !== 'exit')) return
    }
    phase = 'exit'
    const clearedWave = score
    const prevBest = best[tier.id] ?? 0
    const newBest = clearedWave > prevBest
    if (newBest) best[tier.id] = clearedWave
    const finalBest = best[tier.id] ?? 0
    grantCosmetics(clearedWave)

    events.emit('dungeon:cleared', {
      tier: tier.id,
      tierName: tier.name,
      waves: clearedWave,
      best: finalBest,
      newBest,
      shards: runShards
    })
    events.emit('chat:system', {
      text: reason === 'death' ? flavor.deathLine(rng) : flavor.fleeLine(rng)
    })
    events.emit('save:dirty', { why: 'dungeon run ended' })

    void (async () => {
      await ui.fade(true)
      clearMobs()
      arena?.dispose()
      arena = null // collision override reverts to the real world here
      player.pos.copy(entryReturn)
      player.hp = Math.max(1, player.hp)
      if (reason === 'death') player.hp = player.maxHp
      ui.setHudVisible(false)
      phase = 'idle'
      revive?.()
      await ui.fade(false)
      await ui.summary({
        tierName: tier.name,
        waves: clearedWave,
        best: finalBest,
        newBest,
        shards: runShards
      })
    })()
  }

  function grantCosmetics(clearedWave: number): void {
    const t = tier
    if (clearedWave >= t.clearWave && !cosmetics.has(t.capeId)) {
      cosmetics.add(t.capeId)
      cosmetics.add(`title_${t.id}`)
      events.emit('chat:system', { text: flavor.cosmeticLine(t.title) })
    }
  }

  // -------------------------------------------------------------------------
  // Waves
  // -------------------------------------------------------------------------

  function clearMobs(): void {
    for (const m of mobs) m.dispose()
    mobs.length = 0
  }

  function eligibleSpecies(cap: number): SpeciesDef[] {
    const e = SPECIES.filter((s) => s.tier <= cap)
    return e.length > 0 ? e : [SPECIES[0]!]
  }

  function pickSpecies(cap: number): SpeciesDef {
    const e = eligibleSpecies(cap)
    return e[Math.floor(rng() * e.length)] ?? e[0]!
  }

  function pickTough(cap: number): SpeciesDef {
    const e = eligibleSpecies(cap)
    const maxT = e.reduce((mx, s) => Math.max(mx, s.tier), 0)
    const top = e.filter((s) => s.tier === maxT)
    return top[Math.floor(rng() * top.length)] ?? e[0]!
  }

  function startWave(n: number): void {
    if (!arena) return
    waveNum = n
    const plan = planWave(tier, n)
    spawnWave(plan)
    phase = 'wave'
    const line =
      plan.kind === 'boss' ? flavor.bossLine(rng)
        : plan.kind === 'mini' ? flavor.miniLine(rng)
          : flavor.waveQuip(rng)
    updateHud(line)
    events.emit('chat:system', { text: `Wave ${n}: ${line}` })
  }

  function spawnWave(plan: WavePlan): void {
    if (!arena) return
    for (let i = 0; i < plan.count; i++) {
      const isChamp = plan.champLevel > 0 && i === 0
      const boss = isChamp
      let sp: SpeciesDef
      if (isChamp && plan.kind === 'boss') sp = speciesById.get('skeleton') ?? pickTough(plan.speciesTierCap)
      else if (isChamp) sp = pickTough(plan.speciesTierCap)
      else sp = pickSpecies(plan.speciesTierCap)
      const level = isChamp ? plan.champLevel : plan.mobLevel
      const rig = mobRigFn?.(sp.id, boss) ?? null
      if (!rig) continue
      const stats = mobStats(level, boss, tier.dmgMul)
      const sp2 = arena.spawnPoint(rng)
      const m = new DungeonMob({
        rig,
        species: sp,
        level,
        boss,
        maxHp: stats.maxHp,
        atk: stats.atk,
        x: sp2.x,
        z: sp2.z,
        centerX: ARENA_CENTER.x,
        centerZ: ARENA_CENTER.z,
        half: arena.half,
        bossId: isChamp && plan.kind === 'boss' ? 'boss_ashen' : null
      })
      m.addToScene(scene)
      mobs.push(m)
    }
  }

  function aliveCount(): number {
    let n = 0
    for (const m of mobs) if (m.alive) n++
    return n
  }

  function onWaveCleared(): void {
    score = waveNum
    bankRewards()
    const prevBest = best[tier.id] ?? 0
    if (score > prevBest) {
      best[tier.id] = score
      events.emit('save:dirty', { why: 'dungeon best' })
    }
    phase = 'breather'
    timer = BREATHER_SECS
    updateHud(`Breather — Wave ${waveNum + 1} in ${Math.ceil(timer)}s`)
  }

  function bankRewards(): void {
    const plan = planWave(tier, waveNum)
    const { shards, items } = waveRewards(tier, plan, rng)
    runShards += shards
    // Crystal Shards are a real inventory material (the Anvil of Ascension
    // consumes them) — never a banked soft-currency counter.
    if (shards > 0) inventory?.add('crystal_shard', shards, 'loot')
    for (const it of items) inventory?.add(it.id, it.qty, 'loot')
    ui.toast(`Wave ${waveNum} cleared — +${shards} Crystal Shards`)
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

  function onPlayerStrike(): void {
    if (phase !== 'wave' || playerDead) return
    const fx = Math.sin(player.facing)
    const fz = Math.cos(player.facing)
    const baseAng = Math.atan2(fx, fz)
    for (const m of [...mobs]) {
      if (!m.alive) continue
      const dx = m.x - player.pos.x
      const dz = m.z - player.pos.z
      const dist = Math.hypot(dx, dz)
      if (dist > STRIKE_RANGE + m.radius) continue
      let diff = Math.atan2(dx, dz) - baseAng
      while (diff > Math.PI) diff -= Math.PI * 2
      while (diff < -Math.PI) diff += Math.PI * 2
      if (Math.abs(diff) > STRIKE_ARC && dist > m.radius + 0.5) continue

      const { dmg, crit } = strikeDamage()
      m.takeHit(dmg)
      const hitPos = new THREE.Vector3(m.x, m.rig.height * 0.5, m.z)
      events.emit('mob:hit', {
        species: m.species,
        amount: dmg,
        crit,
        pos: hitPos,
        boss: m.boss,
        ...(m.bossId !== null ? { bossId: m.bossId } : {})
      })
      if (!m.alive) killMob(m)
    }
  }

  function killMob(m: DungeonMob): void {
    const pos = new THREE.Vector3(m.x, 0, m.z)
    events.emit('mob:killed', {
      species: m.species,
      level: m.level,
      pos,
      ...(m.boss ? { boss: true } : {})
    })
    const mult = m.boss ? 5 : 1
    const attackXp = Math.round((10 + m.level * 5) * mult)
    events.emit('xp:gained', { skill: 'attack', amount: attackXp })
    events.emit('xp:gained', { skill: 'vitality', amount: Math.ceil(attackXp * 0.4) })
    m.kill(() => {
      const i = mobs.indexOf(m)
      if (i >= 0) {
        mobs.splice(i, 1)
        m.dispose()
      }
    })
  }

  // -------------------------------------------------------------------------
  // Mob hits player + arena death
  // -------------------------------------------------------------------------

  function hurtPlayer(m: DungeonMob): void {
    if (playerDead) return
    const s = statsFn?.() ?? { atk: 0, def: 0, str: 0, int: 0, agi: 0 }
    const defLevel = skillsFn?.('defense') ?? 1
    const reduction = Math.min(0.75, s.def * 0.012 + (defLevel - 1) * 0.004 + mod('combat.defense'))
    const raw = m.atk * (0.85 + rng() * 0.3)
    const dealt = Math.max(1, Math.round(raw * (1 - reduction)))
    if (playerDamageFn) playerDamageFn(dealt, m.boss ? 'something enormous' : m.species)
    else player.hp = Math.max(0, player.hp - dealt)
    events.emit('player:damaged', { amount: dealt, from: m.species })
    if (player.hp <= 0) beginDeath()
  }

  function beginDeath(): void {
    if (playerDead) return
    playerDead = true
    events.emit('player:died', { at: player.pos.clone() })
    if (playerDeathFn) {
      playerDeathFn((revive) => endRun('death', revive))
    } else {
      window.setTimeout(() => endRun('death'), 1200)
    }
  }

  // -------------------------------------------------------------------------
  // Self-driven tick (proximity when idle + run loop)
  // -------------------------------------------------------------------------

  let last = performance.now()
  let raf = 0

  function tick(now: number): void {
    raf = requestAnimationFrame(tick)
    const dt = Math.min((now - last) / 1000, 0.1)
    last = now
    const nowS = now / 1000

    if (phase === 'idle') {
      const d = Math.hypot(player.pos.x - ENTRANCE.x, player.pos.z - ENTRANCE.z)
      ui.setEnterVisible(d <= USE_RANGE)
      return
    }
    if (phase === 'enter' || phase === 'exit') return

    // timers
    if (phase === 'intro') {
      timer -= dt
      updateHud(`Descending… Wave 1 in ${Math.max(0, Math.ceil(timer))}s`)
      if (timer <= 0) startWave(1)
    } else if (phase === 'breather') {
      timer -= dt
      updateHud(`Breather — Wave ${waveNum + 1} in ${Math.max(0, Math.ceil(timer))}s`)
      if (timer <= 0) startWave(waveNum + 1)
    }

    // mob AI (runs during wave + breather so stragglers keep pressuring you)
    if (phase === 'wave' || phase === 'breather') {
      const px = player.pos.x
      const pz = player.pos.z
      for (const m of mobs) {
        m.update(dt, nowS, px, pz, !playerDead, hurtPlayer)
      }
    }

    if (phase === 'wave') {
      // forgiving auto-attack when a foe is in reach (keeps mobile playable)
      if (!playerDead && nowS >= nextAutoSwing && anyMobInReach()) {
        nextAutoSwing = nowS + AUTO_SWING_CD
        attackTriggerFn?.()
      }
      if (aliveCount() === 0) onWaveCleared()
    }

    refreshHudStats()
  }

  function anyMobInReach(): boolean {
    for (const m of mobs) {
      if (!m.alive) continue
      const d = Math.hypot(m.x - player.pos.x, m.z - player.pos.z)
      if (d <= STRIKE_RANGE + m.radius + 0.3) return true
    }
    return false
  }

  let hudLine = ''
  function updateHud(line: string): void {
    hudLine = line
    refreshHudStats()
  }
  function refreshHudStats(): void {
    ui.setHud({
      tierName: tier.name,
      wave: waveNum > 0 ? waveNum : 1,
      score,
      best: best[tier.id] ?? 0,
      mobs: aliveCount(),
      line: hudLine
    })
  }

  // --- E to enter when standing at the gate (desktop convenience) ----------
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'e' && e.key !== 'E') return
    const ae = document.activeElement
    if (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement) return
    if (phase !== 'idle') return
    const d = Math.hypot(player.pos.x - ENTRANCE.x, player.pos.z - ENTRANCE.z)
    if (d <= USE_RANGE) openPicker()
  }
  window.addEventListener('keydown', onKey)

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
    onPlayerStrike,
    active() { return phase !== 'idle' },
    dispose() {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
      clearMobs()
      arena?.dispose()
      arena = null
      world.isBlocked = origIsBlocked
      const d = entranceGroup.userData['dispose']
      entranceGroup.removeFromParent()
      if (typeof d === 'function') (d as () => void)()
      ui.dispose()
      inited = null
    }
  }
  return inited
}
