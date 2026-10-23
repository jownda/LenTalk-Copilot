<div align="center">

<img src="./src-tauri/icons/128x128@2x.png" width="112" height="112" alt="LenTalk" />

# LenTalk · 分镜助手

**一块无限画布，把一部片子从剧本拆到成片。**

节点式生成 · 本地扒剧本 · 3D 预演 · 多平台接入

<p>
  <a href="https://github.com/jownda/LenTalk-Copilot/releases/latest">
    <img src="https://img.shields.io/github/v/release/jownda/LenTalk-Copilot?style=flat-square&color=4f46e5&label=release" alt="Latest Release" />
  </a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-22c55e?style=flat-square" alt="Platform" />
  <img src="https://img.shields.io/badge/Tauri-2-FFC131?style=flat-square&logo=tauri&logoColor=black" alt="Tauri 2" />
  <img src="https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React 18" />
  <a href="https://github.com/jownda/LenTalk-Copilot/stargazers">
    <img src="https://img.shields.io/github/stars/jownda/LenTalk-Copilot?style=flat-square&color=f59e0b" alt="Stars" />
  </a>
</p>

<p>
  <a href="https://github.com/jownda/LenTalk-Copilot/releases/latest"><b>下载最新版</b></a> ·
  <a href="#-五分钟上手">五分钟上手</a> ·
  <a href="#-支持的平台">支持的平台</a> ·
  <a href="#-从源码构建">从源码构建</a>
</p>

</div>

---

## 这是什么

LenTalk 是一个**跑在本机的 AI 分镜工作台**：所有生成结果、素材、剧本都落在你自己电脑上，不经过任何中台。

它不做「一键成片」这种黑盒，而是把一部片子拆成一张**可读、可改、可回滚**的节点图：剧本、分镜、图片、视频、音频节点排布在无限画布上，用连线表达"谁是谁的上游"。你可以只跑其中一段，也可以整条链路重跑。

> 从早期开源分镜项目 **Storyboard-Copilot** 演进而来，现在是一个长期迭代的个人项目。

## ✨ 核心能力

<table>
<tr>
<td width="50%" valign="top">

**🎬 无限画布 · 16 种节点**

本地上传 / AI 图片 / AI 视频 / AI 音频 / 媒体 / 文本 / 分组 / 分镜节点 / 分镜生成 / 360 全景 / 3D 导演台 / 提示词工作室 / 提示词优化 / 动作控制 / 无缝拼图 / 导出。

框选批量连线、`@` 引用上游素材、分组冻结、等比缩放、自动避让落位。

</td>
<td width="50%" valign="top">

**🎥 多平台视频生成**

一套节点接 10+ 家视频协议，按 Base URL 自动识别链路；时长、分辨率、画幅按型号的真实档位收敛，节点上直接显示**本次报价**（按秒 / 按条、分辨率分档）。

失败可续查、任务落库，关掉窗口不丢。

</td>
</tr>
<tr>
<td valign="top">

**📖 本地扒剧本**

内置 Python 引擎：抽帧 + 双模型识别（视觉看画面、音频听台词），产出一集可直接开拍的分镜剧本；支持断点续查、双模型缓存、角色表对齐。

也可以反向用：`扒视频 → 改剧本 → 生成分镜 → 出图`。

</td>
<td valign="top">

**🤖 AI Agent 直接操作画布**

对话即可建节点、连线、触发上下游生成。**付费操作一律先报价、再确认**；算不出来的价格标「未知」，不当作 0。

</td>
</tr>
<tr>
<td valign="top">

**🧍 3D 导演台**

Three.js + Mixamo 素模，摆放走位、调机位与焦距，先在 3D 里把镜头关系试对，再出图。

</td>
<td valign="top">

**🗂️ 素材库 / 资产库 / 提示词库**

图片、视频、音频分类管理，拖入画布即成节点；资产库管角色与道具，提示词库沉淀可复用描述。全库可 zip 备份与恢复。

</td>
</tr>
</table>

## 🧩 节点一览

