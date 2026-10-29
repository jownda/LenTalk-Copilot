import { describe, expect, it } from "vitest";

import { FPS_30, ticksFromSeconds } from "./mediaTime";
import {
  addTitle,
  appendClip,
  buildAdvancedRequest,
  clipRanges,
  createAdvancedState,
  duplicateClip,
  applyEasing,
  clipKeyframeTicks,
  findClipAt,
  findTitleAt,
  isIdentityTransform,
  resolveClipTransform,
  resolveDropPlan,
  resolveScaleAxes,
  minClipTicks,
  moveClipToIndex,
  moveMusic,
  moveTitle,
  removeClip,
  removeClipKeyframe,
  removeTitle,
  resetClipTransform,
  sampleClipTransform,
  sampleKeyframes,
  setClipKeyframe,
  setClipKeyframeEasing,
  setClipUniformScale,
  toggleClipKeyframe,
  updateClipTransform,
  resolveDropIndex,
  sequenceTicks,
  setMusic,
  setZoom,
  splitAt,
  timelineTicks,
  trimClipEdge,
  trimClipInToPlayhead,
  trimClipOutToPlayhead,
  trimTitleEdge,
  updateTitle,
  validateAdvancedState,
  type AdvancedEditorState,
} from "./advancedEditor";

const SEC = (seconds: number) => ticksFromSeconds(seconds);

function source(name: string, seconds = 10) {
  return { sourcePath: `/media/${name}.mp4`, sourceName: name, durationTicks: SEC(seconds) };
}

function withClips(...specs: Array<[string, number]>): AdvancedEditorState {
  let state = createAdvancedState(FPS_30);
  for (const [name, seconds] of specs) {
    state = appendClip(state, source(name, seconds));
  }
  return state;
}

describe("片段序列", () => {
  it("空时间线总长为 0", () => {
    const state = createAdvancedState(FPS_30);
    expect(sequenceTicks(state.clips)).toBe(0);
    expect(timelineTicks(state)).toBe(0);
  });

  it("追加片段后首尾相接", () => {
    const state = withClips(["a", 2], ["b", 3]);
    expect(clipRanges(state.clips).map((range) => [range.start, range.end])).toEqual([
      [0, SEC(2)],
      [SEC(2), SEC(5)],
    ]);
    expect(sequenceTicks(state.clips)).toBe(SEC(5));
  });

  it("删除片段后后面的自动前移（磁吸，不留空隙）", () => {
    let state = withClips(["a", 2], ["b", 3], ["c", 1]);
    state = removeClip(state, state.clips[0].id);
    expect(state.clips.map((clip) => clip.sourceName)).toEqual(["b", "c"]);
    expect(clipRanges(state.clips).map((range) => range.start)).toEqual([0, SEC(3)]);
  });

  it("复制片段插在它后面", () => {
    let state = withClips(["a", 2], ["b", 3]);
    const firstId = state.clips[0].id;
    state = duplicateClip(state, firstId);
    expect(state.clips.map((clip) => clip.sourceName)).toEqual(["a", "a", "b"]);
    expect(sequenceTicks(state.clips)).toBe(SEC(7));
  });
});

describe("切一刀", () => {
  it("按时间轴位置换算到源素材内切点", () => {
    let state = withClips(["a", 4]);
    // 第二段开头切：时间轴 1.5s → 片段 a 的 1.5s
    state = splitAt(state, SEC(1.5));
    expect(state.clips).toHaveLength(2);
    expect(state.clips[0].outTicks).toBe(SEC(1.5));
    expect(state.clips[1].inTicks).toBe(SEC(1.5));
  });

  it("跨片段时切在所在的那一段", () => {
    let state = withClips(["a", 2], ["b", 4]);
    state = splitAt(state, SEC(3));
    expect(state.clips.map((clip) => clip.sourceName)).toEqual(["a", "b", "b"]);
    expect(state.clips[1].outTicks).toBe(SEC(1));
    expect(state.clips[2].inTicks).toBe(SEC(1));
  });

  it("切点离边界不足最短片段时不切", () => {
    const state = withClips(["a", 4]);
    const next = splitAt(state, SEC(0.02));
    expect(next.clips).toHaveLength(1);
  });

  it("切点落在片尾时切在最后一段的末尾，不产生空片段", () => {
    const state = withClips(["a", 4]);
    const next = splitAt(state, SEC(4));
    expect(next.clips).toHaveLength(1);
  });
});

