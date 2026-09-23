# LenTalk OTA 自建更新源（腾讯云轻量 → COS 平滑迁移）

用一台腾讯云轻量服务器承载应用自动更新的清单与安装包，替代第三方 GitHub 镜像。
本方案按「后端可替换」设计：**切换到腾讯云对象存储时只改一个变量**。

> **⚠️ 2026-09-19 架构变更（重要）**
>
> 产物同步方向**已反转**：以前是 CI（GitHub 美国 runner）用 `scp` **推**给服务器，
> 现在是**服务器主动从 GitHub Release 拉**。
>
> 原因：runner 在美国 Azure 机房，跨境 `scp` 实测只有 **6~9 KB/s**，40MB 要传
> 47~77 分钟，**而且会直接失败** —— v1.2.19 的 macOS job 就卡在这里（2858 秒后
> 失败），导致紧随其后的 `Publish to GitHub Release` 被 skip，Release 里至今
> 没有 darwin 资产。
>
> 改成服务器主动拉之后：**同样体积约 52 秒**（约 55 倍）。
>
> **CI 侧已删除两个 `Publish updater files to self-hosted source` 步骤**，
> 也不再需要任何 SSH 凭据。**不要把 scp 加回去。**
>
> **⚠️ 2026-09-19 补充：大文件（>50MB）服务器拉不动是常态**
>
> 服务器 → GitHub **直连只有 12 KB/s**（116MB 的 exe 要 **2.7 小时**），会被脚本的
> `--speed-limit 20480` 判死；而 **21MB 的 `LenTalk.app.tar.gz` 能过**。
> 所以典型症状是「**darwin 清单秒切新版、windows 清单一直停在旧版**」。
> 国内加速镜像当晚实测 6 个全部失效，**别再一个个试**。
>
> **处置 = 本地直投**（脚本已内置旁路，见 §2.4）：本机下载 CI 产物 → `scp` 上传
> （本机 → 服务器 **~3 MB/s**，122MB 约 40 秒）→ 原子替换根清单。

---

## 1. 架构

```
LenTalk 客户端
  │  ① 读清单  GET <UPDATE_BASE_URL>/latest-{{target}}.json
  │  ② 读签名  清单内 signature 字段(ed25519)
  │  ③ 下安装包 GET <UPDATE_BASE_URL>/releases/<tag>/<文件>
  ▼
腾讯云轻量服务器 (nginx, 与参考图上传服务共用 80 端口)
  └─ /var/www/lentalk-ota/
       ├── latest-windows.json      ← 始终指向最新版
       ├── latest-darwin.json
       ├── latest-macos.json        ← 兼容 1.2.12 及更早客户端
       └── releases/
            └── v1.2.23/
                 ├── LenTalk_1.2.23_x64-setup.exe
                 ├── LenTalk_1.2.23_x64-setup.exe.sig
                 ├── LenTalk.app.tar.gz
                 └── LenTalk.app.tar.gz.sig

同步链路（新）：

  GitHub runner (美国) ──构建+发布 Release(几秒)──> GitHub Release
  腾讯云服务器 ──lentalk-ota-sync.timer 每 2 分钟──> ghfast.top 镜像 ──> GitHub Release
               └─ 下载到 releases/<tag>/ → 校验体积 → 原子替换根目录清单

  大文件（exe/dmg）镜像也拉不动时的旁路：
  本机 ──下载 CI 产物──> scp ~3MB/s ──> 服务器 releases/<tag>/
                                       └─ 脚本发现"已就位且体积相符" → 跳过下载，只更新清单
```

**目录里没有 `.msi` 是正常的**：updater 不使用 MSI，`.msi` 只进 GitHub Release。
**目录里也没有 `.dmg`**：macOS 的 updater 用的是 `LenTalk.app.tar.gz`，
`.dmg` 只进 GitHub Release 供首次安装（自建源只同步两个 updater 产物 + 它们的 `.sig`）。

两处地址必须对齐，这是唯一容易出错的地方：

