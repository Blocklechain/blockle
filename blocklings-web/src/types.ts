/**
 * Blocklings — shared type contract.
 *
 * THIS FILE IS THE CONTRACT between the parallel feature modules
 * (world, player, ui, wallet). Other agents build against these
 * interfaces EXACTLY as written — do not rename members, change
 * signatures, or alter semantics without coordinating a contract bump.
 */
import * as THREE from 'three'

/**
 * The game world: terrain, collision, and where new players appear.
 *
 * Coordinates are world-space; the voxel grid is 1 unit per block.
 * Implemented by `createWorld(scene)` in `./world`.
 */
export interface World {
  /**
   * True if the world-space column at (x, z) cannot be walked into
   * (building, fence, water, prop, out-of-bounds...). Movement code
   * must consult this before committing a step.
   */
  isBlocked(x: number, z: number): boolean

  /**
   * Y height of the walkable ground surface at (x, z), in world units.
   * Characters stand with their feet at this height.
   */
  groundHeight(x: number, z: number): number

  /** World-space position where the player spawns (feet position). */
  spawn: THREE.Vector3
}

/**
 * Live, mutable state of the local player character.
 *
 * Owned/updated by the player module each frame; read by the UI
 * (HUD bars, nameplate) and camera follow logic.
 */
export interface PlayerState {
  /** Current feet position in world space. Mutated in place each frame. */
  pos: THREE.Vector3

  /** Facing direction as a yaw angle in radians (0 = +Z, counter-clockwise). */
  facing: number

  /** True while the character is actively moving (drives walk animation). */
  moving: boolean

  /** Display name shown on the nameplate and in chat. */
  name: string

  /** Character level. */
  level: number

  /** Current hit points. */
  hp: number
  /** Maximum hit points. */
  maxHp: number

  /** Current mana points. */
  mp: number
  /** Maximum mana points. */
  maxMp: number

  /** Experience accumulated toward the next level. */
  xp: number
  /** Experience required to reach the next level. */
  xpToNext: number
}

/**
 * The central wiring hub passed between modules at bootstrap.
 *
 * `main.ts` constructs this once and hands it to each feature module,
 * so world/player/ui/wallet never import each other directly.
 */
export interface GameAPI {
  /** The one Three.js scene everything renders into. */
  scene: THREE.Scene

  /** The isometric-feel perspective camera (fov ~35, elevated). */
  camera: THREE.PerspectiveCamera

  /** Terrain + collision + spawn point. */
  world: World

  /** The local player's live state (see PlayerState). */
  player: PlayerState

  /**
   * Send a chat message from the local player. The UI calls this when
   * the chat input is submitted; the networking/chat backend delivers it.
   */
  chatSend(msg: string): void

  /**
   * Incoming-chat callback. The UI assigns this; the chat backend
   * invokes it for every message to display (including echoes of the
   * local player's own messages). Null until the UI registers it.
   */
  onChat: ((from: string, msg: string) => void) | null
}

/** Snapshot of the in-game BLOCK wallet, for display in the wallet UI. */
export interface WalletInfo {
  /** Public receive address (BLOCK chain). */
  address: string

  /** Spendable balance in BLOCK. */
  balance: number

  /** True when the wallet exists but is passphrase-locked (cannot send). */
  locked: boolean
}

/**
 * Non-custodial in-game BLOCK wallet.
 *
 * Implemented by the wallet module; consumed by the wallet UI panel.
 * All methods are async because they may hit the chain / crypto ops.
 */
export interface WalletAPI {
  /** Current wallet snapshot (address, balance, lock state). */
  info(): Promise<WalletInfo>

  /**
   * Create a brand-new wallet encrypted with `passphrase`.
   * Resolves to the mnemonic/backup phrase the user must write down.
   */
  create(passphrase: string): Promise<string>

  /**
   * Restore a wallet from a mnemonic or raw private key, re-encrypting
   * it with `passphrase`. Resolves to the wallet's address.
   */
  restore(mnemonicOrKey: string, passphrase: string): Promise<string>

  /** Unlock the stored wallet. Resolves true on correct passphrase. */
  unlock(passphrase: string): Promise<boolean>

  /**
   * Send `amount` BLOCK to address `to`.
   * Resolves `{ok: true, tx}` with the txid on success, or
   * `{ok: false, error}` with a human-readable reason on failure.
   */
  send(to: string, amount: number): Promise<{ ok: boolean; tx?: string; error?: string }>