describe("拖边界", () => {
  it("拖起点右边去 = 入点变晚", () => {
    let state = withClips(["a", 4]);
    state = trimClipEdge(state, state.clips[0].id, "start", SEC(1));
    expect(state.clips[0].inTicks).toBe(SEC(1));
    expect(sequenceTicks(state.clips)).toBe(SEC(3));
  });

  it("拖起点负方向不会小于 0", () => {
    let state = withClips(["a", 4]);
    state = trimClipEdge(state, state.clips[0].id, "start", -SEC(5));
    expect(state.clips[0].inTicks).toBe(0);
  });

  it("拖终点不会压到最短片段以下", () => {
    let state = withClips(["a", 4]);
    state = trimClipEdge(state, state.clips[0].id, "end", -SEC(10));
    expect(state.clips[0].outTicks - state.clips[0].inTicks).toBe(minClipTicks(FPS_30));
  });
});

describe("拖动重排", () => {
  it("按落点算目标下标", () => {
    const state = withClips(["a", 2], ["b", 2], ["c", 2]);
    // 落在第一段左半边 → 插到 0
    expect(resolveDropIndex(state.clips, SEC(0.5))).toBe(0);
    // 落在第二段右半边 → 插到 2
    expect(resolveDropIndex(state.clips, SEC(3.5))).toBe(2);
    // 超出末尾 → 放到最后
    expect(resolveDropIndex(state.clips, SEC(99))).toBe(3);
  });

  it("移到目标下标后顺序变化、总长不变", () => {
    let state = withClips(["a", 2], ["b", 2], ["c", 2]);
    const before = sequenceTicks(state.clips);
    state = moveClipToIndex(state, state.clips[2].id, 0);
    expect(state.clips.map((clip) => clip.sourceName)).toEqual(["c", "a", "b"]);
    expect(sequenceTicks(state.clips)).toBe(before);
  });

  it("只有一个片段时不动", () => {
    const state = withClips(["a", 2]);
    const next = moveClipToIndex(state, state.clips[0].id, 0);
    expect(next.clips).toHaveLength(1);
  });
});

describe("音乐轨", () => {
  it("音乐把时间轴总长撑到它的结束点", () => {
    let state = withClips(["a", 3]);
    state = setMusic(state, { sourcePath: "/m.m4a", sourceName: "m", durationTicks: SEC(10) }, SEC(2));
    expect(sequenceTicks(state.clips)).toBe(SEC(3));
    expect(timelineTicks(state)).toBe(SEC(12));
  });

  it("拖动音乐改变起点，不会为负", () => {
    let state = setMusic(createAdvancedState(FPS_30), {
      sourcePath: "/m.m4a",
      sourceName: "m",
      durationTicks: SEC(5),
    });
    state = moveMusic(state, -SEC(3));
    expect(state.music?.startTicks).toBe(0);
    state = moveMusic(state, SEC(1.5));
    expect(state.music?.startTicks).toBe(SEC(1.5));
  });
});

describe("缩放", () => {
  it("限制在允许区间内", () => {
    let state = createAdvancedState(FPS_30);
    state = setZoom(state, 1);
    expect(state.pixelsPerSecond).toBeGreaterThanOrEqual(8);
    state = setZoom(state, 9999);
    expect(state.pixelsPerSecond).toBeLessThanOrEqual(320);
  });
});

