/**
 * questmega_frontier — the outer-continent & islands quest pack (~78 quests).
 *
 * Progression for the far zones: the frozen tundra (brainfreeze / glacier_point /
 * nope_shelf), the drowned coast and its islands (sea species), the sunken bog
 * (drizzlemire / croakening), the mirage desert (mirage_mile), the shattered
 * construct-fields (prism_break) and the volcanic simmering_steps. Givers are the
 * wave-3 outpost NPCs plus a few base quest-givers framing the expedition.
 *
 * Every kill target is a real base or new species id; every gather target is a
 * real node kind; every collect/reward id is a real catalog material/food/potion.
 * No armor-piece ids are granted (those live in other packs). Rewards scale up
 * toward the 999 skill cap across the late boss chains.
 *
 * Side-effect: registers at import time via registerPack({ quests, prereqs,
 * itemNames }). Imported from src/content/index.ts.
 */
import { registerPack } from './packs'
import type { QuestDef } from '../types'

const quests: QuestDef[] = [
  // ══════════════════════════════════════════════════════════════════════
  // ARC A — Survivor Petra · the Frozen Tundra (brainfreeze / glacier_point)
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'q_frontier_01',
    title: 'Welcome to Camp Bad Idea',
    giver: 'survivor_petra',
    regionId: 'brainfreeze',
    steps: [{ kind: 'explore', target: 'brainfreeze', need: 1, label: 'Reach the frozen tundra' }],
    rewards: { xp: { vitality: 300 }, items: [{ id: 'food_jerky', qty: 4 }] },
    intro:
      "Oh good, another one. I'm Petra — Petra the Previous, because I was the last 'hero' through here and look how that's going. You walked to the end of the world on purpose. That's not courage, that's a symptom. Look around, catch frostbite, and come tell me you've seen it.",
    outro:
      "You've seen it. Endless white, wind that files grievances, and the distinct feeling the horizon is judging you. Congratulations, you're officially out past where the maps apologize. Jerky. Eat it before it freezes into a brick.",
  },
  {
    id: 'q_frontier_02',
    title: 'Foxed Again',
    giver: 'survivor_petra',
    regionId: 'brainfreeze',
    steps: [{ kind: 'kill', target: 'tundra_fox', need: 10, label: 'Thin 10 tundra foxes' }],
    rewards: { xp: { attack: 320 }, items: [{ id: 'hide_tough', qty: 4 }], blockCents: 40 },
    intro:
      "Tundra foxes stole my boots, my gloves, and — I want to be clear — my will to live, in that order. They're cute. That's the trap. Ten of them. Do not make eye contact; they'll guilt you into surrendering the jerky you just ate.",
    outro:
      "Ten foxes, relieved of their crime careers. They were wearing my gloves as HATS, the little performers. Take the tough hides — out here, 'cute' is a predator's cover story and you've learned that the hard way.",
  },
  {
    id: 'q_frontier_03',
    title: 'Crag Ram Standoff',
    giver: 'survivor_petra',
    regionId: 'brainfreeze',
    steps: [{ kind: 'kill', target: 'crag_ram', need: 8, label: 'Out-stubborn 8 crag rams' }],
    rewards: { xp: { attack: 360, defense: 160 }, items: [{ id: 'hide_boar', qty: 5 }], blockCents: 45 },
    intro:
      "Crag rams headbutt avalanches for fun and lose, every time, and learn nothing. I respect it, I just can't have it on the one path that isn't a cliff. Eight rams. Whatever you do, don't flinch first — they can smell a coward and they bill by the bruise.",
    outro:
      "Eight rams, out-stubborned by a narrow margin and a lot of yelling. The path's clear. Those hides will stop a hoof, which is suddenly a design requirement in my life. Nice work, you magnificent wall of poor decisions.",
  },
  {
    id: 'q_frontier_04',
    title: 'Cold Reception',
    giver: 'survivor_petra',
    regionId: 'brainfreeze',
    steps: [
      { kind: 'kill', target: 'frost_lynx', need: 9, label: 'Hunt 9 frost lynxes' },
      { kind: 'gather', target: 'crystal_node', need: 6, label: 'Chip 6 ice-crystal nodes' },
    ],
    rewards: { xp: { attack: 380, mining: 200 }, items: [{ id: 'crystal_raw', qty: 6 }], blockCents: 55 },
    intro:
      "Frost lynxes hunt by sitting perfectly still until you convince yourself they're a rock, and then they are very much not a rock. Nine of them. While you're out there bleeding, chip me six crystal nodes — they grow in the ice like the tundra's only good idea.",
    outro:
      "Nine lynxes and six crystals, and you only mistook one for a rock, which is below the regional average. The ice gives up nothing willingly; you took it anyway. That's the frontier spirit, or hypothermia talking. Either way, paid.",
  },
  {
    id: 'q_frontier_05',
    title: 'The Mote in the Blizzard',
    giver: 'survivor_petra',
    regionId: 'brainfreeze',
    steps: [{ kind: 'kill', target: 'mote_frost', need: 12, label: 'Snuff 12 frost motes' }],
    rewards: { xp: { magic: 420 }, items: [{ id: 'crystal_shard', qty: 5 }], blockCents: 60 },
    intro:
      "Frost motes are what happens when the cold gets ambitious — little drifting knots of 'you should sit down and nap' made manifest. The nap is permanent. Pop twelve before the weather gets suggestions, and keep moving, for the love of warm things.",
    outro:
      "Twelve motes dispersed into harmless glitter. You didn't nap, which out here counts as an act of genius. The shards they leave behind are cold enough to sting a glove off. Keep them. Don't lick them. I licked one. Never again.",
  },
  {
    id: 'q_frontier_06',
    title: 'Elemental, My Dear',
    giver: 'survivor_petra',
    regionId: 'brainfreeze',
    steps: [{ kind: 'kill', target: 'elem_frost', need: 6, label: 'Shatter 6 frost elementals' }],
    rewards: { xp: { magic: 480, attack: 200 }, items: [{ id: 'crystal_cut', qty: 4 }], blockCents: 75 },
    intro:
      "The motes were the apprentices. Frost elementals are the management — bigger, meaner, and they hit back with the entire concept of winter. Six of them. Shatter them before they decide the whole valley should be an ice sculpture of you, screaming.",
    outro:
      "Six frost elementals, shattered into expensive-looking debris. The cut crystals in their hearts are worth more than this entire camp, which tells you less about the crystals and more about the camp. Yours. I'm not carrying anything valuable; it attracts foxes.",
  },
  {
    id: 'q_frontier_07',
    title: 'The Glacier Keeps Its Warden',
    giver: 'survivor_petra',
    regionId: 'glacier_point',
    steps: [
      { kind: 'explore', target: 'glacier_point', need: 1, label: 'Climb to Glacier Point' },
      { kind: 'kill', target: 'glacier_warden', need: 3, label: 'Fell 3 glacier wardens' },
    ],
    rewards: { xp: { defense: 560, attack: 260 }, items: [{ id: 'crystal_cut', qty: 5 }, { id: 'bar_steel', qty: 3 }], blockCents: 110 },
    intro:
      "Up at Glacier Point there's a whale frozen mid-breach — long story, ask Karl, don't let him finish — and guarding it are glacier wardens: slabs of living ice that take 'move along' as a personal insult. Three of them. Bring a coat and a grudge.",
    outro:
      "Three wardens, down to meltwater. The whale's still up there, mid-leap, eternally almost. The wardens guarded ice guarding nothing, which is the most frontier thing I've ever heard, and I live here. Steel and crystal. You've earned the right to be cold somewhere nicer.",
  },
  {
    id: 'q_frontier_08',
    title: "A Lich of Sense",
    giver: 'prophet_karl',
    regionId: 'glacier_point',
    steps: [{ kind: 'kill', target: 'lich_frost', need: 2, label: 'Un-maintain 2 frost liches' }],
    rewards: { xp: { magic: 640, attack: 300 }, items: [{ id: 'crystal_cut', qty: 6 }], blockCents: 130 },
    intro:
      "I'm Karl. Whale-Certified. Don't ask. The frost liches up here froze themselves solid to cheat death and now spend eternity being smug AND cold, which is the worst possible combination. Two of them. The whale told me they had it coming. The whale is usually right.",
    outro:
      "Two frost liches, de-smugged permanently. You know what a lich learns at the end? Nothing — that's the whole problem with liches. The whale sends its regards, which I can hear, which is a separate issue I'm managing. Crystals. Go.",
  },
  {
    id: 'q_frontier_09',
    title: 'Wyrmling Season',
    giver: 'prophet_karl',
    regionId: 'glacier_point',
    steps: [{ kind: 'kill', target: 'wyrmling_frost', need: 8, label: 'Chill out 8 frost wyrmlings' }],
    rewards: { xp: { attack: 500 }, items: [{ id: 'hide_tough', qty: 6 }, { id: 'food_honey', qty: 3 }], blockCents: 70 },
    intro:
      "Baby dragons. 'Aww', you say. 'AWW.' Then the aww breathes a cone of absolute-zero and your eyebrows join the whale. Eight frost wyrmlings before they grow into the things that make the whale nervous, and the whale has seen EVERYTHING.",
    outro:
      "Eight wyrmlings, grounded before they graduated to actual problems. Honey for your throat — the cold does a number on it, and you'll want to still be able to scream properly for what's coming. There's always something bigger up here. The whale's seen to that.",
  },
  {
    id: 'q_frontier_10',
    title: 'Permafrost, Permanent Problem',
    giver: 'prophet_karl',
    regionId: 'glacier_point',
    steps: [{ kind: 'kill', target: 'wyrm_permafrost', need: 1, label: 'Slay the Permafrost Wyrm' }],
    rewards: { xp: { attack: 820, defense: 400, magic: 300 }, items: [{ id: 'crystal_cut', qty: 8 }, { id: 'bar_gold', qty: 4 }], blockCents: 220 },
    intro:
      "The Permafrost Wyrm is why nothing thaws up here. It's not malice, it's metabolism — it exhales ten thousand years of winter because that's just what it is. One wyrm. End it and maybe the ice remembers how to be water. The whale thinks you can. The whale has notoriously low standards for 'you can'.",
    outro:
      "The Permafrost Wyrm is dead and, somewhere far below, a single drop of water has decided to be liquid again. That's your doing. The whale wept — or thawed slightly, hard to tell. Gold and crystal, the wyrm's hoard. It won't miss it. It's a drop of water now too.",
  },
  {
    id: 'q_frontier_11',
    title: 'The Last Laugh',
    giver: 'lookout_grettel',
    regionId: 'nope_shelf',
    steps: [
      { kind: 'explore', target: 'nope_shelf', need: 1, label: 'Board the frozen pirate ship' },
      { kind: 'kill', target: 'drownedman', need: 10, label: 'Re-drown 10 drowned crew' },
    ],
    rewards: { xp: { attack: 440, vitality: 220 }, items: [{ id: 'food_jerky', qty: 5 }], blockCents: 65 },
    intro:
      "Grettel, ship's lookout — of a ship that froze mid-mutiny, so the crew's still arguing, just colder and deader. 'Drowned men', though they drowned in ice, which is a fun technicality nobody survived to appreciate. Ten of them back to sleep. Watch the deck, it's slippery with regret.",
    outro:
      "Ten crew, re-drowned and re-quieted. The mutiny's been going for two hundred years and you ended one side of the argument in an afternoon. That's conflict resolution, frontier-style. Jerky. It's the ship's ration. It's also two hundred years old. Enjoy.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // ARC B — Lookout Grettel & the Drowned Coast · sea species / islands
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'q_frontier_12',
    title: 'Crabs All the Way Down',
    giver: 'lookout_grettel',
    regionId: 'nope_shelf',
    steps: [{ kind: 'kill', target: 'reefcrab', need: 12, label: 'Evict 12 reefcrabs' }],
    rewards: { xp: { attack: 300, defense: 140 }, items: [{ id: 'hide_tough', qty: 4 }], blockCents: 40 },
    intro:
      "Reefcrabs have colonized the hull. Twelve of them, pincers like bolt-cutters, personalities like a tax audit. They're trying to take the ship apart faster than the ice is, and it's become a competition I refuse to let the crabs win. Go win it for me.",
    outro:
      "Twelve reefcrabs, decolonized. The ship will now be destroyed by the ice at the leisurely pace it deserves, with dignity. You smell of brine and spite. That's the coast's house perfume. Take the hides — crab's a decent armorer if you ask it rudely.",
  },
  {
    id: 'q_frontier_13',
    title: 'Hop to It',
    giver: 'lookout_grettel',
    regionId: 'nope_shelf',
    steps: [
      { kind: 'kill', target: 'tidehopper', need: 10, label: 'Flatten 10 tidehoppers' },
      { kind: 'kill', target: 'brinebat', need: 8, label: 'Ground 8 brinebats' },
    ],
    rewards: { xp: { attack: 340, archery: 180 }, items: [{ id: 'fish_salmon', qty: 5 }], blockCents: 50 },
    intro:
      "Tidehoppers bounce off the rigging like the ocean learned to be annoying, and brinebats roost in the sails doing whatever the salty cousin of a bat does. Ten hops, eight bats. Clear the air and the deck. One of them already stole my spyglass — the lookout, with no spyglass. The irony is NOT lost on me.",
    outro:
      "Ten hoppers flat, eight bats grounded, spyglass recovered from inside a bat, don't ask how, I did ask how, I regret it. The salmon's fresh from the ice — flash-frozen two centuries ago, it's practically a delicacy now. Eat up, sailor.",
  },
  {
    id: 'q_frontier_14',
    title: 'Puff Piece',
    giver: 'honest_jim',
    regionId: 'nope_shelf',
    steps: [{ kind: 'kill', target: 'pufferpup', need: 11, label: 'Deflate 11 pufferpups' }],
    rewards: { xp: { attack: 320 }, items: [{ id: 'food_jelly', qty: 4 }], blockCents: 45 },
    intro:
      "Honest Jim, pleasure, don't check my pockets. The pufferpups washed up on the shelf and inflate when threatened — into a spiky ball of 'please reconsider'. Eleven of them. I'd sell you a deflation service but you look capable and I look busy. Go on.",
    outro:
      "Eleven pufferpups, deflated, de-spiked, de-problemed. Between us, I was going to sell those spikes as 'sea-unicorn horns' to someone gullible, but you popped the merchandise. No hard feelings — have some jelly. It's honest jelly. Mostly.",
  },
  {
    id: 'q_frontier_15',
    title: 'Mud Season',
    giver: 'maestro_ribbert',
    regionId: 'drizzlemire',
    steps: [
      { kind: 'explore', target: 'drizzlemire', need: 1, label: 'Wade into the Drizzlemire' },
      { kind: 'kill', target: 'mudskip', need: 12, label: 'Pacify 12 mudskips' },
    ],
    rewards: { xp: { attack: 300, vitality: 160 }, items: [{ id: 'mushroom_brown', qty: 6 }], blockCents: 40 },
    intro:
      "Maestro Ribbert, conductor of the Frog Choir, which you will hear whether you want to or not. The mudskips are ruining my acoustics — they flop percussively and they're NOT in the arrangement. Twelve of them, out of the swamp, out of my symphony. Pianissimo, please. With a club.",
    outro:
      "Twelve mudskips, removed from the percussion section they were never invited to join. The Choir can finally hit the wet, mournful notes it was born for. Mushrooms — they grow between the amphibians, perfectly edible, probably, have the Choir try them first. They won't mind. They can't leave.",
  },
  {
    id: 'q_frontier_16',
    title: 'Leech Field Day',
    giver: 'maestro_ribbert',
    regionId: 'drizzlemire',
    steps: [{ kind: 'kill', target: 'bogleech', need: 14, label: 'Salt 14 bogleeches' }],
    rewards: { xp: { attack: 320, herbalism: 200 }, items: [{ id: 'herb_green', qty: 8 }], blockCents: 50 },
    intro:
      "Bogleeches have discovered the Choir stands very still during the slow movements. We've lost three tenors to exsanguination this season — they went flat, THEN pale. Fourteen leeches. Salt them, stomp them, I don't care, just stop my sopranos from fainting mid-aria.",
    outro:
      "Fourteen bogleeches, salted into regret. The Choir's blood pressure has stabilized and the slow movement no longer ends in fainting. Herbs from the mire — they soak up the damp and the dread equally. Press them, dry them, don't think about what they soaked up.",
  },
  {
    id: 'q_frontier_17',
    title: 'Centipede Symphony',
    giver: 'maestro_ribbert',
    regionId: 'drizzlemire',
    steps: [{ kind: 'kill', target: 'centipede_bog', need: 10, label: 'De-leg 10 bog centipedes' }],
    rewards: { xp: { attack: 360, defense: 160 }, items: [{ id: 'hide_tough', qty: 5 }], blockCents: 55 },
    intro:
      "A bog centipede has more legs than the Choir has members, and it uses every one to be upsetting. They nest under the stage — my STAGE, a rotting log, but MINE. Ten of them. The Choir watched one eat a bass last week and now they only sing in terrified whispers.",
    outro:
      "Ten bog centipedes, de-legged and dis-couraged. The bass section has regained enough nerve to sing above a whimper, which for this Choir is a standing ovation. Tough hides from their shells — segmented, horrible, surprisingly good armor. The centipede knew something after all.",
  },
  {
    id: 'q_frontier_18',
    title: 'The Grudge Notary',
    giver: 'tadpole_tony',
    regionId: 'croakening',
    steps: [
      { kind: 'explore', target: 'croakening', need: 1, label: 'Report to Big Gerald’s sign' },
      { kind: 'kill', target: 'plague_rat', need: 12, label: 'Exterminate 12 plague rats' },
    ],
    rewards: { xp: { attack: 340, vitality: 180 }, items: [{ id: 'potion_regret', qty: 2 }], blockCents: 50 },
    intro:
      "Tadpole Tony, Grudge Notary — I write down who wronged whom, and in the Croakening that's a full-time job with overtime. Current top grievance: plague rats, filed by everyone, against everyone's stew pots. Twelve exterminations. I'll notarize it as 'righteous'. Sign here. And here. And here.",
    outro:
      "Twelve plague rats, struck from the ledger of the living. I've notarized the grievance as fully satisfied, with prejudice. Here's a Potion of Regret — not for you, for THEM, symbolically, they're dead, it doesn't matter, Big Gerald insisted on the gesture. Big Gerald is a sign. It's complicated here.",
  },
  {
    id: 'q_frontier_19',
    title: 'Bloated Ambitions',
    giver: 'tadpole_tony',
    regionId: 'croakening',
    steps: [
      { kind: 'kill', target: 'tick_bloated', need: 10, label: 'Pop 10 bloated ticks' },
      { kind: 'kill', target: 'deathmoth_pale', need: 8, label: 'Dust 8 pale deathmoths' },
    ],
    rewards: { xp: { attack: 380, magic: 180 }, items: [{ id: 'herb_red', qty: 6 }], blockCents: 60 },
    intro:
      "Two filings today. Bloated ticks — grievance: they're the size of plums and they POP, which is its own kind of grievance. Pale deathmoths — grievance: they eat the Grudge Ledger, which is tampering with evidence. Ten ticks, eight moths. Don't pop the ticks near your face. Learn from the previous notary. We don't talk about the previous notary.",
    outro:
      "Ten ticks popped — upwind, I noticed, you learn fast — and eight moths dusted before they could amend my records. The Ledger is secure. The red herbs grow where the ticks burst, fed on something I refuse to think about professionally. Take them. Wash them. Twice.",
  },
  {
    id: 'q_frontier_20',
    title: 'Crawler in the Reeds',
    giver: 'tadpole_tony',
    regionId: 'croakening',
    steps: [{ kind: 'kill', target: 'gravecrawler', need: 9, label: 'Re-bury 9 gravecrawlers' }],
    rewards: { xp: { attack: 400, defense: 200 }, items: [{ id: 'bar_iron', qty: 4 }], blockCents: 65 },
    intro:
      "The bog doesn't bury its dead so much as misplace them, and gravecrawlers are what comes back up looking for a complaint form. They keep trying to file against the living for 'being warm'. Grievance DENIED. Nine of them, re-filed underground. Permanently. Notarized.",
    outro:
      "Nine gravecrawlers, re-interred and struck from the active docket. The warm may continue being warm without further litigation. Iron bars — dredged from the mire, rusted honest, Big Gerald vouches for them. Big Gerald is, again, a sign. I will not be taking questions about Big Gerald.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // ARC C — Honest Jim · the Mirage Mile · desert / dunes
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'q_frontier_21',
    title: 'The Mirage Emporium',
    giver: 'honest_jim',
    regionId: 'mirage_mile',
    steps: [{ kind: 'explore', target: 'mirage_mile', need: 1, label: 'Find the Mirage Emporium' }],
    rewards: { xp: { vitality: 320 }, items: [{ id: 'food_pie', qty: 3 }] },
    intro:
      "You found me! Or you found the IDEA of me, out here the two are negotiable. Welcome to the Mirage Mile, where the water's fake, the oases are rumors, and my Emporium sells both at competitive prices. Walk the dunes, confirm I'm real, come back. Mostly real. Realistic.",
    outro:
      "You walked the Mile and you're still thirsty and lightly swindled — that's the authentic Mirage Mile experience, no refunds, none were offered. Here's a pie. It's real. I checked. I bit it to check. That's the one I'm selling you. Enjoy the Emporium, friend.",
  },
  {
    id: 'q_frontier_22',
    title: 'Sting Operation',
    giver: 'honest_jim',
    regionId: 'mirage_mile',
    steps: [{ kind: 'kill', target: 'scorpion_sand', need: 12, label: 'De-sting 12 sand scorpions' }],
    rewards: { xp: { attack: 340 }, items: [{ id: 'hide_tough', qty: 5 }], blockCents: 50 },
    intro:
      "Sand scorpions keep getting into the Emporium's 'exotic goods' crates and then I'm selling live venom to unsuspecting tourists, which is technically a lawsuit. Twelve of them, de-stung, before my customer-satisfaction scores get any more fatal. Mind the tail. The tail minds you.",
    outro:
      "Twelve sand scorpions, permanently out of the inventory. My exotic goods are back to being merely MISLEADING instead of actively lethal, which my lawyer calls 'an improvement'. Tough hides — chitin, really, but 'tough hide' sells better. Marketing, friend. It's all marketing out here.",
  },
  {
    id: 'q_frontier_23',
    title: 'Hyena Business Hours',
    giver: 'honest_jim',
    regionId: 'mirage_mile',
    steps: [
      { kind: 'kill', target: 'savanna_hyena', need: 10, label: 'Shoo 10 savanna hyenas' },
      { kind: 'kill', target: 'locust_swarm', need: 8, label: 'Disperse 8 locust swarms' },
    ],
    rewards: { xp: { attack: 360, archery: 200 }, items: [{ id: 'wheat', qty: 10 }], blockCents: 55 },
    intro:
      "The hyenas laugh at my prices. Literally. They gather outside the Emporium and CACKLE, and it's hurting the brand. And the locusts eat my 'genuine desert wheat' before I can fake-genuine-ly sell it. Ten hyenas, eight swarms. Protect commerce, friend. Commerce is all we have out here, besides sand.",
    outro:
      "Ten hyenas silenced and eight swarms scattered. The Emporium is laughter-free and my wheat is swarm-free, which means it's finally sellable at the premium 'survived the locusts' markup. Here's some for your trouble — real wheat, this time, I'm feeling generous and slightly supervised.",
  },
  {
    id: 'q_frontier_24',
    title: 'King of the Sands',
    giver: 'honest_jim',
    regionId: 'mirage_mile',
    steps: [{ kind: 'kill', target: 'savanna_lion', need: 6, label: 'Dethrone 6 savanna lions' }],
    rewards: { xp: { attack: 440, defense: 200 }, items: [{ id: 'hide_boar', qty: 6 }, { id: 'food_jerky', qty: 4 }], blockCents: 70 },
    intro:
      "There's a pride of savanna lions that's decided the trade road is their 'territory' and the merchants are their 'tolls', paid in merchants. Six lions. I'd negotiate but lions don't haggle, they just eat the first offer. Make the road safe for honest commerce. And me. Mostly me.",
    outro:
      "Six lions, dethroned, the road un-tolled. The merchants can travel again, which means they can reach my Emporium, which means — this is beautiful — they can be swindled by a professional instead of eaten by an amateur. Everybody wins. Mostly me. Jerky, friend.",
  },
  {
    id: 'q_frontier_25',
    title: 'Emperor’s New Sting',
    giver: 'honest_jim',
    regionId: 'mirage_mile',
    steps: [{ kind: 'kill', target: 'scorpion_emperor', need: 3, label: 'Fell 3 emperor scorpions' }],
    rewards: { xp: { attack: 520, defense: 260 }, items: [{ id: 'crystal_shard', qty: 5 }, { id: 'bar_steel', qty: 3 }], blockCents: 95 },
    intro:
      "The sand scorpions have a management tier: emperor scorpions, the size of a market stall, with a sting that could un-alive a golem. Three of them rule the deep dunes. I'd sell you protection but I can't afford my OWN protection, so — partnership? You kill them, I'll claim I helped.",
    outro:
      "Three emperor scorpions, de-throned and de-stinged. The deep dunes have a vacancy at the top and nobody brave enough to fill it, which is exactly how I like my power vacuums — empty and nearby. Crystal and steel from their nest-hoard. Scorpions, hoarding. Everyone out here hoards. It's the climate.",
  },
  {
    id: 'q_frontier_26',
    title: 'Dune Drake Days',
    giver: 'honest_jim',
    regionId: 'mirage_mile',
    steps: [{ kind: 'kill', target: 'drake_dune', need: 5, label: 'Ground 5 dune drakes' }],
    rewards: { xp: { attack: 560, magic: 220 }, items: [{ id: 'bar_gold', qty: 3 }, { id: 'crystal_cut', qty: 3 }], blockCents: 120 },
    intro:
      "Dune drakes swim through sand like it's water and surface under caravans like the world's worst surprise party. Five of them. They've eaten my last four shipments and, more upsettingly, the invoices. I need those drakes gone before my accountant — me — has a breakdown. Also me.",
    outro:
      "Five dune drakes, surfaced one last time, permanently. My caravans can cross without becoming a drake's light snack and my invoices are, at long last, un-eaten. Gold and cut crystal from their sand-hoard. Honest Jim pays honest rates, friend — a phrase I'm legally required to say with a straight face.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // ARC D — Shard-Warden Igor · Prism Break · crystal / construct fields
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'q_frontier_27',
    title: 'The Great Refractor',
    giver: 'shardwarden_igor',
    regionId: 'prism_break',
    steps: [{ kind: 'explore', target: 'prism_break', need: 1, label: 'Reach the Great Refractor' }],
    rewards: { xp: { magic: 360, mining: 200 }, items: [{ id: 'crystal_raw', qty: 5 }] },
    intro:
      "Shard-Warden Igor. I guard the Great Refractor — a crystal the size of a cathedral that splits reality into its component annoyances. It leaks constructs. It leaks light that WALKS. Come see it before you fight it, because afterward you won't trust your own shadow. Reasonable. Neither do I.",
    outro:
      "You've seen the Refractor. Feel that? That's your depth perception filing for divorce. Everything out here is a reflection of a reflection of something that wants you dead. Raw crystal for your trouble — it's real, as far as 'real' means anything within a mile of that thing.",
  },
  {
    id: 'q_frontier_28',
    title: 'Crawl Space',
    giver: 'shardwarden_igor',
    regionId: 'prism_break',
    steps: [{ kind: 'kill', target: 'shard_crawler', need: 12, label: 'Smash 12 shard crawlers' }],
    rewards: { xp: { attack: 360, mining: 220 }, items: [{ id: 'crystal_shard', qty: 6 }], blockCents: 55 },
    intro:
      "Shard crawlers are what flakes off the Refractor when it's stressed, which is always. Little scuttling bits of animate glass that cut everything and feel nothing. Twelve of them. Wear thick gloves. Wear thick everything. The ones I didn't warn properly are a statue garden now.",
    outro:
      "Twelve shard crawlers, smashed back into inanimate glitter. The Refractor sheds more every hour — you're not solving the problem, you're mowing the lawn, but the lawn is made of razors and it's the best any of us can do. Keep the shards. They're sharp. So are you now, probably.",
  },
  {
    id: 'q_frontier_29',
    title: 'Gears of Resentment',
    giver: 'shardwarden_igor',
    regionId: 'prism_break',
    steps: [
      { kind: 'kill', target: 'gearhound', need: 10, label: 'Decommission 10 gearhounds' },
      { kind: 'kill', target: 'cog_sprite', need: 8, label: 'Unwind 8 cog sprites' },
    ],
    rewards: { xp: { attack: 400, defense: 180 }, items: [{ id: 'bar_steel', qty: 4 }], blockCents: 60 },
    intro:
      "The Refractor also leaks CLOCKWORK, because of course it does, why would reality be simple. Gearhounds hunt in packs and never tire, and cog sprites wind them UP when they do, which is cheating. Ten hounds, eight sprites. Break the sprites first or you'll be at this until the heat death of the valley.",
    outro:
      "Ten gearhounds decommissioned, eight cog sprites unwound. The pack won't self-repair tonight, which is the closest thing to peace this place offers. Steel bars from their frames — good metal, ground-up, no longer trying to bite you. An improvement in every metal's life, honestly.",
  },
  {
    id: 'q_frontier_30',
    title: 'Mirror Match',
    giver: 'shardwarden_igor',
    regionId: 'prism_break',
    steps: [{ kind: 'kill', target: 'mirror_golem', need: 6, label: 'Shatter 6 mirror golems' }],
    rewards: { xp: { attack: 440, defense: 240 }, items: [{ id: 'crystal_cut', qty: 5 }], blockCents: 80 },
    intro:
      "Mirror golems copy your fighting style back at you, flawlessly, which means fighting one is just losing to yourself in a very honest review. Six of them. My advice? Fight ugly. Fight in a way you'd be embarrassed to be copied doing. The uglier the better. You look like you have range.",
    outro:
      "Six mirror golems, shattered — you fought ugly enough that your reflections got confused and apologetic. That's a strategy I'm adding to the Warden's notes under 'surprisingly effective, deeply undignified'. Cut crystal from their faces. Don't look too long. You'll start negotiating with it.",
  },
  {
    id: 'q_frontier_31',
    title: 'Sentry Duty',
    giver: 'shardwarden_igor',
    regionId: 'prism_break',
    steps: [
      { kind: 'kill', target: 'brass_sentry', need: 8, label: 'Topple 8 brass sentries' },
      { kind: 'kill', target: 'prism_drone', need: 10, label: 'Ground 10 prism drones' },
    ],
    rewards: { xp: { attack: 460, archery: 240 }, items: [{ id: 'bar_gold', qty: 3 }, { id: 'crystal_shard', qty: 4 }], blockCents: 90 },
    intro:
      "The Refractor built itself guards without asking anyone: brass sentries that march in squares and prism drones that float in triangles and together they make shapes that give me a migraine and give you a crossfire. Eight sentries, ten drones. Break the geometry. The geometry has it coming.",
    outro:
      "Eight sentries toppled, ten drones grounded — the formation's broken and my migraine, for the first time in a season, is merely a headache. Gold and crystal from their cores. The Refractor will build more by week's end. It always does. But tonight the geometry is wrong, and wrong is restful.",
  },
  {
    id: 'q_frontier_32',
    title: 'Clockwork and Daggers',
    giver: 'shardwarden_igor',
    regionId: 'prism_break',
    steps: [{ kind: 'kill', target: 'clockwork_knight', need: 5, label: 'Stop 5 clockwork knights' }],
    rewards: { xp: { attack: 520, defense: 280 }, items: [{ id: 'bar_steel', qty: 5 }, { id: 'crystal_cut', qty: 3 }], blockCents: 100 },
    intro:
      "Clockwork knights are the sentries' officers — same tireless menace, but with tactics and a truly unsettling habit of saluting you before they attack. Five of them. They fight with honor, which is worse, because you can't demoralize a thing that's already at peace with its gears. Just out-last the wind-up.",
    outro:
      "Five clockwork knights, stopped mid-salute. They died courteously, which somehow made it ruder. The valley's chain of command is one link shorter tonight. Steel and crystal from the officer-class frames — finer work, better metal. The Refractor doesn't skimp on its lieutenants. Pity. Them, I mean.",
  },
  {
    id: 'q_frontier_33',
    title: 'The Iron Warden Wakes',
    giver: 'shardwarden_igor',
    regionId: 'prism_break',
    steps: [{ kind: 'kill', target: 'iron_warden', need: 3, label: 'Fell 3 iron wardens' }],
    rewards: { xp: { attack: 600, defense: 340, mining: 200 }, items: [{ id: 'bar_gold', qty: 5 }, { id: 'crystal_cut', qty: 5 }], blockCents: 150 },
    intro:
      "Share a name with me, the iron wardens do, and I RESENT it, because they guard nothing worth guarding and do it with twelve tons of enthusiasm. Three of them hold the inner ring of the Refractor. Fell them and I'll finally be the only Warden in Prism Break, which is a petty goal and I own it completely.",
    outro:
      "Three iron wardens down, and I am, at last, the sole Warden of Prism Break — a title that now means something precisely because I made the competition extinct. That's leadership. Gold and crystal, the inner-ring hoard. You've earned a crack at the thing the wardens were guarding. You'll wish you hadn't.",
  },
  {
    id: 'q_frontier_34',
    title: 'Crystalline Conclusion',
    giver: 'shardwarden_igor',
    regionId: 'prism_break',
    steps: [{ kind: 'kill', target: 'wyrm_crystalline', need: 1, label: 'Slay the Crystalline Wyrm' }],
    rewards: { xp: { attack: 880, defense: 420, magic: 360 }, items: [{ id: 'crystal_cut', qty: 10 }, { id: 'bar_gold', qty: 5 }], blockCents: 240 },
    intro:
      "Here's what the Refractor was really guarding: the Crystalline Wyrm, a dragon that grew inside the great crystal and became part of it — every scale a facet, every breath a thousand cutting lights. One wyrm. It IS the Refractor, basically. Kill it and the leaking stops. Kill it and the valley gets to be one reality again. Mine, if that's alright with everyone.",
    outro:
      "The Crystalline Wyrm is dead and the Great Refractor has gone dark and SILENT for the first time in living memory. One reality. You can trust your shadow again. You can trust the GROUND again. Take the heart-crystals and the gold — a Warden's thanks, and a Warden's warning: the simmering_steps are hotter than all of this, and twice as impatient.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // ARC E — Dormancy Inspector Flora · Simmering Steps · volcanic
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'q_frontier_35',
    title: 'Dormancy Verification',
    giver: 'inspector_flora',
    regionId: 'simmering_steps',
    steps: [{ kind: 'explore', target: 'simmering_steps', need: 1, label: 'Reach the Simmering Steps' }],
    rewards: { xp: { vitality: 360 }, items: [{ id: 'food_pie', qty: 3 }] },
    intro:
      "Dormancy Inspector Flora. My job is to certify that the volcano is 'dormant', a word I use the way a liar uses 'probably'. The Simmering Steps are stairs of cooling lava that are, frankly, not cooling. Walk up. Don't touch the glowing parts. Everything's a glowing part. Good luck.",
    outro:
      "You reached the Steps and you're only slightly on fire, which my clipboard records as 'nominal'. The volcano is 'dormant' in the sense that it hasn't killed EVERYONE yet, a bar it clears daily by the narrowest margin. Pie. It's warm. Everything's warm here. That's the whole problem.",
  },
  {
    id: 'q_frontier_36',
    title: 'Hot Under the Collar',
    giver: 'inspector_flora',
    regionId: 'simmering_steps',
    steps: [{ kind: 'kill', target: 'cinder_hound', need: 12, label: 'Douse 12 cinder hounds' }],
    rewards: { xp: { attack: 400 }, items: [{ id: 'hide_tough', qty: 5 }], blockCents: 55 },
    intro:
      "Cinder hounds are the volcano's guard dogs, if dogs were made of embers and bad temper. Twelve of them patrol the lower Steps and they do NOT respect my clipboard, my authority, or the posted dormancy notices. Douse them. Carry water. Carry a LOT of water. It evaporates on the way.",
    outro:
      "Twelve cinder hounds, doused and decommissioned. My dormancy notices remain un-respected but at least un-eaten now. The tough hides don't burn, which up here is the single most valuable property a material can have. Keep them close. Keep them BETWEEN you and everything else.",
  },
  {
    id: 'q_frontier_37',
    title: 'Blobbing Up',
    giver: 'inspector_flora',
    regionId: 'simmering_steps',
    steps: [
      { kind: 'kill', target: 'magma_blob', need: 10, label: 'Cool 10 magma blobs' },
      { kind: 'kill', target: 'sulfur_sprite', need: 8, label: 'Snuff 8 sulfur sprites' },
    ],
    rewards: { xp: { attack: 420, magic: 200 }, items: [{ id: 'ore_gold', qty: 6 }], blockCents: 65 },
    intro:
      "Magma blobs are slimes that went to a worse neighborhood and came back molten. Sulfur sprites are the smell given legs and spite. Ten blobs, eight sprites. The blobs split when you hit them wrong, so hit them right, and the sprites make your eyes water, so cry professionally and keep swinging.",
    outro:
      "Ten blobs cooled to slag, eight sprites snuffed. The air's gone from 'rotten egg' back to merely 'apocalyptic', which my sinuses count as a holiday. Gold ore from the cooled blobs — the volcano cooks it right out of the rock, the one genuinely useful thing it does besides threaten us.",
  },
  {
    id: 'q_frontier_38',
    title: 'Imp-ossible Standards',
    giver: 'inspector_flora',
    regionId: 'simmering_steps',
    steps: [
      { kind: 'kill', target: 'ash_imp', need: 11, label: 'Extinguish 11 ash imps' },
      { kind: 'kill', target: 'fiendling', need: 9, label: 'Banish 9 fiendlings' },
    ],
    rewards: { xp: { attack: 440, magic: 240 }, items: [{ id: 'crystal_shard', qty: 5 }], blockCents: 70 },
    intro:
      "Ash imps and fiendlings are the volcano's unpaid interns — small, numerous, on fire, and CONSTANTLY asking the bigger demons for 'exposure'. Eleven imps, nine fiendlings. If you let them network, next week they're pit brutes. Nip the career ladder in the bud. Firmly. Repeatedly.",
    outro:
      "Eleven ash imps and nine fiendlings, career paths permanently ended. The demon-economy's entry level has collapsed, which trickles up delightfully. Crystal shards — they cool in the imps' ash, little black-and-red things, surprisingly pretty for something that was recently trying to set you alight.",
  },
  {
    id: 'q_frontier_39',
    title: 'Crawl, Don’t Walk',
    giver: 'inspector_flora',
    regionId: 'simmering_steps',
    steps: [
      { kind: 'kill', target: 'soot_crawler', need: 10, label: 'Stomp 10 soot crawlers' },
      { kind: 'kill', target: 'ember_crawler', need: 10, label: 'Stomp 10 ember crawlers' },
    ],
    rewards: { xp: { attack: 460, defense: 220 }, items: [{ id: 'bar_steel', qty: 4 }], blockCents: 75 },
    intro:
      "Soot crawlers and ember crawlers infest the vents like the world's worst carpet. Ten of each. The soot ones blind you, the ember ones brand you, and together they've turned a routine dormancy inspection into a game of 'guess which part of me is burning now'. I'm sick of that game. End it.",
    outro:
      "Ten soot, ten ember, twenty fewer reasons to look down in terror. The vents are crawlable again — bad word choice, walkable, they're WALKABLE now. Steel bars, vent-forged, tempered in air that would cremove your eyebrows at a glance. Good metal. Expensive eyebrows.",
  },
  {
    id: 'q_frontier_40',
    title: 'Gloom and Doom',
    giver: 'inspector_flora',
    regionId: 'simmering_steps',
    steps: [{ kind: 'kill', target: 'gloom_imp', need: 10, label: 'Dispel 10 gloom imps' }],
    rewards: { xp: { magic: 500, attack: 220 }, items: [{ id: 'crystal_cut', qty: 4 }], blockCents: 80 },
    intro:
      "Gloom imps are ash imps that read one depressing book and now radiate despair as an attack — you fight them AND the sudden conviction that it's all pointless. Ten of them. It is NOT all pointless. My clipboard gives purpose to my days. Dispel the imps. Reject the gloom. Fill out the form.",
    outro:
      "Ten gloom imps dispelled, and the oppressive certainty that nothing matters has lifted to the baseline existential dread I consider cozy. You held onto your purpose, which here is a combat skill. Cut crystal, clear and cold — hold it when the gloom comes back. It will. But so will you, apparently.",
  },
  {
    id: 'q_frontier_41',
    title: 'Brute Force',
    giver: 'inspector_flora',
    regionId: 'simmering_steps',
    steps: [{ kind: 'kill', target: 'pit_brute', need: 5, label: 'Topple 5 pit brutes' }],
    rewards: { xp: { attack: 560, defense: 300 }, items: [{ id: 'bar_gold', qty: 3 }, { id: 'hide_boar', qty: 5 }], blockCents: 100 },
    intro:
      "Those interns you didn't stop last season? Pit brutes now. Congratulations to them, condolences to you. Five of them, each the size of a siege engine with the temperament of a stubbed toe. Topple them before they make MIDDLE management. There is no bottom to how bad the demon org chart can get.",
    outro:
      "Five pit brutes, toppled, the demon org chart beheaded at the middle. Morale among the surviving fiendlings is in free-fall, which is a morale I'm thrilled to crush. Gold and hide. You fight like the volcano personally owes you money. It does, actually. We all do. It's a very hot economy.",
  },
  {
    id: 'q_frontier_42',
    title: 'Char Broiled',
    giver: 'inspector_flora',
    regionId: 'simmering_steps',
    steps: [{ kind: 'kill', target: 'char_drake', need: 5, label: 'Ground 5 char drakes' }],
    rewards: { xp: { attack: 600, magic: 260 }, items: [{ id: 'bar_gold', qty: 4 }, { id: 'crystal_cut', qty: 3 }], blockCents: 120 },
    intro:
      "Char drakes nest in the caldera and dive on anything that casts a shadow, which up here is just 'anything'. Five of them. They breathe fire, obviously, because what ELSE would they breathe, this is the WORST neighborhood. Ground them before they torch my only road down. I have forms to file at sea level.",
    outro:
      "Five char drakes, grounded, the road down un-torched and open. You've bought me a trip to sea level, where the air doesn't try to cook me — I'd forgotten it could do that, just BE air. Gold and crystal from the nests. The caldera's quieter now. Quiet, up here, is just the volcano inhaling. Enjoy it anyway.",
  },
  {
    id: 'q_frontier_43',
    title: 'The Brimstone Fiend',
    giver: 'inspector_flora',
    regionId: 'simmering_steps',
    steps: [{ kind: 'kill', target: 'brimstone_fiend', need: 3, label: 'Banish 3 brimstone fiends' }],
    rewards: { xp: { attack: 680, magic: 340, defense: 260 }, items: [{ id: 'bar_gold', qty: 5 }, { id: 'crystal_cut', qty: 5 }], blockCents: 170 },
    intro:
      "Top of the demon food chain before the truly unspeakable: brimstone fiends. Three of them run the caldera like a cartel, taxing lesser demons in screams and setting examples in flame. Banish all three. There's a vacuum at the top I'd love to leave empty and verify as, officially, dormant.",
    outro:
      "Three brimstone fiends, banished, the cartel dissolved, the caldera leaderless and sulking. I can nearly, ALMOST, with a straight face, stamp this region 'dormant' — except for the one thing left, the thing even the fiends paid tribute to. You've met everything that feared it. Now go meet IT. Gold, crystal, and my professional condolences.",
  },
  {
    id: 'q_frontier_44',
    title: 'Ashfall',
    giver: 'inspector_flora',
    regionId: 'simmering_steps',
    steps: [{ kind: 'kill', target: 'dragon_ashfall', need: 1, label: 'Slay the Ashfall Dragon' }],
    rewards: { xp: { attack: 999, defense: 500, magic: 450, vitality: 400 }, items: [{ id: 'bar_gold', qty: 8 }, { id: 'crystal_cut', qty: 10 }, { id: 'food_cake', qty: 2 }], blockCents: 320 },
    intro:
      "The Ashfall Dragon IS the volcano — every eruption is it rolling over in its sleep, every ash-cloud is its breath. 'Dormant' was always a lie I told so the maps would stop screaming. One dragon. Slay it and I can write 'dormant' and MEAN it for the first time in my career. No pressure. Enormous pressure. The most pressure. Go.",
    outro:
      "The Ashfall Dragon is dead. The Simmering Steps are COOLING — genuinely, honestly cooling, for the first time in recorded history — and I am stamping this region DORMANT with a hand that will not stop shaking. You did it. You cleared the last map that apologized. Gold, crystal, and cake — real cake, baked at sea level, where I'm moving IMMEDIATELY. Thank you. Don't come back. Nothing's left to inspect.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // ARC F — The Long Expedition · Captain Elara frames the whole frontier
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'q_frontier_45',
    title: 'The Crown Wants the Edge Mapped',
    giver: 'captain_elara',
    regionId: 'capital',
    steps: [
      { kind: 'explore', target: 'brainfreeze', need: 1, label: 'Survey the frozen tundra' },
      { kind: 'explore', target: 'mirage_mile', need: 1, label: 'Survey the Mirage Mile' },
      { kind: 'explore', target: 'simmering_steps', need: 1, label: 'Survey the Simmering Steps' },
    ],
    rewards: { xp: { vitality: 500 }, items: [{ id: 'food_pie', qty: 3 }, { id: 'potion_regret', qty: 1 }], blockCents: 80 },
    intro:
      "The Crown has heard there's a whole continent past the Forgotten Lands and would like it 'surveyed', by which they mean 'someone expendable should walk into it and either return with a map or not return, both are data'. Their words. The memo's framed. Ice, sand, fire — hit all three, come back with a pulse. That's the mission.",
    outro:
      "Frozen, parched, and singed, in that order, and still breathing — the Crown's cartographers are weeping, partly from your notes, partly from the implication they'll be asked to go next. Pie, and a Potion of Regret for the Crown's sense of priorities. You've out-survived the frontier's opening argument. It has more.",
  },
  {
    id: 'q_frontier_46',
    title: 'Beasts of the Far Meadows',
    giver: 'captain_elara',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'meadow_fawn', need: 10, label: 'Cull 10 meadow fawns' },
      { kind: 'kill', target: 'horned_stag', need: 6, label: 'Fell 6 horned stags' },
    ],
    rewards: { xp: { attack: 380, archery: 200 }, items: [{ id: 'hide_tough', qty: 5 }, { id: 'food_jerky', qty: 4 }], blockCents: 60 },
    intro:
      "Don't let 'fawn' fool you. The far-meadow herds past the frontier gate grew up mean — the fawns kick like mules and the horned stags have gored two of my scouts and 'felt nothing', per the one who lived. Ten fawns, six stags. Bring back hides. Bring back dignity. The herd's been collecting both.",
    outro:
      "Ten fawns and six stags, and the far meadows remember fear again. My surviving scout wants their gored tabard back; the stag was wearing it as a trophy. Tough hides and jerky. Venison's venison, even when the venison was winning. You've bloodied the frontier's welcome mat. Keep going. It gets toothier.",
  },
  {
    id: 'q_frontier_47',
    title: 'Predator Patrol',
    giver: 'captain_elara',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'thicket_lynx', need: 8, label: 'Hunt 8 thicket lynxes' },
      { kind: 'kill', target: 'shadow_panther', need: 5, label: 'Hunt 5 shadow panthers' },
    ],
    rewards: { xp: { attack: 440, defense: 200 }, items: [{ id: 'hide_boar', qty: 6 }], blockCents: 70 },
    intro:
      "The frontier's cats hunt the scouts who hunt the herds — thicket lynxes from the brush, shadow panthers from, apparently, inside the concept of darkness. Eight lynxes, five panthers. The panthers are the problem. You won't see them. You'll see the aftermath, then you'll BE the aftermath, unless you're better than my last three patrols. Be better.",
    outro:
      "Eight lynxes, five panthers, and the frontier's night is five shades less lethal. The panthers never saw you coming, which is a rich, satisfying reversal I'll be savoring in the after-action report. Boar hide, tough as the cats that nearly wore YOUR hide. The food chain's been edited. You're near the top now. Only a few things left above you.",
  },
  {
    id: 'q_frontier_48',
    title: 'Pack Mentality',
    giver: 'captain_elara',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'ridgeback_hound', need: 10, label: 'Break 10 ridgeback hounds' },
      { kind: 'kill', target: 'pack_raptor', need: 8, label: 'Scatter 8 pack raptors' },
    ],
    rewards: { xp: { attack: 480, vitality: 240 }, items: [{ id: 'hide_tough', qty: 6 }, { id: 'food_jerky', qty: 5 }], blockCents: 80 },
    intro:
      "Ridgeback hounds and pack raptors hunt in coordinated packs that are, I'll be honest, better organized than my garrison. Ten hounds, eight raptors. They flank. They feint. They have what I can only call 'doctrine'. Break the packs before the frontier's apex predators learn to take notes from them.",
    outro:
      "Ten hounds broken, eight raptors scattered, their terrible doctrine unlearned by force. My garrison, watching your technique, has asked for 'whatever that was' in writing. Tough hide and jerky — pack-hunter leather holds a seam like loyalty. You've out-pack-ed the pack hunters. There's bigger game that hunts alone. That's next.",
  },
  {
    id: 'q_frontier_49',
    title: 'The Big Bruins',
    giver: 'captain_elara',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'grizzled_bruin', need: 5, label: 'Fell 5 grizzled bruins' },
      { kind: 'kill', target: 'cave_bear', need: 4, label: 'Fell 4 cave bears' },
    ],
    rewards: { xp: { attack: 560, defense: 300 }, items: [{ id: 'hide_boar', qty: 8 }, { id: 'food_honey', qty: 4 }], blockCents: 100 },
    intro:
      "Grizzled bruins and cave bears are the frontier's self-employed wrecking crews — no pack, no doctrine, just mass and a grudge against anything upright. Five bruins, four bears. They stand taller than a barn door and hit like one falling on you. Bring a big weapon and bigger nerve. Bring the nerve especially.",
    outro:
      "Five bruins and four cave bears, felled — the frontier's heavyweights have a new champion and it's, regrettably for my paperwork, you. Boar hide by the armful and honey raided from the bears' stashes; they'll miss the honey more than the dying, bears being bears. You're running out of things on four legs that can threaten you. The things on two legs and the things with WINGS remain.",
  },
  {
    id: 'q_frontier_50',
    title: 'Boar War',
    giver: 'captain_elara',
    regionId: 'capital',
    steps: [{ kind: 'kill', target: 'dire_boar', need: 9, label: 'Fell 9 dire boars' }],
    rewards: { xp: { attack: 500, vitality: 260 }, items: [{ id: 'hide_boar', qty: 10 }, { id: 'food_jerky', qty: 5 }], blockCents: 85 },
    intro:
      "Dire boars have rooted up the frontier road into a trench and gored every surveyor's stake flat. Nine of them. They charge first and have no second thought because they have no first thought either — it's pure forward. Meet the charge or become part of the road. The road's hungry. The road's mostly boars now.",
    outro:
      "Nine dire boars, felled, the road un-trenched and the surveyor's stakes standing again. The boars charged to the last, thoughtlessly, gloriously — you can't demoralize a thing with no morale to begin with, so you just out-stood it. Boar hide and jerky, the spoils of a very stupid war. Stupid, but WON. Onward.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // ARC G — The Outer Isles · Honest Jim's "shipping line" (sea bosses)
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'q_frontier_51',
    title: 'The Outer Isles Await',
    giver: 'honest_jim',
    regionId: 'mirage_mile',
    steps: [{ kind: 'gather', target: 'fishing_spot', need: 12, label: 'Fish the outer shallows 12 times' }],
    rewards: { xp: { fishing: 420 }, items: [{ id: 'fish_salmon', qty: 6 }], blockCents: 55 },
    intro:
      "Past the desert coast there's a scatter of islands the maps call 'the Outer Isles' and the sailors call 'the reason we don't sail that way'. I'm starting a shipping line. First, provisions. Fish the outer shallows — twelve casts. If something enormous tugs back, let go of the rod. Rods are cheaper than you. Marginally.",
    outro:
      "Twelve casts, a real haul, and whatever was down there decided you weren't worth surfacing for — yet. The Outer Isles shipping line is PROVISIONED, friend. Salmon for you, infamy for me, and a route no sane captain will sail, which keeps my costs down. Everybody wins. Mostly me. Obviously me.",
  },
  {
    id: 'q_frontier_52',
    title: 'Sand in the Wrong Places',
    giver: 'honest_jim',
    regionId: 'mirage_mile',
    steps: [
      { kind: 'kill', target: 'sandwraith', need: 10, label: 'Lay 10 sandwraiths' },
      { kind: 'kill', target: 'beetle_dung', need: 8, label: 'Squash 8 dung beetles' },
    ],
    rewards: { xp: { attack: 400, defense: 180 }, items: [{ id: 'crystal_shard', qty: 5 }], blockCents: 60 },
    intro:
      "The isthmus to the Isles is haunted — sandwraiths, the ghosts of travelers who trusted a mirage, which, hypocritically, I sell. And dung beetles the size of carts rolling boulders of, well, use your imagination, right across my ONLY land route. Ten wraiths, eight beetles. Clear the road to the sea. The sea's where the real money drowns.",
    outro:
      "Ten sandwraiths laid to rest and eight dung beetles rolled off the road, boulders and all. The isthmus is passable and only faintly cursed, which for this region is practically a tourist board endorsement. Crystal shards from the wraiths — ghosts hoard the weirdest things. Onward to the water, friend.",
  },
  {
    id: 'q_frontier_53',
    title: 'Wasp Factor',
    giver: 'honest_jim',
    regionId: 'mirage_mile',
    steps: [
      { kind: 'kill', target: 'wasp_paper', need: 12, label: 'Burn 12 paper wasp nests' },
      { kind: 'kill', target: 'wasp_hornet', need: 8, label: 'Down 8 hornets' },
    ],
    rewards: { xp: { attack: 420, archery: 220 }, items: [{ id: 'herb_gold', qty: 4 }], blockCents: 65 },
    intro:
      "The coastal cliffs where I want to build my DOCK are infested with paper wasps and hornets the size of your thumb and twice as judgmental. Twelve nests, eight hornets. They've already chased off two work crews and stung my foreman into early retirement and a lifelong grudge. Clear the cliffs. Commerce demands it. I demand it. The foreman demands revenge but he's useless now.",
    outro:
      "Twelve nests burned, eight hornets downed, the cliffs sting-free and dock-ready. My foreman wept with vindication, which was awkward for everyone. Gold herb grows in the cliff cracks — I'd sell it as 'wasp-blessed vitality tonic' but you earned it honestly, a word I'm using loosely and under duress. Take it.",
  },
  {
    id: 'q_frontier_54',
    title: 'Coral Reckoning',
    giver: 'lookout_grettel',
    regionId: 'nope_shelf',
    steps: [{ kind: 'kill', target: 'coralgolem', need: 6, label: 'Shatter 6 coral golems' }],
    rewards: { xp: { attack: 480, defense: 260 }, items: [{ id: 'crystal_cut', qty: 4 }, { id: 'bar_steel', qty: 3 }], blockCents: 85 },
    intro:
      "Coral golems guard the shallows of the Outer Isles — living reefs that stood up and developed opinions about trespassers. Six of them. They move slow but they hit like a shipwreck, which, fun fact, several of them USED to be. Shatter them before they add your boat to the collection. Grettel's seen collections. Grettel is OVER collections.",
    outro:
      "Six coral golems, shattered back into scenic hazard. The shallows are navigable, or at least survivable, which out here is the same word. Cut crystal and steel from the wreck-coral — two centuries of sunken ships, compressed into something you can hold. History, friend. Sharp, heavy history. Mind your fingers.",
  },
  {
    id: 'q_frontier_55',
    title: 'Something Pale Below',
    giver: 'lookout_grettel',
    regionId: 'nope_shelf',
    steps: [
      { kind: 'kill', target: 'frostfin', need: 10, label: 'Hook 10 frostfins' },
      { kind: 'kill', target: 'anglerfiend', need: 6, label: 'Land 6 anglerfiends' },
    ],
    rewards: { xp: { attack: 500, archery: 260 }, items: [{ id: 'fish_salmon', qty: 6 }, { id: 'crystal_shard', qty: 4 }], blockCents: 90 },
    intro:
      "The deep channel between the Isles runs cold and WRONG. Frostfins swarm it like living hail and anglerfiends lure you in with a pretty light and a mouth you don't see until it's the last thing you see. Ten frostfins, six anglers. Don't follow the lights. I followed a light once. I'm the lookout now BECAUSE I followed a light. Learn from me.",
    outro:
      "Ten frostfins and six anglerfiends, hauled up and ended. The channel's a little less hungry tonight. You didn't follow the lights — you ARE the one the lights should've feared, which rewrites the whole food chart down there. Salmon and crystal. The deep's not done with us. The deep is NEVER done. But it's done with those six.",
  },
  {
    id: 'q_frontier_56',
    title: 'The Krakenling Nursery',
    giver: 'lookout_grettel',
    regionId: 'nope_shelf',
    steps: [{ kind: 'kill', target: 'krakenling', need: 8, label: 'Cull 8 krakenlings' }],
    rewards: { xp: { attack: 540, defense: 280 }, items: [{ id: 'crystal_cut', qty: 5 }, { id: 'food_honey', qty: 3 }], blockCents: 110 },
    intro:
      "Between the far Isles there's a cove where the krakenlings nest — baby krakens, each already the size of a longboat, each a down-payment on a nightmare. Eight of them. Cull the nursery before they grow into the thing their MOTHER is, and their mother is why this whole coast is called 'nope'. Do it fast. Do it quiet. Mother listens.",
    outro:
      "Eight krakenlings culled, the nursery thinned, and Mother — far below — has gone very, very still. That's either grief or planning. Out here it's always planning. Cut crystal from the cove and honey for your nerves; you'll want them steady. There's exactly one thing bigger left in this water, and you just made it ANGRY.",
  },
  {
    id: 'q_frontier_57',
    title: 'Here Be Serpents',
    giver: 'lookout_grettel',
    regionId: 'nope_shelf',
    steps: [{ kind: 'kill', target: 'seaserpent', need: 4, label: 'Slay 4 sea serpents' }],
    rewards: { xp: { attack: 620, defense: 320 }, items: [{ id: 'crystal_cut', qty: 6 }, { id: 'bar_gold', qty: 4 }], blockCents: 150 },
    intro:
      "The old maps drew serpents at the edges as a joke. The joke is here, it's real, it's four serpents long enough to belt the horizon, and it's wrapped around the last Isle like it's hugging it to death. Four serpents. Slay them and the final Isle opens — the one with the thing even Mother Kraken swims AROUND. Yeah. That one.",
    outro:
      "Four sea serpents, slain, uncoiled from the last Isle, which now lies open and waiting and far too quiet. The edge-of-the-map joke isn't funny anymore; it's just your resume. Gold and crystal, serpent-hoard, dragged up from where they'd dragged it down. One thing left out here. The biggest thing. It's been watching you work. Go introduce yourself.",
  },
  {
    id: 'q_frontier_58',
    title: 'The Tidewraith',
    giver: 'lookout_grettel',
    regionId: 'nope_shelf',
    steps: [{ kind: 'kill', target: 'tidewraith', need: 1, label: 'Banish the Tidewraith of the last Isle' }],
    rewards: { xp: { attack: 900, defense: 460, magic: 400 }, items: [{ id: 'crystal_cut', qty: 10 }, { id: 'bar_gold', qty: 6 }, { id: 'food_cake', qty: 2 }], blockCents: 280 },
    intro:
      "The Tidewraith is every soul this coast ever drowned, braided into one grieving flood that walks on legs of seawater. It's why the coast is 'nope'. It's why I'M here, two hundred years a lookout, waiting for someone who could end it instead of joining it. One wraith. Banish it, and the drowned finally rest, me included, probably, in the good way this time. Go on. I've waited long enough.",
    outro:
      "The Tidewraith is banished, and all along the coast the drowned are sinking back into a sleep they were denied for centuries — I can feel the ship's old crew settle, finally silent. You unmade the thing that unmade this whole shore. Take the hoard, and the cake, and this, from a lookout who can finally stop looking: thank you. I'm going to watch one more sunset, properly, and then I think I'll rest too. In the good way. You earned us all that.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // ARC H — The Dormant Tyrants · Prophet Karl's doomsaying (mega-dragons)
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'q_frontier_59',
    title: 'The Whale Was Right',
    giver: 'prophet_karl',
    regionId: 'glacier_point',
    steps: [{ kind: 'kill', target: 'mote_cinder', need: 12, label: 'Snuff 12 cinder motes' }],
    rewards: { xp: { magic: 460 }, items: [{ id: 'crystal_shard', qty: 5 }], blockCents: 65 },
    intro:
      "The whale's been telling me for forty years that the elements are waking up all across the frontier, and the whale, I remind you, is FROZEN and DEAD and still MORE reliable than the Crown's forecasters. It starts with motes. Cinder motes, drifting in from the fire-lands. Twelve. Snuff them. The whale says it begins small. The whale is never wrong. Mostly never.",
    outro:
      "Twelve cinder motes, snuffed, and the whale has gone quiet in that way that means 'I told you so' in whale. The elements ARE stirring, friend — fire, frost, stone, storm, void — all of it coming awake at once, all of it heading our way. Crystal shards. We'll need more than shards. The whale says so. The whale is, regrettably, right.",
  },
  {
    id: 'q_frontier_60',
    title: 'Storm Warning',
    giver: 'prophet_karl',
    regionId: 'glacier_point',
    steps: [
      { kind: 'kill', target: 'mote_spark', need: 10, label: 'Ground 10 spark motes' },
      { kind: 'kill', target: 'elem_storm', need: 6, label: 'Disperse 6 storm elementals' },
    ],
    rewards: { xp: { magic: 520, archery: 240 }, items: [{ id: 'crystal_cut', qty: 4 }], blockCents: 80 },
    intro:
      "The spark motes came first, like the whale said, and now storm elementals are condensing out of the frontier sky — walking thunderheads with OPINIONS and a 100% chance of lightning aimed at you. Ten motes, six elementals. The whale says if we let the storm settle, it never leaves. The whale survived a harpoon AND an ice age. Trust the whale.",
    outro:
      "Ten spark motes grounded, six storm elementals dispersed back into weather. The sky over the frontier is merely threatening now instead of actively hostile. The whale approves, or the ice shifted, same thing. Cut crystal, lightning-charged, humming faintly — hold it in a storm and it sings. Don't hold it in a storm, actually. Terrible advice. The whale agrees.",
  },
  {
    id: 'q_frontier_61',
    title: 'Gale Force',
    giver: 'prophet_karl',
    regionId: 'glacier_point',
    steps: [{ kind: 'kill', target: 'elem_gale', need: 5, label: 'Disperse 5 gale elementals' }],
    rewards: { xp: { magic: 580, defense: 240 }, items: [{ id: 'crystal_cut', qty: 5 }, { id: 'bar_steel', qty: 3 }], blockCents: 100 },
    intro:
      "Gale elementals are storm elementals that skipped leg day and became ALL arms — screaming cyclones that throw you, your sword, and your last words in three different directions. Five of them. The whale says the gales herald the storm-wyrm, which is a sentence I hate, from a mouth that's frozen shut, which makes it worse somehow.",
    outro:
      "Five gale elementals, dispersed to a dead calm. The frontier can hear itself think again, briefly. The whale says 'briefly' is the only kind of calm the frontier gets, and the whale has never once oversold a doom. Steel and crystal. Hold onto both. The storm-wyrm is coming, the whale insists, and the whale has a frankly unbeatable forecasting record for a dead mammal.",
  },
  {
    id: 'q_frontier_62',
    title: 'Stone Cold',
    giver: 'prophet_karl',
    regionId: 'glacier_point',
    steps: [
      { kind: 'kill', target: 'mote_pebble', need: 10, label: 'Crush 10 pebble motes' },
      { kind: 'kill', target: 'elem_stone', need: 6, label: 'Topple 6 stone elementals' },
    ],
    rewards: { xp: { defense: 560, mining: 300 }, items: [{ id: 'ore_gold', qty: 6 }, { id: 'crystal_raw', qty: 5 }], blockCents: 90 },
    intro:
      "The earth's waking too — pebble motes skittering up out of the ground and stone elementals shrugging whole hillsides onto their shoulders. Ten motes, six elementals. The whale says stone is the patient element; it waits a thousand years to roll over and crush you, and its patience just ran out. Ours should too. Go.",
    outro:
      "Ten pebble motes crushed, six stone elementals toppled back into rubble and resentment. The ground's stopped trying to stand up and walk off with the frontier. Gold ore and raw crystal from the elementals' cores — the earth hoards its best in its heart, like everything out here, like the whale, like me, like you now, I'd wager. Patient and dangerous. Good combination.",
  },
  {
    id: 'q_frontier_63',
    title: 'The Void Stares Back',
    giver: 'prophet_karl',
    regionId: 'glacier_point',
    steps: [
      { kind: 'kill', target: 'mote_void', need: 10, label: 'Seal 10 void motes' },
      { kind: 'kill', target: 'elem_void', need: 5, label: 'Banish 5 void elementals' },
    ],
    rewards: { xp: { magic: 680, attack: 300 }, items: [{ id: 'crystal_cut', qty: 6 }, { id: 'potion_regret', qty: 1 }], blockCents: 130 },
    intro:
      "Last and worst of the stirrings: the void. Void motes are little holes in the world where the frontier forgot to exist, and void elementals are the holes gone AMBITIOUS. Ten motes, five elementals. The whale won't even describe what they herald — the whale, which narrated its OWN harpooning in detail, goes SILENT on this. That silence is the most frightened I've ever heard a dead whale be. Seal them. Please.",
    outro:
      "Ten void motes sealed, five void elementals banished back into the nothing they leaked from. The holes in the world have closed, and the whale has started talking again, which I'm choosing to find reassuring rather than terrifying. Cut crystal, and a Potion of Regret — the void leaves you with a lot of it, best to have the bottled kind handy. The elements are all stirred now, every last one. The whale says their MASTERS come next. Plural. Rest while you can.",
  },
  {
    id: 'q_frontier_64',
    title: 'The Rime Dragon',
    giver: 'prophet_karl',
    regionId: 'glacier_point',
    steps: [{ kind: 'kill', target: 'dragon_rime', need: 1, label: 'Slay the Rime Dragon' }],
    rewards: { xp: { attack: 999, defense: 520, magic: 480 }, items: [{ id: 'crystal_cut', qty: 12 }, { id: 'bar_gold', qty: 7 }, { id: 'food_cake', qty: 2 }], blockCents: 340 },
    intro:
      "First of the masters, the one the whale fears most because it's the one that got the WHALE: the Rime Dragon. Pure frozen wrath, old as the last ice age, the thing that flash-froze a breaching whale mid-leap for the CRIME of being warm. One dragon. The whale's waited forty years, frozen in that leap, for someone to settle the score. Settle it. For the whale. For all of us. Mostly the whale.",
    outro:
      "The Rime Dragon is DEAD, and up at Glacier Point the whale — I swear this on my whale certification — the whale FINISHED ITS LEAP. Two hundred years frozen mid-breach and it came down with a splash that soaked the whole point, free at last, and then it was still, properly still, at peace. You settled the oldest score on the frontier. Gold, crystal, cake. The whale says thank you. The whale says there are more masters. But the whale says it SMILING now. Go rest. You've earned the whale's smile, and that's the rarest reward out here.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // ARC I — The Great Constructs · Shard-Warden Igor (titan bosses)
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'q_frontier_65',
    title: 'Sentinels of the Shards',
    giver: 'shardwarden_igor',
    regionId: 'prism_break',
    steps: [{ kind: 'kill', target: 'crystal_sentinel', need: 8, label: 'Fell 8 crystal sentinels' }],
    rewards: { xp: { attack: 540, defense: 280 }, items: [{ id: 'crystal_cut', qty: 5 }], blockCents: 90 },
    intro:
      "With the Refractor dark, you'd think the constructs would stop. You'd be WRONG, which is the frontier's favorite thing for you to be. Crystal sentinels — bigger, older, self-winding — have risen from the deep shards to 'restore order', meaning kill everything that moved while they were buried. Eight of them. Restore order to THEM.",
    outro:
      "Eight crystal sentinels, felled, their notion of 'order' permanently disordered. The deep shards are quieter, which only means the BIG things down there have noticed the small things have stopped reporting in. Cut crystal. You've woken the lower levels, Warden-to-be. The things down there make the sentinels look like the toys they are.",
  },
  {
    id: 'q_frontier_66',
    title: 'The Elemental Crystal',
    giver: 'shardwarden_igor',
    regionId: 'prism_break',
    steps: [
      { kind: 'kill', target: 'elem_crystal', need: 6, label: 'Shatter 6 crystal elementals' },
      { kind: 'kill', target: 'elem_frost', need: 6, label: 'Shatter 6 frost elementals' },
    ],
    rewards: { xp: { magic: 600, attack: 280 }, items: [{ id: 'crystal_cut', qty: 6 }, { id: 'bar_gold', qty: 3 }], blockCents: 110 },
    intro:
      "The deep shards have started growing crystal elementals — the element of 'sharp expensive murder' given a body — and the cold down there breeds frost elementals to match. Six of each. They refract your spells back at you and freeze your footing, which is a combination I'd admire if it weren't aimed at my only competent visitor. Shatter them.",
    outro:
      "Six crystal and six frost elementals, shattered into a fortune's worth of debris. The deep shards have lost their elemental guard. Gold and cut crystal — take the fortune, you bled for it, and Prism Break pays its debts in the only currency it has, which is 'shiny things that recently tried to kill you'. Standard frontier wages.",
  },
  {
    id: 'q_frontier_67',
    title: 'Prism Drake Descent',
    giver: 'shardwarden_igor',
    regionId: 'prism_break',
    steps: [{ kind: 'kill', target: 'drake_prism', need: 5, label: 'Ground 5 prism drakes' }],
    rewards: { xp: { attack: 640, magic: 320 }, items: [{ id: 'crystal_cut', qty: 7 }, { id: 'bar_gold', qty: 4 }], blockCents: 140 },
    intro:
      "Prism drakes roost in the lower Refractor and breathe LIGHT — not fire, light, focused to a line that cuts stone and resolve equally. Five of them. They dive from angles that shouldn't exist, split into copies that shouldn't be solid, and generally cheat at physics. Ground them. Their descent guards the stairway to the last thing down there.",
    outro:
      "Five prism drakes, grounded, their light extinguished and their cheating-at-physics concluded. The stairway down is open, and down it waits the construct the whole valley was built to contain — the one even the iron wardens knelt to. Gold and crystal, drake-hoard. Rest, drink, and then descend. A Warden faces what's below. You're a Warden now, nearly. Earn the 'nearly'.",
  },
  {
    id: 'q_frontier_68',
    title: 'The Aegis Titan',
    giver: 'shardwarden_igor',
    regionId: 'prism_break',
    steps: [{ kind: 'kill', target: 'aegis_titan', need: 1, label: 'Fell the Aegis Titan' }],
    rewards: { xp: { attack: 999, defense: 600, magic: 420 }, items: [{ id: 'crystal_cut', qty: 12 }, { id: 'bar_gold', qty: 7 }, { id: 'food_cake', qty: 2 }], blockCents: 360 },
    intro:
      "At the bottom of the shards stands the Aegis Titan — the first construct, the one the Refractor grew EVERYTHING ELSE to protect. A walking fortress of living crystal and ancient brass, asleep for an age, and your descent has it stirring. One Titan. Fell it and Prism Break is finally, fully MINE to warden in peace. Fail and it 'restores order' to the entire frontier. No pressure. Shattering pressure. Facet it.",
    outro:
      "The Aegis Titan is FELLED — the first construct, the last guardian, down in a cascade of crystal that rang across the whole valley like a struck bell. Prism Break is silent, and SAFE, and mine to warden over a peace you forged with your own hands. Take the Titan's heart-crystals and its ancient gold, and take this title, which I don't give lightly because I give nothing lightly: you are a Warden of the Frontier. The maps don't apologize for Prism Break anymore. You rewrote them. Cake. Go. Rest. You've earned a view that isn't trying to kill you.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // ARC J — Bog & Barrow finale · Maestro Ribbert & the deep graves
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'q_frontier_69',
    title: 'The Choir Invisible',
    giver: 'maestro_ribbert',
    regionId: 'drizzlemire',
    steps: [
      { kind: 'kill', target: 'ghoul_grave', need: 10, label: 'Re-inter 10 grave ghouls' },
      { kind: 'kill', target: 'corpse_imp', need: 8, label: 'Snuff 8 corpse imps' },
    ],
    rewards: { xp: { attack: 480, magic: 240 }, items: [{ id: 'herb_red', qty: 6 }, { id: 'potion_regret', qty: 1 }], blockCents: 85 },
    intro:
      "The bog's dead have started HUMMING ALONG, and I'll tell you, a grave ghoul cannot hold a tune and a corpse imp cannot hold a REST — they come in a half-beat early, every time, it's RUINING the requiem. Ten ghouls, eight imps. I conduct the living and the dead, but only one section gets to be IN MY CHOIR and it is not the rude one.",
    outro:
      "Ten ghouls re-interred, eight corpse imps snuffed, the uninvited section evicted from my arrangement. The requiem can breathe again. Red herbs and a Potion of Regret — for the ghouls, who'll never sing on-key again, and good riddance, art is suffering but it is MY suffering, not theirs. Pianissimo. Finally.",
  },
  {
    id: 'q_frontier_70',
    title: 'Barrow Depths',
    giver: 'maestro_ribbert',
    regionId: 'drizzlemire',
    steps: [
      { kind: 'kill', target: 'barrow_wight', need: 7, label: 'Lay 7 barrow wights' },
      { kind: 'kill', target: 'crypt_widow', need: 6, label: 'Burn 6 crypt widows' },
    ],
    rewards: { xp: { attack: 520, defense: 260 }, items: [{ id: 'crystal_shard', qty: 5 }, { id: 'bar_iron', qty: 4 }], blockCents: 95 },
    intro:
      "Below the Choir's stage — below the rotting log, I mean — there are BARROWS, old graves of a people who buried their kings standing up, and the barrow wights and crypt widows down there do NOT appreciate my acoustics seeping through the floor. Seven wights, six widows. They've been scratching at the boards in protest. The barrows have NOTES. I will not be given NOTES by the dead.",
    outro:
      "Seven barrow wights laid flat, six crypt widows burned out of their webs. The scratching's stopped; the barrows have withdrawn their notes with extreme prejudice. Crystal and iron, grave-goods of standing kings — they won't miss them, they're lying down now, as is traditional for the DECEASED. The deepest barrow, though, still has a tenant. The loudest one.",
  },
  {
    id: 'q_frontier_71',
    title: 'Knight of the Cursed Choir',
    giver: 'maestro_ribbert',
    regionId: 'drizzlemire',
    steps: [{ kind: 'kill', target: 'boneknight_cursed', need: 4, label: 'Unmake 4 cursed boneknights' }],
    rewards: { xp: { attack: 620, defense: 340 }, items: [{ id: 'bar_gold', qty: 4 }, { id: 'crystal_cut', qty: 4 }], blockCents: 130 },
    intro:
      "The standing kings had standing GUARDS: cursed boneknights, still at their posts a thousand years on, still swinging the moment anyone disturbs the barrow's peace, which my CONTINUOUS REQUIEM apparently does. Four of them. Unmake them. They died defending a corpse's nap and they'll not take it out on my sopranos.",
    outro:
      "Four cursed boneknights, unmade, their thousand-year watch finally relieved. The barrows are nearly quiet — nearly. Gold and crystal from their armor, a king's ransom in guard's kit. There's one thing left in the deepest grave, friend, the thing the knights were GUARDING, and when it wakes it won't give notes. It'll give a performance. Bring your whole voice.",
  },
  {
    id: 'q_frontier_72',
    title: 'The Obsidian Dragon',
    giver: 'maestro_ribbert',
    regionId: 'drizzlemire',
    steps: [{ kind: 'kill', target: 'dragon_obsidian', need: 1, label: 'Slay the Obsidian Dragon of the deep barrow' }],
    rewards: { xp: { attack: 999, defense: 540, magic: 440, vitality: 420 }, items: [{ id: 'bar_gold', qty: 8 }, { id: 'crystal_cut', qty: 10 }, { id: 'food_cake', qty: 2 }], blockCents: 350 },
    intro:
      "The thing the standing kings were really buried AROUND, the thing the boneknights guarded, the thing my requiem has been — oh no — WAKING, note by note, for a whole season: the Obsidian Dragon. Black glass and old death, coiled under the deepest barrow since before the bog was a bog. One dragon. End it before my art ends US. I'll conduct your battle-hymn. It's the least I can do. It's also all I can do; I'm a frog in a swamp.",
    outro:
      "The Obsidian Dragon is SLAIN, and the deep barrow has gone silent in the final, settled way — no scratching, no humming, no notes. The Choir sang your battle-hymn through the whole fight; I conducted with my whole frog heart and we did NOT come in early, not once, our finest performance. You ended the thing my art accidentally woke. Gold, crystal, cake — real cake, I had the Choir bake it, don't ask with what, it's a FROG CHOIR, it's fine. Encore. You magnificent, murderous soloist. Encore.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // ARC K — Last Verifications · Inspector Flora's final sign-offs
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'q_frontier_73',
    title: 'Insect Audit',
    giver: 'inspector_flora',
    regionId: 'simmering_steps',
    steps: [
      { kind: 'kill', target: 'mantis_blade', need: 8, label: 'Fell 8 blade mantises' },
      { kind: 'kill', target: 'beetle_rhino', need: 6, label: 'Flip 6 rhino beetles' },
    ],
    rewards: { xp: { attack: 500, defense: 240 }, items: [{ id: 'hide_tough', qty: 6 }, { id: 'herb_gold', qty: 3 }], blockCents: 90 },
    intro:
      "Before I can file the final dormancy paperwork I'm legally required to audit the local megafauna, which out here means BUGS THE SIZE OF HORSES. Blade mantises that can fence, rhino beetles that can joust. Eight mantises, six beetles. My clipboard needs their threat-levels downgraded to 'deceased', the only threat-level I trust.",
    outro:
      "Eight blade mantises felled, six rhino beetles flipped and finished. The megafauna audit is complete and the threat-levels are all, satisfyingly, 'deceased'. Tough hide and gold herb — the bugs grew the herb ON themselves, like armor, like a salad that fights back. Pressed and filed. The paperwork nears completion. One category left.",
  },
  {
    id: 'q_frontier_74',
    title: 'Chasm and Recluse',
    giver: 'inspector_flora',
    regionId: 'simmering_steps',
    steps: [
      { kind: 'kill', target: 'centipede_chasm', need: 7, label: 'De-leg 7 chasm centipedes' },
      { kind: 'kill', target: 'spider_recluse', need: 8, label: 'Burn out 8 recluse spiders' },
      { kind: 'kill', target: 'spider_funnel', need: 8, label: 'Collapse 8 funnel-webs' },
    ],
    rewards: { xp: { attack: 560, archery: 280 }, items: [{ id: 'crystal_shard', qty: 6 }, { id: 'hide_boar', qty: 5 }], blockCents: 110 },
    intro:
      "The lava chasms are the last un-audited zone and they are, per my binoculars, a horror of chasm centipedes and venomous spiders — recluses that hide and funnel-webs that DON'T, which is almost worse. Seven centipedes, eight recluses, eight funnels. Audit them. Thoroughly. I'll stay up here and supervise, which is a word I use for 'watch, appalled, from a safe distance'.",
    outro:
      "Seven chasm centipedes, eight recluses, eight funnel-webs — the chasms are audited and the last threat-levels are 'deceased' across the board. I watched the whole thing through the binoculars, appalled and impressed in roughly equal measure. Crystal and hide. Every zone is accounted for now. Every category downgraded. There's just the sign-off left. And the thing the sign-off is ABOUT.",
  },
  {
    id: 'q_frontier_75',
    title: 'Final Dormancy Sign-Off',
    giver: 'inspector_flora',
    regionId: 'simmering_steps',
    steps: [
      { kind: 'kill', target: 'dread_maw', need: 2, label: 'Slay 2 dread maws' },
      { kind: 'kill', target: 'balor_spawn', need: 3, label: 'Banish 3 balor spawn' },
    ],
    rewards: { xp: { attack: 680, magic: 360, defense: 300 }, items: [{ id: 'bar_gold', qty: 5 }, { id: 'crystal_cut', qty: 5 }, { id: 'food_pie', qty: 3 }], blockCents: 180 },
    intro:
      "The absolute last entries on my audit before I can sign this cursed region dormant: dread maws, which are mouths that learned to walk, and balor spawn, which are what the brimstone fiends PRAYED to. Two maws, three spawn. Clear them and I will sign this clipboard with a flourish, retire, and never feel warm again as long as I live, which will be a BLESSING.",
    outro:
      "Two dread maws slain, three balor spawn banished, and I am signing — SIGNED — this region, with a FLOURISH, as officially, legally, verifiably DORMANT. My career's magnum opus is a single stamped word that is finally TRUE. Gold, crystal, pie. You cleared the frontier's hottest corner one monster at a time and made an honest inspector of me, which I'd frankly given up on. Go. Be cool somewhere. You've earned the whole frontier's thanks, and mine, which is rarer, because I almost never mean it.",
  },
  {
    id: 'q_frontier_76',
    title: 'Grettel’s Last Reef',
    giver: 'lookout_grettel',
    regionId: 'nope_shelf',
    steps: [
      { kind: 'gather', target: 'fishing_spot', need: 15, label: 'Dredge the quiet shallows 15 times' },
      { kind: 'kill', target: 'drownedman', need: 8, label: 'Re-rest 8 of the newly drowned' },
    ],
    rewards: { xp: { fishing: 520, attack: 300 }, items: [{ id: 'fish_salmon', qty: 8 }, { id: 'crystal_cut', qty: 3 }], blockCents: 100 },
    intro:
      "Now that the Tidewraith's gone the coast is QUIET, and in the quiet a few stragglers have surfaced — latecomers to the drowning, confused, cold, and in your way. Eight of them, re-rested gently. And dredge the shallows while you're down there; with the wraith gone, the good fishing's come back for the first time in two centuries. Enjoy it. I can't eat. But you enjoy it.",
    outro:
      "Eight stragglers re-rested and fifteen hauls from water that's finally, FINALLY just water — no wraith, no curse, just fish, like it was meant to be before any of this. Salmon and crystal. Take it with a dead lookout's blessing. You gave this coast back its quiet AND its fish. That's more than any hero before you managed, and I watched them ALL fail. You didn't. Go well.",
  },
  {
    id: 'q_frontier_77',
    title: 'The Siege of Nothing',
    giver: 'shardwarden_igor',
    regionId: 'prism_break',
    steps: [
      { kind: 'kill', target: 'siege_golem', need: 4, label: 'Topple 4 siege golems' },
      { kind: 'kill', target: 'obsidian_automaton', need: 4, label: 'Unmake 4 obsidian automatons' },
    ],
    rewards: { xp: { attack: 640, defense: 360, mining: 260 }, items: [{ id: 'bar_gold', qty: 5 }, { id: 'crystal_cut', qty: 6 }], blockCents: 150 },
    intro:
      "With the Aegis Titan down, its unfinished reinforcements woke up CONFUSED and started a siege against a fortress that no longer has a commander — so they're besieging NOTHING, loudly, forever, and it's disturbing my hard-won peace. Four siege golems, four obsidian automatons. End the pointless war. Peace, as I'm learning, is a thing you have to keep RE-winning. Tedious. Go win it again.",
    outro:
      "Four siege golems toppled, four obsidian automatons unmade, the siege of nothing concluded on account of no combatants. Prism Break is, at last, PEACEFUL — the real, boring, wonderful kind of peaceful that I will defend to my dying breath by sending YOU to deal with it. Gold and crystal. A Warden's work is never done, but tonight, somehow, it's done enough. Rest, fellow Warden. You've earned the silence. I'll keep it warm. Cold. I'll keep it COLD. It's Prism Break.",
  },
  {
    id: 'q_frontier_78',
    title: 'The Rune Colossus',
    giver: 'shardwarden_igor',
    regionId: 'prism_break',
    steps: [{ kind: 'kill', target: 'rune_colossus', need: 1, label: 'Fell the Rune Colossus' }],
    rewards: { xp: { attack: 999, defense: 999, magic: 500, mining: 400 }, items: [{ id: 'bar_gold', qty: 10 }, { id: 'crystal_cut', qty: 12 }, { id: 'food_cake', qty: 3 }], blockCents: 400 },
    intro:
      "One thing stirred when the Titan fell that even I didn't know was buried: the Rune Colossus, the Refractor's FINAL fail-safe, a mountain of inscribed crystal that activates only when every other guardian is gone — which, thanks to you, they now are. One Colossus. Fell it and the frontier's construct-age ENDS, here, with you. This is the last guardian of the last zone. After this, the maps don't just stop apologizing. They stop WARNING. Fell it, Warden. Finish the frontier.",
    outro:
      "The Rune Colossus is FELLED — the final fail-safe, the last guardian of the last zone, down in a toppling of inscribed crystal that shook the whole continent and then left it, for the first time in all of history, genuinely QUIET. You finished the frontier. Every zone cleared, every tyrant ended, every map rewritten from 'here be monsters' to 'here be peace, hard-won'. Take the Colossus's runic gold and heart-crystals, and take the title fully now, no 'nearly' about it: you are THE Warden of the Frontier, the one who tamed the untamable edge of the world. The cake's the biggest I could find. You've earned all three of it. Go home a legend. You made the maps stop screaming. Nobody's ever done that. Nobody but you.",
  },
]

