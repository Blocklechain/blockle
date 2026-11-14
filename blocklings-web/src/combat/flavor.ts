/**
 * Combat flavor — mature-cartoon sass for player deaths, boss entrances
 * and the occasional kill quip. Mild profanity fine; keep it punchy.
 */

const DEATH_LINES = [
  'You died. The ground would like to apologize for nothing.',
  "You're dead. On the bright side, the monsters are telling this story for weeks.",
  'Dead. A slime somewhere just got a confidence boost it absolutely did not need.',
  "You have perished. Heroically, we'll say. The report will say heroically.",
  'You died doing what you loved: badly misjudging a fight.',
  "Flat on your back again. The waystone's seen it all, it won't judge. Much.",
  'You died. Your gear is fine. Your dignity is still at the crime scene.',
  "Welp. Turns out HP is not a suggestion.",
] as const

export function deathLine(rng: () => number): string {
  return DEATH_LINES[Math.floor(rng() * DEATH_LINES.length)] ?? DEATH_LINES[0]
}

const BOSS_LINES: Record<string, string> = {
  boss_greenwood: 'The Alpha Direwolf has noticed you. It skipped breakfast. You ARE breakfast.',
  boss_ironhold: 'The Gravelord Golem wakes up. It has one emotion and it is "avalanche".',
  boss_ashen: 'The Skeleton King rises. He died once already — he is NOT impressed by your sword.',
  boss_forgotten: 'Warchief Grukk cracks his knuckles. Each knuckle is the size of your head.',
}

export function bossAggroLine(bossId: string, name: string): string {
  return BOSS_LINES[bossId] ?? `${name} has had enough of you, specifically.`
}

const KILL_QUIPS: Record<string, readonly string[]> = {
  slime: ['Slime popped. Extremely satisfying. Slightly sticky.', 'The slime is now abstract art.'],
  mushroom: ['Shroomling flattened. Pizza topping acquired... morally.', 'Fungus among us: resolved.'],
  crab: ['Crab deleted. Sideways no more.', 'The crab rave is over.'],
  wolf: ['Wolf down. Who let the dogs out? You. You let them down.', 'Bad dog. Worse corpse.'],
  goblin: ['Goblin filed its final complaint.', 'One less goblin. HR is relieved.'],
  bat: ['Bat swatted. Echolocation found: one (1) sword.', 'The cave is 3% quieter now.'],
  spider: ['Spider squished. The internet money is safe.', 'Eight legs, zero plans.'],
  bandit: ['Bandit retired. Involuntarily. Permanently.', 'Crime does not pay. You, however, loot.'],
  skeleton: ['Skeleton dismantled. Calcium everywhere.', 'He had a bone to pick. You picked ALL of them.'],
  imp: ['Imp extinguished. Smells like burnt regret.', 'The imp has been yeeted back to HR hell.'],
  golem: ['Golem gravel-ized. The mountain mourns, briefly.', 'Rock: bottom.'],
  orc: ['Orc flattened. The kebab economy takes a hit.', 'Big guy, bigger thud.'],
  wisp: ['Wisp snuffed. The graveyard is mildly less haunted.', 'Lights out, spooky boy.'],
}

/** Occasional (caller throttles) sass after a kill. */
export function killQuip(species: string, rng: () => number): string | null {
  const lines = KILL_QUIPS[species]
  if (!lines || lines.length === 0) return null
  return lines[Math.floor(rng() * lines.length)] ?? null
}

const BOSS_KILL_LINES: Record<string, string> = {
  boss_greenwood: 'The Alpha Direwolf is down! The forest exhales. The squirrels throw a party.',
  boss_ironhold: 'The Gravelord Golem crumbles! Congratulations, you beat up a landslide.',
  boss_ashen: 'The Skeleton King falls apart — for good this time. Long live nobody.',
  boss_forgotten: 'Warchief Grukk has been un-chiefed. The Forgotten Lands will remember THIS.',
}

export function bossKillLine(bossId: string, name: string): string {
  return BOSS_KILL_LINES[bossId] ?? `${name} is down. Somebody write a song about it.`
}
