# 电影提示词引擎 V2 优化文档（LenTalk-Copilot 集成版）

> 关联旧文档：`cinematic-prompt-studio/docs/CINEDANCE-ACTING-OPTIMIZATION.md`（旧仓库、旧路径）。
> 本文件**重新立项**：以集成后的真实代码路径为准，重新记录现状，并把最近一次实测生成结果的走查问题收进 V2 优化清单。
>
> 代码根：`src/features/cinematicStudio/`
> 原则不变：本文档只描述改动，不直接实现；按 V2-P0 → V2-P2 顺序执行，每个改动独立提交、独立验收。

---

## 1. 现状记录（集成后已存在的能力）

下面按旧文档的模块登记，标注集成后的代码位置与状态，避免新旧项目路径混用。

| 模块 | 代码位置 | 状态 |
|---|---|---|
| 导演级分段输出 | `engine/compiler/director.ts`（`compileDirectorSequence` + `DIRECTOR_LAYERS`） | 已实现 |
| 上下文隔离（逐镜活动引用） | `engine/compiler/renderer.ts`（`buildSceneAssetRegistry` scope="shot"） | 已实现 |
| 负面词局部锁 | `engine/compiler/sections.ts`（`renderLocalLocks`） | 已实现 |
| 长镜头/多镜头模式 | `shared-types` `scene.shootingMode`；`sections.unifiedCameraForScene` | 已实现（结构层） |
| AI 编译分镜 + 导演分层 | `app/providers/ai.ts`（`fillSceneDraft` + `directorLayers` + schema） | 已实现（缺质量门） |
| 首帧占位锁 / 光线方向 / 光学 FOV / 相机行为 / 物理锚点 | `shared-types` + `ai.ts` normalize + `director.ts` 各层 | 已实现 |
| 表演目标 / 表演 0–5 / 眼部生活 / 声音锁 | `sections.renderActingSection` / `renderVoiceLockLines` | 已实现 |
| 连续性检查 | `engine/continuity.ts` | 已实现（不覆盖 AI 层文本） |
| 分层文档锁定（lockedDirectorLayers） | `shared-types` 类型已存在 | 部分（需确认 UI 落点） |

### 1.1 当前编译路径的关键特征（与 V2 问题直接相关）

1. `compileDirectorSequence` 里 **`scene.directorLayers` 存在时直接按层序拼接透传**，不再走结构化编译。
   也就是说：AI 写出来的分层文本是什么，最终提示词就是什么——**AI 层文本没有任何质量门**。
2. `ai.ts` 的 `fillSceneDraft` 把**项目里全部角色/道具资产**都放进 prompt（`CHARACTER ASSETS` / `PROP ASSETS`），
   而不是只给「本场景实际引用」的资产，AI 因此会提到未使用资产。
3. `normalizeDirectorLayers` 只做 canonical key 过滤 + trim，**无内容校验**（无分镜结构检查、无术语检查、无去重）。
4. 结构化编译路径本身较干净：资产只收集被引用的；身份强锁只在 POSITIVE CONSTRAINTS 出现一次。
   所以 V2 的攻击面主要在 **AI 分层文档（directorLayers）路径**，结构化为回退兜底。

---

## 2. V2 优化问题清单（来源：实测生成结果走查）

以下每条给「实测证据 → 问题定性 → 改动方案 → 涉及文件」。
证据取自一次中文界面实测输出（林sir / 无尽地铁车厢片段）。

---

### V2-P0-1 多镜头标签与单条连续时间轴矛盾（结构级）

**证据**

```text
格式模式
CONTROLLED MULTI-SHOT SEQUENCE：以低角度沉思特写为主的受控多镜头段落…

动作时序
0:00-0:05：… 0:05-0:11：… 0:11-0:17：… 0:17-0:23：…
0:23-0:29：… 0:29-0:34：…
```

**问题**：声明「多镜头序列」，实际却是一条 0:00–0:34 的单一连续时间轴、单一机位关系。
平台单次生成上限（通常 5–10s）下后半段会被截断或忽略；「多镜头」标签形同虚设。

**改动**

1. 新增规则：`formatMode == CONTROLLED MULTI-SHOT SEQUENCE` 时，
   `actionTiming` / `camera` / `physics` 层必须按镜头分块，每块带镜头号 + 时长 + 机位 + 内容；
   只有 `SINGLE CONTINUOUS TAKE` 才允许连续时间轴。
2. AI 规则里显式写明这条（见 V2-P0-4），并且**结构化编译路径的 ACTION TIMING 时间块补上镜头号前缀**（现状：`renderActionTimingLayer` 输出的 TIME BLOCK 不带镜头号）。
3. 校验器：`directorLayers` 已存在且为 multi-shot 时，检测「连续时间轴 + 无镜头分块」→ error；
   error 时丢弃该层，回退结构化编译（每镜一卡，天然分块）。

**文件**：`engine/compiler/director.ts`、`engine/compiler/sections.ts`、`app/providers/ai.ts`、新校验模块（V2-P2-1）。

---

### V2-P0-2 未引用/未启用资产泄漏进最终提示词

**证据**

```text
启用资产：@无尽地铁车厢、@林sir、@阿俊，未启用琪琪与黛莲。
…
动作时序：0:11-0:17：他看向镜头附近的琪琪所在方向但不让琪琪入画…
```

**问题**：a) 「启用资产 / 未启用」是项目管理元数据，不属于画面指令，应永远不导出；
b) 更严重的是正文点名未启用的琪琪——模型看到名字就可能真画出她；
c) 根因是 AI 拿到了项目全部资产清单，而非场景实际引用集合。

**改动**

1. `fillSceneDraft` 的输入侧：资产清单只保留「本场景实际引用」——`staging.locationAssetId`、
   各镜头 participants / beats / propStates / characterOrder 里出现的 id；其余资产不进入 AI prompt。
2. AI 规则写死禁区：`directorLayers` 及任何层里**禁止出现未被镜头引用的资产名**、
   **禁止出现“启用/未启用/仅用于项目”类语句**；需要表达空间关系时写「镜头右前方的空位方向」而非角色名。
3. 校验器：扫描各层文本中的 `@资产名` 与裸资产名，出现「不在场景引用集合内」的名字 → error；
   出现元数据关键词（启用资产 / 未启用 / 未使用）→ error，编译时剔除该句或整层回退。
4. 导出净化管道兜底：最终文本出口统一执行一次过滤（见 V2-P1-3）。

**文件**：`app/providers/ai.ts`、新校验模块、编译入口。

---

### V2-P0-3 首帧锁定与场景地图道具冲突

