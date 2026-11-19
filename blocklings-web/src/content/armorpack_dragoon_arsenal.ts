/**
 * Content pack — DRAGOON ARSENAL.
 *
 * The full DRAGOON armor family (wyrmhelm / wyrmscale / wyrmboots) at every one
 * of the 12 material tiers (copper..runic) — dragon-knight plate that gives up a
 * little defense for a snarling +atk, because the dragoon philosophy is "block
 * it by killing it first." PLUS the endgame WEAPON line: sword / axe / bow /
 * staff / shield at the four late-game tiers past mythic (obsidian..runic),
 * extending the base weapon ladder (which stops at mythic) up the new 999 curve.
 *
 * Every id follows the `<prefix>_<materialTail>` convention so the mesh dispatch
 * in items/mesh.ts routes it to the real family builder at the right tier, and
 * SLOT_BY_PREFIX in inventory/defs.ts files it into the right slot. All of these
 * prefixes (wyrmhelm/wyrmscale/wyrmboots, sword/axe/bow/staff/shield) already
 * exist in those tables — this pack only mints catalog truth, never touches the
 * mesh/slot foundation.
 *
 * Tiers 6..11 (obsidian..runic) all clamp to Mythical rarity (5); their colors
 * still come from palette tiers 6..11. Stats are explicit and ride on top of the
 * new 999 level curve.
 *
 * Writing register: mature cartoon-comedy, mean-at-life. You have nice gear now.
 * Your problems remain uninsured.
 */
import { registerPack } from './packs'
import type { ItemDef, ItemSlot, Rarity } from '../types'

// Material ladder — index == tier. The id tail MUST be exactly one of these.
const MAT_TAIL = [
  'copper', 'iron', 'steel', 'gold', 'crystal', 'mythic',
  'obsidian', 'dragonbone', 'void', 'astral', 'titan', 'runic',
] as const
const MAT_NAME = [
  'Copper', 'Iron', 'Steel', 'Gold', 'Crystal', 'Mythic',
  'Obsidian', 'Dragonbone', 'Void', 'Astral', 'Titan', 'Runic',
] as const

// Tier index -> rarity (endgame tiers all read Mythical, which caps the type).
const RARITY: readonly Rarity[] = [0, 1, 1, 2, 3, 4, 5, 5, 5, 5, 5, 5]
// Tier index -> level requirement (clamped <= 999).
const LEVEL_REQ = [1, 10, 20, 40, 60, 85, 120, 180, 260, 380, 560, 800] as const

const lvl = (t: number): number => Math.min(LEVEL_REQ[t]!, 999)
const val = (t: number): number => (t + 1) * (t + 1) * 12

// Funny, mean-at-life tier flavor — appended to each piece's family opener.
const TIER_FLAVOR = [
  'Starter gear for someone life has already disappointed.',
  'A modest upgrade, like most good things that happen to you: small and late.',
  'Reliable, unremarkable, and faintly judgmental of your life choices.',
  "Shiny enough to distract from the fact that you still owe everyone money.",
  "Humming with power and the quiet suspicion that you don't deserve it.",
  'Mythic-grade, which means the therapy would have been cheaper.',
  'Forged in volcanic glass by craftsmen who hated mornings as much as you do.',
  'Carved from the bones of something that also thought it was special.',
  'Woven from the empty part of the universe, which relates to your weekends.',
  'Star-touched, radiant, and still unable to fix your sleep schedule.',
  'Heavy as your student debt and roughly as indestructible.',
  'Runic endgame gear. Reality signed off on it; your landlord did not.',
] as const

type Stats = NonNullable<ItemDef['stats']>
type Grip = NonNullable<ItemDef['gripStyle']>

const items: ItemDef[] = []
const itemNames: Record<string, string> = {}

function push(
  prefix: string,
  t: number,
  slot: ItemSlot,
  noun: string,
  opener: string,
  stats: Stats,
  opts: { grip?: Grip; valueMul?: number } = {},
): void {
  const id = `${prefix}_${MAT_TAIL[t]}`
  const name = `${MAT_NAME[t]} ${noun}`
  const def: ItemDef = {
    id,
    name,
    slot,
    rarity: RARITY[t]!,
    stats,
    levelReq: lvl(t),
    value: Math.round(val(t) * (opts.valueMul ?? 1)),
    desc: `${opener} ${TIER_FLAVOR[t]}`,
    ...(opts.grip !== undefined ? { gripStyle: opts.grip } : {}),
  }
  items.push(def)
  itemNames[id] = name
}

