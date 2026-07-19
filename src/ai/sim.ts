// ── hard 档 AI：确定化蒙特卡洛（DMC） ──────────────────────────────────
// 思路：按记牌算出未见牌 → 随机发给另外三家成「想象牌局」；每个候选着法
// 在多副想象牌局里用轻量启发式打完整局，按己队名次得分，选平均分最高。
// 同一副想象牌局评完所有候选（公共随机数降方差）；deadline 截断保预算。

import {
  makeDeck, isJoker, isWild, singlePower, straightValue,
  LEVEL_POWER, SMALL_JOKER_POWER, BIG_JOKER_POWER,
  type Card, type NormalRank, type Suit,
} from '../core/cards'
import { beats, isBomb, bombTier, type Combo, type ComboType } from '../core/combos'
import { generateMoves, generateBeating, type Move } from '../core/moves'
import { play, pass, type RoundState } from '../core/round'
import { SEATS, partnerOf, teamOf, type Seat } from '../core/deal'
import { levelGain } from '../core/scoring'
import { mulberry32, shuffleInPlace } from '../core/rng'
import { type AIContext } from './ai'

export interface SimOptions {
  deadlineMs?: number // 决策总预算（默认 220ms，在 GameSession 700ms 出牌延时窗口内）
  maxDeterminizations?: number // 想象牌局数上限
  baseline?: Move | null // 稳健基准着法（如旧启发式）：MC 需明显更优才偏离；缺省纯 MC
}

const byStrength = (a: Move, b: Move): number =>
  a.combo.rank - b.combo.rank || a.combo.length - b.combo.length

// —— 记牌：整副牌减去已见（打出 + 自己手牌）＝未见牌（合成 id，仅模拟内用） ——
function keyOf(suit: Suit | 'JOKER', rank: string): string {
  return suit === 'JOKER' ? `J-${rank}` : `${suit}-${rank}`
}

export function remainingCards(ctx: AIContext): Card[] {
  const counts = new Map<string, number>()
  for (const c of makeDeck()) counts.set(keyOf(c.suit, c.rank), (counts.get(keyOf(c.suit, c.rank)) ?? 0) + 1)
  for (const c of [...(ctx.seen ?? []), ...ctx.hand]) {
    const k = keyOf(c.suit, c.rank)
    const v = counts.get(k) ?? 0
    if (v > 0) counts.set(k, v - 1)
  }
  const out: Card[] = []
  let id = 0
  for (const [k, n] of counts) {
    for (let i = 0; i < n; i++) {
      if (k.startsWith('J-')) out.push({ id: `r${id++}`, suit: 'JOKER', rank: k.slice(2) as 'sj' | 'bj' })
      else {
        const dash = k.indexOf('-')
        out.push({ id: `r${id++}`, suit: k.slice(0, dash) as Suit, rank: k.slice(dash + 1) as NormalRank })
      }
    }
  }
  return out
}

/** 确定化：未见牌随机发给另外三家（按各家剩余张数），自己座位放真实手牌。 */
export function dealUnseen(ctx: AIContext, rng: () => number): Card[][] {
  const unseen = shuffleInPlace(remainingCards(ctx), rng)
  const hands: Card[][] = [[], [], [], []]
  let k = 0
  for (const s of SEATS) {
    if (s === ctx.seat) { hands[s] = ctx.hand.slice(); continue }
    hands[s] = unseen.slice(k, k + ctx.handCounts[s])
    k += ctx.handCounts[s]
  }
  return hands
}

// —— 候选剪枝：每型留最弱（兜底走法）+ 部分最强（炸弹留最弱最强，单/对留最强施压）——
const PRUNE_LIMIT = 8 // 总候选上限（压预算集中到少量候选，提升评估精度）
const PRUNE_STRONG_TYPES = new Set<ComboType>(['single', 'pair', 'triple', 'bomb', 'straight_flush'])

