// ─────────────────────────────────────────────────────────────
// V0.1 兼容模型（保留，迁移时读取旧字段）
// ─────────────────────────────────────────────────────────────
export type CameraMovement = "Static" | "Handheld" | "Steadicam" | "Dolly" | "Tracking" | "Crane" | "POV" | "OTS";

export interface PropItem {
  id: string;
  /** 道具用法描述, 如 "左手拿红色包包" */
  text: string;
  /** 道具参考图(data URL / URL) */
  image?: string;
}

export interface Character {
  id: string;
  name: string;
  role: string;
  identityLock: boolean;
  face: string;
  wardrobe: string;
  /** 角色参考图(人物三视图, data URL / URL) — V0.2 迁移时登记为 character Asset，新项目不再直接使用 */
  reference?: string;
  /** 角色音频(声音音色, data URL / URL), 用于语气与台词参考 */
  audio?: string;
  /** 角色道具列表(文字 + 图片组合) — V0.2 迁移时登记为 prop Asset */
  prop?: PropItem[];
}

export interface Shot {
  id: string;
  label: string;
  duration: string;
  framing: string;
  /** 焦距/画幅描述, 如 "35mm" */
  lens: string;
  /** 相机型号 id(gear 库), 如 "sony-venice-2" */
  camera?: string;
  /** 镜头型号 id(gear 库), 如 "arri-master-prime" */
  lensModel?: string;
  movement: CameraMovement;
  action: string;
  acting: string;
  direction: "left-to-right" | "right-to-left";
  characterId?: string;
}

export interface Scene {
  id: string;
  name: string;
  logline: string;
  location: string;
  time: string;
  weather: string;
  duration: string;
  palette: string;
  lighting: string;
  environmentLock: boolean;
  /** 场景补充描述(环境细节等) */
  description?: string;
  shots: Shot[];
}

export interface Project {
  id: string;
  title: string;
  description: string;
  /** 兼容旧字段的电影预设名 */
  preset: string;
  /** 大师风格 id(styles 库), 如 "wong-kar-wai" */
  styleId?: string;
  /** 负面提示词(可编辑), 为空时编译回退默认约束 */
  negativePrompt?: string;
  scenes: Scene[];
  characters: Character[];
}

// ─────────────────────────────────────────────────────────────
// V0.2 数据模型（均为可选新增字段，兼容已有 JSON 项目）
// 见 docs/V0.2-CLICK-TO-PROMPT-IMPLEMENTATION.md 第 3 节
// ─────────────────────────────────────────────────────────────

export type AssetKind = "character" | "location" | "prop" | "style-reference" | "audio-reference";
export type LockLevel = "none" | "soft" | "strict";

/** 角色表演母版（P2/P5）：中英拆双子段，中文界面只读 *Zh，英文界面只读英文字段 */
export interface AssetActingProfile {
  /** 单段母版、固定块序（英文界面；英文约 150–220 词） */
  masterProfile?: string;
  /** 同上（中文界面，中文按当量字量） */
  masterProfileZh?: string;
  /** 声音锁定公式（英文界面），讲话时逐字粘贴 */
  voicePrompt?: string;
  /** 同上（中文界面） */
  voicePromptZh?: string;
  /** 表演目标 0–5，默认 ≥4 */
  performanceTarget?: number;
}

/** 场景表演目标（P2 五支柱）：目的 / 阻碍 / 代价 / 贯穿目标，每角色每镜结构化 */
export interface ActingObjective {
  /** 参与角色的资产 id */
  characterId: string;
  /** 目的：必须是对着具体对象行的动词，如 "make him confess" */
  objective: string;
  /** 全剧贯穿目标（可留空） */
  superObjective?: string;
  /** 外在 / 内在阻碍 */
  obstacle?: string;
  /** 失败代价：必须让角色害怕 */
  stakes?: string;
}

