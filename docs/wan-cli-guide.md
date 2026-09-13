# 万相 CLI 使用说明

LenTalk 通过官方 `@wan-ai/cli` 调用万相账号的视频生成能力，与即梦 CLI 分别配置。当前接入 Wan 3.0 的文生视频、参考图生视频和首尾帧生视频。

官方指南：<https://alidocs.dingtalk.com/i/nodes/kDnRL6jAJMLgNkw7tqkEa774VyMoPYe1>

## 安装和配置

安装 Node.js 后，在终端执行：

```bash
npm install --global @wan-ai/cli
wan --version
wan update --check --output json
```

国内网络可在安装命令末尾添加 `--registry=https://registry.npmmirror.com`。Windows PowerShell 如果阻止执行 `wan.ps1`，使用 `wan.cmd`，无需修改执行策略。

在 LenTalk 桌面应用中打开「设置 → 密钥 → 万相 CLI」：

1. 点击「保存路径并检测」。默认命令为 `wan`；如果未找到，可填写 `command -v wan`（Windows：`where wan`）显示的完整路径。
2. 选择国内站或国际站，打开万相账号页面，从头像 → 我的账户创建 AccessKey。
3. 输入 AccessKey，点击「保存 AccessKey 并验证」。已经在终端登录的账号可以直接检测。

AccessKey 由官方 CLI 保存到 `~/.wan/config.json`，不存入 LenTalk 设置、项目文件或代码库。CLI 需要有效万相会员；服务端返回 `4018` 时应确认会员状态。此凭据不同于 ModelScope 或百炼 API Key。

也可以由本人在终端交互登录：

```bash
wan auth login --site cn
wan auth status --output json
```

万相配置中的路径单独保存。GUI 会搜索 PATH、常见 npm 全局目录及 nvm 目录，并补充 Node.js 路径；Windows npm shim 会转为 Node.js 执行官方入口，不经过 PowerShell。

## 视频节点

模型选择「万相 CLI → Wan 3.0」：

| 输入 | 实际命令 |
| --- | --- |
| 参考模式，无图片 | `wan text2video` |
| 参考模式，1–5 张图片 | `wan reference2video --assets …` |
| 首尾帧模式，两张图片 | `wan frame2video --first-frame … --last-frame …` |

时长支持 2–30 秒，分辨率支持 480P、720P、1080P。参考模式支持 16:9、9:16、1:1、4:3、3:4；首尾帧模式按官方规则使用 adaptive，由图片决定画幅。输出音频使用 CLI 默认设置。

当前节点没有接入参考配音、上传音频、Omni、视频编辑或图片生成，连接参考音频时会提示移除。相关官方 CLI 命令仍可在终端独立使用。

## 任务和结果

提交后保存任务 ID，通过 `wan result get` 查询状态，成功后使用 `--save` 下载视频，写入正常的下游视频结果节点。结果和任务记录位于 Tauri 应用数据目录下的 `wan-cli/videos/`，使用官方默认下载行为。

每次点击生成都有独立请求 ID。同一结果节点恢复或重试时复用已有任务；下载失败后继续下载，不重新生成。新点击生成仍代表一个新任务。

如果提交响应不明确，应用保留提交记录并停止自动重提。先在终端检查：

```bash
wan task list --output json
wan result get <taskId> --output json
wan result get <taskId> --save --save-dir ./wan-results --output json
```

确认已有任务后可手动下载并导入项目，不要直接重复点击生成。没有 AccessKey 时只能验证安装、界面和 dry-run 参数，不能完成真实生成验证。
