// ── 牌型识别与比较 ──────────────────────────────────────────────────────
// 设计：getCombos(cards, level) 枚举一组牌的所有合法牌型解释。
//  - 逢人配（红桃级牌）作万能牌填充任意非王点数；
//  - 王不入顺子/连对/钢板，且不可被逢人配替代；
//  - 炸弹族（bomb / straight_flush / joker_bomb）可压任意非炸弹，内部按位阶比较。

import {
  isJoker, isWild, singlePower, straightValue, suitIndex, SUITS,
  LEVEL_POWER, SMALL_JOKER_POWER, BIG_JOKER_POWER,
  type Card, type NormalRank, type Suit,
} from './cards'

export type ComboType =
  | 'single'
  | 'pair'
  | 'triple'
  | 'triple_pair' // 三带二（三张 + 一对）
  | 'straight'    // 顺子（5 张连续单）
  | 'tube'        // 木板/连对（3 连对 = 6 张）
  | 'plate'       // 钢板（2 连三 = 6 张）
  | 'bomb'        // n 同张（n≥4）
  | 'straight_flush' // 同花顺（5 张同花连续）
  | 'joker_bomb'  // 天王炸（2 大 2 小王）

export interface Combo {
  type: ComboType
  /** 同型比较用的代表点数（n 同张=点数，顺子族=最大连续值）。 */
  rank: number
  /** 牌数（炸弹按张数比位阶；顺子=5，连对/钢板=6）。 */
  length: number
}

const JOKER_BOMB_RANK = 1000

// —— 组合工具 ——
function choose<T>(arr: T[], k: number): T[][] {
  const res: T[][] = []
  const rec = (start: number, cur: T[]): void => {
    if (cur.length === k) { res.push(cur.slice()); return }
    for (let i = start; i < arr.length; i++) { cur.push(arr[i]); rec(i + 1, cur); cur.pop() }
  }
  rec(0, [])
  return res
}

/**
 * 把 group 当作 |group| 同张时，可实现的代表点数集合。
 * 非逢人配牌须点数一致；逢人配可填充（但不能填充王）。
 */
function nKindRankOptions(group: Card[], level: NormalRank): Set<number> {
  const nonWild = group.filter((c) => !isWild(c, level))
  if (nonWild.length === 0) {
    const s = new Set<number>()
    for (let r = 2; r <= LEVEL_POWER; r++) s.add(r) // 全逢人配：2..级牌(16)
    return s
  }
  const powers = new Set(nonWild.map((c) => singlePower(c, level)))
  if (powers.size !== 1) return new Set()
  const R = [...powers][0]
  if (R === SMALL_JOKER_POWER || R === BIG_JOKER_POWER) {
    if (group.length > nonWild.length) return new Set() // 逢人配不能配王
  }
  return new Set([R])
}

/** 顺子族：跨度 span、每级重数 mult 的连续牌可实现的最大连续值列表。 */
function runTops(cards: Card[], span: number, mult: number, level: NormalRank): number[] {
  const tops: number[] = []
  if (cards.length !== span * mult) return tops
  if (cards.some(isJoker)) return tops
  const nonWild = cards.filter((c) => !isWild(c, level))
  const w = cards.length - nonWild.length
  for (let s = 1; s + span - 1 <= 14; s++) {
    const top = s + span - 1
    const slots = new Map<number, number>()
    let ok = true
    for (const c of nonWild) {
      let v = straightValue(c) // A=14
      if (s === 1 && c.rank === 'A') v = 1 // A 作最小（A2345）
      if (v < s || v > top) { ok = false; break }
      const cur = (slots.get(v) ?? 0) + 1
      if (cur > mult) { ok = false; break }
      slots.set(v, cur)
    }
    if (!ok) continue
    if (span * mult - nonWild.length === w) tops.push(top) // 逢人配恰好补足
  }
  return tops
}

function straightFlushTops(cards: Card[], level: NormalRank): number[] {
  if (cards.length !== 5) return []
  if (cards.some(isJoker)) return []
  const nonWild = cards.filter((c) => !isWild(c, level))
  const suits = new Set(nonWild.map((c) => c.suit))
  if (suits.size > 1) return [] // 非逢人配牌须同花
  return runTops(cards, 5, 1, level)
}

