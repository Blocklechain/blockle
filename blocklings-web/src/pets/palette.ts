/**
 * Variant palettes for pets.
 *
 * A pet is a mini (0.45x) rebuild of its species voxel model; this file owns
 * the recolor pass that turns the base species materials into the variant
 * look (ember / snow / golden / shadow), the little aura accents, and the
 * CSS-side colors the collection panel uses for tiles and rarity borders.
 *
 * The recolor traverses a freshly-built rig group and mutates its PER-RIG
 * Lambert materials in place (combat's builder clones materials per rig, so
 * nothing leaks onto real mobs). Shared face textures are never touched —
 * only the material's color tint.
 */
import * as THREE from 'three'
import type { PetVariant } from '../types'

export type AuraKind = 'none' | 'glint' | 'wisp' | 'ember'

export interface VariantLook {
  /** UI accent (rarity border / badges). */
  accent: string
  /** Panel label for the rarity bracket. */
  rarity: string
  aura: AuraKind
}

export const VARIANT_LOOK: Record<PetVariant, VariantLook> = {
  base: { accent: '#8fa08f', rarity: 'Common', aura: 'none' },
  ember: { accent: '#ff7a2b', rarity: 'Rare', aura: 'ember' },
  snow: { accent: '#9fdcff', rarity: 'Rare', aura: 'none' },
  golden: { accent: '#e8c15a', rarity: 'Epic', aura: 'glint' },
  shadow: { accent: '#b48cff', rarity: 'Epic', aura: 'wisp' },
  boss: { accent: '#f2c43d', rarity: 'Boss Baby', aura: 'glint' },
}

/** Face-material tint (face mats carry the shared pixel-face texture). */
const FACE_TINT: Partial<Record<PetVariant, number>> = {
  ember: 0xffd9b8,
  snow: 0xeaf6ff,
  golden: 0xffeebb,
  shadow: 0xcbb3e8,
}

/** Transform one body color into the variant palette. Mutates `c`; returns the emissive. */
function transformColor(c: THREE.Color, variant: PetVariant): THREE.Color | null {
  const hsl = { h: 0, s: 0, l: 0 }
  c.getHSL(hsl)
  switch (variant) {
    case 'ember': {
      // fiery oranges + inner glow
      c.setHSL(0.03 + hsl.h * 0.08, Math.max(0.72, hsl.s), Math.min(0.72, hsl.l * 0.95 + 0.06))
      return c.clone().multiplyScalar(0.35)
    }
    case 'snow': {
      // white / pale ice
      c.setHSL(0.56, hsl.s * 0.22, Math.min(0.92, hsl.l * 1.25 + 0.3))
      return c.clone().multiplyScalar(0.08)
    }
    case 'golden': {
      // gold, with a soft sheen
      c.setHSL(0.118, 0.72, Math.min(0.78, hsl.l * 1.05 + 0.18))
      return c.clone().multiplyScalar(0.22)
    }
    case 'shadow': {
      // dark + purple
      c.setHSL(0.76, 0.5 + hsl.s * 0.2, Math.max(0.08, hsl.l * 0.32))
      return new THREE.Color(0.09, 0.03, 0.15)
    }
    default:
      return null // base + boss keep the species' own colors
  }
}

/**
 * Recolor a freshly-built species rig for the variant. Safe to call once per
 * rig (materials are visited through a Set so shared instances transform once).
 */
export function applyVariantPalette(root: THREE.Object3D, variant: PetVariant): void {
  if (variant === 'base' || variant === 'boss') return
  const seen = new Set<THREE.Material>()
  const faceTint = FACE_TINT[variant]
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
    for (const mat of mats) {
      if (!(mat instanceof THREE.MeshLambertMaterial) || seen.has(mat)) continue
      seen.add(mat)
      if (mat.map) {
        // the pixel face: tint only, never touch the shared texture
        if (faceTint !== undefined) mat.color.setHex(faceTint)
        continue
      }
      const emissive = transformColor(mat.color, variant)
      if (emissive) mat.emissive.copy(emissive)
    }
  })
}

/**
 * Build the little variant aura (parented at roughly head height by the
 * companion, which also animates it per `kind`). Fresh geometry+materials;
 * dispose via disposeAura().
 */
export function buildAura(variant: PetVariant): { group: THREE.Group; kind: AuraKind } | null {
  const kind = VARIANT_LOOK[variant].aura
  if (kind === 'none') return null
  const group = new THREE.Group()
  const bit = (size: number, color: number, opacity: number): THREE.Mesh => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(size, size, size),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false })
    )
    group.add(mesh)
    return mesh
  }
  switch (kind) {
    case 'glint':
      bit(0.09, 0xfff3c0, 0.95)
      bit(0.06, 0xffffff, 0.9)
      break
    case 'wisp':
      bit(0.12, 0x8a5cff, 0.65)
      bit(0.07, 0xc9aaff, 0.55)
      break
    case 'ember':
      bit(0.07, 0xff9a3b, 0.85)
      bit(0.05, 0xffd34d, 0.8)
      break
  }
  return { group, kind }
}

export function disposeAura(group: THREE.Group): void {
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose()
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
      for (const mat of mats) mat.dispose()
    }
  })
}

/** CSS color for a collection tile: the species base color pushed through the variant palette. */
export function variantTileColor(speciesColorHex: number, variant: PetVariant): string {
  const c = new THREE.Color(speciesColorHex)
  transformColor(c, variant)
  return `#${c.getHexString()}`
}
