import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply as applyWxPlugin, resolveAccount } from './src/wx-plugin.ts'
import { WxRegistry, buildBody, buildQuery, replacePlaceholders, opNeedsPlaceholder } from './src/wx/registry.ts'
import { hmacSignature, buildHmacHeaders } from './src/wx/hmac.ts'
import { renderResponse } from './src/wx/render.ts'

describe('wx adapter layer', () => {
  describe('hmac', () => {
    it('produces a 44-char base64 signature deterministically', () => {
      const sig = hmacSignature('acct', '1234', 'nonce', 'key')
      expect(sig).toMatch(/^[A-Za-z0-9+/]+=*$/)
      // Same inputs -> same signature (HMAC is deterministic).
      expect(hmacSignature('acct', '1234', 'nonce', 'key')).toBe(sig)
      // Changing any part changes it.
      expect(hmacSignature('acct', '1235', 'nonce', 'key')).not.toBe(sig)
    })

    it('builds the expected header set', () => {
      const h = buildHmacHeaders('acct', 'key', '1000')
      expect(h['X-Account']).toBe('acct')
      expect(h['X-Timestamp']).toBe('1000')
      expect(h['X-Signature']).toBeTruthy()
      expect(h['Content-Type']).toBe('application/json')
    })
  })

  describe('registry', () => {
    let reg: WxRegistry
    beforeAll(async () => {
      reg = await WxRegistry.load()
    })

    it('resolves system-name -> first biz', async () => {
      const ref = await reg.resolveBiz('purchase')
      expect(ref.system).toBe('purchase')
      expect(ref.bizKey).toBeTruthy()
    })

    it('resolves sys.biz dot form', async () => {
      const ref = await reg.resolveBiz('purchase.generay')
      expect(ref.system).toBe('purchase')
      expect(ref.bizKey).toBe('generay')
    })

    it('resolves a global unique biz key', async () => {
      const ref = await reg.resolveBiz('generay')
      expect(ref.system).toBe('purchase')
    })

    it('throws on unknown biz', async () => {
      await expect(reg.resolveBiz('does-not-exist')).rejects.toThrow()
    })

    it('lists systems', async () => {
      const text = await reg.listBiz()
      expect(text).toContain('采购系统')
      expect(text).toContain('采购系统')
    })
  })

  describe('request builders', () => {
    it('substitutes placeholders and JSON-encodes string values', () => {
      expect(replacePlaceholders('{{a}}', { a: '1' })).toBe('1')
      expect(replacePlaceholders('{{a|default}}', {})).toBe('default')
    })

    it('buildBody reproduces the Go JSON encoding (numbers raw, strings quoted)', () => {
      const body = buildBody(
        { path: '/x', method: 'POST', requestBody: { current: '1', account: '{{account}}', quoted: '"10"' } },
        { account: 'yang' },
      )
      expect(JSON.parse(body)).toEqual({ current: 1, account: 'yang', quoted: '10' })
    })

    it('buildQuery appends only non-empty vars', () => {
      const q = buildQuery({ path: '/x', method: 'POST', requestQuery: { a: '{{a}}', b: '{{b}}' } }, { a: '1' })
      expect(q).toBe('?a=1')
    })

    it('opNeedsPlaceholder detects memberCode references', () => {
      const op = { path: '/x', method: 'POST', requestBody: { a: '{{memberCode}}' } }
      expect(opNeedsPlaceholder(op, 'memberCode')).toBe(true)
      expect(opNeedsPlaceholder({ path: '/x', method: 'POST' }, 'memberCode')).toBe(false)
    })
  })

  describe('render', () => {
    it('renders a list with Chinese labels', () => {
      const raw = JSON.stringify({ data: { page: { data: { data: [{ orderNumber: 'PR1', entryName: '项目' }], total: 1 } } } })
      const out = renderResponse(raw, {
        path: 'data.page.data',
        totalField: 'total',
        listField: 'data',
        fields: { orderNumber: '申请单号', entryName: '项目名称' },
      })
      expect(out).toContain('共 1 条')
      expect(out).toContain('申请单号: PR1')
    })

    it('falls back to pretty JSON on parse failure', () => {
      expect(renderResponse('not json')).toBe('not json')
    })
  })
})

describe('resolveAccount (agentId→userID injection)', () => {
  it('prefers the bridge lookup, then defaultAccount, then empty', () => {
    const lookup = (id: string) => (id === 'agent-1' ? 'wx-user-9' : undefined)
    expect(resolveAccount({ id: 'agent-1' }, lookup, 'dev')).toBe('wx-user-9')
    expect(resolveAccount({ id: 'agent-nope' }, lookup, 'dev')).toBe('dev')
    expect(resolveAccount({ id: 'agent-nope' }, lookup)).toBe('')
  })
})

describe('wx plugin registration', () => {
  let ctx: Context
  let disposers: Array<() => unknown> = []

  beforeAll(async () => {
    ctx = new Context()
    // ToolRuntime injects systemPrompt; a fake that satisfies section()/tools()/
    // context()/variable()/assemble() is enough for registration.
    ctx.provide('systemPrompt', {
      section: () => () => {},
      context: () => () => {},
      tools: () => () => {},
      variable: () => () => {},
      suppressRuntimeContext: () => () => {},
      assemble: async () => ({ sections: [], contexts: [], tools: [], variables: {} }),
    } as never)
    const t = await ctx.plugin(ToolRuntime)
    disposers = [() => t.dispose()]
    applyWxPlugin(ctx, { defaultEnv: 'test', defaultAccount: 'test-account' })
  })

  afterAll(async () => {
    for (const d of disposers) await d()
  })

  it('registers the five wx tools', () => {
    const names = ctx.tools.schemas().map((t) => t.name)
    expect(names).toContain('wx_query_biz')
    expect(names).toContain('wx_query_todo')
    expect(names).toContain('wx_query_detail')
    expect(names).toContain('wx_approve')
    expect(names).toContain('wx_confirm')
  })

  it('wx_query_biz returns the system list', async () => {
    const out = await ctx.tools.get('wx_query_biz')!.execute({}, { signal: new AbortController().signal } as never)
    expect(String(out)).toContain('采购系统')
  })
})
