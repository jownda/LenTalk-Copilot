import { isTauri } from '@tauri-apps/api/core';

import { persistMediaSourceAuto } from '@/commands/mediaOutput';
import {
  getProjectRecord,
  listProjectSummaries,
  upsertProjectRecord,
  type ProjectRecord,
} from '@/commands/projectState';
import { browserTemplateRepository } from '@/features/templates/storage/templateRepository';
import type { Template } from '@/features/templates/types';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';

/**
 * 存量媒体本地化。
 *
 * 生成侧的落盘只保证「以后生成的」不再存第三方 CDN 链接（见 `mediaPersistence`）。
 * 但**已经存下来的**节点、模板、撤销栈里仍然是 `https://...aliyuncs.com/...` 这类
 * **临时**地址：冰火那类平台的 `reference-assets/` 目录会被定期清理，链接一断，
 * 模板同步、跨机分享、离线预览全部永久损坏，换任何网络都救不回来。
 *
 * 这个模块做的是「一次性搬家」：把存量数据里指向远端的媒体下载到本地落盘目录
 * （`设置 → 通用 → 默认落盘位置`），并把引用改写成本地路径。
 *
 * ⚠️ 这里**不能**盲目扫描所有 `http` 字符串 —— 提示词里出现一条参考链接是很正常的，
 * 把它换成本地路径等于把用户的提示词改坏。所以只认下面这份**字段名白名单**
 * （枚举自 `canvasNodes.ts` / `cinematicStudio/shared-types` 的媒体字段），
 * 字段名对不上的一律不碰。宁可漏掉某个冷门字段（结果是那一条仍然留在远端），
 * 也不能误改正文。
 */

/** 值本身就是「单个来源」的媒体字段。 */
const MEDIA_STRING_KEYS = new Set([
  'sourcePath',
  'imageUrl',
  'previewImageUrl',
  'inputImageUrl',
  'previewInputImageUrl',
  'outputImageUrl',
  'outputPreviewImageUrl',
  'firstFrameImageUrl',
  'firstFramePreviewImageUrl',
  'lastFrameImageUrl',
  'lastFramePreviewImageUrl',
  'lastCaptureUrl',
  'lastCapturePreviewUrl',
  'imageSource',
  'imagePreviewUrl',
  'motionVideoSource',
  'motionVideoPreviewUrl',
  'inputVideoSource',
  'inputVideoPreviewUrl',
  'audioSource',
  'audioPreviewUrl',
  'outputVideoUrl',
  'referenceAudio',
  'mmxClonePreviewAudio',
  'mmxDesignPreviewAudio',
  'indexTtsSecondReferenceAudio',
  'stagingReferenceImage',
  'voiceClip',
]);

/**
 * 值是「来源列表」的媒体字段。
 *
 * `referenceAudio` 同时出现在两张表里：音频生成节点上是单个字符串，
 * 模板 pipeline 上是数组，两处都要认。
 */
const MEDIA_ARRAY_KEYS = new Set([
  'imagePool',
  'referenceImages',
  'referenceVideo',
  'referenceVideos',
  'referenceAudio',
  'studioReferenceImages',
  'studioReferenceAudio',
  'binghuoReferenceVideos',
  'quickReferenceImages',
  'excludedReferenceSources',
  'referencePaths',
  // 供应商扩展参数里的下划线命名（炳火 reference_videos 等）。
  'reference_videos',
  'reference_images',
  'reference_audio',
]);

/** 只有 http(s) 才值得落盘；`data:` / `asset:` / `blob:` / 本地路径都不动。 */
export function isDownloadableRemoteSource(source: string): boolean {
  return /^https?:\/\//i.test(source.trim());
}

export interface MediaLocalizeFailure {
  source: string;
  reason: string;
}

export interface MediaLocalizeStats {
  /** 成功换成本地路径的引用条数（含命中缓存的重复引用）。 */
  localized: number;
  /** 下载失败、保持原样的来源（已去重）。 */
  failed: MediaLocalizeFailure[];
}

/** 解析器：把远端来源换成本地绝对路径；失败必须抛错。 */
export type MediaSourceResolver = (source: string) => Promise<string>;

