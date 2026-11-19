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
import type { GameAPI, GoldAPI, WalletInfo } from '../types'
import { events } from '../events'
import { restorePurchases } from '../gold'
import { getRealm, setRealm, REALM_COUNT, fetchRealmPops } from '../net/index'
import { AudioManager } from './audio'

const MAX_REALM_CAP = 2000
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

  /**
   * GOLD module API (balance + store opener). When present, the top-right
   * balances grid shows a GOLD cell whose tap opens the 'Get GOLD' sheet.
   */
  gold?: GoldAPI

  /**
   * Snap-to-North hook (true = camera faces North and holds). Fallback global:
   * `window.blocklingsSetNorthLock`. No hook = no row. Defaults OFF.
   */
  setNorthLock?: (on: boolean) => void
}

/** Window-global hooks other modules may expose (duck-typed, not declared). */
interface ChainLeg {
  address: string
  balance: number
}
interface HudWallet {
  info(): Promise<WalletInfo>
  chains?(): Promise<Partial<Record<string, ChainLeg>>>
}
interface HudGlobals {
  blocklingsWallet?: HudWallet
  blocklingsSetQuality?: (high: boolean) => void
  blocklingsSetAutoRetaliate?: (on: boolean) => void
  blocklingsSetAlwaysDay?: (on: boolean) => void
  blocklingsSetMinimap?: (visible: boolean) => void
  blocklingsSetNorthLock?: (on: boolean) => void
  blocklingsSignOut?: () => unknown
  blocklingsDeleteBlockling?: () => Promise<{ ok: boolean; error?: string }>
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
  // Top-right: collapsible 2x2 balances grid (GOLD / BLOCK / ETH / SOL)
  // + settings gear
  // =========================================================================
  const topRight = el('div', 'bl-topright')

  // --- currency cell icons (custom inline SVG — no emoji, per product rule) --
  const ICON: Record<'gold' | 'block' | 'eth' | 'sol', string> = {
    gold:
      '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="10" fill="#e8c15a" stroke="#8a6508" stroke-width="2"/>' +
      '<circle cx="12" cy="12" r="6.2" fill="none" stroke="#b8860b" stroke-width="1.6"/>' +
      '<rect x="10.9" y="8.2" width="2.2" height="7.6" rx="1.1" fill="#b8860b"/></svg>',
    block:
      '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">' +
      '<rect x="3" y="3" width="18" height="18" rx="4" fill="#f2a93b"/>' +
      '<path d="M8.6 7.2h4.1c1.8 0 2.9.8 2.9 2.3 0 1-.5 1.7-1.4 2 .1 0 1.7.5 1.7 2.2 0 1.6-1.2 2.5-3.1 2.5H8.6V7.2Zm2.1 1.7v2.1h1.7c.8 0 1.2-.4 1.2-1 0-.7-.4-1.1-1.2-1.1h-1.7Zm0 3.6v2.3h1.9c.8 0 1.3-.4 1.3-1.1 0-.8-.5-1.2-1.4-1.2h-1.8Z" fill="#1b1405"/></svg>',
    eth:
      '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">' +
      '<path d="M12 2 5.5 12.2 12 16l6.5-3.8L12 2Z" fill="#8aa0ff"/>' +
      '<path d="M12 17.1 5.5 13.3 12 22l6.5-8.7L12 17.1Z" fill="#6c82e0"/></svg>',
    sol:
      '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">' +
      '<rect x="3" y="3" width="18" height="18" rx="4" fill="#14152a"/>' +
      '<path d="M7 9.2c.1-.2.3-.3.5-.3h9.2c.3 0 .5.4.3.6l-1.5 1.5c-.1.1-.3.2-.5.2H5.9c-.3 0-.5-.4-.3-.6L7 9.2Z" fill="#14f195"/>' +
      '<path d="M7 15.3c.1-.1.3-.2.5-.2h9.2c.3 0 .5.4.3.6l-1.5 1.5c-.1.1-.3.2-.5.2H5.9c-.3 0-.5-.4-.3-.6L7 15.3Z" fill="#9945ff"/></svg>'
  }

