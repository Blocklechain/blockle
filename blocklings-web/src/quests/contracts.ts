/**
 * Contracts — the repeatable daily job board.
 *
 * Six postings rotate every CST day, generated DETERMINISTICALLY from the
 * CST date + the combat band the player was in when the day's board was first
 * papered (band is frozen into the save so reloads regenerate byte-identical
 * defs). Slots 0-2: kill contracts (species + count scaled to the band),
 * slots 3-4: gather contracts (node kinds), slot 5: a bounty — travel to a
 * named outer zone, then put down its signature problem.
 *
 * Contracts are QuestDef-shaped (`repeatable: true`, ids 'contract:<date>:<n>')
 * and progress through the exact same bus events the quest engine uses
 * ('mob:killed' / 'gather:done' / 'region:entered'). Up to 3 accepted at once;
 * rewards are items + xp only (economy law), tuned ~1.2x the equivalent
 * one-off quests; completions reset at the next CST midnight. Persists via its
 * own 'contracts' save provider — an additive key in the character save blob.
 *
 * Board UI lives in ./board (a 'Contracts' entry injected into the quest log).
 * Registered from ./index via appended glue: `installContracts()`.
 */
import type { QuestDef, QuestStep } from '../types'
import { events } from '../events'
import { saveRegistry } from '../save/registry'
import { NODE_KINDS, SPECIES } from '../ids'
import { ITEM_NAMES } from './defs'
import { createBoard, type Board } from './board'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContractDef extends QuestDef {
  repeatable: true
  /** Board slot 0..5 (5 = the bounty). */
  slot: number
  job: 'kill' | 'gather' | 'bounty'
  /** Display name of whoever pinned the notice (comedy is load-bearing). */
  postedBy: string
}

export type ContractState =
  | { state: 'open'; step: 0; done: 0 }
  | { state: 'active'; step: number; done: number }
  | { state: 'done'; step: number; done: number }

export interface ContractsAPI {
  /** Today's six postings, slot order. */
  today(): readonly ContractDef[]
  status(id: string): ContractState
  /** Accept a posting (max 3 active). False if full/taken/finished. */
  accept(id: string): boolean
  /** Drop an active contract (progress is lost; the board judges silently). */
  abandon(id: string): void
  activeCount(): number
  maxActive(): number
  /** Milliseconds until the CST-midnight reroll. */
  resetsInMs(): number
}

const MAX_ACTIVE = 3
const CST_OFFSET_MS = 6 * 3_600_000 // fixed UTC-6, no DST — deterministic

// ---------------------------------------------------------------------------
// Deterministic daily RNG
// ---------------------------------------------------------------------------

function cstDay(now = Date.now()): string {
  return new Date(now - CST_OFFSET_MS).toISOString().slice(0, 10)
}

function msUntilNextCstDay(now = Date.now()): number {
  const shifted = now - CST_OFFSET_MS
  return 86_400_000 - (((shifted % 86_400_000) + 86_400_000) % 86_400_000)
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** rng int in [lo, hi] inclusive. */
function rint(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1))
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!
}

