# dsh-synapse English Guide

`dsh-synapse` is a Web plugin for DeepSeek Harness (DSH). It adds a session map to the native conversation interface and organizes sessions, follow-ups, and forks from the same workspace as a browsable, draggable, and zoomable canvas.

The plugin does not replace DSH models, tools, sessions, permissions, or the Web server. DSH remains responsible for every conversation operation.

## Prerequisites

- DeepSeek Harness `>= 0.1.7-rc.2`; this revision targets that release's Host session and Client service interfaces.
- Node.js `>= 22.19.0`.
- The right profile: the desktop app uses `desktop`, the `dsh web` command uses `web` (see below).

## Which profile to install into

DSH installs plugins per profile. Each profile keeps its own plugin list and `node_modules`, so the desktop app and the command line do not affect each other.

| How you run DSH | Profile to use |
|---|---|
| Desktop app (DeepSeek Harness client) | `desktop` |
| `dsh web` on the command line (if you keep that profile) | `web` |

- Installing from the app's plugin page already targets the profile the app uses, so you do not pick one there.
- **Quick self-check: if the "会话地图 / Session map" switch never appears, the plugin went into the other profile** — install again with the other `--profile`.
- A desktop install takes effect after **restarting the app**; a command-line install takes effect after restarting `dsh web` and refreshing the page.

## Installation

`dsh` is the launcher that ships with the DSH runtime, at `resources\runtime\cli\bin\dsh.cmd` inside the app directory. Check that it responds first:

```powershell
dsh --version
```

### Install from npm

```powershell
# Desktop app
dsh plugin --profile desktop add dsh-synapse

# Command line (only if you keep a web profile)
dsh plugin --profile web add dsh-synapse
```

The npm package ships prebuilt code, so no build-script permission is needed — the simplest install. GitHub and local-checkout routes below are alternatives.

### Install from GitHub

```powershell
dsh plugin --profile desktop add github:liangmianya/dsh-synapse
```

GitHub installs run the package `prepare` script, which validates JavaScript syntax with `node --check`.

### pnpm 10+ allowBuilds

pnpm 10 and later may block build scripts for Git dependencies by default. If installation is blocked, copy the **complete key printed by pnpm** into the matching profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  "dsh-synapse@https://codeload.github.com/liangmianya/dsh-synapse/tar.gz/<commit>": true
```

Use the complete key containing the tarball URL and commit, not the bare package name `dsh-synapse`. The key changes when the upstream commit changes, so use the newly printed value when upgrading.

### Install a local checkout

```powershell
dsh plugin --profile desktop add link:E:\path\to\dsh-synapse
```

The `link:` form references the local checkout directly and is recommended for development. In a normal run, restart the host (the desktop app or `dsh web`) and refresh the page after editing the plugin.

## Start DSH Web

```powershell
dsh web
```

Default address:

```text
http://127.0.0.1:3080/
```

Let DSH choose a free port when 3080 is occupied:

```powershell
dsh web --port 0
```

Open the top **Session Map** switch after startup. Do not run two `dsh web` processes that share the same profile.

## Usage

1. Select a working directory in DSH or open an existing session.
2. Send at least one message so the session enters workspace history.
3. Open **Session Map** from the top switch.
4. Click a card or sidebar session to synchronize the current session between the map and native chat.
5. Use **Branch** on a completed answer to preserve an alternative path.
6. Open **Details** from a card to inspect the complete conversation.
7. Use **Open in DSH** or the top **Dialogue** switch to return to native chat.

The canvas supports:

- Panning and zooming up to 4×.
- Dragging cards with positions persisted on the host (they survive a restart and a different browser).
- Expanding or collapsing descendant conversation subtrees.
- One-click focus on the current session.
- Smooth card scrolling and Markdown table rendering.
- Folding tool calls and results into the related assistant answer by `callId`.

### Annotations

The toolbar at the top of the canvas adds annotations next to the conversation cards. Annotations are saved with the canvas.

| Tool | How it works |
|---|---|
| **Note** | Press **Note** (or `N`), then click an empty spot. Click the body to edit; clicking away saves it. `Esc` leaves the editor, the bottom-right corner resizes it, `×` deletes it. |
| **Image** | Paste a screenshot with `Ctrl+V`, drop an image file onto the canvas, or press **Image** to pick a file. The browser downsizes it to a 1600px long edge and re-encodes to WebP before uploading. |
| **Arrow / rectangle / ellipse** | Pick a tool and drag on the canvas; a plain click gets a default-sized shape. An arrow's two end handles can be dragged afterwards. |
| **Marquee / group** | Press **Select** and drag a rubber band over empty canvas (or `Shift`/`Ctrl`-click cards and annotations), then press **Group** or `G`. |

How groups behave:

- Drag the **header bar** to move the whole group — its cards and annotations move with it.
- Drag a **card inside the group** and only that card moves; it leaves the group automatically.
- The header buttons collapse the group into **one summary row** (with its member count) and expand it again. Switching to a conversation whose cards are collapsed expands that group first, so focus never lands on a hidden card.
- `Delete` / `Backspace` removes the selected annotations; `Esc` cancels the active tool and the selection.

The **Dialogue / Session Map** switch can be moved too:

- Drag it by the six-dot grip on its left edge; the position is remembered per browser.
- Double-click the grip to return it to its shipped seat (centred under the window chrome).
- With the grip focused, the arrow keys nudge it by 8px.
- It always keeps an 8px grab margin from the viewport edges, so shrinking the window cannot strand it off screen.

## Recent changes

**0.6.0**

- New annotation layer: sticky notes, pasted images, arrows / rectangles / ellipses, and collapsible group frames (new).
- Card positions are now stored in the host's `workspaces.json`. The desktop app opens the page on a random port every launch (`--port 0`) and browser storage is origin-scoped, so **positions used to be lost on every restart**; they now survive a restart and a different browser.
- Pasted images live in the DSH attachment store (`$DSH_HOME/attachments/`); a canvas node keeps only a content-addressed reference, so `workspaces.json` does not grow with images.
- Fixed a rendering hazard: a status message appearing no longer rebuilds the whole canvas subtree.

**0.5.6**

- The top switch is draggable, remembers where you left it, and resets on a double-click (new).
- Interaction and rendering consistency: switching a conversation now brings it into view; folding a card no longer moves the canvas; a text selection in an answer no longer freezes the sidebar and the details panel; the fold/branch buttons on a card's right edge are no longer covered by the neighbouring card.
- Workspace switching no longer races the background poll, and the canvas is rebuilt only when data actually changes instead of several times a second.
- An unreadable `workspaces.json` now fails loudly and read-only instead of restoring an old backup over it (the 0.5.5 fallback was reverted).

## Configuration

The plugin is inserted through the profile's `cordis.patch.yml`. Override it in your own patch by targeting the row id `synapse`.

> A DSH patch replaces the row's complete `config`, so restate every value that must remain active.

| Key | Default | Description |
|---|---|---|
| `dataFile` | `$DSH_HOME/synapse/workspaces.json` | Canvas metadata persistence file |
| `autoProjection` | `true` | Automatically project committed DSH session events into cards |
| `projectionWorkspaceTitle` | `DSH 任务` | Title of the automatically projected workspace |
| `trustedHosts` | `[]` | Extra host or `host:port` values accepted by the `/synapse` Host check; `localhost` and `127.0.0.1` are always accepted |

Example:

```yaml
- id: synapse
  config:
    dataFile: !!js dshHomePath('synapse/my-workspaces.json')
    autoProjection: true
    projectionWorkspaceTitle: My tasks
    trustedHosts: []
