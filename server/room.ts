// 房间管理器：房间增删查、选座、游戏开始、行动校验、AI 调度。

import { WebSocket } from 'ws'
import { deal, teamOf, type Seat } from '../src/core/deal'
import { createRound, play, pass, type RoundState } from '../src/core/round'
import { initMatch, applyRoundResult, computeTribute, levelGain, type MatchState, type TributeResult } from '../src/core/scoring'
import { mulberry32 } from '../src/core/rng'
import { getCombos, beats, type Combo } from '../src/core/combos'
import { generateBeating } from '../src/core/moves'
import { singlePower, type Card, type NormalRank } from '../src/core/cards'
import { decideAction, type AIContext } from '../src/ai/ai'
import type { PlayerInfo, PlayerAction } from '../src/net/protocol'

// ── 简易 ID 生成 ──
let idSeq = 0
function uid(): string { return `p${Date.now().toString(36)}_${(idSeq++).toString(36)}` }
function roomCodeGen(): string {
  return String(Math.floor(1000 + Math.random() * 9000))
}

/** 找到下一个有牌在手的活跃座位。 */
function findNextActive(round: RoundState, from: Seat): Seat {
  let s = ((from + 1) % 4) as Seat
  while (round.hands[s].length === 0) s = ((s + 1) % 4) as Seat
  return s
}

/** 在手牌之间移动一张牌。 */
function moveCard(hands: Card[][], from: Seat, to: Seat, card: Card): void {
  const idx = hands[from].findIndex((c) => c.id === card.id)
  if (idx < 0) return
  const [c] = hands[from].splice(idx, 1)
  hands[to].push(c)
}

/** 进贡牌最大者先出。 */
function biggestPayer(transfers: Array<{ from: Seat; to: Seat; card: Card }>): Seat {
  let best = transfers[0]
  for (const t of transfers) {
    if (singlePower(t.card, '2' as NormalRank) > singlePower(best.card, '2' as NormalRank)) best = t
  }
  return best.from
}

// ── 玩家连接 ──
interface PlayerConn {
  id: string
  name: string
  seat: Seat | null
  ws: WebSocket
}

// ── 游戏协调器（每个房间一局一个） ──
class GameCoordinator {
  round: RoundState
  match: MatchState
  seed: number
  level: NormalRank
  lastFinished: Seat[] | null = null
  private aiRng: () => number
  phase: 'play' | 'tribute_give' | 'tribute_return' = 'play'
  /** 座位→玩家id映射（null=AI） */
  seatPlayers: (string | null)[]
  /** 当前墩的出牌历史（用于断线重连恢复桌面状态）。leader 在清桌时重置。 */
  trickPlays: Array<{ seat: Seat; cardIds: string[]; combo: Combo }> = []

  constructor(hands: Array<Array<{ id: string; suit: string; rank: string }>>, level: NormalRank, seed: number, match: MatchState, seatPlayers: (string | null)[]) {
    this.level = level
    this.seed = seed
    this.match = match
    this.seatPlayers = seatPlayers
    this.aiRng = mulberry32(seed * 7 + 1)
    // 转换 Card 格式（id 里有所有信息，直接使用）
    const cards = hands as unknown as Array<Array<import('../src/core/cards').Card>>
    this.round = createRound(cards, level, 0) // 先默认 0 先出，可能会被进贡覆盖
  }

  /** 获取某个座位的玩家 id（null = AI） */
  playerAt(seat: Seat): string | null { return this.seatPlayers[seat] }

  /** 某个座位是否为 AI */
  isAi(seat: Seat): boolean { return this.seatPlayers[seat] === null }

  /** AI 决策（在服务端运行） */
  aiDecide(seat: Seat): PlayerAction | null {
    const ctx: AIContext = {
      hand: this.round.hands[seat],
      table: this.round.table,
      leader: this.round.leader,
      seat,
      level: this.level,
      handCounts: this.round.hands.map((h) => h.length),
      seen: [], // 服务端可维护 seen 列表但当前简化
      finished: this.round.finished,
      passes: this.round.passes,
      rng: this.aiRng,
    }
    const mv = decideAction(ctx, 'hard') // 联机 AI 统一用 hard 档
    if (!mv) return { kind: 'pass', seat }
    return { kind: 'play', seat, cardIds: mv.cards.map((c) => c.id), combo: mv.combo }
  }

