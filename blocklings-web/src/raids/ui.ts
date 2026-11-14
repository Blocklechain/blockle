/**
 * Raids DOM overlay — the proximity summon prompt and the shared boss-HP bar
 * pinned to the top during the fight (name, title, HP %, phase, enrage timer,
 * and the live count of nearby raiders from multiplayer presence).
 *
 * Both roots are content-sized elements appended to #ui (never a full-screen
 * pointer-events:none layer), so they do NOT trip the documented #ui input
 * footgun — no src/style.css change required.
 */
import './raids.css'

export interface BossBarState {
  name: string
  title: string
  /** 0..1 */
  hp: number
  tint: string
  phase: number
  phaseCount: number
  /** Seconds until soft-enrage (<=0 once enraged). */
  enrageIn: number
  enraged: boolean
  raiders: number
}

export class RaidsUI {
  onSummon: (() => void) | null = null

  private readonly summonBtn: HTMLButtonElement
  private readonly bar: HTMLDivElement
  private readonly barName: HTMLDivElement
  private readonly barTitle: HTMLDivElement
  private readonly barFill: HTMLDivElement
  private readonly barPct: HTMLDivElement
  private readonly barPhase: HTMLDivElement
  private readonly barEnrage: HTMLDivElement
  private readonly barRaiders: HTMLDivElement

  constructor(mount: HTMLElement) {
    this.summonBtn = document.createElement('button')
    this.summonBtn.className = 'bl-raid-summon'
    this.summonBtn.textContent = 'Summon'
    this.summonBtn.addEventListener('click', () => this.onSummon?.())

    this.bar = document.createElement('div')
    this.bar.className = 'bl-raid-bar'
    const top = document.createElement('div')
    top.className = 'bl-raid-bar-top'
    this.barName = document.createElement('div')
    this.barName.className = 'bl-raid-bar-name'
    this.barTitle = document.createElement('div')
    this.barTitle.className = 'bl-raid-bar-title'
    top.append(this.barName, this.barTitle)

    const track = document.createElement('div')
    track.className = 'bl-raid-bar-track'
    this.barFill = document.createElement('div')
    this.barFill.className = 'bl-raid-bar-fill'
    this.barPct = document.createElement('div')
    this.barPct.className = 'bl-raid-bar-pct'
    track.append(this.barFill, this.barPct)

    const sub = document.createElement('div')
    sub.className = 'bl-raid-bar-sub'
    this.barPhase = document.createElement('div')
    this.barPhase.className = 'bl-raid-bar-phase'
    this.barEnrage = document.createElement('div')
    this.barEnrage.className = 'bl-raid-bar-enrage'
    this.barRaiders = document.createElement('div')
    this.barRaiders.className = 'bl-raid-bar-raiders'
    sub.append(this.barPhase, this.barRaiders, this.barEnrage)

    this.bar.append(top, track, sub)
    mount.append(this.summonBtn, this.bar)
  }

  /** Show/label the proximity summon button (empty label hides it). */
  setSummon(label: string | null): void {
    if (label) {
      this.summonBtn.textContent = label
      this.summonBtn.classList.add('show')
    } else {
      this.summonBtn.classList.remove('show')
    }
  }

  setBarVisible(v: boolean): void {
    this.bar.classList.toggle('show', v)
  }

  setBar(s: BossBarState): void {
    this.barName.textContent = s.name
    this.barTitle.textContent = s.title
    const pct = Math.max(0, Math.min(1, s.hp))
    this.barFill.style.width = `${(pct * 100).toFixed(1)}%`
    this.barFill.style.background = `linear-gradient(180deg, ${s.tint}, rgba(0,0,0,0.35))`
    this.barPct.textContent = `${Math.ceil(pct * 100)}%`
    this.barPhase.textContent = `Phase ${Math.min(s.phase + 1, s.phaseCount)} / ${s.phaseCount}`
    this.barRaiders.textContent =
      s.raiders > 0 ? `${s.raiders + 1} raiders` : 'solo'
    if (s.enraged) {
      this.barEnrage.textContent = 'ENRAGED'
      this.barEnrage.classList.add('hot')
    } else {
      this.barEnrage.classList.remove('hot')
      this.barEnrage.textContent = `enrage ${Math.max(0, Math.ceil(s.enrageIn))}s`
    }
  }

  dispose(): void {
    this.summonBtn.remove()
    this.bar.remove()
  }
}
