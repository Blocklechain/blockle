/**
 * Minting — the ITEM NFT instance ledger (pets keep their own 'pets' blob).
 *
 * ALL-ITEMS FRAMEWORK: any gear piece or stackable can become an NFT.
 *   - A gear copy gets its canonical uid lazily, at the moment of its first
 *     REAL mint (uid is generated at mint intent and embedded on-chain; a
 *     failed mint stores nothing, so nothing is ever fabricated).
 *   - Stackables mint as quantity-bundles: the qty leaves the bag stacks
 *     (escrowed into the bundle) and the bundle becomes its own unstackable
 *     ItemInstance with the qty in its on-chain meta.
 *
 * INVARIANT: every stored instance has uid + at least one MintRecord with a
 * real token + tx. Mint state is permanent and travels with the item.
 *
 * STORAGE (saveRegistry provider 'invnft' → character-save `mods.invnft`):
 *   { v: 1, i: [[itemId, uid, qty, [[chain, token, tx, t], ...]], ...] }
 */
import type { ChainId, MintRecord } from '../types'
import { events } from '../events'
import { saveRegistry } from '../save/registry'

export const CHAINS: readonly ChainId[] = ['blockle', 'ethereum', 'solana']

export function isChainId(x: unknown): x is ChainId {
  return typeof x === 'string' && (CHAINS as readonly string[]).includes(x)
}

/** A minted item instance: one gear copy or one quantity-bundle. */
export interface NftInstance {
  /** Catalog id (ItemDef.id). */
  id: string
  /** Canonical uid — permanent, embedded in every on-chain mint. */
  uid: string
  /** 1 = a single gear copy; >1 = a bundle of a stackable (qty escrowed). */
  qty: number
  /** One per chain; never empty in the store, never fabricated. */
  mints: MintRecord[]
}

export class MintStore {
  private recs: NftInstance[] = []
  private listeners: Array<() => void> = []