  /** 应用一个 PlayerAction（出牌或过牌），返回是否成功 */
  applyAction(action: PlayerAction): { ok: boolean; error?: string } {
    if (action.kind === 'pass') {
      const r = pass(this.round, action.seat)
      return { ok: r.ok, error: r.reason }
    }
    if (action.kind === 'play') {
      // 从手牌中找到对应 cardIds 的牌
      const cards = action.cardIds
        .map((id) => this.round.hands[action.seat].find((c) => c.id === id))
        .filter(Boolean) as import('../src/core/cards').Card[]
      if (cards.length !== action.cardIds.length) {
        return { ok: false, error: '牌不在手牌中' }
      }
      // 新一墩领牌 → 清桌面历史
      if (this.round.table === null) {
        this.trickPlays = []
      }
      this.trickPlays.push({ seat: action.seat, cardIds: action.cardIds, combo: action.combo })
      const r = play(this.round, action.seat, cards, action.combo)
      return { ok: r.ok, error: r.reason }
    }
    return { ok: false, error: '未知动作类型' }
  }
}

// ── 房间 ──
interface Room {
  code: string
  players: Map<string, PlayerConn>  // playerId → connection
  seats: (string | null)[]          // seat → playerId (null=AI/空闲)
  phase: 'lobby' | 'playing' | 'settle'
  coordinator: GameCoordinator | null
  aiTimer: ReturnType<typeof setTimeout> | null
}

// ── 管理器 ──
export class RoomManager {
  private rooms = new Map<string, Room>()
  private MAX_ROOMS = 50

  // ── 房间操作 ──
  createRoom(playerName: string, ws: WebSocket): { roomCode: string; playerId: string } {
    if (this.rooms.size >= this.MAX_ROOMS) {
      throw new Error('服务器房间已满，请稍后再试')
    }
    const pid = uid()
    let code: string
    do { code = roomCodeGen() } while (this.rooms.has(code))

    const room: Room = {
      code,
      players: new Map(),
      seats: [null, null, null, null],
      phase: 'lobby',
      coordinator: null,
      aiTimer: null,
    }
    room.players.set(pid, { id: pid, name: playerName, seat: null, ws })
    this.rooms.set(code, room)
    console.log(`[房间] ${code} 创建 (创建者 ${playerName})`)
    return { roomCode: code, playerId: pid }
  }

  joinRoom(code: string, playerName: string, ws: WebSocket): {
    ok: boolean; error?: string; playerId?: string; players?: PlayerInfo[]; seats?: (string | null)[]; isMidGame?: boolean; assignedSeat?: number
  } {
    const room = this.rooms.get(code)
    if (!room) return { ok: false, error: '房间不存在' }

    // lobby 阶段：正常加入（最多4人）
    if (room.phase === 'lobby') {
      if (room.players.size >= 4) return { ok: false, error: '房间已满（最多4人）' }
      const pid = uid()
      room.players.set(pid, { id: pid, name: playerName, seat: null, ws })
      console.log(`[房间] ${code} ${playerName} 加入 (${room.players.size}/4)`)
      return { ok: true, playerId: pid, players: this.playerList(room), seats: room.seats, isMidGame: false }
    }

    // playing/settle 阶段：断线重连或中途加入（需要有 AI 空座）
    const coord = room.coordinator
    if (!coord) return { ok: false, error: '游戏状态异常' }

    // 先检查是否已有同名玩家断线重连（同一个 ws 可能不同，按名字匹配）
    // 查找空座（AI 座位）
    let assignedSeat: number | null = null
    for (let s = 0; s < 4; s++) {
      if (coord.seatPlayers[s] === null) {
        assignedSeat = s
        break
      }
    }
    if (assignedSeat === null) return { ok: false, error: '房间已满，没有空位' }

    const pid = uid()
    const conn: PlayerConn = { id: pid, name: playerName, seat: assignedSeat as Seat, ws }
    room.players.set(pid, conn)
    room.seats[assignedSeat] = pid
    coord.seatPlayers[assignedSeat] = pid
    console.log(`[房间] ${code} ${playerName} 重连加入 → 座${assignedSeat} (${room.players.size}/4)`)
    return { ok: true, playerId: pid, players: this.playerList(room), seats: room.seats, isMidGame: true, assignedSeat }
  }

