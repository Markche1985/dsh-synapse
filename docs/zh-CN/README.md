# dsh-synapse 中文指南

`dsh-synapse` 是 DeepSeek Harness（DSH）的 Web 插件。它在 DSH 原生对话界面上增加会话地图，把同一工作区中的会话、追问和分支组织成可浏览、可拖拽和可缩放的画布。

插件不替代 DSH 的模型、工具、会话、权限或 Web 服务；所有对话操作仍由 DSH 完成。

## 前提条件

- DeepSeek Harness `>= 0.1.7-rc.2`（本插件依赖该版本的 Host 会话与 Client 服务接口）。
- Node.js `>= 22.19.0`。
- 选对 profile：桌面 App 用 `desktop`，命令行 `dsh web` 用 `web`（见下节）。

## 装到哪一套 profile

DSH 按 profile 分套安装插件：每套 profile 有自己的插件清单和 `node_modules`，桌面 App 和命令行各用一套，互不影响。

| 你平时怎么用 DSH | 要装的 profile |
|---|---|
| 桌面 App（DeepSeek Harness 客户端） | `desktop` |
| 命令行 `dsh web` / 浏览器访问（如果你自己也维护了这套） | `web` |

- 从 App 内的插件页面安装时，App 会自动装进它自己用的那套，无需关心 profile。
- **自检口诀：装完顶部看不到「会话地图」开关，就是装到另一套去了**，把 `--profile` 换成另一套的名字再装一次即可。
- 桌面 App 装完需要**重启 App**；命令行装的，重启 `dsh web` 并刷新页面。

## 安装

`dsh` 是 DSH 运行时自带的 launcher，位于 App 安装目录的 `resources\runtime\cli\bin\dsh.cmd`。先确认它能调用：

```powershell
dsh --version
```

### 从 npm 安装

```powershell
# 桌面 App
dsh plugin --profile desktop add dsh-synapse

# 命令行形态（仅当你有对应的 web profile）
dsh plugin --profile web add dsh-synapse
```

npm 包分发的是预构建产物，无需任何构建授权——最简单的安装方式。下方 GitHub 与本地 checkout 为备选。

### 从 GitHub 安装

```powershell
dsh plugin --profile desktop add github:liangmianya/dsh-synapse
```

GitHub 安装会运行本包的 `prepare` 脚本，通过 `node --check` 验证 JavaScript 语法。

### pnpm 10+ 的 allowBuilds

pnpm 10 及之后版本默认可能阻止 Git 依赖执行构建脚本。如果安装被拦截，请将 pnpm 输出的**完整键**复制到对应 profile 的 `pnpm-workspace.yaml`：

```yaml
allowBuilds:
  "dsh-synapse@https://codeload.github.com/liangmianya/dsh-synapse/tar.gz/<commit>": true
```

必须使用包含 tarball URL 和 commit 的完整键，不能只填写裸包名 `dsh-synapse`。上游 commit 变化后，键也会变化；届时使用 pnpm 新输出的值。

### 本地开发安装

```powershell
dsh plugin --profile desktop add link:E:\path\to\dsh-synapse
```

`link:` 会直接引用本地 checkout，适合开发和调试。普通运行模式下修改代码后，建议重启宿主（桌面 App 或 `dsh web`）并刷新页面。

## 启动

```powershell
dsh web
```

默认地址：

```text
http://127.0.0.1:3080/
```

如果 3080 被占用，可以让 DSH 自动选择端口：

```powershell
dsh web --port 0
```

启动后点击顶部“会话地图”进入 Synapse。不要同时运行两个共享同一 profile 的 `dsh web` 实例。

## 使用方式

1. 在 DSH 中选择工作目录，或打开已有会话。
2. 发送至少一条消息，使会话进入工作区历史。
3. 点击顶部“会话地图”。
4. 点击卡片或侧边栏会话，在地图与原生对话之间同步当前会话。
5. 使用“分支”从已完成的回答创建替代路径。
6. 点击卡片底部“详情”查看完整会话记录。
7. 使用“打开 DSH”或顶部“对话”返回原生对话界面。

画布支持：

- 拖动画布和缩放视图（最高 4×）。
- 拖动卡片并自动保存位置（存到 Host，重启和换浏览器都还在）。
- 展开或折叠后续对话子树。
- 一键定位当前会话。
- 卡片内部平滑滚动和 Markdown 表格渲染。
- 将工具调用和结果按 `callId` 折叠到对应助手回答中。

### 批注层

画布顶部工具栏可以在会话卡片旁边加批注，批注和卡片一样会被保存：

| 工具 | 怎么用 |
|---|---|
| **便签** | 点「便签」（或按 `N`）再点画布空白处。点正文即可编辑，点别处自动保存；`Esc` 结束编辑；拖右下角改尺寸；`×` 删除。 |
| **图片** | 截图后直接在画布里 `Ctrl+V`，或把图片文件拖进画布，或点「图片」选文件。图片会自动压到长边 1600px 的 WebP 再上传。 |
| **箭头 / 矩形 / 椭圆** | 点工具后在画布上按下拖动画；只点不拖得到一个默认尺寸。箭头两端的小圆点可以再拖。 |
| **框选 / 分组** | 点「框选」后在空白处拖出选框（或用 `Shift`/`Ctrl` 点选卡片与批注），再点「分组」或按 `G`。 |

分组的操作方式：

- **拖标题栏**搬走整组（组里的卡片和其它批注一起移动）。
- **拖组里的某张卡片**只移动那张卡片，它会自动移出该组。
- 标题栏右侧的按钮可以把整组**折叠成一条摘要**（显示成员数），再点一次展开；切到被折叠的会话时会自动展开该组，避免定位到看不见的卡片。
- 选中批注按 `Delete` / `Backspace` 可删除；`Esc` 取消当前工具与选择。

