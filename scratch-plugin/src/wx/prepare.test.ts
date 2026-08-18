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
    expect(vars.orderNumber).toBe('BNO123')
    expect(vars.action).toBe('1')   // approve -> 1；reject 分支应为 '2'
  })

  it('builds an approval summary with order no, name and action', () => {
    const ref: WxBizRef = { system: 'purchase', bizKey: 'generay', biz: { name: '普通采购' }, sys: { name: '采购系统', bizs: {} } }
    const summary = approveSummary(ref, { orderNumber: 'PR999', applyName: '项目X' }, 'PR999', 'approve', '')
    expect(summary).toContain('PR999')
    expect(summary).toContain('审批通过')
    expect(summary).toContain('确认')
  })
})