  leaveRoom(code: string, playerId: string, ws: WebSocket): void {
    const room = this.rooms.get(code)
    if (!room) return
    const p = room.players.get(playerId)
    if (!p) return
    // 释放座位
    if (p.seat !== null) {
      room.seats[p.seat] = null
      // 同步更新 coordinator 的 seatPlayers（若游戏进行中）
      if (room.coordinator) {
        room.coordinator.seatPlayers[p.seat] = null
      }
    }
    room.players.delete(playerId)
    console.log(`[房间] ${code} ${p.name} 离开 (${room.players.size}/4)`)
    // lobby 阶段无玩家则删除；playing/settle 保留（AI 接管或等待重连）
    if (room.players.size === 0 && room.phase === 'lobby') {
      this.cleanupRoom(room)
      this.rooms.delete(code)
      console.log(`[房间] ${code} 已删除`)
    }
  }

  selectSeat(code: string, playerId: string, seat: Seat): { ok: boolean; error?: string } {
    const room = this.rooms.get(code)
    if (!room) return { ok: false, error: '房间不存在' }
    if (room.phase !== 'lobby') return { ok: false, error: '游戏已开始' }
    const p = room.players.get(playerId)
    if (!p) return { ok: false, error: '玩家不在房间' }
    if (room.seats[seat] !== null) return { ok: false, error: '该座位已被占用' }

    // 释放旧座位
    if (p.seat !== null) room.seats[p.seat] = null
    p.seat = seat
    room.seats[seat] = playerId
    console.log(`[房间] ${code} ${p.name} → 座${seat}`)
    return { ok: true }
  }

  startGame(code: string, playerId: string): {
    ok: boolean; error?: string
    startMessages?: Array<{ playerId: string; seed: number; level: string; matchLevels: [string, string]; banker: number; hand: Array<{ id: string; suit: string; rank: string }>; localSeat: number; seatPlayers: Array<{ playerId: string; name: string; cardCount: number } | null> }>
    firstTurn?: { type: string; seat: number; table: null }
    firstAiSeat?: number | null
  } {
    const room = this.rooms.get(code)
    if (!room) return { ok: false, error: '房间不存在' }
    if (room.phase !== 'lobby') return { ok: false, error: '游戏已开始' }

    // 至少2个真人已选座
    const seatedHumans = [...room.players.values()].filter((p) => p.seat !== null)
    if (seatedHumans.length < 1) return { ok: false, error: '至少需要1个真人就座才能开始' }

    // 自动就座：未选座的真人自动分配空座
    const unseated = [...room.players.values()].filter((p) => p.seat === null)
    for (const p of unseated) {
      const emptyIdx = room.seats.findIndex((s, i) => s === null && !room.seats[i])
      if (emptyIdx !== -1) {
        const empty = emptyIdx as Seat
        p.seat = empty
        room.seats[empty] = p.id
      }
    }

    // 座位→玩家id（null=AI）
    const seatPlayers: (string | null)[] = room.seats.map((pid) => {
      if (pid === null) return null  // AI
      return pid
    })

    const seed = Math.floor(Math.random() * 2147483647)
    const { hands } = deal(seed)
    const match = initMatch(0)
    const level = match.levels[match.banker]

    // 创建协调器
    room.coordinator = new GameCoordinator(hands, level, seed, match, seatPlayers)
    room.phase = 'playing'

    // 构造给每个真人玩家的 game_start 消息（只含自己的手牌）
    const startMessages: Array<{ playerId: string; seed: number; level: string; matchLevels: [string, string]; banker: number; hand: Array<{ id: string; suit: string; rank: string }>; localSeat: number; seatPlayers: Array<{ playerId: string; name: string; cardCount: number } | null> }> = []
    for (const [pid, conn] of room.players) {
      const seat = conn.seat!
      const handCards = hands[seat].map((c) => ({ id: c.id, suit: c.suit, rank: c.rank }))
      const sps: Array<{ playerId: string; name: string; cardCount: number } | null> = [0, 1, 2, 3].map((s) => {
        const spId = seatPlayers[s]
        if (spId === null) return { playerId: '', name: s === conn.seat ? conn.name : `AI-${['南', '东', '北', '西'][s]}`, cardCount: 27 }
        const spConn = room.players.get(spId)
        return { playerId: spId, name: spConn?.name ?? '未知', cardCount: 27 }
      })
      startMessages.push({ playerId: pid, seed, level, matchLevels: match.levels, banker: match.banker, hand: handCards, localSeat: seat, seatPlayers: sps })
    }

    console.log(`[房间] ${code} 游戏开始 (seed=${seed}, ${room.players.size}人)`)
    const firstSeat = room.coordinator!.round.current
    const firstAiSeat = room.coordinator!.isAi(firstSeat) ? firstSeat : null
    return { ok: true, startMessages, firstTurn: { type: 'turn_notify', seat: firstSeat, table: null }, firstAiSeat }
  }

