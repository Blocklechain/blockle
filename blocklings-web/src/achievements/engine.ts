/**
 * Achievements engine — counters, unlock logic, and the 'achv' save provider.
 *
 * Pure state machine: feature code (index.ts) feeds it bus events via the
 * note*() methods; it bumps counters, re-evaluates the catalog, and reports
 * fresh unlocks through the `onUnlock` callback (toast + chat + fanfare are
 * wired there, not here). Every mutation emits 'save:dirty' — the save
 * module debounces the writes.
 *
 * Persistence is intentionally tiny: counters, id-sets, unlock timestamps,
 * and a pruned per-uid mint-chain map (only uids still short of 3 chains).
 */
import { events } from '../events'
import { saveRegistry } from '../save/registry'
import { REGIONS, WAYSTONES } from '../ids'
import { ZONES } from '../world/zones/registry'
import { ACHIEVEMENTS, type AchDef, type AchStats } from './defs'

/** Gathering professions arrive via 'gather:done'. */
const GATHER_PROFS = new Set(['mining', 'woodcutting', 'fishing', 'farming', 'herbalism'])
/** Crafting professions arrive via 'xp:gained'. */
const CRAFT_PROFS = new Set(['blacksmithing', 'cooking', 'alchemy', 'tailoring'])

/** Home stone starts attuned and never fires 'waystone:attuned'. */
const HOME_STONE = 'ws_village'

/** Keep at most this many in-progress uid→chains entries in the save. */
const MINT_MAP_CAP = 40

/** All 96 valid zone ids: 6 heart regions + 90 wilderness zones. */
const VALID_ZONE_IDS: ReadonlySet<string> = new Set([
  ...REGIONS.map((r) => r.id),
  ...ZONES.map((z) => z.id),
])
const HEART_REGION_IDS: ReadonlySet<string> = new Set(REGIONS.map((r) => r.id))

/** 20 = 6 heart stones + 14 zone stones; exported for the panel's flex line. */
export const TOTAL_WAYSTONES = WAYSTONES.length + ZONES.filter((z) => z.waystone).length
export const TOTAL_ZONES = VALID_ZONE_IDS.size

interface AchSaveV1 {
  v: 1
  /** id -> unlock time (ms epoch). */
  u: Record<string, number>
  /** plain counters */
  c: Partial<Record<string, number>>
  /** id sets */
  s: Partial<Record<'regions' | 'zones' | 'stones' | 'prof' | 'boss', string[]>>
  /** uid -> chains minted (pruned; dropped once triChain unlocks). */
  mc: Record<string, string[]>
  /** current contract day + distinct slots done that day */
  cd: { d: string; n: number[] } | null
  /** last seen server GOLD balance (purchase detection baseline). */
  lg: number | null
  /** boolean flags */
  f: Partial<Record<'skill99' | 'petPrestige' | 'petBoss' | 'triChain', boolean>>
}

export interface AchEngine {
  stats(): AchStats
  unlockedAt(id: string): number | undefined
  unlockedCount(): number
  /** Set by index.ts before any events can arrive. */
  onUnlock: ((def: AchDef) => void) | null

  noteKill(species: string, boss: boolean): void
  noteDeath(): void
  noteRegion(regionId: string): void
  noteAttune(stoneId: string): void
  noteTravel(): void
  noteGather(skill: string): void
  noteXp(skill: string): void
  noteLevel(level: number): void
  noteMint(uid: string, chain: string): void
  noteSale(): void
  noteGold(balance: number): void
  notePet(variant: string): void
  noteQuestDone(questId: string): void
  noteChat(): void
  noteWho(): void
}

