// Pure helpers and markup for the canvas annotation layer (notes / images /
// shapes / frames). The helper blocks are evaluated from app.js in a bare `vm`,
// exactly like conversation-cards.test.js does for app.js:606-956, so this file
// doubles as a guard that they never reach for document/state/Host globals.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')

const marker = (startText, endText) => {
  const start = source.indexOf(startText)
  const end = source.indexOf(endText)
  assert.ok(start > 0, `app.js declares the marker: ${startText}`)
  assert.ok(end > start, `app.js declares the marker: ${endText}`)
  return source.slice(start, end)
}

const pureSlice = marker('// --- canvas nodes: pure helpers', '// --- canvas nodes: pure helpers: end ---')
const renderSlice = marker('// --- canvas nodes: rendering', '// --- canvas nodes: rendering: end ---')

const exported = [
  'clampNodeCoordinate', 'clampNodeDimension', 'fitImageSize', 'fitImageDisplaySize',
  'assetUrlFor', 'isImageMediaType', 'normalizeNoteText', 'normalizeFrameTitle',
  'cardPositionKey', 'nodeBounds', 'boundsOfBoxes', 'groupBoundsOf',
  'mergeCardPositions', 'mergeWorkspaceNodes',
  'nextFrameTitle', 'collapsedFrameMembers', 'rectsIntersect', 'marqueeWorldRect',
  'marqueeSelection', 'normalizeShapeBox', 'defaultShapeGeometry', 'shapeMovePatch',
  'shapeEndpointPatch',
  // Review A/B regression surface: the two "unconfirmed" protocols and the
  // smaller hardening helpers.
  'appendPendingCardPosition', 'pendingCardPositionKeys', 'unconfirmedCardPositionKeys',
  'workspacePayloadNodes', 'wasOptimisticNodeDeleted', 'pastedPlainText', 'cardSyncKey',
  'toolbarToolOf',
]
const context = { CARD_WIDTH: 310, CARD_HEIGHT: 276 }
vm.createContext(context)
vm.runInContext(
  `${pureSlice}
globalThis.__nodes = { ${exported.map(name => `${name}: typeof ${name} === 'function' ? ${name} : undefined`).join(', ')} }`,
  context,
)
const helpers = context.__nodes
// Values returned from the vm realm carry that realm's Array/Object prototypes,
// so copy them into this realm before a strict deep comparison.
const plain = value => JSON.parse(JSON.stringify(value))

for (const name of exported) assert.equal(typeof helpers[name], 'function', `${name} is a pure helper`)

test('clamps node coordinates into the range the Host accepts', () => {
  assert.equal(helpers.clampNodeCoordinate(12.6), 13)
  assert.equal(helpers.clampNodeCoordinate(-99999), -2000)
  assert.equal(helpers.clampNodeCoordinate(99999), 5000)
  assert.equal(helpers.clampNodeCoordinate(Number.NaN), 0)
  assert.equal(helpers.clampNodeCoordinate('80'), 80)
})

test('enforces the 80x60 node floor', () => {
  assert.equal(helpers.clampNodeDimension(10, 80), 80)
  assert.equal(helpers.clampNodeDimension(-4, 60), 60)
  assert.equal(helpers.clampNodeDimension(240.4, 80), 240)
  assert.equal(helpers.clampNodeDimension(Number.NaN, 60), 60)
  // The default floor is the width minimum.
  assert.equal(helpers.clampNodeDimension(1), 80)
})

test('fits an image inside 1600px on the long edge without upscaling', () => {
  assert.deepEqual(plain(helpers.fitImageSize(3200, 1800)), { width: 1600, height: 900, scale: 0.5 })
  assert.deepEqual(plain(helpers.fitImageSize(1000, 4000)), { width: 400, height: 1600, scale: 0.4 })
  // Smaller than the limit: untouched, scale 1.
  assert.deepEqual(plain(helpers.fitImageSize(800, 600)), { width: 800, height: 600, scale: 1 })
  // A 1px edge survives rounding.
  assert.deepEqual(plain(helpers.fitImageSize(4000, 1)), { width: 1600, height: 1, scale: 0.4 })
})

test('sizes the image node box independently of the compression pass', () => {
  assert.deepEqual(plain(helpers.fitImageDisplaySize(1600, 900)), { width: 320, height: 180 })
  // Extreme aspects clamp each dimension to the node floor; object-fit: contain
  // letterboxes the bitmap so the pixels are never distorted.
  assert.deepEqual(plain(helpers.fitImageDisplaySize(40, 20)), { width: 80, height: 60 })
  assert.deepEqual(plain(helpers.fitImageDisplaySize(4000, 100)), { width: 320, height: 60 })
})

test('builds asset URLs only for Host attachment refs', () => {
  const attachmentId = `sha256:${'a'.repeat(64)}`
  assert.equal(helpers.assetUrlFor(attachmentId), `/synapse/api/assets/${attachmentId}`)
  assert.equal(helpers.assetUrlFor(''), '')
  assert.equal(helpers.assetUrlFor(null), '')
  assert.equal(helpers.assetUrlFor('sha256:short'), '')
  assert.equal(helpers.assetUrlFor('/etc/passwd'), '')
})

test('accepts bitmap media types only', () => {
  for (const mediaType of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'IMAGE/PNG']) {
    assert.equal(helpers.isImageMediaType(mediaType), true, mediaType)
  }
  for (const mediaType of ['image/svg+xml', 'text/html', '', null, undefined]) {
    assert.equal(helpers.isImageMediaType(mediaType), false, String(mediaType))
  }
})

test('caps note text at 4000 characters and keeps newlines', () => {
  assert.equal(helpers.normalizeNoteText('第一行\n第二行'), '第一行\n第二行')
  assert.equal(helpers.normalizeNoteText(null), '')
  assert.equal(helpers.normalizeNoteText(42), '42')
  assert.equal(helpers.normalizeNoteText('x'.repeat(5000)).length, 4000)
})

test('normalizes frame titles to a single 120-character line', () => {
  assert.equal(helpers.normalizeFrameTitle('  分组   一  '), '分组 一')
  assert.equal(helpers.normalizeFrameTitle(null), '')
  assert.equal(helpers.normalizeFrameTitle('长'.repeat(200)).length, 120)
})

