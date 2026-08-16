import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const webUrl = process.env.DSH_WEB_URL
if (webUrl === undefined) throw new Error('DSH_WEB_URL is required')

const projectRoot = resolve(process.env.THREEJS_EDITOR_MCP_ROOT ?? '.')
const artifacts = resolve(projectRoot, 'artifacts')
mkdirSync(artifacts, { recursive: true })

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 1,
})
const appProblems = []
page.on('console', message => {
  if (message.type() === 'error' || message.text().includes('THREE.')) {
    appProblems.push(`${message.type()}: ${message.text()}`)
  }
})
page.on('pageerror', error => {
  appProblems.push(`pageerror: ${error.message}`)
})

try {
  await page.goto(webUrl, { waitUntil: 'domcontentloaded' })

  const disclaimer = page.locator('[role="presentation"]')
    .filter({ hasText: '内测声明' })
    .last()
  await disclaimer.waitFor({ state: 'visible', timeout: 60_000 })
  await disclaimer.getByText('继续', { exact: true }).click()
  await disclaimer.waitFor({ state: 'hidden' })

  await page.getByRole('button', { name: '添加工作区' }).click()
  await page.getByRole('heading', { name: '选择工作区目录' }).waitFor()
  await page.getByRole('button', { name: '编辑路径' }).click()
  const pathInput = page.getByRole('textbox', { name: '编辑路径' })
  await pathInput.fill(projectRoot)
  await pathInput.press('Enter')
  await page.getByRole('button', { name: '打开', exact: true }).click()

  const composer = page.getByRole('textbox', { name: '描述你想要构建的内容' })
  await composer.fill('打开 Three.js 验证场景')
  await composer.press('Enter')
  await page.getByText('Three.js validation scene loaded.').waitFor({ timeout: 20_000 })

  const outer = page.locator('iframe[title="MCP App: mcp__threejs__open_three_demo"]')
  await outer.waitFor({ state: 'visible', timeout: 20_000 })
  const outerHandle = await outer.elementHandle()
  assert.notEqual(outerHandle, null)
  const sandboxFrame = await outerHandle.contentFrame()
  assert.notEqual(sandboxFrame, null)

  const inner = sandboxFrame.locator('iframe')
  await inner.waitFor({ state: 'visible', timeout: 10_000 })
  const innerHandle = await inner.elementHandle()
  assert.notEqual(innerHandle, null)
  const appFrame = await innerHandle.contentFrame()
  assert.notEqual(appFrame, null)

  await appFrame.locator('[data-three-m0]').waitFor({ timeout: 10_000 })
  await appFrame.waitForFunction(() => globalThis.__THREE_M0__?.metrics().frame > 10)

  const outerBox = await outer.boundingBox()
  const innerBox = await inner.boundingBox()
  const canvas = appFrame.locator('[data-three-canvas]')
  const canvasBox = await canvas.boundingBox()
  assert.notEqual(outerBox, null)
  assert.notEqual(innerBox, null)
  assert.notEqual(canvasBox, null)
  assert.ok(outerBox.height >= 390, `outer iframe is only ${String(outerBox.height)}px high`)
  assert.ok(innerBox.height >= 390, `sandbox inner iframe is only ${String(innerBox.height)}px high`)
  assert.ok(canvasBox.width >= 480, `canvas is only ${String(canvasBox.width)}px wide`)
  assert.ok(canvasBox.height >= 320, `canvas is only ${String(canvasBox.height)}px high`)

  const beforeMove = await appFrame.evaluate(() => globalThis.__THREE_M0__.metrics())
  await canvas.click()
  await page.keyboard.down('w')
  await page.waitForTimeout(300)
  await page.keyboard.up('w')
  const afterMove = await appFrame.evaluate(() => globalThis.__THREE_M0__.metrics())
  assert.ok(
    afterMove.leftPaddleZ < beforeMove.leftPaddleZ - 0.2,
    `keyboard input did not move the paddle: ${String(beforeMove.leftPaddleZ)} -> ${String(afterMove.leftPaddleZ)}`,
  )

  await appFrame.getByRole('button', { name: 'Pause animation' }).click()
  const paused = await appFrame.evaluate(() => globalThis.__THREE_M0__.metrics())
  await page.waitForTimeout(250)
  const stillPaused = await appFrame.evaluate(() => globalThis.__THREE_M0__.metrics())
  assert.ok(Math.abs(stillPaused.ballX - paused.ballX) < 0.001, 'pause did not stop the ball')
  await appFrame.getByRole('button', { name: 'Resume animation' }).click()

  const pixels = await appFrame.evaluate(() => globalThis.__THREE_M0__.pixelStats())
  assert.ok(pixels.width >= 480, `drawing buffer width is ${String(pixels.width)}`)
  assert.ok(pixels.height >= 320, `drawing buffer height is ${String(pixels.height)}`)
  assert.ok(pixels.lit > pixels.sampled * 0.1, 'canvas is effectively blank')
  assert.ok(pixels.colors > 20, `canvas has only ${String(pixels.colors)} sampled colors`)

  const wideCanvas = await canvas.boundingBox()
  await page.setViewportSize({ width: 640, height: 900 })
  await page.waitForTimeout(300)
  const narrowCanvas = await canvas.boundingBox()
  assert.notEqual(wideCanvas, null)
  assert.notEqual(narrowCanvas, null)
  assert.ok(narrowCanvas.width < wideCanvas.width, 'canvas did not respond to viewport width')
  assert.ok(narrowCanvas.height >= 280, `responsive canvas collapsed to ${String(narrowCanvas.height)}px`)

  await page.screenshot({
    path: resolve(artifacts, 'm0-harness-threejs.png'),
    fullPage: true,
  })
  assert.deepEqual(appProblems, [])

  process.stdout.write(`${JSON.stringify({
    webUrl,
    outer: outerBox,
    inner: innerBox,
    canvas: canvasBox,
    keyboard: {
      before: beforeMove.leftPaddleZ,
      after: afterMove.leftPaddleZ,
    },
    pixels,
    responsive: {
      wide: wideCanvas,
      narrow: narrowCanvas,
    },
    appProblems,
  }, null, 2)}\n`)
} catch (error) {
  await page.screenshot({
    path: resolve(artifacts, 'm0-harness-threejs-failure.png'),
    fullPage: true,
  })
  throw error
} finally {
  await browser.close()
}
