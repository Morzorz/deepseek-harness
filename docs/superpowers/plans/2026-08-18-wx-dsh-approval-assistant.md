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

- [ ] **Step 1: 拷贝资源文件（保留 registry/ 子目录，与 `wx-cli.biz.json` 的 `file` 字段一致）**

`wx-cli.biz.json` 的索引条目是 `"file": "registry/purchase.json"`（带 `registry/` 前缀），所以内置资产必须保持同样的子目录结构，否则 `getSystem` 按 `meta.file` 解析会 ENOENT：

```bash
mkdir -p /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin/src/wx/registry-assets/registry
cd /Users/yangjingting/develop/ai/deepseek-harness
cp develop/wokspace/GitWorkSpace/wx/bin/wx-cli.biz.json scratch-plugin/src/wx/registry-assets/biz-index.json
cp develop/wokspace/GitWorkSpace/wx/bin/registry/liquidity.json scratch-plugin/src/wx/registry-assets/registry/liquidity.json
cp develop/wokspace/GitWorkSpace/wx/bin/registry/purchase.json scratch-plugin/src/wx/registry-assets/registry/purchase.json
cp develop/wokspace/GitWorkSpace/wx/bin/registry/xincontract.json scratch-plugin/src/wx/registry-assets/registry/xincontract.json
find scratch-plugin/src/wx/registry-assets -type f | sort
```

- [ ] **Step 2: 写失败测试（registry 默认加载内置资源）**

新文件 `scratch-plugin/src/wx/registry-assets.test.ts`：

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

  it('resolves liquidity and xincontract from bundled assets', async () => {
    const reg = await WxRegistry.load()
    await expect(reg.resolveBiz('liquidity.flm')).resolves.toBeTruthy()
    await expect(reg.resolveBiz('xincontract.xincontract')).resolves.toBeTruthy()
  })

  it('keeps external wxHome override working for debug', async () => {
    const reg = await WxRegistry.load(process.env.WX_HOME ?? '/Users/yangjingting/develop/wokspace/GitWorkSpace/wx/bin')
    const ref = await reg.resolveBiz('purchase')
    expect(ref.system).toBe('purchase')
  })
})
```

- [ ] **Step 3: 运行确认失败**

Run: `cd /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin && npx vitest run src/wx/registry-assets.test.ts`
Expected: FAIL —— `WxRegistry.load()` 不接受无参调用（缺 base 参数，TypeError）。

- [ ] **Step 4: 实现内置加载**

修改 `scratch-plugin/src/wx/registry.ts`。

实现要点：
- `WxRegistry.load(base?)`：base 省略时读 `biz-index.json`（`registry-assets/` 目录），`baseDir` 记为 assets 目录；base 提供时保持旧行为（读外部 `wx-cli.biz.json`，供调试）。
- `getSystem` 的内置分支：`meta.file` 是 `registry/<system>.json`，直接用 `new URL(meta.file, ASSETS_DIR)` 能正确落到 `registry-assets/registry/<system>.json`（因为 ASSETS_DIR 本身以 `/` 结尾，`new URL('registry/purchase.json', 'file:///.../registry-assets/')` = `file:///.../registry-assets/registry/purchase.json`）——子目录结构与 meta.file 天然一致，无需剥前缀。
- 内置分支不经 `join(this.baseDir, meta.file)`（那是文件系统路径拼接），改用 URL 读取：

```ts
/** 内置资源根目录（相对本文件，尾斜杠） */
const ASSETS_DIR = new URL('./registry-assets/', import.meta.url)

/** 读取内置资产（biz-index.json 或 registry/<system>.json）。 */
function readAssetUrl(url: URL): Promise<string> {
  return readFile(url, 'utf8')
}
```

