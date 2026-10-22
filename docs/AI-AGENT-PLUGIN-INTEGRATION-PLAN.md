# AI Agent 与插件系统接入规划

> 状态：规划稿（未动代码）  
> 范围：AI 对话 Agent、故事/小说创作、提示词创作、画布节点程序化执行、插件系统  
> 结论先行— 本规划的所有现状判断均已对照代码核验，关键处标注了文件与行号。

---

## 0. 结论摘要

这不是"从零接 Agent"，而是**把已经躺在仓库里的零件接起来，并补上三个真实缺口**。

### 三个真实缺口

| #  | 缺口                   | 现状证据                                                                                                                                                                                                                                           | 影响                                  |
| -- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| G1 | **没有 Agent Runtime** | `src/features/agent/AgentPanel.tsx:23` 回复是硬编码字符串"Agent Runtime 接入后，我会在这里执行画布操作"；`canvasTools.ts` / `commandExecutor.ts` / `canvasPlugin.ts` 全仓仅有自引用，无人 import                                                                                  | 聊天、工具循环、上下文管理全部要新建                  |
| G2 | **没有程序化触发生成**        | `canvasStore` 有 `addNode` / `addEdge` / `updateNodeData` / `deleteNode`，但**没有任何 run/execute 类 action**；生成逻辑锁在节点组件内（`ImageEditNode.tsx:749` `handleGenerate`、`VideoGenNode.tsx:1144` `handleGenerate`），轮询在 `Canvas.tsx:1393-1735` / `1913-2050` | "调用画布节点生成图片/视频"**无法实现**，这是最大一块真实工作量 |
| G3 | **没有 LLM 工具调用通道**    | 全仓（`src/` + `src-tauri/src/`）搜 `tool_calls` / `function_call` **零命中**；`chat_completion`（`openai_compat/mod.rs:642`）无 stream、无 tools，且 `temperature` 硬编码 `0.4`；现有 SSE 解析（`cinematicStudio/app/providers/ai.ts:304-308`）只读 `delta.content`       | Agent 无法调用工具，必须新建                   |

### 三个反直觉但重要的判断

1. **`chatModels` 和 chat 模型选择器已经存在**——`settingsStore.ts:211` 的 `CustomApiProvider.chatModels: string[]`，以及 `settingsStore.ts:329/331` 的 `cinematicAiSelection` / `textNodeAiSelection`。**Agent 的模型配置不需要新建设置体系**，直接复用。
2. **插件系统不要一步做到"可执行代码插件"**——当前 `csp: null`（`tauri.conf.json:35`）、`withGlobalTauri: true`（`:13`）、`fs` 读写成对 `$HOME/**` 开放（`capabilities/default.json:12-33`）。在这个安全基线上跑第三方代码是危险的。做法是**用 MCP**：插件是独立进程，零代码注入风险。
3. **引入外部 harness 只替换架构的上两层**（2026-10-06 修订）——Agent 运行时选定 `dsh`/`pi` 这样的外部 harness 后，**工具定义、权限模型、数据表、画布接口全部原样保留**，因为它们只依赖 MCP 这一标准接口。**换 harness 不用重做工具层**，这正是选 MCP 作解耦面的回报。

---

## 1. 现状盘点

### 1.1 可直接复用（已核验）

| 能力                     | 位置                                                                                                                                                                                   | 说明                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| **流式传输原语（含 event 回推）** | `ai.rs:719` `request_provider_stream`（注册于 `lib.rs:322`），逐 chunk `app.emit`                                                                                                           | 前端 `invoke` + `listen` 用法已有现成范例：`cinematicStudio/app/providers/ai.ts:156/183` |
| **非流式传输原语**            | `ai.rs:582` `request_provider_json`（`lib.rs:320`）                                                                                                                                    | 同上                                                                            |
| **AI 供应商能力探测**         | `detect_provider_capabilities`（`ai.rs:450`，`lib.rs:319`）                                                                                                                             | 已探测 `/v1/models`，可扩展出 `supportsToolCalling`                                   |
| **chat 模型配置 + 选择器**    | `settingsStore.ts:211` `chatModels`，`:329` `cinematicAiSelection`，`:331` `textNodeAiSelection`                                                                                       | Agent 模型选择直接复用                                                                |
| **画布程序化读写**            | `canvasStore.ts`：`addNode`(返回 id) / `addEdge` / `updateNodeData` / `updateNodeDataTransient` / `deleteNode` / `moveNode` / `undo` / `redo` / `autoLayoutCanvas` / `findNodePosition` | 外部可用 `useCanvasStore.getState()` 直接调                                          |
| **Agent 工具表雏形**        | `agent/canvasTools.ts:17-88`，10 个工具 + `permission: "read" \| "write" \| "destructive" \| "paid-operation"`                                                                           | 权限分级设计已经对了，直接扩展                                                               |
| **工具执行器雏形**            | `agent/commandExecutor.ts:24` `switch(command.tool)` → store action                                                                                                                  | 需要重构成注册表                                                                      |
| **提示词编译引擎**            | `cinematicStudio/app/providers/ai.ts`：`generateQuickPrompt`(1772) / `planSceneShots`(2435) / `generateFinalPrompt`(1758) / `optimizeSceneBrief`(1400)                                | "写提示词"**不需要新建**，接线即可                                                          |
| **故事→分镜的现成接线点**        | `CinematicStudioNode.tsx`：`QUICK_INPUT_HANDLES.synopsis`(398-419)、`handleQuickGenerate`(875-1014)、`handleSendToVideo`(493-543，会 `addNode(videoGen)` + `addEdge`)                     | 创作链路的下半段已经通了                                                                  |
| **提示词库**               | `prompts/promptLibraryStore.ts:45` localStorage                                                                                                                                      | 可被 Agent 直接读写                                                                 |
| **模板体系**               | `templates/*` + `template_sync.rs`（SQLite + UNC 共享盘）                                                                                                                                 | 未来可作插件分发载体                                                                    |
| **异步任务表 + 轮询**         | `ai_generation_jobs` 表（`ai.rs:171-193`），可跨重启续查                                                                                                                                       | Agent 等结果的基础设施已具备                                                             |
| **沙箱化外部通道的先例**         | `media_bridge.rs:1-12` 的三层边界（回环 + Origin 白名单 + 固定路由）                                                                                                                                 | 插件系统的安全范式参考                                                                   |

