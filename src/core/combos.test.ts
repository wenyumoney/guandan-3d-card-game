import { describe, it, expect } from 'vitest'
import { getCombos, canFormCombo, beats, findStraightFlushGroups, type Combo, type ComboType } from './combos'
import { LEVEL_POWER, type Card } from './cards'

const C = (suit: Card['suit'], rank: Card['rank']): Card => ({ id: `${suit}-${rank}-${Math.random()}`, suit, rank })
const has = (cs: Combo[], type: ComboType, rank?: number, length?: number): boolean =>
  cs.some((c) => c.type === type && (rank === undefined || c.rank === rank) && (length === undefined || c.length === length))

const cb = (type: ComboType, rank: number, length: number): Combo => ({ type, rank, length })

describe('单张', () => {
  it('普通单张点数正确', () => {
    expect(getCombos([C('S', '3')], '2')).toEqual([cb('single', 3, 1)])
  })
  it('逢人配单张 = 级牌(16)', () => {
    expect(has(getCombos([C('H', '2')], '2'), 'single', LEVEL_POWER)).toBe(true)
  })
})

describe('对子（含逢人配）', () => {
  it('两张同点成对', () => {
    expect(has(getCombos([C('S', '7'), C('H', '7')], '2'), 'pair', 7)).toBe(true)
  })
  it('不同点不成对', () => {
    expect(has(getCombos([C('S', '7'), C('C', '8')], '2'), 'pair')).toBe(false)
  })
  it('逢人配 + 单张 → 该点对子', () => {
    // 级数2 → H2 是逢人配；配 S7 成对7
    expect(canFormCombo([C('H', '2'), C('S', '7')], 'pair', 7, '2')).toBe(true)
  })
  it('逢人配不能与王成对（王不可被替代/配王）', () => {
    expect(canFormCombo([C('H', '2'), C('JOKER', 'bj')], 'pair', 18, '2')).toBe(false)
  })
})

describe('三张 / 炸弹（含逢人配）', () => {
  it('三张同点成三同张', () => {
    const cs = getCombos([C('S', '7'), C('H', '7'), C('C', '7')], '2')
    expect(has(cs, 'triple', 7, 3)).toBe(true)
  })
  it('逢人配补三张也可成三同张', () => {
    expect(canFormCombo([C('S', '7'), C('C', '7'), C('H', '2')], 'triple', 7, '2')).toBe(true)
  })
  it('四张炸弹', () => {
    const cs = getCombos([C('S', '7'), C('H', '7'), C('C', '7'), C('D', '7')], '2')
    expect(has(cs, 'bomb', 7, 4)).toBe(true)
  })
  it('五张炸弹（含逢人配）', () => {
    // 4张真7 + 逢人配 → 5炸
    expect(canFormCombo([C('S', '7'), C('H', '7'), C('C', '7'), C('D', '7'), C('H', '2')], 'bomb', 7, '2', 5)).toBe(true)
  })
})

describe('三带二', () => {
  it('三张7 + 一对9', () => {
    const cs = getCombos([C('S', '7'), C('H', '7'), C('C', '7'), C('S', '9'), C('H', '9')], '2')
    expect(has(cs, 'triple_pair', 7)).toBe(true)
  })
  it('五张同点是炸弹而非三带二', () => {
    const cs = getCombos([C('S', '7'), C('H', '7'), C('C', '7'), C('D', '7'), C('S', '7')], '2')
    expect(has(cs, 'bomb', 7, 5)).toBe(true)
    expect(has(cs, 'triple_pair')).toBe(false)
  })
  it('三张7 无对搭：可成三同张', () => {
    const cs = getCombos([C('S', '7'), C('H', '7'), C('C', '7')], '2')
    expect(has(cs, 'triple', 7, 3)).toBe(true)
  })
})

