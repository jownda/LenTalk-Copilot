import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * 一个 LenTalk 工程 ↔ 一张即梦画布的绑定。
 *
 * 只存定位信息（projectId 是唯一权威），名称只用来在设置里展示 —— 用户在官网上
 * 改了画布名，这里不会跟着变，也不该因此重建画布。
 */
export interface JimengCanvasBinding {
  projectId: string;
  /** 建这张画布时用的名字（`LenTalk-<工程名>-<工程 id 前 8 位>`） */
  name: string;
  /** 毫秒时间戳；用于设置页展示「什么时候建的」 */
  boundAt: number;
}

// 凭据永远留在 CLI 自己的登录态里（`auth login` 写入的 profile），不进这个 store。
export const useJimengCanvasCliStore = create<{
  executable: string;
  /**
   * `LenTalk 工程 id` → 画布绑定。
   *
   * 为什么要在本地记账而不是每次都去 `canvas ls` 里按名字找：`canvas ls` 每次都要起
   * 一次 CLI（联网自检十几秒），而生成前本来就慢，再叠一次就明显了。而且画布名允许重名
   * （本机历史上就出现过两张都叫 `LenTalk` 的画布），靠名字匹配随时可能挑错。
   */
  bindings: Record<string, JimengCanvasBinding>;
  setExecutable: (executable: string) => void;
  setBinding: (projectKey: string, binding: JimengCanvasBinding) => void;
  /** 只解绑本地记账，**不删**云端画布（CLI 也没有删除命令）。 */
  clearBinding: (projectKey: string) => void;
}>()(
  persist(
    (set) => ({
      executable: "dreamina-canvas",
      bindings: {},
      setExecutable: (executable) => set({ executable: executable.trim() || "dreamina-canvas" }),
      setBinding: (projectKey, binding) =>
        set((state) => ({
          bindings: { ...state.bindings, [projectKey]: binding },
        })),
      clearBinding: (projectKey) =>
        set((state) => {
          if (!state.bindings[projectKey]) return state;
          const next = { ...state.bindings };
          delete next[projectKey];
          return { bindings: next };
        }),
    }),
    {
      name: "lentalk-jimeng-canvas-cli",
      partialize: ({ executable, bindings }) => ({ executable, bindings }),
    }
  )
);
