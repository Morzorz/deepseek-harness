/**
 * wecom-bridge 的企微智能机器人 WebSocket 长连接管理器（有状态、面向连接层）。
 *
 * 构建在 ws-protocol.ts 的纯帧层之上，负责：建立连接、订阅握手（状态机）、
 * 应用层心跳、读超时（stall）检测、断线重连、消息分发与统一异常回复。
 *
 * Node 22 原生 WebSocket 没有 ping()，因此心跳使用应用层文本帧 aibot_heartbeat
 * + 读超时检测，而非 WS 控制帧 Ping。服务端 Ping 由 Node 自动回 Pong，无需实现。
 *
 * 状态机：SUBSCRIBING → SUBSCRIBED。每条新连接的第一帧必须是订阅 ack：
 *   - errcode === 0   → 进入 SUBSCRIBED，启动心跳与 stall 定时器
 *   - errcode !== 0   → 同步 close 并在 reconnectDelayMs 后重连
 * SUBSCRIBED 之后的命令 ack（回复/心跳的“命令拒绝”）一律忽略，非致命。
 *
 * 读超时（stall）：记录 lastFrameAt（每个入站帧更新），每 5s 检查一次，若
 * 距最后一帧超过 readTimeoutMs（默认 heartbeatMs+5s）则视为通道卡死，close
 * 触发重连。重连使用单一定时器（scheduleReconnect 去重，杜绝双重调度）。
 */

import { buildSubscribeFrame, parseIncoming, buildStreamReply } from './ws-protocol.ts'

/** 创建 WebSocket 的工厂。测试可注入可脚本化假对象。 */
export type WsFactory = (url: string) => Pick<WebSocket, 'send' | 'close' | 'addEventListener' | 'removeEventListener'>

export interface ConnectionOptions {
  wsURL: string
  botID: string
  secret: string
  wsFactory?: WsFactory
  onMessage: (m: { userID: string; text: string }) => Promise<string>
  reconnectDelayMs?: number // 默认 3000
  heartbeatMs?: number // 默认 30000
}

const DEFAULT_RECONNECT_DELAY_MS = 3000
const DEFAULT_HEARTBEAT_MS = 30000
const STALL_CHECK_MS = 5000

/** 订阅失败统一回复格式（命令无条件重试）。 */
const HANDLER_ERROR_PREFIX = '处理失败：'
const HANDLER_ERROR_SUFFIX = '（请稍后重试）'

type State = 'SUBSCRIBING' | 'SUBSCRIBED' | 'STOPPED'

/** 连接层最小 WebSocket 视图（与 WsFactory 返回一致）。 */
type WsLike = Pick<WebSocket, 'send' | 'close' | 'addEventListener' | 'removeEventListener'>

export class ConnectionManager {
  private readonly wsURL: string
  private readonly botID: string
  private readonly secret: string
  private readonly wsFactory: WsFactory
  private readonly onMessage: (m: { userID: string; text: string }) => Promise<string>
  private readonly reconnectDelayMs: number
  private readonly heartbeatMs: number
  private readonly readTimeoutMs: number

  private running = false
  private state: State = 'STOPPED'
  private ws: WsLike | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private stallTimer: ReturnType<typeof setInterval> | null = null
  private heartbeatSeq = 0
  private lastFrameAt = 0

  constructor(opts: ConnectionOptions) {
    this.wsURL = opts.wsURL
    this.botID = opts.botID
    this.secret = opts.secret
    this.wsFactory = opts.wsFactory ?? ((url: string) => new WebSocket(url))
    this.onMessage = opts.onMessage
    this.reconnectDelayMs = opts.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
    this.readTimeoutMs = this.heartbeatMs + STALL_CHECK_MS
  }

  /** 建立长连接（幂等：已在运行则忽略）。 */
  start(): void {
    if (this.running) return
    this.running = true
    this.state = 'SUBSCRIBING'
    this.connect()
  }

  /** 优雅关闭：停止重连与定时器并关闭当前 socket（幂等）。 */
  stop(): void {
    if (!this.running) return
    this.running = false
    this.state = 'STOPPED'
    this.clearReconnect()
    this.clearTimers()
    const ws = this.ws
    this.ws = null
    if (ws) {
      try {
        ws.close()
      } catch {
        // 关闭失败无需处理
      }
    }
  }

  isStopped(): boolean {
    return this.state === 'STOPPED'
  }