test('derives the stable positionKey and never the mutable card id', () => {
  assert.equal(helpers.cardPositionKey({ positionKey: 'thread:turn-index:2', dshThreadId: 'thread', turnIndex: 9 }), 'thread:turn-index:2')
  assert.equal(helpers.cardPositionKey({ dshThreadId: 'thread', turnIndex: 3 }), 'thread:turn-index:3')
  // A card whose id came from a DSH seq still resolves to its turn index.
  assert.equal(helpers.cardPositionKey({ id: 'thread:turn:55', dshThreadId: 'thread', turnIndex: 3 }), 'thread:turn-index:3')
  assert.equal(helpers.cardPositionKey({ dshThreadId: 'thread' }), 'thread:turn-index:0')
  assert.equal(helpers.cardPositionKey(null), '')
  assert.equal(helpers.cardPositionKey({}), '')
})

test('computes a positive bounding box for every node type', () => {
  assert.deepEqual(plain(helpers.nodeBounds({ type: 'note', x: 10, y: 20, width: 100, height: 80 })), { x: 10, y: 20, width: 100, height: 80 })
  assert.deepEqual(plain(helpers.nodeBounds({ type: 'shape', shape: 'line', x1: 100, y1: 40, x2: 20, y2: 10 })), { x: 20, y: 10, width: 80, height: 30 })
  assert.deepEqual(plain(helpers.nodeBounds({ type: 'shape', shape: 'arrow', x1: 5, y1: 5, x2: 5, y2: 60 })), { x: 5, y: 5, width: 0, height: 55 })
  assert.deepEqual(plain(helpers.nodeBounds({ type: 'image', x: 0, y: 0 })), { x: 0, y: 0, width: 80, height: 60 })
  assert.equal(helpers.nodeBounds({ type: 'note', x: Number.NaN, y: 0 }), null)
  assert.equal(helpers.nodeBounds(null), null)
})

test('pads a frame around the union of card and node boxes', () => {
  const cards = [{ position: { x: 100, y: 100 } }, { position: { x: 400, y: 300 } }]
  const nodes = [{ type: 'note', x: 50, y: 20, width: 100, height: 60 }]
  // left 50, top 20, right 710, bottom 576 + padding 28 + header 34.
  assert.deepEqual(plain(helpers.groupBoundsOf(cards, nodes, 28, 34)), { x: 22, y: -42, width: 716, height: 646 })
  assert.equal(helpers.groupBoundsOf([], [], 28, 34), null)
  assert.equal(helpers.boundsOfBoxes([], 0, 0), null)
  assert.deepEqual(plain(helpers.boundsOfBoxes([{ x: 10, y: 10, width: 10, height: 10 }], 0, 0)), { x: 10, y: 10, width: 10, height: 10 })
})

test('lets the Host win when merging durable card positions', () => {
  const merged = plain(helpers.mergeCardPositions([
    ['thread:turn-index:0', { x: 1, y: 2 }],
    ['thread:turn:9', { x: 5, y: 6 }],
    ['broken', { x: Number.NaN, y: 1 }],
    ['not-a-pair'],
  ], {
    'thread:turn-index:0': { x: 10.4, y: 20.6 },
    'thread:turn-index:1': { x: 3, y: 4 },
    'nope': 'still-not-a-position',
  }))

  assert.deepEqual(merged, [
    ['thread:turn-index:0', { x: 10, y: 21 }],
    ['thread:turn:9', { x: 5, y: 6 }],
    ['thread:turn-index:1', { x: 3, y: 4 }],
  ])
  // Nothing valid on the Host side: the local cache is returned untouched.
  assert.deepEqual(plain(helpers.mergeCardPositions([['k', { x: 1, y: 1 }]], null)), [['k', { x: 1, y: 1 }]])
})

test('merges Host nodes without losing an optimistic create', () => {
  const merged = plain(helpers.mergeWorkspaceNodes(
    [{ id: 'tmp:1', type: 'note', text: 'local-only' }, { id: 'n1', type: 'note', text: 'stale' }],
    [{ id: 'n1', type: 'note', text: 'server' }, { id: 'n2', type: 'image' }, { id: '' }, { id: 'n1', type: 'note', text: 'duplicate' }],
  ))

  assert.deepEqual(merged.map(node => node.id), ['n1', 'n2', 'tmp:1'])
  assert.equal(merged[0].text, 'server')
  // A local node the Host already knows is replaced by the Host copy.
  assert.deepEqual(plain(helpers.mergeWorkspaceNodes([{ id: 'n1', text: 'local' }], [{ id: 'n1', text: 'server' }])), [{ id: 'n1', text: 'server' }])
  assert.deepEqual(plain(helpers.mergeWorkspaceNodes([], [])), [])
  // A node the user just deleted stays hidden until the Host acknowledges the
  // delete; both a Set-like and an array work (the Set is cross-realm in a vm).
  const incoming = [{ id: 'n1' }, { id: 'n2' }]
  assert.deepEqual(plain(helpers.mergeWorkspaceNodes([], [incoming[0]], ['n1'])), [])
  assert.deepEqual(plain(helpers.mergeWorkspaceNodes([], incoming, ['n2'])).map(node => node.id), ['n1'])
  assert.deepEqual(plain(helpers.mergeWorkspaceNodes([], incoming, new Set(['n1', 'n2']))), [])
})

test('numbers a new frame from the titles already on the canvas', () => {
  assert.equal(helpers.nextFrameTitle([]), '分组 1')
  assert.equal(helpers.nextFrameTitle([{ type: 'frame', title: '分组 1' }]), '分组 2')
  assert.equal(helpers.nextFrameTitle([{ type: 'frame', title: '分组 3' }, { type: 'note' }]), '分组 4')
  // A renamed frame does not consume a number.
  assert.equal(helpers.nextFrameTitle([{ type: 'frame', title: '调研' }, { type: 'frame', title: '分组 2' }]), '分组 3')
})

test('reports which cards and nodes a collapsed frame hides', () => {
  const hidden = helpers.collapsedFrameMembers([
    { id: 'f1', type: 'frame', collapsed: true, memberCards: ['t:turn-index:0', 't:turn-index:1'], memberNodes: ['n1'] },
    { id: 'f2', type: 'frame', collapsed: false, memberCards: ['t:turn-index:9'], memberNodes: ['n2'] },
    { id: 'n3', type: 'note' },
  ])

  assert.deepEqual([...hidden.cardKeys].sort(), ['t:turn-index:0', 't:turn-index:1'])
  assert.deepEqual([...hidden.nodeIds], ['n1'])
  const none = helpers.collapsedFrameMembers([{ type: 'frame', collapsed: false, memberCards: ['t:turn-index:0'] }])
  assert.equal(none.cardKeys.size, 0)
  assert.equal(none.nodeIds.size, 0)
})

