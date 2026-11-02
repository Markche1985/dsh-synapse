const app = document.querySelector('#app')
if ('scrollRestoration' in history) history.scrollRestoration = 'manual'
const LEGACY_CARD_POSITIONS_KEY = 'dsh-synapse:card-positions'
const CARD_POSITIONS_KEY = 'dsh-synapse:card-positions:v3'
const COLLAPSED_CARDS_KEY = 'dsh-synapse:collapsed-cards:v1'
const QUICK_PHRASES_KEY = 'dsh-synapse:quick-phrases:v1'
const DEFAULT_QUICK_PHRASES = ['展开说明', '举例', '通俗易懂', '对比解释']
const MAX_QUICK_PHRASES = 12
const MAX_QUICK_PHRASE_LENGTH = 16
function normalizeQuickPhrases(value) {
  if (!Array.isArray(value)) return []
  const phrases = []
  for (const item of value) {
    const phrase = typeof item === 'string' ? item.trim().slice(0, MAX_QUICK_PHRASE_LENGTH) : ''
    if (phrase !== '' && !phrases.includes(phrase)) phrases.push(phrase)
    if (phrases.length === MAX_QUICK_PHRASES) break
  }
  return phrases
}
const savedQuickPhrases = (() => {
  try {
    const stored = localStorage.getItem(QUICK_PHRASES_KEY)
    return stored === null ? DEFAULT_QUICK_PHRASES : normalizeQuickPhrases(JSON.parse(stored))
  } catch { return DEFAULT_QUICK_PHRASES }
})()
const savedBranchAnchors = (() => {
  try {
    const value = JSON.parse(localStorage.getItem('dsh-synapse:branch-anchors') ?? '[]')
    return Array.isArray(value) ? value.filter(item => Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string') : []
  } catch { return [] }
})()
const savedCardPositions = (() => {
  try {
    // Drop formats that were never persisted; the current key stores drags.
    localStorage.removeItem(LEGACY_CARD_POSITIONS_KEY)
    localStorage.removeItem('dsh-synapse:card-positions:v2')
    const value = JSON.parse(localStorage.getItem(CARD_POSITIONS_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter(item => Array.isArray(item) && typeof item[0] === 'string' && item[1] !== null && Number.isFinite(item[1].x) && Number.isFinite(item[1].y)) : []
  } catch { return [] }
})()
const savedCollapsedCards = (() => {
  try {
    const value = JSON.parse(localStorage.getItem(COLLAPSED_CARDS_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
  } catch { return [] }
})()
const CARD_WIDTH = 310
const CARD_HEIGHT = 276
const CARD_GAP_Y = 42
const CAMERA_INSET_X = 56
const CAMERA_INSET_Y = 56
// Cards outside the viewport (plus this world-space margin) are not mounted
// into the DOM; the margin pre-mounts cards just before they scroll into view
// so panning never flashes empty space.
const VIEWPORT_MARGIN = 1400
const state = {
  summaries: [], workspace: null, activeId: null, selectedCardId: null, mode: 'canvas', zoom: 1, currentDsh: null, sidebarCollapsed: false,
  dshWorkspaces: [], selectedDshWorkspaceId: null,
  historyBySession: new Map(), historyRequests: new Map(), pendingReplies: new Map(), pendingRpc: new Map(), liveReplies: new Map(),
  // Message bodies are not part of the workspace payload; they are fetched per
  // screenful and cached here (issue #42).
  bodies: new Map(), bodyRequests: new Set(), bodyFailures: new Set(), bodiesLoaded: new Set(),
  archivedSessionIds: new Set(),
  draft: null, error: '', workspaceLoad: 0, workspaceLoadOwner: null, workspaceLoadBusy: false, workspaceFingerprint: null, workspacesSignature: null, branchAnchors: new Map(savedBranchAnchors), cardPositions: new Map(savedCardPositions), collapsedCardIds: new Set(savedCollapsedCards), quickPhrases: savedQuickPhrases, quickPhraseEditorOpen: false,
  dragging: false, canvasGesture: false, canvasRefreshAfter: 0, canvasViewInitialized: false, canvasCamera: { x: 0, y: 0 }, mapCardSessionSwitches: new Set(),
  // Annotation layer (Phase A): notes/images live on the Host and are mirrored
  // into this Map; `canvasTool` drives the toolbar, `selectedNodeIds` the
  // `.selected` class, `noteEditingId` the contenteditable that owns the caret.
  nodes: new Map(), canvasTool: 'pan', selectedNodeIds: new Set(), selectedCardKeys: new Set(), noteEditingId: null, pendingNodeDeletes: new Set(),
  expandedMessageIds: new Set(),
  canvasCards: undefined, canvasCardsById: undefined, canvasGraph: undefined, mountedCardIds: new Set(), canvasNeedsCenter: false,
  detailScrollByThread: new Map(), detailThreadId: null, detailTargetCardId: null,
  inspectorCardId: null, inspectorOpening: false, inspectorScrollByCard: new Map(),
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))
const formatTime = value => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const currentThread = () => state.workspace?.threads.find(thread => thread.id === state.activeId) ?? state.workspace?.threads[0] ?? null
const threadListTitle = thread => thread.dshSessionTitle ?? thread.title ?? questionFor(thread)

function rememberBranchAnchor(sessionId, cardId) {
  state.branchAnchors.set(sessionId, cardId)
  try { localStorage.setItem('dsh-synapse:branch-anchors', JSON.stringify([...state.branchAnchors])) } catch { /* Private browsing may disable local storage. */ }
}

function persistCardPositions() {
  try { localStorage.setItem(CARD_POSITIONS_KEY, JSON.stringify([...state.cardPositions])) } catch { /* Private browsing may disable local storage. */ }
}

function persistCollapsedCards() {
  try { localStorage.setItem(COLLAPSED_CARDS_KEY, JSON.stringify([...state.collapsedCardIds])) } catch { /* Private browsing may disable local storage. */ }
}

function persistQuickPhrases() {
  try { localStorage.setItem(QUICK_PHRASES_KEY, JSON.stringify(state.quickPhrases)) } catch { /* Private browsing may disable local storage. */ }
}

function rememberCardPosition(cardId, position, aliases = []) {
  state.cardPositions.set(cardId, { x: Math.round(position.x), y: Math.round(position.y) })
  for (const alias of aliases) state.cardPositions.set(alias, { x: Math.round(position.x), y: Math.round(position.y) })
  persistCardPositions()
  // The Host is the durable owner of the layout: the desktop app starts on a
  // random port, so the browser origin (and its local storage) changes on every
  // restart. One debounced PATCH per drag burst; the positionKey is sent, never
  // the card id, because DSH reassigns `seq` after a pending turn.
  queueCardPositionSync(typeof aliases[0] === 'string' ? aliases[0] : cardId, { x: Math.round(position.x), y: Math.round(position.y) })
}

/** The Host address of the workspace on screen (`dsh:` is a client-side prefix). */
function hostWorkspaceId() {
  const id = state.workspace?.id
  if (typeof id !== 'string' || id === '') return null
  return id.startsWith('dsh:') ? id.slice(4) : id
}

let cardPositionSyncTimer = 0
let cardPositionSyncPending = null

/** Merge the Host's durable card positions; the Host value wins over the cache. */
function applyHostCardPositions(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return false
  const merged = new Map(mergeCardPositions([...state.cardPositions], record))
  let changed = false
  for (const [key, value] of merged) {
    const previous = state.cardPositions.get(key)
    if (previous === undefined || previous.x !== value.x || previous.y !== value.y) { changed = true; break }
  }
  if (!changed) return false
  state.cardPositions = merged
  persistCardPositions()
  return true
}

/** Debounce one `PATCH /workspaces/:id {cardPositions}` per drag burst. */
function queueCardPositionSync(positionKey, position) {
  const workspaceId = hostWorkspaceId()
  if (workspaceId === null || typeof positionKey !== 'string' || positionKey === '') return
  if (cardPositionSyncPending === null) cardPositionSyncPending = {}
  cardPositionSyncPending[positionKey] = position
  if (cardPositionSyncTimer !== 0) return
  cardPositionSyncTimer = window.setTimeout(() => {
    cardPositionSyncTimer = 0
    const body = cardPositionSyncPending
    cardPositionSyncPending = null
    if (body === null) return
    // Best effort: an older Host without the route keeps the local cache as the
    // source of truth, so a failed sync must never surface as a canvas error.
    void api(`/synapse/api/workspaces/${encodeURIComponent(workspaceId)}`, { method: 'PATCH', body: JSON.stringify({ cardPositions: body }) })
      .catch(() => { /* private mode / older Host: localStorage still has the layout */ })
  }, CARD_POSITION_SYNC_DELAY)
}

let appliedWorkspaceId = null

/** Persist every card's current position (整理 resets the layout, not only the cache). */
function syncAllCardPositionsToHost() {
  const cards = state.canvasCards ?? []
  for (const card of cards) {
    const positionKey = cardPositionKey(card)
    if (positionKey === '' || card.position === null || card.position === undefined) continue
    queueCardPositionSync(positionKey, { x: Math.round(card.position.x), y: Math.round(card.position.y) })
  }
}

/** Replace the node collection with the Host's copy, keeping unconfirmed creates. */
function applyWorkspaceNodes(nodes) {
  // Never yank the node the user is typing into: the next payload after blur wins.
  if (state.noteEditingId !== null) return false
  const merged = mergeWorkspaceNodes([...state.nodes.values()], Array.isArray(nodes) ? nodes : [], state.pendingNodeDeletes)
  state.nodes = new Map(merged.map(node => [node.id, node]))
  return true
}

/** Apply the v6 payload fields a workspace carries (nodes + durable positions). */
function applyHostWorkspaceData(workspace) {
  if (workspace === null || typeof workspace !== 'object') return
  // `dsh:<uuid>` and `<uuid>` are the same Host workspace: normalise so the
  // first poll after `openDshWorkspace` does not look like a switch.
  const workspaceId = typeof workspace.id === 'string' && workspace.id.startsWith('dsh:') ? workspace.id.slice(4) : workspace.id
  if (appliedWorkspaceId !== workspaceId) {
    // A workspace switch must not carry another canvas's nodes or selection into
    // this one; the incoming payload below repopulates it.
    appliedWorkspaceId = workspaceId
    state.nodes = new Map()
    state.selectedNodeIds.clear()
    state.selectedCardKeys.clear()
    state.selectedCardId = null
    state.pendingNodeDeletes.clear()
    state.canvasTool = 'pan'
  }
  applyWorkspaceNodes(workspace.nodes)
  // A queued drag PATCH has not reached the Host yet; applying its older copy
  // would snap the card back for one poll tick.
  if (cardPositionSyncTimer === 0 && cardPositionSyncPending === null) applyHostCardPositions(workspace.cardPositions)
}

function resetCardPositions() {
  state.cardPositions.clear()
  persistCardPositions()
  try {
    localStorage.removeItem(LEGACY_CARD_POSITIONS_KEY)
    localStorage.removeItem('dsh-synapse:card-positions:v2')
  } catch { /* Private browsing may disable local storage. */ }
}

function resetCanvasCamera() {
  state.canvasViewInitialized = false
  state.canvasCamera = { x: 0, y: 0 }
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error ?? '请求失败')
  return body
}

function post(type, payload = {}) {
  if (window.parent !== window) window.parent.postMessage({ source: 'dsh-synapse', type, ...payload }, window.location.origin)
}

function dshRpc(type, payload = {}) {
  if (window.parent === window) return Promise.reject(new Error('请从 DSH 页面打开 Synapse 后再操作会话'))
  const requestId = crypto.randomUUID()
  post(type, { requestId, ...payload })
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      state.pendingRpc.delete(requestId)
      reject(new Error('DSH 未在规定时间内响应'))
    }, 20_000)
    state.pendingRpc.set(requestId, { resolve, reject, timer })
  })
}

function settleRpc(requestId, value, error) {
  const pending = state.pendingRpc.get(requestId)
  if (pending === undefined) return
  state.pendingRpc.delete(requestId)
  window.clearTimeout(pending.timer)
  if (error === undefined) pending.resolve(value)
  else pending.reject(error instanceof Error ? error : new Error(String(error)))
}

function setError(error = '') { state.error = error instanceof Error ? error.message : error; render() }

function messagesFromEvents(events) {
  if (!Array.isArray(events)) return []
  return events.flatMap(event => {
    const content = event?.data?.message?.content ?? event?.data?.content
    const text = Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text).filter(Boolean).join('\n') : ''
    if (event?.type === 'user/message' && text && !text.startsWith('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.')) return [{ kind: 'user', text, at: event.time, sourceSeq: event.seq }]
    if (event?.type === 'assistant/message' && text) return [{ kind: 'assistant', text, at: event.time, sourceSeq: event.seq }]
    return []
  })
}

async function loadThreadHistory() {}

function canReplaceView() {
  return state.draft === null && !state.dragging && !state.canvasGesture && Date.now() >= state.canvasRefreshAfter && !document.activeElement?.matches('textarea, [contenteditable="true"]')
}

function deferCanvasRefresh(delay = 700) {
  state.canvasRefreshAfter = Math.max(state.canvasRefreshAfter, Date.now() + delay)
}

function currentDshWorkspace() {
  const id = state.currentDsh?.id
  return typeof id === 'string' ? state.dshWorkspaces.find(workspace => workspace.sessionIds.includes(id)) : undefined
}

function selectedDshWorkspace() {
  return state.dshWorkspaces.find(workspace => workspace.id === state.selectedDshWorkspaceId)
}

function currentDshThread(threads = state.workspace?.threads ?? []) {
  const id = state.currentDsh?.id
  return typeof id === 'string' ? threads.find(thread => thread.dshSessionId === id) : undefined
}

/** Only the session fields the canvas actually draws; used to skip no-op renders. */
function sessionSignature(session) {
  if (session === null || session === undefined) return ''
  return [session.id ?? '', session.title ?? session.displayTitle ?? '', session.cwd ?? '', session.running === true ? '1' : '0'].join('|')
}

function workspaceChoices() {
  if (state.dshWorkspaces.length > 0) return state.dshWorkspaces.map(workspace => ({ ...workspace, source: 'dsh' }))
  return state.summaries.map(workspace => ({ id: workspace.id, title: workspace.title, path: workspace.cwd, sessionIds: [], source: 'projection' }))
}

async function threadsForDshWorkspace(workspace) {
  if (workspace.sessionIds.length === 0) return []
  const requested = new Set(workspace.sessionIds)
  const projections = await Promise.all(state.summaries.map(summary => api(`/synapse/api/workspaces/${summary.id}`)))
  return projections.flatMap(projection => projection.workspace.threads.filter(thread => requested.has(thread.dshSessionId)))
}

async function openDshWorkspace(id, { renderAfter = true, preserveCanvasCamera = false, userInitiated = false } = {}) {
  const workspace = state.dshWorkspaces.find(item => item.id === id)
  if (workspace === undefined) return false
  // A background poll must never cancel or pre-empt a workspace the user just
  // picked, and two polls must never run at once: the 1s poll used to open a
  // fresh whole-workspace load every tick, each one cancelling the previous
  // ticket, so nothing ever rendered (16 loads / 12 cancellations in 19s).
  if (!userInitiated && (state.workspaceLoadOwner === 'user' || state.workspaceLoadBusy)) return false
  const load = ++state.workspaceLoad
  if (userInitiated) state.workspaceLoadOwner = 'user'
  state.workspaceLoadBusy = true
  try {
    state.selectedDshWorkspaceId = id
    // v6 payload: annotation nodes + durable card positions live on the workspace
    // record, fetched alongside the per-workspace projections.
    const [threads, record] = await Promise.all([
      threadsForDshWorkspace(workspace),
      api(`/synapse/api/workspaces/${workspace.id}`).catch(() => null),
    ])
    if (load !== state.workspaceLoad) return true
    const nextWorkspaceId = `dsh:${workspace.id}`
    if (state.workspace?.id !== nextWorkspaceId && !preserveCanvasCamera) resetCanvasCamera()
    state.workspace = { id: nextWorkspaceId, title: workspace.title, cwd: workspace.path, threads, nodes: record?.workspace?.nodes ?? [], cardPositions: record?.workspace?.cardPositions ?? {} }
    applyHostWorkspaceData(state.workspace)
    state.workspaceFingerprint = JSON.stringify(state.workspace)
    const currentThread = currentDshThread(state.workspace.threads)
    state.activeId = currentThread?.id ?? (state.workspace.threads.some(thread => thread.id === state.activeId) ? state.activeId : state.workspace.threads[0]?.id ?? null)
    if (currentThread !== undefined) revealConversationThread(conversationCards(state.workspace.threads), currentThread.id)
    if (currentThread !== undefined) revealFramesForThread(currentThread.id)
    if (renderAfter && canReplaceView()) render()
    await Promise.all(state.workspace.threads.map(thread => loadThreadHistory(thread, false)))
    if (renderAfter && load === state.workspaceLoad && canReplaceView()) render()
    // After a user switch, bring that workspace's active conversation on screen.
    if (userInitiated && load === state.workspaceLoad) window.requestAnimationFrame(() => { if (state.mode === 'canvas') focusActiveCard() })
    return true
  } finally {
    state.workspaceLoadBusy = false
    if (userInitiated && load === state.workspaceLoad) state.workspaceLoadOwner = null
  }
}

async function openCurrentWorkspace({ preserveCanvasCamera = false } = {}) {
  const workspace = currentDshWorkspace()
  if (workspace === undefined || workspace.id === state.selectedDshWorkspaceId) return false
  return openDshWorkspace(workspace.id, { preserveCanvasCamera })
}

async function refreshSummaries({ renderAfter = true } = {}) {
  const before = JSON.stringify(state.summaries)
  const body = await api('/synapse/api/workspaces')
  state.summaries = body.workspaces
  const changed = before !== JSON.stringify(state.summaries)
  const current = state.workspace?.id
  if (state.selectedDshWorkspaceId === null && current !== null && !state.summaries.some(item => item.id === current)) state.workspace = null
  const selected = selectedDshWorkspace()
  if (selected !== undefined && (changed || state.workspace === null)) await openDshWorkspace(selected.id, { renderAfter })
  else if (state.workspace === null && state.summaries.length > 0) await openWorkspace(state.summaries[0].id)
  else if (renderAfter && changed && canReplaceView()) render()
  return changed
}

async function openWorkspace(id, { renderAfter = true } = {}) {
  const load = ++state.workspaceLoad
  const body = await api(`/synapse/api/workspaces/${id}`)
  if (load !== state.workspaceLoad) return
  if (state.workspace?.id !== body.workspace.id) resetCanvasCamera()
  state.workspace = body.workspace
  applyHostWorkspaceData(state.workspace)
  state.workspaceFingerprint = JSON.stringify(state.workspace)
  state.activeId = state.workspace.threads.some(thread => thread.id === state.activeId) ? state.activeId : state.workspace.threads[0]?.id ?? null
  if (renderAfter && canReplaceView()) render()
  await Promise.all(state.workspace.threads.map(thread => loadThreadHistory(thread, false)))
  if (renderAfter && load === state.workspaceLoad && canReplaceView()) render()
}

/**
 * Quiet refresh of the workspace already on screen: re-fetch its payload and only
 * rebuild the canvas when the payload really changed. The poll used to call
 * `openDshWorkspace` every second, which re-ran the whole load (and its ticket)
 * just to discover nothing had changed.
 */
async function refreshCurrentWorkspace() {
  const current = state.workspace
  if (current === null || typeof current.id !== 'string' || !current.id.startsWith('dsh:')) return false
  const body = await api(`/synapse/api/workspaces/${current.id.slice(4)}`)
  if (state.workspace !== current) return false
  const fingerprint = JSON.stringify(body.workspace)
  if (state.workspaceFingerprint === fingerprint) return false
  state.workspaceFingerprint = fingerprint
  state.workspace = body.workspace
  applyHostWorkspaceData(state.workspace)
  if (!state.workspace.threads.some(thread => thread.id === state.activeId)) {
    state.activeId = state.workspace.threads[0]?.id ?? null
  }
  if (canReplaceView()) render()
  return true
}

async function refreshProjection() {
  const summariesChanged = await refreshSummaries({ renderAfter: false })
  if (!summariesChanged || state.workspace === null || !canReplaceView()) return summariesChanged
  if (state.workspace.id.startsWith('dsh:')) return (await refreshCurrentWorkspace()) || summariesChanged
  if (state.selectedDshWorkspaceId !== null) await openDshWorkspace(state.selectedDshWorkspaceId)
  else await openWorkspace(state.workspace.id)
  return true
}

function openNewSession() {
  if (state.draft !== null) return
  state.mode = 'canvas'
  state.activeId = null
  state.selectedCardId = null
  state.inspectorCardId = null
  state.inspectorOpening = false
  state.quickPhraseEditorOpen = false
  state.draft = { kind: 'new', text: '', sending: false }
  state.error = ''
  resetCanvasCamera()
  render()
  window.setTimeout(() => document.querySelector('[data-draft] textarea')?.focus(), 0)
}

async function archiveThread(thread) {
  // A DSH-backed thread is archived in DSH itself, so the sidebar and this map
  // share one archive set (issue #21 / #19). Keeping a second local delete is
  // what made the map claim "archived" while DSH still listed the session.
  if (thread.dshSessionId !== null) {
    if (!window.confirm(`在 DSH 中归档「${thread.title}」及其分支？DSH 侧会话也会被归档。`)) return
    try {
      await dshRpc('synapse:archive-session', { sessionId: thread.dshSessionId })
    } catch (error) {
      setError(error instanceof Error ? error.message : '归档失败')
      return
    }
    state.archivedSessionIds.add(thread.dshSessionId)
    state.activeId = state.activeId === thread.id ? (state.workspace?.threads.find(item => item.id !== thread.id)?.id ?? null) : state.activeId
    if (state.inspectorCardId !== null && state.canvasCardsById?.get(state.inspectorCardId)?.dshThreadId === thread.id) state.inspectorCardId = null
    render()
    await refreshSummaries()
    return
  }
  if (!window.confirm(`归档画布中的「${thread.title}」及其分支？DSH 原会话会保留，可在 DSH 内继续查看。`)) return
  await api(`/synapse/api/threads/${thread.id}`, { method: 'DELETE' })
  state.historyBySession.delete(thread.dshSessionId)
  state.detailScrollByThread.delete(thread.id)
  state.detailTargetCardId = state.detailThreadId === thread.id ? null : state.detailTargetCardId
  if (state.workspace !== null) {
    const removed = new Set([thread.id])
    for (let changed = true; changed;) {
      changed = false
      for (const item of state.workspace.threads) {
        if (item.parentId !== null && removed.has(item.parentId) && !removed.has(item.id)) {
          removed.add(item.id)
          changed = true
        }
      }
    }
    state.workspace.threads = state.workspace.threads.filter(item => !removed.has(item.id))
    for (const key of [...state.cardPositions.keys()]) {
      if ([...removed].some(id => key.startsWith(`${id}:`))) state.cardPositions.delete(key)
    }
    let collapsedChanged = false
    for (const key of [...state.collapsedCardIds]) {
      if ([...removed].some(id => key.startsWith(`${id}:`))) {
        state.collapsedCardIds.delete(key)
        collapsedChanged = true
      }
    }
    if (collapsedChanged) persistCollapsedCards()
    state.activeId = state.activeId !== null && state.workspace.threads.some(item => item.id === state.activeId)
      ? state.activeId
      : state.workspace.threads[0]?.id ?? null
    render()
  } else {
    state.activeId = null
  }
  await refreshSummaries()
}

function focusDraftInput() {
  const input = document.querySelector('[data-draft] textarea')
  if (!(input instanceof HTMLTextAreaElement)) return
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
}

function openContinue(parent, anchorId = undefined, text = '') {
  if (parent.dshSessionId === null) return setError('该节点没有关联的 DSH 会话')
  state.activeId = parent.id
  state.quickPhraseEditorOpen = false
  state.draft = { kind: 'continue', parentId: parent.id, anchorId, text, sending: false }
  render()
  window.setTimeout(focusDraftInput, 0)
}

