/**
 * quests_expansion — the "lots of stuff" per-skill quest pack.
 *
 * ~60 quests spread across all 14 skills (combat + gathering + artisan),
 * placed on existing quest-giver NPCs across every region. Every step target
 * is a real species id (kill), node kind (gather), item id (collect), npc id
 * (talk) or region id (explore); every reward item id is a real catalog or
 * pack item. No new items/mesh/recipes introduced here — rewards reuse
 * existing materials, food, potions and tools so nothing dangles or renders
 * as the "?" fallback crate.
 *
 * Side-effect: registers at import time via registerPack({ quests, prereqs,
 * itemNames }). Imported from src/content/index.ts.
 */
import { registerPack } from './packs'
import type { QuestDef } from '../types'

const quests: QuestDef[] = [
  // ───────────────────────────── ATTACK ─────────────────────────────
  {
    id: 'qx_atk_thinning',
    title: 'Population Control',
    giver: 'captain_elara',
    regionId: 'capital',
    steps: [{ kind: 'kill', target: 'bandit', need: 8, label: 'Discourage 8 bandits' }],
    rewards: { xp: { attack: 240 }, items: [{ id: 'potion_hp_med', qty: 3 }], blockCents: 40 },
    intro:
      "The road tax was supposed to pay for road repairs, not for a bandit's third yacht. Go out there and renegotiate the arrangement with the pointy end of whatever you're holding. Eight of them. Count out loud if it helps you stay motivated.",
    outro:
      'Eight bandits retired early and involuntarily. The road is safe, the yacht is unfunded, and you smell faintly of other people’s bad decisions. Good work.',
  },
  {
    id: 'qx_atk_goblin_rush',
    title: 'Goblin Math',
    giver: 'npc_greenwood_foreman_bexley',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'goblin', need: 12, label: 'Settle up with 12 goblins' }],
    rewards: { xp: { attack: 200 }, items: [{ id: 'hide_wolf', qty: 4 }] },
    intro:
      "Goblins can't count past 'lots', which is a problem because there are lots of them and they keep arriving. Reduce 'lots' to 'fewer'. Twelve should restore my faith in subtraction.",
    outro:
      "Twelve goblins down. 'Lots' is now a manageable 'some'. The ledger balances. The goblins do not.",
  },
  {
    id: 'qx_atk_orc_proving',
    title: 'The Big Fellas',
    giver: 'npc_ashen_warden',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'orc', need: 6, label: 'Out-muscle 6 orcs' }],
    rewards: { xp: { attack: 380 }, items: [{ id: 'bar_steel', qty: 3 }], blockCents: 60 },
    intro:
      "Orcs are what happens when a goblin eats its feelings for ten years. Six of them have decided the ashlands belong to whoever hits hardest. Prove them right, then prove them wrong.",
    outro:
      "Six orcs learned that 'belongs to whoever hits hardest' was a losing argument to start. The ashlands remain nobody's. As intended.",
  },
  {
    id: 'qx_atk_boss_greenwood',
    title: 'Something Big in the Greenwood',
    giver: 'ranger_kael',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'boss_greenwood', need: 1, label: 'Fell the Greenwood terror' }],
    rewards: { xp: { attack: 600, defense: 200 }, items: [{ id: 'potion_hp_large', qty: 2 }], blockCents: 120 },
    intro:
      "The birds stopped singing. The deer left a forwarding address. Something enormous moved into the deep wood and started charging rent in screams. End its lease.",
    outro:
      "The forest exhaled. Birds are filing back in, mildly traumatized but singing. Whatever that thing was, it's now past tense. You look expensive to insure.",
  },

  // ───────────────────────────── DEFENSE ─────────────────────────────
  {
    id: 'qx_def_tank_school',
    title: 'Taking It on the Chin',
    giver: 'npc_capital_sergeant',
    regionId: 'capital',
    steps: [{ kind: 'kill', target: 'skeleton', need: 10, label: 'Soak 10 skeletons' }],
    rewards: { xp: { defense: 260, attack: 80 }, items: [{ id: 'bar_iron', qty: 4 }] },
    intro:
      "Anyone can swing a sword. Takes a real professional to stand there and get hit for a living. Wade into ten skeletons and let them wear themselves out on you. Dying is not part of the lesson plan.",
    outro:
      "Ten skeletons shattered against your guard like waves against a very grumpy rock. You barely flinched. The rock is proud.",
  },
  {
    id: 'qx_def_shieldwall',
    title: 'The Shieldwall Exam',
    giver: 'npc_ironhold_warden_bexley',
    regionId: 'ironhold',
    steps: [{ kind: 'kill', target: 'golem', need: 5, label: 'Hold the line vs 5 golems' }],
    rewards: { xp: { defense: 420 }, items: [{ id: 'potion_restoration', qty: 2 }], blockCents: 70 },
    intro:
      "Golems hit like a landslide filed a complaint in person. Stand firm against five of them. If you back up more than a step I'm failing you and telling everyone.",
    outro:
      "Five golems, zero steps backward, one slightly concussed but unbroken defender. You held. The line held. My reputation as a harsh grader is intact.",
  },
  {
    id: 'qx_def_crab_armor',
    title: 'Crab Logic',
    giver: 'npc_beginnings_perch',
    regionId: 'beginnings',
    steps: [{ kind: 'kill', target: 'crab', need: 9, label: 'Out-armor 9 crabs' }],
    rewards: { xp: { defense: 150 }, items: [{ id: 'hide_tough', qty: 3 }] },
    intro:
      "Crabs wear their skeleton on the outside, which is either genius or a cry for help. Study nine of them up close — by which I mean hit them until you understand their lifestyle.",
    outro:
      "Nine crabs studied, thoroughly. You now understand armor on a personal level, and also what's inside a crab. Both lessons stick with you.",
  },

  // ───────────────────────────── ARCHERY ─────────────────────────────
  {
    id: 'qx_arc_first_volley',
    title: 'From a Safe Distance',
    giver: 'ranger_kael',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'bat', need: 10, label: 'Pluck 10 bats from the air' }],
    rewards: { xp: { archery: 220 }, items: [{ id: 'potion_mp_small', qty: 2 }] },
    intro:
      "The whole point of a bow is that the thing dies over there and you stay over here. Bats are twitchy little targets — perfect practice. Ten of them. Lead the shot or waste the arrow.",
    outro:
      "Ten bats fell out of the sky with excellent grouping. You've grasped the ranger creed: let the problem commute to its own funeral.",
  },
  {
    id: 'qx_arc_spider_nest',
    title: 'Pest Control, Ranged',
    giver: 'npc_greenwood_beastmaster_oona',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'spider', need: 14, label: 'Thin 14 spiders' }],
    rewards: { xp: { archery: 300 }, items: [{ id: 'hide_wolf', qty: 3 }], blockCents: 40 },
    intro:
      "There is a spider situation. I refuse to be in melee range of a spider situation. That's what you and your bow are for. Fourteen legs' worth — no, that's not how spiders work, just shoot fourteen of them.",
    outro:
      "Fourteen spiders, resolved from a dignified distance. My skin has stopped crawling. Yours probably started. Sorry.",
  },
  {
    id: 'qx_arc_imp_hunt',
    title: 'Little Red Problems',
    giver: 'hermit_vex',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'imp', need: 11, label: 'Snipe 11 imps' }],
    rewards: { xp: { archery: 360 }, items: [{ id: 'potion_mp_med', qty: 3 }], blockCents: 55 },
    intro:
      "Imps are fast, mean, and on fire, which is three excellent reasons not to let them get close. Put eleven of them down before they put you up in flames. Breathe. Loose. Repeat.",
    outro:
      "Eleven imps extinguished permanently. The ash is quieter now, and you didn't singe a single eyebrow. That's the ranger difference.",
  },
  {
    id: 'qx_arc_marksman',
    title: "A Marksman's Reputation",
    giver: 'npc_forgotten_beastward',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'wisp', need: 8, label: 'Dispel 8 wisps with arrows' }],
    rewards: { xp: { archery: 480 }, items: [{ id: 'crystal_shard', qty: 4 }], blockCents: 80 },
    intro:
      "Wisps barely exist — half-light and bad intentions. Hitting one is a party trick. Hitting eight is a resume. Go write yourself a resume.",
    outro:
      "Eight wisps unwisped. Word travels: there's an archer in the Forgotten who hits what shouldn't be hittable. Enjoy the reputation; it's cheaper than advertising.",
  },

  // ───────────────────────────── MAGIC ─────────────────────────────
  {
    id: 'qx_mag_first_spark',
    title: 'Don’t Point That At Me',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [{ kind: 'kill', target: 'slime', need: 10, label: 'Vaporize 10 slimes' }],
    rewards: { xp: { magic: 210 }, items: [{ id: 'potion_mp_med', qty: 2 }] },
    intro:
      "Magic is just physics with an attitude problem. Slimes are wonderfully flammable and don't file complaints. Boil ten of them. Mind the backsplash.",
    outro:
      "Ten slimes reduced to a faint whistling steam. Your hands tingle with competence and mild ozone. The physics has been given its attitude.",
  },
  {
    id: 'qx_mag_bind_wisps',
    title: 'Borrowed Light',
    giver: 'npc_capital_magus',
    regionId: 'capital',
    steps: [{ kind: 'kill', target: 'wisp', need: 9, label: 'Unravel 9 wisps' }],
    rewards: { xp: { magic: 300 }, items: [{ id: 'crystal_raw', qty: 5 }], blockCents: 45 },
    intro:
      "Wisps are condensed arcane runoff that got ideas. Pop nine of them and the ambient weave settles down. Also they're pretty, so do it somewhere I can watch.",
    outro:
      "Nine wisps unraveled into harmless sparkle. The weave hums contentedly. Honestly a lovely little show — you've got a flair for the dramatic.",
  },
  {
    id: 'qx_mag_imp_banish',
    title: 'Fight Fire With Worse Fire',
    giver: 'prophet_karl',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'imp', need: 10, label: 'Banish 10 imps' }],
    rewards: { xp: { magic: 360 }, items: [{ id: 'potion_mp_large', qty: 2 }], blockCents: 60 },
    intro:
      "The imps think they own fire. Introduce them to someone who does it academically. Ten banishments. Enunciate the incantation; a mispronounced banish just makes them angry and well-informed.",
    outro:
      "Ten imps banished, correctly conjugated. They've gone back to wherever imps come from to tell everyone about the scary one with the good diction.",
  },
  {
    id: 'qx_mag_skeleton_ward',
    title: 'Undo the Undone',
    giver: 'gravekeeper_sol',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'skeleton', need: 13, label: 'Re-rest 13 skeletons' }],
    rewards: { xp: { magic: 440 }, items: [{ id: 'crystal_cut', qty: 3 }], blockCents: 75 },
    intro:
      "These skeletons were promised eternal rest and then rudely un-promised by somebody with more ambition than manners. Put thirteen of them back to sleep. Permanently. It's a kindness, mostly.",
    outro:
      "Thirteen skeletons tucked back into the earth. The graveyard sighs the sigh of the finally-left-alone. Rest well. Again. For real this time.",
  },

  // ───────────────────────────── VITALITY ─────────────────────────────
  {
    id: 'qx_vit_hard_living',
    title: 'Whatever Doesn’t Kill You',
    giver: 'npc_beginnings_tobias',
    regionId: 'beginnings',
    steps: [{ kind: 'kill', target: 'wolf', need: 8, label: 'Survive 8 wolves' }],
    rewards: { xp: { vitality: 180, defense: 60 }, items: [{ id: 'food_stew', qty: 3 }] },
    intro:
      "Vitality isn't a potion, it's a lifestyle, and the lifestyle is 'things keep biting you and you keep not dying'. Go let eight wolves fail to kill you. Builds character. And hit points.",
    outro:
      "Eight wolves gave it their all. Their all was insufficient. You're tougher now, in the way that only survived things make you. Have some stew.",
  },
  {
    id: 'qx_vit_iron_gut',
    title: 'The Iron Gut',
    giver: 'npc_greenwood_cook_dill',
    regionId: 'greenwood',
    steps: [
      { kind: 'collect', target: 'food_pie', need: 4, label: 'Acquire 4 pies' },
      { kind: 'collect', target: 'food_feast', need: 1, label: 'Acquire 1 feast' },
    ],
    rewards: { xp: { vitality: 260 }, items: [{ id: 'potion_vigor', qty: 2 }], blockCents: 30 },
    intro:
      "You want stamina? Stamina is just the body's memory of large meals. Bring me four pies and a full feast and we'll do some very serious 'training' at the table. Wear loose clothing.",
    outro:
      "Four pies and a feast, consumed in the name of science and gluttony. Your constitution has leveled up and so, visibly, have you. Worth it.",
  },
  {
    id: 'qx_vit_long_march',
    title: 'The Long Way Round',
    giver: 'inspector_flora',
    regionId: 'forgotten',
    steps: [
      { kind: 'explore', target: 'ashen', need: 1, label: 'Reach the Ashlands' },
      { kind: 'explore', target: 'ironhold', need: 1, label: 'Reach Ironhold' },
    ],
    rewards: { xp: { vitality: 320 }, items: [{ id: 'potion_stamina', qty: 3 }], blockCents: 50 },
    intro:
      "Endurance is a thing you prove with your feet, not your mouth. Walk the long circuit — ash, then iron — without collapsing dramatically. The collapsing is optional but frowned upon.",
    outro:
      "You walked the circuit and lived. The road taught your legs things no potion could. You collapsed only a little, and only at the end, which I'm counting as a pass.",
  },

  // ───────────────────────────── MINING ─────────────────────────────
  {
    id: 'qx_min_copper_start',
    title: 'Rock Bottom',
    giver: 'npc_beginnings_marigold',
    regionId: 'beginnings',
    steps: [{ kind: 'gather', target: 'copper_vein', need: 8, label: 'Mine 8 copper veins' }],
    rewards: { xp: { mining: 160 }, items: [{ id: 'food_bread', qty: 3 }] },
    intro:
      "Everyone starts at rock bottom. Literally. Swing a pick at eight copper veins and discover that mining is 10% skill and 90% being okay with dust in places you didn't know you had.",
    outro:
      "Eight veins lighter, the hillside is. Eight veins' worth of copper, you are richer by. The dust? Permanent. Welcome to mining.",
  },
  {
    id: 'qx_min_iron_quota',
    title: 'Making Quota',
    giver: 'foreman_dagna',
    regionId: 'ironhold',
    steps: [{ kind: 'gather', target: 'iron_vein', need: 12, label: 'Mine 12 iron veins' }],
    rewards: { xp: { mining: 300 }, items: [{ id: 'bar_iron', qty: 2 }], blockCents: 40 },
    intro:
      "The quota is twelve iron veins and the quota does not care about your feelings, your lunch break, or the interesting rock you found. Twelve. Go. The rock can wait.",
    outro:
      "Quota met. Twelve veins, logged and smelt-ready. The foreman nods, which from a foreman is the equivalent of a standing ovation and a raise.",
  },
  {
    id: 'qx_min_gold_rush',
    title: 'Gold Fever',
    giver: 'npc_ironhold_quartermaster_odo',
    regionId: 'ironhold',
    steps: [{ kind: 'gather', target: 'gold_vein', need: 7, label: 'Mine 7 gold veins' }],
    rewards: { xp: { mining: 420 }, items: [{ id: 'ore_gold', qty: 5 }], blockCents: 80 },
    intro:
      "Gold does something to people. Usually 'ruins their life'. But you need the experience and I need the ore, so let's catch a small, controlled case of gold fever. Seven veins. Then put the pick down and walk away like a stable person.",
    outro:
      "Seven gold veins, cleanly worked, no life ruined that I can see. You've got the touch and, more importantly, the restraint. Rare combination.",
  },
  {
    id: 'qx_min_crystal_deep',
    title: 'The Singing Dark',
    giver: 'npc_ironhold_deepwarden_hale',
    regionId: 'ironhold',
    steps: [{ kind: 'gather', target: 'crystal_node', need: 6, label: 'Harvest 6 crystal nodes' }],
    rewards: { xp: { mining: 520, magic: 80 }, items: [{ id: 'crystal_raw', qty: 6 }], blockCents: 100 },
    intro:
      "Deep down the crystals hum when you get close. Pretty. Also a warning. Harvest six nodes and come back up before the humming starts answering your thoughts. That's the rule. The ONE rule.",
    outro:
      "Six crystal nodes, and you came back up still yourself. The humming nearly had you — I saw your eyes glaze — but you held. The deep keeps its crystals and, this time, not you.",
  },
  {
    id: 'qx_min_clay_simple',
    title: 'Honest Mud',
    giver: 'npc_beginnings_posey',
    regionId: 'beginnings',
    steps: [{ kind: 'gather', target: 'clay_pit', need: 10, label: 'Dig 10 clay pits' }],
    rewards: { xp: { mining: 140 }, items: [{ id: 'food_apple', qty: 4 }] },
    intro:
      "Not every day is gold and glory. Some days it's clay. Dig ten pits' worth. It's humble, it's muddy, and the village potter will love you for about an hour.",
    outro:
      "Ten pits of good honest clay. The potter is thrilled, you are filthy, and somewhere a very nice bowl is about to exist because of you. Circle of life.",
  },

  // ───────────────────────────── WOODCUTTING ─────────────────────────────
  {
    id: 'qx_wc_oak_order',
    title: 'Timber!',
    giver: 'npc_beginnings_hazel',
    regionId: 'beginnings',
    steps: [{ kind: 'gather', target: 'oak_tree', need: 10, label: 'Fell 10 oak trees' }],
    rewards: { xp: { woodcutting: 180 }, items: [{ id: 'food_jerky', qty: 3 }] },
    intro:
      "Ten oaks. The village needs the wood and the oaks need to learn humility. Yell 'timber' each time — it's not required but it's the only perk of the job.",
    outro:
      "Ten oaks, horizontal. You yelled 'timber' every time, didn't you. I can tell. The wood is good and your enthusiasm is noted, exhaustingly.",
  },
  {
    id: 'qx_wc_pine_cold',
    title: 'Pines for the Fire',
    giver: 'npc_greenwood_foreman_bexley',
    regionId: 'greenwood',
    steps: [{ kind: 'gather', target: 'pine_tree', need: 12, label: 'Fell 12 pine trees' }],
    rewards: { xp: { woodcutting: 280 }, items: [{ id: 'wood_pine', qty: 6 }], blockCents: 35 },
    intro:
      "Winter's coming and winter doesn't negotiate. Twelve pines for firewood. Sappy, sticky, and they smell like a holiday you can't afford. Get chopping.",
    outro:
      "Twelve pines down, hands gloriously sticky. The hearths will burn all winter and the whole village will smell like an expensive candle. You're welcome, everyone.",
  },
  {
    id: 'qx_wc_ancient_grove',
    title: 'Old Wood, Old Rules',
    giver: 'npc_greenwood_herbwife_tansy',
    regionId: 'greenwood',
    steps: [{ kind: 'gather', target: 'oak_tree', need: 18, label: 'Work the deep oaks (18)' }],
    rewards: { xp: { woodcutting: 460 }, items: [{ id: 'wood_ancient', qty: 2 }], blockCents: 90 },
    intro:
      "The deep oaks are old enough to remember your grandmother being born. Work eighteen of them — respectfully, if you can manage respect while swinging an axe. The old wood is worth the ache.",
    outro:
      "Eighteen deep oaks, worked with something almost like reverence. Your arms are ruined and the ancient wood you earned is worth three of anything else. The grove forgives you. Probably.",
  },

  // ───────────────────────────── FISHING ─────────────────────────────
  {
    id: 'qx_fish_first_cast',
    title: 'Something Fishy',
    giver: 'honest_jim',
    regionId: 'beginnings',
    steps: [{ kind: 'gather', target: 'fishing_spot', need: 10, label: 'Fish 10 times' }],
    rewards: { xp: { fishing: 170 }, items: [{ id: 'rod_sturdy', qty: 1 }] },
    intro:
      "Fishing is just standing by water lying to worms. Cast ten times. You'll catch fish, a boot, possibly a cold. Keep the fish. Here's a better rod for your trouble — don't tell anyone where you got it.",
    outro:
      "Ten casts, a respectable haul, and only one boot. That's a good day on the water. The sturdy rod's yours. Officially you found it. Wink.",
  },
  {
    id: 'qx_fish_market_run',
    title: 'The Catch of the Day',
    giver: 'npc_greenwood_cook_dill',
    regionId: 'greenwood',
    steps: [
      { kind: 'collect', target: 'fish_salmon', need: 6, label: 'Catch 6 salmon' },
      { kind: 'collect', target: 'fish_trout', need: 6, label: 'Catch 6 trout' },
    ],
    rewards: { xp: { fishing: 320 }, items: [{ id: 'food_fish', qty: 4 }], blockCents: 45 },
    intro:
      "Menu's set, kitchen's hot, and I have no fish, which is a famously bad way to run a fish restaurant. Six salmon, six trout. The customers are getting restless and so am I.",
    outro:
      "Six and six, fresh enough to flop. Service is saved, the customers are fed, and the restaurant remains, technically, a fish restaurant. You're a hero in an apron.",
  },
  {
    id: 'qx_fish_golden',
    title: 'The One That Doesn’t Get Away',
    giver: 'hermit_vex',
    regionId: 'ashen',
    steps: [{ kind: 'collect', target: 'fish_golden', need: 1, label: 'Land 1 golden fish' }],
    rewards: { xp: { fishing: 500 }, items: [{ id: 'potion_elixir', qty: 1 }], blockCents: 120 },
    intro:
      "There's a golden fish that every angler swears is a legend and every legend swears is real. Catch it. One. I'll wait. I've been waiting forty years, so, you know. Pace yourself.",
    outro:
      "You caught the golden fish. The actual golden fish. Forty years I waited and you did it in an afternoon, which I'm choosing not to have feelings about. Take the elixir. Tell no one it was easy.",
  },

  // ───────────────────────────── FARMING ─────────────────────────────
  {
    id: 'qx_farm_first_harvest',
    title: 'Dirt Rich',
    giver: 'farmer_bram',
    regionId: 'beginnings',
    steps: [{ kind: 'gather', target: 'farm_plot', need: 10, label: 'Work 10 farm plots' }],
    rewards: { xp: { farming: 170 }, items: [{ id: 'wheat', qty: 8 }] },
    intro:
      "Farming: where you do backbreaking labor for months so a rabbit can eat it in an afternoon. Work ten plots. Welcome to the most honest and least grateful profession there is.",
    outro:
      "Ten plots worked, wheat in the bin, rabbits already plotting. You've tasted the farmer's eternal struggle and it tastes like dirt and quiet pride. Here's your harvest.",
  },
  {
    id: 'qx_farm_berry_season',
    title: 'Berry Nice',
    giver: 'npc_greenwood_herbwife_tansy',
    regionId: 'greenwood',
    steps: [{ kind: 'gather', target: 'berry_bush', need: 12, label: 'Pick 12 berry bushes' }],
    rewards: { xp: { farming: 280 }, items: [{ id: 'berry_red', qty: 10 }], blockCents: 35 },
    intro:
      "The berries are ripe, which means we have about a day before the birds, the bears, and the local children strip every bush bare. Pick twelve before nature's freeloaders arrive.",
    outro:
      "Twelve bushes picked clean, just ahead of the mob. Red fingers, full basket, zero shared with the birds. Selfish, efficient, delicious. I approve.",
  },
  {
    id: 'qx_farm_big_season',
    title: 'The Whole Nine Fields',
    giver: 'farmer_bram',
    regionId: 'beginnings',
    steps: [
      { kind: 'gather', target: 'farm_plot', need: 16, label: 'Work 16 farm plots' },
      { kind: 'collect', target: 'wheat', need: 12, label: 'Bring in 12 wheat' },
    ],
    rewards: { xp: { farming: 460 }, items: [{ id: 'food_bread', qty: 6 }], blockCents: 70 },
    intro:
      "Big season, big back pain. Sixteen plots and twelve wheat in the barn before the weather turns mean. Do it and I'll bake you bread from your own grain, which is either poetic or cruel. Haven't decided.",
    outro:
      "Sixteen plots, twelve wheat, one aching legend. The barn's full and the bread's warm — baked from grain you grew. Turns out it's poetic. Eat up, farmer.",
  },

  // ───────────────────────────── HERBALISM ─────────────────────────────
  {
    id: 'qx_herb_starter',
    title: 'Weeds With Benefits',
    giver: 'npc_greenwood_herbwife_tansy',
    regionId: 'greenwood',
    steps: [{ kind: 'gather', target: 'herb_patch', need: 10, label: 'Gather 10 herb patches' }],
    rewards: { xp: { herbalism: 180 }, items: [{ id: 'herb_green', qty: 6 }] },
    intro:
      "Most people see a weed. An herbalist sees a weed that'll fix your headache or stop your heart, depending on respect shown. Gather ten patches. Touch nothing to your mouth until I say.",
    outro:
      "Ten patches gathered, mouth commendably shut the whole time. You're learning the first law of herbalism: everything's medicine, some of it's revenge.",
  },
  {
    id: 'qx_herb_mushrooms',
    title: 'Fungal Economics',
    giver: 'hermit_vex',
    regionId: 'ashen',
    steps: [{ kind: 'gather', target: 'mushroom_cluster', need: 12, label: 'Pick 12 mushroom clusters' }],
    rewards: { xp: { herbalism: 300 }, items: [{ id: 'mushroom_brown', qty: 8 }], blockCents: 40 },
    intro:
      "Two kinds of mushroom out there: delicious and 'your family will tell a cautionary tale about you'. Pick twelve clusters. I'll sort the good from the fatal. That's my job. Yours is the picking.",
    outro:
      "Twelve clusters, and I've sorted them: mostly dinner, a few funerals narrowly avoided. Good eye, or good luck. Either works at this stage.",
  },
  {
    id: 'qx_herb_rare_bloom',
    title: 'The Blue Hour Bloom',
    giver: 'npc_capital_archivist',
    regionId: 'capital',
    steps: [
      { kind: 'collect', target: 'herb_blue', need: 8, label: 'Gather 8 blue herbs' },
      { kind: 'collect', target: 'herb_gold', need: 4, label: 'Gather 4 gold herbs' },
    ],
    rewards: { xp: { herbalism: 480 }, items: [{ id: 'potion_clarity', qty: 2 }], blockCents: 85 },
    intro:
      "The blue herb only shows its color at dusk and the gold one only to the patient. I need eight blue, four gold, for a treatise nobody will read but everybody will cite. Scholarship, baby.",
    outro:
      "Eight blue, four gold, pressed and catalogued. My treatise lives. It will be cited by people who never opened it, which is academic immortality. You made that possible. Sort of.",
  },

  // ───────────────────────────── BLACKSMITHING ─────────────────────────────
  {
    id: 'qx_smith_first_bars',
    title: 'Hot and Bothered',
    giver: 'npc_ironhold_smelt_greta',
    regionId: 'ironhold',
    steps: [{ kind: 'collect', target: 'bar_copper', need: 6, label: 'Smelt 6 copper bars' }],
    rewards: { xp: { blacksmithing: 200 }, items: [{ id: 'food_kebab', qty: 3 }] },
    intro:
      "Forge rule one: the metal is always hotter than you think and you are always closer than you should be. Smelt six copper bars. Burn yourself no more than twice; that's considered a clean run.",
    outro:
      "Six copper bars, poured clean, and only the standard amount of singeing. You've got the forge in your blood now, along with some minor burns. Eat a kebab, hero. You earned the grease.",
  },
  {
    id: 'qx_smith_steel',
    title: 'The Steel Standard',
    giver: 'npc_ironhold_quartermaster_odo',
    regionId: 'ironhold',
    steps: [{ kind: 'collect', target: 'bar_steel', need: 5, label: 'Forge 5 steel bars' }],
    rewards: { xp: { blacksmithing: 400 }, items: [{ id: 'bar_steel', qty: 2 }], blockCents: 60 },
    intro:
      "Copper's for amateurs and candlesticks. Steel's for people who intend to survive a fight. Fold me five steel bars worthy of the quartermaster's stamp. The stamp is judgmental. So am I.",
    outro:
      "Five steel bars, stamped and approved — and the stamp does NOT approve easily. You've graduated from candlesticks to consequences. The armory's glad to have you.",
  },
  {
    id: 'qx_smith_mastersmith',
    title: 'By Hammer and Spite',
    giver: 'npc_forgotten_smith',
    regionId: 'forgotten',
    steps: [
      { kind: 'collect', target: 'bar_steel', need: 6, label: 'Forge 6 steel bars' },
      { kind: 'collect', target: 'bar_gold', need: 3, label: 'Pour 3 gold bars' },
    ],
    rewards: { xp: { blacksmithing: 620 }, items: [{ id: 'potion_forge_charm', qty: 2 }], blockCents: 110 },
    intro:
      "A mastersmith is just a regular smith who refused to quit after the forge tried to kill them nine times. Six steel, three gold, no quitting. Let's see if the tenth attempt makes you or breaks you.",
    outro:
      "Six steel, three gold, zero quit. The forge tried for the tenth time and failed. You're a mastersmith now — not by talent, by spite. Best way there is.",
  },

  // ───────────────────────────── COOKING ─────────────────────────────
  {
    id: 'qx_cook_first_meal',
    title: 'Edible, Technically',
    giver: 'npc_greenwood_cook_dill',
    regionId: 'greenwood',
    steps: [{ kind: 'collect', target: 'food_bread', need: 5, label: 'Bake 5 bread' }],
    rewards: { xp: { cooking: 180 }, items: [{ id: 'food_cheese', qty: 3 }] },
    intro:
      "Cooking is chemistry you're allowed to eat. Bake five loaves. If the smoke alarm goes off, that's not failure, that's 'rustic'. But aim for golden, not charcoal.",
    outro:
      "Five loaves, golden, no alarms. You've crossed the line from 'can boil water' to 'can be trusted near a kitchen'. Big day. Have some cheese to go with it.",
  },
  {
    id: 'qx_cook_feast_prep',
    title: 'Feast or Famine',
    giver: 'maestro_ribbert',
    regionId: 'capital',
    steps: [
      { kind: 'collect', target: 'food_pie', need: 4, label: 'Bake 4 pies' },
      { kind: 'collect', target: 'food_stew', need: 4, label: 'Cook 4 stews' },
    ],
    rewards: { xp: { cooking: 360 }, items: [{ id: 'food_feast', qty: 2 }], blockCents: 55 },
    intro:
      "The gala is tonight, the guest list is insufferable, and the kitchen just quit en masse. Four pies, four stews, now now now. The nobles can smell weakness and also food. Mostly food.",
    outro:
      "Four pies, four stews, gala saved. The nobles are too busy chewing to be insufferable, which is the closest they come to pleasant. You cooked peace into existence. Briefly.",
  },
  {
    id: 'qx_cook_golden_dish',
    title: "The Critic's Table",
    giver: 'npc_capital_marketeer',
    regionId: 'capital',
    steps: [
      { kind: 'collect', target: 'food_cake', need: 2, label: 'Bake 2 cakes' },
      { kind: 'collect', target: 'fish_golden', need: 1, label: 'Source 1 golden fish' },
    ],
    rewards: { xp: { cooking: 560 }, items: [{ id: 'food_golden_fillet', qty: 2 }], blockCents: 130 },
    intro:
      "A food critic is coming. They have ruined restaurants with a single eyebrow. I need two flawless cakes and — don't faint — a golden fish for the centerpiece. Impress them or we're both selling turnips by spring.",
    outro:
      "Two flawless cakes, a golden-fish centerpiece, and the critic's eyebrow stayed DOWN. That's a rave. No turnips this spring. You cook like the stakes are life and death, because with that critic, they were.",
  },

  // ───────────────────────────── ALCHEMY ─────────────────────────────
  {
    id: 'qx_alch_first_brew',
    title: 'Better Living Through Chemistry',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [{ kind: 'collect', target: 'potion_hp_small', need: 5, label: 'Brew 5 small heals' }],
    rewards: { xp: { alchemy: 190 }, items: [{ id: 'herb_red', qty: 6 }] },
    intro:
      "Alchemy is cooking for people who want to live forever and smell like a swamp. Brew five small healing potions. If any of them explode, write down why first, THEN panic.",
    outro:
      "Five healing potions, zero explosions, acceptable swamp odor. You've got the knack — part science, part stubbornness, part not blinking when things bubble ominously.",
  },
  {
    id: 'qx_alch_mana_line',
    title: 'Bottled Lightning',
    giver: 'npc_capital_magus',
    regionId: 'capital',
    steps: [{ kind: 'collect', target: 'potion_mp_med', need: 5, label: 'Brew 5 mana potions' }],
    rewards: { xp: { alchemy: 380 }, items: [{ id: 'potion_mp_large', qty: 2 }], blockCents: 55 },
    intro:
      "Mages drink mana potions like water and complain just as much. Brew five of the good stuff. Get the crystal ratio wrong and it tastes like a battery; get it right and it tastes like winning.",
    outro:
      "Five mana potions, tasting of victory rather than battery acid. The mages will drink them and complain anyway — that's just mages — but your ratios were perfect.",
  },
  {
    id: 'qx_alch_panacea',
    title: 'The Cure for Everything',
    giver: 'prophet_karl',
    regionId: 'ashen',
    steps: [
      { kind: 'collect', target: 'herb_gold', need: 6, label: 'Gather 6 gold herbs' },
      { kind: 'collect', target: 'crystal_shard', need: 4, label: 'Refine 4 crystal shards' },
      { kind: 'collect', target: 'potion_panacea', need: 1, label: 'Distill 1 panacea' },
    ],
    rewards: { xp: { alchemy: 680, herbalism: 120 }, items: [{ id: 'potion_elixir', qty: 1 }], blockCents: 140 },
    intro:
      "They say a true alchemist brews a panacea — the cure for everything — exactly once, and spends the rest of their life trying to do it again. Gold herb, crystal, patience. Brew the impossible. Then act humble about it.",
    outro:
      "One panacea. The cure for everything, sitting in a little glass vial, glowing like it knows a secret. You did the impossible thing alchemists chase for lifetimes. Now spend the rest of yours being insufferably humble about it.",
  },

  // ───────────────────────────── TAILORING ─────────────────────────────
  {
    id: 'qx_tail_first_stitch',
    title: 'A Stitch in Time',
    giver: 'npc_beginnings_posey',
    regionId: 'beginnings',
    steps: [{ kind: 'collect', target: 'hide_wolf', need: 6, label: 'Gather 6 wolf hides' }],
    rewards: { xp: { tailoring: 180 }, items: [{ id: 'thread_sinew', qty: 6 }] },
    intro:
      "You want to be a tailor? First you make friends with a needle and it will stab you, repeatedly, as a form of hazing. Bring six wolf hides so we have something to ruin while you learn. Thimbles are for cowards and the wise.",
    outro:
      "Six hides, several finger-stabs, one humbled apprentice. The needle has accepted you, grudgingly. Here's thread. Try to bleed on the material less next time.",
  },
  {
    id: 'qx_tail_leatherwork',
    title: 'Tough as Old Boots',
    giver: 'npc_ironhold_quartermaster_odo',
    regionId: 'ironhold',
    steps: [
      { kind: 'collect', target: 'hide_tough', need: 5, label: 'Cure 5 tough hides' },
      { kind: 'collect', target: 'hide_boar', need: 4, label: 'Cure 4 boar hides' },
    ],
    rewards: { xp: { tailoring: 380 }, items: [{ id: 'boar_leather', qty: 4 }], blockCents: 50 },
    intro:
      "Cloth is for pillows. The quartermaster needs LEATHER — the kind that stops a knife and outlives its owner. Five tough hides, four boar. Cure them right or the whole garrison dresses like a pillow fort.",
    outro:
      "Five tough, four boar, cured hard as regret. The garrison's kit will stop knives and outlast wars. Nobody's dressing like a pillow fort on your watch. The quartermaster almost smiles.",
  },
  {
    id: 'qx_tail_mastercloth',
    title: 'The Emperor’s Actual Clothes',
    giver: 'npc_capital_marketeer',
    regionId: 'capital',
    steps: [
      { kind: 'collect', target: 'crystal_weave', need: 4, label: 'Weave 4 crystal-thread bolts' },
      { kind: 'collect', target: 'padded_lining', need: 3, label: 'Quilt 3 padded linings' },
    ],
    rewards: { xp: { tailoring: 600 }, items: [{ id: 'satchel_ranger', qty: 1 }], blockCents: 120 },
    intro:
      "The last tailor who dressed the court vanished, probably from the pressure, possibly from a hem comment. Weave me four bolts of crystal-thread and three padded linings fit for royalty. Make it so good it's basically armor with opinions.",
    outro:
      "Four bolts, three linings, fit for a court that destroys reputations for sport. It's armor with opinions, exactly as ordered. You didn't vanish under the pressure. You tailored it into submission. Take the ranger's satchel — you've clearly earned a place to hide from nobles.",
  },
]

