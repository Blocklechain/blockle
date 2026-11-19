/**
 * town_beginnings.ts — CONTENT PACK for the Kingdom of Beginnings (regionId
 * 'beginnings'): the lvl 1-5 starter meadow.
 *
 * Adds the hamlet of "Thistledown" — a modest cluster of cottages, a town
 * hall, a well and a signpost on open meadow SE of Elder Rowan's village
 * green — plus its townsfolk (quest-givers, a vendor, a trainer, two flavor
 * locals) and a run of gentle intro quests: splat slimes, stomp shroomlings,
 * pinch crabs, chop oak, pan the shallows, and learn to cook/brew a little.
 *
 * Every referenced id (species / node-kind / item / npc / region) is real per
 * the canonical maps; the only NEW ids are the two consumables declared in
 * `items` below (and their recipes). Writing register: dry, warm, PG-13.
 */
import { registerPack } from './packs'
import type { NpcDef } from '../ids'
import type { QuestDef, ItemDef } from '../types'
import type { Recipe } from '../crafting/recipes'
import type { Ctx } from '../world/layout'
import {
  kitHouseShell,
  kitPath,
  kitTree,
  kitRock,
  kitFenceRun,
  isLand
} from '../world/kit'
import { S_GRASS, surfaceAt } from '../world/layout'

// ---------------------------------------------------------------------------
// NEW ITEMS (food_* so they render via the food mesh family)
// ---------------------------------------------------------------------------
const ITEMS: ItemDef[] = [
  {
    id: 'food_meadowcake',
    name: 'Meadow Honeycake',
    slot: 'consumable',
    rarity: 1,
    value: 14,
    restores: { hp: 30 },
    desc: 'A dense little cake of meadow honey and wheat. Billed as "good for morale"; mostly good for crumbs down your shirt.',
  },
  {
    id: 'potion_meadow_tonic',
    name: 'Meadow Tonic',
    slot: 'consumable',
    rarity: 1,
    value: 16,
    restores: { hp: 20, mp: 20 },
    desc: 'Steeped herbs and a crushed berry. Tastes like a lawn, works like a nap. Thistledown swears by it; Thistledown swears by a lot of things.',
  },
]

// ---------------------------------------------------------------------------
// NEW NPCs — the hamlet of Thistledown, SE meadow (plaza center ~ x38, z-36).
// Spaced ~4-8 units apart, well clear of the village-green anchors at the
// origin (elder_rowan 3,-6 / hilda 8,7 / bram -14,16 / tomas 0,20).
// ---------------------------------------------------------------------------
const NPCS: NpcDef[] = [
  { id: 'npc_beginnings_marigold', name: 'Mayor Marigold', role: 'quests', regionId: 'beginnings', x: 36, z: -34 },
  { id: 'npc_beginnings_tobias', name: 'Baker Tobias', role: 'quests', regionId: 'beginnings', x: 42, z: -32 },
  { id: 'npc_beginnings_posey', name: 'Gardener Posey', role: 'quests', regionId: 'beginnings', x: 28, z: -30 },
  { id: 'npc_beginnings_perch', name: 'Angler Perch', role: 'quests', regionId: 'beginnings', x: 30, z: -40 },
  { id: 'npc_beginnings_hazel', name: 'Drillmaster Hazel', role: 'trainer', regionId: 'beginnings', x: 34, z: -42 },
  { id: 'npc_beginnings_cobb', name: 'Quartermaster Cobb', role: 'vendor', regionId: 'beginnings', x: 44, z: -38 },
  { id: 'npc_beginnings_dill', name: 'Old Dill', role: 'flavor', regionId: 'beginnings', x: 40, z: -44 },
  { id: 'npc_beginnings_nib', name: 'Scribe Nib', role: 'flavor', regionId: 'beginnings', x: 46, z: -30 },
]

