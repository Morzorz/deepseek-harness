# 企业微信审批机器人（wx-dsh-approval-assistant）实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 部署一个服务器端企业微信智能审批机器人：DSH 引擎 + 插件层（零 DSH 源码改动），企微智能机器人 WS 长连接接入，审批通过/驳回走对话框两步确认，配置/注册表自包含（无 wxHome 外部目录依赖），Agent 仅暴露审批能力。

**Architecture:** 单进程部署 `/opt/wx-dsh-agent/`：wecom-bridge 插件（新增，WS 长连接 + userID→会话路由）把企微消息送入 DSH agent；scratch-plugin（改造）提供审批工具（wx_query_todo/detail/biz + wx_approve/wx_confirm），身份直接取调用上下文 userID（`X-Account`），注册表内置为插件资源，HMAC 密钥走环境变量注入。组合配置只挂审批工具 + 引擎，不挂 bash/fs/web/subagent 等无关能力。

**Tech Stack:** TypeScript (ESM, tsx 运行)、vitest（单元测试）、Node 22 原生 `WebSocket`（无第三方 WS 依赖）、DeepSeek Harness 插件机制（cordis.yml 组合）、schemastery 工具 schema。

**前置阅读：** 设计文档 `docs/superpowers/specs/2026-08-18-wx-dsh-approval-assistant-design.md`；Go 参考实现 `develop/wokspace/GitWorkSpace/wx/bin/internal/wecom/`（longconn.go、wsclient.go）、`internal/agent/`（approve.go、executor.go、audit.go）。

**验证基线：** `cd /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin && npx vitest run` 当前 20 个测试全绿。

---

## Chunk 1: 配置自包含改造（注册表内置 + 密钥环境变量注入）

目标：消灭 wxHome 外部目录依赖。WxRegistry 默认读插件内置资源；WxConfig 支持环境变量注入密钥；移除 `session.ts`。

### Task 1.1: 内置注册表资源

**Files:**
- Create: `scratch-plugin/src/wx/registry-assets/biz-index.json`（= `wx-cli.biz.json` 内容）
- Create: `scratch-plugin/src/wx/registry-assets/liquidity.json`、`purchase.json`、`xincontract.json`（copy 自 `/Users/yangjingting/develop/wokspace/GitWorkSpace/wx/bin/registry/`）
- Modify: `scratch-plugin/src/wx/registry.ts`

- [ ] **Step 1: 拷贝资源文件**

```bash
mkdir -p /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin/src/wx/registry-assets
cd /Users/yangjingting/develop/ai/deepseek-harness
cp develop/wokspace/GitWorkSpace/wx/bin/wx-cli.biz.json scratch-plugin/src/wx/registry-assets/biz-index.json
cp develop/wokspace/GitWorkSpace/wx/bin/registry/liquidity.json scratch-plugin/src/wx/registry-assets/liquidity.json
cp develop/wokspace/GitWorkSpace/wx/bin/registry/purchase.json scratch-plugin/src/wx/registry-assets/purchase.json
cp develop/wokspace/GitWorkSpace/wx/bin/registry/xincontract.json scratch-plugin/src/wx/registry-assets/xincontract.json
ls -la scratch-plugin/src/wx/registry-assets/
```

- [ ] **Step 2: 写失败测试（registry 默认加载内置资源）**

在 `scratch-plugin/wx-plugin.test.ts` 新增 describe（或新文件 `scratch-plugin/src/wx/registry-assets.test.ts`）：

```ts
import { describe, it, expect } from 'vitest'
import { WxRegistry } from './registry.ts'

describe('registry bundled assets', () => {
  it('loads from bundled assets without wxHome', async () => {
    const reg = await WxRegistry.load()
    const ref = await reg.resolveBiz('purchase.generay')
    expect(ref.system).toBe('purchase')
    expect(ref.bizKey).toBe('generay')
  })
})
```

- [ ] **Step 3: 运行确认失败**

Run: `cd /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin && npx vitest run src/wx/registry-assets.test.ts`
Expected: FAIL —— `WxRegistry.load()` 不接受无参调用（缺 base 参数）。

- [ ] **Step 4: 实现内置加载**

修改 `scratch-plugin/src/wx/registry.ts`。新增文件路径解析 helper 并改造 `load` 签名（base 可选）：

```ts
/** 内置资源根目录（相对本文件） */
const ASSETS_DIR = new URL('./registry-assets/', import.meta.url)

/** Worker/ESM 下读取内置资源文本。 */
async function readAsset(file: string): Promise<string> {
  const url = new URL(file, ASSETS_DIR)
  return readFile(url, 'utf8')
}
```

`WxRegistry.load(base?)`：base 缺省时读 `biz-index.json`（assets 目录），`baseDir` 记录为 assets 目录；`getSystem` 的 `join(this.baseDir, meta.file)` 改为对 assets 目录用 `new URL(meta.file, ASSETS_DIR)` 读取。保留传 base 时的旧行为（外部目录覆盖，供调试）。

- [ ] **Step 5: 运行确认通过**