function openBranch(parent, atSeq = undefined, anchorId = undefined) {
  if (parent.dshSessionId === null) return setError('该节点没有关联的 DSH 会话')
  state.activeId = parent.id
  state.quickPhraseEditorOpen = false
  state.draft = { kind: 'branch', parentId: parent.id, atSeq, anchorId, text: '', sending: false }
  render()
  window.setTimeout(() => document.querySelector('[data-draft] textarea')?.focus(), 0)
}

async function sendMessage(thread, text) {
  if (thread.dshSessionId === null) throw new Error('该节点没有关联的 DSH 会话')
  if (state.pendingReplies.has(thread.dshSessionId)) throw new Error('该会话正在回复，请稍后再发送')
  state.pendingReplies.set(thread.dshSessionId, { text, at: Date.now() })
  state.error = ''
  render()
  try {
    await dshRpc('synapse:send-message', { sessionId: thread.dshSessionId, text })
    void loadThreadHistory(thread)
  } catch (error) {
    state.pendingReplies.delete(thread.dshSessionId)
    render()
    throw error
  }
}

async function submitDraft() {
  const draft = state.draft
  const text = draft?.text.trim()
  if (draft === null || !text) return
  const branchPosition = draft.kind === 'branch' && state.workspace !== null ? draftPlacement(conversationCards(state.workspace.threads))?.position : undefined
  draft.sending = true
  state.error = ''
  render()
  try {
    if (draft.kind === 'new') {
      const session = await dshRpc('synapse:create-session', { workspaceId: state.selectedDshWorkspaceId, cwd: state.currentDsh?.cwd })
      await dshRpc('synapse:send-message', { sessionId: session.id, text })
      state.draft = null
      render()
      window.setTimeout(() => {
        void refreshProjection().catch(() => {})
      }, 150)
      return
    }
    const parent = state.workspace?.threads.find(thread => thread.id === draft.parentId)
    if (parent === undefined) throw new Error('来源会话不存在')
    if (draft.kind === 'continue') {
      state.draft = null
      await sendMessage(parent, text)
      return
    }
    const session = await dshRpc('synapse:fork-session', { sessionId: parent.dshSessionId, atSeq: draft.atSeq })
    if (draft.anchorId !== undefined) rememberBranchAnchor(session.id, draft.anchorId)
    const result = await api(`/synapse/api/threads/${parent.id}/branch`, { method: 'POST', body: JSON.stringify({ title: text.slice(0, 42), dshSessionId: session.id, dshSessionTitle: session.title, position: branchPosition }) })
    if (state.workspace !== null && !state.workspace.threads.some(thread => thread.id === result.thread.id || thread.dshSessionId === result.thread.dshSessionId)) state.workspace.threads.push(result.thread)
    state.activeId = result.thread.id
    state.draft = null
    state.pendingReplies.set(result.thread.dshSessionId, { text, at: Date.now() })
    render()
    await dshRpc('synapse:send-message', { sessionId: result.thread.dshSessionId, text })
    void loadThreadHistory(result.thread)
    await refreshProjection()
  } catch (error) {
    if (draft.kind === 'branch') {
      state.pendingReplies.delete(state.workspace?.threads.find(thread => thread.id === state.activeId)?.dshSessionId)
      if (state.draft !== null) state.draft = { ...draft, sending: false }
    } else {
      state.draft = { ...draft, sending: false }
    }
    setError(error)
  }
}

function threadsById() { return new Map((state.workspace?.threads ?? []).map(thread => [thread.id, thread])) }

/**
 * A session archived in DSH must not keep drawing cards here: the canvas and
 * the sidebar both read this filtered list (issue #21 / #19). Threads without a
 * DSH session (canvas-only notes) are never hidden by DSH's state.
 */
function visibleThreads(threads) {
  if (state.archivedSessionIds.size === 0) return threads
  return threads.filter(thread => thread.dshSessionId === null || !state.archivedSessionIds.has(thread.dshSessionId))
}
function persistedMessagesFor(thread) { return state.historyBySession.get(thread.dshSessionId) ?? thread.messages ?? [] }

function pendingUserIndex(messages, pending) {
  // The stored copy may be a preview, so match by full length and by the
  // preview prefix instead of by exact text equality.
  return messages.findLastIndex(message => message.kind === 'user'
    && new Date(message.at).getTime() >= pending.at - 2_000
    && (message.text === pending.text
      || (typeof message.text === 'string' && pending.text.startsWith(message.text.replace(/…$/, '')))))
}

function settlePendingReply(thread, messages) {
  const pending = state.pendingReplies.get(thread.dshSessionId)
  if (pending === undefined) return false
  const userIndex = pendingUserIndex(messages, pending)
  if (userIndex === -1 || !messages.slice(userIndex + 1).some(message => message.kind === 'assistant')) return false
  state.pendingReplies.delete(thread.dshSessionId)
  return true
}

function messagesFor(thread) {
  // A runtime-context snapshot is internal DSH state, never a user turn.
  // Filter here as well as during persistence so existing saved workspaces
  // immediately render one question and its answer as one card.
  const stored = persistedMessagesFor(thread).filter(message => !(message.kind === 'user' && typeof message.text === 'string' && message.text.trimStart().startsWith('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.')))
  // Swap in hydrated bodies where present: the stored text is only a preview.
  const bodies = state.bodies.get(thread.id)
  const messages = bodies === undefined || bodies.size === 0
    ? stored
    : stored.map(message => {
      const body = bodies.get(message.sourceSeq)
      return body === undefined ? message : { ...message, text: body.text, process: Array.isArray(body.process) ? body.process : message.process, truncated: body.truncated === true, hydrated: true }
    })
  const pending = state.pendingReplies.get(thread.dshSessionId)
  if (pending === undefined) return messages
  if (settlePendingReply(thread, messages)) {
    state.liveReplies.delete(thread.dshSessionId)
    return messages
  }
  const liveReply = state.liveReplies.get(thread.dshSessionId)
  const liveAssistant = liveReply?.running ? { kind: 'assistant', text: liveReply.text, pending: true, at: new Date().toISOString() } : { kind: 'assistant', text: '', pending: true, at: new Date().toISOString() }
  const userIndex = pendingUserIndex(messages, pending)
  if (userIndex !== -1) return [...messages, liveAssistant]
  return [...messages, { kind: 'user', text: pending.text, pending: true, at: new Date(pending.at).toISOString() }, liveAssistant]
}

function latestMessage(thread, kind) { return [...messagesFor(thread)].reverse().find(message => message.kind === kind) }
function questionFor(thread) { return latestMessage(thread, 'user')?.text ?? thread.dshSessionTitle ?? '等待用户提问' }
function answerFor(thread) { return latestMessage(thread, 'assistant') ?? null }

function inlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
}

const tableCells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())

const isTableDelimiter = line => {
  const cells = tableCells(line)
  return cells.length > 0 && cells.every(cell => /^:?-+:?$/.test(cell))
}

