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
 */
import type { GameAPI } from '../types'

const MAX_LINES = 150

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
    '<span class="bl-chat-title">Chat</span><span class="bl-chat-chev" aria-hidden="true">&#9662;</span>'
  head.addEventListener('click', () => {
    root.classList.toggle('bl-collapsed')
    onUiTick()
  })

  // -- log ------------------------------------------------------------------
  const log = document.createElement('div')
  log.className = 'bl-chat-log'

  function appendLine(from: string, msg: string): void {
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 28
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

  function send(): void {
    const msg = input.value.trim()
    if (!msg) return
    api.chatSend(msg)
    input.value = ''
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
    input.focus()
    e.preventDefault()
  })

  root.appendChild(head)
  root.appendChild(log)
  root.appendChild(inputRow)

  appendLine('*', 'Welcome to Blocklings. Press Enter to chat.')
  return root
}
