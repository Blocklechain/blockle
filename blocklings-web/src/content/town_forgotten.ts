/**
 * CONTENT PACK — "Lastlight", the holdout of THE FORGOTTEN LANDS
 * (regionId 'forgotten', x 0..240, z 120..240, lvl 20-40, biome wastes).
 *
 * A last-stand settlement bolted together on the eastern plateau, well clear
 * of the Oathbreaker vista, Grukkmaw's war-camp and the river band. The living
 * are badly outnumbered here, so the work is endgame beast-culling, scar-crystal
 * prospecting, rare-material salvage and keeping the lamps lit so the dark knows
 * someone's still home. Everyone's packed a bag by the door and nobody's left.
 *
 * Added here: 8 NPCs, 14 quests (12 from the new NPCs + 2 from the region's
 * existing Hermit Vex), 4 catalog items, 4 recipes, and a modest town hook.
 * Every referenced id is real (per the canonical maps) or added below.
 */
import { registerPack } from './packs'
import type { NpcDef } from '../ids'
import type { QuestDef, ItemDef } from '../types'
import type { Recipe } from '../crafting/recipes'
import {
  isLand,
  kitBone,
  kitCampfire,
  kitCrystalShard,
  kitDeadTree,
  kitFenceRun,
  kitHouseShell,
  kitPath,
  kitRock,
  kitRuinPillar,
  kitTotem
} from '../world/kit'
import { S_GRASS, surfaceAt } from '../world/layout'
import type { Ctx } from '../world/layout'

// ---------------------------------------------------------------------------
// NEW ITEMS (consumables use potion_* so they render; materials use herb_* /
// crystal_* families so they render instead of the generic crate)
// ---------------------------------------------------------------------------

const items: ItemDef[] = [
  {
    id: 'herb_wraithroot',
    name: 'Wraithroot',
    slot: 'material',
    rarity: 2,
    value: 15,
    desc: 'A grey tuber that grows through the ribcages of the fallen. Tastes of pennies and bad decisions, but it keeps the nerves from giving out.'
  },
  {
    id: 'crystal_scarlight',
    name: 'Scarlight Crystal',
    slot: 'material',
    rarity: 3,
    value: 52,
    desc: 'Pried from the glowing wounds the Forgotten Lands never healed. It is warm, faintly furious, and lights a tent better than a lamp and worse than a conscience.'
  },
  {
    id: 'potion_lastlight',
    name: 'Flask of Lastlight',
    slot: 'consumable',
    rarity: 2,
    value: 42,
    restores: { hp: 150 },
    desc: 'Named for the lamps nobody will let go out. Drink it before the dark argues otherwise.'
  },
  {
    id: 'potion_oathkeeper',
    name: 'Oathkeeper Draught',
    slot: 'consumable',
    rarity: 3,
    value: 85,
    restores: { hp: 220, mp: 95 },
    desc: 'Scar-crystal and wraithroot, boiled down to a promise. Glows like resolve. Costs about the same.'
  }
]

// ---------------------------------------------------------------------------
// NEW NPCs — the Lastlight holdout, eastern plateau cluster (~226,152).
// Spaced ~4-8 units apart, clear of the Oathbreaker vista, war-camp and river.
// ---------------------------------------------------------------------------

