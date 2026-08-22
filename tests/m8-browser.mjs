import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { chromium } from 'playwright'
import { M7_RUNTIME_CHANNEL, m7BootstrapHtml } from '../src/m7-runtime.ts'

const webUrl = process.env.DSH_WEB_URL
if (webUrl === undefined) throw new Error('DSH_WEB_URL is required')
const projectRoot = resolve(process.env.THREEJS_EDITOR_MCP_ROOT ?? '.')
const workspacePath = resolve(process.env.THREEJS_EDITOR_MCP_WORKSPACE ?? '')
if (workspacePath === projectRoot) throw new Error('THREEJS_EDITOR_MCP_WORKSPACE is required')
const projectsRoot = resolve(process.env.THREEJS_EDITOR_MCP_PROJECTS ?? '')
if (projectsRoot === projectRoot) throw new Error('THREEJS_EDITOR_MCP_PROJECTS is required')
const evidenceSource = process.env.M8_EVIDENCE_SOURCE
assert.equal(evidenceSource, 'deterministic-replay')
const evidenceStartedAt = Date.now()
const replayPrompts = [
  '打开 Touch-History Frost',
  '打开 Interactive Pool Volume',
]
const corpus = JSON.parse(readFileSync(resolve(projectRoot, 'corpus/m5.json'), 'utf8'))
const corpusRoot = execFileSync(
  'git',
  ['-C', workspacePath, 'rev-parse', '--show-toplevel'],
  { encoding: 'utf8' },
).trim()
const corpusCommit = execFileSync(
  'git',
  ['-C', corpusRoot, 'rev-parse', 'HEAD'],
  { encoding: 'utf8' },
).trim()
assert.equal(corpusCommit, corpus.graphicsCorpus.commit)
assert.equal(execFileSync(
  'git',
  ['-C', corpusRoot, 'status', '--porcelain=v1'],
  { encoding: 'utf8' },
).trim(), '')
assert.deepEqual(readdirSync(projectsRoot).sort(), ['.managed-workspaces'])
assert.deepEqual(readdirSync(resolve(projectsRoot, '.managed-workspaces')), [])
const artifacts = resolve(projectRoot, 'artifacts')
mkdirSync(artifacts, { recursive: true })
const gifFrames = resolve(process.env.M8_GIF_FRAMES ?? '')
if (gifFrames === projectRoot) throw new Error('M8_GIF_FRAMES is required')
const gifFrameNames = [
  '00-frost-deposit.png',
  '01-pool-edit.png',
  '02-pool-dragged.png',
  '03-pool-caustics.png',
  '04-pool-clean-reload.png',
]
mkdirSync(gifFrames, { recursive: true })
assert.deepEqual(readdirSync(gifFrames), [])
const deviceScaleFactor = Number(process.env.M8_DPR ?? 1.25)
assert.ok(Number.isFinite(deviceScaleFactor) && deviceScaleFactor > 0)
const expectedDpr = Math.min(deviceScaleFactor, 2)
const browserArgs = [
  `--force-device-scale-factor=${String(deviceScaleFactor)}`,
  '--disable-software-rasterizer',
]
if (process.platform === 'darwin') browserArgs.push('--use-angle=metal')

const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM_PATH === undefined
    ? { channel: 'chrome' }
    : { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }),
  headless: true,
  args: browserArgs,
})
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor,
  locale: 'zh-CN',
}).catch(async error => {
  await browser.close()
  throw error
})
const appProblems = []
let mainFrameNavigations = 0
page.on('framenavigated', frame => {
  if (frame === page.mainFrame()) mainFrameNavigations += 1
})
const frostAssets = [
  {
    mediaType: 'image/jpeg',
    path: 'dev/example-gallery/examples/threejs-temporal-surfaces/touch-history-frost/assets/winter_forest.jpeg',
    sha256: '154001c43ab2f8744d9eb1684d4b62563a034b0913d344f47f5bc939e590d76f',
    size: 798011,
  },
  {
    mediaType: 'image/webp',
    path: 'skills/threejs-temporal-surfaces/assets/touch-history-frost/main-normal.webp',
    sha256: '98258e2a6928a3060a1e1b2e493e31c57114080aaf154c8a5707f8979bb0abdf',
    size: 11364,
  },
  {
    mediaType: 'image/webp',
    path: 'skills/threejs-temporal-surfaces/assets/touch-history-frost/noise.webp',
    sha256: '3ab5a95af96ddb328154175bc2decc903ab0d6b1dab5b9ee040216006cb566cd',
    size: 7196,
  },
  {
    mediaType: 'image/webp',
    path: 'skills/threejs-temporal-surfaces/assets/touch-history-frost/sub-normal.webp',
    sha256: 'cb8e590072b1bf1a609e9ab4f3a1d4cdda5b8e25c4dcd9ea3fb6e3a26ab2f0a1',
    size: 22554,
  },
]
const poolAssets = [
  ['tiles.jpg', 'da7dbbe829553807fd72fc66514765d8af26b0c326b6664c4ac3be57271c2f69', 110238],
  ['xneg.jpg', '185a3f41c7abd381454d7d3938bb1b885ceca760b0292cc30a04435ffc2b25db', 23299],
  ['xpos.jpg', '80a126350786e8a1f61e3ec8b825003faf00498d9ebebd7173afa2c1ace1f764', 30837],
  ['ypos.jpg', 'e973e3033fb2a3c2f80a8a10cddc78e808f70a93a868fa8ac3cf41b8e822ddb4', 16741],
  ['zneg.jpg', '6c2fbb8af830820b6c980494d9d6f16e99e51a11d16f21c14853c6df535c03e6', 24402],
  ['zpos.jpg', 'a54e18536d0957188108fd95d39669ec88a338a519a174598b90afb4abefb0b1', 22927],
].map(([name, sha256, size]) => ({
  mediaType: 'image/jpeg',
  path: `skills/threejs-water-optics/assets/interactive-pool-volume/${name}`,
  sha256,
  size,
}))
page.on('console', message => {
  if (message.type() === 'error') appProblems.push(`console: ${message.text()}`)
})
page.on('pageerror', error => appProblems.push(`pageerror: ${error.stack ?? error.message}`))

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
  const composer = page.locator('textarea').last()
  await composer.waitFor({ state: 'visible', timeout: 30_000 })
  await composer.fill(text)
  await composer.press('Enter')
}

