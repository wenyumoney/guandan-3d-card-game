import { describe, it, expect } from 'vitest'
import { deal, teamOf, partnerOf, SEATS } from './deal'

describe('发牌 deal', () => {
  it('4 家各 27 张，共 108', () => {
    const { hands } = deal(12345)
    for (const h of hands) expect(h).toHaveLength(27)
    expect(hands.flat()).toHaveLength(108)
  })

  it('无重复牌（id 全不同）', () => {
    const ids = new Set(deal(999).hands.flat().map((c) => c.id))
    expect(ids.size).toBe(108)
  })

  it('同种子 → 完全相同的发牌（可复现）', () => {
    const a = deal(42).hands.map((h) => h.map((c) => c.id))
    const b = deal(42).hands.map((h) => h.map((c) => c.id))
    expect(a).toEqual(b)
  })

  it('不同种子 → 不同发牌', () => {
    const a = deal(1).hands[0].map((c) => c.id).join(',')
    const b = deal(2).hands[0].map((c) => c.id).join(',')
    expect(a).not.toBe(b)
  })
})

describe('座位/队伍', () => {
  it('0/2 同队，1/3 同队', () => {
    expect(teamOf(0)).toBe(teamOf(2))
    expect(teamOf(1)).toBe(teamOf(3))
    expect(teamOf(0)).not.toBe(teamOf(1))
  })
  it('对家是 +2 座位', () => {
    expect(partnerOf(0)).toBe(2)
    expect(partnerOf(1)).toBe(3)
    expect(SEATS.map(partnerOf)).toEqual([2, 3, 0, 1])
  })
})
