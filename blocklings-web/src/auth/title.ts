/**
 * Title screen — the cozy voxel front door shown at boot (and after sign-out).
 *
 * Pure DOM/presentation: forms, tabs, errors, busy state, fade-out. All
 * decisions (API calls, token storage, events) live in src/auth.ts, which
 * drives this via the returned TitleScreen handle and receives user intent
 * through TitleCallbacks. No imports from other feature modules.
 */
import './title.css'

export interface TitleCallbacks {
  /** Sign In submitted. totp present only when the 2FA field was shown + filled. */
  signIn(email: string, password: string, totp?: string): void
  /** Create Account submitted. */
  register(name: string, email: string, password: string): void
  /** "Play Offline (Guest)" tapped. */
  guest(): void
  /** "Enter World" tapped on the welcome-back panel. */
  enterWorld(): void
  /** "Not you? Sign out" tapped on the welcome-back panel. */
  switchAccount(): void
}

export interface TitleScreen {
  /** Show the overlay (restores from a previous hide()). Resets busy state. */
  show(): void
  /** Fade the overlay out and release pointer events. */
  hide(): void
  /** Show the sign-in/register card (the default view). */
  showForms(): void
  /** Show the welcome-back panel for a restored session. */
  showWelcome(name: string, note?: string): void
  /** Reveal the 2FA code field on the sign-in form. */
  showTotp(): void
  /** Red error line (current view). Empty string clears. */
  showError(msg: string): void
  /** Green notice line (verify-email prompts etc). Empty string clears. */
  showNotice(msg: string): void
  /** Disable/enable all controls while a request is in flight. */
  setBusy(busy: boolean): void
  /** Pre-fill the sign-in email (after register). */
  prefillEmail(email: string): void
  /** Switch the card tab. */
  switchTab(tab: 'signin' | 'register'): void
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

function input(type: string, placeholder: string, autocomplete: string): HTMLInputElement {
  const i = el('input', 'bl-title-input')
  i.type = type
  i.placeholder = placeholder
  i.setAttribute('autocomplete', autocomplete)
  i.autocapitalize = 'none'
  i.spellcheck = false
  return i
}

export function createTitleScreen(mount: HTMLElement, cb: TitleCallbacks): TitleScreen {
  const root = el('div', 'bl-title')

  // drifting voxel blocks (flat-color, pure CSS)
  for (let i = 0; i < 4; i++) root.appendChild(el('div', 'bl-title-cube'))

  // --- wordmark ------------------------------------------------------------
  const logo = el('h1', 'bl-title-logo', 'BLOCKLINGS')
  const sod = el('div', 'bl-title-sod')
  const tag = el('p', 'bl-title-tag', 'Tiny heads. Big heads, actually. Huge.')
  root.appendChild(logo)
  root.appendChild(sod)
  root.appendChild(tag)

  // --- card ----------------------------------------------------------------
  const card = el('div', 'bl-title-card')

  const tabs = el('div', 'bl-title-tabs')
  const tabIn = el('button', 'bl-title-tab bl-title-tab--on', 'Sign In')
  const tabUp = el('button', 'bl-title-tab', 'Create Account')
  tabIn.type = 'button'
  tabUp.type = 'button'
  tabs.appendChild(tabIn)
  tabs.appendChild(tabUp)
  card.appendChild(tabs)

  const error = el('div', 'bl-title-error')
  const notice = el('div', 'bl-title-notice')

  // sign-in form
  const formIn = el('form', 'bl-title-form') as HTMLFormElement
  const inEmail = input('email', 'Email', 'email')
  inEmail.inputMode = 'email'
  const inPass = input('password', 'Password', 'current-password')
  const totpWrap = el('div', 'bl-title-totp')
  const totpLabel = el('div', 'bl-title-label', '2FA code')
  const inTotp = input('text', '6-digit authenticator code', 'one-time-code')
  inTotp.inputMode = 'numeric'
  inTotp.maxLength = 8
  totpWrap.appendChild(totpLabel)
  totpWrap.appendChild(inTotp)
  const btnIn = el('button', 'bl-title-primary', 'Sign In')
  btnIn.type = 'submit'
  formIn.appendChild(inEmail)
  formIn.appendChild(inPass)
  formIn.appendChild(totpWrap)
  formIn.appendChild(btnIn)

  // register form
  const formUp = el('form', 'bl-title-form') as HTMLFormElement
  formUp.style.display = 'none'
  const upName = input('text', 'Hero name (shown in-world)', 'username')
  upName.maxLength = 24
  const upEmail = input('email', 'Email', 'email')
  upEmail.inputMode = 'email'
  const upPass = input('password', 'Password', 'new-password')
  const upPass2 = input('password', 'Password again (trust no one)', 'new-password')
  const btnUp = el('button', 'bl-title-primary', 'Create Account')
  btnUp.type = 'submit'
  formUp.appendChild(upName)
  formUp.appendChild(upEmail)
  formUp.appendChild(upPass)
  formUp.appendChild(upPass2)
  formUp.appendChild(btnUp)

  // welcome-back panel (restored session)
  const welcome = el('div', 'bl-title-welcome')
  const wbHi = el('div', 'bl-title-wb-hi', 'Welcome back,')
  const wbName = el('div', 'bl-title-wb-name')
  const wbNote = el('div', 'bl-title-wb-note')
  const btnEnter = el('button', 'bl-title-primary', 'Enter World')
  btnEnter.type = 'button'
  const btnSwitch = el('button', 'bl-title-link', 'Not you? Sign out')
  btnSwitch.type = 'button'
  welcome.appendChild(wbHi)
  welcome.appendChild(wbName)
  welcome.appendChild(wbNote)
  welcome.appendChild(btnEnter)
  welcome.appendChild(btnSwitch)

  const spinner = el('div', 'bl-title-spinner')

  card.appendChild(error)
  card.appendChild(notice)
  card.appendChild(formIn)
  card.appendChild(formUp)
  card.appendChild(welcome)
  card.appendChild(spinner)
  root.appendChild(card)

  // --- offline guest -------------------------------------------------------
  const guestBox = el('div', 'bl-title-guestbox')
  const btnGuest = el('button', 'bl-title-guest', 'Play Offline (Guest)')
  btnGuest.type = 'button'
  guestBox.appendChild(btnGuest)
  guestBox.appendChild(
    el('p', 'bl-title-guest-cap', 'Local-only save — your progress stays on this device.')
  )
  root.appendChild(guestBox)

  root.appendChild(
    el('div', 'bl-title-foot', 'A Blockle account carries your hero across devices.')
  )

  mount.appendChild(root)

  // --- behavior ------------------------------------------------------------
  let busy = false
  let totpShown = false

  function clearLines(): void {
    error.classList.remove('bl-title-error--on')
    notice.classList.remove('bl-title-notice--on')
  }

  function switchTab(tab: 'signin' | 'register'): void {
    clearLines()
    const signin = tab === 'signin'
    tabIn.classList.toggle('bl-title-tab--on', signin)
    tabUp.classList.toggle('bl-title-tab--on', !signin)
    formIn.style.display = signin ? '' : 'none'
    formUp.style.display = signin ? 'none' : ''
    welcome.classList.remove('bl-title-welcome--on')
    tabs.style.display = ''
  }

  tabIn.addEventListener('click', () => {
    if (!busy) switchTab('signin')
  })
  tabUp.addEventListener('click', () => {
    if (!busy) switchTab('register')
  })

  formIn.addEventListener('submit', (e) => {
    e.preventDefault()
    if (busy) return
    clearLines()
    const email = inEmail.value.trim()
    const pass = inPass.value
    if (!email || !pass) {
      api.showError('Email and password, please. The bouncer is strict.')
      return
    }
    const code = totpShown ? inTotp.value.trim() : ''
    if (code) cb.signIn(email, pass, code)
    else cb.signIn(email, pass)
  })

  formUp.addEventListener('submit', (e) => {
    e.preventDefault()
    if (busy) return
    clearLines()
    const name = upName.value.trim()
    const email = upEmail.value.trim()
    const pass = upPass.value
    if (!name || !email || !pass) {
      api.showError('Name, email and password — all three, hero.')
      return
    }
    if (pass !== upPass2.value) {
      api.showError("Passwords don't match. One of them is lying.")
      return
    }
    if (pass.length < 8) {
      api.showError('Password needs 8+ characters. Dragons can count.')
      return
    }
    cb.register(name, email, pass)
  })

  btnGuest.addEventListener('click', () => {
    if (!busy) cb.guest()
  })
  btnEnter.addEventListener('click', () => {
    if (!busy) cb.enterWorld()
  })
  btnSwitch.addEventListener('click', () => {
    if (!busy) cb.switchAccount()
  })

  const api: TitleScreen = {
    show() {
      api.setBusy(false)
      root.classList.remove('bl-title--hidden')
    },
    hide() {
      root.classList.add('bl-title--hidden')
    },
    showForms() {
      welcome.classList.remove('bl-title-welcome--on')
      switchTab('signin')
    },
    showWelcome(name: string, note?: string) {
      clearLines()
      tabs.style.display = 'none'
      formIn.style.display = 'none'
      formUp.style.display = 'none'
      wbName.textContent = name
      wbNote.textContent = note ?? ''
      wbNote.style.display = note ? '' : 'none'
      welcome.classList.add('bl-title-welcome--on')
    },
    showTotp() {
      totpShown = true
      totpWrap.classList.add('bl-title-totp--on')
      inTotp.focus()
    },
    showError(msg: string) {
      notice.classList.remove('bl-title-notice--on')
      error.textContent = msg
      error.classList.toggle('bl-title-error--on', !!msg)
    },
    showNotice(msg: string) {
      error.classList.remove('bl-title-error--on')
      notice.textContent = msg
      notice.classList.toggle('bl-title-notice--on', !!msg)
    },
    setBusy(b: boolean) {
      busy = b
      root.classList.toggle('bl-title--busy', b)
      for (const c of [tabIn, tabUp, btnIn, btnUp, btnGuest, btnEnter, btnSwitch]) {
        c.disabled = b
      }
    },
    prefillEmail(email: string) {
      inEmail.value = email
    },
    switchTab
  }

  return api
}
