/**
 * RunningHub「工作流」通道：把 ComfyUI 工作流 JSON 解析成可填参数。
 *
 * ## 为什么需要这个解析器
 *
 * 官方**没有**「这个工作流有哪些可填参数」的查询接口 —— 实测结果：
 *   - `/api/workflow/detail` `/api/workflow/nodeInfo` → 403 TOKEN_MISSION（要网页登录态）
 *   - `POST /openapi/v2/workflow/info` → 1001 Invalid URL（v2 网关不认识）
 *   - `/task/openapi/workflow/*` → 404
 *   - 文档站 404 个端点里 0 个跟 workflow 有关
 *
 * 文档原文只说 nodeId 来自 **"the exported workflow JSON"**, 也就是把「参数发现」这件事
 * 交给使用者。好在 ComfyUI 的 API 格式 JSON 是自描述的:
 *
 *   { "3": { "class_type": "KSampler", "inputs": { "seed": 1, "model": ["4", 0] } } }
 *
 * 于是「导入工作流」唯一可行的形态是: 用户粘 JSON → 这里解析出可填字段 → UI 渲染表单。
 * 这个过程不需要任何平台接口, 也就不会因为平台改接口而失效。
 *
 * ## 只支持 API 格式
 *
 * ComfyUI 有两种导出格式:
 *   - **API 格式**(`{"3": {"class_type": ...}}`) —— 有完整的节点输入, 能做参数表单;
 *   - UI 格式(`{"nodes": [...], "links": [...]}`) —— 输入值在 `widgets_values` 数组里,
 *     **数组下标与字段名的对应关系取决于节点定义**, 没有节点 schema 就无法可靠还原。
 *
 * 所以遇到 UI 格式直接给出明确指引, 而不是猜一个错位的表单让用户改错参数。
 */

/** 表单控件类型。 */
export type RunningHubWorkflowControl =
  | 'text'
  | 'textarea'
  | 'number'
  | 'seed'
  | 'switch'
  | 'image'
  | 'video'
  | 'audio';

/** 工作流里一个可填字段。 */
export interface RunningHubWorkflowField {
  /** 稳定主键: `${nodeId}.${inputName}` */
  key: string;
  nodeId: string;
  inputName: string;
  /** 节点显示名: `_meta.title` 优先, 否则 class_type。 */
  nodeLabel: string;
  classType: string;
  control: RunningHubWorkflowControl;
  /** JSON 里的当前值, 统一转成字符串(提交时也是字符串)。 */
  defaultValue: string;
  /**
   * 是否属于「关键参数」—— 文本提示词 / 素材 / 随机种子。
   * UI 默认展开这些, 其余(步数、采样器、模型名…)收进「高级」。
   */
  primary: boolean;
}

export type RunningHubWorkflowOutputKind = 'image' | 'video' | 'audio';

export interface RunningHubWorkflowSchema {
  fields: RunningHubWorkflowField[];
  /** 解析出的节点总数(不含无法识别的条目)。 */
  nodeCount: number;
  /** 输出类型: 按 Save* 节点推断, 用户仍可覆盖。 */
  outputKind: RunningHubWorkflowOutputKind;
  /** 非致命问题(未识别到输出节点等), UI 直接展示。 */
  warnings: string[];
}

/** 素材类输入: 按字段名 + class_type 双判据, 只靠字段名会误伤(很多节点都有个叫 image 的参数)。 */
const MEDIA_INPUT_PATTERNS: Array<{ kind: 'image' | 'video' | 'audio'; inputs: RegExp; classTypes: RegExp }> = [
  {
    kind: 'image',
    inputs: /^(?:image|images|image_path|input_image|init_image|image1|image_1)$/i,
    classTypes: /LoadImage|LoadImageMask|ReadImage|ImageLoad|LoadImagesFromDir/i,
  },
  {
    kind: 'video',
    inputs: /^(?:video|videos|video_path|video_file|file|filename|upload)$/i,
    classTypes: /LoadVideo|VHS_LoadVideo|VideoLoad|LoadVideoUpload|VHS_LoadVideoPath/i,
  },
  {
    kind: 'audio',
    inputs: /^(?:audio|audio_path|sound|voice|audio_file)$/i,
    classTypes: /LoadAudio|AudioLoad|VHS_LoadAudio|LoadAudioUpload/i,
  },
];

/** 输出类型判据。优先级: 视频 > 音频 > 图片 —— 同时存在时以「最重的产物」为准。 */
const OUTPUT_PATTERNS: Array<{ kind: RunningHubWorkflowOutputKind; classTypes: RegExp }> = [
  { kind: 'video', classTypes: /VHS_VideoCombine|SaveVideo|SaveWEBM|SaveAnimatedWEBP/i },
  { kind: 'audio', classTypes: /SaveAudio|PreviewAudio|SaveAudioMP3|SaveAudioOpus/i },
  { kind: 'image', classTypes: /SaveImage|PreviewImage|ImageSave|SaveImageWebsocket/i },
];

