/**
 * Quests, wave 4 — the PROFESSIONS & PAPERWORK book (18 QuestDefs).
 *
 * Four crafting arcs (smithing at Orin's uphill forge, cooking out of the
 * Sleeping Blockling Inn, alchemy in Moss's unregulated shed, tailoring for
 * the Archmage's cape budget), four collection contracts that feed the
 * marketplace loop, and two meta quests about the trophy shelf watching you.
 *
 * Crafted-output steps use kind 'collect': the quest engine counts EVERY
 * 'item:gained' except source 'restore' (verified in ./index.ts), so items
 * produced by the crafting system (source 'craft') progress them — as do
 * loot, vendor and marketplace gains, which keeps the steps un-softlockable.
 * Same register as defs.ts: mature cartoon comedy, nobody is paid enough.
 */
import type { QuestDef } from '../types'

/** quest id -> quests that must be COMPLETED before it is offered. */
export const PREREQS3: Readonly<Record<string, readonly string[]>> = {
  // Smithing arc — Smith Orin, after his existing hazing quest
  q3_ore_you_ready: ['q_strike_iron'],
  q3_smelting_point: ['q3_ore_you_ready'],
  q3_first_sword: ['q3_smelting_point'],
  q3_dressed_for_distress: ['q3_first_sword'],
  // Cooking arc — the Sleeping Blockling Inn (Hilda runs the kitchen too)
  q3_catch_of_the_day: ['q3_flour_power'],
  q3_stew_review: ['q3_catch_of_the_day'],
  // Alchemy arc — Herbalist Moss, after the herb-picking intro
  q3_lab_assistant: ['q_weed_the_people'],
  q3_brew_it_yourself: ['q3_lab_assistant'],
  q3_explosive_results: ['q3_brew_it_yourself'],
  // Tailoring arc — Archmage Lyra's cape emergency
  q3_dramatic_flutter: ['q3_cape_crusade'],
  // Marketplace collection contracts
  q3_liquid_assets: ['q_hostile_audit'],
  // Meta — the trophy shelf
  q3_trophy_hunter: ['q_graduation_day'],
  q3_one_of_everything: ['q3_trophy_hunter'],
}

/** Display names for item ids this module grants or tracks (catalog-verified). */
export const ITEM_NAMES3: Readonly<Record<string, string>> = {
  ore_copper: 'Copper Ore',
  ore_iron: 'Iron Ore',
  ore_gold: 'Gold Ore',
  bar_copper: 'Copper Bar',
  bar_gold: 'Gold Bar',
  hatchet_iron: 'Iron Hatchet',
  helm_iron: 'Iron Helm',
  boots_iron: 'Iron Boots',
  shield_iron: 'Iron Shield',
  food_fish: 'Grilled Fish',
  food_block: 'BLOCK Pop',
  rod_sturdy: 'Sturdy Fishing Rod',
  potion_mp_small: 'Small Mana Potion',
  potion_regret: 'Potion of Regret',
  hide_wolf: 'Wolf Hide',
  hide_tough: 'Tough Hide',
  herb_red: 'Red Herb',
  acc_goggles: 'Tinker Goggles',
  acc_lucky_rock: 'Lucky Rock',
  amulet_grandma: "Grandma's Locket",
}

