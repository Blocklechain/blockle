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
