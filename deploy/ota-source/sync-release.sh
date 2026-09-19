#!/usr/bin/env bash
# ============================================================================
# LenTalk OTA 自建源同步脚本 —— 服务器主动拉取（取代 CI 跨境 scp 推送）
#
# 背景: CI 的 runner 在美国 Azure 机房，用 scp 把安装包推给腾讯云轻量服务器时实测
#       只有 6~9 KB/s（scp 老协议在长肥链路上吞吐塌陷），约 40MB 产物要传近 2 小时。
#       改成"服务器主动从国内镜像拉"后实测 1.09 MB/s，同样 40MB 只需约 37 秒。
#
# 用法:
#   sync-release.sh                 # 同步最新 release（推荐交给 systemd timer 定时跑）
#   sync-release.sh v1.2.17         # 同步指定 tag
#   sync-release.sh --dry-run       # 只检查并报告，不下载、不写盘
#   sync-release.sh --force         # 忽略版本守卫（允许写成更旧版本，仅用于人工纠错）
#
# 退出码: 0 = 成功或无新版本   1 = 参数/环境错误   2 = 有平台同步失败
# 依赖: curl, jq, flock（Ubuntu 24.04 默认都有）
# ============================================================================
set -uo pipefail

REPO="${REPO:-jownda/LenTalk-Copilot}"
OTA_ROOT="${OTA_ROOT:-/var/www/lentalk-ota}"
MIRROR="${MIRROR:-https://ghfast.top}"     # 置空则直连 github（服务器直连实测仅约 10 KB/s）
API="${API:-https://api.github.com}"
LOCK="${LOCK:-/tmp/lentalk-ota-sync.lock}"

DRY=0
FORCE=0
TAG=""

log()  { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
die()  { log "ERROR: $*"; exit 1; }

usage() {
  cat <<'EOF'
用法: sync-release.sh [选项] [tag]

  不带参数        同步 GitHub 上最新的 release
  v1.2.17         同步指定 tag
  --dry-run       只检查并报告，不下载、不写盘
  --force         忽略版本守卫（允许写成更旧版本，仅用于人工纠错）
  -h, --help      显示本帮助

可用环境变量: REPO OTA_ROOT MIRROR API LOCK
EOF
}

# ver_gt A B  → A 比 B 新则返回 0
ver_gt() {
  [ "$1" != "$2" ] || return 1
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n1)" = "$1" ]
}

# dl <仓库内相对路径> <目标文件> —— 先走镜像，失败再直连
#
# 两点与初版不同:
#   1) 不用 curl -f, 改成自己看 http_code —— 必须把"资产确实不存在(404)"和
#      "链路失败"分开。darwin 尚未发布时每次都 404, 换源去直连 github 毫无意义
#      (而且直连只有约 10 KB/s), 白等几十秒。404 直接判死。
#   2) 加 --speed-limit/--speed-time: 传输卡死(而不是断开)时 45 秒内自动放弃,
#      否则会一直挂到 --max-time 900, 把 systemd timer 的下一轮堵在 flock 外面。
dl() {
  local rel="$1" dest="$2" bases=() b code rc
  [ -n "$MIRROR" ] && bases+=("$MIRROR/https://github.com/$rel")
  bases+=("https://github.com/$rel")
  for b in "${bases[@]}"; do
    code=""
    if code=$(curl -sSL --connect-timeout 15 --max-time 900 \
                 --speed-limit 20480 --speed-time 45 \
                 --retry 2 --retry-delay 3 -o "$dest" -w '%{http_code}' "$b" 2>/dev/null); then
      rc=0
    else
      rc=$?
    fi
    # 只有"curl 正常结束 + HTTP 200"才算拿到完整文件（截断/超速放弃都会是 rc!=0）
    if [ "$rc" = 0 ] && [ "$code" = 200 ]; then
      return 0
    fi
    if [ "$code" = 404 ]; then
      log "  资源不存在(404): $rel"
      return 1
    fi
    log "  下载失败(HTTP ${code:-000} curl=$rc)，换源重试: $(printf '%s' "$b" | cut -c1-44)…"
    rm -f "$dest"
  done
  return 1
}

