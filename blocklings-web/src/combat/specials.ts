/**
 * Weapon specials — ability data + the mobile SPECIAL button.
 *
 * The catalog (src/items/catalog.ts) is the display truth for ItemSpecial
 * defs; the integrator wires combat.setDefSource(items.def) to read it.
 * Until that wire exists, FALLBACK_SPECIALS mirrors the same id convention
 * (`kind_material`, steel+ only) so specials work standalone.
 */
import type { ItemSpecial } from '../types'
import { MATERIALS } from '../ids'

// ---------------------------------------------------------------------------
// Ability lookup by item id (fallback mirror of the catalog data)
// ---------------------------------------------------------------------------

/** kind -> [steel/gold ability, crystal/mythic ability]. */
const KIND_ABILITIES: Record<string, readonly [ItemSpecial, ItemSpecial]> = {
  sword: [
    { id: 'lunge', name: 'Lunge', desc: 'Dash forward, piercing everything in the line.', cooldownS: 9 },
    { id: 'lunge_nova', name: 'Nova Lunge', desc: 'Dash-pierce that detonates a nova where you stop.', cooldownS: 12 },
  ],
  axe: [
    { id: 'whirlwind', name: 'Whirlwind', desc: 'Spin a full circle, hitting everything around you.', cooldownS: 10 },
    { id: 'whirlwind_nova', name: 'Cyclone Nova', desc: 'A 360 spin that ends in a shockwave.', cooldownS: 13 },
  ],
  staff: [
    { id: 'fireball', name: 'Fireball', desc: 'Lob an exploding fireball.', cooldownS: 8 },
    { id: 'fireball_nova', name: 'Meteor Orb', desc: 'An orb that detonates into a mana nova.', cooldownS: 11 },
  ],
  bow: [
    { id: 'volley', name: 'Volley', desc: 'Fan five arrows at once.', cooldownS: 9 },
    { id: 'volley_storm', name: 'Arrow Storm', desc: 'Nine arrows in a glittering fan.', cooldownS: 12 },
  ],
  shield: [
    { id: 'bash', name: 'Shield Bash', desc: 'Cone knockback + 1.5s stun.', cooldownS: 10 },
    { id: 'bash_shockwave', name: 'Bulwark Shockwave', desc: 'Everything around you is knocked flat and stunned.', cooldownS: 14 },
  ],
}

/** Material tier of an id like 'sword_steel' (0..5, -1 if not a ladder id). */
export function tierOfId(id: string): number {
  const tail = id.slice(id.lastIndexOf('_') + 1)
  return (MATERIALS as readonly string[]).indexOf(tail)
}

/** Fallback ItemSpecial for a catalog id (steel+ weapons/shields only). */
export function fallbackSpecial(id: string): ItemSpecial | undefined {
  const t = tierOfId(id)
  if (t < 2) return undefined
  const kind = id.slice(0, id.indexOf('_'))
  const pair = KIND_ABILITIES[kind]
  if (!pair) return undefined
  return t >= 4 ? pair[1] : pair[0]
}

/** Which player animation each ability family plays. */
export function animOf(abilityId: string): 'spin' | 'lunge' | 'cast' | 'volley' | 'bash' {
  if (abilityId.startsWith('whirlwind')) return 'spin'
  if (abilityId.startsWith('fireball')) return 'cast'
  if (abilityId.startsWith('volley')) return 'volley'
  if (abilityId.startsWith('bash')) return 'bash'
  return 'lunge'
}

/** FX color per material tier (echoes the item palette family). */
export function tierFxColor(tier: number): number {
  if (tier >= 5) return 0x9b59d0 // mythic violet
  if (tier >= 4) return 0x6fe3e8 // crystal cyan
  if (tier === 3) return 0xf2c14e // gold
  return 0xd3dae2 // steel white
}

// ---------------------------------------------------------------------------
// Mobile SPECIAL button (twin of the player's ATK button, + cooldown ring)
// ---------------------------------------------------------------------------

export interface SpecialButton {
  /** Show/hide + repaint the cooldown ring (cd 0 = ready, 1 = just used). */
  set(visible: boolean, cdFrac: number): void
  dispose(): void
}

const SIZE = 66 // px (a notch smaller than the 84px ATK button below it)

/**
 * Round SPC button above the ATK button, bottom-right. Fires on
 * pointerdown; hidden entirely while no special weapon is equipped.
 * The cooldown ring is a conic-gradient repaint on a tiny canvas.
 */
export function createSpecialButton(root: HTMLElement, fire: () => void): SpecialButton {
  const btn = document.createElement('div')
  btn.style.cssText = [
    'position:fixed',
    'right:max(27px, env(safe-area-inset-right))',
    `bottom:calc(max(32px, env(safe-area-inset-bottom)) + 98px)`,
    `width:${SIZE}px`,
    `height:${SIZE}px`,
    'border-radius:50%',
    'background:rgba(16,22,34,0.35)',
    'border:2px solid rgba(255,210,62,0.45)',
    'color:rgba(255,210,62,0.9)',
    'font:bold 12px "Courier New", monospace',
    'letter-spacing:1px',
    'display:none',
    'align-items:center',
    'justify-content:center',
    'pointer-events:auto',
    'touch-action:none',
    'z-index:40',
    'user-select:none',
    '-webkit-user-select:none',
    '-webkit-tap-highlight-color:transparent',
  ].join(';')
  btn.textContent = 'SPC'

  const ring = document.createElement('canvas')
  ring.width = SIZE
  ring.height = SIZE
  ring.style.cssText = 'position:absolute;left:-2px;top:-2px;pointer-events:none'
  btn.appendChild(ring)

  let lastFrac = -1
  const paint = (frac: number): void => {
    if (Math.abs(frac - lastFrac) < 0.02 && frac !== 0) return
    lastFrac = frac
    const g = ring.getContext('2d')
    if (!g) return
    g.clearRect(0, 0, SIZE, SIZE)
    if (frac <= 0) return
    g.beginPath()
    g.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 3, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac)
    g.strokeStyle = 'rgba(255,210,62,0.85)'
    g.lineWidth = 4
    g.stroke()
  }

  const onDown = (e: PointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    btn.style.background = 'rgba(255,210,62,0.3)'
    btn.style.transform = 'scale(0.92)'
    fire()
  }
  const onUp = (e: PointerEvent): void => {
    e.stopPropagation()
    btn.style.background = 'rgba(16,22,34,0.35)'
    btn.style.transform = 'scale(1)'
  }
  btn.addEventListener('pointerdown', onDown)
  btn.addEventListener('pointerup', onUp)
  btn.addEventListener('pointercancel', onUp)
  btn.addEventListener('pointerleave', onUp)
  root.appendChild(btn)

  return {
    set(visible, cdFrac) {
      btn.style.display = visible ? 'flex' : 'none'
      if (visible) paint(cdFrac)
    },
    dispose() {
      btn.remove()
    },
  }
}