| 节点 | 作用 |
|---|---|
| **本地上传** | 本地图片 / 视频 / 音频入画布，按画面比例锁定尺寸 |
| **AI 图片** | 文生图 / 图生图，支持参考图与局部编辑 |
| **AI 视频** | 文生视频 / 图生视频 / 首尾帧；可带参考图、参考视频、参考音频 |
| **AI 音频** | 语音合成，支持音色参考 |
| **媒体** | 音视频媒体节点：播放、抽帧、封面选取 |
| **文本** | 剧本 / 提示词 / 备注，可直接作为上游文本喂给生成节点 |
| **分组** | 归档节点，可冻结锁定 |
| **分镜节点** | 一张长图按 N×M 切成格子，逐格修图与重排 |
| **分镜生成** | 按剧本产出一组分镜图，保持风格与人物一致 |
| **360 全景** | 全景查看与取景 |
| **3D 导演台** | 素模走位与机位预演 |
| **提示词工作室** | 结构化编写电影级提示词（场景 / 站位 / 运镜 / 动作 / 光线），生成后直连视频节点 |
| **提示词优化** | 一句话扩写成可用提示词，也能从图片反推 |
| **动作控制** | 骨骼姿势、动作迁移与对口型 |
| **无缝拼图** | 多段结果拼成一张长图 |
| **导出** | 生成结果落地为独立节点，参与下游引用 |

## 🌐 支持的平台

在 **设置 → 密钥 → 推荐平台** 里点一下即可预填 Base URL 与模型清单；也可以手动添加任意 **OpenAI 兼容**平台。

| 平台 | 主要能力 |
|---|---|
| 知鸟 AI（TokenGo） | 图片 / 视频 / 音频 / 对话，参考素材自动上传换 URL |
| 炳火 API | 图片 / 视频，按秒或按条的渠道矩阵 |
| WGSPAI | 视频多族接口（含任务族），时长与画幅按型号收敛 |
| 字子动画 | 图片 / 视频 / 对口型 |
| RunningHub（国际站 / 国内站） | 端点即模型，覆盖可灵 / Seedance / Sora / Veo / Vidu / 万相 |
| 帧间 API | 图片 / 视频统一异步任务，参考素材换 asset id |
| 灵柯 AI | 视频两套协议（本站信封 + 火山方舟格式） |
| Dramaya | Seedance 2.0 / 2.5 分渠道、MiniMax H3；参数按型号白名单自适应 |
| Sub2API 视频 | Seedance 图生视频，幂等键 + 签名成片 |
| ModelScope · FHL · COMFly · EXELLOME · 65535 | 图像为主，含 GPT-Image 系列与 Nano Banana |

> 视频链路按 **Base URL** 判定协议，不看平台名字 —— 平台改名、换白标域名都不会串链。
> 隐藏某个平台的卡片不会影响已有配置继续工作。

## 📥 下载安装

