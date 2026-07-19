import { type Card, type NormalRank, isWild, singlePower, straightValue, LEVEL_POWER, SMALL_JOKER_POWER, BIG_JOKER_POWER } from '../core/cards'
import { deal, teamOf, type Seat } from '../core/deal'
import { createRound, play, pass, type RoundState } from '../core/round'
import { mulberry32 } from '../core/rng'
import { getCombos, beats, isBomb, bombTier, type Combo } from '../core/combos'
import { generateMoves, generateBeating, playableCardIds, type Move } from '../core/moves'
import {
  initMatch, applyRoundResult, computeTribute, levelGain,
  type MatchState, type TributeResult, type TributeTransfer,
} from '../core/scoring'
import { decideAction, type AIContext, type Difficulty } from '../ai/ai'
import { loadPrefs, recordRound } from './prefs'
import { type TableView } from '../render/Table'
import { type HandView } from '../render/HandView'
import { type RenderContext } from '../render/Renderer'
import { type Effects } from '../render/effects'
import { type AudioApi } from '../audio/audio'
import { type HudApi } from '../ui/Hud'

const SEAT_NAMES = ['你', '下家', '队友', '上家']
const SUIT_SYM: Record<string, string> = { S: '♠', H: '♥', C: '♣', D: '♦' }
/** combo.rank (singlePower 值) → 可读显示 */
function rankName(r: number, level: NormalRank): string {
  if (r === BIG_JOKER_POWER) return '大王'
  if (r === SMALL_JOKER_POWER) return '小王'
  if (r === LEVEL_POWER) return level
  if (r === 14) return 'A'
  if (r === 13) return 'K'
  if (r === 12) return 'Q'
  if (r === 11) return 'J'
  return String(r)
}

/** 出牌记录简练文本 */
function comboText(combo: Combo, level: NormalRank): string {
  const rk = (r: number) => rankName(r, level)
  switch (combo.type) {
    case 'single':
      return rk(combo.rank)
    case 'pair':
      return `对${rk(combo.rank)}`
    case 'triple_pair':
      return '3带2'
    case 'straight': {
      const bot = combo.rank - 4
      return `${rk(bot)}-${rk(combo.rank)}顺`
    }
    case 'tube': {
      const bot = combo.rank - 2
      return `${rk(bot)}${rk(bot)}${rk(bot + 1)}${rk(bot + 1)}${rk(combo.rank)}${rk(combo.rank)}`
    }
    case 'plate': {
      const bot = combo.rank - 1
      return `${rk(bot)}${rk(bot)}${rk(bot)}${rk(combo.rank)}${rk(combo.rank)}${rk(combo.rank)}`
    }
    case 'bomb':
      return `${rk(combo.rank)}炸`
    case 'straight_flush':
      return `同花${rk(combo.rank)}`
    case 'joker_bomb':
      return '天王炸'
    default:
      return `${combo.type}${combo.rank}`
  }
}

interface TrickEntry {
  seat: Seat
  text: string
  isLead: boolean // 是否新一墩起手
}

function cardLabel(c: Card): string {
  if (c.suit === 'JOKER') return c.rank === 'bj' ? '大王' : '小王'
  return `${SUIT_SYM[c.suit] ?? ''}${c.rank}`
}

export interface SessionDeps {
  table: TableView
  hand: HandView
  hud: HudApi
  render: RenderContext
  effects: Effects
  audio: AudioApi
  level: NormalRank
  seed: number
}

/**
 * 对局编排：发牌 → 进贡还贡 → 出牌循环（人类座0 + 三档 AI）→ 名次结算 → 升级 → 下一局。
 * M5：真升级（每局打庄家级牌）、进贡还贡闭环（进贡自动/AI还贡自动/人类半自动还贡）、过A胜负。
 */
