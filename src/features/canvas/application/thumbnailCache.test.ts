import { describe, expect, it } from "vitest";

import {
  createTaskGate,
  isThumbnailableLocalSource,
  readThumbnail,
  resetThumbnailCache,
  resolveThumbnailConcurrency,
} from "@/features/canvas/application/thumbnailCache";

describe("isThumbnailableLocalSource", () => {
  it("接受本地文件路径（Windows 盘符 / UNC / POSIX）", () => {
    expect(isThumbnailableLocalSource(String.raw`C:\Users\a\library-assets\abc.png`)).toBe(true);
    expect(isThumbnailableLocalSource("D:/LENTALK/media/output/frame.jpg")).toBe(true);
    expect(isThumbnailableLocalSource(String.raw`\\nas\share\a.png`)).toBe(true);
    expect(isThumbnailableLocalSource("/Users/job/Pictures/a.png")).toBe(true);
    expect(isThumbnailableLocalSource("file:///C:/Users/a/b.png")).toBe(true);
  });

  it("拒绝远端地址与内联数据 —— Rust 不负责下载", () => {
    expect(isThumbnailableLocalSource("https://cdn.example.com/a.png")).toBe(false);
    expect(isThumbnailableLocalSource("http://127.0.0.1:1420/a.png")).toBe(false);
    expect(isThumbnailableLocalSource("data:image/png;base64,AAAA")).toBe(false);
    expect(isThumbnailableLocalSource("blob:http://localhost/abc")).toBe(false);
    expect(isThumbnailableLocalSource("ASSET://localhost/C:/a.png")).toBe(false);
    expect(isThumbnailableLocalSource("ipc://localhost/a")).toBe(false);
  });

  it("空值一律拒绝", () => {
    expect(isThumbnailableLocalSource("")).toBe(false);
    expect(isThumbnailableLocalSource("   ")).toBe(false);
  });
});

describe("createTaskGate", () => {
  it("同时在跑的任务不超过上限，且按入队顺序收尾", async () => {
    const gate = createTaskGate(2);
    let active = 0;
    let peak = 0;
    const finished: number[] = [];

    const tasks = [1, 2, 3, 4, 5].map((value) =>
      gate(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        finished.push(value);
        return value;
      }),
    );

    await expect(Promise.all(tasks)).resolves.toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
    expect(finished.length).toBe(5);
  });

  it("任务抛错也能释放名额，后面的任务不会被永久堵住", async () => {
    const gate = createTaskGate(1);
    const failing = gate(async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");
    await expect(gate(async () => "ok")).resolves.toBe("ok");
  });

  it("非法上限被夹到至少 1", async () => {
    const gate = createTaskGate(0);
    let active = 0;
    let peak = 0;
    await Promise.all(
      [1, 2, 3].map(() =>
        gate(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 1));
          active -= 1;
        }),
      ),
    );
    expect(peak).toBe(1);
  });
});

describe("缩略图缓存", () => {
  it("未生成过的源地址读不到缩略图", () => {
    resetThumbnailCache();
    expect(readThumbnail(String.raw`C:\a\b.png`)).toBeUndefined();
  });
});

describe("resolveThumbnailConcurrency", () => {
  it("给界面留一个核，并夹在 [2, 6] 之间", () => {
    expect(resolveThumbnailConcurrency(16)).toBe(6);
    expect(resolveThumbnailConcurrency(8)).toBe(6);
    expect(resolveThumbnailConcurrency(6)).toBe(5);
    expect(resolveThumbnailConcurrency(4)).toBe(3);
    expect(resolveThumbnailConcurrency(2)).toBe(2);
    expect(resolveThumbnailConcurrency(1)).toBe(2);
  });

  it("读不到核数时用保守默认值", () => {
    expect(resolveThumbnailConcurrency(undefined)).toBe(3);
    expect(resolveThumbnailConcurrency(0)).toBe(3);
    expect(resolveThumbnailConcurrency(Number.NaN)).toBe(3);
  });
});
