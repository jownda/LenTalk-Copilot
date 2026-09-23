// ---------------------------------------------------------------------------
// 扒剧本（短剧视频 → 拉片剧本）命令封装。
//
// Rust 侧负责探测 Python 环境、拉起引擎子进程并把 stdout 上的
// `##PROGRESS` / `##EP` 协议转成事件；这里只管订阅与调用。
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "@tauri-apps/api/core";

export const PAJUBEN_LOG_EVENT = "pajuben://log";
export const PAJUBEN_PROGRESS_EVENT = "pajuben://progress";
export const PAJUBEN_FINISH_EVENT = "pajuben://finish";

/** 引擎运行环境（Python 解释器 / 引擎文件 / ffmpeg / 人脸依赖）。 */
export interface PajubenEnvironment {
  pythonPath: string | null;
  pythonVersion: string | null;
  /** true = 随包运行时；false = 回退到系统 Python。 */
  pythonBundled: boolean;
  engineDir: string | null;
  engineReady: boolean;
  ffmpegDir: string | null;
  /** 人脸识别依赖（Pillow + NumPy + 带 YuNet/SFace 的 OpenCV）是否齐备。 */
  faceReady: boolean;
  message: string;
}

export interface PajubenRunRequest {
  target: string;
  batch: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  provider: string;
  proxy: string;
  episode?: number | null;
  fps?: number | null;
  resolution?: string | null;
  maxFrames?: number | null;
  workers?: number | null;
  /** 单次模型请求的最长等待时间；留空时引擎使用完整模式默认值。 */
  requestTimeoutSecs?: number | null;
  /** 单次模型请求的尝试次数；快速模式只尝试一次，避免用户误以为界面卡死。 */
  requestAttempts?: number | null;
  audio: boolean;
  animeMode: boolean;
  faceEnabled: boolean;
  outputDir?: string | null;
  roleSheet?: string | null;
  dualAudioModel?: string | null;
  dualVisionModel?: string | null;
  fromEpisode?: number | null;
  toEpisode?: number | null;
  limit?: number | null;
  overwrite: boolean;
  skipAliasVerify: boolean;
  /** 禁用失败后的双模型长流程降级，供画布上的「扒视频」快速模式使用。 */
  disableDualFallback?: boolean;
  /** 直接使用双模型流程：音频模型听写，视觉模型负责画面与合并。 */
  forceDualFallback?: boolean;
}

export interface PajubenLogPayload {
  runId: string;
  line: string;
  isError: boolean;
}

export type PajubenProgressKind = "overall" | "episode" | "episodeDone" | "episodeFailed";

export interface PajubenProgressPayload {
  runId: string;
  kind: PajubenProgressKind;
  episode: number | null;
  done: number | null;
  total: number | null;
  percent: number | null;
  text: string;
}

export interface PajubenFinishPayload {
  runId: string;
  success: boolean;
  cancelled: boolean;
  code: number | null;
  message: string;
}

function ensureDesktop(): void {
  if (!isTauri()) {
    throw new Error("扒剧本需要在 LenTalk 桌面端运行");
  }
}

/** 探测引擎可用环境；打开面板时调用一次即可。 */
export async function probePajubenEnvironment(): Promise<PajubenEnvironment> {
  ensureDesktop();
  return invoke<PajubenEnvironment>("pajuben_probe");
}

/** 启动一次扒取；返回本次运行的 runId。 */
export async function runPajuben(request: PajubenRunRequest): Promise<string> {
  ensureDesktop();
  return invoke<string>("pajuben_run", { request });
}

/** 取消正在运行的扒取（连同 ffmpeg / curl 子进程一起回收）。 */
export async function cancelPajuben(): Promise<void> {
  ensureDesktop();
  await invoke("pajuben_cancel");
}

/** 计算默认输出目录：视频同目录下的「剧本」文件夹。 */
export async function resolvePajubenOutputDir(target: string): Promise<string> {
  ensureDesktop();
  return invoke<string>("pajuben_resolve_output_dir", { target });
}

/**
 * 读回某一集已经扒好的剧本正文。
 *
 * 画布上的「扒视频」跑完要把剧本直接落到文本节点——整篇剧本几万字，塞进
 * finish 事件会把负载撑大，所以单独走这条「按视频路径 + 集号」定位产物的通道。
 * 定位规则与引擎一致：outputDir 留空 = 视频同目录下的「剧本」文件夹。
 */
export async function readPajubenScript(options: {
  target: string;
  outputDir?: string | null;
  episode?: number | null;
}): Promise<string> {
  ensureDesktop();
  return invoke<string>("pajuben_read_script", {
    target: options.target,
    outputDir: options.outputDir ?? null,
    episode: options.episode ?? null,
  });
}

export function onPajubenLog(handler: (payload: PajubenLogPayload) => void): Promise<UnlistenFn> {
  return listen<PajubenLogPayload>(PAJUBEN_LOG_EVENT, (event) => handler(event.payload));
}

export function onPajubenProgress(handler: (payload: PajubenProgressPayload) => void): Promise<UnlistenFn> {
  return listen<PajubenProgressPayload>(PAJUBEN_PROGRESS_EVENT, (event) => handler(event.payload));
}

export function onPajubenFinish(handler: (payload: PajubenFinishPayload) => void): Promise<UnlistenFn> {
  return listen<PajubenFinishPayload>(PAJUBEN_FINISH_EVENT, (event) => handler(event.payload));
}
