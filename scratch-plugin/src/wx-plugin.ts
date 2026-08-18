/**
 * WeCom (企业微信) approval tool plugin for DeepSeek Harness.
 *
 * Registers four model-facing tools on `ctx.tools`:
 *   - wx_query_biz    : list available systems/biz keys
 *   - wx_query_todo   : todo / done list for a biz
 *   - wx_query_detail : document detail for a biz
 *   - wx_approve      : approve/reject a document, gated by dsh `ctx.approval`
 *
 * Login is reused from the Go `wx-cli` session (~/.wx-cli/<env>.json); the human
 * runs `bin/wx-cli login --env X` to scan the QR. No QR UI is implemented here.
 *
 * The approval tool is transport-agnostic and writes only after the dsh
 * approval channel returns `allowed-once` (the Web UI answers it). This keeps
 * the seam reusable when a WeCom smart-robot transport drives the same agent.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ApprovalService, type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-approval'
import { WxConfig } from './wx/config.ts'
import { WxRegistry } from './wx/registry.ts'
import { wxQueryBiz, wxQueryTodo, wxQueryDetail, wxExecuteApprove } from './wx/api.ts'
import type { WxOpContext } from './wx/api.ts'

export const name = 'wx-agent'
export const inject = ['tools', 'approval']

/** Plugin configuration. */
export interface Config {
  /** Directory containing `wx-cli.conf.json` and `wx-cli.biz.json` (the wx repo `bin/`). Omit to use bundled template + registry assets. */
  wxHome?: string
  /** Default environment when the model omits `environment` (test/uat/pro). */
  defaultEnv?: string
  /** Dev fallback identity when the calling context injects no account. */
  defaultAccount?: string
}

/** Runtime schema for the plugin config. */
export const Config: z<Config> = z.object({
  wxHome: z.string(),
  defaultEnv: z.string().default('test'),
  defaultAccount: z.string(),
})

/** Environment choices exposed to the model. */
const ENV_DESCRIPTION = '运行环境：test/uat/pro（默认由插件配置决定）。敏感数据请先确认环境。'

/** Convert a thrown error into a model-facing message; rethrow aborts. */
function toolMessage(e: unknown): string {
  if (e instanceof Error && e.name === 'AbortError') throw e
  return e instanceof Error ? e.message : String(e)
}

/** Ask dsh for one-time approval of an action. Fails closed unless `allowed-once`. */
async function askApproval(
  approval: ApprovalService,
  exec: ToolRunContext,
  reason: string,
): Promise<void> {
  const agent: Agent | undefined = exec.agent
  if (!agent) {
    throw new Error('缺少执行 agent，无法请求审批确认')
  }
  const outcome: ApprovalOutcome = await approval.request({
    agent,
    toolName: 'wx_approve',
    callId: exec.callId,
    reason,
    signal: exec.signal,
  })
  if (outcome !== 'allowed-once') {
    throw new Error(`审批未被允许（${outcome}），未执行任何操作`)
  }
}

export function apply(ctx: Context, cfg: Config) {
  // Batch-load config + registry once. Misconfiguration surfaces as a loud tool
  // error on the first call rather than a silent no-op.
  const backend: Promise<WxOpContext> = (async () => {
    const [config, registry] = await Promise.all([
      cfg.wxHome ? WxConfig.load(cfg.wxHome) : WxConfig.load(),
      cfg.wxHome ? WxRegistry.load(cfg.wxHome) : WxRegistry.load(),
    ])
    return { config, registry, defaultEnv: cfg.defaultEnv, defaultAccount: cfg.defaultAccount }
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
    description: '对某张单据发起审批通过或驳回。此操作需用户确认后才真正提交：工具会先生成将执行的操作摘要并请求确认，仅在获得批准后调网关，未受批准不会产生任何写操作。',
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
        const env = args.environment || cfg.defaultEnv || 'test'
        const actionLabel = args.action === 'approve' ? '审批通过' : '审批驳回'
        const summary = `将对企业微信 ${env} 环境的业务「${args.biz}」申请单 ${args.orderNumber} 执行【${actionLabel}】${args.remarks ? `，意见：${args.remarks}` : ''}。确认后再执行。`
        const approval = ctx.approval
        await askApproval(approval, exec, summary)
        // pro 环境强制二次确认（对齐 CLI 的 yes 二次确认）。
        if (env === 'pro') {
          await askApproval(approval, exec, `【二次确认】即将在 pro 环境真正提交：${summary}`)
        }
        const vars: Record<string, string> = {
          orderNumber: args.orderNumber,
          remarks: args.remarks ?? '',
          auditContent: args.auditContent ?? actionLabel,
        }
        return await wxExecuteApprove(await backend, {
          biz: args.biz,
          action: args.action,
          vars,
          environment: env,
          signal: exec.signal,
        })
      } catch (e) {
        throw new Error(toolMessage(e))
      }
    },
  }))
}
