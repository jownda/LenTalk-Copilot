/**
 * 「@ 引用」候选面板（AI 图片 / AI 视频 / 分镜生成 / 提示词优化四个节点共用）的
 * 锚点换算与面板收敛规则。
 *
 * 抽成纯函数的原因和 quickAssetPickerLayout 一致：这些数值只跟「光标位置 / 面板尺寸 /
 * 节点尺寸」有关，可一旦算错，面板就会溢出节点卡片 —— 光标靠右时整块探出节点外，
 * 节点又贴着画布边缘时就会被画布裁掉。组件里只负责量尺寸，取舍全在这里，便于回归。
 *
 * 坐标系约定（很容易踩错，改之前先读这段）：
 * - 锚点是「相对节点根容器」的未缩放坐标，与 React Flow 下 inline `left/top` 同系
 *   （所以容器的 getBoundingClientRect 要除以 zoom，caretOffset 是 CSS 像素不用除）。
 * - 面板自己写的是 `left/top`，参考的是它的「定位父级」（输入框卡片，不是节点根容器）。
 *   两者差一个 `parentOffset`，必须在 resolveNodePickerPlacement 里减掉。
 *
 * 缩放（zoom）必须传进来，且有两个作用点，漏一个都会出问题：
 * 1. **算锚点**：`getBoundingClientRect` 的差值是屏幕像素，含着 zoom，必须除掉才是未缩放坐标。
 *    漏掉的话锚点会偏成 `真实值 × zoom`，而面板又按未缩放坐标渲染 → 屏幕上看是 `真实值 × zoom²`。
 *    典型症状：画布放大时面板离光标很远、缩小时离得很近。
 * 2. **加间距**：`PICKER_ANCHOR_GAP_PX` 之类的「视觉常量」写在未缩放坐标里，
 *    放大画布时间距会跟着放大。必须除以 zoom 才能在任何缩放下看起来一样宽。
 *
 * 收敛边界是「节点卡片 ∩ 画布可视区」，两个都要（见 PickerViewportBounds 的说明）：
 * 只认卡片时，节点贴画布底边就会出现「卡片里还剩一点空间、屏幕上却全被裁掉」，
 * 面板照旧往下弹、整块落在画布外 —— 用户点不到。补上 viewport 后这种场景会自动上翻。
 */

export interface PickerAnchor {
  left: number;
  top: number;
}

/** 拿不到容器时的兜底锚点：节点左上角内缩一点。 */
export const PICKER_FALLBACK_ANCHOR: PickerAnchor = { left: 8, top: 8 };

/** 面板相对锚点的垂直间距，让面板落在光标下方而不是盖住当前行。 */
export const PICKER_ANCHOR_GAP_PX = 20;

/** 面板与节点卡片四边的留白 —— 小于它视觉上就等于贴边。 */
export const NODE_PICKER_MARGIN_PX = 6;

/** 面板可用高度的下限：再矮连一行缩略图都放不下，不如让它就地溢出。 */
export const NODE_PICKER_MIN_AVAILABLE_HEIGHT_PX = 72;

