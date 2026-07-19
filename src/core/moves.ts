// ── 完整着法生成 ────────────────────────────────────────────────────────
// 枚举一手牌能打出的所有合法牌型（含逢人配填充）。
// 稳健性策略：构造候选牌组后，一律用已充分测试的 getCombos() 校验，
// 只发出被确认合法的着法——生成器永不吐非法牌。

import {
  isWild, isJoker, singlePower, straightValue, SUITS,
  type Card, type NormalRank, type Suit,
} from './cards'
import { getCombos, canFormCombo, beats, type Combo, type ComboType } from './combos'

export interface Move { cards: Card[]; combo: Combo }

function emit(out: Move[], cards: Card[], level: NormalRank, want: (c: Combo) => boolean): void {
  if (cards.length === 0) return
  const combo = getCombos(cards, level).find(want)
  if (combo) out.push({ cards, combo })
}

/** 顺子族：从 normals + wilds 里凑出 [start, start+span) 每级 mult 张，返回牌组或 null。 */
function formRun(
  normals: Card[], wilds: Card[], start: number, span: number, mult: number,
): Card[] | null {
  const need = new Map<number, number>()
  for (let v = start; v < start + span; v++) need.set(v, mult)
  const chosen: Card[] = []
  for (const c of normals) {
    let v = straightValue(c)
    if (start === 1 && c.rank === 'A') v = 1 // A 作最小
    const rem = need.get(v)
    if (rem && rem > 0) {
      chosen.push(c)
      need.set(v, rem - 1)
    }
  }
  let deficit = 0
  for (const r of need.values()) deficit += r
  if (deficit > wilds.length) return null
  for (let i = 0; i < deficit; i++) chosen.push(wilds[i])
  return chosen
}

