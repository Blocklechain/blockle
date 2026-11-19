/**
 * Content pack — DEEPDELVE, a mining town in the Ironhold Mountains (lvl 8-18).
 *
 * A soot-stained settlement clinging to the south-east lowland below the
 * ravine mouth: ore quotas, a smithy that never cools, and a running feud
 * with whatever lives in the deep tunnels. New NPCs, a quest book, a few
 * craftables, and a tasteful town cluster of cottages around a stone well.
 *
 * Writing register: mature cartoon-comedy. Everyone is tired, nobody is paid
 * enough, and the mountain is always one bad shift from eating someone.
 * Every referenced id is real (ITEM/SPECIES/NODE/NPC/REGION maps) or added
 * here in `items`.
 */
import { registerPack } from './packs'
import type { NpcDef } from '../ids'
import type { QuestDef, ItemDef } from '../types'
import type { Recipe } from '../crafting/recipes'
import type { Ctx } from '../world/layout'
import { S_GRASS, surfaceAt } from '../world/layout'
import { isLand, kitHouseShell, kitHut, kitPath, kitFenceRun, kitPine, kitRock } from '../world/kit'

// ---------------------------------------------------------------------------
// New catalog items
//   potion_* ids render via buildPotion (prefix+suffix, no fallback), so both
//   tonics get real meshes. The pasty is a food_* flavor item (crate mesh,
//   acceptable for a quest payout).
// ---------------------------------------------------------------------------
const items: ItemDef[] = [
  {
    id: 'potion_cavebreath',
    name: 'Cavebreath Tonic',
    slot: 'consumable',
    rarity: 1,
    value: 42,
    restores: { hp: 45 },
    desc: 'Smells like a wet tunnel and tastes worse. Clears the lungs of rock dust and the regret of your career choices.',
  },
  {
    id: 'potion_deepdraught',
    name: 'Deepdraught',
    slot: 'consumable',
    rarity: 2,
    value: 78,
    restores: { hp: 60, mp: 30 },
    desc: 'Crushed cave-crystal in cold spring water. Miners swear it lets you see one tunnel further. Mostly it just stops the shivering.',
  },
  {
    id: 'food_miners_pasty',
    name: "Miner's Pasty",
    slot: 'consumable',
    rarity: 1,
    value: 26,
    restores: { hp: 35 },
    desc: 'A folded crust with a crimped edge you hold with sooty fingers and throw away. Structurally sound. Possibly load-bearing.',
  },
]

// ---------------------------------------------------------------------------
// NPCs — the town cluster at roughly (-104, -68): the confirmed open
// south-east lowland, south of the ravine mouth, clear of Dagna/Orin/Finn.
// Spaced 4-8 units apart, standing in open lanes between the cottages.
// ---------------------------------------------------------------------------
const npcs: NpcDef[] = [
  { id: 'npc_ironhold_warden_bexley', name: 'Pit-Warden Bexley', role: 'quests', regionId: 'ironhold', x: -104, z: -66 },
  { id: 'npc_ironhold_smelt_greta', name: 'Greta Emberhand', role: 'trainer', regionId: 'ironhold', x: -110, z: -70 },
  { id: 'npc_ironhold_vendor_tilda', name: 'Tilda Two-Scales', role: 'vendor', regionId: 'ironhold', x: -98, z: -72 },
  { id: 'npc_ironhold_quartermaster_odo', name: 'Quartermaster Odo', role: 'quests', regionId: 'ironhold', x: -108, z: -60 },
  { id: 'npc_ironhold_canary_pim', name: 'Pim the Canary', role: 'flavor', regionId: 'ironhold', x: -96, z: -64 },
  { id: 'npc_ironhold_deepwarden_hale', name: 'Deepwarden Hale', role: 'quests', regionId: 'ironhold', x: -112, z: -56 },
  { id: 'npc_ironhold_cook_marta', name: 'Crust-Cook Marta', role: 'flavor', regionId: 'ironhold', x: -100, z: -58 },
]

