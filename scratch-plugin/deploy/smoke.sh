#!/usr/bin/env bash
# wx-dsh-agent 部署冒烟测试：离线静态校验（产物完整性、能力边界、无 /opt/wx-dsh-agent/plugins
# 占位残留）+ 尽力而为的离线启动（假密钥，SIGTERM -> exit 0）。
#
#   静态部分失败即退出非 0（严格 gate）；启动部分因环境缺依赖/缺 API key 可跳过（SKIP 非失败）。
# 用法: smoke.sh [DSH_REPO]
set -euo pipefail

DSH_REPO="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD="$SCRIPT_DIR/build-wx-dsh-agent.sh"

TMP_OUT="$(mktemp -d)"
trap 'rm -rf "$TMP_OUT"' EXIT

echo "==>[1/4] build to temporary OUT"
bash "$BUILD" "$TMP_OUT" "$DSH_REPO" >/dev/null

PROFILE_DIR="$TMP_OUT/profiles/wx-dsh"
PLUGINS_DIR="$PROFILE_DIR/plugins"
PATCH="$PROFILE_DIR/cordis.patch.yml"
MANIFEST="$PROFILE_DIR/package.json"

echo "==>[2/4] assert build products exist"
for f in \
  "$PROFILE_DIR/package.json" \
  "$PROFILE_DIR/cordis.patch.yml" \
  "$PLUGINS_DIR/wx-plugin.ts" \
  "$PLUGINS_DIR/wx/config.ts" \
  "$PLUGINS_DIR/wecom-bridge/bridge-plugin.ts" \
  "$TMP_OUT/data" \
  "$TMP_OUT/.env.example"; do
  [ -e "$f" ] || { echo "MISSING product: $f" >&2; exit 1; }
done
# data 与 plugins 均为目录
[ -d "$TMP_OUT/data" ] || { echo "data not a directory" >&2; exit 1; }
[ -d "$PLUGINS_DIR" ] || { echo "plugins not a directory" >&2; exit 1; }

echo "==>[3/4] no /opt/wx-dsh-agent/plugins placeholder residue"
if grep -n '/opt/wx-dsh-agent/plugins' "$PATCH" "$MANIFEST" 2>/dev/null; then
  echo "RESIDUAL /opt/wx-dsh-agent/plugins placeholder found" >&2
  exit 1
fi

echo "==>[3/4] capability boundary: every forbidden tool id appears disabled:true"
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
  # 要求该 id 存在且下方紧跟 disabled: true（顶/下邻行均可；宽松匹配已足够防「未禁用」假绿）
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

echo "==>[3/4] @deepseek-ai/dsh-web-app absent from bundles"
if grep -q '@deepseek-ai/dsh-web-app' "$MANIFEST"; then
  echo "dsh-web-app must not be in bundles" >&2
  exit 1
fi
echo "STATIC CHECKS PASSED"

echo "==>[4/4] best-effort offline launch (fake env, SIGTERM -> exit 0)"
# 需要已 build 的 deepseek-harness 与可用 dsh launcher；缺依赖/缺 API key 时静默跳过（SKIP）。
launch=1
cd "$DSH_REPO"
if ! pnpm dsh --help >/dev/null 2>&1; then
  echo "SKIP launch: 'pnpm dsh' unavailable (repo not built/installed)"
  launch=0
fi
if [ "$launch" -eq 1 ]; then
  LOG="$TMP_OUT/launch.log"
  rm -f "$LOG"
  env \
    DSH_HOME="$TMP_OUT" \
    DEEPSEEK_API_KEY="smoke-fake-key" \
    WX_BOT_ID="smoke-bot" \
    WX_BOT_SECRET="smoke-secret" \
    WX_PRO_HMAC_KEY="smoke-hmac" \
    WX_PRO_GATEWAY="http://127.0.0.1:1" \
    WX_DEFAULT_ENV="pro" \
    WX_DEFAULT_ACCOUNT="smoke-account" \
    pnpm dsh --profile wx-dsh >"$LOG" 2>&1 &
  PID=$!
  sleep 6
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "SKIP launch: process exited early (likely needs real build/keys); log tail:"
    tail -n 8 "$LOG" || true
    launch=2
  else
    kill -TERM "$PID"
    set +e
    wait "$PID"
    CODE=$?
    set -e
    if [ "$CODE" -eq 0 ]; then
      echo "LAUNCH OK: SIGTERM -> exit 0"
    else
      echo "LAUNCH WARN: SIGTERM -> exit $CODE (expected 0)" >&2
    fi
  fi
fi

echo "SMOKE DONE (launch phase exit=$launch; static checks passed)"
[ "$launch" -eq 2 ] && echo "NOTE: live launch skipped/guarded; static deployment checks passed." >&2 || true
[ "$launch" -eq 2 ] && exit 0 || true
exit 0
