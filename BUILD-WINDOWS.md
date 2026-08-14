# Storyboard-Copilot (LenTalk) — Windows 打包说明

在 **Windows 电脑**上按以下步骤操作，产出 exe 安装包。

## 一、需要安装的环境（一次性）

1. **Node.js LTS**（22.x）
   - 下载: https://nodejs.org/ → 选 LTS 版本 → 安装时保持默认（勾选 "Add to PATH"）

2. **Rust**（MSVC 工具链）
   - 下载: https://rustup.rs/ → 下载 rustup-init.exe 运行
   - 安装时选默认（default host triple 保持 `x86_64-pc-windows-msvc`）

3. **Visual Studio Build Tools**（提供 C++ 链接器，Rust 编译必需）
   - 下载: https://visualstudio.microsoft.com/zh-hans/downloads/ → 底部选 "Build Tools"
   - 安装时勾选工作负载: **"使用 C++ 的桌面开发"**（Desktop development with C++）
   - 注意: 安装耗时较长（约 2-5GB），这是必须的

4. **WebView2 运行时**（Windows 10/11 一般已自带，无需操作；若运行报错再装）
   - https://developer.microsoft.com/microsoft-edge/webview2/

## 二、打包步骤

```bat
:: 1. 解压本项目 zip 到任意目录（路径不要有中文/空格，如 D:\storyboard）

:: 2. 打开 PowerShell 或 CMD，进入项目目录
cd D:\storyboard

:: 3. 安装前端依赖（首次约 3-10 分钟）
npm install

:: 4. 打包（自动完成前端构建 + Rust 编译，首次约 15-30 分钟）
npm run tauri build

:: 完成！安装包在:
::   src-tauri\target\release\bundle\nsis\LenTalk_0.1.13_x64-setup.exe   ← 双击安装
::   src-tauri\target\release\bundle\msi\LenTalk_0.1.13_x64_en-US.msi  ← 备用
```

## 三、常见问题

| 问题 | 解决 |
|---|---|
| `link.exe not found` / 找不到 MSVC | 没装 VS Build Tools，或装完没重启终端 |
| `'npm' 不是内部或外部命令` | Node.js 没装好或没重启终端 |
| SmartScreen 拦截安装包 | 点「更多信息」→「仍要运行」 |
| 打包卡在下载 NSIS/WiX | 网络问题，重试 `npm run tauri build`（会续传） |

## 四、可选: 走 GitHub Actions 云端打包（不用装上面任何环境）

项目已包含 `.github/workflows/build-windows.yml`：
1. 在 https://github.com/new 新建仓库（不要勾选 README）
2. 把本 zip **解压后**的所有文件拖拽上传到仓库（GitHub 网页支持批量拖拽上传，或用 Git 命令推送）
3. 仓库 → Actions → "Build Windows EXE" → Run workflow
4. 等 15-25 分钟 → 在 run 页面 Artifacts 下载 exe

> 版本号、应用名（LenTalk）、图标、NSIS 简体中文安装界面均已配置好，无需修改。
