/**
 * 镜头运动预设库（镜头执行详情 · 运动）
 *
 * 单一数据源：下拉选项 / 分组 / 中英标签 / 适用场景提示 / AI 词表全部由此派生，
 * 避免「UI 有、编译词典没有」这类漂移（此前 Pan、Tilt、Push-in、Trucking 只有词典没有选项）。
 *
 * 这里的每个 id 都是结构化枚举值（见 shared-types 的 CameraMovement），
 * 会作为短标签编译进提示词的 CAMERA 段与镜头执行的「机位起手式」。
 * sceneZh / sceneEn 只用于界面提示，不进入提示词。
 */

export type CameraMovementGroup = "basic" | "rig" | "perspective" | "stylized";

export type CameraMovementLocale = "zh" | "en";

export interface CameraMovementPreset {
  id: string;
  group: CameraMovementGroup;
  zh: string;
  en: string;
  /** 适用场景（界面提示，不进提示词） */
  sceneZh: string;
  sceneEn: string;
}

export const CAMERA_MOVEMENT_GROUP_ORDER: CameraMovementGroup[] = [
  "basic",
  "rig",
  "perspective",
  "stylized",
];

export const CAMERA_MOVEMENT_GROUP_LABELS: Record<CameraMovementGroup, { zh: string; en: string }> = {
  basic: { zh: "基础运镜", en: "Basic moves" },
  rig: { zh: "机位与设备", en: "Rig & support" },
  perspective: { zh: "视角关系", en: "Viewpoint" },
  stylized: { zh: "风格化运镜", en: "Stylized moves" },
};

