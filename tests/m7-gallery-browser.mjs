import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const webUrl = process.env.DSH_WEB_URL
if (webUrl === undefined) throw new Error('DSH_WEB_URL is required')
const projectRoot = resolve(process.env.THREEJS_EDITOR_MCP_ROOT ?? '.')
const workspacePath = resolve(process.env.THREEJS_EDITOR_MCP_WORKSPACE ?? '')
if (workspacePath === projectRoot) throw new Error('THREEJS_EDITOR_MCP_WORKSPACE is required')
const artifacts = resolve(projectRoot, 'artifacts')
mkdirSync(artifacts, { recursive: true })

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
})
const appProblems = []
page.on('console', message => {
  if (message.type() === 'error') appProblems.push(`console: ${message.text()}`)
})
page.on('pageerror', error => appProblems.push(`pageerror: ${error.message}`))

async function pixelStats(runtimeFrame) {
  return runtimeFrame.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(resolve))
    const canvas = document.querySelector('canvas')
    const sample = document.createElement('canvas')
    sample.width = 240
    sample.height = 150
    const context = sample.getContext('2d', { willReadFrequently: true })
    context.drawImage(canvas, 0, 0, sample.width, sample.height)
    const pixels = context.getImageData(0, 0, sample.width, sample.height).data
    const colors = new Set()
    let lit = 0
    let contrast = 0
    for (let index = 0; index < pixels.length; index += 16) {
      const red = pixels[index] ?? 0
      const green = pixels[index + 1] ?? 0
      const blue = pixels[index + 2] ?? 0
      const maximum = Math.max(red, green, blue)
      const minimum = Math.min(red, green, blue)
      if (red + green + blue > 60) lit += 1
      if (maximum - minimum > 12) contrast += 1
      colors.add((red << 16) | (green << 8) | blue)
    }
    return {
      width: canvas.width,
      height: canvas.height,
      sampled: pixels.length / 16,
      lit,
      contrast,
      colors: colors.size,
    }
  })
}

async function callHarnessTool(name, arguments_) {
  const catalogResponse = await fetch(`${webUrl}/api/mcp-apps/catalog`)
  assert.equal(catalogResponse.status, 200)
  const catalog = await catalogResponse.json()
  const editor = catalog.items.find(
    item => item.publicToolName === 'mcp__threejs__open_editor',
  )
  assert.notEqual(editor, undefined)
  const response = await fetch(`${webUrl}/api/mcp-apps/tool`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      viewId: editor.viewId,
      name,
      arguments: arguments_,
    }),
  })
  const result = await response.json()
  assert.equal(response.status, 200, JSON.stringify(result))
  return result
}

