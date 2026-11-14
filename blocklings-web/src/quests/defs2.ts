/**
 * Quests, wave 3 — the OUTER-ZONE arcs (~25 QuestDefs).
 *
 * Six chains parked at real zone landmarks (see src/world/zones/batch*.ts),
 * given by the eight wave-3 outpost NPCs appended to src/ids.ts. Explore
 * steps target ZONE ids — the integrator's region poll emits
 * 'region:entered' for streamed zones too, so they Just Work. Kill/gather
 * targets are verified against the combat BIOME_MIX and gather BIOME_NODES
 * tables for each chain's biomes. Same register as defs.ts: mature cartoon
 * comedy, everyone is tired, nothing is reimbursable.
 */
import type { QuestDef } from '../types'

/** quest id -> quests that must be COMPLETED before it is offered. */
export const PREREQS2: Readonly<Record<string, readonly string[]>> = {
  // A. Northern expedition — Camp Bad Idea -> the Nope Shelf
  q2_second_opinion: ['q_warchief_retirement'],
  q2_cold_cases: ['q2_second_opinion'],
  q2_summit_paperwork: ['q2_cold_cases'],
  q2_nope_diplomacy: ['q2_summit_paperwork'],
  q2_last_laugh_salvage: ['q2_nope_diplomacy'],
  // B. Southern desert pilgrimage — Honest Jim's
  q2_genuine_oasis: ['q_regicide_legal'],
  q2_invisible_inventory: ['q2_genuine_oasis'],
  q2_castle_buckethead: ['q2_invisible_inventory'],
  q2_exit_signage: ['q2_castle_buckethead'],
  // C. Swamp frog-choir saga
  q2_choir_auditions: ['q_regicide_legal'],
  q2_percussion_section: ['q2_choir_auditions'],
  q2_silence_the_critics: ['q2_percussion_section'],
  q2_gerald_gig: ['q2_silence_the_critics'],
  q2_encore: ['q2_gerald_gig'],
  // D. Moby's Last Laugh whale-cult mini-arc
  q2_join_the_pod: ['q_warchief_retirement'],
  q2_organ_pipes: ['q2_join_the_pod'],
  q2_second_coming: ['q2_organ_pipes'],
  // E. Crystal late chain — Prism Break
  q2_shard_count: ['q_regicide_legal'],
  q2_visitation_rights: ['q2_shard_count'],
  q2_glowhole_audit: ['q2_visitation_rights'],
  q2_full_spectrum: ['q2_glowhole_audit'],
  // F. Volcanic late chain — the Dormancy Files
  q2_certified_dormant: ['q_warchief_retirement'],
  q2_field_readings: ['q2_certified_dormant'],
  q2_tantrum_census: ['q2_field_readings'],
  q2_eruption_paperwork: ['q2_tantrum_census'],
}

/** Display names for item ids this module grants (catalog-verified). */
export const ITEM_NAMES2: Readonly<Record<string, string>> = {
  sword_crystal: 'Crystal Sword',
  staff_crystal: 'Crystal Staff',
  bow_crystal: 'Crystal Bow',
  helm_crystal: 'Crystal Helm',
  boots_crystal: 'Crystal Boots',
  shield_crystal: 'Crystal Shield',
  sword_mythic: 'Mythic Sword',
  pick_gold: 'Gold Pickaxe',
  pick_crystal: 'Crystal Pickaxe',
  potion_elixir: 'Golden Elixir',
  potion_hp_huge: 'Huge Health Potion',
  potion_mp_huge: 'Huge Mana Potion',
  food_feast: 'Royal Feast',
  food_jerky: 'Tough Jerky',
  food_honey: 'Wild Honey',
  fish_salmon: 'Salmon',
  acc_tinfoil: 'Tinfoil Hat',
  ring_onion: 'Onion Ring',
  charm_rabbit: "Rabbit's Foot",
  rod_golden: 'Golden Fishing Rod',
  amulet_block: 'BLOCK Pendant',
  crystal_cut: 'Cut Crystal',
}

