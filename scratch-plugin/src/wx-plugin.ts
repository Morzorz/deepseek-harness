/**
 * WeCom (企业微信) approval tool plugin for DeepSeek Harness.
 *
 * Registers five model-facing tools on `ctx.tools`:
 *   - wx_query_biz    : list available systems/biz keys
 *   - wx_query_todo   : todo / done list for a biz
 *   - wx_query_detail : document detail for a biz
 *   - wx_approve      : 两阶段审批第一步——定位单据、推导参数并登记待确认状态，
 *                     不执行写操作，返回确认摘要
 *   - wx_confirm      : 两阶段审批第二步——用户明确回复「确认/取消」时执行或放弃
 *
 * Login is reused from the Go `wx-cli` session (~/.wx-cli/<env>.json); the human
 * runs `bin/wx-cli login --env X` to scan the QR. No QR UI is implemented here.
 *
 * Approval is a dialog two-step flow: wx_approve never writes; the model must
 * surface the summary and call wx_confirm only on the user's explicit next
 * message. A SameTurnGuard rejects confirm in the same user turn as approve.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { WxConfig } from './wx/config.ts'
import { WxRegistry } from './wx/registry.ts'
import { wxQueryBiz, wxQueryTodo, wxQueryDetail, wxPrepareApprove, wxConfirmApprove } from './wx/api.ts'
import type { WxOpContext } from './wx/api.ts'
import { PendingStore } from './wx/pending.ts'
import { SameTurnGuard } from './wx/same-turn.ts'
import { Auditor } from './wx/audit.ts'

export const name = 'wx-agent'
export const inject = ['tools']

/** Plugin configuration. */
export interface Config {
  /** Directory containing `wx-cli.conf.json` and `wx-cli.biz.json` (the wx repo `bin/`). Omit to use bundled template + registry assets. */
  wxHome?: string
  /** Default environment when the model omits `environment` (test/uat/pro). */
  defaultEnv?: string
  /** Dev fallback identity when the calling context injects no account. */
  defaultAccount?: string
  /** 审批审计日志 JSONL 文件路径（可选）；配置后会把每次审批事件追加到该文件。 */
  auditPath?: string
}

/** Runtime schema for the plugin config. */
export const Config: z<Config> = z.object({
  wxHome: z.string(),
  defaultEnv: z.string().default('test'),
  defaultAccount: z.string(),
  auditPath: z.string(),
})

/** Environment choices exposed to the model. */
const ENV_DESCRIPTION = '运行环境：test/uat/pro（默认由插件配置决定）。敏感数据请先确认环境。'

/** Convert a thrown error into a model-facing message; rethrow aborts. */
function toolMessage(e: unknown): string {
  if (e instanceof Error && e.name === 'AbortError') throw e
  return e instanceof Error ? e.message : String(e)
}

