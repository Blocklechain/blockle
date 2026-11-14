/**
 * Trial of the Deep — DOM overlay (enter prompt, difficulty picker, run HUD,
 * fade veil, reward toasts, run summary). All roots mount into #ui and are
 * either content-sized or display:none-when-idle, so none trips the
 * full-screen pointer-events footgun (no src/style.css change needed).
 */
import './dungeon.css'

export interface TierRow {
  id: number
  name: string
  blurb: string
  best: number
  unlocked: boolean
  unlockHint: string
}

export interface HudState {
  tierName: string
  wave: number
  score: number
  best: number
  mobs: number
  line: string
}

export interface SummaryData {
  tierName: string
  waves: number
  best: number
  newBest: boolean
  shards: number
}

export class DungeonUI {
  onEnter: (() => void) | null = null
  onPickTier: ((id: number) => void) | null = null
  onFlee: (() => void) | null = null

  private readonly enterBtn: HTMLButtonElement
  private readonly veil: HTMLDivElement
  private readonly hud: HTMLDivElement
  private readonly hudWave: HTMLDivElement
  private readonly hudTier: HTMLDivElement
  private readonly hudStats: HTMLDivElement
  private readonly hudLine: HTMLDivElement
  private readonly toastEl: HTMLDivElement
  private readonly modal: HTMLDivElement
  private readonly card: HTMLDivElement
  private toastTimer = 0