  /** True if an encrypted wallet is already stored on this device. */
  exists(): boolean
}

/* ========================================================================== *
 *  PHASE 2+ CONTRACT EXTENSIONS (frozen — parallel modules build against     *
 *  these plus src/ids.ts and src/events.ts). Shim convention: each feature   *
 *  ships a top-level src/<name>.ts exporting `init<Name>(api: GameAPI)`      *
 *  (wired by main.ts in integrator-defined order); heavy code lives in       *
 *  src/<name>/ directories.                                                  *
 * ========================================================================== */

/** Six rarity tiers, common..mythical (index = tier). */
export type Rarity = 0 | 1 | 2 | 3 | 4 | 5

/** Equipment + item slots. */
export type ItemSlot =
  | 'weapon' | 'shield' | 'helm' | 'chest' | 'boots' | 'accessory'
  | 'tool' | 'consumable' | 'material'

/** Static item definition (catalog entry). */
export interface ItemDef {
  id: string
  name: string
  slot: ItemSlot
  rarity: Rarity
  /** Combat/utility stats granted while equipped. */
  stats?: Partial<{ atk: number; def: number; str: number; int: number; agi: number }>
  /** Level required (attack level for weapons, defense for armor...). */
  levelReq?: number
  /** For consumables: hp/mp restored. */
  restores?: Partial<{ hp: number; mp: number }>
  /** Vendor value in BLOCK-cents (game-economy units, NOT on-chain until minted). */
  value: number
  desc?: string

  /* -- wave-2 appends (optional; older items simply omit them) -- */

  /**
   * How the character model holds this item: 'upright' (torch/staff-like,
   * vertical in the fist), 'forward' (sword/axe point-ahead), 'bow'
   * (two-point side grip), 'shield' (strapped to the forearm).
   * Absent = builder default for the slot.
   */
  gripStyle?: 'upright' | 'forward' | 'bow' | 'shield'

  /**
   * Active special ability granted while this item is equipped. Fired by the
   * player via the UI; emits 'special:used' on activation and then cools down.
   */
  special?: ItemSpecial
}

/** An item's active special ability (see ItemDef.special). */
export interface ItemSpecial {
  /** Stable ability id (referenced by the 'special:used' event). */
  id: string
  name: string
  desc: string
  /** Cooldown between uses, in seconds. */
  cooldownS: number
}

/** A stack of an item in an inventory. */
export interface ItemStack { id: string; qty: number }

/** Items module: catalog + 3D voxel meshes for every item. */
export interface ItemsAPI {
  def(id: string): ItemDef | undefined
  all(): readonly ItemDef[]
  /**
   * Build the item's 3D voxel model (fresh group, ~0.5-1.2 units tall,
   * origin at grip/base, facing +Z). Used for the equipped-on-character
   * attachment, world loot drops, and the rotating inventory viewer.
   */
  buildMesh(id: string): import('three').Group
}

/** Inventory + equipment (persists via the save module). */
export interface InventoryAPI {
  items(): readonly ItemStack[]
  add(id: string, qty: number, source?: string): void
  remove(id: string, qty: number): boolean
  count(id: string): number
  equipment(): Readonly<Record<string, string | null>>
  equip(id: string): boolean
  unequip(slot: string): void
  /** Aggregate stats from all equipped items. */
  equippedStats(): { atk: number; def: number; str: number; int: number; agi: number }
}

/** Skills: xp/levels for every SkillId in src/ids.ts. */
export interface SkillsAPI {
  level(skill: string): number
  xp(skill: string): number
  xpToNext(skill: string): number
  addXp(skill: string, amount: number): void
  /** Total level across all skills (profile flex number). */
  total(): number
}

/** Quest definitions + live log. */
export interface QuestStep {
  kind: 'kill' | 'gather' | 'talk' | 'explore' | 'collect'
  /** species id / node kind / npc id / region id / item id (by kind). */
  target: string
  need: number
  label: string
}
export interface QuestDef {
  id: string
  title: string
  giver: string // npc id
  regionId: string
  steps: QuestStep[]
  rewards: { xp?: Partial<Record<string, number>>; items?: ItemStack[]; blockCents?: number }
  intro: string
  outro: string
}
export interface QuestsAPI {
  available(npcId: string): readonly QuestDef[]
  active(): readonly { def: QuestDef; step: number; done: number }[]
  accept(questId: string): void
  completed(): readonly string[]
}

