/**
 * questmega_wild_harvest — the big gathering & crafting-chain quest pack.
 *
 * ~75 quests themed on the slow professions: woodcutting, fishing, farming,
 * herbalism, cooking and alchemy, with the occasional "the thing guarding the
 * good stuff must die first" combat step against the new wildlife/undead/
 * elemental/dragon species. Every step target is a real species id (kill),
 * node kind (gather), item id (collect), npc id (talk) or region id (explore);
 * every reward id is a real catalog material/food/potion. No new items, mesh
 * or recipes — rewards reuse existing stacks so nothing dangles.
 *
 * Side-effect: registers at import time via registerPack({ quests, prereqs,
 * itemNames }). Imported from src/content/index.ts.
 */
import { registerPack } from './packs'
import type { QuestDef } from '../types'

const quests: QuestDef[] = [
  // ═══════════════════════════ WOODCUTTING ═══════════════════════════
  // The Greenwood Timber Guild — chained
  {
    id: 'q_wild_harvest_01',
    title: 'Axe Me No Questions',
    giver: 'scout_wren',
    regionId: 'greenwood',
    steps: [{ kind: 'gather', target: 'oak_tree', need: 8, label: 'Fell 8 oak trees' }],
    rewards: { xp: { woodcutting: 140 }, items: [{ id: 'wood_oak', qty: 6 }] },
    intro:
      "You want woodcutting work? Fine. Here's the whole trade in one sentence: trees are tall, you are rude, gravity does the rest. Fell eight oaks. Don't name them first. People who name trees cry during this job.",
    outro:
      "Eight oaks, horizontal and dignified about it. You didn't cry, you didn't hug the bark, you just worked. The Guild can use someone who treats trees like furniture-in-waiting.",
  },
  {
    id: 'q_wild_harvest_02',
    title: 'Pining Away',
    giver: 'scout_wren',
    regionId: 'greenwood',
    steps: [
      { kind: 'gather', target: 'pine_tree', need: 10, label: 'Fell 10 pine trees' },
      { kind: 'collect', target: 'wood_pine', need: 6, label: 'Stack 6 pine logs' },
    ],
    rewards: { xp: { woodcutting: 220 }, items: [{ id: 'food_jerky', qty: 4 }], blockCents: 30 },
    intro:
      "Pines. Sticky, smug, and they drip sap into your collar out of pure spite. Fell ten and stack six good logs. Your hands will glue themselves to everything you own for a week. That's not injury, that's seasoning.",
    outro:
      "Ten pines down, six logs stacked, and you're now permanently adhesive — try not to lean on anyone you like. The firewood's good. The smell will outlive us both.",
  },
  {
    id: 'q_wild_harvest_03',
    title: 'Deer in the Headlights',
    giver: 'ranger_kael',
    regionId: 'greenwood',
    steps: [
      { kind: 'kill', target: 'meadow_fawn', need: 6, label: 'Cull 6 meadow fawns' },
      { kind: 'kill', target: 'horned_stag', need: 3, label: 'Face down 3 horned stags' },
    ],
    rewards: { xp: { attack: 180, woodcutting: 90 }, items: [{ id: 'hide_wolf', qty: 4 }] },
    intro:
      "You can't log the east grove — the deer have turned it into a nursery and the stags escort trespassers to a very personal afterlife. Thin six fawns and three stags. I know, I know, they're adorable. So was your paycheck before they ate the grove.",
    outro:
      "Six fawns, three stags, one grove reopened for business. Don't feel bad — the fawns were apprentice stags and the stags were professional problems. The hides fetch a decent price. Progress tastes like venison.",
  },
  {
    id: 'q_wild_harvest_04',
    title: 'The Thicket Thickens',
    giver: 'ranger_kael',
    regionId: 'greenwood',
    steps: [
      { kind: 'kill', target: 'thicket_lynx', need: 5, label: 'Drive off 5 thicket lynxes' },
      { kind: 'gather', target: 'oak_tree', need: 12, label: 'Fell 12 oaks in the cleared thicket' },
    ],
    rewards: { xp: { woodcutting: 300, attack: 120 }, items: [{ id: 'wood_oak', qty: 10 }], blockCents: 40 },
    intro:
      "A thicket lynx is a house cat that read one philosophy book and decided you're prey. Five of them den in the oak thicket. Clear the cats, then clear the oaks. In that order. Reverse it and we hold your funeral in the clearing.",
    outro:
      "Five lynxes relocated to the next life and twelve oaks relocated to my lumber yard. The thicket's quiet now except for your axe echoing. That echo is the sound of a mortgage being paid.",
  },
  {
    id: 'q_wild_harvest_05',
    title: 'Old Growth, Old Grudges',
    giver: 'herbalist_moss',
    regionId: 'greenwood',
    steps: [{ kind: 'gather', target: 'oak_tree', need: 20, label: 'Work the ancient oaks (20)' }],
    rewards: { xp: { woodcutting: 460 }, items: [{ id: 'wood_ancient', qty: 2 }], blockCents: 80 },
    intro:
      "The ancient oaks predate the kingdom, the roads, and, I suspect, good taste. Work twenty of them. The wood is worth a fortune and the splinters are worth a lifetime of saying 'ow' at the weather. Earn both.",
    outro:
      "Twenty ancient oaks, worked by hand, cursed at by you, and now worth more than my house. Your palms are one continuous callus. That's not damage. That's a resume written in skin.",
  },
  {
    id: 'q_wild_harvest_06',
    title: 'Boar-ing Afternoon',
    giver: 'ranger_kael',
    regionId: 'greenwood',
    steps: [
      { kind: 'kill', target: 'dire_boar', need: 4, label: 'Put down 4 dire boars' },
      { kind: 'collect', target: 'hide_boar', need: 4, label: 'Skin 4 boar hides' },
    ],
    rewards: { xp: { attack: 260, woodcutting: 80 }, items: [{ id: 'hide_boar', qty: 6 }, { id: 'food_jerky', qty: 3 }], blockCents: 45 },
    intro:
      "Dire boars have been uprooting my planting stakes and eating them, which is both destructive and a dietary choice I refuse to understand. Four of them. Bring back the hides. The stakes, sadly, are already fiber in a boar.",
    outro:
      "Four boars, four hides, and my stakes avenged if not recovered. A dire boar is just a regular boar that went to the gym to work out its anger issues. You out-angered them. Respect.",
  },
  {
    id: 'q_wild_harvest_07',
    title: 'Clear-Cut Case',
    giver: 'scout_wren',
    regionId: 'greenwood',
    steps: [
      { kind: 'gather', target: 'pine_tree', need: 14, label: 'Fell 14 ridge pines' },
      { kind: 'kill', target: 'ridgeback_hound', need: 5, label: 'See off 5 ridgeback hounds' },
      { kind: 'collect', target: 'wood_pine', need: 10, label: 'Deliver 10 pine logs' },
    ],
    rewards: { xp: { woodcutting: 420, attack: 150 }, items: [{ id: 'wood_pine', qty: 12 }, { id: 'bar_copper', qty: 2 }], blockCents: 60 },
    intro:
      "Big contract on the ridge. Fourteen pines, ten delivered, and a pack of ridgeback hounds that think the ridge is theirs because they've been loudest about it. Five hounds, loud right back. Then cut. Then carry. Then collapse, on your own time.",
    outro:
      "Fourteen pines, five hounds, ten logs on the cart. The ridge is open, the hounds have appealed to a higher authority (none), and you've done a full day's work three times over. Sit down before I have to catch you.",
  },
  {
    id: 'q_wild_harvest_08',
    title: 'Timber Baron',
    giver: 'scout_wren',
    regionId: 'greenwood',
    steps: [
      { kind: 'collect', target: 'wood_oak', need: 12, label: 'Stockpile 12 oak logs' },
      { kind: 'collect', target: 'wood_pine', need: 12, label: 'Stockpile 12 pine logs' },
      { kind: 'collect', target: 'wood_ancient', need: 3, label: 'Secure 3 ancient timbers' },
    ],
    rewards: { xp: { woodcutting: 700 }, items: [{ id: 'wood_ancient', qty: 2 }, { id: 'food_pie', qty: 2 }], blockCents: 140 },
    intro:
      "Graduation. To be the Guild's Timber Baron you deliver a baron's hoard: twelve oak, twelve pine, three ancient. No excuses, no 'the forest was emotional today'. Bring the wood or bring your resignation. I'll accept exactly one.",
    outro:
      "Twelve, twelve, and three. A baron's hoard, delivered by someone who started this week unable to tell an oak from a hat rack. The Guild bows. Slightly. We're not animals, but we're close, and you're one of us now.",
  },

  // ═══════════════════════════ FISHING ═══════════════════════════
  // The Outer Isles tackle — chained
  {
    id: 'q_wild_harvest_09',
    title: 'Reel Talk',
    giver: 'honest_jim',
    regionId: 'beginnings',
    steps: [{ kind: 'gather', target: 'fishing_spot', need: 10, label: 'Cast into the shallows 10 times' }],
    rewards: { xp: { fishing: 150 }, items: [{ id: 'fish_raw', qty: 6 }] },
    intro:
      "Fishing is the only job where doing nothing for hours is called 'trying'. Cast ten times in the shallows. You'll catch fish, weeds, and a profound understanding of your own patience, or lack thereof. Mostly fish, hopefully.",
    outro:
      "Ten casts, a bucket of raw fish, and you only swore at the water twice. That's calmer than most apprentices. The water, notably, did not swear back. It never does. Smug, the water.",
  },
  {
    id: 'q_wild_harvest_10',
    title: 'Something Smells Fishy',
    giver: 'honest_jim',
    regionId: 'beginnings',
    steps: [
      { kind: 'collect', target: 'fish_trout', need: 8, label: 'Land 8 trout' },
      { kind: 'kill', target: 'reefcrab', need: 6, label: 'Evict 6 reefcrabs from the nets' },
    ],
    rewards: { xp: { fishing: 240, attack: 80 }, items: [{ id: 'fish_trout', qty: 6 }], blockCents: 30 },
    intro:
      "Eight trout for the market and six reefcrabs out of my nets, because the crabs have decided my nets are a timeshare and they're never checking out. Pinch them before they pinch you. They WILL pinch you. Nothing personal to them. Very personal to your fingers.",
    outro:
      "Eight trout, six crabs, zero timeshares. The nets are mine again and your fingers are mostly accounted for. A reefcrab holds a grudge and a claw; you held better. Decent haul, decent day.",
  },
  {
    id: 'q_wild_harvest_11',
    title: 'Deep Water, Deeper Regrets',
    giver: 'prospector_finn',
    regionId: 'ironhold',
    steps: [
      { kind: 'gather', target: 'fishing_spot', need: 14, label: 'Work the cold mountain pools (14)' },
      { kind: 'kill', target: 'frostfin', need: 5, label: 'Hook and haul 5 frostfins' },
    ],
    rewards: { xp: { fishing: 360 }, items: [{ id: 'fish_salmon', qty: 6 }], blockCents: 50 },
    intro:
      "The mountain pools are so cold the fish come up pre-chilled. Work fourteen and wrestle five frostfins — they're the size of a toddler and twice as determined to ruin your afternoon. Wear layers. Bring a will. Not a last one. Just resolve.",
    outro:
      "Fourteen pools worked, five frostfins hauled flopping onto the ice. Your hands are blue and your pride is intact. A frostfin fights like it's got a mortgage; you won the negotiation. Thaw out. You earned the fire.",
  },
  {
    id: 'q_wild_harvest_12',
    title: 'Angler Management',
    giver: 'prospector_finn',
    regionId: 'ironhold',
    steps: [
      { kind: 'kill', target: 'anglerfiend', need: 4, label: 'Slay 4 anglerfiends' },
      { kind: 'kill', target: 'bogleech', need: 8, label: 'Burn off 8 bogleeches' },
    ],
    rewards: { xp: { fishing: 300, attack: 200 }, items: [{ id: 'fish_salmon', qty: 4 }, { id: 'potion_regret', qty: 1 }], blockCents: 55 },
    intro:
      "An anglerfiend dangles a pretty light and when you swim toward it you become the catch of the day — its day. Four of them have moved into the flooded shaft, and the bogleeches rent the water below them. Clear both. The light is a lie. So is the lease.",
    outro:
      "Four anglerfiends, eight leeches, one flooded shaft returned to being merely wet instead of actively homicidal. You swam toward the pretty light and the pretty light regretted everything. The potion of regret is thematically appropriate. Keep it.",
  },
  {
    id: 'q_wild_harvest_13',
    title: 'The Outer Isles Expedition',
    giver: 'honest_jim',
    regionId: 'beginnings',
    steps: [
      { kind: 'explore', target: 'forgotten', need: 1, label: 'Reach the outer isles (the Forgotten shore)' },
      { kind: 'kill', target: 'tidehopper', need: 7, label: 'Spear 7 tidehoppers' },
      { kind: 'collect', target: 'fish_raw', need: 10, label: 'Fill the barrel with 10 fish' },
    ],
    rewards: { xp: { fishing: 440 }, items: [{ id: 'fish_salmon', qty: 6 }, { id: 'food_jerky', qty: 3 }], blockCents: 75 },
    intro:
      "They call it the outer isles because 'the edge of nowhere, go die there' doesn't fit on a signpost. The fishing's incredible if the tidehoppers don't steal your catch and your morale. Spear seven, fill a barrel, come home smelling like legend and low tide.",
    outro:
      "You reached the isles, speared the hoppers, and filled the barrel — a fisherman's holy trinity. Tidehoppers are what happen when a frog gives up on legs and commits to spite. You committed harder. Welcome back, you salty disaster.",
  },
  {
    id: 'q_wild_harvest_14',
    title: 'Brine and Punishment',
    giver: 'honest_jim',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'brinebat', need: 9, label: 'Knock down 9 brinebats' },
      { kind: 'kill', target: 'pufferpup', need: 6, label: 'Deflate 6 pufferpups' },
      { kind: 'gather', target: 'fishing_spot', need: 12, label: 'Fish the isle lagoons (12)' },
    ],
    rewards: { xp: { fishing: 480, attack: 160 }, items: [{ id: 'fish_salmon', qty: 8 }], blockCents: 85 },
    intro:
      "Brinebats dive-bomb your bait and pufferpups inflate into spiky beachballs of contempt the second you reach for them. Deal with nine bats, six pups, then actually get some fishing done between the assaults. The lagoon's generous if you survive its welcoming committee.",
    outro:
      "Nine bats, six deflated pups, twelve pools fished. A pufferpup is nature's way of saying 'this cute thing will absolutely ruin your hand'. You learned the lesson and the lagoon anyway. Eight salmon says it was worth it.",
  },
  {
    id: 'q_wild_harvest_15',
    title: 'Kraken On',
    giver: 'prospector_finn',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'krakenling', need: 3, label: 'Harpoon 3 krakenlings' },
      { kind: 'kill', target: 'seaserpent', need: 1, label: 'Land the sea serpent (good luck)' },
    ],
    rewards: { xp: { fishing: 620, attack: 300 }, items: [{ id: 'fish_salmon', qty: 10 }, { id: 'crystal_shard', qty: 2 }], blockCents: 120 },
    intro:
      "Every fisherman has a story about the one that got away. Mine has eight arms and lives in the deep channel with its three krakenling kids and a full-grown sea serpent for a roommate. Harpoon the little ones, then land the serpent. Then we'll finally have a story that ends well.",
    outro:
      "Three krakenlings and a sea serpent, hauled out of the deep channel by one person and a lot of leverage. The story finally ends well — for us. Not the serpent. The serpent's story ends in a very large frying pan. Poetic, really.",
  },
  {
    id: 'q_wild_harvest_16',
    title: 'Master of the Tackle Box',
    giver: 'honest_jim',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'tidewraith', need: 2, label: 'Banish 2 tidewraiths' },
      { kind: 'collect', target: 'fish_salmon', need: 14, label: 'Deliver a master haul: 14 salmon' },
      { kind: 'collect', target: 'fish_trout', need: 14, label: 'Deliver a master haul: 14 trout' },
    ],
    rewards: { xp: { fishing: 900 }, items: [{ id: 'food_pie', qty: 3 }, { id: 'crystal_cut', qty: 2 }], blockCents: 180 },
    intro:
      "Final exam. A tidewraith is a drowned fisherman who never learned to let go, and two of them haunt the best waters out of pure professional jealousy. Banish them, then out-fish their memory: fourteen salmon, fourteen trout. Prove you're better at this than the dead are bitter.",
    outro:
      "Two tidewraiths at peace, twenty-eight fish on ice. You out-fished the drowned and the bitter both. There's no higher title in this trade than 'the one the sea stopped arguing with'. That's you now. Go home. The water finally respects you.",
  },

  // ═══════════════════════════ FARMING ═══════════════════════════
  // Farmer Bram's never-ending backache — chained
  {
    id: 'q_wild_harvest_17',
    title: 'Sow What',
    giver: 'farmer_bram',
    regionId: 'beginnings',
    steps: [{ kind: 'gather', target: 'farm_plot', need: 10, label: 'Work 10 farm plots' }],
    rewards: { xp: { farming: 150 }, items: [{ id: 'wheat', qty: 8 }] },
    intro:
      "Farming's easy, they said. You just put a seed in dirt and wait, they said. 'They' have never had a crow steal the seed, a rabbit eat the sprout, and a cloud personally insult the harvest. Work ten plots. Welcome to the argument with the sky.",
    outro:
      "Ten plots worked, eight wheat in the bin, zero thanks from the sky. That's farming: backbreaking labor, a harvest, and the weather watching you fail with its arms crossed. You did good. The clouds disagree. Ignore the clouds.",
  },
  {
    id: 'q_wild_harvest_18',
    title: 'Berry the Hatchet',
    giver: 'farmer_bram',
    regionId: 'beginnings',
    steps: [
      { kind: 'gather', target: 'berry_bush', need: 12, label: 'Pick 12 berry bushes' },
      { kind: 'collect', target: 'berry_red', need: 8, label: 'Fill a crate with 8 red berries' },
    ],
    rewards: { xp: { farming: 240 }, items: [{ id: 'berry_red', qty: 10 }, { id: 'food_jelly', qty: 2 }], blockCents: 30 },
    intro:
      "The bushes are heavy and the birds are circling like they've got a reservation. Pick twelve, crate eight, and move fast — nature's freeloaders strip a bush bare in the time it takes me to complain about it, which is admittedly a while.",
    outro:
      "Twelve bushes, eight crated, birds thoroughly denied. Red fingers, full crates, and jelly in your future. The freeloaders are furious and that, honestly, is the sweetest part of the harvest. Spite tastes like preserves.",
  },
  {
    id: 'q_wild_harvest_19',
    title: 'Scare Tactics',
    giver: 'farmer_bram',
    regionId: 'beginnings',
    steps: [
      { kind: 'kill', target: 'crag_ram', need: 5, label: 'Chase off 5 crag rams' },
      { kind: 'kill', target: 'savanna_hyena', need: 6, label: 'See off 6 savanna hyenas' },
    ],
    rewards: { xp: { attack: 160, farming: 100 }, items: [{ id: 'hide_tough', qty: 3 }, { id: 'food_jerky', qty: 2 }], blockCents: 35 },
    intro:
      "My scarecrow scares nobody. The crag rams headbutt it for sport and the hyenas LAUGH — actual, audible laughing, at my scarecrow, on my land. Five rams, six hyenas. Teach the field a new attitude. The scarecrow will thank you by continuing to do nothing.",
    outro:
      "Five rams, six hyenas, and the laughing has stopped. The field's respectful now, or at least frightened, which in agriculture is the same thing. The scarecrow takes full credit. It always does. I let it. It's got nothing else.",
  },
  {
    id: 'q_wild_harvest_20',
    title: 'The Whole Field and Then Some',
    giver: 'farmer_bram',
    regionId: 'beginnings',
    steps: [
      { kind: 'gather', target: 'farm_plot', need: 18, label: 'Work 18 farm plots' },
      { kind: 'collect', target: 'wheat', need: 12, label: 'Barn 12 wheat' },
    ],
    rewards: { xp: { farming: 420 }, items: [{ id: 'wheat', qty: 10 }, { id: 'food_pie', qty: 2 }], blockCents: 60 },
    intro:
      "Harvest season, and my back has filed for divorce. Eighteen plots and twelve wheat in the barn before the first frost turns the whole lot to disappointment. Do it and I'll bake you a pie from your own grain, which is either a reward or a warning.",
    outro:
      "Eighteen plots, twelve wheat, one pie baked from grain you grew with your own two ruined hands. It's the reward AND the warning — delicious, and also a preview of every harvest for the rest of your life. Eat up, you magnificent sucker.",
  },
  {
    id: 'q_wild_harvest_21',
    title: 'Clay Today, Gone Tomorrow',
    giver: 'farmer_bram',
    regionId: 'beginnings',
    steps: [
      { kind: 'gather', target: 'clay_pit', need: 10, label: 'Dig 10 clay pits' },
      { kind: 'collect', target: 'clay_lump', need: 8, label: 'Haul 8 clay lumps' },
    ],
    rewards: { xp: { farming: 200, mining: 80 }, items: [{ id: 'clay_lump', qty: 10 }], blockCents: 30 },
    intro:
      "Before you plant, you need pots, and before pots you need clay, and before clay you need to get filthy in a way that outlasts several baths. Dig ten pits, haul eight lumps. It's humble work. It's also most of what farming actually is. Nobody tells you that part.",
    outro:
      "Ten pits, eight lumps, one farmhand caked in enough mud to start a second, smaller farm. The potter's thrilled, your laundry is a lost cause, and the pots will outlive everyone here. Honest work. Filthy, honest work.",
  },
  {
    id: 'q_wild_harvest_22',
    title: 'Fawn Over This',
    giver: 'elder_rowan',
    regionId: 'beginnings',
    steps: [
      { kind: 'kill', target: 'meadow_fawn', need: 8, label: 'Cull 8 meadow fawns from the croplands' },
      { kind: 'gather', target: 'berry_bush', need: 10, label: 'Rescue 10 berry bushes' },
    ],
    rewards: { xp: { farming: 300, attack: 120 }, items: [{ id: 'berry_red', qty: 8 }, { id: 'hide_wolf', qty: 3 }], blockCents: 45 },
    intro:
      "The meadow fawns found the berry rows and now the croplands are a buffet with legs. Eight fawns, then save what's left of ten bushes. I know they look like painted innocence. So does a bill you can't pay, and this is one of those with hooves.",
    outro:
      "Eight fawns relocated to the food chain's lower shelf, ten bushes saved. The croplands are ours again. A fawn is adorable right up until it's eaten your livelihood, and then it's dinner. Circle of agriculture. Nobody said it was pretty.",
  },
  {
    id: 'q_wild_harvest_23',
    title: 'Grain Expectations',
    giver: 'farmer_bram',
    regionId: 'beginnings',
    steps: [
      { kind: 'gather', target: 'farm_plot', need: 24, label: 'Work 24 plots for the great harvest' },
      { kind: 'collect', target: 'wheat', need: 16, label: 'Barn 16 wheat' },
      { kind: 'collect', target: 'berry_red', need: 12, label: 'Crate 12 red berries' },
    ],
    rewards: { xp: { farming: 720 }, items: [{ id: 'food_pie', qty: 3 }, { id: 'food_jelly', qty: 3 }], blockCents: 150 },
    intro:
      "The great harvest. The one that decides whether the village eats or 'experiences a character-building winter'. Twenty-four plots, sixteen wheat, twelve berries. My back can't, my knees won't, and my sons 'found themselves' in the city. It's you. It's all you. No pressure. Total pressure.",
    outro:
      "Twenty-four plots, sixteen wheat, twelve berries — the great harvest, brought in by one person who will never fully straighten up again. The village eats. Winter is survivable. You're a hero, which pays in pie and spinal damage. Mostly spinal damage. Some pie.",
  },

  // ═══════════════════════════ HERBALISM ═══════════════════════════
  // Herbalist Moss & Mage Lyra — chained
  {
    id: 'q_wild_harvest_24',
    title: 'Weed Em and Reap',
    giver: 'herbalist_moss',
    regionId: 'greenwood',
    steps: [{ kind: 'gather', target: 'herb_patch', need: 10, label: 'Gather 10 herb patches' }],
    rewards: { xp: { herbalism: 150 }, items: [{ id: 'herb_green', qty: 8 }] },
    intro:
      "A weed is just a plant with bad PR. Gather ten green-herb patches. Rule one: everything out here is medicine. Rule two: half of it is medicine for the specific condition of 'being alive', if you follow me. Don't chew anything. Ever. Especially not to show off.",
    outro:
      "Ten patches, and your mouth stayed shut the whole time, which puts you ahead of my last three apprentices — two of whom are fine, and one of whom now communicates exclusively in colors. You've got the touch. Keep it pointed at the plants.",
  },
  {
    id: 'q_wild_harvest_25',
    title: 'Fungus Among Us',
    giver: 'herbalist_moss',
    regionId: 'greenwood',
    steps: [
      { kind: 'gather', target: 'mushroom_cluster', need: 12, label: 'Pick 12 mushroom clusters' },
      { kind: 'kill', target: 'mushroom', need: 8, label: 'Stomp 8 shroomlings that fight back' },
    ],
    rewards: { xp: { herbalism: 260, attack: 90 }, items: [{ id: 'mushroom_brown', qty: 8 }], blockCents: 30 },
    intro:
      "Some mushrooms you pick. Some mushrooms pick a fight. The clusters are polite — twelve of those. The shroomlings are angry fungus with a grudge and feet — stomp eight of those. Learn the difference early; the lesson for getting it wrong is delivered by an undertaker.",
    outro:
      "Twelve clusters picked, eight shroomlings stomped, zero getting-it-wrong. A shroomling is what happens when a mushroom reads about ambition. You un-ambitioned eight of them. The brown mushrooms are dinner. The shroomlings are a warning to the others.",
  },
  {
    id: 'q_wild_harvest_26',
    title: 'Red Right Hand',
    giver: 'herbalist_moss',
    regionId: 'greenwood',
    steps: [
      { kind: 'collect', target: 'herb_red', need: 8, label: 'Gather 8 red herbs' },
      { kind: 'kill', target: 'spider_recluse', need: 5, label: 'Clear 5 recluse spiders from the patch' },
    ],
    rewards: { xp: { herbalism: 320, attack: 120 }, items: [{ id: 'herb_red', qty: 8 }, { id: 'potion_regret', qty: 1 }], blockCents: 40 },
    intro:
      "The red herb grows where it shouldn't — in the shade of the recluse spiders, who are shy, venomous, and deeply opposed to you touching their shade. Eight herbs, five spiders. Wear gloves. Wear boots. Wear an expression of mild regret; it suits the work.",
    outro:
      "Eight red herbs, five recluses evicted from their shade. A recluse spider wants to be left alone almost as much as it wants to kill you, and those two desires are in constant tension. You resolved the tension. With a boot. Here's a potion of regret. On theme.",
  },
  {
    id: 'q_wild_harvest_27',
    title: 'The Blue Hour',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [
      { kind: 'collect', target: 'herb_blue', need: 10, label: 'Harvest 10 blue herbs at dusk' },
      { kind: 'kill', target: 'wisp', need: 6, label: 'Disperse 6 grave wisps guarding the blooms' },
    ],
    rewards: { xp: { herbalism: 400, magic: 100 }, items: [{ id: 'herb_blue', qty: 8 }, { id: 'crystal_raw', qty: 3 }], blockCents: 55 },
    intro:
      "The blue herb only shows its true color at dusk, which is also, inconveniently, when the grave wisps come out to resent the living. Ten herbs, six wisps. Beautiful work, genuinely — the kind of errand poets write about and then die of, usually from the wisps.",
    outro:
      "Ten blue herbs at the exact blue hour, six wisps dispersed into harmless sparkle. It's the stuff of poetry and you did it without becoming a cautionary stanza. The herbs are potent, the night is yours, and the wisps have filed a complaint with an authority that does not exist.",
  },
  {
    id: 'q_wild_harvest_28',
    title: 'Gold Standard',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [
      { kind: 'collect', target: 'herb_gold', need: 6, label: 'Find 6 gold herbs' },
      { kind: 'explore', target: 'ashen', need: 1, label: 'Search the ashen reaches for rare blooms' },
    ],
    rewards: { xp: { herbalism: 480 }, items: [{ id: 'herb_gold', qty: 6 }, { id: 'food_honey', qty: 2 }], blockCents: 70 },
    intro:
      "The gold herb is the rarest of all — it grows one bloom per season, in the worst possible places, out of what I can only assume is spite. Six of them, and you'll have to walk the ashen reaches to find them. Pack water. Pack patience. The herb respects neither but demands both.",
    outro:
      "Six gold herbs from the ashen reaches, each one worth its weight in the other kind of gold. You walked through ash and spite and came back with the rarest leaf in the realm. The herb still respects nothing. But I respect you, which is rarer than the herb.",
  },
  {
    id: 'q_wild_harvest_29',
    title: 'Grave Matters',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'deathmoth_pale', need: 8, label: 'Net 8 pale deathmoths' },
      { kind: 'gather', target: 'herb_patch', need: 10, label: 'Gather 10 grave-herb patches' },
    ],
    rewards: { xp: { herbalism: 440, attack: 140 }, items: [{ id: 'herb_green', qty: 6 }, { id: 'herb_red', qty: 4 }], blockCents: 60 },
    intro:
      "The best herbs grow in graveyards. Rich soil — don't ask why, you've met the clientele. The pale deathmoths eat the blooms before I can harvest them, the gluttons. Net eight moths, gather ten patches. Gerald will supervise. Gerald supervises everything. Gerald is a skull. Don't question it.",
    outro:
      "Eight deathmoths netted, ten patches gathered under Gerald's watchful... sockets. The graveyard grows the finest herbs in the realm precisely because nobody wants to garden here but us. The moths disagreed with our business model. The moths lost. Lovely work.",
  },
  {
    id: 'q_wild_harvest_30',
    title: 'The Master Herbalist',
    giver: 'herbalist_moss',
    regionId: 'greenwood',
    steps: [
      { kind: 'collect', target: 'herb_green', need: 12, label: 'Deliver 12 green herbs' },
      { kind: 'collect', target: 'herb_red', need: 10, label: 'Deliver 10 red herbs' },
      { kind: 'collect', target: 'herb_blue', need: 8, label: 'Deliver 8 blue herbs' },
      { kind: 'collect', target: 'herb_gold', need: 4, label: 'Deliver 4 gold herbs' },
    ],
    rewards: { xp: { herbalism: 820 }, items: [{ id: 'food_honey', qty: 3 }, { id: 'crystal_cut', qty: 2 }], blockCents: 170 },
    intro:
      "The final test. A master herbalist can bring me all four herbs — green, red, blue, gold — in one trip, in season, without poisoning themselves, their mule, or the reputation of this profession. Twelve, ten, eight, four. Bring the rainbow. Keep your mouth shut around all of it.",
    outro:
      "Green, red, blue, gold — the full spectrum, in one trip, mouth admirably shut throughout. You're a master herbalist now, which means you know exactly how many plants out there can kill you, which is 'most'. Ignorance was more relaxing. Mastery pays better. Congratulations, probably.",
  },

  // ═══════════════════════════ COOKING ═══════════════════════════
  // Maestro Ribbert's kitchen — chained
  {
    id: 'q_wild_harvest_31',
    title: 'Too Many Cooks',
    giver: 'maestro_ribbert',
    regionId: 'capital',
    steps: [{ kind: 'collect', target: 'food_jerky', need: 6, label: 'Cure 6 strips of jerky' }],
    rewards: { xp: { cooking: 160 }, items: [{ id: 'food_jerky', qty: 4 }] },
    intro:
      "We start you at the bottom: jerky. It's meat that gave up and became leather you're allowed to eat. Cure six strips. If you can't dry meat without ruining it, you've no business near anything that requires an opinion, like a sauce. Prove the meat first.",
    outro:
      "Six strips, correctly cured — chewy, salty, and unlikely to kill anyone, which is the whole bar for jerky. You've proven the meat. Next we'll let you near a flame that matters. Try not to make me regret this. Everyone does, eventually.",
  },
  {
    id: 'q_wild_harvest_32',
    title: 'Souse Chef',
    giver: 'maestro_ribbert',
    regionId: 'capital',
    steps: [
      { kind: 'collect', target: 'fish_trout', need: 8, label: 'Source 8 trout' },
      { kind: 'collect', target: 'food_jelly', need: 4, label: 'Set 4 jars of jelly' },
    ],
    rewards: { xp: { cooking: 260 }, items: [{ id: 'food_jelly', qty: 4 }], blockCents: 35 },
    intro:
      "A real cook makes the sweet and the savory and doesn't flinch when I ask for both before noon. Eight trout and four jars of jelly. One's dinner, one's dessert, and if you confuse them I will know, the diners will know, and the trout will haunt the jelly forever.",
    outro:
      "Eight trout, four jars of jelly, and you kept them in separate conceptual universes, thank the stove. Sweet is sweet, savory is savory, and the natural order holds for another service. You're less of a disaster than yesterday. In this kitchen, that's a promotion.",
  },
  {
    id: 'q_wild_harvest_33',
    title: 'Game On',
    giver: 'maestro_ribbert',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'horned_stag', need: 4, label: 'Source venison from 4 horned stags' },
      { kind: 'kill', target: 'dire_boar', need: 3, label: 'Source pork from 3 dire boars' },
    ],
    rewards: { xp: { cooking: 300, attack: 160 }, items: [{ id: 'food_jerky', qty: 4 }, { id: 'hide_boar', qty: 3 }], blockCents: 45 },
    intro:
      "The gala menu calls for game, and game, inconveniently, is still out there being alive and having opinions. Four horned stags, three dire boars. A cook who can't source their own meat is just a person who reheats things. Go. Introduce yourself to dinner.",
    outro:
      "Four stags, three boars, a cold-room full of the finest game in the capital. The nobles will eat it, praise it, and never once imagine you wrestling a dire boar for the privilege. That's cooking: all the violence, none of the credit, excellent jerky.",
  },
  {
    id: 'q_wild_harvest_34',
    title: 'Pie Hard',
    giver: 'maestro_ribbert',
    regionId: 'capital',
    steps: [
      { kind: 'collect', target: 'food_pie', need: 6, label: 'Bake 6 pies' },
      { kind: 'collect', target: 'wheat', need: 10, label: 'Mill flour from 10 wheat' },
    ],
    rewards: { xp: { cooking: 360 }, items: [{ id: 'food_pie', qty: 4 }, { id: 'food_honey', qty: 2 }], blockCents: 55 },
    intro:
      "A pie is a sealed promise. Break the crust and you keep the promise; burn the crust and you've lied to everyone at the table. Six pies, and mill your own flour from ten wheat because store-bought flour is for people who've given up on themselves. Bake me the truth.",
    outro:
      "Six pies, flaky and honest, flour milled by your own hand. Every crust kept its promise. The diners don't know what milling is and never will, but you do now, and that's the quiet dignity of the profession: knowing. And pie. Mostly pie.",
  },
  {
    id: 'q_wild_harvest_35',
    title: 'Honey, I Harvested the Hive',
    giver: 'maestro_ribbert',
    regionId: 'greenwood',
    steps: [
      { kind: 'kill', target: 'wasp_hornet', need: 8, label: 'Smoke out 8 hornets' },
      { kind: 'collect', target: 'food_honey', need: 4, label: 'Harvest 4 combs of honey' },
    ],
    rewards: { xp: { cooking: 340, attack: 120 }, items: [{ id: 'food_honey', qty: 6 }], blockCents: 50 },
    intro:
      "The pastry section needs honey, and honey, cruelly, comes guarded by hornets the size of your thumb and twice as judgmental. Smoke out eight, harvest four combs. Every spoonful of sweetness in this world is defended by something that wants to sting you. Cooking is just courage with a whisk.",
    outro:
      "Eight hornets smoked, four combs of pure gold harvested, and you were stung no more than the professionally acceptable amount. Sweetness, earned through suffering, as all sweetness is. The pastries will be divine. You will itch for a week. Fair trade.",
  },
  {
    id: 'q_wild_harvest_36',
    title: 'Catch of the Day, Served Cold',
    giver: 'maestro_ribbert',
    regionId: 'capital',
    steps: [
      { kind: 'collect', target: 'fish_salmon', need: 10, label: 'Source 10 salmon' },
      { kind: 'kill', target: 'coralgolem', need: 2, label: 'Harvest garnish-crystal from 2 coral golems' },
    ],
    rewards: { xp: { cooking: 440, attack: 200 }, items: [{ id: 'fish_salmon', qty: 6 }, { id: 'crystal_shard', qty: 3 }], blockCents: 65 },
    intro:
      "For the seafood tower I need ten pristine salmon and — don't laugh — crystal shards off a coral golem to garnish the ice. Yes, I garnish with minerals now. The critics called my plating 'timid'. Two coral golems and the critics will eat those words. Literally. I'll bake the words in.",
    outro:
      "Ten salmon and crystal garnish from two coral golems, who did not want to become plating and said so, loudly, with coral. The tower will glitter, the critics will weep, and 'timid' will never be aimed at my ice sculptures again. You cooked, and mined, and that's the future of fine dining.",
  },
  {
    id: 'q_wild_harvest_37',
    title: 'The Grand Banquet',
    giver: 'maestro_ribbert',
    regionId: 'capital',
    steps: [
      { kind: 'collect', target: 'food_pie', need: 8, label: 'Bake 8 pies for the banquet' },
      { kind: 'collect', target: 'food_cake', need: 4, label: 'Bake 4 cakes' },
      { kind: 'collect', target: 'food_honey', need: 6, label: 'Glaze with 6 honey' },
    ],
    rewards: { xp: { cooking: 900 }, items: [{ id: 'food_cake', qty: 3 }, { id: 'crystal_cut', qty: 2 }], blockCents: 190 },
    intro:
      "The royal banquet. The kitchen's entire reputation on one night, one menu, one impossible deadline. Eight pies, four cakes, six honey to glaze the lot. The kitchen staff quit — again, they do it for the drama. It's you, me, and the ovens against the entire nobility. Cook like our lives depend on it. They might.",
    outro:
      "Eight pies, four cakes, six honey glazes — a banquet that silenced a room full of people who exist to complain. The nobles ate until they forgot to be cruel. That's the highest cooking there is: feeding monsters until they're briefly human. You're a maestro now. Weep later. Plate now.",
  },

  // ═══════════════════════════ ALCHEMY ═══════════════════════════
  // The brewers' circle — chained
  {
    id: 'q_wild_harvest_38',
    title: 'Snake Oil Salesman',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [
      { kind: 'collect', target: 'herb_green', need: 8, label: 'Gather 8 green herbs' },
      { kind: 'collect', target: 'herb_red', need: 6, label: 'Gather 6 red herbs' },
    ],
    rewards: { xp: { alchemy: 170, herbalism: 60 }, items: [{ id: 'herb_green', qty: 4 }, { id: 'herb_red', qty: 4 }] },
    intro:
      "Alchemy begins where cooking ends and the smell gets worse. First you gather: eight green, six red. You can't brew a cure without the ingredients, and you can't bluff your way past a bubbling cauldron the way you can a dinner guest. The cauldron knows. Go pick.",
    outro:
      "Eight green, six red, and your eyebrows still fully present, which is more than I can say for most first days. The ingredients are good. Now comes the part where things bubble, change color, and occasionally lie to you. Alchemy. It's chemistry with trust issues.",
  },
  {
    id: 'q_wild_harvest_39',
    title: 'Better Living Through Spite',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [{ kind: 'collect', target: 'potion_regret', need: 5, label: 'Distill 5 potions of regret' }],
    rewards: { xp: { alchemy: 320 }, items: [{ id: 'potion_regret', qty: 3 }], blockCents: 45 },
    intro:
      "Your first brew: the potion of regret. It does exactly what it says, which is more honesty than most potions offer. Distill five. Get the ratio wrong and it only causes mild disappointment, which is, ironically, something to regret. Full-strength or nothing.",
    outro:
      "Five potions of regret, full-strength, each one a tiny bottled lifetime of 'I shouldn't have'. Beautifully bitter. You've got the alchemist's gift: making the feelings everyone avoids, on purpose, for money. The circle welcomes you. We're a cheerful bunch, can't you tell.",
  },
  {
    id: 'q_wild_harvest_40',
    title: 'Crystal Clear',
    giver: 'mage_lyra',
    regionId: 'ironhold',
    steps: [
      { kind: 'gather', target: 'crystal_node', need: 6, label: 'Harvest 6 crystal nodes' },
      { kind: 'kill', target: 'crystal_sentinel', need: 3, label: 'Shatter 3 crystal sentinels' },
    ],
    rewards: { xp: { alchemy: 400, mining: 120 }, items: [{ id: 'crystal_raw', qty: 6 }, { id: 'crystal_shard', qty: 2 }], blockCents: 60 },
    intro:
      "The potent brews need crystal, and the best crystal is guarded by crystal sentinels — animate grudges made of the exact thing you came to steal. Six nodes, three sentinels. There's a poetry to killing a diamond for its diamonds. Don't dwell on it. Dwelling is how alchemists go strange.",
    outro:
      "Six nodes harvested, three sentinels shattered into the very shards you needed, which is efficient and a little sad. The crystal's pure and the poetry writes itself. You didn't dwell. Good. The ones who dwell end up talking to their cauldrons. The cauldrons, worryingly, answer.",
  },
  {
    id: 'q_wild_harvest_41',
    title: 'Elemental, My Dear',
    giver: 'prophet_karl',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'mote_cinder', need: 8, label: 'Capture essence from 8 cinder motes' },
      { kind: 'kill', target: 'mote_frost', need: 8, label: 'Capture essence from 8 frost motes' },
    ],
    rewards: { xp: { alchemy: 440, magic: 100 }, items: [{ id: 'crystal_shard', qty: 3 }, { id: 'potion_regret', qty: 1 }], blockCents: 65 },
    intro:
      "True alchemy balances fire and ice, which sounds poetic until you realize it means fighting eight cinder motes that set you alight and eight frost motes that put you out the hard way. Capture the essence of both. Hot, then cold, then hot again. It's a spa day, if the spa hated you.",
    outro:
      "Eight cinder motes, eight frost motes, their essences bottled and balanced. You've been burned and frozen in the same afternoon and lived to label the vials. That's the alchemist's equilibrium: equally miserable in both directions. The brews will be exquisite. You will never be warm or cool again.",
  },
  {
    id: 'q_wild_harvest_42',
    title: "The Philosopher's Scone",
    giver: 'prophet_karl',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'elem_flame', need: 4, label: 'Render 4 flame elementals' },
      { kind: 'kill', target: 'elem_frost', need: 4, label: 'Render 4 frost elementals' },
      { kind: 'collect', target: 'crystal_cut', need: 4, label: 'Refine 4 cut crystals' },
    ],
    rewards: { xp: { alchemy: 620, magic: 180 }, items: [{ id: 'crystal_cut', qty: 4 }, { id: 'food_honey', qty: 2 }], blockCents: 90 },
    intro:
      "The elementals are the motes' grown-up, furious cousins — a flame elemental is a bonfire with a grudge and a frost elemental is a blizzard that remembers your name. Render four of each and refine four crystals. For what? A transmutation so advanced I've legally agreed not to describe it near windows.",
    outro:
      "Four flame, four frost, four crystals refined — the makings of a transmutation I still can't describe near glass. You rendered elementals into reagents, which is the alchemical equivalent of arguing a thunderstorm into a teapot. The circle is impressed. The circle is rarely impressed. Mostly it's on fire.",
  },
  {
    id: 'q_wild_harvest_43',
    title: 'Mana From Heaven',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'mote_spark', need: 10, label: 'Bottle 10 spark motes' },
      { kind: 'kill', target: 'elem_storm', need: 3, label: 'Render 3 storm elementals' },
    ],
    rewards: { xp: { alchemy: 560, magic: 220 }, items: [{ id: 'crystal_raw', qty: 5 }, { id: 'crystal_shard', qty: 2 }], blockCents: 80 },
    intro:
      "Mana potions need raw charge, and raw charge means catching lightning — ten spark motes, which shock you, and three storm elementals, which shock you more and feel smug about it. Bottle the lot. Your hair will stand up for a week. Consider it a free, terrible hairstyle.",
    outro:
      "Ten spark motes bottled, three storm elementals rendered down to pure charge. You caught lightning in a jar, repeatedly, and your hair has achieved a permanent state of alarm. The mana brews will be electric. So, currently, are you. Don't touch the doorknob. Don't touch anyone you like.",
  },
  {
    id: 'q_wild_harvest_44',
    title: 'The Grand Panacea',
    giver: 'prophet_karl',
    regionId: 'ashen',
    steps: [
      { kind: 'collect', target: 'herb_gold', need: 8, label: 'Gather 8 gold herbs' },
      { kind: 'collect', target: 'crystal_cut', need: 6, label: 'Refine 6 cut crystals' },
      { kind: 'kill', target: 'elem_void', need: 2, label: 'Bind 2 void elementals' },
    ],
    rewards: { xp: { alchemy: 940, herbalism: 160, magic: 200 }, items: [{ id: 'crystal_cut', qty: 3 }, { id: 'food_honey', qty: 3 }], blockCents: 220 },
    intro:
      "They say every alchemist brews one true panacea — the cure for everything — and spends the rest of their life failing to repeat it. For it you need gold herb, cut crystal, and the essence of a void elemental, which is a hole in reality that resents being asked for anything. Eight, six, two. Brew the impossible. Then be unbearable about it forever.",
    outro:
      "Eight gold herbs, six crystals, two void elementals bound against their nonexistent wills — and from them, the panacea. The cure for everything, glowing like it knows the secret of the world and isn't telling. You did the thing alchemists chase to their graves. Now go be insufferably humble about it until yours.",
  },

  // ═══════════════════════════ MINING SUPPORT CHAIN ═══════════════════════════
  {
    id: 'q_wild_harvest_45',
    title: 'Copper Bottom Line',
    giver: 'foreman_dagna',
    regionId: 'ironhold',
    steps: [
      { kind: 'gather', target: 'copper_vein', need: 10, label: 'Mine 10 copper veins' },
      { kind: 'kill', target: 'shard_crawler', need: 6, label: 'Clear 6 shard crawlers from the shaft' },
    ],
    rewards: { xp: { mining: 200, attack: 100 }, items: [{ id: 'ore_copper', qty: 8 }, { id: 'bar_copper', qty: 2 }], blockCents: 40 },
    intro:
      "Copper's the bottom rung and the shaft's full of shard crawlers — little crystal centipedes that chew the ore before we can. Ten veins, six crawlers. Nobody dreams of mining copper, but everybody dreams on a bed someone bought with copper money. Swing the pick.",
    outro:
      "Ten veins, six crawlers, a cart of honest copper. It's not glamorous — nothing down here is — but it's the metal that quietly holds the whole kingdom together. You pulled it out of the dark. The crawlers held a grudge. The crawlers are now gravel. Good start.",
  },
  {
    id: 'q_wild_harvest_46',
    title: 'Iron Will',
    giver: 'foreman_dagna',
    regionId: 'ironhold',
    steps: [
      { kind: 'gather', target: 'iron_vein', need: 12, label: 'Mine 12 iron veins' },
      { kind: 'kill', target: 'gearhound', need: 5, label: 'Scrap 5 gearhounds' },
    ],
    rewards: { xp: { mining: 340, attack: 140 }, items: [{ id: 'ore_iron', qty: 8 }, { id: 'bar_iron', qty: 2 }], blockCents: 55 },
    intro:
      "Iron's where mining stops being cute. Twelve veins, and watch for gearhounds — someone's old mining automatons gone feral, all teeth and loose bolts and a hatred of anyone with a working pickaxe. Scrap five. The quota waits for no one, least of all a rusty dog.",
    outro:
      "Twelve iron veins and five gearhounds parted out for scrap. The quota's met and the shaft's one feral automaton pack lighter. A gearhound's just a loyalty that outlived its owner and curdled. You put them down kindly. With a hammer. Kindness takes many forms down here.",
  },
  {
    id: 'q_wild_harvest_47',
    title: 'Going for Gold',
    giver: 'foreman_dagna',
    regionId: 'ironhold',
    steps: [
      { kind: 'gather', target: 'gold_vein', need: 8, label: 'Mine 8 gold veins' },
      { kind: 'kill', target: 'iron_warden', need: 3, label: 'Dismantle 3 iron wardens' },
    ],
    rewards: { xp: { mining: 480, attack: 220 }, items: [{ id: 'ore_gold', qty: 6 }, { id: 'bar_gold', qty: 1 }], blockCents: 90 },
    intro:
      "The gold seam runs behind the old vault doors, and the old vault doors come with iron wardens — big, patient, and under the lasting impression that the gold is theirs to guard forever. Eight veins, three wardens. Explain to them, with your pickaxe, that 'forever' ended today.",
    outro:
      "Eight gold veins and three iron wardens dismantled, their 'forever' concluded on schedule. The gold's ours, the wardens are parts, and the vault is finally just a hole with good news in it. Gold does strange things to people. You stayed sane and rich, which is the hard part.",
  },
  {
    id: 'q_wild_harvest_48',
    title: 'The Deep Seam',
    giver: 'foreman_dagna',
    regionId: 'ironhold',
    steps: [
      { kind: 'gather', target: 'crystal_node', need: 8, label: 'Harvest 8 deep crystal nodes' },
      { kind: 'kill', target: 'rune_colossus', need: 1, label: 'Topple the rune colossus' },
      { kind: 'collect', target: 'crystal_raw', need: 6, label: 'Haul out 6 raw crystals' },
    ],
    rewards: { xp: { mining: 820, attack: 400 }, items: [{ id: 'crystal_raw', qty: 8 }, { id: 'crystal_cut', qty: 2 }], blockCents: 180 },
    intro:
      "The deepest seam, the richest crystal, and the rune colossus that's been sleeping on top of it since before the kingdom had a name. Eight nodes, one colossus, six crystals hauled up. Wake it, best it, and the deep belongs to the miners. Lose, and the deep keeps you as a souvenir.",
    outro:
      "Eight nodes harvested, one rune colossus toppled, six raw crystals dragged into daylight that hasn't touched them in an age. The deepest seam is ours and the colossus is a very large, very quiet pile of ancient regret. You went to the bottom of everything and climbed back up rich. The deep remembers. The deep is also, now, deeply annoyed.",
  },

  // ═══════════════════════════ BLACKSMITHING CRAFT CHAIN ═══════════════════════════
  {
    id: 'q_wild_harvest_49',
    title: 'Strike One',
    giver: 'smith_orin',
    regionId: 'ironhold',
    steps: [
      { kind: 'collect', target: 'ore_copper', need: 8, label: 'Supply 8 copper ore' },
      { kind: 'collect', target: 'bar_copper', need: 5, label: 'Smelt 5 copper bars' },
    ],
    rewards: { xp: { blacksmithing: 180, mining: 60 }, items: [{ id: 'bar_copper', qty: 4 }] },
    intro:
      "Smithing, lesson one: the forge is hotter than hell and twice as judgmental. Bring eight copper ore, smelt five bars. Copper's forgiving, which is why we start you on it. Steel is not forgiving. Steel remembers. But that's a later, more painful conversation.",
    outro:
      "Five copper bars, poured clean, only lightly singed. Copper forgave your mistakes because copper is kind and you are new. Enjoy that kindness. The metals get meaner from here, same as everything else worth learning. Good first strike.",
  },
  {
    id: 'q_wild_harvest_50',
    title: 'Iron in the Fire',
    giver: 'smith_orin',
    regionId: 'ironhold',
    steps: [
      { kind: 'collect', target: 'ore_iron', need: 10, label: 'Supply 10 iron ore' },
      { kind: 'collect', target: 'bar_iron', need: 6, label: 'Smelt 6 iron bars' },
      { kind: 'kill', target: 'brass_sentry', need: 4, label: 'Salvage brass from 4 sentries' },
    ],
    rewards: { xp: { blacksmithing: 340, mining: 100 }, items: [{ id: 'bar_iron', qty: 4 }, { id: 'ore_iron', qty: 4 }], blockCents: 50 },
    intro:
      "Iron's where the forge stops being polite. Ten ore, six bars, and salvage brass off four brass sentries — defunct guards that'll reactivate the moment you reach for their alloy. Everything worth melting down would rather you didn't. That's metallurgy. That's also most relationships.",
    outro:
      "Ten ore, six iron bars, four sentries salvaged for their brass despite their strong objections. Iron doesn't forgive like copper — it tests you, and you passed, mostly unburned. The sentries tested you harder and failed. You're a smith now, provisionally. The forge will decide for sure later.",
  },
  {
    id: 'q_wild_harvest_51',
    title: 'The Steel Standard',
    giver: 'smith_orin',
    regionId: 'ironhold',
    steps: [
      { kind: 'collect', target: 'bar_iron', need: 8, label: 'Supply 8 iron bars' },
      { kind: 'collect', target: 'bar_steel', need: 5, label: 'Forge 5 steel bars' },
    ],
    rewards: { xp: { blacksmithing: 500, mining: 120 }, items: [{ id: 'bar_steel', qty: 3 }], blockCents: 70 },
    intro:
      "Steel is iron that suffered correctly. Eight iron bars folded into five of steel — heat, fold, hammer, curse, repeat. Get it right and you've made the metal that empires are built on. Get it wrong and you've made an expensive, embarrassing paperweight. Fold me the empire.",
    outro:
      "Five steel bars, folded true, humming with the particular smugness of metal that knows its own worth. You took iron and taught it to suffer into something greater, which is the whole trade in one sentence. Empires are built on this. Tonight, just a very good sword. Tomorrow, who knows.",
  },
  {
    id: 'q_wild_harvest_52',
    title: 'By Hammer and By Spite',
    giver: 'smith_orin',
    regionId: 'ironhold',
    steps: [
      { kind: 'collect', target: 'bar_steel', need: 8, label: 'Forge 8 steel bars' },
      { kind: 'collect', target: 'bar_gold', need: 4, label: 'Pour 4 gold bars' },
      { kind: 'kill', target: 'clockwork_knight', need: 2, label: 'Best 2 clockwork knights' },
    ],
    rewards: { xp: { blacksmithing: 880, attack: 300 }, items: [{ id: 'bar_steel', qty: 3 }, { id: 'bar_gold', qty: 2 }], blockCents: 190 },
    intro:
      "Mastersmith's test. Eight steel, four gold, and you'll best two clockwork knights to do it — the last mastersmith's finest work, now ticking around the forge with opinions about the succession. Beat his knights, pour his metals, inherit his hammer. The forge crowns the one who refuses to quit. Refuse harder than the knights.",
    outro:
      "Eight steel, four gold, two clockwork knights stopped mid-tick. You bested the last master's masterpieces and forged his metals in the same breath. The hammer's yours now, and with it the knowledge that mastery isn't talent — it's spite that outlasted the forge's every attempt to kill you. Wear the title. You bled for it. Literally. I saw.",
  },

  // ═══════════════════════════ MIXED GATHER + WILD KILLS (standalone) ═══════════════════════════
  {
    id: 'q_wild_harvest_53',
    title: 'Fox in the Henhouse',
    giver: 'elder_rowan',
    regionId: 'beginnings',
    steps: [
      { kind: 'kill', target: 'tundra_fox', need: 7, label: 'Chase off 7 tundra foxes' },
      { kind: 'gather', target: 'farm_plot', need: 8, label: 'Secure 8 farm plots' },
    ],
    rewards: { xp: { farming: 200, attack: 120 }, items: [{ id: 'hide_wolf', qty: 4 }, { id: 'food_jerky', qty: 2 }], blockCents: 35 },
    intro:
      "A tundra fox is a small orange opinion about who owns your chickens, and seven of them have strong opinions. Chase them off, then secure eight plots before they circle back with reinforcements and a grudge. Foxes don't forget. Neither do I, about the last henhouse.",
    outro:
      "Seven foxes discouraged, eight plots secured, chickens briefly safe. A tundra fox always comes back, which is why 'discouraged' is the best any farmer gets — total victory is a myth sold by people who've never met a fox. Still, a good day. Enjoy it before the foxes regroup.",
  },
  {
    id: 'q_wild_harvest_54',
    title: 'Lynx to the Past',
    giver: 'scout_wren',
    regionId: 'greenwood',
    steps: [
      { kind: 'kill', target: 'frost_lynx', need: 6, label: 'Hunt 6 frost lynxes' },
      { kind: 'collect', target: 'hide_tough', need: 5, label: 'Cure 5 tough hides' },
    ],
    rewards: { xp: { attack: 240, tailoring: 80 }, items: [{ id: 'hide_tough', qty: 6 }], blockCents: 45 },
    intro:
      "Winter's early and the frost lynxes came down with it, prowling the high trail in coats worth more than your boots. Six of them, five hides cured. They're beautiful, they're lethal, and they'll be warmer as a cloak than they ever were as a problem. Hunt accordingly.",
    outro:
      "Six frost lynxes hunted, five hides cured soft and warm. A frost lynx spends its whole life being the most dangerous beautiful thing on the mountain, and now it's a very fine cloak. The trail's safe. You're warm. Somewhere, a lynx's ancestors are furious. Let them be.",
  },
  {
    id: 'q_wild_harvest_55',
    title: 'Hogtied',
    giver: 'ranger_kael',
    regionId: 'greenwood',
    steps: [
      { kind: 'kill', target: 'pack_raptor', need: 8, label: 'Scatter 8 pack raptors' },
      { kind: 'kill', target: 'grizzled_bruin', need: 2, label: 'Face down 2 grizzled bruins' },
    ],
    rewards: { xp: { attack: 360, vitality: 120 }, items: [{ id: 'hide_boar', qty: 4 }, { id: 'food_jerky', qty: 3 }], blockCents: 60 },
    intro:
      "Pack raptors hunt in groups and think, which is eight problems that coordinate. And where there's prey there's a grizzled bruin — a bear so old and mean the forest named it twice. Scatter eight raptors, face two bruins. Bring a weapon and a plan. Bring a spare plan. Bring a will.",
    outro:
      "Eight raptors scattered, two bruins faced and finished. A pack raptor is clever right up until it isn't, and a grizzled bruin is unstoppable until something stops it, and that something was you. The deep wood respects a thing that outthinks the clever and outlasts the old. That's you now. Terrifying.",
  },
  {
    id: 'q_wild_harvest_56',
    title: 'Pride Goeth',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'savanna_lion', need: 4, label: 'Face down 4 savanna lions' },
      { kind: 'kill', target: 'shadow_panther', need: 3, label: 'Hunt 3 shadow panthers' },
    ],
    rewards: { xp: { attack: 420, defense: 160 }, items: [{ id: 'hide_tough', qty: 5 }, { id: 'potion_regret', qty: 1 }], blockCents: 70 },
    intro:
      "A pride of savanna lions moved onto my frontier and a shadow panther moved onto theirs, and now my yard is a nature documentary I did not subscribe to. Four lions, three panthers. I came out here for solitude, not a food chain. Thin the cast. All of it. Especially the narrator, if you find one.",
    outro:
      "Four lions, three panthers — the entire unwanted documentary, cancelled. The frontier's quiet again, which is the only review I ever wanted to give it. A shadow panther is darkness that learned to be hungry; you un-hungered it. Pride goeth before the fall, and these all went. Thank you. Now leave. Fondly.",
  },
  {
    id: 'q_wild_harvest_57',
    title: 'Bear Necessities',
    giver: 'inspector_flora',
    regionId: 'ironhold',
    steps: [
      { kind: 'kill', target: 'cave_bear', need: 3, label: 'Clear 3 cave bears from the mines' },
      { kind: 'gather', target: 'iron_vein', need: 10, label: 'Mine 10 iron veins' },
    ],
    rewards: { xp: { mining: 280, attack: 180 }, items: [{ id: 'ore_iron', qty: 8 }, { id: 'hide_tough', qty: 3 }], blockCents: 55 },
    intro:
      "Can't inspect a mine that's currently a bear's bedroom. Three cave bears have hibernated in shaft seven for so long the paperwork lists them as 'structural'. Clear them, then mine ten veins so I have a reason to have been down there. Bureaucracy requires an alibi. So does this trip.",
    outro:
      "Three cave bears evicted from their 'structural' nap and ten iron veins mined as cover. The inspection is complete, the paperwork is plausible, and shaft seven is once again a mine instead of a den. A cave bear sleeps through everything except an eviction notice delivered in person. You delivered. Loudly.",
  },
  {
    id: 'q_wild_harvest_58',
    title: "Hornet's Nest",
    giver: 'herbalist_moss',
    regionId: 'greenwood',
    steps: [
      { kind: 'kill', target: 'wasp_paper', need: 10, label: 'Clear 10 paper wasps' },
      { kind: 'gather', target: 'herb_patch', need: 8, label: 'Harvest 8 herb patches behind the nest' },
    ],
    rewards: { xp: { herbalism: 260, attack: 120 }, items: [{ id: 'herb_green', qty: 6 }, { id: 'food_honey', qty: 1 }], blockCents: 40 },
    intro:
      "The finest herb patch in Greenwood sits behind a paper wasp nest, because of course it does — nature guards its best gifts with its worst neighbors. Ten wasps, eight patches. You'll get stung. The herbs cure the sting. There's a horrible circularity to this job that I've stopped questioning.",
    outro:
      "Ten paper wasps cleared, eight patches harvested, and yes, you got stung, and yes, the herbs you just picked will fix it. The job cures the wound the job inflicts. I told you to stop questioning it. Here's some honey for the trouble. The wasps won't miss it. The wasps aren't missing much of anything now.",
  },
  {
    id: 'q_wild_harvest_59',
    title: 'Mantis Religiosa',
    giver: 'ranger_kael',
    regionId: 'greenwood',
    steps: [
      { kind: 'kill', target: 'mantis_blade', need: 6, label: 'Cut down 6 blade mantises' },
      { kind: 'kill', target: 'mantis_prayer', need: 4, label: 'Interrupt 4 praying mantises' },
    ],
    rewards: { xp: { attack: 300, archery: 100 }, items: [{ id: 'hide_tough', qty: 4 }, { id: 'potion_regret', qty: 1 }], blockCents: 50 },
    intro:
      "A blade mantis is a sword that grew legs and a grudge; a praying mantis just looks pious before it does the exact same thing. Six blades, four prayers. Don't be fooled by the praying — it's not asking forgiveness, it's measuring your neck. Six blades, four prayers, zero sympathy.",
    outro:
      "Six blade mantises cut down, four praying ones interrupted mid-devotion. Turns out they weren't praying for your soul, they were appraising it, and you appraised back harder. The grove's clear of walking cutlery. A mantis never begs. It only looks like it. You looked past the look. Well done.",
  },
  {
    id: 'q_wild_harvest_60',
    title: 'Scorpion Bowl',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'scorpion_sand', need: 8, label: 'Crush 8 sand scorpions' },
      { kind: 'kill', target: 'scorpion_emperor', need: 2, label: 'Dethrone 2 emperor scorpions' },
    ],
    rewards: { xp: { attack: 440, defense: 180 }, items: [{ id: 'hide_tough', qty: 4 }, { id: 'crystal_shard', qty: 2 }], blockCents: 75 },
    intro:
      "Sand scorpions infest the frontier dunes and the emperor scorpions rule them, which is a very grand title for 'a bigger bug that stings diplomatically'. Eight commoners, two emperors. Overthrow the monarchy. I'm a hermit; I have strong feelings about monarchies and bugs, and these are both.",
    outro:
      "Eight sand scorpions crushed, two emperors dethroned — a complete and satisfying regime change, entomologically speaking. The dunes are a republic now, or at least a vacancy. An emperor scorpion rules through venom and intimidation, right up until someone bigger has a boot and a grudge. That someone was you. Long live nobody.",
  },
  {
    id: 'q_wild_harvest_61',
    title: 'Dung and Dungeon',
    giver: 'farmer_bram',
    regionId: 'beginnings',
    steps: [
      { kind: 'kill', target: 'beetle_dung', need: 10, label: 'Squash 10 dung beetles' },
      { kind: 'kill', target: 'beetle_rhino', need: 4, label: 'Flip 4 rhino beetles' },
    ],
    rewards: { xp: { attack: 200, farming: 100 }, items: [{ id: 'clay_lump', qty: 6 }, { id: 'food_jerky', qty: 2 }], blockCents: 35 },
    intro:
      "Dung beetles rolled off with half my fertilizer — which, fine, it's their whole thing — but the rhino beetles are plowing my furrows into abstract art. Ten dung beetles, four rhinos. Yes, the fertilizer situation is as glamorous as farming gets. No, there is no cleaner job. This is the job.",
    outro:
      "Ten dung beetles squashed, four rhino beetles flipped and finished. The fertilizer stays, the furrows un-abstract themselves, and the field returns to the dignified business of growing food out of exactly what you'd rather not discuss. Farming: it's all about the dirt, and what's in the dirt, and not thinking too hard about the dirt.",
  },
  {
    id: 'q_wild_harvest_62',
    title: 'Centipede Surprise',
    giver: 'foreman_dagna',
    regionId: 'ironhold',
    steps: [
      { kind: 'kill', target: 'centipede_bog', need: 8, label: 'Clear 8 bog centipedes' },
      { kind: 'kill', target: 'centipede_chasm', need: 3, label: 'Clear 3 chasm centipedes' },
      { kind: 'gather', target: 'copper_vein', need: 8, label: 'Mine 8 copper veins' },
    ],
    rewards: { xp: { mining: 300, attack: 200 }, items: [{ id: 'ore_copper', qty: 8 }, { id: 'bar_copper', qty: 2 }], blockCents: 55 },
    intro:
      "The flooded lower shaft's gone to centipedes — bog ones up top, chasm ones in the dark where even the bog ones won't go, which should tell you something. Eight bog, three chasm, then mine eight copper veins while you're down there earning your nightmares. A chasm centipede has too many legs and all of them have opinions.",
    outro:
      "Eight bog centipedes, three chasm ones, eight copper veins — the lower shaft is reclaimed and your nightmares are fully stocked for the season. A chasm centipede is what the dark grows when nobody's checking, and you checked, violently. The copper's good. Don't count the legs you stepped on. Nobody counts the legs. That way lies madness.",
  },
  {
    id: 'q_wild_harvest_63',
    title: 'Web of Lies',
    giver: 'scout_wren',
    regionId: 'greenwood',
    steps: [
      { kind: 'kill', target: 'spider_funnel', need: 9, label: 'Burn out 9 funnel spiders' },
      { kind: 'gather', target: 'oak_tree', need: 10, label: 'Fell 10 oaks in the cleared grove' },
    ],
    rewards: { xp: { woodcutting: 280, attack: 160 }, items: [{ id: 'wood_oak', qty: 8 }, { id: 'hide_tough', qty: 2 }], blockCents: 50 },
    intro:
      "Can't log the north grove — the funnel spiders webbed it into a fly's idea of hell. Burn out nine, then fell ten oaks before they re-web. A funnel spider builds a trap you only understand once you're in it. Don't get in it. Burn it from outside like a reasonable coward.",
    outro:
      "Nine funnel spiders burned out, ten oaks felled in the reclaimed grove. You logged a forest that was actively trying to eat you, which is just normal forestry with extra steps and more screaming. The oaks are good. The webs are ash. The flies have filed their gratitude with an authority that does not exist.",
  },
  {
    id: 'q_wild_harvest_64',
    title: 'Ant Farm',
    giver: 'elder_rowan',
    regionId: 'beginnings',
    steps: [
      { kind: 'kill', target: 'ant_soldier', need: 12, label: 'Repel 12 soldier ants' },
      { kind: 'kill', target: 'locust_swarm', need: 6, label: 'Scatter 6 locust swarms' },
      { kind: 'gather', target: 'farm_plot', need: 10, label: 'Replant 10 ravaged plots' },
    ],
    rewards: { xp: { farming: 360, attack: 160 }, items: [{ id: 'wheat', qty: 10 }, { id: 'food_pie', qty: 2 }], blockCents: 60 },
    intro:
      "Biblical week on the farm. Soldier ants marching off with the seed, locust swarms eating the sky-side of everything, and the plots left looking like a battlefield's sadder cousin. Twelve ants, six swarms, ten plots replanted. The plagues come in sequence out here. We're only missing frogs, and I don't want to give them ideas.",
    outro:
      "Twelve soldier ants repelled, six locust swarms scattered, ten plots replanted from ruin. You turned a biblical week back into a merely terrible one, which on a farm is a triumph. The ants retreated, the locusts moved on to curse somebody else, and the wheat has a fighting chance. Don't mention frogs. We never mention frogs.",
  },
  {
    id: 'q_wild_harvest_65',
    title: 'Tick Tock',
    giver: 'inspector_flora',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'tick_bloated', need: 8, label: 'Pop 8 bloated ticks' },
      { kind: 'kill', target: 'plague_rat', need: 10, label: 'Exterminate 10 plague rats' },
    ],
    rewards: { xp: { attack: 300, vitality: 160 }, items: [{ id: 'potion_regret', qty: 2 }, { id: 'food_jerky', qty: 2 }], blockCents: 55 },
    intro:
      "Public health assignment, and I use 'health' generously. The frontier's crawling with bloated ticks and plague rats, which is a sentence that should make your skin leave without you. Eight ticks, ten rats. Wear gloves. Wear two pairs. Burn the gloves after. Burn this memo too, honestly.",
    outro:
      "Eight bloated ticks popped and ten plague rats exterminated, and the frontier is now merely unpleasant instead of actively contagious. You did the job nobody volunteers for, which is why it pays in potions of regret — thematically perfect, given what you touched today. Burn the gloves. Burn this one too. I'll deny the whole thing.",
  },

  // ═══════════════════════════ UNDEAD GRAVE-HARVEST CHAIN ═══════════════════════════
  {
    id: 'q_wild_harvest_66',
    title: 'Grave Robbing, But Botanical',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'gravecrawler', need: 8, label: 'Re-bury 8 gravecrawlers' },
      { kind: 'gather', target: 'mushroom_cluster', need: 10, label: 'Harvest 10 crypt mushrooms' },
    ],
    rewards: { xp: { herbalism: 300, attack: 180 }, items: [{ id: 'mushroom_brown', qty: 8 }, { id: 'herb_green', qty: 3 }], blockCents: 55 },
    intro:
      "The crypt mushrooms are the finest in the realm — they grow on exactly what you'd expect and I'd rather you not dwell on it. Trouble is the gravecrawlers keep uprooting them to get at the... soil. Eight crawlers, ten mushrooms. Gerald will watch. Gerald has opinions about mushroom placement. Humor him.",
    outro:
      "Eight gravecrawlers re-buried, ten crypt mushrooms harvested under Gerald's exacting supervision. They're the best mushrooms money can buy and the worst mushrooms to think about, which is the exact trade-off the whole graveyard runs on. Don't ask what they grew in. Do eat them. They're delicious. That's the horror of it.",
  },
  {
    id: 'q_wild_harvest_67',
    title: 'Rattle and Humerus',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'ghoul_grave', need: 7, label: 'Re-rest 7 grave ghouls' },
      { kind: 'kill', target: 'corpse_imp', need: 6, label: 'Snuff 6 corpse imps' },
    ],
    rewards: { xp: { attack: 400, magic: 120 }, items: [{ id: 'potion_regret', qty: 1 }, { id: 'herb_red', qty: 4 }], blockCents: 60 },
    intro:
      "Quiet-hours violation of the most egregious kind: grave ghouls moaning all night and corpse imps setting off little fires in the mausoleum like it's a festival. Seven ghouls, six imps. I run a dignified cemetery. Dignified. The residents keep forgetting they're supposed to be the quiet kind of dead.",
    outro:
      "Seven ghouls re-rested and six corpse imps snuffed, and the cemetery has returned to the profound silence it's supposed to specialize in. Listen to that. Gerald's listening. Beautiful. A dignified death is a quiet one, and you've restored a great deal of dignity with a great deal of violence. Only fitting.",
  },
  {
    id: 'q_wild_harvest_68',
    title: 'Six Feet Under Budget',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'gloomhound', need: 6, label: 'Put down 6 gloomhounds' },
      { kind: 'kill', target: 'barrow_wight', need: 4, label: 'Dispel 4 barrow wights' },
      { kind: 'kill', target: 'ash_spectre', need: 5, label: 'Banish 5 ash spectres' },
    ],
    rewards: { xp: { attack: 560, magic: 200 }, items: [{ id: 'crystal_shard', qty: 3 }, { id: 'herb_gold', qty: 2 }], blockCents: 90 },
    intro:
      "The old barrows woke up, and when the barrows wake it's never just one thing — gloomhounds guarding the paths, barrow wights hoarding the grave-goods, ash spectres drifting around being unhelpfully ominous. Six, four, five. Put the whole restless committee back to bed before it votes to expand.",
    outro:
      "Six gloomhounds, four barrow wights, five ash spectres — the entire restless committee adjourned permanently. The barrows sleep, the grave-goods stay put, and the ominous drifting has ceased, which really pulls the whole crypt together. A barrow wight hoards treasure it can't spend forever; you spent its forever for it. Generous, really.",
  },
  {
    id: 'q_wild_harvest_69',
    title: 'The Longest Night',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'revenant_rust', need: 4, label: 'Lay 4 rust revenants to rest' },
      { kind: 'kill', target: 'crypt_widow', need: 3, label: 'Clear 3 crypt widows' },
      { kind: 'kill', target: 'wraith_pale', need: 5, label: 'Banish 5 pale wraiths' },
    ],
    rewards: { xp: { attack: 680, magic: 260, vitality: 200 }, items: [{ id: 'crystal_cut', qty: 3 }, { id: 'food_honey', qty: 2 }], blockCents: 130 },
    intro:
      "Something stirred the deep crypt and now the old guard's up: rust revenants in their rotted armor, crypt widows spinning webs in the ossuary, pale wraiths wailing through the walls. Four, three, five. These aren't the shambling kind — these remember how to fight. So do you. Prove you remember better.",
    outro:
      "Four rust revenants laid down, three crypt widows cleared, five pale wraiths silenced. The deep crypt is still again, and the old guard remembers nothing now, which is the kindest thing anyone's done for them in centuries. You out-remembered the dead tonight. Gerald wept. Gerald does that. Rest, hero. You earned the quiet you just made.",
  },
  {
    id: 'q_wild_harvest_70',
    title: 'Bone to Pick',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'boneknight_cursed', need: 3, label: 'Shatter 3 cursed bone-knights' },
      { kind: 'kill', target: 'lich_frost', need: 1, label: 'End the frost lich' },
    ],
    rewards: { xp: { attack: 900, magic: 400, vitality: 300 }, items: [{ id: 'crystal_cut', qty: 4 }, { id: 'herb_gold', qty: 3 }], blockCents: 220 },
    intro:
      "Here's the root of all the restlessness: a frost lich set up shop in the lowest vault and raised the whole cemetery as its honor guard, led by three cursed bone-knights who were somebody once and are furniture now. End the lich and the whole graveyard finally, finally sleeps. Three knights, one lich. Do this and I'll owe you a silence I can't repay.",
    outro:
      "Three bone-knights shattered and the frost lich ended, its honor guard collapsing into the quiet it stole from them. The whole cemetery sleeps now — truly sleeps, for the first time in my tenure. Listen. Gerald's listening. It's the most beautiful silence in the world, and you made it with your own two bloody hands. Begonias on the lich's plot. It means 'stay down'. It always has.",
  },

  // ═══════════════════════════ DRAGON / ELEMENTAL CAPSTONES ═══════════════════════════
  {
    id: 'q_wild_harvest_71',
    title: 'Hoard Mentality',
    giver: 'prospector_finn',
    regionId: 'ironhold',
    steps: [
      { kind: 'kill', target: 'wyrmling_ember', need: 5, label: 'Hunt 5 ember wyrmlings' },
      { kind: 'kill', target: 'wyrmling_frost', need: 5, label: 'Hunt 5 frost wyrmlings' },
      { kind: 'gather', target: 'gold_vein', need: 8, label: 'Reclaim 8 gold veins from the nest' },
    ],
    rewards: { xp: { mining: 480, attack: 360 }, items: [{ id: 'ore_gold', qty: 6 }, { id: 'bar_gold', qty: 1 }], blockCents: 140 },
    intro:
      "Dragons start small and greedy and get bigger and greedier. The wyrmlings have claimed the gold seam as the foundation of hoards they haven't even built yet — five ember, five frost, all of them squatting on OUR ore. Hunt the babies, reclaim eight veins. Harsh? They'd eat you without a thought. Think of it as pre-emptive mining.",
    outro:
      "Five ember wyrmlings, five frost wyrmlings, eight gold veins reclaimed from the nursery of future tyrants. A wyrmling is a dragon that hasn't gotten around to ruining your life yet; you cancelled ten such futures and took their down payment in gold. Hoarding runs in the blood. So, apparently, does losing the hoard to you.",
  },
  {
    id: 'q_wild_harvest_72',
    title: 'Drake and Drop',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'drake_ash', need: 4, label: 'Down 4 ash drakes' },
      { kind: 'kill', target: 'drake_crag', need: 3, label: 'Down 3 crag drakes' },
      { kind: 'kill', target: 'wyvern_cinder', need: 2, label: 'Ground 2 cinder wyverns' },
    ],
    rewards: { xp: { attack: 720, defense: 300 }, items: [{ id: 'hide_tough', qty: 6 }, { id: 'crystal_shard', qty: 3 }], blockCents: 160 },
    intro:
      "The frontier sky has become a problem. Ash drakes roosting on my roof, crag drakes nesting in my well, cinder wyverns circling like I'm a buffet with a thatched hat. Four, three, two. I moved to the edge of the world for peace, and the flying lizards followed me here specifically. Ground them. All of them. I want my sky back.",
    outro:
      "Four ash drakes, three crag drakes, two cinder wyverns — the entire aerial menace, grounded permanently. My roof is mine, my well is mine, and the sky above the frontier is once more an empty, beautiful nothing. A drake thinks the sky belongs to whatever flies highest; you reminded them the ground belongs to whoever's left. That's me. Alone. Perfect. Leave.",
  },
  {
    id: 'q_wild_harvest_73',
    title: 'Cold-Blooded',
    giver: 'inspector_flora',
    regionId: 'ironhold',
    steps: [
      { kind: 'kill', target: 'wyvern_glacier', need: 3, label: 'Ground 3 glacier wyverns' },
      { kind: 'kill', target: 'wyrm_permafrost', need: 1, label: 'End the permafrost wyrm' },
      { kind: 'gather', target: 'crystal_node', need: 8, label: 'Harvest 8 frost-crystal nodes' },
    ],
    rewards: { xp: { mining: 640, attack: 560 }, items: [{ id: 'crystal_raw', qty: 8 }, { id: 'crystal_cut', qty: 2 }], blockCents: 200 },
    intro:
      "The high peaks froze over, and it's not weather — it's a permafrost wyrm, big as a glacier and twice as patient, with three glacier wyverns running its errands. The frost crystal it's been hoarding is the finest in the world, which is exactly why it's hoarding it. Three wyverns, one wyrm, eight nodes. Dress warm. Dying of cold up there is embarrassingly on-theme.",
    outro:
      "Three glacier wyverns grounded, one permafrost wyrm ended, eight frost-crystal nodes harvested from its melting hoard. The peaks are thawing, the sky's clear, and the finest crystal in the world is in your pack instead of under a dragon. A permafrost wyrm waits out everything — mountains, kingdoms, patience itself — but it did not wait out you. Impressive. Also, you've turned slightly blue. Go stand near a fire immediately.",
  },
  {
    id: 'q_wild_harvest_74',
    title: 'Scorched Earth Policy',
    giver: 'prophet_karl',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'drake_prism', need: 3, label: 'Down 3 prism drakes' },
      { kind: 'kill', target: 'wyrm_magma', need: 1, label: 'Quench the magma wyrm' },
      { kind: 'kill', target: 'char_drake', need: 4, label: 'Down 4 char drakes' },
    ],
    rewards: { xp: { attack: 820, magic: 400, defense: 300 }, items: [{ id: 'crystal_cut', qty: 4 }, { id: 'herb_gold', qty: 2 }], blockCents: 230 },
    intro:
      "The ashen deep is cooking. A magma wyrm has burrowed into the heart of it, and where there's a magma wyrm there are char drakes and prism drakes drawn to the heat like the worst moths imaginable. Three prism, one wyrm, four char. Quench the wyrm and the whole region stops being a furnace. Bring water. Bring resolve. Water won't help but bring it anyway, for morale.",
    outro:
      "Three prism drakes, four char drakes, and one magma wyrm quenched at the very heart of the ashen deep. The furnace is cooling, the ground's merely warm instead of molten, and the sky's clear of the heat-drunk lizards that worshipped it. A magma wyrm is the ground's own temper made flesh; you cooled its temper permanently. The region exhales steam and gratitude. Mostly steam.",
  },
  {
    id: 'q_wild_harvest_75',
    title: 'The Last Harvest',
    giver: 'mage_lyra',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'wyrm_crystalline', need: 1, label: 'Shatter the crystalline wyrm' },
      { kind: 'kill', target: 'wyrm_bone', need: 1, label: 'End the bone wyrm' },
      { kind: 'kill', target: 'dragon_obsidian', need: 1, label: 'Slay the obsidian dragon' },
      { kind: 'collect', target: 'crystal_cut', need: 8, label: 'Reclaim 8 cut crystals from the hoards' },
    ],
    rewards: { xp: { attack: 999, magic: 999, mining: 820, alchemy: 400 }, items: [{ id: 'crystal_cut', qty: 6 }, { id: 'food_cake', qty: 2 }, { id: 'potion_regret', qty: 1 }], blockCents: 400 },
    intro:
      "This is the one they'll write down wrong for a thousand years. Three ancient wyrms at the edge of the world — crystalline, bone, and the obsidian dragon that sleeps on the biggest hoard in history, built from everything every other dragon ever stole. Shatter the first two, slay the last, reclaim eight cut crystals from the ruin. This is the last harvest, apprentice. Everything else was practice. Go reap the end of an age.",
    outro:
      "The crystalline wyrm shattered, the bone wyrm ended, the obsidian dragon slain atop the greatest hoard the world has ever hidden. You walked to the edge of everything and brought back eight crystals and the end of an age. The scholars will get the details wrong and the stakes wrong and your name wrong, but they'll agree on one thing: once, someone harvested the whole wild world down to its last dragon, and lived to be insufferable about it. That someone is you. Have a cake. You've earned the entire world; the cake is just so you have something to hold.",
  },
]

