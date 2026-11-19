/**
 * questmega_beast_hunt — the "Hunters' Lodge" bounty pack (~75 quests).
 *
 * One giant beast-hunting arc: hides, shells, chitin, bones, cores and
 * bounties off the new menagerie of beasts, undead, fiends, constructs,
 * insects, aquatics, elementals and dragons. Every KILL target is a real
 * base or new species id; every GATHER target is a real node kind; every
 * COLLECT/reward item id is a real catalog material/food; every EXPLORE
 * target is a real region id. No new items, armor pieces, meshes or recipes
 * are introduced — rewards are materials, food, gold (blockCents) and skill
 * XP (scaling toward the 999 cap for the late dragon chains).
 *
 * Side-effect: registers at import time via registerPack({ quests, prereqs,
 * itemNames }). Imported (later) from src/content/index.ts.
 */
import { registerPack } from './packs'
import type { QuestDef } from '../types'

const quests: QuestDef[] = [
  // ═══════════════════════════════════════════════════════════════════════
  // I. THE LODGE OPENS — small-game beasts around Greenwood / the frontier
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_beast_hunt_01',
    title: 'Welcome to the Lodge',
    giver: 'ranger_kael',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'meadow_fawn', need: 6, label: 'Cull 6 meadow fawns' }],
    rewards: { xp: { attack: 120 }, items: [{ id: 'hide_wolf', qty: 4 }, { id: 'food_jerky', qty: 2 }], blockCents: 20 },
    intro:
      "So you want to be a hunter. Cute. Everyone starts on fawns — doe-eyed, soft, completely edible, and they will trample your lunch without a hint of remorse. Six hides. Try not to cry; they can smell it and they WILL exploit it.",
    outro:
      "Six fawns, six hides, zero tears that I witnessed. You're officially the Lodge's problem now. Here's some jerky — it's a fawn that quit earlier than these did.",
  },
  {
    id: 'q_beast_hunt_02',
    title: 'Lynx, Not Jinx',
    giver: 'ranger_kael',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'thicket_lynx', need: 5, label: 'Hunt 5 thicket lynxes' }],
    rewards: { xp: { attack: 160, archery: 60 }, items: [{ id: 'hide_tough', qty: 3 }], blockCents: 30 },
    intro:
      "The thicket lynxes have been 'relocating' chickens — to inside themselves. Five of them. They're quiet, they're smug, and they think the forest belongs to anything with better cheekbones than you. It does not. Prove it.",
    outro:
      "Five lynxes, correctly humbled. Those spotted hides fetch a price that'd make a noble blush. The chickens have erected a tiny statue in your honor. It's a scarecrow. Close enough.",
  },
  {
    id: 'q_beast_hunt_03',
    title: 'Tundra Foxtrot',
    giver: 'scout_wren',
    regionId: 'greenwood',
    steps: [
      { kind: 'kill', target: 'tundra_fox', need: 7, label: 'Trap 7 tundra foxes' },
      { kind: 'collect', target: 'hide_wolf', need: 5, label: 'Turn in 5 pelts to the tanner' },
    ],
    rewards: { xp: { attack: 140 }, items: [{ id: 'food_pie', qty: 2 }, { id: 'herb_green', qty: 4 }], blockCents: 35 },
    intro:
      "Tundra foxes wandered down with the cold front and discovered we keep food in buildings, which blew their tiny minds. Seven of them, then haul the pelts to the tanner. White fur sells. Sentiment doesn't.",
    outro:
      "Seven foxes outfoxed. The tanner says your pelts are 'acceptable', which from him is a marriage proposal. Winter'll be warmer for someone — not the foxes, obviously, but someone.",
  },
  {
    id: 'q_beast_hunt_04',
    title: 'Hound of the Ridgeline',
    giver: 'scout_wren',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'ridgeback_hound', need: 6, label: 'Put down 6 ridgeback hounds' }],
    rewards: { xp: { attack: 200, defense: 80 }, items: [{ id: 'hide_tough', qty: 4 }], blockCents: 40 },
    intro:
      "Ridgeback hounds run in packs and bite in committees. A traveler lost a boot, a sock, AND the foot's dignity. Six of them. Watch the flanks — they coordinate better than our actual town council, which isn't saying much, but still.",
    outro:
      "Six hounds, pack disbanded. The traveler has stopped hopping dramatically about it. Those tough hides are good armor backing — the Lodge thanks you, the hounds abstain.",
  },
  {
    id: 'q_beast_hunt_05',
    title: 'Boaring Day at the Office',
    giver: 'ranger_kael',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'dire_boar', need: 5, label: 'Gore-proof the woods: 5 dire boars' }],
    rewards: { xp: { attack: 240, vitality: 100 }, items: [{ id: 'hide_boar', qty: 5 }, { id: 'food_jerky', qty: 3 }], blockCents: 45 },
    intro:
      "Dire boars: imagine a regular boar that went to the gym exclusively to resent you. Five of them are rototilling the orchard and the orchardist is weeping into his cider. Bring me boar hides. Thick ones. The kind that stop an argument.",
    outro:
      "Five boars, five beautiful hides, one orchardist who has stopped crying and started gloating. Boar leather outlives its owner, usually because the owner picks fights. Wear it. Pick fights.",
  },
  {
    id: 'q_beast_hunt_06',
    title: 'Panther Management',
    giver: 'ranger_kael',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'shadow_panther', need: 4, label: 'Hunt 4 shadow panthers' }],
    rewards: { xp: { attack: 280, archery: 120 }, items: [{ id: 'hide_tough', qty: 5 }], blockCents: 60 },
    intro:
      "Shadow panthers are the reason the night shift quit. You don't see them until you're already their business. Four. If you survive, the pelts are worth a fortune and the bragging rights are priceless, which is lucky, because bragging is all some of you have.",
    outro:
      "Four panthers, dragged into the light where they frankly hate being. Those pelts are so black they look like a hole in the world. Nobles will pay to wrap themselves in your hard work. Let them.",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // II. BIG GAME — the apex beasts, a proper hunter's gauntlet
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_beast_hunt_07',
    title: 'The Grizzled Truth',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'grizzled_bruin', need: 3, label: 'Face down 3 grizzled bruins' }],
    rewards: { xp: { attack: 320, vitality: 160 }, items: [{ id: 'hide_tough', qty: 6 }, { id: 'food_honey', qty: 2 }], blockCents: 70 },
    intro:
      "A grizzled bruin ate my beehive, my spare beehive, and the sign that said 'please do not eat the beehives'. Three of them patrol the frontier like landlords. End the lease. Bring hides AND whatever honey they haven't digested. I'm owed.",
    outro:
      "Three bruins, de-landlorded. You recovered honey from a bear's dubious custody — that's not a sentence most people walk away from. The frontier is three bears quieter. I almost have to talk to you now. Almost.",
  },
  {
    id: 'q_beast_hunt_08',
    title: 'Pack Mentality',
    giver: 'scout_wren',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'pack_raptor', need: 8, label: 'Scatter 8 pack raptors' }],
    rewards: { xp: { attack: 300, archery: 140 }, items: [{ id: 'hide_tough', qty: 4 }], blockCents: 55 },
    intro:
      "Pack raptors hunt in threes, flank in sixes, and open doors — yes, DOORS — which is deeply upsetting for a bird with opinions. Eight of them. Keep your back to something solid or they'll audition it.",
    outro:
      "Eight raptors, flanking maneuver cancelled. The ones that opened doors have been shown the exit, permanently. We've since installed a second lock. On a bird. This is our life now.",
  },
  {
    id: 'q_beast_hunt_09',
    title: 'A Stag Do',
    giver: 'ranger_kael',
    regionId: 'greenwood',
    steps: [
      { kind: 'kill', target: 'horned_stag', need: 5, label: 'Take 5 horned stags' },
      { kind: 'collect', target: 'hide_boar', need: 3, label: 'Deliver 3 cured hides' },
    ],
    rewards: { xp: { attack: 260 }, items: [{ id: 'food_pie', qty: 3 }, { id: 'wood_oak', qty: 4 }], blockCents: 50 },
    intro:
      "Horned stags are majestic, noble, and they will put a tine through your spleen for standing near their favorite shrub. Five. Majesty is not a defense I accept. Bring hides; the antlers you can keep as a hat rack for your many regrets.",
    outro:
      "Five stags, all majesty expended. The shrub lives. You live. The spleens of the realm are marginally safer. Noble beasts make noble leather and, apparently, noble stew.",
  },
  {
    id: 'q_beast_hunt_10',
    title: 'Laughing Last',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'savanna_hyena', need: 7, label: 'Silence 7 savanna hyenas' }],
    rewards: { xp: { attack: 280, defense: 100 }, items: [{ id: 'hide_tough', qty: 4 }], blockCents: 50 },
    intro:
      "Savanna hyenas laugh. At everything. At YOU. At the concept of personal space. Seven of them cackle outside my hut from dusk till I lose my mind, whichever comes first. Make them stop. I want to hear the wind be sad again, like me.",
    outro:
      "Seven hyenas, and the cackling has ceased. The silence is so pure I can hear my own disappointment echo, which is how I like it. You've given a hermit the gift of nothing. Treasure the hides. Leave.",
  },
  {
    id: 'q_beast_hunt_11',
    title: 'Ram Raid',
    giver: 'foreman_dagna',
    regionId: 'ironhold',
    steps: [{ kind: 'kill', target: 'crag_ram', need: 6, label: 'Headbutt-proof the pass: 6 crag rams' }],
    rewards: { xp: { attack: 300, defense: 180 }, items: [{ id: 'hide_tough', qty: 5 }, { id: 'ore_iron', qty: 4 }], blockCents: 55 },
    intro:
      "Crag rams headbutt EVERYTHING. Rocks. Carts. The idea of the number six, which is why I need six of them gone — they'd argue. They've dented three ore wagons and a miner's entire personality. Deal with them before the wagons unionize.",
    outro:
      "Six rams, zero new dents. The wagons are intact, the miner's personality is recovering in a quiet room. Ram-hide's tough as a grudge and I've got plenty of those to compare it to. Good.",
  },
  {
    id: 'q_beast_hunt_12',
    title: 'Frost Bite, Literally',
    giver: 'prospector_finn',
    regionId: 'ironhold',
    steps: [{ kind: 'kill', target: 'frost_lynx', need: 5, label: 'Hunt 5 frost lynxes' }],
    rewards: { xp: { attack: 320, archery: 100 }, items: [{ id: 'hide_tough', qty: 4 }, { id: 'crystal_raw', qty: 3 }], blockCents: 60 },
    intro:
      "Frost lynxes den up high where the air bites back. Five pelts — the frost ones grow crystal in the fur, nobody knows why, nobody's asked politely. Bring me pelts AND whatever crystal you shake loose. I'll sell both and feel nothing.",
    outro:
      "Five frost lynxes, and look — crystal in the fur, clean as a lie. Finn's Pelt-and-Rock Emporium thanks you. The lynxes don't, on account of being inventory now.",
  },
  {
    id: 'q_beast_hunt_13',
    title: 'The King of Nothing',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'savanna_lion', need: 4, label: 'Dethrone 4 savanna lions' }],
    rewards: { xp: { attack: 400, vitality: 180 }, items: [{ id: 'hide_tough', qty: 6 }, { id: 'food_jerky', qty: 3 }], blockCents: 80 },
    intro:
      "Savanna lions call themselves kings of the frontier. Kings of WHAT? Dust? Four of them nap eighteen hours a day and expect tribute for the privilege of watching. Four pelts. Royalty is just confidence plus teeth, and you've got a sword.",
    outro:
      "Four lions, four abdications. Turns out the crown was just a mane and a bad attitude. The frontier has no king now, which is how frontiers prefer it. Regal pelts, peasant price. Beautiful.",
  },
  {
    id: 'q_beast_hunt_14',
    title: 'Bear With Me',
    giver: 'scout_wren',
    regionId: 'ironhold',
    steps: [
      { kind: 'explore', target: 'ironhold', need: 1, label: 'Scout the Ironhold cave mouths' },
      { kind: 'kill', target: 'cave_bear', need: 4, label: 'Clear 4 cave bears' },
    ],
    rewards: { xp: { attack: 420, defense: 200 }, items: [{ id: 'hide_tough', qty: 7 }, { id: 'bar_iron', qty: 2 }], blockCents: 85 },
    intro:
      "Cave bears moved into the old shafts and declared them a 'den', which is bear for 'no'. Scout the cave mouths first — I'm not sending you in blind, I'm not a monster, the bears handle that. Then four bears. Bring the big hides.",
    outro:
      "Shafts scouted, four cave bears evicted. Miners can work without being a snack again. Cave-bear hide could stop a battering ram; you could stop a cave bear. We're all very impressed and slightly concerned.",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // III. GRAVE WORK — undead hides, bone, and shroud off the Ashen/Forgotten
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_beast_hunt_15',
    title: 'Grave Expectations',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'ghoul_grave', need: 8, label: 'Re-bury 8 grave ghouls' }],
    rewards: { xp: { attack: 300, magic: 100 }, items: [{ id: 'food_pie', qty: 2 }, { id: 'potion_regret', qty: 1 }], blockCents: 45 },
    intro:
      "The grave ghouls are redecorating. With exhumed decor. It's a whole LOOK and I hate it. Eight of them, back underground, firmly. Don't let them bite you — their table manners are the LEAST of what's wrong in there. Gerald agrees.",
    outro:
      "Eight ghouls re-interred and the decor is, mercifully, back to 'tasteful dirt'. You handled it. Here — a pie, recently sourced, and a Potion of Regret in case you think too hard about where ghouls get their furniture.",
  },
  {
    id: 'q_beast_hunt_16',
    title: 'Crawl Space',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'gravecrawler', need: 10, label: 'Stomp 10 gravecrawlers' }],
    rewards: { xp: { attack: 260 }, items: [{ id: 'crystal_shard', qty: 2 }, { id: 'food_jelly', qty: 2 }], blockCents: 40 },
    intro:
      "Gravecrawlers. Picture a hand. Now take away the person. Now give it OPINIONS and the ability to scuttle. Ten of them have infested the crypt floor and they keep high-fiving my ankles uninvited. Stomp them flat.",
    outro:
      "Ten gravecrawlers, flattened to a polite smear. My ankles are un-high-fived and life has meaning again. You get jelly. Don't ask what color it started as. The crystals, at least, are honest.",
  },
  {
    id: 'q_beast_hunt_17',
    title: 'Mothballed',
    giver: 'mage_lyra',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'deathmoth_pale', need: 9, label: 'Net 9 pale deathmoths' },
      { kind: 'collect', target: 'crystal_shard', need: 3, label: 'Hand over 3 dust-caked shards' },
    ],
    rewards: { xp: { magic: 240, archery: 120 }, items: [{ id: 'crystal_cut', qty: 2 }, { id: 'herb_blue', qty: 4 }], blockCents: 55 },
    intro:
      "Pale deathmoths eat light. Literally. My reading lamp is a ghost of itself and my treatise is now a treatise on 'why is it so dark'. Nine moths, and gather the shards they powder — the dust refracts beautifully once you stop sneezing.",
    outro:
      "Nine moths, and the lamps dare to glow again. The dust-shards cut into gorgeous little prisms — chapter twelve is saved, and chapter twelve owed me money. Take the cut crystal. You've got a scholar's gratitude, which is thin but sincere.",
  },
  {
    id: 'q_beast_hunt_18',
    title: 'Rat King Cometh',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'plague_rat', need: 12, label: 'Exterminate 12 plague rats' }],
    rewards: { xp: { attack: 240, vitality: 120 }, items: [{ id: 'potion_regret', qty: 1 }, { id: 'food_pie', qty: 2 }], blockCents: 40 },
    intro:
      "Plague rats. They don't bite you, they NEGOTIATE with your immune system and it loses. Twelve of them, running a black market in diseases I've never even heard of. Clear them before they franchise. Hold your breath. Hold ALL your breaths.",
    outro:
      "Twelve plague rats, out of business. The crypt air has gone from 'actively hostile' to merely 'unpleasant', which I'm counting as a triumph. Wash everything you own. Twice. Then burn the second washing.",
  },
  {
    id: 'q_beast_hunt_19',
    title: 'Imp of the Grave',
    giver: 'prophet_karl',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'corpse_imp', need: 8, label: 'Banish 8 corpse imps' }],
    rewards: { xp: { magic: 320, attack: 100 }, items: [{ id: 'crystal_shard', qty: 3 }, { id: 'potion_regret', qty: 1 }], blockCents: 55 },
    intro:
      "Corpse imps are what happens when an imp dies and files an appeal. Eight of them, puppeteering the dead like grim little playwrights. Banish them. Loudly. With conviction. A half-hearted banishment just teaches them your name.",
    outro:
      "Eight corpse imps, appeal denied, case closed. The dead they were operating have gone slack and grateful. You banish with real diaphragm support — the dungeon acoustics loved it. Here, crystal. Don't dwell on the 'corpse' part.",
  },
  {
    id: 'q_beast_hunt_20',
    title: 'Spectre Inspector',
    giver: 'gravekeeper_sol',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'ash_spectre', need: 7, label: 'Dispel 7 ash spectres' }],
    rewards: { xp: { magic: 360, defense: 120 }, items: [{ id: 'crystal_cut', qty: 2 }, { id: 'food_cake', qty: 1 }], blockCents: 60 },
    intro:
      "Ash spectres are grudges that outlived their owners and kept the receipts. Seven of them haunt the burned wing, replaying their worst days for an audience of none. Give them the ending they want: an ending. Dispel seven.",
    outro:
      "Seven spectres, dispelled, finally off the clock after who-knows-how-long of unpaid haunting. The burned wing is just a wing now — tragic, but quiet. Have a cake. The living should eat cake. The dead were very clear on that.",
  },
  {
    id: 'q_beast_hunt_21',
    title: 'Pale and Interesting',
    giver: 'prophet_karl',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'wraith_pale', need: 6, label: 'Unmake 6 pale wraiths' },
      { kind: 'explore', target: 'forgotten', need: 1, label: 'Walk the Forgotten barrow-line' },
    ],
    rewards: { xp: { magic: 420, attack: 140 }, items: [{ id: 'crystal_cut', qty: 3 }, { id: 'herb_gold', qty: 2 }], blockCents: 70 },
    intro:
      "Pale wraiths drift the barrow-line between here and nowhere, cold as a creditor's heart. Unmake six, and walk the whole line while you're out — I want to know how far the cold reaches before I bother praying about it.",
    outro:
      "Six wraiths unmade and the whole barrow-line surveyed. The cold stops at the third cairn, which tells me exactly how long to make the sermon. The gods love specifics. You've earned the gold herb and my grudging theological respect.",
  },
  {
    id: 'q_beast_hunt_22',
    title: 'Rusty Comes Back',
    giver: 'gravekeeper_sol',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'revenant_rust', need: 5, label: 'Lay 5 rust revenants to rest' }],
    rewards: { xp: { attack: 400, defense: 200 }, items: [{ id: 'bar_iron', qty: 3 }, { id: 'ore_iron', qty: 4 }], blockCents: 65 },
    intro:
      "Rust revenants died in their armor and refused to take it off, which is relatable but inconvenient. Five of them clank around leaking orange grief. Lay them down — the armor's scrap-worthy once the revenant stops arguing. You handle the arguing.",
    outro:
      "Five revenants, arguments concluded. The armor's all yours — rusted but reforgeable, like most of us. They clank no more. The barrow is a shade quieter, a shade less orange, and considerably less sad.",
  },
  {
    id: 'q_beast_hunt_23',
    title: 'Gloom and Doom',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'gloomhound', need: 6, label: 'Put down 6 gloomhounds' }],
    rewards: { xp: { attack: 440, archery: 160 }, items: [{ id: 'hide_tough', qty: 5 }, { id: 'potion_regret', qty: 1 }], blockCents: 70 },
    intro:
      "Gloomhounds are dog-shaped holes in the evening. Six of them have been howling a dirge outside at 3am, every night, with PERFECT pitch, which makes it worse. End the recital. I'll pay in hides and the sweet, sweet absence of harmony.",
    outro:
      "Six gloomhounds, choir disbanded. The night is tuneless and perfect. Those shadow-pelts are worth a fortune to people who want to look mysterious — i.e., everyone but me. Take them. Take the quiet. Take your leave.",
  },
  {
    id: 'q_beast_hunt_24',
    title: 'Wight of Way',
    giver: 'prophet_karl',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'barrow_wight', need: 5, label: 'Re-entomb 5 barrow wights' }],
    rewards: { xp: { attack: 480, magic: 200 }, items: [{ id: 'crystal_cut', qty: 3 }, { id: 'bar_gold', qty: 1 }], blockCents: 90 },
    intro:
      "Barrow wights guard treasure they can no longer spend, which is the saddest kind of rich. Five of them. They'll offer you the gold if you join them forever — DECLINE. Take the gold the other way. The way where you keep your pulse.",
    outro:
      "Five wights, re-entombed with their now-unguarded hoards. You took the gold and kept your pulse, which is the correct order of operations. The barrows are quiet. The dead are, for once, actually resting. Well done.",
  },
  {
    id: 'q_beast_hunt_25',
    title: 'The Widow’s Web',
    giver: 'gravekeeper_sol',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'crypt_widow', need: 4, label: 'Burn out 4 crypt widows' },
      { kind: 'collect', target: 'crystal_shard', need: 4, label: 'Recover 4 egg-sac crystals' },
    ],
    rewards: { xp: { attack: 460, archery: 180 }, items: [{ id: 'hide_tough', qty: 4 }, { id: 'crystal_cut', qty: 2 }], blockCents: 75 },
    intro:
      "Crypt widows nest in the ossuary and line their webs with crystallized dread. Four of them. Recover the egg-sac crystals — yes, I know, I KNOW — they're worth a king's ransom and the widows won't need them, being, imminently, past tense.",
    outro:
      "Four widows, ossuary reclaimed, egg-sac crystals recovered — and you only shuddered the normal amount. Those crystals clean up into something gorgeous that no one ever needs to learn the origin of. Our little secret. Gerald's too.",
  },
  {
    id: 'q_beast_hunt_26',
    title: 'Knight Terrors',
    giver: 'captain_elara',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'boneknight_cursed', need: 4, label: 'Unmake 4 cursed boneknights' }],
    rewards: { xp: { attack: 520, defense: 280 }, items: [{ id: 'bar_steel', qty: 3 }, { id: 'crystal_cut', qty: 2 }], blockCents: 100 },
    intro:
      "The Crown wants the cursed boneknights off its 'historic battlefields' before the tourism board finds out the exhibits move. Four of them — knights who lost a war and took it personally for three centuries. Unmake them. The Crown will deny this conversation and so will I.",
    outro:
      "Four boneknights unmade, three centuries of grudge finally filed under 'closed'. The battlefield is a museum again, not a re-enactment with real casualties. The steel's yours; the Crown's gratitude is, as ever, theoretical.",
  },
  {
    id: 'q_beast_hunt_27',
    title: 'Cold Shoulder',
    giver: 'mage_lyra',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'lich_frost', need: 2, label: 'Shatter 2 frost liches' }],
    rewards: { xp: { magic: 640, attack: 200 }, items: [{ id: 'crystal_cut', qty: 4 }, { id: 'potion_regret', qty: 1 }], blockCents: 140 },
    intro:
      "A frost lich is a wizard who looked death in the eye and said 'counteroffer'. Two of them froze a whole valley mid-sentence out of pure academic spite. Shatter them. Bring the phylactery crystals. And do NOT, under any circumstance, read their notes aloud.",
    outro:
      "Two liches, shattered, phylacteries cracked, valley thawing into a very confused spring. You didn't read the notes aloud — I can tell, because you're still shaped like yourself. The cut crystal's yours. Burn the notes. I mean it this time.",
  },
  {
    id: 'q_beast_hunt_28',
    title: 'Colossal Mistake',
    giver: 'gravekeeper_sol',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'tomb_colossus', need: 1, label: 'Topple the Tomb Colossus' }],
    rewards: { xp: { attack: 800, defense: 400, vitality: 300 }, items: [{ id: 'bar_gold', qty: 3 }, { id: 'crystal_cut', qty: 4 }], blockCents: 220 },
    intro:
      "Something woke the Tomb Colossus — forty feet of fused ancestors who all agree on one thing: trespassers. It's grinding the necropolis to gravel and me along with it if you dawdle. Topple it. I've buried a lot of things. I'd rather not add a necropolis to the list.",
    outro:
      "You toppled the Colossus. FORTY FEET of grudge, down like a dropped cathedral. The necropolis stands, the ancestors rest, and I get to keep gravekeeping instead of becoming the subject matter. Gold and crystal from the rubble — take it. You've earned a long, LONG nap.",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // IV. FROM THE PIT — fiends, hellhounds, and things on fire
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_beast_hunt_29',
    title: 'Hot Dogs',
    giver: 'prophet_karl',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'hellhound', need: 7, label: 'Douse 7 hellhounds' }],
    rewards: { xp: { attack: 360, magic: 140 }, items: [{ id: 'bar_steel', qty: 2 }, { id: 'potion_regret', qty: 1 }], blockCents: 65 },
    intro:
      "Hellhounds. Dogs. On fire. Permanently. And no, you cannot pet them, I've buried two optimists who tried. Seven of them are scorching the ash-flats into glass. Put them out. Fetch is not an option; they fetch YOU.",
    outro:
      "Seven hellhounds, extinguished, flats no longer glazing into a dog-shaped window. You didn't try to pet a single one, which puts you two ahead of the optimists. The steel's yours. The ash is cooling. Nobody's a cautionary tale today.",
  },
  {
    id: 'q_beast_hunt_30',
    title: 'Cinder Block',
    giver: 'prophet_karl',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'cinder_hound', need: 8, label: 'Snuff 8 cinder hounds' }],
    rewards: { xp: { attack: 340, defense: 120 }, items: [{ id: 'ore_iron', qty: 5 }, { id: 'food_jerky', qty: 2 }], blockCents: 55 },
    intro:
      "Cinder hounds are hellhounds' broke cousins — less flame, more spite, same terrible fetch instinct. Eight of them nip at the forge-crews and reheat things that were FINE at room temperature. Snuff them. The crews deserve lukewarm peace.",
    outro:
      "Eight cinder hounds, snuffed to embers. The forge-crews can leave their lunch out again without it bursting into a 'surprise'. Iron for your trouble. Spite, at least, is biodegradable.",
  },
  {
    id: 'q_beast_hunt_31',
    title: 'Little Devils',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'ash_imp', need: 10, label: 'Stamp out 10 ash imps' }],
    rewards: { xp: { attack: 280, magic: 100 }, items: [{ id: 'crystal_shard', qty: 3 }, { id: 'food_pie', qty: 2 }], blockCents: 45 },
    intro:
      "Ash imps are ember imps that discovered graffiti. Ten of them are tagging the mausoleums with — and I quote their work — 'SOL WUZ HERE (he's not, he's dead, lol)'. I am VERY much here. Stamp them out. Preserve my brand.",
    outro:
      "Ten ash imps, stamped, mausoleums scrubbed. My brand integrity is restored and I was NOT here the whole time, that's the point of the joke, which they'll never understand, being imps and now being gone. Pie. Take it. Thank you.",
  },
  {
    id: 'q_beast_hunt_32',
    title: 'Fiendish Beginnings',
    giver: 'prophet_karl',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'fiendling', need: 9, label: 'Banish 9 fiendlings' }],
    rewards: { xp: { magic: 360, attack: 120 }, items: [{ id: 'crystal_shard', qty: 4 }, { id: 'potion_regret', qty: 1 }], blockCents: 55 },
    intro:
      "Fiendlings are baby fiends and before you go 'aww' — they bite, they multiply, and they file grievances in a language that gives you a nosebleed. Nine of them before there are ninety. Banish early, banish often. There is no ethical cuteness in the pit.",
    outro:
      "Nine fiendlings banished before they could become a demographic crisis. Your nose stopped bleeding, roughly. The pit has nine fewer future problems. This is called preventative theology. Here's a shard for your trouble and sinuses.",
  },
  {
    id: 'q_beast_hunt_33',
    title: 'Crawl Under the Soot',
    giver: 'foreman_dagna',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'soot_crawler', need: 10, label: 'Clear 10 soot crawlers' },
      { kind: 'gather', target: 'iron_vein', need: 6, label: 'Mine 6 iron veins they blocked' },
    ],
    rewards: { xp: { attack: 300, mining: 220 }, items: [{ id: 'ore_iron', qty: 6 }, { id: 'bar_iron', qty: 2 }], blockCents: 70 },
    intro:
      "Soot crawlers nest in the richest seams, specifically to spite me, I'm certain of it. Ten crawlers, then mine the six veins they've been hoarding. It's two jobs, I'm paying for one and a half, that's called 'management'. Go.",
    outro:
      "Ten crawlers cleared, six veins freed from their grubby little custody. See? Two jobs, done, and the mountain's richer for it. You're wasted on hunting — you've got a miner's stubbornness. Don't take that as a compliment. It is one. Don't.",
  },
  {
    id: 'q_beast_hunt_34',
    title: 'Blobbed Together',
    giver: 'prophet_karl',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'magma_blob', need: 8, label: 'Cool 8 magma blobs' }],
    rewards: { xp: { attack: 320, magic: 140 }, items: [{ id: 'crystal_shard', qty: 3 }, { id: 'ore_gold', qty: 3 }], blockCents: 65 },
    intro:
      "Magma blobs are slimes that got ambitious and extremely hot. Eight of them are oozing through the lower ash, melting the path and swallowing dropped ore — which, incidentally, they then poop out as nuggets. Cool them. Collect the, ah, nuggets. Don't think about it.",
    outro:
      "Eight blobs, cooled to harmless rock. The gold 'nuggets' are suspiciously pure and we will NOT be investigating the supply chain. The path is walkable, the ore is yours, and your moral flexibility is noted and rewarded.",
  },
  {
    id: 'q_beast_hunt_35',
    title: 'Sprite Stuff',
    giver: 'mage_lyra',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'sulfur_sprite', need: 9, label: 'Pop 9 sulfur sprites' }],
    rewards: { xp: { magic: 380, archery: 140 }, items: [{ id: 'crystal_cut', qty: 2 }, { id: 'herb_red', qty: 4 }], blockCents: 60 },
    intro:
      "Sulfur sprites smell like a boiled egg had a breakdown and they EXPLODE when annoyed, which is constantly. Nine of them are fouling the air around my field lab. Pop them from a distance. Upwind. Everything about this is upwind.",
    outro:
      "Nine sprites popped, air cleared from 'actively criminal' to merely 'rotten'. My instruments can breathe again, metaphorically. The cut crystal's clean, the herbs are red, and you, regrettably, smell like a geyser's apology. Bathe.",
  },
  {
    id: 'q_beast_hunt_36',
    title: 'Ember Crawl',
    giver: 'prophet_karl',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'ember_crawler', need: 10, label: 'Snuff 10 ember crawlers' }],
    rewards: { xp: { attack: 300, defense: 100 }, items: [{ id: 'ore_copper', qty: 6 }, { id: 'food_pie', qty: 2 }], blockCents: 50 },
    intro:
      "Ember crawlers are the pit's cockroaches — if you see one, there are ten, and if you see ten, abandon the room. There are ten. In the room. Snuff them before they do the math on reinforcements. Chitin's worthless but the peace isn't.",
    outro:
      "Ten ember crawlers, snuffed, room reclaimed. The math never got done, thank the gods, because the answer was 'way more'. Copper for your nerve. The pit will send more; the pit always does. But not today.",
  },
  {
    id: 'q_beast_hunt_37',
    title: 'Gloom Service',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'gloom_imp', need: 8, label: 'Dispel 8 gloom imps' }],
    rewards: { xp: { magic: 340, attack: 120 }, items: [{ id: 'crystal_shard', qty: 3 }, { id: 'potion_regret', qty: 1 }], blockCents: 55 },
    intro:
      "Gloom imps feed on despair, and let me tell you, a graveyard is an all-you-can-eat buffet, so they're THRIVING. Eight of them, fat and smug on my ambient misery. Dispel them. I'd rather keep my despair, thanks. It's load-bearing.",
    outro:
      "Eight gloom imps, dispelled and freshly dieting. My despair is mine again — unfarmed, artisanal, free-range. You can't put a price on that, but I'm putting a shard and a potion on it anyway. Take them. Go be morbid elsewhere.",
  },
  {
    id: 'q_beast_hunt_38',
    title: 'Brute Force',
    giver: 'hermit_vex',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'pit_brute', need: 5, label: 'Flatten 5 pit brutes' }],
    rewards: { xp: { attack: 480, defense: 240 }, items: [{ id: 'bar_steel', qty: 3 }, { id: 'hide_tough', qty: 3 }], blockCents: 95 },
    intro:
      "Pit brutes are the muscle the pit sends when it's given up on subtlety. Five slabs of grievance with fists like wrecking balls. Flatten them. Their hide's thick enough to armor a cart; their brains thin enough you'll likely out-think them. Likely.",
    outro:
      "Five pit brutes, flattened, out-thought and out-fought. The hide's cart-grade, the steel's a bonus, and the pit has learned that subtlety was the better plan after all. Too late for it. Perfect for us.",
  },
  {
    id: 'q_beast_hunt_39',
    title: 'Spawn Point',
    giver: 'prophet_karl',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'balor_spawn', need: 4, label: 'Banish 4 balor spawn' },
      { kind: 'collect', target: 'crystal_cut', need: 3, label: 'Seal 3 cores in cut crystal' },
    ],
    rewards: { xp: { magic: 560, attack: 220 }, items: [{ id: 'crystal_cut', qty: 3 }, { id: 'bar_gold', qty: 1 }], blockCents: 130 },
    intro:
      "Balor spawn are offcuts of something far worse, and each one's a seed of the thing that shed it. Four of them. Banish them, then seal their cores in cut crystal before they take root — a loose core grows back the gardener. I am the gardener in this metaphor. Don't make me a Balor.",
    outro:
      "Four spawn banished, four cores sealed, and no one in this congregation has sprouted horns. The crystal holds; I checked thrice, then prayed, then checked again. Gold for your nerve. We just pruned something monstrous at the root. Don't tell the choir.",
  },
  {
    id: 'q_beast_hunt_40',
    title: 'Brimstone Economics',
    giver: 'banker_aldous',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'brimstone_fiend', need: 5, label: 'Foreclose on 5 brimstone fiends' }],
    rewards: { xp: { attack: 520, magic: 260 }, items: [{ id: 'bar_gold', qty: 2 }, { id: 'crystal_cut', qty: 3 }], blockCents: 150 },
    intro:
      "Brimstone fiends broker souls on credit at frankly PREDATORY rates, which — professional courtesy aside — undercuts the bank. Five of them. Foreclose. Bring back whatever gold they've been 'holding in escrow'. The paperwork's a formality; the pointy end is the paperwork.",
    outro:
      "Five fiends foreclosed, escrow liberated, and the soul-lending market has a healthy new vacancy that we will absolutely NOT be filling, legally. The gold's clean enough. This meeting continues to not happen. You're very good at things that don't happen.",
  },
  {
    id: 'q_beast_hunt_41',
    title: 'Open Wide',
    giver: 'prophet_karl',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'dread_maw', need: 3, label: 'Close 3 dread maws' }],
    rewards: { xp: { attack: 560, vitality: 260 }, items: [{ id: 'hide_tough', qty: 5 }, { id: 'crystal_cut', qty: 3 }], blockCents: 140 },
    intro:
      "A dread maw is mostly mouth and the rest is regret — yours, for getting close. Three of them have eaten a patrol, a supply cart, and a 'DANGER' sign, in that unfortunate order. Close them. Permanently. Mind the teeth; there are SO many teeth.",
    outro:
      "Three maws, closed for good, several teeth donated to science and the rest to the ash. You retrieved the 'DANGER' sign, which is funny, and the patrol's effects, which is not. The maws eat nothing further. Hide and crystal, hard-earned.",
  },
  {
    id: 'q_beast_hunt_42',
    title: 'Char Broiled',
    giver: 'hermit_vex',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'char_drake', need: 1, label: 'Down the Char Drake' }],
    rewards: { xp: { attack: 680, defense: 320 }, items: [{ id: 'bar_gold', qty: 2 }, { id: 'hide_tough', qty: 6 }], blockCents: 180 },
    intro:
      "The char drake isn't a true dragon — it just acts like one at parties. Still, it's forty feet of walking barbecue and it's reduced my 'quiet retirement' to a smoking crater with a view. Down it. Bring me the hide. I'll rebuild. Alone. As intended.",
    outro:
      "The char drake, downed, de-barbecued, and reduced to premium materials. My crater has a lovely new silence to it. That drake-hide's nearly dragon-grade — wear it, sell it, I don't care, just wear it AWAY from here. Good hunting. Goodbye.",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // V. CONSTRUCTS — cores, plates, and the Ironhold scrap bounties
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_beast_hunt_43',
    title: 'Sentinel Duty',
    giver: 'smith_orin',
    regionId: 'ironhold',
    steps: [{ kind: 'kill', target: 'crystal_sentinel', need: 6, label: 'Decommission 6 crystal sentinels' }],
    rewards: { xp: { attack: 340, mining: 160 }, items: [{ id: 'crystal_raw', qty: 6 }, { id: 'crystal_shard', qty: 3 }], blockCents: 70 },
    intro:
      "The old vault's crystal sentinels never got the memo that the vault's been empty for a century. Six of them still guard a hole, zealously, murderously. Decommission them. They're PACKED with crystal — the irony being, they guard nothing BUT themselves now.",
    outro:
      "Six sentinels, decommissioned, retired from guarding the concept of a room. The crystal's the real haul — raw and sharded, pure as their pointless devotion. The vault's finally, truly empty. Took a century and you. Mostly you.",
  },
  {
    id: 'q_beast_hunt_44',
    title: 'Warden’s Welcome',
    giver: 'foreman_dagna',
    regionId: 'ironhold',
    steps: [{ kind: 'kill', target: 'iron_warden', need: 5, label: 'Scrap 5 iron wardens' }],
    rewards: { xp: { attack: 380, defense: 200 }, items: [{ id: 'bar_iron', qty: 4 }, { id: 'ore_iron', qty: 4 }], blockCents: 75 },
    intro:
      "Iron wardens: automated security that outlived its password. Five of them 'protect' shaft nine by flattening anyone with a pulse, which is a design flaw AND a lawsuit. Scrap them for parts. The parts, at least, don't have opinions about your pulse.",
    outro:
      "Five wardens, scrapped, shaft nine de-lawsuited. That's good iron — reforge it into something that only hits what you tell it to. Novel concept, round here. The warden that wrote the 'flatten everyone' rule remains, mercifully, anonymous and inoperative.",
  },
  {
    id: 'q_beast_hunt_45',
    title: 'Shard Practice',
    giver: 'smith_orin',
    regionId: 'ironhold',
    steps: [
      { kind: 'kill', target: 'shard_crawler', need: 10, label: 'Smash 10 shard crawlers' },
      { kind: 'gather', target: 'crystal_node', need: 5, label: 'Harvest 5 crystal nodes' },
    ],
    rewards: { xp: { attack: 300, mining: 240 }, items: [{ id: 'crystal_raw', qty: 6 }, { id: 'crystal_cut', qty: 2 }], blockCents: 70 },
    intro:
      "Shard crawlers are little crystal centipedes that eat our good nodes and reproduce by — ugh — spalling. Ten of them, then harvest five nodes before the next batch moves in. It's a turf war and I've decided the turf is mine.",
    outro:
      "Ten crawlers smashed, five nodes harvested, turf held. The raw crystal's clean and the cut piece is gorgeous — the crawlers had, I'll admit, excellent taste in what to infest. Shame. Lovely materials. Yours.",
  },
  {
    id: 'q_beast_hunt_46',
    title: 'Gear Grinder',
    giver: 'foreman_dagna',
    regionId: 'ironhold',
    steps: [{ kind: 'kill', target: 'gearhound', need: 8, label: 'Jam 8 gearhounds' }],
    rewards: { xp: { attack: 320, defense: 140 }, items: [{ id: 'bar_copper', qty: 4 }, { id: 'ore_copper', qty: 5 }], blockCents: 55 },
    intro:
      "Gearhounds are clockwork guard-dogs that lost their master and never stopped patrolling, which would be touching if they didn't try to tenderize the night crew. Eight of them. Jam the mechanisms. Keep the brass. Loyalty's a lovely trait in a corpse, less so in a wind-up murder machine.",
    outro:
      "Eight gearhounds, jammed mid-loyalty. The night crew keeps its tenderness un-tenderized. All that brass and copper's yours — melt it into something that doesn't mourn a master by assaulting strangers. The bar's low, I know. Clear it.",
  },
  {
    id: 'q_beast_hunt_47',
    title: 'Brass Tacks',
    giver: 'smith_orin',
    regionId: 'ironhold',
    steps: [{ kind: 'kill', target: 'brass_sentry', need: 7, label: 'Dismantle 7 brass sentries' }],
    rewards: { xp: { attack: 300, blacksmithing: 180 }, items: [{ id: 'bar_copper', qty: 5 }, { id: 'bar_iron', qty: 2 }], blockCents: 60 },
    intro:
      "Brass sentries stand at posts that stopped mattering before your grandparents were a rumor, challenging passersby for a password nobody alive remembers. Seven of them. Dismantle them. The brass is good; the bureaucracy they died defending was not.",
    outro:
      "Seven sentries, dismantled, passwords forever unguessed and now forever unneeded. Fine brass, clean iron. There's a lesson in there about guarding dead rules, but you're covered in machine oil and I'm covered in smoke, so let's skip it.",
  },
  {
    id: 'q_beast_hunt_48',
    title: 'Mirror Match',
    giver: 'mage_lyra',
    regionId: 'ironhold',
    steps: [{ kind: 'kill', target: 'mirror_golem', need: 5, label: 'Shatter 5 mirror golems' }],
    rewards: { xp: { attack: 400, magic: 200 }, items: [{ id: 'crystal_cut', qty: 3 }, { id: 'crystal_raw', qty: 4 }], blockCents: 85 },
    intro:
      "Mirror golems copy the last thing that hit them, which makes them a fascinating study and an infuriating fight. Five of them. Hit them with something you'd hate to face, then face it, then learn humility. Bring the mirror-crystal; it's worth the identity crisis.",
    outro:
      "Five mirror golems, shattered — and you only had to out-fight yourself five times, which is a record most people don't survive setting. The mirror-crystal refracts a version of you that looks far more competent. Keep it. Aspire to it.",
  },
  {
    id: 'q_beast_hunt_49',
    title: 'Cog in the Machine',
    giver: 'foreman_dagna',
    regionId: 'ironhold',
    steps: [{ kind: 'kill', target: 'cog_sprite', need: 10, label: 'Debug 10 cog sprites' }],
    rewards: { xp: { attack: 260, mining: 140 }, items: [{ id: 'bar_copper', qty: 4 }, { id: 'food_jerky', qty: 2 }], blockCents: 45 },
    intro:
      "Cog sprites are little gremlins that live in machinery and 'fix' it by stealing the parts that make it work. Ten of them have optimized three drills into decorative scrap. Debug them — with a hammer. The IT department around here is very physical.",
    outro:
      "Ten cog sprites, debugged percussively. The drills might even drill again, once we find the parts the sprites 'relocated for efficiency'. Copper's yours. Jerky too. Welcome to maintenance; the only fix is violence and the violence never ends.",
  },
  {
    id: 'q_beast_hunt_50',
    title: 'Prism Break',
    giver: 'mage_lyra',
    regionId: 'ironhold',
    steps: [
      { kind: 'kill', target: 'prism_drone', need: 7, label: 'Disable 7 prism drones' },
      { kind: 'collect', target: 'crystal_cut', need: 4, label: 'Reclaim 4 lens-cores' },
    ],
    rewards: { xp: { magic: 420, attack: 160 }, items: [{ id: 'crystal_cut', qty: 4 }, { id: 'crystal_shard', qty: 3 }], blockCents: 90 },
    intro:
      "Prism drones split sunlight into beams that cut stone and, incidentally, me, if I stand in the wrong spot, which I did, ONCE. Seven of them. Reclaim the lens-cores — perfectly cut crystal, the only good decision their makers ever encoded. Mind the beams. They don't mind you.",
    outro:
      "Seven drones disabled, four lens-cores reclaimed, zero further me-slicing incidents. The cores are flawless — whoever built these drones should've just sold jewelry. Take the crystal. You've out-angled the geometry. Few can say that. Fewer still have both arms after.",
  },
  {
    id: 'q_beast_hunt_51',
    title: 'Knight Shift',
    giver: 'captain_elara',
    regionId: 'ironhold',
    steps: [{ kind: 'kill', target: 'clockwork_knight', need: 5, label: 'Wind down 5 clockwork knights' }],
    rewards: { xp: { attack: 440, defense: 240 }, items: [{ id: 'bar_steel', qty: 3 }, { id: 'crystal_cut', qty: 2 }], blockCents: 100 },
    intro:
      "Clockwork knights were the old kingdom's elite guard, and they're STILL on duty, defending a throne that's been firewood for generations. Five of them. Wind them down — respectfully, they outrank us both on paper. Then salvage the steel. Loyalty like that deserves a clean dismantling.",
    outro:
      "Five clockwork knights, wound down with full honors and a crowbar. They held their post for a dead king right to the last gear — tragic, admirable, finally over. The steel's elite-grade. So's the salute I'm giving them. And you. Mostly them.",
  },
  {
    id: 'q_beast_hunt_52',
    title: 'Siege Mentality',
    giver: 'foreman_dagna',
    regionId: 'ironhold',
    steps: [{ kind: 'kill', target: 'siege_golem', need: 3, label: 'Dismantle 3 siege golems' }],
    rewards: { xp: { attack: 560, defense: 300 }, items: [{ id: 'bar_steel', qty: 4 }, { id: 'bar_iron', qty: 3 }], blockCents: 130 },
    intro:
      "Siege golems were built to knock down walls and nobody ever built them an 'off'. Three of them are knocking down MY walls — load-bearing ones, the rude kind to lose. Dismantle them before the whole shaft becomes a very expensive hole. The scrap alone's worth a season's wages.",
    outro:
      "Three siege golems, dismantled before they could demonstrate what happens to a shaft with no walls. The steel-and-iron haul IS a season's wages. You turned a demolition crew into a scrap pile. The mountain owes you, and the mountain never pays, so I will. Grudgingly. Here.",
  },
  {
    id: 'q_beast_hunt_53',
    title: 'Rune of Bad Luck',
    giver: 'mage_lyra',
    regionId: 'ironhold',
    steps: [{ kind: 'kill', target: 'rune_colossus', need: 1, label: 'Unwrite the Rune Colossus' }],
    rewards: { xp: { attack: 720, magic: 400 }, items: [{ id: 'crystal_cut', qty: 5 }, { id: 'bar_gold', qty: 2 }], blockCents: 200 },
    intro:
      "The Rune Colossus is a walking textbook of forbidden magic, and every step rewrites the local laws of reality — last week it made 'up' optional for an afternoon. One of them. Unwrite it. Shatter the runestones in order or the magic just reboots into something worse. I'll give you the order. Memorize it. Lives are optional; the order is not.",
    outro:
      "The Rune Colossus, unwritten, runestones shattered in the exact order — 'up' is mandatory again and reality has stopped editorializing. Those cut crystals still hum with lawful magic now, which is the good kind. The gold's a bonus. You just did homework no one survives. Top marks.",
  },
  {
    id: 'q_beast_hunt_54',
    title: 'Obsidian and On',
    giver: 'smith_orin',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'obsidian_automaton', need: 4, label: 'Crack 4 obsidian automatons' }],
    rewards: { xp: { attack: 520, blacksmithing: 260 }, items: [{ id: 'bar_steel', qty: 4 }, { id: 'crystal_cut', qty: 3 }], blockCents: 120 },
    intro:
      "Obsidian automatons are black-glass brutes that shrug off most of what you'll swing at them and chip into razor-knapped shards when they don't. Four of them guard a forge far better than mine, which I RESENT. Crack them. Bring the obsidian; I'll make it mine out of spite.",
    outro:
      "Four automatons, cracked, their superior forge now suspiciously vacant. The obsidian shards knap into blades that hold a grudge of an edge. Spite-forged is the best forged, I always say, usually while bleeding. Take the steel. Leave me the sulking.",
  },
  {
    id: 'q_beast_hunt_55',
    title: 'Walk This Way',
    giver: 'captain_elara',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'bastion_walker', need: 3, label: 'Topple 3 bastion walkers' }],
    rewards: { xp: { attack: 600, defense: 340 }, items: [{ id: 'bar_steel', qty: 5 }, { id: 'bar_gold', qty: 1 }], blockCents: 150 },
    intro:
      "Bastion walkers are fortresses that got legs and an attitude. Three of them patrol the old border, challenging travelers to a siege, which is an unreasonable thing to do to a man with a mule. Topple them. The Crown wants the road open and the walkers filed under 'historical'.",
    outro:
      "Three bastion walkers, toppled, the border road reopened to anyone who isn't up for an impromptu siege, i.e., everyone. The steel's fortress-grade and the gold is, let's say, a 'historical artifact' now in your custody. The mule-owner weeps with gratitude. Good enough for the Crown. Good enough.",
  },
  {
    id: 'q_beast_hunt_56',
    title: 'Cold Guard',
    giver: 'prospector_finn',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'glacier_warden', need: 4, label: 'Thaw 4 glacier wardens' }],
    rewards: { xp: { attack: 500, defense: 260 }, items: [{ id: 'crystal_cut', qty: 4 }, { id: 'crystal_raw', qty: 5 }], blockCents: 120 },
    intro:
      "Glacier wardens are constructs grown INTO the ice, half machine, half frozen patience. Four of them guard a vein so rich it makes me weep ice-cold tears of greed. Thaw them — aggressively — and the vein's ours. Well, mine. You get crystal and my undying, well-documented gratitude.",
    outro:
      "Four glacier wardens, thawed into scrap and slush, the rich vein finally, GLORIOUSLY unguarded. The crystal's some of the cleanest I've pulled — cut and raw, a prospector's dream. 'Ours', I said. I meant mine. You got crystal. We're square. Mostly square. Square-ish.",
  },
  {
    id: 'q_beast_hunt_57',
    title: 'The Titan’s Last Stand',
    giver: 'captain_elara',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'aegis_titan', need: 1, label: 'Bring down the Aegis Titan' }],
    rewards: { xp: { attack: 820, defense: 500, vitality: 300 }, items: [{ id: 'bar_gold', qty: 3 }, { id: 'crystal_cut', qty: 5 }], blockCents: 240 },
    intro:
      "The Aegis Titan is the last and largest of the old war-constructs — a hundred tons of shield and sanctioned violence that never learned the war ended. One of them. Bring it down. It's protecting a treaty nobody honors from an enemy long dead. End its vigil. The Crown will carve your name somewhere small and hard to find. Royal gratitude.",
    outro:
      "The Aegis Titan, DOWN — a hundred tons of obsolete duty, finally relieved of its post. It guarded a dead peace to the bitter, grinding last. There's something almost noble in that, which I'll put on the plaque nobody reads. The gold and crystal are real, though. Those you can spend. Honor doesn't buy ale. Go buy ale.",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // VI. CREEPY CRAWLIES — insect chitin, venom glands, and swarm bounties
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_beast_hunt_58',
    title: 'Dung and Dusted',
    giver: 'farmer_bram',
    regionId: 'beginnings',
    steps: [{ kind: 'kill', target: 'beetle_dung', need: 10, label: 'Boot 10 dung beetles' }],
    rewards: { xp: { attack: 180, farming: 120 }, items: [{ id: 'wheat', qty: 6 }, { id: 'herb_green', qty: 4 }], blockCents: 30 },
    intro:
      "Dung beetles are, I'll grant them, ecologically important, and also they've rolled off with something that was NOT fertilizer, it was my LUNCH, and I want justice. Ten of them. I know what they do for the soil. I want them to do it somewhere that isn't my sandwich.",
    outro:
      "Ten dung beetles, relocated to the great compost heap in the sky. My lunch remains unavenged but my fields are, somehow, MORE fertile for it. Nature's gross. Take the wheat. Don't ask which beetle fertilized it. There is no good answer.",
  },
  {
    id: 'q_beast_hunt_59',
    title: 'Rhino Mode',
    giver: 'ranger_kael',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'beetle_rhino', need: 8, label: 'Flip 8 rhino beetles' }],
    rewards: { xp: { attack: 240, defense: 120 }, items: [{ id: 'hide_tough', qty: 3 }, { id: 'food_honey', qty: 2 }], blockCents: 40 },
    intro:
      "Rhino beetles are the size of a dinner plate and lift sixty times their weight, mostly logs, mostly onto paths, mostly out of spite. Eight of them. The chitin armors a shield better than steel and weighs less than your excuses. Go.",
    outro:
      "Eight rhino beetles, flipped and finished. The chitin's a smith's daydream — light, hard, and ethically ambiguous. The paths are log-free. The beetles have returned to the earth to lift, presumably, very heavy regrets.",
  },
  {
    id: 'q_beast_hunt_60',
    title: 'Pray, Then Slay',
    giver: 'scout_wren',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'mantis_prayer', need: 7, label: 'Cut down 7 prayer mantises' }],
    rewards: { xp: { attack: 260, archery: 140 }, items: [{ id: 'hide_tough', qty: 3 }, { id: 'herb_red', qty: 4 }], blockCents: 45 },
    intro:
      "Prayer mantises sit statue-still, 'praying', which is a LIE, they're waiting to behead the next thing to wander close, and lately that's been my scouts. Seven of them. They're patient. Be more patient. Then be very, very sudden.",
    outro:
      "Seven mantises, mid-prayer, answered. My scouts keep their heads, which they frankly don't always deserve but I've grown attached. The mantis is quick, but you were quicker — this time the statue blinked first.",
  },
  {
    id: 'q_beast_hunt_61',
    title: 'Blade Runner',
    giver: 'ranger_kael',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'mantis_blade', need: 6, label: 'Outcut 6 blade mantises' }],
    rewards: { xp: { attack: 320, archery: 160 }, items: [{ id: 'hide_tough', qty: 4 }, { id: 'bar_iron', qty: 2 }], blockCents: 55 },
    intro:
      "Blade mantises upgraded from 'sharp arms' to 'arms that ARE blades', which is evolution showing off. Six of them have been pruning the hedge maze and the hedge maze gardener, in that order. Outcut them. Their forelimbs make a knife that never needs a whetstone, which is cheating, which I respect.",
    outro:
      "Six blade mantises, outcut at their own game. The gardener lives, the maze is over-pruned but alive, and you're holding forelimb-knives that'll outlast your grandchildren. Evolution showed off; you showed it the door. Nice work.",
  },
  {
    id: 'q_beast_hunt_62',
    title: 'Sting Operation',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'scorpion_sand', need: 9, label: 'Crush 9 sand scorpions' },
      { kind: 'collect', target: 'herb_red', need: 4, label: 'Brew-base: gather 4 red herbs' },
    ],
    rewards: { xp: { attack: 280, herbalism: 140 }, items: [{ id: 'potion_regret', qty: 2 }, { id: 'herb_gold', qty: 2 }], blockCents: 50 },
    intro:
      "Sand scorpions nest under every flat rock between here and the dunes, and I have STEPPED on every flat rock between here and the dunes. Nine of them. Bring red herbs too — the venom and the herb make an antivenom, which I need, because I keep stepping on rocks. I'm a hermit, not a genius.",
    outro:
      "Nine scorpions crushed, red herbs gathered, antivenom brewing. My foot thanks you, my pride does not. Here — Potions of Regret, which is thematically perfect for a man who moved to the one biome made entirely of ankle-traps. Leave me to my limping.",
  },
  {
    id: 'q_beast_hunt_63',
    title: 'Emperor’s New Sting',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'scorpion_emperor', need: 4, label: 'Dethrone 4 emperor scorpions' }],
    rewards: { xp: { attack: 420, defense: 200 }, items: [{ id: 'hide_tough', qty: 5 }, { id: 'crystal_shard', qty: 3 }], blockCents: 80 },
    intro:
      "Emperor scorpions are the size of a wagon and twice as self-important. Four of them rule the dune-rock like it's a kingdom and they're owed a coronation. Dethrone them. The carapace is armor-grade; the stinger makes a spear that argues back. Mind the pincers — they file grievances in halves.",
    outro:
      "Four emperor scorpions, dethroned, their little dune-kingdom dissolved by force of better judgment, i.e., yours. The carapace is magnificent and the stinger-spears are the stuff of legend and tetanus. Royalty's just a big bug with a crown it awarded itself. You decrowned it. Good.",
  },
  {
    id: 'q_beast_hunt_64',
    title: 'Paper Trail',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [{ kind: 'kill', target: 'wasp_paper', need: 10, label: 'Smoke out 10 paper wasps' }],
    rewards: { xp: { archery: 240, attack: 100 }, items: [{ id: 'herb_blue', qty: 4 }, { id: 'food_honey', qty: 2 }], blockCents: 40 },
    intro:
      "Paper wasps built a nest in the archive — the ARCHIVE — and have been pulping my rarest manuscripts into wallpaper for their horrible little condo. Ten of them. Smoke them out before 'Treatise on Everything' becomes 'Nest, Western Wing'. The honey, at least, is a nice consolation prize.",
    outro:
      "Ten paper wasps, evicted from scholarship. I salvaged four pages of 'Treatise on Everything' — they ate the interesting chapters, of course. The honey's yours. The archive smells of smoke and spite, which is just the smell of academia, really.",
  },
  {
    id: 'q_beast_hunt_65',
    title: 'Hornet’s Nest',
    giver: 'ranger_kael',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'wasp_hornet', need: 8, label: 'Burn out 8 hornets' }],
    rewards: { xp: { archery: 300, attack: 140 }, items: [{ id: 'hide_tough', qty: 3 }, { id: 'food_honey', qty: 3 }], blockCents: 55 },
    intro:
      "Giant hornets. Each one's a thumb-sized guided missile with a grudge and a stinger like a hot nail. Eight of them have claimed the honey grove, and I WANT THAT HONEY. Burn them out from range. Get stung once and you'll feel it next week, in a different body, in a future life.",
    outro:
      "Eight hornets, burned out, honey grove liberated. You kept your distance and your dignity, both of which the hornets specialize in removing. Three jars of honey, earned the hard way. Worth it. Mostly. The welts will fade. Probably.",
  },
  {
    id: 'q_beast_hunt_66',
    title: 'Bog Standard',
    giver: 'herbalist_moss',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'centipede_bog', need: 9, label: 'Chop 9 bog centipedes' }],
    rewards: { xp: { attack: 240, herbalism: 160 }, items: [{ id: 'herb_blue', qty: 5 }, { id: 'herb_green', qty: 4 }], blockCents: 45 },
    intro:
      "Bog centipedes grow as long as a scythe and twice as unpleasant, and they've overrun the blue-herb marsh where I do my best gathering. Nine of them. Each one you chop is a patch of marsh I can wade into without being digested. Herbalism is a dangerous art and I am BARELY paid for it.",
    outro:
      "Nine bog centipedes, chopped into convenient sections. The blue-herb marsh is mine again — well, the marsh's, but mine to harvest. The herbs are as potent as the bog is disgusting, which is VERY. Take some. You've waded through worse now. Literally.",
  },
  {
    id: 'q_beast_hunt_67',
    title: 'The Chasm Gapes',
    giver: 'prospector_finn',
    regionId: 'ironhold',
    steps: [
      { kind: 'explore', target: 'ironhold', need: 1, label: 'Descend into the chasm shafts' },
      { kind: 'kill', target: 'centipede_chasm', need: 6, label: 'Exterminate 6 chasm centipedes' },
    ],
    rewards: { xp: { attack: 380, mining: 180 }, items: [{ id: 'ore_gold', qty: 4 }, { id: 'crystal_raw', qty: 4 }], blockCents: 75 },
    intro:
      "Chasm centipedes live where the rock forgets there's a sky — long as a ladder, mean as the dark. Descend into the chasm shafts, then clear six of them. They nest right on the gold seams, the greedy things. We have THAT in common, which is why they have to go.",
    outro:
      "Shafts descended, six chasm centipedes exterminated, gold seams reclaimed from their many, MANY legs. The ore's rich and the crystal's a bonus the dark didn't know it was giving up. You went where the rock forgets the sky and came back with pockets full. That's prospecting.",
  },
  {
    id: 'q_beast_hunt_68',
    title: 'Funnel Vision',
    giver: 'ranger_kael',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'spider_funnel', need: 10, label: 'Collapse 10 funnel spiders' }],
    rewards: { xp: { attack: 260, archery: 140 }, items: [{ id: 'hide_tough', qty: 3 }, { id: 'crystal_shard', qty: 2 }], blockCents: 45 },
    intro:
      "Funnel spiders dig silk-lined pits and wait for the ground to deliver dinner, and lately the ground's been delivering my trainees. Ten of them. Collapse their pits, then collapse them. The silk's strong enough to string a bow — the irony of which I'm sure the spiders would hate.",
    outro:
      "Ten funnel spiders, pits collapsed, trainees un-delivered. The silk's already strung on three bows and the spiders would, indeed, hate that, which is a bonus. The woods have fewer trapdoors now. Watch your step anyway. Old habits.",
  },
  {
    id: 'q_beast_hunt_69',
    title: 'Recluse Me',
    giver: 'herbalist_moss',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'spider_recluse', need: 8, label: 'Hunt 8 recluse spiders' }],
    rewards: { xp: { attack: 300, herbalism: 160 }, items: [{ id: 'herb_gold', qty: 3 }, { id: 'potion_regret', qty: 1 }], blockCents: 55 },
    intro:
      "Recluse spiders are shy, small, and their bite turns a limb into a cautionary poster. Eight of them den in the ashwood where my rarest gold-herb grows. I need the herb; I do NOT need the necrotic souvenir. Hunt them, carefully. Shake out your boots. ALWAYS shake out your boots.",
    outro:
      "Eight recluses hunted, boots unfailingly shaken, limbs gratifyingly intact. The gold-herb's mine to gather now — potent stuff, worth every nervous step. Here's your cut, and a Potion of Regret in case you looked too long at a recluse's fangs. I did once. I don't recommend it.",
  },
  {
    id: 'q_beast_hunt_70',
    title: 'Ants in the Pants',
    giver: 'captain_elara',
    regionId: 'capital',
    steps: [{ kind: 'kill', target: 'ant_soldier', need: 14, label: 'Repel 14 soldier ants' }],
    rewards: { xp: { attack: 280, defense: 160 }, items: [{ id: 'bar_iron', qty: 3 }, { id: 'food_pie', qty: 2 }], blockCents: 50 },
    intro:
      "Soldier ants are marching on the granary in a column so disciplined it's making the actual army look bad. Fourteen of them — the big mandibled officers. Repel them. The Crown cannot have its grain requisitioned by insects with better formation drills than its own guard. It's embarrassing. End the embarrassment.",
    outro:
      "Fourteen soldier ants repelled, column broken, granary held. The Crown's guard can pretend they'd have handled it, and we'll let them, because the alternative is paperwork. The grain is safe, the formation is scattered, and the army's reputation survives another day on your effort. Classic.",
  },
  {
    id: 'q_beast_hunt_71',
    title: 'Swarm Welcome',
    giver: 'farmer_bram',
    regionId: 'beginnings',
    steps: [{ kind: 'kill', target: 'locust_swarm', need: 12, label: 'Scatter 12 locust swarms' }],
    rewards: { xp: { attack: 240, farming: 200 }, items: [{ id: 'wheat', qty: 10 }, { id: 'berry_red', qty: 6 }], blockCents: 55 },
    intro:
      "Locusts. The word alone makes a farmer age ten years. Twelve swarms are eating my fields down to the DIRT and then eating opinions about the dirt. Scatter them before there's nothing left but a cautionary tale and a very full locust. Save my harvest. Save my sanity. One of the two, I'm not greedy.",
    outro:
      "Twelve swarms scattered, harvest mostly saved, sanity partially recovered. You can't un-eat what a locust's eaten, but you stopped them before the fields became a parable. Here's wheat from what survived — your wheat now, honestly earned. The locusts send no thanks. The locusts send nothing. They're scattered. Good.",
  },
  {
    id: 'q_beast_hunt_72',
    title: 'Tick Tock',
    giver: 'herbalist_moss',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'tick_bloated', need: 8, label: 'Lance 8 bloated ticks' },
      { kind: 'collect', target: 'herb_gold', need: 3, label: 'Gather 3 gold herbs for the salve' },
    ],
    rewards: { xp: { attack: 260, herbalism: 220 }, items: [{ id: 'herb_gold', qty: 3 }, { id: 'potion_regret', qty: 2 }], blockCents: 60 },
    intro:
      "Bloated ticks are the size of a fist and carry diseases that haven't been NAMED yet, because everyone who caught them died before publishing. Eight of them on the frontier game. Lance them from arm's length. Gather gold-herb for the salve. And for the love of all that's green, do not pop one near your face.",
    outro:
      "Eight bloated ticks, lanced cleanly, no face-popping incidents — a phrase I never want to say again. The salve's brewing and the frontier game can roam un-infested. You've handled the single most revolting bounty on the board. The Lodge salutes you from a safe, SAFE distance.",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // VII. DEEP WATER — reef shells, scale, and the Outer Isles bounties
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_beast_hunt_73',
    title: 'Snips and Snails',
    giver: 'honest_jim',
    regionId: 'beginnings',
    steps: [{ kind: 'kill', target: 'reefcrab', need: 10, label: 'Claw back 10 reefcrabs' }],
    rewards: { xp: { attack: 200, fishing: 120 }, items: [{ id: 'fish_raw', qty: 6 }, { id: 'food_jelly', qty: 2 }], blockCents: 35 },
    intro:
      "Reefcrabs have overrun my fishing spot and they keep stealing the bait, the catch, AND the rod, which takes real nerve for a thing with no face. Ten of them. The shells polish up nice and the meat's a delicacy, so really they've only themselves to blame for being delicious AND annoying.",
    outro:
      "Ten reefcrabs, clawed back. The spot's fishable again, the bait stays bait, and the shells are drying prettily on the dock. Delicacy or nuisance? Both. Mostly delicacy now, on account of being cooked. Here's fish and jelly. Fair trade.",
  },
  {
    id: 'q_beast_hunt_74',
    title: 'Hop to It',
    giver: 'honest_jim',
    regionId: 'beginnings',
    steps: [{ kind: 'kill', target: 'tidehopper', need: 12, label: 'Spear 12 tidehoppers' }],
    rewards: { xp: { attack: 220, fishing: 160 }, items: [{ id: 'fish_trout', qty: 5 }, { id: 'fish_raw', qty: 4 }], blockCents: 40 },
    intro:
      "Tidehoppers are frog-fish that bounce clean out of the water to nip your tackle and, on a bad day, your nose. Twelve of them turned my peaceful morning cast into a slapstick routine. Spear them mid-hop if you're flashy, or wait and be sensible — either way, twelve. I've got trout for you. Flashy gets no extra.",
    outro:
      "Twelve tidehoppers, speared, hop concluded. My mornings are calm again, my nose un-nipped, my tackle intact. I noticed you went flashy on a few. No extra trout, but I'll admit it was a good show. Here's your catch. Earned it, hop by hop.",
  },
  {
    id: 'q_beast_hunt_75',
    title: 'Leech Field',
    giver: 'herbalist_moss',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'bogleech', need: 11, label: 'Salt 11 bogleeches' }],
    rewards: { xp: { attack: 200, herbalism: 180 }, items: [{ id: 'herb_blue', qty: 5 }, { id: 'potion_regret', qty: 1 }], blockCents: 40 },
    intro:
      "Bogleeches have infested the medicinal marsh, and while medically a leech has its uses, eleven of them on one ankle is not a 'use', it's a MUGGING. Salt them, burn them, whatever — eleven gone. I need that marsh, and I need my blood to stay roughly where I keep it.",
    outro:
      "Eleven bogleeches, salted and sorry. The marsh is harvestable and your blood remains an inside job, as nature intended. The blue-herb's thriving where they fattened. Medicine from a mugging-ground — herbalism really is just gardening with hazards. Take your cut and a Potion of Regret. You'll want it after a day in that muck.",
  },
  {
    id: 'q_beast_hunt_76',
    title: 'Mud Season',
    giver: 'honest_jim',
    regionId: 'greenwood',
    steps: [
      { kind: 'kill', target: 'mudskip', need: 10, label: 'Net 10 mudskips' },
      { kind: 'gather', target: 'fishing_spot', need: 6, label: 'Work the tidal flats 6 times' },
    ],
    rewards: { xp: { attack: 180, fishing: 240 }, items: [{ id: 'fish_salmon', qty: 4 }, { id: 'fish_trout', qty: 4 }], blockCents: 50 },
    intro:
      "Mudskips walk on land, which fish are NOT supposed to do, and they've been walking right out of the tidal flats to raid my drying racks. Ten of them, then work the flats proper while you're down there. Fish that walk. What's next, birds that swim? Don't answer. Just net them.",
    outro:
      "Ten mudskips netted, the flats worked, the drying racks un-raided by ambulatory seafood. You got a fine haul for your trouble — salmon and trout that had the decency to stay in the water. The mudskips have walked their last. Good riddance, you unnatural little commuters.",
  },
  {
    id: 'q_beast_hunt_77',
    title: 'Batten Down',
    giver: 'honest_jim',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'brinebat', need: 9, label: 'Ground 9 brinebats' }],
    rewards: { xp: { archery: 280, attack: 120 }, items: [{ id: 'fish_raw', qty: 5 }, { id: 'crystal_shard', qty: 2 }], blockCents: 50 },
    intro:
      "Brinebats roost in the sea-caves and dive-bomb anything that glints, which, on the water, is EVERYTHING. Nine of them have claimed the cave where I stash my good lures. Ground them from range — they're quick, they're mean, and they taste, I'm told, like a mistake. Reclaim my lures.",
    outro:
      "Nine brinebats grounded, lure-cave reclaimed. I'll take your word they taste like a mistake — I'm not that curious. The cave's mine again, lures and all. Here, fish and a crystal the bats were hoarding for reasons known only to bats. Nicely shot. Those things don't hold still.",
  },
  {
    id: 'q_beast_hunt_78',
    title: 'Puff Piece',
    giver: 'honest_jim',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'pufferpup', need: 8, label: 'Deflate 8 pufferpups' }],
    rewards: { xp: { attack: 240, alchemy: 140 }, items: [{ id: 'potion_regret', qty: 2 }, { id: 'fish_salmon', qty: 3 }], blockCents: 50 },
    intro:
      "Pufferpups are adorable until they inflate into a ball of venomous spines and bob into your net looking SMUG about it. Eight of them clogging the salmon run. The alchemist wants the toxin glands intact, so deflate them carefully — one careless jab and you're the cautionary tale. Again. Still.",
    outro:
      "Eight pufferpups, deflated with the required care, glands intact for the alchemist's dubious hobbies. The salmon run flows free. You dodged the spines AND the smugness, which is honestly the harder part. Potions and salmon, both earned. Don't lick your fingers.",
  },
  {
    id: 'q_beast_hunt_79',
    title: 'Sand Trap',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'sandwraith', need: 7, label: 'Dissipate 7 sandwraiths' }],
    rewards: { xp: { attack: 360, magic: 180 }, items: [{ id: 'hide_tough', qty: 4 }, { id: 'crystal_shard', qty: 3 }], blockCents: 65 },
    intro:
      "Sandwraiths are the frontier's special cruelty — drowned things that the desert kept, surfacing from dry dunes to drag you UNDER the sand, which should not be POSSIBLE. Seven of them haunt the crossing I actually need to use. Dissipate them. I've relocated for solitude, not to be buried alive by a beach.",
    outro:
      "Seven sandwraiths, dissipated, the crossing walkable without the ground developing ambitions. A drowning in a desert — the frontier really will try anything to kill a man. You've closed that loophole. The hides and crystal are the dunes' apology. I'll accept it on your behalf. Now go.",
  },
  {
    id: 'q_beast_hunt_80',
    title: 'Serpent’s Reach',
    giver: 'captain_elara',
    regionId: 'capital',
    steps: [{ kind: 'kill', target: 'seaserpent', need: 5, label: 'Hunt 5 sea serpents' }],
    rewards: { xp: { attack: 480, archery: 220 }, items: [{ id: 'hide_tough', qty: 6 }, { id: 'bar_steel', qty: 2 }], blockCents: 110 },
    intro:
      "Sea serpents have been capsizing the Crown's trade cogs and eating the crews, which the merchants describe as 'bad for business' in the longest memo I've ever been handed. Five of them. The scaled hide is prized and the Crown pays per fathom of serpent. Bring it in. Try not to become a chapter in the memo.",
    outro:
      "Five sea serpents hunted, the shipping lane reopened, the memo mercifully concluded. The serpent-hide's gorgeous and the Crown's paying by the fathom, which added up fast — those were long serpents. The merchants are insufferable with relief. Here's your cut. You stayed out of the memo. Well done.",
  },
  {
    id: 'q_beast_hunt_81',
    title: 'Angler Mismanagement',
    giver: 'mage_lyra',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'anglerfiend', need: 4, label: 'Extinguish 4 anglerfiends' },
      { kind: 'collect', target: 'crystal_shard', need: 4, label: 'Recover 4 lure-light crystals' },
    ],
    rewards: { xp: { attack: 420, magic: 260 }, items: [{ id: 'crystal_cut', qty: 3 }, { id: 'crystal_raw', qty: 4 }], blockCents: 95 },
    intro:
      "Anglerfiends lurk in the drowned caverns dangling a little glowing light that says 'come closer', and the light is a LIE, as all good lights are. Four of them. Recover the lure-light crystals — they glow without heat, which my research NEEDS and the fiends will not miss, being deceased. Don't follow the light. You know better. Prove it.",
    outro:
      "Four anglerfiends extinguished, four lure-lights recovered, and you did NOT follow a single deceptive glow — a discipline most people learn one time, fatally. The cold-light crystals rewrite my chapter on luminescence. The cut crystal's yours. The dark's a little more honest now. Barely.",
  },
  {
    id: 'q_beast_hunt_82',
    title: 'Release the Krakenlings',
    giver: 'honest_jim',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'krakenling', need: 6, label: 'Pry loose 6 krakenlings' }],
    rewards: { xp: { attack: 400, fishing: 240 }, items: [{ id: 'fish_salmon', qty: 5 }, { id: 'hide_tough', qty: 4 }], blockCents: 85 },
    intro:
      "Krakenlings are baby krakens, which is NOT as cute as it sounds — six arms each, all grabby, and they've latched onto my boat hull like it owes them money. Six of them. Pry them loose before they grow up and I have to find a new, less-eaten boat. The ink's valuable; the trauma's free.",
    outro:
      "Six krakenlings, pried loose, boat un-latched and only moderately slimed. Caught them young, thank the tides — a grown kraken is a BOAT problem, and that boat is my whole personality. The ink sold well and the hide's good leather. Here's salmon. We'll not speak of how many arms there were.",
  },
  {
    id: 'q_beast_hunt_83',
    title: 'Drowned Not Out',
    giver: 'gravekeeper_sol',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'drownedman', need: 8, label: 'Re-drown 8 drowned men' }],
    rewards: { xp: { attack: 380, magic: 160 }, items: [{ id: 'crystal_shard', qty: 3 }, { id: 'potion_regret', qty: 1 }], blockCents: 65 },
    intro:
      "Drowned men are sailors the sea took and the sea gave back, rudely, wronger. Eight of them walk up out of the surf at low tide to reclaim a shore they lost. I bury people; I do NOT un-bury them and I resent the implication. Re-drown them, kindly. The sea should keep what it takes. House rules.",
    outro:
      "Eight drowned men, re-drowned, returned to the sea with a firm note about finders-keepers. It's grim work, friend — they were people, once, before the water had opinions. But rest is rest, and they've got it now. The crystal they washed up with is yours. Go stand somewhere dry. You've earned dry.",
  },
  {
    id: 'q_beast_hunt_84',
    title: 'Wraith of the Tides',
    giver: 'mage_lyra',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'tidewraith', need: 5, label: 'Dispel 5 tidewraiths' }],
    rewards: { xp: { magic: 520, attack: 200 }, items: [{ id: 'crystal_cut', qty: 4 }, { id: 'herb_gold', qty: 2 }], blockCents: 110 },
    intro:
      "Tidewraiths are drowning given a grudge and a shape — they pull the tide itself up the beach to swallow whatever's standing there, usually me, usually mid-measurement. Five of them. Dispel them before high tide becomes a verb. The salt-crystal they leave behind sings; I want to know why; I'd like to stay un-drowned while finding out.",
    outro:
      "Five tidewraiths, dispelled, the tide restored to its lawful schedule. 'High tide' is a noun again. The singing salt-crystal is already upending my theory of resonance, which deserved upending. The cut crystal's your fee. You kept the ocean in its lane — harder than it sounds, and it sounds impossible. Good.",
  },
  {
    id: 'q_beast_hunt_85',
    title: 'Coral Reckoning',
    giver: 'smith_orin',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'coralgolem', need: 4, label: 'Break down 4 coral golems' }],
    rewards: { xp: { attack: 440, blacksmithing: 240 }, items: [{ id: 'crystal_raw', qty: 5 }, { id: 'bar_steel', qty: 2 }], blockCents: 100 },
    intro:
      "Coral golems grow themselves out of reef and shipwreck over centuries, slow and sharp and absolutely unbothered. Four of them have walled off a drowned armory I'd very much like to loot. Break them down. The living coral's worth a fortune and the steel inside the wreck is worth my undivided, GREEDY attention. Mind the edges. All of it is edges.",
    outro:
      "Four coral golems, broken down, drowned armory finally accessible to a man of my refined acquisitive instincts. The living coral alone paid for the trip twice over, and the shipwreck steel is sound after all these years. You're covered in cuts, I notice. Coral does that. The crystal and steel will more than cover the bandages. Grand work.",
  },
  {
    id: 'q_beast_hunt_86',
    title: 'Frostfin Frenzy',
    giver: 'prospector_finn',
    regionId: 'ironhold',
    steps: [{ kind: 'kill', target: 'frostfin', need: 9, label: 'Hook 9 frostfins' }],
    rewards: { xp: { attack: 280, fishing: 280 }, items: [{ id: 'fish_salmon', qty: 5 }, { id: 'crystal_shard', qty: 3 }], blockCents: 60 },
    intro:
      "Frostfins swim the glacier-melt pools and freeze the water solid around anything that gets close, including fishhooks, including fingers, including, on one memorable occasion, ME. Nine of them. Hook them fast or lose the line to ice. The flesh keeps forever, obviously, and the ice-gland fetches coin from the alchemists. Dress warm. Dress WARMER.",
    outro:
      "Nine frostfins hooked before they could ice you out — a feat, given they turn a pool to a skating rink out of pure spite. The flesh'll keep till the heat-death of the realm and the ice-glands sold well. Here's salmon and crystal. Your fingers are blue, but they're all present, which is the frostfin's idea of a defeat. Warm up.",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // VIII. ELEMENTAL MOTES — cores, essences, and the unstable bounties
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_beast_hunt_87',
    title: 'Cinder Motes',
    giver: 'prophet_karl',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'mote_cinder', need: 12, label: 'Snuff 12 cinder motes' }],
    rewards: { xp: { magic: 240, attack: 80 }, items: [{ id: 'crystal_shard', qty: 3 }, { id: 'ore_copper', qty: 4 }], blockCents: 40 },
    intro:
      "Cinder motes are the smallest, stupidest bits of living fire — fireflies with commitment issues and arson in their hearts. Twelve of them are drifting into the thatch-roofs and the thatch-roofs are, by nature, VERY into that. Snuff them. The ember-core's a decent fire-starter, ironically, under supervision.",
    outro:
      "Twelve cinder motes, snuffed, the thatch un-ignited and the village un-cremated. The ember-cores make a reliable fire-starter now that they've stopped having AMBITIONS. Copper and crystal, your due. Small work, but a whole village keeps its roofs. Not nothing.",
  },
  {
    id: 'q_beast_hunt_88',
    title: 'Flame On, Flame Off',
    giver: 'prophet_karl',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'elem_flame', need: 7, label: 'Douse 7 flame elementals' },
      { kind: 'kill', target: 'elem_magma', need: 4, label: 'Cool 4 magma elementals' },
    ],
    rewards: { xp: { magic: 420, attack: 160 }, items: [{ id: 'crystal_cut', qty: 3 }, { id: 'ore_gold', qty: 3 }], blockCents: 85 },
    intro:
      "Flame elementals are a bonfire that learned to walk; magma elementals are a volcano that learned to hold a grudge. Seven and four, respectively, cooking the lower ash into glass. Douse the flames, cool the magma, and bring me the heart-crystal each one leaves. Water helps. Spite helps more. You seem well-supplied with both.",
    outro:
      "Seven flames doused, four magmas cooled, the lower ash no longer glazing underfoot. The heart-crystals run hot even cut — careful where you pocket them. The elementals burned bright and brief, which is poetic, which they would not have appreciated, being fire. Gold and crystal, well earned.",
  },
  {
    id: 'q_beast_hunt_89',
    title: 'Frost Motes & Bother',
    giver: 'prospector_finn',
    regionId: 'ironhold',
    steps: [{ kind: 'kill', target: 'mote_frost', need: 12, label: 'Shatter 12 frost motes' }],
    rewards: { xp: { magic: 240, attack: 80 }, items: [{ id: 'crystal_shard', qty: 3 }, { id: 'ore_iron', qty: 4 }], blockCents: 40 },
    intro:
      "Frost motes are specks of living cold that frost up the drill-heads and freeze the lamp-oil solid, which brings the whole dig to a shivering halt. Twelve of them. Shatter them — they crack like an icicle with a secret. The frost-core keeps a cellar cold all summer, so really they're just misplaced appliances with attitude.",
    outro:
      "Twelve frost motes, shattered, the drills thawed and the lamp-oil liquid again. The frost-cores are already keeping the ale cellar crisp, which is the single most important dig-site improvement in a decade, don't @ me. Iron and crystal, your share. The cold's where cold belongs. Progress.",
  },
  {
    id: 'q_beast_hunt_90',
    title: 'Deep Freeze',
    giver: 'prospector_finn',
    regionId: 'ironhold',
    steps: [
      { kind: 'kill', target: 'elem_frost', need: 7, label: 'Thaw 7 frost elementals' },
      { kind: 'kill', target: 'elem_glacier', need: 3, label: 'Collapse 3 glacier elementals' },
    ],
    rewards: { xp: { magic: 440, attack: 180 }, items: [{ id: 'crystal_cut', qty: 4 }, { id: 'crystal_raw', qty: 4 }], blockCents: 95 },
    intro:
      "Frost elementals are a blizzard with a body; glacier elementals are a blizzard that settled down, bought property, and grew. Seven and three, freezing the richest shaft into a sapphire tomb. Thaw them, collapse them, and pry out the glacier-heart — it's the purest crystal the cold can make. Bundle up. Bundle up MORE. I mean it.",
    outro:
      "Seven frost elementals thawed, three glacier elementals collapsed, the sapphire tomb reopened as a working shaft. The glacier-hearts are flawless — the cold does good work, I'll grudgingly grant it, right before I sell the results. Cut and raw crystal, yours. You out-stubborned a glacier. Few can. Warm up before you brag.",
  },
  {
    id: 'q_beast_hunt_91',
    title: 'Spark Joy',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [{ kind: 'kill', target: 'mote_spark', need: 12, label: 'Discharge 12 spark motes' }],
    rewards: { xp: { magic: 260, archery: 100 }, items: [{ id: 'crystal_shard', qty: 3 }, { id: 'bar_copper', qty: 3 }], blockCents: 45 },
    intro:
      "Spark motes are static with a personality — they zip through the tower and discharge into whatever's most expensive and least insulated, which is usually my instruments and occasionally my hair. Twelve of them. Discharge them safely. The spark-core powers a lantern for a month, which ALMOST makes up for the frizz. Almost.",
    outro:
      "Twelve spark motes, discharged, my instruments un-fried and my hair slowly recovering its dignity. The spark-cores are lighting the whole east wing now, cheap and bright. Copper and crystal, your reward. You wrangled living lightning without becoming a conductor. That's a passing grade and a rare one.",
  },
  {
    id: 'q_beast_hunt_92',
    title: 'Storm Warning',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'elem_storm', need: 6, label: 'Ground 6 storm elementals' },
      { kind: 'kill', target: 'elem_gale', need: 4, label: 'Still 4 gale elementals' },
    ],
    rewards: { xp: { magic: 460, archery: 200 }, items: [{ id: 'crystal_cut', qty: 4 }, { id: 'bar_steel', qty: 2 }], blockCents: 100 },
    intro:
      "Storm elementals are a thunderhead that picked a fight; gale elementals are the wind that won't stop talking. Six and four are circling the spire, and my weather instruments can't tell a reading from a riot. Ground the storms, still the gales, and bring the charged-crystal. Rubber-soled boots. Don't ask how I learned. The hair, again. Always the hair.",
    outro:
      "Six storm elementals grounded, four gale elementals stilled, and the sky over the spire has remembered how to behave. The charged-crystals hum with clean potential now — gorgeous readings, finally. The cut crystal and steel are yours. You picked a fight with the weather and WON, which the weather is not used to. Savor it.",
  },
  {
    id: 'q_beast_hunt_93',
    title: 'Between a Rock',
    giver: 'foreman_dagna',
    regionId: 'ironhold',
    steps: [{ kind: 'kill', target: 'mote_pebble', need: 12, label: 'Crush 12 pebble motes' }],
    rewards: { xp: { magic: 220, mining: 160 }, items: [{ id: 'ore_iron', qty: 5 }, { id: 'clay_lump', qty: 4 }], blockCents: 40 },
    intro:
      "Pebble motes are the mountain's hiccups — bits of living stone that roll into the gears and 'optimize' the machinery into a cairn. Twelve of them. Crush them back into ordinary gravel, which is all they ever were before they got IDEAS. The stone-core's useless, but the gravel's good aggregate, and I'm nothing if not thrifty. And angry. Thrifty and angry.",
    outro:
      "Twelve pebble motes, crushed into honest, idea-free gravel. The gears turn, the cairns stay unbuilt, and the mountain can hiccup somewhere ELSE. Iron and clay, your pay. You de-animated a dozen rocks, which sounds easy and is the opposite. Thrifty and angry salutes you.",
  },
  {
    id: 'q_beast_hunt_94',
    title: 'Set in Stone',
    giver: 'smith_orin',
    regionId: 'ironhold',
    steps: [
      { kind: 'kill', target: 'elem_stone', need: 6, label: 'Shatter 6 stone elementals' },
      { kind: 'kill', target: 'elem_crystal', need: 4, label: 'Fracture 4 crystal elementals' },
    ],
    rewards: { xp: { magic: 440, mining: 220 }, items: [{ id: 'crystal_cut', qty: 4 }, { id: 'crystal_raw', qty: 5 }], blockCents: 95 },
    intro:
      "Stone elementals are a landslide that stood up; crystal elementals are what happens when the deep crystal gets ANIMATED and SMUG about it. Six and four, guarding the mother-lode like it's theirs by birthright. Shatter them, fracture the crystal ones, and bring me the geode-hearts. Pure crystal, no digging required — they ARE the vein. Rude of them, honestly.",
    outro:
      "Six stone elementals shattered, four crystal elementals fractured, the mother-lode liberated from its presumptuous guardians. The geode-hearts are flawless — the vein gift-wrapped itself and then objected to being opened, which is just like a vein. Cut and raw crystal, yours. You mined the un-mineable by hitting it until it agreed. That's craftsmanship.",
  },
  {
    id: 'q_beast_hunt_95',
    title: 'Void Where Prohibited',
    giver: 'prophet_karl',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'mote_void', need: 10, label: 'Seal 10 void motes' }],
    rewards: { xp: { magic: 480, attack: 160 }, items: [{ id: 'crystal_cut', qty: 4 }, { id: 'potion_regret', qty: 1 }], blockCents: 90 },
    intro:
      "Void motes are little holes in creation that drift where reality's worn thin, nibbling existence like moths at a curtain. Ten of them have appeared at the edge of the Forgotten, which is a BAD edge to see holes in. Seal them. Do NOT look into one for longer than a blink — the void looks back, and it takes notes. The null-crystal they leave is worth a fortune and a few nightmares.",
    outro:
      "Ten void motes, sealed, the worn edge of creation darned shut before anything decided to widen it. You didn't stare too long — I can tell, because you're still entirely here, all of you, in the correct order. The null-crystals cut into the deepest black you've ever held. Worth a fortune. Keep them covered. The void remembers an open door.",
  },
  {
    id: 'q_beast_hunt_96',
    title: 'The Hole Truth',
    giver: 'mage_lyra',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'elem_void', need: 4, label: 'Collapse 4 void elementals' }],
    rewards: { xp: { magic: 680, attack: 260 }, items: [{ id: 'crystal_cut', qty: 5 }, { id: 'bar_gold', qty: 2 }], blockCents: 170 },
    intro:
      "A void elemental is a mote that grew up — a walking absence, a sentence the universe is trying to delete. Four of them are unmaking the ruins at the world's edge, one quiet erasure at a time. Collapse them before they finish the sentence and start on the paragraph. This is as dangerous as magic gets, which is why I'm sending you and not going myself. I'm a scholar. Scholarship requires a living scholar.",
    outro:
      "Four void elementals, collapsed, the universe's deletion key pried from their nonexistent hands. The ruins at the edge still EXIST, which, given what you faced, is the whole victory. The null-crystal cores are the rarest things I've catalogued and the gold's a bonus. You fought absence itself and remain emphatically present. Astonishing. Now let's both go stand in some reassuring daylight.",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // IX. HERE BE DRAGONS — the frontier's wyrmling-to-dragon bounty ladder
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_beast_hunt_97',
    title: 'Hatchling Season',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'wyrmling_ember', need: 6, label: 'Catch 6 ember wyrmlings' },
      { kind: 'kill', target: 'wyrmling_frost', need: 6, label: 'Catch 6 frost wyrmlings' },
    ],
    rewards: { xp: { attack: 440, archery: 200 }, items: [{ id: 'hide_tough', qty: 5 }, { id: 'crystal_cut', qty: 3 }], blockCents: 110 },
    intro:
      "Dragons start small and get WORSE, so the smart play is 'small'. Ember and frost wyrmlings are nesting on the frontier — six of each, no bigger than a dog, twice as flammable or frostbitten respectively. Catch them now, while 'catch' is still a word that applies. The scaled hide's already dragon-grade. Next year it'll be dragon-SIZED. Act now.",
    outro:
      "Six ember wyrmlings, six frost, the whole clutch handled while they were still dog-sized nuisances instead of cart-sized catastrophes. Preventative dragon-slaying — the cheapest kind, by FAR. The baby-dragon hide's remarkable and the elemental cores are a bonus. You saved the frontier a very bad next year. It won't thank you. I barely will. There. Done.",
  },
  {
    id: 'q_beast_hunt_98',
    title: 'Ash and Crag',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'drake_ash', need: 4, label: 'Down 4 ash drakes' },
      { kind: 'kill', target: 'drake_crag', need: 4, label: 'Down 4 crag drakes' },
    ],
    rewards: { xp: { attack: 540, defense: 240 }, items: [{ id: 'hide_tough', qty: 6 }, { id: 'bar_steel', qty: 3 }], blockCents: 140 },
    intro:
      "Drakes are dragons that skipped the 'majestic' lessons and went straight to 'destructive'. Ash drakes nest in the burn-scars, crag drakes in the high rock — four of each, all wing and appetite. Down them. The hide armors a warrior and the price armors your purse. They can't breathe fire yet, just 'breathe menacingly', which is survivable. Barely. Go while it's still barely.",
    outro:
      "Four ash drakes and four crag drakes, downed, the frontier's skies notably less toothy. They were one growth-spurt away from 'fire' and you caught them at 'menace' — good timing, better aim. The drake-hide's superb and the steel from their lairs is a tidy bonus. The frontier's quieter. Don't get comfortable; there are bigger ones. There are ALWAYS bigger ones.",
  },
  {
    id: 'q_beast_hunt_99',
    title: 'Dune Rider',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [
      { kind: 'explore', target: 'forgotten', need: 1, label: 'Cross the deep frontier dunes' },
      { kind: 'kill', target: 'drake_dune', need: 5, label: 'Hunt 5 dune drakes' },
    ],
    rewards: { xp: { attack: 580, vitality: 260 }, items: [{ id: 'hide_tough', qty: 7 }, { id: 'bar_gold', qty: 1 }], blockCents: 150 },
    intro:
      "Dune drakes 'swim' through the sand like sharks with a grudge against caravans, and the deep frontier dunes are LOUSY with them. Cross the dunes first — I want to know you can — then hunt five. They surface fast and bite faster. Watch the sand for ripples; a ripple's a drake deciding you're lunch. The hide's worth the sunburn. Probably.",
    outro:
      "Deep dunes crossed, five dune drakes hunted out of the sand they thought hid them. Shark-dragons in a desert — the frontier's imagination for killing people remains boundless. You read the ripples and struck first, which is the only way that fight ends well. Superb hide, honest gold. The caravans can cross again. They'll never know your name. Fitting.",
  },
  {
    id: 'q_beast_hunt_100',
    title: 'Cinder and Glacier',
    giver: 'captain_elara',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'wyvern_cinder', need: 3, label: 'Fell 3 cinder wyverns' },
      { kind: 'kill', target: 'wyvern_glacier', need: 3, label: 'Fell 3 glacier wyverns' },
    ],
    rewards: { xp: { attack: 640, defense: 320 }, items: [{ id: 'hide_tough', qty: 8 }, { id: 'bar_gold', qty: 2 }], blockCents: 180 },
    intro:
      "Wyverns are drakes with a frequent-flyer problem and a breath weapon that actually WORKS now. Cinder wyverns scorch the Crown's eastern watch; glacier wyverns ice the northern. Three of each. The Crown wants its borders un-breathed-upon and will pay per wing. Bring a shield you don't mind losing and a nerve you can't afford to. Three and three. Fly safe. You won't. But try.",
    outro:
      "Three cinder wyverns, three glacier, felled, the Crown's watchtowers no longer doubling as kindling and ice sculpture. These ones could BREATHE — you'll have the scorch and frost marks to prove it — and you downed six anyway. The hide's magnificent and the Crown paid per wing without even haggling, which is unheard of. You've graduated from drakes to dragons-in-all-but-name. The real ones are next. Rest first.",
  },
  {
    id: 'q_beast_hunt_101',
    title: 'Prism Wings',
    giver: 'mage_lyra',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'drake_prism', need: 4, label: 'Down 4 prism drakes' },
      { kind: 'collect', target: 'crystal_cut', need: 4, label: 'Recover 4 prism-scales' },
    ],
    rewards: { xp: { attack: 560, magic: 320 }, items: [{ id: 'crystal_cut', qty: 5 }, { id: 'hide_tough', qty: 5 }], blockCents: 170 },
    intro:
      "Prism drakes grew scales of living crystal that split your own spells back at you in a rainbow of 'that was a mistake'. Four of them. Recover the prism-scales — they refract magic like nothing I've ever studied, and I've studied embarrassing amounts. Vary your attacks; hit a prism drake with the same spell twice and it'll have already filed the counter-argument. Beautiful creatures. Shame. Go.",
    outro:
      "Four prism drakes, downed, four prism-scales recovered from the only dragon that fights you with your own reflection. The scales refract magic into geometries my treatise doesn't have WORDS for yet — I'll invent some. You varied your attacks and out-thought a crystal, which most people can't do to a doorknob. Cut crystal and prime hide, yours. Chapter one of a whole new book. Thank you, genuinely. Rare, from me.",
  },
  {
    id: 'q_beast_hunt_102',
    title: 'Wyrms Turn',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'wyrm_magma', need: 2, label: 'Slay 2 magma wyrms' },
      { kind: 'kill', target: 'wyrm_permafrost', need: 2, label: 'Slay 2 permafrost wyrms' },
    ],
    rewards: { xp: { attack: 720, defense: 380 }, items: [{ id: 'hide_tough', qty: 8 }, { id: 'bar_gold', qty: 3 }], blockCents: 220 },
    intro:
      "Wyrms are the long ones — no wings, all serpent, tunneling through the frontier's bones and surfacing where you least want a hundred feet of angry geology-snake. Magma wyrms melt the south, permafrost wyrms freeze the north. Two of each. This is the big leagues, friend. The hide's nearly priceless and the fight's nearly fatal, which is the exchange rate out here. Two and two. Don't tunnel-vision. The pun is a warning.",
    outro:
      "Two magma wyrms, two permafrost, slain — a hundred feet each of surfacing nightmare, dealt with by one hunter and a great deal of nerve. The frontier's bones are un-infested, the south un-melted, the north un-frozen. That hide is nearly priceless and you've earned every scale of it, plus gold enough to retire, if hunters retired, which they don't, which is their whole tragedy. You're in the big leagues now. There are exactly two things bigger. You'll meet them.",
  },
  {
    id: 'q_beast_hunt_103',
    title: 'Crystalline and Bone',
    giver: 'mage_lyra',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'wyrm_crystalline', need: 2, label: 'Shatter 2 crystalline wyrms' },
      { kind: 'kill', target: 'wyrm_bone', need: 2, label: 'Unmake 2 bone wyrms' },
    ],
    rewards: { xp: { attack: 760, magic: 420 }, items: [{ id: 'crystal_cut', qty: 6 }, { id: 'bar_gold', qty: 3 }], blockCents: 240 },
    intro:
      "Crystalline wyrms grew themselves out of the deep crystal and move like a thousand years of pressure finally let go; bone wyrms are dead dragons that forgot to stay that way, rattling through the barrows. Two of each. Shatter the crystal ones, unmake the bone ones, and bring me a core from each — one sings, one screams, both rewrite what I thought I knew. This is nearly the top of the board. Nearly. Go carefully. Go armed. Go now.",
    outro:
      "Two crystalline wyrms shattered, two bone wyrms unmade, a core from each in my trembling, delighted hands. One sings like the deep earth; one screams like the grave; together they're the two best things I've ever been handed and the two worst things to hold at once. You fought living pressure and walking death in the same week and won both. The cut crystal and gold are nothing next to what you survived. There's one rung left on the ladder. You already know it has wings.",
  },
  {
    id: 'q_beast_hunt_104',
    title: 'The Ashfall Wyrm',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'dragon_ashfall', need: 1, label: 'Slay the Ashfall Dragon' }],
    rewards: { xp: { attack: 940, vitality: 500, defense: 400 }, items: [{ id: 'hide_tough', qty: 10 }, { id: 'bar_gold', qty: 4 }, { id: 'crystal_cut', qty: 4 }], blockCents: 320 },
    intro:
      "Here it is. A real one. The Ashfall Dragon turns the sky to grey snow and the ground to a memory of itself — it's the reason the frontier's southern third is called 'the quiet'. Nothing lives there now. One dragon. One hunter. I have watched a great many 'heroes' walk south toward it, and I have watched the ash settle. You're different. You'd better be. Bring me a scale. Bring me YOURSELF, attached to the scale. That's the whole ask.",
    outro:
      "The Ashfall Dragon is DEAD. The grey snow has stopped. For the first time in living memory, the sky over the southern third is BLUE, and a hermit who hates everyone is standing in his ruined yard with something on his face that is, I'll deny this, a tear. You walked into the quiet and made it loud, and then you made it silent in the good way. The dragon-hide, the gold, the scale — all yours, all legendary. You're not a hunter anymore. You're the thing hunters tell stories about. Two left. The cold one. The black one. But sit, first. Even legends sit.",
  },
  {
    id: 'q_beast_hunt_105',
    title: 'The Rime Dragon',
    giver: 'captain_elara',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'dragon_rime', need: 1, label: 'Slay the Rime Dragon' }],
    rewards: { xp: { attack: 970, defense: 500, magic: 400 }, items: [{ id: 'hide_tough', qty: 10 }, { id: 'bar_gold', qty: 5 }, { id: 'crystal_cut', qty: 5 }], blockCents: 360 },
    intro:
      "The Rime Dragon froze an entire Crown legion mid-march — they're still up there, a thousand men in glittering ranks, perfectly preserved, perfectly dead. The Crown has stopped sending armies. The Crown is sending YOU. One dragon, old as winter, cold enough that fire gives UP near it. Slay it and thaw what it stole. The Crown will deny the legion ever existed; you and I will know. Bring me a frost-scale. Bring me the thaw. Go, before I think too hard about the odds.",
    outro:
      "The Rime Dragon is slain and the glittering legion is melting free — a thousand men, centuries late, collapsing into a rest they earned the hard way. The Crown will carve a false date on a true monument and call it history. You and I will know what really ended the winter: one hunter, one impossible fight, and a refusal to freeze. The frost-scale alone is worth a province. You're worth more than the Crown will ever admit, which is why I'm telling you now, off the record, plainly: that was the finest hunt I have ever seen. One dragon left. The black one. The oldest. Go when you're ready. Only when you're ready.",
  },
  {
    id: 'q_beast_hunt_106',
    title: 'The Obsidian Dragon',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [
      { kind: 'explore', target: 'forgotten', need: 1, label: 'Reach the dragon’s black caldera' },
      { kind: 'kill', target: 'dragon_obsidian', need: 1, label: 'Slay the Obsidian Dragon' },
    ],
    rewards: { xp: { attack: 999, defense: 600, vitality: 600, magic: 500 }, items: [{ id: 'hide_tough', qty: 12 }, { id: 'bar_gold', qty: 6 }, { id: 'crystal_cut', qty: 6 }], blockCents: 500 },
    intro:
      "The Obsidian Dragon is the first dragon and the last — older than the frontier, older than the kingdoms, older than the WORD for old. It sleeps in a black caldera at the literal edge of the map, and when it stirs, the whole world has a bad dream. Every other dragon was a child of its shadow. Reach the caldera. Wake it. End it. I moved to the edge of the world to be alone, and the truth is, I moved here to watch for THIS. You're the one I was waiting for, you magnificent, doomed, impossible hunter. Go. Bring the world a morning without the dream. And — I can't believe I'm saying this — come back. I'll leave the light on. Once. For you.",
    outro:
      "It's over. The Obsidian Dragon — the first thing that ever hunted, the shadow every other dragon was born from — is DEAD, and the world woke up this morning without the bad dream for the first time since there were mornings. The caldera is quiet. The map has an edge again, and the edge is just a place now, not a warning. You did the thing that was never supposed to be doable, and you walked back out of the black to tell it. I left the light on, like I said. One hermit, one lantern, at the edge of a world you saved. Sit down. Stay a while. You've earned every scale, every bar, every coin, and the one thing I never give anyone: a welcome. Welcome home, hunter. The board is clear. You beat it. You beat all of it.",
  },
]

