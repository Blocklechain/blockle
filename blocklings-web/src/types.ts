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
