import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow } from '@xyflow/react';
import { ArrowLeft, CheckCircle2, GitBranch, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '@xyflow/react/dist/style.css';

import { UiButton, UiPanel } from '@/components/ui/primitives';
import { useCanvasStore } from '@/stores/canvasStore';
import { isAudioNode, type CanvasEdge, type CanvasNode, type VideoGenNodeData } from '@/features/canvas/domain/canvasNodes';
import { graphImageResolver } from '@/features/canvas/application/canvasServices';
import { nodeTypes } from '@/features/canvas/nodes';
import { edgeTypes } from '@/features/canvas/edges';
import { browserTemplateRepository } from './storage/templateRepository';
import { templateCoverSource, type Template } from './types';

function isVideoResultNode(node: CanvasNode): boolean {
  return isAudioNode(node) && node.data.mediaType === 'video';
}

function findCurrentOutput(nodes: CanvasNode[], edges: CanvasEdge[], videoNodeId: string, fallbackId: string): CanvasNode | null {
  const candidates = nodes.filter((node) => isVideoResultNode(node) && edges.some((edge) => edge.source === videoNodeId && edge.target === node.id));
  return candidates[candidates.length - 1] ?? nodes.find((node) => node.id === fallbackId) ?? null;
}

function updateAssetRefs(template: Template, sources: string[], kind: 'image' | 'audio' | 'video', role: string) {
  return sources.map((source) => {
    const existing = template.assets.find((asset) => asset.kind === kind && asset.sourcePath === source);
    return existing ?? {
      refId: crypto.randomUUID(),
      kind,
      role,
      sourcePath: source,
      fileName: source.split(/[\\/]/).pop() || `${kind}-${Date.now()}`,
      required: true,
    };
  });
}

export function TemplateGraphPage() {
  const { t } = useTranslation();
  const { templateId } = useParams();
  const [template, setTemplate] = useState<Template | null>(null);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const loadedTemplateId = useRef<string | null>(null);
  const persistedGraphSignature = useRef('');
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const setCanvasData = useCanvasStore((state) => state.setCanvasData);
  const applyNodesChange = useCanvasStore((state) => state.onNodesChange);
  const applyEdgesChange = useCanvasStore((state) => state.onEdgesChange);
  const connectNodes = useCanvasStore((state) => state.onConnect);

  useEffect(() => {
    if (!templateId) return;
    let cancelled = false;
    void browserTemplateRepository.get(templateId).then((loaded) => {
      if (cancelled) return;
      setTemplate(loaded);
      setLoading(false);
      if (!loaded?.graph) return;
      loadedTemplateId.current = loaded.id;
      persistedGraphSignature.current = JSON.stringify({ nodes: loaded.graph.nodes, edges: loaded.graph.edges });
      setCanvasData(loaded.graph.nodes, loaded.graph.edges);
      setReady(true);
    });
    return () => {
      cancelled = true;
      loadedTemplateId.current = null;
      persistedGraphSignature.current = '';
      setCanvasData([], []);
    };
  }, [setCanvasData, templateId]);

  useEffect(() => {
    if (!ready || !template || !template.graph || loadedTemplateId.current !== template.id) return;
    const output = findCurrentOutput(nodes, edges, template.graph.videoNodeId, template.graph.outputNodeId);
    const sourcePath = output && typeof output.data.sourcePath === 'string' ? output.data.sourcePath.trim() : '';
    const currentSource = templateCoverSource(template);
    const graphSignature = JSON.stringify({ nodes, edges });
    const graphChanged = graphSignature !== persistedGraphSignature.current;
    if (!graphChanged && (!sourcePath || sourcePath === currentSource)) return;
    const videoNode = nodes.find((node) => node.id === template.graph?.videoNodeId);
    const videoData = videoNode?.data as VideoGenNodeData | undefined;
    const referenceImages = graphImageResolver.collectInputImages(template.graph.videoNodeId, nodes, edges);
    const referenceAudio = graphImageResolver.collectInputAudio(template.graph.videoNodeId, nodes, edges);
    const referenceVideos = Array.isArray(videoData?.binghuoReferenceVideos)
      ? videoData.binghuoReferenceVideos.filter((source): source is string => typeof source === 'string' && Boolean(source.trim()))
      : template.pipeline.referenceVideo.map((asset) => asset.sourcePath);
    const nextPipeline = videoData ? {
      ...template.pipeline,
      prompt: typeof videoData.prompt === 'string' && videoData.prompt.trim() ? videoData.prompt : template.pipeline.prompt,
      modelId: typeof videoData.model === 'string' && videoData.model.trim() ? videoData.model : template.pipeline.modelId,
      duration: Number.isFinite(videoData.duration) ? videoData.duration : template.pipeline.duration,
      aspectRatio: typeof videoData.aspectRatio === 'string' && videoData.aspectRatio.trim() ? videoData.aspectRatio : template.pipeline.aspectRatio,
      ...(typeof videoData.resolution === 'string' && videoData.resolution.trim() ? { resolution: videoData.resolution } : {}),
      referenceImages: updateAssetRefs(template, referenceImages, 'image', 'referenceImage'),
      referenceAudio: updateAssetRefs(template, referenceAudio, 'audio', 'referenceAudio'),
      referenceVideo: updateAssetRefs(template, referenceVideos, 'video', 'referenceVideo'),
    } : template.pipeline;

    const hasNewVideo = Boolean(sourcePath && output && sourcePath !== currentSource);
    const generatedVideoRef = hasNewVideo && output ? {
      refId: crypto.randomUUID(),
      kind: 'video' as const,
      role: 'generatedVideo',
      sourcePath,
      fileName: `${template.name}-${Date.now()}.mp4`,
      required: false,
    } : null;
    const nextTemplate: Template = {
      ...template,
      updatedAt: new Date().toISOString(),
      pipeline: nextPipeline,
      ...(generatedVideoRef ? {
        assets: [...template.assets, generatedVideoRef],
        artifacts: {
          ...template.artifacts,
          coverVideo: generatedVideoRef,
          history: [...template.artifacts.history, {
            id: generatedVideoRef.refId,
            createdAt: new Date().toISOString(),
            status: 'success' as const,
            videoRef: generatedVideoRef,
          }],
        },
      } : {}),
      graph: { ...template.graph, nodes, edges, outputNodeId: output?.id ?? template.graph.outputNodeId },
    };
    persistedGraphSignature.current = graphSignature;
    setTemplate(nextTemplate);
    void browserTemplateRepository.save(nextTemplate);
  }, [edges, nodes, ready, template]);

  const flowNodes = useMemo(() => nodes, [nodes]);
  if (loading) {
    return <div className="flex h-full items-center justify-center text-sm text-text-muted"><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />{t('templatePage.loading')}</div>;
  }
  if (!template) {
    return <div className="flex h-full items-center justify-center text-sm text-text-muted">{t('templatePage.notFound')}</div>;
  }
  if (!template.graph) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 text-center text-text-muted">
        <GitBranch className="h-12 w-12 opacity-50" />
        <p className="text-text-dark">{t('templatePage.graphUnavailable')}</p>
        <Link to={`/templates/${template.id}`}><UiButton type="button" variant="muted">{t('titleBar.back')}</UiButton></Link>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full bg-bg-dark">
      <div className="absolute left-4 right-4 top-4 z-10 flex items-center justify-between gap-3 pointer-events-none">
        <UiPanel className="pointer-events-auto flex items-center gap-3 rounded-lg px-3 py-2">
          <Link to={`/templates/${template.id}`}><UiButton type="button" variant="ghost" size="sm" className="gap-2"><ArrowLeft className="h-4 w-4" />{t('titleBar.back')}</UiButton></Link>
          <div className="flex items-center gap-2 border-l border-border-dark pl-3"><GitBranch className="h-4 w-4 text-accent" /><span className="max-w-[300px] truncate text-sm font-semibold text-text-dark">{template.name}</span></div>
        </UiPanel>
        <UiPanel className="pointer-events-auto flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-text-muted"><CheckCircle2 className="h-4 w-4 text-emerald-400" />{t('templatePage.graphLive')}</UiPanel>
      </div>
      <ReactFlow
        nodes={flowNodes}
        edges={edges}
        onNodesChange={applyNodesChange}
        onEdgesChange={applyEdgesChange}
        onConnect={connectNodes}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.2, minZoom: 0.35, maxZoom: 1.2 }}
        defaultEdgeOptions={{ type: 'disconnectableEdge' }}
        minZoom={0.1}
        maxZoom={5}
        panOnDrag={[0, 1, 2]}
        panActivationKeyCode={null}
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
        className="bg-bg-dark"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#2a2a2a" />
        <MiniMap className="canvas-minimap nopan nowheel !border-border-dark !bg-surface-dark" nodeColor="rgba(120, 120, 120, 0.92)" maskColor="rgba(0, 0, 0, 0.62)" pannable zoomable />
        <Controls />
      </ReactFlow>
    </div>
  );
}
