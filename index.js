import { copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

export const name = 'synapse'
export const inject = ['webServer', 'sessions']

const MAX_BODY_BYTES = 32 * 1024
const MAX_TITLE_LENGTH = 120
const MAX_NOTE_LENGTH = 4_000
// Canvas primitives (schema v6) are written one node at a time, so a note, a
// shape or a frame never approaches the JSON cap above. Images are the one
// payload that cannot travel as JSON: the bytes live in the DSH attachment
// store and the node keeps only an immutable `sha256:` reference (~120 B), so
// workspaces.json stays small (issue #42). The upload route therefore reads the
// raw request body under its own, much larger, ceiling.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MIN_NODE_WIDTH = 80
const MIN_NODE_HEIGHT = 60
const MAX_NODE_SIZE = 5_000
const MAX_FRAME_MEMBERS = 500
const MAX_CARD_POSITIONS = 1_000
// SVG is deliberately absent: an uploaded vector would be script-capable on the
// DSH origin every canvas image is served from.
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
// The DSH attachment store's opaque, content-addressed identity.
const ATTACHMENT_ID_PATTERN = /^sha256:[a-f0-9]{64}$/
// A canvas card is named by its position key, never by its card id: the id is
// ephemeral once DSH assigns a source sequence, the key is stable.
const POSITION_KEY_PATTERN = /^[0-9a-z-]{8,80}:turn-index:\d{1,6}$/i
const NODE_TYPES = new Set(['note', 'image', 'shape', 'frame'])
const SHAPE_KINDS = new Set(['rect', 'ellipse', 'line', 'arrow'])
// Assigning these as object keys would mutate the prototype of cardPositions.
const RESERVED_POSITION_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
// Projected message text cap: longer replies truncate with a marker pointing
// at the detail view instead of silently cutting mid-sentence.
// Projected messages keep only a short preview: the body already lives in the
// DSH session log, and a canvas full of copies is what made one workspace file
// grow to megabytes (issue #42). Bodies are streamed back on demand by
// `/synapse/api/threads/:id/full`.
const EXCERPT_CHARS = 280
// On-demand bodies are capped so a single enormous tool result cannot stall the
// browser while its card is rendered.
const MAX_BODY_CHARS = 200_000
const PROJECTION_TRUNCATED_SUFFIX = '\n——…（详情查看全文）'
const BODY_TRUNCATED_SUFFIX = '\n——…（正文过长，其余请在 DSH 中查看）'
const TOPIC_COLORS = ['#0f766e', '#2563eb', '#be123c', '#7c3aed', '#b45309']
// The harness writes `user/message` rows of its own (runtime snapshots, skill
// catalogues). A canvas card must stand for a turn a person actually typed, so
// an injected row is recognised by its structured `source.kind` instead of by
// guessing at the prose (issue #31 / #23).
const INJECTED_USER_SOURCE_KINDS = new Set(['skill-catalog'])
// Stored projections keep no raw event to re-read, so the one-time cleanup
// recognises a legacy catalogue card by the markers only that injection emits:
// the `<system-reminder>` opener plus the `<available_skills>` index it wraps.
const SKILL_CATALOG_OPENER = '<system-reminder>'
const SKILL_CATALOG_MARKER = '<available_skills>'
const LOCK_STALE_MS = 60_000
// Deferred (event-projection) writes coalesce into one save per window, so a
// burst of session events costs a single full-state write instead of one per
// event (issue #13: per-event saves pinned the main thread at ~90% CPU).
const SAVE_DEBOUNCE_MS = 800

/** JSON persistence for the Synapse workspace graph. */
export class WorkspaceStore {
  constructor(dataFile) {
    if (typeof dataFile !== 'string' || dataFile.length === 0) throw new Error('synapse: config.dataFile must be a non-empty path')
    this.dataFile = dataFile
    this.state = undefined
    this.serial = Promise.resolve()
    this.ready = this.load()
    this.lastKnownMtime = null
    this.externalModWarned = false
    this.lockWarned = false
    this.dirty = false
    this.flushTimer = null
    this.writeTicket = 0
  }

  async list() {
    await this.ready
    return this.state.workspaces.map(workspace => this.summary(workspace))
  }

  async get(workspaceId) {
    await this.ready
    const workspace = this.workspace(workspaceId)
    return structuredClone(workspace)
  }

  /** Whether a workspace exists, without cloning it: uploads validate cheaply. */
  async hasWorkspace(workspaceId) {
    await this.ready
    return this.state.workspaces.some(workspace => workspace.id === workspaceId)
  }

  /**
   * Read-only lookup used by on-demand body loading: returns the live thread
   * (no clone) together with its workspace, or null when the id is unknown.
   */
  async locateThread(threadId) {
    await this.ready
    for (const workspace of this.state.workspaces) {
      for (const thread of workspace.threads ?? []) {
        if (thread.id === threadId) return { workspace, thread }
      }
    }
    return null
  }

  async create(title) {
    return this.mutate(() => {
      const now = new Date().toISOString()
      const workspace = { id: randomUUID(), title: requiredText(title, MAX_TITLE_LENGTH, 'title'), createdAt: now, updatedAt: now, threads: [], nodes: [], cardPositions: {} }
      this.state.workspaces.unshift(workspace)
      return this.summary(workspace)
    })
  }

  async createThread(workspaceId, input) {
    return this.mutate(() => {
      const workspace = this.workspace(workspaceId)
      const now = new Date().toISOString()
      const thread = this.thread({
        title: input?.title,
        parentId: input?.parentId,
        dshSessionId: input?.dshSessionId,
        dshSessionTitle: input?.dshSessionTitle,
        position: input?.position,
        color: input?.color,
        now,
        order: workspace.threads.length,
      })
      if (thread.parentId !== null && !workspace.threads.some(item => item.id === thread.parentId)) throw new InputError('分支来源不存在')
      workspace.threads.push(thread)
      workspace.updatedAt = now
      return structuredClone(thread)
    })
  }

  async branch(threadId, input) {
    return this.mutate(() => {
      const { workspace, thread: parent } = this.locateThread(threadId)
      const now = new Date().toISOString()
      const sessionId = typeof input?.dshSessionId === 'string' && input.dshSessionId.length > 0 ? input.dshSessionId : null
      // A DSH fork emits session/created while the browser receives its fork
      // response. Either path may win the race, but both must resolve to one node.
      if (sessionId !== null) {
        const existing = workspace.threads.find(item => item.dshSessionId === sessionId)
        if (existing !== undefined) {
          existing.parentId ??= parent.id
          if (typeof input?.title === 'string' && input.title.trim() !== '') existing.title = requiredText(input.title, MAX_TITLE_LENGTH, 'title')
          if (typeof input?.dshSessionTitle === 'string') existing.dshSessionTitle = input.dshSessionTitle.slice(0, MAX_TITLE_LENGTH)
          existing.updatedAt = now
          workspace.updatedAt = now
          return structuredClone(existing)
        }
      }
      const siblings = workspace.threads.filter(item => item.parentId === parent.id)
      const thread = this.thread({
        title: input?.title,
        parentId: parent.id,
        dshSessionId: input?.dshSessionId,
        dshSessionTitle: input?.dshSessionTitle,
        position: input?.position ?? { x: parent.position.x + 420, y: parent.position.y + siblings.length * 248 },
        color: input?.color ?? parent.color,
        now,
        order: workspace.threads.length,
      })
      workspace.threads.push(thread)
      workspace.updatedAt = now
      return structuredClone(thread)
    })
  }

  /** Keep only the canvas graph in Synapse; DSH remains the source of session truth. */
  async syncSessions(sessions, removedSessionIds = []) {
    return this.mutate(() => {
      if (!Array.isArray(sessions)) throw new InputError('sessions 必须是数组')
      if (!Array.isArray(removedSessionIds) || removedSessionIds.some(item => typeof item !== 'string')) throw new InputError('removedSessionIds 必须是字符串数组')
      const blankIds = new Set(sessions.filter(item => item?.blank === true && typeof item.id === 'string').map(item => item.id))
      const removedIds = new Set(removedSessionIds)
      for (const workspace of this.state.workspaces) {
        if (workspace.kind !== 'dsh') continue
        const removedThreadIds = new Set(workspace.threads
          .filter(thread => blankIds.has(thread.dshSessionId) || removedIds.has(thread.dshSessionId))
          .map(thread => thread.id))
        workspace.threads = workspace.threads.filter(thread => !removedThreadIds.has(thread.id))
        pruneFrameCards(workspace, removedThreadIds)
      }
      this.state.workspaces = this.state.workspaces.filter(workspace => workspace.kind !== 'dsh' || workspace.threads.length > 0 || (workspace.nodes ?? []).length > 0)
      for (const item of sessions) {
        if (typeof item?.id !== 'string' || item.id === '' || typeof item.cwd !== 'string' || item.cwd === '') continue
        if (item.blank === true) continue
        // Canvas archiving is persistent UI state. A normal DSH list refresh
        // must not recreate a session that the user deliberately archived.
        if (this.state.hiddenSessionIds.includes(item.id)) continue
        const workspace = this.dshWorkspace(item.cwd, 'DSH 任务')
        const session = { id: item.id, header: { meta: { cwd: item.cwd }, parentSession: typeof item.parentId === 'string' ? item.parentId : undefined }, title: typeof item.title === 'string' ? item.title : undefined, events: [] }
        const thread = this.dshThread(workspace, session)
        if (typeof item.title === 'string' && item.title.trim() !== '') {
          thread.title = item.title.slice(0, MAX_TITLE_LENGTH)
          thread.dshSessionTitle = thread.title
        }
      }
      return this.list()
    }, { deferred: true })
  }

  async addMessage(threadId, text) {
    return this.mutate(() => {
      const { workspace, thread } = this.locateThread(threadId)
      const at = new Date().toISOString()
      const message = { id: randomUUID(), text: requiredText(text, MAX_NOTE_LENGTH, 'text'), kind: 'user', at }
      thread.messages.push(message)
      thread.updatedAt = at
      workspace.updatedAt = at
      return structuredClone(thread)
    })
  }

  async updateThread(threadId, input) {
    return this.mutate(() => {
      const { workspace, thread } = this.locateThread(threadId)
      if (input?.title !== undefined) thread.title = requiredText(input.title, MAX_TITLE_LENGTH, 'title')
      if (input?.position !== undefined) thread.position = positionOf(input.position)
      thread.updatedAt = new Date().toISOString()
      workspace.updatedAt = thread.updatedAt
      return structuredClone(thread)
    })
  }

  async removeThread(threadId) {
    return this.mutate(() => {
      const { workspace, thread } = this.locateThread(threadId)
      const removal = new Set([thread.id])
      for (let changed = true; changed;) {
        changed = false
        for (const item of workspace.threads) {
          if (item.parentId !== null && removal.has(item.parentId) && !removal.has(item.id)) { removal.add(item.id); changed = true }
        }
      }
      for (const item of workspace.threads) {
        if (removal.has(item.id) && item.dshSessionId !== null && !this.state.hiddenSessionIds.includes(item.dshSessionId)) this.state.hiddenSessionIds.push(item.dshSessionId)
      }
      workspace.threads = workspace.threads.filter(item => !removal.has(item.id))
      pruneFrameCards(workspace, removal)
      workspace.updatedAt = new Date().toISOString()
      if (workspace.threads.length === 0 && (workspace.nodes ?? []).length === 0) this.state.workspaces = this.state.workspaces.filter(item => item.id !== workspace.id)
      return { removed: removal.size }
    })
  }

  /**
   * Create one canvas primitive (note, image, shape or frame) beside the
   * conversation graph. Nodes are written one at a time so a canvas with many
   * annotations still costs one small JSON write per edit instead of a
   * whole-canvas save. Image bytes never reach this method: the node carries the
   * DSH attachment store's immutable reference and nothing else.
   */
  async createNode(workspaceId, input) {
    return this.mutate(() => {
      const workspace = this.workspace(workspaceId)
      const now = new Date().toISOString()
      const node = nodeOf(input, workspace, now)
      workspace.nodes ??= []
      workspace.nodes.push(node)
      if (node.type === 'frame') applyFrameMembers(workspace, node)
      workspace.updatedAt = now
      return structuredClone(node)
    })
  }

  /** Patch one node in place; only the fields the caller sent are validated. */
  async updateNode(nodeId, input) {
    return this.mutate(() => {
      const { workspace, node } = this.locateNode(nodeId)
      applyNodePatch(node, input, workspace)
      workspace.updatedAt = node.updatedAt
      return structuredClone(node)
    })
  }

  /**
   * Remove one node. A frame releases its threads first — otherwise a deleted
   * group would leave every card pointing at a frame that no longer exists.
   */
  async removeNode(nodeId) {
    return this.mutate(() => {
      const { workspace, node } = this.locateNode(nodeId)
      if (node.type === 'frame') {
        for (const key of node.memberCards ?? []) {
          const threadId = positionKeyThreadId(key)
          const thread = threadId === null ? undefined : workspace.threads.find(item => item.id === threadId)
          if (thread !== undefined && thread.frameId === node.id) thread.frameId = null
        }
      }
      for (const frame of workspace.nodes ?? []) {
        if (frame === node || frame.type !== 'frame' || !Array.isArray(frame.memberNodes)) continue
        frame.memberNodes = frame.memberNodes.filter(item => item !== node.id)
      }
      workspace.nodes = (workspace.nodes ?? []).filter(item => item.id !== node.id)
      workspace.updatedAt = new Date().toISOString()
      return { removed: 1 }
    })
  }

  /** Merge the card positions the browser dragged; keys are position keys. */
  async mergeCardPositions(workspaceId, positions) {
    return this.mutate(() => {
      const workspace = this.workspace(workspaceId)
      if (positions !== undefined && positions !== null) {
        if (typeof positions !== 'object' || Array.isArray(positions)) throw new InputError('cardPositions 必须是对象')
        const entries = Object.entries(positions)
        if (entries.length > MAX_CARD_POSITIONS) throw new InputError('cardPositions 数量过多')
        workspace.cardPositions ??= {}
        for (const [key, value] of entries) workspace.cardPositions[positionKeyOf(key, false)] = positionOf(value)
      }
      workspace.updatedAt = new Date().toISOString()
      return structuredClone(workspace)
    })
  }

  /**
   * The durable reference of an image some node in this canvas still uses.
   * Serving only referenced attachments keeps the asset route from becoming a
   * reader for every image in the harness home.
   */
  async findImageRef(attachmentId) {
    await this.ready
    if (typeof attachmentId !== 'string' || !ATTACHMENT_ID_PATTERN.test(attachmentId)) return null
    for (const workspace of this.state.workspaces) {
      for (const node of workspace.nodes ?? []) {
        if (node.type === 'image' && node.image?.attachmentId === attachmentId) return { ...node.image }
      }
    }
    return null
  }

  async clearLegacy(sessions) {
    return this.mutate(() => {
      const hidden = new Set(this.state.hiddenSessionIds)
      for (const workspace of this.state.workspaces) for (const thread of workspace.threads) if (thread.dshSessionId !== null) hidden.add(thread.dshSessionId)
      for (const session of sessions) hidden.add(session.id)
      this.state.hiddenSessionIds = [...hidden]
      this.state.workspaces = []
      return { cleared: true }
    })
  }

  /** Replay one live DSH session into the dedicated projection workspace. */
  async projectSession(session, replayFrom = 0, workspaceTitle = 'DSH 任务') {
    return this.mutate(() => {
      if (this.state.hiddenSessionIds.includes(session.id)) return null
      const workspace = this.dshWorkspace(sessionCwd(session), workspaceTitle)
      const thread = this.dshThread(workspace, session)
      // `snapshotEvents()` replaces the removed `session.events` getter. It is
      // marked deprecated because DSH is moving complete logs out of memory, but
      // rebuilding this canvas from history needs the full sequence and the
      // reader is the only complete-log access a plugin still has.
      for (const event of session.snapshotEvents()) {
        if (event.seq >= replayFrom) this.projectEventInto(workspace, thread, event)
      }
      return structuredClone(thread)
    }, { deferred: true })
  }

  /** Project one committed DSH session event. Repeated sequence numbers are ignored. */
  async projectEvent(session, event, workspaceTitle = 'DSH 任务') {
    return this.mutate(() => {
      if (this.state.hiddenSessionIds.includes(session.id)) return null
      const workspace = this.dshWorkspace(sessionCwd(session), workspaceTitle)
      const thread = this.dshThread(workspace, session)
      this.projectEventInto(workspace, thread, event)
      return structuredClone(thread)
    }, { deferred: true })
  }

  /** Project a batch of committed events for one session in a single write. */
  async projectEvents(session, events, workspaceTitle = 'DSH 任务') {
    if (events.length === 0) return null
    return this.mutate(() => {
      if (this.state.hiddenSessionIds.includes(session.id)) return null
      const workspace = this.dshWorkspace(sessionCwd(session), workspaceTitle)
      const thread = this.dshThread(workspace, session)
      for (const event of events) this.projectEventInto(workspace, thread, event)
      return structuredClone(thread)
    }, { deferred: true })
  }

  async load() {
    await mkdir(dirname(this.dataFile), { recursive: true })
    try {
      const parsed = JSON.parse(await readFile(this.dataFile, 'utf8'))
      const { state, migrated } = normalizeState(parsed)
      this.state = state
      if (migrated) {
        // Dropping stored bodies is the one migration that cannot be undone by
        // re-projection alone, so keep the pre-v5 file next to the new one.
        if (Number(parsed?.version) < 5) await copyFile(this.dataFile, `${this.dataFile}.v4-backup`).catch(() => {})
        await this.save()
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // Never "repair" this file. An unreadable workspaces.json is the only
        // copy of the canvas; restoring a backup over it (which an earlier
        // revision did) both discarded whatever the file still held and silently
        // rolled the map back to a snapshot of unknown age. Fail instead: the
        // store stays unloaded, `ready` rejects, every mutation refuses to run,
        // and the HTTP layer reports this exact message so the user learns which
        // file to repair.
        throw new Error(`synapse: cannot read ${this.dataFile}: ${error.message}`)
      }
      this.state = { version: 6, hiddenSessionIds: [], workspaces: [] }
      await this.save()
    }
  }

  async mutate(action, { deferred = false } = {}) {
    await this.ready
    const task = this.serial.then(async () => {
      const result = action()
      if (deferred) this.markDirty()
      else await this.save()
      return result
    })
    this.serial = task.catch(() => undefined)
    return task
  }

  /** Mark the state dirty and schedule one trailing flush for the window. */
  markDirty() {
    this.dirty = true
    if (this.flushTimer !== null) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, SAVE_DEBOUNCE_MS)
  }

  /** Persist the current state when dirty, ordered after in-flight mutations. */
  flush() {
    if (!this.dirty) return Promise.resolve()
    this.dirty = false
    const task = this.serial.then(() => this.save())
    this.serial = task.catch(() => undefined)
    return task
  }

  async save() {
    // Two dsh web instances sharing one profile clobber each other's canvas
    // state. Warn loudly instead of silently losing work; a live lock held by
    // another process or a file mtime that moved since our last write both
    // indicate a second writer.
    const before = await this.fileMtime()
    if (this.lastKnownMtime !== null && before !== null && before !== this.lastKnownMtime) {
      this.lastKnownMtime = before
      if (!this.externalModWarned) {
        this.externalModWarned = true
        process.stderr.write('synapse: workspaces.json 已被另一个 dsh web 实例修改，本实例的写入可能覆盖其更改——请只运行一个实例\n')
      }
    }
    await this.acquireLock()
    try {
      // The ticket keeps two writes inside ONE process (a v6 migration on load
      // racing the first mutation, or two stores over one file in a test) from
      // sharing a temp path: `rename` would then find the file already moved and
      // fail with EPERM/ENOENT. The pid alone was not unique enough.
      const temporaryFile = `${this.dataFile}.${process.pid}.${++this.writeTicket}.tmp`
      await writeFile(temporaryFile, `${JSON.stringify(this.state)}\n`, 'utf8')
      await renameWithRetry(temporaryFile, this.dataFile)
      this.lastKnownMtime = (await stat(this.dataFile)).mtimeMs
    } finally {
      await this.releaseLock()
    }
  }

  async fileMtime() {
    try { return (await stat(this.dataFile)).mtimeMs } catch { return null }
  }

  /** Take an exclusive cross-process lock, breaking a stale one; warn when a live process holds it. */
  async acquireLock() {
    const lockFile = `${this.dataFile}.lock`
    if (await this.tryAcquire(lockFile)) return
    if (await this.lockIsStale(lockFile)) {
      await unlink(lockFile).catch(() => {})
      if (await this.tryAcquire(lockFile)) return
    }
    if (!this.lockWarned) {
      this.lockWarned = true
      process.stderr.write('synapse: 另一个 dsh web 实例正在写入 workspaces.json——请只运行一个实例，否则画布数据可能互相覆盖\n')
    }
  }

  async tryAcquire(lockFile) {
    try {
      await writeFile(lockFile, `${process.pid}\n`, { flag: 'wx' })
      return true
    } catch {
      return false
    }
  }

  /** A lock is stale when its owner PID is gone or the lock file is older than the stale window. */
  async lockIsStale(lockFile) {
    try {
      const [content, stats] = await Promise.all([readFile(lockFile, 'utf8'), stat(lockFile)])
      const tooOld = Date.now() - stats.mtimeMs > LOCK_STALE_MS
      const pid = Number.parseInt(content, 10)
      if (!Number.isInteger(pid)) return tooOld
      if (pid === process.pid) return false
      try {
        process.kill(pid, 0)
        return tooOld
      } catch {
        return true
      }
    } catch {
      return false
    }
  }

  async releaseLock() {
    await unlink(`${this.dataFile}.lock`).catch(() => {})
  }

  workspace(workspaceId) {
    const workspace = this.state.workspaces.find(item => item.id === workspaceId)
    if (workspace === undefined) throw new NotFoundError('工作空间不存在')
    return workspace
  }

  locateThread(threadId) {
    for (const workspace of this.state.workspaces) {
      const thread = workspace.threads.find(item => item.id === threadId)
      if (thread !== undefined) return { workspace, thread }
    }
    throw new NotFoundError('节点不存在')
  }

  locateNode(nodeId) {
    for (const workspace of this.state.workspaces) {
      const node = (workspace.nodes ?? []).find(item => item.id === nodeId)
      if (node !== undefined) return { workspace, node }
    }
    throw new NotFoundError('画布元素不存在')
  }

  dshWorkspace(cwd, fallbackTitle) {
    let workspace = this.state.workspaces.find(item => item.kind === 'dsh' && item.cwd === cwd)
    if (workspace !== undefined) return workspace
    const now = new Date().toISOString()
    workspace = { id: randomUUID(), kind: 'dsh', cwd, title: workspaceTitle(cwd, fallbackTitle), createdAt: now, updatedAt: now, threads: [], nodes: [], cardPositions: {} }
    this.state.workspaces.unshift(workspace)
    return workspace
  }

  dshThread(workspace, session) {
    let thread = workspace.threads.find(item => item.dshSessionId === session.id)
    if (thread !== undefined) {
      if (typeof session.title === 'string' && session.title.trim() !== '') {
        const title = session.title.slice(0, MAX_TITLE_LENGTH)
        thread.title = title
        thread.dshSessionTitle = title
      }
      // `inheritedEventCount` is DSH's durable fork cut, the successor of the
      // removed `header.seedLength`. It survives restore, unlike `firstLiveSeq`.
      const seedLength = session.inheritedEventCount
      if (Number.isSafeInteger(seedLength) && seedLength >= 0) thread.sourceSeedLength = seedLength
      return thread
    }
    const parentSessionId = typeof session.header?.parentSession === 'string' ? session.header.parentSession : null
    const parent = parentSessionId === null ? undefined : workspace.threads.find(item => item.dshSessionId === parentSessionId)
    const siblings = workspace.threads.filter(item => item.sourceParentSessionId === parentSessionId)
    const now = new Date().toISOString()
    thread = {
      id: randomUUID(),
      title: typeof session.title === 'string' && session.title.trim() !== '' ? session.title.slice(0, MAX_TITLE_LENGTH) : (parent === undefined ? 'DSH 会话' : `${parent.title} 分支`),
      parentId: parent?.id ?? null,
      sourceParentSessionId: parentSessionId,
      sourceSeedLength: Number.isSafeInteger(session.inheritedEventCount) && session.inheritedEventCount >= 0 ? session.inheritedEventCount : null,
      dshSessionId: session.id,
      dshSessionTitle: typeof session.title === 'string' ? session.title.slice(0, MAX_TITLE_LENGTH) : null,
      color: TOPIC_COLORS[workspace.threads.length % TOPIC_COLORS.length],
      // The group frame this thread's cards belong to, when the canvas put them
      // in one. Layout is a canvas concern; the projection never guesses it.
      frameId: null,
      // DSH projection stores only a neutral semantic anchor. The visual map
      // lays out visible cards from the current conversation graph each render,
      // so old/archived session counts must never leak into future coordinates.
      position: parent === undefined ? { x: 86, y: 82 } : { x: parent.position.x + 400, y: parent.position.y },
      createdAt: now,
      updatedAt: now,
      messages: [],
      pendingProcess: [],
    }
    workspace.threads.push(thread)
    // A child may arrive before its parent during startup replay. Repair that
    // relation when the missing parent later reaches the projection.
    for (const child of workspace.threads) {
      if (child.sourceParentSessionId === session.id && child.parentId === null) child.parentId = thread.id
    }
    workspace.updatedAt = now
    return thread
  }

  projectEventInto(workspace, thread, event) {
    if (event.type === 'session/title' && typeof event.data?.title === 'string') {
      thread.title = event.data.title.slice(0, MAX_TITLE_LENGTH)
      thread.dshSessionTitle = thread.title
      thread.updatedAt = new Date(event.time).toISOString()
      workspace.updatedAt = thread.updatedAt
      return
    }
    if (event.type === 'tool/call' || event.type === 'tool/result') {
      this.foldToolProcess(thread, event)
      workspace.updatedAt = thread.updatedAt
      return
    }
    const projection = projectableEvent(event)
    if (projection === null || thread.messages.some(message => message.sourceSeq === event.seq)) return
    const at = new Date(event.time).toISOString()
    const message = {
      id: randomUUID(),
      text: projection.text,
      length: projection.length,
      truncated: projection.truncated,
      kind: projection.kind,
      sourceSeq: event.seq,
      at,
      ...(projection.kind === 'assistant' || projection.kind === 'error'
        ? { turn: event.data?.turn, step: event.data?.step, process: [] }
        : {}),
    }
    this.attachPendingProcess(thread, message)
    thread.messages.push(message)
    thread.updatedAt = at
    workspace.updatedAt = at
    if (thread.dshSessionTitle === null && projection.kind === 'user') {
      thread.title = titleFromText(projection.text)
      thread.dshSessionTitle = thread.title
    }
  }

  /**
   * Fold one tool call or result into the assistant message of its own
   * turn/step, keyed by `callId`, so a tool invocation never becomes a
   * separate canvas card. If a tool result arrives before its associated
   * assistant/error message, retain it on the thread until that turn appears.
   */
  foldToolProcess(thread, event) {
    const at = new Date(event.time).toISOString()
    const data = event.data ?? {}
    const target = [...thread.messages].reverse().find(message =>
      (message.kind === 'assistant' || message.kind === 'error')
      && (message.turn === data.turn && message.step === data.step
        || message.turn === undefined && message.step === undefined))
    const process = target === undefined ? (thread.pendingProcess ??= []) : (target.process ??= [])
    const callId = String(event.type === 'tool/call' ? data.callId : data.message?.source?.callId ?? '')
    const entry = process.find(item => item.callId === callId)
    // Process records keep only identity and status: tool arguments and results
    // are the bulk of the old file (issue #42) and are reloaded on demand.
    if (event.type === 'tool/call') {
      if (entry === undefined) {
        process.push({ callId, turn: data.turn, step: data.step, name: data.name, status: 'pending' })
      } else {
        entry.name = data.name
      }
    } else {
      const failed = errorText(data.error) !== null
      if (entry === undefined) {
        process.push({ callId, turn: data.turn, step: data.step, name: '工具调用', status: failed ? 'failed' : 'done' })
      } else {
        entry.status = failed ? 'failed' : 'done'
        if (typeof entry.name !== 'string' || entry.name === '') entry.name = '工具调用'
      }
    }
    thread.updatedAt = at
  }

  attachPendingProcess(thread, message) {
    if (!Array.isArray(thread.pendingProcess) || thread.pendingProcess.length === 0 || !Array.isArray(message.process)) return
    const matching = thread.pendingProcess.filter(entry => entry.turn === message.turn && entry.step === message.step)
    if (matching.length === 0) return
    message.process.push(...matching.map(({ turn, step, ...entry }) => entry))
    thread.pendingProcess = thread.pendingProcess.filter(entry => entry.turn !== message.turn || entry.step !== message.step)
  }

  thread({ title, parentId, dshSessionId, dshSessionTitle, position, color, now, order }) {
    return {
      id: randomUUID(),
      title: requiredText(title, MAX_TITLE_LENGTH, 'title'),
      parentId: typeof parentId === 'string' && parentId.length > 0 ? parentId : null,
      dshSessionId: typeof dshSessionId === 'string' && dshSessionId.length > 0 ? dshSessionId : null,
      dshSessionTitle: typeof dshSessionTitle === 'string' ? dshSessionTitle.slice(0, MAX_TITLE_LENGTH) : null,
      color: TOPIC_COLORS.includes(color) ? color : TOPIC_COLORS[order % TOPIC_COLORS.length],
      frameId: null,
      position: positionOf(position ?? { x: 86 + (order % 3) * 410, y: 82 + Math.floor(order / 3) * 260 }),
      createdAt: now,
      updatedAt: now,
      messages: [],
      pendingProcess: [],
    }
  }

  summary(workspace) {
    return { id: workspace.id, kind: workspace.kind ?? 'manual', cwd: workspace.cwd ?? null, title: workspace.title, createdAt: workspace.createdAt, updatedAt: workspace.updatedAt, threadCount: workspace.threads.length }
  }
}

