/**
 * wecom-bridge 的 per-user 串行会话路由器。
 *
 * 按 userID 把消息路由到 agent 会话：同一用户的消息串行执行（前一条完成后
 * 才处理下一条），不同用户之间互不阻塞、自然并行。provider.prompt 的失败不会
 * 污染该用户的后续消息——存储的链尾 catch 掉错误后继续，而调用方仍能看到真实
 * 的拒绝（见 handle 的链尾处理说明）。
 */

/** 提供者：把一条用户消息交给 agent 会话并返回最终回复文本。 */
export interface AgentSessionProvider {
  prompt(userID: string, text: string, signal?: AbortSignal): Promise<string>
}

type Chain = Promise<unknown>

/** 按 userID 路由消息：同一用户串行、不同用户并行。 */
export class Router {
  private chains = new Map<string, Chain>()

  constructor(private readonly provider: AgentSessionProvider) {}

  /** 处理一条消息，返回回复文本 promise（由调用方发送）。 */
  handle(input: { userID: string; text: string }): Promise<string> {
    const prev = this.chains.get(input.userID) ?? Promise.resolve()
    const run = prev.then(() => this.provider.prompt(input.userID, input.text))
    // 链尾 catch 掉错误并落库，使同一用户的下一条消息仍能继续；同时避免未处理拒绝。
    const tail = run.catch(() => undefined)
    this.chains.set(input.userID, tail)
    return run
  }
}
