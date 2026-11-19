/**
 * CONTENT PACK — "Cinderhearth", the grim outpost of the ASHEN DUNGEONS
 * (regionId 'ashen', x -240..0, z 120..240, lvl 12-25, biome dungeon).
 *
 * A soot-stained huddle of cottages pitched on the eastern scorched flats,
 * well clear of Gravekeeper Sol's chapel, the ruin field and the Skeleton
 * King's arena. Undead-and-imp pest control, crystal prospecting, and deeply
 * unlicensed alchemy. Everyone here is one bad day from becoming a quest
 * objective, and they know it.
 *
 * Added here: 8 NPCs, 14 quests (12 from the new NPCs + 2 from the region's
 * existing Gravekeeper Sol), 4 catalog items, 4 recipes, and a modest town
 * hook. Every referenced id is real (per the canonical maps) or added below.
 */
import { registerPack } from './packs'
import type { NpcDef } from '../ids'
import type { QuestDef, ItemDef } from '../types'
import type { Recipe } from '../crafting/recipes'
import {
  isLand,
  kitBone,
  kitCampfire,
  kitDeadTree,
  kitFenceRun,
  kitGrave,
  kitHouseShell,
  kitPath,
  kitRock,
  kitRuinPillar
} from '../world/kit'
import { S_GRASS, surfaceAt } from '../world/layout'
import type { Ctx } from '../world/layout'

// ---------------------------------------------------------------------------
// NEW ITEMS (consumables use potion_* so they render; materials use herb_* /
// crystal_* families so they render instead of the generic crate)
// ---------------------------------------------------------------------------

const items: ItemDef[] = [
  {
    id: 'herb_ashbloom',
    name: 'Ashbloom',
    slot: 'material',
    rarity: 1,
    value: 9,
    desc: 'A pale flower that only grows where something has recently gone wrong. Smells faintly of regret and barbecue.'
  },
  {
    id: 'crystal_ashen',
    name: 'Ashen Crystal',
    slot: 'material',
    rarity: 2,
    value: 32,
    desc: 'A crystal dug from the scorched flats. Dim, warm to the touch, and humming a tune nobody taught it.'
  },
  {
    id: 'potion_ashwater',
    name: 'Flask of Ash-Water',
    slot: 'consumable',
    rarity: 1,
    value: 20,
    restores: { hp: 70 },
    desc: 'Grey, gritty, medicinal. Tastes like a fireplace and works twice as well as it has any right to.'
  },
  {
    id: 'potion_gravebloom',
    name: 'Gravebloom Tonic',
    slot: 'consumable',
    rarity: 2,
    value: 44,
    restores: { hp: 110, mp: 50 },
    desc: 'Quill distills this in a kettle he insists is "mostly clean." It glows. You feel better. Do not ask why it glows.'
  }
]

// ---------------------------------------------------------------------------
// NEW NPCs — the Cinderhearth outpost, eastern scorched flats cluster (~-16,162)
// Spaced ~4-8 units apart, clear of the ruin field, chapel and arena.
// ---------------------------------------------------------------------------

const npcs: NpcDef[] = [
  { id: 'npc_ashen_warden', name: 'Warden Mercy Gallows', role: 'quests', regionId: 'ashen', x: -16, z: 160 },
  { id: 'npc_ashen_vey', name: 'Prospector Vey', role: 'quests', regionId: 'ashen', x: -8, z: 157 },
  { id: 'npc_ashen_pim', name: 'Gravedigger Pim', role: 'quests', regionId: 'ashen', x: -14, z: 173 },
  { id: 'npc_ashen_bram', name: 'Brother Bram the Un-Haunted', role: 'quests', regionId: 'ashen', x: -6, z: 171 },
  { id: 'npc_ashen_quill', name: 'Quill, Alchemist (Unlicensed)', role: 'vendor', regionId: 'ashen', x: -9, z: 166 },
  { id: 'npc_ashen_grist', name: 'Grist the Bone-Smith', role: 'trainer', regionId: 'ashen', x: -24, z: 167 },
  { id: 'npc_ashen_soot', name: 'Soot, Who Runs the Soup', role: 'flavor', regionId: 'ashen', x: -22, z: 155 },
  { id: 'npc_ashen_edda', name: 'Edda, Night-Shift Lookout', role: 'flavor', regionId: 'ashen', x: -30, z: 162 }
]

