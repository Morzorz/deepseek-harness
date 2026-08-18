import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply as applyBridge } from './bridge-plugin.ts'

describe('bridge plugin registration', () => {
  let ctx: Context
  beforeAll(() => {
    ctx = new Context()
  })
  afterAll(async () => {
    // 真实 cordis Context 无 ctx.dispose()；根 fiber 的 dispose 才是拆解入口。
    await ctx.fiber.dispose()
  })

  it('registers without throwing and does not dial the network in tests', () => {
    expect(() =>
      applyBridge(ctx, {
        wsURL: 'wss://fake',
        botID: 'b',
        secret: 's',
        autoStart: false,
        wsFactory: (() => ({
          send() {},
          close() {},
          addEventListener() {},
          removeEventListener() {},
        })) as never,
        agentProvider: async (userID) => `reply-${userID}`,
      }),
    ).not.toThrow()
  })

  it('routes an injected agentProvider reply back over the fake socket', async () => {
    class FakeWS {
      sent: string[] = []
      handlers = new Map<string, (ev: any) => void>()
      send(d: string) { this.sent.push(d) }
      close() {}
      addEventListener(ev: string, cb: any) { this.handlers.set(ev, cb) }
      removeEventListener() {}
      emit(event: string, data: string) { this.handlers.get(event)?.({ data }) }
    }
    const sockets: FakeWS[] = []
    applyBridge(ctx, {
      wsURL: 'wss://fake',
      botID: 'b',
      secret: 's',
      wsFactory: () => { const s = new FakeWS(); sockets.push(s); return s as never },
      agentProvider: async (userID) => `reply-${userID}`,
    })
    const ws = sockets[0]!
    ws.emit('message', JSON.stringify({ errcode: 0, errmsg: 'ok', headers: { req_id: '' } }))
    ws.emit('message', JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: 'r' }, body: { from: { userid: 'u1' }, msgtype: 'text', text: { content: 'hi' } } }))
    await new Promise((r) => setTimeout(r, 0))
    expect(ws.sent.some((s) => s.includes('reply-u1'))).toBe(true)
  })
})

describe('userID propagation to wx tools (closed loop)', () => {
  const saved = new Map<string, string | undefined>()
  afterEach(() => {
    for (const [k, v] of saved) if (v === undefined) delete process.env[k]; else process.env[k] = v
  })

  it('a WS message userID ends up as the gateway X-Account on wx tool calls', async () => {
    saved.set('WX_TEST_HMAC_KEY', process.env.WX_TEST_HMAC_KEY)
    saved.set('WX_TEST_GATEWAY', process.env.WX_TEST_GATEWAY)
    process.env.WX_TEST_HMAC_KEY = 'test-key'
    process.env.WX_TEST_GATEWAY = 'http://localhost:9090'

    const { Router } = await import('./session-router.ts')
    const { wxQueryTodo } = await import('../wx/api.ts')
    const { WxConfig } = await import('../wx/config.ts')
    const { WxRegistry } = await import('../wx/registry.ts')
    const { PendingStore } = await import('../wx/pending.ts')
    const captured: string[] = []
    const sessionUsers = new Map<string, string>()
    const provider = {
      async prompt(userID: string, text: string) {
        sessionUsers.set('agent-1', userID)
        const c = {
          config: await WxConfig.load(),
          registry: await WxRegistry.load(),
          defaultEnv: 'test',
          pending: new PendingStore(5 * 60_000),
          account: sessionUsers.get('agent-1'),
          transport: {
            async do(o: { account: string }) {
              captured.push(o.account)
              return { body: JSON.stringify({ data: { page: { data: { data: [], total: 0 } } } }) }
            },
            async getMemberCode() {
              return 'M1001'
            },
          },
        }
        await wxQueryTodo(c as never, { biz: 'purchase.generay' })
        return 'done'
      },
    }
    const r = new Router(provider)
    await r.handle({ userID: 'wx-user-9', text: '查待办' })
    expect(captured[0]).toBe('wx-user-9')
  })
})
