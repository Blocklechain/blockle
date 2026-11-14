/**
 * Marketplace shim (module convention: top-level src/<name>.ts exporting
 * init<Name>(api)). Heavy code lives in src/market/.
 *
 * Integrator wiring after init:
 *   const market = initMarket(api)              // returns the contract MarketAPI
 *   market.setGold(gold)                        // GoldAPI (balance checks on GOLD buys)
 *   market.setWallet(wallet2)                   // WalletAPI2 (crypto rail: sendOn)
 *   market.setInventory(inv)                    // escrow / restore / deliver items
 *   market.setPets({ list, remove, add })       // escrow / restore / deliver pets
 *   market.setMeshSource((defId) => items.buildMesh(defId))     // spinning item cards
 *   market.setPetMeshSource((petId) => pets.buildMesh(petId))   // spinning pet cards
 *   market.setDefSource((id) => items.def(id))
 *
 * Server: services/accounts /account/api/game/market* (src/gamemarket.js).
 * Settlement truth: GOLD settles atomically server-side in one ledger txn;
 * CRYPTO is a real wallet-signed payment to the seller's own address —
 * BLOCK verified on-chain via the explorer before completing, ETH/SOL
 * complete with an honest 'payment attested by buyer' status.
 * ECONOMY LAW: crypto-priced listings REQUIRE goods minted on the price
 * chain (uid + MintRecord); gold listings need no mint.
 */
export {
  initMarket,
  goodsName,
  type MarketModule,
  type MarketInternal,
  type PetsHooks,
  type WireListing
} from './market/index'
