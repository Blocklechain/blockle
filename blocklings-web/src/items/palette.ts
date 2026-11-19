/**
 * Items — material-tier palettes + shared color constants.
 *
 * The six-material ladder (copper..mythic) maps 1:1 onto the six rarity
 * tiers. Every voxel item mesh derives its colors from these so the whole
 * catalog reads as one cozy flat-color family (matching the world's
 * VoxelBatch Lambert look — no textures, ever).
 */

export interface TierPalette {
  /** Primary metal/material color. */
  main: number
  /** Shadowed/darker variant (guards, collars, sockets). */
  dark: number
  /** Highlight variant (edges, shine stripes). */
  light: number
  /** Accent (plumes, bosses, trims). */
  accent: number
  /** Set on glowy tiers (crystal, mythic). */
  emissive?: number
  /** Set on translucent tiers (crystal). */
  opacity?: number
}

/**
 * Index = material tier. The first six (copper, iron, steel, gold, crystal,
 * mythic) map 1:1 onto rarity. Tiers 6..11 are the late-game mesh tiers
 * (obsidian, dragonbone, void, astral, titan, runic) — each a distinct,
 * attractive set, with glow (`emissive`) on the top tiers so endgame armor
 * reads as genuinely otherworldly. The first six colors are UNCHANGED.
 */
export const TIER_PALETTES: readonly TierPalette[] = [
  { main: 0xb87333, dark: 0x8a5425, light: 0xd98e4f, accent: 0x6e4320 },
  { main: 0x9aa0a8, dark: 0x6f757d, light: 0xbfc5cc, accent: 0x565b63 },
  { main: 0xd3dae2, dark: 0x9fa8b2, light: 0xf0f4f8, accent: 0xa33c3c },
  { main: 0xf2c14e, dark: 0xc29226, light: 0xffe08a, accent: 0x8f6a1a },
  { main: 0x6fe3e8, dark: 0x3aa7b0, light: 0xb9f6f8, accent: 0x2a7f86, emissive: 0x1b6f74, opacity: 0.85 },
  { main: 0x9b59d0, dark: 0x6a2fa0, light: 0xc98df0, accent: 0x4a1f73, emissive: 0x3d1266 },
  // --- late-game tiers (6..11) ---------------------------------------------
  // 6 obsidian — volcanic glass-black with a violet sheen (no glow, pure menace)
  { main: 0x2c2c36, dark: 0x16161d, light: 0x4a4a59, accent: 0x7a4ad0 },
  // 7 dragonbone — bleached ivory bone with a crimson wyrm-blood accent
  { main: 0xe8dcc2, dark: 0xb09a76, light: 0xf6eedd, accent: 0xb5202a },
  // 8 void — deep indigo nothing, lit from within by violet
  { main: 0x2a1f4a, dark: 0x150f2c, light: 0x5a3fa6, accent: 0x9b6aff, emissive: 0x3a1f7a },
  // 9 astral — cosmic blue starlight, faintly glowing
  { main: 0x3a6ad0, dark: 0x23489a, light: 0x8ab6ff, accent: 0xb9e0ff, emissive: 0x2a5ad0 },
  // 10 titan — molten bronze-orange, radiating heat
  { main: 0xd98030, dark: 0xa85a1e, light: 0xffb060, accent: 0xffd98a, emissive: 0xff6a1a },
  // 11 runic — radiant ivory-gold etched with cyan runes (strongest glow, top tier)
  { main: 0xf4ead0, dark: 0xc9b98a, light: 0xffffff, accent: 0x6fe3ff, emissive: 0x9fe8ff },
] as const

/** Render opts a palette implies (glow + translucency for high tiers). */
export interface VoxOpts {
  emissive?: number
  emissiveIntensity?: number
  opacity?: number
}

export function tierOpts(p: TierPalette): VoxOpts {
  const o: VoxOpts = {}
  if (p.emissive !== undefined) {
    o.emissive = p.emissive
    o.emissiveIntensity = 0.55
  }
  if (p.opacity !== undefined) o.opacity = p.opacity
  return o
}

/** A faint rarity-4+ glow for one-off items that aren't crystal/mythic metal. */
export function faintGlow(color: number): VoxOpts {
  return { emissive: color, emissiveIntensity: 0.3 }
}

// Shared non-tier colors (handles, straps, nature, food).
export const WOOD = 0x6b4a2d
export const WOOD_DARK = 0x523722
export const WOOD_LIGHT = 0xc9a06c
export const LEATHER = 0x7a5a3a
export const STRING = 0xe8e2d0
export const STONE = 0x7a7d82
export const STONE_DARK = 0x5e6166
export const LEAF = 0x5a9e42
export const LEAF_DARK = 0x3f7a35