Run: `cd /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin && npx vitest run src/wx/registry-assets.test.ts`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
cd /Users/yangjingting/develop/ai/deepseek-harness
git add scratch-plugin/src/wx/registry-assets/ scratch-plugin/src/wx/registry.ts scratch-plugin/src/wx/registry-assets.test.ts
git commit -m "feat(scratch-plugin): bundle wx registry assets, optional wxHome override"
```

### Task 1.2: 配置模板 + 环境变量密钥注入

**Files:**
- Create: `scratch-plugin/src/wx/wx-cli.conf.template.json`（3 环境，hmac_key/gateway 留空）
- Modify: `scratch-plugin/src/wx/config.ts`
- Modify: `scratch-plugin/.gitignore`（新增，忽略真实 `wx-cli.conf.json`）

- [ ] **Step 1: 写失败测试（环境变量注入）**

新增 `scratch-plugin/src/wx/config.test.ts`：

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { WxConfig } from './config.ts'

describe('WxConfig env-key injection', () => {
  const saved = new Map<string, string | undefined>()
  afterEach(() => {
    for (const [k, v] of saved) if (v === undefined) delete process.env[k]!; else process.env[k] = v
  })

  it('fills template values from WX_*_HMAC_KEY env vars', async () => {
    saved.set('WX_TEST_HMAC_KEY', process.env.WX_TEST_HMAC_KEY)
    saved.set('WX_TEST_GATEWAY', process.env.WX_TEST_GATEWAY)
    process.env.WX_TEST_HMAC_KEY = 'env-key-123'
    process.env.WX_TEST_GATEWAY = 'http://localhost:9090'
    const cfg = await WxConfig.load()
    const env = cfg.getEnv('test')!
    expect(env.hmac_key).toBe('env-key-123')
    expect(env.gateway).toBe('http://localhost:9090')
  })

  it('throws a Chinese error when no key source exists', async () => {
    saved.set('WX_TEST_HMAC_KEY', process.env.WX_TEST_HMAC_KEY)
    delete process.env.WX_TEST_HMAC_KEY
    // 加载一个所有密钥都留空的模板
    await expect(WxConfig.loadFromString(`{"environments":{"test":{"gateway":"","hmac_key":"","corpid":"","default_corp_iden":""}}}`)).rejects.toThrow(/密钥/)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin && npx vitest run src/wx/config.test.ts`
Expected: FAIL —— 无 `WxConfig.load()` 无参/`loadFromString` 定义。

- [ ] **Step 3: 实现**

改造 `scratch-plugin/src/wx/config.ts`：

```ts
const TEMPLATE_ASSET = new URL('./wx-cli.conf.template.json', import.meta.url)

export class WxConfig {
  readonly environments: Record<string, WxEnv>

  constructor(config: WxCliConfig) {
    this.environments = config.environments
  }

  /** 从模板 + 环境变量构建。base 缺省=内置模板；base 提供=读外部真实文件（保留调试覆盖）。 */
  static async load(base?: string): Promise<WxConfig> {
    if (base) {
      const data = await readFile(join(base, 'wx-cli.conf.json'), 'utf8')
      return WxConfig.fromBase(JSON.parse(data) as WxCliConfig)
    }
    const data = await readFile(TEMPLATE_ASSET, 'utf8')
    return WxConfig.fromBase(JSON.parse(data) as WxCliConfig)
  }

  static async loadFromString(s: string): Promise<WxConfig> {
    return WxConfig.fromBase(JSON.parse(s) as WxCliConfig)
  }

  /** 用 WX_<ENV>_HMAC_KEY / WX_<ENV>_GATEWAY 环境变量填补模板空值。 */
  private static fromBase(cfg: WxCliConfig): WxConfig {
    const envs: Record<string, WxEnv> = {}
    for (const [name, e] of Object.entries(cfg.environments)) {
      const envKey = name.toUpperCase()
      const hmacKey = process.env[`WX_${envKey}_HMAC_KEY`] ?? e.hmac_key
      const gateway = process.env[`WX_${envKey}_GATEWAY`] ?? e.gateway
      if (!hmacKey || !gateway) {
        throw new Error(`环境 ${name} 缺少密钥/网关：请设置 WX_${envKey}_HMAC_KEY、WX_${envKey}_GATEWAY 或提供真实 wx-cli.conf.json`)
      }
      envs[name] = { ...e, hmac_key: hmacKey, gateway }
    }
    return new WxConfig({ environments: envs })
  }
}
```

- [ ] **Step 4: 生成模板文件（密钥留空）**

`scratch-plugin/src/wx/wx-cli.conf.template.json`：

```json
{
  "environments": {
    "test": { "gateway": "", "hmac_key": "", "corpid": "", "default_corp_iden": "" },
    "uat": { "gateway": "", "hmac_key": "", "corpid": "", "default_corp_iden": "" },
    "pro": { "gateway": "", "hmac_key": "", "corpid": "", "default_corp_iden": "" }
  }
}
```

- [ ] **Step 5: .gitignore 防密钥入库**

新建 `scratch-plugin/.gitignore`：

```
wx-cli.conf.json
.env
```

- [ ] **Step 6: 运行确认通过**

