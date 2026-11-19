/**
 * questmega_menagerie — the "catch 'em, tame 'em, befriend the weird ones" pack.
 *
 * ~75 quests about taming/collecting the new rare pets & mounts and befriending
 * fae & elementals. Every KILL target is a real base or new species id; every
 * GATHER target is a real node kind; every COLLECT target and every REWARD item
 * is a real catalog material/food/potion id (no armor-piece rewards — those live
 * in other packs). EXPLORE targets use real region ids (narrated as "the
 * frontier" / "the outer isles"). Rewards scale from modest early XP toward the
 * 999 cap on the late dragon chains.
 *
 * Writing register: funny, mean-at-life. Taming is framed as a series of
 * increasingly unwise relationships with animals that could eat you.
 *
 * Side-effect: registers at import time via registerPack({ quests, prereqs,
 * itemNames }). Imported from src/content/index.ts.
 */
import { registerPack } from './packs'
import type { QuestDef } from '../types'

const quests: QuestDef[] = [
  // ═══════════════════════════════════════════════════════════════════════
  // ARC 1 — Meadow & Woodland fauna. Scout Wren teaches you that "tame" is a
  // verb you earn by first being very rude to the local wildlife.
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_menagerie_01',
    title: 'Bambi, But Vengeful',
    giver: 'scout_wren',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'meadow_fawn', need: 6, label: 'Convince 6 meadow fawns of your superiority' }],
    rewards: { xp: { attack: 120, vitality: 60 }, items: [{ id: 'hide_wolf', qty: 3 }], blockCents: 20 },
    intro:
      "You want a pet? Adorable. First rule of taming: the cute ones kick. These meadow fawns look like a greeting card and fight like a bar brawl. Teach six of them who feeds whom, and we'll talk about the leash.",
    outro:
      "Six fawns humbled, one of your shins ruined. Congratulations — the survivors now follow you at a respectful distance, which in deer is basically a marriage proposal. You're a tamer now. Barely.",
  },
  {
    id: 'q_menagerie_02',
    title: 'The Lynx Interview',
    giver: 'scout_wren',
    regionId: 'greenwood',
    steps: [
      { kind: 'kill', target: 'thicket_lynx', need: 5, label: 'Out-sneak 5 thicket lynxes' },
      { kind: 'collect', target: 'berry_red', need: 6, label: 'Gather 6 red berries as a bribe' },
    ],
    rewards: { xp: { attack: 150, archery: 80 }, items: [{ id: 'food_jerky', qty: 4 }], blockCents: 25 },
    intro:
      "A thicket lynx will never respect you until it has lost to you at least once and been bribed at least twice. Beat five, then bring red berries — they pretend not to like them, like a cat pretending it didn't want the box.",
    outro:
      "Five lynxes bested, a basket of berries extorted out of your dignity. One of them is now 'yours', in the sense that it will tolerate you until something more interesting walks past. Pets, everyone.",
  },
  {
    id: 'q_menagerie_03',
    title: 'Fox News',
    giver: 'ranger_kael',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'tundra_fox', need: 7, label: 'Negotiate with 7 tundra foxes (loudly)' }],
    rewards: { xp: { archery: 160, attack: 60 }, items: [{ id: 'hide_tough', qty: 3 }], blockCents: 30 },
    intro:
      "Tundra foxes are liars. Little orange con artists. One of them sold me a 'map to treasure' that was just my own house, redrawn worse. Discourage seven of them and maybe the rest will deal honestly. They won't. But try.",
    outro:
      "Seven foxes out-foxed. One's decided you're the biggest predator around and has attached itself to you for protection, which means you now have a tiny criminal following you home. Lock your coin purse.",
  },
  {
    id: 'q_menagerie_04',
    title: 'Good Boy, Eventually',
    giver: 'ranger_kael',
    regionId: 'greenwood',
    steps: [
      { kind: 'kill', target: 'ridgeback_hound', need: 6, label: 'Establish dominance over 6 ridgeback hounds' },
      { kind: 'collect', target: 'food_jerky', need: 5, label: 'Secure 5 jerky for training' },
    ],
    rewards: { xp: { attack: 200, vitality: 100 }, items: [{ id: 'hide_boar', qty: 4 }], blockCents: 35 },
    intro:
      "Ridgeback hounds come in one personality: 'bite now, apologize never'. Best war-mount you can get on the frontier, if you survive the application process. Win six fights, bring jerky. The jerky is non-negotiable. So are they.",
    outro:
      "Six hounds convinced, one pack formed around you like you're the meanest dog in it, which — statistically, after that — you are. Ride well. Don't wear anything that smells like a mail carrier.",
  },
  {
    id: 'q_menagerie_05',
    title: 'Boar-ing Conversation',
    giver: 'ranger_kael',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'dire_boar', need: 8, label: 'Settle disputes with 8 dire boars' }],
    rewards: { xp: { attack: 240, defense: 120 }, items: [{ id: 'hide_boar', qty: 5 }, { id: 'food_pie', qty: 2 }], blockCents: 40 },
    intro:
      "A dire boar is a sofa with tusks and a grudge. Eight of them have decided the greenwood trail is theirs. Change their minds. A tamed one carries your luggage AND gores your enemies — the ideal relationship, frankly.",
    outro:
      "Eight boars re-educated. One now trots behind you like an enormous, bristly dog that could kill a knight. The village children are terrified, which is the correct response and also free security.",
  },
  {
    id: 'q_menagerie_06',
    title: "Here, Kitty (Please Don't)",
    giver: 'scout_wren',
    regionId: 'greenwood',
    steps: [
      { kind: 'kill', target: 'shadow_panther', need: 5, label: 'Earn the respect of 5 shadow panthers' },
      { kind: 'kill', target: 'horned_stag', need: 4, label: 'Impress 4 horned stags with your nerve' },
    ],
    rewards: { xp: { attack: 300, archery: 150 }, items: [{ id: 'crystal_raw', qty: 3 }, { id: 'food_jerky', qty: 4 }], blockCents: 55 },
    intro:
      "Graduation exam. Shadow panthers hunt the thing that's hunting you — invisible until it's rude. Horned stags just have a lot of forehead opinions. Best five panthers and four stags and you'll have earned a mount nobody else on the frontier can claim.",
    outro:
      "Five panthers, four stags, all suitably humbled. A panther now melts out of the dark to walk at your heel, and honestly that's the coolest thing that will ever happen to you. Peak. It's all downhill and on fire from here.",
  },
  {
    id: 'q_menagerie_07',
    title: 'Bear With Me',
    giver: 'scout_wren',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'grizzled_bruin', need: 3, label: 'Wrestle 3 grizzled bruins to a draw' }],
    rewards: { xp: { attack: 360, vitality: 200 }, items: [{ id: 'hide_tough', qty: 5 }, { id: 'food_honey', qty: 3 }], blockCents: 70 },
    intro:
      "Final test before I sign off on you. A grizzled bruin is nine hundred pounds of 'no'. You don't tame a bear — you reach a mutual understanding that neither of you wants to find out who wins. Reach that understanding three times. Bring honey. Bears are bribable, like senators.",
    outro:
      "Three bruins, three understandings, zero deaths — yours. One shambles after you now, mostly for the honey, partly out of what I'll generously call affection. You've got a bear. Try to act like that's normal.",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // ARC 2 — Savanna & high-mountain mounts. Hermit Vex, who hates company,
  // sends you to collect the most antisocial animals on the frontier.
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_menagerie_08',
    title: 'Laughing Matter',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'savanna_hyena', need: 8, label: 'Silence 8 savanna hyenas (temporarily)' }],
    rewards: { xp: { attack: 260, defense: 100 }, items: [{ id: 'bar_iron', qty: 3 }], blockCents: 45 },
    intro:
      "Savanna hyenas laugh. At everything. At ME. At my gardening. Eight of them have formed a comedy club outside my hut and I am the entire act. Shut them up. Tame one if you must — it'll laugh at your enemies instead, which I can tolerate.",
    outro:
      "Eight comedians, eight closed mics. One now cackles exclusively at people you're fighting, which is disconcerting but on-brand. Take your iron. Take your hyena. Take it all away from my property.",
  },
  {
    id: 'q_menagerie_09',
    title: 'Ram It Home',
    giver: 'foreman_dagna',
    regionId: 'ironhold',
    steps: [
      { kind: 'kill', target: 'crag_ram', need: 7, label: 'Head-butt 7 crag rams into respect' },
      { kind: 'gather', target: 'iron_vein', need: 5, label: 'Mine 5 iron veins for the harness' },
    ],
    rewards: { xp: { attack: 280, mining: 150 }, items: [{ id: 'bar_steel', qty: 3 }], blockCents: 50 },
    intro:
      "A crag ram climbs sheer rock like it's got a grudge against physics. Best pack animal in the mountains, if you can survive seven of them trying to fold you like laundry. Then mine the iron for a harness, because tamed is not the same as 'won't launch you off a cliff for fun'.",
    outro:
      "Seven rams humbled, one harness forged. Your new ram will haul ore up sheer cliffs and occasionally headbutt you off said cliffs. We call that 'character'. The healer calls it 'job security'.",
  },
  {
    id: 'q_menagerie_10',
    title: 'Cool Cat',
    giver: 'foreman_dagna',
    regionId: 'ironhold',
    steps: [{ kind: 'kill', target: 'frost_lynx', need: 6, label: 'Out-chill 6 frost lynxes' }],
    rewards: { xp: { attack: 300, defense: 140 }, items: [{ id: 'crystal_raw', qty: 4 }], blockCents: 55 },
    intro:
      "Frost lynxes live where it's so cold your complaints freeze mid-air. Six of them have been raiding the mine's food stores and leaving nothing but smug paw prints. Cool their enthusiasm. A tamed one keeps your enemies at a literal distance — frostbite.",
    outro:
      "Six lynxes, suitably humbled, one now following you like a very cold shadow. It sleeps on your face. You will never be warm again, but you'll never be ambushed either. Trade-offs.",
  },
  {
    id: 'q_menagerie_11',
    title: 'King of the Jungle Gym',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'savanna_lion', need: 5, label: 'Dethrone 5 savanna lions' }],
    rewards: { xp: { attack: 340, vitality: 160 }, items: [{ id: 'hide_tough', qty: 5 }, { id: 'food_jerky', qty: 3 }], blockCents: 65 },
    intro:
      "A savanna lion thinks it's royalty because it naps eighteen hours a day and lets everyone else do the hunting. Sounds like most nobles I've met. Dethrone five. Tame one and you'll have a mount that terrifies kingdoms and refuses to work. Relatable.",
    outro:
      "Five lions dethroned, one abdicated directly into your service. It will ride into battle magnificently and then immediately find a sunbeam. You've tamed a monarch. Lower your expectations accordingly.",
  },
  {
    id: 'q_menagerie_12',
    title: 'Grin and Bear It, Again',
    giver: 'foreman_dagna',
    regionId: 'ironhold',
    steps: [
      { kind: 'kill', target: 'cave_bear', need: 4, label: 'Reach terms with 4 cave bears' },
      { kind: 'kill', target: 'pack_raptor', need: 6, label: 'Out-pack 6 pack raptors' },
    ],
    rewards: { xp: { attack: 420, defense: 220 }, items: [{ id: 'bar_steel', qty: 4 }, { id: 'food_honey', qty: 3 }], blockCents: 90 },
    intro:
      "The deep mine has cave bears the size of ore carts and pack raptors that hunt in coordinated little nightmares. Four bears, six raptors. Tame the lot and you'll have an entourage that makes bandits reconsider their career. Don't get eaten during the negotiations.",
    outro:
      "Four bears, six raptors, one very alarming pet convoy. You now travel with a security detail that could flatten a town. The miners salute you. The raptors clicker at you. It's a whole thing. Enjoy.",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // ARC 3 — Gravekeeper Sol's undead menagerie. Yes, you can tame the dead.
  // No, you should not. Sol thinks it's lovely.
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_menagerie_13',
    title: 'Adopt, Don\'t Shop (The Dead)',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'ghoul_grave', need: 8, label: 'Re-settle 8 grave ghouls' }],
    rewards: { xp: { attack: 260, magic: 120 }, items: [{ id: 'herb_red', qty: 5 }], blockCents: 40 },
    intro:
      "Everyone wants a kitten. Gerald wanted a grave ghoul, and now Gerald's a very happy skeleton with a shambling best friend. The graveyard's overrun — re-settle eight of them, and if one imprints on you, well. Not every pet has to breathe, friend.",
    outro:
      "Eight ghouls re-settled, one now plodding after you with the devotion only the mindless can offer. It doesn't eat, it doesn't sleep, it occasionally loses a finger on your carpet. It's family now. Sol's crying. Happy tears. Probably.",
  },
  {
    id: 'q_menagerie_14',
    title: "Something's Crawling",
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'gravecrawler', need: 7, label: 'Un-crawl 7 gravecrawlers' },
      { kind: 'kill', target: 'plague_rat', need: 6, label: 'Discourage 6 plague rats' },
    ],
    rewards: { xp: { attack: 280, magic: 140 }, items: [{ id: 'mushroom_brown', qty: 6 }], blockCents: 45 },
    intro:
      "Gravecrawlers and plague rats are what happens when the graveyard throws a party and doesn't clean up. Seven and six, respectively. A tamed plague rat makes an EXCELLENT gift for someone you dislike. I keep three. For enemies I don't have yet. Optimism!",
    outro:
      "Thirteen pests managed. One plague rat now rides in your pocket, radiating illness and loyalty in equal measure. Do not pet it with a cut on your hand. Do not pet it, generally. But it loves you. Grossly.",
  },
  {
    id: 'q_menagerie_15',
    title: 'Mothman\'s Cousin',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'deathmoth_pale', need: 9, label: 'Ground 9 pale deathmoths' }],
    rewards: { xp: { archery: 300, magic: 100 }, items: [{ id: 'herb_blue', qty: 5 }], blockCents: 50 },
    intro:
      "Pale deathmoths are drawn to lantern-light and screaming, both of which I produce in quantity. Nine of them. Fluttering. Constantly. A tamed one glows faintly and leads you through the dark, which is either useful or a horror story depending on your bedtime. Nine. Go.",
    outro:
      "Nine deathmoths grounded, one fluttering gently at your shoulder like a very large, very ominous nightlight. The dust it sheds is probably fine. Probably. Don't inhale it. Lovely pet, truly. Sol approves.",
  },
  {
    id: 'q_menagerie_16',
    title: 'Imp Friends Forever',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'corpse_imp', need: 7, label: 'Out-spite 7 corpse imps' },
      { kind: 'kill', target: 'gloomhound', need: 5, label: 'Leash 5 gloomhounds' },
    ],
    rewards: { xp: { attack: 340, magic: 180 }, items: [{ id: 'crystal_shard', qty: 3 }, { id: 'food_pie', qty: 2 }], blockCents: 65 },
    intro:
      "Corpse imps are the raccoons of the afterlife — clever, spiteful, impossible to deter. Gloomhounds are worse: they howl the frequency of a bad memory. Seven imps, five hounds. Tame a gloomhound and nobody will ever sneak up on you, because you'll already be sad.",
    outro:
      "Seven imps, five hounds, one new gloomhound padding at your side like depression you can pet. It howls at approaching enemies and also at sunsets, puppies, and nothing at all. A complicated animal. You'll bond.",
  },
  {
    id: 'q_menagerie_17',
    title: 'Ghost Story',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'ash_spectre', need: 6, label: 'Dispel 6 ash spectres' },
      { kind: 'kill', target: 'wraith_pale', need: 5, label: 'Un-haunt 5 pale wraiths' },
    ],
    rewards: { xp: { magic: 420, attack: 160 }, items: [{ id: 'crystal_cut', qty: 3 }, { id: 'herb_gold', qty: 2 }], blockCents: 90 },
    intro:
      "Spectres and wraiths — the truly fancy dead. Translucent, judgmental, perpetually cold. Six and five. A tamed wraith passes through walls to scout for you, which is handy right up until it passes through a wall and finds something you'd both rather it hadn't. Go gently. Or don't. They're dead already.",
    outro:
      "Six spectres, five wraiths, one now drifting behind you like a regret you can't shake and no longer want to. It scouts. It judges. It makes the room cold and the mood colder. Perfect companion for a long walk home.",
  },
  {
    id: 'q_menagerie_18',
    title: 'The Widow\'s Pet',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'crypt_widow', need: 5, label: 'Out-weave 5 crypt widows' }],
    rewards: { xp: { attack: 400, archery: 200 }, items: [{ id: 'hide_tough', qty: 4 }, { id: 'crystal_shard', qty: 2 }], blockCents: 85 },
    intro:
      "A crypt widow is a spider the size of a coffin, which is convenient, because that's where it files its victims. Five of them. If you can tame one — and most who try become part of the décor — it webs up your enemies for easy harvesting. A real homemaker. A real murderer. Both.",
    outro:
      "Five widows out-woven, one now skittering at your heel and web-wrapping anything that looks at you funny. The silk's quite useful. The eight eyes watching you sleep are quite not. Marriage is compromise.",
  },
  {
    id: 'q_menagerie_19',
    title: 'Knight Terrors',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'barrow_wight', need: 5, label: 'Lay 5 barrow wights to rest' },
      { kind: 'kill', target: 'revenant_rust', need: 4, label: 'Retire 4 rust revenants' },
    ],
    rewards: { xp: { attack: 480, defense: 240 }, items: [{ id: 'bar_steel', qty: 4 }, { id: 'crystal_cut', qty: 2 }], blockCents: 110 },
    intro:
      "Barrow wights and rust revenants: knights too stubborn to accept the memo about being dead. Five and four. Tame one and you've got an undead bodyguard who never sleeps, never eats, and never stops rusting onto your good furniture. Chivalry isn't dead. It's just reanimated.",
    outro:
      "Five wights, four revenants, one new iron guardian clanking faithfully behind you, shedding rust and menace. It bows before battle. It bows after battle. It bows at doorways. A knight's knight, if the knight were a corpse. He is.",
  },
  {
    id: 'q_menagerie_20',
    title: 'Big Boned',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'boneknight_cursed', need: 4, label: 'Unmake 4 cursed boneknights' },
      { kind: 'kill', target: 'tomb_colossus', need: 2, label: 'Topple 2 tomb colossi' },
    ],
    rewards: { xp: { attack: 600, defense: 320 }, items: [{ id: 'bar_gold', qty: 3 }, { id: 'crystal_cut', qty: 4 }], blockCents: 180 },
    intro:
      "The crypt's heavy hitters: cursed boneknights and tomb colossi, the latter being a cathedral that learned to walk and hold a grudge. Four and two. Tame a colossus and you'll have a mount that doubles as a siege weapon and triples as a very large reason the townsfolk have fled. Dream big.",
    outro:
      "Four boneknights unmade, two colossi toppled and one — against all sense — bound to you. You now ride a walking mausoleum into battle. Bridges weep when you cross them. Sol has never been prouder, and he once wept over a nice rock.",
  },
  {
    id: 'q_menagerie_21',
    title: 'Cold Front',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'lich_frost', need: 2, label: 'Shatter 2 frost liches' }],
    rewards: { xp: { magic: 700, attack: 300 }, items: [{ id: 'crystal_cut', qty: 5 }, { id: 'herb_gold', qty: 3 }], blockCents: 220 },
    intro:
      "A frost lich is a wizard who got so petty about dying that it simply declined. Two of them hoard spells in the deep crypt like a dragon hoards gold, except the spells can freeze your blood into a cautionary tale. Unmake them. If the ambient dread seems to 'like' you afterward... don't question a free familiar. Sol never does.",
    outro:
      "Two liches shattered, their lingering chill now curled around you like the world's worst house guest that also casts frost spells on your behalf. It hums ancient curses while you sleep. You'll get used to it. The alternative is admitting you won't.",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // ARC 4 — Prophet Karl's infernal kennel. Hellhounds, fiends, and the
  // general concept of "fire with a personality."
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_menagerie_22',
    title: 'Who Let the Hellhounds Out',
    giver: 'prophet_karl',
    regionId: 'glacier_point',
    steps: [{ kind: 'kill', target: 'hellhound', need: 7, label: 'Heel 7 hellhounds' }],
    rewards: { xp: { attack: 320, magic: 160 }, items: [{ id: 'bar_iron', qty: 3 }, { id: 'food_jerky', qty: 3 }], blockCents: 55 },
    intro:
      "A hellhound is a dog made of regret and open flame. The whale told me seven of them escaped a very warm place and ended up here, confused and extremely on fire. Heel them. A tamed hellhound fetches sticks and also sets them alight. It's a package deal.",
    outro:
      "Seven hellhounds heeled, one now trotting beside you smelling of brimstone and bad decisions. It's housebroken in the sense that it doesn't go indoors — mostly because everything indoors catches fire. Keep a bucket handy. Keep two.",
  },
  {
    id: 'q_menagerie_23',
    title: 'Hot Dog',
    giver: 'prophet_karl',
    regionId: 'glacier_point',
    steps: [
      { kind: 'kill', target: 'cinder_hound', need: 6, label: 'Leash 6 cinder hounds' },
      { kind: 'kill', target: 'ash_imp', need: 8, label: 'Swat 8 ash imps' },
    ],
    rewards: { xp: { attack: 360, magic: 200 }, items: [{ id: 'crystal_raw', qty: 4 }], blockCents: 65 },
    intro:
      "Cinder hounds are hellhounds' smaller, angrier cousins, and ash imps are what settles on everything after the hounds have a disagreement. Six hounds, eight imps. Tame a cinder hound and you'll never need a campfire again. You'll never NOT have a fire again, either. Think it through.",
    outro:
      "Six hounds, eight imps, one cinder hound now glowing faithfully at your side. Your eyebrows are a memory. Your enemies are warmer than they'd like. The whale says you've been 'baptized by fire'. The whale says a lot of things.",
  },
  {
    id: 'q_menagerie_24',
    title: 'Little Devils',
    giver: 'prophet_karl',
    regionId: 'glacier_point',
    steps: [
      { kind: 'kill', target: 'fiendling', need: 7, label: 'Out-scheme 7 fiendlings' },
      { kind: 'kill', target: 'gloom_imp', need: 6, label: 'Dim 6 gloom imps' },
    ],
    rewards: { xp: { magic: 400, attack: 180 }, items: [{ id: 'crystal_shard', qty: 3 }, { id: 'herb_red', qty: 4 }], blockCents: 80 },
    intro:
      "Fiendlings are baby fiends, which means they're only slightly less likely to sell your soul for a snack. Gloom imps just make everyone sad on purpose. Seven and six. Tame a fiendling young and it grows up loyal — ish. Loyalty's a spectrum when the pet is technically a demon.",
    outro:
      "Seven fiendlings out-schemed, one now perched on your shoulder whispering terrible, occasionally useful ideas. It's negotiating your soul down to a reasonable installment plan. The whale endorses this. Everyone, be concerned.",
  },
  {
    id: 'q_menagerie_25',
    title: 'Crawl Space',
    giver: 'prophet_karl',
    regionId: 'glacier_point',
    steps: [
      { kind: 'kill', target: 'soot_crawler', need: 8, label: 'Sweep 8 soot crawlers' },
      { kind: 'kill', target: 'ember_crawler', need: 7, label: 'Stamp 7 ember crawlers' },
    ],
    rewards: { xp: { attack: 380, magic: 180 }, items: [{ id: 'clay_lump', qty: 5 }, { id: 'crystal_raw', qty: 3 }], blockCents: 70 },
    intro:
      "Soot crawlers and ember crawlers infest the warm places — chimneys, forges, the inside of a sleeping whale, apparently, which is a story for never. Eight and seven. A tamed ember crawler keeps your forge lit and your boots smoking. Bargains everywhere, if you squint.",
    outro:
      "Fifteen crawlers dealt with, one ember crawler now riding in your pack and keeping it toasty, occasionally flammable. Your snacks are pre-warmed. Your map is slightly singed. The whale calls it 'cozy'. I call it 'controlled'. Barely.",
  },
  {
    id: 'q_menagerie_26',
    title: 'Blob Life',
    giver: 'prophet_karl',
    regionId: 'glacier_point',
    steps: [
      { kind: 'kill', target: 'magma_blob', need: 6, label: 'Cool 6 magma blobs' },
      { kind: 'kill', target: 'sulfur_sprite', need: 7, label: 'Dispel 7 sulfur sprites' },
    ],
    rewards: { xp: { magic: 440, attack: 160 }, items: [{ id: 'crystal_cut', qty: 2 }, { id: 'ore_gold', qty: 3 }], blockCents: 95 },
    intro:
      "Magma blobs are slimes that fell in a volcano and came out confident. Sulfur sprites are the smell given legs. Six and seven. Tame a magma blob and it'll melt obstacles, locks, and — if you're careless — the floor, your gear, and the concept of a safe home. Six. Please.",
    outro:
      "Six blobs cooled, seven sprites dispelled, one magma blob now oozing loyally at your heel and ruining every surface it touches. It melts through enemy armor beautifully and your inn-room floorboards accidentally. The whale is thrilled. The innkeeper is not.",
  },
  {
    id: 'q_menagerie_27',
    title: 'Brute Force',
    giver: 'prophet_karl',
    regionId: 'glacier_point',
    steps: [
      { kind: 'kill', target: 'pit_brute', need: 5, label: 'Humble 5 pit brutes' },
      { kind: 'kill', target: 'brimstone_fiend', need: 4, label: 'Banish 4 brimstone fiends' },
    ],
    rewards: { xp: { attack: 520, defense: 260 }, items: [{ id: 'bar_gold', qty: 3 }, { id: 'crystal_cut', qty: 3 }], blockCents: 150 },
    intro:
      "Pit brutes are fiends built for one job: hitting. Brimstone fiends are built for two: hitting AND smelling awful about it. Five and four. Tame a pit brute as a mount and you'll ride into battle on a wall of muscle that reeks of sulfur. Nobody will challenge you. Nobody will sit near you either.",
    outro:
      "Five brutes humbled, four fiends banished, one pit brute now lumbering behind you like a loyal landslide. It carries you, your gear, and a permanent cloud of sulfur. You've achieved a kind of terrible majesty. The whale weeps with joy, or that's the fumes.",
  },
  {
    id: 'q_menagerie_28',
    title: 'The Big Burn',
    giver: 'prophet_karl',
    regionId: 'glacier_point',
    steps: [
      { kind: 'kill', target: 'balor_spawn', need: 3, label: 'Unmake 3 balor spawn' },
      { kind: 'kill', target: 'dread_maw', need: 2, label: 'Shut 2 dread maws' },
    ],
    rewards: { xp: { attack: 680, magic: 340 }, items: [{ id: 'bar_gold', qty: 4 }, { id: 'crystal_cut', qty: 5 }], blockCents: 240 },
    intro:
      "Now the apex infernals. Balor spawn — teenage demons with wings and attitude — and dread maws, which are mostly mouth and entirely appetite. Three and two. Tame a balor spawn and you command the most feared pet on the frontier. The whale had one once. The whale regrets nothing and also several things.",
    outro:
      "Three balor spawn unmade, two maws silenced, one balor now soaring above you like a storm cloud that owes you a favor. Villages evacuate at your approach. Birds file complaints. You have, officially, the coolest and least housebroken pet in the realm. Wear it well.",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // ARC 5 — Shard-Warden Igor's clockwork kennel. Constructs aren't "tamed"
  // so much as "convinced not to dismantle you." Semantics.
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_menagerie_29',
    title: 'Good Boy Protocol',
    giver: 'shardwarden_igor',
    regionId: 'prism_break',
    steps: [{ kind: 'kill', target: 'gearhound', need: 8, label: 'Reprogram 8 gearhounds' }],
    rewards: { xp: { attack: 280, defense: 160 }, items: [{ id: 'bar_steel', qty: 3 }, { id: 'crystal_raw', qty: 3 }], blockCents: 55 },
    intro:
      "A gearhound is a clockwork dog that someone wound too tight and gave a hunting instinct. Eight of them have decided the Great Refractor is their yard. Reset them — forcibly, with a hammer, that's a valid reset method — and one may bond to you. It fetches. It never tires. It occasionally needs oiling, which is weirder than it sounds.",
    outro:
      "Eight gearhounds reset, one now clicking contentedly at your heel and fetching anything metal, including things you'd rather it didn't, like keys, coins, and other people's swords. Wind it nightly. Love it clankily. Good boy. Good... machine. Good gearhound.",
  },
  {
    id: 'q_menagerie_30',
    title: 'Crystal Clear',
    giver: 'shardwarden_igor',
    regionId: 'prism_break',
    steps: [
      { kind: 'kill', target: 'shard_crawler', need: 9, label: 'Shatter 9 shard crawlers' },
      { kind: 'gather', target: 'crystal_node', need: 6, label: 'Harvest 6 crystal nodes for cores' },
    ],
    rewards: { xp: { attack: 300, mining: 200 }, items: [{ id: 'crystal_cut', qty: 4 }, { id: 'crystal_shard', qty: 3 }], blockCents: 70 },
    intro:
      "Shard crawlers skitter through the Refractor stealing crystal to grow. Nine of them, plus six fresh nodes to build a proper core for whichever one you want to keep. A tamed shard crawler refracts light into blinding beams, which is handy for fights and for ruining everyone's nap.",
    outro:
      "Nine crawlers shattered, six nodes harvested, one shard crawler now glittering at your side and occasionally setting the dry grass alight with a stray sunbeam. It's beautiful and a liability. Like most things worth keeping.",
  },
  {
    id: 'q_menagerie_31',
    title: 'Sentry Duty',
    giver: 'shardwarden_igor',
    regionId: 'prism_break',
    steps: [
      { kind: 'kill', target: 'crystal_sentinel', need: 5, label: 'Deactivate 5 crystal sentinels' },
      { kind: 'kill', target: 'brass_sentry', need: 6, label: 'Decommission 6 brass sentries' },
    ],
    rewards: { xp: { attack: 360, defense: 220 }, items: [{ id: 'bar_steel', qty: 4 }, { id: 'crystal_cut', qty: 2 }], blockCents: 90 },
    intro:
      "Crystal sentinels and brass sentries were built to guard the Refractor and have taken that mandate to an unhealthy place — namely, guarding it from ME, the warden. Five and six. Deactivate them, keep one, and you've got a tireless guard that also won't let YOU into your own tent. We're troubleshooting that part.",
    outro:
      "Five sentinels, six sentries, one now standing eternal watch beside you and challenging everyone, including you, every single morning. 'Halt, who goes there' — it's you, it's always you — but your camp has never been safer. Or more annoying. Both.",
  },
  {
    id: 'q_menagerie_32',
    title: 'Reflecting Poorly',
    giver: 'shardwarden_igor',
    regionId: 'prism_break',
    steps: [
      { kind: 'kill', target: 'mirror_golem', need: 5, label: 'Crack 5 mirror golems' },
      { kind: 'kill', target: 'cog_sprite', need: 8, label: 'Wind down 8 cog sprites' },
    ],
    rewards: { xp: { magic: 400, attack: 180 }, items: [{ id: 'crystal_cut', qty: 3 }, { id: 'bar_gold', qty: 2 }], blockCents: 100 },
    intro:
      "A mirror golem copies whatever hits it, which makes fighting one a tour of your own worst habits. Cog sprites are the gremlins that keep them wound. Five and eight. Tame a mirror golem and it mimics your attacks back at your enemies, doubling you, which the world is NOT ready for. Neither am I. Do it anyway.",
    outro:
      "Five mirror golems cracked, eight cog sprites wound down, one golem now shadowing you and copying your every move with a half-second delay, like a reflection with commitment issues. It fights as you, fights FOR you, and occasionally fights you. We're calling that a feature.",
  },
  {
    id: 'q_menagerie_33',
    title: 'Drone On',
    giver: 'shardwarden_igor',
    regionId: 'prism_break',
    steps: [
      { kind: 'kill', target: 'prism_drone', need: 8, label: 'Ground 8 prism drones' },
      { kind: 'kill', target: 'clockwork_knight', need: 5, label: 'Unwind 5 clockwork knights' },
    ],
    rewards: { xp: { attack: 440, defense: 240 }, items: [{ id: 'bar_gold', qty: 3 }, { id: 'crystal_cut', qty: 3 }], blockCents: 130 },
    intro:
      "Prism drones buzz the Refractor like metal wasps; clockwork knights patrol it like metal bores. Eight and five. Tame a prism drone and it scouts from above, relaying everything it sees — which, given it's a drone, is 'everything, constantly, in excruciating detail'. Privacy is dead. But so are your blind spots.",
    outro:
      "Eight drones grounded, five knights unwound, one prism drone now orbiting your head and narrating the horizon in little chirps. You know everything happening within a mile. You also can never be alone again. The warden's trade-off. You chose it. Live with the buzzing.",
  },
  {
    id: 'q_menagerie_34',
    title: 'Heavy Machinery',
    giver: 'shardwarden_igor',
    regionId: 'prism_break',
    steps: [
      { kind: 'kill', target: 'iron_warden', need: 4, label: 'Dismantle 4 iron wardens' },
      { kind: 'kill', target: 'siege_golem', need: 3, label: 'Topple 3 siege golems' },
    ],
    rewards: { xp: { attack: 560, defense: 320 }, items: [{ id: 'bar_gold', qty: 4 }, { id: 'crystal_cut', qty: 4 }], blockCents: 180 },
    intro:
      "Iron wardens and siege golems are the Refractor's heavy infantry — walking fortifications with opinions about trespassers. Four and three. Tame a siege golem and you've got a mount that knocks down walls as a greeting. Doorways are a thing of your past. So are subtle entrances.",
    outro:
      "Four wardens dismantled, three siege golems toppled, one now striding behind you and reducing obstacles — walls, gates, the occasional inn — to rubble on sight. You no longer use doors. Doors are beneath you now. Literally; you walk over where they were.",
  },
  {
    id: 'q_menagerie_35',
    title: 'The Unstoppable Collection',
    giver: 'shardwarden_igor',
    regionId: 'prism_break',
    steps: [
      { kind: 'kill', target: 'rune_colossus', need: 3, label: 'Silence 3 rune colossi' },
      { kind: 'kill', target: 'obsidian_automaton', need: 2, label: 'Shut down 2 obsidian automatons' },
    ],
    rewards: { xp: { attack: 700, defense: 400 }, items: [{ id: 'bar_gold', qty: 5 }, { id: 'crystal_cut', qty: 6 }], blockCents: 280 },
    intro:
      "The crown jewels of the kennel: rune colossi humming with bound spellwork, and obsidian automatons carved from volcanic glass and spite. Three and two. Tame these and you command the apex of construct-kind — tireless, fearless, and heavier than most buildings. The Refractor's finest, if you survive the reformatting.",
    outro:
      "Three colossi silenced, two automatons shut down, one now looming behind you like a mountain that decided to help. It never tires. It never questions. It never fits through a gate — but gates don't survive the attempt, so it evens out. Magnificent. Terrifying. Yours.",
  },
  {
    id: 'q_menagerie_36',
    title: 'Last Line of Defense',
    giver: 'shardwarden_igor',
    regionId: 'prism_break',
    steps: [
      { kind: 'kill', target: 'bastion_walker', need: 2, label: 'Ground 2 bastion walkers' },
      { kind: 'kill', target: 'glacier_warden', need: 2, label: 'Melt 2 glacier wardens' },
      { kind: 'kill', target: 'aegis_titan', need: 1, label: 'Humble 1 aegis titan' },
    ],
    rewards: { xp: { attack: 820, defense: 500 }, items: [{ id: 'bar_gold', qty: 6 }, { id: 'crystal_cut', qty: 8 }], blockCents: 360 },
    intro:
      "The final exam of construct-taming. Bastion walkers, glacier wardens, and one aegis titan — the single largest thing the ancients ever built and then, wisely, abandoned. Two, two, and one. Bind the titan and no army on the frontier will march against you. They'll march the other way. Fast.",
    outro:
      "Two walkers, two wardens, one aegis titan — all bowed to you. The titan now stands at your back like a moving fortress, and armies redraw their entire campaign to avoid your postcode. You've out-collected every tamer alive. Igor's retiring. You broke the kennel. Well done, horribly.",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // ARC 6 — Farmer Bram's bug bounty. Insects are small, numerous, and
  // disgusting, which makes them perfect starter pets and terrible houseguests.
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_menagerie_37',
    title: 'Dung and Dusted',
    giver: 'farmer_bram',
    regionId: 'beginnings',
    steps: [
      { kind: 'kill', target: 'beetle_dung', need: 9, label: 'Roll out 9 dung beetles' },
      { kind: 'gather', target: 'farm_plot', need: 5, label: 'Clean up 5 farm plots' },
    ],
    rewards: { xp: { attack: 120, farming: 120 }, items: [{ id: 'wheat', qty: 6 }], blockCents: 25 },
    intro:
      "Dung beetles. In my FIELD. Rolling their little... projects... right across my prize turnips. Nine of them, out. Tame one and it'll tirelessly tidy your campsite, in the sense that it eats the parts you'd rather not discuss. A gross little miracle. Starter pet. Go.",
    outro:
      "Nine beetles rolled off, five plots cleaned, one dung beetle now trundling after you doing the jobs nobody volunteers for. It's useful, loyal, and must NEVER be allowed near the dinner table. A fine first pet. Wash your hands. Wash them again.",
  },
  {
    id: 'q_menagerie_38',
    title: 'Rhino Mode',
    giver: 'farmer_bram',
    regionId: 'beginnings',
    steps: [{ kind: 'kill', target: 'beetle_rhino', need: 8, label: 'Flip 8 rhino beetles' }],
    rewards: { xp: { attack: 160, defense: 80 }, items: [{ id: 'hide_tough', qty: 3 }], blockCents: 30 },
    intro:
      "Rhino beetles are dung beetles that hit the gym and got a complex. They can lift fifty times their weight, which they demonstrate by lifting my fence. Eight of them, flipped. Tame one and it hauls cargo like a tiny ox with a horn and an attitude. Beetle of burden.",
    outro:
      "Eight beetles flipped, one now hauling your overflow loot like it's personally insulted by the concept of a weight limit. It can carry a full suit of armor. It cannot carry a conversation. You'll manage.",
  },
  {
    id: 'q_menagerie_39',
    title: 'Praying for It',
    giver: 'farmer_bram',
    regionId: 'beginnings',
    steps: [
      { kind: 'kill', target: 'mantis_prayer', need: 7, label: 'Interrupt 7 praying mantises' },
      { kind: 'kill', target: 'mantis_blade', need: 6, label: 'Disarm 6 blade mantises' },
    ],
    rewards: { xp: { attack: 240, archery: 120 }, items: [{ id: 'herb_green', qty: 5 }, { id: 'food_pie', qty: 2 }], blockCents: 45 },
    intro:
      "Praying mantises look pious right up until they fold you in half with arms like scythes. Blade mantises skip the praying. Seven and six. Tame a blade mantis and it duels your enemies with natural swords, which is incredible until it decides your haircut needs 'adjusting'. Precision is a lifestyle for these things.",
    outro:
      "Seven mantises interrupted, six disarmed, one blade mantis now perched on your pack and grooming its lethal forearms. It fences beautifully. It judges your posture. It has opinions about your sword work and expresses them with live demonstrations. Educational. Painful.",
  },
  {
    id: 'q_menagerie_40',
    title: 'Sting Operation',
    giver: 'farmer_bram',
    regionId: 'beginnings',
    steps: [
      { kind: 'kill', target: 'scorpion_sand', need: 8, label: 'De-sting 8 sand scorpions' },
      { kind: 'kill', target: 'wasp_paper', need: 7, label: 'Smoke out 7 paper wasps' },
    ],
    rewards: { xp: { attack: 280, archery: 140 }, items: [{ id: 'herb_red', qty: 4 }, { id: 'food_honey', qty: 3 }], blockCents: 55 },
    intro:
      "Sand scorpions and paper wasps: nature's way of saying 'the ground AND the sky want you dead'. Eight and seven. Tame a sand scorpion and it tucks into your boot as a venomous, extremely ill-advised surprise for anyone who steals your boots. Pet AND security system. Terrible. Perfect.",
    outro:
      "Eight scorpions de-stung, seven wasps smoked, one sand scorpion now lurking in your pack and envenoming anything that reaches in uninvited, including, twice, you. It's loyal. It's lethal. It's learning the difference between 'thief' and 'owner'. Slowly. Keep a spare antivenom.",
  },
  {
    id: 'q_menagerie_41',
    title: 'The Bigger They Buzz',
    giver: 'farmer_bram',
    regionId: 'beginnings',
    steps: [
      { kind: 'kill', target: 'wasp_hornet', need: 6, label: 'Ground 6 giant hornets' },
      { kind: 'kill', target: 'locust_swarm', need: 9, label: 'Scatter 9 locust swarms' },
    ],
    rewards: { xp: { attack: 320, farming: 160 }, items: [{ id: 'wheat', qty: 8 }, { id: 'food_honey', qty: 2 }], blockCents: 70 },
    intro:
      "Giant hornets and locust swarms — the twin horsemen of 'there goes the harvest'. Six hornets, nine swarms. Tame a hornet as a flying mount and you'll be the only farmer in history to commute by angry insect. The neighbors will talk. The neighbors always talk. Give them something worth it.",
    outro:
      "Six hornets grounded, nine swarms scattered, one giant hornet now big enough to ride and petty enough to enjoy it. You commute by wasp. Children point. Dogs flee. Your harvest is safe and your reputation is extremely specific. Worth every sting.",
  },
  {
    id: 'q_menagerie_42',
    title: 'Leggy Companions',
    giver: 'farmer_bram',
    regionId: 'beginnings',
    steps: [
      { kind: 'kill', target: 'centipede_bog', need: 7, label: 'Segment 7 bog centipedes' },
      { kind: 'kill', target: 'tick_bloated', need: 8, label: 'Pop 8 bloated ticks' },
    ],
    rewards: { xp: { attack: 300, herbalism: 140 }, items: [{ id: 'herb_blue', qty: 4 }, { id: 'mushroom_brown', qty: 5 }], blockCents: 60 },
    intro:
      "Bog centipedes have too many legs and bloated ticks have too much of everything else. Seven and eight. A tamed centipede makes a surprisingly good... look, it's long and it's fast and it carries messages across the field without stopping to chat. Postal worker. With fangs. Seven, plus pop those ticks before they pop first.",
    outro:
      "Seven centipedes segmented, eight ticks popped — ventilated — whatever, dealt with. One bog centipede now races your errands across the frontier, undulating horribly and reliably. It's the fastest, worst-looking courier in the realm. You'll never shake its hand. It doesn't have hands. Small mercies.",
  },
  {
    id: 'q_menagerie_43',
    title: 'The Underground Collection',
    giver: 'farmer_bram',
    regionId: 'beginnings',
    steps: [
      { kind: 'kill', target: 'spider_funnel', need: 6, label: 'Collapse 6 funnel spiders' },
      { kind: 'kill', target: 'spider_recluse', need: 5, label: 'Evict 5 recluse spiders' },
      { kind: 'kill', target: 'ant_soldier', need: 8, label: 'Out-rank 8 soldier ants' },
    ],
    rewards: { xp: { attack: 400, archery: 200, defense: 160 }, items: [{ id: 'hide_tough', qty: 4 }, { id: 'crystal_shard', qty: 2 }], blockCents: 110 },
    intro:
      "Final bug bounty: funnel spiders, recluse spiders, and a whole regiment of soldier ants that have, I swear, started doing DRILLS in my carrot bed. Six, five, eight. Tame a soldier ant and a hundred of its friends come as a package — an entire tiny army that answers to you. Terrifying value. Go recruit.",
    outro:
      "Six funnels collapsed, five recluses evicted, eight soldier ants out-ranked and the rest now saluting you as their general. You command an ant legion. It's microscopic and unstoppable and marches through enemy camps like a biblical footnote. You're a warlord now. Of ants. Own it.",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // ARC 7 — Honest Jim & Maestro Ribbert's aquatic emporium. Sea pets.
  // Everything here is wet, grumpy, and overpriced.
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_menagerie_44',
    title: 'Crab Mentality',
    giver: 'honest_jim',
    regionId: 'mirage_mile',
    steps: [
      { kind: 'kill', target: 'reefcrab', need: 8, label: 'Out-pinch 8 reefcrabs' },
      { kind: 'gather', target: 'fishing_spot', need: 5, label: 'Fish 5 times for bait' },
    ],
    rewards: { xp: { attack: 160, fishing: 120 }, items: [{ id: 'fish_salmon', qty: 4 }], blockCents: 30 },
    intro:
      "Friend! Partner! Reefcrabs have overrun the tide pools and they PINCH, which is bad for my 'authentic seaside experience' business. Out-pinch eight. Tame one and it rides on your shoulder, snipping threats and thread and, regrettably, your earlobes. A bargain! Everything here is a bargain! Don't check the prices.",
    outro:
      "Eight crabs out-pinched, one now perched on your shoulder snapping at anything within reach, which is a radius you'll learn to respect. It's a loyal little menace. Also I may have sold you the bait at a markup. Friends! No refunds! Enjoy the crab!",
  },
  {
    id: 'q_menagerie_45',
    title: 'Hop to It',
    giver: 'honest_jim',
    regionId: 'mirage_mile',
    steps: [
      { kind: 'kill', target: 'tidehopper', need: 9, label: 'Out-hop 9 tidehoppers' },
      { kind: 'kill', target: 'mudskip', need: 7, label: 'Round up 7 mudskips' },
    ],
    rewards: { xp: { attack: 200, fishing: 160 }, items: [{ id: 'fish_salmon', qty: 3 }, { id: 'fish_trout', qty: 4 }], blockCents: 40 },
    intro:
      "Tidehoppers and mudskips: fish that got AMBITIOUS and learned to leave the water, which is frankly against the natural order and bad for morale. Nine and seven. Tame a mudskip and it flops alongside you on land, which is slow, sad, and strangely endearing. Like a dog that's also a disappointment. A STEAL at these prices!",
    outro:
      "Nine tidehoppers, seven mudskips, one now flopping gamely behind you across dry land at the speed of regret. It's devoted. It's amphibious. It needs to be carried near rivers, which it will not shut up about. A high-maintenance bargain. All my bargains are. Cheers, pal!",
  },
  {
    id: 'q_menagerie_46',
    title: 'Leech Field Trip',
    giver: 'maestro_ribbert',
    regionId: 'drizzlemire',
    steps: [
      { kind: 'kill', target: 'bogleech', need: 8, label: 'Un-stick 8 bogleeches' },
      { kind: 'kill', target: 'brinebat', need: 7, label: 'Ground 7 brinebats' },
    ],
    rewards: { xp: { attack: 240, herbalism: 140 }, items: [{ id: 'herb_green', qty: 5 }, { id: 'mushroom_brown', qty: 4 }], blockCents: 50 },
    intro:
      "*ribbit* The Frog Choir's rehearsal keeps getting interrupted — bogleeches clinging to the altos and brinebats dive-bombing the sopranos. Eight and seven, *ribbit*, if you please. A tamed bogleech draws poison from wounds, which is medically useful and socially isolating. The choir thanks you. The choir is also several frogs. Priorities!",
    outro:
      "Eight leeches un-stuck, seven bats grounded, one bogleech now riding your arm and sucking venom from your wounds, which is genuinely helpful and genuinely revolting. *ribbit* The choir resumes. You have a medicinal parasite. Everyone wins, some of us wetly.",
  },
  {
    id: 'q_menagerie_47',
    title: 'Puff Piece',
    giver: 'honest_jim',
    regionId: 'mirage_mile',
    steps: [
      { kind: 'kill', target: 'pufferpup', need: 8, label: 'Deflate 8 pufferpups' },
      { kind: 'kill', target: 'sandwraith', need: 6, label: 'Disperse 6 sandwraiths' },
    ],
    rewards: { xp: { attack: 280, fishing: 180 }, items: [{ id: 'fish_salmon', qty: 5 }, { id: 'crystal_shard', qty: 2 }], blockCents: 65 },
    intro:
      "A pufferpup is adorable until threatened, at which point it inflates into a spiky balloon of betrayal. Sandwraiths are the desert's version of 'nope'. Eight and six. Tame a pufferpup and it's the cutest pet you'll own, right up until it puffs up in your pack and pops your water skins. Cuteness has a cost. Everything has a cost. ESPECIALLY here!",
    outro:
      "Eight pufferpups deflated, six sandwraiths dispersed, one pufferpup now bobbing after you being devastatingly cute and occasionally, explosively prickly. It's a beloved hazard. It's a spiked friend. It's the best worst purchase you've made all week, and you've been shopping with ME.",
  },
  {
    id: 'q_menagerie_48',
    title: 'Deep Cuts',
    giver: 'maestro_ribbert',
    regionId: 'drizzlemire',
    steps: [
      { kind: 'kill', target: 'anglerfiend', need: 5, label: 'Lights-out 5 anglerfiends' },
      { kind: 'kill', target: 'frostfin', need: 7, label: 'Thaw 7 frostfins' },
    ],
    rewards: { xp: { attack: 340, fishing: 200 }, items: [{ id: 'fish_salmon', qty: 5 }, { id: 'crystal_cut', qty: 2 }], blockCents: 90 },
    intro:
      "*ribbit* From the deep places: anglerfiends with their little lure-lights and bear-trap faces, and frostfins that freeze the water around them out of spite. Five and seven. Tame an anglerfiend and its glowing lure guides you through dark water — toward the exit, usually, sometimes toward dinner. Its dinner. Which might be you. *ribbit* Worth it!",
    outro:
      "Five anglerfiends dimmed, seven frostfins thawed, one anglerfiend now paddling ahead of you, its eerie lure lighting the way and its enormous mouth promising nothing good. You have a living lantern with teeth. The choir finds it 'atmospheric'. You find it 'watching you'. Both true.",
  },
  {
    id: 'q_menagerie_49',
    title: 'The Drowned and the Damp',
    giver: 'maestro_ribbert',
    regionId: 'drizzlemire',
    steps: [
      { kind: 'kill', target: 'drownedman', need: 6, label: 'Re-sink 6 drowned men' },
      { kind: 'kill', target: 'coralgolem', need: 4, label: 'Crumble 4 coral golems' },
    ],
    rewards: { xp: { attack: 440, defense: 240 }, items: [{ id: 'crystal_cut', qty: 3 }, { id: 'bar_steel', qty: 3 }], blockCents: 130 },
    intro:
      "*ribbit* The waterlogged undead and the reef-born golems — drowned men who forgot to stay down and coral golems who grew where no golem should. Six and four. Tame a coral golem and you've a bodyguard that regenerates in water and smells permanently of low tide. The choir won't let it in the front row. Can't imagine why. *ribbit*",
    outro:
      "Six drowned re-sunk, four coral golems crumbled, one now lumbering behind you, dripping and barnacled and loyal. It mends itself in any puddle and leaves a trail of seawater and small crabs everywhere it goes. The choir's banned it from the risers. You've gained a damp, devoted mountain. *ribbit* Mostly a win.",
  },
  {
    id: 'q_menagerie_50',
    title: 'Release the Kraken (Politely)',
    giver: 'maestro_ribbert',
    regionId: 'drizzlemire',
    steps: [
      { kind: 'kill', target: 'krakenling', need: 5, label: 'Untangle 5 krakenlings' },
      { kind: 'kill', target: 'seaserpent', need: 4, label: 'Uncoil 4 sea serpents' },
      { kind: 'kill', target: 'tidewraith', need: 3, label: 'Becalm 3 tidewraiths' },
    ],
    rewards: { xp: { attack: 640, magic: 320 }, items: [{ id: 'crystal_cut', qty: 5 }, { id: 'bar_gold', qty: 3 }], blockCents: 240 },
    intro:
      "*ribbit!* The deep's royalty: krakenlings, sea serpents, and the dreaded tidewraiths. Five, four, three. Tame a krakenling while it's young and it grows into a mount that can cross any water and strangle any problem. The Frog Choir has composed a whole oratorio about this quest. It's four hours long. It's all 'ribbit'. Please succeed before the premiere. *ribbit*",
    outro:
      "Five krakenlings untangled, four serpents uncoiled, three tidewraiths becalmed, one krakenling now riding in a very large bucket and growing fast. Soon you'll cross oceans on its back. The oratorio has its finale. It is, somehow, MORE 'ribbit'. You have a baby sea monster. The choir weeps. Loudly. Wetly. *RIBBIT*",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // ARC 8 — Archmage Lyra's elemental & fae studies. You don't tame these.
  // You befriend them, which is harder, because they have feelings and grudges.
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_menagerie_51',
    title: 'Little Spark',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [{ kind: 'kill', target: 'mote_cinder', need: 8, label: 'Befriend 8 cinder motes (firmly)' }],
    rewards: { xp: { magic: 240, attack: 80 }, items: [{ id: 'crystal_raw', qty: 4 }], blockCents: 40 },
    intro:
      "Elementals aren't pets, they're relationships, and the first one is always fire because fire is the toddler of the elements — bright, needy, prone to tantrums. Befriend eight cinder motes. By 'befriend' I mean 'subdue until they respect you', which is also how I made most of my friends. Mind the sparks.",
    outro:
      "Eight cinder motes befriended, one now orbiting your hand like a loyal little sun with abandonment issues. It lights your way, warms your tea, and sulks spectacularly if ignored. Congratulations on your first elemental friendship. It's exactly as exhausting as a human one, and warmer.",
  },
  {
    id: 'q_menagerie_52',
    title: 'Playing With Fire',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'elem_flame', need: 6, label: 'Earn the regard of 6 flame elementals' },
      { kind: 'kill', target: 'elem_magma', need: 4, label: 'Impress 4 magma elementals' },
    ],
    rewards: { xp: { magic: 360, attack: 140 }, items: [{ id: 'crystal_cut', qty: 3 }, { id: 'ore_gold', qty: 2 }], blockCents: 75 },
    intro:
      "Now the grown-ups. Flame elementals have opinions; magma elementals have grudges that cooled into bedrock. Earn the regard of six and impress four. A flame elemental companion will incinerate your enemies and also your paperwork, your tent, and your eyebrows. Fire doesn't do nuance. Befriend it anyway.",
    outro:
      "Six flame elementals won over, four magma elementals impressed, one flame elemental now dancing at your side like a bonfire with boundaries issues. Your enemies burn. Your belongings occasionally burn. The line between friend and arsonist is thin and bright. Welcome to fire friendship.",
  },
  {
    id: 'q_menagerie_53',
    title: 'The Cold Shoulder',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [{ kind: 'kill', target: 'mote_frost', need: 8, label: 'Thaw out 8 frost motes (emotionally)' }],
    rewards: { xp: { magic: 260, defense: 120 }, items: [{ id: 'crystal_raw', qty: 4 }], blockCents: 45 },
    intro:
      "Frost motes are the opposite of fire ones: aloof, quiet, and they give you the cold shoulder literally and figuratively. Befriend eight. It takes patience and a thick coat. A frost mote companion chills your drinks and your enemies' enthusiasm. It also judges you silently, forever. Introverts, basically.",
    outro:
      "Eight frost motes thawed — emotionally; they're still freezing — one now drifting beside you radiating cool disdain and colder air. It never speaks. It preserves your food and your personal space. The quietest friend you'll ever make, and the only one that keeps leftovers fresh. Fair trade.",
  },
  {
    id: 'q_menagerie_54',
    title: 'Ice to Meet You',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'elem_frost', need: 6, label: 'Win over 6 frost elementals' },
      { kind: 'kill', target: 'elem_glacier', need: 4, label: 'Earn 4 glacier elementals\' respect' },
    ],
    rewards: { xp: { magic: 400, defense: 200 }, items: [{ id: 'crystal_cut', qty: 3 }, { id: 'crystal_shard', qty: 3 }], blockCents: 90 },
    intro:
      "Frost elementals are blizzards with manners; glacier elementals are the slow, crushing weight of a bad mood that lasts centuries. Win over six, earn the respect of four. A glacier elemental befriended becomes an unmovable ally — emphasis on UNMOVABLE, so pick a fight somewhere you don't mind it standing forever. They don't relocate. Ever.",
    outro:
      "Six frost elementals won, four glacier elementals respecting you from their geological timescale, one glacier elemental now looming beside you with the patience of an ice age. It'll crush any enemy, eventually, slowly, inevitably. Rushing it is rude. It remembers rudeness for ten thousand years. Be nice.",
  },
  {
    id: 'q_menagerie_55',
    title: 'Static Cling',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'mote_spark', need: 8, label: 'Ground 8 spark motes' },
      { kind: 'kill', target: 'elem_storm', need: 5, label: 'Negotiate with 5 storm elementals' },
    ],
    rewards: { xp: { magic: 440, archery: 180 }, items: [{ id: 'crystal_cut', qty: 4 }], blockCents: 100 },
    intro:
      "Spark motes and storm elementals: the élite of 'befriend at your own risk'. They're fast, loud, and they shock you to say hello. Eight motes, five storms. A storm elemental ally zaps your enemies and, when excited, you, your mount, and anyone standing within a regrettable radius. High energy. Low control. Great at parties, briefly.",
    outro:
      "Eight spark motes grounded, five storm elementals negotiated with, one storm elemental now crackling at your side and greeting everyone with a complimentary jolt. Your hair is permanently on end. Your enemies are permanently alarmed. You are, electrically speaking, the life of every encounter. Mind the puddles.",
  },
  {
    id: 'q_menagerie_56',
    title: 'Gale Force Friendship',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [{ kind: 'kill', target: 'elem_gale', need: 6, label: 'Reason with 6 gale elementals' }],
    rewards: { xp: { magic: 480, archery: 220 }, items: [{ id: 'crystal_cut', qty: 4 }, { id: 'herb_gold', qty: 2 }], blockCents: 120 },
    intro:
      "Gale elementals are the frontier wind given a personality, and the personality is 'can't sit still'. Six of them. Reason with them, if you can reason with something that's halfway across the sky before you finish a sentence. A gale companion speeds your travel and scatters your maps, your hat, and your train of thought. Everything's faster and nothing's organized. Befriend the chaos.",
    outro:
      "Six gale elementals reasoned with, one now swirling around you, hurrying your steps and stealing anything not nailed down. You travel at twice the speed and arrive with half your belongings. It's exhilarating and infuriating, like most friendships worth keeping. Hold onto your hat. You won't.",
  },
  {
    id: 'q_menagerie_57',
    title: 'Between a Rock and a Hard Pace',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'mote_pebble', need: 8, label: 'Settle 8 pebble motes' },
      { kind: 'kill', target: 'elem_stone', need: 5, label: 'Convince 5 stone elementals' },
    ],
    rewards: { xp: { magic: 420, defense: 240 }, items: [{ id: 'crystal_raw', qty: 5 }, { id: 'clay_lump', qty: 4 }], blockCents: 110 },
    intro:
      "Earth elementals are the easiest to befriend and the hardest to excite. Pebble motes and stone elementals: solid, dependable, DULL. Eight and five. A stone elemental companion is an immovable wall of loyalty with the conversational range of, well, a rock. Reliable to a fault. The fault being that it will out-stubborn a mountain. Befriend the boring. The boring saves your life.",
    outro:
      "Eight pebble motes settled, five stone elementals convinced, one now rolling faithfully at your side like a landslide that chose peace. It blocks blows, holds the line, and never, ever rushes. The most dependable friend you'll ever make, and the worst at charades. You'll grow to love the silence. And the shielding.",
  },
  {
    id: 'q_menagerie_58',
    title: 'Crystal Persuasion',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'elem_crystal', need: 5, label: 'Resonate with 5 crystal elementals' },
      { kind: 'gather', target: 'crystal_node', need: 8, label: 'Harvest 8 crystal nodes as offerings' },
    ],
    rewards: { xp: { magic: 560, mining: 260 }, items: [{ id: 'crystal_cut', qty: 5 }, { id: 'crystal_shard', qty: 4 }], blockCents: 160 },
    intro:
      "Crystal elementals are earth elementals that went to finishing school — refined, resonant, and insufferably proud of their facets. Five of them, plus eight nodes as a gift, because crystal elementals, like certain relatives, only visit when you bring something shiny. A crystal companion amplifies your spells and your sense of self-importance. Both, significantly.",
    outro:
      "Five crystal elementals resonating with you, eight nodes gifted, one now chiming at your side and amplifying every spell you cast into something grander and considerably louder. It makes you more powerful and much harder to be around. A true friend tells you that. This one just hums smugly. You'll figure it out.",
  },
  {
    id: 'q_menagerie_59',
    title: 'Staring Into the Void',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'mote_void', need: 6, label: 'Comprehend 6 void motes' },
      { kind: 'kill', target: 'elem_void', need: 3, label: 'Make peace with 3 void elementals' },
    ],
    rewards: { xp: { magic: 760, attack: 300 }, items: [{ id: 'crystal_cut', qty: 6 }, { id: 'herb_gold', qty: 3 }], blockCents: 240 },
    intro:
      "And now the rare one. Void elementals aren't fire or ice or stone — they're the absence where those things would be, and befriending one is less 'taming' and more 'convincing nothingness to like you specifically'. Six motes, three elementals. A void companion devours enemy spells and, if you're careless, enemy people, allies, scenery, and the occasional afternoon. It eats. Direct its appetite. Carefully.",
    outro:
      "Six void motes comprehended — barely — three void elementals at peace with you, one now hovering beside you as a hole in the world that happens to be on your side. It swallows attacks, light, and sound, leaving a quiet so complete it's almost restful. Almost. You've befriended nothing itself. Lyra's taking notes. Lyra's a little scared. Good.",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // ARC 9 — Captain Elara's Royal Beast Program → the Dragon capstone chain.
  // The realm's most dangerous collection. Scales toward the 999 cap.
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_menagerie_60',
    title: 'The Dragon Starter Kit',
    giver: 'captain_elara',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'wyrmling_ember', need: 5, label: 'Hatch-sit 5 ember wyrmlings' },
      { kind: 'kill', target: 'wyrmling_frost', need: 5, label: 'Hatch-sit 5 frost wyrmlings' },
    ],
    rewards: { xp: { attack: 400, magic: 200 }, items: [{ id: 'bar_gold', qty: 3 }, { id: 'crystal_cut', qty: 3 }], blockCents: 140 },
    intro:
      "The Crown has, in its wisdom, decided the realm needs a Royal Dragon Program, and in its cowardice, decided YOU should start it. Wyrmlings — baby dragons — are the size of a large angry cat and twice as flammable. Five ember, five frost. Win them young and they imprint. Lose, and the Program's new slogan is 'well, we tried'. No pressure. Total pressure.",
    outro:
      "Ten wyrmlings wrangled, two imprinted — one ember, one frost — now curled in your pack hissing steam and frost at each other and occasionally at you. You're a dragon-parent now. The Crown is delighted. Your insurance premiums are a historical document. It begins.",
  },
  {
    id: 'q_menagerie_61',
    title: 'Here Be (Small) Dragons',
    giver: 'captain_elara',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'drake_ash', need: 4, label: 'Break 4 ash drakes' },
      { kind: 'kill', target: 'drake_crag', need: 4, label: 'Break 4 crag drakes' },
    ],
    rewards: { xp: { attack: 480, defense: 240 }, items: [{ id: 'bar_gold', qty: 4 }, { id: 'crystal_cut', qty: 4 }], blockCents: 180 },
    intro:
      "Your wyrmlings are growing, which means they need role models, which means drakes — adolescent dragons, all attitude and no altitude yet. Ash drakes and crag drakes, four each. Break them to saddle and you'll have your first rideable dragon-kin. They can't fly far. They can set a barn alight from the ground, so, you know, versatile.",
    outro:
      "Four ash drakes, four crag drakes, broken to saddle and sulking about it. You can RIDE one now, in short, terrifying bursts. The stable master quit. The stable is ash. The Crown calls this 'excellent progress'. You call it 'why is everything always on fire'. Both correct.",
  },
  {
    id: 'q_menagerie_62',
    title: 'Dune and Gloom',
    giver: 'captain_elara',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'drake_dune', need: 4, label: 'Tame 4 dune drakes' },
      { kind: 'kill', target: 'drake_prism', need: 3, label: 'Dazzle 3 prism drakes' },
    ],
    rewards: { xp: { attack: 520, magic: 280 }, items: [{ id: 'bar_gold', qty: 4 }, { id: 'crystal_cut', qty: 5 }], blockCents: 220 },
    intro:
      "Expanding the collection: dune drakes that swim through sand like it owes them money, and prism drakes that refract light into blinding, gorgeous mayhem. Four and three. A prism drake mount makes you impossible to look at directly, which is either a tactical advantage or just your personality finally made visible. Collect them. The Program demands variety.",
    outro:
      "Four dune drakes tamed, three prism drakes dazzled into cooperation. Your menagerie now shimmers and burrows and generally refuses to be ignored. The Crown's dragon-stable is the envy and terror of neighboring kingdoms, who have started building very tall, very fireproof walls. Good. Let them.",
  },
  {
    id: 'q_menagerie_63',
    title: 'Winging It',
    giver: 'captain_elara',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'wyvern_cinder', need: 4, label: 'Ground 4 cinder wyverns' },
      { kind: 'kill', target: 'wyvern_glacier', need: 4, label: 'Ground 4 glacier wyverns' },
    ],
    rewards: { xp: { attack: 600, archery: 300 }, items: [{ id: 'bar_gold', qty: 5 }, { id: 'crystal_cut', qty: 5 }], blockCents: 280 },
    intro:
      "Wyverns: dragons that traded their front legs for the ability to actually FLY, which is the trade you'd make too if you'd ever met a dragon's accountant. Cinder and glacier, four each. Tame one and you get a real flying mount — the kind that lets you leave a bad conversation by simply ascending. Life-changing. Ground the eight first. From the air they're smug.",
    outro:
      "Four cinder wyverns, four glacier wyverns, grounded then saddled. You can FLY now — properly, over the frontier, dropping bad opinions and worse enemies from a great height. The Crown's Program has wings. The neighboring kingdoms have a new word for 'the sky is no longer safe'. The word is your name. Spoken with dread. Lovely.",
  },
  {
    id: 'q_menagerie_64',
    title: 'The Worm Turns',
    giver: 'captain_elara',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'wyrm_magma', need: 3, label: 'Subdue 3 magma wyrms' },
      { kind: 'kill', target: 'wyrm_permafrost', need: 3, label: 'Subdue 3 permafrost wyrms' },
    ],
    rewards: { xp: { attack: 720, defense: 400 }, items: [{ id: 'bar_gold', qty: 6 }, { id: 'crystal_cut', qty: 6 }], blockCents: 340 },
    intro:
      "Wyrms are what drakes become if they live long enough to get serious — legless, colossal, and burrowing through the deep earth like a grudge made geological. Magma and permafrost, three each. Tame a wyrm and you ride the underground itself, erupting beneath your enemies like a very pointed surprise party. Subdue six. Try to keep the capital standing.",
    outro:
      "Three magma wyrms, three permafrost wyrms, subdued and sulking in the deep stables we had to dig specially and may regret. You can travel UNDERGROUND now, surfacing wherever you please, which has ruined ambushes for an entire generation of bandits. The Crown's Program is unstoppable. The ground is no longer anyone's safe place. Yours least of all.",
  },
  {
    id: 'q_menagerie_65',
    title: 'Crystalline and Present Danger',
    giver: 'captain_elara',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'wyrm_crystalline', need: 3, label: 'Shatter-tame 3 crystalline wyrms' },
      { kind: 'kill', target: 'wyrm_bone', need: 3, label: 'Lay 3 bone wyrms to heel' },
    ],
    rewards: { xp: { attack: 820, magic: 460 }, items: [{ id: 'bar_gold', qty: 7 }, { id: 'crystal_cut', qty: 8 }], blockCents: 420 },
    intro:
      "The rare wyrms now: crystalline ones that hoard light in their faceted hides, and bone wyrms — the fossilized dead of ancient dragons, reanimated and extremely bitter about missing the Jurassic. Three each. These are the wyrms other wyrms tell stories about. Tame them and your menagerie crosses from 'impressive' into 'legally classified as a national threat'. Onward, threat.",
    outro:
      "Three crystalline wyrms shattered into submission, three bone wyrms laid to heel. Your collection now includes a dragon made of living crystal and a dragon made of death itself, and they get along better than you'd fear. The Crown's Program is nearly complete. Three kingdoms have sent diplomats. Two sent assassins. All of them failed. The menagerie ate the evidence.",
  },
  {
    id: 'q_menagerie_66',
    title: 'The Apex Collection: Ashfall',
    giver: 'captain_elara',
    regionId: 'capital',
    steps: [{ kind: 'kill', target: 'dragon_ashfall', need: 1, label: 'Bind the Ashfall Dragon' }],
    rewards: { xp: { attack: 999, magic: 600 }, items: [{ id: 'bar_gold', qty: 8 }, { id: 'crystal_cut', qty: 10 }], blockCents: 600 },
    intro:
      "The first true dragon. The Ashfall Dragon blots out the sun and rains cinders on three provinces as a mood. There is no 'taming' here — there is a negotiation, and your opening offer had better be overwhelming. Bind it and you ride the most feared creature in the sky. Fail and you become a cautionary mural. The Crown has, generously, pre-commissioned both the saddle and the mural. Choose which they use.",
    outro:
      "The Ashfall Dragon is YOURS. The sun returns to three provinces, now that the dragon only blots it out when you ask nicely. You ride a living apocalypse and it answers to you, mostly, when it's eaten. The mural's been repurposed into a triumph. Kingdoms don't threaten the realm anymore. They send gifts. Frightened, expensive gifts. Keep the saddle oiled.",
  },
  {
    id: 'q_menagerie_67',
    title: 'The Apex Collection: Rime',
    giver: 'captain_elara',
    regionId: 'capital',
    steps: [{ kind: 'kill', target: 'dragon_rime', need: 1, label: 'Bind the Rime Dragon' }],
    rewards: { xp: { defense: 999, magic: 620 }, items: [{ id: 'bar_gold', qty: 8 }, { id: 'crystal_cut', qty: 10 }], blockCents: 620 },
    intro:
      "The second true dragon. Where Ashfall burns, the Rime Dragon freezes — entire rivers, seasons, armies caught mid-charge and left as a very dramatic ice sculpture. It is ancient, patient, and deeply unimpressed by you specifically. Earn its respect or earn frostbite the size of a province. The saddle's ready. The eulogy's optional. Bring a very warm coat and an even warmer argument.",
    outro:
      "The Rime Dragon has accepted you, in the way a glacier accepts a particularly persistent pebble. You now command winter itself on wings. Enemies freeze mid-sentence. Summer campaigns end the moment you arrive. The realm's borders are safe, cold, and beautifully still. The Crown weeps gratefully into a scarf. You've out-collected history. Two down.",
  },
  {
    id: 'q_menagerie_68',
    title: 'The Apex Collection: Obsidian',
    giver: 'captain_elara',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'dragon_obsidian', need: 1, label: 'Bind the Obsidian Dragon' },
      { kind: 'explore', target: 'forgotten', need: 1, label: 'Fly the frontier on dragonback' },
    ],
    rewards: { xp: { attack: 999, defense: 999, magic: 700 }, items: [{ id: 'bar_gold', qty: 10 }, { id: 'crystal_cut', qty: 12 }], blockCents: 800 },
    intro:
      "The last and worst. The Obsidian Dragon is carved from cooled volcanic glass and older grudges, a creature so powerful that the previous three Royal Beast Programs ended the moment someone merely SUGGESTED trying. You've bound the sky and the frost. Bind the dark glass and your menagerie is complete — the finest collection of creatures ever assembled by one gloriously unhinged tamer. Then fly the frontier and let the whole realm see what you've become.",
    outro:
      "The Obsidian Dragon is bound, and the Royal Beast Program is COMPLETE — fawns to fiends, motes to mounts, wyrmlings to world-enders, all of it YOURS. You flew the frontier on obsidian wings and the entire realm looked up and quietly decided never to cross you. The Crown has run out of medals. Captain Elara, who has never once smiled, smiles. You are the greatest tamer who ever lived, and the single largest fire hazard in recorded history. Both. Forever. Go home. Feed your dragons. You've earned the exhaustion.",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // ARC 10 — Loose ends & side collections across the frontier / outer isles.
  // Petra, Honest Jim, Inspector Flora mop up the stragglers.
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_menagerie_69',
    title: 'Previously, On Dying',
    giver: 'survivor_petra',
    regionId: 'brainfreeze',
    steps: [
      { kind: 'kill', target: 'frost_lynx', need: 6, label: 'Befriend 6 frost lynxes' },
      { kind: 'kill', target: 'cave_bear', need: 3, label: 'Reach terms with 3 cave bears' },
    ],
    rewards: { xp: { attack: 360, vitality: 220 }, items: [{ id: 'hide_tough', qty: 4 }, { id: 'food_jerky', qty: 3 }], blockCents: 90 },
    intro:
      "Welcome to Camp Bad Idea. I named it. I was here first, I died first, I know things. The frost lynxes and cave bears up here are meaner than anywhere else because the cold has given them nothing to do but practice. Befriend six and three. A pet that survives THIS place survives anything. So will you, if you listen to me. The last six who didn't are the camp's new landmarks.",
    outro:
      "Six lynxes, three bears, and you're still breathing, which at Camp Bad Idea makes you the mayor. These frontier-hardened companions won't flinch at anything, because they've seen the cold do worse. Neither will you now. I'd say I'm proud, but pride's for people who haven't frozen to death yet. Welcome to the club. Bring a coat. Bring two.",
  },
  {
    id: 'q_menagerie_70',
    title: 'The Outer Isles Bestiary',
    giver: 'honest_jim',
    regionId: 'mirage_mile',
    steps: [
      { kind: 'kill', target: 'seaserpent', need: 3, label: 'Catalog 3 sea serpents' },
      { kind: 'kill', target: 'brinebat', need: 8, label: 'Catalog 8 brinebats' },
      { kind: 'gather', target: 'fishing_spot', need: 10, label: 'Fish 10 times for specimens' },
    ],
    rewards: { xp: { fishing: 400, attack: 220 }, items: [{ id: 'fish_salmon', qty: 6 }, { id: 'crystal_shard', qty: 3 }], blockCents: 120 },
    intro:
      "Friend! A proposition! The outer isles are crawling — swimming — with beasts nobody's catalogued, and a catalogued beast is a SELLABLE beast, which is my favorite kind. Three sea serpents, eight brinebats, and ten casts for specimens. Help me compile the Outer Isles Bestiary and I'll cut you in on, let's say, a generous fraction of a percentage. It's practically a gift! To me!",
    outro:
      "Three serpents, eight brinebats, ten casts, one Bestiary — bound, illustrated, and priced to move. You've documented the outer isles' worst inhabitants and I've already got three buyers and two lawsuits. Your cut is in fish and shards, as agreed — well, as I decided. Pleasure doing business! The lawsuits are MY problem. Probably. Swim safe!",
  },
  {
    id: 'q_menagerie_71',
    title: 'Dormancy Verification',
    giver: 'inspector_flora',
    regionId: 'simmering_steps',
    steps: [
      { kind: 'kill', target: 'elem_magma', need: 5, label: 'Verify 5 magma elementals are dormant' },
      { kind: 'kill', target: 'mote_cinder', need: 8, label: 'Log 8 cinder motes' },
    ],
    rewards: { xp: { magic: 420, defense: 200 }, items: [{ id: 'ore_gold', qty: 3 }, { id: 'crystal_cut', qty: 3 }], blockCents: 110 },
    intro:
      "Dormancy Inspector Flora, Simmering Steps. My ENTIRE job is certifying that the volcano's elementals are 'dormant', which is bureaucratic for 'not currently erupting'. They keep failing the inspection by moving. Verify five magma elementals are dormant — forcibly, if their definition of 'dormant' differs from the regulation — and log eight cinder motes. Paperwork keeps the whole frontier from exploding. Literally. I have the forms to prove it.",
    outro:
      "Five magma elementals verified dormant — they're very dormant now, you were thorough — eight cinder motes logged in triplicate. The Simmering Steps are officially Not Currently Exploding, and I can file form 7-C with a clear conscience. Do you know how rare a clear conscience is in volcano compliance? Take your gold. You've made a tired civil servant's year.",
  },
  {
    id: 'q_menagerie_72',
    title: 'The Full Set',
    giver: 'captain_elara',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'char_drake', need: 4, label: 'Complete the drake set: 4 char drakes' },
      { kind: 'kill', target: 'elem_void', need: 2, label: 'Add 2 void elementals to the collection' },
      { kind: 'explore', target: 'ashen', need: 1, label: 'Survey the ashen frontier for stragglers' },
    ],
    rewards: { xp: { attack: 820, magic: 500, vitality: 400 }, items: [{ id: 'bar_gold', qty: 6 }, { id: 'crystal_cut', qty: 7 }], blockCents: 400 },
    intro:
      "Completionist's errand, straight from the Crown's accountant, who's noticed the menagerie is 'missing entries' and cannot sleep. Char drakes — the one drake you skipped — and a pair of void elementals to round out the elemental wing. Four, two, plus a survey of the ashen frontier for anything hiding. Fill the gaps. The accountant needs the ledger to balance before his heart does.",
    outro:
      "Four char drakes, two void elementals, one ashen frontier surveyed to its lonely edges. The collection's gaps are filled, the accountant has fainted with relief, and the ledger is, at last, complete — or complete until you find something new, which you will, because you're incapable of walking past a dangerous animal without wanting to keep it. The Crown's menagerie is the stuff of legend. So are the vet bills.",
  },
  {
    id: 'q_menagerie_73',
    title: 'Hoarder\'s Dilemma',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'dire_boar', need: 5, label: 'Thin the boar herd crowding your camp: 5' },
      { kind: 'gather', target: 'oak_tree', need: 8, label: 'Fell 8 oaks for bigger pens' },
      { kind: 'gather', target: 'iron_vein', need: 6, label: 'Mine 6 iron veins for sturdier fencing' },
    ],
    rewards: { xp: { attack: 300, woodcutting: 220, mining: 220 }, items: [{ id: 'wood_ancient', qty: 2 }, { id: 'bar_iron', qty: 4 }], blockCents: 130 },
    intro:
      "Listen. You've collected... a LOT of animals. They're in MY yard now. All of them. The boars are breeding, the hounds are howling, and yesterday a dragon ate my only chair. Thin the boar herd to five, fell oak for bigger pens, mine iron for fences that'll actually HOLD a wyvern. I moved to the edge of the world for SOLITUDE and now I run a zoo. Fix this. I beg you. Hermit-ly.",
    outro:
      "Boars thinned, pens expanded, iron fences up and — crucially — holding. My yard is now an orderly menagerie instead of a chaotic one, which is a downgrade in peace and an upgrade in not-being-eaten. I hate how much I've come to tolerate the dragon. It's warm. I named it. Don't tell anyone. Take the ancient wood. And take some of these animals. PLEASE take some of these animals.",
  },
  {
    id: 'q_menagerie_74',
    title: 'Feeding Time',
    giver: 'farmer_bram',
    regionId: 'beginnings',
    steps: [
      { kind: 'gather', target: 'farm_plot', need: 12, label: 'Harvest 12 farm plots of feed' },
      { kind: 'gather', target: 'berry_bush', need: 10, label: 'Strip 10 berry bushes' },
      { kind: 'collect', target: 'fish_salmon', need: 8, label: 'Net 8 salmon for the carnivores' },
    ],
    rewards: { xp: { farming: 460, fishing: 280 }, items: [{ id: 'wheat', qty: 10 }, { id: 'food_pie', qty: 4 }, { id: 'food_honey', qty: 3 }], blockCents: 150 },
    intro:
      "Nobody tells you the hard part of collecting a hundred dangerous animals: they EAT. Constantly. I've become the realm's largest supplier of 'monster chow' and my fields can't keep up. Harvest twelve plots, strip ten berry bushes, net eight salmon — the fawns want greens, the dragons want... everything, honestly. Feed your zoo before your zoo feeds ON something. Like my LEGS, which it eyed yesterday.",
    outro:
      "Twelve plots, ten bushes, eight salmon — enough chow to keep the menagerie fed and your legs attached for another week. This is your life now: a glorious tamer by day, a very anxious caterer by every other hour. The animals are full. The animals are content. The animals are, briefly, not plotting. Savor it. Here's pie — for YOU, this time. Eat it before something with scales notices.",
  },
  {
    id: 'q_menagerie_75',
    title: 'Grand Menagerie, Grander Headache',
    giver: 'captain_elara',
    regionId: 'capital',
    steps: [
      { kind: 'explore', target: 'greenwood', need: 1, label: 'Parade through Greenwood' },
      { kind: 'explore', target: 'ironhold', need: 1, label: 'Parade through Ironhold' },
      { kind: 'explore', target: 'capital', need: 1, label: 'Parade through the Capital' },
      { kind: 'kill', target: 'dragon_obsidian', need: 1, label: 'Lead the Obsidian Dragon in the grand parade' },
    ],
    rewards: { xp: { attack: 999, defense: 999, magic: 999, vitality: 800 }, items: [{ id: 'bar_gold', qty: 12 }, { id: 'crystal_cut', qty: 15 }, { id: 'food_cake', qty: 5 }], blockCents: 1200 },
    intro:
      "The Crown has decreed a Grand Menagerie Parade — the single most dangerous public event in the realm's history — to show off the collection you've assembled from absolutely nothing but poor judgment and raw nerve. Lead your beasts through Greenwood, Ironhold, and the Capital itself, with the Obsidian Dragon as the finale, and if everyone survives, you'll be the most celebrated tamer who ever drew breath. If they DON'T, well. We'll call it a 'spontaneous festival of running'. No pressure. Historical, world-defining amounts of pressure.",
    outro:
      "You led a parade of apocalypses through three kingdoms and NOBODY DIED — a sentence no herald ever expected to write. The crowds cheered from behind very thick walls. The Obsidian Dragon did a loop. Children will tell their grandchildren they saw the Grand Menagerie and lived. You've gone from 'fresh meat splatting slimes in a meadow' to the greatest, maddest, most beloved beast-tamer the realm will ever know. The Crown is out of honors. Captain Elara salutes you — a FULL salute, which she's done exactly twice, both today. Now go. Rest. Your zoo misses you, and feeding time waits for no legend.",
  },
]

