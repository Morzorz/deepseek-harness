export interface PendingApprove {
  account: string
  biz: string
  action: 'approve' | 'reject'
  orderNumber: string
  vars: Record<string, string>
  summary: string
  /** 过期时间戳；缺省由 set() 按 ttlMs 派生。 */
  expireAt?: number
  /** 发起 approve 时的环境（confirm 按此环境执行，Task 2.3 添加，可选）。 */
  env?: string
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
