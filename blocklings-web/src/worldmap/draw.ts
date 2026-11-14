/**
 * Canvas drawing helpers shared by the full map panel and the mini-map:
 * seeded wobble (hand-drawn-feel borders), Catmull-Rom smoothing for roads,
 * and the little icon set (waystone, skull, house, castle, player arrow).
 * Everything draws flat shapes with ink outlines — same cozy voxel-era
 * vocabulary as the game, no textures.
 */
import type { Pt } from './data'

/** Deterministic 32-bit seeded rng (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * A region rectangle as a wobbly closed polygon in WORLD coordinates —
 * edges subdivided every ~9 units with a seeded perpendicular jitter so
 * borders read as hand-inked, and stay identical frame to frame.
 */
export function wobblyRect(x0: number, z0: number, x1: number, z1: number, seed: number): Pt[] {
  const r = rng(seed)
  const pts: Pt[] = []
  const corners: Pt[] = [
    { x: x0, z: z0 },
    { x: x1, z: z0 },
    { x: x1, z: z1 },
    { x: x0, z: z1 }
  ]
  for (let c = 0; c < 4; c++) {
    const a = corners[c]!
    const b = corners[(c + 1) % 4]!
    const dx = b.x - a.x
    const dz = b.z - a.z
    const len = Math.hypot(dx, dz)
    const steps = Math.max(2, Math.round(len / 9))
    // unit perpendicular
    const px = -dz / len
    const pz = dx / len
    for (let i = 0; i < steps; i++) {
      const t = i / steps
      const w = i === 0 ? 0 : (r() - 0.5) * 5 // corners stay put
      pts.push({ x: a.x + dx * t + px * w, z: a.z + dz * t + pz * w })
    }
  }
  return pts
}

