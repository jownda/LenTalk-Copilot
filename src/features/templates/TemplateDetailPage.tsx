import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Check, CircleAlert, Copy, Download, GitBranch, LoaderCircle, Pencil, Play, Trash2, Video, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiIconButton, UiInput, UiPanel, UiTextArea } from '@/components/ui/primitives';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { saveMediaSourceWithDialog } from '@/features/canvas/application/mediaDownload';
import { regenerateTemplate } from './regenerate';
import { browserTemplateRepository } from './storage/templateRepository';
import { findReferenceTokens } from '@/features/canvas/application/referenceTokenEditing';
import { ImageViewerModal } from '@/features/canvas/ui/ImageViewerModal';
import { useCanvasStore } from '@/stores/canvasStore';
import { useAssetLibraryStore } from '@/features/library/assetStore';
import { type AssetRef, type Template } from './types';

function applyPromptToGraph(template: Template, nextPrompt: string): Template {
  if (!template.graph) return template;
  return {
    ...template,
    graph: {
      ...template.graph,
      nodes: template.graph.nodes.map((node) => {
        if (node.id !== template.graph?.videoNodeId) return node;
        const generationRequest = node.data.generationRequest;
        const videoRequest = generationRequest && typeof generationRequest === 'object' && 'kind' in generationRequest && generationRequest.kind === 'video'
          ? generationRequest
          : null;
        return {
          ...node,
          data: {
            ...node.data,
            prompt: nextPrompt,
            ...(videoRequest
              ? { generationRequest: { ...videoRequest, prompt: nextPrompt } }
              : {}),
          },
        };
      }),
    },
  };
}

function AssetThumbnail({ asset }: { asset: AssetRef }) {
  const source = resolveImageDisplayUrl(asset.sourcePath);
  if (asset.kind === 'image') {
    return <img src={source} alt={asset.fileName} className="h-full w-full object-cover" />;
  }
  if (asset.kind === 'video') {
    return <video muted preload="metadata" src={source} className="h-full w-full object-cover" />;
  }
  return <span className="flex h-full w-full items-center justify-center text-[10px] font-semibold uppercase text-text-muted">audio</span>;
}

