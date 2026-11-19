/**
 * questmega_legends — the "go touch level 999" pack.
 *
 * ~75 epic, multi-step legendary questlines and prerequisite chains that
 * march a Blockling from "promising" to "legally a natural disaster". Each
 * arc is a ladder: early rungs are achievable embarrassments, late rungs
 * hand out XP by the cartload to drag the dedicated toward the 999 cap.
 *
 * Every kill target is a real base species or one of the new wildlife/undead/
 * demon/construct/insect/sea/elemental/dragon species ids. Every gather kind
 * is a real node kind, every collect/reward id a real catalog material, food
 * or potion. No armor-piece rewards (those live in other packs) — materials,
 * food, gold (blockCents) and XP only.
 *
 * Side-effect: registers at import time via registerPack({ quests, prereqs,
 * itemNames }). Imported from src/content/index.ts.
 */
import { registerPack } from './packs'
import type { QuestDef } from '../types'

const quests: QuestDef[] = [
  // ══════════════════════════════════════════════════════════════════════
  // ARC A — "The Hundred Beasts": wildlife escalation, Greenwood → Forgotten
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'q_legends_01',
    title: 'The Hundred Beasts: Bambi Has to Go',
    giver: 'scout_wren',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'meadow_fawn', need: 12, label: 'Harden your heart against 12 meadow fawns' }],
    rewards: { xp: { attack: 600 }, items: [{ id: 'hide_wolf', qty: 4 }], blockCents: 50 },
    intro:
      "Every legend starts with a decision you'll lie about later. The meadow fawns are eating the saplings faster than they grow, big eyes, no remorse. Twelve of them. Don't name them. That's the only rule I can give you that'll actually help.",
    outro:
      "Twelve fawns, and you only cried a little. The saplings live. You've learned the first law of heroism: the forest doesn't run on sentiment, it runs on you doing the thing nobody else will.",
  },
  {
    id: 'q_legends_02',
    title: 'The Hundred Beasts: Things With Opinions',
    giver: 'scout_wren',
    regionId: 'greenwood',
    steps: [
      { kind: 'kill', target: 'thicket_lynx', need: 10, label: 'Out-pounce 10 thicket lynxes' },
      { kind: 'kill', target: 'horned_stag', need: 8, label: 'Dethrone 8 horned stags' },
    ],
    rewards: { xp: { attack: 900, defense: 300 }, items: [{ id: 'hide_tough', qty: 5 }], blockCents: 70 },
    intro:
      "The lynxes drop out of trees and the stags charge anything with a pulse, which is a personality trait I can't negotiate with. Ten lynxes, eight stags. Bring back the hides — the hard part of you needs a harder outside.",
    outro:
      "Ten lynxes, eight stags, and you still have the standard number of eyes. The thicket is survivable again. Barely. That's the best this forest offers anyone.",
  },
  {
    id: 'q_legends_03',
    title: 'The Hundred Beasts: Pack Mentality',
    giver: 'ranger_kael',
    regionId: 'greenwood',
    steps: [
      { kind: 'kill', target: 'ridgeback_hound', need: 12, label: 'Scatter 12 ridgeback hounds' },
      { kind: 'kill', target: 'pack_raptor', need: 10, label: 'Thin 10 pack raptors' },
    ],
    rewards: { xp: { attack: 1100, archery: 400 }, items: [{ id: 'hide_boar', qty: 6 }], blockCents: 90 },
    intro:
      "Hounds hunt in twelves, raptors in whatever number makes you regret the open field. They flank. They coordinate. They've got better teamwork than the Capital guard, which is both impressive and depressing. Break their nerve.",
    outro:
      "The packs broke before you did. Word travels through a pack faster than through a tavern — they'll smell you coming now and reconsider their whole afternoon. Good. Fear's cheaper than a second fight.",
  },
  {
    id: 'q_legends_04',
    title: 'The Hundred Beasts: The Big Ugly Ones',
    giver: 'ranger_kael',
    regionId: 'greenwood',
    steps: [
      { kind: 'kill', target: 'dire_boar', need: 10, label: 'Flatten 10 dire boars' },
      { kind: 'kill', target: 'grizzled_bruin', need: 8, label: 'Reason with 8 grizzled bruins (violently)' },
    ],
    rewards: { xp: { attack: 1500, vitality: 600 }, items: [{ id: 'hide_tough', qty: 8 }, { id: 'food_jerky', qty: 4 }], blockCents: 110 },
    intro:
      "Dire boars are tusks with a bad mood attached, and the bruins are what happens when a bear reads a book about anger management and sets it on fire. Ten and eight. If you come back smelling like wet rug, that's just the bruins saying hello.",
    outro:
      "Ten boars, eight bruins, and you walked out under your own power. The deep thicket's apex predators have been demoted to 'cautionary tale'. You're climbing. Keep climbing; the view only gets worse.",
  },
  {
    id: 'q_legends_05',
    title: 'The Hundred Beasts: Apex, Allegedly',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'shadow_panther', need: 9, label: 'See through 9 shadow panthers' },
      { kind: 'kill', target: 'savanna_lion', need: 7, label: 'Unseat 7 savanna lions' },
      { kind: 'kill', target: 'cave_bear', need: 6, label: 'Evict 6 cave bears' },
    ],
    rewards: { xp: { attack: 2400, vitality: 900, defense: 500 }, items: [{ id: 'hide_tough', qty: 10 }, { id: 'food_pie', qty: 3 }], blockCents: 160 },
    intro:
      "Out here the food chain is a suggestion and you're on the menu until proven otherwise. Shadow panthers you'll hear last, lions you'll hear first, cave bears you'll hear through your boots. Prove otherwise. Nine, seven, six. I'll keep the kettle on, pessimistically.",
    outro:
      "Nine panthers, seven lions, six bears. The apex predators of the wastes have filed you under 'do not attempt'. You're not the top of the food chain yet — but you've started eating it from the middle. Rude. Effective.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // ARC B — "The Dead Walk": undead crawl through Ashen, into legend
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'q_legends_06',
    title: 'The Dead Walk: Entry-Level Decomposition',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'ghoul_grave', need: 12, label: 'Re-bury 12 grave ghouls' },
      { kind: 'kill', target: 'gravecrawler', need: 10, label: 'Stomp 10 gravecrawlers' },
    ],
    rewards: { xp: { attack: 1000, magic: 300 }, items: [{ id: 'potion_hp_large', qty: 3 }], blockCents: 80 },
    intro:
      "The cheap seats of the afterlife are acting up again. Ghouls shambling, gravecrawlers doing that thing where they crawl, hence the name, I didn't pick it. Twelve and ten, back underground. Gerald's nerves can't take another noisy week.",
    outro:
      "Twelve ghouls, ten crawlers, all tucked back in. Gerald's stopped twitching. The cheap seats are quiet. Now the EXPENSIVE dead will notice someone's thinning the crowd, and THAT'S when it gets interesting.",
  },
  {
    id: 'q_legends_07',
    title: 'The Dead Walk: Vermin and Vapor',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'plague_rat', need: 15, label: 'Exterminate 15 plague rats' },
      { kind: 'kill', target: 'deathmoth_pale', need: 10, label: 'Swat 10 pale deathmoths' },
      { kind: 'kill', target: 'ash_spectre', need: 8, label: 'Dispel 8 ash spectres' },
    ],
    rewards: { xp: { attack: 1300, magic: 600 }, items: [{ id: 'crystal_shard', qty: 4 }, { id: 'potion_mp_large', qty: 2 }], blockCents: 100 },
    intro:
      "Plague rats carry diseases the plague itself finds distasteful. Deathmoths eat the LIGHT, which is a career choice. And the ash spectres just hang around judging everyone. Fifteen, ten, eight. Hold your breath, it's cheaper than the antidote.",
    outro:
      "Rats gone, moths grounded, spectres dispelled, and you only inhaled a LITTLE death. The crypt air is breathable again, by crypt standards. You're getting a reputation among the deceased. They don't have mouths, but they're talking.",
  },
  {
    id: 'q_legends_08',
    title: 'The Dead Walk: Nobody Likes a Corpse Imp',
    giver: 'prophet_karl',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'corpse_imp', need: 12, label: 'Snuff 12 corpse imps' },
      { kind: 'kill', target: 'gloomhound', need: 10, label: 'Leash 10 gloomhounds (permanently)' },
    ],
    rewards: { xp: { attack: 1600, magic: 800 }, items: [{ id: 'crystal_shard', qty: 5 }, { id: 'food_jelly', qty: 3 }], blockCents: 120 },
    intro:
      "Corpse imps are what you get when an imp dies and comes back WORSE, which I didn't think was geometrically possible. The gloomhounds herd them. It's an ecosystem of spite. Twelve imps, ten hounds. Unmake the ecosystem.",
    outro:
      "The imps are out, the hounds are leashed to oblivion. You've unraveled a little economy of malice down here. The prophets are revising their doom predictions to include 'unless that one shows up', which — flattering, honestly.",
  },
  {
    id: 'q_legends_09',
    title: 'The Dead Walk: The Wraith Problem',
    giver: 'gravekeeper_sol',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'wraith_pale', need: 12, label: 'Banish 12 pale wraiths' },
      { kind: 'kill', target: 'revenant_rust', need: 10, label: 'Re-kill 10 rust revenants' },
      { kind: 'kill', target: 'barrow_wight', need: 8, label: 'Put down 8 barrow wights' },
    ],
    rewards: { xp: { attack: 2200, magic: 1100, defense: 600 }, items: [{ id: 'crystal_cut', qty: 4 }, { id: 'potion_hp_large', qty: 4 }], blockCents: 180 },
    intro:
      "Wraiths don't die, they get DISCOURAGED. Revenants came back with a grudge and a rust problem. Wights guard barrows full of other people's bad decisions. Twelve, ten, eight. You'll feel cold the whole time. That's just them appreciating you.",
    outro:
      "The wraiths are discouraged all the way to gone. The revenants re-rested, the wights un-woken. The barrows are quiet enough to hear your own heartbeat, which down here is a love letter. You're nearly ready for the ones with crowns.",
  },
  {
    id: 'q_legends_10',
    title: 'The Dead Walk: Spiders, But Dead',
    giver: 'prophet_karl',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'crypt_widow', need: 10, label: 'Unweb 10 crypt widows' },
      { kind: 'kill', target: 'ash_imp', need: 12, label: 'Extinguish 12 ash imps' },
    ],
    rewards: { xp: { attack: 1900, archery: 800 }, items: [{ id: 'crystal_cut', qty: 5 }, { id: 'potion_mp_large', qty: 3 }], blockCents: 150 },
    intro:
      "A crypt widow is a spider that died and decided death was no excuse to stop making webs. Ash imps light the webs. It is, I want to stress, the stupidest possible combination of enemies. Ten widows, twelve imps. Bring a torch and a grudge.",
    outro:
      "Ten widows, twelve imps, and the webs are nothing but ash now. The crypt's worst pairing is dissolved. You smell like a bonfire at a funeral, which is EXACTLY the smell of progress down here.",
  },
  {
    id: 'q_legends_11',
    title: 'The Dead Walk: The Cursed Court',
    giver: 'gravekeeper_sol',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'boneknight_cursed', need: 9, label: 'Disassemble 9 cursed boneknights' },
      { kind: 'kill', target: 'lich_frost', need: 5, label: 'Thaw 5 frost liches (the hard way)' },
      { kind: 'kill', target: 'tomb_colossus', need: 2, label: 'Topple 2 tomb colossi' },
    ],
    rewards: { xp: { attack: 4200, magic: 2100, defense: 1500 }, items: [{ id: 'crystal_cut', qty: 8 }, { id: 'bar_steel', qty: 5 }, { id: 'food_cake', qty: 2 }], blockCents: 320 },
    intro:
      "Here's the top of the dead society: cursed boneknights who still salute a king that's twice-dead, frost liches running the place like a bad homeowners' association, and tomb colossi, which are the walls, which also hate you. Nine, five, two. If you win, the whole necropolis votes on whether to wake up anymore. They'll vote no.",
    outro:
      "The court is unmade. The boneknights saluted no one. The liches cooled permanently. The colossi are just architecture again. You dismantled the entire bureaucracy of death down here — and the dead, for once, are grateful enough to stay that way.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // ARC C — "Fires of the Pit": demons & fire, Ashen depths
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'q_legends_12',
    title: 'Fires of the Pit: Hot and Getting Hotter',
    giver: 'prophet_karl',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'hellhound', need: 12, label: 'Put out 12 hellhounds' },
      { kind: 'kill', target: 'cinder_hound', need: 10, label: 'Douse 10 cinder hounds' },
    ],
    rewards: { xp: { attack: 1200, magic: 500 }, items: [{ id: 'bar_iron', qty: 6 }], blockCents: 90 },
    intro:
      "Something cracked open the lower vents and now there are DOGS made of FIRE. Hellhounds and cinder hounds, which differ in ways only a very brave fool measures up close. Twelve and ten. They shed embers. Bring a hat you don't like.",
    outro:
      "Twelve hellhounds, ten cinder hounds, all reduced to a sad little smoke. The vents are quieter. You're singed in a dignified, experienced way now. The pit noticed. The pit is sending something bigger.",
  },
  {
    id: 'q_legends_13',
    title: 'Fires of the Pit: Small Fry, Literally',
    giver: 'prophet_karl',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'fiendling', need: 15, label: 'Stamp out 15 fiendlings' },
      { kind: 'kill', target: 'soot_crawler', need: 12, label: 'Crush 12 soot crawlers' },
      { kind: 'kill', target: 'sulfur_sprite', need: 10, label: 'Pop 10 sulfur sprites' },
    ],
    rewards: { xp: { attack: 1500, magic: 700 }, items: [{ id: 'crystal_raw', qty: 6 }, { id: 'potion_hp_large', qty: 2 }], blockCents: 110 },
    intro:
      "Before the big demons come the LITTLE demons, and there are always more little ones, like a tavern's mice but on fire and theologically concerning. Fiendlings, soot crawlers, sulfur sprites. Fifteen, twelve, ten. The smell alone is a crime.",
    outro:
      "The small fry are fried. Fifteen fiendlings, twelve crawlers, ten sprites. You smell like a struck match in a tannery, and the lower vents are measurably less infested. The big ones can't hide behind the little ones anymore.",
  },
  {
    id: 'q_legends_14',
    title: 'Fires of the Pit: Blobs and Bruisers',
    giver: 'prophet_karl',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'magma_blob', need: 12, label: 'Cool 12 magma blobs' },
      { kind: 'kill', target: 'ember_crawler', need: 10, label: 'Snuff 10 ember crawlers' },
      { kind: 'kill', target: 'gloom_imp', need: 10, label: 'Dim 10 gloom imps' },
    ],
    rewards: { xp: { attack: 1800, defense: 700 }, items: [{ id: 'crystal_raw', qty: 8 }, { id: 'food_honey', qty: 3 }], blockCents: 130 },
    intro:
      "Magma blobs split when you hit them, which is nature's way of saying 'hit them harder, once'. Ember crawlers climb walls, gloom imps put out torches to watch you panic. Twelve, ten, ten. Stay calm, stay lit, stay alive, roughly in that order.",
    outro:
      "No more splitting blobs, no more wall-crawling embers, no more torch-thieving imps. The lower galleries are hot but HONEST now. You've beaten the pit's middle management. The executives are next, and they have horns.",
  },
  {
    id: 'q_legends_15',
    title: 'Fires of the Pit: The Horned Agenda',
    giver: 'prophet_karl',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'pit_brute', need: 9, label: 'Humble 9 pit brutes' },
      { kind: 'kill', target: 'brimstone_fiend', need: 7, label: 'Extinguish 7 brimstone fiends' },
    ],
    rewards: { xp: { attack: 2600, magic: 1200 }, items: [{ id: 'crystal_cut', qty: 6 }, { id: 'bar_steel', qty: 4 }], blockCents: 200 },
    intro:
      "Pit brutes are the muscle, brimstone fiends are the ones who THINK, which makes them worse. They have an agenda. I've seen the agenda. It's mostly 'burn everything', but it's TYPED UP, which is terrifying. Nine brutes, seven fiends. Edit their plans permanently.",
    outro:
      "The brutes are humbled, the fiends' agenda is ash. You've put the pit's leadership behind schedule by what I'd generously call 'forever'. There's one thing left down there now, and it's the thing even the fiends were scared of.",
  },
  {
    id: 'q_legends_16',
    title: 'Fires of the Pit: What the Fiends Feared',
    giver: 'prophet_karl',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'balor_spawn', need: 6, label: 'Cut down 6 balor spawn' },
      { kind: 'kill', target: 'dread_maw', need: 4, label: 'Shut 4 dread maws' },
      { kind: 'kill', target: 'char_drake', need: 3, label: 'Ground 3 char drakes' },
    ],
    rewards: { xp: { attack: 5200, magic: 2600, vitality: 1800 }, items: [{ id: 'crystal_cut', qty: 10 }, { id: 'bar_gold', qty: 4 }, { id: 'food_cake', qty: 3 }], blockCents: 400 },
    intro:
      "Balor spawn are the children of something that never had children by any definition we'd like. Dread maws are mouths with ambition. And char drakes are the first dragons you'll meet that consider YOU the snack. Six, four, three. If you survive, the pit goes cold, and the whole realm owes you a drink it won't buy.",
    outro:
      "The balor spawn fell, the dread maws closed forever, the char drakes grounded for good. The pit is COLD. You walked into the thing demons tell their larvae about and walked out. The realm doesn't know how close it came. You do. Carry it well.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // ARC D — "The Clockwork War": constructs, Ironhold → capital labs
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'q_legends_17',
    title: 'The Clockwork War: Tin Soldiers',
    giver: 'foreman_dagna',
    regionId: 'ironhold',
    steps: [
      { kind: 'kill', target: 'cog_sprite', need: 15, label: 'Unwind 15 cog sprites' },
      { kind: 'kill', target: 'gearhound', need: 12, label: 'Scrap 12 gearhounds' },
    ],
    rewards: { xp: { attack: 1100, defense: 500 }, items: [{ id: 'bar_iron', qty: 6 }, { id: 'ore_iron', qty: 8 }], blockCents: 90 },
    intro:
      "Some genius in the Capital built a self-repairing mine crew and then the mine crew decided it didn't want a boss. Now the deep shafts are full of cog sprites and gearhounds that bite with actual GEARS. Fifteen and twelve. Bring them back as parts.",
    outro:
      "Fifteen sprites unwound, twelve gearhounds scrapped. The deep shafts are mine again — MY mine, with MY crew, who are flesh and complain normally. The scrap's good iron. But the big ones are still ticking somewhere below.",
  },
  {
    id: 'q_legends_18',
    title: 'The Clockwork War: Watchmen',
    giver: 'foreman_dagna',
    regionId: 'ironhold',
    steps: [
      { kind: 'kill', target: 'brass_sentry', need: 12, label: 'Decommission 12 brass sentries' },
      { kind: 'kill', target: 'shard_crawler', need: 12, label: 'Shatter 12 shard crawlers' },
      { kind: 'kill', target: 'prism_drone', need: 10, label: 'Blind 10 prism drones' },
    ],
    rewards: { xp: { attack: 1600, defense: 800, mining: 400 }, items: [{ id: 'bar_steel', qty: 5 }, { id: 'crystal_raw', qty: 6 }], blockCents: 130 },
    intro:
      "The sentries guard a door nobody told me about. The shard crawlers mine the crystals that POWER the sentries, and the prism drones aim the light that makes the whole mess work. Twelve, twelve, ten. Break the supply chain and the whole clockwork army gets a bad day.",
    outro:
      "Sentries down, crawlers shattered, drones blinded. You've cut the clockwork army's legs out from under it — figuratively, they have treads. Whatever's behind that guarded door is about to get a lot less guarded.",
  },
  {
    id: 'q_legends_19',
    title: 'The Clockwork War: Mirror Match',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'mirror_golem', need: 10, label: 'Outwit 10 mirror golems' },
      { kind: 'kill', target: 'crystal_sentinel', need: 9, label: 'Crack 9 crystal sentinels' },
      { kind: 'kill', target: 'iron_warden', need: 8, label: 'Dent 8 iron wardens' },
    ],
    rewards: { xp: { attack: 2400, magic: 1000, defense: 1000 }, items: [{ id: 'crystal_cut', qty: 6 }, { id: 'bar_steel', qty: 6 }], blockCents: 190 },
    intro:
      "The lab's prototypes escaped. Mirror golems copy your last move, which is humbling. Crystal sentinels shrug off magic, which is insulting. Iron wardens just won't fall over, which is RUDE. Ten, nine, eight. Teach the prototypes a lesson they can't reflect.",
    outro:
      "The mirror golems ran out of moves to copy, the sentinels cracked, the wardens finally fell over. My prototypes are humbled and you've learned to fight something that fights like you. Unsettling, wasn't it? Good. The big ones don't copy — they just WIN. Usually.",
  },
  {
    id: 'q_legends_20',
    title: 'The Clockwork War: Knight Shift',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'clockwork_knight', need: 8, label: 'Disarm 8 clockwork knights' },
      { kind: 'kill', target: 'glacier_warden', need: 6, label: 'Melt 6 glacier wardens' },
    ],
    rewards: { xp: { attack: 3000, defense: 1500 }, items: [{ id: 'crystal_cut', qty: 7 }, { id: 'bar_gold', qty: 3 }], blockCents: 240 },
    intro:
      "Clockwork knights were built to replace the Capital guard, which, honestly, understandable, but they replaced them a little TOO permanently. Glacier wardens guard the northern prototype vault in a cold I can feel from here. Eight knights, six wardens. Clock out, permanently.",
    outro:
      "Eight knights disarmed, six wardens melted. The Capital's cold little coup is over before anyone important noticed it started. You're wading into the real tonnage now — the siege-class. Those don't tick. They RUMBLE.",
  },
  {
    id: 'q_legends_21',
    title: 'The Clockwork War: Siege Engine',
    giver: 'foreman_dagna',
    regionId: 'ironhold',
    steps: [
      { kind: 'kill', target: 'siege_golem', need: 6, label: 'Dismantle 6 siege golems' },
      { kind: 'kill', target: 'bastion_walker', need: 5, label: 'Topple 5 bastion walkers' },
    ],
    rewards: { xp: { attack: 3800, defense: 2000, mining: 600 }, items: [{ id: 'bar_gold', qty: 5 }, { id: 'crystal_cut', qty: 8 }], blockCents: 300 },
    intro:
      "Siege golems carry their own walls. Bastion walkers ARE walls that got bored. They were built to break a city — the plans say which city, and it's OURS. Six and five. Reduce the siege to a pile of expensive regret before anyone has to evacuate.",
    outro:
      "Six siege golems dismantled, five bastion walkers toppled. The invasion that nobody knew was coming has been cancelled by one very tired Blockling with a grudge. There are two things left in that vault. They're the biggest. They're the reason the vault needed walls.",
  },
  {
    id: 'q_legends_22',
    title: 'The Clockwork War: The Last Two Titans',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'obsidian_automaton', need: 4, label: 'Shatter 4 obsidian automatons' },
      { kind: 'kill', target: 'rune_colossus', need: 3, label: 'Silence 3 rune colossi' },
      { kind: 'kill', target: 'aegis_titan', need: 2, label: 'Fell 2 aegis titans' },
    ],
    rewards: { xp: { attack: 6000, defense: 3200, magic: 1600 }, items: [{ id: 'bar_gold', qty: 8 }, { id: 'crystal_cut', qty: 12 }, { id: 'food_cake', qty: 3 }], blockCents: 480 },
    intro:
      "The vault's heart holds three classes of nightmare: obsidian automatons that don't chip, rune colossi humming with a magic I helped write and now regret, and the aegis titans — the things the OTHER things were guarding. Four, three, two. Win and the Clockwork War is a footnote. Lose and it's a eulogy.",
    outro:
      "Four automatons shattered, three colossi silenced, two aegis titans down for the count. The vault is a scrapyard, the war is a footnote, and I am never, EVER building a self-repairing anything again. You ended an army. Take the gold — it's the least the Capital owes a legend.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // ARC E — "The Swarm": insects, Greenwood underbrush → wastes
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'q_legends_23',
    title: 'The Swarm: Beneath Notice',
    giver: 'herbalist_moss',
    regionId: 'greenwood',
    steps: [
      { kind: 'kill', target: 'beetle_dung', need: 15, label: 'Roll back 15 dung beetles' },
      { kind: 'kill', target: 'ant_soldier', need: 15, label: 'Disband 15 soldier ants' },
    ],
    rewards: { xp: { attack: 700, herbalism: 300 }, items: [{ id: 'herb_green', qty: 8 }, { id: 'herb_red', qty: 4 }], blockCents: 60 },
    intro:
      "The herb garden has a bug problem, and I mean that in the oldest, most literal, most disgusting sense. Dung beetles rolling off with my seedbeds, soldier ants marching in formation like they pay rent. Fifteen each. Squish with conviction.",
    outro:
      "Fifteen beetles rolled, fifteen ants disbanded. My garden survives another season. You've started at the bottom of the food chain, which is a humbling but necessary rung. The bigger bugs won't be this polite.",
  },
  {
    id: 'q_legends_24',
    title: 'The Swarm: Things That Pray',
    giver: 'herbalist_moss',
    regionId: 'greenwood',
    steps: [
      { kind: 'kill', target: 'mantis_prayer', need: 12, label: 'Interrupt 12 praying mantises' },
      { kind: 'kill', target: 'wasp_paper', need: 14, label: 'Deflate 14 paper wasps' },
      { kind: 'kill', target: 'tick_bloated', need: 10, label: 'Pop 10 bloated ticks' },
    ],
    rewards: { xp: { attack: 1000, archery: 400 }, items: [{ id: 'herb_blue', qty: 5 }, { id: 'potion_hp_large', qty: 2 }], blockCents: 90 },
    intro:
      "Praying mantises pray for you to come closer. Paper wasps build city-states in my eaves. And the bloated ticks — don't ask what they're bloated WITH, you'll stop sleeping. Twelve, fourteen, ten. Wear sleeves. Wear all the sleeves.",
    outro:
      "Mantises interrupted, wasps deflated, ticks popped — and I'll thank you not to describe the ticks. The garden's eaves are mine again. You're moving up the bug ladder, and the next rungs have PINCERS.",
  },
  {
    id: 'q_legends_25',
    title: 'The Swarm: Pincers and Patience',
    giver: 'ranger_kael',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'beetle_rhino', need: 10, label: 'Overturn 10 rhino beetles' },
      { kind: 'kill', target: 'scorpion_sand', need: 12, label: 'De-sting 12 sand scorpions' },
      { kind: 'kill', target: 'centipede_bog', need: 10, label: 'Shorten 10 bog centipedes' },
    ],
    rewards: { xp: { attack: 1400, defense: 600 }, items: [{ id: 'hide_tough', qty: 6 }, { id: 'crystal_raw', qty: 4 }], blockCents: 120 },
    intro:
      "The ashen fringe breeds bugs with ARMOR now. Rhino beetles you flip, sand scorpions you watch the tail, bog centipedes you count the legs AS you remove them, for morale. Ten, twelve, ten. This is where bug-hunting stops being funny and starts being cardio.",
    outro:
      "Rhino beetles overturned, scorpions de-stung, centipedes considerably shorter. You've graduated to the armored tier of pest control. The spiders are next, and they are NOT paper wasps. These ones plan.",
  },
  {
    id: 'q_legends_26',
    title: 'The Swarm: The Reclusive Types',
    giver: 'ranger_kael',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'spider_funnel', need: 10, label: 'Collapse 10 funnel spiders' },
      { kind: 'kill', target: 'spider_recluse', need: 10, label: 'Evict 10 recluse spiders' },
      { kind: 'kill', target: 'wasp_hornet', need: 12, label: 'Ground 12 giant hornets' },
    ],
    rewards: { xp: { attack: 1900, archery: 900 }, items: [{ id: 'crystal_cut', qty: 4 }, { id: 'potion_hp_large', qty: 3 }], blockCents: 160 },
    intro:
      "Funnel spiders ambush, recluse spiders you don't see until it's a medical event, and the giant hornets are, and I quote the last ranger, 'nope-copters'. Ten, ten, twelve. Fight from range. Fight from VERY range. I'll be over here, supportively, far away.",
    outro:
      "Funnels collapsed, recluses evicted, nope-copters grounded. You cleared the wastes' worst ambushers from a dignified distance. There are two things left in the deep burrows. They're big enough to have ECOSYSTEMS living on them.",
  },
  {
    id: 'q_legends_27',
    title: 'The Swarm: The Hive Royalty',
    giver: 'herbalist_moss',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'mantis_blade', need: 7, label: 'Disarm 7 blade mantises' },
      { kind: 'kill', target: 'centipede_chasm', need: 5, label: 'Behead 5 chasm centipedes' },
      { kind: 'kill', target: 'scorpion_emperor', need: 4, label: 'Dethrone 4 emperor scorpions' },
      { kind: 'kill', target: 'locust_swarm', need: 6, label: 'Scatter 6 locust swarms' },
    ],
    rewards: { xp: { attack: 4000, defense: 2000, archery: 1500 }, items: [{ id: 'crystal_cut', qty: 9 }, { id: 'bar_steel', qty: 5 }, { id: 'food_honey', qty: 4 }], blockCents: 360 },
    intro:
      "The royalty of the swarm: blade mantises with ARMS that are SWORDS, chasm centipedes the size of bridges, emperor scorpions that rule the dunes, and locust swarms that eat the dunes themselves. Seven, five, four, six. End the hive's monarchy and the little bugs go back to being just bugs.",
    outro:
      "The blade mantises disarmed, the chasm centipedes beheaded, the emperor scorpions dethroned, the locust swarms scattered to the wind. The swarm has no crown now, no king, no plan — just bugs. You de-monarchized an entire kingdom of insects. Somewhere, an entomologist is weeping with joy and fear.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // ARC F — "The Drowned Depths": sea creatures, coasts of the outer isles
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'q_legends_28',
    title: 'The Drowned Depths: Low Tide',
    giver: 'honest_jim',
    regionId: 'beginnings',
    steps: [
      { kind: 'kill', target: 'reefcrab', need: 14, label: 'De-claw 14 reefcrabs' },
      { kind: 'kill', target: 'tidehopper', need: 12, label: 'Catch 12 tidehoppers' },
    ],
    rewards: { xp: { attack: 700, fishing: 400 }, items: [{ id: 'fish_raw', qty: 8 }, { id: 'fish_trout', qty: 4 }], blockCents: 60 },
    intro:
      "The tide brought company and the company has CLAWS. Reefcrabs in the shallows, tidehoppers skipping across the surf like they own the place, which, no, I own the place, I have a rod and everything. Fourteen and twelve. Make the beach mine again.",
    outro:
      "Fourteen reefcrabs de-clawed, twelve tidehoppers caught mid-skip. The beach is safe for honest lies to worms again. But the tide only brings bigger things, and the bigger things don't stay in the shallows. They INVITE you out.",
  },
  {
    id: 'q_legends_29',
    title: 'The Drowned Depths: Brackish Business',
    giver: 'honest_jim',
    regionId: 'beginnings',
    steps: [
      { kind: 'kill', target: 'bogleech', need: 15, label: 'Salt 15 bogleeches' },
      { kind: 'kill', target: 'mudskip', need: 12, label: 'Strand 12 mudskips' },
      { kind: 'kill', target: 'brinebat', need: 10, label: 'Ground 10 brinebats' },
    ],
    rewards: { xp: { attack: 1000, fishing: 600 }, items: [{ id: 'fish_salmon', qty: 5 }, { id: 'potion_hp_large', qty: 2 }], blockCents: 90 },
    intro:
      "Where the river meets the sea it meets a lot of other things too, all of them hungry. Bogleeches attach, mudskips flop with intent, brinebats come up from the sea caves at dusk. Fifteen, twelve, ten. Carry salt. Salt solves most brackish problems and seasons the rest.",
    outro:
      "Leeches salted, mudskips stranded, brinebats grounded. The brackish estuary is honest water again. You've cleared the shallows and the shoreline. The real depths are waiting, and the real depths have TEETH arranged in ways that aren't legal.",
  },
  {
    id: 'q_legends_30',
    title: 'The Drowned Depths: Things With Lures',
    giver: 'prospector_finn',
    regionId: 'ironhold',
    steps: [
      { kind: 'kill', target: 'pufferpup', need: 12, label: 'Deflate 12 pufferpups' },
      { kind: 'kill', target: 'frostfin', need: 12, label: 'Thaw 12 frostfins' },
      { kind: 'kill', target: 'anglerfiend', need: 8, label: 'Snuff the lures of 8 anglerfiends' },
    ],
    rewards: { xp: { attack: 1500, fishing: 800 }, items: [{ id: 'fish_salmon', qty: 6 }, { id: 'crystal_raw', qty: 4 }], blockCents: 120 },
    intro:
      "The mountain lakes go DEEP and connect to things they shouldn't. Pufferpups inflate, frostfins freeze the water around them, and anglerfiends dangle a pretty light so you swim right into the regret. Twelve, twelve, eight. Don't trust anything glowing. Down there, glowing means 'about to be lunch'.",
    outro:
      "Pufferpups deflated, frostfins thawed, anglerfiend lures snuffed. The deep lakes are navigable again, and I lost my lucky boot down there decades ago so believe me, I appreciate it. The TRUE depths remain. That's where the serpents live.",
  },
  {
    id: 'q_legends_31',
    title: 'The Drowned Depths: Serpents and Specters',
    giver: 'prospector_finn',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'sandwraith', need: 10, label: 'Dispel 10 sandwraiths' },
      { kind: 'kill', target: 'drownedman', need: 10, label: 'Lay 10 drowned men to rest' },
      { kind: 'kill', target: 'seaserpent', need: 6, label: 'Uncoil 6 sea serpents' },
    ],
    rewards: { xp: { attack: 2400, fishing: 1200, magic: 600 }, items: [{ id: 'crystal_cut', qty: 5 }, { id: 'fish_salmon', qty: 8 }, { id: 'potion_hp_large', qty: 3 }], blockCents: 190 },
    intro:
      "The outer isles' waters are haunted AND infested, which is overachieving. Sandwraiths rise from wet graves, drowned men walk the tideline looking for company, and sea serpents treat ships like appetizers. Ten, ten, six. Everything down here wants you to join it. Decline, firmly.",
    outro:
      "Sandwraiths dispelled, drowned men laid to rest, serpents uncoiled. The outer waters are haunted by considerably less. You've cleared the drowned middle depths. What's left is the bottom — where the pressure crushes ships and the things are big enough not to notice.",
  },
  {
    id: 'q_legends_32',
    title: 'The Drowned Depths: The Bottom of Everything',
    giver: 'honest_jim',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'coralgolem', need: 6, label: 'Crumble 6 coral golems' },
      { kind: 'kill', target: 'krakenling', need: 5, label: 'Untangle 5 krakenlings' },
      { kind: 'kill', target: 'tidewraith', need: 3, label: 'Dispel 3 tidewraiths' },
    ],
    rewards: { xp: { attack: 5000, fishing: 2500, magic: 1500 }, items: [{ id: 'crystal_cut', qty: 10 }, { id: 'bar_gold', qty: 4 }, { id: 'food_cake', qty: 3 }], blockCents: 420 },
    intro:
      "At the bottom of the outer isles: coral golems older than the coastline, krakenlings — BABY krakens, which means a parent — and tidewraiths, the drowned souls of every sailor who thought they knew the sea. Six, five, three. Come back up and I'll never doubt a fishing story again.",
    outro:
      "Coral golems crumbled, krakenlings untangled, tidewraiths dispelled. You went to the bottom of everything and came back with your bones and your mind. I've been fishing forty years and I've never heard of anyone doing that. Every tall tale told on this beach from now on is just you, underselling it.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // ARC G — "Elements Unbound": elementals, all regions, mage-sponsored
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'q_legends_33',
    title: 'Elements Unbound: Spark and Ember',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'mote_cinder', need: 15, label: 'Snuff 15 cinder motes' },
      { kind: 'kill', target: 'mote_spark', need: 15, label: 'Ground 15 spark motes' },
    ],
    rewards: { xp: { magic: 900, attack: 300 }, items: [{ id: 'crystal_raw', qty: 6 }, { id: 'potion_mp_large', qty: 2 }], blockCents: 70 },
    intro:
      "A binding circle I was absolutely CERTAIN about has failed, and now the Capital has a weather problem shaped like angry sparks. Cinder motes and spark motes — the small change of the elemental plane. Fifteen each. Catch them before they aggregate into something with a NAME.",
    outro:
      "Fifteen cinder motes, fifteen spark motes, all returned to inert. The Capital's indoor weather is back to 'merely damp'. But motes gather, and the ones that gathered first have been getting BIGGER while you worked. My circle has much to answer for.",
  },
  {
    id: 'q_legends_34',
    title: 'Elements Unbound: Frost and Stone',
    giver: 'mage_lyra',
    regionId: 'ironhold',
    steps: [
      { kind: 'kill', target: 'mote_frost', need: 15, label: 'Thaw 15 frost motes' },
      { kind: 'kill', target: 'mote_pebble', need: 15, label: 'Crush 15 pebble motes' },
      { kind: 'kill', target: 'mote_void', need: 12, label: 'Unmake 12 void motes' },
    ],
    rewards: { xp: { magic: 1200, mining: 500 }, items: [{ id: 'crystal_raw', qty: 8 }, { id: 'ore_iron', qty: 6 }], blockCents: 100 },
    intro:
      "The leak spread to Ironhold. Frost motes freezing the shafts, pebble motes clogging them, and — worryingly — void motes, which are little holes in the IDEA of things. Fifteen, fifteen, twelve. The void ones don't burn. They just need to stop BEING. Convince them.",
    outro:
      "Frost motes thawed, pebble motes crushed, void motes convinced out of existence. The shafts are clear and reality has its full complement of corners again. The motes are handled — but the leak had a SOURCE, and the source made bigger things than motes.",
  },
  {
    id: 'q_legends_35',
    title: 'Elements Unbound: The Lesser Elementals',
    giver: 'mage_lyra',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'elem_flame', need: 10, label: 'Extinguish 10 flame elementals' },
      { kind: 'kill', target: 'elem_frost', need: 10, label: 'Melt 10 frost elementals' },
      { kind: 'kill', target: 'elem_stone', need: 10, label: 'Shatter 10 stone elementals' },
    ],
    rewards: { xp: { magic: 2000, attack: 800, defense: 800 }, items: [{ id: 'crystal_cut', qty: 5 }, { id: 'bar_steel', qty: 4 }], blockCents: 160 },
    intro:
      "The motes have grown up. Flame, frost, and stone elementals now walk the ashlands — fully-formed tantrums of raw element with no manners and worse diction. Ten each. Oppose them with their opposite where you can; oppose them with violence where you can't.",
    outro:
      "Ten flame, ten frost, ten stone — all unbound back to formless. You've been cancelling tantrums in three languages at once. The lesser elementals are handled. The GREATER ones are forming now, and those don't just leak from my circle. They remember being called.",
  },
  {
    id: 'q_legends_36',
    title: 'Elements Unbound: Storm and Gale',
    giver: 'mage_lyra',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'elem_storm', need: 8, label: 'Disperse 8 storm elementals' },
      { kind: 'kill', target: 'elem_gale', need: 8, label: 'Becalm 8 gale elementals' },
      { kind: 'kill', target: 'elem_magma', need: 8, label: 'Cool 8 magma elementals' },
    ],
    rewards: { xp: { magic: 2800, attack: 1200 }, items: [{ id: 'crystal_cut', qty: 7 }, { id: 'potion_mp_large', qty: 4 }], blockCents: 220 },
    intro:
      "Storm elementals are arguments that learned to throw lightning. Gale elementals you can't hit because they're MADE of the gap where you aimed. Magma elementals just melt the whole question. Eight each. I'd help, but my circle started this and the elementals can TELL. They'd prioritize me. Go.",
    outro:
      "Storms dispersed, gales becalmed, magma cooled. The wastes have weather you can predict again, which out here is a miracle. You're fighting the primal forces of nature to a draw and then winning on points. Only the GREATEST remain — glacier, crystal, and the void.",
  },
  {
    id: 'q_legends_37',
    title: 'Elements Unbound: The Primordials',
    giver: 'mage_lyra',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'elem_glacier', need: 5, label: 'Thaw 5 glacier elementals' },
      { kind: 'kill', target: 'elem_crystal', need: 5, label: 'Fracture 5 crystal elementals' },
      { kind: 'kill', target: 'elem_void', need: 3, label: 'Seal 3 void elementals' },
    ],
    rewards: { xp: { magic: 6000, attack: 2000, defense: 2000 }, items: [{ id: 'crystal_cut', qty: 14 }, { id: 'bar_gold', qty: 5 }, { id: 'food_cake', qty: 3 }], blockCents: 500 },
    intro:
      "The greatest elementals: glaciers that move like continents in a hurry, crystal elementals that refract your spells into YOUR face, and the void elementals — the holes in everything, the things my circle was really trying to keep OUT. Five, five, three. Seal the void and the elemental plane goes quiet. Fail and it comes through entirely. No pressure. All the pressure.",
    outro:
      "Glaciers thawed, crystals fractured, the void sealed. The plane is quiet. My catastrophically overconfident circle is undone, the leak is plugged, and reality has all its elements back in their drawers. You fought the fundamental building blocks of the world and told them to sit down. They sat. Legends get written about less.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // ARC H — "The Dragon Ladder": the final climb to 999, all regions
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'q_legends_38',
    title: 'The Dragon Ladder: Hatchlings Count',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'wyrmling_ember', need: 10, label: 'Snuff 10 ember wyrmlings' },
      { kind: 'kill', target: 'wyrmling_frost', need: 10, label: 'Thaw 10 frost wyrmlings' },
    ],
    rewards: { xp: { attack: 3000, magic: 1000, vitality: 1000 }, items: [{ id: 'crystal_cut', qty: 6 }, { id: 'bar_steel', qty: 5 }], blockCents: 240 },
    intro:
      "You want to be a LEGEND, not just a very tired person who kills things? Then you climb the ladder, and the ladder is dragons. Start small — and 'small' here means 'merely house-sized'. Ember and frost wyrmlings, ten each. Everyone forgets the hatchlings have the same TEMPER as the parents.",
    outro:
      "Ten ember wyrmlings, ten frost wyrmlings. You've taken the first rung, which most 'heroes' take to the face. The hatchlings are done. The drakes have noticed their babies going quiet, and drakes hold GRUDGES. Come back when your nerve regrows.",
  },
  {
    id: 'q_legends_39',
    title: 'The Dragon Ladder: Junior Varsity',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'drake_ash', need: 8, label: 'Ground 8 ash drakes' },
      { kind: 'kill', target: 'drake_crag', need: 8, label: 'Topple 8 crag drakes' },
      { kind: 'kill', target: 'drake_dune', need: 8, label: 'Bury 8 dune drakes' },
    ],
    rewards: { xp: { attack: 5000, defense: 2000, magic: 1500 }, items: [{ id: 'crystal_cut', qty: 9 }, { id: 'bar_gold', qty: 4 }, { id: 'food_pie', qty: 3 }], blockCents: 380 },
    intro:
      "Drakes: dragons that never finished their degree. No breath weapon worth the name, but teeth, claws, and a chip on the shoulder the size of their mother. Ash, crag, dune — eight each, in the terrain they're named for, because they don't travel. Go to them. They'll be waiting. They always are.",
    outro:
      "Eight ash, eight crag, eight dune drakes — grounded, toppled, and buried respectively. You've cleared the junior varsity. The real wyverns are next, and wyverns DID finish the degree. They have a breath weapon and they CANNOT wait to show you.",
  },
  {
    id: 'q_legends_40',
    title: 'The Dragon Ladder: On the Wing',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'wyvern_cinder', need: 7, label: 'Ground 7 cinder wyverns' },
      { kind: 'kill', target: 'wyvern_glacier', need: 7, label: 'Ground 7 glacier wyverns' },
      { kind: 'kill', target: 'drake_prism', need: 6, label: 'Shatter 6 prism drakes' },
    ],
    rewards: { xp: { attack: 8000, archery: 3000, magic: 2500 }, items: [{ id: 'crystal_cut', qty: 12 }, { id: 'bar_gold', qty: 6 }, { id: 'food_cake', qty: 3 }], blockCents: 520 },
    intro:
      "Wyverns fight from the AIR, which is cheating, and they breathe fire or frost, which is also cheating, and the prism drakes bend light so you aim where they WERE. Seven, seven, six. If you don't have an answer for 'flying thing that breathes death', develop one on the way there. Fast learner or fast meal, those are the options.",
    outro:
      "Seven cinder wyverns, seven glacier wyverns, six prism drakes — all introduced to the ground at speed. You have an answer for flying death now, and the answer is 'you'. The TRUE dragons are above this. The wyrms. The ones that don't fly because they don't NEED to.",
  },
  {
    id: 'q_legends_41',
    title: 'The Dragon Ladder: The Elder Wyrms',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'wyrm_magma', need: 5, label: 'Cool 5 magma wyrms' },
      { kind: 'kill', target: 'wyrm_permafrost', need: 5, label: 'Thaw 5 permafrost wyrms' },
      { kind: 'kill', target: 'wyrm_crystalline', need: 4, label: 'Fracture 4 crystalline wyrms' },
    ],
    rewards: { xp: { attack: 14000, defense: 6000, magic: 5000 }, items: [{ id: 'crystal_cut', qty: 18 }, { id: 'bar_gold', qty: 8 }, { id: 'food_cake', qty: 4 }], blockCents: 700 },
    intro:
      "Wyrms are what dragons become when nothing has been able to kill them for a few centuries. Magma, permafrost, crystalline — ancient, enormous, and SO bored that your arrival is the most exciting thing to happen to them since the mountains were young. Five, five, four. Be interesting. Interesting, out here, means 'survives'.",
    outro:
      "Five magma wyrms, five permafrost wyrms, four crystalline wyrms. You killed things that were old when the kingdoms were villages. The wyrms are gone. The hermit's wastes are quiet in a way they haven't been in my lifetime. There are only the GREAT dragons left now. The three with names the old maps won't print.",
  },
  {
    id: 'q_legends_42',
    title: 'The Dragon Ladder: The Bone Wyrm',
    giver: 'gravekeeper_sol',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'wyrm_bone', need: 3, label: 'Lay 3 bone wyrms to final rest' },
    ],
    rewards: { xp: { attack: 20000, magic: 10000, vitality: 8000 }, items: [{ id: 'crystal_cut', qty: 22 }, { id: 'bar_gold', qty: 10 }, { id: 'food_cake', qty: 5 }], blockCents: 900 },
    intro:
      "Gerald found it. A dragon that died and refused to notice. The bone wyrm — a skeleton the length of a valley, held together by a grudge against the concept of endings. I buried a Skeleton King once; this is his landlord. Three of them nest in the far barrows. Three. Lay them to rest and the dead of the whole realm will sleep easier. So will I.",
    outro:
      "Three bone wyrms, laid to rest for the last time. Gerald wept, I wept, even the headstones seemed relieved. You put the un-dyingest thing in creation into the ground and planted begonias on the concept. The dead don't have a bigger legend than you now. And there are only two names left on the old maps.",
  },
  {
    id: 'q_legends_43',
    title: 'The Dragon Ladder: Ashfall and Rime',
    giver: 'captain_elara',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'dragon_ashfall', need: 2, label: 'Fell 2 Ashfall Dragons' },
      { kind: 'kill', target: 'dragon_rime', need: 2, label: 'Fell 2 Rime Dragons' },
    ],
    rewards: { xp: { attack: 40000, defense: 18000, magic: 16000 }, items: [{ id: 'crystal_cut', qty: 30 }, { id: 'bar_gold', qty: 14 }, { id: 'food_cake', qty: 6 }], blockCents: 1400 },
    intro:
      "The Crown doesn't ask me to send heroes after these two. The Crown asks me to send CONDOLENCES, in advance, to save postage. Ashfall burns provinces as a hobby. Rime froze a war mid-charge, both armies, and the ice is still there, still screaming. Two each. Come back and I'll perjure myself happily about how I always believed in you.",
    outro:
      "Two Ashfall Dragons, two Rime Dragons — felled. The provinces Ashfall was eyeing still stand. The frozen war is thawing, the screaming has stopped. The Crown has prepared a medal and an apology for doubting you, and I have prepared to watch the Crown grovel, which is the real reward. One name remains. The worst one. The one the maps leave BLANK.",
  },
  {
    id: 'q_legends_44',
    title: 'The Dragon Ladder: The Obsidian End',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [
      { kind: 'explore', target: 'the frontier beyond the Forgotten Lands', need: 1, label: "Walk to the edge of the map and keep going" },
      { kind: 'kill', target: 'dragon_obsidian', need: 1, label: 'End the Obsidian Dragon' },
    ],
    rewards: { xp: { attack: 90000, defense: 40000, magic: 40000, vitality: 30000 }, items: [{ id: 'crystal_cut', qty: 50 }, { id: 'bar_gold', qty: 25 }, { id: 'food_cake', qty: 10 }], blockCents: 3000 },
    intro:
      "This is the last thing I will ever ask of anyone, because after this there is nothing left to ask. Past the Forgotten Lands, past where the maps give up and just write 'no', there is the Obsidian Dragon. It is older than the word 'old'. It does not burn or freeze — it simply ENDS things, the way a sentence ends. Go to the edge of everything and end the thing that ends. One of it. One is enough. One is TOO MANY.",
    outro:
      "You ended the Obsidian Dragon. The thing at the edge of the map, the thing that ends things, is itself ended. There is no rung above this one; you've climbed off the top of the ladder into the sky. The realm will tell your story wrong for a thousand years and it still won't do you justice. Go home, legend. You've run out of things that can kill you. That's the loneliest victory there is — and you earned every empty mile of it.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // ARC I — "The Great Supply": a legendary gathering chain to 999
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'q_legends_45',
    title: 'The Great Supply: Humble Beginnings, Huge Numbers',
    giver: 'smith_orin',
    regionId: 'ironhold',
    steps: [
      { kind: 'gather', target: 'copper_vein', need: 25, label: 'Mine 25 copper veins' },
      { kind: 'gather', target: 'iron_vein', need: 25, label: 'Mine 25 iron veins' },
    ],
    rewards: { xp: { mining: 2500 }, items: [{ id: 'bar_iron', qty: 10 }, { id: 'ore_copper', qty: 15 }], blockCents: 120 },
    intro:
      "Every legendary forge-work starts with a stupid amount of ore and a strong back learning to hate itself. Twenty-five copper, twenty-five iron. It's not glamorous. The legend part comes LATER. The back pain is now. Swing.",
    outro:
      "Fifty veins. Your arms are longer than they were this morning and your soul is shorter. But that's a LEGENDARY amount of ore, and legends are just normal tasks done until they become ridiculous. You're on your way. Downhill, mostly, into more work.",
  },
  {
    id: 'q_legends_46',
    title: 'The Great Supply: Gold Fever, Clinical Dose',
    giver: 'smith_orin',
    regionId: 'ironhold',
    steps: [
      { kind: 'gather', target: 'gold_vein', need: 20, label: 'Mine 20 gold veins' },
      { kind: 'collect', target: 'bar_gold', need: 10, label: 'Pour 10 gold bars' },
    ],
    rewards: { xp: { mining: 3000, blacksmithing: 2000 }, items: [{ id: 'bar_gold', qty: 5 }, { id: 'ore_gold', qty: 10 }], blockCents: 200 },
    intro:
      "Now the expensive madness. Twenty gold veins mined, ten bars poured, and you WILL start muttering about 'just one more vein' — that's the fever, it's normal, I've buried men who caught it worse. Do the work, pour the bars, and walk away like someone with a future.",
    outro:
      "Twenty veins, ten bars, and you walked away. Not everyone does. The fever had you and you shook it, which is harder than the mining. That's the kind of restraint that separates a legendary smith from a cautionary one.",
  },
  {
    id: 'q_legends_47',
    title: 'The Great Supply: The Singing Deep',
    giver: 'smith_orin',
    regionId: 'ironhold',
    steps: [
      { kind: 'gather', target: 'crystal_node', need: 20, label: 'Harvest 20 crystal nodes' },
      { kind: 'collect', target: 'crystal_cut', need: 12, label: 'Cut 12 crystals' },
    ],
    rewards: { xp: { mining: 4000, magic: 1500 }, items: [{ id: 'crystal_cut', qty: 8 }, { id: 'crystal_shard', qty: 10 }], blockCents: 260 },
    intro:
      "The deep crystals hum, and after twenty nodes the humming starts humming BACK, which is where most apprentices quit and take up farming. Twenty nodes, twelve cut clean. Keep your mind your own down there. A legend isn't just strong — it's STUBBORN about staying itself.",
    outro:
      "Twenty nodes, twelve flawless cuts, and you came back up still answering to your own name. The deep sang to you and you hummed something ruder back. That crystal's worth a fortune, and the composure's worth more. You're nearly forge-worthy.",
  },
  {
    id: 'q_legends_48',
    title: 'The Great Supply: Timber for Titans',
    giver: 'smith_orin',
    regionId: 'greenwood',
    steps: [
      { kind: 'gather', target: 'oak_tree', need: 30, label: 'Fell 30 oak trees' },
      { kind: 'gather', target: 'pine_tree', need: 25, label: 'Fell 25 pine trees' },
      { kind: 'collect', target: 'wood_ancient', need: 6, label: 'Secure 6 ancient wood' },
    ],
    rewards: { xp: { woodcutting: 5000, blacksmithing: 1000 }, items: [{ id: 'wood_ancient', qty: 4 }, { id: 'wood_oak', qty: 20 }], blockCents: 300 },
    intro:
      "A legendary forge needs a legendary fire, and a legendary fire needs a frankly OBSCENE amount of wood. Thirty oak, twenty-five pine, and six ancient — the ancient's the hard part, the old trees fight back philosophically. Charcoal from the ordinary, soul from the ancient. Go make a forest nervous.",
    outro:
      "Thirty oak, twenty-five pine, six ancient. The forest will be whispering about you for a generation, which is the forest's version of a wanted poster. The fire I can build with this will melt things that laugh at ordinary heat. You're assembling the makings of something legendary. Keep going.",
  },
  {
    id: 'q_legends_49',
    title: 'The Great Supply: Feed the Legend',
    giver: 'maestro_ribbert',
    regionId: 'capital',
    steps: [
      { kind: 'gather', target: 'farm_plot', need: 30, label: 'Work 30 farm plots' },
      { kind: 'gather', target: 'fishing_spot', need: 25, label: 'Fish the pools 25 times' },
      { kind: 'collect', target: 'food_cake', need: 8, label: 'Bake 8 tiny expensive cakes' },
    ],
    rewards: { xp: { farming: 3500, fishing: 3500, cooking: 3000 }, items: [{ id: 'food_cake', qty: 4 }, { id: 'food_pie', qty: 6 }, { id: 'food_honey', qty: 5 }], blockCents: 280 },
    intro:
      "A legend that faints from hunger is just a dramatic corpse. Thirty plots, twenty-five casts, eight cakes — enough to provision a hero through the final climb AND cater the funeral if it goes poorly. Cook like lives depend on it. Specifically yours. They do.",
    outro:
      "Thirty plots, twenty-five casts, eight exquisite cakes. You've provisioned an epic. Whatever you march off to die against, you'll do it on a FULL STOMACH, which is the only kind of heroism I personally endorse. Eat well, legend. The hungry ones never make the songs.",
  },
  {
    id: 'q_legends_50',
    title: "The Great Supply: The Hoard to End Hoards",
    giver: 'smith_orin',
    regionId: 'ironhold',
    steps: [
      { kind: 'gather', target: 'gold_vein', need: 40, label: 'Mine 40 gold veins' },
      { kind: 'gather', target: 'crystal_node', need: 40, label: 'Harvest 40 crystal nodes' },
      { kind: 'collect', target: 'bar_gold', need: 20, label: 'Pour 20 gold bars' },
      { kind: 'collect', target: 'crystal_cut', need: 20, label: 'Cut 20 crystals' },
    ],
    rewards: { xp: { mining: 20000, blacksmithing: 15000 }, items: [{ id: 'bar_gold', qty: 20 }, { id: 'crystal_cut', qty: 20 }, { id: 'food_cake', qty: 5 }], blockCents: 2000 },
    intro:
      "This is the one they'll disbelieve. Forty gold veins. Forty crystal nodes. Twenty bars, twenty cuts. Enough wealth to buy a province and enough crystal to power a myth. Nobody has ever done it in one go. Nobody sane has tried. You stopped being either of those a long time ago. Go empty the mountain.",
    outro:
      "Forty veins, forty nodes, twenty bars, twenty cuts — in ONE go. The mountain is measurably lighter and you are measurably richer than the Crown, which we won't mention to the Crown. You've done the thing the old smiths swore was a tall tale. Now it's just a true tale, about you. That's all a legend ever is: the ridiculous thing, actually done.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // ARC J — "The Realm Walker": grand exploration circuit, capstone
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'q_legends_51',
    title: 'The Realm Walker: Know Thy Home',
    giver: 'inspector_flora',
    regionId: 'beginnings',
    steps: [
      { kind: 'explore', target: 'beginnings', need: 1, label: 'Survey the Kingdom of Beginnings' },
      { kind: 'explore', target: 'greenwood', need: 1, label: 'Survey Greenwood Forest' },
    ],
    rewards: { xp: { vitality: 1500 }, items: [{ id: 'food_jerky', qty: 5 }, { id: 'potion_hp_large', qty: 2 }], blockCents: 80 },
    intro:
      "A legend who can't read a map is just a rumor with good aim. Before you walk the whole realm you'll walk the EASY half — Beginnings and Greenwood — and learn what your own feet are worth. It's a lot of walking. That's the point. Legs first, legend later.",
    outro:
      "Both home regions surveyed, every trail under your boots. You know where you're from now, which matters, because the next legs are places people don't come back from. Jerky for the road. The road gets long from here.",
  },
  {
    id: 'q_legends_52',
    title: 'The Realm Walker: The Hard Middle',
    giver: 'inspector_flora',
    regionId: 'capital',
    steps: [
      { kind: 'explore', target: 'capital', need: 1, label: 'Survey the Royal Capital' },
      { kind: 'explore', target: 'ironhold', need: 1, label: 'Survey the Ironhold Mountains' },
      { kind: 'explore', target: 'ashen', need: 1, label: 'Survey the Ashen Dungeons' },
    ],
    rewards: { xp: { vitality: 3000 }, items: [{ id: 'food_pie', qty: 4 }, { id: 'potion_hp_large', qty: 3 }], blockCents: 140 },
    intro:
      "The middle of the realm is the mean part: a Capital that'll tax your survey, mountains that'll steepen just to spite you, and dungeons that resent being LOOKED at. Capital, Ironhold, Ashen. Survey all three. If the Ashen one whispers your name back, keep walking and don't answer. It's not polite down there. It's HUNGRY.",
    outro:
      "Capital, mountains, and dungeons surveyed — and the Ashen didn't keep you, which puts you ahead of three inspectors I could name but won't, out of respect. You've walked the hard middle. Only the far edge remains, and the far edge is where the maps start lying.",
  },
  {
    id: 'q_legends_53',
    title: 'The Realm Walker: The Edge of the Map',
    giver: 'inspector_flora',
    regionId: 'forgotten',
    steps: [
      { kind: 'explore', target: 'forgotten', need: 1, label: 'Survey the Forgotten Lands' },
      { kind: 'explore', target: 'the outer isles', need: 1, label: 'Chart the Outer Isles' },
      { kind: 'explore', target: 'the frontier beyond the Forgotten Lands', need: 1, label: 'Stand at the frontier and look over the edge' },
    ],
    rewards: { xp: { vitality: 10000 }, items: [{ id: 'food_cake', qty: 4 }, { id: 'potion_hp_large', qty: 5 }, { id: 'bar_gold', qty: 3 }], blockCents: 600 },
    intro:
      "The last survey, the one nobody completes. The Forgotten Lands, the Outer Isles the mapmakers draw as 'here be regrets', and the frontier past both — the edge of the map, the edge of what anyone's bothered to name. Walk all of it. Stand at the edge. Look over. Then come tell me what's out there, because the Crown's been too scared to ask for three hundred years.",
    outro:
      "You walked to the edge of the map and looked over the edge and came BACK, which no surveyor in the Crown's history has managed. Whatever's out there, you've seen it, and your feet have earned a rest they'll never actually get, because legends don't retire — they just run out of map. You've nearly run out. There's glory in that, and a little grief. Both are yours.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // ARC K — "The Beasts They Forgot": the wildlife nobody finished off
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'q_legends_54',
    title: 'The Beasts They Forgot: Cold Vermin',
    giver: 'scout_wren',
    regionId: 'ironhold',
    steps: [
      { kind: 'kill', target: 'tundra_fox', need: 14, label: 'Outfox 14 tundra foxes' },
      { kind: 'kill', target: 'frost_lynx', need: 12, label: 'Ground 12 frost lynxes' },
    ],
    rewards: { xp: { attack: 1100, archery: 500 }, items: [{ id: 'hide_tough', qty: 5 }, { id: 'food_jerky', qty: 3 }], blockCents: 90 },
    intro:
      "The cold hills breed clever little things that steal traps, steal bait, and once — I swear this on the mountain — stole a trapper's boots WHILE HE WORE THEM. Tundra foxes and frost lynxes. Fourteen and twelve. Out-think them. They've had practice. You've had none. Good luck.",
    outro:
      "Fourteen foxes outfoxed, twelve lynxes grounded. The cold hills are honest again and the trappers have their boots. You've beaten the cleverest small things in the mountains — the dumb BIG things are next, and they headbutt.",
  },
  {
    id: 'q_legends_55',
    title: 'The Beasts They Forgot: Headbutts and Hyenas',
    giver: 'ranger_kael',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'crag_ram', need: 12, label: 'Out-stubborn 12 crag rams' },
      { kind: 'kill', target: 'savanna_hyena', need: 14, label: 'Silence 14 savanna hyenas' },
    ],
    rewards: { xp: { attack: 1400, defense: 700, vitality: 500 }, items: [{ id: 'hide_boar', qty: 6 }, { id: 'food_pie', qty: 3 }], blockCents: 110 },
    intro:
      "Crag rams headbutt boulders FOR FUN and will gladly upgrade to headbutting you. Savanna hyenas laugh — actually laugh — the whole time they're trying to eat your leg, which is a terrible way to die, insult-wise. Twelve rams, fourteen hyenas. Wipe the smiles off. Both kinds.",
    outro:
      "Twelve rams out-stubborned, fourteen hyenas silenced mid-cackle. The last of the beasts everyone else gave up on are handled. You've cleared the whole wild roster now — fur, horn, and laughter. Whatever's got SCALES is a different ladder, and you're already climbing it.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // ARC L — "The Twice-Buried": branch undead legend, gravekeeper
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'q_legends_56',
    title: 'The Twice-Buried: Grave Shift',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'skeleton', need: 20, label: 'Re-retire 20 skeletons' },
      { kind: 'kill', target: 'ghoul_grave', need: 16, label: 'Re-bury 16 grave ghouls' },
      { kind: 'kill', target: 'gloomhound', need: 12, label: 'Leash 12 gloomhounds' },
    ],
    rewards: { xp: { attack: 1700, defense: 900, magic: 700 }, items: [{ id: 'crystal_shard', qty: 6 }, { id: 'potion_hp_large', qty: 3 }], blockCents: 130 },
    intro:
      "Double shift. Someone's been un-burying the dead faster than I can re-bury them, and I'm ONE gravekeeper with ONE Gerald. Twenty skeletons, sixteen ghouls, twelve gloomhounds. Clear the whole yard in one sweep and I might, MIGHT, sleep tonight. In the crypt. Where it's quiet. Usually.",
    outro:
      "Twenty, sixteen, twelve — the whole yard swept in one night. I slept. In the crypt. Uninterrupted. Do you know what that's WORTH to a gravekeeper? Everything. Gerald sends his regards, which is a cold spot near your left ear. He likes you.",
  },
  {
    id: 'q_legends_57',
    title: 'The Twice-Buried: Who Keeps Doing This',
    giver: 'gravekeeper_sol',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'barrow_wight', need: 12, label: 'Put down 12 barrow wights' },
      { kind: 'kill', target: 'boneknight_cursed', need: 10, label: 'Disassemble 10 cursed boneknights' },
      { kind: 'kill', target: 'lich_frost', need: 6, label: 'Thaw 6 frost liches' },
    ],
    rewards: { xp: { attack: 3600, magic: 1800, defense: 1200 }, items: [{ id: 'crystal_cut', qty: 8 }, { id: 'bar_steel', qty: 5 }, { id: 'food_cake', qty: 2 }], blockCents: 300 },
    intro:
      "I found the answer to 'who keeps un-burying everyone': the frost liches, running a little resurrection racket out of the far barrows. The wights are their foremen, the boneknights their muscle. Twelve, ten, six. Shut the whole operation down and the dead of this realm will STAY dead, which is the only HR policy I've ever cared about.",
    outro:
      "The racket's shut down. Twelve wights, ten boneknights, six liches — all permanently unemployed. The dead stay dead now, the way the dead PREFER, frankly. You didn't just fight the undead, you put their management out of business. Gerald is ecstatic. The temperature just dropped four degrees out of pure joy.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // ARC M — "Proving Grounds": classic-species legend gauntlets, capital
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'q_legends_58',
    title: 'Proving Grounds: The Green Gauntlet',
    giver: 'captain_elara',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'slime', need: 25, label: 'Splat 25 slimes' },
      { kind: 'kill', target: 'goblin', need: 20, label: 'Evict 20 goblins' },
      { kind: 'kill', target: 'bandit', need: 15, label: 'Arrest 15 bandits (terminally)' },
    ],
    rewards: { xp: { attack: 1800, defense: 600 }, items: [{ id: 'potion_hp_large', qty: 3 }, { id: 'food_pie', qty: 3 }], blockCents: 120 },
    intro:
      "Before the Crown lets you call yourself a legend it wants a NUMBER, because the Crown trusts spreadsheets more than songs. Twenty-five slimes, twenty goblins, fifteen bandits. Yes it's beneath you. The paperwork isn't. Fill the number. Earn the title the boring way.",
    outro:
      "Twenty-five, twenty, fifteen — the spreadsheet is satisfied and so, grudgingly, is the Crown. You've proven you can do the small work at a legendary SCALE, which is honestly what most legends turn out to be. The gauntlet gets heavier from here. Enjoy the warmup. It's over.",
  },
  {
    id: 'q_legends_59',
    title: 'Proving Grounds: The Iron Gauntlet',
    giver: 'captain_elara',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'golem', need: 18, label: 'Demolish 18 golems' },
      { kind: 'kill', target: 'orc', need: 18, label: 'Discourage 18 orcs' },
      { kind: 'kill', target: 'skeleton', need: 18, label: 'Re-retire 18 skeletons' },
    ],
    rewards: { xp: { attack: 3200, defense: 1600 }, items: [{ id: 'bar_steel', qty: 6 }, { id: 'potion_hp_large', qty: 4 }], blockCents: 220 },
    intro:
      "The middle gauntlet: eighteen golems, eighteen orcs, eighteen skeletons. Stone, muscle, and bone — the three things that have killed more 'heroes' than old age ever will. Do all three and the Crown stops calling you 'the applicant' in meetings. I've heard them. It's demeaning. For both of us.",
    outro:
      "Fifty-four of the realm's heaviest hitters, logged and dropped. You're not 'the applicant' anymore — you're a line item the Crown is afraid to cut. The last gauntlet is the one nobody passes. You're about to make the Crown update its vocabulary.",
  },
  {
    id: 'q_legends_60',
    title: 'Proving Grounds: The Impossible Gauntlet',
    giver: 'captain_elara',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'wraith_pale', need: 15, label: 'Banish 15 pale wraiths' },
      { kind: 'kill', target: 'pit_brute', need: 12, label: 'Humble 12 pit brutes' },
      { kind: 'kill', target: 'siege_golem', need: 8, label: 'Dismantle 8 siege golems' },
      { kind: 'kill', target: 'wyvern_cinder', need: 6, label: 'Ground 6 cinder wyverns' },
    ],
    rewards: { xp: { attack: 9000, defense: 4000, magic: 3000 }, items: [{ id: 'crystal_cut', qty: 14 }, { id: 'bar_gold', qty: 6 }, { id: 'food_cake', qty: 4 }], blockCents: 600 },
    intro:
      "The final gauntlet is one of everything that's ever made a grown knight resign. Wraiths you can't touch, pit brutes you can't move, siege golems you can't dent, and wyverns you can't REACH. Fifteen, twelve, eight, six. Nobody's completed this. The form's never been filled out. The ink's gone dry. Prove me a liar.",
    outro:
      "You filled out the form nobody's ever completed, in ink I had to re-wet because it had DRIED from disuse. Fifteen wraiths, twelve brutes, eight siege golems, six wyverns. The Crown doesn't have a word for what you are now, so they're inventing one. Until then: legend will do.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // ARC N — "Deep Tide": branch sea legend, outer isles
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'q_legends_61',
    title: 'Deep Tide: The Reef Reclaimed',
    giver: 'honest_jim',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'reefcrab', need: 20, label: 'De-claw 20 reefcrabs' },
      { kind: 'kill', target: 'coralgolem', need: 8, label: 'Crumble 8 coral golems' },
      { kind: 'kill', target: 'frostfin', need: 14, label: 'Thaw 14 frostfins' },
    ],
    rewards: { xp: { attack: 2600, fishing: 1600 }, items: [{ id: 'fish_salmon', qty: 8 }, { id: 'crystal_cut', qty: 4 }], blockCents: 180 },
    intro:
      "The outer reef used to be the best fishing in the world and now it's a fortress of crabs, coral golems, and fish so cold they frost the net. Twenty crabs, eight golems, fourteen frostfins. Reclaim the reef and I'll die a happy liar, surrounded by the fish I always SAID were out there.",
    outro:
      "Twenty crabs, eight golems, fourteen frostfins — the reef is MINE again, which is to say everyone's, which is to say mostly mine. Forty years of fishing stories just became true all at once. You've handed an old liar his honest reward. The deep is still deeper, though. It always is.",
  },
  {
    id: 'q_legends_62',
    title: 'Deep Tide: What the Kraken Mothered',
    giver: 'honest_jim',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'krakenling', need: 8, label: 'Untangle 8 krakenlings' },
      { kind: 'kill', target: 'tidewraith', need: 5, label: 'Dispel 5 tidewraiths' },
      { kind: 'kill', target: 'seaserpent', need: 8, label: 'Uncoil 8 sea serpents' },
    ],
    rewards: { xp: { attack: 4400, fishing: 2800, magic: 1600 }, items: [{ id: 'crystal_cut', qty: 9 }, { id: 'bar_gold', qty: 4 }, { id: 'food_cake', qty: 3 }], blockCents: 360 },
    intro:
      "There's a nursery in the deep trench — krakenlings, which means a MOTHER, guarded by tidewraiths and patrolling serpents. Eight, five, eight. Clear the nursery and the parent moves its brood to somebody else's ocean. That's not a victory. That's just making it the next sea's problem. I'll take it.",
    outro:
      "The nursery's cleared, the brood relocated to waters that frankly deserve it. Eight krakenlings, five tidewraiths, eight serpents. You've done what no fishing fleet dared — gone to the trench and come back with a story the sea itself will have to corroborate. Nobody's calling you a liar. Not even me, and I invented lying.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // ARC O — "Forge of Legends": artisan capstone, materials to mastery
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'q_legends_63',
    title: 'Forge of Legends: The Smelter Never Sleeps',
    giver: 'smith_orin',
    regionId: 'ironhold',
    steps: [
      { kind: 'collect', target: 'bar_copper', need: 20, label: 'Smelt 20 copper bars' },
      { kind: 'collect', target: 'bar_iron', need: 20, label: 'Smelt 20 iron bars' },
      { kind: 'collect', target: 'bar_steel', need: 15, label: 'Fold 15 steel bars' },
    ],
    rewards: { xp: { blacksmithing: 6000, mining: 2000 }, items: [{ id: 'bar_steel', qty: 8 }, { id: 'bar_gold', qty: 2 }], blockCents: 260 },
    intro:
      "A legendary smith is measured in BARS, and the number is always 'more than seems reasonable'. Twenty copper, twenty iron, fifteen steel. The forge runs day and night and so, now, do you. Sleep is for coppersmiths. You're going to be something louder.",
    outro:
      "Twenty copper, twenty iron, fifteen steel, poured clean enough to shave in. The smelter never slept and neither did you, and it SHOWS, in the good way and the under-eye way. You're a real smith now — the kind the apprentices tell stories about to scare each other.",
  },
  {
    id: 'q_legends_64',
    title: 'Forge of Legends: Gold Standard, Gold Pressure',
    giver: 'smith_orin',
    regionId: 'ironhold',
    steps: [
      { kind: 'collect', target: 'bar_gold', need: 15, label: 'Pour 15 gold bars' },
      { kind: 'collect', target: 'crystal_cut', need: 15, label: 'Cut 15 crystals' },
    ],
    rewards: { xp: { blacksmithing: 9000, mining: 3000, magic: 1500 }, items: [{ id: 'bar_gold', qty: 6 }, { id: 'crystal_cut', qty: 6 }, { id: 'food_cake', qty: 3 }], blockCents: 400 },
    intro:
      "Gold and crystal — the materials that separate a smith from an ARTIST, and bankrupt both. Fifteen gold bars, fifteen cut crystals. Gold punishes a shaky hand and crystal punishes a shaky MIND, so bring both hands and most of a mind. Make something the Capital will covet and never afford.",
    outro:
      "Fifteen gold bars, fifteen flawless crystals. Your hands held steady and your mind held together, which is two more than most manage. You're an artist now, smith — the dangerous kind, who makes beautiful things the powerful can't resist and can't pay for. Watch your back. Beauty makes enemies.",
  },
  {
    id: 'q_legends_65',
    title: "Forge of Legends: The Masterwork",
    giver: 'smith_orin',
    regionId: 'ironhold',
    steps: [
      { kind: 'collect', target: 'bar_gold', need: 25, label: 'Pour 25 gold bars' },
      { kind: 'collect', target: 'crystal_cut', need: 25, label: 'Cut 25 crystals' },
      { kind: 'collect', target: 'bar_steel', need: 25, label: 'Fold 25 steel bars' },
      { kind: 'collect', target: 'wood_ancient', need: 10, label: 'Season 10 ancient wood' },
    ],
    rewards: { xp: { blacksmithing: 40000, mining: 10000, magic: 8000 }, items: [{ id: 'bar_gold', qty: 15 }, { id: 'crystal_cut', qty: 15 }, { id: 'food_cake', qty: 6 }], blockCents: 1800 },
    intro:
      "Every mastersmith makes exactly one masterwork and spends the rest of their life failing to repeat it. Twenty-five gold, twenty-five crystal, twenty-five steel, ten ancient wood — the makings of a thing with a NAME, a thing songs are about. Nobody's gathered this much and had the nerve to forge it in one piece. Have the nerve. Forge the legend. Literally.",
    outro:
      "The masterwork is done. Twenty-five gold, twenty-five crystal, twenty-five steel, ten ancient woods, all forged into one impossible thing that hums when the light hits it right. You'll never make its equal. Nobody does — that's what makes it the masterwork. You're not a legendary smith anymore. You're the smith OTHER legends mention. Now put the hammer down. You've said everything a hammer can say.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // ARC P — "The Scaled Legion": branch dragon gauntlet, hermit
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'q_legends_66',
    title: 'The Scaled Legion: Clutch Control',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'wyrmling_ember', need: 15, label: 'Snuff 15 ember wyrmlings' },
      { kind: 'kill', target: 'wyrmling_frost', need: 15, label: 'Thaw 15 frost wyrmlings' },
      { kind: 'kill', target: 'drake_ash', need: 10, label: 'Ground 10 ash drakes' },
    ],
    rewards: { xp: { attack: 6000, magic: 2500, vitality: 2000 }, items: [{ id: 'crystal_cut', qty: 10 }, { id: 'bar_gold', qty: 5 }, { id: 'food_pie', qty: 4 }], blockCents: 420 },
    intro:
      "A clutch hatched out past the old watchtower — thirty wyrmlings and the ash drakes raising them, which is a DAYCARE from hell. Fifteen ember, fifteen frost, ten drakes. Handle the whole nursery before it graduates into my sky. I've suffered enough sky.",
    outro:
      "The clutch is handled, the drake-daycare disbanded. Thirty wyrmlings, ten drakes — a generation of dragons that will now never ruin anyone's roof. You've learned to fight them young, in numbers, which is the only sane way. The old ones wait higher up. They're not young. They're not in numbers. They're just OLD, and ANGRY, and WAITING.",
  },
  {
    id: 'q_legends_67',
    title: 'The Scaled Legion: Wings Over Everything',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'wyvern_cinder', need: 10, label: 'Ground 10 cinder wyverns' },
      { kind: 'kill', target: 'wyvern_glacier', need: 10, label: 'Ground 10 glacier wyverns' },
      { kind: 'kill', target: 'drake_prism', need: 8, label: 'Shatter 8 prism drakes' },
      { kind: 'kill', target: 'char_drake', need: 6, label: 'Ground 6 char drakes' },
    ],
    rewards: { xp: { attack: 12000, archery: 5000, magic: 4000 }, items: [{ id: 'crystal_cut', qty: 16 }, { id: 'bar_gold', qty: 8 }, { id: 'food_cake', qty: 4 }], blockCents: 760 },
    intro:
      "An entire flight has taken the far ridge — wyverns, prism drakes, char drakes, the whole winged middle class of dragonkind, and they fight TOGETHER now, which is a horror I'd hoped was just a legend. Ten, ten, eight, six. Thin the flight before it decides the wastes are a buffet with legs.",
    outro:
      "The flight is thinned to feathers and regret. Ten cinder wyverns, ten glacier, eight prism drakes, six char drakes — all introduced to gravity. The far ridge is quiet, the sky is empty, and the only winged things left are the GREAT ones, which don't fly in flights because they don't need help. Those are yours too, someday. Soon. Too soon.",
  },
  {
    id: 'q_legends_68',
    title: 'The Scaled Legion: The Three Great Wyrms',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'wyrm_magma', need: 6, label: 'Cool 6 magma wyrms' },
      { kind: 'kill', target: 'wyrm_permafrost', need: 6, label: 'Thaw 6 permafrost wyrms' },
      { kind: 'kill', target: 'wyrm_crystalline', need: 6, label: 'Fracture 6 crystalline wyrms' },
    ],
    rewards: { xp: { attack: 22000, defense: 10000, magic: 9000 }, items: [{ id: 'crystal_cut', qty: 24 }, { id: 'bar_gold', qty: 12 }, { id: 'food_cake', qty: 6 }], blockCents: 1100 },
    intro:
      "Eighteen elder wyrms have gathered at the shattered caldera — magma, permafrost, crystalline, six of each, which has NEVER happened, because elder wyrms hate each other almost as much as they'll hate you. Six, six, six. Something's drawing them together, and I don't want to find out what by waiting. Scatter the gathering.",
    outro:
      "Eighteen elder wyrms scattered to cinders, slush, and shards. Whatever was calling them together will have to call louder now, into an empty caldera. You've broken up a convocation of creatures older than kingdoms. There's precisely one thing left that could have summoned them — and it's past the edge of the map, and it's been waiting for YOU specifically. I'm almost sorry. Almost.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // ARC Q — "The Long Patrol": multi-skill legend errands, standalones
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'q_legends_69',
    title: 'The Long Patrol: Hunter and Gatherer',
    giver: 'inspector_flora',
    regionId: 'greenwood',
    steps: [
      { kind: 'kill', target: 'dire_boar', need: 12, label: 'Flatten 12 dire boars' },
      { kind: 'gather', target: 'herb_patch', need: 20, label: 'Pick 20 herb patches' },
      { kind: 'collect', target: 'hide_tough', need: 10, label: 'Cure 10 tough hides' },
    ],
    rewards: { xp: { attack: 1600, herbalism: 1600, tailoring: 1200 }, items: [{ id: 'hide_tough', qty: 6 }, { id: 'herb_gold', qty: 5 }], blockCents: 160 },
    intro:
      "A legend who can only swing a sword is just a very expensive sword. Twelve boars down, twenty herb patches picked, ten hides cured — kill, gather, AND craft, all in one patrol, because the Crown wants to see 'versatility' on the report and the report is all they read. Be versatile. It's exhausting. That's why it counts.",
    outro:
      "Twelve boars, twenty patches, ten cured hides — hunter, gatherer, AND tanner in one circuit. The report says 'versatile'. The truth says 'tired'. Both get you the title. A one-skill legend is a rumor; a many-skilled one is a LEGEND. You're spelling it out, skill by aching skill.",
  },
  {
    id: 'q_legends_70',
    title: 'The Long Patrol: Field Kitchen',
    giver: 'maestro_ribbert',
    regionId: 'capital',
    steps: [
      { kind: 'gather', target: 'farm_plot', need: 25, label: 'Work 25 farm plots' },
      { kind: 'gather', target: 'fishing_spot', need: 20, label: 'Fish the pools 20 times' },
      { kind: 'collect', target: 'food_pie', need: 10, label: 'Bake 10 meat pies' },
      { kind: 'collect', target: 'food_jerky', need: 10, label: 'Cure 10 jerky' },
    ],
    rewards: { xp: { farming: 4000, fishing: 4000, cooking: 4000 }, items: [{ id: 'food_pie', qty: 6 }, { id: 'food_jerky', qty: 6 }, { id: 'food_honey', qty: 4 }], blockCents: 300 },
    intro:
      "An army marches on its stomach and a legend marches on a MUCH bigger stomach. Twenty-five plots, twenty casts, ten pies, ten jerky — enough to feed a campaign and the vultures that follow it. Cook at scale. Provision the whole next chapter of your overblown life.",
    outro:
      "Twenty-five plots, twenty casts, ten pies, ten jerky. You've provisioned an epic campaign AND catered its inevitable sequel. Whatever you march off to slay, you'll do it fed, which is the difference between a legend and a hungry obituary. Eat first. Die never. That's the whole recipe.",
  },
  {
    id: 'q_legends_71',
    title: 'The Long Patrol: The Alchemist-Errant',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [
      { kind: 'gather', target: 'herb_patch', need: 25, label: 'Gather 25 herb patches' },
      { kind: 'collect', target: 'potion_hp_large', need: 12, label: 'Brew 12 large heals' },
      { kind: 'collect', target: 'potion_mp_large', need: 12, label: 'Brew 12 large manas' },
    ],
    rewards: { xp: { alchemy: 7000, herbalism: 3000, magic: 2000 }, items: [{ id: 'potion_hp_large', qty: 6 }, { id: 'potion_mp_large', qty: 6 }, { id: 'herb_gold', qty: 6 }], blockCents: 340 },
    intro:
      "A legend dies the same as anyone when the potion bag's empty — just with a better crowd watching. Twenty-five herb patches, twelve large heals, twelve large manas. Brew your own survival. Trusting a shopkeeper's potions in the endgame is how promising legends become cautionary ones. Brew. Bottle. Live.",
    outro:
      "Twenty-five patches rendered into twelve heals and twelve manas, all your own work, all trustworthy because you watched every bubble. You'll walk into the endgame carrying your own survival on your belt. That's the mark of the real article — a legend doesn't HOPE to live. It PREPARES to.",
  },

  // ══════════════════════════════════════════════════════════════════════
  // ARC R — "The Convergence": cross-arc endgame capstones
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'q_legends_72',
    title: 'The Convergence: Everything That Crawls',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'scorpion_emperor', need: 6, label: 'Dethrone 6 emperor scorpions' },
      { kind: 'kill', target: 'tomb_colossus', need: 4, label: 'Topple 4 tomb colossi' },
      { kind: 'kill', target: 'balor_spawn', need: 8, label: 'Cut down 8 balor spawn' },
      { kind: 'kill', target: 'aegis_titan', need: 3, label: 'Fell 3 aegis titans' },
    ],
    rewards: { xp: { attack: 30000, defense: 14000, magic: 12000 }, items: [{ id: 'crystal_cut', qty: 28 }, { id: 'bar_gold', qty: 14 }, { id: 'food_cake', qty: 6 }], blockCents: 1600 },
    intro:
      "Something's drawing the realm's worst things to one valley — emperor scorpions, tomb colossi, balor spawn, aegis titans, all gathering like they got the same invitation. Six, four, eight, three. They didn't gather by accident. Something's CALLING them, and it's past the edge, and it's patient. Break the gathering before it becomes an ARMY.",
    outro:
      "The gathering is broken. Emperor scorpions, tomb colossi, balor spawn, aegis titans — the worst of insect, dead, demon, and machine, scattered across one valley by one Blockling. They came when something called. You answered the call instead, with a sword. Whatever's past the edge now knows exactly who's coming for it. Good. Let it worry.",
  },
  {
    id: 'q_legends_73',
    title: 'The Convergence: The Four Winds of Death',
    giver: 'mage_lyra',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'dragon_ashfall', need: 3, label: 'Fell 3 Ashfall Dragons' },
      { kind: 'kill', target: 'dragon_rime', need: 3, label: 'Fell 3 Rime Dragons' },
      { kind: 'kill', target: 'elem_void', need: 5, label: 'Seal 5 void elementals' },
      { kind: 'kill', target: 'wyrm_bone', need: 4, label: 'Lay 4 bone wyrms to rest' },
    ],
    rewards: { xp: { attack: 60000, defense: 26000, magic: 26000, vitality: 20000 }, items: [{ id: 'crystal_cut', qty: 40 }, { id: 'bar_gold', qty: 20 }, { id: 'food_cake', qty: 8 }], blockCents: 2600 },
    intro:
      "The Obsidian Dragon doesn't wait defenseless. It's gathered four lieutenants from four corners of horror — Ashfall for fire, Rime for ice, the void elementals for nothing, and the bone wyrms for death itself. Three, three, five, four. Clear its honor guard before you knock on the door past the map. It won't expect anyone to make it through them. Surprise it.",
    outro:
      "The honor guard is gone. Three Ashfall, three Rime, five void, four bone wyrms — fire, ice, nothing, and death, all cleared from the Obsidian Dragon's door. There's nothing between you and the thing at the edge now but the walk. The whole realm is holding its breath. So is the thing past the map. For once, so am I.",
  },
  {
    id: 'q_legends_74',
    title: 'The Convergence: One Hundredfold',
    giver: 'inspector_flora',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'shadow_panther', need: 20, label: 'Best 20 shadow panthers' },
      { kind: 'kill', target: 'revenant_rust', need: 20, label: 'Re-kill 20 rust revenants' },
      { kind: 'kill', target: 'brimstone_fiend', need: 20, label: 'Extinguish 20 brimstone fiends' },
      { kind: 'kill', target: 'rune_colossus', need: 10, label: 'Silence 10 rune colossi' },
      { kind: 'kill', target: 'seaserpent', need: 10, label: 'Uncoil 10 sea serpents' },
    ],
    rewards: { xp: { attack: 50000, defense: 22000, magic: 20000 }, items: [{ id: 'crystal_cut', qty: 36 }, { id: 'bar_gold', qty: 18 }, { id: 'food_cake', qty: 8 }], blockCents: 2200 },
    intro:
      "The Crown's final tally, the one it's never had cause to use: one of every horror, times a terrifying number. Twenty panthers, twenty revenants, twenty fiends, ten colossi, ten serpents — beast, dead, demon, machine, and deep, all in one patrol. No one's ever filled this tally. The parchment's gone yellow waiting. Fill it, and the Crown runs out of numbers to doubt you with.",
    outro:
      "The tally is filled — eighty of the realm's worst, from five kinds of nightmare, in a single impossible patrol. The parchment that waited a century for someone worthy has your name on it now, in ink that'll outlast the Crown. There's nothing left to prove. There's only the thing past the edge, and the long quiet walk toward it.",
  },
  {
    id: 'q_legends_75',
    title: 'The Convergence: The Name the Maps Won\'t Print',
    giver: 'elder_rowan',
    regionId: 'beginnings',
    steps: [
      { kind: 'explore', target: 'the frontier beyond the Forgotten Lands', need: 1, label: 'Return to the edge of everything, one last time' },
      { kind: 'kill', target: 'dragon_obsidian', need: 3, label: 'End all three Obsidian Dragons at the end of the world' },
    ],
    rewards: { xp: { attack: 180000, defense: 90000, magic: 90000, vitality: 70000 }, items: [{ id: 'crystal_cut', qty: 80 }, { id: 'bar_gold', qty: 40 }, { id: 'food_cake', qty: 15 }], blockCents: 6000 },
    intro:
      "Remember me? Elder Rowan. I sent you after five slimes once, a whole life ago, and called it a crisis. I was wrong about the crisis. THIS is the crisis. Past the edge of every map there wasn't one Obsidian Dragon — there were THREE, and they are the end that every other ending was rehearsing for. Go back to the edge of the world and end all three. I'm an old man who sent a child after slimes. Let me be the old man who sent a legend after the apocalypse. It's the best thing I'll ever do, and you're the best thing this village ever grew.",
    outro:
      "Three Obsidian Dragons, ended, at the edge of everything, by the kid I once sent after five slimes. The world doesn't end now. It just... keeps going, quietly, the way worlds prefer. You've climbed past 999, past the top of every ladder, past the last name the maps refused to print. There's nothing above you now but sky, and nothing left to fear in all the realm but your own reflection. Come home, legend. The slimes have unionized again. We'll always have slimes. That's what home IS. Welcome back.",
  },
]

