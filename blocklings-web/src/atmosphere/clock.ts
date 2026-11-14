/**
 * Shared world clock — REAL time of day in America/Chicago (CST/CDT).
 *
 * Every player on Earth sees the same sky because the sky follows one
 * timezone, not the device's. We resync against Intl.DateTimeFormat once a
 * minute (cheap, handles DST flips) and advance with Date.now() in between,
 * so the per-frame path allocates nothing.
 */

export class CstClock {
  private readonly fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })

  /** CST hour-of-day at the last sync (fractional). */
  private baseHour = 12
  /** Date.now() at the last sync. */
  private baseMs = 0
  /** Seconds since the last sync. */
  private sinceSync = Infinity

  /** Advance the resync timer; call once per frame. */
  update(dt: number): void {
    this.sinceSync += dt
    if (this.sinceSync > 60) this.sync()
  }

  /** Current CST hour of day in [0, 24). Allocation-free. */
  hour(): number {
    const h = this.baseHour + (Date.now() - this.baseMs) / 3_600_000
    return ((h % 24) + 24) % 24
  }

  /** Re-read the real America/Chicago wall clock. */
  private sync(): void {
    let h = 12
    let m = 0
    let s = 0
    try {
      for (const part of this.fmt.formatToParts(new Date())) {
        if (part.type === 'hour') h = parseInt(part.value, 10)
        else if (part.type === 'minute') m = parseInt(part.value, 10)
        else if (part.type === 'second') s = parseInt(part.value, 10)
      }
    } catch {
      // Intl hiccup (shouldn't happen in the iOS shell) — keep extrapolating.
    }
    // Some engines report midnight as "24".
    this.baseHour = (h % 24) + m / 60 + s / 3600
    this.baseMs = Date.now()
    this.sinceSync = 0
  }
}
