/**
 * questmega_forge_master — the big mining / smelting / blacksmithing ladder.
 *
 * ~75 quests that walk a blockling from "hold the pick the correct way round"
 * all the way to the endgame material tiers (mythril, adamant, obsidian and
 * the stuff the smiths only whisper about). Every step target is a real
 * species id (kill), node kind (gather), item id (collect) or region id
 * (explore); every reward id is a real catalog material/food/potion, plus
 * skill XP (scaling toward the 999 cap on the late chains) and blockCents.
 * No new item ids, armor-piece ids, meshes or recipes are introduced here —
 * nothing dangles or renders as the "?" fallback crate.
 *
 * Givers all resolve to existing Ironhold/Forgotten NPCs (smiths, wardens,
 * smelters, the prospector). Side-effect: registers at import time via
 * registerPack({ quests, prereqs, itemNames }). Imported from content/index.ts.
 *
 * Writing register: mature cartoon comedy. The forge is hot, the pay is bad,
 * and the mountain has never once apologized.
 */
import { registerPack } from './packs'
import type { QuestDef } from '../types'

const quests: QuestDef[] = [
  // ======================================================================
  // CHAIN A — Copper apprenticeship (Foreman Dagna)
  // ======================================================================
  {
    id: 'q_forge_master_01',
    title: 'Which End Is the Pick',
    giver: 'foreman_dagna',
    regionId: 'ironhold',
    steps: [{ kind: 'gather', target: 'copper_vein', need: 6, label: 'Mine 6 copper veins' }],
    rewards: { xp: { mining: 120 }, items: [{ id: 'ore_copper', qty: 6 }], blockCents: 20 },
    intro:
      "Everyone starts at copper, because copper is soft and so are you. Six veins. Hold the heavy end away from your face — I'm not filling out the form twice this week.",
    outro:
      "Six veins, zero self-inflicted injuries, a personal best for a first-dayer. Keep the ore. Keep the arms. Both are harder to replace than you'd think.",
  },
  {
    id: 'q_forge_master_02',
    title: 'Copper-Bottomed Promise',
    giver: 'foreman_dagna',
    regionId: 'ironhold',
    steps: [
      { kind: 'gather', target: 'copper_vein', need: 10, label: 'Mine 10 copper veins' },
      { kind: 'kill', target: 'bat', need: 6, label: 'Clear 6 bats off the seam' },
    ],
    rewards: { xp: { mining: 180, attack: 60 }, items: [{ id: 'bar_copper', qty: 4 }], blockCents: 30 },
    intro:
      "The rich copper seam is further in, which means bats. The bats think the seam is theirs. The bats cannot sign a lease. Ten veins, six bats, settle the ownership question with volume.",
    outro:
      "Seam secured, bats relocated to the great cave ceiling in the sky. Here's copper bar for your trouble — already smelted, so you can't ruin it.",
  },
  {
    id: 'q_forge_master_03',
    title: 'Clay Today, Gone Tomorrow',
    giver: 'npc_ironhold_smelt_greta',
    regionId: 'ironhold',
    steps: [{ kind: 'gather', target: 'clay_pit', need: 8, label: 'Dig 8 clay pits' }],
    rewards: { xp: { mining: 140 }, items: [{ id: 'clay_lump', qty: 8 }], blockCents: 15 },
    intro:
      "You can't smelt in a bucket, genius, you need crucibles, and crucibles need clay. Eight pits. It's wet, it's cold, it gets everywhere, it builds character you didn't order.",
    outro:
      "Eight lumps of good grey clay. I'll fire them into crucibles overnight and you'll never thank the crucibles, nobody does. Take the extra clay, make a pot, have a hobby.",
  },
  {
    id: 'q_forge_master_04',
    title: 'The Fuel Run',
    giver: 'npc_ironhold_smelt_greta',
    regionId: 'ironhold',
    steps: [
      { kind: 'gather', target: 'oak_tree', need: 8, label: 'Fell 8 oaks for charcoal' },
      { kind: 'gather', target: 'pine_tree', need: 6, label: 'Fell 6 pines for kindling' },
    ],
    rewards: { xp: { woodcutting: 160, mining: 40 }, items: [{ id: 'wood_oak', qty: 6 }], blockCents: 25 },
    intro:
      "A forge eats wood like a goblin eats regret: constantly and without shame. Oak burns slow, pine starts it. Eight oak, six pine, and no, you can't burn the foreman's chair, I already asked.",
    outro:
      "That'll keep the furnace honest for a week. You've got sap in your hair and splinters in your pride. That's just Tuesday here.",
  },
  {
    id: 'q_forge_master_05',
    title: 'First Bars, Few Tears',
    giver: 'npc_ironhold_smelt_greta',
    regionId: 'ironhold',
    steps: [{ kind: 'collect', target: 'bar_copper', need: 6, label: 'Produce 6 copper bars' }],
    rewards: { xp: { blacksmithing: 200, mining: 60 }, items: [{ id: 'bar_copper', qty: 3 }], blockCents: 35 },
    intro:
      "Ore in, slag off, bar out. That's smelting. Six copper bars, poured clean. The first one will look like a sad pancake. The sixth one less so. Growth, baby.",
    outro:
      "Six bars and only one looks like roadkill — above average. You're officially allowed near the good furnace now. Don't make me regret the vote.",
  },
  {
    id: 'q_forge_master_06',
    title: 'Rat Problem, Hot Solution',
    giver: 'foreman_dagna',
    regionId: 'ironhold',
    steps: [{ kind: 'kill', target: 'plague_rat', need: 10, label: 'Exterminate 10 plague rats' }],
    rewards: { xp: { attack: 160, defense: 80 }, items: [{ id: 'food_jerky', qty: 3 }], blockCents: 30 },
    intro:
      "Plague rats got into the ore stores. They're gnawing the sample tags, which means our grades are now 'vibes'. Ten rats. Wash your hands after, or don't, and find out why we say it.",
    outro:
      "Ten rats, zero remorse, ore stores no longer biohazardous. Jerky's your reward. It is not rat. I need you to hear me: it is NOT rat.",
  },
  {
    id: 'q_forge_master_07',
    title: 'Shaft Collapse Audit',
    giver: 'npc_ironhold_deepwarden_hale',
    regionId: 'ironhold',
    steps: [
      { kind: 'kill', target: 'shard_crawler', need: 8, label: 'Smash 8 shard crawlers' },
      { kind: 'gather', target: 'crystal_node', need: 4, label: 'Harvest 4 crystal nodes' },
    ],
    rewards: { xp: { mining: 240, attack: 120 }, items: [{ id: 'crystal_raw', qty: 4 }], blockCents: 45 },
    intro:
      "Shard crawlers are what grow in a collapsed shaft nobody shored up — walking crystal with a bad attitude. Clear eight and pull the four good nodes while you're down there. Don't lick the glowing ones. Rule exists for a reason.",
    outro:
      "Shaft's walkable and the crawlers are gravel. These raw crystals go to the magus later, after she pretends she didn't badly want them. Good delve.",
  },
  {
    id: 'q_forge_master_08',
    title: "Dagna's Copper Capstone",
    giver: 'foreman_dagna',
    regionId: 'ironhold',
    steps: [
      { kind: 'gather', target: 'copper_vein', need: 14, label: 'Mine 14 copper veins' },
      { kind: 'collect', target: 'bar_copper', need: 8, label: 'Bank 8 copper bars' },
    ],
    rewards: { xp: { mining: 300, blacksmithing: 120 }, items: [{ id: 'bar_copper', qty: 5 }, { id: 'food_pie', qty: 2 }], blockCents: 60 },
    intro:
      "Final copper exam. Fourteen veins mined, eight bars banked, all by you, all on the same shift. Pass and you never have to touch copper again unless you WANT to, which you won't. Nobody does.",
    outro:
      "You passed. Copper's behind you. Ahead: iron, and iron doesn't negotiate. Pie's on me — the filling's identifiable, which here counts as a bonus.",
  },

  // ======================================================================
  // CHAIN B — Iron works (Smelter Greta)
  // ======================================================================
  {
    id: 'q_forge_master_09',
    title: 'Iron in the Fire',
    giver: 'npc_ironhold_smelt_greta',
    regionId: 'ironhold',
    steps: [{ kind: 'gather', target: 'iron_vein', need: 10, label: 'Mine 10 iron veins' }],
    rewards: { xp: { mining: 260 }, items: [{ id: 'ore_iron', qty: 10 }], blockCents: 40 },
    intro:
      "Iron's where the mountain stops being polite. Ten veins. It fights the pick, it dulls the edge, it will outlast your enthusiasm — mine it anyway. Enthusiasm's overrated down here.",
    outro:
      "Ten veins of honest iron. Heavier than copper, meaner than copper, worth more than copper — just like you, after a fashion. Haul it to the furnace.",
  },
  {
    id: 'q_forge_master_10',
    title: 'Slag Off',
    giver: 'npc_ironhold_smelt_greta',
    regionId: 'ironhold',
    steps: [{ kind: 'collect', target: 'bar_iron', need: 8, label: 'Smelt 8 iron bars' }],
    rewards: { xp: { blacksmithing: 320, mining: 80 }, items: [{ id: 'bar_iron', qty: 4 }], blockCents: 55 },
    intro:
      "Iron smelts hotter and sulkier than copper. Skim the slag or your bars come out full of holes, like your work ethic on a Friday. Eight clean iron bars. Earn the frown I'll give you if you manage it.",
    outro:
      "Eight bars, barely any holes, I'm appalled to be impressed. The frown stands — I've had it since birth — but it's a proud frown now. Take iron.",
  },
  {
    id: 'q_forge_master_11',
    title: 'The Spider Smelt-Down',
    giver: 'npc_ironhold_warden_bexley',
    regionId: 'ironhold',
    steps: [
      { kind: 'kill', target: 'spider_recluse', need: 7, label: 'Burn out 7 recluse spiders' },
      { kind: 'kill', target: 'centipede_chasm', need: 6, label: 'Stomp 6 chasm centipedes' },
    ],
    rewards: { xp: { attack: 240, defense: 120 }, items: [{ id: 'hide_tough', qty: 3 }], blockCents: 50 },
    intro:
      "The old smelting hall's gone to the bugs. Recluse spiders in the rafters, chasm centipedes in the floor drains, and a work-safety rating of 'flee'. Seven spiders, six centipedes. Bring a torch and a strong stomach.",
    outro:
      "Hall's reclaimed. We can light the big bellows again without a chittering chorus of judgment overhead. Take this tough hide — you've out-crawled things that crawl professionally.",
  },
  {
    id: 'q_forge_master_12',
    title: 'Quota Means Quota',
    giver: 'npc_ironhold_quartermaster_odo',
    regionId: 'ironhold',
    steps: [
      { kind: 'gather', target: 'iron_vein', need: 12, label: 'Mine 12 iron veins' },
      { kind: 'collect', target: 'bar_iron', need: 6, label: 'Deliver 6 iron bars' },
    ],
    rewards: { xp: { mining: 300, blacksmithing: 120 }, items: [{ id: 'bar_iron', qty: 4 }, { id: 'food_jerky', qty: 2 }], blockCents: 65 },
    intro:
      "The capital ordered iron and the capital does not accept 'the mountain was moody'. Twelve veins, six bars delivered. If we miss quota, they cut the budget, and when they cut the budget they cut the SOUP. Not the soup. Mine.",
    outro:
      "Quota met, soup secured, the capital stays off my back for exactly one week. You've personally saved stew for forty miners. Statue's in the mail. It isn't. Jerky is, though.",
  },
  {
    id: 'q_forge_master_13',
    title: 'Deep Vein Thrombosis',
    giver: 'npc_ironhold_deepwarden_hale',
    regionId: 'ironhold',
    steps: [{ kind: 'kill', target: 'iron_warden', need: 4, label: 'Topple 4 iron wardens' }],
    rewards: { xp: { attack: 360, defense: 200 }, items: [{ id: 'bar_iron', qty: 5 }], blockCents: 80 },
    intro:
      "Down in the deep iron, old mining constructs still patrol — iron wardens, built to guard the seam, forgot the mine closed, never clocked out. Four of them. Admire the loyalty. End it anyway.",
    outro:
      "Four wardens, finally off the clock. Pulled good iron straight from their hides — recycling, the mountain way. The deep seam's open again. Mind the dark; it minds you.",
  },
  {
    id: 'q_forge_master_14',
    title: 'Sulfur and Soot',
    giver: 'npc_ironhold_smelt_greta',
    regionId: 'ironhold',
    steps: [
      { kind: 'kill', target: 'sulfur_sprite', need: 8, label: 'Snuff 8 sulfur sprites' },
      { kind: 'kill', target: 'soot_crawler', need: 8, label: 'Squash 8 soot crawlers' },
    ],
    rewards: { xp: { attack: 280, magic: 120 }, items: [{ id: 'potion_regret', qty: 1 }], blockCents: 55 },
    intro:
      "The furnace heat's drawn vermin from the lower vents — sulfur sprites that reek, soot crawlers that smear. They're fouling the air gauge and the air gauge is the only thing between us and 'explosion'. Eight each. Breathe shallow.",
    outro:
      "Vents cleared, gauge reads safe-ish, the hall smells like rotten eggs instead of DOOM. Improvement. Here — one Potion of Regret, in case you develop any. You won't. You're too tired.",
  },
  {
    id: 'q_forge_master_15',
    title: 'Tempering Expectations',
    giver: 'npc_ironhold_smelt_greta',
    regionId: 'ironhold',
    steps: [
      { kind: 'gather', target: 'fishing_spot', need: 8, label: 'Fetch 8 quenching-pool fills' },
      { kind: 'collect', target: 'bar_iron', need: 5, label: 'Temper 5 iron bars' },
    ],
    rewards: { xp: { blacksmithing: 360, fishing: 80 }, items: [{ id: 'bar_iron', qty: 4 }, { id: 'fish_trout', qty: 2 }], blockCents: 60 },
    intro:
      "Hot iron into cold water is the whole trick — too fast it cracks, too slow it sulks. Bring water from the mountain pools, cold as a landlord's heart, and temper five bars. Mind the trout. They watch. They judge.",
    outro:
      "Properly tempered iron rings like a bell and bends like a promise. These two trout wandered into your quench bucket and are now lunch. The circle of forge.",
  },
  {
    id: 'q_forge_master_16',
    title: "Greta's Iron Verdict",
    giver: 'npc_ironhold_smelt_greta',
    regionId: 'ironhold',
    steps: [
      { kind: 'gather', target: 'iron_vein', need: 16, label: 'Mine 16 iron veins' },
      { kind: 'collect', target: 'bar_iron', need: 10, label: 'Bank 10 iron bars' },
    ],
    rewards: { xp: { mining: 420, blacksmithing: 200 }, items: [{ id: 'bar_iron', qty: 6 }, { id: 'food_cake', qty: 1 }], blockCents: 90 },
    intro:
      "Iron mastery, final test. Sixteen veins, ten clean bars, all you. Pass and I stop calling you 'the new one' — I'll learn your actual name, which is the warmest thing I do.",
    outro:
      "...Fine. I know your name now. Don't make it weird. You've graduated to steel, where the real crying happens. Cake's for you. It cost more than the cake deserves.",
  },

  // ======================================================================
  // CHAIN C — Steel & the alloy arts (Smith Orin)
  // ======================================================================
  {
    id: 'q_forge_master_17',
    title: 'Steel Yourself',
    giver: 'smith_orin',
    regionId: 'ironhold',
    steps: [
      { kind: 'collect', target: 'bar_iron', need: 8, label: 'Gather 8 iron bars for the crucible' },
      { kind: 'gather', target: 'oak_tree', need: 6, label: 'Char 6 oaks for the carbon' },
    ],
    rewards: { xp: { blacksmithing: 400, woodcutting: 80 }, items: [{ id: 'bar_steel', qty: 3 }], blockCents: 80 },
    intro:
      "Steel is iron that went to therapy and came back stronger — iron, carbon, heat, and patience you don't have yet. Bring eight iron bars and six oaks' worth of char. We make the first batch together. You watch. You do not touch.",
    outro:
      "That's steel. Feel the weight of it — that's the weight of every miner who got you this far, plus carbon. Three bars. Guard them. Steel walks off in this place.",
  },
  {
    id: 'q_forge_master_18',
    title: 'The Golem Recycling Program',
    giver: 'smith_orin',
    regionId: 'ironhold',
    steps: [{ kind: 'kill', target: 'golem', need: 8, label: 'Dismantle 8 stone golems' }],
    rewards: { xp: { attack: 320, defense: 180, mining: 80 }, items: [{ id: 'crystal_shard', qty: 2 }], blockCents: 70 },
    intro:
      "Golems are just ore that learned to walk and resent it. Eight of them wandered into the quarry road. Dismantle them — their cores are packed with crystal shard the mountain was too lazy to make properly. Waste not.",
    outro:
      "Eight golems, back to being raw material, as nature intended before nature made a mistake. Two crystal shards from the cores. The quarry road's open. The golems have no comment.",
  },
  {
    id: 'q_forge_master_19',
    title: 'Steel Bars, No Cover Charge',
    giver: 'smith_orin',
    regionId: 'ironhold',
    steps: [{ kind: 'collect', target: 'bar_steel', need: 8, label: 'Forge 8 steel bars solo' }],
    rewards: { xp: { blacksmithing: 500 }, items: [{ id: 'bar_steel', qty: 4 }], blockCents: 90 },
    intro:
      "Now you forge steel ALONE. Eight bars, no hand-holding, no me hovering, no me 'accidentally' fixing your mistakes. If the carbon's off, they're brittle. If you're off, so are they. Eight. Go.",
    outro:
      "Eight steel bars and every one rings true. I hovered from across the room, I admit it — but I didn't touch, and that's the hardest thing a master does. You're a smith now. Lowercase. Earn the capital S.",
  },
  {
    id: 'q_forge_master_20',
    title: 'Hard Water',
    giver: 'npc_ironhold_quartermaster_odo',
    regionId: 'ironhold',
    steps: [
      { kind: 'kill', target: 'elem_frost', need: 6, label: 'Shatter 6 frost elementals' },
      { kind: 'kill', target: 'mote_frost', need: 8, label: 'Snuff 8 frost motes' },
    ],
    rewards: { xp: { attack: 340, magic: 160 }, items: [{ id: 'bar_steel', qty: 3 }], blockCents: 75 },
    intro:
      "Frost elementals drifted up from the glacier vents and froze the quench pools solid. Can't temper steel in a skating rink. Six elementals, eight motes. Dress warm, hit hard, don't stick your tongue to anything.",
    outro:
      "Pools are liquid again and the hall's back to a cozy inferno. Steel's your cut of the thaw. Those frost cores would've made lovely blades if they weren't busy being evil ice.",
  },
  {
    id: 'q_forge_master_21',
    title: 'Grinding the Gears',
    giver: 'npc_forgotten_smith',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'gearhound', need: 7, label: 'Scrap 7 gearhounds' },
      { kind: 'kill', target: 'cog_sprite', need: 9, label: 'Disassemble 9 cog sprites' },
    ],
    rewards: { xp: { attack: 360, blacksmithing: 120 }, items: [{ id: 'bar_steel', qty: 4 }], blockCents: 85 },
    intro:
      "Out here at the edge, the old war-foundry still spits out gearhounds and cog sprites — clockwork strays, no owner, no off-switch, just endless aggressive ticking. Seven hounds, nine sprites. The scrap's good steel. The noise is not.",
    outro:
      "Blessed, glorious silence. The scrap melts down to proper steel — the ancients built things to LAST, which is exactly why they wouldn't die. Four bars. The ticking will haunt your dreams. You're welcome.",
  },
  {
    id: 'q_forge_master_22',
    title: 'Pattern Welding 101',
    giver: 'smith_orin',
    regionId: 'ironhold',
    steps: [
      { kind: 'collect', target: 'bar_steel', need: 6, label: 'Fold 6 steel bars' },
      { kind: 'collect', target: 'bar_iron', need: 6, label: 'Layer in 6 iron bars' },
    ],
    rewards: { xp: { blacksmithing: 540 }, items: [{ id: 'bar_steel', qty: 5 }], blockCents: 95 },
    intro:
      "Fold steel and iron together, over and over, and you get a blade with a grain like flowing water and an edge like a bad review. Six steel, six iron. Fold until your arms file a formal complaint.",
    outro:
      "Look at that pattern — rivers of light in solid metal. Took me twenty years to make that; took you a week and my constant verbal abuse. Progress. Five bars of the good folded stock.",
  },
  {
    id: 'q_forge_master_23',
    title: 'The Beastmetal Hunt',
    giver: 'npc_forgotten_smith',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'dire_boar', need: 6, label: 'Hunt 6 dire boar for tusk-flux' },
      { kind: 'collect', target: 'hide_boar', need: 6, label: 'Collect 6 boar hides for the bellows' },
    ],
    rewards: { xp: { attack: 300, blacksmithing: 100 }, items: [{ id: 'hide_boar', qty: 4 }, { id: 'food_jerky', qty: 2 }], blockCents: 70 },
    intro:
      "Bellows need leather and the best bellows-leather walks around on dire boars, snorting, full of itself. Six boars. Keep the hides supple, keep your fingers attached, keep the tusks — ground tusk makes a flux that cheats physics a little.",
    outro:
      "Boar hide makes bellows that breathe like a dragon with good lungs. The flux is a trade secret now, so forget I said 'physics'. Jerky's smoked boar. It's honest. It's also chewy enough to resole a boot.",
  },
  {
    id: 'q_forge_master_24',
    title: "Orin's Steel Seal",
    giver: 'smith_orin',
    regionId: 'ironhold',
    steps: [
      { kind: 'collect', target: 'bar_steel', need: 12, label: 'Forge 12 flawless steel bars' },
      { kind: 'kill', target: 'iron_warden', need: 3, label: 'Prove it on 3 iron wardens' },
    ],
    rewards: { xp: { blacksmithing: 700, attack: 200 }, items: [{ id: 'bar_steel', qty: 6 }, { id: 'food_cake', qty: 1 }], blockCents: 130 },
    intro:
      "Mastersmith trial. Twelve flawless steel bars, then take a blade YOU forged and go put down three iron wardens with it. If the blade survives, so does your reputation. If it snaps — well, run fast.",
    outro:
      "Blade held. Wardens didn't. Twelve bars, flawless as a lie. You've earned the capital S, Smith. Now I tell you the secret every master knows: steel was the easy part. What comes next is where the mountain hides its teeth.",
  },

  // ======================================================================
  // CHAIN D — Gold, crystal & the jeweler's fire (Quartermaster Odo)
  // ======================================================================
  {
    id: 'q_forge_master_25',
    title: 'All That Glitters',
    giver: 'npc_ironhold_quartermaster_odo',
    regionId: 'ironhold',
    steps: [{ kind: 'gather', target: 'gold_vein', need: 8, label: 'Mine 8 gold veins' }],
    rewards: { xp: { mining: 340 }, items: [{ id: 'ore_gold', qty: 8 }], blockCents: 100 },
    intro:
      "Gold's soft, useless for blades, and worth a fortune — the three great lies of this mountain in one metal. Eight veins. Don't pocket any. I count. I always count. I dream in subtraction.",
    outro:
      "Eight veins, and the count matches, which means either you're honest or very good. Either way, keep working for me. Honest OR good is rare down here. Both would frighten me.",
  },
  {
    id: 'q_forge_master_26',
    title: 'Gilding the Guilty',
    giver: 'npc_ironhold_quartermaster_odo',
    regionId: 'ironhold',
    steps: [{ kind: 'collect', target: 'bar_gold', need: 6, label: 'Pour 6 gold bars' }],
    rewards: { xp: { blacksmithing: 380, mining: 80 }, items: [{ id: 'bar_gold', qty: 3 }], blockCents: 140 },
    intro:
      "Gold melts like butter and sticks to everything, including sticky fingers. Pour six bars, clean and even. The capital wants ceremonial ingots and the capital will notice a thumbprint. They always notice the thumbprint.",
    outro:
      "Six ingots, mirror-bright, not a print on them. The capital will stack them in a vault and look at them, which is all gold is really for. Three bars, your cut, signed off and legal. Mostly legal.",
  },
  {
    id: 'q_forge_master_27',
    title: 'Crystal Methods',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [
      { kind: 'gather', target: 'crystal_node', need: 8, label: 'Harvest 8 crystal nodes' },
      { kind: 'kill', target: 'crystal_sentinel', need: 4, label: 'Overload 4 crystal sentinels' },
    ],
    rewards: { xp: { mining: 400, magic: 200 }, items: [{ id: 'crystal_raw', qty: 6 }, { id: 'crystal_shard', qty: 2 }], blockCents: 110 },
    intro:
      "Raw crystal is where mining stops being digging and starts being alchemy. Pull eight good nodes — but the deep seams grow crystal sentinels, living geometry that does NOT share. Four of them, shattered. Bring me everything that glitters.",
    outro:
      "Marvelous specimens, and the sentinel fragments hum at a frequency that voids three of my competitors' theories. Delightful. Raw crystal and shards, your fee. Try not to resonate on the way home; it attracts attention.",
  },
  {
    id: 'q_forge_master_28',
    title: 'Faceted',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [{ kind: 'collect', target: 'crystal_cut', need: 6, label: 'Cut and polish 6 crystals' }],
    rewards: { xp: { blacksmithing: 460, magic: 160 }, items: [{ id: 'crystal_cut', qty: 3 }], blockCents: 150 },
    intro:
      "A raw crystal is a thug. A cut crystal is a scalpel. The difference is forty facets and one wrong tap. Cut six. Each wrong tap is a week's wage turning into glittering gravel, so breathe, and hate your breathing.",
    outro:
      "Six cut crystals, each one bending light like it owes it money. This is where mining becomes art — and art, unlike iron, can't be re-smelted when you ruin it. You ruined none. I'm nearly warm toward you.",
  },
  {
    id: 'q_forge_master_29',
    title: 'The Prism Drones',
    giver: 'npc_forgotten_smith',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'prism_drone', need: 8, label: 'Down 8 prism drones' },
      { kind: 'kill', target: 'mirror_golem', need: 4, label: 'Crack 4 mirror golems' },
    ],
    rewards: { xp: { attack: 400, magic: 200 }, items: [{ id: 'crystal_cut', qty: 2 }, { id: 'crystal_shard', qty: 2 }], blockCents: 120 },
    intro:
      "The ancients grew crystal weapons — prism drones, mirror golems — and the lenses in them are cut finer than any living jeweler can manage. Eight drones, four golems. Salvage the lenses. Also, bring a shield; they reflect your own attacks back, the smug mirrors.",
    outro:
      "Those lenses are perfect — unsettlingly perfect, made by hands that are now dust. We copy what we can and pretend we invented it. Crystal's your share. Don't look too long into the mirror golem shards. They look back.",
  },
  {
    id: 'q_forge_master_30',
    title: 'Clockwork and Daggers',
    giver: 'npc_forgotten_smith',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'clockwork_knight', need: 5, label: 'Stop 5 clockwork knights' }],
    rewards: { xp: { attack: 440, defense: 240 }, items: [{ id: 'bar_steel', qty: 4 }, { id: 'crystal_shard', qty: 1 }], blockCents: 130 },
    intro:
      "Clockwork knights: the foundry's old guard, wound tight centuries ago, still marching their dead patrol routes. Five of them. Inside each is a mainspring of a steel we can't reproduce and a crystal governor worth a small town. Open them up.",
    outro:
      "Five knights wound all the way down, finally. The mainsprings are a grade of steel that embarrasses ours — we're salvaging our way toward secrets we forgot we knew. Good scraps. Mind the ticking ones that aren't fully stopped.",
  },
  {
    id: 'q_forge_master_31',
    title: 'Gold-Pressed Flattery',
    giver: 'npc_ironhold_quartermaster_odo',
    regionId: 'ironhold',
    steps: [
      { kind: 'gather', target: 'gold_vein', need: 12, label: 'Mine 12 gold veins' },
      { kind: 'collect', target: 'bar_gold', need: 8, label: 'Pour 8 gold bars' },
    ],
    rewards: { xp: { mining: 480, blacksmithing: 180 }, items: [{ id: 'bar_gold', qty: 5 }, { id: 'food_honey', qty: 2 }], blockCents: 180 },
    intro:
      "Big order. The capital's commissioning a crown, because of course they are, and crowns are gold, because of course they are. Twelve veins, eight bars. Pour them perfect. A king notices a flaw in his hat faster than a flaw in his kingdom.",
    outro:
      "Eight flawless ingots off to become a hat for a man who inherited his job. The honey's from me — the crown's gold is from the mountain, and the mountain tips nobody. Five bars, your honest cut.",
  },
  {
    id: 'q_forge_master_32',
    title: 'Sentinel Stand-Off',
    giver: 'npc_ironhold_deepwarden_hale',
    regionId: 'ironhold',
    steps: [{ kind: 'kill', target: 'crystal_sentinel', need: 8, label: 'Shatter 8 crystal sentinels' }],
    rewards: { xp: { attack: 500, mining: 200 }, items: [{ id: 'crystal_raw', qty: 4 }, { id: 'crystal_cut', qty: 1 }], blockCents: 150 },
    intro:
      "The deepest crystal seam grows sentinels thick as a hedge now — they've sealed the richest vein in the mountain behind a wall of living glass. Eight sentinels. Behind them is crystal so pure it's nearly worth the broken bones. Nearly.",
    outro:
      "The seam's open and it's as pure as the old songs promised. Eight sentinels, down and glittering. These shards carry a charge — hand them to the magus quick, before they decide they'd rather be lightning.",
  },
  {
    id: 'q_forge_master_33',
    title: 'The Jeweler of the Deep',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [
      { kind: 'collect', target: 'crystal_cut', need: 8, label: 'Cut 8 flawless crystals' },
      { kind: 'collect', target: 'bar_gold', need: 4, label: 'Prepare 4 gold settings' },
    ],
    rewards: { xp: { blacksmithing: 620, magic: 220 }, items: [{ id: 'crystal_cut', qty: 3 }, { id: 'bar_gold', qty: 2 }], blockCents: 200 },
    intro:
      "Gold holds the crystal; the crystal holds the magic; you hold the whole thing together with nerves and spite. Eight flawless cuts, four gold settings. This is the top of the jeweler's art. Mess it up and you've made very expensive confetti.",
    outro:
      "Eight crystals set in gold, each one singing a little. You've reached the ceiling of what gold and crystal can do — and discovered, as every master does, that the ceiling is where the floor of the NEXT tier begins. Onward, and downward.",
  },
  {
    id: 'q_forge_master_34',
    title: "Odo's Ledger Closes",
    giver: 'npc_ironhold_quartermaster_odo',
    regionId: 'ironhold',
    steps: [
      { kind: 'gather', target: 'gold_vein', need: 16, label: 'Mine 16 gold veins' },
      { kind: 'gather', target: 'crystal_node', need: 10, label: 'Harvest 10 crystal nodes' },
      { kind: 'collect', target: 'bar_gold', need: 6, label: 'Bank 6 gold bars' },
    ],
    rewards: { xp: { mining: 600, blacksmithing: 240 }, items: [{ id: 'bar_gold', qty: 6 }, { id: 'crystal_cut', qty: 2 }, { id: 'food_cake', qty: 1 }], blockCents: 240 },
    intro:
      "Last great haul on my books before I retire to a chair and a grudge. Sixteen gold, ten crystal, six bars banked. Do this and the ledger balances for the first time in my career, and I can die — metaphorically, into retirement — a happy accountant.",
    outro:
      "The ledger balances. BALANCES. Do you understand what you've done? Neither do I; I've never seen it before. Take the gold, take the crystal, take the cake. You've mastered the shallow riches. Now Hale will take you where the mountain gets personal.",
  },

  // ======================================================================
  // CHAIN E — The Deep Delve: mythril & adamant tiers (Deepwarden Hale)
  // ======================================================================
  {
    id: 'q_forge_master_35',
    title: 'Below the Below',
    giver: 'npc_ironhold_deepwarden_hale',
    regionId: 'ironhold',
    steps: [
      { kind: 'explore', target: 'ironhold', need: 1, label: 'Descend to the Underhold' },
      { kind: 'kill', target: 'cave_bear', need: 5, label: 'Clear 5 cave bears from the stair' },
    ],
    rewards: { xp: { attack: 420, mining: 160 }, items: [{ id: 'food_jerky', qty: 3 }], blockCents: 130 },
    intro:
      "Everything you've mined so far was the ATTIC. The real mountain is below, past the sealed stair, in the dark we don't map because the maps keep changing. Cave bears nest on the stair. Five of them. Then we go down. Scared? Good. Fear's a lantern.",
    outro:
      "Stair's clear and the bears have relocated to a cave with better reviews. Past this door the rock gets older than the kingdom, older than the gods' excuses. Rest up. Tomorrow we meet metals that have NAMES.",
  },
  {
    id: 'q_forge_master_36',
    title: 'Silverlight',
    giver: 'npc_ironhold_deepwarden_hale',
    regionId: 'ironhold',
    steps: [
      { kind: 'gather', target: 'iron_vein', need: 12, label: 'Mine 12 veins of silverlight ore' },
      { kind: 'kill', target: 'shard_crawler', need: 8, label: 'Clear 8 shard crawlers from the seam' },
    ],
    rewards: { xp: { mining: 560, attack: 220 }, items: [{ id: 'ore_iron', qty: 8 }, { id: 'crystal_shard', qty: 2 }], blockCents: 170 },
    intro:
      "The first deep tier. The miners call it silverlight — glows faint blue, light as a feather, strong as a grudge. It mines like iron if iron fought back and SANG. Twelve veins. The crawlers love it too; eight of them don't get a vote.",
    outro:
      "Silverlight. Feel how LIGHT that haul is — you could carry a castle's worth and barely sweat. This is the metal the old songs call mythril, back when anyone still sang. We call it payday. Rest. It gets heavier from here. Spiritually.",
  },
  {
    id: 'q_forge_master_37',
    title: 'Forging the Featherblade',
    giver: 'smith_orin',
    regionId: 'ironhold',
    steps: [
      { kind: 'collect', target: 'bar_steel', need: 6, label: 'Alloy 6 steel bars into the mix' },
      { kind: 'collect', target: 'bar_gold', need: 3, label: 'Add 3 gold bars for the binding' },
      { kind: 'collect', target: 'crystal_shard', need: 4, label: 'Thread in 4 crystal shards' },
    ],
    rewards: { xp: { blacksmithing: 780 }, items: [{ id: 'bar_steel', qty: 5 }, { id: 'crystal_cut', qty: 1 }], blockCents: 200 },
    intro:
      "Silverlight won't forge alone — too proud, too light, cracks if you look at it wrong. You bind it with steel, gold and crystal in a recipe I'm trusting you with because you've stopped being a disappointment. Six steel, three gold, four shards. Don't rush the quench. The quench is where fools are made.",
    outro:
      "A featherblade. Light as rumor, sharp as a grudge held for years. There are maybe four smiths alive who can forge one and now there are five. Keep this to yourself and keep the stock. The next tier won't be so gentle.",
  },
  {
    id: 'q_forge_master_38',
    title: 'The Underhold Wardens',
    giver: 'npc_ironhold_deepwarden_hale',
    regionId: 'ironhold',
    steps: [{ kind: 'kill', target: 'rune_colossus', need: 3, label: 'Fell 3 rune colossi' }],
    rewards: { xp: { attack: 620, defense: 360 }, items: [{ id: 'bar_steel', qty: 5 }, { id: 'crystal_cut', qty: 1 }], blockCents: 210 },
    intro:
      "The deeper tiers are guarded by rune colossi — mountains that stood up one day and decided to have opinions. Three of them block the adamant seam. They hit like a verdict. Bring the featherblade. Bring a will. Bring a spare will.",
    outro:
      "Three colossi, back to being scenery. The runes carved on them are a language older than the kingdom, and one of them, loosely, reads 'turn back'. We did not. The adamant's ours now.",
  },
  {
    id: 'q_forge_master_39',
    title: 'Adamant Dreams',
    giver: 'npc_ironhold_deepwarden_hale',
    regionId: 'ironhold',
    steps: [
      { kind: 'gather', target: 'iron_vein', need: 14, label: 'Mine 14 veins of adamant' },
      { kind: 'kill', target: 'iron_warden', need: 6, label: 'Fight off 6 iron wardens' },
    ],
    rewards: { xp: { mining: 680, attack: 300 }, items: [{ id: 'ore_iron', qty: 10 }, { id: 'bar_steel', qty: 2 }], blockCents: 230 },
    intro:
      "Adamant. Black-green, heavy as a bad conscience, so hard it laughs at steel picks. You'll break three picks a vein and like it. Fourteen veins. The old wardens cluster thick here, guarding what they can't remember. Six of them. Mine through the argument.",
    outro:
      "Adamant. The hardest thing in the known mountain, and you pulled fourteen veins of it with mortal arms and immortal stubbornness. Steel was a rehearsal. Iron was a warm-up. THIS is where blades become legends. If you can forge it.",
  },
  {
    id: 'q_forge_master_40',
    title: 'The Unbreakable',
    giver: 'smith_orin',
    regionId: 'ironhold',
    steps: [
      { kind: 'collect', target: 'bar_steel', need: 10, label: 'Smelt down 10 steel bars for flux' },
      { kind: 'gather', target: 'oak_tree', need: 10, label: 'Burn 10 oaks for the long heat' },
    ],
    rewards: { xp: { blacksmithing: 900, woodcutting: 120 }, items: [{ id: 'bar_steel', qty: 6 }, { id: 'crystal_cut', qty: 2 }], blockCents: 260 },
    intro:
      "Adamant needs a heat so long and hard it's cheaper to rename the week 'the forging'. Ten steel bars for flux, ten oaks of pure char, and a fire you feed for three days without sleeping. Sleep is for smiths with easier ambitions. Begin.",
    outro:
      "Three days, no sleep, and an adamant bar that would turn a dragon's tooth. You've nearly caught the ancients now — nearly. There's one tier left, and it isn't in the mountain. It's in the places the mountain is afraid of.",
  },
  {
    id: 'q_forge_master_41',
    title: 'Dung Beetles of the Deep',
    giver: 'npc_ironhold_deepwarden_hale',
    regionId: 'ironhold',
    steps: [
      { kind: 'kill', target: 'beetle_rhino', need: 8, label: 'Flip 8 rhino beetles' },
      { kind: 'kill', target: 'beetle_dung', need: 10, label: 'Roll out 10 dung beetles' },
    ],
    rewards: { xp: { attack: 440, defense: 280 }, items: [{ id: 'hide_tough', qty: 4 }], blockCents: 150 },
    intro:
      "The adamant seam's infested with rhino beetles — their shells are near-adamant themselves — and dung beetles that eat the rock and leave worse. Eight rhino, ten dung. Their shells plate armor better than most bars. Grim work. Grimmer smell.",
    outro:
      "Eighteen beetles, and the seam's clear enough to work. Those rhino shells make plating that laughs at arrows. The smell will follow you for a week. It's how they'll know you're a real deep-delver. Congratulations, I suppose.",
  },
  {
    id: 'q_forge_master_42',
    title: 'Scorpions in the Dark',
    giver: 'npc_ironhold_deepwarden_hale',
    regionId: 'ironhold',
    steps: [{ kind: 'kill', target: 'scorpion_emperor', need: 4, label: 'Behead 4 emperor scorpions' }],
    rewards: { xp: { attack: 540, defense: 320 }, items: [{ id: 'bar_steel', qty: 4 }, { id: 'potion_regret', qty: 1 }], blockCents: 180 },
    intro:
      "Emperor scorpions nest where the adamant's richest — big as carts, armored like warships, venom that'll make you nostalgic for a quick death. Four of them. Their stingers, properly treated, make an engraving tool that cuts adamant like butter. Go get the butter knife.",
    outro:
      "Four emperors, four stingers, and you're still breathing, which the venom makes genuinely impressive. The stingers will carve runes into metal nothing else can touch. Potion of Regret's a joke gift — you've no time for regret down here, and no breath to spare for it either.",
  },
  {
    id: 'q_forge_master_43',
    title: 'The Siege Below',
    giver: 'npc_ironhold_deepwarden_hale',
    regionId: 'ironhold',
    steps: [{ kind: 'kill', target: 'siege_golem', need: 4, label: 'Topple 4 siege golems' }],
    rewards: { xp: { attack: 660, defense: 400, mining: 160 }, items: [{ id: 'crystal_cut', qty: 2 }, { id: 'bar_steel', qty: 4 }], blockCents: 220 },
    intro:
      "Siege golems — the ancients built them to break fortress walls, then the fortress fell and they just kept walking into the dark, looking for a wall. Four of them pace the lowest hall. They're adamant-cored. End their very long bad day.",
    outro:
      "Four siege golems, down at last after a march of centuries. The adamant in their cores is already forged, ancient-grade — a head start on the work of ten lifetimes. Take it. You've nearly reached the floor of the world. Nearly.",
  },
  {
    id: 'q_forge_master_44',
    title: 'Bastion Breaker',
    giver: 'npc_ironhold_deepwarden_hale',
    regionId: 'ironhold',
    steps: [
      { kind: 'kill', target: 'bastion_walker', need: 3, label: 'Dismantle 3 bastion walkers' },
      { kind: 'kill', target: 'obsidian_automaton', need: 4, label: 'Shatter 4 obsidian automatons' },
    ],
    rewards: { xp: { attack: 720, defense: 440 }, items: [{ id: 'crystal_cut', qty: 3 }, { id: 'bar_gold', qty: 2 }], blockCents: 260 },
    intro:
      "The last gate before the deepest dark is held by bastion walkers and obsidian automatons — the ancients' final line, and they've held it so long they've forgotten what they're guarding. Three walkers, four automatons. Past them lies the obsidian seam. Past THAT lies trouble with a capital everything.",
    outro:
      "The final line, broken. Whatever the ancients feared enough to build THAT is on the other side of this door — and so is obsidian, the black glass that drinks light and holds an edge sharper than a goodbye. Steel yourself, mastersmith. We go to the seam.",
  },
  {
    id: 'q_forge_master_45',
    title: 'The Obsidian Seam',
    giver: 'npc_ironhold_deepwarden_hale',
    regionId: 'ironhold',
    steps: [
      { kind: 'gather', target: 'crystal_node', need: 12, label: 'Carve 12 obsidian nodes' },
      { kind: 'kill', target: 'obsidian_automaton', need: 6, label: 'Clear 6 obsidian automatons' },
    ],
    rewards: { xp: { mining: 820, attack: 360 }, items: [{ id: 'crystal_raw', qty: 8 }, { id: 'crystal_cut', qty: 2 }], blockCents: 300 },
    intro:
      "Obsidian isn't mined, it's HARVESTED — one wrong tap and a vein's worth shatters into black sand and heartbreak. Twelve nodes, carved with patience you've bled for. The automatons grown from the seam don't want you here. Six of them. This is the deepest honest metal in the world.",
    outro:
      "Obsidian. Black as the space between stars, sharp enough to split a thought. You've mined to the bottom of the known world and come back glittering. Only one tier remains — and it's not honest, and it's not in this mountain. Hale can take you no further. The frontier calls.",
  },
  {
    id: 'q_forge_master_46',
    title: "Hale's Last Descent",
    giver: 'npc_ironhold_deepwarden_hale',
    regionId: 'ironhold',
    steps: [
      { kind: 'gather', target: 'iron_vein', need: 20, label: 'Mine 20 veins of mixed deep ore' },
      { kind: 'gather', target: 'crystal_node', need: 12, label: 'Harvest 12 crystal nodes' },
      { kind: 'kill', target: 'rune_colossus', need: 5, label: 'Fell 5 rune colossi' },
    ],
    rewards: { xp: { mining: 900, attack: 500, defense: 300 }, items: [{ id: 'crystal_cut', qty: 4 }, { id: 'bar_gold', qty: 3 }, { id: 'food_cake', qty: 1 }], blockCents: 400 },
    intro:
      "My knees are gone and the deep is a young fool's grave, so this is my last descent, and I'm spending it on you. Twenty deep veins, twelve crystal, five colossi, all in one go. Carry the Underhold on your back once, so I can say I trained the one who could.",
    outro:
      "You carried it. The whole deep, on one back, in one breath. I'm done — these halls belong to you now, mastersmith. Everything the mountain had, you've taken. What's left isn't mountain. It's out past the maps, in the ash and the ice and the sea. Go find the metals that fell from the SKY.",
  },

  // ======================================================================
  // CHAIN F — Starmetal & the frontier tiers (Prospector Finn)
  // ======================================================================
  {
    id: 'q_forge_master_47',
    title: 'The Prospector Returns',
    giver: 'prospector_finn',
    regionId: 'ironhold',
    steps: [
      { kind: 'explore', target: 'forgotten', need: 1, label: 'Reach the Forgotten Lands' },
      { kind: 'kill', target: 'dire_boar', need: 6, label: 'Clear 6 dire boar from the trail' },
    ],
    rewards: { xp: { attack: 420, mining: 160 }, items: [{ id: 'food_jerky', qty: 4 }], blockCents: 160 },
    intro:
      "Forget the boot story, that was the OLD me. New obsession: starmetal. Stuff that fell burning from the sky and buried itself in the frontier past the Forgotten Lands. No mountain made it — the SKY did. Meet me past the wastes. Mind the boars; they're territorial about my lunch.",
    outro:
      "You came! Most people hear 'metal from the sky' and back away slowly. But you — you've got the look of someone who's run out of mountain. Good. The frontier's where mining stops being a job and starts being a dare.",
  },
  {
    id: 'q_forge_master_48',
    title: 'Ash and Embers',
    giver: 'prospector_finn',
    regionId: 'forgotten',
    steps: [
      { kind: 'explore', target: 'ashen', need: 1, label: 'Cross into the ashen reaches' },
      { kind: 'kill', target: 'cinder_hound', need: 8, label: 'Put down 8 cinder hounds' },
    ],
    rewards: { xp: { attack: 480, defense: 200 }, items: [{ id: 'food_jerky', qty: 3 }], blockCents: 170 },
    intro:
      "The biggest starfall landed in the ashen wastes, which is why the ash never cools. Cinder hounds hunt the glow — they can smell starmetal, which makes them excellent prospectors and terrible company. Eight of them. Then we dig where they were sniffing.",
    outro:
      "Eight hounds, and they died pointing — straight at a seam of something that glitters like a swallowed star. Starmetal. First flake of it any living hand has touched in an age. We're rich, or dead, and I genuinely can't tell which yet.",
  },
  {
    id: 'q_forge_master_49',
    title: 'Starmetal, First Harvest',
    giver: 'prospector_finn',
    regionId: 'forgotten',
    steps: [
      { kind: 'gather', target: 'crystal_node', need: 10, label: 'Chip 10 starmetal nodes from the crater' },
      { kind: 'kill', target: 'magma_blob', need: 8, label: 'Cool 8 magma blobs off the seam' },
    ],
    rewards: { xp: { mining: 760, attack: 300 }, items: [{ id: 'crystal_raw', qty: 8 }, { id: 'crystal_cut', qty: 1 }], blockCents: 280 },
    intro:
      "Starmetal sits in the crater still half-molten, guarded by magma blobs that think the heat belongs to them. Ten nodes chipped loose, eight blobs cooled permanently. It burns to the touch and hums like it remembers the sky. Gloves. GOOD gloves.",
    outro:
      "Ten chunks of starmetal, still warm with the memory of falling. No smith in the kingdom has forged this in a thousand years — the recipe died, and here we are trying to resurrect it with guesswork and nerve. Mostly nerve.",
  },
  {
    id: 'q_forge_master_50',
    title: 'The Cinder Forge',
    giver: 'npc_forgotten_smith',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'elem_magma', need: 6, label: 'Harvest 6 magma elementals for forge-heat' },
      { kind: 'kill', target: 'ember_crawler', need: 10, label: 'Clear 10 ember crawlers' },
    ],
    rewards: { xp: { attack: 520, blacksmithing: 220 }, items: [{ id: 'bar_steel', qty: 4 }, { id: 'crystal_shard', qty: 2 }], blockCents: 220 },
    intro:
      "Starmetal won't melt in an honest furnace — needs the heart of a magma elemental, bottled while it screams. Six elementals, and ten ember crawlers that'll try to eat you first. This is how we light a forge hot enough to shame a volcano. Dangerous? Immensely. Alternative? None.",
    outro:
      "Six elemental hearts, bottled and furious, burning hotter than any coal ever dug. The cinder forge roars. NOW we can try to shape a star. Try. The word's doing heavy lifting. Stand back when I open the crucible.",
  },
  {
    id: 'q_forge_master_51',
    title: 'Forging a Fallen Star',
    giver: 'npc_forgotten_smith',
    regionId: 'forgotten',
    steps: [
      { kind: 'collect', target: 'crystal_raw', need: 8, label: 'Feed 8 raw starmetal to the crucible' },
      { kind: 'collect', target: 'bar_gold', need: 4, label: 'Bind with 4 gold bars' },
      { kind: 'collect', target: 'crystal_cut', need: 3, label: 'Core it with 3 cut crystals' },
    ],
    rewards: { xp: { blacksmithing: 960 }, items: [{ id: 'crystal_cut', qty: 2 }, { id: 'bar_gold', qty: 2 }], blockCents: 320 },
    intro:
      "This is it. Starmetal in the cinder forge, bound in gold, cored in crystal, hammered on a beat you feel in your teeth. Eight starmetal, four gold, three crystal. If the alloy takes, you've forged the first starblade in a thousand years. If it doesn't, we're both briefly on fire.",
    outro:
      "...It took. It TOOK. Look at it — it glows with its own light, cold and blue, like it's still falling. A starblade. Nobody alive has held one until this exact breath. We did that. YOU did that. Sit down before you faint; I already did, discreetly.",
  },
  {
    id: 'q_forge_master_52',
    title: 'The Char Drakes',
    giver: 'prospector_finn',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'char_drake', need: 5, label: 'Down 5 char drakes' }],
    rewards: { xp: { attack: 640, defense: 300 }, items: [{ id: 'hide_tough', qty: 4 }, { id: 'crystal_shard', qty: 2 }], blockCents: 240 },
    intro:
      "Char drakes nest in the biggest craters — they EAT starmetal, if you can believe it, and their scales are plated with it, half-digested and glowing. Five drakes. Those scales skip three steps of smelting. Also the drakes breathe fire, so, you know. Even trade.",
    outro:
      "Five drakes, five hides crusted with pre-forged starmetal. The scales alone are worth a season's mining. You smell of singed everything and triumph. Mostly singed everything. Finn's proud. Finn would hug you but you're still smoking.",
  },
  {
    id: 'q_forge_master_53',
    title: 'Frostmetal in the Rime',
    giver: 'prospector_finn',
    regionId: 'forgotten',
    steps: [
      { kind: 'gather', target: 'crystal_node', need: 12, label: 'Chip 12 frostmetal nodes' },
      { kind: 'kill', target: 'elem_glacier', need: 5, label: 'Shatter 5 glacier elementals' },
    ],
    rewards: { xp: { mining: 800, attack: 340 }, items: [{ id: 'crystal_raw', qty: 8 }, { id: 'crystal_cut', qty: 1 }], blockCents: 290 },
    intro:
      "Not all stars fall hot. Some fell into the great rime past the outer isles and froze metal that's cold enough to burn — frostmetal, starmetal's spiteful twin. Twelve nodes, and five glacier elementals who guard it like a grudge. Bring the warmest cloak you own and a will colder than the ice.",
    outro:
      "Frostmetal. So cold it welds your gloves to it, so sharp it cuts the air into a whistle. Pair it with starmetal and you get blades that are fire AND ice, which is just showing off, and we are ABSOLUTELY going to show off. Rest the fingers you have left.",
  },
  {
    id: 'q_forge_master_54',
    title: 'The Wyrm of the Wastes',
    giver: 'npc_forgotten_smith',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'wyrm_magma', need: 2, label: 'Slay 2 magma wyrms' }],
    rewards: { xp: { attack: 820, defense: 460 }, items: [{ id: 'crystal_cut', qty: 3 }, { id: 'bar_gold', qty: 2 }], blockCents: 340 },
    intro:
      "Magma wyrms sleep in the deepest craters, coiled around the purest starmetal like the world's worst dragon-hoard metaphor made literal. Two of them. Their hearts are a single flawless starmetal gem each, grown over centuries of molten sleep. Wake them. Regret it. Win anyway.",
    outro:
      "Two wyrms, two heart-gems, each one worth more than the kingdom's crown and infinitely harder earned. The purest starmetal that exists, and it exists now in YOUR hands. There's one tier left that even I fear to name. Finn knows where. The outer isles. The void seam.",
  },
  {
    id: 'q_forge_master_55',
    title: 'Voidtouched',
    giver: 'prospector_finn',
    regionId: 'forgotten',
    steps: [
      { kind: 'explore', target: 'forgotten', need: 1, label: 'Sail to the outer isles' },
      { kind: 'kill', target: 'mote_void', need: 10, label: 'Disperse 10 void motes' },
    ],
    rewards: { xp: { attack: 700, magic: 400 }, items: [{ id: 'crystal_shard', qty: 3 }], blockCents: 300 },
    intro:
      "There's a seam past the outer isles where the sky didn't drop metal — it dropped a HOLE. Voidmetal. It weighs nothing and costs everything. Void motes swarm it, little gaps in the world with teeth. Ten of them. If you come back changed, that's normal. If you come back wrong, that's also normal. Just come back.",
    outro:
      "You came back, and you're mostly the right shape. The void motes left shards that don't reflect light — they EAT it. This is the last metal, the forbidden tier, the one the ancients mined once and then sealed forever with a very good reason they didn't write down. We're ignoring that. Obviously.",
  },
  {
    id: 'q_forge_master_56',
    title: 'The Void Seam',
    giver: 'prospector_finn',
    regionId: 'forgotten',
    steps: [
      { kind: 'gather', target: 'crystal_node', need: 14, label: 'Extract 14 voidmetal nodes' },
      { kind: 'kill', target: 'elem_void', need: 6, label: 'Unmake 6 void elementals' },
    ],
    rewards: { xp: { mining: 940, magic: 500 }, items: [{ id: 'crystal_raw', qty: 10 }, { id: 'crystal_cut', qty: 2 }], blockCents: 420 },
    intro:
      "The void seam doesn't sit in rock — it sits in the ABSENCE of rock, a wound in the world you mine by reaching into nothing and pulling out less. Fourteen nodes. Six void elementals, which are holes that learned to hate. Don't look directly at the seam. Don't count the motes twice; the number changes.",
    outro:
      "Fourteen pieces of nothing-made-solid, and you still know your own name, which the last three prospectors couldn't say. Voidmetal. The final tier. No blade's been forged from it since the ancients — and they stopped for a reason we're about to rediscover the hard way.",
  },
  {
    id: 'q_forge_master_57',
    title: 'Forging the Unforgeable',
    giver: 'npc_forgotten_smith',
    regionId: 'forgotten',
    steps: [
      { kind: 'collect', target: 'crystal_raw', need: 10, label: 'Feed 10 voidmetal to the cinder forge' },
      { kind: 'collect', target: 'crystal_cut', need: 6, label: 'Bind with 6 cut crystals' },
      { kind: 'collect', target: 'bar_gold', need: 5, label: 'Anchor it with 5 gold bars' },
    ],
    rewards: { xp: { blacksmithing: 999, magic: 600 }, items: [{ id: 'crystal_cut', qty: 4 }, { id: 'bar_gold', qty: 3 }, { id: 'food_cake', qty: 1 }], blockCents: 500 },
    intro:
      "Voidmetal won't take a shape — it keeps trying to become nothing again — so you anchor it with gold, pin it with crystal, and hammer it with a rhythm that argues the void into submission. Ten void, six crystal, five gold. This is the top of the art. There is no tier above this. If there were, I wouldn't want to know.",
    outro:
      "A voidblade. It doesn't gleam — it ERASES, a line of pure absence you can barely look at. You've forged the last metal, the one the ancients buried on purpose. There's nothing left to learn, mastersmith. You've reached the bottom of mining and the top of smithing in the same breath. The cake tastes like victory and faintly of static.",
  },
  {
    id: 'q_forge_master_58',
    title: "Finn's Final Claim",
    giver: 'prospector_finn',
    regionId: 'forgotten',
    steps: [
      { kind: 'gather', target: 'crystal_node', need: 18, label: 'Mine 18 nodes across every frontier seam' },
      { kind: 'kill', target: 'wyrm_magma', need: 3, label: 'Slay 3 magma wyrms' },
      { kind: 'kill', target: 'elem_void', need: 4, label: 'Unmake 4 void elementals' },
    ],
    rewards: { xp: { mining: 999, attack: 600, blacksmithing: 400 }, items: [{ id: 'crystal_cut', qty: 6 }, { id: 'bar_gold', qty: 4 }, { id: 'food_cake', qty: 2 }], blockCents: 700 },
    intro:
      "One last claim, the biggest of my life, and I'm staking it in your name because my legs are done and my luck's all used up. Eighteen nodes across every frontier seam, three magma wyrms, four void elementals. Do it and your name goes on the deed to the whole sky. Mine's coming off. Been a good run.",
    outro:
      "The deed's yours. Starmetal, frostmetal, voidmetal — every seam that fell from heaven, claimed in your name. I started chasing a lost boot and ended up handing you the whole firmament. Not bad for an old fool. Go. Forge things that outlive the kingdoms that'll fight over them.",
  },

  // ======================================================================
  // CHAIN G — Mastersmith commissions (standalone hard contracts)
  // ======================================================================
  {
    id: 'q_forge_master_59',
    title: 'The Capital Commission',
    giver: 'smith_orin',
    regionId: 'ironhold',
    steps: [
      { kind: 'collect', target: 'bar_steel', need: 10, label: 'Forge 10 steel bars for the royal order' },
      { kind: 'explore', target: 'capital', need: 1, label: 'Deliver to the capital' },
    ],
    rewards: { xp: { blacksmithing: 620 }, items: [{ id: 'bar_gold', qty: 3 }, { id: 'food_pie', qty: 2 }], blockCents: 200 },
    intro:
      "The capital wants ten steel bars for the armory and they want them YESTERDAY, which is a scheduling miracle I can't perform, so they'll settle for excellent. Forge ten, haul them to the capital, smile at the clerk, don't let the clerk talk about requisition forms. Run if he does.",
    outro:
      "Ten bars delivered, clerk successfully escaped mid-sentence about form 12-C. The capital pays in gold and pie, which is the correct ratio of things. The armory's stocked. Some guard will live because your bars held. Carry that. Lightly.",
  },
  {
    id: 'q_forge_master_60',
    title: 'Horns of the Stag',
    giver: 'npc_forgotten_smith',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'horned_stag', need: 8, label: 'Hunt 8 horned stags for antler-flux' }],
    rewards: { xp: { attack: 360, blacksmithing: 140 }, items: [{ id: 'food_jerky', qty: 3 }, { id: 'hide_tough', qty: 2 }], blockCents: 130 },
    intro:
      "Ground antler makes a flux that pulls impurities out of molten metal like gossip pulls secrets out of a tavern. Eight horned stags. They've got a temper and a point to make, both located on their heads. Mind the charge.",
    outro:
      "Eight stags, eight sets of antler, enough flux to clean a season of ore. The jerky's venison, the hide's for the bellows, and the moral is that even a frontier smith can't work without the forest's reluctant donations.",
  },
  {
    id: 'q_forge_master_61',
    title: 'Crag Ram Rampage',
    giver: 'npc_ironhold_warden_bexley',
    regionId: 'ironhold',
    steps: [{ kind: 'kill', target: 'crag_ram', need: 10, label: 'Clear 10 crag rams off the ore road' }],
    rewards: { xp: { attack: 320, defense: 200 }, items: [{ id: 'hide_tough', qty: 3 }], blockCents: 110 },
    intro:
      "Crag rams have claimed the ore road and they headbutt the carts for SPORT. Ten of them. Every cart they crack is a day's quota in the dirt and a day's pay off MY ledger, so this is personal, and it's your problem now.",
    outro:
      "Ten rams relocated to the valley floor, the hard way. Carts roll free, quota flows, my ledger stops bleeding. Tough hide's your cut — ram hide takes a dent and gives nothing back, much like me.",
  },
  {
    id: 'q_forge_master_62',
    title: 'The Brass Sentries',
    giver: 'npc_forgotten_smith',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'brass_sentry', need: 10, label: 'Melt down 10 brass sentries' },
      { kind: 'kill', target: 'cog_sprite', need: 8, label: 'Salvage gearwork from 8 cog sprites' },
    ],
    rewards: { xp: { attack: 400, blacksmithing: 160 }, items: [{ id: 'bar_copper', qty: 4 }, { id: 'bar_gold', qty: 1 }], blockCents: 150 },
    intro:
      "Brass sentries guard the foundry's old vault — brass is just copper and zinc with ambitions, and these have been polishing the same empty hall for an age. Eight of them. The brass melts down lovely, and the gearwork inside teaches us tricks we forgot. Go learn by breaking.",
    outro:
      "Eight sentries, melted to ingots, their secrets spread on my workbench like an autopsy. Copper and a touch of gold for you. The ancients built better than we remember — every scrap we recover is a lesson we should never have lost.",
  },
  {
    id: 'q_forge_master_63',
    title: 'Aegis Protocol',
    giver: 'npc_ironhold_deepwarden_hale',
    regionId: 'ironhold',
    steps: [{ kind: 'kill', target: 'aegis_titan', need: 2, label: 'Dismantle 2 aegis titans' }],
    rewards: { xp: { attack: 760, defense: 500 }, items: [{ id: 'crystal_cut', qty: 3 }, { id: 'bar_steel', qty: 4 }], blockCents: 300 },
    intro:
      "Aegis titans are the ancients' masterwork armor given legs — walking fortresses, plated in an alloy we've spent lifetimes failing to copy. Two of them guard a sealed hall. Dismantle them carefully; every plate you recover is a page of a textbook that burned a thousand years ago.",
    outro:
      "Two titans, down and apart, their plating spread out like a puzzle we're finally allowed to solve. The alloy's beyond us still, but we're closer than any smith since the fall. Crystal and steel for your trouble — and the trouble was considerable.",
  },
  {
    id: 'q_forge_master_64',
    title: 'The Glacier Warden',
    giver: 'prospector_finn',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'glacier_warden', need: 3, label: 'Shatter 3 glacier wardens' }],
    rewards: { xp: { attack: 640, defense: 380, magic: 160 }, items: [{ id: 'crystal_cut', qty: 2 }, { id: 'crystal_shard', qty: 3 }], blockCents: 260 },
    intro:
      "The frostmetal seam in the rime is guarded by glacier wardens — ice golems with cores of frozen starmetal, slow as winter and twice as patient. Three of them. Their cores never melt, never dull, and make an edge cold enough to freeze a scream mid-throat. Chip them loose.",
    outro:
      "Three wardens, cracked open, three cores of eternal cold on your belt. Frostmetal that'll outlast the sun. You're collecting the sky piece by piece, mastersmith. Soon there'll be nothing left up there to want.",
  },
  {
    id: 'q_forge_master_65',
    title: 'Brimstone and Treacle',
    giver: 'npc_forgotten_smith',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'brimstone_fiend', need: 6, label: 'Banish 6 brimstone fiends' },
      { kind: 'kill', target: 'pit_brute', need: 5, label: 'Flatten 5 pit brutes' },
    ],
    rewards: { xp: { attack: 560, defense: 300 }, items: [{ id: 'bar_steel', qty: 4 }, { id: 'food_honey', qty: 2 }], blockCents: 220 },
    intro:
      "The lava vents I need for the cinder forge are overrun — brimstone fiends in the smoke, pit brutes in the shallows, all of them allergic to me specifically. Six fiends, five brutes. Clear the vents and the forge burns hot enough to shame the sun. The honey's a bribe. It's working, isn't it.",
    outro:
      "Vents clear, fiends banished, brutes flattened, forge roaring like a kingdom falling. The honey bribe worked and I'm not ashamed. Steel's your real pay. Now the cinder forge can take on the big jobs — the SKY jobs. You know the ones.",
  },
  {
    id: 'q_forge_master_66',
    title: 'Dread Maw Diet Plan',
    giver: 'prospector_finn',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'dread_maw', need: 4, label: 'Put down 4 dread maws' }],
    rewards: { xp: { attack: 700, defense: 360 }, items: [{ id: 'crystal_shard', qty: 3 }, { id: 'hide_tough', qty: 3 }], blockCents: 280 },
    intro:
      "Dread maws tunnel through the starmetal craters eating EVERYTHING — ore, rock, the occasional prospector who dawdled. Four of them. They've swallowed more starmetal than I've ever mined, and it's just sitting in their guts, un-taxed and un-claimed. Go audit them. Aggressively.",
    outro:
      "Four maws, four bellies full of swallowed star. The recovery's... messy, but the metal doesn't mind where it's been. Crystal and hide for you, and the lingering knowledge of what the inside of a dread maw looks like. Sorry about that. Sort of.",
  },
  {
    id: 'q_forge_master_67',
    title: 'The Obsidian Dragon',
    giver: 'npc_forgotten_smith',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'dragon_obsidian', need: 1, label: 'Slay the obsidian dragon' }],
    rewards: { xp: { attack: 999, defense: 700, blacksmithing: 400 }, items: [{ id: 'crystal_cut', qty: 5 }, { id: 'bar_gold', qty: 4 }, { id: 'food_cake', qty: 1 }], blockCents: 600 },
    intro:
      "There's a dragon made of obsidian sleeping on the richest black-glass seam in existence — scales of forged volcanic glass, breath that melts adamant, and a mean streak a mile wide. One dragon. If you kill it, its scales are pre-forged obsidian plate, master-grade, and you'll never want for the black metal again. If it kills you, well, I warned the last six.",
    outro:
      "You slew the obsidian dragon. Its hoard is a seam of black glass you could mine for ten lifetimes, and its scales are armor the gods would covet. There aren't words for what you are now, mastersmith — 'legend' is too small and 'maniac' is too honest. The cake's the biggest I had. You earned the whole bakery.",
  },
  {
    id: 'q_forge_master_68',
    title: 'The Rime Dragon',
    giver: 'prospector_finn',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'dragon_rime', need: 1, label: 'Slay the rime dragon' }],
    rewards: { xp: { attack: 999, defense: 700, mining: 300 }, items: [{ id: 'crystal_cut', qty: 5 }, { id: 'crystal_raw', qty: 6 }, { id: 'food_cake', qty: 1 }], blockCents: 600 },
    intro:
      "The rime dragon sleeps atop the frostmetal mother-lode in the deep ice — breath that freezes the air into falling glass, scales of pure frostmetal, and the patience of a glacier with a grudge. One dragon. Its heart is the single largest frostmetal gem in the world. I'd go myself, but I'd like to keep my remaining limbs for the retirement I keep promising them.",
    outro:
      "The rime dragon sleeps forever now, and its heart — a frostmetal gem the size of a shield — is yours. The whole frozen mother-lode lies open behind it. You've claimed the cold sky and the hot sky both. There's only the dark one left, and even I won't send you there unless you ask.",
  },
  {
    id: 'q_forge_master_69',
    title: 'The Ashfall Dragon',
    giver: 'npc_forgotten_smith',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'dragon_ashfall', need: 1, label: 'Slay the ashfall dragon' }],
    rewards: { xp: { attack: 999, blacksmithing: 500, magic: 300 }, items: [{ id: 'crystal_cut', qty: 5 }, { id: 'bar_gold', qty: 4 }, { id: 'food_cake', qty: 1 }], blockCents: 600 },
    intro:
      "The ashfall dragon is the one that FELL — the biggest starfall of all, so big it didn't just drop metal, it dropped a dragon made of the stuff, still burning from the descent. One dragon. Its body is more starmetal than the whole crater field combined. End its very long, very fiery landing.",
    outro:
      "The ashfall dragon has finally finished falling. Its body is a mountain of starmetal, enough to arm a kingdom in blades that glow like dawn. You've killed a piece of the sky and lived to forge it. I'd retire now if I were you. You won't. Your kind never does.",
  },
  {
    id: 'q_forge_master_70',
    title: 'Gathering the Grand Flux',
    giver: 'smith_orin',
    regionId: 'ironhold',
    steps: [
      { kind: 'gather', target: 'herb_patch', need: 10, label: 'Gather 10 herb patches for binder' },
      { kind: 'gather', target: 'clay_pit', need: 10, label: 'Dig 10 clay pits for crucibles' },
      { kind: 'collect', target: 'crystal_shard', need: 6, label: 'Collect 6 crystal shards for the mix' },
    ],
    rewards: { xp: { blacksmithing: 700, mining: 200, herbalism: 120 }, items: [{ id: 'crystal_cut', qty: 2 }, { id: 'food_jelly', qty: 2 }], blockCents: 260 },
    intro:
      "To forge the sky-metals you need a flux grander than any one skill can make — herb binder, fresh crucibles, powdered crystal, all mixed by someone who's suffered across every discipline. That's you. You've suffered EVERYWHERE. Ten herbs, ten clay, six shards. Suffer once more, with feeling.",
    outro:
      "The grand flux is mixed — green and grey and glittering, smelling of a forge that hasn't been lit in a thousand years. With this, the starmetals finally behave. You've become the thing the frontier needed: a smith who's done ALL of it. Jelly's for the road. The road's uphill. It's always uphill.",
  },
  {
    id: 'q_forge_master_71',
    title: 'The Bone Wyrm',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'wyrm_bone', need: 2, label: 'Lay 2 bone wyrms to rest' }],
    rewards: { xp: { attack: 820, magic: 400 }, items: [{ id: 'crystal_cut', qty: 3 }, { id: 'potion_regret', qty: 1 }], blockCents: 320 },
    intro:
      "Bone wyrms have burrowed up through my graveyard chasing the starmetal that fell here an age ago — they SWALLOWED the whole crater and calcified around it. Two of them, rattling under my begonias. Put them down, recover the star-bone, and I'll stop having to apologize to Gerald for the noise.",
    outro:
      "Two bone wyrms, properly re-interred, and the star-bone they'd swallowed is yours — metal and bone fused by a thousand years of patient digestion. Horrible. Valuable. Very me. Gerald's calmer now. The begonias will recover. You, I'm less sure about.",
  },
  {
    id: 'q_forge_master_72',
    title: 'Crystalline Heart',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [{ kind: 'kill', target: 'wyrm_crystalline', need: 2, label: 'Slay 2 crystalline wyrms' }],
    rewards: { xp: { attack: 800, magic: 460, mining: 200 }, items: [{ id: 'crystal_cut', qty: 4 }, { id: 'crystal_raw', qty: 4 }], blockCents: 340 },
    intro:
      "A crystalline wyrm is what happens when a crystal seam grows for ten thousand years and wakes up annoyed. Two of them coil through the deepest crystal cavern, and their hearts are single flawless crystals the size of a man's torso. I want those hearts for Science. Capital S. Capital everything.",
    outro:
      "Two crystalline hearts, each a perfect prism heavy as sin. My treatise just gained three chapters and lost two rivals to despair. Cut crystal and raw, your share. Handle the hearts gently; they're humming at a pitch that's making my quill write things I didn't ask it to.",
  },
  {
    id: 'q_forge_master_73',
    title: 'The Permafrost Wyrm',
    giver: 'prospector_finn',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'wyrm_permafrost', need: 2, label: 'Slay 2 permafrost wyrms' }],
    rewards: { xp: { attack: 840, defense: 480, mining: 200 }, items: [{ id: 'crystal_cut', qty: 4 }, { id: 'crystal_raw', qty: 4 }], blockCents: 360 },
    intro:
      "Permafrost wyrms sleep in the deepest rime, so cold they've frozen the frostmetal AROUND themselves into armor — a dragon in an ice coffin of its own making. Two of them. Crack the coffins, kill the wyrms, claim the purest frostmetal the world will ever grow. Bring fire. Bring more fire. Bring a backup plan made of fire.",
    outro:
      "Two permafrost wyrms, thawed and ended, and the frostmetal from their coffins is purer than any seam. You've now claimed the hearts of both the hot sky and the cold. The frontier's running out of monsters to throw at you. It's going to be sad when it does. For the monsters.",
  },
  {
    id: 'q_forge_master_74',
    title: 'The Forgemaster Trial',
    giver: 'smith_orin',
    regionId: 'ironhold',
    steps: [
      { kind: 'collect', target: 'bar_steel', need: 12, label: 'Forge 12 flawless steel bars' },
      { kind: 'collect', target: 'bar_gold', need: 6, label: 'Pour 6 flawless gold bars' },
      { kind: 'collect', target: 'crystal_cut', need: 8, label: 'Cut 8 flawless crystals' },
      { kind: 'kill', target: 'rune_colossus', need: 4, label: 'Prove it on 4 rune colossi' },
    ],
    rewards: { xp: { blacksmithing: 999, mining: 500, attack: 400 }, items: [{ id: 'crystal_cut', qty: 5 }, { id: 'bar_gold', qty: 4 }, { id: 'food_cake', qty: 2 }], blockCents: 600 },
    intro:
      "The Forgemaster Trial. Nobody's passed it in three generations. Twelve flawless steel, six flawless gold, eight flawless crystal, and then take weapons YOU made and best four rune colossi with them. Pass, and the title 'Forgemaster' is yours — the last one died bitter and alone, which is the traditional retirement here.",
    outro:
      "Twelve, six, eight, flawless all, and four colossi down with blades of your own making. You're the Forgemaster now — first in three generations, and the youngest ever. I taught you to hold the hammer; you taught the mountain to fear it. The cake's doubled. So's my pride, and I ration that like gold.",
  },
  {
    id: 'q_forge_master_75',
    title: 'The Sky-Forged Legacy',
    giver: 'npc_forgotten_smith',
    regionId: 'forgotten',
    steps: [
      { kind: 'gather', target: 'crystal_node', need: 20, label: 'Mine 20 sky-metal nodes' },
      { kind: 'kill', target: 'wyrm_magma', need: 2, label: 'Slay 2 magma wyrms for star-cores' },
      { kind: 'kill', target: 'wyrm_permafrost', need: 2, label: 'Slay 2 permafrost wyrms for frost-cores' },
      { kind: 'kill', target: 'elem_void', need: 3, label: 'Harvest 3 void elementals for the dark core' },
    ],
    rewards: { xp: { blacksmithing: 999, mining: 999, attack: 700, magic: 500 }, items: [{ id: 'crystal_cut', qty: 8 }, { id: 'bar_gold', qty: 6 }, { id: 'crystal_raw', qty: 8 }, { id: 'food_cake', qty: 3 }], blockCents: 1000 },
    intro:
      "This is the last thing I'll ever ask of anyone. A blade that holds all three fallen skies at once — star, frost, and void — forged in one impossible piece. Twenty nodes, two magma wyrms, two permafrost wyrms, three void elementals. No smith has ever gathered all three. No smith has ever dared. You're not 'a smith'. You're THE smith. Go make the legacy.",
    outro:
      "It's done. A blade that burns and freezes and erases, all at once, the three fallen skies bound in one edge by hands that started out not knowing which end of a pick was which. There's nothing left above you — you've mined to the bottom of the world and forged the top of the sky. Whatever you make now, you make for history. Now put the hammer down, Forgemaster. You've earned a quiet that even this loud mountain will respect. Take the cake. Take all of it. You bought the bakery a hundred times over.",
  },
]

