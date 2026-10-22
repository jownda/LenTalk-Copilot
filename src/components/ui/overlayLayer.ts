import { createContext, useContext } from 'react';

/**
 * 浮层层级上下文。
 *
 * 设置面板(SettingsDialog)这类容器自身就是高层级(z-[300])。它内部打开的下拉菜单 /
 * 弹窗都会被 portal 到 `document.body`, 如果沿用默认层级(UiModal `z-50`、
 * UiSelect 菜单 `z-[140]`), 就会被容器本身压在下层 —— 视觉上表现为"点了没反应 /
 * 页面被遮挡"。
 *
 * 容器只要用 `<OverlayLayerProvider value={自身层级}>` 把层级告诉子树, 内部浮层
 * 就会自动抬到它之上, 不需要在每个调用点重复手写 z-index。
 */
export const OverlayLayerContext = createContext(0);

/** `OverlayLayerContext` 的 Provider 别名, 便于在业务组件里语义化使用。 */
export const OverlayLayerProvider = OverlayLayerContext.Provider;

/**
 * 读取当前浮层层级的"下限"; 没有 Provider 包裹时返回 0。
 *
 * 返回 0 表示"不介入": 此时浮层仍沿用 className 里写死的默认层级, 保证
 * 现有调用点(含用 `containerClassName` 覆盖层级的场景)行为完全不变。
 */
export function useOverlayLayerFloor(): number {
  return useContext(OverlayLayerContext);
}
