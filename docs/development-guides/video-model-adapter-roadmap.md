# 视频模型适配改造路线图

## 目标

让 AI 视频节点对模型差异有明确的适配边界。前端只提交统一任务；Rust 本地网关按模型 profile 完成请求、参考资源处理、轮询和结果解析。平台配置只保存 Base URL 与 API Key，不再把所有视频模型假定为同一个接口。

当前已验证的事实：WGSPAI 的 Minimax H3 可通过 OpenAI Video 协议工作；WGSPAI 的 Seedance 2 需要独立确认参考图、画幅和任务字段，不能与 Minimax 共用假设。

## 阶段 0：冻结与记录

产物：一份已验证模型清单和脱敏响应样本目录。

- 标记 Minimax H3 为“已验证”；Seedance 2 标记为“待适配”。
- 为每个模型记录提交 URL、成功响应、查询响应、失败响应、支持的参考图/音频方式。
- 不继续在 UI 或通用请求函数中为单个报错增加临时猜测分支。

验收：任意模型的可用状态都有对应的真实请求样本；不包含 API Key、图片 Base64 或用户提示词原文。

## 阶段 1：定义统一视频任务

产物：前端与 Rust 共享的 `VideoGenerationRequest` DTO。

- 统一字段：`modelId`、`prompt`、`duration`、`aspectRatio`、`referenceImages`、`referenceAudio`、`firstFrame`、`lastFrame`。
- 将节点里的 `imageMode` 映射为 DTO，节点 UI 不直接决定 API 字段名。
- 为 `referenceImages` 标注来源类型：公开 URL、Data URL、本地文件、平台文件。

涉及模块：`src/features/canvas/application/ports.ts`、`src/commands/ai.ts`、`src-tauri/src/commands/ai.rs`。

验收：同一份 DTO 可以表示文生视频、参考图、首尾帧和音频参考，不含供应商专用字段。

## 阶段 2：建立模型 Profile 注册表

产物：`VideoModelProfile` 注册表，按模型 ID 选择链路。

每个 profile 声明：

- 认证类型：Bearer API Key 或平台会话令牌。
- 提交/查询端点和 HTTP 方法。
- 请求字段映射：模型、时长、`size`、画幅、首尾帧、音频。
- 参考图目标：Data URL、公开 URL、平台文件上传。
- 任务 ID、状态、视频 URL 的响应路径。
- 支持能力和限制：可选画幅、最长时长、最多参考图、是否支持音频。

初始 profile：`openai-video`、`minimax-h3`、`seedance-v2`。`openai-video` 只承载已遵守标准协议的模型；Seedance 不自动归入它。

验收：新模型的接入主要是新增 profile 文件与测试，而不是修改节点组件或通用分支。

## 阶段 3：迁移网络调用到 Rust 网关

产物：单一 Tauri 命令，例如 `generate_video_with_profile`。

- React 只调用该命令并接收任务状态/最终视频 URL。
- Rust 负责 HTTP、超时策略、轮询、错误脱敏、文件上传和临时资源清理。
- Windows、macOS 使用相同 Rust 网络链路，避免 WebView CORS 与权限差异。
- 保留当前前端链路作为短期回退，迁移完成一个 profile 后删除对应回退。

验收：网络请求不再散落在 `src/commands/ai.ts` 和画布网关；平台 API Key 不进入浏览器 fetch。

## 阶段 4：先固化 Minimax H3

产物：Minimax H3 的稳定 profile 与契约测试。

- 固定当前已验证的 WGSPAI OpenAI Video 提交/查询协议。
- 覆盖 16:9、9:16、无参考图、单参考图和任务失败五种响应样本。
- 将实际视频分辨率回写到下游节点，校验平台是否遵守请求画幅。

验收：同一配置连续生成时不需要端点探测；失败信息显示模型、端点和平台错误摘要。

## 阶段 5：单独适配 Seedance 2

前置条件：取得 WGSPAI/Seedance 的成功 cURL 示例，包括参考图、16:9 和查询任务示例。

- 按示例实现独立 profile，不复用 Minimax 的字段猜测。
- 明确参考图是否必须上传、文件 URL 是否需要签名、首尾帧字段和可选时长。
- 若模型不支持音频参考，在节点生成前给出能力错误，不静默忽略。

验收：文本、参考图、16:9、9:16 各至少有一次真实成功记录；不支持的能力能清晰提示。

## 阶段 6：测试、可观测性与发布

产物：profile 单元测试、响应 fixture、脱敏日志和模型状态展示。

- 每个 profile 测试请求体、任务 ID 提取、轮询终态、视频 URL 提取和错误映射。
- 日志只保存端点、模型、字段名、图片数量、耗时与响应摘要，绝不保存 API Key 或 Base64。
- 设置页显示“已验证 / 待适配 / 不支持”的模型状态；普通用户不需要手填 JSON。

验收：平台接口变动可由契约测试定位；发布前执行 `npx tsc --noEmit`、`cargo check`、profile 测试和 `npm run build`。

## 设置页调整原则

阶段 0 到阶段 4 不需要重做设置页。现有的平台名称、Base URL、API Key、图片模型和视频模型字段足以先固化已验证的模型 profile。

后续只做以下必要调整：

- 移除或隐藏“视频 Access Token”。WGSPAI 已确认公开 API 使用 Bearer API Key，独立令牌字段容易把网页登录令牌与 API Key 混用。
- 在视频模型旁显示 profile 状态，例如“OpenAI Video / 已验证”“Seedance 2 / 待适配”“不支持参考音频”。
- 普通用户只配置平台与选择模型；profile 自动决定端点和字段映射。
- 高级模式才允许覆盖端点、参考资源策略或轮询路径，并且需要显著标注为实验性配置。

验收：新用户不需要填写请求 JSON 就能使用已验证模型；模型能力与可用状态在设置中可见。

## 实施顺序

先完成阶段 0 到 4，使 Minimax H3 稳定可用；随后以真实接口样本完成 Seedance 2。不要同时迁移所有视频模型，也不要为了兼容未知接口继续增加多端点轮询或重复提交。
