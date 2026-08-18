import { describe, it, expect } from 'vitest'
import { buildSubscribeFrame, parseIncoming, buildStreamReply } from './ws-protocol.ts'

describe('ws protocol', () => {
  it('builds a subscribe frame with bot_id and secret', () => {
    const f = buildSubscribeFrame('bot-1', 'sec')
    const parsed = JSON.parse(f)
    expect(parsed.cmd).toBe('aibot_subscribe')
    expect(parsed.body.bot_id).toBe('bot-1')
    expect(parsed.body.secret).toBe('sec')
    expect(parsed.headers.req_id).toBeTruthy()
  })

  it('parses a msg callback into user id and text with @prefix stripped', () => {
    const raw = JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: 'r1' }, body: { msgid: 'm1', aibotid: 'a', chatid: 'c', chattype: 'group', from: { userid: 'u42' }, msgtype: 'text', text: { content: '@bot 查一下待办' } } })
    const msg = parseIncoming(raw)
    expect(msg.userID).toBe('u42')
    expect(msg.text).toBe('查一下待办')
  })

  it('builds a stream reply frame', () => {
    const f = buildStreamReply('r1', 'reply text')
    const parsed = JSON.parse(f)
    expect(parsed.cmd).toBe('aibot_respond_msg')
    expect(parsed.headers.req_id).toBe('r1')
    expect(parsed.body.msgtype).toBe('stream')
    expect(parsed.body.stream.finish).toBe(true)
    expect(parsed.body.stream.content).toBe('reply text')
  })

  it('strips a @prefix terminated by a full-width space U+3000, then trims whitespace', () => {
    const raw = JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: 'r1' }, body: { msgid: 'm1', aibotid: 'a', chatid: 'c', chattype: 'group', from: { userid: 'u42' }, msgtype: 'text', text: { content: '@机器人\u3000 查一下待办 ' } } })
    const msg = parseIncoming(raw)
    expect(msg.text).toBe('查一下待办')
  })

  it('returns empty userID and text when the frame is not a msg callback', () => {
    const ack = JSON.stringify({ headers: { req_id: 'r1' }, errcode: 0 })
    expect(parseIncoming(ack)).toEqual({ userID: '', text: '' })
    const event = JSON.stringify({ cmd: 'aibot_event_callback', headers: { req_id: 'r1' }, body: { event: { eventtype: 'enter_chat' } } })
    expect(parseIncoming(event)).toEqual({ userID: '', text: '' })
  })

  it('returns empty userID and text for non-text or invalid frames', () => {
    const image = JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: 'r1' }, body: { msgtype: 'image', from: { userid: 'u42' } } })
    expect(parseIncoming(image)).toEqual({ userID: '', text: '' })
    expect(parseIncoming('not json')).toEqual({ userID: '', text: '' })
    expect(parseIncoming('')).toEqual({ userID: '', text: '' })
  })
})
