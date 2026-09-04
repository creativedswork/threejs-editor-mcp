import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { chromium } from 'playwright'
import { m7BootstrapHtml } from '../src/m7-runtime.ts'

const corpus = process.env.THREEJS_EDITOR_MCP_WORKSPACE
if (corpus === undefined) throw new Error('THREEJS_EDITOR_MCP_WORKSPACE is required')
const artifactRoot = resolve(process.env.M10_ARTIFACTS ?? '.playwright-mcp/m10')
const resultPath = resolve(process.env.M10_RESULT ?? '.playwright-mcp/m10-result.json')
const selectedCase = process.env.M10_CASE ?? 'all'
assert.ok(['all', 'p6', 'g1', 'capability'].includes(selectedCase), `invalid M10_CASE: ${selectedCase}`)
const root = await mkdtemp(join(tmpdir(), 'threejs-editor-m10-browser-'))
const p6Workspace = join(root, 'p6')
const g1Workspace = join(root, 'g1')
const serverPath = fileURLToPath(new URL('../dist/server.js', import.meta.url))
const repository = fileURLToPath(new URL('..', import.meta.url))

execFileSync(process.execPath, [
  fileURLToPath(new URL('../scripts/prepare-m10-p6.mjs', import.meta.url)),
  corpus,
  p6Workspace,
], { cwd: repository, stdio: 'pipe' })
execFileSync(process.execPath, [
  fileURLToPath(new URL('../scripts/prepare-m10-g1.mjs', import.meta.url)),
  g1Workspace,
], { cwd: repository, stdio: 'pipe' })
await mkdir(join(artifactRoot, 'p6'), { recursive: true })
await mkdir(join(artifactRoot, 'g1'), { recursive: true })

const client = new Client({ name: 'threejs-editor-m10-browser', version: '0.0.0' })
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [serverPath, '--root', join(root, 'store')],
}))
const webServer = createServer((_request, response) => {
  response.writeHead(200, {
    'content-security-policy': "connect-src 'self'",
    'content-type': 'text/html; charset=utf-8',
  })
  response.end('<!doctype html><title>M10 Runtime Harness</title>')
})
await new Promise(resolveListen => webServer.listen(0, '127.0.0.1', resolveListen))
const address = webServer.address()
if (address === null || typeof address === 'string') throw new Error('browser server did not bind')

const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM_PATH === undefined
    ? { channel: 'chrome' }
    : { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }),
  headless: true,
  args: process.platform === 'darwin' ? ['--use-angle=metal'] : [],
})
const page = await browser.newPage({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  locale: 'en-US',
})
const browserProblems = []
page.on('console', message => {
  if (message.type() === 'error' || message.type() === 'warning') {
    browserProblems.push(`${message.type()}: ${message.text()}`)
  }
})
page.on('pageerror', error => browserProblems.push(`pageerror: ${error.message}`))
if (selectedCase === 'capability') {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'gpu', {
      configurable: true,
      get: () => undefined,
    })
  })
}
await page.goto(`http://127.0.0.1:${String(address.port)}`)

async function resourceText(uri) {
  return (await client.readResource({ uri })).contents[0].text
}

async function buildWorkspace(workspace) {
  const opened = await client.callTool({
    name: 'open_editor',
    arguments: {},
    _meta: { 'ai.deepseek.dsh/workspace': { cwd: workspace } },
  })
  assert.equal(opened.isError, undefined, JSON.stringify(opened))
  const built = await client.callTool({
    name: 'build_project',
    arguments: {
      projectId: opened.structuredContent.projectId,
      revision: opened.structuredContent.revision,
    },
  })
  assert.equal(built.structuredContent.status, 'ready', JSON.stringify(built))
  const assets = []
  for (const asset of built.structuredContent.assets) {
    if (asset.resourceUri === undefined) continue
    const chunks = []
    for (let index = 0; index < asset.chunks; index += 1) {
      const result = await client.readResource({ uri: `${asset.resourceUri}/${index}` })
      chunks.push(Buffer.from(result.contents[0].blob, 'base64'))
    }
    const bytes = Buffer.concat(chunks)
    assert.equal(bytes.length, asset.size)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256)
    assets.push({
      sha256: asset.sha256,
      mediaType: asset.mediaType,
      base64: bytes.toString('base64'),
    })
  }
  return {
    projectId: opened.structuredContent.projectId,
    revision: opened.structuredContent.revision,
    build: built.structuredContent,
    bundle: await resourceText(built.structuredContent.bundleUri),
    assets,
  }
}