export function pruneCandidates(ctx: AIContext): (Move | null)[] {
  let all = ctx.table
    ? generateBeating(ctx.hand, ctx.level, ctx.table)
    : generateMoves(ctx.hand, ctx.level)
  // 跟牌候选约束：把明显亏的着法挡在候选之外（MC 噪声防线）
  if (ctx.table) {
    const partnerLeads = ctx.leader === partnerOf(ctx.seat)
    if (partnerLeads) {
      if (ctx.table.rank >= 14) return [null] // 队友的牌已够大（≥A）→ 让队友走
      all = all.filter((m) => !isBomb(m.combo) && m.combo.rank < 14) // 只许便宜顶，不动大牌/炸弹
    } else {
      // 对手领牌：炸弹仅在值得时入候选
      const leaderCount = ctx.leader !== null ? ctx.handCounts[ctx.leader] : 99
      const partnerCount = ctx.handCounts[partnerOf(ctx.seat)]
      // 任何情况下都允许炸：对手马上赢 / 对炸 / 队友岌岌可危
      const alwaysBomb = leaderCount <= 1 || isBomb(ctx.table) ||
        (partnerCount <= 2 && partnerCount > 0 && ctx.table && ctx.table.rank >= 14)
      // 无非要命时才可炸（无散张可压为前提）
      const nonBombsExist = all.some((m) => !isBomb(m.combo))
      const bombOk = alwaysBomb || (!nonBombsExist && (ctx.table.rank >= 14 || leaderCount <= 3 || (partnerCount <= 4 && partnerCount > 0)))
      if (!bombOk) all = all.filter((m) => !isBomb(m.combo))
    }
  }
  const groups = new Map<string, Move[]>()
  for (const m of all) {
    const k = `${m.combo.type}:${m.combo.length}`
    const g = groups.get(k)
    if (g) g.push(m)
    else groups.set(k, [m])
  }
  const weak: Move[] = []
  const strong: Move[] = []
  for (const g of groups.values()) {
    g.sort(byStrength)
    weak.push(g[0])
    if (g.length > 1 && PRUNE_STRONG_TYPES.has(g[0].combo.type)) strong.push(g[g.length - 1])
  }
  const cands: (Move | null)[] = [...weak, ...strong].slice(0, PRUNE_LIMIT)
  if (ctx.table) cands.push(null)
  return cands
}

// —— 快速手牌分解（rollout 每步用，不走 generateMoves）——
interface QuickPlan {
  jokerBomb: Card[] | null
  bombs: Card[][] // ≥4 同点，点数升序
  triples: Card[][] // 恰 3 同点，升序
  pairs: Card[][] // 恰 2 同点，升序（含王对）
  straights: Card[][] // 从散张贪心抽出的顺子（顶张降序抽取，存升序）
  singles: Card[] // 散张升序（含单王）
  wilds: Card[] // 逢人配单列（非必要不消耗）
}

function quickDecompose(hand: Card[], level: NormalRank): QuickPlan {
  const wilds: Card[] = []
  const byPower = new Map<number, Card[]>()
  for (const c of hand) {
    if (isWild(c, level)) { wilds.push(c); continue }
    const p = singlePower(c, level)
    const arr = byPower.get(p)
    if (arr) arr.push(c)
    else byPower.set(p, [c])
  }
  const q: QuickPlan = { jokerBomb: null, bombs: [], triples: [], pairs: [], straights: [], singles: [], wilds }
  const sj = byPower.get(SMALL_JOKER_POWER) ?? []
  const bj = byPower.get(BIG_JOKER_POWER) ?? []
  if (sj.length === 2 && bj.length === 2) {
    q.jokerBomb = [...sj, ...bj]
    byPower.delete(SMALL_JOKER_POWER)
    byPower.delete(BIG_JOKER_POWER)
  }
  for (const p of [...byPower.keys()].sort((a, b) => a - b)) {
    const cs = byPower.get(p)!
    if (cs.length >= 4) q.bombs.push(cs)
    else if (cs.length === 3) q.triples.push(cs)
    else if (cs.length === 2) q.pairs.push(cs)
    else q.singles.push(cs[0])
  }
  // 从散张贪心抽顺子（提高走牌节奏保真度）：每连续值至多 1 张散张，A 可作 14/1
  const byVal = new Map<number, Card>()
  for (const c of q.singles) if (!isJoker(c)) byVal.set(straightValue(c), c)
  const cell = (v: number): Card | undefined => byVal.get(v === 1 ? 14 : v)
  for (let s0 = 10; s0 >= 1; s0--) {
    const vals = [s0, s0 + 1, s0 + 2, s0 + 3, s0 + 4]
    if (!vals.every((v) => cell(v) !== undefined)) continue
    q.straights.push(vals.map((v) => cell(v)!))
    for (const v of vals) byVal.delete(v === 1 ? 14 : v)
  }
  if (q.straights.length > 0) {
    const used = new Set(q.straights.flat().map((c) => c.id))
    q.singles = q.singles.filter((c) => !used.has(c.id))
  }
  return q
}