| 位置 | 值 | 示例 |
| --- | --- | --- |
| 客户端端点（**编译进二进制**） | `{UPDATE_BASE_URL}/latest-{{target}}.json` | `http://1.2.3.4/ota/latest-windows.json` |
| 清单内 `platforms.*.url` | `{UPDATE_BASE_URL}/releases/{tag}/{文件名}` | `http://1.2.3.4/ota/releases/v1.2.19/xxx.exe` |
| 服务器磁盘（由 nginx alias 映射） | URL 的 `/ota/*` ↔ `/var/www/lentalk-ota/*` | `/ota/latest-windows.json` → `/var/www/lentalk-ota/latest-windows.json` |

注意 `UPDATE_BASE_URL` **带 `/ota` 后缀**，磁盘路径**不含 `/ota`**，两者靠
`nginx-ota.conf` 里的 `alias` 对接。

> 历史遗留：以前还有一个 `OTA_REMOTE_DIR` 变量用来告诉 CI 写到哪个目录，
> 已随 scp 步骤一并从工作流移除，**不再需要配置**。

---

## 2. 服务器侧

### 2.1 首次搭建：nginx 片段

把本目录的 `setup-ota-source.sh` 与 `nginx-ota.conf` 一起上传到服务器，然后：

```bash
sudo bash setup-ota-source.sh --inject
```

脚本做四件事：建目录骨架、装 nginx 片段到 `/etc/nginx/snippets/`、把 `include` 注入现有 server 块
（备份原文件，`nginx -t` 失败自动回滚）、reload 并自检。

完成后按脚本末尾提示放一个测试清单确认路径可达：

```bash
echo '{}' > /var/www/lentalk-ota/latest-windows.json
curl -sI http://<公网IP>/ota/latest-windows.json   # 期望 200 + application/json
rm -f /var/www/lentalk-ota/latest-windows.json
```

### 2.2 首次搭建：同步脚本 + 定时器

**不需要为上传单独建账号，也不需要给 CI 配任何密钥。** 脚本以 `ubuntu` 身份运行，
而 `/var/www/lentalk-ota` 属主就是 `ubuntu:ubuntu`，直接可写。

```bash
# 1) 放脚本
scp sync-release.sh ubuntu@<公网IP>:/tmp/
ssh ubuntu@<公网IP> 'sudo install -m 755 -o root -g root /tmp/sync-release.sh /usr/local/bin/lentalk-ota-sync'

# 2) 先干跑（只读，不写盘）
/usr/local/bin/lentalk-ota-sync --dry-run

# 3) 装 systemd 单元
scp lentalk-ota-sync.service lentalk-ota-sync.timer ubuntu@<公网IP>:/tmp/
ssh ubuntu@<公网IP> 'sudo install -m 644 -o root -g root /tmp/lentalk-ota-sync.service \
                     /tmp/lentalk-ota-sync.timer /etc/systemd/system/ && sudo systemctl daemon-reload'

# 4) 启用并确认
sudo systemctl enable --now lentalk-ota-sync.timer
systemctl list-timers lentalk-ota-sync.timer --no-pager    # 看下一轮触发时间
journalctl -u lentalk-ota-sync -n 50 --no-pager            # 看日志
```

依赖（Ubuntu 24.04 **自带**，无需 apt）：`curl`、`jq`、`flock`。

**unit 文件里的 `TimeoutStartSec=600` 不能删**：systemd 默认 `DefaultTimeoutStartSec`
只有 90 秒，一次全平台同步遇到镜像抖动会超过它，被半路 kill 会留下半截文件。

### 2.3 脚本的四道保护

| 保护 | 作用 |
| --- | --- |
| **版本守卫** | 新版本号必须**严格大于**根清单现有版本才覆盖。旧任务/手动同步都不可能把清单写回旧版本（也顺带根治了历史上"上一次发版的慢 job 覆盖新清单"的竞态） |
| **原子替换** | 清单先写临时文件再 `mv`（同文件系统的 rename 是原子的），绝不对外暴露半截 JSON |
| **体积校验** | 下载完比对文件体积与 GitHub API 报告的 size，不符则判失败、**不更新清单** |
| **本地直投旁路** | 目标目录里已有同名文件且体积与 Release API 一致时，**跳过下载只更新清单**。用于服务器拉不动大文件时由外部链路投递（见 §2.4）。安全前提：投放的文件必须能通过 `.sig` 验签，否则客户端会拒装 |

