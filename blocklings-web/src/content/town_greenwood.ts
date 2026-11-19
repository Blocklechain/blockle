/**
 * Content pack — GREENWOOD FOREST town: "Mossgrove".
 *
 * A woodcutters' and rangers' hamlet tucked into the SE coastal meadow of the
 * Greenwood Forest region (lvl 4-12). Logging, herbalism, and the occasional
 * "please kill the wolf that keeps eating the signpost" sort of errand.
 *
 * Side-effect: calls registerPack({...}) at import time.
 */
import { registerPack } from './packs'
import type { NpcDef } from '../ids'
import type { QuestDef } from '../types'
import type { Recipe } from '../crafting/recipes'
import type { ItemDef } from '../types'
import type { Ctx } from '../world/layout'

import {
  kitHouseShell,
  kitPath,
  kitTree,
  kitPine,
  kitRock,
  kitCampfire,
  kitFenceRun
} from '../world/kit'
import { surfaceAt, S_GRASS } from '../world/layout'

// ---------------------------------------------------------------------------
// New items (potions render a real mesh for any potion_* id)
// ---------------------------------------------------------------------------

const items: ItemDef[] = [
  {
    id: 'potion_pine_salve',
    name: 'Pine Salve',
    slot: 'consumable',
    rarity: 1,
    value: 24,
    restores: { hp: 45 },
    desc: 'Smells aggressively of a forest that owes you money. Patches up most scrapes and all splinters.'
  },
  {
    id: 'potion_houndsbane',
    name: 'Houndsbane Draught',
    slot: 'consumable',
    rarity: 2,
    value: 52,
    restores: { hp: 70, mp: 20 },
    desc: "Brewed to steady a ranger's nerves before the direwolves start their evening gossip. Tastes like confidence and wet dog."
  }
]

// ---------------------------------------------------------------------------
// NPCs — the townsfolk of Mossgrove (clustered near SE meadow ~156,-94)
// ---------------------------------------------------------------------------

const npcs: NpcDef[] = [
  { id: 'npc_greenwood_foreman_bexley', name: 'Foreman Bexley', role: 'quests', regionId: 'greenwood', x: 152, z: -97 },
  { id: 'npc_greenwood_herbwife_tansy', name: 'Herbwife Tansy', role: 'quests', regionId: 'greenwood', x: 146, z: -94 },
  { id: 'npc_greenwood_fletcher_pike', name: 'Fletcher Pike', role: 'vendor', regionId: 'greenwood', x: 166, z: -94 },
  { id: 'npc_greenwood_beastmaster_oona', name: 'Beastmaster Oona', role: 'trainer', regionId: 'greenwood', x: 158, z: -108 },
  { id: 'npc_greenwood_cook_dill', name: 'Cook Dill', role: 'quests', regionId: 'greenwood', x: 156, z: -79 },
  { id: 'npc_greenwood_sapling_nib', name: 'Sapling Nib', role: 'flavor', regionId: 'greenwood', x: 148, z: -82 },
  { id: 'npc_greenwood_barkeep_gilda', name: 'Barkeep Gilda', role: 'flavor', regionId: 'greenwood', x: 162, z: -82 }
]

// ---------------------------------------------------------------------------
// Quests
// ---------------------------------------------------------------------------

