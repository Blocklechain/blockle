/**
 * Pet panel — HUD paw button + collection grid.
 *
 * Grid of owned pets (variant-rarity borders, chain badges B/Ξ/◎ lit per
 * mint, active-pet star), a detail card with nickname editing, set-active /
 * dismiss, and the MINT flow: chain picker → wallet.mintNft (real, wired by
 * the integrator) → badge lights up on a REAL tx. Errors are shown verbatim
 * and nothing is ever faked.
 */
import type { ChainId, PetInstance } from '../types'
import { SPECIES, petDef } from '../ids'
import { VARIANT_LOOK, variantTileColor } from './palette'
import './pets.css'

export interface PetsPanelDeps {
  owned(): readonly PetInstance[]
  activeUid(): string | null
  setActive(uid: string | null): void
  setNickname(uid: string, nickname: string): void
  mint(uid: string, chain: ChainId): Promise<{ ok: boolean; token?: string; tx?: string; error?: string }>
  /** Distinct petIds owned (the "X / 56 discovered" flex). */
  discovered(): number
  totalCatalog(): number
}

const CHAIN_BADGES: readonly { chain: ChainId; glyph: string; label: string }[] = [
  { chain: 'blockle', glyph: 'B', label: 'Blockle' },
  { chain: 'ethereum', glyph: 'Ξ', label: 'Ethereum' },
  { chain: 'solana', glyph: '◎', label: 'Solana' },
]

const speciesById = new Map(SPECIES.map((s) => [s.id, s] as const))

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

const PAW_SVG =
  '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor">' +
  '<circle cx="6.1" cy="9.4" r="2.1"/><circle cx="10" cy="6.2" r="2.2"/>' +
  '<circle cx="14.6" cy="6.4" r="2.2"/><circle cx="18.2" cy="9.8" r="2.1"/>' +
  '<path d="M12.2 10.3c2.9 0 5.8 2.6 5.8 5.2 0 1.7-1.3 2.8-3 2.8-1.1 0-1.9-.5-2.8-.5-.9 0-1.7.5-2.8.5-1.7 0-3-1.1-3-2.8 0-2.6 2.9-5.2 5.8-5.2Z"/></svg>'