**证据**

```text
场景地图 …前景是林sir的膝盖、鞋和散落烟头…
首帧锁定 …首帧不得出现阿俊正脸，不得加入其他人物或新道具。
```

**问题**：首帧「禁止新道具」与场景地图把「散落烟头」列为前景内容互相打架；烟头到底算不算新道具，模型无法判断。

**改动**

1. AI 规则：首帧锁的语句改为「不得加入本场景未指定的角色或道具」；
   场景地图已列出的道具（烟头等）视为已指定，不冲突。
2. 校验器：检测「禁止新道具 / no new props」与首帧/场景地图中出现具体道具的并存 → warning，提示换措辞。

**文件**：`app/providers/ai.ts`、新校验模块。

---

### V2-P1-1 光学术语矛盾（广角 vs 压缩感）

**证据**

```text
光学
采用约84度标准视场的短焦压缩感…
```

**问题**：84° 是广角，特征是近大远小、纵深拉伸；「压缩感」是长焦（29°/18°/8°）的特性。两者并写在一条指令里
是自相矛盾，模型执行方向不确定。

**改动**

1. 建立术语冲突白名单（常量表）：`84-wide / 107-ultrawide ↔ 压缩感 / 空间压缩 / compression` 冲突；
   `29-short-tele / 18-tele / 8-supertele ↔ 拉伸 / 近大远小 / perspective stretch` 冲突。
2. AI 规则引用白名单：OPTICS 层只允许「FOV 度数 + 可观测光学校果」，禁止混用矛盾词。
3. 校验器：命中冲突词对 → error，自动替换为白名单内规范替代句（如「84° 广角纵深透视，近大远小，边缘轻微呼吸感」），
   或整层回退结构化 FOV 锁定。

**文件**：`engine/presets/lens-bank.ts`（或新 `engine/quality/lexicon.ts`）、`app/providers/ai.ts`、新校验模块。

---

### V2-P1-2 身份锚在多层重复，稀释注意力

**证据**：同一角色完整描述同时出现在
`光学`（锁定面部身份、深蓝西装、夹烟手）、`正向硬约束`（完整外观）、`全局失败锁`（禁止身份漂移）。

**问题**：模型看不到重点区分；且当 AI 手写文本与资产引用描述不一致时可能互相污染。

**改动**

1. 原则写入 AI 规则：身份完整描述**只允许出现在一个层**（POSITIVE CONSTRAINTS）；
   其余层的身份引用一律用 `@资产名`，不重复描述具体外观。
2. 校验器：统计各层中「以资产名开头 + 出现可识别身份词（脸型/发型/服装）」的重复文本，
   同一身份描述 >1 处 → warning；自动把重复处替换为 `@资产名`（在净管道做，提示用户）。

**文件**：`app/providers/ai.ts`、新校验模块。

---

### V2-P1-3 导出净化管道（元数据 / 诊断 / 空段统一收口）

**问题**：每一处出口各自拼接，缺少一个统一的后处理点
（旧项目已强调「导出时剔除连续性/警告等诊断元数据，留在检查面板」，集成后没有对应实现）。

**改动**

1. 新增 `sanitizeDirectorText(text)`：去除「启用/未启用」元数据行、诊断类摘要
   （如「连续性：共 N 个问题」「最终导出前请解决错误级问题」）、空白段，压缩连续换行。
2. 接入所有最终导出入口（导演文档导出 / 提示词编辑器回填 / 复制）。
3. 校验器发现的 error/warning **只进检查面板，不进导出文本**。

**文件**：新 `engine/quality/sanitize.ts`、`engine/compiler/director.ts`、导出调用方。

---

### V2-P2-1 导演文档校验器（纯函数 + 单测）

**改动**

1. 新增 `engine/quality/validateDirectorLayers.ts`：
   - 输入：`directorLayers`、`project`、`scene`、`locale`
   - 输出：`issues[]`（`error | warning`，带层 key 与行号）
   - 规则汇总（V2-P0-1/P0-2/P0-3/P1-1/P1-2）
2. `app/providers/ai.ts` 的 `normalizeSceneDraft` 在写回 `directorLayers` 前调用：
   error → 丢弃对应层（或回退结构化）；warning → 随对象带回前端展示。
3. `compileDirectorSequence` 读取 `storedLayers` 前同样过校验。
4. 单元测试 fixtures：中文样例（本次实测段落）+ 英文样例各一组；
   断言：多镜头连续时间轴 → error；未引用资产名 → error；84 度 + 压缩感 → error；
   禁止新道具 + 具体道具并存 → warning；重复身份锚 → warning。

**文件**：新 `engine/quality/` 目录 + `__tests__`。

---

### V2-P2-2 AI 输入侧收紧与层标题规范

**改动**

1. `fillSceneDraft`：
   - 资产清单只传场景引用集合（见 V2-P0-2）；
   - `DIRECTOR LAYERS` 规则补三条：分镜分块、禁提及未引用资产、身份只出现一次；
   - AI **不再自拟层标题**——各层正文以 canonical 层标题的本地化文案开头（`DIRECTOR_LAYERS` 现成 zh/en），
     消灭「场景语境 / 场景上下文」这类标题漂移。
2. 结构化编译路径：`renderActionTimingLayer` 的时间块前缀带上镜头号（`镜头1 · 时间块 0:00 至 0:05`）。

**文件**：`app/providers/ai.ts`、`engine/compiler/director.ts`。

---

### V2-P2-3 质量面板展示 V2 校验结果

**改动**：左侧连续性/检查面板新增「导演文档质量」分组，展示 V2 校验的 error/warning；
error 时不阻止导出，但红字提示「当前分层文档存在结构冲突，建议重新 AI 编译或回退结构化」。

**文件**：左前面板组件（复用 `ContinuityPanel` 或其兄弟组件）。

---

## 3. 实施顺序（从简单到完整，逐步提交）

每个步骤独立提交、独立可验证；建议顺序：

| 步骤 | 内容 | 层 | 风险 | 提交点 |
|---|---|---|---|---|
| V2.1 | 常量词表（术语白名单 / 元数据禁词 / 规范替代句）+ 纯函数校验器 + 单测 | 纯函数 | 无 | `test:` / `feat:` |
| V2.2 | `compileDirectorSequence` 接入校验（storedLayers 入口） | 引擎 | 低 | `feat:` |
| V2.3 | AI 输入侧收紧（引用资产集合 / 层规则 / 禁自拟标题） | AI | 中 | `feat:` |
| V2.4 | `normalizeSceneDraft` 写回前校验 + error 层回退结构化 | AI+引擎 | 中 | `feat:` |
| V2.5 | 导出净化管道 `sanitizeDirectorText` 接入所有出口 | 引擎 | 低 | `feat:` |
| V2.6 | 左侧质量面板展示 V2 warnings/errors | UI | 中 | `feat:` |
| V2.7 | 回归走查：用本次实测片段重跑，断言不再出现 5 类问题 | 验收 | 高 | `fix:` |

