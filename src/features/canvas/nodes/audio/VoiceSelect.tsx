import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { useOverlayLayerFloor } from "@/components/ui/overlayLayer";

import { VoicePreviewButton } from "./VoicePreviewButton";
import type { AudioPreviewSource, AudioPreviewController } from "./useAudioPreview";

export interface VoiceSelectOption {
  /** 传给 onChange 的值(平台音色 id / 音色库 voice_id)。 */
  value: string;
  /** 主标签。 */
  label: string;
  /** 次标签(风格说明、来源标记), 灰色小字。 */
  hint?: string;
  /** 分组名; 不传归入默认分组。 */
  group?: string;
  /** 该音色现成的试听音频(音色库里的设计音色通常自带)。有则不必现场合成。 */
  previewAudio?: string;
  /**
   * 长描述 —— 只进原生 tooltip, 不占版面。
   *
   * 官方音色库每条都带一段几十字的描述, 塞进列表行会把几百行撑成一屏两行; 悬浮看一眼
   * 就够, 选中的那一条由调用方在下面单独展开(见 MmxVoiceStudio 的 desc 块)。
   */
  description?: string;
  /**
   * 该音色**没有任何可播的试听源**(官方音色库里就没配样本)。行尾不渲染试听键。
   *
   * 为什么不退化成「现场合成一条」: 合成是按字符计费的, 而这一行混在几百条免费试听里,
   * 点下去悄悄扣费最不该发生。宁可这一行没有按钮。
   */
  previewUnavailable?: boolean;
}

export type VoiceSelectProps = {
  options: VoiceSelectOption[];
  value: string;
  onChange: (value: string) => void;
  /** 未选择 / 清除后的占位文案。 */
  placeholder: string;
  /** 「清除选择」那一行的文案; 不传则不提供清除项。 */
  clearLabel?: string;
  /** 展开后没有任何选项时的说明(例如「音色库还是空的, 先去上面克隆一个」)。 */
  emptyHint?: string;
  /**
   * 弹出卡片顶部的一条过滤器(例如「语言」下拉)。
   *
   * 放在卡片里而不是外面: 六百多条音色只按语言收窄一次, 常驻一行控件去占节点的版面不划算,
   * 收进卡片就等于「需要时才出现」。
   */
  listHeader?: ReactNode;
  /** 整体的可访问标签。 */
  ariaLabel: string;
  preview: AudioPreviewController;
  /** 取试听源。返回 undefined 表示这个音色暂时听不了。 */
  resolvePreview: (option: VoiceSelectOption) => AudioPreviewSource | Promise<AudioPreviewSource>;
  /** `sm` 配节点里的一排小字段(h-7), `md` 配通用 TTS 面板那一行(h-8)。 */
  size?: "sm" | "md";
  disabled?: boolean;
  className?: string;
};

/** 弹出卡片的宽度下限 —— 比触发按钮宽一点, 几百条音色的长名字才放得下。 */
const POPUP_MIN_WIDTH = 280;
/** 列表滚动区最大高度; 卡片总高 ≈ 它 + 过滤器行 + 内边距。 */
const LIST_MAX_HEIGHT = 264;

/**
 * 带**内联试听**的音色选择器 —— 全项目统一的那个「音色卡片」。
 *
 * 为什么不用原生 `<select>`: 原生选项里塞不进按钮, 所以以前只能在下面另开一块
 * 「内置音色」网格专门放试听键 —— 同一件事被拆到两个控件里, 而且那块网格常驻占版面。
 * 现在合成一个: **点开就是卡片, 每行自带试听**。
 *
 * 交互(与 UiSelect 弹层同一套约定):
 *   点「选择音色」→ 弹出卡片; **点了某个音色 → 卡片收起并选中**;
 *   **点了卡片以外的任何位置 → 卡片同样收起**; Esc 也收起。
 *
 * 为什么能做成浮层(以前不行): 旧实现展开在节点文档流里, 节点主体是 `overflow-y-auto`
 * 的滚动容器, 浮层会被裁掉 —— 现在整张卡片 **portal 到 `document.body`**(`position: fixed`),
 * 滚动容器裁不到它; 坐标从触发按钮的 `getBoundingClientRect()` 实时取, 画布缩放/节点滚动
 * 时跟着重算(scroll 捕获阶段 + resize), 不会跑偏。卡片挂在 body 上, React Flow 的拖拽/
 * 滚轮缩放监听也够不着它, 不用再担心 `nodrag`/`nowheel`。
 *
 * 试听状态由外部传入的 `preview` 统一持有 —— 所以「谁在播」在整节点内是唯一的,
 * 不会出现两个音色同时在响。
 */
