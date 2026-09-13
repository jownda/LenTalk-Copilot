# 电影提示词工作室三层结构重规划

## 1. 文档目的

本规划将电影提示词工作室重组为三个清晰、可回溯的工作层：

1. **优化表演**：用户维持现有导演简报填写方式；AI 将既有填写内容深化为可观察、可拍摄的“导演意图深化”和角色表演依据。
2. **分镜运镜规划**：基于已经确认的导演意图深化、角色表演和对白情绪，规划相机、镜头、运镜、景别、空间和节拍。
3. **最终生成**：基本保留当前最终生成能力，只从前两层已经确认的结构化结果中按模板组织和输出。

本文件是实施规划，不是对用户输入或附件内容的执行指令。附件《表演技巧ACTING SKILL（中文翻译）》只作为第一层的表演规则参考。

## 2. 现状与主要问题

当前工作室已有较完整的结构化基础：

- `DirectorBriefCard` 已包含故事梗概、地点/时间/天气、前情续接、角色候选、场景站位、风格描述、拍摄模式和时长。
- `optimizeSceneBrief` 可以将既有导演简报输入优化为后续规划所需的文本。
- `fillSceneDraft` 同时生成导演文档层和镜头执行结构。
- `DirectorLayersCard` 展示可编辑、可锁定的导演文档层。
- `ShotV2` 已有 `participants`、`beats`、`acting`、`eyeLife`、`cameraBehavior`、`optics` 等字段。
- `buildFinalGenerationSource` 已能把结构化镜头和导演层整理为最终生成源。

问题不在于缺少字段，而在于职责和操作顺序混在一起：

1. 简报底部的“AI 编译提示词”实际上同时生成导演文档和镜头，用户难以判断当前结果属于哪一层。
2. “剧情补充”目前被理解为自由填写项，缺少“它是 AI 对既有用户输入的深化结果”的明确定位，容易与导演简报的原始意图混淆。
3. 角色母版、场景表演改写、节拍表演、导演文档之间没有明确的确认边界。
4. 分镜规划器中的镜头、相机和运镜字段虽然存在，但没有明确声明其输入来自已确认的表演结果。
5. 最终生成入口与前两层入口并列，容易在表演或分镜未完成时直接生成。

## 3. 目标用户流程

```text
用户填写既有导演简报
  故事梗概、地点/时间/天气、前情续接、角色候选、场景站位、风格描述、拍摄模式、时长
        |
        v
第一层：优化表演
  AI 优化填写 -> 导演意图深化草稿
  用户审核/编辑/确认
  AI 将情绪、目的、对白落地为动作、微表情、眼神、呼吸、节拍和预分镜
        |
        v
第二层：分镜运镜规划
  读取已确认的导演意图深化与表演节拍
  AI / 用户选择景别、镜头、相机、运镜、空间和剪辑关系
  自动生成可编辑的分镜执行结构
        |
        v
第三层：最终生成
  读取当前表演与分镜结构
  运行连续性/时长/引用/最终格式检查
  按所选模板整理输出最终提示词
```

每一层都必须支持“草稿、已确认、已过期”三种计算状态。上游内容发生变化时，下游结果标记为已过期，但不直接删除，用户可以查看差异后重新生成。

## 4. 三层产品结构

### 4.1 第一层：优化表演

#### 4.1.1 目标

将用户现有导演简报中的信息转化为视频模型可以执行的表演信息：

- 角色当前想对谁做什么，以及失败代价。
- 情绪走向如何通过身体、呼吸、节奏、距离、视线和动作变化体现。
- 对白之前、对白过程中和对白之后的可见反应。
- 每个角色的手上事、动作打断点、微表情和眼神生命。
- 以状态描述为主的预分镜节拍，不提前决定完整机位。

#### 4.1.2 界面分区

在现有导演简报下方增加 AI 结果区，但不改变或新增用户填写区字段：