**统一验证命令**

```bash
npm test            # vitest：新增校验器用例全绿
npm run build       # tsc 类型 + vite 打包，确认前端无破坏
```

**回归走查断言（中文界面其一）**

1. 输出不再含「未启用 / 启用资产」类元数据；
2. 多镜头时动作时序按镜头分块，镜头号 + 时长齐全；不再出现 34 秒单条时间轴 + 多镜头标签并存；
3. OPTICS 层无「84 度 + 压缩感」矛盾词；
4. 身份完整描述只出现在一个层，其余为 `@资产名`；
5. 导出文本里没有「连续性：共 N 个问题」等诊断信息；警告全部留在左侧面板。

---

## 4. 验收口径

- 引擎层：单测覆盖全部 V2 校验规则（zh/en fixture 各一组）。
- 集成层：中文界面全中文输出（仅特定英文名称），英文界面按 locale 输出；两条语言路径各跑一次回归走查。
- 用户体验：AI 编译出错时按钮旁保留原始错误详情 + 一键复制；校验 warning 只在左侧面板提示，不污染导出文本。

---

## 5. V2-P3 用户反馈问题清单（2026-08-25 集成实测）

> 本轮 7 项全部为用户真实操作反馈，先记录问题与方案，按 V2.8 → V2.15 逐步实施、独立提交。
> 依据：`表演技巧ACTING SKILL.md`（表演五支柱、表演母版、声音锁）、`视频提示脚本CINEDANCE HIGGSFIELD SKILL.md`（逐镜密封文档、FOV 角度语言银行）。
> 约束沿用：中文界面全中文输出（仅特定英文名称），英文界面按 locale 全英文输出。

### V2-P3-1 页面无法上下滚动，下方内容不可见（布局级）

**证据**：打开工作室后左侧卡片较长（导演简报 → 导演文档 → 镜头列表 → 检查器 → 连续性），页面整体无法滚动，底部分区看不到。

**根因（代码核查）**
1. 顶层容器 `.cinematic-studio-app` 是 `fixed top-10 bottom-0 overflow-hidden`，实际高度 = 视口 − 40px；
2. 内部 `.cinematic-studio-body { min-height: 100vh }` 与 `.app-shell { height: 100vh; overflow: hidden }` 仍按整屏高度计算，底部 40px 被容器裁切，唯一滚动区 `.content`（`overflow-y: auto`）的底端和滚动条尾部也被裁掉；
3. `styles.css` 存在一批坏选择器：`.inspector-`、`.checklist-`、`.tech-`、`.settings-`、`.recipe-edit-` 后直接拼接 `.cinematic-studio-app`（约 1313 / 2846 / 2896 / 3060 / 3175 行），本意应是给 `.cinematic-studio-body` 设列布局，从未生效，属死代码。

**改动**
1. 高度链改为 `100%`：`.cinematic-studio-body { height: 100% }`（去掉 `min-height: 100vh`）、`.app-shell { height: 100% }`；
2. `.content` 保持唯一纵向滚动区（`min-height: 0; overflow-y: auto`），左列能滚动到底看到全部卡片；
3. `.content-side` 维持自身内部滚动（sticky + max-height），右侧资产库 / 提示词编辑器各自可滚；
4. 修复/清理上述坏选择器（按 DOM 结构核对作用域后改，避免样式回归）。

**文件**：`src/features/cinematicStudio/CinematicStudioWorkbench.tsx`、`src/features/cinematicStudio/app/styles.css`

---

### V2-P3-2 模型切换放到「AI编译提示词」左边，去掉右上角设置

**证据**：当前选 AI 模型要进右上角设置弹窗，路径长；右上角齿轮与 LenTalk 全局设置入口混淆。

**改动**
1. `DirectorBriefCard` 场景操作区（scene-actions）「AI编译提示词」左侧新增「模型」下拉：
   - 数据源 = LenTalk 自定义平台的 Chat 模型列表（与 `aiSettings.ts` 一致）；
   - 切换即写 `saveAISettings({ provider, model })`；未配置平台时下拉显示「未配置，前往 LenTalk 设置 → 密钥」并提示跳转；
2. 移除顶栏 `Settings2` 设置按钮，**工作室内部不再放任何设置入口**；全软件 API 设置统一收口到 LenTalk「设置 → 密钥」（即 settingsStore 的 customApis 与 chatModels），工作室不再有第二份 API 弹窗；
3. 两个「模型」职责分开：新下拉只决定调用哪个 Chat 模型；旧的「目标模型」下拉继续只控制编译模板语法（Kling / Seedance 等输出规范），UI 加 tooltip 区分。

**文件**：`src/features/cinematicStudio/app/App.tsx`（移除 settingsOpen / SettingsModal 使用）、`src/features/cinematicStudio/app/components/DirectorBriefCard.tsx`、`src/features/cinematicStudio/app/providers/aiSettings.ts`、`src/features/cinematicStudio/app/i18n.ts`

---

### V2-P3-3 资产编辑新增「用户备注（仅 AI 参考）」，AI 填写补充到角色信息栏

**证据**：AI 填写详细目前只依赖参考图，用户已有的「性格 / 声音 / 来历」等主观信息没有入口；希望先写一句人设，AI 再结合图片补全「表演母版 + 声音锁」。
UI 位置：名称输入框下方；其他资产类型同逻辑。

**依据（ACTING SKILL）**：表演母版 = 身体传记 + 心理引擎 + 声线 + 习惯/抽动（带触发条件）+ 命名步态 + 压力裂缝 + 软化目标；声音锁在角色开口时逐字粘贴。用户备注只作 AI 理解素材，不是最终提示词字段。

**改动**
1. `Asset` 增加 `notes?` / `notesZh?`：用户手写简要备注（角色 = 性格 / 动机 / 说话习惯；地点 = 氛围 / 用途；道具 = 用法 / 质感；风格参考 = 意向描述），中英分栏，**强制不入编译输出**；
2. 编辑页在「名称」下方放备注输入框，占位文案写明「仅 AI 参考，不输出到最终提示词」；角色类型提示可写性格与声音；
3. `fillAssetDetails` 的 prompt 注入 `notes` / `notesZh`，规则改为「参考图 + 用户备注共同依据」：角色把备注性格/声音吸收进 `masterProfile` 与 `voicePrompt`（声音锁），地点/道具吸收进 `description` 与标记；
4. 编译白名单 + 校验器加规则：「资产备注禁入导出」。

