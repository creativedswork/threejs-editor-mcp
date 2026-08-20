import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const webUrl = process.env.DSH_WEB_URL
if (webUrl === undefined) throw new Error('DSH_WEB_URL is required')
const projectRoot = resolve(process.env.THREEJS_EDITOR_MCP_ROOT ?? '.')
const workspacePath = resolve(process.env.THREEJS_EDITOR_MCP_WORKSPACE ?? '.tmp/m7-p1-workspace')
const artifacts = resolve(projectRoot, 'artifacts')
mkdirSync(artifacts, { recursive: true })

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
})
const appProblems = []
let diagnosticAppFrame
page.on('console', message => {
  if (message.type() === 'error') appProblems.push(`console: ${message.text()}`)
})
page.on('pageerror', error => appProblems.push(`pageerror: ${error.message}`))

async function appSurface() {
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
      && metrics.playState === 'editing'
      && metrics.m7.active === true
      && metrics.m7.ready?.mode === 'edit'
  }, undefined, { timeout: 120_000 })
  await appFrame.getByRole('checkbox', { name: 'Livery' }).waitFor()
  return { outer, inner, appFrame }
}

async function runtimeSurface(appFrame) {
  const runtime = appFrame.locator('iframe[data-runtime-sandbox]')
  await runtime.waitFor({ state: 'visible', timeout: 120_000 })
  const runtimeHandle = await runtime.elementHandle()
  assert.notEqual(runtimeHandle, null)
  const runtimeFrame = await runtimeHandle.contentFrame()
  assert.notEqual(runtimeFrame, null)
  return { runtime, runtimeFrame }
}

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
  await page.goto(webUrl, { waitUntil: 'domcontentloaded' })

  const addWorkspace = page.getByRole('button', { name: '添加工作区', exact: true })
  try {
    await addWorkspace.click({ timeout: 30_000 })
  } catch {
    const continueButton = page.getByText('继续', { exact: true })
    await continueButton.waitFor({
      state: 'visible',
      timeout: 60_000,
    })
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
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })
    composer = page.getByRole('textbox', {
      name: /描述你想要构建的内容|给智能体发消息/,
    })
  }
  await composer.waitFor({ state: 'visible', timeout: 60_000 })
  await composer.fill('打开 M7 Formula One Race Car Workspace')
  await composer.press('Enter')
  await page.getByText('Three.js M7 Formula One Workspace opened.')
    .waitFor({ timeout: 30_000 })

  const { appFrame } = await appSurface()
  diagnosticAppFrame = appFrame
  const initial = await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics())
  assert.match(initial.projectId, /^workspace-[a-f0-9]{54}$/)
  assert.equal(initial.workspaceEntry, 'src/main.js')
  assert.equal(initial.workspaceBackend, 'webgpu')
  assert.equal(initial.m7.active, true)
  assert.equal(initial.playState, 'editing')
  assert.deepEqual(
    await appFrame.getByRole('combobox', { name: 'Runtime debug mode' })
      .locator('option').allTextContents(),
    ['final', 'topology', 'no-livery', 'projector', 'rolling'],
  )
  const livery = appFrame.getByRole('checkbox', { name: 'Livery' })
  assert.equal(await livery.isChecked(), false)

  await livery.check()
  await appFrame.waitForFunction(previous => {
    const metrics = globalThis.__THREE_M7__.metrics()
    return metrics.sync === 'clean'
      && metrics.revision !== previous
      && metrics.playState === 'editing'
      && metrics.m7.ready?.mode === 'edit'
  }, initial.revision, { timeout: 120_000 })
  const human = await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics())
  assert.equal(
    JSON.parse(readFileSync(resolve(workspacePath, 'src/parameters.json'), 'utf8')).livery,
    true,
  )
  assert.equal(
    await page.getByText('Three.js M7 Formula One Workspace opened.').count(),
    1,
  )

  const parameters = JSON.parse(
    readFileSync(resolve(workspacePath, 'src/parameters.json'), 'utf8'),
  )
  const ai = await callHarnessTool('apply_project_files', {
    projectId: initial.projectId,
    baseRevision: human.revision,
    changes: [{
      type: 'write',
      path: 'src/parameters.json',
      text: `${JSON.stringify({ ...parameters, bodyScale: 1.04 }, null, 2)}\n`,
    }],
  })
  assert.equal(ai.isError, undefined)
  await appFrame.waitForFunction(target => {
    const metrics = globalThis.__THREE_M7__.metrics()
    const input = document.querySelector('[aria-label="Body length"]')
    return metrics.sync === 'clean'
      && metrics.revision === target
      && input?.value === '1.04'
      && metrics.playState === 'editing'
      && metrics.m7.ready?.mode === 'edit'
  }, ai.structuredContent.revision, { timeout: 120_000 })

  await appFrame.getByRole('button', { name: 'Play', exact: true }).click()
  await appFrame.waitForFunction(() => {
    const metrics = globalThis.__THREE_M7__.metrics()
    return metrics.playState === 'playing'
      && metrics.m7.ready?.emittedParts === 62
      && metrics.m7.ready?.uniqueTriangles === 375964
  }, undefined, { timeout: 120_000 })
  const { runtime, runtimeFrame } = await runtimeSurface(appFrame)
  assert.equal(await runtime.getAttribute('sandbox'), 'allow-scripts')
  assert.equal(await runtimeFrame.evaluate(() => location.origin), 'null')
  const finalMetrics = await appFrame.evaluate(() => globalThis.__THREE_M7__.requestM7Metrics())
  assert.equal(finalMetrics.rendererCount, 1)
  assert.equal(finalMetrics.secureContext, true)
  assert.equal(finalMetrics.webgpuApi, true)
  assert.equal(finalMetrics.rendererBackend, 'WebGPUBackend')
  assert.equal(finalMetrics.emittedParts, 62)
  assert.equal(finalMetrics.uniqueTriangles, 375964)
  assert.equal(finalMetrics.hullRings, 168)
  assert.equal(finalMetrics.hullSegments, 96)
  assert.equal(finalMetrics.livery, true)
  assert.equal(finalMetrics.bodyScale, 1.04)
  const pixels = await pixelStats(runtimeFrame)
  assert.ok(pixels.lit > pixels.sampled * 0.2)
  assert.ok(pixels.colors > 100)
  assert.ok(pixels.contrast > pixels.sampled * 0.03)
  await page.screenshot({
    path: resolve(artifacts, 'm7-p1-final.png'),
    fullPage: false,
  })

  for (const mode of ['topology', 'no-livery']) {
    await appFrame.evaluate(value => globalThis.__THREE_M7__.setM7DebugMode(value), mode)
    await page.waitForTimeout(300)
    await page.screenshot({
      path: resolve(artifacts, `m7-p1-${mode}.png`),
      fullPage: false,
    })
  }
  await appFrame.evaluate(() => globalThis.__THREE_M7__.setM7DebugMode('final'))
  const firstRun = await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics().m7)
  await appFrame.getByRole('button', { name: 'Stop', exact: true }).click()
  await appFrame.waitForFunction(() => {
    const metrics = globalThis.__THREE_M7__.metrics()
    return metrics.m7.active === true
      && metrics.m7.runtimeFrameVisible === true
      && metrics.m7.metrics?.mode === 'edit'
      && metrics.playState === 'editing'
  })
  const stopped = await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics().m7)
  await page.waitForTimeout(300)
  const afterStop = await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics().m7)
  assert.ok(afterStop.metrics.frame >= stopped.metrics.frame)
  assert.equal(afterStop.messagesAfterStop, 0)

  await appFrame.getByRole('button', { name: 'Play', exact: true }).click()
  await appFrame.waitForFunction(() => {
    const metrics = globalThis.__THREE_M7__.metrics()
    return metrics.playState === 'playing'
      && metrics.m7.ready?.rendererCount === 1
      && metrics.m7.ready?.frame >= 1
  }, undefined, { timeout: 120_000 })
  const restarted = await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics().m7)
  assert.equal(restarted.ready.rendererCount, 1)
  assert.equal(restarted.build.buildId, firstRun.build.buildId)
  await appFrame.getByRole('button', { name: 'Stop', exact: true }).click()
  await appFrame.waitForFunction(() => (
    globalThis.__THREE_M7__.metrics().playState === 'editing'
  ))

  assert.deepEqual(appProblems, [])
  process.stdout.write(`${JSON.stringify({
    webUrl,
    transport: 'deterministic replay',
    projectId: initial.projectId,
    revisions: {
      initial: initial.revision,
      humanLivery: human.revision,
      aiGeometry: ai.structuredContent.revision,
    },
    buildId: firstRun.build.buildId,
    backend: firstRun.build.backend,
    metrics: finalMetrics,
    pixels,
    debugModes: ['final', 'topology', 'no-livery'],
    restart: {
      rendererCount: restarted.ready.rendererCount,
      cacheBuildId: restarted.build.buildId,
      messagesAfterStop: afterStop.messagesAfterStop,
    },
    appProblems,
  }, null, 2)}\n`)
} catch (error) {
  if (diagnosticAppFrame !== undefined) {
    const metrics = await diagnosticAppFrame
      .evaluate(() => globalThis.__THREE_M7__?.metrics())
      .catch(() => undefined)
    process.stderr.write(`M7 diagnostics:\n${JSON.stringify({
      metrics,
      appProblems,
    }, null, 2)}\n`)
  }
  await page.screenshot({
    path: resolve(artifacts, 'm7-p1-failure.png'),
    fullPage: true,
  })
  throw error
} finally {
  await browser.close()
}