export function createEngine(): AchEngine {
  // ---- live state ---------------------------------------------------------
  const unlocked = new Map<string, number>()
  const counters = {
    kills: 0, deaths: 0, sales: 0, goldBuys: 0, pets: 0,
    chats: 0, who: 0, quests: 0, mints: 0, travels: 0, contractsBestDay: 0,
  }
  const regions = new Set<string>()
  const zones = new Set<string>()
  const stones = new Set<string>([HOME_STONE])
  const prof = new Set<string>()
  const boss = new Set<string>()
  let mintChains = new Map<string, Set<string>>()
  let contractDay: { d: string; n: Set<number> } | null = null
  let lastGold: number | null = null
  const flags = { skill99: false, petPrestige: false, petBoss: false, triChain: false }

  const stats = (): AchStats => ({
    ...counters,
    regions, zones, stones, prof, boss,
    triChain: flags.triChain,
    skill99: flags.skill99,
    petPrestige: flags.petPrestige,
    petBoss: flags.petBoss,
  })

  // ---- unlock evaluation --------------------------------------------------
  const engine: AchEngine = {
    stats,
    unlockedAt: (id) => unlocked.get(id),
    unlockedCount: () => unlocked.size,
    onUnlock: null,

    noteKill(species, isBoss) {
      counters.kills++
      if (isBoss) boss.add(species)
      changed('kill')
    },
    noteDeath() {
      counters.deaths++
      changed('death')
    },
    noteRegion(regionId) {
      if (!VALID_ZONE_IDS.has(regionId)) return
      const before = zones.size + regions.size
      zones.add(regionId)
      if (HEART_REGION_IDS.has(regionId)) regions.add(regionId)
      if (zones.size + regions.size !== before) changed('region')
    },
    noteAttune(stoneId) {
      if (stones.has(stoneId)) return
      stones.add(stoneId)
      changed('attune')
    },
    noteTravel() {
      counters.travels++
      if (counters.travels <= 2) changed('travel') // only the first matters
    },
    noteGather(skill) {
      if (!GATHER_PROFS.has(skill) || prof.has(skill)) return
      prof.add(skill)
      changed('gather')
    },
    noteXp(skill) {
      if (!CRAFT_PROFS.has(skill) || prof.has(skill)) return
      prof.add(skill)
      changed('craft')
    },
    noteLevel(level) {
      if (level < 99 || flags.skill99) return
      flags.skill99 = true
      changed('skill99')
    },
    noteMint(uid, chain) {
      counters.mints++
      if (!flags.triChain) {
        let set = mintChains.get(uid)
        if (!set) {
          set = new Set()
          mintChains.set(uid, set)
        }
        set.add(chain)
        if (set.size >= 3) {
          flags.triChain = true
          mintChains = new Map() // job done — stop carrying the map
        } else if (mintChains.size > MINT_MAP_CAP) {
          // prune the oldest insertion to keep the save small
          const first = mintChains.keys().next()
          if (!first.done) mintChains.delete(first.value)
        }
      }
      changed('mint')
    },
    noteSale() {
      counters.sales++
      changed('sale')
    },
    noteGold(balance) {
      if (lastGold !== null && balance > lastGold) {
        counters.goldBuys++
        lastGold = balance
        changed('gold')
        return
      }
      if (lastGold !== balance) {
        lastGold = balance
        emitDirty('gold-baseline')
      }
    },
    notePet(variant) {
      counters.pets++
      if (variant === 'golden' || variant === 'shadow') flags.petPrestige = true
      if (variant === 'boss') flags.petBoss = true
      changed('pet')
    },
    noteQuestDone(questId) {
      counters.quests++
      // contract ids: 'contract:<date>:<slot>'
      if (questId.startsWith('contract:')) {
        const parts = questId.split(':')
        const day = parts[1] ?? ''
        const slot = Number(parts[2])
        if (day && Number.isFinite(slot)) {
          if (!contractDay || contractDay.d !== day) contractDay = { d: day, n: new Set() }
          contractDay.n.add(slot)
          if (contractDay.n.size > counters.contractsBestDay) {
            counters.contractsBestDay = contractDay.n.size
          }
        }
      }
      changed('quest')
    },
    noteChat() {
      counters.chats++
      if (counters.chats <= 2) changed('chat')
      // later chats are not persistence-worthy — skip the save churn
    },
    noteWho() {
      counters.who++
      if (counters.who <= 6) changed('who')
    },
  }

  function evaluate(silent: boolean): void {
    const st = stats()
    for (const def of ACHIEVEMENTS) {
      if (unlocked.has(def.id)) continue
      if (def.progress(st) >= def.goal) {
        unlocked.set(def.id, Date.now())
        if (!silent) engine.onUnlock?.(def)
      }
    }
  }

  function emitDirty(why: string): void {
    events.emit('save:dirty', { why: `achv:${why}` })
  }

  /** Any persistent stat changed: re-evaluate, then mark the save dirty. */
  function changed(why: string): void {
    evaluate(false)
    emitDirty(why)
  }

  // ---- save provider ------------------------------------------------------
  saveRegistry.register('achv', {
    dump(): unknown {
      const out: AchSaveV1 = {
        v: 1,
        u: Object.fromEntries(unlocked),
        c: { ...counters },
        s: {
          regions: [...regions],
          zones: [...zones],
          stones: [...stones],
          prof: [...prof],
          boss: [...boss],
        },
        mc: Object.fromEntries([...mintChains].map(([k, v]) => [k, [...v]])),
        cd: contractDay ? { d: contractDay.d, n: [...contractDay.n] } : null,
        lg: lastGold,
        f: { ...flags },
      }
      return out
    },
    load(data: unknown): void {
      if (!data || typeof data !== 'object') return
      const d = data as Partial<AchSaveV1>
      unlocked.clear()
      if (d.u && typeof d.u === 'object') {
        for (const [id, t] of Object.entries(d.u)) {
          if (typeof t === 'number') unlocked.set(id, t)
        }
      }
      if (d.c && typeof d.c === 'object') {
        for (const key of Object.keys(counters) as (keyof typeof counters)[]) {
          const v = d.c[key]
          if (typeof v === 'number' && Number.isFinite(v) && v >= 0) counters[key] = v
        }
      }
      const loadSet = (dst: Set<string>, src: unknown, seed?: string): void => {
        dst.clear()
        if (seed) dst.add(seed)
        if (Array.isArray(src)) for (const v of src) if (typeof v === 'string') dst.add(v)
      }
      loadSet(regions, d.s?.regions)
      loadSet(zones, d.s?.zones)
      loadSet(stones, d.s?.stones, HOME_STONE)
      loadSet(prof, d.s?.prof)
      loadSet(boss, d.s?.boss)
      mintChains = new Map()
      if (d.mc && typeof d.mc === 'object') {
        for (const [uid, chains] of Object.entries(d.mc)) {
          if (Array.isArray(chains)) {
            mintChains.set(uid, new Set(chains.filter((c): c is string => typeof c === 'string')))
          }
        }
      }
      contractDay = null
      if (d.cd && typeof d.cd === 'object' && typeof d.cd.d === 'string' && Array.isArray(d.cd.n)) {
        contractDay = { d: d.cd.d, n: new Set(d.cd.n.filter((n): n is number => typeof n === 'number')) }
      }
      lastGold = typeof d.lg === 'number' ? d.lg : null
      if (d.f && typeof d.f === 'object') {
        flags.skill99 = d.f.skill99 === true
        flags.petPrestige = d.f.petPrestige === true
        flags.petBoss = d.f.petBoss === true
        flags.triChain = d.f.triChain === true
      }
      // Old saves whose counters already cross a newly-added bar unlock
      // quietly — a 3-second banner about ancient history helps no one.
      evaluate(true)
    },
  })

  return engine
}
