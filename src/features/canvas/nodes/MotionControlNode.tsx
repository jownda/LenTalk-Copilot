import { memo, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Handle, Position, type NodeProps, useUpdateNodeInternals } from '@xyflow/react';
import { Accessibility, AudioLines, ImagePlus, LoaderCircle, Upload, Video } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isTauri } from '@tauri-apps/api/core';

import {
  CANVAS_NODE_TYPES,
  type MotionControlLipSyncInput,
  type MotionControlMode,
  type MotionControlNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { canvasAiGateway, graphImageResolver } from '@/features/canvas/application/canvasServices';
import { useCanvasInputGraph } from '@/features/canvas/application/useCanvasInputGraph';
import { prepareNodeImageFromFile, resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { getVideoModel, listVideoModels } from '@/features/canvas/models';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { showErrorDialog } from '@/features/canvas/application/errorDialog';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { persistLibraryAssetBinary, persistLibraryAssetFile } from '@/commands/assetLibrary';
import { isZzdhLipSyncModel } from '@/commands/zzdhApi';

type MotionControlNodeProps = NodeProps & {
  id: string;
  data: MotionControlNodeData;
  selected?: boolean;
  width?: number;
  height?: number;
};

type UploadKind = 'image' | 'motion-video' | 'source-video' | 'audio';

function fileExtension(file: File): string {
  const extension = file.name.split('.').pop()?.trim().toLowerCase();
  return extension && /^[a-z0-9]{1,8}$/.test(extension) ? extension : 'bin';
}

async function persistMediaFile(file: File): Promise<string> {
  const path = (file as File & { path?: string }).path?.trim();
  if (isTauri()) {
    if (path) {
      return await persistLibraryAssetFile(path, fileExtension(file));
    }
    return await persistLibraryAssetBinary(new Uint8Array(await file.arrayBuffer()), fileExtension(file));
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
  return dataUrl;
}

function sourceLabel(source: string | null | undefined, fallback: string): string {
  if (!source) return fallback;
  if (/^data:/i.test(source)) return fallback;
  const clean = source.split(/[\\/]/).pop()?.trim();
  return clean || fallback;
}

function resolveModeModelLabel(modelId: string): string {
  const model = modelId ? getVideoModel(modelId) : undefined;
  return model?.displayName ?? modelId;
}

export const MotionControlNode = memo(({ id, data, selected, width, height }: MotionControlNodeProps) => {
  const { t } = useTranslation();
  const updateNodeInternals = useUpdateNodeInternals();
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);
  const { nodes, edges } = useCanvasInputGraph();
  const apiKeys = useSettingsStore((state) => state.apiKeys);
  const customApis = useSettingsStore((state) => state.customApis);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadKind, setUploadKind] = useState<UploadKind | null>(null);
  const [isGenerating, setIsGenerating] = useState(Boolean(data.isGenerating));
  const [error, setError] = useState<string | null>(data.generationError ?? null);

  const inputImages = useMemo(
    () => graphImageResolver.collectInputImages(id, nodes, edges),
    [edges, id, nodes],
  );
  const inputVideos = useMemo(
    () => graphImageResolver.collectInputVideos(id, nodes, edges),
    [edges, id, nodes],
  );
  const inputAudio = useMemo(
    () => graphImageResolver.collectInputAudio(id, nodes, edges),
    [edges, id, nodes],
  );

  const mode: MotionControlMode = data.mode === 'lip-sync' ? 'lip-sync' : 'motion-control';
  const models = useMemo(() => {
    const allVideoModels = listVideoModels();
    const klingModels = allVideoModels.filter((model) =>
      model.id.startsWith('custom:')
      && (model.id.toLowerCase().includes('kling')
        || model.displayName.toLowerCase().includes('kling')
        || model.displayName.toLowerCase().includes('可灵')),
    );
    if (mode !== 'motion-control') return klingModels;
    return klingModels.filter((model) => model.id.toLowerCase().includes('motion-control')
      || model.displayName.toLowerCase().includes('motion control')
      || model.displayName.toLowerCase().includes('动作控制'));
  }, [customApis, mode]);
  const allModels = useMemo(() => {
    if (mode === 'motion-control') return models;
    const lipSyncModels = listVideoModels().filter((model) =>
      isZzdhLipSyncModel(model.id)
      || (model.id.startsWith('custom:') && model.id.toLowerCase().includes('kling')),
    );
    return lipSyncModels;
  }, [customApis, mode, models]);
  const selectedModelId = allModels.some((model) => model.id === data.model)
    ? data.model
    : allModels[0]?.id || '';
  const imageSource = data.imageSource || inputImages[0] || null;
  const motionVideoSource = data.motionVideoSource || inputVideos[0] || null;
  const sourceVideo = data.inputVideoSource || inputVideos[0] || null;
  const audioSource = data.audioSource || inputAudio[0] || null;
  const isZzdhLipSync = mode === 'lip-sync' && isZzdhLipSyncModel(selectedModelId);
  const lipSyncInput: MotionControlLipSyncInput = data.lipSyncInput === 'video' ? 'video' : 'image';
  const zzdhUsesVideoInput = isZzdhLipSync && lipSyncInput === 'video';
  const lipSyncNeedsSourceVideo = mode === 'lip-sync' && !isZzdhLipSync;
  const resolvedWidth = Math.max(360, Math.round(width ?? 420));
  const resolvedHeight = Math.max(460, Math.round(height ?? 560));

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, mode, updateNodeInternals]);

  useEffect(() => {
    if (data.model !== selectedModelId && selectedModelId) {
      updateNodeData(id, { model: selectedModelId });
    }
  }, [data.model, id, selectedModelId, updateNodeData]);

  useEffect(() => {
    return () => {
      for (const source of [data.motionVideoPreviewUrl, data.inputVideoPreviewUrl, data.audioPreviewUrl]) {
        if (source?.startsWith('blob:')) URL.revokeObjectURL(source);
      }
    };
  }, [data.audioPreviewUrl, data.inputVideoPreviewUrl, data.motionVideoPreviewUrl]);

  const openUpload = useCallback((kind: UploadKind) => {
    setUploadKind(kind);
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    const kind = uploadKind;
    event.target.value = '';
    if (!file || !kind) return;
    try {
      if (kind === 'image') {
        const prepared = await prepareNodeImageFromFile(file);
        updateNodeData(id, {
          imageSource: prepared.imageUrl,
          imagePreviewUrl: prepared.previewImageUrl,
        });
      } else {
        const source = await persistMediaFile(file);
        const preview = URL.createObjectURL(file);
        const fields: Partial<MotionControlNodeData> = kind === 'motion-video'
          ? { motionVideoSource: source, motionVideoPreviewUrl: preview }
          : kind === 'source-video'
            ? { inputVideoSource: source, inputVideoPreviewUrl: preview }
            : { audioSource: source, audioPreviewUrl: preview };
        updateNodeData(id, fields);
      }
    } catch (uploadError) {
      const message = uploadError instanceof Error ? uploadError.message : String(uploadError);
      setError(message);
      void showErrorDialog(message, t('common.error'));
    } finally {
      setUploadKind(null);
    }
  }, [id, t, updateNodeData, uploadKind]);

  const handleGenerate = useCallback(async () => {
    setError(null);
    const chosenModel = getVideoModel(selectedModelId);
    if (!chosenModel) return setError(t('node.motionControl.needModel'));
    if (!imageSource && mode === 'motion-control') return setError(t('node.motionControl.needImage'));
    if (!motionVideoSource && mode === 'motion-control') return setError(t('node.motionControl.needMotionVideo'));
    if (!sourceVideo && (lipSyncNeedsSourceVideo || zzdhUsesVideoInput)) return setError(t('node.motionControl.needSourceVideo'));
    if (!imageSource && isZzdhLipSync && !zzdhUsesVideoInput) return setError(t('node.motionControl.needLipSyncImage'));
    if (!audioSource && mode === 'lip-sync') return setError(t('node.motionControl.needAudio'));
    const providerKey = apiKeys[chosenModel.providerId] ?? '';
    if (!providerKey.trim() && !chosenModel.id.startsWith('jimeng-cli/')) {
      return setError(t('node.imageEdit.apiKeyRequired'));
    }

    const prompt = data.prompt.trim();
    const outputId = addNode(CANVAS_NODE_TYPES.audio, findNodePosition(id, 420, 260), {
      displayName: prompt || resolveNodeDisplayName(CANVAS_NODE_TYPES.motionControl, data),
      mediaType: 'video',
      sourcePath: null,
      aspectRatio: '16:9',
      isGenerating: true,
      generationStartedAt: Date.now(),
      generationProviderId: chosenModel.providerId,
      generationModel: chosenModel.id,
      providerBaseUrl: customApis.find((api) => api.id === chosenModel.providerId.replace(/^custom:/, ''))?.baseUrl ?? null,
    });
    addEdge(id, outputId);
    setIsGenerating(true);
    updateNodeData(id, { isGenerating: true, generationError: null });

    try {
      const outputUrl = await canvasAiGateway.generateVideo({
        prompt,
        model: chosenModel.id,
        duration: mode === 'lip-sync' ? 10 : Number(data.duration ?? 5),
        aspectRatio: '16:9',
        videoResolution: data.resolution,
        referenceImages: (mode === 'motion-control' || (isZzdhLipSync && !zzdhUsesVideoInput)) && imageSource ? [imageSource] : [],
        referenceAudio: mode === 'lip-sync' && audioSource ? [audioSource] : [],
        extraParams: {
          video_transport: isZzdhLipSync ? 'zzdh-v8-video' : 'kling-control',
          control_mode: mode,
          character_orientation: data.characterOrientation,
          keep_original_audio: data.keepOriginalAudio,
          resolution: data.resolution,
          motion_reference_video: motionVideoSource,
          source_video: sourceVideo,
          reference_videos: zzdhUsesVideoInput && sourceVideo ? [sourceVideo] : undefined,
          lip_sync_audio: audioSource,
          face_session_id: data.faceSessionId?.trim(),
          face_id: data.faceId?.trim(),
        },
      });
      updateNodeData(outputId, {
        sourcePath: outputUrl,
        isGenerating: false,
        generationResultProtected: true,
      });
      updateNodeData(id, { isGenerating: false, outputVideoUrl: outputUrl });
    } catch (generationError) {
      const message = generationError instanceof Error ? generationError.message : String(generationError);
      setError(message);
      updateNodeData(outputId, { isGenerating: false, generationError: message, generationErrorDetails: message });
      updateNodeData(id, { isGenerating: false, generationError: message });
      void showErrorDialog(message, t('node.motionControl.generationFailed'));
    } finally {
      setIsGenerating(false);
    }
  }, [addEdge, addNode, apiKeys, audioSource, customApis, data, findNodePosition, id, imageSource, isZzdhLipSync, lipSyncNeedsSourceVideo, mode, motionVideoSource, selectedModelId, sourceVideo, t, updateNodeData, zzdhUsesVideoInput]);

  const setMode = (nextMode: MotionControlMode) => {
    updateNodeData(id, { mode: nextMode });
    setError(null);
  };

  const renderSource = (kind: UploadKind, label: string, source: string | null, preview: string | null | undefined, icon: React.ReactNode) => (
    <div className="min-w-0 rounded-lg border border-border-dark bg-bg-dark/60 p-2">
      <div className="mb-1 flex items-center gap-1 text-[11px] text-text-muted">{icon}<span>{label}</span></div>
      <button
        type="button"
        className="nodrag flex h-12 w-full items-center gap-2 overflow-hidden rounded border border-dashed border-border-dark px-2 text-left text-xs text-text-muted hover:border-accent/60 hover:text-text-dark"
        onClick={(event) => { event.stopPropagation(); openUpload(kind); }}
        onMouseDown={(event) => event.stopPropagation()}
        title={sourceLabel(source, t('node.motionControl.notSet'))}
      >
        {preview ? (
          kind === 'image' ? <img src={resolveImageDisplayUrl(preview)} alt={label} className="h-9 w-12 rounded object-cover" /> :
            <span className="flex h-9 w-12 items-center justify-center rounded bg-accent/10 text-accent">{icon}</span>
        ) : <Upload className="h-4 w-4 shrink-0" />}
        <span className="truncate">{source ? sourceLabel(source, t('node.motionControl.connected')) : t('node.motionControl.upload')}</span>
      </button>
    </div>
  );

  return (
    <div
      className={`relative flex h-full flex-col gap-2 rounded-xl border bg-surface-dark p-3 text-text-dark shadow-lg ${selected ? 'border-accent/70 ring-1 ring-accent/30' : 'border-border-dark'}`}
      style={{ width: resolvedWidth, height: resolvedHeight }}
    >
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<Accessibility className="h-4 w-4" />}
        titleText={resolveNodeDisplayName(CANVAS_NODE_TYPES.motionControl, data)}
        editable
        onTitleChange={(displayName) => updateNodeData(id, { displayName })}
      />
      <Handle type="target" position={Position.Left} id="target" className="!h-3 !w-3 !border-2 !border-surface-dark !bg-accent" />
      <Handle type="source" position={Position.Right} id="source" className="!h-3 !w-3 !border-2 !border-surface-dark !bg-accent" />

      <div className="mt-7 flex gap-1 rounded-lg bg-bg-dark p-1">
        {(['motion-control', 'lip-sync'] as MotionControlMode[]).map((item) => (
          <button
            key={item}
            type="button"
            className={`nodrag flex-1 rounded-md px-2 py-1.5 text-xs ${mode === item ? 'bg-accent/20 text-text-dark' : 'text-text-muted hover:text-text-dark'}`}
            onClick={(event) => { event.stopPropagation(); setMode(item); }}
          >
            {t(item === 'motion-control' ? 'node.motionControl.modeMotion' : 'node.motionControl.modeLipSync')}
          </button>
        ))}
      </div>

      <div className="text-[10px] leading-4 text-text-muted">
        {t(mode === 'motion-control'
          ? 'node.motionControl.motionHint'
          : isZzdhLipSync
            ? 'node.motionControl.zzdhLipHint'
            : 'node.motionControl.faceHint')}
      </div>

      <select
        className="nodrag h-8 rounded border border-border-dark bg-bg-dark px-2 text-xs text-text-dark"
        value={selectedModelId}
        onChange={(event) => updateNodeData(id, { model: event.target.value })}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {allModels.length === 0 ? <option value="">{t('node.motionControl.needModel')}</option> : null}
        {allModels.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
      </select>
      <div className="truncate text-[10px] text-text-muted" title={selectedModelId}>
        {resolveModeModelLabel(selectedModelId) || t('node.motionControl.needModel')}
      </div>
      <div className="text-[10px] leading-4 text-text-muted">
        {t(isZzdhLipSync ? 'node.motionControl.zzdhModelHint' : 'node.motionControl.modelHint')}
      </div>

      {mode === 'motion-control' ? (
        <div className="grid grid-cols-2 gap-2">
          {renderSource('image', t('node.motionControl.characterImage'), imageSource, data.imagePreviewUrl || imageSource, <ImagePlus className="h-4 w-4" />)}
          {renderSource('motion-video', t('node.motionControl.motionVideo'), motionVideoSource, data.motionVideoPreviewUrl, <Video className="h-4 w-4" />)}
        </div>
      ) : isZzdhLipSync ? (
        <div className="space-y-2">
          <div className="flex gap-1 rounded-lg bg-bg-dark p-1">
            {(['image', 'video'] as MotionControlLipSyncInput[]).map((item) => (
              <button
                key={item}
                type="button"
                className={`nodrag flex-1 rounded-md px-2 py-1.5 text-[11px] ${lipSyncInput === item ? 'bg-accent/20 text-text-dark' : 'text-text-muted hover:text-text-dark'}`}
                onClick={(event) => { event.stopPropagation(); updateNodeData(id, { lipSyncInput: item }); setError(null); }}
                onMouseDown={(event) => event.stopPropagation()}
              >
                {t(item === 'image' ? 'node.motionControl.lipSyncImageAudio' : 'node.motionControl.lipSyncVideoAudio')}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {zzdhUsesVideoInput
              ? renderSource('source-video', t('node.motionControl.sourceVideo'), sourceVideo, data.inputVideoPreviewUrl, <Video className="h-4 w-4" />)
              : renderSource('image', t('node.motionControl.characterImage'), imageSource, data.imagePreviewUrl || imageSource, <ImagePlus className="h-4 w-4" />)}
            {renderSource('audio', t('node.motionControl.sourceAudio'), audioSource, data.audioPreviewUrl, <AudioLines className="h-4 w-4" />)}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {renderSource('source-video', t('node.motionControl.sourceVideo'), sourceVideo, data.inputVideoPreviewUrl, <Video className="h-4 w-4" />)}
          {renderSource('audio', t('node.motionControl.sourceAudio'), audioSource, data.audioPreviewUrl, <AudioLines className="h-4 w-4" />)}
        </div>
      )}

      <textarea
        className="nodrag nowheel min-h-[52px] resize-none rounded border border-border-dark bg-bg-dark p-2 text-xs text-text-dark outline-none placeholder:text-text-muted focus:border-accent/60"
        value={data.prompt}
        placeholder={t('node.motionControl.promptPlaceholder')}
        onChange={(event) => updateNodeData(id, { prompt: event.target.value })}
        onMouseDown={(event) => event.stopPropagation()}
      />

      <div className="grid grid-cols-2 gap-2">
        <label className="text-[10px] text-text-muted">{t('node.motionControl.resolution')}
          <select className="nodrag mt-1 h-7 w-full rounded border border-border-dark bg-bg-dark px-1.5 text-xs text-text-dark" value={data.resolution} onChange={(event) => updateNodeData(id, { resolution: event.target.value as MotionControlNodeData['resolution'] })}>
            <option value="720p">720p</option><option value="1080p">1080p</option>
          </select>
        </label>
        {mode === 'motion-control' ? (
          <label className="text-[10px] text-text-muted">{t('node.motionControl.orientation')}
            <select className="nodrag mt-1 h-7 w-full rounded border border-border-dark bg-bg-dark px-1.5 text-xs text-text-dark" value={data.characterOrientation} onChange={(event) => updateNodeData(id, { characterOrientation: event.target.value as MotionControlNodeData['characterOrientation'] })}>
              <option value="image">{t('node.motionControl.orientationImage')}</option><option value="video">{t('node.motionControl.orientationVideo')}</option>
            </select>
          </label>
        ) : (
          <label className="text-[10px] text-text-muted">{t('node.motionControl.faceId')}
            <input className="nodrag mt-1 h-7 w-full rounded border border-border-dark bg-bg-dark px-1.5 text-xs text-text-dark" value={data.faceId ?? ''} onChange={(event) => updateNodeData(id, { faceId: event.target.value })} />
          </label>
        )}
      </div>

      {mode === 'lip-sync' && (
        <input
          className="nodrag h-7 rounded border border-border-dark bg-bg-dark px-1.5 text-xs text-text-dark"
          placeholder={t('node.motionControl.faceSessionId')}
          value={data.faceSessionId ?? ''}
          onChange={(event) => updateNodeData(id, { faceSessionId: event.target.value })}
          onMouseDown={(event) => event.stopPropagation()}
        />
      )}

      {mode === 'motion-control' && (
        <label className="flex items-center gap-2 text-[11px] text-text-muted">
          <input type="checkbox" checked={data.keepOriginalAudio} onChange={(event) => updateNodeData(id, { keepOriginalAudio: event.target.checked })} />
          {t('node.motionControl.keepOriginalAudio')}
        </label>
      )}

      {error && <div className="max-h-12 overflow-auto rounded bg-red-500/10 px-2 py-1 text-[10px] leading-4 text-red-300">{error}</div>}
      <input
        ref={fileInputRef}
        type="file"
        accept={uploadKind === 'image' ? 'image/*' : uploadKind === 'audio' ? 'audio/*' : 'video/*'}
        className="hidden"
        onChange={handleFileChange}
      />
      <button
        type="button"
        className="nodrag mt-auto flex h-8 items-center justify-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
        disabled={isGenerating}
        onClick={(event) => { event.stopPropagation(); void handleGenerate(); }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {isGenerating ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Accessibility className="h-3.5 w-3.5" />}
        {isGenerating ? t('node.motionControl.generating') : t('node.motionControl.generate')}
      </button>
      <NodeResizeHandle minWidth={360} minHeight={460} maxWidth={720} maxHeight={900} />
    </div>
  );
});

MotionControlNode.displayName = 'MotionControlNode';