**A. 用户填写区（保持不变，不新增字段）**

- 故事梗概。
- 地点、时间、天气。
- 前情续接。
- 角色候选。
- 场景站位。
- 风格描述。
- 拍摄模式和时长。

这些字段继续由用户填写，保留原有位置与职责；它们作为 AI 优化的输入，不直接被“导演意图深化”覆盖。

**B. AI 导演意图深化**

- “AI 优化填写”按钮只读取上述既有用户填写区和现有资产信息。
- 生成一段结构化、可编辑的“导演意图深化”，而不是直接生成镜头列表。
- 结果必须显示“AI 草稿”，支持接受、重试、局部编辑和恢复上次版本。
- 导演意图深化为下一层准备：情绪弧线、角色目的/阻碍/代价、对白归属、可见动作、微表情/眼神、动作节拍和预分镜意图。

**C. 表演确认区**

- 角色表演母版：角色长期稳定的身体、声音、习惯和面具裂纹。
- 本场景表演改写：只写当前出镜角色在本场的可见行为。
- 表演质量评分：0–5，默认目标为 4+。
- “确认表演结果”按钮：记录当前导演意图深化与表演快照，解锁第二层。

#### 4.1.3 第一层输出

输出不是最终提示词，而是可供第二层消费的结构化 `PerformancePlan`：

- 场景情绪弧线。
- 每个出镜角色的目标、阻碍、赌注和潜台词。
- 每个角色的场景表演段落和眼神生命。
- 按时间排列的动作节拍：演员、动作、目标、对白、反应先于台词、节拍变化、手上事、声音。
- 预分镜意图：应观察什么、何时停住、何时切换关注对象。
- 约束：必须发生、禁止发生、不可改变的对白和角色关系。

#### 4.1.4 表演规则落地

附件规则应映射为 AI 生成和校验规则，而不是整篇拼入提示词：

- 只写可观察行为，不写“他很紧张”这类不可拍心理结论。
- 每个小动作带触发点和目的。
- 每个角色拥有身体重心、节奏、开放度、呼吸和地位状态。
- 眼神必须包含扫视、眨眼质感、瞳光和眼睛先于头部的反应。
- 反应应在对手台词结束前开始。
- 以“状态”描述动作，避免复杂的连续过渡动作。
- 群像反应错开，强者静止、弱者忙乱只作为可被事件打破的默认倾向。
- 每个主角镜头表演目标为 4+，低于 3 时给出重写建议。
- 表演文本不写机位、色彩和服装；这些属于第二层或全局风格层。

### 4.2 第二层：分镜运镜规划

#### 4.2.1 目标

把第一层已经确认的表演节拍转译为可执行的镜头语言，明确“为什么此刻这样拍”：

- 每个镜头捕捉哪个表演事件或反应。
- 景别、相机、焦段/FOV、机位高度、距离、角度和焦点行为。
- 运镜的触发事件、方向、速度、起止状态和与表演的因果关系。
- 场景站位、人物距离、屏幕方向、轴线与剪辑衔接。
- 长镜头和多镜头的时间分配。

#### 4.2.2 界面分区

**A. 表演输入摘要**

- 只读展示第一层已确认的情绪弧线、角色目标、对白和节拍。
- 提供“返回优化表演”入口。
- 上游变更时显示“表演结果已更新，当前分镜需要重新规划”。

**B. 镜头规划器**

- 镜头时间轴：开始、结束、镜头时长、剪辑关系。
- 镜头意图：本镜要捕捉的表演事件/反应。
- 景别与构图：全景、中景、近景、特写、过肩等。
- 相机与光学：相机型号、镜头角色、FOV、景深、焦点行为。
- 运镜：Static、Handheld、Dolly、Tracking、Crane、POV、OTS 等。
- 运镜行为：高度、距离、角度、方向、速度、稳定性、触发事件、结束状态。
- 空间连续性：角色左右、前后景、朝向、视线、距离、入画/出画和轴线。
- 节拍绑定：每个镜头必须绑定一个或多个第一层节拍。

