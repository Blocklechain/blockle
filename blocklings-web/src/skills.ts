/**
 * Blocklings — skills module shim.
 *
 * `main.ts` wires this via `initSkills(api)`; the implementation lives in
 * ./skills/. Also exports the combat hooks the integrator reads each hit:
 *   maxHpBonus()      — vitality: +4 max HP per level above 1
 *   damageReduction() — defense: 0..0.40 fraction of incoming damage soaked
 */
export { initSkills, skillsApi, maxHpBonus, damageReduction } from './skills/index'