const quests: QuestDef[] = [
  // --- Foreman Bexley: woodcutting line ---
  {
    id: 'q_greenwood_first_timber',
    title: 'A Cord and a Prayer',
    giver: 'npc_greenwood_foreman_bexley',
    regionId: 'greenwood',
    steps: [{ kind: 'gather', target: 'oak_tree', need: 6, label: 'Fell oak for the town stockpile' }],
    rewards: { xp: { woodcutting: 120 }, items: [{ id: 'hatchet_copper', qty: 1 }], blockCents: 40 },
    intro:
      "Bexley spits on his palms, realizes that solved nothing, and wipes them on his apron. \"New blood! Grand. The quota's due, my last two cutters eloped, and the trees aren't getting any shorter. Six oaks. Go make them regret growing here.\"",
    outro:
      "He counts the logs twice, which is impressive since he loses count at four. \"Honest work. Take the spare hatchet — mine's got a personality now and I'd rather you two didn't bond.\""
  },
  {
    id: 'q_greenwood_pine_fresh',
    title: 'Pine, Not Whine',
    giver: 'npc_greenwood_foreman_bexley',
    regionId: 'greenwood',
    steps: [{ kind: 'gather', target: 'pine_tree', need: 8, label: 'Cut pine for the mill' }],
    rewards: { xp: { woodcutting: 170 }, items: [{ id: 'food_jerky', qty: 3 }] },
    intro:
      "\"Oak's for folk who like to show off,\" Bexley confides. \"Pine's for folk who like to finish by sundown. Eight of 'em. Mind the sap — it holds a grudge and it holds your gloves.\"",
    outro:
      "\"Sticky, honest, and quick. That's pine, and increasingly, that's you.\" He hands you jerky that is also three of those things."
  },
  {
    id: 'q_greenwood_splinter_squad',
    title: 'The Splinter Squad',
    giver: 'npc_greenwood_foreman_bexley',
    regionId: 'greenwood',
    steps: [
      { kind: 'kill', target: 'spider', need: 8, label: 'Clear spiders from the woodpile' },
      { kind: 'gather', target: 'oak_tree', need: 4, label: 'Salvage the usable oak' }
    ],
    rewards: { xp: { woodcutting: 140, attack: 90 }, items: [{ id: 'potion_hp_small', qty: 2 }] },
    intro:
      "Bexley gestures at the woodpile, which is gently breathing. \"Spiders moved in. Eight-legged, no permit, terrible tenants. Evict 'em, then grab whatever oak they haven't webbed into furniture.\"",
    outro:
      "\"The woodpile's stopped twitching. I'll take that as a victory and so should you.\" He presses two potions on you. \"For the bites. There'll be bites. There are always bites.\""
  },

  // --- Herbwife Tansy: herbalism line ---
  {
    id: 'q_greenwood_herb_errand',
    title: 'Green Fingers',
    giver: 'npc_greenwood_herbwife_tansy',
    regionId: 'greenwood',
    steps: [{ kind: 'gather', target: 'herb_patch', need: 6, label: 'Pick fresh greenleaf' }],
    rewards: { xp: { herbalism: 110 }, items: [{ id: 'potion_pine_salve', qty: 2 }] },
    intro:
      "Tansy doesn't look up from her mortar. \"You've got the hands of someone who hasn't ruined anything yet. Rare. Fetch me six greenleaf — the patch by the creek, not the lookalike that makes you sneeze colors.\"",
    outro:
      "She sniffs each leaf like a suspicious customs officer. \"Honest picking. No sneezing-weed in the batch. Here — salve. Rub it on the splinters you're pretending you don't have.\""
  },
  {
    id: 'q_greenwood_berry_bother',
    title: 'Berry Much Obliged',
    giver: 'npc_greenwood_herbwife_tansy',
    regionId: 'greenwood',
    steps: [
      { kind: 'gather', target: 'berry_bush', need: 8, label: 'Harvest redberries' },
      { kind: 'collect', target: 'mushroom_brown', need: 5, label: 'Gather brown mushrooms' }
    ],
    rewards: { xp: { herbalism: 150, cooking: 60 }, items: [{ id: 'food_berry_tart', qty: 2 }] },
    intro:
      "\"The children keep eating my reagents,\" Tansy sighs. \"So I'm making a tart to bribe them. Eight redberries, five brown mushrooms. The mushrooms are for flavor and, if the children misbehave, a lesson.\"",
    outro:
      "\"Perfect. Not a single poisonous one, which I'll admit I was half-hoping for.\" She slides you a tart. \"This batch is safe. This batch.\""
  },
  {
    id: 'q_greenwood_batty',
    title: 'Belfry, Without the Bell',
    giver: 'npc_greenwood_herbwife_tansy',
    regionId: 'greenwood',
    steps: [{ kind: 'kill', target: 'bat', need: 10, label: 'Thin out the drying-shed bats' }],
    rewards: { xp: { vitality: 120, herbalism: 60 }, items: [{ id: 'herb_red', qty: 4 }] },
    intro:
      "Tansy points a trowel at the ceiling of her drying shed. \"Bats. In my herbs. Doing bat things to my herbs. Ten of them, out, before my blue-mallow tastes like regret and guano.\"",
    outro:
      "\"Quiet at last. I can hear myself grind.\" She tucks redberry— redherb into your pack. \"Take these. They're worth more than the bats ever paid in rent.\""
  },

  // --- Beastmaster Oona: bow & beast line ---
  {
    id: 'q_greenwood_bow_basics',
    title: 'Point and Shoot',
    giver: 'npc_greenwood_beastmaster_oona',
    regionId: 'greenwood',
    steps: [
      { kind: 'talk', target: 'npc_greenwood_fletcher_pike', need: 1, label: 'Collect a loaner bow from Fletcher Pike' },
      { kind: 'kill', target: 'goblin', need: 6, label: 'Practice on the goblin raiders' }
    ],
    rewards: { xp: { attack: 160 }, items: [{ id: 'bow_copper', qty: 1 }] },
    intro:
      "Oona looks you up and down the way you'd appraise a nervous mule. \"You want to range for me? First you learn the pointy end goes toward the trouble. See Pike for a loaner, then introduce yourself to the goblins. Firmly.\"",
    outro:
      "\"Six goblins and you still have both eyebrows. Promising.\" She hands you a bow of your very own. \"Keep the loaner's string tension in mind. Pike cries when they come back frayed.\""
  },
  {
    id: 'q_greenwood_wolf_hides',
    title: "The Big Bad Paperwork",
    giver: 'npc_greenwood_beastmaster_oona',
    regionId: 'greenwood',
    steps: [
      { kind: 'kill', target: 'wolf', need: 8, label: 'Cull the aggressive wolves' },
      { kind: 'collect', target: 'hide_wolf', need: 5, label: 'Recover usable wolf hides' }
    ],
    rewards: { xp: { attack: 180, defense: 90 }, items: [{ id: 'potion_houndsbane', qty: 2 }], blockCents: 80 },
    intro:
      "\"The pack's gotten bold,\" Oona says. \"Bold enough to steal a boot off a sleeping ranger and bold enough to bring it back the wrong one. Eight wolves. Five good hides. The Crown counts hides, not apologies.\"",
    outro:
      "She stacks the hides and nods, once, which from Oona is basically a parade. \"Clean work. Two draughts of houndsbane — drink before the next howl, not during. During is too late.\""
  },
  {
    id: 'q_greenwood_houndsbane_brew',
    title: 'A Draught of Nerve',
    giver: 'npc_greenwood_beastmaster_oona',
    regionId: 'greenwood',
    steps: [
      { kind: 'collect', target: 'herb_green', need: 6, label: 'Gather greenleaf for the brew' },
      { kind: 'gather', target: 'pine_tree', need: 4, label: 'Cut pine for the resin base' }
    ],
    rewards: { xp: { alchemy: 150, herbalism: 60 }, items: [{ id: 'potion_houndsbane', qty: 3 }] },
    intro:
      "\"Houndsbane doesn't grow on trees,\" Oona says, then reconsiders. \"Well. Half of it does. Six greenleaf, four pine for the resin. Tansy brews, I supervise, you fetch. Everyone's happy except the pine.\"",
    outro:
      "\"Tansy says the batch 'won't kill anyone,' which from her is a five-star review.\" She splits the draughts with you. \"Three for the road. Don't drink them like soup.\""
  },
  {
    id: 'q_greenwood_direwolf',
    title: 'Who Let the Alpha Out',
    giver: 'npc_greenwood_beastmaster_oona',
    regionId: 'greenwood',
    steps: [
      { kind: 'kill', target: 'wolf', need: 6, label: 'Scatter the escort pack' },
      { kind: 'kill', target: 'boss_greenwood', need: 1, label: 'Bring down the Alpha Direwolf' }
    ],
    rewards: {
      xp: { attack: 320, defense: 160, vitality: 120 },
      items: [{ id: 'bow_iron', qty: 1 }, { id: 'potion_hp_med', qty: 3 }],
      blockCents: 200
    },
    intro:
      "Oona is, for the first time, not making a joke. \"The Alpha's grown too clever. It leads, it lures, it's eaten two patrols and a surprising number of signposts. Thin its escort, then end it. No heroics. Just a clean shot and good footing.\"",
    outro:
      "She exhales a breath she's clearly held for weeks. \"Mossgrove sleeps tonight. That's your doing.\" She presses a fine iron bow into your hands. \"You've earned the good string. Pike will weep, but the proud kind.\""
  },

  // --- Cook Dill ---
  {
    id: 'q_greenwood_cook_dill_stew',
    title: 'Stew Unto Others',
    giver: 'npc_greenwood_cook_dill',
    regionId: 'greenwood',
    steps: [
      { kind: 'collect', target: 'mushroom_brown', need: 6, label: 'Gather stewing mushrooms' },
      { kind: 'gather', target: 'fishing_spot', need: 4, label: 'Catch creek fish for the pot' }
    ],
    rewards: { xp: { cooking: 160, fishing: 80 }, items: [{ id: 'food_stew', qty: 2 }, { id: 'food_herb_roast', qty: 1 }] },
    intro:
      "Cook Dill is up to both elbows in a cauldron the size of a small pond. \"The whole town eats at my fire and nobody brings so much as a carrot. Six mushrooms, four fish from the creek. I'll do the hard part, which is everything after.\"",
    outro:
      "Dill tastes the stew, closes his eyes, and sheds a single professional tear. \"That's the one. That's dinner. Here — a couple bowls and a roast, because a cook who eats alone is just a sad man with a ladle.\""
  },

  // --- Sapling Nib (flavor giver) ---
  {
    id: 'q_greenwood_nib_lost',
    title: 'Where in the Woods is Mister Flopsy',
    giver: 'npc_greenwood_sapling_nib',
    regionId: 'greenwood',
    steps: [
      { kind: 'talk', target: 'npc_greenwood_barkeep_gilda', need: 1, label: 'Ask Gilda if she saw the rabbit' },
      { kind: 'explore', target: 'greenwood', need: 1, label: 'Search the Greenwood for Mister Flopsy' }
    ],
    rewards: { xp: { vitality: 90 }, items: [{ id: 'food_apple', qty: 3 }, { id: 'acc_lucky_rock', qty: 1 }] },
    intro:
      "Nib is approximately forty percent tears. \"Mister Flopsy ran off into the BIG woods and the big woods have WOLVES and I gave him a HAT and now the hat is out there being brave WITHOUT him—\" You should probably ask Gilda first.",
    outro:
      "Nib clutches a suspiciously round rock to their chest. \"Gilda says Mister Flopsy's been living in her cellar eating the good carrots this WHOLE time. He's fine. He's FAT. Here, you can have my lucky rock, it found him so it's YOUR problem now.\""
  },

  // --- Existing greenwood NPCs (allowed: 1-2 by regional existing npcs) ---
  {
    id: 'q_greenwood_wren_patrol',
    title: 'The Long Way Round',
    giver: 'scout_wren',
    regionId: 'greenwood',
    steps: [
      { kind: 'kill', target: 'goblin', need: 8, label: 'Break up the goblin patrols' },
      { kind: 'explore', target: 'greenwood', need: 1, label: 'Walk the full forest perimeter' }
    ],
    rewards: { xp: { attack: 140, vitality: 70 }, items: [{ id: 'potion_hp_small', qty: 3 }] },
    intro:
      "Scout Wren unrolls a map that is ninety percent coffee ring. \"Goblins are testing the tree line. I'd patrol it myself but someone's got to hold the map and the map chose me. Rough up eight, then walk the whole loop so they know we're watching.\"",
    outro:
      "Wren re-rolls the coffee map with great ceremony. \"Perimeter's quiet, goblins are sulking, and I didn't have to leave this very comfortable stump. Textbook. Take the potions — patrolling's thirsty work, I'm told.\""
  },
  {
    id: 'q_greenwood_moss_simples',
    title: 'Simples, Really',
    giver: 'herbalist_moss',
    regionId: 'greenwood',
    steps: [
      { kind: 'gather', target: 'herb_patch', need: 8, label: 'Gather greenleaf for the dispensary' },
      { kind: 'collect', target: 'mushroom_brown', need: 6, label: 'Collect capped mushrooms' }
    ],
    rewards: { xp: { herbalism: 160, alchemy: 80 }, items: [{ id: 'potion_mp_small', qty: 3 }] },
    intro:
      "Herbalist Moss gestures at a wall of alarmingly empty jars. \"Half the forest comes to me with a cough and leaves with a miracle, and the shelves don't restock on good intentions. Eight greenleaf, six mushrooms. Simple ingredients. The word is 'simples.' That's a herbalist joke. We don't get out much.\"",
    outro:
      "Moss begins decanting with the focus of a surgeon and the apron of a finger-painter. \"Shelves full, town coughing less. Take some mana draughts — a tired mind picks the wrong leaf, and the wrong leaf picks a fight.\""
  }
]

