/**
 * NPCs — dialog panel. A cozy bottom-sheet in the HUD style: pixel portrait,
 * gold name, typed-out comedy text, quest offers / live progress (through the
 * integrator-wired QuestsAPI), and a functional vendor buy list where EVERY
 * item is payable on any of four rails — BLOCK / ETH / SOL (REAL crypto) or
 * GOLD (IAP premium currency) — at the vendor's posted exchange rates (four
 * per-rail badges per item). Buying is a two-step confirm: Buy expands a
 * rail picker, picking a rail arms it, then the player confirms the exact
 * amount ("this is real crypto" for chains, "purchased Gold, no refunds" for
 * GOLD) and it settles through the integrator-wired pay functions. No wallet
 * wired = crypto rails disabled ('Wallet required'); no account = GOLD rail
 * disabled ('Sign in for Gold'). The shop always browses.
 * Mobile-friendly: big targets, bottom sheet, tap text to skip the typewriter.
 */
import type { ChainId, QuestDef, QuestsAPI } from '../types'
import { railPrices, fmtRail, type RailPrice, type StockEntry } from './vendors'
import { payFailLine, buyOkLine } from './flavor'

export interface DialogHooks {
  /** Integrator-wired quests API (null until setQuestsApi is called). */
  quests(): QuestsAPI | null
  /** True once the integrator has wired a pay function (wallet present). */
  walletReady(): boolean
  /** True once a GOLD spender is wired AND the player looks signed in. */
  goldReady(): boolean
  /**
   * Execute the REAL on-chain payment for `entry` on the chosen crypto rail
   * (already confirmed by the player). Resolves the wallet result verbatim;
   * on ok the item has been granted ('item:gained' source 'vendor'). Never
   * fabricates a tx.
   */
  pay(
    entry: StockEntry,
    price: { chain: ChainId; amount: number }
  ): Promise<{ ok: boolean; tx?: string; error?: string }>
  /**
   * Spend `amount` purchased GOLD server-side for `entry` (already
   * confirmed). On ok the item has been granted exactly like the crypto
   * path ('item:gained' source 'vendor'). Never fabricates a balance.
   */
  payGold(entry: StockEntry, amount: number): Promise<{ ok: boolean; error?: string }>
  /** Dialog fully closed (emit 'npc:talked' here). */
  closed(npcId: string): void
}

export interface DialogOpenOpts {
  id: string
  name: string
  roleTag: string
  portrait: HTMLCanvasElement
  greeting: string
  stock: readonly StockEntry[]
}

const TYPE_CPS = 60 // characters per second (2 per 33ms tick)

export class DialogPanel {
  private readonly panel: HTMLDivElement
  private readonly nameEl: HTMLDivElement
  private readonly roleEl: HTMLDivElement
  private readonly portraitBox: HTMLDivElement
  private readonly textEl: HTMLDivElement
  private readonly actionsEl: HTMLDivElement
  private readonly shopEl: HTMLDivElement
  private readonly hooks: DialogHooks

  private current: DialogOpenOpts | null = null
  private pending: QuestDef | null = null
  /** Index into current.stock whose rail picker is expanded. */
  private picking: number | null = null
  /** The armed (awaiting-confirm) rail on the picking entry. */
  private armed: RailPrice | null = null
  /** A payment is in flight — all buy buttons lock until it resolves. */
  private paying = false
  private typeTimer: number | null = null
  private fullText = ''

  constructor(mount: HTMLElement, hooks: DialogHooks) {
    this.hooks = hooks

    this.panel = document.createElement('div')
    this.panel.className = 'bl-npc-panel'
    this.panel.style.display = 'none'

    const head = document.createElement('div')
    head.className = 'bl-npc-head'

    this.portraitBox = document.createElement('div')
    this.portraitBox.className = 'bl-npc-portrait'

    const title = document.createElement('div')
    title.className = 'bl-npc-title'
    this.nameEl = document.createElement('div')
    this.nameEl.className = 'bl-npc-name'
    this.roleEl = document.createElement('div')
    this.roleEl.className = 'bl-npc-role'
    title.append(this.nameEl, this.roleEl)

    const closeBtn = document.createElement('button')
    closeBtn.className = 'bl-npc-x'
    closeBtn.textContent = '✕'
    closeBtn.setAttribute('aria-label', 'Close dialog')
    closeBtn.addEventListener('click', () => this.close())

    head.append(this.portraitBox, title, closeBtn)

    this.textEl = document.createElement('div')
    this.textEl.className = 'bl-npc-text'
    // tap the text to finish the typewriter instantly
    this.textEl.addEventListener('click', () => this.finishTyping())

    this.actionsEl = document.createElement('div')
    this.actionsEl.className = 'bl-npc-actions'

    this.shopEl = document.createElement('div')
    this.shopEl.className = 'bl-npc-shop'

    this.panel.append(head, this.textEl, this.actionsEl, this.shopEl)
    mount.appendChild(this.panel)
  }

