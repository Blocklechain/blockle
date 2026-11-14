/**
 * Quests — the full quest book (~29 QuestDefs).
 *
 * Writing register: mature cartoon comedy. Givers are snarky, stakes are
 * ridiculous, nobody is paid enough. All ids referenced here come straight
 * from src/ids.ts (species/NPCs/nodes/regions) and the items module's id
 * conventions (verified against the live catalog).
 */
import type { QuestDef } from '../types'

/** quest id -> quests that must be COMPLETED before it is offered. */
export const PREREQS: Readonly<Record<string, readonly string[]>> = {
  q_lumber_emergency: ['q_slime_situation'],
  q_meet_middleman: ['q_lumber_emergency'],
  q_fungal_dispute: ['q_meet_middleman'],
  q_graduation_day: ['q_fungal_dispute'],
  q_crab_grass: ['q_amber_waves'],
  q_goblin_eviction: ['q_teeth_of_greenwood'],
  q_alpha_male_energy: ['q_teeth_of_greenwood', 'q_goblin_eviction'],
  q_occupational_hazards: ['q_copper_quota'],
  q_rock_bottom: ['q_occupational_hazards'],
  q_border_inspection: ['q_crime_punishment'],
  q_dead_letters: ['q_border_inspection'],
  q_impportant_business: ['q_lie_back_down'],
  q_regicide_legal: ['q_impportant_business'],
  q_lawn_ornaments: ['q_unwelcome_wagon'],
  q_warchief_retirement: ['q_lawn_ornaments'],
}

/**
 * Display names for every item id this module grants or tracks (the quests
 * module may not import the items module, so it carries its own tiny
 * name table — ids verified against the catalog).
 */
export const ITEM_NAMES: Readonly<Record<string, string>> = {
  potion_hp_small: 'Small Health Potion',
  potion_hp_med: 'Health Potion',
  potion_hp_large: 'Large Health Potion',
  potion_mp_large: 'Large Mana Potion',
  potion_mystery: 'Mystery Potion',
  food_bread: 'Crusty Bread',
  food_cheese: 'Aged Cheese',
  food_skewer: 'Meat Skewer',
  food_stew: 'Hearty Stew',
  food_pie: 'Meat Pie',
  food_kebab: 'Orc Kebab',
  ring_participation: 'Participation Ring',
  ring_mood: 'Mood Ring',
  sword_iron: 'Iron Sword',
  sword_gold: 'Gold Sword',
  bow_iron: 'Iron Bow',
  staff_gold: 'Gold Staff',
  pick_iron: 'Iron Pickaxe',
  helm_steel: 'Steel Helm',
  chest_iron: 'Iron Chestplate',
  chest_crystal: 'Crystal Chestplate',
  boots_steel: 'Steel Boots',
  shield_steel: 'Steel Shield',
  bar_iron: 'Iron Bar',
  crystal_shard: 'Crystal Shard',
  fish_boot: 'Old Boot',
  herb_green: 'Green Herb',
}

