/**
 * wallet/ui.ts — the in-game BLOCK wallet panel (medieval parchment flavor).
 *
 * `initWalletUI(mount, api)` appends a toggle button + panel to `mount`
 * (the #ui overlay). Every control drives the real WalletAPI: create (with
 * a one-time self-custody backup warning), restore, unlock, copy address,
 * live balance, and a two-step send flow. No fake data anywhere — errors
 * from the wasm/chain surface verbatim.
 */
import type { ChainId, WalletAPI2 } from '../types'
import { lock } from './index'

const PANEL_ID = 'blkw-panel'

// iOS App Store build: wallet is VIEW-ONLY for crypto (no send / no MoonPay);
// crypto lives on the web, same account. See src/platform.ts (lazy gate).
import { isIosApp, openCryptoWeb } from '../platform'

/** Display config for the two classical chains shown as cards. */
const CHAIN_CARDS: { id: ChainId; label: string; unit: string; hint: string }[] = [
  { id: 'ethereum', label: 'Ethereum', unit: 'ETH', hint: '0x…' },
  { id: 'solana', label: 'Solana', unit: 'SOL', hint: 'base58 address' }
]

export function initWalletUI(mount: HTMLElement, api: WalletAPI2): { update(dt: number): void } {
  injectStyles()

  const toggle = el('button', 'blkw-toggle') as HTMLButtonElement
  toggle.type = 'button'
  toggle.title = 'BLOCK wallet'
  toggle.innerHTML = coinSvg() + '<span>Wallet</span>'
  mount.appendChild(toggle)

  const panel = el('div', 'blkw')
  panel.id = PANEL_ID
  panel.style.display = 'none'
  mount.appendChild(panel)

  let open = false
  let balanceTimer: number | null = null

  toggle.addEventListener('click', () => {
    open = !open
    panel.style.display = open ? 'block' : 'none'
    if (open) {
      void route()
      balanceTimer = window.setInterval(() => void refreshBalance(), 30_000)
    } else if (balanceTimer !== null) {
      clearInterval(balanceTimer)
      balanceTimer = null
    }
  })

  // ------------------------------------------------------------------ views

  async function route(): Promise<void> {
    if (!api.exists()) return viewWelcome()
    const info = await api.info()
    if (info.locked) return viewUnlock()
    return viewMain()
  }

  function header(sub: string): string {
    return (
      `<div class="blkw-head">${coinSvg()}<div><div class="blkw-title">BLOCK Satchel</div>` +
      `<div class="blkw-sub">${esc(sub)}</div></div><button type="button" class="blkw-x" data-act="close">✕</button></div>`
    )
  }

  function viewWelcome(): void {
    panel.innerHTML =
      header('Your own coin purse — keys never leave this device') +
      `<div class="blkw-tabs"><button type="button" class="blkw-tab on" data-act="tab-new">New purse</button>` +
      `<button type="button" class="blkw-tab" data-act="tab-restore">Restore</button></div>` +
      `<div class="blkw-body" id="blkw-tabbody"></div>`
    wireCommon()
    tabNew()
    on('[data-act=tab-new]', () => {
      setTab('tab-new')
      tabNew()
    })
    on('[data-act=tab-restore]', () => {
      setTab('tab-restore')
      tabRestore()
    })
  }

  function setTab(act: string): void {
    panel.querySelectorAll('.blkw-tab').forEach((t) => {
      t.classList.toggle('on', (t as HTMLElement).dataset['act'] === act)
    })
  }

  function tabNew(): void {
    const body = byId('blkw-tabbody')
    body.innerHTML =
      `<p class="blkw-note">Forge a brand-new BLOCK wallet. It is sealed with your passphrase and stored only in this browser.</p>` +
      `<label class="blkw-label">Passphrase (min 8 chars)<input type="password" id="blkw-pass1" autocomplete="new-password"></label>` +
      `<label class="blkw-label">Repeat passphrase<input type="password" id="blkw-pass2" autocomplete="new-password"></label>` +
      `<div class="blkw-err" id="blkw-err"></div>` +
      `<button type="button" class="blkw-btn primary" data-act="create">Forge wallet</button>`
    on('[data-act=create]', () => void doCreate())
  }

  async function doCreate(): Promise<void> {
    const p1 = (byId('blkw-pass1') as HTMLInputElement).value
    const p2 = (byId('blkw-pass2') as HTMLInputElement).value
    const err = byId('blkw-err')
    err.textContent = ''
    if (p1.length < 8) return void (err.textContent = 'Passphrase must be at least 8 characters.')
    if (p1 !== p2) return void (err.textContent = 'Passphrases do not match.')
    busy('Forging keys (post-quantum)…')
    try {
      const backup = await api.create(p1)
      const info = await api.info()
      viewBackup(backup, info.address)
    } catch (e) {
      viewWelcome()
      byId('blkw-err').textContent = msg(e)
    }
  }

  function viewBackup(backup: string, address: string): void {
    panel.innerHTML =
      header('Write down your backup — it IS your money') +
      `<div class="blkw-body">` +
      `<div class="blkw-warn"><b>SELF-CUSTODY WARNING.</b> This backup key is the ONLY way to recover your BLOCK. ` +
      `Nobody — not the game, not Blockle — holds a copy and nobody can reset it. ` +
      `Anyone who sees it can take your funds. Save it somewhere safe and private, OFF this device. It is shown ONCE.</div>` +
      `<div class="blkw-addr">Your address<br><code>${esc(address)}</code></div>` +
      `<textarea class="blkw-backup" readonly rows="5">${esc(backup)}</textarea>` +
      `<div class="blkw-row">` +
      `<button type="button" class="blkw-btn" data-act="copy-backup">Copy backup</button>` +
      `<button type="button" class="blkw-btn" data-act="dl-backup">Download .txt</button></div>` +
      `<label class="blkw-check"><input type="checkbox" id="blkw-ack"> I saved my backup key. I understand it cannot be recovered.</label>` +
      `<div class="blkw-err" id="blkw-err"></div>` +
      `<button type="button" class="blkw-btn primary" data-act="backup-done">Enter the realm</button>` +
      `</div>`
    wireCommon()
    on('[data-act=copy-backup]', () => void copyText(backup, '[data-act=copy-backup]', 'Copied!'))
    on('[data-act=dl-backup]', () => {
      void downloadText('blocklings-wallet-backup.txt', backup + '\n', '[data-act=dl-backup]')
    })
    on('[data-act=backup-done]', () => {
      if (!(byId('blkw-ack') as HTMLInputElement).checked) {
        byId('blkw-err').textContent = 'Tick the box once your backup is safely stored.'
        return
      }
      void viewMain()
    })
  }

  function tabRestore(): void {
    const body = byId('blkw-tabbody')
    body.innerHTML =
      `<p class="blkw-note">Paste a <code>blockling-key-v1:…</code> backup, a raw ML-DSA key pair (secret + public hex), or a desktop wallet.json with plaintext keys.</p>` +
      `<textarea id="blkw-restore-key" rows="4" placeholder="backup key…" spellcheck="false"></textarea>` +
      `<label class="blkw-label">New passphrase for this device (min 8 chars)<input type="password" id="blkw-pass1" autocomplete="new-password"></label>` +
      `<div class="blkw-err" id="blkw-err"></div>` +
      `<button type="button" class="blkw-btn primary" data-act="restore">Restore wallet</button>`
    on('[data-act=restore]', () => void doRestore())
  }

  async function doRestore(): Promise<void> {
    const key = (byId('blkw-restore-key') as HTMLTextAreaElement).value
    const pass = (byId('blkw-pass1') as HTMLInputElement).value
    const err = byId('blkw-err')
    err.textContent = ''
    busy('Verifying keys…')
    try {
      await api.restore(key, pass)
      await viewMain()
    } catch (e) {
      viewWelcome()
      setTab('tab-restore')
      tabRestore()
      ;(byId('blkw-restore-key') as HTMLTextAreaElement).value = key
      byId('blkw-err').textContent = msg(e)
    }
  }

  function viewUnlock(): void {
    panel.innerHTML =
      header('Purse is sealed') +
      `<div class="blkw-body">` +
      `<label class="blkw-label">Passphrase<input type="password" id="blkw-pass1" autocomplete="current-password"></label>` +
      `<div class="blkw-err" id="blkw-err"></div>` +
      `<button type="button" class="blkw-btn primary" data-act="unlock">Unlock</button>` +
      `</div>`
    wireCommon()
    on('[data-act=unlock]', () => void doUnlock())
    const inp = byId('blkw-pass1') as HTMLInputElement
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void doUnlock()
    })
  }

  async function doUnlock(): Promise<void> {
    const pass = (byId('blkw-pass1') as HTMLInputElement).value
    const err = byId('blkw-err')
    err.textContent = ''
    busy('Unsealing…')
    const ok = await api.unlock(pass)
    if (ok) return void viewMain()
    viewUnlock()
    byId('blkw-err').textContent = 'Wrong passphrase.'
  }

  async function viewMain(): Promise<void> {
    busy('Consulting the ledger…')
    const info = await api.info()
    panel.innerHTML =
      header('Non-custodial · live on the BLOCK chain') +
      `<div class="blkw-body">` +
      `<div class="blkw-balrow"><div><div class="blkw-sub">Balance</div>` +
      `<div class="blkw-bal" id="blkw-bal">${fmtBlock(info.balance)} <small>BLOCK</small></div></div>` +
      `<button type="button" class="blkw-btn small" data-act="refresh">↻</button></div>` +
      `<div class="blkw-addr">Address ` +
      `<button type="button" class="blkw-btn small" data-act="copy-addr">copy</button><br>` +
      `<code title="${esc(info.address)}">${esc(shortAddr(info.address))}</code></div>` +
      `<div class="blkw-sep"></div>` +
      `<div class="blkw-sub" style="margin-bottom:4px">Send BLOCK</div>` +
      `<label class="blkw-label">To (block1…)<input id="blkw-to" placeholder="block1…" spellcheck="false" autocomplete="off"></label>` +
      `<label class="blkw-label">Amount<input id="blkw-amt" inputmode="decimal" placeholder="0.0" autocomplete="off"></label>` +
      `<div class="blkw-err" id="blkw-err"></div>` +
      `<div class="blkw-good" id="blkw-good"></div>` +
      `<button type="button" class="blkw-btn primary" data-act="send">Review &amp; send</button>` +
      `<div class="blkw-sep"></div>` +
      `<div class="blkw-sub" style="margin-bottom:4px">Other realms (same keys, same vault)</div>` +
      `<div id="blkw-chains"><p class="blkw-note">Consulting foreign ledgers…</p></div>` +
      `<div class="blkw-sep"></div>` +
      `<div class="blkw-sub" style="margin-bottom:4px">Back up your keys</div>` +
      `<div id="blkw-backup"><button type="button" class="blkw-btn" data-act="reveal-open">Show private keys (for backup)</button>` +
      `<p class="blkw-note">Your private keys live only on this device. Save them somewhere safe and offline.</p></div>` +
      `<div class="blkw-sep"></div>` +
      `<div class="blkw-banner">Your keys never leave this browser. Every transaction is signed on this device — nothing custodial, nothing phoned home.</div>` +
      `<button type="button" class="blkw-btn" data-act="lock">Lock purse</button>` +
      `<p class="blkw-note">Fee 0.0001 BLOCK · signed on this device · nothing custodial.</p>` +
      `</div>`
    wireCommon()
    on('[data-act=refresh]', () => void refreshBalance(true))
    on('[data-act=copy-addr]', () => void copyText(info.address, '[data-act=copy-addr]', 'copied'))
    on('[data-act=lock]', () => {
      lock()
      viewUnlock()
    })
    on('[data-act=send]', () => void confirmSend(info.address))
    on('[data-act=reveal-open]', () => void openReveal(info.address))
    void renderChains()
  }

  // --- key backup: press-and-hold reveal per chain ---------------------------

  async function openReveal(blockAddr: string): Promise<void> {
    const host = panel.querySelector('#blkw-backup') as HTMLElement | null
    if (!host) return
    host.innerHTML = `<p class="blkw-note">Decrypting your keys on this device…</p>`
    let keys: { blockle: string; ethereum: string; solana: string } | null
    try {
      keys = await api.revealKeys()
    } catch (e) {
      host.innerHTML = `<p class="blkw-note">Could not read keys: ${esc(msg(e))}</p>`
      return
    }
    if (!keys) {
      host.innerHTML = `<p class="blkw-note">Unlock your purse to reveal keys.</p>`
      return
    }
    // best-effort addresses for the two classical chains
    let snaps: Partial<Record<ChainId, { address: string; balance: number }>> = {}
    try {
      snaps = await api.chains()
    } catch {
      /* addresses are optional context */
    }
    const rows: { key: string; label: string; addr: string; fmt: string }[] = [
      { key: keys.blockle, label: 'BLOCK', addr: blockAddr, fmt: 'blockling-key-v1 backup (restores all three chains)' },
      { key: keys.ethereum, label: 'Ethereum', addr: snaps.ethereum?.address ?? '', fmt: '0x secp256k1 private key' },
      { key: keys.solana, label: 'Solana', addr: snaps.solana?.address ?? '', fmt: 'base58 ed25519 secret (Phantom import)' }
    ]
    host.innerHTML =
      `<div class="blkw-warn"><b>SELF-CUSTODY WARNING.</b> Your private key IS your money. Anyone who sees it can take your funds. ` +
      `Never share it or type it into any site. Back it up offline.</div>` +
      rows
        .map(
          (r, i) =>
            `<div class="blkw-keyrow">` +
            `<div class="blkw-keyhead"><b>${esc(r.label)}</b>` +
            (r.addr ? ` <code title="${esc(r.addr)}">${esc(shortAddr(r.addr))}</code>` : '') +
            `</div>` +
            `<div class="blkw-keybox" id="blkw-key-${i}" aria-live="polite">••••••••  —  hold the button to reveal</div>` +
            `<div class="blkw-keybtns">` +
            `<button type="button" class="blkw-btn small blkw-hold" data-reveal="${i}">Hold to reveal</button>` +
            `<button type="button" class="blkw-btn small" data-copy="${i}" style="display:none">Copy</button>` +
            `</div><div class="blkw-note">${esc(r.fmt)}</div></div>`
        )
        .join('') +
      `<button type="button" class="blkw-btn small" data-act="reveal-hide" style="margin-top:6px">Done</button>`

    const HOLD_MS = 400
    rows.forEach((r, i) => {
      const box = panel.querySelector(`#blkw-key-${i}`) as HTMLElement | null
      const btn = panel.querySelector(`[data-reveal="${i}"]`) as HTMLButtonElement | null
      const copy = panel.querySelector(`[data-copy="${i}"]`) as HTMLButtonElement | null
      if (!box || !btn) return
      let timer: number | null = null
      let shown = false
      const reveal = (): void => {
        box.textContent = r.key
        shown = true
        if (copy) copy.style.display = ''
        btn.classList.remove('on')
        btn.classList.add('shown')
        btn.textContent = 'Hide key'
      }
      const hide = (): void => {
        box.textContent = '••••••••  —  hold the button to reveal'
        shown = false
        if (copy) copy.style.display = 'none'
        btn.classList.remove('on', 'shown')
        btn.textContent = 'Hold to reveal'
      }
      // Press-and-HOLD to reveal; once the hold completes it STAYS shown after
      // you let go. Tap it again to hide.
      const start = (e: Event): void => {
        e.preventDefault()
        if (shown) { hide(); return } // tap while revealed → hide
        btn.classList.add('on')
        timer = window.setTimeout(() => {
          timer = null
          reveal()
        }, HOLD_MS)
      }
      // Releasing only cancels a hold that hasn't completed — it never re-hides
      // an already-revealed key.
      const cancelHold = (): void => {
        if (timer !== null) { clearTimeout(timer); timer = null }
        if (!shown) btn.classList.remove('on')
      }
      btn.addEventListener('pointerdown', start)
      btn.addEventListener('pointerup', cancelHold)
      btn.addEventListener('pointerleave', cancelHold)
      btn.addEventListener('pointercancel', cancelHold)
      btn.addEventListener('contextmenu', (e) => e.preventDefault())
      if (copy) copy.addEventListener('click', () => void copyText(r.key, `[data-copy="${i}"]`, 'Copied!'))
    })
    on('[data-act=reveal-hide]', () => viewMain())
  }

  // --- per-chain cards (Ethereum + Solana) -----------------------------------

  async function renderChains(): Promise<void> {
    const host = panel.querySelector('#blkw-chains') as HTMLElement | null
    if (!host) return
    let snaps: Partial<Record<ChainId, { address: string; balance: number }>>
    try {
      snaps = await api.chains()
    } catch (e) {
      host.innerHTML = `<p class="blkw-note">Chain lookup failed: ${esc(msg(e))}</p>`
      return
    }
    const live = panel.querySelector('#blkw-chains') as HTMLElement | null
    if (!live) return // view changed while we were fetching
    const cards = CHAIN_CARDS.map((c) => {
      const s = snaps[c.id]
      if (!s) {
        return (
          `<div class="blkw-chain"><div class="blkw-chainhead"><b>${esc(c.label)}</b></div>` +
          `<p class="blkw-note">Not set up yet — unlock once to forge this chain's keys from your vault.</p></div>`
        )
      }
      return (
        `<div class="blkw-chain" data-chain="${c.id}">` +
        `<div class="blkw-chainhead"><b>${esc(c.label)}</b>` +
        `<span class="blkw-chainbal">${fmtBlock(s.balance)} <small>${esc(c.unit)}</small></span></div>` +
        `<div class="blkw-addr"><code title="${esc(s.address)}">${esc(shortAddr(s.address))}</code> ` +
        `<button type="button" class="blkw-btn small" data-act="ch-copy" data-chain="${c.id}">copy</button></div>` +
        `<div class="blkw-row">` +
        `<button type="button" class="blkw-btn small" data-act="ch-send" data-chain="${c.id}">Send</button>` +
        `<button type="button" class="blkw-btn small" data-act="ch-buy" data-chain="${c.id}">Buy (MoonPay)</button>` +
        `<button type="button" class="blkw-btn small" data-act="ch-sell" data-chain="${c.id}">Sell</button>` +
        `</div>` +
        `<div class="blkw-chainform" id="blkw-chf-${c.id}" style="display:none"></div>` +
        `<div class="blkw-err" id="blkw-cherr-${c.id}"></div>` +
        `<div class="blkw-good" id="blkw-chgood-${c.id}"></div>` +
        `</div>`
      )
    })
    live.innerHTML = cards.join('')
    for (const c of CHAIN_CARDS) {
      const s = snaps[c.id]
      if (!s) continue
      const address = s.address
      onIn(live, `[data-act=ch-copy][data-chain=${c.id}]`, () =>
        void copyText(address, `[data-act=ch-copy][data-chain=${c.id}]`, 'copied')
      )
      onIn(live, `[data-act=ch-send][data-chain=${c.id}]`, () => toggleChainSend(c.id, c.hint, c.unit))
      onIn(live, `[data-act=ch-buy][data-chain=${c.id}]`, () => void openMoonpay('buy', c.id))
      onIn(live, `[data-act=ch-sell][data-chain=${c.id}]`, () => void openMoonpay('sell', c.id))
    }
  }

  function toggleChainSend(chain: ChainId, hint: string, unit: string): void {
    const form = panel.querySelector(`#blkw-chf-${chain}`) as HTMLElement | null
    if (!form) return
    if (form.style.display !== 'none') {
      form.style.display = 'none'
      return
    }
    form.style.display = 'block'
    form.innerHTML =
      `<label class="blkw-label">To (${esc(hint)})<input id="blkw-chto-${chain}" spellcheck="false" autocomplete="off"></label>` +
      `<label class="blkw-label">Amount (${esc(unit)})<input id="blkw-chamt-${chain}" inputmode="decimal" autocomplete="off"></label>` +
      `<button type="button" class="blkw-btn primary" data-act="ch-go-${chain}">Sign &amp; send</button>`
    onIn(form, `[data-act=ch-go-${chain}]`, () => void doChainSend(chain))
  }

  async function doChainSend(chain: ChainId): Promise<void> {
    const err0 = byId(`blkw-cherr-${chain}`)
    if (isIosApp()) {
      err0.textContent = 'Sending crypto isn’t available in the app — do it on the web (same account at blocklings.blockle.org).'
      openCryptoWeb()
      return
    }
    const to = (byId(`blkw-chto-${chain}`) as HTMLInputElement).value.trim()
    const amt = Number((byId(`blkw-chamt-${chain}`) as HTMLInputElement).value)
    const err = byId(`blkw-cherr-${chain}`)
    const good = byId(`blkw-chgood-${chain}`)
    err.textContent = ''
    good.textContent = ''
    if (!to) return void (err.textContent = 'Enter a recipient address.')
    if (!Number.isFinite(amt) || amt <= 0)
      return void (err.textContent = 'Enter an amount greater than zero.')
    const go = panel.querySelector(`[data-act=ch-go-${chain}]`) as HTMLButtonElement | null
    if (go) {
      go.disabled = true
      go.textContent = 'Signing…'
    }
    const res = await api.sendOn(chain, to, amt)
    if (res.ok) {
      good.innerHTML = `Sent! tx <code>${esc((res.tx ?? '').slice(0, 16))}…</code>`
      const form = panel.querySelector(`#blkw-chf-${chain}`) as HTMLElement | null
      if (form) form.style.display = 'none'
      void renderChains()
    } else {
      err.textContent = res.error ?? 'send failed'
      if (go) {
        go.disabled = false
        go.textContent = 'Sign & send'
      }
    }
  }

  async function openMoonpay(kind: 'buy' | 'sell', chain: ChainId): Promise<void> {
    const err = byId(`blkw-cherr-${chain}`)
    err.textContent = ''
    if (isIosApp()) {
      // Not offered in the app — same account on the web does buy/sell crypto.
      err.textContent = 'Buy/Sell crypto on the web: sign in to your same account at blocklings.blockle.org in a browser.'
      openCryptoWeb()
      return
    }
    const url = await api.moonpayUrl(kind, chain)
    if (!url) {
      err.textContent = `MoonPay ${kind} is not available for this chain right now.`
      return
    }
    // iOS (and the in-app WebView) can't show MoonPay in an IFRAME — MoonPay
    // refuses to embed there, so the overlay just white-screens. Open the widget
    // at the TOP LEVEL instead: the native browser via the app bridge, or a fresh
    // Safari tab on mobile web. Desktop keeps the nicer in-app iframe overlay.
    const bridge = (window as unknown as { blocklingsOpenURL?: (u: string) => void }).blocklingsOpenURL
    const ua = navigator.userAgent || ''
    const iOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document)
    if (bridge) {
      bridge(url) // in-app: hand off to the native browser (SafariViewController)
      return
    }
    if (iOS) {
      const w = window.open(url, '_blank', 'noopener')
      if (!w) window.location.href = url
      return
    }
    openMoonpayOverlay(url, kind)
  }

  function openMoonpayOverlay(url: string, kind: 'buy' | 'sell'): void {
    document.getElementById('blkw-mp-overlay')?.remove()
    const bridge = (window as unknown as { blocklingsOpenURL?: (u: string) => void }).blocklingsOpenURL
    const ov = document.createElement('div')
    ov.id = 'blkw-mp-overlay'
    ov.innerHTML =
      `<div class="blkw-mp-bar"><span>MoonPay — ${kind === 'buy' ? 'Buy crypto' : 'Sell crypto'}</span>` +
      (bridge ? `<button type="button" class="blkw-mp-safari">Open in Safari</button>` : '') +
      `<button type="button" class="blkw-mp-x" aria-label="Close">✕</button></div>` +
      `<iframe class="blkw-mp-frame" src="${url.replace(/"/g, '&quot;')}" ` +
      `allow="accelerometer; autoplay; camera; gyroscope; payment" ` +
      `allowfullscreen referrerpolicy="origin"></iframe>`
    ov.querySelector('.blkw-mp-x')?.addEventListener('click', () => ov.remove())
    ov.querySelector('.blkw-mp-safari')?.addEventListener('click', () => { bridge?.(url) })
    ;(document.getElementById('ui') ?? document.body).appendChild(ov)
  }


  async function confirmSend(_from: string): Promise<void> {
    const err = byId('blkw-err')
    err.textContent = ''
    if (isIosApp()) {
      err.textContent = 'Sending crypto isn’t available in the app — do it on the web (same account at blocklings.blockle.org).'
      openCryptoWeb()
      return
    }
    const to = (byId('blkw-to') as HTMLInputElement).value.trim()
    const amt = Number((byId('blkw-amt') as HTMLInputElement).value)
    byId('blkw-good').textContent = ''
    if (!/^block1/.test(to)) return void (err.textContent = 'Recipient must be a block1… address.')
    if (!Number.isFinite(amt) || amt <= 0)
      return void (err.textContent = 'Enter an amount greater than zero.')

    // second step: explicit confirmation
    const sendBtn = panel.querySelector('[data-act=send]') as HTMLButtonElement | null
    if (!sendBtn) return
    const confirmBox = el('div', 'blkw-confirm')
    confirmBox.innerHTML =
      `<div class="blkw-warn" style="margin-bottom:8px">Send <b>${fmtBlock(amt)} BLOCK</b> (+0.0001 fee)<br>to <code>${esc(shortAddr(to))}</code>?<br>This cannot be undone.</div>` +
      `<div class="blkw-row">` +
      `<button type="button" class="blkw-btn primary" data-act="send-go">Sign &amp; send</button>` +
      `<button type="button" class="blkw-btn" data-act="send-cancel">Cancel</button></div>`
    sendBtn.replaceWith(confirmBox)
    on('[data-act=send-cancel]', () => void viewMain())
    on('[data-act=send-go]', () => {
      void (async () => {
        const go = panel.querySelector('[data-act=send-go]') as HTMLButtonElement | null
        if (go) {
          go.disabled = true
          go.textContent = 'Signing…'
        }
        const res = await api.send(to, amt)
        if (res.ok) {
          await viewMain()
          byId('blkw-good').innerHTML = `Sent! tx <code>${esc((res.tx ?? '').slice(0, 16))}…</code>`
          void refreshBalance(true)
        } else {
          await viewMain()
          ;(byId('blkw-to') as HTMLInputElement).value = to
          ;(byId('blkw-amt') as HTMLInputElement).value = String(amt)
          byId('blkw-err').textContent = res.error ?? 'send failed'
        }
      })()
    })
  }

  async function refreshBalance(_force = false): Promise<void> {
    const elBal = document.getElementById('blkw-bal')
    if (!elBal) return
    const info = await api.info()
    elBal.innerHTML = `${fmtBlock(info.balance)} <small>BLOCK</small>`
  }

  // ---------------------------------------------------------------- helpers

  function wireCommon(): void {
    on('[data-act=close]', () => toggle.click())
  }

  function on(sel: string, fn: () => void): void {
    panel.querySelectorAll(sel).forEach((n) => n.addEventListener('click', fn))
  }

  function onIn(root: HTMLElement, sel: string, fn: () => void): void {
    root.querySelectorAll(sel).forEach((n) => n.addEventListener('click', fn))
  }

  function busy(text: string): void {
    panel.innerHTML = header('') + `<div class="blkw-body"><p class="blkw-note">${esc(text)}</p></div>`
    wireCommon()
  }

  function byId(id: string): HTMLElement {
    const n = panel.querySelector('#' + id)
    if (!n) throw new Error('wallet ui: missing #' + id)
    return n as HTMLElement
  }

  async function copyText(text: string, btnSel: string, okLabel: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      const b = panel.querySelector(btnSel) as HTMLButtonElement | null
      if (b) {
        const prev = b.textContent
        b.textContent = okLabel
        setTimeout(() => {
          b.textContent = prev
        }, 1200)
      }
    } catch {
      /* clipboard denied — the value is visible/selectable in the UI */
    }
  }

  /** Robust text download. The old one-liner failed widely: the <a> was never
   *  added to the DOM and the object URL was revoked on the SAME tick, so the
   *  download was cancelled (desktop/Android) and iOS WebViews can't save blobs
   *  at all. We append the anchor, delay the revoke, and — if the environment
   *  silently can't download (iOS in-app WebView) — fall back to the clipboard so
   *  the user never loses their backup. */
  async function downloadText(filename: string, text: string, btnSel: string): Promise<void> {
    // iOS in-app WebViews (WKWebView) don't trigger blob/anchor downloads at all,
    // and Safari handling is flaky — copy to clipboard there instead.
    const ua = navigator.userAgent || ''
    const iOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document)
    const standaloneOrWebView = iOS && !/Safari/.test(ua) // in-app WKWebView lacks the Safari token
    if (standaloneOrWebView) {
      // No blob downloads in an in-app WebView — copy instead so the key is never lost.
      await copyText(text, btnSel, 'Copied — paste & save!')
      return
    }
    try {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.rel = 'noopener'
      a.style.display = 'none'
      document.body.appendChild(a)
      a.click()
      setTimeout(() => {
        a.remove()
        URL.revokeObjectURL(url)
      }, 2000)
    } catch {
      await copyText(text, btnSel, 'Copied — save it!')
    }
  }

  return { update(_dt: number): void {} }
}

