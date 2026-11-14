/**
 * Blocklings — local player: voxel hero, input, movement, camera follow.
 *
 * createPlayer(scene, world, state[, camera]) builds the voxel character,
 * wires keyboard (WASD/arrows) + mobile touch-joystick input, moves the
 * character with smooth accel/decel and axis-separated sliding collision
 * against world.isBlocked, and (when handed the camera) smooth-lerp
 * follows with wheel/pinch zoom — fixed isometric yaw, no rotation drama.
 *
 * It also boots the realtime presence client (src/net): remote players
 * appear as the same voxel character with name-hash tunic colors. The
 * net handle is exposed on the returned object so chat can be wired:
 *   api.chatSend = (msg) => player.net.sendChat(msg)
 *   player.net.onChat = (from, msg) => api.onChat?.(from, msg)
 */
import * as THREE from 'three'
import type { PlayerState, World } from '../types'
import { events } from '../events'
import { saveRegistry } from '../save/registry'
import { CharacterRig, type GripStyle, type SpecialAnim } from './character'
import { DEFAULT_LOOK, decodeLook, encodeLook, type CharacterLook } from './look'
import { createJoystick, createAttackButton, type Joystick, type AttackButton } from './joystick'
import { connect, WS_URL, type NetHandle } from '../net/index'

// ---------------------------------------------------------------------------
// Module-level combat/equipment API (binds to the live player instance)
// ---------------------------------------------------------------------------

/** A point the hero should walk himself to (tap-to-attack chase). */
export interface AutoWalkTarget {
  x: number
  z: number
  /** Stop when within this distance (world units). */
  arrive: number
}

interface PlayerControl {
  rig: CharacterRig
  attack(): void
  special(kind: SpecialAnim, cb?: () => void): boolean
  hurt(): void
  die(cb?: (revive: () => void) => void): void
  setAutoWalk(target: AutoWalkTarget | null): void
}

let control: PlayerControl | null = null
const attackCbs = new Set<() => void>()

// ---------------------------------------------------------------------------
// Character look (customization) — module-level so the creator can set it
// BEFORE the world (and the rig) exists, and settings can change it after.
// ---------------------------------------------------------------------------

let activeLook: CharacterLook = DEFAULT_LOOK
let announceLook: (() => void) | null = null

/** The hero's current look (copy). */
export function currentLook(): CharacterLook {
  return { ...activeLook }
}

/**
 * Change the hero's look. Before the world exists this just records it (the
 * rig is then born wearing it); after, the rig is rebuilt IN PLACE —
 * position, facing and every equipped item mesh survive — the new look is
 * announced to the relay, and a save is queued via 'save:dirty'.
 */
export function applyLook(look: CharacterLook): void {
  activeLook = { ...look }
  control?.rig.applyLook(activeLook)
  announceLook?.()
  events.emit('save:dirty', { why: 'look' })
}

/** Set the look without emitting save:dirty (save-load path). */
function restoreLook(look: CharacterLook): void {
  activeLook = { ...look }
  control?.rig.applyLook(activeLook)
  announceLook?.()
}

// Persistence: the look rides the save envelope as a compact code. Register
// at module scope so initSave's late-binding apply finds it whenever it runs.
saveRegistry.register('look', {
  dump: () => encodeLook(activeLook),
  load(data: unknown): void {
    const look = decodeLook(data)
    if (look) restoreLook(look)
  }
})

/**
 * Register a strike callback: fires at the strike frame (~125ms) of every
 * attack swing. The combat module hooks damage-dealing here. Returns an
 * unsubscribe function.
 */
export function onAttack(cb: () => void): () => void {
  attackCbs.add(cb)
  return () => {
    attackCbs.delete(cb)
  }
}

/**
 * Play the 250ms arm-swing attack (weapon arcs with the arm). No-op while
 * a swing is already in flight or the player is dead. Wired to left-click
 * on the canvas, spacebar, and the mobile ATTACK button; other modules may
 * also call it directly.
 */
