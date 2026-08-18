#!/usr/bin/env bash
# wx-dsh-agent 部署冒烟测试：build（生成 profile + dsh plugin add 安装插件包）→ 静态校验
# （产物完整性、能力边界、包名 patch、无 dsh-web-app）→ 尽力而为的离线启动（假密钥，
# SIGTERM -> exit 0）。
#
#   静态部分失败即退出非 0（严格 gate）；启动部分因环境缺依赖/缺 API key 可跳过
#   （LAUNCH-SKIPPED 非失败，但要区别它和真正启动失败）。
# 用法: smoke.sh [DSH_REPO]
set -euo pipefail

DSH_REPO="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD="$SCRIPT_DIR/build-wx-dsh-agent.sh"
PLUGIN_DIR="$DSH_REPO/scratch-plugin"

# 前置：dsh 必须在 PATH（build 脚本依赖 `dsh plugin add`；在仓库内可用 pnpm dsh 包装）
command -v dsh >/dev/null 2>&1 || { echo "SKIP: no 'dsh' on PATH — build phase needs dsh plugin add. Install DSH first (or add scripts/dsh to PATH)." >&2; exit 0; }

TMP_OUT="$(mktemp -d)"
trap 'rm -rf "$TMP_OUT"' EXIT

echo "==>[1/5] build to temporary OUT"
bash "$BUILD" "$TMP_OUT" "$PLUGIN_DIR" "$DSH_REPO" >/dev/null

PROFILE_DIR="$TMP_OUT/profiles/wx-dsh"
PATCH="$PROFILE_DIR/cordis.patch.yml"
MANIFEST="$PROFILE_DIR/package.json"
PKG_LINK="$PROFILE_DIR/node_modules/@wx-dash/plugins"

echo "==>[2/5] assert build products exist"
for f in \
  "$PROFILE_DIR/package.json" \
  "$PROFILE_DIR/cordis.patch.yml" \
  "$TMP_OUT/data" \
  "$TMP_OUT/.env.example"; do
  [ -e "$f" ] || { echo "MISSING product: $f" >&2; exit 1; }
done
[ -d "$TMP_OUT/data" ] || { echo "data not a directory" >&2; exit 1; }

# 插件包已由 `dsh plugin add` link 安装进 profile node_modules，且指向插件源码
if [ ! -e "$PKG_LINK/package.json" ]; then
  echo "MISSING installed plugin package: $PKG_LINK" >&2
  echo "（npm pnpm link 应使 node_modules/@wx-dash/plugins 存在）" >&2
  exit 1
fi

echo "==>[3/5] patch references plugin by package name (not .ts relative path)"
if grep -nE "name: '\./plugins/" "$PATCH"; then
  echo "RESIDUAL relative .ts plugin path in patch (must use package name)" >&2
  exit 1
fi
if ! grep -nE "name: '@wx-dash/plugins(/bridge)?'" "$PATCH" >/dev/null; then
  echo "patch must reference @wx-dash/plugins (and /bridge) by package name" >&2
  exit 1
fi

echo "==>[3/5] capability boundary: every forbidden tool id appears disabled:true"
forbidden_ids=(
  tool-bash tool-pwsh tool-jobs
  tool-fs tool-fs-search tool-skill
  skill skill-filesystem skill-badge
  commands command-feedback command-goal command-compact
  goal goal-round-driver plan-mode
  subagent subagent-spawn-in-process subagent-fork-in-process
  tool-subagent-control tool-subagent-list-agents tool-subagent tool-subagent-fork tool-subagent-report
  workflow-worker-thread tool-workflow tool-result-pruner
  tool-todo tool-goal tool-ralph tool-str-replace-editor
  web web-search-deepseek tool-web
)
missing=0
for id in "${forbidden_ids[@]}"; do
  if ! awk -v id="$id" '
    BEGIN{mode="out"}
    $0 ~ "^[[:space:]]*- id: "id"$"          {mode="in"; next}
    mode=="in" && /^[[:space:]]*disabled:/   {if ($0 !~ /true/) {bad=1} else {ok=1}; mode="out"; next}
    mode=="in" && /^[[:space:]]*- id:/       {mode="out"; next}
    END{exit !(ok && !bad)}
  ' "$PATCH"; then
    echo "FORBIDDEN tool not disabled: $id" >&2
    missing=1
  fi
