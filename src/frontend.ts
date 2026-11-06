// Shared Presence — frontend module.
//
// Asks once for a nickname (both of you share one account, so the server can't
// tell you apart), heartbeats it to the backend, and renders a small floating
// pill listing who else is online. The backend also toasts preset saves.

import type { SpindleFrontendContext } from 'lumiverse-spindle-types'

const NICK_KEY = 'shared_presence.nickname'
const POS_KEY = 'shared_presence.position'
const HEARTBEAT_MS = 20_000

type Peer = { id: string; nickname: string; editing: string | null }
type PresetSave = { name: string; detail: string }

function readNickname(): string | null {
  try { return localStorage.getItem(NICK_KEY) } catch { return null }
}
function writeNickname(value: string) {
  try { localStorage.setItem(NICK_KEY, value) } catch { /* private mode etc. */ }
}
function readPosition(): { x: number; y: number } | null {
  try { const raw = localStorage.getItem(POS_KEY); return raw ? JSON.parse(raw) : null } catch { return null }
}
function writePosition(pos: { x: number; y: number }) {
  try { localStorage.setItem(POS_KEY, JSON.stringify(pos)) } catch { /* ignore */ }
}

// Themed host modal with a host text input. Resolves with the chosen name;
// closing the modal keeps the current name (or 'someone' on first run).
function askNickname(ctx: SpindleFrontendContext, current: string | null): Promise<string> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: string | null) => {
      if (settled) return
      settled = true
      const nick = (value ?? '').trim()
      resolve(nick || current || 'someone')
    }

    let modal: ReturnType<typeof ctx.ui.showModal>
    try {
      modal = ctx.ui.showModal({ title: 'Who are you?', width: 360, persistent: current === null })
    } catch {
      // Modal stack full or host too old: last-resort fallback.
      finish(window.prompt('What should the other editor see you as?', current ?? ''))
      return
    }

    modal.root.innerHTML =
      `<p class="sp-modal-help">The other person on this account will see this name next to the green dot.</p>` +
      `<div class="sp-modal-input"></div>` +
      `<div class="sp-modal-actions"><button type="button" class="sp-modal-ok">Save</button></div>`

    const inputHost = modal.root.querySelector<HTMLElement>('.sp-modal-input')!
    const input = ctx.components.mountTextInput(inputHost, {
      value: current ?? '',
      placeholder: 'Nickname',
      autoFocus: true,
      ariaLabel: 'Nickname',
    })

    // Resolve BEFORE dismissing: dismiss() fires onDismiss synchronously, which
    // would otherwise settle the promise with "no answer" first.
    const submit = () => { finish(input.getValue()); modal.dismiss() }
    modal.root.querySelector<HTMLButtonElement>('.sp-modal-ok')?.addEventListener('click', submit)
    inputHost.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } })
    modal.onDismiss(() => { input.destroy(); finish(null) })
  })
}

// ── "What are they working on" ─────────────────────────────────────────────
//
// With the privileged `presets` permission the host exposes the Loom editor's
// live draft. We watch it and remember the last block whose fields changed, so
// the pill can say "editing Sola › 'Jailbreak'". Without the permission every
// call throws and we quietly report nothing.

type AnyPreset = Record<string, any>
const BLOCK_FIELDS = ['name', 'content', 'role', 'enabled', 'position', 'depth', 'marker', 'group'] as const

function same(a: unknown, b: unknown): boolean {
  try { return JSON.stringify(a) === JSON.stringify(b) } catch { return a === b }
}

class EditingTracker {
  private lastDraft: AnyPreset | null = null
  private lastPresetId: string | null = null
  private lastBlock: string | null = null
  private lastBlockAt = 0
  private unsub: (() => void) | null = null
  onChange: (() => void) | null = null

  constructor(private ctx: SpindleFrontendContext) {
    this.tryAttach()
  }

  private editor(): any {
    try { return (this.ctx.ui as any)?.presetEditor ?? null } catch { return null }
  }

  /** getState() can throw when the `presets` grant is missing or still propagating. */
  private state(): any {
    try { return this.editor()?.getState?.() ?? null } catch { return null }
  }