// ---------------------------------------------------------------------------
// Prerequisites (quest chains)
// ---------------------------------------------------------------------------

const prereqs: Record<string, readonly string[]> = {
  q_greenwood_pine_fresh: ['q_greenwood_first_timber'],
  q_greenwood_splinter_squad: ['q_greenwood_first_timber'],
  q_greenwood_batty: ['q_greenwood_herb_errand'],
  q_greenwood_wolf_hides: ['q_greenwood_bow_basics'],
  q_greenwood_houndsbane_brew: ['q_greenwood_wolf_hides'],
  q_greenwood_direwolf: ['q_greenwood_wolf_hides']
}

// ---------------------------------------------------------------------------
// Recipes (all inputs/outputs are real catalog ids or pack items)
// ---------------------------------------------------------------------------

const recipes: Recipe[] = [
  {
    id: 'alchemy:potion_pine_salve',
    skill: 'alchemy',
    levelReq: 5,
    inputs: [{ id: 'herb_green', qty: 2 }, { id: 'wood_pine', qty: 1 }],
    output: { id: 'potion_pine_salve', qty: 2 },
    xp: 14,
    gate: 'unlock:brew'
  },
  {
    id: 'alchemy:potion_houndsbane',
    skill: 'alchemy',
    levelReq: 10,
    inputs: [{ id: 'herb_green', qty: 3 }, { id: 'hide_wolf', qty: 1 }],
    output: { id: 'potion_houndsbane', qty: 1 },
    xp: 24,
    gate: 'unlock:brew'
  },
  {
    id: 'cooking:food_herb_roast',
    skill: 'cooking',
    levelReq: 8,
    inputs: [{ id: 'mushroom_brown', qty: 2 }, { id: 'herb_green', qty: 1 }, { id: 'wheat', qty: 1 }],
    output: { id: 'food_herb_roast', qty: 1 },
    xp: 16,
    gate: 'unlock:cook'
  }
]

