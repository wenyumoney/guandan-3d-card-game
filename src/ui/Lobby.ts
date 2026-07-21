// 联机大厅 UI：创建/加入房间、选座、等待开局。

import { ClientTransport } from '../net/ClientTransport'
import type { PlayerInfo, ServerMessage } from '../net/protocol'
import type { Seat } from '../core/deal'

const SEAT_NAME = ['南', '东', '北', '西']
const SEAT_DESC = ['你 (下方)', '下家 (右方)', '队友 (上方)', '上家 (左方)']

export interface LobbyOpts {
  serverUrl: string
  playerName?: string  // 预填昵称
  autoJoinRoom?: string  // URL 参数 ?room=XXXX，自动加入
  onStart: (transport: ClientTransport, localSeat: Seat, msg: ServerMessage & { type: 'game_start' }) => void
  onJoinGame: (transport: ClientTransport, msg: ServerMessage & { type: 'game_sync' }) => void
  onBack: () => void
}

export function createLobby(root: HTMLElement, opts: LobbyOpts): void {
  const transport = new ClientTransport(opts.serverUrl)
  let playerId: string | null = null
  let roomCode: string | null = null

  const el = document.createElement('div')
  el.id = 'lobby'
  el.innerHTML = `
    <div class="lobby-container">
      <!-- 模式选择 -->
      <div class="lobby-mode" id="lobby-mode">
        <h2 class="lobby-title">联机对战</h2>
        <div class="lobby-actions">
          <button class="lobby-btn primary" id="btn-create">创建房间</button>
          <div class="lobby-join-row">
            <input type="text" id="join-code" placeholder="房间码 (4位数字)" maxlength="4" pattern="\\d{4}" />
            <button class="lobby-btn" id="btn-join">加入房间</button>
          </div>
        </div>
        <div class="lobby-name-row">
          <label>昵称：<input type="text" id="player-name" placeholder="你的昵称" maxlength="8" value="${opts.playerName ?? ''}" /></label>
        </div>
        <p class="lobby-status" id="lobby-status">输入房间码或创建新房间</p>
        <button class="lobby-back" id="btn-back">← 返回</button>
      </div>

      <!-- 房间内 -->
      <div class="lobby-room" id="lobby-room" style="display:none">
        <h2 class="lobby-title">房间 <span id="room-code-display"></span>
          <button class="lobby-copy-btn" id="btn-copy-code" title="复制邀请链接">📋 复制链接</button>
        </h2>
        <div class="seat-grid">
          ${[2, 3, 0, 1].map((s) => `
            <button class="seat-slot" id="seat-${s}" data-seat="${s}">
              <span class="seat-dir">${SEAT_NAME[s]}</span>
              <span class="seat-name" id="seat-name-${s}">AI</span>
              <span class="seat-desc">${SEAT_DESC[s]}</span>
            </button>
          `).join('')}
        </div>
        <div class="lobby-player-list" id="player-list"></div>
        <button class="lobby-btn primary" id="btn-start" disabled>等待更多玩家就座…</button>
        <button class="lobby-btn" id="btn-leave">离开房间</button>
        <p class="lobby-status" id="room-status">选择座位后等待房主开始</p>
      </div>
    </div>`

  root.appendChild(el)

  // ── 元素引用 ──
  const $mode = el.querySelector('#lobby-mode')!
  const $room = el.querySelector('#lobby-room')!
  const $status = el.querySelector('#lobby-status')! as HTMLParagraphElement
  const $roomStatus = el.querySelector('#room-status')! as HTMLParagraphElement
  const $roomCodeDisplay = el.querySelector('#room-code-display')!
  const $playerList = el.querySelector('#player-list')!
  const $btnStart = el.querySelector('#btn-start')! as HTMLButtonElement
  const $nameInput = el.querySelector('#player-name')! as HTMLInputElement

  function nameInput(): string {
    return $nameInput.value.trim() || '玩家'
  }

  function setStatus(text: string): void { $status.textContent = text }

  // ── 消息处理 ──
  const unsub = transport.onMessage((msg: ServerMessage) => {
    switch (msg.type) {
      case 'room_created': {
        playerId = msg.playerId
        roomCode = msg.roomCode
        showRoom()
        $roomCodeDisplay.textContent = roomCode
        $roomStatus.textContent = '房间已创建！请选座，等待其他玩家加入'
        updateSeatDisplay([])
        updateStartButton([])
        break
      }
      case 'room_joined': {
        playerId = msg.playerId
        roomCode = msg.roomCode
        showRoom()
        $roomCodeDisplay.textContent = roomCode
        updateSeatDisplay(msg.players)
        updateStartButton(msg.players)
        break
      }
      case 'room_update': {
        updateSeatDisplay(msg.players)
        updateStartButton(msg.players)
        break
      }
      case 'game_start': {
        unsub()
        try {
          opts.onStart(transport, msg.localSeat, msg as ServerMessage & { type: 'game_start' })
        } catch (e) {
          console.error('OnlineSession init failed:', e)
          setStatus('⚠️ 进入游戏失败，请刷新重试')
          return
        }
        el.remove()
        break
      }
      case 'game_sync': {
        // 断线重连 / 中途加入 → 直接进入游戏恢复状态
        unsub()
        try {
          opts.onJoinGame(transport, msg as ServerMessage & { type: 'game_sync' })
        } catch (e) {
          console.error('OnlineSession restore failed:', e)
          setStatus('⚠️ 恢复游戏失败，请刷新重试')
          return
        }
        el.remove()
        break
      }
      case 'error': {
        setStatus(`❌ ${msg.message}`)
        break
      }
      case 'pong': break
    }
  })

  // ── 按钮事件 ──
  el.querySelector('#btn-create')!.addEventListener('click', () => {
    setStatus('连接服务器…')
    transport.setPlayerName(nameInput())
    transport.connect().then(() => {
      transport.enableVisibilityReconnect()
      transport.send({ type: 'create_room', playerName: nameInput() })
    }).catch(() => setStatus('❌ 无法连接服务器'))
  })

  el.querySelector('#btn-join')!.addEventListener('click', () => {
    const code = (el.querySelector('#join-code')! as HTMLInputElement).value.trim()
    if (!/^\d{4}$/.test(code)) { setStatus('请输入4位数字房间码'); return }
    setStatus('连接服务器…')
    transport.setPlayerName(nameInput())
    transport.connect().then(() => {
      transport.enableVisibilityReconnect()
      transport.send({ type: 'join_room', roomCode: code, playerName: nameInput() })
    }).catch(() => setStatus('❌ 无法连接服务器'))
  })

  el.querySelector('#btn-back')!.addEventListener('click', () => {
    transport.disconnect()
    el.remove()
    opts.onBack()
  })

  el.querySelector('#btn-leave')!.addEventListener('click', () => {
    transport.send({ type: 'leave_room' })
    transport.disconnect()
    el.remove()
    opts.onBack()
  })

  $btnStart.addEventListener('click', () => {
    transport.send({ type: 'start_game' })
  })

  // 复制邀请链接
  el.querySelector('#btn-copy-code')!.addEventListener('click', () => {
    if (!roomCode) return
    const url = `${location.protocol}//${location.hostname}:${location.port}?room=${roomCode}`
    navigator.clipboard.writeText(url).then(() => {
      const btn = el.querySelector('#btn-copy-code')!
      btn.textContent = '✓ 已复制'
      btn.classList.add('copied')
      $roomStatus.textContent = '链接已复制，发送给朋友即可一键加入！'
      setTimeout(() => {
        btn.textContent = '📋 复制链接'
        btn.classList.remove('copied')
      }, 2000)
    }).catch(() => {
      $roomStatus.textContent = `房间码：${roomCode}（请手动告知朋友）`
    })
  })

  // 选座
  for (let s = 0; s < 4; s++) {
    const btn = el.querySelector(`#seat-${s}`)!
    btn.addEventListener('click', () => {
      if (!roomCode) return
      transport.send({ type: 'select_seat', seat: s as Seat })
    })
  }

  // ── UI 更新 ──
  function showRoom(): void {
    ($mode as HTMLElement).style.display = 'none'
    ;($room as HTMLElement).style.display = ''
  }

  function updateSeatDisplay(players: PlayerInfo[]): void {
    // 清空（默认显示 AI）
    for (let s = 0; s < 4; s++) {
      const nameEl = el.querySelector(`#seat-name-${s}`)!
      const btn = el.querySelector(`#seat-${s}`)! as HTMLButtonElement
      nameEl.textContent = 'AI'
      btn.classList.remove('occupied', 'mine')
    }
    // 填充已选座位
    for (const p of players) {
      if (p.seat === null) continue
      const nameEl = el.querySelector(`#seat-name-${p.seat}`)!
      const btn = el.querySelector(`#seat-${p.seat}`)! as HTMLButtonElement
      nameEl.textContent = p.name
      btn.classList.add('occupied')
      if (p.id === playerId) btn.classList.add('mine')
    }
    // 更新玩家列表
    $playerList.innerHTML = players.map((p) =>
      `<span class="player-tag">${p.name}${p.seat !== null ? ` (${SEAT_NAME[p.seat]})` : ' (未选座)'}</span>`
    ).join('')
  }

  function updateStartButton(players: PlayerInfo[]): void {
    const seated = players.filter((p) => p.seat !== null).length
    $btnStart.disabled = seated < 1
    if (seated < 2) {
      $btnStart.textContent = seated === 0 ? '请先选座' : `开始游戏（AI 补齐 ${4 - seated} 个空位）`
    } else {
      $btnStart.textContent = '开始游戏'
    }
  }

  // ── 自动加入（URL 参数 ?room=XXXX）──
  if (opts.autoJoinRoom) {
    setStatus('正在加入房间…')
    transport.setPlayerName(nameInput())
    transport.connect().then(() => {
      transport.enableVisibilityReconnect()
      transport.send({ type: 'join_room', roomCode: opts.autoJoinRoom!, playerName: nameInput() })
    }).catch(() => setStatus('❌ 无法连接服务器'))
  }
}
