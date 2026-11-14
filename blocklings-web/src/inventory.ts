/**
 * Inventory shim (module convention: top-level src/<name>.ts exporting
 * init<Name>(api)). Heavy code lives in src/inventory/.
 *
 * Integrator wiring after init:
 *   const inv = initInventory(api)
 *   inv.setMeshSource((id) => items.buildMesh(id)) // live 3D item viewer
 *   inv.setDefSource((id) => items.def(id))        // real catalog defs
 */
export { initInventory, type InventoryModule } from './inventory/index'