# sync_platform <名称> <根目录清单名> <必需平台键> <Release 清单名> [附加别名清单名]
sync_platform() {
  local name="$1" manifest="$2" key="$3" rel_manifest="$4" alias_manifest="${5:-}"
  local dir="$WORK/$name"
  mkdir -p "$dir"

  log "[$name] 读取 Release 清单 $rel_manifest"
  if ! dl "$REPO/releases/download/$TAG/$rel_manifest" "$dir/$rel_manifest"; then
    log "[$name] 跳过: Release 里暂无 $rel_manifest（该平台尚未发布完成）"
    return 1
  fi
  if ! jq -e --arg k "$key" '.platforms[$k]' "$dir/$rel_manifest" >/dev/null 2>&1; then
    log "[$name] 跳过: $rel_manifest 不含平台键 $key（资产未就绪）"
    return 1
  fi

  local newver curver
  newver=$(jq -r '.version // empty' "$dir/$rel_manifest")
  [ -n "$newver" ] || { log "[$name] 跳过: 清单缺 version 字段"; return 1; }

  curver=""
  [ -f "$OTA_ROOT/$manifest" ] && curver=$(jq -r '.version // empty' "$OTA_ROOT/$manifest" 2>/dev/null || true)

  if [ "$FORCE" = 0 ]; then
    if [ "$curver" = "$newver" ]; then
      log "[$name] 已是最新 $newver，无需同步"
      return 0
    fi
    if [ -n "$curver" ] && ! ver_gt "$newver" "$curver"; then
      log "[$name] 忽略: 远端 $newver 不高于本地 $curver（版本守卫，防被旧任务覆盖）"
      return 0
    fi
  fi

  # 清单里 url 指向的那个文件的文件名
  local base fname
  base=$(jq -r --arg k "$key" '.platforms[$k].url // empty' "$dir/$rel_manifest")
  [ -n "$base" ] || { log "[$name] 跳过: 平台键 $key 缺 url"; return 1; }
  fname="${base##*/}"

  # 该文件必须已出现在 Release 资产列表里
  local expect_size
  expect_size=$(jq -r --arg n "$fname" '.assets[]? | select(.name==$n) | .size // empty' "$RELJSON" | head -n1)
  if [ -z "$expect_size" ]; then
    log "[$name] 跳过: Release 资产里没有 $fname（可能仍在上传）"
    return 1
  fi

  log "[$name] $curver → $newver  ($fname, $((expect_size/1048576)) MB)"

  if [ "$DRY" = 1 ]; then
    log "[$name] [dry-run] 将落到 $OTA_ROOT/releases/$TAG/$fname 并更新 $OTA_ROOT/$manifest"
    return 0
  fi

  local destdir="$OTA_ROOT/releases/$TAG"
  mkdir -p "$destdir"
  if ! dl "$REPO/releases/download/$TAG/$fname" "$dir/$fname"; then
    log "[$name] 失败: 安装包下载不成功"
    return 1
  fi

  local got_size
  got_size=$(stat -c%s "$dir/$fname")
  if [ "$got_size" != "$expect_size" ]; then
    log "[$name] 失败: 体积不符 期望 $expect_size 实得 $got_size（下载被截断）"
    return 1
  fi

  mv -f "$dir/$fname" "$destdir/$fname"
  # .sig 是给人手工验签用的，非必需，尽力而为
  dl "$REPO/releases/download/$TAG/$fname.sig" "$destdir/$fname.sig" 2>/dev/null || true

  # 清单最后落盘，且用 mv 原子替换 —— 绝不会对外暴露半截 JSON
  cp "$dir/$rel_manifest" "$OTA_ROOT/.$manifest.new"
  mv -f "$OTA_ROOT/.$manifest.new" "$OTA_ROOT/$manifest"
  log "[$name] OK: 根目录清单 $manifest → $newver"

  if [ -n "$alias_manifest" ]; then
    cp "$dir/$rel_manifest" "$OTA_ROOT/.$alias_manifest.new"
    mv -f "$OTA_ROOT/.$alias_manifest.new" "$OTA_ROOT/$alias_manifest"
    log "[$name] OK: 同步别名清单 $alias_manifest"
  fi
  return 0
}

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY=1 ;;
      --force)   FORCE=1 ;;
      -h|--help) usage; exit 0 ;;
      -*)        die "未知参数: $1" ;;
      *)         TAG="$1" ;;
    esac
    shift
  done

  command -v jq    >/dev/null || die "缺少 jq（apt install -y jq）"
  command -v curl  >/dev/null || die "缺少 curl"

  exec 9>"$LOCK"
  flock -n 9 || die "另一个同步任务正在运行，退出"

  WORK=$(mktemp -d)
  trap 'rm -rf "$WORK"' EXIT

  # 取版本信息。注意: 无论哪条路径，都只消耗 1 次 api.github.com 调用 ——
  # 定时轮询必须省着用（匿名限额 60 次/小时/IP，5 分钟一次 = 12 次/小时）。
  RELJSON="$WORK/release.json"
  local apiurl
  if [ -z "$TAG" ]; then
    log "查询 GitHub 最新 release…"
    apiurl="$API/repos/$REPO/releases/latest"
  else
    apiurl="$API/repos/$REPO/releases/tags/$TAG"
  fi
  curl -fsSL --connect-timeout 15 --max-time 60 "$apiurl" > "$RELJSON" \
    || die "无法获取 release 信息（$apiurl）"

  if [ -z "$TAG" ]; then
    TAG=$(jq -r '.tag_name // empty' "$RELJSON")
    [ -n "$TAG" ] || die "响应里没有 tag_name"
  fi
  log "目标版本: $TAG   (dry-run=$DRY force=$FORCE)"
  log "Release 资产: $(jq -r '[.assets[].name] | join(", ")' "$RELJSON")"

  local fail=0
  sync_platform windows latest-windows.json windows-x86_64-nsis latest-windows.json            || fail=$((fail+1))
  sync_platform darwin  latest-darwin.json  darwin-aarch64      latest-darwin.json latest-macos.json || fail=$((fail+1))

  if [ "$fail" -ge 2 ]; then
    log "两个平台都未同步（可能该 Release 尚未产出任何资产）"
    exit 2
  fi
  log "完成"
  exit 0
}

main "$@"