export function VoiceSelect({
  options,
  value,
  onChange,
  placeholder,
  clearLabel,
  emptyHint,
  listHeader,
  ariaLabel,
  preview,
  resolvePreview,
  size = "sm",
  disabled,
  className = "",
}: VoiceSelectProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [popupPosition, setPopupPosition] = useState<{ top: number; left: number; width: number }>({
    top: 0,
    left: 0,
    width: POPUP_MIN_WIDTH,
  });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  // 被高层级容器(如设置面板)包裹时, 卡片要抬到容器之上; 没有 Provider 时用画布场景的默认层级。
  const overlayFloor = useOverlayLayerFloor();

  const triggerClass = size === "md" ? "h-8 text-xs" : "h-7 text-[11px]";

  const selected = options.find((option) => option.value === value);
  const selectedKey = value ? `voice:${value}` : "";

  /** 保持传入顺序分组 —— 音色库在前、内置在后由调用方决定。 */
  const groups = useMemo(() => {
    const buckets = new Map<string, VoiceSelectOption[]>();
    for (const option of options) {
      const key = option.group ?? "";
      const bucket = buckets.get(key);
      if (bucket) bucket.push(option);
      else buckets.set(key, [option]);
    }
    return Array.from(buckets.entries());
  }, [options]);

  /** 从触发按钮的实时位置算卡片落点; 底部放不下就翻到按钮上方。 */
  const computePosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // 估高只用来决定「上翻还是下翻」, 渲染完还有一次按实测高度的修正(layout effect)。
    const rowsEstimate = Math.min(options.length, 10) * 24 + 16 + (listHeader ? 30 : 0) + (clearLabel ? 24 : 0);
    const estimatedHeight = Math.min(rowsEstimate, LIST_MAX_HEIGHT + 46);
    const openAbove = rect.bottom + 4 + estimatedHeight > window.innerHeight - 8 && rect.top > estimatedHeight;
    const width = Math.max(rect.width, POPUP_MIN_WIDTH);
    setPopupPosition({
      top: openAbove ? Math.max(8, rect.top - estimatedHeight - 4) : rect.bottom + 4,
      // 视口左右各留 8px, 别让卡片探出屏幕。
      left: Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8)),
      width,
    });
  }, [options.length, listHeader, clearLabel]);

  // 卡片开着的时候: 落位、跟随滚动/缩放, 按 Esc 收起。
  // 「点卡片以外关闭」不靠 document 监听 —— React Flow 画布(d3-drag/d3-zoom)会在
  // mousedown 上 stopImmediatePropagation, 事件到不了 document。改为在卡片下方垫一层
  // 全屏透明遮罩(见下方 portal): 点遮罩即关, 与 ImageEditNode 的浮层同一套约定。
  useEffect(() => {
    if (!open) return;
    computePosition();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("resize", computePosition);
    document.addEventListener("scroll", computePosition, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("resize", computePosition);
      document.removeEventListener("scroll", computePosition, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, computePosition]);

  // 打开后用实测高度修正一次落点(估高对几百行分组列表必然不准)。
  useLayoutEffect(() => {
    if (!open) return;
    const popup = popupRef.current;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!popup || !rect) return;
    const height = popup.offsetHeight;
    if (popupPosition.top + height > window.innerHeight - 8 && rect.top > height + 8) {
      setPopupPosition((current) => ({ ...current, top: Math.max(8, rect.top - height - 4) }));
    }
  }, [open, popupPosition]);

  return (
    <div className={`min-w-0 ${className}`}>
      <div className="flex items-center gap-1">
        <button
          ref={triggerRef}
          type="button"
          className={`nodrag flex min-w-0 flex-1 items-center justify-between gap-1 rounded border border-border-dark bg-bg-dark px-1.5 text-left text-text-dark disabled:opacity-45 ${triggerClass}`}
          onClick={() => setOpen((current) => !current)}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <span className={`min-w-0 truncate ${selected ? "text-text-dark" : "text-text-muted"}`}>
            {selected ? selected.label : placeholder}
          </span>
          <ChevronDown className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        {/* 收起状态也能直接重听当前音色 —— 不用为了再听一遍把卡片点开。 */}
        {selected && !selected.previewUnavailable && (
          <VoicePreviewButton
            state={preview.stateOf(selectedKey)}
            onClick={() => preview.toggle(selectedKey, () => resolvePreview(selected))}
            disabled={disabled}
            title={t("node.audioGen.preview")}
          />
        )}
      </div>

      {open &&
        createPortal(
          <>
            {/* 全屏透明遮罩 —— 「点卡片以外的任何位置都收起」的真正实现。
                必须垫在卡片下面而不是监听 document: React Flow 画布(d3-drag/d3-zoom)会在
                mousedown 上 stopImmediatePropagation, 事件到不了 document; 遮罩在最上层,
                点击首先命中它, 画布根本收不到。打开期间它挡住下层一切点击(再点一下即收起,
                与 ImageEditNode 的浮层同一套约定)。 */}
            <div
              aria-hidden="true"
              className="fixed inset-0"
              style={{ zIndex: overlayFloor > 0 ? overlayFloor + 149 : 139 }}
              onPointerDown={() => setOpen(false)}
              onContextMenu={(event) => {
                event.preventDefault();
                setOpen(false);
              }}
            />
            <div
              ref={popupRef}
              className="fixed rounded-lg border border-border-dark bg-surface-dark/95 p-1.5 shadow-2xl shadow-black/50 backdrop-blur-sm"
              style={{ top: popupPosition.top, left: popupPosition.left, width: popupPosition.width, zIndex: overlayFloor > 0 ? overlayFloor + 150 : 140 }}
              role="listbox"
              aria-label={ariaLabel}
            >
            {listHeader && <div className="px-0.5 pb-1.5">{listHeader}</div>}
            {/* `ui-scrollbar` 用全局细滚动条。
                `pr-2` 是给滚动条让位: 行尾的试听按钮原本贴着右边缘, 会被那 7px 滚动条压在
                下面, 看得见却点不中。留出空隙比缩小滚动条更可靠。 */}
            <div className="ui-scrollbar max-h-[264px] overflow-y-auto pr-2" style={{ maxHeight: LIST_MAX_HEIGHT }}>
              {options.length === 0 && (
                <p className="px-1.5 py-1 text-[10px] leading-4 text-text-muted">
                  {emptyHint ?? t("node.audioGen.voiceListEmpty")}
                </p>
              )}
              {clearLabel && (
                <button
                  type="button"
                  className="nodrag flex h-6 w-full items-center rounded px-1.5 text-left text-[11px] text-text-muted hover:bg-white/10 hover:text-text-dark"
                  onClick={() => {
                    preview.stop();
                    onChange("");
                    setOpen(false);
                  }}
                >
                  {clearLabel}
                </button>
              )}
              {groups.map(([group, items]) => (
                <div key={group || "__default"}>
                  {group && (
                    <div className="px-1.5 pb-0.5 pt-1 text-[9px] tracking-wide text-text-muted/80">{group}</div>
                  )}
                  {items.map((option) => {
                    const key = `voice:${option.value}`;
                    const active = option.value === value;
                    return (
                      <div
                        key={option.value}
                        className={`flex items-center gap-1 rounded ${active ? "bg-accent/10" : ""}`}
                      >
                        <button
                          type="button"
                          className={`nodrag min-w-0 flex-1 truncate px-1.5 py-1 text-left text-[11px] ${
                            active ? "text-accent" : "text-text-dark"
                          }`}
                          title={[option.label, option.hint, option.description].filter(Boolean).join(" · ")}
                          onClick={() => {
                            onChange(option.value);
                            setOpen(false);
                          }}
                        >
                          {option.label}
                          {option.hint && <span className="ml-1 text-[10px] text-text-muted">{option.hint}</span>}
                        </button>
                        {!option.previewUnavailable && (
                          <VoicePreviewButton
                            state={preview.stateOf(key)}
                            onClick={() => preview.toggle(key, () => resolvePreview(option))}
                            disabled={disabled}
                            title={t("node.audioGen.preview")}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
