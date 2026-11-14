/**
 * NPCs — vendor stock lists. Item ids follow the frozen conventions in
 * src/ids.ts; the inventory module resolves defs (or synthesizes them), we
 * only name and price things. Prices are in game-BLOCK-cents (purse units).
 */

export interface StockEntry {
  id: string
  name: string
  price: number
  /** One-liner shown under the item in the shop list. */
  pitch: string
}

export const VENDOR_STOCK: Record<string, readonly StockEntry[]> = {
  merchant_hilda: [
    { id: 'food_apple', name: 'Apple', price: 4, pitch: 'Keeps the doctor away. We don’t have a doctor.' },
    { id: 'food_bread', name: 'Bread Loaf', price: 6, pitch: 'Day-old. The day in question is classified.' },
    { id: 'potion_health', name: 'Health Potion', price: 12, pitch: 'Red means healthy. That’s just science.' },
    { id: 'potion_mana', name: 'Mana Potion', price: 12, pitch: 'Tastes blue. You’ll understand.' },
    { id: 'rod_basic', name: 'Fishing Rod', price: 20, pitch: 'Fish not included. That’s the whole premise.' },
    { id: 'sword_copper', name: 'Copper Sword', price: 30, pitch: 'Entry-level stabbing. Everyone starts somewhere.' },
    { id: 'shield_copper', name: 'Copper Shield', price: 26, pitch: 'Hide behind your problems, professionally.' }
  ],
  herbalist_moss: [
    { id: 'herb_green', name: 'Green Herb', price: 5, pitch: 'It’s green. It’s an herb. I never oversell.' },
    { id: 'potion_health', name: 'Health Potion', price: 11, pitch: 'Locally brewed. Lovingly unregulated.' },
    { id: 'potion_mana', name: 'Mana Potion', price: 11, pitch: 'Side effects include wizardry.' },
    { id: 'elixir_focus', name: 'Focus Elixir', price: 18, pitch: 'Like sleep, but you can skip the sleep part.' },
    { id: 'food_mushroom', name: 'Forest Mushroom', price: 7, pitch: 'Edible! (Confidence: medium.)' }
  ],
  prospector_finn: [
    { id: 'pick_copper', name: 'Copper Pickaxe', price: 24, pitch: 'Swing at rocks, not coworkers.' },
    { id: 'hatchet_copper', name: 'Copper Hatchet', price: 24, pitch: 'The trees started it.' },
    { id: 'pick_iron', name: 'Iron Pickaxe', price: 80, pitch: 'For when the mountain stops respecting copper.' },
    { id: 'ore_copper', name: 'Copper Ore', price: 8, pitch: 'Skip the mining, keep the glory.' },
    { id: 'ore_iron', name: 'Iron Ore', price: 20, pitch: 'Pre-mined by someone with worse knees than you.' },
    { id: 'food_jerky', name: 'Mine Jerky', price: 6, pitch: 'Of what? Don’t worry about it.' }
  ],
  banker_aldous: [
    { id: 'ring_gold', name: 'Gold Ring', price: 220, pitch: 'Wearable savings account. Non-interest-bearing.' },
    { id: 'amulet_gold', name: 'Gold Amulet', price: 260, pitch: 'Heavy enough to count as exercise.' },
    { id: 'charm_crystal', name: 'Crystal Charm', price: 480, pitch: 'Probably magic. Definitely marked up.' },
    { id: 'potion_health', name: 'Health Potion', price: 15, pitch: 'Capital pricing. The potion is the same.' },
    { id: 'food_cake', name: 'Tiny Expensive Cake', price: 25, pitch: 'Let yourself eat cake.' }
  ]
}
