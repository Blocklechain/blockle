/**
 * Gather prompt UI — one tappable pill above the hotbar area:
 *   [E]  Mine Copper Vein        (desktop hint + mobile tap target)
 * with a progress fill while harvesting and a dimmed "needs a better
 * tool" state. Lives in the #ui overlay; pointer-events re-enable via
 * the #ui > * rule in style.css.
 */
import './gather.css'

export interface GatherPromptUI {
  /** Show the prompt. `blocked` dims it (wrong/missing tool). */
  show(label: string, blocked: boolean): void
  hide(): void
  /** 0..1 progress fill while harvesting; NaN hides the bar. */
  progress(f: number): void
  /** Wire the tap/click action. */
  onActivate(fn: () => void): void
  dispose(): void
}

export function createGatherUI(mount: HTMLElement): GatherPromptUI {
  const root = document.createElement('button')
  root.type = 'button'
  root.className = 'gather-prompt'
  root.style.display = 'none'

  const key = document.createElement('span')
  key.className = 'gather-key'
  key.textContent = 'E'

  const label = document.createElement('span')
  label.className = 'gather-label'

  const bar = document.createElement('div')
  bar.className = 'gather-bar'
  const fill = document.createElement('div')
  fill.className = 'gather-fill'
  bar.appendChild(fill)

  root.appendChild(key)
  root.appendChild(label)
  root.appendChild(bar)
  mount.appendChild(root)

  let activate: (() => void) | null = null
  const onClick = (e: Event): void => {
    e.preventDefault()
    activate?.()
  }
  root.addEventListener('click', onClick)

  return {
    show(text: string, blocked: boolean): void {
      root.style.display = 'flex'
      label.textContent = text
      root.classList.toggle('gather-blocked', blocked)
    },
    hide(): void {
      root.style.display = 'none'
      bar.style.display = 'none'
    },
    progress(f: number): void {
      if (Number.isNaN(f)) {
        bar.style.display = 'none'
        return
      }
      bar.style.display = 'block'
      fill.style.width = `${Math.round(Math.min(1, Math.max(0, f)) * 100)}%`
    },
    onActivate(fn: () => void): void {
      activate = fn
    },
    dispose(): void {
      root.removeEventListener('click', onClick)
      root.remove()
    }
  }
}
