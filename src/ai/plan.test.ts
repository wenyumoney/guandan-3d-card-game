import { describe, it, expect } from 'vitest'
import { planHand, structureCardIds } from './plan'
import { type Card } from '../core/cards'

let seq = 0
const C = (suit: Card['suit'], rank: Card['rank']): Card => ({ id: `${suit}-${rank}-${seq++}`, suit, rank })

describe('planHand 手牌拆分', () => {
  it('拆出顺子 + 对子，散张作单牌，总牌数守恒', () => {
    // 混色顺子 3-7（非同花顺）+ 一对 9 + 三张高单张
    const hand = [
      C('S', '3'), C('H', '4'), C('C', '5'), C('D', '6'), C('S', '7'),
      C('S', '9'), C('H', '9'),
      C('S', 'J'), C('C', 'K'), C('D', 'A'),
    ]
    const plan = planHand(hand, '2')
    const structures = plan.filter((m) => m.combo.length >= 2)
    expect(structures.some((m) => m.combo.type === 'straight')).toBe(true)
    expect(structures.some((m) => m.combo.type === 'pair' && m.combo.rank === 9)).toBe(true)
    expect(structures).toHaveLength(2)
    expect(plan.reduce((n, m) => n + m.cards.length, 0)).toBe(hand.length)
  })

  it('炸弹整块保留，不拆成对子', () => {
    const hand = [C('S', '9'), C('H', '9'), C('C', '9'), C('D', '9'), C('S', '3'), C('H', '4')]
    const plan = planHand(hand, '2')
    expect(plan.some((m) => m.combo.type === 'bomb' && m.combo.length === 4)).toBe(true)
    expect(plan.filter((m) => m.combo.type === 'pair')).toHaveLength(0)
  })

  it('structureCardIds 标记成型牌所属的牌（顺子5+对子2=7）', () => {
    const hand = [
      C('S', '3'), C('H', '4'), C('C', '5'), C('D', '6'), C('S', '7'),
      C('S', '9'), C('H', '9'),
      C('S', 'J'), C('C', 'K'), C('D', 'A'),
    ]
    expect(structureCardIds(hand, '2').size).toBe(7)
  })
})