function markdownBlock(text) {
  const lines = text.split('\n')
  const output = []
  for (let index = 0; index < lines.length;) {
    const line = lines[index]
    if (line.trim() === '') { index++; continue }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line)
    if (heading !== null) {
      const level = heading[1].length
      output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`)
      index++
      continue
    }
    const unordered = /^[-*+]\s+(.+)$/.exec(line)
    const ordered = /^\d+[.)]\s+(.+)$/.exec(line)
    if (unordered !== null || ordered !== null) {
      const matcher = unordered === null ? /^\d+[.)]\s+(.+)$/ : /^[-*+]\s+(.+)$/
      const items = []
      while (index < lines.length) {
        const item = matcher.exec(lines[index])
        if (item === null) break
        items.push(`<li>${inlineMarkdown(item[1])}</li>`)
        index++
      }
      output.push(`<${unordered === null ? 'ol' : 'ul'}>${items.join('')}</${unordered === null ? 'ol' : 'ul'}>`)
      continue
    }
    // GFM table: a leading-pipe header row followed by a |-delimiter row,
    // then any number of leading-pipe body rows.
    if (/^\s*\|/.test(line) && index + 1 < lines.length && isTableDelimiter(lines[index + 1])) {
      const header = line
      const body = []
      index += 2
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
        body.push(lines[index])
        index++
      }
      output.push(`<table><thead><tr>${tableCells(header).map(cell => `<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${body.map(row => `<tr>${tableCells(row).map(cell => `<td>${inlineMarkdown(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`)
      continue
    }
    const paragraph = []
    while (index < lines.length && lines[index].trim() !== '' && !/^(#{1,3})\s+/.test(lines[index]) && !/^[-*+]\s+/.test(lines[index]) && !/^\d+[.)]\s+/.test(lines[index])) paragraph.push(lines[index++])
    // A marker-only line such as PowerShell's "+ " diagnostic is neither a
    // list item nor paragraph content under the rules above. Consume it so
    // the parser always makes progress.
    if (paragraph.length === 0) paragraph.push(lines[index++])
    output.push(`<p>${paragraph.map(inlineMarkdown).join('<br>')}</p>`)
  }
  return output.join('')
}

// Markdown parsing is pure CPU and repeats for every card on every canvas
// rebuild; cache the rendered HTML by input text so stable answers are never
// re-parsed. Bounded: streaming partial texts churn keys, so evict oldest.
const markdownCache = new Map()
const MARKDOWN_CACHE_LIMIT = 5000
function renderMarkdown(text) {
  const key = String(text)
  const cached = markdownCache.get(key)
  if (cached !== undefined) return cached
  const parts = key.split(/```/)
  const rendered = parts.map((part, index) => index % 2 === 1
    ? `<pre><code>${escapeHtml(part.replace(/^\w*\n/, ''))}</code></pre>`
    : markdownBlock(part)).join('')
  if (markdownCache.size >= MARKDOWN_CACHE_LIMIT) markdownCache.delete(markdownCache.keys().next().value)
  markdownCache.set(key, rendered)
  return rendered
}

function overlapsCard(position, other) {
  return position.x < other.x + CARD_WIDTH && position.x + CARD_WIDTH > other.x
    && position.y < other.y + CARD_HEIGHT && position.y + CARD_HEIGHT > other.y
}

function firstAvailableCardPosition(position, occupied) {
  const candidate = { x: Math.round(position.x), y: Math.max(82, Math.round(position.y)) }
  while (true) {
    const collisions = occupied.filter(other => overlapsCard(candidate, other))
    if (collisions.length === 0) return candidate
    candidate.y = Math.max(...collisions.map(other => other.y + CARD_HEIGHT + CARD_GAP_Y))
  }
}

function connectorPath(fromPosition, toPosition) {
  const fromX = fromPosition.x + CARD_WIDTH
  const fromY = fromPosition.y + CARD_HEIGHT / 2
  const toX = toPosition.x
  const toY = toPosition.y + CARD_HEIGHT / 2
  const bend = Math.min(110, Math.max(36, Math.abs(toX - fromX) * .2))
  return `M ${fromX} ${fromY} C ${fromX + bend} ${fromY}, ${toX - bend} ${toY}, ${toX} ${toY}`
}

function connectorPathFromElements(fromCard, toCard) {
  const fromX = Number.parseFloat(fromCard.style.left) + CARD_WIDTH
  const fromY = Number.parseFloat(fromCard.style.top) + CARD_HEIGHT / 2
  const toX = Number.parseFloat(toCard.style.left)
  const toY = Number.parseFloat(toCard.style.top) + CARD_HEIGHT / 2
  if (![fromX, fromY, toX, toY].every(Number.isFinite)) return null
  const bend = Math.min(110, Math.max(36, Math.abs(toX - fromX) * .2))
  return `M ${fromX} ${fromY} C ${fromX + bend} ${fromY}, ${toX - bend} ${toY}, ${toX} ${toY}`
}

function selectorValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

// Connector paths are rebuilt together with the canvas DOM; cache the mapping
// from card id to its incident paths so dragging never scans the whole SVG.
let connectorPathsByCard = new Map()
function cacheCardConnectors() {
  connectorPathsByCard = new Map()
  const viewport = document.querySelector('.canvas-viewport')
  if (!(viewport instanceof HTMLElement)) return
  for (const path of viewport.querySelectorAll('.connectors path[data-from]')) {
    const fromId = path.getAttribute('data-from')
    const toId = path.getAttribute('data-to')
    if (fromId === null || toId === null) continue
    for (const id of [fromId, toId]) {
      const paths = connectorPathsByCard.get(id)
      if (paths === undefined) connectorPathsByCard.set(id, new Set([path]))
      else paths.add(path)
    }
  }
}

function refreshCardConnectors(cardId) {
  const paths = connectorPathsByCard.get(cardId)
  if (paths === undefined || paths.size === 0) return
  const byId = state.canvasCardsById
  if (byId === undefined) return
  for (const path of paths) {
    const fromId = path.getAttribute('data-from')
    const toId = path.getAttribute('data-to')
    if (fromId === null || toId === null) continue
    const fromCard = byId.get(fromId)
    const toCard = byId.get(toId)
    if (fromCard === undefined || toCard === undefined) continue
    // Data-driven endpoints: the counterpart card may be unmounted (outside
    // the viewport) but its position is still authoritative.
    path.setAttribute('d', connectorPath(fromCard.position, toCard.position))
  }
}

function initialCanvasCamera(cards) {
  const draft = state.draft?.kind === 'new' ? { id: 'draft:new', position: { x: 86, y: 82 } } : draftPlacement(cards)
  // Focus the active conversation's latest turn, not its first: after many
  // rounds the canvas should open where work is happening, at the newest card.
  const activeCards = state.activeId === null || state.activeId === undefined ? [] : cards.filter(card => card.dshThreadId === state.activeId)
  const active = activeCards.at(-1)
  const focus = draft ?? active ?? cards[0]
  const position = focus?.position
  if (position === undefined) return { x: 0, y: 0 }
  return { x: CAMERA_INSET_X - position.x * state.zoom, y: CAMERA_INSET_Y - position.y * state.zoom }
}

function placeConversationCards(cards) {
  const saved = new Map(cards.flatMap(card => {
    if (card.positionLocked !== true) return []
    const position = state.cardPositions.get(card.id) ?? state.cardPositions.get(card.positionKey)
    return position === undefined ? [] : [[card.id, { x: position.x, y: position.y }]]
  }))
  const occupied = []
  for (const card of cards) {
    const position = saved.get(card.id)
    if (position !== undefined) {
      card.position = position
      continue
    }
    card.position = firstAvailableCardPosition(card.naturalPosition ?? card.position, occupied)
    occupied.push(card.position)
  }
  return cards
}

function layoutConversationGraph(cards, threads) {
  const childrenByThread = new Map()
  for (const thread of threads) {
    if (thread.parentId === null) continue
    const children = childrenByThread.get(thread.parentId) ?? []
    children.push(thread.id)
    childrenByThread.set(thread.parentId, children)
  }
  const laneByThread = new Map()
  const visitThread = threadId => {
    if (laneByThread.has(threadId)) return
    laneByThread.set(threadId, laneByThread.size)
    for (const childId of childrenByThread.get(threadId) ?? []) visitThread(childId)
  }
  for (const thread of threads) if (thread.parentId === null) visitThread(thread.id)
  for (const thread of threads) visitThread(thread.id)

  const byId = new Map(cards.map(card => [card.id, card]))
  const positioned = new Map()
  const positionFor = (card, visiting = new Set()) => {
    if (positioned.has(card.id)) return positioned.get(card.id)
    if (visiting.has(card.id)) return { x: 86, y: 82 + (laneByThread.get(card.dshThreadId) ?? 0) * (CARD_HEIGHT + CARD_GAP_Y) }
    visiting.add(card.id)
    const parent = card.parentId === null ? undefined : byId.get(card.parentId)
    const parentPosition = parent === undefined ? undefined : positionFor(parent, visiting)
    const position = {
      x: parentPosition === undefined ? 86 : parentPosition.x + 365,
      y: 82 + (laneByThread.get(card.dshThreadId) ?? 0) * (CARD_HEIGHT + CARD_GAP_Y),
    }
    visiting.delete(card.id)
    positioned.set(card.id, position)
    return position
  }
  for (const card of cards) {
    card.naturalPosition = positionFor(card)
    if (!card.positionLocked) card.position = card.naturalPosition
  }
  return placeConversationCards(cards)
}

function conversationCards(threads) {
  const cards = []
  const cardsByThread = new Map()
  for (const thread of threads) {
    const messages = messagesFor(thread)
    const turns = []
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
      const question = messages[messageIndex]
      if (question.kind !== 'user') continue
      const replies = []
      const errors = []
      let processCount = 0
      for (let replyIndex = messageIndex + 1; replyIndex < messages.length; replyIndex++) {
        const reply = messages[replyIndex]
        if (reply.kind === 'user') break
        if (reply.kind === 'assistant') replies.push(reply)
        if (reply.kind === 'error') errors.push(reply)
        if (Array.isArray(reply.process)) processCount += reply.process.length
        else if (reply.kind === 'tool') processCount += 1
      }
      const answer = replies.at(-1) ?? null
      const error = errors.at(-1) ?? null
      const turnIndex = turns.length
      const id = `${thread.id}:turn:${question.sourceSeq ?? messageIndex}`
      const previous = turns.at(-1)
      const positionKey = `${thread.id}:turn-index:${turnIndex}`
      const naturalPosition = previous === undefined ? { x: 86, y: 82 } : { x: previous.naturalPosition.x + 365, y: previous.naturalPosition.y }
      const savedPosition = state.cardPositions?.get(positionKey) ?? state.cardPositions?.get(id)
      const positionLocked = savedPosition !== undefined
      const position = positionLocked ? savedPosition : naturalPosition
      turns.push({
        id,
        positionKey,
        dshThreadId: thread.id,
        sourceParentId: thread.parentId,
        parentId: null,
        sourceSeq: question.sourceSeq,
        turnIndex,
        naturalPosition,
        position,
        positionLocked,
        question: question.text,
        questionMessage: question,
        answer,
        error,
        processCount,
      })
    }
    const liveReply = state.liveReplies.get(thread.dshSessionId)
    const latestTurn = turns.at(-1)
    if (liveReply?.running && latestTurn !== undefined && (latestTurn.answer === null || latestTurn.answer.pending === true)) latestTurn.answer = { kind: 'assistant', text: liveReply.text, pending: true, at: new Date().toISOString() }
    if (turns.length === 0) {
      const id = `${thread.id}:turn:empty`
      const positionKey = `${thread.id}:turn-index:0`
      const naturalPosition = { x: 86, y: 82 }
      const savedPosition = state.cardPositions?.get(positionKey) ?? state.cardPositions?.get(id)
      const positionLocked = savedPosition !== undefined
      turns.push({
      id,
      positionKey,
      dshThreadId: thread.id,
      sourceParentId: thread.parentId,
      parentId: null,
      sourceSeq: undefined,
      turnIndex: 0,
      naturalPosition,
      position: positionLocked ? savedPosition : naturalPosition,
      positionLocked,
      question: thread.dshSessionTitle ?? thread.title,
      answer: null,
      error: null,
      processCount: 0,
      })
    }
    turns.at(-1).canContinue = true
    cardsByThread.set(thread.id, turns)
    cards.push(...turns)
  }
  for (const card of cards) {
    const siblings = cardsByThread.get(card.dshThreadId)
    if (card.turnIndex > 0) card.parentId = siblings[card.turnIndex - 1].id
    else {
      const parentCards = cardsByThread.get(card.sourceParentId)
      const sourceThread = threads.find(thread => thread.id === card.dshThreadId)
      const firstChildQuestion = siblings?.[0]
      const seedLength = sourceThread?.sourceSeedLength ?? firstChildQuestion?.sourceSeq
      // A fork inherits every parent event before DSH's durable seed boundary.
      // The latest parent question below that boundary is the exact Turn where
      // this child was born. Canvas coordinates never participate in lineage.
      const inheritedTurn = Number.isSafeInteger(seedLength)
        ? parentCards?.filter(candidate => Number.isInteger(candidate.sourceSeq) && candidate.sourceSeq < seedLength).at(-1)
        : undefined
      card.parentId = state.branchAnchors.get(card.dshThreadId) ?? inheritedTurn?.id ?? null
    }
  }
  return layoutConversationGraph(cards, threads)
}

function conversationGraphView(cards, collapsedCardIds = state.collapsedCardIds) {
  const cardIds = new Set(cards.map(card => card.id))
  const childrenByParent = new Map()
  for (const card of cards) {
    if (card.parentId === null || !cardIds.has(card.parentId)) continue
    const children = childrenByParent.get(card.parentId) ?? []
    children.push(card.id)
    childrenByParent.set(card.parentId, children)
  }

  const hiddenIds = new Set()
  for (const rootId of collapsedCardIds) {
    if (!cardIds.has(rootId)) continue
    const visited = new Set([rootId])
    const visit = parentId => {
      for (const childId of childrenByParent.get(parentId) ?? []) {
        if (visited.has(childId)) continue
        visited.add(childId)
        hiddenIds.add(childId)
        visit(childId)
      }
    }
    visit(rootId)
  }

  // Persisted collapse roots must remain visible even if malformed metadata
  // contains a cycle where two collapsed nodes otherwise hide each other.
  for (const rootId of collapsedCardIds) hiddenIds.delete(rootId)

  // Post-order accumulation: each card's descendant count is 1 + the sum of
  // its children's subtree sizes, so the whole graph is O(n) instead of a BFS
  // from every card (O(n²) on deep chains). Malformed parent cycles are
  // detected through the DFS path: every member of a cycle reaches every other
  // member plus the union of their off-cycle subtrees, so when the cycle entry
  // pops last, all members are settled to (cycleSize - 1) + off-cycle total,
  // which matches the per-card BFS' unique-descendant count.
  const descendantCounts = new Map()
  const inStack = new Set()
  for (const card of cards) {
    if (descendantCounts.has(card.id)) continue
    const stack = [{ id: card.id, children: childrenByParent.get(card.id) ?? [], index: 0 }]
    const path = [card.id]
    let cycleEntry = null
    let cycleMembers = null
    let cycleOffCycleTotal = 0
    inStack.add(card.id)
    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      if (top.index < top.children.length) {
        const childId = top.children[top.index++]
        if (descendantCounts.has(childId)) continue
        if (inStack.has(childId)) {
          // Back edge: the nodes from childId up to top.id form a cycle.
          cycleEntry = childId
          cycleMembers = new Set(path.slice(path.indexOf(childId)))
          cycleOffCycleTotal = 0
          continue
        }
        inStack.add(childId)
        path.push(childId)
        stack.push({ id: childId, children: childrenByParent.get(childId) ?? [], index: 0 })
      } else {
        stack.pop()
        path.pop()
        inStack.delete(top.id)
        let count = 0
        for (const childId of top.children) {
          if (cycleMembers !== null && cycleMembers.has(childId)) continue // ring edge; base count added below
          count += 1 + (descendantCounts.get(childId) ?? 0)
        }
        if (cycleMembers !== null && cycleMembers.has(top.id)) cycleOffCycleTotal += count
        if (cycleMembers !== null && top.id === cycleEntry) {
          // All cycle members have popped (the entry pops last in post-order);
          // settle them so ancestors popping next read the final counts.
          const base = cycleMembers.size - 1
          for (const id of cycleMembers) descendantCounts.set(id, base + cycleOffCycleTotal)
          cycleEntry = null
          cycleMembers = null
        } else {
          descendantCounts.set(top.id, count)
        }
      }
    }
  }

  return {
    cards: cards.filter(card => !hiddenIds.has(card.id)),
    childCounts: new Map(cards.map(card => [card.id, childrenByParent.get(card.id)?.length ?? 0])),
    descendantCounts,
  }
}

function revealConversationThread(cards, threadId) {
  const byId = new Map(cards.map(card => [card.id, card]))
  let changed = false
  for (const target of cards.filter(card => card.dshThreadId === threadId)) {
    const visited = new Set([target.id])
    let parentId = target.parentId
    while (parentId !== null && !visited.has(parentId)) {
      visited.add(parentId)
      if (state.collapsedCardIds.delete(parentId)) changed = true
      parentId = byId.get(parentId)?.parentId ?? null
    }
  }
  if (changed) persistCollapsedCards()
}

function canvasConnectors(cards) {
  const index = new Map(cards.map(card => [card.id, card]))
  const links = cards.map(card => {
    const parent = card.parentId === null ? null : index.get(card.parentId)
    if (parent === undefined || parent === null) return ''
    const active = card.dshThreadId === state.activeId && parent.dshThreadId === state.activeId ? ' active-connector' : ''
    return `<path class="${active.trim()}" data-from="${escapeHtml(parent.id)}" data-to="${escapeHtml(card.id)}" d="${connectorPath(parent.position, card.position)}"></path>`
  })
  const placement = draftPlacement(cards)
  if (placement !== null) {
    links.push(`<path class="draft-connector" data-from="${escapeHtml(placement.parent.id)}" data-to="draft" d="${connectorPath(placement.parent.position, placement.position)}"></path>`)
  }
  return links.join('')
}

function conversationCard(card, graph) {
  const selected = card.id === state.selectedCardId || state.selectedCardKeys.has(cardPositionKey(card)) ? 'selected' : ''
  const source = card.parentId === null ? 'DSH 会话' : card.turnIndex === 0 ? 'DSH 分支' : '追问'
  const continueButton = card.canContinue === true
    ? `<button class="graph-continue-button" data-action="open-continue" data-thread="${card.dshThreadId}" data-card="${escapeHtml(card.id)}" aria-label="添加追问" title="添加追问"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M8 3.5v9M3.5 8h9"/></svg></button>`
    : ''
  const childCount = graph.childCounts.get(card.id) ?? 0
  const collapsed = state.collapsedCardIds.has(card.id)
  const foldLabel = collapsed ? '展开后续对话' : '折叠后续对话'
  const foldButton = childCount === 0 || card.canContinue === true ? '' : `<button class="graph-fold-button${collapsed ? ' collapsed' : ''}" data-action="toggle-card-children" data-card="${escapeHtml(card.id)}" aria-expanded="${collapsed ? 'false' : 'true'}" aria-label="${foldLabel}" title="${foldLabel}"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M3.5 8h9"/>${collapsed ? '<path d="M8 3.5v9"/>' : ''}</svg></button>`
  const branchButton = childCount === 0 || card.canContinue === true || !Number.isInteger(card.answer?.sourceSeq) ? '' : `<button class="graph-branch-button" data-action="open-branch" data-thread="${card.dshThreadId}" data-card="${escapeHtml(card.id)}" data-seq="${card.answer.sourceSeq}" aria-label="在新对话中分支" title="在新对话中分支"><svg aria-hidden="true" viewBox="0 0 16 16"><path fill-rule="evenodd" clip-rule="evenodd" d="M13.0762 1.37207C14.0846 1.37228 14.9021 2.19077 14.9023 3.19922C14.9022 4.20772 14.0847 5.02518 13.0762 5.02539C12.2967 5.02539 11.6325 4.53691 11.3701 3.84961H4.35547C4.79397 4.26458 5.15861 4.7644 5.41699 5.33496L7.10645 9.06738C7.88526 10.7875 9.55104 11.9228 11.4189 12.0371C11.7085 11.4109 12.3411 10.9756 13.0762 10.9756C14.0843 10.9759 14.9023 11.7936 14.9023 12.8018C14.9023 13.81 14.0843 14.6277 13.0762 14.6279C12.2534 14.6279 11.5574 14.0832 11.3291 13.335C8.9868 13.1879 6.89981 11.7612 5.92285 9.60352L4.23242 5.87109C3.67503 4.64033 2.44878 3.84961 1.09766 3.84961V2.54883C1.10665 2.54883 1.11601 2.54975 1.125 2.5498L11.3701 2.54883C11.6326 1.86151 12.2969 1.37207 13.0762 1.37207ZM13.0762 12.2764C12.7858 12.2764 12.5508 12.5114 12.5508 12.8018C12.5508 13.0921 12.7858 13.3281 13.0762 13.3281C13.3664 13.3279 13.6025 13.092 13.6025 12.8018C13.6025 12.5115 13.3664 12.2766 13.0762 12.2764ZM13.0762 2.67285C12.7855 2.67285 12.55 2.90861 12.5498 3.19922C12.5499 3.48987 12.7855 3.72559 13.0762 3.72559C13.3667 3.72538 13.6024 3.48975 13.6025 3.19922C13.6023 2.90874 13.3666 2.67306 13.0762 2.67285Z" fill="currentColor"/></svg></button>`
  return `<article class="thread-card ${selected}" data-card-id="${escapeHtml(card.id)}" data-position-key="${escapeHtml(card.positionKey)}" data-thread="${card.dshThreadId}" style="left:${card.position.x}px;top:${card.position.y}px;--thread-color:#3478f6">
    <button class="node-handle" data-drag-card="${card.id}" aria-label="拖动 ${escapeHtml(card.question)}" title="拖动卡片"></button>
    ${continueButton}${foldButton}${branchButton}
    <div class="thread-card-head"><span class="topic-dot"></span><button class="thread-title" data-action="show-thread" data-thread="${card.dshThreadId}" data-card="${escapeHtml(card.id)}" title="查看完整会话：${escapeHtml(card.question)}">${escapeHtml(card.question)}</button></div>
    <div class="thread-meta"><span>${source}</span><span>第 ${card.turnIndex + 1} 轮</span>${card.error === null ? '' : '<span class="card-error-status">失败</span>'}${card.processCount > 0 ? `<span class="card-process-count">工具 ${card.processCount}</span>` : ''}</div>
    <div class="thread-answer">${card.answer === null ? (card.error === null ? '<p class="thread-answer-empty">等待助手回复</p>' : '') : card.answer.pending && card.answer.text === '' ? '<p class="thread-answer-pending">正在回复</p>' : `${renderMarkdown(card.answer.text)}${card.answer.pending ? '<p class="thread-answer-pending">正在回复</p>' : ''}`}${card.error === null ? '' : `<p class="thread-answer-error" title="${escapeHtml(card.error.text)}">本轮失败：${escapeHtml(card.error.text)}</p>`}</div>
    <footer><button data-action="show-thread" data-thread="${card.dshThreadId}" data-card="${escapeHtml(card.id)}" title="查看完整会话" aria-label="查看完整会话"><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2 8.5 8 2.5l6 6V13.5a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5Z"/><path d="M6.2 14v-3.6a1.8 1.8 0 0 1 3.6 0V14" /></svg>详情</button><button data-action="open-dsh" data-thread="${card.dshThreadId}" data-seq="${Number.isInteger(card.sourceSeq) ? card.sourceSeq : ''}" title="在 DSH 中打开" aria-label="在 DSH 中打开"><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3.5H4.5A1.5 1.5 0 0 0 3 5v6.5A1.5 1.5 0 0 0 4.5 13H11a1.5 1.5 0 0 0 1.5-1.5V9"/><path d="M9.5 3.5h3v3M12.4 3.6 7.5 8.5"/></svg>DSH</button><button data-action="archive-thread" data-thread="${card.dshThreadId}" title="归档此会话" aria-label="归档此会话"><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 5h11M5.5 7v5.5a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1V7"/><path d="M4 5 5 2.8a.7.7 0 0 1 .6-.4h4.8a.7.7 0 0 1 .6.4L12 5M6 9.5h4"/></svg>归档</button></footer>
  </article>`
}

function draftActions(draft) {
  const disabled = draft.sending ? 'disabled' : ''
  return `<div class="draft-actions"><button type="button" data-action="cancel-draft" ${disabled} aria-label="取消" title="取消"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg></button><button class="primary" type="submit" ${disabled} aria-label="发送" title="发送"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7"/></svg></button></div>`
}

function quickPhraseEditor(draft) {
  const disabled = draft.sending ? 'disabled' : ''
  const phrases = state.quickPhrases.map((phrase, index) => `<div class="draft-quick-phrase-editor-row"><input data-quick-phrase-index="${index}" maxlength="${MAX_QUICK_PHRASE_LENGTH}" value="${escapeHtml(phrase)}" aria-label="快捷词 ${index + 1}" ${disabled}><button type="button" data-action="remove-quick-phrase" data-quick-phrase-index="${index}" aria-label="删除 ${escapeHtml(phrase)}" title="删除" ${disabled}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg></button></div>`).join('')
  return `<section class="draft-quick-editor" aria-label="编辑快捷词"><div class="draft-quick-editor-list">${phrases}</div><div class="draft-quick-phrase-add"><input maxlength="${MAX_QUICK_PHRASE_LENGTH}" placeholder="添加快捷词" aria-label="添加快捷词" ${disabled}><button class="primary" type="button" data-action="add-quick-phrase" aria-label="添加快捷词" title="添加快捷词" ${disabled}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg></button></div><button class="draft-quick-editor-close" type="button" data-action="close-quick-phrase-editor" ${disabled}>完成</button></section>`
}

function draftQuickPhrases(draft) {
  const disabled = draft.sending ? 'disabled' : ''
  if (state.quickPhraseEditorOpen) return quickPhraseEditor(draft)
  const phrases = state.quickPhrases.map(phrase => `<button class="draft-quick-phrase" type="button" data-action="insert-quick-phrase" data-quick-phrase="${escapeHtml(phrase)}" ${disabled}>${escapeHtml(phrase)}</button>`).join('')
  return `<div class="draft-quick-phrases" aria-label="常用补充词">${phrases}<button class="draft-quick-phrase-add-button" type="button" data-action="open-quick-phrase-editor" aria-label="管理快捷词" title="管理快捷词" ${disabled}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg></button></div>`
}

function insertQuickPhrase(phrase) {
  const input = document.querySelector('[data-draft] textarea')
  if (!(input instanceof HTMLTextAreaElement) || state.draft === null) return
  const start = input.selectionStart
  const end = input.selectionEnd
  const prefix = input.value.slice(0, start)
  const suffix = input.value.slice(end)
  const separator = prefix !== '' && !prefix.endsWith('\n') ? '\n' : ''
  const text = `${prefix}${separator}${phrase}${suffix}`
  if (text.length > input.maxLength) return setError('追问内容不能超过 4000 个字符')
  const caret = prefix.length + separator.length + phrase.length
  input.value = text
  state.draft.text = text
  input.focus()
  input.setSelectionRange(caret, caret)
}

function addQuickPhrase(value) {
  const phrase = value.trim().slice(0, MAX_QUICK_PHRASE_LENGTH)
  if (phrase === '') return false
  if (state.quickPhrases.includes(phrase)) return setError('这个快捷词已经存在')
  if (state.quickPhrases.length >= MAX_QUICK_PHRASES) return setError(`最多保留 ${MAX_QUICK_PHRASES} 个快捷词`)
  state.quickPhrases.push(phrase)
  persistQuickPhrases()
  return true
}

function updateQuickPhrase(index, value) {
  if (!Number.isInteger(index) || index < 0 || index >= state.quickPhrases.length) return
  const phrase = value.trim().slice(0, MAX_QUICK_PHRASE_LENGTH)
  if (phrase === '') {
    state.quickPhrases.splice(index, 1)
  } else if (state.quickPhrases.some((item, itemIndex) => itemIndex !== index && item === phrase)) {
    return setError('这个快捷词已经存在')
  } else {
    state.quickPhrases[index] = phrase
  }
  persistQuickPhrases()
  render()
}

function draftPlacement(cards) {
  const draft = state.draft
  if (draft === null || draft.kind === 'new') return null
  const parent = draft.anchorId === undefined
    ? cards.filter(card => card.dshThreadId === draft.parentId).at(-1)
    : cards.find(card => card.id === draft.anchorId)
  if (parent === undefined) return null
  return { parent, position: firstAvailableCardPosition({ x: parent.position.x + 365, y: parent.position.y }, cards.map(card => card.position)) }
}

function draftCard(cards) {
  const draft = state.draft
  if (draft?.kind === 'new') return `<article class="thread-card draft-card first-session-card" data-card-id="draft" style="left:86px;top:82px;--thread-color:#3478f6">
    <div class="thread-card-head"><span class="topic-dot"></span><strong>新会话</strong></div>
    <form class="draft-branch-form" data-draft><textarea maxlength="4000" placeholder="输入第一条消息" ${draft.sending ? 'disabled' : ''}>${escapeHtml(draft.text)}</textarea>${draftActions(draft)}</form>
  </article>`
  const placement = draftPlacement(cards)
  if (draft === null || placement === null) return ''
  const continuing = draft.kind === 'continue'
  return `<article class="thread-card draft-card" data-card-id="draft" style="left:${placement.position.x}px;top:${placement.position.y}px;--thread-color:#3478f6">
    <div class="thread-card-head"><span class="topic-dot"></span><strong>${continuing ? '新的追问' : '新的分支'}</strong></div>
    <form class="draft-branch-form" data-draft>${draftQuickPhrases(draft)}<textarea maxlength="4000" placeholder="${continuing ? '输入追问' : '输入这个分支的新问题'}" ${draft.sending ? 'disabled' : ''}>${escapeHtml(draft.text)}</textarea>${draftActions(draft)}</form>
  </article>`
}

function selectionFollowupButton() {
  return `<button class="selection-followup" type="button" data-action="follow-selection" hidden aria-label="基于所选内容创建追问" title="基于所选内容追问"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M3 3.5h10v6.25H7.2L4 12.5V9.75H3Z"/><path d="M8 4.9v3.4M6.3 6.6h3.4"/></svg><span>追问</span></button>`
}

// Cards are mounted into the DOM only when they intersect the viewport
// (inflated by VIEWPORT_MARGIN) in world coordinates. The camera transform is
// translate(camera) scale(zoom), so screen = world * zoom + camera.
function visibleCardIds(cards) {
  const viewport = document.querySelector('.canvas-viewport')
  if (!(viewport instanceof HTMLElement)) return new Set(cards.map(card => card.id))
  const bounds = viewport.getBoundingClientRect()
  const left = (-state.canvasCamera.x - VIEWPORT_MARGIN) / state.zoom
  const right = (bounds.width - state.canvasCamera.x + VIEWPORT_MARGIN) / state.zoom
  const top = (-state.canvasCamera.y - VIEWPORT_MARGIN) / state.zoom
  const bottom = (bounds.height - state.canvasCamera.y + VIEWPORT_MARGIN) / state.zoom
  const visible = new Set()
  for (const card of cards) {
    const { x, y } = card.position
    if (x + CARD_WIDTH < left || x > right || y + CARD_HEIGHT < top || y > bottom) continue
    visible.add(card.id)
  }
  return visible
}

// Incrementally mount cards entering the viewport and unmount cards leaving
// it, without rebuilding the canvas. Called after pan/zoom/focus camera moves.
function syncCanvasViewport() {
  if (state.mode !== 'canvas' || state.canvasCards === undefined) return
  const layer = document.querySelector('.cards-layer')
  if (!(layer instanceof HTMLElement)) return
  const visible = visibleCardIds(state.canvasCards)
  for (const cardId of [...state.mountedCardIds]) {
    if (visible.has(cardId)) continue
    const element = layer.querySelector(`[data-card-id="${selectorValue(cardId)}"]`)
    if (element instanceof HTMLElement) element.remove()
    state.mountedCardIds.delete(cardId)
  }
  for (const card of state.canvasCards) {
    if (!visible.has(card.id) || state.mountedCardIds.has(card.id)) continue
    const wrapper = document.createElement('div')
    wrapper.innerHTML = conversationCard(card, state.canvasGraph)
    const element = wrapper.firstElementChild
    if (element instanceof HTMLElement) {
      layer.appendChild(element)
      const handle = element.querySelector('[data-drag-card]')
      if (handle instanceof HTMLElement) bindDragHandle(handle)
    }
    state.mountedCardIds.add(card.id)
  }
}

// --- canvas nodes: pure helpers (unit-tested by test/canvas-nodes.test.js) ---
// Everything in this block is dependency-free: the test evaluates it in a bare
// `vm` context, exactly like conversation-cards.test.js does for app.js:606-956.
// Do not reference document/state/localStorage/Host helpers from here.
const MAX_NOTE_LENGTH = 4000
const MAX_TITLE_LENGTH = 120
const MIN_NODE_WIDTH = 80
const MIN_NODE_HEIGHT = 60
const NODE_COORD_MIN = -2000
const NODE_COORD_MAX = 5000
const NODE_DEFAULT_WIDTH = 240
const NODE_DEFAULT_HEIGHT = 150
const IMAGE_DEFAULT_WIDTH = 320
const MAX_IMAGE_EDGE = 1600
const IMAGE_WEBP_QUALITY = 0.82
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const CARD_POSITION_SYNC_DELAY = 400
const ASSET_PATH_PREFIX = '/synapse/api/assets/'
const NODE_RESIZE_CORNER = 18
const DEFAULT_SHAPE_WIDTH = 180
const DEFAULT_SHAPE_HEIGHT = 120
const DEFAULT_ARROW_LENGTH = 200
const SHAPE_DRAG_THRESHOLD = 4
const ARROW_MARKER_ID = 'synapse-arrow-head'

/** Round and clamp a world coordinate into the range the Host accepts. */
function clampNodeCoordinate(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.min(NODE_COORD_MAX, Math.max(NODE_COORD_MIN, Math.round(number)))
}

/** Clamp a node dimension; the contract fixes an 80x60 floor. */
function clampNodeDimension(value, minimum = MIN_NODE_WIDTH) {
  const floor = Number.isFinite(minimum) ? minimum : MIN_NODE_WIDTH
  const number = Number(value)
  if (!Number.isFinite(number)) return floor
  return Math.max(floor, Math.round(number))
}

/** Contain an image inside `maxEdge` (long edge) and never upscale it. */
function fitImageSize(width, height, maxEdge = MAX_IMAGE_EDGE) {
  const sourceWidth = Math.max(1, Math.round(Number(width) || 1))
  const sourceHeight = Math.max(1, Math.round(Number(height) || 1))
  const requested = Number(maxEdge)
  const limit = Number.isFinite(requested) && requested > 0 ? Math.round(requested) : MAX_IMAGE_EDGE
  const scale = Math.min(1, limit / Math.max(sourceWidth, sourceHeight))
  return { width: Math.max(1, Math.round(sourceWidth * scale)), height: Math.max(1, Math.round(sourceHeight * scale)), scale }
}

/** Size an image node: fit the long edge first, then the display box width. */
function fitImageDisplaySize(width, height, maxWidth = IMAGE_DEFAULT_WIDTH) {
  const contained = fitImageSize(width, height, MAX_IMAGE_EDGE)
  const requested = Number(maxWidth)
  const limit = Number.isFinite(requested) && requested > 0 ? Math.round(requested) : IMAGE_DEFAULT_WIDTH
  const scale = Math.min(1, limit / contained.width)
  // `object-fit: contain` letterboxes inside the node box, so clamping the box
  // dimensions independently never distorts the bitmap.
  return {
    width: clampNodeDimension(contained.width * scale, MIN_NODE_WIDTH),
    height: clampNodeDimension(contained.height * scale, MIN_NODE_HEIGHT),
  }
}

/** The Host address of a stored image (`/synapse/api/assets/sha256:…`). */
function assetUrlFor(attachmentId) {
  return typeof attachmentId === 'string' && /^sha256:[0-9a-f]{64}$/.test(attachmentId) ? `${ASSET_PATH_PREFIX}${attachmentId}` : ''
}

/** Only bitmap formats are accepted; the Host rejects SVG (XSS). */
function isImageMediaType(mediaType) {
  return typeof mediaType === 'string' && IMAGE_MEDIA_TYPES.includes(mediaType.toLowerCase())
}

/** Cap note text at the contract limit without touching existing newlines. */
function normalizeNoteText(value) {
  const text = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value)
  return text.length <= MAX_NOTE_LENGTH ? text : text.slice(0, MAX_NOTE_LENGTH)
}

/** Frame titles are single-line and capped at 120 characters. */
function normalizeFrameTitle(value) {
  const title = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
  return title.length <= MAX_TITLE_LENGTH ? title : title.slice(0, MAX_TITLE_LENGTH)
}

/**
 * `${threadId}:turn-index:${turnIndex}` — the only stable card identity.
 * `conversationCards` derives `card.id` from the DSH `seq`, which changes once a
 * pending turn is committed, so host payloads must never key on the card id.
 */
function cardPositionKey(card) {
  if (card === null || typeof card !== 'object') return ''
  if (typeof card.positionKey === 'string' && card.positionKey !== '') return card.positionKey
  const threadId = typeof card.dshThreadId === 'string' ? card.dshThreadId : ''
  const turnIndex = Number.isInteger(card.turnIndex) ? card.turnIndex : 0
  return threadId === '' ? '' : `${threadId}:turn-index:${turnIndex}`
}

/** Normalized (positive) bounding box for any node type, line/arrow included. */
function nodeBounds(node) {
  if (node === null || typeof node !== 'object') return null
  if (node.type === 'shape' && (node.shape === 'line' || node.shape === 'arrow')) {
    const x1 = Number(node.x1)
    const y1 = Number(node.y1)
    const x2 = Number(node.x2)
    const y2 = Number(node.y2)
    if (![x1, y1, x2, y2].every(Number.isFinite)) return null
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) }
  }
  const x = Number(node.x)
  const y = Number(node.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  const width = Number(node.width)
  const height = Number(node.height)
  return {
    x,
    y,
    width: Number.isFinite(width) ? width : MIN_NODE_WIDTH,
    height: Number.isFinite(height) ? height : MIN_NODE_HEIGHT,
  }
}

/** Union of boxes, padded around and by `headerHeight` on top (frame layout). */
function boundsOfBoxes(boxes, padding = 0, headerHeight = 0) {
  const list = (Array.isArray(boxes) ? boxes : []).filter(box => box !== null && typeof box === 'object' && Number.isFinite(box.x) && Number.isFinite(box.y))
  if (list.length === 0) return null
  const left = Math.min(...list.map(box => box.x))
  const top = Math.min(...list.map(box => box.y))
  const right = Math.max(...list.map(box => box.x + (Number.isFinite(box.width) ? box.width : 0)))
  const bottom = Math.max(...list.map(box => box.y + (Number.isFinite(box.height) ? box.height : 0)))
  const pad = Number.isFinite(padding) ? Math.max(0, padding) : 0
  const header = Number.isFinite(headerHeight) ? Math.max(0, headerHeight) : 0
  return { x: left - pad, y: top - pad - header, width: right - left + pad * 2, height: bottom - top + pad * 2 + header }
}

/** Bounding box for a frame that groups cards and/or nodes (contract §4). */
function groupBoundsOf(cards, nodes, padding = 28, headerHeight = 34) {
  const boxes = []
  for (const card of Array.isArray(cards) ? cards : []) {
    if (card === null || typeof card !== 'object' || card.position === null || card.position === undefined) continue
    const position = card.position
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) continue
    boxes.push({ x: position.x, y: position.y, width: CARD_WIDTH, height: CARD_HEIGHT })
  }
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const bounds = nodeBounds(node)
    if (bounds !== null) boxes.push(bounds)
  }
  return boundsOfBoxes(boxes, padding, headerHeight)
}

/** Merge Host card positions over the local cache; the Host wins per key. */
function mergeCardPositions(localPairs, hostRecord) {
  const merged = new Map()
  const readable = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Number.isFinite(value.x) && Number.isFinite(value.y)
  for (const pair of Array.isArray(localPairs) ? localPairs : []) {
    if (!Array.isArray(pair) || typeof pair[0] !== 'string' || !readable(pair[1])) continue
    merged.set(pair[0], { x: Math.round(pair[1].x), y: Math.round(pair[1].y) })
  }
  const host = hostRecord !== null && typeof hostRecord === 'object' && !Array.isArray(hostRecord) ? hostRecord : {}
  for (const [key, value] of Object.entries(host)) {
    if (typeof key !== 'string' || key === '' || !readable(value)) continue
    merged.set(key, { x: Math.round(value.x), y: Math.round(value.y) })
  }
  return [...merged]
}

/**
 * Merge the Host node list with the local one: server nodes win by id, `tmp:`
 * nodes the client created optimistically survive until confirmed, and ids the
 * user just deleted are filtered out until the Host acknowledges the delete.
 */
function mergeWorkspaceNodes(existing, incoming, excludedIds = null) {
  // Accept any Set-like (a `Set` from another realm fails `instanceof`) or array.
  const excluded = excludedIds !== null && typeof excludedIds?.has === 'function'
    ? excludedIds
    : new Set(Array.isArray(excludedIds) ? excludedIds : [])
  const result = []
  const seen = new Set()
  const push = node => {
    if (node === null || typeof node !== 'object' || typeof node.id !== 'string' || node.id === '' || seen.has(node.id)) return
    if (excluded.has(node.id)) return
    seen.add(node.id)
    result.push(node)
  }
  for (const node of Array.isArray(incoming) ? incoming : []) push(node)
  for (const node of Array.isArray(existing) ? existing : []) {
    if (typeof node?.id !== 'string' || !node.id.startsWith('tmp:')) continue
    push(node)
  }
  return result
}

/** Next free frame title (`分组 N`), based on the titles already on the canvas. */
function nextFrameTitle(nodes) {
  let highest = 0
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node === null || typeof node !== 'object' || node.type !== 'frame' || typeof node.title !== 'string') continue
    const match = /^分组\s*(\d+)$/.exec(node.title.trim())
    if (match !== null) highest = Math.max(highest, Number(match[1]))
  }
  return `分组 ${highest + 1}`
}