test('detects rectangle overlap for the marquee', () => {
  const box = { x: 0, y: 0, width: 100, height: 100 }
  assert.equal(helpers.rectsIntersect(box, { x: 50, y: 50, width: 100, height: 100 }), true)
  assert.equal(helpers.rectsIntersect(box, { x: 100, y: 0, width: 10, height: 10 }), false)
  assert.equal(helpers.rectsIntersect(box, { x: -10, y: -10, width: 10, height: 10 }), false)
  assert.equal(helpers.rectsIntersect(box, null), false)
})

test('converts the marquee from screen space into world space', () => {
  // screen = world * zoom + camera → world = (screen - camera) / zoom
  assert.deepEqual(plain(helpers.marqueeWorldRect({ left: 100, top: 50, width: 200, height: 100 }, { x: 0, y: 0 }, 2)), {
    x: 50, y: 25, width: 100, height: 50,
  })
  // A rectangle dragged up/left normalizes before conversion.
  assert.deepEqual(plain(helpers.marqueeWorldRect({ left: 100, top: 50, width: -40, height: -20 }, { x: 10, y: 10 }, 1)), {
    x: 50, y: 20, width: 40, height: 20,
  })
  // Defensive defaults: zoom 0 behaves like 1.
  assert.deepEqual(plain(helpers.marqueeWorldRect({ left: 10, top: 10, width: 10, height: 10 }, null, 0)), {
    x: 10, y: 10, width: 10, height: 10,
  })
})

test('selects cards by positionKey and nodes by id inside the marquee', () => {
  const cards = [
    { id: 't:turn:5', positionKey: 't:turn-index:0', dshThreadId: 't', turnIndex: 0, position: { x: 0, y: 0 } },
    { id: 't:turn:6', positionKey: 't:turn-index:1', dshThreadId: 't', turnIndex: 1, position: { x: 1000, y: 0 } },
  ]
  const nodes = [
    { id: 'n1', type: 'note', x: 100, y: 100, width: 80, height: 60 },
    { id: 's1', type: 'shape', shape: 'line', x1: 400, y1: 400, x2: 500, y2: 500 },
  ]
  const hit = plain(helpers.marqueeSelection(cards, nodes, { x: 50, y: 50, width: 200, height: 200 }))
  assert.deepEqual(hit, { cardKeys: ['t:turn-index:0'], nodeIds: ['n1'] })
  // Nothing intersects an empty marquee.
  assert.deepEqual(plain(helpers.marqueeSelection(cards, nodes, null)), { cardKeys: [], nodeIds: [] })
})

test('normalizes a dragged shape box and applies the click default', () => {
  assert.deepEqual(plain(helpers.normalizeShapeBox({ x: 100, y: 100 }, { x: 40, y: 60 })), { x: 40, y: 60, width: 60, height: 40 })
  assert.deepEqual(plain(helpers.normalizeShapeBox({ x: 10, y: 10 }, { x: 10, y: 10 })), { x: 10, y: 10, width: 0, height: 0 })

  // Click without a drag: default sizes, still a valid Host payload.
  assert.deepEqual(plain(helpers.defaultShapeGeometry('rect', { x: 20, y: 30 })), { shape: 'rect', x: 20, y: 30, width: 180, height: 120 })
  assert.deepEqual(plain(helpers.defaultShapeGeometry('ellipse', { x: 20, y: 30 })).shape, 'ellipse')
  assert.deepEqual(plain(helpers.defaultShapeGeometry('arrow', { x: 20, y: 30 })), { shape: 'arrow', x1: 20, y1: 30, x2: 220, y2: 30 })
  assert.equal(plain(helpers.defaultShapeGeometry('line', { x: 0, y: 0 })).shape, 'line')
})

test('translates shapes and drags one endpoint', () => {
  // Boxed shapes move by x/y; lines move both ends together.
  assert.deepEqual(plain(helpers.shapeMovePatch({ type: 'shape', shape: 'rect', x: 10, y: 20 }, 5, -5)), { x: 15, y: 15 })
  assert.deepEqual(plain(helpers.shapeMovePatch({ type: 'shape', shape: 'arrow', x1: 0, y1: 0, x2: 100, y2: 50 }, 10, 20)), {
    x1: 10, y1: 20, x2: 110, y2: 70,
  })
  assert.deepEqual(plain(helpers.shapeEndpointPatch({ x1: 0, y1: 0 }, 'from', { x: -5, y: 7 })), { x1: -5, y1: 7 })
  assert.deepEqual(plain(helpers.shapeEndpointPatch({ x2: 0, y2: 0 }, 'to', { x: 9, y: 9 })), { x2: 9, y2: 9 })
  // Coordinates are clamped to the Host range.
  assert.deepEqual(plain(helpers.shapeEndpointPatch({}, 'to', { x: 99999, y: -99999 })), { x2: 5000, y2: -2000 })
})

// --- review A/B: the two unconfirmed-state protocols ------------------------

test('never lets a Host payload roll back an unconfirmed position', () => {
  const local = [['thread:turn-index:0', { x: 100, y: 100 }]]
  const host = { 'thread:turn-index:0': { x: 10, y: 10 }, 'thread:turn-index:1': { x: 20, y: 20 } }

  // Pending or in flight: the Host copy must not win for that key.
  assert.deepEqual(plain(helpers.mergeCardPositions(local, host, new Set(['thread:turn-index:0']))), [
    ['thread:turn-index:0', { x: 100, y: 100 }],
    ['thread:turn-index:1', { x: 20, y: 20 }],
  ])
  // Confirmed (no protection): the Host value is applied again.
  assert.deepEqual(plain(helpers.mergeCardPositions(local, host, [])), [
    ['thread:turn-index:0', { x: 10, y: 10 }],
    ['thread:turn-index:1', { x: 20, y: 20 }],
  ])
})

