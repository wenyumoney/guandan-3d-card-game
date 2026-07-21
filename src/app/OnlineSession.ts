// 联机客户端游戏会话：接收服务端状态，发送玩家操作，驱动渲染。

import { type Card, type NormalRank, LEVEL_POWER, SMALL_JOKER_POWER, BIG_JOKER_POWER } from '../core/cards'
import { type Seat, teamOf } from '../core/deal'
import { getCombos, beats, isBomb, bombTier, type Combo } from '../core/combos'
import { generateMoves, generateBeating, playableCardIds, type Move } from '../core/moves'
import { type ClientTransport } from '../net/ClientTransport'
import type { ServerMessage, PlayerAction, SeatPlayer } from '../net/protocol'
import { type TableView } from '../render/Table'
import { type HandView } from '../render/HandView'
import { type RenderContext } from '../render/Renderer'
import { type Effects } from '../render/effects'
import { type AudioApi } from '../audio/audio'
import { type HudApi } from '../ui/Hud'

const SEAT_NAMES = ['你', '下家', '队友', '上家']

/** 从 card.id 重建 Card 对象（用于渲染，客户端没有完整的 Card 实例）。 */
function cardFromId(id: string): Card {
  if (id.startsWith('JOKER-')) {
    const rank = id.includes('bj') ? 'bj' as const : 'sj' as const
    return { id, suit: 'JOKER', rank }
  }
  const parts = id.split('-')
  return { id, suit: parts[0] as Card['suit'], rank: parts[1] as Card['rank'] }
}

function rankName(r: number, level: NormalRank): string {
  if (r === BIG_JOKER_POWER) return '大王'
  if (r === SMALL_JOKER_POWER) return '小王'
  if (r === LEVEL_POWER) return level
  if (r === 14) return 'A'; if (r === 13) return 'K'; if (r === 12) return 'Q'; if (r === 11) return 'J'
  return String(r)
}

function comboText(combo: Combo, level: NormalRank): string {
  const rk = (r: number) => rankName(r, level)
  switch (combo.type) {
    case 'single': return rk(combo.rank)
    case 'pair': return `对${rk(combo.rank)}`
    case 'triple_pair': return '3带2'
    case 'straight': { const bot = combo.rank - 4; return `${rk(bot)}-${rk(combo.rank)}顺` }
    case 'tube': { const bot = combo.rank - 2; return `${rk(bot)}${rk(bot)}${rk(bot + 1)}${rk(bot + 1)}${rk(combo.rank)}${rk(combo.rank)}` }
    case 'plate': { const bot = combo.rank - 1; return `${rk(bot)}${rk(bot)}${rk(bot)}${rk(combo.rank)}${rk(combo.rank)}${rk(combo.rank)}` }
    case 'bomb': return `${rk(combo.rank)}炸`
    case 'straight_flush': return `同花${rk(combo.rank)}`
    case 'joker_bomb': return '天王炸'
    default: return `${combo.type}${combo.rank}`
  }
}

interface TrickEntry { seat: Seat; text: string; isLead: boolean }

export interface OnlineSessionDeps {
  table: TableView
  hand: HandView
  hud: HudApi
  render: RenderContext
  effects: Effects
  audio: AudioApi
}

export class OnlineSession {
  private transport: ClientTransport
  private deps: OnlineSessionDeps
  private localSeat!: Seat
  private level!: NormalRank
  private hand: Card[] = []
  private handCounts: number[] = [27, 27, 27, 27]
  private table: Combo | null = null
  private current: Seat = 0
  private finished: Seat[] = []
  private trickLog: TrickEntry[] = []
  private hintMoves: Move[] = []
  private hintIdx = -1
  private hintSig = ''
  private seatNames: string[] = [...SEAT_NAMES]
  private unsub: (() => void) | null = null

