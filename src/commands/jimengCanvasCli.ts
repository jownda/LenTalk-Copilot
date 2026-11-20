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
  /**
   * 参考视频（`m2v`）。额度按模型来自目录的 `references.types[video].max`
   * （`seedance_2.5_flash` 5 段、`seedance_2.5` 10 段、2.0 系 3 段）。
   *
   * 传本地路径 / `asset://` / http(s) 都行 —— 后端会先物化成临时文件再
   * `resource upload --type=video` 登记，最后用 `res:<id>` 挂到 `--ref`。
   */
  referenceVideos?: string[];
  /** 参考音频（m2v 最多 10 个）；不传 = 音频没进生成 */
  referenceAudio?: string[];
  /**
   * 目标画布（`canvas ls` 的 projectId）。
   *
   * 不传时后端会在账号里找一张名为 `LenTalk` 的画布，没有就新建 —— 也就是说所有工程、
   * 所有节点都会堆在同一张画布上。按工程分画布走
   * `application/jimengCanvasProject.ts` 的 `ensureJimengCanvasProject`。
   */
  projectId?: string;
  /**
   * 前端节点的 clientJobId，用于「提交前取消」：后端按它记账，在素材上传 /
   * 建节点 / `node run` 之间逐段检查取消标志。不传就只能等它跑完。
   */
  clientJobId?: string;
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
  /**
   * 生成张数（`--count`）。
   *
   * 固定张数模型必须与目录声明一致（MJ 8.2 恒为 4），后端会按模型目录强制覆盖 ——
   * 漏传或传错都会被服务端以 `service.2 / generation.output_count` 拒掉。
   */
  count?: number;
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

/** 账号下一张协作画布的定位摘要（`canvas ls` 的 items 一一对应）。 */
export interface JimengCanvasProject {
  projectId: string;
  name: string;
  /** 毫秒时间戳；CLI 没给时为 null */
  createdAt: number | null;
  updatedAt: number | null;
}

/** 列出账号下全部画布（含用户在官网自己建的，只读，不会改动任何东西）。 */
export async function listJimengCanvasProjects(
  executable: string
): Promise<JimengCanvasProject[]> {
  requireDesktop();
  return await invoke<JimengCanvasProject[]>("jimeng_canvas_project_list", { executable });
}

/**
 * 新建一张画布。
 *
 * 不传 `--use`：创建后**不会**改 CLI 的「当前画布」，后续所有命令都显式带 projectId，
 * 免得把用户官网正在用的画布悄悄切走。
 */
export async function createJimengCanvasProject(
  executable: string,
  name: string
): Promise<JimengCanvasProject> {
  requireDesktop();
  return await invoke<JimengCanvasProject>("jimeng_canvas_project_create", {
    executable,
    name,
  });
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
