import * as THREE from 'three'
import { type Card } from '../core/cards'

// 国风程序化 canvas 贴图（无外部图像；GEMINI_API_KEY=MISSING）：
// 牌面清晰易读 + 描金回纹牌背/云纹 + 云锦桌布 + 宣纸背景。带缓存。
// 配色：朱红 #7a2230 · 黛青 #21384a · 描金 #c9a55c · 宣纸米白 #f4ecd8

const GOLD = '#c9a55c'
const GOLD_HI = '#e6cf95'
const RED = '#7a2230'
const INK = '#20242a'

const SUIT_SYM: Record<string, string> = { S: '♠', H: '♥', C: '♣', D: '♦' }
const faceCache = new Map<string, THREE.CanvasTexture>()
let backTex: THREE.CanvasTexture | null = null
let feltTex: THREE.CanvasTexture | null = null
let paperTex: THREE.CanvasTexture | null = null
let woodTex: THREE.CanvasTexture | null = null
const labelCache = new Map<string, THREE.CanvasTexture>()

function ctx(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  return [cv, cv.getContext('2d') as CanvasRenderingContext2D]
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath()
  g.moveTo(x + r, y)
  g.arcTo(x + w, y, x + w, y + h, r)
  g.arcTo(x + w, y + h, x, y + h, r)
  g.arcTo(x, y + h, x, y, r)
  g.arcTo(x, y, x + w, y, r)
  g.closePath()
}

/** 宣纸纤维底噪（叠在给定色上，营造纸质）。 */
function paperGrain(g: CanvasRenderingContext2D, w: number, h: number, alpha: number): void {
  for (let i = 0; i < w * h * 0.03; i++) {
    const x = Math.random() * w
    const y = Math.random() * h
    g.fillStyle = `rgba(${Math.random() > 0.5 ? '120,95,60' : '255,250,235'},${(Math.random() * alpha).toFixed(3)})`
    g.fillRect(x, y, 1, 1)
  }
}

/** 回纹（Greek-key / 万字纹）描边边框。 */
function meanderBorder(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, unit: number, color: string): void {
  g.save()
  g.strokeStyle = color
  g.lineWidth = Math.max(1.5, unit * 0.16)
  g.lineJoin = 'miter'
  const key = (cx: number, cy: number, dir: number): void => {
    // 单个回纹钩，dir: 1 顶边朝内向下 / -1 底边朝内向上
    const u = unit
    g.beginPath()
    g.moveTo(cx, cy)
    g.lineTo(cx, cy + dir * u * 0.66)
    g.lineTo(cx + u * 0.66, cy + dir * u * 0.66)
    g.lineTo(cx + u * 0.66, cy + dir * u * 0.2)
    g.lineTo(cx + u * 0.28, cy + dir * u * 0.2)
    g.stroke()
  }
  for (let cx = x; cx < x + w - unit; cx += unit) {
    key(cx, y, 1)
    key(cx, y + h, -1)
  }
  for (let cy = y + unit; cy < y + h - unit; cy += unit) {
    key(x, cy, 0.0001) // 左边竖排简化为竖线段
    g.beginPath()
    g.moveTo(x, cy)
    g.lineTo(x, cy + unit * 0.66)
    g.moveTo(x + w, cy)
    g.lineTo(x + w, cy + unit * 0.66)
    g.stroke()
  }
  g.restore()
}

/** 如意/祥云纹（描金），中心装饰。 */
function ruyiCloud(g: CanvasRenderingContext2D, cx: number, cy: number, s: number, color: string): void {
  g.save()
  g.strokeStyle = color
  g.lineWidth = s * 0.09
  g.lineCap = 'round'
  for (const dir of [-1, 1]) {
    g.beginPath()
    g.arc(cx + dir * s * 0.42, cy, s * 0.42, Math.PI * 0.1, Math.PI * 1.5, false)
    g.stroke()
    g.beginPath()
    g.arc(cx + dir * s * 0.42, cy, s * 0.18, 0, Math.PI * 2)
    g.stroke()
  }
  g.beginPath()
  g.moveTo(cx, cy + s * 0.1)
  g.lineTo(cx, cy + s * 0.72)
  g.stroke()
  g.restore()
}

function faceKey(card: Card): string {
  return card.suit === 'JOKER' ? `J-${card.rank}` : `${card.suit}-${card.rank}`
}

