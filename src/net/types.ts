// 联机接口类型——统一从 protocol.ts 导出，保持向后兼容。
// 服务器实现见 server/index.ts。
export type {
  PlayerAction,
  PlayerInfo,
  SeatPlayer,
  ClientMessage,
  ServerMessage,
  CardExport,
} from './protocol'
