/**
 * Inventory — item-def resolution.
 *
 * The items module owns the real catalog; the integrator wires it in via
 * `setDefSource`. Until (or unless) that happens, we synthesize a sane
 * ItemDef from the frozen item-id conventions in src/ids.ts so the bag is
 * never dead UI: slot, rarity, stats, restores, value and a comedy desc
 * are all derived deterministically from the id alone.
 */
import type { ItemDef, ItemSlot, Rarity } from '../types'
import { MATERIALS } from '../ids'

export type DefSource = (id: string) => ItemDef | undefined

/** The seven wearable/wieldable slots (ItemSlot minus consumable/material). */
export const GEAR_SLOTS = [
  'weapon',
  'shield',
  'helm',
  'chest',
  'boots',
  'accessory',
  'tool'
] as const
export type GearSlot = (typeof GEAR_SLOTS)[number]

export function isGearSlot(slot: string): slot is GearSlot {
  return (GEAR_SLOTS as readonly string[]).includes(slot)
}

export function isStackable(def: ItemDef): boolean {
  return def.slot === 'material' || def.slot === 'consumable'
}

/** Rarity presentation (index = Rarity tier). */
export const RARITY_NAMES = [
  'Common',
  'Uncommon',
  'Rare',
  'Epic',
  'Legendary',
  'Mythical'
] as const

export const RARITY_COLORS = [
  '#9aa0a6', // common — gray
  '#7ed957', // uncommon — green
  '#6cb8ff', // rare — blue
  '#b07df2', // epic — purple
  '#ffb04f', // legendary — orange
  '#ff5c8a' // mythical — pink
] as const

function hash(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h
}

function pick(pool: readonly string[], id: string): string {
  return pool[hash(id) % pool.length] ?? pool[0] ?? ''
}

// --- comedy fallback descriptions, one pool per slot family ----------------

const DESC: Record<string, readonly string[]> = {
  weapon: [
    'The pointy end goes in the other guy. You figured that out faster than most.',
    'Warranty void if used for violence. So, void.',
    'Previous owner has no further complaints. Or pulse.',
    'Swing it hard enough and your problems become someone else’s.'
  ],
  shield: [
    'Professional-grade hiding equipment. Strap it on and feel brave-ish.',
    'Blocks arrows, insults, and most forms of personal growth.',
    'The fine print says "shield not responsible for what goes around it."'
  ],
  helm: [
    'Keeps your brain where you left it. Mostly.',
    'Hat hair is a small price to pay for a functioning skull.',
    'One size fits most. Yours is "most," right?'
  ],
  chest: [
    'Vital organs: now 60% more opinionated about staying inside.',
    'Smells faintly of its previous owner. Don’t ask about the hole.',
    'Fashion-forward in a "please stop stabbing me" kind of way.'
  ],
  boots: [
    'Made for walking. Also kicking, stomping, and dramatic exits.',
    'Waterproof until proven otherwise.',
    'Step on a goblin’s toes with CONFIDENCE.'
  ],
  accessory: [
    'Vaguely magical. Loudly overpriced.',
    'The jeweler swore it was enchanted. The jeweler also skipped town.',
    'It hums when nobody’s listening. Probably fine.'
  ],
  tool: [
    'An honest tool for dishonest wages.',
    'Swing at rocks, not coworkers. We shouldn’t have to say this.',
    'Union-approved. The union is one angry dwarf.'
  ],
  consumable: [
    'Tastes like regret and secondhand victory. Down the hatch.',
    'The label says "probably not poison." Good enough.',
    'Chef’s kiss, if the chef had ever washed his hands.',
    'Shake well. Scream optional.'
  ],
  material: [
    'A perfectly good lump of commerce. Someone will pay for this. Probably.',
    'Crafting fuel. Hoard it like your self-esteem depends on it. It does.',
    'Heavy, useless alone, weirdly valuable in bulk. Like meetings.',
    'You picked this up off the ground and now it’s an asset. Capitalism!'
  ]
}

// --- id-convention parsing --------------------------------------------------

const SLOT_BY_PREFIX: Record<string, ItemSlot> = {
  sword: 'weapon',
  axe: 'weapon',
  bow: 'weapon',
  staff: 'weapon',
  shield: 'shield',
  helm: 'helm',
  chest: 'chest',
  boots: 'boots',
  ring: 'accessory',
  amulet: 'accessory',
  charm: 'accessory',
  talisman: 'accessory',
  pick: 'tool',
  hatchet: 'tool',
  rod: 'tool',
  food: 'consumable',
  potion: 'consumable',
  elixir: 'consumable'
}

/** Materials ladder index found inside the id, else 0 (common). */
function tierOf(id: string): Rarity {
  for (let i = MATERIALS.length - 1; i >= 0; i--) {
    const m = MATERIALS[i]
    if (m && id.includes(m)) return i as Rarity
  }
  return 0
}

function titleCase(id: string): string {
  return id
    .split('_')
    .reverse()
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ')
}

const LEVEL_REQ = [1, 5, 10, 15, 20, 30] as const

/** Deterministic fallback ItemDef from the id conventions alone. */
export function synthDef(id: string): ItemDef {
  const prefix = id.split('_')[0] ?? id
  const slot: ItemSlot = SLOT_BY_PREFIX[prefix] ?? 'material'
  const t = tierOf(id)
  const name = titleCase(id)
  const desc = pick(DESC[slot] ?? DESC['material']!, id)
  const value = (t + 1) * (t + 1) * 8

  const def: ItemDef = { id, name, slot, rarity: t, value, desc }

  switch (slot) {
    case 'weapon':
      def.stats = { atk: 3 + 3 * t, str: 1 + t }
      def.levelReq = LEVEL_REQ[t] ?? 1
      break
    case 'shield':
      def.stats = { def: 2 + 2 * t }
      def.levelReq = LEVEL_REQ[t] ?? 1
      break
    case 'helm':
      def.stats = { def: 1 + 2 * t }
      def.levelReq = LEVEL_REQ[t] ?? 1
      break
    case 'chest':
      def.stats = { def: 2 + 3 * t }
      def.levelReq = LEVEL_REQ[t] ?? 1
      break
    case 'boots':
      def.stats = { def: 1 + t, agi: 1 + t }
      def.levelReq = LEVEL_REQ[t] ?? 1
      break
    case 'accessory':
      def.stats = { int: 1 + 2 * t }
      break
    case 'tool':
      break
    case 'consumable':
      if (id.includes('mana') || id.includes('mp')) {
        def.restores = { mp: 30 + 20 * t }
      } else if (prefix === 'food') {
        def.restores = { hp: 15 + 10 * t }
      } else {
        def.restores = { hp: 30 + 20 * t }
      }
      break
    case 'material':
      break
  }
  return def
}