/**
 * Prerequisite chains — every arc reads as a progression, with the dragon
 * capstone gated behind the full apex ladder.
 */
const prereqs: Record<string, readonly string[]> = {
  // Arc 1 — woodland fauna
  q_menagerie_02: ['q_menagerie_01'],
  q_menagerie_03: ['q_menagerie_01'],
  q_menagerie_04: ['q_menagerie_03'],
  q_menagerie_05: ['q_menagerie_04'],
  q_menagerie_06: ['q_menagerie_02', 'q_menagerie_05'],
  q_menagerie_07: ['q_menagerie_06'],
  // Arc 2 — savanna & mountain mounts
  q_menagerie_09: ['q_menagerie_08'],
  q_menagerie_10: ['q_menagerie_09'],
  q_menagerie_11: ['q_menagerie_08'],
  q_menagerie_12: ['q_menagerie_10', 'q_menagerie_11'],
  // Arc 3 — undead menagerie
  q_menagerie_14: ['q_menagerie_13'],
  q_menagerie_15: ['q_menagerie_13'],
  q_menagerie_16: ['q_menagerie_14'],
  q_menagerie_17: ['q_menagerie_16'],
  q_menagerie_18: ['q_menagerie_17'],
  q_menagerie_19: ['q_menagerie_18'],
  q_menagerie_20: ['q_menagerie_19'],
  q_menagerie_21: ['q_menagerie_20'],
  // Arc 4 — infernal kennel
  q_menagerie_23: ['q_menagerie_22'],
  q_menagerie_24: ['q_menagerie_22'],
  q_menagerie_25: ['q_menagerie_23'],
  q_menagerie_26: ['q_menagerie_25'],
  q_menagerie_27: ['q_menagerie_24', 'q_menagerie_26'],
  q_menagerie_28: ['q_menagerie_27'],
  // Arc 5 — clockwork kennel
  q_menagerie_30: ['q_menagerie_29'],
  q_menagerie_31: ['q_menagerie_30'],
  q_menagerie_32: ['q_menagerie_31'],
  q_menagerie_33: ['q_menagerie_32'],
  q_menagerie_34: ['q_menagerie_33'],
  q_menagerie_35: ['q_menagerie_34'],
  q_menagerie_36: ['q_menagerie_35'],
  // Arc 6 — insects
  q_menagerie_38: ['q_menagerie_37'],
  q_menagerie_39: ['q_menagerie_38'],
  q_menagerie_40: ['q_menagerie_39'],
  q_menagerie_41: ['q_menagerie_40'],
  q_menagerie_42: ['q_menagerie_41'],
  q_menagerie_43: ['q_menagerie_42'],
  // Arc 7 — aquatic
  q_menagerie_45: ['q_menagerie_44'],
  q_menagerie_46: ['q_menagerie_44'],
  q_menagerie_47: ['q_menagerie_45'],
  q_menagerie_48: ['q_menagerie_46', 'q_menagerie_47'],
  q_menagerie_49: ['q_menagerie_48'],
  q_menagerie_50: ['q_menagerie_49'],
  // Arc 8 — elementals & fae
  q_menagerie_52: ['q_menagerie_51'],
  q_menagerie_53: ['q_menagerie_51'],
  q_menagerie_54: ['q_menagerie_53'],
  q_menagerie_55: ['q_menagerie_52', 'q_menagerie_54'],
  q_menagerie_56: ['q_menagerie_55'],
  q_menagerie_57: ['q_menagerie_55'],
  q_menagerie_58: ['q_menagerie_57'],
  q_menagerie_59: ['q_menagerie_56', 'q_menagerie_58'],
  // Arc 9 — dragon capstone ladder
  q_menagerie_61: ['q_menagerie_60'],
  q_menagerie_62: ['q_menagerie_61'],
  q_menagerie_63: ['q_menagerie_62'],
  q_menagerie_64: ['q_menagerie_63'],
  q_menagerie_65: ['q_menagerie_64'],
  q_menagerie_66: ['q_menagerie_65'],
  q_menagerie_67: ['q_menagerie_66'],
  q_menagerie_68: ['q_menagerie_67'],
  // Arc 10 — loose ends & the grand finale
  q_menagerie_70: ['q_menagerie_44'],
  q_menagerie_72: ['q_menagerie_62', 'q_menagerie_59'],
  q_menagerie_73: ['q_menagerie_07'],
  q_menagerie_75: ['q_menagerie_68', 'q_menagerie_72'],
}