function TemplatePromptEditor({
  value,
  onChange,
  editable,
  images,
  audio,
  assetNameBySource,
}: {
  value: string;
  onChange: (value: string) => void;
  editable: boolean;
  images: AssetRef[];
  audio: AssetRef[];
  assetNameBySource: Map<string, string>;
}) {
  const openImageViewer = useCanvasStore((state) => state.openImageViewer);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const tokens = findReferenceTokens(value, images.length, audio.length);
  const imageUrls = images.map((asset) => resolveImageDisplayUrl(asset.sourcePath));
  const resolveAssetName = (asset: AssetRef) => assetNameBySource.get(asset.sourcePath.trim())
    || (asset.assetId ? assetNameBySource.get(`asset:${asset.assetId}`) : undefined)
    || asset.fileName;
  const audioLabels = audio.map(resolveAssetName);
  const renderPrompt = () => {
    if (!value) return ' ';
    const parts: ReactNode[] = [];
    let lastIndex = 0;
    tokens.forEach((token) => {
      if (token.start > lastIndex) parts.push(<span key={`text-${lastIndex}`}>{value.slice(lastIndex, token.start)}</span>);
      if (token.kind === 'image' && imageUrls[token.value - 1]) {
        const imageUrl = imageUrls[token.value - 1];
        parts.push(
          <button
            key={`image-${token.start}`}
            type="button"
            className="pointer-events-auto relative inline-flex h-5 w-5 -translate-y-px cursor-zoom-in overflow-hidden rounded align-middle"
            title="查看引用图片"
            onClick={(event) => {
              event.stopPropagation();
              openImageViewer(imageUrl, imageUrls);
            }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <img src={imageUrl} alt={token.token} className="h-full w-full object-cover" />
          </button>,
        );
      } else if (token.kind === 'audio') {
        parts.push(
          <span key={`audio-${token.start}`} className="mx-0.5 inline-flex max-w-[150px] items-center gap-1 rounded bg-accent px-1.5 py-0.5 align-middle text-[10px] text-white">
            <span className="shrink-0">♫</span><span className="truncate">{audioLabels[token.value - 1] ?? token.token}</span>
          </span>,
        );
      } else {
        parts.push(<span key={`token-${token.start}`}>{token.token}</span>);
      }
      lastIndex = token.end;
    });
    if (lastIndex < value.length) parts.push(<span key={`text-${lastIndex}`}>{value.slice(lastIndex)}</span>);
    return parts;
  };

  return (
    <div className="relative h-[260px] max-h-[42vh] overflow-hidden rounded-md border border-border-dark bg-bg-dark/60">
      <div ref={highlightRef} aria-hidden="true" className="pointer-events-none absolute inset-0 z-20 overflow-hidden whitespace-pre-wrap break-words p-3 text-sm leading-6 text-text-dark">
        {renderPrompt()}
      </div>
      <textarea
        ref={textareaRef}
        value={value}
        readOnly={!editable}
        onChange={(event) => onChange(event.target.value)}
        rows={8}
        onScroll={() => {
          if (!textareaRef.current || !highlightRef.current) return;
          highlightRef.current.scrollTop = textareaRef.current.scrollTop;
          highlightRef.current.scrollLeft = textareaRef.current.scrollLeft;
        }}
        className="relative z-10 h-full w-full resize-none overflow-y-auto overflow-x-hidden border-0 bg-transparent p-3 text-sm leading-6 text-transparent caret-text-dark outline-none placeholder:text-text-muted/70 focus:border-0"
      />
    </div>
  );
}

function VideoHistoryCard({
  run,
  templateName,
  downloading,
  onDownload,
  onOpen,
}: {
  run: NonNullable<Template['artifacts']['history'][number]>;
  templateName: string;
  downloading: boolean;
  onDownload: () => void;
  onOpen: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoSource = run.videoRef?.sourcePath ?? '';
  const [aspectRatio, setAspectRatio] = useState('16 / 9');
  const isRunning = run.status === 'running';
  const isFailed = run.status === 'failed';
  const errorMessage = typeof run.params?.error === 'string' ? run.params.error : '生成失败';
  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video || isRunning || isFailed) return;
    if (video.paused) {
      void video.play();
    } else {
      video.pause();
    }
  };

  return (
    <article className={`max-w-full overflow-hidden rounded border ${isFailed ? 'border-red-400/40' : isRunning ? 'border-accent/50' : 'border-border-dark'} bg-bg-dark/45`}>
      <button type="button" disabled={isRunning || isFailed} className={`group relative block w-full bg-black text-left ${isRunning || isFailed ? 'cursor-default' : 'cursor-pointer'}`} style={{ aspectRatio }} onClick={togglePlayback} onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); onOpen(); }} title="播放视频，双击放大">
        <video
          ref={videoRef}
          preload="metadata"
          src={resolveImageDisplayUrl(videoSource)}
          className="h-full w-full object-contain"
          onLoadedMetadata={(event) => {
            const { videoWidth, videoHeight } = event.currentTarget;
            if (videoWidth > 0 && videoHeight > 0) setAspectRatio(`${videoWidth} / ${videoHeight}`);
          }}
        />
        {isRunning && <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 text-xs text-white"><LoaderCircle className="h-6 w-6 animate-spin text-accent" /><span>正在生成视频…</span><span className="h-1 w-2/3 overflow-hidden rounded-full bg-white/15"><span className="block h-full w-1/2 animate-pulse rounded-full bg-accent" /></span></span>}
        {isFailed && <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/65 px-3 text-center text-xs text-red-200"><CircleAlert className="h-6 w-6 text-red-400" /><span>生成失败</span><span className="line-clamp-3 break-words text-[10px] text-red-200/80">{errorMessage}</span></span>}
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/15 opacity-0 transition-opacity group-hover:opacity-100">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/65 text-white"><Play className="ml-0.5 h-3.5 w-3.5 fill-current" /></span>
        </span>
      </button>
      <div className="flex items-center justify-between gap-1.5 px-1.5 py-1">
        <span className={`min-w-0 truncate text-[10px] ${isFailed ? 'text-red-300' : 'text-text-muted'}`} title={isFailed ? errorMessage : new Date(run.createdAt).toLocaleString()}>{isRunning ? '生成中…' : isFailed ? errorMessage : new Date(run.createdAt).toLocaleString()}</span>
        {isFailed ? <UiIconButton
          type="button"
          className="h-6 w-6 shrink-0 text-red-300"
          onClick={() => void navigator.clipboard.writeText(errorMessage)}
          title="复制错误信息"
          aria-label="复制错误信息"
        ><Copy className="h-3 w-3" /></UiIconButton> : <UiIconButton
          type="button"
          className="h-6 w-6 shrink-0"
          onClick={onDownload}
          disabled={downloading || isRunning}
          title={`下载 ${templateName}`}
          aria-label={`下载 ${templateName}`}
        ><Download className="h-3 w-3" /></UiIconButton>}
      </div>
    </article>
  );
}

