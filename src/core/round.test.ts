import { describe, it, expect } from 'vitest'
import { createRound, play, pass, validatePlay, type RoundState } from './round'
import { type Combo } from './combos'
import { type Card } from './cards'
import { type Seat } from './deal'

const C = (suit: Card['suit'], rank: Card['rank'], tag = ''): Card => ({ id: `${suit}-${rank}-${tag}`, suit, rank })
const single = (rank: number): Combo => ({ type: 'single', rank, length: 1 })

function mkRound(hands: Card[][], first: Seat = 0): RoundState {
  return createRound(hands, '2', first)
}

describe('自由领出不能过牌', () => {
  it('table 为 null 时 pass 被拒', () => {
    const s = mkRound([[C('S', '5')], [C('S', '9')], [C('S', '7')], [C('S', '3')]])
    const r = pass(s, 0)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('自由领出')
  })
})

describe('完整一局 → 名次', () => {
  it('单张速通产生 [头,二,三,末]', () => {
    const s = mkRound([[C('S', '5')], [C('S', '9')], [C('S', '7')], [C('S', '3')]], 0)
    expect(play(s, 0, [C('S', '5')], single(5)).ok).toBe(true) // 座0 出完 → 头游
    expect(s.finished).toEqual([0])
    expect(s.current).toBe(1)

    expect(play(s, 1, [C('S', '9')], single(9)).ok).toBe(true) // 座1 压5 出完 → 二游
    expect(s.finished).toEqual([0, 1])
    expect(s.current).toBe(2)

    expect(pass(s, 2).ok).toBe(true) // 座2 S7 压不过9
    expect(pass(s, 3).ok).toBe(true) // 座3 S3 压不过9 → 一圈过完
    // 收牌方座1已出完 → 接风：牌权交其队友座3 自由领出
    expect(s.table).toBeNull()
    expect(s.current).toBe(3)

    expect(play(s, 3, [C('S', '3')], single(3)).ok).toBe(true) // 座3 出完 → 三游，局终，座2 末游
    expect(s.over).toBe(true)
    expect(s.finished).toEqual([0, 1, 3, 2])
  })
})

describe('双下即终局：同队两人先出完立即结束', () => {
  it('座0(头游) + 座2(同队二游出完) → 立即 over，败方不再出牌', () => {
    // 每人 1 张牌，座0 领出单9 出完；座1-3 都过→接风：牌权归其队友座2
    // 座2 自由领出单A 出完→同队双下！
    const s = mkRound([
      [C('S', '9')],   // 座0 单9
      [C('S', '3')],   // 座1 单3
      [C('S', 'A')],   // 座2 单A
      [C('S', '4')],   // 座3 单4
    ], 0)
    // 座0 领单9 出完
    expect(play(s, 0, [C('S', '9')], single(9)).ok).toBe(true)
    expect(s.finished).toEqual([0])
    // 座1-3 都过（都压不过9）
    expect(pass(s, 1).ok).toBe(true) // → 座2
    expect(pass(s, 2).ok).toBe(true) // → 座3
    expect(pass(s, 3).ok).toBe(true) // 一圈过完 → 接风
    // 接风：领牌者座0已出完 → 牌权交其队友座2 自由领出
    expect(s.table).toBeNull()
    expect(s.current).toBe(2)
    expect(play(s, 2, [C('S', 'A')], single(14)).ok).toBe(true)
    expect(s.over).toBe(true)
    expect(s.finished.length).toBe(4)
    expect(s.finished[0]).toBe(0)
    expect(s.finished[1]).toBe(2)
  })
})

describe('收牌权：全过回到收牌方自由领出', () => {
  it('leader 仍有牌时重获自由领出', () => {
    const s = mkRound(
      [
        [C('S', '5'), C('S', '3')],
        [C('S', '6'), C('S', '4')],
        [C('S', '7'), C('S', 'Q')],
        [C('S', '8'), C('S', 'K')],
      ],
      0,
    )
    expect(play(s, 0, [C('S', '5')], single(5)).ok).toBe(true)
    expect(pass(s, 1).ok).toBe(true)
    expect(pass(s, 2).ok).toBe(true)
    expect(pass(s, 3).ok).toBe(true) // 一圈过完
    expect(s.table).toBeNull()
    expect(s.leader).toBe(0)
    expect(s.current).toBe(0) // 座0 重获自由领出
  })
})

describe('非法出牌拒绝', () => {
  const hands = (): Card[][] => [[C('S', '5')], [C('S', '9')], [C('S', '7')], [C('S', '3')]]
  it('未轮到该玩家', () => {
    const s = mkRound(hands(), 0)
    expect(validatePlay(s, 1, [C('S', '9')], single(9)).ok).toBe(false)
  })
  it('所选牌不在手中', () => {
    const s = mkRound(hands(), 0)
    const r = validatePlay(s, 0, [C('S', 'K')], single(13))
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('不在手中')
  })
  it('压不过桌面牌', () => {
    const s = mkRound(hands(), 0)
    play(s, 0, [C('S', '5')], single(5))
    // 座1 试图用更小的单张压（构造一个压不过的场景）
    const r = validatePlay(s, 1, [C('S', '9')], single(4)) // 声明 rank4 与实际不符 + 也压不过
    expect(r.ok).toBe(false)
  })
})