**文件**：`src/features/cinematicStudio/shared-types/index.ts`、`src/features/cinematicStudio/app/components/AssetLibrary.tsx`、`src/features/cinematicStudio/app/providers/ai.ts`、`src/features/cinematicStudio/app/i18n.ts`、编译白名单

---

### V2-P3-4 风格倾向与一句风格话深度结合

**证据**：风格配方目前平铺 12 个可折叠模块字段，选中风格后「一句风格话」仍为空或手填，两者割裂。

**改动**
1. 风格倾向卡的一级展示改为「一段详细风格描述」（zh/en 各一段），不默认分栏；12 字段折叠为「高级编辑」；
2. 选中某个风格倾向时，把该风格的详细描述直接写入 `project.styleBrief`（当前界面语言对应语种），用户可手改，改动即视为脱离自动派生；
3. 风格预设数据补 `descriptionZh` / `description` 长文本字段（一段话囊括光线 / 色彩 / 构图 / 质感本意）；
4. AI 编译规则：`styleBrief` 是唯一风格语义来源；手改过则以手改内容优先，风格倾向仅作标签参考。

**文件**：`src/features/cinematicStudio/app/components/TechnicalProfileCard.tsx`、`src/features/cinematicStudio/engine/presets/`（风格预设）、`src/features/cinematicStudio/app/i18n.ts`

---

### V2-P3-5 「AI编译提示词」是分水岭：以上用户填写（仅 AI 参考），以下 AI 填写（进入最终提示词）

**证据（代码核查）**：`aiCompileScene` 把 `draft.audioPlan` 直接合并进 project，覆盖用户在音频计划卡里填的内容；`fillSceneDraft` 的 schema 也要求 AI 输出 `audioPlan`。用户明确：音频计划是用户信息，AI 不要填。

**产品语义（写入 AI 规则与 UI 帮助）**
- 按钮以上（导演简报：剧情 / 站位 / 风格 / 硬约束 / 对白 / 表演目标 / 音频计划）= 用户输入，仅作为 AI 编译参考上下文，**不整块直拼进最终提示词**；
- 按钮以下（导演文档各层、镜头列表、检查器）= AI 产出，进入最终提示词；
- 本地编译例外：不依赖 AI，把用户已填内容直接按结构编译输出（保留现有功能）。

**改动**
1. `fillSceneDraft` schema 删除 `audioPlan` 输出；AI prompt 把用户现有 `audioPlan` 作为必读输入，只在 directorLayers 的 `audio` 层转述/细化，禁止回写音频计划卡；
2. `aiCompileScene` 不再合并 `draft.audioPlan`；
3. 音频计划区加刘海提示「用户填写 · 仅作 AI 参考」，用户区 / AI 区做视觉分隔（分水岭标签）；
4. 编译规则明确：场景字段（logline、priorContext、staging、styleBrief、audioPlan、actingObjectives…）由 AI 消化后重组进分层文档，不逐字拼接；本地编译保留结构化直拼兜底。

**文件**：`src/features/cinematicStudio/app/providers/ai.ts`、`src/features/cinematicStudio/app/App.tsx`、`src/features/cinematicStudio/app/components/DirectorBriefCard.tsx`、`src/features/cinematicStudio/app/i18n.ts`

---

### V2-P3-6 镜头焦段（mm）与视场角（°）双轨冲突

**证据（代码核查）**：检查器「镜头」下拉写 `shot.lens`（24mm…135mm），光学卡写 `shot.optics.fieldOfViewDegrees`（8°–135°）；AI 生成 schema 同时要求 `lens` 字符串与 `optics.fieldOfViewDegrees`，两套标称并存会互相矛盾或重复。

**依据（CINEDANCE）**：FOV 角度是镜头语言核心度量，品牌 / mm 只是实现细节。

**改动**
1. 以**度数 `fieldOfViewDegrees` 为唯一权威字段**；`lens`（mm）降级为兼容层：旧数据缺失 optics 时按 lens-bank 换算补 FOV，UI 一律显示度数；
2. 检查器删除 mm 下拉，并入光学卡的「视场角」选择 / 决策树（`OpticsCameraEditor` 已有 8° / 18° / 29° / 47° / 84° / 107° / 135° + 内容类别决策，直接复用）；
3. `lensModel`（品牌镜头）保留为可选实现细节，不再承担焦段语义；
4. `fillSceneDraft` schema 去掉顶层 `lens`，只保留 `optics.fieldOfViewDegrees` + `lensModel`；continuity 的 `OPTICS.FOV_OVERRIDDEN` / `OPTICS.BRAND_AS_PRIMARY` 升级为「双轨并存 error」。

**文件**：`src/features/cinematicStudio/app/components/OpticsCameraEditor.tsx`、`src/features/cinematicStudio/app/App.tsx`（检查器）、`src/features/cinematicStudio/app/providers/ai.ts`、`src/features/cinematicStudio/engine/continuity.ts`、`src/features/cinematicStudio/shared-types/index.ts`

---

### V2-P3-7 镜头列表以下（检查器）内容未进最终提示词

**证据**：AI 编译后检查器已填（节拍 / 站位 / 表演 / 眼部生活 / 声音锁），但最终提示词没有对应输出；实测输出只有 AI 分层文本，检查器数据缺失。

**根因（代码核查）**：`compileDirectorSequence` 里 `scene.directorLayers` 存在时直接拼接分层文本并 return，结构化镜头渲染（`renderShotSection`：节拍、站位、表演、眼动、对白 + 声音锁）被整段跳过；AI 分层文本本身没有逐镜密封结构，导致检查器数据丢失。

**依据（CINEDANCE + ACTING）**：每镜是一份密封文档，必须包含本镜活动引用、节拍 / 动作时序、站位、表演（行为而非情绪）、声音锁；这些是最终提示词的必要部分，不是可删元数据。真正问题不是「检查器没用」，而是透传路径把它丢了。

**改动**
1. 分层透传不再裸 `return`：`directorLayers` 存在时逐层校验，并与结构化镜头数据合并——`actionTiming` 层之后补上每镜结构段（活动引用 / 节拍 / 站位 / 表演 / 声音锁，来自检查器数据，去重呈现）；
2. AI 规则：directorLayers 的 `actionTiming` 必须逐镜分块，每镜内容与检查器字段一一对应；校验器按镜头数检查「每镜至少 1 节拍、有站位、有表演、开口角色有声音锁」，缺失 → warning 并自动用结构化渲染补齐该镜；
3. AI 分层文本与结构化数据冲突时（同镜两个版本），以检查器结构化数据为准，AI 文本作参考描述；
4. 不删除检查器：它是 AI 填写 + 用户修正的结构化入口，与最终输出强绑定。

