import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, LayoutGrid } from 'lucide-react';

import { UiButton, UiInput, UiModal } from '@/components/ui';
import { fetchRhtvCliStatus, type RhtvCliStatus } from '@/commands/rhtvCli';
import {
  ensureRhtvSpecs,
  getRhtvCatalog,
  refreshRhtvCatalog,
  useRhtvCatalogError,
  useRhtvCatalogRevision,
  useRhtvCatalogStatus,
  useRhtvCatalogStore,
} from '@/features/canvas/models/rhtvCatalog';
import { useRhtvCanvasStore } from '@/stores/rhtvCanvasStore';

/**
 * RunningHub 画布 CLI（rhtvcli）设置卡。
 *
 * 卡片只留一句简介，细节（路径、账号、画布、目录同步进度）都在弹窗里：
 * 目录由服务端实时下发，不需要跟应用版本走。
 */
export function RhtvCanvasSettings() {
  const [status, setStatus] = useState<RhtvCliStatus | null>(null);
  const [probing, setProbing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState(false);
  const executable = useRhtvCanvasStore((state) => state.executable);
  const setExecutable = useRhtvCanvasStore((state) => state.setExecutable);
  const [executableDraft, setExecutableDraft] = useState(executable);
  const catalogStatus = useRhtvCatalogStatus();
  const catalogError = useRhtvCatalogError();
  const revision = useRhtvCatalogRevision();

  const probe = useCallback(
    async (command?: string) => {
      setProbing(true);
      try {
        setStatus(await fetchRhtvCliStatus(command || executable || undefined));
      } catch (error) {
        setStatus({
          found: false,
          executable,
          resolvedPath: null,
          version: null,
          loggedIn: false,
          userId: null,
          canvasId: null,
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setProbing(false);
      }
    },
    [executable],
  );

  useEffect(() => {
    void probe();
  }, [probe]);

  const current = catalogStatus ?? status;
  const catalog = getRhtvCatalog();
  // revision 只用来触发重渲染：同步完目录后弹窗里的数量要跟着变。
  void revision;

  const specs = useRhtvCatalogStore((state) => state.specs);
  const specsLoading = useRhtvCatalogStore((state) => state.specsLoading);
  const totalModels = catalog.image.length + catalog.video.length;
  const resolvedSpecs = [...catalog.image, ...catalog.video].filter((item) =>
    Boolean(specs[item.modelCode]),
  ).length;
  const loggedIn = Boolean(current?.found && current.loggedIn);

  return (
    <>
      <div className="rounded-lg border border-border-dark bg-bg-dark/60 p-4">
        <button
          type="button"
          className="flex w-full items-start gap-3 text-left transition-colors hover:opacity-80"
          onClick={() => {
            setExecutableDraft(executable);
            setOpen(true);
            void probe();
          }}
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
            <LayoutGrid className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-text-dark">RunningHub 画布 CLI</span>
              <span className="flex shrink-0 items-center gap-1.5">
                {loggedIn && (
                  <span className="rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                    已登录
                  </span>
                )}
                <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />
              </span>
            </span>
            <span className="mt-0.5 block text-xs text-text-muted">
              画布模型目录实时同步，含标准 API 没有的 RH Enhanced 系列
            </span>
          </span>
        </button>
      </div>

      <UiModal
        isOpen={open}
        title="RunningHub 画布 CLI"
        widthClassName="w-[580px]"
        onClose={() => {
          if (!refreshing) setOpen(false);
        }}
      >
        <div className="ui-scrollbar max-h-[calc(100vh-180px)] space-y-4 overflow-y-auto text-sm text-text-dark">
          <p className="text-xs leading-5 text-text-muted">
            用 RunningHub 画布（<code className="text-text-dark">rhtvcli</code>
            ）跑图/视频：模型目录由服务端实时下发，画布里的 RH Enhanced 系列在标准模型 API 里没有。
          </p>

          <label className="block space-y-1">
            <span className="text-xs">可执行命令</span>
            <UiInput
              value={executableDraft}
              disabled={probing}
              placeholder="rhtvcli"
              onChange={(event) => setExecutableDraft(event.target.value)}
            />
            <span className="block text-[11px] leading-4 text-text-muted">
              默认从 PATH 与 <code>~/.runninghub-canvas/bin</code> 探测；找不到就填完整路径。
            </span>
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <UiButton
              size="sm"
              disabled={probing}
              onClick={() => {
                const next = executableDraft.trim();
                setExecutable(next);
                void probe(next || undefined);
              }}
            >
              {probing ? '检测中…' : '保存并检测'}
            </UiButton>
            <button
              type="button"
              className="text-xs text-accent hover:underline"
              onClick={() => void probe()}
            >
              重新检测
            </button>
          </div>

          {/* 状态 / 账号 */}
          <div className="space-y-2 border-t border-border-dark pt-4">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-text-muted">状态</span>
              <span className={current?.found ? 'text-text-dark' : 'text-text-muted'}>
                {probing
                  ? '检测中…'
                  : current
                    ? current.found
                      ? `v${current.version ?? '?'} · ${current.loggedIn ? '已登录' : '未登录'}`
                      : '未检测到'
                    : '—'}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-text-muted">账号</span>
              <span className={current?.userId ? 'text-text-dark' : 'text-text-muted'}>
                {current?.userId ?? '—'}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-text-muted">画布</span>
              <span className={current?.canvasId ? 'text-text-dark' : 'text-text-muted'}>
                {current?.canvasId ?? '首次生成时自动创建'}
              </span>
            </div>
            {current?.resolvedPath && (
              <p className="break-all text-[11px] leading-4 text-text-muted">{current.resolvedPath}</p>
            )}
            {current?.found && !current.loggedIn ? (
              <div className="space-y-1 rounded-md bg-bg-dark px-2 py-1.5">
                <p className="text-[11px] text-text-muted">需要终端执行一次浏览器授权：</p>
                <code className="block select-all font-mono text-[11px] text-text-dark">
                  rhtvcli login
                </code>
              </div>
            ) : null}
          </div>

          {/* 模型目录 */}
          <div className="space-y-2 border-t border-border-dark pt-4">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-text-muted">已同步</span>
              <span className={loggedIn ? 'text-text-dark' : 'text-text-muted'}>
                {loggedIn
                  ? `图片 ${catalog.image.length} · 视频 ${catalog.video.length} · 音频 ${catalog.audio.length}`
                  : '—'}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-text-muted">参数已解析</span>
              <span className={loggedIn ? 'text-text-dark' : 'text-text-muted'}>
                {loggedIn ? `${resolvedSpecs}/${totalModels}` : '—'}
              </span>
              {specsLoading && <span className="text-[11px] text-text-muted">同步中…</span>}
            </div>
            <p className="text-[11px] leading-4 text-text-muted">
              节点面板里的比例 / 分辨率 / 时长档位都按每个模型的 schema 生成，所以参数要按模型逐个拉；
              首次选中模型时自动补，不用等全量。
            </p>
            <UiButton
              size="sm"
              disabled={refreshing || probing || !loggedIn}
              onClick={async () => {
                setRefreshing(true);
                try {
                  await refreshRhtvCatalog(true);
                  // 显式点才全量拉：100 个模型串行约 3 分钟，不能放在启动流程里。
                  await ensureRhtvSpecs({ force: true });
                  await probe();
                } finally {
                  setRefreshing(false);
                }
              }}
            >
              {refreshing ? '同步中…' : '同步目录与参数'}
            </UiButton>
          </div>

          {current?.message ? (
            <p className="whitespace-pre-wrap break-words text-[11px] leading-4 text-text-muted">
              {current.message}
            </p>
          ) : null}
          {catalogError ? <p className="text-[11px] leading-4 text-amber-400">{catalogError}</p> : null}
        </div>
      </UiModal>
    </>
  );
}
