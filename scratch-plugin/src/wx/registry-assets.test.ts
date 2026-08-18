import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WxRegistry } from './registry.ts'

describe('registry bundled assets', () => {
  it('loads from bundled assets without wxHome', async () => {
    const reg = await WxRegistry.load()
    const ref = await reg.resolveBiz('purchase.generay')
    expect(ref.system).toBe('purchase')
    expect(ref.bizKey).toBe('generay')
  })

  it('resolves liquidity and xincontract from bundled assets', async () => {
    const reg = await WxRegistry.load()
    await expect(reg.resolveBiz('liquidity.flm')).resolves.toBeTruthy()
    await expect(reg.resolveBiz('xincontract.xincontract')).resolves.toBeTruthy()
  })
})

// external wxHome override 供调试的路径：用自包含临时 fixture（不依赖开发机上的 wx 仓库绝对路径）。
describe('registry external wxHome override', () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wx-reg-'))
    await mkdir(join(dir, 'registry'), { recursive: true })
    await writeFile(
      join(dir, 'wx-cli.biz.json'),
      JSON.stringify({ systems: { purchase: { file: 'registry/purchase.json', name: '采购系统' } } }),
      'utf8',
    )
    await writeFile(
      join(dir, 'registry', 'purchase.json'),
      JSON.stringify({ name: '采购系统', bizs: { generay: { name: '普通采购' } } }),
      'utf8',
    )
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('loads from an external base dir when provided (debug override)', async () => {
    const reg = await WxRegistry.load(dir)
    const ref = await reg.resolveBiz('purchase')
    expect(ref.system).toBe('purchase')
    expect(ref.bizKey).toBe('generay')
  })
})