**文件**：`src/features/cinematicStudio/engine/compiler/director.ts`、`src/features/cinematicStudio/engine/compiler/sections.ts`、`src/features/cinematicStudio/app/providers/ai.ts`、新校验模块（复用 V2-P2-1）

---

## 6. 实施顺序追加（V2-P3）

| 步骤 | 内容 | 层 | 风险 | 提交点 |
|---|---|---|---|---|
| V2.8 | 布局滚动修复（高度链 100% + 清理坏选择器） | UI | 低 | `fix:` |
| V2.9 | 模型下拉迁移 + 移除工作室全部设置入口（API 统一 LenTalk 设置 → 密钥） | UI | 低 | `feat:` |
| V2.10 | 资产备注字段 + AI 填写纳入备注（角色信息栏） | 数据+AI+UI | 中 | `feat:` |
| V2.11 | 风格倾向 → 一句风格话自动派生（一段式描述） | 预设+UI | 低 | `feat:` |
| V2.12 | AI 编译分水岭：删 audioPlan 输出，AI 只读不回写；用户区/AI区视觉分隔 | AI+UI | 中 | `feat:` |
| V2.13 | 焦段统一为视场角（mm 兼容层删除 UI） | 引擎+AI+UI | 中 | `refactor:` |
| V2.14 | 检查器内容进最终提示词（分层 + 结构化合并输出） | 引擎+AI | 高 | `feat:` |
| V2.15 | P3 回归走查（下节断言）+ 提交 | 验收 | — | `fix:` |

## 7. 回归走查断言追加（V2-P3）

1. 全屏工作室左列可完整滚动到底，滚动条可见，底部按钮不被裁切；
2. 工作室内无任何设置按钮/弹窗，API 配置只能在 LenTalk「设置 → 密钥」完成；「AI编译提示词」左侧有模型下拉（列出 LenTalk 已配置平台的 Chat 模型），切换后下轮 AI 调用使用新模型；
3. 资产编辑名称下出现「用户备注（仅 AI 参考）」；AI 填写后角色「表演母版 + 声音锁」被补全，最终提示词不含用户备注原文；
4. 选中风格倾向后「一句风格话」自动出现该风格的一段中文描述，可手改；
5. AI 编译后音频计划卡内容保持用户填写不变；导演文档 audio 层参考它但不再回写；
6. 检查器不再出现 mm 焦段下拉，只保留视场角；导出文本无 mm/度数并存冲突；
7. 最终提示词中每个镜头都有完整的节拍 / 站位 / 表演 / 声音锁段落；「动作时序」与检查器内容不重复冲突；
8. 中文界面全程中文输出（固定名词除外），英文界面全英文（沿用既有 locale 验收）。

---

## 8. V2-P4 项目简报（Cully Hill Boys）新增提示词写作要点

> 来源：`/Users/job/Downloads/Cully Hill Boys — Project Brief.docx`（约 600 资产 / 137 场景的 Seedance 长片项目简报）。
> 范围：只收录 **CINEDANCE / ACTING 两份 skill 未覆盖**、且能直接转化为软件规则的要点；
> 两份 skill 已覆盖的内容（单镜密封文档、逐镜活动引用、无负面块、表演母版、声音锁等）不重复罗列，只在与简报冲突或需补充时提及。
> 语言约束沿用全文档口径：凡「用户可见文案 / 写作模板 / 失败判定句式」一律维护 zh/en 两套并按 locale 输出；
> 中文界面全中文（仅 FOV、SFX、`@资产名`、质量后缀等固定英文名词保留原文），英文界面全英文。
> 每条沿用「证据 → 要点 → 改动方案 → 涉及文件」。

---

### P4-1 时代锚：年份是规则，不是装饰

**证据**：简报明确「The year is a rule, not decoration. Nothing in frame is newer than 2011 — no smartphones, no glowing screens in a crowd, no new cars on the street. Left alone, the model drags every shot toward today」。年份进入每一张地点资产，并重复出现在每一个提示词里。

**要点**：模型默认把画面拖向「今天」；年代必须成为显式字段，而不是一段备注。skill 未覆盖年代管理。

**改动**
1. 场景卡片新增「时代锚」字段（默认「无特定年代」）；选定年代后给出该年代的 3 个「时代禁物」预设清单（2011 → 智能手机 / 发光屏幕 / 现代车型与 logo），可勾选增删；
2. AI 编译时把时代锚 + 时代禁物写入**每个镜头**的 LOCATION MAP 与 POSITIVE CONSTRAINTS（不是只在全局出现一次）；
3. 地点资产编辑器增加「年代」属性，导出引用时自动附带。

**文件**：`shared-types`（scene.eraLock）、`app/providers/ai.ts`、`engine/compiler/sections.ts`、资产编辑器。

---

### P4-2 @资产命名脚手架：项目码 + 状态 + 版本

**证据**：命名格式在创建、提示词、上传三处完全一致：`@char_CB_Kel_v9`（角色）/ `@loc_CB_warehouse_s6_v2`（地点 + 场景号）/ `@prop_CB_gunTobin_s26_v2`（道具 + 场景号）；Canvas 是唯一事实来源，资产不在上面就不进镜头。

**要点**：当前 `@角色名 / @地点名` 没有项目码、状态、版本，多状态资产无法区分，也没有版本回溯；skill 未覆盖命名脚手架。

**改动**
1. 资产引用统一改为 `@类型_项目码_名称_状态_v版本`（类型：char / loc / prop）；
2. 新建「状态变体」时自动复制基卡图片 + 完整描述，只允许编辑变化部分，并强制填写变更日志；
3. 版本永不覆盖旧卡；左侧场景地图、检查器、最终提示词的引用全部使用同一命名，保证三处一致。

**文件**：资产数据模型、资产编辑卡片、`engine/compiler/renderer.ts`（引用解析）。

---

### P4-3 资产状态化：一个角色 = 多少个状态 = 多少张卡

**证据**：Cal 三幕三张卡（干净 / 落水湿 / 第三幕带伤，各自独立资产，不是一张卡加备注）；日 / 夜 / 雨是三个地点资产；新变体只改变化部分、整体不重跑图；**车辆内部是道具资产，不是地点**。

