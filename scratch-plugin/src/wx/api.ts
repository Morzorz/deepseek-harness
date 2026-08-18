/**
 * High-level WeCom approval operations, ported from the Go `wx-cli` + `wx-agent`
 * (`bin/internal/biz/biz.go`, `bin/internal/client/client.go`,
 * `bin/internal/agent/executor.go`).
 *
 * These functions are transport-agnostic and take an optional AbortSignal so a
 * tool executes can honour `exec.signal`. They return a Chinese rendered text
 * value (already model-facing) and throw Chinese errors for the tool to wrap.
 */

import { wxHttpDo, wxGetMemberCode } from './client.ts'
import { buildBody, buildQuery, opNeedsPlaceholder, opNames, resolveOp } from './registry.ts'
import { renderResponse } from './render.ts'
import type { WxOpContext, WxTransport } from './types.ts'

export type { WxOpContext } from './types.ts'

/** Default transport backed by real HTTP. */
export const realWxTransport: WxTransport = {
  async do(o) {
    return wxHttpDo(o)
  },
  async getMemberCode(o) {
    return wxGetMemberCode(o)
  },
}

/** The resolved identity + env for one operation. */
interface ReadySession {
  env: string
  account: string
  gateway: string
  hmacKey: string
}

async function readySession(ctx: WxOpContext, env: string | undefined, signal?: AbortSignal): Promise<ReadySession> {
  const envName = env || ctx.defaultEnv || 'test'
  const e = await ctx.config.getReadyEnv(envName)
  if (signal?.aborted) {
    const err = new Error('aborted before dispatch')
    err.name = 'AbortError'
    throw err
  }
  const account = ctx.account ?? ctx.defaultAccount ?? ''
  if (!account) throw new Error('缺少当前用户身份（插件未注入 account，请设置 defaultAccount 或经 wecom-bridge 注入）')
  return { env: envName, gateway: e.gateway, hmacKey: e.hmac_key, account }
}

function callOp(
  ctx: WxOpContext,
  ready: ReadySession,
  bizRef: string,
  opName: string,
  vars: Record<string, string>,
  signal?: AbortSignal,
): Promise<string> {
  return (async () => {
    const ref = await ctx.registry.resolveBiz(bizRef)
    const op = resolveOp(ref.biz, opName)
    if (!op) {
      throw new Error(
        `业务 "${ref.system}-${ref.biz.name}" 未配置操作 "${opName}"（可用: ${opNames(ref.biz).join(', ')}）`,
      )
    }
    const account = ready.account
    if (vars.account === undefined) vars.account = account
    if ((vars.memberCode === undefined || vars.memberCode === '') && opNeedsPlaceholder(op, 'memberCode')) {
      try {
        vars.memberCode = await (ctx.transport ?? realWxTransport).getMemberCode({
          gateway: ready.gateway,
          hmacKey: ready.hmacKey,
          account,
          signal,
        })
      } catch (e) {
        throw new Error(`自动获取当前用户 memberCode 失败: ${messageOf(e)}`)
      }
    }
    const body = buildBody(op, vars)
    const path = op.path + buildQuery(op, vars)
    const { body: resp } = await (ctx.transport ?? realWxTransport).do({
      gateway: ready.gateway,
      hmacKey: ready.hmacKey,
      account,
      method: op.method,
      path,
      body,
      signal,
    })
    return renderResponse(resp, op.response)
  })()
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** List available systems + biz keys. */
export async function wxQueryBiz(ctx: WxOpContext, opts: { signal?: AbortSignal } = {}): Promise<string> {
  return ctx.registry.listBiz()
}

/** Query a todo/done list. `status` default empty -> 待办; `op` selects alternative lists. */
export async function wxQueryTodo(
  ctx: WxOpContext,
  opts: {
    biz: string
    status?: string
    op?: string
    environment?: string
    signal?: AbortSignal
  },
): Promise<string> {
  const ready = await readySession(ctx, opts.environment, opts.signal)
  const vars: Record<string, string> = {}
  if (opts.status) vars.status = opts.status
  const opName = opts.op || 'list'
  return callOp(ctx, ready, opts.biz, opName, vars, opts.signal)
}

/** Query a document detail (detail op or a named op), passing arbitrary query vars. */
export async function wxQueryDetail(
  ctx: WxOpContext,
  opts: {
    biz: string
    op?: string
    vars: Record<string, string>
    environment?: string
    signal?: AbortSignal
  },
): Promise<string> {
  const ready = await readySession(ctx, opts.environment, opts.signal)
  const opName = opts.op || 'detail'
  return callOp(ctx, ready, opts.biz, opName, { ...opts.vars }, opts.signal)
}

/**
 * Execute an approve/reject op. The registry ops reference
 * `{{orderNumber}}`/`{{remarks}}`/`{{auditContent}}`/`{{account}}`; the plugin
 * passes the caller's vars through. The approval gate before this call is the
 * plugin's responsibility (dsh `ctx.approval`).
 * @returns the rendered gateway result text.
 */
export async function wxExecuteApprove(
  ctx: WxOpContext,
  opts: {
    biz: string
    action: string
    vars: Record<string, string>
    environment?: string
    signal?: AbortSignal
  },
): Promise<string> {
  const ready = await readySession(ctx, opts.environment, opts.signal)
  const vars = { ...opts.vars }
  // Map the tool-facing action to the registry op name (approve/reject).
  const opName = opts.action
  return callOp(ctx, ready, opts.biz, opName, vars, opts.signal)
}
