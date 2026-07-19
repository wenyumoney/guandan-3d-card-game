// ── 计分：进贡还贡 / 升级 / 过A / 胜负 ────────────────────────────────────
// 所有「可配置」项按需求书默认值（见 DEFAULT_SCORING）。地区细则差异见注释。

import {
  isWild, singlePower, straightValue, type Card, type NormalRank,
} from './cards'
import { teamOf, type Seat } from './deal'

export interface ScoringConfig {
  /** 进贡是否排除红桃逢人配（默认 true）。 */
  excludeWildFromTribute: boolean
  /** 打 A 连续失败几次降级（默认 3）。 */
  maxAFails: number
  /** 打 A 失败降回的级数（默认 K）。 */
  aDropTo: NormalRank
}
export const DEFAULT_SCORING: ScoringConfig = {
  excludeWildFromTribute: true,
  maxAFails: 3,
  aDropTo: 'K',
}

// —— 升级 ——
const LEVEL_SEQ: readonly NormalRank[] =
  ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']

export function advanceLevel(r: NormalRank, gain: number): NormalRank {
  const i = Math.min(LEVEL_SEQ.indexOf(r) + gain, LEVEL_SEQ.length - 1)
  return LEVEL_SEQ[i]
}

/** 升几级：头游队友二游=+3，三游=+2，末游=+1。 */
export function levelGain(finished: Seat[]): 1 | 2 | 3 {
  const head = teamOf(finished[0])
  const partnerPos = finished.findIndex((s, i) => i > 0 && teamOf(s) === head)
  if (partnerPos === 1) return 3
  if (partnerPos === 2) return 2
  return 1
}

// —— 一整局对局（match）状态 ——
export interface MatchState {
  levels: [NormalRank, NormalRank] // 各队级数
  banker: 0 | 1 // 本局级牌归属（上一局头游方）
  aFails: [number, number] // 各队打 A 失败次数
  winner: 0 | 1 | null
}

export function initMatch(banker: 0 | 1 = 0): MatchState {
  return { levels: ['2', '2'], banker, aFails: [0, 0], winner: null }
}

/** 结算一局：更新级数、庄家、打 A 失败、胜负。 */
export function applyRoundResult(
  m: MatchState, finished: Seat[], cfg: ScoringConfig = DEFAULT_SCORING,
): MatchState {
  const next: MatchState = {
    levels: [...m.levels] as [NormalRank, NormalRank],
    banker: m.banker,
    aFails: [...m.aFails] as [number, number],
    winner: m.winner,
  }
  const winTeam = teamOf(finished[0])

  // 过 A 圆满：打 A 的队伍拿到头游即获胜
  if (m.levels[winTeam] === 'A') {
    next.winner = winTeam
    next.banker = winTeam
    return next
  }

  // 庄家在 A 却被翻盘：记一次打 A 失败，累计到阈值降级
  if (m.levels[m.banker] === 'A' && winTeam !== m.banker) {
    next.aFails[m.banker]++
    if (next.aFails[m.banker] >= cfg.maxAFails) {
      next.levels[m.banker] = cfg.aDropTo
      next.aFails[m.banker] = 0
    }
  }

  next.levels[winTeam] = advanceLevel(m.levels[winTeam], levelGain(finished))
  next.banker = winTeam
  return next
}

// —— 进贡 / 还贡 ——
export interface TributeTransfer { from: Seat; to: Seat; card: Card }
export interface TributeResult {
  double: boolean // 双下双贡
  kang: boolean // 抗贡（持 2 大王）
  transfers: TributeTransfer[] // 进贡
  returns: TributeTransfer[] // 还贡（建议：收贡方回一张 ≤10）
}

function biggestSingleCard(hand: Card[], level: NormalRank, excludeWild: boolean): Card {
  const pool = excludeWild ? hand.filter((c) => !isWild(c, level)) : hand
  const src = pool.length > 0 ? pool : hand
  return src.reduce((best, c) => (singlePower(c, level) > singlePower(best, level) ? c : best))
}

function countBigJokers(hand: Card[]): number {
  return hand.filter((c) => c.rank === 'bj').length
}

/** 还贡建议：收贡方(from) 回一张 ≤10 的牌给进贡方(to)，默认给最小的。 */
function suggestReturn(from: Seat, to: Seat, hands: Card[][], level: NormalRank): TributeTransfer {
  const returnable = hands[from].filter((c) => c.suit !== 'JOKER' && straightValue(c) <= 10)
  const pool = returnable.length > 0 ? returnable : hands[from]
  const card = pool.reduce((best, c) => (singlePower(c, level) < singlePower(best, level) ? c : best))
  return { from, to, card }
}

/**
 * 依上一局名次计算进贡/还贡（作用于新一局手牌）。
 * - 双下（头游+二游同队）→ 双贡：末游→头游、三游→二游。
 * - 否则单贡：败方名次最差者 → 头游。
 * - 抗贡：进贡方持 2 大王免贡。
 */
export function computeTribute(
  finished: Seat[], hands: Card[][], level: NormalRank, cfg: ScoringConfig = DEFAULT_SCORING,
): TributeResult {
  const winTeam = teamOf(finished[0])
  const losers = finished.filter((s) => teamOf(s) !== winTeam)
  const isDouble = teamOf(finished[2]) !== winTeam && teamOf(finished[3]) !== winTeam
  const ex = cfg.excludeWildFromTribute

  if (isDouble) {
    const loserBigJokers = losers.reduce<number>((n, s) => n + countBigJokers(hands[s]), 0)
    if (loserBigJokers >= 2) return { double: true, kang: true, transfers: [], returns: [] }
    const [head, er] = finished
    const [la, lb] = losers
    const ca = biggestSingleCard(hands[la], level, ex)
    const cb = biggestSingleCard(hands[lb], level, ex)
    // 牌大者→头游，牌小者→二游（按 biggestSingleCard 的 singlePower 比较）
    const ap = singlePower(ca, level)
    const bp = singlePower(cb, level)
    const bigSeat = ap >= bp ? la : lb
    const smallSeat = ap >= bp ? lb : la
    const bigCard = ap >= bp ? ca : cb
    const smallCard = ap >= bp ? cb : ca
    return {
      double: true,
      kang: false,
      transfers: [
        { from: bigSeat, to: head, card: bigCard },
        { from: smallSeat, to: er, card: smallCard },
      ],
      returns: [suggestReturn(head, bigSeat, hands, level), suggestReturn(er, smallSeat, hands, level)],
    }
  }

  const payer = losers[losers.length - 1] // 败方中名次最差者
  const head = finished[0]
  if (countBigJokers(hands[payer]) >= 2) return { double: false, kang: true, transfers: [], returns: [] }
  return {
    double: false,
    kang: false,
    transfers: [{ from: payer, to: head, card: biggestSingleCard(hands[payer], level, ex) }],
    returns: [suggestReturn(head, payer, hands, level)],
  }
}
