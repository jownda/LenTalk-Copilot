export const NODE_CONTROL_CHIP_CLASS = '!h-6 !rounded-md !px-2 !text-[11px] !gap-1';

export const NODE_CONTROL_MODEL_CHIP_CLASS = '!w-auto !justify-start !shrink-0';

/**
 * 窄版模型 chip：给宽度封顶，超长的模型名自己截断。
 *
 * 底部工具栏是「模型 + 参数 + 动作按钮」挤一行，模型名一带平台后缀就把右侧按钮顶出去。
 * 封顶后这一格宽度可预期，多余的字走省略号（`title` 里能看全）。
 */
export const NODE_CONTROL_MODEL_CHIP_NARROW_CLASS =
  '!w-auto !justify-start !shrink-0 !max-w-[124px]';

export const NODE_CONTROL_PARAMS_CHIP_CLASS = '!w-auto !justify-start !shrink-0';

/**
 * 图标型 chip（提示词模板按钮这类「只有图标、没有文字」的控件）。
 *
 * 高度 / 圆角 / 边框 / hover / 展开态全部跟模型、参数两个 chip 走同一套
 * （由 `UiChipButton` 的基础类 + `ui-field` 提供），只把内边距和宽度换成固定方块：
 * 有文字的 chip 是 `!px-2` + `w-auto`，直接复用会把 24px 的方块撑成 28px，
 * 和右侧生成按钮就不再对齐了。
 */
export const NODE_CONTROL_ICON_CHIP_CLASS =
  '!h-6 !w-6 !shrink-0 !justify-center !rounded-md !px-0 !gap-0 !text-[11px]';

/** 图标 chip 里的图标尺寸：与紧凑模式模型 chip 的图标一致。 */
export const NODE_CONTROL_ICON_CHIP_ICON_CLASS = 'h-3 w-3';

export const NODE_CONTROL_PRIMARY_BUTTON_CLASS =
  '!h-6 !rounded-md !px-2 !text-[11px] !gap-1 border border-transparent';

export const NODE_CONTROL_ICON_CLASS = 'h-3 w-3';
