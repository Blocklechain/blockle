/**
 * Waystone comedy lines — mature-cartoon register: irreverent, sarcastic,
 * a little dark. Attune lines are per-stone; travel + misc lines rotate.
 */

const ATTUNE: Record<string, string> = {
  ws_village:
    'Village Waystone attuned. Yes, you teleported to the place you were already standing. Visionary.',
  ws_greenwood:
    'Greenwood Waystone attuned. The trees saw everything you just did. They talk.',
  ws_ironhold:
    'Ironhold Waystone attuned. Now you can skip the mountain hike like the fraud you are.',
  ws_capital:
    'Capital Waystone attuned. Fast travel to the one place where everyone wants your money.',
  ws_ashen:
    'Ashen Waystone attuned. That smell? Barbecue. It is absolutely not barbecue.',
  ws_forgotten:
    'Forgotten Waystone attuned. This place got forgotten on purpose. Enjoy!'
}

const ATTUNE_FALLBACK =
  'Waystone attuned! Fast travel unlocked, because walking is for people with free time.'

export function attuneLine(stoneId: string): string {
  return ATTUNE[stoneId] ?? ATTUNE_FALLBACK
}

const ARRIVALS = [
  'Whoosh. All your atoms arrived, most of them in the right order.',
  'Teleport complete. Any lingering nausea is included at no extra charge.',
  'You materialize dramatically. Nobody was watching. Classic.',
  'The stone spits you out like it had somewhere better to be.',
  'Reassembled! The warranty on your spleen is void, though.'
] as const

export function arrivalLine(destName: string): string {
  const i = Math.floor(Math.random() * ARRIVALS.length)
  return `${destName}: ${ARRIVALS[i] ?? ARRIVALS[0]}`
}

export function dormantTapLine(): string {
  return 'This stone is dim and dead. Walk up and give it a poke — attunement is a contact sport.'
}

export function emptyListLine(): string {
  return 'No other attuned waystones yet. Go out there and touch more rocks.'
}