describe("查询", () => {
  it("找到片段与它在时间轴上的起点", () => {
    const state = withClips(["a", 2], ["b", 3]);
    const hit = findClipAt(state.clips, SEC(2.5));
    expect(hit?.clip.sourceName).toBe("b");
    expect(hit?.start).toBe(SEC(2));
  });

  it("时间轴末尾归到最后一段", () => {
    const state = withClips(["a", 2], ["b", 3]);
    expect(findClipAt(state.clips, SEC(5))?.clip.sourceName).toBe("b");
  });
});

describe("校验与请求体", () => {
  it("空时间线给出 noClip", () => {
    expect(validateAdvancedState(createAdvancedState(FPS_30), "/a.mp4")).toBe("noClip");
    expect(validateAdvancedState(createAdvancedState(FPS_30), null)).toBe("missingSource");
  });

  it("正常时间线可提交", () => {
    expect(validateAdvancedState(withClips(["a", 2]), "/a.mp4")).toBeNull();
  });

  it("请求体按顺序给出源素材入出点", () => {
    let state = withClips(["a", 2], ["b", 3]);
    state = trimClipEdge(state, state.clips[1].id, "start", SEC(0.5));
    const request = buildAdvancedRequest(state);
    expect(request.clips).toEqual([
      { sourcePath: "/media/a.mp4", start: 0, end: 2 },
      { sourcePath: "/media/b.mp4", start: 0.5, end: 3 },
    ]);
    expect(request.audioMode).toBe("keep");
    expect(request.music).toBeUndefined();
  });

  it("静音模式写进 audioMode", () => {
    const state = { ...withClips(["a", 2]), muted: true };
    expect(buildAdvancedRequest(state).audioMode).toBe("mute");
  });

  it("音乐带起点与音量", () => {
    let state = withClips(["a", 5]);
    state = setMusic(state, { sourcePath: "/m.m4a", sourceName: "m", durationTicks: SEC(8) }, SEC(1.5));
    state = { ...state, musicVolume: 0.4, musicFadeIn: 0.5 };
    expect(buildAdvancedRequest(state).music).toEqual({
      sourcePath: "/m.m4a",
      start: 1.5,
      volume: 0.4,
      fadeIn: 0.5,
      fadeOut: 0,
    });
  });

  it("探测到的真实时长会把超出的出点收回来", () => {
    const state = withClips(["a", 10]);
    const request = buildAdvancedRequest(state, () => SEC(4));
    expect(request.clips[0].end).toBe(4);
  });
});

