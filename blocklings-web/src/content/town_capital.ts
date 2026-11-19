/**
 * Content pack — The Royal Capital ('capital') town: Crownhaven, the bustling
 * lower-town quarter wedged between the market's east edge and the east rampart,
 * a comfortable distance from the enterable castle keep. Civic / guard / mage /
 * market questlines for the higher-level crowd, a modest hamlet of cottages +
 * a well + signpost, two recipes, and two new consumables.
 *
 * Everything references real ids from the canonical maps except the two items
 * this pack introduces (food_guard_rations, potion_scholars_tonic), which ship
 * in items:[] and are then free to appear in rewards/recipes.
 */
import { registerPack } from './packs'
import type { NpcDef } from '../ids'
import type { QuestDef, ItemDef } from '../types'
import type { Recipe } from '../crafting/recipes'
import type { Ctx } from '../world/layout'
import { kitHouseShell, kitPath, kitTree, kitRock, kitFenceRun } from '../world/kit'

// ---------------------------------------------------------------------------
// New catalog items (food_* / potion_* prefixes so they render a real mesh)
// ---------------------------------------------------------------------------

const ITEMS: ItemDef[] = [
  {
    id: 'food_guard_rations',
    name: 'Guard Rations',
    slot: 'consumable',
    rarity: 1,
    value: 18,
    restores: { hp: 45 },
    desc: 'Dense, salty, and engineered by committee to be eaten standing up during a double shift. The crumbs are a city-wide pigeon stimulus package.',
  },
  {
    id: 'potion_scholars_tonic',
    name: "Scholar's Tonic",
    slot: 'consumable',
    rarity: 2,
    value: 32,
    restores: { mp: 55 },
    desc: 'Brewed by the archive to keep candle-blind clerks upright past midnight. Tastes of blue herb, ground crystal, and mild existential dread. Restores mana; does not restore the will to re-file anything.',
  },
]

// ---------------------------------------------------------------------------
// NPCs — Crownhaven, the SE lower-town quarter (x 46..67, z -102..-136).
// Clear of the castle keep (x -14..14, z -222..-202), the market plaza, the
// bank, and every existing capital anchor (Elara/Aldous/Lyra). Spaced ~4-8.
// ---------------------------------------------------------------------------

const NPCS: NpcDef[] = [
  { id: 'npc_capital_warden', name: 'Lord-Warden Cassius', role: 'quests', regionId: 'capital', x: 54, z: -106 },
  { id: 'npc_capital_quartermaster', name: 'Quartermaster Bette', role: 'vendor', regionId: 'capital', x: 60, z: -110 },
  { id: 'npc_capital_magus', name: 'Court Magus Pim', role: 'trainer', regionId: 'capital', x: 48, z: -114 },
  { id: 'npc_capital_sergeant', name: 'Sergeant Hobbs', role: 'quests', regionId: 'capital', x: 64, z: -118 },
  { id: 'npc_capital_marketeer', name: 'Market-Mistress Odile', role: 'quests', regionId: 'capital', x: 58, z: -130 },
  { id: 'npc_capital_archivist', name: 'Archivist Wenna', role: 'quests', regionId: 'capital', x: 66, z: -132 },
  { id: 'npc_capital_herald', name: 'Herald Fipp', role: 'flavor', regionId: 'capital', x: 50, z: -126 },
  { id: 'npc_capital_tinker', name: 'Tinker Dobbs', role: 'flavor', regionId: 'capital', x: 46, z: -122 },
]

// ---------------------------------------------------------------------------
// Quests — higher-level civic/guard/mage/market work. 'kill' steps target the
// tier-3/4 wilderness species (skeleton/bandit/imp/golem/orc/wisp) the capital's
// adventurers go abroad to hunt; gather/collect use real nodes + catalog ids.
// ---------------------------------------------------------------------------