export class GameSession {
  private round!: RoundState
  private match: MatchState
  private seed: number
  private roundLevel: NormalRank
  private difficulty: Difficulty = 'normal'
  private seen: Card[] = []
  private aiTimer: number | null = null
  private thinkTimer: number | null = null // 思考动画省略号
  private dealTimer: number | null = null
  private lastFinished: Seat[] | null = null // 上一局名次（算进贡用）
  private aiRng: () => number = mulberry32(1) // hard 档确定化随机源（每局重建）
  private phase: 'play' | 'return' = 'play'
  private humanReturnTo: Seat | null = null // 人类需还贡给谁
  // 提示循环
  private hintMoves: Move[] = []
  private hintIdx = -1
  private hintSig = ''
  private trickLog: TrickEntry[] = []

  constructor(private readonly deps: SessionDeps) {
    this.seed = deps.seed
    this.match = initMatch(0)
    this.roundLevel = this.match.levels[this.match.banker]
    deps.hud.onPlay(() => this.humanPlay())
    deps.hud.onPass(() => this.humanPass())
    deps.hud.onHint(() => this.humanHint())
    deps.hud.onSort(() => {
      const mode = deps.hand.cycleSortMode()
      deps.hud.message(`理牌：${mode}`)
    })
    deps.hud.onDifficulty((d) => this.setDifficulty(d))
    deps.hand.onSelectionChange(() => {
      this.refreshControls()
      if (this.round?.current === 0 && !this.round?.over && this.phase === 'play') this.deps.audio.select()
    })
    deps.hud.setActiveDifficulty(this.difficulty)

    // 键盘快捷键
    const onKey = (e: KeyboardEvent): void => {
      if (e.target !== document.body && (e.target as HTMLElement).tagName !== 'CANVAS') return
      if (this.phase === 'return') {
        if (e.key === 'Enter') this.humanPlay()
        return
      }
      if (this.round.over || this.round.current !== 0) return
      switch (e.key) {
        case 'Enter': e.preventDefault(); this.humanPlay(); break
        case ' ': e.preventDefault(); this.humanPass(); break
        case 'h': this.humanHint(); break
        case 'Escape': this.deps.hand.clearSelection(); break
      }
    }
    window.addEventListener('keydown', onKey)
  }

  start(): void {
    this.startRound()
  }

  setDifficulty(d: Difficulty): void {
    this.difficulty = d
    this.deps.hud.setActiveDifficulty(d)
  }

  /** 按动画速度偏好缩放的延时（速度越快等待越短）。 */
  private ms(base: number): number {
    return Math.round(base / loadPrefs().speed)
  }

  private startRound(): void {
    if (this.aiTimer !== null) { clearTimeout(this.aiTimer); this.aiTimer = null }
    if (this.thinkTimer !== null) { clearInterval(this.thinkTimer); this.thinkTimer = null }
    if (this.dealTimer !== null) { clearTimeout(this.dealTimer); this.dealTimer = null }
    this.seen = []
    this.phase = 'play'
    this.humanReturnTo = null
    this.hintSig = ''
    this.trickLog = []
    this.deps.hud.setTrickLog([])
    this.deps.hud.hideBanner()

    // 本局打庄家（上一局胜方）的级牌
    this.roundLevel = this.match.levels[this.match.banker]
    this.aiRng = mulberry32(this.seed * 7 + 1)
    const hands = deal(this.seed).hands
    this.deps.hud.setLevels(this.match.levels[0], this.match.levels[1], this.match.banker)
    this.deps.table.clearAllPlays()

    // 进贡还贡（首局或过 A 换新局无贡）
    const trib = this.lastFinished ? computeTribute(this.lastFinished, hands, this.roundLevel) : null
    const firstSeat = this.applyTribute(hands, trib)

    this.round = createRound(hands, this.roundLevel, firstSeat)
    this.deps.table.dealFlourish()
    this.deps.hand.setHand(this.round.hands[0], this.roundLevel, true)
    for (let k = 0; k < 6; k++) window.setTimeout(() => this.deps.audio.deal(), 120 + k * 85)
    this.deps.hud.setCounts(this.round.hands.map((h) => h.length), -1)
    this.deps.hud.setTurn('发牌中…')

    if (trib && !trib.kang) this.animateTribute(trib)

    if (this.humanReturnTo !== null) {
      const to = this.humanReturnTo
      this.dealTimer = window.setTimeout(() => { this.dealTimer = null; this.enterReturnPhase(to) }, this.ms(1000))
    } else {
      const delay = trib && !trib.kang ? 1300 : 720 // 有贡则多留时间看动画
      this.dealTimer = window.setTimeout(() => { this.dealTimer = null; this.advance() }, this.ms(delay))
    }
  }

