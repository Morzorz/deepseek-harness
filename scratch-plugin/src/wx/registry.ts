/**
 * WeCom biz registry, ported from the Go `wx-cli` (`bin/internal/biz/biz.go`).
 *
 * Reads `wx-cli.biz.json` (index) + `bin/registry/<system>.json` (lazy per-system).
 * Resolution supports 业务key / 系统.业务 / 系统名 (first biz), matching the CLI.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  WxBiz,
  WxBizIndex,
  WxBizRef,
  WxOp,
  WxSystem,
  WxSystemMeta,
} from './types.ts'

/** Registry path layout relative to a base directory. */
export interface WxPaths {
  /** Directory containing `wx-cli.biz.json` and `registry/`. */
  base: string
}

/** 内置资源根目录（相对本文件，尾斜杠）。 */
const ASSETS_DIR = new URL('./registry-assets/', import.meta.url)

/** 读取内置资产（biz-index.json 或 registry/<system>.json）。 */
function readAssetUrl(url: URL): Promise<string> {
  return readFile(url, 'utf8')
}

function sortKeys(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).sort()
}

/** Loaded registry: index + lazy-loaded system cache. */
export class WxRegistry {
  readonly systems: Record<string, WxSystemMeta>
  private readonly baseDir: string
  private readonly bundled: boolean
  private readonly loaded = new Map<string, WxSystem>()

  constructor(index: WxBizIndex, baseDir: string, bundled = false) {
    this.systems = index.systems
    this.baseDir = baseDir
    this.bundled = bundled
  }

  /**
   * Load the index. When `base` is omitted, read the bundled
   * `biz-index.json` asset; when given, read `<base>/wx-cli.biz.json`
   * (kept for external wxHome debug override).
   */
  static async load(base?: string): Promise<WxRegistry> {
    if (base === undefined) {
      const data = await readAssetUrl(new URL('biz-index.json', ASSETS_DIR))
      const index = JSON.parse(data) as WxBizIndex
      return new WxRegistry(index, ASSETS_DIR.toString(), true)
    }
    const data = await readFile(join(base, 'wx-cli.biz.json'), 'utf8')
    const index = JSON.parse(data) as WxBizIndex
    return new WxRegistry(index, base)
  }

  /** System names, sorted (index only; does not touch system files). */
  systemNames(): string[] {
    return sortKeys(this.systems)
  }

  /** Lazy-load + cache one system file. Throws a Chinese error on miss/failure. */
  async getSystem(name: string): Promise<WxSystem> {
    const cached = this.loaded.get(name)
    if (cached) return cached
    const meta = this.systems[name]
    if (!meta) {
      throw new Error(`未知系统 "${name}"（可用: ${this.systemNames().join(', ')}）`)
    }
    const data = this.bundled
      ? await readAssetUrl(new URL(meta.file, ASSETS_DIR))
      : await readFile(join(this.baseDir, meta.file), 'utf8')
    const sys = JSON.parse(data) as WxSystem
    this.loaded.set(name, sys)
    return sys
  }

  /** Display name of a system (index only). */
  systemDisplayName(name: string): string {
    return this.systems[name]?.name ?? name
  }

  /**
   * Resolve a biz reference:
   *   - `bizKey` (globally unique across systems)
   *   - `sys.biz` (dot form)
   *   - `sys` (system name; its first biz by key order)
   */
  async resolveBiz(ref: string): Promise<WxBizRef> {
    if (!ref) {
      throw new Error(`业务引用为空（可用系统: ${this.systemNames().join(', ')}）`)
    }
    if (ref.includes('.')) {
      const dot = ref.indexOf('.')
      const sys = ref.slice(0, dot)
      const biz = ref.slice(dot + 1)
      if (!sys || !biz) throw new Error(`业务引用 "${ref}" 格式非法（应为 系统.业务）`)
      return this.resolveExact(sys, biz)
    }
    if (this.systems[ref]) {
      const sys = await this.getSystem(ref)
      const keys = sortKeys(sys.bizs)
      const first = keys[0]
      if (!first) throw new Error(`系统 "${ref}" 未配置业务`)
      return this.resolveExact(ref, first)
    }
    // Global unique biz key: scan all systems (lazy).
    for (const sysName of sortKeys(this.systems)) {
      const sys = await this.getSystem(sysName)
      if (sys.bizs[ref]) return this.resolveExact(sysName, ref)
    }
    throw new Error(`未知业务 "${ref}"（可用: ${(await this.bizKeyList()).join(', ')}；或 系统.业务）`)
  }

  private async resolveExact(sysName: string, bizKey: string): Promise<WxBizRef> {
    const sys = await this.getSystem(sysName)
    const biz = sys.bizs[bizKey]
    if (!biz) {
      throw new Error(`系统 "${sysName}" 无业务 "${bizKey}"（可用: ${(await this.bizKeys(sysName)).join(', ')}）`)
    }
    return { system: sysName, sys, bizKey, biz }
  }

