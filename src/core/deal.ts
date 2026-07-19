import { makeDeck, type Card } from './cards'
import { mulberry32, shuffleInPlace } from './rng'

export type Seat = 0 | 1 | 2 | 3
export const SEATS: readonly Seat[] = [0, 1, 2, 3]

/** 座位所属队伍：0/2 为 0 队，1/3 为 1 队（队友坐对家）。 */
export const teamOf = (seat: Seat): 0 | 1 => (seat % 2) as 0 | 1
/** 对家（队友）座位。 */
export const partnerOf = (seat: Seat): Seat => ((seat + 2) % 4) as Seat

export interface Deal {
  hands: [Card[], Card[], Card[], Card[]]
}

/**
 * 发牌：用种子洗一副 108 张，逐张轮流发给 4 家，各 27 张。
 * 同一种子结果确定可复现（便于单测与联机回放）。
 */
export function deal(seed: number): Deal {
  const deck = shuffleInPlace(makeDeck(), mulberry32(seed))
  const hands: [Card[], Card[], Card[], Card[]] = [[], [], [], []]
  for (let i = 0; i < deck.length; i++) hands[(i % 4) as Seat].push(deck[i])
  return { hands }
}