async function latestApp(title, entry, assets) {
  const frames = page.locator('iframe[title="MCP App: mcp__threejs__open_editor"]')
  await page.getByText(title, { exact: false }).last().waitFor({
    state: 'visible',
    timeout: 60_000,
  })
  const deadline = Date.now() + 120_000
  let candidates = []
  while (Date.now() < deadline) {
    candidates = []
    for (let index = await frames.count() - 1; index >= 0; index -= 1) {
      try {
        const outerFrame = await (await frames.nth(index).elementHandle()).contentFrame()
        if (outerFrame === null) continue
        const inner = outerFrame.locator('iframe')
        if (await inner.count() === 0) continue
        const appFrame = await (await inner.last().elementHandle()).contentFrame()
        if (appFrame === null || await appFrame.locator('[data-three-editor]').count() === 0) {
          continue
        }
        const metrics = await appFrame.evaluate(() => globalThis.__THREE_M7__?.metrics())
        candidates.push(metrics)
        if (metrics?.workspaceEntry !== entry
          || metrics.sync !== 'clean'
          || metrics.m7.ready?.mode !== 'edit'
          || metrics.m7.build?.assets?.length !== assets) continue
        const runtime = appFrame.locator('iframe[data-runtime-sandbox]')
        await runtime.waitFor({ state: 'visible', timeout: 30_000 })
        const runtimeFrame = await (await runtime.elementHandle()).contentFrame()
        assert.notEqual(runtimeFrame, null)
        return { appFrame, runtimeFrame }
      } catch {}
    }
    await page.waitForTimeout(250)
  }
  process.stderr.write(`${JSON.stringify({ title, candidates, appProblems }, null, 2)}\n`)
  throw new Error(`timed out waiting for MCP App ${title}`)
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
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
    for (let index = 0; index < pixels.length; index += 16) {
      const red = pixels[index] ?? 0
      const green = pixels[index + 1] ?? 0
      const blue = pixels[index + 2] ?? 0
      if (red + green + blue > 60) lit += 1
      colors.add((red << 16) | (green << 8) | blue)
    }
    return {
      sampled: pixels.length / 16,
      lit,
      colors: colors.size,
    }
  })
}

function inputEventCount(metrics, type) {
  return Number(metrics.runtimeInputEvents?.[type] ?? 0)
}

function assertHardwareRenderer(metrics) {
  assert.equal(metrics.gpuRendererUnmasked, true)
  assert.equal(typeof metrics.gpuRenderer, 'string')
  assert.doesNotMatch(
    metrics.gpuRenderer,
    /swiftshader|software|llvmpipe|lavapipe|softpipe|basic render|gdi generic/i,
  )
}

async function runtimeMetrics(appFrame) {
  return appFrame.evaluate(() => globalThis.__THREE_M7__.requestM7Metrics())
}

async function waitForRuntimeFrames(appFrame, count) {
  const current = await runtimeMetrics(appFrame)
  await appFrame.waitForFunction(async target => (
    (await globalThis.__THREE_M7__.requestM7Metrics()).frame >= target
  ), current.frame + count)
}

async function captureGifFrame(name) {
  assert.ok(gifFrameNames.includes(name))
  await page.screenshot({ path: resolve(gifFrames, name), fullPage: false })
}

async function verifyFailedStartDisposalHandshake() {
  const probe = await browser.newPage()
  try {
    await probe.setContent('<iframe sandbox="allow-scripts"></iframe>')
    await probe.locator('iframe').evaluate(
      (frame, source) => { frame.srcdoc = source },
      m7BootstrapHtml(),
    )
    await probe.frameLocator('iframe').locator('canvas').waitFor()
    const run = {
      channel: M7_RUNTIME_CHANNEL,
      projectId: 'm8-startup-failure-probe',
      runId: '55555555-6666-4777-8888-999999999999',
      nonce: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      revision: 'a'.repeat(64),
    }
    await probe.evaluate(value => {
      globalThis.__runtimeProbeEvents = []
      const runtime = document.querySelector('iframe')
      window.addEventListener('message', event => {
        if (event.source === runtime?.contentWindow
          && event.data?.channel === value.channel
          && event.data.projectId === value.projectId
          && event.data.runId === value.runId
          && event.data.nonce === value.nonce
          && event.data.revision === value.revision) {
          globalThis.__runtimeProbeEvents.push(event.data)
        }
      })
      document.querySelector('iframe').contentWindow.postMessage({
        ...value,
        action: 'run',
        bundle: 'throw new Error("startup boom")',
        backend: 'webgl',
        mode: 'edit',
      }, '*')
    }, run)
    await probe.waitForFunction(() => (
      globalThis.__runtimeProbeEvents.some(event => event.type === 'runtime-error')
    ))
    await probe.evaluate(value => {
      document.querySelector('iframe').contentWindow.postMessage({
        ...value,
        action: 'stop',
      }, '*')
    }, run)
    await probe.waitForFunction(() => (
      globalThis.__runtimeProbeEvents.some(event => event.type === 'disposed')
    ), undefined, { timeout: 10_000 })
    const events = await probe.evaluate(() => globalThis.__runtimeProbeEvents)
    assert.deepEqual(events.map(event => event.type), ['runtime-error', 'disposed'])
    assert.deepEqual(events.map(event => ({
      channel: event.channel,
      projectId: event.projectId,
      runId: event.runId,
      nonce: event.nonce,
      revision: event.revision,
    })), [run, run])
  } finally {
    await probe.close()
  }
}

