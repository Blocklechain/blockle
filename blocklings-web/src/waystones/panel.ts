/**
 * Travel panel (bottom sheet listing other attuned waystones) + the
 * fade-to-black teleport veil. Pure DOM, mounted in #ui, styled by
 * waystones.css to match the HUD / NPC-dialog parchment look.
 */
import { emptyListLine } from './flavor'

export interface TravelOption {
  id: string
  name: string
  region: string
}

export class TravelPanel {
  private readonly root: HTMLDivElement
  private openStone: string | null = null

  constructor(
    mount: HTMLElement,
    private readonly onPick: (destId: string) => void
  ) {
    this.root = document.createElement('div')
    this.root.className = 'bl-ws-panel'
    this.root.style.display = 'none'
    mount.appendChild(this.root)
  }

  get isOpen(): boolean {
    return this.openStone !== null
  }

  /** Id of the stone the player opened the panel at (null when closed). */
  get stoneId(): string | null {
    return this.openStone
  }

  open(hereId: string, hereName: string, options: readonly TravelOption[]): void {
    this.openStone = hereId
    this.root.innerHTML = ''

    const head = document.createElement('div')
    head.className = 'bl-ws-head'
    const title = document.createElement('div')
    title.className = 'bl-ws-title'
    title.textContent = hereName
    const sub = document.createElement('div')
    sub.className = 'bl-ws-sub'
    sub.textContent = 'Where to, meatbag?'
    const titleWrap = document.createElement('div')
    titleWrap.className = 'bl-ws-titlewrap'
    titleWrap.appendChild(title)
    titleWrap.appendChild(sub)
    const x = document.createElement('button')
    x.className = 'bl-ws-x'
    x.textContent = '✕'
    x.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      this.close()
    })
    head.appendChild(titleWrap)
    head.appendChild(x)
    this.root.appendChild(head)

    if (options.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'bl-ws-empty'
      empty.textContent = emptyListLine()
      this.root.appendChild(empty)
    } else {
      for (const opt of options) {
        const row = document.createElement('button')
        row.className = 'bl-ws-row'
        const name = document.createElement('span')
        name.className = 'bl-ws-rowname'
        name.textContent = opt.name
        const region = document.createElement('span')
        region.className = 'bl-ws-rowregion'
        region.textContent = opt.region
        row.appendChild(name)
        row.appendChild(region)
        row.addEventListener('pointerdown', (e) => {
          e.preventDefault()
          e.stopPropagation()
          this.onPick(opt.id)
        })
        this.root.appendChild(row)
      }
    }

    this.root.style.display = ''
  }

  close(): void {
    this.openStone = null
    this.root.style.display = 'none'
  }
}

/** Full-screen fade-to-black: fade in, run the swap at black, fade out. */
export class FadeVeil {
  private readonly el: HTMLDivElement
  private busy = false

  constructor(mount: HTMLElement) {
    this.el = document.createElement('div')
    this.el.className = 'bl-ws-veil'
    // Inline (beats ANY stylesheet rule): the veil is purely visual and must
    // NEVER intercept input — it ate every in-world tap when a #ui>* opt-in
    // rule out-specified the class-level pointer-events:none.
    this.el.style.pointerEvents = 'none'
    mount.appendChild(this.el)
  }

  get active(): boolean {
    return this.busy
  }

  run(atBlack: () => void): void {
    if (this.busy) return
    this.busy = true
    this.el.classList.add('bl-ws-veil-on')
    window.setTimeout(() => {
      try {
        atBlack()
      } finally {
        window.setTimeout(() => {
          this.el.classList.remove('bl-ws-veil-on')
          this.busy = false
        }, 220) // hold black a beat so the camera settles on the new spot
      }
    }, 300)
  }
}