/** 把外部传进来的 zoom 归一成可安全做除法的正数。 */
export function normalizeZoom(zoom: number | undefined): number {
  return typeof zoom === 'number' && Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

/**
 * 把「视觉上应有的尺寸」换算成当前缩放下的未缩放坐标值。
 *
 * 面板写在未缩放坐标里，但用户看的是缩放后的画面：同一个未缩放间距，画布放大时看着更远、
 * 缩小时看着更近。所有「希望屏幕上恒定的」量都要先过这道换算。
 */
export function toUnscaledLength(visualPx: number, zoom: number | undefined): number {
  return visualPx / normalizeZoom(zoom);
}

/**
 * 量光标在 textarea 内的像素偏移（镜像 div 技巧）。
 * 返回的是 CSS 像素，不受画布缩放影响，因此不要在这里除 zoom。
 */
export function getTextareaCaretOffset(textarea: HTMLTextAreaElement, caretIndex: number): PickerAnchor {
  const mirror = document.createElement('div');
  const computed = window.getComputedStyle(textarea);
  const mirrorStyle = mirror.style;

  mirrorStyle.position = 'absolute';
  mirrorStyle.visibility = 'hidden';
  mirrorStyle.pointerEvents = 'none';
  mirrorStyle.whiteSpace = 'pre-wrap';
  mirrorStyle.overflowWrap = 'break-word';
  mirrorStyle.wordBreak = 'break-word';
  mirrorStyle.boxSizing = computed.boxSizing;
  mirrorStyle.width = `${textarea.clientWidth}px`;
  mirrorStyle.font = computed.font;
  mirrorStyle.lineHeight = computed.lineHeight;
  mirrorStyle.letterSpacing = computed.letterSpacing;
  mirrorStyle.padding = computed.padding;
  mirrorStyle.border = computed.border;
  mirrorStyle.textTransform = computed.textTransform;
  mirrorStyle.textIndent = computed.textIndent;

  mirror.textContent = textarea.value.slice(0, caretIndex);

  const marker = document.createElement('span');
  marker.textContent = textarea.value.slice(caretIndex, caretIndex + 1) || ' ';
  mirror.appendChild(marker);

  document.body.appendChild(mirror);

  const left = marker.offsetLeft - textarea.scrollLeft;
  const top = marker.offsetTop - textarea.scrollTop;

  document.body.removeChild(mirror);

  return {
    left: Math.max(0, left),
    top: Math.max(0, top),
  };
}

/**
 * 把光标位置换算成「相对节点容器」的锚点。
 *
 * ⚠️ `zoom` **必传**（故意不给默认值）：`getBoundingClientRect` 的差值是屏幕像素，含 zoom。
 * 漏传时锚点会变成「真实未缩放偏移 × zoom」，面板又按未缩放坐标渲染 → 画布上看是 × zoom²，
 * 症状就是「画布放大时面板离光标很远、缩小时离得很近」。不给默认值是为了让漏传直接编译不过。
 */
export function resolvePickerAnchor(
  container: HTMLElement | null,
  textarea: HTMLTextAreaElement,
  caretIndex: number,
  zoom: number,
): PickerAnchor {
  if (!container) {
    return PICKER_FALLBACK_ANCHOR;
  }

  const containerRect = container.getBoundingClientRect();
  const textareaRect = textarea.getBoundingClientRect();
  const caretOffset = getTextareaCaretOffset(textarea, caretIndex);
  const safeZoom = normalizeZoom(zoom);

  return {
    left: Math.max(0, (textareaRect.left - containerRect.left) / safeZoom + caretOffset.left),
    top: Math.max(0, (textareaRect.top - containerRect.top) / safeZoom + caretOffset.top),
  };
}

/** 把鼠标点击位置换算成「相对节点容器」的锚点（分镜节点点格子里的输入框时用）。zoom 必传，理由同上。 */
export function resolvePointerAnchor(
  container: HTMLElement | null,
  clientX: number,
  clientY: number,
  zoom: number,
): PickerAnchor {
  if (!container) {
    return PICKER_FALLBACK_ANCHOR;
  }

  const containerRect = container.getBoundingClientRect();
  const safeZoom = normalizeZoom(zoom);

  return {
    left: Math.max(0, (clientX - containerRect.left) / safeZoom),
    top: Math.max(0, (clientY - containerRect.top) / safeZoom),
  };
}

/**
 * 求「element 的定位父级」相对 ancestor 的偏移：从 element.offsetParent 起，
 * 沿 offsetParent 链累加 offsetLeft/offsetTop，直到碰到 ancestor。
 *
 * 面板是 `absolute`，它自己的 inline `left/top` 参考的是「定位父级」，
 * 而锚点是「节点容器」坐标系 —— 两者差的就是这个偏移，必须在 placement 里减掉。
 *
 * **必须从 offsetParent 起步，不能从 element 起步。** element（面板自己）的
 * offsetLeft 里含它当前的 inline `left`，也就是锚点值；一起算进来会让 parentOffset
 * 顺手把锚点吞掉，于是 `localLeft = anchor - parentOffset ≈ 0`，面板被推到卡片边界外 ——
 * 「面板不在 @ 位置」正是这么来的。改这里之前先想清楚这一点。
 *
 * 用 offset 系列而不是 getBoundingClientRect：后者带着画布缩放的缩放系数，
 * 而面板写的是未缩放的 inline left/top，两者不同系。
 *
 * 不在同一条 offsetParent 链上时返回 0 —— 宁可少算偏移，也不要瞎算出一个越界位置。
 */
export function measureOffsetWithin(element: HTMLElement, ancestor: HTMLElement): PickerAnchor {
  let left = 0;
  let top = 0;
  let current = element.offsetParent as HTMLElement | null;

  while (current && current !== ancestor) {
    left += current.offsetLeft;
    top += current.offsetTop;
    current = current.offsetParent as HTMLElement | null;
  }

  return current === ancestor ? { left, top } : { left: 0, top: 0 };
}

/**
 * 往上找第一个「真的会裁剪」的祖先 —— 通常就是 React Flow 的画布根（`.react-flow` 带 overflow:hidden）。
 *
 * 为什么不直接写 `closest('.react-flow')`：面板的定位父级可能落在节点内部某个
 * overflow-auto 的滚动区里，那层才是真正把面板切掉的人。按「计算样式」判断与实际裁剪行为一致，
 * 也不跟 React Flow 的类名/版本绑定。往上找到 body 都没有就返回 null，退化成只认节点卡片。
 */
export function findClippingAncestor(element: HTMLElement): HTMLElement | null {
  let current = element.parentElement;

  while (current && current !== document.body) {
    const style = window.getComputedStyle(current);
    if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
      return current;
    }
    current = current.parentElement;
  }

  return null;
}