async function playRuntime(appFrame) {
  const before = await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics())
  const previousFrame = Number(before.m7.metrics?.frame ?? -1)
  await appFrame.getByRole('button', { name: 'Play', exact: true }).click()
  await appFrame.waitForFunction(async frame => {
    const appMetrics = globalThis.__THREE_M7__.metrics()
    if (appMetrics.playState !== 'playing' || appMetrics.m7.runId === undefined) return false
    try {
      const runtime = await globalThis.__THREE_M7__.requestM7Metrics()
      return runtime.mode === 'run' && runtime.frame > frame
    } catch {
      return false
    }
  }, previousFrame)
  await appFrame.waitForFunction(frame => {
    const metrics = globalThis.__THREE_M7__.metrics().m7.metrics
    return metrics?.mode === 'run' && metrics.frame > frame
  }, previousFrame)
  const after = await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics())
  assert.equal(after.playState, 'playing', JSON.stringify(after))
  assert.equal(after.m7.active, true, JSON.stringify(after))
  assert.equal(after.m7.metrics.mode, 'run', JSON.stringify(after))
  assert.ok(after.m7.metrics.frame > previousFrame, JSON.stringify(after))
  return after.m7.metrics
}

async function callHarnessRpc(method, payload) {
  const response = await fetch(`${webUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `m8-${method}-${Date.now()}`,
      method,
      payload,
    }),
  })
  const body = await response.json()
  assert.equal(response.ok, true, JSON.stringify(body))
  assert.equal(body.result?.ok, true, JSON.stringify(body))
  return body.result.value
}

async function findReplaySession(callId) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const listed = await callHarnessRpc('session.list', {})
    for (const session of listed.items
      .filter(item => !item.blank && item.updatedAt >= evidenceStartedAt)
      .sort((left, right) => right.updatedAt - left.updatedAt)) {
      const history = await callHarnessRpc('session.history', {
        sessionId: session.sessionId,
        maxMessages: 100,
      })
      if (history.events.some(item => (
        item.event.time >= evidenceStartedAt
          && item.event.type === 'tool/call'
          && item.event.data.callId === callId
      ))) return session.sessionId
    }
    await page.waitForTimeout(100)
  }
  throw new Error(`Replay session for ${callId} was not observed`)
}

async function replayEvidence(sessionId, sourceEdit, diagnostics) {
  const expectedCallIds = [
    'call_threejs_m8_frost',
    'call_threejs_m8_pool',
    'call_threejs_m8_read_source',
    'call_threejs_m8_apply_source',
    'call_threejs_m8_build_source',
    'call_threejs_m8_check_source',
    'call_threejs_m8_check_runtime',
  ]
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const listed = await callHarnessRpc('session.list', {})
    const session = listed.items.find(item => item.sessionId === sessionId)
    if (session !== undefined && !session.running) {
      const history = await callHarnessRpc('session.history', {
        sessionId,
        maxMessages: 100,
      })
      const currentEvents = history.events.filter(
        item => item.event.time >= evidenceStartedAt,
      )
      const toolCalls = currentEvents
        .filter(item => item.event.type === 'tool/call')
        .map(item => item.event.data)
      const toolCallIds = toolCalls.map(item => item.callId)
      if (JSON.stringify(toolCallIds) === JSON.stringify(expectedCallIds)) {
        assert.equal(history.hasMore, false)
        assert.deepEqual(toolCalls.map(item => item.name), [
          'mcp__threejs__open_editor',
          'mcp__threejs__open_editor',
          'mcp__threejs__read_project_files',
          'mcp__threejs__apply_project_files',
          'mcp__threejs__build_project',
          'mcp__threejs__check_project',
          'mcp__threejs__check_project',
        ])
        const toolArguments = toolCalls.map(item => JSON.parse(item.arguments))
        assert.deepEqual(toolArguments, [
          { projectPath: 'threejs-temporal-surfaces/touch-history-frost' },
          { projectPath: 'threejs-water-optics/interactive-pool-volume' },
          {
            projectId: sourceEdit.projectId,
            files: [{ path: sourceEdit.path }],
          },
          {
            projectId: sourceEdit.projectId,
            baseRevision: sourceEdit.baseRevision,
            changes: [{
              type: 'write',
              path: sourceEdit.path,
              text: sourceEdit.text,
            }],
          },
          {
            projectId: sourceEdit.projectId,
            revision: sourceEdit.revision,
          },
          { projectId: sourceEdit.projectId },
          { projectId: sourceEdit.projectId },
        ])
        const userPrompts = currentEvents
          .filter(item => (
            item.event.type === 'user/message'
              && item.event.data.source?.kind === 'user'
          ))
          .map(item => item.event.data.content
            .filter(block => block.type === 'text')
            .map(block => block.text)
            .join(''))
        assert.deepEqual(userPrompts, replayPrompts)
        const assistantEvents = currentEvents
          .filter(item => item.event.type === 'assistant/message')
        assert.ok(assistantEvents.length >= 11)
        assert.ok(assistantEvents.every(item => (
          item.event.data.message.source.provider === 'deepseek-official'
            && item.event.data.message.source.model === 'deepseek-v4-flash'
        )))
        for (const toolCall of toolCalls) {
          assert.ok(assistantEvents.some(item => (
            item.event.data.turn === toolCall.turn
              && item.event.data.step === toolCall.step
              && item.event.data.message.source.provider === 'deepseek-official'
              && item.event.data.message.source.model === 'deepseek-v4-flash'
              && item.event.data.message.content.some(block => (
                block.type === 'tool-call'
                  && block.id === toolCall.callId
                  && block.name === toolCall.name
                  && block.arguments === toolCall.arguments
              ))
          )))
        }
        assert.ok(assistantEvents.every(item => (
          item.event.data.message.source.provider === 'deepseek-official'
            && item.event.data.message.source.model === 'deepseek-v4-flash'
        )))
        assert.ok(toolCalls.every(toolCall => (
          typeof toolCall.turn === 'number'
            && typeof toolCall.step === 'number'
        )))
        const diagnosticsResult = currentEvents.find(item => (
          item.event.type === 'tool/result'
            && item.event.data.message.source.callId === 'call_threejs_m8_check_runtime'
        ))
        const diagnosticsText = diagnosticsResult?.event.data.message.content
          .filter(block => (
            block.type === 'tool-result'
              && block.toolCallId === 'call_threejs_m8_check_runtime'
          ))
          .flatMap(block => block.content)
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('\n')
        assert.equal(
          diagnosticsText,
          `Checked ${sourceEdit.projectId} at revision ${sourceEdit.revision}: `
            + '0 errors, 0 warnings. '
            + `Diagnostics tested revision ${diagnostics.testedRevision} `
            + `with run ${diagnostics.runId}.`,
        )
        return {
          source: evidenceSource,
          handshake: 'fixture-tool-call-ids',
          sessionId,
          updatedAt: session.updatedAt,
          toolCallIds,
          provider: 'deepseek-official',
          model: 'deepseek-v4-flash',
          diagnosticsText,
        }
      }
    }
    await page.waitForTimeout(100)
  }
  throw new Error('deterministic Replay handshake was not observed')
}

async function callHarnessTool(name, arguments_) {
  const catalog = await (await fetch(`${webUrl}/api/mcp-apps/catalog`)).json()
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

async function callModelVisibleTool(name, arguments_) {
  const client = new Client({
    name: 'threejs-editor-mcp-m8-browser',
    version: '0.0.0',
  })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [resolve(projectRoot, 'dist/server.js'), '--root', projectsRoot],
  }))
  try {
    return await client.callTool({ name, arguments: arguments_ })
  } finally {
    await client.close()
  }
}

async function waitForInspectedObject(projectId, path) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const inspected = await callHarnessTool('inspect_editor', { projectId })
    const object = inspected.structuredContent.objects.find(candidate => candidate.path === path)
    if (object !== undefined) return object
    await page.waitForTimeout(100)
  }
  throw new Error(`Runtime object was not reported: ${path}`)
}

try {
  await verifyFailedStartDisposalHandshake()
  await page.goto(webUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  const mainFrameNavigationsAfterLoad = mainFrameNavigations
  await addWorkspace()
  const appFrames = page.locator('iframe[title="MCP App: mcp__threejs__open_editor"]')
  assert.equal(await appFrames.count(), 0)

  await sendPrompt(replayPrompts[0])
  const frost = await latestApp(
    'Touch-History Frost',
    'dev/example-gallery/examples/threejs-temporal-surfaces/touch-history-frost/scene.js',
    4,
  )
  assert.equal(await appFrames.count(), 1)
  assert.equal(mainFrameNavigations, mainFrameNavigationsAfterLoad)
  const replaySessionId = await findReplaySession('call_threejs_m8_frost')
  await page.getByTitle('Open mcp__threejs__open_editor fullscreen').last().click()
  await page.locator('[data-mcp-app-view][data-display-mode="fullscreen"]').waitFor()
  const frostCanvas = frost.runtimeFrame.locator('canvas')
  let frostBounds = await frostCanvas.boundingBox()
  assert.notEqual(frostBounds, null)
  const frostEdit = await runtimeMetrics(frost.appFrame)
  assert.equal(frostEdit.inputOwner, 'editor')
  assert.equal(frostEdit.runtimeInputListeners, 6)
  assert.equal(frostEdit.capturedPointers, 0)
  assert.equal(frostEdit.rendererCanvasFacade, true)
  assert.deepEqual(frostEdit.runtimeInputEvents, {})
  assert.equal(frostEdit.devicePixelRatio, expectedDpr)
  assert.ok(frostEdit.gpuTextures >= 8)
  assertHardwareRenderer(frostEdit)
  const frostFinalPixels = await pixelStats(frost.runtimeFrame)
  assert.ok(frostFinalPixels.lit > frostFinalPixels.sampled * 0.25)
  assert.ok(frostFinalPixels.colors > 128)
  const frostApp = await frost.appFrame.evaluate(() => globalThis.__THREE_M7__.metrics())
  assert.deepEqual(frostApp.m7.build.assets, frostAssets)
  await page.mouse.move(frostBounds.x + 80, frostBounds.y + 100)
  await page.mouse.down()
  await page.mouse.up()
  const frostEditAfterPointer = await runtimeMetrics(frost.appFrame)
  assert.deepEqual(frostEditAfterPointer.runtimeInputEvents, {})

  await frost.appFrame.evaluate(() => globalThis.__THREE_M7__.setM7DebugMode('deposit'))
  const frostRun = await playRuntime(frost.appFrame)
  assert.equal(frostRun.inputOwner, 'runtime')
  assert.equal(frostRun.runtimeInputListeners, frostEdit.runtimeInputListeners)
  assert.equal(frostRun.capturedPointers, 0)
  const stableTextures = frostRun.gpuTextures

  const frostBefore = digest(await frostCanvas.screenshot())
  await page.mouse.move(frostBounds.x + 120, frostBounds.y + 180)
  await page.mouse.down()
  await page.mouse.move(
    frostBounds.x + frostBounds.width - 120,
    frostBounds.y + frostBounds.height - 180,
    { steps: 24 },
  )
  await page.mouse.up()
  await waitForRuntimeFrames(frost.appFrame, 2)
  const frostDeposited = digest(await frostCanvas.screenshot())
  assert.notEqual(frostDeposited, frostBefore)
  const frostAfterPointer = await runtimeMetrics(frost.appFrame)
  assert.equal(frostAfterPointer.runtimeEventFacade, true)
  for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
    assert.ok(
      inputEventCount(frostAfterPointer, type) > inputEventCount(frostRun, type),
      `Frost runtime did not receive ${type}`,
    )
  }
  await frostCanvas.screenshot({ path: resolve(artifacts, 'm8-frost-deposit.png') })
  await frost.appFrame.evaluate(() => globalThis.__THREE_M7__.setM7TimeScale(0))
  const frostDepositDebug = digest(await frostCanvas.screenshot())
  const frostHistoryMode = await frost.appFrame.evaluate(
    () => globalThis.__THREE_M7__.setM7DebugMode('history-previous'),
  )
  assert.equal(frostHistoryMode.debugMode, 'history-previous')
  const frostHistoryDebug = digest(await frostCanvas.screenshot())
  assert.notEqual(frostHistoryDebug, frostDepositDebug)
  await frost.appFrame.evaluate(() => globalThis.__THREE_M7__.setM7DebugMode('deposit'))
  await frost.appFrame.evaluate(() => globalThis.__THREE_M7__.setM7TimeScale(1))

  await page.mouse.move(1, 1)
  await waitForRuntimeFrames(frost.appFrame, 2)
  const frostDecayStart = digest(await frostCanvas.screenshot())
  await waitForRuntimeFrames(frost.appFrame, 12)
  const frostDecayed = digest(await frostCanvas.screenshot())
  assert.notEqual(frostDecayed, frostDecayStart)

  const frostBeforeResize = await runtimeMetrics(frost.appFrame)
  await page.setViewportSize({ width: 1200, height: 820 })
  await page.waitForTimeout(500)
  frostBounds = await frostCanvas.boundingBox()
  assert.notEqual(frostBounds, null)
  const frostResized = await runtimeMetrics(frost.appFrame)
  assert.equal(frostResized.gpuTextures, stableTextures)
  assert.equal(frostResized.capturedPointers, 0)
  assert.ok(frostResized.resizeCount > frostBeforeResize.resizeCount)
  assert.deepEqual(
    frostResized.drawingBufferSize,
    frostResized.clientSize.map(value => Math.floor(value * expectedDpr)),
  )
  await waitForRuntimeFrames(frost.appFrame, 2)
  const frostReset = digest(await frostCanvas.screenshot())
  await waitForRuntimeFrames(frost.appFrame, 4)
  assert.equal(digest(await frostCanvas.screenshot()), frostReset)
  const frostResizeSettled = await runtimeMetrics(frost.appFrame)
  assert.equal(frostResizeSettled.resizeCount, frostResized.resizeCount)
  await page.mouse.move(frostBounds.x + 120, frostBounds.y + 180)
  await page.mouse.down()
  await page.mouse.move(
    frostBounds.x + frostBounds.width - 120,
    frostBounds.y + frostBounds.height - 180,
    { steps: 24 },
  )
  await page.mouse.up()
  await waitForRuntimeFrames(frost.appFrame, 2)
  await captureGifFrame('00-frost-deposit.png')

  for (let cycle = 0; cycle < 10; cycle += 1) {
    await frost.appFrame.getByRole('button', { name: 'Stop', exact: true }).click()
    await frost.appFrame.waitForFunction(() => (
      globalThis.__THREE_M7__.metrics().playState === 'editing'
    ))
    const stopped = await runtimeMetrics(frost.appFrame)
    assert.equal(stopped.inputOwner, 'editor')
    assert.equal(stopped.runtimeInputListeners, frostEdit.runtimeInputListeners)
    assert.equal(stopped.capturedPointers, 0)
    assert.equal(stopped.gpuTextures, stableTextures)
    await playRuntime(frost.appFrame)
  }
  await frost.appFrame.getByRole('button', { name: 'Stop', exact: true }).click()
  await frost.appFrame.waitForFunction(() => (
    globalThis.__THREE_M7__.metrics().playState === 'editing'
  ))
  assert.deepEqual(appProblems, [])
  await page.getByText('Locate in Chat', { exact: true }).click()

  await sendPrompt(replayPrompts[1])
  const pool = await latestApp(
    'Interactive Pool Volume',
    'dev/example-gallery/examples/threejs-water-optics/interactive-pool-volume/scene.js',
    6,
  )
  assert.equal(await appFrames.count(), 2)
  assert.equal(mainFrameNavigations, mainFrameNavigationsAfterLoad)
  await page.getByTitle('Open mcp__threejs__open_editor fullscreen').last().click()
  await page.locator('[data-mcp-app-view][data-display-mode="fullscreen"]').waitFor()
  const poolCanvas = pool.runtimeFrame.locator('canvas')
  const poolBounds = await poolCanvas.boundingBox()
  assert.notEqual(poolBounds, null)
  const poolEdit = await runtimeMetrics(pool.appFrame)
  assert.equal(poolEdit.inputOwner, 'editor')
  assert.equal(poolEdit.runtimeInputListeners, 4)
  assert.equal(poolEdit.capturedPointers, 0)
  assert.equal(poolEdit.rendererCanvasFacade, true)
  assert.equal(poolEdit.devicePixelRatio, expectedDpr)
  assert.ok(poolEdit.gpuTextures > 0)
  assertHardwareRenderer(poolEdit)
  const poolFinalPixels = await pixelStats(pool.runtimeFrame)
  assert.ok(poolFinalPixels.lit > poolFinalPixels.sampled * 0.25)
  assert.ok(poolFinalPixels.colors > 128)
  const poolApp = await pool.appFrame.evaluate(() => globalThis.__THREE_M7__.metrics())
  assert.deepEqual(poolApp.m7.build.assets, poolAssets)
  const poolProjectId = await pool.appFrame.evaluate(
    () => globalThis.__THREE_M7__.metrics().projectId,
  )
  assert.equal(typeof poolProjectId, 'string')
  const sourcePath =
    'dev/example-gallery/examples/threejs-water-optics/interactive-pool-volume/scene.js'
  const sourceResult = await callModelVisibleTool('read_project_files', {
    projectId: poolProjectId,
    files: [{ path: sourcePath }],
  })
  const source = sourceResult.structuredContent.files[0].text
  assert.equal(
    sourceResult.structuredContent.files[0].sha256,
    'ca9cfe84f61e00b41bdbe409108e96cf0e235aa1317c1456ed84e2c9aa38f73e',
  )
  assert.equal(source.match(/damping: 0\.995,/g)?.length, 1)
  await captureGifFrame('01-pool-edit.png')
  const sphere = await waitForInspectedObject(poolProjectId, 'scene/Mesh#2')
  await pool.appFrame.locator(`[data-object-uuid="${sphere.uuid}"]`).click()
  const selectedSphere = await runtimeMetrics(pool.appFrame)
  assert.equal(selectedSphere.selectedUuid, sphere.uuid)
  assert.ok(Array.isArray(selectedSphere.selectedScreenPosition))

  const poolBeforeDrag = await playRuntime(pool.appFrame)
  assert.equal(poolBeforeDrag.selectedUuid, sphere.uuid)
  const [sphereX, sphereY] = poolBeforeDrag.selectedScreenPosition
  await page.mouse.move(poolBounds.x + sphereX, poolBounds.y + sphereY)
  await page.mouse.down()
  await page.mouse.move(
    poolBounds.x + sphereX + 100,
    poolBounds.y + sphereY - 40,
    { steps: 20 },
  )
  const poolDragging = await runtimeMetrics(pool.appFrame)
  assert.equal(poolDragging.capturedPointers, 1)
  await page.mouse.up()
  await page.waitForTimeout(300)
  const poolAfterDrag = await runtimeMetrics(pool.appFrame)
  assert.equal(poolAfterDrag.capturedPointers, 0)
  assert.equal(poolAfterDrag.runtimeEventFacade, true)
  assert.equal(poolAfterDrag.selectedUuid, sphere.uuid)
  assert.deepEqual(poolAfterDrag.cameraPosition, poolBeforeDrag.cameraPosition)
  assert.ok(Math.hypot(...poolAfterDrag.selectedBoundsCenter.map(
    (value, index) => value - poolBeforeDrag.selectedBoundsCenter[index],
  )) > 0.05)
  for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
    assert.ok(
      inputEventCount(poolAfterDrag, type) > inputEventCount(poolBeforeDrag, type),
      `Pool runtime did not receive ${type}`,
    )
  }
  await captureGifFrame('02-pool-dragged.png')

  await pool.appFrame.evaluate(() => globalThis.__THREE_M7__.setM7DebugMode('height'))
  const frozen = await pool.appFrame.evaluate(() => globalThis.__THREE_M7__.setM7TimeScale(0))
  assert.equal(frozen.timeScale, 0)
  await waitForRuntimeFrames(pool.appFrame, 2)
  const poolBefore = digest(await poolCanvas.screenshot())
  await waitForRuntimeFrames(pool.appFrame, 2)
  assert.equal(digest(await poolCanvas.screenshot()), poolBefore)
  const poolBeforeDrop = await runtimeMetrics(pool.appFrame)
  await page.mouse.move(
    poolBounds.x + poolBounds.width * 0.35,
    poolBounds.y + poolBounds.height * 0.4,
  )
  await page.mouse.down()
  await page.mouse.move(
    poolBounds.x + poolBounds.width * 0.45,
    poolBounds.y + poolBounds.height * 0.5,
    { steps: 8 },
  )
  await page.mouse.up()
  await waitForRuntimeFrames(pool.appFrame, 2)
  const poolAfter = digest(await poolCanvas.screenshot())
  const poolAfterDrop = await runtimeMetrics(pool.appFrame)
  assert.notEqual(poolAfter, poolBefore)
  assert.ok(
    inputEventCount(poolAfterDrop, 'pointerdown') > inputEventCount(poolBeforeDrop, 'pointerdown'),
  )

  await pool.appFrame.evaluate(() => globalThis.__THREE_M7__.setM7TimeScale(1))
  await waitForRuntimeFrames(pool.appFrame, 2)
  const poolWaveStart = digest(await poolCanvas.screenshot())
  await waitForRuntimeFrames(pool.appFrame, 8)
  const poolWaveEnd = digest(await poolCanvas.screenshot())
  assert.notEqual(poolWaveEnd, poolWaveStart)

  const debugFrozen = await pool.appFrame.evaluate(
    () => globalThis.__THREE_M7__.setM7TimeScale(0),
  )
  assert.equal(debugFrozen.timeScale, 0)
  const debugHashes = {}
  for (const mode of ['height', 'normals', 'caustics']) {
    const changed = await pool.appFrame.evaluate(
      value => globalThis.__THREE_M7__.setM7DebugMode(value),
      mode,
    )
    assert.equal(changed.debugMode, mode)
    debugHashes[mode] = digest(await poolCanvas.screenshot())
  }
  assert.equal(new Set(Object.values(debugHashes)).size, 3)
  const poolRun = await runtimeMetrics(pool.appFrame)
  assert.equal(poolRun.inputOwner, 'runtime')
  assert.equal(poolRun.runtimeInputListeners, poolEdit.runtimeInputListeners)
  assert.equal(poolRun.capturedPointers, 0)
  await poolCanvas.screenshot({ path: resolve(artifacts, 'm8-pool-caustics.png') })
  await captureGifFrame('03-pool-caustics.png')
  await pool.appFrame.evaluate(() => globalThis.__THREE_M7__.setM7DebugMode('final'))
  const poolFinalHash = digest(await poolCanvas.screenshot())
  assert.notEqual(poolFinalHash, debugHashes.caustics)
  const poolFinalAfterDebug = await pixelStats(pool.runtimeFrame)
  assert.ok(poolFinalAfterDebug.lit > poolFinalAfterDebug.sampled * 0.25)
  assert.ok(poolFinalAfterDebug.colors > 128)
  await pool.appFrame.getByRole('button', { name: 'Stop', exact: true }).click()
  await pool.appFrame.waitForFunction(() => (
    globalThis.__THREE_M7__.metrics().playState === 'editing'
  ))
  const poolStopped = await runtimeMetrics(pool.appFrame)
  assert.equal(poolStopped.inputOwner, 'editor')
  assert.equal(poolStopped.runtimeInputListeners, poolEdit.runtimeInputListeners)
  assert.equal(poolStopped.capturedPointers, 0)
  assert.equal(poolStopped.selectedUuid, sphere.uuid)

  const beforeHuman = await pool.appFrame.evaluate(() => globalThis.__THREE_M7__.metrics())
  const positionY = pool.appFrame.getByRole('spinbutton', { name: 'Position Y' })
  await positionY.fill('-0.68')
  await positionY.press('Enter')
  await pool.appFrame.getByRole('button', { name: 'Save', exact: true }).click()
  await pool.appFrame.waitForFunction(previous => {
    const metrics = globalThis.__THREE_M7__.metrics()
    return metrics.sync === 'clean'
      && metrics.revision !== previous
      && metrics.playState === 'editing'
  }, beforeHuman.revision, { timeout: 120_000 })
  const human = await pool.appFrame.evaluate(() => globalThis.__THREE_M7__.metrics())

  const fixedSource = source.replace('damping: 0.995,', 'damping: 0.992,')
  assert.notEqual(fixedSource, source)
  let delayedReloadBuild = false
  let finishDelayedReloadRequest = () => {}
  const delayedReloadRequest = new Promise(resolve => {
    finishDelayedReloadRequest = () => resolve()
  })
  const delayReloadBuild = async route => {
    const request = route.request()
    const body = request.postDataJSON()
    if (!delayedReloadBuild && body?.name === 'build_project') {
      delayedReloadBuild = true
      await new Promise(resolveDelay => setTimeout(resolveDelay, 12_000))
      try {
        await route.continue()
      } finally {
        finishDelayedReloadRequest()
      }
      return
    }
    await route.continue()
  }
  await page.route('**/api/mcp-apps/tool', delayReloadBuild)
  const sourceFixPrompt =
    `读取并修复 Interactive Pool Volume 的波纹衰减参数；`
    + `projectId=${poolProjectId} baseRevision=${human.revision}`
  replayPrompts.push(sourceFixPrompt)
  await sendPrompt(sourceFixPrompt)
  await pool.appFrame.waitForFunction(previousRevision => {
    const metrics = globalThis.__THREE_M7__.metrics()
    return metrics.revision !== previousRevision && metrics.playState === 'starting'
  }, human.revision, { timeout: 120_000 })
  const sourceRevision = (await pool.appFrame.evaluate(
    () => globalThis.__THREE_M7__.metrics(),
  )).revision
  const delayedBuildDeadline = Date.now() + 30_000
  while (!delayedReloadBuild && Date.now() < delayedBuildDeadline) {
    await page.waitForTimeout(10)
  }
  assert.equal(delayedReloadBuild, true)
  const stopStartedAt = Date.now()
  await pool.appFrame.getByRole('button', { name: 'Stop', exact: true }).click()
  await pool.appFrame.waitForFunction(() => (
    globalThis.__THREE_M7__.metrics().playState === 'stopped'
  ), undefined, { timeout: 15_000 })
  assert.ok(Date.now() - stopStartedAt < 11_500)
  await delayedReloadRequest
  await page.unroute('**/api/mcp-apps/tool', delayReloadBuild)
  const cancelledReload = await pool.appFrame.evaluate(() => globalThis.__THREE_M7__.metrics())
  assert.equal(cancelledReload.m7.active, false)
  assert.equal(cancelledReload.m7.runtimeFrameVisible, false)
  await playRuntime(pool.appFrame)
  await pool.appFrame.getByRole('button', { name: 'Stop', exact: true }).click()
  await pool.appFrame.waitForFunction(() => {
    const metrics = globalThis.__THREE_M7__.metrics()
    return metrics.playState === 'editing'
      && metrics.m7.ready?.mode === 'run'
      && metrics.m7.build?.revision === metrics.revision
  }, undefined, { timeout: 120_000 })
  const reloaded = await pool.appFrame.evaluate(() => globalThis.__THREE_M7__.metrics())
  assert.notEqual(reloaded.m7.runId, human.m7.runId)
  assert.notEqual(reloaded.m7.build.buildId, human.m7.build.buildId)
  assert.equal(reloaded.m7.lastDispose.runId, human.m7.runId)
  assert.equal(reloaded.m7.lastDispose.inputListenersAfterExampleDispose, 0)
  assert.equal(reloaded.m7.lastDispose.runtimeInputListenersAfterDispose, 0)
  assert.equal(reloaded.m7.lastDispose.capturedPointersAfterDispose, 0)
  assert.equal(reloaded.m7.lastDispose.rendererDisposed, true)
  assert.equal(reloaded.m7.lastDispose.disposeError, undefined)
  const reloadedFinalPixels = await pixelStats(pool.runtimeFrame)
  assert.ok(reloadedFinalPixels.lit > reloadedFinalPixels.sampled * 0.25)
  assert.ok(reloadedFinalPixels.colors > 128)
  const persisted = await callModelVisibleTool('read_project_files', {
    projectId: poolProjectId,
    files: [{ path: sourcePath }, { path: 'threejs.editor.json' }],
  })
  const persistedSource = persisted.structuredContent.files.find(file => file.path === sourcePath)
  const persistedEditor = persisted.structuredContent.files.find(
    file => file.path === 'threejs.editor.json',
  )
  assert.match(persistedSource.text, /damping: 0\.992,/)
  assert.ok(JSON.parse(persistedEditor.text).operations.some(operation => (
    operation.objectUuid === sphere.uuid
      && operation.type === 'set_position'
      && operation.value[1] === -0.68
  )))
  const reloadedSphere = await waitForInspectedObject(poolProjectId, 'scene/Mesh#2')
  assert.equal(reloadedSphere.position[1], -0.68)
  await page.waitForTimeout(300)
  assert.equal(
    (await pool.appFrame.evaluate(() => globalThis.__THREE_M7__.metrics()))
      .m7.messagesAfterStop,
    0,
  )
  await captureGifFrame('04-pool-clean-reload.png')

  await playRuntime(pool.appFrame)
  await pool.appFrame.getByRole('button', { name: 'Stop', exact: true }).click()
  await pool.appFrame.getByText('Stopped; diagnostics recorded', { exact: true })
    .waitFor({ timeout: 30_000 })
  const checked = {
    revision: sourceRevision,
    ...JSON.parse(readFileSync(resolve(
      projectsRoot,
      '.managed-workspaces',
      poolProjectId,
      '.threejs-editor',
      'diagnostics',
      'runtime.json',
    ), 'utf8')),
  }
  assert.equal(checked.testedRevision, sourceRevision)
  assert.equal(checked.runId, reloaded.m7.runId)
  assert.deepEqual(checked.errors, [])
  assert.deepEqual(checked.warnings, [])
  assert.deepEqual(appProblems, [])
  const diagnosticsPrompt =
    `检查 Interactive Pool Volume 最终运行诊断；projectId=${poolProjectId} `
    + `testedRevision=${checked.testedRevision} runId=${checked.runId}`
  replayPrompts.push(diagnosticsPrompt)
  await sendPrompt(diagnosticsPrompt)
  const replay = await replayEvidence(replaySessionId, {
    projectId: poolProjectId,
    baseRevision: human.revision,
    revision: sourceRevision,
    path: sourcePath,
    text: fixedSource,
  }, checked)
  assert.equal(await appFrames.count(), 2)
  assert.equal(mainFrameNavigations, mainFrameNavigationsAfterLoad)
  assert.deepEqual(readdirSync(gifFrames).sort(), gifFrameNames)
  const poolFinal = await pool.appFrame.evaluate(() => globalThis.__THREE_M7__.metrics())

  const sceneProjectId = 'm8-runtime-cleanup-scene'
  const createdScene = await callModelVisibleTool('create_project', {
    projectId: sceneProjectId,
    title: 'M8 Runtime Cleanup Scene',
    template: 'empty',
  })
  assert.equal(createdScene.isError, undefined)
  await pool.appFrame.evaluate(
    nextProjectId => globalThis.__THREE_M7__.loadProject(nextProjectId),
    sceneProjectId,
  )
  await pool.appFrame.waitForFunction(nextProjectId => {
    const metrics = globalThis.__THREE_M7__.metrics()
    return metrics.projectId === nextProjectId
      && metrics.workspaceKind === undefined
      && metrics.playState === 'stopped'
      && metrics.m7.active === false
      && metrics.m7.runtimeFrameVisible === false
  }, sceneProjectId)
  assert.equal(readFileSync(resolve(
    projectsRoot,
    '.managed-workspaces',
    poolProjectId,
    '.threejs-editor',
    'diagnostics',
    'active-run.json',
  )).length, 0)

  process.stdout.write(`${JSON.stringify({
    frost: {
      buildId: frost.appFrame
        ? (await frost.appFrame.evaluate(() => globalThis.__THREE_M7__.metrics())).m7.build.buildId
        : undefined,
      assets: 4,
      inputListeners: frostEdit.runtimeInputListeners,
      gpuTextures: stableTextures,
      gpuRenderer: frostEdit.gpuRenderer,
      pointerChangedHistory: true,
      historyDecayed: true,
      resizeResetHistory: true,
      resizeStable: true,
      playStopCycles: 10,
    },
    pool: {
      buildId: poolFinal.m7.build.buildId,
      assets: 6,
      inputListeners: poolEdit.runtimeInputListeners,
      gpuRenderer: poolEdit.gpuRenderer,
      sphereMoved: true,
      pointerChangedHeightfield: true,
      wavePropagated: true,
      revisions: {
        initial: beforeHuman.revision,
        human: human.revision,
        assistantSourceEdit: sourceRevision,
      },
      evidence: {
        transport: replay,
        sourceEditActor: 'replay-assistant-tool-call',
      },
      cleanReload: {
        previousRunId: human.m7.runId,
        runId: reloaded.m7.runId,
        buildId: reloaded.m7.build.buildId,
        lastDispose: reloaded.m7.lastDispose,
      },
      diagnostics: checked,
      debugHashes,
      finalHash: poolFinalHash,
      corpusCommit,
      sceneCleanup: {
        projectId: sceneProjectId,
        previousRunId: poolFinal.m7.runId,
      },
    },
    startupFailureDisposal: true,
    mcpAppCards: {
      initial: 0,
      afterFirstOpen: 1,
      afterSecondOpen: 2,
      afterEditWithoutOpen: 2,
      mainFrameNavigations,
    },
    appProblems,
  }, null, 2)}\n`)
} finally {
  await browser.close()
}