/** 文本类字段名: 命中就当多行文本框, 其余字符串字段(枚举名 / 路径)走折叠的 text。 */
const TEXTAREA_INPUTS = /^(?:text|prompt|positive|negative|positive_prompt|negative_prompt|string|description)$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 把 JSON 里的原始值转成提交用的字符串。
 *
 * 布尔要转 `true` / `false`(JS 默认的 `String(true)` 正好是这个), 数值保留原样,
 * 目的是让"没改过的字段"发出去与 JSON 里完全一致 —— 工作流对类型敏感,
 * 把 `0.8` 发成 `"0.8"` 大多数节点能接受, 但发成 `"0.80000001"` 就未必。
 */
function stringifyValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return null;
}

/** 值是否为「节点连线」(形如 `["6", 0]`)。这类输入由上游节点提供, 不是用户可填项。 */
function isLinkValue(value: unknown): boolean {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number';
}

/**
 * 解开 ComfyUI 的「包装值」。
 *
 * 部分自定义节点把真实值包在 `{ __value__: [...] }` 里(例如带开关的 speak_and_recognation),
 * 这种情况取内层值; 其余对象类型(嵌套配置 / 子图)无法用单行输入表达, 直接跳过。
 */
function unwrapValue(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const inner = value.__value__;
  if (Array.isArray(inner) && inner.length === 1) return inner[0];
  return undefined;
}

function resolveControl(
  classType: string,
  inputName: string,
  value: unknown,
): RunningHubWorkflowControl | null {
  for (const pattern of MEDIA_INPUT_PATTERNS) {
    if (pattern.inputs.test(inputName) && pattern.classTypes.test(classType)) return pattern.kind;
  }
  if (typeof value === 'boolean') return 'switch';
  if (typeof value === 'number') {
    return /^(?:seed|noise_seed|rand_seed|random_seed)$/i.test(inputName) ? 'seed' : 'number';
  }
  if (typeof value === 'string') {
    if (TEXTAREA_INPUTS.test(inputName)) return 'textarea';
    // 值本身就是一段自然语言(含空格且够长)时也按多行处理, 免得长句挤在单行里。
    if (value.length > 40 && /\s/.test(value)) return 'textarea';
    return 'text';
  }
  return null;
}

/** 关键参数: 素材 / 文本提示词 / 种子。其余进「高级」。 */
function isPrimaryControl(control: RunningHubWorkflowControl): boolean {
  return control === 'image' || control === 'video' || control === 'audio' || control === 'textarea' || control === 'seed';
}

/** 节点排序: 数字 id 按数值, 非数字 id 排后面并按字典序。 */
function compareNodeId(left: string, right: string): number {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  const leftIsNumber = left.trim() !== '' && Number.isFinite(leftNumber);
  const rightIsNumber = right.trim() !== '' && Number.isFinite(rightNumber);
  if (leftIsNumber && rightIsNumber) return leftNumber - rightNumber;
  if (leftIsNumber) return -1;
  if (rightIsNumber) return 1;
  return left.localeCompare(right);
}

/**
 * 解析 ComfyUI 工作流 JSON。
 *
 * @throws Error 当内容不是 JSON / 是 UI 格式 / 找不到任何可填字段时, 抛出**可直接展示**的中文原因。
 */
export function parseRunningHubWorkflow(jsonText: string): RunningHubWorkflowSchema {
  const trimmed = jsonText.trim();
  if (!trimmed) throw new Error('请先粘贴工作流 JSON');

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('这不是合法的 JSON，请重新导出工作流后粘贴');
  }
  if (!isPlainObject(parsed)) {
    throw new Error('工作流 JSON 的顶层应该是一个对象');
  }
  // UI 格式: 顶层有 nodes 数组。它的输入值在 widgets_values 里, 没有节点 schema 无法
  // 可靠还原字段名 —— 猜出来的表单会让用户改错参数, 不如直接说清楚怎么导。
  if (Array.isArray(parsed.nodes)) {
    throw new Error(
      '这是 ComfyUI 的界面格式。请在 ComfyUI 里用「导出（API）」/ RunningHub 工作流页的「导出 API」得到 API 格式 JSON 再粘贴',
    );
  }

  const fields: RunningHubWorkflowField[] = [];
  const warnings: string[] = [];
  const nodeIds = Object.keys(parsed).filter((key) => isPlainObject(parsed[key])).sort(compareNodeId);

  for (const nodeId of nodeIds) {
    const node = parsed[nodeId] as Record<string, unknown>;
    const classType = typeof node.class_type === 'string' ? node.class_type : '';
    if (!classType) continue;
    const inputs = isPlainObject(node.inputs) ? node.inputs : null;
    if (!inputs) continue;
    const meta = isPlainObject(node._meta) ? node._meta : null;
    const nodeLabel =
      meta && typeof meta.title === 'string' && meta.title.trim() ? meta.title.trim() : classType;

    for (const [inputName, rawValue] of Object.entries(inputs)) {
      // 连线型输入由上游节点提供, 不是可填项。
      if (isLinkValue(rawValue)) continue;
      const value = unwrapValue(rawValue);
      if (value === undefined || value === null) continue;
      const control = resolveControl(classType, inputName, value);
      if (!control) continue;
      const defaultValue = stringifyValue(value);
      if (defaultValue === null) continue;
      fields.push({
        key: `${nodeId}.${inputName}`,
        nodeId,
        inputName,
        nodeLabel,
        classType,
        control,
        defaultValue,
        primary: isPrimaryControl(control),
      });
    }
  }

  if (!fields.length) {
    throw new Error('这个工作流里没有找到可填参数，请确认导出的是 API 格式 JSON');
  }

  let outputKind: RunningHubWorkflowOutputKind | null = null;
  for (const pattern of OUTPUT_PATTERNS) {
    const hit = nodeIds.some((nodeId) => {
      const node = parsed[nodeId] as Record<string, unknown>;
      return typeof node.class_type === 'string' && pattern.classTypes.test(node.class_type);
    });
    if (hit) {
      outputKind = pattern.kind;
      break;
    }
  }
  if (!outputKind) {
    outputKind = 'image';
    warnings.push('没有识别到保存类节点（SaveImage / VHS_VideoCombine 等），输出类型暂按图片处理');
  }

  return { fields, nodeCount: nodeIds.length, outputKind, warnings };
}

