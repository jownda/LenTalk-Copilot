import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, Download, FileJson, LoaderCircle, Save, Search, Workflow } from "lucide-react";
import { useTranslation } from "react-i18next";

import type {
  RunningHubWorkflowField,
  RunningHubWorkflowOutputKind,
} from "@/commands/runningHubWorkflow";
import { WorkflowFieldInput } from "@/features/canvas/ui/WorkflowFieldInput";

/** 编辑器里一个节点分组。`fields` 顺序沿用解析结果（按 nodeId 排过）。 */
interface EditorNodeGroup {
  nodeId: string;
  label: string;
  classType: string;
  fields: RunningHubWorkflowField[];
  primaryCount: number;
}

export interface RunningHubWorkflowEditorProps {
  open: boolean;
  onClose: () => void;

  name: string;
  onNameChange: (next: string) => void;

  providers: Array<{ id: string; name?: string }>;
  providerId: string;
  onProviderChange: (id: string) => void;
  workflowId: string;
  onWorkflowIdChange: (next: string) => void;
  onFetch: () => void;
  isFetching: boolean;

  fields: RunningHubWorkflowField[];
  nodeCount: number;
  warnings: string[];
  parseError: string | null;

  /** 粘贴 JSON 的草稿（平台拉不到的自建工作流走这条兜底）。 */
  jsonDraft: string;
  onJsonDraftChange: (next: string) => void;
  onApplyJson: () => void;
  /** 取字段当前值（素材槽会回落到上游素材，逻辑留在卡片那边，这里只负责显示）。 */
  resolveValue: (field: RunningHubWorkflowField) => string;
  onValueChange: (key: string, value: string) => void;
  onUploadMedia: (field: RunningHubWorkflowField) => void;

  outputKind: RunningHubWorkflowOutputKind;
  onOutputKindChange: (kind: RunningHubWorkflowOutputKind) => void;

  onImportFile: () => void;
  onSaveFile: () => void;
  onRun: () => void;
  isGenerating: boolean;
  error: string | null;
}

/**
 * 工作流全屏编辑器。
 *
 * 为什么要有它：卡片（420×640）里塞着 provider、工作流 ID、JSON 粘贴区和参数表单，
 * 而一个真实的 ComfyUI 工作流有几十个节点、三十多个参数 —— 卡片上只能看到「关键参数」，
 * 剩下的（采样器、步数、lora 强度…）根本改不了。全屏把**全部字段**摊开，
 * 按节点分组，左右两栏：左边挑节点，右边改参数。
 *
 * 层级 220：高于 `UiModal`(140) 与高级剪辑的覆盖层(200)，避免被它们盖住。
 * 必须 portal 到 body：画布节点树里有 `transform`，`fixed` 会退化成相对节点定位。
 */
