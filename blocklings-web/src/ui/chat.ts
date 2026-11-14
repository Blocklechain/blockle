/**
 * Blocklings — chat box (bottom of the HUD).
 *
 * Collapsible message log + input. Outgoing messages go through
 * `api.chatSend`; incoming messages arrive via `api.onChat`, which this
 * module registers (the chat backend echoes the local player's own
 * messages back, so nothing is appended locally on send).
 *
 * Keyboard contract:
 *   - Enter (while the game has focus) focuses the chat input.
 *   - Enter (in the input) sends, then blurs so movement resumes.
 *   - Escape blurs the input.
 *   - While the input is focused, key events are stopped from bubbling so
 *     WASD never moves the character mid-sentence; while blurred, the
 *     chat touches no keys at all.
 *
 * Slash commands (handled locally, never sent to the relay):
 *   - /who   lists online players (from the net module's duck-typed
 *     window.blocklingsWho hook; honest when offline).
 *   - /zone  prints the current zone's name + mob level band.
 */
import type { GameAPI } from '../types'
import { regionAt } from '../ids'

const MAX_LINES = 150

/** Duck-typed window hooks other modules may publish (never required). */
interface ChatGlobals {
  /** Net module: online players (shape tolerant — names or name+level). */
  blocklingsWho?: () =>
    | readonly (string | { name: string; level?: number })[]
    | undefined
  /**
   * World module: zone lookup covering the outer-ring zones the frozen
   * ids.ts REGIONS table doesn't know about.
   */
  blocklingsZoneAt?: (
    x: number,
    z: number
  ) => { name: string; minLevel?: number; maxLevel?: number } | null
}

function isTypingTarget(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    (t instanceof HTMLElement && t.isContentEditable)
  )
}

