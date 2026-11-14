/**
 * Blocklings — character look contract + curated catalogs.
 *
 * One compact, index-based description of everything cosmetic about a hero:
 * body frame, skin, hair (style + color), facial hair, tunic, pants, eyes
 * and cape. The catalogs below are THE palette — every index in a
 * CharacterLook points into them, so saves stay tiny and the art direction
 * stays curated (cozy flat-color voxel, forever).
 *
 * encodeLook/decodeLook pack a look into a short base36 string ('1' version
 * prefix + one char per field) for the save envelope and the net join
 * message. lookFromName is the deterministic fallback for remote players
 * whose relay doesn't carry looks yet.
 */
import * as THREE from 'three'

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

export interface CharacterLook {
  /** Body frame: 'broad' (the classic hero) or 'slender' (same big head). */
  body: 'broad' | 'slender'
  /** Index into SKIN_TONES. */
  skin: number
  /** Index into HAIR_STYLES. */
  hairStyle: number
  /** Index into HAIR_COLORS. */
  hairColor: number
  /** Index into FACIAL_HAIR (0 = none; every body may beard, it's a comedy). */
  facialHair: number
  /** Index into TUNIC_COLORS. */
  tunicColor: number
  /** Index into PANTS_COLORS. */
  pantsColor: number
  /** Index into EYE_COLORS. */
  eyes: number
  /** Index into CAPES (0 = none). */
  cape: number
}

// ---------------------------------------------------------------------------
// Catalogs (names are shown in the creator UI — comedy is load-bearing)
// ---------------------------------------------------------------------------

export interface BodyFrameDef {
  id: 'broad' | 'slender'
  name: string
  flavor: string
}

export const BODY_FRAMES: readonly BodyFrameDef[] = [
  { id: 'broad', name: 'Broad', flavor: 'Built like a friendly wardrobe.' },
  { id: 'slender', name: 'Slender', flavor: 'Dodges arrows and small talk.' }
]

/** 6 inclusive skin tones. */
export const SKIN_TONES: readonly { name: string; hex: number }[] = [
  { name: 'Porcelain Quest', hex: 0xf7d9b8 },
  { name: 'Adventurer Tan', hex: 0xf0c49a }, // the classic hero
  { name: 'Honey Bronze', hex: 0xd9a066 },
  { name: 'Toasted Oak', hex: 0xb07b4f },
  { name: 'Rich Mahogany', hex: 0x8a5a3b },
  { name: 'Deep Umber', hex: 0x5f3d2a }
]

/** 8 voxel-built hair styles; flavor lines show in the creator. */
export const HAIR_STYLES: readonly { id: string; name: string; flavor: string }[] = [
  { id: 'spiky', name: 'Spiky', flavor: 'Gelled with pure confidence and a little tree sap.' },
  { id: 'bob', name: 'The Bob', flavor: 'Classic. Dependable. Has never lost a fight, or won one.' },
  { id: 'long', name: 'Long & Flowing', flavor: 'Flows majestically indoors. Physics filed a complaint.' },
  { id: 'ponytail', name: 'Ponytail', flavor: 'Aerodynamic. Adds +0 speed but feels faster.' },
  { id: 'mohawk', name: 'Mohawk', flavor: 'The village elders disapprove. That is the point.' },
  { id: 'bald', name: 'Gloriously Bald', flavor: 'Nothing to grab in a fight. Tactical genius.' },
  { id: 'braids', name: 'Braids', flavor: 'Each braid took an hour. Respect the commitment.' },
  { id: 'topknot', name: 'Topknot', flavor: '10% hair, 90% discipline.' }
]

/** 10 hair colors (first six match the beloved villager palette). */
export const HAIR_COLORS: readonly { name: string; hex: number }[] = [
  { name: 'Chestnut', hex: 0x4a2f1b }, // the classic hero
  { name: 'Midnight', hex: 0x1d1a17 },
  { name: 'Caramel', hex: 0x8a5a2b },
  { name: 'Dandelion', hex: 0xb8863b },
  { name: 'Auburn', hex: 0x6e3a24 },
  { name: 'Indigo', hex: 0x3b3f8c },
  { name: 'Ginger Alarm', hex: 0xc94f2e },
  { name: 'Wise Silver', hex: 0xd8d4c8 },
  { name: 'Suspicious Potion', hex: 0x7a4fb0 },
  { name: 'Moss Mistake', hex: 0x3f8a4f }
]