// ---------------------------------------------------------------------------
// QUESTS
// ---------------------------------------------------------------------------

const quests: QuestDef[] = [
  // --- Warden Mercy Gallows: pest control & patrols ---
  {
    id: 'q_ashen_welcome',
    title: 'Welcome to the Cheer Pit',
    giver: 'npc_ashen_warden',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'skeleton', need: 8, label: 'Put 8 skeletons back to bed' }],
    rewards: { xp: { attack: 180, vitality: 90 }, items: [{ id: 'potion_ashwater', qty: 2 }], blockCents: 40 },
    intro:
      'Warden Gallows doesn\'t smile, exactly — the muscles have forgotten how — but she nods. "Newcomer. Good. The skeletons have been getting cocky, and a cocky skeleton is just a confident skeleton with poor life choices. Thin them out. Eight should remind the rest that we have standards here."',
    outro:
      '"Eight down, and not one of them filed a complaint." She almost smiles again. "Almost" being the operative word. "You\'ll do. Most folks last a week. You lasted an afternoon with your spine intact — that\'s management material."'
  },
  {
    id: 'q_ashen_imps',
    title: 'Imps, and Other HR Issues',
    giver: 'npc_ashen_warden',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'imp', need: 10, label: 'Deal with 10 imps' }],
    rewards: { xp: { attack: 220, defense: 120 }, items: [{ id: 'potion_hp_med', qty: 2 }], blockCents: 55 },
    intro:
      '"The imps are back," Gallows says, pinching the bridge of her nose. "They stole my left boot, set fire to a signpost, and rewrote the duty roster in crayon. Ten of them. I want ten fewer of them. This is not negotiable, and yes, I checked the crayon — it says YOU\'RE NEXT, which is just rude."',
    outro:
      '"Ten imps, one boot recovered, zero crayon." She slides the boot back on with enormous dignity. "The signpost is still on fire, but we\'re choosing to call that \'ambiance\' now. Welcome to Cinderhearth."'
  },
  {
    id: 'q_ashen_patrol',
    title: 'The Long Soot Patrol',
    giver: 'npc_ashen_warden',
    regionId: 'ashen',
    steps: [
      { kind: 'explore', target: 'ashen', need: 1, label: 'Walk the Ashen flats' },
      { kind: 'kill', target: 'bandit', need: 6, label: 'Run off 6 ash-flat bandits' }
    ],
    rewards: { xp: { attack: 200, defense: 160 }, items: [{ id: 'food_jerky', qty: 3 }], blockCents: 60 },
    intro:
      '"Bandits." Gallows says the word the way other people say "weevils." "They hide out past the ruins and rob people too tired from fighting skeletons to run. Walk the flats, see what\'s what, and convince six of them that armed robbery is a young person\'s game. The irony of robbing a bandit of his career is not lost on me."',
    outro:
      '"Flats walked, bandits discouraged." She ticks a box on the un-burnt corner of her clipboard. "Six fewer entrepreneurs out there. The honest skeletons thank you — well, they would, if jaws were on inventory this week."'
  },

  // --- Prospector Vey: crystal line ---
  {
    id: 'q_ashen_rockbottom',
    title: 'Rock Bottom',
    giver: 'npc_ashen_vey',
    regionId: 'ashen',
    steps: [{ kind: 'gather', target: 'crystal_node', need: 6, label: 'Mine 6 rare crystals' }],
    rewards: { xp: { mining: 210 }, items: [{ id: 'crystal_ashen', qty: 3 }], blockCents: 35 },
    intro:
      'Vey is lying on his back in a shallow hole. "Don\'t mind me, I\'m thinking. The crystals down here sing, see, and I can\'t sell a song, so I need the crystals. Six of \'em. Mind the hum — it gets in your teeth — but the pay\'s real and the holes are free. I dig a lot of holes."',
    outro:
      '"Six singers, lovely." He cuts one and holds it to his ear like a seashell. "This one\'s flat. This one\'s in C. This one is, and I want to be clear, extremely judgmental. Good haul. Here\'s a few of the ashen sort — they\'re the quiet ones. You\'ve earned quiet."'
  },
  {
    id: 'q_ashen_deeper',
    title: 'Deeper Still',
    giver: 'npc_ashen_vey',
    regionId: 'ashen',
    steps: [
      { kind: 'gather', target: 'crystal_node', need: 10, label: 'Mine 10 deep crystals' },
      { kind: 'kill', target: 'golem', need: 4, label: 'Topple 4 claim-jumping golems' }
    ],
    rewards: { xp: { mining: 280, attack: 120 }, items: [{ id: 'crystal_ashen', qty: 5 }, { id: 'potion_ashwater', qty: 2 }], blockCents: 70 },
    intro:
      '"Here\'s the thing about the good crystals," Vey says, already digging. "They\'re deep, and deep is where the golems live, and golems take the whole \'claim\' thing very personally. Mine ten, flatten four, and try not to let them flatten you — the paperwork for that is BRUTAL and I lose a day every time."',
    outro:
      '"Ten crystals, four golems, one slightly dented prospector — not me, them." He wipes grit off his brow and adds more grit. "You\'re the best digger I\'ve had since the last one, and he MELTED, so that\'s really saying something."'
  },
  {
    id: 'q_ashen_raw_deal',
    title: 'A Raw Deal',
    giver: 'npc_ashen_vey',
    regionId: 'ashen',
    steps: [{ kind: 'collect', target: 'crystal_raw', need: 8, label: 'Bring 8 raw crystals' }],
    rewards: { xp: { mining: 240 }, items: [{ id: 'crystal_cut', qty: 4 }], blockCents: 50 },
    intro:
      '"A buyer up in the Capital wants raw crystal — uncut, unloved, unreasonable," Vey grumbles. "Eight lumps. He says \'I\'ll do my own cutting,\' which is what everyone says right before they ruin a perfectly good crystal. Bring me eight and I\'ll cut four of mine properly to show him up. Spite is a renewable resource out here."',
    outro:
      '"Eight raw, and here\'s four cut the RIGHT way." He holds them to the grey light, smug as a cat. "Let the Capital fumble their own. We may live in a pit, but we have craftsmanship. And a pit. Mostly the pit."'
  },

  // --- Gravedigger Pim ---
  {
    id: 'q_ashen_underbudget',
    title: 'Six Feet Under Budget',
    giver: 'npc_ashen_pim',
    regionId: 'ashen',
    steps: [{ kind: 'kill', target: 'skeleton', need: 12, label: 'Re-retire 12 skeletons' }],
    rewards: { xp: { attack: 240, vitality: 120 }, items: [{ id: 'food_skewer', qty: 3 }], blockCents: 55 },
    intro:
      'Pim leans on a shovel that has clearly seen things. "Job security\'s a funny thing here. I bury \'em, they get UP, I bury \'em again. Round and round. Could you put twelve of them down properly? I\'d do it myself, but my back\'s gone and frankly so has my enthusiasm for the whole undeath situation."',
    outro:
      '"Twelve, and they STAYED down. Bless you." He pats the fresh mounds fondly. "You know it\'s a strange life when \'they stayed buried\' is the nicest thing that\'s happened all month. Here — eat something. You\'ve got that look fresh gravediggers get."'
  },
  {
    id: 'q_ashen_grave_mistakes',
    title: 'Grave Mistakes',
    giver: 'npc_ashen_pim',
    regionId: 'ashen',
    steps: [
      { kind: 'gather', target: 'clay_pit', need: 6, label: 'Dig 6 loads of grave-clay' },
      { kind: 'kill', target: 'imp', need: 6, label: 'Shoo 6 imps off the plots' }
    ],
    rewards: { xp: { mining: 180, attack: 140 }, items: [{ id: 'potion_hp_med', qty: 2 }], blockCents: 50 },
    intro:
      '"I need clay for the headstones — six loads," Pim says, "and I need the imps GONE, because they keep digging the graves back up looking for \'treasure,\' which is just, you know, people. Rude people now, admittedly, but still. Six loads of clay, six imps evicted. The dead deserve a lie-in."',
    outro:
      '"Clay\'s perfect, imps are scarpering." Pim shapes a headstone with the tenderness of a man who\'s made far too many. "There. Nice and dignified. The imps\'ll be back by Tuesday, but a man can have a dignified Monday. Thank you, friend."'
  },

  // --- Brother Bram the Un-Haunted: exorcism / magic line ---
  {
    id: 'q_ashen_ghost_chance',
    title: 'Ghost of a Chance',
    giver: 'npc_ashen_bram',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'wisp', need: 8, label: 'Dispel 8 restless wisps' },
      { kind: 'explore', target: 'ashen', need: 1, label: 'Bless the far flats' }
    ],
    rewards: { xp: { magic: 260, vitality: 100 }, items: [{ id: 'potion_mp_med', qty: 2 }], blockCents: 60 },
    intro:
      'Brother Bram is cheerful in the way only a man surrounded by ghosts can be. "The wisps, you see, are just confused lights that never got the memo about resting. Dispel eight — gently! — and walk the far flats so I can bless them from here. I\'d go myself but the ghosts and I have an understanding, and the understanding is I stay put."',
    outro:
      '"Eight souls shown the door, and the flats blessed." Bram beams. "They say I\'m the Un-Haunted because nothing dares haunt a man this relentlessly pleasant. It\'s a curse, really. A nice one. Go on — you\'ve got good light about you now."'
  },
  {
    id: 'q_ashen_lackeys',
    title: 'The Bony Boss\'s Lackeys',
    giver: 'npc_ashen_bram',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'skeleton', need: 10, label: 'Clear 10 royal skeletons' },
      { kind: 'kill', target: 'orc', need: 6, label: 'Scatter 6 hired orcs' }
    ],
    rewards: { xp: { magic: 300, attack: 180 }, items: [{ id: 'potion_gravebloom', qty: 2 }, { id: 'crystal_cut', qty: 2 }], blockCents: 110 },
    intro:
      '"The Skeleton King," Bram says, dropping his voice, "is recruiting. Skeletons AND orcs now — he\'s diversifying, the overachiever. We can\'t storm his throne yet, but we can make his staffing a nightmare. Clear ten of the bony sort and scatter six orcs. A king with no court is just a loud man in a hat, after all."',
    outro:
      '"Ten skeletons, six orcs — his whole middle management, gone." Bram rubs his hands. "He\'ll have to do his OWN menacing now, poor dear. Nothing humbles a tyrant like having to haunt his own corridors. You\'ve done the flats a kindness."'
  },

  // --- Quill the unlicensed alchemist (vendor, still gives work) ---
  {
    id: 'q_ashen_brew_haha',
    title: 'Brew-ha-ha',
    giver: 'npc_ashen_quill',
    regionId: 'ashen',
    steps: [{ kind: 'gather', target: 'herb_patch', need: 8, label: 'Gather 8 ashbloom roots' }],
    rewards: { xp: { herbalism: 200, alchemy: 100 }, items: [{ id: 'herb_ashbloom', qty: 6 }], blockCents: 30 },
    intro:
      'Quill is stirring a kettle that is, against all odds, not on fire. "I need roots — ashbloom roots, eight of them — before my license situation becomes a conversation. Which it won\'t, because I don\'t have a license, which means technically there\'s nothing to revoke. Checkmate, bureaucracy. Now fetch, before this reduces."',
    outro:
      '"Eight roots! And the kettle only boiled over twice!" Quill ladles something grey and triumphant. "You know, I was told alchemy required \'training\' and \'supervision\' and \'not doing it near the soup.\' I have disproven all three. Take some ashbloom. You\'ve earned a stake in this crime."'
  },
  {
    id: 'q_ashen_bottled_courage',
    title: 'Bottled Courage',
    giver: 'npc_ashen_quill',
    regionId: 'ashen',
    steps: [
      { kind: 'collect', target: 'herb_ashbloom', need: 6, label: 'Supply 6 ashbloom' },
      { kind: 'gather', target: 'crystal_node', need: 4, label: 'Mine 4 humming crystals' }
    ],
    rewards: { xp: { alchemy: 260, herbalism: 120 }, items: [{ id: 'potion_gravebloom', qty: 3 }], blockCents: 70 },
    intro:
      '"The big tonic," Quill whispers reverently, "needs ashbloom AND a humming crystal, because the hum keeps the glow from, um, leaving. Bring me six roots and four crystals. Last batch escaped the bottle and now lives in the rafters. We named it. We\'re not proud. SIX roots, hurry."',
    outro:
      '"Gravebloom Tonic — bottled, corked, and NOT in the rafters this time." He hands you three with the pride of a terrible, terrible genius. "Glows like a conscience. Works like a miracle. Drink it before a dungeon dive and you\'ll fear nothing. Including, ideally, me."'
  }
]

