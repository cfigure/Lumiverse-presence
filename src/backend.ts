// Shared Presence — backend worker.
//
// Keeps a roster of every browser document currently connected under this
// account (each one is a "frontend session" with its own id), tells every
// document who else is online, and announces preset saves so the other editor
// knows to reload before they overwrite anything.

declare const spindle: import('lumiverse-spindle-types').SpindleAPI

type Peer = {
  nickname: string
  editing: string | null   // preset name the peer currently has open, if they told us
  lastSeen: number
}

const STALE_MS = 60_000          // drop a peer if no heartbeat for this long
const PRUNE_EVERY_MS = 15_000

const peers = new Map<string, Peer>()   // frontendSessionId -> Peer
let ownerUserId: string | null = null   // user-scoped extension: always the installer

function roster() {
  return [...peers.entries()].map(([id, p]) => ({
    id,
    nickname: p.nickname,
    editing: p.editing,
    lastSeen: p.lastSeen,
  }))
}

function broadcastRoster() {
  if (!ownerUserId) return
  spindle.sendToFrontend({ type: 'presence_roster', peers: roster() }, ownerUserId)
}

function cleanNickname(value: unknown): string {
  const s = typeof value === 'string' ? value.trim() : ''
  return (s || 'someone').slice(0, 32)
}

spindle.onFrontendMessage((payload: any, userId, frontendSessionId) => {
  if (!frontendSessionId || !payload || typeof payload !== 'object') return
  ownerUserId = userId

  switch (payload.type) {
    case 'presence_hello':
    case 'presence_heartbeat': {
      const prev = peers.get(frontendSessionId)
      const next: Peer = {
        nickname: cleanNickname(payload.nickname),
        editing: typeof payload.editing === 'string' ? payload.editing.slice(0, 80)
               : payload.editing === null ? null
               : prev?.editing ?? null,
        lastSeen: Date.now(),
      }
      peers.set(frontendSessionId, next)

      const changed = !prev || prev.nickname !== next.nickname || prev.editing !== next.editing
      if (!prev) {
        spindle.log.info(`${next.nickname} connected (${frontendSessionId.slice(0, 8)})`)
        // Tell everyone *else*; the newcomer gets the roster below anyway.
        spindle.toast.info(`${next.nickname} is online`, { title: 'Shared Presence', duration: 4000 })
      }
      if (changed || payload.type === 'presence_hello') broadcastRoster()
      break
    }

    case 'presence_bye': {
      const prev = peers.get(frontendSessionId)
      if (peers.delete(frontendSessionId)) {
        spindle.log.info(`${prev?.nickname ?? 'someone'} left (${frontendSessionId.slice(0, 8)})`)
        broadcastRoster()
      }
      break
    }
  }
})

// The host tells us when a document's socket is gone (tab closed, reload, network drop).
spindle.on('FRONTEND_SESSION_CLOSED', (payload: any) => {
  const id = payload?.frontendSessionId
  if (typeof id !== 'string') return
  const prev = peers.get(id)
  if (peers.delete(id)) {
    spindle.log.info(`${prev?.nickname ?? 'someone'} disconnected (${id.slice(0, 8)})`)
    broadcastRoster()
  }
})

// ── Save announcements with a "what changed" summary ────────────────────────
//
// PRESET_CHANGED is documented as { presetId } but the staging server sends
// { id, preset } with the full row, so read both shapes. Blocks live in
// `prompt_order`; sampler/model settings in `parameters`; everything else the
// editor saves (samplerOverrides, promptVariables, …) lands in `metadata`.

type AnyPreset = Record<string, any>
const lastRows = new Map<string, AnyPreset>()   // presetId -> last row we saw

const BLOCK_FIELDS = ['name', 'content', 'role', 'enabled', 'position', 'depth', 'marker', 'group', 'injectionTrigger', 'variables'] as const

function same(a: unknown, b: unknown): boolean {
  try { return JSON.stringify(a) === JSON.stringify(b) } catch { return a === b }
}