describe('顺子', () => {
  it('34567 顺子，最大值7', () => {
    const cs = getCombos([C('S', '3'), C('H', '4'), C('S', '5'), C('C', '6'), C('D', '7')], '2')
    expect(has(cs, 'straight', 7, 5)).toBe(true)
  })
  it('A2345（A 作最小，级数K 避免与逢人配冲突）', () => {
    const cs = getCombos([C('S', 'A'), C('S', '2'), C('S', '3'), C('S', '4'), C('D', '5')], 'K')
    expect(has(cs, 'straight', 5)).toBe(true)
  })
  it('10JQKA（A 作最大）', () => {
    const cs = getCombos([C('S', '10'), C('H', 'J'), C('S', 'Q'), C('C', 'K'), C('D', 'A')], '2')
    expect(has(cs, 'straight', 14)).toBe(true)
  })
  it('逢人配补顺子空档', () => {
    // 3 4 _ 6 7 + 逢人配(H2) → 34567
    expect(canFormCombo([C('S', '3'), C('H', '4'), C('H', '2'), C('C', '6'), C('D', '7')], 'straight', 7, '2')).toBe(true)
  })
  it('含王不能组顺子', () => {
    const cs = getCombos([C('S', '3'), C('H', '4'), C('S', '5'), C('C', '6'), C('JOKER', 'bj')], '2')
    expect(has(cs, 'straight')).toBe(false)
  })
  it('KA2 不连（无环绕）', () => {
    const cs = getCombos([C('S', 'Q'), C('S', 'K'), C('S', 'A'), C('S', '2'), C('D', '3')], '5')
    expect(has(cs, 'straight')).toBe(false)
  })
})

describe('木板(连对) / 钢板(连三)', () => {
  it('334455 连对，最大值5', () => {
    const cs = getCombos([C('S', '3'), C('H', '3'), C('S', '4'), C('H', '4'), C('S', '5'), C('H', '5')], '2')
    expect(has(cs, 'tube', 5, 6)).toBe(true)
  })
  it('333444 钢板，最大值4', () => {
    const cs = getCombos([C('S', '3'), C('H', '3'), C('C', '3'), C('S', '4'), C('H', '4'), C('C', '4')], '2')
    expect(has(cs, 'plate', 4, 6)).toBe(true)
  })
})

describe('同花顺 / 天王炸', () => {
  it('同花 34567 同时是同花顺(炸)与顺子', () => {
    const cs = getCombos([C('S', '3'), C('S', '4'), C('S', '5'), C('S', '6'), C('S', '7')], '2')
    expect(has(cs, 'straight_flush', 7)).toBe(true)
    expect(has(cs, 'straight', 7)).toBe(true)
  })
  it('混花不是同花顺', () => {
    const cs = getCombos([C('S', '3'), C('H', '4'), C('S', '5'), C('C', '6'), C('D', '7')], '2')
    expect(has(cs, 'straight_flush')).toBe(false)
  })
  it('2大2小王 = 天王炸', () => {
    const cs = getCombos([C('JOKER', 'sj'), C('JOKER', 'sj'), C('JOKER', 'bj'), C('JOKER', 'bj')], '2')
    expect(has(cs, 'joker_bomb')).toBe(true)
  })
})

describe('压制 beats', () => {
  it('炸弹压任意非炸弹', () => {
    expect(beats(cb('bomb', 3, 4), cb('straight', 14, 5))).toBe(true)
    expect(beats(cb('straight', 14, 5), cb('bomb', 3, 4))).toBe(false)
  })
  it('张数多的炸弹更大', () => {
    expect(beats(cb('bomb', 3, 5), cb('bomb', 14, 4))).toBe(true)
  })
  it('同花顺位阶介于5炸与6炸之间', () => {
    expect(beats(cb('straight_flush', 5, 5), cb('bomb', 14, 5))).toBe(true) // 同花顺 > 5炸
    expect(beats(cb('bomb', 3, 6), cb('straight_flush', 14, 5))).toBe(true) // 6炸 > 同花顺
  })
  it('天王炸最大', () => {
    expect(beats(cb('joker_bomb', 1000, 4), cb('bomb', 14, 8))).toBe(true)
  })
  it('同型比点数', () => {
    expect(beats(cb('pair', 8, 2), cb('pair', 7, 2))).toBe(true)
    expect(beats(cb('pair', 7, 2), cb('pair', 8, 2))).toBe(false)
  })
  it('异型（非炸）互不压制', () => {
    expect(beats(cb('straight', 14, 5), cb('pair', 3, 2))).toBe(false)
  })
  it('同点不算压过（须严格大于）', () => {
    expect(beats(cb('pair', 7, 2), cb('pair', 7, 2))).toBe(false)
  })
})

