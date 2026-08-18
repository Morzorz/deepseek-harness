/**
 * 审批操作审计：把每条审批事件以 JSONL（每行一个 JSON 对象）形式追加到指定文件。
 *
 * 审计写入是尽力而为、非阻塞的：任何写入失败只会 console.warn，绝不会抛出——
 * 审计失败不得影响审批操作的正常返回。
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 把审批事件追加写入一个 JSONL 文件。 */
export class Auditor {
  constructor(private readonly filePath: string) {}

  /**
   * 追加一条审计事件。自动创建所在目录；写入失败时仅告警，不抛出。
   * @param entry 审计事件对象，序列化为一行 JSON。
   */
  async record(entry: Record<string, unknown>): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      await appendFile(this.filePath, JSON.stringify(entry) + '\n', 'utf8')
    } catch (e) {
      console.warn(`[audit] 写入审计日志失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}