async function lastEvent(run, types) {
  return page.evaluate(({ identity, accepted }) => (
    globalThis.__m10Events.filter(event => (
      event.runId === identity.runId
        && event.nonce === identity.nonce
        && accepted.includes(event.type)
    )).at(-1)
  ), { identity: run, accepted: types })
}

async function loadRuntime(candidate, debugMode = 'final', expectFailure = false) {
  await page.setContent(
    '<style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style>'
      + '<iframe title="M10 Runtime" sandbox="allow-scripts"></iframe>',
  )
  const iframe = page.locator('iframe')
  await iframe.evaluate((element, html) => {
    element.srcdoc = html
  }, m7BootstrapHtml())
  const frame = await (await iframe.elementHandle()).contentFrame()
  assert.notEqual(frame, null)
  await frame.waitForSelector('canvas')
  const run = {
    projectId: candidate.projectId,
    revision: candidate.revision,
    runId: randomUUID(),
    nonce: randomUUID(),
    evidenceToken: randomUUID(),
  }
  await page.evaluate(({ request, bundle, assets }) => {
    globalThis.__m10Events = []
    globalThis.addEventListener('message', event => {
      if (event.data?.channel === 'threejs-editor-m7-runtime') {
        globalThis.__m10Events.push(event.data)
      }
    })
    const payload = assets.map(asset => {
      const raw = atob(asset.base64)
      return {
        sha256: asset.sha256,
        mediaType: asset.mediaType,
        bytes: Uint8Array.from(raw, value => value.charCodeAt(0)).buffer,
      }
    })
    document.querySelector('iframe').contentWindow.postMessage({
      channel: 'threejs-editor-m7-runtime',
      action: 'run',
      ...request,
      bundle,
      assets: payload,
      mode: 'run',
      buildId: request.buildId,
    }, '*')
  }, {
    request: { ...run, debugMode, buildId: candidate.build.buildId },
    bundle: candidate.bundle,
    assets: candidate.assets,
  })
  await page.waitForFunction(identity => globalThis.__m10Events.some(event => (
    event.runId === identity.runId
      && event.nonce === identity.nonce
      && (event.type === 'ready' || event.type === 'runtime-error')
  )), run, { timeout: 120_000 })
  const startup = await lastEvent(run, ['ready', 'runtime-error'])
  assert.equal(startup.type, expectFailure ? 'runtime-error' : 'ready', JSON.stringify(startup))
  return { frame, run, startup }
}

async function command(run, action, payload = {}, types = [action]) {
  const offset = await page.evaluate(() => globalThis.__m10Events.length)
  await page.locator('iframe').evaluate((element, request) => {
    element.contentWindow.postMessage({
      channel: 'threejs-editor-m7-runtime',
      ...request,
    }, '*')
  }, { ...run, action, ...payload })
  await page.waitForFunction(({ identity, accepted, start }) => (
    globalThis.__m10Events.slice(start).some(event => (
      event.runId === identity.runId
        && event.nonce === identity.nonce
        && accepted.includes(event.type)
    ))
  ), { identity: run, accepted: types, start: offset }, { timeout: 120_000 })
  return lastEvent(run, types)
}

async function metrics(run) {
  return (await command(run, 'metrics', {}, ['metrics'])).data
}

async function setDebug(run, debugMode) {
  return command(run, 'set-debug', { debugMode }, ['debug-mode'])
}

async function waitFrames(run, frames) {
  const commandId = randomUUID()
  const event = await command(run, 'harness-command', {
    commandId,
    kind: 'simulate-actions',
    target: 'validation',
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    actions: [{ type: 'waitFrames', frames }],
  }, ['harness-result', 'harness-error'])
  assert.equal(event.type, 'harness-result', JSON.stringify(event))
}

async function screenshot(caseName, name) {
  const path = join(artifactRoot, caseName, name)
  await page.locator('iframe').screenshot({ path })
  return path
}

async function stop(run) {
  return command(run, 'stop', {}, ['disposed'])
}

