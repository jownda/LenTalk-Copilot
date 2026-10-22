import { describe, expect, it } from "vitest";

import { sortQuickAssetItemsNewestFirst } from "./quickAssetPickerSorting";

describe("sortQuickAssetItemsNewestFirst", () => {
  it("puts the last entry (the most recently created) first", () => {
    // 数据源按创建顺序追加：index 越大越新。
    const ordered = [{ id: "oldest" }, { id: "middle" }, { id: "newest" }];

    expect(sortQuickAssetItemsNewestFirst(ordered).map((entry) => entry.id)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);
  });

  it("never mutates the input array", () => {
    // 上游是 useMemo 出来的共享引用，原地 reverse 会污染 store 里的数组。
    const ordered = [{ id: "a" }, { id: "b" }];
    const sorted = sortQuickAssetItemsNewestFirst(ordered);

    expect(sorted).not.toBe(ordered);
    expect(ordered.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("handles empty and single-entry lists", () => {
    expect(sortQuickAssetItemsNewestFirst([])).toEqual([]);
    expect(sortQuickAssetItemsNewestFirst([{ id: "only" }]).map((entry) => entry.id)).toEqual(["only"]);
  });
});