**要点**：当前资产库一张角色卡一个形象，无法表达多状态；地点无昼夜 / 天气变体概念；车辆内部被当作地点。

**改动**
1. 资产增加「状态组 / 状态名 / 基卡」结构，引用时可切换状态并自动带出对应变体；
2. 描述合并规则 = 基卡完整描述 + 仅变化段（不整体重写）；
3. 地点卡增加昼夜 / 雨雪选项；「车辆内部」归入道具类型。

**文件**：资产 schema、`AssetEditor`、AI 填写上下文（`ai.ts`）。

---

### P4-4 角色人物表（sheet）规则进资产编辑器

**证据**：人物表 = 正面全身 + 背面全身 + 大特写三方格；**全身图去掉头**（否则宽景会复制小脸）；说话角色特写做「微笑 / 无微笑」两版（否则模型第一次让他笑会编出别人的嘴）；背景中性灰、禁用「studio」字眼与 rim light（光会被烘焙进每一镜）；手上不放道具（道具必须是独立资产，否则无法被丢 / 扔 / 拿走）。

**要点**：skill 未覆盖人物表制作规范，但资产卡是软件第一入口，规范应在编辑器内引导。

**改动**
1. 角色资产编辑器增加「人物表规范」引导（三方格 / 全身去头 / 特写两版 / 背景与光的禁词提醒）；
2. 提供「生成人物表建议」按钮，按规范输出图像提示词（中英按 locale）；
3. 录入时提示「手上道具请单独建道具卡」。

**文件**：`AssetEditor`、资产预设模板。

---

### P4-5 压测（stress test）进资产验收

**证据**：完美的 sheet 证明不了什么，10 次生成 10/10 可辨认才算过；必须和地点 / 同框角色一起测（单测往往在同框时崩）；崩了先改词，同样的问题再崩才重建资产。

**要点**：当前资产没有「可动性验收」状态，坏了分不清是资产问题还是提示词问题。

**改动**
1. 资产卡增加「压测状态」标签（未测 / 通过 / 失败）；
2. AI 提供一键压测：不同动作 + 景别生成 10 条试拍提示词，逐条记录可辨认判定；
3. 失败判定给出「先改词 → 再崩重建资产」的决策提示。

**文件**：`AssetCard`、`app/providers/ai.ts`。

---

### P4-6 口音 = 条件写法 + 逐镜一句台词（SPEECH COUNT LOCK）

**证据**：口音写成条件而非标签——声音块含 register / timbre / tempo / accent / manner，且按场景逐字粘贴，绝不改写（改词就扩大采样面、声音漂移）；口音用类别 + 1–2 个发音标记写实（th→f/v、dropped h、glottal t、-ing→-in'）；完整示例里整镜只有一句台词「Pull it, Oli.」，之后所有嘴保持闭合（SPEECH COUNT LOCK，零即兴、零多语言）。

**要点**：当前声音锁只有「怎么说话」，没有「口音条件」与「本镜说几句」；skill 未覆盖逐镜台词数锁定。

**改动**
1. 声音锁子字段增加「口音条件（类别 + 可选发音标记）」与「本镜台词数上限（0 / 1 / 多）」；
2. AI 填声音锁按 locale 输出，**逐字引用用户台词，禁止同义改写**；台词数超上限 → warning；
3. 长对话自动拆到多镜，每镜独立一声。

**文件**：`engine/compiler/sections.ts`（`renderVoiceLockLines`）、`ai.ts`、检查器 UI。

---

### P4-7 总览镜头（master）+ 空间地图（spatial map）

**证据**：每场开头一条 ~1s 总览 wide：固定站位、无台词无动作，让模型「拍下」谁在哪 / 什么在哪 / 光从哪来，后面每镜才不换位（去掉它角色就开始互换位置）；让某人说个「hm」会被更认真当镜头；空间地图每场写一次、原样贴进每镜（根治瞬移 / 换位 / 机位跳到房间另一边）；站位绑定可见地标（灯、第二排椅、舞台边、门）而非米数；用 frame-left/right 定边；写明机位在哪一侧、永不越过哪条 180° 线；每次切镜后重报「谁在哪、看向哪」。

**要点**：CINEDANCE 有首帧锁但没有 master + 空间地图制度；当前每镜独立写站位，跨镜空间一致性靠 AI 自觉。

**改动**
1. 场景卡片新增「空间地图」字段（compass + 地标 + 180° 线 + 每镜人物初始站位），AI 编译后写入最终提示词的 LOCATION MAP 层；
2. AI 使每场第一镜为 master shot（~1s、无台词、可选单字「hm」）；
3. 站位模板改为「以 [地标] 为参照 + frame 方向」，禁止「距 X 米 / 英雄左边」式写法。

**文件**：`shared-types`（scene.spatialMap）、`ai.ts`、`sections.ts`（站位渲染）。

---

### P4-8 光学：十档视场角阶梯 + 长焦补全

**证据**：视场角（非毫米）按十档阶梯：180 / 135 / 107 / 84 / 63 / 47 / 29 / 18 / 12 / 8；29–84° 为原生可靠区，越界风险骤增；内容是镜头的主宰（135° 细节塌、8° 人群塌）；每镜必须钉死一个 FOV 否则滑回舒适中焦（"one lens per shot"）；长焦必须写完整观测模式：相机距离 + 背景压缩 + 前景遮挡占画面下部 30–45%。

**要点**：V2-P3 已把 mm 改成视场角，但缺档位阶梯与长焦补全校验；AI 可能自拟非阶梯度数。

**改动**
1. 视场角下拉改为十档阶梯；校验器检查「每镜一个 FOV、档位合法」；
2. 长焦（≤18°）自动补全校验：必须有相机距离 + 前景遮挡描述，缺失 → warning。

**文件**：`shared-types`、`ai.ts`、`engine/continuity.ts`。

---

### P4-9 命名锁制度（law 而非 request）

**证据**：规则升级成「锁」三要素 = 有名字 + 画面可见证据 + 一句破坏判定；约 150 个命名锁、约 80 句以 "= failed take" 结尾。四条常用：
1. **尺度三重锚定**：真实尺度 + 画面比例 + 画面内既有参照物，三者同写；
2. **高度失败方向**：如「NOT taller by a single centimeter; if in doubt, render him a touch shorter」；
3. **数量逐帧写**：模型运动时会复制道具（一个三明治被撞出变成两个）；
4. **情绪双侧夹紧**：一个情绪词会变成漫画，「between joy and aggression；扭曲的脸 = 失败take；灿烂微笑 = 失败take；面无表情 = 失败take」。