另外：Release 里某平台清单缺失时，脚本**在触碰根清单之前就退出** →
"某个平台还没发布完"不会把好清单改坏。

自愈行为：macOS 还没发布时只跳过 darwin，不影响 Windows；下一轮自动补上。

### 2.4 大文件拉不动时：本地直投 SOP

**判据（一眼认出）**：`latest-darwin.json` / `latest-macos.json` 已切到新版本，
而 **`latest-windows.json` 一直停在旧版本**。

```bash
journalctl -u lentalk-ota-sync -n 50 --no-pager
# → [windows] 失败: 安装包下载不成功(HTTP 200 curl=92)
#   curl 92 = CURLE_HTTP2_STREAM：HTTP 状态是 200，但流被中途掐断
```

**根因**：服务器 → GitHub 直连只有 **12 KB/s**。exe 116MB 需 2.7 小时，必被脚本
`--speed-limit 20480 --speed-time 45`（20KB/s）判死；而 tar.gz 只有 21MB，能过。
国内加速镜像（`gh-proxy.com` / `ghproxy.net` / `hub.gitmirror.com` / `gh.llkk.cc` /
`github.moeyy.xyz` …）实测**全部失效**，不要再逐个试。

**处置**：

```bash
# 1) 本机下载「CI 产物」——不是本机 tauri build 的包！
#    本机构建是 createUpdaterArtifacts:false（体积、签名都与清单不匹配），混用必验签失败
#    同时取回 Release 的 latest-windows.json 与 *.exe.sig（各 ~1KB）
# 2) 上传（本机 → 服务器 ~3MB/s，122MB 约 40 秒）
scp -i ~/.ssh/lentalk-ota-ci LenTalk_X.Y.Z_x64-setup.exe ubuntu@118.25.194.71:/tmp/

# 3) 服务器侧：核对 sha256 → 落盘 → 原子替换根清单 → 恢复 timer
sha256sum /tmp/LenTalk_X.Y.Z_x64-setup.exe          # 与 Release 的 digest 比对
sudo mv -f /tmp/LenTalk_X.Y.Z_x64-setup.exe /var/www/lentalk-ota/releases/vX.Y.Z/
sudo mv -f /tmp/LenTalk_X.Y.Z_x64-setup.exe.sig /var/www/lentalk-ota/releases/vX.Y.Z/
sudo chown ubuntu:ubuntu /var/www/lentalk-ota/releases/vX.Y.Z/LenTalk_X.Y.Z_x64-setup.exe*
cp /tmp/latest-windows.json /var/www/lentalk-ota/.latest-windows.json.new
mv -f /var/www/lentalk-ota/.latest-windows.json.new /var/www/lentalk-ota/latest-windows.json
sudo systemctl start lentalk-ota-sync.timer
```

**验证（缺一不可）**：

```bash
# ① 清单版本 + url 指向自建源自身
curl -s http://118.25.194.71/ota/latest-windows.json | jq -r '.version, .platforms["windows-x86_64-nsis"].url'
# ② 端点存在（期望 206）
curl -s -o /dev/null -r 0-0 -w "%{http_code}\n" \
  http://118.25.194.71/ota/releases/vX.Y.Z/LenTalk_X.Y.Z_x64-setup.exe
# ③ nginx 实际吐出的字节与本地文件逐位一致
ssh ubuntu@118.25.194.71 'curl -s http://127.0.0.1/ota/releases/vX.Y.Z/LenTalk_X.Y.Z_x64-setup.exe | sha256sum'
# ④ 验签（见 §9）；⑤ 强制跑一轮确认旁路生效
sudo env LOCK=/tmp/ota-manual.lock /usr/local/bin/lentalk-ota-sync --force
# → [windows] 跳过下载: ... 已就位且体积相符（本地直投）
```

**两个坑**：