const QUESTS: QuestDef[] = [
  // --- Lord-Warden Cassius: the civic onboarding chain -------------------
  {
    id: 'q_capital_papers_please',
    title: 'Papers, Please',
    giver: 'npc_capital_warden',
    regionId: 'capital',
    steps: [
      { kind: 'talk', target: 'npc_capital_quartermaster', need: 1, label: 'Register with Quartermaster Bette' },
      { kind: 'talk', target: 'npc_capital_sergeant', need: 1, label: 'Report to Sergeant Hobbs' },
    ],
    rewards: { xp: { vitality: 120 }, items: [{ id: 'ring_participation', qty: 1 }], blockCents: 40 },
    intro:
      "So. Another hero wanders into the capital expecting a parade. We don't do parades on a Tuesday. We do PAPERWORK. Register with Bette — she inventories everything, including your hopes — and report to Hobbs on the wall. Come back when you exist on at least two ledgers.",
    outro:
      "You're now triple-filed, which in this city is a kind of knighthood. Welcome to Crownhaven. Try not to generate too much new paperwork; some of us are already behind.",
  },
  {
    id: 'q_capital_crypt_contract',
    title: 'The Crypt Contract',
    giver: 'npc_capital_warden',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'skeleton', need: 10, label: 'Put down 10 skeletons' },
      { kind: 'collect', target: 'bar_steel', need: 4, label: 'Deliver 4 steel bars for new gratings' },
    ],
    rewards: { xp: { attack: 240, defense: 120 }, items: [{ id: 'potion_hp_med', qty: 3 }], blockCents: 90 },
    intro:
      "The old royal crypts have developed a tenant problem — specifically, the tenants are up and walking, which violates roughly every clause of their lease. Go explain the terms to ten skeletons with whatever's sharpest, and bring back four steel bars so the smiths can re-grate the gates. Mortality is non-negotiable here.",
    outro:
      "Ten tenants evicted, four bars delivered, gratings re-hung. The crypt is once again merely creepy rather than actively ambulatory. The city sleeps slightly better, and the dead sleep considerably more.",
  },
  {
    id: 'q_capital_coronation_guest',
    title: 'An Awkward Coronation Guest',
    giver: 'npc_capital_warden',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'golem', need: 6, label: 'Dismantle 6 rampaging golems' },
      { kind: 'talk', target: 'captain_elara', need: 1, label: 'Debrief Captain Elara' },
    ],
    rewards: { xp: { defense: 300, attack: 150 }, items: [{ id: 'food_guard_rations', qty: 4 }], blockCents: 120 },
    intro:
      "A hedge-mage animated six stone golems as 'festive statues' for the coronation. The statues then developed opinions. Opinions with fists. Reduce all six back to charming rubble and debrief Captain Elara — she loves a tidy incident report almost as much as she hates the word 'festive'.",
    outro:
      "Six golems, now gravel; Elara, now smug. The coronation proceeded with statues that stayed statues, which guests described as 'refreshingly structural'. Fine work.",
  },

  // --- Quartermaster Bette: the supply logistics line -------------------
  {
    id: 'q_capital_supply_run',
    title: 'The Supply Run',
    giver: 'npc_capital_quartermaster',
    regionId: 'capital',
    steps: [
      { kind: 'gather', target: 'iron_vein', need: 12, label: 'Mine 12 iron veins' },
      { kind: 'collect', target: 'wood_oak', need: 8, label: 'Hand in 8 oak logs' },
    ],
    rewards: { xp: { mining: 200, woodcutting: 120 }, items: [{ id: 'pick_steel', qty: 1 }], blockCents: 60 },
    intro:
      "The castle runs on three things: iron, timber, and me quietly weeping over the budget. The quarry's short twelve veins of iron and the yards are short eight oak. Fetch both before the Treasurer notices and invents a fourth thing to run on. Here's a requisition chit; it's worth exactly nothing and I need it back.",
    outro:
      "Iron logged, oak stacked, chit returned, budget survived another day. You, requisition-filer of rare competence, may keep the good pick. Don't tell anyone I own a good pick.",
  },
  {
    id: 'q_capital_kitchen_crisis',
    title: 'Below-Stairs Crisis',
    giver: 'npc_capital_quartermaster',
    regionId: 'capital',
    steps: [
      { kind: 'collect', target: 'fish_salmon', need: 5, label: 'Supply 5 salmon to the kitchens' },
      { kind: 'gather', target: 'farm_plot', need: 8, label: 'Harvest 8 wheat from the royal plots' },
    ],
    rewards: { xp: { cooking: 180, farming: 120, fishing: 80 }, items: [{ id: 'food_guard_rations', qty: 3 }], blockCents: 50 },
    intro:
      "The kitchens have declared a crisis, which for them means a Thursday. The guard mess is out of salmon and the royal plots went unharvested because the gardener 'needed space'. Five salmon, eight wheat, before three hundred hungry soldiers turn their opinions toward management. Me. I am management.",
    outro:
      "Salmon in the smoker, wheat in the mill, mutiny averted by a margin of about two loaves. Cook says you have 'a dependable face', which is the highest praise anyone below-stairs has ever received.",
  },

  // --- Sergeant Hobbs: the wall-watch line ------------------------------
  {
    id: 'q_capital_wall_watch',
    title: 'Wall Watch',
    giver: 'npc_capital_sergeant',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'bandit', need: 12, label: 'Scatter 12 road bandits' },
      { kind: 'collect', target: 'hide_tough', need: 5, label: 'Turn in 5 tough hides for new jerkins' },
    ],
    rewards: { xp: { attack: 200, defense: 160 }, items: [{ id: 'chest_steel', qty: 1 }], blockCents: 70 },
    intro:
      "Bandits have been taxing the trade road, which is MY job, technically. Twelve of them, back into the ditch they came from. While you're out there, strip five tough hides — the recruits keep patrolling in jerkins you can see through, and morale is already transparent enough.",
    outro:
      "Road's clear, recruits are opaque again, and the bandits have taken their business to someone else's jurisdiction. That's the dream, really: making your problems become a different sergeant's problems.",
  },
  {
    id: 'q_capital_gate_breakers',
    title: 'The Gate-Breakers',
    giver: 'npc_capital_sergeant',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'orc', need: 9, label: 'Break up a 9-strong orc raiding party' },
      { kind: 'talk', target: 'npc_capital_warden', need: 1, label: 'Report the raid to Lord-Warden Cassius' },
    ],
    rewards: { xp: { attack: 360, defense: 200 }, items: [{ id: 'shield_steel', qty: 1 }, { id: 'potion_hp_large', qty: 2 }], blockCents: 140 },
    intro:
      "A warband of orcs has been testing the outer gates like rude houseguests who keep rattling the handle. Nine of them, this season's worst. Go introduce them to the concept of 'no', then tell the Warden so he can feel important about it. Take a good shield — they hit like a dropped portcullis.",
    outro:
      "Nine orcs persuaded that our gates are, in fact, closed. The Warden has already started a memo titled 'My Timely Response To The Raid'. You did the work; he'll do the filing. Balance, of a sort.",
  },

  // --- Court Magus Pim: the arcane line ---------------------------------
  {
    id: 'q_capital_arcane_dust',
    title: 'Arcane Dust Shortage',
    giver: 'npc_capital_magus',
    regionId: 'capital',
    steps: [
      { kind: 'gather', target: 'crystal_node', need: 10, label: 'Mine 10 crystal nodes' },
      { kind: 'collect', target: 'crystal_shard', need: 6, label: 'Grind out 6 crystal shards' },
    ],
    rewards: { xp: { magic: 220, mining: 100 }, items: [{ id: 'potion_mp_med', qty: 3 }], blockCents: 60 },
    intro:
      "The court's wards run on ground crystal, and we are, in the technical magical terminology, 'nearly out of the stuff'. Bring me ten crystal nodes and six proper shards. And do mine them gently — raw crystal that's been whacked by an amateur sulks for weeks and refuses to glow.",
    outro:
      "Beautiful resonance, no sulking. The wards are humming at full brightness again, which means the eastern tower has stopped letting weather in through dimensions it has no business owning. Good hands, that.",
  },
  {
    id: 'q_capital_wisp_wrangle',
    title: 'Wrangle the Wisps',
    giver: 'npc_capital_magus',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'wisp', need: 8, label: 'Banish 8 loose wisps' },
      { kind: 'talk', target: 'mage_lyra', need: 1, label: 'Confer with Archmage Lyra' },
    ],
    rewards: { xp: { magic: 340, vitality: 120 }, items: [{ id: 'staff_steel', qty: 1 }, { id: 'potion_scholars_tonic', qty: 2 }], blockCents: 110 },
    intro:
      "My last containment ritual went 'statistically interesting', which is magus for 'eight wisps escaped'. They drift about discharging static into anyone with a metal buckle. Banish all eight, then go tell Archmage Lyra it was definitely a 'calibration event' and absolutely not my fault. Word it kindly. She grades.",
    outro:
      "All eight wisps dispersed, and Lyra has agreed to call it a 'calibration event' in exchange for never hearing the phrase again. Take the staff and the tonic. The tonic is for the paperwork; the staff is for the next calibration event.",
  },

  // --- Archivist Wenna: the records line --------------------------------
  {
    id: 'q_capital_overdue_tomes',
    title: 'Catastrophically Overdue',
    giver: 'npc_capital_archivist',
    regionId: 'capital',
    steps: [
      { kind: 'collect', target: 'herb_blue', need: 8, label: 'Gather 8 blue herbs for ink' },
      { kind: 'talk', target: 'npc_capital_magus', need: 1, label: 'Verify the recipe with Court Magus Pim' },
    ],
    rewards: { xp: { herbalism: 180, alchemy: 140 }, items: [{ id: 'potion_scholars_tonic', qty: 2 }], blockCents: 45 },
    intro:
      "A royal ancestor borrowed the Grand Ledger four hundred years ago and has yet to return it, the scoundrel, being dead. I'm re-copying it from memory, but I'm out of the blue ink that doesn't fade. Eight blue herbs, and check the fixative with Pim — last batch I made glowed and then evaporated, taking a decade of tax records with it.",
    outro:
      "Proper, non-evaporating ink at last. The Grand Ledger lives again, four centuries overdue, with a fine I've calculated at 'the entire kingdom plus interest'. I've decided to waive it. Magnanimous, aren't I.",
  },
  {
    id: 'q_capital_imps_in_stacks',
    title: 'Imps in the Stacks',
    giver: 'npc_capital_archivist',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'imp', need: 11, label: 'Clear 11 imps from the sub-archive' },
      { kind: 'gather', target: 'oak_tree', need: 6, label: 'Fell 6 oaks for new shelving' },
    ],
    rewards: { xp: { attack: 200, woodcutting: 140, magic: 60 }, items: [{ id: 'food_pie', qty: 2 }], blockCents: 55 },
    intro:
      "Imps have nested in the lower stacks and are eating the footnotes — the FOOTNOTES, where all the good gossip lives. Eleven of them, out. And fetch six oaks; they chewed through the shelving and now section J is just a sad pile of history on the floor. History deserves a shelf.",
    outro:
      "Eleven imps relocated to the great hereafter and section J is vertical once more. The footnotes that survived are, frankly, scandalous. I may have to redact a few before they reach the public. For the realm's dignity. And my own entertainment.",
  },

  // --- Market-Mistress Odile: the commerce line -------------------------
  {
    id: 'q_capital_market_day',
    title: 'Market Day Panic',
    giver: 'npc_capital_marketeer',
    regionId: 'capital',
    steps: [
      { kind: 'collect', target: 'berry_red', need: 10, label: 'Buy up 10 red berries for the tart stall' },
      { kind: 'collect', target: 'mushroom_brown', need: 8, label: 'Secure 8 brown mushrooms' },
    ],
    rewards: { xp: { herbalism: 160, cooking: 100 }, items: [{ id: 'food_berry_tart', qty: 3 }], blockCents: 65 },
    intro:
      "It's market day, half my suppliers have 'gone to find themselves' in the hills, and the pie-wife is threatening to cry on a nobleman. I need ten red berries and eight brown mushrooms ON MY STALL within the hour or the whole east quarter smells disappointment. Go. Haggle. Intimidate a shrub if you must.",
    outro:
      "Berries and mushrooms, delivered, and the pie-wife has downgraded from crying to merely glowering. Market day holds. You've a merchant's eye — if you ever tire of heroics, there's a stall here with your name on it and a terrifying lease.",
  },
  {
    id: 'q_capital_caravan_guard',
    title: 'Caravan Duty',
    giver: 'npc_capital_marketeer',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'goblin', need: 14, label: 'Drive off 14 goblin road-thieves' },
      { kind: 'talk', target: 'banker_aldous', need: 1, label: 'Deposit the caravan takings with Banker Aldous' },
    ],
    rewards: { xp: { attack: 180, vitality: 160 }, items: [{ id: 'amulet_block', qty: 1 }, { id: 'potion_vigor', qty: 2 }], blockCents: 160 },
    intro:
      "A spice caravan's coming in and the road's thick with goblins who've confused 'commerce' for 'buffet'. Shoo fourteen of the little tariff-dodgers off the route, then march the takings straight to Banker Aldous before anyone — including you, no offense, lots of offense — gets a creative idea about a handling fee.",
    outro:
      "Caravan's in, goblins are out, and Aldous has the takings under roughly nine locks and a glare. He even smiled, which the staff logged as a 'seismic event'. Take the amulet; you earned the realm a very profitable afternoon.",
  },
]