const npcs: NpcDef[] = [
  { id: 'npc_forgotten_marshal', name: 'Marshal Bronwyn Last', role: 'quests', regionId: 'forgotten', x: 226, z: 150 },
  { id: 'npc_forgotten_prospector', name: 'Scar-Prospector Odo', role: 'quests', regionId: 'forgotten', x: 219, z: 148 },
  { id: 'npc_forgotten_beastward', name: 'Beastward Yara', role: 'quests', regionId: 'forgotten', x: 232, z: 152 },
  { id: 'npc_forgotten_chaplain', name: 'Chaplain Mote', role: 'quests', regionId: 'forgotten', x: 228, z: 164 },
  { id: 'npc_forgotten_apoth', name: 'Nettle, Field Apothecary', role: 'vendor', regionId: 'forgotten', x: 222, z: 160 },
  { id: 'npc_forgotten_smith', name: 'Salvage-Smith Corra', role: 'trainer', regionId: 'forgotten', x: 216, z: 158 },
  { id: 'npc_forgotten_cook', name: 'Old Pell, Keeper of the Pot', role: 'flavor', regionId: 'forgotten', x: 217, z: 150 },
  { id: 'npc_forgotten_lookout', name: 'Wick, Who Watches the Dark', role: 'flavor', regionId: 'forgotten', x: 234, z: 146 }
]

// ---------------------------------------------------------------------------
// QUESTS (new-NPC givers)
// ---------------------------------------------------------------------------

