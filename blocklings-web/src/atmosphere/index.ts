/**
 * ATMOSPHERE — real-time CST day/night for the whole world.
 *
 * The sky runs on America/Chicago wall-clock time (one shared world clock —
 * every player sees the same sky), driving:
 *   - a continuous sun/moon arc on ONE directional light (sun by day, blue
 *     moon by night; the handoff happens at the horizon where intensity dips
 *     to nothing, so the swap is invisible),
 *   - sky / fog / hemisphere color ramps (pale dawn 6:00-8:00, blue day,
 *     golden hour before sunset with long warm shadows, deep night),
 *   - a star-field Points dome that fades in at dusk,
 *   - night FX: window/lantern/ember glow ramps UP after sundown (daytime
 *     keeps the preserved village look exactly), fireflies in forest/swamp/
 *     cherry biomes at night,
 *   - an 'always day' accessibility toggle (persisted) that glides the sky
 *     to a fixed afternoon.
 *
 * Everything lerps smoothly (exponential damping on every applied value) and
 * the per-frame path performs zero allocations.
 *
 * INTEGRATOR WIRING (main.ts):
 *   const atmo = initAtmosphere(api)
 *   atmo.setSkyLights(sun, hemi)                 // main's existing lights
 *   atmo.setEmissiveMaterials([windowMat])        // world's shared glow mat(s)
 *   atmo.setLanternLights(lanternPointLights)     // village lantern lights
 *   atmo.setBiomeSource((x, z) => regionOrZoneAt(x, z)?.biome ?? null)
 *   // in the frame loop: atmo.update(dt) AFTER world.update(dt) (the window
 *   // flicker writes absolute emissiveIntensity; atmosphere scales the
 *   // emissive COLOR, and owns sun positioning — drop main's updateSun()).
 */
import * as THREE from 'three'
import type { GameAPI } from '../types'
import { CstClock } from './clock'
import { makeState, evalRamp, phaseName, ALWAYS_DAY_HOUR, type AtmoState } from './ramp'
import { StarField } from './stars'
import { Fireflies } from './fireflies'

declare global {
  interface Window {
    /** Accessibility hook the HUD settings 'always day' toggle calls. */
    blocklingsSetAlwaysDay?: (on: boolean) => void
  }
}

/** Biomes that host fireflies at night. */
const FIREFLY_BIOMES: ReadonlySet<string> = new Set(['forest', 'swamp', 'cherry'])

/** localStorage key for the accessibility toggle. */
const ALWAYS_DAY_KEY = 'blocklings_always_day'

/** Sun above the horizon between these CST hours (geometry, not light). */
const SUNRISE = 5.8
const SUNSET = 19.5
/** Distance of the directional light from the player anchor. */
const LIGHT_DIST = 46

export interface AtmosphereAPI {
  /** Per-frame tick. Call AFTER world.update(dt), before render. */
  update(dt: number): void
  /** Accessibility: pin the sky to a fixed sunny afternoon. Persisted. */
  setAlwaysDay(on: boolean): void
  isAlwaysDay(): boolean
  /** Current CST hour of day in [0, 24) (the shared world clock). */
  hourCST(): number
  /** Human-readable phase name ('golden hour', 'deep night', ...). */
  phase(): string

  /** Wire main's existing sun DirectionalLight + HemisphereLight. */
  setSkyLights(sun: THREE.DirectionalLight, hemi: THREE.HemisphereLight): void
  /**
   * Wire the world's shared glow materials (windows / embers / crystals).
   * Atmosphere scales each material's emissive COLOR from its registration-
   * time base, so the world's own emissiveIntensity flicker keeps working.
   */
  setEmissiveMaterials(mats: readonly THREE.MeshLambertMaterial[]): void
  /** Wire the village lantern PointLights; intensity ramps up at night. */
  setLanternLights(lights: readonly THREE.PointLight[]): void
  /** Wire a biome lookup (world's regionOrZoneAt) for the fireflies. */
  setBiomeSource(fn: (x: number, z: number) => string | null): void
}

