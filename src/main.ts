import './styles.css'
import { createRenderer } from './render/Renderer'
import { createTable } from './render/Table'
import { createHandView } from './render/HandView'
import { createEffects } from './render/effects'
import { createHud } from './ui/Hud'
import { createMenu } from './ui/Menu'
import { createLobby } from './ui/Lobby'
import { ClientTransport } from './net/ClientTransport'
import type { Seat } from './core/deal'
import type { ServerMessage } from './net/protocol'
import { createAudio } from './audio/audio'
import { GameSession } from './app/GameSession'
import { OnlineSession } from './app/OnlineSession'
import { loadPrefs, savePrefs, loadStats } from './app/prefs'
import { Tweens } from './render/tween'

declare global {
  interface Window {
    __THREE_GAME_DIAGNOSTICS__?: () => object
    __FX_TEST__?: (kind: 'bomb' | 'wild', tier?: number) => void
    __PAUSE__?: (p: boolean) => void
    __READY__?: boolean
  }
}

const app = document.getElementById('app')
if (!app) throw new Error('#app not found')

const render = createRenderer(app)
const tweens = new Tweens()
render.onFrame((dt) => tweens.update(dt))

const audio = createAudio()
const table = createTable(render.scene, tweens)
const effects = createEffects(render.scene, tweens)
const hand = createHandView(render.scene, render.camera, render.domElement, tweens)
const hud = createHud(app)

// ── 偏好恢复（localStorage）──
const prefs = loadPrefs()
if (prefs.quality) render.setQuality(prefs.quality)
tweens.timeScale = prefs.speed
audio.setMuted(prefs.muted)
audio.setVolume(prefs.volume)
hud.setActiveQuality(render.getQuality())
hud.setMuted(prefs.muted)
hud.setVolume(prefs.volume)
hud.setActiveSpeed(prefs.speed)

hud.onQuality((q) => { render.setQuality(q); savePrefs({ quality: q }) })
hud.onMute((m) => {
  audio.setMuted(m)
  if (!m) audio.startBgm()
  savePrefs({ muted: m })
})
hud.onVolume((v) => { audio.setVolume(v); savePrefs({ volume: v }) })
hud.onSpeed((s) => { tweens.timeScale = s; hud.setActiveSpeed(s); savePrefs({ speed: s }) })
hud.onDifficulty((d) => savePrefs({ difficulty: d })) // 难度应用由 GameSession 自身监听

const session = new GameSession({ table, hand, hud, render, effects, audio, level: '2', seed: Date.now() })
session.setDifficulty(prefs.difficulty)

// 首个用户手势解锁音频并起 BGM（浏览器自动播放策略；点菜单即触发）
const unlock = (): void => {
  audio.unlock()
  if (!audio.isMuted()) audio.startBgm()
}
window.addEventListener('pointerdown', unlock, { once: true })

// 开局菜单：选难度 → 开始
const startLocal = (d: Parameters<typeof session.setDifficulty>[0]): void => {
  session.setDifficulty(d)
  savePrefs({ difficulty: d })
  session.start()
}

// 解析 URL 参数 — 朋友分享的 ?room=XXXX 自动加入
let autoJoinRoom: string | undefined = (() => {
  const code = new URLSearchParams(location.search).get('room')
  if (code) window.history.replaceState(null, '', location.pathname) // 即时清理 URL
  return code ?? undefined
})()

// WebSocket 地址：开发模式用独立端口 8787，生产模式用同主机 /ws 路径
const wsUrl = import.meta.env.DEV
  ? `ws://${location.hostname}:8787`
  : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`

const startOnline = (): void => {
  session.deactivate() // 停用离线 GameSession，避免回调冲突
  createLobby(app, {
    serverUrl: wsUrl,
    playerName: '',
    autoJoinRoom,
    onStart: (transport: ClientTransport, _localSeat: Seat, msg: ServerMessage & { type: 'game_start' }) => {
      autoJoinRoom = undefined
      new OnlineSession(transport, { table, hand, hud, render, effects, audio }, msg)
    },
    onJoinGame: (transport: ClientTransport, msg: ServerMessage & { type: 'game_sync' }) => {
      autoJoinRoom = undefined
      new OnlineSession(transport, { table, hand, hud, render, effects, audio }, msg)
    },
    onBack: () => {
      autoJoinRoom = undefined
      createMenu(app, {
        stats: loadStats(),
        initialDifficulty: prefs.difficulty,
        onStart: startLocal,
        onOnline: startOnline,
      })
    },
  })
}

// 自动加入房间（分享链接）→ 跳过菜单，直接进大厅
if (autoJoinRoom) {
  startOnline()
} else {
  createMenu(app, {
    stats: loadStats(),
    initialDifficulty: prefs.difficulty,
    onStart: startLocal,
    onOnline: startOnline,
  })
}

// 诊断 / QA / 特效钩子（仅开发/测试环境，生产构建 tree-shaking 移除）
if (import.meta.env.DEV) {
  window.__THREE_GAME_DIAGNOSTICS__ = () => ({
    fps: render.getFps(),
    quality: render.getQuality(),
    renderer: render.renderer.info.render,
    tweens: tweens.active,
    muted: audio.isMuted(),
    selected: hand.getSelected().length,
    state: session.getState(),
  })
  window.__FX_TEST__ = (kind, tier = 6) => {
    if (kind === 'bomb') {
      effects.bomb(tier)
      const s = tier >= 1000 ? 1 : Math.min((tier - 3) / 6, 1)
      render.shake(0.07 + 0.22 * s, 0.35 + 0.35 * s)
      audio.bomb(tier)
    } else {
      effects.wild()
      audio.wild()
    }
  }
  window.__PAUSE__ = (p) => tweens.setPaused(p)
}
// 测试钩子（供 bot playtest / canvas 检查使用，仅 dev）
if (import.meta.env.DEV) {
  window.__THREE_GAME_TEST_HOOKS__ = {
    seed(value: number) {
      // 重建 session 用新种子（下一局起效）
      ;(session as unknown as { seed: number }).seed = value
    },
    setState(_name: string) {
      // 命名状态映射由调用方管理，此处提供占位
    },
    setPausedForScreenshot(paused: boolean) {
      window.__PAUSE__?.(paused)
    },
  }
}
window.__READY__ = true
