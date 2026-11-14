/**
 * Crafting shim (module convention: top-level src/<name>.ts exporting
 * init<Name>(api)). Heavy code lives in src/crafting/.
 *
 * Integrator wiring after init:
 *   const crafting = initCrafting(api)
 *   crafting.setInventory(inv)                      // have/need counts
 *   crafting.setSkills(skillsApi)                   // level gates + chip
 *   crafting.setSkillTree(skillTree)                // recipe gates + talents
 *   crafting.setDefSource((id) => itemsApi.def(id)) // names in the panel
 *
 * WORLD-SIDE HOOK (build time, not integrator wiring): world/index.ts calls
 * `registerCraftingStations(ctx)` from ./crafting/stations during the eager
 * build passes — it places the station props (forge/stove/alchemy/loom) with
 * the shared kit vocabulary, marks collision, and records the interact
 * anchors this module polls.
 *
 * Self-drives its per-frame tick (proximity prompt, craft progress, SFX) on
 * its own RAF loop. ONLY emits item mutations ('item:removed' inputs +
 * 'item:gained' output, source 'craft') — the inventory module applies them;
 * also emits 'xp:gained' / 'save:dirty' / 'chat:system'.
 */
export { initCrafting, type CraftingModule } from './crafting/index'
export { registerCraftingStations, stationSpots } from './crafting/stations'