Run: `cd /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin && npx vitest run src/wx/config.test.ts src/wx/registry-assets.test.ts`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
cd /Users/yangjingting/develop/ai/deepseek-harness
git add scratch-plugin/src/wx/config.ts scratch-plugin/src/wx/wx-cli.conf.template.json scratch-plugin/src/wx/config.test.ts scratch-plugin/.gitignore
git commit -m "feat(scratch-plugin): env-injected hmac keys, template config, no wxHome required"
```

### Task 1.3: 移除本机会话（session.ts 删除 + readySession 改造）

**Files:**
- Delete: `scratch-plugin/src/wx/session.ts`
- Modify: `scratch-plugin/src/wx/api.ts`
- Modify: `scratch-plugin/src/wx/types.ts`（WxOpContext 加 account 字段，见 Task 2.1，先放在本任务完成结构准备）

- [ ] **Step 1: 写失败测试（无会话文件时的行为）**

在 `wx-plugin.test.ts` 的 plugin 测试里，新增断言：不设 `~/.wx-cli` 会话时，`wx_query_biz` 仍可用（不需登录）；构造一个 account 注入后 `wx_query_todo` 走 mock transport 发出 X-Account。先写一个最小失败测试（api 层）：

新增 `scratch-plugin/src/wx/api.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { wxQueryTodo } from './api.ts'
import { WxConfig } from './config.ts'
import { WxRegistry } from './registry.ts'

