import { memo } from "react";
import { Upload } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { RunningHubWorkflowField } from "@/commands/runningHubWorkflow";
import {
  isMediaControl,
  type WorkflowMediaKind,
} from "@/features/canvas/application/workflowFieldMedia";
import { mediaSourceLabel } from "@/features/canvas/application/nodeMediaUpload";
import { useThumbnailFallback } from "@/features/canvas/ui/useCanvasImageSource";

/** 素材缩略：图片走 256 缩略图；视频只取首帧（autoplay 会让画布上多条同时播放）。 */
export const MediaSlotPreview = memo(({ source, kind }: { source: string; kind: WorkflowMediaKind }) => {
  const image = useThumbnailFallback(kind === "image" ? source : "");
  if (kind === "image") {
    if (image.isPlaceholder) {
      return <span className="h-8 w-10 shrink-0 animate-pulse rounded bg-white/[0.06]" aria-hidden />;
    }
    return <img src={image.url ?? ""} alt="" className="h-8 w-10 shrink-0 rounded object-cover object-top" />;
  }
  if (kind === "video") {
    return (
      <video src={source} muted preload="metadata" className="h-8 w-10 shrink-0 rounded bg-black/40 object-cover" />
    );
  }
  return (
    <span className="flex h-8 w-10 shrink-0 items-center justify-center rounded bg-accent/10 text-accent">
      <Upload className="h-3.5 w-3.5" />
    </span>
  );
});
MediaSlotPreview.displayName = "MediaSlotPreview";

/**
 * 一个工作流字段的输入控件。
 *
 * 卡片和全屏编辑器**共用这一份** —— 分成两份必然出现「卡片能传素材、编辑器不能」
 * 或者两处控件样式不一致的问题。
 */
export const WorkflowFieldInput = memo(function WorkflowFieldInput({
  field,
  value,
  onChange,
  onUpload,
  dense = false,
}: {
  field: RunningHubWorkflowField;
  value: string;
  onChange: (next: string) => void;
  onUpload: () => void;
  /** 卡片里用更矮的控件，编辑器里放宽。 */
  dense?: boolean;
}) {
  const { t } = useTranslation();
  const control = field.control;
  const label = field.inputName;
  const height = dense ? "h-7" : "h-8";
  const textSize = dense ? "text-[11px]" : "text-xs";

  if (isMediaControl(control)) {
    return (
      <div className="min-w-0">
        <div className="mb-1 truncate text-[10px] text-text-muted">{label}</div>
        <button
          type="button"
          className={`nodrag flex ${dense ? "h-10" : "h-11"} w-full items-center gap-2 overflow-hidden rounded border border-dashed border-border-dark px-2 text-left text-xs text-text-muted hover:border-accent/60 hover:text-text-dark`}
          onClick={(event) => {
            event.stopPropagation();
            onUpload();
          }}
          onMouseDown={(event) => event.stopPropagation()}
          title={value || t("node.runningHubWorkflow.notSet")}
        >
          {value ? <MediaSlotPreview source={value} kind={control} /> : <Upload className="h-3.5 w-3.5 shrink-0" />}
          <span className="truncate">{mediaSourceLabel(value, t("node.runningHubWorkflow.upload"))}</span>
        </button>
      </div>
    );
  }

  if (control === "switch") {
    return (
      <label className="flex items-center gap-2 text-[11px] text-text-muted">
        <input
          type="checkbox"
          className="nodrag"
          checked={value === "true"}
          onChange={(event) => onChange(event.target.checked ? "true" : "false")}
          onMouseDown={(event) => event.stopPropagation()}
        />
        <span className="truncate">{label}</span>
      </label>
    );
  }

  if (control === "textarea") {
    return (
      <label className="block text-[10px] text-text-muted">
        <span className="mb-1 block truncate">{label}</span>
        <textarea
          className={`nodrag nowheel ${dense ? "min-h-[52px]" : "min-h-[88px]"} w-full resize-none rounded border border-border-dark bg-bg-dark p-1.5 ${textSize} leading-5 text-text-dark outline-none placeholder:text-text-muted focus:border-accent/60`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onMouseDown={(event) => event.stopPropagation()}
        />
      </label>
    );
  }

  const isNumeric = control === "number" || control === "seed";
  return (
    <label className="block text-[10px] text-text-muted">
      <span className="mb-1 block truncate">{label}</span>
      <input
        className={`nodrag ${height} w-full rounded border border-border-dark bg-bg-dark px-1.5 ${textSize} text-text-dark outline-none focus:border-accent/60`}
        value={value}
        inputMode={isNumeric ? "numeric" : undefined}
        onChange={(event) => onChange(event.target.value)}
        onMouseDown={(event) => event.stopPropagation()}
      />
    </label>
  );
});
