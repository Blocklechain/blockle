/**
 * Blocklings — skills module shim.
 *
 * `main.ts` wires this via `initSkills(api)`; the implementation lives in
 * ./skills/. Also exports the combat hooks the integrator reads each hit:
 *   maxHpBonus()      — vitality: +4 max HP per level above 1
 *   damageReduction() — defense: 0..0.40 fraction of incoming damage soaked
 *   skillTree         — SkillTreeAPI; combat/gather/craft read aggregated
 *                       talent effects via skillTree.modifier(key) (keys like
 *                       'crit', 'cleave', 'lifesteal', 'mineSpeed',
 *                       'doubleOre', 'gatherSpeed', 'recipe:<id>', 'maxHpPct')
 *
 * Prestige hooks (wired by the integrator so the prestige module never imports
 * this one): `prestigeResetSkill(skill)` wipes a maxed skill back to level 1
 * for a Mastery star; `setPrestigeXpBonus(fn)` feeds the "+xp%" mastery perk
 * into the incoming-XP path.
 */
export {
  initSkills,
  skillsApi,
  maxHpBonus,
  damageReduction,
  skillTree,
  prestigeResetSkill,
  setPrestigeXpBonus
} from './skills/index'
