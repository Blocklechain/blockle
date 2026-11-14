/**
 * Blocklings — NPC population core.
 *
 * Spawns every NPC in src/ids.ts NPCS as a cute voxel character (same
 * builder vocabulary as the hero) with a role-flavored outfit, a floating
 * name, and an idle wander: 2-3 unit leash around home, pauses, and turning
 * to face the player when they come close.
 *
 * Interact: click/tap an NPC, press E nearby, or the proximity Talk button
 * (mobile). Opens the dialog panel — comedy greetings, quest offers /
 * progress through the integrator-wired QuestsAPI, and vendor buy lists
 * priced in game-BLOCK-cents from the purse.
 *
 * Emits: 'npc:talked' (dialog finished), 'item:gained' (vendor purchases —
 * the inventory module applies them), 'chat:system', 'save:dirty' (purse).
 * Runs its own light RAF loop; animation is distance-culled.
 */
import * as THREE from 'three'
import type { GameAPI, QuestsAPI } from '../types'
import { NPCS, type NpcDef } from '../ids'
import { events } from '../events'
import { NpcRig, makePortrait, type NpcLook } from './rig'
import { DialogPanel } from './dialog'
import { purse, registerPurseSave } from './purse'
import { ROLE_TAGS, greeting, tooFarLine } from './flavor'
import { VENDOR_STOCK, type StockEntry } from './vendors'
import './npcs.css'

export { purse } from './purse'
export type { PurseAPI } from './purse'

// ---------------------------------------------------------------------------
// Per-NPC looks (role-flavored outfits in the same voxel vocabulary)
// ---------------------------------------------------------------------------

const LOOKS: Record<string, NpcLook> = {
  elder_rowan: { tunicHue: 275, hairIdx: 5, beard: true, robe: true, held: 'staff' },
  merchant_hilda: { tunicHue: 35, hairIdx: 3, apron: true, hat: true },
  farmer_bram: { tunicHue: 95, hairIdx: 2, hat: true },
  guard_tomas: { tunicHue: 215, hairIdx: 1, helmet: true, held: 'spear' },
  scout_wren: { tunicHue: 130, hairIdx: 0, headband: true },
  herbalist_moss: { tunicHue: 155, hairIdx: 2, apron: true },
  ranger_kael: { tunicHue: 110, hairIdx: 1, headband: true },
  foreman_dagna: { tunicHue: 25, hairIdx: 4, helmet: true },
  smith_orin: { tunicHue: 15, hairIdx: 1, apron: true },
  prospector_finn: { tunicHue: 45, hairIdx: 2, hat: true },
  captain_elara: { tunicHue: 350, hairIdx: 3, helmet: true },
  banker_aldous: { tunicHue: 50, hairIdx: 1, robe: true },
  mage_lyra: { tunicHue: 260, hairIdx: 5, robe: true, held: 'staff' },
  gravekeeper_sol: { tunicHue: 220, hairIdx: 1, robe: true, hat: true },
  hermit_vex: { tunicHue: 80, hairIdx: 4, beard: true, robe: true, held: 'staff' }
}

const FALLBACK_LOOK: NpcLook = { tunicHue: 200, hairIdx: 0 }

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const LEASH = 2.6 // wander radius around home
const WALK_SPEED = 1.15 // slower than the hero — these folks are off the clock
const FACE_RANGE = 3.4 // stop and look at the player inside this
const TALK_RANGE = 2.6 // E key / Talk button range
const CLICK_RANGE = 4.2 // click/tap-to-talk range
const CLOSE_RANGE = 5.5 // auto-close dialog if the player wanders off
const ANIM_RANGE = 80 // beyond this, NPCs hold still (fog hides them anyway)

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface NpcRuntime {
  def: NpcDef
  rig: NpcRig
  home: { x: number; z: number }
  target: { x: number; z: number } | null
  pauseT: number
}

let questsApi: QuestsAPI | null = null

/** Integrator wires the quests module here once it exists. */
export function setQuestsApi(q: QuestsAPI): void {
  questsApi = q
}

