import * as THREE from 'three'
import { type Card } from '../core/cards'
import { type Seat } from '../core/deal'
import { createCardMesh, createBackMesh, CARD_W } from './CardMesh'
import { labelTexture, feltTexture, paperTexture, woodTexture } from './textures'
import { Tweens, easeOutBack, easeOutCubic, easeInOutCubic } from './tween'

/** 座位平面坐标 (x,z)：0=你(南) 1=下家(东) 2=队友(北) 3=上家(西)。 */
export const SEAT_POS: readonly [number, number][] = [
  [0, 3.4], [3.4, 0], [0, -3.4], [-3.4, 0],
]
const SEAT_NAME = ['你', '下家', '队友', '上家']

export interface TableView {
  group: THREE.Group
  /** 出牌落在该家座位前，保留至新一墩；onDone 落定回调（供音效/特效定时）。 */
  showPlay(cards: Card[], seat: Seat, onDone?: () => void): void
  /** 清掉全部四家出牌（新一墩领牌时调用）。 */
  clearAllPlays(): void
  /** 当前桌面（四家出牌槽）总牌数——供 QA 验证「出牌留桌」。 */
  shownCards(): number
  /** 进贡/还贡飞牌：一张牌从 from 家飞向 to 家（抛物）。 */
  tributeFly(from: Seat, to: Seat, card: Card, onDone?: () => void): void
  /** 发牌飞散点缀（面朝下飞向四家再消失）。 */
  dealFlourish(): void
}