/** A few light chains so the skills read as progressions, not loose errands. */
const prereqs: Record<string, readonly string[]> = {
  qx_min_iron_quota: ['qx_min_copper_start'],
  qx_min_gold_rush: ['qx_min_iron_quota'],
  qx_min_crystal_deep: ['qx_min_gold_rush'],
  qx_wc_pine_cold: ['qx_wc_oak_order'],
  qx_wc_ancient_grove: ['qx_wc_pine_cold'],
  qx_fish_market_run: ['qx_fish_first_cast'],
  qx_fish_golden: ['qx_fish_market_run'],
  qx_farm_big_season: ['qx_farm_first_harvest'],
  qx_smith_steel: ['qx_smith_first_bars'],
  qx_smith_mastersmith: ['qx_smith_steel'],
  qx_cook_feast_prep: ['qx_cook_first_meal'],
  qx_cook_golden_dish: ['qx_cook_feast_prep'],
  qx_alch_mana_line: ['qx_alch_first_brew'],
  qx_alch_panacea: ['qx_alch_mana_line'],
  qx_tail_leatherwork: ['qx_tail_first_stitch'],
  qx_tail_mastercloth: ['qx_tail_leatherwork'],
  qx_herb_rare_bloom: ['qx_herb_starter'],
  qx_arc_marksman: ['qx_arc_first_volley'],
  qx_mag_skeleton_ward: ['qx_mag_first_spark'],
}

/** Display names for collect/reward ids that may not carry a catalog name. */
const itemNames: Record<string, string> = {
  crystal_weave: 'Crystal-Thread Bolt',
  padded_lining: 'Padded Lining',
  boar_leather: 'Cured Boar Leather',
  thread_sinew: 'Sinew Thread',
  satchel_ranger: "Ranger's Satchel",
  potion_forge_charm: 'Forge Charm',
  potion_panacea: 'Panacea',
  food_golden_fillet: 'Golden Fillet',
  berry_red: 'Red Berries',
  mushroom_brown: 'Brown Mushroom',
}

registerPack({ quests, prereqs, itemNames })
