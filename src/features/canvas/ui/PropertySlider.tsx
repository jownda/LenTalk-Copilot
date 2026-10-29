import type * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { clampScalar, snapScalar } from "@/features/canvas/application/scalarMath";

/**
 * 属性面板的一行：`标签 | 滑块 | 数值框`。
 *
 * 交互照 OpenChatCut 的 Inspector（MIT）来的：
 * - 滑块拖动实时生效；
 * - 数值框点进去才变成可编辑（避免把用户正在输入的 "0." 打断）；
 * - 双击标签复位到默认值（比额外塞一个复位小图标省地方，参考图里那个 ↩ 一共 4 个位置太碎）。
 */

interface PropertySliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** 显示倍率：不透明度存 0~1，界面上按 0~100 显示。 */
  displayScale?: number;
  suffix?: string;
  /** 双击标签复位到它。不传则不能复位。 */
  defaultValue?: number;
  disabled?: boolean;
  /** 行尾附加控件（关键帧按钮之类）。放在数值框右边，不挤压滑块。 */
  trailing?: React.ReactNode;
  onChange: (value: number) => void;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

export function PropertySlider({
  label,
  value,
  min,
  max,
  step = 1,
  displayScale = 1,
  suffix = "",
  defaultValue,
  disabled = false,
  trailing,
  onChange,
}: PropertySliderProps) {
  const display = value * displayScale;
  const [draft, setDraft] = useState(() => formatNumber(display));
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(formatNumber(display));
  }, [display, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = useCallback(() => {
    const parsed = Number(draft);
    if (draft.trim() && Number.isFinite(parsed)) {
      onChange(snapScalar(clampScalar(parsed / displayScale, min, max), min, max, step));
    }
    setEditing(false);
  }, [displayScale, draft, max, min, onChange, step]);

  return (
    <div className="flex h-7 items-center gap-2">
      <span
        className="w-[68px] shrink-0 truncate text-[11px] text-text-muted"
        title={defaultValue === undefined ? label : `${label}（双击复位）`}
        onDoubleClick={() => {
          if (defaultValue !== undefined) onChange(defaultValue);
        }}
      >
        {label}
      </span>
      <input
        type="range"
        min={min * displayScale}
        max={max * displayScale}
        step={step * displayScale}
        value={display}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value) / displayScale)}
        className="h-1 min-w-0 flex-1 cursor-pointer accent-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
      />
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") setEditing(false);
          }}
          className="h-6 w-14 shrink-0 rounded border border-accent/60 bg-bg-dark px-1 text-right text-[11px] tabular-nums text-text-dark outline-none"
        />
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setEditing(true)}
          className="h-6 w-14 shrink-0 rounded border border-white/10 bg-white/[0.04] px-1 text-right text-[11px] tabular-nums text-text-dark transition-colors hover:border-accent/50 disabled:opacity-40"
        >
          {formatNumber(display)}
          {suffix}
        </button>
      )}
      {trailing}
    </div>
  );
}

/** 只读行：`标签 …… 值`。 */
export function PropertyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex h-7 items-center justify-between gap-2 text-[11px]">
      <span className="truncate text-text-muted">{label}</span>
      <span className="shrink-0 tabular-nums text-text-dark">{value}</span>
    </div>
  );
}

/** 分组标题 + 分隔线。 */
export function PropertySection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="pt-1 text-[10px] font-medium uppercase tracking-wide text-text-muted/60">{title}</div>
      {children}
    </div>
  );
}
