/**
 * Blocklings — NPCs module shim.
 *
 * `main.ts` wires this via `initNpcs(api)`; the implementation lives in
 * ./npcs/. After the quests module exists, the integrator calls
 * `setQuestsApi(q)` so dialogs can offer/track quests.
 *
 * Also exports `purse` — the game-BLOCK-cents soft-currency ledger
 * (save key 'purse'). Quest blockCents rewards are wired by the
 * integrator: events.on('quest:completed', ...) -> purse.add(cents).
 */
export { initNpcs, setQuestsApi, purse } from './npcs/index'
export type { PurseAPI } from './npcs/index'