function shuffled<T>(rng: () => number, arr: readonly T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

// ---------------------------------------------------------------------------
// Content tables (ids verified against src/ids.ts + the quest book's
// catalog-verified ITEM_NAMES; zone ids/names verified against
// src/world/zones/registry.ts — carried here, not imported, same precedent
// as ITEM_NAMES vs the items module)
// ---------------------------------------------------------------------------

type Band = 1 | 2 | 3 | 4

const PLURAL: Readonly<Record<string, string>> = {
  slime: 'Slimes',
  mushroom: 'Shroomlings',
  crab: 'Pebble Crabs',
  wolf: 'Wolves',
  goblin: 'Goblins',
  bat: 'Cave Bats',
  spider: 'Spiders',
  bandit: 'Bandits',
  skeleton: 'Skeletons',
  imp: 'Ember Imps',
  golem: 'Stone Golems',
  orc: 'Orcs',
  wisp: 'Grave Wisps',
}

function speciesOfTier(tier: 1 | 2 | 3 | 4): string[] {
  return SPECIES.filter((s) => s.tier === tier).map((s) => s.id)
}

/** Zone venues for the daily bounty, by band ('region:entered' fires zone ids). */
const VENUES: Readonly<Record<Band, readonly { id: string; name: string }[]>> = {
  1: [
    { id: 'bracing_pines', name: 'The Bracing Pines' },
    { id: 'rumbling_foothills', name: 'The Rumbling Foothills' },
    { id: 'kings_back_lawn', name: "The King's Back Lawn" },
    { id: 'tanglewilds', name: 'The Tanglewilds' },
    { id: 'whistlewood', name: 'Whistlewood' },
    { id: 'ironvein_hollow', name: 'Ironvein Hollow' },
    { id: 'heartwood_hollow', name: 'Heartwood Hollow' },
  ],
  2: [
    { id: 'greenwood_heights', name: 'Greenwood Heights' },
    { id: 'scrublands', name: 'The Scrublands' },
    { id: 'tombstone_flats', name: 'Tombstone Flats' },
    { id: 'upper_ironhold', name: 'Upper Ironhold' },
    { id: 'forgottener_lands', name: 'The Forgotten-er Lands' },
    { id: 'gravely_serious', name: 'Gravely Serious' },
  ],
  3: [
    { id: 'char_beyond', name: 'The Char Beyond' },
    { id: 'catacombs_of_moist', name: 'The Catacombs of Moist' },
    { id: 'vulture_veranda', name: 'Vulture Veranda' },
    { id: 'boulderdash', name: 'Boulderdash Basin' },
    { id: 'oakzilla_grove', name: 'Oakzilla Grove' },
  ],
  4: [
    { id: 'glimmer_gulch', name: 'The Glimmer Gulch' },
    { id: 'avalanche_alley', name: 'Avalanche Alley' },
    { id: 'funguy_hills', name: 'The Funguy Hills' },
    { id: 'overgrown_opus', name: 'The Overgrown Opus' },
    { id: 'sporeburb', name: 'Sporeburb' },
    { id: 'dustbowl_diner', name: 'Dustbowl Diner' },
    { id: 'gorge_yourself', name: 'Gorge Yourself' },
  ],
}

/** Gather node pools per band (ids from NODE_KINDS). */
const GATHER_POOLS: Readonly<Record<Band, readonly string[]>> = {
  1: ['oak_tree', 'herb_patch', 'farm_plot', 'fishing_spot', 'berry_bush', 'copper_vein'],
  2: ['oak_tree', 'pine_tree', 'iron_vein', 'mushroom_cluster', 'clay_pit', 'herb_patch', 'fishing_spot'],
  3: ['pine_tree', 'iron_vein', 'gold_vein', 'mushroom_cluster', 'clay_pit', 'fishing_spot'],
  4: ['gold_vein', 'crystal_node', 'pine_tree', 'iron_vein', 'mushroom_cluster'],
}

/** Item payouts per band (each option is one items[] bundle; catalog-verified ids). */
const LOOT: Readonly<Record<Band, readonly (readonly [string, number][])[]>> = {
  1: [
    [['potion_hp_small', 2]],
    [['food_bread', 3]],
    [['food_skewer', 2]],
    [['food_cheese', 2], ['food_bread', 1]],
  ],
  2: [
    [['potion_hp_med', 2]],
    [['food_stew', 2]],
    [['potion_mystery', 1], ['food_bread', 2]],
    [['food_pie', 2]],
  ],
  3: [
    [['potion_hp_large', 2]],
    [['bar_iron', 2]],
    [['food_pie', 2], ['potion_hp_med', 1]],
    [['potion_mp_large', 1], ['food_stew', 2]],
  ],
  4: [
    [['potion_hp_large', 3]],
    [['food_kebab', 3], ['potion_hp_large', 1]],
    [['crystal_shard', 1]],
    [['food_cake', 2], ['potion_hp_large', 1]],
  ],
}

/** XP per kill by species tier (~1.2x the quest book's going rate). */
const KILL_XP_RATE = [0, 16, 30, 62, 100] as const

const POSTERS = [
  'Elder Rowan',
  'Farmer Bram',
  'Guard Tomas',
  'Merchant Hilda',
  'Scout Wren',
  'Foreman Dagna',
  'Banker Aldous',
  'Gravekeeper Sol',
  'Hermit Vex',
  'Someone Anonymous (it was Dave)',
] as const

const KILL_TITLES: readonly ((n: number, p: string) => string)[] = [
  (n, p) => `WANTED: ${n} ${p}. Reason: personal.`,
  (n, p) => `WANTED: ${n} ${p}. They know what they did.`,
  (n, p) => `PEST CONTROL: ${n} ${p}. The situation has escalated.`,
  (n, p) => `HELP WANTED: make ${n} ${p} stop existing.`,
  (n, p) => `URGENT: ${n} ${p}. The committee has voted.`,
]

const KILL_POSTS = [
  'They ate my fence. Then they ate my spare fence. I am down to zero fences.',
  'I waved politely. They did not wave politely. You see where this is going.',
  'Payment on delivery of proof. Proof format negotiable. Washable preferred.',
  'This is the third notice. The first two were eaten, which proves my point.',
  'No questions asked. I tried asking questions. It made everything worse.',
  'My therapist says closure is important. This is the closure.',
] as const

const GATHER_TITLES: readonly ((n: number, name: string) => string)[] = [
  (n, name) => `SUPPLY RUN: ${name} ×${n}. Urgency: theatrical.`,
  (n, name) => `PROCUREMENT: ${name} ×${n}. Invoice lost on purpose.`,
  (n, name) => `MATERIALS NEEDED: ${name} ×${n}. For a project. A legal one.`,
  (n, name) => `HIRING: someone with arms. Task: ${name} ×${n}.`,
]

const GATHER_POSTS = [
  'The guild requires materials and refuses to say why. Standard arrangement.',
  'Will trade goods of equal or suspiciously greater value.',
  "I'd get it myself, but my back and I are no longer on speaking terms.",
  'Quality matters. Not a lot. But it matters.',
] as const

const BOUNTY_TITLES: readonly ((n: number, p: string, zone: string) => string)[] = [
  (n, p, zone) => `BOUNTY: ${n} ${p} in ${zone}. Make it mutual.`,
  (n, p, zone) => `BOUNTY: ${zone} reports ${n} ${p} too many.`,
  (n, p, zone) => `CROWN BOUNTY: ${n} ${p}. Last seen in ${zone}, acting smug.`,
]

const BOUNTY_POSTS = [
  'Locals report aggressive loitering. The Crown pays extra for distance work.',
  'Danger pay included. Dying voids the danger pay. Read the fine print.',
  'Whoever takes this: aim for the loud ones first. Trust me. — Management',
] as const

const OUTROS = [
  'Payment left under the board. Mind the splinters.',
  'The board accepts your proof and asks no follow-up questions.',
  'Pleasure doing business. The board remembers reliable people.',
  'Contract closed. The stain on the notice is unrelated.',
] as const

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

function bandOf(lv: number): Band {
  return lv <= 5 ? 1 : lv <= 12 ? 2 : lv <= 20 ? 3 : 4
}

function round5(x: number): number {
  return Math.max(5, Math.round(x / 5) * 5)
}

function mergeLoot(bundles: readonly (readonly [string, number])[]): { id: string; qty: number }[] {
  const acc = new Map<string, number>()
  for (const [id, qty] of bundles) acc.set(id, (acc.get(id) ?? 0) + qty)
  return [...acc].map(([id, qty]) => ({ id, qty }))
}

function nodeName(nodeId: string): string {
  return NODE_KINDS.find((n) => n.id === nodeId)?.name ?? nodeId
}

function speciesTier(id: string): 1 | 2 | 3 | 4 {
  return SPECIES.find((s) => s.id === id)?.tier ?? 1
}

/** Kill-pool for a band: mostly the band's headline tier plus one step down. */
function killPool(rng: () => number, band: Band): string[] {
  if (band === 1) return shuffled(rng, speciesOfTier(1))
  const top = band as 2 | 3 | 4
  return [
    ...shuffled(rng, speciesOfTier(top)).slice(0, 2),
    ...shuffled(rng, speciesOfTier((top - 1) as 1 | 2 | 3)).slice(0, 1),
  ]
}

export function generateDay(date: string, lv: number): ContractDef[] {
  const band = bandOf(lv)
  const rng = mulberry32(fnv1a(`blocklings:contracts:${date}:${band}`))
  const defs: ContractDef[] = []

  const killTargets = killPool(rng, band).slice(0, 3)

  // --- slots 0-2: kill contracts -----------------------------------------
  for (let slot = 0; slot < 3; slot++) {
    const sp = killTargets[slot]!
    const plural = PLURAL[sp] ?? `${sp}s`
    const tier = speciesTier(sp)
    const need = rint(rng, 7 + band, 13 + band)
    const total = need * KILL_XP_RATE[tier]
    defs.push({
      id: `contract:${date}:${slot}`,
      repeatable: true,
      slot,
      job: 'kill',
      title: pick(rng, KILL_TITLES)(need, plural),
      postedBy: pick(rng, POSTERS),
      giver: 'guard_tomas', // the board hangs by the gate; Tomas "administrates"
      regionId: 'beginnings',
      steps: [{ kind: 'kill', target: sp, need, label: `Defeat ${need} ${plural}` }],
      rewards: {
        xp: { attack: round5(total * 0.7), defense: round5(total * 0.3) },
        items: mergeLoot(pick(rng, LOOT[band])),
      },
      intro: pick(rng, KILL_POSTS),
      outro: pick(rng, OUTROS),
    })
  }

  // --- slots 3-4: gather contracts ---------------------------------------
  const nodes = shuffled(rng, GATHER_POOLS[band]).slice(0, 2)
  for (let i = 0; i < 2; i++) {
    const slot = 3 + i
    const nid = nodes[i]!
    const name = nodeName(nid)
    const skill = NODE_KINDS.find((n) => n.id === nid)?.skill ?? 'mining'
    const need = rint(rng, 6, 12)
    const perUnit = 19 + (band - 1) * 4
    defs.push({
      id: `contract:${date}:${slot}`,
      repeatable: true,
      slot,
      job: 'gather',
      title: pick(rng, GATHER_TITLES)(need, name),
      postedBy: pick(rng, POSTERS),
      giver: 'merchant_hilda',
      regionId: 'beginnings',
      steps: [{ kind: 'gather', target: nid, need, label: `Harvest ${need}× ${name}` }],
      rewards: {
        xp: { [skill]: round5(need * perUnit) },
        items: mergeLoot(pick(rng, LOOT[band])),
      },
      intro: pick(rng, GATHER_POSTS),
      outro: pick(rng, OUTROS),
    })
  }

  // --- slot 5: the bounty --------------------------------------------------
  const topTier = band === 1 ? 1 : (band as 2 | 3 | 4)
  const bountyCandidates = speciesOfTier(topTier).filter((s) => !killTargets.includes(s))
  const bountySp = pick(rng, bountyCandidates.length ? bountyCandidates : speciesOfTier(topTier))
  const bPlural = PLURAL[bountySp] ?? `${bountySp}s`
  const venue = pick(rng, VENUES[band])
  const bNeed = rint(rng, 7 + band, 13 + band) + 4
  const bTotal = bNeed * KILL_XP_RATE[speciesTier(bountySp)] * 1.3
  const bonus: readonly [string, number][] =
    band >= 4 ? [['crystal_shard', 2]] : band === 3 ? [['crystal_shard', 1]] : [['potion_mystery', 1]]
  const bountySteps: QuestStep[] = [
    { kind: 'explore', target: venue.id, need: 1, label: `Travel to ${venue.name}` },
    { kind: 'kill', target: bountySp, need: bNeed, label: `Defeat ${bNeed} ${bPlural}` },
  ]
  defs.push({
    id: `contract:${date}:5`,
    repeatable: true,
    slot: 5,
    job: 'bounty',
    title: pick(rng, BOUNTY_TITLES)(bNeed, bPlural, venue.name),
    postedBy: 'Captain Elara (the Crown pays)',
    giver: 'captain_elara',
    regionId: venue.id,
    steps: bountySteps,
    rewards: {
      xp: {
        attack: round5(bTotal * 0.6),
        defense: round5(bTotal * 0.25),
        vitality: round5(bTotal * 0.15),
      },
      items: mergeLoot([...pick(rng, LOOT[band]), ...bonus]),
    },
    intro: pick(rng, BOUNTY_POSTS),
    outro: pick(rng, OUTROS),
  })

  return defs
}

// ---------------------------------------------------------------------------
// Live engine (mirrors the quest engine's advance/complete machinery)
// ---------------------------------------------------------------------------

let day = ''
let dayLv = 1
let defs: ContractDef[] = []
const byId = new Map<string, ContractDef>()
const active = new Map<string, { step: number; done: number }>()
const doneToday = new Set<string>()
/** Lifetime best combat level seen via 'level:up' (attack/defense/magic/vitality). */
let bestCombat = 1
/** Highest-level mob ever killed (level proxy for restored old saves). */
let bestMobLv = 0
let lastRegion: string | null = null
let board: Board | null = null

function effectiveLv(): number {
  return Math.max(bestCombat, Math.ceil(bestMobLv * 0.75), 1)
}

function itemNameLocal(id: string): string {
  return (
    ITEM_NAMES[id] ??
    id
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
  )
}

export function contractRewardText(def: ContractDef): string {
  const bits: string[] = []
  if (def.rewards.xp) {
    for (const [skill, amount] of Object.entries(def.rewards.xp)) {
      if (typeof amount === 'number' && amount > 0) {
        bits.push(`${amount} ${skill.charAt(0).toUpperCase() + skill.slice(1)} XP`)
      }
    }
  }
  if (def.rewards.items) {
    for (const s of def.rewards.items) {
      bits.push(s.qty > 1 ? `${itemNameLocal(s.id)} ×${s.qty}` : itemNameLocal(s.id))
    }
  }
  return bits.join(', ')
}

function rebuild(): void {
  defs = generateDay(day, dayLv)
  byId.clear()
  for (const d of defs) byId.set(d.id, d)
}

/** Roll to today's board if the CST date changed. Returns true on a roll. */
function checkDay(): boolean {
  const d = cstDay()
  if (d === day) return false
  const firstBuild = day === ''
  day = d
  dayLv = effectiveLv()
  active.clear()
  doneToday.clear()
  rebuild()
  if (!firstBuild) {
    events.emit('chat:system', {
      text: 'The job board has been re-papered: six fresh postings, zero fresh respect.',
    })
    events.emit('save:dirty', { why: 'contracts:reroll' })
  }
  board?.refresh()
  return true
}

function completeContract(id: string, def: ContractDef): void {
  active.delete(id)
  doneToday.add(id)
  events.emit('quest:completed', { questId: id })

  const r = def.rewards
  if (r.items) for (const s of r.items) events.emit('item:gained', { id: s.id, qty: s.qty, source: 'quest' })
  if (r.xp) {
    for (const [skill, amount] of Object.entries(r.xp)) {
      if (typeof amount === 'number' && amount > 0) events.emit('xp:gained', { skill, amount })
    }
  }

  events.emit('chat:system', { text: `Contract fulfilled: "${def.title}"` })
  events.emit('chat:system', { text: def.outro })
  const summary = contractRewardText(def)
  if (summary) events.emit('chat:system', { text: `Payment: ${summary}` })

  events.emit('save:dirty', { why: `contract:complete:${id}` })
  board?.refresh()
  board?.celebrate()
}

function advanceContract(id: string, def: ContractDef, st: { step: number; done: number }, amount: number): void {
  const step = def.steps[st.step]
  if (!step) return
  st.done = Math.min(step.need, st.done + amount)
  events.emit('quest:progress', { questId: id, step: st.step, done: st.done, need: step.need })

  if (st.done >= step.need) {
    st.step += 1
    st.done = 0
    if (st.step >= def.steps.length) {
      completeContract(id, def)
      return
    }
    const next = def.steps[st.step]
    if (next) events.emit('chat:system', { text: `${def.title} — next: ${next.label}` })
    events.emit('save:dirty', { why: `contract:step:${id}` })
    board?.refresh()
    autoExploreContract(id)
    return
  }

  events.emit('save:dirty', { why: `contract:progress:${id}` })
  board?.refresh()
}

function autoExploreContract(id: string): void {
  const st = active.get(id)
  const def = byId.get(id)
  if (!st || !def) return
  const step = def.steps[st.step]
  if (step && step.kind === 'explore' && step.target === lastRegion) {
    advanceContract(id, def, st, step.need)
  }
}

function progressContracts(match: (step: QuestStep) => boolean, amount = 1): void {
  for (const [id, st] of [...active]) {
    const def = byId.get(id)
    if (!def) continue
    const step = def.steps[st.step]
    if (!step || !match(step)) continue
    advanceContract(id, def, st, amount)
  }
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export const contractsApi: ContractsAPI = {
  today(): readonly ContractDef[] {
    checkDay()
    return defs
  },

  status(id: string): ContractState {
    if (doneToday.has(id)) return { state: 'done', step: 0, done: 0 }
    const st = active.get(id)
    if (st) return { state: 'active', step: st.step, done: st.done }
    return { state: 'open', step: 0, done: 0 }
  },

  accept(id: string): boolean {
    checkDay()
    const def = byId.get(id)
    if (!def || active.has(id) || doneToday.has(id) || active.size >= MAX_ACTIVE) return false
    active.set(id, { step: 0, done: 0 })
    events.emit('quest:accepted', { questId: id })
    const first = def.steps[0]
    events.emit('chat:system', {
      text: `Contract taken: "${def.title}"${first ? ` — ${first.label}` : ''}`,
    })
    events.emit('save:dirty', { why: `contract:accept:${id}` })
    board?.refresh()
    autoExploreContract(id)
    return true
  },

  abandon(id: string): void {
    const def = byId.get(id)
    if (!active.delete(id)) return
    events.emit('chat:system', {
      text: `Contract abandoned: "${def?.title ?? id}". The board judges silently.`,
    })
    events.emit('save:dirty', { why: `contract:abandon:${id}` })
    board?.refresh()
  },

  activeCount(): number {
    return active.size
  },

  maxActive(): number {
    return MAX_ACTIVE
  },

  resetsInMs(): number {
    return msUntilNextCstDay()
  },
}

// ---------------------------------------------------------------------------
// Install (called once from ./index's appended glue)
// ---------------------------------------------------------------------------

let installed = false

export function installContracts(): ContractsAPI {
  if (installed) return contractsApi
  installed = true

  checkDay()

  // --- persistence: additive 'contracts' key in the character save blob ----
  saveRegistry.register('contracts', {
    dump(): {
      day: string
      lv: number
      best: number
      mob: number
      act: [string, number, number][]
      done: string[]
    } {
      return {
        day,
        lv: dayLv,
        best: bestCombat,
        mob: bestMobLv,
        act: [...active].map(([id, st]) => [id, st.step, st.done]),
        done: [...doneToday],
      }
    },
    load(data: unknown): void {
      if (!data || typeof data !== 'object') return
      const d = data as {
        day?: unknown
        lv?: unknown
        best?: unknown
        mob?: unknown
        act?: unknown
        done?: unknown
      }
      if (typeof d.best === 'number' && Number.isFinite(d.best)) {
        bestCombat = Math.max(1, Math.floor(d.best))
      }
      if (typeof d.mob === 'number' && Number.isFinite(d.mob)) {
        bestMobLv = Math.max(0, Math.floor(d.mob))
      }
      active.clear()
      doneToday.clear()
      if (typeof d.day === 'string' && d.day === cstDay()) {
        // Same CST day: regenerate the identical board from the frozen band...
        day = d.day
        dayLv = typeof d.lv === 'number' && Number.isFinite(d.lv) ? Math.max(1, Math.floor(d.lv)) : effectiveLv()
        rebuild()
        // ...then restore progress rows against it (clamped, quests-style).
        if (Array.isArray(d.done)) {
          for (const id of d.done) {
            if (typeof id === 'string' && byId.has(id)) doneToday.add(id)
          }
        }
        if (Array.isArray(d.act)) {
          for (const row of d.act) {
            if (!Array.isArray(row)) continue
            const [id, step, done] = row as [unknown, unknown, unknown]
            if (typeof id !== 'string' || doneToday.has(id)) continue
            const def = byId.get(id)
            if (!def || active.size >= MAX_ACTIVE) continue
            const s = typeof step === 'number' && Number.isFinite(step) ? Math.floor(step) : 0
            const clampedStep = Math.max(0, Math.min(def.steps.length - 1, s))
            const need = def.steps[clampedStep]?.need ?? 1
            const dn = typeof done === 'number' && Number.isFinite(done) ? Math.floor(done) : 0
            active.set(id, { step: clampedStep, done: Math.max(0, Math.min(need, dn)) })
          }
        }
      } else {
        // Stale save day: force today's fresh board.
        day = ''
        checkDay()
      }
      board?.refresh()
    },
  })

  // --- progress listeners (same hooks the quest engine rides) --------------
  events.on('mob:killed', (e) => {
    checkDay()
    if (e.level > bestMobLv) {
      bestMobLv = e.level
      events.emit('save:dirty', { why: 'contracts:moblv' })
    }
    // Contracts never target boss_* ids; plain species kills (boss included,
    // same law as quests — a boss IS a wolf, legally) count.
    progressContracts((step) => step.kind === 'kill' && step.target === e.species)
  })

  events.on('gather:done', (e) => {
    checkDay()
    progressContracts((step) => step.kind === 'gather' && step.target === e.nodeType)
  })

  events.on('region:entered', (e) => {
    lastRegion = e.regionId
    checkDay()
    progressContracts((step) => step.kind === 'explore' && step.target === e.regionId)
  })

  events.on('level:up', (e) => {
    if (
      (e.skill === 'attack' || e.skill === 'defense' || e.skill === 'magic' || e.skill === 'vitality') &&
      e.level > bestCombat
    ) {
      bestCombat = e.level
      events.emit('save:dirty', { why: 'contracts:band' })
    }
  })

  // CST-midnight reroll while the tab stays open.
  window.setInterval(() => {
    checkDay()
    board?.refresh()
  }, 60_000)

  // --- board UI (injects its 'Contracts' entry into the quest log) ----------
  board = createBoard({
    contracts: () => contractsApi.today(),
    status: (id) => contractsApi.status(id),
    accept: (id) => contractsApi.accept(id),
    abandon: (id) => contractsApi.abandon(id),
    activeCount: () => contractsApi.activeCount(),
    maxActive: () => contractsApi.maxActive(),
    resetsInMs: () => contractsApi.resetsInMs(),
    rewardText: (def) => contractRewardText(def),
  })

  return contractsApi
}