interface WalkContext {
  resolve: MediaSourceResolver;
  /** 来源 → 本地路径。同一条链接在多个节点里出现时只下载一次。 */
  cache: Map<string, string>;
  /** 已经失败过的来源，避免同一条死链反复记流水。 */
  failed: Set<string>;
  stats: MediaLocalizeStats;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createContext(resolve: MediaSourceResolver): WalkContext {
  return { resolve, cache: new Map(), failed: new Set(), stats: { localized: 0, failed: [] } };
}

async function localizeSource(source: string, context: WalkContext): Promise<string> {
  const trimmed = source.trim();
  if (!isDownloadableRemoteSource(trimmed)) {
    return source;
  }

  const cached = context.cache.get(trimmed);
  if (cached) {
    context.stats.localized += 1;
    return source === trimmed ? cached : source.replace(trimmed, cached);
  }
  if (context.failed.has(trimmed)) {
    return source;
  }

  try {
    const localPath = (await context.resolve(trimmed)).trim();
    if (!localPath || localPath === trimmed || isDownloadableRemoteSource(localPath)) {
      context.failed.add(trimmed);
      context.stats.failed.push({ source: trimmed, reason: '未拿到本地路径' });
      return source;
    }
    context.cache.set(trimmed, localPath);
    context.stats.localized += 1;
    return source === trimmed ? localPath : source.replace(trimmed, localPath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    context.failed.add(trimmed);
    context.stats.failed.push({ source: trimmed, reason });
    return source;
  }
}

async function walkValue(value: unknown, context: WalkContext): Promise<void> {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object') {
        await walkValue(item, context);
      }
    }
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const child = record[key];

    if (typeof child === 'string') {
      if (MEDIA_STRING_KEYS.has(key)) {
        record[key] = await localizeSource(child, context);
      }
      continue;
    }

    if (Array.isArray(child)) {
      if (MEDIA_ARRAY_KEYS.has(key)) {
        const next: unknown[] = [];
        for (const item of child) {
          next.push(typeof item === 'string' ? await localizeSource(item, context) : item);
        }
        record[key] = next;
        // 数组里也可能装对象（模板的 AssetRef[]），继续下钻找 sourcePath。
        for (const item of next) {
          if (item && typeof item === 'object') {
            await walkValue(item, context);
          }
        }
        continue;
      }
      await walkValue(child, context);
      continue;
    }

    if (child && typeof child === 'object') {
      await walkValue(child, context);
    }
  }
}

/** 一次本地化会话：共享下载缓存与失败记账，跨模板/工程复用。 */
export interface MediaLocalizer {
  stats: MediaLocalizeStats;
  /** 就地改写传入的 JSON 结构（调用方负责先克隆）。 */
  localize: (value: unknown) => Promise<void>;
}

export function createMediaLocalizer(
  resolve: MediaSourceResolver = persistMediaSourceAuto,
): MediaLocalizer {
  const context = createContext(resolve);
  return {
    stats: context.stats,
    localize: (value) => walkValue(value, context),
  };
}

/** 就地本地化任意 JSON（一次性用法）。 */
export async function localizeMediaInPlace(
  value: unknown,
  resolve: MediaSourceResolver = persistMediaSourceAuto,
): Promise<MediaLocalizeStats> {
  if (!isTauri()) {
    return { localized: 0, failed: [] };
  }
  const localizer = createMediaLocalizer(resolve);
  await localizer.localize(value);
  return localizer.stats;
}

/** 本地化单个模板；返回是否发生了改写。 */
export async function localizeTemplateMedia(
  template: Template,
  localizer: MediaLocalizer,
): Promise<boolean> {
  const before = JSON.stringify(template);
  await localizer.localize(template);
  return JSON.stringify(template) !== before;
}

/** 模板前置本地化：同步到共享盘之前调用，失败不影响调用方。 */
export async function localizeAllTemplateMedia(): Promise<MediaLocalizeStats> {
  if (!isTauri()) {
    return { localized: 0, failed: [] };
  }
  const localizer = createMediaLocalizer();
  const templates = await browserTemplateRepository.list();
  for (const template of templates) {
    const changed = await localizeTemplateMedia(template, localizer);
    if (changed) {
      await browserTemplateRepository.save(template);
    }
  }
  return localizer.stats;
}

/** 单个模板的本地化（右键「上传到共享盘」之前调用）。 */
export async function localizeTemplateMediaById(templateId: string): Promise<MediaLocalizeStats> {
  if (!isTauri()) {
    return { localized: 0, failed: [] };
  }
  const localizer = createMediaLocalizer();
  const template = await browserTemplateRepository.get(templateId);
  if (template && (await localizeTemplateMedia(template, localizer))) {
    await browserTemplateRepository.save(template);
  }
  return localizer.stats;
}

export interface LocalizeProgress {
  phase: 'templates' | 'current-project' | 'projects';
  /** 当前处理的模板名 / 工程名。 */
  label: string;
  done: number;
  total: number;
}

export interface ExistingMediaLocalizationReport extends MediaLocalizeStats {
  templatesTotal: number;
  templatesChanged: number;
  projectsTotal: number;
  projectsChanged: number;
}

/**
 * 把「已经存下来的」远端媒体搬回本地。
 *
 * 顺序有讲究：**当前打开的工程先处理**。它在内存里有一份活的状态，直接改数据库没用 ——
 * 画布下一次自动保存就会把内存里的旧值（远端链接）写回去，等于白做。所以当前工程走
 * 「克隆内存 → 本地化克隆 → setCanvasData + saveCurrentProject」，其余工程才走数据库。
 */