  // ── 进贡还贡 ──────────────────────────────────────────────────────────
  private moveCard(hands: Card[][], from: Seat, to: Seat, card: Card): void {
    const idx = hands[from].findIndex((c) => c.id === card.id)
    if (idx < 0) return
    const [c] = hands[from].splice(idx, 1)
    hands[to].push(c)
  }

  /** 进贡牌更大的一方先出（单贡=该家；双贡=贡牌大者）。 */
  private biggestPayer(transfers: TributeTransfer[]): Seat {
    let best = transfers[0]
    for (const t of transfers) {
      if (singlePower(t.card, this.roundLevel) > singlePower(best.card, this.roundLevel)) best = t
    }
    return best.from
  }

  /** 施加进贡（自动）与 AI 还贡（自动）；人类还贡挂起。返回本局先出者。 */
  private applyTribute(hands: Card[][], trib: TributeResult | null): Seat {
    if (!trib) return 0 // 首局：人类先出
    if (trib.kang) {
      this.deps.hud.message('抗贡！免进贡')
      return this.lastFinished![0] // 头游先出
    }
    for (const t of trib.transfers) this.moveCard(hands, t.from, t.to, t.card)
    for (const r of trib.returns) {
      if (r.from === 0) this.humanReturnTo = r.to // 人类是收贡方 → 手动还
      else this.moveCard(hands, r.from, r.to, r.card) // AI 自动还
    }
    return this.biggestPayer(trib.transfers)
  }

  private animateTribute(trib: TributeResult): void {
    let d = 0
    const fly = (t: TributeTransfer, tag: string): void => {
      window.setTimeout(() => {
        this.deps.table.tributeFly(t.from, t.to, t.card)
        this.deps.audio.deal()
        this.deps.hud.message(`${SEAT_NAMES[t.from]} ${tag} ${cardLabel(t.card)} → ${SEAT_NAMES[t.to]}`)
      }, 450 + d * 260)
      d++
    }
    for (const t of trib.transfers) fly(t, '进贡')
    for (const r of trib.returns) if (r.from !== 0) fly(r, '还贡')
  }

  private enterReturnPhase(to: Seat): void {
    this.phase = 'return'
    const returnable = this.round.hands[0].filter((c) => c.suit !== 'JOKER' && straightValue(c) <= 10)
    const ids = new Set(returnable.map((c) => c.id))
    this.deps.hand.setPlayable(ids.size > 0 ? ids : null)
    this.deps.hud.setCounts(this.round.hands.map((h) => h.length), 0)
    this.deps.hud.setTurn('请还贡')
    this.deps.hud.message(`还贡：选一张 ≤10 的牌回给「${SEAT_NAMES[to]}」，点【出牌】确认`)
    this.refreshControls()
  }

  private confirmReturn(): void {
    const to = this.humanReturnTo
    if (to === null) { this.phase = 'play'; return }
    const sel = this.deps.hand.getSelected()
    if (sel.length !== 1) { this.deps.hud.message('还贡请只选一张牌'); return }
    const card = sel[0]
    if (card.suit === 'JOKER' || straightValue(card) > 10) { this.deps.hud.message('还贡必须是 ≤10 的牌'); return }
    this.moveCard(this.round.hands, 0, to, card)
    this.deps.table.tributeFly(0, to, card)
    this.deps.audio.deal()
    this.humanReturnTo = null
    this.phase = 'play'
    this.deps.hand.clearSelection()
    this.deps.hand.setHand(this.round.hands[0], this.roundLevel)
    this.deps.hud.message(`已还贡 ${cardLabel(card)}`)
    this.advance()
  }