/** Light chains so the ladder reads as progression, not a pile of errands. */
const prereqs: Record<string, readonly string[]> = {
  // Chain A — copper
  q_forge_master_02: ['q_forge_master_01'],
  q_forge_master_05: ['q_forge_master_03', 'q_forge_master_04'],
  q_forge_master_08: ['q_forge_master_05', 'q_forge_master_06'],
  // Chain B — iron
  q_forge_master_09: ['q_forge_master_08'],
  q_forge_master_10: ['q_forge_master_09'],
  q_forge_master_12: ['q_forge_master_10'],
  q_forge_master_13: ['q_forge_master_12'],
  q_forge_master_15: ['q_forge_master_10'],
  q_forge_master_16: ['q_forge_master_13', 'q_forge_master_15'],
  // Chain C — steel
  q_forge_master_17: ['q_forge_master_16'],
  q_forge_master_19: ['q_forge_master_17'],
  q_forge_master_22: ['q_forge_master_19'],
  q_forge_master_24: ['q_forge_master_22'],
  // Chain D — gold & crystal
  q_forge_master_25: ['q_forge_master_16'],
  q_forge_master_26: ['q_forge_master_25'],
  q_forge_master_28: ['q_forge_master_27'],
  q_forge_master_31: ['q_forge_master_26'],
  q_forge_master_33: ['q_forge_master_28', 'q_forge_master_31'],
  q_forge_master_34: ['q_forge_master_33'],
  // Chain E — deep delve
  q_forge_master_35: ['q_forge_master_24', 'q_forge_master_34'],
  q_forge_master_36: ['q_forge_master_35'],
  q_forge_master_37: ['q_forge_master_36'],
  q_forge_master_38: ['q_forge_master_37'],
  q_forge_master_39: ['q_forge_master_38'],
  q_forge_master_40: ['q_forge_master_39'],
  q_forge_master_44: ['q_forge_master_40'],
  q_forge_master_45: ['q_forge_master_44'],
  q_forge_master_46: ['q_forge_master_45'],
  // Chain F — frontier
  q_forge_master_47: ['q_forge_master_46'],
  q_forge_master_48: ['q_forge_master_47'],
  q_forge_master_49: ['q_forge_master_48'],
  q_forge_master_50: ['q_forge_master_49'],
  q_forge_master_51: ['q_forge_master_50'],
  q_forge_master_53: ['q_forge_master_51'],
  q_forge_master_54: ['q_forge_master_51'],
  q_forge_master_55: ['q_forge_master_54'],
  q_forge_master_56: ['q_forge_master_55'],
  q_forge_master_57: ['q_forge_master_56'],
  q_forge_master_58: ['q_forge_master_57'],
  // Chain G — grand commissions
  q_forge_master_67: ['q_forge_master_51'],
  q_forge_master_68: ['q_forge_master_53'],
  q_forge_master_69: ['q_forge_master_51'],
  q_forge_master_74: ['q_forge_master_24'],
  q_forge_master_75: ['q_forge_master_57', 'q_forge_master_74'],
}

/** Display names for materials this pack tracks/grants (verified real ids). */
const itemNames: Record<string, string> = {
  ore_copper: 'Copper Ore',
  ore_iron: 'Iron Ore',
  ore_gold: 'Gold Ore',
  bar_copper: 'Copper Bar',
  bar_iron: 'Iron Bar',
  bar_steel: 'Steel Bar',
  bar_gold: 'Gold Bar',
  crystal_raw: 'Raw Crystal',
  crystal_shard: 'Crystal Shard',
  crystal_cut: 'Cut Crystal',
  clay_lump: 'Clay Lump',
  hide_boar: 'Boar Hide',
  hide_tough: 'Tough Hide',
  wood_oak: 'Oak Log',
  fish_trout: 'Trout',
  food_jerky: 'Dried Jerky',
  food_pie: 'Meat Pie',
  food_cake: 'Tiny Expensive Cake',
  food_honey: 'Pot of Honey',
  food_jelly: 'Fruit Jelly',
  potion_regret: 'Potion of Regret',
}

registerPack({ quests, prereqs, itemNames })