// --- 2 quests given by the region's EXISTING npc (gravekeeper_sol) ---
const existingGiverQuests: QuestDef[] = [
  {
    id: 'q_ashen_neighbourly',
    title: 'Neighbourly Duties',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [
      { kind: 'talk', target: 'npc_ashen_warden', need: 1, label: 'Report to Warden Gallows' },
      { kind: 'gather', target: 'crystal_node', need: 4, label: 'Charge 4 ward-crystals' }
    ],
    rewards: { xp: { vitality: 160, mining: 120 }, items: [{ id: 'potion_ashwater', qty: 2 }], blockCents: 45 },
    intro:
      'Gravekeeper Sol gestures vaguely east, toward the smoke. "A whole outpost sprang up on my flats while I was mid-eulogy. Cinderhearth, they call it. Go say hello to their Warden so she stops calling my graveyard \'the quiet neighbours,\' and bring four crystals to recharge the wards — the dead sleep lighter when the lights are on."',
    outro:
      '"So you\'ve met Gallows. Grim woman. I like her." Sol sets the crystals into the ward-stones, and a dim, steady glow pushes back the dark. "There. Now the neighbours stay neighbourly, and nobody on my watch gets up for a midnight stroll. Good. I hate the strolling ones."'
  },
  {
    id: 'q_ashen_impound',
    title: 'The Imp-ound Lot',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'imp', need: 12, label: 'Clear 12 imps from the graves' },
      { kind: 'collect', target: 'herb_ashbloom', need: 4, label: 'Lay 4 ashbloom on the stones' }
    ],
    rewards: { xp: { attack: 220, herbalism: 120 }, items: [{ id: 'potion_gravebloom', qty: 1 }], blockCents: 65 },
    intro:
      '"The imps," Sol says, with the long patience of the dead, "have decided my graveyard is an adventure playground. Twelve of them, cavorting on consecrated ground. Clear them out, and lay ashbloom on the stones after — the flowers settle things. And me. Mostly me. It\'s been a long century, friend."',
    outro:
      'Sol surveys the quiet graveyard, imp-free, each stone crowned with a pale ashbloom. "Peaceful. For the first time in ages, peaceful." He almost sounds surprised. "The dead thank you. They can\'t, of course — different department — but I\'ll pass it along. Rest easy, Cinderhearth. You\'ve earned a grey little dawn."'
  }
]

