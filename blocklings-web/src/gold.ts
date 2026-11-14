/**
 * GOLD shim (module convention: top-level src/<name>.ts exporting
 * init<Name>(api)). Heavy code lives in src/gold/.
 *
 * Integrator wiring:
 *   const gold = initGold(api)   // returns the contract GoldAPI
 *   // hand `gold` to the market/shop modules via their setters
 *
 * GOLD is the IAP-only premium currency: server-authoritative balance on the
 * Blockle account, purchasable solely through the iOS shell's StoreKit bridge
 * (window.blocklingsIAP — see src/gold/index.ts for the bridge contract).
 * Never earned in-game, never cashed out, no gold->crypto bridge.
 */
export { initGold, spendGold, type GoldModule, type BlocklingsIAPBridge } from './gold/index'