describe("文字片段", () => {
  it("加在播放头处，并且自动选中", () => {
    const state = addTitle(createAdvancedState(FPS_30), SEC(2));
    expect(state.titles).toHaveLength(1);
    expect(state.titles[0].startTicks).toBe(SEC(2));
    expect(state.selectedId).toBe(state.titles[0].id);
  });

  it("多条按起点排序，属性互不影响", () => {
    let state = addTitle(createAdvancedState(FPS_30), SEC(5));
    const second = addTitle(state, SEC(1));
    state = second;
    expect(state.titles.map((title) => title.startTicks)).toEqual([SEC(1), SEC(5)]);
    const later = state.titles[1];
    expect(updateTitle(state, later.id, { text: "改过了" }).titles[0].text).not.toBe("改过了");
  });

  it("删除后不再被选中", () => {
    const state = addTitle(createAdvancedState(FPS_30), 0);
    const id = state.titles[0].id;
    const next = removeTitle(state, id);
    expect(next.titles).toHaveLength(0);
    expect(next.selectedId).toBeNull();
  });

  it("拖起点不会小于 0", () => {
    const state = addTitle(createAdvancedState(FPS_30), SEC(1));
    const id = state.titles[0].id;
    expect(moveTitle(state, id, -SEC(5)).titles[0].startTicks).toBe(0);
  });

  it("拖右边缘改时长，起点不动", () => {
    const state = addTitle(createAdvancedState(FPS_30), SEC(1));
    const id = state.titles[0].id;
    const next = trimTitleEdge(state, id, "end", SEC(4), FPS_30);
    expect(next.titles[0].startTicks).toBe(SEC(1));
    expect(next.titles[0].durationTicks).toBe(SEC(3));
  });

  it("拖左边缘时右边缘保持不动", () => {
    const state = addTitle(createAdvancedState(FPS_30), SEC(2));
    const id = state.titles[0].id;
    const end = SEC(2) + state.titles[0].durationTicks;
    const next = trimTitleEdge(state, id, "start", SEC(3), FPS_30);
    expect(next.titles[0].startTicks).toBe(SEC(3));
    expect(next.titles[0].startTicks + next.titles[0].durationTicks).toBe(end);
  });

  it("左边缘不能被拖过右边缘（至少留最短时长）", () => {
    const state = addTitle(createAdvancedState(FPS_30), SEC(1));
    const id = state.titles[0].id;
    const next = trimTitleEdge(state, id, "start", SEC(99), FPS_30);
    expect(next.titles[0].durationTicks).toBe(minClipTicks(FPS_30));
  });

  it("按播放头找当前应显示的文字", () => {
    const state = addTitle(createAdvancedState(FPS_30), SEC(2));
    const id = state.titles[0].id;
    expect(findTitleAt(state.titles, SEC(2))?.id).toBe(id);
    expect(findTitleAt(state.titles, SEC(4))?.id).toBe(id);
    // 右边界是开区间：3 秒的片段在 5s 那一刻已经不显示了。
    expect(findTitleAt(state.titles, SEC(5))).toBeNull();
    expect(findTitleAt(state.titles, SEC(1))).toBeNull();
  });

  it("请求体带上文字，空文本不提交", () => {
    let state = addTitle(createAdvancedState(FPS_30), SEC(1));
    const id = state.titles[0].id;
    state = updateTitle(state, id, { text: "   " });
    expect(buildAdvancedRequest(state).titles).toBeUndefined();

    state = updateTitle(state, id, { text: "有字了", fontSize: 64 });
    const titles = buildAdvancedRequest(state).titles;
    expect(titles).toHaveLength(1);
    expect(titles?.[0]).toMatchObject({ text: "有字了", start: 1, fontSize: 64 });
  });
});

describe("Q/W 裁到播放线", () => {
  it("Q 把入点提到播放线（裁掉左边）", () => {
    const state = withClips(["a", 10]);
    const id = state.clips[0].id;
    // 播放线在第 3 秒：入点 0 → 3。
    const next = trimClipInToPlayhead(state, id, SEC(3));
    expect(next.clips[0].inTicks).toBe(SEC(3));
    expect(next.clips[0].outTicks).toBe(SEC(10));
    // 播放线停在片段开头（这里是第 0 秒），预览新入点那一帧。
    expect(next.playheadTicks).toBe(0);
  });

  it("W 把出点退到播放线（裁掉右边）", () => {
    const state = withClips(["a", 10]);
    const id = state.clips[0].id;
    const next = trimClipOutToPlayhead(state, id, SEC(6));
    expect(next.clips[0].inTicks).toBe(0);
    expect(next.clips[0].outTicks).toBe(SEC(6));
    // 播放线停在片段末尾（第 6 秒），预览新出点那一帧。
    expect(next.playheadTicks).toBe(SEC(6));
  });

  it("播放线不在选中片段内时不动", () => {
    const state = withClips(["a", 5], ["b", 5]);
    const id = state.clips[0].id;
    // 播放线在第 6 秒，落在第二段上，不是选中的第一段。
    expect(trimClipInToPlayhead(state, id, SEC(6)).clips[0].inTicks).toBe(0);
  });

  it("裁得太短时保持原样（至少留一帧）", () => {
    const state = withClips(["a", 10]);
    const id = state.clips[0].id;
    const minTicks = minClipTicks(FPS_30);
    // 播放线贴着入点，裁完不足一帧 → 不裁。
    const next = trimClipInToPlayhead(state, id, minTicks / 2);
    expect(next.clips[0].inTicks).toBe(0);
  });
});