export const QUESTS2: readonly QuestDef[] = [
  // =========================================================================
  // A. The Bad Idea Revival — Petra the Previous (Camp Bad Idea, Brainfreeze
  //    Expanse) marches you north to the Nope Shelf's frozen pirate ship.
  // =========================================================================
  {
    id: 'q2_second_opinion',
    title: 'Expedition: Second Opinion',
    giver: 'survivor_petra',
    regionId: 'brainfreeze',
    steps: [
      { kind: 'kill', target: 'wolf', need: 10, label: 'Drive off 10 frost wolves circling the camp' },
      { kind: 'gather', target: 'pine_tree', need: 6, label: 'Chop 6 frozen pines for firewood' },
    ],
    rewards: { xp: { attack: 700, woodcutting: 350 }, items: [{ id: 'potion_hp_huge', qty: 2 }, { id: 'food_jerky', qty: 4 }] },
    intro:
      "Welcome to Camp Bad Idea. I'm Petra — expedition survivor, singular, which technically makes me the leader now. We're relaunching the expedition, and this time we're doing it RIGHT: with firewood, and without the wolves that ate the committee. Ten wolves gone, six pines down, and we are officially an organization again.",
    outro:
      "Wolves repelled, wood stacked, morale at an all-time high — the bar was underground, but still. I've written you into the expedition charter as 'the muscle'. Don't read the rest of the charter. It's mostly eulogies.",
  },
  {
    id: 'q2_cold_cases',
    title: 'Cold Cases',
    giver: 'survivor_petra',
    regionId: 'brainfreeze',
    steps: [
      { kind: 'kill', target: 'golem', need: 6, label: 'Crack 6 ice-rimed golems' },
      { kind: 'gather', target: 'crystal_node', need: 3, label: 'Chip 3 rare crystals from the ice' },
    ],
    rewards: { xp: { attack: 800, mining: 500 }, items: [{ id: 'crystal_cut', qty: 1 }, { id: 'potion_mp_huge', qty: 2 }] },
    intro:
      "The last expedition catalogued six 'decorative ice statues' between here and the Big Brain. Day two, the statues catalogued US. They're golems, they're angry, and they're standing on the richest crystal seam I've ever lost colleagues to. Crack all six and bring me three crystals. For science. And spite. Mostly spite.",
    outro:
      "Six golems down and the crystals are singing — that's normal, apparently, everything up here hums or screams. The Big Brain watched you do it and somehow looks MORE disappointed. Ignore him. He's been like that since we got here.",
  },
  {
    id: 'q2_summit_paperwork',
    title: 'Summit Paperwork',
    giver: 'survivor_petra',
    regionId: 'brainfreeze',
    steps: [
      { kind: 'explore', target: 'shiverspikes', need: 1, label: 'Reach the Shiverspikes (Camp Bad Idea, the original)' },
      { kind: 'kill', target: 'bat', need: 8, label: 'Clear 8 frostbats from the old base camp' },
    ],
    rewards: { xp: { vitality: 900, defense: 450 }, items: [{ id: 'food_feast', qty: 1 }, { id: 'potion_hp_huge', qty: 2 }] },
    intro:
      "Confession: this is Camp Bad Idea TWO. The original is up in the Shiverspikes, under the peak that stabbed our flag back. The climbers left the expedition ledger there, and without it I legally cannot requisition more tents. Hike up, shoo the bats out of the mess hall, and pay your respects to the sign. We spent our last budget on the sign.",
    outro:
      "You found it! The ledger, the sign, the frozen suggestion box — untouched. The bats had turned the mess hall into a guano-based economy, so thank you for the market correction. We are now a TWO-camp operation. Expansion. The investors would weep, if we had any, or they'd survived.",
  },
  {
    id: 'q2_nope_diplomacy',
    title: 'Diplomacy at the Nope Shelf',
    giver: 'survivor_petra',
    regionId: 'brainfreeze',
    steps: [
      { kind: 'explore', target: 'nope_shelf', need: 1, label: 'Cross onto the Nope Shelf' },
      { kind: 'talk', target: 'lookout_grettel', need: 1, label: 'Parley with Grettel at the frozen pirate ship' },
    ],
    rewards: { xp: { vitality: 1000, magic: 500 }, items: [{ id: 'charm_rabbit', qty: 1 }, { id: 'food_honey', qty: 3 }] },
    intro:
      "Final push: the Nope Shelf. Named by professionals, for professionals. There's a pirate ship frozen mid-sink out there — 'The Last Laugh' — and ONE crew member still aboard, still on watch, still refusing to call it. Her name's Grettel. Talk to her. Offer her a job. We're the only expedition desperate enough to hire from a shipwreck.",
    outro:
      "A letter! For — wait, you're not the relief crew. Forty years I've held this watch and they send a LANDLUBBER with a clipboard. Fine. FINE. Tell Petra I accept, on two conditions: I keep my title, and nobody mentions the iceberg. The captain laughed at it. You can see how that went.",
  },
  {
    id: 'q2_last_laugh_salvage',
    title: 'Salvage of the Last Laugh',
    giver: 'survivor_petra',
    regionId: 'brainfreeze',
    steps: [
      { kind: 'kill', target: 'wisp', need: 8, label: 'Disperse 8 wisps haunting the wreck' },
      { kind: 'gather', target: 'iron_vein', need: 6, label: 'Mine 6 iron veins for hull braces' },
    ],
    rewards: { xp: { attack: 1600, mining: 700, vitality: 800 }, items: [{ id: 'sword_crystal', qty: 1 }, { id: 'potion_elixir', qty: 1 }] },
    intro:
      "Grettel's aboard — the expedition has a navigator, a ledger, and a attitude problem, which is all any great venture needs. Last job: the wreck itself. The wisps moved in rent-free and the hull needs iron bracing before the shelf finishes what the iceberg started. Clear them out, shore her up, and Camp Bad Idea becomes Camp Bad Idea: HARBOR DIVISION.",
    outro:
      "The Last Laugh stands — frozen, braced, and wisp-free, which is more than the original crew could say. Grettel cried, then denied it, then promoted you to 'First Mate of the Land Parts'. Take the crystal sword from the captain's cabin. He won't miss it. He's been laughing about the iceberg for forty years.",
  },

  // =========================================================================
  // B. The Honest Pilgrimage — Honest Jim (Mirage Mile) walks you down the
  //    great southern desert, one completely genuine landmark at a time.
  // =========================================================================
  {
    id: 'q2_genuine_oasis',
    title: 'The 100% Genuine Oasis',
    giver: 'honest_jim',
    regionId: 'mirage_mile',
    steps: [
      { kind: 'kill', target: 'crab', need: 8, label: 'De-pinch 8 dune crabs at the oasis' },
      { kind: 'kill', target: 'bandit', need: 6, label: 'Run off 6 "rival entrepreneurs"' },
    ],
    rewards: { xp: { attack: 600, defense: 300 }, items: [{ id: 'pick_gold', qty: 1 }, { id: 'food_honey', qty: 3 }] },
    intro:
      "Friend! Welcome to Honest Jim's, home of the realm's only certified-genuine oasis. The water is real — stop smirking — but my customers keep getting eaten on the way to it, and eaten customers leave TERRIBLE reviews. Eight crabs, six bandits, and the pilgrimage route reopens. First one's free. The quest, not the water. Water's extra.",
    outro:
      "Business is BOOMING, by which I mean two people came by and neither died. You're my best investment since the invisible inventory. Here — a gold pickaxe. Fell off a wagon. The wagon fell off a bigger wagon. Don't audit the wagons.",
  },
  {
    id: 'q2_invisible_inventory',
    title: 'Premium Invisible Inventory',
    giver: 'honest_jim',
    regionId: 'mirage_mile',
    steps: [
      { kind: 'gather', target: 'gold_vein', need: 5, label: 'Mine 5 gold veins (restocking fee)' },
      { kind: 'talk', target: 'honest_jim', need: 1, label: 'Return to Jim with the "merchandise"' },
    ],
    rewards: { xp: { mining: 700 }, items: [{ id: 'ring_onion', qty: 1 }, { id: 'potion_hp_huge', qty: 2 }] },
    intro:
      "Slight situation. A customer bought my entire invisible inventory, then claimed he 'received nothing'. The NERVE. Now I'm short on visible inventory too, and visible inventory is the expensive kind. Five gold veins' worth, mined with that pick I definitely legally gave you, and the Emporium survives another fiscal quarter.",
    outro:
      "GOLD! Real, heavy, taxable — we'll fix that last part. You know what you are? A pilgrim of commerce. Take this onion ring: genuine jewelry, certified by me, appraised by me, insured by a guy who is also me. Try not to cry. It's the onions. It's always the onions.",
  },
  {
    id: 'q2_castle_buckethead',
    title: 'The Siege of Castle Buckethead',
    giver: 'honest_jim',
    regionId: 'mirage_mile',
    steps: [
      { kind: 'explore', target: 'great_sandbox', need: 1, label: 'Enter the Great Sandbox' },
      { kind: 'kill', target: 'skeleton', need: 10, label: 'Evict 10 skeletons squatting in the sandcastle' },
    ],
    rewards: { xp: { attack: 900, vitality: 500 }, items: [{ id: 'helm_crystal', qty: 1 }, { id: 'food_feast', qty: 1 }] },
    intro:
      "Next station of the pilgrimage: Castle Buckethead, a sandcastle built by something ENORMOUS that I have personally never seen and sincerely hope is a rumor. Skeletons moved in and they're undercutting my prices — turns out the dead have NO overhead. March west, take the castle, restore the free market. For the pilgrims. For commerce. For Jim.",
    outro:
      "You took Castle Buckethead! The skeletons have been returned to the economy as, well, sand, eventually. I'd gift you the castle but something ENORMOUS has a prior claim and I don't do title disputes with things that build in flood zones. The crystal helm's from the gift shop. There's a gift shop now. You're welcome.",
  },
  {
    id: 'q2_exit_signage',
    title: "Pharaoh's Folly: Terrible Exit Signage",
    giver: 'honest_jim',
    regionId: 'mirage_mile',
    steps: [
      { kind: 'explore', target: 'pharaohs_folly', need: 1, label: "Reach Pharaoh's Folly" },
      { kind: 'kill', target: 'wisp', need: 8, label: 'Disperse 8 tomb wisps' },
      { kind: 'kill', target: 'skeleton', need: 8, label: 'Pacify 8 royal(ish) skeletons' },
    ],
    rewards: { xp: { attack: 1500, magic: 800, vitality: 700 }, items: [{ id: 'bow_crystal', qty: 1 }, { id: 'potion_elixir', qty: 1 }] },
    intro:
      "The pilgrimage ends at Pharaoh's Folly: excellent gold, TERRIBLE exit signage, zero refunds — my kind of place, honestly. Three tour groups went in; the tombs now have three tour groups' worth of staff. Clear the wisps and whatever royalty is still filing grievances, and I'll finally be able to sell the souvenir map. Which exists. Which is visible. Growth, friend.",
    outro:
      "You walked OUT of Pharaoh's Folly, which puts you in an exclusive club of basically you. The pharaoh's grievance, for the record, was that his tomb's gift shop outlived his dynasty — a king after my own heart. Take the crystal bow from lost-and-found. Nobody's coming back for it. That's what lost-and-found MEANS out here.",
  },

  // =========================================================================
  // C. Ribbit in D Minor — Maestro Ribbert (the Frog Choir, Drizzlemire)
  //    conducts you south to Big Gerald, the Croakening's shed-sized diva.
  // =========================================================================
  {
    id: 'q2_choir_auditions',
    title: 'Open Auditions (Closed Immediately)',
    giver: 'maestro_ribbert',
    regionId: 'drizzlemire',
    steps: [{ kind: 'kill', target: 'slime', need: 12, label: 'Remove 12 off-key bog slimes' }],
    rewards: { xp: { attack: 650, magic: 350 }, items: [{ id: 'potion_mp_huge', qty: 2 }, { id: 'fish_salmon', qty: 3 }] },
    intro:
      "SHHH — do you hear that? That wet, flat, UNFORGIVABLE droning? Bog slimes. They heard my choir rehearsing 'Ribbit in D Minor' and decided to 'join in'. Slimes cannot sing, friend. Slimes can only COMMIT ACOUSTIC CRIMES. Twelve of them, removed from the venue, before Thursday's performance. There are no refunds because tickets are free. The principle stands.",
    outro:
      "Silence... then five frogs, one chord, PERFECTION. The choir thanks you, the swamp thanks you, and the drizzle — which attends every show — thanks you. You've been promoted from 'audience' to 'security'. It pays in salmon. Everything here pays in salmon.",
  },
  {
    id: 'q2_percussion_section',
    title: 'The Percussion Section',
    giver: 'maestro_ribbert',
    regionId: 'drizzlemire',
    steps: [{ kind: 'gather', target: 'clay_pit', need: 6, label: 'Dig 6 clay pits for the drum line' }],
    rewards: { xp: { herbalism: 450, vitality: 400 }, items: [{ id: 'food_stew', qty: 3 }, { id: 'charm_rabbit', qty: 1 }] },
    intro:
      "The choir has voice, but no RHYTHM section, and a frog choir without percussion is just... weather. I need clay — six pits' worth — for a full drum line: bog bongos, mire timpani, one experimental mud gong that the critics will HATE, which is how I'll know it's good. Dig, friend. Dig for the arts.",
    outro:
      "Magnificent clay! Wet, angry, full of texture — the mud gong alone has made two herons leave in protest. We are now a FULL ORCHESTRA, assuming you count five frogs and a gong as an orchestra, which I aggressively do.",
  },
  {
    id: 'q2_silence_the_critics',
    title: 'Silence the Critics',
    giver: 'maestro_ribbert',
    regionId: 'drizzlemire',
    steps: [
      { kind: 'kill', target: 'spider', need: 10, label: 'Escort out 10 hissing marsh spiders' },
      { kind: 'kill', target: 'wisp', need: 6, label: 'Dim 6 heckling bog wisps' },
    ],
    rewards: { xp: { attack: 850, defense: 450 }, items: [{ id: 'boots_crystal', qty: 1 }] },
    intro:
      "Every opening night, the same two demographics ruin everything: the marsh spiders, who hiss during the quiet parts, and the bog wisps, who float over the stage doing UNLICENSED LIGHTING DESIGN. Art requires sacrifice, and tonight it requires theirs. Ten spiders, six wisps, standing ovation.",
    outro:
      "The performance went THREE encores. The spiders hissed nothing, the lighting was legally ours, and one frog hit a note so pure the drizzle briefly stopped out of respect. Take these crystal boots — stage footwear, barely used, previous owner exploded. Theatrically. It's a long opera.",
  },
  {
    id: 'q2_gerald_gig',
    title: 'The Big Gerald Gig',
    giver: 'maestro_ribbert',
    regionId: 'drizzlemire',
    steps: [
      { kind: 'explore', target: 'croakening', need: 1, label: 'Travel to the Croakening' },
      { kind: 'talk', target: 'tadpole_tony', need: 1, label: "Negotiate with Gerald's management (Tadpole Tony)" },
    ],
    rewards: { xp: { vitality: 900, magic: 500 }, items: [{ id: 'rod_golden', qty: 1 }, { id: 'food_feast', qty: 1 }] },
    intro:
      "The tour goes SOUTH, friend — to the Croakening, where the frogs are the size of sheds and the bass sections are PRE-INSTALLED. I want Big Gerald. One note from Gerald and 'Ribbit in D Minor' becomes 'Ribbit in D MAJOR', which is the same song but with hope in it. His management is a tadpole named Tony. Be polite. Tadpoles remember EVERYTHING.",
    outro:
      "So. The Maestro wants Big Gerald. Lemme check the grudge ledger... Drizzlemire, Drizzlemire — ONE outstanding grievance: a heron, 'rudeness, general', 60 years ago. The heron's dead. Grudge resolved. Gerald sings ONE note, no encores, and if anybody says 'nice frog' in a weird voice, the deal's off and the grudge is PERMANENT. Tony out.",
  },
  {
    id: 'q2_encore',
    title: 'An Encore for Gerald',
    giver: 'maestro_ribbert',
    regionId: 'drizzlemire',
    steps: [
      { kind: 'kill', target: 'mushroom', need: 10, label: 'Clear 10 shroomlings from the amphitheater bog' },
      { kind: 'gather', target: 'herb_patch', need: 8, label: 'Pick 8 herb patches for throat tonic' },
    ],
    rewards: { xp: { attack: 1400, herbalism: 800, magic: 700 }, items: [{ id: 'staff_crystal', qty: 1 }, { id: 'potion_elixir', qty: 1 }] },
    intro:
      "Gerald said yes. GERALD SAID YES. Now everything must be PERFECT: the venue bog is infested with shroomlings — they absorb sound, it's a whole acoustic tragedy — and a voice like Gerald's requires throat tonic brewed from eight patches of swamp herb. Gerald does not warm up. Gerald WAITS, and then Gerald DELIVERS. Go. The arts are counting on you.",
    outro:
      "He sang. One note, four minutes long, felt in the KNEES. Three leeches wept, the drizzle applauded, and Tony allowed a second note off the books — don't tell Gerald's union. Take my conducting staff, the crystal one. I don't need it anymore. After tonight, friend, the swamp conducts ITSELF.",
  },

  // =========================================================================
  // D. The Church of the Beached — Prophet Karl (Moby's Last Laugh, Glacier
  //    Point Blank) and the realm's most committed whale-based faith.
  // =========================================================================
  {
    id: 'q2_join_the_pod',
    title: 'Join the Pod',
    giver: 'prophet_karl',
    regionId: 'glacier_point',
    steps: [
      { kind: 'kill', target: 'wolf', need: 10, label: 'Repel 10 wolves gnawing the Holy Ribs' },
      { kind: 'gather', target: 'pine_tree', need: 5, label: 'Fell 5 pines for sanctuary pews' },
    ],
    rewards: { xp: { attack: 1000, woodcutting: 500 }, items: [{ id: 'acc_tinfoil', qty: 1 }, { id: 'fish_salmon', qty: 4 }] },
    intro:
      "Welcome, drifter, to the Church of the Beached! Behold Moby's Last Laugh: a whale who dodged the harpoon, beached himself ANYWAY, and died grinning at the irony. That's PROPHECY, friend. Or comedy. At this latitude they're the same thing. The wolves keep gnawing the Holy Ribs and we're out of pews. Ten wolves, five pines, one congregation saved.",
    outro:
      "The Ribs stand ungnawed and the pews are GORGEOUS — well, they're logs, but faith makes them pews. You're a member of the Pod now. Here's your ceremonial hat. Yes, it's tinfoil. The whale speaks on many frequencies and we like to be REACHABLE.",
  },
  {
    id: 'q2_organ_pipes',
    title: 'The Organ Pipes',
    giver: 'prophet_karl',
    regionId: 'glacier_point',
    steps: [
      { kind: 'explore', target: 'icicle_works', need: 1, label: 'Make a pilgrimage to the Icicle Works' },
      { kind: 'kill', target: 'bat', need: 10, label: 'Clear 10 bats roosting in the "organ"' },
      { kind: 'gather', target: 'iron_vein', need: 5, label: 'Mine 5 iron veins for pipe fittings' },
    ],
    rewards: { xp: { attack: 1100, mining: 600, vitality: 600 }, items: [{ id: 'potion_hp_huge', qty: 3 }, { id: 'food_feast', qty: 1 }] },
    intro:
      "Every church needs an organ, and the Whale — blessed be His beaching — has PROVIDED. The Icicle Works, one zone south: a cliff of natural pipes that howl in the wind like a baleen hallelujah. Problem one: bats in the pipes, very off-message. Problem two: the pipes need iron fittings, and the Whale provides ore but not LABOR. That's where faith comes in. You're faith.",
    outro:
      "Listen to it HOWL! That's a FULL SERMON in E-flat, friend, straight from the cliff to the congregation, and not one bat soloing over it. The Pod wept. The elk looked over. Attendance is UP. The Whale's plan proceeds, and you, drifter, are load-bearing within it.",
  },
  {
    id: 'q2_second_coming',
    title: 'The Second Beaching',
    giver: 'prophet_karl',
    regionId: 'glacier_point',
    steps: [
      { kind: 'kill', target: 'golem', need: 8, label: 'Topple 8 "false idols" (ice golems)' },
      { kind: 'kill', target: 'wisp', need: 8, label: 'Disperse 8 wisps impersonating the Whale' },
    ],
    rewards: { xp: { attack: 1700, magic: 900, vitality: 800 }, items: [{ id: 'shield_crystal', qty: 1 }, { id: 'potion_elixir', qty: 1 }, { id: 'amulet_block', qty: 1 }] },
    intro:
      "Crisis of FAITH, drifter. The ice golems have started standing in meaningful circles — false idols, obviously, the Whale is a JEALOUS fish, don't write in, I know, mammal — and the wisps have begun GLOWING WHALE-SHAPED. Blasphemous impersonation! The prophecy says the Whale returns when the coast is clear. SO CLEAR THE COAST.",
    outro:
      "And lo: the coast was cleared, and the sea did... nothing. No Second Beaching. Yet. But a seal DID haul up onto the Holy Shore and look at me — MEANINGFULLY — so the prophecy is, at minimum, in TALKS. Take the crystal shield and this BLOCK pendant from the collection plate. The Whale provides, friend. Irregularly, but He provides.",
  },

  // =========================================================================
  // E. Prism Break — Shard-Warden Igor (the Great Refractor) and the
  //    crystal fields' one-man department of corrections.
  // =========================================================================
  {
    id: 'q2_shard_count',
    title: 'Morning Shard Count',
    giver: 'shardwarden_igor',
    regionId: 'prism_break',
    steps: [{ kind: 'kill', target: 'wisp', need: 10, label: 'Disperse 10 wisps loitering around the Refractor' }],
    rewards: { xp: { attack: 800, magic: 500 }, items: [{ id: 'pick_crystal', qty: 1 }, { id: 'potion_mp_huge', qty: 2 }] },
    intro:
      "Name's Igor. Shard-Warden. I guard the Great Refractor and its six pillar inmates — five, since one escaped, we don't discuss the gap. Every morning I count shards; every morning the count is wrong, because WISPS keep loitering in the exercise yard, soaking up refracted light like it's free. It is not free. Nothing here is free. Ten wisps, dispersed. This is a FACILITY.",
    outro:
      "Count's clean for the first time since the escape. The pillars hummed approvingly, which they're not supposed to do — I'll write it up. You've got facility potential, friend. Take the crystal pickaxe from evidence. Technically it IS evidence, so if anyone asks, you mined it from your own ambition.",
  },
  {
    id: 'q2_visitation_rights',
    title: 'Visitation Rights',
    giver: 'shardwarden_igor',
    regionId: 'prism_break',
    steps: [{ kind: 'gather', target: 'crystal_node', need: 6, label: 'Harvest 6 rare crystals (contraband intake)' }],
    rewards: { xp: { mining: 900 }, items: [{ id: 'crystal_cut', qty: 2 }, { id: 'food_feast', qty: 1 }] },
    intro:
      "See those two pillars leaning over the path? The Visitation Arch. They've been straining to touch for three hundred years and gravity keeps denying the request. The paperwork to approve contact requires six rare crystals — processing fees, don't look at me, I don't make the geology. Harvest six with that pick. Yes, the evidence pick. We're past that now.",
    outro:
      "Six crystals, processed, filed, and... request APPROVED. Three centuries of paperwork and the arch gets its visit. They haven't moved, obviously — they're pillars — but the light between them went soft and pink and I had to take a MOMENT behind the dais. Don't tell the inmates the Warden has feelings. Take these cut crystals. OFF the books.",
  },
  {
    id: 'q2_glowhole_audit',
    title: 'The Glowhole Audit',
    giver: 'shardwarden_igor',
    regionId: 'prism_break',
    steps: [
      { kind: 'explore', target: 'shardlight_hollow', need: 1, label: 'Descend into Shardlight Hollow' },
      { kind: 'kill', target: 'golem', need: 8, label: 'Subdue 8 crystal-fed golems' },
    ],
    rewards: { xp: { attack: 1300, defense: 700, mining: 500 }, items: [{ id: 'potion_hp_huge', qty: 3 }, { id: 'potion_mp_huge', qty: 2 }] },
    intro:
      "Deep assignment: Shardlight Hollow, where the ground glows and your shadow files for independence. The old Glowhole mine down there — prospectors struck light, got rich, got WEIRD, and left a full cart nobody dared cash in. Now golems have been eating the seams and growing OPINIONS. Eight of them, subdued, and check if the cart's still there. Don't touch the cart. DOCUMENT the cart.",
    outro:
      "Cart documented, golems subdued, and your shadow came back — most auditors can't say all three. The glow down there got into your clothes, by the way; you'll be faintly luminous for a week. On the record: that's a hazard. Off the record: it's EXTREMELY slimming. The audit passes. The Hollow remains weird. Balance, of a kind.",
  },
  {
    id: 'q2_full_spectrum',
    title: 'Full Spectrum Lockdown',
    giver: 'shardwarden_igor',
    regionId: 'prism_break',
    steps: [
      { kind: 'kill', target: 'wisp', need: 12, label: 'Disperse 12 wisps massing for the "breakout"' },
      { kind: 'collect', target: 'crystal_raw', need: 6, label: 'Recover 6 raw crystals for the Refractor' },
    ],
    rewards: { xp: { attack: 1800, magic: 1000, mining: 600 }, items: [{ id: 'chest_crystal', qty: 1 }, { id: 'potion_elixir', qty: 1 }] },
    intro:
      "RED ALERT — or technically FULL-SPECTRUM alert, this is a prism facility. The wisps are massing at the Refractor. I've seen this before: they charge up, sync their flicker, and try to spring the pillars. Last time I lost a fence, my hat, and the ESCAPEE. Not again. Twelve wisps down and six raw crystals to overcharge the Refractor. We end the breakout era TONIGHT.",
    outro:
      "The Refractor drank those crystals and threw a beam you could read by in THREE ZONES. Wisps gone. Pillars secure. The escapee's tipped-over husk even glowed a little — remorse, probably, or refraction, I'm a warden not a poet. Take the crystal chestplate, full ceremonial issue. You're the first deputy this facility's ever had, and the only one it'll ever need.",
  },

  // =========================================================================
  // F. The Dormancy Files — Inspector Flora (Dormancy Verification Station,
  //    the Simmering Steps) versus everything the ground is lying about.
  // =========================================================================
  {
    id: 'q2_certified_dormant',
    title: 'Certified Dormant (Certificate on Fire)',
    giver: 'inspector_flora',
    regionId: 'simmering_steps',
    steps: [{ kind: 'kill', target: 'imp', need: 10, label: 'Extinguish 10 ember imps on the "dormant" terraces' }],
    rewards: { xp: { attack: 1100, defense: 600 }, items: [{ id: 'potion_hp_huge', qty: 3 }, { id: 'food_kebab', qty: 4 }] },
    intro:
      "Inspector Flora, Dormancy Verification Station, badge number one because I'm the only one left. My job: certify nightly that this lava field is dormant. It is NOT. The certificate is ON FIRE. And the ember imps keep re-igniting everything I stamp out, which is MALICIOUS INTERFERENCE WITH AN AUDIT. Ten imps, extinguished. The paperwork demands it, and frankly, so do I.",
    outro:
      "Ten imps out and tonight — for ONE glorious hour — the terraces merely simmered. I stamped 'CONDITIONALLY DORMANT' so hard I broke the stamp. That's the closest this field has come to compliance since the station opened. You beautiful instrument of bureaucracy.",
  },
  {
    id: 'q2_field_readings',
    title: 'Field Readings',
    giver: 'inspector_flora',
    regionId: 'simmering_steps',
    steps: [
      { kind: 'gather', target: 'gold_vein', need: 6, label: 'Mine 6 gold veins (thermal probes, allegedly)' },
      { kind: 'gather', target: 'crystal_node', need: 3, label: 'Extract 3 rare crystals (calibration media)' },
    ],
    rewards: { xp: { mining: 1100 }, items: [{ id: 'crystal_cut', qty: 2 }, { id: 'potion_mp_huge', qty: 2 }] },
    intro:
      "Science time. The ground lies, but MINERALS don't: gold conducts the truth and crystal remembers it. I need six gold veins for thermal probes and three rare crystals for calibration. Is this real geology? Unclear. Did I read it in a manual? The manual burned. We work with what survives, inspector's assistant. Go measure things.",
    outro:
      "Readings are IN: the ground is 400 degrees of liar. The gold probes melted — data! — and the crystals recorded a low, continuous chuckle from beneath the terraces, which I've logged as 'concerning'. The file grows. The truth simmers. Take the spare crystals; they've heard enough.",
  },
  {
    id: 'q2_tantrum_census',
    title: 'The Mount Tantrum Census',
    giver: 'inspector_flora',
    regionId: 'simmering_steps',
    steps: [
      { kind: 'explore', target: 'mount_tantrum', need: 1, label: 'Reach Mount Tantrum' },
      { kind: 'kill', target: 'golem', need: 10, label: 'Tally (demolish) 10 magma-fed golems' },
    ],
    rewards: { xp: { attack: 1600, defense: 900, vitality: 800 }, items: [{ id: 'boots_crystal', qty: 1 }, { id: 'food_feast', qty: 1 }] },
    intro:
      "Escalation. My jurisdiction technically ends at the zone line, but Mount Tantrum — the realm's angriest volcano, currently insisting its lava dribble is 'venting, actually' — keeps mailing me boulders. The complaints department up there has a queue fence and NO staff. Go conduct a census: count the magma golems, then reduce the count to zero. That's statistics.",
    outro:
      "Census complete: ten golems counted, ten golems retired, margin of error EXCELLENT. Mount Tantrum threw one (1) boulder in response, which by its standards is a formal apology. I've filed it under 'diplomatic progress'. The boots are volcanic-rated. The feast is because you climbed an ACTIVE GRIEVANCE and came back.",
  },
  {
    id: 'q2_eruption_paperwork',
    title: 'Eruption Paperwork, in Triplicate',
    giver: 'inspector_flora',
    regionId: 'simmering_steps',
    steps: [
      { kind: 'explore', target: 'cinderchoke', need: 1, label: 'Survey Cinderchoke (breathe sparingly)' },
      { kind: 'kill', target: 'imp', need: 12, label: 'Extinguish 12 ash imps falsifying records' },
      { kind: 'kill', target: 'skeleton', need: 8, label: 'Retire 8 charred "witnesses"' },
    ],
    rewards: { xp: { attack: 2400, defense: 1200, vitality: 1000 }, items: [{ id: 'sword_mythic', qty: 1 }, { id: 'potion_elixir', qty: 2 }] },
    intro:
      "Final file, assistant. Cinderchoke — ashfall country, where the air chews back — has been FALSIFYING ERUPTION RECORDS. The imps forge the dates, and the skeletons out there are listed as 'witnesses', which is a problem because they're dead AND lying. Twelve imps, eight witnesses, one honest ledger. Close this file and the whole southern range goes on the record, permanently, in TRIPLICATE.",
    outro:
      "CASE CLOSED. The Dormancy Files are complete: every lie logged, every imp extinguished, every witness... thoroughly deposed. Headquarters would promote you if headquarters existed; instead, take the mythic sword I confiscated from the caldera in '09. It's been in the evidence locker humming showtunes. It's yours now. THAT'S closure, assistant. That's the good paperwork.",
  },
] as const

const BY_ID2 = new Map<string, QuestDef>(QUESTS2.map((q) => [q.id, q]))

export function questById2(id: string): QuestDef | undefined {
  return BY_ID2.get(id)
}
