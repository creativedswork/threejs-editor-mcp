import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, realpathSync, watch } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const webUrl = process.env.DSH_WEB_URL
if (webUrl === undefined) throw new Error('DSH_WEB_URL is required')
const projectRoot = resolve(process.env.THREEJS_EDITOR_MCP_ROOT ?? '.')
const workspacePath = resolve(process.env.THREEJS_EDITOR_MCP_WORKSPACE ?? '.tmp/m7-p1-workspace')
const workspaceRealPath = realpathSync(workspacePath)
const dshHome = resolve(process.env.DSH_HOME ?? '.tmp/m7-dsh-home')
const runtimeReplacementTimeout = 300_000
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
  if (message.type() !== 'error') return
  const text = message.text()
  const source = message.location().url
  if (/http:\/\/127\.0\.0\.1:777[78]\//u.test(source)
    || /http:\/\/127\.0\.0\.1:777[78]\//u.test(text)) {
    return
  }
  appProblems.push(`console: ${text}`)
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
  diagnosticAppFrame = appFrame
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

async function waitForLatestTurn() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const workspaceStore = JSON.parse(
      readFileSync(resolve(dshHome, 'storages/workspace.json'), 'utf8'),
    )
    const workspace = Object.values(workspaceStore.tables?.workspaces ?? {})
      .find(item => realpathSync(item.path) === workspaceRealPath)
    const sessionId = workspace?.sessionIds?.[0]
    const sessionStore = JSON.parse(
      readFileSync(resolve(dshHome, 'storages/session_projcache.json'), 'utf8'),
    )
    const stats = sessionStore.tables?.sessions?.[sessionId]?.rows?.sessionStats?.val
    if (stats?.lastTurn >= 1 && stats.openStep === null) return
    await new Promise(resolve_ => setTimeout(resolve_, 100))
  }
  throw new Error('Replay turn did not settle within 30000 ms')
}

