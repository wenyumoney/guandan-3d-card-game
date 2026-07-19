// ── 三档 AI 策略 ────────────────────────────────────────────────────────
// easy   贪最小、不用炸、无视队友（会盖队友）
// normal 让队友、留炸（仅对手剩 1 张才炸）、跟最小非炸、领最小
// hard   确定化蒙特卡洛（sim.ts）：记牌发想象牌局 × 多副模拟到终局，选平均得分最高的着法

import { type Card, type NormalRank } from '../core/cards'
import { isBomb, type Combo } from '../core/combos'
import { generateMoves, generateBeating, type Move } from '../core/moves'
import { planHand, structureCardIds } from './plan'
import { partnerOf, type Seat } from '../core/deal'
import { decideHard, remainingCards } from './sim'

export type Difficulty = 'easy' | 'normal' | 'hard'

export interface AIContext {
  hand: Card[]
  table: Combo | null // 待压桌面牌（null=自由领出）
  leader: Seat | null // 桌面牌出牌者
  seat: Seat
  level: NormalRank
  handCounts: number[] // 各座剩余牌数
  seen?: Card[] // 已打出的牌（记牌用）
  finished?: Seat[] // 已出完的座位（名次序，hard 模拟用；缺省按 handCounts 推导）
  passes?: number // 本墩连续过牌数（hard 模拟用）
  rng?: () => number // 注入随机源（hard 确定化用；缺省按局面派生固定种子）
}

const byStrength = (a: Move, b: Move): number =>
  a.combo.rank - b.combo.rank || a.combo.length - b.combo.length
const weakest = (ms: Move[]): Move | null => (ms.length > 0 ? [...ms].sort(byStrength)[0] : null)
const splitBombs = (ms: Move[]): { nonBombs: Move[]; bombs: Move[] } => ({
  nonBombs: ms.filter((m) => !isBomb(m.combo)),
  bombs: ms.filter((m) => isBomb(m.combo)),
})

const opponentSeats = (seat: Seat): Seat[] => [((seat + 1) % 4) as Seat, ((seat + 3) % 4) as Seat]
const someOpponentClose = (ctx: AIContext, n: number): boolean =>
  opponentSeats(ctx.seat).some((s) => ctx.handCounts[s] <= n)

// —— 记牌：推断对手（剩余未见牌）能否用非炸压过某牌 ——
/** 剩余未见牌里是否存在能用**非炸**压过 combo 的着法（对手现实威胁）。 */
function remainingBeatsWith(rem: Card[], level: NormalRank, combo: Combo): boolean {
  return generateBeating(rem, level, combo).some((m) => !isBomb(m.combo))
}
function remainingBeats(ctx: AIContext, combo: Combo): boolean {
  return remainingBeatsWith(remainingCards(ctx), ctx.level, combo)
}

const CONTROL_POWER = 14 // ≥A（含级牌/王）视为控制牌，领牌时保留不早出

/** 跟牌：优先用不属于成型牌的散张来压，避免拆散结构；无散张可跟再退回最弱。 */
function followNonBomb(ctx: AIContext, nonBombs: Move[]): Move | null {
  const kept = structureCardIds(ctx.hand, ctx.level)
  const loose = nonBombs.filter((m) => m.cards.every((c) => !kept.has(c.id)))
  return weakest(loose.length > 0 ? loose : nonBombs)
}

/** 拆分式领牌（normal/hard）：优先领最弱成型牌高效走牌；无结构则领最弱非控制单张，保留控制牌与炸弹。 */
function leadFromPlan(ctx: AIContext): Move | null {
  const plan = planHand(ctx.hand, ctx.level)
  const structures = plan.filter((m) => !isBomb(m.combo) && m.combo.length >= 2)
  if (structures.length > 0) return weakest(structures)
  const singles = plan.filter((m) => m.combo.length === 1)
  const nonControl = singles.filter((m) => m.combo.rank < CONTROL_POWER)
  return weakest(nonControl.length > 0 ? nonControl : singles)
}

