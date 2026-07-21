// 掼蛋 3D 卡牌 — 生产服务器
// 单端口：HTTP 静态文件 + WebSocket 游戏通信
// 启动：node server/prod.ts  或  npx tsx server/prod.ts

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import { RoomManager } from './room.js'
import type { Seat } from '../src/core/deal.js'

const PORT = parseInt(process.env.PORT ?? '8787', 10)
const DIST = join(fileURLToPath(import.meta.url), '../../dist')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // 静态文件
  let path = (req.url ?? '/').split('?')[0]
  if (path === '/') path = '/index.html'

  try {
    const file = await readFile(join(DIST, path))
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' })
    res.end(file)
  } catch {
    // SPA fallback
    try {
      const index = await readFile(join(DIST, 'index.html'))
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(index)
    } catch {
      res.writeHead(500)
      res.end('Server error')
    }
  }
})

const wss = new WebSocketServer({ server })
const rooms = new RoomManager()

wss.on('connection', (ws: WebSocket) => {
  let playerId: string | null = null
  let roomCode: string | null = null

  ws.on('message', (raw) => {
    let msg: { type: string; [key: string]: unknown }
    try { msg = JSON.parse(raw.toString()) } catch { return }
    try { handle(msg, ws) } catch (e) { send(ws, { type: 'error', message: String(e) }) }
  })

  ws.on('close', () => {
    if (roomCode && playerId) {
      const tookOver = rooms.handleDisconnect(roomCode, playerId)
      if (tookOver) {
        broadcastToRoom(roomCode, { type: 'player_disconnected', playerId: playerId!, seat: tookOver.seat, name: tookOver.name })
        rooms.scheduleAiTurn(roomCode, tookOver.seat)
      }
      rooms.leaveRoom(roomCode, playerId, ws)
    }
  })

  // ── 消息分发 ──
  function handle(msg: { type: string; [key: string]: unknown }, ws: WebSocket): void {
    switch (msg.type) {
      case 'ping': send(ws, { type: 'pong' }); break

      case 'create_room': {
        const { roomCode: code, playerId: pid } = rooms.createRoom(msg.playerName as string, ws)
        playerId = pid; roomCode = code
        send(ws, { type: 'room_created', roomCode: code, playerId: pid })
        break
      }

      case 'join_room': {
        const result = rooms.joinRoom(msg.roomCode as string, msg.playerName as string, ws)
        if (!result.ok) { send(ws, { type: 'error', message: result.error! }); return }
        playerId = result.playerId!; roomCode = msg.roomCode as string
        if (result.isMidGame) {
          // 中局重连：返回可选座位，等玩家选座后再发 game_sync
          send(ws, { type: 'room_joined', roomCode: roomCode!, playerId: playerId!, players: result.players!, seats: result.seats!, isMidGame: true, availableSeats: result.availableSeats! })
          broadcastRoomUpdate(roomCode!)
        } else {
          send(ws, { type: 'room_joined', roomCode: roomCode!, playerId: playerId!, players: result.players!, seats: result.seats! })
          broadcastRoomUpdate(roomCode!)
        }
        break
      }

      case 'select_seat': {
        if (!roomCode || !playerId) { send(ws, { type: 'error', message: '请先加入房间' }); return }
        const r = rooms.selectSeat(roomCode, playerId, msg.seat as Seat)
        if (!r.ok) { send(ws, { type: 'error', message: r.error! }); return }
        if (r.syncData) {
          // 中局重连选座 → 发送 game_sync 恢复游戏
          send(ws, { type: 'game_sync', ...r.syncData })
        }
        broadcastRoomUpdate(roomCode)
        break
      }

      case 'start_game': {
        if (!roomCode || !playerId) { send(ws, { type: 'error', message: '请先加入房间' }); return }
        const r = rooms.startGame(roomCode, playerId)
        if (!r.ok) { send(ws, { type: 'error', message: r.error! }); return }
        for (const sm of r.startMessages!) {
          const c = rooms.getClient(roomCode, sm.playerId as string)
          if (c) send(c, { type: 'game_start', ...sm })
        }
        const rc = roomCode
        if (r.firstTurn) { const ft = r.firstTurn; setTimeout(() => broadcastToRoom(rc, ft), 1200) }
        if (r.firstAiSeat != null) { const aiSeat = r.firstAiSeat as Seat; setTimeout(() => rooms.scheduleAiTurn(rc, aiSeat), 1200) }
        break
      }

      case 'player_action': {
        if (!roomCode || !playerId) { send(ws, { type: 'error', message: '请先加入房间' }); return }
        const r = rooms.handleAction(roomCode, playerId, msg.action as Record<string, unknown>)
        if (!r.ok) { send(ws, { type: 'error', message: r.error! }); return }
        if (r.broadcast) for (const bm of r.broadcast) broadcastToRoom(roomCode, bm)
        if (r.turnNotify) broadcastToRoom(roomCode, r.turnNotify)
        if (r.nextAiSeat != null) rooms.scheduleAiTurn(roomCode, r.nextAiSeat as Seat)
        break
      }

      case 'leave_room': {
        if (roomCode && playerId) { rooms.leaveRoom(roomCode, playerId, ws); broadcastRoomUpdate(roomCode) }
        roomCode = null; playerId = null
        break
      }
    }
  }
})

function broadcastRoomUpdate(code: string): void {
  const info = rooms.getRoomInfo(code)
  if (!info) return
  const msg = { type: 'room_update', players: info.players, seats: info.seats }
  for (const pid of info.playerIds) {
    const c = rooms.getClient(code, pid)
    if (c && c.readyState === WebSocket.OPEN) send(c, msg)
  }
}

function broadcastToRoom(code: string, msg: Record<string, unknown>): void {
  const info = rooms.getRoomInfo(code)
  if (!info) return
  for (const pid of info.playerIds) {
    const c = rooms.getClient(code, pid)
    if (c && c.readyState === WebSocket.OPEN) send(c, msg)
  }
}

function send(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  } else {
    console.warn(`[send] 丢弃 ${msg.type} — WebSocket 状态=${ws.readyState}`)
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🀄 掼蛋联机服务器 → http://0.0.0.0:${PORT}`)
  console.log(`   静态文件: ${DIST}`)
})
