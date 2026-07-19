import { describe, it, expect } from 'vitest'
import {
  makeDeck, isJoker, isWild, singlePower, straightValue,
  LEVEL_POWER, BIG_JOKER_POWER, SMALL_JOKER_POWER,
  type Card,
} from './cards'

const C = (suit: Card['suit'], rank: Card['rank']): Card => ({ id: `${suit}-${rank}-t`, suit, rank })

describe('牌组 makeDeck', () => {
  it('恰好 108 张', () => {
    expect(makeDeck()).toHaveLength(108)
  })
  it('含 4 张王 (2 大 2 小)', () => {
    const deck = makeDeck()
    expect(deck.filter((c) => c.rank === 'bj')).toHaveLength(2)
    expect(deck.filter((c) => c.rank === 'sj')).toHaveLength(2)
    expect(deck.filter(isJoker)).toHaveLength(4)
  })
  it('每种(花色,点数)恰好 2 张', () => {
    const deck = makeDeck()
    expect(deck.filter((c) => c.suit === 'H' && c.rank === '7')).toHaveLength(2)
    expect(deck.filter((c) => c.suit === 'S' && c.rank === 'A')).toHaveLength(2)
  })
  it('所有 id 唯一', () => {
    const ids = new Set(makeDeck().map((c) => c.id))
    expect(ids.size).toBe(108)
  })
})

describe('单张牌力 singlePower（级数=2）', () => {
  const lv = '2' as const
  it('自然序 3<...<K<A', () => {
    expect(singlePower(C('S', '3'), lv)).toBeLessThan(singlePower(C('S', 'K'), lv))
    expect(singlePower(C('S', 'K'), lv)).toBeLessThan(singlePower(C('S', 'A'), lv))
  })
  it('级牌(2)抬升到 A 之上、王之下', () => {
    expect(singlePower(C('S', '2'), lv)).toBe(LEVEL_POWER)
    expect(singlePower(C('S', '2'), lv)).toBeGreaterThan(singlePower(C('S', 'A'), lv))
    expect(singlePower(C('S', '2'), lv)).toBeLessThan(singlePower(C('JOKER', 'sj'), lv))
  })
  it('小王<大王，均为最大', () => {
    expect(singlePower(C('JOKER', 'sj'), lv)).toBe(SMALL_JOKER_POWER)
    expect(singlePower(C('JOKER', 'bj'), lv)).toBe(BIG_JOKER_POWER)
    expect(singlePower(C('JOKER', 'sj'), lv)).toBeLessThan(singlePower(C('JOKER', 'bj'), lv))
  })
})

describe('单张牌力（级数=5：非级牌的 2 是最小单张）', () => {
  const lv = '5' as const
  it('2 自然最小，A 仅次于级牌', () => {
    expect(singlePower(C('S', '2'), lv)).toBeLessThan(singlePower(C('S', '3'), lv))
    expect(singlePower(C('S', 'A'), lv)).toBeGreaterThan(singlePower(C('S', 'K'), lv))
    expect(singlePower(C('S', '5'), lv)).toBe(LEVEL_POWER)
    expect(singlePower(C('S', '5'), lv)).toBeGreaterThan(singlePower(C('S', 'A'), lv))
  })
})

describe('逢人配 isWild', () => {
  it('红桃级牌是逢人配，其他花色级牌不是', () => {
    expect(isWild(C('H', '2'), '2')).toBe(true)
    expect(isWild(C('S', '2'), '2')).toBe(false)
    expect(isWild(C('H', '7'), '2')).toBe(false)
  })
})

describe('连续值 straightValue', () => {
  it('A=14，2=2，王=NaN', () => {
    expect(straightValue(C('S', 'A'))).toBe(14)
    expect(straightValue(C('S', '2'))).toBe(2)
    expect(Number.isNaN(straightValue(C('JOKER', 'bj')))).toBe(true)
  })
})