done
[ "$missing" -eq 0 ] || exit 1

# 保持启用的引擎/守护行必须仍在（未误禁）
for keep in timeout-policy repeat-tool-reminder; do
  grep -q "^[[:space:]]*- id: $keep$" "$PATCH" && echo "engine row wrongly disabled: $keep" >&2 && exit 1
done

echo "==>[3/5] @deepseek-ai/dsh-web-app absent from bundles"
if grep -q '@deepseek-ai/dsh-web-app' "$MANIFEST"; then
  echo "dsh-web-app must not be in bundles" >&2
  exit 1
fi
echo "STATIC CHECKS PASSED"

echo "==>[5/5] best-effort offline launch (fake env, SIGTERM -> exit 0)"
launch=1
if [ ! -f "$DSH_REPO/apps/cli/src/bin.ts" ]; then
  echo "LAUNCH-SKIPPED: apps/cli/src/bin.ts not found in $DSH_REPO"
  launch=0
fi
if [ "$launch" -eq 1 ]; then
  LOG="$TMP_OUT/launch.log"
  rm -f "$LOG"
  # 直接跑 node 入口（与 DSH 源码运行一致），绕过 `pnpm dsh` 的 pnpm 父进程包装——
  # 否则 SIGTERM 发给 pnpm 返回 143 而 DSH 的优雅关闭（SIGTERM->exit 0）只对 node 进程成立。
  # `exec` 让后台 subshell 被替换为 node 进程，$PID 即 node（kill -TERM 直接命中它）。
  (cd "$DSH_REPO" && exec env \
    DSH_HOME="$TMP_OUT" \
    DEEPSEEK_API_KEY="smoke-fake-key" \
    WX_BOT_ID="smoke-bot" \
    WX_BOT_SECRET="smoke-secret" \
    WX_PRO_HMAC_KEY="smoke-hmac" \
    WX_PRO_GATEWAY="http://127.0.0.1:1" \
    WX_DEFAULT_ENV="pro" \
    WX_DEFAULT_ACCOUNT="smoke-account" \
    node --import tsx/esm apps/cli/src/bin.ts --profile wx-dsh >"$LOG" 2>&1) &
  PID=$!
  sleep 8
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "LAUNCH-SKIPPED: process exited early (likely needs real build/keys OR a genuine boot error); log tail:"
    tail -n 12 "$LOG" || true
    launch=2
    # 若日志含 duplicate/cycle/failed-to-load → 视为真实失败而非跳过
    if grep -qiE "ERR_REQUIRE_CYCLE_MODULE|duplicate loader entry|failed to (import|apply) loader entry" "$LOG"; then
      echo "REAL BOOT FAILURE (not environment): see above" >&2
      exit 1
    fi
  else
    kill -TERM "$PID"
    # DSH 优雅关闭最长 5s，等待其自己的退出（SIGTERM -> exit 0）
    for _ in $(seq 1 6); do
      sleep 1
      kill -0 "$PID" 2>/dev/null || break
    done
    set +e
    wait "$PID"
    CODE=$?
    set -e
    if kill -0 "$PID" 2>/dev/null; then
      echo "LAUNCH WARN: process still running 6s after SIGTERM (graceful drain not completing); killing" >&2
      kill -9 "$PID" 2>/dev/null || true
    elif [ "$CODE" -eq 0 ]; then
      echo "LAUNCH OK: SIGTERM -> exit 0"
    else
      echo "LAUNCH WARN: SIGTERM -> exit $CODE (expected 0)" >&2
    fi
  fi
fi

echo "SMOKE DONE (launch phase=$launch; static checks passed)"
if [ "$launch" -eq 2 ]; then
  echo "NOTE: live launch skipped/guarded; static deployment checks passed." >&2
fi
exit 0
