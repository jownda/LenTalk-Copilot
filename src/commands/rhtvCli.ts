import { invoke, isTauri } from '@tauri-apps/api/core';
import i18n from '@/i18n';

/** 画布 CLI（rhtvcli）探测结果。登录态由 CLI 自己维护（浏览器授权 + 系统钥匙串）。 */
export interface RhtvCliStatus {
  found: boolean;
  executable: string;
  resolvedPath: string | null;
  version: string | null;
  loggedIn: boolean;
  userId: string | null;
  /** LenTalk 专用画布的 canvasId；首次生成时自动创建并落盘。 */
  canvasId: string | null;
  message: string;
}

/** 目录项。字段由画布服务端定义，前端只做展示映射。 */
export interface RhtvModelItem {
  modelCode: string;
  name?: string;
  nameEn?: string;
  types?: string[];
  buckets?: string[];
  modelType?: string;
  available?: boolean;
  skuId?: string;
  schemaHash?: string;
}

/** 模型 schema 里的一项（比例 / 分辨率 / 时长 / 开关 …）。 */
export interface RhtvModelConfigField {
  type: string;
  title?: string;
  titleEn?: string;
  paramName: string;
  paramDataType?: string;
  paramValue?: unknown;
  required?: boolean;
  display?: boolean | Record<string, unknown>;
  min?: number;
  max?: number;
  unit?: string;
  maxLength?: number;
  optionValue?: Array<{ value: string | null; labelCn?: string; labelEn?: string; isAuto?: boolean }>;
}

export interface RhtvModelDetail extends RhtvModelItem {
  generateNum?: number[];
  config?: RhtvModelConfigField[];
}

/** 一个可选项。`isAuto` 为真表示"不传这个字段，交给服务端自适应"。 */
export interface RhtvParamOption {
  value: string;
  label: string;
  isAuto?: boolean;
}

/**
 * 归一化后的模型参数（Rust 侧合并了 `schema.properties` 与 `config[]`）。
 *
 * `semantic` 是通用槽位：比例在各模型里可能叫 `aspectRatio` 也可能叫 `whAspectRatio`，
 * 前端只需要按 `semantic` 找，真正的字段名看 `key`。
 */
export interface RhtvParamSpec {
  key: string;
  control: 'prompt' | 'text' | 'select' | 'toggle' | 'number' | 'slider' | 'aspect' | 'resolution' | 'media';
  semantic: 'prompt' | 'aspectRatio' | 'resolution' | 'duration' | 'count' | 'other';
  title: string;
  required: boolean;
  display?: boolean;
  defaultValue?: string | null;
  options: RhtvParamOption[];
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
  /** 组合控件：CLI 会把 `whAspectRatio` 换算成 width/height，原样传值即可。 */
  composite?: boolean;
}

export interface RhtvModelParams {
  model: string;
  kind?: string;
  params: RhtvParamSpec[];
  error?: string | null;
}

export interface RhtvGenerateRequest {
  executable?: string;
  model: string;
  prompt?: string;
  params?: string[];
  images?: string[];
  kind: 'image' | 'video' | 'audio';
  timeoutSeconds?: number;
}

function requireDesktop(): void {
  if (!isTauri()) throw new Error(i18n.t('runningHubCli.desktopOnly'));
}

export async function fetchRhtvCliStatus(executable?: string): Promise<RhtvCliStatus> {
  requireDesktop();
  return invoke<RhtvCliStatus>('rhtv_cli_status', { executable: executable ?? null });
}

export async function fetchRhtvAccount(executable?: string): Promise<unknown> {
  requireDesktop();
  return invoke<unknown>('rhtv_cli_account', { executable: executable ?? null });
}

/**
 * 拉当前账号可见的画布模型目录。
 * 这份目录由服务端实时下发（含只在画布出现的 RH Enhanced 系），**不要在前端硬编码**。
 */
export async function fetchRhtvModels(
  kind: 'image' | 'video' | 'audio' | 'text',
  options: { executable?: string; query?: string } = {},
): Promise<RhtvModelItem[]> {
  requireDesktop();
  const result = await invoke<{ items: RhtvModelItem[] }>('rhtv_cli_models', {
    executable: options.executable ?? null,
    kind,
    query: options.query ?? null,
  });
  return result?.items ?? [];
}

/** 单个模型的实时 schema：参数名、枚举、默认值全在这里，生成前必须读。 */
export async function fetchRhtvModel(
  modelCode: string,
  kind: 'image' | 'video' | 'audio' | 'text',
  executable?: string,
): Promise<RhtvModelDetail | null> {
  requireDesktop();
  return invoke<RhtvModelDetail | null>('rhtv_cli_model', {
    executable: executable ?? null,
    model: modelCode,
    kind,
  });
}

/**
 * 批量取参数清单（一次 IPC，Rust 侧 4 路并发）。
 *
 * 逐个模型调 `fetchRhtvModel` 会让首屏等好几分钟：每次都是一次 IPC + 一个 Node 进程。
 */
export async function fetchRhtvModelParams(
  models: Array<{ model: string; kind?: string }>,
  executable?: string,
): Promise<RhtvModelParams[]> {
  requireDesktop();
  if (models.length === 0) return [];
  return invoke<RhtvModelParams[]>('rhtv_cli_model_params_batch', {
    executable: executable ?? null,
    models,
  });
}

/** 解除 LenTalk 与画布的绑定；下次生成会重新建一个。 */
export async function forgetRhtvCanvas(): Promise<void> {
  requireDesktop();
  await invoke('rhtv_cli_forget_canvas');
}

/**
 * 走画布生成：建节点 → 运行 → 取产物 URL → 删节点。
 * 与标准模型 API 的一次性请求不同，这条路是节点语义，耗时以分钟计。
 */
export async function generateRhtvCanvasModel(request: RhtvGenerateRequest): Promise<string> {
  requireDesktop();
  return invoke<string>('generate_rhtv_canvas_model', { request });
}