  // ── 出牌循环 ──────────────────────────────────────────────────────────
  private advance(): void {
    if (this.round.over) { this.settle(); return }
    const cur = this.round.current
    this.deps.hud.setCounts(this.round.hands.map((h) => h.length), cur)
    // 清除思考动画计时器
    if (this.thinkTimer !== null) { clearInterval(this.thinkTimer); this.thinkTimer = null }
    if (cur === 0) {
      this.deps.hud.setTurn('轮到你')
      const ids = this.playableIds()
      this.deps.hand.setPlayable(ids)
      this.refreshControls()
      // 跟牌时无牌可出 → 自动过
      if (this.round.table !== null && ids !== null && ids.size === 0) {
        this.deps.hud.message('无牌可出，自动过')
        this.aiTimer = window.setTimeout(() => this.autoPass(), this.ms(500))
      }
    } else {
      let dots = 0
      const name = SEAT_NAMES[cur]
      this.deps.hud.setTurn(`${name} 思考中`)
      this.thinkTimer = window.setInterval(() => {
        dots = (dots + 1) % 4
        this.deps.hud.setTurn(`${name} 思考中${'.'.repeat(dots)}`)
      }, 400)
      this.deps.hand.setPlayable(new Set())
      this.deps.hud.setControls({ canPlay: false, canPass: false, canHint: false })
      this.aiTimer = window.setTimeout(() => this.aiTurn(cur), this.ms(700))
    }
  }

  private aiTurn(seat: Seat): void {
    this.aiTimer = null
    try {
      const ctx: AIContext = {
        hand: this.round.hands[seat],
        table: this.round.table,
        leader: this.round.leader,
        seat,
        level: this.roundLevel,
        handCounts: this.round.hands.map((h) => h.length),
        seen: this.seen,
        finished: this.round.finished,
        passes: this.round.passes,
        rng: this.aiRng,
      }
      const mv = decideAction(ctx, this.difficulty)
      if (mv) {
        const isLead = this.round.table === null
        play(this.round, seat, mv.cards, mv.combo)
        this.resolvePlay(mv.cards, mv.combo, seat, isLead)
        this.deps.hud.message(`${SEAT_NAMES[seat]} 出牌`)
      } else {
        pass(this.round, seat)
        this.deps.audio.pass()
        this.addLog(seat, '过', false)
        this.deps.hud.message(`${SEAT_NAMES[seat]} 过`)
      }
    } catch (e) {
      console.error(`AI ${seat} 出错，自动过牌：`, e)
      try { pass(this.round, seat) } catch (_) { /* 如果连过牌都失败了，跳过 */ }
      this.deps.hud.message(`${SEAT_NAMES[seat]} 出错，跳过`)
    }
    this.advance()
  }

  /** 出牌的视听反馈：新一墩先清桌 + 记牌 + 落桌动画 + 音效 + 炸弹分级特效/屏震 + 逢人配流光。 */
  private resolvePlay(cards: Card[], combo: Combo, seat: Seat, isLead: boolean): void {
    if (isLead) this.deps.table.clearAllPlays() // 新一墩领牌：清掉上一墩四家的牌
    this.seen.push(...cards)
    this.deps.audio.play()
    // 出牌记录（简练：单张/对子只写点数，组合牌用简明格式如 3带2、K炸、555666）
    this.addLog(seat, comboText(combo, this.roundLevel), isLead)
    const wild = cards.some((c) => isWild(c, this.roundLevel))
    const bomb = isBomb(combo)
    const tier = bomb ? bombTier(combo) : 0
    this.deps.table.showPlay(cards, seat, () => {
      if (bomb) {
        const s = tier >= 1000 ? 1 : Math.min((tier - 3) / 6, 1)
        this.deps.effects.bomb(tier)
        this.deps.render.shake(0.07 + 0.22 * s, 0.35 + 0.35 * s)
        this.deps.audio.bomb(tier)
      }
    })
    if (wild) {
      this.deps.effects.wild()
      this.deps.audio.wild()
    }
  }

