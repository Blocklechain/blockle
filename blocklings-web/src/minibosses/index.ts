/**
 * Per-zone mini-bosses. Every region + streamed zone (≈980 of them) gets ONE
 * deterministic, unique elite — generated purely from the zone id so it's
 * save-stable and identical on every device. Each mini-boss drops a
 * one-of-a-kind trophy (`trophy_<zoneId>`, defined in content/trophies.ts).
 *
 * This module is PURE DATA (no THREE, no DOM): the combat module imports
 * miniBossForZone() to spawn the current zone's elite, and content/trophies.ts
 * imports the zone list to mint the unique drops.
 */
import { SPECIES, REGIONS } from '../ids'
import { ZONES } from '../world/zones/registry'
import { MAX_LEVEL } from '../skills/curve'

/** The structural shape both RegionDef and ZoneDef satisfy. */
export interface ZoneLike {
  id: string
  name: string
  x0: number
  z0: number
  x1: number
  z1: number
  minLevel: number
  maxLevel: number
  biome: string
}

export interface MiniBoss {
  id: string // 'mb_<zoneId>'  — also the mob.bossId
  zoneId: string
  name: string
  speciesId: string
  level: number
  trophyId: string // 'trophy_<zoneId>'
  trophyName: string
  den: { x: number; z: number } // zone centre
  biome: string
}

function hash(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

const FIRST = [
  'Grukthar', 'Mossbeard', 'Gnarlrot', 'Blightfang', 'Cindermaw', 'Rustgut',
  'Hollowyn', 'Sludge', 'Vexhollow', 'Thornax', 'Gribble', 'Murkwall',
  'Snagtooth', 'Dreadnil', 'Wormwood', 'Clankjaw', 'Frostbite', 'Embereth',
  'Gloomfist', 'Puddlewrath', 'Scabrous', 'Fenwick', 'Boltcrack', 'Mirefang',
] as const

const TITLE = [
  'the Insufferable', 'the Overcompensating', 'the Unpaid', 'the Vaguely Threatening',
  'the Tax-Exempt', 'the Perpetually Damp', 'the Ill-Tempered', 'the Allegedly Undefeated',
  'the Mildly Cursed', 'Esquire', 'the Third', 'the Unfinished', 'the Overdue',
  'the Underwhelming', 'Prime', 'the Unhinged', 'the Regrettable', 'the Not-Sorry',
] as const

function nameFor(h: number): string {
  const first = FIRST[h % FIRST.length]!
  const title = TITLE[(h >>> 8) % TITLE.length]!
  return `${first} ${title}`
}

/** The unique mini-boss for a zone/region — pure function of its id + bounds. */
export function miniBossForZone(z: ZoneLike): MiniBoss {
  const h = hash('mb:' + z.id)
  const sp = SPECIES[h % SPECIES.length] ?? SPECIES[0]!
  const level = Math.max(1, Math.min(MAX_LEVEL, z.maxLevel || z.minLevel || 1))
  return {
    id: `mb_${z.id}`,
    zoneId: z.id,
    name: nameFor(h),
    speciesId: sp.id,
    level,
    trophyId: `trophy_${z.id}`,
    trophyName: `Trophy of ${z.name}`,
    den: { x: (z.x0 + z.x1) / 2, z: (z.z0 + z.z1) / 2 },
    biome: z.biome,
  }
}

/** Every region + zone, normalized to ZoneLike (the full mini-boss roster). */
export const MINIBOSS_ZONES: readonly ZoneLike[] = [
  ...REGIONS.map((r) => ({
    id: r.id, name: r.name, x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z1,
    minLevel: r.minLevel, maxLevel: r.maxLevel, biome: r.biome,
  })),
  ...ZONES.map((z) => ({
    id: z.id, name: z.name, x0: z.x0, z0: z.z0, x1: z.x1, z1: z.z1,
    minLevel: z.minLevel, maxLevel: z.maxLevel, biome: z.biome,
  })),
]

const byId = new Map<string, MiniBoss>()
/** The whole roster (also lets the map draw den markers later). */
export const ALL_MINIBOSSES: readonly MiniBoss[] = MINIBOSS_ZONES.map((z) => {
  const mb = miniBossForZone(z)
  byId.set(mb.id, mb)
  byId.set(mb.zoneId, mb)
  return mb
})

export function miniBossById(id: string): MiniBoss | undefined {
  return byId.get(id)
}

// ---------------------------------------------------------------------------
// Signature monsters — every zone has a few of its OWN named creatures that
// spawn only there. Deterministic from the zone id, so across ~980 zones there
// are thousands of distinct, named monsters (animated for free by the shared
// MobRig). Each rides a base species but gets a unique name + a size quirk so
// it reads as its own beast.
// ---------------------------------------------------------------------------

export interface SigMonster {
  key: string // stable id `sig_<zoneId>_<n>`
  name: string
  speciesId: string
  sizeMul: number // 0.8..1.35 — visual size quirk
  minLevel: number
  maxLevel: number
}

const SIG_ADJ = [
  'Feral', 'Rabid', 'Spectral', 'Gilded', 'Wretched', 'Bloated', 'Twitchy',
  'Ancient', 'Runty', 'Venomous', 'Molten', 'Frostbitten', 'Hollow', 'Screaming',
  'Putrid', 'Glistening', 'Mangy', 'Cursed', 'Giggling', 'Overfed', 'Sunbleached',
  'Three-Legged', 'Disgruntled', 'Soggy', 'Electric', 'Haunted', 'Lopsided',
] as const
const SIG_SUFFIX = [
  'of the Hollow', 'of Gribble Hill', 'Prime', 'Reborn', 'Mk II', 'of Nowhere',
  'the Local', 'of the Dump', 'Classic', 'Deluxe', 'the Elder', 'Jr.', 'Supreme',
  'of Last Tuesday', 'the Forgotten', 'Redux',
] as const

/** The handful of zone-exclusive named monsters for a zone (default 3). */
export function signatureMonstersForZone(z: ZoneLike, count = 3): SigMonster[] {
  const out: SigMonster[] = []
  for (let n = 0; n < count; n++) {
    const h = hash(`sig:${z.id}:${n}`)
    const sp = SPECIES[h % SPECIES.length] ?? SPECIES[0]!
    const adj = SIG_ADJ[(h >>> 3) % SIG_ADJ.length]!
    const suffix = SIG_SUFFIX[(h >>> 9) % SIG_SUFFIX.length]!
    const sizeMul = 0.8 + ((h >>> 14) % 56) / 100 // 0.80 .. 1.35
    out.push({
      key: `sig_${z.id}_${n}`,
      name: `${adj} ${sp.name} ${suffix}`,
      speciesId: sp.id,
      sizeMul,
      minLevel: z.minLevel,
      maxLevel: z.maxLevel,
    })
  }
  return out
}