/**
 * Replace a file, tolerating the transient Windows refusals. An antivirus
 * scanner or another reader holding the destination open makes `rename` fail
 * with EPERM/EBUSY/EACCES for a few milliseconds; retrying beats losing the
 * write. A locked source (ENOENT after a competing move) is not retried — that
 * is a real bug, not a race with the OS.
 */
async function renameWithRetry(from, to, attempts = 4) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await rename(from, to)
    } catch (error) {
      const transient = error?.code === 'EPERM' || error?.code === 'EBUSY' || error?.code === 'EACCES'
      if (!transient || attempt >= attempts) throw error
      await new Promise(resolve => setTimeout(resolve, 10 * attempt))
    }
  }
}

class InputError extends Error {}
class NotFoundError extends Error {}
class PayloadTooLargeError extends Error {}
class UnsupportedMediaError extends Error {}
class UnavailableError extends Error {}

// The DSH attachment store raises a structurally-compatible `AttachmentError`
// carrying a stable code (never a prototype we can rely on across packages).
// Only the codes a canvas user can act on get their own status and wording.
const ATTACHMENT_FAILURES = new Map([
  ['IMAGE_TOO_LARGE', [413, '图片超过体积上限']],
  ['IMAGES_TOO_LARGE', [413, '图片超过体积上限']],
  ['IMAGE_TOO_MANY_PIXELS', [413, '图片像素过多']],
  ['IMAGE_DIMENSION_TOO_LARGE', [413, '图片边长过大']],
  ['TOO_MANY_IMAGES', [413, '图片数量过多']],
  ['UNSUPPORTED_IMAGE_TYPE', [415, '不支持的图片格式']],
  ['IMAGE_TYPE_MISMATCH', [415, '图片内容与声明的类型不一致']],
  ['INVALID_IMAGE', [400, '图片内容无法识别']],
  ['INVALID_IMAGE_BASE64', [400, '图片编码无效']],
  ['INVALID_FILE_BASE64', [400, '文件编码无效']],
  ['INVALID_ATTACHMENT_REF', [400, '图片引用无效']],
  ['ATTACHMENT_NOT_FOUND', [404, '图片不存在']],
])

