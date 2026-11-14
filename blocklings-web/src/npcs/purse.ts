/**
 * NPCs — the player's purse of game-BLOCK-cents.
 *
 * Wallet-agnostic soft currency: quests/loot award cents (integrator wires
 * QuestDef.rewards.blockCents to purse.add), vendors drain them. Persists via
 * saveRegistry provider 'purse' (a bare number — tiny, tolerant on load).
 * NOT the on-chain wallet; nothing here touches keys or the chain.
 */
import { events } from '../events'
import { saveRegistry } from '../save/registry'

const CAP = 999_999_999

/** Starter stipend — enough for an apple and a dream. */
let cents = 25

export interface PurseAPI {
  /** Current balance in BLOCK-cents. */
  get(): number
  /** Award cents (quests, loot, the integrator's reward wiring). */
  add(amount: number, why?: string): void
  /** Try to spend; true and deducts on success, false (untouched) if broke. */
  spend(amount: number): boolean
}

export const purse: PurseAPI = {
  get(): number {
    return cents
  },
  add(amount: number, why = 'purse'): void {
    if (!Number.isFinite(amount) || amount <= 0) return
    cents = Math.min(CAP, cents + Math.floor(amount))
    events.emit('save:dirty', { why })
  },
  spend(amount: number): boolean {
    if (!Number.isFinite(amount) || amount <= 0) return false
    const a = Math.floor(amount)
    if (a > cents) return false
    cents -= a
    events.emit('save:dirty', { why: 'purse' })
    return true
  }
}

let registered = false

/** Called once by initNpcs — registers the 'purse' save provider. */
export function registerPurseSave(): void {
  if (registered) return
  registered = true
  saveRegistry.register('purse', {
    dump(): number {
      return cents
    },
    load(data: unknown): void {
      if (typeof data !== 'number' || !Number.isFinite(data)) return
      cents = Math.max(0, Math.min(CAP, Math.floor(data)))
    }
  })
}