// ---------------------------------------------------------------------------
// Quests
// ---------------------------------------------------------------------------
const quests: QuestDef[] = [
  // --- Pit-Warden Bexley: the ore-quota chain -----------------------------
  {
    id: 'q_ironhold_welcome_to_deepdelve',
    title: 'Welcome to Deepdelve',
    giver: 'npc_ironhold_warden_bexley',
    regionId: 'ironhold',
    steps: [
      { kind: 'talk', target: 'npc_ironhold_smelt_greta', need: 1, label: 'Report to Greta at the forge' },
      { kind: 'talk', target: 'npc_ironhold_vendor_tilda', need: 1, label: 'Sign the ledger with Tilda' },
    ],
    rewards: { xp: { vitality: 70 }, items: [{ id: 'potion_cavebreath', qty: 2 }] },
    intro:
      "New boots on the mountain, good. Rules are simple: the forge never goes cold, the ledger never goes wrong, and you never go into the deep tunnels alone. Go meet Greta — she makes the metal — and Tilda, who makes the metal into my problem. Sign everything. Read nothing.",
    outro:
      "Greta likes you, which is rare, and Tilda already has a column with your name on it, which is inevitable. You're Deepdelve now. Try to stay attached to your fingers.",
  },
  {
    id: 'q_ironhold_copper_bottom',
    title: 'Copper-Bottomed Certainty',
    giver: 'npc_ironhold_warden_bexley',
    regionId: 'ironhold',
    steps: [{ kind: 'gather', target: 'copper_vein', need: 8, label: 'Work 8 copper veins' }],
    rewards: { xp: { mining: 120 }, items: [{ id: 'food_miners_pasty', qty: 3 }], blockCents: 40 },
    intro:
      "Copper's the easy stuff — soft, cheerful, sits near the surface like it wants to be found. Chip me eight veins' worth so I can tell the capital we met quota and they can go back to ignoring us. Pace yourself; it's a marathon of extremely small hills.",
    outro:
      "Eight veins, decent haul, only a moderate amount of complaining. That's a copper-bottomed shift. Have a pasty — Marta made forty and only three of them fought back.",
  },
  {
    id: 'q_ironhold_iron_will',
    title: 'Iron Will',
    giver: 'npc_ironhold_warden_bexley',
    regionId: 'ironhold',
    steps: [
      { kind: 'gather', target: 'iron_vein', need: 10, label: 'Work 10 iron veins' },
      { kind: 'collect', target: 'ore_iron', need: 6, label: 'Deliver 6 iron ore to the warden' },
    ],
    rewards: { xp: { mining: 180, blacksmithing: 80 }, items: [{ id: 'pick_iron', qty: 1 }] },
    intro:
      "Iron's where the mountain starts negotiating. It's deeper, it's meaner, and it does not care about your quota. Pull ten veins and hand me six good ore while you're at it — Greta needs feedstock and I need to look busy when the inspector comes. Bring your own stubbornness.",
    outro:
      "Six clean ore and a will to match. Take this pick — it's iron, it's honest, and it won't snap on you like the last one snapped on the last one of you.",
  },
  {
    id: 'q_ironhold_bandit_tolls',
    title: 'The Toll Troubles',
    giver: 'npc_ironhold_warden_bexley',
    regionId: 'ironhold',
    steps: [{ kind: 'kill', target: 'bandit', need: 8, label: 'Clear 8 road bandits' }],
    rewards: { xp: { attack: 160, defense: 60 }, items: [{ id: 'potion_hp_med', qty: 2 }], blockCents: 55 },
    intro:
      "A crew of bandits set up a 'toll' on the switchback and our ore carts keep arriving light and apologetic. There is one official tollkeeper on this mountain and it is me. Go un-employ eight of them. Tell them Deepdelve sends its regards, then don't say anything else.",
    outro:
      "The road's clear and the carts came in heavy for once. The bandits have relocated their business model to lying very still. Excellent customer service.",
  },

  // --- Quartermaster Odo: supply & logistics ------------------------------
  {
    id: 'q_ironhold_restock',
    title: 'Restocking the Racks',
    giver: 'npc_ironhold_quartermaster_odo',
    regionId: 'ironhold',
    steps: [
      { kind: 'collect', target: 'bar_iron', need: 5, label: 'Deliver 5 iron bars' },
      { kind: 'gather', target: 'clay_pit', need: 6, label: 'Dig 6 clay pits for the moulds' },
    ],
    rewards: { xp: { blacksmithing: 140, mining: 60 }, items: [{ id: 'potion_cavebreath', qty: 2 }] },
    intro:
      "I run supply, which means I run out of everything slightly before anyone needs it. Bring me five iron bars for the racks and six loads of clay for the casting moulds. Yes, clay. We're a mining town that runs on mud; don't make it weird.",
    outro:
      "Racks full, moulds ready, Odo briefly happy — a rare alignment of the spheres. Enjoy it. By tomorrow we'll be out of something again.",
  },
  {
    id: 'q_ironhold_crystal_quota',
    title: 'The Crystal Quota',
    giver: 'npc_ironhold_quartermaster_odo',
    regionId: 'ironhold',
    steps: [
      { kind: 'gather', target: 'crystal_node', need: 6, label: 'Mine 6 crystal nodes' },
      { kind: 'collect', target: 'crystal_raw', need: 4, label: 'Hand over 4 raw crystal' },
    ],
    rewards: { xp: { mining: 200 }, items: [{ id: 'potion_deepdraught', qty: 2 }], blockCents: 70 },
    intro:
      "The capital wants crystal now. Not 'soon', not 'when it's safe' — now, in writing, underlined twice. The nodes glow in the deep seams, which is lovely and also how the cave-things find you. Mine six, bring me four of the best, and watch the dark between swings.",
    outro:
      "Four crystals, cut-worthy, barely any screaming on the audio report. The capital gets its shiny rocks and we get to keep existing. A fair trade by mountain standards.",
  },
  {
    id: 'q_ironhold_pasty_problem',
    title: 'A Pasty Problem',
    giver: 'npc_ironhold_quartermaster_odo',
    regionId: 'ironhold',
    steps: [
      { kind: 'collect', target: 'wheat', need: 8, label: 'Bring Marta 8 wheat' },
      { kind: 'collect', target: 'mushroom_brown', need: 6, label: 'Forage 6 brown mushrooms' },
    ],
    rewards: { xp: { cooking: 120, farming: 50 }, items: [{ id: 'food_miners_pasty', qty: 4 }] },
    intro:
      "Morale is a resource and right now ours is a crumb. Marta can fix it with pasties, but a mining town grows rock, not wheat, so she needs eight wheat hauled up the switchback and six brown mushrooms for the filling. Feed the diggers and the diggers dig. It's basically alchemy.",
    outro:
      "Marta's got her filling and the crew's got full hands at last. A fed miner is a mildly-less-furious miner. Here — first batch, still structurally warm.",
  },

  // --- Deepwarden Hale: the cave-beast chain ------------------------------
  {
    id: 'q_ironhold_things_in_the_dark',
    title: 'Things in the Dark',
    giver: 'npc_ironhold_deepwarden_hale',
    regionId: 'ironhold',
    steps: [{ kind: 'kill', target: 'imp', need: 6, label: 'Cull 6 tunnel imps' }],
    rewards: { xp: { attack: 150, magic: 40 }, items: [{ id: 'potion_cavebreath', qty: 3 }] },
    intro:
      "Hush. Hear that skittering? Imps. They nest in the dead seams and steal tools, lamps, and the occasional apprentice. I'm the deepwarden — I keep the dark polite. Go into the old shaft and cull six. Don't bargain with them; they're very good at it and you are not.",
    outro:
      "Six imps quieter, six lamps un-stolen. The dark remembers who pushes back, and tonight it remembers you. Sleep with the light on anyway. I do.",
  },
  {
    id: 'q_ironhold_bonepickers',
    title: 'Bonepickers',
    giver: 'npc_ironhold_deepwarden_hale',
    regionId: 'ironhold',
    steps: [{ kind: 'kill', target: 'skeleton', need: 8, label: 'Put down 8 shaft skeletons' }],
    rewards: { xp: { attack: 190, defense: 90 }, items: [{ id: 'potion_hp_large', qty: 1 }], blockCents: 60 },
    intro:
      "Every mountain collects miners who didn't come back up, and some of them get bored. The bonepickers have started climbing toward the worked seams, which upsets the live miners for obvious, overlapping reasons. Put eight of them back to rest. Firmly. They've had their shift.",
    outro:
      "Eight laid down and the shaft's gone quiet the good way. The living crew says thanks; the former crew says nothing, which is the whole point.",
  },
  {
    id: 'q_ironhold_imp_infestation',
    title: 'Deep Infestation',
    giver: 'npc_ironhold_deepwarden_hale',
    regionId: 'ironhold',
    steps: [
      { kind: 'kill', target: 'imp', need: 10, label: 'Thin the imp nest by 10' },
      { kind: 'collect', target: 'crystal_shard', need: 3, label: 'Recover 3 crystal shards from the nest' },
    ],
    rewards: { xp: { attack: 220, mining: 80 }, items: [{ id: 'potion_deepdraught', qty: 2 }], blockCents: 80 },
    intro:
      "The imps got organized, which is the worst thing a problem can do. They've walled off a crystal seam and are hoarding the shards like tiny crooked bankers. Clear ten and bring me three shards back — partly as evidence, partly because Odo will cry if we leave good crystal down there.",
    outro:
      "Nest thinned, seam reclaimed, three shards shinier than the imps deserved. You're getting dangerously comfortable in the deep. That's either mastery or a warning. Probably both.",
  },
  {
    id: 'q_ironhold_gravelord',
    title: 'The Gravelord Stirs',
    giver: 'npc_ironhold_deepwarden_hale',
    regionId: 'ironhold',
    steps: [
      { kind: 'kill', target: 'golem', need: 4, label: 'Shatter 4 stone golems on the approach' },
      { kind: 'kill', target: 'boss_ironhold', need: 1, label: 'Fell the Gravelord Golem' },
      { kind: 'collect', target: 'crystal_raw', need: 5, label: 'Pry 5 raw crystal from its heart-seam' },
    ],
    rewards: {
      xp: { attack: 400, defense: 200, mining: 120 },
      items: [{ id: 'sword_steel', qty: 1 }, { id: 'potion_hp_huge', qty: 1 }],
      blockCents: 250,
    },
    intro:
      "The deep tremors aren't the mountain settling. They're the Gravelord — a golem the size of a guildhall that treats our tunnels as a renovation project. Its honor-guard of lesser golems walks the approach; break four, then break the big one. Dig the crystal out of its heart afterward. We don't waste good seam, even on a legend.",
    outro:
      "You walked back up from the deepest dark carrying the Gravelord's own crystal, and the tremors have stopped. Deepdelve will be telling this one wrong for a hundred years. Take the blade — you earned the right to never go down there again, and the certainty that you will anyway.",
  },

  // --- Quests from EXISTING Ironhold NPCs (from the map) -------------------
  {
    id: 'q_ironhold_smiths_apprentice',
    title: "The Smith's Shortlist",
    giver: 'smith_orin',
    regionId: 'ironhold',
    steps: [
      { kind: 'collect', target: 'ore_copper', need: 10, label: 'Bring Orin 10 copper ore' },
      { kind: 'gather', target: 'iron_vein', need: 6, label: 'Work 6 iron veins for the second heat' },
    ],
    rewards: { xp: { blacksmithing: 200, mining: 70 }, items: [{ id: 'hatchet_iron', qty: 1 }] },
    intro:
      "You want to learn the forge? Everyone does, right up until the sparks go down their collar. Prove you can feed it before you stand at it: ten copper ore and six iron veins' worth of raw. Carry it yourself. An apprentice who hires a cart is a customer.",
    outro:
      "Good ore, better arms. You hauled it without whining and that's ninety percent of smithing — the other ten is not setting yourself on fire. Here's a hatchet off my own rack. Don't embarrass it.",
  },
  {
    id: 'q_ironhold_lost_pick',
    title: "Finn's Lost Lucky Pick",
    giver: 'prospector_finn',
    regionId: 'ironhold',
    steps: [
      { kind: 'kill', target: 'bandit', need: 5, label: 'Shake down 5 bandits for the pick' },
      { kind: 'explore', target: 'ironhold', need: 1, label: 'Search the Ironhold slopes' },
    ],
    rewards: { xp: { attack: 120, mining: 60 }, items: [{ id: 'potion_mystery', qty: 1 }], blockCents: 45 },
    intro:
      "Some light-fingered road bandit lifted my lucky pick — forty years of ore came off that handle and I am not emotionally prepared to buy a new one. Rough up five of them until the pick falls out of somebody's bag, and scour the slopes while you're at it. It glows faintly, like my mood does not.",
    outro:
      "You found it! Scuffed, bent, lucky as ever. A prospector without his pick is just a sad man staring at hills, and I was two days from that fate. Take a mystery potion from my stash — even I don't know what's in it, which is the fun.",
  },
]

