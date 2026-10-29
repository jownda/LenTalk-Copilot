import { memo, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Handle, Position, type NodeProps, useUpdateNodeInternals } from "@xyflow/react";
import { ChevronRight, FileJson, LoaderCircle, Save, Workflow } from "lucide-react";
import { open as openNativeFile, save as saveNativeFile } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";

import { CANVAS_NODE_TYPES, type RunningHubWorkflowNodeData } from "@/features/canvas/domain/canvasNodes";
import { resolveNodeDisplayName } from "@/features/canvas/domain/nodeDisplay";
import { canvasAiGateway, graphImageResolver } from "@/features/canvas/application/canvasServices";
import { useCanvasInputGraph } from "@/features/canvas/application/useCanvasInputGraph";
import { persistNodeMediaFile } from "@/features/canvas/application/nodeMediaUpload";
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from "@/features/canvas/ui/NodeHeader";
import { NodeResizeHandle } from "@/features/canvas/ui/NodeResizeHandle";
import { showErrorDialog } from "@/features/canvas/application/errorDialog";
import { WorkflowFieldInput } from "@/features/canvas/ui/WorkflowFieldInput";
import { ACCEPT_BY_CONTROL, isMediaControl } from "@/features/canvas/application/workflowFieldMedia";
import { RunningHubWorkflowEditor } from "@/features/canvas/ui/RunningHubWorkflowEditor";
import { readTextFile, writeTextFile } from "@/commands/textFile";
import { useCanvasStore } from "@/stores/canvasStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { isRunningHubBaseUrl } from "@/commands/runningHubProtocol";
import {
  buildRunningHubWorkflowNodeInfoList,
  extractRunningHubWorkflowId,
  parseRunningHubWorkflow,
  type RunningHubWorkflowField,
  type RunningHubWorkflowOutputKind,
} from "@/commands/runningHubWorkflow";

type RunningHubWorkflowNodeProps = NodeProps & {
  id: string;
  data: RunningHubWorkflowNodeData;
  selected?: boolean;
  width?: number;
  height?: number;
};



/** 按节点分组的表单结构。 */
interface FieldGroup {
  nodeId: string;
  nodeLabel: string;
  classType: string;
  fields: RunningHubWorkflowField[];
  hasPrimary: boolean;
}