function blockLabel(b: AnyPreset): string {
  const name = typeof b?.name === 'string' && b.name.trim() ? b.name.trim() : '(unnamed block)'
  return `'${name.slice(0, 40)}'`
}

/** Human summary of what differs between two saved rows; empty if nothing we track changed. */
function describeChanges(prev: AnyPreset, next: AnyPreset): string[] {
  const out: string[] = []

  const prevBlocks: AnyPreset[] = Array.isArray(prev.prompt_order) ? prev.prompt_order : []
  const nextBlocks: AnyPreset[] = Array.isArray(next.prompt_order) ? next.prompt_order : []
  const prevById = new Map(prevBlocks.map((b) => [String(b.id), b]))
  const nextById = new Map(nextBlocks.map((b) => [String(b.id), b]))

  const edited: string[] = [], added: string[] = [], removed: string[] = []
  for (const [id, b] of nextById) {
    const p = prevById.get(id)
    if (!p) { added.push(blockLabel(b)); continue }
    if (BLOCK_FIELDS.some((f) => !same(p[f], b[f]))) edited.push(blockLabel(b))
  }
  for (const [id, b] of prevById) if (!nextById.has(id)) removed.push(blockLabel(b))

  const prevOrder = prevBlocks.map((b) => String(b.id)).filter((id) => nextById.has(id))
  const nextOrder = nextBlocks.map((b) => String(b.id)).filter((id) => prevById.has(id))
  const reordered = !same(prevOrder, nextOrder)

  const list = (xs: string[]) => xs.length > 3 ? `${xs.slice(0, 3).join(', ')} +${xs.length - 3} more` : xs.join(', ')
  if (edited.length) out.push(`edited ${list(edited)}`)
  if (added.length) out.push(`added ${list(added)}`)
  if (removed.length) out.push(`removed ${list(removed)}`)
  if (reordered) out.push('reordered blocks')

  if (prev.name !== next.name) out.push(`renamed to '${String(next.name).slice(0, 40)}'`)
  if (!same(prev.parameters, next.parameters)) out.push('sampler/model parameters')

  const pm: AnyPreset = prev.metadata ?? {}, nm: AnyPreset = next.metadata ?? {}
  const metaKeys = new Set([...Object.keys(pm), ...Object.keys(nm)])
  const changedMeta = [...metaKeys].filter((k) => !same(pm[k], nm[k]))
  if (changedMeta.length) out.push(changedMeta.slice(0, 4).join(', ') + (changedMeta.length > 4 ? ', …' : ''))

  return out
}

spindle.on('PRESET_CHANGED', (payload: any) => {
  const preset: AnyPreset | null = payload?.preset ?? null
  const presetId: string | undefined = payload?.id ?? payload?.presetId ?? preset?.id
  const name: string = preset?.name ?? 'A preset'
  const revision: number | undefined = preset?.cache_revision

  let summary: string[] = []
  if (preset && presetId) {
    const prev = lastRows.get(presetId)
    if (prev) summary = describeChanges(prev, preset)
    lastRows.set(presetId, preset)
  }

  if (ownerUserId) {
    spindle.sendToFrontend({ type: 'preset_saved', presetId, name, revision, summary }, ownerUserId)
  }
  const rev = typeof revision === 'number' ? ` (rev ${revision})` : ''
  const what = summary.length ? `: ${summary.join('; ')}` : ''
  spindle.toast.info(`${name} saved${rev}${what}. Reload if you have it open.`, {
    title: 'Shared Presence',
    duration: summary.length ? 10000 : 7000,
  })
})

// Drop peers whose heartbeats stopped without a clean close.
setInterval(() => {
  const cutoff = Date.now() - STALE_MS
  let removed = false
  for (const [id, p] of peers) {
    if (p.lastSeen < cutoff) { peers.delete(id); removed = true }
  }
  if (removed) broadcastRoster()
}, PRUNE_EVERY_MS)

spindle.log.info('Shared Presence backend loaded')