function isAttachmentFailure(error) {
  return error instanceof Error && error.name === 'AttachmentError' && typeof error.code === 'string'
}

function attachmentFailure(error) {
  return ATTACHMENT_FAILURES.get(error.code) ?? [500, '图片读写失败']
}

function normalizeState(value) {
  let migrated = false
  let state
  if ((value?.version === 2 || value?.version === 3 || value?.version === 4 || value?.version === 5 || value?.version === 6) && Array.isArray(value.workspaces)) {
    const hiddenSessionIds = Array.isArray(value.hiddenSessionIds) ? value.hiddenSessionIds.filter(item => typeof item === 'string') : []
    migrated = value.version < 3 || !Array.isArray(value.hiddenSessionIds)
    const workspaces = value.workspaces.map(workspace => ({
      ...workspace,
      threads: Array.isArray(workspace.threads) ? workspace.threads.map(thread => {
        if (Array.isArray(thread.messages)) {
          const messages = thread.messages.filter(message => !isInjectedUserMessage(message))
          if (messages.length !== thread.messages.length) migrated = true
          return { ...thread, messages }
        }
        migrated = true
        const notes = Array.isArray(thread.notes) ? thread.notes : []
        const { notes: _notes, ...rest } = thread
        return { ...rest, messages: notes, pendingProcess: [] }
      }) : [],
    }))
    state = { ...value, version: value.version, hiddenSessionIds, workspaces }
  } else if (value?.version === 1 && Array.isArray(value.workspaces)) {
    const now = typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString()
    state = {
      version: 3,
      hiddenSessionIds: [],
      workspaces: value.workspaces.map((workspace, index) => {
        const events = Array.isArray(workspace.events) ? workspace.events : []
        const workspaceNow = typeof workspace.updatedAt === 'string' ? workspace.updatedAt : now
        return {
          id: typeof workspace.id === 'string' ? workspace.id : randomUUID(),
          title: typeof workspace.title === 'string' && workspace.title.trim() ? workspace.title : '未命名工作空间',
          createdAt: typeof workspace.createdAt === 'string' ? workspace.createdAt : workspaceNow,
          updatedAt: workspaceNow,
          threads: events.length === 0 ? [] : [{
            id: randomUUID(), title: workspace.title || '历史记录', parentId: null, dshSessionId: null, dshSessionTitle: null,
            color: TOPIC_COLORS[index % TOPIC_COLORS.length], position: { x: 86, y: 82 }, createdAt: workspaceNow, updatedAt: workspaceNow,
            messages: events.map(event => ({ id: typeof event.id === 'string' ? event.id : randomUUID(), text: String(event.text ?? ''), at: typeof event.at === 'string' ? event.at : workspaceNow })),
          }],
        }
      }),
    }
    migrated = true
  } else {
    throw new Error('expected Synapse data version 1, 2, 3, 4, 5, or 6')
  }
  if (state.version < 4) {
    if (foldLegacyToolCards(state.workspaces)) migrated = true
    state.version = 4
    migrated = true
  }
  // v5 drops message bodies and tool payloads from the workspace file: they are
  // re-read from the DSH session log on demand. Existing bodies become previews.
  if (state.version < 5) {
    for (const workspace of state.workspaces) {
      for (const thread of workspace.threads ?? []) {
        if (Array.isArray(thread.messages)) thread.messages = thread.messages.map(toStoredMessage)
        if (Array.isArray(thread.pendingProcess)) thread.pendingProcess = thread.pendingProcess.map(toStoredProcess)
      }
    }
    state.version = 5
    migrated = true
  }
  // v6 adds the canvas annotation layer beside the conversation graph: notes,
  // images, shapes and group frames live on the workspace, and a card names the
  // frame that holds it. Nothing is rewritten — an absent collection is empty
  // and absent membership is null — so this step is a default-fill, not a
  // conversion, and a v6 file is never touched on load.
  if (state.version < 6) {
    for (const workspace of state.workspaces) {
      if (!Array.isArray(workspace.nodes)) workspace.nodes = []
      if (workspace.cardPositions === null || typeof workspace.cardPositions !== 'object' || Array.isArray(workspace.cardPositions)) workspace.cardPositions = {}
      for (const thread of workspace.threads ?? []) {
        if (typeof thread.frameId !== 'string') thread.frameId = null
      }
    }
    state.version = 6
    migrated = true
  }
  return { state, migrated }
}

