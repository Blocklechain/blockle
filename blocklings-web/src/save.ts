/**
 * Save module shim (contract: src/<name>.ts exporting init<Name>(api)).
 *
 * Integrator wiring: call initSave(api) FIRST among the stateful modules —
 * it loads the persisted envelope immediately and late-applies each module's
 * blob as its saveRegistry provider registers. Heavy code in src/save/.
 */
export { initSave, saveNow, type SaveEnvelope } from './save/core'
