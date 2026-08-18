/**
 * WeCom environment config, ported from the Go `wx-cli`
 * (`bin/internal/config/config.go`).
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WxCliConfig, WxEnv } from './types.ts'

/** 内置配置模板（相对本文件；三套环境密钥/网关均为空）。 */
const TEMPLATE_ASSET = new URL('./wx-cli.conf.template.json', import.meta.url)

/** Loaded multi-environment config. */
export class WxConfig {
  readonly environments: Record<string, WxEnv>

  constructor(config: WxCliConfig) {
    this.environments = config.environments
  }

  /** 从模板 + 环境变量构建。base 缺省=内置模板；base 提供=读外部真实文件（保留调试覆盖）。 */
  static async load(base?: string): Promise<WxConfig> {
    const data = base
      ? await readFile(join(base, 'wx-cli.conf.json'), 'utf8')
      : await readFile(TEMPLATE_ASSET, 'utf8')
    const cfg = JSON.parse(data) as WxCliConfig
    if (!cfg.environments || Object.keys(cfg.environments).length === 0) {
      throw new Error('wx-cli.conf.json 未定义任何环境')
    }
    return new WxConfig(cfg)
  }

  /** Environment names, sorted. */
  envNames(): string[] {
    return Object.keys(this.environments).sort()
  }

  /** Get one environment; undefined when unknown. */
  getEnv(name: string): WxEnv | undefined {
    return this.environments[name]
  }

  /** 环境名与真实密钥/网关是否齐备（按需校验，部署时只配用到的环境即可）。 */
  async getReadyEnv(name: string): Promise<WxEnv> {
    const e = this.environments[name]
    if (!e) throw new Error(`未知环境 "${name}"（可用: ${this.envNames().join(', ')}）`)
    const envKey = name.toUpperCase()
    const hmacKey = process.env[`WX_${envKey}_HMAC_KEY`] ?? e.hmac_key
    const gateway = process.env[`WX_${envKey}_GATEWAY`] ?? e.gateway
    if (!hmacKey || !gateway) {
      throw new Error(
        `环境 ${name} 缺少密钥/网关：请设置 WX_${envKey}_HMAC_KEY、WX_${envKey}_GATEWAY 或提供真实 wx-cli.conf.json`,
      )
    }
    return { ...e, hmac_key: hmacKey, gateway }
  }
}
