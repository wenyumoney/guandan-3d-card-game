// 联机协议：Client ↔ Server 消息类型定义。
// 由客户端和服务端共享——两边 import 同一份类型，保证协议一致性。

import type { NormalRank } from '../core/cards'
import type { Combo } from '../core/combos'
import type { Seat } from '../core/deal'
import type { MatchState } from '../core/scoring'

// ── PlayerAction（复用原占位类型，稍作扩展） ──
export type PlayerAction =
  | { kind: 'play'; seat: Seat; cardIds: string[]; combo: Combo }
  | { kind: 'pass'; seat: Seat }
  | { kind: 'tributeGive'; seat: Seat; cardId: string }
  | { kind: 'tributeReturn'; seat: Seat; cardId: string }

// ── 玩家信息 ──
export interface PlayerInfo {
  id: string
  name: string
  seat: Seat | null  // null = 尚未选座
}

// ── 座位上的玩家 ──
export interface SeatPlayer {
  playerId: string
  name: string
  cardCount: number
}

// ── Client → Server ──
export type ClientMessage =
  | { type: 'create_room'; playerName: string }
  | { type: 'join_room'; roomCode: string; playerName: string }
  | { type: 'select_seat'; seat: Seat }
  | { type: 'start_game' }
  | { type: 'player_action'; action: PlayerAction }
  | { type: 'leave_room' }
  | { type: 'ping' }

// ── Server → Client ──
export type ServerMessage =
  | { type: 'room_created'; roomCode: string; playerId: string }
  | { type: 'room_joined'; roomCode: string; playerId: string; players: PlayerInfo[]; seats: (string | null)[] }
  | { type: 'room_update'; players: PlayerInfo[]; seats: (string | null)[] }
  | { type: 'game_start'; seed: number; level: NormalRank; matchLevels: [NormalRank, NormalRank]; banker: 0 | 1; hand: CardExport[]; localSeat: Seat; seatPlayers: (SeatPlayer | null)[] }
  | { type: 'turn_notify'; seat: Seat; table: Combo | null }
  | { type: 'action_broadcast'; action: PlayerAction }
  | { type: 'round_end'; finished: Seat[]; match: MatchState; tributePreview: string }
  | { type: 'error'; message: string }
  | { type: 'pong' }
  | { type: 'player_disconnected'; playerId: string; seat: Seat; name: string }

// ── Card 的序列化形式（Card.id 包含所有信息，但为清晰仍拆分） ──
export interface CardExport {
  id: string
  suit: string
  rank: string
}
