/**
 * Items module shim — catalog + voxel meshes for every item.
 *
 * `initItems(api)` registers the module (the catalog is static data, so
 * there is nothing to wire beyond a dev-time sanity check); integrators
 * import the ItemsAPI instance directly:
 *
 *   import { itemsApi } from './items'
 */
import type { GameAPI } from './types'
import { NODE_KINDS } from './ids'
import { itemsApi } from './items/index'

export { itemsApi }

export function initItems(api: GameAPI): void {
  void api // catalog is static; nothing to wire into the scene here.

  // Dev-time sanity: every resource node's drop must exist in the catalog.
  for (const node of NODE_KINDS) {
    if (!itemsApi.def(node.itemId)) {
      console.warn(`[items] node kind "${node.id}" drops unknown item "${node.itemId}"`)
    }
  }
}
