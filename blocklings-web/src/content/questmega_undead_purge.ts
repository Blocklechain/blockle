/**
 * questmega_undead_purge — the "the dead won't stay dead and it's ruining
 * everyone's week" quest pack (~75 QuestDefs).
 *
 * Theme: undead, demons, and graveyards — cleansing, exorcism, cursed loot,
 * plague vermin, and the occasional bone-dragon with a grudge. Givers are the
 * region's load-bearing cynics (Gravekeeper Sol most of all, naturally), the
 * stakes are escalating, and absolutely nobody is being paid enough to exorcise
 * anything.
 *
 * Every step target is a real species id (kill), node kind (gather), item id
 * (collect), npc id (talk) or region id (explore); every reward item id is a
 * real catalog/pack material, food, or potion. No new items/mesh/recipes — so
 * nothing dangles or renders as the "?" fallback crate. Rewards are XP (scaling
 * toward the 999 cap for late chains), blockCents, and real materials/food.
 *
 * Side-effect: registers at import time via registerPack({ quests, prereqs,
 * itemNames }). Imported from src/content/index.ts.
 */
import { registerPack } from './packs'
import type { QuestDef } from '../types'

const quests: QuestDef[] = [
  // ═══════════════════════════════════════════════════════════════════════
  // GRAVEYARD SHIFT — Gravekeeper Sol's cleansing chain (ashen)
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_undead_purge_01',
    title: 'Someone Left the Graves Open',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'gravecrawler', need: 8, label: 'Re-bury 8 gravecrawlers' }],
    rewards: { xp: { attack: 120 }, items: [{ id: 'food_jerky', qty: 2 }], blockCents: 30 },
    intro:
      "The gravecrawlers are out again. They don't do much — mostly they ooze up through the dirt and emotionally ruin the flowerbeds — but a lawn is a promise, friend, and I keep my promises. Eight of them, back underground. Gerald's counting. Gerald always counts.",
    outro:
      "Eight crawlers, re-soiled. The flowerbeds breathe easier. You've got a tidy hand for the trade — most 'heroes' just set the whole plot on fire and call it closure.",
  },
  {
    id: 'q_undead_purge_02',
    title: 'Ghoul Problems',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'ghoul_grave', need: 10, label: 'Put down 10 grave ghouls' },
      { kind: 'collect', target: 'herb_green', need: 5, label: 'Gather 5 green herbs for the warding salve' },
    ],
    rewards: { xp: { attack: 180, herbalism: 90 }, items: [{ id: 'potion_regret', qty: 1 }], blockCents: 45 },
    intro:
      "Ghouls. They gnaw. On the headstones, on the fence, on the one tree I was emotionally invested in. I need ten of them stopped and five green herbs for a salve that keeps the chewing sort at bay — smells like a funeral and tastes like regret, which is on brand. Go.",
    outro:
      "Ten ghouls, zero remaining appetites. The tree's going to make it. I named it after you, briefly, then thought better of it — you're not the type to stay in one place, and neither are the dead, apparently.",
  },
  {
    id: 'q_undead_purge_03',
    title: 'Moth Season',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'deathmoth_pale', need: 12, label: 'Swat 12 pale deathmoths' }],
    rewards: { xp: { attack: 200 }, items: [{ id: 'food_pie', qty: 2 }], blockCents: 40 },
    intro:
      "The pale deathmoths are swarming the lanterns again. Lovely creatures, if you enjoy the sensation of your own funeral fluttering past your ear every nine seconds. Twelve of them, dispersed. They eat grief, supposedly. I have plenty. They're still not welcome.",
    outro:
      "Twelve moths, grounded. Quiet lanterns. You know, most people find the graveyard oppressive — I find it peaceful, and you've made it more so. Pie. It's fresh. Don't ask about the filling. You never ask. That's why I like you.",
  },
  {
    id: 'q_undead_purge_04',
    title: 'The Barrow Below the Barrow',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [
      { kind: 'explore', target: 'ashen', need: 1, label: 'Descend into the deeper barrows' },
      { kind: 'kill', target: 'barrow_wight', need: 6, label: 'Still 6 barrow wights' },
    ],
    rewards: { xp: { attack: 320, vitality: 160 }, items: [{ id: 'bar_steel', qty: 2 }], blockCents: 70 },
    intro:
      "There's a barrow under the barrow. I've known for years, I've chosen peace about it, and now the barrow wights down there have chosen violence, so peace is off the table. Head down, meet six of them, and remind them the lease ended during a previous administration.",
    outro:
      "Six wights, evicted from a property they didn't even technically own. You went UNDER the graveyard and came back — do you understand how rare that is? The begonias I plant for returning heroes are always just for show. Keep these bars. You earned them above ground.",
  },
  {
    id: 'q_undead_purge_05',
    title: 'A Widow in Every Crypt',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'crypt_widow', need: 9, label: 'Sweep 9 crypt widows' }],
    rewards: { xp: { attack: 360, defense: 140 }, items: [{ id: 'crystal_shard', qty: 2 }], blockCents: 80 },
    intro:
      "Crypt widows. Big spiders, bad attitudes, they string their webs across the sacred paths like they're DECORATING. I tripped. In front of Gerald. A dignity cost was incurred. Nine widows, swept out, and we never speak of the tripping. Agreed? Agreed.",
    outro:
      "Nine widows, no webs, dignity restored and backdated. The paths are walkable again. You never mentioned the tripping. You're a true professional and a better friend than the one I buried for mentioning it.",
  },
  {
    id: 'q_undead_purge_06',
    title: 'The Cursed Knight',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'boneknight_cursed', need: 4, label: 'Lay 4 cursed boneknights to rest' }],
    rewards: { xp: { attack: 480, defense: 220 }, items: [{ id: 'bar_gold', qty: 2 }, { id: 'food_cake', qty: 1 }], blockCents: 120 },
    intro:
      "Four boneknights are patrolling the old chapel like it's still their shift. It is NOT their shift. Their shift ended with a cavalry charge and a closed-casket memorial roughly two centuries ago. Relieve them of duty, permanently. They'll resist. They always resist. Duty rots last.",
    outro:
      "Four knights, honorably discharged into the dirt. The chapel's quiet for the first time since before I had this job, and I've had this job a LONG time. Cake. The tiny expensive kind. I was saving it. For this. For you, I suppose.",
  },
  {
    id: 'q_undead_purge_07',
    title: 'Deposing the King (Again, I Know)',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'revenant_rust', need: 10, label: 'Break the King\'s 10 rusted revenant honor guard' },
      { kind: 'kill', target: 'lich_frost', need: 1, label: 'Shatter the Frost Lich propping him up' },
    ],
    rewards: { xp: { attack: 820, vitality: 440, magic: 300 }, items: [{ id: 'bar_gold', qty: 3 }, { id: 'crystal_cut', qty: 2 }], blockCents: 260 },
    intro:
      "I know. I KNOW. We deposed a king already. But this one's new management — a Frost Lich crawled in, found the old throne, and started a RESTORATION. Ten rusted revenants guard him and the lich keeps him upright. Break the guard, break the lich, break the cycle. I am so tired of begonias.",
    outro:
      "The guard: rubble. The lich: slush. The restoration: cancelled, no refunds. I have planted begonias with a heavy heart and a steady hand. The graveyard sleeps, Gerald weeps, and you — you've done more for the dead than most of the living ever manage. Gold. Take it. The dead don't spend.",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // THE PLAGUE BENEATH — vermin and pestilence (capital → ashen)
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_undead_purge_08',
    title: 'Rats of Unusual Opinions',
    giver: 'captain_elara',
    regionId: 'capital',
    steps: [{ kind: 'kill', target: 'plague_rat', need: 15, label: 'Cull 15 plague rats' }],
    rewards: { xp: { attack: 160 }, items: [{ id: 'food_jerky', qty: 3 }], blockCents: 35 },
    intro:
      "The lower districts have plague rats. Not the regular kind — these ones died, got bored of it, and came back worse. They bite, they spread things with names I can't pronounce, and one of them stole a councilman's wig. Fifteen of them. The wig is a bonus objective; I won't lie, I want the wig.",
    outro:
      "Fifteen rats culled, districts disinfected, and — is that the wig? It is. Don't tell the councilman. He looks better bald and more honest about it. Jerky. It's rat-free. Probably. I didn't supervise the butcher closely and I regret that now.",
  },
  {
    id: 'q_undead_purge_09',
    title: 'Something in the Sewers',
    giver: 'captain_elara',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'plague_rat', need: 10, label: 'Clear 10 more plague rats' },
      { kind: 'kill', target: 'bogleech', need: 8, label: 'Drain 8 bogleeches' },
      { kind: 'collect', target: 'herb_blue', need: 4, label: 'Collect 4 blue herbs for the physician' },
    ],
    rewards: { xp: { attack: 240, herbalism: 120 }, items: [{ id: 'potion_regret', qty: 2 }], blockCents: 55 },
    intro:
      "The rats were a symptom. Under the capital it's wet, it's dark, and the bogleeches have moved in to feast on whatever the rats drag down. Ten rats, eight leeches, and four blue herbs for the physician who has to patch up whoever we send down. That's you. Congratulations on the promotion.",
    outro:
      "Sewers cleared, leeches drained, physician supplied. The capital's water smells like water again instead of regret. You've done the city a service nobody will ever thank you for, so I'll do it: thanks. There. Don't let it go to your head.",
  },
  {
    id: 'q_undead_purge_10',
    title: 'Corpse Imps, Plural',
    giver: 'npc_capital_sergeant',
    regionId: 'capital',
    steps: [{ kind: 'kill', target: 'corpse_imp', need: 12, label: 'Snuff out 12 corpse imps' }],
    rewards: { xp: { attack: 260, magic: 100 }, items: [{ id: 'bar_iron', qty: 3 }], blockCents: 50 },
    intro:
      "Corpse imps in the graveyard district. Little demons that reanimate whatever's lying around and send it shuffling into traffic. We've had three carts hit a reanimated what-used-to-be-a-horse this week. Twelve imps, snuffed. End the supply chain, end the problem.",
    outro:
      "Twelve imps, snuffed, supply chain severed. No more surprise horses. The cart drivers have started a collection for you — it's mostly buttons and a strongly-worded thank you, but the sentiment's genuine. Take the iron instead. More useful than buttons.",
  },
  {
    id: 'q_undead_purge_11',
    title: 'Bloated and Unbothered',
    giver: 'npc_capital_sergeant',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'tick_bloated', need: 14, label: 'Pop 14 bloated ticks' },
      { kind: 'collect', target: 'herb_red', need: 6, label: 'Collect 6 red herbs for the antivenom' },
    ],
    rewards: { xp: { attack: 300, herbalism: 140 }, items: [{ id: 'food_jelly', qty: 2 }], blockCents: 60 },
    intro:
      "The bloated ticks are the size of apples now and twice as smug. They latch onto the plague-dead and swell with things best left un-swollen. Pop fourteen of them — stand UPWIND — and bring six red herbs for the antivenom, because you WILL need the antivenom. Everyone needs the antivenom.",
    outro:
      "Fourteen ticks, popped, upwind, hopefully. The antivenom's brewing. You smell like a decision you'll regret, but you're alive, which is the only metric that pays out around here. Jelly. It's the good kind. You've earned the good kind.",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CURSED LOOT — the exorcism side-business (mage_lyra, capital)
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_undead_purge_12',
    title: 'The Haunted Inventory',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'ash_spectre', need: 7, label: 'Banish 7 ash spectres' },
      { kind: 'collect', target: 'crystal_shard', need: 4, label: 'Collect 4 crystal shards to bind them into' },
    ],
    rewards: { xp: { magic: 300, mining: 120 }, items: [{ id: 'crystal_cut', qty: 1 }], blockCents: 70 },
    intro:
      "My cursed-loot research is going splendidly, which is to say my lab is haunted. Ash spectres keep seeping out of the artifacts I'm studying. I need seven banished and four crystal shards to bind the residue into — spectres hate being filed, which is exactly why I file them. For science. Mostly science.",
    outro:
      "Seven spectres, bound and labelled. The lab's merely eerie now instead of actively hostile, which for a cursed-artifact research wing counts as 'cozy'. Chapter eleven is SAVED. Take this cut crystal — it hums with the key of 'definitely not haunted anymore'. Probably.",
  },
  {
    id: 'q_undead_purge_13',
    title: 'Wraiths Have No Manners',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [{ kind: 'kill', target: 'wraith_pale', need: 9, label: 'Dispel 9 pale wraiths' }],
    rewards: { xp: { magic: 340 }, items: [{ id: 'potion_regret', qty: 2 }], blockCents: 65 },
    intro:
      "Pale wraiths are leaking out of a particularly rude amulet a 'collector' sold me without mentioning the screaming. Nine of them are now haunting the east wing and critiquing my FILING SYSTEM, which is alphabetical by threat level, which is CORRECT. Dispel them before they reorganize anything.",
    outro:
      "Nine wraiths dispelled, filing system vindicated and untouched. The amulet's been downgraded from 'cursed' to 'sulky'. I'll take it. You've a real knack for the intangible — most warriors just swing through a wraith and look offended when it doesn't help.",
  },
  {
    id: 'q_undead_purge_14',
    title: 'Return to Sender',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'gloom_imp', need: 10, label: 'Banish 10 gloom imps' },
      { kind: 'gather', target: 'crystal_node', need: 5, label: 'Harvest 5 crystal nodes for fresh binding stones' },
    ],
    rewards: { xp: { magic: 400, mining: 180 }, items: [{ id: 'crystal_cut', qty: 2 }, { id: 'potion_regret', qty: 1 }], blockCents: 90 },
    intro:
      "A box of 'definitely not cursed' trinkets arrived and — surprise — it was extremely cursed. Gloom imps are pouring out faster than I can log them. Ten banished, and I need five fresh crystal nodes mined for new binding stones, because the imps keep eating the old ones. Rude little parasites. Off you go.",
    outro:
      "Ten imps banished, five binding stones freshly cut and un-eaten. The box is now merely a box, which is all I ever wanted from it. Cut crystals, as agreed — and keep the potion, you've got the expression of someone who's seen inside a cursed trinket box, and that expression needs medicating.",
  },
  {
    id: 'q_undead_purge_15',
    title: 'The Mirror That Stares Back',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'mirror_golem', need: 5, label: 'Smash 5 mirror golems' },
      { kind: 'kill', target: 'gloomhound', need: 6, label: 'Put down 6 gloomhounds' },
    ],
    rewards: { xp: { magic: 460, attack: 200 }, items: [{ id: 'crystal_cut', qty: 2 }], blockCents: 110 },
    intro:
      "I enchanted a mirror to reflect 'the truth'. The truth, it turns out, is five hostile mirror golems and a pack of gloomhounds that followed the reflections out. I have learned a valuable lesson about metaphors. Smash the golems, put down the hounds, and let's all pretend I didn't do this.",
    outro:
      "Five golems shattered, six hounds grounded, and the mirror's back to just making me look tired, which is the truth I can live with. You never asked WHY the truth was hostile. Discretion. I treasure it. Take the crystals and your dignity, both of which survived the week.",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // HELLMOUTH — the demon front (prophet_karl / npc_ashen_warden, ashen)
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_undead_purge_16',
    title: 'A Crack in the World',
    giver: 'prophet_karl',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'fiendling', need: 12, label: 'Cast out 12 fiendlings' }],
    rewards: { xp: { attack: 220, magic: 120 }, items: [{ id: 'food_jerky', qty: 3 }], blockCents: 45 },
    intro:
      "I SAW IT in a vision, and also with my eyes, which is less prophetic but more reliable: a crack in the world, down in the ashlands, and fiendlings wriggling out of it like it owes them money. Twelve of them, cast out. The vision didn't say what happens if you DON'T. The vision rarely does. Ominous, that.",
    outro:
      "Twelve fiendlings, cast back into the crack whence they oozed. The vision has updated: it's now a vision of you doing well, which is nice, and a vision of the crack getting bigger, which is less nice. We'll address the second one shortly. Jerky. Prophets eat too.",
  },
  {
    id: 'q_undead_purge_17',
    title: 'Hounds From Below',
    giver: 'prophet_karl',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'hellhound', need: 8, label: 'Put down 8 hellhounds' }],
    rewards: { xp: { attack: 340, defense: 160 }, items: [{ id: 'hide_tough', qty: 3 }], blockCents: 75 },
    intro:
      "The crack widened — I TOLD you it would, don't look at me like the problem is me — and now hellhounds are loping through. Eight of them, each one on fire and deeply committed to the bit. Put them down. Their hides are fireproof, which is worth something, assuming you survive the harvesting.",
    outro:
      "Eight hellhounds, down and extinguished. You've got their hides — tough, scorch-proof, smell forever of brimstone and bad decisions. The vision shows the crack is now more of a GAP. We're escalating our language. That's never a good sign. Rest while you can.",
  },
  {
    id: 'q_undead_purge_18',
    title: 'Cinder and Soot',
    giver: 'npc_ashen_warden',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'cinder_hound', need: 7, label: 'Douse 7 cinder hounds' },
      { kind: 'kill', target: 'soot_crawler', need: 9, label: 'Crush 9 soot crawlers' },
    ],
    rewards: { xp: { attack: 380, defense: 180 }, items: [{ id: 'bar_steel', qty: 2 }], blockCents: 85 },
    intro:
      "The gap — the prophet's gap, not mine, I disavow all gaps — is belching cinder hounds and soot crawlers across the whole ashen threshold. Seven hounds, nine crawlers. They burn everything that isn't already burnt, which out here is a short list, but it's MY short list.",
    outro:
      "Seven hounds doused, nine crawlers crushed, the threshold's back to its usual tasteful smoulder. You fight like someone who's decided fire is a personal insult, and I respect that worldview. Steel. Don't melt it. It's harder to replace than you are. No offense. Some offense.",
  },
  {
    id: 'q_undead_purge_19',
    title: 'The Brimstone Brigade',
    giver: 'npc_ashen_warden',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'ash_imp', need: 10, label: 'Scatter 10 ash imps' },
      { kind: 'kill', target: 'brimstone_fiend', need: 5, label: 'Banish 5 brimstone fiends' },
    ],
    rewards: { xp: { attack: 440, magic: 200 }, items: [{ id: 'bar_gold', qty: 1 }, { id: 'crystal_shard', qty: 2 }], blockCents: 120 },
    intro:
      "The gap has organized. The ash imps were chaos; the brimstone fiends are MANAGEMENT. They've got the imps marching in formation now, which is the worst thing that can happen to any demon incursion — competence. Scatter ten imps, banish five fiends, and dissolve their little org chart.",
    outro:
      "Ten imps scattered, five fiends banished, org chart in ashes where org charts belong. The incursion's back to disorganized clawing, which we can handle. You've bought us time. The vision — sorry, the PROPHET'S vision — says we'll need it. Gold. Shards. Go breathe actual air.",
  },
  {
    id: 'q_undead_purge_20',
    title: 'Pit Brutes at the Threshold',
    giver: 'npc_ashen_warden',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'pit_brute', need: 6, label: 'Topple 6 pit brutes' }],
    rewards: { xp: { attack: 520, defense: 260 }, items: [{ id: 'bar_gold', qty: 2 }], blockCents: 140 },
    intro:
      "Six pit brutes have wedged themselves into the gap and started WIDENING it with their shoulders, like it's a doorway and they're moving a very large, very cursed couch. Topple them before the couch gets through. The couch is a metaphor. The brutes are not. Hit the brutes.",
    outro:
      "Six brutes, toppled, gap un-widened, metaphorical couch returned to the metaphorical store. You're the only reason the ashlands aren't a demon loading dock right now. Gold, and the warden's grudging respect, which is rarer and worth less, but it's what I've got.",
  },
  {
    id: 'q_undead_purge_21',
    title: 'The Thing That Closes the Gap',
    giver: 'prophet_karl',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'balor_spawn', need: 8, label: 'Cut down 8 balor spawn' },
      { kind: 'kill', target: 'dread_maw', need: 1, label: 'Seal the gap by killing the Dread Maw' },
    ],
    rewards: { xp: { attack: 900, magic: 480, vitality: 400 }, items: [{ id: 'bar_gold', qty: 3 }, { id: 'crystal_cut', qty: 3 }], blockCents: 300 },
    intro:
      "The vision has clarified at last, and I wish it hadn't: the gap is a MOUTH. The Dread Maw. It's been inhaling the ashlands slowly for weeks, flanked by eight balor spawn that act as its teeth. Cut down the teeth, then kill the mouth, and the world closes over it like a bad memory. No pressure. All the pressure.",
    outro:
      "The teeth: cut. The Maw: killed. The world: sealed, scarred, but whole. The vision shows nothing now — just quiet, and me, finally getting some SLEEP. You closed a hole in reality with a weapon and sheer spite. I'd call you a prophet, but you'd have to see the future, and frankly you ARE the future. Gold. All of it. You earned the vision's worth.",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // FIELD SANITATION — standalone purges across the regions
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_undead_purge_22',
    title: 'The Skeleton Overtime Problem',
    giver: 'elder_rowan',
    regionId: 'beginnings',
    steps: [{ kind: 'kill', target: 'skeleton', need: 8, label: 'Re-retire 8 skeletons' }],
    rewards: { xp: { attack: 140 }, items: [{ id: 'food_jerky', qty: 2 }], blockCents: 25 },
    intro:
      "Even the sleepy old Kingdom of Beginnings has a bone problem now. Skeletons wandered up from the ashlands, found our quiet cemetery, and decided it was a 'networking opportunity'. Eight of them, back to rest. They don't bite much, but they RATTLE, and at my age that's an assault.",
    outro:
      "Eight skeletons, re-retired, rattling ceased. The village sleeps. I sleep. Even the dog's stopped barking at the cemetery, which it hasn't done since the incident we agreed to call 'the Tuesday thing'. Jerky. For the dog. And for you, if the dog shares, which it won't.",
  },
  {
    id: 'q_undead_purge_23',
    title: 'Bats That Used to Be Alive',
    giver: 'scout_wren',
    regionId: 'greenwood',
    steps: [
      { kind: 'kill', target: 'bat', need: 10, label: 'Ground 10 undead bats' },
      { kind: 'kill', target: 'brinebat', need: 6, label: 'Ground 6 brinebats that drifted in' },
    ],
    rewards: { xp: { attack: 200, archery: 100 }, items: [{ id: 'hide_wolf', qty: 3 }], blockCents: 40 },
    intro:
      "The Greenwood bats have gone WRONG. They don't flap right anymore — jerky, stiff, like something's piloting them from inside. And now brinebats have drifted up from the coast to join the airborne horror show. Ten bats, six brinebats. Shoot them down before the trees learn to fear the sky.",
    outro:
      "Sixteen things that shouldn't fly, grounded. The canopy's its own self again. Whatever was piloting those bats has gone quiet, which I'd find reassuring if 'gone quiet' ever meant 'gone away' out here. It doesn't. Take the hides. Stay sharp.",
  },
  {
    id: 'q_undead_purge_24',
    title: 'The Spider Was Already Dead',
    giver: 'ranger_kael',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'spider_recluse', need: 8, label: 'Put down 8 reclusive dead-spiders' }],
    rewards: { xp: { archery: 240, attack: 100 }, items: [{ id: 'hide_tough', qty: 2 }], blockCents: 50 },
    intro:
      "Found a nest of recluse spiders in the northern hollow. Here's the thing: they'd already died. Weeks ago. They're just... still spidering. Still webbing. Still lunging. Eight of them, put down for real this time. Shoot first. Do not attempt to confirm the diagnosis up close.",
    outro:
      "Eight recluses, put down for real. The hollow's clear. I've stopped trying to understand why the dead don't lie down out here — it's bad for morale and worse for sleep. Tough hide, well-earned. Don't think about the webs. I'm thinking about the webs. Don't.",
  },
  {
    id: 'q_undead_purge_25',
    title: 'Rats in the Deep Shafts',
    giver: 'foreman_dagna',
    regionId: 'ironhold',
    steps: [
      { kind: 'kill', target: 'plague_rat', need: 12, label: 'Clear 12 plague rats from the shafts' },
      { kind: 'gather', target: 'iron_vein', need: 5, label: 'Mine 5 iron veins while you\'re down there' },
    ],
    rewards: { xp: { attack: 180, mining: 160 }, items: [{ id: 'bar_iron', qty: 3 }], blockCents: 45 },
    intro:
      "Plague rats got into shaft seven and the miners won't go back down until it's clear, which is reasonable, because the rats are the reanimated kind and they've learned to work IN SHIFTS. Twelve rats, and since you're already down there, mine five iron veins. Multitask. The mountain respects efficiency and nothing else.",
    outro:
      "Twelve rats cleared, five veins mined, shaft seven reopened for business. The miners are back and only mildly traumatized, which is baseline. You're the most productive thing to happen to this mine since we invented the second shift. Iron's yours. Don't spend it all on therapy.",
  },
  {
    id: 'q_undead_purge_26',
    title: 'The Centipede in the Clay',
    giver: 'npc_ironhold_deepwarden_hale',
    regionId: 'ironhold',
    steps: [
      { kind: 'kill', target: 'centipede_chasm', need: 7, label: 'Crush 7 chasm centipedes' },
      { kind: 'gather', target: 'clay_pit', need: 4, label: 'Dig 4 clay pits for the warding bricks' },
    ],
    rewards: { xp: { attack: 260, mining: 140 }, items: [{ id: 'clay_lump', qty: 4 }, { id: 'bar_iron', qty: 2 }], blockCents: 55 },
    intro:
      "Chasm centipedes have burrowed into the deep clay, and they're not the living kind — they're the kind that keep moving after you've cut them in half, which is a FEATURE for them and a NIGHTMARE for me. Crush seven, and dig four clay pits — we're bricking up the tunnels they came from. Warding clay. Old deepwarden trick.",
    outro:
      "Seven centipedes crushed — some of them twice, I know, I'm sorry, it's the nature of the beast — and four pits' worth of warding clay. The tunnels are bricked. The deep stays deep. You've got the clay you didn't need and iron you did. The trade favors you. Take it before I reconsider.",
  },
  {
    id: 'q_undead_purge_27',
    title: 'The Drowned Walk Ashore',
    giver: 'prospector_finn',
    regionId: 'ironhold',
    steps: [{ kind: 'kill', target: 'drownedman', need: 9, label: 'Return 9 drowned men to the deep' }],
    rewards: { xp: { attack: 300, fishing: 160 }, items: [{ id: 'fish_salmon', qty: 3 }], blockCents: 65 },
    intro:
      "The mountain pools gave something BACK this time, and I wish they'd kept it. Drowned men — folk who went under years ago — are walking out of the water and up the trails, dripping and cold and looking for company. Nine of them, returned to the deep. Gently. They didn't ask for this. Neither did I, but here we are.",
    outro:
      "Nine returned to the water, quiet at last. I keep a list of everyone I've known who went under. I checked it against the faces. None matched. I'm choosing to find that comforting. Salmon — fresh, I caught it before the drowned started walking, I SWEAR it's fresh. Take it. Eat it above ground.",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // THE OUTER ISLES — drowned horrors at the coast (narrative frontier)
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_undead_purge_28',
    title: 'Something Washed Up',
    giver: 'npc_forgotten_beastward',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'sandwraith', need: 10, label: 'Disperse 10 sandwraiths on the outer isles' },
      { kind: 'kill', target: 'bogleech', need: 8, label: 'Burn 8 bogleeches' },
    ],
    rewards: { xp: { attack: 340, magic: 140 }, items: [{ id: 'fish_salmon', qty: 2 }, { id: 'hide_tough', qty: 2 }], blockCents: 80 },
    intro:
      "Out on the outer isles the tide's been bringing in the WRONG things. Sandwraiths rise from the wet sand at dusk, and bogleeches have colonized every tidal pool like they pay rent. Ten wraiths, eight leeches. Go to the far edge of the world and make it slightly less haunted. Slightly. That's the ceiling out there.",
    outro:
      "Ten wraiths dispersed, eight leeches burned, the outer isles marginally less cursed. The tide'll bring more — it always does, the sea's got terrible taste in deliveries — but you've bought the fisherfolk a season. They'll name a boat after you. Badly. Take the salmon and go.",
  },
  {
    id: 'q_undead_purge_29',
    title: 'The Anglerfiend\'s Lantern',
    giver: 'npc_forgotten_beastward',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'anglerfiend', need: 5, label: 'Snuff 5 anglerfiend lanterns' }],
    rewards: { xp: { attack: 420, fishing: 200 }, items: [{ id: 'fish_salmon', qty: 4 }], blockCents: 100 },
    intro:
      "Anglerfiends. They hang a light over the dark water and when a drowned soul swims toward the glow — SNAP. They've been fishing the outer isles for the DEAD, which should be a victimless crime, except it's making MORE drowned, faster. Snuff five lanterns. End the fishing trip.",
    outro:
      "Five lanterns snuffed, five fiends gone dark forever. The dead can drift unmolested now, which is a sentence I never expected to say with relief. The waters are quieter. The drowned are fewer. Salmon, from a pool WITHOUT a lantern — I checked. Twice. Eat well.",
  },
  {
    id: 'q_undead_purge_30',
    title: 'The Tidewraith\'s Grudge',
    giver: 'npc_forgotten_beastward',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'brinebat', need: 9, label: 'Ground 9 brinebats' },
      { kind: 'kill', target: 'tidewraith', need: 3, label: 'Lay 3 tidewraiths to final rest' },
    ],
    rewards: { xp: { attack: 540, magic: 240 }, items: [{ id: 'crystal_shard', qty: 3 }, { id: 'fish_salmon', qty: 3 }], blockCents: 130 },
    intro:
      "The tidewraiths are the drowned who DIED ANGRY — captains who went down with grudges instead of ships. Three of them are stirring up the brinebats into a screaming coastal storm. Nine bats, three wraiths. Settle the grudges the only way grudges out here get settled: thoroughly, and with a weapon.",
    outro:
      "Three grudges settled, nine bats grounded, the coast gone calm as a held breath. The tidewraiths went quiet at the end — not peaceful, exactly, but DONE, which is the best the sea offers. Crystal shards, pulled from the wreck-line. They glow. Everything on the outer isles glows. Stop asking. I did.",
  },
  {
    id: 'q_undead_purge_31',
    title: 'The Kraken Was a Corpse',
    giver: 'npc_forgotten_beastward',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'krakenling', need: 8, label: 'Cut down 8 krakenlings' },
      { kind: 'kill', target: 'seaserpent', need: 1, label: 'Slay the dead Sea Serpent beneath the isles' },
    ],
    rewards: { xp: { attack: 860, vitality: 420, fishing: 300 }, items: [{ id: 'bar_gold', qty: 3 }, { id: 'crystal_cut', qty: 2 }], blockCents: 280 },
    intro:
      "Here's the root of the outer-isles rot: a Sea Serpent died down there a hundred years ago and NEVER STOPPED. It's been spawning krakenlings from its own decay, poisoning the tide, raising the drowned. Eight krakenlings to clear the water, then the Serpent itself. Kill what's already dead. Make it stick this time.",
    outro:
      "Eight krakenlings cut down, the Serpent finally, truly, permanently DEAD. The tide's turned clean for the first time in a century — the fisherfolk wept, the drowned stopped walking, and the outer isles remembered how to just be islands. You killed the sea's longest grudge. Gold from the wreck. All of it. The sea won't miss it.",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // BONEYARD HUSBANDRY — gathering under the shadow of the dead
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_undead_purge_32',
    title: 'Herbs for the Warding Incense',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [{ kind: 'gather', target: 'herb_patch', need: 10, label: 'Pick 10 herb patches for the incense' }],
    rewards: { xp: { herbalism: 220 }, items: [{ id: 'herb_gold', qty: 2 }], blockCents: 40 },
    intro:
      "The incense keeps the lesser dead drowsy — a sleepy skeleton is a cooperative skeleton. But I'm out, and my supplier 'relocated' in the sense that I relocated him, to a plot, for unrelated reasons. Pick ten herb patches so I can roll a fresh batch. The dead sleep better when they smell nice. Don't we all.",
    outro:
      "Ten patches, enough incense to keep the whole plot drowsy through winter. The dead are dozing. Gerald's dozing. I might doze. You've bought this graveyard a quiet season, which is my favorite kind. Gold herb — the rare stuff. For the incense you'll say no to and I'll insist on. Take it.",
  },
  {
    id: 'q_undead_purge_33',
    title: 'Grave-Mushrooms',
    giver: 'herbalist_moss',
    regionId: 'greenwood',
    steps: [
      { kind: 'gather', target: 'mushroom_cluster', need: 8, label: 'Harvest 8 grave-mushroom clusters' },
      { kind: 'kill', target: 'gloomhound', need: 5, label: 'Shoo off 5 gloomhounds guarding them' },
    ],
    rewards: { xp: { herbalism: 200, attack: 120 }, items: [{ id: 'mushroom_brown', qty: 6 }, { id: 'potion_regret', qty: 1 }], blockCents: 50 },
    intro:
      "There's a mushroom that only grows where the dead have lain, and wouldn't you know it, the Greenwood's got a new crop thanks to all the undead foot traffic. Eight clusters for my research. Catch is, gloomhounds have claimed the patch. Shoo off five. 'Shoo' is a strong word for what you'll do.",
    outro:
      "Eight clusters, five hounds 'shooed', and a research breakthrough I'll pretend I understand. These grave-mushrooms do SOMETHING to the dead — I'll know more once I've eaten one, which my guild has strongly advised against, so soon. Brown mushrooms, the edible sort. Don't mix them up. I almost always do.",
  },
  {
    id: 'q_undead_purge_34',
    title: 'Fishing in the Dead Pool',
    giver: 'prospector_finn',
    regionId: 'ironhold',
    steps: [{ kind: 'gather', target: 'fishing_spot', need: 12, label: 'Fish the dead pool 12 times' }],
    rewards: { xp: { fishing: 240 }, items: [{ id: 'fish_raw', qty: 4 }, { id: 'food_jerky', qty: 1 }], blockCents: 45 },
    intro:
      "There's a pool up the mountain where the drowned used to gather. They've moved on — mostly — and the fish that are left are... big. Too big. Fed on something I don't want named. Fish it twelve times. Whatever surfaces, bring it up. I'll decide if it's dinner or evidence.",
    outro:
      "Twelve casts and — these are definitely fish. Definitely. The eyes are fine. The teeth are a choice but the eyes are fine. We'll cook them thoroughly and never speak of the teeth. Raw fish for you, and jerky in case you lose your nerve, which, having seen the teeth, I'd understand.",
  },
  {
    id: 'q_undead_purge_35',
    title: 'Cursed Timber',
    giver: 'npc_forgotten_smith',
    regionId: 'forgotten',
    steps: [
      { kind: 'gather', target: 'oak_tree', need: 8, label: 'Fell 8 oaks from the haunted grove' },
      { kind: 'kill', target: 'ash_spectre', need: 6, label: 'Banish 6 ash spectres that haunt the grove' },
    ],
    rewards: { xp: { woodcutting: 260, attack: 120 }, items: [{ id: 'wood_oak', qty: 6 }, { id: 'bar_iron', qty: 2 }], blockCents: 60 },
    intro:
      "I need oak from the old grove — best timber in the Forgotten Lands, and it's CHEAP, because the grove is haunted and nobody'll go near it. Eight trees. The ash spectres between you and the wood come free of charge; banish six of them while you're at it. Haunted lumber builds character. And doors that occasionally scream. Mostly character.",
    outro:
      "Eight oaks, six spectres banished, a full cord of only-mildly-cursed timber. The wood'll settle down once it's cut and dried — the screaming usually stops by spring. Usually. Take your share of the oak and some iron for the trouble. You smell like a haunted forest, which here passes for cologne.",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // REVENANT ROW — the rust-and-bone frontier (forgotten / frontier)
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_undead_purge_36',
    title: 'The Rust Walkers',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'revenant_rust', need: 10, label: 'Dismantle 10 rusted revenants' }],
    rewards: { xp: { attack: 400, defense: 180 }, items: [{ id: 'bar_steel', qty: 3 }], blockCents: 90 },
    intro:
      "I moved to the edge of the world to avoid PEOPLE. Nobody warned me about the people who USED to be people. Rusted revenants — old soldiers, armor fused to bone — have started a slow, creaking patrol past my hermitage. Ten of them, dismantled. The creaking. Every night. THE CREAKING. Make it stop.",
    outro:
      "Ten revenants, dismantled, the creaking SILENCED. I slept. Actual sleep, no armor-shuffle soundtrack. You've given me the one thing I crave more than solitude, which is QUIET solitude. Steel from their frames. I kept a bolt as a trophy, which I'll deny if asked. Now go. Fondly. Go.",
  },
  {
    id: 'q_undead_purge_37',
    title: 'Hound of the Gloom',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'gloomhound', need: 8, label: 'Put down 8 gloomhounds' },
      { kind: 'kill', target: 'gloom_imp', need: 6, label: 'Banish 6 gloom imps riding them' },
    ],
    rewards: { xp: { attack: 460, magic: 200 }, items: [{ id: 'hide_tough', qty: 3 }, { id: 'crystal_shard', qty: 1 }], blockCents: 110 },
    intro:
      "The gloomhounds are back and this time they've got PASSENGERS. Gloom imps, riding them like tiny vile jockeys, steering the pack straight through my vegetable garden. Eight hounds, six imps. I grew those turnips from SEED, in SPITE, and I will have my vengeance by proxy. You're the proxy. Thank you. Don't make it weird.",
    outro:
      "Eight hounds down, six imps banished, the turnips AVENGED. What's left of the garden is mostly holes, but they're PEACEFUL holes now. You've done a hermit a kindness, which obligates me to you, which I HATE, so take this tough hide and this crystal and let's call the ledger clear. Clear. Done. Goodbye.",
  },
  {
    id: 'q_undead_purge_38',
    title: 'The Wight on the Hill',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'barrow_wight', need: 7, label: 'Still 7 barrow wights on the frontier' }],
    rewards: { xp: { attack: 500, defense: 240 }, items: [{ id: 'bar_gold', qty: 1 }, { id: 'crystal_shard', qty: 2 }], blockCents: 130 },
    intro:
      "There's a hill past my hermitage — out on the frontier, where the maps give up and just write 'here be the usual nonsense'. Barrow wights have claimed it, and at night they GLOW and they CHANT and it is, frankly, derivative. Seven of them, stilled. If the dead are going to haunt near me, they could at least be ORIGINAL about it.",
    outro:
      "Seven wights stilled, the hill gone dark and blessedly silent. The frontier reclaims a little of itself tonight. You've a talent for persuading the dead to lie back down, which is a grim resume but an in-demand one out here. Gold, shards. Spend them somewhere with LIVING people. One of us should.",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // SWARM SEASON — undead insects and the things that eat them
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_undead_purge_39',
    title: 'The Grave Beetles',
    giver: 'npc_greenwood_beastmaster_oona',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'beetle_dung', need: 14, label: 'Crush 14 grave-fed dung beetles' }],
    rewards: { xp: { attack: 160 }, items: [{ id: 'hide_wolf', qty: 2 }], blockCents: 30 },
    intro:
      "Dung beetles. Normally I'd say leave them be — they're nature's cleanup crew, bless their revolting little hearts. But these ones have been feeding on the UNDEAD, and now they're rolling around balls of something that glows and twitches. Fourteen of them. The cleanup crew needs cleaning up.",
    outro:
      "Fourteen beetles, crushed, their horrible little glowing projects abandoned. Nature can resume its regularly scheduled disgustingness. You didn't flinch once, which tells me you've either seen worse or you've stopped feeling things. Both are useful out here. Hide's yours.",
  },
  {
    id: 'q_undead_purge_40',
    title: 'Mantis of the Mausoleum',
    giver: 'npc_greenwood_beastmaster_oona',
    regionId: 'greenwood',
    steps: [
      { kind: 'kill', target: 'mantis_blade', need: 9, label: 'Cut down 9 blade mantises' },
      { kind: 'kill', target: 'centipede_bog', need: 8, label: 'Crush 8 bog centipedes' },
    ],
    rewards: { xp: { attack: 280, archery: 120 }, items: [{ id: 'hide_tough', qty: 2 }, { id: 'potion_regret', qty: 1 }], blockCents: 55 },
    intro:
      "The old mausoleum's grown a GARDEN of horrors. Blade mantises stalk the pillars and bog centipedes nest in the cracks, all of them fattened on grave-rot. Nine mantises, eight centipedes. Bring a long weapon. Bring a LONGER one. Whatever you're thinking, longer.",
    outro:
      "Nine mantises, eight centipedes, the mausoleum garden pruned down to just the usual creeping dread. You handled the long end of a very bad situation. Tough hide and a potion — drink the potion, you've got the thousand-yard stare of someone who counted a centipede's legs mid-swing.",
  },
  {
    id: 'q_undead_purge_41',
    title: 'Wasps That Won\'t Die',
    giver: 'npc_greenwood_herbwife_tansy',
    regionId: 'greenwood',
    steps: [
      { kind: 'kill', target: 'wasp_hornet', need: 12, label: 'Burn out 12 undead hornets' },
      { kind: 'collect', target: 'herb_gold', need: 4, label: 'Collect 4 gold herbs for the sting salve' },
    ],
    rewards: { xp: { attack: 240, herbalism: 160 }, items: [{ id: 'food_honey', qty: 3 }], blockCents: 50 },
    intro:
      "The hornets built a nest in a dead oak and then — this is the part I hate — the hornets DIED and kept the nest running anyway. Undead hornets. They don't even make honey, they just make GRUDGES. Burn out twelve and bring four gold herbs for the salve, because you WILL get stung, and the sting from a dead hornet lingers like a bad review.",
    outro:
      "Twelve hornets burned, the grudge-nest cold, four gold herbs for the salve. Here's a jar of real honey from a nest of LIVING bees down the valley — a reminder that not everything with wings is out to ruin your week. Just most things. Just here. Eat the honey. You've earned something sweet.",
  },
  {
    id: 'q_undead_purge_42',
    title: 'The Locust Shroud',
    giver: 'farmer_bram',
    regionId: 'beginnings',
    steps: [
      { kind: 'kill', target: 'locust_swarm', need: 16, label: 'Scatter 16 grave-locust swarms' },
      { kind: 'gather', target: 'farm_plot', need: 6, label: 'Replant 6 ruined farm plots' },
    ],
    rewards: { xp: { attack: 180, farming: 200 }, items: [{ id: 'wheat', qty: 6 }, { id: 'food_pie', qty: 2 }], blockCents: 55 },
    intro:
      "Locusts. Fine. Locusts I can handle. But these came up out of the OLD burial field, and they don't eat the wheat, they WITHER it — walk over a row and it just gives up, like it's heard bad news. Sixteen swarms scattered, then help me replant six plots. My wheat has standards. The locusts offended them.",
    outro:
      "Sixteen swarms scattered, six plots replanted, the wheat cautiously optimistic again. The old burial field's gone quiet, which I'll take and not investigate, because investigating is how you END UP in a burial field. Wheat and pie. The pie's from the GOOD wheat. Don't tell the new crop.",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // THE EXORCIST'S LADDER — mage_lyra's escalating cursed-loot chain (cont.)
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_undead_purge_43',
    title: 'The Cog That Ticks With No One Winding It',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'cog_sprite', need: 10, label: 'Still 10 cursed cog sprites' },
      { kind: 'kill', target: 'clockwork_knight', need: 4, label: 'Shut down 4 clockwork knights' },
    ],
    rewards: { xp: { magic: 500, attack: 220 }, items: [{ id: 'bar_steel', qty: 3 }, { id: 'crystal_cut', qty: 1 }], blockCents: 130 },
    intro:
      "A collector left me a 'self-winding reliquary'. It is, in fact, a HAUNTED one — a dead artificer's soul got wound into the gears and now cog sprites and clockwork knights pour out of it, all ticking to a heartbeat that stopped in the previous century. Still ten sprites, shut down four knights, and let the poor dead gearhead finally rest.",
    outro:
      "Ten sprites stilled, four knights shut down, the reliquary ticking at last to nothing at all. Somewhere a dead artificer exhaled a century-late breath. You can hear it in the quiet, if you believe in that sort of thing, which I didn't until I started collecting cursed clocks. Steel and crystal. Go.",
  },
  {
    id: 'q_undead_purge_44',
    title: 'The Portrait That Blinks',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'mirror_golem', need: 6, label: 'Shatter 6 portrait-born mirror golems' },
      { kind: 'kill', target: 'prism_drone', need: 8, label: 'Dispel 8 prism drones' },
    ],
    rewards: { xp: { magic: 560, attack: 240 }, items: [{ id: 'crystal_cut', qty: 3 }], blockCents: 150 },
    intro:
      "I acquired a portrait of a nobleman long dead. It blinks. It's been blinking for a WEEK, and now it's spawning mirror golems that wear his face and prism drones that scatter his stare into every reflective surface in the wing. I can't SHAVE without an audience. Six golems, eight drones, and let the man STOP WATCHING ME.",
    outro:
      "Six golems shattered, eight drones dispelled, the portrait gone back to being an unsettling but INERT piece of art. I can shave in peace. The nobleman's eyes are just paint again. Cut crystals, three of them — they came out of the golems and they do NOT blink, I checked, repeatedly, which is its own problem for another day.",
  },
  {
    id: 'q_undead_purge_45',
    title: 'The Crown Nobody Should Wear',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'boneknight_cursed', need: 6, label: 'Fell 6 boneknights drawn to the crown' },
      { kind: 'kill', target: 'lich_frost', need: 2, label: 'Shatter 2 frost liches reaching for it' },
      { kind: 'gather', target: 'crystal_node', need: 6, label: 'Mine 6 crystal nodes to seal the crown' },
    ],
    rewards: { xp: { magic: 720, attack: 360, mining: 200 }, items: [{ id: 'bar_gold', qty: 2 }, { id: 'crystal_cut', qty: 3 }], blockCents: 220 },
    intro:
      "Someone donated a crown to my collection. A DEAD KING'S crown. It's calling things — boneknights that want to serve it, frost liches that want to WEAR it — and I need it sealed before it finishes rebuilding a court in my east wing. Six boneknights, two liches, and six crystal nodes to forge the seal. This is the dumbest heirloom anyone has ever given me and I've been given a screaming amulet.",
    outro:
      "Six boneknights felled, two liches shattered, the crown sealed in crystal where it can call all it likes to NO ONE. The east wing is mine again, unmonarched. You've done the realm a favor it'll never know about, saving it from a king it never elected. Gold and crystal. The crown stays in the vault. Forever. We agree on forever.",
  },
  {
    id: 'q_undead_purge_46',
    title: 'The Reliquary of the Frost Lich',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'lich_frost', need: 4, label: 'Shatter 4 frost liches' },
      { kind: 'kill', target: 'wyrm_bone', need: 1, label: 'Destroy the Bone Wyrm the reliquary summoned' },
    ],
    rewards: { xp: { magic: 940, attack: 480, vitality: 400 }, items: [{ id: 'bar_gold', qty: 4 }, { id: 'crystal_cut', qty: 4 }], blockCents: 340 },
    intro:
      "The crown was a WARNING. The reliquary it came from has cracked open, and what's inside is worse than a king — it's the phylactery of an ARCH-lich, and it's summoning a Bone Wyrm to defend itself: a dragon of welded skeletons, every one a soul it stole. Shatter four lesser liches, then kill the Wyrm and shatter the phylactery for good. This is the one, hero. This is the bottom of the cursed-loot ladder. Don't look down.",
    outro:
      "Four liches shattered, the Bone Wyrm UNMADE — every stolen soul loosed from its welded frame at last, drifting up and out and finally, FINALLY free. The phylactery is dust. My cursed-loot collection is, I think, done; I'm taking up something safe, like pottery, or screaming into a field. You didn't just exorcise an artifact. You emptied a graveyard that walked. Gold. Crystal. My genuine, undisguised respect — spend that one carefully. It's the rarest thing I own.",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // DRAGONS OF THE DEAD — the apex undead chain (prophet_karl, frontier)
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_undead_purge_47',
    title: 'Wyrmlings in the Ash',
    giver: 'prophet_karl',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'wyrmling_ember', need: 10, label: 'Stamp out 10 ember wyrmlings' }],
    rewards: { xp: { attack: 440, magic: 220 }, items: [{ id: 'bar_gold', qty: 1 }, { id: 'hide_tough', qty: 2 }], blockCents: 120 },
    intro:
      "New vision. Clearer than I'd like. The ashen drakes have been nesting in the old pyres, and their wyrmlings hatch already half-dead, half-burning, wholly furious. Ten of them, stamped out before they GROW. A wyrmling is a problem. What a wyrmling becomes is a catastrophe with a wingspan.",
    outro:
      "Ten wyrmlings stamped out, ten catastrophes un-winged before they started. The vision thanks you, insofar as a vision thanks anyone, which is by showing me slightly fewer disasters. Gold, hide. There's more in the nests above — bigger things, older things. We'll get there. We always get there. That's the curse of seeing ahead.",
  },
  {
    id: 'q_undead_purge_48',
    title: 'The Ash Drake\'s Hoard',
    giver: 'prophet_karl',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'drake_ash', need: 6, label: 'Slay 6 ash drakes' },
      { kind: 'gather', target: 'gold_vein', need: 5, label: 'Reclaim 5 gold veins from their hoard' },
    ],
    rewards: { xp: { attack: 560, mining: 220 }, items: [{ id: 'bar_gold', qty: 2 }, { id: 'ore_gold', qty: 4 }], blockCents: 160 },
    intro:
      "The ash drakes have a hoard, and like all undead they hoard WRONG — not treasure, but bones, and the gold veins they've smothered under their nests. Six drakes slain, five gold veins reclaimed from the pile. The vision says the gold matters. The vision won't say WHY. The vision's a tease like that.",
    outro:
      "Six drakes slain, five veins reclaimed, the hoard picked clean of the smothered gold. The vision clarifies: you'll NEED this gold for what's coming, to forge something, to pay something, I can't quite — it's gone fuzzy, which means it's important and unpleasant. Gold and ore. Hold onto it. Trust the fuzzy visions. They're the honest ones.",
  },
  {
    id: 'q_undead_purge_49',
    title: 'The Rime Wyvern',
    giver: 'prophet_karl',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'wyvern_glacier', need: 4, label: 'Down 4 glacier wyverns' },
      { kind: 'kill', target: 'wyrm_permafrost', need: 2, label: 'Slay 2 permafrost wyrms' },
    ],
    rewards: { xp: { attack: 720, defense: 320, magic: 300 }, items: [{ id: 'bar_gold', qty: 3 }, { id: 'crystal_cut', qty: 2 }], blockCents: 240 },
    intro:
      "The vision has gone COLD — literally, I woke with frost on my eyelashes. Out on the frontier, the dead dragons of the ice are stirring: glacier wyverns and permafrost wyrms, things that died frozen and stayed angry at the thaw. Four wyverns, two wyrms. The cold ones are patient. You can't be. Go now, before the frost reaches the vision's edge.",
    outro:
      "Four wyverns down, two wyrms slain, the frost retreating from my eyelashes and from the vision both. You move faster than the cold, which is the only speed that survives the frontier. Gold and crystal — and a warning the vision WILL let me share: what's coming next isn't a dead dragon. It's THE dead dragon. Rest. You'll know when it's time. We all will.",
  },
  {
    id: 'q_undead_purge_50',
    title: 'The Obsidian Dragon',
    giver: 'prophet_karl',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'wyrm_bone', need: 3, label: 'Unmake 3 bone wyrms of its honor-flight' },
      { kind: 'kill', target: 'dragon_obsidian', need: 1, label: 'Slay the Obsidian Dragon, the dead apex of the ashlands' },
    ],
    rewards: { xp: { attack: 999, vitality: 720, magic: 600, defense: 500 }, items: [{ id: 'bar_gold', qty: 5 }, { id: 'crystal_cut', qty: 5 }], blockCents: 500 },
    intro:
      "This is the vision I've been dreading since the first crack in the world: the Obsidian Dragon. The apex of every dead thing in the ashlands — it died in the first age and has been PATIENT ever since, gathering wyrms, drakes, revenants, waiting for the realm to grow soft. It's done waiting. Three bone wyrms guard its flight; unmake them, then face the Dragon itself. Everything you've killed, everything you've buried, everything you've exorcised — it was ALL training for this. The vision ends here. I cannot see past you. Nobody can. Go and make the future yourself.",
    outro:
      "It's dead. The Obsidian Dragon — the oldest dead thing in the world — is DEAD, truly, finally, the way nothing out here has been dead in an age. I watched the obsidian crack and the darkness pour out and up and GONE, and for the first time in my life the vision showed me nothing but DAWN. You've done what prophecy itself couldn't: you ended it. The dead can rest. The living can breathe. And I — I think I'll finally get some SLEEP. Take the gold, the crystal, all of it. You didn't save the realm from a monster. You gave the dead permission to STAY dead. There's no reward in any vault for that. There's just this: thank you. From all of them. From all of us.",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // GRAVE MAINTENANCE — Sol's endless side-work (ashen, short tasks)
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_undead_purge_51',
    title: 'The Moths Came Back',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'deathmoth_pale', need: 15, label: 'Swat 15 returning deathmoths' }],
    rewards: { xp: { attack: 240 }, items: [{ id: 'food_jerky', qty: 2 }], blockCents: 45 },
    intro:
      "They're back. The deathmoths. I KNEW it was too quiet — quiet out here is just the dead holding their breath. Fifteen this time, drawn by the fresh graves from your OWN excellent work, which is a little ironic, and I've decided not to dwell on it. Swat them. Again. The job is never done. The job is a lifestyle.",
    outro:
      "Fifteen moths, swatted, the lanterns clear for now. 'For now' is the longest promise this place keeps. You keep coming back, and the dead keep coming back, and between us we've achieved a sort of EQUILIBRIUM. Jerky. Same as last time. The menu here is as eternal as the clientele.",
  },
  {
    id: 'q_undead_purge_52',
    title: 'Gravecrawler Season, Part the Infinite',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'gravecrawler', need: 12, label: 'Re-bury 12 gravecrawlers' },
      { kind: 'kill', target: 'ghoul_grave', need: 8, label: 'Put down 8 grave ghouls' },
    ],
    rewards: { xp: { attack: 320, defense: 140 }, items: [{ id: 'bar_iron', qty: 3 }], blockCents: 60 },
    intro:
      "Twelve crawlers, eight ghouls. I won't dress it up — it's the same work as always, the same plots, the same ooze on the same boots. But the alternative is letting the graveyard win, and I've been losing to a graveyard my whole life. Not today. Today we hold the line. The DIRT line. Which I rake. Daily. Forever.",
    outro:
      "Twelve crawlers, eight ghouls, the line held one more day. You and me, friend — we're the only reason this place is a graveyard and not a MOB. Gerald knows it. The flowers know it. I know it. Iron's yours. See you tomorrow. There's always a tomorrow. That's the whole horror of the job.",
  },
  {
    id: 'q_undead_purge_53',
    title: 'The Headstone Thief',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'corpse_imp', need: 10, label: 'Snuff 10 corpse imps hauling off headstones' },
      { kind: 'gather', target: 'clay_pit', need: 5, label: 'Dig 5 clay pits to mold new markers' },
    ],
    rewards: { xp: { attack: 280, mining: 120 }, items: [{ id: 'clay_lump', qty: 5 }, { id: 'food_pie', qty: 1 }], blockCents: 55 },
    intro:
      "Corpse imps have been STEALING the headstones. Hauling them off to build — I don't know, a FORT, a shrine, an imp timeshare, I didn't ask, I was too busy being furious. Those stones have NAMES on them. Snuff ten imps and dig five clay pits so I can mold replacements. Every grave gets a marker. That's the ONE rule. That's the whole job.",
    outro:
      "Ten imps snuffed, their little stone fort dismantled, five pits of good clay for new markers. Every grave will have its name again by week's end. You understand it, don't you — it's not about the dead CARING. It's about US caring. For them. When no one else will. Clay's yours, and pie. Go. The molds won't fill themselves. I'll do that part. It's the part I like.",
  },
  {
    id: 'q_undead_purge_54',
    title: 'Whatever\'s In the Well',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [
      { kind: 'explore', target: 'ashen', need: 1, label: 'Investigate the old graveyard well' },
      { kind: 'kill', target: 'bogleech', need: 10, label: 'Drain 10 bogleeches from the well' },
      { kind: 'kill', target: 'drownedman', need: 4, label: 'Still 4 drowned things that climbed out' },
    ],
    rewards: { xp: { attack: 400, magic: 180 }, items: [{ id: 'crystal_shard', qty: 2 }, { id: 'potion_regret', qty: 1 }], blockCents: 90 },
    intro:
      "There's a well at the back of the plot. I stopped drawing water from it YEARS ago, for reasons I filed under 'the well'. Now something's climbing OUT of it at night — bogleeches, and worse, the drowned. Go look. Drain ten leeches, still four of the climbers, and tell me what's down there. Actually, don't tell me. Just make it stop being down there.",
    outro:
      "Ten leeches drained, four climbers stilled, and you — bless you — did NOT tell me what's at the bottom. Some mercies are in the NOT knowing, and you knew that, which is why you're the only help I keep. I've bricked the well. We never mention the well. Crystal and a potion for the nerves. Mine or yours, take your pick. There's enough nerves to go around.",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // SCATTERED PURGES — one-off undead cleanup across every region
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_undead_purge_55',
    title: 'The Honored Dead Dishonor the Lawn',
    giver: 'npc_beginnings_tobias',
    regionId: 'beginnings',
    steps: [{ kind: 'kill', target: 'skeleton', need: 10, label: 'Re-retire 10 skeletons' }],
    rewards: { xp: { attack: 160, defense: 60 }, items: [{ id: 'food_jerky', qty: 2 }], blockCents: 30 },
    intro:
      "The war memorial's acting up. We built it to HONOR the fallen, and the fallen have repaid us by GETTING UP and tromping through the petunias in full ceremonial armor. Ten of them, back to honored rest. It's not disrespectful if you do it RESPECTFULLY. I've decided. Go. Salute them first if it helps you sleep.",
    outro:
      "Ten honored dead, re-honored, lying back down with dignity and only slightly trampled petunias. We'll replant. We always replant. The memorial's a memorial again, instead of a parade ground. You saluted, didn't you. You did. Good lad. Jerky. The dead don't eat. More for you.",
  },
  {
    id: 'q_undead_purge_56',
    title: 'The Fox That Isn\'t a Fox Anymore',
    giver: 'npc_greenwood_beastmaster_oona',
    regionId: 'greenwood',
    steps: [
      { kind: 'kill', target: 'tundra_fox', need: 6, label: 'Put down 6 blight-touched foxes' },
      { kind: 'kill', target: 'gravecrawler', need: 8, label: 'Re-bury 8 gravecrawlers infecting them' },
    ],
    rewards: { xp: { attack: 240, archery: 100 }, items: [{ id: 'hide_tough', qty: 3 }], blockCents: 50 },
    intro:
      "The foxes have caught something. The gravecrawlers oozed up into the warrens and now the foxes are — wrong. Blight-touched. They don't hunt, they SHAMBLE, and it breaks my heart because I LIKE foxes, I like them better than most people. Put down six, clear eight crawlers at the source. Mercy, dressed as violence. The usual outfit out here.",
    outro:
      "Six foxes put down, eight crawlers cleared, the warrens cleansed before the blight could spread to the whole wood. It's a mercy. I keep telling myself it's a mercy. It IS a mercy. Tough hide — from the crawlers, not the foxes, I'd never, don't even LOOK at me. Go. I need a moment with the warren.",
  },
  {
    id: 'q_undead_purge_57',
    title: 'The Boar That Wouldn\'t Lie Down',
    giver: 'ranger_kael',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'dire_boar', need: 5, label: 'Finally down 5 risen dire boars' }],
    rewards: { xp: { attack: 320, defense: 140 }, items: [{ id: 'hide_boar', qty: 4 }], blockCents: 60 },
    intro:
      "I shot a dire boar last week. Clean shot, good shot, down it went. Then it GOT BACK UP. The blight from the ashlands has crept this far north, and now five dire boars are stomping the Greenwood that are, technically, deceased. Down them again. Harder. Aim for whatever's keeping them UP, not just alive.",
    outro:
      "Five boars downed, and this time they STAYED down — you found the trick of it, didn't you, the second death that takes. I've been shooting the same boars for a week; you ended it in an afternoon. Boar hide, the good tough kind, from a boar that's finally RESTING. Take it. Teach me that trick sometime. Actually, don't. I'd rather not need it.",
  },
  {
    id: 'q_undead_purge_58',
    title: 'The Bruin at the Barrow',
    giver: 'npc_forgotten_beastward',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'grizzled_bruin', need: 4, label: 'Put down 4 barrow-blighted bruins' },
      { kind: 'kill', target: 'barrow_wight', need: 5, label: 'Still 5 wights that raised them' },
    ],
    rewards: { xp: { attack: 440, defense: 200 }, items: [{ id: 'hide_tough', qty: 3 }, { id: 'bar_steel', qty: 1 }], blockCents: 90 },
    intro:
      "The barrow wights out on the frontier have taken to RAISING the local wildlife — grizzled bruins, the big mean ones, now bigger and meaner and DEAD. Four bruins put down, five wights stilled at the source. A living bruin is a bad afternoon. A dead one is a bad WEEK. Go have the afternoon so nobody has the week.",
    outro:
      "Four bruins down, five wights stilled, the frontier wildlife returned to merely wanting to kill you for the normal reasons. The wights can't raise what they can't reach, and they can't reach anything now. Tough hide and steel. You smell like a dead bear, which is a specific smell, and an earned one. Go wash it off somewhere civilized. If you can find somewhere civilized. Out here. Good luck.",
  },
  {
    id: 'q_undead_purge_59',
    title: 'Hyenas of the Bone Pit',
    giver: 'npc_forgotten_beastward',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'savanna_hyena', need: 10, label: 'Scatter 10 bone-pit hyenas' }],
    rewards: { xp: { attack: 300 }, items: [{ id: 'hide_wolf', qty: 4 }], blockCents: 55 },
    intro:
      "There's a bone pit out past the dunes where the dead things end up, and the savanna hyenas have made it a HOME. They eat the undead and — surprise — they're catching it, turning patchy and wrong and LAUGHING in a way that stopped being funny three nights ago. Ten of them, scattered, before the whole pack turns. The laughing. Make the laughing stop.",
    outro:
      "Ten hyenas scattered, the laughing silenced, the bone pit left to the bones where it belongs. A pack that eats the dead becomes the dead — there's a lesson there, and I'll let someone with more time ponder it. Hide's yours. If you hear laughing on the way out, walk faster. Don't look. It's never worth the look.",
  },
  {
    id: 'q_undead_purge_60',
    title: 'The Stag of Thorns and Bone',
    giver: 'scout_wren',
    regionId: 'greenwood',
    steps: [
      { kind: 'kill', target: 'horned_stag', need: 4, label: 'Down 4 risen horned stags' },
      { kind: 'collect', target: 'herb_red', need: 5, label: 'Gather 5 red herbs to cleanse the glade' },
    ],
    rewards: { xp: { attack: 360, herbalism: 140 }, items: [{ id: 'hide_tough', qty: 2 }, { id: 'potion_regret', qty: 1 }], blockCents: 70 },
    intro:
      "The old stags of the deep glade have risen — antlers grown through with thorns and bone, eyes like cold lanterns. They were MAGNIFICENT in life and they're an abomination in death, and I hate that the blight took THEM, of all the Greenwood's creatures. Down four. Gather five red herbs to cleanse the glade after. Give them that much, at least. A clean glade to not-haunt.",
    outro:
      "Four stags downed, the glade cleansed with red-herb smoke, the thorns already withering now that the blight's broken. They were magnificent. They'll be magnificent again, in some spring I won't see, when the glade grows new stags that don't glow. Tough hide and a potion. Sit with me a minute before you go. The glade's worth a minute. They were worth more.",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // IRONHOLD CRYPTS — the deep-dead beneath the mountain
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_undead_purge_61',
    title: 'The Miners Who Didn\'t Come Up',
    giver: 'npc_ironhold_deepwarden_hale',
    regionId: 'ironhold',
    steps: [{ kind: 'kill', target: 'revenant_rust', need: 9, label: 'Lay to rest 9 risen miners' }],
    rewards: { xp: { attack: 360, mining: 120 }, items: [{ id: 'bar_iron', qty: 4 }], blockCents: 70 },
    intro:
      "A cave-in sealed shaft nine forty years ago with eleven miners still inside. We mourned. We moved on. We DID NOT expect them to dig their way back out, rusted picks still in hand, still swinging, still 'working the seam' with an enthusiasm that frankly none of them had in LIFE. Nine of them, laid to rest. They've done enough overtime. Tell them the shift is over. Then make it over.",
    outro:
      "Nine miners laid to rest, their forty-year overtime finally clocked out. We'll seal shaft nine again, properly this time, with names on the stone and a prayer over the brick. They dug their way out looking for a shift that ended before you were born. You gave them the end of it. Iron's yours. They'd have wanted a working man to have it.",
  },
  {
    id: 'q_undead_purge_62',
    title: 'The Thing in the Crystal Seam',
    giver: 'npc_ironhold_deepwarden_hale',
    regionId: 'ironhold',
    steps: [
      { kind: 'kill', target: 'crystal_sentinel', need: 6, label: 'Shatter 6 corrupted crystal sentinels' },
      { kind: 'gather', target: 'crystal_node', need: 6, label: 'Harvest 6 clean crystal nodes' },
    ],
    rewards: { xp: { attack: 440, mining: 220 }, items: [{ id: 'crystal_raw', qty: 5 }, { id: 'crystal_shard', qty: 2 }], blockCents: 100 },
    intro:
      "We mined into a crystal seam and woke something that's been SLEEPING in it. Now crystal sentinels prowl the deep gallery, and the crystal itself has gone WRONG — it hums at a pitch that makes the miners weep and the lanterns gutter. Shatter six sentinels, harvest six CLEAN nodes from the untainted seam. We'll study the clean stuff. The tainted stuff we leave for the dark.",
    outro:
      "Six sentinels shattered, six clean nodes harvested, the gallery's weeping-pitch silenced. Whatever slept in the seam is rubble now, and rubble doesn't dream. The miners have stopped crying, which for miners is practically singing. Raw crystal and shards — the CLEAN kind, I triple-checked, I'm not sending anyone home with a cursed rock. Not again. Long story. Take it and go.",
  },
  {
    id: 'q_undead_purge_63',
    title: 'The Colossus of Tombs',
    giver: 'npc_ironhold_deepwarden_hale',
    regionId: 'ironhold',
    steps: [
      { kind: 'kill', target: 'boneknight_cursed', need: 8, label: 'Fell 8 boneknights guarding the deep tomb' },
      { kind: 'kill', target: 'tomb_colossus', need: 1, label: 'Bring down the Tomb Colossus' },
    ],
    rewards: { xp: { attack: 820, defense: 440, mining: 260 }, items: [{ id: 'bar_gold', qty: 3 }, { id: 'crystal_cut', qty: 3 }], blockCents: 240 },
    intro:
      "At the very bottom of the mountain, past shaft nine, past the crystal seam, there's a TOMB — older than the mine, older than Ironhold, older than the maps. And it's WAKING. A Tomb Colossus, a mountain of welded dead, guarded by eight boneknights, is standing up for the first time in an age. If it reaches the shafts it'll bring the whole mountain down. Fell the knights. Bring down the Colossus. Keep the mountain UP. That's the whole job, and it's a big one.",
    outro:
      "Eight knights felled, the Tomb Colossus brought DOWN, the mountain held. You went to the bottom of the world and the bottom of the world BLINKED FIRST. Ironhold stands because you stood between it and a tomb that wanted to swallow it. We'll brick the tomb. We'll name the shaft after you. And we'll never, EVER dig that deep again. Gold and crystal. You've earned the mountain's respect, and the mountain is a hard grader. Harder than me, even.",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // THE RECKONING — demon-lord capstone (npc_ashen_warden, ashen)
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_undead_purge_64',
    title: 'The Char Drake\'s Roost',
    giver: 'npc_ashen_warden',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'char_drake', need: 6, label: 'Slay 6 char drakes' }],
    rewards: { xp: { attack: 500, defense: 220 }, items: [{ id: 'bar_gold', qty: 2 }, { id: 'hide_tough', qty: 2 }], blockCents: 130 },
    intro:
      "The demon front has air support now. Char drakes — half-dragon, half-nightmare, all teeth — have roosted in the smoking crags above the threshold and they STRAFE anything that moves. Six of them, out of the sky. I can hold a line against things that walk. Things that FLY are above my pay grade, and above my literal position, which they keep setting on fire.",
    outro:
      "Six char drakes, grounded permanently, the crags gone quiet. I can hold the LINE again, now that the line isn't on fire from above. You've a knack for reaching the unreachable — I don't know how you got up to those roosts and I've decided the answer would only upset me. Gold and hide. The front holds. For now. 'For now' is the only tense this place has.",
  },
  {
    id: 'q_undead_purge_65',
    title: 'The Brimstone Fiend Lord',
    giver: 'npc_ashen_warden',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'brimstone_fiend', need: 10, label: 'Banish 10 brimstone fiends' },
      { kind: 'kill', target: 'balor_spawn', need: 6, label: 'Cut down 6 balor spawn' },
    ],
    rewards: { xp: { attack: 680, magic: 320, defense: 300 }, items: [{ id: 'bar_gold', qty: 3 }, { id: 'crystal_cut', qty: 2 }], blockCents: 200 },
    intro:
      "The fiends have crowned a LORD. One of the brimstone fiends grew fat on the incursion and now it commands the rest, flanked by balor spawn, building toward something I don't want to witness. Ten fiends, six spawn — thin the court before the coronation finishes. A demon with a title is a demon with AMBITIONS, and ambitions, out here, come with a body count. Go lower the count preemptively.",
    outro:
      "Ten fiends banished, six spawn cut down, the fiend-lord's court scattered before it could crown anything. No coronation. No title. Just ash, which is the only thing that should ever grow on the ashen front. You've bought the threshold another season of merely-terrible instead of catastrophic. Gold and crystal. Rest up. The REAL one's still coming. It's always still coming. That's the curse of holding a line — the line never ends.",
  },
  {
    id: 'q_undead_purge_66',
    title: 'The Balor at the Breach',
    giver: 'npc_ashen_warden',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'pit_brute', need: 10, label: 'Topple 10 pit brutes at the breach' },
      { kind: 'kill', target: 'dread_maw', need: 2, label: 'Seal 2 lesser dread maws' },
      { kind: 'gather', target: 'gold_vein', need: 8, label: 'Mine 8 gold veins to forge the breach-seal' },
    ],
    rewards: { xp: { attack: 900, defense: 500, magic: 400, mining: 300 }, items: [{ id: 'bar_gold', qty: 4 }, { id: 'crystal_cut', qty: 4 }], blockCents: 320 },
    intro:
      "This is it. The breach — the great wound the prophet's been seeing — has opened wide enough to march an ARMY through, and the demons are doing exactly that. Ten pit brutes hold it open, two lesser dread maws anchor it, and I need eight gold veins mined to forge a SEAL big enough to close it for good. Topple the brutes, seal the maws, bring the gold. We close the breach today, hero, or we don't get a tomorrow to close it in.",
    outro:
      "Ten brutes toppled, two maws sealed, eight veins of gold forged into a seal that CLOSED THE BREACH. The wound in the world is shut — scarred over in gold and spite and your own two hands. The demon army on the other side can march all it likes. The door is LOCKED. You didn't just hold the line today. You ERASED the thing the line was holding against. Gold and crystal, and the warden's full respect, freely given, no grudging about it. You've earned the version without the grudge. First one ever. Take it. Take all of it. You closed the breach. There's no 'for now' this time. It's just CLOSED.",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CONSECRATION — gathering + cleansing hybrids (varied regions)
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_undead_purge_67',
    title: 'Blessed Steel',
    giver: 'smith_orin',
    regionId: 'ironhold',
    steps: [
      { kind: 'gather', target: 'iron_vein', need: 8, label: 'Mine 8 iron veins for blessed blanks' },
      { kind: 'kill', target: 'skeleton', need: 10, label: 'Test the blanks on 10 skeletons' },
    ],
    rewards: { xp: { mining: 200, blacksmithing: 180, attack: 100 }, items: [{ id: 'bar_steel', qty: 4 }], blockCents: 70 },
    intro:
      "Everyone's fighting the dead these days and coming to ME for 'blessed steel', like I keep holy water in the QUENCHING trough. Fine. Mine eight iron veins and I'll forge you proper undead-cracking blanks, and then you'll TEST them on ten skeletons, because I don't ship anything I haven't seen bite. The dead are the quality control. Poetic, isn't it. No? Just me? Fine.",
    outro:
      "Eight veins, ten skeletons shattered on freshly-forged steel — that's a passed inspection in any language. The blanks hold an edge against bone, which is all anyone wants anymore. 'Blessed', they'll call it. It's not blessed. It's WELL MADE. There's a difference, and it's the whole difference. Steel bars, yours, properly tested. Go crack some more dead with them.",
  },
  {
    id: 'q_undead_purge_68',
    title: 'Grave-Salt and Gold Herb',
    giver: 'npc_greenwood_herbwife_tansy',
    regionId: 'greenwood',
    steps: [
      { kind: 'collect', target: 'herb_gold', need: 6, label: 'Collect 6 gold herbs for the consecration' },
      { kind: 'collect', target: 'herb_blue', need: 6, label: 'Collect 6 blue herbs for the binding' },
      { kind: 'kill', target: 'ash_spectre', need: 8, label: 'Test the mix on 8 ash spectres' },
    ],
    rewards: { xp: { herbalism: 280, magic: 160 }, items: [{ id: 'herb_gold', qty: 2 }, { id: 'potion_regret', qty: 2 }], blockCents: 65 },
    intro:
      "I'm brewing consecration powder — the stuff that makes a spectre think twice and a ghoul think once. It needs six gold herbs and six blue, ground with grave-salt I'm NOT telling you where I got. Then you'll test it on eight ash spectres, because an untested consecration is just expensive seasoning. If it works, they flinch. If it doesn't, you run. Either way I get data.",
    outro:
      "Six gold, six blue, eight spectres — and they FLINCHED, every one, which means the powder WORKS. Do you know how rare a working first batch is? I've got drawers full of 'expensive seasoning' that just annoyed the dead. This batch is gold. Here's gold herb to say thank you, and potions, because testing consecration powder is hard on the nerves, mine AND yours. Mostly yours. You did the spectres.",
  },
  {
    id: 'q_undead_purge_69',
    title: 'The Cook Who Feeds the Vigil',
    giver: 'npc_greenwood_cook_dill',
    regionId: 'greenwood',
    steps: [
      { kind: 'gather', target: 'farm_plot', need: 8, label: 'Harvest 8 plots for the vigil feast' },
      { kind: 'gather', target: 'berry_bush', need: 6, label: 'Pick 6 berry bushes' },
      { kind: 'kill', target: 'plague_rat', need: 10, label: 'Clear 10 plague rats from the larder' },
    ],
    rewards: { xp: { farming: 200, cooking: 200, attack: 80 }, items: [{ id: 'food_pie', qty: 4 }, { id: 'food_cake', qty: 1 }], blockCents: 60 },
    intro:
      "The whole region's pulling vigil shifts against the dead now, and an army fights on its STOMACH, which means it fights on ME. I need eight plots harvested and six berry bushes picked for a proper vigil feast — and the plague rats got into my larder AGAIN, so clear ten of those vile things before they ruin the flour. Nobody fights the undead on an EMPTY stomach. That's just two horrors at once.",
    outro:
      "Eight plots, six bushes, ten rats evicted from my flour — now THAT'S a vigil feast. The guards'll eat like kings tonight and fight like devils tomorrow, and it's all because somebody kept the rats out of the pantry. Unglamorous work. The MOST important work. Pies and a cake, hero. You fight better fed too. Everyone does. Eat. Then go stab something. In that order. Always that order.",
  },
  {
    id: 'q_undead_purge_70',
    title: 'Driftwood for the Pyres',
    giver: 'npc_forgotten_smith',
    regionId: 'forgotten',
    steps: [
      { kind: 'gather', target: 'pine_tree', need: 10, label: 'Fell 10 pines for the funeral pyres' },
      { kind: 'kill', target: 'tidewraith', need: 4, label: 'Still 4 tidewraiths drawn to the pyre-site' },
    ],
    rewards: { xp: { woodcutting: 260, attack: 160 }, items: [{ id: 'wood_pine', qty: 6 }, { id: 'bar_steel', qty: 1 }], blockCents: 75 },
    intro:
      "Out here on the frontier the dead don't get BURIED — the ground's too hard and the drowned just climb back out of it anyway. We BURN them. Proper pyres, proper rites, proper ash. But I'm out of pine, and the tidewraiths keep gathering at the pyre-site like it's a REUNION. Fell ten pines, still four wraiths. The dead deserve a clean fire. It's the one dignity the frontier can still afford.",
    outro:
      "Ten pines felled, four wraiths stilled, enough driftwood to burn the frontier's dead with the dignity they've earned. We'll light the pyres at dusk and send them off clean — no climbing back out of a FIRE, that's the whole point of it. You helped give the dead a proper ending, which out here is rarer than gold. Pine's yours, and steel. Stay for the pyres if you want. They're beautiful, in a way that'll ruin you a little. Most dignities do.",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // DENIAL AND BARGAINING — Sol's long chain finale (ashen)
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'q_undead_purge_71',
    title: 'The Widows Have Organized',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'crypt_widow', need: 12, label: 'Sweep 12 crypt widows' },
      { kind: 'kill', target: 'spider_funnel', need: 8, label: 'Burn out 8 funnel spiders' },
    ],
    rewards: { xp: { attack: 440, defense: 180 }, items: [{ id: 'crystal_shard', qty: 3 }], blockCents: 90 },
    intro:
      "The crypt widows have ORGANIZED, friend. They've recruited funnel spiders from the lower vaults and they're webbing the ENTIRE east plot into one great grey cathedral of silk. It's almost impressive. I'd admire it if I could WALK through it. Twelve widows, eight funnel spiders. Take the cathedral DOWN. Some architecture deserves demolition.",
    outro:
      "Twelve widows swept, eight funnels burned, the silk cathedral demolished and the east plot WALKABLE again. I'll say this for the widows — they had a vision. A terrible, sticky, trip-hazard vision, but a vision. Now it's cobwebs and memory, which is where visions belong out here. Crystal shards, pulled from the silk. They glow. Of course they glow. Everything in this graveyard glows except my MOOD. Take them. Go.",
  },
  {
    id: 'q_undead_purge_72',
    title: 'Gerald\'s Cousin',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [
      { kind: 'explore', target: 'ashen', need: 1, label: 'Search the far crypt for Gerald\'s wandering cousin' },
      { kind: 'kill', target: 'wraith_pale', need: 10, label: 'Dispel 10 pale wraiths blocking the way' },
      { kind: 'kill', target: 'ash_spectre', need: 6, label: 'Banish 6 ash spectres in the crypt' },
    ],
    rewards: { xp: { attack: 460, magic: 240 }, items: [{ id: 'crystal_shard', qty: 2 }, { id: 'potion_regret', qty: 1 }], blockCents: 100 },
    intro:
      "Gerald's upset. Won't say why — Gerald doesn't SAY things, that's rather his whole situation — but I've gathered his COUSIN has wandered off into the far crypt and gotten himself lost among the wraiths. Now, I don't ENCOURAGE the dead to socialize, but Gerald's good company and I owe him one. Find the cousin, dispel ten wraiths, banish six spectres clearing the way. Do it for Gerald. Do it for me. Mostly do it for Gerald.",
    outro:
      "You found the cousin — rattled, in both senses, but intact — and dispelled the lot that had him cornered. Gerald's... I want to say 'smiling', but Gerald's a skull, so let's say 'arranged more contentedly'. He's grateful. I'm grateful. The cousin's grateful, in a drafty, incorporeal way. You did a kindness for the dead with nothing to gain, which is the rarest kind of kindness there is. Crystal and a potion. And Gerald's regards. He means them. I can tell.",
  },
  {
    id: 'q_undead_purge_73',
    title: 'The Gravekeeper Before Me',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'revenant_rust', need: 10, label: 'Lay to rest 10 rusted revenants' },
      { kind: 'kill', target: 'boneknight_cursed', need: 5, label: 'Still the 5 boneknight guardians' },
      { kind: 'kill', target: 'barrow_wight', need: 1, label: 'Lay the old gravekeeper himself to rest' },
    ],
    rewards: { xp: { attack: 720, magic: 360, vitality: 320 }, items: [{ id: 'bar_gold', qty: 2 }, { id: 'crystal_cut', qty: 2 }], blockCents: 200 },
    intro:
      "I've been avoiding this plot for TWENTY YEARS. The gravekeeper before me is buried here — and lately he's been getting UP, raising a whole retinue of revenants and boneknights, 'maintaining' the graveyard his way, which was a WORSE way, with more stabbing. He's a barrow wight now, poor old monster. Lay his retinue to rest — ten revenants, five knights — and then lay HIM to rest. Someone has to. It's the job. It was always going to be the job.",
    outro:
      "Ten revenants, five knights, and the old gravekeeper himself — all of them, finally, at rest. He fought me at the end, the way he fought everything, the way the job teaches you to fight. But he's down now. Peaceful. I buried him PROPER this time, with the rites he never got, and I planted begonias, and I meant them. One day that'll be me getting up and raking the wrong way, and I hope whoever comes next is as kind about it as you were just now. Gold and crystal. Thank you. For him. For me. For whoever's next.",
  },
  {
    id: 'q_undead_purge_74',
    title: 'Acceptance',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'lich_frost', need: 6, label: 'Shatter 6 frost liches gathering at the plot' },
      { kind: 'kill', target: 'wyrm_bone', need: 2, label: 'Unmake 2 bone wyrms they raised' },
      { kind: 'kill', target: 'dragon_rime', need: 1, label: 'Lay the Rime Dragon, lord of the frozen dead, to rest' },
    ],
    rewards: { xp: { attack: 999, vitality: 640, magic: 560, defense: 480 }, items: [{ id: 'bar_gold', qty: 5 }, { id: 'crystal_cut', qty: 4 }], blockCents: 460 },
    intro:
      "Here's the truth I've danced around our whole acquaintance, friend: my graveyard isn't a graveyard. It's a DOOR. And something on the far side of it has been pushing — frost liches, bone wyrms, and now the Rime Dragon itself, the lord of every frozen dead thing that ever refused to lie down. It's coming THROUGH my plot, using my dead, and if it finishes crossing, there won't be a realm left to bury. Six liches, two wyrms, and the Dragon. Close my door. I've kept it my whole life. Help me keep it one last time. Then I think — I think I can finally rest too.",
    outro:
      "It's done. The Rime Dragon — lord of the frozen dead, the thing pushing at my door since before I took this job — is laid to rest at last, and the door is SHUT, sealed with your sword and my rake and a lifetime of begonias. The graveyard's just a graveyard again. Quiet. Tended. Mine. Gerald's weeping, and this time I am too, and they're the good kind, the FINISHED kind. You didn't just purge the dead, friend. You let an old gravekeeper lay down his rake knowing the door would HOLD. Gold, crystal, and the only thing I've ever truly had to give: peace. Take it. We both earned it. The dead can rest now. So can I. So can you. Go live, hero. Somebody in all this ought to.",
  },
  {
    id: 'q_undead_purge_75',
    title: 'The Longest Night',
    giver: 'prophet_karl',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'dread_maw', need: 3, label: 'Seal 3 dread maws tearing the sky open' },
      { kind: 'kill', target: 'dragon_obsidian', need: 1, label: 'Slay the Obsidian Dragon risen one final time' },
      { kind: 'kill', target: 'dragon_rime', need: 1, label: 'Slay the Rime Dragon risen beside it' },
    ],
    rewards: { xp: { attack: 999, vitality: 999, magic: 999, defense: 999 }, items: [{ id: 'bar_gold', qty: 6 }, { id: 'crystal_cut', qty: 6 }], blockCents: 700 },
    intro:
      "The final vision. The one I've carried since I was a child and prayed was a nightmare: the Longest Night. Every dead thing you ever put down, every door you ever closed, every dragon you ever laid to rest — they rise ONE more time, all at once, led by the Obsidian Dragon and the Rime Dragon TOGETHER, under a sky torn open by three dread maws. This is the night the dead decide whether they stay dead FOREVER. Three maws, two dragons, the fate of everything that ever lived or died. I can't see past it, hero. No one can. Nobody has EVER seen past the Longest Night. Go be the first. Go make a dawn.",
    outro:
      "The sun came up. Do you understand what I'm telling you — the SUN CAME UP. The Longest Night ended, the maws are sealed, the Obsidian and the Rime Dragon lie still beneath a sky that's healing, and for the first time in every prophecy ever whispered, there IS a past-the-Night, and it is DAWN, and it is REAL, and you MADE it. The dead are resting. All of them. Every grave you ever stood over, every door you ever shut, every soul you ever freed from a welded frame — they're at PEACE, and they'll stay at peace, because you gave them the one thing prophecy never could: an ending that HOLDS. There's no reward in any vault worth this. So take the biggest one I've got, and know it isn't enough, and know that nothing ever could be. You didn't purge the undead, hero. You let the whole world finally, finally sleep. Now go wake up in it. You've earned the morning. We all have. Because of you.",
  },
]

