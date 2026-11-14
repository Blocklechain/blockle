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
    'Forgotten Waystone attuned. This place got forgotten on purpose. Enjoy!',
  // --- wilderness zone stones (world scale-up) ---
  ws_zero_chill:
    'Polar Waystone attuned. You touched the coldest rock in existence with your bare hands. Bold. Stupid, but bold.',
  ws_frosthold:
    'Frosthold Waystone attuned. The previous owners froze solid mid-argument, so the place was going cheap.',
  ws_north_roads_end:
    "Road's End Waystone attuned. The road gave up here. You didn't. History will decide who was right.",
  ws_kings_back_lawn:
    "Back Lawn Waystone attuned. Yes, the King knows you teleport onto his lawn. No, he's not okay with it.",
  ws_prism_break:
    'Prism Waystone attuned. Please stop licking the crystals. That is a rule now, specifically because of you.',
  ws_ironvein_hollow:
    'Ironvein Waystone attuned. The mountain hums with ore, echoes, and several unresolved grudges.',
  ws_blushing_orchard:
    'Orchard Waystone attuned. The petals smell lovely. The things living under them do not.',
  ws_port_saltlick:
    'Saltlick Waystone attuned. Welcome to the port! Watch your coin purse, your back, and your backup coin purse.',
  ws_heartwood_hollow:
    'Heartwood Waystone attuned. The forest accepts you. The forest accepts everyone. That is the problem.',
  ws_gravely_serious:
    'Gravedigger Waystone attuned. Locals call the area "quiet, mostly". It is the "mostly" that gets you.',
  ws_gorge_yourself:
    'Gorge Waystone attuned. Mind the edge — the bottom is further away than your schedule allows.',
  ws_croakening:
    'Croaking Waystone attuned. The frogs are singing about you. It is not a flattering song.',
  ws_mirage_mile:
    'Mirage Waystone attuned. This one is probably real. Probably. Take a sip of water just in case.',
  ws_simmering_steps:
    'Simmering Waystone attuned. The floor is lava. Not the game. The actual floor. Actual lava.'
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
