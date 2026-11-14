/**
 * Contracts — the job-board UI.
 *
 * The board is a HUD panel reached from a 'Contracts' entry injected into the
 * existing quest log header (this module owns no world placement — the
 * "physical notice board" is the panel). It waits for the quest panel's DOM
 * (created by initQuests) and then:
 *   - adds a CONTRACTS tab button to the quest log's header,
 *   - mounts its own centered panel (same medieval-dark plate styling),
 *     listing today's six postings: comedy title, who pinned it, the posting
 *     body, a step checklist with live progress, payment preview, and a
 *     Take Job / Abandon / PAID footer. Header shows taken-count + the
 *     countdown to the CST-midnight reroll.
 *
 * All state questions go through BoardDeps (wired by ./contracts); this file
 * renders and forwards clicks only.
 */
import type { ContractDef, ContractState } from './contracts'
import './board.css'

export interface BoardDeps {
  contracts(): readonly ContractDef[]
  status(id: string): ContractState
  accept(id: string): boolean
  abandon(id: string): void
  activeCount(): number
  maxActive(): number
  resetsInMs(): number
  rewardText(def: ContractDef): string
  /** Guide-trail tracking (./tracking): is this the sparkled contract? */
  isTracked(id: string): boolean
  /** Track a contract (switches the one trail) or untrack with null. */
  setTracked(id: string | null): void
}