/**
 * Legendary chains — every arc is a ladder, each rung gated behind the last,
 * so the questline reads as a genuine climb toward the 999 cap rather than a
 * pile of unlocked errands.
 */
const prereqs: Record<string, readonly string[]> = {
  // Arc A — The Hundred Beasts
  q_legends_02: ['q_legends_01'],
  q_legends_03: ['q_legends_02'],
  q_legends_04: ['q_legends_03'],
  q_legends_05: ['q_legends_04'],
  // Arc B — The Dead Walk
  q_legends_07: ['q_legends_06'],
  q_legends_08: ['q_legends_07'],
  q_legends_09: ['q_legends_08'],
  q_legends_10: ['q_legends_09'],
  q_legends_11: ['q_legends_10'],
  // Arc C — Fires of the Pit
  q_legends_13: ['q_legends_12'],
  q_legends_14: ['q_legends_13'],
  q_legends_15: ['q_legends_14'],
  q_legends_16: ['q_legends_15'],
  // Arc D — The Clockwork War
  q_legends_18: ['q_legends_17'],
  q_legends_19: ['q_legends_18'],
  q_legends_20: ['q_legends_19'],
  q_legends_21: ['q_legends_20'],
  q_legends_22: ['q_legends_21'],
  // Arc E — The Swarm
  q_legends_24: ['q_legends_23'],
  q_legends_25: ['q_legends_24'],
  q_legends_26: ['q_legends_25'],
  q_legends_27: ['q_legends_26'],
  // Arc F — The Drowned Depths
  q_legends_29: ['q_legends_28'],
  q_legends_30: ['q_legends_29'],
  q_legends_31: ['q_legends_30'],
  q_legends_32: ['q_legends_31'],
  // Arc G — Elements Unbound
  q_legends_34: ['q_legends_33'],
  q_legends_35: ['q_legends_34'],
  q_legends_36: ['q_legends_35'],
  q_legends_37: ['q_legends_36'],
  // Arc H — The Dragon Ladder (the long climb to 999)
  q_legends_39: ['q_legends_38'],
  q_legends_40: ['q_legends_39'],
  q_legends_41: ['q_legends_40'],
  q_legends_42: ['q_legends_41'],
  q_legends_43: ['q_legends_42'],
  q_legends_44: ['q_legends_43'],
  // Arc I — The Great Supply
  q_legends_46: ['q_legends_45'],
  q_legends_47: ['q_legends_46'],
  q_legends_48: ['q_legends_47'],
  q_legends_49: ['q_legends_48'],
  q_legends_50: ['q_legends_49'],
  // Arc J — The Realm Walker
  q_legends_52: ['q_legends_51'],
  q_legends_53: ['q_legends_52'],
  // Arc K — The Beasts They Forgot (continues the wildlife arc)
  q_legends_54: ['q_legends_05'],
  q_legends_55: ['q_legends_54'],
  // Arc L — The Twice-Buried (branches off the undead arc)
  q_legends_56: ['q_legends_11'],
  q_legends_57: ['q_legends_56'],
  // Arc M — Proving Grounds
  q_legends_59: ['q_legends_58'],
  q_legends_60: ['q_legends_59'],
  // Arc N — Deep Tide (continues the sea arc)
  q_legends_61: ['q_legends_32'],
  q_legends_62: ['q_legends_61'],
  // Arc O — Forge of Legends (continues the supply arc)
  q_legends_63: ['q_legends_50'],
  q_legends_64: ['q_legends_63'],
  q_legends_65: ['q_legends_64'],
  // Arc P — The Scaled Legion (branches off the dragon ladder)
  q_legends_66: ['q_legends_41'],
  q_legends_67: ['q_legends_66'],
  q_legends_68: ['q_legends_67'],
  // Arc Q — The Long Patrol
  q_legends_70: ['q_legends_69'],
  q_legends_71: ['q_legends_70'],
  // Arc R — The Convergence (cross-arc endgame capstones)
  q_legends_72: ['q_legends_68', 'q_legends_27'],
  q_legends_73: ['q_legends_44', 'q_legends_42', 'q_legends_37'],
  q_legends_74: ['q_legends_60', 'q_legends_22', 'q_legends_32'],
  q_legends_75: ['q_legends_73', 'q_legends_74', 'q_legends_53'],
}

/** Display names for any reward/collect ids not already carried by the catalog. */
const itemNames: Record<string, string> = {
  bar_gold: 'Gold Bar',
  crystal_cut: 'Cut Crystal',
  crystal_shard: 'Crystal Shard',
  wood_ancient: 'Ancient Wood',
  food_cake: 'Tiny Expensive Cake',
  food_honey: 'Honeycomb',
  food_jelly: 'Wobbling Jelly',
}

registerPack({ quests, prereqs, itemNames })
