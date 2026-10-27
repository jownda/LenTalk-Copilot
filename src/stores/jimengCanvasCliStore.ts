import { create } from "zustand";
import { persist } from "zustand/middleware";

// 凭据永远留在 CLI 自己的登录态里（`auth login` 写入的 profile），不进这个 store。
export const useJimengCanvasCliStore = create<{
  executable: string;
  setExecutable: (executable: string) => void;
}>()(
  persist(
    (set) => ({
      executable: "dreamina-canvas",
      setExecutable: (executable) => set({ executable: executable.trim() || "dreamina-canvas" }),
    }),
    {
      name: "lentalk-jimeng-canvas-cli",
      partialize: ({ executable }) => ({ executable }),
    }
  )
);