  handleAction(code: string, playerId: string, rawAction: Record<string, unknown>): {
    ok: boolean; error?: string; broadcast?: Array<Record<string, unknown>>; turnNotify?: Record<string, unknown>; nextAiSeat?: number | null
  } {
    const room = this.rooms.get(code)
    if (!room || !room.coordinator) return { ok: false, error: '游戏未开始' }
    if (room.phase !== 'playing') return { ok: false, error: '游戏不在进行中' }

    const coord = room.coordinator
    const p = room.players.get(playerId)
    if (!p || p.seat === null) return { ok: false, error: '玩家未就座' }

    const action = rawAction as unknown as PlayerAction
    action.seat = p.seat // 服务端强制指定seat，防止伪造

    // 校验轮次
    if (coord.round.current !== p.seat) return { ok: false, error: '还没轮到你' }

    // 应用动作
    const r = coord.applyAction(action)
    if (!r.ok) return { ok: false, error: r.error }

    // 广播给所有客户端
    const broadcast: Array<Record<string, unknown>> = [{ type: 'action_broadcast', action }]

    // 推进回合
    const round = coord.round
    const next = findNextActive(round, p.seat)
    round.current = next

    // 检查是否本轮结束
    if (round.over) {
      // 结算
      const finished = round.finished
      coord.match = applyRoundResult(coord.match, finished)
      coord.level = coord.match.levels[coord.match.banker] // 同步级别
      coord.lastFinished = [...finished]
      const winT = teamOf(finished[0])
      const losers = finished.filter((s) => teamOf(s) !== winT)
      const isDouble = teamOf(finished[2]) !== winT && teamOf(finished[3]) !== winT
      let tributePreview = ''
      if (!coord.match.winner) {
        if (isDouble) tributePreview = '下局双贡'
        else tributePreview = `下局进贡：输家→头游`
      }
      broadcast.push({
        type: 'round_end',
        finished: round.finished,
        match: coord.match,
        tributePreview,
      })
      room.phase = 'settle'
      this.scheduleNextRound(code)
      return { ok: true, broadcast, turnNotify: { type: 'turn_notify', seat: -1, table: null } }
    }

    // 发送 turn_notify
    const turnNotify = { type: 'turn_notify', seat: round.current, table: round.table }
    const nextAiSeat = coord.isAi(round.current) ? round.current : null
    return { ok: true, broadcast, turnNotify, nextAiSeat }
  }