export const CAMERA_MOVEMENT_PRESETS: CameraMovementPreset[] = [
  // ── 基础运镜 ────────────────────────────────────────────────────────
  {
    id: "Static", group: "basic", zh: "固定", en: "Static",
    sceneZh: "画面完全锁定，只让表演、呼吸和光线自己发生；最稳，也最依赖走位调度。",
    sceneEn: "Hold the frame completely still and let performance, breath, and light do the work; the most stable option and the most dependent on blocking.",
  },
  {
    id: "Pan", group: "basic", zh: "摇镜", en: "Pan",
    sceneZh: "机位不动，水平摇向新主体或揭示空间；用于交接注意力、交代环境关系。",
    sceneEn: "Pivot horizontally from a fixed position to hand off attention or reveal space.",
  },
  {
    id: "Tilt", group: "basic", zh: "俯仰", en: "Tilt",
    sceneZh: "机位不动，垂直摇上或摇下；用于揭示身高体量、头顶上空或脚下细节。",
    sceneEn: "Pivot vertically from a fixed position to reveal stature, the space overhead, or detail underfoot.",
  },
  {
    id: "Push-in", group: "basic", zh: "推近", en: "Push-in",
    sceneZh: "直线推向主体、景别逐步收紧；用于情绪升温、意识到关键信息。",
    sceneEn: "Move straight toward the subject as the shot tightens; use it for rising emotion or a realization.",
  },
  {
    id: "Pull-out", group: "basic", zh: "拉远", en: "Pull-out",
    sceneZh: "从主体向后拉远、逐步露出环境；用于孤立感、退让、收尾留白。",
    sceneEn: "Ease back from the subject and reveal the surroundings; use it for isolation, withdrawal, or an ending.",
  },
  {
    id: "Trucking", group: "basic", zh: "横移", en: "Trucking",
    sceneZh: "与主体平行横向平移、距离不变；用于并列观察、贴住对话节奏。",
    sceneEn: "Slide sideways parallel to the subject at a constant distance; good for parallel observation and keeping pace with dialogue.",
  },
  {
    id: "Tracking", group: "basic", zh: "跟拍", en: "Tracking",
    sceneZh: "跟随运动中的主体并保持画面位置；用于行走、追逐、揭示目的地。",
    sceneEn: "Follow a moving subject while holding its frame position; use it for walking, pursuit, or revealing a destination.",
  },
  {
    id: "Dolly", group: "basic", zh: "移轨", en: "Dolly",
    sceneZh: "沿轨道平稳移动，可推可拉可横移；最接近摄影机的物理运动质感。",
    sceneEn: "Move smoothly along track in any direction; the most physically grounded camera movement.",
  },
  {
    id: "Crane", group: "basic", zh: "摇臂", en: "Crane",
    sceneZh: "摇臂或升降机上抬 / 下压，同时改变高度与俯仰；用于规模感、登场、收尾。",
    sceneEn: "Rise or descend on a crane, changing height and pitch together; use it for scale, entrances, or endings.",
  },
  {
    id: "Arc", group: "basic", zh: "弧线环绕", en: "Arc",
    sceneZh: "以主体为圆心走一段弧线，机位与背景同时变化；用于关系变化、揭示隐藏信息。",
    sceneEn: "Travel a partial arc around the subject so position and background change together; use it for relationship shifts or a withheld reveal.",
  },
  {
    id: "Orbit", group: "basic", zh: "环绕", en: "Orbit",
    sceneZh: "绕主体持续环绕、背景不断流动；用于对峙、孤立、时间压力。",
    sceneEn: "Circle the subject continuously so the background keeps flowing; use it for standoffs, isolation, or time pressure.",
  },
  {
    id: "Zoom", group: "basic", zh: "变焦", en: "Zoom",
    sceneZh: "机位不动、只改变焦距压缩或扩张空间；慎用，除非刻意风格化。",
    sceneEn: "Change focal length from a locked position to compress or expand space; use sparingly and only when stylised.",
  },

  // ── 机位与设备 ──────────────────────────────────────────────────────
  {
    id: "Handheld", group: "rig", zh: "手持", en: "Handheld",
    sceneZh: "摄影师呼吸与脚步带来真实晃动；用于压力、纪录感、失控边缘。",
    sceneEn: "Operator breath and footsteps create honest instability; use it for pressure, documentary feel, or a character losing control.",
  },
  {
    id: "Steadicam", group: "rig", zh: "斯坦尼康", en: "Steadicam",
    sceneZh: "稳定器长镜头平滑穿行空间；用于调度复杂的一镜到底。",
    sceneEn: "A stabilised long take that travels smoothly through space; use it for complex oners.",
  },
  {
    id: "Gimbal", group: "rig", zh: "稳定器", en: "Gimbal",
    sceneZh: "三轴稳定、运动干净顺滑；低角度与快速跟随都适用。",
    sceneEn: "Three-axis stabilisation with clean, smooth motion; works for low angles and fast follow moves.",
  },
  {
    id: "Drone", group: "rig", zh: "航拍", en: "Drone",
    sceneZh: "空中视角，可升可降可环绕；用于规模建立、地理关系、追击。",
    sceneEn: "An aerial vantage that can rise, descend, or orbit; use it for scale, geography, or pursuit.",
  },
  {
    id: "Cable cam", group: "rig", zh: "索道", en: "Cable cam",
    sceneZh: "沿固定索道高速平移、路线可预判；用于体育、追踪、长距离穿行。",
    sceneEn: "High-speed travel along a fixed cable with a repeatable path; use it for sport, pursuit, or long traverses.",
  },
  {
    id: "Vehicle", group: "rig", zh: "车载", en: "Vehicle",
    sceneZh: "摄影机固定在车或交通工具上随载具运动；用于公路、追逐、旅途。",
    sceneEn: "Mount the camera to a vehicle so it moves with the ride; use it for roads, chases, or journeys.",
  },
  {
    id: "Robot arm", group: "rig", zh: "机械臂", en: "Robot arm",
    sceneZh: "高精度可重复的复杂轨迹，可极快也可极慢；用于产品、特效与精确重复。",
    sceneEn: "Highly repeatable complex trajectories, very fast or very slow; use it for product shots, effects, and exact repeats.",
  },
  {
    id: "Snorricam", group: "rig", zh: "贴身固定", en: "Snorricam",
    sceneZh: "摄影机固定在演员身上，人物与镜头同步移动；用于精神失衡、眩晕、崩溃。",
    sceneEn: "Rig the camera to the performer so body and lens move as one; use it for dissociation, vertigo, or breakdown.",
  },

  // ── 视角关系 ────────────────────────────────────────────────────────
  {
    id: "POV", group: "perspective", zh: "主观镜头", en: "POV",
    sceneZh: "以角色的眼睛为镜头，观众与角色共用视点；用于代入、发现、恐惧。",
    sceneEn: "Make the lens the character's eye so audience and character share a viewpoint; use it for identification, discovery, or fear.",
  },
  {
    id: "OTS", group: "perspective", zh: "过肩镜头", en: "OTS",
    sceneZh: "越过前景人物的肩观察对象，建立两人的空间关系；用于对话与对峙。",
    sceneEn: "Observe past a foreground shoulder to define the spatial relationship between two people; use it for dialogue and standoffs.",
  },
  {
    id: "Reverse tracking", group: "perspective", zh: "反向跟拍", en: "Reverse tracking",
    sceneZh: "摄影机在主体前方倒行、人物迎面走来；用于交谈式跟随、情绪推进。",
    sceneEn: "Lead the subject while walking backward so they advance toward the lens; use it for conversational follow moves.",
  },

  // ── 风格化运镜 ──────────────────────────────────────────────────────
  {
    id: "Whip-pan", group: "stylized", zh: "甩镜", en: "Whip-pan",
    sceneZh: "高速甩动连接两个空间或两个节拍；常用于转场与动作衔接。",
    sceneEn: "A fast whip that links two spaces or two beats; commonly used for transitions and action handoffs.",
  },
  {
    id: "Dolly zoom", group: "stylized", zh: "推拉变焦", en: "Dolly zoom",
    sceneZh: "机位推进同时反向变焦，人物大小不变而背景透视拉伸；用于主观失衡。",
    sceneEn: "Track in while zooming the opposite way so the subject holds size and the background stretches; use it for subjective destabilisation.",
  },
  {
    id: "Snap zoom", group: "stylized", zh: "急推变焦", en: "Snap zoom",
    sceneZh: "极快的推焦，瞬间锁定细节或制造冲击；用于喜剧、惊悚、强调。",
    sceneEn: "An extremely fast zoom that slams onto detail or impact; use it for comedy, thriller punctuation, or emphasis.",
  },
];