const quests: QuestDef[] = [
  // --- Marshal Bronwyn Last: the defense of Lastlight ---
  {
    id: 'q_forgotten_welcome',
    title: 'Last One In Bars the Door',
    giver: 'npc_forgotten_marshal',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'orc', need: 10, label: 'Cull 10 orcs off the plateau' }],
    rewards: { xp: { attack: 420, vitality: 200 }, items: [{ id: 'potion_lastlight', qty: 2 }], blockCents: 90 },
    intro:
      'Marshal Last sizes you up over the top of a very dented shield. "You walked INTO the Forgotten Lands. On purpose. Either you\'re brave or you can\'t read a map, and both are useful to me right now. Ten orcs are testing the east line. Go un-test them. If you make it back, we\'ll talk about a bunk."',
    outro:
      '"Ten orcs, and you came back in roughly the shape you left. That\'s a better record than most." She thumps the dented shield once, which is as close as she gets to applause. "Welcome to Lastlight. We don\'t lock the door at night — we just dare it."'
  },
  {
    id: 'q_forgotten_siege',
    title: 'The Slow Siege',
    giver: 'npc_forgotten_marshal',
    regionId: 'forgotten',
    steps: [
      { kind: 'explore', target: 'forgotten', need: 1, label: 'Walk the eastern wastes' },
      { kind: 'kill', target: 'golem', need: 6, label: 'Break 6 wandering golems' }
    ],
    rewards: { xp: { attack: 460, defense: 300 }, items: [{ id: 'potion_hp_large', qty: 2 }, { id: 'bar_gold', qty: 2 }], blockCents: 120 },
    intro:
      '"The golems aren\'t attacking, exactly," the Marshal says, squinting at the horizon. "They\'re just WALKING at us. Slowly. For months. It\'s the most patient siege I\'ve ever lost sleep over. Walk the wastes, see how many there are, and break six of them so the rest take the hint. Nothing demoralizes a boulder like watching six of its friends become gravel."',
    outro:
      '"Six golems, down to rubble, and you\'ve got the lay of the land now." She marks the map with a stub of charcoal. "Good. A siege you can see is a siege you can fight. It\'s the patient ones that get you — ask anyone here. Well. Anyone who\'s still here."'
  },
  {
    id: 'q_forgotten_warchief',
    title: 'Grukk Gets a Letter of Complaint',
    giver: 'npc_forgotten_marshal',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'orc', need: 8, label: 'Cut through Grukk\'s honour guard' },
      { kind: 'kill', target: 'boss_forgotten', need: 1, label: 'End Warchief Grukk' }
    ],
    rewards: {
      xp: { attack: 900, defense: 500, vitality: 400 },
      items: [{ id: 'relic_eternal_cleaver', qty: 1 }, { id: 'potion_oathkeeper', qty: 2 }],
      blockCents: 400
    },
    intro:
      'The Marshal finally says the name she\'s been avoiding. "Warchief Grukk. He\'s why there\'s a \'last\' in Lastlight. He has a war-camp, an honour guard, and a truly unreasonable hat. I\'ve written him eleven letters of complaint. He ate nine and wore two. So. New plan: you cut through his guard, and then you deliver the twelfth letter personally. With a sword. The letter IS the sword."',
    outro:
      '"Grukk is DOWN." For the first time, Marshal Last looks her actual age, and then she laughs, which is worse and better all at once. "Eleven letters and all it took was the twelfth. Take the Cleaver — it\'s older than the war and it finally got to finish one. You didn\'t just hold the line today. You moved it."'
  },

  // --- Scar-Prospector Odo: scar-crystal & ore line ---
  {
    id: 'q_forgotten_scarlight',
    title: 'Where It Still Hurts',
    giver: 'npc_forgotten_prospector',
    regionId: 'forgotten',
    steps: [{ kind: 'gather', target: 'crystal_node', need: 8, label: 'Mine 8 scar-crystals' }],
    rewards: { xp: { mining: 420 }, items: [{ id: 'crystal_scarlight', qty: 3 }], blockCents: 70 },
    intro:
      'Odo taps a glowing seam with a pick that\'s mostly repairs. "The land out here got hurt bad, long ago, and it never scarred over proper. The crystals grow right in the wound — scarlight, we call it. Mine me eight. Mind the glow and mind your footing; a prospector who falls in a scar comes out philosophical, and I\'ve no patience for philosophy before lunch."',
    outro:
      '"Eight, and every one of \'em still warm." He turns one over, and the light paints his face a tired gold. "Folk up in the Capital pay a fortune for these and call \'em pretty. Out here we just call \'em the places it hurts. Same crystal. Take a few of the good ones — you dug honest."'
  },
  {
    id: 'q_forgotten_goldrush',
    title: 'The Rush That Nobody Came To',
    giver: 'npc_forgotten_prospector',
    regionId: 'forgotten',
    steps: [
      { kind: 'gather', target: 'gold_vein', need: 7, label: 'Work 7 gold veins' },
      { kind: 'kill', target: 'golem', need: 4, label: 'Clear 4 claim-golems off the dig' }
    ],
    rewards: { xp: { mining: 500, attack: 220 }, items: [{ id: 'bar_gold', qty: 3 }, { id: 'potion_lastlight', qty: 2 }], blockCents: 130 },
    intro:
      '"There\'s gold out here," Odo says, "proper gold, the kind that\'d start a stampede anywhere ELSE. Out here it started a stampede of exactly me. The veins are rich but the golems treat \'em like family heirlooms. Work seven veins, topple four golems, and we\'ll be the richest two people at the funeral. Ours, probably. Still worth it."',
    outro:
      '"Seven veins, four golems, and the richest dig in the Forgotten Lands — population: us." He weighs a gold bar like a newborn. "You know the funny thing? Back home this\'d buy a castle. Out here it buys lamp oil and bragging rights. I\'ll take the bragging rights. You take the gold."'
  },
  {
    id: 'q_forgotten_rawcut',
    title: 'Cut Your Losses',
    giver: 'npc_forgotten_prospector',
    regionId: 'forgotten',
    steps: [{ kind: 'collect', target: 'crystal_raw', need: 8, label: 'Bring Odo 8 raw crystals' }],
    rewards: { xp: { mining: 460 }, items: [{ id: 'crystal_cut', qty: 4 }, { id: 'crystal_scarlight', qty: 1 }], blockCents: 95 },
    intro:
      '"The Salvage-Smith wants raw crystal, uncut," Odo grumbles, "which is like asking a baker for flour and a slap. Bring me eight raw, and I\'ll cut four proper so Corra remembers who does the actual geology around here. There\'s an art to it. There\'s also a grudge. Mostly it\'s the grudge, but the art helps."',
    outro:
      '"Eight raw in, four cut clean." He holds a facet up and the scarlight catches it just so. "Let Corra bang on bones all she likes — THIS is the trade. You keep a few of the cut ones. And if she asks who did it, you look her dead in the eye and you say \'geology.\'"'
  },

  // --- Beastward Yara: endgame beast hunts ---
  {
    id: 'q_forgotten_willowisps',
    title: 'Lights Out',
    giver: 'npc_forgotten_beastward',
    regionId: 'forgotten',
    steps: [{ kind: 'kill', target: 'wisp', need: 10, label: 'Snuff 10 hungry wisps' }],
    rewards: { xp: { magic: 400, attack: 240 }, items: [{ id: 'potion_mp_large', qty: 2 }], blockCents: 85 },
    intro:
      'Yara watches a pale light drift across the dark and does not blink. "Those aren\'t lamps, newcomer, and they aren\'t friendly. Wisps. They float pretty and they feed ugly, and lately they\'ve learned the smell of a camp. Snuff ten before they learn the smell of a bunk. And don\'t follow the pretty ones. The pretty ones are the hungry ones. The pretty ones are ALWAYS the hungry ones."',
    outro:
      '"Ten lights out, and the dark\'s a little darker — which, out here, is good news." She finally blinks. "You don\'t chase the pretty ones. Half the beastwards I trained chased the pretty ones. I train a lot of beastwards. You, though — you might stick around long enough to be annoying. I\'d like that."'
  },
  {
    id: 'q_forgotten_apex',
    title: 'The Thick-Hided Problem',
    giver: 'npc_forgotten_beastward',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'orc', need: 8, label: 'Hunt 8 war-orcs' },
      { kind: 'collect', target: 'hide_tough', need: 5, label: 'Salvage 5 tough hides' }
    ],
    rewards: { xp: { attack: 500, defense: 260 }, items: [{ id: 'potion_oathkeeper', qty: 1 }, { id: 'food_feast', qty: 1 }], blockCents: 150 },
    intro:
      '"The war-orcs out here grow a hide like a barn door," Yara says, almost admiring. "Arrows bounce. Tempers don\'t. Hunt eight and bring me five good hides — Corra turns them into armour that\'ll keep YOU alive next time, which is my entirely selfish interest in the matter. I\'ve buried enough beastwards. The hides are so I stop."',
    outro:
      '"Eight down, five hides, and not one of them YOURS." She stacks the hides with real care. "That armour\'ll turn a blow that\'d\'ve turned you. I know how that sounds, coming from a woman who hunts for a living — but out here the whole point of killing the big things is so the small things get to grow old. You\'re welcome to it. Grow old."'
  },

  // --- Chaplain Mote: oaths, wisps & the dead ---
  {
    id: 'q_forgotten_oath',
    title: 'Keeping the Lamps Lit',
    giver: 'npc_forgotten_chaplain',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'wisp', need: 8, label: 'Lay 8 wisps to rest' },
      { kind: 'explore', target: 'forgotten', need: 1, label: 'Walk a blessing round the wastes' }
    ],
    rewards: { xp: { magic: 460, vitality: 220 }, items: [{ id: 'potion_mp_large', qty: 2 }], blockCents: 90 },
    intro:
      'Chaplain Mote tends a lamp with the focus of a surgeon. "Every wisp out here was somebody once — somebody who died and forgot to stop. I don\'t fight them. I remind them. Lay eight to rest, kindly, and walk the wastes so I can send a blessing after your footsteps. It\'s the only patrol route we keep: the one that keeps the lamps lit. A lit lamp says \'not yet.\' I\'m very attached to \'not yet.\'"',
    outro:
      '"Eight souls, rested. The wastes, blessed." Mote trims the wick and the little flame steadies. "They don\'t go anywhere grand, you know. They just go quiet. In a place this loud, quiet IS the grand thing. You did a priest\'s work today, and you didn\'t even pray. Don\'t tell the others. They\'ll want you for the choir."'
  },
  {
    id: 'q_forgotten_lastrites',
    title: 'Last Rites, First Draft',
    giver: 'npc_forgotten_chaplain',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'golem', need: 5, label: 'Still 5 restless golems' },
      { kind: 'gather', target: 'herb_patch', need: 6, label: 'Gather 6 wraithroot patches' }
    ],
    rewards: { xp: { magic: 500, herbalism: 260 }, items: [{ id: 'potion_oathkeeper', qty: 1 }, { id: 'herb_wraithroot', qty: 4 }], blockCents: 110 },
    intro:
      '"Even the golems out here don\'t rest," Mote sighs. "Something in the scars won\'t let the land lie down. Still five of them — gently as stone allows — and bring me six wraithroot. I lay it on the quiet places; it grows where things end, so it knows the way. I\'m writing better last rites. The old ones were for people who stayed dead. We need a revised edition."',
    outro:
      'Mote presses a sprig of wraithroot to a cooling golem and murmurs something you don\'t quite catch. "There. First draft of a better goodbye." The chaplain almost smiles. "Five stilled, six roots gathered, and a revised liturgy that mostly rhymes. The dead out here are a demanding congregation, but they\'re MY congregation. Thank you for helping me seat them."'
  },

  // --- Nettle the field apothecary (vendor, still gives work) ---
  {
    id: 'q_forgotten_fieldkit',
    title: 'Everything But the Patients',
    giver: 'npc_forgotten_apoth',
    regionId: 'forgotten',
    steps: [{ kind: 'gather', target: 'herb_patch', need: 8, label: 'Harvest 8 wraithroot' }],
    rewards: { xp: { herbalism: 400, alchemy: 200 }, items: [{ id: 'herb_wraithroot', qty: 6 }], blockCents: 60 },
    intro:
      'Nettle is elbow-deep in a satchel that clinks ominously. "Field apothecary, that\'s me — which is a fancy way of saying I run out of everything at the worst possible moment. Right now it\'s wraithroot. Eight patches. It\'s the base of half my kit and all of my good ideas. Fetch, before somebody out there goes and gets interesting in a wounded sort of way."',
    outro:
      '"Eight! Bless your muddy boots." She stuffs the roots away and the satchel clinks happier. "You know what the hardest part of field medicine is? It\'s not the blood. It\'s the RESTOCKING. Anybody can patch a hero. Try keeping the cupboard full while they keep heroing into the furniture. Take your cut of the roots. You\'ve got a steady hand."'
  },
  {
    id: 'q_forgotten_oathkeeper',
    title: 'The Good Stuff',
    giver: 'npc_forgotten_apoth',
    regionId: 'forgotten',
    steps: [
      { kind: 'collect', target: 'herb_wraithroot', need: 6, label: 'Supply Nettle 6 wraithroot' },
      { kind: 'gather', target: 'crystal_node', need: 4, label: 'Mine 4 scar-crystals for the burner' }
    ],
    rewards: { xp: { alchemy: 520, herbalism: 240 }, items: [{ id: 'potion_oathkeeper', qty: 3 }], blockCents: 140 },
    intro:
      '"The good stuff," Nettle whispers, eyes gleaming, "the Oathkeeper draught — needs wraithroot AND a live scar-crystal to keep the burner hot. Six roots, four crystals. One sip and a body keeps its promises even when its legs are voting otherwise. I made a batch for the Marshal last winter. She\'s still here. I rest my case and my feet."',
    outro:
      '"Oathkeeper, three bottles, corked and glowing like good news." She hands them over the way other people hand over newborns. "That\'s the difference between a camp that holds and a camp that\'s a cautionary tale — somebody kept the burner hot. Drink one before you do something brave. Then come back and tell me it worked, because that\'s the only review I trust."'
  }
]

