/**
 * NPCs — dialog panel. A cozy bottom-sheet in the HUD style: pixel portrait,
 * gold name, typed-out comedy text, quest offers / live progress (through the
 * integrator-wired QuestsAPI), and a functional vendor buy list priced in
 * game-BLOCK-cents. Mobile-friendly: big targets, bottom sheet, tap text to
 * skip the typewriter.
 */
import type { QuestDef, QuestsAPI } from '../types'
import type { StockEntry } from './vendors'
import { buyBrokeLine, buyOkLine } from './flavor'

export interface DialogHooks {
  /** Integrator-wired quests API (null until setQuestsApi is called). */
  quests(): QuestsAPI | null
  /** Current purse balance in BLOCK-cents. */
  purse(): number
  /** Attempt a purchase; true on success (purse already debited). */
  buy(entry: StockEntry): boolean
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

    const bar = document.createElement('div')
    bar.className = 'bl-npc-shopbar'
    const label = document.createElement('div')
    label.className = 'bl-npc-shoplabel'
    label.textContent = 'Wares'
    const purseChip = document.createElement('div')
    purseChip.className = 'bl-npc-purse'
    purseChip.textContent = `Purse: ${this.hooks.purse()}c`
    bar.append(label, purseChip)
    this.shopEl.appendChild(bar)

    for (const entry of cur.stock) {
      const row = document.createElement('div')
      row.className = 'bl-npc-item'

      const info = document.createElement('div')
      info.className = 'bl-npc-iteminfo'
      const nm = document.createElement('div')
      nm.className = 'bl-npc-itemname'
      nm.textContent = entry.name
      const pitch = document.createElement('div')
      pitch.className = 'bl-npc-itempitch'
      pitch.textContent = entry.pitch
      info.append(nm, pitch)

      const buy = document.createElement('button')
      buy.className = 'bl-npc-btn bl-npc-buy'
      buy.textContent = `${entry.price}c`
      buy.addEventListener('click', () => {
        if (this.hooks.buy(entry)) {
          this.setText(`One ${entry.name}. ${buyOkLine()}`)
          purseChip.textContent = `Purse: ${this.hooks.purse()}c`
        } else {
          this.setText(buyBrokeLine())
        }
      })

      row.append(info, buy)
      this.shopEl.appendChild(row)
    }
  }
}