/** Chains so the frontier reads as a real expedition, zone by zone. */
const prereqs: Record<string, readonly string[]> = {
  // Tundra (Petra / Karl)
  q_frontier_02: ['q_frontier_01'],
  q_frontier_03: ['q_frontier_02'],
  q_frontier_04: ['q_frontier_03'],
  q_frontier_05: ['q_frontier_04'],
  q_frontier_06: ['q_frontier_05'],
  q_frontier_07: ['q_frontier_06'],
  q_frontier_08: ['q_frontier_07'],
  q_frontier_09: ['q_frontier_08'],
  q_frontier_10: ['q_frontier_09'],
  q_frontier_11: ['q_frontier_07'],
  // Coast (Grettel)
  q_frontier_13: ['q_frontier_12'],
  q_frontier_14: ['q_frontier_12'],
  // Bog (Ribbert / Tony)
  q_frontier_16: ['q_frontier_15'],
  q_frontier_17: ['q_frontier_16'],
  q_frontier_19: ['q_frontier_18'],
  q_frontier_20: ['q_frontier_19'],
  // Desert (Jim)
  q_frontier_22: ['q_frontier_21'],
  q_frontier_23: ['q_frontier_22'],
  q_frontier_24: ['q_frontier_23'],
  q_frontier_25: ['q_frontier_24'],
  q_frontier_26: ['q_frontier_25'],
  // Prism (Igor)
  q_frontier_28: ['q_frontier_27'],
  q_frontier_29: ['q_frontier_28'],
  q_frontier_30: ['q_frontier_29'],
  q_frontier_31: ['q_frontier_30'],
  q_frontier_32: ['q_frontier_31'],
  q_frontier_33: ['q_frontier_32'],
  q_frontier_34: ['q_frontier_33'],
  // Volcano (Flora)
  q_frontier_36: ['q_frontier_35'],
  q_frontier_37: ['q_frontier_36'],
  q_frontier_38: ['q_frontier_37'],
  q_frontier_39: ['q_frontier_38'],
  q_frontier_40: ['q_frontier_39'],
  q_frontier_41: ['q_frontier_40'],
  q_frontier_42: ['q_frontier_41'],
  q_frontier_43: ['q_frontier_42'],
  q_frontier_44: ['q_frontier_43'],
  // Expedition (Elara)
  q_frontier_46: ['q_frontier_45'],
  q_frontier_47: ['q_frontier_46'],
  q_frontier_48: ['q_frontier_47'],
  q_frontier_49: ['q_frontier_48'],
  q_frontier_50: ['q_frontier_49'],
  // Outer Isles (Jim → Grettel sea bosses)
  q_frontier_52: ['q_frontier_51'],
  q_frontier_53: ['q_frontier_52'],
  q_frontier_54: ['q_frontier_53'],
  q_frontier_55: ['q_frontier_54'],
  q_frontier_56: ['q_frontier_55'],
  q_frontier_57: ['q_frontier_56'],
  q_frontier_58: ['q_frontier_57'],
  // Dormant Tyrants (Karl's elements → Rime Dragon)
  q_frontier_60: ['q_frontier_59'],
  q_frontier_61: ['q_frontier_60'],
  q_frontier_62: ['q_frontier_61'],
  q_frontier_63: ['q_frontier_62'],
  q_frontier_64: ['q_frontier_63'],
  // Great Constructs (Igor titans)
  q_frontier_66: ['q_frontier_65'],
  q_frontier_67: ['q_frontier_66'],
  q_frontier_68: ['q_frontier_67'],
  // Barrow finale (Ribbert)
  q_frontier_70: ['q_frontier_69'],
  q_frontier_71: ['q_frontier_70'],
  q_frontier_72: ['q_frontier_71'],
  // Final sign-offs (Flora)
  q_frontier_74: ['q_frontier_73'],
  q_frontier_75: ['q_frontier_74'],
  // Wind-down epilogues
  q_frontier_76: ['q_frontier_58'],
  q_frontier_77: ['q_frontier_68'],
  q_frontier_78: ['q_frontier_77'],
}

/** Display names for collect/reward ids that may not carry a catalog name. */
const itemNames: Record<string, string> = {
  potion_regret: 'Potion of Regret',
  crystal_cut: 'Cut Crystal',
  crystal_shard: 'Crystal Shard',
  crystal_raw: 'Raw Crystal',
  bar_gold: 'Gold Bar',
  bar_steel: 'Steel Bar',
  bar_iron: 'Iron Bar',
  ore_gold: 'Gold Ore',
  hide_tough: 'Tough Hide',
  hide_boar: 'Boar Hide',
  herb_gold: 'Golden Herb',
  herb_red: 'Red Herb',
  herb_green: 'Green Herb',
  food_honey: 'Pot of Honey',
  food_jelly: 'Wobbling Jelly',
  food_jerky: 'Travel Jerky',
  food_cake: 'Tiny Expensive Cake',
  fish_salmon: 'Salmon',
}

registerPack({ quests, prereqs, itemNames })
