/**
 * Blocklings — prestige / mastery module shim.
 *
 * `main.ts` wires this via `initPrestige(api)`; the implementation lives in
 * ./prestige/. The endgame flex layer on top of skills: prestige a level-99
 * skill (reset → 1) for a permanent Mastery star + a mastery perk; stars stack
 * and the grand total unlocks cosmetic titles + a character aura.
 *
 * Integrator contract (all wired in main.ts, since prestige never imports the
 * other feature modules):
 *
 *   const prestige = initPrestige(api)            // mounts the Mastery HUD panel
 *   prestige is a side-effecting init; the hooks below are module exports:
 *
 *   // prestige reads skills (read-only) + drives the reset through skills:
 *   setSkillLevelSource((s) => skillsApi.level(s))
 *   setSkillReset((s) => prestigeResetSkill(s))   // from ./skills
 *
 *   // skills applies the "+xp%" mastery perk by reading back from prestige:
 *   setPrestigeXpBonus((s) => masteryModifier(s, 'xpBonus'))   // on ./skills
 *
 *   // combat / gather / crafting fold the 'mod' mastery perk into their
 *   // existing talent-tree modifier source:
 *   combat.setModifierSource((key) => skillTree.modifier(key) + masteryBonus(key))
 *   gather.setSkillTree(...) — pass a wrapper whose modifier(key) adds masteryBonus(key)
 *
 *   // character aura (optional — falls back to a window CustomEvent
 *   // 'blocklings:prestige-aura' { tier, color } when the rig has no hook):
 *   setAuraSink((tier, color) => playerSetAura(tier, color))
 */
export {
  initPrestige,
  masteryModifier,
  masteryBonus,
  prestige,
  setSkillLevelSource,
  setSkillReset,
  setAuraSink
} from './prestige/index'
