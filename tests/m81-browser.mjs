import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { chromium } from 'playwright'

const webUrl = process.env.DSH_WEB_URL
if (webUrl === undefined) throw new Error('DSH_WEB_URL is required')
const workspacePath = resolve(process.env.THREEJS_EDITOR_MCP_WORKSPACE ?? '')
const projectRoot = resolve(process.env.THREEJS_EDITOR_MCP_ROOT ?? '.')
const projectsPath = resolve(process.env.THREEJS_EDITOR_MCP_PROJECTS ?? '')
const framesPath = resolve(process.env.M81_GIF_FRAMES ?? '')
if (workspacePath === projectRoot) throw new Error('THREEJS_EDITOR_MCP_WORKSPACE is required')
if (projectsPath === projectRoot) throw new Error('THREEJS_EDITOR_MCP_PROJECTS is required')
if (framesPath === projectRoot) throw new Error('M81_GIF_FRAMES is required')
mkdirSync(framesPath, { recursive: true })

const deviceScaleFactor = Number(process.env.M81_DPR ?? 1.25)
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM_PATH === undefined
    ? { channel: 'chrome' }
    : { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }),
  headless: true,
  args: [
    `--force-device-scale-factor=${String(deviceScaleFactor)}`,
    '--disable-software-rasterizer',
    ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []),
  ],
})
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor,
  locale: 'zh-CN',
})
const startedAt = Date.now()
let mainFrameNavigations = 0
const browserProblems = []
const startupTimeout = Number(process.env.M81_START_TIMEOUT ?? 120_000)
const revisionCount = Number(process.env.M81_REVISION_COUNT ?? 20)
const revisionTimeout = Number(process.env.M81_REVISION_TIMEOUT ?? 120_000)
const layeringFocus = process.env.M81_LAYERING_FOCUS === '1'
const isolationFocus = process.env.M81_ISOLATION_FOCUS === '1'
page.on('framenavigated', frame => {
  if (frame === page.mainFrame()) mainFrameNavigations += 1
})
page.on('console', message => {
  if (message.type() === 'error' || message.type() === 'warning') {
    browserProblems.push(`${message.type()}: ${message.text()}`)
  }
})

