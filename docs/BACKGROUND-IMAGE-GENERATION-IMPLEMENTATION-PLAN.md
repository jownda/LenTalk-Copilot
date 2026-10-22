# 画布图片后台生成实施方案

状态：已实施，待桌面端手工验收

## 1. 目标

用户在画布发起图片编辑或分镜图片生成后，可以立刻切换到项目管理页、打开其他项目或关闭画布视图。任务必须继续在桌面端运行；重新打开原项目时，生成结果应自动写回原结果节点。

本方案只覆盖图片生成。视频生成保持现有独立流程，不能被本次改动带入或重构。

## 2. 当前问题

`ImageEditNode` 和 `StoryboardGenNode` 当前将 `generationMode` 固定为 `sync`，调用 `canvasAiGateway.generateImage()` 后等待图片返回。

```text
节点组件 -> invoke(generate_image) -> 等待供应商响应 -> 节点写入图片
```

切到项目管理页会使 `Canvas` 卸载，因为 `App.tsx` 只在存在 `currentProjectId` 时渲染它。关闭项目会立即持久化当时的节点快照；之后同步回调即便完成，也不再通过已卸载的 Canvas 持久化回原项目。

项目已具备可复用基础：

| 已有能力 | 位置 | 现状 |
| --- | --- | --- |
| SQLite 生成任务表和状态查询 | `src-tauri/src/commands/ai.rs` | 可保存 `running/succeeded/failed` 与结果 |
| 任务 ID 与轮询接口 | `src/commands/ai.ts` | 已有提交、查询 DTO |
| 画布恢复轮询 | `src/features/canvas/Canvas.tsx` | 可从 `generationJobId` 查询并把结果写回节点 |
| 节点请求快照 | 图片节点 | 已持久化 `generationRequest`、供应商、模型和参考图 |

阻塞点在于：对同步供应商，`submit_generate_image_job` 仍在调用 `provider.submit_task()` 后等待 `provider.generate()` 完成，任务 ID 不会立刻返回。因此同步链路没有真正进入后台。

## 3. 设计结论

### 3.1 统一任务模型

所有图片生成统一使用“先创建本地任务，再执行”的流程。供应商是否具有自己的异步任务 API 只是后台任务的内部实现细节。

```text
点击生成
  -> 创建结果节点（isGenerating=true，保存完整 generationRequest）
  -> 桌面端创建 generation_jobs 记录并立即返回 jobId
  -> 节点写入 jobId，立即持久化项目
  -> 桌面后台执行供应商请求或轮询供应商任务
  -> Canvas 在显示时轮询 jobId
  -> 成功：写入图片并清除 generationRequest/jobId
  -> 失败：写入错误并保留可重试请求
```

### 3.2 两类本地任务

| 类型 | 适用情况 | `resumable` | 应用重启后 |
| --- | --- | --- | --- |
| 外部可恢复任务 | 服务商已返回外部 task ID，且存在可靠查询接口 | `true` | 继续查询原任务 |
| 本地后台任务 | OpenAI Images 等同步 HTTP 请求 | `false` | 标记为“应用退出时任务中断”，保留请求供用户明确重试 |

不得假设 OpenAI Images 的同步请求可在应用重启后继续查询。重启后绝不自动重新提交，避免重复扣费。

### 3.3 不变量

1. 后端必须先将 job ID 写入 SQLite，再启动后台请求；前端收到 job ID 后必须立即以非 transient 更新写入项目快照。
2. 同一结果节点最多拥有一个活动任务；同一 `generationRequest` 不得自动重复提交。
3. 关闭项目只停止 Canvas 的轮询，不取消桌面端已启动的本地后台任务。
4. 用户重新打开项目时，只轮询已有 job ID；没有 job ID 的旧同步任务只显示“可重试”，不得自动重发。
5. 只有成功拿到并处理图片后才清空 `generationRequest` 和 `generationJobId`。
6. 任务失败、网络失败和应用重启都要留下明确状态和可复制错误；不得显示永久转圈。

## 4. 实施步骤