顶部「对话 / 会话地图」开关也可以挪位置：

- 按住开关左侧的**六点手柄**拖动，鬆手即记忆（存在浏览器本地，按浏览器各自独立）；
- **双击手柄**复位到默认位置（标题栏下方居中）；
- 手柄获得焦点后可用**方向键**微调，每次 8px；
- 开关始终保留离屏幕边缘 8px 的余量，缩小窗口也不会被挤到看不见的地方。

## 最近更新

**0.6.0**

- 新增画布批注层：便签、粘贴图片、箭头 / 矩形 / 椭圆，以及可折叠的分组框（本次新增）。
- 卡片坐标改为写进 Host 的 `workspaces.json`。桌面 App 每次启动都用随机端口打开页面（`--port 0`），浏览器本地存储按 origin 隔离，所以**重启后画布位置原本会全部丢失**；现在重启、换浏览器都还在。
- 图片存进 DSH 附件库（`$DSH_HOME/attachments/`），画布节点只保留引用，`workspaces.json` 不会因为图片变大。
- 修掉一个渲染隐患：顶部状态条出现时不再连带重建整棵画布。

**0.5.6**

- 顶部开关可以拖动、记忆位置、双击复位（本次新增）。
- 修正交互与渲染一致性：切换会话会把该会话带到视野内；折叠卡片不再移动画布；选区落在正文时侧栏与详情仍能更新；卡片右侧的折叠/分支按钮不再被相邻卡片遮住而点不到。
- 修正工作区加载竞态：切换工作区不会再被后台轮询顶掉，画布重建次数从「每秒数次」降到「仅在数据变化时一次」。
- `workspaces.json` 读不出来时改为**明确报错并保持只读**，不再用旧备份覆盖原文件（0.5.5 引入的回退已撤销）。

## 配置

插件通过 profile 的 `cordis.patch.yml` 注入。可以在自己的 patch 中通过行 id `synapse` 覆盖配置。

> DSH patch 会整体替换该行的 `config`，覆盖时需要重述所有需要保留的键。

| 键 | 默认值 | 说明 |
|---|---|---|
| `dataFile` | `$DSH_HOME/synapse/workspaces.json` | 画布元数据持久化文件 |
| `autoProjection` | `true` | 自动将已提交的 DSH 会话事件投影为卡片 |
| `projectionWorkspaceTitle` | `DSH 任务` | 自动投影工作区的标题 |
| `trustedHosts` | `[]` | `/synapse` Host 检查额外允许的主机名或 `主机:端口`；`localhost` 和 `127.0.0.1` 始终允许 |

配置示例：

```yaml
- id: synapse
  config:
    dataFile: !!js dshHomePath('synapse/my-workspaces.json')
    autoProjection: true
    projectionWorkspaceTitle: 我的任务
    trustedHosts: []
```

局域网访问时，需要将实际访问主机加入 `trustedHosts`。

## 卸载与数据清理

卸载插件：

```powershell
dsh plugin --profile web remove dsh-synapse
```

`remove` 只移除插件依赖和 profile 激活层，不会删除画布数据。重新安装后，旧数据会继续使用并按需迁移。

彻底清理时，手动删除：

```text
$DSH_HOME/synapse/
```

`pnpm-workspace.yaml` 中遗留的 `allowBuilds` 键没有副作用，也可以一并移除。

## 数据与运行边界

- DSH session log 保存真实对话内容。
- Synapse 的 `workspaces.json` 只保存画布元数据、布局、卡片坐标、批注节点（便签文本、图形、分组）和分支锚点；数据格式为 **version 6**，更旧的版本在载入时自动迁移。
- 粘贴的图片不在 `workspaces.json` 里：字节交给 DSH 附件库（`$DSH_HOME/attachments/`），节点只存内容寻址引用（约 120 字节），因此画布加再多图也不会把元数据文件撑大。
- 删除 `workspaces.json` 会丢失画布布局与批注，但不会删除 DSH 会话，也不会删除附件库里的图片。
- 单条消息投影上限为 8000 字符；超出部分在卡片中截断并标注“—…（详情查看全文）”，完整内容仍可在会话详情中查看。
- 插件不启动第二个 Web 服务，也不创建第二套 Agent。
- 插件只读取已经提交的会话事件，不修改模型请求、系统提示、工具 schema 或 KV cache 前缀。

更详细的内部说明见[架构与运行边界](../architecture.md)。

## 已知限制

- 支持 `desktop`（桌面 App）与 `web`（命令行 `dsh web`）两套 profile；其他自定义 profile 需要自己把插件加入 bundle 列表。装错 profile 时插件不会报错，只是顶部不会出现「会话地图」。
- 两个 DSH Web 实例共享同一个 profile 时会写入同一个 `workspaces.json`。虽然存在跨进程写锁和外部修改警告，仍可能出现最后写入覆盖，请只运行一个实例。
- v3 数据迁移时，旧工具卡片按顺序将每次调用与下一条结果配对；实时事件使用 `callId`。
- 箭头与直线是**自由端点**，不会吸附到卡片上；分组折叠期间成员卡片不渲染，因此也搜不到它们的正文。
- 图片只接受 png / jpeg / webp / gif，**SVG 会被拒绝**（矢量文件在 DSH 源上可执行脚本）。上传上限 8 MiB，浏览器侧会先把长边压到 1600px。
- 如果 profile 的自定义 composition 没有挂载 DSH 附件库，图片相关接口返回 503 并给出提示，便签、图形、分组等其余批注功能不受影响。

## 开发与发布

贡献者命令、GitHub Actions 和 npm 发布流程见[开发与发布指南](../development.md)。

返回[项目主页](../../README.md)。
