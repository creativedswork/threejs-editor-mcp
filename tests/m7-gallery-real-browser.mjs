import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const webUrl = process.env.DSH_WEB_URL
const workspacePath = process.env.THREEJS_EDITOR_MCP_WORKSPACE
if (webUrl === undefined || workspacePath === undefined) {
  throw new Error('DSH_WEB_URL and THREEJS_EDITOR_MCP_WORKSPACE are required')
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })

async function pixelStats(frame) {
  return frame.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(resolve))
    const canvas = document.querySelector('canvas')
    const sample = document.createElement('canvas')
    sample.width = 240
    sample.height = 150
    const context = sample.getContext('2d', { willReadFrequently: true })
    context.drawImage(canvas, 0, 0, sample.width, sample.height)
    const data = context.getImageData(0, 0, sample.width, sample.height).data
    const colors = new Set()
    let lit = 0
    for (let index = 0; index < data.length; index += 16) {
      const red = data[index] ?? 0
      const green = data[index + 1] ?? 0
      const blue = data[index + 2] ?? 0
      if (red + green + blue > 60) lit += 1
      colors.add((red << 16) | (green << 8) | blue)
    }
    return { sampled: data.length / 16, lit, colors: colors.size }
  })
}

try {
  await page.goto(webUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  const addWorkspace = page.getByRole('button', { name: '添加工作区', exact: true })
  const continueButton = page.getByText('继续', { exact: true })
  try {
    await addWorkspace.click({ timeout: 30_000 })
  } catch {
    await continueButton.waitFor({ state: 'visible', timeout: 60_000 })
    await continueButton.click()
    await continueButton.waitFor({ state: 'hidden' })
    await addWorkspace.click({ timeout: 30_000 })
  }
  await page.getByRole('heading', { name: '选择工作区目录' }).waitFor()
  await page.getByRole('button', { name: '编辑路径' }).click()
  const pathInput = page.getByRole('textbox', { name: '编辑路径' })
  await pathInput.fill(workspacePath)
  await pathInput.press('Enter')
  await page.getByRole('button', { name: '打开', exact: true }).click()
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })

  const composer = page.getByRole('textbox', {
    name: /描述你想要构建的内容|给智能体发消息/,
  })
  await composer.waitFor({ state: 'visible', timeout: 60_000 })
  await composer.fill('列出当前threejs工程有哪些')
  await composer.press('Enter')
  await page.waitForFunction(
    () => document.body.innerText.includes(
      'threejs-procedural-geometry/formula-one-race-car',
    ),
    undefined,
    { timeout: 120_000 },
  )

  await composer.fill('打开这个 threejs-procedural-geometry/formula-one-race-car')
  await composer.press('Enter')
  const outer = page.locator('iframe[title="MCP App: mcp__threejs__open_editor"]').last()
  await outer.waitFor({ state: 'visible', timeout: 120_000 })
  const outerFrame = await (await outer.elementHandle()).contentFrame()
  assert.notEqual(outerFrame, null)
  const inner = outerFrame.locator('iframe')
  await inner.waitFor({ state: 'visible', timeout: 30_000 })
  const appFrame = await (await inner.elementHandle()).contentFrame()
  assert.notEqual(appFrame, null)
  await appFrame.waitForFunction(() => {
    const metrics = globalThis.__THREE_M7__?.metrics()
    return metrics?.playState === 'editing'
      && metrics.m7.ready?.mode === 'edit'
      && metrics.m7.ready?.rendererBackend === 'WebGPUBackend'
      && metrics.m7.ready?.emittedParts === 62
  }, undefined, { timeout: 120_000 })
  await appFrame.getByRole('button', { name: 'VF-26', exact: true }).waitFor()
  const runtime = appFrame.locator('iframe[data-runtime-sandbox]')
  const runtimeFrame = await (await runtime.elementHandle()).contentFrame()
  assert.notEqual(runtimeFrame, null)
  const runtimeIdentity = await runtimeFrame.evaluate(() => {
    globalThis.__M7_RUNTIME_IDENTITY__ = crypto.randomUUID()
    return globalThis.__M7_RUNTIME_IDENTITY__
  })
  const pixels = await pixelStats(runtimeFrame)
  assert.ok(pixels.lit > pixels.sampled * 0.7)
  assert.ok(pixels.colors > 600)
  const car = appFrame.getByRole('button', { name: 'VF-26', exact: true })
  await car.click()
  const positionX = appFrame.getByRole('spinbutton', { name: 'Position X' })
  const beforeRevision = await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics().revision)
  await positionX.fill('0.25')
  await positionX.press('Enter')
  await appFrame.getByRole('button', { name: 'Save' }).click()
  await appFrame.waitForFunction(previous => {
    const metrics = globalThis.__THREE_M7__.metrics()
    return metrics.sync === 'clean'
      && metrics.playState === 'editing'
      && metrics.revision !== previous
  }, beforeRevision, { timeout: 120_000 })
  const savedRevision = await appFrame.evaluate(() => (
    globalThis.__THREE_M7__.metrics().revision
  ))
  assert.equal(Number(await positionX.inputValue()), 0.25)

  await composer.fill('我刚才在编辑器里做过什么操作？请使用 Three.js MCP 检查当前工程。')
  await composer.press('Enter')
  await page.waitForFunction(() => {
    const text = document.body.innerText
    return text.includes('VF-26') && text.includes('0.25')
  }, undefined, { timeout: 120_000 })
  await composer.fill(
    '撤销这次移动，将 VF-26 恢复到 [0,0,0]。请使用 Three.js MCP 完成并检查结果。',
  )
  await composer.press('Enter')
  await appFrame.waitForFunction(previous => {
    const metrics = globalThis.__THREE_M7__.metrics()
    return metrics.sync === 'clean'
      && metrics.playState === 'editing'
      && metrics.revision !== previous
  }, savedRevision, { timeout: 120_000 })
  assert.equal(Number(await positionX.inputValue()), 0)
  const runtimeAfterUndo = await (await runtime.elementHandle()).contentFrame()
  assert.notEqual(runtimeAfterUndo, null)
  assert.equal(
    await runtimeAfterUndo.evaluate(() => globalThis.__M7_RUNTIME_IDENTITY__),
    runtimeIdentity,
  )
  const undoPixels = await pixelStats(runtimeAfterUndo)
  assert.ok(undoPixels.lit > undoPixels.sampled * 0.7)
  assert.ok(undoPixels.colors > 600)
  await page.getByTitle('Open mcp__threejs__open_editor fullscreen').click()
  await page.locator('[data-mcp-app-view][data-display-mode="fullscreen"]').waitFor()
  const fullscreenPixels = await pixelStats(runtimeAfterUndo)
  assert.ok(fullscreenPixels.lit > fullscreenPixels.sampled * 0.7)
  assert.ok(fullscreenPixels.colors > 600)
  const body = await page.locator('body').innerText()
  assert.doesNotMatch(body, /npm install|gallery server|打开 HTML/i)

  await page.screenshot({
    path: 'artifacts/m7-gallery-real-direct-open.png',
    fullPage: false,
  })
  await page.setViewportSize({ width: 520, height: 900 })
  await page.waitForTimeout(500)
  const mobileLayout = await appFrame.evaluate(() => {
    const topbar = document.querySelector('.topbar').getBoundingClientRect()
    const toolbar = document.querySelector('.transform-tools').getBoundingClientRect()
    const panel = document.querySelector('.hierarchy').getBoundingClientRect()
    const hit = document.elementFromPoint(innerWidth / 2, topbar.bottom + 20)
    return {
      visibleTopHit: hit?.hasAttribute('data-runtime-sandbox') ? 'runtime' : hit?.className,
      toolbarAbovePanels: toolbar.bottom < panel.top,
    }
  })
  assert.deepEqual(mobileLayout, {
    visibleTopHit: 'runtime',
    toolbarAbovePanels: true,
  })
  await page.screenshot({
    path: 'artifacts/m7-ai-undo-mobile.png',
    fullPage: false,
  })
  process.stdout.write(`${JSON.stringify({
    webUrl,
    workspacePath,
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    toolSequence: [
      'mcp__threejs__list_projects',
      'mcp__threejs__open_editor',
      'mcp__threejs__inspect_project',
      'mcp__threejs__apply_editor_commands',
      'mcp__threejs__inspect_project',
    ],
    editMode: true,
    editorObject: 'VF-26',
    humanPositionX: 0.25,
    savedRevision,
    aiRecognizedHumanEdit: true,
    aiUndidHumanEdit: true,
    runtimePreservedAcrossAiUndo: true,
    pixels,
    undoPixels,
    fullscreenPixels,
    mobileLayout,
  }, null, 2)}\n`)
} finally {
  await browser.close()
}
