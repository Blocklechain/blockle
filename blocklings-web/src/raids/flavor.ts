/**
 * Raid comedy copy — mature cartoon-comedy tone, no slurs/sexual content.
 * Boss taunts land in chat via 'chat:system'. Keyed by boss id so each apex
 * has its own voice; phase lines are indexed by phase number.
 */

const RNG = Math.random
function pick(arr: readonly string[]): string {
  return arr[Math.floor(RNG() * arr.length)] ?? ''
}

/** Line when the player walks up to a ready altar. */
const APPROACH: Record<string, string[]> = {
  raid_frostwyrm: [
    'The ice altar hums. Something enormous is napping under the shelf, and the snooze button is you.',
    'Frost creeps up the altar. Summon the Frostwyrm? It has been expecting literally anyone.'
  ],
  raid_magma_colossus: [
    'The altar is uncomfortably warm. Wake the Magma Colossus? It is dormant, which is lava-speak for "lying".',
    'Heat shimmers off the obsidian altar. The Colossus stirs. It has feelings about tourists.'
  ],
  raid_bone_tyrant: [
    'The altar rattles politely. The Bone Tyrant will see you now. He has cleared his entire afterlife.',
    'Dust lifts off the tomb altar. Summon the Bone Tyrant? He bills by the hour and he is already annoyed.'
  ],
  raid_grukk_eternal: [
    'The altar screams in a language that is mostly vowels and threats. Summon Grukk the Eternal?',
    'The air goes green. Grukk the Eternal is ready. Death was a lateral career move for him.'
  ]
}

/** Boss "you woke me" line on summon. */
const AGGRO: Record<string, string[]> = {
  raid_frostwyrm: [
    'THE FROSTWYRM UNCOILS: "Five hundred years of quiet. You get ten minutes of me."',
    'THE FROSTWYRM: "Ah. A warm snack with legs. How thoughtful."'
  ],
  raid_magma_colossus: [
    'THE MAGMA COLOSSUS GROANS AWAKE: "WHO. TURNED. ON. THE. HEAT."',
    'THE MAGMA COLOSSUS: "I was DORMANT. That is DIFFERENT from asleep. Now I am NEITHER."'
  ],
  raid_bone_tyrant: [
    'THE BONE TYRANT RISES: "Do you have an appointment? No? Classic."',
    'THE BONE TYRANT: "I have been dead for ages and YOU are the inconvenience."'
  ],
  raid_grukk_eternal: [
    'GRUKK THE ETERNAL BOOMS: "You killed Grukk once. Grukk got better. Grukk got WORSE, for you."',
    'GRUKK THE ETERNAL: "Ascended. Eternal. Mildly inconvenienced. Prepare."'
  ]
}

/** Per-phase taunts (index = phase number; clamped). */
const PHASE: Record<string, string[]> = {
  raid_frostwyrm: [
    '',
    'THE FROSTWYRM: "Cute. Now let us try the part where the floor is lava’s colder cousin."',
    'THE FROSTWYRM: "No more warm-ups. Mostly because there is nothing warm left."'
  ],
  raid_magma_colossus: [
    '',
    'THE MAGMA COLOSSUS: "CRACKS APPEARING. THAT IS A ME PROBLEM AND SOON A YOU PROBLEM."',
    'THE MAGMA COLOSSUS: "I AM MOSTLY RUBBLE NOW. RUBBLE IS VERY ANGRY."'
  ],
  raid_bone_tyrant: [
    '',
    'THE BONE TYRANT: "Escalating to my middle-management voice. You will not enjoy it."',
    'THE BONE TYRANT: "I am down to the load-bearing bones. These are the SPICY ones."'
  ],
  raid_grukk_eternal: [
    '',
    'GRUKK: "Grukk warming up. Grukk apologize in advance. Grukk not mean it."',
    'GRUKK: "HALF GRUKK. DOUBLE ANGRY. Math checks out."',
    'GRUKK: "This is Grukk’s LAST QUARTER of health and his FIRST of fury."'
  ]
}

/** Soft-enrage line. */
const ENRAGE: Record<string, string[]> = {
  raid_frostwyrm: ['THE FROSTWYRM: "You are taking too long. I have a shelf to haunt. ENOUGH."'],
  raid_magma_colossus: ['THE MAGMA COLOSSUS: "OVERTIME. I DO NOT GET PAID FOR OVERTIME. NEITHER DO YOU."'],
  raid_bone_tyrant: ['THE BONE TYRANT: "This meeting could have been an email. Now it is a MASSACRE."'],
  raid_grukk_eternal: ['GRUKK: "Grukk DONE being polite. Grukk was never polite. Grukk LYING NOW too."']
}

/** Boss death line + the reward crow. */
const DEATH: Record<string, string[]> = {
  raid_frostwyrm: ['THE FROSTWYRM SHATTERS into a very expensive slushie. The Nope Shelf exhales.'],
  raid_magma_colossus: ['THE MAGMA COLOSSUS cools into a extremely valuable driveway. Finally dormant. For real this time.'],
  raid_bone_tyrant: ['THE BONE TYRANT collapses into a filing cabinet of loot. "Out of... office..." he clatters.'],
  raid_grukk_eternal: ['GRUKK THE ETERNAL falls. "Grukk... get better... again...?" No, Grukk. Not today.']
}

export const flavor = {
  approach: (id: string): string => pick(APPROACH[id] ?? ['The altar waits.']),
  aggro: (id: string): string => pick(AGGRO[id] ?? ['The boss awakens.']),
  phase: (id: string, phase: number): string => {
    const lines = PHASE[id] ?? []
    return lines[Math.min(phase, lines.length - 1)] ?? ''
  },
  enrage: (id: string): string => pick(ENRAGE[id] ?? ['The boss enrages.']),
  death: (id: string): string => pick(DEATH[id] ?? ['The boss is slain.']),
  wipe: (): string =>
    pick([
      'The raid wipes. The boss settles back onto its hoard, deeply unbothered.',
      'You are extremely dead. The apex goes back to sleep, filing you under "cardio".',
      'Flawless victory — for the boss. It did not even use its good moves.'
    ]),
  cooldown: (name: string, mins: number): string =>
    `${name} needs ${mins} more minute${mins === 1 ? '' : 's'} to respawn its menace. Even apex evil observes a cooldown.`,
  tooLow: (name: string, lvl: number): string =>
    `${name} glances at you, sighs, and goes back to sleep. (Recommended level ${lvl}. This is a kindness.)`,
  busy: (): string => 'One apocalypse at a time. A raid boss is already loose somewhere in the world.'
}
