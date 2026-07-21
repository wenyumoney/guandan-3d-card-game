import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'

export type Quality = 'high' | 'medium' | 'low'

export interface RenderContext {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  domElement: HTMLCanvasElement
  onFrame(cb: (dt: number) => void): void
  getFps(): number
  /** 相机屏震（炸弹用）。intensity 世界单位，dur 秒。 */
  shake(intensity: number, dur: number): void
  setQuality(q: Quality): void
  getQuality(): Quality
  dispose(): void
}

const DPR_CAP: Record<Quality, number> = { high: 2, medium: 1.5, low: 1 }

/** 渲染器 + 45° 俯视相机 + 暖色宫灯打光 + ACES 色调映射 + 可选 Bloom + 屏震。 */
export function createRenderer(container: HTMLElement): RenderContext {
  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setSize(container.clientWidth, container.clientHeight)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.06
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.info.autoReset = false // 手动 reset：让 info.render 累计一帧内所有 pass 的真实 draw call
  container.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x120d09)
  scene.fog = new THREE.Fog(0x140f0a, 16, 30)

  const camera = new THREE.PerspectiveCamera(46, container.clientWidth / container.clientHeight, 0.1, 100)
  const basePos = new THREE.Vector3(0, 8.4, 8.7)
  camera.position.copy(basePos)
  camera.lookAt(0, 0, 0.4)

  // —— 打光：暖色主光 + 冷补光 + 桌上两盏宫灯点光 ——
  scene.add(new THREE.AmbientLight(0xfff2df, 0.55))
  const key = new THREE.DirectionalLight(0xffe9c6, 1.2)
  key.position.set(3.5, 12, 5.5)
  scene.add(key)
  const fill = new THREE.DirectionalLight(0x8fb0d6, 0.3)
  fill.position.set(-5.5, 6, -3)
  scene.add(fill)
  const lantern1 = new THREE.PointLight(0xffb862, 26, 16, 2)
  lantern1.position.set(-3.4, 4.2, -3.4)
  scene.add(lantern1)
  const lantern2 = new THREE.PointLight(0xffb862, 26, 16, 2)
  lantern2.position.set(3.4, 4.2, -3.4)
  scene.add(lantern2)

  // —— 后期：Bloom（仅 high）——
  const composer = new EffectComposer(renderer)
  composer.addPass(new RenderPass(scene, camera))
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(container.clientWidth, container.clientHeight),
    0.62, // strength
    0.7, // radius
    0.82, // threshold：仅高亮处泛光，避免整体发糊
  )
  composer.addPass(bloom)
  composer.addPass(new OutputPass())

  let quality: Quality = (window.innerWidth < 768) ? 'medium' : 'high'
  const applyDpr = (): void => renderer.setPixelRatio(Math.min(window.devicePixelRatio, DPR_CAP[quality]))
  applyDpr()

  const onResize = (): void => {
    const w = container.clientWidth
    const h = container.clientHeight
    renderer.setSize(w, h)
    composer.setSize(w, h)
    bloom.setSize(w, h)
    camera.aspect = w / h
    // 窄屏自动提升 FOV
    if (w / h < 1.2) {
      camera.fov = 62
    } else if (w / h < 1.5) {
      camera.fov = 54
    } else {
      camera.fov = 46
    }
    camera.updateProjectionMatrix()
  }
  window.addEventListener('resize', onResize)

  let shakeAmt = 0
  let shakeT = 0
  let shakeDur = 0

  const cbs: ((dt: number) => void)[] = []
  let last = performance.now()
  let fps = 0
  let acc = 0
  let frames = 0
  let raf = 0
  const tick = (now: number): void => {
    renderer.info.reset() // 帧首重置，本帧内所有 pass 累计，读数时反映上一完整帧
    const dt = Math.min((now - last) / 1000, 0.05)
    last = now
    acc += dt
    frames++
    if (acc >= 0.5) {
      fps = Math.round(frames / acc)
      acc = 0
      frames = 0
    }
    for (const cb of cbs) cb(dt)
    // 屏震：绕基准位随机抖动，逐渐衰减
    if (shakeT > 0) {
      shakeT -= dt
      const k = shakeAmt * Math.max(shakeT / shakeDur, 0)
      camera.position.set(
        basePos.x + (Math.random() * 2 - 1) * k,
        basePos.y + (Math.random() * 2 - 1) * k,
        basePos.z + (Math.random() * 2 - 1) * k,
      )
    } else if (camera.position.distanceToSquared(basePos) > 0.001) {
      camera.position.copy(basePos)
    }
    // 始终渲染（不在条件分支中，避免移动端浮点精度导致永不渲染）
    if (quality === 'high') composer.render()
    else renderer.render(scene, camera)
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)

  return {
    renderer,
    scene,
    camera,
    domElement: renderer.domElement,
    onFrame: (cb) => cbs.push(cb),
    getFps: () => fps,
    shake: (intensity, dur) => {
      shakeAmt = intensity
      shakeDur = Math.max(dur, 0.05)
      shakeT = shakeDur
    },
    setQuality: (q) => {
      quality = q
      applyDpr()
    },
    getQuality: () => quality,
    dispose: () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      composer.dispose()
      renderer.dispose()
      if (renderer.domElement.parentElement === container) container.removeChild(renderer.domElement)
    },
  }
}
