/**
 * Tiny WebAudio blips for the waystones — no assets, just two short
 * sine-arpeggio chimes (attune ping + arrival chime). Context is created
 * lazily and failures are swallowed (audio is garnish, not gameplay).
 */

let ctx: AudioContext | null = null

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch {
    return null
  }
}

function blip(ac: AudioContext, freq: number, at: number, dur: number, peak: number): void {
  const osc = ac.createOscillator()
  const gain = ac.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq
  gain.gain.setValueAtTime(0.0001, at)
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur)
  osc.connect(gain)
  gain.connect(ac.destination)
  osc.start(at)
  osc.stop(at + dur + 0.05)
}

/** Soft two-note ping when a stone attunes. */
export function playAttuneChime(): void {
  const ac = audio()
  if (!ac) return
  const t = ac.currentTime + 0.01
  blip(ac, 523.25, t, 0.28, 0.06) // C5
  blip(ac, 784.0, t + 0.09, 0.34, 0.055) // G5
}

/** Rising three-note arrival chime after a teleport. */
export function playArrivalChime(): void {
  const ac = audio()
  if (!ac) return
  const t = ac.currentTime + 0.01
  blip(ac, 659.25, t, 0.22, 0.055) // E5
  blip(ac, 987.77, t + 0.08, 0.22, 0.05) // B5
  blip(ac, 1318.5, t + 0.16, 0.3, 0.045) // E6
}
