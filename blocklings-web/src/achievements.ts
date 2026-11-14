/**
 * Achievements shim (module convention: top-level src/<name>.ts exporting
 * init<Name>(api)). Heavy code lives in src/achievements/.
 *
 * Integrator wiring (main.ts) — one line, anywhere after the save module
 * (so the 'achv' provider exists before load) and ideally after the HUD:
 *   const achievements = initAchievements(api)
 *
 * 45 comedy-named achievements across combat / exploration / gathering &
 * crafting / wealth / pets / social / quests. Rewards: glory only — the
 * economy law stays intact and the panel jokes about it. Unlocks fire a
 * queued gold top-toast (3s), a 'chat:system' line and the existing
 * 'level-up' fanfare; progress persists via the additive 'achv' save key.
 */
export { initAchievements } from './achievements/index'
export type { AchievementsModule } from './achievements/index'