### 1.2 关键缺口

| 缺口                      | 说明                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| **G2 节点执行器**            | 生成逻辑内嵌在节点组件（`ImageEditNode` / `VideoGenNode` / `AudioGenNode`），无 headless 入口                              |
| **G3 工具调用**             | 无 `tools` 透传、无 `delta.tool_calls` 解析、无工具循环                                                                |
| **无会话持久化**              | 无 `conversation` 相关表或 store（`AgentPanel` 用组件内 `useState`，卸载即丢）                                            |
| **无多会话**                | 无会话列表 / 切换 / 重命名                                                                                          |
| **无故事数据模型**             | `novel/` 只是番茄小说**下载器**（`NovelDownloader.tsx:1-11`），**不接大模型、不能写作**；没有设定集/大纲/章节的数据结构                        |
| **无依赖图自动执行**            | 拓扑排序只用于 `autoLayoutCanvas` 排版（`canvasLayout.ts:45/82`），不驱动执行；无"生成完成"事件（`eventBus.ts` 只有 UI 类事件）           |
| **无插件系统**               | 无 marketplace / mcp / 沙箱 / 动态加载；现有"扩展"全是**构建期发现**（前端 `import.meta.glob`、后端 `automod`+`inventory`）         |
| **`zod` 未安装但是被 import** | `canvasTools.ts:1` `import { z } from "zod"`，但 `package.json` 无 zod。**当前是潜伏的编译断裂**——一旦有人 import 这个文件就构建失败 |

### 1.3 现状给规划的硬约束

- **C1 只能沿数据流改**（AGENTS.md §3）：UI → Store → 应用服务 → 基础设施 → 持久化，禁止跨层偷改状态。Agent 必须是"应用服务层"的居民。
- **C2 节点注册单一真相源**（AGENTS.md §4.5）：新节点类型统一在 `domain/nodeRegistry.ts` 声明。
- **C3 文件规模警戒线 800 行**（AGENTS.md §4.3）。`canvasStore.ts` 已 97KB、`Canvas.tsx` 更大——**Agent 相关代码不得再往这两个文件里塞**。
- **C4 表结构变更必须自愈**（AGENTS.md §9）：`PRAGMA table_info` + `ALTER TABLE`。
- **C5 一模型一文件**（AGENTS.md §8.1）：新增 LLM 模型/供应商走 `models/` 目录约定。

---

## 2. 目标架构

分五层，自下而上（**2026-10-06 修订**：Agent 运行时改为引入外部 harness，故上两层重画）：

```
┌──────────────────────────────────────────────────────────────────────┐
│ 展示层    自研 Chat UI · 创作工作台 · 工具调用卡片 · 权限确认弹窗          │
├──────────────────────────────────────────────────────────────────────┤
│ 集成层    harness 进程管理（spawn/健康/日志）· 流式转发 · 会话映射        │
│           ★ 外部 harness（DSH / Pi）在这一层被包裹，而非被替换            │
├──────────────────────────────────────────────────────────────────────┤
│ 桥接层    LenTalk MCP Server（Rust）· WebView 工具执行端点（往返桥）      │
├──────────────────────────────────────────────────────────────────────┤
│ 工具层    canvas.* · story.* · prompt.* · library.* · media.* · mcp.*   │
├──────────────────────────────────────────────────────────────────────┤
│ 基础设施   canvasStore · nodeExecution(新建) · Tauri 命令 · SQLite       │
└──────────────────────────────────────────────────────────────────────┘
```

> **最重要的结论**：选定 harness 只替换了**上两层**。  
> 原规划里的**工具层（工具定义 + 权限模型）、桥接层、基础设施层（数据表 + 画布接口）全部原样保留**——  
> 因为它们只依赖 MCP 这个标准接口，不依赖谁来做 agent 循环。

**分层职责边界**

| 层    | 职责                                      | 禁止                       |
| ---- | --------------------------------------- | ------------------------ |
| 展示层  | 渲染消息、收集输入、展示工具调用与确认                     | 不直接调 `invoke`，不直接改 store |
| 集成层  | 管理 harness 子进程生命周期、把流式事件转成前端可消费的消息、映射会话 | **不含任何工具逻辑，不解析业务语义**     |
| 桥接层  | 把 MCP 工具调用转成 WebView 可执行的操作并回传结果        | 不承载业务逻辑，只做搬运与关联          |
| 工具层  | 单个工具的入参校验、权限判定、执行                       | 不互相调用，不关心谁调用它            |
| 基础设施 | 真正的副作用（画布变更、文件、HTTP、DB）                 | —                        |

---

## 3. 关键技术决策

### D1 · Agent 运行时：引入外部 harness（DSH / Pi），不自研循环

> **2026-10-06 决策**：用户倾向使用 `pi` 或 `dsh` 作为 Agent 运行时，**替代**本文档初稿建议的"自研前端循环"。  
> 本节据此重写。原初稿判断见本节末"被推翻的初稿判断"。

#### D1.1 两个候选是什么

|           | **Pi**                                                                        | **DSH**（DeepSeek Harness，CLI 名 `dsh`）             |
| --------- | ----------------------------------------------------------------------------- | ------------------------------------------------- |
| 定位        | 极简 kernel：4 把工具 `read`/`write`/`edit`/`bash`，系统提示 < 1000 token                | 完整 agent chassis，53 个内置工具                         |
| 架构        | 极简内核 + 25+ TS hook 点（`input` / `before_agent_start` / `tool_call` / `turn_*`） | Cordis 微内核，"一切皆插件"——模型适配器、工具注册表、沙箱、会话、**主循环**皆可替换 |
| 扩展方式      | 写 TypeScript 扩展文件（`~/.pi/agent/extensions/`）；可加工具、拦调用、改上下文                    | 写 Cordis 插件（打 `dsh-plugin` topic）；或换 preset       |
| **MCP**   | ❌ **不支持**，需自建                                                                 | ✅ **原生支持**                                        |
| **权限/审批** | ❌ **无**，继承宿主进程全部权限                                                            | ✅ **内置审批策略**                                      |
| 沙箱        | ❌ 无，需自备容器                                                                     | ✅ 内置，可选                                           |
| UI        | 无（纯 CLI）                                                                      | 自带本地 Web UI（`127.0.0.1:3080`）+ headless           |
| 会话        | 树状 session，支持分叉                                                               | append-only 日志，可回放、可审计                            |
| 成熟度       | 相对稳定，MIT，约 100k star                                                          | ⚠️ **v0.1 开发者预览，周更，有破坏性变更**                       |
| 运行依赖      | Node.js                                                                       | Node.js 22.19+（另有 Python SDK）                     |

