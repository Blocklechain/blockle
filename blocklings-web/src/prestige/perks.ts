/**
 * Blocklings prestige — the mastery perk vocabulary.
 *
 * Every time a skill is prestiged (reset from 99 → 1) the player banks one
 * permanent Mastery star AND picks ONE perk. Stars stack (prestige 1..5+), so
 * a skill accumulates a LIST of perk picks — one per star. Three flavours:
 *
 *   'xp'   → +5% permanent incoming XP in that skill (skills.addXp reads this
 *            via the 'xpBonus' modifier key). Stacks: 2 picks = +10%.
 *   'mod'  → a small permanent boost to that skill's SIGNATURE combat/gather
 *            modifier (the same keys the talent-tree already speaks, so combat
 *            /gather/crafting pick it up for free). Stacks.
 *   'gold' → a purely cosmetic golden skill icon (and it reads nice on the
 *            flex). No mechanical effect — the flex IS the reward.
 *
 * Perks are stored compactly in the save as one char each ('x' | 'm' | 'g').
 */
import type { SkillId } from '../ids'

/** The three mastery perk choices offered at every prestige. */
export type PerkKind = 'xp' | 'mod' | 'gold'

/** Compact save code ↔ PerkKind. */
export const PERK_CODE: Record<PerkKind, string> = { xp: 'x', mod: 'm', gold: 'g' }
export const PERK_BY_CODE: Record<string, PerkKind> = { x: 'xp', m: 'mod', g: 'gold' }

/** +5% incoming XP per 'xp' pick. */
export const XP_PERK_STEP = 0.05

/**
 * Each skill's signature modifier: the key a 'mod' pick boosts, and by how
 * much per pick. Keys match the talent-tree modifier vocabulary (see
 * skills/tree effects) so combat / gather / crafting read them with zero extra
 * wiring beyond folding masteryBonus(key) into their existing modifier source.
 * Combat skills get a tighter step (0.02) than professions (0.03) — raw damage
 * compounds harder than a gather-speed tick.
 */
export const SIGNATURE: Record<SkillId, { key: string; step: number; label: string }> = {
  attack: { key: 'atkDmgPct', step: 0.02, label: 'attack damage' },
  defense: { key: 'dmgReducePct', step: 0.02, label: 'damage reduction' },
  magic: { key: 'magDmgPct', step: 0.02, label: 'spell damage' },
  vitality: { key: 'maxHpPct', step: 0.02, label: 'max HP' },
  mining: { key: 'mineSpeed', step: 0.03, label: 'mining speed' },
  woodcutting: { key: 'chopSpeed', step: 0.03, label: 'chop speed' },
  fishing: { key: 'fishSpeed', step: 0.03, label: 'catch speed' },
  farming: { key: 'growSpeed', step: 0.03, label: 'growth speed' },
  herbalism: { key: 'gatherSpeed', step: 0.03, label: 'gather speed' },
  blacksmithing: { key: 'smithSpeed', step: 0.03, label: 'smith speed' },
  cooking: { key: 'cookSpeed', step: 0.03, label: 'cook speed' },
  alchemy: { key: 'brewSpeed', step: 0.03, label: 'brew speed' },
  tailoring: { key: 'sewSpeed', step: 0.03, label: 'sew speed' }
}

/** One perk option as shown in the prestige confirm dialog. */
export interface PerkOption {
  kind: PerkKind
  name: string
  /** Human blurb (comedy register, clean). */
  desc(skill: SkillId): string
}

/** The three choices, in display order. */
export const PERK_OPTIONS: readonly PerkOption[] = [
  {
    kind: 'xp',
    name: 'Fast Learner',
    desc: () => `+${Math.round(XP_PERK_STEP * 100)}% XP in this skill, forever. Compounds with every star.`
  },
  {
    kind: 'mod',
    name: 'Honed Edge',
    desc: (s) => {
      const sig = SIGNATURE[s]
      return `+${Math.round(sig.step * 100)}% ${sig.label}, permanently. Small, but it never goes away.`
    }
  },
  {
    kind: 'gold',
    name: 'Gilded',
    desc: () => 'A golden icon and zero mechanical benefit. Pure, honest flexing.'
  }
]