/** v4 message → v5 message: keep identity and a preview, drop the body. */
function toStoredMessage(message) {
  const normalized = typeof message?.text === 'string' ? message.text.trim() : ''
  const text = normalized === '' ? '' : excerptOf(normalized)
  const process = Array.isArray(message?.process) ? message.process.map(toStoredProcess) : message?.process
  return {
    ...message,
    text,
    length: normalized.length,
    truncated: text.length < normalized.length,
    ...(process === undefined ? {} : { process }),
  }
}

/** v4 process record → v5 record: keep identity and status, drop the payload. */
function toStoredProcess(entry) {
  if (entry === null || typeof entry !== 'object') return entry
  const { arguments: _arguments, result, error, ...rest } = entry
  const status = error !== null && error !== undefined && error !== ''
    ? 'failed'
    : result === null || result === undefined
      ? 'pending'
      : 'done'
  return { ...rest, status: typeof entry.status === 'string' ? entry.status : status }
}

/**
 * Fold v3-era standalone tool cards (kinds `tool` / `tool-result`) into the
 * preceding assistant message's `process` list, pairing each call with the
 * result that follows it in order, so every tool invocation lives in one
 * home: the assistant turn card.
 */
function foldLegacyToolCards(workspaces) {
  let changed = false
  for (const workspace of workspaces) {
    for (const thread of workspace.threads ?? []) {
      if (!Array.isArray(thread.messages)) continue
      const folded = []
      let assistant = null
      let pending = []
      for (const message of thread.messages) {
        if (message.kind === 'assistant') {
          assistant = message
          assistant.process ??= []
          pending = []
          folded.push(message)
          continue
        }
        if (message.kind !== 'tool' && message.kind !== 'tool-result') {
          folded.push(message)
          continue
        }
        if (assistant === null) {
          folded.push(message)
          continue
        }
        changed = true
        if (message.kind === 'tool') {
          const [name = '工具调用', ...argumentLines] = message.text.split('\n')
          const entry = { callId: `legacy-${assistant.process.length}`, name, arguments: argumentLines.join('\n'), result: null, error: null }
          pending.push(entry)
          assistant.process.push(entry)
        } else {
          const entry = pending.shift() ?? (() => {
            const orphan = { callId: `legacy-orphan-${assistant.process.length}`, name: '工具调用', arguments: null, result: null, error: null }
            assistant.process.push(orphan)
            return orphan
          })()
          entry.result = message.text
        }
      }
      thread.messages = folded
    }
  }
  return changed
}

