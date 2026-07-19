// WebSocket 客户端传输层：连接服务器，收发类型化消息。

import type { ClientMessage, ServerMessage } from './protocol'

export type MessageHandler = (msg: ServerMessage) => void

export class ClientTransport {
  private ws: WebSocket | null = null
  private url: string
  private handlers: Set<MessageHandler> = new Set()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 1000
  private maxReconnectDelay = 30000
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private _playerId: string | null = null
  private _roomCode: string | null = null

  constructor(url: string) {
    this.url = url
  }

  get playerId(): string | null { return this._playerId }
  get roomCode(): string | null { return this._roomCode }
  get connected(): boolean { return this.ws?.readyState === WebSocket.OPEN }

  // ── 连接 ──
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
        resolve()
        return
      }
      try {
        this.ws = new WebSocket(this.url)
      } catch (e) {
        reject(e)
        return
      }
      this.ws.onopen = () => {
        this.startPing()
        this.reconnectDelay = 1000
        resolve()
      }
      this.ws.onmessage = (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data as string) as ServerMessage
          // 记录 playerId / roomCode
          if (msg.type === 'room_created' || msg.type === 'room_joined') {
            this._playerId = msg.playerId
            this._roomCode = msg.roomCode
          }
          for (const h of this.handlers) {
            try { h(msg) } catch (e) { console.error('transport handler error:', e) }
          }
        } catch (e) {
          console.error('transport parse error:', e)
        }
      }
      this.ws.onclose = () => {
        this.stopPing()
        this.scheduleReconnect()
      }
      this.ws.onerror = (e) => {
        console.error('WebSocket error:', e)
        reject(new Error('WebSocket connection failed'))
      }
    })
  }

  disconnect(): void {
    this.stopPing()
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    if (this.ws) {
      this.ws.onclose = null // 不触发重连
      this.ws.close()
      this.ws = null
    }
  }

  // ── 消息 ──
  send(msg: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('transport: not connected, cannot send', msg.type)
      return
    }
    this.ws.send(JSON.stringify(msg))
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler)
    return () => { this.handlers.delete(handler) }
  }

  // ── 心跳 ──
  private startPing(): void {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({ type: 'ping' })
      }
    }, 25000) // 25 秒一次心跳
  }

  private stopPing(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
  }

  // ── 重连 ──
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    console.log(`transport: reconnecting in ${this.reconnectDelay}ms...`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect().catch(() => {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay)
      })
    }, this.reconnectDelay)
  }
}