export interface NodePickerPlacement {
  left: number;
  top: number;
  /** 面板自身的 max-height：内容再多也不会高过「卡片 ∩ 画布可视区」。 */
  maxHeight: number;
  /** true = 下方放不下，翻到了锚点上方（仅为断言/调试保留）。 */
  placedAbove: boolean;
}

/**
 * 画布可视区（真正会裁剪面板的那层祖先）相对节点容器、**未缩放**的矩形。
 *
 * 为什么不直接用节点卡片当边界：卡片里的「放得下」不等于屏幕上看得见。
 * 节点被拖到画布底部时，卡片下半截已经在画布视口之外，面板即便规规矩矩待在卡片内，
 * 屏幕上也只剩一条边 —— 用户看到的就是「@ 出来的卡片被画布边框遮住、选不到」。
 */
export interface PickerViewportBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 把两个屏幕矩形换算成「可视区相对容器」的未缩放矩形。
 *
 * 两个 rect 都是屏幕像素、含着 zoom，所以差值要除 zoom 才是未缩放坐标 ——
 * 这点和 resolvePickerAnchor 同源，漏除会让边界随缩放忽宽忽窄。
 */
export function resolveViewportBounds(
  containerRect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  viewportRect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  zoom: number,
): PickerViewportBounds {
  const safeZoom = normalizeZoom(zoom);

  return {
    left: (viewportRect.left - containerRect.left) / safeZoom,
    top: (viewportRect.top - containerRect.top) / safeZoom,
    width: viewportRect.width / safeZoom,
    height: viewportRect.height / safeZoom,
  };
}

