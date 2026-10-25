import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Check, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { CanvasNode, CanvasNodeType } from "@/features/canvas/domain/canvasNodes";
import { resolveNodeDisplayName } from "@/features/canvas/domain/nodeDisplay";
import {
  buildNodeProperties,
  serializeNodeProperties,
  type MediaProbe,
  type NodeMediaKind,
  type NodePropertyRow,
  type UpstreamGenerationSource,
} from "@/features/canvas/application/nodeProperties";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import {
  listAudioModels,
  listImageModels,
  listModelProviders,
  listVideoModels,
} from "@/features/canvas/models/registry";
import { buildCustomProviderId, useSettingsStore } from "@/stores/settingsStore";
import { UiButton, UiModal } from "@/components/ui";

interface NodePropertiesDialogProps {
  /** 打开中的节点;为 null 表示关闭。 */
  node: CanvasNode | null;
  mediaKind: NodeMediaKind | null;
  mediaUrl: string | null;
  /** 上游生成节点: 结果节点自身没有生成记录时从这里取平台/模型/提示词。 */
  upstream?: UpstreamGenerationSource | null;
  onClose: () => void;
}

/** 复制反馈的延时复位计时器。组件卸载时必须清掉,否则会对已卸载组件 setState。 */
interface CopyFeedbackState {
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * 探测媒体本体信息:图片取原始像素尺寸,音视频取尺寸/时长。
 *
 * 这里刻意不复用节点自身已经渲染的 <video>/<img> —— 节点可能已卸载(画布只渲染视口内
 * 元素),也可能显示的是缩略图而不是原图。属性面板要的是**原始文件**的真实参数。
 */
function useMediaProbe(
  mediaKind: NodeMediaKind | null,
  mediaUrl: string | null,
): MediaProbe | null {
  const [probe, setProbe] = useState<MediaProbe | null>(null);

  useEffect(() => {
    setProbe(null);
    const source = mediaUrl?.trim();
    if (!source || !mediaKind) {
      return;
    }

    let disposed = false;
    const displaySource = resolveImageDisplayUrl(source);

    if (mediaKind === "image") {
      const image = new Image();
      const applyDimensions = () => {
        if (!disposed && image.naturalWidth > 0 && image.naturalHeight > 0) {
          setProbe({ width: image.naturalWidth, height: image.naturalHeight });
        }
      };
      image.onload = applyDimensions;
      image.src = displaySource;
      // 命中缓存时 onload 可能不会补发,此时 complete 已为 true,直接取一次尺寸。
      if (image.complete) {
        applyDimensions();
      }
      return () => {
        disposed = true;
        image.onload = null;
        image.onerror = null;
      };
    }

    // 音视频都靠 loadedmetadata: 只读头部,不下载整段,也不触发解码/播放。
    const element = document.createElement(mediaKind === "video" ? "video" : "audio");
    element.preload = "metadata";
    element.muted = true;
    const handleLoaded = () => {
      if (disposed) {
        return;
      }
      const next: MediaProbe = {};
      if (mediaKind === "video") {
        const video = element as HTMLVideoElement;
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          next.width = video.videoWidth;
          next.height = video.videoHeight;
        }
      }
      // 流式/损坏文件会给出 NaN 或 Infinity,必须挡掉,否则会显示成 `NaN:NaN`。
      if (Number.isFinite(element.duration) && element.duration > 0) {
        next.durationSeconds = element.duration;
      }
      setProbe(next);
    };
    element.addEventListener("loadedmetadata", handleLoaded);
    element.src = displaySource;
    element.load();

    return () => {
      disposed = true;
      element.removeEventListener("loadedmetadata", handleLoaded);
      // 立刻断开加载,避免关闭面板后还在后台拖流媒体。
      element.removeAttribute("src");
      element.load();
    };
  }, [mediaKind, mediaUrl]);

  return probe;
}

/** 文件体积由 Rust 侧读取,绕过前端 fetch 的 CORS 限制(与节点悬停标注同一条命令)。 */
function useMediaByteSizeProbe(mediaUrl: string | null): number | null {
  const [bytes, setBytes] = useState<number | null>(null);

  useEffect(() => {
    setBytes(null);
    const source = mediaUrl?.trim();
    if (!source || !isTauri()) {
      return;
    }

    let disposed = false;
    void invoke<number>("resolve_media_file_size", { source })
      .then((value) => {
        if (!disposed && typeof value === "number" && Number.isFinite(value) && value > 0) {
          setBytes(value);
        }
      })
      .catch(() => {
        // 体积属于附加信息:远程地址拒绝探测(签名过期/防盗链)时静默降级,不影响其它字段。
      });

    return () => {
      disposed = true;
    };
  }, [mediaUrl]);

  return bytes;
}

