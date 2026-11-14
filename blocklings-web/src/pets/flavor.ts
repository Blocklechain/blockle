/**
 * Pet drop / companion comedy lines. Mature-cartoon tone, zero slurs,
 * zero sexual content — just a narrator who has seen too much.
 */
import type { PetVariant } from '../types'

const DROP_LINES: Record<PetVariant, readonly string[]> = {
  base: [
    '{name} crawls out of the loot pile and decides you are its parent now. No refunds.',
    'A wild {name} appears! It has already imprinted on you. Legally, that is binding.',
    '{name} follows you home. You ARE the home.',
    'You got {name}! It brought nothing to the relationship except unconditional love.',
  ],
  ember: [
    '{name} drops! It is warm. Suspiciously warm. Do not file an insurance claim yet.',
    'A smoldering {name} joins you. Your eyebrows are now a renewable resource.',
    '{name} appears in a puff of smoke that is DEFINITELY not your fault.',
  ],
  snow: [
    '{name} drops! It is cold to the touch and emotionally unavailable. Perfect.',
    'A frosty {name} joins you. It judges your life choices at -4°C.',
    '{name} appears! Please do not lick it. We know you thought about it.',
  ],
  golden: [
    'A GOLDEN {name} drops!! Your accountant just felt a disturbance.',
    '{name} appears, appraised at "shiny". The economy trembles.',
    'RARE DROP: {name}. It glitters. You weep. The market watches.',
  ],
  shadow: [
    'A SHADOW {name} slinks out of the void. It knows what you did. It does not care.',
    '{name} materializes from pure darkness and mild spite.',
    'RARE DROP: {name}. It is 60% shadow, 40% attitude.',
  ],
  boss: [
    'WAIT — {name} survived the fight and has decided you are the new management.',
    'BOSS BABY: {name} joins you. Nepotism works both ways now.',
    '{name} crawls out of the boss\'s pockets. It was never on the payroll anyway.',
  ],
}

export function dropLine(name: string, variant: PetVariant, rng: () => number): string {
  const lines = DROP_LINES[variant]
  const line = lines[Math.floor(rng() * lines.length)] ?? lines[0] ?? '{name} joins you!'
  return line.replaceAll('{name}', name)
}

const COWER_LINES: readonly string[] = [
  'Your pet is having a moment. Give it ten seconds.',
  'Your pet has unionized. Current demand: not that.',
  'Your pet bravely runs away. It will be back. Probably.',
]

export function cowerLine(rng: () => number): string {
  return COWER_LINES[Math.floor(rng() * COWER_LINES.length)] ?? COWER_LINES[0]!
}

export function mintLine(name: string, chain: string): string {
  return `${name} is now on-chain (${chain}). It remains unaware and unbothered.`
}