// ---------------------------------------------------------------------------
// Prereq chains (gate the later/harder quests behind the intro work).
// ---------------------------------------------------------------------------

const PREREQS: Record<string, readonly string[]> = {
  q_capital_crypt_contract: ['q_capital_papers_please'],
  q_capital_coronation_guest: ['q_capital_crypt_contract'],
  q_capital_gate_breakers: ['q_capital_wall_watch'],
  q_capital_wisp_wrangle: ['q_capital_arcane_dust'],
  q_capital_imps_in_stacks: ['q_capital_overdue_tomes'],
  q_capital_caravan_guard: ['q_capital_market_day'],
  q_capital_kitchen_crisis: ['q_capital_supply_run'],
}

// ---------------------------------------------------------------------------
// Recipes — craftable once the skill's base unlock is owned.
// ---------------------------------------------------------------------------

const RECIPES: Recipe[] = [
  {
    id: 'cooking:food_guard_rations',
    skill: 'cooking',
    levelReq: 25,
    inputs: [
      { id: 'wheat', qty: 2 },
      { id: 'fish_trout', qty: 1 },
      { id: 'mushroom_brown', qty: 1 },
    ],
    output: { id: 'food_guard_rations', qty: 2 },
    xp: 22,
    gate: 'unlock:cook',
  },
  {
    id: 'alchemy:potion_scholars_tonic',
    skill: 'alchemy',
    levelReq: 30,
    inputs: [
      { id: 'herb_blue', qty: 2 },
      { id: 'crystal_shard', qty: 1 },
    ],
    output: { id: 'potion_scholars_tonic', qty: 1 },
    xp: 28,
    gate: 'unlock:brew',
  },
]

