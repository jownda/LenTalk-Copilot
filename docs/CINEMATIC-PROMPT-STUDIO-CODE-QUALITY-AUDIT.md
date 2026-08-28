# 电影提示词工作室代码质量审查

> 项目：LenTalk-Copilot-main  
> 模块：`src/features/cinematicStudio/`  
> 审查日期：2026-08-28  
> 审查性质：代码质量与功能一致性审查，不包含本次修复实现

## 1. 总体结论

电影提示词工作室已经具备较完整的结构化数据、导演文档、镜头执行、资产引用、连续性检查和最终生成链路。纯函数编译器测试覆盖相对扎实，但当前仍存在几项会直接影响最终提示词正确性的状态同步问题，同时代码质量门未通过。

当前判断：

- **功能基础：中上**。核心编译和资产引用路径已经成型。
- **输出一致性：需要整改**。导演层、资产删除、道具空间关系和导出闸门之间存在不一致。
- **代码清晰度：中等**。模块边界存在，但入口组件和 AI Provider 职责过重。
- **测试完整度：不足**。纯函数测试较多，真实 UI 工作流测试明显缺失。

## 2. 问题清单

### P1-01：持有道具的空间渲染是死代码

**位置**：[renderer.ts:384](/Users/job/Documents/appinste/LenTalk-Copilot-main/src/features/cinematicStudio/engine/compiler/renderer.ts:384)

**现象**

`heldPropsByCharacter(shot)` 无论传入什么镜头都返回空 `Map`：

```ts
export function heldPropsByCharacter(shot: ShotV2) {
  void shot;
  return new Map();
}
```

但 `renderSpatialLayoutLine()` 会调用这个函数，并计划输出角色持有的道具、道具位置和道具状态。

**影响**

- 角色与道具的空间关系不会进入“空间走位”文本。
- “某角色手持/怀抱/放置某道具”的结构化数据与最终提示词脱节。
- 资产引用虽然可能进入“活动引用”，但模型缺少该道具与角色之间的画面关系。

**建议**

实现 `heldPropsByCharacter()`，从镜头的 `propStatesAtStart` 和有效节拍状态中解析：

- `holderCharacterId` 对应的角色；
- `propId` 对应的道具；
- `position` 与 `state`；
- 同一道具状态变化时，以镜头开始时的可见状态作为空间走位初始条件。

同时增加 `renderSpatialLayoutLine()` 的正向和反向测试，覆盖至少“角色抱着道具”和“道具在地面上”两种状态。

**验收标准**

给镜头添加角色持有道具状态后，空间走位文本中能出现角色、道具引用以及位置/状态；没有道具状态时保持当前空输出行为。

### P1-02：删除资产后仍可能残留引用

**位置**：[projectReducer.ts:98](/Users/job/Documents/appinste/LenTalk-Copilot-main/src/features/cinematicStudio/app/store/projectReducer.ts:98)

**现象**

`DELETE_ASSET` 已清理部分参与者、开始道具状态和节拍引用，但没有完整清理以下字段：

- `propStatesAtEnd`；
- `scene.staging.characterOrder`；
- `shot.layout.characterOrder`；
- `scene.firstFrameLock.requiredSubjectIds`；
- `scene.actingObjectives`；
- `scene.directorLayers` 中已经保存的角色名、道具名或资产引用文本。

**影响**

- 删除角色或道具后，旧资产 ID 仍可能参与空间顺序、首帧锁和道具状态链。
- `directorLayers` 属于最终生成的优先来源，旧角色名或旧资产描述可能继续进入最终提示词。
- UI 显示的资产库与实际生成源不一致，问题难以通过普通编辑发现。

**建议**

把资产删除后的引用清理集中为一个纯函数，例如 `removeAssetReferences(project, assetId)`，统一处理项目级、场景级、镜头级、节拍级和导演层级字段。对于自由文本 `directorLayers`，至少应：

- 清理可确定的 `@referenceTag` 和内部资产 ID；
- 标记相关导演层为需要重新编译，而不是静默继续使用旧文本；
- 删除后重新运行导演层校验和连续性校验。

**验收标准**

删除角色、地点、道具、声音资产后，项目 JSON、镜头执行、首帧锁、空间排序、表演目标和最终生成源中都不再出现该资产 ID 或其活动引用。

### P2-01：电影工作室专属 lint 不通过

**检查命令**：

```bash
npx eslint src/features/cinematicStudio
```

**结果**：5 个 error、10 个 warning。

主要位置：

- [director.ts:101](/Users/job/Documents/appinste/LenTalk-Copilot-main/src/features/cinematicStudio/engine/compiler/director.ts:101)：无效转义；
- [director.ts:149](/Users/job/Documents/appinste/LenTalk-Copilot-main/src/features/cinematicStudio/engine/compiler/director.ts:149)：控制字符正则；
- [director.ts:362](/Users/job/Documents/appinste/LenTalk-Copilot-main/src/features/cinematicStudio/engine/compiler/director.ts:362)：无效引号转义；
- [validateDirectorLayers.ts:66](/Users/job/Documents/appinste/LenTalk-Copilot-main/src/features/cinematicStudio/engine/quality/validateDirectorLayers.ts:66)：控制字符正则。