try {
  await page.goto(webUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  })
  const addWorkspace = page.getByRole('button', { name: '添加工作区', exact: true })
  try {
    await addWorkspace.click({ timeout: 30_000 })
  } catch {
    const continueButton = page.getByText('继续', { exact: true })
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

  let composer = page.getByRole('textbox', {
    name: /描述你想要构建的内容|给智能体发消息/,
  })
  if (!await composer.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await page.reload({
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    composer = page.getByRole('textbox', {
      name: /描述你想要构建的内容|给智能体发消息/,
    })
  }
  try {
    await composer.waitFor({ state: 'visible', timeout: 60_000 })
  } catch (error) {
    await page.screenshot({
      path: resolve(artifacts, 'm7-gallery-composer-timeout.png'),
      fullPage: false,
    })
    throw new Error(
      `Composer did not appear after workspace selection:\n${
        (await page.locator('body').innerText()).slice(0, 4_000)
      }`,
      { cause: error },
    )
  }
  await composer.fill('列出当前threejs工程有哪些')
  await composer.press('Enter')
  await page.getByText('当前 DSH Workspace 已通过 Three.js MCP 列出 37 个图形/特效演示工程。')
    .waitFor({ timeout: 30_000 })

  await composer.fill('打开这个 threejs-procedural-geometry/formula-one-race-car')
  await composer.press('Enter')
  await page.getByText('已通过 Three.js MCP App 打开 Formula One Race Car。')
    .waitFor({ timeout: 30_000 })

  const outer = page.locator('iframe[title="MCP App: mcp__threejs__open_editor"]').last()
  await outer.waitFor({ state: 'visible', timeout: 30_000 })
  const outerFrame = await (await outer.elementHandle()).contentFrame()
  assert.notEqual(outerFrame, null)
  const inner = outerFrame.locator('iframe')
  await inner.waitFor({ state: 'visible', timeout: 15_000 })
  const appFrame = await (await inner.elementHandle()).contentFrame()
  assert.notEqual(appFrame, null)
  await appFrame.locator('[data-three-editor]').waitFor({ state: 'visible', timeout: 15_000 })
  await appFrame.waitForFunction(() => {
    const metrics = globalThis.__THREE_M7__?.metrics()
    return metrics?.frame > 10
      && metrics.sync === 'clean'
      && metrics.workspaceBackend === 'webgpu'
  })
  const opened = await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics())
  assert.match(opened.projectId, /^example-[a-f0-9]{56}$/)
  assert.equal(
    opened.workspaceEntry,
    'dev/example-gallery/examples/threejs-procedural-geometry/formula-one-race-car/scene.js',
  )
  assert.equal(opened.workspaceBackend, 'webgpu')

  await appFrame.waitForFunction(() => {
    const metrics = globalThis.__THREE_M7__.metrics()
    return metrics.playState === 'editing'
      && metrics.m7.ready?.mode === 'edit'
      && metrics.m7.ready?.emittedParts === 62
      && metrics.m7.ready?.uniqueTriangles === 375964
  }, undefined, { timeout: 120_000 })
  const runtime = appFrame.locator('iframe[data-runtime-sandbox]')
  await runtime.waitFor({ state: 'visible', timeout: 120_000 })
  const runtimeFrame = await (await runtime.elementHandle()).contentFrame()
  assert.notEqual(runtimeFrame, null)
  const editPixels = await pixelStats(runtimeFrame)
  assert.ok(editPixels.lit > editPixels.sampled * 0.7)
  assert.ok(editPixels.colors > 600)
  assert.ok(editPixels.contrast > 100)
  const runtimeCanvas = runtimeFrame.locator('canvas')
  const canvasBox = await runtimeCanvas.boundingBox()
  assert.notEqual(canvasBox, null)
  const runtimeIdentity = await runtimeFrame.evaluate(() => {
    globalThis.__M7_RUNTIME_IDENTITY__ = crypto.randomUUID()
    let topPointerDowns = 0
    document.querySelector('canvas').addEventListener('pointerdown', event => {
      if (event.clientY <= 32) topPointerDowns += 1
    })
    globalThis.__M7_TOP_POINTER_DOWNS__ = () => topPointerDowns
    return globalThis.__M7_RUNTIME_IDENTITY__
  })
  await runtimeCanvas.click({
    position: {
      x: canvasBox.width * 0.5,
      y: 20,
    },
  })
  assert.equal(
    await runtimeFrame.evaluate(() => globalThis.__M7_TOP_POINTER_DOWNS__()),
    1,
  )
  let cycledSelection = false
  for (const [xRatio, yRatio] of [[0.5, 0.55], [0.62, 0.5], [0.4, 0.6]]) {
    const position = {
      x: canvasBox.width * xRatio,
      y: canvasBox.height * yRatio,
    }
    await runtimeCanvas.click({ position })
    await page.waitForTimeout(50)
    const first = await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics().selectedUuid)
    await runtimeCanvas.click({ position })
    await page.waitForTimeout(50)
    const second = await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics().selectedUuid)
    if (typeof first === 'string' && typeof second === 'string' && first !== second) {
      cycledSelection = true
      break
    }
  }
  assert.equal(cycledSelection, true)
  const sceneSearch = appFrame.getByRole('searchbox', { name: 'Search scene objects' })
  await sceneSearch.fill('helmet')
  const helmet = appFrame.getByRole('button', { name: 'helmet', exact: true })
  await helmet.waitFor({ state: 'visible' })
  await helmet.click()
  await appFrame.getByRole('button', { name: 'Reveal selected object' }).click()
  assert.equal(await sceneSearch.inputValue(), '')
  const car = appFrame.getByRole('button', { name: 'VF-26', exact: true })
  await car.waitFor({ state: 'visible' })
  await car.click()
  const positionX = appFrame.getByRole('spinbutton', { name: 'Position X' })
  assert.equal(Number(await positionX.inputValue()), 0)
  const beforeRevision = opened.revision
  const runtimeHandleBeforeSave = await runtime.elementHandle()
  await positionX.fill('0.25')
  await positionX.press('Enter')
  await appFrame.getByRole('button', { name: 'Save' }).click()
  await appFrame.waitForFunction(previous => {
    const metrics = globalThis.__THREE_M7__.metrics()
    return metrics.sync === 'clean'
      && metrics.playState === 'editing'
      && metrics.revision !== previous
  }, beforeRevision, { timeout: 120_000 })
  const edited = await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics())
  assert.equal(await runtimeHandleBeforeSave.evaluate(node => node.isConnected), true)
  assert.equal(await runtimeFrame.evaluate(() => document.visibilityState), 'visible')
  const savedPixels = await pixelStats(runtimeFrame)
  assert.ok(savedPixels.lit > savedPixels.sampled * 0.7)
  assert.ok(savedPixels.colors > 600)
  await appFrame.getByRole('button', { name: 'VF-26', exact: true }).click()
  assert.equal(Number(await positionX.inputValue()), 0.25)
  const carUuid = await appFrame.getByRole('button', {
    name: 'VF-26',
    exact: true,
  }).getAttribute('data-object-uuid')
  assert.match(carUuid, /^[a-f0-9-]{36}$/)
  const inspected = await callHarnessTool('inspect_editor', {
    projectId: opened.projectId,
  })
  assert.equal(
    inspected.structuredContent.objects.find(object => object.name === 'VF-26').uuid,
    carUuid,
  )
  assert.deepEqual(
    inspected.structuredContent.editorChanges.find(
      change => change.objectName === 'VF-26',
    ),
    {
      source: 'human',
      type: 'set_position',
      objectUuid: carUuid,
      objectName: 'VF-26',
      objectPath: 'scene/VF-26#0',
      value: [0.25, 0, 0],
    },
  )

  const ai = await callHarnessTool('apply_editor_commands', {
    projectId: opened.projectId,
    baseRevision: edited.revision,
    operations: [{
      type: 'set_position',
      objectUuid: carUuid,
      value: [0, 0, 0],
    }],
  })
  assert.equal(ai.isError, undefined)
  await appFrame.waitForFunction(nextRevision => {
    const metrics = globalThis.__THREE_M7__.metrics()
    return metrics.sync === 'clean'
      && metrics.playState === 'editing'
      && metrics.revision === nextRevision
  }, ai.structuredContent.revision, { timeout: 120_000 })
  const runtimeAfterAi = await (await runtime.elementHandle()).contentFrame()
  assert.notEqual(runtimeAfterAi, null)
  assert.equal(
    await runtimeAfterAi.evaluate(() => globalThis.__M7_RUNTIME_IDENTITY__),
    runtimeIdentity,
  )
  const aiPixels = await pixelStats(runtimeAfterAi)
  assert.ok(aiPixels.lit > aiPixels.sampled * 0.7)
  assert.ok(aiPixels.colors > 600)
  await appFrame.getByRole('button', { name: 'VF-26', exact: true }).click()
  assert.equal(Number(await positionX.inputValue()), 0)

  await page.getByTitle('Open mcp__threejs__open_editor fullscreen').click()
  await page.locator('[data-mcp-app-view][data-display-mode="fullscreen"]').waitFor()
  await appFrame.waitForFunction(() => (
    globalThis.__THREE_M7__.metrics().displayMode === 'fullscreen'
  ))
  const fullscreenPixels = await pixelStats(runtimeAfterAi)
  assert.ok(fullscreenPixels.lit > fullscreenPixels.sampled * 0.7)
  assert.ok(fullscreenPixels.colors > 600)

  await appFrame.getByRole('button', { name: 'Play', exact: true }).click()
  await appFrame.waitForFunction(() => {
    const metrics = globalThis.__THREE_M7__.metrics()
    return metrics.playState === 'playing'
      && metrics.m7.metrics?.mode === 'run'
  }, undefined, { timeout: 120_000 })
  let metrics = await appFrame.evaluate(() => globalThis.__THREE_M7__.requestM7Metrics())
  assert.equal(metrics.rendererBackend, 'WebGPUBackend')
  assert.equal(metrics.mode, 'run')
  assert.equal(metrics.emittedParts, 62)
  assert.equal(metrics.uniqueTriangles, 375964)
  await appFrame.getByRole('button', { name: 'Stop', exact: true }).click()
  await appFrame.waitForFunction(() => (
    globalThis.__THREE_M7__.metrics().playState === 'editing'
  ))
  metrics = await appFrame.evaluate(() => globalThis.__THREE_M7__.requestM7Metrics())
  assert.equal(metrics.mode, 'edit')
  await appFrame.getByRole('button', { name: 'VF-26', exact: true }).click()
  assert.equal(Number(await positionX.inputValue()), 0)
  assert.equal(await runtimeFrame.evaluate(() => location.origin), 'null')

  const conversation = await page.locator('body').innerText()
  assert.doesNotMatch(conversation, /npm install|example-gallery server|打开 HTML/i)
  await page.screenshot({
    path: resolve(artifacts, 'm7-gallery-direct-open.png'),
    fullPage: false,
  })
  assert.deepEqual(appProblems, [])
  process.stdout.write(`${JSON.stringify({
    webUrl,
    transport: 'deterministic replay',
    prompts: [
      '列出当前threejs工程有哪些',
      '打开这个 threejs-procedural-geometry/formula-one-race-car',
    ],
    projectId: opened.projectId,
    entry: opened.workspaceEntry,
    backend: opened.workspaceBackend,
    editPixels,
    savedPixels,
    cycledSelection,
    editorObject: 'VF-26',
    humanPositionX: 0.25,
    humanRevision: edited.revision,
    aiPositionX: 0,
    aiRevision: ai.structuredContent.revision,
    aiPixels,
    fullscreenPixels,
    runtimePreservedAcrossAiEdit: true,
    topCanvasPointerReachable: true,
    rendererBackend: metrics.rendererBackend,
    emittedParts: metrics.emittedParts,
    uniqueTriangles: metrics.uniqueTriangles,
    appProblems,
  }, null, 2)}\n`)
} finally {
  await browser.close()
}
