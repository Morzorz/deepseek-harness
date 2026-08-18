/**
 * Render a gateway response through a registry `response` spec into Chinese
 * text, ported 1:1 from the Go `wx-cli` (`bin/internal/biz/render.go`).
 */

import type { ResponseSpec } from './types.ts'

type JsonNode = Record<string, unknown>

/** Pretty-print arbitrary JSON. */
function printPretty(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

function printPrettyMap(m: JsonNode): string {
  return JSON.stringify(m, null, 2)
}

function lookupPath(root: JsonNode, path: string): JsonNode | undefined {
  if (!path) return root
  let cur: unknown = root
  for (const seg of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined
    cur = (cur as JsonNode)[seg]
  }
  if (typeof cur !== 'object' || cur === null) return undefined
  return cur as JsonNode
}

function getList(node: JsonNode, field: string): JsonNode[] {
  const raw = node[field]
  if (!Array.isArray(raw)) return []
  return raw.filter((v): v is JsonNode => typeof v === 'object' && v !== null)
}

function getInt(node: JsonNode, field: string | undefined): number {
  if (!field) return 0
  const raw = node[field]
  if (typeof raw === 'number') return Math.trunc(raw)
  if (typeof raw === 'string') {
    const n = Number.parseInt(raw, 10)
    return Number.isNaN(n) ? 0 : n
  }
  return 0
}

function lookupField(item: JsonNode, key: string): unknown {
  if (!key.includes('.')) return item[key]
  let cur: unknown = item
  for (const seg of key.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined
    cur = (cur as JsonNode)[seg]
  }
  return cur
}

function renderFields(item: JsonNode, fields?: Record<string, string>): string {
  if (!fields) return printPrettyMap(item)
  const lines: string[] = []
  for (const k of Object.keys(fields).sort()) {
    const v = lookupField(item, k)
    if (v === undefined || v === null) continue
    const s = String(v)
    if (s === '' || s === '<nil>') continue
    lines.push(`  ${fields[k]}: ${v}`)
  }
  return lines.join('\n')
}

/**
 * Format a raw gateway response into Chinese display text (parallel Go
 * `RenderResponse`). `spec` may be undefined for plain pretty-print.
 */
export function renderResponse(raw: string, spec?: ResponseSpec): string {
  let root: JsonNode
  try {
    root = JSON.parse(raw) as JsonNode
  } catch {
    return raw
  }
  if (!spec) return printPretty(raw)

  const node = lookupPath(root, spec.path ?? '')
  if (!node) return printPretty(raw)

  const out: string[] = []

  // List: node = { total, data: [...] }
  if (spec.listField) {
    const list = getList(node, spec.listField)
    const total = getInt(node, spec.totalField)
    if (total > 0 || list.length > 0) {
      out.push(`共 ${total} 条`)
      for (let i = 0; i < list.length; i++) {
        const item = list[i]
        if (item) {
          out.push(`--- 第 ${i + 1} 条 ---`)
          out.push(renderFields(item, spec.fields))
        }
      }
      return out.join('\n')
    }
  }

  // Simple record (or nested sub-list): header fields first, then sub-list.
  if (spec.listItemsField) {
    if (spec.fields && Object.keys(spec.fields).length > 0) {
      out.push(renderFields(node, spec.fields))
    }
    const items = getList(node, spec.listItemsField)
    if (items.length > 0) {
      out.push(`-- ${spec.listItemsField}（${items.length} 项）--`)
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item) {
          out.push(`--- 第 ${i + 1} 项 ---`)
          out.push(renderFields(item, spec.listItemsFields))
        }
      }
    }
    return out.join('\n')
  }

  out.push(renderFields(node, spec.fields))
  return out.join('\n')
}