/** 5 facial hair options — available to every body. It's a comedy game. */
export const FACIAL_HAIR: readonly { id: string; name: string }[] = [
  { id: 'none', name: 'Baby Smooth' },
  { id: 'stubble', name: 'Five O’Clock Shadow' },
  { id: 'beard', name: 'Full Lumberjack' },
  { id: 'mustache', name: 'The Diplomat' },
  { id: 'goatee', name: 'Suspicious Goatee' }
]

/**
 * 12 tunic colors, stored as hues — the builder applies the same
 * HSL(h, 0.62, 0.52) formula the hero has always worn.
 */
export const TUNIC_COLORS: readonly { name: string; hue: number }[] = [
  { name: 'Adventurer Blue', hue: 210 }, // the classic hero
  { name: 'Dragon Red', hue: 0 },
  { name: 'Pumpkin Spice', hue: 25 },
  { name: 'Mustard Incident', hue: 45 },
  { name: 'Grass Stain', hue: 95 },
  { name: 'Forest Casual', hue: 130 },
  { name: 'Minty Business', hue: 160 },
  { name: 'Deep Lagoon', hue: 185 },
  { name: 'Wizard Purple', hue: 260 },
  { name: 'Orchid Flex', hue: 285 },
  { name: 'Berry Crush', hue: 320 },
  { name: 'Battle Rosé', hue: 340 }
]

/** Dimmed-tunic formula — exactly how the classic hero's pants were made. */
function dim(hue: number): THREE.Color {
  return new THREE.Color().setHSL(hue / 360, 0.62, 0.52).multiplyScalar(0.75)
}

/** 8 pants colors (index 0 is the hero's original navy, bit-for-bit). */
export const PANTS_COLORS: readonly { name: string; color: THREE.Color }[] = [
  { name: 'Trusty Navy', color: dim(210) }, // the classic hero's exact pants
  { name: 'Dirt-Ready Brown', color: new THREE.Color(0x6b4a2c) },
  { name: 'Charcoal', color: new THREE.Color(0x3a3d45) },
  { name: 'Forest Duty', color: dim(130) },
  { name: 'Mulled Wine', color: dim(345) },
  { name: 'Khaki Compromise', color: new THREE.Color(0x9a8a62) },
  { name: 'Plum Gamble', color: dim(280) },
  { name: 'Storm Slate', color: new THREE.Color(0x5a6b7a) }
]

/** 4 eye colors (the crunchy 1px pupils on the 8x8 face). */
export const EYE_COLORS: readonly { name: string; css: string }[] = [
  { name: 'Midnight', css: '#20242e' }, // the classic hero
  { name: 'Forest', css: '#2e5d34' },
  { name: 'Ocean', css: '#2b4f8a' },
  { name: 'Amber', css: '#8a5a1e' }
]

/** 5 capes: none + 4 colors. Simple back-plane voxels, subtle walk sway. */
export const CAPES: readonly { name: string; hex: number | null }[] = [
  { name: 'No Cape (Safety First)', hex: null },
  { name: 'Hero Red', hex: 0xa83232 },
  { name: 'Royal Blue', hex: 0x2b4f8a },
  { name: 'Ranger Green', hex: 0x2e6b3f },
  { name: 'Midnight Drama', hex: 0x23263a }
]

// ---------------------------------------------------------------------------
// Defaults + helpers
// ---------------------------------------------------------------------------

/** The classic hero — exactly the look every Blockling wore before looks. */
export const DEFAULT_LOOK: CharacterLook = {
  body: 'broad',
  skin: 1, // Adventurer Tan (0xf0c49a)
  hairStyle: 1, // The Bob (cap + back + fringe)
  hairColor: 0, // Chestnut (0x4a2f1b)
  facialHair: 0,
  tunicColor: 0, // Adventurer Blue (hue 210)
  pantsColor: 0, // Trusty Navy (dim 210)
  eyes: 0, // Midnight (#20242e)
  cape: 0
}

/** Safe catalog pick — any out-of-range index wraps into the palette. */
export function pick<T>(arr: readonly T[], i: number): T {
  const n = arr.length
  const idx = Number.isFinite(i) ? ((Math.floor(i) % n) + n) % n : 0
  return arr[idx] as T
}

