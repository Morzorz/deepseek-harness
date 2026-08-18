/**
 * Shared wire types for the WeCom (企业微信) approval adapter.
 *
 * These mirror the on-disk formats of the `wx` Go repo:
 * - `wx-cli.conf.json` (multi-environment gateway/hmac_key/corpid)
 * - `wx-cli.biz.json` (system -> registry file index)
 * - `bin/registry/<system>.json` (per-system biz/op/response specs)
 * - `~/.wx-cli/<env>.json` (a CLI login session)
 */

import type { WxConfig } from './config.ts'
import type { WxRegistry } from './registry.ts'

/** One environment's gateway + signing config from `wx-cli.conf.json`. */
export interface WxEnv {
  gateway: string
  hmac_key: string
  corpid: string
  default_corp_iden: string
}

/** The full `wx-cli.conf.json` document. */
export interface WxCliConfig {
  environments: Record<string, WxEnv>
}

/** A persisted login session at `~/.wx-cli/<env>.json`. */
export interface WxSession {
  account: string
  logged_in_at?: string
}

/** Injectable transport seam so tests can stub the network. */
export interface WxTransport {
  do(opts: {
    gateway: string
    hmacKey: string
    account: string
    method: string
    path: string
    body: string
    signal?: AbortSignal
  }): Promise<{ body: string }>
  getMemberCode(opts: {
    gateway: string
    hmacKey: string
    account: string
    signal?: AbortSignal
  }): Promise<string>
}

/**
 * Context for one WeCom operation. The acting identity comes from the calling
 * context (`account`, injected by the bridge) or a dev fallback
 * (`defaultAccount`), never from a local scan session.
 */
export interface WxOpContext {
  config: WxConfig
  registry: WxRegistry
  /** Default environment when the caller omits `environment`. */
  defaultEnv?: string
  /** Acting user identity (wecom userID), injected by the calling bridge. */
  account?: string
  /** Dev fallback identity when `account` is not injected. */
  defaultAccount?: string
  transport?: WxTransport
}

/** Response rendering spec from a registry op (`response`). */
export interface ResponseSpec {
  path?: string
  totalField?: string
  listField?: string
  fields?: Record<string, string>
  listItemsField?: string
  listItemsFields?: Record<string, string>
}

/** One operation (list/detail/detailItems/ops) from a registry biz. */
export interface WxOp {
  name?: string
  path: string
  method: string
  requestBody?: Record<string, string>
  requestQuery?: Record<string, string>
  response?: ResponseSpec
}

/** One business domain under a system. */
export interface WxBiz {
  name: string
  module?: string
  list?: WxOp
  detail?: WxOp
  detailItems?: WxOp
  ops?: Record<string, WxOp>
}

/** One business system (a registry file). */
export interface WxSystem {
  name: string
  bizs: Record<string, WxBiz>
}

/** Index entry from `wx-cli.biz.json`. */
export interface WxSystemMeta {
  file: string
  name: string
}

/** The `wx-cli.biz.json` document. */
export interface WxBizIndex {
  systems: Record<string, WxSystemMeta>
}

/** Environment name restricted to the configured set. */
export type WxEnvName = string

/** A resolved biz reference (system + biz + display name), parallel to Go BizRef. */
export interface WxBizRef {
  system: string
  sys: WxSystem
  bizKey: string
  biz: WxBiz
}

/** Result of rendering a raw gateway response through a ResponseSpec. */
export type RenderedOutput = string
