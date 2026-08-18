# 企业微信审批机器人（DSH 引擎 + 插件层）设计

日期：2026-08-18
状态：已确认（设计决策经逐节评审）

## 1. 目标与动机

把企业微信审批能力部署为**服务器上的智能审批助理**：员工通过企微智能机器人（WS 长连接）对话，查询待办、查看详情、完成审批通过/驳回。核心诉求：

- 部署在服务器（systemd 托管），可移植、自包含，**取消 scratch-plugin 对外部目录（wxHome）的依赖**；
- 审批写操作可靠、容错（比现有 Go wx-agent 出错率更低）；
- **能力边界**：agent 只做审批相关事，拒绝无关请求，但保留后续扩展能力。

## 2. 关键决策（已确认）

| 决策点 | 结论 |
|--------|------|
| 引擎 | DeepSeek Harness 作为审批引擎；**DSH 源码零改动**，全部功能经插件层实现 |
| 接入 | 企微智能机器人 **WS 长连接**（无需公网 URL、无需加解密；移植 Go 版 `wecom/longconn.go` 协议） |
| 会话映射 | 按企微 `userID` 一对一会话（userID → DSH session 1:1） |
| 确认交互 | **企微对话框两步确认**：approve（只生成摘要、不执行）→ 用户回复「确认」→ confirm 才执行；pro 环境对话框确认足够，不叠加 DSH approval 弹窗 |
| 身份模型 | 删除本机扫码会话（`~/.wx-cli/<env>.json`）；网关请求 `X-Account` 直接取调用上下文里的企微 userID；本机开发用配置 `defaultAccount` 测试账号 |
| 配置打包 | 业务注册表（无敏感）内置进插件资源；HMAC 密钥走**环境变量注入**（`WX_*_HMAC_KEY`），模板提交、真实值不进 git |
| 能力边界 | 组合配置**只挂审批工具**，不挂 bash/fs/web/subagent 等无关能力；persona 固定审批助手身份；组合模块化以保留扩展能力 |

## 3. 总体架构

```
┌────────────────────────── 服务器（单进程）──────────────────────────┐
│  DSH (DeepSeek Harness)                                             │
│  ┌──────────────────────┐      ┌───────────────────────────────┐   │
│  │ wecom-bridge 插件(新) │      │ scratch-plugin（改造）          │   │
│  │ · WS 长连接           │      │ · wx_query_todo/detail/biz    │   │
│  │ · userID→会话 1:1 路由 │ ──▶  │ · wx_approve + wx_confirm     │   │
│  │ · 回复经 WS 回企微     │      │ · 身份=X-Account(userID)       │   │
│  └──────────────────────┘      │ · 配置/注册表内置              │   │
│             ▲                   └────────┬──────────────────────┘   │
│             │ WS                          │ HMAC 签名请求            │
└─────────────┼─────────────────────────────┼─────────────────────────┘
       企微智能机器人                   企业微信审批网关
       (openws.work.weixin.qq.com)
```

分层职责：接入层（wecom-bridge，WS 协议/心跳/重连/路由）、引擎层（DSH agent 循环/LLM/会话/guard）、工具层（scratch-plugin 审批业务）。

数据流（审批示例）：

1. 用户发消息 → wecom-bridge 收到 `{userID, text}` → 取/建该用户 DSH 会话 → 发 prompt；
2. agent 调 `wx_query_todo`（身份=userID）→ 回复待办列表；
3. 用户发「审批通过 PRxxx」→ agent 调 `wx_approve`（定位单据、推导参数、存 pending、生成摘要，**不执行**）→ 回复「确认将以当前账号执行审批通过？回复『确认』执行」；
4. 用户回复「确认」→ agent 调 `wx_confirm(decision=confirm)` → 从 pending 取出执行 → 回复结果。

## 4. 配置与注册表打包（解决 wxHome 依赖）

### 4.1 内置注册表（无敏感，进 git）

新增到 `scratch-plugin/src/wx/`：

```
registry/            purchase.json / liquidity.json / xincontract.json（从 wx 仓库 copy）
biz-index.json       wx-cli.biz.json 内容
```

`WxRegistry.load()` 改造：**默认读内置资源**；仅当配置显式提供 `wxHome` 覆盖路径时才去外部读（保留开发期灵活性，服务器部署不设）。