**C. 分镜确认**

- 不要求用户逐镜审核、确认或锁定。
- AI 生成后直接形成可编辑的分镜执行结构；用户可在需要时修改任意镜头。
- 提供“AI 重新规划运镜”和“仅修复连续性”两个不同入口。

#### 4.2.3 第二层输出

直接复用并扩展现有 `ShotV2`，但补充明确的来源与绑定字段：

- `performanceBeatIds`：本镜绑定的第一层节拍 ID。
- `shotIntent`：本镜的拍摄目的。
- `cameraTrigger`：运镜触发的表演事件。
- `cameraEndState`：运镜结束时的机位/焦点/主体状态。
- `planningStatus`：草稿、已确认、已过期。

现有 `cameraBehavior`、`optics`、`movement`、`layout`、`cutStyle`、`participants` 和 `beats` 继续作为执行数据源，不另建一套平行镜头模型。

### 4.3 第三层：最终生成

#### 4.3.1 保持不变的部分

- `buildFinalGenerationSource` 继续作为 canonical source 构建入口。
- `generateFinalPrompt` 继续负责最终语言组织，而不是重新做剧情或分镜创作。
- 现有模板 `pro-sequence`、`shot-cards`、`asset-id-tagged` 继续保留。
- 资产引用、声音、风格、负面约束、连续性和最终审计继续复用。

#### 4.3.2 需要调整的部分

- 最终生成只消费“已确认”的第一层和第二层数据。
- 用户原始总结只作为可追溯元数据，不直接覆盖已确认的可执行字段。
- 最终生成前显示门禁状态：表演是否确认、分镜是否确认、是否存在过期结果、是否有错误级连续性问题。
- 生成源明确标注来源快照，支持查看“本次最终输出使用了哪一版表演和分镜”。

## 5. 建议数据模型

### 5.1 SceneV2 新增字段

```ts
interface PerformancePlan {
  id: string;
  sourceBriefHash?: string;
  status: "draft" | "confirmed" | "stale";
  generatedAt?: string;
  confirmedAt?: string;
  emotionArc?: string;
  characterPlans: CharacterPerformancePlan[];
  beats: PerformanceBeat[];
  previsualization?: string;
  version: number;
}

interface CharacterPerformancePlan {
  characterId: string;
  objective: string;
  obstacle?: string;
  stakes?: string;
  subtext?: string;
  sceneActing?: string;
  eyeLife?: string;
  performanceLevel?: 0 | 1 | 2 | 3 | 4 | 5;
}

interface PerformanceBeat {
  id: string;
  order: number;
  startSeconds?: number;
  duration?: number;
  actorId?: string;
  targetCharacterId?: string;
  action: string;
  dialogue?: string;
  reactionBeforeLine?: string;
  tactic?: string;
  subtext?: string;
  beatChange?: string;
  business?: string;
  audio?: string;
  required?: boolean;
}
```

建议挂在 `SceneV2.performancePlan`，并将现有 `storyNotes` 重命名为语义明确的 AI 结果字段：

- `directorIntentRefinement`：AI 生成、用户可编辑的“导演意图深化”，用于准备下一层表演和分镜规划。
- `directorIntentRefinementSource`：`ai` / `edited`，用于标记是否经过用户调整。
- 旧 `storyNotes` 保留迁移兼容，读取时映射到 `directorIntentRefinement`。

不新增 `briefSummary` 或其他用户输入字段。用户输入继续使用导演简报中既有的故事梗概、地点/时间/天气、前情续接、角色候选、场景站位、风格描述、拍摄模式和时长。

### 5.2 ShotV2 新增字段

```ts
interface ShotPlanningMeta {
  status: "draft" | "confirmed" | "stale";
  performanceBeatIds: string[];
  shotIntent?: string;
  cameraTrigger?: string;
  cameraEndState?: string;
}
```