/** Card positionKeys and node ids hidden by collapsed frames (contract §4). */
function collapsedFrameMembers(nodes) {
  const cardKeys = new Set()
  const nodeIds = new Set()
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node === null || typeof node !== 'object' || node.type !== 'frame' || node.collapsed !== true) continue
    for (const key of Array.isArray(node.memberCards) ? node.memberCards : []) if (typeof key === 'string') cardKeys.add(key)
    for (const id of Array.isArray(node.memberNodes) ? node.memberNodes : []) if (typeof id === 'string') nodeIds.add(id)
  }
  return { cardKeys, nodeIds }
}

/** Axis-aligned rectangle intersection; touching edges do not count. */
function rectsIntersect(a, b) {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  const left = Number(a.x)
  const top = Number(a.y)
  const width = Number(a.width)
  const height = Number(a.height)
  const otherLeft = Number(b.x)
  const otherTop = Number(b.y)
  const otherWidth = Number(b.width)
  const otherHeight = Number(b.height)
  if (![left, top, width, height, otherLeft, otherTop, otherWidth, otherHeight].every(Number.isFinite)) return false
  return left < otherLeft + otherWidth && left + width > otherLeft && top < otherTop + otherHeight && top + height > otherTop
}

/** Marquee screen rectangle (viewport-relative) → world rectangle. */
function marqueeWorldRect(screenRect, camera, zoom) {
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  const left = Number.isFinite(screenRect?.left) ? screenRect.left : 0
  const top = Number.isFinite(screenRect?.top) ? screenRect.top : 0
  const width = Number.isFinite(screenRect?.width) ? screenRect.width : 0
  const height = Number.isFinite(screenRect?.height) ? screenRect.height : 0
  const cameraX = Number.isFinite(camera?.x) ? camera.x : 0
  const cameraY = Number.isFinite(camera?.y) ? camera.y : 0
  const x1 = (left - cameraX) / scale
  const y1 = (top - cameraY) / scale
  const x2 = (left + width - cameraX) / scale
  const y2 = (top + height - cameraY) / scale
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) }
}

/** Cards (by positionKey) and nodes (by id) intersecting a world rectangle. */
function marqueeSelection(cards, nodes, worldRect) {
  const cardKeys = []
  const nodeIds = []
  if (worldRect === null || typeof worldRect !== 'object') return { cardKeys, nodeIds }
  for (const card of Array.isArray(cards) ? cards : []) {
    if (card === null || typeof card !== 'object' || !Number.isFinite(card.position?.x) || !Number.isFinite(card.position?.y)) continue
    const key = cardPositionKey(card)
    if (key === '') continue
    if (rectsIntersect({ x: card.position.x, y: card.position.y, width: CARD_WIDTH, height: CARD_HEIGHT }, worldRect)) cardKeys.push(key)
  }
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node === null || typeof node !== 'object' || typeof node.id !== 'string' || node.id === '') continue
    const bounds = nodeBounds(node)
    if (bounds === null) continue
    if (rectsIntersect(bounds, worldRect)) nodeIds.push(node.id)
  }
  return { cardKeys, nodeIds }
}

/** Normalize a dragged box into a positive rectangle. */
function normalizeShapeBox(from, to) {
  const x1 = Number.isFinite(Number(from?.x)) ? Number(from.x) : 0
  const y1 = Number.isFinite(Number(from?.y)) ? Number(from.y) : 0
  const x2 = Number.isFinite(Number(to?.x)) ? Number(to.x) : x1
  const y2 = Number.isFinite(Number(to?.y)) ? Number(to.y) : y1
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) }
}

/** Geometry for a click without a drag: the default shape at the press point. */
function defaultShapeGeometry(tool, point) {
  const x = clampNodeCoordinate(point?.x)
  const y = clampNodeCoordinate(point?.y)
  if (tool === 'arrow' || tool === 'line') {
    return { shape: tool === 'line' ? 'line' : 'arrow', x1: x, y1: y, x2: clampNodeCoordinate(x + DEFAULT_ARROW_LENGTH), y2: y }
  }
  return { shape: tool === 'ellipse' ? 'ellipse' : 'rect', x, y, width: DEFAULT_SHAPE_WIDTH, height: DEFAULT_SHAPE_HEIGHT }
}

/** Whole-shape drag: the PATCH body for a rect/ellipse box or both line ends. */
function shapeMovePatch(node, dx, dy) {
  const deltaX = Math.round(Number(dx) || 0)
  const deltaY = Math.round(Number(dy) || 0)
  if (node !== null && typeof node === 'object' && node.type === 'shape' && (node.shape === 'line' || node.shape === 'arrow')) {
    return {
      x1: clampNodeCoordinate(Number(node.x1) + deltaX),
      y1: clampNodeCoordinate(Number(node.y1) + deltaY),
      x2: clampNodeCoordinate(Number(node.x2) + deltaX),
      y2: clampNodeCoordinate(Number(node.y2) + deltaY),
    }
  }
  return { x: clampNodeCoordinate(Number(node?.x) + deltaX), y: clampNodeCoordinate(Number(node?.y) + deltaY) }
}

/** Patch body for dragging one end of a line/arrow. */
function shapeEndpointPatch(node, endpoint, point) {
  const x = clampNodeCoordinate(point?.x)
  const y = clampNodeCoordinate(point?.y)
  return endpoint === 'from' ? { x1: x, y1: y } : { x2: x, y2: y }
}
// --- canvas nodes: pure helpers: end ---

// --- canvas nodes: rendering (Host-owned notes / images / shapes) ---
function selectedNodeClass(nodeId) {
  return state.selectedNodeIds.has(nodeId) ? ' selected' : ''
}

function canvasNodeStyle(node) {
  const z = Number.isFinite(node.z) ? node.z : 1
  return `left:${Math.round(Number(node.x) || 0)}px;top:${Math.round(Number(node.y) || 0)}px;width:${clampNodeDimension(node.width, MIN_NODE_WIDTH)}px;height:${clampNodeDimension(node.height, MIN_NODE_HEIGHT)}px;z-index:${z}`
}

function noteBodyHtml(text) {
  return escapeHtml(normalizeNoteText(text)).replace(/\n/g, '<br>')
}

function canvasNoteHtml(node) {
  return `<section class="canvas-note${selectedNodeClass(node.id)}" data-node-id="${escapeHtml(node.id)}" data-morph-key="note:${escapeHtml(node.id)}" style="${canvasNodeStyle(node)}"><div class="canvas-note-body" contenteditable="true" spellcheck="false" role="textbox" aria-label="便签正文">${noteBodyHtml(node.text)}</div><button class="canvas-node-remove" type="button" data-action="delete-node" data-node="${escapeHtml(node.id)}" aria-label="删除便签" title="删除便签">×</button></section>`
}

function canvasImageHtml(node) {
  const image = node.image !== null && typeof node.image === 'object' ? node.image : {}
  const source = assetUrlFor(image.attachmentId)
  const content = source === ''
    ? '<div class="canvas-image-missing">图片不可用</div>'
    : `<img class="canvas-image-img" src="${escapeHtml(source)}" alt="" draggable="false">`
  return `<figure class="canvas-image${selectedNodeClass(node.id)}" data-node-id="${escapeHtml(node.id)}" data-morph-key="image:${escapeHtml(node.id)}" style="${canvasNodeStyle(node)}">${content}<button class="canvas-node-remove" type="button" data-action="delete-node" data-node="${escapeHtml(node.id)}" aria-label="删除图片" title="删除图片">×</button></figure>`
}

function canvasShapeHtml(node) {
  const stroke = typeof node.stroke === 'string' && node.stroke !== '' ? node.stroke : '#3d4d63'
  const strokeWidth = Number.isFinite(node.strokeWidth) ? node.strokeWidth : 2
  const selected = state.selectedNodeIds.has(node.id)
  const common = `class="canvas-shape${selected ? ' selected' : ''}" data-node-id="${escapeHtml(node.id)}" data-morph-key="shape:${escapeHtml(node.id)}"`
  const x1 = Math.round(Number(node.x1) || 0)
  const y1 = Math.round(Number(node.y1) || 0)
  const x2 = Math.round(Number(node.x2) || 0)
  const y2 = Math.round(Number(node.y2) || 0)
  if (node.shape === 'line' || node.shape === 'arrow') {
    const marker = node.shape === 'arrow' ? ` marker-end="url(#${ARROW_MARKER_ID})"` : ''
    // Endpoint handles only while selected: they are the drag targets for each
    // end, and showing them on every arrow would clutter the map.
    const handles = selected
      ? `<circle class="canvas-shape-handle" data-shape-handle="from" cx="${x1}" cy="${y1}" r="5" fill="#fff" stroke="#3478f6" stroke-width="2" pointer-events="all"></circle><circle class="canvas-shape-handle" data-shape-handle="to" cx="${x2}" cy="${y2}" r="5" fill="#fff" stroke="#3478f6" stroke-width="2" pointer-events="all"></circle>`
      : ''
    return `<g ${common}><line class="canvas-shape-visible" data-shape-type="${escapeHtml(String(node.shape))}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${escapeHtml(stroke)}" stroke-width="${strokeWidth}"${marker}></line><line class="canvas-shape-hit" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="transparent" stroke-width="14"></line>${handles}</g>`
  }
  const bounds = nodeBounds(node)
  if (bounds === null) return ''
  const shape = node.shape === 'ellipse' ? 'ellipse' : 'rect'
  const geometry = shape === 'ellipse'
    ? `cx="${Math.round(bounds.x + bounds.width / 2)}" cy="${Math.round(bounds.y + bounds.height / 2)}" rx="${Math.round(Math.max(1, bounds.width / 2))}" ry="${Math.round(Math.max(1, bounds.height / 2))}"`
    : `x="${Math.round(bounds.x)}" y="${Math.round(bounds.y)}" width="${Math.round(bounds.width)}" height="${Math.round(bounds.height)}" rx="4"`
  return `<g ${common}><${shape} class="canvas-shape-visible" ${geometry} fill="none" stroke="${escapeHtml(stroke)}" stroke-width="${strokeWidth}"></${shape}><${shape} class="canvas-shape-hit" ${geometry} fill="transparent" stroke="transparent" stroke-width="14"></${shape}></g>`
}

/**
 * A frame box. It is the first child of `.cards-layer` so DOM order paints it
 * under the cards; the header is the only interactive part (group drag).
 */
function frameNodeHtml(node) {
  const memberCards = Array.isArray(node.memberCards) ? node.memberCards : []
  const collapsed = node.collapsed === true
  const titleText = normalizeFrameTitle(node.title)
  const title = escapeHtml(titleText === '' ? '分组' : titleText)
  const selected = state.selectedNodeIds.has(node.id) ? ' selected' : ''
  const width = clampNodeDimension(node.width, MIN_NODE_WIDTH)
  const height = collapsed ? 34 : clampNodeDimension(node.height, MIN_NODE_HEIGHT)
  const label = collapsed ? '展开分组' : '折叠分组'
  // Inline pointer-events keep the empty frame area transparent to pan/marquee
  // while the header stays grabbable (visuals live in styles.css, contract §6).
  return `<section class="canvas-frame${collapsed ? ' collapsed' : ''}${selected}" data-frame-id="${escapeHtml(node.id)}" data-morph-key="frame:${escapeHtml(node.id)}" style="left:${Math.round(Number(node.x) || 0)}px;top:${Math.round(Number(node.y) || 0)}px;width:${width}px;height:${height}px;pointer-events:none"><header class="canvas-frame-head" data-frame-drag="${escapeHtml(node.id)}" style="pointer-events:auto"><span class="canvas-frame-title" title="${title}">${title}</span><span class="canvas-frame-count" title="组内卡片">${memberCards.length}</span><button class="canvas-frame-toggle" type="button" data-action="toggle-frame" data-frame="${escapeHtml(node.id)}" aria-expanded="${collapsed ? 'false' : 'true'}" aria-label="${label}" title="${label}"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M8 3.5v9M3.5 8h9"/></svg></button><button class="canvas-node-remove" type="button" data-action="delete-node" data-node="${escapeHtml(node.id)}" aria-label="删除分组" title="删除分组">×</button></header></section>`
}

function visibleNodesOfType(type, hiddenIds = null) {
  const nodes = []
  for (const node of state.nodes.values()) {
    if (node === null || typeof node !== 'object' || node.type !== type) continue
    if (hiddenIds !== null && hiddenIds.has(node.id)) continue
    nodes.push(node)
  }
  return nodes
}

/** Inner HTML of `.notes-layer`: notes first, then images (contract §3). */
function notesLayerHtml(hiddenIds = null) {
  return `${visibleNodesOfType('note', hiddenIds).map(canvasNoteHtml).join('')}${visibleNodesOfType('image', hiddenIds).map(canvasImageHtml).join('')}`
}

/** Inner HTML of `svg.shapes-layer`; the arrow marker lives in renderCanvas' <defs>. */
function shapesLayerHtml(hiddenIds = null) {
  // `z` only orders nodes inside one layer (contract §1); the SVG paints in
  // document order, so sort by it before emitting.
  return visibleNodesOfType('shape', hiddenIds)
    .slice()
    .sort((left, right) => (Number.isFinite(left.z) ? left.z : 0) - (Number.isFinite(right.z) ? right.z : 0))
    .map(canvasShapeHtml)
    .join('')
}

/** Inner HTML of `.cards-layer`'s leading frame children (painted under cards). */
function frameNodesHtml(hiddenIds = null) {
  return visibleNodesOfType('frame', hiddenIds).map(frameNodeHtml).join('')
}
// --- canvas nodes: rendering: end ---

function renderCanvas() {
  const threads = visibleThreads(state.workspace?.threads ?? [])
  if (threads.length === 0 && state.draft?.kind !== 'new' && state.nodes.size === 0) return `<section class="empty-canvas"><strong>当前工作目录还没有 DSH 对话。</strong><p>点击新会话，在画布中输入第一条消息。</p><div><button class="primary" type="button" data-action="create-session">新建会话</button></div></section>`
  const allCards = conversationCards(threads)
  const graph = conversationGraphView(allCards)
  const cards = graph.cards
  // Collapsed frames hide their members from this projection (contract §4).
  // Mutating `cards` in place keeps one list for the connectors, the
  // virtualisation pass and the draft, without changing the projection itself.
  const frameHidden = collapsedFrameMembers([...state.nodes.values()])
  for (let index = cards.length - 1; index >= 0; index--) {
    if (frameHidden.cardKeys.has(cardPositionKey(cards[index]))) cards.splice(index, 1)
  }
  state.canvasCards = cards
  state.canvasCardsById = new Map(cards.map(card => [card.id, card]))
  state.canvasGraph = graph
  if (state.inspectorCardId !== null && !state.canvasCardsById.has(state.inspectorCardId)) {
    state.inspectorCardId = null
    state.inspectorOpening = false
  }
  if (!state.canvasViewInitialized) {
    state.canvasCamera = initialCanvasCamera(cards)
    state.canvasViewInitialized = true
    // The viewport is not laid out yet while renderCanvas builds its HTML;
    // center the focused card once the DOM is mounted (render tail).
    state.canvasNeedsCenter = true
  }
  const visible = visibleCardIds(cards)
  state.mountedCardIds = new Set(visible)
  const mounted = cards.filter(card => visible.has(card.id))
  const inspector = state.inspectorCardId === null ? '' : renderCardInspector(state.canvasCardsById.get(state.inspectorCardId))
  return `<section class="canvas-view" data-morph-key="canvas"><div class="canvas-viewport"><div class="canvas-content" data-morph-key="canvas-content" style="transform:translate(${state.canvasCamera.x}px, ${state.canvasCamera.y}px) scale(${state.zoom})"><svg class="connectors">${canvasConnectors(cards)}</svg><div class="cards-layer" data-morph-key="cards">${frameNodesHtml(frameHidden.nodeIds)}${mounted.map(card => conversationCard(card, graph)).join('')}${draftCard(cards)}</div><div class="notes-layer" data-morph-key="canvas-notes">${notesLayerHtml(frameHidden.nodeIds)}</div><svg class="shapes-layer" data-morph-key="canvas-shapes"><defs><marker id="${ARROW_MARKER_ID}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse" markerUnits="strokeWidth"><path d="M0 0 L10 5 L0 10 z"></path></marker></defs>${shapesLayerHtml(frameHidden.nodeIds)}</svg></div></div>${inspector}</section>`
}

function isProcessMessage(message) {
  if (message.kind === 'tool' || message.kind === 'tool-result') return true
  return message.kind === 'assistant' && /(?:^|\n)\s*(?:bash|pwsh|powershell|web_search|web_fetch|browser|read_file|write_file)\s*\n\s*\{/.test(message.text)
}

function processSummary(text) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 140) || '工具调用记录'
}

function threadMessage(thread, message) {
  const isUser = message.kind === 'user'
  const label = isUser ? '你' : message.kind === 'assistant' ? 'DSH' : message.kind === 'error' ? '错误' : '记录'
  const branch = message.kind === 'assistant' && Number.isInteger(message.sourceSeq)
    ? `<button class="message-branch" data-action="open-branch" data-thread="${thread.id}" data-seq="${message.sourceSeq}" title="从此回答创建分支"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M4.5 3v6a2.5 2.5 0 0 0 2.5 2.5H12"/><circle cx="4.5" cy="3" r="1.5"/><circle cx="11.5" cy="12" r="1.5"/></svg>分支</button>`
    : ''
  const messageId = `${thread.id}:${message.sourceSeq ?? `${message.kind}:${message.at}`}`
  const collapsible = isProcessMessage(message)
  const expanded = state.expandedMessageIds.has(messageId)
  const fold = collapsible ? `<button class="message-fold" data-action="toggle-message" data-message="${escapeHtml(messageId)}" aria-label="${expanded ? '收起过程记录' : '展开过程记录'}" title="${expanded ? '收起' : '展开'}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5"/></svg></button>` : ''
  const process = Array.isArray(message.process) && message.process.length > 0 ? message.process : null
  const body = message.pending && message.text === '' ? '<p class="message-streaming"><span class="streaming-dot"></span>正在回复</p>'
    : `${collapsible && !expanded ? `<p class="message-summary">${escapeHtml(processSummary(message.text))}</p>` : renderMarkdown(message.text)}${message.pending ? '<p class="message-streaming"><span class="streaming-dot"></span>正在回复</p>' : ''}${process === null ? '' : processRecords(process, messageId)}`
  const avatar = isUser ? '' : '<span class="message-avatar" aria-hidden="true"></span>'
  return `<article class="message message-${message.kind}${message.pending ? ' message-pending' : ''}${collapsible ? ' message-collapsible' : ''}${expanded ? ' expanded' : ''}" data-message-seq="${Number.isInteger(message.sourceSeq) ? message.sourceSeq : ''}"><header>${avatar}<span class="message-role">${label}</span><time>${formatTime(message.at)}</time>${branch}${fold}</header><div class="message-body">${body}</div></article>`
}

/**
 * Stored process entries carry a `status` (`pending` / `done` / `failed`);
 * records folded in from a v3-era message still carry `error` / `result`. Read
 * both shapes, otherwise a finished tool renders as a failure only because the
 * newer shape has no `error` key at all (`undefined !== null`).
 */
function processState(entry) {
  if (entry.status === 'failed') return 'failed'
  if (entry.status === 'pending') return 'pending'
  if (entry.status === 'done') return 'done'
  if (typeof entry.error === 'string') return entry.error === '' ? (entry.result === null || entry.result === undefined ? 'pending' : 'done') : 'failed'
  if (entry.error !== null && entry.error !== undefined) return 'failed'
  return entry.result === null || entry.result === undefined ? 'pending' : 'done'
}

function processRecords(process, messageId) {
  const key = `${messageId}:process`
  const expanded = state.expandedMessageIds.has(key)
  const entries = process.map((entry, index) => {
    const entryKey = `${key}:${index}`
    const entryExpanded = state.expandedMessageIds.has(entryKey)
    const state_ = processState(entry)
    const status = state_ === 'failed' ? '失败' : state_ === 'pending' ? '等待结果' : '完成'
    const statusClass = state_ === 'failed' ? ' process-status-error' : state_ === 'pending' ? ' process-status-pending' : ' process-status-done'
    const argumentsHtml = typeof entry.arguments === 'string' && entry.arguments !== '' ? `<pre class="process-args">${escapeHtml(entry.arguments)}</pre>` : ''
    const outcomeHtml = state_ === 'failed' && typeof entry.error === 'string' && entry.error !== ''
      ? `<pre class="process-error">${escapeHtml(entry.error)}</pre>`
      : typeof entry.result === 'string' && entry.result !== '' ? `<pre class="process-result">${escapeHtml(entry.result)}</pre>` : ''
    return `<div class="process-entry${entryExpanded ? ' expanded' : ''}"><button class="process-entry-fold" data-action="toggle-message" data-message="${escapeHtml(entryKey)}"><span class="process-entry-name">${escapeHtml(entry.name)}</span><span class="process-status${statusClass}">${status}</span></button>${entryExpanded ? `<div class="process-entry-body">${argumentsHtml}${outcomeHtml}</div>` : ''}</div>`
  }).join('')
  return `<section class="process-records${expanded ? ' expanded' : ''}"><button class="process-records-fold" data-action="toggle-message" data-message="${escapeHtml(key)}"><span>${expanded ? '收起过程记录' : '过程记录'}</span><span class="process-count">${process.length}</span></button>${expanded ? entries : ''}</section>`
}

function messagesForCard(card) {
  const thread = state.workspace?.threads.find(item => item.id === card.dshThreadId)
  if (thread === undefined) return { thread: null, messages: [] }
  const messages = messagesFor(thread)
  let turnIndex = -1
  let start = -1
  for (let index = 0; index < messages.length; index++) {
    if (messages[index].kind !== 'user') continue
    turnIndex += 1
    if (turnIndex === card.turnIndex) {
      start = index
      break
    }
  }
  if (start === -1) return { thread, messages: [] }
  const end = messages.findIndex((message, index) => index > start && message.kind === 'user')
  return { thread, messages: messages.slice(start, end === -1 ? undefined : end) }
}

function inspectorProcessEntries(messages) {
  const entries = []
  for (const message of messages) {
    if (Array.isArray(message.process)) {
      entries.push(...message.process.map(entry => ({ ...entry })))
      continue
    }
    if (message.kind === 'tool') {
      entries.push({ name: processSummary(message.text), arguments: message.text, status: 'pending' })
      continue
    }
    if (message.kind === 'tool-result') {
      const previous = entries.at(-1)
      if (previous !== undefined && processState(previous) === 'pending') {
        previous.status = 'done'
        previous.result = message.text
      } else entries.push({ name: '工具结果', arguments: null, status: 'done', result: message.text })
    }
  }
  return entries
}

