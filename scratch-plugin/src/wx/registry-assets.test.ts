import { describe, it, expect } from 'vitest'
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

  it('keeps external wxHome override working for debug', async () => {
    const reg = await WxRegistry.load(process.env.WX_HOME ?? '/Users/yangjingting/develop/wokspace/GitWorkSpace/wx/bin')
    const ref = await reg.resolveBiz('purchase')
    expect(ref.system).toBe('purchase')
  })
})