try {
  const result = { browserProblems }
  if (selectedCase === 'capability') {
    const p6 = await buildWorkspace(p6Workspace)
    const failed = await loadRuntime(p6, 'final', true)
    assert.equal(failed.startup.data.code, 'WEBGPU_UNAVAILABLE')
    assert.deepEqual(failed.startup.data.capability, {
      backend: 'webgpu',
      available: false,
      secureContext: true,
      webgpuApi: false,
      code: 'WEBGPU_UNAVAILABLE',
      message: 'WebGPU is unavailable in this browser or GPU environment',
    })
    result.capabilityFailure = {
      revision: p6.revision,
      buildId: p6.build.buildId,
      runId: failed.run.runId,
      error: failed.startup.data,
    }
  }

  if (selectedCase === 'all' || selectedCase === 'p6') {
    const p6 = await buildWorkspace(p6Workspace)
    const first = await loadRuntime(p6)
    await waitFrames(first.run, 60)
    const current = await metrics(first.run)
    assert.equal(current.capabilities.available, true)
    assert.equal(current.capabilities.backend, 'webgpu')
    assert.equal(current.rendererBackend, 'WebGPUBackend')
    assert.equal(current.gpuResources, 1)
    assert.equal(current.pressureIterations, 4)
    assert.match(current.renderGrid, /^\d+×\d+×\d+$/)
    await screenshot('p6', '00-final.png')
    await setDebug(first.run, 'temperature')
    await screenshot('p6', '01-temperature.png')
    await setDebug(first.run, 'colliders')
    await screenshot('p6', '02-colliders.png')
    const disposed = await stop(first.run)
    assert.equal(disposed.data.gpuResourcesAfterDispose, 0)
    assert.equal(disposed.data.gpuResourcesDisposed, 1)
    const restarted = await loadRuntime(p6)
    assert.notEqual(restarted.run.runId, first.run.runId)
    await stop(restarted.run)
    result.p6 = {
      revision: p6.revision,
      buildId: p6.build.buildId,
      runIds: [first.run.runId, restarted.run.runId],
      metrics: current,
      teardown: disposed.data,
    }
  }

  if (selectedCase === 'all' || selectedCase === 'g1') {
    const g1 = await buildWorkspace(g1Workspace)
    await writeFile(join(artifactRoot, 'g1', 'bundle.js'), g1.bundle)
    const first = await loadRuntime(g1)
    await waitFrames(first.run, 15)
    const initial = await metrics(first.run)
    assert.equal(initial.gltfSkin, true)
    assert.equal(initial.animationClips, 1)
    assert.equal(initial.morphTargets, 1)
    await screenshot('g1', '00-running.png')

    const canvas = first.frame.locator('canvas')
    await canvas.click({ position: { x: 640, y: 400 } })
    await page.keyboard.down('KeyW')
    await waitFrames(first.run, 30)
    await page.keyboard.up('KeyW')
    const moved = await metrics(first.run)
    assert.ok(moved.playerPosition[2] < initial.playerPosition[2] - 0.05)
    assert.equal(moved.audioUnlocked, true)
    assert.equal(moved.audioState, 'running')
    await screenshot('g1', '01-moved-audio.png')

    await command(first.run, 'set-time-scale', { timeScale: 0 }, ['time-scale'])
    const pauseStart = await metrics(first.run)
    await waitFrames(first.run, 2)
    const paused = await metrics(first.run)
    assert.equal(paused.paused, true)
    assert.deepEqual(paused.playerPosition, pauseStart.playerPosition)
    await command(first.run, 'set-time-scale', { timeScale: 1 }, ['time-scale'])
    await waitFrames(first.run, 2)
    assert.equal((await metrics(first.run)).paused, false)
    await setDebug(first.run, 'skeleton')
    await screenshot('g1', '02-skeleton.png')

    await stop(first.run)
    const second = await loadRuntime(g1)
    const restarted = await metrics(second.run)
    assert.notEqual(second.run.runId, first.run.runId)
    assert.deepEqual(restarted.playerPosition, [0, 0, 0])
    await stop(second.run)
    result.g1 = {
      revision: g1.revision,
      buildId: g1.build.buildId,
      runIds: [first.run.runId, second.run.runId],
      initial,
      moved,
      paused,
      restarted,
    }
  }
  await mkdir(resolve(resultPath, '..'), { recursive: true })
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`)
  assert.deepEqual(browserProblems, [])
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} finally {
  await browser.close()
  await client.close()
  await new Promise(resolveClose => webServer.close(resolveClose))
  await rm(root, { recursive: true, force: true })
}
