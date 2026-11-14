/**
 * Quest tracking — the one shared "which quest has the sparkles" slot.
 *
 * A deliberately tiny leaf store so the quest log (./index), the job board
 * (./contracts + ./board) and the guide trail (./guide) can all agree on the
 * single tracked quest/contract without importing each other. Exactly one id
 * is tracked at a time (tracking another switches); the id is persisted as an
 * additive `tracked` field inside the existing 'quests' save blob (./index
 * owns the provider — this store just holds the value).
 */
import { events } from '../events'

let tracked: string | null = null
const listeners = new Set<(id: string | null) => void>()

/** The tracked quest/contract id, or null when nothing is tracked. */
export function trackedId(): string | null {
  return tracked
}

/**
 * Track `id` (null = untrack). Tracking a new id switches off the old one —
 * there is only ever one trail of sparkles. `silent` skips the save:dirty
 * (used when restoring from the save blob).
 */
export function setTracked(id: string | null, silent = false): void {
  if (tracked === id) return
  tracked = id
  for (const fn of [...listeners]) {
    try {
      fn(tracked)
    } catch (e) {
      console.error('[quests/tracking] listener threw', e)
    }
  }
  if (!silent) events.emit('save:dirty', { why: `quest:track:${id ?? 'off'}` })
}

/** Subscribe to tracked-id changes. Returns an unsubscribe. */
export function onTrackedChange(fn: (id: string | null) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