export function cardFaceTexture(card: Card): THREE.CanvasTexture {
  const key = faceKey(card)
  const cached = faceCache.get(key)
  if (cached) return cached

  const w = 300
  const h = 418
  const [cv, g] = ctx(w, h)
  // 宣纸底
  const grad = g.createLinearGradient(0, 0, 0, h)
  grad.addColorStop(0, '#f8f1e0')
  grad.addColorStop(1, '#efe4c9')
  roundRect(g, 6, 6, w - 12, h - 12, 22)
  g.fillStyle = grad
  g.fill()
  g.save()
  roundRect(g, 6, 6, w - 12, h - 12, 22)
  g.clip()
  paperGrain(g, w, h, 0.06)
  g.restore()
  // 描金双边框
  roundRect(g, 6, 6, w - 12, h - 12, 22)
  g.lineWidth = 5
  g.strokeStyle = GOLD
  g.stroke()
  roundRect(g, 14, 14, w - 28, h - 28, 16)
  g.lineWidth = 1.5
  g.strokeStyle = 'rgba(201,165,92,.55)'
  g.stroke()

  if (card.suit === 'JOKER') {
    const red = card.rank === 'bj'
    g.textAlign = 'center'
    g.fillStyle = red ? RED : INK
    g.font = 'bold 52px "KaiTi","STKaiti",serif'
    g.fillText('王', w / 2, 72)
    ruyiCloud(g, w / 2, h / 2 - 30, 90, red ? 'rgba(122,34,48,.35)' : 'rgba(32,36,42,.3)')
    g.fillStyle = red ? RED : INK
    g.font = 'bold 150px "KaiTi","STKaiti",serif'
    g.fillText(red ? '大' : '小', w / 2, h / 2 + 30)
    g.fillText('王', w / 2, h / 2 + 168)
    g.font = 'bold 28px serif'
    g.fillStyle = GOLD
    g.fillText('JOKER', w / 2, h - 40)
  } else {
    const red = card.suit === 'H' || card.suit === 'D'
    const col = red ? '#b02a37' : '#1c2026'
    const sym = SUIT_SYM[card.suit]
    // 角标
    g.fillStyle = col
    g.textAlign = 'center'
    g.font = 'bold 72px "Georgia",serif'
    g.fillText(card.rank, 46, 78)
    g.font = '52px serif'
    g.fillText(sym, 46, 130)
    g.save()
    g.translate(w - 46, h - 78)
    g.rotate(Math.PI)
    g.font = 'bold 72px "Georgia",serif'
    g.fillText(card.rank, 0, -0)
    g.font = '52px serif'
    g.fillText(sym, 0, 52)
    g.restore()
    // 中心大花色
    g.fillStyle = col
    g.font = 'bold 260px serif'
    g.fillText(sym, w / 2, h / 2 + 76)
    // 中心描金光晕
    g.save()
    g.globalAlpha = 0.14
    g.fillStyle = GOLD
    g.font = 'bold 260px serif'
    g.fillText(sym, w / 2 + 3, h / 2 + 78)
    g.restore()
  }

  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  faceCache.set(key, tex)
  return tex
}

export function cardBackTexture(): THREE.CanvasTexture {
  if (backTex) return backTex
  const w = 300
  const h = 418
  const [cv, g] = ctx(w, h)
  // 朱红底 + 暗角
  roundRect(g, 6, 6, w - 12, h - 12, 22)
  const rg = g.createRadialGradient(w / 2, h / 2, 30, w / 2, h / 2, h * 0.62)
  rg.addColorStop(0, '#8a2a37')
  rg.addColorStop(1, '#611a26')
  g.fillStyle = rg
  g.fill()
  g.save()
  roundRect(g, 6, 6, w - 12, h - 12, 22)
  g.clip()
  // 斜向暗纹
  g.strokeStyle = 'rgba(0,0,0,.14)'
  g.lineWidth = 8
  for (let i = -h; i < w; i += 26) {
    g.beginPath()
    g.moveTo(i, 0)
    g.lineTo(i + h, h)
    g.stroke()
  }
  g.restore()
  // 回纹金边
  meanderBorder(g, 26, 26, w - 52, h - 52, 18, GOLD)
  // 中央如意云 + 掼字印
  ruyiCloud(g, w / 2, h / 2 - 34, 96, GOLD)
  g.fillStyle = RED
  g.strokeStyle = GOLD
  g.lineWidth = 3
  roundRect(g, w / 2 - 44, h / 2 + 30, 88, 88, 12)
  g.fill()
  g.stroke()
  g.fillStyle = GOLD_HI
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.font = 'bold 60px "KaiTi","STKaiti",serif'
  g.fillText('掼', w / 2, h / 2 + 76)
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  backTex = tex
  return tex
}

