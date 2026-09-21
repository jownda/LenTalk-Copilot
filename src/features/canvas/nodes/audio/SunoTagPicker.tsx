import { ChevronDown, Eraser, Tags } from "lucide-react";
import { memo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  countTags,
  parseTagList,
  toggleTag,
  type SunoTagGroup,
} from "./sunoTagLibrary";

export type SunoTagPickerProps = {
  /** 折叠条上的标题（i18n key）。 */
  labelKey: string;
  /** 展开后的标题（i18n key）—— 通常是「XX库」。 */
  panelLabelKey: string;
  groups: readonly SunoTagGroup[];
  /** 字段当前值（逗号分隔的字符串，与链路层同形状）。 */
  value: string;
  onChange: (next: string) => void;
  /** 负向标签用暖色描边，避免和正向标签看成一个东西。 */
  tone?: "style" | "negative";
};

const STYLE_CHIP_ACTIVE = "border-accent bg-accent/15 text-accent";
const STYLE_CHIP_IDLE = "border-border-dark bg-bg-dark/70 text-text-muted hover:text-text-dark";

/**
 * 标签库点选器 —— 平时**收起**（只占一行），点开才铺标签。
 *
 * 收起是刻意的：节点高度是固定的（默认 560px），风格库动辄几百个词，
 * 常驻会把输入区彻底挤没。收起时只显示「已选 N 个」，不占版面。
 *
 * 交互是**按值 toggle**：点一下加入、再点一下移除，不引入第二份状态 ——
 * 高亮直接由字段值推导（`hasTag`），所以手改输入框也能立刻反映到 chip 上。
 */
export function SunoTagPicker({
  labelKey,
  panelLabelKey,
  groups,
  value,
  onChange,
  tone = "style",
}: SunoTagPickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const selectedCount = countTags(value);
  const activeClass = tone === "negative" ? "border-amber-500/70 bg-amber-500/15 text-amber-400" : STYLE_CHIP_ACTIVE;

  return (
    <div className="space-y-1">
      <button
        type="button"
        className="nodrag flex h-6 w-full items-center justify-between gap-1 rounded border border-border-dark px-1.5 text-[10px] text-text-muted hover:text-text-dark"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
      >
        <span className="flex min-w-0 items-center gap-1">
          <Tags className="h-3 w-3 shrink-0" />
          <span className="truncate">{t(labelKey)}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {selectedCount > 0 && (
            <span className="tabular-nums text-text-muted/90">
              {t("node.audioGen.suno.tagsSelected", { count: selectedCount })}
            </span>
          )}
          <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>

      {open && (
        <div className="rounded-lg border border-border-dark bg-bg-dark/55 p-1.5">
          <div className="mb-1 flex items-center justify-between gap-1.5">
            <span className="text-[10px] text-text-muted">{t(panelLabelKey)}</span>
            <button
              type="button"
              className="nodrag flex h-5 items-center gap-1 rounded border border-border-dark px-1 text-[10px] text-text-muted hover:text-text-dark disabled:opacity-40"
              disabled={selectedCount === 0}
              title={t("node.audioGen.suno.tagsClear")}
              onClick={() => onChange("")}
            >
              <Eraser className="h-2.5 w-2.5" />
              {t("node.audioGen.suno.tagsClear")}
            </button>
          </div>

          {/* `nowheel` 挡住画布缩放，`ui-scrollbar` 用全局细滚动条 —— 节点内的既有约定。 */}
          <div className="ui-scrollbar nowheel max-h-40 space-y-1.5 overflow-y-auto pr-0.5">
            {groups.map((group) => (
              <TagGroupRow
                key={group.key}
                group={group}
                value={value}
                onChange={onChange}
                activeClass={activeClass}
              />
            ))}
          </div>

          <p className="mt-1 text-[10px] leading-4 text-text-muted/90">{t("node.audioGen.suno.tagsHint")}</p>
        </div>
      )}
    </div>
  );
}

type TagGroupRowProps = {
  group: SunoTagGroup;
  value: string;
  onChange: (next: string) => void;
  activeClass: string;
};

/**
 * 单组标签行。`memo` 是为了让打字时不至于把几百个 chip 全 diff 一遍 ——
 * 只有 `value` 真变了才重算高亮。
 */
const TagGroupRow = memo(function TagGroupRow({ group, value, onChange, activeClass }: TagGroupRowProps) {
  const { t } = useTranslation();
  // 高亮判据复用同一个 parse, 避免「同一个词 chip 亮着但值里没有」的错位。
  // 解析一次进 Set, 不逐个 chip 调 hasTag —— 那是 O(词数 × 已选数)。
  const picked = new Set(parseTagList(value));

  return (
    <div>
      <div className="mb-0.5 text-[9px] tracking-wide text-text-muted/80">{t(group.labelKey)}</div>
      <div className="flex flex-wrap gap-1">
        {group.tags.map((tag) => {
          const active = picked.has(tag);
          return (
            <button
              key={tag}
              type="button"
              className={`nodrag h-5 shrink-0 rounded border px-1.5 text-[10px] leading-none transition-colors ${
                active ? activeClass : STYLE_CHIP_IDLE
              }`}
              onClick={() => onChange(toggleTag(value, tag))}
            >
              {tag}
            </button>
          );
        })}
      </div>
    </div>
  );
});
