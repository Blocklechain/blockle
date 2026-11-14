/**
 * Blocklings — typed global event bus.
 *
 * Systems (combat, quests, skills, inventory, gathering, save, UI) communicate
 * ONLY through this bus + the GameAPI; feature modules never import each other.
 * Part of the frozen contract — do not change existing event shapes.
 */
import type * as THREE from 'three'

export interface GameEvents {
  /** A mob died (killed by the local player unless noted). */
  'mob:killed': { species: string; level: number; pos: THREE.Vector3; boss?: boolean }
  /** The player dealt damage to a mob. */
  'mob:hit': { species: string; amount: number; crit: boolean; pos: THREE.Vector3 }
  /** The local player took damage. */
  'player:damaged': { amount: number; from: string }
  /** The local player died and respawned. */
  'player:died': { at: THREE.Vector3 }

  /** Items entered the player's possession (loot, gather, quest, craft, buy). */
  'item:gained': { id: string; qty: number; source: 'loot' | 'gather' | 'quest' | 'craft' | 'vendor' | 'restore' }
  /** Items were removed (consumed, sold, dropped). */
  'item:removed': { id: string; qty: number }
  /** Equipment changed in a slot (id null = unequipped). */
  'item:equipped': { slot: string; id: string | null }

  /** Skill XP gained. */
  'xp:gained': { skill: string; amount: number }
  /** A skill reached a new level. */
  'level:up': { skill: string; level: number }

  /** The player finished a dialog with an NPC. */
  'npc:talked': { npcId: string }
  /** Quest lifecycle. */
  'quest:accepted': { questId: string }
  'quest:progress': { questId: string; step: number; done: number; need: number }
  'quest:completed': { questId: string }

  /** A resource node was successfully gathered. */
  'gather:done': { nodeType: string; itemId: string; skill: string }

  /** The player crossed into a region. */
  'region:entered': { regionId: string }

  /** The player attuned a new teleport waystone (now a travel target). */
  'waystone:attuned': { stoneId: string }
  /** The player teleported between waystones. */
  'waystone:traveled': { from: string; to: string }

  /** Show a system line in chat / toast. */
  'chat:system': { text: string }
  /** Any persistent state changed; the save module debounces writes on this. */
  'save:dirty': { why: string }
}

type Handler<K extends keyof GameEvents> = (payload: GameEvents[K]) => void

class EventBus {
  private handlers = new Map<string, Set<Handler<never>>>()

  on<K extends keyof GameEvents>(event: K, fn: Handler<K>): () => void {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(fn as Handler<never>)
    return () => set.delete(fn as Handler<never>)
  }

  emit<K extends keyof GameEvents>(event: K, payload: GameEvents[K]): void {
    const set = this.handlers.get(event)
    if (!set) return
    for (const fn of [...set]) {
      try {
        ;(fn as Handler<K>)(payload)
      } catch (e) {
        console.error(`[events] handler for ${event} threw`, e)
      }
    }
  }
}

/** The one global bus. */
export const events = new EventBus()