  constructor(transport: ClientTransport, deps: OnlineSessionDeps, msg: ServerMessage & ({ type: 'game_start' } | { type: 'game_sync' })) {
    this.transport = transport
    this.deps = deps

    if (msg.type === 'game_sync') {
      this.initFromSync(msg as ServerMessage & { type: 'game_sync' })
    } else {
      this.initFromStart(msg as ServerMessage & { type: 'game_start' })
    }
  }

  private initCommon(msg: { localSeat: Seat; level: NormalRank; matchLevels: [NormalRank, NormalRank]; banker: 0 | 1; hand: Array<{ id: string; suit: string; rank: string }>; seatPlayers: (SeatPlayer | null)[] }): void {
    this.localSeat = msg.localSeat
    this.level = msg.level

    for (let s = 0; s < 4; s++) {
      const sp = msg.seatPlayers[s]
      if (sp) this.seatNames[s] = sp.name
    }

    this.hand = msg.hand.map((c) => ({ id: c.id, suit: c.suit as Card['suit'], rank: c.rank as Card['rank'] }))
    this.deps.hand.setHand(this.hand, this.level, true)

    this.deps.hud.setLevels(msg.matchLevels[0], msg.matchLevels[1], msg.banker)
    this.deps.hud.message(`联机对战 · 你是 ${this.seatNames[this.localSeat]} (${SEAT_NAMES[this.localSeat]})`)

    // 注册按钮回调
    this.deps.hud.onPlay(() => this.humanPlay())
    this.deps.hud.onPass(() => this.humanPass())
    this.deps.hud.onHint(() => this.humanHint())
    this.deps.hud.onSort(() => {
      const mode = this.deps.hand.cycleSortMode()
      this.deps.hud.message(`理牌：${mode}`)
    })
    this.deps.hud.onClear(() => this.deps.hand.clearSelection())
    this.deps.hand.onSelectionChange(() => this.refreshControls())

    // 键盘快捷键
    const onKey = (e: KeyboardEvent): void => {
      if (e.target !== document.body && (e.target as HTMLElement).tagName !== 'CANVAS') return
      if (this.finished.includes(this.localSeat)) return
      if (this.current !== this.localSeat) return
      switch (e.key) {
        case 'Enter': e.preventDefault(); this.humanPlay(); break
        case ' ': e.preventDefault(); this.humanPass(); break
        case 'h': this.humanHint(); break
        case 'Escape': this.deps.hand.clearSelection(); break
      }
    }
    window.addEventListener('keydown', onKey)

    // 监听服务端消息
    this.unsub = this.transport.onMessage((m: ServerMessage) => this.handleServerMsg(m))
  }

  private initFromStart(msg: ServerMessage & { type: 'game_start' }): void {
    this.initCommon(msg)

    for (let s = 0; s < 4; s++) {
      const sp = msg.seatPlayers[s]
      this.handCounts[s] = sp ? sp.cardCount : 27
    }
    this.current = msg.localSeat // 初始轮次：服务端 tur_notify 会纠正，此处防止 delay 丢失
    this.deps.hud.setCounts(this.handCounts, -1)
    this.deps.hud.setTurn('等待…')
    this.deps.hud.setControls({ canPlay: false, canPass: false, canHint: false })
    this.deps.table.dealFlourish()
    this.deps.audio.play()
  }

