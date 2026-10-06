export const UI_DIALOG_TRANSITION_MS = 180;
export const UI_POPOVER_TRANSITION_MS = 140;

// Keep custom overlays below the app title bar (h-10 = 40px).
export const UI_CONTENT_OVERLAY_INSET_CLASS = 'inset-x-0 bottom-0 top-10';

// 设置面板容器自身的层级(SettingsDialog)。
export const UI_SETTINGS_LAYER_Z = 300;

// 设置面板内部浮层(UiModal / UiSelect 菜单)的层级下限。
// 必须高于面板本身, 否则弹窗会被面板遮住 —— 表现为"点了没反应"。
export const UI_SETTINGS_OVERLAY_LAYER_Z = UI_SETTINGS_LAYER_Z + 100;

// 扒剧本工作台容器自身的层级(PajubenStudio)。
export const UI_PAJUBEN_LAYER_Z = 150;

// 工作台内部浮层(UiModal / UiSelect 菜单)的层级下限。
// 必须高于工作台本身, 否则「下载小说」页的书籍预览弹窗会被工作台整个盖住,
// 点「下载」看不到任何反应。
export const UI_PAJUBEN_OVERLAY_LAYER_Z = UI_PAJUBEN_LAYER_Z + 100;

// 画布内模板抽屉(TemplateSidebar)自身的层级。抽屉 portal 到 body, 用 z-[140],
// 这里的常量只用于推导它的内部浮层, 不参与类名拼装。
export const UI_TEMPLATE_DRAWER_LAYER_Z = 140;

// 抽屉内双击卡片打开的模板详情弹窗层级下限。
// 必须高于抽屉, 否则遮罩盖不住卡片、关闭按钮会被卡片压住点不到。
export const UI_TEMPLATE_DETAIL_OVERLAY_LAYER_Z = UI_TEMPLATE_DRAWER_LAYER_Z + 100;
