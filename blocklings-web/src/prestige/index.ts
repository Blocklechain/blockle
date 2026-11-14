/**
 * Blocklings — prestige / mastery core.
 *
 * Owns the endgame flex layer on top of skills: when a skill hits level 99 it
 * can PRESTIGE — reset to 1 (via the skills module's prestigeResetSkill hook)
 * for a permanent Mastery star plus one mastery perk. Stars stack per skill
 * (1..5+) and the grand total drives cosmetic titles + the character's
 * prestige aura.
 *
 * Contract shape (the frozen rules the integrator wires in main.ts):
 *   - This module NEVER imports skills/combat/gather/player directly. It reads
 *     skill levels through `setSkillLevelSource`, performs the reset through
 *     `setSkillReset`, and lights the character through `setAuraSink`.
 *   - It EXPOSES the mastery modifiers the rest of the game reads:
 *       masteryModifier(skill, key) — per-skill (skills folds 'xpBonus' in).
 *       masteryBonus(key)           — summed across skills (combat/gather fold
 *                                     this into their talent-tree modifier).
 *   - Persists a compact 'prestige' saveRegistry blob (per-skill perk picks).
 *
 * Leaf imports only: save/registry + events (the sanctioned ones).
 */
import type { GameAPI } from '../types'
import { SKILLS, type SkillId } from '../ids'
import { events } from '../events'
import { saveRegistry } from '../save/registry'
import {
  PERK_BY_CODE,
  PERK_CODE,
  SIGNATURE,
  XP_PERK_STEP,
  type PerkKind
} from './perks'
import { auraColor, auraTier, masteryTitle, reachedMilestone } from './milestones'
import { createMasteryPanel, type MasteryPanel } from './panel'
import { prestigeLine } from './flavor'

// ---------------------------------------------------------------------------
// State — per-skill perk picks (one entry per star, insertion order = order
// the stars were earned). Stars for a skill = its perk list length.
// ---------------------------------------------------------------------------

const perks = new Map<SkillId, PerkKind[]>()
for (const s of SKILLS) perks.set(s, [])

function isSkillId(s: string): s is SkillId {
  return (SKILLS as readonly string[]).includes(s)
}

function starsOf(skill: string): number {
  return isSkillId(skill) ? perks.get(skill)!.length : 0
}

function countKind(skill: SkillId, kind: PerkKind): number {
  let n = 0
  for (const k of perks.get(skill)!) if (k === kind) n++
  return n
}

function totalStars(): number {
  let t = 0
  for (const s of SKILLS) t += perks.get(s)!.length
  return t
}

function isGolden(skill: string): boolean {
  return isSkillId(skill) && countKind(skill, 'gold') > 0
}

// ---------------------------------------------------------------------------
// Mastery modifiers — the read surface combat / gather / crafting / skills use.
// ---------------------------------------------------------------------------

/**
 * Per-skill permanent mastery bonus for `key`:
 *   'xpBonus'           → +XP% from 'xp' perks (read by skills.addXp).
 *   <skill signature>   → the skill's signature stat from 'mod' perks.
 * Everything else is 0.
 */
export function masteryModifier(skill: string, key: string): number {
  if (!isSkillId(skill)) return 0
  if (key === 'xpBonus') return XP_PERK_STEP * countKind(skill, 'xp')
  const sig = SIGNATURE[skill]
  if (key === sig.key) return sig.step * countKind(skill, 'mod')
  return 0
}

/**
 * Summed mastery bonus for a talent-tree modifier `key` across all skills.
 * Combat/gather fold this into their existing modifier source so a 'mod' perk
 * stacks straight onto the matching talent effect. (XP bonus is per-skill and
 * is read via masteryModifier, never through this aggregate.)
 */
export function masteryBonus(key: string): number {
  if (key === 'xpBonus') return 0
  let v = 0
  for (const s of SKILLS) {
    const sig = SIGNATURE[s]
    if (sig.key === key) v += sig.step * countKind(s, 'mod')
  }
  return v
}

// ---------------------------------------------------------------------------
// Integrator-wired sources / sinks.
// ---------------------------------------------------------------------------

let skillLevelSource: (skill: string) => number = () => 1
let skillResetSource: (skill: string) => boolean = () => false
let auraSink: ((tier: 0 | 1 | 2 | 3 | 4, color: number | null) => void) | null = null

