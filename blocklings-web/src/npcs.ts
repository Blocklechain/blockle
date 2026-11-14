/**
 * Blocklings — NPCs module shim.
 *
 * `main.ts` wires this via `initNpcs(api)`; the implementation lives in
 * ./npcs/. After the quests module exists, the integrator calls
 * `setQuestsApi(q)` so dialogs can offer/track quests.
 *
 * Vendors anchor prices in REAL crypto (mostly BLOCK, a couple ETH/SOL
 * novelties) and every item is payable on four rails — BLOCK/ETH/SOL/GOLD —
 * at vendor-posted rates. The integrator wires crypto with `setPay(fn)` —
 * typically `(chain, amount) => wallet.sendOn(chain, TREASURY[chain],
 * amount)` — and GOLD with `setGoldPay(fn)` — typically the gold module's
 * `spendGold`. Pass null to unwire (shop stays browsable; crypto rails read
 * 'Wallet required', GOLD reads 'Sign in for Gold'). There is NO soft
 * currency; the old purse/BLOCK-cents ledger is gone.
 */
export { initNpcs, setQuestsApi, setPay, setGoldPay } from './npcs/index'
export type { VendorPayFn, GoldPayFn } from './npcs/index'