const prereqs: Record<string, readonly string[]> = {
  // Gravekeeper Sol's cleansing chain
  q_undead_purge_02: ['q_undead_purge_01'],
  q_undead_purge_03: ['q_undead_purge_02'],
  q_undead_purge_04: ['q_undead_purge_03'],
  q_undead_purge_05: ['q_undead_purge_04'],
  q_undead_purge_06: ['q_undead_purge_05'],
  q_undead_purge_07: ['q_undead_purge_06'],
  // Plague beneath
  q_undead_purge_09: ['q_undead_purge_08'],
  q_undead_purge_11: ['q_undead_purge_10'],
  // Cursed loot ladder (mage_lyra)
  q_undead_purge_13: ['q_undead_purge_12'],
  q_undead_purge_14: ['q_undead_purge_13'],
  q_undead_purge_15: ['q_undead_purge_14'],
  q_undead_purge_43: ['q_undead_purge_15'],
  q_undead_purge_44: ['q_undead_purge_43'],
  q_undead_purge_45: ['q_undead_purge_44'],
  q_undead_purge_46: ['q_undead_purge_45'],
  // Hellmouth / demon front
  q_undead_purge_17: ['q_undead_purge_16'],
  q_undead_purge_18: ['q_undead_purge_17'],
  q_undead_purge_19: ['q_undead_purge_18'],
  q_undead_purge_20: ['q_undead_purge_19'],
  q_undead_purge_21: ['q_undead_purge_20'],
  // Outer isles
  q_undead_purge_29: ['q_undead_purge_28'],
  q_undead_purge_30: ['q_undead_purge_29'],
  q_undead_purge_31: ['q_undead_purge_30'],
  // Revenant row (hermit_vex)
  q_undead_purge_37: ['q_undead_purge_36'],
  q_undead_purge_38: ['q_undead_purge_37'],
  // Dragons of the dead (prophet_karl)
  q_undead_purge_48: ['q_undead_purge_47'],
  q_undead_purge_49: ['q_undead_purge_48'],
  q_undead_purge_50: ['q_undead_purge_49'],
  // Grave maintenance side-loop
  q_undead_purge_52: ['q_undead_purge_51'],
  q_undead_purge_53: ['q_undead_purge_52'],
  q_undead_purge_54: ['q_undead_purge_53'],
  // Ironhold crypts
  q_undead_purge_62: ['q_undead_purge_61'],
  q_undead_purge_63: ['q_undead_purge_62'],
  // Demon-lord capstone (warden)
  q_undead_purge_65: ['q_undead_purge_64'],
  q_undead_purge_66: ['q_undead_purge_65'],
  // Sol's long finale
  q_undead_purge_72: ['q_undead_purge_71'],
  q_undead_purge_73: ['q_undead_purge_72'],
  q_undead_purge_74: ['q_undead_purge_73'],
  // The absolute end — requires the two apex chains done
  q_undead_purge_75: ['q_undead_purge_50', 'q_undead_purge_74'],
}

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
  wood_oak: 'Oak Log',
  wood_pine: 'Pine Log',
  hide_wolf: 'Wolf Hide',
  hide_boar: 'Boar Hide',
  hide_tough: 'Tough Hide',
  herb_green: 'Green Herb',
  herb_red: 'Red Herb',
  herb_blue: 'Blue Herb',
  herb_gold: 'Goldleaf Herb',
  mushroom_brown: 'Brown Mushroom',
  wheat: 'Wheat',
  clay_lump: 'Clay Lump',
  fish_raw: 'Raw Fish',
  fish_salmon: 'Salmon',
  food_jerky: 'Grave-Cured Jerky',
  food_pie: 'Meat Pie',
  food_cake: 'Tiny Expensive Cake',
  food_honey: 'Jar of Honey',
  food_jelly: 'Wobbling Jelly',
  potion_regret: 'Potion of Regret',
}

registerPack({ quests, prereqs, itemNames })

export { quests, prereqs, itemNames }
