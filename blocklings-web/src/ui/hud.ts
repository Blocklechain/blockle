/**
 * Blocklings — HUD root module.
 *
 * Builds the Phase-1 MMORPG overlay as DOM inside #ui:
 *   - top-left character plate (name, level, HP/MP/XP bars) driven from
 *     `api.player` every frame;
 *   - top-right BLOCK balance chip (shown only when a wallet hook exists)
 *     and a settings gear with a working panel: music/SFX volume plus
 *     hook-gated toggles (render quality, mini-map, auto-retaliate,
 *     always-day) and a sign-out button — rows only render when their
 *     owning module's hook exists (no dead controls);
 *   - bottom chat box (see ./chat; local /who and /zone commands);
 *   - zone banner fade-in on spawn.
 *
 * hud.css additionally owns the cross-module overlay arbitration: the gold
 * chip / paw / storefront / special buttons mount themselves, but their
 * positions, z-indices and safe-area offsets are coordinated there so the
 * top-right cluster and bottom-right stacks never collide on phones.
 *
 * Every control shipped here works — nothing is decorative.
 */
import type { GameAPI, WalletInfo } from '../types'
import { AudioManager } from './audio'
import { createChat } from './chat'
import './hud.css'

/** Optional integration hooks (also discoverable via window globals). */
export interface HUDOptions {
  /**
   * Render-quality hook: called with `true` for high quality (full
   * devicePixelRatio) / `false` for low. When neither this nor
   * `window.blocklingsSetQuality` exists, the quality toggle is not
   * rendered (no dead controls).
   */
  setQuality?: (high: boolean) => void

  /**
   * Combat auto-retaliate setter (hit back when hit; combat defaults ON).
   * Fallback global: `window.blocklingsSetAutoRetaliate`. No hook = no row.
   */
  setAutoRetaliate?: (on: boolean) => void

  /**
   * Atmosphere always-day hook (true = pin the clock at high noon).
   * Fallback global: `window.blocklingsSetAlwaysDay`. No hook = no row.
   */
  setAlwaysDay?: (on: boolean) => void

  /**
   * Mini-map visibility hook (worldmap module persists the preference).
   * Fallback global: `window.blocklingsSetMinimap`. No hook = no row.
   */
  setMinimap?: (visible: boolean) => void

  /**
   * Blockle-account sign-out hook (auth module; may be async).
   * Fallback global: `window.blocklingsSignOut`. No hook = no button.
   */
  signOut?: () => unknown
}

/** Window-global hooks other modules may expose (duck-typed, not declared). */
interface HudGlobals {
  blocklingsWallet?: { info(): Promise<WalletInfo> }
  blocklingsSetQuality?: (high: boolean) => void
  blocklingsSetAutoRetaliate?: (on: boolean) => void
  blocklingsSetAlwaysDay?: (on: boolean) => void
  blocklingsSetMinimap?: (visible: boolean) => void
  blocklingsSignOut?: () => unknown
}

const QUALITY_KEY = 'blocklings.quality.high'
const AUTO_RET_KEY = 'blocklings.autoRetaliate.on'
const ALWAYS_DAY_KEY = 'blocklings.alwaysDay.on'
/** Shared with the worldmap module (it reads/writes the same preference). */
const MINIMAP_KEY = 'blocklings.minimap.on'
const WALLET_POLL_MS = 5000
const ZONE_NAME = 'Kingdom of Beginnings'

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

function pct(cur: number, max: number): string {
  if (max <= 0) return '0%'
  return `${Math.min(100, Math.max(0, (cur / max) * 100)).toFixed(1)}%`
}