  private initFromSync(msg: ServerMessage & { type: 'game_sync' }): void {
    this.initCommon(msg)

    this.handCounts = [...msg.handCounts]
    this.finished = [...msg.finished]
    this.current = msg.currentTurn
    this.table = msg.table

    // 恢复桌面：重放当前墩的出牌历史
    this.deps.table.clearAllPlays()
    for (const tp of msg.trickPlays) {
      const cards = tp.cardIds.map(cardFromId)
      this.deps.table.showPlay(cards as Card[], tp.seat)
      const text = comboText(tp.combo, this.level)
      if (this.trickLog.length === 0) {
        this.trickLog.push({ seat: tp.seat, text, isLead: true })
      } else {
        // 服务端 trickPlays 按顺序排列，只有第一条是领牌
        this.trickLog.push({ seat: tp.seat, text, isLead: false })
      }
    }
    this.deps.hud.setTrickLog(this.trickLog)
    this.deps.hud.setCounts(this.handCounts, msg.currentTurn)
    this.deps.hud.setControls({ canPlay: false, canPass: false, canHint: false })

    if (this.finished.includes(this.localSeat)) {
      this.deps.hud.setTurn('你已完成')
      this.deps.hud.setControls({ canPlay: false, canPass: false, canHint: false })
    } else if (msg.currentTurn === this.localSeat) {
      this.onMyTurn()
    } else {
      this.deps.hud.setTurn(`${this.seatNames[msg.currentTurn]} 思考中…`)
      this.deps.hand.setPlayable(new Set())
    }

    this.deps.hud.message(`已恢复联机 · 你是 ${this.seatNames[this.localSeat]} (${SEAT_NAMES[this.localSeat]})`)
    this.deps.audio.play()
  }

  destroy(): void {
    this.unsub?.()
    this.transport.disconnect()
  }

  // ── 服务端消息处理 ──
  private handleServerMsg(msg: ServerMessage): void {
    switch (msg.type) {
      case 'game_start': {
        // 新一局开始（可能是第二局+）
        this.level = msg.level
        this.hand = msg.hand.map((c) => ({ id: c.id, suit: c.suit as Card['suit'], rank: c.rank as Card['rank'] }))
        this.handCounts = msg.seatPlayers.map((sp) => sp ? sp.cardCount : 27)
        this.localSeat = msg.localSeat
        for (let s = 0; s < 4; s++) {
          const sp = msg.seatPlayers[s]
          if (sp) this.seatNames[s] = sp.name
        }
        this.table = null
        this.current = msg.localSeat
        this.finished = []
        this.trickLog = []
        this.deps.hand.setHand(this.hand, this.level, true)
        this.deps.hud.setLevels(msg.matchLevels[0], msg.matchLevels[1], msg.banker)
        this.deps.hud.setCounts(this.handCounts, -1)
        this.deps.hud.setTrickLog([])
        this.deps.hud.hideBanner()
        this.deps.hud.setTurn('等待…')
        this.deps.table.clearAllPlays()
        this.deps.table.dealFlourish()
        break
      }

      case 'turn_notify': {
        this.current = msg.seat
        this.table = msg.table
        if (msg.table === null) {
          this.deps.table.clearAllPlays()
          this.trickLog = []
          this.deps.hud.setTrickLog([])
        }
        this.deps.hud.setCounts(this.handCounts, msg.seat)
        if (msg.seat === this.localSeat) {
          this.onMyTurn()
        } else {
          this.deps.hud.setTurn(`${this.seatNames[msg.seat]} 思考中…`)
          this.deps.hand.setPlayable(new Set())
          this.deps.hud.setControls({ canPlay: false, canPass: false, canHint: false })
        }
        break
      }

      case 'action_broadcast': {
        const action = msg.action
        if (action.kind === 'play') {
          this.animatePlay(action)
        } else if (action.kind === 'pass') {
          this.deps.audio.pass()
          this.addLog(action.seat, '过', false)
          this.deps.hud.message(`${this.seatNames[action.seat]} 过`)
        }
        // 更新手牌数
        if (action.seat !== this.localSeat) {
          if (action.kind === 'play') {
            this.handCounts[action.seat] -= action.cardIds.length
          }
        }
        this.deps.hud.setCounts(this.handCounts, this.current)
        break
      }

      case 'round_end': {
        this.finished = msg.finished
        this.deps.hud.setTurn('本局结束')
        this.deps.hud.setControls({ canPlay: false, canPass: false, canHint: false })
        this.deps.hand.setPlayable(new Set())

        const winT = teamOf(msg.finished[0])
        const names = msg.finished.map((s) => this.seatNames[s]).join(' → ')
        const won = msg.match.winner !== null
        const html = `本局名次：${names}<br>${won ? '过A 胜利！' : ''}级数 你方 <b>${msg.match.levels[0]}</b> · 对方 <b>${msg.match.levels[1]}</b><br><span style="font-size:15px;color:#7a2230">${msg.tributePreview}</span>`

        if (winT === teamOf(this.localSeat)) { this.deps.audio.win(); this.deps.effects.wild() }
        else { this.deps.audio.lose() }

        this.deps.hud.showBanner(html, () => {
          // 等待服务端开始下一局
          this.deps.hud.message('等待下一局…')
        })
        break
      }

      case 'error': {
        this.deps.hud.message(`❌ ${msg.message}`)
        break
      }

      case 'game_sync': {
        // 游戏中重连：不重注册回调，仅同步状态
        this.localSeat = msg.localSeat
        this.level = msg.level
        this.hand = msg.hand.map((c) => ({ id: c.id, suit: c.suit as Card['suit'], rank: c.rank as Card['rank'] }))
        this.handCounts = [...msg.handCounts]
        this.finished = [...msg.finished]
        this.current = msg.currentTurn
        this.table = msg.table
        this.trickLog = []
        for (let s = 0; s < 4; s++) {
          const sp = msg.seatPlayers[s]
          if (sp) this.seatNames[s] = sp.name
        }
        this.deps.hand.setHand(this.hand, this.level, true)
        this.deps.hud.setLevels(msg.matchLevels[0], msg.matchLevels[1], msg.banker)
        // 恢复桌面
        this.deps.table.clearAllPlays()
        for (const tp of msg.trickPlays) {
          const cards = tp.cardIds.map(cardFromId)
          this.deps.table.showPlay(cards as Card[], tp.seat)
          this.trickLog.push({ seat: tp.seat, text: comboText(tp.combo, this.level), isLead: this.trickLog.length === 0 })
        }
        this.deps.hud.setTrickLog(this.trickLog)
        this.deps.hud.setCounts(this.handCounts, msg.currentTurn)
        if (this.finished.includes(this.localSeat)) {
          this.deps.hud.setTurn('你已完成')
          this.deps.hud.setControls({ canPlay: false, canPass: false, canHint: false })
        } else if (this.current === this.localSeat) {
          this.onMyTurn()
        } else {
          this.deps.hud.setTurn(`${this.seatNames[this.current]} 思考中…`)
          this.deps.hand.setPlayable(new Set())
          this.deps.hud.setControls({ canPlay: false, canPass: false, canHint: false })
        }
        this.deps.hud.message('已恢复联机')
        break
      }

      case 'player_disconnected': {
        this.deps.hud.message(`${msg.name} 已断线`)
        break
      }

      case 'pong': break
      default: break
    }
  }