/** Serializable character save (MUST stay well under 16KB JSON). */
export interface CharacterSave {
  v: 1
  name: string
  pos: [number, number]
  skills: Record<string, number> // skill -> xp
  inv: [string, number][] // [itemId, qty]
  equip: Record<string, string | null>
  quests: { done: string[]; active: [string, number, number][] } // [id, step, done]
  stones: string[] // attuned waystone ids
  hp: number
  mp: number
}

/* ========================================================================== *
 *  WAVE-2 CONTRACT EXTENSIONS (frozen append — Contracts agent, phase 1).    *
 *  NFTs/minting, pets, GOLD (IAP-only), marketplace, skill trees, specials.  *
 *                                                                            *
 *  ECONOMY LAW: zero earnable soft currency — players EARN items only.       *
 *  GOLD is IAP-only (never earned in-game, never cashed out, no gold->crypto *
 *  bridge, server-authoritative). Crypto is real (BLOCK/ETH/SOL),            *
 *  wallet-signed. NEVER fabricate balances/txids/receipts.                   *
 *                                                                            *
 *  NFT LAW: every item/pet INSTANCE gets one canonical `uid` at creation.    *
 *  Minting embeds that UID on the chosen chain; re-minting the SAME uid on   *
 *  additional chains is allowed (still one item — it gains chain badges).    *
 *  Mint state is permanent and travels with the item on trade. Only minted   *
 *  things trade for crypto; gold trades need no mint.                        *
 * ========================================================================== */

/** The three chains an item/pet can be minted on / paid with. */
export type ChainId = 'blockle' | 'ethereum' | 'solana'

/** One completed mint of a uid on one chain (permanent; travels on trade). */
export interface MintRecord {
  chain: ChainId
  /** Chain-native token identifier (BLOCK-20 token id / ERC-721 contract:tokenId / SPL mint address). */
  token: string
  /** The REAL mint transaction id. Never fabricated — absent tx = not minted. */
  tx: string
  /** Mint time, ms since epoch. */
  t: number
}

/**
 * Anything with a canonical NFT identity: one uid assigned at instance
 * creation (see src/uid.ts), plus every mint of that uid across chains.
 * `mints` empty = unminted (tradeable for gold only, never crypto).
 */
export interface Mintable {
  uid: string
  mints: MintRecord[]
}

/**
 * A concrete item INSTANCE (one specific sword, one bundle) as opposed to the
 * fungible ItemStack. Gear instances and market bundles carry these so they
 * can be minted/traded; uid/mints are optional because plain stackable items
 * never get an identity until the moment they're instanced for mint/listing.
 */
export interface ItemInstance {
  /** Catalog id (ItemDef.id). */
  id: string
  /** Canonical NFT uid — assigned once at instancing, then permanent. */
  uid?: string
  /** All mints of this uid (one per chain; same single item everywhere). */
  mints?: MintRecord[]
}

/** Pet visual/rarity variant. 'boss' pets are unique baby-boss drops. */
export type PetVariant = 'base' | 'ember' | 'snow' | 'golden' | 'shadow' | 'boss'

/**
 * Static pet catalog entry (see PET_VARIANTS in src/ids.ts).
 * Canonical petId = `${species}.${variant}` (e.g. 'slime.golden').
 */
export interface PetDef {
  /** Species id from SPECIES in src/ids.ts. */
  species: string
  variant: PetVariant
  /** Display name (comedy tone is intentional and load-bearing). */
  name: string
  /** Drop odds: one drop per `dropOneIn` qualifying kills of the species. */
  dropOneIn: number
}

/** A pet the player owns. Always Mintable: uid assigned the moment it drops. */
export interface PetInstance extends Mintable {
  /** `${species}.${variant}` key into PET_VARIANTS. */
  petId: string
  /** Player-chosen nickname (display-only; petId stays canonical). */
  nickname?: string
}

/**
 * Multi-chain wallet: everything WalletAPI does (BLOCK) plus per-chain
 * accounts, sends, NFT minting, and MoonPay on/off-ramp URLs.
 * All real, all wallet-signed — failures resolve {ok:false,error}, loudly.
 */
export interface WalletAPI2 extends WalletAPI {
  /** Per-chain account snapshot. Chains the user hasn't set up are absent. */
  chains(): Promise<Partial<Record<ChainId, { address: string; balance: number }>>>

  /**
   * Send on a specific chain. `amountOrToken` is a native-coin amount
   * (number) or a token identifier string (sends that NFT/token).
   */
  sendOn(
    chain: ChainId,
    to: string,
    amountOrToken: number | string,
  ): Promise<{ ok: boolean; tx?: string; error?: string }>

