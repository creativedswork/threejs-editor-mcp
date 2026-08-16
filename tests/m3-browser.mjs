import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { chromium } from 'playwright'

const webUrl = process.env.DSH_WEB_URL
if (webUrl === undefined) throw new Error('DSH_WEB_URL is required')

const projectRoot = resolve(process.env.THREEJS_EDITOR_MCP_ROOT ?? '.')
const projectsRoot = resolve(
  process.env.THREEJS_EDITOR_MCP_PROJECTS ?? resolve(projectRoot, '.tmp/m3-projects'),
)
const artifacts = resolve(projectRoot, 'artifacts')
mkdirSync(artifacts, { recursive: true })

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({
  viewport: { width: 1280, height: 1000 },
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

let externalClient

async function appSurface() {
  const outer = page.locator('iframe[title="MCP App: mcp__threejs__create_project"]').last()
  await outer.waitFor({ state: 'visible', timeout: 30_000 })
  const outerHandle = await outer.elementHandle()
  assert.notEqual(outerHandle, null)
  const sandboxFrame = await outerHandle.contentFrame()
  assert.notEqual(sandboxFrame, null)

  const inner = sandboxFrame.locator('iframe')
  await inner.waitFor({ state: 'visible', timeout: 15_000 })
  const innerHandle = await inner.elementHandle()
  assert.notEqual(innerHandle, null)
  const appFrame = await innerHandle.contentFrame()
  assert.notEqual(appFrame, null)
  await appFrame.locator('[data-three-editor]').waitFor({ state: 'visible', timeout: 15_000 })
  await appFrame.waitForFunction(() => (
    globalThis.__THREE_M3__?.metrics().frame > 10
    && globalThis.__THREE_M3__?.metrics().sync === 'clean'
  ))
  return { outer, inner, appFrame }
}

async function connectExternalClient() {
  const client = new Client({
    name: 'threejs-editor-m3-evidence',
    version: '0.0.0',
  })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [resolve(projectRoot, 'dist/server.js'), '--root', projectsRoot],
  }))
  return client
}

