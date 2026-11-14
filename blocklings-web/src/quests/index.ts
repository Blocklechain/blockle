/**
 * Quests — core engine.
 *
 * Owns the live quest log: offers (per-giver, prereq-gated), sequential step
 * progress driven entirely by bus events ('mob:killed' / 'gather:done' /
 * 'npc:talked' / 'region:entered' / 'item:gained'), completion + rewards
 * (emitted as 'item:gained' source 'quest' + 'xp:gained' + 'chat:system' —
 * this module never mutates stacks itself), and persistence through the
 * 'quests' save provider (CharacterSave.quests shape).
 *
 * Boss kill steps: a step target of 'boss_*' resolves through BOSSES and only
 * counts boss-flagged kills of that boss's species; plain species targets
 * count every kill of the species (boss included — a boss IS a wolf, legally).
 */
import type { GameAPI, QuestDef, QuestStep, QuestsAPI } from '../types'
import { events } from '../events'
import { saveRegistry } from '../save/registry'
import { BOSSES, NPCS } from '../ids'
import { ITEM_NAMES as ITEM_NAMES1, PREREQS as PREREQS1, QUESTS as QUESTS1, questById as questById1 } from './defs'
import { ITEM_NAMES2, PREREQS2, QUESTS2, questById2 } from './defs2'
import { ITEM_NAMES3, PREREQS3, QUESTS3, questById3 } from './defs3'
import { createQuestPanel, type QuestPanel } from './panel'
import { onTrackedChange, setTracked as setTrackedId, trackedId } from './tracking'

// Wave-3 outer-zone arcs concat straight onto the original book; everything
// below works off the merged tables under the original names.
const QUESTS: readonly QuestDef[] = [...QUESTS1, ...QUESTS2, ...QUESTS3]
const PREREQS: Readonly<Record<string, readonly string[]>> = { ...PREREQS1, ...PREREQS2, ...PREREQS3 }
const ITEM_NAMES: Readonly<Record<string, string>> = { ...ITEM_NAMES1, ...ITEM_NAMES2, ...ITEM_NAMES3 }
const questById = (id: string): QuestDef | undefined =>
  questById1(id) ?? questById2(id) ?? questById3(id)

interface ActiveState {
  step: number
  done: number
}

/** questId -> live progress, in accept order. */
const active = new Map<string, ActiveState>()
const completedSet = new Set<string>()
/** The quest the on-screen tracker follows. */
let focusId: string | null = null
/** Last region the player entered (lets explore steps auto-satisfy). */
let lastRegion: string | null = null

let ui: QuestPanel | null = null

function npcName(id: string): string {
  return NPCS.find((n) => n.id === id)?.name ?? id
}

export function itemName(id: string): string {
  return (
    ITEM_NAMES[id] ??
    id
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
  )
}

/** Human-readable reward summary ("120 Attack XP, Iron Sword ×1"). */
export function rewardSummary(def: QuestDef): string {
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
      bits.push(s.qty > 1 ? `${itemName(s.id)} ×${s.qty}` : itemName(s.id))
    }
  }
  return bits.join(', ')
}

// ---------------------------------------------------------------------------
// Progress machinery
// ---------------------------------------------------------------------------

function ensureFocus(): void {
  if (focusId && active.has(focusId)) return
  focusId = active.keys().next().value ?? null
}

function complete(id: string, def: QuestDef): void {
  active.delete(id)
  completedSet.add(id)
  ensureFocus()

  events.emit('quest:completed', { questId: id })

  const r = def.rewards
  if (r.items) {
    for (const s of r.items) {
      events.emit('item:gained', { id: s.id, qty: s.qty, source: 'quest' })
    }
  }
  if (r.xp) {
    for (const [skill, amount] of Object.entries(r.xp)) {
      if (typeof amount === 'number' && amount > 0) {
        events.emit('xp:gained', { skill, amount })
      }
    }
  }

  events.emit('chat:system', { text: `Quest complete: "${def.title}"` })
  events.emit('chat:system', { text: `${npcName(def.giver)}: ${def.outro}` })
  const summary = rewardSummary(def)
  if (summary) events.emit('chat:system', { text: `Rewards: ${summary}` })

  events.emit('save:dirty', { why: `quest:complete:${id}` })
  ui?.refresh()
  ui?.celebrate()
}

