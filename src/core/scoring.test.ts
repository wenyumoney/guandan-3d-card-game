import { describe, it, expect } from 'vitest'
import {
  levelGain, advanceLevel, initMatch, applyRoundResult, computeTribute,
} from './scoring'
import { type Card } from './cards'

const C = (suit: Card['suit'], rank: Card['rank'], t = ''): Card => ({ id: `${suit}-${rank}-${t}`, suit, rank })

describe('升级 levelGain', () => {
  it('队友二游=+3', () => expect(levelGain([0, 2, 1, 3])).toBe(3))
  it('队友三游=+2', () => expect(levelGain([0, 1, 2, 3])).toBe(2))
  it('队友末游=+1', () => expect(levelGain([0, 1, 3, 2])).toBe(1))
})

describe('advanceLevel 封顶 A', () => {
  it('2 升 3 级到 5', () => expect(advanceLevel('2', 3)).toBe('5'))
  it('K 升 3 级封顶 A', () => expect(advanceLevel('K', 3)).toBe('A'))
})

describe('applyRoundResult 升级/过A/降级', () => {
  it('普通升级：team0 双下 2→5', () => {
    const m = applyRoundResult(initMatch(0), [0, 2, 1, 3])
    expect(m.levels[0]).toBe('5')
    expect(m.banker).toBe(0)
    expect(m.winner).toBeNull()
  })
  it('过A圆满：打A方拿头游即胜', () => {
    const start = { levels: ['A', '5'] as ['A', '5'], banker: 0 as const, aFails: [0, 0] as [number, number], winner: null }
    const m = applyRoundResult(start, [0, 2, 1, 3])
    expect(m.winner).toBe(0)
  })
  it('庄家在A被翻盘：记一次失败，未到阈值不降', () => {
    const start = { levels: ['A', 'K'] as ['A', 'K'], banker: 0 as const, aFails: [0, 0] as [number, number], winner: null }
    const m = applyRoundResult(start, [1, 3, 0, 2]) // team1 头游
    expect(m.aFails[0]).toBe(1)
    expect(m.levels[0]).toBe('A')
    expect(m.winner).toBeNull()
  })
  it('打A失败累计到3次降回K', () => {
    const start = { levels: ['A', 'Q'] as ['A', 'Q'], banker: 0 as const, aFails: [2, 0] as [number, number], winner: null }
    const m = applyRoundResult(start, [1, 3, 0, 2])
    expect(m.levels[0]).toBe('K')
    expect(m.aFails[0]).toBe(0)
  })
})

describe('进贡 computeTribute', () => {
  const base = (): Card[][] => [
    [C('S', '3', '0'), C('S', '8', '0'), C('S', '9', '0')],
    [C('S', 'Q', '1'), C('S', '5', '1'), C('S', '4', '1')],
    [C('S', '3', '2'), C('S', '6', '2'), C('S', '7', '2')],
    [C('S', 'K', '3'), C('S', '6', '3'), C('S', '7', '3')],
  ]

  it('双下双贡：按牌大小分（牌大→头游、牌小→二游）', () => {
    // finished [0,2,1,3]：team0 头游+二游(双下)。使三游(座1)持 2=级牌(16)，末游(座3)持 K=13
    // → 应座1(牌大)→头游0、座3(牌小)→二游2。rank-order 规则则相反（座3→头游）
    const hands: Card[][] = [
      [C('S', '3'), C('S', '8')],
      [C('S', '2'), C('S', '5')], // 座1 max=2(级牌16)
      [C('S', '4'), C('S', '7')],
      [C('S', 'K'), C('S', '6')], // 座3 max=K(13)
    ]
    const r = computeTribute([0, 2, 1, 3], hands, '2')
    expect(r.double).toBe(true)
    expect(r.kang).toBe(false)
    expect(r.transfers).toHaveLength(2)
    const t0 = r.transfers.find((t) => t.from === 1)!
    expect(t0.to).toBe(0)
    expect(t0.card.rank).toBe('2') // 座1 的 2(级牌16) > K(13) → 给头游
    const t1 = r.transfers.find((t) => t.from === 3)!
    expect(t1.to).toBe(2)
    expect(t1.card.rank).toBe('K') // 座3 的 K → 给二游
  })

  it('还贡：收贡方回一张 ≤10 的牌', () => {
    const r = computeTribute([0, 2, 1, 3], base(), '2')
    // head(0) 还给 mo(3)，最小 ≤10 = seat0 的 3
    const back = r.returns.find((t) => t.from === 0)!
    expect(back.to).toBe(3)
    expect(back.card.rank).toBe('3')
  })

  it('双下抗贡：败方合计持 2 大王 → 免贡', () => {
    const h = base()
    h[1] = [C('JOKER', 'bj', 'a'), C('S', '5', '1')]
    h[3] = [C('JOKER', 'bj', 'b'), C('S', '6', '3')]
    const r = computeTribute([0, 2, 1, 3], h, '2')
    expect(r.kang).toBe(true)
    expect(r.transfers).toHaveLength(0)
  })

  it('单贡：非双下时败方名次最差者向头游进贡', () => {
    // finished [0,1,2,3]：team0 头游(seat0)+三游(seat2)，败方 seat1、seat3；末游 seat3 进贡
    const r = computeTribute([0, 1, 2, 3], base(), '2')
    expect(r.double).toBe(false)
    expect(r.transfers).toHaveLength(1)
    expect(r.transfers[0].from).toBe(3)
    expect(r.transfers[0].to).toBe(0)
    expect(r.transfers[0].card.rank).toBe('K')
  })

  it('单贡抗贡：进贡方持 2 大王 → 免贡', () => {
    const h = base()
    h[3] = [C('JOKER', 'bj', 'a'), C('JOKER', 'bj', 'b'), C('S', '6', '3')]
    const r = computeTribute([0, 1, 2, 3], h, '2')
    expect(r.kang).toBe(true)
  })
})