#### D1.2 选型结论：**DSH 优先，Pi 作为轻量退路**

理由**不是**"DSH 功能多"，而是**项目已定的两条硬需求恰好都是 DSH 原生、Pi 缺失**：

1. **插件走 MCP**（§7.1 决策 1）→ DSH 原生支持；Pi 完全不支持，等于 MCP 客户端要我们自己写。
2. **`paid-operation` 必须二次确认**（生图生视频要花钱）→ DSH 内置审批策略；Pi 无权限层，等于确认闸门要我们自己造。

次要加分项：DSH 内置沙箱、append-only 可审计会话日志（对应本文档 §4 的 `agent_tool_calls` 审计表）。

**必须承认的代价**：DSH 处于 v0.1 开发者预览，周更且带破坏性变更。**升级即可能打碎集成层**。因此集成层必须做薄、并且把 harness 版本**锁定**（pin），不能跟随 latest。

#### D1.3 集成方式：LenTalk 作 MCP Server + harness 以 headless 运行

```
LenTalk 主窗口（React WebView）
  ├─ 自研 Chat UI（复用项目设计 token，AGENTS.md §5）
  └─ WebView 工具执行端点（执行画布/提示词操作）
        ⇅  Tauri IPC（invoke 请求 / emit 回传，按 requestId 关联）
Rust 后端
  ├─ LenTalk MCP Server  ←→  暴露 canvas.* / story.* / prompt.* / library.* / media.*
  ├─ harness 进程管理（spawn / 健康检查 / 停止 / 日志 / 版本 pin）
  └─ 流式转发（harness 事件 → 前端消息）
        ⇅  stdio 或 Streamable HTTP（MCP）
Agent Harness 子进程（dsh，或 pi）
  └─ 同时连接：LenTalk 的 MCP server + 用户自己安装的其他 MCP server
```

**四条设计约束**

1. **用 MCP 解耦，不直连 harness 内部 API**。LenTalk 只实现标准 MCP server，于是换 harness（DSH↔Pi↔未来其他）不用改工具层。这也是 §7.1 决策 1 的自然延伸。
2. **不把 DSH 的 Web UI 塞进 LenTalk**。DSH 自带 UI 与项目卡片式设计语言（AGENTS.md §5）冲突，且会让权限闸门落在我们控制之外。**DSH 的 Web UI 仅作为开发期调试工具保留**；产品内一律用自研 Chat UI。
3. **工具执行按"是否需要 WebView"分流**：
   - `story.*` / `media.*` / `library.*` → **纯 Rust 执行**，无需桥接（SQLite / ffmpeg 都在 Rust 侧）
   - `canvas.*` / `prompt.*` → **必须走 WebView 往返桥**（`canvasStore` 与 cinematicStudio 编译引擎都是 TS）
   - 这条分流能显著缩小桥接面，进而缩小出 bug 的面积。
4. **会话数据主权归 LenTalk**。会话与消息落我们自己的 `agent_*` 表（§4），harness 自身日志只作调试用途——否则将来换 harness 就丢历史。

**项目内已有的先例（可直接借鉴，不是从零摸索）**

| 先例                            | 位置                                                                          | 对本规划的价值                  |
| ----------------------------- | --------------------------------------------------------------------------- | ------------------------ |
| Python 引擎包裹 + stdout 机器协议流式转发 | `pajuben.rs:1-11`，`##PROGRESS` 协议                                           | **集成层**的现成范式：外挂进程 + 流式事件 |
| sidecar 进程 + 回环 HTTP 代理       | `novel.rs:1-18`                                                             | 子进程生命周期管理范式              |
| 回环 HTTP + Origin 白名单 + 固定路由   | `media_bridge.rs:1-12`                                                      | 若桥接改用 HTTP，安全边界直接照抄      |
| 版本化扩展协议 + 插件结果限额              | `threeDDirector/editor/io/extensionProtocol.ts` + `pluginResultRegistry.ts` | 插件身份声明与结果体积约束范式          |

#### D1.4 ⚠️ 开工前必须先做的"集成验证 spike"

以下 5 个问题**任一答"不能"，D1.3 的架构就要改**。因此 **P0 的第一步不是写生产代码，而是做一个丢掉也不心疼的验证原型**。

| # | 待验证                                          | 若失败的后果                        |
| - | -------------------------------------------- | ----------------------------- |
| 1 | 能否把 harness 作为子进程拉起并**流式**拿到中间过程（而非只能等最终答案）？ | 集成层无法做流式 UI，只能"转圈等结果"         |
| 2 | 能否让 harness 连上**我们的 MCP server** 并真的调用其中工具？  | 退回"harness 自跑、LenTalk 旁观"的弱集成 |
| 3 | 能否**拦截工具调用做人工确认**（`paid-operation` 闸门）？      | 要么放弃付费工具，要么自建闸门（Pi 就必须自建）     |
| 4 | Node.js 依赖怎么打包？Tauri 安装包要带 Node 还是要求用户自装？    | 影响安装包体积与用户门槛                  |
| 5 | 能否让**我们控制会话存储位置**（而非 harness 自己的日志目录）？       | 换 harness 即丢历史                |

**spike 的验收标准**：`dsh` 以子进程启动 → 连上 LenTalk MCP server → 调用一次 `canvas.get_snapshot` 拿到真实画布数据 → 全过程可在 LenTalk UI 内看到流式进度。**跑通即为 P0 放行条件。**

#### D1.5 被推翻的初稿判断（留档）

初稿建议"v1 自研前端循环"，理由是画布工具在前端、传输原语已有、纯 TS 便于单测。  
**该判断在"引入外部 harness"的前提下不再成立**——但其中一条仍然有效且已并入 D1.3：  
**工具执行必须能触达 WebView 内的 `canvasStore`**，这正是 D1.3 约束 3 的由来。