  constructor() {
    saveRegistry.register('invnft', {
      dump: () => this.dump(),
      load: (d) => this.load(d)
    })
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn)
  }

  private notify(why: string): void {
    events.emit('save:dirty', { why: `invnft:${why}` })
    for (const fn of this.listeners) {
      try {
        fn()
      } catch (e) {
        console.error('[minting] change listener threw', e)
      }
    }
  }

  // --- queries --------------------------------------------------------------

  all(): readonly NftInstance[] {
    return this.recs
  }

  of(id: string): readonly NftInstance[] {
    return this.recs.filter((r) => r.id === id)
  }

  byUid(uid: string): NftInstance | undefined {
    return this.recs.find((r) => r.uid === uid)
  }

  /** Union of chains any minted instance of `id` lives on. */
  chainsOf(id: string): readonly ChainId[] {
    const out: ChainId[] = []
    for (const r of this.recs) {
      if (r.id !== id) continue
      for (const m of r.mints) if (!out.includes(m.chain)) out.push(m.chain)
    }
    return out
  }

  /** Minted gear copies of `id` (each claims one owned copy of the item). */
  gearCount(id: string): number {
    return this.recs.filter((r) => r.id === id && r.qty === 1).length
  }

  /** All minted quantity-bundles (stackables escrowed out of the bag). */
  bundles(): readonly NftInstance[] {
    return this.recs.filter((r) => r.qty > 1)
  }

  // --- mutations (only ever from REAL wallet results) -----------------------

  /**
   * Store a brand-new minted instance. Refuses records without a real
   * token + tx — a MintRecord is proof, never a hope.
   */
  addMinted(id: string, uid: string, qty: number, rec: MintRecord): NftInstance | null {
    if (!rec.token || !rec.tx) return null
    if (this.byUid(uid)) return null
    const inst: NftInstance = { id, uid, qty: Math.max(1, Math.floor(qty)), mints: [rec] }
    this.recs.push(inst)
    this.notify(`mint:${id}`)
    return inst
  }

  /**
   * Remove an instance whose goods left this save (market escrow on list).
   * NFT LAW: the uid is permanent — it travels with the goods to the buyer
   * (or back home on cancel via `receive`), it never belongs to two saves.
   */
  take(uid: string): NftInstance | null {
    const i = this.recs.findIndex((r) => r.uid === uid)
    if (i < 0) return null
    const inst = this.recs[i]!
    this.recs.splice(i, 1)
    this.notify(`take:${inst.id}`)
    return inst
  }

  /**
   * Store an instance arriving WITH its mint state from a trade (market
   * delivery / cancel-restore). Records are validated like `load` — only
   * real chain+token+tx survive, nothing is ever fabricated here. If the
   * uid is already present (cancel after a partial restore), missing chain
   * records are merged instead.
   */
  receive(id: string, uid: string, qty: number, mints: readonly MintRecord[]): boolean {
    if (!id || !uid) return false
    const clean: MintRecord[] = []
    for (const m of mints) {
      if (!m || !isChainId(m.chain) || typeof m.token !== 'string' || typeof m.tx !== 'string') continue
      if (!m.token || !m.tx || clean.some((r) => r.chain === m.chain)) continue
      clean.push({ chain: m.chain, token: m.token, tx: m.tx, t: typeof m.t === 'number' && Number.isFinite(m.t) ? m.t : 0 })
    }
    if (!clean.length) return false
    const have = this.byUid(uid)
    if (have) {
      let merged = false
      for (const m of clean) {
        if (have.mints.some((r) => r.chain === m.chain)) continue
        have.mints.push(m)
        merged = true
      }
      if (merged) this.notify(`receive:${have.id}`)
      return true
    }
    this.recs.push({ id, uid, qty: Math.max(1, Math.floor(qty)), mints: clean })
    this.notify(`receive:${id}`)
    return true
  }

  /** Record a re-mint of an existing uid on an ADDITIONAL chain. */
  recordMint(uid: string, rec: MintRecord): boolean {
    const inst = this.byUid(uid)
    if (!inst || !rec.token || !rec.tx) return false
    if (inst.mints.some((m) => m.chain === rec.chain)) return false
    inst.mints.push(rec)
    this.notify(`remint:${inst.id}`)
    return true
  }

  // --- persistence ----------------------------------------------------------

  private dump(): unknown {
    return {
      v: 1,
      i: this.recs.map((r) => [
        r.id,
        r.uid,
        r.qty,
        r.mints.map((m) => [m.chain, m.token, m.tx, m.t])
      ])
    }
  }

  private load(data: unknown): void {
    this.recs = []
    if (!data || typeof data !== 'object') return
    const d = data as { i?: unknown }
    if (!Array.isArray(d.i)) return
    for (const row of d.i) {
      if (!Array.isArray(row)) continue
      const [id, uid, qty, mints] = row as unknown[]
      if (typeof id !== 'string' || typeof uid !== 'string' || !id || !uid) continue
      if (this.byUid(uid)) continue
      const inst: NftInstance = {
        id,
        uid,
        qty: typeof qty === 'number' && Number.isFinite(qty) ? Math.max(1, Math.floor(qty)) : 1,
        mints: []
      }
      if (Array.isArray(mints)) {
        for (const m of mints) {
          if (!Array.isArray(m)) continue
          const [chain, token, tx, t] = m as unknown[]
          if (
            isChainId(chain) &&
            typeof token === 'string' &&
            typeof tx === 'string' &&
            token &&
            tx &&
            !inst.mints.some((r) => r.chain === chain)
          ) {
            inst.mints.push({
              chain,
              token,
              tx,
              t: typeof t === 'number' && Number.isFinite(t) ? t : 0
            })
          }
        }
      }
      // Store invariant: only instances with at least one REAL mint survive.
      if (inst.mints.length > 0) this.recs.push(inst)
    }
    for (const fn of this.listeners) {
      try {
        fn()
      } catch (e) {
        console.error('[minting] change listener threw', e)
      }
    }
  }
}