test('buckets pending positions per workspace and unions them with in-flight keys', () => {
  const pending = {}
  helpers.appendPendingCardPosition(pending, 'ws-a', 't:turn-index:0', { x: 1.4, y: 2.6 })
  helpers.appendPendingCardPosition(pending, 'ws-b', 't:turn-index:0', { x: 9, y: 9 })
  helpers.appendPendingCardPosition(pending, 'ws-a', '', { x: 1, y: 1 })
  helpers.appendPendingCardPosition(pending, 'ws-a', 't:turn-index:1', { x: Number.NaN, y: 1 })

  assert.deepEqual(plain(helpers.pendingCardPositionKeys(pending, 'ws-a')), ['t:turn-index:0'])
  assert.deepEqual(plain(helpers.pendingCardPositionKeys(pending, 'ws-b')), ['t:turn-index:0'])
  assert.deepEqual(plain(pending['ws-a']), { 't:turn-index:0': { x: 1, y: 3 } })
  // The same positionKey carries different values in each workspace bucket: a
  // switch inside the debounce window can never write A's drag into B.
  assert.notEqual(pending['ws-a']['t:turn-index:0'].x, pending['ws-b']['t:turn-index:0'].x)

  const inFlight = new Map([['ws-a', new Set(['t:turn-index:7'])]])
  assert.deepEqual([...helpers.unconfirmedCardPositionKeys(pending, inFlight, 'ws-a')].sort(), ['t:turn-index:0', 't:turn-index:7'])
  assert.deepEqual([...helpers.unconfirmedCardPositionKeys(pending, inFlight, 'ws-b')], ['t:turn-index:0'])
  assert.deepEqual([...helpers.unconfirmedCardPositionKeys({}, inFlight, 'ws-c')], [])
  // The client keeps reference counts per key; any positive count still protects.
  const counted = new Map([['ws-a', new Map([['t:turn-index:8', 2]])]])
  assert.deepEqual([...helpers.unconfirmedCardPositionKeys({}, counted, 'ws-a')], ['t:turn-index:8'])
})

test('keeps the local node version while its PATCH is unconfirmed', () => {
  const local = [{ id: 'n1', type: 'note', text: '刚才写的字' }, { id: 'tmp:9', type: 'note', text: 'new' }]
  const host = [{ id: 'n1', type: 'note', text: '旧快照' }, { id: 'n2', type: 'note', text: 'other' }]

  const merged = plain(helpers.mergeWorkspaceNodes(local, host, null, new Set(['n1'])))
  assert.deepEqual(merged.map(node => node.id), ['n1', 'n2', 'tmp:9'])
  assert.equal(merged[0].text, '刚才写的字')
  assert.equal(merged[1].text, 'other')
  // Once confirmed the Host copy wins again.
  assert.equal(plain(helpers.mergeWorkspaceNodes(local, host, null, []))[0].text, '旧快照')
  // pendingNodeDeletes still filters a deleted id, and a dirty+excluded id is gone.
  assert.deepEqual(plain(helpers.mergeWorkspaceNodes(local, host, ['n1'], new Set(['n1']))).map(node => node.id), ['n2', 'tmp:9'])
})

test('treats a workspace payload without nodes as "keep the canvas"', () => {
  assert.deepEqual(plain(helpers.workspacePayloadNodes({ id: 'w', nodes: [] })), [])
  assert.deepEqual(plain(helpers.workspacePayloadNodes({ id: 'w', nodes: [{ id: 'n1' }] })), [{ id: 'n1' }])
  // A failed record load has no nodes field: the caller keeps the current canvas.
  assert.equal(helpers.workspacePayloadNodes({ id: 'w' }), null)
  assert.equal(helpers.workspacePayloadNodes(null), null)
  assert.equal(helpers.workspacePayloadNodes({ id: 'w', nodes: 'nope' }), null)
})

test('recognises a note deleted while its create was in flight', () => {
  assert.equal(helpers.wasOptimisticNodeDeleted('tmp:1', new Set(['tmp:1'])), true)
  assert.equal(helpers.wasOptimisticNodeDeleted('tmp:1', new Set()), false)
  assert.equal(helpers.wasOptimisticNodeDeleted('tmp:1', null), false)
  assert.equal(helpers.wasOptimisticNodeDeleted('', new Set([''])), false)
})

test('reads only the plain-text flavour of a paste', () => {
  const clipboard = {
    getData: type => (type === 'text/plain' ? '<b>纯文本</b>\n第二行' : '<img src="https://evil.example/x.png">'),
  }
  // Whatever text/html says, only text/plain is returned; the caller inserts it as
  // a text node, so markup and remote images can never be parsed.
  assert.equal(helpers.pastedPlainText(clipboard), '<b>纯文本</b>\n第二行')
  assert.equal(helpers.pastedPlainText({ getData: () => null }), '')
  assert.equal(helpers.pastedPlainText({ getData: () => { throw new Error('denied') } }), '')
  assert.equal(helpers.pastedPlainText(null), '')
})

test('syncs card positions only under a durable positionKey', () => {
  assert.equal(helpers.cardSyncKey(['t:turn-index:2']), 't:turn-index:2')
  assert.equal(helpers.cardSyncKey(['t:turn-index:2', 't:turn:9']), 't:turn-index:2')
  // No positionKey → nothing is queued (a card id is not a durable Host key).
  assert.equal(helpers.cardSyncKey([]), '')
  assert.equal(helpers.cardSyncKey(['']), '')
  assert.equal(helpers.cardSyncKey(undefined), '')
})

test('maps toolbar actions to the canvas tool they activate', () => {
  assert.equal(helpers.toolbarToolOf('add-note'), 'note')
  assert.equal(helpers.toolbarToolOf('select-tool'), 'select')
  assert.equal(helpers.toolbarToolOf('draw-arrow'), 'arrow')
  assert.equal(helpers.toolbarToolOf('draw-rect'), 'rect')
  assert.equal(helpers.toolbarToolOf('draw-ellipse'), 'ellipse')
  for (const action of ['layout', 'group-selection', 'toggle-frame', 'add-image', '', null]) {
    assert.equal(helpers.toolbarToolOf(action), '', String(action))
  }
})

// --- review A/B: the position protocol, executed rather than pattern-matched --
const protocolSlice = source.slice(
  source.indexOf('function markCardPositionsInFlight'),
  source.indexOf('/** Debounce one `PATCH'),
)

