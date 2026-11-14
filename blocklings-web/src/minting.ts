/**
 * Minting shim (module convention: top-level src/<name>.ts exporting
 * init<Name>(api)). Heavy code lives in src/minting/.
 *
 * Integrator wiring after init:
 *   const minting = initMinting(api)
 *   minting.setWallet(() => wallet)                 // WalletAPI2 (mintNft)
 *   minting.setInventory(() => inv)                 // counts + bundle escrow
 *   inv.setMintHooks({                              // card Mint button + badges
 *     open: (id, def) => minting.openForItem(id, def),
 *     chainsOf: (id) => minting.chainsOf(id),
 *     bundles: () => minting.bundles()
 *   })
 *
 * The marketplace gates crypto listings with the pure mintedOnly helpers
 * below (NFT LAW: crypto price on chain C requires a MintRecord on chain C;
 * gold listings need no mint) and reads live minted goods via
 * `minting.mintedItems()` through its own integrator-wired setter.
 */
export { initMinting, type MintingModule, type MintedBundle } from './minting/index'
export {
  isMinted,
  mintedOn,
  mintedChains,
  canListForCrypto,
  mintedOnly,
  type MaybeMintable
} from './minting/helpers'
