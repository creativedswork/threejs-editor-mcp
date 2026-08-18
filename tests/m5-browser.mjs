import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const webUrl = process.env.DSH_WEB_URL
if (webUrl === undefined) throw new Error('DSH_WEB_URL is required')
const projectRoot = resolve(process.env.THREEJS_EDITOR_MCP_ROOT ?? '.')
const projectsRoot = resolve(
  process.env.THREEJS_EDITOR_MCP_PROJECTS ?? resolve(projectRoot, '.tmp/m5-projects'),
)
const artifacts = resolve(projectRoot, 'artifacts')
mkdirSync(artifacts, { recursive: true })

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({
  viewport: { width: 1280, height: 1000 },
  deviceScaleFactor: 1,
})
const appProblems = []
const expectedSecurityMessages = []
page.on('console', message => {
  if (message.type() !== 'error' && !message.text().includes('THREE.')) return
  const text = `${message.type()}: ${message.text()}`
  if (/Unsafe attempt to initiate navigation|Blocked.*navigation/i.test(text)) {
    expectedSecurityMessages.push(text)
  } else {
    appProblems.push(text)
  }
})
page.on('pageerror', error => appProblems.push(`pageerror: ${error.message}`))

async function appSurface() {
  const outer = page.locator('iframe[title="MCP App: mcp__threejs__create_project"]').last()
  await outer.waitFor({ state: 'visible', timeout: 30_000 })
  const outerFrame = await (await outer.elementHandle()).contentFrame()
  assert.notEqual(outerFrame, null)
  const inner = outerFrame.locator('iframe')
  await inner.waitFor({ state: 'visible', timeout: 15_000 })
  const appFrame = await (await inner.elementHandle()).contentFrame()
  assert.notEqual(appFrame, null)
  await appFrame.locator('[data-three-editor]').waitFor({ state: 'visible', timeout: 15_000 })
  await appFrame.waitForFunction(() => (
    globalThis.__THREE_M5__?.metrics().frame > 10
    && globalThis.__THREE_M5__?.metrics().sync === 'clean'
  ))
  return { outer, inner, appFrame }
}

