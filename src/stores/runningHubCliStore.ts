import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const useRunningHubCliStore = create<{
  executable: string;
  setExecutable: (executable: string) => void;
}>()(
  persist(
    (set) => ({
      executable: 'rh',
      setExecutable: (executable) => set({ executable: executable.trim() || 'rh' }),
    }),
    { name: 'lentalk-runninghub-cli', partialize: ({ executable }) => ({ executable }) }
  )
);
