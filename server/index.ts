// 掼蛋联机对战服务器：WebSocket 房间管理 + 游戏协调。
// 启动：npx tsx server/index.ts
// 端口：8787（可通过 PORT 环境变量覆盖）

import { WebSocketServer, WebSocket } from 'ws'
import { RoomManager } from './room'

const PORT = parseInt(process.env.PORT ?? '8787', 10)

const wss = new WebSocketServer({ port: PORT })
const rooms = new RoomManager()

console.log(`🀄 掼蛋联机服务器启动 → ws://0.0.0.0:${PORT}`)

wss.on('connection', (ws: WebSocket) => {
  let playerId: string | null = null
  let roomCode: string | null = null

  console.log(`[连接] 新客户端 (活跃 ${wss.clients.size})`)

  ws.on('message', (raw) => {
    let msg: { type: string; [key: string]: unknown }
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      send(ws, { type: 'error', message: '消息格式错误' })
      return
    }

    try {
      handle(msg, ws)
    } catch (e) {
      console.error('[错误]', e)
      send(ws, { type: 'error', message: String(e) })
    }
  })

  ws.on('close', () => {
    console.log(`[断开] ${playerId ?? '未认证'}`)
    if (roomCode && playerId) {
      const tookOver = rooms.handleDisconnect(roomCode, playerId)
      if (tookOver) {
        broadcastToRoom(roomCode, { type: 'player_disconnected', playerId: playerId!, seat: tookOver.seat, name: tookOver.name })
        // 如果断线玩家的回合正在进行中，触发 AI
        rooms.scheduleAiTurn(roomCode, tookOver.seat)
      }
      rooms.leaveRoom(roomCode, playerId, ws)
    }
  })

  ws.on('error', (e) => {
    console.error('[WebSocket error]', e)
  })

  // ── 消息分发 ──
  function handle(msg: { type: string; [key: string]: unknown }, ws: WebSocket): void {
    switch (msg.type) {
      case 'ping': {
        send(ws, { type: 'pong' })
        break
      }

      case 'create_room': {
        const { roomCode: code, playerId: pid } = rooms.createRoom(msg.playerName as string, ws)
        playerId = pid
        roomCode = code
        send(ws, { type: 'room_created', roomCode: code, playerId: pid })
        break
      }

      case 'join_room': {
        const result = rooms.joinRoom(msg.roomCode as string, msg.playerName as string, ws)
        if (!result.ok) { send(ws, { type: 'error', message: result.error! }); return }
        playerId = result.playerId!
        roomCode = msg.roomCode as string
        send(ws, {
          type: 'room_joined',
          roomCode: roomCode!,
          playerId: playerId!,
          players: result.players!,
          seats: result.seats!,
        })
        // 广播房间更新给其他人
        broadcastRoom(roomCode!)
        break
      }

      case 'select_seat': {
        if (!roomCode || !playerId) { send(ws, { type: 'error', message: '请先加入房间' }); return }
        const r = rooms.selectSeat(roomCode, playerId, msg.seat as number)
        if (!r.ok) { send(ws, { type: 'error', message: r.error! }); return }
        broadcastRoom(roomCode)
        break
      }

      case 'start_game': {
        if (!roomCode || !playerId) { send(ws, { type: 'error', message: '请先加入房间' }); return }
        const r = rooms.startGame(roomCode, playerId)
        if (!r.ok) { send(ws, { type: 'error', message: r.error! }); return }
        // 给每个已就座的玩家发送 game_start（含各自手牌）
        for (const startMsg of r.startMessages!) {
          const client = rooms.getClient(roomCode, startMsg.playerId)
          if (client) send(client, { type: 'game_start', ...startMsg })
        }
        // 发送初始 turn_notify
        if (r.firstTurn) broadcastToRoom(roomCode, r.firstTurn)
        // 如果第一个是 AI，触发 AI 决策
        if (r.firstAiSeat !== null && r.firstAiSeat !== undefined) {
          rooms.scheduleAiTurn(roomCode, r.firstAiSeat)
        }
        break
      }

      case 'player_action': {
        if (!roomCode || !playerId) { send(ws, { type: 'error', message: '请先加入房间' }); return }
        const r = rooms.handleAction(roomCode, playerId, msg.action as Record<string, unknown>)
        if (!r.ok) { send(ws, { type: 'error', message: r.error! }); return }
        // 广播动作 + 通知下一轮
        if (r.broadcast) {
          for (const bm of r.broadcast) broadcastToRoom(roomCode, bm)
        }
        if (r.turnNotify) broadcastToRoom(roomCode, r.turnNotify)
        // 如果下一个是 AI，触发 AI 决策
        if (r.nextAiSeat !== undefined && r.nextAiSeat !== null) {
          rooms.scheduleAiTurn(roomCode, r.nextAiSeat)
        }
        break
      }

      case 'leave_room': {
        if (roomCode && playerId) {
          rooms.leaveRoom(roomCode, playerId, ws)
          broadcastRoom(roomCode)
        }
        roomCode = null
        playerId = null
        break
      }

      default: {
        send(ws, { type: 'error', message: `未知消息类型: ${msg.type}` })
      }
    }
  }

  function broadcastRoom(code: string): void {
    const info = rooms.getRoomInfo(code)
    if (!info) return
    for (const pid of info.playerIds) {
      const client = rooms.getClient(code, pid)
      if (client && client.readyState === WebSocket.OPEN) {
        send(client, { type: 'room_update', players: info.players, seats: info.seats })
      }
    }
  }

  function broadcastToRoom(code: string, msg: Record<string, unknown>): void {
    const info = rooms.getRoomInfo(code)
    if (!info) return
    for (const pid of info.playerIds) {
      const client = rooms.getClient(code, pid)
      if (client && client.readyState === WebSocket.OPEN) {
        send(client, msg)
      }
    }
  }
})

function send(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n🛑 服务器关闭')
  wss.close()
  process.exit(0)
})
process.on('SIGTERM', () => {
  wss.close()
  process.exit(0)
})
