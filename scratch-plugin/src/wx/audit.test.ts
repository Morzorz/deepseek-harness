import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Auditor } from './audit.ts'

describe('Auditor', () => {
  it('appends JSONL lines with account, action and outcome', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audit-'))
    const a = new Auditor(join(dir, 'audit.jsonl'))
    await a.record({ account: 'u1', biz: 'purchase.generay', orderNumber: 'PR1', action: 'approve', outcome: 'success' })
    const text = await readFile(join(dir, 'audit.jsonl'), 'utf8')
    expect(text).toContain('"account":"u1"')
    expect(text).toContain('"action":"approve"')
  })

  it('creates the directory automatically', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audit-'))
    const a = new Auditor(join(dir, 'nested', 'deeper', 'audit.jsonl'))
    await a.record({ account: 'u1', biz: 'b', orderNumber: 'P1', action: 'reject', outcome: 'success' })
    const text = await readFile(join(dir, 'nested', 'deeper', 'audit.jsonl'), 'utf8')
    expect(text).toContain('"action":"reject"')
  })

  it('does not throw when the write fails (warn only, non-blocking)', async () => {
    const a = new Auditor('/nonexistent-root-xyz/audit.jsonl')  // 不会存在的目录
    await expect(a.record({ account: 'u1', biz: 'b', orderNumber: 'P1', action: 'approve', outcome: 'success' })).resolves.toBeUndefined()
  })
})