function triplePairCombos(cards: Card[], level: NormalRank): Combo[] {
  const res: Combo[] = []
  if (cards.length !== 5) return res
  const idx = [0, 1, 2, 3, 4]
  const seen = new Set<number>()
  for (const c3 of choose(idx, 3)) {
    const triple = c3.map((i) => cards[i])
    const pair = idx.filter((i) => !c3.includes(i)).map((i) => cards[i])
    const tOpts = nKindRankOptions(triple, level)
    const pOpts = nKindRankOptions(pair, level)
    for (const R of tOpts) {
      let ok = false
      for (const S of pOpts) if (S !== R) { ok = true; break }
      if (ok && !seen.has(R)) { seen.add(R); res.push({ type: 'triple_pair', rank: R, length: 5 }) }
    }
  }
  return res
}

/** 枚举一组牌的所有合法牌型解释（去重）。 */
export function getCombos(cards: Card[], level: NormalRank): Combo[] {
  const n = cards.length
  const out: Combo[] = []
  if (n === 0) return out

  if (n === 1) {
    const c = cards[0]
    const rank = isWild(c, level) ? LEVEL_POWER : singlePower(c, level)
    out.push({ type: 'single', rank, length: 1 })
    return out
  }

  // 天王炸
  if (n === 4 && cards.every(isJoker)) {
    const sj = cards.filter((c) => c.rank === 'sj').length
    const bj = cards.filter((c) => c.rank === 'bj').length
    if (sj === 2 && bj === 2) out.push({ type: 'joker_bomb', rank: JOKER_BOMB_RANK, length: 4 })
  }

  // n 同张：对 / 三同张 / 炸
  if (n === 2) for (const R of nKindRankOptions(cards, level)) out.push({ type: 'pair', rank: R, length: 2 })
  if (n === 3) for (const R of nKindRankOptions(cards, level)) out.push({ type: 'triple', rank: R, length: 3 })
  if (n >= 4) for (const R of nKindRankOptions(cards, level)) out.push({ type: 'bomb', rank: R, length: n })

  // 三带二
  if (n === 5) out.push(...triplePairCombos(cards, level))

  // 顺子族
  if (n === 5) for (const t of runTops(cards, 5, 1, level)) out.push({ type: 'straight', rank: t, length: 5 })
  if (n === 6) for (const t of runTops(cards, 3, 2, level)) out.push({ type: 'tube', rank: t, length: 6 })
  if (n === 6) for (const t of runTops(cards, 2, 3, level)) out.push({ type: 'plate', rank: t, length: 6 })
  if (n === 5) for (const t of straightFlushTops(cards, level)) out.push({ type: 'straight_flush', rank: t, length: 5 })

  // 去重
  const seen = new Set<string>()
  return out.filter((c) => {
    const k = `${c.type}:${c.rank}:${c.length}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** 这组牌能否组成指定牌型(可选指定张数)。 */
export function canFormCombo(
  cards: Card[], type: ComboType, rank: number, level: NormalRank, length?: number,
): boolean {
  return getCombos(cards, level).some(
    (c) => c.type === type && c.rank === rank && (length === undefined || c.length === length),
  )
}

/** 从选中的一组牌里，找出所有能压过 incumbent 的合法牌型解释。 */
export function beatingCombos(cards: Card[], incumbent: Combo, level: NormalRank): Combo[] {
  return getCombos(cards, level).filter((c) => beats(c, incumbent))
}

/** 这组牌能否压过 incumbent（用于跟牌合法性）。 */
export function canBeatWith(cards: Card[], incumbent: Combo, level: NormalRank): boolean {
  return beatingCombos(cards, incumbent, level).length > 0
}

const BOMB_TYPES = new Set<ComboType>(['bomb', 'straight_flush', 'joker_bomb'])
export const isBomb = (c: Combo): boolean => BOMB_TYPES.has(c.type)

/** 炸弹位阶：4炸<5炸<同花顺<6炸<7炸<8炸<天王炸。 */
export function bombTier(c: Combo): number {
  if (c.type === 'joker_bomb') return JOKER_BOMB_RANK
  if (c.type === 'straight_flush') return 5.5
  return c.length // 普通炸弹按张数
}

/** challenger 能否压过 incumbent。 */
export function beats(challenger: Combo, incumbent: Combo): boolean {
  const chB = isBomb(challenger)
  const inB = isBomb(incumbent)
  if (chB && !inB) return true
  if (!chB && inB) return false
  if (chB && inB) {
    const t1 = bombTier(challenger)
    const t2 = bombTier(incumbent)
    if (t1 !== t2) return t1 > t2
    return challenger.rank > incumbent.rank
  }
  // 均非炸弹：须同型同长，比点数
  if (challenger.type !== incumbent.type) return false
  if (challenger.length !== incumbent.length) return false
  return challenger.rank > incumbent.rank
}

// ── 理牌用：同花顺扫描 ──────────────────────────────────────────────────
/**
 * 从整手牌中扫出互不相交的同花顺组（供理牌展示，非出牌校验）。
 * 规则：先耗尽天然同花顺，再用剩余逢人配每组至多补 1 缺；
 * A 可作大或小，顶张从高到低贪心（10JQKA 优先于 A2345）；王不入顺。
 * 返回组按 (顶张升序, 花色序升序) 排列，组内升序，配插在被替代槽位。
 */
export function findStraightFlushGroups(cards: Card[], level: NormalRank): Card[][] {
  // 建池：suit → 连续值 → 牌数组（id 升序，取牌恒 shift → 双副重复牌确定消耗）
  const pool = new Map<Suit, Map<number, Card[]>>()
  for (const s of SUITS) pool.set(s, new Map())
  for (const c of cards) {
    if (isJoker(c)) continue // 王不入顺
    const m = pool.get(c.suit as Suit)!
    const v = straightValue(c) // A 恒存 14；♥级牌第一遍按本位入池（天然优先，不浪费配）
    const arr = m.get(v)
    if (arr) arr.push(c)
    else m.set(v, [c])
  }
  for (const m of pool.values()) for (const arr of m.values()) arr.sort((a, b) => a.id.localeCompare(b.id))

  // 槽位取值：A 作小仅出现在 v=1 的窗口（映射回 14 的池格）
  const cell = (suit: Suit, v: number): Card[] | undefined => pool.get(suit)!.get(v === 1 ? 14 : v)

  const groups: { top: number; suit: Suit; cards: Card[] }[] = []

  // 第一遍：纯天然（每花色顶张从高到低扫，同窗口 while 到耗尽）
  for (const suit of SUITS) {
    for (let s = 10; s >= 1; s--) {
      const vals = [s, s + 1, s + 2, s + 3, s + 4]
      while (vals.every((v) => (cell(suit, v)?.length ?? 0) > 0)) {
        groups.push({ top: s + 4, suit, cards: vals.map((v) => cell(suit, v)!.shift()!) })
      }
    }
  }

  // 抽出剩余逢人配（♥级牌，≤2 张）作补缺癞子
  const wilds: Card[] = []
  const hMap = pool.get('H')!
  for (const [v, arr] of hMap) {
    const keep = arr.filter((c) => !isWild(c, level))
    wilds.push(...arr.filter((c) => isWild(c, level)))
    if (keep.length) hMap.set(v, keep)
    else hMap.delete(v)
  }
  wilds.sort((a, b) => a.id.localeCompare(b.id))

  // 第二遍：找「恰缺 1 槽」的窗口用配补上；成组后从头重扫（双副同窗口可补两组）
  const fillOne = (): boolean => {
    for (const suit of SUITS) {
      for (let s = 10; s >= 1; s--) {
        const vals = [s, s + 1, s + 2, s + 3, s + 4]
        const missing = vals.filter((v) => (cell(suit, v)?.length ?? 0) === 0)
        if (missing.length !== 1) continue
        groups.push({
          top: s + 4, suit,
          cards: vals.map((v) => (v === missing[0] ? wilds.shift()! : cell(suit, v)!.shift()!)),
        })
        return true
      }
    }
    return false
  }
  while (wilds.length > 0 && fillOne()) { /* 补到无缺可补 */ }

  groups.sort((a, b) => a.top - b.top || suitIndex(a.suit) - suitIndex(b.suit))
  return groups.map((g) => g.cards)
}
