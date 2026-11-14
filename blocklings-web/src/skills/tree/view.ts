/**
 * Blocklings skill trees — full-screen tree view.
 *
 * Opened from a row in the skills panel. One pannable canvas graph per
 * skill: edges (requirement + visual), node states (locked / available /
 * chosen / auto-granted), name labels, a point counter, and a bottom detail
 * card with a two-tap confirm Choose button. Touch + mouse; DPR-aware.
 */
import { skillTreeApi, chooseBlocker, effectLabel, type TreeNodeDef } from './core'
import { treeNodes } from './data'
import './tree.css'

const CELL_X = 128
const CELL_Y = 104
const PAD = 90
const R = 23

interface Pt {
  x: number
  y: number
}

function nodePos(n: TreeNodeDef): Pt {
  return { x: PAD + n.x * CELL_X, y: PAD + n.y * CELL_Y }
}

type NodeState = 'chosen' | 'auto' | 'available' | 'locked'

function stateOf(n: TreeNodeDef, chosen: ReadonlySet<string>): NodeState {
  if (chosen.has(n.id)) return n.kind === 'auto' ? 'auto' : 'chosen'
  if (n.kind !== 'auto' && skillTreeApi.canChoose(n.id)) return 'available'
  return 'locked'
}

const STATE_FILL: Record<NodeState, string> = {
  chosen: '#d4af37',
  auto: '#6f5d2a',
  available: '#2a2416',
  locked: '#181a21'
}
const STATE_EDGE: Record<NodeState, string> = {
  chosen: '#ffe9a6',
  auto: '#c9b36a',
  available: '#e8c15a',
  locked: '#3a3d47'
}
const STATE_TEXT: Record<NodeState, string> = {
  chosen: '#1c1405',
  auto: '#f2e7c0',
  available: '#e8c15a',
  locked: '#6a6d78'
}

