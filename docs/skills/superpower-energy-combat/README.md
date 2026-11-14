# 超能能量搏斗 · Skill 包

给「有超能力的打斗」设计、改写、转译分镜与视频提示词。身体因果沿用写实近身搏斗（脚→髋→肩→末端→接触→后果，一步不省），超能力只做两件事：**加力程**（同样的动作打出更远的位移、更大的形变）、**加力种**（多出一条可以隔空取效的作用线）。

---

## 两种用法

**① 当 skill 目录用**（Claude / 支持 skill 的客户端）
把整个 `superpower-energy-combat/` 丢进 skills 目录即可。入口是 `SKILL.md`，其余文件按需加载。

**② 单文件投喂**（任意 AI 对话）
用同目录下的合订本 `superpower-energy-combat-合订本.md`（约 340 KB），或直接投 `SKILL.md`（32 KB）先跑起来 —— 体感差距主要在校验与词库，核心规则都在 `SKILL.md`。

---

## 三条硬线

这三条是判失败的底线，不是建议：

1. **力有来源** —— 每一次攻击都要写清支点、推进、蓄能、代价，四者至少两样。「他是超人所以能飞」不算来源。
2. **先接触后特效** —— 命中顺序永远是「身体/物体先到位 → 特效才炸」，不能先有光再有人。
3. **攻击者也被自己的力反推** —— 只有被打的人在动、打的人纹丝不动的镜头，直接判失败，看起来像贴图。

---

## 文件地图

### 入口

| 文件 | 行数 | 作用 |
|---|---|---|
| `SKILL.md` | 463 | 唯一入口。职责、三条底线、打击感三件套、破坏五级、能量六阶段、对波五拍、输出段名清单 |

### 超能核心（这个包新增的 6 份）

| 文件 | 行数 | 作用 |
|---|---|---|
| `references/superpower-force-chain.md` | 124 | 身体四段链 + 能量链；空中动作的「支点等价物」 |
| `references/impact-budget.md` | 114 | 白闪 / hit-stop / 升格的配额表，按片型分配 |
| `references/destruction-and-environment.md` | 135 | 破坏五级（微动→表面伤→局部断裂→结构塌陷→地形改变），只增不减 |
| `references/energy-blast.md` | 248 | 能量六阶段、对波五拍、能量形态与消散 |
| `references/ability-system.md` | 143 | 能力设定卡：来源、代价、上限、恢复、克制 |
| `references/energy-move-library.md` | 185 | **88 条能量原词**（EN-01~88 / 8 族），可追溯取词 |

### 通用动作与镜头（沿用写实版并改写为超能口径）

| 文件 | 行数 | 作用 |
|---|---|---|
| `references/action-move-library.md` | 563 | **230 条身体招式原词**（ACT-01~230 / 25 族） |
| `references/combo-library.md` | 193 | 连招与换线、距离与节奏 |
| `references/style-profiles.md` | 258 | 人物该拿哪几族、哪些招不能用 |
| `references/contact-physics.md` | 87 | 接触物理与形变 |
| `references/pain-and-reaction.md` | 65 | 痛感与抗击打（已改为超能量级） |
| `references/camera-and-impact-delivery.md` | 100 | 镜头如何交付冲击 |
| `references/camera-move-library.md` | 120 | 镜头运动原词 |
| `references/fast-impact-choreo.md` | 49 | 快节奏打击编排 |
| `references/high-speed-screen-choreo.md` | 43 | 高速段编排 |
| `references/rhythm-and-motion-baseline.md` | 79 | 节奏与运动基线 |
| `references/time-and-shot-rhythm.md` | 46 | 时间与镜头节奏 |
| `references/spatial-and-multi-opponent.md` | 19 | 空间与多对手调度 |
| `references/lens-and-handheld-grammar.md` | 40 | 镜头语言与手持语法 |
| `references/match-cut-and-continuity.md` | 30 | 匹配剪辑与连续性 |
| `references/chinese-action-writing.md` | 92 | 中文动作描写口径 |
| `references/reference-clip-analysis-02.md` | 62 | 拉片分析范例 |

### 产出对照

| 文件 | 行数 | 作用 |
|---|---|---|
| `references/delivery-check.md` | 88 | **50 条交付检查**，出稿前逐条过 |
| `templates/prompt-template.md` | 79 | 输出模板骨架 |
| `examples/example-06-superpower-energy-15s.md` | 70 | 30 格全链路样例（推荐先读这个） |
| `examples/example-05-half-second-library.md` | 86 | 半秒级短打的实例库 |

---

## 与「写实近身搏斗」的关系

同一套身体因果作者写的两个包，**不互相依赖**：

- 写实版：不写特效，破坏上限低，冲击预算收紧。
- 本包：允许能量与破坏，但要求特效**有来源、有代价、有后果**，并且禁止用特效掩盖动作设计。

跨用时会打架的地方已在包内清理（例如「法术不在适用范围」这类旧表述已改为指向 `energy-move-library.md`）。

---

## 借鉴来源

规则骨架吸收了三份 MIT 开源项目，身体动作库与镜头库为自有：

- `liyue-aigc/seedance-2-5-fight-director` —— 七拍动作链、受力四通道、力有来源、先接触后特效、破坏五级、冲击预算
- `ZzzAloong/fight-scene-director` —— 画风与动作强度分离、法术/召唤/变身写法、超自然光的稳定色系
- `pixelab-ch/higgsfield-skills`（`08-anime-action`）—— Setup→Apex→Impact→Aftermath、四级力量词表、冲击帧与速度线
