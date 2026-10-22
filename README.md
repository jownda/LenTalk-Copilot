<div align="center">
  <img src="./src-tauri/icons/128x128@2x.png" width="100" height="100" alt="LenTalk" />
  <h1>LenTalk · 分镜助手</h1>
  <p>基于无限画布的 AI 分镜工作台 —— 一站式完成图片生成、分镜规划、3D 预演与素材管理</p>

  <p>
    <a href="https://github.com/jownda/LenTalk-Copilot/releases/latest">
      <img src="https://img.shields.io/github/v/release/jownda/LenTalk-Copilot?style=for-the-badge&color=4f46e5" alt="Latest Release" />
    </a>
    <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-22c55e?style=for-the-badge" alt="Platform" />
    <img src="https://img.shields.io/badge/version-1.0.0-f97316?style=for-the-badge" alt="Version" />
  </p>
</div>

---

## ✨ 核心特性

| | 功能 | 说明 |
|---|------|------|
| 🎨 | **AI 图像生成** | 节点式画布，多模型提供商接入，生成后可继续编辑 |
| 🖼️ | **无限画布** | 自由布局分镜节点、连线组织叙事流，支持缩放平移与框选 |
| 🎬 | **3D 导演台** | 内置人体素体、姿势系统、摄像机与几何体，在 3D 空间预演分镜 |
| 📚 | **素材库** | 图片 / 视频 / 音频分类管理，支持拖拽入画布、智能分类与 zip 备份恢复 |
| 💡 | **提示词库** | 沉淀常用提示词，一键应用到生成节点 |
| 🗂️ | **项目管理** | 多项目隔离，独立保存与切换 |
| 🌗 | **主题与多语言** | 暗色 / 亮色主题，中英双语切换 |
| ⌨️ | **快捷键系统** | 高频操作全键盘可达，可自定义 |

## 📥 下载安装

<div align="center">

| 平台 | 安装包 | 说明 |
|------|--------|------|
| **Windows** | `.exe`（NSIS 安装包） | 双击安装，建议安装 [WebView2 运行时](https://developer.microsoft.com/zh-cn/microsoft-edge/webview2) |
| **Windows** | `.msi` | 企业批量分发用 |
| **macOS** | `.dmg` | 双击挂载，拖入「应用程序」安装 |

👉 **[前往 Releases 下载最新版本](https://github.com/jownda/LenTalk-Copilot/releases/latest)**

</div>

> **系统要求**：**Windows 10 1809 及以上** / macOS 10.15 及以上。
>
> ⚠️ **Windows 7 / 8 / 8.1 无法运行**，安装包会直接提示并中止安装。原因是两条硬性限制，应用代码无法绕过：
> 1. Tauri v2 依赖 Microsoft Edge WebView2 运行时，微软自 WebView2 110 / SDK 1.0.1519.0 起不再支持 Win7 与 8/8.1（109 是最后一个支持版本，已停止更新）；
> 2. Rust 1.78+ 生成的程序依赖 Windows 10 才有的 `bcryptprimitives.dll!ProcessPrng`，在 Win7 上会直接报「无法定位程序输入点 ProcessPrng」，进程连启动阶段都进不去。

应用内置**自动更新**（Tauri updater + ed25519 签名校验）：启动后按「**自建更新源 → GitHub 镜像兜底**」的顺序
检查新版本，签名校验通过后自动下载并安装，无需手动重装。分发链路与运维说明见
[`deploy/ota-source/README.md`](./deploy/ota-source/README.md)。

> **macOS 首次打开被拦**：安装包未做 Apple 公证（详见下方说明），首次运行会被 Gatekeeper 挡住。
>
> - 提示「**无法验证开发者**」→ 在应用上右键 → **打开** → **仍要打开**（只需一次）。
> - 提示「**"LenTalk"已损坏，无法打开。你应该将它移到废纸篓**」→ 右键那招无效，这是下载隔离标记（quarantine）导致的。执行一次：
>
>   ```bash
>   sudo xattr -rd com.apple.quarantine /Applications/LenTalk.app
>   ```
>
>   （装到别处就把路径换成实际位置；把它拖到终端窗口里可自动补全路径。校验是否已清除：`xattr -l /Applications/LenTalk.app` 应无输出。）
>
> 为什么要这样做：应用未购买 Apple 开发者证书（$99/年）与公证服务，属于个人分发。
> **这不影响自动更新的安全性** —— 应用更新走 Tauri updater 自己的 ed25519 签名校验，与 Apple 公证是两套独立机制。
> 每次发新版首次安装都需重复上述一次，之后的自动更新不需要。

## 🛠️ 本地开发

需要环境：**Node.js 20+**、**Rust（stable）**、Tauri 系统依赖（macOS: Xcode CLT / Windows: VS Build Tools + WebView2）

```bash
# 安装依赖
npm install

# 启动开发模式（热更新）
npm run dev

# 桌面端开发运行（Tauri）
npm run tauri dev
```

## 📦 打包构建

```bash
# 类型检查 + 前端构建
npm run build

# 打桌面安装包（当前平台）
npm run tauri build
```

产物位置：
- macOS：`src-tauri/target/release/bundle/dmg/`
- Windows：`src-tauri/target/release/bundle/nsis/`（`.exe`）与 `bundle/msi/`（`.msi`）

> 仓库已配置 [GitHub Actions](./.github/workflows/build-releases.yml)：推送 `v*` 标签或手动触发，
> 自动在 Windows / macOS 云构建并发布安装包到 Releases。

## 🚀 发布流程

1. 同步改**五处**版本号：`package.json`、`package-lock.json`（顶层 + `packages[""]`）、
   `src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`
2. 本机验证：`tsc` → `vitest` → `vite build` →（有 Rust 改动时）`cargo test --lib`
3. 提交 + 打**附注 tag** `vX.Y.Z`，推送 `main` 与 tag
4. CI 构建完成后核对 GitHub Release 资产**按平台成组**，并确认自建源三份根清单已切到新版本

> ⚠️ 本机 `git push` 写通道不可用（`Connection was reset`），推送走 Git Data API。
> 详细步骤、`--dry-run` 的「删除 0」判据、大文件与 OTA 同步的坑，见
> [`deploy/ota-source/README.md`](./deploy/ota-source/README.md)。

## 🧰 技术栈

<div align="center">

[![Tauri](https://img.shields.io/badge/Tauri_2-FFC131?logo=tauri&logoColor=black)](https://tauri.app) [![React](https://img.shields.io/badge/React_18-61DAFB?logo=react&logoColor=black)](https://react.dev) [![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org) [![Vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white)](https://vitejs.dev) [![Three.js](https://img.shields.io/badge/Three.js-000000?logo=three.js&logoColor=white)](https://threejs.org) [![Zustand](https://img.shields.io/badge/Zustand-7C3AED?)](https://github.com/pmndrs/zustand)

</div>

- **桌面框架**：Tauri 2（Rust 后端 + WebView 前端）
- **前端**：React 18 + TypeScript + Vite
- **画布**：React Flow / Konva
- **3D**：Three.js + @react-three/fiber
- **状态**：Zustand + TanStack Query
- **国际化**：i18next（中 / 英）

## 📄 关于

LenTalk 是个人项目，从开源分镜工具 **Storyboard-Copilot** 演进而来，按需持续迭代中。欢迎提 Issue 反馈问题或建议。
