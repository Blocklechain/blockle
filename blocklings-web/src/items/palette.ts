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

/** Index = material tier = rarity (copper, iron, steel, gold, crystal, mythic). */
export const TIER_PALETTES: readonly TierPalette[] = [
  { main: 0xb87333, dark: 0x8a5425, light: 0xd98e4f, accent: 0x6e4320 },
  { main: 0x9aa0a8, dark: 0x6f757d, light: 0xbfc5cc, accent: 0x565b63 },
  { main: 0xd3dae2, dark: 0x9fa8b2, light: 0xf0f4f8, accent: 0xa33c3c },
  { main: 0xf2c14e, dark: 0xc29226, light: 0xffe08a, accent: 0x8f6a1a },
  { main: 0x6fe3e8, dark: 0x3aa7b0, light: 0xb9f6f8, accent: 0x2a7f86, emissive: 0x1b6f74, opacity: 0.85 },
  { main: 0x9b59d0, dark: 0x6a2fa0, light: 0xc98df0, accent: 0x4a1f73, emissive: 0x3d1266 },
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
