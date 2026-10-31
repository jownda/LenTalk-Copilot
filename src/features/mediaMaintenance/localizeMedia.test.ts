import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isTauri: true,
  persistMediaSourceAuto: vi.fn(),
  getProjectRecord: vi.fn(),
  listProjectSummaries: vi.fn(),
  upsertProjectRecord: vi.fn(),
  templateList: vi.fn(),
  templateSave: vi.fn(),
  canvas: {
    nodes: [] as unknown[],
    edges: [] as unknown[],
    history: { past: [], future: [] } as unknown,
    setCanvasData: vi.fn(),
  },
  project: {
    currentProjectId: null as string | null,
    currentProject: null as { viewport?: unknown } | null,
    saveCurrentProject: vi.fn(),
  },
}));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => mocks.isTauri }));
vi.mock('@/commands/mediaOutput', () => ({ persistMediaSourceAuto: mocks.persistMediaSourceAuto }));
vi.mock('@/commands/projectState', () => ({
  getProjectRecord: mocks.getProjectRecord,
  listProjectSummaries: mocks.listProjectSummaries,
  upsertProjectRecord: mocks.upsertProjectRecord,
}));
vi.mock('@/features/templates/storage/templateRepository', () => ({
  browserTemplateRepository: { list: mocks.templateList, save: mocks.templateSave },
}));
vi.mock('@/stores/canvasStore', () => ({
  useCanvasStore: { getState: () => mocks.canvas },
}));
vi.mock('@/stores/projectStore', () => ({
  useProjectStore: { getState: () => mocks.project },
}));

import {
  createMediaLocalizer,
  isDownloadableRemoteSource,
  isLocalizableMediaSource,
  localizeMediaInPlace,
  localizeProjectRecord,
  runExistingMediaLocalization,
} from './localizeMedia';

const REMOTE = 'https://binghuo-media-lrs.oss-cn-shenzhen.aliyuncs.com/reference-assets/a.mp4';
const LOCAL = 'C:/Users/me/Downloads/LenTalk/videos/ab12.mp4';

beforeEach(() => {
  mocks.isTauri = true;
  mocks.persistMediaSourceAuto.mockReset();
  mocks.getProjectRecord.mockReset();
  mocks.listProjectSummaries.mockReset();
  mocks.upsertProjectRecord.mockReset();
  mocks.templateList.mockReset();
  mocks.templateSave.mockReset();
  mocks.canvas.nodes = [];
  mocks.canvas.edges = [];
  mocks.canvas.history = { past: [], future: [] };
  mocks.canvas.setCanvasData.mockReset();
  mocks.project.currentProjectId = null;
  mocks.project.currentProject = null;
  mocks.project.saveCurrentProject.mockReset();
});

describe('isDownloadableRemoteSource', () => {
  it('只认 http(s)', () => {
    expect(isDownloadableRemoteSource(REMOTE)).toBe(true);
    expect(isDownloadableRemoteSource('  http://x/a.png ')).toBe(true);
    expect(isDownloadableRemoteSource('data:image/png;base64,AAAA')).toBe(false);
    expect(isDownloadableRemoteSource('asset://localhost/a.png')).toBe(false);
    expect(isDownloadableRemoteSource('C:/Users/me/a.png')).toBe(false);
  });
});

describe('isLocalizableMediaSource', () => {
  it('http(s) 与够大的内嵌 base64 都要搬，小图标不动', () => {
    expect(isLocalizableMediaSource(REMOTE)).toBe(true);
    // 几 KB 以下的小 data URL 搬成文件只是增加噪声。
    expect(isLocalizableMediaSource('data:image/png;base64,AAAA')).toBe(false);
    expect(isLocalizableMediaSource(`data:image/png;base64,${'A'.repeat(6000)}`)).toBe(true);
    expect(isLocalizableMediaSource('asset://localhost/a.png')).toBe(false);
    expect(isLocalizableMediaSource('__img_ref__:2')).toBe(false);
  });
});

