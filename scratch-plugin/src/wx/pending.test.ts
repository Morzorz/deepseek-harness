import { describe, it, expect, beforeEach } from 'vitest'
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