describe("Q/W 播放线跟随", () => {
  it("在多段序列里裁剪，播放线仍落在被裁片段自己的时间轴区间", () => {
    const state = withClips(["a", 5], ["b", 5]);
    // 选中第二段（时间轴 5~10），播放线在 8。
    const id = state.clips[1].id;
    const q = trimClipInToPlayhead({ ...state, selectedId: id }, id, SEC(8));
    // 第二段源内 in 从 0 提到 3（8-5），播放线回到第二段时间轴起点 5。
    expect(q.clips[1].inTicks).toBe(SEC(3));
    expect(q.playheadTicks).toBe(SEC(5));
  });
});

describe("片段变换", () => {
  it("没设过的片段等于原样铺满画布", () => {
    const state = withClips(["a", 5]);
    const transform = resolveClipTransform(state.clips[0]);
    expect(transform).toMatchObject({ scale: 1, scaleX: 1, scaleY: 1, x: 0, y: 0, rotation: 0, opacity: 1, borderRadius: 0 });
    expect(isIdentityTransform(transform)).toBe(true);
  });

  it("改一个字段不会动其它字段", () => {
    const state = withClips(["a", 5]);
    const id = state.clips[0].id;
    const next = updateClipTransform(state, id, { rotation: 30 });
    const transform = resolveClipTransform(next.clips[0]);
    expect(transform.rotation).toBe(30);
    expect(transform.scale).toBe(1);
    expect(isIdentityTransform(transform)).toBe(false);
  });

  it("越界值被收敛（NaN / 超范围都不该传到后端）", () => {
    const state = withClips(["a", 5]);
    const id = state.clips[0].id;
    const next = updateClipTransform(state, id, {
      scale: 99,
      x: -999,
      opacity: -1,
      rotation: Number.NaN,
    });
    const transform = resolveClipTransform(next.clips[0]);
    expect(transform.scale).toBe(8);
    expect(transform.x).toBe(-200);
    expect(transform.opacity).toBe(0);
    // NaN 退到下限而不是留在数据里 —— 否则后端 f64 解析出 NaN，整条图会怪异地失败。
    expect(transform.rotation).toBe(-360);
  });

  it("等比缩放会同步两个轴向值（否则拖过单轴后再拖等比没反应）", () => {
    const state = withClips(["a", 5]);
    const id = state.clips[0].id;
    const stretched = updateClipTransform(state, id, { scaleX: 2 });
    expect(resolveScaleAxes(resolveClipTransform(stretched.clips[0]))).toEqual({ scaleX: 2, scaleY: 1 });

    const uniform = setClipUniformScale(stretched, id, 1.5);
    expect(resolveScaleAxes(resolveClipTransform(uniform.clips[0]))).toEqual({ scaleX: 1.5, scaleY: 1.5 });
  });

  it("重置回到默认", () => {
    const state = withClips(["a", 5]);
    const id = state.clips[0].id;
    const changed = updateClipTransform(state, id, { scale: 2, x: 10, borderRadius: 40 });
    expect(isIdentityTransform(resolveClipTransform(resetClipTransform(changed, id).clips[0]))).toBe(true);
  });

  it("请求体只带非默认字段，全默认时不带 transform", () => {
    const state = withClips(["a", 5]);
    expect(buildAdvancedRequest(state).clips[0].transform).toBeUndefined();

    const id = state.clips[0].id;
    const moved = updateClipTransform(state, id, { x: 12.5, rotation: 45 });
    const transform = buildAdvancedRequest(moved).clips[0].transform;
    expect(transform).toEqual({ x: 12.5, rotation: 45 });
  });
});