/** 国风 3D 牌桌：宣纸远景 + 红木圆桌 + 云锦绒面 + 宫灯 + 中央出牌区。 */
export function createTable(scene: THREE.Scene, tweens: Tweens): TableView {
  const group = new THREE.Group()
  scene.add(group)

  // 宣纸远景背板
  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(46, 22),
    new THREE.MeshBasicMaterial({ map: paperTexture(), fog: true }),
  )
  backdrop.position.set(0, 4.5, -13)
  group.add(backdrop)

  // 红木圆桌框（倒角）
  const woodMat = new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.62, metalness: 0.12, color: 0x8a5a38 })
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(4.95, 5.15, 0.55, 64), woodMat)
  rim.position.y = -0.28
  group.add(rim)
  const bevel = new THREE.Mesh(new THREE.TorusGeometry(4.9, 0.16, 16, 72), woodMat)
  bevel.rotation.x = Math.PI / 2
  bevel.position.y = 0.0
  group.add(bevel)

  // 云锦绒面
  const felt = feltTexture()
  felt.repeat.set(2, 2)
  const feltMesh = new THREE.Mesh(
    new THREE.CircleGeometry(4.7, 64),
    new THREE.MeshStandardMaterial({ map: felt, roughness: 0.95, metalness: 0.02 }),
  )
  feltMesh.rotation.x = -Math.PI / 2
  feltMesh.position.y = 0.02
  group.add(feltMesh)

  // 中央出牌区金环
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.85, 0.045, 12, 80),
    new THREE.MeshStandardMaterial({ color: 0xc9a55c, emissive: 0x6b4e1e, roughness: 0.35, metalness: 0.8 }),
  )
  ring.rotation.x = -Math.PI / 2
  ring.position.y = 0.04
  group.add(ring)

  // 宫灯（发光，供 bloom 拾取）
  const lanternMat = new THREE.MeshStandardMaterial({ color: 0x8a1f22, emissive: 0xff7a2c, emissiveIntensity: 1.5, roughness: 0.4 })
  const capMat = new THREE.MeshStandardMaterial({ color: 0xc9a55c, metalness: 0.7, roughness: 0.35 })
  for (const sx of [-1, 1]) {
    const lantern = new THREE.Group()
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.42, 24, 16), lanternMat)
    body.scale.set(1, 1.18, 1)
    lantern.add(body)
    for (const cy of [0.5, -0.5]) {
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.12, 12), capMat)
      cap.position.y = cy
      lantern.add(cap)
    }
    lantern.position.set(sx * 3.4, 4.2, -3.4)
    group.add(lantern)
    // 轻微上下浮动
    const y0 = lantern.position.y
    const bob = (): void => {
      tweens.add(2.4, (t) => { lantern.position.y = y0 + Math.sin(t * Math.PI * 2) * 0.12 }, { ease: (x) => x, onComplete: bob })
    }
    bob()
  }

  // 座位铭牌
  for (let s = 0; s < 4; s++) {
    const [x, z] = SEAT_POS[s]
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(SEAT_NAME[s]), depthTest: false }))
    spr.position.set(x * 0.9, 0.12, z * 0.9)
    spr.scale.set(1.5, 0.42, 1)
    spr.renderOrder = 5
    group.add(spr)
  }

  const playGroup = new THREE.Group()
  group.add(playGroup)

  // 每家一个出牌槽，落在各自座位前；一整墩内四家的牌都留着，新一墩领牌时才清空
  const slots: THREE.Group[] = []
  for (let s = 0; s < 4; s++) {
    const g = new THREE.Group()
    playGroup.add(g)
    slots.push(g)
  }

  const clearSlot = (s: number): void => {
    for (const c of [...slots[s].children]) {
      slots[s].remove(c)
      ;((c as THREE.Mesh).material as THREE.Material | undefined)?.dispose()
    }
  }
  const clearAllPlays = (): void => {
    for (let s = 0; s < 4; s++) clearSlot(s)
  }

  const showPlay = (cards: Card[], seat: Seat, onDone?: () => void): void => {
    clearSlot(seat) // 只替换该家自己的上一手，别家保留
    const [seatX, seatZ] = SEAT_POS[seat]
    const px = seatX * 0.58 // 落点：座位与桌心之间
    const pz = seatZ * 0.58
    const spread = CARD_W * 0.72
    const startX = (-(cards.length - 1) / 2) * spread
    cards.forEach((card, i) => {
      const m = createCardMesh(card)
      const fx = px + startX + i * spread
      const fz = pz
      // 起点：从该家座位方向飞入（闭包捕获，避免读写同变量）
      const sx = seatX * 0.9
      const sy = 1.3
      const sz = seatZ * 0.9
      const srz = (Math.random() - 0.5) * 0.7
      m.position.set(sx, sy, sz)
      m.rotation.set(-Math.PI / 2, 0, srz)
      slots[seat].add(m)
      const last = i === cards.length - 1
      tweens.add(
        0.32,
        (t) => {
          m.position.x = sx + (fx - sx) * t
          m.position.z = sz + (fz - sz) * t
          m.position.y = sy + (0.05 - sy) * t + Math.sin(Math.min(t, 1) * Math.PI) * 0.16 // 抛物落桌
          m.rotation.z = srz * (1 - t)
        },
        { ease: easeOutBack, delay: i * 0.05, onComplete: last ? onDone : undefined },
      )
    })
    if (cards.length === 0) onDone?.()
  }

  const tributeFly = (from: Seat, to: Seat, card: Card, onDone?: () => void): void => {
    const [fx, fz] = SEAT_POS[from]
    const [tx, tz] = SEAT_POS[to]
    const m = createCardMesh(card)
    m.rotation.x = -Math.PI / 2
    const sx = fx * 0.72
    const sz = fz * 0.72
    const ex = tx * 0.72
    const ez = tz * 0.72
    m.position.set(sx, 0.4, sz)
    group.add(m)
    tweens.add(
      0.6,
      (t) => {
        m.position.x = sx + (ex - sx) * t
        m.position.z = sz + (ez - sz) * t
        m.position.y = 0.4 + Math.sin(Math.min(t, 1) * Math.PI) * 1.4 // 抛物弧
      },
      {
        ease: easeInOutCubic,
        onComplete: () => {
          group.remove(m)
          ;(m.material as THREE.Material).dispose()
          onDone?.()
        },
      },
    )
  }

  const dealFlourish = (): void => {
    const backs: THREE.Mesh[] = []
    for (let s = 0; s < 4; s++) {
      const [x, z] = SEAT_POS[s]
      for (let k = 0; k < 4; k++) {
        const b = createBackMesh()
        b.position.set(0, 1.6, 0)
        b.rotation.x = -Math.PI / 2
        b.scale.setScalar(0.7)
        group.add(b)
        backs.push(b)
        const tx = x * 0.72 + (Math.random() - 0.5) * 0.5
        const tz = z * 0.72 + (Math.random() - 0.5) * 0.5
        tweens.to(
          b,
          { x: tx, y: 0.08, z: tz },
          0.5,
          { ease: easeOutCubic, delay: (s * 4 + k) * 0.03 },
        )
      }
    }
    // 收尾清除
    tweens.delay(1.1, () => {
      for (const b of backs) {
        group.remove(b)
        ;(b.material as THREE.Material).dispose()
      }
    })
  }

  return { group, showPlay, clearAllPlays, dealFlourish, shownCards: () => slots.reduce((n, g) => n + g.children.length, 0), tributeFly }
}