### P0. 定义后台图片任务契约

文件：`src-tauri/src/commands/ai.rs`、`src/commands/ai.ts`、`src/features/canvas/application/ports.ts`

1. 保留现有 `submit_generate_image_job` 和 `get_generate_image_job` 命令名，避免前端接口扩散。
2. 在请求 DTO 的 `extra_params` 中读取显式 `request_mode`：只有明确为 `async` 且供应商确实返回外部 task ID 时，走外部可恢复任务。
3. 其余图片请求统一创建 `resumable=false` 的本地后台任务：
   - 先插入 `generation_jobs(status=running)`；
   - 将 `provider.generate(request)` 放入 `tauri::async_runtime::spawn`；
   - 后台完成后更新 `succeeded + result` 或 `failed + error`；
   - 命令立即返回本地 `jobId`，不得等待图片结果。
4. 为本地后台任务保留 30 分钟硬超时；失败时记录原因。
5. `get_generate_image_job` 对 `resumable=false` 且当前进程仍活跃的任务返回 `running`；进程重启后将它标记为 `failed`，错误固定为“应用退出时任务中断，可从节点重试”。

验收：在一个人为延迟的同步供应商请求中，提交命令应在短时间内返回 `jobId`，不等待图片下载完成。

### P1. 图片节点改为只提交任务

文件：

- `src/features/canvas/nodes/ImageEditNode.tsx`
- `src/features/canvas/nodes/StoryboardGenNode.tsx`

1. 删除两个节点中 `generationMode === 'sync'` 的直接 `generateImage()` 分支。
2. 结果节点创建时保留并立即写入：
   - `isGenerating`
   - `generationStartedAt`
   - `generationRequest`
   - `generationProviderId`
   - `generationSourceType`
   - `generationClientSessionId`
3. 完成参考图规范化、自动比例计算和 API Key 注入后，始终调用 `submitGenerateImageJob()`。
4. 收到 `jobId` 后使用非 transient 更新写入 `generationJobId` 与诊断上下文，确保项目关闭前可立即落盘。
5. 节点组件不再处理图片成功结果；成功、失败和图片元数据写入全部交给 Canvas 的统一轮询器，避免两套完成逻辑。

验收：点击生成后结果节点立刻显示生成中；网络慢时仍可在 1 秒内获得可持久化的 job ID。

### P2. 收敛 Canvas 轮询与恢复

文件：`src/features/canvas/Canvas.tsx`

1. 保留现有按 `generationJobId` 的轮询主路径，并将它作为唯一完成入口。
2. 删除恢复逻辑中 `generationMode === 'sync'` 时直接再次调用 `generateImage()` 的分支。没有 job ID 的旧节点不能自动重发。
3. 对旧项目中 `isGenerating=true` 但无 job ID 的同步节点：
   - 设为失败；
   - 显示“旧版同步任务未保存后台任务 ID，请手动重试”；
   - 保留 `generationRequest`。
4. 成功时沿用已有 `prepareNodeImage()`、缩略图、分镜网格元数据嵌入和 `recordGenerationOutcome()`；清理任务字段并持久化。
5. 失败时沿用已有错误报告与 `resolveErrorContent()`，包括 65535 的系统代理提示；保留可重试请求。
6. Canvas 卸载仅停止轮询协程，不得更改任务状态、删除 job ID 或清理后台执行集合。

验收：切项目后再返回，原节点自动从同一 job ID 获取结果；日志中不存在第二次 `submit_generate_image_job`。

### P3. 项目关闭与持久化顺序

文件：`src/stores/projectStore.ts`、`src/features/canvas/Canvas.tsx`

1. 在关闭项目时，立即保存含 `generationJobId` 的最新节点快照；不要等待 Canvas 防抖保存。
2. 确认 `generation_jobs` 和项目快照都使用统一 SQLite 数据库，保证任务记录与项目记录在同一应用数据目录。
3. 重新打开项目时，先恢复节点快照，再启动任务轮询；轮询前按节点保存的供应商 ID 重新注入 API Key。
4. 将任务数据库保留策略写清楚：成功/失败任务保留用于诊断，按现有清理策略淘汰，不影响正在运行任务。

