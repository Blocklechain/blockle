/**
 * Blocklings skill trees — state + SkillTreeAPI implementation.
 *
 * Point economy: 1 perk point per level-up in ANY skill, pooled. Earned
 * points are derived (sum of level-1 across skills), spent points are the
 * count of explicitly chosen perk/capstone nodes — so nothing about points
 * needs its own persistence. Auto nodes are granted free the moment their
 * skill level is reached (also derived, never stored).
 *
 * Persistence: only the explicit picks, as a string[] of node ids, embedded
 * additively by skills/index.ts into the existing 'skills' save blob under
 * the reserved '_tree' key.
 */
import type { SkillTreeAPI, TreeNode } from '../../types'
import { events } from '../../events'
import { treeNode, treeNodes, allTreeNodes, type TreeNodeDef } from './data'

/** Injected by skills/index.ts at init — the one bridge to XP state. */
interface TreeDeps {
  level(skill: string): number
  skills: readonly string[]
}

let deps: TreeDeps = { level: () => 1, skills: [] }

/** Explicitly chosen perk/capstone node ids (insertion order kept for saves). */
const picked = new Set<string>()

let modCache: Map<string, number> | null = null
let chosenCache: string[] | null = null
let onChanged: (() => void) | null = null

function invalidate(): void {
  modCache = null
  chosenCache = null
  onChanged?.()
}

/** Explicit picks + every auto node whose level gate is met. */
function chosenIds(): readonly string[] {
  if (chosenCache) return chosenCache
  const out: string[] = []
  for (const skill of deps.skills) {
    const lvl = deps.level(skill)
    for (const n of treeNodes(skill)) {
      if (n.kind === 'auto' && n.lvlReq <= lvl) out.push(n.id)
    }
  }
  for (const id of picked) out.push(id)
  chosenCache = out
  return out
}

function isChosen(id: string): boolean {
  if (picked.has(id)) return true
  const n = treeNode(id)
  return !!n && n.kind === 'auto' && n.lvlReq <= deps.level(n.skill)
}

function earnedPoints(): number {
  let t = 0
  for (const s of deps.skills) t += deps.level(s) - 1
  return t
}

function points(): number {
  return Math.max(0, earnedPoints() - picked.size)
}

