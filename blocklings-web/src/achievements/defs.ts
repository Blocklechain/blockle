/**
 * Achievements — the catalog (45 entries, comedy-named, zero rewards).
 *
 * ECONOMY LAW COMPLIANCE: achievements grant glory and nothing else. No
 * items, no currency, no stats. The panel says so, loudly and with jokes.
 *
 * Each def reads its live progress from the engine's AchStats snapshot;
 * `goal` is the finish line (goal 1 = binary). Ids are permanent save keys —
 * add, don't rename.
 */

export type AchCategory =
  | 'combat'
  | 'exploration'
  | 'gathering'
  | 'wealth'
  | 'pets'
  | 'social'
  | 'quests'

export const CATEGORY_LABELS: Record<AchCategory, string> = {
  combat: 'Combat',
  exploration: 'Exploration',
  gathering: 'Gathering & Crafting',
  wealth: 'Wealth',
  pets: 'Pets',
  social: 'Social',
  quests: 'Quests',
}

/** Live counters/sets the engine maintains (see engine.ts). */
export interface AchStats {
  kills: number
  deaths: number
  sales: number
  goldBuys: number
  pets: number
  chats: number
  who: number
  quests: number
  mints: number
  travels: number
  /** Best single-CST-day distinct contract completions (0..6). */
  contractsBestDay: number
  /** Heart-region ids visited (of the 6). */
  regions: ReadonlySet<string>
  /** Every distinct zone/region id visited (of the 96). */
  zones: ReadonlySet<string>
  /** Waystone ids attuned (of the 20; ws_village seeded). */
  stones: ReadonlySet<string>
  /** Profession skills performed at least once (of the 9). */
  prof: ReadonlySet<string>
  /** Boss species defeated (wolf/golem/skeleton/orc). */
  boss: ReadonlySet<string>
  triChain: boolean
  skill99: boolean
  petPrestige: boolean
  petBoss: boolean
}

export interface AchDef {
  id: string
  cat: AchCategory
  name: string
  desc: string
  goal: number
  progress(st: AchStats): number
}

const bool = (b: boolean): number => (b ? 1 : 0)
const has = (set: ReadonlySet<string>, id: string): number => bool(set.has(id))