// ---------------------------------------------------------------------------
// Prereq chains
// ---------------------------------------------------------------------------
const prereqs: Record<string, readonly string[]> = {
  q_ironhold_copper_bottom: ['q_ironhold_welcome_to_deepdelve'],
  q_ironhold_iron_will: ['q_ironhold_copper_bottom'],
  q_ironhold_bandit_tolls: ['q_ironhold_iron_will'],
  q_ironhold_crystal_quota: ['q_ironhold_restock'],
  q_ironhold_pasty_problem: ['q_ironhold_restock'],
  q_ironhold_bonepickers: ['q_ironhold_things_in_the_dark'],
  q_ironhold_imp_infestation: ['q_ironhold_bonepickers'],
  q_ironhold_gravelord: ['q_ironhold_imp_infestation'],
}

// ---------------------------------------------------------------------------
// Display names for the new item ids (quests module keeps its own table)
// ---------------------------------------------------------------------------
const itemNames: Record<string, string> = {
  potion_cavebreath: 'Cavebreath Tonic',
  potion_deepdraught: 'Deepdraught',
  food_miners_pasty: "Miner's Pasty",
}

// ---------------------------------------------------------------------------
// Recipes — inputs/outputs are real catalog ids or items added above.
//   Alchemy/cooking gate on the base profession unlocks; the blacksmithing
//   recipe has no gate (gated by level only, per the recipe map).
// ---------------------------------------------------------------------------
const recipes: Recipe[] = [
  {
    id: 'alchemy:potion_cavebreath',
    skill: 'alchemy',
    levelReq: 10,
    inputs: [{ id: 'herb_green', qty: 2 }, { id: 'herb_red', qty: 1 }],
    output: { id: 'potion_cavebreath', qty: 1 },
    xp: 22,
    gate: 'unlock:brew',
  },
  {
    id: 'alchemy:potion_deepdraught',
    skill: 'alchemy',
    levelReq: 18,
    inputs: [{ id: 'crystal_shard', qty: 1 }, { id: 'herb_blue', qty: 2 }],
    output: { id: 'potion_deepdraught', qty: 1 },
    xp: 34,
    gate: 'unlock:brew',
  },
  {
    id: 'cooking:food_miners_pasty',
    skill: 'cooking',
    levelReq: 8,
    inputs: [{ id: 'wheat', qty: 2 }, { id: 'mushroom_brown', qty: 2 }],
    output: { id: 'food_miners_pasty', qty: 2 },
    xp: 16,
    gate: 'unlock:cook',
  },
  {
    id: 'blacksmithing:pick_steel',
    skill: 'blacksmithing',
    levelReq: 20,
    inputs: [{ id: 'bar_steel', qty: 2 }, { id: 'wood_pine', qty: 1 }],
    output: { id: 'pick_steel', qty: 1 },
    xp: 40,
  },
]