export const RunningHubWorkflowNode = memo(({ id, data, selected, width, height }: RunningHubWorkflowNodeProps) => {
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
  const [uploadFieldKey, setUploadFieldKey] = useState<string | null>(null);
  const [uploadControl, setUploadControl] = useState<"image" | "video" | "audio" | null>(null);
  const [isGenerating, setIsGenerating] = useState(Boolean(data.isGenerating));
  const [error, setError] = useState<string | null>(data.generationError ?? null);
  /** JSON 导入区：没有导入过时默认展开。 */
  const [isImportOpen, setIsImportOpen] = useState(!data.workflowJson);
  const [jsonDraft, setJsonDraft] = useState(data.workflowJson ?? "");
  const [isFetching, setIsFetching] = useState(false);
  /** 全屏编辑器：卡片只放关键参数，其余（几十个节点的全部字段）在编辑器里改。 */
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  /** 导入文件的瞬态提示：读文件/解析失败要说清楚哪一步错了。 */
  const [fileBusy, setFileBusy] = useState(false);

  const inputImages = useMemo(() => graphImageResolver.collectInputImages(id, nodes, edges), [edges, id, nodes]);
  const inputVideos = useMemo(() => graphImageResolver.collectInputVideos(id, nodes, edges), [edges, id, nodes]);
  const inputAudios = useMemo(() => graphImageResolver.collectInputAudio(id, nodes, edges), [edges, id, nodes]);

  const runningHubProviders = useMemo(
    () => customApis.filter((api) => isRunningHubBaseUrl(api.baseUrl)),
    [customApis],
  );
  const storedProviderId = typeof data.providerId === "string" ? data.providerId : "";
  const providerId = runningHubProviders.some((api) => api.id === storedProviderId)
    ? storedProviderId
    : (runningHubProviders[0]?.id ?? "");
  const providerBaseUrl = runningHubProviders.find((api) => api.id === providerId)?.baseUrl ?? "";
  const workflowId = typeof data.workflowId === "string" ? data.workflowId : "";

  /**
   * 解析结果只走 `useMemo`，不落盘。
   *
   * 节点数据里只存 JSON 原文 —— 存一份解析缓存会出现「JSON 换了、表单还是旧的」，
   * 而重新解析几十个节点本来就只有毫秒级开销。
   */
  const parsed = useMemo(() => {
    const json = (data.workflowJson ?? "").trim();
    if (!json) return { schema: null as ReturnType<typeof parseRunningHubWorkflow> | null, error: null as string | null };
    try {
      return { schema: parseRunningHubWorkflow(json), error: null as string | null };
    } catch (parseError) {
      return {
        schema: null,
        error: parseError instanceof Error ? parseError.message : String(parseError),
      };
    }
  }, [data.workflowJson]);

  const fields = useMemo(() => parsed.schema?.fields ?? [], [parsed.schema]);
  const outputKind: RunningHubWorkflowOutputKind =
    data.workflowOutputKind ?? parsed.schema?.outputKind ?? "video";

  const values = useMemo(() => data.workflowValues ?? {}, [data.workflowValues]);

  /**
   * 素材槽按「同类型第 N 个」对接上游素材：工作流里有两个 LoadImage 时，第 1/2 个槽
   * 分别吃上游的第 1/2 张图。用户手动传过的槽优先，不会被打断。
   */
  const upstreamMediaByField = useMemo(() => {
    const counters: Record<"image" | "video" | "audio", number> = { image: 0, video: 0, audio: 0 };
    const pools = { image: inputImages, video: inputVideos, audio: inputAudios };
    const mapping = new Map<string, string>();
    for (const field of fields) {
      if (!isMediaControl(field.control)) continue;
      const index = counters[field.control]++;
      const upstream = pools[field.control][index];
      if (upstream) mapping.set(field.key, upstream);
    }
    return mapping;
  }, [fields, inputAudios, inputImages, inputVideos]);

  /**
   * 取字段的当前值。
   *
   * 素材字段**不回落到 JSON 默认值** —— 那里的值（如 `example.png`）是平台作者的示例
   * 文件，发过去只会让任务在平台侧下载失败，不如当面提示"请上传素材"。
   */
  const valueOf = useCallback(
    (field: RunningHubWorkflowField): string => {
      const own = values[field.key];
      if (typeof own === "string" && own !== "") return own;
      if (isMediaControl(field.control)) return upstreamMediaByField.get(field.key) ?? "";
      return field.defaultValue;
    },
    [upstreamMediaByField, values],
  );

  /**
   * 卡片只渲染**关键参数**（提示词 / 素材 / 种子）。
   *
   * 一个真实工作流有三十多个可填项，全摊在 420px 宽的卡片里会把真正要改的淹没掉。
   * 其余字段不丢 —— 点卡片上的工作流名字进全屏编辑器，那里按节点列出全部。
   */
  const primaryGroups = useMemo<FieldGroup[]>(() => {
    const ordered: FieldGroup[] = [];
    const indexByNode = new Map<string, FieldGroup>();
    for (const field of fields) {
      if (!field.primary) continue;
      let group = indexByNode.get(field.nodeId);
      if (!group) {
        group = {
          nodeId: field.nodeId,
          nodeLabel: field.nodeLabel,
          classType: field.classType,
          fields: [],
          hasPrimary: true,
        };
        indexByNode.set(field.nodeId, group);
        ordered.push(group);
      }
      group.fields.push(field);
    }
    return ordered;
  }, [fields]);

  /** 卡片上没显示、只在编辑器里能改的参数个数。 */
  const hiddenFieldCount = useMemo(() => fields.filter((field) => !field.primary).length, [fields]);

  const setValue = useCallback(
    (key: string, value: string) => {
      updateNodeData(id, { workflowValues: { ...values, [key]: value } });
    },
    [id, updateNodeData, values],
  );

  const openUpload = useCallback((field: RunningHubWorkflowField) => {
    if (!isMediaControl(field.control)) return;
    setUploadFieldKey(field.key);
    setUploadControl(field.control);
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      const key = uploadFieldKey;
      event.target.value = "";
      if (!file || !key) return;
      try {
        const source = await persistNodeMediaFile(file);
        setValue(key, source);
        setError(null);
      } catch (uploadError) {
        const message = uploadError instanceof Error ? uploadError.message : String(uploadError);
        setError(message);
        void showErrorDialog(message, t("common.error"));
      } finally {
        setUploadFieldKey(null);
        setUploadControl(null);
      }
    },
    [setValue, t, uploadFieldKey],
  );

  /** 应用 JSON：先解析验证，能过才写入节点 —— 粘错的 JSON 不该覆盖已有配置。 */
  const handleApplyJson = useCallback(() => {
    const text = jsonDraft.trim();
    if (!text) return;
    try {
      const schema = parseRunningHubWorkflow(text);
      updateNodeData(id, { workflowJson: text, workflowOutputKind: schema.outputKind });
      setError(null);
      setIsImportOpen(false);
    } catch (parseError) {
      const message = parseError instanceof Error ? parseError.message : String(parseError);
      setError(message);
    }
  }, [id, jsonDraft, updateNodeData]);

  /**
   * 按工作流 ID 从平台拉取 JSON。
   *
   * 走 `POST /api/openapi/getJsonApiFormat`（未写进公开文档，但确实存在）——
   * 有了它，「导入工作流」就不需要用户先去 ComfyUI 导出文件再粘进来；
   * 粘贴 JSON 的入口保留，用于平台拉不到的自建工作流。
   */
  const handleFetch = useCallback(async () => {
    if (!workflowId) return setError(t("node.runningHubWorkflow.needWorkflowId"));
    if (!providerId) return setError(t("node.runningHubWorkflow.needProvider"));
    const providerKey = apiKeys[`custom:${providerId}`] ?? "";
    if (!providerKey.trim()) return setError(t("node.imageEdit.apiKeyRequired"));
    setIsFetching(true);
    setError(null);
    try {
      const json = await canvasAiGateway.inspectRunningHubWorkflow({
        model: `custom:${providerId}/runninghub-workflow`,
        workflowId,
        extraParams: { provider_base_url: providerBaseUrl },
      });
      // 拉到就立刻验证：坏数据在这里报错，比等用户点「运行」才失败要好。
      const schema = parseRunningHubWorkflow(json);
      updateNodeData(id, { workflowJson: json, workflowOutputKind: schema.outputKind });
      setJsonDraft(json);
      setIsImportOpen(false);
    } catch (fetchError) {
      const message = fetchError instanceof Error ? fetchError.message : String(fetchError);
      setError(message);
    } finally {
      setIsFetching(false);
    }
  }, [apiKeys, id, providerBaseUrl, providerId, t, updateNodeData, workflowId]);

  const handleWorkflowIdChange = useCallback(
    (raw: string) => {
      // 直接粘平台链接时自动截出数字 ID —— 手抄一串 19 位数字很容易错一位。
      const extracted = extractRunningHubWorkflowId(raw);
      updateNodeData(id, { workflowId: extracted || raw });
    },
    [id, updateNodeData],
  );

  /** 卡片上显示的工作流名字：用户起的名 > 工作流 ID > 未命名。 */
  const workflowTitle =
    (typeof data.workflowName === "string" && data.workflowName.trim()) ||
    (workflowId ? `${t("node.runningHubWorkflow.editorWorkflowPrefix")} ${workflowId}` : "");

  /**
   * 从本地 .json 文件导入工作流。
   *
   * 先解析验证再写入 —— 和粘贴 JSON 一样的规矩：坏的输入不该覆盖已有配置。
   * 文件名顺手当作工作流名字，省得用户再起一遍。
   */
  const handleImportFile = useCallback(async () => {
    setFileBusy(true);
    try {
      const picked = await openNativeFile({
        multiple: false,
        filters: [{ name: t("node.runningHubWorkflow.editorJsonFilter"), extensions: ["json"] }],
      });
      if (!picked || Array.isArray(picked)) return;
      const text = await readTextFile(picked);
      const schema = parseRunningHubWorkflow(text);
      const baseName = picked.split(/[\\/]/).pop()?.replace(/\.json$/i, "") ?? "";
      updateNodeData(id, {
        workflowJson: text,
        workflowOutputKind: schema.outputKind,
        ...(baseName ? { workflowName: baseName } : {}),
      });
      setJsonDraft(text);
      setError(null);
    } catch (importError) {
      const message = importError instanceof Error ? importError.message : String(importError);
      setError(message);
      void showErrorDialog(message, t("common.error"));
    } finally {
      setFileBusy(false);
    }
  }, [id, t, updateNodeData]);

  /** 把当前工作流 JSON 存成文件（备份 / 分享 / 换机器）。 */
  const handleSaveFile = useCallback(async () => {
    const json = (data.workflowJson ?? "").trim();
    if (!json) return setError(t("node.runningHubWorkflow.needJson"));
    try {
      const target = await saveNativeFile({
        title: t("node.runningHubWorkflow.editorSaveFile"),
        defaultPath: `${workflowTitle || "workflow"}.json`,
        filters: [{ name: t("node.runningHubWorkflow.editorJsonFilter"), extensions: ["json"] }],
      });
      if (!target || Array.isArray(target)) return;
      await writeTextFile(target, json);
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : String(saveError);
      setError(message);
      void showErrorDialog(message, t("common.error"));
    }
  }, [data.workflowJson, t, workflowTitle]);

  const handleRun = useCallback(async () => {
    setError(null);
    if (!parsed.schema) return setError(t("node.runningHubWorkflow.needJson"));
    if (!workflowId) return setError(t("node.runningHubWorkflow.needWorkflowId"));
    if (!providerId) return setError(t("node.runningHubWorkflow.needProvider"));
    const providerKey = apiKeys[`custom:${providerId}`] ?? "";
    if (!providerKey.trim()) return setError(t("node.imageEdit.apiKeyRequired"));

    const resolvedValues: Record<string, string> = {};
    const missingMedia: string[] = [];
    for (const field of parsed.schema.fields) {
      const value = valueOf(field);
      if (isMediaControl(field.control) && !value.trim()) missingMedia.push(field.inputName);
      resolvedValues[field.key] = value;
    }
    if (missingMedia.length) {
      return setError(
        t("node.runningHubWorkflow.needMedia", { fields: Array.from(new Set(missingMedia)).join(" / ") }),
      );
    }

    const modelId = `custom:${providerId}/runninghub-workflow`;
    const nodeInfoList = buildRunningHubWorkflowNodeInfoList(parsed.schema.fields, resolvedValues);
    const outputId = addNode(CANVAS_NODE_TYPES.audio, findNodePosition(id, 420, 320), {
      displayName: resolveNodeDisplayName(CANVAS_NODE_TYPES.runningHubWorkflow, data),
      mediaType: outputKind,
      sourcePath: null,
      aspectRatio: "16:9",
      isGenerating: true,
      generationStartedAt: Date.now(),
      generationProviderId: `custom:${providerId}`,
      generationModel: modelId,
      providerBaseUrl: providerBaseUrl || null,
    });
    addEdge(id, outputId);
    setIsGenerating(true);
    updateNodeData(id, { isGenerating: true, generationError: null });

    try {
      const outputUrl = await canvasAiGateway.runRunningHubWorkflow({
        model: modelId,
        workflowId,
        nodeInfoList,
        outputKind,
        extraParams: { provider_base_url: providerBaseUrl },
      });
      updateNodeData(outputId, {
        sourcePath: outputUrl,
        isGenerating: false,
        generationResultProtected: true,
      });
      updateNodeData(id, { isGenerating: false, outputUrl });
    } catch (generationError) {
      const message = generationError instanceof Error ? generationError.message : String(generationError);
      setError(message);
      updateNodeData(outputId, { isGenerating: false, generationError: message, generationErrorDetails: message });
      updateNodeData(id, { isGenerating: false, generationError: message });
      void showErrorDialog(message, t("node.runningHubWorkflow.runFailed"));
    } finally {
      setIsGenerating(false);
    }
  }, [
    addEdge,
    addNode,
    apiKeys,
    data,
    findNodePosition,
    id,
    outputKind,
    parsed.schema,
    providerBaseUrl,
    providerId,
    t,
    updateNodeData,
    valueOf,
    workflowId,
  ]);

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, isImportOpen, updateNodeInternals]);

  const resolvedWidth = Math.max(360, Math.round(width ?? 420));
  const resolvedHeight = Math.max(520, Math.round(height ?? 640));

  return (
    <div
      className={`relative flex h-full flex-col gap-2 rounded-xl border bg-surface-dark p-3 text-text-dark shadow-lg ${selected ? "border-accent/70 ring-1 ring-accent/30" : "border-border-dark"} [&>*]:shrink-0`}
      style={{ width: resolvedWidth, height: resolvedHeight }}
    >
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<Workflow className="h-4 w-4" />}
        titleText={resolveNodeDisplayName(CANVAS_NODE_TYPES.runningHubWorkflow, data)}
        editable
        onTitleChange={(displayName) => updateNodeData(id, { displayName })}
      />
      <Handle
        type="target"
        position={Position.Left}
        id="target"
        className="!h-3 !w-3 !border-2 !border-surface-dark !bg-accent"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="source"
        className="!h-3 !w-3 !border-2 !border-surface-dark !bg-accent"
      />

      {/* 工作流名字：点它进全屏编辑器（导入 / 全部参数 / 连接配置都在那边）。 */}
      <div className="mt-7">
        <button
          type="button"
          className="nodrag group flex w-full items-center gap-1.5 rounded-md border border-border-dark bg-bg-dark/60 px-2 py-2 text-left transition-colors hover:border-accent/60"
          onClick={(event) => {
            event.stopPropagation();
            setJsonDraft(data.workflowJson ?? "");
            setIsEditorOpen(true);
          }}
          onMouseDown={(event) => event.stopPropagation()}
          title={t("node.runningHubWorkflow.editorOpenHint")}
        >
          <Workflow className="h-4 w-4 shrink-0 text-accent" />
          <span
            className={`min-w-0 flex-1 truncate text-xs ${
              workflowTitle ? "font-medium text-text-dark" : "text-text-muted"
            }`}
          >
            {workflowTitle || t("node.runningHubWorkflow.editorImportPrompt")}
          </span>
          {fields.length ? (
            <span className="shrink-0 text-[10px] tabular-nums text-text-muted/70">
              {t("node.runningHubWorkflow.editorFieldShort", { count: fields.length })}
            </span>
          ) : null}
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted group-hover:text-text-dark" />
        </button>
      </div>

      {/* 导入 / 保存：文件进出都在卡片上一级可见，不用先进编辑器 */}
      <div className="flex gap-1.5">
        <button
          type="button"
          className="nodrag flex h-7 flex-1 items-center justify-center gap-1 rounded border border-border-dark text-[11px] text-text-dark transition-colors hover:border-accent/60 disabled:opacity-50"
          disabled={fileBusy}
          onClick={(event) => {
            event.stopPropagation();
            void handleImportFile();
          }}
          onMouseDown={(event) => event.stopPropagation()}
          title={t("node.runningHubWorkflow.editorImportHint")}
        >
          {fileBusy ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <FileJson className="h-3 w-3" />}
          {t("node.runningHubWorkflow.editorImportFile")}
        </button>
        <button
          type="button"
          className="nodrag flex h-7 flex-1 items-center justify-center gap-1 rounded border border-border-dark text-[11px] text-text-dark transition-colors hover:border-accent/60 disabled:opacity-50"
          disabled={!data.workflowJson}
          onClick={(event) => {
            event.stopPropagation();
            void handleSaveFile();
          }}
          onMouseDown={(event) => event.stopPropagation()}
          title={t("node.runningHubWorkflow.editorSaveHint")}
        >
          <Save className="h-3 w-3" />
          {t("node.runningHubWorkflow.editorSaveFile")}
        </button>
      </div>

      {parsed.error ? (
        <div className="rounded bg-red-500/10 px-2 py-1 text-[10px] leading-4 text-red-300">{parsed.error}</div>
      ) : null}
      {parsed.schema && parsed.schema.warnings.length ? (
        <div className="rounded bg-amber-500/10 px-2 py-1 text-[10px] leading-4 text-amber-300">
          {parsed.schema.warnings.join("；")}
        </div>
      ) : null}

      {/* 关键参数：唯一吸收尺寸的区域，拉高卡片能一次看到更多。 */}
      <div className="ui-scrollbar flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-1">
        {primaryGroups.length === 0 ? (
          <button
            type="button"
            className="nodrag flex flex-1 items-center justify-center rounded-md border border-dashed border-border-dark px-2 text-center text-[11px] leading-5 text-text-muted transition-colors hover:border-accent/60 hover:text-text-dark"
            onClick={(event) => {
              event.stopPropagation();
              setJsonDraft(data.workflowJson ?? "");
              setIsEditorOpen(true);
            }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            {t("node.runningHubWorkflow.emptyHint")}
          </button>
        ) : (
          <>
            {primaryGroups.map((group) => (
              <div key={group.nodeId} className="rounded-md border border-border-dark bg-bg-dark/40 p-2">
                <div className="mb-1.5 flex items-baseline gap-1">
                  <span className="truncate text-[11px] text-text-dark">{group.nodeLabel}</span>
                  <span className="ml-auto shrink-0 text-[9px] tabular-nums text-text-muted/70">#{group.nodeId}</span>
                </div>
                <div className="flex flex-col gap-2">
                  {group.fields.map((field) => (
                    <WorkflowFieldInput
                      key={field.key}
                      field={field}
                      value={valueOf(field)}
                      onChange={(next) => setValue(field.key, next)}
                      onUpload={() => openUpload(field)}
                      dense
                    />
                  ))}
                </div>
              </div>
            ))}
            {hiddenFieldCount > 0 ? (
              <button
                type="button"
                className="nodrag flex h-6 shrink-0 items-center justify-center gap-1 rounded border border-dashed border-border-dark text-[10px] text-text-muted transition-colors hover:border-accent/60 hover:text-text-dark"
                onClick={(event) => {
                  event.stopPropagation();
                  setJsonDraft(data.workflowJson ?? "");
                  setIsEditorOpen(true);
                }}
                onMouseDown={(event) => event.stopPropagation()}
              >
                {t("node.runningHubWorkflow.editorMoreFields", { count: hiddenFieldCount })}
              </button>
            ) : null}
          </>
        )}
      </div>

      {error ? (
        <div className="max-h-14 overflow-auto rounded bg-red-500/10 px-2 py-1 text-[10px] leading-4 text-red-300">
          {error}
        </div>
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        accept={uploadControl ? ACCEPT_BY_CONTROL[uploadControl] : undefined}
        className="hidden"
        onChange={handleFileChange}
      />

      <div className="flex items-center gap-2">
        <select
          className="nodrag h-8 w-[92px] shrink-0 rounded border border-border-dark bg-bg-dark px-1.5 text-[11px] text-text-dark"
          value={outputKind}
          onChange={(event) =>
            updateNodeData(id, { workflowOutputKind: event.target.value as RunningHubWorkflowOutputKind })
          }
          onMouseDown={(event) => event.stopPropagation()}
          title={t("node.runningHubWorkflow.outputKindHint")}
        >
          <option value="image">{t("node.runningHubWorkflow.outputImage")}</option>
          <option value="video">{t("node.runningHubWorkflow.outputVideo")}</option>
          <option value="audio">{t("node.runningHubWorkflow.outputAudio")}</option>
        </select>
        <button
          type="button"
          className="nodrag flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          disabled={isGenerating}
          onClick={(event) => {
            event.stopPropagation();
            void handleRun();
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {isGenerating ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Workflow className="h-3.5 w-3.5" />}
          {isGenerating ? t("node.runningHubWorkflow.running") : t("node.runningHubWorkflow.run")}
        </button>
      </div>

      <NodeResizeHandle minWidth={360} minHeight={520} maxWidth={760} maxHeight={1100} />

      {/* 全屏编辑器自己 portal 到 body，放在这里只是为了让状态和回调就近可达。 */}
      <RunningHubWorkflowEditor
        open={isEditorOpen}
        onClose={() => setIsEditorOpen(false)}
        name={workflowTitle}
        onNameChange={(next) => updateNodeData(id, { workflowName: next })}
        providers={runningHubProviders}
        providerId={providerId}
        onProviderChange={(next) => updateNodeData(id, { providerId: next })}
        workflowId={workflowId}
        onWorkflowIdChange={handleWorkflowIdChange}
        onFetch={() => void handleFetch()}
        isFetching={isFetching}
        fields={fields}
        nodeCount={parsed.schema?.nodeCount ?? 0}
        warnings={parsed.schema?.warnings ?? []}
        parseError={parsed.error}
        jsonDraft={jsonDraft}
        onJsonDraftChange={setJsonDraft}
        onApplyJson={handleApplyJson}
        resolveValue={valueOf}
        onValueChange={setValue}
        onUploadMedia={openUpload}
        outputKind={outputKind}
        onOutputKindChange={(next) => updateNodeData(id, { workflowOutputKind: next })}
        onImportFile={() => void handleImportFile()}
        onSaveFile={() => void handleSaveFile()}
        onRun={() => void handleRun()}
        isGenerating={isGenerating}
        error={error}
      />
    </div>
  );
});

RunningHubWorkflowNode.displayName = "RunningHubWorkflowNode";
