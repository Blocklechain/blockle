/**
 * Day/night color schedule — keyframed ramps over the CST hour.
 *
 * One table drives everything: sky + fog color, fog distances, the shared
 * directional light (sun by day, moon by night — same light, see index.ts),
 * hemisphere light, star opacity, night-glow multiplier for windows/
 * lanterns/embers, and a 0..1 "night" factor for the fireflies.
 *
 * The 8:00-16:30 daytime row IS the sacred preserved look from main.ts
 * (sky 0x87b7e8, sun 0xfff3d6 @ 1.6, hemi 0xcfe6ff/0x5a6b4a @ 0.9,
 * fog 55/140) — midday must render exactly as the village always has.
 *
 * Evaluation smoothsteps between adjacent keys and writes into a caller-
 * owned AtmoState, so the per-frame path allocates nothing.
 */
import * as THREE from 'three'

/** Everything the atmosphere lerps, as one struct (preallocated). */
export interface AtmoState {
  sky: THREE.Color
  fog: THREE.Color
  fogNear: number
  fogFar: number
  /** The sun/moon directional light. */
  light: THREE.Color
  lightI: number
  hemiSky: THREE.Color
  hemiGround: THREE.Color
  hemiI: number
  /** Star-field opacity 0..1. */
  stars: number
  /** Multiplier on window/lantern/ember glow (1.0 = preserved day look; ramps UP at night). */
  glow: number
  /** 0 = full day, 1 = deep night (drives fireflies). */
  night: number
}

/** A fresh zeroed state (init-time only). */
export function makeState(): AtmoState {
  return {
    sky: new THREE.Color(),
    fog: new THREE.Color(),
    fogNear: 55,
    fogFar: 140,
    light: new THREE.Color(),
    lightI: 1,
    hemiSky: new THREE.Color(),
    hemiGround: new THREE.Color(),
    hemiI: 0.9,
    stars: 0,
    glow: 1.0,
    night: 0
  }
}

interface Key {
  h: number
  sky: THREE.Color
  fog: THREE.Color
  fogNear: number
  fogFar: number
  light: THREE.Color
  lightI: number
  hemiSky: THREE.Color
  hemiGround: THREE.Color
  hemiI: number
  stars: number
  glow: number
  night: number
}

function key(
  h: number,
  sky: number,
  fog: number,
  fogNear: number,
  fogFar: number,
  light: number,
  lightI: number,
  hemiSky: number,
  hemiGround: number,
  hemiI: number,
  stars: number,
  glow: number,
  night: number
): Key {
  return {
    h,
    sky: new THREE.Color(sky),
    fog: new THREE.Color(fog),
    fogNear,
    fogFar,
    light: new THREE.Color(light),
    lightI,
    hemiSky: new THREE.Color(hemiSky),
    hemiGround: new THREE.Color(hemiGround),
    hemiI,
    stars,
    glow,
    night
  }
}

/**
 * THE SCHEDULE (CST):
 *   0:00-5:00   deep night — near-black indigo sky, full stars, blue moonlight
 *   5:00-5:50   moonset — light dips to nothing on the west horizon
 *   5:50-6:40   pre-dawn → pale dawn — washed lavender-pink creeps in
 *   6:40-8:00   dawn → morning — ramps up to the sacred day look
 *   8:00-16:30  day — preserved village palette, windows barely glow
 *  16:30-18:10  golden hour — warm amber light, sun low, long soft shadows
 *  18:10-19:10  sunset — rose sky, lanterns waking up
 *  19:10-19:40  sundown dip — light fades out before the moon takes over
 *  19:40-20:40  nightfall — stars finish fading in, full lantern glow
 *  20:40-24:00  deep night
 */