验收：生成开始后立即切到项目管理页，等待完成再打开项目，结果节点显示图片且项目没有丢失连线或参考图。

### P4. 用户可见状态

文件：结果节点 UI、错误对话框相关组件

1. 生成中状态显示“后台生成中”，用户离开画布后再次进入仍能看见。
2. 外部可恢复任务显示“可在重启后继续查询”；本地后台任务可显示“应用保持运行即可完成”。
3. 本地后台任务因应用退出失败时，显示“应用退出时任务中断”，提供明确的“重试”入口。
4. 不添加全局任务中心作为本次前置条件。可在后续版本基于 `generation_jobs` 增加，但不能阻塞后台生成落地。

验收：用户不需要理解同步/异步协议，也能知道任务是否仍在运行、是否需要重试。

## 5. 数据与兼容性

1. 不修改已保存的图片、历史记录或项目 ID。
2. 新字段优先复用既有 `generationJobId`、`generationRequest`、`generationProviderId`、`generationClientSessionId`，避免引入第二套任务状态。
3. 若需要新增 `generationMode` 值，使用 `background`；加载旧值 `sync/async` 时保持可读，统一按“有 job ID 则轮询、无 job ID 则不自动重发”处理。
4. 旧同步节点的自动恢复行为是高风险重复扣费源，必须迁移为“失败但可手动重试”，不可静默重提。
5. `generation_jobs.result` 可能保存 Base64 Data URL。实现前确认当前 SQLite 列与图片池编码的容量；如果结果体积导致数据库膨胀，再单独设计结果文件/图片池引用迁移，不在本次顺手修改。

## 6. 测试清单

### Rust 单元测试

1. 同步请求提交后立即返回 job ID，后台完成后状态从 `running` 变为 `succeeded`。
2. 后台请求报错后状态为 `failed`，错误文本可读取。
3. 非可恢复任务在模拟进程重启后变为“应用退出时任务中断”。
4. 显式异步供应商任务继续保存外部 task ID，并通过原查询接口完成。

### 前端单元测试

1. 图片编辑和分镜生成均调用 `submitGenerateImageJob`，不调用 `generateImage`。
2. 收到 job ID 后，节点保存 `generationJobId` 和完整 `generationRequest`。
3. Canvas 恢复时对存在 job ID 的节点只查询、不重复提交。
4. Canvas 恢复时对旧同步且无 job ID 的节点不自动扣费重试。
5. 成功与失败后字段清理、错误报告和重试入口符合现有行为。

### 桌面手工验收

1. 用 65535 发起带参考图的 4K 图片编辑，任务卡出现后立即返回项目管理页；等待完成后重新打开项目，图片存在。
2. 用分镜生成节点重复上述流程，确认网格元数据和缩略图正常。
3. 生成中切换到另一个项目，再切回，确认原任务不重复提交。
4. 生成中退出整个应用并重开，确认节点显示可重试的中断状态，不自动再次扣费。
5. 关闭系统代理触发 65535 网络错误，确认显示“开启系统代理后重试”；开启后重试成功。

## 7. 交付顺序

1. 先完成 P0，并为 Rust 任务状态补测试。
2. 完成 P1 后只在图片编辑节点手测，确认可切页恢复。
3. 完成 P2 和 P3 后接入分镜生成节点、旧项目兼容和项目切换测试。
4. 完成 P4 与全部测试后，运行 `npx tsc --noEmit`、`cargo check`、`npx vitest run`，再进行桌面端手工验收。

## 8. 完成标准

以下条件全部满足才可发布：

1. 生成中的图片任务在切换到项目管理页后继续完成。
2. 返回原项目后图片自动写回同一结果节点。
3. 不会因为切页或恢复导致同一请求重复提交。
4. 应用重启不会假装能恢复同步上游请求，也不会静默重复扣费。
5. 图片编辑、分镜生成、普通图生图和带参考图请求均通过回归。
