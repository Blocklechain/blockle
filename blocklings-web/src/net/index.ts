/**
 * Blocklings — realtime multiplayer presence client.
 *
 * Talks to the deployed relay at wss://blockle.org/blocklings/ws
 * (services/blocklings/server.js). The relay is presence-only — the
 * world is deterministic client-side — so the protocol is tiny JSON:
 *
 *   c->s: {t:'join',name}   {t:'pos',x,y,lvl}   {t:'chat',msg}
 *   s->c: {t:'welcome',id,count}  {t:'pos',id,name,x,y,lvl}
 *         {t:'left',id}  {t:'chat',id,name,msg}  {t:'full'}
 *
 * Server coords are 2D: we map world x -> x and world z -> y, and
 * resolve height locally via world.groundHeight (deterministic world).
 *
 * Position updates stream at ~8 Hz. Remote players render as the same
 * voxel character as the local hero with a name-hash tunic hue and a
 * CanvasTexture name label, lerp-smoothed toward their last reported
 * position. Auto-reconnects with capped exponential backoff and is
 * fully silent when offline — single-player keeps working untouched.
 */
import * as THREE from 'three'
import type { PlayerState, World } from '../types'
import { CharacterRig, hueFromName, makeNameSprite } from '../player/character'

/** Deployed relay endpoint. */
export const WS_URL = 'wss://blockle.org/blocklings/ws'

const POS_INTERVAL_MS = 125 // ~8 Hz
const STALE_MS = 45_000 // drop remotes the relay stopped updating (AOI culled)
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15_000] as const

// ---------------------------------------------------------------------------

export interface RemotePlayer {
  id: string
  name: string
  level: number
  /** Smoothed render position (feet, world space). */
  pos: THREE.Vector3
  /** Latest reported position we lerp toward. */
  target: THREE.Vector3
  rig: CharacterRig
  label: THREE.Sprite
  lastSeen: number
  facing: number
}

export interface NetContext {
  scene: THREE.Scene
  world: World
  /** Local player's live state — read for outgoing pos/level. */
  local: PlayerState
}

export interface NetHandle {
  /** True while the socket is open and joined. */
  readonly connected: boolean
  /** Our relay-assigned id (null until welcomed). */
  readonly selfId: string | null
  /** Live remote players, keyed by relay id. */
  readonly remotes: ReadonlyMap<string, RemotePlayer>
  /**
   * Incoming chat callback (from, msg) — invoked for every message to
   * display, including a local echo of our own sends.
   */
  onChat: ((from: string, msg: string) => void) | null
  /** Send a chat line (also locally echoed through onChat). */
  sendChat(msg: string): void
  /** Per-frame: lerp remotes, advance their animations, prune stale. */
  update(dt: number): void
  dispose(): void
}

interface WireMsg {
  t?: string
  id?: string
  name?: string
  msg?: string
  x?: number
  y?: number
  lvl?: number
  count?: number
}

// ---------------------------------------------------------------------------