  const wallet = el('div', 'bl-wallet')
  const COLLAPSE_KEY = 'blocklings.balances.collapsed'
  const startCollapsed = (() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1'
    } catch {
      return false
    }
  })()

  // Toggle header: chevron + a compact summary (shown when collapsed).
  const walletToggle = el('button', 'bl-wallet-toggle')
  walletToggle.type = 'button'
  const walletChevron = el('span', 'bl-wallet-chevron', '▾')
  const walletTitle = el('span', 'bl-wallet-title', 'Balances')
  const walletSummary = el('span', 'bl-wallet-summary', '')
  walletToggle.appendChild(walletChevron)
  walletToggle.appendChild(walletTitle)
  walletToggle.appendChild(walletSummary)

  const grid = el('div', 'bl-wallet-grid')

  type CurKey = 'gold' | 'block' | 'eth' | 'sol'
  interface Cell {
    amt: HTMLElement
  }
  const cells: Record<CurKey, Cell> = {} as Record<CurKey, Cell>

  function makeCell(k: CurKey, label: string, clickable: boolean): void {
    const cell = el('div', `bl-wallet-cell bl-wallet-${k}`)
    if (clickable) {
      cell.classList.add('bl-wallet-clickable')
      cell.setAttribute('role', 'button')
      cell.tabIndex = 0
    }
    const icon = el('span', 'bl-wallet-icon')
    icon.innerHTML = ICON[k]
    const body = el('span', 'bl-wallet-body')
    const lab = el('span', 'bl-wallet-label', label)
    const amt = el('span', 'bl-wallet-amt', '—')
    body.appendChild(lab)
    body.appendChild(amt)
    cell.appendChild(icon)
    cell.appendChild(body)
    grid.appendChild(cell)
    cells[k] = { amt }
    if (clickable) {
      const open = (): void => opts?.gold?.openStore()
      cell.addEventListener('click', open)
      cell.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          open()
        }
      })
    }
  }

  makeCell('gold', 'GOLD', true) // tap opens the 'Get GOLD' store (IAP surface)
  makeCell('block', 'BLOCK', false)
  makeCell('eth', 'ETH', false)
  makeCell('sol', 'SOL', false)

  wallet.appendChild(walletToggle)
  wallet.appendChild(grid)

  function applyCollapsed(collapsed: boolean): void {
    wallet.classList.toggle('collapsed', collapsed)
    walletChevron.textContent = collapsed ? '▸' : '▾'
    walletToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
  }
  applyCollapsed(startCollapsed)
  walletToggle.addEventListener('click', () => {
    const next = !wallet.classList.contains('collapsed')
    applyCollapsed(next)
    try {
      localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0')
    } catch {
      /* non-fatal */
    }
    uiTick()
  })

  // -- balance formatting + data --------------------------------------------
  const fmtGold = (v: number): string => Math.round(v).toLocaleString()
  const fmtCrypto = (v: number): string =>
    v.toLocaleString(undefined, { maximumFractionDigits: 4 })

  function setGold(v: number): void {
    cells.gold.amt.textContent = fmtGold(v)
    walletSummary.textContent = fmtGold(v) + ' GOLD'
  }

  // GOLD: initial pull + live bus updates (server-authoritative).
  if (opts?.gold) {
    void opts.gold
      .balance()
      .then((v) => setGold(v))
      .catch(() => {
        /* signed out → stays 0; the cell shows — until a value arrives */
      })
    events.on('gold:changed', ({ balance }) => setGold(balance))
  }

  // BLOCK / ETH / SOL: poll the tri-chain wallet on the shared timer.
  let walletBusy = false
  async function pollChains(): Promise<void> {
    const w = g.blocklingsWallet
    if (!w || walletBusy) return
    walletBusy = true
    try {
      const legs = w.chains ? await w.chains() : null
      const block = legs?.['blockle']?.balance
      const eth = legs?.['ethereum']?.balance
      const sol = legs?.['solana']?.balance
      cells.block.amt.textContent = typeof block === 'number' ? fmtCrypto(block) : '—'
      cells.eth.amt.textContent = typeof eth === 'number' ? fmtCrypto(eth) : '—'
      cells.sol.amt.textContent = typeof sol === 'number' ? fmtCrypto(sol) : '—'
    } catch {
      /* offline / signer unavailable — leave the last shown values */
    } finally {
      walletBusy = false
    }
  }
  void pollChains()
  const walletTimer = window.setInterval(() => void pollChains(), WALLET_POLL_MS)
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

  // "Hide buttons" clean-UI mode — toggles #ui.bl-minimal (keeps movement, the
  // ATK action button, hotbar, minimap, combat stance + the gear). Persisted.
  const MINIMAL_KEY = 'blocklings.hideButtons'
  const minimalOn = (): boolean => {
    try { return localStorage.getItem(MINIMAL_KEY) === '1' } catch { return false }
  }
  const applyMinimal = (on: boolean): void => { uiMount!.classList.toggle('bl-minimal', on) }
  applyMinimal(minimalOn())
  panel.appendChild(
    makeToggleRow('Hide buttons', minimalOn(), (on) => {
      try { localStorage.setItem(MINIMAL_KEY, on ? '1' : '0') } catch { /* non-fatal */ }
      applyMinimal(on)
    })
  )

  // Realm picker — shard population (2000/realm, 30 realms). Switch reloads.
  const realmRow = el('div', 'bl-set-row')
  realmRow.appendChild(el('span', 'bl-set-label', 'Realm'))
  const realmBtn = el('button', 'bl-set-signout')
  realmBtn.type = 'button'
  realmBtn.textContent = `Realm ${getRealm()}`
  realmBtn.addEventListener('click', () => void openRealmPicker())
  realmRow.appendChild(realmBtn)
  panel.appendChild(realmRow)

  async function openRealmPicker(): Promise<void> {
    const back = el('div', 'bl-realm-back')
    const card = el('div', 'bl-realm-card')
    card.appendChild(el('div', 'bl-realm-title', 'Choose a Realm'))
    card.appendChild(el('div', 'bl-realm-sub', `Up to ${MAX_REALM_CAP} Blocklings per realm. Switching reloads the world.`))
    const grid = el('div', 'bl-realm-grid')
    card.appendChild(grid)
    const closeR = el('button', 'bl-realm-x', '×')
    closeR.type = 'button'
    closeR.addEventListener('click', () => back.remove())
    card.appendChild(closeR)
    back.appendChild(card)
    back.addEventListener('click', (e) => { if (e.target === back) back.remove() })
    uiMount!.appendChild(back)

    const cur = getRealm()
    const pops = await fetchRealmPops()
    const popOf = (id: number): { pop: number; acct: number; cap: number } => {
      const r = pops.find((p) => p.id === id)
      return { pop: r?.pop ?? 0, acct: r?.acct ?? 0, cap: r?.cap ?? MAX_REALM_CAP }
    }
    // Is the local player signed in? Their own realm is floored to count them,
    // as a member or a guest, so it never reads 0 while they stand in it.
    let selfAcct = false
    try { selfAcct = !!localStorage.getItem('blk_token') } catch { selfAcct = false }
    grid.innerHTML = ''
    for (let i = 1; i <= REALM_COUNT; i++) {
      const raw = popOf(i)
      const cap = raw.cap
      // Floor the current realm at 1 (you're in it — relay count may race your
      // join, or you may be an offline guest not yet in its roster).
      const pop = i === cur ? Math.max(1, raw.pop) : raw.pop
      const acct = i === cur && selfAcct ? Math.max(1, raw.acct) : Math.min(raw.acct, pop)
      const guests = Math.max(0, pop - acct)
      const full = pop >= cap
      const cell = el('button', 'bl-realm-cell' + (i === cur ? ' on' : '') + (full ? ' full' : ''))
      cell.type = 'button'
      // Total headcount is the headline (it's what the cap measures); the
      // members/guests split reconciles it with the signed-in leaderboard.
      const split =
        pop === 0 ? 'empty'
        : guests === 0 ? `${acct} signed in`
        : acct === 0 ? `${guests} guest${guests === 1 ? '' : 's'}`
        : `${acct} member${acct === 1 ? '' : 's'} · ${guests} guest${guests === 1 ? '' : 's'}`
      cell.innerHTML =
        `<span class="bl-realm-n">Realm ${i}</span>` +
        `<span class="bl-realm-pop">${pop}/${cap}</span>` +
        `<span class="bl-realm-split">${split}</span>`
      if (i === cur) cell.disabled = true
      else if (full) cell.disabled = true
      else cell.addEventListener('click', () => {
        setRealm(i)
        location.reload()
      })
      grid.appendChild(cell)
    }
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
  const ensureNorthLockRow = hookToggle(
    'Snap to North',
    'blocklings.snapNorth.on',
    false, // off by default
    () => opts?.setNorthLock ?? g.blocklingsSetNorthLock
  )

  // -- sign-out (only when the auth module published its hook) --------------
  // Apple requires a visible "Restore Purchases" control for IAP apps. Shown
  // only inside the iOS shell (which injects window.blocklingsIAP).
  let restoreRow: HTMLElement | null = null
  function ensureRestoreRow(): void {
    if (restoreRow || !(window as { blocklingsIAP?: unknown }).blocklingsIAP) return
    restoreRow = el('div', 'bl-set-row bl-set-signoutrow')
    const btn = el('button', 'bl-set-signout', 'Restore Purchases')
    btn.type = 'button'
    btn.addEventListener('click', () => {
      btn.disabled = true
      btn.textContent = 'Restoring…'
      void restorePurchases().then((r) => {
        btn.disabled = false
        btn.textContent = 'Restore Purchases'
        api.onChat?.(
          'System',
          r.ok
            ? r.restored
              ? `Restored ${r.restored} purchase${r.restored === 1 ? '' : 's'}.`
              : 'Nothing to restore — your purchases are already active.'
            : r.error ?? 'Restore failed.'
        )
      })
      uiTick()
    })
    restoreRow.appendChild(btn)
    panel.appendChild(restoreRow)
  }

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

  // --- Delete Account (soft delete — 7 confirmations + a math gate) ----------
  const DELETE_STEPS = [
    'Delete your account? Your Blockling will be put away in a little box.',
    'Are you SURE? There is a lot of box-related paperwork involved.',
    'Like… actually sure? We already told the box. The box is excited now.',
    'Your Blocklings will cry tiny voxel tears. Blocky, cuboid tears. Still sure?',
    'The ancient Get-GOLD prophecy foretold this exact click. Proceed anyway?',
    'Final warning: a wizard somewhere will feel a vague sense of loss. Continue?',
    'Okay. Last one. Pinky-promise-cross-your-heart-no-takebacks sure?'
  ]
  const DELETE_MATHS = [
    { q: 'Prove you are serious (and sentient). What is 7 + 5?', a: 12 },
    { q: 'One more sanity check: what is 9 + 4?', a: 13 },
    { q: 'For the paperwork: what is 6 + 8?', a: 14 }
  ]

  let deleteRow: HTMLElement | null = null
  function ensureDeleteRow(): void {
    // Same gate as sign-out: only signed-in accounts can delete (+restore).
    const canDelete = (opts?.signOut ?? g.blocklingsSignOut) && g.blocklingsDeleteBlockling
    if (!canDelete || deleteRow) return
    deleteRow = el('div', 'bl-set-row bl-set-signoutrow')
    const btn = el('button', 'bl-set-danger', 'Delete Account')
    btn.type = 'button'
    btn.addEventListener('click', () => {
      panel.style.display = 'none'
      uiTick()
      runDeleteFlow()
    })
    deleteRow.appendChild(btn)
    panel.appendChild(deleteRow)
  }

  function runDeleteFlow(): void {
    const back = el('div', 'bl-del-back')
    const card = el('div', 'bl-del-card')
    back.appendChild(card)
    back.addEventListener('click', (e) => { if (e.target === back) back.remove() })
    uiMount!.appendChild(back)

    const close = (): void => back.remove()

    const step = (i: number): void => {
      card.innerHTML = ''
      card.appendChild(el('div', 'bl-del-title', `Really? (${i + 1}/7)`))
      card.appendChild(el('div', 'bl-del-msg', DELETE_STEPS[i] ?? 'Sure?'))
      const row = el('div', 'bl-del-actions')
      const no = el('button', 'bl-del-no', 'No, take me back')
      no.type = 'button'
      no.addEventListener('click', close)
      const yes = el('button', 'bl-del-yes', i < 6 ? 'Yes, continue' : 'Yes, I am certain')
      yes.type = 'button'
      yes.addEventListener('click', () => { if (i < 6) step(i + 1); else mathStep() })
      row.appendChild(no)
      row.appendChild(yes)
      card.appendChild(row)
    }

    const mathStep = (): void => {
      const problem = DELETE_MATHS[api.player.name.length % DELETE_MATHS.length] ?? DELETE_MATHS[0]!
      card.innerHTML = ''
      card.appendChild(el('div', 'bl-del-title', 'One tiny maths problem'))
      card.appendChild(el('div', 'bl-del-msg', problem.q))
      const input = document.createElement('input')
      input.type = 'number'
      input.className = 'bl-del-input'
      input.inputMode = 'numeric'
      card.appendChild(input)
      const err = el('div', 'bl-del-err', '')
      card.appendChild(err)
      const row = el('div', 'bl-del-actions')
      const no = el('button', 'bl-del-no', 'Cancel')
      no.type = 'button'
      no.addEventListener('click', close)
      const go = el('button', 'bl-del-yes', 'Delete my account')
      go.type = 'button'
      go.addEventListener('click', () => {
        if (Number(input.value) !== problem.a) {
          err.textContent = "That's not it. Maybe your Blockling should keep doing the maths."
          return
        }
        void doDelete()
      })
      row.appendChild(no)
      row.appendChild(go)
      card.appendChild(row)
      input.focus()
    }

    const doDelete = async (): Promise<void> => {
      card.innerHTML = ''
      card.appendChild(el('div', 'bl-del-title', 'Tidying up…'))
      card.appendChild(el('div', 'bl-del-msg', 'Folding your Blockling into its little box.'))
      const hook = g.blocklingsDeleteBlockling
      const r = hook ? await hook() : { ok: false, error: 'Unavailable.' }
      if (!r.ok) {
        card.innerHTML = ''
        card.appendChild(el('div', 'bl-del-title', 'Hmm.'))
        card.appendChild(el('div', 'bl-del-msg', r.error ?? 'Could not delete right now — try again.'))
        const row = el('div', 'bl-del-actions')
        const ok = el('button', 'bl-del-no', 'Close')
        ok.type = 'button'
        ok.addEventListener('click', close)
        row.appendChild(ok)
        card.appendChild(row)
        return
      }
      close()
      api.onChat?.('System', 'Your Blockling has been tucked away. Restore it anytime at blockle.org/account.')
      const signOut = opts?.signOut ?? g.blocklingsSignOut
      if (signOut) void signOut()
    }

    step(0)
  }

  /** Mount every row whose hook exists (safe to call repeatedly, in order). */
  function ensureRows(): void {
    ensureQualityRow()
    ensureMinimapRow()
    ensureRetaliateRow()
    ensureAlwaysDayRow()
    ensureNorthLockRow()
    ensureRestoreRow()
    ensureSignOutRow()
    ensureDeleteRow()
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

  // Balances live under the character plate (below the HP/MP/XP bars), not in
  // the top-right cluster — only the settings gear stays top-right.
  plate.appendChild(wallet)
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