const KEYS: readonly Key[] = [
  //    h     sky       fog      fogN fogF  light    lI    hemiSky  hemiGnd  hI    stars glow  night
  key(0.0, 0x0a0e22, 0x0a0e22, 38, 105, 0x9db4ff, 0.38, 0x1c2742, 0x11141f, 0.34, 1.0, 1.6, 1.0),
  key(5.0, 0x0a0e22, 0x0a0e22, 38, 105, 0x9db4ff, 0.38, 0x1c2742, 0x11141f, 0.34, 1.0, 1.6, 1.0),
  key(5.8, 0x141a33, 0x141a33, 40, 110, 0x9db4ff, 0.10, 0x232c4a, 0x151827, 0.38, 0.8, 1.55, 1.0),
  key(6.6, 0xd9c6cf, 0xd9c6cf, 48, 125, 0xffd9b8, 0.75, 0xe9d9df, 0x6a6258, 0.55, 0.1, 1.2, 0.35),
  key(8.0, 0x87b7e8, 0x87b7e8, 55, 140, 0xfff3d6, 1.6, 0xcfe6ff, 0x5a6b4a, 0.9, 0.0, 1.0, 0.0),
  key(16.5, 0x87b7e8, 0x87b7e8, 55, 140, 0xfff3d6, 1.6, 0xcfe6ff, 0x5a6b4a, 0.9, 0.0, 1.0, 0.0),
  key(18.2, 0xf0b974, 0xe9ac67, 52, 135, 0xffc66e, 1.35, 0xffdca6, 0x77644a, 0.72, 0.0, 1.1, 0.05),
  key(19.1, 0x8c5a71, 0x8c5a71, 46, 120, 0xff9d5c, 0.45, 0x7a5570, 0x33293f, 0.5, 0.25, 1.3, 0.55),
  key(19.6, 0x2c2747, 0x2c2747, 42, 112, 0x9db4ff, 0.12, 0x2c3352, 0x191c2b, 0.4, 0.6, 1.5, 0.9),
  key(20.6, 0x0a0e22, 0x0a0e22, 38, 105, 0x9db4ff, 0.38, 0x1c2742, 0x11141f, 0.34, 1.0, 1.6, 1.0),
  // wrap sentinel — same values as 0:00 so the 20:40→24:00 segment holds.
  key(24.0, 0x0a0e22, 0x0a0e22, 38, 105, 0x9db4ff, 0.38, 0x1c2742, 0x11141f, 0.34, 1.0, 1.6, 1.0)
]

/** The hour the accessibility 'always day' mode pins the sky to. */
export const ALWAYS_DAY_HOUR = 13

function smooth(t: number): number {
  return t * t * (3 - 2 * t)
}

/** Evaluate the schedule at CST hour `h` into `out`. Allocation-free. */
export function evalRamp(h: number, out: AtmoState): void {
  let a = KEYS[0]!
  let b = KEYS[KEYS.length - 1]!
  for (let i = 1; i < KEYS.length; i++) {
    const k = KEYS[i]!
    if (k.h >= h) {
      a = KEYS[i - 1]!
      b = k
      break
    }
  }
  const span = b.h - a.h
  const t = span > 0 ? smooth(Math.min(1, Math.max(0, (h - a.h) / span))) : 0

  out.sky.lerpColors(a.sky, b.sky, t)
  out.fog.lerpColors(a.fog, b.fog, t)
  out.fogNear = a.fogNear + (b.fogNear - a.fogNear) * t
  out.fogFar = a.fogFar + (b.fogFar - a.fogFar) * t
  out.light.lerpColors(a.light, b.light, t)
  out.lightI = a.lightI + (b.lightI - a.lightI) * t
  out.hemiSky.lerpColors(a.hemiSky, b.hemiSky, t)
  out.hemiGround.lerpColors(a.hemiGround, b.hemiGround, t)
  out.hemiI = a.hemiI + (b.hemiI - a.hemiI) * t
  out.stars = a.stars + (b.stars - a.stars) * t
  out.glow = a.glow + (b.glow - a.glow) * t
  out.night = a.night + (b.night - a.night) * t
}

/** Human-readable phase name for the current hour (HUD/debug flavor). */
export function phaseName(h: number): string {
  if (h < 5) return 'deep night'
  if (h < 5.8) return 'moonset'
  if (h < 6.6) return 'pale dawn'
  if (h < 8) return 'morning'
  if (h < 16.5) return 'day'
  if (h < 18.2) return 'golden hour'
  if (h < 19.1) return 'sunset'
  if (h < 19.6) return 'sundown'
  if (h < 20.6) return 'nightfall'
  return 'deep night'
}
