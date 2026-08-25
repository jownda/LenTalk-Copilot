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
