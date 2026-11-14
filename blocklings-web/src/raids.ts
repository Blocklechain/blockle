/**
 * Raids shim (module convention: top-level src/<name>.ts exporting
 * init<Name>(api)). Heavy code lives in src/raids/.
 *
 * RAID BOSSES — four giant, multi-phase APEX world bosses summoned at altars
 * in the far outer zones (The Frostwyrm lv50, The Magma Colossus lv65, The
 * Bone Tyrant lv80, Grukk the Eternal lv99). Telegraphed AoEs, spawned adds,
 * phase transitions with comedy taunts + reused boss themes, a soft-enrage
 * timer, a shared top-of-screen boss-HP bar, and a ~10-minute per-boss
 * cooldown. Loot: guaranteed EPIC+ real gear, a chance at a unique LEGENDARY,
 * raid tokens (gear-upgrade material), a royal treat, and the species' rare
 * ascended boss-baby pet.
 *
 * Integrator wiring (in main.ts enterWorld, after combat is up — it reuses the
 * same MobRig + player swing + stat/skill/modifier sources combat uses):
 *
 *   const raids = initRaids(api)
 *   raids.setMobRigSource((species, boss) => {
 *     const def = SPECIES.find((s) => s.id === species)
 *     return def ? new MobRig(def, boss) : null   // MobRig is MobRigLike structurally
 *   })
 *   raids.setStatsSource(() => inv.equippedStats())
 *   raids.setSkillsSource((s) => skillsApi.level(s))
 *   raids.setModifierSource((key) => skillTree.modifier(key) + masteryBonus(key))
 *   raids.setInventory(inv)                               // ONLY inventory mutates stacks
 *   raids.setPlayerDamage((amount) => { player.hp = Math.max(0, player.hp - amount); playerHurt() })
 *   raids.setPlayerDeath((onDown) => playerDie(onDown))
 *   raids.setAttackTrigger(() => triggerAttack())
 *   raids.setPresenceSource(() => [...hero.net.remotes.values()].map((r) => ({ x: r.pos.x, z: r.pos.z })))
 *   onAttack(() => raids.onPlayerStrike())                // in ADDITION to combat.playerStrike()
 *
 * Self-drives its own RAF loop (altar proximity + fight loop); no update()
 * wiring. Places its four altar props into api.scene and registers their
 * collision by wrapping world.isBlocked. Persists per-boss cooldowns via the
 * save registry ('raids'). Emits 'mob:hit'/'mob:killed'/'xp:gained' so music,
 * pets, achievements and quests all react to the raid; drops land through the
 * inventory module ('item:gained').
 */
export {
  initRaids,
  type RaidsModule,
  type RaidStats,
  type RaiderPresence
} from './raids/index'