- `--dry-run` / `--force` 是 **CLI 开关，不是环境变量**（`DRY=1 cmd` 之类写法不生效）。
- 手工跑会和 systemd 抢 `/tmp/lentalk-ota-sync.lock`，报 `Permission denied` +
  `flock: Bad file descriptor`，日志显示「另一个同步任务正在运行」——**这是假报**，
  用 `LOCK=/tmp/ota-manual.lock` 换把锁即可。

---

## 3. 客户端端点接线（本机执行）

拿到服务器地址后，用一条命令写入客户端端点：

```bash
bash deploy/ota-source/set-endpoint.sh 1.2.3.4            # → http://1.2.3.4/ota
bash deploy/ota-source/set-endpoint.sh 1.2.3.4:8080       # 自定义端口
bash deploy/ota-source/set-endpoint.sh https://up.example.com
bash deploy/ota-source/set-endpoint.sh --show             # 查看当前端点
bash deploy/ota-source/set-endpoint.sh --clear            # 移除自建源, 恢复纯镜像
```

脚本会：把自建源插到 `endpoints` **首位**、原样保留 `github.com` 系列镜像作为兜底。

> **为什么必须放首位**：Tauri 更新器按数组顺序逐个尝试，**首个返回成功即停止**。
> 放首位即"优先查自建源，查不到才退到镜像"；若自建源暂时挂掉，客户端会静默回退。

> ⚠️ **端点是编译进安装包的常量**，改完必须**升版本号并发版**才对客户端生效。

---

## 4. GitHub 侧配置

仓库 `Settings → Secrets and variables → Actions` —— **现在只需要一项**：

| 类型 | 名称 | 示例值 | 说明 |
| --- | --- | --- | --- |
| Variable | `UPDATE_BASE_URL` | `http://1.2.3.4/ota` | **换源总开关**，留空则回落 ghfast.top 镜像 |

它只决定**清单里的下载地址指向哪里**。CI 本身不再向服务器推任何文件。

> `OTA_SSH_HOST` / `OTA_SSH_USER` / `OTA_SSH_KEY` / `OTA_SSH_PORT` / `OTA_REMOTE_DIR`
> 已经没有任何消费者，属于历史遗留。**建议全部删除** —— 尤其 `OTA_SSH_KEY`：
> CI 私钥等价于服务器 `ubuntu` 账号权限，而该账号免密 sudo 等于 root。
> 删掉它之后，即使 GitHub 仓库或 Actions 被攻破，也无法直接登录服务器。
>
> 注意：删密钥前请先确认服务器 `authorized_keys` 里已有**其他**可登录的公钥，
> 否则会把自己也锁在外面。

---

## 5. 发版流程

```bash
# 改五处版本号 → 本机验证（tsc / vitest / vite build / cargo test）→ 提交 → 打附注 tag
git tag -a vX.Y.Z -m "LenTalk vX.Y.Z"
```

> **本机 `git push` 恒坏**（`Connection was reset`，写通道被墙），推送走 Git Data API：
> `~/.workbuddy/tools/gh_api_push_index.py --branch main --message-file MSG.txt --tag vX.Y.Z`。
> 先 `--dry-run` 看「**删除 0**」再正式跑；成功判据是 **tree 一致**（`TREE_MATCH_OK`），不是 commit SHA。

CI 会自动：构建 → 生成带自建源地址的清单 → **发布 GitHub Release**。
服务器上的 timer 最多 **2 分钟**后把产物拉到自建源并更新根清单。

排障用输出：`Generate updater metadata` 步骤会打印实际写入清单的 `资源基址`，可直接比对。

**发版后自查**（Release 页面资产必须**按平台成组出现**）：

```bash
curl -s http://118.25.194.71/ota/latest-windows.json | jq -r '.version'
curl -s http://118.25.194.71/ota/latest-darwin.json  | jq -r '.version'
curl -s http://118.25.194.71/ota/latest-darwin.json  | jq -r '.platforms["darwin-aarch64"].url'
# 服务器上：
journalctl -u lentalk-ota-sync -n 50 --no-pager
```

> ⚠️ **务必单独盯 windows 清单**：darwin 通常几秒就位，而 **116MB 的 exe 有可能拉不动**
> （症状：darwin 已切新版、windows 停在旧版）。出现就走 §2.4 的本地直投，
> 别以为是「timer 还没跑」。三份根清单版本一致才算发版完成。