/**
 * Chains — the bounty board reads as a real hunter's career, from fawns to
 * the first-and-last dragon. Each prereq gates the next rung of its ladder.
 */
const prereqs: Record<string, readonly string[]> = {
  // Lodge intro → big game
  q_beast_hunt_02: ['q_beast_hunt_01'],
  q_beast_hunt_05: ['q_beast_hunt_02'],
  q_beast_hunt_06: ['q_beast_hunt_05'],
  q_beast_hunt_07: ['q_beast_hunt_06'],
  q_beast_hunt_13: ['q_beast_hunt_10'],
  q_beast_hunt_14: ['q_beast_hunt_11'],
  // Grave-work undead ladder
  q_beast_hunt_16: ['q_beast_hunt_15'],
  q_beast_hunt_20: ['q_beast_hunt_15'],
  q_beast_hunt_21: ['q_beast_hunt_20'],
  q_beast_hunt_22: ['q_beast_hunt_21'],
  q_beast_hunt_25: ['q_beast_hunt_22'],
  q_beast_hunt_26: ['q_beast_hunt_25'],
  q_beast_hunt_27: ['q_beast_hunt_26'],
  q_beast_hunt_28: ['q_beast_hunt_27'],
  // Pit / fiend ladder
  q_beast_hunt_30: ['q_beast_hunt_29'],
  q_beast_hunt_38: ['q_beast_hunt_32'],
  q_beast_hunt_39: ['q_beast_hunt_38'],
  q_beast_hunt_40: ['q_beast_hunt_39'],
  q_beast_hunt_41: ['q_beast_hunt_40'],
  q_beast_hunt_42: ['q_beast_hunt_41'],
  // Construct ladder
  q_beast_hunt_44: ['q_beast_hunt_43'],
  q_beast_hunt_51: ['q_beast_hunt_47'],
  q_beast_hunt_52: ['q_beast_hunt_44'],
  q_beast_hunt_53: ['q_beast_hunt_52'],
  q_beast_hunt_55: ['q_beast_hunt_54'],
  q_beast_hunt_57: ['q_beast_hunt_55', 'q_beast_hunt_56'],
  // Insect chains
  q_beast_hunt_61: ['q_beast_hunt_60'],
  q_beast_hunt_63: ['q_beast_hunt_62'],
  q_beast_hunt_65: ['q_beast_hunt_64'],
  q_beast_hunt_72: ['q_beast_hunt_69'],
  // Aquatic ladder
  q_beast_hunt_74: ['q_beast_hunt_73'],
  q_beast_hunt_80: ['q_beast_hunt_77'],
  q_beast_hunt_84: ['q_beast_hunt_83'],
  q_beast_hunt_85: ['q_beast_hunt_82'],
  // Elemental ladder
  q_beast_hunt_88: ['q_beast_hunt_87'],
  q_beast_hunt_90: ['q_beast_hunt_89'],
  q_beast_hunt_92: ['q_beast_hunt_91'],
  q_beast_hunt_94: ['q_beast_hunt_93'],
  q_beast_hunt_96: ['q_beast_hunt_95'],
  // Dragon ladder — the grand finale, gated rung by rung
  q_beast_hunt_98: ['q_beast_hunt_97'],
  q_beast_hunt_99: ['q_beast_hunt_98'],
  q_beast_hunt_100: ['q_beast_hunt_99'],
  q_beast_hunt_101: ['q_beast_hunt_100'],
  q_beast_hunt_102: ['q_beast_hunt_101'],
  q_beast_hunt_103: ['q_beast_hunt_102'],
  q_beast_hunt_104: ['q_beast_hunt_103'],
  q_beast_hunt_105: ['q_beast_hunt_104'],
  q_beast_hunt_106: ['q_beast_hunt_105'],
}

/** Display names for reward/collect ids that may lack a catalog name. */
const itemNames: Record<string, string> = {
  hide_wolf: 'Wolf Hide',
  hide_boar: 'Boar Hide',
  hide_tough: 'Tough Hide',
  food_honey: 'Jar of Honey',
  food_jelly: 'Wobbling Jelly',
  food_jerky: 'Strip Jerky',
  potion_regret: 'Potion of Regret',
  berry_red: 'Red Berries',
  herb_gold: 'Gold Herb',
  clay_lump: 'Lump of Clay',
}

registerPack({ quests, prereqs, itemNames })
