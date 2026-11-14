/**
 * Player-facing gather one-liners. House tone: mature cartoon comedy —
 * sarcastic, a little mean, never actually cruel.
 */

/** Shown when the player tries a node with NO tool of the right family. */
const NO_TOOL: Record<string, readonly string[]> = {
  pick: [
    "You slap the rock with your bare hands. The rock remains unimpressed.",
    "No pickaxe? What's the plan here, harsh language?",
    "Mining with your fists. Bold. Stupid, but bold. Buy a pick."
  ],
  hatchet: [
    "You kick the tree. The tree drops one leaf on you. Sarcastically.",
    "No hatchet? Gnawing through trunks is for beavers, champ.",
    "The tree has survived storms, wolves, and worse adventurers than you. Get an axe."
  ],
  rod: [
    "You stare menacingly at the water. The fish stare back. They're winning.",
    "Hand-fishing? The fish have collectively filed a restraining order.",
    "No rod, no dinner. The river doesn't do charity."
  ]
}

/** Shown when the tool exists but its material tier is too soft. */
const UNDER_TIER: Record<string, readonly string[]> = {
  pick: [
    "Your pick bounces off like a toddler's spoon. This vein wants better metal.",
    "That pick couldn't crack an egg. The ore actually laughed.",
    "Nice try. This rock eats picks like yours for breakfast."
  ],
  hatchet: [
    "Your hatchet folds like wet cardboard. This tree has standards.",
    "You put a dent in your axe, not the tree. Upgrade, lumberjack."
  ],
  rod: [
    "Your rod isn't fancy enough for these fish. Snobs, the lot of them."
  ]
}

/** Occasional success quips (kept rare so they stay funny). */
const SUCCESS: Record<string, readonly string[]> = {
  mining: ["Rock: 0. You: 1. Finally.", "Shiny rocks acquired. Try not to eat them."],
  woodcutting: ["Timber! Nobody was under it. Probably.", "The forest will remember this."],
  fishing: ["One fish, zero dignity lost. A good day.", "It flopped. You flopped harder. You won."],
  herbalism: ["Plucked. Smells like salad and poor decisions.", "The herbs gave up without a fight."],
  farming: ["Wheat secured. Farmer Bram is quietly furious.", "Harvested. You're basically a farmhand now."]
}

function pick(list: readonly string[] | undefined, fallback: string): string {
  if (!list || list.length === 0) return fallback
  return list[Math.floor(Math.random() * list.length)] ?? fallback
}

export function noToolLine(family: string): string {
  return pick(NO_TOOL[family], 'You need the right tool for that.')
}

export function underTierLine(family: string): string {
  return pick(UNDER_TIER[family], 'Your tool is too flimsy for this one.')
}

/** ~12% of harvests get a quip; returns null the rest of the time. */
export function maybeSuccessLine(skill: string): string | null {
  if (Math.random() > 0.12) return null
  return pick(SUCCESS[skill], null as unknown as string) || null
}