// ---------------------------------------------------------------------------
// QUESTS — gentle meadow fare. Kill targets are the region's tier-1 species
// (slime / mushroom / crab); gather/collect use meadow nodes + items.
// ---------------------------------------------------------------------------
const QUESTS: QuestDef[] = [
  {
    id: 'qb_welcome_wagon',
    title: 'Welcome to Thistledown',
    giver: 'npc_beginnings_marigold',
    regionId: 'beginnings',
    steps: [
      { kind: 'talk', target: 'npc_beginnings_tobias', need: 1, label: 'Say hello to Baker Tobias' },
      { kind: 'talk', target: 'npc_beginnings_cobb', need: 1, label: 'Report to Quartermaster Cobb' },
      { kind: 'talk', target: 'npc_beginnings_hazel', need: 1, label: 'Check in with Drillmaster Hazel' },
    ],
    rewards: { xp: { vitality: 40 }, items: [{ id: 'food_bread', qty: 2 }], blockCents: 20 },
    intro:
      "Welcome to Thistledown! Population: stubborn. We're a hamlet, which is a village that lost an argument with a map. Go introduce yourself to the three people who actually keep the place standing. Smile. Lie if you have to.",
    outro:
      "They've all met you now and nobody's filed a complaint, which in Thistledown is a landslide endorsement. You're practically a local. Start paying attention to the slimes.",
  },
  {
    id: 'qb_slime_season',
    title: 'Slime Season',
    giver: 'npc_beginnings_marigold',
    regionId: 'beginnings',
    steps: [{ kind: 'kill', target: 'slime', need: 6, label: 'Splat 6 meadow slimes' }],
    rewards: { xp: { attack: 70 }, items: [{ id: 'potion_hp_small', qty: 2 }] },
    intro:
      "It's slime season, which is every season, because slimes don't own calendars. Six of them have moved into the well path and they JIGGLE at people. Menacingly. Go splat six. Bring a mop energy and an open mind.",
    outro:
      "Six slimes, resolved. The well path is passable again and only slightly sticky. The town council — me, I'm the council — formally thanks you.",
  },
  {
    id: 'qb_crab_cakes',
    title: 'Crab Cakes (No Cakes)',
    giver: 'npc_beginnings_tobias',
    regionId: 'beginnings',
    steps: [
      { kind: 'kill', target: 'crab', need: 5, label: 'Pinch back 5 meadow crabs' },
      { kind: 'gather', target: 'farm_plot', need: 4, label: 'Harvest 4 wheat plots' },
    ],
    rewards: { xp: { attack: 50, farming: 50 }, items: [{ id: 'food_skewer', qty: 2 }] },
    intro:
      "The crabs keep marching out of the shallows and INTO MY FLOUR. Do you know what crab-flour bread tastes like? Neither do I and I'd like to keep it that way. Pinch five of them back, then grab me four wheat since they've ruined the rest. No, there are no cakes. The name is aspirational.",
    outro:
      "Clean wheat, chastened crabs, and my flour is once again legally bread-grade. You've saved the breakfast economy of a hamlet. Take a skewer; you've earned the protein.",
  },
  {
    id: 'qb_mushroom_muddle',
    title: 'A Bit of a Muddle',
    giver: 'npc_beginnings_posey',
    regionId: 'beginnings',
    steps: [
      { kind: 'kill', target: 'mushroom', need: 6, label: 'Stomp 6 shroomlings' },
      { kind: 'gather', target: 'mushroom_cluster', need: 4, label: 'Pick 4 mushroom clusters' },
    ],
    rewards: { xp: { attack: 50, herbalism: 60 }, items: [{ id: 'food_mushroom_soup', qty: 2 }] },
    intro:
      "Here's the muddle: the SPITEFUL shroomlings have to go, but the POLITE mushrooms I actually cook with. They look identical. The difference is attitude. Stomp six of the rude ones, then pick me four good clusters. Read the room. The room is a meadow.",
    outro:
      "Six rude mushrooms humbled, four polite ones in the basket. The soup's on. You've got a herbalist's eye and, worryingly, a herbalist's lack of squeamishness.",
  },
  {
    id: 'qb_berry_bother',
    title: 'The Berry Bother',
    giver: 'npc_beginnings_posey',
    regionId: 'beginnings',
    steps: [
      { kind: 'gather', target: 'berry_bush', need: 8, label: 'Strip 8 berry bushes' },
      { kind: 'collect', target: 'berry_red', need: 6, label: 'Collect 6 red berries' },
    ],
    rewards: { xp: { herbalism: 70 }, items: [{ id: 'food_meadowcake', qty: 2 }], blockCents: 25 },
    intro:
      "The berry bushes fruited all at once, which is lovely, except birds. The birds have opinions. Strip eight bushes before the sky-rats do and set six good red ones aside for Tobias. Move fast. The birds can see you and they are keeping score.",
    outro:
      "Eight bushes stripped, six berries saved, zero birds consulted. Tobias is already humming about honeycakes. Have one — Thistledown runs on sugar and spite, mostly in that order.",
  },
  {
    id: 'qb_honey_batch',
    title: 'The Honeycake Batch',
    giver: 'npc_beginnings_tobias',
    regionId: 'beginnings',
    steps: [
      { kind: 'gather', target: 'farm_plot', need: 5, label: 'Harvest 5 wheat plots' },
      { kind: 'collect', target: 'food_meadowcake', need: 2, label: 'Deliver 2 Meadow Honeycakes' },
    ],
    rewards: { xp: { cooking: 90, farming: 40 }, items: [{ id: 'potion_meadow_tonic', qty: 2 }], blockCents: 40 },
    intro:
      "Big order. The mayor wants honeycakes for the harvest thing and I have one oven and two hands, both of which are elbow-deep in dough. Bring me five wheat, then — IF the cooking skill's taken you anywhere — bake two Meadow Honeycakes yourself and hand them over. Delegation! It's a baker's second-best ingredient.",
    outro:
      "Five wheat, two cakes, and you baked the cakes YOURSELF — look at you, a whole apprentice. The harvest thing is saved. Nobody will remember the harvest thing in a week, but the cakes were real.",
  },
  {
    id: 'qb_first_catch',
    title: 'First Catch',
    giver: 'npc_beginnings_perch',
    regionId: 'beginnings',
    steps: [{ kind: 'gather', target: 'fishing_spot', need: 6, label: 'Fish the meadow shallows 6 times' }],
    rewards: { xp: { fishing: 70 }, items: [{ id: 'rod_basic', qty: 1 }] },
    intro:
      "You want to fish? Noble. Doomed, but noble. The meadow shallows are stocked with things that are LEGALLY fish. Haul six out. Don't name them. The ones you name, you can't gut, and then you've got a pet and a problem.",
    outro:
      "Six catches, not one of them named. You're a natural, by which I mean you were quiet and didn't fall in. Keep this rod; the one you borrowed was mine and I want it back more than I want you to have it.",
  },
  {
    id: 'qb_boot_strapped',
    title: 'Boot-Strapped',
    giver: 'npc_beginnings_perch',
    regionId: 'beginnings',
    steps: [
      { kind: 'gather', target: 'fishing_spot', need: 8, label: 'Keep fishing the shallows (8 times)' },
      { kind: 'collect', target: 'fish_boot', need: 1, label: 'Fish up 1 Old Boot' },
    ],
    rewards: { xp: { fishing: 80 }, items: [{ id: 'food_fish', qty: 3 }] },
    intro:
      "Someone lost a boot in the shallows and now it's downstream karma. Fish eight more times and, trust me, the boot will find YOU — it always does. Bring it in. It's mine. It's been mine since I was young and stupid enough to wade in wearing boots.",
    outro:
      "There it is. Hello, old friend. Smells like a decade and a half of pond. I'm keeping it on the mantel as a warning. Here's some actual fish — the edible genre. You're a proper angler now.",
  },
  {
    id: 'qb_timber_too',
    title: 'Timber, Too',
    giver: 'npc_beginnings_cobb',
    regionId: 'beginnings',
    steps: [{ kind: 'gather', target: 'oak_tree', need: 6, label: 'Fell 6 oaks for the stores' }],
    rewards: { xp: { woodcutting: 80 }, items: [{ id: 'food_jerky', qty: 2 }], blockCents: 30 },
    intro:
      "Quartermaster math: the hamlet needs fence, fence needs oak, oak needs chopping, chopping needs YOU. I'd do it myself but I'm holding a clipboard and a clipboard is a solemn trust. Six oaks. Try to leave the forest some trees; it's shy.",
    outro:
      "Six oaks, logged and tallied. The fence will stand, the sheep will stay, and I get to write a very satisfying number in column three. Jerky's yours. It's load-bearing jerky — keeps the whole supply chain chewing.",
  },
  {
    id: 'qb_copper_starter',
    title: 'Copper Bottom',
    giver: 'npc_beginnings_cobb',
    regionId: 'beginnings',
    steps: [
      { kind: 'gather', target: 'copper_vein', need: 5, label: 'Mine 5 copper veins' },
      { kind: 'collect', target: 'ore_copper', need: 5, label: 'Stockpile 5 copper ore' },
    ],
    rewards: { xp: { mining: 85 }, items: [{ id: 'pick_copper', qty: 1 }], blockCents: 35 },
    intro:
      "Every hamlet needs a copper bottom — nails, buckets, the mayor's commemorative plaque she hasn't earned yet. There's a copper seam at the meadow's edge. Knock five veins loose and set aside five ore. Pace yourself; the rock isn't going anywhere, which is the one dependable thing about rock.",
    outro:
      "Five veins down, five ore in the barrel, and you've graduated from borrowing picks to owning one. Congratulations, you now have a tool and the obligation that comes with it. That's basically adulthood.",
  },
  {
    id: 'qb_training_dummy',
    title: "Drillmaster's Welcome",
    giver: 'npc_beginnings_hazel',
    regionId: 'beginnings',
    steps: [
      { kind: 'kill', target: 'slime', need: 8, label: 'Drill against 8 slimes' },
      { kind: 'kill', target: 'mushroom', need: 4, label: 'Drill against 4 shroomlings' },
    ],
    rewards: { xp: { attack: 80, defense: 60 }, items: [{ id: 'potion_meadow_tonic', qty: 2 }] },
    intro:
      "I run the meadow's finest combat academy, enrollment: you. Lesson one: hit the thing until the thing stops. Our curriculum is eight slimes and four shroomlings, selected because they can't hit back hard enough to file a lawsuit. Form up. Pretend the slimes are your doubts.",
    outro:
      "Textbook. Twelve targets, correct amount of flailing, you stayed vertical the whole time. I'd pin a medal on you but we're a hamlet; take a tonic and the knowledge that you've impressed a woman who impresses poorly.",
  },
  {
    id: 'qb_herb_rounds',
    title: 'The Herb Rounds',
    giver: 'npc_beginnings_hazel',
    regionId: 'beginnings',
    steps: [
      { kind: 'gather', target: 'herb_patch', need: 6, label: 'Clear 6 herb patches' },
      { kind: 'collect', target: 'potion_meadow_tonic', need: 2, label: 'Brew 2 Meadow Tonics' },
    ],
    rewards: { xp: { herbalism: 70, alchemy: 60 }, items: [{ id: 'potion_hp_small', qty: 3 }], blockCents: 30 },
    intro:
      "A warrior who can't patch themselves up is just a future problem. Do the herb rounds — six patches — then, if the alchemy's in you, brew two Meadow Tonics and show me you can keep yourself standing without crying for a medic. The medic is me. I'm busy yelling.",
    outro:
      "Six patches cleared and two tonics you brewed with your own two hands. A self-sufficient soldier. If you ever leave Thistledown — and everyone does — you'll leave knowing how to NOT die of a scrape. That's the whole syllabus.",
  },
  {
    id: 'qb_town_census',
    title: 'The Thistledown Census',
    giver: 'npc_beginnings_nib',
    regionId: 'beginnings',
    steps: [
      { kind: 'talk', target: 'npc_beginnings_marigold', need: 1, label: 'Confirm the mayor exists' },
      { kind: 'talk', target: 'npc_beginnings_dill', need: 1, label: 'Interview Old Dill' },
      { kind: 'talk', target: 'npc_beginnings_perch', need: 1, label: 'Count Angler Perch' },
    ],
    rewards: { xp: { vitality: 60 }, items: [{ id: 'food_cheese', qty: 2 }], blockCents: 15 },
    intro:
      "I am conducting a census. There are, I believe, eleven of us, but Old Dill keeps answering for the scarecrow and the scarecrow keeps winning arguments. Go confirm three heads are attached to three real people. The crown pays me by the verified citizen, and I am OWED.",
    outro:
      "Three citizens confirmed, zero of them scarecrows — a clean audit, which Thistledown has never had. I'll write you into the margins as 'Helpful Stranger'. It's the highest honor the margins allow.",
  },
  {
    id: 'qb_graduation_capstone',
    title: 'Leaving the Meadow',
    giver: 'elder_rowan',
    regionId: 'beginnings',
    steps: [
      { kind: 'kill', target: 'slime', need: 10, label: 'Clear 10 slimes from the border path' },
      { kind: 'explore', target: 'beginnings', need: 1, label: 'Walk the Kingdom of Beginnings' },
    ],
    rewards: { xp: { attack: 120, vitality: 80 }, items: [{ id: 'sword_copper', qty: 1 }], blockCents: 60 },
    intro:
      "Word travels — Thistledown's taken a shine to you, and Thistledown shines to almost no one. So here's your last meadow errand from an old man: clear ten slimes off the border path and take one good walk around the whole kingdom you learned to stand up in. Then the forest's yours to ruin. They grow up so fast and so suddenly armed.",
    outro:
      "Ten slimes, one lap of a kingdom that'll miss you more than it'll admit. Take the copper sword — it's not much, but neither were you a week ago, and look. The road out of the meadow goes north. Don't look back; the slimes will take it personally.",
  },
]

