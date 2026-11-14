/**
 * Items — ItemsAPI implementation (catalog lookup + mesh factory).
 */
import type * as THREE from 'three'
import type { ItemsAPI } from '../types'
import { CATALOG } from './catalog'
import { buildItemMesh } from './mesh'

const byId = new Map(CATALOG.map(d => [d.id, d] as const))

export const itemsApi: ItemsAPI = {
  def(id: string) {
    return byId.get(id)
  },
  all() {
    return CATALOG
  },
  buildMesh(id: string): THREE.Group {
    const d = byId.get(id)
    if (!d) console.warn(`[items] buildMesh: unknown item id "${id}" — using fallback crate`)
    return buildItemMesh(d)
  },
}
