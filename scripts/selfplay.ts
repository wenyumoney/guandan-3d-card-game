// ── AI 自对弈分析：4 个 hard AI 打 N 局，记录可疑决策，输出统计 ──────────
// 用法：npx tsx scripts/selfplay.ts [局数=20]

import {
  singlePower, type Card, type NormalRank,
  LEVEL_POWER, SMALL_JOKER_POWER, BIG_JOKER_POWER,
} from '../src/core/cards'
import { isBomb, type Combo } from '../src/core/combos'
import { generateBeating, type Move } from '../src/core/moves'
import { deal, partnerOf, teamOf, SEATS, type Seat } from '../src/core/deal'
import { createRound, play, pass, type RoundState } from '../src/core/round'
import { initMatch, applyRoundResult, computeTribute } from '../src/core/scoring'
import { decideHeuristic, type AIContext, type Difficulty } from '../src/ai/ai'
import { decideHard, remainingCards } from '../src/ai/sim'
import { mulberry32 } from '../src/core/rng'

const SEAT_NAMES = ['你', '下家', '队友', '上家']

// ── 可疑事件 ──
interface SuspiciousEvent {
  game: number
  round: number
  trick: number
  seat: Seat
  seatName: string
  handLen: number
  issue: string
  detail: string
}

const events: SuspiciousEvent[] = []
const stats = {
  games: 0,
  rounds: 0,
  bombsUsed: 0,
  bombsOnLowRank: 0, // 炸低点数非炸弹（rank < 14）
  partnerCoverBig: 0, // 大牌压队友（≥A 或炸弹）
  partnerCoverIdle: 0, // 无对手威胁仍顶队友（浪费出牌）
  partnerCoverCheap: 0, // 合理便宜顶（有威胁、<A 非炸）——仅计数不告警
  missedProtection: 0, // 该保队友没保
  nonBombExistsButBombed: 0, // 有非炸可跟却出炸
}

function rankLabel(r: number): string {
  if (r === BIG_JOKER_POWER) return '大王'
  if (r === SMALL_JOKER_POWER) return '小王'
  if (r === LEVEL_POWER) return '级牌'
  if (r === 14) return 'A'
  if (r === 13) return 'K'
  if (r === 12) return 'Q'
  if (r === 11) return 'J'
  return String(r)
}

function comboLabel(c: Combo): string {
  const rk = rankLabel(c.rank)
  switch (c.type) {
    case 'single': return `单${rk}`
    case 'pair': return `对${rk}`
    case 'triple_pair': return `3带2(${rk})`
    case 'straight': return `顺${rk}`
    case 'tube': return `木板${rk}`
    case 'plate': return `钢板${rk}`
    case 'bomb': return `${c.length}炸${rk}`
    case 'straight_flush': return `同花顺${rk}`
    case 'joker_bomb': return '天王炸'
    default: return `${c.type}${rk}`
  }
}

function logEvent(e: SuspiciousEvent): void {
  events.push(e)
  console.log(`  ⚠ [G${e.game}R${e.round}T${e.trick}] ${e.seatName}(${e.handLen}张) ${e.issue}: ${e.detail}`)
}