/** Why a node can't be taken right now ('' = it can). Drives UI copy too. */
export function chooseBlocker(id: string): string {
  const n = treeNode(id)
  if (!n) return 'unknown node'
  if (n.kind === 'auto') return `granted free at ${cap(n.skill)} level ${n.lvlReq}`
  if (picked.has(id)) return 'already chosen'
  if (deps.level(n.skill) < n.lvlReq) return `requires ${cap(n.skill)} level ${n.lvlReq}`
  for (const req of n.requires) {
    if (!isChosen(req)) {
      const r = treeNode(req)
      return `requires "${r?.name ?? req}" first`
    }
  }
  if (n.excl) {
    for (const other of treeNodes(n.skill)) {
      if (other.id !== id && other.excl === n.excl && picked.has(other.id)) {
        return `locked out by "${other.name}" — you chose your side`
      }
    }
  }
  if (points() <= 0) return 'no perk points — go level something'
  return ''
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export const skillTreeApi: SkillTreeAPI = {
  nodes(skill: string): readonly TreeNode[] {
    return treeNodes(skill)
  },
  chosen(): readonly string[] {
    return chosenIds()
  },
  canChoose(id: string): boolean {
    return chooseBlocker(id) === ''
  },
  choose(id: string): boolean {
    if (chooseBlocker(id) !== '') return false
    picked.add(id)
    invalidate()
    const n = treeNode(id)!
    events.emit('chat:system', {
      text: `Perk chosen: ${n.name} — ${n.desc}`
    })
    events.emit('save:dirty', { why: 'skilltree' })
    return true
  },
  points,
  modifier(key: string): number {
    if (!modCache) {
      modCache = new Map()
      for (const id of chosenIds()) {
        const n = treeNode(id)
        if (!n) continue
        for (const [k, v] of Object.entries(n.effects)) {
          modCache.set(k, (modCache.get(k) ?? 0) + v)
        }
      }
    }
    return modCache.get(key) ?? 0
  }
}

/* ========================================================================== *
 *  Wiring (called only from skills/index.ts).                                *
 * ========================================================================== */

/**
 * Force a recompute of the auto-grant / modifier caches. Normally driven by
 * 'level:up', but the prestige module resets a skill's XP straight to 0
 * WITHOUT a level event, so skills/index.ts calls this after a prestige reset
 * to drop that skill's now-unearned auto nodes from the modifier aggregate.
 */
export function invalidateTree(): void {
  invalidate()
}

export function initSkillTree(d: TreeDeps, changed?: () => void): SkillTreeAPI {
  deps = d
  onChanged = changed ?? null
  // Auto grants + earned points move on every level-up.
  events.on('level:up', () => invalidate())
  return skillTreeApi
}

/** Serialize explicit picks (for the 'skills' save blob, '_tree' key). */
export function dumpTree(): string[] {
  return [...picked]
}

/** Restore explicit picks; silently drops ids that no longer exist. */
export function loadTree(data: unknown): void {
  picked.clear()
  if (Array.isArray(data)) {
    const catalog = allTreeNodes()
    for (const id of data) {
      if (typeof id !== 'string') continue
      const n = catalog.get(id)
      if (n && n.kind !== 'auto') picked.add(id)
    }
  }
  invalidate()
}

/** Pretty one-liner for an effects entry (shared by the tree view). */
export function effectLabel(key: string, value: number): string {
  if (key.startsWith('recipe:')) return `Unlocks recipe: ${key.slice(7)}`
  if (key.startsWith('tier:')) return `Unlocks tier: ${key.slice(5)}`
  if (key.startsWith('unlock:')) return `Unlocks: ${key.slice(7)}`
  const NAMES: Record<string, string> = {
    crit: 'crit chance',
    critDmg: 'crit damage',
    cleave: 'cleave splash',
    atkDmgPct: 'attack damage',
    atkSpeed: 'attack speed',
    comboDmg: 'third-hit damage',
    execDmg: 'damage vs low-HP enemies',
    dmgReducePct: 'damage reduction',
    blockChance: 'block chance',
    blockHeal: 'heal on block',
    thorns: 'damage reflected',
    aggroDown: 'less monster attention',
    maxHpPct: 'max HP',
    magDmgPct: 'spell damage',
    mpMaxPct: 'max MP',
    mpRegen: 'MP regen',
    mpCostDown: 'cheaper spells',
    burnChance: 'ignite chance',
    chain: 'spell bounce chance',
    castSpeed: 'cast speed',
    hpRegen: 'HP regen',
    lifesteal: 'lifesteal',
    foodHealPct: 'food healing',
    secondChance: 'cheat death (once per fight)',
    mineSpeed: 'mining speed',
    doubleOre: 'double ore chance',
    gemFind: 'gem find',
    chopSpeed: 'chop speed',
    doubleWood: 'double wood chance',
    nestFind: 'nest find',
    fishSpeed: 'catch speed',
    doubleFish: 'double fish chance',
    treasureFind: 'treasure find',
    growSpeed: 'growth speed',
    doubleCrop: 'double crop chance',
    seedSave: 'seed save chance',
    gatherSpeed: 'gather speed',
    doubleHerb: 'double herb chance',
    rareHerb: 'rare herb find',
    smithSpeed: 'smith speed',
    saveBar: 'bar save chance',
    quality: 'quality chance',
    cookSpeed: 'cook speed',
    noBurn: 'less burning',
    brewSpeed: 'brew speed',
    doublePotion: 'bonus potion chance',
    potency: 'potion potency',
    sewSpeed: 'sew speed',
    saveCloth: 'cloth save chance'
  }
  const name = NAMES[key] ?? key
  if (value === 1 && (key === 'secondChance')) return name
  // regen-style values are flat, everything else reads as percent
  const flat = key === 'hpRegen' || key === 'mpRegen'
  return flat ? `+${value} ${name}` : `+${Math.round(value * 100)}% ${name}`
}

export type { TreeNodeDef }