function renderCardInspector(card) {
  if (card === undefined) return ''
  const { thread, messages } = messagesForCard(card)
  if (thread === null) return ''
  const process = inspectorProcessEntries(messages)
  const answer = card.answer === null
    ? card.error === null ? '<p class="card-inspector-pending">等待助手回复</p>' : ''
    : `<article class="card-inspector-answer">${renderMarkdown(card.answer.text)}${card.answer.pending ? '<p class="card-inspector-pending">正在回复</p>' : ''}</article>`
  const error = card.error === null ? '' : `<section class="card-inspector-error" role="alert"><strong>本轮未完成</strong><p>${escapeHtml(card.error.text)}</p></section>`
  const processRecordsHtml = process.length === 0 ? '' : processRecords(process, `${thread.id}:${card.id}:inspector`)
  const continueAction = card.canContinue === true ? `<button type="button" data-action="open-continue" data-thread="${thread.id}" data-card="${escapeHtml(card.id)}"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M2.5 3.5h11v7h-6l-3.5 2.5v-2.5h-1.5Z"/><path d="M8 5.5v3M6.5 7h3"/></svg>继续追问</button>` : ''
  const branch = Number.isInteger(card.answer?.sourceSeq)
    ? `<button type="button" data-action="open-branch" data-thread="${thread.id}" data-card="${escapeHtml(card.id)}" data-seq="${card.answer.sourceSeq}"><svg aria-hidden="true" viewBox="0 0 16 16"><circle cx="4" cy="3.5" r="1.5"/><circle cx="12" cy="3.5" r="1.5"/><circle cx="12" cy="12.5" r="1.5"/><path d="M5.5 3.5h2A2.5 2.5 0 0 1 10 6v5"/></svg>创建分支</button>`
    : ''
  const openDshAction = `<button class="primary" type="button" data-action="open-dsh" data-thread="${thread.id}" data-seq="${Number.isInteger(card.answer?.sourceSeq) ? card.answer.sourceSeq : ''}"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M7 3.5H4.5A1.5 1.5 0 0 0 3 5v6.5A1.5 1.5 0 0 0 4.5 13H11a1.5 1.5 0 0 0 1.5-1.5V9"/><path d="M9.5 3.5h3v3M12.4 3.6 7.5 8.5"/></svg>在 DSH 中打开</button>`
  return `<aside class="card-inspector${state.inspectorOpening ? ' is-opening' : ''}" aria-label="卡片详情" data-inspector-card="${escapeHtml(card.id)}"><header class="card-inspector-head"><div><div class="card-inspector-meta"><span>第 ${card.turnIndex + 1} 轮</span>${card.error === null ? '' : '<span class="card-inspector-error-status">失败</span>'}${process.length > 0 ? `<span>工具 ${process.length}</span>` : ''}</div><h2 title="${escapeHtml(card.question)}">${escapeHtml(card.question)}</h2></div><button class="card-inspector-close" type="button" data-action="close-card-inspector" aria-label="关闭卡片详情" title="关闭"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg></button></header><div class="card-inspector-scroll">${error}${answer}${processRecordsHtml}</div><footer class="card-inspector-actions">${continueAction}${branch}${openDshAction}</footer></aside>`
}

function renderThread() {
  const thread = currentThread()
  if (thread === null) return renderCanvas()
  const messages = messagesFor(thread)
  const waiting = state.pendingReplies.has(thread.dshSessionId)
  const latestAssistantSeq = [...messages].reverse().find(message => Number.isInteger(message.sourceSeq))?.sourceSeq
  return `<section class="detail-view" data-morph-key="detail"><header class="detail-head"><div class="detail-head-title"><div class="detail-head-meta"><span class="detail-badge">${thread.parentId === null ? '会话' : '分支'}</span>${thread.dshSessionTitle ?? thread.title ? `<span class="detail-subtitle">${escapeHtml(thread.dshSessionTitle ?? thread.title)}</span>` : ''}</div><h1>${escapeHtml(questionFor(thread))}</h1></div><div class="detail-head-actions"><button data-action="open-dsh" data-thread="${thread.id}" data-seq="${Number.isInteger(latestAssistantSeq) ? latestAssistantSeq : ''}" title="在原生对话中打开此会话">在 DSH 中打开</button><button data-action="open-branch" data-thread="${thread.id}" title="基于最新回答创建分支">创建分支</button><button class="primary" data-action="show-canvas">返回画布</button></div></header><div class="detail-scroll">${messages.map(message => threadMessage(thread, message)).join('') || '<div class="note-empty">等待这条会话的第一条消息。</div>'}</div><form class="message-composer" data-compose="${thread.id}"><textarea maxlength="4000" placeholder="继续当前会话…" ${waiting ? 'disabled' : ''}></textarea><button class="primary" type="submit" ${waiting ? 'disabled' : ''}>${waiting ? '等待回复' : '发送'}</button></form></section>`
}

function render() {
  // Remember the departing thread's scroll position per thread id, so
  // switching sessions restores each conversation's own place instead of
  // smearing one session's position onto another.
  if (state.mode === 'thread' && state.detailThreadId !== null) {
    const detail = document.querySelector('.detail-scroll')
    if (detail instanceof HTMLElement) state.detailScrollByThread.set(state.detailThreadId, detail.scrollTop)
  }
  if (state.mode === 'canvas' && state.inspectorCardId !== null) {
    const inspector = document.querySelector('.card-inspector-scroll')
    if (inspector instanceof HTMLElement) state.inspectorScrollByCard.set(state.inspectorCardId, inspector.scrollTop)
  }
  state.detailThreadId = state.mode === 'thread' ? state.activeId : null
  const detailScrollTop = state.detailThreadId === null ? null : state.detailScrollByThread.get(state.detailThreadId) ?? null
  const inspectorScrollTop = state.mode === 'canvas' && state.inspectorCardId !== null ? state.inspectorScrollByCard.get(state.inspectorCardId) ?? null : null
  const cardScrollTops = new Map()
  if (state.mode === 'canvas') {
    // Key by the unique card id: every card of a session shares data-thread,
    // so keying on it would clobber sibling cards' scroll positions. Only
    // scrollable answers have a position worth preserving; reading the two
    // height properties shares the same forced layout as the scrollTop read.
    for (const answer of document.querySelectorAll('.thread-card[data-thread] .thread-answer')) {
      if (answer.scrollHeight <= answer.clientHeight) continue
      const card = answer.closest('.thread-card')
      if (card instanceof HTMLElement && typeof card.dataset.cardId === 'string') cardScrollTops.set(card.dataset.cardId, answer.scrollTop)
    }
  }
  const workspace = state.workspace
  const threads = visibleThreads(workspace?.threads ?? [])
  const view = state.mode === 'thread' ? renderThread() : renderCanvas()
  const choices = workspaceChoices()
  const selectedWorkspaceId = state.selectedDshWorkspaceId ?? workspace?.id
  const canvasControls = state.mode === 'canvas' && (threads.length > 0 || state.draft?.kind === 'new' || state.nodes.size > 0) ? `<div class="canvas-controls"><button data-action="add-note" class="${state.canvasTool === 'note' ? 'active' : ''}" aria-pressed="${state.canvasTool === 'note'}" title="便签：点击画布放置" aria-label="便签"><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M6 6.2h4M6 8.8h2.6"/></svg>便签</button><button data-action="add-image" title="插入图片（也可 Ctrl+V 粘贴）" aria-label="插入图片"><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/><circle cx="6" cy="7" r="1.1"/><path d="M4 12l3.2-3.2 2 2L11 9l2 3"/></svg>图片</button><button data-action="draw-arrow" class="${state.canvasTool === 'arrow' ? 'active' : ''}" aria-pressed="${state.canvasTool === 'arrow'}" title="箭头：按下拖动绘制" aria-label="箭头"><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 13.5 13 3M9 3h4v4"/></svg>箭头</button><button data-action="draw-rect" class="${state.canvasTool === 'rect' ? 'active' : ''}" aria-pressed="${state.canvasTool === 'rect'}" title="矩形：按下拖动绘制" aria-label="矩形"><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><rect x="2.5" y="3.5" width="11" height="9" rx="1"/></svg>矩形</button><button data-action="draw-ellipse" class="${state.canvasTool === 'ellipse' ? 'active' : ''}" aria-pressed="${state.canvasTool === 'ellipse'}" title="椭圆：按下拖动绘制" aria-label="椭圆"><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><ellipse cx="8" cy="8" rx="5.5" ry="4.5"/></svg>椭圆</button><button data-action="select-tool" class="${state.canvasTool === 'select' ? 'active' : ''}" aria-pressed="${state.canvasTool === 'select'}" title="框选：空白处拖动画框，Shift/Ctrl 点选可追加" aria-label="框选"><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><rect x="2.5" y="2.5" width="11" height="11" rx="1" stroke-dasharray="3 2"/><rect x="6" y="6" width="4" height="4" rx=".5"/></svg>框选</button><button data-action="group-selection" title="把选中的卡片/元素组合成分组框（G）" aria-label="分组"><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2.5 5.5h4l1.2 1.4h5.8v5.1a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/><path d="M2.5 5.5v-2h3l1 1.5"/></svg>分组</button><button data-action="layout" title="整理节点" aria-label="整理节点"><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/></svg>整理</button><button data-action="focus-active" title="定位到当前会话" aria-label="定位到当前会话"><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="8" cy="8" r="3.2"/><path d="M8 1.5v2.6M8 11.9v2.6M1.5 8h2.6M11.9 8h2.6"/></svg>定位</button><button data-action="zoom-out" aria-label="缩小" title="缩小"><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3.5 8h9"/></svg></button><span>${Math.round(state.zoom * 100)}%</span><button data-action="zoom-in" aria-label="放大" title="放大"><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M8 3.5v9M3.5 8h9"/></svg></button></div>` : ''
  const detailAvailable = currentThread() !== null
  const canvasTabs = `<nav class="canvas-tabs" data-morph-key="canvas-tabs" aria-label="会话地图视图"><button class="${state.mode === 'canvas' ? 'active' : ''}" data-action="show-canvas">地图</button><button class="${state.mode === 'thread' ? 'active' : ''}" data-action="show-thread" data-thread="${state.activeId ?? ''}" ${detailAvailable ? '' : 'disabled'}>详情</button></nav>`
  morphInto(app, `<main class="synapse-shell ${state.sidebarCollapsed ? 'sidebar-collapsed' : ''}"><aside class="sidebar"><div class="sidebar-brand-row"><div class="brand" aria-label="Synapse"><svg class="brand-mark" aria-hidden="true" viewBox="0 0 32 32" fill="none"><path d="M9 10.5 16 7l7 3.5M9 10.5v8L16 22m0-15v15m7-11.5v8L16 22"/><circle cx="9" cy="10" r="2.5"/><circle cx="23" cy="10" r="2.5"/><circle cx="16" cy="23" r="2.5"/></svg><strong>Synapse</strong></div><button class="sidebar-toggle" type="button" data-action="toggle-sidebar" aria-label="${state.sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}" title="${state.sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.75" y="1.75" width="12.5" height="12.5" rx="2.25"/><path d="M6 2v12"/></svg></button></div><button class="new-workspace" type="button" data-action="create-session" ${state.draft !== null ? 'disabled' : ''}><svg class="new-session-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25"/><path d="M8 4.75v6.5M4.75 8h6.5"/></svg><span>新会话</span></button><label class="workspace-label"><span>工作区</span><span class="workspace-select"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M2.5 4.75h3l1.2 1.5h6.8v5.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z"/></svg><select data-action="select-workspace" aria-label="选择工作区" ${state.draft !== null ? 'disabled' : ''}>${choices.map(item => `<option value="${item.id}" title="${escapeHtml(item.path ?? item.title)}" ${item.id === selectedWorkspaceId ? 'selected' : ''}>${escapeHtml(item.title)}</option>`).join('')}</select></span></label><div class="sidebar-heading"><span>会话</span></div><nav class="thread-tree">${threads.map(thread => `<button class="tree-row ${thread.id === state.activeId ? 'active' : ''}" data-action="select-thread" data-thread="${thread.id}" style="--thread-color:#374151"><span class="tree-dot"></span><span>${escapeHtml(threadListTitle(thread))}</span>${thread.parentId === null ? '' : '<i>分支</i>'}</button>`).join('') || '<p class="tree-empty">暂未同步会话</p>'}</nav></aside><header class="topbar">${canvasControls}</header><section class="main-stage">${state.error ? `<div class="status-message" data-morph-key="status" role="alert"><span>${escapeHtml(state.error)}</span><button data-action="dismiss-error" aria-label="关闭" title="关闭">×</button></div>` : ''}${canvasTabs}${view}${selectionFollowupButton()}</section></main>`)
  installDragging()
  cacheCardConnectors()
  // The initial camera from renderCanvas is inset (viewport not laid out yet);
  // center it on the focused card once the canvas DOM is mounted.
  if (state.canvasNeedsCenter) {
    state.canvasNeedsCenter = false
    window.requestAnimationFrame(() => { if (state.mode === 'canvas') focusActiveCard() })
  }
  for (const [cardId, scrollTop] of cardScrollTops) {
    const answer = app.querySelector(`.thread-card[data-card-id="${CSS.escape(cardId)}"] .thread-answer`)
    if (answer instanceof HTMLElement) answer.scrollTop = scrollTop
  }
  if (detailScrollTop !== null) window.requestAnimationFrame(() => {
    const nextDetail = document.querySelector('.detail-scroll')
    if (nextDetail instanceof HTMLElement) nextDetail.scrollTop = detailScrollTop
  })
  if (inspectorScrollTop !== null) window.requestAnimationFrame(() => {
    const inspector = document.querySelector('.card-inspector-scroll')
    if (inspector instanceof HTMLElement) inspector.scrollTop = inspectorScrollTop
  })
  if (state.inspectorOpening) window.requestAnimationFrame(() => {
    document.querySelector('.card-inspector')?.classList.remove('is-opening')
    state.inspectorOpening = false
  })
  // Jump the detail view to the card the user clicked: card ids carry the
  // source sequence (`<thread>:turn:<seq>`), which matches data-message-seq
  // anchors on the rendered messages.
  const targetCardId = state.detailTargetCardId
  state.detailTargetCardId = null
  if (targetCardId !== null) {
    const match = /:turn:(\d+)$/.exec(targetCardId)
    const seq = match === null ? null : match[1]
    if (seq !== null) window.requestAnimationFrame(() => {
      const target = app.querySelector(`[data-message-seq="${CSS.escape(seq)}"]`)
      if (target instanceof HTMLElement) target.scrollIntoView({ block: 'start' })
    })
  }
  // Card faces and the detail view only hold previews: pull the real bodies for
  // whatever is on screen right now (issue #42).
  void hydrateBodies()
}

/**
 * Ask the Host for the bodies of the messages currently on screen. The
 * workspace payload carries previews only, so each newly mounted card and each
 * opened detail view hydrates from the DSH session log.
 */
async function hydrateBodies() {
  const wanted = new Map()
  const add = (threadId, message) => {
    if (threadId === undefined || message === null || message === undefined) return
    if (!Number.isInteger(message.sourceSeq)) return
    if (state.bodies.get(threadId)?.has(message.sourceSeq) === true) return
    const key = `${threadId}:${message.sourceSeq}`
    if (state.bodyRequests.has(key) || state.bodyFailures.has(key)) return
    const seqs = wanted.get(threadId) ?? new Set()
    seqs.add(message.sourceSeq)
    wanted.set(threadId, seqs)
  }
  const addCard = card => {
    if (card === undefined) return
    add(card.dshThreadId, card.questionMessage)
    add(card.dshThreadId, card.answer)
    add(card.dshThreadId, card.error)
  }
  if (state.mode === 'thread' && state.activeId !== null) {
    const thread = currentThread()
    if (thread !== null && !state.bodiesLoaded.has(thread.id)) {
      for (const message of persistedMessagesFor(thread)) add(thread.id, message)
    }
  } else if (state.mode === 'canvas') {
    for (const cardId of state.mountedCardIds) addCard(state.canvasCardsById?.get(cardId))
  }
  if (state.inspectorCardId !== null) addCard(state.canvasCardsById?.get(state.inspectorCardId))
  for (const [threadId, seqs] of wanted) void fetchBodies(threadId, [...seqs])
}

async function fetchBodies(threadId, seqs) {
  if (seqs.length === 0) return
  const keys = seqs.map(seq => `${threadId}:${seq}`)
  for (const key of keys) state.bodyRequests.add(key)
  try {
    const body = await api(`/synapse/api/threads/${threadId}/full?seqs=${seqs.join(',')}`)
    const cached = state.bodies.get(threadId) ?? new Map()
    for (const [seq, payload] of Object.entries(body.messages ?? {})) {
      if (payload === null || typeof payload !== 'object') continue
      cached.set(Number(seq), payload)
    }
    state.bodies.set(threadId, cached)
    if (state.mode === 'thread' && state.activeId === threadId) state.bodiesLoaded.add(threadId)
    if (body.unavailable === true) {
      // Archived or already removed from DSH: keep the previews, stop asking.
      for (const message of persistedMessagesFor(currentThread() ?? { messages: [] })) {
        if (Number.isInteger(message.sourceSeq)) state.bodyFailures.add(`${threadId}:${message.sourceSeq}`)
      }
      state.bodiesLoaded.add(threadId)
    }
    if (state.mode === 'thread' || state.inspectorCardId !== null) render()
    else if (canReplaceView()) render()
    else deferCanvasRefresh(400)
  } catch {
    for (const key of keys) state.bodyFailures.add(key)
  } finally {
    for (const key of keys) state.bodyRequests.delete(key)
  }
}

function renderPreservingDetailScroll() {
  render()
}

let inspectorCloseTimer = 0
function openCardInspector(cardId) {
  if (inspectorCloseTimer !== 0) {
    window.clearTimeout(inspectorCloseTimer)
    inspectorCloseTimer = 0
  }
  state.inspectorOpening = state.inspectorCardId === null
  state.inspectorCardId = cardId
}

function closeCardInspector({ animate = true } = {}) {
  if (state.inspectorCardId === null) return
  if (inspectorCloseTimer !== 0) window.clearTimeout(inspectorCloseTimer)
  const cardId = state.inspectorCardId
  const inspector = document.querySelector('.card-inspector')
  if (!animate || !(inspector instanceof HTMLElement)) {
    state.inspectorCardId = null
    state.inspectorOpening = false
    render()
    return
  }
  inspector.classList.add('is-closing')
  inspectorCloseTimer = window.setTimeout(() => {
    inspectorCloseTimer = 0
    if (state.inspectorCardId !== cardId) return
    state.inspectorCardId = null
    state.inspectorOpening = false
    render()
  }, 180)
}

function applyCanvasTransform() {
  const content = document.querySelector('.canvas-content')
  if (content instanceof HTMLElement) content.style.transform = `translate(${state.canvasCamera.x}px, ${state.canvasCamera.y}px) scale(${state.zoom})`
}

// --- DOM morphing ---------------------------------------------------------
// The canvas re-renders on every projection tick and on every streamed chunk.
// Assigning `app.innerHTML` destroys the exact node the user is pressing, and a
// click is only dispatched when mousedown and mouseup share a target, so a
// rebuild in between silently swallows the click (W3C uievents #141). Morph the
// new markup into the live tree instead: matching nodes are patched in place and
// whatever sits under the pointer stays alive.

const MORPH_KEY_ATTRIBUTES = ['data-morph-key', 'data-card-id', 'data-thread', 'id']

function morphKeyOf(node) {
  if (!(node instanceof Element)) return null
  for (const attribute of MORPH_KEY_ATTRIBUTES) {
    const value = node.getAttribute(attribute)
    if (value !== null && value !== '') return `${node.tagName}|${attribute}|${value}`
  }
  return null
}

// Only the node that actually owns the caret/selection is frozen — never its
// ancestors. Freezing every ancestor of the anchor froze the entire shell (a
// caret in a card's answer made `.canvas-view` and `main` un-morphable), so the
// inspector never appeared and the sidebar never refreshed after a switch.
let morphFrozenRoot = null

function morphFrozenRootOfDocument() {
  if (typeof window.getSelection !== 'function') return null
  const selection = window.getSelection()
  if (selection === null || selection.rangeCount === 0) return null
  const anchor = selection.anchorNode
  if (anchor === null) return null
  const element = anchor.nodeType === 1 ? anchor : anchor.parentElement
  if (element === null) return null
  return element.closest('.thread-answer, .card-inspector-answer, .message-body, [data-draft], input, textarea, [contenteditable="true"]')
}

/** Elements whose children must survive a render: they own the caret, or a selection. */
function morphKeepsChildren(node) {
  if (!(node instanceof Element)) return false
  if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) return true
  if (node.isContentEditable === true) return true
  return node === morphFrozenRoot
}

function morphNode(from, to) {
  if (from.nodeType !== to.nodeType) return replaceMorphed(from, to)
  if (from.nodeType === Node.TEXT_NODE || from.nodeType === Node.COMMENT_NODE) {
    if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue
    return from
  }
  if (!(from instanceof Element) || !(to instanceof Element) || from.tagName !== to.tagName) {
    return replaceMorphed(from, to)
  }
  // Attributes are always patched, even on the node the user just clicked: a
  // pressed button becomes document.activeElement, and treating that as "owns
  // the caret" used to freeze its whole subtree — the clicked sidebar row never
  // received its `active` class, so no row looked selected after a switch.
  for (const attribute of [...from.attributes]) {
    if (!to.hasAttribute(attribute.name)) from.removeAttribute(attribute.name)
  }
  for (const attribute of [...to.attributes]) {
    if (from.getAttribute(attribute.name) !== attribute.value) from.setAttribute(attribute.name, attribute.value)
  }
  if (!morphKeepsChildren(from)) morphChildren(from, to)
  return from
}

/** Swap one node for a copy of another and hand back the node now in the tree. */
function replaceMorphed(from, to) {
  const next = to.cloneNode(true)
  from.replaceWith(next)
  return next
}

function morphChildren(from, to) {
  const keyed = new Map()
  for (const child of [...from.childNodes]) {
    const key = morphKeyOf(child)
    if (key !== null && !keyed.has(key)) keyed.set(key, child)
  }
  const matched = new Set()
  let cursor = from.firstChild
  for (const next of [...to.childNodes]) {
    const key = morphKeyOf(next)
    let match = key === null ? null : keyed.get(key) ?? null
    if (match === null && cursor !== null && morphKeyOf(cursor) === null) match = cursor
    if (match === null) {
      const inserted = next.cloneNode(true)
      from.insertBefore(inserted, cursor)
      matched.add(inserted)
      continue
    }
    if (match !== cursor) from.insertBefore(match, cursor)
    matched.add(morphNode(match, next))
    cursor = match.nextSibling
  }
  for (const child of [...from.childNodes]) {
    if (!matched.has(child)) from.removeChild(child)
  }
}

/** Patch `container`'s children to match `html` without discarding live nodes. */
function morphInto(container, html) {
  const template = document.createElement('template')
  template.innerHTML = html
  // Computed once per pass: the one subtree that must not be rebuilt because the
  // caret/selection lives in it. Everything else (inspector, sidebar rows, cards)
  // keeps updating normally.
  morphFrozenRoot = morphFrozenRootOfDocument()
  try {
    morphChildren(container, template.content)
  } finally {
    morphFrozenRoot = null
  }
}