  private async bizKeys(sysName: string): Promise<string[]> {
    try {
      const sys = await this.getSystem(sysName)
      return sortKeys(sys.bizs).map((k) => `${sysName}.${k}`)
    } catch {
      return []
    }
  }

  private async bizKeyList(): Promise<string[]> {
    const out: string[] = []
    for (const sysName of sortKeys(this.systems)) {
      out.push(...(await this.bizKeys(sysName)))
    }
    return out
  }

  /** List all systems + their biz keys as a Chinese display string (parallel Executor.ListBiz). */
  async listBiz(): Promise<string> {
    const out: string[] = []
    for (const sysName of this.systemNames()) {
      const sys = await this.getSystem(sysName)
      out.push(`${sysName}（${sys.name}）:`)
      for (const k of sortKeys(sys.bizs)) {
        const b = sys.bizs[k]
        if (b) out.push(`  - ${k}（${b.name}）`)
      }
    }
    return out.join('\n')
  }
}

/** Look up a list/detail/detailItems/ops op on a biz (parallel Go ResolveOp). */
export function resolveOp(biz: WxBiz, name: string): WxOp | undefined {
  switch (name) {
    case 'list':
      return biz.list
    case 'detail':
      return biz.detail
    case 'detailItems':
      return biz.detailItems
    default:
      return biz.ops?.[name]
  }
}

/** Names of operations a biz offers (list/detail/detailItems + ops keys). */
export function opNames(biz: WxBiz): string[] {
  const names: string[] = []
  if (biz.list) names.push('list')
  if (biz.detail) names.push('detail')
  if (biz.detailItems) names.push('detailItems')
  for (const k of Object.keys(biz.ops ?? {})) names.push(k)
  return names.sort()
}

/** Whether an op's body/query references the `{{key}}` placeholder. */
export function opNeedsPlaceholder(op: WxOp, key: string): boolean {
  const needle = `{{${key}}}`
  for (const v of Object.values(op.requestBody ?? {})) {
    if (v.includes(needle)) return true
  }
  for (const v of Object.values(op.requestQuery ?? {})) {
    if (v.includes(needle)) return true
  }
  return false
}

/**
 * Replace `{{key}}` / `{{key|default}}` placeholders with vars.
 * Parallel to Go `replacePlaceholders`.
 */
export function replacePlaceholders(s: string, vars: Record<string, string>): string {
  if (!s.includes('{{')) return s
  let out = ''
  let rest = s
  for (;;) {
    const i = rest.indexOf('{{')
    if (i < 0) {
      out += rest
      break
    }
    out += rest.slice(0, i)
    const j = rest.indexOf('}}', i + 2)
    if (j < 0) {
      out += rest
      break
    }
    const expr = rest.slice(i + 2, j)
    const after = rest.slice(j + 2)
    let key = expr
    let def = ''
    const p = expr.indexOf('|')
    if (p >= 0) {
      key = expr.slice(0, p)
      def = expr.slice(p + 1)
    }
    const v = vars[key]
    out += v !== undefined && v !== '' ? v : def
    rest = after
  }
  return out
}

/** Serialize one JSON key (quoted). */
function jsonKey(k: string): string {
  return `${JSON.stringify(k)}:`
}

/** Serialize a body value the way Go `jsonValue` does (preserve pre-quoted/numbers). */
function jsonValue(v: string): string {
  if (v === '') return '""'
  if (v.startsWith('"') && v.endsWith('"')) return v
  if (isNumber(v) || v === 'true' || v === 'false' || v === 'null') return v
  return JSON.stringify(v)
}

function isNumber(s: string): boolean {
  if (s === '') return false
  for (const c of s) {
    if (c < '0' || c > '9') return false
  }
  return true
}

/** Build the JSON request body string from an op's requestBody spec (parallel Go BuildBody). */
export function buildBody(op: WxOp, vars: Record<string, string>): string {
  const spec = op.requestBody
  if (!spec) return ''
  const keys = sortKeys(spec)
  const parts = keys.flatMap((k) => {
    const raw = spec[k]
    if (raw === undefined) return []
    let val = replacePlaceholders(raw, vars)
    if (val === '') val = vars[k] ?? ''
    return [`${jsonKey(k)}${jsonValue(val)}`]
  })
  return `{${parts.join(',')}}`
}

/** Build the URL query string from an op's requestQuery spec (parallel Go BuildQuery). */
export function buildQuery(op: WxOp, vars: Record<string, string>): string {
  const spec = op.requestQuery
  if (!spec) return ''
  const keys = sortKeys(spec)
  const parts: string[] = []
  for (const k of keys) {
    const raw = spec[k]
    if (raw === undefined) continue
    let val = replacePlaceholders(raw, vars)
    if (val === '') val = vars[k] ?? ''
    if (!val) continue
    parts.push(`${k}=${val}`)
  }
  if (parts.length === 0) return ''
  return `?${parts.join('&')}`
}
