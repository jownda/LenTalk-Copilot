import { describe, expect, it } from 'vitest';

import {
  NODE_PICKER_MARGIN_PX,
  PICKER_ANCHOR_GAP_PX,
  PICKER_FALLBACK_ANCHOR,
  measureOffsetWithin,
  normalizeZoom,
  resolveNodePickerPlacement,
  resolvePointerAnchor,
  resolveViewportBounds,
  toUnscaledLength,
  type NodePickerPlacementInput,
} from './nodeReferencePickerLayout';

/** 一块 320×260 的节点卡片，面板 140×120，定位父级与容器重合（偏移 0）。 */
function baseInput(overrides: Partial<NodePickerPlacementInput> = {}): NodePickerPlacementInput {
  return {
    anchorLeft: 40,
    anchorTop: 40,
    panelWidth: 140,
    panelHeight: 120,
    containerWidth: 320,
    containerHeight: 260,
    parentOffsetLeft: 0,
    parentOffsetTop: 0,
    zoom: 1,
    ...overrides,
  };
}

describe('resolveNodePickerPlacement', () => {
  it('places the panel below the anchor with a readable gap', () => {
    const placement = resolveNodePickerPlacement(baseInput());

    expect(placement.left).toBe(40);
    expect(placement.top).toBe(40 + PICKER_ANCHOR_GAP_PX);
    expect(placement.placedAbove).toBe(false);
  });

  it('shifts the panel left instead of letting it poke out of the card on the right', () => {
    // 光标贴着卡片右侧：40 + 140 + 40 = 220 已经越过 320 - margin。
    const placement = resolveNodePickerPlacement(baseInput({ anchorLeft: 300 }));

    expect(placement.left).toBe(320 - NODE_PICKER_MARGIN_PX - 140);
    expect(placement.left + 140).toBeLessThanOrEqual(320 - NODE_PICKER_MARGIN_PX);
  });

  it('keeps the panel inside the card when the anchor is at the very top-left', () => {
    const placement = resolveNodePickerPlacement(baseInput({ anchorLeft: 0, anchorTop: 0 }));

    // 锚点贴在角上时面板不能跟着贴边 —— 左边内缩 margin，纵向仍按光标下方 gap 落位。
    expect(placement.left).toBe(NODE_PICKER_MARGIN_PX);
    expect(placement.top).toBe(PICKER_ANCHOR_GAP_PX);
  });

  it('flips the panel above the anchor when there is no room below', () => {
    // 锚点离底边只剩 30px，而面板高 120 —— 下方必然放不下。
    const placement = resolveNodePickerPlacement(baseInput({ anchorTop: 220 }));

    expect(placement.placedAbove).toBe(true);
    expect(placement.top + 120).toBeLessThanOrEqual(220 - PICKER_ANCHOR_GAP_PX);
    expect(placement.top).toBeGreaterThanOrEqual(NODE_PICKER_MARGIN_PX);
  });

  it('clamps and scrolls when neither side fits', () => {
    // 面板比卡片还高：上翻也放不下，只能就地夹取并靠 maxHeight 滚动。
    const placement = resolveNodePickerPlacement(
      baseInput({ panelHeight: 400, anchorTop: 200, containerHeight: 240 }),
    );

    expect(placement.placedAbove).toBe(false);
    expect(placement.maxHeight).toBe(240 - NODE_PICKER_MARGIN_PX * 2);
    expect(placement.top).toBeGreaterThanOrEqual(NODE_PICKER_MARGIN_PX);
    expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(240);
  });

  it('subtracts the positioning parent offset before writing left/top', () => {
    // 面板的 offsetParent 是内层输入卡片，它相对节点根容器偏了 (12, 12)。
    // 锚点仍然用容器坐标系描述，写出去的 left/top 必须换算回父级坐标系。
    const placement = resolveNodePickerPlacement(
      baseInput({ anchorLeft: 60, anchorTop: 80, parentOffsetLeft: 12, parentOffsetTop: 12 }),
    );

    expect(placement.left).toBe(60 - 12);
    expect(placement.top).toBe(80 - 12 + PICKER_ANCHOR_GAP_PX);
  });

  it('never lets the panel cross the left or top edge of the card', () => {
    const placement = resolveNodePickerPlacement(
      baseInput({ anchorLeft: 2, anchorTop: 2, parentOffsetLeft: 12, parentOffsetTop: 12 }),
    );

    expect(placement.left).toBe(NODE_PICKER_MARGIN_PX - 12);
    expect(placement.top).toBeGreaterThanOrEqual(NODE_PICKER_MARGIN_PX - 12);
  });

  it('still returns a usable box when the card has no measurable size yet', () => {
    const placement = resolveNodePickerPlacement(
      baseInput({ containerWidth: 0, containerHeight: 0, anchorLeft: 0, anchorTop: 0 }),
    );

    expect(Number.isFinite(placement.left)).toBe(true);
    expect(Number.isFinite(placement.top)).toBe(true);
    expect(placement.maxHeight).toBeGreaterThan(0);
  });
});