export function triggerAttack(): void {
  control?.attack()
}

/**
 * Attach an equipment mesh (from ItemsAPI.buildMesh) to the character:
 * slots 'weapon' | 'shield' | 'helm' | 'chest' | 'boots'; null clears the
 * slot (weapon slot then shows the classic sword again). The integrator
 * calls this on 'item:equipped'.
 */
export function setEquipmentMesh(slot: string, mesh: THREE.Group | null): void {
  control?.rig.setEquipmentMesh(slot, mesh)
}

/**
 * Play a special-attack animation: 'spin' (whirlwind), 'lunge' (dash-pierce),
 * 'cast' (staff raise), 'volley' (bow fan) or 'bash' (shield shove).
 * `onStrike` fires once at the ability's strike frame. Returns false (and
 * plays nothing) while dead or mid-swing/special — the combat module wires
 * this via combat.setSpecialAnimTrigger(triggerSpecial).
 */
export function triggerSpecial(kind: string, onStrike?: () => void): boolean {
  if (kind !== 'spin' && kind !== 'lunge' && kind !== 'cast' && kind !== 'volley' && kind !== 'bash') {
    return false
  }
  return control?.special(kind, onStrike) ?? false
}

/**
 * Walk the hero to a world-space point (full walk animation + collision),
 * stopping within `arrive` units; null cancels. Manual input (keys/joystick)
 * always wins while held. Wired by the integrator:
 *   combat.setAutoWalk((t) => setAutoWalk(t))
 */
export function setAutoWalk(target: AutoWalkTarget | null): void {
  control?.setAutoWalk(target)
}

/**
 * Optional richer grip lookup (integrator may wire items.def to return
 * ItemDef.gripStyle). Without it the player falls back to the catalog's
 * id conventions (sword_/axe_/pick_/hatchet_ forward, staff_ upright,
 * bow_ bow, shield_ shield).
 */
let gripSource: ((itemId: string) => string | undefined) | null = null
export function setGripStyleSource(fn: (itemId: string) => string | undefined): void {
  gripSource = fn
}

function gripOf(id: string): GripStyle | null {
  const fromSource = gripSource?.(id)
  if (
    fromSource === 'upright' || fromSource === 'forward' ||
    fromSource === 'bow' || fromSource === 'shield'
  ) {
    return fromSource
  }
  if (id.startsWith('staff_')) return 'upright'
  if (id.startsWith('bow_')) return 'bow'
  if (id.startsWith('shield_')) return 'shield'
  if (/^(sword|axe|pick|hatchet)_/.test(id)) return 'forward'
  return null
}

/** Brief red damage flash + a knockback nudge opposite the facing. */
export function playerHurt(): void {
  control?.hurt()
}

/**
 * Dramatic topple. When the body hits the dirt, `cb(revive)` fires — the
 * integrator fades the screen, moves state.pos to the respawn point, then
 * calls revive() to stand the hero back up and re-enable input. Without a
 * cb he gets back up on his own after ~1.2s (shame is temporary).
 */
