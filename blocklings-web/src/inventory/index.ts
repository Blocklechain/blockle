/**
 * Inventory module wiring: core (stacks/equipment/save) + bag UI + viewer.
 */
import type { GameAPI, InventoryAPI } from '../types'
import type * as THREE from 'three'
import { InventoryCore } from './core'
import { createInventoryUI } from './ui'
import type { DefSource } from './defs'

/** What initInventory hands back: the contract API + integrator hooks. */
export interface InventoryModule extends InventoryAPI {
  /**
   * Wire the detail card's live 3D viewer to the items module:
   *   inv.setMeshSource((id) => items.buildMesh(id))
   * Until wired, a flat-color voxel placeholder is shown.
   */
  setMeshSource(fn: (id: string) => THREE.Group): void
  /**
   * Optionally wire real catalog defs (stats/desc/value) to the items module:
   *   inv.setDefSource((id) => items.def(id))
   * Until wired, defs are synthesized from the frozen id conventions.
   */
  setDefSource(fn: DefSource): void
}

export function initInventory(api: GameAPI): InventoryModule {
  const core = new InventoryCore(api)
  const viewer = createInventoryUI(api, core)

  return {
    items: () => core.items(),
    add: (id, qty, source) => core.add(id, qty, source),
    remove: (id, qty) => core.remove(id, qty),
    count: (id) => core.count(id),
    equipment: () => core.equipment(),
    equip: (id) => core.equip(id),
    unequip: (slot) => core.unequip(slot),
    equippedStats: () => core.equippedStats(),
    setMeshSource: (fn) => viewer.setMeshSource(fn),
    setDefSource: (fn) => core.setDefSource(fn)
  }
}
