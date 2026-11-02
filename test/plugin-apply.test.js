import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'

/**
 * Drives the host half through the v0.1.7-rc.2 contracts it consumes: the
 * `webServer` route registry, the untagged (global) `session/created` and
 * `session/event` listeners, and the `Session` surface a projection replay
 * reads. A Session double here exposes `snapshotEvents()` and
 * `inheritedEventCount`, because the plugin's old readers (`session.events`,
 * `header.seedLength`) were removed and their absence must fail this test.
 */

/**
 * Build one `Session` double.
 * @param fields - identity, durable fork cut, cwd, and the recorded log.
 * @returns the session double.
 */
function hostSession(fields) {
  return {
    id: fields.id,
    header: fields.cwd === undefined ? {} : { cwd: fields.cwd },
    inheritedEventCount: fields.inheritedEventCount ?? 0,
    // The log is reachable only through the v0.1.7 reader: a double that also
    // exposed the removed `events` getter would let the old host half pass.
    snapshotEvents: () => fields.events,
  }
}

/**
 * Build the composing context the host half is mounted into.
 * @param options - the live sessions `ctx.sessions.list()` reports, plus the
 *   services `ctx.get(name)` may resolve (the attachment store is optional).
 * @returns the context, the registered routes, the handlers, and the listeners.
 */
function hostContext(options = {}) {
  const routes = []
  const handlers = new Map()
  const listeners = new Map()
  const sessions = options.sessions ?? []
  const services = options.services ?? {}
  const ctx = {
    logger: { warn: () => {}, error: () => {} },
    webServer: {
      register: route => {
        routes.push({ kind: route.kind, path: route.path })
        handlers.set(route.path, route.handler)
        return () => {}
      },
    },
    sessions: { list: () => sessions },
    // Cordis reads an injectable service without declaring it this way; the
    // host half uses it so a composition without `attachments` still mounts.
    get: name => services[name],
    on: (type, handler) => {
      listeners.set(type, [...listeners.get(type) ?? [], handler])
      return () => {}
    },
    effect: effect => effect(),
  }
  return {
    ctx,
    routes,
    handlers,
    sessions,
    services,
    emit: async (type, ...args) => {
      for (const handler of listeners.get(type) ?? []) await handler(...args)
    },
  }
}

/**
 * Drive one `/synapse/api` request through the mounted prefix handler.
 * @param host - the context returned by {@link hostContext}.
 * @param fields - method, url, headers, and an optional body string or buffer.
 * @returns the status, headers, raw body, and its decoded views.
 */
async function request(host, fields) {
  const handler = host.handlers.get('/synapse/api')
  const chunks = fields.body === undefined ? [] : [Buffer.isBuffer(fields.body) ? fields.body : Buffer.from(fields.body)]
  const req = {
    method: fields.method ?? 'GET',
    url: fields.url,
    headers: { host: 'localhost', ...fields.headers },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
  const response = { status: 0, headers: {}, body: Buffer.alloc(0) }
  const res = {
    writeHead(status, headers) {
      response.status = status
      response.headers = headers ?? {}
    },
    end(chunk) {
      response.body = chunk === undefined ? Buffer.alloc(0) : Buffer.from(chunk)
    },
  }
  await handler(req, res)
  response.text = response.body.toString('utf8')
  response.json = () => JSON.parse(response.text)
  return response
}

/**
 * Poll until the store's debounced write contains `predicate`, or fail the wait.
 * @param dataFile - the store's JSON file.
 * @param predicate - receives the parsed state.
 * @returns the parsed state that satisfied the predicate.
 */
async function waitForState(dataFile, predicate) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    // The store loads and creates the file asynchronously after `apply` returns.
    const state = await readFile(dataFile, 'utf8').then(JSON.parse, () => undefined)
    if (state !== undefined && predicate(state)) return state
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('the debounced projection write did not reach the data file')
}

test('mounts its own routes on the existing DSH Web Server', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-apply-routes-'))
  const host = hostContext()

  apply(host.ctx, { dataFile: join(directory, 'state.json') })

  assert.deepEqual(host.routes, [
    { kind: 'exact', path: '/synapse' },
    { kind: 'exact', path: '/synapse/' },
    { kind: 'exact', path: '/synapse/app.js' },
    { kind: 'exact', path: '/synapse/styles.css' },
    { kind: 'exact', path: '/synapse/deepseek-mark.svg' },
    { kind: 'prefix', path: '/synapse/api' },
  ])
})

test('replays the sessions already live at mount through snapshotEvents()', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-apply-replay-'))
  const dataFile = join(directory, 'state.json')
  const host = hostContext({
    sessions: [hostSession({
      id: 'session-live',
      cwd: 'C:\\work\\live',
      events: [
        { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: '已存在的会话' }] } },
        { type: 'assistant/message', seq: 1, time: 2, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '回答' }] } } },
      ],
    })],
  })

  apply(host.ctx, { dataFile })
  const state = await waitForState(dataFile, value => value.workspaces.length === 1)

  assert.equal(state.workspaces[0].cwd, 'C:\\work\\live')
  assert.deepEqual(state.workspaces[0].threads[0].messages.map(message => message.text), ['已存在的会话', '回答'])
})