  constructor(mount: HTMLElement) {
    this.enterBtn = document.createElement('button')
    this.enterBtn.className = 'bl-dng-enter'
    this.enterBtn.textContent = 'Enter the Trial of the Deep'
    this.enterBtn.addEventListener('click', () => this.onEnter?.())

    this.veil = document.createElement('div')
    this.veil.className = 'bl-dng-veil'

    this.hud = document.createElement('div')
    this.hud.className = 'bl-dng-hud'
    const top = document.createElement('div')
    top.className = 'bl-dng-hud-top'
    this.hudWave = document.createElement('div')
    this.hudWave.className = 'bl-dng-hud-wave'
    this.hudTier = document.createElement('div')
    this.hudTier.className = 'bl-dng-hud-tier'
    top.append(this.hudWave, this.hudTier)
    this.hudStats = document.createElement('div')
    this.hudStats.className = 'bl-dng-hud-stats'
    this.hudLine = document.createElement('div')
    this.hudLine.className = 'bl-dng-hud-line'
    const flee = document.createElement('button')
    flee.className = 'bl-dng-flee'
    flee.textContent = 'Flee the Deep'
    flee.addEventListener('click', () => this.onFlee?.())
    this.hud.append(top, this.hudStats, this.hudLine, flee)

    this.toastEl = document.createElement('div')
    this.toastEl.className = 'bl-dng-toast'

    this.modal = document.createElement('div')
    this.modal.className = 'bl-dng-modal'
    this.card = document.createElement('div')
    this.card.className = 'bl-dng-card'
    this.modal.appendChild(this.card)
    // tap on the dim backdrop (not the card) closes the picker
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal && this.modal.dataset['mode'] === 'picker') this.closeModal()
    })

    mount.append(this.enterBtn, this.veil, this.hud, this.toastEl, this.modal)
  }

  setEnterVisible(v: boolean): void {
    this.enterBtn.classList.toggle('show', v)
  }

  /** Fade to black (true) or back from black (false). Resolves when done. */
  fade(toBlack: boolean): Promise<void> {
    return new Promise((resolve) => {
      this.veil.classList.add('on')
      // next frame so the transition takes
      requestAnimationFrame(() => {
        this.veil.classList.toggle('black', toBlack)
        window.setTimeout(() => {
          if (!toBlack) this.veil.classList.remove('on')
          resolve()
        }, 440)
      })
    })
  }

  openPicker(rows: readonly TierRow[], shards: number): void {
    this.card.innerHTML = ''
    const h = document.createElement('h2')
    h.textContent = 'Trial of the Deep'
    const sub = document.createElement('div')
    sub.className = 'bl-dng-sub'
    sub.textContent = 'Endless waves. Pick how badly you want it to go.'
    const sh = document.createElement('div')
    sh.className = 'bl-dng-shards'
    sh.textContent = `Crystal Shards: ${shards}`
    this.card.append(h, sub, sh)

    for (const r of rows) {
      const b = document.createElement('button')
      b.className = 'bl-dng-tier' + (r.unlocked ? '' : ' locked')
      const name = document.createElement('div')
      name.className = 'bl-dng-tier-name'
      name.textContent = r.name
      const blurb = document.createElement('div')
      blurb.className = 'bl-dng-tier-blurb'
      blurb.textContent = r.blurb
      const meta = document.createElement('div')
      meta.className = 'bl-dng-tier-meta'
      meta.textContent = r.unlocked
        ? `Best: ${r.best} wave${r.best === 1 ? '' : 's'}`
        : `Locked — ${r.unlockHint}`
      b.append(name, blurb, meta)
      if (r.unlocked) b.addEventListener('click', () => this.onPickTier?.(r.id))
      this.card.appendChild(b)
    }
    const cancel = document.createElement('button')
    cancel.className = 'bl-dng-btn'
    cancel.textContent = 'Not today'
    cancel.addEventListener('click', () => this.closeModal())
    this.card.appendChild(cancel)

    this.modal.dataset['mode'] = 'picker'
    this.modal.classList.add('show')
  }

  closeModal(): void {
    this.modal.classList.remove('show')
    delete this.modal.dataset['mode']
  }

  setHudVisible(v: boolean): void {
    this.hud.classList.toggle('show', v)
  }

  setHud(s: HudState): void {
    this.hudWave.textContent = `Wave ${s.wave}`
    this.hudTier.textContent = s.tierName
    this.hudStats.innerHTML =
      `<span>Score <b>${s.score}</b></span>` +
      `<span>Best <b>${s.best}</b></span>` +
      `<span>Foes <b>${s.mobs}</b></span>`
    this.hudLine.textContent = s.line
  }

  toast(text: string): void {
    this.toastEl.textContent = text
    this.toastEl.classList.add('show')
    window.clearTimeout(this.toastTimer)
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), 2600)
  }

  /** Run-over summary. Resolves when the player taps "Back to the surface". */
  summary(s: SummaryData): Promise<void> {
    return new Promise((resolve) => {
      this.card.innerHTML = ''
      const h = document.createElement('h2')
      h.textContent = 'The Deep is Done With You'
      const sub = document.createElement('div')
      sub.className = 'bl-dng-sub'
      sub.textContent = s.tierName
      this.card.append(h, sub)
      const rows: [string, string][] = [
        ['Waves cleared', String(s.waves)],
        ['Personal best', String(s.best)],
        ['Crystal Shards this run', String(s.shards)]
      ]
      for (const [k, v] of rows) {
        const row = document.createElement('div')
        row.className = 'bl-dng-summary-row'
        row.innerHTML = `<span>${k}</span><b>${v}</b>`
        this.card.appendChild(row)
      }
      if (s.newBest) {
        const nb = document.createElement('div')
        nb.className = 'bl-dng-newbest'
        nb.textContent = 'NEW PERSONAL BEST'
        this.card.appendChild(nb)
      }
      const ok = document.createElement('button')
      ok.className = 'bl-dng-btn primary'
      ok.textContent = 'Back to the surface'
      ok.addEventListener('click', () => {
        this.closeModal()
        resolve()
      })
      this.card.appendChild(ok)
      this.modal.dataset['mode'] = 'summary'
      this.modal.classList.add('show')
    })
  }

  dispose(): void {
    window.clearTimeout(this.toastTimer)
    for (const el of [this.enterBtn, this.veil, this.hud, this.toastEl, this.modal]) {
      el.remove()
    }
  }
}
