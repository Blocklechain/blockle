/**
 * Minting module core — the ALL-ITEMS NFT framework.
 *
 * Contract compliance: talks to the rest of the game ONLY via the event bus
 * + GameAPI + integrator-wired setters (+ the one allowed saveRegistry
 * import, inside store.ts). Integrator wiring in main.ts:
 *
 *   const minting = initMinting(api)
 *   minting.setWallet(() => wallet)        // WalletAPI2 (multichain, mintNft)
 *   minting.setInventory(() => inv)        // InventoryAPI (counts + bundle escrow)
 *   inv.setMintHooks({                     // inventory card ↔ shared mint flow
 *     open: (id, def) => minting.openForItem(id, def),
 *     chainsOf: (id) => minting.chainsOf(id),
 *     bundles: () => minting.bundles()
 *   })
 *
 * The marketplace gates crypto listings with the pure helpers in
 * src/minting/helpers.ts and reads live minted goods via
 * `market.setMintedSource(() => minting.mintedItems())`-style wiring.
 */
import type { ChainId, GameAPI, InventoryAPI, ItemDef, ItemInstance, WalletAPI2 } from '../types'
import { MintStore, type NftInstance } from './store'
import { createMintFlow } from './flow'

export interface MintedBundle {
  id: string
  uid: string
  qty: number
  chains: readonly ChainId[]
}

export interface MintingModule {
  /** The multichain wallet (getter — may become available late). */
  setWallet(fn: () => WalletAPI2 | null): void
  /** The inventory (counts, equipment, and bundle escrow via add/remove). */
  setInventory(fn: () => InventoryAPI | null): void

  /** Open the shared mint dialog for a catalog item id (inventory hook). */
  openForItem(id: string, def?: ItemDef): void
  /** Chains any minted instance of `id` lives on (badges on item cards). */
  chainsOf(id: string): readonly ChainId[]
  /** Minted instances of one catalog id, as contract ItemInstances. */
  instancesOf(id: string): readonly ItemInstance[]
  /** ALL minted item instances (gear copies + bundles) — marketplace feed. */
  mintedItems(): readonly ItemInstance[]
  /** Minted quantity-bundles (escrowed stackables), for bag-grid display. */
  bundles(): readonly MintedBundle[]

  /** NFT LAW trade hooks (integrator wires these into the marketplace):
   *  goods escrowed out of this save drop their ledger row via `takeByUid`;
   *  goods delivered/restored WITH mint state re-enter via `receive` —
   *  mint state travels with the item, it is never fabricated or duplicated. */
  takeByUid(uid: string): boolean
  receive(inst: ItemInstance): boolean

  dispose(): void
}

let inited: MintingModule | null = null

export function initMinting(_api: GameAPI): MintingModule {
  if (inited) return inited

  let walletSource: (() => WalletAPI2 | null) | null = null
  let invSource: (() => InventoryAPI | null) | null = null

  const store = new MintStore()
  const flow = createMintFlow({
    store,
    wallet: () => walletSource?.() ?? null,
    inventory: () => invSource?.() ?? null
  })

  const toInstance = (r: NftInstance): ItemInstance => ({
    id: r.id,
    uid: r.uid,
    mints: r.mints.map((m) => ({ ...m }))
  })

  inited = {
    setWallet(fn) {
      walletSource = fn
    },
    setInventory(fn) {
      invSource = fn
    },
    openForItem(id, def) {
      flow.open(id, def)
    },
    chainsOf(id) {
      return store.chainsOf(id)
    },
    instancesOf(id) {
      return store.of(id).map(toInstance)
    },
    mintedItems() {
      return store.all().map(toInstance)
    },
    takeByUid(uid) {
      return store.take(uid) !== null
    },
    receive(inst) {
      return store.receive(inst.id, inst.uid ?? '', 1, inst.mints ?? [])
    },
    bundles() {
      return store.bundles().map((r) => ({
        id: r.id,
        uid: r.uid,
        qty: r.qty,
        chains: r.mints.map((m) => m.chain)
      }))
    },
    dispose() {
      flow.dispose()
      inited = null
    }
  }
  return inited
}