const PRESET_BY_ID = new Map(CAMERA_MOVEMENT_PRESETS.map((preset) => [preset.id, preset]));

/** 全部预设 id（顺序即下拉顺序） */
export const CAMERA_MOVEMENT_IDS: string[] = CAMERA_MOVEMENT_PRESETS.map((preset) => preset.id);

/** 下拉分组（含组名），供 select 的 optgroup 使用 */
export function cameraMovementGroupedOptions(
  locale: CameraMovementLocale,
): { label: string; values: string[] }[] {
  return CAMERA_MOVEMENT_GROUP_ORDER.map((group) => ({
    label: CAMERA_MOVEMENT_GROUP_LABELS[group][locale],
    values: CAMERA_MOVEMENT_PRESETS.filter((preset) => preset.group === group).map((preset) => preset.id),
  }));
}

export function cameraMovementPreset(id: string | undefined): CameraMovementPreset | undefined {
  return id ? PRESET_BY_ID.get(id) : undefined;
}

/**
 * 下拉分组：预设分组 + （当前值不在预设中时）前置一个「当前值」组。
 * AI 或历史数据可能写入自由文本运动值，必须让它继续可见、不被静默丢弃。
 */
export function cameraMovementSelectGroups(
  current: string | undefined,
  locale: CameraMovementLocale,
): { label: string; values: string[] }[] {
  const groups = cameraMovementGroupedOptions(locale);
  if (!current || PRESET_BY_ID.has(current)) return groups;
  return [{ label: locale === "zh" ? "当前值" : "Current", values: [current] }, ...groups];
}

/** 结构值 → 当前语言标签；未知值原样返回（兼容历史数据里的自由文本） */
export function cameraMovementLabel(id: string | undefined, locale: CameraMovementLocale): string {
  if (!id) return "";
  const preset = PRESET_BY_ID.get(id);
  return preset ? preset[locale] : id;
}

/** 当前运动的适用场景提示（界面用，不进提示词） */
export function cameraMovementHint(id: string | undefined, locale: CameraMovementLocale): string {
  if (!id) return "";
  const preset = PRESET_BY_ID.get(id);
  if (!preset) {
    return locale === "zh"
      ? "自定义运动值，不在预设列表中，将原样编译进提示词。"
      : "Custom movement value outside the preset list; compiled into the prompt as-is.";
  }
  return locale === "zh" ? `适用场景：${preset.sceneZh}` : `Best for: ${preset.sceneEn}`;
}

/** 生成「中英双语标签表」，供界面各处复用同一份标签 */
export function cameraMovementLabels(locale: CameraMovementLocale): Record<string, string> {
  const table: Record<string, string> = {};
  for (const preset of CAMERA_MOVEMENT_PRESETS) table[preset.id] = preset[locale];
  return table;
}