// --- 2 quests given by the region's EXISTING npc (hermit_vex) ---
const existingGiverQuests: QuestDef[] = [
  {
    id: 'q_forgotten_hermit_tea',
    title: 'The Hermit Wants a Word (and a Mushroom)',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [
      { kind: 'gather', target: 'mushroom_cluster', need: 6, label: 'Gather 6 wastes-mushrooms' },
      { kind: 'talk', target: 'npc_forgotten_cook', need: 1, label: 'Deliver the recipe to Old Pell' }
    ],
    rewards: { xp: { herbalism: 300, cooking: 160 }, items: [{ id: 'food_feast', qty: 1 }, { id: 'potion_lastlight', qty: 1 }], blockCents: 75 },
    intro:
      'Hermit Vex eyes the smoke of Lastlight with deep suspicion. "A whole TOWN. In MY wastes. Hmph. I was here first, you know — I came out here specifically to be left alone, and now there\'s a SOUP POT." He softens a hair. "...It does smell good, though. Fetch me six of the grey mushrooms and take this recipe to their cook. If they insist on existing, they can at least exist DELICIOUSLY."',
    outro:
      '"You gave Pell the recipe? Good. Good." Vex pretends to be gruff and fails completely. "Tell the old fool to simmer it, not boil it — boiling\'s for people who\'ve given up. Maybe I\'ll wander over for a bowl. Once. To CRITIQUE it. Not because I\'m lonely. A hermit is never lonely. A hermit is just... strategically un-visited. Go on."'
  },
  {
    id: 'q_forgotten_hermit_vigil',
    title: 'Old Debts in the Dark',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'wisp', need: 8, label: 'Put 8 old ghosts to bed' },
      { kind: 'collect', target: 'crystal_scarlight', need: 3, label: 'Set 3 scarlight at the old stones' }
    ],
    rewards: { xp: { magic: 460, vitality: 200 }, items: [{ id: 'potion_oathkeeper', qty: 1 }, { id: 'crystal_cut', qty: 2 }], blockCents: 120 },
    intro:
      'Vex\'s voice drops, and for once there\'s no bluster in it. "I know this land from before it was \'forgotten.\' I knew some of those wisps when they had NAMES. Eight of them wander near the old stones — put them to bed, kindly, and set scarlight at the markers so the dark knows those three are spoken for. I owe them a vigil. A hermit pays his debts. It\'s the LIVING he can skip."',
    outro:
      'Vex stands a long moment at the lit stones, the scarlight throwing his shadow out across the wastes. "Eight at rest. Three remembered. Debt paid." He clears his throat, aggressively. "Dust. In the eye. Both eyes. From the... wind. Go back to your soup and your Marshal and your terrible, hopeful little town. And — thank you. Don\'t make it weird. I\'ll know if you make it weird."'
  }
]

