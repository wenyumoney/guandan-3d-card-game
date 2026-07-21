import * as THREE from 'three'
import { type Card, type NormalRank, singlePower, suitIndex } from '../core/cards'
import { findStraightFlushGroups } from '../core/combos'
import { createCardMesh, tintCard, CARD_W, CARD_H } from './CardMesh'
import { Tweens, easeOutBack } from './tween'

/**
 * 玩家（座位0）列式手牌视图：同点数竖叠成列、列间由小到大，hover 抬起、
 * 点选/拖选/双击同点数、双击已选牌锁定、理牌排序、非法置灰，raycast 拾取。
 * 只负责展示与选择；权威手牌与合法性由 GameSession 提供。
 */
export interface HandView {
  setHand(cards: Card[], level: NormalRank, animate?: boolean): void
  /** 可选牌 id 集合；null = 全部可选。非集合内的牌置灰且不可选。 */
  setPlayable(ids: Set<string> | null): void
  getSelected(): Card[]
  /** 程序化选中一组牌（用于「提示」），仅选可选的。 */
  select(ids: string[]): void
  clearSelection(): void
  /** 是否已锁定选中（锁定后拖选不改变选中）。 */
  isLocked(): boolean
  /** 切换排序模式（点数→同花顺 循环）。 */
  cycleSortMode(): string
  onSelectionChange(cb: (sel: Card[]) => void): void
  dispose(): void
}

const BASE_Y = 0.98
const BASE_Z = 4.7
const TILT_X = -0.52
// 列式布局：列内沿牌面向上叠（角标可见），上牌更远离相机
const COL_STEP = 0.3 // 列内间距（≈33% CARD_H）
const COL_SPAN_MAX = 0.85 // 列内总展开上限：压缩高列，避免挡住相机→出牌位的视线
const UP_Y = Math.cos(TILT_X) // ≈ 0.868：牌面局部“上”的世界 y 分量
const UP_Z = Math.sin(TILT_X) // ≈ -0.497：越往上越远离相机
const COL_EPS = 0.006 // 每行额外 -z，防同列共面闪烁
const COL_Z = 0.01 // 每列 +z，右列在前

type SortMode = 'rank' | 'sflush'
const SORT_MODES: SortMode[] = ['rank', 'sflush']
const SORT_LABEL: Record<SortMode, string> = { rank: '点数', sflush: '同花顺' }

