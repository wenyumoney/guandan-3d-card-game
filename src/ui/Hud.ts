import { type NormalRank } from '../core/cards'
import { type Difficulty } from '../ai/ai'
import { type Quality } from '../render/Renderer'

export interface HudApi {
  setLevels(you: NormalRank, opp: NormalRank, banker: 0 | 1): void
  setCounts(counts: number[], active: number): void
  setTurn(text: string): void
  message(text: string): void
  setControls(opts: { canPlay: boolean; canPass: boolean; canHint: boolean }): void
  setActiveDifficulty(d: Difficulty): void
  setActiveQuality(q: Quality): void
  setMuted(m: boolean): void
  setVolume(v: number): void
  setActiveSpeed(s: number): void
  showBanner(html: string, onReplay: () => void): void
  hideBanner(): void
  setTrickLog(entries: { seat: number; text: string; isLead: boolean }[]): void
  onPlay(cb: () => void): void
  onPass(cb: () => void): void
  onHint(cb: () => void): void
  onDifficulty(cb: (d: Difficulty) => void): void
  onQuality(cb: (q: Quality) => void): void
  onMute(cb: (muted: boolean) => void): void
  onVolume(cb: (v: number) => void): void
  onSpeed(cb: (s: number) => void): void
  onSort(cb: () => void): void
  onClear(cb: () => void): void
}

const SEAT_NAMES = ['你', '下家', '队友', '上家']
const SEAT_ANCHOR: [string, string][] = [
  ['50%', '82%'], ['92%', '46%'], ['50%', '15%'], ['8%', '46%'],
]

