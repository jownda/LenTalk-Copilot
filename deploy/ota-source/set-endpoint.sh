#!/usr/bin/env bash
# ── LenTalk OTA 端点设置 ────────────────────────────────────────────────
# 把自建更新源写进 src-tauri/tauri.conf.json 的 updater.endpoints 首位,
# 其余 GitHub 镜像端点原样保留, 作为兜底。
#
# ⚠️ endpoints 是**编译进安装包**的常量, 改完必须重新发版(升版本号 + 推 tag)
#    才对客户端生效。已装的旧版本永远读的是它自己编译时的那份列表。
#
# 用法:
#   bash deploy/ota-source/set-endpoint.sh 1.2.3.4                 → http://1.2.3.4/ota
#   bash deploy/ota-source/set-endpoint.sh 1.2.3.4:8080            → http://1.2.3.4:8080/ota
#   bash deploy/ota-source/set-endpoint.sh https://up.example.com  → https://up.example.com/ota
#   bash deploy/ota-source/set-endpoint.sh --show                 查看当前端点
#   bash deploy/ota-source/set-endpoint.sh --clear                移除自建源, 恢复纯镜像
#
# 说明: /ota 前缀是 deploy/ota-source/nginx-ota.conf 里约定的路径, 不要省略。
set -euo pipefail

# 用参数展开取目录, 不依赖外部 dirname(部分受限 shell 环境里 PATH 不全)
case "$0" in
  */*) SCRIPT_DIR="${0%/*}" ;;
  *)   SCRIPT_DIR="." ;;
esac
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONF_REL="src-tauri/tauri.conf.json"
CONF="$REPO_ROOT/$CONF_REL"

log()  { printf '\033[1;34m[ota]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[ota]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[ota] 失败:\033[0m %s\n' "$*" >&2; exit 1; }

[ -f "$CONF" ] || die "找不到 $CONF"
command -v node >/dev/null 2>&1 || die "需要 node(用于安全改写 JSON)"
# node 在 Windows 上是原生程序, Git Bash 的 /d/xxx 路径它认不出来;
# 统一 cd 到仓库根后传相对路径, 三种平台行为一致。
cd "$REPO_ROOT"

read_endpoints() {
  node -e '
    const c = require("./" + process.argv[1]);
    console.log((c.plugins?.updater?.endpoints ?? []).join("\n"));
  ' "$CONF_REL"
}

# 写回: 保留 github.com 系列镜像端点, 自建源固定插到首位(空字符串 = 仅保留镜像)
write_endpoints() {
  node -e '
    const fs = require("fs");
    const rel = process.argv[1];
    const self = process.argv[2];
    const c = JSON.parse(fs.readFileSync(rel, "utf8"));
    const mirror = (c.plugins.updater.endpoints ?? []).filter((e) => e.includes("github.com"));
    c.plugins.updater.endpoints = self ? [self, ...mirror] : mirror;
    fs.writeFileSync(rel, JSON.stringify(c, null, 2) + "\n");
  ' "$CONF_REL" "$1"
}

normalize() {
  local raw="$1"
  case "$raw" in
    http://*|https://*) ;;
    *) raw="http://$raw" ;;                    # 裸 IP / 域名默认 http
  esac
  raw="${raw%/}"
  case "$raw" in
    */ota) ;;                                  # 已带前缀就不重复追加
    *) raw="$raw/ota" ;;
  esac
  printf '%s' "$raw"
}

MODE="${1:-}"

if [ -z "$MODE" ] || [ "$MODE" = "-h" ] || [ "$MODE" = "--help" ]; then
  sed -n '2,18p' "$0"
  exit 0
fi

if [ "$MODE" = "--show" ]; then
  log "当前 endpoints(客户端按顺序尝试, 首个成功即停止):"
  read_endpoints | nl -w4 -s'  '
  exit 0
fi

if [ "$MODE" = "--clear" ]; then
  write_endpoints ""
  log "已移除自建源, 仅保留镜像端点:"
  read_endpoints | nl -w4 -s'  '
  warn "别忘了把 GitHub 变量 UPDATE_BASE_URL 也清空, 否则 CI 仍会把清单里的下载地址指向自建源"
  exit 0
fi

BASE="$(normalize "$MODE")"
SELF_EP="${BASE}/latest-{{target}}.json"

write_endpoints "$SELF_EP"

log "已写入 src-tauri/tauri.conf.json:"
read_endpoints | nl -w4 -s'  '

HOSTPORT="${BASE#*://}"
HOSTPORT="${HOSTPORT%%/*}"
HOST="${HOSTPORT%%:*}"
PORT=""
case "$HOSTPORT" in *:*) PORT="${HOSTPORT##*:}" ;; esac

cat <<EOF

────────────────────────────────────────────────────────────
GitHub 仓库 → Settings → Secrets and variables → Actions

Variables 页(不是 Secrets):
  UPDATE_BASE_URL = ${BASE}
  OTA_SSH_PORT    = ${PORT:-22}
  OTA_REMOTE_DIR  = /var/www/lentalk-ota   (不填也有此默认值)

Secrets 页:
  OTA_SSH_HOST = ${HOST}
  OTA_SSH_USER = <能写 /var/www/lentalk-ota 的账号, 通常 root>
  OTA_SSH_KEY  = <该账号对应的私钥全文>

服务器侧(若尚未执行):
  scp deploy/ota-source/setup-ota-source.sh deploy/ota-source/nginx-ota.conf root@${HOST}:/root/
  ssh root@${HOST} "bash /root/setup-ota-source.sh --inject"

自检:
  curl -sI "${BASE}/latest-windows.json"    # 未上传时 404 属正常(不是 nginx 默认页即可)

⚠️ 本改动编译进安装包, 需升版本号并发版后才对客户端生效。
────────────────────────────────────────────────────────────
EOF