### D2 · 工具调用协议：由 harness 负责，但需验证"不支持 tool calling 的模型怎么办"

> **2026-10-06 修订**：初稿假设由 LenTalk 自己解析 `delta.tool_calls[]`。选定外部 harness 后，  
> **工具调用协议与解析全部由 harness 内部完成，LenTalk 侧不再需要写 SSE 工具调用解析**——  
> 这是引入 harness 换来的最实在的一笔收益，也顺带消灭了初稿里"最容易写错"的那一处。

**LenTalk 侧的唯一职责**：按 MCP 规范实现工具 server（工具名、描述、入参 JSON Schema、返回值）。  
模型与协议适配不归我们管。

**但仍有一个真实风险需要验证**：本项目用户大量使用**中转/聚合平台**，这类平台对 tool calling 的支持参差不齐。  
当模型不支持原生 tool calling 时：

- 若 harness 内部有降级策略（如转 JSON 模式）→ 可用。
- 若 harness 直接报错或静默失败 → 用户会遇到"对话正常但永远不调用工具"的困惑，且**这种失败很难排查**。


**处置**：并入 D1.4 的 spike 一并验证，用**一个明确不支持 tool calling 的中转端点**实测 harness 行为。  
若 harness 无降级能力，则需在集成层加"能力探测 + 不支持时明确提示用户"，而不是让用户自己撞墙。

**探测工具的既有基础**：`detect_provider_capabilities`（`ai.rs:450`）已在探测 `/v1/models`，  
可在其返回值上追加 `supportsToolCalling` / `supportsStreaming` 字段，结果缓存进 `app_settings`。  
**注意**：该探测只影响"给用户看的提示"，不影响 harness 内部行为。

### D3 · Agent 常驻位置：画布内还是全局？

**推荐：全局常驻（应用壳层），画布只是其中一个工具包。**

理由：用户的需求横跨四块——聊天、写小说、写提示词、操作画布。若 Agent 只活在 `Canvas.tsx` 里（现状 `Canvas.tsx:4769` 渲染 `AgentPanel`），那么"写小说"时还要先打开画布，体验割裂。

落地方式：

- 把 `AgentPanel` 从 `Canvas.tsx` 提到应用壳层（`App.tsx` 级），支持右侧停靠 / 可拖拽宽度 / 可折叠。
- 画布上下文（当前选中节点、当前项目）作为**可选附件**注入，而非硬依赖。
- 从画布内点开时，自动带上当前画布快照 + 选中节点。

### D4 · 插件协议：MCP / 自研清单 / 沙箱代码？

**推荐分三档推进，v1 只做第一档。**

**第一档（推荐·P4）——MCP 客户端**

- Rust 侧实现 MCP client：`stdio`（拉起子进程 + JSON-RPC 分帧）+ Streamable HTTP/SSE。
- 用户"安装插件"= 填一份 server 配置（command/args/env 或 url/headers），本质与 WorkBuddy、Claude Desktop 的 MCP 配置一致。
- **收益**：零代码执行风险（MCP server 是独立进程，不是注入本应用），且直接吃到现成生态（文件系统、浏览器、数据库、搜索……）。
- 工具命名 `mcp.<server>.<tool>`，动态合并进 `ToolRegistry`，权限按 server 白名单。
- 新增命令：`mcp_list_servers` / `mcp_upsert_server` / `mcp_remove_server` / `mcp_list_tools` / `mcp_call_tool` / `mcp_server_status`。
- 插件元数据落新表 `plugins`（见 §4）。

**第二档（P5·按需）——声明式 HTTP 工具**

- 零代码：manifest 里声明 URL 模板 + 入参 schema + 鉴权头。覆盖"我就想接自己的一个 API"。
- 复用 MCP 的 `ToolRegistry` 合并路径与权限模型。

**第三档（明确不建议现在做）——沙箱内 UI 插件**

- `iframe` + `postMessage`，可复用 `threeDDirector/editor/io/hostBridge.ts` 的现有范式（版本化协议 + Origin 校验 + `pluginResultRegistry.ts` 的体积限额 512KB/50 条）。
- **前置条件**：必须先做安全收口（见下），否则不予开工。

**安全收口（第二/三档的前置条件，也是 P4 应顺带做的）**

| 项      | 现状                                                         | 目标                                                                |
| ------ | ---------------------------------------------------------- | ----------------------------------------------------------------- |
| CSP    | `csp: null`（`tauri.conf.json:35`）                          | 设置真实 CSP，至少限定 `default-src 'self'`、`img-src` / `media-src` 放开必要来源 |
| 全局 API | `withGlobalTauri: true`（`:13`）                             | 评估关闭或收窄                                                           |
| fs 权限  | read+write 对 `$HOME/**`（`capabilities/default.json:12-33`） | 收窄到应用数据目录 + 用户显式选择的目录                                             |
| 插件执行   | 无通道                                                        | 参照 `media_bridge.rs` 的三层边界范式                                      |

### D5 · 故事/小说数据模型

**推荐：新建 `src/features/story/`，不塞进 `novel/`。**

理由：`novel/` 的语义已被占用为"番茄小说下载器"（`NovelDownloader.tsx:1-11` 自证）。把写作功能塞进去会造成命名混淆。

**为什么不复用 `projects` 表**：`projects` 存的是画布快照（`nodes_json` / `edges_json`），而故事的天然单元是"设定集 + 大纲 + 章节"，需要按章寻址、按章重写、按章装配上下文。用 blob 存整本会在大长篇上失控。

**分层数据模型**：

```
StoryProject（故事项目）
├── StoryBible（设定集）
│   ├── 角色卡 StoryEntity(kind=character)
│   ├── 世界观 StoryEntity(kind=world)
│   ├── 地点 StoryEntity(kind=location)
│   └── 时间线 StoryEntity(kind=timeline)
├── Outline（大纲，树形）
└── Chapter[]（章节）
    └── 正文 + 摘要 + 状态(草稿/已确认/已过期)
```

