/**
 * Dungeon shim (module convention: top-level src/<name>.ts exporting
 * init<Name>(api)). Heavy code lives in src/dungeon/.
 *
 * TRIAL OF THE DEEP — repeatable wave-survival in a self-contained voxel
 * arena, entered from the gate prop in the Ashen Dungeons region.
 *
 * Integrator wiring (in main.ts enterWorld, after combat is up — it reuses the
 * same MobRig + player swing + stat sources combat uses):
 *
 *   const dungeon = initDungeon(api)
 *   dungeon.setMobRigSource((species, boss) => {
 *     const def = SPECIES.find((s) => s.id === species)
 *     return def ? new MobRig(def, boss) : null   // MobRig is MobRigLike structurally
 *   })
 *   dungeon.setStatsSource(() => inv.equippedStats())
 *   dungeon.setSkillsSource((s) => skillsApi.level(s))
 *   dungeon.setModifierSource((key) => skillTree.modifier(key))
 *   dungeon.setInventory(inv)                              // ONLY inventory mutates stacks
 *   dungeon.setPlayerDamage((amount) => { player.hp = Math.max(0, player.hp - amount); playerHurt() })
 *   dungeon.setPlayerDeath((onDown) => playerDie(onDown))
 *   dungeon.setAttackTrigger(() => triggerAttack())
 *   onAttack(() => dungeon.onPlayerStrike())               // in ADDITION to combat.playerStrike()
 *
 * Self-drives its own RAF loop (gate proximity + run loop); no update() wiring.
 * Persists per-tier bests / banked Deep Shards / cosmetics via the save
 * registry ('dungeon'). Emits 'dungeon:cleared' (+ reuses 'mob:hit' /
 * 'mob:killed' / 'xp:gained' so music, pets, achievements and quests all react
 * to arena fights). Returns the player to their exact entry spot on exit.
 */
export { initDungeon, type DungeonModule, type DungeonStats } from './dungeon/index'