// ---------------------------------------------------------------------------
// Town build — "Crownhaven", the SE lower-town hamlet (x 46..67, z -100..-142).
// Four cottages around a cobbled plaza with a stone well + signpost, two warm
// lanterns, a shade tree, a rock, and a short fence run. Well clear of the
// castle keep (x -14..14, z -222..-202), the market plaza, and every anchor.
// ---------------------------------------------------------------------------

function buildWell(ctx: Ctx, cx: number, cz: number): void {
  const { batches, grid } = ctx
  const STONE = 0x8a8a84
  const WOODC = 0x5a3f28
  const ROOFC = 0x3f6b3a
  // 3x3 stone rim (the four straight sides)
  batches.stone.add(cx - 1.5, 0, cz - 1.5, 3, 0.9, 0.6, STONE)
  batches.stone.add(cx - 1.5, 0, cz + 0.9, 3, 0.9, 0.6, STONE)
  batches.stone.add(cx - 1.5, 0, cz - 0.9, 0.6, 0.9, 1.8, STONE)
  batches.stone.add(cx + 0.9, 0, cz - 0.9, 0.6, 0.9, 1.8, STONE)
  // water (emissive window batch so it glints with the night lights)
  batches.window.add(cx - 0.9, 0.2, cz - 0.9, 1.8, 0.2, 1.8, 0x2f5f94)
  // two posts + a little green roof over the bucket
  batches.wood.add(cx - 1.2, 0.9, cz - 0.1, 0.3, 2.6, 0.3, WOODC)
  batches.wood.add(cx + 0.9, 0.9, cz - 0.1, 0.3, 2.6, 0.3, WOODC)
  batches.roof.add(cx - 1.6, 3.4, cz - 0.8, 3.4, 0.5, 1.6, ROOFC)
  grid.blockRect(cx - 1, cz - 1, 3, 3)
}

