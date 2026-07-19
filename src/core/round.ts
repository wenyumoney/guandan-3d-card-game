// ── 一局流程状态机 ──────────────────────────────────────────────────────
// 轮流出牌或过牌；连续过牌回到收牌方 → 收牌方自由领出；出完手牌记名次。
// 一局在 3 家出完时结束（余下 1 家为末游），产出 finished = [头游,二游,三游,末游]。

import { type Card, type NormalRank } from './cards'
import { type Combo, canFormCombo, beats } from './combos'
import { type Seat, SEATS, teamOf, partnerOf } from './deal'

export interface RoundState {
  level: NormalRank
  hands: Card[][] // 按座位 0..3
  current: Seat
  table: Combo | null // 待压的桌面牌型（null = 自由领出）
  leader: Seat | null // 桌面牌型的出牌者（收牌权归属）
  passes: number // 自上次出牌以来的连续过牌数
  finished: Seat[] // 名次顺序（头游在前）
  over: boolean
}

export interface ActionResult {
  ok: boolean
  reason?: string
}

export function createRound(hands: Card[][], level: NormalRank, firstSeat: Seat): RoundState {
  return {
    level,
    hands: hands.map((h) => h.slice()),
    current: firstSeat,
    table: null,
    leader: null,
    passes: 0,
    finished: [],
    over: false,
  }
}

const activeCount = (s: RoundState): number => s.hands.filter((h) => h.length > 0).length

function nextActiveSeat(s: RoundState, from: Seat): Seat {
  for (let i = 1; i <= 4; i++) {
    const seat = ((from + i) % 4) as Seat
    if (s.hands[seat].length > 0) return seat
  }
  return from
}

function handHasAll(hand: Card[], cards: Card[]): boolean {
  const ids = new Set(hand.map((c) => c.id))
  return cards.every((c) => ids.has(c.id))
}

/** 校验一次出牌是否合法（不改状态）。 */
export function validatePlay(s: RoundState, seat: Seat, cards: Card[], combo: Combo): ActionResult {
  if (s.over) return { ok: false, reason: '本局已结束' }
  if (seat !== s.current) return { ok: false, reason: '未轮到该玩家' }
  if (cards.length === 0) return { ok: false, reason: '未选牌' }
  if (!handHasAll(s.hands[seat], cards)) return { ok: false, reason: '所选牌不在手中' }
  if (!canFormCombo(cards, combo.type, combo.rank, s.level, combo.length)) {
    return { ok: false, reason: '所选牌无法组成声明的牌型' }
  }
  if (s.table !== null && !beats(combo, s.table)) return { ok: false, reason: '压不过桌面牌' }
  return { ok: true }
}

/** 出牌（合法则改状态并返回 ok）。 */
export function play(s: RoundState, seat: Seat, cards: Card[], combo: Combo): ActionResult {
  const v = validatePlay(s, seat, cards, combo)
  if (!v.ok) return v

  const ids = new Set(cards.map((c) => c.id))
  s.hands[seat] = s.hands[seat].filter((c) => !ids.has(c.id))
  s.table = combo
  s.leader = seat
  s.passes = 0

  if (s.hands[seat].length === 0) {
    s.finished.push(seat)
    // 双下：同队两人先出完 → 立即终局，败方不再打
    if (s.finished.length === 2 && teamOf(s.finished[0]) === teamOf(s.finished[1])) {
      const losers = SEATS.filter((x) => !s.finished.includes(x)).sort(
        (a, b) => s.hands[a].length - s.hands[b].length, // 牌少者三游，多者末游
      )
      s.finished.push(losers[0], losers[1])
      s.over = true
      return { ok: true }
    }
    if (s.finished.length === 3) {
      const last = SEATS.find((x) => s.hands[x].length > 0)
      if (last !== undefined) s.finished.push(last)
      s.over = true
      return { ok: true }
    }
  }
  s.current = nextActiveSeat(s, seat)
  return { ok: true }
}

/** 校验过牌是否合法（不改状态）。 */
export function validatePass(s: RoundState, seat: Seat): ActionResult {
  if (s.over) return { ok: false, reason: '本局已结束' }
  if (seat !== s.current) return { ok: false, reason: '未轮到该玩家' }
  if (s.table === null) return { ok: false, reason: '自由领出不能过牌' }
  return { ok: true }
}

/** 过牌（合法则改状态；连续过牌到收牌方则该方自由领出）。 */
export function pass(s: RoundState, seat: Seat): ActionResult {
  const v = validatePass(s, seat)
  if (!v.ok) return v

  s.passes++
  const leaderActive = s.leader !== null && s.hands[s.leader].length > 0
  const others = leaderActive ? activeCount(s) - 1 : activeCount(s)

  if (s.passes >= others) {
    // 一圈过完 → 收牌方自由领出；收牌方已出完则接风：牌权交其对家（队友），队友也出完则下家兜底
    const leader = s.leader as Seat
    const p = partnerOf(leader)
    const newLeader = leaderActive ? leader : s.hands[p].length > 0 ? p : nextActiveSeat(s, leader)
    s.table = null
    s.passes = 0
    s.leader = newLeader
    s.current = newLeader
  } else {
    s.current = nextActiveSeat(s, s.current)
  }
  return { ok: true }
}