export interface NodePickerPlacementInput {
  /** 锚点：节点容器坐标系（未缩放）。 */
  anchorLeft: number;
  anchorTop: number;
  /** 面板实测尺寸（offsetWidth / offsetHeight）。 */
  panelWidth: number;
  panelHeight: number;
  /** 节点容器可用尺寸（offsetWidth / offsetHeight）。 */
  containerWidth: number;
  containerHeight: number;
  /** 面板定位父级相对节点容器的偏移（measureOffsetWithin 的结果）。 */
  parentOffsetLeft: number;
  parentOffsetTop: number;
  /** 当前画布缩放。间距/留白是「视觉常量」，要靠它换算成未缩放坐标（必传，漏传会静默错位）。 */
  zoom: number;
  /**
   * 画布可视区（未缩放、相对容器）。传了就与卡片边界求交，面板会优先落在
   * 「卡片 ∩ 可视区」内 —— 节点贴画布底边时，这就是「自适应向上弹」的依据。
   * 拿不到可视区时传 null / 省略，行为退回到「只认卡片」。
   */
  viewport?: PickerViewportBounds | null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

/**
 * 把面板收敛进「节点卡片 ∩ 画布可视区」：
 * 1. 先按锚点定位（锚点下方 gap 处）；
 * 2. 右侧放不下就左移，左侧放不下就右移 —— 左右都夹不住时以左边界优先；
 * 3. 下方放不下就翻到锚点上方；上下都放不下才就地夹取并靠 maxHeight 滚动。
 *
 * 有了 viewport，第 3 步才真正解决问题：节点贴着画布底边时，卡片里可能「还剩一点空间」，
 * 但那点空间在屏幕上是看不见的（被画布裁掉）。原来只认卡片，于是面板照旧往下弹、
 * 整块落在画布外，用户点不到任何一项。现在可用底线取「卡片底」与「可视区底」的较小值，
 * 空间不够就直接翻到锚点上方。
 *
 * `gap` 与 `margin` 都按 zoom 折算：它们是「希望在屏幕上恒定」的视觉量，而 left/top 写在
 * 未缩放坐标里，不折算的话画布放大时间距会跟着放大（「@ 卡片离光标忽远忽近」就是这么来的）。
 */
export function resolveNodePickerPlacement({
  anchorLeft,
  anchorTop,
  panelWidth,
  panelHeight,
  containerWidth,
  containerHeight,
  parentOffsetLeft,
  parentOffsetTop,
  zoom,
  viewport = null,
}: NodePickerPlacementInput): NodePickerPlacement {
  const gap = toUnscaledLength(PICKER_ANCHOR_GAP_PX, zoom);
  const margin = toUnscaledLength(NODE_PICKER_MARGIN_PX, zoom);

  // 可用区先取卡片内边界，再与画布可视区求交（含 margin 留白）。
  let usableLeft = margin;
  let usableTop = margin;
  let usableRight = containerWidth - margin;
  let usableBottom = containerHeight - margin;

  if (viewport) {
    const clippedLeft = viewport.left + margin;
    const clippedTop = viewport.top + margin;
    const clippedRight = viewport.left + viewport.width - margin;
    const clippedBottom = viewport.top + viewport.height - margin;

    // 逐轴求交；某一轴完全没有交集（整个卡片都在这轴的可视区外）时该轴退回卡片边界 ——
    // 那种情况下面板无论怎么放都看不见，交给卡片边界至少不会比改之前更差。
    if (clippedRight - clippedLeft > 0) {
      usableLeft = Math.max(usableLeft, clippedLeft);
      usableRight = Math.min(usableRight, clippedRight);
    }
    if (clippedBottom - clippedTop > 0) {
      usableTop = Math.max(usableTop, clippedTop);
      usableBottom = Math.min(usableBottom, clippedBottom);
    }

    if (usableRight <= usableLeft) {
      usableLeft = margin;
      usableRight = containerWidth - margin;
    }
    if (usableBottom <= usableTop) {
      usableTop = margin;
      usableBottom = containerHeight - margin;
    }
  }

  const availableHeight = Math.max(0, usableBottom - usableTop);
  const fitHeight = Math.max(NODE_PICKER_MIN_AVAILABLE_HEIGHT_PX, availableHeight);
  const height = Math.min(panelHeight, fitHeight);

  // 容器可用区换算到「定位父级坐标系」。
  const minLeft = usableLeft - parentOffsetLeft;
  const minTop = usableTop - parentOffsetTop;
  const maxLeftLimit = usableRight - parentOffsetLeft;
  const maxBottomLimit = usableBottom - parentOffsetTop;

  const localLeft = anchorLeft - parentOffsetLeft;
  const localTop = anchorTop - parentOffsetTop;
  const maxLeft = Math.max(minLeft, maxLeftLimit - panelWidth);
  const left = clamp(localLeft, minLeft, maxLeft);

  const belowTop = localTop + gap;
  const aboveTop = localTop - gap - height;
  const maxTop = Math.max(minTop, maxBottomLimit - height);

  /**
   * 每个分支都要顺手把 max-height 收到「这一侧真正剩多少」——否则内容一多，
   * 面板就会从当前位置往下长到超出可视区，正是「卡片被画布边框遮住」的另一副面孔。
   * 取 min(该侧空间, 到可用底线的距离) 是为了让「最坏情况（内容无限多）」也不越过底边。
   */
  const fitMaxHeight = (sideSpace: number, top: number) =>
    Math.max(
      NODE_PICKER_MIN_AVAILABLE_HEIGHT_PX,
      Math.min(sideSpace, maxBottomLimit - top),
    );

  if (belowTop + height <= maxBottomLimit) {
    return {
      left,
      top: belowTop,
      maxHeight: fitMaxHeight(maxBottomLimit - belowTop, belowTop),
      placedAbove: false,
    };
  }
  // 上翻要求「顶边不低于可视区顶」且「底边不越过可视区底」——只查前一半的话，
  // 锚点本身掉在可视区外时上翻会连人带面板一起跑到屏幕上方去。
  if (aboveTop >= minTop && aboveTop + height <= maxBottomLimit) {
    return {
      left,
      top: aboveTop,
      maxHeight: fitMaxHeight(localTop - gap - minTop, aboveTop),
      placedAbove: true,
    };
  }

  // 上下都放不下（面板比可用区还高）：就地夹取，靠 maxHeight 滚动。
  const clampedTop = clamp(belowTop, minTop, maxTop);

  return {
    left,
    top: clampedTop,
    maxHeight: fitMaxHeight(maxBottomLimit - clampedTop, clampedTop),
    placedAbove: false,
  };
}
