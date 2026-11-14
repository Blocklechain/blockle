/**
 * Pets module core — rare-pet drops, the companion, the collection panel,
 * NFT minting and persistence.
 *
 * Contract compliance: talks to the rest of the game ONLY via the event bus
 * + GameAPI + integrator-wired setters (+ the one allowed saveRegistry
 * import). Integrator wiring in main.ts:
 *
 *   const pets = initPets(api)
 *   pets.setMobMeshSource((species, boss) => { ... new MobRig(def, boss) })  // combat's builder
 *   pets.setWallet(() => wallet)                       // WalletAPI2 (multichain, mintNft)
 *   pets.setTargetSource(() => combat.petTarget())     // the player's current mob
 *   pets.setPlayerDpsSource(() => <player dps estimate>)
 *
 * DROPS: every 'mob:killed' rolls the dead species' PET_VARIANTS entries
 * independently at 1-in-dropOneIn. Boss kills roll the boss-baby variants
 * (1/40); normal kills roll base/ember/snow/golden/shadow. A drop mints a
 * canonical uid (src/uid.ts), sparkles, quips in chat, emits 'pet:dropped'
 * and dirties the 'pets' save blob.
 *
 * NFT LAW: the uid is permanent from the drop. Minting embeds it on the
 * chosen chain via the wallet; one MintRecord per chain, re-minting the same
 * uid on ANOTHER chain is allowed, and records are only written from a REAL
 * {ok, token, tx} wallet response. Nothing is ever fabricated.
 */
import * as THREE from 'three'
import type { ChainId, GameAPI, MintRecord, PetInstance, PetVariant, WalletAPI2 } from '../types'
import { PET_VARIANTS, SPECIES, petDef } from '../ids'
import { events } from '../events'
import { newUid } from '../uid'
import { saveRegistry } from '../save/registry'
import { Companion, type MobMeshSource, type PetTarget } from './companion'
import { applyVariantPalette } from './palette'
import { Sparkles } from './sparkle'
import { createPetsPanel } from './panel'
import { dropLine, mintLine } from './flavor'

export type { MobMeshSource, PetRig, PetTarget } from './companion'

// ---------------------------------------------------------------------------
// Public module interface (wired by the integrator in main.ts)
// ---------------------------------------------------------------------------

export interface PetsModule {
  /** Combat's species voxel builder (the pet is a mini rebuild of it). */
  setMobMeshSource(fn: MobMeshSource): void
  /** The multichain wallet (getter — may become available late). */
  setWallet(fn: () => WalletAPI2 | null): void
  /** The player's current combat target (pet joins that fight). */
  setTargetSource(fn: () => PetTarget | null): void
  /** Player damage-per-second estimate; the pet deals ~25% of it. */
  setPlayerDpsSource(fn: () => number): void

  owned(): readonly PetInstance[]
  active(): PetInstance | null
  setActive(uid: string | null): void
  setNickname(uid: string, nickname: string): void
  /** Escrow a pet out of the collection (marketplace listing). */
  remove(uid: string): boolean
  /** Deliver a bought/restored pet back into the collection. */
  add(p: PetInstance): void
  /** Fresh display rig for a catalog petId (marketplace spinning cards). */
  buildMesh(petId: string): THREE.Group
  /** Mint `uid` on `chain` through the wired wallet (real tx or honest error). */
  mint(uid: string, chain: ChainId): Promise<{ ok: boolean; token?: string; tx?: string; error?: string }>
  dispose(): void
}

const speciesById = new Map(SPECIES.map((s) => [s.id, s] as const))
const VALID_CHAINS: readonly ChainId[] = ['blockle', 'ethereum', 'solana']

let inited: PetsModule | null = null