前往 **[Releases](https://github.com/jownda/LenTalk-Copilot/releases/latest)** 下载：

| 平台 | 安装包 |
|---|---|
| Windows | `.exe`（NSIS 安装） / `.msi`（批量分发） |
| macOS | `.dmg` |

**系统要求**：Windows 10 1809+ / macOS 10.15+。

<details>
<summary><b>Windows 7 / 8 为什么装不了</b></summary>

两条硬限制，应用层绕不过：

1. Tauri v2 依赖 WebView2，微软自 WebView2 110 起不再支持 Win7 / 8.1；
2. Rust 1.78+ 的产物依赖 Windows 10 才有的 `bcryptprimitives.dll!ProcessPrng`，在 Win7 上直接报「无法定位程序输入点 ProcessPrng」。

安装包会检测并中止安装，不会装出一个跑不起来的程序。

</details>

<details>
<summary><b>macOS 首次打开被拦怎么办</b></summary>

安装包未做 Apple 公证（个人分发，未购买开发者证书），首次运行会被 Gatekeeper 拦住：

- 提示「无法验证开发者」→ 右键应用 → **打开** → **仍要打开**（只需一次）。
- 提示「已损坏，无法打开」→ 这是下载隔离标记，执行一次：

  ```bash
  sudo xattr -rd com.apple.quarantine /Applications/LenTalk.app
  ```

这不影响自动更新的安全性：更新走 Tauri updater 的 ed25519 签名校验，与 Apple 公证是两套独立机制。

</details>

**自动更新**：启动后按「自建更新源 → GitHub 兜底」检查新版本，签名校验通过后自动下载安装。

## 🚀 五分钟上手

1. **新建项目** → 画布中央双击，或右键菜单选择节点类型。
2. **配密钥** → 设置 → 密钥：选一个推荐平台，粘贴 API Key，点「拉取模型」。
3. **跑第一张图** → 拖入「AI 图片」节点，写提示词、选模型、点生成。
4. **连起来** → 从图片节点右侧端口拖到新节点，结果自动作为下游参考。
5. **扒一条片子** → 视频节点工具栏点「扒视频」，选视觉 / 音频模型。**扒取在后台继续，关掉卡片也不中断**；跑完剧本节点自动挂到视频右侧。

## 🛠️ 从源码构建

需要 **Node.js 20+**、**Rust stable** 与 Tauri 系统依赖（Windows：VS Build Tools + WebView2；macOS：Xcode CLT）。

```bash
npm install          # 安装依赖
npm run tauri dev    # 桌面端开发模式（热更新）
```

```bash
npm run build        # 类型检查 + 前端构建
npm run tauri build  # 打当前平台安装包
```

产物在 `src-tauri/target/release/bundle/`（Windows：`nsis/`、`msi/`；macOS：`dmg/`）。

**测试**：`npm run test`（vitest）、`cargo test --lib`（Rust）。

## 📦 发版

1. 同步五处版本号：`package.json`、`package-lock.json`（含 `packages[""]`）、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`
2. 本地校验：`tsc` → `vitest` → `vite build` →（改过 Rust 时）`cargo test --lib`
3. 推送 `main`，打附注 tag `vX.Y.Z` 并推送
4. [GitHub Actions](./.github/workflows/build-releases.yml) 在 Windows / macOS 云构建并发布到 Releases

> 自建更新源的目录结构、根清单切换与推送细节见 [`deploy/ota-source/README.md`](./deploy/ota-source/README.md)；Windows 单独构建说明见 [`BUILD-WINDOWS.md`](./BUILD-WINDOWS.md)。

## 🧰 技术栈

| 层 | 选型 |
|---|---|
| 桌面框架 | Tauri 2（Rust 后端 + 系统 WebView） |
| 前端 | React 18 · TypeScript · Vite · Tailwind CSS |
| 画布 | React Flow · Konva |
| 3D | Three.js · @react-three/fiber |
| 状态 | Zustand |
| 本地数据 | SQLite（项目 / 任务 / 素材索引） |
| 脚本引擎 | 内置 Python 运行时（抽帧 / 识别 / 剧本） |
| 国际化 | i18next（中 / 英） |

## 📁 目录结构

```
src/                 前端
  features/
    canvas/          画布、节点、连线、落位、生成链路
    cinematicStudio/ 提示词工作室（引擎 / 规则 / 资产）
    pajuben/         扒剧本：面板、模型选择、后台任务
    agent/           AI Agent 与画布工具协议
    library/         素材库 / 资产库
    threeDDirector/  3D 导演台
    settings/        平台预设、价格、设置页
src-tauri/           Rust 后端
  src/ai/providers/  各平台协议实现（图片 / 视频 / 音频）
  resources/pajuben/ 扒剧本引擎（Python）
browser-extension/   素材捕手（浏览器扩展）
deploy/ota-source/   自建更新源
```

## ❓ 常见问题

<details>
<summary><b>生成一直转圈 / 报「等待超时」</b></summary>

视频任务在平台侧通常要几分钟。任务已落库，关掉窗口不会丢，重新打开画布会续查。若平台已扣费但一直无结果，先去该平台后台确认任务状态，**不要重复提交**（会产生二次扣费）。

</details>

<details>
<summary><b>提示「unsupported published model parameter」</b></summary>

部分中转平台会按型号校验参数白名单。适配层会自动改名（如 `seconds → duration`）或剔除该字段后重试，并在错误里注明调整了什么。若仍失败，把错误原文发 Issue。

</details>

<details>
<summary><b>换电脑 / 重装怎么迁移</b></summary>

素材库支持 zip 备份与恢复（含提示词库、资产库）。项目数据在应用数据目录的 SQLite 里，迁移时一并拷走。

</details>

## 📄 许可与致谢

个人项目，仓库未附开源许可证，**转载请注明出处**；二次分发或商业使用请先联系作者。

感谢这些开源项目让这个应用成为可能：

[Tauri](https://tauri.app) · [React Flow](https://reactflow.dev) · [Three.js](https://threejs.org) · [Zustand](https://github.com/pmndrs/zustand) · [Tailwind CSS](https://tailwindcss.com) · [Konva](https://konvajs.org) · [i18next](https://www.i18next.com)

界面上的若干交互形态参考过开源画布项目 [hero8152/Infinite-Canvas](https://github.com/hero8152/Infinite-Canvas)（仅作功能与交互参考，代码为独立实现）。

---

<div align="center">

**如果它对你有用，点个 ⭐ 就是最好的支持。**

<a href="https://github.com/jownda/LenTalk-Copilot/issues">反馈问题</a> ·
<a href="https://github.com/jownda/LenTalk-Copilot/releases">更新日志</a>

</div>