describe('媒体字段白名单遍历', () => {
  const resolver = () => Promise.resolve(LOCAL);

  it('改写 sourcePath / 嵌套 sourcePath / 引用数组 / imagePool', async () => {
    const localizer = createMediaLocalizer(resolver);
    const payload = {
      nodes: [
        {
          id: 'n1',
          type: 'audioNode',
          data: { sourcePath: REMOTE, previewImageUrl: REMOTE, aspectRatio: '16:9' },
        },
      ],
      assets: [{ sourcePath: REMOTE, fileName: 'a.mp4' }],
      pipeline: { referenceImages: [{ sourcePath: REMOTE }], extraParams: { reference_videos: [REMOTE] } },
      history: { imagePool: [REMOTE], past: [] },
    };

    await localizer.localize(payload);

    expect(payload.nodes[0].data.sourcePath).toBe(LOCAL);
    expect(payload.nodes[0].data.previewImageUrl).toBe(LOCAL);
    expect(payload.nodes[0].data.aspectRatio).toBe('16:9');
    expect(payload.assets[0].sourcePath).toBe(LOCAL);
    expect(payload.assets[0].fileName).toBe('a.mp4');
    expect(payload.pipeline.referenceImages[0].sourcePath).toBe(LOCAL);
    expect(payload.pipeline.extraParams.reference_videos).toEqual([LOCAL]);
    expect(payload.history.imagePool).toEqual([LOCAL]);
  });

  it('绝不碰提示词、标题里的链接', async () => {
    const localizer = createMediaLocalizer(resolver);
    const payload = {
      data: {
        prompt: `参考 ${REMOTE} 的风格`,
        negativePrompt: REMOTE,
        displayName: REMOTE,
        model: REMOTE,
        content: REMOTE,
      },
    };

    await localizer.localize(payload);

    expect(payload.data.prompt).toBe(`参考 ${REMOTE} 的风格`);
    expect(payload.data.negativePrompt).toBe(REMOTE);
    expect(payload.data.displayName).toBe(REMOTE);
    expect(payload.data.model).toBe(REMOTE);
    expect(payload.data.content).toBe(REMOTE);
  });

  it('跳过 __img_ref__ 轻量引用、data URL 与本地路径', async () => {
    const localizer = createMediaLocalizer(resolver);
    const payload = {
      data: {
        imageUrl: '__img_ref__:3',
        previewImageUrl: 'data:image/png;base64,AAAA',
        firstFrameImageUrl: 'C:/Users/me/pic.png',
      },
    };

    await localizer.localize(payload);

    expect(payload.data.imageUrl).toBe('__img_ref__:3');
    expect(payload.data.previewImageUrl).toBe('data:image/png;base64,AAAA');
    expect(payload.data.firstFrameImageUrl).toBe('C:/Users/me/pic.png');
  });

  it('同一链接只下载一次，多处引用一起改写', async () => {
    const resolve = vi.fn().mockResolvedValue(LOCAL);
    const localizer = createMediaLocalizer(resolve);
    const payload = { a: { sourcePath: REMOTE }, b: { sourcePath: REMOTE }, c: { imageUrl: REMOTE } };

    await localizer.localize(payload);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(payload.a.sourcePath).toBe(LOCAL);
    expect(payload.b.sourcePath).toBe(LOCAL);
    expect(payload.c.imageUrl).toBe(LOCAL);
    expect(localizer.stats.localized).toBe(3);
  });

  it('下载失败保留原链接，且同一条死链只记一次', async () => {
    const resolve = vi.fn().mockRejectedValue(new Error('404 NoSuchKey'));
    const localizer = createMediaLocalizer(resolve);
    const payload = { a: { sourcePath: REMOTE }, b: { sourcePath: REMOTE } };

    await localizer.localize(payload);

    expect(payload.a.sourcePath).toBe(REMOTE);
    expect(payload.b.sourcePath).toBe(REMOTE);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(localizer.stats.failed).toEqual([{ source: REMOTE, reason: '404 NoSuchKey' }]);
    expect(localizer.stats.localized).toBe(0);
  });

  it('解析器没给出本地路径时按失败处理', async () => {
    const localizer = createMediaLocalizer(() => Promise.resolve(''));
    const payload = { data: { sourcePath: REMOTE } };

    await localizer.localize(payload);

    expect(payload.data.sourcePath).toBe(REMOTE);
    expect(localizer.stats.failed).toHaveLength(1);
  });
});