export const QUESTS3: readonly QuestDef[] = [
  // =========================================================================
  // Smithing arc — Smith Orin, the forge he built uphill ON PURPOSE.
  // =========================================================================
  {
    id: 'q3_ore_you_ready',
    title: 'Ore You Ready',
    giver: 'smith_orin',
    regionId: 'ironhold',
    steps: [
      { kind: 'gather', target: 'copper_vein', need: 6, label: 'Mine 6 copper veins' },
      { kind: 'gather', target: 'iron_vein', need: 6, label: 'Mine 6 iron veins' },
    ],
    rewards: { xp: { blacksmithing: 150, mining: 120 }, items: [{ id: 'bar_copper', qty: 2 }] },
    intro:
      "So you carried ore uphill once and now you want to be a SMITH. Fine. Lesson one: a smith who can't find metal is just a sweaty person with opinions about hammers. Six copper veins, six iron. Learn what the mountain feels like before you ask it for favors.",
    outro:
      "Copper AND iron, sorted by hand, barely any gravel padding the sacks — I checked, I always check. Here's two copper bars I made while you were gone, so you can see what competence looks like. Study them. Then stop touching them.",
  },
  {
    id: 'q3_smelting_point',
    title: 'The Smelting Point',
    giver: 'smith_orin',
    regionId: 'ironhold',
    steps: [
      { kind: 'collect', target: 'bar_copper', need: 3, label: 'Smelt 3 copper bars' },
      { kind: 'collect', target: 'bar_iron', need: 3, label: 'Smelt 3 iron bars' },
    ],
    rewards: { xp: { blacksmithing: 260 }, items: [{ id: 'hatchet_iron', qty: 1 }] },
    intro:
      "Lesson two: smelting. Ore goes in, bar comes out, and in between there is a temperature that separates smiths from arsonists. Three copper bars, three iron. The furnace doesn't care about your intentions, only your timing. Your eyebrows are the tuition.",
    outro:
      "Six bars and both eyebrows — show-off. They're lumpy, they're honest, they'll do. Take this iron hatchet I made from somebody's lumpier attempt. In this forge nothing is wasted except my patience.",
  },
  {
    id: 'q3_first_sword',
    title: 'Your First Sword (Condolences)',
    giver: 'smith_orin',
    regionId: 'ironhold',
    steps: [
      { kind: 'collect', target: 'sword_iron', need: 1, label: 'Forge an iron sword' },
      { kind: 'kill', target: 'golem', need: 3, label: 'Field-test it on 3 stone golems' },
    ],
    rewards: { xp: { blacksmithing: 350, attack: 180 }, items: [{ id: 'potion_hp_med', qty: 2 }] },
    intro:
      "Lesson three: the sword. Everyone's first sword is terrible. Mine was terrible. My master's was terrible. It's tradition. Forge an iron sword, then take it out and hit three stone golems with it, because a sword that's never met a rock is just a rumor with a handle.",
    outro:
      "Let me see. Hm. The edge wanders, the balance is a coin toss, and the pommel is... a choice. And it cracked three golems anyway. That's the dirty secret of smithing: terrible swords work FINE. Don't tell the customers. Potions — you've earned the bleeding.",
  },
  {
    id: 'q3_dressed_for_distress',
    title: 'Dressed for Distress',
    giver: 'smith_orin',
    regionId: 'ironhold',
    steps: [
      { kind: 'collect', target: 'helm_iron', need: 1, label: 'Forge an iron helm' },
      { kind: 'collect', target: 'chest_iron', need: 1, label: 'Forge an iron chestplate' },
      { kind: 'collect', target: 'boots_iron', need: 1, label: 'Forge iron boots' },
      { kind: 'talk', target: 'smith_orin', need: 1, label: 'Present the full set to Orin' },
    ],
    rewards: { xp: { blacksmithing: 600, defense: 250 }, items: [{ id: 'shield_iron', qty: 1 }] },
    intro:
      "Final lesson: the set. Helm, chest, boots — armor is a sentence and you're going to write a whole one without the hammer doing the spelling for you. When all three pieces exist and none of them whistle in the wind, bring them here and stand in them like you mean it.",
    outro:
      "Turn around. Again. ...Huh. It fits, it holds, and nothing whistles. You're a smith now — a bad one, which is the only kind of new one. Take the matching shield; I made it years ago for an apprentice who eloped with a hammock. You're the first one worth finishing the set for.",
  },

  // =========================================================================
  // Cooking arc — Merchant Hilda, who also runs the Sleeping Blockling Inn's
  // kitchen, because of course she does, she runs everything.
  // =========================================================================
  {
    id: 'q3_flour_power',
    title: 'Flour Power',
    giver: 'merchant_hilda',
    regionId: 'beginnings',
    steps: [
      { kind: 'gather', target: 'farm_plot', need: 6, label: 'Harvest 6 plots of wheat' },
      { kind: 'collect', target: 'food_bread', need: 4, label: 'Bake 4 loaves of bread' },
    ],
    rewards: { xp: { cooking: 150, farming: 100 }, items: [{ id: 'food_cheese', qty: 2 }] },
    intro:
      "Between us: the shop is a front. My real empire is the Inn's kitchen, and my baker just 'found his bliss', which turned out to be a woman in Greenwood. Harvest six plots and bake me four loaves. Baking is just alchemy you're allowed to serve children. You'll be fine.",
    outro:
      "Four loaves, crusts within legal limits, and only one of them shaped like a grudge. The Inn's guests have stopped complaining, which costs me money — complainers order more ale — but fine, FINE, quality has value. Cheese. Take it. We never discussed the baker.",
  },
  {
    id: 'q3_catch_of_the_day',
    title: 'Catch of the Day, Every Day',
    giver: 'merchant_hilda',
    regionId: 'beginnings',
    steps: [
      { kind: 'gather', target: 'fishing_spot', need: 6, label: 'Fish 6 catches for the kitchen' },
      { kind: 'collect', target: 'food_fish', need: 3, label: 'Grill 3 fish without incident' },
    ],
    rewards: { xp: { cooking: 240, fishing: 140 }, items: [{ id: 'rod_sturdy', qty: 1 }] },
    intro:
      "The Inn's menu says 'Catch of the Day' and for three days the catch has been 'no'. Guests are asking questions. Fish me six catches, then grill three of them — GRILL, not cremate; the smoke alarm is a parrot and he holds grudges. Skin crispy, flesh tender, parrot silent.",
    outro:
      "Crispy, tender, and the parrot said 'acceptable', which from him is a standing ovation. The menu is honest again, which is a strange feeling for this establishment. Take the sturdy rod — my supplier 'lost' it, I 'found' it, commerce is beautiful.",
  },
  {
    id: 'q3_stew_review',
    title: 'The Stew Review',
    giver: 'merchant_hilda',
    regionId: 'beginnings',
    steps: [
      { kind: 'collect', target: 'food_stew', need: 2, label: 'Cook 2 hearty stews' },
      { kind: 'collect', target: 'food_pie', need: 2, label: 'Bake 2 meat pies' },
      { kind: 'talk', target: 'guard_tomas', need: 1, label: 'Serve the tasting menu to the critic (Tomas)' },
    ],
    rewards: { xp: { cooking: 450 }, items: [{ id: 'food_cake', qty: 2 }] },
    intro:
      "Graduation dinner. A food critic is reviewing the Inn tonight. It's Tomas. Yes, the guard. He eats here nine times a week; nobody's palate is better funded. Two hearty stews, two meat pies, served to his post, because the critic cannot leave the gate — it's a whole thing with him.",
    outro:
      "The review is in: 'perimeter fully secured, stew-wise', four stars, one star deducted because you made him share. You're the Inn's cook now, unofficially, unpaid, non-negotiable. Victory cake — eat it before the parrot files his OWN review.",
  },

  // =========================================================================
  // Alchemy arc — Herbalist Moss and the shed the guild pretends not to know
  // about.
  // =========================================================================
  {
    id: 'q3_lab_assistant',
    title: 'Unpaid Lab Assistant',
    giver: 'herbalist_moss',
    regionId: 'greenwood',
    steps: [
      { kind: 'gather', target: 'herb_patch', need: 6, label: 'Pick 6 herb patches' },
      { kind: 'gather', target: 'mushroom_cluster', need: 4, label: 'Harvest 4 mushroom clusters' },
    ],
    rewards: { xp: { alchemy: 150, herbalism: 120 }, items: [{ id: 'potion_mp_small', qty: 2 }] },
    intro:
      "Congratulations! You've been promoted to lab assistant. The pay is experience, the benefits are exposure — to fumes. Alchemy starts with ingredients: six herb patches and four mushroom clusters. Smell everything, taste nothing. That rule is written on the shed wall in a previous assistant's handwriting.",
    outro:
      "Lovely specimens! Fragrant, potent, and only one of the mushrooms screamed, which is well within parameters. Here's some mana potions — assistant-brewed, so hold them away from your face on the first sip. And the second. Just develop longer arms, really.",
  },
  {
    id: 'q3_brew_it_yourself',
    title: 'Brew It Yourself',
    giver: 'herbalist_moss',
    regionId: 'greenwood',
    steps: [
      { kind: 'collect', target: 'potion_hp_small', need: 4, label: 'Brew 4 small health potions' },
    ],
    rewards: { xp: { alchemy: 280 }, items: [{ id: 'potion_mystery', qty: 1 }] },
    intro:
      "Time to brew. The small health potion: the 'hello world' of alchemy. Herb, water, heat, hope. Four of them, red-ish, drinkable-ish. The guild requires I say 'follow the recipe exactly'. The shed requires me to tell you the recipe was written by someone mid-explosion. Interpret boldly.",
    outro:
      "Four potions, all red, none weeping — genuinely top-decile work for a first brew. The guild would certify you if the guild knew this shed existed, which it doesn't, officially, please maintain that. Have a Mystery Potion from MY shelf. The mystery is I also don't remember.",
  },
  {
    id: 'q3_explosive_results',
    title: 'Explosive Results',
    giver: 'herbalist_moss',
    regionId: 'greenwood',
    steps: [
      { kind: 'collect', target: 'potion_regret', need: 2, label: 'Recover 2 Potions of Regret from the... incident' },
      { kind: 'kill', target: 'slime', need: 8, label: 'Re-splat 8 slimes the spill invigorated' },
    ],
    rewards: { xp: { alchemy: 450, attack: 140 }, items: [{ id: 'potion_hp_med', qty: 3 }] },
    intro:
      "Don't panic. SMALL incident. I attempted the guild's new 'vigor tonic', and it backfired — audibly, visibly, and in one case through the roof. The batch rolled downhill, the local slimes drank it, and now they have CARDIO. Re-splat eight of them, and recover two bottles of what the spill became. The label says Potion of Regret. The label is self-aware. Bring it anyway.",
    outro:
      "Both bottles recovered and the slimes are back to their regular, non-aerobic jiggle. I've logged the tonic as 'a learning experience', the roof as 'ventilation', and you as co-author — congratulations, in alchemy the blast radius IS the byline. Health potions. The good batch. Probably the good batch.",
  },

  // =========================================================================
  // Tailoring arc — Archmage Lyra, whose cape line-item survived three
  // budget reviews that the research wing did not.
  // =========================================================================
  {
    id: 'q3_cape_crusade',
    title: 'The Cape Crusade',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'wolf', need: 8, label: 'Requisition materials from 8 wolves' },
      { kind: 'collect', target: 'hide_wolf', need: 6, label: 'Collect 6 wolf hides' },
    ],
    rewards: { xp: { tailoring: 220, attack: 120 }, items: [{ id: 'acc_goggles', qty: 1 }] },
    intro:
      "A wizard is forty percent cape. This is settled science — mine, but settled. My ceremonial cape was damaged in a teleportation 'event' I won't be elaborating on, and the replacement requires wolf hide: supple, dramatic, excellent in a breeze. Eight wolves, six hides. Tell them it's for ACADEMIA.",
    outro:
      "Magnificent hides! Thick enough to billow, soft enough to swirl. The tower's tailoring lab is yours to use — it's the room the budget calls 'textile research' so the Crown keeps funding it. Goggles? Goggles. Pins fly in there. Everything in this tower flies eventually.",
  },
  {
    id: 'q3_dramatic_flutter',
    title: 'Guaranteed Dramatic Flutter',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [
      { kind: 'collect', target: 'hide_tough', need: 4, label: 'Source 4 tough hides for the lining' },
      { kind: 'kill', target: 'wisp', need: 4, label: 'Capture 4 wisps’ worth of glow for the hem' },
      { kind: 'talk', target: 'mage_lyra', need: 1, label: 'Deliver the finished cape to Lyra' },
    ],
    rewards: { xp: { tailoring: 450, magic: 180 }, items: [{ id: 'amulet_grandma', qty: 1 }] },
    intro:
      "Phase two: structure and SPECTACLE. The lining takes tough hide — four pieces, the spiders carry the best and object the most — and the hem gets wisp-glow, four wisps' worth, so the cape flutters dramatically even in still air. Yes, that's the entire function. Forty. Percent.",
    outro:
      "Oh. OH. Look at the drape. Look at the FLUTTER — there isn't even a draft in here, I sealed the windows for this exact test. You've tailored a garment that upstages its wizard, which is the highest compliment and also a small problem for me professionally. Take my grandmother's locket as payment. She'd approve. She also upstaged everyone.",
  },

  // =========================================================================
  // Collection contracts — four NPCs discover the marketplace exists and
  // immediately outsource everything to you.
  // =========================================================================
  {
    id: 'q3_bulk_order_bars',
    title: 'Bulk Order: Bars',
    giver: 'prospector_finn',
    regionId: 'ironhold',
    steps: [
      { kind: 'gather', target: 'iron_vein', need: 5, label: 'Mine 5 iron veins' },
      { kind: 'collect', target: 'bar_iron', need: 5, label: 'Deliver 5 iron bars (smelt or shop, Finn won’t audit)' },
    ],
    rewards: { xp: { mining: 220, blacksmithing: 150 }, items: [{ id: 'acc_lucky_rock', qty: 1 }, { id: 'food_jerky', qty: 3 }] },
    intro:
      "Business opportunity! I've started selling 'artisanal pre-smelted ore' — bars, the word is bars — and demand is through the roof, because I priced them under the smith out of pure friendship and spite. Mine me five veins and deliver five iron bars. Smelt them, buy them, win them in a card game — provenance is a big-city concept.",
    outro:
      "Five bars! Gorgeous. I'll stamp 'FINN' on them and triple the price — branding, friend, it's all branding. Your cut: one genuine lucky rock and some jerky. The rock's luck is unverified, but so are my margins, and look at me thriving.",
  },
  {
    id: 'q3_liquid_assets',
    title: 'Liquid Assets',
    giver: 'banker_aldous',
    regionId: 'capital',
    steps: [
      { kind: 'gather', target: 'gold_vein', need: 4, label: 'Mine 4 gold veins' },
      { kind: 'collect', target: 'bar_gold', need: 2, label: 'Smelt 2 gold bars for the vault' },
    ],
    rewards: { xp: { mining: 300, blacksmithing: 220 }, items: [{ id: 'food_cake', qty: 3 }] },
    intro:
      "You again! Wonderful. Terrible. Both. The audit resurfaced — audits do that, like bodies — and this time the vault needs gold in BAR form, because apparently 'a sack of promising rocks' is not an accounting category. Four veins mined, two bars smelted. The furnace is off-site. The books say there is no furnace.",
    outro:
      "Two bars, vault-grade, ledger-shaped. The auditor wept, and for once it was joy, or at least a professional imitation. Your fee remains cake, because cake leaves no paper trail. Three slices. Eat the evidence. That's banking.",
  },
  {
    id: 'q3_skewer_logistics',
    title: 'Skewer-Based Logistics',
    giver: 'guard_tomas',
    regionId: 'beginnings',
    steps: [
      { kind: 'collect', target: 'food_skewer', need: 5, label: 'Procure 5 meat skewers (any legal-ish source)' },
      { kind: 'talk', target: 'guard_tomas', need: 1, label: 'Deliver the rations to the gate' },
    ],
    rewards: { xp: { cooking: 160, vitality: 120 }, items: [{ id: 'food_cheese', qty: 3 }] },
    intro:
      "Citizen. The gate has entered a new era of readiness, and readiness runs on protein. I require five meat skewers. Cook them, loot them, buy them off the marketplace — I'm told we HAVE a marketplace now, incredible, civilization — I don't audit provenance, I audit FLAVOR. This briefing is classified and also I can hear your stomach, so make it six. No. Five. Discipline.",
    outro:
      "Five skewers, received and — mmf — rigorously inspected. The gate's combat readiness has never been higher or better marinated. Take this cheese from the evidence locker. The evidence locker is a barrel. The barrel is also classified. Dismissed, citizen.",
  },
  {
    id: 'q3_potion_pipeline',
    title: 'The Potion Pipeline',
    giver: 'scout_wren',
    regionId: 'greenwood',
    steps: [
      { kind: 'collect', target: 'herb_red', need: 5, label: 'Collect 5 red herbs' },
      { kind: 'collect', target: 'potion_hp_med', need: 3, label: 'Supply 3 health potions for the patrol cache' },
    ],
    rewards: { xp: { alchemy: 220, herbalism: 160 }, items: [{ id: 'potion_mystery', qty: 2 }] },
    intro:
      "Supply run. My patrol cache is down to one potion and a note that says 'IOU, sorry, bled a lot'. I need five red herbs and three proper health potions — brew them, buy them off the market, shake down a bandit, I genuinely do not care. Logistics is just violence that arrives on time.",
    outro:
      "Cache restocked. The next ranger who bleeds out here will do it with OPTIONS, which is all any of us can ask. Take these mystery potions from the old cache. They predate me. They fizz when you insult them. Don't insult them.",
  },

  // =========================================================================
  // Meta — Elder Rowan discovers the concept of achievements and becomes
  // insufferable about it.
  // =========================================================================
  {
    id: 'q3_trophy_hunter',
    title: 'Trophy Hunter',
    giver: 'elder_rowan',
    regionId: 'beginnings',
    steps: [
      { kind: 'talk', target: 'scout_wren', need: 1, label: 'Get Scout Wren’s grudging endorsement' },
      { kind: 'talk', target: 'foreman_dagna', need: 1, label: 'Get Foreman Dagna’s professional sign-off' },
      { kind: 'talk', target: 'captain_elara', need: 1, label: 'Get Captain Elara’s official stamp' },
      { kind: 'talk', target: 'gravekeeper_sol', need: 1, label: 'Get Gravekeeper Sol’s (and Gerald’s) blessing' },
      { kind: 'talk', target: 'hermit_vex', need: 1, label: 'Get Hermit Vex’s reference, somehow' },
    ],
    rewards: { xp: { vitality: 400 }, items: [{ id: 'food_feast', qty: 1 }, { id: 'ring_participation', qty: 1 }] },
    intro:
      "Have you SEEN the trophy shelf? Someone's keeping a ledger of everything you do — every splat, every chop, every quest, engraved for eternity. I find it magnificent and deeply creepy, in that order. I'm nominating you for 'Realm's Most Employable', but the shelf demands REFERENCES: Wren, Dagna, Elara, Sol, and Vex. Yes, Vex. Bring a snack and low expectations.",
    outro:
      "Five references! Wren wrote 'adequate', Dagna wrote 'load-bearing', Elara stamped it without reading it, Sol's is lovely and smells concerning, and Vex's entire letter is the word 'LEAVING', which I'm choosing to read as a verb about you and a lifestyle about him. The shelf is pleased. The shelf is always watching. Feast's on me.",
  },
  {
    id: 'q3_one_of_everything',
    title: 'One of Everything',
    giver: 'elder_rowan',
    regionId: 'beginnings',
    steps: [
      { kind: 'kill', target: 'slime', need: 1, label: 'A slime, for the shelf' },
      { kind: 'kill', target: 'wolf', need: 1, label: 'A wolf, for the shelf' },
      { kind: 'kill', target: 'bat', need: 1, label: 'A bat, for the shelf' },
      { kind: 'kill', target: 'skeleton', need: 1, label: 'A skeleton, for the shelf' },
      { kind: 'kill', target: 'imp', need: 1, label: 'An imp, for the shelf' },
      { kind: 'kill', target: 'golem', need: 1, label: 'A golem, for the shelf (the shelf is ambitious)' },
    ],
    rewards: { xp: { attack: 350, vitality: 300 }, items: [{ id: 'potion_hp_large', qty: 2 }, { id: 'food_block', qty: 1 }] },
    intro:
      "The shelf has ESCALATED. There's an engraving now for defeating 'one of everything', and an empty plaque with — I checked twice — YOUR name pre-carved on it. Presumptuous? Immensely. Are we doing it anyway? Obviously. One slime, one wolf, one bat, one skeleton, one imp, one golem. In that order. The shelf insists on the order. I've stopped asking the shelf questions.",
    outro:
      "The plaque filled itself in as you worked — letter by letter, which the children found delightful and I found like watching a haunting with good penmanship. 'One of Everything: achieved.' You're immortalized, the shelf is satisfied, and I've draped a cloth over it for everyone's sake. Here's a BLOCK Pop. Lick responsibly. The shelf is probably watching that too.",
  },
] as const

const BY_ID3 = new Map<string, QuestDef>(QUESTS3.map((q) => [q.id, q]))

export function questById3(id: string): QuestDef | undefined {
  return BY_ID3.get(id)
}