test('projects only the child-owned tail of a fork through inheritedEventCount', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-apply-fork-'))
  const dataFile = join(directory, 'state.json')
  const host = hostContext({
    sessions: [hostSession({
      id: 'session-child',
      cwd: 'C:\\work\\fork',
      // The first two events belong to the parent the canvas already shows; the
      // durable fork cut is what replaced `header.seedLength`.
      inheritedEventCount: 2,
      events: [
        { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: '父会话问题' }] } },
        { type: 'assistant/message', seq: 1, time: 2, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '父会话回答' }] } } },
        { type: 'user/message', seq: 2, time: 3, data: { content: [{ type: 'text', text: '分支追问' }] } },
      ],
    })],
  })

  apply(host.ctx, { dataFile })
  const state = await waitForState(dataFile, value => value.workspaces.length === 1)

  const thread = state.workspaces[0].threads[0]
  assert.equal(thread.sourceSeedLength, 2)
  assert.deepEqual(thread.messages.map(message => message.text), ['分支追问'])
})

test('projects committed events delivered through the global session feed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-apply-feed-'))
  const dataFile = join(directory, 'state.json')
  const session = hostSession({ id: 'session-feed', cwd: 'C:\\work\\feed', events: [] })
  const host = hostContext({ sessions: [session] })

  apply(host.ctx, { dataFile })
  await host.emit('session/event', session, { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: '实时事件' }] } })
  const state = await waitForState(dataFile, value => value.workspaces.length === 1)

  assert.deepEqual(state.workspaces[0].threads[0].messages.map(message => message.text), ['实时事件'])
})

test('tracks a session created after mount', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-apply-created-'))
  const dataFile = join(directory, 'state.json')
  const host = hostContext()

  apply(host.ctx, { dataFile })
  await host.emit('session/created', hostSession({
    id: 'session-created',
    cwd: 'C:\\work\\created',
    events: [{ type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: '新会话' }] } }],
  }))
  const state = await waitForState(dataFile, value => value.workspaces.length === 1)

  assert.deepEqual(state.workspaces[0].threads[0].messages.map(message => message.text), ['新会话'])
})

/** Attachment-store double: the two methods the host half calls on it. */
function attachmentStoreDouble() {
  const stored = new Map()
  return {
    stored,
    async saveImage(input) {
      const attachmentId = `sha256:${'c'.repeat(64)}`
      const ref = { attachmentId, mediaType: input.mediaType, bytes: input.data.length, width: 24, height: 12 }
      stored.set(attachmentId, { ref, data: input.data })
      return ref
    },
    async readImage(ref) {
      const entry = stored.get(ref.attachmentId)
      if (entry === undefined) throw Object.assign(new Error('attachment missing'), { name: 'AttachmentError', code: 'ATTACHMENT_NOT_FOUND' })
      return entry
    },
  }
}

test('serves canvas node routes under the existing api prefix', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-apply-nodes-'))
  const host = hostContext()
  apply(host.ctx, { dataFile: join(directory, 'state.json') })

  const created = await request(host, { method: 'POST', url: '/synapse/api/workspaces', body: JSON.stringify({ title: '画布' }) })
  assert.equal(created.status, 201)
  const workspaceId = created.json().workspace.id

  const note = await request(host, {
    method: 'POST', url: `/synapse/api/workspaces/${workspaceId}/nodes`,
    body: JSON.stringify({ type: 'note', x: 12, y: 34, text: '标注' }),
  })
  assert.equal(note.status, 201)
  const node = note.json().node
  assert.equal(node.type, 'note')
  assert.equal(node.text, '标注')

  const patched = await request(host, { method: 'PATCH', url: `/synapse/api/nodes/${node.id}`, body: JSON.stringify({ text: '改过' }) })
  assert.equal(patched.status, 200)
  assert.equal(patched.json().node.text, '改过')

  const key = '11111111-1111-4111-8111-111111111111:turn-index:0'
  const moved = await request(host, {
    method: 'PATCH', url: `/synapse/api/workspaces/${workspaceId}`,
    body: JSON.stringify({ cardPositions: { [key]: { x: 10, y: 20 } } }),
  })
  assert.equal(moved.status, 200)
  assert.deepEqual(moved.json().workspace.cardPositions[key], { x: 10, y: 20 })

  const graph = await request(host, { url: `/synapse/api/workspaces/${workspaceId}` })
  assert.deepEqual(graph.json().workspace.nodes.map(item => item.id), [node.id])

  const removed = await request(host, { method: 'DELETE', url: `/synapse/api/nodes/${node.id}` })
  assert.equal(removed.status, 200)
  assert.deepEqual(removed.json(), { removed: 1 })

  // Unknown node ids stay a 404 so a stale tab cannot resurrect a deleted node.
  const missing = await request(host, { method: 'DELETE', url: '/synapse/api/nodes/22222222-2222-4222-8222-222222222222' })
  assert.equal(missing.status, 404)
})

