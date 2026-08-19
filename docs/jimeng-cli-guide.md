# 即梦 CLI（Dreamina CLI）使用与登录教程

即梦 CLI 是字节跳动即梦（Dreamina）官方的命令行工具，专为智能体/脚本调用即梦的生图、生视频能力设计。LenTalk-Copilot 通过它调用即梦生成视频（文生视频 / 图生视频 / 首尾帧 / 多模态），**不需要 API Key，直接用你的即梦账号积分**。

> 参考：即梦官方《即梦 CLI 体验指南》（飞书 wiki）：
> https://bytedance.larkoffice.com/wiki/FVTwwm0bGiishxkKOoScdHR2nsg

## ⚠️ 使用前必须知道（官方原文要点）

1. **仅高级会员以上可用**：生成任务会消耗账户权益或积分，目前仅供**高级会员以上**账号使用；
2. **积分标准**：与即梦网页端 Agent 模式下相同生成能力的积分消耗标准一致；
3. **视频生成必须先网页端生成一次**：由于合规要求，**需要先在即梦网页端完成第一次视频生成**，之后才能在 CLI 内提交视频生成任务（否则 CLI 会返回合规授权类错误，如 `AigcComplianceConfirmationRequired`）；
4. **异步任务**：大多数生成任务是异步的，提交（拿到 `submit_id`）和查询是两个步骤；
5. **排查问题**：报错日志位于 `~/.dreamina_cli/logs/`，反馈前先贴日志；优先更新 CLI 再重试（`curl -fsSL https://jimeng.jianying.com/cli | bash`）。

---

## 一、安装

官方一键安装脚本（macOS / Linux / Windows Git Bash / WSL 均支持）：

```bash
curl -fsSL https://jimeng.jianying.com/cli | bash
```

安装脚本会：

1. 从字节 CDN 下载 `dreamina` 可执行文件；
2. 安装到 `~/.dreamina_cli/`，并把目录写入你的 shell 启动文件（`~/.zshrc` / `~/.bashrc`）；
3. 同时下载官方 `SKILL.md` 到 `~/.dreamina_cli/dreamina/SKILL.md`。

安装完成后**重新打开终端**（或执行 `source ~/.zshrc`），验证：

```bash
dreamina -h
```

看到命令列表即安装成功。当前最新版本：1.4.17（2026-08-18 发布，Seedance 2.5 支持 1080p）。

> 你的机器已安装（`/Users/job/.local/bin/dreamina`，8/17 构建版本），可跳过本步。
>
> 升级到最新版：重新执行一次上面的安装命令即可。

---

## 二、登录（重点）

即梦 CLI 使用 **OAuth Device Flow（设备码登录）**：终端打印一个验证地址 + 用户码，你用浏览器打开地址、输入用户码、在即梦网页上确认授权，终端会自动完成登录。**不需要任何 API Key，登录的就是你平时的即梦账号（含积分余额）。**

### 2.1 普通登录

```bash
dreamina login
```

执行后终端会打印类似：

```
verification_uri: https://jimeng.jianying.com/oauth/device/activate
user_code: XXXX-XXXX
```

操作步骤：

1. 用浏览器打开 `verification_uri` 那个地址；
2. 输入终端里的 `user_code`；
3. 在打开的即梦页面确认授权（如果没登录即梦，先登录网页版即梦）；
4. 回到终端，命令会自动结束并提示登录成功。

> 登录命令会一直等待你完成授权，**不要中途 Ctrl+C**，等它自己输出登录成功。

### 2.2 无头登录（给脚本/远程环境用）

```bash
# 第一步：打印设备码后立即退出（不阻塞等待）
dreamina login --headless

# 第二步：完成授权后，用 device_code 完成登录
dreamina login checklogin --device_code=<上面打印的 device_code>
```

### 2.3 验证登录是否成功

```bash
dreamina user_credit
```

返回包含余额/积分信息的 JSON 即说明登录成功、账号可用。

### 2.4 重新登录 / 退出登录

```bash
dreamina relogin     # 重新走一遍授权（换账号用）
dreamina logout      # 清除本地登录态
```

### 2.5 会话（session）管理

```bash
dreamina session list              # 查看会话
dreamina session create --name=xx  # 新建会话
```

所有生成命令都支持 `--session=<id>`，`0` 是默认会话。一般不用管，用默认的即可。

---

## 三、在 LenTalk 里配置

1. 打开应用 → **设置 → 密钥（API 密钥）**；
2. 找到 **「即梦 CLI」** 一项；
3. 在「可执行命令」里填 `dreamina`（如果 PATH 里找不到，填完整路径：macOS 一般为 `/Users/你的用户名/.local/bin/dreamina`，或先 `which dreamina` 查一下）；
4. 保存即可。

> 注意：配置填的是 **CLI 可执行命令**，不是 API Key——即梦没有 API Key，用账号积分计费。

---

## 四、在画布中生成视频

在视频生成节点（VideoGenNode）的模型列表里选择 **即梦 CLI 系列模型**，即可使用。支持以下模型与参数：

### 4.1 支持的模型

| 模型（model_version） | 时长范围 | 分辨率 |
|---|---|---|
| `seedance2.0` | 4–15 秒 | 720p |
| `seedance2.0fast` | 4–15 秒 | 720p |
| `seedance2.0_vip` | 4–15 秒 | 720p / 1080p / 4k |
| `seedance2.0fast_vip` | 4–15 秒 | 720p |
| `seedance2.0mini` | 4–15 秒 | 720p |
| `seedance2.5` | 4–30 秒 | 480p / 720p / 1080p |