function positionOf(value) {
  const x = Number(value?.x)
  const y = Number(value?.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new InputError('position 必须包含有效坐标')
  return { x: Math.round(Math.max(-2000, Math.min(5000, x))), y: Math.round(Math.max(-2000, Math.min(5000, y))) }
}

function requiredText(value, maxLength, field) {
  if (typeof value !== 'string') throw new InputError(`${field} 必须是文本`)
  const text = value.trim()
  if (text.length === 0) throw new InputError(`${field} 不能为空`)
  if (text.length > maxLength) throw new InputError(`${field} 超过长度限制`)
  return text
}

// ---------------------------------------------------------------------------
// Canvas primitives (schema v6)
//
// A node is one annotation drawn beside the conversation graph: a sticky note,
// a pasted image, a shape/arrow, or a group frame. Every node is validated
// before it enters the state, because the browser receives these objects back
// verbatim and renders them as geometry.
// ---------------------------------------------------------------------------

/** Build one validated node. `input` comes straight from JSON, so nothing is trusted. */
function nodeOf(input, workspace, now) {
  const type = requiredNodeType(input?.type)
  const base = { id: randomUUID(), type, z: zOf(input?.z, workspace), createdAt: now, updatedAt: now }
  if (type === 'note') {
    const position = positionOf(input)
    const size = nodeSizeOf(input, { width: 240, height: 150 })
    return {
      ...base,
      x: position.x, y: position.y, width: size.width, height: size.height,
      text: nodeTextOf(input?.text),
      color: nodeColorOf(input?.color, 'yellow'),
    }
  }
  if (type === 'image') {
    const image = imageRefOf(input?.image)
    const position = positionOf(input)
    const size = nodeSizeOf(input, defaultImageSize(image))
    return { ...base, x: position.x, y: position.y, width: size.width, height: size.height, image }
  }
  if (type === 'shape') {
    const shape = shapeOf(input?.shape)
    const stroke = { stroke: strokeColorOf(input?.stroke), strokeWidth: strokeWidthOf(input?.strokeWidth) }
    if (shape === 'rect' || shape === 'ellipse') {
      const position = positionOf(input)
      const size = nodeSizeOf(input, { width: 180, height: 120 })
      return { ...base, shape, x: position.x, y: position.y, width: size.width, height: size.height, ...stroke, fill: fillOf(input?.fill) }
    }
    const start = positionOf({ x: input?.x1, y: input?.y1 })
    const end = positionOf({ x: input?.x2, y: input?.y2 })
    return { ...base, shape, x1: start.x, y1: start.y, x2: end.x, y2: end.y, ...stroke }
  }
  const position = positionOf(input)
  const size = nodeSizeOf(input, { width: 420, height: 300 })
  return {
    ...base,
    x: position.x, y: position.y, width: size.width, height: size.height,
    title: nodeTitleOf(input?.title),
    collapsed: input?.collapsed === true,
    memberCards: memberCardsOf(input?.memberCards) ?? [],
    memberNodes: memberNodesOf(input?.memberNodes, workspace) ?? [],
  }
}

/** Apply the fields one PATCH actually carried, leaving the rest untouched. */
function applyNodePatch(node, input, workspace) {
  const patch = input !== null && typeof input === 'object' ? input : {}
  const boxed = node.type !== 'shape' || node.shape === 'rect' || node.shape === 'ellipse'
  if (boxed && (patch.x !== undefined || patch.y !== undefined)) {
    const position = positionOf({ x: patch.x ?? node.x, y: patch.y ?? node.y })
    node.x = position.x
    node.y = position.y
  }
  if (boxed && (patch.width !== undefined || patch.height !== undefined)) {
    const size = sizeOf({ width: patch.width ?? node.width, height: patch.height ?? node.height })
    node.width = size.width
    node.height = size.height
  }
  if (!boxed && (patch.x1 !== undefined || patch.y1 !== undefined)) {
    const start = positionOf({ x: patch.x1 ?? node.x1, y: patch.y1 ?? node.y1 })
    node.x1 = start.x
    node.y1 = start.y
  }
  if (!boxed && (patch.x2 !== undefined || patch.y2 !== undefined)) {
    const end = positionOf({ x: patch.x2 ?? node.x2, y: patch.y2 ?? node.y2 })
    node.x2 = end.x
    node.y2 = end.y
  }
  if (patch.z !== undefined) node.z = zOf(patch.z, workspace)
  if (patch.text !== undefined) node.text = nodeTextOf(patch.text)
  if (patch.title !== undefined) node.title = nodeTitleOf(patch.title)
  if (patch.collapsed !== undefined) node.collapsed = patch.collapsed === true
  if (patch.color !== undefined) node.color = nodeColorOf(patch.color, node.color ?? 'yellow')
  if (patch.stroke !== undefined) node.stroke = strokeColorOf(patch.stroke)
  if (patch.strokeWidth !== undefined) node.strokeWidth = strokeWidthOf(patch.strokeWidth)
  if (patch.fill !== undefined) node.fill = fillOf(patch.fill)
  if (node.type === 'frame' && (patch.memberCards !== undefined || patch.memberNodes !== undefined)) {
    if (patch.memberCards !== undefined) node.memberCards = memberCardsOf(patch.memberCards) ?? []
    if (patch.memberNodes !== undefined) node.memberNodes = memberNodesOf(patch.memberNodes, workspace) ?? []
    applyFrameMembers(workspace, node)
  }
  node.updatedAt = new Date().toISOString()
}

/**
 * Point every member thread at this frame and release threads it no longer
 * holds, so `thread.frameId` never outlives its frame's membership list.
 */
function applyFrameMembers(workspace, frame) {
  const memberThreadIds = new Set()
  for (const key of frame.memberCards ?? []) {
    const threadId = positionKeyThreadId(key)
    if (threadId !== null) memberThreadIds.add(threadId)
  }
  for (const thread of workspace.threads ?? []) {
    if (memberThreadIds.has(thread.id)) thread.frameId = frame.id
    else if (thread.frameId === frame.id) thread.frameId = null
  }
}

/** `${threadId}:turn-index:${turnIndex}` → threadId, or null for another shape. */
function positionKeyThreadId(value) {
  if (typeof value !== 'string') return null
  const index = value.lastIndexOf(':turn-index:')
  return index > 0 ? value.slice(0, index) : null
}

/** Drop the position keys of removed threads from every frame in the workspace. */
function pruneFrameCards(workspace, removedThreadIds) {
  if (removedThreadIds.size === 0) return
  for (const node of workspace.nodes ?? []) {
    if (node.type !== 'frame' || !Array.isArray(node.memberCards)) continue
    const kept = node.memberCards.filter(key => !removedThreadIds.has(positionKeyThreadId(key)))
    if (kept.length !== node.memberCards.length) node.memberCards = kept
  }
}

/**
 * Validate one card key. `strict` demands the contract's position key; the
 * looser form accepts any stable key so an older browser that still stores card
 * ids cannot lose its whole position batch to a 400.
 */
function positionKeyOf(value, strict) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) throw new InputError('positionKey 无效')
  if (RESERVED_POSITION_KEYS.has(value) || !/^[0-9a-zA-Z:._-]+$/.test(value)) throw new InputError('positionKey 无效')
  if (strict === true && !POSITION_KEY_PATTERN.test(value)) throw new InputError('memberCards 只接受 positionKey')
  return value
}

function requiredNodeType(value) {
  if (typeof value !== 'string' || !NODE_TYPES.has(value)) throw new InputError('type 必须是 note、image、shape 或 frame')
  return value
}

function shapeOf(value) {
  if (typeof value !== 'string' || !SHAPE_KINDS.has(value)) throw new InputError('shape 必须是 rect、ellipse、line 或 arrow')
  return value
}

/** Clamped box size; a node is never smaller than what its handles need. */
function sizeOf(value) {
  const width = Number(value?.width)
  const height = Number(value?.height)
  if (!Number.isFinite(width) || !Number.isFinite(height)) throw new InputError('尺寸必须包含有效宽高')
  return {
    width: Math.round(Math.min(MAX_NODE_SIZE, Math.max(MIN_NODE_WIDTH, width))),
    height: Math.round(Math.min(MAX_NODE_SIZE, Math.max(MIN_NODE_HEIGHT, height))),
  }
}

function nodeSizeOf(input, fallback) {
  if (input?.width === undefined && input?.height === undefined) return { ...fallback }
  return sizeOf({ width: input?.width ?? fallback.width, height: input?.height ?? fallback.height })
}