### 4.2 密钥配置（模板 + 环境变量，不进 git）

- 提交 `wx-cli.conf.template.json`：`hmac_key`/`gateway` 等留空占位；
- 运行时从环境变量注入：`WX_TEST_HMAC_KEY` / `WX_UAT_HMAC_KEY` / `WX_PRO_HMAC_KEY`（网关地址可选注入）；
- `config.ts` 改造：`load(base?)` 有真实文件值用之，否则回退环境变量，都没有则中文报错；
- `.gitignore` 增加 `wx-cli.conf.json` 防误提交真实密钥。

### 4.3 移除本机会话

- 删除 `session.ts` 及 `loadSession()`；`readySession()` 不再读 `~/.wx-cli/<env>.json`；
- account 来自调用上下文（见 §5），消灭「未登录」报错与扫码依赖。

### 4.4 wxHome 配置项变化

- `cordis.yml` 的 `wxHome` 变为可选：省略=全内置；保留=覆盖注册表/配置路径（调试用）；
- 服务器部署 cordis.yml 无任何绝对路径。

## 5. 身份模型改造（核心难点）

`api.ts` 的 `readySession()` 改为从调用上下文取身份：

```ts
export interface WxOpContext {
  config: WxConfig
  registry: WxRegistry
  defaultEnv?: string
  transport?: WxTransport
  account?: string            // 当前企微用户身份
}

// readySession:
const account = ctx.account ?? ctx.defaultAccount ?? ''
if (!account) throw new Error('缺少当前用户身份（plugin 未注入 account）')
return { env, gateway, hmacKey, account }
```

- 服务器路径：wecom-bridge 收到消息时把 userID 绑定到该用户的 DSH 会话，工具执行时经执行上下文回传 userID → `X-Account=userID`（对齐 Go 版 `executor.go` 的多用户隔离）;
- 本机开发路径：配置 `defaultAccount` 测试账号，保持 Web GUI 手工调用可用；
- `{{memberCode}}` 动态变量保留（`X-Account=userID` 就位后由 `wxGetMemberCode` 自动获取）。

## 6. 两步确认机制

### 6.1 新增工具 `wx_confirm`

- 参数：`decision`（confirm=cancel 之外的确认；cancel=放弃）
- 描述：确认/取消待执行的审批；用户回复「确认」时调用 confirm，「取消」时调用 cancel（清理 pending）

### 6.2 pending 存储（新文件 `src/wx/pending.ts`）

移植 Go 版 `pendingStore` 并强化：

```ts
interface PendingApprove {
  biz: string
  action: 'approve' | 'reject'
  orderNumber: string
  vars: Record<string, string>   // 审批参数（含自动推导字段）
  summary: string
  account: string                // 归属用户，按 userID 隔离
  expireAt: number               // 5 分钟 TTL
}
```

- 按 userID 隔离（用户 A 不能确认 B 的单据）；
- 5 分钟 TTL（对齐 Go 版）；
- 并发安全：`take()` 原子取出即删，防重复执行；同轮 approve+confirm 拒绝（防绕过二次确认）；
- **强化（修 Go 版缺陷）**：执行失败时 pending 回写，用户可再回复「确认」重试。

### 6.3 wx_approve 行为

调用 → 网关定位单据 + 推导全部审批参数（移植 `prepareApprove`）→ 存 pending → 返回中文摘要（系统/单号/名称/申请人/金额/节点 + 「回复「确认」执行，回复「取消」放弃」）→ **不执行写操作**。

### 6.4 wx_confirm 行为

- confirm：`pending.take()` → 执行网关审批 → 返回结果；
- cancel：`pending.take()` → 返回「已取消审批操作」；
- 无 pending：返回「没有待确认的审批（可能已过期或已处理，请重新发起）」；
- 执行失败：pending 回写，可重试。

## 7. 容错与可观测性