export const ACHIEVEMENTS: readonly AchDef[] = [
  // ───────────────────────────── combat ─────────────────────────────
  {
    id: 'first_blood', cat: 'combat', name: 'First Blood (Self-Defense, Allegedly)',
    desc: 'Defeat your first mob. It started it. Probably.',
    goal: 1, progress: (s) => s.kills,
  },
  {
    id: 'kills_10', cat: 'combat', name: 'Double Digits of Mayhem',
    desc: 'Defeat 10 mobs. The local wildlife has opened a file on you.',
    goal: 10, progress: (s) => s.kills,
  },
  {
    id: 'kills_100', cat: 'combat', name: 'Century of Violence',
    desc: 'Defeat 100 mobs. At this point it’s a hobby.',
    goal: 100, progress: (s) => s.kills,
  },
  {
    id: 'kills_1000', cat: 'combat', name: 'Pacifism: Postponed',
    desc: 'Defeat 1,000 mobs. The mobs have started a support group.',
    goal: 1000, progress: (s) => s.kills,
  },
  {
    id: 'boss_direwolf', cat: 'combat', name: 'Bad Dog. No Biscuit.',
    desc: 'Defeat the Alpha Direwolf. Who’s a good boy? Not him.',
    goal: 1, progress: (s) => has(s.boss, 'wolf'),
  },
  {
    id: 'boss_golem', cat: 'combat', name: 'Rock Bottom (His, Not Yours)',
    desc: 'Defeat the Gravelord Golem. He took it hard. Like granite.',
    goal: 1, progress: (s) => has(s.boss, 'golem'),
  },
  {
    id: 'boss_skeleton', cat: 'combat', name: 'Calcium Regicide',
    desc: 'Defeat the Skeleton King. Turns out the crown was load-bearing.',
    goal: 1, progress: (s) => has(s.boss, 'skeleton'),
  },
  {
    id: 'boss_orc', cat: 'combat', name: 'Grukk Around and Find Out',
    desc: 'Defeat Warchief Grukk. He found out.',
    goal: 1, progress: (s) => has(s.boss, 'orc'),
  },
  {
    id: 'boss_all', cat: 'combat', name: 'Middle Management Removed',
    desc: 'Defeat all four region bosses. HR will not be reaching out.',
    goal: 4, progress: (s) => s.boss.size,
  },
  {
    id: 'deaths_10', cat: 'combat', name: 'Frequent Flyer',
    desc: 'Die 10 times. The respawn stone keeps a punch card with your name on it.',
    goal: 10, progress: (s) => s.deaths,
  },

  // ─────────────────────────── exploration ───────────────────────────
  {
    id: 'reg_beginnings', cat: 'exploration', name: 'Humble Beginnings',
    desc: 'Set foot in the Kingdom of Beginnings. Technically unavoidable. Still counts.',
    goal: 1, progress: (s) => has(s.regions, 'beginnings'),
  },
  {
    id: 'reg_greenwood', cat: 'exploration', name: 'Into the Woods, Against Advice',
    desc: 'Visit Greenwood Forest. The trees are whispering. It’s reviews.',
    goal: 1, progress: (s) => has(s.regions, 'greenwood'),
  },
  {
    id: 'reg_ironhold', cat: 'exploration', name: 'Peak Performance',
    desc: 'Visit the Ironhold Mountains. The air is thin and so is your excuse.',
    goal: 1, progress: (s) => has(s.regions, 'ironhold'),
  },
  {
    id: 'reg_capital', cat: 'exploration', name: 'Big City, Same You',
    desc: 'Visit the Royal Capital. The guards are judging your boots.',
    goal: 1, progress: (s) => has(s.regions, 'capital'),
  },
  {
    id: 'reg_ashen', cat: 'exploration', name: 'Spelunking Permit: Denied',
    desc: 'Visit the Ashen Dungeons. You went anyway. Respect.',
    goal: 1, progress: (s) => has(s.regions, 'ashen'),
  },
  {
    id: 'reg_forgotten', cat: 'exploration', name: 'Forgotten, Not Forgiven',
    desc: 'Visit the Forgotten Lands. Someone there remembers. Something.',
    goal: 1, progress: (s) => has(s.regions, 'forgotten'),
  },
  {
    id: 'zones_10', cat: 'exploration', name: 'Tourist Visa',
    desc: 'Visit 10 zones. The brochure lied about most of them.',
    goal: 10, progress: (s) => s.zones.size,
  },
  {
    id: 'zones_50', cat: 'exploration', name: 'Cartographer’s Headache',
    desc: 'Visit 50 zones. Maps hate this one wanderer.',
    goal: 50, progress: (s) => s.zones.size,
  },
  {
    id: 'zones_96', cat: 'exploration', name: 'No Stone Unstepped-On',
    desc: 'Visit all 96 zones. The continent is considering a restraining order.',
    goal: 96, progress: (s) => s.zones.size,
  },
  {
    id: 'ws_travel', cat: 'exploration', name: 'Commuter',
    desc: 'Teleport between waystones. Walking is for quests.',
    goal: 1, progress: (s) => s.travels,
  },
  {
    id: 'ws_all', cat: 'exploration', name: 'Public Transit Champion',
    desc: 'Attune all 20 waystones. You ARE the transit system now.',
    goal: 20, progress: (s) => s.stones.size,
  },

  // ──────────────────────── gathering & crafting ─────────────────────
  {
    id: 'prof_mining', cat: 'gathering', name: 'Rock Enthusiast',
    desc: 'Mine your first ore. The rocks respect you now. (They don’t.)',
    goal: 1, progress: (s) => has(s.prof, 'mining'),
  },
  {
    id: 'prof_woodcutting', cat: 'gathering', name: 'Lumber? Barely Know Her',
    desc: 'Chop your first tree. It had a family. Of planks.',
    goal: 1, progress: (s) => has(s.prof, 'woodcutting'),
  },
  {
    id: 'prof_fishing', cat: 'gathering', name: 'Something’s Fishy',
    desc: 'Catch your first fish. It saw everything. Now it’s dinner.',
    goal: 1, progress: (s) => has(s.prof, 'fishing'),
  },
  {
    id: 'prof_farming', cat: 'gathering', name: 'Agricultural Pivot',
    desc: 'Harvest your first crop. From hero to hoe-haver.',
    goal: 1, progress: (s) => has(s.prof, 'farming'),
  },
  {
    id: 'prof_herbalism', cat: 'gathering', name: 'Totally Legal Herbs',
    desc: 'Pick your first herb. For potions. Officially, for potions.',
    goal: 1, progress: (s) => has(s.prof, 'herbalism'),
  },
  {
    id: 'prof_blacksmithing', cat: 'gathering', name: 'Hot Metal, Cold Sweat',
    desc: 'Earn your first blacksmithing experience. Roughly 60% of your eyebrows remain.',
    goal: 1, progress: (s) => has(s.prof, 'blacksmithing'),
  },
  {
    id: 'prof_cooking', cat: 'gathering', name: 'Burnt Is a Flavor',
    desc: 'Earn your first cooking experience. The smoke alarm is your biggest fan.',
    goal: 1, progress: (s) => has(s.prof, 'cooking'),
  },
  {
    id: 'prof_alchemy', cat: 'gathering', name: 'Mostly Reversible',
    desc: 'Earn your first alchemy experience. Side effects include confidence.',
    goal: 1, progress: (s) => has(s.prof, 'alchemy'),
  },
  {
    id: 'prof_tailoring', cat: 'gathering', name: 'Sew What?',
    desc: 'Earn your first tailoring experience. Fashion-forward, thread-backward.',
    goal: 1, progress: (s) => has(s.prof, 'tailoring'),
  },
  {
    id: 'skill_99', cat: 'gathering', name: 'Ninety-Nine Problems (This Ain’t One)',
    desc: 'Reach level 99 in any skill. Touch grass? You ARE the grass now.',
    goal: 1, progress: (s) => bool(s.skill99),
  },

  // ───────────────────────────── wealth ──────────────────────────────
  {
    id: 'mint_first', cat: 'wealth', name: 'Mint Condition',
    desc: 'Mint your first NFT. It’s real, it’s on-chain, and it’s probably a hat.',
    goal: 1, progress: (s) => s.mints,
  },
  {
    id: 'mint_5', cat: 'wealth', name: 'Serial Minter',
    desc: 'Mint 5 NFTs. The blockchain knows your name and sighs.',
    goal: 5, progress: (s) => s.mints,
  },
  {
    id: 'mint_tri', cat: 'wealth', name: 'Chain Triathlete',
    desc: 'Mint the same item on all three chains. Blockle, Ethereum, Solana — collect the whole set.',
    goal: 1, progress: (s) => bool(s.triChain),
  },
  {
    id: 'sale_first', cat: 'wealth', name: 'Capitalism Speedrun',
    desc: 'Make your first marketplace sale. A stranger paid real money. Frame this.',
    goal: 1, progress: (s) => s.sales,
  },
  {
    id: 'gold_first', cat: 'wealth', name: 'Whale Watching (It’s a Mirror)',
    desc: 'Buy GOLD for the first time. The economy committee sends a fruit basket.',
    goal: 1, progress: (s) => s.goldBuys,
  },

  // ────────────────────────────── pets ───────────────────────────────
  {
    id: 'pet_first', cat: 'pets', name: 'Accidental Parent',
    desc: 'Obtain your first pet. Congratulations and/or condolences.',
    goal: 1, progress: (s) => s.pets,
  },
  {
    id: 'pet_10', cat: 'pets', name: 'Zoo Permit Pending',
    desc: 'Own 10 pets. The paperwork is in the mail. The mail is on fire.',
    goal: 10, progress: (s) => s.pets,
  },
  {
    id: 'pet_prestige', cat: 'pets', name: 'Limited Edition Friend',
    desc: 'Obtain a golden or shadow pet. It appraises YOU.',
    goal: 1, progress: (s) => bool(s.petPrestige),
  },
  {
    id: 'pet_boss', cat: 'pets', name: 'Nepotism Hire',
    desc: 'Obtain a boss’s baby. Bring-your-kid-to-work day went poorly.',
    goal: 1, progress: (s) => bool(s.petBoss),
  },

  // ───────────────────────────── social ──────────────────────────────
  {
    id: 'chat_first', cat: 'social', name: 'Social Butterfly (Larval Stage)',
    desc: 'Send your first chat message. The void says hi back.',
    goal: 1, progress: (s) => s.chats,
  },
  {
    id: 'who_5', cat: 'social', name: 'Confirmed: Not Alone',
    desc: 'Spot other players online 5 times. The economy trembles appropriately.',
    goal: 5, progress: (s) => s.who,
  },

  // ───────────────────────────── quests ──────────────────────────────
  {
    id: 'quests_10', cat: 'quests', name: 'Professional Favor-Doer',
    desc: 'Complete 10 quests. Your going rate: exposure, and occasionally boots.',
    goal: 10, progress: (s) => s.quests,
  },
  {
    id: 'quests_50', cat: 'quests', name: 'The To-Do List Fears You',
    desc: 'Complete 50 quests. NPCs form an orderly queue now.',
    goal: 50, progress: (s) => s.quests,
  },
  {
    id: 'contracts_day', cat: 'quests', name: 'Employee of the Month',
    desc: 'Finish all six contracts in a single day. The plaque is imaginary. The glory is not.',
    goal: 6, progress: (s) => s.contractsBestDay,
  },
] as const

export function achById(id: string): AchDef | undefined {
  return ACHIEVEMENTS.find((a) => a.id === id)
}
