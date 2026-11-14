/**
 * Upgrading — top-level shim (the integrator calls initUpgrading(api) in
 * main.ts and wires the inventory + items + skills + lent viewer).
 *
 * See src/upgrading/index.ts for the gear-progression engine (UPGRADE +0..+10,
 * ENCHANT 2 sockets, REFORGE), the Anvil of Ascension station, and the
 * centered Ascension panel.
 */
export { initUpgrading } from './upgrading/index'
export type { UpgradingModule, LentViewer } from './upgrading/index'