function zOf(value, workspace) {
  if (value !== undefined && value !== null) {
    const z = Number(value)
    if (!Number.isFinite(z)) throw new InputError('z 必须是数字')
    return Math.round(Math.min(10_000, Math.max(-10_000, z)))
  }
  return (workspace?.nodes ?? []).reduce((max, node) => (Number.isFinite(node?.z) ? Math.max(max, node.z) : max), 0) + 1
}

function nodeTextOf(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new InputError('text 必须是文本')
  return value.slice(0, MAX_NOTE_LENGTH)
}

function nodeTitleOf(value) {
  if (value === undefined || value === null) return '分组'
  if (typeof value !== 'string') throw new InputError('title 必须是文本')
  const title = value.trim()
  return (title === '' ? '分组' : title).slice(0, MAX_TITLE_LENGTH)
}

function nodeColorOf(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string' || !/^[a-z][a-z-]{0,23}$/.test(value)) throw new InputError('color 无效')
  return value
}

function strokeColorOf(value) {
  if (value === undefined || value === null) return '#3d4d63'
  if (typeof value !== 'string' || !/^#[0-9a-f]{3,8}$/i.test(value)) throw new InputError('stroke 必须是颜色值')
  return value.toLowerCase()
}

function strokeWidthOf(value) {
  if (value === undefined || value === null) return 2
  const width = Number(value)
  if (!Number.isFinite(width)) throw new InputError('strokeWidth 必须是数字')
  return Math.round(Math.min(12, Math.max(1, width)))
}

function fillOf(value) {
  if (value === undefined || value === null) return 'none'
  if (typeof value !== 'string') throw new InputError('fill 必须是颜色值')
  const fill = value.toLowerCase()
  if (fill !== 'none' && !/^#[0-9a-f]{3,8}$/.test(fill)) throw new InputError('fill 必须是颜色值')
  return fill
}

/** The only shape an image reference may take: the attachment store's receipt. */
function imageRefOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new InputError('image 必须是附件引用')
  const attachmentId = typeof value.attachmentId === 'string' ? value.attachmentId.toLowerCase() : ''
  if (!ATTACHMENT_ID_PATTERN.test(attachmentId)) throw new InputError('image.attachmentId 无效')
  const mediaType = typeof value.mediaType === 'string' ? value.mediaType.toLowerCase() : ''
  if (!IMAGE_MEDIA_TYPES.has(mediaType)) throw new InputError('image.mediaType 不受支持')
  const bytes = Number(value.bytes)
  const width = Number(value.width)
  const height = Number(value.height)
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new InputError('image.bytes 无效')
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) throw new InputError('image 尺寸无效')
  return { attachmentId, mediaType, bytes, width, height }
}

/** Default card size for a pasted image: preserve the aspect ratio. */
function defaultImageSize(image) {
  const width = Math.min(480, Math.max(MIN_NODE_WIDTH, image.width))
  return { width, height: Math.max(MIN_NODE_HEIGHT, Math.round(width * image.height / image.width)) }
}

function memberCardsOf(value) {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new InputError('memberCards 必须是数组')
  if (value.length > MAX_FRAME_MEMBERS) throw new InputError('分组内的卡片过多')
  const keys = []
  for (const item of value) {
    const key = positionKeyOf(item, true)
    if (!keys.includes(key)) keys.push(key)
  }
  return keys
}

function memberNodesOf(value, workspace) {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new InputError('memberNodes 必须是数组')
  if (value.length > MAX_FRAME_MEMBERS) throw new InputError('分组内的元素过多')
  const ids = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > 200) throw new InputError('memberNodes 只接受节点 id')
    if (!(workspace.nodes ?? []).some(node => node.id === item)) throw new InputError('分组引用的画布元素不存在')
    if (!ids.includes(item)) ids.push(item)
  }
  return ids
}

/** Event → canvas message kind, or null when the event is not a message. */
function eventKind(event) {
  switch (event?.type) {
    case 'user/message': return 'user'
    case 'assistant/message': return 'assistant'
    case 'todo/write': return 'todo'
    case 'turn/end': {
      const reason = event.data?.reason
      if (reason?.kind === 'error') return 'error'
      if (reason?.kind === 'cancelled' || reason?.kind === 'canceled' || reason?.kind === 'aborted') return 'error'
      return null
    }
    default:
      return /(?:error|failed|failure|cancel(?:led)?|abort)/i.test(event?.type ?? '') ? 'error' : null
  }
}

/**
 * Full body of one event. Shared by the projection (which stores a preview) and
 * the on-demand loader (which returns the whole text), so both read the same
 * fields instead of keeping two parsers in step.
 */
function eventBody(event) {
  switch (event?.type) {
    case 'user/message': return contentText(event.data?.content)
    case 'assistant/message': return contentText(event.data?.message?.content)
    case 'todo/write': return Array.isArray(event.data?.todos) ? event.data.todos.map(todo => `[${todo.status}] ${todo.content}`).join('\n') : ''
    case 'turn/end': {
      const reason = event.data?.reason
      if (reason?.kind === 'error') return errorText(reason.error) ?? '本轮执行失败'
      return '本轮已取消'
    }
    default:
      return eventKind(event) === 'error' ? errorText(event.data?.error ?? event.data?.reason ?? event.data) ?? 'Harness 运行失败' : ''
  }
}

function projectableEvent(event) {
  const kind = eventKind(event)
  if (kind === null) return null
  const text = eventBody(event)
  if (kind === 'user' && (isInjectedUserSource(event.data?.source) || isRuntimeContextText(text))) return null
  return noteProjection(kind, text)
}

/**
 * Full bodies for the requested stored messages, assembled from one session's
 * event log. Exported so the on-demand loader is testable without a Host.
 * `seqs === null` returns every projected message of the thread.
 */
