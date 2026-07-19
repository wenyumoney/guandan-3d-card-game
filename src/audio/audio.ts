// ── 离线 WebAudio 音效（无外部依赖 / 无网络；ELEVENLABS_API_KEY=MISSING）──
// 全部程序化合成：古筝感 BGM 循环 + 发/出/过/炸弹分级/胜负。
// 浏览器自动播放策略：首个用户手势后调用 unlock() 才出声。

export interface AudioApi {
  unlock(): void
  setMuted(m: boolean): void
  isMuted(): boolean
  /** 主音量 0~1（与静音相互独立）。 */
  setVolume(v: number): void
  startBgm(): void
  stopBgm(): void
  deal(): void
  select(): void
  play(): void
  pass(): void
  /** 炸弹分级：tier 越大越炸裂（4炸=4 … 天王炸=1000）。 */
  bomb(tier: number): void
  wild(): void
  win(): void
  lose(): void
}

const midi = (n: number): number => 440 * Math.pow(2, (n - 69) / 12)
// 五声音阶（D 宫：D E F# A B），古筝雅致
const PENTA = [62, 64, 66, 69, 71, 74, 76, 78, 81]
const MELODY = [0, 2, 4, 3, 2, 0, 1, 3, 4, 6, 4, 3, 2, 1, 0, 2]