  get isOpen(): boolean {
    return this.current !== null
  }

  get npcId(): string | null {
    return this.current?.id ?? null
  }

  open(opts: DialogOpenOpts): void {
    // reopening on another NPC mid-dialog counts as finishing the first chat
    if (this.current && this.current.id !== opts.id) {
      const prev = this.current.id
      this.current = null
      this.hooks.closed(prev)
    }
    this.current = opts
    this.pending = null
    this.picking = null
    this.armed = null
    this.paying = false
    this.nameEl.textContent = opts.name
    this.roleEl.textContent = opts.roleTag
    this.portraitBox.replaceChildren(opts.portrait)
    opts.portrait.className = 'bl-npc-pix'
    this.panel.style.display = ''
    this.setText(opts.greeting)
    this.renderActions()
    this.renderShop()
  }

  close(): void {
    if (!this.current) return
    const id = this.current.id
    this.current = null
    this.pending = null
    this.picking = null
    this.armed = null
    this.stopTyping()
    this.panel.style.display = 'none'
    this.hooks.closed(id)
  }

  // --- typewriter ----------------------------------------------------------

  private stopTyping(): void {
    if (this.typeTimer !== null) {
      clearInterval(this.typeTimer)
      this.typeTimer = null
    }
  }

  private finishTyping(): void {
    if (this.typeTimer === null) return
    this.stopTyping()
    this.textEl.textContent = this.fullText
  }

  private setText(text: string): void {
    this.stopTyping()
    this.fullText = text
    this.textEl.textContent = ''
    let i = 0
    const step = Math.max(1, Math.round(TYPE_CPS / 30))
    this.typeTimer = window.setInterval(() => {
      i += step
      this.textEl.textContent = text.slice(0, i)
      if (i >= text.length) this.stopTyping()
    }, 33)
  }

  // --- quests --------------------------------------------------------------

  private renderActions(): void {
    this.actionsEl.replaceChildren()
    const cur = this.current
    if (!cur) return
    const q = this.hooks.quests()

    if (this.pending && q) {
      // intro is on screen — accept or walk
      const def = this.pending
      const accept = document.createElement('button')
      accept.className = 'bl-npc-btn bl-npc-accept'
      accept.textContent = `Accept "${def.title}"`
      accept.addEventListener('click', () => {
        q.accept(def.id)
        this.pending = null
        this.setText(`Deal. "${def.title}" is your problem now. Try not to die — the paperwork is unbearable.`)
        this.renderActions()
      })
      const pass = document.createElement('button')
      pass.className = 'bl-npc-btn bl-npc-pass'
      pass.textContent = 'Hard pass'
      pass.addEventListener('click', () => {
        this.pending = null
        this.setText('Suit yourself. The problem will just sit there. Menacingly.')
        this.renderActions()
      })
      this.actionsEl.append(accept, pass)
      return
    }

    if (q) {
      const accepted = new Set(q.active().map((a) => a.def.id))
      for (const def of q.available(cur.id)) {
        if (accepted.has(def.id)) continue
        const b = document.createElement('button')
        b.className = 'bl-npc-btn bl-npc-offer'
        b.textContent = `! ${def.title}`
        b.addEventListener('click', () => {
          this.pending = def
          this.setText(def.intro)
          this.renderActions()
        })
        this.actionsEl.appendChild(b)
      }
      // live progress on quests this NPC handed out
      for (const a of q.active()) {
        if (a.def.giver !== cur.id) continue
        const step = a.def.steps[a.step]
        const row = document.createElement('div')
        row.className = 'bl-npc-prog'
        row.textContent = step
          ? `${a.def.title} — ${step.label} (${a.done}/${step.need})`
          : `${a.def.title} — wrapping up`
        this.actionsEl.appendChild(row)
      }
    }

    const leave = document.createElement('button')
    leave.className = 'bl-npc-btn bl-npc-leave'
    leave.textContent = 'Leave'
    leave.addEventListener('click', () => this.close())
    this.actionsEl.appendChild(leave)
  }

  // --- shop ----------------------------------------------------------------