**要点**：当前 POSITIVE CONSTRAINTS 是「要求式」，缺破坏判定；数量 / 高度 / 尺度 / 情绪无锚定写法；skill 未覆盖命名锁句法。

**改动**
1. 正向硬约束新增 4 类命名锁模板（HEIGHT RULER / COUNT LOCK / SCALE TRIPLE-ANCHOR / EMOTION CLAMP），UI 勾选后按 locale 自动生成「= 失败take」句式（zh/en 两套模板）；
2. 中文句式示例（高度锁）：「林sir 比阿俊高约 10cm；同框时林sir 头顶必须明显更高——矮 1cm 或显得更矮 = 失败take」；
3. AI 编译时对已勾选锁逐项输出，每项含名称 + 证据 + 破坏判定。

**文件**：`sections.ts`（`renderPositiveConstraints`）、AI 编译规则、命名锁模板常量表。

---

### P4-10 人群：一个资产 + 折叠写法

**证据**：人群是一张资产 + 一两个可特写的主群演；超过 15 人折叠成 3–5 个可辨形体；拥挤房间写成「贴着舞台边的身体 + 前景手臂」，绝不写人数；人群承载年代（2011 → 剪影 + 摆动的手臂 + 打火机火焰，无手机无发光屏）。

**要点**：当前 AI 会写「20 多个路人」这类数量词，模型画不出还会复制；skill 未覆盖人群规则。

**改动**：AI 写作规则加入人群条目：>15 人折叠为 3–5 形体；主群演单独建卡；人群引用必带年代禁物。

**文件**：`ai.ts`（导演层写作规则）。

---

### P4-11 按名封禁（ban by name）

**证据**：铁路板总被画成车站——列出站台 / 顶棚 / 灯列 / 停靠列车全部缺席 + 精确轨道数才治好。

**要点**：负面约束防不住具名幻觉，需要「点名 + 计数」的正向写法。

**改动**：全局失败锁支持「点名封禁」条目：列出不该出现的具名物体 + 精确替代计数（如「画面无任何站台元素；轨道恰好 4 条」）。

**文件**：`sections.ts`、全局失败锁区块。

---

### P4-12 十五块骨架固化：不要独立负面块

**证据**：简报骨架固定 15 块：SCENE CONTEXT · ACTIVE REFERENCES · LOCATION MAP · FIRST FRAME AND SPATIAL BLOCKING · FORMAT MODE · OPTICS · CAMERA · ACTION TIMING · PHYSICS · LIGHTING · AUDIO · CHARACTER ACTING · STYLE · QUALITY · POSITIVE CONSTRAINTS——**没有负面块**，禁语写成期望结果。

**要点**：与 CINEDANCE「无独立负面块」一致；新增点是 LOCATION MAP 与 FORMAT MODE 必须占固定位。

**改动**
1. AI 编译输出固定 15 块顺序（跳过空块），块标题按 locale 输出；
2. LOCATION MAP 强制作为第二块（紧接 ACTIVE REFERENCES），内容来自空间地图。

**文件**：`engine/compiler/director.ts`、`sections.ts`。

---

### P4-13 引用规则：一 tag 一次 + 地点继承禁令

**证据**：每个 @tag 只出现一次、总在 ACTIVE REFERENCES；地点引用强制声明「controls geometry, materials, light and atmosphere ONLY — not framing」；预算 9 图 + 3 视频 + 3 音频。

**要点**：当前 AI 层会把 @tag 重复散落多处；地点「取景控制」边界没有声明。

**改动**
1. 校验器：@tag 在正文（ACTIVE REFERENCES 之后）只允许出现一次，重复 → warning 并替换为代称；
2. 地点引用自动追加「仅控制几何 / 材质 / 光 / 氛围，不控制取景」声明（按 locale）。

**文件**：`engine/continuity.ts`、`ai.ts`。

---

### P4-14 节奏补偿与裁边

**证据**：生成普遍偏慢，剪辑要「比直觉更激进」地剪；每个片段计划裁掉首尾各半秒，因为边缘会漂移。

**要点**：AI 分镜时长建议应做节奏补偿；裁边信息属于制作备注，不进提示词。

**改动**
1. AI 分镜时长按「视觉节奏 = 平台生成时长的 0.8–0.9 倍」给出建议；
2. 导出卡片提供「裁首尾 0.5s」制作备注（放左侧面板，不写入最终提示词）。

**文件**：`ai.ts`（分镜时长规则）、左侧制作备注面板。

---

### P4-15 一次只改一处 + 完整版本日志

**证据**：每轮迭代只改一行、其余逐字保留；137 条日志（版本 / 改了啥 / 判定），无日志无法复现好镜、也无法判断是否试过某个修法；整段重写会丢掉已经成功的部分。

**要点**：当前 AI 分层文档整段重写，用户已锁定层可被覆盖（`lockedDirectorLayers` 仅部分实现）。

**改动**
1. 分层文档锁定按层生效：未锁定层整体重写，已锁定层保留原文并提示「一次只改一处」；
2. 每次 AI 编译写版本日志（版本号 + 变更摘要 + 判定）到左侧面板。

**文件**：`engine/compiler/director.ts`、左侧面板 UI。

---

### P4-16 简化镜头，而不是改措辞

**证据**：15–20 次生成后换一种拍法——拆两镜 / 删一个动作 / 换角度 / 换物理路径；「我们救回来的每个失败镜都是靠改镜头，从不是靠改句子」。

**要点**：当前用户失败时只会改文字；应引导换镜头方案。

**改动**：连续失败时左侧面板给出「换镜头建议」（拆镜 / 删动作 / 换机位 / 物理换路径），并提供一键重新分镜。

**文件**：左侧面板 UI、`ai.ts`。

---

### P4-17 复杂动作不在时序中间

**证据**：门踢不开，是因为把动作写在中间（走到门前才挥腿、然后僵住）；改法 = 动作前置进开头「他已经在挥腿、门已经在裂」，接近过程单独成镜。

**要点**：动作高潮应落在首帧或开头，不埋在 40–70% 区间。

**改动**：AI 填动作时序时检查每镜高潮动作位置；落在 40–70% → warning，建议前置到 0–30% 或拆镜。

**文件**：`engine/continuity.ts`、`ai.ts`。

---

### P4-18 规模治理：全局常量 + 场景块

**证据**：600 资产 / 137 场景；描述符与固定 look-and-camera 块作为常量，一处编辑全场生效；按场景块组织 shotlist 文件。

**要点**：当前软件无「全局常量」，每场重复粘贴，规模一大必然漂移。