try {
  await page.goto(webUrl, { waitUntil: 'domcontentloaded' })
  const continueButton = page.getByText('继续', { exact: true })
  await continueButton.waitFor({ state: 'visible', timeout: 60_000 })
  await continueButton.click()
  await continueButton.waitFor({ state: 'hidden' })

  const catalog = await page.evaluate(async () => {
    const response = await fetch('/api/mcp-apps/catalog')
    return response.json()
  })
  assert.deepEqual(catalog.items.map(item => item.publicToolName).sort(), [
    'mcp__threejs__create_project',
    'mcp__threejs__open_editor',
  ])

  await page.getByRole('button', { name: '添加工作区' }).click()
  await page.getByRole('heading', { name: '选择工作区目录' }).waitFor()
  await page.getByRole('button', { name: '编辑路径' }).click()
  const pathInput = page.getByRole('textbox', { name: '编辑路径' })
  await pathInput.fill(projectRoot)
  await pathInput.press('Enter')
  await page.getByRole('button', { name: '打开', exact: true }).click()

  const composer = page.getByRole('textbox', {
    name: /描述你想要构建的内容|给智能体发消息/,
  })
  await composer.fill('创建并打开 M5 Runtime Isolation 项目')
  await composer.press('Enter')
  await page.getByText('Three.js M5 runtime opened.').waitFor({ timeout: 20_000 })

  const { outer, inner, appFrame } = await appSurface()
  const projectPath = resolve(projectsRoot, 'm5-runtime', 'project.json')
  const revisionBeforeResources = sha256(projectPath)
  const ready = await appFrame.evaluate(() => globalThis.__THREE_M5__.runM5Fixture())
  assert.equal(ready.webgl2, true)
  assert.equal(typeof ready.webgpu.api, 'boolean')
  assert.equal(typeof ready.webgpu.adapter, 'boolean')
  assert.deepEqual(ready.modules, ['color.js', 'main.js'])
  assert.deepEqual(ready.isolation, {
    parentDomBlocked: true,
    topNavigationBlocked: true,
    appBridgeGlobal: 'undefined',
    forgedRpcSent: true,
  })

  await appFrame.waitForFunction(() => globalThis.__THREE_M5__.metrics().m5.frame >= 10)
  const runtime = appFrame.locator('iframe[data-runtime-sandbox]')
  assert.equal(await runtime.getAttribute('sandbox'), 'allow-scripts')
  const runtimeHandle = await runtime.elementHandle()
  assert.notEqual(runtimeHandle, null)
  const runtimeFrame = await runtimeHandle.contentFrame()
  assert.notEqual(runtimeFrame, null)
  assert.equal(await runtimeFrame.evaluate(() => location.origin), 'null')

  const pixels = await runtimeFrame.evaluate(() => {
    const canvas = document.querySelector('canvas')
    const gl = canvas.getContext('webgl2')
    const values = new Uint8Array(canvas.width * canvas.height * 4)
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, values)
    let lit = 0
    const colors = new Set()
    for (let index = 0; index < values.length; index += 16) {
      const red = values[index] ?? 0
      const green = values[index + 1] ?? 0
      const blue = values[index + 2] ?? 0
      if (red + green + blue > 80) lit += 1
      colors.add((red << 16) | (green << 8) | blue)
    }
    return {
      width: canvas.width,
      height: canvas.height,
      sampled: values.length / 16,
      lit,
      colors: colors.size,
    }
  })
  assert.ok(pixels.lit > pixels.sampled * 0.2)
  assert.ok(pixels.colors >= 2)

  const running = await appFrame.evaluate(() => globalThis.__THREE_M5__.metrics().m5)
  assert.equal(running.resourceReads, 2)
  assert.deepEqual(running.modules, ['color.js', 'main.js'])
  assert.deepEqual(running.serverCommandProof, running.localCommandProof)
  assert.equal(running.serverCommandProof.addObjectRoundTrip, true)
  assert.equal(running.serverCommandProof.historyRoundTrip, true)
  assert.equal(running.serverCommandProof.humanAiEquivalent, true)
  assert.equal(running.serverCommandProof.batchUndoRedo, true)
  assert.equal(sha256(projectPath), revisionBeforeResources)
  assert.equal(
    await page.locator('iframe[title="MCP App: mcp__threejs__create_project"]').count(),
    1,
  )
  const outerBox = await outer.boundingBox()
  const innerBox = await inner.boundingBox()
  const runtimeBox = await runtime.boundingBox()
  assert.notEqual(outerBox, null)
  assert.notEqual(innerBox, null)
  assert.notEqual(runtimeBox, null)
  assert.ok(outerBox.height >= 620)
  assert.equal(innerBox.height, outerBox.height)
  assert.ok(runtimeBox.width >= 700)
  assert.ok(runtimeBox.height >= 330)

  await page.screenshot({
    path: resolve(artifacts, 'm5-harness-isolated-runtime.png'),
    fullPage: true,
  })

  const rejection = await appFrame.evaluate(() => globalThis.__THREE_M5__.triggerM5Unhandled())
  assert.match(rejection.message, /M5 expected unhandled rejection/)
  await appFrame.evaluate(() => globalThis.__THREE_M5__.stopM5Fixture())
  const stopped = await appFrame.evaluate(() => globalThis.__THREE_M5__.metrics().m5)
  await page.waitForTimeout(200)
  const afterStop = await appFrame.evaluate(() => globalThis.__THREE_M5__.metrics().m5)
  assert.equal(stopped.active, false)
  assert.equal(stopped.runtimeFrameVisible, false)
  assert.equal(afterStop.frame, stopped.frame)
  assert.ok(stopped.frameAtStop >= stopped.frame)
  assert.equal(afterStop.messagesAfterStop, 0)

  const buildError = await appFrame.evaluate(() => globalThis.__THREE_M5__.runM5BrokenFixture())
  assert.match(buildError.message, /unresolved module missing\.js/)
  const failed = await appFrame.evaluate(() => globalThis.__THREE_M5__.metrics().m5)
  assert.ok(failed.errors.some(error => /unresolved module missing\.js/.test(error)))
  await appFrame.evaluate(() => globalThis.__THREE_M5__.stopM5Fixture())

  assert.deepEqual(appProblems, [])

  process.stdout.write(`${JSON.stringify({
    webUrl,
    catalog: catalog.items.map(item => item.publicToolName).sort(),
    revisionBeforeResources,
    revisionAfterResources: sha256(projectPath),
    frames: { outer: outerBox, inner: innerBox, runtime: runtimeBox },
    ready,
    pixels,
    commandProof: running.serverCommandProof,
    resourceReads: running.resourceReads,
    rejection,
    stopped: afterStop,
    buildError,
    expectedSecurityMessages,
    appProblems,
  }, null, 2)}\n`)
} catch (error) {
  await page.screenshot({
    path: resolve(artifacts, 'm5-harness-isolated-runtime-failure.png'),
    fullPage: true,
  })
  throw error
} finally {
  await browser.close()
}