// ---------------------------------------------------------------------------
// PREREQ CHAINS
// ---------------------------------------------------------------------------
const PREREQS: Record<string, readonly string[]> = {
  qb_slime_season: ['qb_welcome_wagon'],
  qb_crab_cakes: ['qb_welcome_wagon'],
  qb_mushroom_muddle: ['qb_welcome_wagon'],
  qb_berry_bother: ['qb_mushroom_muddle'],
  qb_honey_batch: ['qb_berry_bother'],
  qb_boot_strapped: ['qb_first_catch'],
  qb_copper_starter: ['qb_timber_too'],
  qb_herb_rounds: ['qb_training_dummy'],
  qb_graduation_capstone: ['qb_slime_season', 'qb_training_dummy'],
}

// ---------------------------------------------------------------------------
// RECIPES — starter cooking/alchemy, gated on the base profession unlocks.
// ---------------------------------------------------------------------------
const RECIPES: Recipe[] = [
  {
    id: 'cooking:food_meadowcake',
    skill: 'cooking',
    levelReq: 3,
    inputs: [{ id: 'wheat', qty: 2 }, { id: 'berry_red', qty: 1 }],
    output: { id: 'food_meadowcake', qty: 1 },
    xp: 12,
    gate: 'unlock:cook',
  },
  {
    id: 'cooking:food_berry_tart',
    skill: 'cooking',
    levelReq: 6,
    inputs: [{ id: 'berry_red', qty: 2 }, { id: 'wheat', qty: 1 }],
    output: { id: 'food_berry_tart', qty: 1 },
    xp: 16,
    gate: 'unlock:cook',
  },
  {
    id: 'alchemy:potion_meadow_tonic',
    skill: 'alchemy',
    levelReq: 2,
    inputs: [{ id: 'herb_green', qty: 2 }, { id: 'berry_red', qty: 1 }],
    output: { id: 'potion_meadow_tonic', qty: 1 },
    xp: 12,
    gate: 'unlock:brew',
  },
]