  private renderShop(): void {
    this.shopEl.replaceChildren()
    const cur = this.current
    if (!cur || cur.stock.length === 0) {
      this.shopEl.style.display = 'none'
      return
    }
    this.shopEl.style.display = ''
    const walletReady = this.hooks.walletReady()
    const goldReady = this.hooks.goldReady()

    const bar = document.createElement('div')
    bar.className = 'bl-npc-shopbar'
    const label = document.createElement('div')
    label.className = 'bl-npc-shoplabel'
    label.textContent = 'Wares'
    const note = document.createElement('div')
    note.className = 'bl-npc-cryptonote'
    note.textContent =
      walletReady && goldReady
        ? 'Pay in BLOCK, ETH, SOL or Gold'
        : walletReady
          ? 'Pay in BLOCK, ETH or SOL — sign in for Gold'
          : goldReady
            ? 'Pay in Gold — wallet required for crypto'
            : 'Browsing only — wallet or Gold sign-in to buy'
    bar.append(label, note)
    this.shopEl.appendChild(bar)

    cur.stock.forEach((entry, idx) => {
      const rails = railPrices(entry)
      const row = document.createElement('div')
      row.className = 'bl-npc-item'

      const info = document.createElement('div')
      info.className = 'bl-npc-iteminfo'
      const nameRow = document.createElement('div')
      nameRow.className = 'bl-npc-itemname'
      nameRow.textContent = entry.name
      const pitch = document.createElement('div')
      pitch.className = 'bl-npc-itempitch'
      pitch.textContent = entry.pitch
      // all four rail prices as small chips under the name
      const badges = document.createElement('div')
      badges.className = 'bl-npc-railbadges'
      for (const p of rails) {
        const chip = document.createElement('span')
        chip.className = `bl-npc-chainbadge bl-chain-${p.rail}`
        chip.textContent = fmtRail(p)
        badges.appendChild(chip)
      }
      info.append(nameRow, pitch, badges)

      const buyBox = document.createElement('div')
      buyBox.className = 'bl-npc-buybox'

      if (this.picking !== idx) {
        // collapsed: a single Buy button that expands the rail picker
        const buy = document.createElement('button')
        buy.className = 'bl-npc-btn bl-npc-buy'
        buy.textContent = 'Buy'
        buy.disabled = this.paying
        buy.addEventListener('click', () => {
          if (this.paying) return
          this.picking = idx
          this.armed = null
          this.setText(
            `${entry.name}? Pick your poison — er, payment rail. Same item, four ways to regret nothing.`
          )
          this.renderShop()
        })
        buyBox.appendChild(buy)
      } else {
        // expanded: one button per rail; picking arms it, picking again pays
        for (const p of rails) {
          const b = document.createElement('button')
          const isGold = p.rail === 'gold'
          const isArmed = this.armed !== null && this.armed.rail === p.rail
          b.className =
            `bl-npc-btn bl-npc-buy bl-npc-rail bl-rail-${p.rail}` +
            (isArmed ? ' bl-npc-confirm' : '')
          if (isGold && !goldReady) {
            b.textContent = fmtRail(p)
            b.title = 'Sign in for Gold'
            b.disabled = true
          } else if (!isGold && !walletReady) {
            b.textContent = fmtRail(p)
            b.title = 'Wallet required'
            b.disabled = true
          } else if (this.paying) {
            b.textContent = isArmed ? 'Paying…' : fmtRail(p)
            b.disabled = true
          } else if (isArmed) {
            b.textContent = `Confirm ${fmtRail(p)}`
          } else {
            b.textContent = fmtRail(p)
          }
          b.addEventListener('click', () => {
            if (this.paying) return
            if (isGold ? !this.hooks.goldReady() : !this.hooks.walletReady()) return
            if (!(this.armed !== null && this.armed.rail === p.rail)) {
              // step 1: arm THIS rail — spell out the exact cost, plainly
              this.armed = p
              this.setText(
                isGold
                  ? `${entry.name}: ${fmtRail(p)}. That's your purchased Gold — bought with real money, ` +
                      `spent for keeps, no refunds. Tap "Confirm ${fmtRail(p)}" to spend it, or pick another rail to chicken out gracefully.`
                  : `${entry.name}: ${fmtRail(p)}. This is REAL crypto sent from your wallet — ` +
                      `not game money, no refunds. Tap "Confirm ${fmtRail(p)}" to pay, or pick another rail to change your mind.`
              )
              this.renderShop()
              return
            }
            // step 2: confirmed — hand off to the wallet / GOLD ledger
            void this.executePay(entry, p)
          })
          buyBox.appendChild(b)
        }
      }

      row.append(info, buyBox)
      this.shopEl.appendChild(row)
    })
  }

  private async executePay(entry: StockEntry, price: RailPrice): Promise<void> {
    this.paying = true
    this.renderShop()
    this.setText(
      price.rail === 'gold'
        ? `Spending ${fmtRail(price)}… the ledger goblins are doing the real thing. One moment.`
        : `Sending ${fmtRail(price)}… your wallet is doing the real thing. One moment.`
    )
    try {
      const res =
        price.rail === 'gold'
          ? await this.hooks.payGold(entry, price.amount)
          : await this.hooks.pay(entry, { chain: price.rail, amount: price.amount })
      if (res.ok) {
        this.setText(`One ${entry.name}, paid in full — ${fmtRail(price)}. ${buyOkLine()}`)
      } else {
        this.setText(`${payFailLine()} (${res.error ?? 'payment failed'})`)
      }
    } catch (e) {
      // honest failure — nothing was granted, nothing is pretended
      this.setText(`${payFailLine()} (${e instanceof Error ? e.message : 'payment failed'})`)
    } finally {
      this.paying = false
      this.picking = null
      this.armed = null
      // the dialog may have closed while the payment worked
      if (this.current) this.renderShop()
    }
  }
}