/** A lantern POST without a point light (town builders get no scene) — the
 *  emissive window cube flickers warm with the village night lights, zero
 *  light-budget cost. Self-blocks its cell. */
function buildLanternPost(ctx: Ctx, ix: number, iz: number): void {
  const { batches, grid } = ctx
  const WOODC = 0x3a2b1c
  batches.wood.add(ix + 0.38, 0, iz + 0.38, 0.24, 2.3, 0.24, WOODC)
  batches.wood.add(ix + 0.38, 2.3, iz + 0.1, 0.24, 0.16, 0.8, WOODC)
  batches.window.add(ix + 0.3, 1.95, iz + 0.02, 0.4, 0.45, 0.4, 0xffd27a)
  grid.block(ix, iz)
}

function buildSignpost(ctx: Ctx, cx: number, cz: number): void {
  const { batches, grid } = ctx
  const WOODC = 0x6b4a2c
  batches.wood.add(cx, 0, cz, 0.3, 2.3, 0.3, WOODC)
  batches.wood.add(cx - 0.9, 1.5, cz - 0.05, 1.9, 0.5, 0.18, WOODC) // one arm
  batches.wood.add(cx - 0.2, 0.9, cz - 0.05, 1.5, 0.4, 0.18, WOODC) // lower arm
  grid.block(Math.round(cx), Math.round(cz))
}

