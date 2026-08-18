/**
 * 审批参数自动推导 (port of the Go `wx-cli` agent's PrepareApprove/findRecord/
 * buildApproveSummary logic). Locates a record by order no, derives the request
 * params the approve/reject op's `{{placeholder}}` templates require, and builds
 * a Chinese confirmation summary.
 */

import { resolveOp } from './registry.ts'
import type { ResponseSpec, WxBizRef } from './types.ts'

/** 从列表响应中按单号定位记录；fetcher 返回原始响应体字符串。 */
export async function findRecord(
  ref: WxBizRef,
  orderNo: string,
  fetcher: (vars: Record<string, string>) => Promise<{ body: string }>,
): Promise<Record<string, unknown> | undefined> {
  const op = ref.biz.list
  if (!op) {
    throw new Error(`业务 "${ref.biz.name}" 未配置列表接口`)
  }
  // 同时尝试 orderNumber 与 applyNo 两种单号过滤参数（注册表各自消费）。
  const vars = { orderNumber: orderNo, applyNo: orderNo }
  const resp = await fetcher(vars)
  const recs = extractRecords(resp.body, op.response)
  if (recs.length === 0) return undefined
  // 客户端二次过滤：某些系统（如 liquidity）的列表接口不消费单号过滤参数，
  // 必须按单号字段校验，避免误取用户第一条待办。
  for (const r of recs) {
    if (firstNonEmpty(r, 'applyNo', 'orderNumber') === orderNo) return r
    const no = firstNonEmpty(r, 'bussNo', 'businessNo')
    if (no !== '' && no === orderNo) return r
  }
  return undefined
}

/**
 * 按 approve/reject op 的 requestBody 占位符推导审批参数（含 needDetail 分支，可传
 * fetchDetail 拉详情补字段）。返回的 map 以占位符键写入，供 buildBody 消费——
 * buildBody 遍历 requestBody 键，用 vars[placeholder] 替换各 {{placeholder}} 模板。
 */
export async function approveParams(
  ref: WxBizRef,
  action: 'approve' | 'reject',
  account: string,
  orderNo: string,
  opinion: string,
  fields: Record<string, unknown>,
  fetchDetail?: (vars: Record<string, string>) => Promise<Record<string, unknown>>,
): Promise<Record<string, string>> {
  const opName = action === 'reject' ? 'reject' : 'approve'
  const op = resolveOp(ref.biz, opName)
  if (!op) {
    throw new Error(`业务 "${ref.biz.name}" 未配置操作 "${opName}"`)
  }

  const vars: Record<string, string> = {}
  const needDetail: string[] = []
  for (const bodyKey of Object.keys(op.requestBody ?? {})) {
    const tmpl = op.requestBody![bodyKey]
    if (!tmpl) continue
    for (const ph of placeholderKeys(tmpl)) {
      if (isNeedDetail(ph)) {
        if (!needDetail.includes(ph)) needDetail.push(ph)
        vars[ph] = ''
        continue
      }
      const v = derive(ph, account, action, orderNo, opinion, fields)
      vars[ph] = v
    }
  }

  // 需要详情字段时（鑫合同等），调详情接口提取。
  if (needDetail.length > 0 && fetchDetail) {
    const detail = (await fetchDetail({
      orderNumber: recStr(fields, 'orderNumber'),
      id: recStr(fields, 'handleTaskId'),
      applyTaskId: recStr(fields, 'id'),
      applyTypeDetail: applyTypeCode(fields['applyTypeDetail']),
      account,
    })) as Record<string, unknown>
    for (const k of needDetail) {
      vars[k] = nestedStrDetail(detail, k)
    }
  }
  return vars
}

/** 取单个占位符对应的推导值（port Go PrepareApprove 的 switch）。 */
function derive(
  ph: string,
  account: string,
  action: 'approve' | 'reject',
  orderNo: string,
  opinion: string,
  fields: Record<string, unknown>,
): string {
  switch (ph) {
    case 'account':
      return account
    case 'orderNumber':
    case 'bussNo':
      return orderNo
    case 'action':
      // liquidity 的 auditResult：1=通过，2=驳回
      return action === 'reject' ? '2' : '1'
    case 'auditContent': {
      const v = recStr(fields, 'auditContent')
      if (v !== '') return v
      return action === 'approve' ? '审批通过' : '审批驳回'
    }
    case 'remarks':
      return opinion
    case 'memberCode':
      // 留空：执行时自动从当前用户获取
      return ''
    case 'id':
    case 'handleTaskId':
      return recStr(fields, 'handleTaskId')
    case 'applyTaskId':
      return recStr(fields, 'id')
    case 'applyTypeDetail':
      return applyTypeCode(fields['applyTypeDetail'])
    default:
      return ''
  }
}

/** 该占位符是否属于需要详情接口补字段的字段。 */
function isNeedDetail(ph: string): boolean {
  return ph === 'memberType' || ph === 'nodeApprovalType' || ph === 'workListId' ||
    ph === 'workListMemberId' || ph === 'worklistName'
}

