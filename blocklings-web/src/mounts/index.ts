/**
 * Mounts — ultra-rare rideable creatures (+40% move speed). A mount lives in
 * your bag like any item (so it mints as an NFT + sells on the market); this
 * module just tracks which one you're RIDING and toggles the speed buff + the
 * under-player mesh. Mount/dismount is driven from the hotbar for quick access.
 *
 * ECONOMY-SAFE: riding never consumes the item; the mount stays in your bag.
 */
import type * as THREE from 'three'
import type { GameAPI, ItemDef } from '../types'
import { events } from '../events'
import { saveRegistry } from '../save/registry'
import { setMountActive } from '../player/index'

export interface MountsAPI {
  /** Mount this id, or dismount if it's already the active mount. */
  toggle(id: string): void
  dismount(): void
  active(): string | null
  isMount(id: string): boolean
}

let meshSource: ((id: string) => THREE.Group) | null = null
let defSource: ((id: string) => ItemDef | undefined) | null = null
let ownsFn: ((id: string) => boolean) | null = null
let activeId: string | null = null
let inited = false

export function setMountMeshSource(fn: (id: string) => THREE.Group): void {
  meshSource = fn
}
export function setMountDefSource(fn: (id: string) => ItemDef | undefined): void {
  defSource = fn
}
/** Lets the module verify you still own a mount before (re)mounting it. */
export function setMountOwnership(fn: (id: string) => boolean): void {
  ownsFn = fn
}

function isMountId(id: string): boolean {
  return (defSource?.(id)?.slot ?? '') === 'mount'
}

function ride(id: string): void {
  const def = defSource?.(id)
  if (!def || def.slot !== 'mount') return
  const mesh = meshSource?.(id) ?? null
  const speed = Math.max(1.0, def.mountSpeed ?? 1.0) // all mounts: +100% minimum
  setMountActive(true, mesh, speed)
  activeId = id
  events.emit('mount:changed', { id })
  events.emit('chat:system', {
    text: `Mounted your ${def.name} — +${Math.round(speed * 100)}% speed. Giddy up.`
  })
  events.emit('save:dirty', { why: 'mount' })
}

function down(announce: boolean): void {
  if (!activeId) return
  const name = defSource?.(activeId)?.name ?? 'mount'
  setMountActive(false, null, 0)
  activeId = null
  events.emit('mount:changed', { id: null })
  if (announce) events.emit('chat:system', { text: `Dismounted your ${name}. Back on your own two feet.` })
  events.emit('save:dirty', { why: 'mount' })
}

export const mountsApi: MountsAPI = {
  toggle(id: string): void {
    if (!isMountId(id)) return
    if (activeId === id) down(true)
    else ride(id)
  },
  dismount(): void {
    down(true)
  },
  active(): string | null {
    return activeId
  },
  isMount(id: string): boolean {
    return isMountId(id)
  }
}

export function initMounts(api: GameAPI): MountsAPI {
  void api
  if (inited) return mountsApi
  inited = true

  saveRegistry.register('mount', {
    dump: () => activeId,
    load: (d) => {
      const id = typeof d === 'string' ? d : null
      // Only re-mount if the mount is defined AND still owned (not sold/traded).
      if (id && isMountId(id) && (ownsFn?.(id) ?? true)) ride(id)
      else down(false)
    }
  })

  // Lose the ride if the active mount leaves the bag (sold, traded, minted away).
  events.on('item:removed', () => {
    if (activeId && ownsFn && !ownsFn(activeId)) down(true)
  })

  return mountsApi
}