describe("关键帧", () => {
  it("缓动曲线端点固定、中点为对称", () => {
    for (const easing of ["linear", "ease-in", "ease-out", "ease-in-out"] as const) {
      expect(applyEasing(0, easing)).toBeCloseTo(0, 6);
      expect(applyEasing(1, easing)).toBeCloseTo(1, 6);
    }
    expect(applyEasing(0.5, "ease-in-out")).toBeCloseTo(0.5, 6);
    // 缓入在 0.25 处应慢于线性（二次曲线 0.0625）。
    expect(applyEasing(0.25, "ease-in")).toBeCloseTo(0.0625, 6);
    // 缓出是缓入的镜像。
    expect(applyEasing(0.75, "ease-out")).toBeCloseTo(0.9375, 6);
  });

  it("线性插值两端与中点", () => {
    const list = [
      { ticks: 0, value: 0, easing: "linear" as const },
      { ticks: SEC(2), value: 100, easing: "linear" as const },
    ];
    expect(sampleKeyframes(list, 0)).toBe(0);
    expect(sampleKeyframes(list, SEC(1))).toBe(50);
    expect(sampleKeyframes(list, SEC(2))).toBe(100);
    // 区间外保持不变（不外插）。
    expect(sampleKeyframes(list, -SEC(1))).toBe(0);
    expect(sampleKeyframes(list, SEC(9))).toBe(100);
  });

  it("打了帧的属性覆盖静态值，没打的保持静态", () => {
    const base = withClips(["a", 5]);
    const id = base.clips[0].id;
    let state = updateClipTransform(base, id, { x: 10, rotation: 45 });
    state = setClipKeyframe(state, id, "x", 0, 0);
    state = setClipKeyframe(state, id, "x", SEC(2), 100);

    const clip = state.clips[0];
    expect(sampleClipTransform(clip, 0).x).toBe(0);
    expect(sampleClipTransform(clip, SEC(1)).x).toBe(50);
    // 没打帧的 rotation 仍然用静态值。
    expect(sampleClipTransform(clip, SEC(1)).rotation).toBe(45);
  });

  it("只动 X 的帧，不影响 Y 和缩放", () => {
    const base = withClips(["a", 5]);
    const id = base.clips[0].id;
    let state = setClipKeyframe(base, id, "x", 0, 0);
    state = setClipKeyframe(state, id, "x", SEC(2), 40);
    // 静态 Y 与缩放保持原样（缩放不支持动画，见 ANIMATABLE_PROPS 注释）。
    expect(sampleClipTransform(state.clips[0], SEC(1)).y).toBe(0);
    expect(sampleClipTransform(state.clips[0], SEC(1)).scale).toBe(1);
  });

  it("删掉某一帧后曲线改按剩下的帧插值", () => {
    const base = withClips(["a", 5]);
    const id = base.clips[0].id;
    let state = setClipKeyframe(base, id, "rotation", 0, 0);
    state = setClipKeyframe(state, id, "rotation", SEC(2), 90);
    state = removeClipKeyframe(state, id, "rotation", SEC(2), minClipTicks(FPS_30) / 2);
    // 只剩一帧 → 后面全程保持不变。
    expect(sampleClipTransform(state.clips[0], SEC(1)).rotation).toBe(0);
    expect(state.clips[0].keyframes?.rotation).toHaveLength(1);
  });

  it("切换：没有就打一帧，有就删掉", () => {
    const base = withClips(["a", 5]);
    const id = base.clips[0].id;
    const added = toggleClipKeyframe(base, id, "rotation", SEC(1), 30, minClipTicks(FPS_30) / 2);
    expect(added.clips[0].keyframes?.rotation).toHaveLength(1);
    expect(added.clips[0].keyframes?.rotation?.[0]).toMatchObject({ ticks: SEC(1), value: 30 });
    const removed = toggleClipKeyframe(added, id, "rotation", SEC(1), 30, minClipTicks(FPS_30) / 2);
    // 删空了就把整条属性移除，避免留下空数组。
    expect(removed.clips[0].keyframes).toBeUndefined();
  });

  it("同一时刻重复打帧只保留一个，并按时间排序", () => {
    const base = withClips(["a", 5]);
    const id = base.clips[0].id;
    let state = setClipKeyframe(base, id, "y", SEC(2), 10);
    state = setClipKeyframe(state, id, "y", 0, -5);
    state = setClipKeyframe(state, id, "y", SEC(2), 30);
    const list = state.clips[0].keyframes?.y ?? [];
    expect(list).toHaveLength(2);
    expect(list.map((frame) => frame.ticks)).toEqual([0, SEC(2)]);
    expect(list[1].value).toBe(30);
  });

  it("改缓动只影响这一帧到下一帧", () => {
    const base = withClips(["a", 5]);
    const id = base.clips[0].id;
    let state = setClipKeyframe(base, id, "x", 0, 0);
    state = setClipKeyframe(state, id, "x", SEC(2), 100);
    state = setClipKeyframeEasing(state, id, "x", 0, "ease-in");
    // 1 秒 = 进度 0.5 → 缓入 0.25 → 值 25。
    expect(sampleClipTransform(state.clips[0], SEC(1)).x).toBeCloseTo(25, 6);
  });

  it("时间轴要画的菱形：多属性去重升序", () => {
    const base = withClips(["a", 5]);
    const id = base.clips[0].id;
    let state = setClipKeyframe(base, id, "x", SEC(2), 1);
    state = setClipKeyframe(state, id, "rotation", 0, 1);
    state = setClipKeyframe(state, id, "x", 0, 1);
    expect(clipKeyframeTicks(state.clips[0])).toEqual([0, SEC(2)]);
  });

  it("请求体按「相对片段起点的秒」提交关键帧", () => {
    const base = withClips(["a", 5]);
    const id = base.clips[0].id;
    let state = setClipKeyframe(base, id, "x", 0, 0);
    state = setClipKeyframe(state, id, "x", SEC(2), 100);
    state = setClipKeyframeEasing(state, id, "x", 0, "ease-out");
    const keyframes = buildAdvancedRequest(state).clips[0].keyframes;
    // 每一帧带自己的缓动；只有「到下一帧」那段才用到它，所以最后一帧保留默认 linear。
    expect(keyframes?.x).toEqual([
      { t: 0, v: 0, e: "ease-out" },
      { t: 2, v: 100, e: "linear" },
    ]);
  });
});

