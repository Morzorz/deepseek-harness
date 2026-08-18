import { describe, it, expect, afterEach } from 'vitest'
import { wxQueryTodo } from './api.ts'
import { WxConfig } from './config.ts'
import { WxRegistry } from './registry.ts'

describe('api without local session', () => {
  const saved = new Map<string, string | undefined>()
  afterEach(() => {
    for (const [k, v] of saved) if (v === undefined) delete process.env[k]; else process.env[k] = v
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
