import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { RhtvParamSpec } from '@/commands/rhtvCli';

/**
 * RunningHub **画布** CLI（`rhtvcli`）的本地状态。
 *
 * 为什么不复用 `runningHubCliStore`：那个 store 管的是标准模型 API 的 `rh`（默认值就是
 * `'rh'`）。两个 CLI 是不同的二进制、不同子命令，共用一份 executable 会让画布链路实际
 * 去调 `rh`，报错还很难看出来。所以这里独立一份，默认空值 = 让 Rust 侧自动探测。
 */
interface RhtvCanvasState {
  executable: string;
  setExecutable: (executable: string) => void;
  /**
   * 模型的参数清单缓存：`modelCode -> { hash, params }`。
   *
   * 必须持久化 —— 每个模型要跑一次 CLI 拿 schema，140 个模型首屏要几十秒；
   * 缓存按目录给的 `schemaHash` 失效，画布上新或改参数时会自动重拉。
   */
  specs: Record<string, { hash?: string; params: RhtvParamSpec[] }>;
  setSpecs: (next: Record<string, { hash?: string; params: RhtvParamSpec[] }>) => void;
  clearSpecs: () => void;
}

export const useRhtvCanvasStore = create<RhtvCanvasState>()(
  persist(
    (set) => ({
      executable: '',
      setExecutable: (executable) => set({ executable: executable.trim() }),
      specs: {},
      setSpecs: (next) => set({ specs: next }),
      clearSpecs: () => set({ specs: {} }),
    }),
    {
      name: 'lentalk-rhtv-canvas',
      partialize: ({ executable, specs }) => ({ executable, specs }),
    }
  )
);