export function createAudio(): AudioApi {
  let ctx: AudioContext | null = null
  let master: GainNode | null = null
  let noiseBuf: AudioBuffer | null = null
  let muted = false
  let volume = 1
  let bgmOn = false
  let bgmTimer: number | null = null
  let nextNote = 0
  let step = 0

  const masterGain = (): number => (muted ? 0 : 0.9 * volume)

  function ensure(): boolean {
    if (ctx) return true
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return false
    ctx = new AC()
    master = ctx.createGain()
    master.gain.value = masterGain()
    master.connect(ctx.destination)
    // 一次性白噪声缓冲
    const len = Math.floor(ctx.sampleRate * 1.2)
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate)
    const ch = noiseBuf.getChannelData(0)
    for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1
    return true
  }

  /** 拨弦音（三角波 + 快速指数衰减 + 一点二次谐波），gain 0~1。 */
  function pluck(freq: number, when: number, dur: number, gain: number, type: OscillatorType = 'triangle'): void {
    if (!ctx || !master) return
    const g = ctx.createGain()
    g.connect(master)
    g.gain.setValueAtTime(0.0001, when)
    g.gain.exponentialRampToValueAtTime(gain, when + 0.008)
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur)
    const o = ctx.createOscillator()
    o.type = type
    o.frequency.value = freq
    o.connect(g)
    o.start(when)
    o.stop(when + dur + 0.02)
    // 二次谐波添亮色
    const o2 = ctx.createOscillator()
    const g2 = ctx.createGain()
    g2.gain.setValueAtTime(0.0001, when)
    g2.gain.exponentialRampToValueAtTime(gain * 0.28, when + 0.01)
    g2.gain.exponentialRampToValueAtTime(0.0001, when + dur * 0.6)
    o2.type = 'sine'
    o2.frequency.value = freq * 2
    o2.connect(g2)
    g2.connect(master)
    o2.start(when)
    o2.stop(when + dur)
  }

  /** 滤波噪声（whoosh / boom）。 */
  function noise(when: number, dur: number, gain: number, type: BiquadFilterType, freq: number, q = 1): void {
    if (!ctx || !master || !noiseBuf) return
    const src = ctx.createBufferSource()
    src.buffer = noiseBuf
    const flt = ctx.createBiquadFilter()
    flt.type = type
    flt.frequency.value = freq
    flt.Q.value = q
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, when)
    g.gain.exponentialRampToValueAtTime(gain, when + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur)
    src.connect(flt)
    flt.connect(g)
    g.connect(master)
    src.start(when)
    src.stop(when + dur)
  }

  function now(): number {
    return ctx ? ctx.currentTime : 0
  }

  function scheduleBgm(): void {
    if (!ctx) return
    const ahead = ctx.currentTime + 0.4
    const beat = 0.62
    while (nextNote < ahead) {
      const idx = MELODY[step % MELODY.length]
      // 偶尔留白，避免吵
      if (step % 8 !== 7) pluck(midi(PENTA[idx]), nextNote, 1.4, 0.12)
      // 低音伴底每两拍
      if (step % 4 === 0) pluck(midi(PENTA[0] - 12), nextNote, 1.8, 0.08, 'sine')
      nextNote += beat
      step++
    }
  }

  return {
    unlock() {
      if (!ensure() || !ctx) return
      if (ctx.state === 'suspended') void ctx.resume()
    },
    setMuted(m) {
      muted = m
      if (master && ctx) master.gain.setTargetAtTime(masterGain(), ctx.currentTime, 0.05)
    },
    isMuted: () => muted,
    setVolume(v) {
      volume = Math.min(Math.max(v, 0), 1)
      if (master && ctx) master.gain.setTargetAtTime(masterGain(), ctx.currentTime, 0.05)
    },
    startBgm() {
      if (bgmOn || !ensure() || !ctx) return
      bgmOn = true
      nextNote = ctx.currentTime + 0.2
      step = 0
      scheduleBgm()
      bgmTimer = window.setInterval(scheduleBgm, 200)
    },
    stopBgm() {
      bgmOn = false
      if (bgmTimer !== null) {
        clearInterval(bgmTimer)
        bgmTimer = null
      }
    },
    deal() {
      if (!ctx) return
      pluck(midi(PENTA[4] + 12), now(), 0.18, 0.22)
      noise(now(), 0.09, 0.05, 'highpass', 2600)
    },
    select() {
      if (!ctx) return
      // 极短高频 click — 模拟棋子落盘
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'sine'
      o.frequency.setValueAtTime(2400, ctx.currentTime)
      o.frequency.exponentialRampToValueAtTime(1600, ctx.currentTime + 0.04)
      g.gain.setValueAtTime(0.06, ctx.currentTime)
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.05)
      o.connect(g)
      if (master) g.connect(master)
      o.start(ctx.currentTime)
      o.stop(ctx.currentTime + 0.06)
    },
    play() {
      if (!ctx) return
      noise(now(), 0.16, 0.09, 'bandpass', 1400, 0.7)
      pluck(midi(PENTA[3]), now() + 0.02, 0.25, 0.16)
    },
    pass() {
      if (!ctx) return
      pluck(midi(PENTA[0] - 12), now(), 0.2, 0.12, 'sine')
    },
    bomb(tier) {
      if (!ctx) return
      const t = now()
      const s = tier >= 1000 ? 1 : Math.min((tier - 3) / 6, 1) // 强度 0~1
      const g = 0.4 + 0.5 * s
      // 低频下潜
      const o = ctx.createOscillator()
      const og = ctx.createGain()
      o.type = 'sawtooth'
      o.frequency.setValueAtTime(160 + 60 * s, t)
      o.frequency.exponentialRampToValueAtTime(38, t + 0.5 + 0.4 * s)
      og.gain.setValueAtTime(g, t)
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.7 + 0.6 * s)
      o.connect(og)
      if (master) og.connect(master)
      o.start(t)
      o.stop(t + 1.4)
      // 爆裂噪声
      noise(t, 0.35 + 0.3 * s, 0.22 + 0.2 * s, 'lowpass', 900 + 600 * s, 0.6)
      // 天王炸额外金属亮击
      if (tier >= 1000) {
        pluck(midi(93), t + 0.04, 0.5, 0.3, 'square')
        noise(t + 0.05, 0.5, 0.14, 'highpass', 5000)
      }
    },
    wild() {
      if (!ctx) return
      const t = now()
      pluck(midi(PENTA[2]), t, 0.4, 0.14)
      pluck(midi(PENTA[4]), t + 0.06, 0.4, 0.14)
      pluck(midi(PENTA[6]), t + 0.12, 0.5, 0.16)
    },
    win() {
      if (!ctx) return
      const t = now()
      ;[0, 2, 4, 7].forEach((k, i) => pluck(midi(PENTA[k]), t + i * 0.11, 0.6, 0.2))
    },
    lose() {
      if (!ctx) return
      const t = now()
      ;[4, 2, 1, 0].forEach((k, i) => pluck(midi(PENTA[k] - 12), t + i * 0.13, 0.5, 0.16, 'sine'))
    },
  }
}