/** Apply `amount` progress to one active quest's current step. */
function advance(id: string, def: QuestDef, st: ActiveState, amount: number): void {
  const step = def.steps[st.step]
  if (!step) return
  st.done = Math.min(step.need, st.done + amount)
  events.emit('quest:progress', { questId: id, step: st.step, done: st.done, need: step.need })

  if (st.done >= step.need) {
    st.step += 1
    st.done = 0
    if (st.step >= def.steps.length) {
      complete(id, def)
      return
    }
    const next = def.steps[st.step]
    if (next) {
      events.emit('chat:system', { text: `${def.title} — next: ${next.label}` })
    }
    events.emit('save:dirty', { why: `quest:step:${id}` })
    ui?.refresh()
    ui?.pulse()
    // A freshly-revealed explore step for the region we're standing in
    // counts immediately — no "leave and walk back in" busywork.
    autoExplore(id)
    return
  }

  events.emit('save:dirty', { why: `quest:progress:${id}` })
  ui?.refresh()
  ui?.pulse()
}

function autoExplore(id: string): void {
  const st = active.get(id)
  if (!st) return
  const def = questById(id)
  if (!def) return
  const step = def.steps[st.step]
  if (step && step.kind === 'explore' && step.target === lastRegion) {
    advance(id, def, st, step.need)
  }
}

/** Run every active quest's CURRENT step through `match`; count hits. */
function progressWhere(match: (step: QuestStep) => boolean, amount = 1): void {
  for (const [id, st] of [...active]) {
    const def = questById(id)
    if (!def) continue
    const step = def.steps[st.step]
    if (!step || !match(step)) continue
    advance(id, def, st, amount)
  }
}

// ---------------------------------------------------------------------------
// QuestsAPI
// ---------------------------------------------------------------------------

function prereqsMet(questId: string): boolean {
  const reqs = PREREQS[questId]
  if (!reqs) return true
  return reqs.every((r) => completedSet.has(r))
}