/** Long gathering/crafting progressions so each profession reads as a ladder. */
const prereqs: Record<string, readonly string[]> = {
  // Woodcutting
  q_wild_harvest_02: ['q_wild_harvest_01'],
  q_wild_harvest_04: ['q_wild_harvest_03'],
  q_wild_harvest_05: ['q_wild_harvest_02'],
  q_wild_harvest_07: ['q_wild_harvest_05'],
  q_wild_harvest_08: ['q_wild_harvest_07'],
  // Fishing
  q_wild_harvest_10: ['q_wild_harvest_09'],
  q_wild_harvest_11: ['q_wild_harvest_10'],
  q_wild_harvest_12: ['q_wild_harvest_11'],
  q_wild_harvest_13: ['q_wild_harvest_12'],
  q_wild_harvest_14: ['q_wild_harvest_13'],
  q_wild_harvest_15: ['q_wild_harvest_14'],
  q_wild_harvest_16: ['q_wild_harvest_15'],
  // Farming
  q_wild_harvest_18: ['q_wild_harvest_17'],
  q_wild_harvest_20: ['q_wild_harvest_18'],
  q_wild_harvest_21: ['q_wild_harvest_17'],
  q_wild_harvest_23: ['q_wild_harvest_20'],
  // Herbalism
  q_wild_harvest_25: ['q_wild_harvest_24'],
  q_wild_harvest_26: ['q_wild_harvest_25'],
  q_wild_harvest_27: ['q_wild_harvest_26'],
  q_wild_harvest_28: ['q_wild_harvest_27'],
  q_wild_harvest_30: ['q_wild_harvest_28'],
  // Cooking
  q_wild_harvest_32: ['q_wild_harvest_31'],
  q_wild_harvest_33: ['q_wild_harvest_32'],
  q_wild_harvest_34: ['q_wild_harvest_33'],
  q_wild_harvest_35: ['q_wild_harvest_34'],
  q_wild_harvest_36: ['q_wild_harvest_35'],
  q_wild_harvest_37: ['q_wild_harvest_36'],
  // Alchemy
  q_wild_harvest_39: ['q_wild_harvest_38'],
  q_wild_harvest_40: ['q_wild_harvest_39'],
  q_wild_harvest_41: ['q_wild_harvest_40'],
  q_wild_harvest_42: ['q_wild_harvest_41'],
  q_wild_harvest_43: ['q_wild_harvest_40'],
  q_wild_harvest_44: ['q_wild_harvest_42', 'q_wild_harvest_43'],
  // Mining
  q_wild_harvest_46: ['q_wild_harvest_45'],
  q_wild_harvest_47: ['q_wild_harvest_46'],
  q_wild_harvest_48: ['q_wild_harvest_47'],
  // Blacksmithing
  q_wild_harvest_50: ['q_wild_harvest_49'],
  q_wild_harvest_51: ['q_wild_harvest_50'],
  q_wild_harvest_52: ['q_wild_harvest_51'],
  // Undead grave-harvest
  q_wild_harvest_67: ['q_wild_harvest_66'],
  q_wild_harvest_68: ['q_wild_harvest_67'],
  q_wild_harvest_69: ['q_wild_harvest_68'],
  q_wild_harvest_70: ['q_wild_harvest_69'],
  // Dragon capstones
  q_wild_harvest_72: ['q_wild_harvest_71'],
  q_wild_harvest_73: ['q_wild_harvest_71'],
  q_wild_harvest_74: ['q_wild_harvest_72'],
  q_wild_harvest_75: ['q_wild_harvest_73', 'q_wild_harvest_74', 'q_wild_harvest_44'],
}

/** Display names for collect/reward ids that may not carry their own catalog name. */
const itemNames: Record<string, string> = {
  wood_oak: 'Oak Log',
  wood_pine: 'Pine Log',
  wood_ancient: 'Ancient Timber',
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
  hide_wolf: 'Wolf Hide',
  hide_boar: 'Boar Hide',
  hide_tough: 'Tough Hide',
  herb_green: 'Green Herb',
  herb_red: 'Red Herb',
  herb_blue: 'Blue Herb',
  herb_gold: 'Gold Herb',
  berry_red: 'Red Berries',
  mushroom_brown: 'Brown Mushroom',
  wheat: 'Wheat',
  clay_lump: 'Clay Lump',
  fish_raw: 'Raw Fish',
  fish_trout: 'Trout',
  fish_salmon: 'Salmon',
  food_jerky: 'Dried Jerky',
  food_pie: 'Meat Pie',
  food_cake: 'Tiny Expensive Cake',
  food_honey: 'Honeycomb',
  food_jelly: 'Berry Jelly',
  potion_regret: 'Potion of Regret',
}

registerPack({ quests, prereqs, itemNames })