// ---------------------------------------------------------------------------
// DRAGOON armor — all 12 tiers. Dragon-knight plate: trades a little defense
// for a snarling +atk (the dragoon secondary). Boots also get a small +agi.
// ---------------------------------------------------------------------------
for (let t = 0; t < 12; t++) {
  push('wyrmhelm', t, 'helm', 'Wyrmhelm',
    "A dragon-skulled helm that snarls so you don't have to.",
    { def: 2 + 2 * t, atk: 1 + t })

  push('wyrmscale', t, 'chest', 'Wyrmscale',
    'Overlapping wyrmscale plate that treats incoming fire as a mild inconvenience.',
    { def: 3 + 3 * t, atk: 2 + t }, { valueMul: 1.4 })

  push('wyrmboots', t, 'boots', 'Wyrmboots',
    'Clawed dragon-boots built for leaping onto things that wanted a quiet day.',
    { def: 1 + 2 * t, agi: 1 + Math.floor(t / 3), atk: 1 + Math.floor(t / 2) })
}

// ---------------------------------------------------------------------------
// Endgame WEAPON line — obsidian(6)..runic(11) only. Extends the base weapon
// ladder (which stops at mythic / index 5) up the new curve. Stat ramps below
// continue the catalog's per-tier shape; we index into them at 6..11.
// ---------------------------------------------------------------------------
const SWORD_ATK = [4, 8, 14, 22, 32, 46, 62, 82, 106, 134, 168, 210] as const
const SWORD_STR = [1, 2, 3, 5, 7, 10, 14, 19, 25, 32, 40, 50] as const
const AXE_ATK = [5, 9, 16, 24, 35, 50, 68, 90, 116, 146, 182, 226] as const
const AXE_STR = [2, 3, 5, 7, 10, 14, 19, 25, 32, 40, 50, 62] as const
const BOW_ATK = [4, 7, 13, 20, 30, 43, 58, 76, 98, 124, 156, 194] as const
const BOW_AGI = [2, 4, 6, 9, 13, 18, 24, 31, 39, 49, 61, 75] as const
const STAFF_ATK = [3, 6, 11, 17, 26, 38, 52, 69, 89, 113, 142, 178] as const
const STAFF_INT = [3, 6, 10, 15, 22, 32, 44, 58, 75, 95, 120, 150] as const
const SHIELD_DEF = [3, 6, 10, 16, 24, 35, 48, 63, 81, 103, 130, 162] as const
const SHIELD_INT = [0, 0, 0, 0, 0, 0, 12, 16, 20, 25, 31, 38] as const

for (let t = 6; t < 12; t++) {
  push('sword', t, 'weapon', 'Sword',
    "A blade long enough to settle arguments you never should have started.",
    { atk: SWORD_ATK[t]!, str: SWORD_STR[t]! }, { grip: 'forward', valueMul: 2 })

  push('axe', t, 'weapon', 'Battleaxe',
    "A cleaver that files every dispute under 'resolved, loudly.'",
    { atk: AXE_ATK[t]!, str: AXE_STR[t]! }, { grip: 'forward', valueMul: 2 })

  push('bow', t, 'weapon', 'Bow',
    "A bow that ends conversations from a distance you'd call cowardly if you weren't holding it.",
    { atk: BOW_ATK[t]!, agi: BOW_AGI[t]! }, { grip: 'bow', valueMul: 2 })

  push('staff', t, 'weapon', 'Staff',
    'A staff that converts your unresolved feelings directly into area-of-effect damage.',
    { atk: STAFF_ATK[t]!, int: STAFF_INT[t]! }, { grip: 'upright', valueMul: 2 })

  push('shield', t, 'shield', 'Shield',
    'A wall you carry, for the many, many things lining up to reach your face.',
    { def: SHIELD_DEF[t]!, int: SHIELD_INT[t]! }, { grip: 'shield', valueMul: 1.5 })
}

registerPack({ items, itemNames })
