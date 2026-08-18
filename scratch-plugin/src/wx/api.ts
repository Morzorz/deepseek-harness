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
import { findRecord, approveParams, approveSummary } from './prepare.ts'
import type { PendingApprove } from './pending.ts'
import type { WxBizRef, WxOpContext, WxOp, WxTransport } from './types.ts'

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
 * Execute an approve/reject op directly. The registry ops reference
 * `{{orderNumber}}`/`{{remarks}}`/`{{auditContent}}`/`{{account}}`; the caller
 * passes the vars through. This is a one-step direct execute; the plugin's
 * two-step flow uses wxPrepareApprove/wxConfirmApprove instead.
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

/**
 * 原样分发一次 op 请求（不做渲染），返回原始响应体。供 findRecord/approveParams
 * 的 fetcher 使用：它们需要 raw body，而非 callOp 渲染后的字符串。
 */
async function rawOp(
  ctx: WxOpContext,
  ready: ReadySession,
  ref: WxBizRef,
  op: WxOp,
  vars: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ body: string }> {
  const t = ctx.transport ?? realWxTransport
  const account = ready.account
  if (vars.account === undefined) vars.account = account
  if ((vars.memberCode === undefined || vars.memberCode === '') && opNeedsPlaceholder(op, 'memberCode')) {
    try {
      vars.memberCode = await t.getMemberCode({
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
  return t.do({ gateway: ready.gateway, hmacKey: ready.hmacKey, account, method: op.method, path, body, signal })
}

/** 列表接口拉取（findRecord 的 fetcher，返回原始响应体）。 */
async function callList(
  ready: ReadySession,
  ctx: WxOpContext,
  ref: WxBizRef,
  vars: Record<string, string>,
): Promise<{ body: string }> {
  const op = ref.biz.list
  if (!op) throw new Error(`业务 "${ref.biz.name}" 未配置列表接口`)
  return rawOp(ctx, ready, ref, op, { ...vars })
}

/** 详情接口拉取（approveParams 的 fetchDetail，解析为记录对象）。无详情接口时返回空对象。 */
async function callDetail(
  ready: ReadySession,
  ctx: WxOpContext,
  ref: WxBizRef,
  vars: Record<string, string>,
): Promise<Record<string, unknown>> {
  const op = resolveOp(ref.biz, 'detail')
  const resp = op ? await rawOp(ctx, ready, ref, op, { ...vars }) : { body: '{}' }
  const parsed = JSON.parse(resp.body) as unknown
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
  return {}
}

/** 执行一次审批写操作（wx_confirm 的 confirm 分支）。按 p.env 解析网关/密钥。 */
async function executeApprove(ctx: WxOpContext, p: PendingApprove, signal?: AbortSignal): Promise<string> {
  const e = await ctx.config.getReadyEnv(p.env ?? '')
  const ready: ReadySession = { env: p.env ?? '', account: p.account, gateway: e.gateway, hmacKey: e.hmac_key }
  return callOp(ctx, ready, p.biz, p.action, { ...p.vars }, signal)
}

/**
 * 两步审批第一步：定位单据、推导审批参数并登记待确认状态，不执行任何写操作。
 * 返回确认摘要；用户回复『确认/取消』后调用 wxConfirmApprove。
 */
export async function wxPrepareApprove(
  ctx: WxOpContext,
  opts: { biz: string; orderNumber: string; action: 'approve' | 'reject'; remarks?: string; environment?: string },
): Promise<string> {
  const ready = await readySession(ctx, opts.environment)
  const ref = await ctx.registry.resolveBiz(opts.biz)
  const rec = await findRecord(ref, opts.orderNumber, (vars) => callList(ready, ctx, ref, vars))
  if (!rec) return `未找到单号 ${opts.orderNumber} 的待办记录（可能已处理或单号有误）`
  const params = await approveParams(ref, opts.action, ready.account, opts.orderNumber, opts.remarks ?? '', rec,
    (vars) => callDetail(ready, ctx, ref, vars))
  const summary = approveSummary(ref, rec, opts.orderNumber, opts.action, opts.remarks ?? '')
  const pending = ctx.pending
  if (!pending) throw new Error('缺 pending 存储（插件未注入）')
  pending.set({
    account: ready.account, biz: opts.biz, action: opts.action, orderNumber: opts.orderNumber,
    vars: params, summary, env: ready.env,
  })
  return summary
}

/**
 * 两步审批第二步：确认执行或取消。confirm 按发起时记录的 p.env 环境执行一次写操作，
 * 失败则回写待确认状态供用户重试。
 */
export async function wxConfirmApprove(
  ctx: WxOpContext, opts: { decision: 'confirm' | 'cancel'; environment?: string },
): Promise<string> {
  const ready = await readySession(ctx, opts.environment)
  const pending = ctx.pending
  if (!pending) throw new Error('缺 pending 存储（插件未注入）')
  const p = pending.take(ready.account)
  if (!p) return '没有待确认的审批（可能已过期或已处理，请重新发起）'
  if (opts.decision !== 'confirm') return '已取消审批操作。'
  try {
    const result = await executeApprove(ctx, p)
    return `已执行${p.action === 'reject' ? '审批驳回' : '审批通过'}：\n${result}`
  } catch (e) {
    pending.rebid(p)
    throw e
  }
}
