/**
 * Blocklings — the context-aware INTERACT action registry.
 *
 * The mobile INTERACT button (and anyone else who cares) shows ONE action
 * whose symbol depends on what the player is standing next to. Rather than
 * poll every module every frame, each interact module PUSHES its current
 * best option into this tiny singleton from its OWN per-frame proximity
 * tick — `publish(id, opt)` while something is in range, `publish(id, null)`
 * when nothing is. `resolve()` returns the published option with the LOWEST
 * priority number (attack=1 beats gather=2 beats talk/travel/craft=3), so
 * the button always offers the most urgent thing.
 *
 * No deps, no DOM, no events — just a shared map. Modules stay decoupled:
 * they never import each other, only this.
 */

/** The glyph the INTERACT button renders. */
export type ActionIcon =
  | 'sword'
  | 'axe'
  | 'pick'
  | 'hook'
  | 'sickle'
  | 'hand'
  | 'talk'
  | 'portal'
  | 'anvil'
  | 'door'

/** One candidate action a module is offering right now. */
export interface ActionOption {
  /** Lower wins. attack=1, gather=2, interact(talk/travel/craft/door)=3. */
  priority: number
  /** Which glyph the button shows. */
  icon: ActionIcon
  /** Human label (accessibility / future HUD use). */
  label: string
  /** Perform the action. */
  invoke(): void
}

class ActionContext {
  private readonly options = new Map<string, ActionOption>()

  /** Publish (or clear with null) the option a module source is offering. */
  publish(id: string, opt: ActionOption | null): void {
    if (opt) this.options.set(id, opt)
    else this.options.delete(id)
  }

  /** The highest-urgency (lowest-priority-number) published option, or null. */
  resolve(): ActionOption | null {
    let best: ActionOption | null = null
    for (const opt of this.options.values()) {
      if (best === null || opt.priority < best.priority) best = opt
    }
    return best
  }
}

/** Process-wide singleton (modules import this, never each other). */
export const actionContext = new ActionContext()