export function playerDie(cb?: (revive: () => void) => void): void {
  control?.die(cb)
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const MAX_SPEED = 4.3 // units/s
const ACCEL = 26 // units/s² when speeding up
const DECEL = 20 // units/s² when stopping
const RADIUS = 0.3 // collision radius (half-width of the hero)
const TURN_RATE = 14 // facing lerp sharpness

// Camera rig — matches the scaffold's isometric feel (45° yaw, 50° pitch).
const CAM_YAW = Math.PI / 4
const CAM_PITCH = (50 * Math.PI) / 180
const CAM_DIST = 30
const ZOOM_MIN = 0.55 // closest (≈16.5 units)
const ZOOM_MAX = 1.7 // farthest (≈51 units)

export interface PlayerHandle {
  /** The hero's root group (position = feet, rotation.y = facing). */
  group: THREE.Group
  /** Per-frame tick — hooked into the main loop. */
  update(dt: number): void
  /** Multiplayer presence/chat client (works silently offline). */
  net: NetHandle
  dispose(): void
}

export function createPlayer(
  scene: THREE.Scene,
  world: World,
  state: PlayerState,
  camera?: THREE.PerspectiveCamera
): PlayerHandle {
  // --- character (born wearing the chosen/saved look) ----------------------
  const rig = new CharacterRig(activeLook)
  rig.group.position.copy(state.pos)
  rig.group.rotation.y = state.facing
  scene.add(rig.group)

  // --- combat state + actions ----------------------------------------------
  let dead = false
  let autoTarget: AutoWalkTarget | null = null

  function doAttack(): void {
    if (dead) return
    rig.startAttack(() => {
      for (const fn of [...attackCbs]) {
        try {
          fn()
        } catch (e) {
          console.error('[player] onAttack handler threw', e)
        }
      }
    })
  }

  function doSpecial(kind: SpecialAnim, cb?: () => void): boolean {
    if (dead) return false
    return rig.startSpecial(kind, cb)
  }

  // --- weapon grip style follows the equipped weapon ------------------------
  const offGripEquip = events.on('item:equipped', ({ slot, id }) => {
    if (slot !== 'weapon') return
    rig.setGripStyle(id ? gripOf(id) : null)
  })

  function doHurt(): void {
    if (dead) return
    rig.flashHurt()
    // knockback nudge: shove opposite the facing; normal integration +
    // wall collision absorb it over the next few frames
    const kick = 3.4
    vel.x -= Math.sin(state.facing) * kick
    vel.y -= Math.cos(state.facing) * kick
  }

  function doDie(cb?: (revive: () => void) => void): void {
    if (dead) return
    dead = true
    keys.clear()
    autoTarget = null
    state.moving = false
    rig.die(() => {
      const revive = (): void => {
        if (!dead) return
        dead = false
        rig.revive()
        rig.group.position.copy(state.pos)
      }
      if (cb) cb(revive)
      else window.setTimeout(revive, 1200)
    })
  }

  // --- keyboard ------------------------------------------------------------
  const keys = new Set<string>()

  function typingInField(e: KeyboardEvent): boolean {
    const t = e.target
    return (
      t instanceof HTMLInputElement ||
      t instanceof HTMLTextAreaElement ||
      (t instanceof HTMLElement && t.isContentEditable)
    )
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (typingInField(e)) return
    keys.add(e.code)
    if (e.code.startsWith('Arrow')) e.preventDefault() // no page scroll
    if (e.code === 'Space') {
      e.preventDefault() // no page scroll
      if (!e.repeat) doAttack()
    }
  }
  const onKeyUp = (e: KeyboardEvent): void => {
    keys.delete(e.code)
  }
  const onBlur = (): void => keys.clear()
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)

  // --- touch joystick + ATTACK button (coarse pointers / touch only) ------
  let joystick: Joystick | null = null
  let attackBtn: AttackButton | null = null
  const uiRoot = document.getElementById('ui')
  const touchy =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window
      : 'ontouchstart' in window
  if (uiRoot && touchy) {
    joystick = createJoystick(uiRoot)
    attackBtn = createAttackButton(uiRoot, doAttack)
  }

  // --- left-click attack (mouse/pen on the canvas, never on UI) ------------
  const onCanvasDown = (e: PointerEvent): void => {
    if (e.button !== 0 || e.pointerType === 'touch') return
    if (!(e.target instanceof HTMLCanvasElement)) return // UI clicks don't swing
    doAttack()
  }
  window.addEventListener('pointerdown', onCanvasDown)

  // --- camera zoom (wheel + pinch), only when we drive the camera ----------
  let zoom = 1
  let zoomTarget = 1
  const camCurrent = new THREE.Vector3()
  let camSnapped = false
  const pinchPts = new Map<number, { x: number; y: number }>()
  let pinchDist = 0

  const onWheel = (e: WheelEvent): void => {
    zoomTarget = THREE.MathUtils.clamp(
      zoomTarget * Math.exp(e.deltaY * 0.0012),
      ZOOM_MIN,
      ZOOM_MAX
    )
  }
  const onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType !== 'touch') return
    pinchPts.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinchPts.size === 2) pinchDist = currentPinchDist()
  }
  const onPointerMove = (e: PointerEvent): void => {
    if (!pinchPts.has(e.pointerId)) return
    pinchPts.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinchPts.size === 2) {
      const d = currentPinchDist()
      if (pinchDist > 0 && d > 0) {
        zoomTarget = THREE.MathUtils.clamp(zoomTarget * (pinchDist / d), ZOOM_MIN, ZOOM_MAX)
      }
      pinchDist = d
    }
  }
  const onPointerEnd = (e: PointerEvent): void => {
    pinchPts.delete(e.pointerId)
    pinchDist = 0
  }
  function currentPinchDist(): number {
    const pts = [...pinchPts.values()]
    const a = pts[0]
    const b = pts[1]
    if (!a || !b) return 0
    return Math.hypot(a.x - b.x, a.y - b.y)
  }

  if (camera) {
    window.addEventListener('wheel', onWheel, { passive: true })
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerEnd)
    window.addEventListener('pointercancel', onPointerEnd)
  }

  // --- multiplayer presence ------------------------------------------------
  const net = connect(WS_URL, state.name, {
    scene,
    world,
    local: state,
    look: () => encodeLook(activeLook)
  })
  announceLook = () => net.sendLook()

  // --- movement ------------------------------------------------------------
  const vel = new THREE.Vector2() // x/z velocity

  function inputVector(): { x: number; z: number } {
    if (dead) return { x: 0, z: 0 } // corpses don't WASD
    // raw input in screen space: ix right, iy forward(up-screen)
    let ix = 0
    let iy = 0
    if (keys.has('KeyW') || keys.has('ArrowUp')) iy += 1
    if (keys.has('KeyS') || keys.has('ArrowDown')) iy -= 1
    if (keys.has('KeyD') || keys.has('ArrowRight')) ix += 1
    if (keys.has('KeyA') || keys.has('ArrowLeft')) ix -= 1
    if (joystick && joystick.active) {
      ix += joystick.x
      iy += joystick.y
    }
    const len = Math.hypot(ix, iy)
    if (len > 1) {
      ix /= len
      iy /= len
    }
    if (ix !== 0 || iy !== 0) {
      // manual input always wins over tap-to-attack auto-walk
      autoTarget = null
      // rotate into world space around the fixed isometric yaw:
      // screen-forward = -(sin yaw, cos yaw), screen-right = (cos yaw, -sin yaw)
      const s = Math.sin(CAM_YAW)
      const c = Math.cos(CAM_YAW)
      return { x: ix * c - iy * s, z: -ix * s - iy * c }
    }
    // tap-to-attack auto-walk: head straight for the target, stop on arrival
    if (autoTarget) {
      const dx = autoTarget.x - state.pos.x
      const dz = autoTarget.z - state.pos.z
      const d = Math.hypot(dx, dz)
      if (d <= autoTarget.arrive) {
        autoTarget = null
      } else {
        return { x: dx / d, z: dz / d }
      }
    }
    return { x: 0, z: 0 }
  }

  function tryMove(dt: number): void {
    const want = inputVector()
    const targetVx = want.x * MAX_SPEED
    const targetVz = want.z * MAX_SPEED
    const hasInput = want.x !== 0 || want.z !== 0
    const rate = hasInput ? ACCEL : DECEL
    const maxStep = rate * dt
    const dvx = targetVx - vel.x
    const dvz = targetVz - vel.y
    const dvLen = Math.hypot(dvx, dvz)
    if (dvLen <= maxStep) {
      vel.set(targetVx, targetVz)
    } else {
      vel.x += (dvx / dvLen) * maxStep
      vel.y += (dvz / dvLen) * maxStep
    }

    const p = state.pos
    // axis-separated moves => sliding along walls instead of sticking
    if (vel.x !== 0) {
      const nx = p.x + vel.x * dt
      const sx = Math.sign(vel.x)
      if (
        world.isBlocked(nx + sx * RADIUS, p.z - RADIUS * 0.7) ||
        world.isBlocked(nx + sx * RADIUS, p.z + RADIUS * 0.7)
      ) {
        vel.x = 0
      } else {
        p.x = nx
      }
    }
    if (vel.y !== 0) {
      const nz = p.z + vel.y * dt
      const sz = Math.sign(vel.y)
      if (
        world.isBlocked(p.x - RADIUS * 0.7, nz + sz * RADIUS) ||
        world.isBlocked(p.x + RADIUS * 0.7, nz + sz * RADIUS)
      ) {
        vel.y = 0
      } else {
        p.z = nz
      }
    }

    // feet track the ground, softly (stairs/terraces don't pop)
    const gh = world.groundHeight(p.x, p.z)
    p.y += (gh - p.y) * Math.min(1, dt * 14)

    // facing + moving flag
    const speed = Math.hypot(vel.x, vel.y)
    state.moving = speed > 0.15
    if (speed > 0.15) {
      const want2 = Math.atan2(vel.x, vel.y) // 0 = +Z, CCW — per contract
      let diff = want2 - state.facing
      while (diff > Math.PI) diff -= Math.PI * 2
      while (diff < -Math.PI) diff += Math.PI * 2
      state.facing += diff * Math.min(1, dt * TURN_RATE)
    }

    rig.group.position.copy(p)
    rig.group.rotation.y = state.facing
    rig.update(dt, state.moving, speed / MAX_SPEED)
  }

  // --- camera follow -------------------------------------------------------
  const camTarget = new THREE.Vector3()
  const camOffsetDir = new THREE.Vector3(
    Math.sin(CAM_YAW) * Math.cos(CAM_PITCH),
    Math.sin(CAM_PITCH),
    Math.cos(CAM_YAW) * Math.cos(CAM_PITCH)
  )

  function updateCamera(dt: number): void {
    if (!camera) return
    zoom += (zoomTarget - zoom) * Math.min(1, dt * 8)
    camTarget.set(state.pos.x, state.pos.y + 1, state.pos.z)
    const desired = camTarget.clone().addScaledVector(camOffsetDir, CAM_DIST * zoom)
    if (!camSnapped) {
      camCurrent.copy(desired)
      camSnapped = true
    } else {
      camCurrent.lerp(desired, Math.min(1, dt * 7))
    }
    camera.position.copy(camCurrent)
    camera.lookAt(camTarget)
  }

  // --- module-level combat API binds to this instance ----------------------
  const myControl: PlayerControl = {
    rig,
    attack: doAttack,
    special: doSpecial,
    hurt: doHurt,
    die: doDie,
    setAutoWalk(target) {
      autoTarget = dead ? null : target
    },
  }
  control = myControl

  // --- tick ----------------------------------------------------------------
  return {
    group: rig.group,
    net,
    update(dt: number): void {
      tryMove(dt)
      net.update(dt)
      updateCamera(dt)
    },
    dispose(): void {
      if (control === myControl) control = null
      announceLook = null
      offGripEquip()
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('pointerdown', onCanvasDown)
      if (camera) {
        window.removeEventListener('wheel', onWheel)
        window.removeEventListener('pointerdown', onPointerDown)
        window.removeEventListener('pointermove', onPointerMove)
        window.removeEventListener('pointerup', onPointerEnd)
        window.removeEventListener('pointercancel', onPointerEnd)
      }
      joystick?.dispose()
      attackBtn?.dispose()
      net.dispose()
      scene.remove(rig.group)
      rig.dispose()
    }
  }
}