// ---------------------------------------------------------------------------
// PREREQ CHAINS
// ---------------------------------------------------------------------------

const prereqs: Record<string, readonly string[]> = {
  q_ashen_imps: ['q_ashen_welcome'],
  q_ashen_patrol: ['q_ashen_imps'],
  q_ashen_deeper: ['q_ashen_rockbottom'],
  q_ashen_raw_deal: ['q_ashen_deeper'],
  q_ashen_grave_mistakes: ['q_ashen_underbudget'],
  q_ashen_lackeys: ['q_ashen_ghost_chance', 'q_ashen_imps'],
  q_ashen_bottled_courage: ['q_ashen_brew_haha'],
  q_ashen_impound: ['q_ashen_neighbourly']
}

// ---------------------------------------------------------------------------
// RECIPES (alchemy gated on unlock:brew; cooking on unlock:cook — all
// inputs/outputs are real catalog ids or items added above)
// ---------------------------------------------------------------------------

const recipes: Recipe[] = [
  {
    id: 'alchemy:potion_ashwater',
    skill: 'alchemy',
    levelReq: 14,
    inputs: [{ id: 'herb_ashbloom', qty: 2 }, { id: 'herb_green', qty: 1 }],
    output: { id: 'potion_ashwater', qty: 1 },
    xp: 16,
    gate: 'unlock:brew'
  },
  {
    id: 'alchemy:potion_gravebloom',
    skill: 'alchemy',
    levelReq: 20,
    inputs: [{ id: 'herb_ashbloom', qty: 2 }, { id: 'crystal_ashen', qty: 1 }, { id: 'herb_red', qty: 1 }],
    output: { id: 'potion_gravebloom', qty: 1 },
    xp: 28,
    gate: 'unlock:brew'
  },
  {
    id: 'alchemy:potion_mp_med',
    skill: 'alchemy',
    levelReq: 18,
    inputs: [{ id: 'crystal_ashen', qty: 1 }, { id: 'herb_blue', qty: 1 }],
    output: { id: 'potion_mp_med', qty: 1 },
    xp: 22,
    gate: 'unlock:brew'
  },
  {
    id: 'cooking:food_skewer',
    skill: 'cooking',
    levelReq: 12,
    inputs: [{ id: 'mushroom_brown', qty: 2 }, { id: 'wheat', qty: 1 }],
    output: { id: 'food_skewer', qty: 1 },
    xp: 14,
    gate: 'unlock:cook'
  }
]