export async function runExistingMediaLocalization(options?: {
  onProgress?: (progress: LocalizeProgress) => void;
}): Promise<ExistingMediaLocalizationReport> {
  const onProgress = options?.onProgress;
  const report: ExistingMediaLocalizationReport = {
    localized: 0,
    failed: [],
    templatesTotal: 0,
    templatesChanged: 0,
    projectsTotal: 0,
    projectsChanged: 0,
  };
  if (!isTauri()) {
    return report;
  }

  const localizer = createMediaLocalizer();

  // ---- 1. 模板 ----
  const templates = await browserTemplateRepository.list();
  report.templatesTotal = templates.length;
  for (let index = 0; index < templates.length; index += 1) {
    const template = templates[index];
    onProgress?.({
      phase: 'templates',
      label: template.name,
      done: index,
      total: templates.length,
    });
    try {
      if (await localizeTemplateMedia(template, localizer)) {
        await browserTemplateRepository.save(template);
        report.templatesChanged += 1;
      }
    } catch (error) {
      console.error('[media-localize] 模板本地化失败', template.id, error);
    }
  }

  // ---- 2. 当前打开的工程（内存态）----
  const currentProjectId = useProjectStore.getState().currentProjectId;
  const summarizeProjects = await listProjectSummaries().catch((error) => {
    console.error('[media-localize] 读取工程列表失败', error);
    return [];
  });
  report.projectsTotal = summarizeProjects.length;

  if (currentProjectId) {
    onProgress?.({
      phase: 'current-project',
      label: summarizeProjects.find((item) => item.id === currentProjectId)?.name ?? '',
      done: 0,
      total: 1,
    });
    try {
      const canvas = useCanvasStore.getState();
      const nodes = cloneJson(canvas.nodes);
      const edges = cloneJson(canvas.edges);
      const history = cloneJson(canvas.history);
      await localizer.localize(nodes);
      await localizer.localize(edges);
      await localizer.localize(history);
      const changed =
        JSON.stringify(nodes) !== JSON.stringify(canvas.nodes) ||
        JSON.stringify(edges) !== JSON.stringify(canvas.edges) ||
        JSON.stringify(history) !== JSON.stringify(canvas.history);
      if (changed) {
        useCanvasStore.getState().setCanvasData(nodes, edges, history);
        const projectState = useProjectStore.getState();
        projectState.saveCurrentProject(
          nodes,
          edges,
          projectState.currentProject?.viewport,
          history,
        );
        report.projectsChanged += 1;
      }
    } catch (error) {
      console.error('[media-localize] 当前工程本地化失败', currentProjectId, error);
    }
  }

  // ---- 3. 其余工程（数据库）----
  for (let index = 0; index < summarizeProjects.length; index += 1) {
    const summary = summarizeProjects[index];
    if (summary.id === currentProjectId) {
      continue;
    }
    onProgress?.({
      phase: 'projects',
      label: summary.name,
      done: index,
      total: summarizeProjects.length,
    });
    try {
      const record = await getProjectRecord(summary.id);
      if (!record) {
        continue;
      }
      const next = await localizeProjectRecord(record, localizer);
      if (next) {
        await upsertProjectRecord(next);
        report.projectsChanged += 1;
      }
    } catch (error) {
      console.error('[media-localize] 工程本地化失败', summary.id, error);
    }
  }

  report.localized = localizer.stats.localized;
  report.failed = localizer.stats.failed;
  return report;
}

/**
 * 本地化一条工程记录里的媒体引用。
 *
 * 返回 `null` 表示没有任何改写（不必回写数据库）。注意图片字段在落库时被编码成了
 * `__img_ref__:N`，真实地址在 `historyJson.imagePool` 里 —— 白名单特意收了
 * `imagePool`，所以撤销栈与当前节点用的是同一份本地文件。
 */
export async function localizeProjectRecord(
  record: ProjectRecord,
  localizer: MediaLocalizer,
): Promise<ProjectRecord | null> {
  const nodes = JSON.parse(record.nodesJson) as unknown;
  const edges = JSON.parse(record.edgesJson) as unknown;
  const history = JSON.parse(record.historyJson) as unknown;

  await localizer.localize(nodes);
  await localizer.localize(edges);
  await localizer.localize(history);

  const nextNodesJson = JSON.stringify(nodes);
  const nextEdgesJson = JSON.stringify(edges);
  const nextHistoryJson = JSON.stringify(history);
  if (
    nextNodesJson === record.nodesJson &&
    nextEdgesJson === record.edgesJson &&
    nextHistoryJson === record.historyJson
  ) {
    return null;
  }

  return {
    ...record,
    nodesJson: nextNodesJson,
    edgesJson: nextEdgesJson,
    historyJson: nextHistoryJson,
  };
}