// ---------------------------------------------------------------------------
// Town — Deepdelve. A modest cluster of cottages + smithy around a stone well
// and a signpost, at the confirmed open lowland (~ -104,-68). Within region
// bounds (x -240..-80, z -120..120), far from the capital keep and from the
// region's existing NPC anchors (Dagna -120,0 / Orin -150,30 / Finn -190,-40).
// No lanterns: kitLantern needs a THREE.Scene and the town hook only gets Ctx.
// ---------------------------------------------------------------------------
const C_STONE = 0x8c8a86
const C_WATER = 0x3a79b8
const C_WOOD = 0x6b4a2b
const C_ROOF = 0x4a6b3a

function cellClear(ctx: Ctx, ix: number, iz: number): boolean {
  return (
    isLand(ix + 0.5, iz + 0.5) &&
    surfaceAt(ctx, ix, iz) === S_GRASS &&
    !ctx.grid.isBlocked(ix + 0.5, iz + 0.5)
  )
}

function footprintClear(ctx: Ctx, x0: number, z0: number, w: number, d: number): boolean {
  for (let ix = x0; ix < x0 + w; ix++) {
    for (let iz = z0; iz < z0 + d; iz++) {
      if (!cellClear(ctx, ix, iz)) return false
    }
  }
  return true
}