挂载为 `ShotV2.planningMeta`。现有字段保持不变，避免破坏编译器、连续性检查和旧项目迁移。

### 5.3 状态依赖

```text
existing director brief / scene context
        -> directorIntentRefinement
        -> performancePlan
        -> shot planningMeta + ShotV2
        -> canonical final source
        -> final prompt
```

任意上游内容变化时：

- 修改既有用户简报字段：`directorIntentRefinement`、`performancePlan`、镜头规划标记为 `stale`。
- 修改导演意图深化：`performancePlan` 和镜头规划标记为 `stale`。
- 修改已确认表演：镜头规划标记为 `stale`。
- 修改单个镜头：只标记最终生成源为待重新生成，不影响其它镜头。

## 6. AI 调用契约

### 6.1 第一层调用：`optimizeSceneBrief`

职责：只生成“导演意图深化”文本或结构化结果，不生成镜头和最终提示词。

输入：

- 既有导演简报字段：故事梗概、地点/时间/天气、前情续接、角色候选、场景站位、风格描述、拍摄模式和时长。
- 角色表演母版和声音锁只作为角色一致性参考。

输出：

- `directorIntentRefinement`。
- 不写入 `ShotV2`、导演文档层、最终提示词。

### 6.2 第一层调用：`planPerformance`

职责：把导演意图深化为角色表演计划和预分镜节拍。

输入：

- 已确认的 `directorIntentRefinement`。
- 当前场景角色与资产。
- 表演规则约束。

输出 JSON：

```json
{
  "emotionArc": "...",
  "characterPlans": [
    {
      "characterId": "...",
      "objective": "...",
      "obstacle": "...",
      "stakes": "...",
      "subtext": "...",
      "sceneActing": "...",
      "eyeLife": "...",
      "performanceLevel": 4
    }
  ],
  "beats": [
    {
      "order": 1,
      "actorId": "...",
      "action": "...",
      "dialogue": "...",
      "reactionBeforeLine": "...",
      "tactic": "...",
      "subtext": "...",
      "beatChange": "...",
      "business": "..."
    }
  ],
  "previsualization": "..."
}
```

### 6.3 第二层调用：`planSceneShots`

职责：只把已确认的表演计划转译为镜头和运镜。

输入：

- 已确认 `performancePlan`。
- 地点和站位。
- 时长、拍摄模式、风格与技术限制。

输出：

- `ShotV2[]`。
- 每个镜头必须有 `performanceBeatIds` 和 `shotIntent`。
- 每个非静止运镜必须有 `cameraTrigger` 和 `cameraEndState`。

### 6.4 第三层调用：`generateFinalPrompt`

职责：组织最终文案，不重新创作上游内容。

输入：

- 已确认的 canonical source。
- 模板、语言和目标模型。

约束：

- 不新增没有结构化来源的角色、道具、对白、镜头或运镜。
- 如果源数据存在错误级问题，阻止生成并给出具体修复入口。

## 7. 代码改造步骤

### 阶段 0：基线与分支保护

1. 新建功能分支并记录当前 `npx tsc --noEmit`、`npm test` 和 `npm run build` 基线。
2. 检查已有未提交改动，避免覆盖用户工作。
3. 为 `App.tsx`、`DirectorBriefCard.tsx`、`DirectorLayersCard.tsx` 和 `providers/ai.ts` 建立改造前快照。

### 阶段 1：数据模型和迁移

1. 在 `shared-types/index.ts` 增加 `PerformancePlan`、`PerformanceBeat`、`ShotPlanningMeta`。
2. 在 `SceneV2` 增加 `directorIntentRefinement`、`performancePlan` 和版本状态字段，保留旧字段。
3. 在 `ShotV2` 增加 `planningMeta`。
4. 在 `app/model.ts` 的迁移函数中完成：
   - 旧 `storyNotes` 映射到 `directorIntentRefinement`。
   - 旧 `actingObjectives`、`emotionArc` 和镜头 `beats` 尽可能映射为 `performancePlan`。
   - 没有来源快照的旧镜头默认标记为 `draft`，不强行标记为已确认。