/**
 * providerId → 平台显示名 / 接口地址。
 *
 * 自定义平台的名字只有设置里才有,内置平台走模型注册表。节点里存的是生成当时的
 * providerId,平台后来被改名或删除也必须照原样显示,所以查不到就退回原始 id。
 */
function useProviderLookup() {
  const customApis = useSettingsStore((state) => state.customApis);

  return useMemo(() => {
    const customBaseUrls = new Map<string, { name: string; baseUrl: string }>();
    for (const api of customApis) {
      customBaseUrls.set(buildCustomProviderId(api.id), { name: api.name, baseUrl: api.baseUrl });
    }

    let builtinLabels: Map<string, string> | null = null;
    const resolveBuiltinLabel = (providerId: string): string | null => {
      if (!builtinLabels) {
        try {
          builtinLabels = new Map(
            listModelProviders().map((provider) => [provider.id, provider.label || provider.name]),
          );
        } catch {
          builtinLabels = new Map();
        }
      }
      return builtinLabels.get(providerId) ?? null;
    };

    return {
      label: (providerId: string) =>
        customBaseUrls.get(providerId)?.name ?? resolveBuiltinLabel(providerId),
      baseUrl: (providerId: string) => customBaseUrls.get(providerId)?.baseUrl ?? null,
    };
  }, [customApis]);
}

/**
 * 模型 id → providerId。
 *
 * 结果节点在生成完成时会被清掉平台字段, 这时唯一还能确定平台的就是上游节点上记的
 * 「选了哪个模型」。按注册表反查一次即可还原平台(如 `doubao-seedance-2.5` → 炳火)。
 * 三张表都查: 图片/视频/音频的模型名可能重名, 先命中的即当作来源。
 */
function useModelProviderResolver() {
  const customApis = useSettingsStore((state) => state.customApis);

  return useMemo(() => {
    const index = new Map<string, string>();
    try {
      const models = [...listImageModels(), ...listVideoModels(), ...listAudioModels()];
      for (const model of models) {
        if (model?.id && model.providerId && !index.has(model.id)) {
          index.set(model.id, model.providerId);
        }
      }
    } catch {
      // 注册表读不出来就退化成「只显示模型 id」, 不影响其它字段。
    }
    return (modelId: string) => index.get(modelId) ?? null;
  }, [customApis]);
}

function PropertyRowView({
  row,
  copiedKey,
  rowKey,
  copyLabel,
  onCopy,
}: {
  row: NodePropertyRow;
  copiedKey: string | null;
  rowKey: string;
  copyLabel: string;
  onCopy: (key: string, value: string) => void;
}) {
  const isCopied = copiedKey === rowKey;

  return (
    <div className="flex gap-3 py-1.5">
      <span className="w-[76px] shrink-0 pt-0.5 text-xs text-text-muted">{row.label}</span>
      <div className="min-w-0 flex-1">
        <span
          className={
            row.multiline
              ? "block max-h-[180px] overflow-y-auto whitespace-pre-wrap break-words rounded bg-[rgba(15,23,42,0.04)] px-2 py-1 font-mono text-[11px] leading-relaxed text-text-dark dark:bg-bg-dark/60"
              : "block break-words text-xs leading-relaxed text-text-dark"
          }
        >
          {row.value}
        </span>
      </div>
      {row.copyable && (
        <button
          type="button"
          onClick={() => onCopy(rowKey, row.value)}
          className="nodrag h-6 w-6 shrink-0 rounded text-text-muted transition-colors hover:bg-[rgba(15,23,42,0.08)] hover:text-text-dark dark:hover:bg-bg-dark/70"
          title={copyLabel}
          aria-label={copyLabel}
        >
          {isCopied ? <Check className="mx-auto h-3.5 w-3.5 text-accent" /> : <Copy className="mx-auto h-3.5 w-3.5" />}
        </button>
      )}
    </div>
  );
}