/** Catmull-Rom spline through waypoints → dense polyline (world coords). */
export function smoothPath(way: ReadonlyArray<readonly [number, number]>, segs = 8): Pt[] {
  if (way.length < 2) return way.map(([x, z]) => ({ x, z }))
  const p = (i: number): readonly [number, number] =>
    way[Math.max(0, Math.min(way.length - 1, i))]!
  const out: Pt[] = []
  for (let i = 0; i < way.length - 1; i++) {
    const p0 = p(i - 1)
    const p1 = p(i)
    const p2 = p(i + 1)
    const p3 = p(i + 2)
    for (let j = 0; j < segs; j++) {
      const t = j / segs
      const t2 = t * t
      const t3 = t2 * t
      out.push({
        x:
          0.5 *
          (2 * p1[0] +
            (-p0[0] + p2[0]) * t +
            (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
            (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        z:
          0.5 *
          (2 * p1[1] +
            (-p0[1] + p2[1]) * t +
            (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
            (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
      })
    }
  }
  const last = way[way.length - 1]!
  out.push({ x: last[0], z: last[1] })
  return out
}

export function tracePoly(ctx: CanvasRenderingContext2D, pts: readonly Pt[], toX: (x: number) => number, toY: (z: number) => number): void {
  ctx.beginPath()
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!
    if (i === 0) ctx.moveTo(toX(p.x), toY(p.z))
    else ctx.lineTo(toX(p.x), toY(p.z))
  }
}

/* ========================= icons (screen-space px) ======================== */

/** Teleport waystone: little obelisk with a gem. Lit = attuned (cyan glow). */
export function drawWaystone(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, lit: boolean): void {
  ctx.save()
  ctx.translate(x, y)
  if (lit) {
    ctx.shadowColor = '#59e0f0'
    ctx.shadowBlur = s * 0.9
  }
  // stone body
  ctx.fillStyle = lit ? '#8fa8b0' : '#6f6f78'
  ctx.strokeStyle = '#2b2b33'
  ctx.lineWidth = Math.max(1, s * 0.12)
  ctx.beginPath()
  ctx.moveTo(-s * 0.32, s * 0.5)
  ctx.lineTo(-s * 0.22, -s * 0.5)
  ctx.lineTo(s * 0.22, -s * 0.5)
  ctx.lineTo(s * 0.32, s * 0.5)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  // gem
  ctx.shadowBlur = 0
  ctx.fillStyle = lit ? '#59e0f0' : '#3e3e46'
  ctx.beginPath()
  ctx.moveTo(0, -s * 0.28)
  ctx.lineTo(s * 0.14, -s * 0.06)
  ctx.lineTo(0, s * 0.16)
  ctx.lineTo(-s * 0.14, -s * 0.06)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

/** Boss skull: round cranium, hollow eyes, tiny teeth. Adorable. Deadly. */
export function drawSkull(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  ctx.save()
  ctx.translate(x, y)
  ctx.fillStyle = '#efe9d8'
  ctx.strokeStyle = '#2b2420'
  ctx.lineWidth = Math.max(1, s * 0.12)
  // cranium
  ctx.beginPath()
  ctx.arc(0, -s * 0.08, s * 0.5, Math.PI * 0.95, Math.PI * 0.05)
  ctx.lineTo(s * 0.34, s * 0.26)
  ctx.lineTo(-s * 0.34, s * 0.26)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  // jaw / teeth
  ctx.fillRect(-s * 0.26, s * 0.26, s * 0.52, s * 0.2)
  ctx.strokeRect(-s * 0.26, s * 0.26, s * 0.52, s * 0.2)
  ctx.strokeStyle = '#2b2420'
  ctx.beginPath()
  ctx.moveTo(-s * 0.08, s * 0.26)
  ctx.lineTo(-s * 0.08, s * 0.46)
  ctx.moveTo(s * 0.08, s * 0.26)
  ctx.lineTo(s * 0.08, s * 0.46)
  ctx.stroke()
  // eyes
  ctx.fillStyle = '#2b2420'
  ctx.beginPath()
  ctx.arc(-s * 0.2, -s * 0.1, s * 0.13, 0, Math.PI * 2)
  ctx.arc(s * 0.2, -s * 0.1, s * 0.13, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/** Village: one green-roofed timber cottage, like home. */
export function drawHouse(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  ctx.save()
  ctx.translate(x, y)
  ctx.strokeStyle = '#2b2420'
  ctx.lineWidth = Math.max(1, s * 0.1)
  ctx.fillStyle = '#d8c9a6' // timber wall
  ctx.fillRect(-s * 0.36, -s * 0.05, s * 0.72, s * 0.5)
  ctx.strokeRect(-s * 0.36, -s * 0.05, s * 0.72, s * 0.5)
  ctx.fillStyle = '#4e8a4a' // the sacred green roof
  ctx.beginPath()
  ctx.moveTo(-s * 0.48, -s * 0.02)
  ctx.lineTo(0, -s * 0.52)
  ctx.lineTo(s * 0.48, -s * 0.02)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  ctx.fillStyle = '#6b4a2e' // door
  ctx.fillRect(-s * 0.1, s * 0.13, s * 0.2, s * 0.32)
  ctx.restore()
}

/** Capital: a three-tower keep. */
export function drawCastle(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  ctx.save()
  ctx.translate(x, y)
  ctx.strokeStyle = '#2b2420'
  ctx.lineWidth = Math.max(1, s * 0.09)
  ctx.fillStyle = '#b8b2a4'
  // wall
  ctx.fillRect(-s * 0.5, -s * 0.1, s, s * 0.55)
  ctx.strokeRect(-s * 0.5, -s * 0.1, s, s * 0.55)
  // towers
  for (const tx of [-s * 0.42, 0, s * 0.42]) {
    const h = tx === 0 ? s * 0.62 : s * 0.42
    ctx.fillRect(tx - s * 0.12, -h, s * 0.24, h)
    ctx.strokeRect(tx - s * 0.12, -h, s * 0.24, h)
    // green cone roofs
    ctx.fillStyle = '#4e8a4a'
    ctx.beginPath()
    ctx.moveTo(tx - s * 0.17, -h)
    ctx.lineTo(tx, -h - s * 0.26)
    ctx.lineTo(tx + s * 0.17, -h)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = '#b8b2a4'
  }
  // gate
  ctx.fillStyle = '#4a3826'
  ctx.beginPath()
  ctx.arc(0, s * 0.45, s * 0.14, Math.PI, 0)
  ctx.lineTo(s * 0.14, s * 0.45)
  ctx.lineTo(-s * 0.14, s * 0.45)
  ctx.fill()
  ctx.restore()
}

/** Player blip: gold-edged arrow pointing along the facing direction. */
export function drawPlayerArrow(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, facing: number): void {
  // facing: yaw radians, 0 = +Z (down-screen on a north-up map), dir=(sin,cos)
  const ang = Math.atan2(Math.cos(facing), Math.sin(facing)) // canvas angle of (dx,dy)
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(ang + Math.PI / 2) // arrow art points "up" pre-rotation
  ctx.fillStyle = '#ffffff'
  ctx.strokeStyle = '#b8860b'
  ctx.lineWidth = Math.max(1, s * 0.22)
  ctx.beginPath()
  ctx.moveTo(0, -s)
  ctx.lineTo(s * 0.7, s * 0.8)
  ctx.lineTo(0, s * 0.35)
  ctx.lineTo(-s * 0.7, s * 0.8)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  ctx.restore()
}