另外还有 `any`、无效 Hook 依赖、无用赋值和 Fast Refresh 导出警告。

**影响**

- 模块不能通过自身的静态检查质量门。
- 正则和字符串处理较多，当前 lint 错误会增加后续修改时的误判风险。
- warning 持续累积后，真正的 Hook 或类型问题容易被淹没。

**建议**

先清零 5 个 error，再按以下顺序处理 warning：

1. 为 `TechnicalProfileCard` 的回调和数据结构补充具体类型，移除显式 `any`。
2. 删除无效的 Hook 依赖和无用赋值。
3. 将非组件导出函数或常量移到独立模块，消除 Fast Refresh 警告。
4. 将正则中的 ASCII 判断改成不触发 `no-control-regex` 的实现，并补充测试。

**验收标准**

`npx eslint src/features/cinematicStudio` 无 error；warning 数量为零，或每个保留的 warning 都有明确的代码注释和原因。

### P2-02：单文件职责过重，边界不够清晰

**主要位置**：

- [App.tsx](/Users/job/Documents/appinste/LenTalk-Copilot-main/src/features/cinematicStudio/app/App.tsx)：约 877 行；
- [ai.ts](/Users/job/Documents/appinste/LenTalk-Copilot-main/src/features/cinematicStudio/app/providers/ai.ts)：约 1294 行；
- [continuity.ts](/Users/job/Documents/appinste/LenTalk-Copilot-main/src/features/cinematicStudio/engine/continuity.ts)：约 1340 行。

**现象**

`App.tsx` 同时负责 React 状态、项目持久化、审计、AI 操作、复制导出、画布发送和主要页面渲染。`ai.ts` 同时负责网络请求、错误分类、Schema、AI 提示词、JSON 解析、场景归一化和最终提示词请求。

**影响**

- 一个功能修改容易同时触碰状态、业务规则和界面行为。
- 逻辑复用困难，单元测试需要间接依赖大型模块。
- 发生问题时，很难快速判断是数据、编译器、网络还是 UI 状态造成的。

**建议**

按现有职责逐步拆分，不建议一次性重构：

- `App.tsx`：保留页面编排，将审计/导出/项目操作移到 hooks 或 application service；
- `ai.ts`：拆出 transport、schema/normalize、scene planner、final prompt delivery；
- `continuity.ts`：按 identity、spatial/prop、audio/acting、technical 分离规则文件，共享统一 issue 类型。

拆分时保持现有纯函数 API，优先减少交叉依赖，不改变提示词输出行为。

**验收标准**

每个模块只有一个主要职责；新增规则可以在对应模块中独立测试，不需要修改页面组件或网络层。

### P2-03：UI 集成测试不足

**现状**

当前测试主要覆盖：

- 编译器和渲染器纯函数；
- 连续性和最终审计；
- 资产命名与 reducer 部分行为；
- AI 归一化和样式描述。

目前缺少对以下真实工作流的 React/UI 集成测试：

- `App` 中导演层错误对最终生成、复制、导出的阻断；
- 风格预设切换后最终提示词是否使用新风格；
- 删除资产后的完整引用清理；
- 镜头执行中角色、道具、表演和节拍的联动；
- 画布音频选择到视频节点的完整流程；
- 导演层编辑、锁定和再次 AI 编译。

**影响**

纯函数测试通过并不能证明页面上的状态组合正确。当前发现的道具渲染和资产删除问题，就是典型的跨组件、跨层数据问题。

**建议**

优先增加少量高价值集成测试，而不是追求全面覆盖：

1. 创建最小项目，添加两个角色和一个道具，验证按镜头分配角色；
2. 删除其中一个资产，验证所有引用字段被清理；
3. 添加导演层错误，验证最终生成、复制、TXT/Markdown 导出和发送按钮全部阻断；
4. 切换风格预设，验证最终源中的 STYLE 使用最新预设；
5. 添加持有道具状态，验证空间走位文本输出道具关系。

## 3. 已具备的质量基础

- 结构化镜头执行已经将动作节奏、角色表演和节拍放在同一执行链中。
- 活动引用支持 `@referenceTag`、`[imageN]` 和 `@audioN`，并按实际镜头首次使用去重。
- 导演层、最终审计和连续性检查已经有独立纯函数，便于继续补测试。
- 当前全量测试为 24 个测试文件、152 个测试通过。
- TypeScript 检查和生产构建通过；构建输出中的警告不属于本审查列出的功能错误。

## 4. 推荐整改顺序

1. 修复 `heldPropsByCharacter()`，补空间渲染测试。
2. 完善 `DELETE_ASSET` 的引用清理，补 reducer 与最终源测试。
3. 统一导演层错误的最终生成、复制、导出、发送和审计记录闸门。
4. 修复 cinematic studio lint error，再清理 warning。
5. 增加上述高价值 UI 集成测试。
6. 在功能稳定后拆分 `App.tsx` 和 `ai.ts`，降低后续维护成本。

