/**
 * Bot 对局测试：Playwright 驱动完整掼蛋对局。
 * 脚本通过 HUD 按钮（提示→出牌/过）驱动人类回合，等 AI 自动行动，
 * 验证：零报错、对局流程正常推进至结算。
 *
 * 运行：npx playwright test tests/bot-playtest.spec.ts
 *
 * 注意：headless WebGL 为 SwiftShader 软件渲染，帧率低（非性能证据），
 * 仅验证功能性——canvas 非空、回合推进、结算可达。
 */
import { test, expect } from '@playwright/test'

const SEED = 20260714

/** 等待游戏就绪：过开局菜单（首次自动弹出的玩法说明 → 关闭 → 开始游戏） */
async function waitReady(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.waitForFunction(() => (window as any).__READY__ === true, undefined, { timeout: 15_000 })
  const helpClose = page.locator('.menu-help-close')
  if (await helpClose.isVisible().catch(() => false)) {
    await helpClose.click()
  }
  await page.locator('.menu-start').click()
  // 等发牌动画 + AI 思考完毕 → 轮到人类
  await page.waitForTimeout(4_000)
}

/** 点【提示】按钮 */
async function clickHint(page: import('@playwright/test').Page) {
  const btn = page.locator('#btn-hint')
  if (await btn.isVisible().catch(() => false)) {
    await btn.click()
    await page.waitForTimeout(200)
  }
}

/** 点【出牌】按钮 */
async function clickPlay(page: import('@playwright/test').Page) {
  const btn = page.locator('#btn-play')
  if (await btn.isVisible().catch(() => false)) {
    const disabled = await btn.getAttribute('disabled')
    if (disabled === null) {
      await btn.click()
      await page.waitForTimeout(500)
    }
  }
}

/** 点【过】按钮 */
async function clickPass(page: import('@playwright/test').Page) {
  const btn = page.locator('#btn-pass')
  if (await btn.isVisible().catch(() => false)) {
    const disabled = await btn.getAttribute('disabled')
    if (disabled === null) {
      await btn.click()
      await page.waitForTimeout(500)
    }
  }
}

/** 读取游戏诊断 */
async function diag(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const d = (window as any).__THREE_GAME_DIAGNOSTICS__
    return d ? d() : null
  })
}

/** 等 AI 回合完毕（current 变为 0 或 over） */
async function waitForHumanTurn(page: import('@playwright/test').Page, timeoutMs = 15_000) {
  await page.waitForFunction(
    () => {
      const g = (window as any).__THREE_GAME_DIAGNOSTICS__
      if (!g) return false
      const s = g().state
      return s.current === 0 || s.over === true
    },
    undefined,
    { timeout: timeoutMs },
  )
}

test('bot 完整对局：从发牌到结算零报错', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`)
  })

  await waitReady(page)

  // 处理可能的进贡还贡：如果有可出牌就出
  await page.waitForTimeout(1_500)

  let turns = 0
  const MAX_TURNS = 120 // 安全上限，防止无限循环

  while (turns < MAX_TURNS) {
    const d = await diag(page)
    if (!d) break
    if (d.state.over) break

    // 如果是人类回合
    if (d.state.current === 0) {
      // 先点提示看有什么可出
      await clickHint(page)

      // 判断：如果能出牌就出，否则过
      const d2 = await diag(page)
      const canPass = d2?.state?.tableType !== null

      await clickPlay(page)

      // 如果出牌按钮是 disabled（无可出牌型），试过牌
      const d3 = await diag(page)
      if (d3?.state?.current === 0 && canPass) {
        await clickPass(page)
      }

      turns++
      await page.waitForTimeout(600)
    }

    // 等 AI 行动完毕
    await waitForHumanTurn(page)
  }

  expect(turns).toBeLessThan(MAX_TURNS)

  const final = await diag(page)
  expect(final).not.toBeNull()
  expect(final.state.over).toBe(true)
  expect(final.state.finished.length).toBe(4)

  // 零报错
  expect(errors.filter((e) => !e.includes('favicon'))).toEqual([])
})

test('canvas 非空 + 帧推进', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))

  await waitReady(page)

  // 拿诊断
  const d = await diag(page)
  expect(d).not.toBeNull()
  expect(d.fps).toBeGreaterThan(0)
  // headless 下 FPS 可能很低（SwiftShader），只验证非零
  expect(d.renderer.calls).toBeGreaterThan(0)
  expect(errors.filter((e) => !e.includes('favicon'))).toEqual([])
})

test('难度切换 + 静音/画质开关有效', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))

  await waitReady(page)

  // 难度按钮存在且可点击
  const easyBtn = page.locator('button[data-d="easy"]')
  const normalBtn = page.locator('button[data-d="normal"]')
  const hardBtn = page.locator('button[data-d="hard"]')
  await expect(easyBtn).toBeVisible()
  await expect(hardBtn).toBeVisible()

  // 切到困难
  await hardBtn.click()
  await page.waitForTimeout(300)
  let d = await diag(page)
  expect(d.state.difficulty).toBe('hard')

  // 切回简单
  await easyBtn.click()
  await page.waitForTimeout(300)
  d = await diag(page)
  expect(d.state.difficulty).toBe('easy')

  // 切回普通
  await normalBtn.click()
  await page.waitForTimeout(300)
  d = await diag(page)
  expect(d.state.difficulty).toBe('normal')

  // 静音切换
  const muteBtn = page.locator('#btn-mute')
  await expect(muteBtn).toBeVisible()
  await muteBtn.click()
  await page.waitForTimeout(200)
  d = await diag(page)
  expect(d.muted).toBe(true)
  await muteBtn.click()
  await page.waitForTimeout(200)
  d = await diag(page)
  expect(d.muted).toBe(false)

  // 画质切换
  const qLow = page.locator('button[data-q="low"]')
  const qHigh = page.locator('button[data-q="high"]')
  await expect(qLow).toBeVisible()
  await qLow.click()
  await page.waitForTimeout(300)
  d = await diag(page)
  expect(d.quality).toBe('low')

  await qHigh.click()
  await page.waitForTimeout(300)
  d = await diag(page)
  expect(d.quality).toBe('high')

  expect(errors.filter((e) => !e.includes('favicon'))).toEqual([])
})