export function bodiesFromEvents(thread, events, seqs) {
  const wanted = seqs === null ? null : new Set(seqs)
  const messages = {}
  const eventsBySeq = new Map(events.map(event => [event?.seq, event]))
  const calls = new Map()
  for (const event of events) {
    if (event?.type !== 'tool/call' && event?.type !== 'tool/result') continue
    const callId = String(event.type === 'tool/call' ? event.data?.callId : event.data?.message?.source?.callId ?? '')
    if (callId === '') continue
    const record = calls.get(callId) ?? {}
    if (event.type === 'tool/call') {
      record.arguments = typeof event.data?.arguments === 'string' ? event.data.arguments : null
    } else {
      record.result = contentText(event.data?.message?.content) || null
      record.error = errorText(event.data?.error)
    }
    calls.set(callId, record)
  }
  for (const message of thread.messages ?? []) {
    if (wanted !== null && !wanted.has(message.sourceSeq)) continue
    const event = eventsBySeq.get(message.sourceSeq)
    if (event === undefined) continue
    const body = eventBody(event).trim()
    const capped = body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}${BODY_TRUNCATED_SUFFIX}` : body
    const process = Array.isArray(message.process)
      ? message.process.map(entry => ({ ...entry, ...(calls.get(String(entry.callId)) ?? {}) }))
      : []
    messages[String(message.sourceSeq)] = { text: capped, truncated: capped.length < body.length, process }
  }
  return messages
}

// ---------------------------------------------------------------------------
// Session logs on disk
//
// `ctx.sessions` only exposes sessions this process currently holds, which is
// one or two out of a workspace's history. Everything else is read from the DSH
// session log: a run of concatenated zstd frames holding JSONL events.
// ---------------------------------------------------------------------------

const SESSION_LOG_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const SESSION_LOG_PATTERN = /^session(?:\.[\w-]+)*\.jsonl\.zstd$/

/** Decode the concatenated zstd frames of one session log into JSONL text. */
export function decodeSessionLog(buffer) {
  if (typeof zstdDecompressSync !== 'function') return null
  const offsets = []
  let index = buffer.indexOf(SESSION_LOG_MAGIC, 0)
  while (index !== -1) {
    offsets.push(index)
    index = buffer.indexOf(SESSION_LOG_MAGIC, index + 4)
  }
  if (offsets.length === 0) return null
  const parts = []
  for (let i = 0; i < offsets.length; i += 1) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(offsets[i], end)))
    } catch {
      // A log that is being appended to can end mid-frame; decode what is whole.
      break
    }
  }
  if (parts.length === 0) return null
  return Buffer.concat(parts).toString('utf8')
}

/** Reads session events from `$DSH_HOME/sessions`, caching by file mtime. */
export class SessionLogReader {
  constructor(directory) {
    this.directory = directory
    this.cache = new Map()
  }

  /** Events of one session, or null when its log is missing or unreadable. */
  async events(sessionId) {
    if (typeof this.directory !== 'string' || this.directory === '' || typeof sessionId !== 'string' || sessionId === '') return null
    const file = await this.findLog(sessionId)
    if (file === null) {
      this.cache.delete(sessionId)
      return null
    }
    const info = await stat(file).catch(() => null)
    if (info === null) return null
    const cached = this.cache.get(sessionId)
    if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.events
    const text = decodeSessionLog(await readFile(file))
    if (text === null) return null
    const events = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const event = JSON.parse(line)
        if (typeof event?.seq === 'number') events.push(event)
      } catch {
        // Trailing partial line while the session is still being written.
      }
    }
    // Keep a few decoded logs; one screenful of cards touches few threads.
    if (this.cache.size >= 4) this.cache.delete(this.cache.keys().next().value)
    this.cache.set(sessionId, { mtimeMs: info.mtimeMs, size: info.size, events })
    return events
  }

  async findLog(sessionId) {
    let workspaces
    try {
      workspaces = await readdir(this.directory, { withFileTypes: true })
    } catch {
      return null
    }
    for (const workspace of workspaces) {
      if (!workspace.isDirectory()) continue
      const sessionDirectory = join(this.directory, workspace.name, sessionId)
      let files
      try {
        files = await readdir(sessionDirectory)
      } catch {
        continue
      }
      const log = files.find(name => SESSION_LOG_PATTERN.test(name))
      if (log !== undefined) return join(sessionDirectory, log)
    }
    return null
  }
}

function errorText(value) {
  if (typeof value === 'string') return value.trim() || null
  if (value === null || value === undefined || typeof value !== 'object') return null
  const name = typeof value.name === 'string' && value.name.trim() !== '' ? value.name.trim() : ''
  const code = typeof value.code === 'string' && value.code.trim() !== '' ? value.code.trim() : ''
  const message = typeof value.message === 'string' && value.message.trim() !== '' ? value.message.trim() : ''
  if (message !== '') return [name, code].filter(Boolean).concat(message).join(': ')
  return [name, code].filter(Boolean).join(': ') || null
}

function noteProjection(kind, text) {
  const normalized = text.trim()
  if (normalized === '') return null
  const excerpt = excerptOf(normalized)
  return { kind, text: excerpt, length: normalized.length, truncated: excerpt.length < normalized.length }
}

/** Short preview kept in the workspace file, with an ellipsis when cut. */
function excerptOf(text) {
  if (text.length <= EXCERPT_CHARS) return text
  return `${text.slice(0, EXCERPT_CHARS).trimEnd()}…`
}

function isRuntimeContextText(text) {
  return typeof text === 'string' && text.trimStart().startsWith('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.')
}

function isRuntimeContextMessage(message) {
  return message?.kind === 'user' && isRuntimeContextText(message.text)
}

/** A harness-authored turn, identified by its structured provenance. */
function isInjectedUserSource(source) {
  return typeof source?.kind === 'string' && INJECTED_USER_SOURCE_KINDS.has(source.kind)
}

/**
 * Recognises a stored skill catalogue. Only the harness emits both markers
 * together, so a person quoting one of them is still kept as a real turn.
 */
function isSkillCatalogText(text) {
  if (typeof text !== 'string') return false
  const head = text.trimStart()
  return head.startsWith(SKILL_CATALOG_OPENER) && head.includes(SKILL_CATALOG_MARKER)
}

/**
 * Whether a stored message must stay out of the canvas graph: runtime
 * snapshots and skill catalogues were never a turn the user took.
 */
function isInjectedUserMessage(message) {
  return message?.kind === 'user' && (isRuntimeContextMessage(message) || isSkillCatalogText(message.text))
}

function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content.flatMap(block => {
    if (block?.type === 'text') return [block.text]
    if (block?.type === 'tool-call') return [block.name, block.arguments]
    if (block?.type === 'tool-result') return contentText(block.content)
    return []
  }).filter(value => typeof value === 'string' && value.trim() !== '').join('\n')
}

function titleFromText(text) {
  const line = text.replaceAll(/\s+/g, ' ').trim()
  return (line.length > 42 ? `${line.slice(0, 42)}...` : line) || 'DSH 会话'
}

function sessionCwd(session) {
  // The Session header defines `cwd` as its only working-directory carrier; the
  // old `header.meta.cwd` fallback never matched a real header field.
  const cwd = session.header?.cwd
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : '未指定工作目录'
}

function workspaceTitle(cwd, fallbackTitle) {
  if (cwd === '未指定工作目录') return fallbackTitle
  const segment = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1)
  return segment && segment.trim() !== '' ? segment : fallbackTitle
}

async function readJson(req) {
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > MAX_BODY_BYTES) throw new InputError('请求内容过大')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new InputError('请求不是有效 JSON') }
}

/**
 * Read one raw binary body under its own ceiling. `readJson`'s 32 KiB cap
 * exists because every JSON route answers from a small state object; an image
 * upload is the one request whose body is the payload, so it gets its own
 * budget and a declared-length pre-check that refuses before the bytes arrive.
 */
async function readBody(req, maxBytes) {
  const declared = Number.parseInt(typeof req.headers?.['content-length'] === 'string' ? req.headers['content-length'] : '', 10)
  if (Number.isInteger(declared) && declared > maxBytes) throw new PayloadTooLargeError(`请求内容过大（上限 ${Math.round(maxBytes / 1024 / 1024)} MiB）`)
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > maxBytes) throw new PayloadTooLargeError(`请求内容过大（上限 ${Math.round(maxBytes / 1024 / 1024)} MiB）`)
    chunks.push(chunk)
  }
  if (length === 0) throw new InputError('图片内容为空')
  return Buffer.concat(chunks)
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function sendFile(res, contentType, body) {
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' })
  res.end(body)
}

/**
 * Serve one attachment object. The URL is content-addressed, so the bytes behind
 * it can never change: the response is immutable, and `nosniff` keeps a stored
 * object from being reinterpreted as something scriptable.
 */
function sendImage(res, contentType, body) {
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': body.length,
    // `private`: a canvas image belongs to this user's browser. The bytes are
    // content-addressed so they never change, but a shared proxy on a LAN-trusted
    // host must not keep a copy.
    'cache-control': 'private, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

/** The request's media type, or a 415 when this deployment will not store it. */
function imageMediaTypeOf(value) {
  const mediaType = (typeof value === 'string' ? value : '').split(';', 1)[0].trim().toLowerCase()
  if (!IMAGE_MEDIA_TYPES.has(mediaType)) throw new UnsupportedMediaError('只支持 png/jpeg/webp/gif 图片')
  return mediaType
}

function page() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Synapse for DSH</title><link rel="stylesheet" href="/synapse/styles.css"></head><body><div id="app"></div><script src="/synapse/app.js"></script></body></html>`
}

