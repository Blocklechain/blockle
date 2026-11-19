/**
 * questmega_arcane — the "arcane studies" mega quest pack.
 *
 * ~75 quests focused on the four fiddly, flammable, finger-stabbing crafts:
 * MAGIC (arcane study), ARCHERY (fletching), ALCHEMY (brewing) and
 * TAILORING (stitching). Multi-step chains + prereqs give each craft a real
 * progression from "don't point that at me" to "you solved a problem wizards
 * chase for lifetimes".
 *
 * Every step target is a real species id (kill), node kind (gather), item id
 * (collect) or region id (explore); every reward item id is a real catalog or
 * pack material/food. No armor-piece ids are granted (those live elsewhere and
 * may not match) — rewards are materials, food, gold and skill XP, scaling up
 * toward the 999 cap for the late capstones.
 *
 * Side-effect: registers at import time via registerPack({ quests, prereqs,
 * itemNames }). Imported from src/content/index.ts.
 */
import { registerPack } from './packs'
import type { QuestDef } from '../types'

const quests: QuestDef[] = [
  // ═══════════════════════════════ MAGIC — arcane study ═══════════════════════════════
  {
    id: 'q_arcane_01',
    title: 'Don’t Point That At Me, Either',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [{ kind: 'kill', target: 'wisp', need: 10, label: 'Unravel 10 wisps' }],
    rewards: { xp: { magic: 220 }, items: [{ id: 'crystal_raw', qty: 4 }] },
    intro:
      "Everyone wants to throw fireballs on day one. Day one you unravel wisps, which are arcane lint with ambitions. Ten of them. If your hands catch fire, that's not a spell, that's a mistake. Know the difference.",
    outro:
      "Ten wisps, back to being nothing. Your hands are intact and only faintly smoking. That's a passing grade and, frankly, a surprise.",
  },
  {
    id: 'q_arcane_02',
    title: 'Something to Point It Through',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [{ kind: 'gather', target: 'crystal_node', need: 8, label: 'Harvest 8 crystal nodes' }],
    rewards: { xp: { magic: 200, mining: 60 }, items: [{ id: 'crystal_raw', qty: 6 }] },
    intro:
      "Raw talent is a candle in a hurricane. You need a focus — a crystal to shove the magic through so it comes out a spell and not a regret. Harvest eight nodes. Mind the humming; crystals that hum are forming opinions.",
    outro:
      "Eight nodes, eight chances to channel without blowing a finger off. Now your magic has somewhere to go that isn't 'everywhere, loudly'. Progress.",
  },
  {
    id: 'q_arcane_03',
    title: 'Echolocation, Rudely Interrupted',
    giver: 'npc_capital_magus',
    regionId: 'capital',
    steps: [{ kind: 'kill', target: 'bat', need: 12, label: 'Burst 12 bats mid-flap' }],
    rewards: { xp: { magic: 240 }, items: [{ id: 'potion_regret', qty: 1 }] },
    intro:
      "A bat is a moving target that screams in a frequency your spell has to catch up to. Pop twelve. It teaches timing, and timing is the entire difference between a mage and a scorch mark with a name.",
    outro:
      "Twelve bats, caught mid-screech. Your timing's sharpening. One day you'll hit a thing that's actually trying, and you'll thank the bats. Quietly. They won't hear you now.",
  },
  {
    id: 'q_arcane_04',
    title: 'Correctly Conjugated Banishment',
    giver: 'prophet_karl',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'imp', need: 12, label: 'Banish 12 imps (enunciate)' }],
    rewards: { xp: { magic: 300 }, items: [{ id: 'crystal_shard', qty: 3 }], blockCents: 45 },
    intro:
      "Imps think fire is theirs by birthright. Correct them, academically. Twelve banishments, and ENUNCIATE — a mispronounced banish just teleports the imp three feet left and makes it smug.",
    outro:
      "Twelve imps, correctly conjugated into the elsewhere. Your diction could cut glass. The imps are telling scary stories about the one who spoke in complete sentences.",
  },
  {
    id: 'q_arcane_05',
    title: 'The Reading List',
    giver: 'npc_capital_archivist',
    regionId: 'capital',
    steps: [
      { kind: 'collect', target: 'crystal_shard', need: 6, label: 'Refine 6 crystal shards' },
      { kind: 'collect', target: 'herb_blue', need: 4, label: 'Gather 4 blue herbs (for the ink)' },
    ],
    rewards: { xp: { magic: 340, herbalism: 80 }, items: [{ id: 'crystal_cut', qty: 2 }], blockCents: 55 },
    intro:
      "You cannot cast what you cannot read, and the good spellbooks are written in ink that costs a kidney. Six crystal shards for the stylus, four blue herbs for the ink. Bleed for scholarship — everyone else did.",
    outro:
      "Six shards, four herbs, one stylus that writes in light. The library will let you in now, past the shelf of books that bite. You've earned the bite.",
  },
  {
    id: 'q_arcane_06',
    title: 'Ghosts Have Feelings (They’re Bad)',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'ash_spectre', need: 10, label: 'Dispel 10 ash spectres' }],
    rewards: { xp: { magic: 380 }, items: [{ id: 'potion_regret', qty: 2 }], blockCents: 55 },
    intro:
      "Ash spectres are grudges that learned to float. They can't hurt you much, but they will narrate your failures in a cold whisper until you quit the profession. Dispel ten before the self-esteem damage compounds.",
    outro:
      "Ten spectres dispelled mid-insult. The whispering's gone and your confidence is, miraculously, intact. Arcane therapy, performed with a spellbook. Bill yourself later.",
  },
  {
    id: 'q_arcane_07',
    title: 'Wraiths, and the Unmaking Thereof',
    giver: 'npc_forgotten_chaplain',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'wraith_pale', need: 8, label: 'Unmake 8 pale wraiths' }],
    rewards: { xp: { magic: 460 }, items: [{ id: 'crystal_cut', qty: 3 }], blockCents: 75 },
    intro:
      "A pale wraith is what's left when a soul forgets to leave and the leftovers go sour. Unmake eight. The spell is simple; the nerve required to stand still while one glides at you is the hard part.",
    outro:
      "Eight wraiths, unmade. You held your ground while cold death reached for you and you didn't flinch or wet anything important. That nerve is worth more than the spell.",
  },
  {
    id: 'q_arcane_08',
    title: 'The Thing Under the Frost',
    giver: 'npc_forgotten_chaplain',
    regionId: 'forgotten',
    steps: [
      { kind: 'explore', target: 'forgotten', need: 1, label: 'Reach the deep barrows' },
      { kind: 'kill', target: 'lich_frost', need: 1, label: 'Put the Frost Lich down for good' },
    ],
    rewards: { xp: { magic: 820, vitality: 200 }, items: [{ id: 'crystal_cut', qty: 5 }], blockCents: 160 },
    intro:
      "Somewhere under the deep barrows a lich has been 'studying' for four centuries, which is a polite word for hoarding frost and refusing to die on schedule. Walk in. End the sabbatical. Bring a scarf.",
    outro:
      "The Frost Lich finished its research the hard way. Four centuries of spite, concluded in an afternoon by someone who read the right chapters. The barrows are just cold now, not malevolent. Big upgrade.",
  },
  {
    id: 'q_arcane_09',
    title: 'Fire Is a Language',
    giver: 'npc_ashen_quill',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'mote_cinder', need: 12, label: 'Snuff 12 cinder motes' }],
    rewards: { xp: { magic: 300 }, items: [{ id: 'bar_copper', qty: 3 }], blockCents: 40 },
    intro:
      "Cinder motes are baby fires that never learned manners. Snuff twelve. You'll learn to feel the shape of flame, which is useful right up until it's the last thing you ever feel. Pay attention.",
    outro:
      "Twelve motes, out. You can read fire now — where it wants to go, where it'll bite. The elementals will respect you, in the way fire respects anything, which is to say briefly and then it tries again.",
  },
  {
    id: 'q_arcane_10',
    title: 'The Cold Shoulder',
    giver: 'npc_ashen_quill',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'elem_frost', need: 8, label: 'Shatter 8 frost elementals' }],
    rewards: { xp: { magic: 440 }, items: [{ id: 'crystal_shard', qty: 4 }], blockCents: 70 },
    intro:
      "Frost elementals are made of 'no'. They freeze your spell halfway out of your mouth, which is humiliating and permanent if you let it finish. Shatter eight. Counter cold with contempt, I find it works.",
    outro:
      "Eight frost elementals, shattered into expensive-looking gravel. You out-stubborned the cold. In this school that's basically a thesis defense. Well argued.",
  },
  {
    id: 'q_arcane_11',
    title: 'Static Cling',
    giver: 'npc_capital_magus',
    regionId: 'capital',
    steps: [{ kind: 'kill', target: 'elem_storm', need: 8, label: 'Ground 8 storm elementals' }],
    rewards: { xp: { magic: 520 }, items: [{ id: 'crystal_cut', qty: 3 }], blockCents: 90 },
    intro:
      "Storm elementals are tantrums with range. Ground eight of them before they ground you, which they do by stopping your heart and calling it weather. Keep one foot off the wet stone, genius.",
    outro:
      "Eight storms, grounded. Your hair will stand up for a week and you smell like a coming migraine, but the weather is calm and you are alive, which is the rarer of those two outcomes.",
  },
  {
    id: 'q_arcane_12',
    title: 'Staring Into the Nothing',
    giver: 'npc_forgotten_apoth',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'mote_void', need: 6, label: 'Collapse 6 void motes' }],
    rewards: { xp: { magic: 640 }, items: [{ id: 'crystal_cut', qty: 4 }], blockCents: 110 },
    intro:
      "Void motes are holes in the world small enough to mistake for dust. Collapse six. Don't look too long — the void looks back, takes notes, and remembers your name for later. Work fast, think about lunch.",
    outro:
      "Six void motes, folded back into the nothing they came from. You looked into the abyss and the abyss looked annoyed. Lunch is a fine thing to think about. Go think about it elsewhere.",
  },
  {
    id: 'q_arcane_13',
    title: 'The Rune That Walks',
    giver: 'shardwarden_igor',
    regionId: 'ironhold',
    steps: [{ kind: 'kill', target: 'rune_colossus', need: 1, label: 'Unbind the Rune Colossus' }],
    rewards: { xp: { magic: 760, defense: 180 }, items: [{ id: 'crystal_cut', qty: 5 }], blockCents: 150 },
    intro:
      "Some idiot ancestor carved a spell so big it stood up and walked off. The Rune Colossus has been pacing the old vault for a thousand years with no destination, which is the saddest and most dangerous thing I know. Unbind it. Read the runes as they fall — it's the only free lesson you'll get.",
    outro:
      "The Rune Colossus is a pile of glowing script again, as it should be. You read half its body as it came apart — a thousand-year masterclass, delivered by something trying to crush you. Best kind of tutor.",
  },
  {
    id: 'q_arcane_14',
    title: 'Mirror, Mirror, Stab',
    giver: 'shardwarden_igor',
    regionId: 'ironhold',
    steps: [{ kind: 'kill', target: 'mirror_golem', need: 6, label: 'Shatter 6 mirror golems' }],
    rewards: { xp: { magic: 500, defense: 120 }, items: [{ id: 'crystal_shard', qty: 5 }], blockCents: 85 },
    intro:
      "Mirror golems reflect your own spell back at you, which is the universe's way of grading your work in real time. Shatter six. If your spell kills you, it was a bad spell and you learned that the fastest way possible.",
    outro:
      "Six mirror golems, shattered — by your own spells, technically, which the golems helpfully returned. Turns out your work holds up. Good to know before a real wizard tests it.",
  },
  {
    id: 'q_arcane_15',
    title: 'Enchantments for the Impatient',
    giver: 'npc_capital_archivist',
    regionId: 'capital',
    steps: [
      { kind: 'collect', target: 'crystal_cut', need: 5, label: 'Cut 5 crystals for binding' },
      { kind: 'collect', target: 'herb_gold', need: 3, label: 'Gather 3 gold herbs (binding oil)' },
    ],
    rewards: { xp: { magic: 560, herbalism: 100 }, items: [{ id: 'crystal_cut', qty: 2 }], blockCents: 100 },
    intro:
      "Enchanting is just convincing an object to keep a secret forever. Five cut crystals, three gold herbs for the oil. Rush it and the enchantment leaks out overnight and your sword glows for exactly no reason in the morning.",
    outro:
      "Five crystals, three herbs, one enchantment that will actually hold. The object kept its secret through the night and didn't glow stupidly at dawn. You're enchanting like you mean it now.",
  },
  {
    id: 'q_arcane_16',
    title: 'Field Research, Dangerous',
    giver: 'npc_capital_magus',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'wisp', need: 8, label: 'Harvest residue from 8 wisps' },
      { kind: 'gather', target: 'crystal_node', need: 6, label: 'Log 6 crystal nodes' },
    ],
    rewards: { xp: { magic: 400, mining: 80 }, items: [{ id: 'crystal_raw', qty: 6 }], blockCents: 60 },
    intro:
      "My last field researcher developed 'self-preservation' and quit. You don't have that, clearly. Eight wisps for residue, six crystal nodes for baseline readings. Data doesn't collect itself, and it certainly won't survive itself.",
    outro:
      "Eight wisps, six nodes, one complete dataset. Chapter nine lives again. You risked your skin for footnotes, which is the truest scholarship there is. Welcome to academia; the pay is worse than banditry.",
  },
  {
    id: 'q_arcane_17',
    title: 'The Clockwork Won’t Reason',
    giver: 'npc_ironhold_deepwarden_hale',
    regionId: 'ironhold',
    steps: [{ kind: 'kill', target: 'prism_drone', need: 10, label: 'Dim 10 prism drones' }],
    rewards: { xp: { magic: 480 }, items: [{ id: 'crystal_shard', qty: 5 }], blockCents: 80 },
    intro:
      "Prism drones split your spell into a rainbow and then stab you with every color at once. It's beautiful and it's trying to kill you, which describes most of magic. Dim ten. Aim for the lens.",
    outro:
      "Ten drones dimmed, their pretty murder-rainbows extinguished. You learned to hit the lens, which is the whole trick. Beauty's a distraction; the lens is the point. Apply broadly.",
  },
  {
    id: 'q_arcane_18',
    title: 'Grudge Collectors',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'ash_spectre', need: 6, label: 'Dispel 6 ash spectres' },
      { kind: 'kill', target: 'wraith_pale', need: 6, label: 'Unmake 6 pale wraiths' },
    ],
    rewards: { xp: { magic: 600, vitality: 120 }, items: [{ id: 'crystal_cut', qty: 4 }], blockCents: 105 },
    intro:
      "The spectres whisper your failures and the wraiths reach for your warmth. Together they're a committee of everything that's ever gone wrong, and they meet nightly in my graveyard. Adjourn the meeting. Six and six. Gerald approves.",
    outro:
      "Six spectres, six wraiths, one adjourned committee of regret. The graveyard whispers nothing now. Gerald is weeping, but happily — insofar as whatever Gerald is can be happy. Beautiful work.",
  },
  {
    id: 'q_arcane_19',
    title: 'The Bone Wyrm’s Last Lecture',
    giver: 'npc_forgotten_apoth',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'wyrm_bone', need: 1, label: 'Silence the Bone Wyrm' }],
    rewards: { xp: { magic: 960, defense: 240 }, items: [{ id: 'crystal_cut', qty: 6 }], blockCents: 200 },
    intro:
      "The Bone Wyrm is a dragon that died, got bored, and came back as a rattling lecture on mortality that eats students. Every mage who's faced it learned exactly one spell before the end. Learn yours faster. Silence it.",
    outro:
      "The Bone Wyrm's lecture is over, permanently, mid-sentence. You learned the spell AND lived, which the syllabus swore was impossible. You're not a student of the arcane anymore. You're the thing students read about.",
  },
  {
    id: 'q_arcane_20',
    title: 'Tenure Track',
    giver: 'npc_capital_archivist',
    regionId: 'capital',
    steps: [
      { kind: 'explore', target: 'capital', need: 1, label: 'Present at the Grand Library' },
      { kind: 'collect', target: 'crystal_cut', need: 4, label: 'Submit 4 cut crystals (your findings)' },
    ],
    rewards: { xp: { magic: 700 }, items: [{ id: 'food_cake', qty: 3 }], blockCents: 130 },
    intro:
      "To be a Master you must present findings to the Grand Library and submit four flawless crystals as proof you didn't make it all up. The committee is ancient, hostile, and allergic to your generation specifically. Impress them anyway.",
    outro:
      "Four crystals, one presentation, zero committee members awake by the end — which, for that committee, is the highest honor. You're a Master now. Here's cake. Mastery tastes a lot like cake and resentment.",
  },

  // ═══════════════════════════════ ARCHERY — fletching ═══════════════════════════════
  {
    id: 'q_fletch_01',
    title: 'The Thing Dies Over There',
    giver: 'ranger_kael',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'bat', need: 12, label: 'Pluck 12 bats from the sky' }],
    rewards: { xp: { archery: 220 }, items: [{ id: 'wood_pine', qty: 4 }] },
    intro:
      "The entire philosophy of archery is: the problem happens over there, and I remain, smugly, over here. Twelve bats. Lead the shot or feed the arrow to the wind. The wind does not say thank you.",
    outro:
      "Twelve bats, grouped tight, all of them 'over there' at the moment of death. You've grasped the creed. Here's pine for shafts — a real archer makes half their own arrows and loses all of them anyway.",
  },
  {
    id: 'q_fletch_02',
    title: 'Shafts and Grafts',
    giver: 'npc_greenwood_sapling_nib',
    regionId: 'greenwood',
    steps: [{ kind: 'gather', target: 'pine_tree', need: 10, label: 'Fell 10 pines for straight shafts' }],
    rewards: { xp: { archery: 200, woodcutting: 80 }, items: [{ id: 'wood_pine', qty: 8 }] },
    intro:
      "An arrow is 90% stick. A crooked stick is a prayer you fling at the enemy's general direction. Fell ten pines and pick the straightest grain — bent wood flies bent, and bent is how you miss a barn.",
    outro:
      "Ten pines, and you've learned to read grain like a palm. Straight shafts fly straight; it's not magic, it's just not being lazy. You'd be amazed how many archers die of laziness.",
  },
  {
    id: 'q_fletch_03',
    title: 'Fletching for Beginners Who Will Cry',
    giver: 'npc_greenwood_beastmaster_oona',
    regionId: 'greenwood',
    steps: [
      { kind: 'kill', target: 'pack_raptor', need: 10, label: 'Hunt 10 pack raptors (for flight feathers)' },
      { kind: 'collect', target: 'wood_pine', need: 6, label: 'Shape 6 pine shafts' },
    ],
    rewards: { xp: { archery: 320 }, items: [{ id: 'food_jerky', qty: 3 }], blockCents: 45 },
    intro:
      "Feathers steer the arrow. No feathers, and your shot tumbles like a drunk leaving a tavern. Hunt ten pack raptors for proper flight feathers and bring six shafts. You will glue your fingers together. Everyone does. It builds character and ruins gloves.",
    outro:
      "Ten raptors, six shafts, and — let me see your hands — yes, fully glued, textbook. Your arrows will fly true now instead of tumbling off to embarrass you. The gloves are a lost cause. Jerky?",
  },
  {
    id: 'q_fletch_04',
    title: 'Venison Is a Byproduct',
    giver: 'npc_greenwood_beastmaster_oona',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'meadow_fawn', need: 8, label: 'Harvest 8 meadow fawn' }],
    rewards: { xp: { archery: 260 }, items: [{ id: 'hide_wolf', qty: 4 }, { id: 'food_jerky', qty: 2 }] },
    intro:
      "Don't look at me like that — a fawn is a very mobile target that teaches very real lead. Eight of them. The hide makes bowstrings, the meat makes dinner, and your conscience makes a brief appearance and then leaves. That's hunting.",
    outro:
      "Eight fawns, clean shots, and your lead is immaculate now. Hide for strings, meat for the pot. Your conscience is already recovering, I can tell. It always does. That's the troubling part.",
  },
  {
    id: 'q_fletch_05',
    title: 'The Air Force Problem',
    giver: 'ranger_kael',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'wasp_hornet', need: 12, label: 'Down 12 hornets mid-dive' }],
    rewards: { xp: { archery: 340 }, items: [{ id: 'herb_red', qty: 5 }], blockCents: 50 },
    intro:
      "Hornets are tiny, furious, and they dive. Hitting one is a moving-target masterclass with a stinging final exam. Down twelve. Miss and you'll learn why we respect anything that comes at you faster than an apology.",
    outro:
      "Twelve hornets, dropped mid-dive, and only a few stings for the honor. Your snap shot is lethal now. Small fast things are the whole game; everything bigger just moves slower.",
  },
  {
    id: 'q_fletch_06',
    title: 'Funnel Vision',
    giver: 'npc_greenwood_beastmaster_oona',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'spider_funnel', need: 10, label: 'Snipe 10 funnel spiders at the web' }],
    rewards: { xp: { archery: 360 }, items: [{ id: 'crystal_shard', qty: 3 }], blockCents: 55 },
    intro:
      "Funnel spiders wait at the bottom of their hole and bolt out when you're close. The trick is shooting them in the half-second they emerge — too early you miss, too late you're lunch. Ten of them. I'll refuse to be within thirty feet.",
    outro:
      "Ten funnel spiders, picked off in the exact instant of emergence. That's timing most archers never find. My skin, which was crawling, has settled. Yours, I suspect, is only starting.",
  },
  {
    id: 'q_fletch_07',
    title: 'Foxed',
    giver: 'npc_forgotten_beastward',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'tundra_fox', need: 8, label: 'Track and drop 8 tundra foxes' }],
    rewards: { xp: { archery: 400 }, items: [{ id: 'hide_tough', qty: 3 }], blockCents: 60 },
    intro:
      "A tundra fox against snow is a rumor with a tail. You won't see it; you'll see where it isn't, and shoot where it's about to be. Eight. This is the lesson that separates a hunter from a man standing in the cold holding a bow.",
    outro:
      "Eight foxes, each shot where it was going rather than where it was. You can read a track and a future now. You are officially a hunter and not, I'm relieved to report, just a cold man with a stick.",
  },
  {
    id: 'q_fletch_08',
    title: 'Cat Got Your Arrow',
    giver: 'npc_forgotten_beastward',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'frost_lynx', need: 6, label: 'Outshoot 6 frost lynxes' }],
    rewards: { xp: { archery: 460 }, items: [{ id: 'hide_tough', qty: 4 }], blockCents: 75 },
    intro:
      "A frost lynx closes the distance faster than you can nock a second arrow, so your first one had better be a love letter to its vital organs. Six of them. One shot each is the goal; two is survival; three is a funeral.",
    outro:
      "Six lynxes, mostly one shot each. Your first arrow means something now, which is the whole art — the second arrow is just an apology for the first one missing. You rarely apologize these days.",
  },
  {
    id: 'q_fletch_09',
    title: 'Antler Points',
    giver: 'ranger_kael',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'horned_stag', need: 8, label: 'Fell 8 horned stags' }],
    rewards: { xp: { archery: 420 }, items: [{ id: 'hide_tough', qty: 3 }, { id: 'food_jerky', qty: 3 }] },
    intro:
      "A horned stag doesn't flee — it turns, lowers the rack, and charges, which changes archery from a hobby into a deadline. Eight of them. Hit the heart before the antlers rewrite your opinion of 'safe distance'.",
    outro:
      "Eight stags, all dropped before the charge connected. You've learned the ugly truth: distance is only safe until it decides not to be. You keep the first shot honest now. Keeps you un-gored.",
  },
  {
    id: 'q_fletch_10',
    title: 'Pride Goeth',
    giver: 'npc_forgotten_beastward',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'savanna_lion', need: 6, label: 'Bring down 6 savanna lions' }],
    rewards: { xp: { archery: 540 }, items: [{ id: 'hide_tough', qty: 5 }], blockCents: 95 },
    intro:
      "Lions hunt in a pride, which means while you're aiming at one, three are flanking you and the fourth is already bored and hungry. Bring down six. Keep your back to a rock and your arrows faster than their patience.",
    outro:
      "Six lions, and you kept your back to the rock the whole time, which is why you still have a back. You can manage a pack now — the hardest part of archery is remembering everything you're NOT aiming at.",
  },
  {
    id: 'q_fletch_11',
    title: 'Swarm Theory',
    giver: 'npc_forgotten_beastward',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'locust_swarm', need: 14, label: 'Scatter 14 locust swarms' }],
    rewards: { xp: { archery: 480 }, items: [{ id: 'wheat', qty: 10 }], blockCents: 70 },
    intro:
      "A locust swarm will strip a field to dirt in an hour and a man to opinions shortly after. You can't shoot a swarm, but you can shoot the core that holds it together. Fourteen cores. Protect the wheat; the wheat is the only one here with no enemies.",
    outro:
      "Fourteen swarm-cores, pierced, and each swarm fell apart into harmless bugs. The fields stand. You learned to shoot the thing that holds the problem together — a skill that works on crowds, too. File that away.",
  },
  {
    id: 'q_fletch_12',
    title: 'Strings Attached',
    giver: 'npc_greenwood_sapling_nib',
    regionId: 'greenwood',
    steps: [
      { kind: 'collect', target: 'hide_tough', need: 5, label: 'Cure 5 tough hides (bowstrings)' },
      { kind: 'collect', target: 'wood_ancient', need: 2, label: 'Season 2 ancient staves (for the bow)' },
    ],
    rewards: { xp: { archery: 500, tailoring: 100 }, items: [{ id: 'wood_ancient', qty: 1 }], blockCents: 90 },
    intro:
      "The arrow gets the glory; the string and the stave do the work and take the blame. Cure five tough hides into strings and season two ancient staves. A snapped string at the wrong moment is how archers become close-combat specialists, briefly.",
    outro:
      "Five strings, two staves, one bow that won't betray you mid-draw. You understand now that the loudest part of the shot is the least important. The quiet parts keep you alive. Build accordingly.",
  },
  {
    id: 'q_fletch_13',
    title: 'Drake Season',
    giver: 'survivor_petra',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'char_drake', need: 1, label: 'Ground the Char Drake' }],
    rewards: { xp: { archery: 820, vitality: 180 }, items: [{ id: 'crystal_cut', qty: 4 }], blockCents: 160 },
    intro:
      "The Char Drake owns the sky over the ashlands and charges a toll of fire to anyone who looks up. A sword is useless; it never lands. This is an archer's problem and an archer's glory. Ground it. Lead it like the biggest, angriest bat you'll ever see.",
    outro:
      "The Char Drake is grounded — permanently, and smoking. You led a flying mountain of spite and put an arrow where it mattered. The sky's open again. Look up without flinching; you earned the view.",
  },
  {
    id: 'q_fletch_14',
    title: 'Hounds of the Gloom',
    giver: 'npc_forgotten_marshal',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'gloomhound', need: 10, label: 'Put down 10 gloomhounds' }],
    rewards: { xp: { archery: 440 }, items: [{ id: 'hide_tough', qty: 4 }], blockCents: 70 },
    intro:
      "Gloomhounds hunt by fading in and out of the dark, so you're shooting a shadow that occasionally has teeth. Ten of them. Shoot where the dark is thickest; if you wait to see the hound clearly, you're seeing it from inside its mouth.",
    outro:
      "Ten gloomhounds, shot out of the dark before they finished arriving. You trust the shadow now instead of your eyes, which is backwards and correct. The gloom is just terrain to you these days.",
  },
  {
    id: 'q_fletch_15',
    title: 'The Glacier Takes Wing',
    giver: 'survivor_petra',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'wyvern_glacier', need: 1, label: 'Down the Glacier Wyvern' }],
    rewards: { xp: { archery: 900, defense: 200 }, items: [{ id: 'crystal_cut', qty: 5 }], blockCents: 190 },
    intro:
      "The Glacier Wyvern is the Char Drake's cold cousin — same altitude, same contempt, but it freezes your string to your fingers before it stoops. Down it. Keep your hands warm and your nerve colder than the thing hunting you.",
    outro:
      "The Glacier Wyvern fell out of its own sky, frozen string and all defeated by a hand that didn't shake. You've bracketed the heavens now — fire and ice, both grounded by the same archer. There's little left up there that scares you.",
  },
  {
    id: 'q_fletch_16',
    title: 'Over the Water',
    giver: 'honest_jim',
    regionId: 'beginnings',
    steps: [{ kind: 'kill', target: 'brinebat', need: 10, label: 'Drop 10 brine bats over the shallows' }],
    rewards: { xp: { archery: 320 }, items: [{ id: 'fish_salmon', qty: 3 }], blockCents: 45 },
    intro:
      "Brine bats skim the water so low that a low arrow skips off the surface and a high one sails over. There's a one-inch window and it's moving. Drop ten. Shooting over water humbles everybody; let it humble you cheaply.",
    outro:
      "Ten brine bats, threaded through that nasty one-inch window. Shooting over water is a special kind of cruel and you've made peace with it. Here's salmon — the bats were eating it, so, spoils.",
  },
  {
    id: 'q_fletch_17',
    title: 'Something Long in the Shallows',
    giver: 'honest_jim',
    regionId: 'beginnings',
    steps: [{ kind: 'kill', target: 'seaserpent', need: 1, label: 'Slay the Sea Serpent from the shore' }],
    rewards: { xp: { archery: 760, vitality: 160 }, items: [{ id: 'fish_salmon', qty: 5 }], blockCents: 150 },
    intro:
      "A sea serpent's moved into the bay and it only surfaces for a breath every so often, which is your only window to put an arrow down its throat. Slay it from the shore — get in the water and you're not an archer anymore, you're bait with good aim.",
    outro:
      "The Sea Serpent breathed its last breath at exactly the wrong moment for it and the right one for you. You never got your boots wet. That's the dream — solve the ocean's problem without joining the ocean. Fish is on the house.",
  },
  {
    id: 'q_fletch_18',
    title: 'The Marksman’s Ledger',
    giver: 'npc_forgotten_beastward',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'shadow_panther', need: 8, label: 'Outshoot 8 shadow panthers' },
      { kind: 'explore', target: 'forgotten', need: 1, label: 'Walk the far hunting grounds' },
    ],
    rewards: { xp: { archery: 620 }, items: [{ id: 'hide_tough', qty: 5 }], blockCents: 120 },
    intro:
      "Shadow panthers are the final exam of seeing: they're built from the exact color of 'you looked away'. Outshoot eight, then walk the far grounds and come back with a tally. A marksman's reputation is just a ledger of things that didn't see it coming.",
    outro:
      "Eight panthers, one long walk, one full ledger. Word's out: there's an archer in the far country who hits what's made of not-being-seen. That reputation is worth more than any bow. Guard it; it's the only thing you can't restring.",
  },

  // ═══════════════════════════════ ALCHEMY — brewing ═══════════════════════════════
  {
    id: 'q_brew_01',
    title: 'Swamp-Smelling Science',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [{ kind: 'collect', target: 'herb_green', need: 6, label: 'Gather 6 green herbs' }],
    rewards: { xp: { alchemy: 200, herbalism: 60 }, items: [{ id: 'potion_regret', qty: 1 }] },
    intro:
      "Alchemy is cooking for people who'd like to live forever and don't mind smelling like a swamp got a job. Bring six green herbs — the humble base of everything. Taste nothing. The first law of alchemy is 'the second ingredient is regret'.",
    outro:
      "Six green herbs, and you tasted none of them, which puts you ahead of every apprentice I've buried. Here's a Potion of Regret — don't drink it either. It's a teaching aid. The lesson is the name.",
  },
  {
    id: 'q_brew_02',
    title: 'Weeds, Industrially',
    giver: 'npc_greenwood_herbwife_tansy',
    regionId: 'greenwood',
    steps: [{ kind: 'gather', target: 'herb_patch', need: 10, label: 'Strip 10 herb patches' }],
    rewards: { xp: { alchemy: 220, herbalism: 80 }, items: [{ id: 'herb_green', qty: 6 }] },
    intro:
      "You can't brew what you haven't picked, and the good brews eat herbs by the armful. Strip ten patches. An alchemist with an empty satchel is just a nervous person standing near a cauldron.",
    outro:
      "Ten patches, stripped clean, satchel bulging. Now you've got something to ruin in the name of science. An alchemist's shelf should groan; yours is starting to. Good.",
  },
  {
    id: 'q_brew_03',
    title: 'Mostly Dinner, A Few Funerals',
    giver: 'npc_forgotten_apoth',
    regionId: 'forgotten',
    steps: [{ kind: 'gather', target: 'mushroom_cluster', need: 12, label: 'Pick 12 mushroom clusters' }],
    rewards: { xp: { alchemy: 280 }, items: [{ id: 'mushroom_brown', qty: 8 }], blockCents: 40 },
    intro:
      "Mushrooms come in two flavors: 'medicine' and 'your family invents a cautionary rhyme about you'. Pick twelve clusters. Don't sort them. That's my job and I'm the one with the antidote and the shovel.",
    outro:
      "Twelve clusters, and I've sorted them — mostly tonic, a couple that would've stopped your heart for the fun of it. Good picking. The rhyme about you will have to wait.",
  },
  {
    id: 'q_brew_04',
    title: 'The Blue and the Gold',
    giver: 'npc_capital_archivist',
    regionId: 'capital',
    steps: [
      { kind: 'collect', target: 'herb_blue', need: 8, label: 'Gather 8 blue herbs' },
      { kind: 'collect', target: 'herb_gold', need: 4, label: 'Gather 4 gold herbs' },
    ],
    rewards: { xp: { alchemy: 360, herbalism: 100 }, items: [{ id: 'herb_gold', qty: 2 }], blockCents: 55 },
    intro:
      "The blue herb hides its potency till dusk and the gold one only reveals itself to the patient and the slightly obsessive. Eight blue, four gold. These two are the backbone of every potion worth drinking and every poison worth fearing.",
    outro:
      "Eight blue, four gold, dusk and patience both honored. With these two on your shelf you can brew a cure or a curse, and the only difference is which drawer you reach for. Choose wisely. Or don't; I'm not your conscience.",
  },
  {
    id: 'q_brew_05',
    title: 'Reagents With Legs',
    giver: 'npc_forgotten_apoth',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'plague_rat', need: 12, label: 'Render 12 plague rats' }],
    rewards: { xp: { alchemy: 320 }, items: [{ id: 'herb_red', qty: 5 }], blockCents: 45 },
    intro:
      "Some reagents grow in the ground. Others scurry, and carry three diseases and a grudge. Render twelve plague rats — their glands make a fever-breaker, which is ironic given what else they carry. Wash your hands. With fire, ideally.",
    outro:
      "Twelve rats, rendered, and you only touched them with tongs — good instincts. The glands will break fevers in half the kingdom. The irony is not lost on me and it shouldn't be lost on you. Burn the gloves.",
  },
  {
    id: 'q_brew_06',
    title: 'Dust of Pale Wings',
    giver: 'npc_forgotten_apoth',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'deathmoth_pale', need: 10, label: 'Collect scale-dust from 10 deathmoths' }],
    rewards: { xp: { alchemy: 380 }, items: [{ id: 'herb_blue', qty: 5 }], blockCents: 55 },
    intro:
      "Pale deathmoth dust is a sedative so clean a surgeon would weep, and a poison so quiet an enemy would never. Ten moths. Don't inhale the dust — you'll sleep for a week and wake owing me rent on the cot.",
    outro:
      "Ten moths, ten pinches of dust, and you held your breath like a professional. Sleep-tonic for the dying, or worse for the deserving. The cot's free this time. Don't make a habit of breathing near your ingredients.",
  },
  {
    id: 'q_brew_07',
    title: 'Milking the Widow',
    giver: 'npc_ashen_quill',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'crypt_widow', need: 8, label: 'Extract venom from 8 crypt widows' }],
    rewards: { xp: { alchemy: 440 }, items: [{ id: 'crystal_shard', qty: 3 }], blockCents: 70 },
    intro:
      "Crypt widow venom is the base of the best antivenoms, which is alchemy's favorite joke: the cure is the thing that kills you, measured carefully. Extract from eight. 'Carefully' is doing enormous work in that sentence. Respect it.",
    outro:
      "Eight widows, eight vials of the stuff that cures what it causes. You measured carefully, which is why you can still count to eight on the original fingers. That's the whole trade: dosage is the difference between doctor and murderer.",
  },
  {
    id: 'q_brew_08',
    title: 'The Emperor’s Sting',
    giver: 'npc_ashen_quill',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'scorpion_emperor', need: 8, label: 'Harvest 8 emperor scorpion stingers' }],
    rewards: { xp: { alchemy: 520 }, items: [{ id: 'crystal_shard', qty: 4 }], blockCents: 90 },
    intro:
      "The emperor scorpion carries enough neurotoxin in one stinger to make a philosophical point to a golem. Harvest eight. Its tail is faster than your apology, so bring a long knife and shorter regrets.",
    outro:
      "Eight stingers, and your reflexes kept pace with the tail, barely. This toxin brews into a battlefield anesthetic or a very permanent nap, depending on your mood and the buyer's. Alchemy's never asked me which, and I've learned not to ask you.",
  },
  {
    id: 'q_brew_09',
    title: 'Bog Standard',
    giver: 'npc_forgotten_apoth',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'centipede_bog', need: 10, label: 'Render 10 bog centipedes' }],
    rewards: { xp: { alchemy: 360 }, items: [{ id: 'clay_lump', qty: 4 }], blockCents: 50 },
    intro:
      "Bog centipede oil keeps a potion from separating, which sounds boring until your healing draught turns into two layers of useless sludge overnight. Render ten. It's the unglamorous reagent that makes the glamorous ones behave.",
    outro:
      "Ten centipedes, ten measures of the oil nobody brags about. Your potions will hold together now instead of divorcing in the bottle. Alchemy is 10% genius and 90% things not separating. You've learned the 90%.",
  },
  {
    id: 'q_brew_10',
    title: 'Brimstone Bouquet',
    giver: 'survivor_petra',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'sulfur_sprite', need: 10, label: 'Trap 10 sulfur sprites' }],
    rewards: { xp: { alchemy: 420 }, items: [{ id: 'ore_copper', qty: 4 }], blockCents: 65 },
    intro:
      "Sulfur sprites are living matchsticks with attitude. Trap ten and bottle the brimstone — it's the kick in every explosive tonic and flash-bomb worth throwing. Cork them tight; a loose brimstone jar is how you redecorate a lab violently.",
    outro:
      "Ten sprites, ten jars of brimstone, all corked tight — no redecorating today. Your explosive tonics will actually explode on cue now instead of fizzling or, worse, waiting. Timing is everything with fire. Ask any archer. Or widow.",
  },
  {
    id: 'q_brew_11',
    title: 'Blood From a Stone (It’s Lava)',
    giver: 'survivor_petra',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'magma_blob', need: 8, label: 'Cool and tap 8 magma blobs' }],
    rewards: { xp: { alchemy: 500 }, items: [{ id: 'crystal_shard', qty: 4 }], blockCents: 85 },
    intro:
      "A magma blob's core, cooled fast, crystallizes into a reagent that holds heat like a grudge — perfect for brews that need to stay warm for days. Tap eight. Cool them too slow and they pop; too fast and they shatter; just right and you're clever. No pressure.",
    outro:
      "Eight blobs, cooled just right, their hot little hearts crystallized and bottled. Your warming-draughts will outlast a winter now. You threaded the line between 'pop' and 'shatter' eight times. That's not luck anymore. That's craft.",
  },
  {
    id: 'q_brew_12',
    title: 'Bloated and Bountiful',
    giver: 'npc_forgotten_apoth',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'tick_bloated', need: 12, label: 'Drain 12 bloated ticks' }],
    rewards: { xp: { alchemy: 400 }, items: [{ id: 'potion_regret', qty: 2 }], blockCents: 60 },
    intro:
      "I'm not going to dress this up: a bloated tick is a bag of blood with ambitions, and that blood is the best coagulant I know for wound-sealing paste. Drain twelve. Wear the apron. Wear the OTHER apron under that one.",
    outro:
      "Twelve ticks, drained, and both aprons earned their keep. The coagulant you've brought will seal wounds that would've ended people. It's foul work that saves lives — which is most of alchemy once you strip the pretty bottles off it.",
  },
  {
    id: 'q_brew_13',
    title: 'A Spoonful of Sugar',
    giver: 'npc_greenwood_cook_dill',
    regionId: 'greenwood',
    steps: [
      { kind: 'collect', target: 'berry_red', need: 8, label: 'Gather 8 red berries' },
      { kind: 'collect', target: 'food_honey', need: 3, label: 'Collect 3 honey' },
    ],
    rewards: { xp: { alchemy: 320, cooking: 100 }, items: [{ id: 'food_jelly', qty: 3 }], blockCents: 45 },
    intro:
      "Half of alchemy is making the cure taste like something other than a drowned toad. Bring eight red berries and three honey — the sweeteners that let a patient keep the medicine DOWN. A spat-out potion heals nobody but the floor.",
    outro:
      "Eight berries, three honey, and now your tonics go down like a treat instead of a threat. Patients will actually finish the dose. You'd be amazed how many great cures died on a bad flavor. Not yours.",
  },
  {
    id: 'q_brew_14',
    title: 'The Philosopher’s Rock',
    giver: 'npc_capital_magus',
    regionId: 'capital',
    steps: [
      { kind: 'gather', target: 'crystal_node', need: 6, label: 'Harvest 6 crystal nodes' },
      { kind: 'collect', target: 'crystal_shard', need: 5, label: 'Grind 5 crystal shards to catalyst' },
    ],
    rewards: { xp: { alchemy: 560, mining: 120 }, items: [{ id: 'crystal_cut', qty: 2 }], blockCents: 100 },
    intro:
      "Every alchemist eventually wants a catalyst — a stone that makes reactions happen faster without being used up, which is the closest alchemy comes to cheating. Six nodes, five shards ground to powder. Grind them finer than your patience; coarse catalyst just sits there judging you.",
    outro:
      "Six nodes, five shards, one catalyst ground fine enough to sulk about. Your reactions will fly now and the stone just watches, eternally smug and never spent. It's the most useful thing in your kit and it does nothing. Like a manager.",
  },
  {
    id: 'q_brew_15',
    title: 'Leech Essence',
    giver: 'npc_forgotten_apoth',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'bogleech', need: 10, label: 'Press 10 bogleeches' }],
    rewards: { xp: { alchemy: 440 }, items: [{ id: 'herb_red', qty: 4 }], blockCents: 65 },
    intro:
      "Bogleech essence thins blood, which is a miracle for the clotted and a catastrophe for the clumsy. Press ten. Mind the mouths — a bogleech doesn't know it's dead for a surprisingly long time, and it holds a grudge the whole while.",
    outro:
      "Ten bogleeches, pressed, and only a couple reminded you they were 'dead'. The essence will save anyone whose blood's gone to glue. Horrible little animals, marvelous medicine. That's the recurring theme here, isn't it.",
  },
  {
    id: 'q_brew_16',
    title: 'Puff Piece',
    giver: 'honest_jim',
    regionId: 'beginnings',
    steps: [{ kind: 'kill', target: 'pufferpup', need: 8, label: 'Harvest toxin from 8 pufferpups' }],
    rewards: { xp: { alchemy: 360 }, items: [{ id: 'fish_trout', qty: 4 }], blockCents: 50 },
    intro:
      "A pufferpup looks adorable and carries a toxin that numbs anything it touches — a godsend for surgery and a death sentence for appetizers. Harvest eight. The adorable ones are always the worst; put that on a sampler and hang it in your lab.",
    outro:
      "Eight pufferpups, toxin bottled, zero accidental numbings — your hands are steady and still fully feeling, which is the goal. Surgeons will bless you. Dinner guests should fear you. That's a good balance for an alchemist.",
  },
  {
    id: 'q_brew_17',
    title: 'Crucible Clay',
    giver: 'npc_beginnings_posey',
    regionId: 'beginnings',
    steps: [{ kind: 'gather', target: 'clay_pit', need: 10, label: 'Dig 10 clay pits' }],
    rewards: { xp: { alchemy: 240, mining: 80 }, items: [{ id: 'clay_lump', qty: 8 }] },
    intro:
      "You want to brew the hot, angry potions? Then you need crucibles that won't crack and spray your life's work across the ceiling. Dig ten clay pits. The best brew in the world is worthless in a vessel that gives up at the worst moment.",
    outro:
      "Ten pits of good firing clay. Now your crucibles will hold the mean brews without blooming into shrapnel. Alchemists obsess over reagents and forget the pot; the pot is why you still have eyebrows. Yours and mine both.",
  },
  {
    id: 'q_brew_18',
    title: 'Imps in the Ingredients',
    giver: 'prophet_karl',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'corpse_imp', need: 10, label: 'Banish 10 corpse imps from the stores' }],
    rewards: { xp: { alchemy: 420, magic: 80 }, items: [{ id: 'herb_gold', qty: 3 }], blockCents: 65 },
    intro:
      "Corpse imps have infested the reagent cellar and they're EATING the rare stock — I caught one halfway through a year's worth of gold herb, chewing with its mouth open. Banish ten before the inventory becomes a bar tab. Save what you can.",
    outro:
      "Ten corpse imps, banished mid-bite, and the gold herb's mostly saved. The cellar's ours again. An alchemist loses more to pests than to failed brews — guard the pantry like it's your firstborn, because it's worth more.",
  },
  {
    id: 'q_brew_19',
    title: 'The Magma Core',
    giver: 'survivor_petra',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'elem_magma', need: 6, label: 'Quench 6 magma elementals' }],
    rewards: { xp: { alchemy: 620 }, items: [{ id: 'crystal_cut', qty: 3 }], blockCents: 110 },
    intro:
      "A magma elemental's core is pure distilled heat — the single most volatile reagent an alchemist can own, and the one that makes the legendary brews legendary. Quench six. If one goes off in your satchel, they'll identify you by your dental records and your optimism.",
    outro:
      "Six magma cores, quenched and sealed, satchel intact, dental records un-needed. You're handling reagents that kill careless alchemists for sport, and you're not careless. The legendary brews are open to you now. Don't let it go to your eyebrows.",
  },
  {
    id: 'q_brew_20',
    title: 'The Cure for Absolutely Everything',
    giver: 'prophet_karl',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'wyrm_magma', need: 1, label: 'Harvest the Magma Wyrm’s heart-ash' },
      { kind: 'collect', target: 'herb_gold', need: 6, label: 'Gather 6 gold herbs' },
      { kind: 'collect', target: 'crystal_cut', need: 3, label: 'Set 3 cut crystals for the distillation' },
    ],
    rewards: { xp: { alchemy: 980, herbalism: 200, magic: 120 }, items: [{ id: 'food_cake', qty: 3 }], blockCents: 220 },
    intro:
      "They say a true alchemist brews a panacea — the cure for everything — exactly once, and the one ingredient that makes it work is the heart-ash of a slain Magma Wyrm, which is a polite way of saying 'go fight a volcano with opinions'. Heart-ash, six gold herbs, three set crystals. Brew the impossible. Then be unbearable about it.",
    outro:
      "One panacea. The cure for everything, glowing in a vial like it's keeping a secret from God. You fought a volcano, picked the patient herb, set the flawless crystal, and distilled a thing alchemists chase into their graves. Now spend the rest of your life being quietly, insufferably humble about it. Cake?",
  },

  // ═══════════════════════════════ TAILORING — stitching ═══════════════════════════════
  {
    id: 'q_stitch_01',
    title: 'The Needle Wins First',
    giver: 'npc_beginnings_posey',
    regionId: 'beginnings',
    steps: [{ kind: 'collect', target: 'hide_wolf', need: 6, label: 'Gather 6 wolf hides' }],
    rewards: { xp: { tailoring: 200 }, items: [{ id: 'hide_wolf', qty: 2 }] },
    intro:
      "Welcome to tailoring, where the first thing you make is friends with a needle and the needle's opening move is to stab you. Bring six wolf hides so we have something to ruin while you bleed and learn. Thimbles are for cowards and the elderly. You'll want one by Tuesday.",
    outro:
      "Six hides and several finger-stabs later, the needle has grudgingly accepted you. You're bleeding on the material less, which is the only metric that matters this week. The thimble's in the drawer. Pride is in the bin. Grab both.",
  },
  {
    id: 'q_stitch_02',
    title: 'Hide and Seek',
    giver: 'npc_beginnings_tobias',
    regionId: 'beginnings',
    steps: [{ kind: 'kill', target: 'ridgeback_hound', need: 8, label: 'Skin 8 ridgeback hounds' }],
    rewards: { xp: { tailoring: 260 }, items: [{ id: 'hide_tough', qty: 3 }], blockCents: 40 },
    intro:
      "A tailor who buys all their hide is a tailor who goes broke. Skin eight ridgeback hounds yourself — their hide's tough enough for work garments and thin enough to actually sew. Learn which cut is worth keeping; half a carcass is just mess.",
    outro:
      "Eight hounds, skinned clean, and you kept only the hide worth keeping. That eye for the good cut is half the trade — the other half is the stabbing, which continues. Your garments won't fall apart at the seams now. Just the budget.",
  },
  {
    id: 'q_stitch_03',
    title: 'Tough as Old Boots, Again',
    giver: 'npc_ironhold_quartermaster_odo',
    regionId: 'ironhold',
    steps: [
      { kind: 'collect', target: 'hide_tough', need: 5, label: 'Cure 5 tough hides' },
      { kind: 'collect', target: 'hide_boar', need: 4, label: 'Cure 4 boar hides' },
    ],
    rewards: { xp: { tailoring: 360 }, items: [{ id: 'hide_tough', qty: 4 }], blockCents: 55 },
    intro:
      "Cloth is for pillows and poets. The garrison needs LEATHER that stops a knife and outlives its wearer. Five tough hides, four boar, cured right. Cure them wrong and the whole watch dresses like a pillow fort, and pillow forts lose wars.",
    outro:
      "Five tough, four boar, cured hard as a sergeant's heart. The garrison's kit will turn a blade and outlast the man inside it. Nobody's dressing like soft furnishings on your watch. Odo almost nods, which is a tailor's knighthood.",
  },
  {
    id: 'q_stitch_04',
    title: 'Boarderline Personality',
    giver: 'npc_beginnings_tobias',
    regionId: 'beginnings',
    steps: [{ kind: 'kill', target: 'dire_boar', need: 8, label: 'Hunt 8 dire boars' }],
    rewards: { xp: { tailoring: 320 }, items: [{ id: 'hide_boar', qty: 5 }, { id: 'food_jerky', qty: 2 }] },
    intro:
      "Dire boar hide is the best cheap armor-leather there is, and the boar is the worst-tempered way to get it. Hunt eight. They charge, they don't bluff, and they take the loss of their hide as a personal betrayal even after they're jerky. Fair enough.",
    outro:
      "Eight dire boars, eight prime hides, and a bit of jerky for the road. That leather will armor half the village cheaply and well. The boars would be furious. They were already furious. It's really their defining feature.",
  },
  {
    id: 'q_stitch_05',
    title: 'Bear With Me',
    giver: 'npc_forgotten_beastward',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'grizzled_bruin', need: 6, label: 'Take 6 grizzled bruin pelts' }],
    rewards: { xp: { tailoring: 440 }, items: [{ id: 'hide_tough', qty: 5 }], blockCents: 75 },
    intro:
      "A grizzled bruin pelt makes a winter coat that laughs at blizzards, and the bruin makes the acquisition a once-in-a-lifetime event, usually your last. Take six pelts. Approach downwind, strike sure, and remember the bruin has done this before and is still here.",
    outro:
      "Six bruin pelts, and you're still here to stitch them, which the bruins would call cheating. These coats will shrug off a killing winter. You went into the cold after the thing that owns the cold and came back with its coat. That's tailoring with teeth.",
  },
  {
    id: 'q_stitch_06',
    title: 'The Cave Had Opinions',
    giver: 'npc_forgotten_beastward',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'cave_bear', need: 6, label: 'Take 6 cave bear hides' }],
    rewards: { xp: { tailoring: 500 }, items: [{ id: 'hide_tough', qty: 5 }], blockCents: 90 },
    intro:
      "A cave bear is a grizzled bruin that moved somewhere dark and got meaner about it. Its hide is thicker, warmer, and defended more aggressively. Six of them. Bring a torch for the cave and your nerve for the bear; you'll need both and the bear knows the cave better.",
    outro:
      "Six cave bear hides, hauled out of the dark past the thing that owned it. This is the warmest, toughest leather short of dragon, and you earned every square inch in a place where the bear had every advantage. Stitch something that deserves it.",
  },
  {
    id: 'q_stitch_07',
    title: 'Fur Coat, No Knickers',
    giver: 'npc_capital_marketeer',
    regionId: 'capital',
    steps: [{ kind: 'kill', target: 'shadow_panther', need: 8, label: 'Take 8 shadow panther pelts' }],
    rewards: { xp: { tailoring: 560 }, items: [{ id: 'crystal_shard', qty: 4 }], blockCents: 110 },
    intro:
      "The court wants shadow panther fur — the one pelt that's a different color depending on how guilty you feel looking at it. Eight pelts for a cloak no noble needs and every noble will fight over. Fashion is just war with better lighting. Go to war.",
    outro:
      "Eight panther pelts, each one a cloak the nobility will bankrupt themselves over. You've made something useless and devastating, which is haute couture in two words. The court will adore you and mean none of it. Perfect. You're a real tailor now.",
  },
  {
    id: 'q_stitch_08',
    title: 'Lynx in the Chain',
    giver: 'npc_greenwood_beastmaster_oona',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'thicket_lynx', need: 10, label: 'Take 10 thicket lynx pelts' }],
    rewards: { xp: { tailoring: 420 }, items: [{ id: 'hide_tough', qty: 4 }], blockCents: 65 },
    intro:
      "Thicket lynx fur trims gloves and collars — the fiddly bits where cheap fur shows and quality whispers. Take ten pelts. The lynx hides in the brush and bolts, so you'll earn these in scratches and swearing. The gloves will be worth it. The swearing is free.",
    outro:
      "Ten lynx pelts, earned in scratches and language I'll pretend I didn't hear. Your collars and cuffs will whisper 'expensive' now instead of shouting 'thrift'. The details are where tailors are judged. You've started winning the judgment.",
  },
  {
    id: 'q_stitch_09',
    title: 'Pulling the Wool',
    giver: 'npc_forgotten_beastward',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'crag_ram', need: 8, label: 'Shear 8 crag rams (the hard way)' }],
    rewards: { xp: { tailoring: 380 }, items: [{ id: 'hide_tough', qty: 3 }], blockCents: 55 },
    intro:
      "Crag ram wool is warm, water-shedding, and attached to an animal that headbutts boulders for recreation. 'Shear' eight — and I use the word loosely, since the ram has strong feelings about the arrangement. Mind the horns; they've retired shepherds twice your size.",
    outro:
      "Eight crag rams, 'sheared', your ribs intact despite the horns' best efforts. This wool spins into cloth that keeps rain out and warmth in — the backbone of any garment meant for weather. The rams are furious and bald. Priorities.",
  },
  {
    id: 'q_stitch_10',
    title: 'Dyeing to Impress',
    giver: 'npc_greenwood_herbwife_tansy',
    regionId: 'greenwood',
    steps: [
      { kind: 'gather', target: 'berry_bush', need: 12, label: 'Pick 12 berry bushes (for dye)' },
      { kind: 'collect', target: 'berry_red', need: 8, label: 'Mash 8 red berries into pigment' },
    ],
    rewards: { xp: { tailoring: 340, farming: 100 }, items: [{ id: 'berry_red', qty: 10 }], blockCents: 50 },
    intro:
      "A garment's cut gets the respect; the color gets the sale. Pick twelve berry bushes and mash eight red berries into dye. Get the mordant wrong and your rich crimson rinses out to 'apologetic pink' in the first rain. Dye like the weather's watching.",
    outro:
      "Twelve bushes, eight berries, one crimson that'll survive a monsoon and a jealous rival. Color is the first thing anyone sees and the last thing a cheap tailor masters. You've got it early. The weather can't embarrass you now.",
  },
  {
    id: 'q_stitch_11',
    title: 'Loom With a View',
    giver: 'npc_capital_marketeer',
    regionId: 'capital',
    steps: [
      { kind: 'collect', target: 'wood_ancient', need: 2, label: 'Season 2 ancient timbers (for the loom)' },
      { kind: 'collect', target: 'crystal_shard', need: 4, label: 'Set 4 crystal shards (for the heddles)' },
    ],
    rewards: { xp: { tailoring: 480, woodcutting: 100 }, items: [{ id: 'crystal_cut', qty: 2 }], blockCents: 85 },
    intro:
      "You've outgrown hand-stitching rags. Time for a real loom: two seasoned ancient timbers for the frame, four crystal shards for the heddles so the threads don't snarl. A snarled warp is a day lost and a tailor cursing the gods by name. Build it right.",
    outro:
      "Two timbers, four crystal heddles, one loom that won't snarl your warp or your temper. You can weave your own cloth now instead of buying it marked up by smug merchants. A tailor with a loom is a tailor with power. Wield it. Gently. It's precise.",
  },
  {
    id: 'q_stitch_12',
    title: 'Silk From the Recluse',
    giver: 'npc_greenwood_beastmaster_oona',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'spider_recluse', need: 10, label: 'Harvest silk from 10 recluse spiders' }],
    rewards: { xp: { tailoring: 520 }, items: [{ id: 'crystal_shard', qty: 4 }], blockCents: 95 },
    intro:
      "Recluse silk is stronger than steel thread and lighter than a lie, which makes it the finest material a tailor can work and the spider least willing to share. Harvest from ten. The recluse bites, the bite rots, and the silk is worth it anyway. That's the whole pitch.",
    outro:
      "Ten recluses, ten skeins of silk stronger than steel and smug about it. Woven right, this makes garments that stop a blade and weigh nothing. You bled a little for it. All the best thread costs a little blood. Usually the tailor's.",
  },
  {
    id: 'q_stitch_13',
    title: 'The Widow’s Weave',
    giver: 'npc_ashen_quill',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'crypt_widow', need: 8, label: 'Harvest silk from 8 crypt widows' }],
    rewards: { xp: { tailoring: 580 }, items: [{ id: 'crystal_cut', qty: 3 }], blockCents: 105 },
    intro:
      "Crypt widow silk is black, cold to the touch, and takes enchantment like silk takes nothing else — the only thread worth weaving into a mage's robe. Harvest from eight. The widow is faster than you'd hope and more patient than you'd like. Don't get wrapped; the silk is lovely from the outside only.",
    outro:
      "Eight widows, eight skeins of that cold black silk that drinks enchantment like water. Robes woven from this will hold a spell for a lifetime. You went into the crypt and came out with the thread instead of becoming part of the décor. That's the job.",
  },
  {
    id: 'q_stitch_14',
    title: 'Pray and Splay',
    giver: 'npc_greenwood_beastmaster_oona',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'mantis_prayer', need: 8, label: 'Harvest 8 prayer mantises (for chitin needles)' }],
    rewards: { xp: { tailoring: 440 }, items: [{ id: 'hide_tough', qty: 4 }], blockCents: 70 },
    intro:
      "A prayer mantis forelimb, cleaned and sharpened, makes the finest needle you'll ever stab yourself with — thin, strong, and already shaped like regret. Harvest eight. They're called 'prayer' mantises because that's what you'll do when one turns around mid-harvest. Amen.",
    outro:
      "Eight mantises, eight needles sharper than anything a smith could draw. Your fine work just got finer — and so did the stabbing, which is now surgical. The mantis prayed. The mantis's prayers went unanswered. Yours, apparently, did not.",
  },
  {
    id: 'q_stitch_15',
    title: 'The Banner of the Colossus',
    giver: 'npc_capital_marketeer',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'tomb_colossus', need: 1, label: 'Fell the Tomb Colossus for its shroud-cloth' },
      { kind: 'collect', target: 'crystal_cut', need: 3, label: 'Set 3 cut crystals into the weave' },
    ],
    rewards: { xp: { tailoring: 940, defense: 200 }, items: [{ id: 'food_cake', qty: 3 }], blockCents: 220 },
    intro:
      "The Tomb Colossus is wrapped in a mile of ancient shroud-cloth that no loom alive can reproduce — thread spun before the kingdom had a name. Fell it, claim the cloth, and set three crystals into the weave. Make the court a banner so fine it ends the argument about who the best tailor is. The argument is you. Prove it.",
    outro:
      "The Tomb Colossus is unwrapped and horizontal, and you're holding a mile of thread older than history, crystal-set and flawless. The banner you'll weave will hang over the throne room and settle the 'best tailor' debate for a generation. You went to a tomb for cloth and came back a legend with a needle. Cake, master. You've earned the whole thing.",
  },
]