export function createHud(root: HTMLElement): HudApi {
  const hud = document.createElement('div')
  hud.id = 'hud'
  hud.innerHTML = `
    <div class="topbar">
      <span class="brand">掼蛋</span>
      <span class="stat">你方 <b id="hud-lv-you">2</b> · 对方 <b id="hud-lv-opp">2</b> <span id="hud-banker" class="banker"></span></span>
      <span class="sep"></span>
      <span id="hud-turn">发牌中…</span>
      <span class="group diff">
        <span class="glabel">难度</span>
        <button data-d="easy">简单</button>
        <button data-d="normal">普通</button>
        <button data-d="hard">困难</button>
      </span>
      <span class="group qual">
        <span class="glabel">画质</span>
        <button data-q="high">高</button>
        <button data-q="medium">中</button>
        <button data-q="low">低</button>
      </span>
      <button id="btn-mute" class="mute" title="音乐/音效开关">🔊</button>
      <button id="btn-settings" class="mute" title="设置">⚙</button>
    </div>
    <div class="settings" id="hud-settings">
      <button id="btn-settings-close" class="settings-close" title="关闭">✕</button>
      <div class="srow"><span class="glabel">音量</span><input id="set-vol" type="range" min="0" max="100" value="100"></div>
      <div class="srow"><span class="glabel">动画速度</span><span class="group speed">
        <button data-s="0.7">慢</button>
        <button data-s="1">正常</button>
        <button data-s="1.5">快</button>
      </span></div>
    </div>
    <div class="msg" id="hud-msg"></div>
    <div class="controls">
      <button id="btn-sort" class="sort" title="循环切换排列：点数→同花顺">理牌</button>
      <button id="btn-clear" class="sort" title="取消选择">重选</button>
      <button id="btn-log-toggle" class="sort log-toggle" title="出牌记录">📜</button>
      <button id="btn-hint">提示</button>
      <button id="btn-pass">过</button>
      <button id="btn-play" class="primary">出牌</button>
    </div>
    <div class="banner" id="hud-banner"></div>
    <div class="tricklog" id="hud-log" style="display:none"><div class="tricklog-inner"></div></div>`
  root.appendChild(hud)

  const seatEls: HTMLDivElement[] = []
  for (let s = 0; s < 4; s++) {
    const el = document.createElement('div')
    el.className = 'seat'
    el.style.left = SEAT_ANCHOR[s][0]
    el.style.top = SEAT_ANCHOR[s][1]
    el.innerHTML = `<span class="sname">${SEAT_NAMES[s]}</span> <span class="cnt">27</span>`
    hud.appendChild(el)
    seatEls.push(el)
  }

  const $ = <T extends HTMLElement>(id: string): T => hud.querySelector(`#${id}`) as T
  const lvYou = $('hud-lv-you')
  const lvOpp = $('hud-lv-opp')
  const bankerEl = $('hud-banker')
  const turnEl = $('hud-turn')
  const msgEl = $('hud-msg')
  const bannerEl = $<HTMLDivElement>('hud-banner')
  const logEl = $<HTMLDivElement>('hud-log')
  const logInner = logEl.querySelector('.tricklog-inner') as HTMLDivElement
  const btnPlay = $<HTMLButtonElement>('btn-play')
  const btnPass = $<HTMLButtonElement>('btn-pass')
  const btnHint = $<HTMLButtonElement>('btn-hint')
  const btnSort = $<HTMLButtonElement>('btn-sort')
  const btnMute = $<HTMLButtonElement>('btn-mute')
  const btnSettings = $<HTMLButtonElement>('btn-settings')
  const settingsEl = $<HTMLDivElement>('hud-settings')
  const btnSettingsClose = $<HTMLButtonElement>('btn-settings-close')
  const btnClear = $<HTMLButtonElement>('btn-clear')
  const btnLogToggle = $<HTMLButtonElement>('btn-log-toggle')
  const volSlider = $<HTMLInputElement>('set-vol')
  const diffBtns = [...hud.querySelectorAll<HTMLButtonElement>('.diff button')]
  const qualBtns = [...hud.querySelectorAll<HTMLButtonElement>('.qual button')]
  const speedBtns = [...hud.querySelectorAll<HTMLButtonElement>('.speed button')]
  let muted = false

  btnSettings.addEventListener('click', () => settingsEl.classList.toggle('show'))
  btnSettingsClose.addEventListener('click', () => settingsEl.classList.remove('show'))
  btnLogToggle.addEventListener('click', () => logEl.classList.toggle('show-mobile'))

  const applyMuteIcon = (): void => {
    btnMute.textContent = muted ? '🔇' : '🔊'
    btnMute.classList.toggle('off', muted)
  }

  return {
    setLevels: (you, opp, banker) => {
      lvYou.textContent = String(you)
      lvOpp.textContent = String(opp)
      bankerEl.textContent = `打 ${banker === 0 ? you : opp}（${banker === 0 ? '你方' : '对方'}庄）`
    },
    setCounts: (counts, active) => {
      counts.forEach((c, s) => {
        const cnt = seatEls[s].querySelector('.cnt')
        if (cnt) cnt.textContent = String(c)
        seatEls[s].classList.toggle('active', s === active)
      })
    },
    setTurn: (text) => { turnEl.textContent = text },
    message: (text) => { msgEl.textContent = text },
    setControls: ({ canPlay, canPass, canHint }) => {
      btnPlay.disabled = !canPlay
      btnPass.disabled = !canPass
      btnHint.disabled = !canHint
    },
    setActiveDifficulty: (d) => {
      diffBtns.forEach((b) => b.classList.toggle('active', b.dataset.d === d))
    },
    setActiveQuality: (q) => {
      qualBtns.forEach((b) => b.classList.toggle('active', b.dataset.q === q))
    },
    setMuted: (m) => {
      muted = m
      applyMuteIcon()
    },
    setVolume: (v) => {
      volSlider.value = String(Math.round(v * 100))
    },
    setActiveSpeed: (s) => {
      speedBtns.forEach((b) => b.classList.toggle('active', Number(b.dataset.s) === s))
    },
    showBanner: (html, onReplay) => {
      bannerEl.innerHTML = `<div class="banner-scroll">${html}<div style="margin-top:14px"><button id="btn-replay" class="primary">再来一局</button></div></div>`
      bannerEl.classList.add('show')
      const rb = bannerEl.querySelector('#btn-replay') as HTMLButtonElement
      rb.addEventListener('click', () => { bannerEl.classList.remove('show'); onReplay() })
    },
    hideBanner: () => bannerEl.classList.remove('show'),
    setTrickLog(entries) {
      if (entries.length === 0) { logEl.style.display = 'none'; logInner.innerHTML = ''; return }
      logEl.style.display = 'block'
      const items = entries.slice(-30) // 最多显示 30 条
      logInner.innerHTML = items
        .map((e, i) => {
          const prefix = e.isLead ? '<span class="lead-dot">●</span> ' : ''
          const cls = e.seat === 0 ? 'me' : ''
          return `<div class="tlog-entry ${cls}${i === items.length - 1 ? ' latest' : ''}">${prefix}${SEAT_NAMES[e.seat]} ${e.text}</div>`
        })
        .join('')
      logInner.scrollTop = logInner.scrollHeight
    },
    onPlay: (cb) => btnPlay.addEventListener('click', cb),
    onPass: (cb) => btnPass.addEventListener('click', cb),
    onHint: (cb) => btnHint.addEventListener('click', cb),
    onDifficulty: (cb) => diffBtns.forEach((b) => b.addEventListener('click', () => cb(b.dataset.d as Difficulty))),
    onQuality: (cb) => qualBtns.forEach((b) => b.addEventListener('click', () => cb(b.dataset.q as Quality))),
    onSort: (cb) => btnSort.addEventListener('click', cb),
    onClear: (cb) => btnClear.addEventListener('click', cb),
    onMute: (cb) => btnMute.addEventListener('click', () => {
      muted = !muted
      applyMuteIcon()
      cb(muted)
    }),
    onVolume: (cb) => volSlider.addEventListener('input', () => cb(Number(volSlider.value) / 100)),
    onSpeed: (cb) => speedBtns.forEach((b) => b.addEventListener('click', () => cb(Number(b.dataset.s)))),
  }
}
