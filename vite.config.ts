import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import path from "path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
const appVersion = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version ?? "0.0.0";
const requiredMixamoCharacters = ["camille.fbx", "soldier.glb"];
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

  build: {
    // 大依赖各自成 chunk：首屏只需要主包 + 真正用到的那几个。
    // 没有这段时全部打进单个 4.9MB 的 index-*.js，改一行代码整个包缓存全失效，
    // 解析也是一个几 MB 的脚本一口气跑完。
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          // three 故意不单独分包：它只被「全景节点 / 3D 导演台 / 全景查看器」这几个
          // 懒加载模块用到，交给 Rollup 自然切成共享 chunk（three.module-*.js），
          // 首屏就不会预加载它。强行指定 chunk 名反而会让入口静态导入它。
          if (/[\\/]node_modules[\\/](konva|react-konva)[\\/]/.test(id)) return "vendor-konva";
          if (/[\\/]node_modules[\\/]zod[\\/]/.test(id)) return "vendor-zod";
          if (/[\\/]node_modules[\\/]jszip[\\/]/.test(id)) return "vendor-jszip";
          if (/[\\/]node_modules[\\/]@xyflow[\\/]/.test(id)) return "vendor-flow";
          if (
            /[\\/]node_modules[\\/](react-markdown|remark-[a-z-]+|micromark[a-z-]*|mdast-[a-z-]+|hast-[a-z-]+|unified|unist-[a-z-]+)[\\/]/.test(
              id,
            )
          ) {
            return "vendor-markdown";
          }
          return undefined;
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    // Tauri 探测的是 tauri.conf.json 里的 devUrl(http://127.0.0.1:1420)。
    // 若这里用 `false`(即 localhost), 在 IPv6 优先解析的机器上 Node 只会绑 [::1],
    // 导致 Tauri 永远等不到 dev server。显式绑 127.0.0.1 以保证两者一致。
    host: host || "127.0.0.1",
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
