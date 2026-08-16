import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const webUrl = process.env.DSH_WEB_URL
if (webUrl === undefined) throw new Error('DSH_WEB_URL is required')

const projectRoot = resolve(process.env.THREEJS_EDITOR_MCP_ROOT ?? '.')
const projectsRoot = resolve(
  process.env.THREEJS_EDITOR_MCP_PROJECTS ?? resolve(projectRoot, '.tmp/m1-projects'),
)
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

  const catalog = await page.evaluate(async () => {
    const response = await fetch('/api/mcp-apps/catalog')
    return response.json()
  })
  const publicToolNames = catalog.items.map(item => item.publicToolName).sort()
  assert.deepEqual(publicToolNames, [
    'mcp__threejs__create_project',
    'mcp__threejs__open_editor',
  ])
  assert.equal(publicToolNames.some(name => name.includes('pull_project')), false)
  assert.equal(publicToolNames.some(name => name.includes('push_project')), false)

  await page.getByRole('button', { name: '添加工作区' }).click()
  await page.getByRole('heading', { name: '选择工作区目录' }).waitFor()
  await page.getByRole('button', { name: '编辑路径' }).click()
  const pathInput = page.getByRole('textbox', { name: '编辑路径' })
  await pathInput.fill(projectRoot)
  await pathInput.press('Enter')
  await page.getByRole('button', { name: '打开', exact: true }).click()

  const composer = page.getByRole('textbox', { name: '描述你想要构建的内容' })
  await composer.fill('创建并打开 M1 Pong 项目')
  await composer.press('Enter')
  await page.getByText('Three.js project created and opened.').waitFor({ timeout: 20_000 })

  const outer = page.locator('iframe[title="MCP App: mcp__threejs__create_project"]')
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

  const editor = appFrame.locator('[data-three-editor]')
  await editor.waitFor({ state: 'visible', timeout: 10_000 })
  await appFrame.waitForFunction(() => (
    globalThis.__THREE_M1__?.metrics().frame > 10
    && globalThis.__THREE_M1__?.metrics().sync === 'clean'
  ))

  const outerBox = await outer.boundingBox()
  const innerBox = await inner.boundingBox()
  const canvas = appFrame.locator('[data-three-canvas]')
  const canvasBox = await canvas.boundingBox()
  assert.notEqual(outerBox, null)
  assert.notEqual(innerBox, null)
  assert.notEqual(canvasBox, null)
  assert.ok(outerBox.height >= 398, `outer iframe is only ${String(outerBox.height)}px high`)
  assert.ok(innerBox.height >= 398, `sandbox inner iframe is only ${String(innerBox.height)}px high`)
  assert.ok(canvasBox.width >= 480, `canvas is only ${String(canvasBox.width)}px wide`)
  assert.ok(canvasBox.height >= 315, `canvas is only ${String(canvasBox.height)}px high`)

  const beforeSave = await appFrame.evaluate(() => globalThis.__THREE_M1__.metrics())
  assert.equal(beforeSave.projectId, 'm1-pong')
  assert.equal(beforeSave.title, 'Pong M1')
  assert.match(beforeSave.revision, /^[a-f0-9]{64}$/)

  const pixels = await appFrame.evaluate(() => globalThis.__THREE_M1__.pixelStats())
  assert.ok(pixels.width >= 480, `drawing buffer width is ${String(pixels.width)}`)
  assert.ok(pixels.height >= 315, `drawing buffer height is ${String(pixels.height)}`)
  assert.ok(pixels.lit > pixels.sampled * 0.1, 'canvas is effectively blank')
  assert.ok(pixels.colors > 20, `canvas has only ${String(pixels.colors)} sampled colors`)

  const title = appFrame.getByRole('textbox', { name: 'Project title' })
  await title.fill('Pong Human Edit')
  await editor.waitFor({ state: 'visible' })
  assert.equal(await editor.getAttribute('data-sync'), 'dirty')
  await appFrame.getByRole('button', { name: 'Save', exact: true }).click()
  await appFrame.getByText('Saved', { exact: true }).waitFor({ timeout: 10_000 })
  await appFrame.waitForFunction(() => globalThis.__THREE_M1__?.metrics().sync === 'clean')

  const afterSave = await appFrame.evaluate(() => globalThis.__THREE_M1__.metrics())
  assert.equal(afterSave.title, 'Pong Human Edit')
  assert.notEqual(afterSave.revision, beforeSave.revision)

  const projectPath = resolve(projectsRoot, 'm1-pong', 'project.json')
  const projectBytes = readFileSync(projectPath)
  const diskProject = JSON.parse(projectBytes)
  const diskRevision = createHash('sha256').update(projectBytes).digest('hex')
  assert.equal(diskProject.title, 'Pong Human Edit')
  assert.equal(afterSave.revision, diskRevision)

  await page.setViewportSize({ width: 640, height: 900 })
  await page.waitForTimeout(300)
  const narrowCanvas = await canvas.boundingBox()
  assert.notEqual(narrowCanvas, null)
  assert.ok(narrowCanvas.width < canvasBox.width, 'canvas did not respond to viewport width')
  assert.ok(narrowCanvas.height >= 280, `responsive canvas collapsed to ${String(narrowCanvas.height)}px`)

  await page.screenshot({
    path: resolve(artifacts, 'm1-harness-project-save.png'),
    fullPage: true,
  })
  assert.deepEqual(appProblems, [])

  process.stdout.write(`${JSON.stringify({
    webUrl,
    catalog: publicToolNames,
    outer: outerBox,
    inner: innerBox,
    canvas: canvasBox,
    pixels,
    beforeSave,
    afterSave,
    disk: {
      projectPath,
      title: diskProject.title,
      revision: diskRevision,
    },
    responsive: {
      narrow: narrowCanvas,
    },
    appProblems,
  }, null, 2)}\n`)
} catch (error) {
  await page.screenshot({
    path: resolve(artifacts, 'm1-harness-project-save-failure.png'),
    fullPage: true,
  })
  throw error
} finally {
  await browser.close()
}