/** 资产库条目：图片 + 描述 + 引用规则 → 可复用资产 */
export interface Asset {
  id: string;
  kind: AssetKind;
  /** 名称：REIN / BAKERY INTERIOR / boombox */
  name: string;
  /** 英文 canonical 描述 */
  description: string;
  /** UI 辅助阅读 */
  descriptionZh?: string;
  /** 用户备注：仅供 AI 填写时参考，不参与任何提示词编译 */
  notes?: string;
  /** 同上（中文界面） */
  notesZh?: string;
  referencePaths: string[];
  /** 用途：face, body, wardrobe, appearance, environment… */
  useFor?: string[];
  /** 忽略：pose, background, lighting… */
  ignore?: string[];
  lockLevel: LockLevel;
  tags: string[];
  /** 角色独特标记：scar on left eye only */
  uniqueMarkers?: string[];
  /** 始终可见物件：black leather gloves on both hands at all times */
  alwaysVisible?: string[];
  /** 禁止混淆对象 */
  forbiddenConfusions?: string[];
  /** 声音音色（角色）：上传音频 dataURL（mp3/wav/m4a…），配音/音色参考 */
  voiceClip?: string;
  /** 角色表演母版 + 声音锁（仅角色；P2/P5） */
  actingProfile?: AssetActingProfile;
  /** 资产状态组；同一角色/地点/道具的状态变体共享该 id。 */
  variantGroupId?: string;
  /** 变体的基卡资产 id；基卡指向自身。 */
  baseAssetId?: string;
  /** 当前卡片的可见状态，如 base / wet / injured / night-rain。 */
  stateName?: string;
  /** 版本号只增不覆盖，作为提示词引用的一部分。 */
  version?: number;
  /** 新状态相对基卡的变化记录。 */
  changeLog?: string;
  /** 变体创建时冻结的基卡完整描述，导出时与当前变化描述合并。 */
  baseDescription?: string;
  baseDescriptionZh?: string;
  /** 资产在多动作、多景别试拍中的验收状态。 */
  stressTestStatus?: "untested" | "passed" | "failed";
  stressTestNotes?: string;
  /** 已持久化的稳定引用名：char_project_name_state_v1。 */
  referenceTag?: string;
}

/** 身份强锁规则（绑定 Character Asset） */
export interface IdentityRule {
  characterId: string;
  uniqueMarkers: string[];
  alwaysVisible?: string[];
  forbiddenConfusions?: string[];
}

/** 场景空间站位 */
export interface SceneStaging {
  locationAssetId?: string;
  priorContext?: string;
  /** 空间锚点：backs against white wall next to red doors */
  anchorDescription?: string;
  /** 左到右角色 ID 排序 */
  characterOrder?: string[];
  spacing?: string;
  axisDirection?: "left-to-right" | "right-to-left";
}

/** 镜头参与角色 */
export interface ShotParticipant {
  characterId: string;
  role: "primary" | "supporting" | "target" | "background";
  /** foreground-left / center / background-right */
  position?: string;
  /** already-in-frame / enters-left / enters-right */
  entrance?: "already-in-frame" | "enters-left" | "enters-right";
  /** 朝向：toward-camera / profile-left / profile-right / toward-center… */
  facing?: string;
  eyeline?: string;
  /** 身体朝向与视线分离（P1.5）：torso faces camera-left; eyes stay locked on @HERO */
  torsoFacing?: string;
  /** 标志物距离锚点（P1.5）：within 1 meter of the burned-out car */
  anchorDistance?: string;
}

/** 道具/角色/地点状态 */
export interface PropState {
  propId: string;
  /** on-ground / playing / intact / shattered… */
  state: string;
  holderCharacterId?: string;
  position?: string;
}

