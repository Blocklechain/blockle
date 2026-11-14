/**
 * Quests — HUD surfaces.
 *
 *  - A round "!" button in the right-hand HUD column (under the world-map
 *    button) with a live active-quest count badge; toggles the quest log.
 *  - The quest log: centered parchment-dark panel listing active quests with
 *    full step checklists + reward previews + per-quest Track buttons, and a
 *    collapsed Completed roll underneath.
 *  - A compact always-on tracker widget (top-right, under the balance/map
 *    stack) following the focused quest's current step with a progress bar;
 *    tapping it opens the log. It pulses on progress and flashes gold on
 *    completion.
 *
 * Mobile-friendly: ≥40px targets, panel scrolls, widget stays thumb-sized.
 */
import type { QuestDef } from '../types'
import './quests.css'

export interface QuestPanelDeps {
  active(): readonly { def: QuestDef; step: number; done: number }[]
  completedTitles(): readonly string[]
  activeCount(): number
  focused(): { def: QuestDef; step: number; done: number } | null
  setFocus(id: string): void
  isFocused(id: string): boolean
  giverName(id: string): string
  rewardText(def: QuestDef): string
}

export interface QuestPanel {
  refresh(): void
  /** Small attention pulse on the tracker (step progress). */
  pulse(): void
  /** Bigger gold flash (quest completed). */
  celebrate(): void
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

export function createQuestPanel(deps: QuestPanelDeps): QuestPanel {
  const uiMount = document.getElementById('ui')
  if (!uiMount) throw new Error('missing #ui overlay mount')

  const root = el('div', 'blq-root')

  // =========================================================================
  // Toggle button (right column, under the map button)
  // =========================================================================
  const btn = el('button', 'blq-btn')
  btn.type = 'button'
  btn.setAttribute('aria-label', 'Quest log')
  btn.appendChild(el('span', 'blq-btn-glyph', '!'))
  const badge = el('span', 'blq-badge', '0')
  badge.style.display = 'none'
  btn.appendChild(badge)

  // =========================================================================
  // Tracker widget (under the button)
  // =========================================================================
  const tracker = el('button', 'blq-tracker')
  tracker.type = 'button'
  tracker.style.display = 'none'
  tracker.setAttribute('aria-label', 'Focused quest — open quest log')
  const trkTitle = el('div', 'blq-trk-title')
  const trkStep = el('div', 'blq-trk-step')
  const trkBar = el('div', 'blq-trk-bar')
  const trkFill = el('div', 'blq-trk-fill')
  trkBar.appendChild(trkFill)
  const trkCount = el('div', 'blq-trk-count')
  tracker.append(trkTitle, trkStep, trkBar, trkCount)

  // =========================================================================
  // Quest log panel
  // =========================================================================
  const panel = el('div', 'blq-panel')
  panel.style.display = 'none'

  const head = el('div', 'blq-head')
  head.appendChild(el('span', 'blq-title', 'Quest Log'))
  const closeBtn = el('button', 'blq-close', '×')
  closeBtn.type = 'button'
  closeBtn.setAttribute('aria-label', 'Close quest log')
  head.appendChild(closeBtn)
  panel.appendChild(head)

  const body = el('div', 'blq-body')
  panel.appendChild(body)

  function renderActiveCard(a: {
    def: QuestDef
    step: number
    done: number
  }): HTMLElement {
    const card = el('div', 'blq-card')
    if (deps.isFocused(a.def.id)) card.classList.add('blq-card-focused')

    const top = el('div', 'blq-card-top')
    const titleBox = el('div', 'blq-card-titles')
    titleBox.appendChild(el('div', 'blq-card-title', a.def.title))
    titleBox.appendChild(el('div', 'blq-card-giver', deps.giverName(a.def.giver)))
    top.appendChild(titleBox)

    const track = el('button', 'blq-track')
    track.type = 'button'
    const focused = deps.isFocused(a.def.id)
    track.textContent = focused ? 'Tracking' : 'Track'
    track.disabled = focused
    track.addEventListener('click', () => deps.setFocus(a.def.id))
    top.appendChild(track)
    card.appendChild(top)

    const steps = el('div', 'blq-steps')
    a.def.steps.forEach((step, i) => {
      const row = el('div', 'blq-step')
      let mark = '·'
      if (i < a.step) {
        mark = '✓'
        row.classList.add('blq-step-done')
      } else if (i === a.step) {
        mark = '▸'
        row.classList.add('blq-step-now')
      } else {
        row.classList.add('blq-step-later')
      }
      row.appendChild(el('span', 'blq-step-mark', mark))
      const label = el('span', 'blq-step-label', step.label)
      row.appendChild(label)
      if (i === a.step) {
        row.appendChild(el('span', 'blq-step-count', `${a.done}/${step.need}`))
      }
      steps.appendChild(row)
    })
    card.appendChild(steps)

    const rewards = deps.rewardText(a.def)
    if (rewards) {
      const rw = el('div', 'blq-rewards')
      rw.appendChild(el('span', 'blq-rewards-tag', 'Rewards'))
      rw.appendChild(el('span', 'blq-rewards-list', rewards))
      card.appendChild(rw)
    }
    return card
  }

  function renderBody(): void {
    body.replaceChildren()
    const activeQuests = deps.active()

    body.appendChild(el('div', 'blq-section', `Active (${activeQuests.length})`))
    if (activeQuests.length === 0) {
      body.appendChild(
        el(
          'div',
          'blq-empty',
          'No active quests. Somewhere out there, an NPC with a "!" over their personality needs you.'
        )
      )
    } else {
      for (const a of activeQuests) body.appendChild(renderActiveCard(a))
    }

    const doneTitles = deps.completedTitles()
    body.appendChild(el('div', 'blq-section', `Completed (${doneTitles.length})`))
    if (doneTitles.length === 0) {
      body.appendChild(el('div', 'blq-empty', 'Nothing finished yet. The grind respects honesty.'))
    } else {
      const list = el('div', 'blq-donelist')
      for (const t of doneTitles) {
        const row = el('div', 'blq-done')
        row.appendChild(el('span', 'blq-done-mark', '✓'))
        row.appendChild(el('span', 'blq-done-title', t))
        list.appendChild(row)
      }
      body.appendChild(list)
    }
  }

  // =========================================================================
  // Refresh / open-close wiring
  // =========================================================================
  function refreshTracker(): void {
    const f = deps.focused()
    if (!f) {
      tracker.style.display = 'none'
      return
    }
    tracker.style.display = ''
    const step = f.def.steps[f.step]
    trkTitle.textContent = f.def.title
    if (step) {
      trkStep.textContent = step.label
      trkCount.textContent = `${f.done} / ${step.need}`
      trkFill.style.width = `${step.need > 0 ? Math.min(100, (f.done / step.need) * 100) : 0}%`
    } else {
      trkStep.textContent = 'Wrapping up…'
      trkCount.textContent = ''
      trkFill.style.width = '100%'
    }
  }

  function refreshBadge(): void {
    const n = deps.activeCount()
    badge.textContent = String(n)
    badge.style.display = n > 0 ? '' : 'none'
  }

  function refresh(): void {
    refreshBadge()
    refreshTracker()
    if (panel.style.display !== 'none') renderBody()
  }

  function setOpen(open: boolean): void {
    panel.style.display = open ? '' : 'none'
    btn.classList.toggle('blq-btn-open', open)
    if (open) renderBody()
  }

  btn.addEventListener('click', () => setOpen(panel.style.display === 'none'))
  closeBtn.addEventListener('click', () => setOpen(false))
  tracker.addEventListener('click', () => setOpen(true))

  function reflash(target: HTMLElement, cls: string): void {
    target.classList.remove(cls)
    // force a reflow so the animation restarts
    void target.offsetWidth
    target.classList.add(cls)
  }

  root.append(btn, tracker, panel)
  uiMount.appendChild(root)
  refresh()

  return {
    refresh,
    pulse(): void {
      reflash(tracker, 'blq-pulse')
    },
    celebrate(): void {
      reflash(tracker, 'blq-celebrate')
      reflash(btn, 'blq-celebrate')
    },
  }
}
