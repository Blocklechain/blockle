/**
 * World-map shim (module convention: top-level src/<name>.ts exporting
 * init<Name>(api)). Heavy code lives in src/worldmap/.
 *
 * Integrator wiring after init:
 *   const map = initWorldmap(api)
 *   map.setAttuned(save.stones)              // loaded attuned waystones
 *   map.setRequestTravel(id => ws.travel(id))// waystones module teleport flow
 *   map.setEntitySource(() => blips)         // live mob/node mini-map blips
 *
 * Provides the full-screen continent map (HUD button + M key, tap a lit
 * waystone to travel) and the top-right mini-map circle (settings hook:
 * setMinimapVisible / window.blocklingsSetMinimap). Self-driving; no
 * per-frame update() wiring needed.
 */
export { initWorldmap } from './worldmap/index'
export type { WorldmapModule, WorldmapEntity } from './worldmap/index'