/** 粗略剩余手数（三张按 1 手估，够走牌节奏判断即可）。 */
const quickMoveCount = (q: QuickPlan): number =>
  q.bombs.length + (q.jokerBomb ? 1 : 0) + q.triples.length + q.pairs.length +
  q.straights.length + q.singles.length + (q.wilds.length > 0 ? 1 : 0)

/** 不含炸弹/天王炸的剩余手数——判断"真快赢了"用（有炸弹说明还没清光）。 */
const nonBombMoveCount = (q: QuickPlan): number =>
  q.triples.length + q.pairs.length + q.straights.length + q.singles.length + (q.wilds.length > 0 ? 1 : 0)

const RUN_TYPES = new Set(['straight', 'tube', 'plate', 'straight_flush'])
const single = (c: Card, level: NormalRank): Move =>
  ({ cards: [c], combo: { type: 'single', rank: singlePower(c, level), length: 1 } })
const mkPair = (g: Card[], level: NormalRank): Move =>
  ({ cards: g, combo: { type: 'pair', rank: singlePower(g[0], level), length: 2 } })
const mkBomb = (g: Card[], level: NormalRank): Move =>
  ({ cards: g, combo: { type: 'bomb', rank: singlePower(g[0], level), length: g.length } })
const mkJokerBomb = (g: Card[]): Move =>
  ({ cards: g, combo: { type: 'joker_bomb', rank: 1000, length: 4 } })

