/**
 * Blocklings — combat stance panel (WEAPON-DRIVEN).
 *
 * Your fighting style follows the weapon in your hand, not a manual pick:
 *
 *   • Sword / axe / barehanded → MELEE. The panel shows an Offense / Defense
 *     stance toggle. Offense trains ATTACK and hits a little harder; Defense
 *     trains DEFENSE, raises your shield, and softens incoming blows.
 *   • Bow  → RANGED. Fires arrows at your target. Kills train ARCHERY.
 *   • Staff → MAGIC. Hurls bolts at your target. Kills train MAGIC.
 *
 * The derived style is read by combat via setStyleSource; the melee sub-stance
 * via setStanceSource. Equip changes arrive on the 'item:equipped' bus. The
 * melee sub-stance persists via the save registry ('stance'); style itself is
 * never persisted (it's a pure function of the equipped weapon).
 */
import type { GameAPI } from '../types'
import { events } from '../events'
import { saveRegistry } from '../save/registry'
import './stance.css'

export type CombatStyle = 'melee' | 'archery' | 'magic'
export type MeleeStance = 'offense' | 'defense'

export interface CombatStyleModule {
  current(): CombatStyle
  stance(): MeleeStance
  dispose(): void
}

/** Resolves a weapon item id to its grip ('bow' | 'upright' | 'forward' | 'shield' | null). */
type GripResolver = (id: string) => 'bow' | 'upright' | 'forward' | 'shield' | undefined

let style: CombatStyle = 'melee'
let meleeStance: MeleeStance = 'offense'
let resolveGrip: GripResolver | null = null

/** Live source of the currently-equipped weapon id (set by the integrator). */
let weaponSource: (() => string | null) | null = null

/**
 * Active combat style — ALWAYS derived live from the equipped weapon (never a
 * stale cache), so reopening the UI or reloading keeps a bow on Ranged / a
 * staff on Magic. Falls back to the last event-derived style pre-wiring.
 */
export function currentStyle(): CombatStyle {
  return weaponSource ? styleForWeapon(weaponSource()) : style
}

/** Active melee sub-stance (meaningful only while style === 'melee'). */
export function currentStance(): MeleeStance {
  return meleeStance
}

function styleForWeapon(id: string | null): CombatStyle {
  if (!id) return 'melee' // barehanded
  const grip = resolveGrip?.(id)
  if (grip === 'bow') return 'archery'
  if (grip === 'upright') return 'magic'
  if (grip === 'forward' || grip === 'shield') return 'melee'
  // Fallback to the id family when no def/grip is available.
  const cut = id.indexOf('_')
  const fam = cut >= 0 ? id.slice(0, cut) : id
  if (fam === 'bow') return 'archery'
  if (fam === 'staff') return 'magic'
  return 'melee'
}

const SWORD =
  '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M14.5 4.5 20 4l-.5 5.5-9 9-2.5-2.5zM5 19l3-3M6.5 20.5 3.5 17.5"/></svg>'
const SHIELD =
  '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 3 5 6v5c0 4 3 7 7 10 4-3 7-6 7-10V6z"/></svg>'
const BOW =
  '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M5 3a13 13 0 0 1 0 18M5 3l2 9-2 9M4 12h16M15 8l5 4-5 4"/></svg>'
const STAFF =
  '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M7 20 17 6M17 6l1.5-2 2 1.5L20 7zM4.5 16l1.5-.4.4-1.5.4 1.5 1.5.4-1.5.4-.4 1.5-.4-1.5z"/></svg>'

let inited = false

/**
 * @param weaponGrip optional resolver from a weapon item id to its gripStyle
 *   (the integrator passes itemsApi.def(id)?.gripStyle). Lets a bow read as
 *   ranged / a staff as magic even for named legendaries.
 */
export function initCombatStyle(
  api: GameAPI,
  weaponGrip?: GripResolver,
  getEquippedWeapon?: () => string | null
): CombatStyleModule {
  void api
  if (inited) return { current: currentStyle, stance: currentStance, dispose() {} }
  inited = true
  if (weaponGrip) resolveGrip = weaponGrip
  if (getEquippedWeapon) weaponSource = getEquippedWeapon
  // Seed from whatever is already equipped (restored save) so the panel opens
  // on the right style immediately, not a melee default.
  style = currentStyle()

  saveRegistry.register('stance', {
    dump: () => meleeStance,
    load: (d) => {
      meleeStance = d === 'defense' ? 'defense' : 'offense'
      render()
      emitStance()
    }
  })

  const root = document.createElement('div')
  root.className = 'bl-stance'
  ;(document.getElementById('ui') ?? document.body).appendChild(root)

  // Re-derive style whenever the weapon slot changes.
  events.on('item:equipped', ({ slot, id }) => {
    if (slot !== 'weapon') return
    const next = styleForWeapon(id)
    if (next !== style) {
      style = next
      events.emit('style:changed', { style })
      events.emit('chat:system', { text: styleLine() })
    }
    render()
    emitStance() // guard pose depends on (style, stance)
  })

  function styleLine(): string {
    return style === 'archery'
      ? 'Bow drawn — Ranged. Arrows fly at your target. Kills train Archery.'
      : style === 'magic'
        ? 'Staff raised — Magic. Bolts fly at your target. Kills train Magic.'
        : 'Blade in hand — Melee. Pick a stance: Offense or Defense.'
  }

  function emitStance(): void {
    events.emit('stance:changed', { stance: meleeStance })
  }

  function setStance(s: MeleeStance): void {
    if (s === meleeStance) return
    meleeStance = s
    render()
    emitStance()
    events.emit('save:dirty', { why: 'stance' })
    events.emit('chat:system', {
      text:
        s === 'defense'
          ? 'Defense stance — shield up, blows softened. Kills train Defense.'
          : 'Offense stance — press the attack. Kills train Attack.'
    })
  }

  function chip(cls: string, svg: string, label: string, on: boolean): HTMLButtonElement {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'bl-stance-btn' + (on ? ' on' : '')
    b.dataset.s = cls
    b.innerHTML = svg + '<span>' + label + '</span>'
    b.addEventListener('pointerdown', (e) => e.stopPropagation())
    return b
  }

  function render(): void {
    // Always render from the LIVE weapon-derived style, never a stale cache —
    // reopening the panel or reloading keeps a bow on Ranged.
    const s = currentStyle()
    style = s
    root.innerHTML = ''
    if (s === 'melee') {
      const off = chip('offense', SWORD, 'Offense', meleeStance === 'offense')
      off.addEventListener('click', () => setStance('offense'))
      const def = chip('defense', SHIELD, 'Defense', meleeStance === 'defense')
      def.addEventListener('click', () => setStance('defense'))
      root.appendChild(off)
      root.appendChild(def)
    } else if (s === 'archery') {
      root.appendChild(chip('archery', BOW, 'Ranged', true))
    } else {
      root.appendChild(chip('magic', STAFF, 'Magic', true))
    }
  }

  // Keep the panel honest even if equipment is restored without an equip event
  // (save load sets the slot directly): re-derive on the save-loaded signal.
  events.on('chat:system', () => {
    const s = currentStyle()
    if (s !== style) render()
  })

  render()

  return {
    current: currentStyle,
    stance: currentStance,
    dispose() {
      root.remove()
    }
  }
}