try {
  const workspaceResponse = await fetch(`${webUrl}/api/workspace.create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'm7-workspace-create',
      method: 'workspace.create',
      payload: { path: workspaceRealPath },
    }),
  })
  const workspaceBody = await workspaceResponse.json()
  assert.equal(workspaceResponse.status, 200, JSON.stringify(workspaceBody))
  assert.equal(workspaceBody.result?.ok, true, JSON.stringify(workspaceBody))

  await page.goto(webUrl, { waitUntil: 'domcontentloaded' })

  const continueButton = page.getByText('继续', { exact: true })
  const composer = page.getByRole('textbox', {
    name: /描述你想要构建的内容|给智能体发消息/,
  })
  const composerDeadline = Date.now() + 120_000
  let composerReady = false
  while (Date.now() < composerDeadline) {
    if (await continueButton.isVisible()) {
      const settingsPath = resolve(dshHome, 'settings.yaml')
      const acknowledgement = new Promise((resolve_, reject) => {
        const watcher = watch(dshHome, () => {
          try {
            if (!readFileSync(settingsPath, 'utf8')
              .includes('welcomeNoticeVersion: 2026-08-13.1')) return
            clearTimeout(timeout)
            watcher.close()
            resolve_()
          } catch {}
        })
        const timeout = setTimeout(() => {
          watcher.close()
          reject(new Error('Welcome acknowledgement did not persist within 60000 ms'))
        }, 60_000)
        watcher.once('error', reject)
      })
      await continueButton.click()
      await acknowledgement
      const detached = await continueButton.waitFor({ state: 'detached', timeout: 5_000 })
        .then(() => true, () => false)
      if (!detached) await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })
      continue
    }
    if (await composer.isVisible()
      && await composer.click({ trial: true, timeout: 500 })
        .then(() => true, () => false)) {
      composerReady = true
      break
    }
    await page.waitForTimeout(100)
  }
  if (!composerReady) {
    throw new Error('Composer did not become clickable within 120000 ms')
  }
  appProblems.length = 0
  await composer.fill('打开 M7 Formula One Race Car Workspace')
  await composer.press('Enter')
  await waitForLatestTurn()

  const { appFrame } = await appSurface()
  diagnosticAppFrame = appFrame
  const initial = await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics())
  assert.match(initial.projectId, /^workspace-[a-f0-9]{54}$/)
  assert.equal(initial.workspaceEntry, 'src/main.js')
  assert.equal(initial.workspaceBackend, 'webgpu')
  assert.equal(initial.m7.active, true)
  assert.equal(initial.playState, 'editing')
  const livery = appFrame.getByRole('checkbox', { name: 'Livery' })
  assert.equal(await livery.isChecked(), false)

  await livery.check()
  await appFrame.waitForFunction(previous => {
    const metrics = globalThis.__THREE_M7__.metrics()
    return metrics.sync === 'clean'
      && metrics.revision !== previous
      && metrics.playState === 'editing'
      && metrics.m7.ready?.mode === 'edit'
  }, initial.revision, { timeout: runtimeReplacementTimeout })
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
  }, ai.structuredContent.revision, { timeout: runtimeReplacementTimeout })

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
  }, undefined, { timeout: runtimeReplacementTimeout })
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
  await appFrame.evaluate(() => {
    const objectButton = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === 'VF-26')
    if (!(objectButton instanceof HTMLButtonElement)) {
      throw new Error('VF-26 hierarchy button was not found')
    }
    objectButton.click()
    const positionX = document.querySelector('[aria-label="Position X"]')
    if (!(positionX instanceof HTMLInputElement)) {
      throw new Error('Position X input was not found')
    }
  })

  let delayedModelContext
  let signalDelayedModelContext = () => {}
  let releaseModelContext = () => {}
  let signalSaveRaceStarted = () => {}
  const modelContextDelayed = new Promise(resolve => {
    signalDelayedModelContext = resolve
  })
  const modelContextRelease = new Promise(resolve => {
    releaseModelContext = resolve
  })
  const saveRaceStarted = new Promise(resolve => {
    signalSaveRaceStarted = resolve
  })
  await page.exposeFunction('__m0SaveStarted', () => {
    signalSaveRaceStarted()
    releaseModelContext()
  })
  const delayModelContextResponse = async route => {
    if (delayedModelContext !== undefined) {
      await route.continue()
      return
    }
    const response = await route.fetch()
    delayedModelContext = {
      request: route.request().postDataJSON(),
      status: response.status(),
    }
    signalDelayedModelContext()
    await modelContextRelease
    await route.fulfill({ response })
  }
  await page.route('**/api/mcp-apps/model-context', delayModelContextResponse)
  const revisionBeforeOverlap = await appFrame.evaluate(
    () => globalThis.__THREE_M7__.metrics().revision,
  )
  await appFrame.evaluate(previousRunId => {
    const timer = window.setInterval(() => {
      const metrics = globalThis.__THREE_M7__.metrics()
      if (metrics.playState !== 'editing'
        || metrics.m7.lifecyclePending !== false
        || metrics.m7.runId === previousRunId
        || !metrics.m7.eventTypes.includes('editor-scene')) return
      window.clearInterval(timer)
      try {
        const editingWhileLifecyclePending = metrics
        const positionX = document.querySelector('[aria-label="Position X"]')
        if (!(positionX instanceof HTMLInputElement)) {
          throw new Error('Position X input was not found')
        }
        positionX.value = '0.35'
        positionX.dispatchEvent(new Event('input', { bubbles: true }))
        positionX.dispatchEvent(new Event('change', { bubbles: true }))
        const dirtyWhileLifecyclePending = globalThis.__THREE_M7__.metrics()
        const saveButton = [...document.querySelectorAll('button')]
          .find(button => button.textContent?.trim() === 'Save')
        if (!(saveButton instanceof HTMLButtonElement)) {
          throw new Error('Save button was not found')
        }
        saveButton.click()
        globalThis.__M0_IMMEDIATE_SAVE_RACE__ = {
          editingWhileLifecyclePending,
          dirtyWhileLifecyclePending,
          saveStartedWhileLifecyclePending: globalThis.__THREE_M7__.metrics(),
        }
      } catch (error) {
        globalThis.__M0_IMMEDIATE_SAVE_RACE__ = {
          error: error instanceof Error ? error.message : String(error),
        }
      }
      void globalThis.__m0SaveStarted()
    }, 10)
  }, restarted.runId)
  await appFrame.getByRole('button', { name: 'Stop', exact: true }).click()
  let overlap
  try {
    await Promise.all([
      Promise.race([
        modelContextDelayed,
        page.waitForTimeout(runtimeReplacementTimeout).then(() => {
          throw new Error('Stop did not publish Runtime model context')
        }),
      ]),
      Promise.race([
        saveRaceStarted,
        page.waitForTimeout(runtimeReplacementTimeout).then(() => {
          throw new Error('Immediate Save race did not start')
        }),
      ]),
    ])
    overlap = await appFrame.evaluate(() => globalThis.__M0_IMMEDIATE_SAVE_RACE__)
    if (typeof overlap?.error === 'string') throw new Error(overlap.error)
  } finally {
    releaseModelContext()
  }
  const {
    editingWhileLifecyclePending,
    dirtyWhileLifecyclePending,
    saveStartedWhileLifecyclePending,
  } = overlap
  assert.equal(delayedModelContext.status, 200)
  assert.equal(
    delayedModelContext.request.structuredContent.runtime.runId,
    editingWhileLifecyclePending.m7.runId,
  )
  const overlapPositionX = appFrame.getByRole('spinbutton', { name: 'Position X' })
  assert.equal(dirtyWhileLifecyclePending.playState, 'editing')
  assert.equal(dirtyWhileLifecyclePending.m7.lifecyclePending, false)
  assert.equal(dirtyWhileLifecyclePending.sync, 'dirty')
  assert.equal(saveStartedWhileLifecyclePending.playState, 'editing')
  assert.equal(saveStartedWhileLifecyclePending.m7.lifecyclePending, true)
  assert.equal(saveStartedWhileLifecyclePending.sync, 'saving')
  await appFrame.waitForFunction(previousRevision => {
    const metrics = globalThis.__THREE_M7__.metrics()
    return metrics.playState === 'editing'
      && metrics.m7.lifecyclePending === false
      && metrics.sync === 'clean'
      && metrics.revision !== previousRevision
  }, revisionBeforeOverlap, { timeout: 120_000 })
  await page.unroute('**/api/mcp-apps/model-context', delayModelContextResponse)
  const immediateSaveOutcome = await appFrame.evaluate(
    () => globalThis.__THREE_M7__.metrics(),
  )
  assert.equal(Number(await overlapPositionX.inputValue()), 0.35)
  assert.equal(immediateSaveOutcome.m7.runId, editingWhileLifecyclePending.m7.runId)

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
    immediateSaveRace: {
      delayedModelContextStatus: delayedModelContext.status,
      editingWhileLifecyclePending: {
        playState: editingWhileLifecyclePending.playState,
        lifecyclePending: editingWhileLifecyclePending.m7.lifecyclePending,
      },
      saveStartedWhileLifecyclePending: {
        sync: saveStartedWhileLifecyclePending.sync,
        lifecyclePending: saveStartedWhileLifecyclePending.m7.lifecyclePending,
      },
      outcome: {
        sync: immediateSaveOutcome.sync,
        playState: immediateSaveOutcome.playState,
        lifecyclePending: immediateSaveOutcome.m7.lifecyclePending,
        revisionChanged: immediateSaveOutcome.revision !== revisionBeforeOverlap,
        positionX: Number(await overlapPositionX.inputValue()),
      },
    },
    appProblems,
  }, null, 2)}\n`)
} catch (error) {
  if (diagnosticAppFrame !== undefined) {
    const diagnostics = await diagnosticAppFrame
      .evaluate(() => ({
        metrics: globalThis.__THREE_M7__?.metrics(),
        status: document.querySelector('[data-status]')?.textContent,
      }))
      .catch(() => undefined)
    const runtimeTrace = await (async () => {
      const runtime = diagnosticAppFrame.locator('iframe[data-runtime-sandbox]')
      const runtimeHandle = await runtime.elementHandle()
      const runtimeFrame = await runtimeHandle?.contentFrame()
      return runtimeFrame?.evaluate(() => globalThis.__THREE_M7_RUNTIME_TRACE__)
    })().catch(() => undefined)
    process.stderr.write(`M7 diagnostics:\n${JSON.stringify({
      ...diagnostics,
      runtimeTrace,
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