/** Chains so each craft reads as a progression, not a pile of errands. */
const prereqs: Record<string, readonly string[]> = {
  // MAGIC — arcane study
  q_arcane_02: ['q_arcane_01'],
  q_arcane_03: ['q_arcane_02'],
  q_arcane_04: ['q_arcane_03'],
  q_arcane_05: ['q_arcane_04'],
  q_arcane_06: ['q_arcane_05'],
  q_arcane_07: ['q_arcane_06'],
  q_arcane_08: ['q_arcane_07'],
  q_arcane_10: ['q_arcane_09'],
  q_arcane_11: ['q_arcane_10'],
  q_arcane_12: ['q_arcane_11'],
  q_arcane_14: ['q_arcane_13'],
  q_arcane_15: ['q_arcane_05'],
  q_arcane_18: ['q_arcane_06', 'q_arcane_07'],
  q_arcane_19: ['q_arcane_12', 'q_arcane_14'],
  q_arcane_20: ['q_arcane_08', 'q_arcane_19'],
  // ARCHERY — fletching
  q_fletch_02: ['q_fletch_01'],
  q_fletch_03: ['q_fletch_02'],
  q_fletch_04: ['q_fletch_03'],
  q_fletch_05: ['q_fletch_03'],
  q_fletch_06: ['q_fletch_05'],
  q_fletch_08: ['q_fletch_07'],
  q_fletch_10: ['q_fletch_09'],
  q_fletch_12: ['q_fletch_02'],
  q_fletch_13: ['q_fletch_10', 'q_fletch_12'],
  q_fletch_15: ['q_fletch_13'],
  q_fletch_17: ['q_fletch_16'],
  q_fletch_18: ['q_fletch_10', 'q_fletch_14'],
  // ALCHEMY — brewing
  q_brew_02: ['q_brew_01'],
  q_brew_03: ['q_brew_02'],
  q_brew_04: ['q_brew_02'],
  q_brew_06: ['q_brew_05'],
  q_brew_08: ['q_brew_07'],
  q_brew_11: ['q_brew_10'],
  q_brew_14: ['q_brew_04'],
  q_brew_19: ['q_brew_11'],
  q_brew_20: ['q_brew_14', 'q_brew_19'],
  // TAILORING — stitching
  q_stitch_02: ['q_stitch_01'],
  q_stitch_03: ['q_stitch_02'],
  q_stitch_04: ['q_stitch_02'],
  q_stitch_06: ['q_stitch_05'],
  q_stitch_07: ['q_stitch_06'],
  q_stitch_11: ['q_stitch_10'],
  q_stitch_13: ['q_stitch_12'],
  q_stitch_15: ['q_stitch_11', 'q_stitch_13'],
}

/** Display names for reward/collect ids that may not carry a catalog name. */
const itemNames: Record<string, string> = {
  crystal_raw: 'Raw Crystal',
  crystal_shard: 'Crystal Shard',
  crystal_cut: 'Cut Crystal',
  herb_blue: 'Blue Herb',
  herb_gold: 'Gold Herb',
  herb_red: 'Red Herb',
  wood_ancient: 'Ancient Timber',
  hide_tough: 'Tough Hide',
  hide_boar: 'Boar Hide',
  clay_lump: 'Clay Lump',
  ore_copper: 'Copper Ore',
  bar_copper: 'Copper Bar',
  potion_regret: 'Potion of Regret',
  food_honey: 'Jar of Honey',
  food_jelly: 'Sweet Jelly',
  fish_trout: 'River Trout',
  fish_salmon: 'Silver Salmon',
}

registerPack({ quests, prereqs, itemNames })