  private connect(): void {
    if (!this.running || this.state === 'STOPPED') return
    const ws = this.wsFactory(this.wsURL) as WsLike
    this.ws = ws
    this.state = 'SUBSCRIBING'
    this.lastFrameAt = Date.now()
    try {
      ws.send(buildSubscribeFrame(this.botID, this.secret))
    } catch {
      // 发送失败交给 close/error 事件重连
    }
    ws.addEventListener('message', (ev: unknown) => {
      if (this.state === 'STOPPED') return
      this.lastFrameAt = Date.now()
      const raw = this.extractData(ev)
      void this.handleFrame(raw)
    })
    ws.addEventListener('close', () => {
      if (!this.running || this.state === 'STOPPED') return
      if (this.ws !== ws) return // 陈旧连接的迟到 close，忽略
      this.clearTimers()
      this.ws = null
      this.scheduleReconnect(this.reconnectDelayMs)
    })
    ws.addEventListener('error', () => {
      if (!this.running || this.state === 'STOPPED') return
      if (this.ws !== ws) return // 陈旧连接的迟到 error，忽略
      // 触发 close 事件走正常重连路径
      try {
        ws.close()
      } catch {
        // 忽略
      }
    })
  }

  private extractData(ev: unknown): string {
    const data = (ev as { data?: unknown })?.data
    return typeof data === 'string' ? data : ''
  }

  private handleFrame(raw: string): void {
    if (this.state === 'SUBSCRIBING') {
      this.handleSubscribeFrame(raw)
      return
    }
    if (this.state !== 'SUBSCRIBED') return
    const msg = parseIncoming(raw)
    if (!msg.userID || !msg.text) return
    void this.handleMessage(msg, this.extractReqID(raw))
  }

  /** 处理订阅 ack：errcode 决定进入 SUBSCRIBED 或 同步关闭重连。 */
  private handleSubscribeFrame(raw: string): void {
    const errcode = this.readErrCode(raw)
    if (errcode !== 0) {
      this.rejectSubscribe()
      return
    }
    this.state = 'SUBSCRIBED'
    this.startTimers()
  }

  private rejectSubscribe(): void {
    // 先安排重连（订阅拒绝也要重连），随后同步 close。
    this.scheduleReconnect(this.reconnectDelayMs)
    const ws = this.ws
    if (ws) {
      try {
        ws.close()
      } catch {
        // 忽略
      }
    }
  }

  private startTimers(): void {
    this.clearTimers()
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.heartbeatMs)
    this.stallTimer = setInterval(() => this.checkStall(), STALL_CHECK_MS)
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.stallTimer) {
      clearInterval(this.stallTimer)
      this.stallTimer = null
    }
  }

  /** 应用层心跳帧（收到“命令拒绝”ack 时忽略，非致命）。 */
  private sendHeartbeat(): void {
    if (this.state !== 'SUBSCRIBED' || !this.ws) return
    try {
      this.ws.send(
        JSON.stringify({ cmd: 'aibot_heartbeat', headers: { req_id: `hb-${++this.heartbeatSeq}` } }),
      )
    } catch {
      // 发送失败忽略
    }
  }

  /** 读超时检测：距最后一帧超过 readTimeoutMs 视为 stall，关断并立即重连。 */
  private checkStall(): void {
    if (this.state !== 'SUBSCRIBED' || !this.ws) return
    if (Date.now() - this.lastFrameAt >= this.readTimeoutMs) {
      const ws = this.ws
      try {
        ws.close()
      } catch {
        // 忽略
      }
      // onclose 会按 3s 排一次重连；stall 需尽快恢复，清掉后立即重连。
      this.clearReconnect()
      this.connect()
    }
  }

  private async handleMessage(msg: { userID: string; text: string }, reqID: string): Promise<void> {
    let reply: string
    try {
      reply = await this.onMessage(msg)
    } catch (e) {
      reply = `${HANDLER_ERROR_PREFIX}${(e as Error).message}${HANDLER_ERROR_SUFFIX}`
    }
    if (this.state !== 'SUBSCRIBED' || !this.ws) return
    try {
      this.ws.send(buildStreamReply(reqID, reply))
    } catch {
      // 发送失败忽略
    }
  }

  private scheduleReconnect(delay: number): void {
    if (!this.running || this.state === 'STOPPED') return
    if (this.reconnectTimer) return // 已有待执行重连，保持单一调度
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private readErrCode(raw: string): number {
    try {
      const f = JSON.parse(raw) as { errcode?: unknown }
      if (typeof f.errcode === 'number') return f.errcode
      return -1
    } catch {
      return -1
    }
  }

  private extractReqID(raw: string): string {
    try {
      const f = JSON.parse(raw) as { headers?: { req_id?: unknown } }
      return typeof f.headers?.req_id === 'string' ? f.headers.req_id : ''
    } catch {
      return ''
    }
  }
}