function bindDragHandle(handle) {
  // Cards now survive a render, so bind each drag handle once.
  if (handle.dataset.dragBound === '1') return
  handle.dataset.dragBound = '1'
  handle.addEventListener('pointerdown', event => {
    const cardId = event.currentTarget.dataset.dragCard
    const card = event.currentTarget.closest('.thread-card')
    if (cardId === undefined || !(card instanceof HTMLElement)) return
    event.preventDefault()
    const origin = { x: event.clientX, y: event.clientY, position: { x: Number.parseFloat(card.style.left), y: Number.parseFloat(card.style.top) } }
    const aliases = card.dataset.positionKey === undefined ? [] : [card.dataset.positionKey]
    let position = origin.position
    let stopped = false
    let frame = 0
    state.dragging = true
    // Coalesce pointermove updates to one DOM pass per animation frame so a
    // high report-rate pointer cannot queue a reflow per event.
    const apply = () => {
      frame = 0
      state.cardPositions.set(cardId, { x: Math.round(position.x), y: Math.round(position.y) })
      for (const alias of aliases) state.cardPositions.set(alias, { x: Math.round(position.x), y: Math.round(position.y) })
      // Keep the virtualized data object in sync so viewport visibility and
      // connector paths track the live drag position.
      const dataCard = state.canvasCardsById?.get(cardId)
      if (dataCard !== undefined) dataCard.position = { x: position.x, y: position.y }
      card.style.left = `${position.x}px`
      card.style.top = `${position.y}px`
      refreshCardConnectors(cardId)
    }
    const move = moveEvent => {
      position = { x: origin.position.x + (moveEvent.clientX - origin.x) / state.zoom, y: origin.position.y + (moveEvent.clientY - origin.y) / state.zoom }
      if (frame === 0) frame = window.requestAnimationFrame(apply)
    }
    const stop = () => {
      if (stopped) return
      stopped = true
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', stop)
      document.removeEventListener('pointercancel', stop)
      if (frame !== 0) { window.cancelAnimationFrame(frame); frame = 0 }
      apply()
      rememberCardPosition(cardId, position, aliases)
      // Dragging a card out of a frame detaches it (contract §4); the Host syncs
      // thread.frameId when memberCards changes.
      if (aliases.length > 0) detachCardFromFrame(aliases[0])
      state.dragging = false
      deferCanvasRefresh(120)
      // No full render: only the dragged card's inline position and its
      // connectors changed; rebuilding the whole canvas on drop is the jank.
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', stop)
    document.addEventListener('pointercancel', stop)
  })
}

function installDragging() {
  for (const handle of document.querySelectorAll('[data-drag-card]')) bindDragHandle(handle)
}

function canvasViewport(target) {
  return target instanceof Element ? target.closest('.canvas-viewport') : null
}

function zoomCanvas(viewport, nextZoom, clientX, clientY) {
  // 20% keeps a whole map readable as an overview; 400% is the detail ceiling.
  const zoom = Math.min(4, Math.max(.2, Math.round(nextZoom * 100) / 100))
  if (zoom === state.zoom) return
  const bounds = viewport.getBoundingClientRect()
  const localX = clientX - bounds.left
  const localY = clientY - bounds.top
  const worldX = (localX - state.canvasCamera.x) / state.zoom
  const worldY = (localY - state.canvasCamera.y) / state.zoom
  state.zoom = zoom
  state.canvasCamera = { x: localX - worldX * zoom, y: localY - worldY * zoom }
  const content = viewport.querySelector('.canvas-content')
  if (content instanceof HTMLElement) {
    // Drop the composited layer before zooming: a cached will-change raster
    // would be upscaled instead of re-rasterized, which was the original
    // zoom-blur bug. will-change re-applies via .is-panning on the next pan.
    content.style.willChange = 'auto'
    applyCanvasTransform()
    syncCanvasViewport()
    window.requestAnimationFrame(() => { content.style.willChange = '' })
  } else {
    applyCanvasTransform()
    syncCanvasViewport()
  }
  const label = document.querySelector('.canvas-controls span')
  if (label !== null) label.textContent = `${Math.round(state.zoom * 100)}%`
}

function zoomCanvasAtCenter(delta) {
  const viewport = document.querySelector('.canvas-viewport')
  if (!(viewport instanceof HTMLElement)) return
  const bounds = viewport.getBoundingClientRect()
  zoomCanvas(viewport, state.zoom + delta, bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
}

function focusActiveCard() {
  const viewport = document.querySelector('.canvas-viewport')
  if (!(viewport instanceof HTMLElement)) return
  const cards = state.canvasCards
  if (cards === undefined || cards.length === 0) return
  // A collapsed frame must never hide the conversation we are focusing: expand
  // the group(s) holding it first, then re-focus on the next frame (contract §4).
  if (state.activeId !== null && state.activeId !== undefined
    && !cards.some(card => card.dshThreadId === state.activeId)
    && revealFramesForThread(state.activeId)) {
    render()
    window.requestAnimationFrame(() => { if (state.mode === 'canvas') focusActiveCard() })
    return
  }
  // Drafts win over the active conversation's latest turn; fall back to the
  // first card. Cards may be unmounted (outside the viewport), so the focus
  // target comes from the data model, never from DOM queries.
  const draft = state.draft === null ? undefined
    : state.draft.kind === 'new' ? { position: { x: 86, y: 82 } } : draftPlacement(cards)
  const activeCards = state.activeId === null || state.activeId === undefined ? [] : cards.filter(card => card.dshThreadId === state.activeId)
  const card = draft ?? activeCards.at(-1) ?? cards[0]
  const { x: left, y: top } = card.position
  const bounds = viewport.getBoundingClientRect()
  state.canvasCamera = {
    x: bounds.width / 2 - (left + CARD_WIDTH / 2) * state.zoom,
    y: bounds.height / 2 - (top + CARD_HEIGHT / 2) * state.zoom,
  }
  applyCanvasTransform()
  syncCanvasViewport()
}

let selectionFollowup = null
let selectionFollowupFrame = 0

function hideSelectionFollowup() {
  if (selectionFollowupFrame !== 0) {
    window.cancelAnimationFrame(selectionFollowupFrame)
    selectionFollowupFrame = 0
  }
  selectionFollowup = null
  const button = app.querySelector('.selection-followup')
  if (button instanceof HTMLButtonElement) button.hidden = true
}

function selectionFollowupTarget(range) {
  const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
  const end = range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement
  if (!(start instanceof Element) || !(end instanceof Element)) return null
  const answer = start.closest('.thread-answer')
  if (answer instanceof HTMLElement && answer.contains(end)) {
    const card = answer.closest('.thread-card[data-thread]:not(.draft-card)')
    if (card instanceof HTMLElement && card.dataset.thread !== undefined) return { threadId: card.dataset.thread }
  }
  const messageBody = start.closest('.message-assistant .message-body')
  const thread = currentThread()
  if (messageBody instanceof HTMLElement && messageBody.contains(end) && thread !== null) return { threadId: thread.id }
  return null
}

function updateSelectionFollowup() {
  selectionFollowupFrame = 0
  const button = app.querySelector('.selection-followup')
  const selection = window.getSelection()
  if (!(button instanceof HTMLButtonElement) || state.draft !== null || selection === null || selection.rangeCount !== 1 || selection.isCollapsed) return hideSelectionFollowup()
  const text = selection.toString().trim()
  const range = selection.getRangeAt(0)
  const target = text === '' || text.length > 4000 ? null : selectionFollowupTarget(range)
  const rect = range.getBoundingClientRect()
  if (target === null || rect.width === 0 || rect.height === 0) return hideSelectionFollowup()
  selectionFollowup = { ...target, text }
  button.dataset.thread = target.threadId
  button.style.left = `${Math.min(window.innerWidth - 12, Math.max(76, rect.right))}px`
  button.style.top = `${Math.min(window.innerHeight - 38, Math.max(8, rect.bottom + 8))}px`
  button.hidden = false
}

function queueSelectionFollowup() {
  if (selectionFollowupFrame !== 0) return
  selectionFollowupFrame = window.requestAnimationFrame(updateSelectionFollowup)
}

app.addEventListener('pointerdown', event => {
  const viewport = canvasViewport(event.target)
  if (!(viewport instanceof HTMLElement) || event.target instanceof Element && event.target.closest('.thread-card, .canvas-note, .canvas-image, .canvas-frame, .canvas-shape, .canvas-frame-head, button, textarea, select, [contenteditable="true"]')) return
  // The note tool turns the next empty-canvas press into a placement, then hands
  // the canvas back to panning (contract §4); everything else pans as before.
  if (state.canvasTool === 'note') { event.preventDefault(); createNoteFromPointer(viewport, event); return }
  // `select` marquees and the draw tools paint; the pan tool keeps the default.
  if (state.canvasTool === 'select') { event.preventDefault(); startMarqueeGesture(viewport, event); return }
  if (state.canvasTool === 'arrow' || state.canvasTool === 'rect' || state.canvasTool === 'ellipse') { event.preventDefault(); startShapeDraw(viewport, event, state.canvasTool); return }
  event.preventDefault()
  const origin = { x: event.clientX, y: event.clientY, camera: { ...state.canvasCamera } }
  let pendingCamera = null
  let frame = 0
  state.canvasGesture = true
  viewport.classList.add('is-panning')
  viewport.setPointerCapture(event.pointerId)
  const apply = () => {
    frame = 0
    if (pendingCamera === null) return
    state.canvasCamera = pendingCamera
    pendingCamera = null
    applyCanvasTransform()
    syncCanvasViewport()
  }
  const move = moveEvent => {
    pendingCamera = {
      x: origin.camera.x + moveEvent.clientX - origin.x,
      y: origin.camera.y + moveEvent.clientY - origin.y,
    }
    if (frame === 0) frame = window.requestAnimationFrame(apply)
  }
  const stop = () => {
    viewport.classList.remove('is-panning')
    document.removeEventListener('pointermove', move)
    document.removeEventListener('pointerup', stop)
    document.removeEventListener('pointercancel', stop)
    if (frame !== 0) { window.cancelAnimationFrame(frame); frame = 0 }
    apply()
    state.canvasGesture = false
    deferCanvasRefresh(120)
  }
  document.addEventListener('pointermove', move)
  document.addEventListener('pointerup', stop)
  document.addEventListener('pointercancel', stop)
})

app.addEventListener('wheel', event => {
  const viewport = canvasViewport(event.target)
  if (!(viewport instanceof HTMLElement)) return
  const card = event.target instanceof Element ? event.target.closest('.thread-card') : null
  if (card instanceof HTMLElement) {
    // Over a card the wheel scrolls that card's own answer with the browser's
    // native wheel (OS-smooth, never a page jump per notch); the answer's
    // overscroll-behavior: contain stops the scroll chaining into the canvas.
    const answer = card.querySelector('.thread-answer')
    if (answer instanceof HTMLElement && answer.scrollHeight > answer.clientHeight) {
      deferCanvasRefresh()
      return
    }
    // A card with no scrollable answer swallows the wheel instead of zooming.
    event.preventDefault()
    deferCanvasRefresh()
    return
  }
  const noteBody = event.target instanceof Element ? event.target.closest('.canvas-note-body') : null
  if (noteBody instanceof HTMLElement) {
    // A note scrolls its own text like a card answer; never zoom under the caret.
    if (noteBody.scrollHeight > noteBody.clientHeight) {
      deferCanvasRefresh()
      return
    }
    event.preventDefault()
    deferCanvasRefresh()
    return
  }
  event.preventDefault()
  zoomCanvas(viewport, state.zoom + (event.deltaY < 0 ? .05 : -.05), event.clientX, event.clientY)
}, { passive: false })

// Track pointer-down so the card click handler can tell a plain click from a
// text-selection or drag gesture; acting on the latter would re-render and
// wipe the user's selection.
let pointerDownPosition = null
app.addEventListener('pointerdown', event => { pointerDownPosition = { x: event.clientX, y: event.clientY } })
app.addEventListener('pointerdown', event => {
  const button = event.target instanceof Element ? event.target.closest('.selection-followup') : null
  if (button instanceof HTMLButtonElement) event.preventDefault()
  else hideSelectionFollowup()
})
app.addEventListener('pointerup', queueSelectionFollowup)
app.addEventListener('scroll', hideSelectionFollowup, true)
document.addEventListener('selectionchange', queueSelectionFollowup)
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || state.mode !== 'canvas' || state.inspectorCardId === null) return
  event.preventDefault()
  closeCardInspector({ animate: false })
})

app.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]')
  if (!(button instanceof HTMLElement)) {
    const card = event.target instanceof Element ? event.target.closest('.thread-card[data-thread]:not(.draft-card)') : null
    if (!(card instanceof HTMLElement) || event.target instanceof Element && event.target.closest('.node-handle, textarea, select, form')) return
    // A double-click selects a word and a drag selects a range; neither is a
    // select-click, so leave the selection intact instead of re-rendering.
    if (event.detail > 1) return
    if (pointerDownPosition !== null
      && Math.hypot(event.clientX - pointerDownPosition.x, event.clientY - pointerDownPosition.y) > 4) return
    const thread = state.workspace?.threads.find(item => item.id === card.dataset.thread)
    if (thread === undefined) return
    const cardId = card.dataset.cardId
    if (cardId === undefined) return
    const dataCard = state.canvasCardsById?.get(cardId)
    const cardKey = dataCard === undefined ? '' : cardPositionKey(dataCard)
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      // Multi-select: toggle this card and never open the inspector.
      if (cardKey !== '') {
        if (state.selectedCardKeys.has(cardKey)) state.selectedCardKeys.delete(cardKey)
        else state.selectedCardKeys.add(cardKey)
        card.classList.toggle('selected', state.selectedCardKeys.has(cardKey))
      }
      return
    }
    state.selectedCardKeys.clear()
    state.selectedNodeIds.clear()
    state.activeId = thread.id
    state.selectedCardId = cardId
    openCardInspector(cardId)
    state.error = ''
    render()
    void loadThreadHistory(thread)
    // Bidirectional current-session sync: switch DSH's current session
    // without closing the map; the client confirms via synapse:current-session.
    if (thread.dshSessionId !== null) {
      if (thread.dshSessionId !== state.currentDsh?.id) state.mapCardSessionSwitches.add(thread.dshSessionId)
      post('synapse:activate-session', { sessionId: thread.dshSessionId })
    }
    return
  }
  const thread = state.workspace?.threads.find(item => item.id === button.dataset.thread)
  try {
    if (button.dataset.action === 'follow-selection') {
      const followup = selectionFollowup
      hideSelectionFollowup()
      if (followup !== null && thread !== undefined && thread.id === followup.threadId && state.draft === null) openContinue(thread, undefined, followup.text)
      return
    }
    if (button.dataset.action === 'insert-quick-phrase' && button.dataset.quickPhrase !== undefined) insertQuickPhrase(button.dataset.quickPhrase)
    if (button.dataset.action === 'open-quick-phrase-editor') { state.quickPhraseEditorOpen = true; render() }
    if (button.dataset.action === 'close-quick-phrase-editor') { state.quickPhraseEditorOpen = false; render() }
    if (button.dataset.action === 'add-quick-phrase') {
      const editor = button.closest('.draft-quick-phrase-add')
      const input = editor?.querySelector('input')
      if (input instanceof HTMLInputElement && addQuickPhrase(input.value)) {
        render()
        window.setTimeout(() => document.querySelector('.draft-quick-phrase-add input')?.focus(), 0)
      }
    }
    if (button.dataset.action === 'remove-quick-phrase') {
      const index = Number(button.dataset.quickPhraseIndex)
      if (Number.isInteger(index) && index >= 0 && index < state.quickPhrases.length) {
        state.quickPhrases.splice(index, 1)
        persistQuickPhrases()
        render()
      }
    }
    if (button.dataset.action === 'close') post('synapse:close')
    if (button.dataset.action === 'close-card-inspector') { closeCardInspector(); return }
    if (button.dataset.action === 'toggle-sidebar') { state.sidebarCollapsed = !state.sidebarCollapsed; render() }
    if (button.dataset.action === 'create-session') openNewSession()
    if (button.dataset.action === 'open-current' && state.currentDsh !== null) post('synapse:open-session', { sessionId: state.currentDsh.id })
    if (button.dataset.action === 'select-thread' && thread !== undefined) {
      state.mapCardSessionSwitches.clear()
      state.activeId = thread.id
      state.selectedCardId = null
      state.inspectorCardId = null
      state.inspectorOpening = false
      state.error = ''
      if (state.workspace !== null) revealConversationThread(conversationCards(state.workspace.threads), thread.id)
      revealFramesForThread(thread.id)
      render()
      // The state switch is instant, so the map has to show it: without this the
      // camera stayed on the previous conversation's cards (often thousands of
      // pixels away), and a click that worked looked like a dead button.
      window.requestAnimationFrame(() => { if (state.mode === 'canvas') focusActiveCard() })
      void loadThreadHistory(thread)
      // Bidirectional current-session sync: switch DSH's current session
      // without closing the map; the client confirms via synapse:current-session.
      if (thread.dshSessionId !== null) post('synapse:activate-session', { sessionId: thread.dshSessionId })
    }
    if (button.dataset.action === 'show-thread' && thread !== undefined) { state.activeId = thread.id; state.mode = 'thread'; state.detailTargetCardId = button.dataset.card ?? null; render(); void loadThreadHistory(thread) }
    if (button.dataset.action === 'show-canvas') { state.mode = 'canvas'; render() }
    if (button.dataset.action === 'toggle-card-children' && button.dataset.card !== undefined) {
      const cardId = button.dataset.card
      const collapsing = !state.collapsedCardIds.has(cardId)
      if (collapsing && state.workspace !== null) {
        const allCards = conversationCards(state.workspace.threads)
        const nextCollapsed = new Set(state.collapsedCardIds).add(cardId)
        const visibleCards = conversationGraphView(allCards, nextCollapsed).cards
        const visibleIds = new Set(visibleCards.map(card => card.id))
        const draftParentId = draftPlacement(allCards)?.parent.id
        if (draftParentId !== undefined && !visibleIds.has(draftParentId)) return setError('请先完成或取消正在编辑的追问或分支')
        // Collapsing is a view operation, so it is never refused: it used to be
        // blocked whenever the active conversation would be hidden, which made
        // "−" look dead on exactly the newest card people press it on. Keep the
        // camera useful instead, by re-focusing after the collapse below.
      }
      collapsing ? state.collapsedCardIds.add(cardId) : state.collapsedCardIds.delete(cardId)
      persistCollapsedCards()
      // Keep the viewport exactly where it is: folding is about hiding a
      // subtree, not about re-framing the canvas (moving the camera on every
      // fold is disorienting). Focus the handle without scrolling for a11y.
      render()
      window.setTimeout(() => document.querySelector(`[data-action="toggle-card-children"][data-card="${selectorValue(cardId)}"]`)?.focus({ preventScroll: true }), 0)
    }
    if (button.dataset.action === 'open-continue' && thread !== undefined) openContinue(thread, button.dataset.card)
    if (button.dataset.action === 'open-branch' && thread !== undefined) {
      const requestedSeq = Number(button.dataset.seq)
      if (button.dataset.card !== undefined && !Number.isInteger(requestedSeq)) return setError('请等待这张卡片的最终回答后再创建分支')
      const fallbackSeq = latestMessage(thread, 'assistant')?.sourceSeq
      openBranch(thread, Number.isInteger(requestedSeq) ? requestedSeq : fallbackSeq, button.dataset.card)
    }
    if (button.dataset.action === 'cancel-draft') { state.draft = null; state.quickPhraseEditorOpen = false; render() }
    if (button.dataset.action === 'toggle-message' && button.dataset.message !== undefined) { state.expandedMessageIds.has(button.dataset.message) ? state.expandedMessageIds.delete(button.dataset.message) : state.expandedMessageIds.add(button.dataset.message); renderPreservingDetailScroll() }
    if (button.dataset.action === 'open-dsh' && thread?.dshSessionId !== null) post('synapse:open-session', { sessionId: thread.dshSessionId, seq: Number.isInteger(Number(button.dataset.seq)) ? Number(button.dataset.seq) : undefined })
    if (button.dataset.action === 'archive-thread' && thread !== undefined) await archiveThread(thread)
    if (button.dataset.action === 'zoom-in') zoomCanvasAtCenter(.1)
    if (button.dataset.action === 'zoom-out') zoomCanvasAtCenter(-.1)
    if (button.dataset.action === 'focus-active') focusActiveCard()
    if (button.dataset.action === 'dismiss-error') { state.error = ''; render() }
    if (button.dataset.action === 'layout' && state.workspace !== null) {
      resetCardPositions()
      resetCanvasCamera()
      render()
      // The Host owns the layout now: without this the next payload change would
      // restore the positions the user just cleared with 整理. Frames are re-fit
      // so their members stay inside the box after the re-layout.
      syncAllCardPositionsToHost()
      refitFramesToMembers()
      render()
    }
    if (button.dataset.action === 'add-note') {
      state.canvasTool = state.canvasTool === 'note' ? 'pan' : 'note'
      render()
      return
    }
    if (button.dataset.action === 'add-image') { openImagePicker(); return }
    if (button.dataset.action === 'draw-arrow' || button.dataset.action === 'draw-rect' || button.dataset.action === 'draw-ellipse') {
      const tool = button.dataset.action.slice(5)
      state.canvasTool = state.canvasTool === tool ? 'pan' : tool
      render()
      return
    }
    if (button.dataset.action === 'select-tool') {
      state.canvasTool = state.canvasTool === 'select' ? 'pan' : 'select'
      render()
      return
    }
    if (button.dataset.action === 'group-selection') { void groupSelection(); return }
    if (button.dataset.action === 'toggle-frame' && button.dataset.frame !== undefined) { void toggleFrameCollapse(button.dataset.frame); return }
    if (button.dataset.action === 'delete-node' && button.dataset.node !== undefined) { void deleteCanvasNode(button.dataset.node); return }
  } catch (error) { setError(error) }
})

// --- canvas nodes: gestures, editing and Host IO -----------------------------
// The annotation layers are re-created by the morph on every render, so node
// gestures are delegated from `app` once instead of being rebound per node.
// Contract: .recon/contract.md §3 (DOM) and §4 (interaction).
let lastPointerWorld = null

function canvasViewportElement() {
  const viewport = document.querySelector('.canvas-viewport')
  return viewport instanceof HTMLElement ? viewport : null
}

/** Screen (client) coordinates → world coordinates, matching zoomCanvas. */
function worldFromClient(viewport, clientX, clientY) {
  const bounds = viewport.getBoundingClientRect()
  return {
    x: clampNodeCoordinate((clientX - bounds.left - state.canvasCamera.x) / state.zoom),
    y: clampNodeCoordinate((clientY - bounds.top - state.canvasCamera.y) / state.zoom),
  }
}