---

## 6. HTTP 还是 HTTPS

当前服务器是 **IP 直连 + 80 端口**（无域名），因此走 `http://`，这需要客户端配置：

```jsonc
// src-tauri/tauri.conf.json
"plugins": {
  "updater": {
    "dangerousInsecureTransportProtocol": true,
    "endpoints": [
      "http://1.2.3.4/ota/latest-{{target}}.json",
      // 镜像兜底保留
      "https://ghfast.top/https://github.com/.../latest-{{target}}.json"
    ]
  }
}
```

**明文传输不会导致安装被篡改**：更新包经 ed25519 签名，客户端校验 `signature` 字段后才安装，
HTTP 只影响保密性（版本号、IP 可见），不影响完整性。若日后绑定了已备案域名，换成
`https://` 并移除该开关即可，客户端需再发一版。

---

## 7. 到期迁移到 COS

推荐做法是**让客户端地址永不改变**，只在后端之间漂移：

- **有域名**（推荐）：把 `UPDATE_BASE_URL` 设为自有域名，DNS 从轻量 IP 切到 COS 域名。
  客户端无需发新版，迁移当天生效。
- **只有 IP**：地址变了就必须发行新版本。此时改 `UPDATE_BASE_URL` 为 COS 域名 →
  发版 → 老版本靠端点里的镜像兜底仍能升级到新版，形成平滑过渡。

> ⚠️ **迁 COS 时"谁推谁拉"要重新想一遍。** 现在的模型是"服务器从 GitHub Release 拉"，
> 而 COS 是对象存储，没有能跑定时任务的主机。可选：
> ① 继续保留这台服务器，让同步脚本**多写一份到 COS**（`coscmd upload`），COS 只做 CDN 回源；
> ② CI 直接推 COS —— 但要注意 **runner 在美国**，推给广州的 COS 是同一类跨境问题，
> 需评估 COS 全球加速或就近地域桶；③ 保留自建源，只把它挂到 CDN 后面。

迁移时的动作清单：
1. 把 `/var/www/lentalk-ota/` 整目录同步到 COS（`coscmd upload -rs`）
2. 改 `UPDATE_BASE_URL` 变量
3. 用 `curl -sI <新地址>/latest-windows.json` 验证可达
4. 本地重新接线：`bash deploy/ota-source/set-endpoint.sh <COS域名>` → 发版
5. 停掉 nginx 片段或保留双跑

> 提醒：COS 免费额度只含 50GB 标准存储 6 个月，**不含外网下行流量**（0.5 元/GiB 按量）。
> 按 Windows 包 16MB 计，1 万次更新约 160GiB ≈ 80 元。建议配合 CDN 或保留镜像兜底。
> 另：**只有腾讯云 COS 可免备案分发 exe/dmg**（阿里云 OSS 新户默认域名禁下载、
> 七牛测试域名同样禁 exe/dmg）。

---