async function rpc(method, payload) {
  const response = await fetch(`${webUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `m81-${method}-${Date.now()}`,
      method,
      payload,
    }),
  })
  const body = await response.json()
  assert.equal(response.ok, true, JSON.stringify(body))
  assert.equal(body.result?.ok, true, JSON.stringify(body))
  return body.result.value
}

function historyMessage(item) {
  return item.event.data.message ?? item.event.data
}

async function addWorkspace() {
  const add = page.getByRole('button', { name: '添加工作区', exact: true })
  try {
    await add.click({ timeout: 30_000 })
  } catch {
    const continueButton = page.getByText('继续', { exact: true })
    await continueButton.waitFor({ state: 'visible', timeout: 60_000 })
    await continueButton.click()
    await continueButton.waitFor({ state: 'hidden' })
    await add.click({ timeout: 30_000 })
  }
  await page.getByRole('button', { name: '编辑路径', exact: true }).click()
  const pathInput = page.getByRole('textbox', { name: '编辑路径', exact: true })
  await pathInput.fill(workspacePath)
  await pathInput.press('Enter')
  await page.getByRole('button', { name: '打开', exact: true }).click()
}

async function sendPrompt(text) {
  const composer = page.locator('textarea:enabled[placeholder="描述你想要构建的内容"]')
  await composer.waitFor({ state: 'visible', timeout: 30_000 })
  await composer.fill(text)
  await composer.press('Enter')
}

async function sessionId() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const listed = await rpc('session.list', {})
    const sessions = listed.items
      .filter(item => !item.blank && item.updatedAt >= startedAt)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0]
    if (sessions !== undefined) {
      const concurrent = listed.items.filter(
        item => !item.blank && item.updatedAt >= startedAt,
      )
      assert.equal(concurrent.length, 1, 'fresh-profile run observed multiple sessions')
      return sessions.sessionId
    }
    await page.waitForTimeout(100)
  }
  throw new Error('M8.1 Session was not observed')
}

async function editorFrame(expectedSync = 'clean') {
  const outer = page.locator('iframe[title="MCP App: mcp__threejs__open_editor"]')
  await outer.waitFor({ state: 'visible', timeout: 60_000 })
  const outerFrame = await (await outer.elementHandle()).contentFrame()
  assert.notEqual(outerFrame, null)
  const inner = outerFrame.locator('iframe')
  await inner.waitFor({ state: 'attached', timeout: 30_000 })
  const appFrame = await (await inner.elementHandle()).contentFrame()
  assert.notEqual(appFrame, null)
  try {
    await appFrame.waitForFunction(sync => {
      const metrics = globalThis.__THREE_M7__?.metrics()
      return metrics?.sync === sync
        && metrics?.m7?.active === true
        && metrics?.m7?.nonce !== undefined
    }, expectedSync, { timeout: startupTimeout })
  } catch (error) {
    const metrics = await appFrame.evaluate(() => globalThis.__THREE_M7__?.metrics())
    throw new Error(`Editor Runtime did not start: ${JSON.stringify({
      metrics,
      browserProblems: browserProblems.slice(-30),
    })}`, { cause: error })
  }
  return appFrame
}

async function editorFrameForProject(projectId, expectedSync) {
  const deadline = Date.now() + startupTimeout
  let observed
  while (Date.now() < deadline) {
    const frames = page.locator('iframe[title="MCP App: mcp__threejs__open_editor"]')
    for (let index = 0; index < await frames.count(); index += 1) {
      const outerFrame = await (await frames.nth(index).elementHandle()).contentFrame()
      const inner = outerFrame?.locator('iframe')
      if (inner === undefined || await inner.count() === 0) continue
      const appFrame = await (await inner.elementHandle()).contentFrame()
      if (appFrame === null) continue
      const metrics = await appFrame.evaluate(() => globalThis.__THREE_M7__?.metrics())
        .catch(() => undefined)
      if (metrics?.projectId !== projectId) continue
      observed = metrics
      if (metrics.sync === expectedSync
        && metrics.m7?.active === true
        && metrics.m7?.nonce !== undefined) return appFrame
    }
    await page.waitForTimeout(100)
  }
  throw new Error(`Editor ${projectId} did not reach ${expectedSync}: ${JSON.stringify({
    metrics: observed,
    browserProblems: browserProblems.slice(-30),
  })}`)
}

async function secondEditorFrame(projectId) {
  const deadline = Date.now() + startupTimeout
  while (Date.now() < deadline) {
    const frames = page.locator('iframe[title="MCP App: mcp__threejs__open_editor"]')
    for (let index = 0; index < await frames.count(); index += 1) {
      const outerFrame = await (await frames.nth(index).elementHandle()).contentFrame()
      const inner = outerFrame?.locator('iframe')
      if (inner === undefined || await inner.count() === 0) continue
      const appFrame = await (await inner.elementHandle()).contentFrame()
      if (appFrame === null) continue
      const metrics = await appFrame.evaluate(() => globalThis.__THREE_M7__?.metrics())
        .catch(() => undefined)
      if (typeof metrics?.projectId === 'string' && metrics.projectId !== projectId) {
        await appFrame.waitForFunction(() => {
          const current = globalThis.__THREE_M7__?.metrics()
          return current?.sync === 'clean'
            && current?.m7?.active === true
            && current?.m7?.nonce !== undefined
        }, undefined, { timeout: startupTimeout })
        return {
          appFrame,
          metrics: await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics()),
        }
      }
    }
    await page.waitForTimeout(100)
  }
  throw new Error('Second Editor card was not observed')
}

async function locateEditor(callId, appFrame, projectId) {
  const sandboxFrame = appFrame.parentFrame()
  assert.notEqual(sandboxFrame, null)
  const outerFrame = await sandboxFrame.frameElement()
  await page.getByRole('button', { name: 'MCP App actions' }).click()
  const item = page.locator(`[data-mcp-app-menu-item="${callId}"]`)
  await item.getByRole('menuitem', { name: 'Locate', exact: true }).click()
  const anchor = page.locator(`[data-chat-anchor-key="call:${callId}"]`)
  const deadline = Date.now() + 30_000
  let observed
  let markerObserved = false
  while (Date.now() < deadline) {
    try {
      const view = anchor.locator('[data-mcp-app-view]')
      const host = view.locator('[data-mcp-app-frame-host]')
      const [anchorCount, viewCount, hostCount] = await Promise.all([
        anchor.count(),
        view.count(),
        host.count(),
      ])
      if (anchorCount === 1 && viewCount === 1 && hostCount === 1) {
        const [framePlacement, hostPlacement, runtime] = await Promise.all([
          outerFrame.evaluate(frame => {
            const bounds = frame.getBoundingClientRect()
            return {
              connected: frame.isConnected,
              left: bounds.left,
              top: bounds.top,
              width: bounds.width,
              height: bounds.height,
              opacity: frame.style.opacity,
              pointerEvents: frame.style.pointerEvents,
            }
          }),
          host.evaluate(element => {
            const bounds = element.getBoundingClientRect()
            const scrollport = element.closest('[data-conversation-scroll]')
              ?.getBoundingClientRect()
            return {
              left: bounds.left,
              top: bounds.top,
              width: bounds.width,
              height: bounds.height,
              inScrollport: scrollport !== undefined
                && bounds.bottom > scrollport.top
                && bounds.top < scrollport.bottom,
            }
          }),
          appFrame.evaluate(() => globalThis.__THREE_M7__.metrics()),
        ])
        markerObserved ||= await view.getAttribute('data-mcp-app-located') === 'true'
        observed = { framePlacement, hostPlacement, runtime, markerObserved }
        const aligned = Math.abs(framePlacement.left - hostPlacement.left) <= 1
          && Math.abs(framePlacement.top - hostPlacement.top) <= 1
          && Math.abs(framePlacement.width - hostPlacement.width) <= 1
          && Math.abs(framePlacement.height - hostPlacement.height) <= 1
        if (runtime.projectId === projectId
          && framePlacement.connected
          && framePlacement.opacity === '1'
          && framePlacement.pointerEvents === 'auto'
          && hostPlacement.inScrollport
          && aligned) return observed
      }
    } catch {}
    await page.waitForTimeout(50)
  }
  throw new Error(`Locate did not expose the requested owner: ${JSON.stringify(observed)}`)
}

async function catalogEditor() {
  const response = await fetch(`${webUrl}/api/mcp-apps/catalog`)
  const catalog = await response.json()
  assert.equal(response.ok, true, JSON.stringify(catalog))
  const editor = catalog.items.find(
    item => item.publicToolName === 'mcp__threejs__open_editor',
  )
  assert.notEqual(editor, undefined)
  return editor
}

async function callRuntimeTool(name, arguments_, ownerSessionId) {
  const editor = await catalogEditor()
  const response = await fetch(`${webUrl}/api/mcp-apps/tool`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      viewId: editor.viewId,
      name,
      arguments: arguments_,
      sessionId: ownerSessionId,
      connectionGeneration: editor.connectionGeneration,
    }),
  })
  const result = await response.json()
  assert.equal(response.status, 200, JSON.stringify(result))
  assert.notEqual(result.isError, true, JSON.stringify(result))
  return result
}

function imageEvidence(result) {
  const image = result.content.find(block => block.type === 'image')
  assert.notEqual(image, undefined)
  assert.equal(result.structuredContent.evidenceToken, undefined)
  const bytes = Buffer.from(image.data, 'base64')
  assert.ok(bytes.length > 100)
  assert.equal(image.mimeType, 'image/png')
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  assert.equal(width, result.structuredContent.width)
  assert.equal(height, result.structuredContent.height)
  assert.ok(Number.isInteger(result.structuredContent.frame))
  assert.ok(Number.isFinite(Date.parse(result.structuredContent.capturedAt)))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), result.structuredContent.digest)
  return {
    bytes,
    digest: result.structuredContent.digest,
    runtime: result.structuredContent.runtime,
    frame: result.structuredContent.frame,
    width,
    height,
  }
}

async function canvasPng(canvas) {
  const dataUrl = await canvas.evaluate(element => element.toDataURL('image/png'))
  assert.match(dataUrl, /^data:image\/png;base64,/)
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
}

function activeAuthority(metrics) {
  return {
    projectId: metrics.projectId,
    revision: metrics.revision,
    sync: metrics.sync,
    selectedUuid: metrics.selectedUuid,
    operations: metrics.operations,
    pendingOperations: metrics.pendingOperations,
    hierarchy: metrics.hierarchy,
    runId: metrics.m7.runId,
    nonce: metrics.m7.nonce,
    cameraPosition: metrics.m7.metrics.cameraPosition,
    cameraQuaternion: metrics.m7.metrics.cameraQuaternion,
    cameraUp: metrics.m7.metrics.cameraUp,
    cameraZoom: metrics.m7.metrics.cameraZoom,
    controlsTarget: metrics.m7.metrics.controlsTarget,
  }
}

async function stableCanvasScreenshot(canvas, path) {
  let previous
  const digests = []
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const bytes = await canvas.screenshot()
    const digest = createHash('sha256').update(bytes).digest('hex')
    digests.push(digest)
    if (previous?.digest === digest) {
      writeFileSync(resolve(framesPath, path), bytes)
      return { bytes, digest, digests }
    }
    previous = { bytes, digest }
    await page.waitForTimeout(50)
  }
  throw new Error(`active canvas did not produce consecutive identical screenshots: ${
    digests.join(', ')
  }`)
}

function restartMcpServer() {
  const command = `${resolve(projectRoot, 'dist/server.js')} --root ${projectsPath}`
  const processes = execFileSync('ps', ['-ax', '-o', 'pid=,command='], {
    encoding: 'utf8',
  }).split('\n').filter(line => line.includes(command))
  assert.equal(processes.length, 1, `expected one scratch MCP server, found:\n${processes.join('\n')}`)
  process.kill(Number(processes[0].trim().split(/\s+/, 1)[0]), 'SIGTERM')
}

async function waitForConnectionGeneration(previous) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const editor = await catalogEditor()
      if (editor.connectionGeneration !== previous.connectionGeneration) return editor
    } catch {}
    await page.waitForTimeout(100)
  }
  throw new Error('MCP Server did not reconnect with a new generation')
}

async function waitForFrameRecreation(frame) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      await frame.evaluate(() => undefined)
      await page.waitForTimeout(100)
    } catch {
      return
    }
  }
  throw new Error('MCP App iframe was not recreated after reconnect')
}

async function checkProject(projectId) {
  const client = new Client({ name: 'm81-browser-check', version: '0.0.0' })
  await client.connect(new StdioClientTransport({
    command: fileURLToPath(new URL('../dist/server.js', import.meta.url)),
    args: ['--root', projectsPath],
  }))
  try {
    return await client.callTool({
      name: 'check_project',
      arguments: { projectId },
    })
  } finally {
    await client.close()
  }
}

async function parkCurrentEditor(appFrame, expectedFrames) {
  const marker = `m81-runtime-${Date.now()}`
  await appFrame.evaluate(value => {
    globalThis.__M81_RUNTIME_MARKER__ = value
  }, marker)
  const composer = page.locator('textarea:enabled[placeholder="描述你想要构建的内容"]')
  try {
    await page.locator('button[aria-label="新建会话"]:visible').last().click()
  } catch (error) {
    if (!await composer.isVisible()) throw error
  }
  await composer.waitFor({
    state: 'visible',
    timeout: 30_000,
  })
  await page.waitForFunction(expected => {
    const frames = [...document.querySelectorAll(
      'iframe[title="MCP App: mcp__threejs__open_editor"]',
    )]
    return frames.length === expected
      && frames.every(frame => frame.isConnected && frame.style.opacity === '0')
      && document.querySelector('[data-mcp-app-frame-host]') === null
  }, expectedFrames)
  assert.equal(
    await appFrame.evaluate(() => globalThis.__M81_RUNTIME_MARKER__),
    marker,
  )
  return marker
}

async function run() {
  await page.goto(webUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  const navigationsAfterLoad = mainFrameNavigations
  await addWorkspace()
  await sendPrompt('打开 Interactive Pool Volume')
  let appFrame = await editorFrame()
  const ownerSessionId = await sessionId()
  const initial = await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics())
  const projectId = initial.projectId
  assert.equal(typeof projectId, 'string')
  assert.equal(initial.capabilities.parameterPanel.id, 'runtime-parameters')
  assert.equal(initial.capabilities.command.undoable, true)
  assert.equal(initial.capabilities.debugSurface.id, 'runtime-diagnostics')
  assert.deepEqual(initial.capabilities.extension.permissions, ['runtime'])
  assert.equal(initial.m7.validationRunId, undefined)
  assert.equal(await page.locator('[data-mcp-app-view]').count(), 1)
  await page.screenshot({ path: resolve(framesPath, '00-open.png') })

  if (isolationFocus) {
    const identity = {
      projectId,
      revision: initial.revision,
      runId: initial.m7.runId,
      nonce: initial.m7.nonce,
    }
    const activeCanvas = appFrame
      .locator('iframe[data-runtime-sandbox]')
      .contentFrame()
      .locator('canvas')
    const visibleScreenshot = await stableCanvasScreenshot(
      activeCanvas,
      'focused-active-visible.png',
    )
    const activeBeforeBytes = await canvasPng(activeCanvas)
    const activeBefore = createHash('sha256').update(activeBeforeBytes).digest('hex')
    await parkCurrentEditor(appFrame, 1)
    const parkedBefore = await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics())
    const parkedBeforeBytes = await canvasPng(activeCanvas)
    const parkedBeforeCanvas = createHash('sha256').update(parkedBeforeBytes).digest('hex')
    assert.equal(parkedBeforeCanvas, activeBefore)
    const authorityBefore = activeAuthority(parkedBefore)
    const authorityBeforeSha256 = createHash('sha256')
      .update(JSON.stringify(authorityBefore))
      .digest('hex')
    const parkedCommands = []
    for (const frames of [400, 600]) {
      const result = await callRuntimeTool('simulate_player_actions', {
        ...identity,
        target: 'validation',
        timeoutMs: 20_000,
        actions: [{ type: 'waitFrames', frames }],
      }, ownerSessionId)
      assert.equal(result.structuredContent.status, 'completed')
      assert.ok(result.structuredContent.endFrame >= result.structuredContent.startFrame + frames)
      parkedCommands.push({
        frames,
        evidenceId: result.structuredContent.evidenceId,
        startFrame: result.structuredContent.startFrame,
        endFrame: result.structuredContent.endFrame,
      })
    }
    const parkedAfter = await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics())
    assert.equal(parkedAfter.projectId, parkedBefore.projectId)
    assert.equal(parkedAfter.revision, parkedBefore.revision)
    assert.equal(parkedAfter.sync, parkedBefore.sync)
    assert.equal(parkedAfter.m7.runId, parkedBefore.m7.runId)
    assert.equal(parkedAfter.m7.nonce, parkedBefore.m7.nonce)
    assert.equal(parkedAfter.selectedUuid, parkedBefore.selectedUuid)
    assert.deepEqual(
      parkedAfter.m7.metrics.cameraPosition,
      parkedBefore.m7.metrics.cameraPosition,
    )
    assert.deepEqual(
      parkedAfter.m7.metrics.cameraQuaternion,
      parkedBefore.m7.metrics.cameraQuaternion,
    )
    assert.deepEqual(parkedAfter.m7.metrics.cameraUp, parkedBefore.m7.metrics.cameraUp)
    assert.equal(parkedAfter.m7.metrics.cameraZoom, parkedBefore.m7.metrics.cameraZoom)
    assert.deepEqual(
      parkedAfter.m7.metrics.controlsTarget,
      parkedBefore.m7.metrics.controlsTarget,
    )
    const authorityAfter = activeAuthority(parkedAfter)
    assert.deepEqual(authorityAfter, authorityBefore)
    const authorityAfterSha256 = createHash('sha256')
      .update(JSON.stringify(authorityAfter))
      .digest('hex')
    assert.equal(authorityAfterSha256, authorityBeforeSha256)
    const activeAfterBytes = await canvasPng(activeCanvas)
    const activeAfter = createHash('sha256').update(activeAfterBytes).digest('hex')
    assert.equal(activeAfter, parkedBeforeCanvas)
    process.stdout.write(`${JSON.stringify({
      focusedActiveIsolation: true,
      runtime: identity,
      activeFrames: {
        before: parkedBefore.m7.metrics.frame,
        after: parkedAfter.m7.metrics.frame,
      },
      activeCanvasSha256: activeAfter,
      authoritativeStateSha256: authorityAfterSha256,
      visibleScreenshotSha256: visibleScreenshot.digest,
      visibleScreenshotSamples: visibleScreenshot.digests,
      parkedCommands,
    }, null, 2)}\n`)
    return
  }

  const sourcePath = resolve(
    workspacePath,
    'threejs-water-optics/interactive-pool-volume/scene.js',
  )
  const original = readFileSync(sourcePath, 'utf8')
  assert.match(original, /scene\.background = new THREE\.Color\(0x000000\);/)
  const ordinarySource = iteration => {
    const color = (
      (Math.min(255, iteration * 6) << 16)
      | (Math.min(255, iteration * 3) << 8)
      | Math.min(255, iteration * 2)
    ).toString(16).padStart(6, '0')
    return `${
      original.replace(
        'scene.background = new THREE.Color(0x000000);',
        `scene.background = new THREE.Color(0x${color});`,
      )
    }\n// M8.1 ordinary filesystem revision ${String(iteration)}\n`
  }
  let previousRevision = initial.revision
  try {
    for (let iteration = 1; iteration <= revisionCount; iteration += 1) {
      writeFileSync(sourcePath, ordinarySource(iteration))
      try {
        await appFrame.waitForFunction(previous => {
          const metrics = globalThis.__THREE_M7__.metrics()
          return metrics.sync === 'clean'
            && metrics.playState === 'editing'
            && metrics.revision !== previous
        }, previousRevision, { timeout: revisionTimeout })
      } catch (error) {
        const metrics = await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics())
        throw new Error(`Revision ${String(iteration)} did not settle: ${JSON.stringify({
          previousRevision,
          metrics,
          browserProblems: browserProblems.slice(-30),
        })}`, { cause: error })
      }
      const current = await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics())
      previousRevision = current.revision
      assert.equal(current.projectId, projectId)
      assert.equal(await page.locator('[data-mcp-app-view]').count(), 1)
      assert.equal(mainFrameNavigations, navigationsAfterLoad)
      if ([5, 10, 15, 20].includes(iteration)) {
        await page.screenshot({
          path: resolve(framesPath, `${String(iteration).padStart(2, '0')}-update.png`),
        })
      }
    }
    const applied = await callRuntimeTool('apply_project_files', {
      projectId,
      baseRevision: previousRevision,
      changes: [{
        type: 'write',
        path: 'm81-agent-update.txt',
        text: 'ordinary Agent mutation without reopening the Editor\n',
      }],
    }, ownerSessionId)
    await appFrame.waitForFunction(revision => {
      const metrics = globalThis.__THREE_M7__.metrics()
      return metrics.sync === 'clean' && metrics.revision === revision
    }, applied.structuredContent.revision, { timeout: revisionTimeout })
    previousRevision = applied.structuredContent.revision
    assert.equal(await page.locator('[data-mcp-app-view]').count(), 1)
    assert.equal(mainFrameNavigations, navigationsAfterLoad)

    await appFrame.getByRole('button', { name: 'Enter fullscreen' }).click()
    await appFrame.waitForFunction(() => (
      globalThis.__THREE_M7__.metrics().displayMode === 'fullscreen'
    ))
    await appFrame.locator('[data-play]').click()
    await appFrame.waitForFunction(() => (
      globalThis.__THREE_M7__.metrics().playState === 'playing'
    ), undefined, { timeout: 30_000 })
    const playingBefore = await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics())
    writeFileSync(sourcePath, ordinarySource(revisionCount + 1))
    await appFrame.waitForFunction(previous => {
      const metrics = globalThis.__THREE_M7__.metrics()
      return metrics.sync === 'clean'
        && metrics.playState === 'playing'
        && metrics.revision !== previous.revision
        && metrics.m7.runId !== previous.runId
        && metrics.displayMode === 'fullscreen'
    }, {
      revision: previousRevision,
      runId: playingBefore.m7.runId,
    }, { timeout: revisionTimeout })
    const playingAfter = await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics())
    assert.equal(playingAfter.m7.lastDispose.runId, playingBefore.m7.runId)
    assert.equal(playingAfter.m7.validationRunId, undefined)
    previousRevision = playingAfter.revision
    await page.screenshot({ path: resolve(framesPath, '21-playing-update.png') })
    await appFrame.getByRole('button', { name: 'Exit fullscreen' }).click()
    await appFrame.waitForFunction(() => (
      globalThis.__THREE_M7__.metrics().displayMode === 'inline'
    ))
    await page.locator('[data-mcp-app-view][data-display-mode="inline"]').waitFor({
      state: 'visible',
    })
    await appFrame.locator('[data-stop]').click()
    await appFrame.waitForFunction(() => (
      globalThis.__THREE_M7__.metrics().playState === 'editing'
    ), undefined, { timeout: 30_000 })

    const visibleRuntime = appFrame
      .locator('iframe[data-runtime-sandbox]')
      .contentFrame()
      .locator('canvas')
    const lastGoodRunId = (await appFrame.evaluate(
      () => globalThis.__THREE_M7__.metrics(),
    )).m7.runId
    writeFileSync(sourcePath, 'export default { setup( }\n')
    await appFrame.waitForFunction(previous => {
      const metrics = globalThis.__THREE_M7__.metrics()
      return metrics.revision !== previous
        && metrics.playState === 'error'
        && metrics.m7.runtimeFrameVisible === true
    }, previousRevision, { timeout: 120_000 })
    const failed = await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics())
    assert.equal(failed.m7.runId, lastGoodRunId)
    assert.equal(failed.m7.active, true)
    assert.ok((await visibleRuntime.screenshot()).length > 10_000)
    const checked = await checkProject(projectId)
    assert.equal(checked.isError, undefined)
    assert.ok(checked.structuredContent.errors.length > 0)
    assert.ok(checked.structuredContent.errors.some(error => /Expected identifier|syntax/i.test(error)))
    previousRevision = (await appFrame.evaluate(
      () => globalThis.__THREE_M7__.metrics(),
    )).revision
    await page.screenshot({ path: resolve(framesPath, '20-failed-candidate.png') })
  } finally {
    writeFileSync(sourcePath, original)
  }
  await appFrame.waitForFunction(previous => {
    const metrics = globalThis.__THREE_M7__.metrics()
    return metrics.sync === 'clean'
      && metrics.playState === 'editing'
      && metrics.revision !== previous
  }, previousRevision, { timeout: 120_000 })

  try {
    await appFrame.locator('[data-object-uuid]').first().click()
    const positionX = appFrame.getByRole('spinbutton', { name: 'Position X' })
    const externalPositionX = await positionX.inputValue()
    await positionX.fill('-2.25')
    await positionX.press('Tab')
    await appFrame.waitForFunction(() => (
      globalThis.__THREE_M7__.metrics().sync === 'dirty'
      && document.querySelector('[data-vector="position"][data-axis="x"]').value === '-2.25'
    ))
    writeFileSync(sourcePath, `${original}\n// M8.1 conflict revision 1\n`)
    await appFrame.waitForFunction(() => (
      globalThis.__THREE_M7__.metrics().sync === 'conflict'
      && document.querySelector('[data-vector="position"][data-axis="x"]').value === '-2.25'
    ), undefined, { timeout: 120_000 })
    await appFrame.getByRole('button', { name: 'Review later', exact: true }).click()
    await appFrame.getByText(
      'External revision deferred; local changes remain unsaved',
      { exact: true },
    ).waitFor()
    assert.equal(
      (await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics())).sync,
      'conflict',
    )
    const editorStatePath = resolve(
      projectsPath,
      '.managed-workspaces',
      projectId,
      'threejs.editor.json',
    )
    const editorStateBeforeRejectedSave = readFileSync(editorStatePath, 'utf8')
    await appFrame.getByRole('button', { name: 'Save local revision', exact: true }).click()
    await appFrame.waitForFunction(() => (
      globalThis.__THREE_M7__.metrics().sync === 'conflict'
      && globalThis.__THREE_M7__.metrics().draft === 'stored'
      && document.querySelector('[data-vector="position"][data-axis="x"]').value === '-2.25'
    ), undefined, { timeout: 120_000 })
    assert.equal(readFileSync(editorStatePath, 'utf8'), editorStateBeforeRejectedSave)
    await appFrame.getByRole('button', { name: 'Load external', exact: true }).click()
    await appFrame.waitForFunction(expectedPosition => (
      globalThis.__THREE_M7__.metrics().sync === 'clean'
      && globalThis.__THREE_M7__.metrics().draft === undefined
      && document.querySelector('[data-vector="position"][data-axis="x"]').value === expectedPosition
    ), externalPositionX, { timeout: 120_000 })
  } finally {
    previousRevision = (await appFrame.evaluate(
      () => globalThis.__THREE_M7__.metrics(),
    )).revision
    writeFileSync(sourcePath, original)
  }
  await appFrame.waitForFunction(previous => (
    globalThis.__THREE_M7__.metrics().sync === 'clean'
      && globalThis.__THREE_M7__.metrics().revision !== previous
  ), previousRevision, { timeout: 120_000 })

  const draftPosition = appFrame.getByRole('spinbutton', { name: 'Position X' })
  await draftPosition.fill('-1.75')
  await draftPosition.press('Tab')
  await appFrame.waitForFunction(() => {
    const metrics = globalThis.__THREE_M7__.metrics()
    return metrics.sync === 'dirty'
      && metrics.draft === 'stored'
      && document.querySelector('[data-vector="position"][data-axis="x"]').value === '-1.75'
  })
  const beforeReload = await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics())

  await rpc('session.prompt', {
    sessionId: ownerSessionId,
    mode: 'queue',
    content: [{
      type: 'text',
      text: '打开 Touch History Frost',
    }],
  })
  const second = await secondEditorFrame(projectId)
  let frostFrame = second.appFrame
  const frostProjectId = second.metrics.projectId
  const frostTitle = frostFrame.getByRole('textbox', { name: 'Project title' })
  await frostTitle.fill('Touch-History Frost Draft')
  await frostTitle.press('Tab')
  await frostFrame.waitForFunction(() => (
    globalThis.__THREE_M7__.metrics().sync === 'dirty'
      && globalThis.__THREE_M7__.metrics().draft === 'stored'
      && document.querySelector('[data-title]').value === 'Touch-History Frost Draft'
  ))
  await frostFrame.getByRole('button', { name: 'Enter fullscreen' }).click()
  await frostFrame.waitForFunction(() => (
    globalThis.__THREE_M7__.metrics().displayMode === 'fullscreen'
  ))
  assert.equal((await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics())).sync, 'dirty')
  assert.equal(await draftPosition.inputValue(), '-1.75')
  await frostFrame.getByRole('button', { name: 'Exit fullscreen' }).click()
  await frostFrame.waitForFunction(() => (
    globalThis.__THREE_M7__.metrics().displayMode === 'inline'
  ))
  assert.equal(await page.locator('[data-mcp-app-view]').count(), 2)
  await page.screenshot({ path: resolve(framesPath, '22-two-projects.png') })

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })
  appFrame = await editorFrameForProject(projectId, 'dirty')
  frostFrame = await editorFrameForProject(frostProjectId, 'dirty')
  const restored = await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics())
  assert.equal(restored.projectId, projectId)
  assert.equal(restored.revision, beforeReload.revision)
  assert.equal(restored.draft, 'restored')
  assert.equal(
    await appFrame.getByRole('spinbutton', { name: 'Position X' }).inputValue(),
    '-1.75',
  )
  assert.equal(
    await frostFrame.getByRole('textbox', { name: 'Project title' }).inputValue(),
    'Touch-History Frost Draft',
  )
  assert.equal(await page.locator('[data-mcp-app-view]').count(), 2)
  assert.equal(mainFrameNavigations, navigationsAfterLoad + 1)

  const previousConnection = await catalogEditor()
  restartMcpServer()
  const reconnected = await waitForConnectionGeneration(previousConnection)
  assert.notEqual(reconnected.viewId, previousConnection.viewId)
  const stale = await fetch(`${webUrl}/api/mcp-apps/tool`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      viewId: previousConnection.viewId,
      name: 'pull_project',
      arguments: { projectId },
      sessionId: ownerSessionId,
      connectionGeneration: previousConnection.connectionGeneration,
    }),
  })
  assert.equal(stale.status, 400)
  await Promise.all([
    waitForFrameRecreation(appFrame),
    waitForFrameRecreation(frostFrame),
  ])
  appFrame = await editorFrameForProject(projectId, 'dirty')
  frostFrame = await editorFrameForProject(frostProjectId, 'dirty')
  assert.equal(await appFrame.getByRole('spinbutton', { name: 'Position X' }).inputValue(), '-1.75')
  assert.equal(
    await frostFrame.getByRole('textbox', { name: 'Project title' }).inputValue(),
    'Touch-History Frost Draft',
  )
  assert.equal(await page.locator('[data-mcp-app-view]').count(), 2)
  await page.screenshot({ path: resolve(framesPath, '23-reconnected.png') })

  const locateEvidence = await locateEditor(
    'call_threejs_m81_pool',
    appFrame,
    projectId,
  )
  await page.waitForFunction(() => [...document.querySelectorAll(
    'iframe[title="MCP App: mcp__threejs__open_editor"]',
  )].some(frame => frame.style.opacity === '1' && frame.style.pointerEvents === 'auto'))
  const beforeSave = await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics())
  await appFrame.locator('[data-save]').click()
  try {
    await appFrame.waitForFunction(previous => {
      const metrics = globalThis.__THREE_M7__.metrics()
      return metrics.sync === 'clean'
        && metrics.draft === undefined
        && metrics.playState === 'editing'
        && metrics.m7.active === true
        && metrics.revision !== previous.revision
        && metrics.m7.runId === previous.runId
        && metrics.m7.nonce === previous.nonce
        && metrics.m7.runtimeFrameVisible === true
    }, {
      revision: beforeSave.revision,
      runId: beforeSave.m7.runId,
      nonce: beforeSave.m7.nonce,
    }, { timeout: 120_000 })
  } catch (error) {
    const state = await appFrame.evaluate(() => ({
      metrics: globalThis.__THREE_M7__.metrics(),
      status: document.querySelector('[data-status]')?.textContent,
    }))
    throw new Error(`Restored draft did not save after reconnect: ${JSON.stringify({
      state,
      browserProblems: browserProblems.slice(-30),
    })}`, { cause: error })
  }

  if (layeringFocus) {
    const beforePark = await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics())
    const identity = {
      projectId: beforePark.projectId,
      revision: beforePark.revision,
      runId: beforePark.m7.runId,
      nonce: beforePark.m7.nonce,
    }
    const activeCanvas = appFrame
      .locator('iframe[data-runtime-sandbox]')
      .contentFrame()
      .locator('canvas')
    const activeBeforeBytes = await canvasPng(activeCanvas)
    const activeBefore = createHash('sha256').update(activeBeforeBytes).digest('hex')
    const authorityBefore = activeAuthority(beforePark)
    const authorityBeforeSha256 = createHash('sha256')
      .update(JSON.stringify(authorityBefore))
      .digest('hex')
    await parkCurrentEditor(appFrame, 2)
    const parkedActions = []
    for (let index = 0; index < 2; index += 1) {
      const result = await callRuntimeTool('simulate_player_actions', {
        ...identity,
        target: 'validation',
        timeoutMs: 20_000,
        actions: [{ type: 'waitFrames', frames: 5 }],
      }, ownerSessionId)
      assert.equal(result.structuredContent.status, 'completed')
      parkedActions.push({
        evidenceId: result.structuredContent.evidenceId,
        startFrame: result.structuredContent.startFrame,
        endFrame: result.structuredContent.endFrame,
      })
    }
    const afterPark = await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics())
    const authorityAfter = activeAuthority(afterPark)
    assert.deepEqual(authorityAfter, authorityBefore)
    const authorityAfterSha256 = createHash('sha256')
      .update(JSON.stringify(authorityAfter))
      .digest('hex')
    assert.equal(authorityAfterSha256, authorityBeforeSha256)
    const activeAfterBytes = await canvasPng(activeCanvas)
    const activeAfter = createHash('sha256').update(activeAfterBytes).digest('hex')
    assert.equal(activeAfter, activeBefore)
    process.stdout.write(`${JSON.stringify({
      projectId,
      secondProjectId: frostProjectId,
      ordinaryFilesystemRevisions: revisionCount,
      conflictSaveRejectedWithoutWrite: true,
      sessionReloadRestored: true,
      mcpRestartRestored: true,
      actionsMenuClicked: true,
      locateMenuClicked: true,
      locateEvidence,
      iframeInteractionsRestored: true,
      iframeSaveClicked: true,
      parkedRuntimeConsecutiveCommands: parkedActions,
      activeCanvasSha256: activeAfter,
      authoritativeStateSha256: authorityAfterSha256,
    }, null, 2)}\n`)
  } else {
  const before = await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics())
  const identity = {
    projectId: before.projectId,
    revision: before.revision,
    runId: before.m7.runId,
    nonce: before.m7.nonce,
  }
  const activeCanvas = appFrame
    .locator('iframe[data-runtime-sandbox]')
    .contentFrame()
    .locator('canvas')
  const activeBeforeBytes = await canvasPng(activeCanvas)
  writeFileSync(resolve(framesPath, '24-active-before.png'), activeBeforeBytes)
  const activeBefore = createHash('sha256').update(activeBeforeBytes).digest('hex')
  const capturedBefore = imageEvidence(await callRuntimeTool(
    'capture_runtime_frame',
    { ...identity, target: 'validation' },
    ownerSessionId,
  ))
  writeFileSync(resolve(framesPath, '24-validation-before.png'), capturedBefore.bytes)
  const action = await callRuntimeTool('simulate_player_actions', {
    ...identity,
    target: 'validation',
    actions: [
      { type: 'click', x: 0.35, y: 0.4, button: 0 },
      { type: 'waitFrames', frames: 8 },
      { type: 'drag', from: [0.42, 0.44], to: [0.58, 0.52], button: 0, steps: 8 },
      { type: 'waitFrames', frames: 8 },
      { type: 'waitFrames', frames: 600 },
    ],
  }, ownerSessionId)
  assert.equal(action.structuredContent.status, 'completed')
  assert.equal(action.structuredContent.trace.length, 5)
  assert.equal(action.structuredContent.trace[0].handled, true)
  assert.equal(action.structuredContent.trace[2].handled, true)
  const capturedAfter = imageEvidence(await callRuntimeTool(
    'capture_runtime_frame',
    { ...identity, target: 'validation' },
    ownerSessionId,
  ))
  writeFileSync(resolve(framesPath, '25-validation-after.png'), capturedAfter.bytes)
  assert.notEqual(capturedAfter.digest, capturedBefore.digest)
  assert.ok(capturedAfter.frame > capturedBefore.frame)
  assert.equal(capturedAfter.width, capturedBefore.width)
  assert.equal(capturedAfter.height, capturedBefore.height)
  const validationCanvas = appFrame
    .locator('iframe[data-validation-runtime]')
    .contentFrame()
    .locator('canvas')
  await validationCanvas.evaluate(canvas => {
    console.warn('M8.1 injected validation warning')
    window.dispatchEvent(new ErrorEvent('error', {
      message: 'M8.1 injected validation exception',
    }))
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    canvas.dispatchEvent(new Event('webglcontextrestored'))
  })
  const firstLogs = await callRuntimeTool('read_runtime_logs', {
    ...identity,
    target: 'validation',
    cursor: 0,
    limit: 3,
  }, ownerSessionId)
  assert.equal(firstLogs.structuredContent.entries.length, 3)
  assert.equal(firstLogs.structuredContent.truncated, true)
  const secondLogs = await callRuntimeTool('read_runtime_logs', {
    ...identity,
    target: 'validation',
    cursor: firstLogs.structuredContent.nextCursor,
    limit: 20,
  }, ownerSessionId)
  const logEntries = [
    ...firstLogs.structuredContent.entries,
    ...secondLogs.structuredContent.entries,
  ]
  assert.equal(new Set(logEntries.map(entry => entry.cursor)).size, logEntries.length)
  assert.ok(logEntries.some(entry => (
    entry.message.includes('Runtime Harness action')
  )))
  assert.ok(logEntries.some(entry => entry.message.includes('injected validation warning')))
  assert.ok(logEntries.some(entry => entry.message.includes('injected validation exception')))
  assert.ok(logEntries.some(entry => entry.message.includes('WebGL context lost')))
  assert.ok(logEntries.some(entry => entry.message.includes('WebGL context restored')))
  const after = await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics())
  assert.equal(after.sync, before.sync)
  assert.equal(after.m7.runId, before.m7.runId)
  assert.equal(after.selectedUuid, before.selectedUuid)
  assert.deepEqual(after.m7.metrics.cameraPosition, before.m7.metrics.cameraPosition)
  const activeAfterBytes = await canvasPng(activeCanvas)
  writeFileSync(resolve(framesPath, '25-active-after.png'), activeAfterBytes)
  const activeAfter = createHash('sha256').update(activeAfterBytes).digest('hex')
  assert.equal(activeAfter, activeBefore)
  assert.equal(before.m7.metrics.gpuRendererUnmasked, true)
  assert.equal(typeof before.m7.metrics.gpuRenderer, 'string')
  assert.doesNotMatch(before.m7.metrics.gpuRenderer, /swiftshader|llvmpipe|software/i)
  if (process.platform === 'darwin') {
    assert.match(before.m7.metrics.gpuRenderer, /ANGLE.*Metal|Metal/i)
  }
  assert.equal(before.m7.metrics.devicePixelRatio, deviceScaleFactor)
  assert.ok(Math.abs(
    before.m7.metrics.drawingBufferSize[0]
      - Math.floor(before.m7.metrics.clientSize[0] * deviceScaleFactor),
  ) <= 1)
  assert.ok(Math.abs(
    before.m7.metrics.drawingBufferSize[1]
      - Math.floor(before.m7.metrics.clientSize[1] * deviceScaleFactor),
  ) <= 1)
  await page.screenshot({ path: resolve(framesPath, '26-validation.png') })

  await rpc('session.prompt', {
    sessionId: ownerSessionId,
    mode: 'queue',
    content: [{
      type: 'text',
      text: '当前模型不支持图像输入，请执行视觉验收',
    }],
  })
  const noImageDeadline = Date.now() + 30_000
  let currentEvents = []
  while (Date.now() < noImageDeadline) {
    const history = await rpc('session.history', {
      sessionId: ownerSessionId,
      maxMessages: 100,
    })
    currentEvents = history.events.filter(item => item.event.time >= startedAt)
    if (currentEvents.some(item => (
      item.event.type === 'assistant/message'
        && historyMessage(item).content.some(block => (
          block.type === 'text'
            && block.text.includes('停止自动视觉判断')
            && block.text.includes('等待用户提供实际结果后继续')
            && block.text.includes('不得自行推断视觉结果')
        ))
    ))) break
    await page.waitForTimeout(100)
  }
  const toolCalls = currentEvents.filter(item => item.event.type === 'tool/call')
  assert.deepEqual(toolCalls.map(item => item.event.data.name), [
    'mcp__threejs__open_editor',
    'mcp__threejs__open_editor',
  ])
  const runtimeContext = currentEvents.findLast(item => (
    item.event.type === 'user/message'
      && historyMessage(item).source?.plugin === '@deepseek-ai/dsh-system-prompt'
      && historyMessage(item).content.some(block => (
        block.type === 'text'
          && block.text.includes('MCP App context from "mcp__threejs__open_editor"')
      ))
  ))
  assert.notEqual(runtimeContext, undefined)
  const runtimeContextText = historyMessage(runtimeContext).content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  assert.match(runtimeContextText, new RegExp(identity.revision))
  assert.doesNotMatch(runtimeContextText, new RegExp(beforeSave.revision))
  assert.ok(currentEvents.some(item => (
    item.event.type === 'assistant/message'
      && historyMessage(item).content.some(block => (
        block.type === 'text'
          && block.text.includes('停止自动视觉判断')
          && block.text.includes('等待用户提供实际结果后继续')
          && block.text.includes('不得自行推断视觉结果')
      ))
  )))

  await parkCurrentEditor(appFrame, 2)
  const parkedActions = []
  for (let index = 0; index < 2; index += 1) {
    const parkedAction = await callRuntimeTool('simulate_player_actions', {
      ...identity,
      target: 'validation',
      timeoutMs: 20_000,
      actions: [{ type: 'waitFrames', frames: 5 }],
    }, ownerSessionId)
    assert.equal(parkedAction.structuredContent.status, 'completed')
    parkedActions.push(parkedAction.structuredContent.evidenceId)
  }

  process.stdout.write(`${JSON.stringify({
    projectId,
    secondProjectId: frostProjectId,
    ordinaryFilesystemRevisions: revisionCount,
    ordinaryAgentToolRevision: true,
    conflictSaveRejectedWithoutWrite: true,
    editorCards: await page.locator('[data-mcp-app-view]').count(),
    mainFrameNavigations,
    sessionReloadRestored: true,
    mcpRestartRestored: true,
    connectionGeneration: {
      before: previousConnection.connectionGeneration,
      after: reconnected.connectionGeneration,
    },
    twoProjectDraftsRestored: true,
    gpu: {
      renderer: before.m7.metrics.gpuRenderer,
      unmasked: before.m7.metrics.gpuRendererUnmasked,
      devicePixelRatio: before.m7.metrics.devicePixelRatio,
    },
    runtime: identity,
    validationRuntime: capturedAfter.runtime,
    evidence: {
      before: capturedBefore.digest,
      after: capturedAfter.digest,
      action: action.structuredContent.evidenceId,
      logs: [
        firstLogs.structuredContent.evidenceId,
        secondLogs.structuredContent.evidenceId,
      ],
    },
    playingRevisionUpdated: true,
    draftReloadRestored: true,
    activeEditorIsolated: true,
    runtimeModelContextRefreshed: true,
    noImageRoutePaused: true,
    parkedRuntimeContextPreserved: true,
    parkedRuntimeCommandCompleted: true,
    parkedRuntimeConsecutiveCommands: parkedActions,
    locateEvidence,
    activeFrameDigests: {
      before: activeBefore,
      after: activeAfter,
    },
  }, null, 2)}\n`)
  }
}

try {
  await run()
} finally {
  await browser.close()
}
