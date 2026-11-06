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

type PresetSave = {
  presetId: string
  name: string
  revision?: number
  detail: string
}

type Account = {
  peers: Map<string, Peer>
  lastRows: Map<string, AnyPreset>
  latestSave: PresetSave | null
  seeding: boolean
}

const STALE_MS = 60_000          // drop a peer if no heartbeat for this long
const PRUNE_EVERY_MS = 15_000

const accounts = new Map<string, Account>()

function getAccount(userId: string): Account {
  let account = accounts.get(userId)
  if (!account) {
    account = { peers: new Map(), lastRows: new Map(), latestSave: null, seeding: false }
    accounts.set(userId, account)
  }
  return account
}

function sendRoster(userId: string, account: Account, frontendSessionId?: string) {
  const peers = [...account.peers].map(([id, { nickname, editing }]) => ({ id, nickname, editing }))
  spindle.sendToFrontend({ type: 'presence_roster', peers, latestSave: account.latestSave }, userId, { frontendSessionId })
}

function cleanNickname(value: unknown): string {
  const s = typeof value === 'string' ? value.trim() : ''
  return (s || 'someone').slice(0, 32)
}

spindle.onFrontendMessage((payload: any, userId, frontendSessionId) => {
  if (!userId || !frontendSessionId || !payload || typeof payload !== 'object') return

  switch (payload.type) {
    case 'presence_hello':
    case 'presence_heartbeat': {
      const account = getAccount(userId)
      const { peers } = account
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
        spindle.toast.info(`${next.nickname} is online`, { title: 'Shared Presence', duration: 4000, userId })
        void seedBaselines(userId, account)
      }
      // A quiet heartbeat still gets a snapshot to recover a missed update.
      sendRoster(userId, account, changed ? undefined : frontendSessionId)
      break
    }

    case 'presence_bye':
      removePeer(userId, frontendSessionId)
      break
  }
})

function removePeer(userId: string, id: string) {
  const account = accounts.get(userId)
  if (account?.peers.delete(id)) sendRoster(userId, account)
}

// The host tells us when a document's socket is gone (tab closed, reload, network drop).
spindle.on('FRONTEND_SESSION_CLOSED', (payload: any, userId?: string) => {
  const id = payload?.frontendSessionId
  if (userId && typeof id === 'string') removePeer(userId, id)
})

// ── Save announcements with a "what changed" summary ────────────────────────
//
// PRESET_CHANGED is documented as { presetId } but the staging server sends
// { id, preset } with the full row, so read both shapes. Blocks live in
// `prompt_order`; sampler/model settings in `parameters`; everything else the
// editor saves (samplerOverrides, promptVariables, …) lands in `metadata`.

type AnyPreset = Record<string, any>

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

  // Loom spreads its other editor sections across two JSON bags; name the keys that moved.
  const changedKeys = (a: AnyPreset, b: AnyPreset) =>
    [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].filter((k) => !same(a?.[k], b?.[k]))
  const changed = [...changedKeys(prev.prompts, next.prompts), ...changedKeys(prev.metadata, next.metadata)]
  if (changed.length) {
    const labels = changed.slice(0, 4).map((key) => key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().slice(0, 40))
    out.push(labels.join(', ') + (changed.length > 4 ? ', …' : ''))
  }

  return out
}

// The authenticated account is known when its first browser announces itself.
async function seedBaselines(userId: string, account: Account) {
  if (account.seeding || !spindle.permissions.has('presets')) return
  account.seeding = true
  try {
    let offset = 0
    for (;;) {
      const { data, total } = await spindle.presets.list({ limit: 100, offset, userId })
      for (const row of data) if (!account.lastRows.has(row.id)) account.lastRows.set(row.id, row)
      offset += data.length
      if (!data.length || offset >= total) break
    }
  } catch (err) {
    spindle.log.info(`Baseline seed skipped: ${String(err)}`)
  } finally {
    account.seeding = false
  }
}
spindle.permissions.onChanged(({ permission, granted }) => {
  if (permission === 'presets' && granted) {
    for (const [userId, account] of accounts) void seedBaselines(userId, account)
  }
})

spindle.on('PRESET_CHANGED', (payload: any, userId?: string) => {
  if (!userId) return
  const account = getAccount(userId)
  const preset: AnyPreset | null = payload?.preset ?? null
  const presetId: string | undefined = payload?.id ?? payload?.presetId ?? preset?.id
  if (typeof presetId !== 'string') return

  const prev = account.lastRows.get(presetId)
  const name = String(preset?.name ?? prev?.name ?? 'A preset').slice(0, 100)
  const revision = typeof preset?.cache_revision === 'number' ? preset.cache_revision : undefined
  const latest = account.latestSave
  if (revision !== undefined && latest?.presetId === presetId && latest.revision === revision) return

  let compared = false
  let summary: string[] = []
  if (preset) {
    if (revision !== undefined && typeof prev?.cache_revision === 'number' && revision < prev.cache_revision) return
    if (prev && revision !== undefined && prev.cache_revision === revision - 1) {
      compared = true
      summary = describeChanges(prev, preset)
    }
    account.lastRows.set(presetId, preset)
  } else {
    account.lastRows.delete(presetId)
  }

  const changes = summary.join(' · ')
  const detail = changes
    ? changes.charAt(0).toUpperCase() + changes.slice(1)
    : compared ? 'Preset saved · no tracked changes' : 'Preset saved · change details unavailable'
  const save = { presetId, name, revision, detail }
  account.latestSave = save
  spindle.sendToFrontend({ type: 'preset_saved', save }, userId)
  spindle.toast.info(detail, {
    title: 'Shared Presence',
    duration: summary.length ? 10000 : 7000,
    userId,
  })
})

// Drop peers whose heartbeats stopped without a clean close.
setInterval(() => {
  const cutoff = Date.now() - STALE_MS
  for (const [userId, account] of accounts) {
    let removed = false
    for (const [id, p] of account.peers) {
      if (p.lastSeen < cutoff) { account.peers.delete(id); removed = true }
    }
    if (removed) sendRoster(userId, account)
  }
}, PRUNE_EVERY_MS)

spindle.log.info('Shared Presence backend loaded')
