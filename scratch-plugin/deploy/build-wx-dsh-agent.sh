#!/usr/bin/env bash
# 自包含部署打包脚本：在 $OUT 下生成 wx-dsh profile 目录 + 插件源码 + 环境变量模板。
#
# 用法:
#   build-wx-dsh-agent.sh [OUT] [DSH_REPO]
#     OUT      部署根目录（默认 /opt/wx-dsh-agent）
#     DSH_REPO deepseek-harness 仓库根（默认当前目录）
#
# 产物形态（profile-boot 消费标准 profile 目录）:
#   $OUT/profiles/wx-dsh/
#     package.json      声明 dsh.profile.bundles=[@deepseek-ai/dsh-base]（只挂 dsh-base）
#     cordis.patch.yml  叠加 patch：禁用无关工具 + 插入 wx-agent / wecom-bridge
#     plugins/          wx/、wecom-bridge/、wx-plugin.ts（保留源码目录结构）
#   $OUT/data/          会话与审计落盘目录
#   $OUT/.env.example   环境变量模板（密钥占位，由部署者复制为 .env 填写）
set -euo pipefail

OUT="${1:-/opt/wx-dsh-agent}"
DSH_REPO="${2:-$(pwd)}"
# 本脚本所在目录（即 deploy/，内含 cordis.patch.yml 与源码相对路径）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE_DIR="$OUT/profiles/wx-dsh"
PLUGINS_DIR="$PROFILE_DIR/plugins"

# 1. 目录骨架
mkdir -p "$PLUGINS_DIR" "$OUT/data"

# 2. profile 声明：只挂 @deepseek-ai/dsh-base（引擎行），不挂 dsh-web-app（无 Web UI）
cat > "$PROFILE_DIR/package.json" <<'EOF'
{
  "name": "wx-dsh-agent",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base"] } }
}
EOF

# 3. 拷贝 patch 层，并把插件路径规整为相对 profile 目录的 ./plugins/...（profile dir 是
#    Loader 的 baseUrl）。
#    同时兜底：把任何残留的 /opt/wx-dsh-agent/plugins/... 绝对占位替换为相对路径，
#    保证产物不残留 /opt/wx-dsh-agent/plugins 占位（smoke 校验项）。
cp "$SCRIPT_DIR/cordis.patch.yml" "$PROFILE_DIR/cordis.patch.yml"
sed -i '' 's#/opt/wx-dsh-agent/plugins/#./plugins/#g; s# /opt/wx-dsh-agent/plugins# ./plugins#g' "$PROFILE_DIR/cordis.patch.yml" 2>/dev/null \
  || sed -i 's#/opt/wx-dsh-agent/plugins/#./plugins/#g; s# /opt/wx-dsh-agent/plugins# ./plugins#g' "$PROFILE_DIR/cordis.patch.yml"

# 4. 拷贝插件源码，保留目录结构：
#      wx-plugin.ts        -> plugins/wx-plugin.ts
#      src/wx/             -> plugins/wx/
#      src/wecom-bridge/   -> plugins/wecom-bridge/
cp "$DSH_REPO/scratch-plugin/src/wx-plugin.ts" "$PLUGINS_DIR/wx-plugin.ts"
cp -R "$DSH_REPO/scratch-plugin/src/wx" "$PLUGINS_DIR/wx"
cp -R "$DSH_REPO/scratch-plugin/src/wecom-bridge" "$PLUGINS_DIR/wecom-bridge"

# 5. data 目录 + 环境变量模板（密钥由部署者写入 .env，绝不入库）
mkdir -p "$OUT/data"
cat > "$OUT/.env.example" <<'EOF'
# 复制为 /opt/wx-dsh-agent/.env 并填写真实值（密钥绝不入库）
WX_BOT_ID=
WX_BOT_SECRET=
WX_PRO_HMAC_KEY=
WX_PRO_GATEWAY=
WX_DEFAULT_ENV=pro
WX_DEFAULT_ACCOUNT=
WX_AUDIT_PATH=/opt/wx-dsh-agent/data/audit.jsonl
DEEPSEEK_API_KEY=
EOF

# 6. 输出产物清单
echo "=== built $OUT ==="
find "$OUT" -type f | sort