/** Mount Synapse routes on the existing DSH Web Server. */
export function apply(ctx, config) {
  const store = new WorkspaceStore(config?.dataFile)
  // A profile can point the plugin at a different home; by default the session
  // logs sit beside the workspace file ($DSH_HOME/sessions).
  const sessionsDirectory = typeof config?.sessionsDir === 'string' && config.sessionsDir !== ''
    ? config.sessionsDir
    : join(dirname(dirname(config?.dataFile ?? '')), 'sessions')
  const sessionLog = new SessionLogReader(sessionsDirectory)
  const autoProjection = config?.autoProjection !== false
  const projectionWorkspaceTitle = typeof config?.projectionWorkspaceTitle === 'string' && config.projectionWorkspaceTitle.trim() !== ''
    ? config.projectionWorkspaceTitle.trim().slice(0, MAX_TITLE_LENGTH)
    : 'DSH 任务'
  const reportProjectionFailure = error => {
    ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
  }
  const replaySession = session => {
    // Forks inherit their parent's log. The canvas already represents that
    // history through the parent node, so only project the child's live tail:
    // `inheritedEventCount` is 0 without a fork and the durable cut with one.
    const replayFrom = session.inheritedEventCount ?? 0
    void store.projectSession(session, replayFrom, projectionWorkspaceTitle).catch(reportProjectionFailure)
  }
  // Buffer live events per session and flush them in one write per microtask,
  // so a burst of turn events coalesces into a single save instead of N.
  const projectionQueue = []
  let projectionScheduled = false
  const enqueueProjection = (session, event) => {
    projectionQueue.push({ session, event })
    if (projectionScheduled) return
    projectionScheduled = true
    queueMicrotask(() => {
      projectionScheduled = false
      const batch = projectionQueue.splice(0)
      const bySession = new Map()
      for (const item of batch) {
        const entry = bySession.get(item.session.id)
        if (entry === undefined) bySession.set(item.session.id, [item.session, [item.event]])
        else entry[1].push(item.event)
      }
      for (const [sessionId, [session, events]] of bySession) {
        void store.projectEvents(session, events, projectionWorkspaceTitle).catch(reportProjectionFailure)
      }
    })
  }
  if (autoProjection) {
    ctx.on('session/created', replaySession)
    ctx.on('session/event', enqueueProjection)
    for (const session of ctx.sessions.list()) replaySession(session)
  }
  // Bodies live in the session log, not in the workspace file (issue #42). The
  // canvas pulls them for the cards it actually renders; the detail view pulls a
  // whole thread at once. An archived or already-removed session cannot be
  // re-read, so the caller is told instead of receiving silently empty text.
  const threadBodies = async (threadId, seqs) => {
    const located = await store.locateThread(threadId)
    if (located === null) throw new NotFoundError('会话不存在')
    const { thread } = located
    const wanted = seqs === null ? null : new Set(seqs)
    if (thread.dshSessionId === null) {
      const messages = {}
      for (const message of thread.messages ?? []) {
        if (wanted !== null && !wanted.has(message.sourceSeq)) continue
        messages[String(message.sourceSeq)] = { text: message.text, truncated: message.truncated === true, process: message.process ?? [], local: true }
      }
      return { messages }
    }
    const session = ctx.sessions.list().find(candidate => candidate.id === thread.dshSessionId)
    if (session !== undefined) return { messages: bodiesFromEvents(thread, session.snapshotEvents(), seqs) }
    // Closed session: read its log from disk, which is where the body lives.
    const events = await sessionLog.events(thread.dshSessionId)
    if (events === null) return { messages: {}, unavailable: true }
    return { messages: bodiesFromEvents(thread, events, seqs) }
  }
  // The DSH attachment store is an optional capability: the shipped base
  // composition mounts `dsh-attachment-local`, but a custom composition may not.
  // Every canvas feature except images works without it, so the service is read
  // lazily — Cordis throws on a bare `ctx.attachments` access when the service
  // was never injected, and `ctx.get()` is its documented read-without-inject
  // accessor. Its absence surfaces as a 503 on the two image routes only.
  const attachmentStore = () => {
    if (typeof ctx.get === 'function') return ctx.get('attachments')
    try { return ctx.attachments } catch { return undefined }
  }
  const saveImageAttachment = async (data, mediaType) => {
    const attachments = attachmentStore()
    if (attachments === undefined) throw new UnavailableError('DSH 附件库不可用，暂时无法保存图片')
    const input = { data, mediaType }
    if (typeof attachments.saveImage === 'function') return attachments.saveImage(input)
    if (typeof attachments.saveImages === 'function') {
      const [ref] = await attachments.saveImages([input])
      return ref
    }
    throw new UnavailableError('DSH 附件库不可用，暂时无法保存图片')
  }
  const readImageAttachment = async ref => {
    const attachments = attachmentStore()
    if (attachments === undefined) throw new UnavailableError('DSH 附件库不可用，暂时无法读取图片')
    if (typeof attachments.readImage === 'function') {
      const stored = await attachments.readImage(ref)
      if (stored !== null && typeof stored === 'object' && stored.data !== undefined) return { mediaType: stored.ref?.mediaType ?? ref.mediaType, data: stored.data }
    }
    // A backend without normalized-image reads can still hand over the
    // host-file location of the immutable object it stored.
    if (typeof attachments.imageHostPath === 'function') {
      const path = attachments.imageHostPath(ref)
      if (typeof path === 'string' && path !== '') return { mediaType: ref.mediaType, data: await readFile(path) }
    }
    throw new UnavailableError('DSH 附件库不可用，暂时无法读取图片')
  }
  // The DSH /api browser-trust fence does not cover /synapse routes, so this
  // handler checks the Host header itself: localhost is allowed by default and
  // additional authorities opt in through config.trustedHosts (mirrors the
  // fence's DNS-rebinding defense).
  const trustedHosts = new Set(['localhost', '127.0.0.1', ...[...(config?.trustedHosts ?? [])].map(host => String(host).trim().toLowerCase()).filter(Boolean)])
  const api = async (req, res) => {
    try {
      const hostname = (typeof req.headers.host === 'string' ? req.headers.host : '').replace(/:\d+$/, '').toLowerCase()
      if (!trustedHosts.has(hostname)) return sendJson(res, 403, { error: '不被信任的 Host' })
      const path = new URL(req.url ?? '/', 'http://dsh.local').pathname
      if (path === '/synapse/api/reset' && req.method === 'POST') return sendJson(res, 200, await store.clearLegacy(ctx.sessions.list()))
      if (path === '/synapse/api/workspaces') {
        if (req.method === 'GET') return sendJson(res, 200, { workspaces: await store.list() })
        if (req.method === 'POST') return sendJson(res, 201, { workspace: await store.create((await readJson(req)).title) })
      }
      const workspace = /^\/synapse\/api\/workspaces\/([0-9a-f-]+)$/i.exec(path)
      if (workspace !== null) {
        if (req.method === 'GET') return sendJson(res, 200, { workspace: await store.get(workspace[1]) })
        if (req.method === 'POST') return sendJson(res, 201, { thread: await store.createThread(workspace[1], await readJson(req)) })
        // Card positions are merged, never replaced: the browser sends only the
        // keys it just moved, so a second tab's drags survive.
        if (req.method === 'PATCH') return sendJson(res, 200, { workspace: await store.mergeCardPositions(workspace[1], (await readJson(req)).cardPositions) })
      }
      const workspaceNodes = /^\/synapse\/api\/workspaces\/([0-9a-f-]+)\/nodes$/i.exec(path)
      if (workspaceNodes !== null && req.method === 'POST') return sendJson(res, 201, { node: await store.createNode(workspaceNodes[1], await readJson(req)) })
      const workspaceImages = /^\/synapse\/api\/workspaces\/([0-9a-f-]+)\/images$/i.exec(path)
      if (workspaceImages !== null && req.method === 'POST') {
        // The body is the image itself, so the media type is the only type
        // information that exists and the bytes are capped by MAX_IMAGE_BYTES
        // instead of the JSON route's 32 KiB. The workspace is resolved first so
        // a typo cannot leave an unreferenced object behind, and the reply is the
        // attachment receipt — the caller creates the node with it, which keeps
        // placement in the same request as every other node.
        if (!await store.hasWorkspace(workspaceImages[1])) throw new NotFoundError('工作空间不存在')
        const mediaType = imageMediaTypeOf(req.headers['content-type'])
        const data = await readBody(req, MAX_IMAGE_BYTES)
        return sendJson(res, 201, { image: await saveImageAttachment(data, mediaType) })
      }
      const nodeRoute = /^\/synapse\/api\/nodes\/([0-9a-f-]+)$/i.exec(path)
      if (nodeRoute !== null && req.method === 'PATCH') return sendJson(res, 200, { node: await store.updateNode(nodeRoute[1], await readJson(req)) })
      if (nodeRoute !== null && req.method === 'DELETE') return sendJson(res, 200, await store.removeNode(nodeRoute[1]))
      // Content-addressed image bytes. Only an attachment some node in this
      // canvas still references is served, so the route cannot read the whole
      // harness attachment store.
      const asset = /^\/synapse\/api\/assets\/(sha256:[0-9a-f]{64})$/i.exec(path)
      if (asset !== null && req.method === 'GET') {
        const ref = await store.findImageRef(asset[1].toLowerCase())
        if (ref === null) throw new NotFoundError('图片不存在')
        const stored = await readImageAttachment(ref)
        return sendImage(res, stored.mediaType, stored.data)
      }
      const branch = /^\/synapse\/api\/threads\/([0-9a-f-]+)\/branch$/i.exec(path)
      if (branch !== null && req.method === 'POST') return sendJson(res, 201, { thread: await store.branch(branch[1], await readJson(req)) })
      if (path === '/synapse/api/sessions/sync' && req.method === 'POST') { const body = await readJson(req); return sendJson(res, 200, { workspaces: await store.syncSessions(body.sessions, body.removedSessionIds) }) }
      const messages = /^\/synapse\/api\/threads\/([0-9a-f-]+)\/messages$/i.exec(path)
      if (messages !== null && req.method === 'POST') return sendJson(res, 201, { thread: await store.addMessage(messages[1], (await readJson(req)).text) })
      const full = /^\/synapse\/api\/threads\/([0-9a-f-]+)\/full$/i.exec(path)
      if (full !== null && req.method === 'GET') {
        const raw = new URL(req.url ?? '/', 'http://dsh.local').searchParams.get('seqs')
        const seqs = raw === null || raw.trim() === ''
          ? null
          : raw.split(',').map(value => Number.parseInt(value, 10)).filter(value => Number.isInteger(value) && value >= 0)
        return sendJson(res, 200, await threadBodies(full[1], seqs))
      }
      const thread = /^\/synapse\/api\/threads\/([0-9a-f-]+)$/i.exec(path)
      if (thread !== null && req.method === 'PATCH') return sendJson(res, 200, { thread: await store.updateThread(thread[1], await readJson(req)) })
      if (thread !== null && req.method === 'DELETE') return sendJson(res, 200, await store.removeThread(thread[1]))
      return sendJson(res, 404, { error: '接口不存在' })
    } catch (error) {
      if (error instanceof InputError) return sendJson(res, 400, { error: error.message })
      if (error instanceof NotFoundError) return sendJson(res, 404, { error: error.message })
      if (error instanceof PayloadTooLargeError) return sendJson(res, 413, { error: error.message })
      if (error instanceof UnsupportedMediaError) return sendJson(res, 415, { error: error.message })
      if (error instanceof UnavailableError) return sendJson(res, 503, { error: error.message })
      if (isAttachmentFailure(error)) {
        const [status, message] = attachmentFailure(error)
        if (status < 500) return sendJson(res, status, { error: message })
        ctx.logger.error(error)
        return sendJson(res, status, { error: message })
      }
      ctx.logger.error(error instanceof Error ? error : new Error(String(error)))
      // A store that cannot read its file carries the only actionable detail —
      // the path. Passing it through beats a generic banner the user cannot act
      // on, and it is the one failure the canvas must never paper over.
      const unreadable = error instanceof Error && error.message.startsWith('synapse: cannot read')
      return sendJson(res, 500, { error: unreadable ? error.message : 'Synapse 数据暂时不可用' })
    }
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/synapse', handler: (_req, res) => { res.writeHead(302, { location: '/synapse/' }); res.end() } }), 'synapse: redirect')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/synapse/', handler: (_req, res) => { sendFile(res, 'text/html; charset=utf-8', page()) } }), 'synapse: page')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/synapse/app.js', handler: async (_req, res) => { sendFile(res, 'text/javascript; charset=utf-8', await readFile(new URL('./app.js', import.meta.url), 'utf8')) } }), 'synapse: app')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/synapse/styles.css', handler: async (_req, res) => { sendFile(res, 'text/css; charset=utf-8', await readFile(new URL('./styles.css', import.meta.url), 'utf8')) } }), 'synapse: styles')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/synapse/deepseek-mark.svg', handler: async (_req, res) => { sendFile(res, 'image/svg+xml', await readFile(new URL('./deepseek-mark.svg', import.meta.url), 'utf8')) } }), 'synapse: DeepSeek mark')
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/synapse/api', handler: api }), 'synapse: api')
}