/** 领出决策。 */
function decideLead(ctx: AIContext, diff: Difficulty): Move | null {
  const all = generateMoves(ctx.hand, ctx.level)
  if (all.length === 0) return null
  const nonBombs = all.filter((m) => !isBomb(m.combo))
  const pool = nonBombs.length > 0 ? nonBombs : all

  if (diff === 'easy') return weakest(pool) // 弱档：领最弱（多为单张）

  // ── hard：队友配合（喂牌 + 控场）──
  if (diff === 'hard') {
    // 队友快出完 → 喂小单/小对让队友跑
    const p = partnerOf(ctx.seat)
    const partnerCount = ctx.handCounts[p]
    if (partnerCount <= 4 && partnerCount > 0) {
      const feedPool = nonBombs.filter((m) =>
        m.combo.type === 'single' || (m.combo.type === 'pair' && m.combo.rank <= 10))
      if (feedPool.length > 0) return weakest(feedPool)
    }
    // 控场：对手临近获胜 → 领不可（非炸）压的牌
    if (someOpponentClose(ctx, 3)) {
      const rem = remainingCards(ctx)
      const unbeatable = pool.filter((m) => !remainingBeatsWith(rem, ctx.level, m.combo))
      const pick = weakest(unbeatable)
      if (pick) return pick
    }
  }

  return leadFromPlan(ctx) ?? weakest(pool) // 拆分式；兜底（全炸手等）领最弱可用
}

/** 启发式决策（easy/normal 主路径；hard 的旧启发式保留作 sim 对照与测试基准）。 */
export function decideHeuristic(ctx: AIContext, diff: Difficulty): Move | null {
  if (ctx.table === null) return decideLead(ctx, diff)

  const beating = generateBeating(ctx.hand, ctx.level, ctx.table)
  if (beating.length === 0) return null
  const { nonBombs, bombs } = splitBombs(beating)
  const partnerLeads = ctx.leader === partnerOf(ctx.seat)

  if (diff === 'easy') return weakest(nonBombs) // 无视队友、不炸、可拆结构（弱档）

  if (partnerLeads) {
    if (diff === 'normal') return null // 让队友
    if (ctx.table.rank >= 14) return null // hard：队友的牌已够大（≥A），不盖
    // 受威胁才便宜顶一手（只用 <A 的散张，不动大牌）
    if (!remainingBeats(ctx, ctx.table)) return null
    const cheap = nonBombs.filter((m) => m.combo.rank < CONTROL_POWER)
    return followNonBomb(ctx, cheap)
  }

  // 对手领出
  const leaderCount = ctx.leader !== null ? ctx.handCounts[ctx.leader] : 99
  // hard：队友极少牌 + 桌面大 → 优先炸保队友（即便有非炸可跟）
  if (diff === 'hard' && bombs.length > 0 && ctx.table) {
    const p = partnerOf(ctx.seat)
    if (ctx.handCounts[p] <= 2 && ctx.handCounts[p] > 0 && ctx.table.rank >= 14 && leaderCount > 1) {
      return weakest(bombs)
    }
  }
  if (nonBombs.length > 0) return followNonBomb(ctx, nonBombs)
  if (bombs.length === 0) return null
  // 对手仅剩 1 张 → 无论桌面大小都必须炸（马上赢了）
  if (leaderCount <= 1) return weakest(bombs)
  // 对手 ≤3 张且桌面 ≥A → 值得炸；桌面小牌（如单 3）让队友处理即可
  if (diff === 'hard' && leaderCount <= 3 && ctx.table && ctx.table.rank >= 14) {
    return weakest(bombs)
  }
  // hard：桌面大 + 队友牌少 → 炸掉抢牌权保队友
  if (diff === 'hard') {
    const p = partnerOf(ctx.seat)
    if (ctx.handCounts[p] <= 4 && ctx.handCounts[p] > 0 && ctx.table && ctx.table.rank >= 14) {
      return weakest(bombs)
    }
  }
  return null
}

/** AI 决策：返回着法，null 表示过牌。hard = 蒙特卡洛评估，以旧启发式为稳健下限。 */
export function decideAction(ctx: AIContext, diff: Difficulty): Move | null {
  if (diff !== 'hard') return decideHeuristic(ctx, diff)
  return decideHard(ctx, { baseline: decideHeuristic(ctx, 'hard') })
}