/** Load the in-flight/retry/flush functions with stubbed api + setError. */
function makeProtocol({ failFirst = 0 } = {}) {
  const calls = []
  const errors = []
  let failures = failFirst
  const context = {
    state: { inFlightCardPositionKeys: new Map() },
    setError: message => { errors.push(message) },
    api: async (path, options) => {
      calls.push({ path, body: JSON.parse(options.body) })
      if (failures > 0) {
        failures -= 1
        throw new Error('HTTP 500')
      }
      return { workspace: {} }
    },
  }
  vm.createContext(context)
  vm.runInContext(
    `let cardPositionSyncPending = {}
${protocolSlice}
globalThis.__protocol = { markCardPositionsInFlight, settleInFlightCardPositions, sendCardPositions, flushCardPositionSync, setPending: value => { cardPositionSyncPending = value } }`,
    context,
  )
  return { protocol: context.__protocol, state: context.state, calls, errors }
}

test('keeps a failed position PATCH unconfirmed after one retry', async () => {
  const { protocol, state, calls, errors } = makeProtocol({ failFirst: 2 })
  protocol.markCardPositionsInFlight('ws-a', ['t:turn-index:0'])
  await protocol.sendCardPositions('ws-a', { 't:turn-index:0': { x: 1, y: 2 } }, ['t:turn-index:0'], 0)

  assert.equal(calls.length, 2)  // exactly one retry
  assert.equal(errors.length, 1) // reported once
  // The key stays protected so the next Host snapshot cannot roll it back.
  assert.equal(state.inFlightCardPositionKeys.get('ws-a').get('t:turn-index:0') >= 1, true)
})

test('retires the in-flight mark once the retry succeeds', async () => {
  const { protocol, state, calls, errors } = makeProtocol({ failFirst: 1 })
  protocol.markCardPositionsInFlight('ws-a', ['t:turn-index:0'])
  await protocol.sendCardPositions('ws-a', { 't:turn-index:0': { x: 1, y: 2 } }, ['t:turn-index:0'], 0)

  assert.equal(calls.length, 2)
  assert.equal(errors.length, 0)
  assert.equal(state.inFlightCardPositionKeys.has('ws-a'), false)
})

test('flushes each workspace bucket to its own workspace', async () => {
  const { protocol, calls } = makeProtocol()
  protocol.setPending({
    'ws-a': { 't:turn-index:0': { x: 1, y: 2 } },
    'ws-b': { 't:turn-index:0': { x: 9, y: 9 } },
  })
  protocol.flushCardPositionSync()
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(calls.length, 2)
  const byWorkspace = new Map(calls.map(call => [decodeURIComponent(call.path.split('/').at(-1)), call.body.cardPositions]))
  assert.deepEqual(plain(byWorkspace.get('ws-a')), { 't:turn-index:0': { x: 1, y: 2 } })
  assert.deepEqual(plain(byWorkspace.get('ws-b')), { 't:turn-index:0': { x: 9, y: 9 } })
})

// --- markup contract (.recon/contract.md §3) -------------------------------
const renderContext = {
  CARD_WIDTH: 310,
  CARD_HEIGHT: 276,
  escapeHtml: value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])),
  state: { nodes: new Map(), selectedNodeIds: new Set() },
}
vm.createContext(renderContext)
vm.runInContext(
  `${pureSlice}
${renderSlice}
globalThis.__markup = { canvasNoteHtml, canvasImageHtml, canvasShapeHtml, notesLayerHtml, shapesLayerHtml, frameNodeHtml, frameNodesHtml }`,
  renderContext,
)
const markup = renderContext.__markup
const setNodes = (nodes, selected = []) => {
  renderContext.state.nodes = new Map(nodes.map(node => [node.id, node]))
  renderContext.state.selectedNodeIds = new Set(selected)
}
const attachmentId = `sha256:${'b'.repeat(64)}`

test('renders a note with the contract classes, keys and inline box', () => {
  setNodes([])
  const html = markup.canvasNoteHtml({ id: 'n1', type: 'note', x: 12.4, y: -8, width: 240, height: 150, z: 3, text: '第一行\n<b>粗</b>' })

  assert.match(html, /class="canvas-note"/)
  assert.match(html, /data-node-id="n1"/)
  assert.match(html, /data-morph-key="note:n1"/)
  assert.match(html, /style="left:12px;top:-8px;width:240px;height:150px;z-index:3"/)
  // The body is the editable surface, and the text is escaped, newlines kept.
  assert.match(html, /<div class="canvas-note-body" contenteditable="true" spellcheck="false"/)
  assert.match(html, /第一行<br>&lt;b&gt;粗&lt;\/b&gt;/)
  assert.match(html, /<button class="canvas-node-remove" type="button" data-action="delete-node" data-node="n1"/)
  // A selected node carries the shared `.selected` class.
  setNodes([], ['n1'])
  assert.match(markup.canvasNoteHtml({ id: 'n1', type: 'note', x: 0, y: 0, width: 240, height: 150, text: '' }), /class="canvas-note selected"/)
})

test('renders an image node that only points at the Host asset route', () => {
  setNodes([])
  const html = markup.canvasImageHtml({ id: 'i1', type: 'image', x: 0, y: 0, width: 320, height: 180, z: 2, image: { attachmentId } })

  assert.match(html, /class="canvas-image"/)
  assert.match(html, /data-morph-key="image:i1"/)
  assert.match(html, new RegExp(`<img class="canvas-image-img" src="/synapse/api/assets/${attachmentId}" alt="" draggable="false">`))
  assert.match(html, /data-action="delete-node" data-node="i1"/)
  // An unusable ref renders a placeholder instead of an arbitrary URL.
  const broken = markup.canvasImageHtml({ id: 'i2', type: 'image', x: 0, y: 0, width: 320, height: 180, image: { attachmentId: '/etc/passwd' } })
  assert.match(broken, /class="canvas-image-missing"/)
  assert.doesNotMatch(broken, /src=/)
})

test('renders line/arrow, rect and ellipse shapes with a hit area', () => {
  setNodes([])
  const line = markup.canvasShapeHtml({ id: 's1', type: 'shape', shape: 'arrow', x1: 100, y1: 40, x2: 20, y2: 10, stroke: '#3d4d63', strokeWidth: 2 })
  assert.match(line, /data-morph-key="shape:s1"/)
  assert.match(line, /<line class="canvas-shape-visible" data-shape-type="arrow" x1="100" y1="40" x2="20" y2="10"/)
  assert.match(line, /<line class="canvas-shape-hit"/)
  assert.doesNotMatch(line, /NaN|undefined/)

  const rect = markup.canvasShapeHtml({ id: 's2', type: 'shape', shape: 'rect', x: 10, y: 20, width: 180, height: 120 })
  assert.match(rect, /<rect class="canvas-shape-visible" x="10" y="20" width="180" height="120"/)
  const ellipse = markup.canvasShapeHtml({ id: 's3', type: 'shape', shape: 'ellipse', x: 10, y: 20, width: 180, height: 120 })
  assert.match(ellipse, /<ellipse class="canvas-shape-visible" cx="100" cy="80" rx="90" ry="60"/)
})