export function TemplateDetailPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { templateId } = useParams();
  const [template, setTemplate] = useState<Template | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [downloadingRunId, setDownloadingRunId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeVideo, setActiveVideo] = useState<{ source: string; name: string } | null>(null);
  const imageViewer = useCanvasStore((state) => state.imageViewer);
  const closeImageViewer = useCanvasStore((state) => state.closeImageViewer);
  const navigateImageViewer = useCanvasStore((state) => state.navigateImageViewer);
  const libraryAssets = useAssetLibraryStore((state) => state.assets);
  const hydrateLibrary = useAssetLibraryStore((state) => state.hydrate);

  useEffect(() => {
    void hydrateLibrary();
  }, [hydrateLibrary]);

  const assetNameBySource = useMemo(() => {
    const names = new Map<string, string>();
    libraryAssets.forEach((asset) => {
      const name = asset.name.trim();
      if (!name) return;
      names.set(`asset:${asset.id}`, name);
      [asset.sourcePath, asset.previewImageUrl ?? ''].forEach((source) => {
        const normalized = source.trim();
        if (normalized) names.set(normalized, name);
      });
    });
    return names;
  }, [libraryAssets]);

  useEffect(() => {
    if (!templateId) return;
    void browserTemplateRepository.get(templateId).then((loaded) => {
      setTemplate(loaded);
      setName(loaded?.name ?? '');
      setDescription(loaded?.description ?? '');
      setPrompt(loaded?.pipeline.prompt ?? '');
    });
  }, [templateId]);

  const handleSave = async () => {
    if (!template || !name.trim() || !prompt.trim()) return;
    const updated: Template = applyPromptToGraph({
      ...template,
      name: name.trim(),
      ...(description.trim() ? { description: description.trim() } : { description: undefined }),
      pipeline: { ...template.pipeline, prompt: prompt.trim() },
      updatedAt: new Date().toISOString(),
    }, prompt.trim());
    await browserTemplateRepository.save(updated);
    setTemplate(updated);
    setEditing(false);
    setNotice(t('templatePage.changesSaved'));
  };

  const handleRegenerate = async () => {
    if (!template || busy || template.status === 'broken') return;
    setBusy(true);
    setNotice(null);
    try {
      const sourceTemplate = editing
        ? applyPromptToGraph({ ...template, pipeline: { ...template.pipeline, prompt: prompt.trim() } }, prompt.trim())
        : template;
      const result = await regenerateTemplate(sourceTemplate, { onTemplateUpdate: setTemplate });
      setTemplate(result.template);
      setName(result.template.name);
      setPrompt(result.template.pipeline.prompt);
      setNotice(t('templatePage.regenerateSuccess'));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('templatePage.regenerateFailed'));
      const current = await browserTemplateRepository.get(template.id);
      if (current) setTemplate(current);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!template || !window.confirm(t('templatePage.confirmDelete', { name: template.name }))) return;
    await browserTemplateRepository.delete(template.id);
    navigate('/templates');
  };

  if (!template) {
    return <div className="flex h-full items-center justify-center text-sm text-text-muted">{t('templatePage.notFound')}</div>;
  }

  const referenceAssets = [
    ...template.pipeline.referenceImages,
    ...template.pipeline.referenceAudio,
    ...template.pipeline.referenceVideo,
  ];
  const resolveAssetName = (asset: AssetRef) => assetNameBySource.get(asset.sourcePath.trim()) || asset.fileName;
  const videoHistory = template.artifacts.history
    .slice()
    .reverse()
    .filter((run) => run.status === 'running' || run.status === 'failed' || Boolean(run.videoRef?.sourcePath));
  const handleDownloadRun = async (run: Template['artifacts']['history'][number]) => {
    if (!template || !run.videoRef?.sourcePath || downloadingRunId) return;
    setDownloadingRunId(run.id);
    setNotice(null);
    try {
      await saveMediaSourceWithDialog({
        source: run.videoRef.sourcePath,
        nodeId: run.id,
        mediaType: 'video',
        fileName: run.videoRef.fileName || `${template.name}-${run.id}.mp4`,
      });
      setNotice(t('templatePage.downloadSuccess'));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('templatePage.downloadFailed'));
    } finally {
      setDownloadingRunId(null);
    }
  };

  return (
    <div className="ui-scrollbar h-full min-h-0 overflow-auto p-4 sm:p-6 lg:p-8">
      <div className="mx-auto w-full max-w-[1600px]">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Link to="/templates"><UiIconButton title={t('titleBar.back')} aria-label={t('titleBar.back')}><ArrowLeft className="h-4 w-4" /></UiIconButton></Link>
            {editing ? <UiInput value={name} onChange={(event) => setName(event.target.value)} className="max-w-[420px] text-lg font-semibold" /> : <h1 className="truncate text-2xl font-bold text-text-dark">{template.name}</h1>}
          </div>
          <div className="flex items-center gap-2">
            {template.graph && <Link to={`/templates/${template.id}/graph`}><UiButton type="button" variant="muted" size="sm" className="gap-2"><GitBranch className="h-4 w-4" />{t('templatePage.viewNodes')}</UiButton></Link>}
            {editing ? <UiButton type="button" variant="primary" size="sm" className="gap-2" onClick={() => void handleSave()} disabled={!name.trim() || !prompt.trim()}><Check className="h-4 w-4" />{t('common.save')}</UiButton> : <UiButton type="button" variant="muted" size="sm" className="gap-2" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" />{t('templatePage.edit')}</UiButton>}
            <UiButton type="button" variant="primary" size="sm" className="gap-2" onClick={() => void handleRegenerate()} disabled={busy || template.status === 'broken' || !prompt.trim()}><Video className="h-4 w-4" />{busy ? t('templatePage.regenerating') : t('templatePage.regenerate')}</UiButton>
            <UiIconButton onClick={() => void handleDelete()} title={t('templatePage.delete')} aria-label={t('templatePage.delete')} className="text-red-400"><Trash2 className="h-4 w-4" /></UiIconButton>
          </div>
        </div>
        {notice && <p role="status" className="mb-4 text-sm text-emerald-400">{notice}</p>}
        <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(280px,0.9fr)_minmax(240px,0.8fr)_minmax(420px,1.3fr)]">
          <UiPanel className="min-w-0 rounded-lg p-4">
            <h2 className="mb-4 text-sm font-semibold text-text-dark">{t('templatePage.promptSummary')}</h2>
            {referenceAssets.length > 0 && (
              <div className="mb-4">
                <p className="mb-2 text-xs text-text-muted">{t('templatePage.referenceAssets')}</p>
                <div className="grid grid-cols-4 gap-2 sm:grid-cols-5 xl:grid-cols-4">
                  {referenceAssets.map((asset) => (
                    <div key={asset.refId} className="group relative aspect-square overflow-hidden rounded-md border border-border-dark bg-bg-dark" title={resolveAssetName(asset)}>
                      <AssetThumbnail asset={asset} />
                      <span className="absolute inset-x-0 bottom-0 truncate bg-black/65 px-1 py-1 text-[9px] text-white">{resolveAssetName(asset)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <label className="block text-xs text-text-muted">{t('templatePage.prompt')}<div className="mt-1.5"><TemplatePromptEditor value={editing ? prompt : template.pipeline.prompt} onChange={setPrompt} editable={editing} images={template.pipeline.referenceImages} audio={template.pipeline.referenceAudio} assetNameBySource={assetNameBySource} /></div></label>
            {editing && <label className="mt-4 block text-xs text-text-muted">{t('templatePage.description')}<UiTextArea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} className="mt-1.5" /></label>}
          </UiPanel>
          <UiPanel className="min-w-0 rounded-lg p-4">
            <h2 className="mb-4 text-sm font-semibold text-text-dark">{t('templatePage.generationConfig')}</h2>
            <dl className="space-y-3 text-sm"><div><dt className="text-xs text-text-muted">{t('templatePage.model')}</dt><dd className="mt-1 break-words text-text-dark">{template.pipeline.modelId}</dd></div><div><dt className="text-xs text-text-muted">{t('templatePage.provider')}</dt><dd className="mt-1 text-text-dark">{template.pipeline.providerId}</dd></div><div><dt className="text-xs text-text-muted">{t('templatePage.duration')}</dt><dd className="mt-1 text-text-dark">{template.pipeline.duration}s</dd></div><div><dt className="text-xs text-text-muted">{t('templatePage.aspectRatio')}</dt><dd className="mt-1 text-text-dark">{template.pipeline.aspectRatio}</dd></div><div><dt className="text-xs text-text-muted">{t('templatePage.quality')}</dt><dd className="mt-1 text-text-dark">{template.pipeline.resolution || t('templatePage.none')}</dd></div><div><dt className="text-xs text-text-muted">{t('templatePage.imageMode')}</dt><dd className="mt-1 text-text-dark">{template.pipeline.imageMode === 'first-last' ? t('templatePage.firstLast') : t('templatePage.referenceMode')}</dd></div><div><dt className="text-xs text-text-muted">{t('templatePage.references')}</dt><dd className="mt-1 text-text-dark">{referenceAssets.length} ({template.pipeline.referenceImages.length} {t('templatePage.images')}, {template.pipeline.referenceAudio.length} {t('templatePage.audio')}, {template.pipeline.referenceVideo.length} {t('templatePage.videoReferences')})</dd></div><div><dt className="text-xs text-text-muted">{t('templatePage.description')}</dt><dd className="mt-1 whitespace-pre-wrap break-words text-text-dark">{template.description || t('templatePage.none')}</dd></div></dl>
          </UiPanel>
          <UiPanel className="min-w-0 rounded-lg p-4">
            <div className="mb-4 flex items-center justify-between gap-3"><h2 className="text-sm font-semibold text-text-dark">{t('templatePage.artifacts')}</h2><span className="text-xs text-text-muted">{videoHistory.length} {t('templatePage.videos')}</span></div>
            <div className="ui-scrollbar max-h-[540px] overflow-y-auto pr-1"><div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{videoHistory.map((run) => <VideoHistoryCard key={run.id} run={run} templateName={template.name} downloading={downloadingRunId === run.id} onDownload={() => void handleDownloadRun(run)} onOpen={() => { if (run.videoRef?.sourcePath) setActiveVideo({ source: run.videoRef.sourcePath, name: run.videoRef.fileName || template.name }); }} />)}</div></div>
          </UiPanel>
        </div>
      </div>
      <ImageViewerModal
        open={imageViewer.isOpen}
        imageUrl={imageViewer.currentImageUrl ?? ''}
        imageList={imageViewer.imageList}
        currentIndex={imageViewer.currentIndex}
        onClose={closeImageViewer}
        onNavigate={navigateImageViewer}
      />
      {activeVideo && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/90 p-4 backdrop-blur-sm" onClick={() => setActiveVideo(null)}>
          <div className="relative flex max-h-full w-full max-w-6xl flex-col gap-3" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 text-sm text-white"><span className="truncate">{activeVideo.name}</span><UiIconButton type="button" className="h-8 w-8 border-white/20 bg-black/50 text-white hover:bg-white/10 hover:text-white" onClick={() => setActiveVideo(null)} title="关闭" aria-label="关闭"><X className="h-4 w-4" /></UiIconButton></div>
            <video autoPlay controls playsInline src={resolveImageDisplayUrl(activeVideo.source)} className="max-h-[82vh] w-full rounded-md bg-black object-contain" />
          </div>
        </div>
      )}
    </div>
  );
}
