/**
 * Gathering-professions shim (module convention: top-level src/<name>.ts
 * exporting init<Name>(api)). Heavy code lives in src/gather/.
 *
 * Integrator wiring after init:
 *   const gather = initGather(api)
 *   gather.setInventory(inv)              // tool-slot reads (gating + speed)
 *   gather.setSwing(() => triggerAttack())// arm-swing during the harvest bar
 *
 * The module self-drives its per-frame tick (proximity prompt, progress,
 * node bob/sparkle, respawns) on its own RAF loop — no update() wiring
 * needed. All item/xp flow goes through the event bus ('item:gained',
 * 'xp:gained', 'gather:done'); it never mutates inventory directly.
 */
export { initGather, type GatherModule } from './gather/index'