let inited = false

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function initNpcs(api: GameAPI): void {
  if (inited) return
  inited = true
  registerPurseSave()

  const uiMount = document.getElementById('ui') ?? document.body

  // --- spawn every NPC on walkable ground near its anchor ------------------
  const list: NpcRuntime[] = []
  const hitMeshes: THREE.Mesh[] = []

  for (const def of NPCS) {
    const look = LOOKS[def.id] ?? FALLBACK_LOOK
    const rig = new NpcRig(def.name, look)
    const spot = findWalkable(api, def.x, def.z)
    rig.group.position.set(spot.x, api.world.groundHeight(spot.x, spot.z), spot.z)
    rig.group.rotation.y = Math.random() * Math.PI * 2
    rig.hit.userData['npcIdx'] = list.length
    api.scene.add(rig.group)
    hitMeshes.push(rig.hit)
    list.push({
      def,
      rig,
      home: spot,
      target: null,
      pauseT: Math.random() * 3
    })
  }

  // --- dialog panel --------------------------------------------------------
  const dialog = new DialogPanel(uiMount, {
    quests: () => questsApi,
    purse: () => purse.get(),
    buy: (entry: StockEntry): boolean => {
      if (!purse.spend(entry.price)) return false
      // the inventory module is the one place stacks mutate — we only emit
      events.emit('item:gained', { id: entry.id, qty: 1, source: 'vendor' })
      events.emit('chat:system', { text: `Bought ${entry.name} for ${entry.price}c.` })
      return true
    },
    closed: (npcId: string) => {
      events.emit('npc:talked', { npcId })
    }
  })

  function openDialog(n: NpcRuntime): void {
    const look = LOOKS[n.def.id] ?? FALLBACK_LOOK
    dialog.open({
      id: n.def.id,
      name: n.def.name,
      roleTag: ROLE_TAGS[n.def.role] ?? 'Local',
      portrait: makePortrait(look),
      greeting: greeting(n.def.id, n.def.name),
      stock: n.def.role === 'vendor' ? (VENDOR_STOCK[n.def.id] ?? []) : []
    })
  }

  // --- proximity Talk button (mobile-first; harmless on desktop) ----------
  const talkBtn = document.createElement('button')
  talkBtn.className = 'bl-npc-talk'
  talkBtn.style.display = 'none'
  talkBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (nearest && nearestDist <= TALK_RANGE && !dialog.isOpen) openDialog(nearest)
  })
  uiMount.appendChild(talkBtn)

  // --- click/tap-to-talk (raycast; drags and long-presses don't count) ----
  const ray = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  let downX = 0
  let downY = 0
  let downT = 0

  window.addEventListener('pointerdown', (e) => {
    if (!(e.target instanceof HTMLCanvasElement)) return
    downX = e.clientX
    downY = e.clientY
    downT = performance.now()
  })

  window.addEventListener('pointerup', (e) => {
    if (!(e.target instanceof HTMLCanvasElement)) return
    if (performance.now() - downT > 450) return // long press = not a tap
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 10) return // drag
    ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1)
    ray.setFromCamera(ndc, api.camera)
    const hit = ray.intersectObjects(hitMeshes, false)[0]
    if (!hit) return
    const idx = hit.object.userData['npcIdx']
    const n = typeof idx === 'number' ? list[idx] : undefined
    if (!n) return
    const d = dist2d(n.rig.group.position, api.player.pos)
    if (d <= CLICK_RANGE) openDialog(n)
    else events.emit('chat:system', { text: tooFarLine(n.def.name) })
  })

  // --- E to talk -----------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'e' && e.key !== 'E') return
    const ae = document.activeElement
    if (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement) return
    if (dialog.isOpen) return
    if (nearest && nearestDist <= TALK_RANGE) openDialog(nearest)
  })

  // --- wander + animation loop --------------------------------------------
  let nearest: NpcRuntime | null = null
  let nearestDist = Infinity
  let last = performance.now()

  function tick(now: number): void {
    const dt = Math.min((now - last) / 1000, 0.1)
    last = now
    const p = api.player.pos

    nearest = null
    nearestDist = Infinity

    for (const n of list) {
      const g = n.rig.group
      const dx = p.x - g.position.x
      const dz = p.z - g.position.z
      const d = Math.hypot(dx, dz)
      if (d < nearestDist) {
        nearestDist = d
        nearest = n
      }
      if (d > ANIM_RANGE) continue // far away: hold pose, save the budget

      let moving = false
      if (d < FACE_RANGE) {
        // company! stop, turn, look friendly (or at least look)
        n.target = null
        n.pauseT = Math.max(n.pauseT, 0.8 + Math.random())
        faceToward(g, Math.atan2(dx, dz), dt)
      } else if (n.target) {
        const tx = n.target.x - g.position.x
        const tz = n.target.z - g.position.z
        const td = Math.hypot(tx, tz)
        if (td < 0.08) {
          n.target = null
          n.pauseT = 1.5 + Math.random() * 3.5
        } else {
          const step = Math.min(td, WALK_SPEED * dt)
          const nx = g.position.x + (tx / td) * step
          const nz = g.position.z + (tz / td) * step
          if (api.world.isBlocked(nx, nz)) {
            n.target = null
            n.pauseT = 1 + Math.random() * 2
          } else {
            g.position.x = nx
            g.position.z = nz
            moving = true
            faceToward(g, Math.atan2(tx, tz), dt)
          }
        }
      } else {
        n.pauseT -= dt
        if (n.pauseT <= 0) {
          n.target = pickWanderTarget(api, n)
          if (!n.target) n.pauseT = 1.5
        }
      }

      g.position.y = api.world.groundHeight(g.position.x, g.position.z)
      n.rig.update(dt, moving, moving ? 0.75 : 0)
    }

    // proximity Talk button
    if (!dialog.isOpen && nearest && nearestDist <= TALK_RANGE) {
      talkBtn.textContent = `Talk — ${nearest.def.name}`
      talkBtn.style.display = ''
    } else {
      talkBtn.style.display = 'none'
    }

    // walking away mid-conversation is a statement; the NPC takes the hint
    if (dialog.isOpen) {
      const id = dialog.npcId
      const n = id ? list.find((x) => x.def.id === id) : undefined
      if (n && dist2d(n.rig.group.position, p) > CLOSE_RANGE) dialog.close()
    }

    requestAnimationFrame(tick)
  }

  requestAnimationFrame(tick)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dist2d(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

/** Smoothly turn the group toward `yaw` (shortest way around). */
function faceToward(g: THREE.Group, yaw: number, dt: number): void {
  let diff = yaw - g.rotation.y
  while (diff > Math.PI) diff -= Math.PI * 2
  while (diff < -Math.PI) diff += Math.PI * 2
  g.rotation.y += diff * (1 - Math.exp(-dt * 8))
}

/** Nudge an anchor to the nearest walkable column (spiral search). */
function findWalkable(api: GameAPI, x0: number, z0: number): { x: number; z: number } {
  if (!api.world.isBlocked(x0, z0)) return { x: x0, z: z0 }
  for (let r = 1; r <= 6; r++) {
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2
      const x = x0 + Math.cos(ang) * r
      const z = z0 + Math.sin(ang) * r
      if (!api.world.isBlocked(x, z)) return { x, z }
    }
  }
  return { x: x0, z: z0 } // worst case: stand there awkwardly, very on-brand
}

/** A random unblocked point within the leash of home (or null to wait). */
function pickWanderTarget(api: GameAPI, n: NpcRuntime): { x: number; z: number } | null {
  for (let i = 0; i < 6; i++) {
    const ang = Math.random() * Math.PI * 2
    const r = 0.6 + Math.random() * (LEASH - 0.6)
    const x = n.home.x + Math.cos(ang) * r
    const z = n.home.z + Math.sin(ang) * r
    if (!api.world.isBlocked(x, z)) return { x, z }
  }
  return null
}