**改动**：新增「全局常量」（世界固定 look / 相机块 / 镜头语言白名单），单场减少重复输入且一处改全局生效；导出时自动展开到每镜。

**文件**：引擎层、工作室 UI。

---

### P4-19 声音设计：连续氛围粘合 + "SFX only, no music"

**证据**：一段共享连续氛围把生成片段粘进同一空间，画面漂移也成立；「SFX only. No music.」每个提示词必写。

**要点**：音频计划已有「画内音乐 / 环境音效」两列，但缺「连续氛围」条目与强制 SFX-only 规则。

**改动**
1. 音频计划默认生成「连续氛围」条目（用户可关）；
2. AI 编译默认输出「仅音效，无配乐」锁，除非用户明确开启配乐。

**文件**：音频计划 UI、`ai.ts`。

---

### P4-20 表演：三条「活镜头」规则进检查器

**证据**（skill 未覆盖的增量）：
1. **反应提前**：反应在前一句落完前就开始——听者在对方说到半句时脸上已经回答了；
2. **情绪余波跨镜**：重情绪后呼吸不稳、手抖的尾巴带进下一镜，缝合剪辑；
3. **手不能闲**：角色边说边修 / 数 / 倒 / 扶椅子，最强重音是「他听到那句话时手停下来的那一刻」。

**改动**
1. 每镜表演段自动补「反应提前度」提示（监听者于前句结束前开始反应）；
2. 跨镜连续性检查器新增「情绪余波」字段（上一镜尾部状态 → 下一镜首帧）；
3. 「手部忙碌」进表演母版模板。

**文件**：`sections.ts`（`renderActingSection`）、`engine/continuity.ts`、表演母版模板。

---

### P4-21 音乐表演模式（rap / 对口型）【可选专项】

**证据**：视频模型不会表演歌曲——先完成歌曲（真实人声 + 最终混音）→ 按 ~12s 一块切在换气处 → 生成时关掉音频（口型仍由波形驱动，但返回静音片，版权检查抓不到）→ 歌词整段写入提示词 + LIP-SYNC LOCK（嘴只属于音频文件、帧级对齐、其他嘴绝不跟唱）。

**要点**：skill 完全没有音乐场景流程；Seedance 用户常见需求。

**改动**：音频计划增加「音乐表演」卡片（Track 文件 + 歌词块 + 嘴型锁开关）；AI 编译输出 mouth-ownership 锁。此条列为可选专项，P4 排期默认 backlog。

**文件**：音频计划 UI、`ai.ts`。

---

## 9. 实施顺序追加（V2-P4）

> 承接 V2-P3（V2.8–V2.15），从简单到完整、逐步提交；每步独立验收。P4-21 为 backlog，默认不进入 P4 主排期。

| 步骤 | 内容 | 层 | 风险 | 提交点 |
|---|---|---|---|---|
| V2.16 | 资产命名脚手架 + 状态变体数据模型（@类型_项目码_名称_状态_v版本） | 数据+UI | 中 | `feat:` |
| V2.17 | 资产状态化 UI：变体切换 / 车辆内部归道具 / 人物表规范引导 / 压测状态 | UI | 中 | `feat:` |
| V2.18 | 时代锚字段 + 年代禁物全局锁 | 引擎+AI+UI | 低 | `feat:` |
| V2.19 | 空间地图 + master 制度（站位地标化 + 每场 1s 首镜） | 引擎+AI+UI | 高 | `feat:` |
| V2.20 | 视场角十档阶梯 + 长焦补全校验 | 引擎 | 低 | `refactor:` |
| V2.21 | 四类命名锁模板（高度 / 数量 / 尺度 / 情绪）+「= 失败take」句式 | 引擎+UI | 中 | `feat:` |
| V2.22 | 口音条件 + 本镜台词数上限 + 声音锁逐字引用 | AI+UI | 中 | `feat:` |
| V2.23 | 引用与地点继承校验（一 tag 一次、地点「不控制取景」声明） | 引擎 | 中 | `feat:` |
| V2.24 | 十五块骨架固化 + 无独立负面块 + LOCATION MAP 固定第二块 | 引擎+AI | 高 | `refactor:` |
| V2.25 | AI 写作规则：人群折叠 / 点名封禁 / 复杂动作前置 / 节奏补偿 | AI | 中 | `feat:` |
| V2.26 | 一次改一处 + 分层锁定 + 版本日志 | 引擎+UI | 中 | `feat:` |
| V2.27 | 连续氛围 + SFX-only 默认 + 裁边备注 | AI+UI | 低 | `feat:` |
| V2.28 | 表演三规则进检查器与跨镜连续性（反应提前 / 情绪余波 / 手部忙碌） | 引擎+AI | 中 | `feat:` |
| V2.29 | P4 回归走查（下节断言）+ 提交 | 验收 | — | `fix:` |

**统一验证命令**（沿用 V2-P0）

```bash
npm test            # 校验器 / 模板用例（zh/en fixture 各一组）
npm run build       # tsc + vite 打包
```

---

## 10. 回归走查断言追加（V2-P4）

1. 资产引用统一为 `@类型_项目码_名称_状态_v版本`，创建 / 提示词 / 上传三处一致；版本永不覆盖；
2. 角色 / 地点 / 道具支持状态变体；「车辆内部」从地点归入道具；人物表规范与压测状态在编辑器可见；
3. 每场开出 ~1s master 帧（无台词或单字），空间地图每场写一次但逐镜生效；站位全部以地标 + frame 方向表达，无「距 X 米」；
4. FOV 只来自十档阶梯、每镜一个；≤18° 长焦必有相机距离 + 前景遮挡描述；
5. 正向硬约束中的命名锁含名称 + 可见证据 + 破坏判定（…= 失败take），无无判定要求句；
6. 每个 @tag 在正文只出现一次；地点引用带「仅控制几何 / 材质 / 光 / 氛围，不控制取景」声明；
7. 输出固定十五块骨架、无独立负面块；有时代锚的场景每个镜头都带年代禁物；
8. 声音锁逐字引用用户台词、无同义改写；一镜台词数受 SPEECH COUNT LOCK 约束（超出 → warning）；
9. 重试/迭代遵循「一次只改一处」：已锁定层不被整段覆盖，版本日志可见；
10. 音频默认「连续氛围 + 仅音效无配乐」（用户开启配乐除外）；音乐表演卡（如启用）输出 mouth-ownership 锁；
11. 中文界面全程中文输出（仅 FOV / SFX / @资产名 / 质量后缀等固定英文名词保留原文），英文界面全英文（沿用既有 locale 验收）。