// ---------------------------------------------------------------------------
// PREREQ CHAINS
// ---------------------------------------------------------------------------

const prereqs: Record<string, readonly string[]> = {
  q_forgotten_siege: ['q_forgotten_welcome'],
  q_forgotten_warchief: ['q_forgotten_siege', 'q_forgotten_apex'],
  q_forgotten_goldrush: ['q_forgotten_scarlight'],
  q_forgotten_rawcut: ['q_forgotten_goldrush'],
  q_forgotten_apex: ['q_forgotten_willowisps'],
  q_forgotten_lastrites: ['q_forgotten_oath'],
  q_forgotten_oathkeeper: ['q_forgotten_fieldkit'],
  q_forgotten_hermit_vigil: ['q_forgotten_hermit_tea']
}

// ---------------------------------------------------------------------------
// RECIPES (alchemy gated on unlock:brew; cooking on recipe:food_feast — all
// inputs/outputs are real catalog ids or items added above)
// ---------------------------------------------------------------------------

const recipes: Recipe[] = [
  {
    id: 'alchemy:potion_lastlight',
    skill: 'alchemy',
    levelReq: 22,
    inputs: [{ id: 'herb_wraithroot', qty: 2 }, { id: 'herb_green', qty: 1 }],
    output: { id: 'potion_lastlight', qty: 1 },
    xp: 24,
    gate: 'unlock:brew'
  },
  {
    id: 'alchemy:potion_oathkeeper',
    skill: 'alchemy',
    levelReq: 30,
    inputs: [{ id: 'herb_wraithroot', qty: 2 }, { id: 'crystal_scarlight', qty: 1 }, { id: 'herb_blue', qty: 1 }],
    output: { id: 'potion_oathkeeper', qty: 1 },
    xp: 40,
    gate: 'unlock:brew'
  },
  {
    id: 'alchemy:potion_hp_large',
    skill: 'alchemy',
    levelReq: 26,
    inputs: [{ id: 'herb_red', qty: 2 }, { id: 'crystal_scarlight', qty: 1 }],
    output: { id: 'potion_hp_large', qty: 1 },
    xp: 30,
    gate: 'unlock:brew'
  },
  {
    id: 'cooking:food_feast',
    skill: 'cooking',
    levelReq: 28,
    inputs: [{ id: 'fish_salmon', qty: 1 }, { id: 'wheat', qty: 2 }, { id: 'mushroom_brown', qty: 2 }],
    output: { id: 'food_feast', qty: 1 },
    xp: 34,
    gate: 'recipe:food_feast'
  }
]

