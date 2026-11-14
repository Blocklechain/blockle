/**
 * Crafting UI — the station prompt pill + the centered crafting panel.
 *
 * Matches the HUD's gold-on-dark parchment language (hud.css vars echoed in
 * crafting.css); every control is a real button ≥ 40px tall. The panel is a
 * pure view: src/crafting/index.ts feeds it row view-models and receives
 * craft requests back — no game state lives here.
 */
import './crafting.css'

export interface CraftInputView {
  name: string
  have: number
  need: number
}

export interface CraftRowView {
  recipeId: string
  name: string
  outQty: number
  xp: number
  inputs: CraftInputView[]
  /** Empty = unlocked; otherwise the requirement text ("Blacksmithing 20"). */
  locked: string
  /** Comedy sub-line for locked rows. */
  lockQuip: string
  /** Unlocked + all materials present. */
  craftable: boolean
}

export interface CraftPanelData {
  stationName: string
  skillLabel: string
  skillLevel: number
  rows: CraftRowView[]
}

export interface CraftingUI {
  /** Show the interact pill ("Use <station>"). */
  showPrompt(label: string): void
  hidePrompt(): void
  onPromptActivate(fn: () => void): void

  openPanel(data: CraftPanelData): void
  refreshPanel(data: CraftPanelData): void
  closePanel(): void
  isOpen(): boolean
  onCraft(fn: (recipeId: string, count: number) => void): void
  onClose(fn: () => void): void

  /** 0..1 craft progress bar (with a "Crafting 2/5..." label); NaN hides. */
  progress(f: number, label?: string): void
  /** Disable/enable every craft button (while a craft runs). */
  setBusy(busy: boolean): void

  dispose(): void
}

