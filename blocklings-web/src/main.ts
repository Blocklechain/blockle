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
import { events } from './events'
import { createWorld, regionAt } from './world'
import {
  createPlayer,
  setEquipmentMesh,
  triggerAttack,
  onAttack,
  playerHurt,
  playerDie
} from './player/index'
import { initSave } from './save'
import { initItems, itemsApi } from './items'
import { initSkills, skillsApi, maxHpBonus } from './skills'
import { initInventory } from './inventory'
import { initQuests, questDefById } from './quests'
import { initNpcs, setQuestsApi, purse } from './npcs'
import { initCombat } from './combat'
import { initGather } from './gather'
import { initWaystones } from './waystones'
import { initWorldmap } from './worldmap'
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

// --- UI mount (modules below render overlays into #ui) -----------------------

const uiMount = document.getElementById('ui')
if (!uiMount) throw new Error('missing #ui overlay mount')

// --- save (FIRST stateful module: loads the envelope, applies player pos/hp,
//     then late-applies each provider's blob the moment it registers) ---------

initSave(api)

// --- items (static catalog + voxel mesh builders) -----------------------------

initItems(api)

// --- skills (xp/levels; 'skills' save provider registers -> blob applied) ----

initSkills(api)

// Vitality -> max HP. Applied now (after the save loaded skills) and again on
// every vitality level-up; HP is clamped, and a fresh vitality level tops the
// new headroom up so leveling feels like a snack, not paperwork.
const BASE_MAX_HP = 100
function applyVitality(healDelta: number): void {
  const prev = player.maxHp
  player.maxHp = BASE_MAX_HP + maxHpBonus()
  if (healDelta > 0 && player.maxHp > prev) {
    player.hp += Math.min(healDelta, player.maxHp - prev)
  }
  player.hp = Math.min(player.hp, player.maxHp)
}
applyVitality(0)
events.on('level:up', ({ skill }) => {
  if (skill === 'vitality') applyVitality(4)
})

// --- inventory (+ real catalog defs + live 3D item viewer) --------------------

const inv = initInventory(api)
inv.setMeshSource((id) => itemsApi.buildMesh(id))
inv.setDefSource((id) => itemsApi.def(id))

// Equipment -> character: build the item's voxel mesh and hang it on the rig's
// attach points whenever a slot changes, plus one initial pass for loaded gear.
function applyEquipMesh(slot: string, id: string | null): void {
  setEquipmentMesh(slot, id ? itemsApi.buildMesh(id) : null)
}
events.on('item:equipped', ({ slot, id }) => applyEquipMesh(slot, id))
for (const [slot, id] of Object.entries(inv.equipment())) {
  if (id) applyEquipMesh(slot, id)
}

// --- quests (29 defs + log panel + tracker; 'quests' save provider) ----------

const quests = initQuests(api)

// Quest BLOCK-cent payouts land in the purse (quests only emits the event;
// the npcs module owns the soft-currency ledger).
events.on('quest:completed', ({ questId }) => {
  const cents = questDefById(questId)?.rewards.blockCents
  if (cents) purse.add(cents)
})

// --- npcs (15 villagers/vendors + dialogs + purse) ---------------------------

initNpcs(api)
setQuestsApi(quests)

// --- combat (mobs, bosses, loot, death/respawn) ------------------------------

const combat = initCombat(api)
combat.setStatsSource(() => inv.equippedStats())
combat.setSkillsSource((s) => skillsApi.level(s))
combat.setMeshSource((id) => itemsApi.buildMesh(id))
// Combat already folds gear def + the defense skill into `amount` (its
// internal defenseReduction uses the skills source), so here we just apply
// the hit and play the hero's hurt flash/knockback.
combat.setPlayerDamage((amount) => {
  player.hp = Math.max(0, player.hp - amount)
  playerHurt()
})
combat.setPlayerDeath((onDown) => playerDie(onDown))
onAttack(() => combat.playerStrike())

// --- gathering (90 nodes; reads the equipped tool, swings the hero's arm) ----

const gather = initGather(api)
gather.setInventory(inv)
gather.setSwing(() => triggerAttack())

// --- waystones (attune + teleport network; 'stones' save provider) -----------

const waystones = initWaystones(api)

// Respawn where you last touched a stone (Village until then), kept fresh on
// every attune/teleport.
function syncRespawn(): void {
  const s = waystones.lastUsedStone()
  combat.setRespawnPoint(s.pos.x, s.pos.z, s.name)
}
syncRespawn()
events.on('waystone:attuned', syncRespawn)
events.on('waystone:traveled', syncRespawn)

// --- world map + mini-map (travel taps bridge into the waystones module) -----

const worldmap = initWorldmap(api)
worldmap.setAttuned(waystones.attunedStones())
worldmap.setRequestTravel((stoneId) => waystones.travelTo(stoneId))

// --- wallet (parchment panel + HUD balance-chip hook) ------------------------

window.blocklingsWallet = wallet
const walletPanel = initWalletUI(uiMount, wallet)

// --- HUD (plate, balance chip, settings, chat box, zone banner) --------------

const hud = createHUD(api, { setQuality })

// System lines ('chat:system' from every module) land in the HUD chat box.
events.on('chat:system', ({ text }) => api.onChat?.('System', text))

// --- region tracking ('region:entered' on every border crossing) -------------

let currentRegionId: string | null = null
let regionPollT = 0
function pollRegion(dt: number): void {
  regionPollT += dt
  if (regionPollT < 0.5) return
  regionPollT = 0
  const r = regionAt(player.pos.x, player.pos.z)
  if (r && r.id !== currentRegionId) {
    currentRegionId = r.id
    events.emit('region:entered', { regionId: r.id })
  }
}

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
  pollRegion(dt) // 'region:entered' on border crossings (every ~0.5s)
  walletPanel.update(dt)
  hud.update()
  updateSun()
  renderer.render(scene, camera)
  requestAnimationFrame(frame)
}

requestAnimationFrame(frame)