export const questsApi: QuestsAPI = {
  available(npcId: string): readonly QuestDef[] {
    return QUESTS.filter(
      (q) =>
        q.giver === npcId && !completedSet.has(q.id) && !active.has(q.id) && prereqsMet(q.id)
    )
  },

  active(): readonly { def: QuestDef; step: number; done: number }[] {
    const out: { def: QuestDef; step: number; done: number }[] = []
    for (const [id, st] of active) {
      const def = questById(id)
      if (def) out.push({ def, step: st.step, done: st.done })
    }
    return out
  },

  accept(questId: string): void {
    const def = questById(questId)
    if (!def || active.has(questId) || completedSet.has(questId)) return
    active.set(questId, { step: 0, done: 0 })
    focusId = questId
    events.emit('quest:accepted', { questId })
    const first = def.steps[0]
    events.emit('chat:system', {
      text: `Quest accepted: "${def.title}"${first ? ` — ${first.label}` : ''}`,
    })
    events.emit('save:dirty', { why: `quest:accept:${questId}` })
    ui?.refresh()
    autoExplore(questId)
  },

  completed(): readonly string[] {
    return [...completedSet]
  },
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

let inited = false

export function initQuests(api: GameAPI): QuestsAPI {
  void api // UI mounts into #ui; GameAPI kept for shim-contract symmetry
  if (inited) return questsApi
  inited = true

  // --- persistence: CharacterSave.quests -----------------------------------
  saveRegistry.register('quests', {
    dump(): { done: string[]; active: [string, number, number][]; tracked: string | null } {
      return {
        done: [...completedSet],
        active: [...active].map(([id, st]) => [id, st.step, st.done]),
        // additive field: the guide-trail tracked quest/contract id
        tracked: trackedId(),
      }
    },
    load(data: unknown): void {
      if (!data || typeof data !== 'object') return
      const d = data as { done?: unknown; active?: unknown; tracked?: unknown }
      completedSet.clear()
      active.clear()
      if (Array.isArray(d.done)) {
        for (const id of d.done) {
          if (typeof id === 'string' && questById(id)) completedSet.add(id)
        }
      }
      if (Array.isArray(d.active)) {
        for (const row of d.active) {
          if (!Array.isArray(row)) continue
          const [id, step, done] = row as [unknown, unknown, unknown]
          if (typeof id !== 'string') continue
          const def = questById(id)
          if (!def || completedSet.has(id)) continue
          const s = typeof step === 'number' && Number.isFinite(step) ? Math.floor(step) : 0
          const clampedStep = Math.max(0, Math.min(def.steps.length - 1, s))
          const need = def.steps[clampedStep]?.need ?? 1
          const dn = typeof done === 'number' && Number.isFinite(done) ? Math.floor(done) : 0
          active.set(id, { step: clampedStep, done: Math.max(0, Math.min(need, dn)) })
        }
      }
      focusId = null
      ensureFocus()
      // restore the tracked id (contracts validate lazily in the guide)
      const t = d.tracked
      setTrackedId(
        typeof t === 'string' && (active.has(t) || t.startsWith('contract:')) ? t : null,
        true
      )
      ui?.refresh()
    },
  })

  // --- progress listeners ---------------------------------------------------
  events.on('mob:killed', (e) => {
    progressWhere((step) => {
      if (step.kind !== 'kill') return false
      if (step.target.startsWith('boss_')) {
        const b = BOSSES.find((x) => x.id === step.target)
        return !!b && e.boss === true && e.species === b.species
      }
      return step.target === e.species
    })
  })

  events.on('gather:done', (e) => {
    progressWhere((step) => step.kind === 'gather' && step.target === e.nodeType)
  })

  events.on('npc:talked', (e) => {
    progressWhere((step) => step.kind === 'talk' && step.target === e.npcId)
  })

  events.on('region:entered', (e) => {
    lastRegion = e.regionId
    progressWhere((step) => step.kind === 'explore' && step.target === e.regionId)
  })

  events.on('item:gained', (e) => {
    if (e.source === 'restore') return // save-load replays never progress quests
    progressWhere((step) => step.kind === 'collect' && step.target === e.id, e.qty)
  })

  // --- HUD: log button + panel + tracker widget -----------------------------
  ui = createQuestPanel({
    active: () => questsApi.active(),
    completedTitles: () =>
      [...completedSet].map((id) => questById(id)?.title ?? id),
    activeCount: () => active.size,
    focused: () => {
      ensureFocus()
      if (!focusId) return null
      const st = active.get(focusId)
      const def = focusId ? questById(focusId) : undefined
      return st && def ? { def, step: st.step, done: st.done } : null
    },
    setFocus: (id) => {
      if (active.has(id)) focusId = id
      ui?.refresh()
    },
    isFocused: (id) => focusId === id,
    isTracked: (id) => trackedId() === id,
    setTracked: (id) => {
      // tracking a quest also focuses it (the HUD widget follows the trail)
      if (id && active.has(id)) focusId = id
      setTrackedId(id)
      ui?.refresh()
    },
    giverName: npcName,
    rewardText: rewardSummary,
  })

  // tracking can change from the job board / the guide — keep pills in sync
  onTrackedChange(() => ui?.refresh())

  return questsApi
}

// ---------------------------------------------------------------------------
// Repeatable job board — contracts (appended registration glue; the engine,
// generation, and board UI live in ./contracts + ./board).
// ---------------------------------------------------------------------------
import { installContracts } from './contracts'
installContracts()