export function initPets(api: GameAPI): PetsModule {
  if (inited) return inited

  const rng = Math.random

  // --- state ---------------------------------------------------------------
  const pets: PetInstance[] = []
  let activeUid: string | null = null

  // --- integrator-wired sources --------------------------------------------
  let meshSource: MobMeshSource | null = null
  let walletSource: (() => WalletAPI2 | null) | null = null
  let targetSource: (() => PetTarget | null) | null = null
  let dpsSource: (() => number) | null = null

  // --- sparkles (own light RAF; bursts happen off the event bus) -----------
  const sparkles = new Sparkles(api.scene)
  let raf = 0
  let lastMs = performance.now()
  const tick = (nowMs: number): void => {
    raf = requestAnimationFrame(tick)
    const dt = Math.min((nowMs - lastMs) / 1000, 0.1)
    lastMs = nowMs
    sparkles.update(dt)
  }
  raf = requestAnimationFrame(tick)

  // --- companion -----------------------------------------------------------
  const companion = new Companion({
    scene: api.scene,
    world: api.world,
    player: api.player,
    rigSource: () => meshSource,
    target: () => targetSource?.() ?? null,
    playerDps: () => dpsSource?.() ?? 0,
  })

  const byUid = (uid: string | null): PetInstance | undefined =>
    uid === null ? undefined : pets.find((p) => p.uid === uid)

  const syncCompanion = (): void => {
    const pet = byUid(activeUid)
    const def = pet ? petDef(pet.petId) : undefined
    if (pet && def) {
      companion.setPet({
        species: def.species,
        variant: def.variant,
        speciesColor: speciesById.get(def.species)?.color ?? 0x7ed957,
      })
    } else {
      companion.setPet(null)
    }
  }

  // --- panel ---------------------------------------------------------------
  const panel = createPetsPanel({
    owned: () => pets,
    activeUid: () => activeUid,
    setActive: (uid) => setActive(uid),
    setNickname: (uid, nickname) => setNickname(uid, nickname),
    mint: (uid, chain) => mint(uid, chain),
    discovered: () => new Set(pets.map((p) => p.petId)).size,
    totalCatalog: () => PET_VARIANTS.length,
  })

  // --- mutations -----------------------------------------------------------

  function setActive(uid: string | null): void {
    const next = uid !== null && byUid(uid) ? uid : null
    if (next === activeUid) return
    activeUid = next
    syncCompanion()
    events.emit('save:dirty', { why: 'pets' })
    panel.refresh()
  }

  function setNickname(uid: string, nickname: string): void {
    const pet = byUid(uid)
    if (!pet) return
    const trimmed = nickname.trim().slice(0, 24)
    if (trimmed) pet.nickname = trimmed
    else delete pet.nickname
    events.emit('save:dirty', { why: 'pets' })
    panel.refresh()
  }

  async function mint(
    uid: string,
    chain: ChainId
  ): Promise<{ ok: boolean; token?: string; tx?: string; error?: string }> {
    const pet = byUid(uid)
    if (!pet) return { ok: false, error: 'Unknown pet.' }
    if (pet.mints.some((m) => m.chain === chain)) {
      return { ok: false, error: `Already minted on ${chain} — same UID, one mint per chain.` }
    }
    const wallet = walletSource?.()
    if (!wallet) return { ok: false, error: 'Wallet not connected.' }
    const def = petDef(pet.petId)
    const name = pet.nickname ? `${def?.name ?? pet.petId} "${pet.nickname}"` : (def?.name ?? pet.petId)

    const res = await wallet.mintNft(chain, pet.uid, {
      name,
      desc: `Blocklings pet companion. Canonical UID ${pet.uid} — the same single pet across every chain it is minted on.`,
      attrs: {
        species: def?.species ?? '?',
        variant: def?.variant ?? '?',
        petId: pet.petId,
        dropOneIn: def?.dropOneIn ?? 0,
      },
    })

    // NEVER fabricate: a MintRecord exists only on a real token + tx.
    if (!res.ok || !res.token || !res.tx) {
      return { ok: false, error: res.error ?? 'Mint failed (wallet returned no token/tx).' }
    }
    const record: MintRecord = { chain, token: res.token, tx: res.tx, t: Date.now() }
    pet.mints.push(record)
    events.emit('pet:minted', { uid: pet.uid, chain, token: res.token })
    events.emit('chat:system', { text: mintLine(def?.name ?? pet.petId, chain) })
    events.emit('save:dirty', { why: 'pets' })
    panel.refresh()
    return { ok: true, token: res.token, tx: res.tx }
  }

  /** Marketplace escrow: the pet leaves the collection (and the yard). */
  function removePet(uid: string): boolean {
    const i = pets.findIndex((p) => p.uid === uid)
    if (i < 0) return false
    pets.splice(i, 1)
    if (activeUid === uid) {
      activeUid = null
      syncCompanion()
    }
    events.emit('save:dirty', { why: 'pets' })
    panel.refresh()
    return true
  }

  /** Marketplace delivery/restore: the pet (same uid + mints) comes home. */
  function addPet(p: PetInstance): void {
    if (!petDef(p.petId) || byUid(p.uid)) return
    pets.push(p)
    events.emit('save:dirty', { why: 'pets' })
    panel.refresh()
  }

  /** Fresh species rig recolored for the variant (marketplace cards). */
  function buildMesh(petId: string): THREE.Group {
    const group = new THREE.Group()
    const def = petDef(petId)
    if (!def) return group
    const rig = meshSource?.(def.species, def.variant === 'boss')
    if (rig) {
      applyVariantPalette(rig.group, def.variant)
      group.add(rig.group)
    }
    return group
  }

  // --- drops ---------------------------------------------------------------

  function rollDrop(species: string, boss: boolean, pos: THREE.Vector3): void {
    const candidates = PET_VARIANTS.filter(
      (p) => p.species === species && (p.variant === 'boss') === boss
    )
    let won: (typeof candidates)[number] | null = null
    for (const def of candidates) {
      if (rng() * def.dropOneIn < 1) {
        // multiple simultaneous wins resolve to the rarest — maximum drama
        if (!won || def.dropOneIn > won.dropOneIn) won = def
      }
    }
    if (!won) return

    const petId = `${won.species}.${won.variant}`
    const pet: PetInstance = { petId, uid: newUid(), mints: [] }
    const firstEver = pets.length === 0
    pets.push(pet)

    sparkles.burst(new THREE.Vector3(pos.x, pos.y + 0.6, pos.z), 0xf2c43d, won.variant === 'base' ? 22 : 34)
    events.emit('chat:system', { text: dropLine(won.name, won.variant as PetVariant, rng) })
    events.emit('pet:dropped', { petId, variant: won.variant })
    events.emit('save:dirty', { why: 'pets' })
    panel.flashButton()
    panel.refresh()

    // your first pet immediately adopts you back
    if (firstEver) setActive(pet.uid)
  }

  const offKilled = events.on('mob:killed', ({ species, pos, boss }) => {
    rollDrop(species, boss === true, pos)
  })

  // --- persistence ---------------------------------------------------------
  // Compact blob: { v, a: activeUid, p: [[petId, uid, nickname, [[chain,token,tx,t]...]]...] }

  saveRegistry.register('pets', {
    dump(): unknown {
      return {
        v: 1,
        a: activeUid,
        p: pets.map((p) => [
          p.petId,
          p.uid,
          p.nickname ?? '',
          p.mints.map((m) => [m.chain, m.token, m.tx, m.t]),
        ]),
      }
    },
    load(data: unknown): void {
      if (!data || typeof data !== 'object') return
      const d = data as { a?: unknown; p?: unknown }
      pets.length = 0
      if (Array.isArray(d.p)) {
        for (const row of d.p) {
          if (!Array.isArray(row)) continue
          const [petId, uid, nickname, mints] = row as unknown[]
          if (typeof petId !== 'string' || typeof uid !== 'string') continue
          if (!petDef(petId)) continue
          const pet: PetInstance = { petId, uid, mints: [] }
          if (typeof nickname === 'string' && nickname.trim()) pet.nickname = nickname.trim()
          if (Array.isArray(mints)) {
            for (const m of mints) {
              if (!Array.isArray(m)) continue
              const [chain, token, tx, t] = m as unknown[]
              if (
                typeof chain === 'string' &&
                (VALID_CHAINS as readonly string[]).includes(chain) &&
                typeof token === 'string' &&
                typeof tx === 'string' &&
                token &&
                tx &&
                !pet.mints.some((r) => r.chain === chain)
              ) {
                pet.mints.push({
                  chain: chain as ChainId,
                  token,
                  tx,
                  t: typeof t === 'number' && Number.isFinite(t) ? t : 0,
                })
              }
            }
          }
          pets.push(pet)
        }
      }
      activeUid = typeof d.a === 'string' && byUid(d.a) ? d.a : null
      syncCompanion()
      panel.refresh()
    },
  })

  // --- module handle -------------------------------------------------------

  inited = {
    setMobMeshSource(fn) {
      meshSource = fn
      companion.refreshRig() // upgrade a fallback blob to the real species rig
    },
    setWallet(fn) {
      walletSource = fn
    },
    setTargetSource(fn) {
      targetSource = fn
    },
    setPlayerDpsSource(fn) {
      dpsSource = fn
    },
    owned: () => pets,
    active: () => byUid(activeUid) ?? null,
    setActive,
    setNickname,
    remove: removePet,
    add: addPet,
    buildMesh,
    mint,
    dispose() {
      cancelAnimationFrame(raf)
      offKilled()
      companion.dispose()
      sparkles.dispose()
      inited = null
    },
  }
  return inited
}