// ---------------------------------------------------------------------------
// Town hook — "Mossgrove", SE coastal meadow cluster (~156, -94)
// ---------------------------------------------------------------------------

function town(ctx: Ctx): void {
  const canPlace = (ix: number, iz: number): boolean =>
    surfaceAt(ctx, ix, iz) === S_GRASS && !ctx.grid.isBlocked(ix + 0.5, iz + 0.5)

  // --- Paths first (stamp cobble before the ground/instancing pass) ---
  kitPath(ctx, [
    [154, -83],
    [156, -89],
    [156, -94], // the well
    [155, -100],
    [158, -106]
  ])
  kitPath(ctx, [
    [148, -94],
    [156, -94],
    [165, -94]
  ])

  // --- Buildings (kitHouseShell self-blocks its footprint) ---
  // Foreman's lodge (biggest, chimney) — north of the well
  if (canPlace(153, -101)) {
    kitHouseShell(ctx, { x0: 150, z0: -104, w: 8, d: 6, wallH: 4, door: 'N', chimney: true })
  }
  // Cottage A — NE
  if (canPlace(164, -100)) {
    kitHouseShell(ctx, { x0: 162, z0: -102, w: 6, d: 5, wallH: 3, door: 'W', chimney: true })
  }
  // Cottage B — SW
  if (canPlace(150, -88)) {
    kitHouseShell(ctx, { x0: 148, z0: -90, w: 6, d: 5, wallH: 3, door: 'S' })
  }
  // The tavern / common hall — SE, chimney
  if (canPlace(163, -87)) {
    kitHouseShell(ctx, { x0: 160, z0: -90, w: 8, d: 6, wallH: 4, door: 'W', chimney: true })
  }
  // Cottage C — south
  if (canPlace(152, -82)) {
    kitHouseShell(ctx, { x0: 150, z0: -84, w: 6, d: 5, wallH: 3, door: 'N' })
  }

  // --- The village well at (156, -94): a 3x3 stone curb + water + little roof ---
  const wx = 155
  const wz = -95
  const STONE = 0x8a8f8c
  const STONE_D = 0x6d726f
  const WATER = 0x2f5e8a
  const WOOD_D = 0x5a4631
  const ROOF_G = 0x3f6b3a
  // curb ring (height 0.7), water in the middle sunk a touch
  for (let dx = 0; dx < 3; dx++) {
    for (let dz = 0; dz < 3; dz++) {
      const edge = dx === 0 || dx === 2 || dz === 0 || dz === 2
      if (edge) {
        ctx.batches.stone.add(wx + dx, 0, wz + dz, 1, 0.7, 1, dx === 1 || dz === 1 ? STONE : STONE_D)
      } else {
        ctx.batches.misc.add(wx + dx + 0.08, 0, wz + dz + 0.08, 0.84, 0.35, 0.84, WATER)
      }
    }
  }
  // two posts + crossbeam + a little green roof over the well
  ctx.batches.wood.add(wx + 0.1, 0.7, wz + 1.1, 0.24, 2.2, 0.24, WOOD_D)
  ctx.batches.wood.add(wx + 2.66, 0.7, wz + 1.1, 0.24, 2.2, 0.24, WOOD_D)
  ctx.batches.wood.add(wx + 0.1, 2.7, wz + 1.0, 2.8, 0.2, 0.4, WOOD_D)
  ctx.batches.roof.add(wx - 0.1, 2.9, wz + 0.6, 3.2, 0.3, 1.2, ROOF_G)
  ctx.batches.roof.add(wx + 0.3, 3.15, wz + 0.8, 2.4, 0.3, 0.8, ROOF_G)
  ctx.grid.blockRect(wx, wz, 3, 3)

  // --- Signpost just SW of the well ---
  const sx = 152
  const sz = -92
  if (canPlace(sx, sz)) {
    ctx.batches.wood.add(sx + 0.4, 0, sz + 0.4, 0.22, 2.0, 0.22, WOOD_D)
    ctx.batches.wood.add(sx - 0.2, 1.4, sz + 0.44, 1.1, 0.4, 0.14, 0x7a6244) // "MOSSGROVE ->"
    ctx.batches.wood.add(sx + 0.1, 0.9, sz + 0.44, 0.9, 0.34, 0.14, 0x7a6244) // "<- TIMBER"
    ctx.grid.block(sx, sz)
  }

  // --- Forest flavor: a short fence, a campfire, a few pines/oaks/rocks ---
  if (canPlace(144, -100)) kitFenceRun(ctx, 144, -100, 5, false) // short paddock rail
  if (canPlace(159, -98)) kitCampfire(ctx, 159, -98)

  const scatter: ReadonlyArray<readonly [number, number, 'pine' | 'oak' | 'rock']> = [
    [143, -92, 'pine'],
    [145, -105, 'pine'],
    [169, -98, 'oak'],
    [168, -88, 'pine'],
    [147, -78, 'oak'],
    [161, -76, 'pine'],
    [141, -97, 'rock'],
    [170, -92, 'rock'],
    [153, -76, 'rock']
  ]
  for (const [ix, iz, kind] of scatter) {
    if (!canPlace(ix, iz)) continue
    if (kind === 'pine') kitPine(ctx, ix, iz)
    else if (kind === 'oak') kitTree(ctx, ix, iz)
    else kitRock(ctx, ix, iz, 1)
  }
}

// ---------------------------------------------------------------------------
registerPack({ items, npcs, quests, prereqs, recipes, town })
