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
import { CharacterRig } from './character'
import { createJoystick, type Joystick } from './joystick'
import { connect, WS_URL, type NetHandle } from '../net/index'

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
  // --- character -----------------------------------------------------------
  const rig = new CharacterRig({ tunicHue: 210 })
  rig.group.position.copy(state.pos)
  rig.group.rotation.y = state.facing
  scene.add(rig.group)

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
  }
  const onKeyUp = (e: KeyboardEvent): void => {
    keys.delete(e.code)
  }
  const onBlur = (): void => keys.clear()
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)

  // --- touch joystick (coarse pointers / touch devices only) ---------------
  let joystick: Joystick | null = null
  const uiRoot = document.getElementById('ui')
  const touchy =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window
      : 'ontouchstart' in window
  if (uiRoot && touchy) joystick = createJoystick(uiRoot)

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
  const net = connect(WS_URL, state.name, { scene, world, local: state })

  // --- movement ------------------------------------------------------------
  const vel = new THREE.Vector2() // x/z velocity

  function inputVector(): { x: number; z: number } {
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
    // rotate into world space around the fixed isometric yaw:
    // screen-forward = -(sin yaw, cos yaw), screen-right = (cos yaw, -sin yaw)
    const s = Math.sin(CAM_YAW)
    const c = Math.cos(CAM_YAW)
    return { x: ix * c - iy * s, z: -ix * s - iy * c }
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
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      if (camera) {
        window.removeEventListener('wheel', onWheel)
        window.removeEventListener('pointerdown', onPointerDown)
        window.removeEventListener('pointermove', onPointerMove)
        window.removeEventListener('pointerup', onPointerEnd)
        window.removeEventListener('pointercancel', onPointerEnd)
      }
      joystick?.dispose()
      net.dispose()
      scene.remove(rig.group)
      rig.dispose()
    }
  }
}