export function createChat(api: GameAPI, onUiTick: () => void): HTMLElement {
  const root = document.createElement('div')
  root.className = 'bl-chat'

  // -- header ---------------------------------------------------------------
  const head = document.createElement('button')
  head.type = 'button'
  head.className = 'bl-chat-head'
  head.setAttribute('aria-label', 'Toggle chat log')
  head.innerHTML =
    '<svg class="bl-chat-glyph" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">' +
    '<path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg>' +
    '<span class="bl-chat-title">Chat</span>' +
    '<span class="bl-chat-unread" aria-hidden="true"></span>' +
    '<span class="bl-chat-chev" aria-hidden="true">&#9662;</span>'
  const unreadEl = head.querySelector('.bl-chat-unread') as HTMLElement
  let unread = 0
  const refreshUnread = (): void => {
    unreadEl.textContent = unread > 9 ? '9+' : String(unread)
    unreadEl.style.display = unread > 0 ? '' : 'none'
  }
  refreshUnread()
  head.addEventListener('click', () => {
    root.classList.toggle('bl-collapsed')
    if (!root.classList.contains('bl-collapsed')) {
      unread = 0
      refreshUnread()
    }
    onUiTick()
  })

  // Touch devices: start collapsed — screen space is scarce and the log must
  // never shadow the movement joystick below it.
  if (window.matchMedia('(pointer: coarse)').matches) {
    root.classList.add('bl-collapsed')
  }

  // -- log ------------------------------------------------------------------
  const log = document.createElement('div')
  log.className = 'bl-chat-log'

  function appendLine(from: string, msg: string): void {
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 28
    if (root.classList.contains('bl-collapsed') && from !== '*') {
      unread++
      refreshUnread()
    }
    const line = document.createElement('div')
    line.className = 'bl-chat-line'
    const who = document.createElement('span')
    who.className = 'bl-chat-from'
    who.textContent = from
    line.appendChild(who)
    line.appendChild(document.createTextNode(' ' + msg))
    log.appendChild(line)
    while (log.childElementCount > MAX_LINES) log.firstElementChild?.remove()
    if (nearBottom) log.scrollTop = log.scrollHeight
  }

  api.onChat = (from, msg) => appendLine(from, msg)

  // -- input row ------------------------------------------------------------
  const inputRow = document.createElement('form')
  inputRow.className = 'bl-chat-inputrow'

  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'bl-chat-input'
  input.placeholder = 'Press Enter to chat…'
  input.maxLength = 240
  input.autocomplete = 'off'
  input.autocapitalize = 'sentences'
  input.spellcheck = false
  input.enterKeyHint = 'send'

  const sendBtn = document.createElement('button')
  sendBtn.type = 'submit'
  sendBtn.className = 'bl-chat-send'
  sendBtn.textContent = 'Send'

  inputRow.appendChild(input)
  inputRow.appendChild(sendBtn)

  // -- local slash commands ---------------------------------------------------

  function cmdWho(): void {
    const hook = (window as unknown as ChatGlobals).blocklingsWho
    const raw = hook?.()
    const others = (raw ?? [])
      .map((e) => (typeof e === 'string' ? { name: e } : e))
      .filter((e) => e.name && e.name !== api.player.name)
    if (!hook || raw === undefined) {
      appendLine('*', 'No realm connection. As far as anyone can prove, you are the server.')
      return
    }
    if (others.length === 0) {
      appendLine('*', 'Online (1): just you. The economy trembles.')
      return
    }
    const names = others
      .map((e) => (e.level !== undefined ? `${e.name} (Lv ${e.level})` : e.name))
      .join(', ')
    appendLine('*', `Online (${others.length + 1}): you, ${names}`)
  }

  function cmdZone(): void {
    const { x, z } = api.player.pos
    const g = window as unknown as ChatGlobals
    const zone = regionAt(x, z) ?? g.blocklingsZoneAt?.(x, z) ?? null
    if (!zone) {
      appendLine('*', 'Uncharted wilderness. The cartographers gave up here, and so should you.')
      return
    }
    const lo = 'minLevel' in zone ? zone.minLevel : undefined
    const hi = 'maxLevel' in zone ? zone.maxLevel : undefined
    let line = zone.name
    if (lo !== undefined && hi !== undefined) {
      line += ` — levels ${lo}–${hi}.`
      const lvl = api.player.level
      if (lvl < lo) line += ` You are level ${lvl}. Brave. Foolish, but brave.`
      else if (lvl > hi) line += ` You are level ${lvl}. The mobs here have families, you monster.`
      else line += ` You are level ${lvl}. A fair fight, allegedly.`
    } else {
      line += ' — level band unknown. Assume the worst.'
    }
    appendLine('*', line)
  }

  /** True if the message was a local command (and was handled here). */
  function handleCommand(msg: string): boolean {
    if (!msg.startsWith('/')) return false
    const cmd = msg.split(/\s+/, 1)[0]?.toLowerCase()
    if (cmd === '/who') cmdWho()
    else if (cmd === '/zone') cmdZone()
    else appendLine('*', `Unknown command ${cmd}. Known spells: /who, /zone`)
    return true
  }

  function send(): void {
    const msg = input.value.trim()
    if (!msg) return
    input.value = ''
    if (!handleCommand(msg)) api.chatSend(msg)
    onUiTick()
  }

  inputRow.addEventListener('submit', (e) => {
    e.preventDefault()
    send()
    // On desktop, hand focus back to the game; on touch the keyboard
    // closing does this naturally.
    input.blur()
  })

  // While typing, swallow key events (down AND up, so movement code never
  // sees a down without its matching up) before they bubble to the window.
  for (const type of ['keydown', 'keyup'] as const) {
    input.addEventListener(type, (e) => {
      if (e.key === 'Escape') {
        input.blur()
        e.preventDefault()
      }
      e.stopPropagation()
    })
  }

  // Global Enter-to-chat, classic-MMO style. Never steals from other inputs.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.repeat) return
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return
    root.classList.remove('bl-collapsed')
    unread = 0
    refreshUnread()
    input.focus()
    e.preventDefault()
  })

  root.appendChild(head)
  root.appendChild(log)
  root.appendChild(inputRow)

  appendLine('*', 'Welcome to Blocklings. Press Enter to chat.')
  return root
}