describe("拖入轨道的落点", () => {
  it("V1 落点换算成插入索引 + 该位置的起点", () => {
    const state = withClips(["a", 5], ["b", 5]);
    // 7 秒落在第二段前半 → 插到第 1 位（第一段之后），起点 5 秒。
    const plan = resolveDropPlan(state.clips, SEC(7), "video", "video", SEC(3), SEC(5));
    expect(plan).toMatchObject({ lane: "video", at: 1, startTicks: SEC(5), durationTicks: SEC(3) });
  });

  it("V1 拖到最前/最后", () => {
    const state = withClips(["a", 5], ["b", 5]);
    expect(resolveDropPlan(state.clips, 0, "video", "video", SEC(2), SEC(5))).toMatchObject({
      at: 0,
      startTicks: 0,
    });
    expect(resolveDropPlan(state.clips, SEC(99), "video", "video", SEC(2), SEC(5))).toMatchObject({
      at: 2,
      startTicks: SEC(10),
    });
  });

  it("A2 落点就是秒数（可以为 0，不能为负）", () => {
    const state = withClips(["a", 5]);
    expect(resolveDropPlan(state.clips, SEC(3), "audio", "audio", SEC(4), SEC(5))).toMatchObject({
      lane: "audio",
      at: SEC(3),
      startTicks: SEC(3),
    });
    expect(resolveDropPlan(state.clips, -SEC(3), "audio", "audio", SEC(4), SEC(5)).startTicks).toBe(0);
  });

  it("拖音频到 V1 也会归到 A2（和落子逻辑一致）", () => {
    const state = withClips(["a", 5]);
    const plan = resolveDropPlan(state.clips, SEC(2), "video", "audio", SEC(4), SEC(5));
    expect(plan.lane).toBe("audio");
    expect(plan.at).toBe(SEC(2));
  });

  it("时长没探到时用兜底值（虚线块不能是 0 宽）", () => {
    const plan = resolveDropPlan([], 0, "video", "video", 0, SEC(5));
    expect(plan.durationTicks).toBe(SEC(5));
  });
});
