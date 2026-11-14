/**
 * Combat shim — the monster kingdom.
 *
 * Usage (integrator, in main.ts):
 *   const combat = initCombat(api)
 *   combat.setStatsSource(() => inv.equippedStats())
 *   combat.setSkillsSource((s) => skills.level(s))
 *   combat.setMeshSource((id) => itemsApi.buildMesh(id))
 *   combat.setPlayerDamage((amount) => { player.hp = Math.max(0, player.hp - amount); playerHurt() })
 *   combat.setPlayerDeath((onDown) => playerDie(onDown))
 *   onAttack(() => combat.playerStrike())
 *
 * Everything else — spawning, AI, blood, loot drops, damage numbers,
 * respawn-at-last-waystone — runs itself off the event bus.
 */
export { initCombat, setAutoRetaliate } from './combat/index'
export type { CombatModule, EquippedStats } from './combat/index'