/** 提交时的一项节点参数。`mediaKind` 存在表示这一项要先把本地素材换成公网 URL。 */
export interface RunningHubWorkflowNodeValue {
  nodeId: string;
  fieldName: string;
  fieldValue: string;
  mediaKind?: 'image' | 'video' | 'audio';
}

/**
 * 把「字段定义 + 用户填的值」组装成平台要的 `nodeInfoList`。
 *
 * **全部字段都提交**, 不是只提交改动过的: 工作流 API 是覆盖式的, 而用户粘进来的 JSON
 * 就是他对这次运行的全部配置意图。只发改动过的会让"参数以平台模板为准", 与
 * "导入这份工作流"的语义相反。
 */
export function buildRunningHubWorkflowNodeInfoList(
  fields: RunningHubWorkflowField[],
  values: Record<string, string | undefined>,
): RunningHubWorkflowNodeValue[] {
  const result: RunningHubWorkflowNodeValue[] = [];
  for (const field of fields) {
    const raw = values[field.key];
    const fieldValue = typeof raw === 'string' ? raw : field.defaultValue;
    const mediaKind =
      field.control === 'image' || field.control === 'video' || field.control === 'audio'
        ? field.control
        : undefined;
    result.push({ nodeId: field.nodeId, fieldName: field.inputName, fieldValue, ...(mediaKind ? { mediaKind } : {}) });
  }
  return result;
}

/**
 * 从 `https://www.runninghub.cn/workflow/1904136902449209346` 这类链接里取出工作流 ID。
 *
 * 用户手里多半是浏览器地址栏里那条 URL, 让他自己截数字很容易多带一个字符。
 */
export function extractRunningHubWorkflowId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  if (/^\d{6,}$/.test(trimmed)) return trimmed;
  const match = /(?:workflow|ai-detail)\/(\d{6,})/i.exec(trimmed);
  if (match) return match[1];
  const digits = trimmed.match(/\d{6,}/);
  return digits ? digits[0] : '';
}

/** 判断一个值是不是 ComfyUI 的图（至少有一个节点带 inputs）。 */
function looksLikeWorkflowGraph(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  return Object.values(value).some((node) => isPlainObject(node) && isPlainObject(node.inputs));
}

/**
 * 从平台「拉取工作流」接口的响应里取出图。
 *
 * `POST /api/openapi/getJsonApiFormat` 的返回形态不统一（不同版本的网关把图放在
 * `data.prompt` / `data.workflow` / 直接 `data` 里，而且**常被再序列化一层字符串**），
 * 所以这里逐个候选试，并对字符串值做两次解包。
 *
 * @throws Error 找不到可解析的图时，把响应的开头截出来 —— 报错信息本身就是排查线索。
 */
export function extractRunningHubWorkflowJson(raw: unknown): string {
  const candidates: unknown[] = [
    isPlainObject(raw) && isPlainObject(raw.data) ? raw.data.prompt : undefined,
    isPlainObject(raw) && isPlainObject(raw.data) ? raw.data.workflow : undefined,
    isPlainObject(raw) && isPlainObject(raw.data) ? raw.data : undefined,
    isPlainObject(raw) ? raw.prompt : undefined,
    isPlainObject(raw) ? raw.workflow : undefined,
    raw,
  ];
  for (const candidate of candidates) {
    let value = candidate;
    // 网关可能把图序列化成字符串塞进字段里，最多解两层。
    for (let depth = 0; depth < 2 && typeof value === 'string'; depth += 1) {
      const text = value.trim();
      if (!text) break;
      try {
        value = JSON.parse(text);
      } catch {
        break;
      }
    }
    if (looksLikeWorkflowGraph(value)) return JSON.stringify(value);
  }
  throw new Error(
    `工作流接口没有返回可解析的工作流 JSON：${JSON.stringify(raw).slice(0, 300)}`,
  );
}