**关键设计：状态三态**（`draft` / `confirmed` / `stale`）——直接沿用 `docs/CINEMATIC-PROMPT-STUDIO-3-LAYER-REPLAN.md:57` 已确立的约定："上游变化时下游标记'已过期'但不删除"。这让"AI 改了设定，后面章节需要重审"变成可视、可回溯的事情。

---

## 4. 数据模型（SQLite 新增表）

全部走 `ensure_*_table` 自愈模式（`PRAGMA table_info` + `ALTER TABLE`，AGENTS.md §9）。

```sql
-- 会话与消息
CREATE TABLE IF NOT EXISTS agent_conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  scope_json TEXT NOT NULL,        -- {projectId?, storyId?} 会话绑定范围
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  seq INTEGER NOT NULL,            -- 会话内顺序
  role TEXT NOT NULL,              -- system/user/assistant/tool
  content_json TEXT NOT NULL,      -- 文本 + 多模态 content 数组
  tool_calls_json TEXT,            -- assistant 发起的工具调用
  tool_call_id TEXT,               -- role=tool 时的回填目标
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_conv ON agent_messages(conversation_id, seq);

-- 工具调用审计（权限追溯，必须留）
CREATE TABLE IF NOT EXISTS agent_tool_calls (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  tool_name TEXT NOT NULL,
  args_json TEXT NOT NULL,
  permission TEXT NOT NULL,        -- read/write/destructive/paid-operation
  confirmed INTEGER NOT NULL,      -- 是否经用户确认
  status TEXT NOT NULL,            -- ok/denied/error
  error TEXT,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL
);

-- 故事
CREATE TABLE IF NOT EXISTS story_projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  logline TEXT,                    -- 一句话故事
  genre TEXT,
  meta_json TEXT NOT NULL,         -- 风格/调性/目标篇幅等
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS story_entities (
  id TEXT PRIMARY KEY,
  story_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- character/world/location/prop/timeline
  name TEXT NOT NULL,
  payload_json TEXT NOT NULL,      -- 结构化字段（含 @引用锚）
  status TEXT NOT NULL,            -- draft/confirmed/stale
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS story_outline_nodes (
  id TEXT PRIMARY KEY,
  story_id TEXT NOT NULL,
  parent_id TEXT,
  seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  beat TEXT,                       -- 情节节拍
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS story_chapters (
  id TEXT PRIMARY KEY,
  story_id TEXT NOT NULL,
  outline_node_id TEXT,
  seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT,                    -- 滚动摘要（上下文装配用）
  word_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 插件
CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY,             -- 如 mcp:filesystem
  name TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,              -- mcp-stdio/mcp-http/http-tool
  manifest_json TEXT NOT NULL,     -- command/args/env 或 url/headers + 工具白名单
  enabled INTEGER NOT NULL DEFAULT 1,
  last_status TEXT,                -- 连接状态
  installed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

**已有表可复用的**：`app_settings`（放能力探测缓存、Agent 默认模型选择）、`ai_generation_jobs`（Agent 触发的生成任务天然落在这里，可直接 `get_generate_*_job` 轮询）。

---

## 5. 工具清单（Agent 的能力面）

命名空间化，权限沿用既有四级（`read` / `write` / `destructive` / `paid-operation`）。

### 5.1 画布包 `canvas.*`

| 工具                                      | 权限                 | 说明                      | 依赖                        |
| --------------------------------------- | ------------------ | ----------------------- | ------------------------- |
| `canvas.get_snapshot`                   | read               | 节点/连线/选中态快照             | 已有（`canvasContext.ts:60`） |
| `canvas.list_nodes`                     | read               | 按类型/名称过滤                | 新建                        |
| `canvas.create_node`                    | write              | `addNode`               | 已有雏形                      |
| `canvas.update_node`                    | write              | `updateNodeData`        | 已有雏形                      |
| `canvas.connect_nodes`                  | write              | `addEdge`               | 已有雏形                      |
| `canvas.move_node`                      | write              | `updateNodePosition`    | 已有雏形                      |
| `canvas.group_nodes` / `canvas.ungroup` | write              | 分组                      | 新建                        |
| `canvas.auto_layout`                    | write              | `autoLayoutCanvas`      | 已有雏形                      |
| `canvas.delete_node`                    | **destructive**    | 需确认                     | 已有雏形                      |
| `canvas.undo` / `canvas.redo`           | write              | —                       | 已有雏形                      |
| **`canvas.run_node`**                   | **paid-operation** | **执行节点 → 返回 jobId；需确认** | **G2，需新建**                |
| **`canvas.run_chain`**                  | **paid-operation** | 按依赖跑一条链                 | **G2，需新建**                |
| `canvas.job_status`                     | read               | 查生成任务                   | 已有（`ai_generation_jobs`）  |

### 5.2 故事包 `story.*`（P2 新建）

`story.list` / `story.create` / `story.get_bible` / `story.upsert_entity` / `story.list_outline` / `story.upsert_outline` / `story.read_chapter` / `story.write_chapter` / `story.append_section` / `story.set_status`

**深化情节专用**（结构化指令，非自由聊天）：  
`story.expand_beat`（扩写节拍）/ `story.add_conflict`（加冲突）/ `story.motivate`（补动机）/ `story.branch`（给 3 个分叉走向）/ `story.critique`（批评并给修改建议）

### 5.3 提示词包 `prompt.*`

| 工具                                      | 权限         | 说明                                                  |
| --------------------------------------- | ---------- | --------------------------------------------------- |
| `prompt.list_library` / `prompt.upsert` | read/write | 提示词库（`promptLibraryStore`）                          |
| `prompt.compile_cinematic`              | write      | 调 `generateQuickPrompt`（`ai.ts:1772`）——**已存在，接线即可** |
| `prompt.plan_shots`                     | write      | 调 `planSceneShots`（`ai.ts:2435`）                    |
| `prompt.finalize`                       | write      | 调 `generateFinalPrompt`（`ai.ts:1758`）               |
| `prompt.optimize`                       | write      | 调 `optimizeSceneBrief`（`ai.ts:1400`）                |

### 5.4 素材库包 `library.*`

`library.search` / `library.list_categories` / `library.import_url` / `library.apply_to_canvas`  
（后端 `asset_library.rs` 已有能力）

### 5.5 媒体包 `media.*`

`media.probe`（ffprobe）/ `media.transcode` / `media.hls_import`（复用 `media_bridge.rs` 的 `/hls` 通道）

### 5.6 插件包 `mcp.*`（P4 动态）

`mcp.list_servers` / `mcp.list_tools` / `mcp.<server>.<tool>`（动态注册）

### 5.7 工具注册表的硬性要求

> **2026-10-06 修订**：选定外部 harness 后，工具以 **MCP 工具**形态注册（实现于 Rust，见 D1.3）。

- 每个工具声明：`name` / `description` / 入参 schema（**导出为 JSON Schema 供 MCP 与模型消费**）/ `permission` / `execute`
- 一条契约测试：**任何注册工具必须有 schema、权限、executor**——防止漂移
- 工具暴露数量上限由集成层控制（建议 ≤ 32），超出按上下文相关性裁剪后再生效
- 所有 `destructive` / `paid-operation` 工具**在 LenTalk 侧拦截**，未经确认不得执行——  
  **不依赖 harness 自身的审批策略**（Pi 没有；DSH 有但会随版本变化），否则换 harness 就丢闸门

---

## 6. 路线图

每阶段独立可验收，不追求一次做完。

### P0 · 集成验证 spike + 地基（不改任何现有行为）

> **2026-10-06 修订**：因运行时改为外部 harness（D1），P0 必须先做 spike 拿结论，再写生产代码。  
> **spike 是 P0 的放行条件**：5 个问题（D1.4）任一答"不能"，架构需改，此时返工代价最小。

**P0-A · 集成验证 spike（丢弃型原型，不进主干）**

1. 把 `dsh` 作为子进程拉起，确认能**流式**拿到中间过程（验证 D1.4-1）。
2. Rust 侧写一个**最小 MCP server**（只暴露 `canvas.get_snapshot` 一个工具），确认 harness 能连上并调用（D1.4-2）。
3. 在该工具上加一个**人工确认**环节，确认 harness 会等待（D1.4-3）。
4. 用一个**明确不支持 tool calling 的中转端点**实测 harness 行为（D2 的风险项）。
5. 记录 Node 依赖的打包方式与体积影响（D1.4-4）；确认会话存储位置可控（D1.4-5）。

**P0-A 验收**：`dsh` 启动 → 连上 LenTalk MCP server → 成功调用 `canvas.get_snapshot` 取到真实画布数据 → 全过程在 LenTalk UI 内可见流式进度。

**P0-B · 地基（spike 通过后开工）**

1. 补 `zod` 依赖（消除 `canvasTools.ts:1` 的潜伏编译断裂）——或改用手写校验。
2. **集成层**：harness 进程管理（spawn / 健康检查 / 停止 / 日志 / **版本 pin**）+ 流式事件 → 前端消息的转换。**参照 `pajuben.rs` 的"外挂进程 + 流式协议转发"范式**。
3. **会话数据主权**：`agent_*` 表（`agent_conversations` / `agent_messages`）+ 持久化命令，与 harness 自身日志解耦。
4. 自研 Chat UI（复用项目设计 token），从 `Canvas.tsx` 提到应用壳层；先实现**纯聊天**（不带工具）。
5. 扩展 `detect_provider_capabilities`：追加 `supportsToolCalling` / `supportsStreaming`，结果缓存进 `app_settings`（仅用于给用户提示）。

**P0 验收**：能在 LenTalk 自己的界面里与 harness 连续多轮对话、有流式输出；重启应用后会话还在；切换项目后历史不串；**工具层尚未接入**。  
**风险**：中（取决于 spike 结论）。**不触碰画布，不触碰现有生成链路。**

### P1 · MCP 工具服务 + 桥接 + 只读 Agent

**交付**

1. **LenTalk MCP Server（Rust）**：工具注册、入参 JSON Schema 导出、权限判定、审计写 `agent_tool_calls`。  
   工具实现按 D1.3 约束 3 **分流**：Rust 直执行（`story.*` / `media.*` / `library.*`）与 WebView 往返桥（`canvas.*` / `prompt.*`）。
2. **WebView 工具执行端点**：Rust → WebView 请求（带 `requestId`）→ 执行画布操作 → 回传结果。需处理超时、取消、并发关联。
3. **权限闸门**：`destructive` / `paid-operation` 工具在执行前必须经 UI 确认；与 harness 的审批策略对接（D1.4-3 的结论决定具体接法）。
4. 首批工具：`canvas.get_snapshot`、`canvas.list_nodes`、`story.*` 只读、`library.search`。
5. UI：工具调用卡片（可折叠查看 args / result）、权限确认弹窗。
6. **契约测试**：任何注册工具必须有 name / description / schema / permission / executor（防漂移）。

**验收**：问"这幅画布上有什么"能答对；问"把某个节点删掉"会**弹确认**而不是直接删。  
**风险**：中。首次引入 Rust↔WebView 往返桥，**这是本阶段最容易出 bug 的地方**（超时与关联错误会导致 UI 卡住）。  
**降险**：桥接必须带超时与失败回传，且单测覆盖"WebView 无响应"路径。


### P2 · 写剧情 · 写小说 · 写提示词（你的创作需求的正面解答）

**交付**

1. 新建 `src/features/story/` 创作工作台：设定集 / 大纲树 / 章节正文编辑器；三态（草稿/已确认/已过期）可视化。
2. **上下文装配器**：实体卡 + 滚动摘要 + 近 N 章原文 + 大纲路径 → 受 token 预算约束的 messages。这是长篇小说不崩的关键，**必须独立成模块并单测**。
3. 故事工具包写入侧 + 深化情节的结构化指令。
4. `prompt.*` 接线到 cinematicStudio 已有 AI 函数。
5. **故事 → 画布**：章节 → 文本节点 → `CinematicStudioNode` 的 `synopsis` 输入口（`CinematicStudioNode.tsx:398-419`）→ 生成视频节点。（下半段 `handleSendToVideo` 已存在，只需建上半段）

**验收**：从一句话 logline 长出设定集 + 大纲 + 至少一章正文；一键把一章变成分镜提示词并落到画布。  
**风险**：中。全新模块，但与现有代码耦合最浅，可并行推进。

### P3 · 打通画布执行（**已决策暂缓，改走退路** ⚠️）

> **2026-10-06 决策**：本阶段**暂不实施**。改用 §7.4 的退路方案——Agent 负责建图与填参，用户在画布上点生成。  
> 下方内容作为**未来升级路径**保留；若退路方案验证下来价值足够，再回来做。

**交付（未来）**

1. **抽取 `src/features/canvas/application/nodeExecution.ts`**，对外暴露 `runNode(nodeId, options)`。
2. 把 `ImageEditNode.handleGenerate`(749) / `VideoGenNode.handleGenerate`(1144) / `AudioGenNode` 改为**薄壳调用**该模块——**纯抽取，不改行为**。
3. 工具：`canvas.run_node` / `canvas.run_chain` / `canvas.job_status`。
4. （可选，独立评估）"生成完成事件"→ 自动触发下游：需在 `Canvas.tsx` 图片落结果处（`1581`）与视频落结果处（`2015`）加"扫描下游边并触发"的逻辑。

**为什么风险最高**：`ImageEditNode` / `VideoGenNode` 是项目最复杂的组件（含参数联动、`extraParams`、CLI 兼容分支、2 秒冷却与多任务记账），抽取过程容易引入行为回归。

**降险措施**

- **纯抽取优先**：先只搬不改，保持函数边界与副作用顺序完全一致；**分两次提交**（先抽取、后接线）。
- 抽取后立刻回归：图片生成、视频生成、断点续传（重启后续跑）、CLI 链路各手测一遍。
- 跑 `npx tsc --noEmit` + `cargo check` + `npm test`。
- 若发现抽取代价过高，**退路**：Agent 只负责"把节点和参数准备好"，最后由用户在画布上点一次生成。这仍能满足大部分创作流程，且零风险。

**验收**：Agent 说"生成一张图"→ 建节点 → 跑起来 → 返回结果；`paid-operation` 必须经确认。

### P4 · 插件系统（MCP 优先）

**交付**

1. Rust MCP client：stdio（子进程 + JSON-RPC 分帧）+ Streamable HTTP/SSE。
2. 命令：`mcp_list_servers` / `mcp_upsert_server` / `mcp_remove_server` / `mcp_list_tools` / `mcp_call_tool` / `mcp_server_status`。
3. `plugins` 表 + 插件管理页（安装 / 启用 / 停用 / 删除 / 查看工具与权限 / 连接状态）。
4. 动态工具合并进 `ToolRegistry`（`mcp.<server>.<tool>`），权限按 server 白名单。
5. **安全收口**：设 CSP、收窄 `fs` 范围、评估 `withGlobalTauri`。

**验收**：装一个官方 filesystem MCP server，Agent 能列目录并读文件（且按白名单受控）。  
**风险**：中—高（安全面）。**但零"执行注入代码"风险**——MCP server 是独立进程。

### P5 · 按需扩展

- 声明式 HTTP 工具插件（零代码接自有 API）。
- 沙箱内 UI 插件（`iframe` + postMessage，复用 `threeDDirector` 的 `hostBridge` / `pluginResultRegistry` 范式）——**必须在 P4 的安全收口之后**。
- 插件分发（可复用 `template_sync.rs` 的共享盘机制，或接远端仓库）。

---

## 7. 决策记录

### 7.1 已定（2026-10-06）

| # | 决策             | 结论                                | 影响                                                                                                                                   |
| - | -------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1 | **插件协议**       | **走 MCP**                         | 分两个方向落地：**① 用户装插件** = harness 连用户的 MCP server；**② LenTalk 自身能力** = LenTalk 实现 MCP server 供 harness 调用。第二档（声明式 HTTP）与第三档（沙箱 UI 插件）暂不做 |
| 2 | **实施顺序**       | **按 P0 → P1 → P2 → P4 推进**        | 第一步是集成验证 spike（P0-A），通过后再写生产代码                                                                                                       |
| 3 | **P3 节点执行器抽取** | **暂缓，改用退路方案**                     | Agent 只负责把节点、参数、提示词准备好并连线，**由用户在画布上点一次生成**。零回归风险。详见 §7.4                                                                             |
| 4 | **Agent 运行时**  | **引入外部 harness：DSH 优先，Pi 作为轻量退路** | 详见 D1。**上两层架构重画**；工具层 / 数据表 / 画布接口原样保留。理由：项目已定的"MCP 插件"与"付费需确认"两条需求，恰好都是 DSH 原生、Pi 缺失                                                |

### 7.2 待定

| # | 决策                    | 现状                                                                     | 阻塞什么                                                                                            |
| - | --------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 5 | **DSH 还是 Pi（最终二选一）**  | 已列选型对比（D1.1）与推荐（D1.2），待 spike（P0-A）实测后定稿                               | P0-A 之后的全部工作。**必须承认 DSH 是 v0.1 预览、周更、有破坏性变更**，若团队对稳定性要求高于功能，应转向 Pi 并接受"自建 MCP 客户端 + 自建权限层"的额外成本 |
| 6 | **Node.js 依赖如何打包**    | Tauri 安装包是否内置 Node？项目已有 Python 引擎 + sidecar 二进制先例，但 Node 尚未进过包         | 影响安装包体积与用户门槛。P0-A 第 5 项一并验证                                                                     |
| 7 | 安全收口时机                | 建议 P4 内                                                                | 不阻塞 P0–P2                                                                                       |
| 8 | 是否需要本地/离线模型（Ollama 等） | 现有 `custom:<id>` + OpenAI 兼容可直接填 `http://127.0.0.1:11434/v1`，**无需新代码** | 不阻塞                                                                                             |

