import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply as applyBridge, defaultSessionPrompt } from './bridge-plugin.ts'
import { userByAgentId } from './agent-accounts.ts'
import { resolveAccount, apply as applyWxPlugin } from '../wx-plugin.ts'

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

describe('resolveAccount joins the bridge-populated userByAgentId to the wx tool X-Account', () => {
  const saved = new Map<string, string | undefined>()
  let ctx: Context
  let disposeWx: () => unknown = () => {}
  let captured: string[] = []
  const realFetch = globalThis.fetch

  beforeEach(async () => {
    saved.set('WX_TEST_HMAC_KEY', process.env.WX_TEST_HMAC_KEY)
    saved.set('WX_TEST_GATEWAY', process.env.WX_TEST_GATEWAY)
    process.env.WX_TEST_HMAC_KEY = 'test-key'
    process.env.WX_TEST_GATEWAY = 'http://localhost:9090'
    captured = []
    userByAgentId.clear()

    // Intercept the real transport's fetch to capture the X-Account header the
    // gateway call carries, without hitting the network.
    globalThis.fetch = (async (input: any, init?: any) => {
      // getMemberCode also goes over the gateway; serve an employeeNumber.
      if (String(input).includes('getCurrentUserInfo')) {
        return new Response(JSON.stringify({ employeeNumber: 'M1001' }), { status: 200 })
      }
      captured.push(init?.headers?.['X-Account'] ?? '')
      return new Response(
        JSON.stringify({ data: { page: { data: { data: [], total: 0 } } } }),
        { status: 200 },
      )
    }) as typeof fetch

    // Assemble a minimal wx-plugin runtime on a real Context, exactly like the
    // production composition: ToolRuntime + systemPrompt + wx tools.
    ctx = new Context()
    ctx.provide('systemPrompt', {
      section: () => () => {},
      context: () => () => {},
      tools: () => () => {},
      variable: () => () => {},
      suppressRuntimeContext: () => () => {},
      assemble: async () => ({ sections: [], contexts: [], tools: [], variables: {} }),
    } as never)
    const rt = await ctx.plugin(ToolRuntime)
    disposeWx = () => rt.dispose()
    applyWxPlugin(ctx, { defaultEnv: 'test' })
  })

  afterEach(async () => {
    globalThis.fetch = realFetch
    await disposeWx()
    for (const [k, v] of saved) if (v === undefined) delete process.env[k]; else process.env[k] = v
  })

  it('defaultSessionPrompt registers userByAgentId and resolveAccount consumes it into the tool X-Account', async () => {
    // Population: what defaultSessionPrompt does when it creates an agent for a
    // wecom user — publish agentId → userID.
    userByAgentId.set('agent-1', 'wx-user-9')

    // Consumption: the wx tool resolves the executing agent's userID via the
    // plugin's opCtx(exec.agent) → resolveAccount against the shared map.
    expect(resolveAccount({ id: 'agent-1' }, (id) => userByAgentId.get(id), '')).toBe('wx-user-9')

    const tool = ctx.tools.get('wx_query_todo')!
    // Executing an agent-scoped wx tool through the plugin's real opCtx must
    // send the agent's wecom userID as the gateway X-Account — the closed loop.
    await tool.execute(
      { biz: 'purchase.generay' },
      { agent: { id: 'agent-1' }, signal: new AbortController().signal } as never,
    )
    expect(captured[0]).toBe('wx-user-9')
  })
})

describe('defaultSessionPrompt runs against a stubbed agents service', () => {
  beforeEach(() => {
    userByAgentId.clear()
  })

  it('calls agents.create with a sessionId, registers the account mapping, and returns collected text', async () => {
    const assistantBySession = new Map<any, string[]>()
    const created: Array<{ sessionId: unknown }> = []
    const agentByUser = new Map<any, any>()
    const agents = {
      create: async (opts: { sessionId: any }) => {
        created.push(opts)
        const sessionId = opts.sessionId
        const handle = {
          agent: {
            id: sessionId,
            session: { id: sessionId },
            followup: () => {
              // Simulate the session/event collector committing an assistant
              // message into this session's buffer during the turn.
              const buffer = assistantBySession.get(sessionId) ?? []
              buffer.push('committed-text')
            },
            cancel: () => {},
            whenIdle: async () => {},
          },
          dispose: async () => {},
        }
        return handle
      },
    }
    const ctx = { agents } as unknown as Context

    const reply = await defaultSessionPrompt(ctx, agentByUser, assistantBySession, 'wx-user-9', 'hello')

    // create was called with a session id.
    expect(created.length).toBe(1)
    expect(created[0]!.sessionId).toBeTruthy()
    // The bridge published agentId → userID, mirroring the created agent.
    const agentId = agentByUser.get('wx-user-9')!.agent.id
    expect(userByAgentId.get(agentId)).toBe('wx-user-9')
    // The committed assistant text is returned.
    expect(reply).toBe('committed-text')
  })

  it('reuses the cached agent and trims the assistant buffer across turns', async () => {
    const assistantBySession = new Map<any, string[]>()
    const agentByUser = new Map<any, any>()
    let createCalls = 0
    const agents = {
      create: async (opts: { sessionId: any }) => {
        createCalls++
        const sessionId = opts.sessionId
        return {
          agent: {
            id: sessionId,
            session: { id: sessionId },
            followup: () => {
              const buffer = assistantBySession.get(sessionId) ?? []
              buffer.push(`turn-${buffer.length}`)
            },
            cancel: () => {},
            whenIdle: async () => {},
          },
          dispose: async () => {},
        }
      },
    }
    const ctx = { agents } as unknown as Context

    const first = await defaultSessionPrompt(ctx, agentByUser, assistantBySession, 'wx-user-9', 'one')
    const second = await defaultSessionPrompt(ctx, agentByUser, assistantBySession, 'wx-user-9', 'two')

    // Same user reuses the cached agent (single create).
    expect(createCalls).toBe(1)
    // Each turn returns only that turn's committed text...
    expect(first).toBe('turn-0')
    expect(second).toBe('turn-0')
    // ...and the buffer was trimmed back to its per-turn start, so it does not
    // accumulate across turns.
    expect(assistantBySession.get(agentByUser.get('wx-user-9')!.agent.session.id)!.length).toBe(0)
  })
})
