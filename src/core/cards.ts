// ── 牌模型 ────────────────────────────────────────────────────────────────
// 掼蛋用 2 副牌 = 108 张（每副 52 普通牌 + 大小王各 1）。
// 花色 S♠ H♥ C♣ D♦；王用 suit='JOKER'，rank='sj'(小王/黑) | 'bj'(大王/红)。

export type Suit = 'S' | 'H' | 'C' | 'D'
export const SUITS: readonly Suit[] = ['S', 'H', 'C', 'D']

export type NormalRank =
  | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A'
export const NORMAL_RANKS: readonly NormalRank[] =
  ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']

export type JokerRank = 'sj' | 'bj'
export type Rank = NormalRank | JokerRank

export interface Card {
  /** 唯一物理牌 id，如 "H-7-0"（第 0 副的红桃 7）、"JOKER-bj-1"。 */
  readonly id: string
  readonly suit: Suit | 'JOKER'
  readonly rank: Rank
}

export const isJoker = (c: Card): boolean => c.suit === 'JOKER'

/** 花色序号（S=0 H=1 C=2 D=3），用于排序；王返回 4。 */
export function suitIndex(suit: Card['suit']): number {
  if (suit === 'JOKER') return 4
  return SUITS.indexOf(suit)
}

/** 生成一副 108 张的掼蛋牌堆（未洗）。 */
export function makeDeck(): Card[] {
  const cards: Card[] = []
  for (let d = 0; d < 2; d++) {
    for (const suit of SUITS) {
      for (const rank of NORMAL_RANKS) {
        cards.push({ id: `${suit}-${rank}-${d}`, suit, rank })
      }
    }
    cards.push({ id: `JOKER-sj-${d}`, suit: 'JOKER', rank: 'sj' })
    cards.push({ id: `JOKER-bj-${d}`, suit: 'JOKER', rank: 'bj' })
  }
  return cards
}

// ── 牌力 ──────────────────────────────────────────────────────────────────
// 单张自然序：2<3<…<K<A（掼蛋 2 最小，不沿用斗地主）；当前级牌抬升到 A 之上、王之下；小王<大王最大。

const BASE_POWER: Record<NormalRank, number> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10,
  J: 11, Q: 12, K: 13, A: 14,
}

export const LEVEL_POWER = 16
export const SMALL_JOKER_POWER = 17
export const BIG_JOKER_POWER = 18

/** 单张牌力（含级牌抬升与王）。level 为当前级数。 */
export function singlePower(c: Card, level: NormalRank): number {
  if (c.suit === 'JOKER') return c.rank === 'bj' ? BIG_JOKER_POWER : SMALL_JOKER_POWER
  if (c.rank === level) return LEVEL_POWER
  return BASE_POWER[c.rank as NormalRank]
}

/** 组合（对/三/炸）的代表点数——与单张牌力一致（级牌=16）。 */
export function groupRank(c: Card, level: NormalRank): number {
  return singlePower(c, level)
}

/** 逢人配：当前级数的红桃牌（万能牌）。2 副 → 共 2 张。 */
export function isWild(c: Card, level: NormalRank): boolean {
  return c.suit === 'H' && c.rank === level
}

// ── 顺子/连对/钢板 用的连续值 ────────────────────────────────────────────
// 序列里级牌按自然位置计（不抬升）；A 可作最大(14)或最小(1)；王不入顺。
const STRAIGHT_BASE: Record<NormalRank, number> = {
  A: 14, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  '10': 10, J: 11, Q: 12, K: 13,
}

/** 非王普通牌的连续值（A 记 14；调用方另试 A=1 处理 A2345）。 */
export function straightValue(c: Card): number {
  if (c.suit === 'JOKER') return NaN
  return STRAIGHT_BASE[c.rank as NormalRank]
}