/** rollout 领牌：终局抢跑（≤2 手先出强的）→ 结构优先 → 顺子 → 散张策略。恒有返回。 */
function quickLead(s: RoundState, seat: Seat): Move {
  const level = s.level
  const q = quickDecompose(s.hands[seat], level)
  const powG = (g: Card[]): number => singlePower(g[0], level)
  const mkTP = (t: Card[], p: Card[]): Move =>
    ({ cards: [...t, ...p], combo: { type: 'triple_pair', rank: powG(t), length: 5 } })

  if (quickMoveCount(q) <= 2) {
    // 终局抢跑：优先非炸出清，只有真只剩炸弹（或天王炸）才炸着出 —— 避免后续又要炸弹防守
    if (q.triples.length > 0 && q.pairs.length > 0) return mkTP(q.triples[q.triples.length - 1], q.pairs[0])
    if (q.triples.length > 0) {
      const t = q.triples[q.triples.length - 1]
      return { cards: t.slice(), combo: { type: 'triple', rank: powG(t), length: 3 } }
    }
    if (q.pairs.length > 0) return mkPair(q.pairs[q.pairs.length - 1], level)
    if (q.straights.length > 0)
      return { cards: q.straights[0].slice(), combo: { type: 'straight', rank: straightValue(q.straights[0][4]), length: 5 } }
    if (q.singles.length > 0) return single(q.singles[q.singles.length - 1], level)
    // 只剩炸弹/天王炸
    if (q.jokerBomb) return mkJokerBomb(q.jokerBomb)
    if (q.bombs.length > 0) return mkBomb(q.bombs[q.bombs.length - 1], level)
  }
  // 喂牌：队友快出完 → 出最小单/对让队友跑（队友能接）
  const partnerLen = s.hands[partnerOf(seat)].length
  if (partnerLen <= 3 && partnerLen > 0) {
    if (q.singles.length > 0) return single(q.singles[0], level)
    if (q.pairs.length > 0) return mkPair(q.pairs[0], level)
  }
  // 帮队友减负：队友牌多 → 出对子/结构拉节奏，队友少出牌
  if (partnerLen >= 20 && (q.pairs.length > 0 || q.triples.length > 0)) {
    if (q.pairs.length > 0) return mkPair(q.pairs[0], level)
    if (q.triples.length > 0 && q.pairs.length >= 2) return mkTP(q.triples[0], q.pairs[0])
  }
  // 炸弹在手 → 领最强非炸保牌权，避免出小牌被对手盖住又要炸
  if (q.bombs.length > 0 || q.jokerBomb) {
    if (q.triples.length > 0 && q.pairs.length > 0) return mkTP(q.triples[q.triples.length - 1], q.pairs[q.pairs.length - 1])
    if (q.triples.length > 0) {
      const t = q.triples[q.triples.length - 1]
      return { cards: t.slice(), combo: { type: 'triple', rank: powG(t), length: 3 } }
    }
    if (q.pairs.length > 0) return mkPair(q.pairs[q.pairs.length - 1], level)
    if (q.singles.length > 0) return single(q.singles[q.singles.length - 1], level)
  }
  if (q.triples.length > 0 && q.pairs.length > 0) return mkTP(q.triples[0], q.pairs[0])
  // 无对可带 → 裸三清牌（比拆对高效）
  if (q.triples.length > 0) {
    const t = q.triples[0]
    return { cards: t.slice(), combo: { type: 'triple', rank: powG(t), length: 3 } }
  }
  if (q.pairs.length > 0) return mkPair(q.pairs[0], level)
  if (q.straights.length > 0) {
    const st = q.straights[0]
    return { cards: st.slice(), combo: { type: 'straight', rank: straightValue(st[4]), length: 5 } }
  }
  if (q.singles.length > 0) {
    const oppClose = ([(seat + 1) % 4, (seat + 3) % 4] as Seat[])
      .some((o) => s.hands[o].length > 0 && s.hands[o].length <= 3)
    if (oppClose) return single(q.singles[q.singles.length - 1], level)
    const nc = q.singles.find((c) => singlePower(c, level) < 14)
    return single(nc ?? q.singles[0], level)
  }
  if (q.wilds.length === 2) return { cards: q.wilds.slice(), combo: { type: 'pair', rank: LEVEL_POWER, length: 2 } }
  if (q.wilds.length === 1) return single(q.wilds[0], level)
  if (q.bombs.length > 0) return mkBomb(q.bombs[0], level)
  if (q.jokerBomb) return mkJokerBomb(q.jokerBomb)
  const c = [...s.hands[seat]].sort((a, b) => singlePower(a, level) - singlePower(b, level))[0]
  return single(c, level)
}