  private addLog(seat: Seat, text: string, isLead: boolean): void {
    this.trickLog.push({ seat, text, isLead })
    this.deps.hud.setTrickLog(this.trickLog)
  }

  private humanPlay(): void {
    if (this.phase === 'return') { this.confirmReturn(); return }
    if (this.round.over || this.round.current !== 0) return
    const sel = this.deps.hand.getSelected()
    if (sel.length === 0) { this.deps.hud.message('请先选牌'); return }
    const combo = this.pickHumanCombo(sel)
    if (!combo) { this.deps.hud.message('这手牌不成型，或压不过桌面'); return }
    const isLead = this.round.table === null
    const r = play(this.round, 0, sel, combo)
    if (!r.ok) { this.deps.hud.message(r.reason ?? '出牌无效'); return }
    this.resolvePlay(sel, combo, 0, isLead)
    this.deps.hud.message('你出牌')
    this.deps.hand.clearSelection()
    this.deps.hand.setHand(this.round.hands[0], this.roundLevel)
    this.advance()
  }

  private humanPass(): void {
    if (this.phase === 'return' || this.round.over || this.round.current !== 0) return
    const r = pass(this.round, 0)
    if (!r.ok) { this.deps.hud.message(r.reason ?? '不能过'); return }
    this.deps.audio.pass()
    this.addLog(0, '过', false)
    this.deps.hud.message('你过')
    this.advance()
  }

  private autoPass(): void {
    this.aiTimer = null
    if (this.round.over || this.round.current !== 0) return
    pass(this.round, 0)
    this.deps.audio.pass()
    this.addLog(0, '过', false)
    this.advance()
  }

  /** 提示：循环给出所有可能出法（弱→强，炸弹最后），每次点击前进一手。 */
  private humanHint(): void {
    if (this.phase === 'return' || this.round.over || this.round.current !== 0) return
    const table = this.round.table
    const moves = table
      ? generateBeating(this.round.hands[0], this.roundLevel, table)
      : generateMoves(this.round.hands[0], this.roundLevel)
    if (moves.length === 0) {
      this.hintMoves = []
      this.hintSig = ''
      this.deps.hud.message('无可出，建议过牌')
      return
    }
    const sig = `${this.round.hands[0].length}|${table ? `${table.type}${table.rank}${table.length}` : 'lead'}`
    if (sig !== this.hintSig) {
      // combo.rank 已是 singlePower 值（非名义点数），按强度排序天然正确处理级牌
      this.hintMoves = [...moves].sort(
        (a, b) =>
          Number(isBomb(a.combo)) - Number(isBomb(b.combo)) ||
          a.combo.rank - b.combo.rank ||
          a.combo.length - b.combo.length,
      )
      this.hintSig = sig
      this.hintIdx = -1
    }
    this.hintIdx = (this.hintIdx + 1) % this.hintMoves.length
    const mv = this.hintMoves[this.hintIdx]
    this.deps.hand.select(mv.cards.map((c) => c.id))
    this.deps.hud.message(`提示 ${this.hintIdx + 1}/${this.hintMoves.length}（再点换一手）`)
  }

  private pickHumanCombo(sel: Card[]): Combo | null {
    const table = this.round.table
    const legal = getCombos(sel, this.roundLevel).filter((c) => table === null || beats(c, table))
    if (legal.length === 0) return null
    legal.sort((a, b) => Number(isBomb(a)) - Number(isBomb(b)) || a.rank - b.rank)
    return legal[0]
  }

