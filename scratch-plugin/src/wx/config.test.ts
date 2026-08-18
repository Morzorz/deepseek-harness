import { describe, it, expect, afterEach } from 'vitest'
import { WxConfig } from './config.ts'

describe('WxConfig env-key injection', () => {
  const saved = new Map<string, string | undefined>()
  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    saved.clear()
  })

  it('fills template values from WX_*_HMAC_KEY env vars', async () => {
    saved.set('WX_TEST_HMAC_KEY', process.env.WX_TEST_HMAC_KEY)
    saved.set('WX_TEST_GATEWAY', process.env.WX_TEST_GATEWAY)
    process.env.WX_TEST_HMAC_KEY = 'env-key-123'
    process.env.WX_TEST_GATEWAY = 'http://localhost:9090'
    const cfg = await WxConfig.load()
    // 环境变量注入发生在 getReadyEnv（getEnv 只返回模板原值）
    const env = await cfg.getReadyEnv('test')
    expect(env.hmac_key).toBe('env-key-123')
    expect(env.gateway).toBe('http://localhost:9090')
  })

  it('resolves missing keys lazily per environment (uat/pro not loaded when unused)', async () => {
    const cfg = await WxConfig.load()
    // 未设 uat/pro 的密钥也应能加载成功（惰性校验）
    expect(cfg.getEnv('uat')).toBeDefined()
  })

  it('getReadyEnv throws a Chinese error when the used env lacks keys', async () => {
    saved.set('WX_TEST_HMAC_KEY', process.env.WX_TEST_HMAC_KEY)
    saved.set('WX_TEST_GATEWAY', process.env.WX_TEST_GATEWAY)
    delete process.env.WX_TEST_HMAC_KEY
    delete process.env.WX_TEST_GATEWAY
    const cfg = await WxConfig.load()
    await expect(cfg.getReadyEnv('test')).rejects.toThrow(/密钥/)
  })
})