  /**
   * Mint the NFT for canonical uid `uid` on `chain`, embedding the uid in the
   * token metadata. Re-minting the same uid on another chain is allowed (same
   * item, extra chain badge); same uid twice on one chain must fail.
   */
  mintNft(
    chain: ChainId,
    uid: string,
    meta: { name: string; desc?: string; image?: string; attrs?: Record<string, string | number> },
  ): Promise<{ ok: boolean; token?: string; tx?: string; error?: string }>

  /** MoonPay widget URL for fiat on/off-ramp, or null when unavailable. */
  moonpayUrl(kind: 'buy' | 'sell', chain: ChainId): Promise<string | null>
}

/** A purchasable GOLD pack (App Store IAP SKU). */
export interface GoldSku {
  sku: string
  /** GOLD granted. */
  gold: number
  /** Display price in USD. */
  usd: number
}

/**
 * GOLD: the IAP-ONLY premium currency. Server-authoritative balance; never
 * earned in-game, never cashed out, no gold->crypto bridge. Purchases go
 * through the native StoreKit bridge (window.blocklingsIAP) injected by the
 * iOS shell; in a plain browser purchase() resolves {ok:false,error:'iOS only'}.
 */
export interface GoldAPI {
  /** Current server-authoritative GOLD balance. */
  balance(): Promise<number>
  /** The fixed IAP catalog. */
  buySkus(): GoldSku[]
  /** Buy one SKU via StoreKit; grant happens server-side on receipt. */
  purchase(sku: string): Promise<{ ok: boolean; error?: string }>
}

/** Listing price: GOLD, or real crypto on one chain (crypto ⇒ minted goods only). */
export type ListingPrice = { gold: number } | { chain: ChainId; amount: number }

/** One marketplace listing (exactly one of item/pet is set). */
export interface Listing {
  id: string
  /** Seller display name / account id. */
  seller: string
  item?: ItemInstance
  pet?: PetInstance
  price: ListingPrice
  /** Listed time, ms since epoch. */
  t: number
}

/** Browse filters; all optional, ANDed together. */
export interface ListingFilters {
  kind?: 'item' | 'pet'
  /** Only crypto listings on this chain. */
  chain?: ChainId
  /** Only GOLD listings. */
  gold?: boolean
  /** Pet species / item catalog id. */
  id?: string
  /** Free-text name match. */
  text?: string
}

/**
 * Player marketplace. LAW: a crypto-priced listing requires the goods to be
 * minted (uid + at least one MintRecord on the price chain); gold listings
 * need no mint. Crypto settlement is real and wallet-signed.
 */
export interface MarketAPI {
  /** List an item instance or pet for sale. */
  list(
    goods: { item: ItemInstance } | { pet: PetInstance },
    price: ListingPrice,
  ): Promise<{ ok: boolean; listingId?: string; error?: string }>
  browse(filters?: ListingFilters): Promise<readonly Listing[]>
  /** Buy a listing (gold debit or wallet-signed crypto transfer). */
  buy(listingId: string): Promise<{ ok: boolean; tx?: string; error?: string }>
  myListings(): Promise<readonly Listing[]>
}

/** One node in a skill's talent tree. */
export interface TreeNode {
  id: string
  /** SkillId this node belongs to. */
  skill: string
  /** 'auto' = granted free at lvlReq; 'perk' = costs a point; 'capstone' = big finisher pick. */
  kind: 'auto' | 'perk' | 'capstone'
  /** Skill level required before this node can be taken. */
  lvlReq: number
  name: string
  desc: string
  /** Numeric effects, keyed by modifier id (e.g. 'mining.speed': 0.15 = +15%). */
  effects: Record<string, number>
}

/** Talent trees: browse nodes, spend points, and query aggregate modifiers. */
export interface SkillTreeAPI {
  /** All nodes of one skill's tree. */
  nodes(skill: string): readonly TreeNode[]
  /** Ids of every chosen/granted node. */
  chosen(): readonly string[]
  /** True if id's lvlReq is met, prerequisites hold, and a point is available (perk/capstone). */
  canChoose(id: string): boolean
  /** Take the node. Returns false (and changes nothing) if not choosable. */
  choose(id: string): boolean
  /** Unspent talent points. */
  points(): number
  /** Summed effect value for a modifier key across all chosen nodes (0 if none). */
  modifier(key: string): number
}
