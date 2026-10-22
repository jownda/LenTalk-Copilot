/**
 * 视频任务轮询结果的读法 —— 后端 `get_generation_job_status` 的语义在这里的唯一落点。
 *
 * 分工必须是:**后端判终态, 前端只读**。
 * - 平台失败 / 鉴权失效 / 地址写错这类**确定性**错误, 后端会直接把 `status` 写成
 *   `"failed"` 并带上原因;
 * - 网络抖动、5xx、平台回话慢这类**可重试**错误, 后端保持 `status: "running"`,
 *   同时给 `transient: true`, 其 `error` 字段只承载**诊断文本**。
 *
 * 所以 `status: "running"` + `transient: true` 时, `error` 的文本**永远不能**升级成
 * 终态判据 —— 它是我们自己写的措辞, 里面天然会出现「失败」「timeout」这类词。
 *
 * 2026-09-23 事故: 前端曾对 `error` 做子串匹配(含宽泛的 `includes("失败")`),
 * 诊断文本 `Provider error: binghuo-video 查询失败(网络): error sending request for url (...)`
 * 命中「失败」二字 ⇒ 一次网络抖动就把一条已计费、已在平台跑到 14 分钟的长任务判死,
 * 并清掉 job id; 平台照跑照计费, 成片永久收不回。
 */

/** 轮询响应的最小结构(与 `VideoGenerationJobStatus` 兼容)。 */
export interface VideoJobStatusLike {
  status: string;
  result?: string | null;
  error?: string | null;
  /** 后端声明: 本次 `error` 只是诊断文本, 任务仍在平台侧生成。 */
  transient?: boolean;
}

/**
 * 后端是否声明「这次查询失败是临时的」。
 *
 * 用显式等值判断, 不吃真值字符串 —— 老版本后端没有这个字段(undefined)时按
 * 「不是临时」处理, 保留下面的文本兜底。
 */
export function isTransientVideoJobStatus(status: VideoJobStatusLike): boolean {
  return status.transient === true;
}

/**
 * 终态失败文案的识别(仅当后端**没有**标 transient 时的兜底护栏)。
 *
 * 刻意**不**匹配宽泛的「失败」二字: 后端自己的诊断措辞就带着它
 * (「查询失败(网络)」「查询失败: HTTP 502」), 宽匹配必然误杀。
 * 只认平台终态话语 —— 这些词出现在查询响应里, 说明任务确实已经结束了。
 */
const TERMINAL_FAILURE_TEXT =
  /failed|failure|rejected|can{1,2}elled|can{1,2}eled|timed?\s*out|视频生成失败|生成失败/i;

export function looksLikeTerminalVideoFailure(errorText: string): boolean {
  return TERMINAL_FAILURE_TEXT.test(errorText);
}

/**
 * `status: "running" | "queued"` 时是否该把任务判成失败。
 *
 * 回到 `true` 的条件很苛刻: 后端没标 transient **且** 文本确实是平台终态话语。
 * 这是防「后端漏判终态」的护栏, 不是常规判定路径。
 */
export function shouldFailRunningVideoJob(status: VideoJobStatusLike): boolean {
  if (isTransientVideoJobStatus(status)) return false;
  const errorText = typeof status.error === "string" ? status.error : "";
  return errorText.length > 0 && looksLikeTerminalVideoFailure(errorText);
}