`load(base?)` 与 `getSystem(name)` 的改造要点：
- `load()` 无参分支：`readFile(new URL('biz-index.json', ASSETS_DIR))` 解析索引，`baseDir` 设为 `ASSETS_DIR.toString()`；
- `getSystem` 先判断 `this.baseDir` 是否以 `file://` 开头（内置模式）：是则 `readFile(new URL(meta.file, ASSETS_DIR))`，否则保持 `join(this.baseDir, meta.file)`（外部调试模式）；
- 增加 `isBundled()` 内部标志替代字符串判断（更清晰）。

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

  it('resolves missing keys lazily per environment (uat/pro not loaded when unused)', async () => {
    const cfg = await WxConfig.load()
    // 未设 uat/pro 的密钥也应能加载成功（惰性校验）
    expect(cfg.getEnv('uat')).toBeDefined()
  })

  it('getReadyEnv throws a Chinese error when the used env lacks keys', async () => {
    saved.set('WX_TEST_HMAC_KEY', process.env.WX_TEST_HMAC_KEY)
    saved.set('WX_TEST_GATEWAY', process.env.WX_TEST_GATEWAY)
    delete process.env.WX_TEST_HMAC_KEY
    delete process.env.WX_TEST_GATEWAY
    const cfg = await WxConfig.load()
    await expect(cfg.getReadyEnv('test')).rejects.toThrow(/密钥/)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin && npx vitest run src/wx/config.test.ts`
Expected: FAIL —— 无 `WxConfig.load()` 无参/`getReadyEnv` 定义。

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
    const data = base
      ? await readFile(join(base, 'wx-cli.conf.json'), 'utf8')
      : await readFile(TEMPLATE_ASSET, 'utf8')
    const cfg = JSON.parse(data) as WxCliConfig
    if (!cfg.environments || Object.keys(cfg.environments).length === 0) {
      throw new Error('wx-cli.conf.json 未定义任何环境')
    }
    return new WxConfig(cfg)
  }

  /** 环境名与真实密钥/网关是否齐备（按需校验，部署时只配用到的环境即可）。 */
  async getReadyEnv(name: string): Promise<WxEnv> {
    const e = this.environments[name]
    if (!e) throw new Error(`未知环境 "${name}"（可用: ${this.envNames().join(', ')}）`)
    const envKey = name.toUpperCase()
    const hmacKey = process.env[`WX_${envKey}_HMAC_KEY`] ?? e.hmac_key
    const gateway = process.env[`WX_${envKey}_GATEWAY`] ?? e.gateway
    if (!hmacKey || !gateway) {
      throw new Error(
        `环境 ${name} 缺少密钥/网关：请设置 WX_${envKey}_HMAC_KEY、WX_${envKey}_GATEWAY 或提供真实 wx-cli.conf.json`,
      )
    }
    return { ...e, hmac_key: hmacKey, gateway }
  }
}
```

设计说明（替代评审前版本的「加载时校验全部环境」）：模板含 test/uat/pro 三个环境且都留空，若在 `load()` 时统一校验会造成「只用 test 也要配 uat/pro 密钥」的负担。改为 `getReadyEnv(name)` 按需校验——部署时只配运行环境（服务器 .env 只设 `WX_PRO_HMAC_KEY`/`WX_PRO_GATEWAY`），本机测试只设 test。环境变量优先于文件值（`??` 语义），与 spec §4.2 意图一致。

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

新增 `scratch-plugin/src/wx/api.test.ts`。注意：`WxConfig.load()` 已改为惰性校验（Task 1.2），但 `readySession` 会调 `getReadyEnv`，所以测试必须设好 `WX_TEST_HMAC_KEY`/`WX_TEST_GATEWAY`（否则初始失败是配置错误而不是「未登录」）：

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { wxQueryTodo } from './api.ts'
import { WxConfig } from './config.ts'
import { WxRegistry } from './registry.ts'

describe('api without local session', () => {
  const saved = new Map<string, string | undefined>()
  afterEach(() => {
    for (const [k, v] of saved) if (v === undefined) delete process.env[k]!; else process.env[k] = v
  })

  it('uses ctx.account as X-Account via injected transport', async () => {
    saved.set('WX_TEST_HMAC_KEY', process.env.WX_TEST_HMAC_KEY)
    saved.set('WX_TEST_GATEWAY', process.env.WX_TEST_GATEWAY)
    process.env.WX_TEST_HMAC_KEY = 'test-key'
    process.env.WX_TEST_GATEWAY = 'http://localhost:9090'
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

  it('uses defaultAccount when ctx.account is absent (dev mode)', async () => {
    saved.set('WX_TEST_HMAC_KEY', process.env.WX_TEST_HMAC_KEY)
    saved.set('WX_TEST_GATEWAY', process.env.WX_TEST_GATEWAY)
    process.env.WX_TEST_HMAC_KEY = 'test-key'
    process.env.WX_TEST_GATEWAY = 'http://localhost:9090'
    const captured: string[] = []
    const ctx = {
      config: await WxConfig.load(),
      registry: await WxRegistry.load(),
      defaultEnv: 'test',
      defaultAccount: 'dev-account',
      transport: {
        async do(o: { account: string; method: string; path: string; body: string }) {
          captured.push(o.account)
          return { body: JSON.stringify({ data: { page: { data: { data: [], total: 0 } } } }) }
        },
        async getMemberCode() { return 'M1001' },
      },
    }
    await wxQueryTodo(ctx as never, { biz: 'purchase.generay' })
    expect(captured[0]).toBe('dev-account')
  })

  it('throws a Chinese error when no account source exists', async () => {
    saved.set('WX_TEST_HMAC_KEY', process.env.WX_TEST_HMAC_KEY)
    saved.set('WX_TEST_GATEWAY', process.env.WX_TEST_GATEWAY)
    process.env.WX_TEST_HMAC_KEY = 'test-key'
    process.env.WX_TEST_GATEWAY = 'http://localhost:9090'
    const ctx = {
      config: await WxConfig.load(),
      registry: await WxRegistry.load(),
      defaultEnv: 'test',
      transport: { async do() { return { body: '{}' } }, async getMemberCode() { return 'M' } },
    }
    await expect(wxQueryTodo(ctx as never, { biz: 'purchase.generay' })).rejects.toThrow(/缺少当前用户身份/)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin && npx vitest run src/wx/api.test.ts`
Expected: FAIL —— `WxOpContext` 尚无 `account`/`defaultAccount` 字段，`readySession` 仍调 `loadSession` 读磁盘会话（若磁盘恰好有 test 会话会误通过；若无会话抛「未登录」）。两种失败都算符合预期（说明尚未改造），Step 5 通过代表改造完成。

- [ ] **Step 3: 实现**

改造 `scratch-plugin/src/wx/api.ts`：

- 删除 `import { loadSession } from './session.ts'` 与 `import type { WxSession }`（不再使用）；
- 把 `WxOpContext` 定义移入 `types.ts`，增加 `account?: string` 与 `defaultAccount?: string`；
- `readySession` 改为调用 `ctx.config.getReadyEnv(envName)`（惰性校验密钥）并从上下文取 account：

```ts
async function readySession(ctx: WxOpContext, env: string | undefined): Promise<ReadySession> {
  const envName = env || ctx.defaultEnv || 'test'
  const e = await ctx.config.getReadyEnv(envName)
  const account = ctx.account ?? ctx.defaultAccount ?? ''
  if (!account) throw new Error('缺少当前用户身份（插件未注入 account，请设置 defaultAccount 或经 wecom-bridge 注入）')
  return { env: envName, gateway: e.gateway, hmacKey: e.hmac_key, account }
}
```

- `ReadySession` 类型去掉 `session` 字段，改存 `account`；
- **`callOp`（原本 `ready.session.account`）改为 `const account = ready.account`**（此点不列明则编译失败）；
- 删除 `session.ts` 文件；
- `wx-plugin.ts` 改造（见 Step 4）。

- [ ] **Step 4: 更新 wx-plugin.ts 与现有测试**

`wx-plugin.ts`：
- `Config` 接口与 schema：`wxHome` 改为可选（`wxHome?: string` + `z.string().optional()`），新增可选 `defaultAccount?: string`；
- `apply()` 的 backend 加载改为：`wxHome` 提供时 `WxConfig.load(cfg.wxHome)` / `WxRegistry.load(cfg.wxHome)`，否则无参 `WxConfig.load()` / `WxRegistry.load()`；
- backend 上下文补充 `defaultAccount: cfg.defaultAccount`；
- `Promise.all` 加载仍保持（配置+注册表并发读）。

`wx-plugin.test.ts`：
- `applyWxPlugin(ctx, { wxHome: WX_HOME, defaultEnv: 'test' })` 改为 `applyWxPlugin(ctx, { defaultEnv: 'test', defaultAccount: 'test-account' })`（不再传 wxHome）；
- 工具断言**保持四个**（wx_query_biz/todo/detail/approve；wx_confirm 在 Chunk 2 落地后再追加断言）；
- plugin 测试加载时 `WxConfig.getReadyEnv` 才发现密钥缺失（wx_query_biz 不走 readySession），所以 `wx_query_biz` 的 execute 仍应通过——若运行报密钥缺错误，在测试文件顶部用 `beforeAll` 设置 `WX_TEST_HMAC_KEY`/`WX_TEST_GATEWAY` 环境变量。

- [ ] **Step 5: 运行全量测试**

Run: `cd /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin && WX_TEST_HMAC_KEY=test-key WX_TEST_GATEWAY=http://localhost:9090 npx vitest run`
Expected: PASS（api.test.ts、config.test.ts、registry-assets.test.ts、wx-plugin.test.ts 全绿）。

- [ ] **Step 6: Commit**

```bash
cd /Users/yangjingting/develop/ai/deepseek-harness
git rm scratch-plugin/src/wx/session.ts
git add scratch-plugin/src/wx/api.ts scratch-plugin/src/wx/wx-plugin.ts scratch-plugin/src/wx/api.test.ts scratch-plugin/src/wx/types.ts scratch-plugin/wx-plugin.test.ts
git commit -m "feat(scratch-plugin): account from context, drop local scan session"
```

### Task 1.4: client.ts 去会话化文案清理（评审 advisory）

**Files:**
- Modify: `scratch-plugin/src/wx/client.ts`

`wxHttpDo` 里 `if (!account) throw new Error('未登录，请先执行 wx-cli login')` 在会话模型删除后过时（spec §10 将 client.ts 列为改造）。改为说明身份来源缺失：

- [ ] **Step 1: 修改报错文案**

```ts
if (!account) {
  throw new Error('缺少当前用户身份（插件未注入 account，请设置 defaultAccount 或经 wecom-bridge 注入）')
}
```

- [ ] **Step 2: 运行全量测试确认无回归**

Run: `cd /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin && WX_TEST_HMAC_KEY=test-key WX_TEST_GATEWAY=http://localhost:9090 npx vitest run`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
cd /Users/yangjingting/develop/ai/deepseek-harness
git add scratch-plugin/src/wx/client.ts
git commit -m "fix(scratch-plugin): stale unauthenticated error message after session removal"
```

---

## Chunk 2: 两步确认（pending + wx_confirm 工具）

目标：移植 Go 版 approve/confirm 两步确认，含参数自动推导、按 userID 隔离、5 分钟 TTL、失败回写可重试、同轮 approve+confirm 防护。

### Task 2.1: pending 存储模块

**Files:**
- Create: `scratch-plugin/src/wx/pending.ts`
- Test: `scratch-plugin/src/wx/pending.test.ts`

- [ ] **Step 1: 写失败测试**

注意：**时钟必须是可变的**（注入 `now` 闭包读取可变变量），否则 TTL 测试永不触发过期。`PendingApprove` 的 `biz` 字段必填，测试 item 必须带上：

```ts
import { describe, it, expect } from 'vitest'
import { PendingStore, PendingApprove } from './pending.ts'

describe('PendingStore', () => {
  // 可变时钟：测试推进 currentTime 即可模拟时间流逝
  let currentTime = 1_700_000_000_000
  const now = () => currentTime
  let store: PendingStore

  beforeEach(() => {
    currentTime = 1_700_000_000_000
    store = new PendingStore(5 * 60_000, now)
  })

  function item(over: Partial<PendingApprove> = {}): PendingApprove {
    return { account: 'A', biz: 'purchase.generay', action: 'approve', orderNumber: 'PR1', vars: {}, summary: 's', ...over }
  }

  it('stores and takes by account (user isolation)', () => {
    expect(store.get('A')).toBeUndefined()
    store.set(item())
    expect(store.get('A')!.orderNumber).toBe('PR1')
    expect(store.get('B')).toBeUndefined()
    const taken = store.take('A')
    expect(taken).toBeDefined()
    expect(store.take('A')).toBeUndefined() // 取出即删
  })

  it('derives expireAt from ttlMs at set time', () => {
    const p = item() // 不带 expireAt
    store.set(p)
    expect(store.get('A')!.expireAt).toBe(currentTime + 5 * 60_000)
  })

  it('expires after TTL (advancing the mutable clock)', () => {
    store.set(item({ expireAt: now() + 5 * 60_000 }))
    currentTime += 5 * 60_000 + 1
    expect(store.get('A')).toBeUndefined()
  })

  it('rebids a failed take-back (retryable execution)', () => {
    store.set(item())
    const taken = store.take('A')
    expect(taken).toBeDefined()
    store.rebid(taken!) // 执行失败，回写
    expect(store.get('A')).toBeDefined()
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
  /** 过期时间戳；缺省由 set() 按 ttlMs 派生。 */
  expireAt?: number
}

export class PendingStore {
  private items = new Map<string, PendingApprove>()
  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  set(p: PendingApprove): void {
    if (p.expireAt === undefined) p.expireAt = this.now() + this.ttlMs
    this.items.set(p.account, p)
  }

  get(account: string): PendingApprove | undefined {
    const p = this.items.get(account)
    if (p && this.now() > (p.expireAt ?? 0)) { this.items.delete(account); return undefined }
    return p
  }

  take(account: string): PendingApprove | undefined {
    const p = this.get(account)
    if (p) this.items.delete(account)
    return p
  }

  /** 执行失败后回写（保留原有 expireAt，允许用户重试）。 */
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

**钉死的导出签名（实现必须匹配，测试按此调用）：**

```ts
/** 从列表响应中按单号定位记录；fetcher 返回原始响应体字符串。 */
export async function findRecord(
  ref: WxBizRef,
  orderNo: string,
  fetcher: (vars: Record<string, string>) => Promise<{ body: string }>,
): Promise<Record<string, unknown> | undefined>

/** 按 approve/reject op 的 requestBody 占位符推导审批参数（含 needDetail 分支，可传 fetchDetail 拉详情补字段）。 */
export async function approveParams(
  ref: WxBizRef,
  action: 'approve' | 'reject',
  account: string,
  orderNo: string,
  opinion: string,
  fields: Record<string, unknown>,          // findRecord 得到的记录字段
  fetchDetail?: (vars: Record<string, string>) => Promise<Record<string, unknown>>,
): Promise<Record<string, string>>

/** 拼审批确认摘要（参照 Go buildApproveSummary）。 */
export function approveSummary(
  ref: WxBizRef,
  rec: Record<string, unknown>,
  orderNo: string,
  action: 'approve' | 'reject',
  opinion: string,
): string
```

- [ ] **Step 1: 写失败测试（定位单据 + 占位符驱动的参数推导）**

测试必须**由真实 registry op 的 requestBody 占位符驱动**（这样即使推导逻辑残缺，测试也会失败——不能靠传入的 vars 自证）：purchase.generay 的 approve 请求体在 `registry/purchase.json` 中引用 `orderNumber`/`remarks`/`account`/`auditContent`；liquidity.flm 的 approve 引用 `bussNo`/`auditResult`/`auditRemark`：

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { findRecord, approveParams, approveSummary } from './prepare.ts'
import { WxRegistry } from './registry.ts'
import type { WxBizRef } from './types.ts'

describe('prepare approve', () => {
  let registry: WxRegistry

  beforeAll(async () => { registry = await WxRegistry.load() })

  it('finds a record by orderNumber from list response', async () => {
    const ref = await registry.resolveBiz('purchase.generay')
    const listBody = JSON.stringify({ data: { page: { data: { data: [{ orderNumber: 'PR999', applyName: 'x' }], total: 1 } } } })
    const rec = await findRecord(ref, 'PR999', async () => ({ body: listBody }))
    expect(rec).toBeDefined()
    expect((rec! as any).orderNumber).toBe('PR999')
  })

  it('derives generay approve params from the registry op placeholders', async () => {
    const ref = await registry.resolveBiz('purchase.generay')
    const vars = await approveParams(ref, 'approve', 'u1', 'PR999', 'ok', {
      orderNumber: 'PR999', applyName: 'x', applyNo: 'PR999',
    })
    expect(vars.account).toBe('u1')
    expect(vars.orderNumber).toBe('PR999')
    expect(vars.remarks).toBe('ok')
    expect(vars.auditContent).toBeTruthy()
  })

  it('derives flm approve params (bussNo/auditResult) from liquidity op', async () => {
    const ref = await registry.resolveBiz('liquidity.flm')
    const vars = await approveParams(ref, 'approve', 'u2', 'BNO123', '', {
      bussNo: 'BNO123', cnName: '申请人',
    })
    expect(vars.bussNo).toBe('BNO123')
    expect(vars.auditResult).toBe('1')   // approve -> 1；reject 分支应为 '2'
  })

  it('builds an approval summary with order no, name and action', () => {
    const ref: WxBizRef = { system: 'purchase', bizKey: 'generay', biz: { name: '普通采购' }, sys: { name: '采购系统', bizs: {} } }
    const summary = approveSummary(ref, { orderNumber: 'PR999', applyName: '项目X' }, 'PR999', 'approve', '')
    expect(summary).toContain('PR999')
    expect(summary).toContain('审批通过')
    expect(summary).toContain('确认')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin && npx vitest run src/wx/prepare.test.ts`
Expected: FAIL —— `prepare.ts` 不存在。

- [ ] **Step 3: 实现 prepare.ts**

移植 Go 版 `approve.go` 的 `findRecord` + `PrepareApprove`，实现上面钉死的三个导出：

1. `findRecord`：用 `ref.biz.list` 的 requestBody/requestQuery 构造请求（注入 `orderNumber`/`applyNo`/`account`）→ 调 `fetcher`（实际是网关列表请求）→ 按 `op.response` 的 `path`/`listField` 提取记录数组（移植 `extractRecords`）→ 客户端二次过滤（`applyNo`/`orderNumber`/`bussNo`/`businessNo` 匹配 orderNo，防列表接口不消费单号参数时误取首条）。
2. `approveParams`：取 `ref.biz.ops.approve`（action=reject 时取 `reject`）op → 扫描 requestBody 模板中的 `{{key}}` 占位符（移植 `placeholderKeys`）→ 映射：`account`→入参、`orderNumber`/`bussNo`→orderNo、`action`→auditResult 1/2（approve=1、reject=2）、`auditContent`→记录里的 auditContent 或 action 默认词（审批通过/审批驳回）、`remarks`→opinion、`memberCode`→留空（执行时自动获取）、`id`/`handleTaskId`→记录的 handleTaskId、`applyTaskId`→记录的 id、`applyTypeDetail`→记录的 applyTypeDetail(code)、`memberType`/`nodeApprovalType`/`workListId`/`workListMemberId`/`worklistName`→needDetail 分支，若提供了 `fetchDetail` 则调用详情接口补字段。
3. `approveSummary`：拼系统名/单号/名称/申请人/金额/节点 + 意见 + 「回复『确认』执行，回复『取消』放弃」（参照 Go `buildApproveSummary`）。
4. 大整数 ID（≥2^53）以 JSON 字符串保留（对齐 Go 的 `UseNumber` 防精度丢失）。

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
- Modify: `scratch-plugin/src/wx/api.ts`（新增 wxPrepareApprove / wxConfirmApprove）
- Modify: `scratch-plugin/src/wx/pending.ts`（PendingApprove 增加 env 字段）
- Modify: `scratch-plugin/src/wx-plugin.ts`（注册 wx_confirm；wx_approve 改为两阶段；移除 ctx.approval 注入与 askApproval）
- Create: `scratch-plugin/src/wx/steps.test.ts`
- Modify: `scratch-plugin/wx-plugin.test.ts`

- [ ] **Step 1: 写失败测试（approve 不执行写操作，confirm 才执行）**

新增 `scratch-plugin/src/wx/steps.test.ts`。注意：测试先设 `WX_TEST_HMAC_KEY`/`WX_TEST_GATEWAY`（Task 1.2 惰性校验），构造完整 ctx（含 config/registry/account/pending/transport），验证 **approve 阶段零写调用、confirm 阶段恰调一次**、cancel 清理 pending、失败回写可重试:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { wxPrepareApprove, wxConfirmApprove } from './api.ts'
import { WxConfig } from './config.ts'
import { WxRegistry } from './registry.ts'
import { PendingStore } from './pending.ts'

describe('two-step approval flow', () => {
  const saved = new Map<string, string | undefined>()
  let calls: string[] = []
  let ctx: any

  beforeEach(async () => {
    saved.set('WX_TEST_HMAC_KEY', process.env.WX_TEST_HMAC_KEY)
    saved.set('WX_TEST_GATEWAY', process.env.WX_TEST_GATEWAY)
    process.env.WX_TEST_HMAC_KEY = 'test-key'
    process.env.WX_TEST_GATEWAY = 'http://localhost:9090'
    calls = []
    ctx = {
      config: await WxConfig.load(),
      registry: await WxRegistry.load(),
      defaultEnv: 'test',
      account: 'u1',
      pending: new PendingStore(5 * 60_000),
      transport: {
        async do(o: { account: string; path: string; body: string }) {
          calls.push(`${o.path}`)
          return { body: JSON.stringify({ data: { ok: true } }) }
        },
        async getMemberCode() { return 'M1001' },
      },
    }
  })

  afterEach(() => {
    for (const [k, v] of saved) if (v === undefined) delete process.env[k]!; else process.env[k] = v
  })

  it('approve stores pending and never calls the write transport', async () => {
    await wxPrepareApprove(ctx, { biz: 'purchase.generay', orderNumber: 'PR999', action: 'approve' })
    expect(calls.length).toBe(0)              // prepare 阶段零写调用
    expect(ctx.pending.get('u1')).toBeDefined()
  })

  it('confirm executes the write exactly once', async () => {
    await wxPrepareApprove(ctx, { biz: 'purchase.generay', orderNumber: 'PR999', action: 'approve' })
    const out = await wxConfirmApprove(ctx, { decision: 'confirm' })
    expect(calls.length).toBe(1)
    expect(out).toContain('ok')
    expect(ctx.pending.get('u1')).toBeUndefined()   // 取出即删
  })

  it('cancel clears pending without executing', async () => {
    await wxPrepareApprove(ctx, { biz: 'purchase.generay', orderNumber: 'PR999', action: 'approve' })
    const out = await wxConfirmApprove(ctx, { decision: 'cancel' })
    expect(calls.length).toBe(0)
    expect(out).toContain('取消')
    expect(ctx.pending.get('u1')).toBeUndefined()
  })

  it('confirm without pending returns a hint', async () => {
    const out = await wxConfirmApprove(ctx, { decision: 'confirm' })
    expect(out).toContain('没有待确认的审批')
  })

  it('rebids pending when execution fails so the user can retry', async () => {
    const realDo = ctx.transport.do
    ctx.transport.do = async () => { throw new Error('网关 500') }
    await wxPrepareApprove(ctx, { biz: 'purchase.generay', orderNumber: 'PR999', action: 'approve' })
    await expect(wxConfirmApprove(ctx, { decision: 'confirm' })).rejects.toThrow(/500/)
    expect(ctx.pending.get('u1')).toBeDefined()   // 失败回写可重试
    ctx.transport.do = realDo
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin && npx vitest run src/wx/steps.test.ts`
Expected: FAIL —— `wxPrepareApprove`/`wxConfirmApprove` 未定义。

- [ ] **Step 3: 实现 api 层两阶段函数**

`api.ts` 新增（用 `Date.now()`；`PendingApprove` 增加 `env` 字段——approve 时记录环境，confirm 用同一环境执行）：

```ts
export async function wxPrepareApprove(
  ctx: WxOpContext,
  opts: { biz: string; orderNumber: string; action: 'approve' | 'reject'; remarks?: string; environment?: string },
): Promise<string> {
  const ready = await readySession(ctx, opts.environment)
  const ref = await ctx.registry.resolveBiz(opts.biz)
  const rec = await findRecord(ref, opts.orderNumber, (vars) => callList(ready, ctx, ref, vars))
  if (!rec) return `未找到单号 ${opts.orderNumber} 的待办记录（可能已处理或单号有误）`
  const params = await approveParams(ref, opts.action, ready.account, opts.orderNumber, opts.remarks ?? '', rec,
    (vars) => callDetail(ready, ctx, ref, vars))
  const summary = approveSummary(ref, rec, opts.orderNumber, opts.action, opts.remarks ?? '')
  // env 存入 pending：confirm 时用同一环境执行，防止 approve=pro、confirm 默认 test 打错网关
  ctx.pending.set({
    account: ready.account, biz: opts.biz, action: opts.action, orderNumber: opts.orderNumber,
    vars: params, summary, env: ready.env,
  })
  return summary
}

export async function wxConfirmApprove(
  ctx: WxOpContext, opts: { decision: 'confirm' | 'cancel'; environment?: string },
): Promise<string> {
  const ready = await readySession(ctx, opts.environment)
  const p = ctx.pending.take(ready.account)
  if (!p) return '没有待确认的审批（可能已过期或已处理，请重新发起）'
  if (opts.decision !== 'confirm') return '已取消审批操作。'
  try {
    return await executeApprove(ctx, p)   // 用 p.env 解析网关/hmacKey，见下
  } catch (e) {
    ctx.pending.rebid(p)                  // 失败回写可重试
    throw e
  }
}
```

`callList`/`callDetail`/`executeApprove` 复用 `callOp` 的请求构造逻辑（按 `ref.biz.list` / `ref.biz.detail` / `ref.biz.ops.approve|reject` 的 method/path/requestBody/requestQuery 发请求、渲染返回）；`executeApprove` 用 `p.env` 调 `ctx.config.getReadyEnv(p.env)` 解析网关与密钥（不依赖 confirm 传入的默认环境）。

`wx-plugin.ts`：注册 `wx_confirm`（参数 decision: confirm/cancel）；wx_approve 改为调 `wxPrepareApprove`（不执行写操作）；backend 上下文带 `pending` 实例（每插件实例一个 PendingStore）。

- [ ] **Step 4: 同轮防护（基于 agent turn 事件，不使用 callId）**

**实现机制（评审修正：`ToolRunContext` 无 turn 标识，callId 每次调用不同，靠 callId 相等无法判断同轮）**：DSH 的 turn 编号只出现在 agent/session 事件上（`agent/pre-step` 携带 `turn`）。插件订阅该事件，维护 `Map<agentId, number>` 当前 turn；`wx_approve` 成功时记录 `lastApproveTurn`；`wx_confirm` 比较当前 turn 与记录值，相同则拒绝：

```ts
// 独立小类，便于单测注入时钟
export class SameTurnGuard {
  private last = new Map<string, number>()
  constructor(private readonly getTurn: (agentId: string) => number) {}
  recordApprove(agentId: string): void { this.last.set(agentId, this.getTurn(agentId)) }
  isSameTurn(agentId: string): boolean { return this.last.get(agentId) === this.getTurn(agentId) }
}
```

- 插件初始化：`const guard = new SameTurnGuard((id) => turnByAgent.get(id) ?? -1); ctx.on('agent/pre-step', (p) => turnByAgent.set(p.agent.id, p.turn))`；
- `wx_approve` 成功存 pending 后调 `guard.recordApprove(exec.agent!.id )`；
- `wx_confirm` execute 开头：`if (guard.isSameTurn(exec.agent!.id)) return '确认操作必须在用户下一条消息中单独进行，不能在发起审批的同一轮执行。'`；
- 单测（`src/wx/same-turn.test.ts`）：用一个可控的 `getTurn` 注入（先返回 1 → recordApprove → isSameTurn true；再返回 2 → isSameTurn false）验证同轮拒绝、下轮放行。

- [ ] **Step 5: 更新 wx_approve 工具描述与注入**

- `inject` 从 `['tools', 'approval']` 改为 `['tools']`（对话框两步确认足够，spec §2 不叠加 DSH approval 弹窗）；
- 删除 `askApproval` helper 及 `ApprovalService` 相关 import；
- `wx_approve` 的 model-facing 描述改为：「发起审批通过/驳回：定位单据、推导参数并生成确认摘要，登记待确认状态，**不会直接执行**；用户回复『确认』后调用 wx_confirm 执行，回复『取消』调用 wx_confirm 取消」；
- `wx_confirm` 的 model-facing 描述：「确认或取消待执行的审批。用户明确回复『确认』时调用 decision=confirm 执行；回复『取消』时调用 decision=cancel」。

- [ ] **Step 6: 运行全量测试**

Run: `cd /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin && WX_TEST_HMAC_KEY=test-key WX_TEST_GATEWAY=http://localhost:9090 npx vitest run`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
cd /Users/yangjingting/develop/ai/deepseek-harness
git add scratch-plugin/src/wx/api.ts scratch-plugin/src/wx/pending.ts scratch-plugin/src/wx/prepare.ts scratch-plugin/src/wx-plugin.ts scratch-plugin/src/wx/steps.test.ts scratch-plugin/src/wx/same-turn.test.ts scratch-plugin/wx-plugin.test.ts
git commit -m "feat(scratch-plugin): two-step approve/confirm with same-turn guard"
```

### Task 2.4: 审计日志

**Files:**
- Create: `scratch-plugin/src/wx/audit.ts`
- Create: `scratch-plugin/src/wx/audit.test.ts`
- Modify: `scratch-plugin/src/wx/api.ts`（record 调用接线：wxPrepareApprove 记 approve-request、wxConfirmApprove 记 cancel/success/failure）
- Modify: `scratch-plugin/src/wx-plugin.ts`（可选配置 auditPath；backend 上下文带 auditor）

**审计事件定义（移植 Go 版 handleApprove/handleConfirm 的记录点）：**

| 时机 | 记录 |
|------|------|
| wxPrepareApprove 成功登记 pending | `{ event: 'approve-request', account, biz, orderNumber, action, outcome: 'pending' }` |
| wxConfirmApprove decision=cancel | `{ event: 'approve-cancel', account, biz, orderNumber, action, outcome: 'cancelled' }` |
| wxConfirmApprove 执行成功 | `{ event: action, account, biz, orderNumber, action, outcome: 'success' }` |
| wxConfirmApprove 执行失败 | `{ event: action, account, biz, orderNumber, action, outcome: 'failed', error }` |

- [ ] **Step 1: 写失败测试**

`scratch-plugin/src/wx/audit.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Auditor } from './audit.ts'

describe('Auditor', () => {
  it('appends JSONL lines with account, action and outcome', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audit-'))
    const a = new Auditor(join(dir, 'audit.jsonl'))
    await a.record({ account: 'u1', biz: 'purchase.generay', orderNumber: 'PR1', action: 'approve', outcome: 'success' })
    const text = await readFile(join(dir, 'audit.jsonl'), 'utf8')
    expect(text).toContain('"account":"u1"')
    expect(text).toContain('"action":"approve"')
  })

  it('creates the directory automatically', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audit-'))
    const a = new Auditor(join(dir, 'nested', 'deeper', 'audit.jsonl'))
    await a.record({ account: 'u1', biz: 'b', orderNumber: 'P1', action: 'reject', outcome: 'success' })
    const text = await readFile(join(dir, 'nested', 'deeper', 'audit.jsonl'), 'utf8')
    expect(text).toContain('"action":"reject"')
  })

  it('does not throw when the write fails (warn only, non-blocking)', async () => {
    const a = new Auditor('/nonexistent-root-xyz/audit.jsonl')  // 不会存在的目录
    await expect(a.record({ account: 'u1', biz: 'b', orderNumber: 'P1', action: 'approve', outcome: 'success' })).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin && npx vitest run src/wx/audit.test.ts`
Expected: FAIL —— `Auditor` 不存在。

- [ ] **Step 3: 实现 auditor + 接线**

`audit.ts`：`Auditor` 类，构造收 `filePath`；`record(entry)` 追加一行 JSON（`JSON.stringify(entry)` + `\n`），用 `mkdir(dirname, { recursive: true })` 自动建目录；`appendFile` 失败时 `console.warn`（不抛错，审计失败不应阻断审批）。

`api.ts` 接线：`WxOpContext` 增加可选 `auditor?: Auditor`；`wxPrepareApprove` 在存 pending 后 `ctx.auditor?.record({...})`；`wxConfirmApprove` 在 cancel/success/failure 各分支记录（record 调用不 await 阻塞——fire-and-forget 或并发，但审计失败不改变返回）。

`wx-plugin.ts`：Config 增加可选 `auditPath?: string`；apply 时若配置了 auditPath 则实例化 `Auditor` 并放入 backend 上下文（`logger` 用 service 或 `console`）。

- [ ] **Step 4: 运行确认通过**

Run: `cd /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin && WX_TEST_HMAC_KEY=test-key WX_TEST_GATEWAY=http://localhost:9090 npx vitest run`
Expected: PASS（含原有全部测试）。

- [ ] **Step 5: Commit**

```bash
cd /Users/yangjingting/develop/ai/deepseek-harness
git add scratch-plugin/src/wx/audit.ts scratch-plugin/src/wx/audit.test.ts scratch-plugin/src/wx/api.ts scratch-plugin/src/wx-plugin.ts
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

- [ ] **Step 1: 写失败测试（订阅 + 断线 3s 重连 + errcode 拒绝 + 失败回复）**

测试用假 WebSocket 工厂注入（`wsFactory` 返回可脚本化对象），覆盖：订阅 ack 校验、消息回调和回复帧、断线后 3 秒重连、订阅 errcode≠0 时拒绝、handler 抛错时回复错误文本。注意 `onMessage` 是 ConnectionManager 的可注入回调（默认接 Router）：

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ConnectionManager } from './connection.ts'

/** 可脚本化假 WebSocket。 */
class FakeWS {
  sent: string[] = []
  handlers = new Map<string, (ev: any) => void>()
  closed = false
  send(d: string) { this.sent.push(d) }
  close() { this.closed = true; const cb = this.handlers.get('close'); if (cb) cb({}) }
  addEventListener(ev: string, cb: any) { this.handlers.set(ev, cb) }
  emit(event: string, data: string) {
    const cb = this.handlers.get(event); if (cb) cb({ data })
  }
}

describe('ConnectionManager', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function setup(handlers: { onMessage?: (m: any) => Promise<string> } = {}) {
    const sockets: FakeWS[] = []
    const conn = new ConnectionManager({
      wsURL: 'ws://fake', botID: 'b1', secret: 's1',
      wsFactory: () => { const s = new FakeWS(); sockets.push(s); return s as any },
      onMessage: handlers.onMessage ?? (async (m: any) => `reply:${m.text}`),
    })
    return { conn, sockets }
  }

  it('subscribes, dispatches callbacks and replies', () => {
    const { conn, sockets } = setup()
    conn.start()                       // 第一个 socket 已创建
    const ws = sockets[0]!
    expect(ws.sent[0]).toContain('aibot_subscribe')
    // 订阅 ack（errcode 0）
    ws.emit('message', JSON.stringify({ errcode: 0, errmsg: 'ok', headers: { req_id: '' } }))
    // 消息回调
    ws.emit('message', JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: 'r' }, body: { from: { userid: 'u1' }, msgtype: 'text', text: { content: 'hi' } } }))
    expect(ws.sent.some((s) => s.includes('aibot_respond_msg'))).toBe(true)
  })

  it('rejects a subscription with errcode != 0 and reconnects after 3s', () => {
    const { conn, sockets } = setup()
    conn.start()
    const ws = sockets[0]!
    // 订阅返回错误
    ws.emit('message', JSON.stringify({ errcode: 40001, errmsg: 'bad secret', headers: { req_id: '' } }))
    // 实现应关闭并重连
    expect(ws.closed || conn.isStopped()).toBe(true)
    vi.advanceTimersByTime(3001)       // 3 秒后重连
    expect(sockets.length).toBeGreaterThanOrEqual(2)   // 第二个 socket 已创建
    conn.stop()
  })

  it('responds with an error text when the handler fails', async () => {
    const { conn, sockets } = setup({ onMessage: async () => { throw new Error('网关超时') } })
    conn.start()
    const ws = sockets[0]!
    ws.emit('message', JSON.stringify({ errcode: 0, errmsg: 'ok', headers: { req_id: '' } }))
    ws.emit('message', JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: 'r' }, body: { from: { userid: 'u1' }, msgtype: 'text', text: { content: 'hi' } } }))
    // 实现应回复具体错误文本（spec §7：消息处理失败回复具体原因，不模糊回复）
    expect(ws.sent.some((s) => s.includes('网关超时'))).toBe(true)
    conn.stop()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin && npx vitest run src/wecom-bridge/connection.test.ts`
Expected: FAIL —— `ConnectionManager` 不存在。

- [ ] **Step 3: 实现 ConnectionManager（心跳策略明确化）**

**心跳策略（评审修正：Node 22 原生 WebSocket 没有 `ping()` 方法，无法移植 Go 版的 WS 控制帧 ping）**。选定方案：**应用层心跳文本帧 + 服务端 ping 自动 pong**——

- Node 原生 WebSocket（undici）遇到服务端发来的 ping 会自动回 pong（协议层内置），所以服务端主动探活能收到 pong；
- 应用层每隔 30s 发送一条 `aibot_heartbeat` 文本帧（若企微协议不支持该命令会被 ack 为「命令拒绝」并忽略，不致命）；若协议文档没有应用层心跳命令，则退化为「读超时检测」：`setInterval(35s)` 检查最近一次收到任何帧的时间，超过阈值判定连接僵死 → 主动 close 触发重连；
- 新连接建立后**第一个消息帧必须是订阅 ack**（state 机）：状态 `SUBSCRIBING → SUBSCRIBED`，在 SUBSCRIBING 状态收到 errcode≠0 的 ack → close 并重连（3s）；
- 断线（`onclose` / 心跳超时）→ 3 秒后重连（移植 Go 版 `Run()` 循环）；
- 读循环异步：`onmessage` 仅 `void this.handleMessage(msg)`，不阻塞后续帧（详见 Task 3.3 的 Router 串行化）；
- `isStopped()` / `stop()` 供测试与优雅退出（SIGTERM 时调用）。

```ts
export interface ConnectionOptions {
  wsURL: string
  botID: string
  secret: string
  wsFactory?: typeof WebSocket        // 可注入，测试用
  onMessage: (m: { userID: string; text: string }) => Promise<string>
  reconnectDelayMs?: number           // 默认 3000
  heartbeatMs?: number                // 默认 30000
}

export class ConnectionManager {
  constructor(opts: ConnectionOptions) {}
  start(): void
  stop(): void
  isStopped(): boolean
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin && npx vitest run src/wecom-bridge/connection.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
cd /Users/yangjingting/develop/ai/deepseek-harness
git add scratch-plugin/src/wecom-bridge/connection.ts scratch-plugin/src/wecom-bridge/connection.test.ts
git commit -m "feat(scratch-plugin): wecom ws connection manager with heartbeat and reconnect"
```

### Task 3.3: 消息→agent 会话路由接口

**Files:**
- Create: `scratch-plugin/src/wecom-bridge/session-router.ts`
- Create: `scratch-plugin/src/wecom-bridge/session-router.test.ts`

> 文件归属说明：`bridge-plugin.ts` 由 Task 3.4 拥有（本任务只产出 `session-router.ts` 的 Router + `AgentSessionProvider` 接口；默认 agent-provider 实现也在 Task 3.4 的 bridge-plugin.ts 中）。本任务不触碰 `connection.ts`（Task 3.2 已注入 `onMessage` 回调，Task 3.4 把回调接到 Router）。

**本任务产出：**

```ts
/** 提供者：把一条用户消息交给 agent 会话并返回最终回复文本。 */
export interface AgentSessionProvider {
  prompt(userID: string, text: string, signal?: AbortSignal): Promise<string>
}

/** 按 userID 路由消息：同一用户串行、不同用户并行。 */
export class Router {
  constructor(private readonly provider: AgentSessionProvider) {}
  /** 处理一条消息，返回回复文本 promise（由调用方发送）。 */
  handle(input: { userID: string; text: string }): Promise<string>
}
```

- [ ] **Step 1: 写失败测试（mock provider 断言 userID 隔离与串行）**

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
    const a = r.handle({ userID: 'u1', text: 'm1' })
    const b = r.handle({ userID: 'u1', text: 'm2' })
    const c = r.handle({ userID: 'u2', text: 'm3' })
    const [ra, rb, rc] = await Promise.all([a, b, c])
    expect(ra).toBe('reply-u1')
    expect(rb).toBe('reply-u1')
    expect(rc).toBe('reply-u2')
    expect(order).toEqual(['u1:m1', 'u1:m2', 'u2:m3'])  // u1 串行，u2 并行
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin && npx vitest run src/wecom-bridge/session-router.test.ts`
Expected: FAIL —— `Router` 不存在。

- [ ] **Step 3: 实现 Router（per-user promise 链）**

per-user 队列：`Map<userID, Promise<string>>`，每次 handle 把新 promise 接到前一个 promise 之后（`prev.then(() => provider.prompt(...))`），不同 userID 各自独立链（天然并行）。实现要点：链的末尾错误要捕获并落定（防止未处理 rejection），同用户下一条消息仍能继续。

- [ ] **Step 4: 运行确认通过**

Run: `cd /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin && npx vitest run src/wecom-bridge/session-router.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
cd /Users/yangjingting/develop/ai/deepseek-harness
git add scratch-plugin/src/wecom-bridge/session-router.ts scratch-plugin/src/wecom-bridge/session-router.test.ts
git commit -m "feat(scratch-plugin): per-user serialized message router"
```

### Task 3.4: bridge 插件入口 + 能力接线

**Files:**
- Create: `scratch-plugin/src/wecom-bridge/bridge-plugin.ts`（本任务独占创建，含 `DefaultWSURL` 常量 + AgentSessionProvider 的 ctx 实现）
- Create: `scratch-plugin/src/wecom-bridge/bridge-plugin.test.ts`（加载 smoke + userID→account 注入测试）
- Modify: `scratch-plugin/src/wx-plugin.ts`（暴露 account 注入：agent 会话携带 userID → wx 工具读取）

- [ ] **Step 1: 写失败测试（加载 smoke + userID→account 注入）**

`bridge-plugin.test.ts` 两部分：

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply as applyBridge } from './bridge-plugin.ts'
import type { AgentSessionProvider } from './session-router.ts'

describe('bridge plugin registration', () => {
  let ctx: Context
  beforeAll(() => { ctx = new Context() })
  afterAll(async () => { await ctx.dispose() })

  it('registers without throwing', () => {
    expect(() => applyBridge(ctx, {
      wsURL: 'wss://fake', botID: 'b', secret: 's',
      agentProvider: async (userID, text) => `reply-${userID}`,
    })).not.toThrow()
  })
})
```

```ts
// userID→account 注入测试（spec §5 身份模型、§3 消息路由到 X-Account）
import { describe, it, expect } from 'vitest'
import { Router } from './session-router.ts'

describe('userID propagation to wx tools', () => {
  it('passes the WS userID through the provider to become the account', async () => {
    const seen: string[] = []
    const provider: AgentSessionProvider = {
      async prompt(userID) { seen.push(userID); return 'ok' },
    }
    const r = new Router(provider)
    await r.handle({ userID: 'wx-user-9', text: 'hi' })
    expect(seen).toEqual(['wx-user-9'])
    // wx 工具侧：provider 实现把 userID 作为 WxOpContext.account 注入（详见 Step 4）
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin && npx vitest run src/wecom-bridge/bridge-plugin.test.ts`
Expected: FAIL —— `bridge-plugin.ts` 不存在。

- [ ] **Step 3: 实现 bridge-plugin.ts**

```ts
/** 企微智能机器人长连接默认地址（对齐 Go wecom.DefaultWSURL）。 */
export const DefaultWSURL = 'wss://openws.work.weixin.qq.com'

/** 可注入的 agent 会话提供者：userID → 回复文本。不注入时用 ctx.agents 默认实现。 */
export type AgentProvider = (userID: string, text: string, signal?: AbortSignal) => Promise<string>

export interface BridgeConfig {
  wsURL?: string
  botID: string
  secret: string
  /** 覆盖默认 agent 提供者（测试用）。 */
  agentProvider?: AgentProvider
}

export function apply(ctx: Context, cfg: BridgeConfig) {
  const provider: AgentSessionProvider = {
    async prompt(userID, text, signal) {
      if (cfg.agentProvider) return cfg.agentProvider(userID, text, signal)
      // 默认实现：经 ctx.agents 取/建 userID 会话（1:1），发 prompt 收集 committed assistant 文本。
      // 参考实现模式：packages/acp/（create session → followup → whenIdle → 收集回复）。
      return defaultSessionPrompt(ctx, userID, text, signal)
    },
  }
  const router = new Router(provider)
  const conn = new ConnectionManager({
    wsURL: cfg.wsURL ?? DefaultWSURL,
    botID: cfg.botID,
    secret: cfg.secret,
    onMessage: async (m) => {
      try {
        return await router.handle({ userID: m.userID, text: m.text })
      } catch (e) {
        // spec §7：消息处理失败回复具体错误，不做模糊回复
        return `处理失败：${e instanceof Error ? e.message : String(e)}（请稍后重试或检查单号是否正确）`
      }
    },
  })
  conn.start()
  ctx.on('dispose', () => conn.stop())
}
```

`defaultSessionPrompt(ctx, userID, text, signal)` 的实现要点（对齐 `packages/acp/*` 模式）：
- `ctx.agents` 按 userID 建/取 agent（1:1）：首次 `ctx.agents.create({ sessionId, agentOptions })`，之后按 `userID` 键缓存 `AgentHandle`；
- 发送：`agent.followup({ role: 'user', content: text })`（或 inbox.append + steer）；
- 等待：`agent.whenIdle()`；
- 收集：监听 `assistant/message` 事件 / 会话事件流读取 committed assistant 文本，取本轮回复拼接返回；
- 会话创建时把 `userID` 记为会话变量（供 Step 4 的 wx 工具读取）。

- [ ] **Step 4: userID → WxOpContext.account 注入**

改造 `wx-plugin.ts` 提供 account 解析函数（弱耦合，供 bridge 与 DSH 会话共用）：

```ts
// wx-plugin.ts 导出
/** 从 agent 会话上下文解析当前企微用户身份；无则回退 defaultAccount / 空。 */
export function resolveAccount(agent: { id: string }, lookup: (agentId: string) => string | undefined, defaultAccount?: string): string {
  return lookup(agent.id) ?? defaultAccount ?? ''
}
```

- bridge 侧：`defaultSessionPrompt` 创建会话时注册 `agentId → userID` 映射（一个 `Map`），并提供查询函数；
- wx 工具 execute 里：`const account = resolveAccount(exec.agent!, (id) => sessionUsers.get(id), cfg.defaultAccount)` → 放入该次调用的 `WxOpContext.account`；
- 同一 map 注入方式以实际 DSH 的 exec 上下文传递机制为准（`ToolRunContext` 在 `@deepseek-ai/dsh-tools`，`packages/core/tools/src/index.ts`；`exec.agent` 已可用）。若 DSH 提供 agent 级会话变量注入，优先用会话变量（更干净）；否则用插件内部 `Map` + 每调用查询。

**验证注入闭环（Step 1 的第二个测试 + 本步实现后）：** 一个集成级 vitest（或 Chunk 4 Task 4.3 的快照）接线 `Router → 真实 provider（stub agent 会话）→ wx_query_todo`，断言网关请求的 `X-Account === userID`。

- [ ] **Step 5: 运行确认通过**

Run: `cd /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin && WX_TEST_HMAC_KEY=test-key WX_TEST_GATEWAY=http://localhost:9090 npx vitest run`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
cd /Users/yangjingting/develop/ai/deepseek-harness
git add scratch-plugin/src/wecom-bridge/bridge-plugin.ts scratch-plugin/src/wecom-bridge/bridge-plugin.test.ts scratch-plugin/src/wx-plugin.ts
git commit -m "feat(scratch-plugin): wecom bridge plugin wiring messages into agent sessions"
```

---

## Chunk 4: 能力边界组合配置 + 部署交付

目标：产出服务器部署目录（自包含、systemd 可托管）、只暴露审批能力的 cordis.yml，以及打包脚本；不挂 bash/fs/web/subagent 等无关能力。

### Task 4.1: 部署组合配置（能力收敛）

**Files:**
- Create: `scratch-plugin/deploy/cordis.yml`
- Create: `scratch-plugin/deploy/README.md`

- [ ] **Step 1: 写部署组合配置（引擎部分完整钉死 + 显式关闭非审批工具）**

**关键事实（评审核实）**：示例用的 `@deepseek-ai/dsh-agent-spine-demo` **默认自注册模型可见的 bash、skill、jobs 工具**（`packages/examples/agent-spine-demo/src/index.ts`：`toolBash` 默认开、`toolSkill` 默认开、`toolJobs` 默认开），并且 schema 要求 `workspaceContext` 与 `dshHome`。要实现 spec §8.1 的硬边界，必须**显式关闭**：`toolBash: false`、`toolJobs: false`、`skills.enabled: false`、`workspaceContext: false`。

`scratch-plugin/deploy/cordis.yml` 完整内容（基线参照 `examples/headless-agent/cordis.yml` 的 agent-spine/LLM/persistence/guard 最小集；**不挂** bash/fs/web/subagent/workflow/goal/ralph/todo/skill/jobs）：

```yaml
# 部署组合：企微审批机器人。只挂审批工具 + 最小引擎，不挂任何通用能力插件。
- id: settings
  name: '@deepseek-ai/dsh-settings-file'

- id: credentials
  name: '@deepseek-ai/dsh-credentials-local'

- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    thinking: enabled
    reasoningEffort: max
    models:
      - id: deepseek-v4-pro
        contextWindow: 128000
      - id: deepseek-v4-flash
        contextWindow: 128000

- id: agent-spine
  name: '@deepseek-ai/dsh-agent-spine-demo'
  config:
    agents:
      - id: main
        provider: deepseek-official
        model: deepseek-v4-flash
        cwd: !!js process.cwd()
    # 能力边界：只保留审批工具。显式关闭 agent-spine 自带的通用工具。
    toolBash: false
    toolSkill: false
    toolJobs: false
    skills:
      enabled: false
    workspaceContext: false
    persona: |
      你是企业微信审批助手，代表企业微信用户处理内部审批业务。

      ## 能力与边界
      - 你只处理：查询待办/已办、查看单据详情、审批通过/驳回。
      - 可用审批系统通过 wx_query_biz 查询；业务引用格式：系统名（如 purchase）或 系统.业务（如 purchase.generay）。
      - 你的身份是「当前对话用户」，所有查询/审批都以该用户身份执行，不要假设能看到其他用户的数据。

      ## 审批规则（重要）
      - 审批通过/驳回是敏感写操作：必须先调用 wx_approve（它返回单据摘要并登记待确认，不会直接执行），用户明确回复「确认」后调用 wx_confirm(decision=confirm) 执行；回复「取消」或含糊时调用 wx_confirm(decision=cancel) 清理待确认状态。
      - 用户未提供完整单号时，先引导用户补充，或建议先调用 wx_query_todo 查询待办列表。

      ## 回复风格
      - 用简洁中文回复，直接呈现工具返回的列表/摘要，不要编造数据。
      - 与审批无关的请求（写代码、闲聊、查询外部信息等）一律礼貌拒绝，并说明你只处理审批业务。

- id: persistence
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: './data/sessions'
    compression: zstd

- id: checkpoint-policy
  name: '@deepseek-ai/dsh-session-checkpoint-policy'

- id: token-meter
  name: '@deepseek-ai/dsh-token-meter'

- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  config:
    thresholdRatio: 0.8
    retainRatio: 0.16
    maxTokens: 8192
    compactionRetries: 1

- id: timeout-policy
  name: '@deepseek-ai/dsh-tool-call-timeout-policy'
  config:
    defaultTimeoutMs: 30000

- id: repeat-tool-reminder
  name: '@deepseek-ai/dsh-repeat-tool-reminder'

# 审批工具插件（scratch-plugin）
- id: wx-agent
  name: '/opt/wx-dsh-agent/plugins/wx-plugin.ts'
  config:
    defaultEnv: !!js "process.env.WX_DEFAULT_ENV ?? 'pro'"
    defaultAccount: !!js "process.env.WX_DEFAULT_ACCOUNT ?? ''"
    auditPath: '/opt/wx-dsh-agent/data/audit.jsonl'

# 企微机器人桥接插件（scratch-plugin）
- id: wecom-bridge
  name: '/opt/wx-dsh-agent/plugins/bridge-plugin.ts'
  config:
    wsURL: !!js "process.env.WX_WS_URL ?? 'wss://openws.work.weixin.qq.com'"
    botID: !!js "process.env.WX_BOT_ID"
    secret: !!js "process.env.WX_BOT_SECRET"
```

要点：
- 环境变量统一用 `!!js "process.env.X"` 语法（仓库唯一支持的插值；`${...}` 无效）；
- 插件路径用部署绝对路径占位，由 Task 4.2 的 build 脚本在生成部署目录时替换为实际路径；
- 服务器默认 `defaultEnv: 'pro'`（测试环境仅供本机调试）。
- 最后用 `verify-cordis-config` 或 DSH 的 config 校验检查组合可加载（若该 gate 存在于仓库 gates，亦可在 smoke 中覆盖）。

- [ ] **Step 2: 写部署 README（环境变量清单、启动方式、systemd 示例）**

`scratch-plugin/deploy/README.md` 包含：环境变量清单（`WX_BOT_ID`/`WX_BOT_SECRET`/`WX_PRO_HMAC_KEY`/`WX_PRO_GATEWAY`/`WX_DEFAULT_ENV`/`WX_DEFAULT_ACCOUNT`/`DEEPSEEK_API_KEY`）、构建/部署步骤、systemd 示例、密钥管理说明（HMAC 密钥只通过环境变量注入，绝不入库）、默认 pro 环境提示。

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
- Create: `scratch-plugin/deploy/smoke.sh`

**部署方式（钉死，评审修正：scratch-plugin 无 package.json、node_modules 为空，无法机械「打包 node_modules」）**：DSH 运行时以**仓库根已安装的 `dsh` CLI** 为启动载体。build 脚本把「插件源码 + 部署 cordis.yml + 配置模板」复制进部署目录；启动命令为 `pnpm --dir <harness 仓库> dsh --profile <部署 profile> ...` 或直接 node 加载 cordis 引导（以 `apps/cli` 的 profile-boot 为准）。具体形态二选一，build 脚本内实现并固化：

- 形态 A（推荐，简单）：服务器与开发机共用 deepseek-harness 仓库安装（`pnpm install` 后），build 脚本生成部署目录，systemd `ExecStart` 调 `pnpm --dir /opt/deepseek-harness dsh --profile /opt/wx-dsh-agent`（dsh CLI 支持 profile 路径开头的部署配置，见 `apps/cli/README.md`）；
- 形态 B（完全自包含）：`pnpm deploy` 过滤拷贝 DSH 依赖到部署目录（工作量较大，本期作为备选；若 A 不可行再启用）。

本任务**实现形态 A**，并在 smoke.sh 验证。

- [ ] **Step 1: 实现 build 脚本**

`build-wx-dsh-agent.sh`（参照 `bin/build-wx-agent.sh` 风格）阶段：
1. `mkdir -p "$OUT/plugins" "$OUT/data"`；把 `scratch-plugin/src/wx/`、`src/wecom-bridge/`、`src/wx-plugin.ts` 复制到 `$OUT/plugins/`（保留目录结构：`plugins/wx/…`、`plugins/wecom-bridge/…`、`plugins/wx-plugin.ts`）；
2. 拷贝 `deploy/cordis.yml` → `$OUT/cordis.yml`，并把其中的 `/opt/wx-dsh-agent/plugins/` 占位路径替换为 `$OUT/plugins/`（用 `sed`，`$OUT` 由脚本参数指定）；
3. 生成 `$OUT/.env.example`（环境变量清单模板）；
4. 输出部署目录结构。

- [ ] **Step 2: 实现 systemd 单元**

`wx-dsh-agent.service`：

```ini
[Unit]
Description=wx-dsh-agent 企微审批机器人
After=network.target

[Service]
User=appuser
Group=appuser
WorkingDirectory=/opt/wx-dsh-agent
EnvironmentFile=/opt/wx-dsh-agent/.env
ExecStart=/usr/local/bin/pnpm --dir /opt/deepseek-harness dsh --profile /opt/wx-dsh-agent/cordis.yml
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 3: 部署冒烟测试（可离线）**

`smoke.sh`：临时目录跑 build 脚本 → 断言产物文件齐全（cordis.yml/plugins/data/.env.example）→ 断言**部署后的 cordis.yml 不含残余 `/opt/wx-dsh-agent` 占位**且**不含 `toolBash` 之外的禁止能力插件**（grep 检查 `dsh-bash-local`/`dsh-fs-local`/`dsh-tool-web` 等未出现）→ 用无法连通的假 `WX_BOT_ID`/`WX_BOT_SECRET` + 假网关密钥启动 dsh 进程 → 断言进程存活（重连循环不崩溃）→ `SIGTERM` 后断言退出码 0（DSH CLI 已实现 SIGTERM→exit 0，见 `apps/cli/src/profile-boot.ts`）→ 清理。

- [ ] **Step 4: Commit**

```bash
cd /Users/yangjingting/develop/ai/deepseek-harness
git add scratch-plugin/deploy/
git commit -m "feat(scratch-plugin): self-contained deploy bundle with systemd unit and smoke test"
```

### Task 4.3: 端到端对话测试（查待办→审批→确认 全链路）

**Files:**
- Create: `scratch-plugin/e2e/approval-dialog.test.ts`（vitest 集成测试）

**机制说明（评审修正）**：仓库的 keyless snapshot 是 JSONL 场景套件（`examples/<name>/tests/snapshots/` + `pnpm run test:snapshot`），依赖 example leaf 结构；scratch-plugin 不在 examples 树内，不适用。本任务改用 **vitest 集成测试**断言完整对话输出文本（带 mock transport + mock WS 回调，无需真实 LLM/网关），作为端到端行为的可离线验证；JSONL 快照套件列为后续扩展（若需要发布产品级快照再迁移到 examples 树）。

- [ ] **Step 1: 写端到端对话测试（mock transport + mock WS 回调）**

`e2e/approval-dialog.test.ts` 场景脚本：

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Router } from '../src/wecom-bridge/session-router.ts'
import { PendingStore } from '../src/wx/pending.ts'
import { wxQueryTodo, wxPrepareApprove, wxConfirmApprove } from '../src/wx/api.ts'
import { WxConfig } from '../src/wx/config.ts'
import { WxRegistry } from '../src/wx/registry.ts'

describe('approval dialog end-to-end (mocked)', () => {
  // 构造 ctx：registry/config 用内置资产，transport 是 mock（记录请求并返回预设响应体）
  // 1) user 发「查待办」→ wxQueryTodo 返回待办列表文本
  // 2) user 发「审批通过 PR999」→ wxPrepareApprove 返回摘要（含「回复确认执行」），零写调用
  // 3) user 发「确认」→ wxConfirmApprove(decision=confirm) 执行写调用一次，返回结果文本
  // 断言：写调用次数、摘要文本、执行结果文本顺序正确
})
```

- [ ] **Step 2: 运行确认通过**

Run: `cd /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin && WX_TEST_HMAC_KEY=test-key WX_TEST_GATEWAY=http://localhost:9090 npx vitest run e2e`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
cd /Users/yangjingting/develop/ai/deepseek-harness
git add scratch-plugin/e2e/
git commit -m "test(scratch-plugin): approval dialog end-to-end integration test"
```

---

## 验证清单（全部完成前不允许声称完成）

- [ ] 测试前置：`export WX_TEST_HMAC_KEY=test-key WX_TEST_GATEWAY=http://localhost:9090`（Chunk 1 Task 1.2 的惰性校验要求用到的环境配齐密钥）；
- [ ] `cd /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin && WX_TEST_HMAC_KEY=test-key WX_TEST_GATEWAY=http://localhost:9090 npx vitest run` 全绿；
- [ ] 类型检查：`cd /Users/yangjingting/develop/ai/deepseek-harness/scratch-plugin && npx tsc -p .`（tsconfig noEmit）无错误；在仓库根 `pnpm run typecheck`（若包含 scratch-plugin 则必须通过，否则跳过并记录原因）；
- [ ] 全仓库 grep 无 `wxHome` 残留必需引用（调试覆盖参数以 `wxHome?` 可选形式保留可接受）；
- [ ] `scratch-plugin/deploy/smoke.sh` 在干净临时目录通过（含部署产物完整性、禁止能力插件未出现、SIGTERM 退出码 0 断言）；
- [ ] 无真实密钥提交（git log 检查 `wx-cli.conf.json` 未入库）；
- [ ] 部署 cordis.yml 无残留占位路径（Task 4.2 的 sed 替换后，部署目录内 grep `/opt/wx-dsh-agent` 不出现）；
- [ ] 设计文档与计划文档均已提交 git；修订后的计划已重新评审通过。

## 实施顺序建议

Chunk 1 → Chunk 2 → Chunk 3 → Chunk 4。每 Chunk 结束跑一次全量 vitest；Chunk 3 的 Task 3.4 需要先阅读 DSH agent 会话 API（`packages/core/agent/` README + `packages/acp/` 的 bridge 实现模式——create session → followup → whenIdle → 收集 committed assistant 文本），如接口与计划假设不符，按实际 API 调整实现并更新本计划。Task 4.2 的形态 A 依赖 `apps/cli` 的 profile-boot 与 dsh CLI 的 profile 参数用法，实施前阅读 `apps/cli/README.md` 确认命令形态。