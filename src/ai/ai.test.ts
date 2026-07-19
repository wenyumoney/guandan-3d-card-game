import { describe, it, expect } from 'vitest'
import { decideAction, decideHeuristic, type AIContext, type Difficulty } from './ai'
import { type Combo } from '../core/combos'
import { type Card } from '../core/cards'

let seq = 0
const C = (suit: Card['suit'], rank: Card['rank']): Card => ({ id: `${suit}-${rank}-${seq++}`, suit, rank })
const single = (rank: number): Combo => ({ type: 'single', rank, length: 1 })

function ctx(over: Partial<AIContext>): AIContext {
  return {
    hand: [], table: null, leader: null, seat: 0, level: '2',
    handCounts: [27, 27, 27, 27], seen: [], ...over,
  }
}
const act = (c: AIContext, d: Difficulty) => decideAction(c, d)

describe('队友配合：简单会盖队友，普通/困难让牌', () => {
  const base = () => ctx({ hand: [C('S', '6')], table: single(5), leader: 2 }) // 座2=队友领出单5
  it('easy 盖队友（出单6）', () => {
    expect(act(base(), 'easy')?.combo.rank).toBe(6)
  })
  it('normal 让队友（过）', () => {
    expect(act(base(), 'normal')).toBeNull()
  })
})

describe('用炸时机：普通留炸，困难对手临近获胜时用炸', () => {
  // 对手座1 领出单A(14)，仅四炸9能压；座1 只剩 2 张
  const base = () => ctx({
    hand: [C('S', '9'), C('H', '9'), C('C', '9'), C('D', '9')],
    table: single(14), leader: 1, handCounts: [27, 2, 27, 27],
  })
  it('normal 留炸（过）', () => {
    expect(act(base(), 'normal')).toBeNull()
  })
  it('hard 用炸控场', () => {
    const m = act(base(), 'hard')
    expect(m?.combo.type).toBe('bomb')
    expect(m?.combo.rank).toBe(9)
  })
})

describe('困难档记牌：队友弱牌受威胁则保，安全则让', () => {
  it('队友领单5、高牌仍在场 → hard 保这手(出单6)', () => {
    const c = ctx({ hand: [C('S', '6')], table: single(5), leader: 2, seen: [] })
    expect(act(c, 'hard')?.combo.rank).toBe(6)
  })
  it('队友领大王、无非炸能压 → hard 让牌不浪费炸弹', () => {
    const c = ctx({
      hand: [C('S', '9'), C('H', '9'), C('C', '9'), C('D', '9')],
      table: single(18), leader: 2,
    })
    expect(act(c, 'hard')).toBeNull()
  })
})

describe('控场启发式（decideHeuristic 旧 hard 基准）：对手临近获胜时领不可压的强牌', () => {
  const base = () => ctx({ hand: [C('S', '3'), C('JOKER', 'bj')], table: null, handCounts: [27, 2, 27, 27] })
  it('normal 领最小(单3)', () => {
    expect(act(base(), 'normal')?.combo.rank).toBe(3)
  })
  it('启发式 hard 领不可压的大王', () => {
    expect(decideHeuristic(base(), 'hard')?.combo.rank).toBe(18)
  })
})

describe('压不过时一律过牌', () => {
  it('手里没有能压的牌 → 各档都过', () => {
    const c = ctx({ hand: [C('S', '3')], table: single(14), leader: 1 })
    expect(act(c, 'easy')).toBeNull()
    expect(act(c, 'normal')).toBeNull()
    expect(act(c, 'hard')).toBeNull()
  })
})

describe('领出：默认领最小非炸', () => {
  it('普通领最小单张', () => {
    const c = ctx({ hand: [C('S', '9'), C('S', '3'), C('S', '7')], table: null })
    expect(act(c, 'normal')?.combo.rank).toBe(3)
  })
})

describe('拆分式领牌：有成型牌时普通/困难领成型牌，简单仍丢最小单张', () => {
  // 一对 3 + 高单张 A：普通/困难应领对子高效走牌，不丢控制牌 A
  const base = () => ctx({ hand: [C('S', '3'), C('H', '3'), C('S', 'A')], table: null })
  it('normal 领对子（非单张 A）', () => {
    const m = act(base(), 'normal')
    expect(m?.combo.type).toBe('pair')
    expect(m?.cards.length).toBe(2)
  })
  it('hard 领对子', () => {
    expect(act(base(), 'hard')?.combo.type).toBe('pair')
  })
  it('easy 仍丢最小单张（弱档）', () => {
    const m = act(base(), 'easy')
    expect(m?.combo.type).toBe('single')
    expect(m?.combo.rank).toBe(3)
  })
})

describe('拆分式跟牌：普通/困难不拆散成型牌，简单会拆', () => {
  // 一对 5（成型）+ 散张 8；桌面单 4。散张 8 能压且不拆对，最小的压牌是拆对出 5。
  const base = () => ctx({ hand: [C('S', '5'), C('H', '5'), C('S', '8')], table: single(4), leader: 1 })
  it('normal 用散张 8 保住对 5', () => {
    expect(act(base(), 'normal')?.combo.rank).toBe(8)
  })
  it('hard 用散张 8 保住对 5', () => {
    expect(act(base(), 'hard')?.combo.rank).toBe(8)
  })
  it('easy 拆对出最小单 5（弱档）', () => {
    expect(act(base(), 'easy')?.combo.rank).toBe(5)
  })
})

describe('队友配合：hard 领牌喂队友 + 跟对手时保队友', () => {
  it('队友 3 张时领小牌喂队友（小单/小对，不甩控制牌 K、不炸）', () => {
    const c = ctx({
      hand: [C('S', 'K'), C('S', '3'), C('H', '3')],
      table: null,
      handCounts: [3, 10, 3, 10], // 队友座2 剩 3 张
    })
    const m = act(c, 'hard')
    expect(m).not.toBeNull()
    expect(['single', 'pair']).toContain(m!.combo.type)
    expect(m!.combo.rank).toBeLessThanOrEqual(10) // 出小牌，不先甩 K
  })
  it('对手领A + 队友2张 + 持炸 → 炸掉抢牌权保队友', () => {
    const c = ctx({
      hand: [C('S', '9'), C('H', '9'), C('C', '9'), C('D', '9')],
      table: single(14), leader: 1, // 对手领单A
      handCounts: [4, 10, 2, 10], // 队友座2 剩 2 张
    })
    const m = act(c, 'hard')
    expect(m?.combo.type).toBe('bomb')
  })
})