/** 从详情对象取 needDetail 字段（memberType.code / currentNodeApprovalType.code 等）。 */
function nestedStrDetail(detail: Record<string, unknown>, k: string): string {
  switch (k) {
    case 'memberType':
      return nestedStr(detail, 'memberType', 'code')
    case 'nodeApprovalType':
      return nestedStr(detail, 'currentNodeApprovalType', 'code')
    case 'workListId':
      return recStr(detail, 'currentWorkListId')
    case 'workListMemberId':
      return recStr(detail, 'currentWorkListMembeId')
    case 'worklistName':
      return recStr(detail, 'currentWorkListName')
    default:
      return ''
  }
}

/** 拼审批确认摘要（参照 Go buildApproveSummary）。 */
export function approveSummary(
  ref: WxBizRef,
  rec: Record<string, unknown>,
  orderNo: string,
  action: 'approve' | 'reject',
  opinion: string,
): string {
  const b: string[] = []
  b.push(`【${ref.sys.name}-${ref.biz.name}】`)
  const no = firstNonEmpty(rec, 'applyNo', 'orderNumber') || orderNo
  if (no !== '') b.push(`单号：${no}`)
  const name = firstNonEmpty(rec, 'applyName', 'contractName', 'entryName', 'templateName')
  if (name !== '') b.push(`名称：${name}`)
  const applicant = firstNonEmpty(rec, 'applicantName', 'cnName')
  if (applicant !== '') b.push(`申请人：${applicant}`)
  const amount = firstNonEmpty(rec, 'contractTotalAmount', 'financialApyTotalAmount', 'ticketApplyAmount', 'settlementAmount')
  if (amount !== '') b.push(`金额：${amount}`)
  const node = firstNonEmpty(rec, 'currentWorkListName', 'currentApprovalInfo')
  if (node !== '') b.push(`节点：${node}`)
  const verb = action === 'reject' ? '审批驳回' : '审批通过'
  if (opinion !== '') b.push(`意见：${opinion}`)
  b.push(`确认将以当前账号执行「${verb}」？回复『确认』执行，回复『取消』放弃。`)
  return b.join('\n')
}

/** 提取模板中的 {{key}} 占位符（port Go placeholderKeys）。 */
function placeholderKeys(tmpl: string): string[] {
  const keys: string[] = []
  let rest = tmpl
  for (;;) {
    const i = rest.indexOf('{{')
    if (i < 0) break
    const j = rest.indexOf('}}', i + 2)
    if (j < 0) break
    const expr = rest.slice(i + 2, j)
    const p = expr.indexOf('|')
    keys.push(p >= 0 ? expr.slice(0, p) : expr)
    rest = rest.slice(j + 2)
  }
  return keys
}

/** 沿 "a.b.c" 取嵌套 map。 */
function jsonPath(root: Record<string, unknown>, path: string): Record<string, unknown> | undefined {
  if (path === '') return root
  let cur: unknown = root
  for (const seg of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined
    const m = cur as Record<string, unknown>
    if (!(seg in m)) return undefined
    cur = m[seg]
  }
  if (typeof cur !== 'object' || cur === null) return undefined
  return cur as Record<string, unknown>
}

/** 按 response spec 提取列表记录（port Go extractRecords）。 */
function extractRecords(raw: string, spec?: ResponseSpec): Record<string, unknown>[] {
  const root = parseJson(raw)
  if (!spec || !spec.path || !spec.listField) return []
  const node = jsonPath(root, spec.path)
  if (!node) return []
  const rawList = node[spec.listField]
  if (!Array.isArray(rawList)) return []
  return rawList.filter((v): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v))
}

/** 解析响应体，大整数以字符串保留（对齐 Go UseNumber）。 */
function parseJson(raw: string): Record<string, unknown> {
  return JSON.parse(raw, (_k, v: unknown) =>
    typeof v === 'number' && !Number.isSafeInteger(v) ? String(v) : v)
}

/** recStr：取 map 中字段的字符串表示。 */
function recStr(m: Record<string, unknown>, key: string): string {
  const v = m[key]
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}

/** applyTypeCode：applyTypeDetail 对象取 code；字符串原样。 */
function applyTypeCode(v: unknown): string {
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    const c = (v as Record<string, unknown>)['code']
    return typeof c === 'string' ? c : ''
  }
  return typeof v === 'string' ? v : ''
}

/** nestedStr：取嵌套对象字段（如 memberType.code）。 */
function nestedStr(m: Record<string, unknown>, obj: string, field: string): string {
  const o = m[obj]
  if (typeof o !== 'object' || o === null) return ''
  const v = (o as Record<string, unknown>)[field]
  return typeof v === 'string' ? v : ''
}

/** firstNonEmpty：按序取第一个非空字符串字段。 */
function firstNonEmpty(m: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = recStr(m, k)
    if (v !== '') return v
  }
  return ''
}
