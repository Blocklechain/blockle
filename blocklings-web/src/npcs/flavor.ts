/**
 * NPCs — comedy writing. Idle/greeting lines per NPC (mature-cartoon
 * register: irreverent, sarcastic, a little dark; never mean to the player
 * in a way that stops being funny), plus shared vendor-transaction barks.
 */

export const ROLE_TAGS: Record<string, string> = {
  quests: 'Quest Giver',
  vendor: 'Merchant',
  trainer: 'Trainer',
  flavor: 'Local Character'
}

/** Greeting pools, keyed by npc id. */
const LINES: Record<string, readonly string[]> = {
  elder_rowan: [
    'Ah, fresh me— a HERO. I meant hero. Welcome to the Kingdom of Beginnings.',
    'Back in my day we fought slimes uphill both ways. In the rain. Barefoot. We lost.',
    'The kingdom needs you, champion. Mostly because everyone competent moved to the Capital.',
    'You have the look of destiny about you. Or pinkeye. Hard to say at my age.'
  ],
  merchant_hilda: [
    'Everything is for sale. Except my patience — that sold out years ago.',
    'You break it, you buy it. And frankly you look like a breaker.',
    'Haggling is punishable by sarcasm. I am VERY well armed.',
    'Welcome, welcome. Coins out where I can see them.'
  ],
  farmer_bram: [
    'Slimes ate my turnips. TURNIPS, adventurer. What kind of sick world is this?',
    'You look strong. Or at least... expendable. Either works for me.',
    'Farming is just gambling with dirt. And I am LOSING.'
  ],
  guard_tomas: [
    'Move along. Or stand there. I get paid the same thrilling nothing either way.',
    'I guard this spot. The spot is fine. Thanks for checking in on the spot.',
    'Took an arrow to the— no. No, it was a stapler. Desk incident. Don’t ask.',
    'Halt! ...Okay, that’s the whole script they gave me. Carry on.'
  ],
  scout_wren: [
    'Shhh. The trees are listening. ...I may have been out here too long.',
    'Everything in this forest wants to eat you. It’s honestly refreshing — no pretense.',
    'I scout, you stab. It’s a good system. Don’t overthink your half.'
  ],
  herbalist_moss: [
    'Half these herbs heal you. The other half are... educational.',
    'Smell this. No reason. I just want to see what happens.',
    'All natural remedies! So is hemlock, so read the labels.'
  ],
  ranger_kael: [
    'Shoulders back. Knees bent. Dignity optional — you clearly travel light.',
    'I can teach you to survive out here. The wolves teach faster, but they grade harshly.',
    'Rule one of the wild: everything is a trap. Rule two: see rule one.'
  ],
  foreman_dagna: [
    'The mountain is full of ore and regret. We mostly ship the regret.',
    'Hard hats are mandatory. Heads, apparently, are optional around here.',
    'You swing a pick like a poet. That was not a compliment.'
  ],
  smith_orin: [
    'If it’s not on fire, it’s not finished.',
    'I make weapons, not promises. The weapons hold up better.',
    'Burns build character. I am EXTREMELY characterful.'
  ],
  prospector_finn: [
    'Buy a pickaxe, strike it rich, remember old Finn. That’s the dream, friend.',
    'There’s gold in these mountains. Also cave bats. Mostly cave bats.',
    'I sell shovels during a gold rush. I’m the only one here who’s done the math.'
  ],
  captain_elara: [
    'The Capital is perfectly safe. Ignore the screaming — that’s tradition.',
    'I need someone deniable for some official business. Congratulations, you’re deniable.',
    'Paperwork or monsters. Those are my days. Please bring me monsters.'
  ],
  banker_aldous: [
    'Your coin is perfectly safe with me. Define "safe". Define "your".',
    'We offer competitive rates. Competing against whom? Excellent question. Next window.',
    'Gold doesn’t grow on trees. Believe me, the research division tried.'
  ],
  mage_lyra: [
    'Magic is ten percent talent and ninety percent not exploding.',
    'My last apprentice is that scorch mark by the door. Say hello, apprentice.',
    'Yes, the tower is on fire a little. It’s load-bearing fire. Leave it.'
  ],
  gravekeeper_sol: [
    'Business is dead. That’s the job AND the joke. Moving on.',
    'The residents here are quiet, polite, and occasionally climb out. Two out of three.',
    'Dig the holes, fill the holes. Lately they... un-fill. That’s where you come in.'
  ],
  hermit_vex: [
    'I moved out here to be alone. And yet. Here. You. Are.',
    'The Forgotten Lands aren’t forgotten. They’re ignored. There’s a difference, and it has teeth.',
    'Advice? Don’t die out here. The paperwork is me, and I won’t do it.'
  ]
}

export function greeting(npcId: string, name: string): string {
  const pool = LINES[npcId]
  if (!pool || pool.length === 0) return `${name} nods at you. Riveting stuff.`
  return pool[Math.floor(Math.random() * pool.length)] ?? pool[0]!
}

const BUY_OK = [
  'Pleasure doing business. Now scram, I have a reputation.',
  'Sold! No refunds. Especially not to you.',
  'A wise purchase. Or at least a purchase.',
  'Take it. It’s legally yours now, which makes it legally not my problem.'
] as const

const PAY_FAIL = [
  'The money didn’t move, so neither does the merchandise.',
  'Your wallet said no. I respect its honesty.',
  'No payment landed, no product leaves. It’s an elegant system.',
  'The chain declined. Take it up with the chain — I hear it’s very approachable.'
] as const

export function buyOkLine(): string {
  return BUY_OK[Math.floor(Math.random() * BUY_OK.length)] ?? BUY_OK[0]
}

/** Payment failed / rejected / wallet error — honest, no item granted. */
export function payFailLine(): string {
  return PAY_FAIL[Math.floor(Math.random() * PAY_FAIL.length)] ?? PAY_FAIL[0]
}

export const TOO_FAR_LINES = [
  'They’re over there. You’re over here. Walking: still a thing.',
  'Nice try. Shouting distance is not talking distance.',
  'Get closer. They don’t bite. Probably.'
] as const

export function tooFarLine(name: string): string {
  const l = TOO_FAR_LINES[Math.floor(Math.random() * TOO_FAR_LINES.length)] ?? TOO_FAR_LINES[0]
  return `${name} is out of earshot. ${l}`
}