## 8. 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 客户端始终提示无更新 | 清单被缓存 | 确认 `Cache-Control: no-store` 生效，见 `nginx-ota.conf` |
| 检查更新报错后仍能更新 | 端点回退生效 | 正常行为，Tauri 遇非 2XX 才试下一个端点 |
| 有清单但下载 404 | 安装包未同步或 tag 目录名不符 | 比对清单 `url` 与磁盘实际路径；查 `journalctl -u lentalk-ota-sync` |
| 签名校验失败 | 清单 `signature` 与包不匹配 | 同一版本的 `.sig` 与包必须成对同步 |
| **Release 里某个平台资产整组缺席** | 该平台 job 失败，Release 步骤被 skip | 查该 job 的分步耗时；历史上这是跨境 scp 卡的（现架构已消除该原因） |
| **根清单迟迟不更新** | timer 没跑 / Release 里还没有该平台清单 | `journalctl -u lentalk-ota-sync -n 100`；日志会写明"跳过"原因 |
| 日志显示"资源不存在(404)" | Release 里确实没有该资产 | 等下一个周期；或确认该 tag 是否发布完整 |
| 日志显示"体积不符" | 下载被截断 | 脚本已自动放弃且**不更新清单**，下轮重试；持续出现则换镜像（`MIRROR=`） |
| **只有 windows 清单不更新，darwin 已切新版** | 116MB 的 exe 拉不动（服务器直连 GitHub 仅 12 KB/s，被 `--speed-limit` 判死） | **走 §2.4 本地直投**；不要把镜像换来换去，实测全失效 |
| 日志显示 `下载失败(HTTP 200 curl=92)` | `CURLE_HTTP2_STREAM`：HTTP 200 但流被中途掐断 | 同上。注意「404（资产确实没发布）」与「下载被中断」是两回事，脚本已分开处理 |
| 手工跑报"另一个同步任务正在运行"，但确实没有别人在跑 | 和 systemd 抢 `/tmp/lentalk-ota-sync.lock` 失败（`Permission denied` + `flock: Bad file descriptor`） | **假报**。加 `LOCK=/tmp/ota-manual.lock` 换把锁 |
| 想强制同步某版本 | — | `--dry-run` 确认后再加 `--force`（会绕过版本守卫，谨慎）。**二者是 CLI 开关，不是环境变量** |
| 定时任务"另一个同步任务正在运行" | 上一轮还没跑完 | `flock -n` 保护，正常；说明单轮超过了轮询间隔 |
| 已装版本不走自建源 | 端点是编译期写死的 | 必须发一版新号才能生效 |

---

## 9. 本地验签（排查"更新失败"必用）

**绝不要手写 minisign 校验**（Node/OpenSSL 自实现 BLAKE2b-512 + Ed25519），
它会对**已知完全正常**的包也报失败，极易把排查引向"OTA 一直是坏的"这个错误结论。

用 `~/.workbuddy/tools/sigcheck/`（依赖官方 `minisign-verify 0.2.5`）：

```bash
sigcheck.exe <pubkey.b64> <signature.b64> <文件>      # 期望 VERIFY_OK
```

- `pubkey.b64` ← `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`
- `signature.b64` ← 清单里对应平台键的 `signature` 字段
- 两者都是「minisign 文本再套一层 base64」，**直接存成文件喂进去即可，工具内部会解**

**必做反向自测**：把文件中间翻转一个字节再验，必须得到 `VERIFY_FAIL` ——
否则无法排除"这个工具永远说 OK"。

---

## 10. 实测速率与发版基线

| 链路 | 速率 | 备注 |
| --- | --- | --- |
| GitHub runner（美国）→ 腾讯云（`scp`） | **6~9 KB/s** | **已废弃**，v1.2.19 的 macOS job 卡 2858s 后失败 |
| 腾讯云 → `github.com` 直连 | 9.7 KB/s（复测 **12 KB/s**） | 116MB 要 2.7 小时 → 大文件必栽 |
| 腾讯云 → `ghfast.top` 镜像 | 900 KB/s ~ 1.1 MB/s | 21MB 级能过，116MB 仍悬 |
| 本机 → GitHub（代理） | ~110 KB/s | 116MB ≈ 15 分钟 |
| **本机 → 腾讯云（ssh 上传）** | **~3 MB/s** | 122MB ≈ 40 秒，大文件发版走这条 |
| 腾讯云自建源 → 客户端 | 595~650 KB/s | 用户侧下载速度 |

**根因**：美国 runner → 广州跨境 RTT ~180ms + 丢包，而 `scp` 每块要等服务端 ACK
（吞吐 ≈ TCP 窗口 / RTT）→ 长肥链路必然塌陷。与 dmg 压缩级别、服务器带宽都无关。

**发版基线（v1.2.22 / run 35436535070，全绿 14 分 10 秒）**：

| job | 关键步骤耗时 |
| --- | --- |
| Windows（NSIS exe + MSI） | Install deps 24s → **Build installers 824s** → Publish 9s |
| macOS（dmg） | **Build bundle 398s** → Package dmg 19s → Publish 4s |
| Merge updater manifests | 2s |

**瓶颈是应用层编译，不是网络** —— 别再往传输环节找优化空间。
