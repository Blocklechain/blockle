/**
 * Save registry (frozen contract, authored with types.ts).
 *
 * The ONE allowed cross-module import: stateful modules (inventory, skills,
 * quests, waystones, player) import { saveRegistry } and register a provider.
 * The save module serializes all providers into CharacterSave-compatible JSON
 * (debounced on 'save:dirty'), persists locally + to the Blockle account, and
 * calls load() on boot before the world is entered.
 */
export interface SaveProvider {
  /** Serialize this module's persistent state (small! total save < 16KB). */
  dump(): unknown
  /** Restore from a previously dumped value (tolerate missing/old shapes). */
  load(data: unknown): void
}

class SaveRegistry {
  readonly providers = new Map<string, SaveProvider>()
  register(key: string, p: SaveProvider): void {
    this.providers.set(key, p)
  }
}

export const saveRegistry = new SaveRegistry()
