# Architecture and runtime boundaries

## Purpose

`dsh-synapse` is a presentation and organization layer for DeepSeek Harness conversations. It turns existing DSH sessions, turns, and forks into a visual map without replacing the systems that own those conversations.

## Profile integration

The package contributes `cordis.patch.yml`, which inserts the `dsh-synapse` service into whichever DSH profile lists the package as a bundle — `desktop` for the desktop app, `web` for the `dsh web` command. It reuses the existing DSH Web server and client runtime.

The plugin:

- does not start a second HTTP server;
- does not create a second model or agent runtime;
- does not replace DSH authentication or permission checks;
- stays inert in a profile that does not list it, so installing it into the wrong profile only means the map never appears (see the installation table in the user guide).

## Conversation ownership

DSH session logs remain the source of truth for conversation content and lifecycle. Native DSH operations own:

- creating and opening sessions;
- sending follow-up messages;
- forking sessions;
- archiving sessions;
- model and tool execution;
- permission and approval decisions.

Synapse projects committed DSH events into cards and sends user actions back through the native DSH session bridge.

## Harness compatibility

This revision is built and verified against DeepSeek Harness `0.1.7-rc.2`. Both halves call Harness APIs directly, so a Harness release that changes them requires a matching plugin release.

Host half (`index.js`) calls:

- `ctx.webServer.register({ kind, path, handler })`, the route registry of `@deepseek-ai/dsh-host-webserver`;
- `ctx.sessions.list()`, the live `Session` objects of `@deepseek-ai/dsh-session`;
- the untagged (global) `session/created` and `session/event` listeners;
- `session.snapshotEvents()` for a projection replay, `session.inheritedEventCount` for the durable fork cut, and `session.header.cwd` for workspace grouping.

Client half (`client.js`), through `dsh.client.inject` in `package.json`:

- `sessions.list`, `sessions.binding`, `sessions.create`, `sessions.fork` from `@deepseek-ai/dsh-api-session-controller`, plus `sessions.retain`/`release` for two purposes: owning a reference across a prompt round-trip, and owning one for every *running* Session whose live reply the map mirrors, because no Harness release mints a Session scope implicitly any more and an unowned Session has no readable Chat view;
- `workspaces.list` from `@deepseek-ai/dsh-api-workspace-controller`;
- `uiWorkspace.openSession` from `@deepseek-ai/dsh-client-ui-workspace` for selecting a Session;
- `uiConversation.binding(sessionId).target('chat')` from `@deepseek-ai/dsh-client-ui-conversation` for the streaming reply and the turn anchor index, because the Client builds a view snapshot only after something subscribes to its target. A Session the browser does not observe still reports its `running` flag, which the list row carries.

Two Harness dependencies are worth re-checking on every upgrade:

- `snapshotEvents()` is marked deprecated: Harness is moving complete session logs out of memory. Rebuilding this canvas from history needs the full sequence, so the call remains, and it needs a storage-backed successor (an asynchronous paged read) before Harness removes it.
- The browser half must acquire its own `SessionReference` before sending a prompt; borrowing an Agent scope no longer opens one.

## Canvas metadata

By default, Synapse stores canvas metadata at:

```text
$DSH_HOME/synapse/workspaces.json
```

The file contains organizational state such as workspace mapping, card layout, annotation nodes, and fork anchors. It does not replace session logs. The current format is **version 6**; `normalizeState()` migrates v2–v5 on load.

Why layout is server-side and not in the browser: the desktop app launches its profile with `--host 127.0.0.1 --port 0`, so the page origin (and therefore `localStorage` and `IndexedDB`) changes on every restart. Browser-local canvas state is only a cache; `workspace.cardPositions` is the durable copy and the client merges it with host values winning.

## Annotation layer

`workspace.nodes[]` holds the canvas primitives drawn beside the conversation graph:

| `type` | Geometry | Payload |
|---|---|---|
| `note` | `x, y, width, height` | `text` (≤ 4000), `color` |
| `image` | `x, y, width, height` | `image`: the DSH attachment reference only |
| `shape` (`rect`, `ellipse`) | `x, y, width, height` | `stroke`, `strokeWidth`, `fill` |
| `shape` (`line`, `arrow`) | `x1, y1, x2, y2` | `stroke`, `strokeWidth` |
| `frame` | `x, y, width, height` | `title`, `collapsed`, `memberCards`, `memberNodes` |

Group membership names a card by its **position key** (`${threadId}:turn-index:${n}`), never by the card id: the id changes once DSH assigns a source sequence. The host keeps `thread.frameId` in sync with the frame's member list, so a card cannot point at a frame that no longer holds it.