export interface Board {
  refresh(): void
  /** Gold flash on the Contracts tab (a contract paid out). */
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

function countdownText(ms: number): string {
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return h > 0 ? `${h}h ${m}m` : `${Math.max(1, m)}m`
}

export function createBoard(deps: BoardDeps): Board {
  let panel: HTMLDivElement | null = null
  let body: HTMLDivElement | null = null
  let meta: HTMLDivElement | null = null
  let tab: HTMLButtonElement | null = null
  let metaTimer = 0

  // =========================================================================
  // Rendering
  // =========================================================================

  function renderMeta(): void {
    if (!meta) return
    meta.textContent = `Taken ${deps.activeCount()}/${deps.maxActive()} · fresh postings in ${countdownText(deps.resetsInMs())}`
  }

  function renderCard(def: ContractDef): HTMLElement {
    const st = deps.status(def.id)
    const card = el('div', 'blq-card blc-card')
    if (st.state === 'active') card.classList.add('blc-card-active')
    if (st.state === 'done') card.classList.add('blc-card-done')

    const top = el('div', 'blq-card-top')
    const titles = el('div', 'blq-card-titles')
    titles.appendChild(el('div', 'blq-card-title', def.title))
    titles.appendChild(el('div', 'blq-card-giver', `Pinned by ${def.postedBy}`))
    top.appendChild(titles)

    if (st.state === 'done') {
      top.appendChild(el('span', 'blc-stamp', '✓ PAID'))
    } else if (st.state === 'open') {
      const take = el('button', 'blq-track blc-take', 'Take Job')
      take.type = 'button'
      const full = deps.activeCount() >= deps.maxActive()
      if (full) {
        take.disabled = true
        take.textContent = 'Hands Full'
      }
      take.addEventListener('click', () => {
        deps.accept(def.id)
        renderBody()
      })
      top.appendChild(take)
    } else {
      const tracked = deps.isTracked(def.id)
      const track = el('button', 'blq-track', tracked ? 'Untrack' : 'Track')
      track.type = 'button'
      track.classList.toggle('blq-track-on', tracked)
      track.title = 'Follow the sparkles'
      track.addEventListener('click', () => {
        deps.setTracked(tracked ? null : def.id)
        renderBody()
      })
      top.appendChild(track)

      const drop = el('button', 'blc-abandon', 'Abandon')
      drop.type = 'button'
      drop.addEventListener('click', () => {
        deps.abandon(def.id)
        renderBody()
      })
      top.appendChild(drop)
    }
    card.appendChild(top)

    card.appendChild(el('div', 'blc-post', `“${def.intro}”`))

    const steps = el('div', 'blq-steps')
    def.steps.forEach((step, i) => {
      const row = el('div', 'blq-step')
      let mark = '·'
      if (st.state === 'done' || (st.state === 'active' && i < st.step)) {
        mark = '✓'
        row.classList.add('blq-step-done')
      } else if (st.state === 'active' && i === st.step) {
        mark = '▸'
        row.classList.add('blq-step-now')
      } else {
        row.classList.add('blq-step-later')
      }
      row.appendChild(el('span', 'blq-step-mark', mark))
      row.appendChild(el('span', 'blq-step-label', step.label))
      if (st.state === 'active' && i === st.step) {
        row.appendChild(el('span', 'blq-step-count', `${st.done}/${step.need}`))
      }
      steps.appendChild(row)
    })
    card.appendChild(steps)

    const rewards = deps.rewardText(def)
    if (rewards) {
      const rw = el('div', 'blq-rewards')
      rw.appendChild(el('span', 'blq-rewards-tag', 'Payment'))
      rw.appendChild(el('span', 'blq-rewards-list', rewards))
      card.appendChild(rw)
    }
    return card
  }

  function renderBody(): void {
    if (!body) return
    renderMeta()
    body.replaceChildren()
    body.appendChild(el('div', 'blq-section', "Today's postings"))
    const defs = deps.contracts()
    if (defs.length === 0) {
      body.appendChild(el('div', 'blq-empty', 'The board is bare. Suspiciously bare.'))
      return
    }
    for (const def of defs) body.appendChild(renderCard(def))
    body.appendChild(
      el('div', 'blc-foot', 'Contracts reset at midnight CST. The board keeps no grudges. The posters do.')
    )
  }

  // =========================================================================
  // Open / close (cooperates with the quest log via its public buttons)
  // =========================================================================

  function isOpen(): boolean {
    return !!panel && panel.style.display !== 'none'
  }

  function setOpen(open: boolean): void {
    if (!panel) return
    if (open) {
      // Close the quest log first so the two panels never stack.
      const close = document.querySelector<HTMLElement>('.blq-panel:not(.blc-panel) .blq-close')
      close?.click()
      panel.style.display = ''
      renderBody()
      if (!metaTimer) metaTimer = window.setInterval(renderMeta, 30_000)
    } else {
      panel.style.display = 'none'
      if (metaTimer) {
        window.clearInterval(metaTimer)
        metaTimer = 0
      }
    }
    tab?.classList.toggle('blc-tab-open', open)
  }

  // =========================================================================
  // Deferred mount — the quest panel exists only after initQuests() runs.
  // =========================================================================

  function tryMount(): boolean {
    const root = document.querySelector<HTMLElement>('.blq-root')
    const questPanel = root?.querySelector<HTMLElement>('.blq-panel')
    const head = questPanel?.querySelector<HTMLElement>('.blq-head')
    const closeBtn = head?.querySelector<HTMLElement>('.blq-close')
    if (!root || !questPanel || !head || !closeBtn) return false

    // --- 'Contracts' entry inside the quest log header ---------------------
    tab = el('button', 'blc-tab', 'Contracts')
    tab.type = 'button'
    tab.setAttribute('aria-label', 'Open the contracts job board')
    tab.addEventListener('click', () => setOpen(true))
    head.insertBefore(tab, closeBtn)

    // --- the board panel ---------------------------------------------------
    panel = el('div', 'blq-panel blc-panel')
    panel.style.display = 'none'

    const bHead = el('div', 'blq-head')
    const titles = el('div', 'blc-head-titles')
    titles.appendChild(el('span', 'blq-title', 'Job Board'))
    meta = el('div', 'blc-meta')
    titles.appendChild(meta)
    bHead.appendChild(titles)

    const back = el('button', 'blc-tab', 'Quest Log')
    back.type = 'button'
    back.setAttribute('aria-label', 'Back to the quest log')
    back.addEventListener('click', () => {
      setOpen(false)
      document.querySelector<HTMLElement>('.blq-btn')?.click()
    })
    bHead.appendChild(back)

    const close = el('button', 'blq-close', '×')
    close.type = 'button'
    close.setAttribute('aria-label', 'Close the job board')
    close.addEventListener('click', () => setOpen(false))
    bHead.appendChild(close)
    panel.appendChild(bHead)

    body = el('div', 'blq-body')
    panel.appendChild(body)
    root.appendChild(panel)

    // Opening the quest log (the "!" button) hides the board.
    root.querySelector<HTMLElement>('.blq-btn')?.addEventListener('click', () => setOpen(false))
    return true
  }

  if (!tryMount()) {
    const poll = window.setInterval(() => {
      if (tryMount()) window.clearInterval(poll)
    }, 500)
  }

  return {
    refresh(): void {
      if (isOpen()) renderBody()
    },
    celebrate(): void {
      if (!tab) return
      tab.classList.remove('blq-celebrate')
      void tab.offsetWidth
      tab.classList.add('blq-celebrate')
    },
  }
}
