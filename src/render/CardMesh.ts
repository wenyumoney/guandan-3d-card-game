import * as THREE from 'three'
import { type Card } from '../core/cards'
import { cardFaceTexture, cardBackTexture } from './textures'

export const CARD_W = 0.66
export const CARD_H = 0.92

const sharedGeo = new THREE.PlaneGeometry(CARD_W, CARD_H)

/** 正面朝 +z 的牌网格；userData.card 存牌引用。用 Basic 材质保证牌面恒清晰。 */
export function createCardMesh(card: Card): THREE.Mesh {
  const mat = new THREE.MeshBasicMaterial({ map: cardFaceTexture(card) })
  const mesh = new THREE.Mesh(sharedGeo, mat)
  mesh.userData.card = card
  return mesh
}

export function createBackMesh(): THREE.Mesh {
  const mat = new THREE.MeshBasicMaterial({ map: cardBackTexture() })
  return new THREE.Mesh(sharedGeo, mat)
}

/** 给一张牌上高亮/置灰/锁定视觉状态（改材质颜色乘子）。 */
export function tintCard(mesh: THREE.Mesh, mode: 'normal' | 'dim' | 'select' | 'locked'): void {
  const mat = mesh.material as THREE.MeshBasicMaterial
  if (mode === 'dim') mat.color.setHex(0x888888) // 保留花色可辨（红黑区分不淹没）
  else if (mode === 'select') mat.color.setHex(0xfff2c0)
  else if (mode === 'locked') mat.color.setHex(0xffd89b) // 更暖更亮，区别于普通选中
  else mat.color.setHex(0xffffff)
}
