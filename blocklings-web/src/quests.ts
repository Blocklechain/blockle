/**
 * Quests shim (module convention: top-level src/<name>.ts exporting
 * init<Name>(api)). Heavy code lives in src/quests/.
 *
 * Integrator wiring:
 *   const quests = initQuests(api)
 *   setQuestsApi(quests)          // npcs module — dialog offers + progress
 *
 * ~29 QuestDefs across all six regions: the Elder Rowan starter chain,
 * per-region arcs ending at each BOSSES entry, gathering/profession quests,
 * and the load-bearing absurd ones (the boot, the audit, the lunch).
 * Progress is driven purely by bus events ('mob:killed' / 'gather:done' /
 * 'npc:talked' / 'region:entered' / 'item:gained'); rewards are items + xp
 * ONLY (zero earnable currency — economy law), emitted as 'item:gained'
 * (source 'quest') + 'xp:gained' + 'chat:system'; state persists via the
 * 'quests' save provider (CharacterSave.quests shape).
 * Ships its own HUD: quest-log "!" button + panel and the top-right
 * focused-quest tracker widget.
 */
export { initQuests, questsApi } from './quests/index'