// ── 一局 AI 自对弈 ──
function playOneRound(
  roundIdx: number, gameIdx: number, seed: number,
  lastFinished: Seat[] | null, matchLevels: [NormalRank, NormalRank], banker: 0 | 1,
  diffs: Difficulty[],
): { finished: Seat[]; events: number } {
  const before = events.length
  const rng = mulberry32(seed)
  const level = matchLevels[banker]
  const d = deal(seed)
  const hands = d.hands

  // 进贡还贡
  const trib = lastFinished ? computeTribute(lastFinished, hands, level) : null
  let firstSeat: Seat = 0
  if (trib) {
    if (!trib.kang) {
      for (const t of trib.transfers) {
        const idx = hands[t.from].findIndex((c) => c.id === t.card.id)
        if (idx >= 0) hands[t.to].push(...hands[t.from].splice(idx, 1))
      }
      for (const r of trib.returns) {
        const idx = hands[r.from].findIndex((c) => c.id === r.card.id)
        if (idx >= 0) hands[r.to].push(...hands[r.from].splice(idx, 1))
      }
      // 贡牌大者先出
      let best = trib.transfers[0]
      for (const t of trib.transfers) {
        if (singlePower(t.card, level) > singlePower(best.card, level)) best = t
      }
      firstSeat = best.from
    } else {
      firstSeat = lastFinished![0]
    }
  }

  const s = createRound(hands, level, firstSeat)
  const seen: Card[] = []
  const aiRng = mulberry32(seed * 17 + 3)
  let trick = 0

  while (!s.over) {
    trick++
    const seat = s.current
    const handLen = s.hands[seat].length

    const ctx: AIContext = {
      hand: s.hands[seat],
      table: s.table,
      leader: s.leader,
      seat,
      level,
      handCounts: s.hands.map((h) => h.length),
      seen,
      finished: s.finished,
      passes: s.passes,
      rng: aiRng,
    }

    const d = diffs[seat]
    const mv = d === 'hard'
      ? decideHard(ctx, { baseline: decideHeuristic(ctx, 'hard') })
      : decideHeuristic(ctx, d)

    // ── 可疑检测 ──
    if (mv && s.table) {
      const bomb = isBomb(mv.combo)
      const tableBomb = isBomb(s.table)
      const leaderSeat = s.leader as Seat
      const isPartner = leaderSeat === partnerOf(seat)
      const leaderCount = s.hands[leaderSeat].length
      const partnerCount = s.hands[partnerOf(seat)].length

      // 1. 压队友：便宜顶（<A 非炸）且对手确有非炸威胁 → 合理，仅计数；其余告警
      if (isPartner) {
        const tbl = s.table
        const bigCover = bomb || mv.combo.rank >= 14
        const opps = [((seat + 1) % 4) as Seat, ((seat + 3) % 4) as Seat]
        const oppThreat = opps.some(
          (o) => s.hands[o].length > 0 &&
            generateBeating(s.hands[o], level, tbl).some((m: Move) => !isBomb(m.combo)),
        )
        if (bigCover) {
          stats.partnerCoverBig++
          logEvent({
            game: gameIdx, round: roundIdx, trick, seat,
            seatName: SEAT_NAMES[seat], handLen,
            issue: '大牌压队友',
            detail: `${comboLabel(mv.combo)} 压了队友的 ${comboLabel(tbl)}（队友剩${leaderCount}张）`,
          })
        } else if (!oppThreat) {
          stats.partnerCoverIdle++
          if (stats.partnerCoverIdle <= 15) {
            logEvent({
              game: gameIdx, round: roundIdx, trick, seat,
              seatName: SEAT_NAMES[seat], handLen,
              issue: '无威胁仍顶队友',
              detail: `${comboLabel(mv.combo)} 顶队友的 ${comboLabel(tbl)}（对手无非炸威胁，白费一手）`,
            })
          }
        } else {
          stats.partnerCoverCheap++ // 合理便宜顶
        }
      }

      // 2. 有非炸可跟却用炸弹
      if (bomb && !tableBomb) {
        const beating = generateBeating(ctx.hand, ctx.level, ctx.table)
        const nonBombExists = beating.some((m: Move) => !isBomb(m.combo))
        if (nonBombExists) {
          stats.nonBombExistsButBombed++
          logEvent({
            game: gameIdx, round: roundIdx, trick, seat,
            seatName: SEAT_NAMES[seat], handLen,
            issue: '有非炸可选却出炸弹',
            detail: `${comboLabel(mv.combo)} 压 ${comboLabel(s.table)}（非炸选项存在，浪费炸弹）`,
          })
        }
      }

      // 3. 炸低点数非炸弹
      if (bomb && !tableBomb && s.table.rank < 14) {
        stats.bombsOnLowRank++
        if (stats.bombsOnLowRank <= 15) { // 只打印前 15 条
          logEvent({
            game: gameIdx, round: roundIdx, trick, seat,
            seatName: SEAT_NAMES[seat], handLen,
            issue: '炸低点数牌',
            detail: `${comboLabel(mv.combo)} 压 ${comboLabel(s.table)}（桌面 rank=${s.table.rank}，不值得炸）`,
          })
        }
      }

      // 4. 该保队友没保（队友 ≤4 张，桌面 ≥A，有炸弹但没过/没炸）
      if (!bomb && partnerCount <= 4 && partnerCount > 0 && s.table.rank >= 14) {
        const beating2 = generateBeating(ctx.hand, ctx.level, ctx.table)
        const hasBomb = beating2.some((m: Move) => isBomb(m.combo))
        if (hasBomb) {
          stats.missedProtection++
          logEvent({
            game: gameIdx, round: roundIdx, trick, seat,
            seatName: SEAT_NAMES[seat], handLen,
            issue: '该保队友未保',
            detail: `队友剩${partnerCount}张，桌面${comboLabel(s.table)}，有炸弹却${mv ? `出${comboLabel(mv.combo)}` : '过牌'}`,
          })
        }
      }
    }

    if (mv) {
      const isLead = s.table === null
      const result = play(s, seat, mv.cards, mv.combo)
      if (!result.ok) {
        console.log(`  ✗ [G${gameIdx}R${roundIdx}T${trick}] ${SEAT_NAMES[seat]} 出牌非法: ${result.reason}`)
        pass(s, seat)
      } else {
        if (isBomb(mv.combo)) stats.bombsUsed++
        seen.push(...mv.cards)
      }
    } else {
      pass(s, seat)
    }
  }

  return { finished: s.finished, events: events.length - before }
}