export function apply(ctx: Context, cfg: Config) {
  // 记录每个 agent 当前 turn，供 SameTurnGuard 判定「发起审批」与「确认」是否同轮。
  const turnByAgent = new Map<string, number>()
  ctx.on('agent/pre-step', (p, next) => {
    turnByAgent.set(p.agent.id, p.turn)
    return next()
  })
  const guard = new SameTurnGuard((id) => turnByAgent.get(id) ?? -1)

  // Batch-load config + registry once. Misconfiguration surfaces as a loud tool
  // error on the first call rather than a silent no-op.
  const backend: Promise<WxOpContext> = (async () => {
    const [config, registry] = await Promise.all([
      cfg.wxHome ? WxConfig.load(cfg.wxHome) : WxConfig.load(),
      cfg.wxHome ? WxRegistry.load(cfg.wxHome) : WxRegistry.load(),
    ])
    return {
      config, registry, defaultEnv: cfg.defaultEnv, defaultAccount: cfg.defaultAccount,
      pending: new PendingStore(5 * 60_000),
      auditor: cfg.auditPath ? new Auditor(cfg.auditPath) : undefined,
    }
  })()

  // --- wx_query_biz ---
  ctx.tools.register(defineTool({
    name: 'wx_query_biz',
    description: '列出当前可用的审批系统与业务模块（用户不清楚业务名时先调用此工具）。',
    parameters: {
      environment: { type: 'string', description: ENV_DESCRIPTION },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(_args, exec) {
      try {
        return await wxQueryBiz(await backend, { signal: exec.signal })
      } catch (e) {
        throw new Error(toolMessage(e))
      }
    },
  }))

  // --- wx_query_todo ---
  ctx.tools.register(defineTool({
    name: 'wx_query_todo',
    description: '查询当前用户在指定业务的待办/已办列表（含审批单号与关键字段）。biz 支持三种写法：业务key（generay）、系统.业务（purchase.generay，推荐）、系统名（purchase）。',
    parameters: {
      biz: { type: 'string', required: true, description: '业务引用，见工具描述' },
      status: { type: 'string', description: '0=待办（默认），1=已办' },
      op: { type: 'string', description: '其他列表操作（如鑫合同 listProcessed/listNotify/listMine）' },
      environment: { type: 'string', description: ENV_DESCRIPTION },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      try {
        return await wxQueryTodo(await backend, {
          biz: args.biz,
          status: args.status,
          op: args.op,
          environment: args.environment,
          signal: exec.signal,
        })
      } catch (e) {
        throw new Error(toolMessage(e))
      }
    },
  }))

  // --- wx_query_detail ---
  ctx.tools.register(defineTool({
    name: 'wx_query_detail',
    description: '查询某张单据的详情（申请信息/金额/审批节点/物品明细等）。常用可变参数：orderNumber（申请单号）、purchaseOrderNumber（PO单号）、inspectionNumber（验收单号）、id（鑫合同任务ID）、applyTaskId（鑫合同申请任务ID）。',
    parameters: {
      biz: { type: 'string', required: true, description: '业务引用，同 wx_query_todo' },
      op: { type: 'string', description: '详情操作：detail（默认）/acceptanceDetail/detailItems/detailContract 等' },
      orderNumber: { type: 'string', description: '申请单号' },
      purchaseOrderNumber: { type: 'string', description: 'PO 单号' },
      inspectionNumber: { type: 'string', description: '验收单号' },
      id: { type: 'string', description: '任务ID（鑫合同 handleTaskId，从待办列表取）' },
      applyTaskId: { type: 'string', description: '申请任务ID（鑫合同）' },
      applyTypeDetail: { type: 'string', description: '申请类型代码（鑫合同，如 CONTRACT）' },
      environment: { type: 'string', description: ENV_DESCRIPTION },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      try {
        const vars: Record<string, string> = {}
        for (const k of ['orderNumber', 'purchaseOrderNumber', 'inspectionNumber', 'id', 'applyTaskId', 'applyTypeDetail']) {
          const v = (args as Record<string, unknown>)[k]
          if (typeof v === 'string' && v) vars[k] = v
        }
        return await wxQueryDetail(await backend, {
          biz: args.biz,
          op: args.op,
          vars,
          environment: args.environment,
          signal: exec.signal,
        })
      } catch (e) {
        throw new Error(toolMessage(e))
      }
    },
  }))

  // --- wx_approve ---
  ctx.tools.register(defineTool({
    name: 'wx_approve',
    description: '发起审批通过/驳回：定位单据、推导参数并生成确认摘要，登记待确认状态，不会直接执行；用户回复『确认』后调用 wx_confirm 执行，回复『取消』调用 wx_confirm 取消。',
    parameters: {
      biz: { type: 'string', required: true, description: '业务引用，同 wx_query_todo' },
      orderNumber: { type: 'string', required: true, description: '申请单号（必须完整准确）' },
      action: { type: 'string', required: true, enum: ['approve', 'reject'], description: 'approve=审批通过，reject=审批驳回' },
      remarks: { type: 'string', description: '审批意见（可选）' },
      auditContent: { type: 'string', description: '审批事项（可选，缺省用 action 表述）' },
      environment: { type: 'string', description: ENV_DESCRIPTION },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      try {
        const out = await wxPrepareApprove(await backend, {
          biz: args.biz,
          orderNumber: args.orderNumber,
          action: args.action,
          remarks: args.remarks,
          environment: args.environment,
        })
        if (exec.agent) guard.recordApprove(exec.agent.id)
        return out
      } catch (e) {
        throw new Error(toolMessage(e))
      }
    },
  }))

  // --- wx_confirm ---
  ctx.tools.register(defineTool({
    name: 'wx_confirm',
    description: '确认或取消待执行的审批。用户明确回复『确认』时调用 decision=confirm 执行；回复『取消』时调用 decision=cancel。',
    parameters: {
      decision: { type: 'string', required: true, enum: ['confirm', 'cancel'], description: 'confirm=确认执行，cancel=取消' },
      environment: { type: 'string', description: ENV_DESCRIPTION },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      if (exec.agent && guard.isSameTurn(exec.agent.id)) {
        return '确认操作必须在用户下一条消息中单独进行，不能在发起审批的同一轮执行。'
      }
      try {
        return await wxConfirmApprove(await backend, {
          decision: args.decision,
          environment: args.environment,
        })
      } catch (e) {
        throw new Error(toolMessage(e))
      }
    },
  }))
}