// ---------------------------------------------------------------------------
// TOWN HOOK — "Cinderhearth": a few charred cottages around a stone well, a
// signpost, cobble lanes, fences and grim dressing (dead trees, graves,
// bones, a ruin pillar, one campfire). Eastern scorched flats cluster ~(-16,
// 162). No point lights (ember glow + glow-windows only). Every placement is
// gated on land + grass + unblocked, exactly like the region scatters.
// ---------------------------------------------------------------------------

const ASH_STONE = [0x5f5f66, 0x55555c, 0x6a6a72] as const
const ASH_PLASTER = [0x8f897f, 0x837d73] as const
const ASH_TIMBER = 0x3a3630
const WELL_WATER = 0x24303a

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
  const pal = { stone: ASH_STONE, plaster: ASH_PLASTER, timber: ASH_TIMBER }

  // --- Cottages (charred walls, default green roof) ---
  const cottages = [
    { x0: -27, z0: 156, w: 5, d: 5, wallH: 3, door: 'E' as const, chimney: true },
    { x0: -11, z0: 155, w: 5, d: 4, wallH: 3, door: 'W' as const, chimney: true },
    { x0: -23, z0: 169, w: 5, d: 4, wallH: 3, door: 'N' as const },
    { x0: -9, z0: 168, w: 4, d: 4, wallH: 3, door: 'N' as const, chimney: true }
  ]
  for (const c of cottages) {
    if (footprintClear(ctx, c.x0, c.z0, c.w, c.d)) kitHouseShell(ctx, c, pal)
  }

  // --- Stone well at the heart of the cluster (~-16,162): 3x3 ring + water ---
  const wx = -17
  const wz = 161
  if (footprintClear(ctx, wx, wz, 3, 3)) {
    for (let ix = wx; ix < wx + 3; ix++) {
      for (let iz = wz; iz < wz + 3; iz++) {
        const rim = ix === wx || ix === wx + 2 || iz === wz || iz === wz + 2
        if (rim) {
          ctx.batches.stone.add(ix, 0, iz, 1, 0.9, 1, ASH_STONE[(ix + iz) & 1 ? 0 : 2])
        } else {
          ctx.batches.misc.add(ix + 0.1, 0.15, iz + 0.1, 0.8, 0.35, 0.8, WELL_WATER)
        }
      }
    }
    // little roof posts + lintel over the well
    ctx.batches.wood.add(wx + 0.1, 0.9, wz + 0.1, 0.25, 1.8, 0.25, ASH_TIMBER)
    ctx.batches.wood.add(wx + 2.65, 0.9, wz + 2.65, 0.25, 1.8, 0.25, ASH_TIMBER)
    ctx.batches.wood.add(wx, 2.6, wz, 3, 0.3, 3, ASH_TIMBER)
    ctx.grid.blockRect(wx, wz, 3, 3)
  }

  // --- Signpost just south of the well ---
  const sx = -15
  const sz = 165
  if (cellClear(ctx, sx, sz)) {
    ctx.batches.wood.add(sx + 0.4, 0, sz + 0.4, 0.22, 1.9, 0.22, ASH_TIMBER)
    ctx.batches.wood.add(sx - 0.4, 1.3, sz + 0.35, 1.5, 0.35, 0.12, ASH_PLASTER[0])
    ctx.grid.block(sx, sz)
  }

  // --- Cobble lanes: a spine through the cluster + door spurs to the well ---
  kitPath(ctx, [
    [-27, 158],
    [-20, 161],
    [-16, 162],
    [-11, 160]
  ])
  kitPath(ctx, [
    [-16, 162],
    [-18, 168],
    [-21, 171]
  ])
  kitPath(ctx, [
    [-16, 162],
    [-11, 167],
    [-8, 170]
  ])

  // --- Two short fence runs on the outpost edges (self-blocking) ---
  if (cellClear(ctx, -31, 157)) kitFenceRun(ctx, -31, 157, 5, false)
  if (cellClear(ctx, -6, 158)) kitFenceRun(ctx, -6, 158, 6, false)

  // --- Grim dressing: dead trees, graves, bones, a ruin pillar, a campfire ---
  for (const [ix, iz] of [
    [-30, 153],
    [-5, 154],
    [-29, 174],
    [-3, 176]
  ] as const) {
    if (cellClear(ctx, ix, iz)) kitDeadTree(ctx, ix, iz)
  }
  for (const [ix, iz] of [
    [-25, 174],
    [-26, 176],
    [-28, 170]
  ] as const) {
    if (cellClear(ctx, ix, iz)) kitGrave(ctx, ix, iz)
  }
  for (const [ix, iz] of [
    [-13, 176],
    [-7, 153]
  ] as const) {
    if (cellClear(ctx, ix, iz)) kitBone(ctx, ix, iz)
  }
  if (cellClear(ctx, -31, 166)) kitRuinPillar(ctx, -31, 166)
  if (cellClear(ctx, -4, 162)) kitRock(ctx, -4, 162, 1)
  // one warm point of light in the whole grim place — ember, no point-light cost
  if (cellClear(ctx, -13, 158)) kitCampfire(ctx, -13, 158)
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