/** rollout 跟牌：单/对/三带二/顺子族走快速池，末位炸弹价值判断。队友领牌一律让（不盖）。 */
function quickFollow(s: RoundState, seat: Seat): Move | null {
  const table = s.table as Combo
  const level = s.level
  const leaderSeat = s.leader as Seat
  if (leaderSeat === partnerOf(seat)) return null // 不盖队友（包括其快出完时——让队友先跑）
  const q = quickDecompose(s.hands[seat], level)
  const powC = (c: Card): number => singlePower(c, level)
  const powG = (g: Card[]): number => powC(g[0])
  const leaderCount = s.hands[leaderSeat].length
  const press = leaderCount <= 3

  let ans: Move | null = null
  if (table.type === 'single') {
    const cs = q.singles.filter((c) => powC(c) > table.rank)
    if (cs.length > 0) ans = single(cs[press ? cs.length - 1 : 0], level)
    else if (q.wilds.length > 0 && LEVEL_POWER > table.rank) ans = single(q.wilds[0], level)
  } else if (table.type === 'pair') {
    const gs = q.pairs.filter((g) => powG(g) > table.rank)
    if (gs.length > 0) ans = mkPair(gs[press ? gs.length - 1 : 0], level)
    else if (q.wilds.length > 0) {
      const c = q.singles.find((x) => !isJoker(x) && powC(x) > table.rank)
      if (c) ans = { cards: [c, q.wilds[0]], combo: { type: 'pair', rank: powC(c), length: 2 } }
    }
  } else if (table.type === 'triple') {
    const t = q.triples.find((g) => powG(g) > table.rank)
    if (t) ans = { cards: t.slice(), combo: { type: 'triple', rank: powG(t), length: 3 } }
  } else if (table.type === 'triple_pair') {
    const t = q.triples.find((g) => powG(g) > table.rank)
    if (t && q.pairs.length > 0)
      ans = { cards: [...t, ...q.pairs[0]], combo: { type: 'triple_pair', rank: powG(t), length: 5 } }
  } else if (RUN_TYPES.has(table.type)) {
    const ms = generateBeating(s.hands[seat], level, table).filter((m) => !isBomb(m.combo)).sort(byStrength)
    if (ms.length > 0) ans = ms[0]
  }
  // 快速池未找到非炸 → 遍历完整发生器（catch 快速分解遗漏的 wild 组合等）
  if (ans === null || !beats(ans.combo, table)) {
    const fullNonBombs = generateBeating(s.hands[seat], level, table)
      .filter((m) => !isBomb(m.combo))
      .sort(byStrength)
    if (fullNonBombs.length > 0) {
      if (press) ans = fullNonBombs.reduce((a, b) =>
        b.combo.rank > a.combo.rank || (b.combo.rank === a.combo.rank && b.combo.length > a.combo.length) ? b : a)
      else ans = fullNonBombs[0]
    }
  }
  if (ans !== null && beats(ans.combo, table)) return ans

  // 炸弹价值判断
  const bombMs = [
    ...q.bombs.map((g) => mkBomb(g, level)),
    ...(q.jokerBomb ? [mkJokerBomb(q.jokerBomb)] : []),
  ].filter((m) => beats(m.combo, table))
    .sort((a, b) => bombTier(a.combo) - bombTier(b.combo) || a.combo.rank - b.combo.rank)
  if (bombMs.length === 0) return null
  // 非炸剩余手数：不含炸弹（有炸弹说明还不是真快赢，炸弹应留作防守）
  const nonBombLeft = nonBombMoveCount(q)
  const partnerLen2 = s.hands[partnerOf(seat)].length
  const worth = nonBombLeft <= 1 || // 非炸只有 ≤1 手 → 真快赢了
    (leaderCount <= 1) || // 对手只剩 1 张，必须炸
    (isBomb(table) && leaderCount <= 6) || // 对手出的炸弹，反炸
    (!isBomb(table) && table.rank >= SMALL_JOKER_POWER) || // 王级无条件炸
    (partnerLen2 <= 4 && partnerLen2 > 0 && !isBomb(table) && table.rank >= 14) || // 保队友
    // 炸弹还多（≥2 个）且局势紧张才用；只剩 1 炸时更保守（对手 ≤1 才触发，已包含在上）
    (q.bombs.length >= 2 && leaderCount <= 3 && table.rank >= 14)
  return worth ? bombMs[0] : null
}

// —— 单次 rollout：施加候选 → 快速策略打到终局 → 己队名次得分 ——
const STEP_GUARD = 600 // round.ts 每墩必有人出牌、手牌单调减，理论有界；护栏防御

