/**
 * 同一轮审批守卫：防止模型在发起审批的同一用户轮内立刻确认，强制用户下一条消息
 * 单独确认。按 agentId + turn 判定；两阶段必须跨轮（用于引入真正的两步确认）。
 */
export class SameTurnGuard {
  private last = new Map<string, number>()
  constructor(private readonly getTurn: (agentId: string) => number) {}
  recordApprove(agentId: string): void { this.last.set(agentId, this.getTurn(agentId)) }
  isSameTurn(agentId: string): boolean { return this.last.get(agentId) === this.getTurn(agentId) }
}
