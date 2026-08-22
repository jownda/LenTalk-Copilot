import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import path from "path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
const appVersion = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version ?? "0.0.0";
const localGuoAssetsAvailable = existsSync(new URL("./public/local-assets/guo-3d-assets", import.meta.url));
const requiredMixamoCharacters = ["camille.fbx", "xbot.glb", "soldier.glb"];
const localMixamoCharacterAvailable = requiredMixamoCharacters.every((fileName) =>
  existsSync(new URL(`./public/local-assets/mixamo/characters/${fileName}`, import.meta.url))
);
const requiredRobotCharacters = ["0029_male-bot-a.fbx", "0030_female-bot-a.fbx"];
const localRobotCharacterAvailable = requiredRobotCharacters.every((fileName) =>
  existsSync(new URL(`./public/local-assets/mixamo/characters/${fileName}`, import.meta.url))
);
const requiredMixamoAnimations = [
  "walk.fbx",
  "run.fbx",
  "wave.fbx",
  "walk-left.fbx",
  "sit-laugh.fbx",
  "lazy-old-man.fbx",
  "stumble-fall.fbx",
  "squat-stand.fbx",
];
const localMixamoAnimationsAvailable = requiredMixamoAnimations.every((fileName) =>
  existsSync(new URL(`./public/local-assets/mixamo/animations/${fileName}`, import.meta.url))
);

// https://vite.dev/config/
/// <reference types="vitest/config" />
export default defineConfig(async () => ({
  plugins: [react()],

  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __LOCAL_GUO_ASSETS_AVAILABLE__: JSON.stringify(localGuoAssetsAvailable),
    __LOCAL_MIXAMO_CHARACTER_AVAILABLE__: JSON.stringify(localMixamoCharacterAvailable),
    __LOCAL_ROBOT_CHARACTER_AVAILABLE__: JSON.stringify(localRobotCharacterAvailable),
    __LOCAL_MIXAMO_ANIMATIONS_AVAILABLE__: JSON.stringify(localMixamoAnimationsAvailable),
  },

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