  // ── 我的回合 ──
  private onMyTurn(): void {
    this.deps.hud.setTurn('轮到你')
    const ids = this.playableIds()
    this.deps.hand.setPlayable(ids)
    this.refreshControls()

    // 跟牌时无牌可出 → 自动过
    if (this.table !== null && ids !== null && ids.size === 0) {
      this.deps.hud.message('无牌可出，自动过')
      setTimeout(() => this.autoPass(), 500)
    }
  }

  private humanPlay(): void {
    if (this.current !== this.localSeat) return
    if (this.finished.includes(this.localSeat)) return
    const sel = this.deps.hand.getSelected()
    if (sel.length === 0) { this.deps.hud.message('请先选牌'); return }
    const combo = this.pickCombo(sel)
    if (!combo) { this.deps.hud.message('这手牌不成型，或压不过桌面'); return }

    // 发送到服务端，等待广播回来再动画
    this.transport.send({
      type: 'player_action',
      action: { kind: 'play', seat: this.localSeat, cardIds: sel.map((c) => c.id), combo },
    })

    // 乐观更新：从手牌移除
    const selIds = new Set(sel.map((c) => c.id))
    this.hand = this.hand.filter((c) => !selIds.has(c.id))
    this.handCounts[this.localSeat] = this.hand.length
    this.deps.hand.setHand(this.hand, this.level)
    this.deps.hand.clearSelection()
  }

