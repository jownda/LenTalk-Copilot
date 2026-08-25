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