/** 云锦桌布纹理（黛青底 + 描金缠枝/回纹，可平铺）。 */
export function feltTexture(): THREE.CanvasTexture {
  if (feltTex) return feltTex
  const n = 512
  const [cv, g] = ctx(n, n)
  const bg = g.createRadialGradient(n / 2, n / 2, 40, n / 2, n / 2, n * 0.7)
  bg.addColorStop(0, '#28455a')
  bg.addColorStop(1, '#1a2f3f')
  g.fillStyle = bg
  g.fillRect(0, 0, n, n)
  // 描金网格缠枝点阵
  g.strokeStyle = 'rgba(201,165,92,.18)'
  g.lineWidth = 2
  const cell = 64
  for (let y = cell / 2; y < n; y += cell) {
    for (let x = cell / 2; x < n; x += cell) {
      ruyiCloud(g, x, y, 26, 'rgba(201,165,92,.16)')
    }
  }
  // 细回纹分隔线
  g.strokeStyle = 'rgba(201,165,92,.1)'
  for (let x = 0; x <= n; x += cell) {
    g.beginPath()
    g.moveTo(x, 0)
    g.lineTo(x, n)
    g.stroke()
  }
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.anisotropy = 8
  feltTex = tex
  return feltTex
}

/** 宣纸远景背板纹理（米白水墨渐隐）。 */
export function paperTexture(): THREE.CanvasTexture {
  if (paperTex) return paperTex
  const w = 1024
  const h = 512
  const [cv, g] = ctx(w, h)
  const grad = g.createLinearGradient(0, 0, 0, h)
  grad.addColorStop(0, '#efe6cf')
  grad.addColorStop(0.6, '#e4d7ba')
  grad.addColorStop(1, '#cdbb95')
  g.fillStyle = grad
  g.fillRect(0, 0, w, h)
  // 淡水墨远山
  g.fillStyle = 'rgba(60,72,80,.10)'
  for (const [base, amp, y0] of [[0.72, 60, 0.7], [0.5, 90, 0.82]] as const) {
    g.beginPath()
    g.moveTo(0, h)
    for (let x = 0; x <= w; x += 8) {
      const y = h * y0 - Math.sin(x * 0.008 + base * 10) * amp * base - Math.sin(x * 0.021) * 14
      g.lineTo(x, y)
    }
    g.lineTo(w, h)
    g.closePath()
    g.fill()
  }
  paperGrain(g, w, h, 0.05)
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  paperTex = tex
  return paperTex
}

/** 红木纹理（桌框）。 */
export function woodTexture(): THREE.CanvasTexture {
  if (woodTex) return woodTex
  const n = 512
  const [cv, g] = ctx(n, n)
  g.fillStyle = '#4a2b1a'
  g.fillRect(0, 0, n, n)
  for (let i = 0; i < 90; i++) {
    g.strokeStyle = `rgba(${30 + Math.random() * 40},${18 + Math.random() * 20},8,${0.15 + Math.random() * 0.2})`
    g.lineWidth = 1 + Math.random() * 2
    g.beginPath()
    const y = Math.random() * n
    g.moveTo(0, y)
    for (let x = 0; x <= n; x += 16) g.lineTo(x, y + Math.sin(x * 0.03 + i) * 4)
    g.stroke()
  }
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  woodTex = tex
  return woodTex
}

/** 文字标签贴图（座位名等）。 */
export function labelTexture(text: string, color = '#f4ecd8'): THREE.CanvasTexture {
  const key = `${text}|${color}`
  const cached = labelCache.get(key)
  if (cached) return cached
  const [cv, g] = ctx(256, 72)
  g.fillStyle = color
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.shadowColor = 'rgba(0,0,0,.6)'
  g.shadowBlur = 6
  g.font = 'bold 42px "KaiTi","STKaiti","Microsoft YaHei",serif'
  g.fillText(text, 128, 38)
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  labelCache.set(key, tex)
  return tex
}