export function createPetsPanel(deps: PetsPanelDeps): { refresh(): void; flashButton(): void } {
  const uiMount = document.getElementById('ui')
  if (!uiMount) throw new Error('missing #ui overlay mount')

  const root = el('div', 'bl-pets-root')

  // -- paw button (bottom-right stack, above the bag/skills cluster) --------
  const btn = el('button', 'bl-pets-btn')
  btn.type = 'button'
  btn.setAttribute('aria-label', 'Pets')
  btn.innerHTML = PAW_SVG
  btn.appendChild(el('span', 'bl-pets-btn-label', 'Pets'))

  // -- panel ----------------------------------------------------------------
  const panel = el('div', 'bl-pets')
  panel.style.display = 'none'

  const head = el('div', 'bl-pets-head')
  head.appendChild(el('span', 'bl-pets-title', 'Pets'))
  const countEl = el('span', 'bl-pets-count', '')
  head.appendChild(countEl)
  const closeBtn = el('button', 'bl-pets-close', '×')
  closeBtn.type = 'button'
  closeBtn.setAttribute('aria-label', 'Close pets')
  head.appendChild(closeBtn)
  panel.appendChild(head)

  const empty = el('div', 'bl-pets-empty',
    'No pets yet. Rare critters sometimes take a liking to whoever just defeated them. Keep swinging.')
  panel.appendChild(empty)

  const grid = el('div', 'bl-pets-grid')
  panel.appendChild(grid)

  const detail = el('div', 'bl-pets-detail')
  detail.style.display = 'none'
  panel.appendChild(detail)

  let selectedUid: string | null = null
  let mintBusy = false
  let pickerOpen = false
  let statusText = ''
  let statusKind: 'ok' | 'err' | '' = ''

  // -------------------------------------------------------------------------
  // Grid
  // -------------------------------------------------------------------------

  function renderGrid(): void {
    grid.textContent = ''
    const pets = deps.owned()
    empty.style.display = pets.length === 0 ? '' : 'none'
    const activeUid = deps.activeUid()

    for (const pet of pets) {
      const def = petDef(pet.petId)
      const sp = def ? speciesById.get(def.species) : undefined
      const look = VARIANT_LOOK[def?.variant ?? 'base']

      const tile = el('button', 'bl-pet-tile')
      tile.type = 'button'
      tile.style.borderColor = look.accent
      if (pet.uid === selectedUid) tile.classList.add('bl-pet-tile-sel')

      const swatch = el('div', 'bl-pet-swatch')
      swatch.style.background = sp
        ? variantTileColor(sp.color, def?.variant ?? 'base')
        : '#666'
      if (activeUid === pet.uid) swatch.appendChild(el('span', 'bl-pet-active-star', '★'))
      tile.appendChild(swatch)

      tile.appendChild(el('div', 'bl-pet-tile-name', pet.nickname ?? def?.name ?? pet.petId))
      tile.appendChild(el('div', 'bl-pet-tile-sub', `${sp?.name ?? '?'} · ${def?.variant ?? '?'}`))

      const badges = el('div', 'bl-pet-badges')
      for (const b of CHAIN_BADGES) {
        const lit = pet.mints.some((m) => m.chain === b.chain)
        const badge = el('span', `bl-pet-badge${lit ? ' bl-pet-badge-lit' : ''}`, b.glyph)
        badge.title = lit ? `Minted on ${b.label}` : `Not minted on ${b.label}`
        badges.appendChild(badge)
      }
      tile.appendChild(badges)

      tile.addEventListener('click', () => {
        selectedUid = pet.uid === selectedUid ? null : pet.uid
        pickerOpen = false
        statusText = ''
        statusKind = ''
        refresh()
      })
      grid.appendChild(tile)
    }
  }

  // -------------------------------------------------------------------------
  // Detail card
  // -------------------------------------------------------------------------

  function renderDetail(): void {
    detail.textContent = ''
    const pet = deps.owned().find((p) => p.uid === selectedUid)
    if (!pet) {
      detail.style.display = 'none'
      return
    }
    detail.style.display = ''
    const def = petDef(pet.petId)
    const sp = def ? speciesById.get(def.species) : undefined
    const look = VARIANT_LOOK[def?.variant ?? 'base']
    const isActive = deps.activeUid() === pet.uid

    const title = el('div', 'bl-pet-d-title', def?.name ?? pet.petId)
    title.style.color = look.accent
    detail.appendChild(title)
    detail.appendChild(
      el('div', 'bl-pet-d-sub',
        `${sp?.name ?? '?'} · ${def?.variant ?? '?'} · ${look.rarity} · 1 in ${def?.dropOneIn.toLocaleString() ?? '?'}`)
    )

    // nickname
    const nickRow = el('div', 'bl-pet-d-row')
    const nick = document.createElement('input')
    nick.type = 'text'
    nick.maxLength = 24
    nick.placeholder = 'Nickname…'
    nick.className = 'bl-pet-nick'
    nick.value = pet.nickname ?? ''
    const nickBtn = el('button', 'bl-pet-mini-btn', 'Save')
    nickBtn.type = 'button'
    nickBtn.addEventListener('click', () => {
      deps.setNickname(pet.uid, nick.value.trim())
      refresh()
    })
    nick.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') nickBtn.click()
    })
    nickRow.appendChild(nick)
    nickRow.appendChild(nickBtn)
    detail.appendChild(nickRow)

    // set-active / dismiss
    const activeBtn = el('button', 'bl-pet-wide-btn', isActive ? 'Dismiss (send to bed)' : 'Set active')
    activeBtn.type = 'button'
    if (isActive) activeBtn.classList.add('bl-pet-wide-btn-on')
    activeBtn.addEventListener('click', () => {
      deps.setActive(isActive ? null : pet.uid)
      refresh()
    })
    detail.appendChild(activeBtn)

    // mint area
    const mints = el('div', 'bl-pet-d-mints')
    for (const b of CHAIN_BADGES) {
      const rec = pet.mints.find((m) => m.chain === b.chain)
      const chip = el('span', `bl-pet-badge bl-pet-badge-big${rec ? ' bl-pet-badge-lit' : ''}`, b.glyph)
      chip.title = rec ? `Minted on ${b.label} — tx ${rec.tx}` : `Not minted on ${b.label}`
      mints.appendChild(chip)
    }
    detail.appendChild(mints)

    const unminted = CHAIN_BADGES.filter((b) => !pet.mints.some((m) => m.chain === b.chain))
    if (unminted.length > 0) {
      if (!pickerOpen) {
        const mintBtn = el('button', 'bl-pet-wide-btn bl-pet-mint-btn', 'MINT as NFT')
        mintBtn.type = 'button'
        mintBtn.disabled = mintBusy
        mintBtn.addEventListener('click', () => {
          pickerOpen = true
          refresh()
        })
        detail.appendChild(mintBtn)
      } else {
        const picker = el('div', 'bl-pet-picker')
        picker.appendChild(el('div', 'bl-pet-picker-label', mintBusy ? 'Minting… (wallet-signed)' : 'Mint on:'))
        const rowEl = el('div', 'bl-pet-d-row')
        for (const b of unminted) {
          const cbtn = el('button', 'bl-pet-chain-btn', `${b.glyph} ${b.label}`)
          cbtn.type = 'button'
          cbtn.disabled = mintBusy
          cbtn.addEventListener('click', () => {
            void doMint(pet.uid, b.chain)
          })
          rowEl.appendChild(cbtn)
        }
        picker.appendChild(rowEl)
        detail.appendChild(picker)
      }
    } else {
      detail.appendChild(el('div', 'bl-pet-d-done', 'Minted on every chain. A true cross-chain citizen.'))
    }

    if (statusText) {
      const status = el('div', `bl-pet-status bl-pet-status-${statusKind}`, statusText)
      detail.appendChild(status)
    }
  }

  async function doMint(uid: string, chain: ChainId): Promise<void> {
    if (mintBusy) return
    mintBusy = true
    statusText = ''
    statusKind = ''
    refresh()
    try {
      const res = await deps.mint(uid, chain)
      if (res.ok && res.tx) {
        statusText = `Minted on ${chain} — tx ${res.tx.slice(0, 18)}…`
        statusKind = 'ok'
        pickerOpen = false
      } else {
        statusText = res.error ?? 'Mint failed.'
        statusKind = 'err'
      }
    } catch (e) {
      statusText = e instanceof Error ? e.message : 'Mint failed.'
      statusKind = 'err'
    } finally {
      mintBusy = false
      refresh()
    }
  }

  // -------------------------------------------------------------------------

  function refresh(): void {
    if (panel.style.display === 'none') return
    countEl.textContent = `${deps.owned().length} owned · ${deps.discovered()} / ${deps.totalCatalog()} found`
    renderGrid()
    renderDetail()
  }

  function setOpen(open: boolean): void {
    panel.style.display = open ? '' : 'none'
    btn.classList.toggle('bl-pets-btn-open', open)
    btn.classList.remove('bl-pets-btn-flash')
    if (open) refresh()
  }
  btn.addEventListener('click', () => setOpen(panel.style.display === 'none'))
  closeBtn.addEventListener('click', () => setOpen(false))

  root.appendChild(btn)
  root.appendChild(panel)
  uiMount.appendChild(root)

  return {
    refresh,
    /** Pulse the paw when a pet drops while the panel is closed. */
    flashButton(): void {
      if (panel.style.display === 'none') {
        btn.classList.remove('bl-pets-btn-flash')
        void btn.offsetWidth // restart the animation
        btn.classList.add('bl-pets-btn-flash')
      }
    },
  }
}
