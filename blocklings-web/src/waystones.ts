/**
 * Waystones shim (module convention: top-level src/<name>.ts exporting
 * init<Name>(api)). Heavy code lives in src/waystones/.
 *
 * Integrator wiring:
 *   const waystones = initWaystones(api)
 *   // combat respawn anchor:
 *   const { pos } = waystones.lastUsedStone()
 *
 * Self-drives its per-frame tick (proximity attune, rune glow/ring orbit,
 * travel panel, fade-to-black teleport) on its own RAF loop — no update()
 * wiring needed. Persists attuned stones via the save registry ('stones'
 * provider -> CharacterSave.stones); the Village stone starts attuned.
 * Emits 'waystone:attuned' / 'waystone:traveled' / 'chat:system' /
 * 'save:dirty' on the bus.
 */
export { initWaystones, type WaystonesModule } from './waystones/index'