// ---------------------------------------------------------------------------
// TOWN HOOK — "Lastlight": a huddle of salvaged cottages around a stone well,
// a signpost, cobble lanes, fence runs and wastes dressing (dead trees, bones,
// a ruin pillar, a totem, scarlight shards, one campfire for warmth). Eastern
// plateau cluster ~(226,152). No point lights (ember glow + glow-windows only).
// Every placement is gated on land + grass + unblocked, like the region scatters.
// ---------------------------------------------------------------------------

const WASTE_STONE = [0x6a6270, 0x5e5766, 0x766e7c] as const
const WASTE_PLASTER = [0x9a8f84, 0x8c8177] as const
const WASTE_TIMBER = 0x3c352f
const WELL_WATER = 0x2a2838

/** True only if every cell of the w×d footprint is land, grass and unblocked. */
function footprintClear(ctx: Ctx, x0: number, z0: number, w: number, d: number): boolean {
  for (let ix = x0; ix < x0 + w; ix++) {
    for (let iz = z0; iz < z0 + d; iz++) {
      if (!isLand(ix + 0.5, iz + 0.5)) return false
      if (surfaceAt(ctx, ix, iz) !== S_GRASS) return false
      if (ctx.grid.isBlocked(ix + 0.5, iz + 0.5)) return false
    }
  }
  return true
}

