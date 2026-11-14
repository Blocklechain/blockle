/**
 * Blocklings prestige — system-chat flavor for a prestige.
 *
 * Mature-cartoon-comedy register: sarcastic, a little dark about the player's
 * life choices, never about protected traits. Clean.
 */
import type { PerkKind } from './perks'

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

const ORDINAL = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth']

function ordinal(n: number): string {
  return ORDINAL[n] ?? `${n}th`
}

const PERK_BLURB: Record<PerkKind, string> = {
  xp: 'You chose faster learning. The irony of speeding UP the grind is noted.',
  mod: 'You chose a permanent edge. Tiny. Forever. The best kind.',
  gold: 'You chose a golden icon and no benefit whatsoever. We respect the commitment to the bit.'
}

const LINES = [
  '{skill} PRESTIGED! Level 99 → level 1. You looked at a finished skill and said "again." {star}',
  'Mastery star earned in {skill}. You deleted 1.2 million XP for a shiny star. {star}',
  '{skill} reset to 1. The grind is the point, and you ARE the point now. {star}',
  'You prestiged {skill}. Somewhere, a sensible person just fainted. {star}'
]

/** One celebratory (read: concerned) line for a prestige. */
export function prestigeLine(skill: string, star: number, kind: PerkKind): string {
  const line = LINES[Math.floor(Math.random() * LINES.length)]!
  const starTxt =
    star <= 5
      ? `That's your ${ordinal(star)} star in it.`
      : `That's star number ${star}. We stopped counting words at five.`
  return (
    line.replace('{skill}', cap(skill)).replace('{star}', starTxt) + ' ' + PERK_BLURB[kind]
  )
}