### 7.3 已确认的环境前提

- 画布页面已预留 Agent 接口（`Canvas.tsx:4769` 渲染 `AgentPanel`，`AgentPanel.tsx` 为占位实现），**接线位置现成**。
- 当前无任何外部 Agent 运行时依赖；若引入外部方案，属**新增依赖**，需评估其在 Tauri WebView 中的可用性与打包体积。

### 7.4 P3 退路方案的明确边界（因决策 3 而启用）

**Agent 能做到**：建节点、填参数、写提示词、连线、分组、排版、撤销重做、查生成任务状态。  
**Agent 不能做到**：点"生成"。

**实际工作流**：

```
用户对 Agent 说：「把第 3 章改成 4 个分镜，出图」
  → Agent: story.read_chapter(3)
  → Agent: prompt.plan_shots(...)         ← 复用 cinematicStudio 已有能力
  → Agent: canvas.create_node × 4 + canvas.connect_nodes × 4
  → Agent: 「4 个分镜节点已就绪，参数和提示词都填好了，请点生成」
  → 用户: 在画布上点 4 次生成
```

**验收仍需覆盖**：Agent 编排出来的节点图，用户直接点生成必须能正常出图——即"Agent 建图"与"人工建图"在结果上不可区分。

> 若后续要升级为"Agent 直接出图"，只需补 P3 的抽取；**退路方案的产物不会浪费**，因为工具定义、权限模型、上下文装配器都可原样复用。