/** Stone well: a 3x3 rim with a glowing water cell and a little wooden canopy. */
function buildWell(ctx: Ctx, wx: number, wz: number): void {
  if (!footprintClear(ctx, wx - 1, wz - 1, 3, 3)) return
  const { batches, grid } = ctx
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue
      batches.stone.add(wx + dx, 0, wz + dz, 1, 1.2, 1, C_STONE)
    }
  }
  // water surface (emissive window batch = soft glow, no point-light cost)
  batches.window.add(wx, 0.2, wz, 1, 0.2, 1, C_WATER)
  // two corner posts + a plank canopy
  batches.wood.add(wx - 1, 1.2, wz - 1, 0.3, 2.6, 0.3, C_WOOD)
  batches.wood.add(wx + 0.7, 1.2, wz + 0.7, 0.3, 2.6, 0.3, C_WOOD)
  batches.roof.add(wx - 1.2, 3.6, wz - 1.2, 2.7, 0.4, 2.7, C_ROOF)
  grid.blockRect(wx - 1, wz - 1, 3, 3)
}

/** Signpost: a post with a crossboard. */
function buildSignpost(ctx: Ctx, sx: number, sz: number): void {
  if (!cellClear(ctx, sx, sz)) return
  const { batches, grid } = ctx
  batches.wood.add(sx - 0.15, 0, sz - 0.15, 0.3, 2.4, 0.3, C_WOOD)
  batches.wood.add(sx - 1, 1.6, sz - 0.08, 2, 0.6, 0.16, C_WOOD)
  grid.block(sx, sz)
}