export function createCraftingUI(mount: HTMLElement): CraftingUI {
  // --- prompt pill ---------------------------------------------------------
  const prompt = document.createElement('button')
  prompt.type = 'button'
  prompt.className = 'bl-craft-prompt'
  prompt.style.display = 'none'
  const promptKey = document.createElement('span')
  promptKey.className = 'bl-craft-key'
  promptKey.textContent = 'E'
  const promptLabel = document.createElement('span')
  prompt.appendChild(promptKey)
  prompt.appendChild(promptLabel)
  mount.appendChild(prompt)

  let promptFn: (() => void) | null = null
  const onPromptClick = (e: Event): void => {
    e.preventDefault()
    promptFn?.()
  }
  prompt.addEventListener('click', onPromptClick)

  // --- panel ---------------------------------------------------------------
  const root = document.createElement('div')
  root.className = 'bl-craft-root'
  root.style.display = 'none'

  const panel = document.createElement('div')
  panel.className = 'bl-craft-panel'
  root.appendChild(panel)

  const head = document.createElement('div')
  head.className = 'bl-craft-head'
  const title = document.createElement('div')
  title.className = 'bl-craft-title'
  const skillChip = document.createElement('div')
  skillChip.className = 'bl-craft-skill'
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'bl-craft-close'
  closeBtn.setAttribute('aria-label', 'Close')
  closeBtn.textContent = '✕'
  head.appendChild(title)
  head.appendChild(skillChip)
  head.appendChild(closeBtn)
  panel.appendChild(head)

  const list = document.createElement('div')
  list.className = 'bl-craft-list'
  panel.appendChild(list)

  const foot = document.createElement('div')
  foot.className = 'bl-craft-foot'
  const barLabel = document.createElement('div')
  barLabel.className = 'bl-craft-bar-label'
  const bar = document.createElement('div')
  bar.className = 'bl-craft-bar'
  const fill = document.createElement('div')
  fill.className = 'bl-craft-fill'
  bar.appendChild(fill)
  foot.appendChild(barLabel)
  foot.appendChild(bar)
  foot.style.display = 'none'
  panel.appendChild(foot)

  mount.appendChild(root)

  let open = false
  let busy = false
  let craftFn: ((recipeId: string, count: number) => void) | null = null
  let closeFn: (() => void) | null = null

  const doClose = (): void => {
    if (!open) return
    open = false
    root.style.display = 'none'
    closeFn?.()
  }
  const onCloseClick = (e: Event): void => {
    e.preventDefault()
    doClose()
  }
  closeBtn.addEventListener('click', onCloseClick)
  const onRootClick = (e: Event): void => {
    if (e.target === root) doClose() // tap the dim backdrop to close
  }
  root.addEventListener('click', onRootClick)
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && open) doClose()
  }
  window.addEventListener('keydown', onKeyDown)

  const render = (data: CraftPanelData): void => {
    title.textContent = data.stationName
    skillChip.textContent = `${data.skillLabel} ${data.skillLevel}`
    list.textContent = ''
    for (const row of data.rows) {
      const el = document.createElement('div')
      el.className = 'bl-craft-row' + (row.locked ? ' bl-craft-locked' : '')

      const main = document.createElement('div')
      main.className = 'bl-craft-row-main'

      const nameLine = document.createElement('div')
      nameLine.className = 'bl-craft-name'
      nameLine.textContent = row.outQty > 1 ? `${row.name} x${row.outQty}` : row.name
      const xpChip = document.createElement('span')
      xpChip.className = 'bl-craft-xp'
      xpChip.textContent = `+${row.xp} xp`
      nameLine.appendChild(xpChip)
      main.appendChild(nameLine)

      if (row.locked) {
        const req = document.createElement('div')
        req.className = 'bl-craft-req'
        req.textContent = `Requires ${row.locked}`
        main.appendChild(req)
        const quip = document.createElement('div')
        quip.className = 'bl-craft-quip'
        quip.textContent = row.lockQuip
        main.appendChild(quip)
      } else {
        const mats = document.createElement('div')
        mats.className = 'bl-craft-mats'
        for (const i of row.inputs) {
          const m = document.createElement('span')
          m.className = 'bl-craft-mat' + (i.have < i.need ? ' bl-craft-mat-missing' : '')
          m.textContent = `${i.name} ${i.have}/${i.need}`
          mats.appendChild(m)
        }
        main.appendChild(mats)
      }
      el.appendChild(main)

      if (!row.locked) {
        const actions = document.createElement('div')
        actions.className = 'bl-craft-actions'
        const mk = (label: string, count: number): HTMLButtonElement => {
          const b = document.createElement('button')
          b.type = 'button'
          b.className = 'bl-craft-btn'
          b.textContent = label
          b.disabled = busy || !row.craftable
          b.addEventListener('click', (e) => {
            e.preventDefault()
            if (!busy) craftFn?.(row.recipeId, count)
          })
          return b
        }
        actions.appendChild(mk('Craft', 1))
        actions.appendChild(mk('x5', 5))
        el.appendChild(actions)
      }
      list.appendChild(el)
    }
  }

  return {
    showPrompt(label: string): void {
      prompt.style.display = 'flex'
      promptLabel.textContent = label
    },
    hidePrompt(): void {
      prompt.style.display = 'none'
    },
    onPromptActivate(fn: () => void): void {
      promptFn = fn
    },

    openPanel(data: CraftPanelData): void {
      open = true
      root.style.display = 'flex'
      render(data)
    },
    refreshPanel(data: CraftPanelData): void {
      if (open) render(data)
    },
    closePanel(): void {
      doClose()
    },
    isOpen(): boolean {
      return open
    },
    onCraft(fn: (recipeId: string, count: number) => void): void {
      craftFn = fn
    },
    onClose(fn: () => void): void {
      closeFn = fn
    },

    progress(f: number, label?: string): void {
      if (Number.isNaN(f)) {
        foot.style.display = 'none'
        return
      }
      foot.style.display = 'block'
      barLabel.textContent = label ?? 'Crafting...'
      fill.style.width = `${Math.round(Math.min(1, Math.max(0, f)) * 100)}%`
    },
    setBusy(b: boolean): void {
      busy = b
      for (const btn of list.querySelectorAll<HTMLButtonElement>('.bl-craft-btn')) {
        if (b) btn.disabled = true
        // un-disabling happens on the refreshPanel that follows every craft
      }
    },

    dispose(): void {
      window.removeEventListener('keydown', onKeyDown)
      prompt.removeEventListener('click', onPromptClick)
      closeBtn.removeEventListener('click', onCloseClick)
      root.removeEventListener('click', onRootClick)
      prompt.remove()
      root.remove()
    }
  }
}