// ── 主循环 ──
async function main(): Promise<void> {
  const N = parseInt(process.argv[2] ?? '20', 10)
  const vsMode = process.argv.includes('--vs')
  const DIFFS: Difficulty[] = vsMode
    ? ['hard', 'normal', 'hard', 'normal'] // 队0(座0/2)=hard vs 队1(座1/3)=normal
    : ['hard', 'hard', 'hard', 'hard']

  console.log(`\n🀄 掼蛋 AI 自对弈 ×${N} 场（${vsMode ? '队0=hard vs 队1=normal' : '全 hard'}）\n`)

  let match = initMatch(0)
  let lastFinished: Seat[] | null = null
  let totalRounds = 0
  const teamWins = [0, 0] // 单局胜 [team0, team1]
  const matchWins = [0, 0] // 整场（过A）胜
  let seed = 42

  for (let g = 1; g <= N; g++) {
    let roundIdx = 0
    let gameOver = false

    while (!gameOver) {
      roundIdx++
      totalRounds++
      const { finished } = playOneRound(roundIdx, g, seed++, lastFinished, match.levels, match.banker, DIFFS)

      lastFinished = [...finished]
      const winTeam = teamOf(finished[0])
      teamWins[winTeam]++
      const prevBanker = match.banker
      match = applyRoundResult(match, finished)

      if (match.winner !== null) {
        gameOver = true
        matchWins[match.winner]++
        console.log(`G${g}: ${match.winner === 0 ? '队0' : '队1'} 过A胜 (${roundIdx}局) | 队0 ${match.levels[0]} - 队1 ${match.levels[1]}`)
      } else if (match.banker !== prevBanker || match.levels[prevBanker] !== match.levels[match.banker]) {
        // 升级了，开始新一局
      }
    }

    // 重置新一场
    if (g < N) {
      match = initMatch(0)
      lastFinished = null
      seed += 13
    }
  }

  // ── 统计输出 ──
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`📊 统计摘要（${N} 场，${totalRounds} 局）`)
  console.log(`${'═'.repeat(60)}`)
  console.log(`  队0 胜: ${teamWins[0]} 局 (${(teamWins[0] / totalRounds * 100).toFixed(0)}%)`)
  console.log(`  队1 胜: ${teamWins[1]} 局 (${(teamWins[1] / totalRounds * 100).toFixed(0)}%)`)
  if (vsMode) console.log(`  整场: 队0 ${matchWins[0]} 胜 · 队1 ${matchWins[1]} 胜`)
  console.log(`  炸弹使用: ${stats.bombsUsed}`)
  console.log(`  可疑事件: ${events.length}`)
  console.log(`    - 大牌压队友 (≥A或炸弹): ${stats.partnerCoverBig}`)
  console.log(`    - 无威胁仍顶队友: ${stats.partnerCoverIdle}`)
  console.log(`    - 合理便宜顶 (不计告警): ${stats.partnerCoverCheap}`)
  console.log(`    - 炸低点数牌 (rank<14): ${stats.bombsOnLowRank}`)
  console.log(`    - 有非炸可选却出炸弹: ${stats.nonBombExistsButBombed}`)
  console.log(`    - 该保队友未保: ${stats.missedProtection}`)

  // 按类型分组展示代表性事件
  console.log(`\n📋 可疑事件分类汇总：`)
  const byIssue = new Map<string, SuspiciousEvent[]>()
  for (const e of events) {
    const arr = byIssue.get(e.issue) ?? []
    arr.push(e)
    byIssue.set(e.issue, arr)
  }
  for (const [issue, es] of byIssue) {
    console.log(`  ${issue}: ${es.length} 次`)
    // 展示 3 个例子
    for (const e of es.slice(0, 3)) {
      console.log(`    → G${e.game}R${e.round}T${e.trick} ${e.seatName}(${e.handLen}张): ${e.detail}`)
    }
  }
  console.log()
}

main().catch(console.error)