export function initAtmosphere(api: GameAPI): AtmosphereAPI {
  const clock = new CstClock()

  // --- take ownership of the scene's sky + fog (mutated in place forever) ---
  const skyColor = new THREE.Color(0x87b7e8)
  api.scene.background = skyColor
  const fog = new THREE.Fog(0x87b7e8, 55, 140)
  api.scene.fog = fog

  // --- wired hooks ----------------------------------------------------------
  let sun: THREE.DirectionalLight | null = null
  let hemi: THREE.HemisphereLight | null = null
  let biomeAt: ((x: number, z: number) => string | null) | null = null
  const glowMats: { mat: THREE.MeshLambertMaterial; base: THREE.Color }[] = []
  const lanterns: { light: THREE.PointLight; base: number }[] = []

  // --- FX -------------------------------------------------------------------
  const stars = new StarField(api.scene)
  const fireflies = new Fireflies(api.scene, api.world)

  // --- state (target = ramp output, applied = smoothed, both preallocated) --
  const target: AtmoState = makeState()
  const applied: AtmoState = makeState()
  evalRamp(ALWAYS_DAY_HOUR, target) // sane colors on frame one
  evalRamp(ALWAYS_DAY_HOUR, applied)

  const targetOffset = new THREE.Vector3(24, 38, 18)
  const smoothOffset = new THREE.Vector3(24, 38, 18)

  let alwaysDay = false
  try {
    alwaysDay = localStorage.getItem(ALWAYS_DAY_KEY) === '1'
  } catch {
    /* storage unavailable — default to the real sky */
  }

  // --- firefly biome poll (1.25 Hz, not per-frame) --------------------------
  let biomePollT = 99
  let inFireflyBiome = false

  function lightArcOffset(h: number, out: THREE.Vector3): void {
    // One light plays both roles: sun arc by day, moon arc by night, each a
    // half-circle east -> overhead(-ish, biased south) -> west.
    let t: number
    if (h >= SUNRISE && h <= SUNSET) {
      t = (h - SUNRISE) / (SUNSET - SUNRISE)
    } else {
      const hn = h < SUNRISE ? h + 24 : h
      t = (hn - SUNSET) / (24 - (SUNSET - SUNRISE))
    }
    const a = Math.PI * Math.min(1, Math.max(0, t))
    out.set(Math.cos(a), 0.22 + 1.1 * Math.sin(a), 0.45)
    out.normalize().multiplyScalar(LIGHT_DIST)
  }

  function update(dt: number): void {
    clock.update(dt)
    const h = alwaysDay ? ALWAYS_DAY_HOUR : clock.hour()

    // 1) schedule -> target, then damp applied toward it. The damping also
    //    makes the always-day toggle and clock resyncs glide, never pop.
    evalRamp(h, target)
    const k = 1 - Math.exp(-dt * 2.5)
    applied.sky.lerp(target.sky, k)
    applied.fog.lerp(target.fog, k)
    applied.fogNear += (target.fogNear - applied.fogNear) * k
    applied.fogFar += (target.fogFar - applied.fogFar) * k
    applied.light.lerp(target.light, k)
    applied.lightI += (target.lightI - applied.lightI) * k
    applied.hemiSky.lerp(target.hemiSky, k)
    applied.hemiGround.lerp(target.hemiGround, k)
    applied.hemiI += (target.hemiI - applied.hemiI) * k
    applied.stars += (target.stars - applied.stars) * k
    applied.glow += (target.glow - applied.glow) * k
    applied.night += (target.night - applied.night) * k

    // 2) sky + fog
    skyColor.copy(applied.sky)
    fog.color.copy(applied.fog)
    fog.near = applied.fogNear
    fog.far = applied.fogFar

    // 3) sun/moon directional arc, anchored on the player so the shadow
    //    frustum stays centred on the action.
    if (sun) {
      lightArcOffset(h, targetOffset)
      smoothOffset.lerp(targetOffset, k)
      const p = api.player.pos
      sun.position.set(p.x + smoothOffset.x, p.y + smoothOffset.y, p.z + smoothOffset.z)
      sun.target.position.copy(p)
      sun.color.copy(applied.light)
      sun.intensity = applied.lightI
    }
    if (hemi) {
      hemi.color.copy(applied.hemiSky)
      hemi.groundColor.copy(applied.hemiGround)
      hemi.intensity = applied.hemiI
    }

    // 4) stars
    stars.update(api.player.pos, applied.stars)

    // 5) night glow — emissive COLOR scaled from each material's base, so the
    //    world's own emissiveIntensity flicker stays intact on top.
    for (let i = 0; i < glowMats.length; i++) {
      const g = glowMats[i]!
      g.mat.emissive.copy(g.base).multiplyScalar(applied.glow)
    }
    for (let i = 0; i < lanterns.length; i++) {
      const l = lanterns[i]!
      l.light.intensity = l.base * applied.glow
    }

    // 6) fireflies (biome polled at 1.25 Hz)
    biomePollT += dt
    if (biomePollT > 0.8) {
      biomePollT = 0
      const b = biomeAt ? biomeAt(api.player.pos.x, api.player.pos.z) : null
      inFireflyBiome = b !== null && FIREFLY_BIOMES.has(b)
    }
    fireflies.update(api.player.pos, inFireflyBiome && applied.night > 0.6, dt)
  }

  function setAlwaysDay(on: boolean): void {
    alwaysDay = on
    try {
      localStorage.setItem(ALWAYS_DAY_KEY, on ? '1' : '0')
    } catch {
      /* non-persistent is fine */
    }
  }

  const atmo: AtmosphereAPI = {
    update,
    setAlwaysDay,
    isAlwaysDay: () => alwaysDay,
    hourCST: () => clock.hour(),
    phase: () => (alwaysDay ? phaseName(ALWAYS_DAY_HOUR) : phaseName(clock.hour())),

    setSkyLights(s, hm) {
      sun = s
      hemi = hm
      smoothOffset.copy(s.position).sub(api.player.pos)
    },
    setEmissiveMaterials(mats) {
      glowMats.length = 0
      for (const mat of mats) glowMats.push({ mat, base: mat.emissive.clone() })
    },
    setLanternLights(lights) {
      lanterns.length = 0
      for (const light of lights) lanterns.push({ light, base: light.intensity })
    },
    setBiomeSource(fn) {
      biomeAt = fn
    }
  }

  // Accessibility hook for the HUD settings toggle.
  window.blocklingsSetAlwaysDay = setAlwaysDay

  return atmo
}
