#!/usr/bin/env bash
# ── LenTalk OTA 自建更新源 · 服务器端初始化 ──────────────────────────────
# 在腾讯云轻量服务器上以 root 执行, 单机复用已有 nginx(与参考图上传服务同端口)。
#
# 幂等: 重复执行只补目录与配置, 绝不删除历史上传的版本文件。
#
# 用法:
#   sudo bash setup-ota-source.sh                    # 建目录 + 装 nginx 片段(打印手动步骤)
#   sudo bash setup-ota-source.sh --inject           # 同上, 并自动把 include 注入现有 server 块
#   sudo bash setup-ota-source.sh /srv/lentalk-ota   # 自定义磁盘目录
set -euo pipefail

OTA_ROOT="/var/www/lentalk-ota"
INJECT=0
for arg in "$@"; do
  case "$arg" in
    --inject) INJECT=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) OTA_ROOT="$arg" ;;
  esac
done

SNIPPET_SRC="$(cd "$(dirname "$0")" && pwd)/nginx-ota.conf"
SNIPPET_DST="/etc/nginx/snippets/lentalk-ota.conf"
INCLUDE_LINE="include /etc/nginx/snippets/lentalk-ota.conf;"

log()  { printf '\033[1;34m[ota]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[ota]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[ota] 失败:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "需要 root 权限, 请用: sudo bash $0"
command -v nginx >/dev/null 2>&1 || die "未检测到 nginx"

# ── 1. 目录骨架 ─────────────────────────────────────────────────────────
log "目录: $OTA_ROOT"
mkdir -p "$OTA_ROOT/releases"
chmod 755 "$OTA_ROOT" "$OTA_ROOT/releases"

# ── 2. 安装 nginx 片段 ──────────────────────────────────────────────────
[ -f "$SNIPPET_SRC" ] || die "缺少 nginx-ota.conf(应与本脚本同目录)"
mkdir -p /etc/nginx/snippets
sed "s#/var/www/lentalk-ota#$OTA_ROOT#g" "$SNIPPET_SRC" > "$SNIPPET_DST"
chmod 644 "$SNIPPET_DST"
log "已写入 $SNIPPET_DST"

# ── 3. 挂到现有 server 块 ───────────────────────────────────────────────
# 找承载参考图上传服务的那个配置文件(80 端口的 default_server)
TARGET_CONF="$(grep -rl --include='*.conf' 'reference-assets' /etc/nginx/ 2>/dev/null | grep -v 'lentalk-ota' | head -1 || true)"

if [ -z "$TARGET_CONF" ]; then
  warn "未找到含 reference-assets 的 nginx 配置"
  warn "请手动在对外 server {} 内加一行: $INCLUDE_LINE"
elif grep -q 'lentalk-ota.conf' "$TARGET_CONF"; then
  log "include 已存在: $TARGET_CONF"
elif [ "$INJECT" -eq 1 ]; then
  BACKUP="${TARGET_CONF}.bak.$(date +%s)"
  cp "$TARGET_CONF" "$BACKUP"
  log "已备份原配置 → $BACKUP"
  # 在第一个 server { 之后插入 include
  awk -v inc="    $INCLUDE_LINE" '
    { print }
    !done && /^[[:space:]]*server[[:space:]]*\{/ { print inc; done = 1 }
  ' "$BACKUP" > "$TARGET_CONF"
  if ! nginx -t >/dev/null 2>&1; then
    cp "$BACKUP" "$TARGET_CONF"
    die "注入后 nginx -t 失败, 已自动回滚到 $BACKUP"
  fi
  log "已注入 include 到 $TARGET_CONF"
else
  warn "需在 $TARGET_CONF 的 server {} 内加一行(或重跑并加 --inject):"
  warn "    $INCLUDE_LINE"
fi

# ── 4. 语法检查与生效 ───────────────────────────────────────────────────
nginx -t || die "nginx 配置校验未通过, 请检查上面的报错"
if command -v systemctl >/dev/null 2>&1; then
  systemctl reload nginx && log "nginx 已 reload"
else
  nginx -s reload && log "nginx 已 reload"
fi

# ── 5. 自检 ─────────────────────────────────────────────────────────────
PUBLIC_IP="$(curl -s --max-time 3 https://api.ipify.org || echo '<服务器公网IP>')"
log "本机自检(清单尚未上传, 期望 404 且响应头非 nginx 默认页):"
curl -s -o /dev/null -w "  /ota/latest-windows.json → HTTP %{http_code}\n" \
  "http://127.0.0.1/ota/latest-windows.json" || true

cat <<EOF

────────────────────────────────────────────────────────────
磁盘目录   : $OTA_ROOT

接下来:
1. 放一个测试清单验证路径通不通:
     echo '{}' > $OTA_ROOT/latest-windows.json
     curl -sI http://${PUBLIC_IP}/ota/latest-windows.json   # 期望 200 + application/json
   (验证后删掉: rm -f $OTA_ROOT/latest-windows.json)

2. GitHub 仓库配置(Settings → Secrets and variables → Actions):
   变量 UPDATE_BASE_URL   = http://${PUBLIC_IP}/ota
   变量 OTA_REMOTE_DIR    = $OTA_ROOT
   变量 OTA_SSH_PORT      = 22
   密钥 OTA_SSH_HOST      = ${PUBLIC_IP}
   密钥 OTA_SSH_USER      = <上传用账号, 需对该目录有写权限>
   密钥 OTA_SSH_KEY       = <对应私钥全文>

3. 上传账号需可写目录:
     chown -R <上传账号>:<上传账号> $OTA_ROOT

注意: 若走 http(非 https), 客户端必须开启 dangerousInsecureTransportProtocol。
     更新包完整性由 ed25519 签名保证, 明文传输不会导致安装被篡改。
────────────────────────────────────────────────────────────
EOF