/** 动作节拍：谁 - 做什么 - 对谁/什么 - 结果 */
export interface ActionBeat {
  id: string;
  order: number;
  duration?: number;
  /** 墙钟起始秒（P1.4）：编译器按 startSeconds + duration 生成 0:00 to 0:03 */
  startSeconds?: number;
  framing?: string;
  lens?: string;
  cameraAngle?: string;
  actorId?: string;
  verb: string;
  targetCharacterId?: string;
  targetPropId?: string;
  targetBodyPart?: string;
  actionText?: string;
  dialogue?: string;
  note?: string;
  /** 策略动词（P2）：单一策略检测用 */
  tactic?: string;
  /** 潜台词（P2）：与台词相反的真实意图 */
  subtext?: string;
  /** 节拍变化（P2）：可见行为变化 */
  beatChange?: string;
  /** 反应先于对方台词结束（P2.6） */
  reactionBeforeLine?: string;
  /** 强制发生，进入 MUST 规则 */
  required?: boolean;
  /** 禁止目标：NOT 约束 */
  forbiddenTargets?: string[];
  stateBefore?: PropState[];
  stateAfter?: PropState[];
  /** cut when GUARD begins to fall */
  cutRule?: string;
}

/** 全局技术 Profile（点选式） */
export interface TechnicalProfile {
  format?: "photoreal" | "animation" | "documentary";
  filmStock?: string;
  resolution?: "4K" | "8K";
  fps?: 24 | 25 | 30;
  shutterAngle?: 90 | 180 | 360;
  cinematography?: string[];
  lighting?: string[];
  color?: string;
  skin?: string[];
  acting?: string[];
  physics?: string[];
  composition?: string[];
  sharpness?: string[];
  cameraAngles?: string[];
  /** 大师风格配方 id（点选后自动填充建议值，可覆写） */
  recipeId?: string;
  /** 已锁定的模块：风格配方点选时不覆盖这些字段 */
  lockedModules?: string[];
  /** 风格配方绑定的资产（角色/地点/道具/风格参考，来自资产库） */
  assetIds?: string[];
}

/** 音频计划 */
export interface AudioPlan {
  /** 画内音乐：boombox beat, car radio */
  diegeticMusic?: string[];
  /** 画内音乐来源道具（可选，如 boombox） */
  musicSourcePropId?: string;
  sfx?: string[];
  score: "none" | "original-score";
  subtitles: boolean;
}

/** 模型 Profile：决定图片引用语法、是否拆镜、输出策略 */
export interface ModelProfile {
  id: string;
  name: string;
  imageReferenceSyntax: "asset-id" | "at-mention" | "plain-text";
  maxReferences: number;
  preferredTemplate: "pro-sequence" | "shot-cards" | "asset-id-tagged";
  maxSecondsPerPrompt?: number;
  supportsNegativePrompt: boolean;
  supportsAudio: boolean;
  supportsMultiShot: boolean;
}

/** Prompt 版本（P2.2：每次编译存档，可从历史恢复结构而非纯文本） */
export interface PromptVersion {
  id: string;
  createdAt: string;
  template: string;
  modelProfileId?: string;
  outputText: string;
  /** 结构快照（编译时的项目 JSON，用于从历史恢复） */
  projectSnapshot: unknown;
  continuitySummary: { total: number; errors: number; warnings: number };
  /** 用户手动覆写文本（重新编译时需明确选择保留或重建） */
  manualOverride?: string;
}

// ── V0.2 扩展：Project / Scene / Shot ──

export interface ProjectV02 {
  /** 提示词编辑器当前内容；随工程持久化，关闭工作室后不丢失。 */
  compiledPrompt?: string;
  /** 资产库（角色/地点/道具/参考） */
  assets?: Asset[];
  /** 角色身份规则表 */
  identityRules?: IdentityRule[];
  technicalProfile?: TechnicalProfile;
  audioPlan?: AudioPlan;
  /** 一句风格话（导演简报·风格倾向：与配方二选一或叠加的自由描述） */
  styleBrief?: string;
  /** 一句风格话（中文界面；与英文分开保存） */
  styleBriefZh?: string;
  /** One-line style brief (English UI; stored separately from Chinese) */
  styleBriefEn?: string;
  /** 正向强约束（不可被风格预设覆盖） */
  positiveConstraints?: string[];
  /** 角色数量锁：EXACTLY N */
  characterCountLock?: number;
  /** 数据 schema 版本 */
  schemaVersion?: number;
  /** 资产 @ 引用使用的项目码。 */
  projectCode?: string;
}

