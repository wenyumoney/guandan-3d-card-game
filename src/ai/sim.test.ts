import { describe, it, expect } from 'vitest'
import { remainingCards, dealUnseen, pruneCandidates, decideHard } from './sim'
import { decideHeuristic, type AIContext } from './ai'
import { mulberry32 } from '../core/rng'
import { makeDeck, type Card } from '../core/cards'
import { isBomb, type Combo } from '../core/combos'
import { deal, type Seat } from '../core/deal'

let seq = 0
const C = (suit: Card['suit'], rank: Card['rank']): Card => ({ id: `${suit}-${rank}-${seq++}`, suit, rank })
const single = (rank: number): Combo => ({ type: 'single', rank, length: 1 })

function ctx(over: Partial<AIContext>): AIContext {
  return {
    hand: [], table: null, leader: null, seat: 0, level: '2',
    handCounts: [27, 27, 27, 27], seen: [], ...over,
  }
}

// 测试用固定预算：maxDeterminizations 恒能跑满（deadline 放宽），保证跨机器确定性
const OPTS = { maxDeterminizations: 24, deadlineMs: 60_000 }
const key = (c: Card): string => `${c.suit}-${c.rank}`
const countBy = (cs: Card[]): Map<string, number> => {
  const m = new Map<string, number>()
  for (const c of cs) m.set(key(c), (m.get(key(c)) ?? 0) + 1)
  return m
}

describe('确定化 dealUnseen', () => {
  it('张数按 handCounts 分配，全体多重集 = 整副牌（无 seen 时）', () => {
    const hands0 = deal(42).hands
    const c = ctx({ hand: hands0[0] })
    const dealt = dealUnseen(c, mulberry32(1))
    expect(dealt[0].map((x) => x.id)).toEqual(hands0[0].map((x) => x.id))
    for (const s of [1, 2, 3]) expect(dealt[s]).toHaveLength(27)
    expect(countBy(dealt.flat())).toEqual(countBy(makeDeck()))
  })
  it('已见牌不再出现在想象牌局', () => {
    const c = ctx({
      hand: [C('S', '3')],
      seen: [C('JOKER', 'bj'), C('JOKER', 'bj')], // 两张大王都已打出
      handCounts: [1, 26, 27, 27],
    })
    const dealt = dealUnseen(c, mulberry32(2))
    expect(dealt.flat().filter((x) => x.rank === 'bj')).toHaveLength(0)
  })
  it('固定 seed 可复现', () => {
    const c = ctx({ hand: deal(7).hands[0] })
    const a = dealUnseen(c, mulberry32(9))
    const b = dealUnseen(c, mulberry32(9))
    expect(a.map((h) => h.map(key))).toEqual(b.map((h) => h.map(key)))
  })
})

describe('候选剪枝 pruneCandidates', () => {
  it('跟牌：每型留最弱+最强并追加过牌', () => {
    const c = ctx({
      hand: [C('S', '8'), C('H', '8'), C('S', '9'), C('H', '9'), C('S', 'J'), C('H', 'J')],
      table: { type: 'pair', rank: 7, length: 2 }, leader: 1,
    })
    const cands = pruneCandidates(c)
    expect(cands).toContain(null) // 过牌候选
    const pairs = cands.filter((m): m is NonNullable<typeof m> => m !== null && m.combo.type === 'pair')
    expect(pairs.map((m) => m.combo.rank).sort((a, b) => a - b)).toEqual([8, 11]) // 最弱 8 + 最强 J
  })
})

describe('decideHard 决策质量（固定 seed + 固定确定化数，带启发式基准=生产路径）', () => {
  const hard = (c: AIContext) => decideHard(c, { ...OPTS, baseline: decideHeuristic(c, 'hard') })

  it('终局收尾：对手快出完时 对K+单3 领出 → 先出对K（喂单3必被跑光）', () => {
    const c = ctx({
      hand: [C('S', 'K'), C('H', 'K'), C('S', '3')],
      handCounts: [3, 2, 10, 2], // 两侧对手各剩 2 张
      rng: mulberry32(11),
    })
    const m = hard(c)
    expect(m?.combo.type).toBe('pair')
    expect(m?.combo.rank).toBe(13)
  })
  it('早局不浪费炸弹：有散张可压时不炸 27 张对手的小单', () => {
    const c = ctx({
      hand: [C('S', '5'), C('H', '5'), C('C', '5'), C('D', '5'), C('S', '8'), C('S', '10'), C('S', 'Q')],
      table: single(6), leader: 1,
      handCounts: [7, 27, 27, 27],
      rng: mulberry32(12),
    })
    const m = decideHard(c, { maxDeterminizations: 48, deadlineMs: 60_000, baseline: decideHeuristic(c, 'hard') })
    expect(m).not.toBeNull()
    expect(isBomb(m!.combo)).toBe(false)
  })
  it('固定 seed 决策可复现', () => {
    const mk = (): AIContext => ctx({ hand: deal(5).hands[0], rng: mulberry32(21) })
    const a = hard(mk())
    const b = hard(mk())
    expect(a?.cards.map((x) => x.id)).toEqual(b?.cards.map((x) => x.id))
  })
  it('喂队友：队友 2 张时领小牌（小单/小对，不甩控制牌 K）', () => {
    const c = ctx({
      hand: [C('S', 'K'), C('S', '3'), C('H', '3')],
      handCounts: [3, 10, 2, 10], // 队友座2 剩 2 张
      rng: mulberry32(15),
    })
    const m = hard(c)
    expect(['single', 'pair']).toContain(m?.combo.type)
    expect(m!.combo.rank).toBeLessThanOrEqual(10) // 小牌喂/快走，不先甩 K
  })
  it('不盖队友：队友领牌时决策为过', () => {
    const c = ctx({
      hand: [C('S', '9'), C('H', '9'), C('C', '9'), C('D', '9')],
      table: { type: 'single', rank: 5, length: 1 }, leader: 2 as Seat, // 队友座2领单5
      handCounts: [4, 10, 2, 10],
      rng: mulberry32(16),
    })
    const m = hard(c)
    expect(m).toBeNull() // 有炸也不盖队友
  })
  it('满手领出：返回合法着法且不超时（性能冒烟 <500ms）', () => {
    const c = ctx({ hand: deal(3).hands[0], rng: mulberry32(31) })
    const t0 = Date.now()
    const m = decideHard(c) // 生产默认预算（220ms deadline）
    const dt = Date.now() - t0
    expect(m).not.toBeNull()
    expect(new Set(c.hand.map((x) => x.id)).size).toBe(27)
    for (const x of m!.cards) expect(c.hand.some((h) => h.id === x.id)).toBe(true)
    expect(dt).toBeLessThan(500)
  })
})

describe('remainingCards 记牌', () => {
  it('未见牌 = 整副 − seen − 手牌（按多重集）', () => {
    const hands0 = deal(1).hands
    const seen = hands0[1].slice(0, 5)
    const c = ctx({ hand: hands0[0], seen, handCounts: [27, 22, 27, 27] })
    const rem = remainingCards(c)
    expect(rem).toHaveLength(108 - 27 - 5)
    const total = countBy([...rem, ...seen, ...hands0[0]])
    expect(total).toEqual(countBy(makeDeck()))
  })
})