function canvasCenterWorld() {
  const viewport = canvasViewportElement()
  if (viewport === null) return { x: 0, y: 0 }
  const bounds = viewport.getBoundingClientRect()
  return worldFromClient(viewport, bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
}

function nextNodeZ() {
  let highest = 0
  for (const node of state.nodes.values()) if (typeof node?.z === 'number' && node.z > highest) highest = node.z
  return highest + 1
}

/** Update `state.selectedNodeIds` and mirror it as the `.selected` class. */
function selectNode(nodeId, additive = false) {
  if (additive && state.selectedNodeIds.has(nodeId)) state.selectedNodeIds.delete(nodeId)
  else {
    if (!additive) state.selectedNodeIds.clear()
    state.selectedNodeIds.add(nodeId)
  }
  for (const element of document.querySelectorAll('.canvas-note[data-node-id], .canvas-image[data-node-id], .canvas-frame[data-frame-id], .canvas-shape[data-node-id]')) {
    if (!(element instanceof HTMLElement) && !(element instanceof SVGElement)) continue
    const elementId = element.getAttribute('data-node-id') ?? element.getAttribute('data-frame-id') ?? ''
    element.classList.toggle('selected', state.selectedNodeIds.has(elementId))
  }
}

async function createHostNode(payload) {
  const workspaceId = hostWorkspaceId()
  if (workspaceId === null) throw new Error('当前工作区尚未就绪')
  const body = await api(`/synapse/api/workspaces/${encodeURIComponent(workspaceId)}/nodes`, { method: 'POST', body: JSON.stringify(payload) })
  if (body.node === null || typeof body.node !== 'object' || typeof body.node.id !== 'string') throw new Error('Host 返回的节点无效')
  return body.node
}

async function patchHostNode(nodeId, patch) {
  const body = await api(`/synapse/api/nodes/${encodeURIComponent(nodeId)}`, { method: 'PATCH', body: JSON.stringify(patch) })
  return body.node
}

async function deleteHostNode(nodeId) {
  return api(`/synapse/api/nodes/${encodeURIComponent(nodeId)}`, { method: 'DELETE' })
}

function createNoteFromPointer(viewport, event) {
  state.canvasTool = 'pan'
  createNoteAt(worldFromClient(viewport, event.clientX, event.clientY))
}

function createNoteAt(point) {
  const node = {
    id: `tmp:${crypto.randomUUID()}`,
    type: 'note',
    x: clampNodeCoordinate(point.x),
    y: clampNodeCoordinate(point.y),
    width: NODE_DEFAULT_WIDTH,
    height: NODE_DEFAULT_HEIGHT,
    z: nextNodeZ(),
    text: '',
    color: 'yellow',
    pendingCreate: true,
  }
  state.nodes.set(node.id, node)
  selectNode(node.id, false)
  render()
  window.setTimeout(() => {
    const body = document.querySelector(`[data-node-id="${CSS.escape(node.id)}"] .canvas-note-body`)
    if (body instanceof HTMLElement) body.focus()
  }, 0)
  // Optimistic node first (the canvas answers immediately), then adopt the Host
  // id. A failed create removes the node again — leaving it would silently lose
  // the note on the next poll.
  void createHostNode({ type: 'note', x: node.x, y: node.y, width: node.width, height: node.height, text: node.text, color: node.color })
    .then(created => replaceOptimisticNode(node.id, created))
    .catch(error => {
      state.nodes.delete(node.id)
      state.selectedNodeIds.delete(node.id)
      render()
      setError(`便签保存失败：${error instanceof Error ? error.message : 'Host 未响应'}`)
    })
}

function replaceOptimisticNode(tempId, created) {
  const local = state.nodes.get(tempId)
  const next = { ...created }
  if (local !== undefined) {
    if (local.textDirty === true) {
      next.text = local.text
      void patchHostNode(next.id, { text: local.text }).catch(error => setError(`便签保存失败：${error instanceof Error ? error.message : 'Host 未响应'}`))
    }
    if (!Number.isFinite(created.width) && Number.isFinite(local.width)) next.width = local.width
    if (!Number.isFinite(created.height) && Number.isFinite(local.height)) next.height = local.height
  }
  state.nodes.delete(tempId)
  state.nodes.set(next.id, next)
  if (state.selectedNodeIds.delete(tempId)) state.selectedNodeIds.add(next.id)
  if (state.noteEditingId === tempId) {
    state.noteEditingId = next.id
    // Re-keying the live node in place keeps the caret: a render here would
    // replace the keyed node (note:tmp… → note:<uuid>) under the user.
    const element = document.querySelector(`[data-node-id="${CSS.escape(tempId)}"]`)
    if (element instanceof HTMLElement) {
      element.dataset.nodeId = next.id
      element.setAttribute('data-morph-key', `note:${next.id}`)
    }
    return
  }
  render()
}

function commitNoteText(nodeId, body) {
  const node = state.nodes.get(nodeId)
  if (node === undefined || node.type !== 'note') return
  const text = normalizeNoteText(typeof body.innerText === 'string' ? body.innerText : body.textContent ?? '')
  if (text === (node.text ?? '')) return
  node.text = text
  if (node.pendingCreate === true) {
    node.textDirty = true
    return
  }
  void patchHostNode(nodeId, { text }).catch(error => setError(`便签保存失败：${error instanceof Error ? error.message : 'Host 未响应'}`))
}

async function deleteCanvasNode(nodeId) {
  const node = state.nodes.get(nodeId)
  if (node === undefined) return
  state.nodes.delete(nodeId)
  state.selectedNodeIds.delete(nodeId)
  state.pendingNodeDeletes.add(nodeId)
  render()
  if (nodeId.startsWith('tmp:')) {
    state.pendingNodeDeletes.delete(nodeId)
    return
  }
  try {
    await deleteHostNode(nodeId)
    state.pendingNodeDeletes.delete(nodeId)
  } catch (error) {
    state.pendingNodeDeletes.delete(nodeId)
    state.nodes.set(nodeId, node)
    render()
    setError(`删除失败：${error instanceof Error ? error.message : 'Host 未响应'}`)
  }
}

function openImagePicker() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = IMAGE_MEDIA_TYPES.join(',')
  input.multiple = true
  // A detached input cannot open the picker in every browser; hide it instead.
  input.style.display = 'none'
  document.body.append(input)
  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? [])
    input.remove()
    if (files.length > 0) void addImageFiles(files, canvasCenterWorld())
  }, { once: true })
  input.click()
}

function encodeCanvasBlob(canvas, type, quality) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality })
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => { blob === null ? reject(new Error('图片编码失败')) : resolve(blob) }, type, quality)
  })
}

/** Downscale to MAX_IMAGE_EDGE and encode WebP q0.82 before anything leaves the tab. */
async function compressImageFile(file) {
  if (!isImageMediaType(file.type)) throw new Error('只支持 PNG / JPEG / WebP / GIF 图片')
  if (file.size > MAX_IMAGE_BYTES) throw new Error('图片不能超过 8 MB')
  const bitmap = await createImageBitmap(file)
  try {
    const size = fitImageSize(bitmap.width, bitmap.height, MAX_IMAGE_EDGE)
    const canvas = typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(size.width, size.height)
      : Object.assign(document.createElement('canvas'), { width: size.width, height: size.height })
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('图片解码失败')
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, 0, 0, size.width, size.height)
    const blob = await encodeCanvasBlob(canvas, 'image/webp', IMAGE_WEBP_QUALITY)
    return { blob, width: size.width, height: size.height, mediaType: isImageMediaType(blob.type) ? blob.type : 'image/png' }
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close()
  }
}

async function uploadWorkspaceImage(blob, mediaType = '') {
  const workspaceId = hostWorkspaceId()
  if (workspaceId === null) throw new Error('当前工作区尚未就绪')
  const contentType = mediaType !== '' ? mediaType : blob.type === '' ? 'image/png' : blob.type
  const response = await fetch(`/synapse/api/workspaces/${encodeURIComponent(workspaceId)}/images`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: blob,
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const fallback = response.status === 503 ? 'DSH 附件库不可用，图片暂不能保存' : `图片上传失败（${response.status}）`
    throw new Error(typeof body.error === 'string' && body.error !== '' ? body.error : fallback)
  }
  if (body.image === null || typeof body.image !== 'object') throw new Error('图片上传响应无效')
  return body.image
}

/** Compress → upload → create the image node; one failure never aborts the rest. */
async function addImageFiles(files, point) {
  let offset = 0
  for (const file of files) {
    try {
      const compressed = await compressImageFile(file)
      const image = await uploadWorkspaceImage(compressed.blob, compressed.mediaType)
      const display = fitImageDisplaySize(image.width ?? compressed.width, image.height ?? compressed.height)
      const created = await createHostNode({
        type: 'image',
        x: clampNodeCoordinate(point.x + offset),
        y: clampNodeCoordinate(point.y + offset),
        width: display.width,
        height: display.height,
        image,
      })
      state.nodes.set(created.id, created)
      selectNode(created.id, false)
      render()
      offset += 24
    } catch (error) {
      setError(error instanceof Error ? error.message : '图片插入失败')
    }
  }
}

async function handleCanvasPaste(event) {
  if (state.mode !== 'canvas') return
  const items = Array.from(event.clipboardData?.items ?? [])
  const files = items
    .filter(item => item.kind === 'file' && isImageMediaType(item.type))
    .map(item => item.getAsFile())
    .filter(file => file instanceof File)
  if (files.length === 0) return
  const activeElement = document.activeElement
  const editable = activeElement instanceof Element ? activeElement.closest('textarea, input, select, [contenteditable="true"], [data-draft]') : null
  if (editable !== null) {
    // A note body is text-only (an <img> dropped into it would be lost on the
    // next morph); the composer keeps its own paste behaviour.
    if (editable.closest('[contenteditable="true"]') !== null) {
      event.preventDefault()
      setError('便签只能输入文字；图片请粘贴到画布空白处')
    }
    return
  }
  event.preventDefault()
  await addImageFiles(files, lastPointerWorld ?? canvasCenterWorld())
}

// --- canvas shapes, frames and multi-select ---------------------------------
let cancelCanvasDraw = null

function cardByPositionKey(positionKey) {
  if (typeof positionKey !== 'string' || positionKey === '') return undefined
  for (const card of state.canvasCards ?? []) if (cardPositionKey(card) === positionKey) return card
  return undefined
}

/** Clear every selection flavour and report whether anything was selected. */
function clearCanvasSelection() {
  const hadSelection = state.selectedNodeIds.size > 0 || state.selectedCardKeys.size > 0 || state.selectedCardId !== null
  state.selectedNodeIds.clear()
  state.selectedCardKeys.clear()
  state.selectedCardId = null
  return hadSelection
}

/** Mirror a shape node's geometry onto its live SVG element (drag feedback). */
function applyShapeGeometry(element, node) {
  if (!(element instanceof Element) || node === null || typeof node !== 'object') return
  const line = node.shape === 'line' || node.shape === 'arrow'
  for (const shape of [element.querySelector('.canvas-shape-visible'), element.querySelector('.canvas-shape-hit')]) {
    if (!(shape instanceof SVGElement)) continue
    if (line) {
      shape.setAttribute('x1', String(Math.round(Number(node.x1) || 0)))
      shape.setAttribute('y1', String(Math.round(Number(node.y1) || 0)))
      shape.setAttribute('x2', String(Math.round(Number(node.x2) || 0)))
      shape.setAttribute('y2', String(Math.round(Number(node.y2) || 0)))
      continue
    }
    const bounds = nodeBounds(node)
    if (bounds === null) continue
    if (shape.tagName.toLowerCase() === 'ellipse') {
      shape.setAttribute('cx', String(Math.round(bounds.x + bounds.width / 2)))
      shape.setAttribute('cy', String(Math.round(bounds.y + bounds.height / 2)))
      shape.setAttribute('rx', String(Math.round(Math.max(1, bounds.width / 2))))
      shape.setAttribute('ry', String(Math.round(Math.max(1, bounds.height / 2))))
    } else {
      shape.setAttribute('x', String(Math.round(bounds.x)))
      shape.setAttribute('y', String(Math.round(bounds.y)))
      shape.setAttribute('width', String(Math.round(bounds.width)))
      shape.setAttribute('height', String(Math.round(bounds.height)))
    }
  }
  if (!line) return
  const from = element.querySelector('[data-shape-handle="from"]')
  const to = element.querySelector('[data-shape-handle="to"]')
  if (from instanceof SVGElement) {
    from.setAttribute('cx', String(Math.round(Number(node.x1) || 0)))
    from.setAttribute('cy', String(Math.round(Number(node.y1) || 0)))
  }
  if (to instanceof SVGElement) {
    to.setAttribute('cx', String(Math.round(Number(node.x2) || 0)))
    to.setAttribute('cy', String(Math.round(Number(node.y2) || 0)))
  }
}

/** Press-drag-release draws a shape; a plain click uses the default size. */
function startShapeDraw(viewport, event, tool) {
  const layer = document.querySelector('.shapes-layer')
  if (!(layer instanceof SVGElement)) {
    state.canvasTool = 'pan'
    return
  }
  const tag = tool === 'arrow' || tool === 'line' ? 'line' : tool === 'ellipse' ? 'ellipse' : 'rect'
  const preview = document.createElementNS('http://www.w3.org/2000/svg', tag)
  preview.setAttribute('class', 'canvas-shape-visible')
  preview.setAttribute('stroke-dasharray', '4 3')
  preview.setAttribute('pointer-events', 'none')
  layer.append(preview)
  const origin = worldFromClient(viewport, event.clientX, event.clientY)
  let lastPoint = origin
  let moved = false
  let stopped = false
  state.canvasTool = 'pan'
  state.dragging = true
  const paint = () => {
    if (tag === 'line') {
      preview.setAttribute('x1', String(Math.round(origin.x)))
      preview.setAttribute('y1', String(Math.round(origin.y)))
      preview.setAttribute('x2', String(Math.round(lastPoint.x)))
      preview.setAttribute('y2', String(Math.round(lastPoint.y)))
      return
    }
    const box = normalizeShapeBox(origin, lastPoint)
    if (tag === 'ellipse') {
      preview.setAttribute('cx', String(Math.round(box.x + box.width / 2)))
      preview.setAttribute('cy', String(Math.round(box.y + box.height / 2)))
      preview.setAttribute('rx', String(Math.round(Math.max(1, box.width / 2))))
      preview.setAttribute('ry', String(Math.round(Math.max(1, box.height / 2))))
      return
    }
    preview.setAttribute('x', String(Math.round(box.x)))
    preview.setAttribute('y', String(Math.round(box.y)))
    preview.setAttribute('width', String(Math.round(box.width)))
    preview.setAttribute('height', String(Math.round(box.height)))
  }
  const detach = () => {
    document.removeEventListener('pointermove', move)
    document.removeEventListener('pointerup', up)
    document.removeEventListener('pointercancel', cancel)
    preview.remove()
    state.dragging = false
    deferCanvasRefresh(120)
    cancelCanvasDraw = null
  }
  const commit = () => {
    if (tag === 'line') {
      return {
        type: 'shape',
        shape: tool === 'line' ? 'line' : 'arrow',
        x1: clampNodeCoordinate(origin.x),
        y1: clampNodeCoordinate(origin.y),
        x2: clampNodeCoordinate(moved ? lastPoint.x : origin.x + DEFAULT_ARROW_LENGTH),
        y2: clampNodeCoordinate(moved ? lastPoint.y : origin.y),
      }
    }
    const box = moved ? normalizeShapeBox(origin, lastPoint) : defaultShapeGeometry(tool, origin)
    return {
      type: 'shape',
      shape: tool === 'ellipse' ? 'ellipse' : 'rect',
      x: clampNodeCoordinate(box.x),
      y: clampNodeCoordinate(box.y),
      width: clampNodeDimension(box.width, MIN_NODE_WIDTH),
      height: clampNodeDimension(box.height, MIN_NODE_HEIGHT),
    }
  }
  const finish = persist => {
    if (stopped) return
    stopped = true
    detach()
    if (!persist) {
      render()
      return
    }
    const payload = commit()
    void createHostNode(payload)
      .then(created => {
        state.nodes.set(created.id, created)
        selectNode(created.id, false)
        render()
      })
      .catch(error => {
        render()
        setError(`图形保存失败：${error instanceof Error ? error.message : 'Host 未响应'}`)
      })
  }
  const move = moveEvent => {
    if (!moved && Math.hypot(moveEvent.clientX - event.clientX, moveEvent.clientY - event.clientY) < SHAPE_DRAG_THRESHOLD) return
    moved = true
    lastPoint = worldFromClient(viewport, moveEvent.clientX, moveEvent.clientY)
    paint()
  }
  const up = () => finish(true)
  const cancel = () => finish(false)
  cancelCanvasDraw = cancel
  paint()
  document.addEventListener('pointermove', move)
  document.addEventListener('pointerup', up)
  document.addEventListener('pointercancel', cancel)
}