/** AI 词表：告诉模型只能从这些结构化值里选 */
export function cameraMovementVocab(): string {
  return CAMERA_MOVEMENT_IDS.join(", ");
}

/**
 * 同义词表：把 AI 或历史数据里常见的运动写法归一到预设 id。
 * key 已经是「小写 + 空格/下划线转连字符」之后的形态。
 */
const CAMERA_MOVEMENT_ALIASES: Record<string, string> = {
  // 固定
  "static-camera": "Static", fixed: "Static", locked: "Static", "locked-off": "Static", "lock-off": "Static",
  固定: "Static", 静态: "Static", 固定机位: "Static",
  // 手持 / 稳定
  "hand-held": "Handheld", 手持: "Handheld", 手持摄影: "Handheld",
  steadicam: "Steadicam", 斯坦尼康: "Steadicam",
  gimbal: "Gimbal", 稳定器: "Gimbal", 三轴稳定器: "Gimbal",
  // 基础移动
  dolly: "Dolly", 移轨: "Dolly", 轨道: "Dolly",
  "dolly-in": "Push-in", push: "Push-in", pushin: "Push-in", 推近: "Push-in", 推进: "Push-in",
  "dolly-out": "Pull-out", pull: "Pull-out", pullout: "Pull-out", "pull-back": "Pull-out", 拉远: "Pull-out", 后拉: "Pull-out",
  truck: "Trucking", trucking: "Trucking", crab: "Trucking", 横移: "Trucking", 平移: "Trucking",
  tracking: "Tracking", 跟拍: "Tracking", 跟随: "Tracking",
  crane: "Crane", jib: "Crane", 摇臂: "Crane", 升降: "Crane",
  pan: "Pan", panning: "Pan", 摇镜: "Pan", 摇摄: "Pan", 横摇: "Pan",
  tilt: "Tilt", 俯仰: "Tilt",
  arc: "Arc", 弧线: "Arc", 弧线环绕: "Arc",
  orbit: "Orbit", "orbit-360": "Orbit", 环绕: "Orbit",
  zoom: "Zoom", 变焦: "Zoom",
  // 视角
  "point-of-view": "POV", "first-person": "POV", 主观镜头: "POV", 主观: "POV",
  "over-the-shoulder": "OTS", 过肩镜头: "OTS", 过肩: "OTS",
  "reverse-tracking": "Reverse tracking", "backward-tracking": "Reverse tracking", "backwards-tracking": "Reverse tracking",
  反向跟拍: "Reverse tracking",
  // 设备
  drone: "Drone", aerial: "Drone", "drone-aerial": "Drone", 航拍: "Drone", 无人机: "Drone",
  "cable-cam": "Cable cam", cablecam: "Cable cam", cable: "Cable cam", 索道: "Cable cam",
  vehicle: "Vehicle", "car-mount": "Vehicle", car: "Vehicle", 车载: "Vehicle", 跟车: "Vehicle",
  "robot-arm": "Robot arm", robotarm: "Robot arm", bolt: "Robot arm", 机械臂: "Robot arm",
  snorricam: "Snorricam", "body-mount": "Snorricam", 贴身固定: "Snorricam", 身体固定: "Snorricam",
  // 风格化
  "whip-pan": "Whip-pan", whippan: "Whip-pan", whip: "Whip-pan", "swish-pan": "Whip-pan", 甩镜: "Whip-pan",
  "dolly-zoom": "Dolly zoom", dollyzoom: "Dolly zoom", vertigo: "Dolly zoom", zolly: "Dolly zoom",
  推拉变焦: "Dolly zoom", 眩晕效应: "Dolly zoom",
  "snap-zoom": "Snap zoom", snapzoom: "Snap zoom", "crash-zoom": "Snap zoom", 急推变焦: "Snap zoom", 急推: "Snap zoom",
};

/**
 * 把 AI / 历史数据里的运动文本归一到预设 id。
 * 命中预设或同义词表 → 返回规范 id；否则原样返回（自由文本不丢弃）。
 */
export function normalizeCameraMovement(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  const exact = CAMERA_MOVEMENT_PRESETS.find((preset) => preset.id.toLowerCase() === lower);
  if (exact) return exact.id;
  const key = lower.replace(/[\s_]+/g, "-").replace(/-{2,}/g, "-");
  return CAMERA_MOVEMENT_ALIASES[key] ?? trimmed;
}
