// Shared Presence — frontend module.
//
// Asks once for a nickname (both of you share one account, so the server can't
// tell you apart), heartbeats it to the backend, and renders a small floating
// pill listing who else is online. The backend also toasts preset saves.

import type { SpindleFrontendContext } from 'lumiverse-spindle-types'

const NICK_KEY = 'shared_presence.nickname'
const POS_KEY = 'shared_presence.position'
const HEARTBEAT_MS = 20_000

type Peer = { id: string; nickname: string; editing: string | null; lastSeen: number }

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

    const submit = () => { const v = input.getValue(); modal.dismiss(); finish(v) }
    modal.root.querySelector<HTMLButtonElement>('.sp-modal-ok')?.addEventListener('click', submit)
    inputHost.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } })
    modal.onDismiss(() => { input.destroy(); finish(null) })
  })
}

// Best effort: if the host exposes the preset editor state (needs the
// privileged `presets` permission), report which preset is open. Without it
// this silently returns null and presence still works.
function currentlyEditing(ctx: SpindleFrontendContext): string | null {
  try {
    const editor = (ctx.ui as any)?.presetEditor
    const state = editor?.getState?.()
    if (state?.open && state?.preset?.name) return String(state.preset.name)
  } catch { /* permission not granted */ }
  return null
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

export function setup(ctx: SpindleFrontendContext) {
  let nickname: string = readNickname() ?? 'someone'

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
      border-radius: 999px;
      padding: 6px 10px 6px 8px;
      display: inline-flex; align-items: center; gap: 8px;
      box-shadow: 0 2px 10px rgba(0,0,0,.25);
      user-select: none; cursor: grab; white-space: nowrap;
    }
    .shared-presence .sp-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--lumiverse-success, #3fb950);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--lumiverse-success, #3fb950) 25%, transparent);
    }
    .shared-presence .sp-dot.alone { background: var(--lumiverse-text-muted, #888); box-shadow: none; }
    .shared-presence .sp-peer { display: inline-flex; align-items: center; gap: 4px; }
    .shared-presence .sp-peer + .sp-peer::before { content: "·"; opacity: .5; margin: 0 2px; }
    .shared-presence .sp-editing { opacity: .7; font-size: 11px; }
    .shared-presence .sp-me { opacity: .55; }
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

  let peers: Peer[] = []
  let mySessionId: string | null = null   // learned from the roster: the entry whose nickname matches and is newest

  const render = () => {
    const others = peers.filter((p) => p.id !== mySessionId)
    const dotClass = others.length ? 'sp-dot' : 'sp-dot alone'
    const parts = others.length
      ? others.map((p) =>
          `<span class="sp-peer"><b>${escapeHtml(p.nickname)}</b>${p.editing ? `<span class="sp-editing">editing ${escapeHtml(p.editing)}</span>` : ''}</span>`
        ).join('')
      : `<span class="sp-peer sp-me">only you (${escapeHtml(nickname)})</span>`
    widget.root.innerHTML =
      `<div class="shared-presence"><span class="${dotClass}"></span>${parts}` +
      `<button class="sp-rename" title="Change your nickname">✎</button></div>`
    widget.root.querySelector<HTMLButtonElement>('.sp-rename')?.addEventListener('click', (e) => {
      e.stopPropagation()
      void askNickname(ctx, nickname).then((nick) => {
        nickname = nick; writeNickname(nick)
        send('presence_hello')
      })
    })
    // Width follows content so the pill doesn't clip long names.
    const pill = widget.root.querySelector<HTMLElement>('.shared-presence')
    if (pill) widget.setSize(Math.min(pill.offsetWidth + 2, 480), 32)
  }

  const send = (type: 'presence_hello' | 'presence_heartbeat' | 'presence_bye') => {
    ctx.sendToBackend({ type, nickname, editing: currentlyEditing(ctx) })
  }

  const unsub = ctx.onBackendMessage((payload: any) => {
    if (!payload || typeof payload !== 'object') return
    if (payload.type === 'presence_roster') {
      peers = Array.isArray(payload.peers) ? payload.peers : []
      // Identify "me": the newest roster entry carrying my nickname. Good enough
      // for two people; a second tab of your own will show as a peer, which is
      // actually useful.
      const mine = peers.filter((p) => p.nickname === nickname).sort((a, b) => b.lastSeen - a.lastSeen)
      if (mine.length && (mySessionId === null || !peers.some((p) => p.id === mySessionId))) mySessionId = mine[0].id
      render()
    }
    // 'preset_saved' is also toasted by the backend; nothing extra needed here.
  })

  render()
  if (readNickname()) {
    send('presence_hello')
  } else {
    // First run on this browser: ask before announcing, so the other side
    // never sees "someone" flicker in.
    void askNickname(ctx, null).then((nick) => {
      nickname = nick; writeNickname(nick)
      render()
      send('presence_hello')
    })
  }
  const timer = window.setInterval(() => send('presence_heartbeat'), HEARTBEAT_MS)
  const onHide = () => send('presence_bye')
  window.addEventListener('pagehide', onHide)

  return () => {
    window.clearInterval(timer)
    window.removeEventListener('pagehide', onHide)
    send('presence_bye')
    unsub()
    widget.destroy()
    removeStyle()
    ctx.dom.cleanup()
  }
}