/** Read a skill's current level (wired to skillsApi.level). */
export function setSkillLevelSource(fn: (skill: string) => number): void {
  skillLevelSource = fn
}

/** Perform the level-99 → 1 reset (wired to skills.prestigeResetSkill). */
export function setSkillReset(fn: (skill: string) => boolean): void {
  skillResetSource = fn
}

/**
 * Light the character with the prestige aura. Wired to the player rig if it
 * exposes an aura hook; otherwise the integrator can leave it unset — this
 * module also dispatches a `blocklings:prestige-aura` CustomEvent on window as
 * a rig-agnostic fallback (detail: { tier, color }).
 */
export function setAuraSink(fn: (tier: 0 | 1 | 2 | 3 | 4, color: number | null) => void): void {
  auraSink = fn
  // Push the current state immediately so a late-wired sink catches up.
  emitAura(false)
}

// ---------------------------------------------------------------------------
// Aura broadcasting.
// ---------------------------------------------------------------------------

let lastAuraTier: 0 | 1 | 2 | 3 | 4 = 0

function emitAura(allowToast: boolean): void {
  const total = totalStars()
  const tier = auraTier(total)
  const color = auraColor(total)
  auraSink?.(tier, color)
  try {
    window.dispatchEvent(
      new CustomEvent('blocklings:prestige-aura', { detail: { tier, color } })
    )
  } catch {
    /* non-DOM / SSR guard */
  }
  if (allowToast && tier > lastAuraTier) {
    const m = reachedMilestone(total)
    if (m) events.emit('chat:system', { text: m.toast })
  }
  lastAuraTier = tier
}

// ---------------------------------------------------------------------------
// The one mutation: prestige a skill.
// ---------------------------------------------------------------------------

let panel: MasteryPanel | null = null

/**
 * Prestige `skill` with the chosen perk. Resets it to level 1 (through the
 * skills hook), banks a star + the perk, persists, re-auras, and announces it.
 * No-ops (returns false) unless the skill is currently level 99.
 */
export function prestige(skill: string, kind: PerkKind): boolean {
  if (!isSkillId(skill)) return false
  if (skillLevelSource(skill) < 99) return false
  if (!skillResetSource(skill)) return false
  perks.get(skill)!.push(kind)
  events.emit('save:dirty', { why: 'prestige' })
  events.emit('chat:system', {
    text: prestigeLine(skill, starsOf(skill), kind)
  })
  emitAura(true)
  panel?.refresh()
  return true
}

// ---------------------------------------------------------------------------
// Persistence — compact: { [skill]: "xmg..." } (one char per star).
// ---------------------------------------------------------------------------

function registerSave(): void {
  saveRegistry.register('prestige', {
    dump(): Record<string, string> {
      const out: Record<string, string> = {}
      for (const s of SKILLS) {
        const list = perks.get(s)!
        if (list.length > 0) out[s] = list.map((k) => PERK_CODE[k]).join('')
      }
      return out
    },
    load(data: unknown): void {
      for (const s of SKILLS) perks.set(s, [])
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        for (const [skill, val] of Object.entries(data as Record<string, unknown>)) {
          if (!isSkillId(skill) || typeof val !== 'string') continue
          const list: PerkKind[] = []
          for (const ch of val) {
            const kind = PERK_BY_CODE[ch]
            if (kind) list.push(kind)
          }
          perks.set(skill, list)
        }
      }
      emitAura(false)
      panel?.refresh()
    }
  })
}

// ---------------------------------------------------------------------------
// Init.
// ---------------------------------------------------------------------------

let inited = false

export function initPrestige(api: GameAPI): void {
  void api // panel mounts into #ui; GameAPI kept for contract symmetry
  if (inited) return
  inited = true

  registerSave()

  panel = createMasteryPanel({
    skills: SKILLS,
    level: (s) => skillLevelSource(s),
    stars: (s) => starsOf(s),
    golden: (s) => isGolden(s),
    perks: (s) => (isSkillId(s) ? [...perks.get(s)!] : []),
    totalStars,
    title: () => masteryTitle(totalStars()),
    prestige: (s, kind) => prestige(s, kind)
  })

  // Any skill reaching 99 should make the panel light up its Prestige button.
  events.on('level:up', ({ level }) => {
    if (level >= 99) panel?.refresh()
  })
}
