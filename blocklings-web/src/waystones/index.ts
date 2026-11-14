/**
 * Blocklings — teleport waystones core.
 *
 * Places every WAYSTONES entry (src/ids.ts) as a runed voxel monolith.
 * Walking within 2 units of a dormant stone attunes it (flash + chime +
 * comedy chat line + save). Interacting with an attuned stone (E key, tap
 * on the stone, or the proximity Travel button on mobile) opens the travel
 * panel listing every OTHER attuned stone; picking one fades to black,
 * moves the player, plays an arrival chime and fades back in.
 *
 * The Village Waystone starts attuned. Attunement persists through the
 * save registry under the 'stones' key (CharacterSave.stones: string[]).
 *
 * Emits: 'waystone:attuned', 'waystone:traveled', 'chat:system',
 * 'save:dirty'. Runs its own light RAF loop; animation is distance-culled.
 *
 * Exposes lastUsedStone() — the respawn anchor for the combat module
 * (last stone attuned or traveled to; Village until then).
 */
import * as THREE from 'three'
import type { GameAPI } from '../types'
import { WAYSTONES, REGIONS } from '../ids'
import { events } from '../events'
import { saveRegistry } from '../save/registry'
import { StoneRig } from './monolith'
import { TravelPanel, FadeVeil, type TravelOption } from './panel'
import { attuneLine, arrivalLine, dormantTapLine } from './flavor'
import { playAttuneChime, playArrivalChime } from './chime'
import './waystones.css'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const ATTUNE_RANGE = 2.0 // walk inside this -> attune
const USE_RANGE = 2.6 // E key / Travel button range
const CLICK_RANGE = 4.2 // tap-on-stone range
const CLOSE_RANGE = 5.5 // auto-close the panel if the player wanders off
const ANIM_RANGE = 80 // beyond this, stones hold still (fog hides them)

