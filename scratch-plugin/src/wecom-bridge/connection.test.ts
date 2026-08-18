import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ConnectionManager } from './connection.ts'

/** 可脚本化假 WebSocket。 */
class FakeWS {
  sent: string[] = []
  handlers = new Map<string, (ev: any) => void>()
  closed = false
  send(d: string) { this.sent.push(d) }
  close() { this.closed = true; const cb = this.handlers.get('close'); if (cb) cb({}) }
  addEventListener(ev: string, cb: any) { this.handlers.set(ev, cb) }
  emit(event: string, data: string) { const cb = this.handlers.get(event); if (cb) cb({ data }) }
}

async function flush(): Promise<void> { await Promise.resolve(); await Promise.resolve() }

describe('ConnectionManager', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function setup(handlers: { onMessage?: (m: any) => Promise<string> } = {}) {
    const sockets: FakeWS[] = []
    const conn = new ConnectionManager({
      wsURL: 'ws://fake', botID: 'b1', secret: 's1',
      wsFactory: () => { const s = new FakeWS(); sockets.push(s); return s as any },
      onMessage: handlers.onMessage ?? (async (m: any) => `reply:${m.text}`),
    })
    return { conn, sockets }
  }

  it('subscribes, dispatches callbacks and replies', async () => {
    const { conn, sockets } = setup()
    conn.start()
    const ws = sockets[0]!
    expect(ws.sent[0]).toContain('aibot_subscribe')
    ws.emit('message', JSON.stringify({ errcode: 0, errmsg: 'ok', headers: { req_id: '' } }))
    ws.emit('message', JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: 'r' }, body: { from: { userid: 'u1' }, msgtype: 'text', text: { content: 'hi' } } }))
    await flush()
    expect(ws.sent.some((s) => s.includes('aibot_respond_msg'))).toBe(true)
    conn.stop()
  })

  it('rejects a subscription with errcode != 0 and reconnects after 3s', () => {
    const { conn, sockets } = setup()
    conn.start()
    const ws = sockets[0]!
    ws.emit('message', JSON.stringify({ errcode: 40001, errmsg: 'bad secret', headers: { req_id: '' } }))
    expect(ws.closed || conn.isStopped()).toBe(true)
    vi.advanceTimersByTime(3001)
    expect(sockets.length).toBeGreaterThanOrEqual(2)
    conn.stop()
  })

  it('responds with an error text when the handler fails', async () => {
    const { conn, sockets } = setup({ onMessage: async () => { throw new Error('网关超时') } })
    conn.start()
    const ws = sockets[0]!
    ws.emit('message', JSON.stringify({ errcode: 0, errmsg: 'ok', headers: { req_id: '' } }))
    ws.emit('message', JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: 'r' }, body: { from: { userid: 'u1' }, msgtype: 'text', text: { content: 'hi' } } }))
    await flush()
    expect(ws.sent.some((s) => s.includes('网关超时'))).toBe(true)
    conn.stop()
  })

  it('sends an app-level heartbeat frame every heartbeatMs after subscribing', () => {
    const { conn, sockets } = setup()
    conn.start()
    const ws = sockets[0]!
    ws.emit('message', JSON.stringify({ errcode: 0, errmsg: 'ok', headers: { req_id: '' } }))
    vi.advanceTimersByTime(30_000)   // heartbeatMs 默认 30000
    expect(ws.sent.some((s) => s.includes('aibot_heartbeat'))).toBe(true)
    conn.stop()
  })

  it('closes and reconnects a stalled connection (read-timeout)', () => {
    const { conn, sockets } = setup()
    conn.start()
    const ws = sockets[0]!
    ws.emit('message', JSON.stringify({ errcode: 0, errmsg: 'ok', headers: { req_id: '' } }))
    vi.advanceTimersByTime(35_000)
    expect(sockets.length).toBeGreaterThanOrEqual(2)
    conn.stop()
  })
})
