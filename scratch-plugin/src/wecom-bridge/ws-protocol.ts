/**
 * wecom-bridge 的企微智能机器人 WebSocket 协议帧层（无网络、无状态）。
 *
 * 纯函数式构造/解析内置长连接协议的 JSON 帧（cmd + headers.req_id + body），
 * 与 Go 参考实现 internal/wecom/longconn.go 的帧格式保持一致：
 *   - aibot_subscribe        订阅
 *   - aibot_msg_callback     收到文本消息回调
 *   - aibot_respond_msg      流式消息回复
 */

/** 生成请求唯一标识（对应 Go reqID），如 `sub-<纳秒时间戳>`。 */
function reqID(prefix: string): string {
  const [sec, nano] = process.hrtime()
  return `${prefix}-${Date.now() * 1000000 + sec * 1000000000 + nano}`
}

/**
 * 构造订阅帧 aibot_subscribe，返回 JSON 字符串。
 * @param botID  机器人 bot_id
 * @param secret 机器人 secret
 * @returns `{ cmd, headers: { req_id }, body: { bot_id, secret } }` 的 JSON
 */
export function buildSubscribeFrame(botID: string, secret: string): string {
  return JSON.stringify({
    cmd: 'aibot_subscribe',
    headers: { req_id: reqID('sub') },
    body: { bot_id: botID, secret },
  })
}

/** 解析后的入站消息。 */
export interface ParsedIncoming {
  /** 发送者 userid；非 aibot_msg_callback 文本帧时为空字符串 */
  userID: string
  /** 去除群聊 @机器人 前缀后的文本；非 aibot_msg_callback 文本帧时为空字符串 */
  text: string
}

/**
 * 解析一条服务端入站帧。
 *
 * 仅处理 `aibot_msg_callback` 的文本消息（msgtype === 'text'）：返回发送者
 * userID 与去除群聊 @机器人 前缀后的文本。群聊前缀（findAtPrefix）为开头的
 * `@xxx `（到下个空格或全角空格 U+3000 为止），随后整体做 whitespace 与
 * 全角空格修剪（trimSpace），与 Go 的 trimAtPrefix 一致。
 *
 * 非 aibot_msg_callback、非文本、或不可解析的帧一律返回 `{ userID: '', text: '' }`。
 * @param raw 服务端原始 JSON 帧字符串
 * @returns 发送者与修正后的文本；非消息回调时两者均为空字符串
 */
export function parseIncoming(raw: string): ParsedIncoming {
  if (!raw) {
    return { userID: '', text: '' }
  }
  let frame: {
    cmd?: string
    body?: { from?: { userid?: string }; msgtype?: string; text?: { content?: string } }
  }
  try {
    frame = JSON.parse(raw)
  } catch {
    return { userID: '', text: '' }
  }
  if (frame?.cmd !== 'aibot_msg_callback') {
    return { userID: '', text: '' }
  }
  const body = frame.body
  if (!body || body.msgtype !== 'text') {
    return { userID: '', text: '' }
  }
  const text = trimAtPrefix(body.text?.content ?? '')
  return { userID: body.from?.userid ?? '', text }
}

/**
 * 构造流式消息回复帧 aibot_respond_msg，返回 JSON 字符串。
 * 对应 Go buildStreamBody + sendCmdRaw：一次发送 finish=true 标识结束展示。
 * @param reqID   关联的请求 req_id（同时作为流式消息 id）
 * @param content 回复文本
 * @returns `{ cmd, headers: { req_id }, body: { msgtype, stream: { id, finish, content } } }` 的 JSON
 */
export function buildStreamReply(reqID: string, content: string): string {
  return JSON.stringify({
    cmd: 'aibot_respond_msg',
    headers: { req_id: reqID },
    body: {
      msgtype: 'stream',
      stream: { id: reqID, finish: true, content },
    },
  })
}

/** 去除群聊消息中的 `@机器人 ` 前缀（对应 Go trimAtPrefix）。 */
function trimAtPrefix(s: string): string {
  const i = findAtPrefix(s)
  return trimSpace(i >= 0 ? s.slice(i) : s)
}

/** 找到开头 `@xxx` 之后第一个空格/全角空格 U+3000 的下一个索引；无前缀则 -1。 */
function findAtPrefix(s: string): number {
  if (s.length === 0 || s[0] !== '@') {
    return -1
  }
  for (let i = 1; i < s.length; i++) {
    if (s[i] === ' ') {
      return i + 1
    }
    // 全角空格 U+3000
    if (s[i] === '\u3000') {
      return i + 1
    }
  }
  return -1
}

/** 修剪两端空白（含全角空格 U+3000），对应 Go trimSpace。 */
function trimSpace(s: string): string {
  return s.trim().replace(/^[\u3000]+|[\u3000]+$/g, '')
}