export function createHandView(scene: THREE.Scene, camera: THREE.Camera, dom: HTMLElement, tweens: Tweens): HandView {
  const group = new THREE.Group()
  scene.add(group)

  let meshes: THREE.Mesh[] = []
  // 选中卡牌金色边框：略大于牌面的平面放牌后，形成描边效果
  const borderGeo = new THREE.PlaneGeometry(CARD_W * 1.07, CARD_H * 1.07)
  const borderMat = new THREE.MeshBasicMaterial({ color: 0xd4a017, transparent: true, opacity: 0.72, depthTest: false })
  const borders: THREE.Mesh[] = []
  let level: NormalRank = '2'
  const selected = new Set<string>()
  let locked = false
  let playable: Set<string> | null = null
  let hovered: THREE.Mesh | null = null
  let selCb: (sel: Card[]) => void = () => {}
  let dealing = false
  let pendingPlayable: Set<string> | null = null  // 发牌动画期间缓存的 playable，动画完再应用
  const dealCancels: (() => void)[] = [] // 发牌动画的取消句柄
  let sortMode: SortMode = 'rank'
  let nCols = 1
  // 拖动连选（paint）
  let dragging = false
  let paintMode: 'add' | 'remove' = 'add'
  let lastPainted: string | null = null
  // 移动端触屏：双指Tap + 长按检测
  let lastTapId: string | null = null
  let lastTapTime = 0
  let longPressTimer: ReturnType<typeof setTimeout> | null = null
  let longPressFired = false

  const raycaster = new THREE.Raycaster()
  const ndc = new THREE.Vector2()

  const cardOf = (m: THREE.Mesh): Card => m.userData.card as Card
  const isUsable = (m: THREE.Mesh): boolean => playable === null || playable.has(cardOf(m).id)

  function clearMeshes(): void {
    // 取消未完成的发牌 tween，避免孤儿 tween 驱动已移除的 mesh / dealing 卡死
    for (const c of dealCancels) c()
    dealCancels.length = 0
    dealing = false
    for (const m of meshes) {
      group.remove(m)
      ;(m.material as THREE.Material).dispose()
    }
    for (const b of borders) { group.remove(b) }
    borders.length = 0
    meshes = []
    hovered = null
  }

  function layout(): void {
    const colPitch = Math.min(CARD_W * 0.72, 7.6 / Math.max(nCols, 1))
    // 清除旧边框，重新分配
    for (const b of borders) group.remove(b)
    borders.length = 0
    for (const m of meshes) {
      const { col, row, len } = m.userData.slot as { col: number; row: number; len: number }
      const id = cardOf(m).id
      const sel = selected.has(id)
      const hov = m === hovered
      const dim = playable !== null && !playable.has(id)
      // 高列压缩：列内总展开不超过 COL_SPAN_MAX（防止高列挡住自己出的牌）
      const step = Math.min(COL_STEP, COL_SPAN_MAX / Math.max(len - 1, 1))
      m.position.x = (col - (nCols - 1) / 2) * colPitch
      m.position.y = BASE_Y + row * step * UP_Y + (sel ? 0.6 : 0) + (hov ? 0.42 : 0)
      // 沿牌面向上叠、上牌更远离相机；选中/悬停整体前移（拾取按最近命中）
      m.position.z = BASE_Z + col * COL_Z + row * (step * UP_Z - COL_EPS)
        + (sel ? 0.45 : 0) + (hov ? 0.35 : 0)
      m.rotation.set(TILT_X, 0, 0)
      m.scale.setScalar(hov ? 1.12 : sel ? 1.08 : 1)
      // 锁定牌用 locked 色
      const tint: 'normal' | 'dim' | 'select' | 'locked' =
        dim ? 'dim' : (sel && locked) ? 'locked' : sel ? 'select' : 'normal'
      tintCard(m, tint)
      // 选中牌：金色边框（稍大金色平面放牌后）
      if (sel) {
        const border = new THREE.Mesh(borderGeo, borderMat)
        border.position.copy(m.position)
        border.position.z -= 0.004 // 紧贴牌面后方
        border.rotation.copy(m.rotation)
        group.add(border)
        borders.push(border)
      }
    }
  }

  function pick(ev: MouseEvent): THREE.Mesh | null {
    const rect = dom.getBoundingClientRect()
    ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1
    ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1
    raycaster.setFromCamera(ndc, camera)
    const hits = raycaster.intersectObjects(meshes, false)
    // 取最近命中 = 渲染上最前面的牌（列内下牌/悬停/选中牌均更靠近相机）
    return hits.length > 0 ? (hits[0].object as THREE.Mesh) : null
  }

  /** 按当前 paintMode 设定一张牌的选中态（仅可选牌，锁定状态下忽略）。 */
  function applyPaint(m: THREE.Mesh): void {
    if (!isUsable(m) || locked) return
    const id = cardOf(m).id
    if (paintMode === 'add') selected.add(id)
    else selected.delete(id)
  }

  function onMove(ev: PointerEvent): void {
    if (dealing) return
    const m = pick(ev)
    // 移动时取消长按定时器（手指滑动 ≠ 长按）
    if (longPressTimer && !longPressFired && m) {
      clearTimeout(longPressTimer)
      longPressTimer = null
    }
    if (dragging) {
      // 拖动连选：划过新牌即按 paintMode 涂选（锁定时跳过）
      if (!locked && m && cardOf(m).id !== lastPainted) {
        applyPaint(m)
        lastPainted = cardOf(m).id
        layout()
        selCb(getSelected())
      }
      return
    }
    const usable = m && isUsable(m) ? m : null
    if (usable !== hovered) {
      hovered = usable
      layout()
      dom.style.cursor = usable ? 'pointer' : 'default'
    }
  }

  function onDown(ev: PointerEvent): void {
    if (dealing) return
    ev.preventDefault()
    dom.setPointerCapture(ev.pointerId)

    const m = pick(ev)
    if (!m || !isUsable(m)) {
      // 点击空白/置灰牌 → 解锁并清除选中
      if (locked || selected.size > 0) {
        locked = false
        selected.clear()
        layout()
        selCb([])
      }
      return
    }
    const id = cardOf(m).id

    // ── 双击检测（移动端双指Tap，桌面端 dblclick 仍独立可用）──
    if (id === lastTapId && performance.now() - lastTapTime < 400) {
      lastTapId = null
      lastTapTime = 0
      if (selected.has(id)) {
        locked = !locked
      } else {
        locked = false
        const rank = cardOf(m).rank
        for (const mm of meshes) {
          const c = cardOf(mm)
          if (c.rank === rank && (playable === null || playable.has(c.id))) selected.add(c.id)
        }
      }
      layout()
      selCb(getSelected())
      return
    }
    lastTapId = id
    lastTapTime = performance.now()

    // ── 长按检测：600ms 不动 → 选中所有同点数牌 ──
    longPressFired = false
    if (longPressTimer) clearTimeout(longPressTimer)
    longPressTimer = setTimeout(() => {
      longPressFired = true
      longPressTimer = null
      if (!selected.has(id)) {
        locked = false
        const rank = cardOf(m).rank
        for (const mm of meshes) {
          const c = cardOf(mm)
          if (c.rank === rank && (playable === null || playable.has(c.id))) selected.add(c.id)
        }
        layout()
        selCb(getSelected())
      }
    }, 600)

    // 锁定时：点击已选牌 → 不解锁（故意），点击非已选牌 → 解锁并切换选择
    if (locked) {
      if (!selected.has(id)) {
        locked = false
        selected.clear()
        dragging = true
        paintMode = 'add'
        applyPaint(m)
        lastPainted = id
        layout()
        selCb(getSelected())
      }
      // 点击已锁定的牌 → 无操作
      return
    }
    // 首张决定 paintMode：未选→加选，已选→取消（单击不拖 = 一次 toggle）
    dragging = true
    paintMode = selected.has(id) ? 'remove' : 'add'
    applyPaint(m)
    lastPainted = id
    layout()
    selCb(getSelected())
  }

  function onUp(): void {
    if (longPressTimer) {
      clearTimeout(longPressTimer)
      longPressTimer = null
    }
    dragging = false
    lastPainted = null
  }

  const getSelected = (): Card[] => meshes.map(cardOf).filter((c) => selected.has(c.id))

  /** 双击一张可选牌 → 选中同点数（可选）牌；双击已选牌 → 锁定/解锁。 */
  function onDblClick(ev: MouseEvent): void {
    if (dealing) return
    const m = pick(ev)
    if (!m || !isUsable(m)) return
    const id = cardOf(m).id
    // 如果点的是已选中的牌 → 切换锁定
    if (selected.has(id)) {
      locked = !locked
      layout()
      selCb(getSelected())
      return
    }
    // 否则：选中所有同点数牌（解锁状态）
    locked = false
    const rank = cardOf(m).rank
    for (const mm of meshes) {
      const c = cardOf(mm)
      if (c.rank === rank && (playable === null || playable.has(c.id))) selected.add(c.id)
    }
    layout()
    selCb(getSelected())
  }

  dom.addEventListener('pointermove', onMove)
  dom.addEventListener('pointerdown', onDown)
  dom.addEventListener('dblclick', onDblClick)
  window.addEventListener('pointerup', onUp)

  // ── 分列 ──
  /** 按牌力分组成列：同点数一列（级牌/王各自成列），列间升序，列内按花色再 id。 */
  function rankColumns(cards: Card[]): Card[][] {
    const byPower = new Map<number, Card[]>()
    for (const c of cards) {
      const p = singlePower(c, level)
      const arr = byPower.get(p)
      if (arr) arr.push(c)
      else byPower.set(p, [c])
    }
    return [...byPower.keys()].sort((a, b) => a - b).map((p) =>
      byPower.get(p)!.sort((a, b) => suitIndex(a.suit) - suitIndex(b.suit) || a.id.localeCompare(b.id)),
    )
  }

  /** 当前模式下的列划分；sflush 模式：同花顺组靠左，其余按点数列。 */
  function computeColumns(cards: Card[]): Card[][] {
    if (sortMode === 'sflush') {
      const sf = findStraightFlushGroups(cards, level)
      const used = new Set(sf.flat().map((c) => c.id))
      return [...sf, ...rankColumns(cards.filter((c) => !used.has(c.id)))]
    }
    return rankColumns(cards)
  }

  /** 按列划分重建全部牌 mesh（列主序），slot 记录 (col,row) 供 layout 使用。 */
  function buildMeshes(cards: Card[]): void {
    clearMeshes()
    const cols = computeColumns(cards)
    nCols = Math.max(cols.length, 1)
    cols.forEach((colCards, col) => {
      colCards.forEach((c, row) => {
        const m = createCardMesh(c)
        m.userData.slot = { col, row, len: colCards.length }
        meshes.push(m)
        group.add(m)
      })
    })
  }

  function relayout(): void {
    const cards = meshes.map(cardOf)
    buildMeshes(cards)
    layout()
  }

  return {
    setHand(cards, lv, animate = false) {
      level = lv
      selected.clear()
      locked = false
      buildMeshes(cards)
      layout() // 落到最终列位
      if (animate && meshes.length > 0) {
        dealing = true
        const n = meshes.length
        meshes.forEach((m, i) => {
          const tx = m.position.x
          const ty = m.position.y
          const tz = m.position.z
          const trz = m.rotation.z
          // 起点：桌心上方牌堆，随机初始旋转
          const srz = (Math.random() - 0.5) * 0.6
          m.position.set(0, 3.2, 1.2)
          m.rotation.z = srz
          const last = i === n - 1
          dealCancels.push(tweens.add(
            0.5,
            (t) => {
              m.position.x = tx * t
              m.position.y = 3.2 + (ty - 3.2) * t
              m.position.z = 1.2 + (tz - 1.2) * t
              m.rotation.z = srz + (trz - srz) * t
            },
            {
              ease: easeOutBack,
              delay: i * 0.022,
              onComplete: last
                ? () => {
                    dealing = false
                    // 优先应用发牌期间缓存的 playable 状态（避免被 turn_notify 提前灰化）
                    if (pendingPlayable !== null) {
                      const p = pendingPlayable
                      pendingPlayable = null
                      // 直接应用：不调 setPlayable（避免递归）
                      if (p) for (const id of [...selected]) if (!p.has(id)) selected.delete(id)
                      playable = p
                    }
                    layout()
                  }
                : undefined,
            },
          ))
        })
      }
    },
    setPlayable(ids) {
      // 发牌动画期间：缓存 playable 状态，动画完成回调会应用
      if (dealing) {
        pendingPlayable = ids
        return
      }
      playable = ids
      // 取消已选中的非法牌
      if (ids) for (const id of [...selected]) if (!ids.has(id)) selected.delete(id)
      layout()
    },
    getSelected,
    select(ids) {
      selected.clear()
      locked = false
      const valid = new Set(meshes.map(cardOf).map((c) => c.id))
      for (const id of ids) if (valid.has(id) && (playable === null || playable.has(id))) selected.add(id)
      if (!dealing) layout()
      // 即使在 dealing 中也通知选中变化（不影响视觉 tint，但 callback 需要）
      selCb(getSelected())
    },
    clearSelection() {
      selected.clear()
      locked = false
      layout()
      selCb([])
    },
    isLocked: () => locked,
    cycleSortMode() {
      const idx = SORT_MODES.indexOf(sortMode)
      sortMode = SORT_MODES[(idx + 1) % SORT_MODES.length]
      relayout()
      selCb(getSelected())
      return SORT_LABEL[sortMode]
    },
    onSelectionChange(cb) {
      selCb = cb
    },
    dispose() {
      dom.removeEventListener('pointermove', onMove)
      dom.removeEventListener('pointerdown', onDown)
      dom.removeEventListener('dblclick', onDblClick)
      window.removeEventListener('pointerup', onUp)
      clearMeshes()
      scene.remove(group)
    },
  }
}
