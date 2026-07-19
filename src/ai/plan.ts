// ── 手牌拆分 ────────────────────────────────────────────────────────────
// 把一手牌贪心拆成不相交的成型牌（炸弹 / 顺子族 / 三张 / 对子）+ 散张单牌，
// 供 AI 领牌（优先出成型牌高效走牌）与跟牌（不轻易拆散成型牌）参考。
// 非最优拆分（最优是 set-cover），但产出接近真人的手牌结构，性能足够。

import { generateMoves, type Move } from '../core/moves'
import { isBomb } from '../core/combos'
import { singlePower, type Card, type NormalRank } from '../core/cards'

const RUN_TYPES = new Set(['straight', 'tube', 'plate', 'straight_flush'])

/** 从候选着法里挑「最该保留成型」的结构：炸弹 > 更长 > 顺子族 > 低 rank；无结构返回 null。 */
function pickStructure(moves: Move[]): Move | null {
  const structs = moves.filter((m) => m.combo.length >= 2) // 排除单张
  if (structs.length === 0) return null
  structs.sort((a, b) => {
    const ba = isBomb(a.combo) ? 1 : 0
    const bb = isBomb(b.combo) ? 1 : 0
    if (ba !== bb) return bb - ba // 炸弹先抽走保护
    if (b.combo.length !== a.combo.length) return b.combo.length - a.combo.length // 更长优先
    const ra = RUN_TYPES.has(a.combo.type) ? 1 : 0
    const rb = RUN_TYPES.has(b.combo.type) ? 1 : 0
    if (ra !== rb) return rb - ra // 同长时顺子族优先
    return a.combo.rank - b.combo.rank // 低 rank 优先
  })
  return structs[0]
}

/** 贪心拆分：迭代抽取最优结构直至只剩散张，散张各作单牌。返回不相交 Move[]。 */
export function planHand(hand: Card[], level: NormalRank): Move[] {
  const plan: Move[] = []
  let remaining = [...hand]
  for (let guard = 0; guard < hand.length; guard++) {
    const pick = pickStructure(generateMoves(remaining, level))
    if (!pick) break
    plan.push(pick)
    const ids = new Set(pick.cards.map((c) => c.id))
    remaining = remaining.filter((c) => !ids.has(c.id))
  }
  for (const c of remaining) {
    plan.push({ cards: [c], combo: { type: 'single', rank: singlePower(c, level), length: 1 } })
  }
  return plan
}

/** 手牌里「属于成型牌（结构或炸弹）」的牌 id 集合——跟牌时避免拆散。 */
export function structureCardIds(hand: Card[], level: NormalRank): Set<string> {
  const ids = new Set<string>()
  for (const m of planHand(hand, level)) {
    if (isBomb(m.combo) || m.combo.length >= 2) for (const c of m.cards) ids.add(c.id)
  }
  return ids
}