export function NodePropertiesDialog({
  node,
  mediaKind,
  mediaUrl,
  upstream = null,
  onClose,
}: NodePropertiesDialogProps) {
  const { t } = useTranslation();
  const probe = useMediaProbe(mediaKind, mediaUrl);
  const byteSize = useMediaByteSizeProbe(mediaUrl);
  const provider = useProviderLookup();
  const resolveModelProviderId = useModelProviderResolver();
  const copyFeedbackRef = useRef<CopyFeedbackState>({ timer: null });
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const mergedProbe = useMemo<MediaProbe | null>(() => {
    const base = probe ?? {};
    const merged: MediaProbe = { ...base };
    if (byteSize) {
      merged.byteSize = byteSize;
    }
    return Object.keys(merged).length > 0 ? merged : null;
  }, [probe, byteSize]);

  const groups = useMemo(() => {
    if (!node || !mediaKind) {
      return [];
    }
    return buildNodeProperties({
      nodeType: node.type ?? "",
      data: node.data as unknown as Record<string, unknown>,
      mediaKind,
      mediaUrl,
      probe: mergedProbe,
      provider,
      upstream,
      resolveModelProviderId,
      t: (key: string, fallback: string) => String(t(key, fallback)),
    });
  }, [node, mediaKind, mediaUrl, mergedProbe, provider, upstream, resolveModelProviderId, t]);

  useEffect(
    () => () => {
      if (copyFeedbackRef.current.timer) {
        clearTimeout(copyFeedbackRef.current.timer);
      }
    },
    [],
  );

  const showCopied = useCallback((key: string) => {
    const previous = copyFeedbackRef.current;
    if (previous.timer) {
      clearTimeout(previous.timer);
    }
    setCopiedKey(key);
    copyFeedbackRef.current = {
      timer: setTimeout(() => {
        setCopiedKey(null);
        copyFeedbackRef.current = { timer: null };
      }, 1400),
    };
  }, []);

  const handleCopy = useCallback(
    (key: string, value: string) => {
      const clipboard = navigator.clipboard;
      if (!clipboard?.writeText) {
        return;
      }
      void clipboard
        .writeText(value)
        .then(() => showCopied(key))
        .catch(() => undefined);
    },
    [showCopied],
  );

  const nodeType = (node?.type ?? "") as CanvasNodeType;
  const nodeName = node ? resolveNodeDisplayName(nodeType, node.data) : "";
  const nodeId = node?.id ?? "";

  // 提示词单独给一个「一键复制」入口: 复用提示词最常见的用途就是拿去别的平台重跑。
  const promptText = useMemo(
    () => groups.flatMap((group) => group.rows).find((row) => row.id === "prompt")?.value ?? null,
    [groups],
  );

  const handleCopyAll = useCallback(() => {
    if (!groups.length) {
      return;
    }
    handleCopy("__all__", serializeNodeProperties(groups, { name: nodeName, nodeId }));
  }, [groups, handleCopy, nodeId, nodeName]);

  return (
    <UiModal
      isOpen={Boolean(node && mediaKind)}
      title={String(t("canvas.nodeProperties.title", "节点属性"))}
      onClose={onClose}
      widthClassName="w-[min(560px,calc(100vw-40px))]"
      footer={
        <>
          <UiButton variant="ghost" size="sm" onClick={onClose}>
            {String(t("common.close", "关闭"))}
          </UiButton>
          {promptText && (
            <UiButton
              size="sm"
              variant="ghost"
              onClick={() => handleCopy("__prompt__", promptText)}
            >
              {copiedKey === "__prompt__"
                ? String(t("canvas.nodeProperties.copied", "已复制"))
                : String(t("canvas.nodeProperties.copyPrompt", "复制提示词"))}
            </UiButton>
          )}
          <UiButton size="sm" variant="primary" onClick={handleCopyAll} disabled={groups.length === 0}>
            {copiedKey === "__all__"
              ? String(t("canvas.nodeProperties.copied", "已复制"))
              : String(t("canvas.nodeProperties.copyAll", "复制全部"))}
          </UiButton>
        </>
      }
    >
      <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm font-medium text-text-dark">{nodeName}</span>
          <span className="shrink-0 font-mono text-[10px] text-text-muted">{nodeId}</span>
        </div>

        {groups.map((group) => (
          <section key={group.key} className="space-y-1">
            <h3 className="text-[11px] font-medium tracking-wide text-text-muted uppercase">
              {group.title}
            </h3>
            <div className="divide-y divide-border-dark/40 rounded-lg border border-border-dark/60 px-3 py-1">
              {group.rows.map((row, index) => (
                <PropertyRowView
                  key={`${group.key}-${row.label}-${index}`}
                  row={row}
                  rowKey={`${group.key}-${index}`}
                  copiedKey={copiedKey}
                  copyLabel={String(t("canvas.nodeProperties.copy", "复制"))}
                  onCopy={handleCopy}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </UiModal>
  );
}
