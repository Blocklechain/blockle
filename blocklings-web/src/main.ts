/**
 * Blocklings — bootstrap + integrator.
 *
 * Sets up the renderer, scene, lights and the RAF loop, then wires ALL the
 * feature modules together (events + setters only — main.ts is the single
 * place modules are allowed to meet).
 *
 * Boot order: auth gates everything — the title screen shows first, and the
 * world (save -> items -> skills -> inventory -> minting -> quests -> npcs ->
 * combat -> pets -> gather -> crafting -> waystones -> worldmap -> gold ->
 * market -> wallet -> achievements -> HUD) boots on the first 'auth:changed'
 * (sign-in OR offline
 * guest). The player module drives the isometric camera; main keeps the
 * sun's shadow frustum centred on the action.
 */
import * as THREE from 'three'
import type { ChainId, GameAPI, PlayerState, WalletAPI } from './types'
import { SPECIES } from './ids'
import { events } from './events'
import { createWorld, regionAt, regionOrZoneAt } from './world'
import {
  createPlayer,
  setEquipmentMesh,
  setGripStyleSource,
  setAutoWalk,
  triggerAttack,
  triggerSpecial,
  onAttack,
  playerHurt,
  playerDie
} from './player/index'
import { initAuth } from './auth'
import { needsCreator, showCreator, installAppearanceHook } from './creator'
import { applyLook } from './player/index'
import { initSave } from './save'
import { initItems, itemsApi } from './items'
import { initSkills, skillsApi, skillTree, maxHpBonus, prestigeResetSkill, setPrestigeXpBonus } from './skills'
import {
  initPrestige,
  masteryModifier,
  masteryBonus,
  setSkillLevelSource,
  setSkillReset
} from './prestige'
import type { SkillTreeAPI } from './types'
import { initInventory } from './inventory'
import { initUpgrading } from './upgrading'
import { initMinting } from './minting'
import { initQuests } from './quests'
import { initQuestGuide } from './quests/guide'
import { initNpcs, setQuestsApi, setPay, setGoldPay } from './npcs'
import { initCombat, setAutoRetaliate } from './combat'
import { MobRig } from './combat/mobs'
import { initRaids } from './raids'
import { initDungeon } from './dungeon'
import { initPets } from './pets'
import { initGather } from './gather'
import { initCrafting } from './crafting'
import { initWaystones } from './waystones'
import { initWorldmap } from './worldmap'
import { initAtmosphere } from './atmosphere'
import { initDirector } from './audio/director'
import { initSfx, setSurfaceSource } from './audio/sfx'
import { initAmbience } from './audio/ambience'
import {
  surfaceTypeAt,
  S_COBBLE,
  S_BRIDGE,
  S_SAND,
  S_RIVER,
  S_BANK
} from './world/surface'
import { initAchievements } from './achievements'
import { initGold, spendGold } from './gold'
import { initMarket } from './market'
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
// Game treasury — where vendor crypto payments go (one address per chain).
// ---------------------------------------------------------------------------

