import { describe, it, expect } from 'vitest'
import { Router } from './session-router.ts'

describe('Router', () => {
  it('routes by userID and serializes per user', async () => {
    const order: string[] = []
    const provider = {
      async prompt(user: string, text: string) {
        order.push(`${user}:${text}`)
        await new Promise((r) => setTimeout(r, 10))
        return `reply-${user}`
      },
    }
    const r = new Router(provider as any)
    const a = r.handle({ userID: 'u1', text: 'm1' })
    const b = r.handle({ userID: 'u1', text: 'm2' })
    const c = r.handle({ userID: 'u2', text: 'm3' })
    const [ra, rb, rc] = await Promise.all([a, b, c])
    expect(ra).toBe('reply-u1')
    expect(rb).toBe('reply-u1')
    expect(rc).toBe('reply-u2')
    // u1 串行：u1 的两条消息按到达顺序处理。
    expect(order.filter((o) => o.startsWith('u1'))).toEqual(['u1:m1', 'u1:m2'])
    // u2 并行：不受 u1 串行队列阻塞（在 u1 的第二条消息之前就开始）。
    expect(order.indexOf('u2:m3')).toBeLessThan(order.indexOf('u1:m2'))
  })

  it('lets the next message proceed after a prior one rejects (no unhandled rejection)', async () => {
    const calls: string[] = []
    const provider = {
      async prompt(user: string, text: string) {
        calls.push(`${user}:${text}`)
        if (text === 'boom') throw new Error('boom')
        return `reply-${text}`
      },
    }
    const r = new Router(provider as any)
    const first = r.handle({ userID: 'u1', text: 'boom' })
    const second = r.handle({ userID: 'u1', text: 'ok' })
    await expect(first).rejects.toThrow('boom')
    await expect(second).resolves.toBe('reply-ok')
    expect(calls).toEqual(['u1:boom', 'u1:ok'])
  })
})