/** Marquee selection: empty-canvas drag while the `select` tool is active. */
function startMarqueeGesture(viewport, event) {
  event.preventDefault()
  const bounds = viewport.getBoundingClientRect()
  const marquee = document.createElement('div')
  marquee.className = 'canvas-marquee'
  viewport.append(marquee)
  const origin = { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
  let rect = { left: origin.x, top: origin.y, width: 0, height: 0 }
  let frame = 0
  let stopped = false
  state.canvasGesture = true
  const paint = () => {
    frame = 0
    marquee.style.left = `${Math.round(rect.left)}px`
    marquee.style.top = `${Math.round(rect.top)}px`
    marquee.style.width = `${Math.round(rect.width)}px`
    marquee.style.height = `${Math.round(rect.height)}px`
  }
  const move = moveEvent => {
    const point = { x: moveEvent.clientX - bounds.left, y: moveEvent.clientY - bounds.top }
    rect = {
      left: Math.min(origin.x, point.x),
      top: Math.min(origin.y, point.y),
      width: Math.abs(point.x - origin.x),
      height: Math.abs(point.y - origin.y),
    }
    if (frame === 0) frame = window.requestAnimationFrame(paint)
  }
  const stop = () => {
    if (stopped) return
    stopped = true
    document.removeEventListener('pointermove', move)
    document.removeEventListener('pointerup', stop)
    document.removeEventListener('pointercancel', stop)
    if (frame !== 0) { window.cancelAnimationFrame(frame); frame = 0 }
    marquee.remove()
    state.canvasGesture = false
    deferCanvasRefresh(120)
    if (rect.width < SHAPE_DRAG_THRESHOLD && rect.height < SHAPE_DRAG_THRESHOLD) {
      // A plain click on the void clears the selection.
      clearCanvasSelection()
      render()
      return
    }
    const hidden = collapsedFrameMembers([...state.nodes.values()])
    // Frames are containers (selected from their header), and collapsed members
    // are not on screen, so neither takes part in a marquee.
    const marqueeNodes = [...state.nodes.values()].filter(node => node.type !== 'frame' && !hidden.nodeIds.has(node.id))
    const selection = marqueeSelection(state.canvasCards ?? [], marqueeNodes, marqueeWorldRect(rect, state.canvasCamera, state.zoom))
    state.selectedNodeIds = new Set(selection.nodeIds)
    state.selectedCardKeys = new Set(selection.cardKeys)
    state.selectedCardId = null
    render()
  }
  paint()
  document.addEventListener('pointermove', move)
  document.addEventListener('pointerup', stop)
  document.addEventListener('pointercancel', stop)
}

/** Move a whole shape, or drag one end of a line/arrow. */
function startShapePointerGesture(element, handleElement, event) {
  const nodeId = element.getAttribute('data-node-id')
  if (typeof nodeId !== 'string') return
  const node = state.nodes.get(nodeId)
  if (node === undefined || node.type !== 'shape') return
  event.preventDefault()
  const additive = event.shiftKey || event.ctrlKey || event.metaKey
  const selectionChanged = additive ? !state.selectedNodeIds.has(nodeId) : state.selectedNodeIds.size !== 1 || !state.selectedNodeIds.has(nodeId)
  selectNode(nodeId, additive)
  // Endpoint handles only exist on a selected line/arrow, so a fresh selection
  // needs one render before the far end can be grabbed on the next press.
  if (selectionChanged && (node.shape === 'line' || node.shape === 'arrow')) render()
  const endpoint = handleElement instanceof Element ? handleElement.getAttribute('data-shape-handle') : null
  const origin = { x: event.clientX, y: event.clientY }
  const start = { ...node }
  let moved = false
  state.dragging = true
  const move = moveEvent => {
    const dx = (moveEvent.clientX - origin.x) / state.zoom
    const dy = (moveEvent.clientY - origin.y) / state.zoom
    if (!moved && Math.hypot(dx, dy) < 1) return
    moved = true
    if (endpoint === 'from' || endpoint === 'to') {
      const point = endpoint === 'from'
        ? { x: Number(start.x1) + dx, y: Number(start.y1) + dy }
        : { x: Number(start.x2) + dx, y: Number(start.y2) + dy }
      Object.assign(node, shapeEndpointPatch(start, endpoint, point))
    } else {
      Object.assign(node, shapeMovePatch(start, dx, dy))
    }
    applyShapeGeometry(element, node)
  }
  const stop = () => {
    document.removeEventListener('pointermove', move)
    document.removeEventListener('pointerup', stop)
    document.removeEventListener('pointercancel', stop)
    state.dragging = false
    deferCanvasRefresh(120)
    if (!moved || nodeId.startsWith('tmp:')) return
    const line = node.shape === 'line' || node.shape === 'arrow'
    const patch = endpoint === 'from' || endpoint === 'to'
      ? (endpoint === 'from'
        ? { x1: Math.round(Number(node.x1)), y1: Math.round(Number(node.y1)) }
        : { x2: Math.round(Number(node.x2)), y2: Math.round(Number(node.y2)) })
      : line
        ? { x1: Math.round(Number(node.x1)), y1: Math.round(Number(node.y1)), x2: Math.round(Number(node.x2)), y2: Math.round(Number(node.y2)) }
        : { x: Math.round(Number(node.x)), y: Math.round(Number(node.y)) }
    void patchHostNode(nodeId, patch).catch(error => setError(`图形保存失败：${error instanceof Error ? error.message : 'Host 未响应'}`))
  }
  document.addEventListener('pointermove', move)
  document.addEventListener('pointerup', stop)
  document.addEventListener('pointercancel', stop)
}

function updateFrameCount(frame) {
  const element = document.querySelector(`.canvas-frame[data-frame-id="${CSS.escape(frame.id)}"] .canvas-frame-count`)
  if (element !== null) element.textContent = String(Array.isArray(frame.memberCards) ? frame.memberCards.length : 0)
}

/** Dragging a member card pulls it out of its frame (contract §4). */
function detachCardFromFrame(positionKey) {
  if (typeof positionKey !== 'string' || positionKey === '') return
  for (const node of state.nodes.values()) {
    if (node.type !== 'frame' || !Array.isArray(node.memberCards)) continue
    if (!node.memberCards.includes(positionKey)) continue
    node.memberCards = node.memberCards.filter(key => key !== positionKey)
    updateFrameCount(node)
    // The Host clears `thread.frameId` when the frame's memberCards change.
    if (!node.id.startsWith('tmp:')) void patchHostNode(node.id, { memberCards: node.memberCards }).catch(error => setError(`分组更新失败：${error instanceof Error ? error.message : 'Host 未响应'}`))
    return
  }
}

/** Remove freshly grouped members from any other frame they belonged to. */
async function detachMembersFromOtherFrames(cardKeys, nodeIds) {
  const cardSet = new Set(cardKeys)
  const nodeSet = new Set(nodeIds)
  for (const node of [...state.nodes.values()]) {
    if (node.type !== 'frame') continue
    const currentCards = Array.isArray(node.memberCards) ? node.memberCards : []
    const currentNodes = Array.isArray(node.memberNodes) ? node.memberNodes : []
    const nextCards = currentCards.filter(key => !cardSet.has(key))
    const nextNodes = currentNodes.filter(id => !nodeSet.has(id))
    if (nextCards.length === currentCards.length && nextNodes.length === currentNodes.length) continue
    node.memberCards = nextCards
    node.memberNodes = nextNodes
    if (node.id.startsWith('tmp:')) continue
    await patchHostNode(node.id, { memberCards: nextCards, memberNodes: nextNodes }).catch(() => {})
  }
}

/** Expand frames that hide cards of `threadId`; returns whether anything moved. */
function revealFramesForThread(threadId) {
  if (typeof threadId !== 'string' || threadId === '') return false
  let changed = false
  for (const node of state.nodes.values()) {
    if (node.type !== 'frame' || node.collapsed !== true) continue
    const members = Array.isArray(node.memberCards) ? node.memberCards : []
    if (!members.some(key => key.startsWith(`${threadId}:`))) continue
    node.collapsed = false
    changed = true
    if (!node.id.startsWith('tmp:')) void patchHostNode(node.id, { collapsed: false }).catch(() => {})
  }
  return changed
}

/** Group the current selection into a frame (contract §4, padding 28 + header 34). */
async function groupSelection() {
  const cardKeys = [...state.selectedCardKeys].filter(key => cardByPositionKey(key) !== undefined || state.cardPositions.has(key))
  const memberNodes = [...state.selectedNodeIds].filter(id => {
    if (id.startsWith('tmp:')) return false
    const node = state.nodes.get(id)
    return node !== undefined && node.type !== 'frame'
  })
  const cards = cardKeys.map(key => cardByPositionKey(key)).filter(card => card !== undefined)
  if (cards.length === 0 && memberNodes.length === 0) {
    setError('请先选择要分组的卡片或元素')
    return
  }
  const bounds = groupBoundsOf(cards, memberNodes.map(id => state.nodes.get(id)), 28, 34)
  if (bounds === null) {
    setError('无法计算分组范围')
    return
  }
  try {
    const created = await createHostNode({
      type: 'frame',
      x: clampNodeCoordinate(bounds.x),
      y: clampNodeCoordinate(bounds.y),
      width: clampNodeDimension(bounds.width, MIN_NODE_WIDTH),
      height: clampNodeDimension(bounds.height, MIN_NODE_HEIGHT),
      title: nextFrameTitle([...state.nodes.values()]),
      collapsed: false,
      memberCards: cardKeys,
      memberNodes,
    })
    // The new frame owns these members now; release them from older frames.
    await detachMembersFromOtherFrames(cardKeys, memberNodes)
    state.nodes.set(created.id, created)
    clearCanvasSelection()
    render()
  } catch (error) {
    setError(`分组保存失败：${error instanceof Error ? error.message : 'Host 未响应'}`)
  }
}

/** Collapse/expand a frame. Collapsing never moves the camera (contract §4). */
async function toggleFrameCollapse(frameId) {
  const frame = state.nodes.get(frameId)
  if (frame === undefined || frame.type !== 'frame') return
  const collapsing = frame.collapsed !== true
  if (collapsing) {
    const draftParent = draftPlacement(state.canvasCards ?? [])?.parent
    if (draftParent !== undefined && (Array.isArray(frame.memberCards) ? frame.memberCards : []).includes(cardPositionKey(draftParent))) {
      setError('请先完成或取消正在编辑的追问或分支')
      return
    }
  }
  frame.collapsed = collapsing
  render()
  try {
    await patchHostNode(frameId, { collapsed: collapsing })
  } catch (error) {
    setError(`分组保存失败：${error instanceof Error ? error.message : 'Host 未响应'}`)
  }
}

/** Every card of the workspace by positionKey, hidden-by-collapse ones included. */
function projectedCardsByKey() {
  const map = new Map()
  if (state.workspace === null || state.workspace === undefined) return map
  for (const card of conversationCards(state.workspace.threads ?? [])) map.set(cardPositionKey(card), card)
  return map
}

/** Re-fit every frame around its members (used after 整理 resets the layout). */
function refitFramesToMembers() {
  const byKey = projectedCardsByKey()
  for (const frame of [...state.nodes.values()]) {
    if (frame === null || typeof frame !== 'object' || frame.type !== 'frame') continue
    const cards = (Array.isArray(frame.memberCards) ? frame.memberCards : []).map(key => byKey.get(key)).filter(card => card !== undefined)
    const nodes = (Array.isArray(frame.memberNodes) ? frame.memberNodes : [])
      .map(id => state.nodes.get(id))
      .filter(node => node !== undefined && node.type !== 'frame')
    const bounds = groupBoundsOf(cards, nodes, 28, 34)
    if (bounds === null) continue
    frame.x = clampNodeCoordinate(bounds.x)
    frame.y = clampNodeCoordinate(bounds.y)
    frame.width = clampNodeDimension(bounds.width, MIN_NODE_WIDTH)
    frame.height = clampNodeDimension(bounds.height, MIN_NODE_HEIGHT)
    if (frame.id.startsWith('tmp:')) continue
    void patchHostNode(frame.id, { x: frame.x, y: frame.y, width: frame.width, height: frame.height }).catch(() => {})
  }
}

/** Whole-group move: only the frame header starts it (contract §4). */
function startFrameDrag(frameHead, event) {
  const frameId = frameHead.getAttribute('data-frame-drag')
  if (typeof frameId !== 'string') return
  const frame = state.nodes.get(frameId)
  if (frame === undefined || frame.type !== 'frame') return
  event.preventDefault()
  selectNode(frameId, event.shiftKey || event.ctrlKey || event.metaKey)
  const frameElement = document.querySelector(`.canvas-frame[data-frame-id="${CSS.escape(frameId)}"]`)
  const memberCardKeys = Array.isArray(frame.memberCards) ? [...frame.memberCards] : []
  // Cards hidden by a collapsed frame are not in `state.canvasCards`, so resolve
  // their positions from the full projection (they still have to move with the group).
  const allCardsByKey = projectedCardsByKey()
  const base = {
    frame: { x: Number(frame.x) || 0, y: Number(frame.y) || 0 },
    cards: memberCardKeys.map(key => {
      const card = cardByPositionKey(key) ?? allCardsByKey.get(key)
      const stored = state.cardPositions.get(key)
      const position = card?.position ?? stored ?? { x: 0, y: 0 }
      return { key, card, position: { x: Number(position.x) || 0, y: Number(position.y) || 0 } }
    }),
    nodes: (Array.isArray(frame.memberNodes) ? frame.memberNodes : [])
      .map(id => state.nodes.get(id))
      .filter(node => node !== undefined && node.type !== 'frame')
      .map(node => ({ node, snapshot: { ...node } })),
  }
  const origin = { x: event.clientX, y: event.clientY }
  let moved = false
  state.dragging = true
  const apply = (dx, dy) => {
    frame.x = clampNodeCoordinate(base.frame.x + dx)
    frame.y = clampNodeCoordinate(base.frame.y + dy)
    if (frameElement instanceof HTMLElement) {
      frameElement.style.left = `${Math.round(frame.x)}px`
      frameElement.style.top = `${Math.round(frame.y)}px`
    }
    for (const entry of base.cards) {
      const next = { x: clampNodeCoordinate(entry.position.x + dx), y: clampNodeCoordinate(entry.position.y + dy) }
      state.cardPositions.set(entry.key, next)
      if (entry.card === undefined) continue
      entry.card.position = next
      state.cardPositions.set(entry.card.id, next)
      const element = document.querySelector(`.thread-card[data-card-id="${CSS.escape(entry.card.id)}"]`)
      if (element instanceof HTMLElement) {
        element.style.left = `${next.x}px`
        element.style.top = `${next.y}px`
      }
      refreshCardConnectors(entry.card.id)
    }
    for (const entry of base.nodes) {
      if (entry.node.type === 'shape') {
        Object.assign(entry.node, shapeMovePatch(entry.snapshot, dx, dy))
        const element = document.querySelector(`.canvas-shape[data-node-id="${CSS.escape(entry.node.id)}"]`)
        if (element instanceof Element) applyShapeGeometry(element, entry.node)
        continue
      }
      entry.node.x = clampNodeCoordinate(Number(entry.snapshot.x) + dx)
      entry.node.y = clampNodeCoordinate(Number(entry.snapshot.y) + dy)
      const element = document.querySelector(`.canvas-note[data-node-id="${CSS.escape(entry.node.id)}"], .canvas-image[data-node-id="${CSS.escape(entry.node.id)}"]`)
      if (element instanceof HTMLElement) {
        element.style.left = `${Math.round(entry.node.x)}px`
        element.style.top = `${Math.round(entry.node.y)}px`
      }
    }
  }
  const move = moveEvent => {
    const dx = (moveEvent.clientX - origin.x) / state.zoom
    const dy = (moveEvent.clientY - origin.y) / state.zoom
    if (!moved && Math.hypot(dx, dy) < 1) return
    moved = true
    apply(dx, dy)
  }
  const stop = () => {
    document.removeEventListener('pointermove', move)
    document.removeEventListener('pointerup', stop)
    document.removeEventListener('pointercancel', stop)
    state.dragging = false
    deferCanvasRefresh(120)
    if (!moved) return
    if (!frameId.startsWith('tmp:')) void patchHostNode(frameId, { x: Math.round(frame.x), y: Math.round(frame.y) }).catch(error => setError(`分组保存失败：${error instanceof Error ? error.message : 'Host 未响应'}`))
    for (const entry of base.cards) {
      const next = state.cardPositions.get(entry.key)
      if (next !== undefined) queueCardPositionSync(entry.key, next)
    }
    for (const entry of base.nodes) {
      if (entry.node.id.startsWith('tmp:')) continue
      const patch = entry.node.type === 'shape'
        ? (entry.node.shape === 'line' || entry.node.shape === 'arrow'
          ? { x1: Math.round(Number(entry.node.x1)), y1: Math.round(Number(entry.node.y1)), x2: Math.round(Number(entry.node.x2)), y2: Math.round(Number(entry.node.y2)) }
          : { x: Math.round(Number(entry.node.x)), y: Math.round(Number(entry.node.y)) })
        : { x: Math.round(Number(entry.node.x)), y: Math.round(Number(entry.node.y)) }
      void patchHostNode(entry.node.id, patch).catch(error => setError(`节点保存失败：${error instanceof Error ? error.message : 'Host 未响应'}`))
    }
  }
  document.addEventListener('pointermove', move)
  document.addEventListener('pointerup', stop)
  document.addEventListener('pointercancel', stop)
}

// Node drag + bottom-right resize. The note body keeps native caret behaviour;
// only the note frame, the image frame and the resize corner start a gesture.
app.addEventListener('pointerdown', event => {
  if (state.mode !== 'canvas' || event.button !== 0) return
  const viewport = canvasViewportElement()
  if (viewport !== null) lastPointerWorld = worldFromClient(viewport, event.clientX, event.clientY)
  const target = event.target instanceof Element ? event.target : null
  if (target === null || target.closest('button, [data-action]') !== null) return
  // Frame header → whole-group move (contract §4). The frame body stays
  // transparent so pan/marquee keep working inside it.
  const frameHead = target.closest('.canvas-frame-head[data-frame-drag]')
  if (frameHead instanceof HTMLElement) {
    startFrameDrag(frameHead, event)
    return
  }
  // Shape → move the whole shape, or drag one of its ends while selected.
  // (`.canvas-shape` is an SVG <g>, so it is an Element, not an HTMLElement.)
  const shapeElement = target.closest('.canvas-shape[data-node-id]')
  if (shapeElement instanceof Element) {
    startShapePointerGesture(shapeElement, target.closest('[data-shape-handle]'), event)
    return
  }
  const element = target.closest('.canvas-note[data-node-id], .canvas-image[data-node-id]')
  if (!(element instanceof HTMLElement)) return
  const nodeId = element.dataset.nodeId
  if (typeof nodeId !== 'string') return
  const node = state.nodes.get(nodeId)
  if (node === undefined) return
  const bounds = element.getBoundingClientRect()
  const resizing = event.clientX >= bounds.right - NODE_RESIZE_CORNER && event.clientY >= bounds.bottom - NODE_RESIZE_CORNER
  const inBody = target.closest('.canvas-note-body') !== null
  if (!resizing && inBody) {
    // Placing the caret must not move the note; still reflect the selection.
    if (event.shiftKey || event.ctrlKey || event.metaKey) selectNode(nodeId, true)
    else if (!state.selectedNodeIds.has(nodeId)) selectNode(nodeId, false)
    return
  }
  event.preventDefault()
  if (state.noteEditingId !== null && state.noteEditingId !== nodeId && document.activeElement instanceof HTMLElement) document.activeElement.blur()
  selectNode(nodeId, event.shiftKey || event.ctrlKey || event.metaKey)
  const origin = { x: event.clientX, y: event.clientY, node: { x: Number(node.x) || 0, y: Number(node.y) || 0, width: Number(node.width) || MIN_NODE_WIDTH, height: Number(node.height) || MIN_NODE_HEIGHT } }
  const latest = { ...origin.node }
  let frame = 0
  let stopped = false
  let moved = false
  state.dragging = true
  const apply = () => {
    frame = 0
    node.x = clampNodeCoordinate(latest.x)
    node.y = clampNodeCoordinate(latest.y)
    node.width = clampNodeDimension(latest.width, MIN_NODE_WIDTH)
    node.height = clampNodeDimension(latest.height, MIN_NODE_HEIGHT)
    element.style.left = `${Math.round(node.x)}px`
    element.style.top = `${Math.round(node.y)}px`
    element.style.width = `${Math.round(node.width)}px`
    element.style.height = `${Math.round(node.height)}px`
  }
  const move = moveEvent => {
    const dx = (moveEvent.clientX - origin.x) / state.zoom
    const dy = (moveEvent.clientY - origin.y) / state.zoom
    if (!moved && Math.hypot(dx, dy) < 1) return
    moved = true
    if (resizing) {
      latest.width = origin.node.width + dx
      latest.height = origin.node.height + dy
    } else {
      latest.x = origin.node.x + dx
      latest.y = origin.node.y + dy
    }
    if (frame === 0) frame = window.requestAnimationFrame(apply)
  }
  const stop = () => {
    if (stopped) return
    stopped = true
    document.removeEventListener('pointermove', move)
    document.removeEventListener('pointerup', stop)
    document.removeEventListener('pointercancel', stop)
    if (frame !== 0) { window.cancelAnimationFrame(frame); frame = 0 }
    apply()
    state.dragging = false
    deferCanvasRefresh(120)
    if (!moved || nodeId.startsWith('tmp:')) return
    const patch = resizing ? { width: Math.round(node.width), height: Math.round(node.height) } : { x: Math.round(node.x), y: Math.round(node.y) }
    void patchHostNode(nodeId, patch).catch(error => setError(`节点保存失败：${error instanceof Error ? error.message : 'Host 未响应'}`))
  }
  document.addEventListener('pointermove', move)
  document.addEventListener('pointerup', stop)
  document.addEventListener('pointercancel', stop)
})

// Editing lifecycle: focusin records the node that owns the caret, focusout
// commits the text (the contenteditable subtree is preserved by morphKeepsChildren).
app.addEventListener('focusin', event => {
  const target = event.target
  if (!(target instanceof Element)) return
  const body = target.closest('.canvas-note-body')
  const element = body === null ? null : body.closest('[data-node-id]')
  if (body instanceof HTMLElement && element instanceof HTMLElement && typeof element.dataset.nodeId === 'string') state.noteEditingId = element.dataset.nodeId
})
app.addEventListener('focusout', event => {
  const target = event.target
  if (!(target instanceof HTMLElement) || !target.classList.contains('canvas-note-body')) return
  const element = target.closest('[data-node-id]')
  const nodeId = element instanceof HTMLElement ? element.dataset.nodeId : undefined
  if (typeof nodeId === 'string') commitNoteText(nodeId, target)
  if (state.noteEditingId === nodeId) state.noteEditingId = null
})

// Shortcuts live on `document`: a canvas click leaves focus on body, so the
// event never reaches `#app`. The inspector's Escape handler runs first and sets
// defaultPrevented, which this listener honours.
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || state.mode !== 'canvas') return
  if (state.noteEditingId !== null) {
    if (event.key !== 'Escape') return
    event.preventDefault()
    const body = document.querySelector(`[data-node-id="${CSS.escape(state.noteEditingId)}"] .canvas-note-body`)
    if (body instanceof HTMLElement) body.blur()
    return
  }
  const target = event.target
  if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) return
  if (event.key === 'Escape') {
    if (cancelCanvasDraw !== null) {
      event.preventDefault()
      cancelCanvasDraw()
      return
    }
    if (state.canvasTool === 'pan' && state.selectedNodeIds.size === 0 && state.selectedCardKeys.size === 0 && state.selectedCardId === null) return
    event.preventDefault()
    state.canvasTool = 'pan'
    clearCanvasSelection()
    render()
    return
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    if (state.selectedNodeIds.size === 0) return
    event.preventDefault()
    const nodeIds = [...state.selectedNodeIds]
    state.selectedNodeIds.clear()
    for (const nodeId of nodeIds) void deleteCanvasNode(nodeId)
    return
  }
  if ((event.key === 'g' || event.key === 'G') && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault()
    void groupSelection()
    return
  }
  if ((event.key === 'n' || event.key === 'N') && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault()
    state.canvasTool = 'note'
    render()
  }
})

document.addEventListener('paste', event => { void handleCanvasPaste(event) })

app.addEventListener('dragover', event => {
  if (state.mode !== 'canvas' || event.dataTransfer === null) return
  if (!Array.from(event.dataTransfer.types).includes('Files')) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'copy'
})

app.addEventListener('drop', event => {
  if (state.mode !== 'canvas' || event.dataTransfer === null) return
  const files = Array.from(event.dataTransfer.files ?? []).filter(file => isImageMediaType(file.type))
  const viewport = canvasViewportElement()
  if (files.length === 0 || viewport === null) return
  event.preventDefault()
  void addImageFiles(files, worldFromClient(viewport, event.clientX, event.clientY))
})

app.addEventListener('change', event => {
  const quickPhrase = event.target instanceof Element ? event.target.closest('[data-quick-phrase-index]') : null
  if (quickPhrase instanceof HTMLInputElement) {
    updateQuickPhrase(Number(quickPhrase.dataset.quickPhraseIndex), quickPhrase.value)
    return
  }
  const select = event.target.closest('[data-action="select-workspace"]')
  if (!(select instanceof HTMLSelectElement)) return
  const choice = workspaceChoices().find(item => item.id === select.value)
  state.inspectorCardId = null
  state.inspectorOpening = false
  if (choice?.source === 'dsh') {
    // Map → native sync: switching workspaces moves DSH's current session to
    // the workspace's most recently updated session, keeping both sides in step.
    void openDshWorkspace(choice.id, { userInitiated: true }).then(opened => {
      if (!opened) return
      const threads = state.workspace?.threads ?? []
      const latest = threads
        .filter(thread => thread.dshSessionId !== null)
        .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))[0]
      const sessionId = latest?.dshSessionId ?? choice.sessionIds[0]
      if (sessionId !== undefined) post('synapse:activate-session', { sessionId })
    }).catch(setError)
  } else if (choice !== undefined) { state.selectedDshWorkspaceId = null; void openWorkspace(choice.id).catch(setError) }
})
app.addEventListener('input', event => { const input = event.target; if (input instanceof HTMLTextAreaElement && input.closest('[data-draft]') && state.draft !== null) state.draft.text = input.value })
app.addEventListener('submit', event => {
  const form = event.target
  if (!(form instanceof HTMLFormElement)) return
  if (form.matches('[data-draft]')) { event.preventDefault(); void submitDraft(); return }
  const thread = state.workspace?.threads.find(item => item.id === form.dataset.compose)
  const input = form.querySelector('textarea')
  if (thread === undefined || !(input instanceof HTMLTextAreaElement) || input.value.trim() === '') return
  event.preventDefault()
  const text = input.value.trim()
  input.value = ''
  void sendMessage(thread, text).catch(setError)
})

window.addEventListener('message', event => {
  if (event.origin !== window.location.origin || event.data?.source !== 'dsh-synapse') return
  const data = event.data
  if (data.type === 'synapse:map-opened') {
    // Do NOT reset the camera here: toggling dialog<->map for the same
    // session must keep the user's viewport. A fresh canvas (canvasView
    // not initialized) still centers via renderCanvas; a real session switch
    // re-centers in the current-session handler below.
    state.mode = 'canvas'
    render()
    window.requestAnimationFrame(() => post('synapse:map-ready'))
  }
  if (data.type === 'synapse:theme') {
    document.documentElement.dataset.theme = data.dark === true ? 'dark' : 'light'
  }
  if (data.type === 'synapse:workspaces') {
    const nextWorkspaces = Array.isArray(data.workspaces) ? data.workspaces.filter(workspace => typeof workspace?.id === 'string' && typeof workspace.title === 'string' && Array.isArray(workspace.sessionIds)) : []
    // DSH owns the archive set; mirror it so an archived session stops drawing
    // cards here too (issue #21 / #19).
    const nextArchived = new Set(Array.isArray(data.archivedSessionIds) ? data.archivedSessionIds.filter(id => typeof id === 'string') : [])
    // The parent re-sends this on every session-list change, i.e. on every
    // streamed chunk. Acting on an unchanged payload re-ran a whole workspace
    // load and rebuilt the canvas several times a second, which is what made
    // clicking feel unresponsive and switching workspaces feel stalled.
    const signature = JSON.stringify([nextWorkspaces, [...nextArchived].sort()])
    if (signature === state.workspacesSignature) return
    state.workspacesSignature = signature
    state.dshWorkspaces = nextWorkspaces
    state.archivedSessionIds = nextArchived
    const current = currentDshWorkspace()
    if (current !== undefined && current.id !== state.selectedDshWorkspaceId) void openDshWorkspace(current.id).catch(setError)
    else if (state.selectedDshWorkspaceId !== null) void openDshWorkspace(state.selectedDshWorkspaceId).catch(setError)
    else if (canReplaceView()) render()
  }
  if (data.type === 'synapse:current-session') {
    const previousId = state.currentDsh?.id
    const previousSignature = sessionSignature(state.currentDsh)
    state.currentDsh = data.session
    const nextSignature = sessionSignature(data.session)
    const preserveCanvasCamera = previousId !== data.session?.id && state.mapCardSessionSwitches.delete(data.session?.id)
    const thread = currentDshThread()
    if (thread !== undefined) {
      const preserveSelectedCard = state.activeId === thread.id
      state.activeId = thread.id
      if (!preserveSelectedCard) {
        state.selectedCardId = null
        state.inspectorCardId = null
        state.inspectorOpening = false
      }
      if (state.workspace !== null) revealConversationThread(conversationCards(state.workspace.threads), thread.id)
      revealFramesForThread(thread.id)
    }
    if (previousId !== data.session?.id) {
      // A real session switch: re-center on the new session's latest turn,
      // whether it lives in the same workspace (openCurrentWorkspace returns
      // false) or a different one (it resets the camera itself).
      void openCurrentWorkspace({ preserveCanvasCamera }).then(opened => {
        if (!opened && canReplaceView()) {
          render()
          if (!preserveCanvasCamera) focusActiveCard()
        }
      }).catch(setError)
    }
    // Only the fields the canvas draws matter here: the parent re-sends this
    // message for every streamed chunk, and re-rendering on each one queued a
    // full rebuild behind every click.
    else if (previousSignature !== nextSignature && canReplaceView()) render()
  }
  if (data.type === 'synapse:live-reply' && typeof data.sessionId === 'string') {
    const thread = state.workspace?.threads.find(item => item.dshSessionId === data.sessionId)
    if (thread !== undefined) {
      if (data.running === true) {
        state.liveReplies.set(data.sessionId, { running: true, text: typeof data.text === 'string' ? data.text : '' })
        // Streaming: patch the live card's answer in place instead of
        // rebuilding the whole canvas on every chunk; a full render reconciles
        // at stream end. The detail view is single-thread, so keep its cheap
        // throttled full render.
        if (state.mode === 'canvas') scheduleLiveCardUpdate(data.sessionId)
        else if (canReplaceView()) scheduleLiveRender()
      } else {
        state.liveReplies.delete(data.sessionId)
        if (canReplaceView() || state.pendingReplies.has(data.sessionId)) renderPreservingDetailScroll()
      }
    }
  }
  if (data.type === 'synapse:forked-session' || data.type === 'synapse:created-session' || data.type === 'synapse:message-sent') settleRpc(data.requestId, data.session ?? data)
  if (data.type === 'synapse:archived-session') settleRpc(data.requestId, data)
  if (data.type === 'synapse:bridge-error') { settleRpc(data.requestId, undefined, new Error(data.message)); if (data.requestId === undefined) setError(data.message) }
})

post('synapse:request-current')
refreshSummaries().catch(setError)
let polling = false
let liveRenderTimer = 0
let liveCardFrame = 0
let liveCardSessionId = null
function scheduleLiveCardUpdate(sessionId) {
  // Coalesce streaming chunks to one DOM patch per animation frame.
  liveCardSessionId = sessionId
  if (liveCardFrame !== 0) return
  liveCardFrame = window.requestAnimationFrame(() => {
    liveCardFrame = 0
    if (liveCardSessionId === null) return
    const id = liveCardSessionId
    liveCardSessionId = null
    applyLiveReplyToCard(id)
  })
}
function applyLiveReplyToCard(sessionId) {
  if (state.mode !== 'canvas') return
  // Never patch cards mid-gesture: the reflow would compete with the drag or
  // pan frame; the next live-reply chunk re-applies after the gesture ends.
  if (state.dragging || state.canvasGesture) return
  const thread = state.workspace?.threads.find(item => item.dshSessionId === sessionId)
  if (thread === undefined) return
  const live = state.liveReplies.get(sessionId)
  if (live?.running !== true) return
  const cards = app.querySelectorAll(`.thread-card[data-thread="${CSS.escape(thread.id)}"]`)
  const card = cards[cards.length - 1]
  if (!(card instanceof HTMLElement)) return
  const answer = card.querySelector('.thread-answer')
  if (!(answer instanceof HTMLElement)) return
  const text = live.text
  // Morph instead of replacing the subtree: the answer keeps its nodes, so a
  // pointer that went down inside it still resolves to a click on release.
  morphInto(answer, text.trim() === ''
    ? '<p class="thread-answer-pending">正在回复</p>'
    : `${renderMarkdown(text)}<p class="thread-answer-pending">正在回复</p>`)
}
function scheduleLiveRender() {
  if (liveRenderTimer !== 0 || !canReplaceView()) return
  liveRenderTimer = window.setTimeout(() => {
    liveRenderTimer = 0
    if (canReplaceView()) renderPreservingDetailScroll()
  }, 120)
}
async function pollProjection() {
  if (polling || document.hidden || !canReplaceView()) return
  polling = true
  try {
    await refreshProjection()
  } finally { polling = false }
}
window.setInterval(() => { void pollProjection() }, 1_000)