---

## 8. 验证策略

遵循 AGENTS.md §6，另加针对 Agent 的专门防线。

### 8.1 每阶段必跑

```bash
npx tsc --noEmit          # 类型
cd src-tauri && cargo check
npm test                  # vitest
```

### 8.2 Agent 专有测试

> **2026-10-06 修订**：工具调用协议由 harness 负责（D2），故初稿的"SSE 工具调用解析测试"与  
> "JSON 伪工具兜底测试"**不再由 LenTalk 承担**。新增 Rust↔WebView 桥接测试。

| 测试                  | 类型        | 目的                                                            |
| ------------------- | --------- | ------------------------------------------------------------- |
| **工具契约测试**          | 纯函数       | 所有注册工具都有 name / description / schema / permission / executor  |
| **MCP server 契约测试** | Rust      | 工具列表符合 MCP 规范；入参 schema 合法；非法入参被拒                             |
| **桥接往返测试**          | Rust + 前端 | `requestId` 正确关联；**WebView 无响应时超时并回传失败而非永久挂起**；并发多请求不串号；取消能生效 |
| **权限闸门测试**          | 纯函数       | `destructive` / `paid-operation` 未确认时**一定被拒**（含 harness 绕过尝试） |
| **上下文装配器测试**        | 纯函数       | token 预算不超限；实体卡必进；摘要裁剪顺序正确                                    |
| **集成层流式解析测试**       | 纯函数       | harness 输出的流式事件能正确转成前端消息；中途崩溃能被识别为失败而非静默截断                    |
| **harness 版本兼容测试**  | 集成        | 升级 harness 后集成层仍可用（**因 DSH 周更，此项必须长期保留**）                     |
| **人工端到端**           | 手测        | 至少 1 条主路径 + 1 条异常路径（工具失败 / harness 子进程崩溃）                     |