> `_vip` 结尾 = VIP 权益模型，需要账号开通对应权益；普通账号建议用不带 `_vip` 的模型。

### 4.2 四种生成模式（按输入自动选择）

| 模式 | 输入 | 对应 CLI 子命令 |
|---|---|---|
| 文生视频 | 仅提示词 | `text2video` |
| 图生视频 | 1 张参考图 | `image2video` |
| 首尾帧 | 2 张图（首帧+尾帧） | `frames2video` |
| 多模态 | 多图 / 图+音频 | `multimodal2video` |

- 首尾帧模式：画幅由首帧图片决定（不传 ratio，跟随首帧）；
- 多模态模式：**纯音频参考（无图）时，必须选 Seedance 2.5**；
- 视频生成是异步任务：节点提交后会轮询排队状态（节点上会显示排队位置），完成后自动下载视频到画布。

---

## 五、常用命令速查

| 目的 | 命令 |
|---|---|
| 查看全部命令 | `dreamina -h` |
| 查看子命令参数 | `dreamina <子命令> -h`（如 `dreamina text2video -h`） |
| 登录 | `dreamina login` |
| 无头登录 | `dreamina login --headless` + `dreamina login checklogin --device_code=xxx` |
| 重新登录 | `dreamina relogin` |
| 退出登录 | `dreamina logout` |
| 查余额/积分 | `dreamina user_credit` |
| 会话管理 | `dreamina session list / create / rename / delete` |
| 文生图 | `dreamina text2image --prompt="..." --poll=60` |
| 图生图 | `dreamina image2image --image=xx.jpg --prompt="..."` |
| 文生视频 | `dreamina text2video --prompt="..." --model_version=seedance2.0 --duration=5 --video_resolution=720p --poll=60` |
| 图生视频 | `dreamina image2video --image=xx.png --prompt="..." --poll=60` |
| 首尾帧视频 | `dreamina frames2video --first=a.png --last=b.png --prompt="..." --poll=60` |
| 多模态视频 | `dreamina multimodal2video --image=1.png --image=2.png --audio=a.mp3 --prompt="..." --model_version=seedance2.5` |
| 查任务结果 | `dreamina query_result --submit_id=xxx --download_dir=./out` |
| 查看任务历史 | `dreamina list_task --limit=100` |

提交类命令常用 `--poll=N`：等最多 N 秒拿终态；超时返回 `gen_status=querying` 时，用 `query_result` 继续查（LenTalk 内部就是这么做的：`--poll=0` 提交 + 每 3 秒轮询）。

---

## 六、常见问题排查

**1. 生成排队很久**
即梦是排队制，任务提交后返回排队位置（如 `队列位置 17355/21988`）。`dreamina list_task` 可以看到队列里还有多少任务。高峰期等待几十分钟正常，节点会持续轮询，不用管。

**2. 提示积分/余额不足**
`dreamina user_credit` 查余额。即梦视频按生成时长扣积分（单次约 30 积分，具体看模型），余额不足去即梦官网充值或开通会员。

**3. 返回 `AigcComplianceConfirmationRequired` / 视频任务被拒**
**合规要求：必须先登录即梦网页端（jimeng.jianying.com）完成至少一次视频生成**，之后 CLI 才能提交视频任务（官方文档明确要求）。先在网页端生成一次同类型视频，再回画布重试；个别模型/素材还可能需要网页端一次性授权确认。

**4. 报错排查**
报错日志在 `~/.dreamina_cli/logs/` 目录下，把相关日志贴给客服/排查时带上；先执行更新命令 `curl -fsSL https://jimeng.jianying.com/cli | bash` 升到最新版再重试（很多问题新版已修复）。

**5. 素材含人脸被拒**
即梦对真人脸素材有限制（如"识别到素材中包含人脸信息，请调整素材后再试试"）。换素材或加风格化处理。

**6. `无法启动即梦 CLI`**
- 确认终端里 `which dreamina` 能找到；
- 设置里填的命令要能直接执行：填 `dreamina` 或完整路径；
- macOS 上从桌面/Finder 启动的应用**不继承终端 PATH**——LenTalk 已内置常见目录自动探测（`~/.local/bin`、`~/.cargo/bin`、`/usr/local/bin` 等），若仍找不到请在设置里填完整路径（如 `/Users/你的用户名/.local/bin/dreamina`）；
- 改完 PATH 后需要重启应用（应用读取的是启动时的 PATH）。

**7. `authsdk: store unavailable`（macOS）**
登录态存在 macOS 钥匙串（Keychain），首次使用会弹系统授权框，点「允许」即可。如果命令行报这个错，检查钥匙串里是否拒绝了 dreamina 的访问（系统设置 → 密码与钥匙串 → 钥匙串访问权限）。

**8. 模型不支持**
在节点里选的模型要在上表范围内；`seedance2.5` 只支持 4–30 秒，其他模型 4–15 秒；分辨率按表格选（比如 `seedance2.0` 只支持 720p）。

---

## 七、一句话流程总结

```bash
# 1. 安装
curl -fsSL https://jimeng.jianying.com/cli | bash
# 2. 登录（浏览器授权）
dreamina login
# 3. 验证
dreamina user_credit
# 4. LenTalk 设置 → 密钥 → 即梦 CLI → 填 dreamina
# 5. 画布视频节点选「即梦 CLI」模型 → 生成
```