export const QUESTS: readonly QuestDef[] = [
  // =========================================================================
  // Kingdom of Beginnings — Elder Rowan's starter chain
  // =========================================================================
  {
    id: 'q_slime_situation',
    title: 'The Slime Situation',
    giver: 'elder_rowan',
    regionId: 'beginnings',
    steps: [{ kind: 'kill', target: 'slime', need: 5, label: 'Splat 5 slimes' }],
    rewards: { xp: { attack: 60 }, items: [{ id: 'potion_hp_small', qty: 2 }], blockCents: 15 },
    intro:
      "Ah, fresh meat! I mean — a hero. The meadow slimes have unionized and their first demand is 'everything'. Go splat five of them before they file more paperwork. They're green, they jiggle, they have it coming.",
    outro:
      "Five slimes, zero survivors, acceptable amounts of goo on your boots. The village thanks you. The slimes' next of kin do not.",
  },
  {
    id: 'q_lumber_emergency',
    title: 'Lumber Emergency',
    giver: 'elder_rowan',
    regionId: 'beginnings',
    steps: [{ kind: 'gather', target: 'oak_tree', need: 5, label: 'Chop 5 oak trees' }],
    rewards: { xp: { woodcutting: 80 }, items: [{ id: 'food_bread', qty: 3 }], blockCents: 20 },
    intro:
      "The village needs oak. For what? Repairs. Repairs for what? The things the slimes dissolved. Don't make this a conversation — grab a hatchet and bring me five oaks' worth of regret.",
    outro:
      'Good lumber. Straight grain, minimal screaming. The carpenter wept with joy, which was unsettling for everyone.',
  },
  {
    id: 'q_meet_middleman',
    title: 'Meet the Middleman',
    giver: 'elder_rowan',
    regionId: 'beginnings',
    steps: [
      { kind: 'talk', target: 'merchant_hilda', need: 1, label: 'Introduce yourself to Merchant Hilda' },
      { kind: 'talk', target: 'guard_tomas', need: 1, label: 'Check in with Guard Tomas' },
    ],
    rewards: { xp: { vitality: 50 }, items: [{ id: 'ring_participation', qty: 1 }], blockCents: 30 },
    intro:
      "Time you met the village's two load-bearing personalities. Hilda will sell you anything that isn't nailed down, and Tomas guards the nails. Go say hello. Try not to sign anything.",
    outro:
      "You survived both conversations. Hilda already has a file on you and Tomas thinks you're 'probably fine', which from him is a parade.",
  },
  {
    id: 'q_fungal_dispute',
    title: 'A Fungal Dispute',
    giver: 'elder_rowan',
    regionId: 'beginnings',
    steps: [
      { kind: 'kill', target: 'mushroom', need: 6, label: 'Stomp 6 shroomlings' },
      { kind: 'collect', target: 'herb_green', need: 4, label: 'Collect 4 green herbs' },
    ],
    rewards: { xp: { attack: 80, herbalism: 60 }, items: [{ id: 'potion_hp_small', qty: 2 }], blockCents: 35 },
    intro:
      "The shroomlings bit the herbalist's apprentice. The apprentice bit back, and now everything is legally complicated. Simplify it: stomp six shroomlings and bring me four green herbs for the antidote. To what? Great question.",
    outro:
      "The antidote worked, mostly. The apprentice only glows in the dark a little now. In this village that's a win.",
  },
  {
    id: 'q_graduation_day',
    title: 'Graduation Day',
    giver: 'elder_rowan',
    regionId: 'beginnings',
    steps: [
      { kind: 'explore', target: 'greenwood', need: 1, label: 'Enter Greenwood Forest' },
      { kind: 'talk', target: 'scout_wren', need: 1, label: 'Report to Scout Wren' },
    ],
    rewards: { xp: { vitality: 100 }, items: [{ id: 'food_stew', qty: 2 }], blockCents: 50 },
    intro:
      "You've out-leveled our problems, which is the nicest thing anyone's done for me in years. Head east into Greenwood and find Scout Wren. She's prickly, perpetually unimpressed, and exactly who you want watching the trees. Tell her I said hi. She'll hate that.",
    outro:
      "Rowan says hi, does he? Typical. Fine, you made it here without being eaten, which puts you ahead of the last three 'heroes'. Welcome to the forest. Keep your arms inside the path at all times.",
  },

  // =========================================================================
  // Kingdom of Beginnings — Farmer Bram + Guard Tomas
  // =========================================================================
  {
    id: 'q_amber_waves',
    title: 'Amber Waves of Pain',
    giver: 'farmer_bram',
    regionId: 'beginnings',
    steps: [{ kind: 'gather', target: 'farm_plot', need: 6, label: 'Harvest 6 farm plots' }],
    rewards: { xp: { farming: 90 }, items: [{ id: 'food_bread', qty: 4 }], blockCents: 20 },
    intro:
      "My back went out three days ago. Didn't say where it was going, didn't leave a note. Meanwhile the wheat's just standing out there, smug. Harvest six plots for me and I'll make it worth your while in bread. Bread is a currency. Fight me.",
    outro:
      "Look at that wheat. LOOK at it. Beautiful. You're hired forever, no take-backs. Here's your bread — the crust's a little aggressive today, lead with your molars.",
  },
  {
    id: 'q_crab_grass',
    title: 'Crab Grass',
    giver: 'farmer_bram',
    regionId: 'beginnings',
    steps: [{ kind: 'kill', target: 'crab', need: 6, label: 'Evict 6 pebble crabs' }],
    rewards: { xp: { attack: 70 }, items: [{ id: 'food_skewer', qty: 3 }], blockCents: 25 },
    intro:
      "Pebble crabs moved into my field. Six of them. They pinch the wheat, they pinch the scarecrow, yesterday one pinched ME, and I've got the personality damage to prove it. Make my field a no-pinch zone.",
    outro:
      "Six crabs, de-pinched. You know what crabs are, once you get past the attitude? Dinner. Skewers are on me — don't ask which skewer is which.",
  },
  {
    id: 'q_lunch_duty',
    title: 'Guard Duty: Lunch Edition',
    giver: 'guard_tomas',
    regionId: 'beginnings',
    steps: [
      { kind: 'collect', target: 'food_bread', need: 3, label: 'Obtain 3 loaves of crusty bread' },
      { kind: 'talk', target: 'guard_tomas', need: 1, label: 'Deliver the "supplies" to Tomas' },
    ],
    rewards: { xp: { vitality: 60 }, items: [{ id: 'food_cheese', qty: 2 }], blockCents: 40 },
    intro:
      "Official guard business. Extremely official. I need three loaves of bread for, uh, perimeter integrity. Look, I haven't eaten since dawn and the gate won't guard itself, except it literally does, it's a gate. Three loaves. This conversation is classified.",
    outro:
      "Mmf — excellent work, citizen. The perimeter is now... mmf... fully secure. Take this cheese. It's evidence. Of nothing. Dismissed.",
  },

  // =========================================================================
  // Greenwood Forest — Scout Wren's arc → Alpha Direwolf
  // =========================================================================
  {
    id: 'q_teeth_of_greenwood',
    title: 'The Woods Have Teeth',
    giver: 'scout_wren',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'wolf', need: 7, label: 'Thin the wolf pack: 7 wolves' }],
    rewards: { xp: { attack: 150 }, items: [{ id: 'potion_hp_med', qty: 2 }], blockCents: 60 },
    intro:
      "The wolves are getting bold. Yesterday one stole a traveler's boot while the traveler was wearing it. I respect the craftsmanship, but I can't have it. Put down seven of them and the rest will remember what fear tastes like.",
    outro:
      "Seven wolves. The howling's gone from 'war chant' to 'sad book club'. That's the sweet spot. Here — potions. You're bleeding on my nice dirt.",
  },
  {
    id: 'q_goblin_eviction',
    title: 'Eviction Notice: Goblins',
    giver: 'scout_wren',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'goblin', need: 8, label: 'Serve 8 goblins their eviction' }],
    rewards: { xp: { attack: 180, defense: 90 }, items: [{ id: 'sword_iron', qty: 1 }], blockCents: 80 },
    intro:
      "A goblin camp set up in the east glade. No permits, no sanitation, constant kazoo music. I filed a complaint; they ate it. You're the appeals process. Eight goblins, maximum prejudice.",
    outro:
      "The glade is quiet. No kazoos. I didn't know silence could taste this good. Take this sword — a goblin was carrying it, and he has, let's say, downsized.",
  },
  {
    id: 'q_alpha_male_energy',
    title: 'Alpha Male Energy',
    giver: 'scout_wren',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'boss_greenwood', need: 1, label: 'Put down the Alpha Direwolf' }],
    rewards: { xp: { attack: 400, vitality: 200 }, items: [{ id: 'chest_iron', qty: 1 }], blockCents: 200 },
    intro:
      "Here's why the wolves were bold: the Alpha Direwolf. Big as a cart, loud as a tavern at closing, and he's claimed the deep woods as his 'territory'. Everything is his territory if nobody argues. Go argue.",
    outro:
      "You actually did it. The forest feels ten pounds lighter. The regular wolves have already started a new, much more polite leadership structure. Wear this chestplate — you've earned the right to be harder to chew.",
  },

  // =========================================================================
  // Greenwood — professions & side work
  // =========================================================================
  {
    id: 'q_weed_the_people',
    title: 'Weed the People',
    giver: 'herbalist_moss',
    regionId: 'greenwood',
    steps: [{ kind: 'gather', target: 'herb_patch', need: 8, label: 'Pick 8 herb patches clean' }],
    rewards: { xp: { herbalism: 150 }, items: [{ id: 'potion_mystery', qty: 2 }], blockCents: 40 },
    intro:
      "I need herbs. Many herbs. For medicine, mostly, and for one project the guild has asked me to stop describing out loud. Eight patches, picked with love or at least with fingers. The plants can tell the difference. Probably.",
    outro:
      "Lovely pickings! As payment: two Mystery Potions. What do they do? That's the mystery! Science is a journey and you're the cart.",
  },
  {
    id: 'q_eight_legs',
    title: 'Eight Legs Too Many',
    giver: 'ranger_kael',
    regionId: 'greenwood',
    steps: [
      { kind: 'kill', target: 'spider', need: 6, label: 'Squash 6 spiders' },
      { kind: 'kill', target: 'bat', need: 5, label: 'Ground 5 cave bats' },
    ],
    rewards: { xp: { attack: 160, defense: 80 }, items: [{ id: 'bow_iron', qty: 1 }], blockCents: 70 },
    intro:
      "Training assignment. The northern hollows are crawling with spiders and the bats have formed what I can only describe as an air force. Six spiders, five bats. Consider it a practical exam, except the exam bites.",
    outro:
      "Clean work. You lead the bats, you don't flinch at the spiders — I've seen knights do worse and charge more. Take this bow. The forest prefers its problems solved from a distance.",
  },

  // =========================================================================
  // Ironhold Mountains — Foreman Dagna's arc → Gravelord Golem
  // =========================================================================
  {
    id: 'q_copper_quota',
    title: 'The Copper Quota',
    giver: 'foreman_dagna',
    regionId: 'ironhold',
    steps: [{ kind: 'gather', target: 'copper_vein', need: 8, label: 'Mine 8 copper veins' }],
    rewards: { xp: { mining: 180 }, items: [{ id: 'pick_iron', qty: 1 }], blockCents: 60 },
    intro:
      "Quota's due and I'm down three miners: one quit, one eloped, one 'found himself', which apparently happens in a hammock. You look load-bearing. Eight copper veins, swing till it's done. The mountain doesn't care about your feelings and neither do I, professionally.",
    outro:
      "Quota met! You mine like you've got debts, and I mean that as the highest compliment we give here. Keep the iron pick. The hammock guy won't be needing it.",
  },
  {
    id: 'q_occupational_hazards',
    title: 'Occupational Hazards',
    giver: 'foreman_dagna',
    regionId: 'ironhold',
    steps: [
      { kind: 'kill', target: 'bat', need: 8, label: 'Clear 8 bats from the shafts' },
      { kind: 'kill', target: 'spider', need: 4, label: 'De-web 4 spiders' },
    ],
    rewards: { xp: { attack: 200, defense: 100 }, items: [{ id: 'helm_steel', qty: 1 }], blockCents: 90 },
    intro:
      "Health and safety inspection's next week and shaft four is currently a bat nightclub with a spider coat-check. Eight bats, four spiders, and suddenly we're 'compliant'. I don't make the rules, I just aggressively outsource them.",
    outro:
      "Shaft four passed inspection! First time since the incident we've agreed never to document. Take this helm — around here, rocks fall first and apologize never.",
  },
  {
    id: 'q_rock_bottom',
    title: 'Rock Bottom',
    giver: 'foreman_dagna',
    regionId: 'ironhold',
    steps: [{ kind: 'kill', target: 'boss_ironhold', need: 1, label: 'Dismantle the Gravelord Golem' }],
    rewards: { xp: { attack: 500, defense: 250, mining: 200 }, items: [{ id: 'shield_steel', qty: 1 }], blockCents: 300 },
    intro:
      "Deep tunnel woke something up. The Gravelord Golem: twelve feet of angry geology with a grudge against anyone holding a pickaxe, which statistically is everyone I know. Go introduce him to the concept of gravel. From experience.",
    outro:
      "You turned the Gravelord into aggregate. The miners are calling you 'The Quarry' now — don't fight it, nicknames here are load-bearing too. This shield's forged from his hide. He'd hate that. Perfect.",
  },
  {
    id: 'q_strike_iron',
    title: "Strike While It's Iron",
    giver: 'smith_orin',
    regionId: 'ironhold',
    steps: [{ kind: 'gather', target: 'iron_vein', need: 6, label: 'Mine 6 iron veins' }],
    rewards: { xp: { mining: 140, blacksmithing: 120 }, items: [{ id: 'bar_iron', qty: 3 }], blockCents: 50 },
    intro:
      "You want to learn smithing? Step one: suffer. Step two: iron. Six veins' worth, carried uphill, because the forge builds character and I built the forge uphill on purpose. Off you go.",
    outro:
      "Decent ore. Minimal whining. There's hope for you — don't let it go to your head, hope is flammable in here. Take these bars and make something that doesn't embarrass us both.",
  },
  {
    id: 'q_sole_survivor',
    title: 'Sole Survivor',
    giver: 'prospector_finn',
    regionId: 'ironhold',
    steps: [{ kind: 'gather', target: 'fishing_spot', need: 10, label: 'Fish the mountain pools 10 times' }],
    rewards: { xp: { fishing: 200 }, items: [{ id: 'fish_boot', qty: 1 }], blockCents: 80 },
    intro:
      "Twenty years ago I lost my lucky boot in these mountain pools. Left one. Brown. Full of destiny. Every fish in there has seen it, I guarantee you. Fish those pools ten times and bring back whatever surfaces. I can FEEL that we're close.",
    outro:
      "THAT'S IT! That's my — wait. No. This is a completely different boot. You know what? Doesn't matter. It's lucky now, I've decided, and luck is a mindset. YOU keep it. I've already got a boot. The right one. Obviously.",
  },

  // =========================================================================
  // The Royal Capital — Captain Elara's arc
  // =========================================================================
  {
    id: 'q_crime_punishment',
    title: 'Crime and Punishment(ish)',
    giver: 'captain_elara',
    regionId: 'capital',
    steps: [{ kind: 'kill', target: 'bandit', need: 9, label: 'Arrest 9 bandits (terminally)' }],
    rewards: { xp: { attack: 250, defense: 120 }, items: [{ id: 'potion_hp_large', qty: 2 }], blockCents: 150 },
    intro:
      "Bandits on the trade roads. They stole a tax wagon, which — between us — showed initiative, but the Crown frowns on initiative it didn't invoice. Nine bandits, any order. The paperwork says 'apprehend'; I've seen your resume, we both know how this ends.",
    outro:
      "Nine bandits 'apprehended'. The roads are safe, the merchants are insufferable again, and the Crown is pleased in that way where nobody smiles. Standard procedure: potions, coin, plausible deniability.",
  },
  {
    id: 'q_border_inspection',
    title: 'The Border Inspection',
    giver: 'captain_elara',
    regionId: 'capital',
    steps: [
      { kind: 'explore', target: 'greenwood', need: 1, label: 'Inspect Greenwood Forest' },
      { kind: 'explore', target: 'ironhold', need: 1, label: 'Inspect the Ironhold Mountains' },
      { kind: 'explore', target: 'ashen', need: 1, label: 'Inspect the Ashen Dungeons (from the doorway is fine)' },
    ],
    rewards: { xp: { vitality: 300 }, items: [{ id: 'boots_steel', qty: 1 }], blockCents: 120 },
    intro:
      "The Crown wants a 'comprehensive survey of the realm's frontiers'. The Crown also wants it done by someone expendable — their word, not mine, it was in the memo, I pushed back, briefly. Walk Greenwood, Ironhold, and the Ashen threshold, then come back alive. That last part is the survey.",
    outro:
      "All three borders inspected and you still have your original number of limbs — that's the best survey result we've had in years. Steel boots, requisitioned. The last inspector's. He only needed one. Don't ask.",
  },
  {
    id: 'q_dead_letters',
    title: 'The Dead Letter Office',
    giver: 'captain_elara',
    regionId: 'capital',
    steps: [{ kind: 'talk', target: 'gravekeeper_sol', need: 1, label: 'Deliver the Crown’s letter to Gravekeeper Sol' }],
    rewards: { xp: { magic: 150 }, blockCents: 60 },
    intro:
      "Delivery job. One letter, one recipient: Gravekeeper Sol, down in the Ashen Dungeons. The last three couriers came back as 'a strongly-worded absence'. Sol is... fine. Mostly fine. Just don't comment on the smell, the whispering, or the thing he calls Gerald.",
    outro:
      "A letter! For ME! Nobody writes to Sol. It's a tax notice. A TAX notice. Do you know how funny that is? I buried the last assessor. Not like THAT — he was already — look, it's a long story and you've met Gerald now, so you understand the ambiance.",
  },
  {
    id: 'q_spark_notes',
    title: 'Spark Notes',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [
      { kind: 'gather', target: 'crystal_node', need: 4, label: 'Harvest 4 rare crystals' },
      { kind: 'kill', target: 'wisp', need: 5, label: 'Disperse 5 grave wisps' },
    ],
    rewards: { xp: { magic: 400, mining: 150 }, items: [{ id: 'staff_gold', qty: 1 }, { id: 'potion_mp_large', qty: 2 }], blockCents: 200 },
    intro:
      "I'm writing the definitive treatise on ambient mana, and my field researchers keep developing 'opinions' and 'self-preservation'. I need four raw crystals and five grave wisps dispersed — gently, they're data. Fine, firmly. Fine, however you like, just bring me the readings.",
    outro:
      "Magnificent samples! The wisp residue alone rewrites chapter nine, and chapter nine had TENURE. Take this staff — gold-cored, slightly dramatic, hums in the key of smug. It suits you.",
  },
  {
    id: 'q_hostile_audit',
    title: 'Hostile Audit',
    giver: 'banker_aldous',
    regionId: 'capital',
    steps: [
      { kind: 'gather', target: 'gold_vein', need: 5, label: 'Mine 5 gold veins' },
      { kind: 'talk', target: 'banker_aldous', need: 1, label: 'Report back for the audit (bring the glow)' },
    ],
    rewards: { xp: { mining: 250 }, items: [{ id: 'ring_mood', qty: 1 }], blockCents: 500 },
    intro:
      "The vault ledger says we hold more gold than we... physically... hold. An accounting nuance. A rounding incident. Mine five gold veins in Ironhold and report back, and the books will balance before anyone important counts anything. This meeting never happened. Neither did the gold.",
    outro:
      "The ledger balances! You're a lifesaver, and I say that as someone whose life was, numerically speaking, over. Your fee — generous, untraceable. And a mood ring. It's grey. Grey means 'complicit'.",
  },

  // =========================================================================
  // Ashen Dungeons — Gravekeeper Sol's arc → Skeleton King
  // =========================================================================
  {
    id: 'q_lie_back_down',
    title: 'Lie Back Down',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'skeleton', need: 10, label: 'Re-retire 10 skeletons' }],
    rewards: { xp: { attack: 350, defense: 180 }, items: [{ id: 'potion_hp_large', qty: 3 }], blockCents: 180 },
    intro:
      "The residents are up again. I rake the plots, I polish the headstones, I maintain a FRANKLY heroic quiet-hours policy, and still — up they get, rattling around like a wind chime factory with opinions. Ten skeletons, back in the ground. It's not murder if they started it twice.",
    outro:
      "Ten tenants, re-interred. Listen to that... silence. Gerald, listen. Beautiful. You've got a real gift for the funerary arts, friend — most people just scream and run, and that does nothing for the lawn.",
  },
  {
    id: 'q_impportant_business',
    title: 'Imp-portant Business',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'imp', need: 8, label: 'Snuff out 8 ember imps' }],
    rewards: { xp: { attack: 380, magic: 200 }, items: [{ id: 'food_pie', qty: 3 }], blockCents: 220 },
    intro:
      "Ember imps moved into the lower crypts. They juggle fire. In a WOODEN COFFIN WAREHOUSE. I've tried reasoning with them, but imps treat reasoning as an appetizer. Eight of them, extinguished, before my life's work becomes a bonfire with a guest list.",
    outro:
      "The crypts are imp-free and only lightly scorched. You smell like a campfire made bad choices — wear it proudly. Pie? It's fresh. The ingredients are... recent. That came out wrong. Just take the pie.",
  },
  {
    id: 'q_regicide_legal',
    title: 'Regicide, But Legal',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'boss_ashen', need: 1, label: 'Depose the Skeleton King. Permanently.' }],
    rewards: { xp: { attack: 800, vitality: 400 }, items: [{ id: 'sword_gold', qty: 1 }], blockCents: 600 },
    intro:
      "Here's the root of it: the Skeleton King. Self-appointed, mind you — died a tax clerk, came back royalty, the afterlife does WONDERS for some resumes. Every bone in this dungeon marches on his say-so. Unseat him and the whole graveyard goes back to sleep. I checked the law: you can't murder the deceased. Airtight.",
    outro:
      "The King is dead! Again! Permanently, this time — I've already filled the plot and planted begonias, which is gravekeeper for 'stay down'. The dungeons sleep. Gerald's weeping, but he does that. Take the King's sword: solid gold, tacky as sin, swings like a sunrise.",
  },

  // =========================================================================
  // The Forgotten Lands — Hermit Vex's arc → Warchief Grukk
  // =========================================================================
  {
    id: 'q_unwelcome_wagon',
    title: 'The Unwelcome Wagon',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'orc', need: 8, label: 'Discourage 8 orcs. Thoroughly.' }],
    rewards: { xp: { attack: 450, defense: 220 }, items: [{ id: 'food_kebab', qty: 4 }], blockCents: 250 },
    intro:
      "I moved to the literal edge of the world for ONE reason: no neighbors. Then the orcs arrived. They chant at dawn. They chant at dusk. They chanted at my BIRTHDAY, which I don't celebrate, BECAUSE I'M A HERMIT. Eight of them, gone. I'm not asking for much. I'm asking for silence.",
    outro:
      "Eight fewer baritones. I slept four consecutive hours last night — a personal record since the invasion. Here, take these kebabs. The orcs left them. Waste not, want not, is what I'd say if I wanted conversation, which I don't. Goodbye.",
  },
  {
    id: 'q_lawn_ornaments',
    title: 'Aggressive Lawn Ornaments',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'golem', need: 6, label: 'Demolish 6 stone golems' }],
    rewards: { xp: { attack: 500, defense: 300 }, items: [{ id: 'crystal_shard', qty: 2 }], blockCents: 300 },
    intro:
      "There are six stone golems standing in my yard. At first I thought: statues, free, tasteful. Then one of them WAVED. I've been waving back for THREE WEEKS, out of politeness, and my arm is tired and my trust is broken. Demolish them. All six. Even the one I named. ESPECIALLY the one I named.",
    outro:
      "My yard is rubble and I have never been happier. I kept a pebble from the one I named — sentiment, don't read into it. Take these crystal shards from their cores. They glow. Everything out here glows. I've stopped asking why.",
  },
  {
    id: 'q_warchief_retirement',
    title: "The Warchief's Retirement Party",
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'boss_forgotten', need: 1, label: 'Retire Warchief Grukk, with extreme prejudice' }],
    rewards: { xp: { attack: 1200, vitality: 600 }, items: [{ id: 'chest_crystal', qty: 1 }], blockCents: 1500 },
    intro:
      "Warchief Grukk. The chanting? Him. The drums? Him. The 4 a.m. war-horn solos? HIM. He's been 'about to invade somewhere' for two years — at this point it's a lifestyle. End his career and every orc in these wastes goes back to freelance looting, which is QUIETER. Do this and I will owe you the one thing I have: my absence from your life.",
    outro:
      "Grukk has been... retired. The silence out here is so complete I can hear my own disappointment in people, which is vast. You're the finest neighbor I've ever had, because you're leaving. Take the crystal chestplate — I was saving it for someone worth talking to. Don't come back. I mean it fondly.",
  },
] as const

const BY_ID = new Map<string, QuestDef>(QUESTS.map((q) => [q.id, q]))

export function questById(id: string): QuestDef | undefined {
  return BY_ID.get(id)
}
