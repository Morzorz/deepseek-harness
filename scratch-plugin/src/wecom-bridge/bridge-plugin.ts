/**
 * wecom-bridge 插件入口：把企微智能机器人 WebSocket 消息驱动为 DSH agent 会话。
 *
 * 职责接线（Task 3.4）：
 *   - ConnectionManager（连接层）收到消息 → Router（per-user 串行路由）→
 *     AgentSessionProvider.prompt。默认 provider 通过 `ctx.agents` 为每个
 *     userID 创建/复用 1:1 的 DSH agent 会话，发送用户消息、等待 agent
 *     whenIdle（整 agent 静止）、收集本轮提交的 assistant 文本作为回复。
 *   - 把「agentId → userID」发布到共享模块 userByAgentId，供 wx-plugin 的工具
 *     调用据此解析当前 agent 的 account（注入 WxOpContext.account）。
 *
 * 若既未注入 agentProvider 也没有 `ctx.agents`，则抛清晰的配置错误——默认路径
 * 依赖注入的 agents 服务（inject: ['agents']）。
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { ConnectionManager, type WsFactory } from './connection.ts'
import { Router, type AgentSessionProvider } from './session-router.ts'
import { userByAgentId } from './agent-accounts.ts'

/** 企微智能机器人 WebSocket 默认网关地址。 */
export const DefaultWSURL = 'wss://openws.work.weixin.qq.com'

/** 把一条用户消息交给 agent 并返回最终回复文本。 */
export type AgentProvider = (userID: string, text: string, signal?: AbortSignal) => Promise<string>

export interface BridgeConfig {
  /** WebSocket 网关地址；缺省用 {@link DefaultWSURL}。 */
  wsURL?: string
  botID: string
  secret: string
  /** 注入的会话提供者；缺省走 `ctx.agents` 创建/复用 DSH agent 会话。 */
  agentProvider?: AgentProvider
  /** 是否自动 start 连接；缺省 true。测试注入假 wsFactory 且 autoStart:false 时不拨号。 */
  autoStart?: boolean
  wsFactory?: WsFactory
}

export const name = 'wecom-bridge'
export const inject = ['agents']

function assertAgentsAvailable(agents: unknown): asserts agents is Context['agents'] {
  if (!agents) {
    throw new Error(
      'wecom-bridge: 未注入 agentProvider，且 ctx.agents 不可用（未加载 agent-loop 插件）。' +
        '请注入 agentProvider 或确保 ctx.agents 已注册。',
    )
  }
}

/**
 * 默认会话提供者：按 userID 缓存 1:1 的 agent 会话，发送用户消息，等待整
 * agent 静止，收集本轮提交的 assistant 文本并返回（对照 ACP bridge 的
 * create → followup → whenIdle → 收集 assistant/message 机制）。
 */
function defaultSessionPrompt(
  ctx: Context,
  agentByUser: Map<string, AgentHandle>,
  assistantBySession: Map<SessionId, string[]>,
  userID: string,
  text: string,
  signal?: AbortSignal,
): Promise<string> {
  assertAgentsAvailable(ctx.agents)
  return (async () => {
    let handle = agentByUser.get(userID)
    if (!handle) {
      handle = await ctx.agents.create({
        sessionId: SessionId(randomUUID()),
        meta: { cwd: process.cwd() },
        signal,
      })
      agentByUser.set(userID, handle)
      userByAgentId.set(handle.agent.id, userID)
    }
    const agent = handle.agent
    const sessionId = agent.session.id
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    // 记录本轮起点：collector 会把该 agent 会话之后的 committed 文本追加到同一数组。
    const buffer = assistantBySession.get(sessionId) ?? []
    assistantBySession.set(sessionId, buffer)
    const start = buffer.length
    agent.followup(message)
    const abort = () => agent.cancel({ kind: 'user' })
    signal?.addEventListener('abort', abort, { once: true })
    try {
      await agent.whenIdle()
    } finally {
      signal?.removeEventListener('abort', abort)
    }
    return buffer.slice(start).join('')
  })()
}

export function apply(ctx: Context, cfg: BridgeConfig): void {
  const agentByUser = new Map<string, AgentHandle>()
  // 每 session 已提交的 assistant 文本块（collector 维护；defaultSessionPrompt 读增量）。
  const assistantBySession = new Map<SessionId, string[]>()
  ctx.on('session/event', (session, event: SessionEvent) => {
    if (event.type !== 'assistant/message') return
    const list = assistantBySession.get(session.header.id)
    if (!list) return
    for (const block of event.data.message.content) {
      if (block.type === 'text' && block.text.length > 0) list.push(block.text)
    }
  })

  // Router 调用 provider.prompt(...)；没有 agentProvider 时走默认 ctx.agents 路径。
  const provider: AgentSessionProvider = cfg.agentProvider
    ? { prompt: (userID, text, signal) => cfg.agentProvider!(userID, text, signal) }
    : { prompt: (userID, text, signal) => defaultSessionPrompt(ctx, agentByUser, assistantBySession, userID, text, signal) }

  const router = new Router(provider)
  const conn = new ConnectionManager({
    wsURL: cfg.wsURL ?? DefaultWSURL,
    botID: cfg.botID,
    secret: cfg.secret,
    wsFactory: cfg.wsFactory,
    onMessage: (m) => router.handle(m),
  })

  if (cfg.autoStart !== false) conn.start()

  // ACP 模式：effect 注册一个返回 disposer 函数的闭包；dispose 时先停连接再拆 handle。
  const teardown = (): Promise<void> => {
    conn.stop()
    for (const handle of agentByUser.values()) userByAgentId.delete(handle.agent.id)
    return Promise.allSettled([...agentByUser.values()].map((handle) => handle.dispose())).then(() => undefined)
  }
  ctx.effect(() => teardown, 'wecom-bridge.connection')
}