const KIND_GLYPH: Record<TreeNodeDef['kind'], string> = {
  auto: '◆',
  perk: '●',
  capstone: '★'
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export interface TreeViewDeps {
  level(skill: string): number
}

let current: { destroy(): void; refresh(): void; skill: string } | null = null

/** Repaint the open tree view (if any) — call on level-up etc. */
export function refreshTreeView(): void {
  current?.refresh()
}

export function openTreeView(skill: string, deps: TreeViewDeps): void {
  current?.destroy()

  const uiMount = document.getElementById('ui')
  if (!uiMount) return
  const nodes = treeNodes(skill)
  if (nodes.length === 0) return

  const root = el('div', 'bl-tree-root')

  // ---- header -------------------------------------------------------------
  const head = el('div', 'bl-tree-head')
  const backBtn = el('button', 'bl-tree-back', '‹ Back')
  backBtn.type = 'button'
  const title = el('div', 'bl-tree-title')
  title.appendChild(el('span', 'bl-tree-title-skill', cap(skill)))
  const lvlBadge = el('span', 'bl-tree-title-lvl', '')
  title.appendChild(lvlBadge)
  const ptsWrap = el('div', 'bl-tree-points')
  const ptsNum = el('span', 'bl-tree-points-num', '0')
  ptsWrap.appendChild(ptsNum)
  ptsWrap.appendChild(el('span', 'bl-tree-points-label', 'perk points'))
  head.appendChild(backBtn)
  head.appendChild(title)
  head.appendChild(ptsWrap)
  root.appendChild(head)

  // ---- canvas -------------------------------------------------------------
  const canvasWrap = el('div', 'bl-tree-canvas-wrap')
  const canvas = document.createElement('canvas')
  canvas.className = 'bl-tree-canvas'
  canvasWrap.appendChild(canvas)
  root.appendChild(canvasWrap)

  const hint = el('div', 'bl-tree-hint', 'drag to pan · tap a node')
  canvasWrap.appendChild(hint)

  // ---- detail card --------------------------------------------------------
  const card = el('div', 'bl-tree-card')
  card.style.display = 'none'
  const cardName = el('div', 'bl-tree-card-name')
  const cardMeta = el('div', 'bl-tree-card-meta')
  const cardDesc = el('div', 'bl-tree-card-desc')
  const cardFx = el('div', 'bl-tree-card-fx')
  const cardBlock = el('div', 'bl-tree-card-block')
  const chooseBtn = el('button', 'bl-tree-choose', 'Choose')
  chooseBtn.type = 'button'
  card.appendChild(cardName)
  card.appendChild(cardMeta)
  card.appendChild(cardDesc)
  card.appendChild(cardFx)
  card.appendChild(cardBlock)
  card.appendChild(chooseBtn)
  root.appendChild(card)

  // ---- state --------------------------------------------------------------
  let panX = 0
  let panY = 0
  let selected: TreeNodeDef | null = null
  let armed = false // two-tap confirm
  let raf = 0

  // content bounds (for pan clamping)
  let maxX = 0
  let maxY = 0
  for (const n of nodes) {
    const p = nodePos(n)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }

  function clampPan(): void {
    const w = canvasWrap.clientWidth
    const h = canvasWrap.clientHeight
    const minPanX = Math.min(0, w - (maxX + PAD))
    const minPanY = Math.min(0, h - (maxY + PAD + 60))
    panX = Math.max(minPanX, Math.min(40, panX))
    panY = Math.max(minPanY, Math.min(40, panY))
  }

  // ---- drawing ------------------------------------------------------------
  function draw(): void {
    raf = 0
    const w = canvasWrap.clientWidth
    const h = canvasWrap.clientHeight
    if (w === 0 || h === 0) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr
      canvas.height = h * dpr
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.save()
    ctx.translate(panX, panY)

    const chosen = new Set(skillTreeApi.chosen())

    // edges
    ctx.lineWidth = 2
    for (const n of nodes) {
      const to = nodePos(n)
      const parents: { id: string; hard: boolean }[] = []
      for (const r of n.requires) parents.push({ id: r, hard: true })
      if (n.vis) parents.push({ id: n.vis, hard: false })
      for (const p of parents) {
        const from = nodes.find((m) => m.id === p.id)
        if (!from) continue
        const fp = nodePos(from)
        const lit = chosen.has(n.id) && chosen.has(from.id)
        ctx.strokeStyle = lit ? 'rgba(212,175,55,0.75)' : 'rgba(120,125,140,0.28)'
        ctx.setLineDash(p.hard ? [] : [4, 5])
        ctx.beginPath()
        ctx.moveTo(fp.x, fp.y)
        const mx = (fp.x + to.x) / 2
        ctx.bezierCurveTo(mx, fp.y, mx, to.y, to.x, to.y)
        ctx.stroke()
      }
    }
    ctx.setLineDash([])

    // nodes
    for (const n of nodes) {
      const p = nodePos(n)
      const st = stateOf(n, chosen)
      const r = n.kind === 'capstone' ? R + 5 : n.kind === 'auto' ? R - 3 : R
      const isSel = selected?.id === n.id

      ctx.beginPath()
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
      ctx.fillStyle = STATE_FILL[st]
      ctx.fill()
      ctx.lineWidth = isSel ? 3.5 : st === 'available' ? 2.5 : 2
      ctx.strokeStyle = isSel ? '#ffffff' : STATE_EDGE[st]
      ctx.stroke()

      // glyph
      ctx.fillStyle = STATE_TEXT[st]
      ctx.font = `${n.kind === 'capstone' ? 17 : 13}px 'Trebuchet MS', sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      if (st === 'locked') {
        ctx.font = "10px 'Trebuchet MS', sans-serif"
        ctx.fillText(`Lv${n.lvlReq}`, p.x, p.y)
      } else {
        ctx.fillText(KIND_GLYPH[n.kind], p.x, p.y)
      }

      // label
      ctx.font = "10px 'Trebuchet MS', sans-serif"
      ctx.fillStyle = st === 'locked' ? 'rgba(165,168,180,0.55)' : '#efe9d8'
      const label = n.name.length > 18 ? `${n.name.slice(0, 17)}…` : n.name
      ctx.fillText(label, p.x, p.y + r + 12)
    }
    ctx.restore()
  }

  function requestDraw(): void {
    if (!raf) raf = requestAnimationFrame(draw)
  }

  // ---- detail card --------------------------------------------------------
  function showCard(n: TreeNodeDef | null): void {
    selected = n
    armed = false
    if (!n) {
      card.style.display = 'none'
      requestDraw()
      return
    }
    card.style.display = ''
    cardName.textContent = n.name
    const kindLabel =
      n.kind === 'auto' ? 'automatic' : n.kind === 'capstone' ? 'capstone' : 'perk'
    cardMeta.textContent = `${kindLabel} · ${cap(n.skill)} Lv ${n.lvlReq}${
      n.kind !== 'auto' ? ' · 1 point' : ''
    }`
    cardDesc.textContent = n.desc
    cardFx.textContent = Object.entries(n.effects)
      .map(([k, v]) => effectLabel(k, v))
      .join('  ·  ')

    const chosen = new Set(skillTreeApi.chosen())
    const taken = chosen.has(n.id)
    const blocker = chooseBlocker(n.id)
    if (taken) {
      cardBlock.textContent = n.kind === 'auto' ? 'granted automatically' : 'chosen'
      chooseBtn.style.display = 'none'
    } else if (n.kind === 'auto') {
      cardBlock.textContent = `granted free at ${cap(n.skill)} level ${n.lvlReq}`
      chooseBtn.style.display = 'none'
    } else if (blocker !== '') {
      cardBlock.textContent = blocker
      chooseBtn.style.display = 'none'
    } else {
      cardBlock.textContent = ''
      chooseBtn.style.display = ''
      chooseBtn.textContent = 'Choose'
      chooseBtn.classList.remove('bl-tree-choose-armed')
    }
    requestDraw()
  }

  chooseBtn.addEventListener('click', () => {
    if (!selected) return
    if (!armed) {
      armed = true
      chooseBtn.textContent = 'Confirm — this is permanent'
      chooseBtn.classList.add('bl-tree-choose-armed')
      return
    }
    if (skillTreeApi.choose(selected.id)) {
      refresh()
      showCard(selected)
    } else {
      showCard(selected) // re-render the (new) blocker
    }
  })

  // ---- input: pan + tap ---------------------------------------------------
  let dragging = false
  let moved = false
  let lastX = 0
  let lastY = 0

  canvas.addEventListener('pointerdown', (e) => {
    dragging = true
    moved = false
    lastX = e.clientX
    lastY = e.clientY
    canvas.setPointerCapture(e.pointerId)
  })
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return
    const dx = e.clientX - lastX
    const dy = e.clientY - lastY
    if (Math.abs(dx) + Math.abs(dy) > 0) {
      if (Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY) > 4) moved = true
      panX += dx
      panY += dy
      clampPan()
      lastX = e.clientX
      lastY = e.clientY
      requestDraw()
    }
  })
  canvas.addEventListener('pointerup', (e) => {
    dragging = false
    if (moved) return
    // tap: hit-test
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left - panX
    const y = e.clientY - rect.top - panY
    let hit: TreeNodeDef | null = null
    let best = Infinity
    for (const n of nodes) {
      const p = nodePos(n)
      const d = Math.hypot(p.x - x, p.y - y)
      if (d < R + 14 && d < best) {
        best = d
        hit = n
      }
    }
    showCard(hit)
  })
  canvas.addEventListener('pointercancel', () => {
    dragging = false
  })
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault()
    panX -= e.deltaX
    panY -= e.deltaY
    clampPan()
    requestDraw()
  }, { passive: false })

  // ---- refresh / lifecycle ------------------------------------------------
  function refresh(): void {
    ptsNum.textContent = String(skillTreeApi.points())
    lvlBadge.textContent = `Lv ${deps.level(skill)}`
    clampPan()
    requestDraw()
  }

  const onResize = (): void => {
    clampPan()
    requestDraw()
  }
  window.addEventListener('resize', onResize)

  function destroy(): void {
    window.removeEventListener('resize', onResize)
    if (raf) cancelAnimationFrame(raf)
    root.remove()
    if (current?.skill === skill) current = null
  }
  backBtn.addEventListener('click', destroy)

  uiMount.appendChild(root)

  // center the spine vertically on open
  panY = Math.max(0, (canvasWrap.clientHeight - (maxY + PAD)) / 2)
  clampPan()
  refresh()

  current = { destroy, refresh, skill }
}