function town(ctx: Ctx): void {
  // Buildings (kitHouseShell self-blocks its footprint). Guard each so we
  // never overwrite the region's baked scatter.
  const shells: Array<{ x0: number; z0: number; w: number; d: number; wallH: number; door: 'N' | 'S' | 'E' | 'W'; chimney?: boolean }> = [
    { x0: -108, z0: -86, w: 9, d: 7, wallH: 4, door: 'S', chimney: true }, // Overseer's Longhall
    { x0: -120, z0: -82, w: 8, d: 6, wallH: 3, door: 'E', chimney: true }, // The Deepdelve Smithy
    { x0: -94, z0: -84, w: 7, d: 6, wallH: 3, door: 'W', chimney: true }, // Quartermaster's Store
    { x0: -122, z0: -62, w: 6, d: 5, wallH: 3, door: 'E', chimney: true }, // Miner's Cottage A
    { x0: -90, z0: -66, w: 6, d: 5, wallH: 3, door: 'W' }, // Miner's Cottage B
  ]
  for (const b of shells) {
    if (footprintClear(ctx, b.x0, b.z0, b.w, b.d)) kitHouseShell(ctx, b)
  }

  // Cobble lanes: a main street through the well, plus door spurs.
  kitPath(ctx, [[-118, -68], [-110, -68], [-103, -68], [-96, -68], [-89, -66]])
  kitPath(ctx, [[-103, -68], [-104, -80], [-104, -86]])
  kitPath(ctx, [[-110, -68], [-116, -62], [-120, -60]])
  kitPath(ctx, [[-96, -68], [-91, -64]])

  // Well + signpost at the heart of the lane.
  buildWell(ctx, -103, -68)
  buildSignpost(ctx, -100, -66)

  // A short paddock rail by the smithy.
  if (footprintClear(ctx, -118, -74, 8, 1)) kitFenceRun(ctx, -118, -74, 8, true)

  // Mountain dressing: pines + rock outcrops around the rim (each gated).
  const pines: Array<[number, number]> = [[-124, -70], [-122, -78], [-88, -78], [-86, -60], [-118, -48]]
  for (const [ix, iz] of pines) if (cellClear(ctx, ix, iz)) kitPine(ctx, ix, iz, { tall: true })

  const rocks: Array<[number, number, 1 | 2]> = [[-126, -64, 2], [-84, -72, 1], [-111, -89, 2], [-92, -54, 1]]
  for (const [ix, iz, s] of rocks) if (footprintClear(ctx, ix, iz, s, s)) kitRock(ctx, ix, iz, s)

  // An outlying prospector's hut up the slope.
  if (footprintClear(ctx, -120, -52, 4, 4)) kitHut(ctx, -120, -52)
}

registerPack({ items, npcs, quests, prereqs, itemNames, recipes, town })