```

Add the actual host to `trustedHosts` when exposing DSH on a LAN.

## Uninstall and data cleanup

Remove the plugin:

```powershell
dsh plugin --profile web remove dsh-synapse
```

`remove` deletes the dependency and profile activation layer but keeps canvas data. Reinstalling reuses and migrates the old data when necessary.

For a complete cleanup, manually remove:

```text
$DSH_HOME/synapse/
```

A leftover `allowBuilds` key in `pnpm-workspace.yaml` is harmless and may also be removed.

## Data and runtime boundaries

- DSH session logs own the actual conversation content.
- Synapse `workspaces.json` stores only canvas metadata, layout, card positions, annotation nodes (note text, shapes, groups) and branch anchors; the format is **version 6**, and older versions migrate on load.
- Pasted images are not stored in `workspaces.json`: the bytes go to the DSH attachment store (`$DSH_HOME/attachments/`) and the node keeps a content-addressed reference (~120 bytes), so adding images never bloats the metadata file.
- Deleting `workspaces.json` loses canvas layout and annotations, never DSH sessions — and never the images in the attachment store.
- Projected message text is capped at 8000 characters; longer card text ends with “—…（详情查看全文）”, while the full content remains available in conversation details.
- The plugin starts no second Web server and creates no second agent system.

See [Architecture and runtime boundaries](../architecture.md) for details.

## Model Experience

None, as dsh-synapse only reads committed session events and renders them; it adds no system-prompt prose, tool schemas, or request-context content to any model request.

### KV Cache effect

Does not invalidate. The plugin never changes request headers, system prompts, or tool registries, so an already-reusable KV prefix stays reusable; canvas projection consumes session logs only after they are committed.

## Known limitations

- Both the `desktop` (desktop app) and `web` (`dsh web`) profiles are supported; any other profile has to add the package to its own bundle list. Installing into the wrong profile does not error — the Session map switch simply never appears.
- Two DSH Web instances sharing one profile write the same `workspaces.json`. A cross-process write lock and external-modification warnings exist, but last-writer-wins replacement remains possible; run one instance.
- During v3 migration, legacy tool cards pair each call with the next result by order. Live events pair by `callId`.
- Arrows and lines have **free endpoints**; they do not snap to cards. While a group is collapsed its member cards are not rendered, so their text is not in the DOM.
- Images accept png / jpeg / webp / gif only — **SVG is rejected** on purpose (a vector file would be script-capable on the DSH origin). Uploads are capped at 8 MiB and the browser downsizes to a 1600px long edge first.
- A custom composition that does not mount the DSH attachment store answers 503 on the image routes; notes, shapes and groups keep working.

## Development and releases

Contributor commands, GitHub Actions, and npm publishing are documented in the [Development and release guide](../development.md).

Return to the [project overview](../../README.md).