async function waitForCheck(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await externalClient.callTool({
      name: 'check_project',
      arguments: { projectId: 'm3-pong' },
    })
    if (result.isError === undefined && predicate(result.structuredContent)) return result
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error('check_project did not reach the expected state')
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
  const publicToolNames = catalog.items.map(item => item.publicToolName).sort()
  assert.deepEqual(publicToolNames, [
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
  await composer.fill('创建并打开 M3 Pong 项目')
  await composer.press('Enter')
  await page.getByText('Three.js M3 editor opened.').waitFor({ timeout: 20_000 })

  const { outer, inner, appFrame } = await appSurface()
  const canvas = appFrame.locator('[data-three-canvas]')
  const outerBox = await outer.boundingBox()
  const innerBox = await inner.boundingBox()
  const canvasBox = await canvas.boundingBox()
  assert.notEqual(outerBox, null)
  assert.notEqual(innerBox, null)
  assert.notEqual(canvasBox, null)
  assert.ok(outerBox.height >= 620)
  assert.equal(innerBox.height, outerBox.height)
  assert.ok(canvasBox.width >= 700)
  assert.ok(canvasBox.height >= 330)

  const initialPixels = await appFrame.evaluate(() => globalThis.__THREE_M3__.pixelStats())
  assert.ok(initialPixels.lit > initialPixels.sampled * 0.08)
  assert.ok(initialPixels.colors > 20)

  await appFrame.getByRole('tab', { name: 'Script' }).click()
  const source = appFrame.getByRole('textbox', { name: 'Game script' })
  const brokenScript = `return {
  start() {},
  update() { throw new Error('human runtime failure') },
  dispose() {},
}`
  await source.fill(brokenScript)
  await source.press('Tab')
  await appFrame.waitForFunction(() => globalThis.__THREE_M3__.metrics().sync === 'dirty')
  assert.equal(await appFrame.getByRole('button', { name: 'Play' }).isDisabled(), true)

  await appFrame.getByRole('button', { name: 'Save', exact: true }).click()
  await appFrame.getByText('Saved', { exact: true }).waitFor({ timeout: 10_000 })
  const humanSaved = await appFrame.evaluate(() => globalThis.__THREE_M3__.metrics())
  assert.equal(humanSaved.scriptSource, brokenScript)

  externalClient = await connectExternalClient()
  await appFrame.getByRole('button', { name: 'Play' }).click()
  await appFrame.waitForFunction(() => (
    globalThis.__THREE_M3__.metrics().playState === 'error'
    && globalThis.__THREE_M3__.metrics().runtimeErrors.some(
      error => error.includes('human runtime failure'),
    )
  ))
  const failedCheck = await waitForCheck(check => (
    check.revision === humanSaved.revision
    && check.errors.some(error => error.includes('human runtime failure'))
  ))
  const diagnosticsPath = resolve(projectsRoot, 'm3-pong', 'diagnostics.json')
  assert.equal(existsSync(diagnosticsPath), true)

  await composer.fill('读取 m3-pong 最新保存版本和运行诊断，修复脚本并更新球的颜色')
  await composer.press('Enter')
  await page.getByText('I inspected the saved revision and fixed the runtime script.')
    .waitFor({ timeout: 30_000 })

  await appFrame.waitForFunction(previousRevision => {
    const metrics = globalThis.__THREE_M3__.metrics()
    return metrics.sync === 'clean'
      && metrics.revision !== previousRevision
      && metrics.scriptSource.includes('const speed = 1.8')
      && globalThis.__THREE_M3__.object('Ball').color === 'ff3366'
  }, humanSaved.revision)
  const aiLoaded = await appFrame.evaluate(() => globalThis.__THREE_M3__.metrics())
  assert.equal(
    await page.locator('iframe[title="MCP App: mcp__threejs__create_project"]').count(),
    1,
  )

  const ballBefore = await appFrame.evaluate(() => globalThis.__THREE_M3__.object('Ball').position[0])
  const paddleBefore = await appFrame.evaluate(
    () => globalThis.__THREE_M3__.object('Left Paddle').position[2],
  )
  await appFrame.getByRole('button', { name: 'Play' }).click()
  await appFrame.waitForFunction(startX => (
    globalThis.__THREE_M3__.metrics().playState === 'playing'
    && globalThis.__THREE_M3__.object('Ball').position[0] > startX + 0.15
  ), ballBefore)

  await canvas.focus()
  await page.keyboard.down('w')
  await appFrame.waitForFunction(startZ => (
    globalThis.__THREE_M3__.object('Left Paddle').position[2] < startZ - 0.15
  ), paddleBefore)
  await page.keyboard.up('w')
  const playCanvasBox = await canvas.boundingBox()
  assert.notEqual(playCanvasBox, null)
  await page.mouse.move(
    playCanvasBox.x + playCanvasBox.width / 2,
    playCanvasBox.y + playCanvasBox.height / 2,
  )
  await page.mouse.down()
  await appFrame.waitForFunction(() => (
    globalThis.__THREE_M3__.metrics().inputPointer.buttons.includes(0)
  ))
  const pointerInput = await appFrame.evaluate(
    () => globalThis.__THREE_M3__.metrics().inputPointer,
  )
  await page.mouse.up()
  assert.ok(Math.abs(pointerInput.x) < 0.02)
  assert.ok(Math.abs(pointerInput.y) < 0.02)
  const playing = await appFrame.evaluate(() => ({
    metrics: globalThis.__THREE_M3__.metrics(),
    ball: globalThis.__THREE_M3__.object('Ball'),
    paddle: globalThis.__THREE_M3__.object('Left Paddle'),
    pixels: globalThis.__THREE_M3__.pixelStats(),
  }))
  assert.deepEqual(playing.metrics.runtimeErrors, [])
  assert.ok(playing.pixels.lit > playing.pixels.sampled * 0.08)

  await appFrame.getByRole('button', { name: 'Stop' }).click()
  await appFrame.getByText('Stopped; diagnostics recorded', { exact: true })
    .waitFor({ timeout: 10_000 })
  const passedCheck = await waitForCheck(check => (
    check.revision === aiLoaded.revision
    && check.errors.length === 0
    && check.warnings.length === 0
    && check.testedRevision === aiLoaded.revision
  ))
  const stopped = await appFrame.evaluate(() => ({
    metrics: globalThis.__THREE_M3__.metrics(),
    ball: globalThis.__THREE_M3__.object('Ball'),
    paddle: globalThis.__THREE_M3__.object('Left Paddle'),
  }))
  assert.equal(stopped.ball.position[0], 0)
  assert.equal(stopped.paddle.position[2], 0)

  const projectPath = resolve(projectsRoot, 'm3-pong', 'project.json')
  const projectBytes = readFileSync(projectPath)
  const storedProject = JSON.parse(projectBytes)
  assert.equal(createHash('sha256').update(projectBytes).digest('hex'), aiLoaded.revision)
  assert.match(storedProject.script.source, /const speed = 1\.8/)
  assert.equal(
    storedProject.scene.materials.find(material => material.color === 0xff3366) !== undefined,
    true,
  )

  await page.screenshot({
    path: resolve(artifacts, 'm3-harness-ai-fix-play.png'),
    fullPage: true,
  })
  assert.deepEqual(appProblems, [])

  process.stdout.write(`${JSON.stringify({
    webUrl,
    catalog: publicToolNames,
    outer: outerBox,
    inner: innerBox,
    canvas: canvasBox,
    initialPixels,
    humanSaved: {
      revision: humanSaved.revision,
      runtimeErrors: failedCheck.structuredContent.errors,
      diagnosticsPath,
    },
    aiLoaded: {
      revision: aiLoaded.revision,
      scriptSource: aiLoaded.scriptSource,
      ballColor: playing.ball.color,
    },
    play: {
      ballX: playing.ball.position[0],
      paddleZ: playing.paddle.position[2],
      inputKeys: playing.metrics.inputKeys,
      pointerInput,
      pixels: playing.pixels,
    },
    stopped: {
      ballX: stopped.ball.position[0],
      paddleZ: stopped.paddle.position[2],
      diagnostics: passedCheck.structuredContent,
    },
    projectPath,
    appProblems,
  }, null, 2)}\n`)
} catch (error) {
  await page.screenshot({
    path: resolve(artifacts, 'm3-harness-ai-fix-play-failure.png'),
    fullPage: true,
  })
  throw error
} finally {
  await page.keyboard.up('w').catch(() => {})
  if (externalClient !== undefined) await externalClient.close()
  await browser.close()
}