test('refuses canvas requests whose Host is not trusted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-apply-host-'))
  const host = hostContext()
  apply(host.ctx, { dataFile: join(directory, 'state.json') })

  const blocked = await request(host, { url: '/synapse/api/workspaces', headers: { host: 'evil.example:57096' } })
  assert.equal(blocked.status, 403)
  assert.deepEqual(blocked.json(), { error: '不被信任的 Host' })
})

test('degrades image routes to 503 when no attachment store is mounted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-apply-noattachments-'))
  const host = hostContext()
  apply(host.ctx, { dataFile: join(directory, 'state.json') })

  const created = await request(host, { method: 'POST', url: '/synapse/api/workspaces', body: JSON.stringify({ title: '画布' }) })
  const workspaceId = created.json().workspace.id

  const upload = await request(host, {
    method: 'POST', url: `/synapse/api/workspaces/${workspaceId}/images`,
    headers: { 'content-type': 'image/png', 'content-length': '4' },
    body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  })
  assert.equal(upload.status, 503)
  assert.match(upload.json().error, /附件库不可用/)

  // Annotations keep working without images: the capability is additive.
  const note = await request(host, {
    method: 'POST', url: `/synapse/api/workspaces/${workspaceId}/nodes`,
    body: JSON.stringify({ type: 'note', x: 0, y: 0, text: '照常工作' }),
  })
  assert.equal(note.status, 201)
})

test('stores an uploaded image in the attachment store and serves it back', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-apply-images-'))
  const dataFile = join(directory, 'state.json')
  const host = hostContext({ services: { attachments: attachmentStoreDouble() } })
  apply(host.ctx, { dataFile })

  const created = await request(host, { method: 'POST', url: '/synapse/api/workspaces', body: JSON.stringify({ title: '画布' }) })
  const workspaceId = created.json().workspace.id
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  // The upload stores bytes and answers with the attachment receipt; the caller
  // then creates the node, exactly as the browser half does.
  const upload = await request(host, {
    method: 'POST', url: `/synapse/api/workspaces/${workspaceId}/images`,
    headers: { 'content-type': 'image/png', 'content-length': String(bytes.length) },
    body: bytes,
  })
  assert.equal(upload.status, 201)
  const image = upload.json().image
  assert.equal(image.mediaType, 'image/png')
  assert.equal(image.bytes, bytes.length)
  assert.match(image.attachmentId, /^sha256:[a-f0-9]{64}$/)

  const node = await request(host, {
    method: 'POST', url: `/synapse/api/workspaces/${workspaceId}/nodes`,
    body: JSON.stringify({ type: 'image', x: 40, y: 60, width: 320, height: 200, image }),
  })
  assert.equal(node.status, 201)
  assert.deepEqual(node.json().node.image, image)
  assert.equal(node.json().node.x, 40)

  // The workspace file keeps the reference, never the bytes.
  const persisted = await readFile(dataFile, 'utf8')
  assert.ok(persisted.includes(image.attachmentId))
  assert.equal(persisted.includes('data:image'), false)

  const asset = await request(host, { url: `/synapse/api/assets/${image.attachmentId}` })
  assert.equal(asset.status, 200)
  assert.equal(asset.headers['content-type'], 'image/png')
  assert.match(asset.headers['cache-control'], /immutable/)
  assert.equal(asset.headers['x-content-type-options'], 'nosniff')
  assert.deepEqual([...asset.body], [...bytes])

  // A reference no node uses is not a reader for the whole attachment store.
  const unreferenced = await request(host, { url: `/synapse/api/assets/sha256:${'d'.repeat(64)}` })
  assert.equal(unreferenced.status, 404)
})

test('refuses non-bitmap uploads and bodies over the image ceiling', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-apply-image-guards-'))
  const host = hostContext({ services: { attachments: attachmentStoreDouble() } })
  apply(host.ctx, { dataFile: join(directory, 'state.json') })

  const created = await request(host, { method: 'POST', url: '/synapse/api/workspaces', body: JSON.stringify({ title: '画布' }) })
  const workspaceId = created.json().workspace.id

  // SVG is script-capable on the origin every asset is served from.
  const svg = await request(host, {
    method: 'POST', url: `/synapse/api/workspaces/${workspaceId}/images`,
    headers: { 'content-type': 'image/svg+xml' },
    body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
  })
  assert.equal(svg.status, 415)

  const oversized = await request(host, {
    method: 'POST', url: `/synapse/api/workspaces/${workspaceId}/images`,
    headers: { 'content-type': 'image/png', 'content-length': String(9 * 1024 * 1024) },
    body: Buffer.from([0x89]),
  })
  assert.equal(oversized.status, 413)

  const empty = await request(host, {
    method: 'POST', url: `/synapse/api/workspaces/${workspaceId}/images`,
    headers: { 'content-type': 'image/png' },
  })
  assert.equal(empty.status, 400)

  // A typo'd workspace id must not leave an unreferenced object behind.
  const unknown = await request(host, {
    method: 'POST', url: '/synapse/api/workspaces/33333333-3333-4333-8333-333333333333/images',
    headers: { 'content-type': 'image/png', 'content-length': '1' },
    body: Buffer.from([0x89]),
  })
  assert.equal(unknown.status, 404)
})