describe('画布缩放：间距与留白必须视觉恒定', () => {
  // 回归钉子。left/top 写在「未缩放坐标」里，而用户看到的是缩放后的画面：
  // 同一个未缩放间距，画布放大时看着更远、缩小时看着更近 —— 就是
  // 「窗口放大后 @ 卡片离光标很远、节点缩小后又贴得很近」的根因。

  it('keeps the on-screen gap identical at every zoom level', () => {
    // 卡片给足空间，避开「下方放不下被夹取」那条分支 —— 这里只验折算本身。
    const card = { containerWidth: 600, containerHeight: 600, anchorTop: 40 };

    for (const zoom of [0.25, 0.5, 1, 1.5, 2, 3]) {
      const placement = resolveNodePickerPlacement(baseInput({ ...card, zoom }));
      const visualGap = (placement.top - 40) * zoom;

      expect(visualGap).toBeCloseTo(PICKER_ANCHOR_GAP_PX, 6);
    }
  });

  it('converts the gap into unscaled units instead of adding a raw 20px', () => {
    // 2x 时 20 视觉像素只占 10 未缩放像素；若直接加 20，屏幕上会变成 40。
    expect(resolveNodePickerPlacement(baseInput({ zoom: 2 })).top).toBe(40 + PICKER_ANCHOR_GAP_PX / 2);
    // 0.5x 时反过来：屏幕上的 20 像素要占 40 未缩放像素。
    expect(resolveNodePickerPlacement(baseInput({ zoom: 0.5 })).top).toBe(
      40 + PICKER_ANCHOR_GAP_PX * 2,
    );
  });

  it('scales the card-edge margin by zoom as well', () => {
    // 锚点贴在左上角：留白同样要折算，否则放大画布时面板会离卡片边越来越远。
    expect(
      resolveNodePickerPlacement(baseInput({ zoom: 2, anchorLeft: 0, anchorTop: 0 })).left,
    ).toBe(NODE_PICKER_MARGIN_PX / 2);
    expect(
      resolveNodePickerPlacement(baseInput({ zoom: 0.5, anchorLeft: 0, anchorTop: 0 })).left,
    ).toBe(NODE_PICKER_MARGIN_PX * 2);
  });

  it('still keeps the panel inside the card at extreme zoom', () => {
    for (const zoom of [0.1, 0.25, 4, 5]) {
      const placement = resolveNodePickerPlacement(baseInput({ zoom, anchorTop: 200 }));
      const margin = NODE_PICKER_MARGIN_PX / zoom;

      expect(placement.left).toBeGreaterThanOrEqual(margin - 1e-9);
      expect(placement.left + 140).toBeLessThanOrEqual(320 - margin + 1e-9);
    }
  });

  it('treats a broken zoom as 1 rather than dividing by zero', () => {
    for (const zoom of [0, -2, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      const placement = resolveNodePickerPlacement(
        baseInput({ zoom: zoom as unknown as number }),
      );

      expect(Number.isFinite(placement.left)).toBe(true);
      expect(placement.top).toBe(40 + PICKER_ANCHOR_GAP_PX);
    }
  });
});

describe('画布可视区：贴到画布底边时要自动向上弹', () => {
  // 回归钉子。收敛边界原来只有「节点卡片」—— 节点被拖到画布底部时，卡片里算下来
  // 「还剩一点空间」，可那点空间在屏幕上早被画布裁掉了，面板照旧往下弹、整块落在画布外，
  // 用户点不到任何一个候选。可视区一进边界，这种场景就会翻到锚点上方。

  /** 视口矩形用「相对容器」的未缩放坐标描述，和 resolveViewportBounds 的输出同系。 */
  const viewport = (height: number, width = 320) => ({ left: 0, top: 0, width, height });

  it('flips the panel above when the visible space below the anchor is gone', () => {
    // 卡片本身很高（400），锚点下方还有 194px —— 但那截在画布外，可视区只到 220。
    const card = { containerWidth: 320, containerHeight: 400, anchorTop: 200 };
    const withoutViewport = resolveNodePickerPlacement(baseInput(card));
    const withViewport = resolveNodePickerPlacement(baseInput({ ...card, viewport: viewport(220) }));

    expect(withoutViewport.placedAbove).toBe(false);
    expect(withViewport.placedAbove).toBe(true);
    expect(withViewport.top + 120).toBeLessThanOrEqual(220 - NODE_PICKER_MARGIN_PX);
  });

  it('never lets the panel cross the visible bottom edge', () => {
    for (const anchorTop of [0, 60, 120, 180, 240, 300]) {
      const placement = resolveNodePickerPlacement(
        baseInput({ anchorTop, viewport: viewport(260) }),
      );

      expect(Number.isFinite(placement.top)).toBe(true);
      expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(
        260 - NODE_PICKER_MARGIN_PX + 1e-9,
      );
    }
  });

  it('shrinks max-height to what is actually visible', () => {
    const placement = resolveNodePickerPlacement(
      baseInput({ panelHeight: 400, viewport: viewport(200) }),
    );

    expect(placement.maxHeight).toBe(200 - NODE_PICKER_MARGIN_PX * 2);
  });

  it('changes nothing while the whole card is already visible', () => {
    // 可视区比卡片大（左上角还探出卡片外）：边界取交集后应当和只认卡片时完全一致。
    const roomy = { left: -10, top: -10, width: 400, height: 300 };

    for (const anchorTop of [0, 100, 200]) {
      expect(resolveNodePickerPlacement(baseInput({ anchorTop, viewport: roomy }))).toEqual(
        resolveNodePickerPlacement(baseInput({ anchorTop })),
      );
    }
  });

  it('falls back to the card bounds when the viewport does not overlap the card at all', () => {
    // 卡片整个在可视区外：无论怎么放都看不见，退回卡片边界至少不比改之前更差。
    const faraway = { left: 1000, top: 1000, width: 200, height: 200 };

    expect(resolveNodePickerPlacement(baseInput({ anchorTop: 40, viewport: faraway }))).toEqual(
      resolveNodePickerPlacement(baseInput({ anchorTop: 40 })),
    );
  });

  it('keeps the flipped distance visually constant across zoom levels', () => {
    // 视口 / 锚点 / 面板高度都按 zoom 折算成未缩放坐标，等价于「屏幕上恒定大小的可视区」：
    // 可视区 200px 高、锚点距顶 120px、面板 60px 高、gap 20px —— 下方永远差一点，必须上翻。
    for (const zoom of [0.5, 1, 2]) {
      const placement = resolveNodePickerPlacement(
        baseInput({
          zoom,
          containerHeight: 400,
          anchorTop: 120 / zoom,
          panelHeight: 60 / zoom,
          viewport: viewport(200 / zoom),
        }),
      );

      expect(placement.placedAbove).toBe(true);
      // 锚点到面板底边的屏幕距离仍是一个 gap（负号 = 面板在锚点上方）。
      expect((placement.top + 60 / zoom - 120 / zoom) * zoom).toBeCloseTo(
        -PICKER_ANCHOR_GAP_PX,
        6,
      );
    }
  });
});

describe('resolveViewportBounds', () => {
  const containerRect = { left: 100, top: 50, width: 320, height: 260 };

  it('expresses the viewport in the container unscaled coordinates', () => {
    expect(
      resolveViewportBounds(containerRect, { left: 80, top: 30, width: 400, height: 300 }, 1),
    ).toEqual({ left: -20, top: -20, width: 400, height: 300 });
  });

  it('divides the screen delta by the canvas zoom', () => {
    // 画布 2x：屏幕上的 40px 在未缩放坐标里只有 20。
    expect(
      resolveViewportBounds(containerRect, { left: 80, top: 30, width: 400, height: 300 }, 2),
    ).toEqual({ left: -10, top: -10, width: 200, height: 150 });
  });

  it('treats a broken zoom as 1 instead of dividing by zero', () => {
    expect(resolveViewportBounds(containerRect, containerRect, 0)).toEqual({
      left: 0,
      top: 0,
      width: 320,
      height: 260,
    });
  });
});

describe('toUnscaledLength / normalizeZoom', () => {
  it('divides the visual length by the zoom', () => {
    expect(toUnscaledLength(20, 2)).toBe(10);
    expect(toUnscaledLength(20, 0.5)).toBe(40);
  });

  it('falls back to 1 for anything that cannot be divided by', () => {
    for (const broken of [0, Number.NaN, Number.POSITIVE_INFINITY, -1, undefined]) {
      expect(normalizeZoom(broken)).toBe(1);
    }
    expect(normalizeZoom(1.75)).toBe(1.75);
  });
});

describe('measureOffsetWithin', () => {
  /** 造一个只带 offset 三件套的假盒子；jsdom 不实现布局，只能手摆。 */
  function fakeBox(left: number, top: number, parent: HTMLElement | null): HTMLElement {
    const node = {} as HTMLElement;
    Object.defineProperty(node, 'offsetLeft', { value: left });
    Object.defineProperty(node, 'offsetTop', { value: top });
    Object.defineProperty(node, 'offsetParent', { value: parent });
    return node;
  }

  it('measures from the positioning parent instead of the element itself', () => {
    // 回归钉子：面板自身的 offsetLeft 里含它当前的 inline left（= 锚点 200）。
    // 一旦把这一项也累加进去，parentOffset 就会把锚点吞掉，面板被推到卡片外
    // —— 这正是「@ 弹出的卡片不在 @ 位置」的根因。
    const container = fakeBox(0, 0, null);
    const card = fakeBox(12, 40, container);
    const panel = fakeBox(200, 300, card);

    expect(measureOffsetWithin(panel, container)).toEqual({ left: 12, top: 40 });
  });

  it('returns zero when the panel sits directly in the container', () => {
    const container = fakeBox(0, 0, null);
    const panel = fakeBox(200, 300, container);

    expect(measureOffsetWithin(panel, container)).toEqual({ left: 0, top: 0 });
  });

  it('sums a deeper chain of offset parents', () => {
    const container = fakeBox(0, 0, null);
    const outer = fakeBox(10, 20, container);
    const inner = fakeBox(5, 7, outer);
    const panel = fakeBox(99, 99, inner);

    expect(measureOffsetWithin(panel, container)).toEqual({ left: 15, top: 27 });
  });

  it('bails out to zero when the ancestor is not on the chain', () => {
    const orphan = fakeBox(0, 0, null);
    const card = fakeBox(12, 40, null);
    const panel = fakeBox(0, 0, card);

    expect(measureOffsetWithin(panel, orphan)).toEqual({ left: 0, top: 0 });
  });

  it('keeps the panel at the anchor end to end (regression)', () => {
    // 量出的偏移交给 placement 后，面板必须落在锚点正下方，而不是塌到卡片左边。
    const container = fakeBox(0, 0, null);
    const card = fakeBox(12, 40, container);
    const panel = fakeBox(200, 300, card);
    const offset = measureOffsetWithin(panel, container);

    const placement = resolveNodePickerPlacement({
      anchorLeft: 200,
      anchorTop: 300,
      panelWidth: 140,
      panelHeight: 120,
      containerWidth: 360,
      containerHeight: 600,
      parentOffsetLeft: offset.left,
      parentOffsetTop: offset.top,
      zoom: 1,
    });

    expect(placement.left).toBe(200 - 12);
    expect(placement.top).toBe(300 - 40 + PICKER_ANCHOR_GAP_PX);
  });
});

describe('resolvePointerAnchor', () => {
  function fakeContainer(left: number, top: number): HTMLElement {
    return {
      getBoundingClientRect: () => ({ left, top }) as DOMRect,
    } as unknown as HTMLElement;
  }

  it('converts a viewport click into container-local coordinates', () => {
    const anchor = resolvePointerAnchor(fakeContainer(100, 50), 180, 130, 1);

    expect(anchor).toEqual({ left: 80, top: 80 });
  });

  it('divides the container delta by the canvas zoom', () => {
    // 画布放大到 2x 时，屏幕上的 160px 在节点本地坐标里只有 80px。
    const anchor = resolvePointerAnchor(fakeContainer(100, 50), 260, 210, 2);

    expect(anchor).toEqual({ left: 80, top: 80 });
  });

  it('treats a broken zoom value as 1 and clamps negatives to 0', () => {
    expect(resolvePointerAnchor(fakeContainer(100, 50), 90, 40, 0)).toEqual({ left: 0, top: 0 });
    expect(resolvePointerAnchor(fakeContainer(100, 50), 120, 70, Number.NaN)).toEqual({
      left: 20,
      top: 20,
    });
  });

  it('falls back to the node corner when there is no container', () => {
    expect(resolvePointerAnchor(null, 500, 500, 1)).toEqual(PICKER_FALLBACK_ANCHOR);
  });
});