Write routes, all under the existing `/synapse/api` prefix and behind the same Host check:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/workspaces/:id/nodes` | create one node |
| `PATCH` | `/nodes/:id` | patch one node |
| `DELETE` | `/nodes/:id` | delete one node, releasing frame members |
| `PATCH` | `/workspaces/:id` | merge `cardPositions` (never replaces the map) |
| `POST` | `/workspaces/:id/images` | raw image bytes, own 8 MiB ceiling |
| `GET` | `/assets/:attachmentId` | image bytes for a referenced attachment |

Image bytes never enter `workspaces.json`. The upload route hands them to the DSH attachment store (`ctx.get('attachments').saveImage`) and returns the content-addressed receipt (`sha256:<64hex>`, media type, dimensions, byte length); the node stores that receipt, so the metadata file stays small (issue #42). The asset route serves **only** attachments some node still references, and only raster types — SVG is refused, because a vector file would be script-capable on the origin the canvas is served from. `ctx.get()` is the read-without-inject accessor: a composition without the attachment service answers 503 on the two image routes and every other annotation feature keeps working.

Painted order inside `.canvas-content` is `.connectors` → `.cards-layer` (group frames first, then cards) → `.notes-layer` → `.shapes-layer`. Every layer carries a `data-morph-key`, because the canvas is reconciled by `morphInto` and an unkeyed overlay node would make the morph re-create the card list.

Consequences:

- deleting the file resets canvas organization but does not delete conversations;
- uninstalling the plugin keeps the file, so reinstalling restores the canvas;
- older schema versions migrate when loaded;
- two processes sharing the same file can still produce last-writer-wins replacement despite locking and external-change warnings.

Run one `dsh web` instance for each shared profile.

## Projection model

With `autoProjection` enabled, committed DSH session events are grouped by working directory and projected into the corresponding Synapse workspace.

Each user question becomes a conversation card. The following assistant messages are folded into that turn, and the final assistant reply is shown as the answer. Forked sessions connect to the parent turn at the durable DSH seed boundary rather than at an arbitrary canvas coordinate.

Only a turn a person typed becomes a card. The harness also writes its own `user/message` rows — the runtime-context snapshot, the skill catalogue `<system-reminder>` — and those carry a structured `data.source.kind`; injected kinds (`skill-catalog`, plus the runtime snapshot's text marker) are not projected, so they neither occupy a card nor steal the answer from the real question. Existing projections are pruned the same way when the store loads.

Projected messages keep only a preview (280 characters), not the body. The body already lives in the DSH session log, and a workspace file full of copies is what made one workspace reach several megabytes and stall the canvas (issue #42). The canvas asks the Host for the bodies of the cards it actually mounts (`GET /synapse/api/threads/:id/full`), and the detail view asks for a whole thread at once; when a session is archived or gone from DSH the previews stay and the card is marked unavailable instead of rendering blank.

Bodies returned by the detail fetch are capped at 200 000 characters (`MAX_BODY_CHARS`), while the preview stays at 280; a truncated body carries a marker so the card can say the rest lives in DSH.

Projection writes are coalesced during event bursts, and live updates reuse cached Markdown and patch the active card instead of rebuilding the complete canvas. Card coordinates remain visual metadata only and never determine conversation lineage.

Archiving is owned by DSH. The map mirrors `archivedSessionIds` from the Workspace snapshot to stop drawing cards for archived sessions, and its own archive action calls the Workspace `archiveSession` so both sides share one archive set (issue #21 / #19).

## Tool process folding

Live events pair tool calls and results by `callId` and render them inside the related assistant reply instead of as standalone conversation cards.

Legacy v3 migrations did not always have durable call IDs. Those records pair each tool call with the next tool result by order during migration.

## Browser-local state

Some interaction state, such as dragged card positions and branch anchors, may be cached in browser local storage to keep the canvas responsive. Durable workspace metadata is still written through the Synapse service.

Private-browsing restrictions or local-storage failures must not prevent DSH conversations from operating; they only reduce persistence of visual preferences.

## Host validation

The `/synapse` endpoint always accepts `localhost` and `127.0.0.1`. Additional LAN or proxy authorities must be listed in `trustedHosts` as a host or `host:port` value.

This validation is part of the Web surface and does not replace broader network access controls.

## Model and KV-cache impact

Synapse reads session events only after DSH commits them. It does not add or modify:

- system prompts;
- user request content;
- model request headers;
- tool schemas or registries;
- provider routing;
- approval context.

As a result, the plugin has no direct model-experience effect and does not invalidate an otherwise reusable KV-cache prefix.

## Operational limitations

- The bundled patch applies to any profile that lists the package as a bundle (`desktop`, `web`); a profile that does not list it stays untouched.
- Canvas metadata and session content have different owners and backup requirements.
- A single shared metadata file is not a multi-writer database.
- Browser state can be cleared independently from DSH Home data.
- Historical migrations may have less precise tool-call pairing than live projection.

## Related documentation

- [Chinese user guide](zh-CN/README.md)
- [English user guide](en/README.md)
- [Development and release guide](development.md)
- [Project overview](../README.md)
