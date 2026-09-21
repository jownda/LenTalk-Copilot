export const UI_DIALOG_TRANSITION_MS = 180;
export const UI_POPOVER_TRANSITION_MS = 140;

// Keep custom overlays below the app title bar (h-10 = 40px).
export const UI_CONTENT_OVERLAY_INSET_CLASS = 'inset-x-0 bottom-0 top-10';

// 设置面板容器自身的层级(SettingsDialog)。
export const UI_SETTINGS_LAYER_Z = 300;

// 设置面板内部浮层(UiModal / UiSelect 菜单)的层级下限。
// 必须高于面板本身, 否则弹窗会被面板遮住 —— 表现为"点了没反应"。
export const UI_SETTINGS_OVERLAY_LAYER_Z = UI_SETTINGS_LAYER_Z + 100;
