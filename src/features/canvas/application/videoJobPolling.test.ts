import { describe, expect, it } from 'vitest';

import {
  isTransientVideoJobStatus,
  looksLikeTerminalVideoFailure,
  shouldFailRunningVideoJob,
  type VideoJobStatusLike,
} from './videoJobPolling';

/**
 * 这组用例的报文全部来自真实事故现场, 修之前必须失败。
 * 背景: 2026-09-23 11:53, 一条已在炳火平台跑满 14 分钟的 720p 任务
 * (`task_FEAr3AYNf0AOL7nigotXM5pQk0T6YBvG`) 被一次网络抖动判死。
 */
describe('video job polling verdict', () => {
  describe('transient 声明优先于任何文本', () => {
    // 真实报文: 后端把网络抖动包成 "Provider error: <label> 查询失败(网络): ..."
    // 并保持 status=running。旧代码的 includes("失败") 命中「查询失败」⇒ 当场判死。
    it('网络抖动标记为 transient 时保持运行, 不因「查询失败」四字判死', () => {
      const payload: VideoJobStatusLike = {
        status: 'running',
        result: null,
        transient: true,
        error:
          'Provider error: binghuo-video 查询失败(网络): error sending request for url (https://api.7tai.cc/v1/video/generations/task_FEAr3AYNf0AOL7nigotXM5pQk0T6YBvG)',
      };
      expect(isTransientVideoJobStatus(payload)).toBe(true);
      expect(shouldFailRunningVideoJob(payload)).toBe(false);
    });

    it('5xx / 429 归入可重试时同样保持运行', () => {
      const payload: VideoJobStatusLike = {
        status: 'running',
        result: null,
        transient: true,
        error: 'binghuo-video 查询失败: HTTP 502 Bad Gateway ({}) (https://api.7tai.cc/v1/video/generations/task-x)',
      };
      expect(shouldFailRunningVideoJob(payload)).toBe(false);
    });

    it('平台回话慢(我们自己的等待文案)不构成失败', () => {
      const payload: VideoJobStatusLike = {
        status: 'running',
        result: null,
        transient: true,
        error: '视频任务仍在生成: IN_PROGRESS',
      };
      expect(shouldFailRunningVideoJob(payload)).toBe(false);
    });

    it('transient 优先: 即便诊断文本里有终态话语也不判失败', () => {
      const payload: VideoJobStatusLike = {
        status: 'running',
        result: null,
        transient: true,
        error: '上游返回: 生成失败，正在重试该任务',
      };
      expect(shouldFailRunningVideoJob(payload)).toBe(false);
    });
  });

  describe('后端漏判终态时的兜底护栏', () => {
    it('未标 transient 且文本是终态话语时判失败(如平台静默失败)', () => {
      const payload: VideoJobStatusLike = {
        status: 'running',
        result: null,
        error: '视频生成失败: 当前生成服务繁忙，请稍后重试。',
      };
      expect(shouldFailRunningVideoJob(payload)).toBe(true);
    });

    it('识别英文终态话语', () => {
      expect(
        shouldFailRunningVideoJob({ status: 'running', error: 'Video generation failed: upstream timeout' }),
      ).toBe(true);
    });

    it('没有错误文本时不判失败, 继续等', () => {
      expect(shouldFailRunningVideoJob({ status: 'running', error: null })).toBe(false);
      expect(shouldFailRunningVideoJob({ status: 'queued' })).toBe(false);
    });

    it('光秃秃的一句原因(没有终态话语)不判失败 —— 宁可多轮询也不误杀', () => {
      expect(shouldFailRunningVideoJob({ status: 'running', error: '上游服务繁忙' })).toBe(false);
    });
  });

  describe('文本判据只认终态话语', () => {
    it('不含宽泛的「失败」二字', () => {
      expect(looksLikeTerminalVideoFailure('查询失败(网络): connection reset')).toBe(false);
      expect(looksLikeTerminalVideoFailure('平台返回失败标记')).toBe(false);
      expect(looksLikeTerminalVideoFailure('视频生成失败: 平台返回失败标记')).toBe(true);
    });
  });

  describe('transient 字段只认布尔真', () => {
    it('老版本后端缺字段时按「不是临时」处理, 保留文本兜底', () => {
      expect(isTransientVideoJobStatus({ status: 'running' })).toBe(false);
      expect(isTransientVideoJobStatus({ status: 'running', transient: undefined })).toBe(false);
    });

    it('不把字符串当约定', () => {
      expect(isTransientVideoJobStatus({ status: 'running', transient: 'true' as unknown as boolean })).toBe(false);
      expect(isTransientVideoJobStatus({ status: 'running', transient: true })).toBe(true);
    });
  });
});