  /** Subscribe to draft changes if the helper is available; safe to call repeatedly. */
  tryAttach() {
    if (this.unsub) return
    const ed = this.editor()
    if (!ed?.onChange) return
    try {
      this.unsub = ed.onChange(() => { try { this.observe() } catch { /* ignore */ } this.onChange?.() })
      this.observe()
    } catch { this.unsub = null }
  }

  private observe() {
    const state = this.state()
    if (!state?.open || !state.preset) { this.lastDraft = null; this.lastPresetId = null; this.lastBlock = null; return }
    const draft: AnyPreset = state.preset
    if (state.presetId !== this.lastPresetId) { this.lastPresetId = state.presetId; this.lastBlock = null; this.lastDraft = draft; return }
    const prev = this.lastDraft
    this.lastDraft = draft
    if (!prev) return
    const prevBlocks: AnyPreset[] = Array.isArray(prev.blocks) ? prev.blocks : []
    const nextBlocks: AnyPreset[] = Array.isArray(draft.blocks) ? draft.blocks : []
    const prevById = new Map(prevBlocks.map((b) => [String(b.id), b]))
    for (const b of nextBlocks) {
      const p = prevById.get(String(b.id))
      if (!p || BLOCK_FIELDS.some((f) => !same(p[f], b[f]))) {
        this.lastBlock = `'${typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 40) : '(unnamed block)'}'`
        this.lastBlockAt = Date.now()
        return
      }
    }
    if (!same(prev.samplerOverrides, draft.samplerOverrides) || !same(prev.parameters, draft.parameters)) { this.lastBlock = 'sampler settings'; this.lastBlockAt = Date.now() }
    else if (!same(prev.promptVariables, draft.promptVariables)) { this.lastBlock = 'prompt variables'; this.lastBlockAt = Date.now() }
  }

  /**
   * Which block is open in Loom's block editor right now. Loom only commits a
   * block to the draft when you save/back out of it, so the draft diff alone
   * can't see a block you're still inside; the editor's mount point can.
   */
  private openBlockName(): string | null {
    try {
      const el = document.querySelector<HTMLElement>('[data-spindle-scope^="loom-block:"]')
      const scope = el?.getAttribute('data-spindle-scope') ?? ''
      const id = scope.split(':')[1]
      if (!id) return null
      const blocks: AnyPreset[] = this.state()?.preset?.blocks ?? []
      const b = blocks.find((x) => String(x.id) === id)
      const name = typeof b?.name === 'string' && b.name.trim() ? b.name.trim() : null
      return (name ?? '(unnamed block)').slice(0, 40)
    } catch { return null }
  }

  /** "Sola" / "Sola › 'Jailbreak'" / null when the editor is closed or unavailable. */
  describe(): string | null {
    const state = this.state()
    if (!state?.open || !state.preset?.name) return null
    const name = String(state.preset.name).slice(0, 40)
    const open = this.openBlockName()
    if (open) return `${name} \u203a '${open}'`
    if (state.activeTabId && state.activeTabId !== 'preset') return `${name} \u203a ${String(state.activeTabId).slice(0, 30)} tab`
    const recent = this.lastBlock && Date.now() - this.lastBlockAt < 90_000
    return recent ? `${name} \u203a ${this.lastBlock}` : name
  }

