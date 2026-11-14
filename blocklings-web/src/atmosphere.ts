/**
 * Barrel for the atmosphere module (real-time CST day/night cycle) —
 * main.ts wires feature modules through these top-level shims, so this
 * one-liner is what plugs src/atmosphere/ into the game.
 */
export { initAtmosphere, type AtmosphereAPI } from './atmosphere/index'
