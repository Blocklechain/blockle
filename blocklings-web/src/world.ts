/**
 * Barrel for the world module — main.ts discovers feature modules with
 * import.meta.glob('./world.ts'), which matches files literally (it does
 * not resolve directory indexes), so this one-liner is what wires
 * src/world/ into the game.
 */
export { createWorld } from './world/index'
