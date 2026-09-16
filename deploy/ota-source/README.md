# LenTalk OTA 自建更新源（腾讯云轻量 → COS 平滑迁移）

用一台腾讯云轻量服务器承载应用自动更新的清单与安装包，替代第三方 GitHub 镜像。
本方案按「后端可替换」设计：**切换到腾讯云对象存储时只改一个变量**，流程无需重做。

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
            └── v1.2.14/
                 ├── LenTalk_1.2.14_x64-setup.exe
                 ├── LenTalk_1.2.14_x64-setup.exe.sig
                 ├── LenTalk.app.tar.gz
                 ├── LenTalk.app.tar.gz.sig
                 └── LenTalk_1.2.14_aarch64.dmg
```

三处地址必须严格对齐，这是唯一容易出错的地方：

| 位置 | 值 | 示例 |
| --- | --- | --- |
| 客户端端点（**编译进二进制**） | `{UPDATE_BASE_URL}/latest-{{target}}.json` | `http://1.2.3.4/ota/latest-windows.json` |
| 清单内 `platforms.*.url` | `{UPDATE_BASE_URL}/releases/{tag}/{文件名}` | `http://1.2.3.4/ota/releases/v1.2.14/xxx.exe` |
| 服务器磁盘（由 nginx alias 映射） | URL 的 `/ota/*` ↔ `{OTA_REMOTE_DIR}/*` | `/ota/latest-windows.json` → `/var/www/lentalk-ota/latest-windows.json` |

注意 `UPDATE_BASE_URL` **带 `/ota` 后缀**，而 `OTA_REMOTE_DIR` 是**不含 `/ota` 的纯磁盘路径**，
两者靠 `nginx-ota.conf` 里的 `alias` 对接。它们不必同名，但必须指向同一个目录。

---

## 2. 服务器侧

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

上传账号需对该目录有写权限：

```bash
useradd -m -s /bin/bash lentalk-ota        # 若尚无专用账号
mkdir -p /home/lentalk-ota/.ssh
# 把 CI 用的公钥写入 authorized_keys，私钥全文填到 GitHub Secret
chown -R lentalk-ota:lentalk-ota /var/www/lentalk-ota
```

生成 CI 专用密钥（在服务器或本机均可，**私钥不要提交进仓库**）：

```bash
ssh-keygen -t ed25519 -f ./ota_deploy -N "" -C "github-actions-ota"
cat ota_deploy.pub >> /home/lentalk-ota/.ssh/authorized_keys
```

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

脚本会：把自建源插到 `endpoints` **首位**、原样保留 `github.com` 系列镜像作为兜底、
改完后打印需要填进 GitHub 的变量清单。

> **为什么必须放首位**：Tauri 更新器按数组顺序逐个尝试，**首个返回成功即停止**。
> 放首位即"优先查自建源，查不到才退到镜像"；若自建源暂时挂掉，客户端会静默回退，不会卡住。

> ⚠️ **端点是编译进安装包的常量**，改完必须**升版本号并发版**才对客户端生效。
> 已安装的版本永远读的是它自己编译时那份列表——这就是"配好了但老版本不走自建源"的原因。

灰度建议：**留下 `UPDATE_BASE_URL` 为空时，CI 行为与现状完全一致**（走 ghfast.top 镜像），
所以可以先只做服务器侧与 GitHub 配置，确认无误后再接线发版。

---

## 4. GitHub 侧配置

仓库 `Settings → Secrets and variables → Actions`：

| 类型 | 名称 | 示例值 | 说明 |
| --- | --- | --- | --- |
| Variable | `UPDATE_BASE_URL` | `http://1.2.3.4/ota` | **换源总开关**，留空则回落 ghfast.top 镜像 |
| Variable | `OTA_REMOTE_DIR` | `/var/www/lentalk-ota` | 服务器磁盘路径。**不填即用此默认值**，一般无需配置 |
| Variable | `OTA_SSH_PORT` | `22` | 非 22 时必填 |
| Secret | `OTA_SSH_HOST` | `1.2.3.4` | 公网 IP 或域名 |
| Secret | `OTA_SSH_USER` | `lentalk-ota` | 上传账号 |
| Secret | `OTA_SSH_KEY` | `-----BEGIN OPENSSH...` | 私钥全文 |

`UPDATE_BASE_URL` 与 `OTA_SSH_HOST` **同时非空**时上传步骤才启用；
任一为空则整步跳过，**不影响原有 GitHub 镜像链路**。

若只配了一半（例如填了开关与主机，却漏了 `OTA_SSH_USER`），构建会在上传步骤**明确报错并中止**，
而不是以一个难懂的 ssh 错误收场——这是刻意设计的，避免"CI 显示成功但文件其实没传上去"。

---

## 5. 发版流程

与现状完全一致，无需额外操作：

```bash
# 改版本号 → 提交 → 打 tag
git tag v1.2.14 && git push origin v1.2.14
```

CI 会自动：构建 → 生成带自建源地址的清单 → scp 上传到轻量服务器 → 同步顶层清单 → 照旧发布
GitHub Release（作为兜底与历史留档）。

排障用输出：`Generate updater metadata` 步骤会打印实际写入清单的 `资源基址`，可直接比对。

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

迁移时的动作清单：
1. 把 `/var/www/lentalk-ota/` 整目录同步到 COS（`coscmd upload -rs`）
2. 改 `UPDATE_BASE_URL` 变量
3. 用 `curl -sI <新地址>/latest-windows.json` 验证可达
4. 本地重新接线：`bash deploy/ota-source/set-endpoint.sh <COS域名>` → 发版
5. 停掉 nginx 片段或保留双跑

> 提醒：COS 免费额度只含 50GB 标准存储 6 个月，**不含外网下行流量**（0.5 元/GiB 按量）。
> 按 Windows 包 16MB 计，1 万次更新约 160GiB ≈ 80 元。建议配合 CDN 或保留镜像兜底。

---

## 8. 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 客户端始终提示无更新 | 清单被缓存 | 确认 `Cache-Control: no-store` 生效，见 `nginx-ota.conf` |
| 检查更新报错后仍能更新 | 端点回退生效 | 正常行为，Tauri 遇非 2XX 才试下一个端点 |
| 有清单但下载 404 | 安装包未上传或 tag 目录名不符 | 比对清单 `url` 与磁盘实际路径 |
| 签名校验失败 | 清单 `signature` 与包不匹配 | 同一版本的 `.sig` 与包必须成对上传 |
| 上传步骤被跳过 | `UPDATE_BASE_URL` 或 `OTA_SSH_HOST` 为空 | 补 GitHub 变量/密钥 |
| 构建报"必须配置 OTA_SSH_USER 或 OTA_SSH_KEY" | 自建源开关已开但凭据不全 | 补 Secret；或清空 `UPDATE_BASE_URL` 先回到镜像链路 |
| 构建报"OTA_REMOTE_DIR 必须是绝对路径" | 变量填了相对路径 | 改为以 `/` 开头的绝对路径 |
| **CI 全绿但客户端查不到更新** | `OTA_REMOTE_DIR` 与 nginx alias 目录不一致 | 用 `--show` 查端点、比对上表三处地址；这也是给它设默认值的原因 |
| 已装版本不走自建源 | 端点是编译期写死的 | 必须发一版新号才能生效 |