test('gives arrows a stable marker and shows endpoint handles only when selected', () => {
  setNodes([])
  const arrow = markup.canvasShapeHtml({ id: 'a1', type: 'shape', shape: 'arrow', x1: 0, y1: 0, x2: 100, y2: 0 })
  assert.match(arrow, /marker-end="url\(#synapse-arrow-head\)"/)
  assert.doesNotMatch(arrow, /data-shape-handle/)

  // A line has no arrowhead but gains the same draggable ends once selected.
  const line = markup.canvasShapeHtml({ id: 'l1', type: 'shape', shape: 'line', x1: 0, y1: 0, x2: 100, y2: 0 })
  assert.doesNotMatch(line, /marker-end/)
  assert.doesNotMatch(line, /data-shape-handle/)

  setNodes([], ['a1', 'l1'])
  const selectedArrow = markup.canvasShapeHtml({ id: 'a1', type: 'shape', shape: 'arrow', x1: 0, y1: 0, x2: 100, y2: 0 })
  assert.match(selectedArrow, /class="canvas-shape selected"/)
  assert.match(selectedArrow, /<circle class="canvas-shape-handle" data-shape-handle="from" cx="0" cy="0"/)
  assert.match(selectedArrow, /<circle class="canvas-shape-handle" data-shape-handle="to" cx="100" cy="0"/)
})

test('renders a frame as the header-only box, expanded and collapsed', () => {
  setNodes([])
  const expanded = markup.frameNodeHtml({
    id: 'f1', type: 'frame', x: 40, y: 50, width: 700, height: 500, title: '分组 1',
    collapsed: false, memberCards: ['t:turn-index:0', 't:turn-index:1'], memberNodes: ['n1'],
  })
  assert.match(expanded, /class="canvas-frame"/)
  assert.match(expanded, /data-frame-id="f1"/)
  assert.match(expanded, /data-morph-key="frame:f1"/)
  assert.match(expanded, /style="left:40px;top:50px;width:700px;height:500px;pointer-events:none"/)
  // The header is the drag surface and carries the only interactive controls.
  assert.match(expanded, /<header class="canvas-frame-head" data-frame-drag="f1" style="pointer-events:auto"/)
  assert.match(expanded, /<span class="canvas-frame-title"[^>]*>分组 1<\/span>/)
  assert.match(expanded, /<span class="canvas-frame-count"[^>]*>2<\/span>/)
  assert.match(expanded, /data-action="toggle-frame" data-frame="f1" aria-expanded="true"/)
  assert.match(expanded, /data-action="delete-node" data-node="f1"/)

  // Collapsed: the class lets styles.css pin the height to the 34px header.
  const collapsed = markup.frameNodeHtml({
    id: 'f1', type: 'frame', x: 40, y: 50, width: 700, height: 500, title: '分组 1',
    collapsed: true, memberCards: ['t:turn-index:0'], memberNodes: [],
  })
  assert.match(collapsed, /class="canvas-frame collapsed"/)
  assert.match(collapsed, /height:34px/)
  assert.match(collapsed, /aria-expanded="false"/)
  // The count keeps reporting the members that are hidden.
  assert.match(collapsed, /<span class="canvas-frame-count"[^>]*>1<\/span>/)

  // A missing title falls back to the Host default label.
  const untitled = markup.frameNodeHtml({ id: 'f2', type: 'frame', x: 0, y: 0, width: 200, height: 100, title: '  ', memberCards: [] })
  assert.match(untitled, />分组<\/span>/)
})