// ---------------------------------------------------------------- utilities

function el(tag: string, cls: string): HTMLElement {
  const n = document.createElement(tag)
  n.className = cls
  return n
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function shortAddr(a: string): string {
  return a.length > 24 ? a.slice(0, 14) + '…' + a.slice(-8) : a
}

function fmtBlock(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 8 })
}

function coinSvg(): string {
  return (
    '<svg class="blkw-coin" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="10" fill="#e8b73a" stroke="#8a6414" stroke-width="2"/>' +
    '<rect x="8" y="8" width="8" height="8" rx="1.5" fill="none" stroke="#8a6414" stroke-width="2"/></svg>'
  )
}

let stylesDone = false
function injectStyles(): void {
  if (stylesDone) return
  stylesDone = true
  const css = `
#${PANEL_ID}, .blkw-toggle { pointer-events: auto; font-family: Georgia, 'Times New Roman', serif; }
.blkw-toggle { position: absolute; top: max(60px, calc(env(safe-area-inset-top) + 48px)); right: 12px; display: flex; gap: 7px; align-items: center;
  z-index: 39; /* below the gear cluster (41) when closed */
  background: linear-gradient(#f3e2b3, #e2c683); color: #4a3313; border: 2px solid #8a6414; border-radius: 10px;
  padding: 7px 13px; font-size: 15px; font-weight: 700; cursor: pointer; box-shadow: 0 2px 6px rgba(0,0,0,.35); }
.blkw-toggle:hover { filter: brightness(1.05); }
#blkw-mp-overlay { position: absolute; inset: 0; z-index: 70; display: flex; flex-direction: column;
  background: rgba(8, 9, 14, 0.94); pointer-events: auto; }
.blkw-mp-bar { display: flex; align-items: center; gap: 10px; color: #e8c15a;
  font: 700 13px/1 'Trebuchet MS', system-ui, sans-serif; letter-spacing: .07em; text-transform: uppercase;
  padding: calc(env(safe-area-inset-top) + 10px) calc(env(safe-area-inset-right) + 12px) 10px 14px; }
.blkw-mp-bar span { flex: 1; }
.blkw-mp-safari { font: 600 12px/1 system-ui, sans-serif; text-transform: none; letter-spacing: 0;
  color: #37E0C8; background: rgba(55,224,200,.1); border: 1px solid rgba(55,224,200,.4);
  border-radius: 8px; padding: 9px 11px; cursor: pointer; touch-action: manipulation; }
.blkw-mp-x { width: 44px; height: 44px; font-size: 20px; color: #efe9d8; background: rgba(255,255,255,.06);
  border: 1px solid rgba(212,175,55,.4); border-radius: 10px; cursor: pointer; touch-action: manipulation; flex: none; }
.blkw-mp-frame { flex: 1; width: 100%; border: 0; background: #fff;
  margin-bottom: env(safe-area-inset-bottom); }
.blkw { position: absolute; top: max(60px, calc(env(safe-area-inset-top) + 48px)); right: 12px; width: min(330px, calc(100vw - 24px));
  z-index: 50; /* OPEN panel sits above the top-right gear/chip cluster (41) */
  max-height: calc(100vh - 80px); overflow-y: auto; background: linear-gradient(#f7ecd0, #efdcae);
  border: 2px solid #8a6414; border-radius: 12px; box-shadow: 0 6px 22px rgba(0,0,0,.45);
  color: #42300f; font-size: 14px; }
.blkw-head { display: flex; align-items: center; gap: 9px; padding: 11px 13px;
  border-bottom: 2px solid rgba(138,100,20,.4); }
.blkw-head > div { flex: 1; }
.blkw-title { font-weight: 800; font-size: 16px; letter-spacing: .3px; }
.blkw-sub { font-size: 11.5px; opacity: .75; }
.blkw-x { background: none; border: none; font-size: 15px; cursor: pointer; color: #6b4e17; padding: 4px; }
.blkw-body { padding: 13px; }
.blkw-tabs { display: flex; gap: 6px; padding: 10px 13px 0; }
.blkw-tab { flex: 1; padding: 7px; border: 2px solid #8a6414; border-bottom: none; cursor: pointer;
  border-radius: 8px 8px 0 0; background: #e2c683; color: #4a3313; font-weight: 700; font-family: inherit; opacity: .65; }
.blkw-tab.on { opacity: 1; background: #f7ecd0; }
.blkw-label { display: block; margin: 9px 0; font-size: 12.5px; font-weight: 700; }
.blkw input, .blkw textarea { width: 100%; box-sizing: border-box; margin-top: 4px; padding: 8px;
  border: 1.5px solid #8a6414; border-radius: 7px; background: #fffaf0; color: #30220a;
  font: 13px/1.4 ui-monospace, Menlo, monospace; }
.blkw-btn { padding: 9px 13px; border: 2px solid #8a6414; border-radius: 8px; cursor: pointer;
  background: linear-gradient(#f3e2b3, #e2c683); color: #4a3313; font-weight: 800; font-family: inherit;
  width: 100%; margin-top: 6px; font-size: 14px; }
.blkw-btn.primary { background: linear-gradient(#7aa348, #567a2e); color: #fdf7e3; border-color: #3c5520; }
.blkw-btn.small { width: auto; padding: 3px 9px; margin: 0; font-size: 12px; }
.blkw-btn:disabled { opacity: .6; cursor: default; }
.blkw-btn:not(:disabled):hover { filter: brightness(1.06); }
.blkw-note { font-size: 12px; opacity: .8; margin: 8px 0; }
.blkw-warn { background: #f8d7c0; border: 1.5px solid #b4541e; border-radius: 8px; padding: 9px;
  font-size: 12.5px; line-height: 1.45; margin: 8px 0; }
.blkw-keyrow { border: 1px solid #d8c29a; border-radius: 8px; padding: 8px; margin: 8px 0; background: rgba(255,255,255,.35); }
.blkw-keyhead { font-size: 12.5px; margin-bottom: 5px; }
.blkw-keyhead code { font-size: 11px; opacity: .8; }
.blkw-keybox { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 1.4;
  word-break: break-all; user-select: all; background: #2a2016; color: #f0e6d2; border-radius: 6px; padding: 7px 8px;
  min-height: 34px; }
.blkw-keybtns { display: flex; gap: 6px; margin-top: 6px; }
.blkw-hold { touch-action: none; -webkit-user-select: none; user-select: none; }
.blkw-hold.on { background: #b4541e; color: #fff; }
.blkw-err { color: #9c2b12; font-size: 12.5px; min-height: 16px; margin-top: 6px; font-weight: 700; }
.blkw-good { color: #2f6b1d; font-size: 12.5px; margin-top: 4px; font-weight: 700; }
.blkw-addr { font-size: 12px; margin: 9px 0; }
.blkw-addr code { font-size: 12px; word-break: break-all; }
.blkw-backup { margin: 8px 0; }
.blkw-balrow { display: flex; align-items: center; justify-content: space-between; }
.blkw-bal { font-size: 23px; font-weight: 800; }
.blkw-bal small { font-size: 12px; font-weight: 700; opacity: .7; }
.blkw-sep { border-top: 1.5px dashed rgba(138,100,20,.5); margin: 12px 0; }
.blkw-check { display: flex; gap: 8px; align-items: flex-start; font-size: 12.5px; margin: 9px 0; font-weight: 700; }
.blkw-check input { width: auto; margin-top: 2px; }
.blkw-row { display: flex; gap: 8px; }
.blkw-row .blkw-btn { margin-top: 6px; }
.blkw-chain { border: 1.5px solid rgba(138,100,20,.45); border-radius: 9px; padding: 8px 9px; margin: 8px 0;
  background: rgba(255,250,240,.45); }
.blkw-chainhead { display: flex; align-items: center; justify-content: space-between; }
.blkw-chainbal { font-weight: 800; }
.blkw-chainbal small { font-size: 11px; opacity: .7; }
.blkw-chainform { margin-top: 6px; }
.blkw-banner { background: #e7efd8; border: 1.5px solid #567a2e; border-radius: 8px; padding: 8px 9px;
  font-size: 12px; line-height: 1.45; margin: 8px 0; font-weight: 700; color: #35511c; }
@media (max-width: 480px) { .blkw { top: 54px; } .blkw-toggle span { display: none; } }
`
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
}
