import { describe, expect, it } from "vitest";

import { createLatestTaskQueue } from "./latestTaskQueue";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createLatestTaskQueue", () => {
  it("空闲时立刻开工，不等防抖", async () => {
    const seen: number[] = [];
    const queue = createLatestTaskQueue<number>((value) => {
      seen.push(value);
    });
    queue.push(1);
    expect(queue.isBusy()).toBe(true);
    await tick();
    expect(seen).toEqual([1]);
    expect(queue.isBusy()).toBe(false);
  });

  it("处理中连续推入只保留最后一个（中间值丢弃）", async () => {
    const seen: number[] = [];
    const holder: { release: (() => void) | null } = { release: null };
    const queue = createLatestTaskQueue<number>((value) => {
      seen.push(value);
      return new Promise<void>((resolve) => {
        holder.release = resolve;
      });
    });

    queue.push(1);
    await tick();
    expect(seen).toEqual([1]);

    // 正在算第 1 个的时候，用户又拖到 2、3、4、5
    queue.push(2);
    queue.push(3);
    queue.push(4);
    queue.push(5);
    expect(queue.isBusy()).toBe(true);

    holder.release?.();
    await tick();
    holder.release?.();
    await tick();

    // 只补算最后一个，不会把 2、3、4 逐个补完（那样会明显延迟）
    expect(seen).toEqual([1, 5]);
    expect(queue.isBusy()).toBe(false);
  });

  it("最终一帧一定会算（不会因为 busy 丢掉最后一次拖动）", async () => {
    let latest = 0;
    const holder: { release: (() => void) | null } = { release: null };
    const queue = createLatestTaskQueue<number>((value) => {
      return new Promise<void>((resolve) => {
        holder.release = () => {
          latest = value;
          resolve();
        };
      });
    });

    queue.push(10);
    await tick();
    queue.push(20);
    queue.push(30);
    holder.release?.();
    await tick();
    holder.release?.();
    await tick();

    expect(latest).toBe(30);
  });

  it("worker 抛错不会卡住队列", async () => {
    const seen: number[] = [];
    const queue = createLatestTaskQueue<number>((value) => {
      seen.push(value);
      throw new Error("boom");
    });
    queue.push(1);
    await tick();
    queue.push(2);
    await tick();
    expect(seen).toEqual([1, 2]);
    expect(queue.isBusy()).toBe(false);
  });

  it("clear 丢弃待处理项", async () => {
    const seen: number[] = [];
    const holder: { release: (() => void) | null } = { release: null };
    const queue = createLatestTaskQueue<number>((value) => {
      seen.push(value);
      return new Promise<void>((resolve) => {
        holder.release = resolve;
      });
    });
    queue.push(1);
    await tick();
    queue.push(2);
    queue.clear();
    holder.release?.();
    await tick();
    holder.release?.();
    await tick();
    expect(seen).toEqual([1]);
  });
});