/** A fully random look (uniform across the catalogs; capes stay rare-ish). */
export function randomLook(): CharacterLook {
  const r = (n: number): number => Math.floor(Math.random() * n)
  return {
    body: Math.random() < 0.5 ? 'broad' : 'slender',
    skin: r(SKIN_TONES.length),
    hairStyle: r(HAIR_STYLES.length),
    hairColor: r(HAIR_COLORS.length),
    facialHair: Math.random() < 0.55 ? 0 : 1 + r(FACIAL_HAIR.length - 1),
    tunicColor: r(TUNIC_COLORS.length),
    pantsColor: r(PANTS_COLORS.length),
    eyes: r(EYE_COLORS.length),
    cape: Math.random() < 0.7 ? 0 : 1 + r(CAPES.length - 1)
  }
}

// ---------------------------------------------------------------------------
// Compact wire/save encoding — '1' + nine base36 digits
// ---------------------------------------------------------------------------

const FIELD_SIZES = [
  2, // body
  SKIN_TONES.length,
  HAIR_STYLES.length,
  HAIR_COLORS.length,
  FACIAL_HAIR.length,
  TUNIC_COLORS.length,
  PANTS_COLORS.length,
  EYE_COLORS.length,
  CAPES.length
] as const

function fieldsOf(look: CharacterLook): number[] {
  return [
    look.body === 'slender' ? 1 : 0,
    look.skin,
    look.hairStyle,
    look.hairColor,
    look.facialHair,
    look.tunicColor,
    look.pantsColor,
    look.eyes,
    look.cape
  ]
}

/** Pack a look into a 10-char base36 string (e.g. '1011000000'). */
export function encodeLook(look: CharacterLook): string {
  return (
    '1' +
    fieldsOf(look)
      .map((v, i) => {
        const size = FIELD_SIZES[i] ?? 1
        const n = Number.isFinite(v) ? ((Math.floor(v) % size) + size) % size : 0
        return n.toString(36)
      })
      .join('')
  )
}

/** Unpack an encodeLook string; null when the shape is wrong. */
export function decodeLook(code: unknown): CharacterLook | null {
  if (typeof code !== 'string' || code.length !== 10 || code[0] !== '1') return null
  const vals: number[] = []
  for (let i = 0; i < 9; i++) {
    const n = parseInt(code[i + 1] ?? '', 36)
    const size = FIELD_SIZES[i] ?? 1
    if (!Number.isFinite(n) || n < 0 || n >= size) return null
    vals.push(n)
  }
  return {
    body: vals[0] === 1 ? 'slender' : 'broad',
    skin: vals[1] ?? 0,
    hairStyle: vals[2] ?? 0,
    hairColor: vals[3] ?? 0,
    facialHair: vals[4] ?? 0,
    tunicColor: vals[5] ?? 0,
    pantsColor: vals[6] ?? 0,
    eyes: vals[7] ?? 0,
    cape: vals[8] ?? 0
  }
}

// ---------------------------------------------------------------------------
// Deterministic-from-name fallback (remote players on a look-less relay)
// ---------------------------------------------------------------------------

function hash(name: string, salt: number): number {
  let h = 5381 ^ (salt * 0x9e3779b9)
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) | 0
  return Math.abs(h)
}

/**
 * A stable, varied look derived purely from a display name — what remote
 * players wear when the relay doesn't carry their real look.
 */
export function lookFromName(name: string): CharacterLook {
  return {
    body: hash(name, 1) % 2 === 0 ? 'broad' : 'slender',
    skin: hash(name, 2) % SKIN_TONES.length,
    hairStyle: hash(name, 3) % HAIR_STYLES.length,
    hairColor: hash(name, 4) % HAIR_COLORS.length,
    facialHair: hash(name, 5) % 3 === 0 ? hash(name, 6) % FACIAL_HAIR.length : 0,
    tunicColor: hash(name, 7) % TUNIC_COLORS.length,
    pantsColor: hash(name, 8) % PANTS_COLORS.length,
    eyes: hash(name, 9) % EYE_COLORS.length,
    cape: hash(name, 10) % 6 === 0 ? 1 + (hash(name, 11) % (CAPES.length - 1)) : 0
  }
}
