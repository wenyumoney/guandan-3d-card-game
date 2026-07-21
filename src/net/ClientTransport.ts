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
  private _playerName = ''
  private _intentionalClose = false
  private _visibilityUnsub: (() => void) | null = null

  constructor(url: string) {
    this.url = url
  }

  get playerId(): string | null { return this._playerId }
  get roomCode(): string | null { return this._roomCode }
  get playerName(): string { return this._playerName }
  setPlayerName(name: string): void { this._playerName = name }
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
        this._intentionalClose = false
        this.startPing()
        this.reconnectDelay = 1000
        resolve()
      }
      this.ws.onmessage = (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data as string) as ServerMessage
          // 记录 playerId / roomCode
          if (msg.type === 'room_created' || msg.type === 'room_joined' || msg.type === 'game_sync') {
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
        if (!this._intentionalClose) this.scheduleReconnect()
      }
      this.ws.onerror = (e) => {
        console.error('WebSocket error:', e)
        reject(new Error('WebSocket connection failed'))
      }
    })
  }

  disconnect(): void {
    this._intentionalClose = true
    this.stopPing()
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    if (this._visibilityUnsub) { this._visibilityUnsub(); this._visibilityUnsub = null }
    if (this.ws) {
      this.ws.onclose = null
      this.ws.close()
      this.ws = null
    }
  }

  /** 开启页面可见性监听：切回页面时若断线则自动重连并重加入。 */
  enableVisibilityReconnect(): void {
    if (this._visibilityUnsub) return
    const onVis = (): void => {
      if (document.visibilityState === 'visible' && !this.connected && this._roomCode) {
        console.log('transport: visibility restore, reconnecting...')
        this._intentionalClose = false
        this.reconnectDelay = 500
        this.connect().then(() => {
          // 重加入房间（服务器根据 phase 返回 room_joined 或 game_sync）
          this.send({ type: 'join_room', roomCode: this._roomCode!, playerName: this._playerName })
        }).catch(() => {
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay)
        })
      }
    }
    document.addEventListener('visibilitychange', onVis)
    this._visibilityUnsub = () => document.removeEventListener('visibilitychange', onVis)
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