5. 为迁移增加单元测试，确保旧项目可打开、可保存、可再次读取。

### 阶段 2：第一层 UI 与 AI

1. 将 `DirectorBriefCard` 拆成 `BriefSummaryEditor` 和 `PerformancePlannerCard`，外层只负责场景选择、错误和状态。
2. 保持用户填写区字段与布局不变，不新增用户填写项；将现有 `storyNotes` 结果区改名为“导演意图深化”。
3. 保留“AI 优化填写”，但改为只写 `directorIntentRefinement`，不覆盖任何既有用户填写内容。
4. 新增 `planPerformance` provider 和稳定 JSON schema。
5. 新增表演计划编辑器：角色卡、节拍表、预分镜意图、表演评分、确认按钮。
6. 把附件中的规则放入 provider 的系统约束和本地质量校验，不把规则全文写入最终提示词。
7. 用户确认后写入 `performancePlan.status = confirmed`，记录 `sourceBriefHash` 和版本。

### 阶段 3：第二层 UI 与 AI

1. 将现有 `DirectorLayersCard` 和镜头执行区域重组为 `ShotPlanningCard`。
2. 顶部展示只读表演摘要和过期提示。
3. 新增 `planSceneShots`，从确认的表演计划生成镜头，不再由“AI 编译提示词”承担全部职责。
4. 保留现有 `OpticsCameraEditor`、节拍编辑器、参与角色编辑器和连续性检查，改为镜头规划器的子编辑区。
5. 每个镜头增加表演节拍绑定、镜头意图、运镜触发和结束状态。
6. 重新规划时直接以最新的导演意图深化和表演计划覆盖 AI 生成的分镜结果；用户手动编辑仍可随时保留或再次修改。

### 阶段 4：第三层最终生成收口

1. 将当前最终生成按钮移动到第三层，改名为“最终生成”。
2. 在生成前运行状态门禁和现有 `validateDirectorLayers`、连续性、时长、资产引用审计。
3. 调整 `buildFinalGenerationSource`：优先读取已确认的表演计划和镜头结构；仅把导演文档作为可编辑辅助层。
4. 最终生成记录 `performancePlan.version`、镜头版本和模板信息。
5. 保持导出、复制、发送到视频和历史记录行为不变。

### 阶段 5：清理旧入口与兼容收尾

1. 移除“AI 编译提示词”作为前两层统一入口的语义，保留兼容函数名时改为内部路由。
2. 更新中文/英文 i18n 文案，区分“优化表演”“规划分镜”“最终生成”。
3. 更新文档中的旧“导演简报 → 导演文档 → 镜头执行”描述。
4. 对旧项目、空场景、单角色、群像、多镜头、长镜头和 AI 未配置场景做回归测试。

## 8. 测试与验收标准

### 8.1 数据与迁移

- 旧项目 JSON 能正常打开，旧 `storyNotes` 内容不丢失。
- 新字段缺失时有合理默认值，不影响旧编译器。
- AI 失败、取消、断线续写不会把确认状态错误地改成已确认。
- 上游编辑会正确标记下游 stale，不会静默删除用户手动修改的内容。

### 8.2 第一层

- 点击“AI 优化填写”只改变 AI 导演意图深化，不改变任何既有用户填写字段、镜头和最终提示词。
- 点击“生成表演计划”只改变 `performancePlan`，不改变相机和镜头参数。
- 每个出镜角色都有目标、可观察表演和眼神生命；对白有归属。
- 每个节拍可追溯到故事补充中的情节或对白。
- 表演评分低于 3 时显示明确修复提示；主角默认检查 4+。

### 8.3 第二层