describe('api without local session', () => {
  it('uses ctx.account as X-Account via injected transport', async () => {
    const captured: string[] = []
    const ctx = {
      config: await WxConfig.load(),
      registry: await WxRegistry.load(),
      defaultEnv: 'test',
      account: 'user-wecom-42',
      transport: {
        async do(o: { account: string; method: string; path: string; body: string }) {
          captured.push(o.account)
          return { body: JSON.stringify({ data: { page: { data: { data: [], total: 0 } } } }) }
        },
        async getMemberCode() { return 'M1001' },
      },
    }
    await wxQueryTodo(ctx as never, { biz: 'purchase.generay' })
    expect(captured[0]).toBe('user-wecom-42')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin && npx vitest run src/wx/api.test.ts`
Expected: FAIL —— readySession 仍调 loadSession 读磁盘会话，抛「未登录」。

- [ ] **Step 3: 实现**

改造 `scratch-plugin/src/wx/api.ts`：

- 删除 `import { loadSession } from './session.ts'`；
- `WxOpContext`（定义在 types.ts 或 api.ts，移入 types.ts）增加 `account?: string`；
- 新增 `defaultAccount?: string`（本机开发测试账号，来自插件配置）；
- `readySession` 改为：

```ts
async function readySession(ctx: WxOpContext, env: string | undefined): Promise<ReadySession> {
  const envName = env || ctx.defaultEnv || 'test'
  const e = ctx.config.getEnv(envName)
  if (!e) throw new Error(`未知环境 "${envName}"（可用: ${ctx.config.envNames().join(', ')}）`)
  const account = ctx.account ?? ctx.defaultAccount ?? ''
  if (!account) throw new Error('缺少当前用户身份（插件未注入 account，请设置 defaultAccount 或经 wecom-bridge 注入）')
  return { env: envName, gateway: e.gateway, hmacKey: e.hmac_key, account }
}
```

- `ReadySession` 类型去掉 `session` 字段，改存 `account`；
- 删除 `session.ts` 文件；
- `wx-plugin.ts` 的 `apply` 中把 `ctx.plugin` 配置的 `defaultAccount` 传入 backend context：`{ config, registry, defaultEnv, defaultAccount: cfg.defaultAccount }`（Config 增加可选 `defaultAccount`）。

- [ ] **Step 4: 更新现有测试**

`wx-plugin.test.ts` 中 `applyWxPlugin(ctx, { wxHome: WX_HOME, defaultEnv: 'test' })` 改为 `applyWxPlugin(ctx, { defaultEnv: 'test', defaultAccount: 'test-account' })`（不再传 wxHome）；断言「注册四个工具」改为五个（+wx_confirm，Task 3 完成前先不断言 confirm，仅改传参）。`wx_query_biz` 的 execute 无 account 需求（registry 本地），仍应通过。

- [ ] **Step 5: 运行全量测试**

Run: `cd /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin && npx vitest run`
Expected: PASS（此时 config 需真实密钥：用环境变量注入测试用密钥后运行；README 或测试说明补充 `WX_TEST_HMAC_KEY`/`WX_TEST_GATEWAY` 需要设置）。

- [ ] **Step 6: Commit**

```bash
cd /Users/yangjingting/develop/ai/deepseek-harness
git rm scratch-plugin/src/wx/session.ts
git add scratch-plugin/src/wx/api.ts scratch-plugin/src/wx/wx-plugin.ts scratch-plugin/src/wx/api.test.ts scratch-plugin/src/wx/types.ts scratch-plugin/wx-plugin.test.ts
git commit -m "feat(scratch-plugin): account from context, drop local scan session"
```

---

## Chunk 2: 两步确认（pending + wx_confirm 工具）

目标：移植 Go 版 approve/confirm 两步确认，含参数自动推导、按 userID 隔离、5 分钟 TTL、失败回写可重试、同轮 approve+confirm 防护。

### Task 2.1: pending 存储模块

**Files:**
- Create: `scratch-plugin/src/wx/pending.ts`
- Test: `scratch-plugin/src/wx/pending.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { PendingStore } from './pending.ts'

const now = () => 1_700_000_000_000

describe('PendingStore', () => {
  afterEach(() => vi.useRealTimers())

  it('stores and takes by account (user isolation)', () => {
    const p = new PendingStore(5 * 60_000, now)
    const item = { account: 'A', action: 'approve' as const, orderNumber: 'PR1', vars: {}, summary: 's', expireAt: now() + 5 * 60_000 }
    expect(p.get('A')).toBeUndefined()
    p.set(item)
    expect(p.get('A')!.orderNumber).toBe('PR1')
    expect(p.get('B')).toBeUndefined()
    const taken = p.take('A')
    expect(taken).toBeDefined()
    expect(p.take('A')).toBeUndefined() // 取出即删
  })

  it('expires after TTL', () => {
    vi.useFakeTimers()
    vi.setSystemTime(now())
    const p = new PendingStore(5 * 60_000, now)
    p.set({ account: 'A', action: 'approve' as const, orderNumber: 'PR1', vars: {}, summary: 's', expireAt: now() + 5 * 60_000 })
    vi.setSystemTime(now() + 5 * 60_000 + 1)
    expect(p.get('A')).toBeUndefined()
  })

  it('rebids a failed take-back (retryable execution)', () => {
    const p = new PendingStore(5 * 60_000, now)
    const item = { account: 'A', action: 'approve' as const, orderNumber: 'PR1', vars: {}, summary: 's', expireAt: now() + 5 * 60_000 }
    p.set(item)
    const taken = p.take('A')
    expect(taken).toBeDefined()
    p.rebid(taken!) // 执行失败，回写
    expect(p.get('A')).toBeDefined()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin && npx vitest run src/wx/pending.test.ts`
Expected: FAIL —— `PendingStore` 不存在。

- [ ] **Step 3: 实现 pending.ts**

```ts
export interface PendingApprove {
  account: string
  biz: string
  action: 'approve' | 'reject'
  orderNumber: string
  vars: Record<string, string>
  summary: string
  expireAt: number
}

export class PendingStore {
  private items = new Map<string, PendingApprove>()
  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

  set(p: PendingApprove): void { this.items.set(p.account, p) }

  get(account: string): PendingApprove | undefined {
    const p = this.items.get(account)
    if (p && this.now() > p.expireAt) { this.items.delete(account); return undefined }
    return p
  }

  take(account: string): PendingApprove | undefined {
    const p = this.get(account)
    if (p) this.items.delete(account)
    return p
  }

  /** 执行失败后回写，允许用户重试。 */
  rebid(p: PendingApprove): void { this.items.set(p.account, p) }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin && npx vitest run src/wx/pending.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
cd /Users/yangjingting/develop/ai/deepseek-harness
git add scratch-plugin/src/wx/pending.ts scratch-plugin/src/wx/pending.test.ts
git commit -m "feat(scratch-plugin): pending store with user isolation, TTL, rebid"
```

### Task 2.2: 审批参数自动推导（移植 prepareApprove）

**Files:**
- Create: `scratch-plugin/src/wx/prepare.ts`
- Test: `scratch-plugin/src/wx/prepare.test.ts`

- [ ] **Step 1: 失败测试（定位单据 + 推导参数）**

```ts
import { describe, it, expect } from 'vitest'
import { findRecord, deriveApproveParams } from './prepare.ts'
import { WxRegistry } from './registry.ts'

describe('prepare approve', () => {
  it('finds a record by orderNumber from list response', async () => {
    const registry = await WxRegistry.load()
    const ref = await registry.resolveBiz('purchase.generay')
    const listBody = JSON.stringify({ data: { page: { data: { data: [{ orderNumber: 'PR999', applyName: 'x' }], total: 1 } } } })
    const rec = await findRecord(ref, 'PR999', async () => ({ body: listBody }))
    expect(rec).toBeDefined()
    expect(rec!.orderNumber).toBe('PR999')
  })

  it('derives orderNumber/account/remarks from op placeholder spec', async () => {
    const registry = await WxRegistry.load()
    const ref = await registry.resolveBiz('purchase.generay')
    const vars = deriveApproveParams(ref, { orderNumber: 'PR999', account: 'u1', remarks: 'ok' }, 'approve', 'u1', {
      orderNumber: 'PR999', applyName: 'x', applyNo: 'PR999',
    })
    expect(vars.account).toBe('u1')
    expect(vars.orderNumber).toBe('PR999')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin && npx vitest run src/wx/prepare.test.ts`
Expected: FAIL —— `prepare.ts` 不存在。

- [ ] **Step 3: 实现 prepare.ts**

移植 Go 版 `approve.go` 的 `findRecord` + `PrepareApprove` 参数推导：解析列表响应（含 `extractRecords` 的 path/listField 逻辑）→ 按单号二次过滤 → 遍历 approve/reject op 的 requestBody 占位符，映射 account/orderNumber/action/auditContent/remarks/memberCode/id/handleTaskId/applyTaskId/applyTypeDetail/memberType 等；需要详情的业务调 detail op 补字段。摘要拼装参照 `buildApproveSummary`。

- [ ] **Step 4: 运行确认通过**

Run: `cd /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin && npx vitest run src/wx/prepare.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
cd /Users/yangjingting/develop/ai/deepseek-harness
git add scratch-plugin/src/wx/prepare.ts scratch-plugin/src/wx/prepare.test.ts
git commit -m "feat(scratch-plugin): port prepareApprove param derivation from Go agent"
```

### Task 2.3: wx_approve 改造 + wx_confirm 注册

**Files:**
- Modify: `scratch-plugin/src/wx/api.ts`（新增 wxPrepareApprove / wxConfirmApprove / wxCancelApprove）
- Modify: `scratch-plugin/src/wx-plugin.ts`（注册 wx_confirm；wx_approve 改为两阶段）
- Modify: `scratch-plugin/wx-plugin.test.ts`

- [ ] **Step 1: 失败测试（approve 不执行写操作，confirm 才执行）**

新增 `scratch-plugin/src/wx/steps.test.ts`（或扩展 api.test.ts）：

```ts
import { describe, it, expect } from 'vitest'
import { PendingStore } from './pending.ts'

describe('two-step approval flow', () => {
  it('approve stores pending and never calls transport; confirm executes once', async () => {
    const calls: string[] = []
    const pending = new PendingStore(5 * 60_000)
    // 构造 ctx：transport.do 记录调用并返回成功体
    let ctx: any
    // 1) 调用 wxPrepareApprove -> 只存 pending、不调 transport.do
    await wxPrepareApprove(ctx, { biz: 'purchase.generay', orderNumber: 'PR999', action: 'approve' })
    expect(calls.length).toBe(0)
    expect(pending.get('u1')).toBeDefined()
    // 2) 调用 wxConfirmApprove(decision=confirm) -> 调 transport.do 一次
    await wxConfirmApprove(ctx, { decision: 'confirm' })
    expect(calls.length).toBe(1)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin && npx vitest run src/wx/steps.test.ts`
Expected: FAIL —— 函数未定义。

- [ ] **Step 3: 实现 api 层两阶段函数**

`api.ts`：

```ts
export async function wxPrepareApprove(
  ctx: WxOpContext, opts: { biz: string; orderNumber: string; action: 'approve' | 'reject'; remarks?: string; environment?: string },
): Promise<string> {
  const ready = await readySession(ctx, opts.environment)
  const ref = await ctx.registry.resolveBiz(opts.biz)
  const p = await prepareApprove(ready, ctx, ref, opts)  // 定位+推导+摘要（不调写接口）
  ctx.pending.set({ ...p, account: ready.account, expireAt: now() + 5 * 60_000 })
  return p.summary  // 摘要文本，含“回复「确认」执行”
}

export async function wxConfirmApprove(
  ctx: WxOpContext, opts: { decision: 'confirm' | 'cancel'; environment?: string },
): Promise<string> {
  const ready = await readySession(ctx, opts.environment)
  const p = ctx.pending.take(ready.account)
  if (!p) return '没有待确认的审批（可能已过期或已处理，请重新发起）'
  if (opts.decision !== 'confirm') return '已取消审批操作。'
  try {
    return await executeApprove(ready, ctx, p)  // 调写接口
  } catch (e) {
    ctx.pending.rebid(p)  // 失败回写可重试
    throw e
  }
}
```

`wx-plugin.ts`：注册 `wx_confirm`（参数 decision: confirm/cancel）；wx_approve 改为调 `wxPrepareApprove`（不执行写操作）；backend 上下文带 `pending` 实例（每插件实例一个 PendingStore）。

- [ ] **Step 4: 同轮防护**

`wx-plugin.ts` 的 wx_confirm execute 里记录最近一次 approve 的 callId：若同一轮（同一 agent turn）内 approve 与 confirm 同时出现，拒绝 confirm（返回「确认操作必须在用户下一条消息中单独进行」）。实现方式：agent 会话内维护 `lastApproveCallId`，approve 成功时记录当前 turn 标识；confirm 检查 turn 标识与之相同则拒绝。测试断言同轮拒绝、下轮放行。

- [ ] **Step 5: 运行全量测试**

Run: `cd /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin && npx vitest run`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
cd /Users/yangjingting/develop/ai/deepseek-harness
git add scratch-plugin/src/wx/api.ts scratch-plugin/src/wx-plugin.ts scratch-plugin/src/wx/steps.test.ts scratch-plugin/wx-plugin.test.ts
git commit -m "feat(scratch-plugin): two-step approve/confirm with same-turn guard"
```

### Task 2.4: 审计日志

**Files:**
- Create: `scratch-plugin/src/wx/audit.ts`
- Modify: `scratch-plugin/src/wx-plugin.ts`（可选配置 auditPath）

- [ ] **Step 1: 失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { Auditor } from './audit.ts'

describe('Auditor', () => {
  it('appends JSONL lines with account, action and outcome', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audit-'))
    const a = new Auditor(join(dir, 'audit.jsonl'))
    await a.record({ account: 'u1', biz: 'purchase.generay', orderNumber: 'PR1', action: 'approve', outcome: 'success', at: '2026-01-01T00:00:00Z' })
    const text = await readFile(join(dir, 'audit.jsonl'), 'utf8')
    expect(text).toContain('"account":"u1"')
    expect(text).toContain('"action":"approve"')
  })
})
```

- [ ] **Step 2: 运行确认失败 → Step 3: 实现（append-only JSONL 写入，目录自动创建，写入失败仅告警不阻断） → Step 4: 通过**

- [ ] **Step 5: Commit**

```bash
cd /Users/yangjingting/develop/ai/deepseek-harness
git add scratch-plugin/src/wx/audit.ts scratch-plugin/src/wx/audit.test.ts scratch-plugin/src/wx-plugin.ts
git commit -m "feat(scratch-plugin): jsonl approval audit log"
```

---

## Chunk 3: wecom-bridge 插件（WS 长连接 + 消息路由）

目标：企微智能机器人 WS 长连接接入。Node 22 原生 WebSocket 实现，移植 Go 版协议（longconn.go / wsclient.go）。支持断线重连（3s）、30s 心跳、订阅 errcode 校验。收到消息→创建/复用 userID 对应的 agent 会话→发 prompt→收回复→回企微。

### Task 3.1: WS 协议层

**Files:**
- Create: `scratch-plugin/src/wecom-bridge/ws-protocol.ts`
- Create: `scratch-plugin/src/wecom-bridge/ws-protocol.test.ts`

- [ ] **Step 1: 失败测试（帧编解码 + 订阅请求 + 消息回调解析）**

```ts
import { describe, it, expect } from 'vitest'
import { buildSubscribeFrame, parseIncoming, buildStreamReply } from './ws-protocol.ts'

describe('ws protocol', () => {
  it('builds a subscribe frame with bot_id and secret', () => {
    const f = buildSubscribeFrame('bot-1', 'sec')
    const parsed = JSON.parse(f)
    expect(parsed.cmd).toBe('aibot_subscribe')
    expect(parsed.body.bot_id).toBe('bot-1')
    expect(parsed.headers.req_id).toBeTruthy()
  })

  it('parses a msg callback into user id and text with @prefix stripped', () => {
    const raw = JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: 'r1' }, body: { msgid: 'm1', aibotid: 'a', chatid: 'c', chattype: 'group', from: { userid: 'u42' }, msgtype: 'text', text: { content: '@bot 查一下待办' } } })
    const msg = parseIncoming(raw)
    expect(msg.userID).toBe('u42')
    expect(msg.text).toBe('查一下待办')
  })

  it('builds a stream reply frame', () => {
    const f = buildStreamReply('r1', 'reply text')
    const parsed = JSON.parse(f)
    expect(parsed.cmd).toBe('aibot_respond_msg')
    expect(parsed.body.msgtype).toBe('stream')
    expect(parsed.body.stream.finish).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败 → Step 3: 实现（移植 longconn.go 帧格式/trimAtPrefix）→ Step 4: 通过**

- [ ] **Step 5: Commit**

```bash
cd /Users/yangjingting/develop/ai/deepseek-harness
git add scratch-plugin/src/wecom-bridge/ws-protocol.ts scratch-plugin/src/wecom-bridge/ws-protocol.test.ts
git commit -m "feat(scratch-plugin): wecom ws protocol frames (subscribe/callback/reply)"
```

### Task 3.2: 连接管理器（心跳/重连）

**Files:**
- Create: `scratch-plugin/src/wecom-bridge/connection.ts`
- Create: `scratch-plugin/src/wecom-bridge/connection.test.ts`

- [ ] **Step 1: 失败测试（用假 WebSocket 工厂注入验证订阅成功、断线后 3s 重连）**

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ConnectionManager } from './connection.ts'

describe('ConnectionManager', () => {
  afterEach(() => vi.useRealTimers())

  it('subscribes then dispatches callbacks; reconnects after disconnect', async () => {
    vi.useFakeTimers()
    const sent: string[] = []
    const events: any[] = []
    // 假 ws：onmessage 模拟订阅 ack + msg 回调
    const conn = new ConnectionManager({
      wsURL: 'ws://fake', botID: 'b1', secret: 's1',
      wsFactory: () => ({
        send: (d: string) => sent.push(d),
        close: () => {},
        addEventListener: (ev: string, cb: any) => events.push([ev, cb]),
      }) as any,
      onMessage: async (m: any) => m.text,
    })
    conn.start()
    // 触发订阅 ack（errcode 0）
    const subFrame = sent[0]
    for (const [ev, cb] of events) if (ev === 'message') cb({ data: JSON.stringify({ errcode: 0, errmsg: 'ok', headers: { req_id: '' } }) })
    // 触发消息回调
    for (const [ev, cb] of events) if (ev === 'message') cb({ data: JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: 'r' }, body: { from: { userid: 'u1' }, msgtype: 'text', text: { content: 'hi' } } }) })
    expect(sent.some((s) => s.includes('aibot_respond_msg'))).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败 → Step 3: 实现（ConnectionManager：connect→subscribe→readAck→心跳 ping 30s→消息 dispatch；断线 3s 重连；Stop 关闭）→ Step 4: 通过**

- [ ] **Step 5: Commit**

```bash
cd /Users/yangjingting/develop/ai/deepseek-harness
git add scratch-plugin/src/wecom-bridge/connection.ts scratch-plugin/src/wecom-bridge/connection.test.ts
git commit -m "feat(scratch-plugin): wecom ws connection manager with heartbeat and reconnect"
```

### Task 3.3: 消息→agent 会话路由接口

**Files:**
- Create: `scratch-plugin/src/wecom-bridge/session-router.ts`
- Modify: `scratch-plugin/src/wecom-bridge/connection.ts`（注入 router）
- Create: `scratch-plugin/src/wecom-bridge/bridge-plugin.ts`（插件入口，注册到 ctx）

说明：DSH 的 `ctx.agents` 服务提供 agent 会话管理（见 `packages/core/agent/` README 与 `examples/acp-agent/cordis.yml` 中 agent-spine 的组成）。本任务定义 `AgentSessionProvider` 接口并实现基于 `ctx.agents` 的默认路由：

```ts
export interface AgentSessionProvider {
  /** 取或建 userID 对应的 agent 会话，发送 prompt 并返回最终文本。 */
  prompt(userID: string, text: string, signal?: AbortSignal): Promise<string>
}
```

默认实现（bridge-plugin.ts 内）：
- userID → `ctx.agents` 按 userID 建/取会话（1:1 映射）；
- 发送文本 prompt，收集 committed assistant 文本返回；
- 同一 userID 的消息串行（per-user 队列 promise 链）。

- [ ] **Step 1: 失败测试（mock provider 断言 userID 隔离与串行）**

```ts
import { describe, it, expect } from 'vitest'
import { Router } from './session-router.ts'

describe('Router', () => {
  it('routes by userID and serializes per user', async () => {
    const order: string[] = []
    const provider = {
      async prompt(user: string, text: string) {
        order.push(`${user}:${text}`)
        await new Promise((r) => setTimeout(r, 10))
        return `reply-${user}`
      },
    }
    const r = new Router(provider as any)
    const a = r.handle('u1', 'm1')
    const b = r.handle('u1', 'm2')
    const c = r.handle('u2', 'm3')
    const [ra, rb, rc] = await Promise.all([a, b, c])
    expect(ra).toBe('reply-u1')
    expect(rb).toBe('reply-u1')
    expect(rc).toBe('reply-u2')
    expect(order).toEqual(['u1:m1', 'u1:m2', 'u2:m3'])  // u1 串行，u2 并行
  })
})
```

- [ ] **Step 2: 运行确认失败 → Step 3: 实现 Router（per-user promise 链）→ Step 4: 通过**

- [ ] **Step 5: Commit**

```bash
cd /Users/yangjingting/develop/ai/deepseek-harness
git add scratch-plugin/src/wecom-bridge/session-router.ts scratch-plugin/src/wecom-bridge/session-router.test.ts
git commit -m "feat(scratch-plugin): per-user serialized message router"
```

### Task 3.4: bridge 插件入口 + 能力接线

**Files:**
- Create: `scratch-plugin/src/wecom-bridge/bridge-plugin.ts`
- Create: `scratch-plugin/src/wecom-bridge/bridge-plugin.test.ts`（加载 smoke：注册 bridge 插件不抛错）
- Modify: `scratch-plugin/src/wx-plugin.ts`（向 bridge 暴露 account 注入接口或经 ctx 服务传递 userID）

- [ ] **Step 1: 失败测试（加载 smoke）**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply as applyBridge } from './bridge-plugin.ts'

describe('bridge plugin registration', () => {
  let ctx: Context
  beforeAll(() => { ctx = new Context() })
  afterAll(async () => { await ctx.dispose() })

  it('registers without throwing and exposes conn manager config', () => {
    expect(() => applyBridge(ctx, { wsURL: 'wss://fake', botID: 'b', secret: 's', agentProvider: 'ctx' })).not.toThrow()
  })
})
```

- [ ] **Step 2: 运行确认失败 → Step 3: 实现 bridge-plugin.ts**

```ts
export interface BridgeConfig {
  wsURL?: string
  botID: string
  secret: string
  /** agent 会话提供者：'ctx' 使用 ctx.agents；测试可注入 mock */
  agentProvider?: 'ctx'
}

export function apply(ctx: Context, cfg: BridgeConfig) {
  const provider: AgentSessionProvider = {
    async prompt(userID, text, signal) {
      // 经 ctx.agents 取/建 userID 会话，发 prompt 收集回复
      // 实现细节按 dsh-agent 的 agents 服务 API（session 创建 + prompt + await idle）
    },
  }
  const router = new Router(provider)
  const conn = new ConnectionManager({
    wsURL: cfg.wsURL ?? DefaultWSURL,
    botID: cfg.botID,
    secret: cfg.secret,
    onMessage: async (m) => router.handle(m.userID, m.text),
  })
  conn.start()
  ctx.on('dispose', () => conn.stop())
}
```

- [ ] **Step 4: 使工具执行上下文携带 userID**

改造 `wx-plugin.ts`：agent 会话与工具执行经 `exec` 传递 userID → `WxOpContext.account`。具体：参考 `packages/core/agent/` 的工具执行上下文机制（`ToolRunContext`），在会话内注入 `account`（agent 的会话变量或 prompt 上下文），使 wx 工具能拿到当前企微 userID。需要阅读 `packages/core/tools/` 或 `packages/core/agent/` 的 exec 上下文结构确认注入点（实现时按实际 API 调整）。

- [ ] **Step 5: 运行确认通过 + Commit**

```bash
cd /Users/yangjingting/develop/ai/deepseek-harness
git add scratch-plugin/src/wecom-bridge/ scratch-plugin/src/wx-plugin.ts
git commit -m "feat(scratch-plugin): wecom bridge plugin wiring messages into agent sessions"
```

---

## Chunk 4: 能力边界组合配置 + 部署交付

目标：产出服务器部署目录（自包含、systemd 可托管）、只暴露审批能力的 cordis.yml，以及打包脚本；不挂 bash/fs/web/subagent 等无关能力。

### Task 4.1: 部署组合配置（能力收敛）

**Files:**
- Create: `scratch-plugin/deploy/cordis.yml`
- Create: `scratch-plugin/deploy/README.md`

- [ ] **Step 1: 写部署组合配置**

`scratch-plugin/deploy/cordis.yml` 参考 `examples/headless-agent/cordis.yml` 的最小集（agent-spine + LLM + persistence + guard），**不挂** bash/fs/web/subagent/workflow/goal/ralph/todo；新增两个插件：

```yaml
- id: wecom-bridge
  name: '/path/to/scratch-plugin/src/wecom-bridge/bridge-plugin.ts'
  config:
    botID: ${WX_BOT_ID}
    secret: ${WX_BOT_SECRET}
- id: wx-agent
  name: '/path/to/scratch-plugin/src/wx-plugin.ts'
  config:
    defaultEnv: 'test'
    defaultAccount: ${WX_DEFAULT_ACCOUNT:''}
    auditPath: '/opt/wx-dsh-agent/data/audit.jsonl'
```

agent-spine 的 persona 固定为审批助手：只处理待办查询、详情、审批通过/驳回；无关请求礼貌拒绝。（占位路径在打包脚本里替换为实际部署路径。）

- [ ] **Step 2: 写部署 README（环境变量清单、启动方式、systemd 示例）**

- [ ] **Step 3: Commit**

```bash
cd /Users/yangjingting/develop/ai/deepseek-harness
git add scratch-plugin/deploy/
git commit -m "feat(scratch-plugin): deploy composition with approval-only tool surface"
```

### Task 4.2: 打包脚本 + systemd 单元

**Files:**
- Create: `scratch-plugin/deploy/build-wx-dsh-agent.sh`
- Create: `scratch-plugin/deploy/wx-dsh-agent.service`

- [ ] **Step 1: 实现 build 脚本（参照 bin/build-wx-agent.sh 风格）**

阶段：1) 用 `npx tsx` 预编译或直接打包源码+依赖（scratch-plugin 无第三方运行时依赖，除 DSH 包——部署机需安装 deepseek-harness 或打包 node_modules）；2) 拷贝配置模板与 cordis.yml 并把相对路径替换为部署目录绝对路径；3) 生成 `.env.example`；4) 输出部署目录结构。

- [ ] **Step 2: 实现 systemd 单元**

`wx-dsh-agent.service`：`Restart=always`、`RestartSec=3`、`WorkingDirectory=/opt/wx-dsh-agent`、`EnvironmentFile=/opt/wx-dsh-agent/.env`、`ExecStart` 指向启动命令、journald 日志。

- [ ] **Step 3: 部署冒烟测试（可离线）**

写 `scratch-plugin/deploy/smoke.sh`：在临时目录跑 build 脚本 → 检查产物文件齐全 → 用 mock 环境变量启动进程 → 断言进程存活 → 优雅 SIGTERM 退出码 0 → 清理。（WS 连接用假地址，进程应重连循环不崩溃。）

- [ ] **Step 4: Commit**

```bash
cd /Users/yangjingting/develop/ai/deepseek-harness
git add scratch-plugin/deploy/
git commit -m "feat(scratch-plugin): self-contained deploy bundle with systemd unit and smoke test"
```

### Task 4.3: 端到端快照测试（对话场景）

**Files:**
- Create: `scratch-plugin/e2e/approval-dialog.snapshot.md`（或按 DSH snapshot 机制）

- [ ] **Step 1: 录制关键对话快照（mock transport + mock ws 回调）**

场景：查待办 → 审批通过 PRxxx → 回复确认 → 执行成功。断言工具调用序列与最终文本。（对齐 DSH 测试策略的 snapshot 层；如仓库 snapshot 工具不适用，则用 vitest 集成测试断言完整对话输出文本。）

- [ ] **Step 2: Commit**

```bash
cd /Users/yangjingting/develop/ai/deepseek-harness
git add scratch-plugin/e2e/
git commit -m "test(scratch-plugin): approval dialog end-to-end snapshot"
```

---

## 验证清单（全部完成前不允许声称完成）

- [ ] `cd /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin && npx vitest run` 全绿；
- [ ] `npx tsc -p scratch-plugin/tsconfig.json --noEmit` 无类型错误（用 `cd scratch-plugin && npx tsc -p .`，tsconfig 无 emit）；
- [ ] 全仓库 grep 无 `wxHome` 残留必需引用（调试覆盖参数以 `wxHome?` 可选形式保留可接受）；
- [ ] `deploy/smoke.sh` 在干净临时目录通过；
- [ ] 无真实密钥提交（git log 检查 `wx-cli.conf.json` 未入库）；
- [ ] 部署 cordis.yml 无绝对路径（打包脚本注入部署路径除外）；
- [ ] 设计文档与计划文档均已提交 git。

## 实施顺序建议

Chunk 1 → Chunk 2 → Chunk 3 → Chunk 4。每 Chunk 结束跑一次全量 vitest；Chunk 3 的 Task 3.4 需要先阅读 DSH agent 会话 API（`packages/core/agent/` README + `examples/acp-agent/cordis.yml`），如接口与计划假设不符，按实际 API 调整实现并更新本计划。