import { NodeResizeControl } from '@xyflow/react';

type NodeResizeHandleProps = {
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
};

const DEFAULT_MIN_WIDTH = 160;
const DEFAULT_MIN_HEIGHT = 100;
const DEFAULT_MAX_WIDTH = 1400;
const DEFAULT_MAX_HEIGHT = 1400;

/**
 * 缩放热区共用的外观: 透明、无边框、无内边距, 默认隐藏, 鼠标压上去才显形。
 * 保持"只有右下角一个小三角"的视觉语言 —— 右边框 / 下边框是隐形的整条热区,
 * 只是把可拖拉的范围从"一个角"扩到"整条边"。
 */
const RESIZE_CONTROL_BASE_CLASS =
  '!min-h-0 !min-w-0 !rounded-none !border-0 !bg-transparent !p-0 !opacity-0 transition-opacity duration-100 hover:!opacity-100 focus-within:!opacity-100';

/** 边框提示条: 只做视觉提示, 不吃指针事件。 */
const EDGE_HINT_CLASS = 'pointer-events-none absolute rounded-full bg-white/35 transition-colors';

export function NodeResizeHandle({
  minWidth = DEFAULT_MIN_WIDTH,
  minHeight = DEFAULT_MIN_HEIGHT,
  maxWidth = DEFAULT_MAX_WIDTH,
  maxHeight = DEFAULT_MAX_HEIGHT,
}: NodeResizeHandleProps) {
  const bounds = { minWidth, minHeight, maxWidth, maxHeight };

  return (
    <>
      {/*
        右边框: 只改宽度。
        基础类 `.react-flow__resize-control.handle.right` 已经给了 `left: 100%` 与
        `translate: -50% -50%`, 所以热区天然骑在右边框上; 把高度铺满整条边、
        再把 `top` 回调到中线, 减去一半自身高度后就正好覆盖 [0, H]。
        `autoScale={false}`: 热区是按节点比例铺满整条边的, 跟着缩放做反向补偿
        会把长度算错(节点越矮热区越长)。
      */}
      <NodeResizeControl
        {...bounds}
        position="right"
        resizeDirection="horizontal"
        autoScale={false}
        className={`${RESIZE_CONTROL_BASE_CLASS} !top-1/2 !h-full !w-2`}
      >
        <div className={`${EDGE_HINT_CLASS} left-1/2 top-1/2 h-10 w-[3px] -translate-x-1/2 -translate-y-1/2`} />
      </NodeResizeControl>

      {/*
        下边框: 只改高度。同理, `left: 50%` + `translate: -50% -50%` 让它横向居中,
        宽度铺满整条底边后正好覆盖 [0, W]。
      */}
      <NodeResizeControl
        {...bounds}
        position="bottom"
        resizeDirection="vertical"
        autoScale={false}
        className={`${RESIZE_CONTROL_BASE_CLASS} !left-1/2 !h-2 !w-full`}
      >
        <div className={`${EDGE_HINT_CLASS} left-1/2 top-1/2 h-[3px] w-10 -translate-x-1/2 -translate-y-1/2`} />
      </NodeResizeControl>

      {/* 右下角: 同时改宽高(保持原有行为)。 */}
      <NodeResizeControl
        {...bounds}
        position="bottom-right"
        className={`${RESIZE_CONTROL_BASE_CLASS} !h-5 !w-5`}
      >
        <div className="pointer-events-none absolute bottom-0 right-0 h-3 w-3 border-b border-r border-white/35 transition-colors hover:border-accent" />
      </NodeResizeControl>
    </>
  );
}
