#!/usr/bin/env bash
# lib.sh — Stata Workbench Mac 脚本公共库
#
# 被 status.sh / run_visible.sh / run_native_disk0.sh / force_reset.sh / cleanup.sh 共用。
# 仅依赖系统自带 curl + jq（/usr/bin/jq 在本机已确认存在）。
#
# 桥地址 / token 可用环境变量覆盖：
#   STATA_BRIDGE_BASE   默认 http://127.0.0.1:17601
#   STATA_BRIDGE_TOKEN  must be supplied locally for authenticated endpoints
#
# 注意：/run-command 无 token 鉴权；/debug-run-file、/force-reset 等按补丁实现可能需 token。

set -o pipefail

# --- 桥连接常量 ---
BRIDGE_BASE="${STATA_BRIDGE_BASE:-http://127.0.0.1:17601}"
# Never distribute a machine's live bridge token.
BRIDGE_TOKEN="${STATA_BRIDGE_TOKEN:-}"

# --- 颜色输出（TTY 才上色）---
if [ -t 1 ]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'; C_CYN=$'\033[36m'; C_RST=$'\033[0m'
else
  C_RED=""; C_GRN=""; C_YEL=""; C_CYN=""; C_RST=""
fi

log()  { printf '%s\n' "$*" >&2; }
info() { printf '%s%s%s\n' "$C_CYN" "$*" "$C_RST" >&2; }
ok()   { printf '%s%s%s\n' "$C_GRN" "$*" "$C_RST" >&2; }
warn() { printf '%s%s%s\n' "$C_YEL" "$*" "$C_RST" >&2; }
err()  { printf '%s%s%s\n' "$C_RED" "$*" "$C_RST" >&2; }

# --- 基础 HTTP 封装 ---
# bridge_get <path> [timeout-sec]  -> stdout=body, 返回 curl 退出码
bridge_get() {
  curl -s -m "${2:-10}" "${BRIDGE_BASE}$1"
}

# bridge_status -> 拿 /status JSON（失败返回空串 + 非零）
bridge_status() {
  curl -s -m 5 "${BRIDGE_BASE}/status"
}

# bridge_post_json <path> <json-body> <timeout-sec>
bridge_post_json() {
  local path="$1" body="$2" tmo="${3:-120}"
  curl -s -m "$tmo" -X POST \
    -H "Content-Type: application/json" \
    -H "x-stata-bridge-token: ${BRIDGE_TOKEN}" \
    --data "$body" \
    "${BRIDGE_BASE}${path}"
}

# bridge_post_empty <path> <timeout-sec>  用于 /force-reset /graph-clear 这类无 body 端点
bridge_post_empty() {
  local path="$1" tmo="${2:-30}"
  curl -s -m "$tmo" -X POST \
    -H "x-stata-bridge-token: ${BRIDGE_TOKEN}" \
    "${BRIDGE_BASE}${path}"
}

# require_bridge_online — 桥不在线则报错退出
require_bridge_online() {
  if ! bridge_status >/dev/null 2>&1 || [ -z "$(bridge_status)" ]; then
    err "桥不在线：${BRIDGE_BASE}/status 无响应。确认 VS Code 已打开且 Stata Workbench 扩展已激活。"
    exit 3
  fi
}

# json_field <json> <jq-filter>  安全取字段（jq 失败返回空）
json_field() {
  printf '%s' "$1" | jq -r "$2" 2>/dev/null
}
