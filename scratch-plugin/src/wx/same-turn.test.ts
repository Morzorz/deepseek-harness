import { describe, it, expect } from 'vitest'
import { SameTurnGuard } from './same-turn.ts'

describe('SameTurnGuard', () => {
  it('rejects same-turn approve+confirm and allows next turn', () => {
    let turn = 1
    const guard = new SameTurnGuard(() => turn)
    expect(guard.isSameTurn('a1')).toBe(false)  // 未记录
    guard.recordApprove('a1')                    // 当前 turn=1
    expect(guard.isSameTurn('a1')).toBe(true)    // 同轮 -> 拒绝
    turn = 2
    expect(guard.isSameTurn('a1')).toBe(false)   // 下轮 -> 放行
  })
})