export function RunningHubWorkflowEditor({
  open,
  onClose,
  name,
  onNameChange,
  providers,
  providerId,
  onProviderChange,
  workflowId,
  onWorkflowIdChange,
  onFetch,
  isFetching,
  fields,
  nodeCount,
  warnings,
  parseError,
  jsonDraft,
  onJsonDraftChange,
  onApplyJson,
  resolveValue,
  onValueChange,
  onUploadMedia,
  outputKind,
  onOutputKindChange,
  onImportFile,
  onSaveFile,
  onRun,
  isGenerating,
  error,
}: RunningHubWorkflowEditorProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  /** 粘贴 JSON 的折叠区：导入文件之外的第二条路（自建工作流平台拉不到）。 */
  const [isPasteOpen, setIsPasteOpen] = useState(false);

  /** 按节点聚合。编辑全部字段，所以不过滤 `primary`。 */
  const groups = useMemo<EditorNodeGroup[]>(() => {
    const ordered: EditorNodeGroup[] = [];
    const index = new Map<string, EditorNodeGroup>();
    for (const field of fields) {
      let group = index.get(field.nodeId);
      if (!group) {
        group = { nodeId: field.nodeId, label: field.nodeLabel, classType: field.classType, fields: [], primaryCount: 0 };
        index.set(field.nodeId, group);
        ordered.push(group);
      }
      group.fields.push(field);
      if (field.primary) group.primaryCount += 1;
    }
    return ordered;
  }, [fields]);

  const filteredGroups = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return groups;
    return groups.filter((group) =>
      `${group.label} ${group.classType} #${group.nodeId}`.toLowerCase().includes(keyword),
    );
  }, [groups, query]);

  // 默认选中第一个节点：空白右侧会让人以为「没东西可编辑」。
  useEffect(() => {
    if (!open) return;
    setSelectedNodeId((current) => {
      if (current && groups.some((group) => group.nodeId === current)) return current;
      return groups[0]?.nodeId ?? null;
    });
  }, [groups, open]);

  // Esc 关闭。挂在 window 的捕获阶段：画布上别的浮层可能已经 stopPropagation。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose, open]);

  const selected = useMemo(
    () => filteredGroups.find((group) => group.nodeId === selectedNodeId) ?? null,
    [filteredGroups, selectedNodeId],
  );

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[220] flex flex-col bg-[#0d0f12] text-text-dark">
      {/* ── 顶栏 ── */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-white/10 pl-2 pr-3">
        <button
          type="button"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-text-muted transition-colors hover:bg-white/10 hover:text-text-dark"
          onClick={onClose}
          title={t("node.runningHubWorkflow.editorBack")}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Workflow className="h-4 w-4 shrink-0 text-accent" />
          <input
            className="min-w-0 max-w-[420px] flex-1 truncate rounded border border-transparent bg-transparent px-1 py-0.5 text-sm font-medium text-text-dark outline-none hover:border-white/10 focus:border-accent/60"
            value={name}
            placeholder={t("node.runningHubWorkflow.editorNamePlaceholder")}
            onChange={(event) => onNameChange(event.target.value)}
          />
          <span className="shrink-0 text-[11px] tabular-nums text-text-muted">
            {t("node.runningHubWorkflow.importedSummary", { count: fields.length, nodes: nodeCount })}
          </span>
        </div>
        <button
          type="button"
          className="flex h-8 shrink-0 items-center gap-1.5 rounded border border-white/15 px-2.5 text-xs text-text-dark transition-colors hover:border-accent/60"
          onClick={onImportFile}
          title={t("node.runningHubWorkflow.editorImportHint")}
        >
          <FileJson className="h-3.5 w-3.5" />
          {t("node.runningHubWorkflow.editorImportFile")}
        </button>
        <button
          type="button"
          className="flex h-8 shrink-0 items-center gap-1.5 rounded border border-white/15 px-2.5 text-xs text-text-dark transition-colors hover:border-accent/60 disabled:opacity-50"
          disabled={!fields.length}
          onClick={onSaveFile}
          title={t("node.runningHubWorkflow.editorSaveHint")}
        >
          <Save className="h-3.5 w-3.5" />
          {t("node.runningHubWorkflow.editorSaveFile")}
        </button>
        <button
          type="button"
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
          disabled={isGenerating}
          onClick={onRun}
        >
          {isGenerating ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Workflow className="h-3.5 w-3.5" />}
          {isGenerating ? t("node.runningHubWorkflow.running") : t("node.runningHubWorkflow.run")}
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ── 左栏：连接 + 节点列表 ── */}
        <aside className="flex w-[280px] shrink-0 flex-col border-r border-white/10">
          <div className="shrink-0 space-y-2 border-b border-white/10 p-3">
            <div className="text-[10px] font-medium uppercase tracking-wide text-text-muted">
              {t("node.runningHubWorkflow.editorConnection")}
            </div>
            <select
              className="h-8 w-full rounded border border-white/12 bg-black/40 px-2 text-xs text-text-dark outline-none focus:border-accent/60"
              value={providerId}
              onChange={(event) => onProviderChange(event.target.value)}
            >
              {providers.length === 0 ? <option value="">{t("node.runningHubWorkflow.noProvider")}</option> : null}
              {providers.map((api) => (
                <option key={api.id} value={api.id}>
                  {api.name || api.id}
                </option>
              ))}
            </select>
            <div className="flex gap-1.5">
              <input
                className="h-8 min-w-0 flex-1 rounded border border-white/12 bg-black/40 px-2 text-xs text-text-dark outline-none focus:border-accent/60"
                placeholder={t("node.runningHubWorkflow.workflowIdPlaceholder")}
                value={workflowId}
                onChange={(event) => onWorkflowIdChange(event.target.value)}
              />
              <button
                type="button"
                className="flex h-8 shrink-0 items-center gap-1 rounded border border-white/15 px-2 text-[11px] text-text-dark transition-colors hover:border-accent/60 disabled:opacity-50"
                disabled={isFetching}
                onClick={onFetch}
                title={t("node.runningHubWorkflow.fetchHint")}
              >
                {isFetching ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                {t("node.runningHubWorkflow.fetch")}
              </button>
            </div>

            {/* 粘贴 JSON：拉不到时就手动喂一份 API 格式的工作流。 */}
            <button
              type="button"
              className="flex w-full items-center justify-between rounded border border-dashed border-white/12 px-2 py-1 text-[10px] text-text-muted transition-colors hover:border-accent/60 hover:text-text-dark"
              onClick={() => setIsPasteOpen((previous) => !previous)}
            >
              <span>{t("node.runningHubWorkflow.editorPasteJson")}</span>
              <ChevronLeft
                className={`h-3 w-3 transition-transform ${isPasteOpen ? "rotate-90" : "-rotate-90"}`}
              />
            </button>
            {isPasteOpen ? (
              <div className="flex flex-col gap-1.5">
                <textarea
                  className="nodrag nowheel h-28 w-full resize-none rounded border border-white/12 bg-black/40 p-2 text-[11px] leading-4 text-text-dark outline-none placeholder:text-text-muted/60 focus:border-accent/60"
                  placeholder={t("node.runningHubWorkflow.jsonPlaceholder")}
                  value={jsonDraft}
                  onChange={(event) => onJsonDraftChange(event.target.value)}
                />
                <button
                  type="button"
                  className="h-7 rounded border border-white/15 text-[11px] text-text-dark transition-colors hover:border-accent/60"
                  onClick={() => {
                    onApplyJson();
                    setIsPasteOpen(false);
                  }}
                >
                  {t("node.runningHubWorkflow.parseJson")}
                </button>
              </div>
            ) : null}
          </div>

          <div className="shrink-0 px-3 pt-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted/60" />
              <input
                className="h-8 w-full rounded border border-white/12 bg-black/40 pl-7 pr-2 text-xs text-text-dark outline-none placeholder:text-text-muted/60 focus:border-accent/60"
                placeholder={t("node.runningHubWorkflow.editorSearch")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          </div>

          <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto p-2">
            {filteredGroups.length === 0 ? (
              <p className="px-2 py-3 text-[11px] leading-5 text-text-muted/70">
                {fields.length ? t("node.runningHubWorkflow.editorNoMatch") : t("node.runningHubWorkflow.emptyHint")}
              </p>
            ) : (
              filteredGroups.map((group) => {
                const isActive = group.nodeId === selectedNodeId;
                return (
                  <button
                    key={group.nodeId}
                    type="button"
                    className={`mb-1 flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left transition-colors ${
                      isActive
                        ? "border-accent/60 bg-accent/15"
                        : "border-transparent hover:border-white/10 hover:bg-white/[0.04]"
                    }`}
                    onClick={() => setSelectedNodeId(group.nodeId)}
                  >
                    <span className="mt-0.5 shrink-0 text-[10px] tabular-nums text-text-muted/70">#{group.nodeId}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] text-text-dark">{group.label}</span>
                      <span className="block truncate text-[10px] text-text-muted/70">
                        {group.classType} · {group.fields.length}
                        {group.primaryCount ? " ★" : ""}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>

          <div className="shrink-0 border-t border-white/10 p-3">
            <div className="mb-1 text-[10px] text-text-muted">{t("node.runningHubWorkflow.outputKindHint")}</div>
            <select
              className="h-8 w-full rounded border border-white/12 bg-black/40 px-2 text-xs text-text-dark outline-none focus:border-accent/60"
              value={outputKind}
              onChange={(event) => onOutputKindChange(event.target.value as RunningHubWorkflowOutputKind)}
            >
              <option value="image">{t("node.runningHubWorkflow.outputImage")}</option>
              <option value="video">{t("node.runningHubWorkflow.outputVideo")}</option>
              <option value="audio">{t("node.runningHubWorkflow.outputAudio")}</option>
            </select>
          </div>
        </aside>

        {/* ── 右栏：选中节点的全部字段 ── */}
        <section className="flex min-w-0 flex-1 flex-col">
          {parseError ? (
            <div className="m-3 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-300">
              {parseError}
            </div>
          ) : null}
          {warnings.length ? (
            <div className="mx-3 mt-3 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-5 text-amber-300">
              {warnings.join("；")}
            </div>
          ) : null}
          {error ? (
            <div className="mx-3 mt-3 max-h-24 overflow-auto rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] leading-5 text-red-300">
              {error}
            </div>
          ) : null}

          <div className="shrink-0 border-b border-white/10 px-4 py-2.5">
            {selected ? (
              <div className="flex items-baseline gap-2">
                <span className="truncate text-sm text-text-dark">{selected.label}</span>
                <span className="shrink-0 text-[11px] text-text-muted">
                  #{selected.nodeId} · {selected.classType} ·{" "}
                  {t("node.runningHubWorkflow.editorFieldCount", { count: selected.fields.length })}
                </span>
              </div>
            ) : (
              <span className="text-xs text-text-muted">{t("node.runningHubWorkflow.editorNoSelection")}</span>
            )}
          </div>

          <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
            {selected ? (
              <div className="grid grid-cols-1 gap-x-4 gap-y-3 lg:grid-cols-2 2xl:grid-cols-3">
                {selected.fields.map((field) => (
                  <div
                    key={field.key}
                    className={field.control === "textarea" ? "lg:col-span-2 2xl:col-span-3" : undefined}
                  >
                    <WorkflowFieldInput
                      field={field}
                      value={resolveValue(field)}
                      onChange={(next) => onValueChange(field.key, next)}
                      onUpload={() => onUploadMedia(field)}
                    />
                    {field.primary ? (
                      <span className="mt-0.5 inline-block text-[9px] text-accent/70">
                        {t("node.runningHubWorkflow.editorPrimaryTag")}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs leading-6 text-text-muted/70">{t("node.runningHubWorkflow.editorNoSelection")}</p>
            )}
          </div>
        </section>
      </div>
    </div>,
    document.body,
  );
}
