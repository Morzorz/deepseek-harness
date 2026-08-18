# 企微审批机器人 — 部署参考

> 本目录是**部署组合参考文档**。实际部署由 profile + `cordis.patch.yml` 驱动；`cordis.yml` 仅作组合意图参考（供评审与排障对照），部署脚本不消费它。部署链路（build → `dsh plugin add` 安装插件包 → profile 启动）已经真实实验验证。

## 概述

企微审批机器人 = DSH 引擎 + 插件层：

- **最小引擎集**：profile 只挂 `@deepseek-ai/dsh-base`（settings / credentials / llm / session / agent / tools / persistence / checkpoint / token-meter / compaction / guard 等引擎行）。
- **能力边界**：`cordis.patch.yml` 用**顶层 `disabled: true`** 关掉 dsh-base 默认挂载的全部无关工具（bash / fs / skill / subagent / workflow / goal / ralph / todo / web / plan-mode / commands 等），只保留审批工具（wx-agent）+ 企微桥接（wecom-bridge）与引擎行。
- **配置自包含**：真实密钥一律走**环境变量注入**，无真实密钥入库；`wx-cli.conf.json`（含 HMAC 密钥）由 `.gitignore` 排除。

## 部署形态（包安装）

插件以**包名 + ESM `.ts` 源码**从 profile 的 `node_modules` 加载，这是 DSH 支持且经实验确认的方式：

| 环节 | 方式 |
| --- | --- |
| 插件包 | `scratch-plugin/` 声明为 `@wx-dash/plugins`（`package.json` 的 `exports` 暴露 `wx-plugin.ts` 与 `wecom-bridge/bridge-plugin.ts`） |
| 安装 | `dsh plugin --profile wx-dsh add <scratch-plugin>`（pnpm link，装进 profile `node_modules`） |
| patch 引用 | `cordis.patch.yml` 用**包名** `@wx-dash/plugins` / `@wx-dash/plugins/bridge`（非相对 `.ts` 路径） |
| 依赖解析 | `@deepseek-ai/*` 经 profile 目录 Node parent-walk 解析到 DSH 安装依赖 |

> **为什么不直接用相对路径 `.ts`**：DSH `--profile` 的 include 对**相对路径 `.ts` 插件**走 CJS require 桥接，报 `ERR_REQUIRE_CYCLE_MODULE`（连 DSH 官方自带的 `.ts` 插件同样失败，是平台限制）；而**包名**解析走正常的 ESM import（官方插件形式），ESM `.ts` 源码原样可用。

## 环境变量清单

| 变量 | 说明 |
| --- | --- |
| `WX_BOT_ID` / `WX_BOT_SECRET` | 企微智能机器人身份（ws 桥接用） |
| `WX_PRO_HMAC_KEY` / `WX_PRO_GATEWAY` | pro 环境网关签名密钥（也可设 `WX_TEST_*` / `WX_UAT_*`） |
| `WX_DEFAULT_ENV` | 默认环境，缺省 `pro` |
| `WX_DEFAULT_ACCOUNT` | 本机调试用测试账号 |
| `WX_AUDIT_PATH` | 审计日志路径，默认 `/opt/wx-dsh-agent/data/audit.jsonl` |
| `DEEPSEEK_API_KEY` | LLM API Key |

## 密钥管理说明

- **HMAC / bot 密钥只通过环境变量注入，绝不入库**。
- 真实 `wx-cli.conf.json`（网关签名配置）由 `.gitignore` 排除，仓库内只保留 `wx-cli.conf.template.json` 模板。
- 部署用 `.env`（由 `.env.example` 复制）在 `$DSH_HOME` 根，由 build 脚本外的部署者填写，不入库。

## 部署步骤

```bash
# 1. 生成部署目录（含 profile 声明、插件包安装、patch、.env.example）
build-wx-dsh-agent.sh /opt/wx-dsh-agent /path/to/scratch-plugin /path/to/deepseek-harness

# 2. 填写密钥
cp /opt/wx-dsh-agent/.env.example /opt/wx-dsh-agent/.env   # 填入 WX_BOT_ID / WX_BOT_SECRET / WX_PRO_HMAC_KEY 等

# 3. 启动（node 直接入口，SIGTERM -> exit 0 的优雅关闭只对 node 进程成立）
export DSH_HOME=/opt/wx-dsh-agent
node --import tsx/esm /path/to/deepseek-harness/apps/cli/src/bin.ts --profile wx-dsh
```

系统托管：用 `wx-dsh-agent.service`（systemd，直接 `node` 启动，优雅关闭与 journald 日志）。

## 本目录文件说明

| 文件 | 说明 |
| --- | --- |
| `cordis.yml` | 参考组合意图（最小引擎集 + 审批工具 + persona + 能力边界），供评审/排障，**部署脚本不消费** |
| `cordis.patch.yml` | **实际部署 patch**：顶层禁用无关工具 + 包名插入 `wx-agent` / `wecom-bridge` |
| `build-wx-dsh-agent.sh` | 生成 profile 目录 + `dsh plugin add` 安装插件包 + 产出 `.env.example` |
| `smoke.sh` | 冒烟测试：build → 静态校验（产物/包名/能力边界/无 web-app）→ 真实启动 + SIGTERM→exit 0 |
| `wx-dsh-agent.service` | systemd 托管单元（node 直接启动） |
