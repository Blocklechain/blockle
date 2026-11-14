/**
 * Inventory module wiring: core (stacks/equipment/save) + bag UI + viewer.
 */
import type { GameAPI, InventoryAPI } from '../types'
import type * as THREE from 'three'
import { InventoryCore } from './core'
import { createInventoryUI, type MintHooks } from './ui'
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
  /**
   * Wire the minting module's shared flow into the item cards:
   *   inv.setMintHooks({ open, chainsOf, bundles })
   */
  setMintHooks(hooks: MintHooks): void
  /**
   * Wire the upgrading module's per-item delta into equippedStats:
   *   inv.setUpgradeBonus(upgrading.bonusFor)
   * The delta (from +levels / enchants / reforge) is summed on top of the
   * catalog spread. Until wired, gear reads its base catalog stats only.
   */
  setUpgradeBonus(
    fn: (
      id: string,
      base: { atk: number; def: number; str: number; int: number; agi: number }
    ) => Partial<{ atk: number; def: number; str: number; int: number; agi: number }>
  ): void
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
    setMeshSource: (fn) => viewer.viewer.setMeshSource(fn),
    setDefSource: (fn) => core.setDefSource(fn),
    setMintHooks: (hooks) => viewer.setMintHooks(hooks),
    setUpgradeBonus: (fn) => core.setUpgradeBonus(fn)
  }
}