describe('localizeMediaInPlace', () => {
  it('浏览器环境直接跳过', async () => {
    mocks.isTauri = false;

    await expect(localizeMediaInPlace({ data: { sourcePath: REMOTE } })).resolves.toEqual({
      localized: 0,
      failed: [],
    });
    expect(mocks.persistMediaSourceAuto).not.toHaveBeenCalled();
  });
});

describe('localizeProjectRecord', () => {
  const record = {
    id: 'p1',
    name: '项目',
    createdAt: 1,
    updatedAt: 1,
    nodeCount: 1,
    nodesJson: JSON.stringify([{ id: 'n1', data: { sourcePath: REMOTE } }]),
    edgesJson: '[]',
    viewportJson: '{}',
    historyJson: JSON.stringify({ past: [], future: [], imagePool: [REMOTE] }),
  };

  it('有远端引用时返回改写后的记录', async () => {
    const localizer = createMediaLocalizer(() => Promise.resolve(LOCAL));

    const next = await localizeProjectRecord(record, localizer);

    expect(next).not.toBeNull();
    expect(JSON.parse(next!.nodesJson)[0].data.sourcePath).toBe(LOCAL);
    expect(JSON.parse(next!.historyJson).imagePool).toEqual([LOCAL]);
    expect(next!.viewportJson).toBe('{}');
  });

  it('没有远端引用时返回 null（不必回写数据库）', async () => {
    const localizer = createMediaLocalizer(() => Promise.resolve(LOCAL));
    const clean = { ...record, nodesJson: '[]', historyJson: JSON.stringify({ past: [], future: [], imagePool: [] }) };

    await expect(localizeProjectRecord(clean, localizer)).resolves.toBeNull();
  });
});

describe('runExistingMediaLocalization', () => {
  it('模板、当前工程（内存）、其余工程都会被本地化', async () => {
    mocks.persistMediaSourceAuto.mockResolvedValue(LOCAL);
    mocks.templateList.mockResolvedValue([
      { id: 't1', name: '模板一', assets: [{ sourcePath: REMOTE }], pipeline: {}, graph: { nodes: [], edges: [] } },
    ]);
    mocks.listProjectSummaries.mockResolvedValue([
      { id: 'current', name: '当前工程', createdAt: 1, updatedAt: 1, nodeCount: 1 },
      { id: 'other', name: '别的工程', createdAt: 1, updatedAt: 1, nodeCount: 1 },
    ]);
    mocks.getProjectRecord.mockResolvedValue({
      id: 'other',
      name: '别的工程',
      createdAt: 1,
      updatedAt: 1,
      nodeCount: 1,
      nodesJson: JSON.stringify([{ id: 'n', data: { sourcePath: REMOTE } }]),
      edgesJson: '[]',
      viewportJson: '{}',
      historyJson: JSON.stringify({ past: [], future: [] }),
    });
    mocks.project.currentProjectId = 'current';
    mocks.project.currentProject = { viewport: { x: 0, y: 0, zoom: 1 } };
    mocks.canvas.nodes = [{ id: 'live', data: { sourcePath: REMOTE } }];

    const report = await runExistingMediaLocalization();

    // 模板被改写并保存
    expect(mocks.templateSave).toHaveBeenCalledTimes(1);
    const savedTemplate = mocks.templateSave.mock.calls[0][0];
    expect(savedTemplate.assets[0].sourcePath).toBe(LOCAL);

    // 当前工程走内存：替换画布数据 + 保存
    expect(mocks.canvas.setCanvasData).toHaveBeenCalledTimes(1);
    const [nextNodes] = mocks.canvas.setCanvasData.mock.calls[0];
    expect(nextNodes[0].data.sourcePath).toBe(LOCAL);
    expect(mocks.project.saveCurrentProject).toHaveBeenCalledTimes(1);

    // 其余工程走数据库
    expect(mocks.upsertProjectRecord).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mocks.upsertProjectRecord.mock.calls[0][0].nodesJson)[0].data.sourcePath).toBe(LOCAL);

    expect(report.templatesChanged).toBe(1);
    expect(report.projectsChanged).toBe(2);
    expect(report.localized).toBeGreaterThanOrEqual(3);
  });

  it('浏览器环境不做任何事', async () => {
    mocks.isTauri = false;

    const report = await runExistingMediaLocalization();

    expect(mocks.templateList).not.toHaveBeenCalled();
    expect(report.localized).toBe(0);
  });
});