function rolloutOnce(ctx: AIContext, hands: Card[][], cand: Move | null): number {
  const s: RoundState = {
    level: ctx.level,
    hands: hands.map((h) => h.slice()),
    current: ctx.seat,
    table: ctx.table,
    leader: ctx.leader,
    passes: ctx.passes ?? 0,
    finished: ctx.finished ? [...ctx.finished] : SEATS.filter((x) => x !== ctx.seat && ctx.handCounts[x] === 0),
    over: false,
  }
  const applied = cand ? play(s, ctx.seat, cand.cards, cand.combo).ok : pass(s, ctx.seat).ok
  if (!applied) return -99 // 候选来自真实手牌生成，不应发生

  let steps = 0
  while (!s.over && steps++ < STEP_GUARD) {
    const seat = s.current
    const m = s.table === null ? quickLead(s, seat) : quickFollow(s, seat)
    const ok = m !== null ? play(s, seat, m.cards, m.combo).ok : pass(s, seat).ok
    if (!ok) {
      // 防御：策略产出非法（不应发生）→ 跟牌改过，领牌强制最小单
      if (s.table !== null) { if (!pass(s, seat).ok) break }
      else {
        const c = [...s.hands[seat]].sort((a, b) => singlePower(a, s.level) - singlePower(b, s.level))[0]
        if (!c || !play(s, seat, [c], single(c, s.level).combo).ok) break
      }
    }
  }

  const me = teamOf(ctx.seat)
  if (s.over) return teamOf(s.finished[0]) === me ? levelGain(s.finished) : -levelGain(s.finished)
  // 步数护栏截断（罕见）：按双方剩牌差给残局分
  const mine = s.hands[ctx.seat].length + s.hands[partnerOf(ctx.seat)].length
  const theirs = SEATS.reduce<number>((n, x) => (teamOf(x) === me ? n : n + s.hands[x].length), 0)
  return (theirs - mine) / 27
}

const sameMove = (a: Move | null, b: Move | null): boolean => {
  if (a === null || b === null) return a === b
  if (a.cards.length !== b.cards.length) return false
  const ids = new Set(a.cards.map((c) => c.id))
  return b.cards.every((c) => ids.has(c.id))
}

const BASELINE_MARGIN = 0.3 // 每副想象牌局平均分需领先基准这么多才偏离（抗 rollout 噪声）

/** hard 档决策：确定化蒙特卡洛评估候选；有基准时仅在 MC 明显更优时偏离基准。 */
export function decideHard(ctx: AIContext, opts: SimOptions = {}): Move | null {
  const cands = pruneCandidates(ctx)
  if (cands.length === 0) return null // 领牌恒有着法，仅防御
  const hasBase = opts.baseline !== undefined
  let baseIdx = -1
  if (hasBase) {
    baseIdx = cands.findIndex((m) => sameMove(m, opts.baseline!))
    if (baseIdx < 0) { cands.push(opts.baseline!); baseIdx = cands.length - 1 }
  }
  if (cands.length === 1) return cands[0]

  const rng = ctx.rng ?? mulberry32(ctx.hand.length * 131 + (ctx.seen?.length ?? 0) + 7)
  const deadline = Date.now() + (opts.deadlineMs ?? 220)
  const maxDet = opts.maxDeterminizations ?? 48
  const totals = new Array<number>(cands.length).fill(0)
  let det = 0
  while (det < maxDet && (det < 4 || Date.now() < deadline)) {
    const hands = dealUnseen(ctx, rng) // 公共随机数：同副牌局评所有候选
    for (let i = 0; i < cands.length; i++) totals[i] += rolloutOnce(ctx, hands, cands[i])
    det++
  }
  let best = 0
  for (let i = 1; i < cands.length; i++) if (totals[i] > totals[best]) best = i // 平分取先者（弱着法在前）
  if (!hasBase) return cands[best]
  // 有基准：MC 最优须显著好于基准才改走（下限=基准，噪声不劣化）
  return totals[best] - totals[baseIdx] > BASELINE_MARGIN * det ? cands[best] : cands[baseIdx]
}