export function createHUD(api: GameAPI, opts?: HUDOptions): { update(): void } {
  const uiMount = document.getElementById('ui')
  if (!uiMount) throw new Error('missing #ui overlay mount')

  const g = window as unknown as HudGlobals
  const audio = new AudioManager()
  const uiTick = (): void => audio.tick()

  const root = el('div', 'bl-hud')

  // =========================================================================
  // Top-left: character plate
  // =========================================================================
  const plate = el('div', 'bl-plate')
  const plateHead = el('div', 'bl-plate-head')
  const nameEl = el('span', 'bl-name')
  const levelEl = el('span', 'bl-level')
  plateHead.appendChild(nameEl)
  plateHead.appendChild(levelEl)
  plate.appendChild(plateHead)

  function makeBar(kind: 'hp' | 'mp' | 'xp'): {
    fill: HTMLElement
    text: HTMLElement
  } {
    const bar = el('div', `bl-bar bl-bar-${kind}`)
    const fill = el('div', 'bl-bar-fill')
    const text = el('span', 'bl-bar-text')
    bar.appendChild(fill)
    bar.appendChild(text)
    plate.appendChild(bar)
    return { fill, text }
  }
  const hpBar = makeBar('hp')
  const mpBar = makeBar('mp')
  const xpBar = makeBar('xp')

  let plateCache = ''
  function refreshPlate(): void {
    const p = api.player
    const key = `${p.name}|${p.level}|${p.hp}/${p.maxHp}|${p.mp}/${p.maxMp}|${p.xp}/${p.xpToNext}`
    if (key === plateCache) return
    plateCache = key
    nameEl.textContent = p.name
    levelEl.textContent = `Lv ${p.level}`
    hpBar.fill.style.width = pct(p.hp, p.maxHp)
    hpBar.text.textContent = `${Math.round(p.hp)} / ${Math.round(p.maxHp)}`
    hpBar.fill.classList.toggle('bl-low', p.maxHp > 0 && p.hp / p.maxHp < 0.25)
    mpBar.fill.style.width = pct(p.mp, p.maxMp)
    mpBar.text.textContent = `${Math.round(p.mp)} / ${Math.round(p.maxMp)}`
    xpBar.fill.style.width = pct(p.xp, p.xpToNext)
    xpBar.text.textContent = `XP ${Math.round(p.xp)} / ${Math.round(p.xpToNext)}`
  }

  // =========================================================================
  // Top-right: BLOCK balance chip + settings gear
  // =========================================================================
  const topRight = el('div', 'bl-topright')

  const chip = el('div', 'bl-chip')
  chip.style.display = 'none' // hidden until a wallet hook answers
  const chipIcon = el('span', 'bl-chip-icon', 'B')
  const chipAmt = el('span', 'bl-chip-amt', '—')
  const chipCur = el('span', 'bl-chip-cur', 'BLOCK')
  const chipLock = el('span', 'bl-chip-lock', 'locked')
  chipLock.style.display = 'none'
  chip.appendChild(chipIcon)
  chip.appendChild(chipAmt)
  chip.appendChild(chipCur)
  chip.appendChild(chipLock)
  chip.title = ''

  let walletBusy = false
  async function pollWallet(): Promise<void> {
    const wallet = g.blocklingsWallet
    if (!wallet || walletBusy) return
    walletBusy = true
    try {
      const info = await wallet.info()
      chipAmt.textContent = info.balance.toLocaleString(undefined, {
        maximumFractionDigits: 4
      })
      chipLock.style.display = info.locked ? '' : 'none'
      chip.title = info.address
      // Zero-balance chip is just clutter — show it once there's real crypto.
      chip.style.display = info.balance > 0 ? '' : 'none'
    } catch {
      chip.style.display = 'none'
    } finally {
      walletBusy = false
    }
  }
  void pollWallet()
  const walletTimer = window.setInterval(() => void pollWallet(), WALLET_POLL_MS)
  void walletTimer // kept for symmetry; HUD lives for the page's lifetime

  // -- settings gear + panel ------------------------------------------------
  const gearBtn = el('button', 'bl-gear')
  gearBtn.type = 'button'
  gearBtn.setAttribute('aria-label', 'Settings')
  gearBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' +
    '<path fill="currentColor" d="M19.4 13a7.6 7.6 0 0 0 .1-1 7.6 7.6 0 0 0-.1-1l2.1-1.6a.5.5 0 0 0 .1-.7l-2-3.4a.5.5 0 0 0-.6-.2l-2.5 1a7.7 7.7 0 0 0-1.7-1l-.4-2.6a.5.5 0 0 0-.5-.5h-4a.5.5 0 0 0-.5.4l-.4 2.7a7.7 7.7 0 0 0-1.7 1l-2.5-1a.5.5 0 0 0-.6.2l-2 3.4a.5.5 0 0 0 .1.7L4.5 11a7.6 7.6 0 0 0 0 2l-2.1 1.6a.5.5 0 0 0-.1.7l2 3.4c.1.2.4.3.6.2l2.5-1c.5.4 1.1.8 1.7 1l.4 2.7c0 .2.2.4.5.4h4c.2 0 .5-.2.5-.4l.4-2.7a7.7 7.7 0 0 0 1.7-1l2.5 1c.2.1.5 0 .6-.2l2-3.4a.5.5 0 0 0-.1-.7L19.4 13Zm-7.4 2.5A3.5 3.5 0 1 1 15.5 12 3.5 3.5 0 0 1 12 15.5Z"/></svg>'

  const panel = el('div', 'bl-settings')
  panel.style.display = 'none'

  const panelHead = el('div', 'bl-settings-head')
  panelHead.appendChild(el('span', 'bl-settings-title', 'Settings'))
  const closeBtn = el('button', 'bl-settings-close', '×')
  closeBtn.type = 'button'
  closeBtn.setAttribute('aria-label', 'Close settings')
  panelHead.appendChild(closeBtn)
  panel.appendChild(panelHead)

  function sliderRow(
    label: string,
    initial: number,
    onInput: (v: number) => void,
    onCommit?: () => void
  ): void {
    const row = el('label', 'bl-set-row')
    row.appendChild(el('span', 'bl-set-label', label))
    const slider = document.createElement('input')
    slider.type = 'range'
    slider.min = '0'
    slider.max = '100'
    slider.step = '1'
    slider.value = String(Math.round(initial * 100))
    slider.className = 'bl-set-slider'
    const val = el('span', 'bl-set-val', `${slider.value}%`)
    slider.addEventListener('input', () => {
      val.textContent = `${slider.value}%`
      onInput(Number(slider.value) / 100)
    })
    if (onCommit) slider.addEventListener('change', onCommit)
    row.appendChild(slider)
    row.appendChild(val)
    panel.appendChild(row)
  }

  sliderRow('Music', audio.music, (v) => audio.setMusicVolume(v))
  sliderRow(
    'SFX',
    audio.sfx,
    (v) => audio.setSfxVolume(v),
    () => audio.tick() // audible confirmation at the chosen level
  )

  // -- hook-gated toggle rows (no hook = no dead control) -------------------

  function makeToggleRow(
    label: string,
    checked: boolean,
    onChange: (on: boolean) => void
  ): HTMLLabelElement {
    const row = el('label', 'bl-set-row bl-set-toggle')
    row.appendChild(el('span', 'bl-set-label', label))
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'bl-set-check'
    box.checked = checked
    box.addEventListener('change', () => {
      onChange(box.checked)
      uiTick()
    })
    row.appendChild(box)
    row.appendChild(el('span', 'bl-set-switch'))
    return row
  }

  /**
   * A persisted on/off setting whose backing hook may register after boot
   * (modules boot in integrator order). Each ensure():
   *   - no hook yet -> nothing (re-checked on every gear tap);
   *   - hook found -> push a stored non-default preference into it ONCE,
   *     then mount the toggle row.
   */
  function hookToggle(
    label: string,
    storageKey: string,
    defaultOn: boolean,
    resolve: () => ((on: boolean) => void) | undefined
  ): () => void {
    let row: HTMLLabelElement | null = null
    let pushed = false
    const stored = (): boolean => {
      const v = localStorage.getItem(storageKey)
      return v === null ? defaultOn : v === '1'
    }
    return function ensure(): void {
      const hook = resolve()
      if (!hook) return
      if (!pushed) {
        pushed = true
        if (stored() !== defaultOn) hook(stored())
      }
      if (row) return
      row = makeToggleRow(label, stored(), (on) => {
        try {
          localStorage.setItem(storageKey, on ? '1' : '0')
        } catch {
          /* non-fatal */
        }
        resolve()?.(on)
      })
      panel.appendChild(row)
    }
  }

  const ensureQualityRow = hookToggle(
    'High resolution',
    QUALITY_KEY,
    true,
    () => opts?.setQuality ?? g.blocklingsSetQuality
  )
  const ensureMinimapRow = hookToggle(
    'Mini-map',
    MINIMAP_KEY,
    true,
    () => opts?.setMinimap ?? g.blocklingsSetMinimap
  )
  const ensureRetaliateRow = hookToggle(
    'Auto-retaliate',
    AUTO_RET_KEY,
    true,
    () => opts?.setAutoRetaliate ?? g.blocklingsSetAutoRetaliate
  )
  const ensureAlwaysDayRow = hookToggle(
    'Always day',
    ALWAYS_DAY_KEY,
    false,
    () => opts?.setAlwaysDay ?? g.blocklingsSetAlwaysDay
  )

  // -- sign-out (only when the auth module published its hook) --------------
  let signOutRow: HTMLElement | null = null
  function ensureSignOutRow(): void {
    const hook = opts?.signOut ?? g.blocklingsSignOut
    if (!hook || signOutRow) return
    signOutRow = el('div', 'bl-set-row bl-set-signoutrow')
    const btn = el('button', 'bl-set-signout', 'Sign out')
    btn.type = 'button'
    btn.addEventListener('click', () => {
      panel.style.display = 'none'
      uiTick()
      void hook()
    })
    signOutRow.appendChild(btn)
    panel.appendChild(signOutRow)
  }

  /** Mount every row whose hook exists (safe to call repeatedly, in order). */
  function ensureRows(): void {
    ensureQualityRow()
    ensureMinimapRow()
    ensureRetaliateRow()
    ensureAlwaysDayRow()
    ensureSignOutRow()
  }
  ensureRows()

  gearBtn.addEventListener('click', () => {
    const show = panel.style.display === 'none'
    ensureRows() // hooks registered after boot still get their rows
    panel.style.display = show ? '' : 'none'
    uiTick()
  })
  closeBtn.addEventListener('click', () => {
    panel.style.display = 'none'
    uiTick()
  })

  topRight.appendChild(chip)
  topRight.appendChild(gearBtn)

  // =========================================================================
  // Bottom: chat
  // =========================================================================
  const chat = createChat(api, uiTick)

  // =========================================================================
  // Zone banner (fade in on spawn, fade out, then removed)
  // =========================================================================
  const banner = el('div', 'bl-zone')
  banner.appendChild(el('div', 'bl-zone-name', ZONE_NAME))
  banner.appendChild(el('div', 'bl-zone-rule'))
  banner.addEventListener('animationend', () => banner.remove())

  // =========================================================================
  // Mount
  // =========================================================================
  root.appendChild(plate)
  root.appendChild(topRight)
  root.appendChild(panel)
  root.appendChild(chat)
  root.appendChild(banner)
  uiMount.appendChild(root)

  refreshPlate()

  return {
    update(): void {
      refreshPlate()
    }
  }
}
