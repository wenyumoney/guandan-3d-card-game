import { defineConfig, type Plugin } from 'vite'
import { WebSocketServer, WebSocket as WS } from 'ws'
import { RoomManager } from './server/room'
import type { Seat } from './src/core/deal'

const WS_OPEN = WS.OPEN

// Vite 插件：dev 模式下自动启动 WebSocket 联机服务器
function wsServerPlugin(): Plugin {
  return {
    name: 'ws-server',
    configureServer(server) {
      const wss = new WebSocketServer({ port: 8787 })
      const rooms = new RoomManager()
      console.log('🀄 联机服务器 → ws://127.0.0.1:8787')

      wss.on('connection', (ws) => {
        let playerId: string | null = null
        let roomCode: string | null = null

        ws.on('message', (raw) => {
          let msg: { type: string; [key: string]: unknown }
          try { msg = JSON.parse(raw.toString()) } catch { return }
          try { handle(msg, ws) } catch (e) { send(ws, { type: 'error', message: String(e) }) }
        })

        ws.on('close', () => {
          if (roomCode && playerId) {
            // 断线时判断是否游戏中 → AI 接管
            const tookOver = rooms.handleDisconnect(roomCode, playerId)
            if (tookOver) {
              broadcastToRoom(roomCode, { type: 'player_disconnected', playerId: playerId!, seat: tookOver.seat, name: tookOver.name })
              rooms.scheduleAiTurn(roomCode, tookOver.seat)
            }
            rooms.leaveRoom(roomCode, playerId, ws)
          }
        })

        function handle(msg: { type: string; [key: string]: unknown }, ws: Parameters<typeof send>[0]): void {
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
                const sync = rooms.getGameSyncData(roomCode, playerId)
                if (sync) send(ws, { type: 'game_sync', ...sync })
                broadcastRoomUpdate(roomCode!)
              } else {
                send(ws, { type: 'room_joined', roomCode: roomCode!, playerId: playerId!, players: result.players!, seats: result.seats! })
                broadcastRoomUpdate(roomCode!)
              }
              break
            }

            case 'select_seat': {
              if (!roomCode || !playerId) { send(ws, { type: 'error', message: '请先加入房间' }); return }
              const r = rooms.selectSeat(roomCode, playerId, msg.seat as number)
              if (!r.ok) { send(ws, { type: 'error', message: r.error! }); return }
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
              // 延迟发送 turn_notify（等客户端发牌动画 ~1.1s 完成）
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
              if (r.nextAiSeat != null) rooms.scheduleAiTurn(roomCode, r.nextAiSeat)
              break
            }

            case 'leave_room': {
              if (roomCode && playerId) { rooms.leaveRoom(roomCode, playerId, ws); broadcastRoomUpdate(roomCode) }
              roomCode = null; playerId = null
              break
            }
          }
        }

        function broadcastRoomUpdate(code: string): void {
          const info = rooms.getRoomInfo(code)
          if (!info) return
          const msg = { type: 'room_update', players: info.players, seats: info.seats }
          for (const pid of info.playerIds) {
            const c = rooms.getClient(code, pid)
            if (c && c.readyState === WS_OPEN) send(c, msg)
          }
        }

        function broadcastToRoom(code: string, msg: Record<string, unknown>): void {
          const info = rooms.getRoomInfo(code)
          if (!info) return
          for (const pid of info.playerIds) {
            const c = rooms.getClient(code, pid)
            if (c && c.readyState === WS_OPEN) send(c, msg)
          }
        }
      })

      // 随 Vite 关闭一起清理
      server.httpServer?.on('close', () => { wss.close() })
    },
  }
}

function send(ws: { readyState: number; send(data: string): void }, msg: Record<string, unknown>): void {
  if (ws.readyState === WS_OPEN) {
    ws.send(JSON.stringify(msg))
  } else {
    console.warn(`[send] 丢弃 ${msg.type} — WebSocket 状态=${ws.readyState}`)
  }
}

export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 5173 },
  plugins: [wsServerPlugin()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'vendor-three'
        },
      },
    },
  },
})