/**
 * Display names for reward/collect ids that may not carry a catalog name in
 * this module's tiny table. All ids are real catalog items; these just ensure a
 * friendly label instead of the raw id if the consumer looks here.
 */
const itemNames: Record<string, string> = {
  hide_wolf: 'Wolf Hide',
  hide_boar: 'Boar Hide',
  hide_tough: 'Tough Hide',
  bar_iron: 'Iron Bar',
  bar_steel: 'Steel Bar',
  bar_gold: 'Gold Bar',
  ore_gold: 'Gold Ore',
  crystal_raw: 'Raw Crystal',
  crystal_shard: 'Crystal Shard',
  crystal_cut: 'Cut Crystal',
  clay_lump: 'Lump of Clay',
  wood_ancient: 'Ancient Wood',
  wheat: 'Wheat',
  berry_red: 'Red Berries',
  herb_green: 'Green Herb',
  herb_red: 'Red Herb',
  herb_blue: 'Blue Herb',
  herb_gold: 'Gold Herb',
  mushroom_brown: 'Brown Mushroom',
  fish_trout: 'Raw Trout',
  fish_salmon: 'Raw Salmon',
  food_jerky: 'Dried Jerky',
  food_pie: 'Meat Pie',
  food_cake: 'Tiny Expensive Cake',
  food_honey: 'Pot of Honey',
}

registerPack({ quests, prereqs, itemNames })
