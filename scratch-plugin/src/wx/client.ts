/**
 * HMAC-signed HTTP client for the WeCom gateway, ported from the Go `wx-cli`
 * (`bin/internal/client/client.go`). A network `AbortSignal` is threaded through
 * so tool execution can honour `exec.signal`.
 */

import { buildHmacHeaders, nowUnixSeconds } from './hmac.ts'

/** Response of a gateway call: raw body string (JSON), or an error. */
export interface WxHttpResult {
  body: string
}

const HTTP_TIMEOUT_MS = 30_000

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError'
}

/**
 * Perform an HMAC-signed request. `method` uppercase, `path` starts with `/`,
 * body is a JSON string (may be empty). Resolves to the raw response body;
 * non-2xx rejects with HTTP `<code>: <body>`.
 */
export async function wxHttpDo(
  opts: {
    gateway: string
    hmacKey: string
    account: string
    method: string
    path: string
    body: string
    signal?: AbortSignal
  },
): Promise<WxHttpResult> {
  const { gateway, hmacKey, account, method, path, body, signal } = opts
  if (!account) {
    throw new Error('缺少当前用户身份（插件未注入 account，请设置 defaultAccount 或经 wecom-bridge 注入）')
  }
  const headers = { ...buildHmacHeaders(account, hmacKey, nowUnixSeconds()) }
  const url = `${gateway.replace(/\/$/, '')}${path}`

  let controller: AbortController | undefined
  const composed: AbortController = new AbortController()
  if (signal?.aborted) {
    composed.abort()
  } else if (signal) {
    signal.addEventListener('abort', () => composed.abort(), { once: true })
  }
  const timeoutTimer = setTimeout(() => composed.abort(), HTTP_TIMEOUT_MS)
  composed.signal.addEventListener('abort', () => clearTimeout(timeoutTimer))
  controller = composed

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body !== '' ? body : undefined,
      signal: controller.signal,
    })
    const respBody = await res.text()
    if (res.status >= 400) {
      throw new Error(`HTTP ${res.status}: ${respBody}`)
    }
    return { body: respBody }
  } catch (e) {
    if (isAbortError(e)) {
      const err = new Error(`请求 ${method} ${path} 失败: abort`)
      err.name = 'AbortError'
      throw err
    }
    throw new Error(`请求 ${method} ${path} 失败: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Query the current user's employee number (memberCode), used by xincontract approvals. */
export async function wxGetMemberCode(opts: {
  gateway: string
  hmacKey: string
  account: string
  signal?: AbortSignal
}): Promise<string> {
  const { body } = await wxHttpDo({
    ...opts,
    method: 'GET',
    path: '/enterprisewechat/api/getCurrentUserInfo',
    body: '',
  })
  const parsed = JSON.parse(body) as { employeeNumber?: string }
  if (!parsed.employeeNumber) {
    throw new Error('接口未返回 employeeNumber')
  }
  return parsed.employeeNumber
}