export interface SceneV02 {
  staging?: SceneStaging;
  /** 情绪走向（一段物理可观察的情绪演进描述，P0.4 导演简报可选字段） */
  emotionArc?: string;
  /** 对白/台词（导演简报可选字段，AI 编译时写入镜头节拍） */
  dialogue?: string;
  /** 必须发生（硬约束：一定要发生的可见事件） */
  mustHappen?: string[];
  /** 禁止发生（硬约束：绝不能发生的画面/事件） */
  forbid?: string[];
  /** 场景默认相邻镜头时间关系（新镜头继承） */
  cutStyleDefault?: CutStyle;
  /** 拍摄模式（P2.3）：长镜头全镜统一相机参数；多镜头允许各镜换机位 */
  shootingMode?: "long-take" | "multi-shot";
  /** 导演文档分层（P0.5）：AI 编译产出的各层完整文本（key → 含段头文本块） */
  directorLayers?: Record<string, string>;
  /** 已锁定的导演文档层 key（P0.6）：再次 AI 编译不覆盖这些层 */
  lockedDirectorLayers?: string[];
  /** 首帧占位锁（P1.3）：首帧必须出现的角色/道具 + 占位文案 */
  firstFrameLock?: FirstFrameLock;
  /** 光线方向结构（P1.6）：主光源/方向/曝光优先/高光/禁止 */
  lightingDirection?: LightingDirection;
  /** 表演目标（P2）：每参与角色的目的/阻碍/代价/贯穿目标 */
  actingObjectives?: ActingObjective[];
}

/** 结构化时间（P1.2：废除解析 "0-8秒" 正则字符串） */
export interface TimeRange {
  startSeconds: number;
  endSeconds: number;
}

/** 相邻镜头时间关系（P1.2） */
export type CutStyle = "hard-cut" | "overlap" | "match-cut";

/* ===================== P1 镜头语言模块 ===================== */

/** 七档镜头语言（P1.1）：数字即 FOV 角度，聚焦可观测结果而非品牌 gear */
export type LensCharacter =
  | "47-standard"     // 标准，自然人眼
  | "84-wide"         // 经典广角，1–1.5m
  | "107-ultrawide"   // 广角正射，0.5–0.8m
  | "29-short-tele"   // 中近特写肖像
  | "18-tele"         // 经典长焦，6–8m
  | "8-supertele"     // 超长焦观察，20–25m + 前景遮挡
  | "135-immersive";  // 沉浸广角环境

/** 光学控制（P1.1）：可观测结果优先于焦距与品牌 */
export interface Optics {
  lensCharacter?: LensCharacter;
  /** 视场角 8–135（度） */
  fieldOfViewDegrees?: number;
  /** 可观测结果画像（见 lens-bank） */
  lensOutcome?: string[];
  /** 防漂移锁："LENS IS 47° ACROSS ALL SHOTS. NOT NEGOTIABLE." */
  antiDriftLock?: string;
}

/** 相机：物理操作员行为（P1.2） */
export interface CameraBehavior {
  height?: string;          // "at hip height" / "at snow level"
  distance?: string;        // "3 to 5 meters from subject"
  angle?: string;           // "slight low angle" / "3/4 angle preferred"
  side?: string;            // "on shadow side" / "camera-right of subject"
  subjectSize?: string;     // "full body" / "medium close-up"
  screenPlacement?: string; // "subject occupies screen-left third"
  focusBehavior?: string;   // "razor focus on the eyes"
  depthOfField?: string;
  handheldQuality?: string; // "operator breath, micro-settling, weight shift"
}