  scheduleAiTurn(code: string, seat: Seat): void {
    const room = this.rooms.get(code)
    if (!room || !room.coordinator) return
    const coord = room.coordinator
    if (!coord.isAi(seat)) return

    // AI 延迟 700ms 模拟思考时间
    room.aiTimer = setTimeout(() => {
      room.aiTimer = null
      if (!room.coordinator || room.coordinator !== coord) return
      if (coord.round.current !== seat) return
      if (coord.round.over) return

      const action = coord.aiDecide(seat)
      if (!action) return

      const r = coord.applyAction(action)
      if (!r.ok) { console.error(`[AI] 座${seat} 决策失败: ${r.error}`); return }

      // 广播 AI 动作 + turn_notify
      const round = coord.round
      for (const [pid, conn] of room.players) {
        if (conn.ws.readyState === WebSocket.OPEN) {
          conn.ws.send(JSON.stringify({ type: 'action_broadcast', action }))
        }
      }

      // 推进到下一个活跃座位
      const next = findNextActive(round, seat)
      round.current = next

      if (round.over) {
        const finished = round.finished
        coord.match = applyRoundResult(coord.match, finished)
        coord.level = coord.match.levels[coord.match.banker]
        coord.lastFinished = [...finished]
        room.phase = 'settle'
        for (const [, conn] of room.players) {
          if (conn.ws.readyState === WebSocket.OPEN) {
            conn.ws.send(JSON.stringify({
              type: 'round_end', finished, match: coord.match, tributePreview: '',
            }))
          }
        }
        this.scheduleNextRound(code)
      } else {
        // 发送 turn_notify
        const turnNotify = JSON.stringify({ type: 'turn_notify', seat: round.current, table: round.table })
        for (const [, conn] of room.players) {
          if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(turnNotify)
        }
        // 如果下一个又是 AI，继续调度
        if (coord.isAi(round.current)) {
          this.scheduleAiTurn(code, round.current)
        }
      }
    }, 700)
  }

  // ── 断线接管 ──
  handleDisconnect(code: string, playerId: string): { seat: Seat; name: string } | null {
    const room = this.rooms.get(code)
    if (!room || !room.coordinator) return null
    if (room.phase !== 'playing') return null
    const p = room.players.get(playerId)
    if (!p || p.seat === null) return null
    const seat = p.seat
    const name = p.name
    // 将该座位标记为 AI
    room.coordinator.seatPlayers[seat] = null
    return { seat, name }
  }

  // ── 下一局 ──
  restartRound(code: string): {
    ok: boolean; error?: string
    startMessages?: Array<Record<string, unknown>>
    firstTurn?: Record<string, unknown>
    firstAiSeat?: number | null
  } {
    const room = this.rooms.get(code)
    if (!room || !room.coordinator) return { ok: false, error: '无活跃游戏' }
    if (room.phase !== 'settle') return { ok: false, error: '当前不在结算状态' }

    const coord = room.coordinator
    const lastFinished = coord.lastFinished
    if (!lastFinished) return { ok: false, error: '无上局结果' }

    // 检查是否整场结束
    if (coord.match.winner !== null) {
      coord.match = initMatch(0)
      coord.lastFinished = null
    }

    // 计算进贡
    const newSeed = Math.floor(Math.random() * 2147483647)
    const { hands } = deal(newSeed)
    const trib = lastFinished ? computeTribute(lastFinished, hands, coord.level) : null

    // 自动进贡还贡
    if (trib && !trib.kang) {
      for (const t of trib.transfers) {
        moveCard(hands, t.from, t.to, t.card)
      }
      for (const r of trib.returns) {
        // 自动还贡：AI 和 真人都自动还（简化）
        moveCard(hands, r.from, r.to, r.card)
      }
    }

    const firstSeat = trib && !trib.kang ? biggestPayer(trib.transfers) : (lastFinished?.[0] ?? 0)

    // 创建新协调器
    const newLevel = coord.match.levels[coord.match.banker]
    const newCoord = new GameCoordinator(hands, newLevel, newSeed, coord.match, coord.seatPlayers)
    newCoord.lastFinished = lastFinished
    newCoord.round = createRound(hands as unknown as Array<Array<import('../src/core/cards').Card>>, newLevel, firstSeat)

    room.coordinator = newCoord
    room.phase = 'playing'

    // 构造 startMessages
    const startMessages: Array<Record<string, unknown>> = []
    for (const [pid, conn] of room.players) {
      const seat = conn.seat!
      const handCards = hands[seat].map((c) => ({ id: c.id, suit: c.suit, rank: c.rank }))
      const sps: Array<{ playerId: string; name: string; cardCount: number } | null> = [0, 1, 2, 3].map((s) => {
        const spId = newCoord.seatPlayers[s]
        if (spId === null) return { playerId: '', name: conn.seat === s ? conn.name : `AI-${['南', '东', '北', '西'][s]}`, cardCount: hands[s].length }
        const spConn = room.players.get(spId)
        return { playerId: spId, name: spConn?.name ?? '未知', cardCount: hands[s].length }
      })
      startMessages.push({ playerId: pid, seed: newSeed, level: newCoord.level, matchLevels: newCoord.match.levels, banker: newCoord.match.banker, hand: handCards, localSeat: seat, seatPlayers: sps })
    }

    const firstSeatVal = newCoord.round.current
    const firstAiSeat = newCoord.isAi(firstSeatVal) ? firstSeatVal : null
    return { ok: true, startMessages, firstTurn: { type: 'turn_notify', seat: firstSeatVal, table: null }, firstAiSeat }
  }