function buildTown(ctx: Ctx): void {
  // Plaza + lanes first (surface stamping must precede the ground/instancing pass).
  kitPath(ctx, [
    [51, -100],
    [55, -108],
    [57, -118],
    [57, -128],
    [62, -138],
  ])
  kitPath(ctx, [[57, -118], [66, -118]], 1.2) // spur east toward the sergeant's post
  kitPath(ctx, [[57, -118], [48, -122]], 1.2) // spur west toward the tinker

  // Four cottages (kitHouseShell self-blocks its footprint; village-green roofs).
  kitHouseShell(ctx, { x0: 48, z0: -102, w: 7, d: 5, wallH: 4, door: 'S', chimney: true }) // Watch Hall
  kitHouseShell(ctx, { x0: 61, z0: -104, w: 6, d: 5, wallH: 3, door: 'S' }) // cottage
  kitHouseShell(ctx, { x0: 46, z0: -138, w: 6, d: 5, wallH: 3, door: 'N' }) // cottage
  kitHouseShell(ctx, { x0: 61, z0: -142, w: 6, d: 6, wallH: 4, door: 'N', chimney: true }) // Counting-House

  // Centerpiece well + signpost on the plaza.
  buildWell(ctx, 57, -119)
  buildSignpost(ctx, 53, -116)

  // Dressing — a short fence, a couple of shade trees, a rock. Lanterns: 2 only.
  kitFenceRun(ctx, 46, -112, 5, false) // rail along +Z, west edge
  kitTree(ctx, 68, -110)
  kitTree(ctx, 49, -134)
  kitRock(ctx, 67, -128, 1)
  buildLanternPost(ctx, 52, -119)
  buildLanternPost(ctx, 62, -120)
}

// ---------------------------------------------------------------------------

registerPack({
  items: ITEMS,
  npcs: NPCS,
  quests: QUESTS,
  prereqs: PREREQS,
  recipes: RECIPES,
  itemNames: {
    food_guard_rations: 'Guard Rations',
    potion_scholars_tonic: "Scholar's Tonic",
  },
  town: buildTown,
})
