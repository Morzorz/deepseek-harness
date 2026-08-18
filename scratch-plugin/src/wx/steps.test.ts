import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { wxPrepareApprove, wxConfirmApprove } from './api.ts'
import { WxConfig } from './config.ts'
import { WxRegistry } from './registry.ts'
import { PendingStore } from './pending.ts'

describe('two-step approval flow', () => {
  const saved = new Map<string, string | undefined>()
  let calls: string[] = []           // 记录每次 transport.do 的路径
  let ctx: any

  // 列表接口的响应体：data.page.data.data 结构的记录数组
  const listBody = JSON.stringify({
    data: { page: { data: { data: [{ orderNumber: 'PR999', applyName: '项目X', applyNo: 'PR999' }], total: 1 } } },
  })
  const okBody = JSON.stringify({ data: { ok: true } })

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
          calls.push(o.path)
          const isList = o.path.includes('queryWorkflowInformation')  // 采购列表接口
          return { body: isList ? listBody : okBody }
        },
        async getMemberCode() { return 'M1001' },
      },
    }
  })

  afterEach(() => {
    for (const [k, v] of saved) if (v === undefined) delete process.env[k]; else process.env[k] = v
  })

  it('approve stores pending and performs no write call (list reads are allowed)', async () => {
    await wxPrepareApprove(ctx, { biz: 'purchase.generay', orderNumber: 'PR999', action: 'approve' })
    expect(calls.some((p) => p.includes('getAdopt'))).toBe(false)  // 无审批写调用
    expect(ctx.pending.get('u1')).toBeDefined()
  })

  it('confirm executes the write exactly once', async () => {
    await wxPrepareApprove(ctx, { biz: 'purchase.generay', orderNumber: 'PR999', action: 'approve' })
    const writesBefore = calls.filter((p) => p.includes('getAdopt')).length
    const out = await wxConfirmApprove(ctx, { decision: 'confirm' })
    expect(calls.filter((p) => p.includes('getAdopt')).length).toBe(writesBefore + 1)
    expect(out).toContain('ok')
    expect(ctx.pending.get('u1')).toBeUndefined()   // 取出即删
  })

  it('cancel clears pending without executing a write', async () => {
    await wxPrepareApprove(ctx, { biz: 'purchase.generay', orderNumber: 'PR999', action: 'approve' })
    const writesBefore = calls.filter((p) => p.includes('getAdopt')).length
    const out = await wxConfirmApprove(ctx, { decision: 'cancel' })
    expect(calls.filter((p) => p.includes('getAdopt')).length).toBe(writesBefore)  // 无新增写调用
    expect(out).toContain('取消')
    expect(ctx.pending.get('u1')).toBeUndefined()
  })

  it('confirm without pending returns a hint', async () => {
    const out = await wxConfirmApprove(ctx, { decision: 'confirm' })
    expect(out).toContain('没有待确认的审批')
  })

  it('rebids pending when execution fails so the user can retry', async () => {
    const realDo = ctx.transport.do
    ctx.transport.do = async (o: { path: string }) => {
      if (!o.path.includes('queryWorkflowInformation')) throw new Error('网关 500')
      return { body: listBody }
    }
    await wxPrepareApprove(ctx, { biz: 'purchase.generay', orderNumber: 'PR999', action: 'approve' })
    await expect(wxConfirmApprove(ctx, { decision: 'confirm' })).rejects.toThrow(/500/)
    expect(ctx.pending.get('u1')).toBeDefined()   // 失败回写可重试
    ctx.transport.do = realDo
  })
})