- 未确认表演时，分镜规划器明确提示先确认第一层。
- 每个镜头至少绑定一个表演节拍或明确标记为环境/过渡镜头。
- 非静止运镜具备触发事件和结束状态。
- 相机、景别、焦段与表演意图互相一致，连续性检查可执行。
- 重新规划会生成最新分镜结果，用户可以继续直接编辑任何镜头。

### 8.4 第三层

- 最终生成只使用已确认或用户明确保留的结构化结果。
- 错误级连续性问题阻止最终生成，并提供定位信息。
- 最终输出不重复输出内部 AI 规划说明，不泄漏用户输入字段标签。
- TXT、Markdown、JSON、复制和发送到视频行为保持可用。

### 8.5 自动化测试建议

- `performancePlan` schema 与 normalize 测试。
- `directorIntentRefinement` 到表演计划的来源追踪测试。
- 表演计划变更导致镜头 stale 的 reducer 测试。
- 镜头节拍绑定和重新规划结果的 reducer 测试。
- 最终 source 不包含未确认草稿的测试。
- 现有 `compiler`、`continuity`、`finalAudit` 测试全部保留并扩展关键场景。

## 9. 风险与处理策略

| 风险 | 影响 | 处理 |
|---|---|---|
| 一次性替换旧 `storyNotes` | 旧项目内容丢失 | 新旧字段并存，迁移只做可逆映射 |
| 第一层输出过长 | AI 成本和 UI 负担增加 | 结构化节拍 + 可折叠角色卡，限制每场角色和节拍数量但不截断关键事件 |
| AI 生成表演与镜头互相矛盾 | 最终画面不一致 | 通过 `performanceBeatIds` 建立绑定，第二层只消费确认的表演 |
| 用户修改上游后下游仍旧可生成 | 输出过期 | stale 门禁；允许查看旧版本但默认要求重新确认 |
| 最终生成重新“发挥” | 破坏用户确认内容 | canonical source 作为唯一事实来源，最终 AI 只负责语言组织 |
| 现有 App.tsx 过大 | 改造回归风险高 | 按层拆分组件和 application handlers，逐阶段迁移 |
| 远程 AI 不可用 | 用户无法继续 | 每层提供本地规则建议/手动编辑；最终生成保持现有错误与续写机制 |

## 10. 建议实施顺序与交付物

建议按以下顺序交付，每个阶段都可独立验证：

1. **设计与模型阶段**：本规划、字段定义、状态图、迁移测试。
2. **第一层 MVP**：既有用户填写区保持不变、AI 导演意图深化、表演计划编辑与确认。
3. **第二层 MVP**：表演摘要、镜头规划、运镜规划和节拍绑定。
4. **最终生成收口**：门禁、canonical source、版本记录、导出回归。
5. **体验优化**：i18n、过期提示、差异查看、错误恢复、布局和性能。

每个阶段的完成定义：代码、测试、迁移兼容、中文/英文文案、主路径手测记录和更新后的技术文档全部齐备。

## 11. 首轮实施建议

第一轮不建议直接重写全部 UI。先完成以下最小闭环：

1. 保持导演简报的既有用户填写区不变，将 `storyNotes` 更名并迁移为 AI 结果字段 `directorIntentRefinement`。
2. 把“AI 优化填写”收口为只更新 `directorIntentRefinement`。
3. 新增 `performancePlan` 和“生成/确认表演计划”按钮，先复用现有 `ShotV2.beats` 的字段语义。
4. 在现有镜头执行区顶部加入表演计划摘要和 stale 状态。
5. 将当前“AI 编译提示词”改成第二层“生成分镜运镜”，最终生成按钮继续沿用现有逻辑。
6. 第一轮完成后再拆分 `DirectorBriefCard`、`DirectorLayersCard` 和 `App.tsx`，降低一次性重构风险。

这样可以先验证核心数据流是否符合创作习惯，再决定是否进行完整视觉重构。