const TREASURY: Partial<Record<ChainId, string>> = {
  blockle: 'block1yyvhau7c2kwy4s60kqrysz6prf2k693kvyx94h9ve4qa8fulwy8q99vvdh',
  ethereum: '0x8f55FbeDb99389aADa2B06f12c9567552C7892F5',
  solana: 'CHxVpuE297p7YLttya8vLrxrfFNKXp8SRk4rfVd48PdM'
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

// --- world (terrain, collision, spawn; also publishes the minimap's
//     surface overlay via world/surface) -------------------------------------

const world = createWorld(scene)
player.pos.copy(world.spawn)

const api: GameAPI = {
  scene,
  camera,
  world,
  player,
  // replaced once the player (and its net client) exists at world entry
  chatSend(msg: string) {
    api.onChat?.(player.name, msg)
  },
  onChat: null
}

// --- UI mount (every overlay module renders into #ui) ------------------------

const uiMount: HTMLElement = (() => {
  const el = document.getElementById('ui')
  if (!el) throw new Error('missing #ui overlay mount')
  return el
})()

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
// AUTH GATE — the title screen owns the boot. The world modules only come up
// on the first 'auth:changed' (account sign-in or offline guest), so the
// save module sees the right blk_token and the character wears the right
// name from frame one.
// ---------------------------------------------------------------------------

initAuth(uiMount)

// --- music director (boot): queues the title theme now — the audio engine
//     holds it until the first user gesture unlocks the AudioContext, so the
//     sign-in click itself starts the music. Volume sliders (persisted at
//     blocklings.vol.music/.sfx) are owned by the engine + HUD AudioManager.
const director = initDirector(api)

// One parchment-pretty frame behind the title while the player signs in.
camera.position.set(player.pos.x + 26, player.pos.y + 31, player.pos.z + 26)
camera.lookAt(player.pos)
updateSun()
renderer.render(scene, camera)

let entered = false
events.on('auth:changed', ({ signedIn, name }) => {
  if (signedIn && name) player.name = name
  if (!entered) {
    entered = true
    if (needsCreator()) {
      // First entry on this device: pick a look, THEN enter — the rig is
      // born wearing it (and the look rides the save from then on).
      showCreator((look) => {
        applyLook(look)
        enterWorld()
      })
    } else {
      enterWorld()
    }
  }
})

// ---------------------------------------------------------------------------
// World entry — the full module boot + every integrator wire.
// ---------------------------------------------------------------------------

function enterWorld(): void {
  // --- player (voxel hero, input, camera follow, presence/chat client) ------

  const hero = createPlayer(scene, world, player, camera)

  // Chat bridge: HUD → net, net → HUD. sendChat locally echoes through
  // onChat itself, so this works identically online and offline.
  api.chatSend = (msg: string) => hero.net.sendChat(msg)
  hero.net.onChat = (from: string, msg: string) => api.onChat?.(from, msg)

  // --- save (FIRST stateful module: loads the envelope, applies player
  //     pos/hp, then late-applies each provider's blob as it registers) ------

  initSave(api)

  // --- items (static catalog + voxel mesh builders) -------------------------

  initItems(api)

  // --- skills (xp/levels + the 312-node skill tree; save providers) ---------

  initSkills(api)

  // Vitality -> max HP. Applied now (after the save loaded skills) and again
  // on every vitality level-up; HP is clamped, and a fresh vitality level
  // tops the new headroom up so leveling feels like a snack, not paperwork.
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

  // --- prestige / mastery (reset a level-99 skill → 1 for a permanent star) -
  //
  // The endgame flex layer on top of skills. It never imports skills/combat/
  // gather directly — the integrator wires the three hooks here:
  //   • read skill levels     → skillsApi.level
  //   • perform the 99 → 1 reset → prestigeResetSkill (guarded to level 99)
  //   • feed the "+xp% in this skill" mastery perk back into skills' incoming-
  //     XP path                → masteryModifier(skill, 'xpBonus')
  // The 'mod' mastery perk is folded into combat/gather/crafting below via
  // masteryBonus(key). No player rig aura hook exists yet, so setAuraSink is
  // intentionally left unwired — the prestige module falls back to dispatching
  // window CustomEvent('blocklings:prestige-aura', {detail:{tier,color}}),
  // which the character rig can listen for when it grows an aura attach point.
  initPrestige(api)
  setSkillLevelSource((s) => skillsApi.level(s))
  setSkillReset((s) => prestigeResetSkill(s))
  setPrestigeXpBonus((s) => masteryModifier(s, 'xpBonus'))

  // A skill-tree view onto the live talents with the summed 'mod' mastery
  // bonus folded straight into every modifier key — handed to gather/crafting
  // (which consume a SkillTreeAPI) so a Mastery 'mod' perk stacks onto the
  // matching talent effect with zero extra plumbing.
  const masteryTree: SkillTreeAPI = {
    ...skillTree,
    modifier: (key) => skillTree.modifier(key) + masteryBonus(key)
  }

  // --- inventory (+ real catalog defs + live 3D item viewer) ----------------

  const inv = initInventory(api)
  inv.setMeshSource((id) => itemsApi.buildMesh(id))
  inv.setDefSource((id) => itemsApi.def(id))

  // Equipment -> character: build the item's voxel mesh and hang it on the
  // rig's attach points whenever a slot changes, plus one pass for loaded
  // gear. The grip style (sword/staff/bow/shield rest poses) reads straight
  // from the catalog def.
  setGripStyleSource((itemId) => itemsApi.def(itemId)?.gripStyle)
  function applyEquipMesh(slot: string, id: string | null): void {
    setEquipmentMesh(slot, id ? itemsApi.buildMesh(id) : null)
  }
  events.on('item:equipped', ({ slot, id }) => applyEquipMesh(slot, id))
  for (const [slot, id] of Object.entries(inv.equipment())) {
    if (id) applyEquipMesh(slot, id)
  }

  // --- minting (the ALL-ITEMS NFT framework; inventory card Mint buttons) ---

  const minting = initMinting(api)
  minting.setWallet(() => wallet)
  minting.setInventory(() => inv)
  inv.setMintHooks({
    open: (id, def) => minting.openForItem(id, def),
    chainsOf: (id) => minting.chainsOf(id),
    bundles: () => minting.bundles()
  })

  // --- upgrading (Anvil of Ascension: UPGRADE +0..+10 / ENCHANT / REFORGE) --
  // Needs the inventory (owned gear + material escrow), the real catalog defs,
  // and the blacksmithing level. Its per-item stat delta (bonusFor) feeds back
  // into inventory.equippedStats via setUpgradeBonus, so a +7 flaming sword hits
  // like one everywhere combat/pets/raids read equippedStats. The anvil prop +
  // its interact anchor are placed by world/index.ts (registerAnvilStation);
  // the module self-detects proximity and drives its own prompt/panel. The
  // 3D viewer is left unlent (the panel shows its flat-color placeholder).
  const upgrading = initUpgrading(api)
  upgrading.setInventory(inv)
  upgrading.setDefSource((id) => itemsApi.def(id))
  upgrading.setSkillLevel((s) => skillsApi.level(s))
  inv.setUpgradeBonus((id, base) => upgrading.bonusFor(id, base))

  // --- quests (29 defs + log panel + tracker; 'quests' save provider) -------

  const quests = initQuests(api)
  initQuestGuide(api) // glowing guide path for the tracked quest/contract

  // --- npcs (15 villagers/vendors; REAL-crypto vendor prices -> treasury) ---

  initNpcs(api)
  setQuestsApi(quests)
  setPay(async (chain, amount) => {
    const to = TREASURY[chain]
    if (!to) return { ok: false, error: `No treasury address for ${chain}.` }
    return wallet.sendOn(chain, to, amount)
  })
  // GOLD rail: server-authoritative spend via the gold module (IAP currency)
  setGoldPay((amount, reason) => spendGold(amount, reason))

  // --- combat (mobs, bosses, loot, specials, tap-to-attack, death flow) -----

  const combat = initCombat(api)
  combat.setStatsSource(() => inv.equippedStats())
  combat.setSkillsSource((s) => skillsApi.level(s))
  combat.setMeshSource((id) => itemsApi.buildMesh(id))
  combat.setDefSource((id) => itemsApi.def(id))
  combat.setEquipmentSource(() => inv.equipment())
  combat.setModifierSource((key) => skillTree.modifier(key) + masteryBonus(key))
  // Combat already folds gear def + the defense skill into `amount` (its
  // internal defenseReduction uses the skills source), so here we just apply
  // the hit and play the hero's hurt flash/knockback.
  combat.setPlayerDamage((amount) => {
    player.hp = Math.max(0, player.hp - amount)
    playerHurt()
  })
  combat.setPlayerDeath((onDown) => playerDie(onDown))
  // Swings: tap/auto-retaliate -> the player module's arm animation -> the
  // strike frame fires onAttack -> combat resolves it. One path, always.
  combat.setAttackTrigger(() => triggerAttack())
  combat.setAutoWalk((t) => setAutoWalk(t))
  combat.setSpecialAnimTrigger((kind, onStrike) => triggerSpecial(kind, onStrike))
  onAttack(() => combat.playerStrike())

  // --- raids (four apex world bosses summoned at far-zone altars) -----------
  // Reuses combat's MobRig for adds, the shared swing path, and the same
  // stat/skill/modifier sources; self-drives its own loop + places its altar
  // props. onPlayerStrike runs IN ADDITION to combat.playerStrike() below.
  const raids = initRaids(api)
  raids.setMobRigSource((species, boss) => {
    const def = SPECIES.find((s) => s.id === species)
    return def ? new MobRig(def, boss) : null // MobRig satisfies MobRigLike structurally
  })
  raids.setStatsSource(() => inv.equippedStats())
  raids.setSkillsSource((s) => skillsApi.level(s))
  raids.setModifierSource((key) => skillTree.modifier(key) + masteryBonus(key))
  raids.setInventory(inv)
  raids.setPlayerDamage((amount) => {
    player.hp = Math.max(0, player.hp - amount)
    playerHurt()
  })
  raids.setPlayerDeath((onDown) => playerDie(onDown))
  raids.setAttackTrigger(() => triggerAttack())
  raids.setPresenceSource(() => [...hero.net.remotes.values()].map((r) => ({ x: r.pos.x, z: r.pos.z })))
  onAttack(() => raids.onPlayerStrike())

  // --- dungeon (Trial of the Deep: repeatable wave-survival arena) ----------
  // Entered from the gate prop it places itself in the Ashen Dungeons region;
  // teleports the player into a self-contained out-of-world voxel room and
  // back. Reuses combat's MobRig, the shared swing path, and the same stat/
  // skill/modifier sources. onPlayerStrike runs IN ADDITION to combat's (the
  // arena room sits far outside the collision/spawn window, so combat ignores
  // it). Self-drives its own loop; emits 'dungeon:cleared' + reuses mob/xp
  // events so music, pets, quests and achievements all react to arena fights.
  const dungeon = initDungeon(api)
  dungeon.setMobRigSource((species, boss) => {
    const def = SPECIES.find((s) => s.id === species)
    return def ? new MobRig(def, boss) : null // MobRig satisfies MobRigLike structurally
  })
  dungeon.setStatsSource(() => inv.equippedStats())
  dungeon.setSkillsSource((s) => skillsApi.level(s))
  dungeon.setModifierSource((key) => skillTree.modifier(key) + masteryBonus(key))
  dungeon.setInventory(inv)
  dungeon.setPlayerDamage((amount) => {
    player.hp = Math.max(0, player.hp - amount)
    playerHurt()
  })
  dungeon.setPlayerDeath((onDown) => playerDie(onDown))
  dungeon.setAttackTrigger(() => triggerAttack())
  onAttack(() => dungeon.onPlayerStrike())

  // --- pets (rare drops, companion AI, collection panel, NFT minting) -------

  const pets = initPets(api)
  pets.setMobMeshSource((species, boss) => {
    const def = SPECIES.find((s) => s.id === species)
    return def ? new MobRig(def, boss) : null // MobRig satisfies PetRig structurally
  })
  pets.setWallet(() => wallet)
  pets.setTargetSource(() => combat.petTarget())
  // The pet deals ~25% of this; mirror combat's base swing at ~1 swing/1.2s.
  pets.setPlayerDpsSource(() => {
    const s = inv.equippedStats()
    const atkLevel = skillsApi.level('attack')
    return ((3 + s.atk + 0.4 * s.str) * (1 + (atkLevel - 1) * 0.04)) / 1.2
  })

  // --- gathering (streamed wilderness zones; reads the equipped tool) -------

  const gather = initGather(api)
  gather.setInventory(inv)
  gather.setSwing(() => triggerAttack())
  gather.setSkillTree(masteryTree)
  // (zone node registration self-runs off gather's 1 Hz residency poll)

  // --- crafting (forge/stove/alchemy/loom stations + recipe panel) ----------

  const crafting = initCrafting(api)
  crafting.setInventory(inv)
  crafting.setSkills(skillsApi)
  crafting.setSkillTree(masteryTree)
  crafting.setDefSource((id) => itemsApi.def(id))

  // --- waystones (attune + teleport network; 'stones' save provider) --------

  const waystones = initWaystones(api)

  // Respawn where you last touched a stone (Village until then), kept fresh
  // on every attune/teleport.
  function syncRespawn(): void {
    const s = waystones.lastUsedStone()
    combat.setRespawnPoint(s.pos.x, s.pos.z, s.name)
  }
  syncRespawn()
  events.on('waystone:attuned', syncRespawn)
  events.on('waystone:traveled', syncRespawn)

  // --- world map + layered minimap (travel taps bridge into waystones) ------

  const worldmap = initWorldmap(api)
  worldmap.setAttuned(waystones.attunedStones())
  worldmap.setRequestTravel((stoneId) => waystones.travelTo(stoneId))

  // --- atmosphere (real-time CST day/night; owns sky/fog/sun from here) -----

  const atmo = initAtmosphere(api)
  atmo.setSkyLights(sun, hemi)
  atmo.setEmissiveMaterials(world.glowMaterials)
  // Every PointLight in the scene at entry is a lantern/campfire (village
  // posts + heart-region camps, all built synchronously in createWorld) —
  // atmosphere ramps them up after sundown from their authored intensity.
  const lanternLights: THREE.PointLight[] = []
  scene.traverse((o) => {
    if ((o as THREE.PointLight).isPointLight) lanternLights.push(o as THREE.PointLight)
  })
  atmo.setLanternLights(lanternLights)
  atmo.setBiomeSource((x, z) => regionOrZoneAt(x, z)?.biome ?? null)

  // --- audio (director music + ambience beds + sfx wiring) ------------------

  // Director: title theme -> biome/night explore songs, combat loop on heat,
  // boss themes, stingers. Rides the atmosphere's shared CST clock.
  director.setHourSource(() => atmo.hourCST())
  director.enterWorld()

  // Ambience: generative biome beds (same clock), water proximity from the
  // surface map (-1 = off-grid open sea).
  const ambience = initAmbience(api)
  ambience.setHourSource(() => atmo.hourCST())
  ambience.setWaterSource((x, z) => {
    const s = surfaceTypeAt(x, z)
    return s === S_RIVER || s === S_BANK || s === -1
  })

  // SFX: event-bus wiring + footsteps. Surface picks the step sound: snow in
  // the frozen biomes, sand on beaches/deserts, cobble on roads/bridges.
  initSfx(api)
  setSurfaceSource((x, z) => {
    const biome = regionOrZoneAt(x, z)?.biome ?? null
    if (biome === 'tundra' || biome === 'glacier') return 'snow'
    const s = surfaceTypeAt(x, z)
    if (s === S_COBBLE || s === S_BRIDGE) return 'cobble'
    if (s === S_SAND || biome === 'desert' || biome === 'beach') return 'sand'
    return 'grass'
  })

  // --- GOLD (IAP-only hard currency; server-authoritative balance chip) -----

  const gold = initGold(api)

  // --- marketplace (gold + 3-chain crypto rails; goods escrow) --------------

  const market = initMarket(api)
  market.setGold(gold)
  market.setWallet(wallet)
  market.setInventory(inv)
  market.setPets({
    list: () => pets.owned(),
    remove: (uid) => pets.remove(uid),
    add: (p) => pets.add(p)
  })
  market.setMeshSource((id) => itemsApi.buildMesh(id))
  market.setPetMeshSource((petId) => pets.buildMesh(petId))
  market.setDefSource((id) => itemsApi.def(id))
  market.setMintedSource(() => minting.mintedItems())
  // NFT LAW: mint state travels on trade — escrow drops the seller's ledger
  // row (uid can't double-list), delivery/restore re-enters it intact.
  market.setMintHooks({
    take: (uid) => minting.takeByUid(uid),
    receive: (inst) => minting.receive(inst)
  })

  // --- wallet (parchment panel + HUD balance-chip hook) ---------------------

  window.blocklingsWallet = wallet
  installAppearanceHook()
  const walletPanel = initWalletUI(uiMount, wallet)

  // --- achievements (45 comedy trophies; glory-only rewards) ----------------
  // Last gameplay module before the HUD: every bus emitter above is live, the
  // save module has long since adopted its 'achv' provider, and its chatSend
  // interceptor wraps the final net-wired api.chatSend. Self-contained —
  // trophy button + toasts mount into #ui on their own CSS-arbitrated slots.
  initAchievements(api)

  // --- HUD (plate, balance chip, settings, chat box, zone banner) -----------

  const hud = createHUD(api, {
    setQuality,
    setAutoRetaliate: (on) => setAutoRetaliate(on),
    setAlwaysDay: (on) => atmo.setAlwaysDay(on)
    // setMinimap + signOut resolve via the window hooks worldmap/auth publish
  })

  // System lines ('chat:system' from every module) land in the HUD chat box.
  events.on('chat:system', ({ text }) => api.onChat?.('System', text))

  // --- region tracking ('region:entered' on every border crossing) ----------

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

  // -------------------------------------------------------------------------
  // Main loop (dt clamped so tab-switches don't teleport anything)
  // -------------------------------------------------------------------------

  let last = performance.now()

  function frame(now: number): void {
    const dt = Math.min((now - last) / 1000, 0.1)
    last = now
    world.update(dt) // water shimmer, window flicker
    hero.update(dt) // movement, net, camera follow
    pollRegion(dt) // 'region:entered' on border crossings (every ~0.5s)
    walletPanel.update(dt)
    hud.update()
    atmo.update(dt) // sun/moon arc + sky/fog/glow ramps (owns the sun now)
    renderer.render(scene, camera)
    requestAnimationFrame(frame)
  }

  requestAnimationFrame(frame)
}
