import * as THREE from 'three'
import { Tweens, easeOutCubic, easeOutQuart } from './tween'

// 炸弹分级特效（粒子爆发 + 光闪）与逢人配金色流光。屏震由 Renderer.shake 负责。

const CENTER = new THREE.Vector3(0, 0.2, 0.3)

export interface Effects {
  /** 炸弹分级特效：tier 4炸=4 … 天王炸=1000，越大越炸裂。 */
  bomb(tier: number): void
  /** 逢人配：红桃级牌打出的金色流光。 */
  wild(): void
}

/** tier → 强度 0~1。 */
function intensity(tier: number): number {
  if (tier >= 1000) return 1
  return Math.min(Math.max((tier - 3) / 6, 0.1), 0.95)
}

export function createEffects(scene: THREE.Scene, tweens: Tweens): Effects {
  function burst(count: number, reach: number, size: number, color: number, life: number, up: number): void {
    const geo = new THREE.BufferGeometry()
    const pos = new Float32Array(count * 3)
    const dir: THREE.Vector3[] = []
    for (let i = 0; i < count; i++) {
      pos[i * 3] = CENTER.x
      pos[i * 3 + 1] = CENTER.y
      pos[i * 3 + 2] = CENTER.z
      const a = Math.random() * Math.PI * 2
      const el = (Math.random() * 0.6 + 0.15) * (Math.random() < 0.5 ? 1 : 0.5)
      dir.push(new THREE.Vector3(Math.cos(a) * (1 - el), el * up, Math.sin(a) * (1 - el)).multiplyScalar(0.7 + Math.random() * 0.6))
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    const mat = new THREE.PointsMaterial({
      color,
      size,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    })
    const points = new THREE.Points(geo, mat)
    scene.add(points)
    const attr = geo.getAttribute('position') as THREE.BufferAttribute
    tweens.add(
      life,
      (t) => {
        for (let i = 0; i < count; i++) {
          const d = dir[i]
          attr.setXYZ(
            i,
            CENTER.x + d.x * reach * t,
            CENTER.y + d.y * reach * t - t * t * reach * 0.5, // 重力下坠
            CENTER.z + d.z * reach * t,
          )
        }
        attr.needsUpdate = true
        mat.opacity = 1 - easeOutQuart(t)
      },
      {
        ease: easeOutCubic,
        onComplete: () => {
          scene.remove(points)
          geo.dispose()
          mat.dispose()
        },
      },
    )
  }

  function flash(color: number, power: number, life: number): void {
    const light = new THREE.PointLight(color, power, 20, 2)
    light.position.set(CENTER.x, 1.2, CENTER.z)
    scene.add(light)
    tweens.add(life, (t) => { light.intensity = power * (1 - t) }, {
      ease: easeOutQuart,
      onComplete: () => scene.remove(light),
    })
  }

  return {
    bomb(tier) {
      const s = intensity(tier)
      const count = Math.floor(60 + 260 * s)
      const reach = 2 + 4.2 * s
      const size = 0.09 + 0.11 * s
      flash(0xffb060, 30 + 80 * s, 0.45 + 0.3 * s)
      if (tier >= 1000) {
        // 天王炸：多色叠加最炸裂
        burst(count, reach, size * 1.2, 0xfff0c0, 1.1, 1.2)
        burst(Math.floor(count * 0.8), reach * 1.15, size, 0xd94f4f, 1.2, 1.0)
        burst(Math.floor(count * 0.7), reach * 0.9, size * 0.9, 0xc9a55c, 1.0, 1.5)
        flash(0xff5030, 120, 0.7)
      } else {
        const color = s > 0.5 ? 0xff7a3a : 0xc9a55c
        burst(count, reach, size, color, 0.9 + 0.4 * s, 1.0)
        if (s > 0.4) burst(Math.floor(count * 0.5), reach * 0.8, size * 0.8, 0xfff0c0, 0.9, 1.3)
      }
    },
    wild() {
      // 金色上升流光 + 扩散环
      burst(90, 2.2, 0.1, 0xe6cf95, 1.0, 2.4)
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.5, 0.03, 10, 60),
        new THREE.MeshBasicMaterial({ color: 0xe6cf95, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
      )
      ring.rotation.x = -Math.PI / 2
      ring.position.set(CENTER.x, 0.1, CENTER.z)
      scene.add(ring)
      tweens.add(0.8, (t) => {
        const sc = 0.5 + t * 3
        ring.scale.set(sc, sc, sc)
        ;(ring.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - t)
      }, {
        ease: easeOutCubic,
        onComplete: () => { scene.remove(ring); ring.geometry.dispose(); (ring.material as THREE.Material).dispose() },
      })
      flash(0xe6cf95, 18, 0.5)
    },
  }
}
