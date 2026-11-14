/**
 * Achievements — engine + HUD wiring (shim: src/achievements.ts).
 *
 * Integrator wiring (main.ts): `initAchievements(api)` — everything else is
 * self-contained. The module:
 *   - listens to existing bus events ('mob:killed', 'player:died',
 *     'region:entered', 'waystone:attuned', 'waystone:traveled',
 *     'gather:done', 'xp:gained', 'level:up', 'item:minted', 'pet:minted',
 *     'market:sold', 'gold:changed', 'pet:dropped', 'quest:completed');
 *   - persists counters under the additive 'achv' save key (saveRegistry);
 *   - on unlock: queued gold toast from the top (3s), a 'chat:system' line,
 *     the existing 'level-up' fanfare, and a trophy-button pulse;
 *   - mounts the trophy button (bottom-right stack) + centered panel.
 *
 * First-chat detection: 'chat:send' has no bus event, so the module wraps
 * `api.chatSend` through a property interceptor — a transparent pass-through
 * that survives the integrator's later reassignment (main.ts points it at
 * the net relay after world boot). Local slash commands never hit chatSend,
 * so /who is not "chatting".
 *
 * /who sightings ("Confirmed: Not Alone"): the chat's /who output is local
 * DOM, so the engine instead samples the net module's duck-typed
 * `window.blocklingsWho` hook once a minute; a sample with ≥1 other player
 * online counts as a sighting. `noteWhoSighting()` is also exposed for the
 * integrator to wire directly if the chat module ever grows a hook.
 */
import type { GameAPI } from '../types'
import { events } from '../events'
import { createEngine } from './engine'
import { createToasts } from './toast'
import { createPanel } from './panel'
import './achievements.css'

const WHO_POLL_MS = 60_000

/** Net module's duck-typed online-players hook (see ui/chat.ts). */
interface WhoGlobals {
  blocklingsWho?: () => readonly (string | { name: string; level?: number })[] | undefined
}

export interface AchievementsModule {
  /** Open the achievements panel programmatically. */
  openPanel(): void
  /** Unlock count (profile flex / debugging). */
  unlockedCount(): number
  /** Integrator hook: the local player sent a chat message. */
  noteChatSent(): void
  /** Integrator hook: the player saw other players online (e.g. via /who). */
  noteWhoSighting(): void
}

export function initAchievements(api: GameAPI): AchievementsModule {
  const uiMount = document.getElementById('ui')
  if (!uiMount) throw new Error('missing #ui overlay mount')

  const root = document.createElement('div')
  root.className = 'ach-root'
  uiMount.appendChild(root)

  const engine = createEngine()
  const toasts = createToasts(root)
  const panel = createPanel(root, engine)

  engine.onUnlock = (def) => {
    toasts.push(def)
    panel.flashButton()
    panel.refresh() // no-op while the panel is closed
    events.emit('chat:system', {
      text: `Achievement unlocked: "${def.name}". Reward: glory (non-transferable).`,
    })
  }

  // ---- bus wiring ---------------------------------------------------------
  events.on('mob:killed', (e) => engine.noteKill(e.species, e.boss === true))
  events.on('player:died', () => engine.noteDeath())
  events.on('region:entered', (e) => engine.noteRegion(e.regionId))
  events.on('waystone:attuned', (e) => engine.noteAttune(e.stoneId))
  events.on('waystone:traveled', () => engine.noteTravel())
  events.on('gather:done', (e) => engine.noteGather(e.skill))
  events.on('xp:gained', (e) => engine.noteXp(e.skill))
  events.on('level:up', (e) => engine.noteLevel(e.level))
  events.on('item:minted', (e) => engine.noteMint(e.uid, e.chain))
  events.on('pet:minted', (e) => engine.noteMint(e.uid, e.chain))
  events.on('market:sold', () => engine.noteSale())
  events.on('gold:changed', (e) => engine.noteGold(e.balance))
  events.on('pet:dropped', (e) => engine.notePet(e.variant))
  events.on('quest:completed', (e) => engine.noteQuestDone(e.questId))

  // ---- first-chat interceptor (survives later chatSend reassignment) ------
  let innerChatSend: (msg: string) => void = api.chatSend.bind(api)
  try {
    Object.defineProperty(api, 'chatSend', {
      configurable: true,
      enumerable: true,
      get: () => (msg: string): void => {
        engine.noteChat()
        innerChatSend(msg)
      },
      set: (fn: (msg: string) => void) => {
        innerChatSend = fn
      },
    })
  } catch {
    /* frozen api object — the integrator hook noteChatSent() still works */
  }

  // ---- /who sightings: sample the net roster once a minute ----------------
  const sampleWho = (): void => {
    const hook = (window as unknown as WhoGlobals).blocklingsWho
    const raw = hook?.()
    if (!raw) return
    const others = raw
      .map((e) => (typeof e === 'string' ? e : e.name))
      .filter((name) => name && name !== api.player.name)
    if (others.length > 0) engine.noteWho()
  }
  window.setInterval(sampleWho, WHO_POLL_MS)

  return {
    openPanel: () => panel.open(),
    unlockedCount: () => engine.unlockedCount(),
    noteChatSent: () => engine.noteChat(),
    noteWhoSighting: () => engine.noteWho(),
  }
}