// ---------------------------------------------------------------------------
// DISPLAY NAMES for ids quests reference that may not be in the base catalog's
// name table (new items + a few tracked rewards).
// ---------------------------------------------------------------------------
const ITEM_NAMES: Record<string, string> = {
  food_meadowcake: 'Meadow Honeycake',
  potion_meadow_tonic: 'Meadow Tonic',
  rod_basic: 'Basic Fishing Rod',
  pick_copper: 'Copper Pickaxe',
  sword_copper: 'Copper Sword',
  ore_copper: 'Copper Ore',
  berry_red: 'Red Berry',
  fish_boot: 'Old Boot',
  food_mushroom_soup: 'Mushroom Soup',
  food_berry_tart: 'Berry Tart',
}

// ---------------------------------------------------------------------------
// TOWN — the hamlet of Thistledown, SE meadow cluster (plaza ~ x38,z-36).
// Open ground far from the village-green anchors; buildings self-block, props
// are each gated on open grass. Lanterns kept to 2. No castle anywhere near.
// ---------------------------------------------------------------------------
function town(ctx: Ctx): void {
  const openCell = (ix: number, iz: number): boolean =>
    isLand(ix + 0.5, iz + 0.5) &&
    surfaceAt(ctx, ix, iz) === S_GRASS &&
    !ctx.grid.isBlocked(ix + 0.5, iz + 0.5)

  // --- streets first (region builders run before the ground-instancing pass)
  kitPath(ctx, [
    [26, -27], [32, -32], [38, -36], [44, -36], [50, -38],
  ], 1.6)
  kitPath(ctx, [
    [38, -22], [38, -30], [38, -42], [36, -48],
  ], 1.4)

  // --- buildings (kitHouseShell blocks its own footprint); placed off the
  //     NPC anchor cells, ringing the plaza.
  kitHouseShell(ctx, { x0: 30, z0: -24, w: 8, d: 5, wallH: 5, door: 'S', chimney: true }) // town hall (N)
  kitHouseShell(ctx, { x0: 22, z0: -46, w: 5, d: 5, wallH: 4, door: 'E', chimney: true }) // cottage (SW)
  kitHouseShell(ctx, { x0: 50, z0: -44, w: 5, d: 5, wallH: 4, door: 'W' }) // cottage (SE)
  kitHouseShell(ctx, { x0: 24, z0: -22, w: 5, d: 4, wallH: 4, door: 'S' }) // cottage (NW)
  kitHouseShell(ctx, { x0: 50, z0: -28, w: 5, d: 5, wallH: 4, door: 'W', chimney: true }) // bakery (NE)

  // door spurs to the lanes
  kitPath(ctx, [[34, -20], [34, -27]], 1.2)
  kitPath(ctx, [[27, -44], [31, -40]], 1.2)
  kitPath(ctx, [[49, -42], [46, -38]], 1.2)

  // --- central well (a few batched boxes; marks its own collision)
  const wellX = 37
  const wellZ = -36
  const RIM = 0x9b9284
  const RIMLO = 0x857c6f
  const WATER = 0x2f5a74
  const POST = 0x6b4a2e
  const ROOF = 0x3f7a3a
  for (let dx = 0; dx < 2; dx++) {
    for (let dz = 0; dz < 2; dz++) {
      ctx.batches.stone.add(wellX + dx, 0, wellZ + dz, 1, 0.9, 1, dx === dz ? RIM : RIMLO)
      ctx.grid.block(wellX + dx, wellZ + dz)
    }
  }
  ctx.batches.window.add(wellX + 0.2, 0.55, wellZ + 0.2, 1.6, 0.12, 1.6, WATER) // glinting water
  ctx.batches.wood.add(wellX, 0.9, wellZ, 0.22, 2.6, 0.22, POST)
  ctx.batches.wood.add(wellX + 1.78, 0.9, wellZ, 0.22, 2.6, 0.22, POST)
  ctx.batches.wood.add(wellX + 1.9, 0.9, wellZ + 1.78, 0.22, 2.6, 0.22, POST)
  ctx.batches.roof.add(wellX - 0.3, 3.3, wellZ - 0.3, 2.6, 0.5, 2.6, ROOF)

  // --- signpost at the plaza mouth
  const sx = 33
  const sz = -31
  if (openCell(sx, sz)) {
    ctx.batches.wood.add(sx + 0.4, 0, sz + 0.4, 0.2, 2.2, 0.2, POST)
    ctx.batches.wood.add(sx - 0.2, 1.4, sz + 0.35, 1.5, 0.4, 0.14, 0xc9b183) // THISTLEDOWN board
    ctx.batches.wood.add(sx + 0.35, 1.0, sz - 0.2, 0.14, 0.35, 1.2, 0xc9b183) // arrow: forest ->
    ctx.grid.block(sx, sz)
  }

  // --- low fences framing the SW cottage yard
  kitFenceRun(ctx, 22, -40, 5, true)
  kitFenceRun(ctx, 22, -40, 4, false)

  // --- a tasteful scatter of trees + rocks, each gated on open ground
  const trees: ReadonlyArray<readonly [number, number]> = [
    [20, -30], [52, -34], [26, -48], [48, -48], [54, -24], [24, -46],
  ]
  for (const [tx, tz] of trees) if (openCell(tx, tz)) kitTree(ctx, tx, tz, { big: true })

  const rocks: ReadonlyArray<readonly [number, number]> = [[31, -46], [47, -26], [41, -44]]
  for (const [rx, rz] of rocks) if (openCell(rx, rz)) kitRock(ctx, rx, rz, 1)

  // --- lamp posts: 2, flanking the well plaza. Town hooks get no THREE.Scene,
  //     so these are emissive `window`-batch glow cubes (flicker with the
  //     village lights, zero point-light cost) rather than kitLantern.
  const GLOW = 0xffb45e
  for (const [lx, lz] of [[35, -34], [41, -38]] as const) {
    if (!openCell(lx, lz)) continue
    ctx.batches.wood.add(lx + 0.4, 0, lz + 0.4, 0.2, 2.0, 0.2, POST)
    ctx.batches.window.add(lx + 0.2, 2.0, lz + 0.2, 0.6, 0.6, 0.6, GLOW)
    ctx.grid.block(lx, lz)
  }
}

registerPack({
  items: ITEMS,
  npcs: NPCS,
  quests: QUESTS,
  prereqs: PREREQS,
  itemNames: ITEM_NAMES,
  recipes: RECIPES,
  town,
})
