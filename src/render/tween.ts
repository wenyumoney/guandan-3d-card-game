import type * as THREE from 'three'

// ── 自研可控 tween（不在渲染循环里写死插值；可 seek/暂停/取消）────────────
// 用法：const tw = new Tweens(); render.onFrame((dt)=>tw.update(dt))
//   tw.add(0.4, (t)=>{...}, { ease: easeOutBack })
//   tw.to(mesh, { y: 1.2, rx: 0 }, 0.35, { ease: easeOutCubic, delay: 0.1 })

export type Ease = (t: number) => number

export const linear: Ease = (t) => t
export const easeOutCubic: Ease = (t) => 1 - Math.pow(1 - t, 3)
export const easeInCubic: Ease = (t) => t * t * t
export const easeInOutCubic: Ease = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
export const easeOutBack: Ease = (t) => {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
}
export const easeOutElastic: Ease = (t) => {
  if (t === 0 || t === 1) return t
  const c4 = (2 * Math.PI) / 3
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1
}
export const easeOutQuart: Ease = (t) => 1 - Math.pow(1 - t, 4)

interface Tween {
  dur: number
  elapsed: number
  delay: number
  ease: Ease
  onUpdate: (t: number) => void
  onComplete?: () => void
  done: boolean
}

/** 目标属性（位置/欧拉角），缺省项不动。 */
export interface TransformTarget {
  x?: number
  y?: number
  z?: number
  rx?: number
  ry?: number
  rz?: number
  sx?: number
  sy?: number
  sz?: number
}

export interface TweenOpts {
  ease?: Ease
  delay?: number
  onComplete?: () => void
}

export class Tweens {
  private items: Tween[] = []
  private paused = false
  /** 全局速度倍率（>1 加快，<1 放慢）。 */
  timeScale = 1

  /** 通用：t∈[0,1] 回调，返回可取消句柄。dur 单位秒。 */
  add(dur: number, onUpdate: (t: number) => void, opts: TweenOpts = {}): () => void {
    const tw: Tween = {
      dur: Math.max(dur, 1e-4),
      elapsed: 0,
      delay: opts.delay ?? 0,
      ease: opts.ease ?? easeOutCubic,
      onUpdate,
      onComplete: opts.onComplete,
      done: false,
    }
    this.items.push(tw)
    return () => {
      tw.done = true
    }
  }

  /** 便捷：把 Object3D 的 position/rotation/scale 补间到目标。 */
  to(obj: THREE.Object3D, target: TransformTarget, dur: number, opts: TweenOpts = {}): () => void {
    const p0 = obj.position.clone()
    const r0 = obj.rotation.clone()
    const s0 = obj.scale.clone()
    return this.add(
      dur,
      (t) => {
        if (target.x !== undefined) obj.position.x = p0.x + (target.x - p0.x) * t
        if (target.y !== undefined) obj.position.y = p0.y + (target.y - p0.y) * t
        if (target.z !== undefined) obj.position.z = p0.z + (target.z - p0.z) * t
        if (target.rx !== undefined) obj.rotation.x = r0.x + (target.rx - r0.x) * t
        if (target.ry !== undefined) obj.rotation.y = r0.y + (target.ry - r0.y) * t
        if (target.rz !== undefined) obj.rotation.z = r0.z + (target.rz - r0.z) * t
        if (target.sx !== undefined) obj.scale.x = s0.x + (target.sx - s0.x) * t
        if (target.sy !== undefined) obj.scale.y = s0.y + (target.sy - s0.y) * t
        if (target.sz !== undefined) obj.scale.z = s0.z + (target.sz - s0.z) * t
      },
      opts,
    )
  }

  /** 延时回调（dur 秒后触发一次）。 */
  delay(seconds: number, cb: () => void): () => void {
    return this.add(Math.max(seconds, 1e-4), () => {}, { ease: linear, onComplete: cb })
  }

  update(dt: number): void {
    if (this.paused || this.items.length === 0) return
    const d = dt * this.timeScale
    for (const tw of this.items) {
      if (tw.done) continue
      if (tw.delay > 0) {
        tw.delay -= d
        continue
      }
      tw.elapsed += d
      const raw = Math.min(tw.elapsed / tw.dur, 1)
      tw.onUpdate(tw.ease(raw))
      if (raw >= 1) {
        tw.done = true
        tw.onComplete?.()
      }
    }
    if (this.items.some((t) => t.done)) this.items = this.items.filter((t) => !t.done)
  }

  setPaused(p: boolean): void {
    this.paused = p
  }

  clear(): void {
    this.items = []
  }

  get active(): number {
    return this.items.length
  }
}