function cellClear(ctx: Ctx, ix: number, iz: number): boolean {
  return (
    isLand(ix + 0.5, iz + 0.5) &&
    surfaceAt(ctx, ix, iz) === S_GRASS &&
    !ctx.grid.isBlocked(ix + 0.5, iz + 0.5)
  )
}

function town(ctx: Ctx): void {
  const pal = { stone: WASTE_STONE, plaster: WASTE_PLASTER, timber: WASTE_TIMBER }

  // --- Cottages (salvaged walls, default green roof) ---
  const cottages = [
    { x0: 213, z0: 155, w: 5, d: 5, wallH: 3, door: 'E' as const, chimney: true },
    { x0: 229, z0: 155, w: 5, d: 4, wallH: 3, door: 'W' as const, chimney: true },
    { x0: 215, z0: 166, w: 5, d: 4, wallH: 3, door: 'N' as const },
    { x0: 230, z0: 167, w: 4, d: 4, wallH: 3, door: 'N' as const, chimney: true }
  ]
  for (const c of cottages) {
    if (footprintClear(ctx, c.x0, c.z0, c.w, c.d)) kitHouseShell(ctx, c, pal)
  }

  // --- Stone well at the heart of the cluster (~224,158): 3x3 ring + water ---
  const wx = 223
  const wz = 157
  if (footprintClear(ctx, wx, wz, 3, 3)) {
    for (let ix = wx; ix < wx + 3; ix++) {
      for (let iz = wz; iz < wz + 3; iz++) {
        const rim = ix === wx || ix === wx + 2 || iz === wz || iz === wz + 2
        if (rim) {
          ctx.batches.stone.add(ix, 0, iz, 1, 0.9, 1, WASTE_STONE[(ix + iz) & 1 ? 0 : 2])
        } else {
          ctx.batches.misc.add(ix + 0.1, 0.15, iz + 0.1, 0.8, 0.35, 0.8, WELL_WATER)
        }
      }
    }
    // little roof posts + lintel over the well
    ctx.batches.wood.add(wx + 0.1, 0.9, wz + 0.1, 0.25, 1.8, 0.25, WASTE_TIMBER)
    ctx.batches.wood.add(wx + 2.65, 0.9, wz + 2.65, 0.25, 1.8, 0.25, WASTE_TIMBER)
    ctx.batches.wood.add(wx, 2.6, wz, 3, 0.3, 3, WASTE_TIMBER)
    ctx.grid.blockRect(wx, wz, 3, 3)
  }

  // --- Signpost + a warm glow-lamp cube just south of the well ---
  const sx = 225
  const sz = 162
  if (cellClear(ctx, sx, sz)) {
    ctx.batches.wood.add(sx + 0.4, 0, sz + 0.4, 0.22, 2.0, 0.22, WASTE_TIMBER)
    ctx.batches.wood.add(sx - 0.4, 1.35, sz + 0.35, 1.5, 0.35, 0.12, WASTE_PLASTER[0])
    // the lastlight itself: an emissive glow cube (flickers with village lights,
    // NO point-light cost) — the lamp this town is named for.
    ctx.batches.window.add(sx + 0.3, 2.1, sz + 0.3, 0.4, 0.4, 0.4, 0xffb45e)
    ctx.grid.block(sx, sz)
  }

  // --- Cobble lanes: a spine through the cluster + door spurs to the well ---
  kitPath(ctx, [
    [214, 157],
    [220, 158],
    [224, 158],
    [231, 157]
  ])
  kitPath(ctx, [
    [224, 158],
    [220, 165],
    [217, 168]
  ])
  kitPath(ctx, [
    [224, 158],
    [229, 165],
    [231, 169]
  ])

  // --- Two short fence runs on the holdout edges (self-blocking) ---
  if (cellClear(ctx, 210, 156)) kitFenceRun(ctx, 210, 156, 5, false)
  if (cellClear(ctx, 236, 156)) kitFenceRun(ctx, 236, 156, 6, false)

  // --- Wastes dressing: dead trees, bones, a ruin pillar, a totem, scarlight ---
  for (const [ix, iz] of [
    [211, 152],
    [237, 153],
    [212, 174],
    [238, 175]
  ] as const) {
    if (cellClear(ctx, ix, iz)) kitDeadTree(ctx, ix, iz)
  }
  for (const [ix, iz] of [
    [219, 173],
    [233, 173]
  ] as const) {
    if (cellClear(ctx, ix, iz)) kitBone(ctx, ix, iz)
  }
  if (cellClear(ctx, 210, 165)) kitRuinPillar(ctx, 210, 165)
  if (cellClear(ctx, 238, 165)) kitTotem(ctx, 238, 165)
  for (const [ix, iz] of [
    [213, 148],
    [235, 171]
  ] as const) {
    if (cellClear(ctx, ix, iz)) kitCrystalShard(ctx, ix, iz)
  }
  if (cellClear(ctx, 227, 171)) kitRock(ctx, 227, 171, 1)
  // one shared fire at the heart of a cold camp — ember glow, no point-light cost
  if (cellClear(ctx, 221, 161)) kitCampfire(ctx, 221, 161)
}

// ---------------------------------------------------------------------------
// REGISTER
// ---------------------------------------------------------------------------

registerPack({
  items,
  npcs,
  quests: [...quests, ...existingGiverQuests],
  prereqs,
  recipes,
  town
})
