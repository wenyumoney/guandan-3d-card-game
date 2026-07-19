import { describe, it, expect } from 'vitest'
import { generateMoves, generateBeating, playableCardIds, type Move } from './moves'
import { getCombos, type Combo, type ComboType } from './combos'
import { type Card } from './cards'

let seq = 0
const C = (suit: Card['suit'], rank: Card['rank']): Card => ({ id: `${suit}-${rank}-${seq++}`, suit, rank })
const has = (ms: Move[], type: ComboType, rank?: number, length?: number): boolean =>
  ms.some((m) => m.combo.type === type && (rank === undefined || m.combo.rank === rank) && (length === undefined || m.combo.length === length))
const cb = (type: ComboType, rank: number, length: number): Combo => ({ type, rank, length })

describe('着法生成 generateMoves', () => {
  it('单张：每张牌可作单张', () => {
    const ms = generateMoves([C('S', '3'), C('S', '9')], '2')
    expect(has(ms, 'single', 3)).toBe(true)
    expect(has(ms, 'single', 9)).toBe(true)
  })

  it('对/三/炸：四张7 生成对7、三同7、四炸7', () => {
    const ms = generateMoves([C('S', '7'), C('H', '7'), C('C', '7'), C('D', '7')], '2')
    expect(has(ms, 'pair', 7, 2)).toBe(true)
    expect(has(ms, 'triple', 7, 3)).toBe(true)
    expect(has(ms, 'bomb', 7, 4)).toBe(true)
  })

  it('逢人配组对：S7 + 逢人配 → 对7', () => {
    const ms = generateMoves([C('S', '7'), C('H', '2')], '2') // 级数2，H2 逢人配
    expect(has(ms, 'pair', 7, 2)).toBe(true)
  })

  it('顺子 34567', () => {
    const ms = generateMoves([C('S', '3'), C('H', '4'), C('S', '5'), C('C', '6'), C('D', '7')], '2')
    expect(has(ms, 'straight', 7, 5)).toBe(true)
  })

  it('三张7+一对9 → 三带二 + 三同张', () => {
    const ms = generateMoves([C('S', '7'), C('H', '7'), C('C', '7'), C('S', '9'), C('H', '9')], '2')
    expect(has(ms, 'triple_pair', 7)).toBe(true)
    expect(has(ms, 'triple', 7, 3)).toBe(true)
  })

  it('逢人配补顺子空档 34_67', () => {
    const ms = generateMoves([C('S', '3'), C('H', '4'), C('H', '2'), C('C', '6'), C('D', '7')], '2')
    expect(has(ms, 'straight', 7, 5)).toBe(true)
  })

  it('连对 334455 / 钢板 333444', () => {
    const tube = generateMoves([C('S', '3'), C('H', '3'), C('S', '4'), C('H', '4'), C('S', '5'), C('H', '5')], '2')
    expect(has(tube, 'tube', 5, 6)).toBe(true)
    const plate = generateMoves([C('S', '3'), C('H', '3'), C('C', '3'), C('S', '4'), C('H', '4'), C('C', '4')], '2')
    expect(has(plate, 'plate', 4, 6)).toBe(true)
  })

  it('同花顺 + 天王炸', () => {
    const sf = generateMoves([C('S', '3'), C('S', '4'), C('S', '5'), C('S', '6'), C('S', '7')], '2')
    expect(has(sf, 'straight_flush', 7, 5)).toBe(true)
    const jb = generateMoves([C('JOKER', 'sj'), C('JOKER', 'sj'), C('JOKER', 'bj'), C('JOKER', 'bj')], '2')
    expect(has(jb, 'joker_bomb')).toBe(true)
  })

  it('三带二 777+99', () => {
    const ms = generateMoves([C('S', '7'), C('H', '7'), C('C', '7'), C('S', '9'), C('H', '9')], '2')
    expect(has(ms, 'triple_pair', 7)).toBe(true)
  })

  it('自洽：所有生成着法的牌确实能组成其声明牌型', () => {
    const hand = [
      C('S', '3'), C('H', '3'), C('S', '4'), C('S', '5'), C('C', '6'),
      C('D', '7'), C('S', '9'), C('H', '9'), C('C', '9'), C('H', '2'),
    ]
    const ms = generateMoves(hand, '2')
    expect(ms.length).toBeGreaterThan(0)
    for (const m of ms) {
      const ok = getCombos(m.cards, '2').some(
        (c) => c.type === m.combo.type && c.rank === m.combo.rank && c.length === m.combo.length,
      )
      expect(ok).toBe(true)
    }
  })
})

describe('压制着法 generateBeating', () => {
  it('对8 能压对7', () => {
    expect(has(generateBeating([C('S', '8'), C('H', '8')], '2', cb('pair', 7, 2)), 'pair', 8)).toBe(true)
  })
  it('对3 压不过对7', () => {
    expect(generateBeating([C('S', '3'), C('H', '3')], '2', cb('pair', 7, 2))).toHaveLength(0)
  })
  it('炸弹能压非炸弹（顺子）', () => {
    const bomb = [C('S', '9'), C('H', '9'), C('C', '9'), C('D', '9')]
    expect(has(generateBeating(bomb, '2', cb('straight', 14, 5)), 'bomb', 9, 4)).toBe(true)
  })
})

describe('可参与压牌 playableCardIds', () => {
  it('同点第三张也可选（对7 只需两张，但三张 7 都能参与）', () => {
    const cards = [C('S', '7'), C('H', '7'), C('C', '7'), C('S', '3')]
    const ids = playableCardIds(cards, '2', cb('pair', 6, 2))
    expect(ids.has(cards[0].id)).toBe(true)
    expect(ids.has(cards[1].id)).toBe(true)
    expect(ids.has(cards[2].id)).toBe(true)
    expect(ids.has(cards[3].id)).toBe(false) // 3 压不过，仍置灰
  })
  it('双副重复牌两张都可选', () => {
    const cards = [C('S', '5'), C('S', '5')]
    const ids = playableCardIds(cards, '2', cb('single', 4, 1))
    expect(ids.size).toBe(2)
  })
  it('naturals 够时逢人配也可选（可顶替结对）', () => {
    const cards = [C('S', '7'), C('D', '7'), C('H', '2')] // 级数2，H2 逢人配
    const ids = playableCardIds(cards, '2', cb('pair', 6, 2))
    expect(ids.has(cards[2].id)).toBe(true) // 配 + 单7 也是对7
  })
  it('两花色同顶张同花顺都可选（去重不吞另一花色）', () => {
    const s = ['3', '4', '5', '6', '7'] as const
    const cards = [...s.map((r) => C('S', r)), ...s.map((r) => C('H', r))]
    const ids = playableCardIds(cards, '2', cb('bomb', 14, 4)) // 只有同花顺压得过4炸
    expect(ids.size).toBe(10)
  })
  it('无可压着法 → 空集合', () => {
    expect(playableCardIds([C('S', '3'), C('S', '4')], '2', cb('pair', 13, 2)).size).toBe(0)
  })
})
