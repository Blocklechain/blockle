/**
 * Blocklings skills — level-up chat flavor.
 *
 * Mature-cartoon-comedy register: sarcastic, a little dark, never mean to
 * the player's protected traits — only to their life choices.
 */
import type { SkillId } from '../ids'

const LINES: Record<SkillId, string[]> = {
  attack: [
    'Attack level {lvl}! The local slimes have filed a formal complaint.',
    'Attack level {lvl}. You now swing that thing like you almost know which end is which.',
    'Attack level {lvl}! Violence remains the answer. It was never not the answer.',
  ],
  defense: [
    'Defense level {lvl}! Congratulations on getting hit professionally.',
    'Defense level {lvl}. Your strategy of standing there and taking it is finally paying off.',
    'Defense level {lvl}! You are now slightly harder to kill. Emphasis on slightly.',
  ],
  magic: [
    'Magic level {lvl}! The arcane arts welcome you. The arcane arts have low standards.',
    'Magic level {lvl}. You can now set things on fire from a polite distance.',
    'Magic level {lvl}! Reality bends to your will. Mostly out of pity.',
  ],
  vitality: [
    'Vitality level {lvl}! Your organs have agreed to keep doing this.',
    'Vitality level {lvl}. More HP — so dying takes longer now. Enjoy.',
    'Vitality level {lvl}! Cardio: it works, apparently. Who knew.',
  ],
  mining: [
    'Mining level {lvl}! You hit rocks and the rocks respect you for it.',
    'Mining level {lvl}. The ore practically leaps into your bag. Practically.',
    'Mining level {lvl}! Somewhere, a geologist just felt a disturbance.',
  ],
  woodcutting: [
    'Woodcutting level {lvl}! The forest has started a group chat about you.',
    'Woodcutting level {lvl}. Trees now fall with 12% more existential dread.',
    'Woodcutting level {lvl}! Deforestation, but make it a hobby.',
  ],
  fishing: [
    'Fishing level {lvl}! The fish have begun telling their kids about you.',
    'Fishing level {lvl}. Standing by water doing nothing — and now you’re GOOD at it.',
    'Fishing level {lvl}! Patience: weaponized.',
  ],
  farming: [
    'Farming level {lvl}! Dirt: conquered. Next up, slightly better dirt.',
    'Farming level {lvl}. Your crops grow out of fear now.',
    'Farming level {lvl}! You’ve mastered waiting, but outdoors.',
  ],
  herbalism: [
    'Herbalism level {lvl}! You can now tell which plants are salad and which are murder.',
    'Herbalism level {lvl}. Sniffing weeds in a field — officially a skill.',
    'Herbalism level {lvl}! The herbs whisper to you. Maybe don’t mention that to anyone.',
  ],
  blacksmithing: [
    'Blacksmithing level {lvl}! You hit hot metal and it becomes better metal. Science.',
    'Blacksmithing level {lvl}. Your hammer insurance premiums just went up.',
    'Blacksmithing level {lvl}! Forged in fire, tempered in mild burns.',
  ],
  cooking: [
    'Cooking level {lvl}! Fewer things are on fire that shouldn’t be. Progress.',
    'Cooking level {lvl}. Your food now poisons people slightly less often.',
    'Cooking level {lvl}! Gordon who? Exactly.',
  ],
  alchemy: [
    'Alchemy level {lvl}! You drank something that was bubbling and LIVED. Level up.',
    'Alchemy level {lvl}. The explosions are intentional now. Most of them.',
    'Alchemy level {lvl}! One step closer to turning lead into mild disappointment.',
  ],
  tailoring: [
    'Tailoring level {lvl}! Stabbing cloth thousands of times finally pays off.',
    'Tailoring level {lvl}. Your hems are straight. Your life? Debatable.',
    'Tailoring level {lvl}! Fashion is pain. Mostly needle-related.',
  ],
}

const MAX_LINES = [
  '{skill} level 99. The grind is over. The void where the grind lived is forever.',
  'LEVEL 99 {skill}! Absolute mastery achieved. Touch grass responsibly.',
]

const GENERIC = [
  '{skill} level {lvl}! Look at you go.',
  '{skill} level {lvl}! Numbers went up. Dopamine delivered.',
]

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** A celebratory (read: sarcastic) system-chat line for a level-up. */
export function levelUpLine(skill: string, level: number): string {
  const pool =
    level >= 99 ? MAX_LINES : (LINES as Record<string, string[]>)[skill] ?? GENERIC
  const line = pool[Math.floor(Math.random() * pool.length)]!
  return line.replace('{skill}', cap(skill)).replace('{lvl}', String(level))
}

/** Snarky caption for the total-level flex at the top of the panel. */
export function totalCaption(total: number): string {
  if (total >= 1287) return 'maxed. seek help' // 13 × 99
  if (total >= 1000) return 'certified no-lifer'
  if (total >= 650) return 'dangerously competent'
  if (total >= 400) return 'actually trying now'
  if (total >= 200) return 'mildly employable'
  if (total >= 60) return 'promising-ish'
  return 'certified nobody'
}