const HOME_STONE = 'ws_village' // starts attuned; respawn fallback

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface WaystonesModule {
  /**
   * The last waystone the player attuned or traveled to (Village until
   * then) — combat's respawn anchor. `pos` is a safe walkable arrival
   * spot beside the stone, at ground height (fresh vector each call).
   */
  lastUsedStone(): { id: string; name: string; pos: THREE.Vector3 }
  /** Ids of currently attuned stones (worldmap seeds its lit icons from this). */
  attunedStones(): string[]
  /**
   * Teleport to an attuned stone (worldmap's requestTravel bridge).
   * Ignored for dormant/unknown stones or while a teleport is in flight.
   */
  travelTo(stoneId: string): void
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

interface StoneRuntime {
  def: (typeof WAYSTONES)[number]
  rig: StoneRig
  arrival: { x: number; z: number }
}

let inited: WaystonesModule | null = null

export function initWaystones(api: GameAPI): WaystonesModule {
  if (inited) return inited

  const uiMount = document.getElementById('ui') ?? document.body
  const regionName = new Map(REGIONS.map((r) => [r.id, r.name]))

  // --- place every stone on its anchor ------------------------------------
  const list: StoneRuntime[] = []
  const byId = new Map<string, StoneRuntime>()
  const hitMeshes: THREE.Mesh[] = []

  for (const def of WAYSTONES) {
    const rig = new StoneRig(def.name)
    rig.group.position.set(def.x, api.world.groundHeight(def.x, def.z), def.z)
    rig.hit.userData['stoneIdx'] = list.length
    api.scene.add(rig.group)
    hitMeshes.push(rig.hit)
    const s: StoneRuntime = { def, rig, arrival: findArrival(api, def.x, def.z) }
    list.push(s)
    byId.set(def.id, s)
  }

  // --- attunement state + persistence ('stones' -> CharacterSave.stones) --
  const attuned = new Set<string>([HOME_STONE])
  let lastUsed = HOME_STONE
  byId.get(HOME_STONE)?.rig.setAttuned(true)

  saveRegistry.register('stones', {
    dump: (): unknown => [...attuned],
    load: (data: unknown): void => {
      attuned.clear()
      attuned.add(HOME_STONE)
      if (Array.isArray(data)) {
        for (const id of data) {
          if (typeof id === 'string' && byId.has(id)) attuned.add(id)
        }
      }
      for (const s of list) s.rig.setAttuned(attuned.has(s.def.id))
      if (!attuned.has(lastUsed)) lastUsed = HOME_STONE
    }
  })

  // --- travel panel + teleport veil ---------------------------------------
  const veil = new FadeVeil(uiMount)

  /** Fade-to-black teleport to an attuned stone (panel taps + worldmap). */
  function teleportTo(destId: string, from: string): void {
    const dest = byId.get(destId)
    if (!dest || !attuned.has(destId) || veil.active) return
    if (panel.isOpen) panel.close()
    veil.run(() => {
      const a = dest.arrival
      api.player.pos.set(a.x, api.world.groundHeight(a.x, a.z), a.z)
      lastUsed = dest.def.id
      playArrivalChime()
      events.emit('waystone:traveled', { from, to: dest.def.id })
      events.emit('chat:system', { text: arrivalLine(dest.def.name) })
    })
  }

  const panel = new TravelPanel(uiMount, (destId: string) => {
    const from = panel.stoneId
    if (!from) return
    teleportTo(destId, from)
  })

  function openPanel(s: StoneRuntime): void {
    const options: TravelOption[] = list
      .filter((o) => o.def.id !== s.def.id && attuned.has(o.def.id))
      .map((o) => ({
        id: o.def.id,
        name: o.def.name,
        region: regionName.get(o.def.regionId) ?? o.def.regionId
      }))
    panel.open(s.def.id, s.def.name, options)
  }

  // --- proximity Travel button (mobile-first; harmless on desktop) --------
  const goBtn = document.createElement('button')
  goBtn.className = 'bl-ws-go'
  goBtn.style.display = 'none'
  goBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (nearest && nearestDist <= USE_RANGE && attuned.has(nearest.def.id) && !panel.isOpen) {
      openPanel(nearest)
    }
  })
  uiMount.appendChild(goBtn)

  // --- tap-on-stone (raycast; drags and long-presses don't count) ---------
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
    const idx = hit.object.userData['stoneIdx']
    const s = typeof idx === 'number' ? list[idx] : undefined
    if (!s) return
    const d = dist2d(s.rig.group.position, api.player.pos)
    if (d > CLICK_RANGE) return
    if (attuned.has(s.def.id)) openPanel(s)
    else events.emit('chat:system', { text: dormantTapLine() })
  })

  // --- E to travel ---------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'e' && e.key !== 'E') return
    const ae = document.activeElement
    if (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement) return
    if (panel.isOpen || veil.active) return
    if (nearest && nearestDist <= USE_RANGE && attuned.has(nearest.def.id)) openPanel(nearest)
  })

  // --- attune + animation loop --------------------------------------------
  let nearest: StoneRuntime | null = null
  let nearestDist = Infinity
  let last = performance.now()

  function tick(now: number): void {
    const dt = Math.min((now - last) / 1000, 0.1)
    last = now
    const p = api.player.pos

    nearest = null
    nearestDist = Infinity

    for (const s of list) {
      const g = s.rig.group.position
      const d = Math.hypot(p.x - g.x, p.z - g.z)
      if (d < nearestDist) {
        nearestDist = d
        nearest = s
      }

      // walking up to a dormant stone wakes it
      if (d <= ATTUNE_RANGE && !attuned.has(s.def.id)) {
        attuned.add(s.def.id)
        lastUsed = s.def.id
        s.rig.setAttuned(true)
        s.rig.flash()
        playAttuneChime()
        events.emit('waystone:attuned', { stoneId: s.def.id })
        events.emit('chat:system', { text: attuneLine(s.def.id) })
        events.emit('save:dirty', { why: `waystone ${s.def.id} attuned` })
      }

      if (d <= ANIM_RANGE) s.rig.update(dt)
    }

    // proximity Travel button
    if (!panel.isOpen && !veil.active && nearest && nearestDist <= USE_RANGE && attuned.has(nearest.def.id)) {
      goBtn.textContent = `Travel — ${nearest.def.name}`
      goBtn.style.display = ''
    } else {
      goBtn.style.display = 'none'
    }

    // wandering off mid-browse closes the menu; the stone doesn't chase you
    if (panel.isOpen && !veil.active) {
      const s = panel.stoneId ? byId.get(panel.stoneId) : undefined
      if (s && dist2d(s.rig.group.position, p) > CLOSE_RANGE) panel.close()
    }

    requestAnimationFrame(tick)
  }

  requestAnimationFrame(tick)

  // --- module handle --------------------------------------------------------
  inited = {
    lastUsedStone() {
      const s = byId.get(lastUsed) ?? byId.get(HOME_STONE) ?? (list[0] as StoneRuntime)
      const a = s.arrival
      return {
        id: s.def.id,
        name: s.def.name,
        pos: new THREE.Vector3(a.x, api.world.groundHeight(a.x, a.z), a.z)
      }
    },
    attunedStones() {
      return [...attuned]
    },
    travelTo(stoneId: string) {
      teleportTo(stoneId, lastUsed)
    }
  }
  return inited
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dist2d(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

/**
 * A walkable spot beside the stone to arrive on (so the player never
 * materializes inside 2.5 units of sacred rock). Spiral search outward
 * from 1.4 units south of the anchor.
 */
function findArrival(api: GameAPI, x0: number, z0: number): { x: number; z: number } {
  if (!api.world.isBlocked(x0, z0 + 1.4)) return { x: x0, z: z0 + 1.4 }
  for (let r = 1.4; r <= 5; r += 0.8) {
    for (let a = 0; a < 12; a++) {
      const ang = (a / 12) * Math.PI * 2
      const x = x0 + Math.cos(ang) * r
      const z = z0 + Math.sin(ang) * r
      if (!api.world.isBlocked(x, z)) return { x, z }
    }
  }
  return { x: x0, z: z0 } // worst case: commune with the stone, intimately
}