  /** 可出牌 id 集合（自由领出=null 不置灰；跟牌=所有可参与压牌的牌，含等价副本/逢人配）。 */
  private playableIds(): Set<string> | null {
    const table = this.round.table
    if (table === null) return null
    return playableCardIds(this.round.hands[0], this.roundLevel, table)
  }

  private refreshControls(): void {
    if (this.phase === 'return') {
      const sel = this.deps.hand.getSelected()
      const ok = sel.length === 1 && sel[0].suit !== 'JOKER' && straightValue(sel[0]) <= 10
      this.deps.hud.setControls({ canPlay: ok, canPass: false, canHint: false })
      return
    }
    if (this.round.over || this.round.current !== 0) return
    const sel = this.deps.hand.getSelected()
    this.deps.hud.setControls({
      canPlay: sel.length > 0 && this.pickHumanCombo(sel) !== null,
      canPass: this.round.table !== null,
      canHint: true,
    })
  }

  private settle(): void {
    const finished = this.round.finished
    this.lastFinished = [...finished]
    this.match = applyRoundResult(this.match, finished)
    const names = finished.map((s) => SEAT_NAMES[s]).join(' → ')
    const winT = teamOf(finished[0])
    const winName = winT === 0 ? '你方' : '对方'
    const gain = levelGain(finished)
    const won = this.match.winner !== null
    const winTxt = won
      ? `<b style="color:#7a2230">${winName} 打过 A，赢下整场！</b><br>`
      : `${winName} 升 <b>${gain}</b> 级<br>`
    // 下局进贡预告
    const losers = finished.filter((s) => teamOf(s) !== winT)
    const isDouble = teamOf(finished[2]) !== winT && teamOf(finished[3]) !== winT
    recordRound(winT === 0, isDouble, won) // 战绩记账（localStorage）
    let preview = ''
    if (!won) {
      if (isDouble) {
        const headName = SEAT_NAMES[finished[0]]
        const erName = SEAT_NAMES[finished[1]]
        preview = `下局双贡：${SEAT_NAMES[losers[0]]}·${SEAT_NAMES[losers[1]]} 进贡（牌大→${headName}、牌小→${erName}）`
      } else {
        preview = `下局进贡：${SEAT_NAMES[losers[losers.length - 1]]}→${SEAT_NAMES[finished[0]]}`
      }
    }
    const html =
      `本局名次：${names}<br>${winTxt}` +
      `级数　你方 <b>${this.match.levels[0]}</b> · 对方 <b>${this.match.levels[1]}</b><br>` +
      (preview ? `<span style="font-size:15px;color:#7a2230">${preview}</span>` : '')

    this.deps.hud.setTurn('本局结束')
    this.deps.hud.setControls({ canPlay: false, canPass: false, canHint: false })
    this.deps.hand.setPlayable(new Set())
    this.deps.hud.setCounts(this.round.hands.map((h) => h.length), -1)
    if (winT === 0) {
      this.deps.audio.win()
      this.deps.effects.wild()
      if (won) this.deps.render.shake(0.12, 0.5)
    } else {
      this.deps.audio.lose()
    }
    this.deps.hud.showBanner(html, () => {
      this.seed++
      if (won) { this.match = initMatch(0); this.lastFinished = null } // 过A 圆满 → 新一场
      this.startRound()
    })
  }

  getState(): object {
    return {
      level: this.roundLevel,
      banker: this.match.banker,
      phase: this.phase,
      difficulty: this.difficulty,
      current: this.round?.current ?? -1,
      over: this.round?.over ?? false,
      counts: this.round ? this.round.hands.map((h) => h.length) : [],
      tableType: this.round?.table?.type ?? null,
      finished: this.round?.finished ?? [],
      matchLevels: this.match.levels,
      winner: this.match.winner,
      teamOfHead: this.round?.over ? teamOf(this.round.finished[0]) : null,
      shownCards: this.deps.table.shownCards(),
    }
  }
}
