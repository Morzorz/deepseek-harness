# 企微审批机器人 — 部署参考

> 本目录是**部署组合参考文档**。实际部署由 Task 4.2 的 profile + cordis.patch.yml 驱动；`cordis.yml` 仅作组合意图参考（供评审与排障对照），部署脚本不消费它。

## 概述

企微审批机器人 = DSH 引擎 + 插件层：

- **最小引擎集**：settings / credentials / llm / agent-spine / persistence / checkpoint / token-meter / compaction / guard（重复工具提醒）。
- **能力边界**：只暴露审批工具（wx-agent），显式关闭 agent-spine 自带通用工具（bash/jobs/skills/workspaceContext），并挂企微智能机器人桥接（wecom-bridge）。
- **配置自包含**：真实密钥一律走**环境变量注入**，无真实密钥入库；`wx-cli.conf.json`（含 HMAC 密钥）由 `.gitignore` 排除。

## 环境变量清单

| 变量 | 说明 |
| --- | --- |
| `WX_BOT_ID` / `WX_BOT_SECRET` | 企微智能机器人身份（ws 桥接用） |
| `WX_PRO_HMAC_KEY` / `WX_PRO_GATEWAY` | pro 环境网关签名密钥（也可设 `WX_TEST_*` / `WX_UAT_*`，或用测试环境） |
| `WX_DEFAULT_ENV` | 默认环境，缺省 `pro` |
| `WX_DEFAULT_ACCOUNT` | 本机调试用测试账号 |
| `WX_AUDIT_PATH` | 审计日志路径，默认 `/opt/wx-dsh-agent/data/audit.jsonl` |
| `DEEPSEEK_API_KEY` | LLM API Key |

## 密钥管理说明

- **HMAC / bot 密钥只通过环境变量注入，绝不入库**。
- 真实 `wx-cli.conf.json`（网关签名配置）由 `.gitignore` 排除，仓库内只保留 `wx-cli.conf.template.json` 模板。
- 任何带「真实密钥」的文件一旦生成在 `scratch-plugin/` 下即视为需忽略对象，严禁提交。

## 部署方式（预览）

> 详细步骤由 Task 4.2 补全，此处为形态预览。

- **profile 目录形态**：`$DSH_HOME/profiles/wx-dsh` 下放 profile 声明，`cordis.patch.yml` 为**additive layering patch**，叠加在 dsh-base bundle 之上。
- **打包**：`build-wx-dsh-agent.sh` 将 profile + 插件产出做成可分发 bundle。
- **托管**：systemd 服务常驻运行 wecom 桥接与引擎进程。

## 本目录文件说明

| 文件 | 说明 |
| --- | --- |
| `cordis.yml` | 参考组合意图（最小引擎集 + 审批工具 + persona + 能力边界），供评审/排障，**部署脚本不消费** |
| `cordis.patch.yml` | Task 4.2 实际部署 patch，additive，后续任务产生 |

## 启动方式（预览）

```bash
# 环境变量（示例）
export WX_DEFAULT_ENV=test
export WX_DEFAULT_ACCOUNT=<调试账号>
export DEEPSEEK_API_KEY=<key>

# 预览：从参考组合启动
dsh --profile headless "查我的审批待办"
```

## systemd 示例（占位）

> 具体 unit 内容由 Task 4.2 完善。

```ini
[Unit]
Description=WX DSH Approval Bot
After=network.target

[Service]
Type=simple
EnvironmentFile=/etc/wx-dsh-agent/env
ExecStart=/usr/local/bin/wx-dsh-agent run --profile wx-dsh
Restart=on-failure

[Install]
WantedBy=multi-user.target
```