/** 每镜物理锚点（P1.7）：行走/奔跑/武器/液体/粒子 */
export type PhysicsAnchorKind = "walk" | "run" | "weapon" | "liquid" | "particle";

export interface PhysicsAnchor {
  kind: PhysicsAnchorKind;
  /** 附加自由文本，补充或细化预设锚点 */
  detail?: string;
}

/** 首帧占位锁（P1.3） */
export interface FirstFrameLock {
  /** 首帧必须出现的角色/道具 id */
  requiredSubjectIds?: string[];
  /** 输出文案，缺省用模板 */
  occupancyStatement?: string;
}

/** 光线方向结构（P1.6） */
export interface LightingDirection {
  /** 主光源类型 */
  primarySource?: string;
  /** 光线方向："camera-right, behind and to the side" */
  direction?: string;
  /** 曝光优先：按背景曝光 / 按面曝光 */
  exposurePriority?: string;
  /** 允许的高光 */
  allowHighlights?: string[];
  /** 禁止：no flat front light / no beauty fill */
  forbid?: string[];
}

export interface ShotV02 {
  /** 多参与角色（顺序 = 添加顺序，用于身份编号稳定） */
  participants?: ShotParticipant[];
  /** 按时间排列的动作节拍 */
  beats?: ActionBeat[];
  /** 镜头开始时道具状态 */
  propStatesAtStart?: PropState[];
  /** 镜头结束时道具状态（跨镜头状态链：下一镜头自动继承） */
  propStatesAtEnd?: PropState[];
  /** 结构化时间范围（优先于旧 duration 字符串） */
  time?: TimeRange;
  /** 相邻镜头时间关系 */
  cutStyle?: CutStyle;
  /** 光学控制（P1.1） */
  optics?: Optics;
  /** 相机：物理操作员行为（P1.2） */
  cameraBehavior?: CameraBehavior;
  /** 每镜物理锚点（P1.7）：行走/奔跑/武器/液体/粒子 */
  physicsAnchors?: PhysicsAnchor[];
  /** 镜头表演评分 0–5（P2.8：AI 自评 + 人工可改） */
  performanceLevel?: 0 | 1 | 2 | 3 | 4 | 5;
  /** 眼部生活（P2.6）：微扫视/眨眼质量/瞳光/眼睛先于转头，每镜必填 */
  eyeLife?: string;
  note?: string;
  /** 镜头布局（继承 SceneStaging，可覆写） */
  layout?: {
    /** 使用场景站位：true 继承 SceneStaging.characterOrder */
    useSceneStaging?: boolean;
    /** 镜头级左到右排序（存在即覆写场景站位） */
    characterOrder?: string[];
    axisDirection?: "left-to-right" | "right-to-left";
    anchorDescription?: string;
    /** 故意越轴标记（相邻镜头方向翻转时消除警告） */
    intentionalAxisBreak?: boolean;
    axisNote?: string;
  };
}

export type ProjectV2 = Omit<Project, "scenes" | "characters"> & ProjectV02 & { scenes: SceneV2[]; characters?: Character[] };
export type SceneV2 = Omit<Scene, "shots"> & SceneV02 & { shots: ShotV2[] };
export type ShotV2 = Shot & ShotV02;

/** 连续性问题（新引擎） */
export interface ContinuityIssueV2 {
  code: string;
  severity: "error" | "warning" | "info";
  entityId?: string;
  label: string;
  detail: string;
  /** 中文界面使用的详情文案（引擎按 zh 生成，保持与其他字段一致的插值语义） */
  detailZh?: string;
  /** 该问题是否可一键修复（UI 修复按钮文案，为空表示不可自动修复） */
  fixLabel?: string;
}

/** 每镜头风险评分 */
export interface ShotRisk {
  shotId: string;
  score: number; // 0-10
  level: "low" | "medium" | "high";
  reasons: string[];
  suggestion: string;
}
