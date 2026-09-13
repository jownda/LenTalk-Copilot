import { create } from "zustand";
import { persist } from "zustand/middleware";

// Credentials belong to the official CLI's ~/.wan/config.json, never this store.
export const useWanCliStore = create<{
  executable: string;
  setExecutable: (executable: string) => void;
}>()(
  persist(
    (set) => ({
      executable: "wan",
      setExecutable: (executable) => set({ executable: executable.trim() || "wan" }),
    }),
    { name: "lentalk-wan-cli", partialize: ({ executable }) => ({ executable }) },
  ),
);