test('renders frames first and filters the ones hidden by a collapsed frame', () => {
  setNodes([
    { id: 'f1', type: 'frame', x: 0, y: 0, width: 300, height: 200, title: '分组 1', memberCards: [] },
    { id: 'f2', type: 'frame', x: 0, y: 0, width: 300, height: 200, title: '分组 2', memberCards: [] },
    { id: 'n1', type: 'note', text: '', x: 0, y: 0, width: 240, height: 150 },
  ])
  const frames = markup.frameNodesHtml()
  assert.equal((frames.match(/data-frame-id="/g) ?? []).length, 2)
  assert.doesNotMatch(frames, /canvas-note/)
  const filtered = markup.frameNodesHtml(new Set(['f2']))
  assert.match(filtered, /data-frame-id="f1"/)
  assert.doesNotMatch(filtered, /data-frame-id="f2"/)
  // Notes/shapes honour the same hidden-id set.
  assert.doesNotMatch(markup.notesLayerHtml(new Set(['n1'])), /canvas-note/)
  assert.match(markup.notesLayerHtml(), /canvas-note/)
})

test('splits notes, images and shapes across their two layers', () => {
  setNodes([
    { id: 'n1', type: 'note', text: '便签', x: 0, y: 0, width: 240, height: 150 },
    { id: 'i1', type: 'image', x: 0, y: 0, width: 320, height: 180, image: { attachmentId } },
    { id: 's1', type: 'shape', shape: 'rect', x: 0, y: 0, width: 180, height: 120 },
  ])
  const notes = markup.notesLayerHtml()
  assert.ok(notes.indexOf('canvas-note') < notes.indexOf('canvas-image'), 'notes paint before images')
  assert.doesNotMatch(notes, /canvas-shape/)
  const shapes = markup.shapesLayerHtml()
  assert.match(shapes, /canvas-shape/)
  assert.doesNotMatch(shapes, /canvas-note|canvas-image/)
  setNodes([{ id: 'n1', type: 'note', text: '', x: 0, y: 0, width: 240, height: 150 }])
  assert.equal(markup.shapesLayerHtml(), '')
})

test('declares the annotation layers after the cards layer inside the canvas', () => {
  const canvas = source.slice(source.indexOf('function renderCanvas'), source.indexOf('function isProcessMessage'))
  const cards = canvas.indexOf('data-morph-key="cards"')
  const notes = canvas.indexOf('data-morph-key="canvas-notes"')
  const shapes = canvas.indexOf('data-morph-key="canvas-shapes"')

  assert.match(canvas, /data-morph-key="canvas-content"/)
  assert.ok(cards > 0 && notes > cards, 'the notes layer follows the cards layer')
  assert.ok(shapes > notes, 'the shapes layer follows the notes layer')
  // `.canvas-content` keeps the single camera transform (canvas-runtime asserts the text as well).
  assert.match(canvas, /transform:translate\(\$\{state\.canvasCamera\.x\}px, \$\{state\.canvasCamera\.y\}px\) scale\(\$\{state\.zoom\}\)/)
})

test('keeps annotation nodes out of the pan gesture', () => {
  const guardStart = source.indexOf("app.addEventListener('pointerdown'")
  const guardEnd = source.indexOf("if (state.canvasTool === 'note')")
  assert.ok(guardStart > 0 && guardEnd > guardStart)
  const guard = source.slice(guardStart, guardEnd)
  for (const selector of ['.canvas-note', '.canvas-image', '.canvas-shape', '.canvas-frame', '[contenteditable="true"]']) {
    assert.ok(guard.includes(selector), `the pan guard excludes ${selector}`)
  }
  // The note tool only intercepts the empty canvas, after the guard.
  const noteTool = source.indexOf("if (state.canvasTool === 'note')")
  const create = source.indexOf('createNoteFromPointer(viewport, event)')
  assert.ok(noteTool > 0 && create > noteTool, 'the note tool acts after the pan guard')
})

// --- Phase B wiring: shapes, frames, marquee, multi-select ------------------

test('paints frames first inside the cards layer and defines the arrow marker', () => {
  const canvas = source.slice(source.indexOf('function renderCanvas'), source.indexOf('function isProcessMessage'))
  const cardsStart = canvas.indexOf('data-morph-key="cards"')
  const frameCall = canvas.indexOf('frameNodesHtml(')
  const firstCard = canvas.indexOf('conversationCard(', cardsStart)

  assert.ok(cardsStart > 0, 'the cards layer is declared')
  assert.ok(frameCall > cardsStart, 'frames are emitted by the cards layer')
  assert.ok(firstCard > frameCall, 'frames come before the cards (painted underneath)')
  assert.match(canvas, /data-morph-key="canvas-shapes"><defs><marker id="\$\{ARROW_MARKER_ID\}"/)
  assert.match(canvas, /refX="8" refY="5"[\s\S]{0,80}orient="auto-start-reverse"/)
  assert.match(canvas, /notesLayerHtml\(frameHidden\.nodeIds\)/)
  assert.match(canvas, /shapesLayerHtml\(frameHidden\.nodeIds\)/)
})

test('offers every Phase B tool in the toolbar and wires the actions', () => {
  for (const action of ['draw-arrow', 'draw-rect', 'draw-ellipse', 'select-tool', 'group-selection', 'toggle-frame']) {
    assert.ok(source.includes(`data-action="${action}"`), `the toolbar/actions declare ${action}`)
  }
  assert.match(source, /aria-pressed="\$\{state\.canvasTool === 'arrow'\}"/)
  assert.match(source, /button\.dataset\.action\.slice\(5\)/)
  assert.match(source, /void groupSelection\(\)/)
  assert.match(source, /await toggleFrameCollapse\(button\.dataset\.frame\)|void toggleFrameCollapse\(button\.dataset\.frame\)/)
})

test('keeps the pan tool as the default gesture and routes the others after the guard', () => {
  const panStart = source.indexOf("app.addEventListener('pointerdown', event => {")
  const panEnd = source.indexOf('state.canvasGesture = true', panStart)
  assert.ok(panStart > 0 && panEnd > panStart)
  const branch = source.slice(panStart, panEnd)
  const marquee = branch.indexOf('startMarqueeGesture(viewport, event)')
  const draw = branch.indexOf('startShapeDraw(viewport, event, state.canvasTool)')
  assert.ok(marquee > 0, 'the select tool starts a marquee')
  assert.ok(draw > marquee, 'draw tools start a shape after the marquee branch')
  // All tool branches sit before the pan gesture flags, so pan stays the default.
  assert.ok(branch.indexOf("state.canvasTool === 'note'") < marquee)
  assert.ok(branch.indexOf("state.canvasTool === 'select'") < marquee)
})

test('multi-selects cards by positionKey and clears selection on Esc', () => {
  const card = source.slice(source.indexOf('function conversationCard(card, graph)'), source.indexOf('function draftActions'))
  assert.match(card, /state\.selectedCardKeys\.has\(cardPositionKey\(card\)\)/)
  assert.match(source, /state\.selectedCardKeys\.add\(cardKey\)/)
  assert.match(source, /if \(event\.shiftKey \|\| event\.ctrlKey \|\| event\.metaKey\) \{[\s\S]{0,600}card\.classList\.toggle\('selected'/)
  const keydown = source.slice(source.indexOf('document.addEventListener(\'keydown\', event => {'), source.indexOf("document.addEventListener('paste'"))
  assert.match(keydown, /clearCanvasSelection\(\)/)
  assert.match(keydown, /void groupSelection\(\)/)
  // Delete only removes annotation nodes, never cards.
  assert.match(keydown, /void deleteCanvasNode\(nodeId\)/)
})

test('wires frames into the drag lifecycle and the host payload', () => {
  const drag = source.slice(source.indexOf('function bindDragHandle'), source.indexOf('function installDragging'))
  assert.match(drag, /detachCardFromFrame\(aliases\[0\]\)/)
  assert.match(source, /async function groupSelection\(/)
  assert.match(source, /type: 'frame'/)
  assert.match(source, /memberCards: cardKeys/)
  assert.match(source, /memberNodes,/)
  assert.match(source, /patchHostNode\(frameId, \{ collapsed: collapsing \}\)/)
  assert.match(source, /function revealFramesForThread\(threadId\)/)
  // focusActiveCard expands the group instead of focusing a hidden card.
  const focus = source.slice(source.indexOf('function focusActiveCard'), source.indexOf('let selectionFollowup = null'))
  assert.match(focus, /revealFramesForThread\(state\.activeId\)/)
})

test('renders the canvas when a workspace has annotations but no threads', () => {
  const canvas = source.slice(source.indexOf('function renderCanvas'), source.indexOf('function isProcessMessage'))
  assert.match(canvas, /threads\.length === 0 && state\.draft\?\.kind !== 'new' && state\.nodes\.size === 0/)
  // The toolbar shows for annotation-only workspaces too, otherwise nothing could be drawn.
  assert.match(source, /threads\.length > 0 \|\| state\.draft\?\.kind === 'new' \|\| state\.nodes\.size > 0/)
})

// --- review A/B wiring: unconfirmed protocols, failures and small hardening --

test('marks position keys in flight and protects them from Host snapshots', () => {
  assert.match(source, /inFlightCardPositionKeys/)
  assert.match(source, /markCardPositionsInFlight\(workspaceId, positionKeys\)/)
  // Reference-counted marks: overlapping flushes cannot retire each other.
  assert.match(source, /counts\.set\(key, \(counts\.get\(key\) \?\? 0\) \+ 1\)/)
  assert.match(source, /function settleInFlightCardPositions\(workspaceId, positionKeys, succeeded\)/)
  assert.match(source, /settleInFlightCardPositions\(workspaceId, positionKeys, false\)/)
  assert.match(source, /unconfirmedCardPositionKeys\(cardPositionSyncPending, state\.inFlightCardPositionKeys, workspaceId\)/)
  assert.match(source, /mergeCardPositions\(\[\.\.\.state\.cardPositions\], record, unconfirmed\)/)
  // Failure retries exactly once, then surfaces the error and keeps the marks.
  assert.match(source, /if \(attempt === 0\) \{[\s\S]{0,160}sendCardPositions\(workspaceId, positions, positionKeys, 1\)/)
  assert.match(source, /setError\(`布局保存失败/)
})

test('flushes pending positions per workspace bucket', () => {
  assert.match(source, /let cardPositionSyncPending = \{\}/)
  assert.match(source, /appendPendingCardPosition\(cardPositionSyncPending, workspaceId, positionKey, position\)/)
  assert.match(source, /for \(const \[workspaceId, positions\] of Object\.entries\(buckets\)\)/)
  assert.match(source, /sendCardPositions\(workspaceId, positions, positionKeys, 0\)/)
})

test('keeps dirty nodes local until their last PATCH succeeds', () => {
  assert.match(source, /dirtyNodeIds: new Set\(\)/)
  const patch = source.slice(source.indexOf('async function patchHostNode'), source.indexOf('function createNoteFromPointer'))
  assert.match(patch, /state\.dirtyNodeIds\.add\(id\)/)
  assert.match(patch, /settleNodePatch\(id, true\)/)
  assert.match(patch, /settleNodePatch\(id, false\)/)
  assert.match(source, /mergeWorkspaceNodes\(\[\.\.\.state\.nodes\.values\(\)\], Array\.isArray\(nodes\) \? nodes : \[\], state\.pendingNodeDeletes, state\.dirtyNodeIds\)/)
  // A delete settles the node immediately instead of leaving it dirty.
  assert.match(source, /state\.dirtyNodeIds\.delete\(nodeId\)/)
  // The protocol must not degrade optimistic creates / pending deletes.
  assert.match(source, /state\.pendingNodeDeletes\.clear\(\)/)
  assert.match(source, /node\.id\.startsWith\('tmp:'\)/)
})

test('persists collapsed-frame members when 整理 resets the layout', () => {
  const sync = source.slice(source.indexOf('function syncAllCardPositionsToHost'), source.indexOf('function applyWorkspaceNodes'))
  assert.match(sync, /projectedCardsByKey\(\)\.values\(\)/)
  assert.doesNotMatch(sync, /const cards = state\.canvasCards \?\? \[\]/)
})

test('deletes the Host node created for an optimistic note that was removed', () => {
  const replace = source.slice(source.indexOf('function replaceOptimisticNode'), source.indexOf('function commitNoteText'))
  assert.match(replace, /wasOptimisticNodeDeleted\(tempId, state\.deletedTempIds\)/)
  assert.match(replace, /deleteHostNode\(created\.id\)/)
  assert.match(source, /state\.deletedTempIds\.add\(nodeId\)/)
  assert.match(source, /state\.deletedTempIds\.clear\(\)/)
})

test('never blanks the canvas when the workspace record fails to load', () => {
  const open = source.slice(source.indexOf('async function openDshWorkspace'), source.indexOf('async function openCurrentWorkspace'))
  assert.doesNotMatch(open, /nodes: record\?\.workspace\?\.nodes \?\? \[\]/)
  assert.match(open, /Array\.isArray\(recordNodes\) \? \{ nodes: recordNodes \} : \{\}/)
  const apply = source.slice(source.indexOf('function applyHostWorkspaceData'), source.indexOf('function resetCardPositions'))
  assert.match(apply, /workspacePayloadNodes\(workspace\)/)
  assert.match(apply, /if \(payloadNodes !== null\) \{/)
  // Only an actual payload of the new workspace replaces the collection.
  assert.match(apply, /if \(switching\) state\.nodes = new Map\(\)/)
})

test('intercepts note pastes and inserts plain text only', () => {
  const paste = source.slice(source.indexOf('async function handleCanvasPaste'), source.indexOf('// --- canvas shapes, frames and multi-select'))
  assert.match(paste, /noteBody instanceof HTMLElement/)
  assert.match(paste, /event\.preventDefault\(\)[\s\S]{0,220}pastedPlainText\(event\.clipboardData\)/)
  assert.match(source, /function insertPlainText\(/)
  assert.match(source, /document\.execCommand\('insertText', false, text\)/)
  assert.match(source, /document\.createTextNode\(text\)/)
  // The note body is never written through innerHTML.
  assert.doesNotMatch(source, /noteBody\.innerHTML/)
})

test('queues positions only from the durable alias', () => {
  const remember = source.slice(source.indexOf('function rememberCardPosition'), source.indexOf('/** The Host address of the workspace'))
  assert.match(remember, /const positionKey = cardSyncKey\(aliases\)/)
  assert.match(remember, /if \(positionKey !== ''\) queueCardPositionSync\(positionKey/)
  assert.doesNotMatch(remember, /: cardId,/)
})

test('keeps the toolbar in step when a draw gesture starts', () => {
  assert.match(source, /function syncToolButtons\(/)
  assert.match(source, /toolbarToolOf\(button\.dataset\.action\)/)
  const draw = source.slice(source.indexOf('function startShapeDraw'), source.indexOf('function startMarqueeGesture'))
  assert.match(draw, /state\.canvasTool = 'pan'[\s\S]{0,220}syncToolButtons\(\)/)
})