  destroy() {
    try { this.unsub?.() } catch { /* host may already have removed it */ }
    this.unsub = null
    this.lastDraft = null
    this.lastPresetId = null
    this.lastBlock = null
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

export function setup(ctx: SpindleFrontendContext) {
  const { frontendSessionId, host } = ctx as SpindleFrontendContext & {
    frontendSessionId?: string
    host?: { extensionInstallationId: string }
  }
  let nickname: string = readNickname() ?? 'someone'
  let disposed = false

  const removeStyle = ctx.dom.addStyle(`
    .sp-modal-help { margin: 0 0 10px; font-size: 13px; color: var(--lumiverse-text-muted); }
    .sp-modal-actions { display: flex; justify-content: flex-end; margin-top: 12px; }
    .sp-modal-ok {
      all: unset; cursor: pointer; padding: 6px 14px; border-radius: var(--lumiverse-radius, 8px);
      background: var(--lumiverse-primary); color: var(--lumiverse-on-primary, #fff); font-size: 13px;
    }
    .sp-modal-ok:hover { filter: brightness(1.1); }
    .shared-presence {
      font: 12px/1.3 var(--lumiverse-font, system-ui, sans-serif);
      color: var(--lumiverse-text);
      background: var(--lumiverse-fill, rgba(20,20,24,.92));
      border: 1px solid var(--lumiverse-border, rgba(255,255,255,.12));
      border-radius: 14px;
      padding: 6px 10px 6px 8px;
      box-sizing: border-box;
      width: max-content; max-width: min(420px, calc(100vw - 24px));
      box-shadow: 0 2px 10px rgba(0,0,0,.25);
      user-select: none; cursor: grab; overflow-wrap: anywhere;
    }
    .shared-presence .sp-presence-line { display: flex; align-items: baseline; gap: 8px; }
    .shared-presence .sp-peers { min-width: 0; }
    .shared-presence .sp-dot {
      flex: 0 0 8px; height: 8px; border-radius: 50%;
      background: var(--lumiverse-success, #3fb950);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--lumiverse-success, #3fb950) 25%, transparent);
    }
    .shared-presence .sp-dot.alone { background: var(--lumiverse-text-muted, #888); box-shadow: none; }
    .shared-presence .sp-peer + .sp-peer::before { content: " · "; opacity: .5; }
    .shared-presence .sp-editing { opacity: .7; font-size: 11px; }
    .shared-presence .sp-me { opacity: .55; }
    .shared-presence .sp-save {
      border-top: 1px solid var(--lumiverse-border, rgba(255,255,255,.12));
      margin-top: 5px; padding-top: 5px; opacity: .75; font-size: 11px;
    }
    .shared-presence .sp-rename {
      all: unset; cursor: pointer; opacity: .5; font-size: 11px; margin-left: 2px;
    }
    .shared-presence .sp-rename:hover { opacity: 1; }
  `)

  const widget = ctx.ui.createFloatWidget({
    width: 240,
    height: 32,
    initialPosition: readPosition() ?? { x: 16, y: window.innerHeight - 56 },
    snapToEdge: true,
    tooltip: 'Who else is logged into this account',
    chromeless: true,
  })
  widget.onDragEnd((pos) => writePosition(pos))
  widget.root.innerHTML = `
    <div class="shared-presence">
      <div class="sp-presence-line">
        <span class="sp-dot alone"></span><span class="sp-peers"></span>
        <button type="button" class="sp-rename" title="Change your nickname" aria-label="Change your nickname">✎</button>
      </div>
      <div class="sp-save" aria-live="polite" hidden></div>
    </div>`
  const pill = widget.root.querySelector<HTMLElement>('.shared-presence')!
  const dot = pill.querySelector<HTMLElement>('.sp-dot')!
  const peerList = pill.querySelector<HTMLElement>('.sp-peers')!
  const saveLine = pill.querySelector<HTMLElement>('.sp-save')!

  let peers: Peer[] = []
  let rosterKnown = false
  let latestSave: PresetSave | null = null
  let previousPeers = ''
  let previousWidth = 0
  let previousHeight = 0

  const fitWidget = () => {
    const { offsetWidth, offsetHeight } = pill
    if (!offsetWidth || !offsetHeight || (offsetWidth === previousWidth && offsetHeight === previousHeight)) return
    previousWidth = offsetWidth
    previousHeight = offsetHeight
    widget.setSize(offsetWidth + 2, offsetHeight + 2)
  }
  const sizeObserver = new ResizeObserver(fitWidget)
  sizeObserver.observe(pill)

  const render = () => {
    const others = peers.filter((p) => p.id !== frontendSessionId)
    dot.classList.toggle('alone', !others.length)
    const parts = others.length
      ? others.map((p) =>
          `<span class="sp-peer"><b>${escapeHtml(p.nickname)}</b>${p.editing ? `<span class="sp-editing"> · editing ${escapeHtml(p.editing)}</span>` : ''}</span>`
        ).join('')
      : `<span class="sp-peer sp-me">${rosterKnown ? `only you (${escapeHtml(nickname)})` : 'Connecting…'}</span>`
    if (previousPeers !== parts) {
      peerList.innerHTML = parts
      previousPeers = parts
    }

    saveLine.hidden = !latestSave
    if (latestSave) {
      saveLine.title = latestSave.name
      if (saveLine.textContent !== latestSave.detail) saveLine.textContent = latestSave.detail
    }
    fitWidget()
  }

  const tracker = new EditingTracker(ctx)
  let lastEditing: string | null | undefined = undefined
  let announced = false   // don't heartbeat as "someone" while the name modal is still open
  const send = (type: 'presence_hello' | 'presence_heartbeat' | 'presence_bye') => {
    if (type === 'presence_hello') announced = true
    if (type === 'presence_heartbeat' && !announced) return
    let editing: string | null = null
    try {
      tracker.tryAttach()   // permission may have been granted after load
      editing = tracker.describe()
    } catch { editing = null }
    lastEditing = editing
    ctx.sendToBackend({ type, nickname, editing })
  }
  pill.querySelector<HTMLButtonElement>('.sp-rename')?.addEventListener('click', (e) => {
    e.stopPropagation()
    void askNickname(ctx, nickname).then((nick) => {
      if (disposed) return
      nickname = nick
      writeNickname(nick)
      render()
      send('presence_hello')
    })
  })
  // Push an update as soon as the block being edited changes (debounced), so
  // the other side doesn't wait for the next heartbeat.
  let editTimer: number | null = null
  tracker.onChange = () => {
    if (editTimer) window.clearTimeout(editTimer)
    editTimer = window.setTimeout(() => {
      editTimer = null
      if (announced && tracker.describe() !== lastEditing) send('presence_heartbeat')
    }, 1500)
  }

  const unsub = ctx.onBackendMessage((payload: any) => {
    if (!payload || typeof payload !== 'object') return
    if (payload.type === 'presence_roster') {
      peers = Array.isArray(payload.peers) ? payload.peers : []
      latestSave = payload.latestSave ?? null
      rosterKnown = true
      render()
    } else if (payload.type === 'preset_saved' && payload.save) {
      latestSave = payload.save
      render()
    }
  })
  const unsubConnected = ctx.events.on('CONNECTED', (payload: any) => {
    if (announced && payload?.userId) send('presence_hello')
  })
  const unsubPermissions = ctx.events.on('SPINDLE_PERMISSION_CHANGED', (payload: any) => {
    if (!host || payload?.extensionId !== host.extensionInstallationId || payload.permission !== 'presets') return
    tracker.destroy()
    send('presence_heartbeat')
  })

  render()
  if (readNickname()) {
    send('presence_hello')
  } else {
    // First run on this browser: ask before announcing, so the other side
    // never sees "someone" flicker in.
    void askNickname(ctx, null).then((nick) => {
      if (disposed) return
      nickname = nick; writeNickname(nick)
      render()
      send('presence_hello')
    })
  }
  const timer = window.setInterval(() => send('presence_heartbeat'), HEARTBEAT_MS)
  const editPoll = window.setInterval(() => {
    if (!announced) return
    let now: string | null = null
    try { now = tracker.describe() } catch { now = null }
    if (now !== lastEditing) send('presence_heartbeat')
  }, 2000)
  const onHide = () => send('presence_bye')
  const onShow = () => { if (announced) send('presence_hello') }
  window.addEventListener('pagehide', onHide)
  window.addEventListener('pageshow', onShow)

  return () => {
    disposed = true
    window.clearInterval(timer)
    window.clearInterval(editPoll)
    if (editTimer) window.clearTimeout(editTimer)
    tracker.destroy()
    window.removeEventListener('pagehide', onHide)
    window.removeEventListener('pageshow', onShow)
    sizeObserver.disconnect()
    try { ctx.sendToBackend({ type: 'presence_bye' }) } catch { /* host may already be inactive */ }
    unsubConnected()
    unsubPermissions()
    unsub()
    widget.destroy()
    removeStyle()
    ctx.dom.cleanup()
  }
}
