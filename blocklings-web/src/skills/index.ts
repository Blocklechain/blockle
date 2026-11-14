/**
 * Blocklings — skills module core.
 *
 * Owns XP + levels for every SkillId in src/ids.ts. Consumes 'xp:gained'
 * from the bus, emits 'level:up' / 'chat:system' / 'save:dirty', registers
 * the 'skills' save provider (skill -> total xp, CharacterSave-compatible),
 * and mounts the Skills HUD panel.
 *
 * Combat hooks (read by the combat/integrator layer, never pushed by us):
 *   maxHpBonus()      — vitality: +4 max HP per level above 1
 *   damageReduction() — defense: fraction of incoming damage ignored,
 *                       0.004/level above 1, capped at 0.40 (level 99 ≈ 39%)
 */
import type { GameAPI, SkillsAPI } from '../types'
import { SKILLS, type SkillId } from '../ids'
import { events } from '../events'
import { saveRegistry } from '../save/registry'
import { MAX_LEVEL, XP_CAP, bracketProgress, levelForXp, xpForLevel } from './curve'
import { levelUpLine } from './flavor'
import { createSkillsPanel } from './panel'

/** Total XP per skill. The single source of truth; levels are derived. */
const xpBySkill = new Map<SkillId, number>()
for (const s of SKILLS) xpBySkill.set(s, 0)

function isSkillId(skill: string): skill is SkillId {
  return (SKILLS as readonly string[]).includes(skill)
}

function skillXp(skill: string): number {
  return isSkillId(skill) ? xpBySkill.get(skill)! : 0
}

// ---------------------------------------------------------------------------
// Combat hooks (derived getters — the integrator reads these)
// ---------------------------------------------------------------------------

/** Extra max HP from vitality: +4 per level above 1 (0 at Lv1, +392 at Lv99). */
export function maxHpBonus(): number {
  return (levelForXp(skillXp('vitality')) - 1) * 4
}

/**
 * Fraction of incoming damage the defense skill soaks (apply as
 * `damage * (1 - damageReduction())`). 0 at Lv1, ~0.392 at Lv99, capped 0.40.
 */
export function damageReduction(): number {
  return Math.min(0.4, (levelForXp(skillXp('defense')) - 1) * 0.004)
}

// ---------------------------------------------------------------------------
// SkillsAPI
// ---------------------------------------------------------------------------

function totalLevel(): number {
  let t = 0
  for (const s of SKILLS) t += levelForXp(xpBySkill.get(s)!)
  return t
}

let onChanged: (() => void) | null = null

function addXp(skill: string, amount: number): void {
  if (!isSkillId(skill)) return
  if (!Number.isFinite(amount) || amount <= 0) return

  const before = xpBySkill.get(skill)!
  const after = Math.min(XP_CAP, before + amount)
  if (after === before) return
  xpBySkill.set(skill, after)

  const oldLevel = levelForXp(before)
  const newLevel = levelForXp(after)
  for (let lvl = oldLevel + 1; lvl <= newLevel; lvl++) {
    events.emit('level:up', { skill, level: lvl })
  }
  if (newLevel > oldLevel) {
    events.emit('chat:system', { text: levelUpLine(skill, newLevel) })
  }
  events.emit('save:dirty', { why: 'skills' })
  onChanged?.()
}

export const skillsApi: SkillsAPI = {
  level(skill: string): number {
    return isSkillId(skill) ? levelForXp(xpBySkill.get(skill)!) : 1
  },
  xp(skill: string): number {
    return skillXp(skill)
  },
  /** XP still needed to reach the next level (0 at the 99 cap). */
  xpToNext(skill: string): number {
    if (!isSkillId(skill)) return 0
    const x = xpBySkill.get(skill)!
    const lvl = levelForXp(x)
    if (lvl >= MAX_LEVEL) return 0
    return xpForLevel(lvl + 1) - x
  },
  addXp,
  total: totalLevel
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

let inited = false

export function initSkills(api: GameAPI): SkillsAPI {
  void api // panel mounts into #ui; GameAPI kept for contract symmetry
  if (inited) return skillsApi
  inited = true

  // Persistence: CharacterSave.skills — Record<skill, total xp>.
  saveRegistry.register('skills', {
    dump(): Record<string, number> {
      const out: Record<string, number> = {}
      for (const s of SKILLS) {
        const x = xpBySkill.get(s)!
        if (x > 0) out[s] = x
      }
      return out
    },
    load(data: unknown): void {
      if (!data || typeof data !== 'object') return
      for (const [skill, val] of Object.entries(data as Record<string, unknown>)) {
        if (!isSkillId(skill)) continue
        const x = typeof val === 'number' && Number.isFinite(val) ? val : 0
        xpBySkill.set(skill, Math.max(0, Math.min(XP_CAP, Math.floor(x))))
      }
      onChanged?.()
    }
  })

  // The ONE way xp enters this module from other systems.
  events.on('xp:gained', ({ skill, amount }) => addXp(skill, amount))

  // HUD button + panel.
  const panel = createSkillsPanel({
    skills: SKILLS,
    level: (s) => skillsApi.level(s),
    progress: (s) => bracketProgress(skillXp(s)),
    xp: (s) => skillXp(s),
    total: totalLevel
  })
  onChanged = () => panel.refresh()

  return skillsApi
}
