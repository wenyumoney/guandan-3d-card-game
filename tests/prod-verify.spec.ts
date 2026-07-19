/**
 * 生产构建验证：preview server 加载、零报错、调试钩子已移除。
 */
import { test, expect } from '@playwright/test'

test('生产构建：加载、canvas 非空、调试钩子已移除', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))

  await page.goto('/')
  await page.waitForFunction(() => (window as any).__READY__ === true, undefined, { timeout: 15_000 })
  await page.waitForTimeout(2_000)

  // 调试钩子在生产构建应不存在
  const hasDiag = await page.evaluate(() => typeof (window as any).__THREE_GAME_DIAGNOSTICS__)
  expect(hasDiag).toBe('undefined')

  const hasFxTest = await page.evaluate(() => typeof (window as any).__FX_TEST__)
  expect(hasFxTest).toBe('undefined')

  // __READY__ 仍存在（非调试用）
  const hasReady = await page.evaluate(() => typeof (window as any).__READY__)
  expect(hasReady).toBe('boolean')

  // canvas 非空
  const canvas = page.locator('canvas')
  await expect(canvas).toBeVisible()

  expect(errors.filter((e) => !e.includes('favicon'))).toEqual([])
})