/** 枚举一手牌的全部合法着法（按牌型+点数+张数去重）。 */
export function generateMoves(hand: Card[], level: NormalRank): Move[] {
  const out: Move[] = []
  const wilds = hand.filter((c) => isWild(c, level))
  const jokers = hand.filter(isJoker)
  const normals = hand.filter((c) => !isWild(c, level) && !isJoker(c))

  // 按牌力分组（普通牌级牌→16；王→17/18）
  const byPower = new Map<number, Card[]>()
  for (const c of [...normals, ...jokers]) {
    const p = singlePower(c, level)
    const arr = byPower.get(p) ?? []
    arr.push(c)
    byPower.set(p, arr)
  }

  // 单张
  for (const c of hand) emit(out, [c], level, (k) => k.type === 'single')

  // n 同张：对 / 三 / 炸
  for (const [R, cs] of byPower) {
    const jokerRank = R >= 17
    const maxWild = jokerRank ? 0 : wilds.length
    for (let k = 2; k <= cs.length + maxWild; k++) {
      const real = cs.slice(0, Math.min(k, cs.length))
      const need = k - real.length
      if (need > maxWild) break
      const cards = [...real, ...wilds.slice(0, need)]
      const type: ComboType = k === 2 ? 'pair' : k === 3 ? 'triple' : 'bomb'
      emit(out, cards, level, (c) => c.type === type && c.rank === R && c.length === k)
    }
  }

  // 三带二
  for (const [R, csR] of byPower) {
    if (R >= 17) continue // 王不做三张
    const tripleReal = csR.slice(0, Math.min(3, csR.length))
    const tNeed = 3 - tripleReal.length
    if (tNeed > wilds.length) continue
    const tripleCards = [...tripleReal, ...wilds.slice(0, tNeed)]
    if (tripleCards.length !== 3) continue
    const wildsLeft = wilds.slice(tNeed)
    for (const [S, csS] of byPower) {
      if (S === R) continue // 同点=五张=炸弹，非三带二
      const pairReal = csS.slice(0, Math.min(2, csS.length))
      const pNeed = 2 - pairReal.length
      if (S >= 17 && pNeed > 0) continue
      if (pNeed > wildsLeft.length) continue
      const cards = [...tripleCards, ...pairReal, ...wildsLeft.slice(0, pNeed)]
      emit(out, cards, level, (c) => c.type === 'triple_pair' && c.rank === R)
    }
  }

  // 顺子 / 连对(木板) / 钢板
  for (let top = 5; top <= 14; top++) {
    const cards = formRun(normals, wilds, top - 4, 5, 1)
    if (cards) emit(out, cards, level, (c) => c.type === 'straight' && c.rank === top)
  }
  for (let top = 3; top <= 14; top++) {
    const cards = formRun(normals, wilds, top - 2, 3, 2)
    if (cards) emit(out, cards, level, (c) => c.type === 'tube' && c.rank === top)
  }
  for (let top = 2; top <= 14; top++) {
    const cards = formRun(normals, wilds, top - 1, 2, 3)
    if (cards) emit(out, cards, level, (c) => c.type === 'plate' && c.rank === top)
  }

  // 同花顺
  for (const suit of SUITS as readonly Suit[]) {
    const suitCards = normals.filter((c) => c.suit === suit)
    for (let top = 5; top <= 14; top++) {
      const cards = formRun(suitCards, wilds, top - 4, 5, 1)
      if (cards) emit(out, cards, level, (c) => c.type === 'straight_flush' && c.rank === top)
    }
  }

  // 天王炸
  if (jokers.filter((c) => c.rank === 'sj').length >= 2 && jokers.filter((c) => c.rank === 'bj').length >= 2) {
    const jb = [
      ...jokers.filter((c) => c.rank === 'sj').slice(0, 2),
      ...jokers.filter((c) => c.rank === 'bj').slice(0, 2),
    ]
    emit(out, jb, level, (c) => c.type === 'joker_bomb')
  }

  // 去重（同 牌型:点数:张数 保留其一；同花顺/三带二补花色/对子点数区分等价替代）
  const seen = new Set<string>()
  return out.filter((m) => {
    let extra = ''
    if (m.combo.type === 'straight_flush') {
      extra = `:${m.cards.find((c) => !isWild(c, level))!.suit}`
    } else if (m.combo.type === 'triple_pair') {
      // 三带二：不同对子不可互替——双副重复牌/同点异花副本各需独立着法
      const pairCard = m.cards.find((c) => singlePower(c, level) !== m.combo.rank)
      if (pairCard) extra = `:p${singlePower(pairCard, level)}`
    }
    const key = `${m.combo.type}:${m.combo.rank}:${m.combo.length}${extra}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 能压过 table 的全部着法。 */
export function generateBeating(hand: Card[], level: NormalRank, table: Combo): Move[] {
  return generateMoves(hand, level).filter((m) => beats(m.combo, table))
}

/**
 * 跟牌时「可参与压牌」的牌 id 集合（供置灰展示）。
 * 生成器按 (型:点:长) 去重只留一个实例，等价牌（双副重复、同点异花副本、
 * naturals 够时省下的逢人配）不在实例里但同样能出——按等价类做顶替检验：
 * 把某着法中一张换成该牌后仍成同型同点同长 → 该类全部可选。
 */
export function playableCardIds(hand: Card[], level: NormalRank, table: Combo): Set<string> {
  const moves = generateBeating(hand, level, table)
  const ids = new Set<string>()
  for (const mv of moves) for (const c of mv.cards) ids.add(c.id)
  if (moves.length === 0) return ids

  const classKey = (c: Card): string => `${c.suit}:${c.rank}`
  const usable = new Map<string, boolean>() // 等价类（花色:点数）→ 可否参与
  for (const mv of moves) for (const c of mv.cards) usable.set(classKey(c), true)

  const canSub = (c: Card): boolean =>
    moves.some((mv) =>
      mv.cards.some((_, i) => {
        const alt = mv.cards.slice()
        alt[i] = c
        return canFormCombo(alt, mv.combo.type, mv.combo.rank, level, mv.combo.length)
      }),
    )

  for (const c of hand) {
    const k = classKey(c)
    let ok = usable.get(k)
    if (ok === undefined) {
      ok = canSub(c)
      usable.set(k, ok)
    }
    if (ok) ids.add(c.id)
  }
  return ids
}
