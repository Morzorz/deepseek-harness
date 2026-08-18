#!/usr/bin/env bash
# 自包含部署打包脚本：在 $OUT 下生成 wx-dsh profile 目录，并把插件安装为可加载包。
#
# 用法:
#   build-wx-dsh-agent.sh [OUT] [PLUGIN_DIR] [DSH_REPO]
#     OUT        部署根目录（默认 /opt/wx-dsh-agent；DSH_HOME 指向此目录）
#     PLUGIN_DIR 插件包目录（默认本仓库 scratch-plugin，包名 @wx-dash/plugins）
#     DSH_REPO   deepseek-harness 仓库根（默认当前目录；dsh 命令所在处）
#
# 产物形态（profile-boot 消费标准 profile 目录）:
#   $OUT/profiles/wx-dsh/
#     package.json      声明 dsh.profile.bundles=[@deepseek-ai/dsh-base]（只挂 dsh-base）
#     cordis.patch.yml  叠加 patch：禁用无关工具 + 以包名插入 wx-agent / wecom-bridge
#     node_modules/     dsh plugin add 安装的 @wx-dash/plugins（pnpm link 到 PLUGIN_DIR）
#   $OUT/data/          会话与审计落盘目录
#   $OUT/.env.example   环境变量模板（密钥占位，由部署者复制为 .env 填写）
#
# 插件以「包名 + ESM .ts 源码」从 node_modules 加载（pnpm link 本地包，依赖经 profile
# 目录 Node parent-walk 解析到 DSH 安装）。相对路径 .ts + include 在此环境不可用
# （ERR_REQUIRE_CYCLE_MODULE），这是 DSH 对相对路径 .ts 插件的平台限制，与插件无关。
#
# 注意：脚本含中文字符；请勿把 `$PLUGIN_DIR`/`$PROFILE_DIR` 等变量名改写成含
# Unicode 变体字母（会把变量名污染，导致 set -u 报 unbound variable）。
set -euo pipefail

OUT="${1:-/opt/wx-dsh-agent}"
PLUGIN_DIR="${2:-$(pwd)/scratch-plugin}"
DSH_REPO="${3:-$(pwd)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE_DIR="$OUT/profiles/wx-dsh"

# 0. 前置检查：dsh 可用（dsh plugin 命令需要）
command -v dsh >/dev/null 2>&1 || { echo "错误: 未找到 dsh 命令（dsh plugin add 依赖它）" >&2; exit 1; }

# 1. 目录骨架
mkdir -p "$PROFILE_DIR" "$OUT/data"

# 2. profile 声明：只挂 @deepseek-ai/dsh-base（引擎行），不挂 dsh-web-app（无 Web UI）
cat > "$PROFILE_DIR/package.json" <<'EOF'
{
  "name": "wx-dsh-agent",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base"] } }
}
EOF

# 3. 注册插件包：`dsh plugin --profile wx-dsh add <PLUGIN_DIR>` 转发 pnpm，
#    把本地插件包 link 安装进 profile node_modules，并把依赖记入 manifest。
DSH_HOME="$OUT" dsh plugin --profile wx-dsh add "$PLUGIN_DIR"
#    （部署机需先安装 DSH 使 dsh 命令可用；脚本已在步骤 0 检查。）

# 4. 拷贝 patch 层（已是包名 subpath 引用 @wx-dash/plugins、@wx-dash/plugins/bridge）
cp "$SCRIPT_DIR/cordis.patch.yml" "$PROFILE_DIR/cordis.patch.yml"

# 5. 环境变量模板（密钥由部署者写入 .env，绝不入库）
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
find "$OUT" -type f -not -path '*/node_modules/*' | sort
echo "（插件包位于 ${PROFILE_DIR}/node_modules/@wx-dash/plugins，pnpm link 指向 ${PLUGIN_DIR}）"