  private humanPass(): void {
    if (this.current !== this.localSeat) return
    if (this.finished.includes(this.localSeat)) return
    if (this.table === null) { this.deps.hud.message('领牌不能过'); return }
    this.transport.send({
      type: 'player_action',
      action: { kind: 'pass', seat: this.localSeat },
    })
  }

  private autoPass(): void {
    if (this.current !== this.localSeat) return
    this.transport.send({
      type: 'player_action',
      action: { kind: 'pass', seat: this.localSeat },
    })
  }

  // ── 提示 ──
  private humanHint(): void {
    if (this.current !== this.localSeat) return
    if (this.finished.includes(this.localSeat)) return
    const moves = this.table
      ? generateBeating(this.hand, this.level, this.table)
      : generateMoves(this.hand, this.level)
    if (moves.length === 0) {
      this.hintMoves = []; this.hintSig = ''
      this.deps.hud.message('无可出，建议过牌')
      return
    }
    const sig = `${this.hand.length}|${this.table ? `${this.table.type}${this.table.rank}` : 'lead'}`
    if (sig !== this.hintSig) {
      this.hintMoves = [...moves].sort(
        (a, b) => Number(isBomb(a.combo)) - Number(isBomb(b.combo)) || a.combo.rank - b.combo.rank || a.combo.length - b.combo.length,
      )
      this.hintSig = sig; this.hintIdx = -1
    }
    this.hintIdx = (this.hintIdx + 1) % this.hintMoves.length
    const mv = this.hintMoves[this.hintIdx]
    this.deps.hand.select(mv.cards.map((c) => c.id))
    this.deps.hud.message(`提示 ${this.hintIdx + 1}/${this.hintMoves.length}`)
  }

  // ── 动画 ──
  private animatePlay(action: PlayerAction & { kind: 'play' }): void {
    const isLead = this.table === null
    if (isLead) this.deps.table.clearAllPlays()
    const cards = action.cardIds.map(cardFromId)

    this.deps.table.showPlay(cards as Card[], action.seat, () => {
      if (isBomb(action.combo)) {
        const tier = bombTier(action.combo)
        const s = tier >= 1000 ? 1 : Math.min((tier - 3) / 6, 1)
        this.deps.effects.bomb(tier)
        this.deps.render.shake(0.07 + 0.22 * s, 0.35 + 0.35 * s)
        this.deps.audio.bomb(tier)
      }
    })
    this.deps.audio.play()
    this.addLog(action.seat, comboText(action.combo, this.level), isLead)
    this.deps.hud.message(`${this.seatNames[action.seat]} 出牌`)
  }

  private addLog(seat: Seat, text: string, isLead: boolean): void {
    this.trickLog.push({ seat, text, isLead })
    this.deps.hud.setTrickLog(this.trickLog)
  }

  // ── 工具 ──
  private pickCombo(sel: Card[]): Combo | null {
    const legal = getCombos(sel, this.level).filter((c) => this.table === null || beats(c, this.table))
    if (legal.length === 0) return null
    legal.sort((a, b) => Number(isBomb(a)) - Number(isBomb(b)) || a.rank - b.rank)
    return legal[0]
  }

  private playableIds(): Set<string> | null {
    if (this.table === null) return null
    return playableCardIds(this.hand, this.level, this.table)
  }

  private refreshControls(): void {
    if (this.current !== this.localSeat) return
    if (this.finished.includes(this.localSeat)) return
    const sel = this.deps.hand.getSelected()
    this.deps.hud.setControls({
      canPlay: sel.length > 0 && this.pickCombo(sel) !== null,
      canPass: this.table !== null,
      canHint: true,
    })
  }
}
