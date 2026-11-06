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

// A preset was saved by *someone* on this account. The payload is documented as
// { presetId } but the staging server sends { id, preset } with the full row,
// so read both shapes.
spindle.on('PRESET_CHANGED', (payload: any) => {
  const preset = payload?.preset ?? null
  const presetId: string | undefined = payload?.id ?? payload?.presetId ?? preset?.id
  const name: string = preset?.name ?? 'A preset'
  const revision: number | undefined = preset?.cache_revision

  if (ownerUserId) {
    spindle.sendToFrontend({ type: 'preset_saved', presetId, name, revision }, ownerUserId)
  }
  const rev = typeof revision === 'number' ? ` (rev ${revision})` : ''
  spindle.toast.info(`${name} was saved${rev}. If you have it open, reload before editing further.`, {
    title: 'Shared Presence',
    duration: 8000,
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