describe('同花顺扫描（理牌）', () => {
  const ids = (g: Card[]): string[] => g.map((c) => c.id)

  it('天然同花顺成组且升序', () => {
    const run = [C('S', '5'), C('S', '6'), C('S', '7'), C('S', '8'), C('S', '9')]
    const gs = findStraightFlushGroups([...run, C('D', '3'), C('C', 'K')], '2')
    expect(gs).toHaveLength(1)
    expect(ids(gs[0])).toEqual(ids(run))
  })
  it('混花连张不成组', () => {
    expect(findStraightFlushGroups([C('S', '5'), C('H', '6'), C('S', '7'), C('D', '8'), C('S', '9')], '2')).toHaveLength(0)
  })
  it('逢人配补 1 缺，配插在被替代槽位', () => {
    const wild = C('H', '2')
    const gs = findStraightFlushGroups([C('S', '5'), C('S', '6'), C('S', '8'), C('S', '9'), wild], '2')
    expect(gs).toHaveLength(1)
    expect(gs[0][2].id).toBe(wild.id) // 替代 ♠7
  })
  it('A 作小（A2345）', () => {
    const a = C('D', 'A')
    const gs = findStraightFlushGroups([a, C('D', '2'), C('D', '3'), C('D', '4'), C('D', '5')], 'K')
    expect(gs).toHaveLength(1)
    expect(gs[0][0].id).toBe(a.id)
  })
  it('A 作大（10JQKA）', () => {
    const a = C('C', 'A')
    const gs = findStraightFlushGroups([C('C', '10'), C('C', 'J'), C('C', 'Q'), C('C', 'K'), a], '2')
    expect(gs).toHaveLength(1)
    expect(gs[0][4].id).toBe(a.id)
  })
  it('双副两组不共享牌', () => {
    const hand: Card[] = []
    for (const r of ['5', '6', '7', '8', '9'] as const) hand.push(C('S', r), C('S', r))
    const gs = findStraightFlushGroups(hand, '2')
    expect(gs).toHaveLength(2)
    expect(new Set([...ids(gs[0]), ...ids(gs[1])]).size).toBe(10)
  })
  it('有天然顺时不浪费配', () => {
    const wild = C('H', '2')
    const gs = findStraightFlushGroups(
      [C('S', '5'), C('S', '6'), C('S', '7'), C('S', '8'), C('S', '9'), wild], '2')
    expect(gs).toHaveLength(1)
    expect(ids(gs[0])).not.toContain(wild.id)
  })
  it('♥级牌可按本位参与天然同花顺', () => {
    const gs = findStraightFlushGroups(
      [C('H', '5'), C('H', '6'), C('H', '7'), C('H', '8'), C('H', '9')], '9')
    expect(gs).toHaveLength(1)
    expect(gs[0][4].rank).toBe('9')
  })
  it('缺 2 不补（每组至多 1 配）', () => {
    expect(findStraightFlushGroups(
      [C('S', '5'), C('S', '6'), C('S', '7'), C('H', '2'), C('H', '2')], '2')).toHaveLength(0)
  })
  it('王不入顺；配可补 A 槽', () => {
    const wild = C('H', '2')
    const gs = findStraightFlushGroups(
      [C('S', '10'), C('S', 'J'), C('S', 'Q'), C('S', 'K'), wild, C('JOKER', 'bj')], '2')
    expect(gs).toHaveLength(1)
    expect(gs[0][4].id).toBe(wild.id)
  })
  it('两张配各补一组', () => {
    const gs = findStraightFlushGroups(
      [C('S', '2'), C('S', '3'), C('S', '4'), C('S', '5'),
       C('D', '7'), C('D', '8'), C('D', '9'), C('D', '10'),
       C('H', 'K'), C('H', 'K')], 'K')
    expect(gs).toHaveLength(2)
    expect(gs[0].filter((c) => c.rank === 'K').length).toBe(1)
    expect(gs[1].filter((c) => c.rank === 'K').length).toBe(1)
  })
})
