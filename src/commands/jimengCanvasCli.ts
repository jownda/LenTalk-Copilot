import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * 即梦画布 CLI（`dreamina-canvas`）—— 和设置里的「即梦 CLI」（`dreamina`）是两个独立工具。
 * 它面向 Agent / 自动化流程，操作即梦协同画布（建画布、上传素材、生成、查任务、下载）。
 * 使用文档：https://bytedance.larkoffice.com/wiki/QO66wGahSiakEHkJbxIcNBtDnAc
 */
function requireDesktop() {
  if (!isTauri()) {
    throw new Error("即梦画布 CLI 只能在桌面端使用，请打开 LenTalk 桌面应用后再操作。");
  }
}

export interface JimengCanvasCliStatus {
  /** 可执行文件能跑起来（`dreamina-canvas version` 成功） */
  found: boolean;
  version: string | null;
  loggedIn: boolean;
  /** 当前登录账号（`auth account`）；未登录时为 null */
  account: string | null;
  message: string;
}

export interface JimengCanvasCliLoginStart {
  needAuth: boolean;
  verificationUri: string | null;
  userCode: string | null;
  deviceCode: string | null;
  expiresAt: string | null;
  message: string;
}

export interface JimengCanvasCliLoginCheck {
  success: boolean;
  message: string;
}

export async function queryJimengCanvasCliStatus(
  executable: string
): Promise<JimengCanvasCliStatus> {
  requireDesktop();
  return await invoke<JimengCanvasCliStatus>("jimeng_canvas_cli_status", { executable });
}

/** 申请授权材料。`force=true` 走切换账号（`auth login --force`，先清当前 profile 再授权）。 */
export async function startJimengCanvasCliLogin(
  executable: string,
  options?: { force?: boolean }
): Promise<JimengCanvasCliLoginStart> {
  requireDesktop();
  return await invoke<JimengCanvasCliLoginStart>("jimeng_canvas_cli_login_start", {
    executable,
    force: options?.force ?? false,
  });
}

/**
 * 等待并完成登录（`auth wait --device-code`）。
 * 每次调用会阻塞最多 4 秒；未完成时返回 `success=false`，调用方继续下一轮。
 * 🔴 不能用 `auth status` 代替 —— 它只读本地状态，不会拿 device code 去换 token。
 */
export async function checkJimengCanvasCliLogin(
  executable: string,
  deviceCode: string
): Promise<JimengCanvasCliLoginCheck> {
  requireDesktop();
  return await invoke<JimengCanvasCliLoginCheck>("jimeng_canvas_cli_login_check", {
    executable,
    deviceCode,
  });
}

export async function logoutJimengCanvasCli(
  executable: string
): Promise<JimengCanvasCliLoginCheck> {
  requireDesktop();
  return await invoke<JimengCanvasCliLoginCheck>("jimeng_canvas_cli_logout", { executable });
}

export interface JimengCanvasVideoRequest {
  executable: string;
  prompt: string;
  /** 服务端模型标识，如 `seedance_2.5`（不是节点上显示的 `jimeng-canvas/...` id） */
  model: string;
  mode: "t2v" | "first_last_frame" | "m2v";
  duration: number;
  aspectRatio: string;
  resolution: string;
  referenceImages?: string[];
  /** 参考音频（m2v 最多 10 个）；不传 = 音频没进生成 */
  referenceAudio?: string[];
  /** 复用已有画布（不传则取最近一个，没有就新建） */
  projectId?: string;
}

/**
 * 用即梦画布 CLI 生成视频：上传参考素材 → 建节点并运行 → 等终态 → 下载到本地。
 * 返回本地文件路径。全过程由 CLI 的 `node create video --run --wait` 完成，
 * 单次可能跑几分钟（`--wait` 最长 10 分钟）。
 */
export async function generateJimengCanvasVideo(
  request: JimengCanvasVideoRequest
): Promise<string> {
  requireDesktop();
  return await invoke<string>("generate_jimeng_canvas_video", { request });
}

export interface JimengCanvasImageRequest {
  executable: string;
  prompt: string;
  /** 服务端模型标识，如 `seedream_4.5` */
  model: string;
  mode: "t2i" | "i2i";
  aspectRatio: string;
  resolution: string;
  referenceImages?: string[];
  projectId?: string;
}

/** 用即梦画布 CLI 生成图片，返回本地文件路径（走 `node create image --run --wait`）。 */
export async function generateJimengCanvasImage(
  request: JimengCanvasImageRequest
): Promise<string> {
  requireDesktop();
  return await invoke<string>("generate_jimeng_canvas_image", { request });
}

export interface JimengCanvasAudioRequest {
  executable: string;
  prompt: string;
  /** 服务端模型标识：`legacy_tts` / `seed_music_1.0` */
  model: string;
  mode: "tts" | "music";
  /** music 模式的时长（秒，最小 30） */
  duration?: number;
  referenceAudio?: string[];
  projectId?: string;
}

/** 用即梦画布 CLI 生成音频，返回本地文件路径（走 `node create audio --run --wait`）。 */
export async function generateJimengCanvasAudio(
  request: JimengCanvasAudioRequest
): Promise<string> {
  requireDesktop();
  return await invoke<string>("generate_jimeng_canvas_audio", { request });
}