### 8.3 回归红线（P3 抽取时）

图片生成、视频生成、断点续传、CLI 链路、分组、撤销重做——六条主路径全部手测通过才算完成。

---

## 9. 风险清单

| 风险                                         | 等级              | 说明与缓解                                                                                           |
| ------------------------------------------ | --------------- | ----------------------------------------------------------------------------------------------- |
| **harness 版本churn**（DSH v0.1 预览、周更、破坏性变更）  | **高**           | **pin 版本**，不跟 latest；集成层做薄，只依赖 MCP 与子进程 stdout 两个稳定面；保留"换 Pi"的退路（这正是用 MCP 解耦的价值）；§8.2 的兼容测试长期保留 |
| **Rust↔WebView 往返桥出 bug**（超时/关联错→UI 卡死）    | **高**           | 桥接必须带超时与失败回传；单测覆盖"WebView 无响应"；工具执行按"是否需 WebView"分流（D1.3 约束 3）以缩小桥接面                            |
| **P3 抽取节点生成逻辑引入回归**                        | ~~高~~ → **已降级** | 决策 3 已暂缓该阶段，改用退路方案，风险归零。若未来启用，缓解措施见 §6 P3                                                       |
| **中转平台不支持 tool calling**                   | 中               | 已由 harness 接管（D2）；但仍需 spike 实测 harness 的降级行为，并在无降级时给用户明确提示                                      |
| **Node.js 依赖打包**                           | 中               | P0-A 第 5 项先验证；项目已有 Python 引擎 + sidecar 先例可参照                                                    |
| **长篇小说上下文爆炸**                              | 中               | 上下文装配器独立模块 + token 预算单测；滚动摘要                                                                    |
| **插件安全面**                                  | 中—高             | 先 MCP（server 是独立进程，零代码注入）；安全收口作为沙箱 UI 插件的前置条件；参照 `media_bridge.rs`                              |
| **`zod` 缺口**                               | **低但紧急**        | P0-B 第 1 项解决，否则任何 import 该文件的改动都会构建失败                                                           |
| **双 UI 割裂**（用户拿 DSH 自带 UI 与 LenTalk UI 混用） | 中               | 明确约束：DSH 自带 UI 仅作开发调试，产品内一律自研 Chat UI（D1.3 约束 2）                                                |
| **成本失控**（Agent 反复调付费工具）                    | 中               | `paid-operation` 一律确认 + 审计表 + 单会话调用次数上限                                                         |
| **文件规模失控**                                 | 中               | C3 约束：Agent 代码不得进 `canvasStore.ts` / `Canvas.tsx`；新文件按 400 行舒适区切                                |

---

## 10. 一句话路线

**P0-A 验证 harness 能否接进来（spike）→ P0-B 让聊天真的能聊 → P1 让 Agent 能看和问 → P2 让它会写故事和提示词 → P4 让它能装插件。**

> 原路线中的 P3（让 Agent 直接触发出图出片）**已决策暂缓**，改用「Agent 备好、用户点生成」的退路方案（§7.4）；  
> 实施顺序按已定决策走 **P0 → P1 → P2 → P4**。

**两个当前最关键的点**：

1. **P0-A 的 spike 是唯一放行闸门**。它只回答 5 个问题（D1.4），但任一答"不能"，架构就要改——  
   此时返工代价最小。**不要在 spike 通过前写生产代码。**
2. **P2 是创作需求的正面解答**（写小说、深化情节、写提示词），可以独立于 harness 选型并行推进，  
   因为它依赖的是 cinematicStudio 已有的 AI 能力，不依赖 agent 循环。