  // ── 查询 ──
  getClient(code: string, playerId: string): WebSocket | undefined {
    return this.rooms.get(code)?.players.get(playerId)?.ws
  }

  getRoomInfo(code: string): { players: PlayerInfo[]; seats: (string | null)[]; playerIds: string[] } | null {
    const room = this.rooms.get(code)
    if (!room) return null
    return {
      players: this.playerList(room),
      seats: room.seats,
      playerIds: [...room.players.keys()],
    }
  }

  getGameSyncData(code: string, playerId: string): Record<string, unknown> | null {
    const room = this.rooms.get(code)
    if (!room || !room.coordinator) return null
    const coord = room.coordinator
    const p = room.players.get(playerId)
    if (!p || p.seat === null) return null

    const seat = p.seat
    const handCards = coord.round.hands[seat].map((c) => ({ id: c.id, suit: c.suit, rank: c.rank }))
    const sps: Array<{ playerId: string; name: string; cardCount: number } | null> = [0, 1, 2, 3].map((s) => {
      const spId = coord.seatPlayers[s]
      if (spId === null) return { playerId: '', name: `AI-${['南', '东', '北', '西'][s]}`, cardCount: coord.round.hands[s].length }
      const spConn = room.players.get(spId)
      return { playerId: spId, name: spConn?.name ?? '未知', cardCount: coord.round.hands[s].length }
    })

    return {
      localSeat: seat,
      level: coord.level,
      matchLevels: coord.match.levels,
      banker: coord.match.banker,
      hand: handCards,
      seatPlayers: sps,
      currentTurn: coord.round.current,
      table: coord.round.table,
      handCounts: coord.round.hands.map((h) => h.length),
      finished: coord.round.finished,
      trickPlays: coord.trickPlays,
      playerId,
      roomCode: code,
    }
  }

  // ── 内部 ──
  private playerList(room: Room): PlayerInfo[] {
    return [...room.players.values()].map((p) => ({ id: p.id, name: p.name, seat: p.seat }))
  }

  scheduleNextRound(code: string): void {
    const room = this.rooms.get(code)
    if (!room || room.phase !== 'settle') return
    if (room.aiTimer) { clearTimeout(room.aiTimer); room.aiTimer = null }
    // 5 秒后自动开始下一局
    room.aiTimer = setTimeout(() => {
      room.aiTimer = null
      const r = this.restartRound(code)
      if (!r.ok) { console.error(`[房间] ${code} 重启失败: ${r.error}`); return }
      // 发送 game_start
      for (const sm of r.startMessages!) {
        const client = this.getClient(code, sm.playerId as string)
        if (client && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'game_start', ...sm }))
        }
      }
      // 发送 turn_notify
      if (r.firstTurn) {
        for (const [, conn] of room.players) {
          if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(r.firstTurn))
        }
      }
      // 触发 AI
      if (r.firstAiSeat !== null && r.firstAiSeat !== undefined) {
        this.scheduleAiTurn(code, r.firstAiSeat as Seat)
      }
    }, 5000)
  }

  private cleanupRoom(room: Room): void {
    if (room.aiTimer) { clearTimeout(room.aiTimer); room.aiTimer = null }
  }
}