| 场景 | 设计 |
|------|------|
| LLM/工具调用 | DSH guard 层：超时、重试、token 控制（配置即用，不自写） |
| WS 断线 | 3 秒自动重连（移植 longconn.go） |
| 心跳超时 | 30s ping，失败触发重连 |
| 订阅失败 | 重连后重新 subscribe + 校验 errcode |
| 消息处理失败 | 回复具体错误（如「网关查询失败：HTTP 403」），不做模糊回复 |
| 同用户并发 | 同一 userID 消息串行处理，防 LLM 并发出错 |
| 审批执行失败 | pending 回写可重试（§6.4） |
| 审计 | 每次审批的请求/确认/执行/结果写审计日志（移植 audit.go） |
| 状态查询 | 可选 `wx_pending_status` 工具：用户可以问「我还有没有待确认的审批」 |
| 优雅退出 | SIGTERM → 关 WS → 会话落盘 → 退出（systemd 平滑重启） |

## 8. 能力边界（避免无关操作）

**原则：先按最小集执行，保留扩展能力。**

### 8.1 工具面收敛（硬边界）

组合配置（cordis.yml）**只挂**：

- ✅ wecom-bridge（消息入口）
- ✅ scratch-plugin（审批工具）
- ✅ agent-spine / LLM / persistence（引擎）
- ✅ guard：timeout-policy、repeat-tool-reminder（防护）
- ❌ **不挂**：bash / fs / web / subagent / workflow / goal / ralph / todo 等无关能力

模型拿不到这些工具 → 物理上无法执行无关操作（非提示词软约束，是能力不存在）。

### 8.2 系统提示词（软约束）

persona 固定：**「你是企业微信审批助手」**，只处理待办查询、详情、审批通过/驳回；与审批无关的请求（写代码、查资料、闲聊等）礼貌拒绝。

### 8.3 扩展保留

- 组合配置模块化：后续要加能力（如只读资料查询）时，只需在 cordis.yml 追加插件 + 更新 persona，无需改 DSH 或插件核心；
- 默认不启用扩展，保持最小攻击面。

## 9. 部署形态

```
/opt/wx-dsh-agent/
├── dsh                      # DSH + 插件打包后的可执行入口
├── cordis.yml               # 组合：wecom-bridge + scratch-plugin + 引擎
├── .env                     # WX_*_HMAC_KEY 等密钥
└── data/                    # DSH session 持久化
```

- 新增 `bin/build-wx-dsh-agent.sh`：打包运行时 + 插件 + 内置注册表为自包含目录（参照现有 build-wx-agent.sh 风格）；
- systemd 单元：`Restart=always` + `RestartSec=3`，日志走 journald；
- 零外部路径依赖；服务器出向连企微 WS，无需公网入向端口。

## 10. 交付物清单

| 类型 | 文件 | 说明 |
|------|------|------|
| 新插件 | `scratch-plugin/src/wecom-bridge/` | WS 桥接（移植 Go 版 wecom 包） |
| 改造 | `scratch-plugin/src/wx-plugin.ts` | 注册 wx_confirm、去 wxHome 依赖 |
| 改造 | `src/wx/config.ts` / `registry.ts` / `api.ts` / `client.ts` | 内置注册表、环境变量密钥、userID 身份 |
| 新增 | `src/wx/pending.ts` / `audit.ts` | 两步确认 + 审计 |
| 新增 | `scratch-plugin/src/wx/registry/` + `biz-index.json` | 内置注册表资源 |
| 打包 | `bin/build-wx-dsh-agent.sh` + systemd 单元 | 部署交付 |

## 11. 测试策略

| 层 | 覆盖 | 关键手段 |
|----|------|---------|
| 单元测试 | pending 状态机（TTL/并发/失败回写）、占位符替换、HMAC 签名、配置加载（环境变量注入） | vitest，纯函数无网 |
| 工具级测试 | wx_approve/wx_confirm 全流程（mock transport 注入网关） | 复现现有 wx-plugin.test.ts 模式 |
| 桥接测试 | WS 协议编解码、重连、消息路由 | mock websocket server |
| 快照测试 | 完整对话场景（查待办→审批→确认）输出文本 | DSH snapshot 机制、键无关 |
| 部署冒烟 | 打包目录在干净机器启动、会话落盘、优雅退出 | shell + systemd 单元检查 |

## 12. 非目标（明确不做）

- 不实现企微扫码登录（机器人场景不需要，身份直接来自 userID）；
- 不改 DSH 源码（agent-loop、approval 机制等保持原样）；
- 不实现自建应用 Webhook 回调（本期仅智能机器人 WS 长连接；Webhook 作为未来扩展）；
- 不在插件内置真实密钥（密钥一律环境变量注入）。