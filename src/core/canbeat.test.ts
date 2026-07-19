import { describe, it, expect } from 'vitest'
import { beatingCombos, canBeatWith, type Combo } from './combos'
import { type Card } from './cards'

const C = (suit: Card['suit'], rank: Card['rank']): Card => ({ id: `${suit}-${rank}-${Math.random()}`, suit, rank })
const cb = (type: Combo['type'], rank: number, length: number): Combo => ({ type, rank, length })

describe('跟牌能否压过 canBeatWith', () => {
  it('大一点的对子能压', () => {
    expect(canBeatWith([C('S', '8'), C('H', '8')], cb('pair', 7, 2), '2')).toBe(true)
  })
  it('小的对子压不过', () => {
    expect(canBeatWith([C('S', '3'), C('H', '3')], cb('pair', 7, 2), '2')).toBe(false)
  })
  it('手里的炸弹能压非炸弹', () => {
    const bomb = [C('S', '9'), C('H', '9'), C('C', '9'), C('D', '9')]
    expect(canBeatWith(bomb, cb('straight', 14, 5), '2')).toBe(true)
  })
  it('逢人配帮忙组成更大的对子来压', () => {
    // 级数2：H2 逢人配 + S9 → 对9，压对7
    expect(canBeatWith([C('H', '2'), C('S', '9')], cb('pair', 7, 2), '2')).toBe(true)
  })
  it('异型（非炸）压不过', () => {
    expect(canBeatWith([C('S', '3'), C('H', '3')], cb('single', 14, 1), '2')).toBe(false)
  })
  it('beatingCombos 返回具体可压牌型', () => {
    const res = beatingCombos([C('S', '8'), C('H', '8')], cb('pair', 7, 2), '2')
    expect(res).toContainEqual(cb('pair', 8, 2))
  })
})