export function connect(url: string, name: string, ctx: NetContext): NetHandle {
  const remotes = new Map<string, RemotePlayer>()
  let ws: WebSocket | null = null
  let selfId: string | null = null
  let open = false
  let disposed = false
  let attempts = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  const handle: NetHandle = {
    get connected() {
      return open
    },
    get selfId() {
      return selfId
    },
    remotes,
    onChat: null,
    sendChat(msg: string) {
      const text = String(msg).slice(0, 200)
      if (!text) return
      send({ t: 'chat', msg: text })
      // The relay broadcasts to OTHERS only — echo locally so our own
      // line always shows up, online or offline.
      handle.onChat?.(ctx.local.name, text)
    },
    update,
    dispose() {
      disposed = true
      if (reconnectTimer !== null) clearTimeout(reconnectTimer)
      clearInterval(posTimer)
      try {
        ws?.close()
      } catch {
        /* ignore */
      }
      for (const id of [...remotes.keys()]) removeRemote(id)
    }
  }

  function send(obj: Record<string, unknown>): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(obj))
      } catch {
        /* silent */
      }
    }
  }

  // --- remote lifecycle ----------------------------------------------------

  function upsertRemote(m: WireMsg): void {
    const id = m.id
    if (typeof id !== 'string' || typeof m.x !== 'number' || typeof m.y !== 'number') return
    if (id === selfId) return
    const rname = typeof m.name === 'string' && m.name ? m.name : 'wanderer'
    const lvl = typeof m.lvl === 'number' && m.lvl > 0 ? Math.floor(m.lvl) : 1
    const gx = m.x
    const gz = m.y // server y == world z
    const gy = ctx.world.groundHeight(gx, gz)

    let r = remotes.get(id)
    if (!r) {
      const rig = new CharacterRig({ tunicHue: hueFromName(rname) })
      const label = makeNameSprite(`${rname} · Lv ${lvl}`)
      rig.group.add(label)
      rig.group.position.set(gx, gy, gz)
      ctx.scene.add(rig.group)
      r = {
        id,
        name: rname,
        level: lvl,
        pos: new THREE.Vector3(gx, gy, gz),
        target: new THREE.Vector3(gx, gy, gz),
        rig,
        label,
        lastSeen: performance.now(),
        facing: 0
      }
      remotes.set(id, r)
      return
    }
    if (r.name !== rname || r.level !== lvl) {
      // rebuild the label on name/level change
      r.rig.group.remove(r.label)
      r.label.material.map?.dispose()
      r.label.material.dispose()
      r.label = makeNameSprite(`${rname} · Lv ${lvl}`)
      r.rig.group.add(r.label)
      r.name = rname
      r.level = lvl
    }
    r.target.set(gx, gy, gz)
    r.lastSeen = performance.now()
  }

  function removeRemote(id: string): void {
    const r = remotes.get(id)
    if (!r) return
    ctx.scene.remove(r.rig.group)
    r.rig.dispose()
    remotes.delete(id)
  }

  // --- per-frame smoothing -------------------------------------------------

  const delta = new THREE.Vector3()

  function update(dt: number): void {
    const now = performance.now()
    const k = 1 - Math.exp(-dt * 10)
    for (const r of remotes.values()) {
      if (now - r.lastSeen > STALE_MS) {
        removeRemote(r.id)
        continue
      }
      delta.subVectors(r.target, r.pos)
      const dist = delta.length()
      if (dist > 12) {
        r.pos.copy(r.target) // teleport — don't glide across the village
      } else {
        r.pos.addScaledVector(delta, k)
      }
      const moving = dist > 0.08
      if (moving && (delta.x !== 0 || delta.z !== 0)) {
        const want = Math.atan2(delta.x, delta.z)
        let diff = want - r.facing
        while (diff > Math.PI) diff -= Math.PI * 2
        while (diff < -Math.PI) diff += Math.PI * 2
        r.facing += diff * k
      }
      r.rig.group.position.copy(r.pos)
      r.rig.group.rotation.y = r.facing
      r.rig.update(dt, moving, Math.min(1, dist / 0.6))
    }
  }

  // --- socket lifecycle ----------------------------------------------------

  function scheduleReconnect(extraDelay = 0): void {
    if (disposed || reconnectTimer !== null) return
    const base = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)] ?? 15_000
    const delayMs = base + extraDelay + Math.random() * 500
    attempts++
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      openSocket()
    }, delayMs)
  }

  function openSocket(): void {
    if (disposed) return
    let sock: WebSocket
    try {
      sock = new WebSocket(url)
    } catch {
      scheduleReconnect()
      return
    }
    ws = sock

    sock.onopen = () => {
      if (disposed) {
        sock.close()
        return
      }
      open = true
      attempts = 0
      send({ t: 'join', name })
      // announce ourselves immediately so others see us without waiting a tick
      send({ t: 'pos', x: ctx.local.pos.x, y: ctx.local.pos.z, lvl: ctx.local.level })
    }

    sock.onmessage = (ev: MessageEvent) => {
      let m: WireMsg
      try {
        m = JSON.parse(String(ev.data)) as WireMsg
      } catch {
        return
      }
      switch (m.t) {
        case 'welcome':
          if (typeof m.id === 'string') selfId = m.id
          break
        case 'pos':
          upsertRemote(m)
          break
        case 'left':
          if (typeof m.id === 'string') removeRemote(m.id)
          break
        case 'chat':
          if (typeof m.msg === 'string' && m.id !== selfId) {
            handle.onChat?.(typeof m.name === 'string' ? m.name : 'wanderer', m.msg)
          }
          break
        case 'full':
          // server at capacity — try again much later
          try {
            sock.close()
          } catch {
            /* ignore */
          }
          scheduleReconnect(30_000)
          break
      }
    }

    sock.onclose = () => {
      open = false
      selfId = null
      if (ws === sock) ws = null
      for (const id of [...remotes.keys()]) removeRemote(id)
      scheduleReconnect()
    }
    sock.onerror = () => {
      /* silent — onclose follows and handles reconnect */
    }
  }

  // ~8 Hz presence stream (only sends while the socket is open)
  const posTimer = setInterval(() => {
    if (!open) return
    send({ t: 'pos', x: ctx.local.pos.x, y: ctx.local.pos.z, lvl: ctx.local.level })
  }, POS_INTERVAL_MS)

  openSocket()
  return handle
}
