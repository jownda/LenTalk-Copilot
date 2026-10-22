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
::   src-tauri\target\release\bundle\nsis\LenTalk_1.2.25_x64-setup.exe    ← 双击安装
::   src-tauri\target\release\bundle\msi\LenTalk_1.2.25_x64_zh-CN.msi   ← 备用
```

> **本地打包默认不带 updater 签名产物**。若本机没有配置 `TAURI_SIGNING_PRIVATE_KEY`，
> 签名阶段会报 `A public key has been found, but no private key` 以 1 退出 ——
> 但 bundle 其实已经生成，**直接看 `bundle/nsis/` 有没有 exe 即可**。
> 想让它安静退出，可传一个覆盖配置 `{"bundle":{"createUpdaterArtifacts":false}}`：
>
> ```bat
> npx tauri build --bundles nsis --config override.json
> ```
>
> ⚠️ 这样出来的包**没有 `.sig`、与线上 OTA 清单的签名不匹配，只能自己装，不要上传到自建源**。

> ⚠️ **C 盘要留足空间**。C 盘满会同时砸掉两个看起来无关的步骤：NSIS 在 `%TEMP%` 建 ~142MB
> 内存映射（`Internal compiler error #12345: error creating mmap`）、rustc 提交内存不足
> （`rustc-LLVM ERROR: out of memory`）。构建前把临时目录指到空间充足的分区：
>
> ```bat
> set TEMP=D:\build-tmp && set TMP=D:\build-tmp && set CARGO_BUILD_JOBS=2
> ```

## 三、常见问题

| 问题 | 解决 |
|---|---|
| `link.exe not found` / 找不到 MSVC | 没装 VS Build Tools，或装完没重启终端 |
| `'npm' 不是内部或外部命令` | Node.js 没装好或没重启终端 |
| SmartScreen 拦截安装包 | 点「更多信息」→「仍要运行」 |
| 打包卡在下载 NSIS/WiX | 网络问题，重试 `npm run tauri build`（会续传） |

## 四、可选: 走 GitHub Actions 云端打包（不用装上面任何环境）

仓库已配置 [`.github/workflows/build-releases.yml`](./.github/workflows/build-releases.yml)，
在 GitHub 云端同时构建 **Windows（NSIS `.exe` + `.msi`）与 macOS（`.dmg` + updater 包）** 并发布到 Releases。

```bash
# 同步改五处版本号后，打附注 tag 推送即可触发（推 main 不触发）
git tag -a vX.Y.Z -m "LenTalk vX.Y.Z"
git push origin main vX.Y.Z
```

> 若本机 git 写通道不可用（`Connection was reset`），改走 Git Data API 推送，
> 见 [`deploy/ota-source/README.md`](./deploy/ota-source/README.md) 第 5 节。

单次构建约 **14 分钟**（Windows 编译 824s、macOS 编译 398s），产物自动挂到 Release。
完整发布流程（版本号位置、验证链、推送方式、发布后验收）见
[`deploy/ota-source/README.md`](./deploy/ota-source/README.md) 与 [README](./README.md)。

> 版本号、应用名（LenTalk）、图标、NSIS 简体中文安装界面均已配置好，无需修改。
