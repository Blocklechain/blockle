/**
 * Blocklings — bootstrap.
 *
 * Sets up the renderer, scene, lights and the RAF loop, then wires the
 * feature modules together for real: world → player (input/camera/net) →
 * wallet (panel + HUD hook) → HUD (plate/chat/settings). The player module
 * drives the isometric camera (smooth follow + wheel/pinch zoom); main
 * keeps the sun's shadow frustum centred on the action.
 */
import * as THREE from 'three'
import type { GameAPI, PlayerState, WalletAPI } from './types'
import { createWorld } from './world'
import { createPlayer } from './player/index'
import { wallet } from './wallet/index'
import { initWalletUI } from './wallet/ui'
import { createHUD } from './ui'

declare global {
  interface Window {
    /** Wallet hook the HUD balance chip polls. */
    blocklingsWallet?: WalletAPI
    /** Render-quality hook the HUD settings toggle calls. */
    blocklingsSetQuality?: (high: boolean) => void
  }
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

const mount = document.getElementById('app')
if (!mount) throw new Error('missing #app mount')

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
renderer.outputColorSpace = THREE.SRGBColorSpace
mount.appendChild(renderer.domElement)

/** Quality hook for the HUD settings panel (high = native DPR, low = 1x). */
function setQuality(high: boolean): void {
  renderer.setPixelRatio(high ? Math.min(window.devicePixelRatio, 2) : 1)
  renderer.setSize(window.innerWidth, window.innerHeight)
}
window.blocklingsSetQuality = setQuality

// ---------------------------------------------------------------------------
// Scene, sky, fog
// ---------------------------------------------------------------------------

const SKY = new THREE.Color(0x87b7e8) // soft medieval morning sky
const scene = new THREE.Scene()
scene.background = SKY
scene.fog = new THREE.Fog(SKY, 55, 140)

// ---------------------------------------------------------------------------
// Lights
// ---------------------------------------------------------------------------

const hemi = new THREE.HemisphereLight(0xcfe6ff, 0x5a6b4a, 0.9)
scene.add(hemi)

const sun = new THREE.DirectionalLight(0xfff3d6, 1.6)
sun.position.set(24, 38, 18)
sun.castShadow = true
sun.shadow.mapSize.set(2048, 2048)
sun.shadow.camera.near = 1
sun.shadow.camera.far = 120
sun.shadow.camera.left = -45
sun.shadow.camera.right = 45
sun.shadow.camera.top = 45
sun.shadow.camera.bottom = -45
sun.shadow.bias = -0.0004
scene.add(sun)
scene.add(sun.target)

/** Keep the sun's shadow frustum centred on the player as they roam. */
function updateSun(): void {
  sun.target.position.copy(api.player.pos)
  sun.position.set(api.player.pos.x + 24, api.player.pos.y + 38, api.player.pos.z + 18)
}

// ---------------------------------------------------------------------------
// Isometric-feel camera (driven per-frame by the player module: smooth
// follow at the fixed 45°/50° angle + wheel/pinch zoom)
// ---------------------------------------------------------------------------

const camera = new THREE.PerspectiveCamera(
  35,
  window.innerWidth / window.innerHeight,
  0.1,
  300
)

// ---------------------------------------------------------------------------
// GameAPI hub
// ---------------------------------------------------------------------------

const player: PlayerState = {
  pos: new THREE.Vector3(0, 0, 0),
  facing: 0,
  moving: false,
  name: 'Adventurer',
  level: 1,
  hp: 100,
  maxHp: 100,
  mp: 50,
  maxMp: 50,
  xp: 0,
  xpToNext: 100
}

// --- world (terrain, collision, spawn) --------------------------------------

const world = createWorld(scene)
player.pos.copy(world.spawn)

const api: GameAPI = {
  scene,
  camera,
  world,
  player,
  // replaced below once the player (and its net client) exists
  chatSend(msg: string) {
    api.onChat?.(player.name, msg)
  },
  onChat: null
}

// --- player (voxel hero, input, camera follow, presence/chat client) --------

const hero = createPlayer(scene, world, player, camera)

// Chat bridge: HUD → net, net → HUD. sendChat locally echoes through
// onChat itself, so this works identically online and offline.
api.chatSend = (msg: string) => hero.net.sendChat(msg)
hero.net.onChat = (from: string, msg: string) => api.onChat?.(from, msg)

// --- wallet (parchment panel + HUD balance-chip hook) ------------------------

const uiMount = document.getElementById('ui')
if (!uiMount) throw new Error('missing #ui overlay mount')

window.blocklingsWallet = wallet
const walletPanel = initWalletUI(uiMount, wallet)

// --- HUD (plate, balance chip, settings, chat box, zone banner) --------------

const hud = createHUD(api, { setQuality })

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------

function onResize(): void {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
}
window.addEventListener('resize', onResize)
window.addEventListener('orientationchange', onResize)

// ---------------------------------------------------------------------------
// Main loop (dt clamped so tab-switches don't teleport anything)
// ---------------------------------------------------------------------------

let last = performance.now()

function frame(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.1)
  last = now
  world.update(dt) // water shimmer, window flicker
  hero.update(dt) // movement, net, camera follow
  walletPanel.update(dt)
  hud.update()
  updateSun()
  renderer.render(scene, camera)
  requestAnimationFrame(frame)
}

requestAnimationFrame(frame)
