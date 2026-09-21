import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { chromium } from 'playwright'
import { workspaceRuntimeHtml } from '../src/workspace-runtime.ts'

const corpusRoot = resolve(process.env.THREEJS_EDITOR_MCP_WORKSPACE ?? '')
if (corpusRoot === resolve('')) throw new Error('THREEJS_EDITOR_MCP_WORKSPACE is required')
const artifactRoot = resolve(process.env.M9_ARTIFACTS ?? 'reports/assets')
const resultPath = process.env.M9_RESULT
const selectedCase = process.env.M9_CASE ?? 'all'
assert.ok(['all', 'ocean', 'clouds'].includes(selectedCase), `invalid M9_CASE: ${selectedCase}`)
const serverPath = fileURLToPath(new URL('../dist/server.js', import.meta.url))
const projectRoot = await mkdtemp(join(tmpdir(), 'threejs-editor-m9-browser-'))
await mkdir(artifactRoot, { recursive: true })

const client = new Client({ name: 'threejs-editor-m9-browser', version: '0.0.0' })
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [serverPath, '--root', projectRoot],
}))
const webServer = createServer((_request, response) => {
  response.writeHead(200, {
    'content-security-policy': "connect-src 'self'",
    'content-type': 'text/html; charset=utf-8',
  })
  response.end('<!doctype html><title>M9 Runtime Harness</title>')
})
await new Promise(resolve => webServer.listen(0, '127.0.0.1', resolve))
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
  locale: 'zh-CN',
})
await page.goto(`http://127.0.0.1:${String(address.port)}`)
const browserProblems = []
page.on('console', message => {
  if (message.type() === 'error' || message.type() === 'warning') {
    browserProblems.push(`${message.type()}: ${message.text()}`)
  }
})
page.on('pageerror', error => browserProblems.push(`pageerror: ${error.message}`))

async function resourceText(uri) {
  const result = await client.readResource({ uri })
  return result.contents[0].text
}

async function buildCase(projectPath) {
  const opened = await client.callTool({
    name: 'open_editor',
    arguments: { projectPath },
    _meta: { 'ai.deepseek.dsh/workspace': { cwd: corpusRoot } },
  })
  assert.equal(opened.isError, undefined, JSON.stringify(opened))
  const projectId = opened.structuredContent.projectId
  const revision = opened.structuredContent.revision
  const built = await client.callTool({
    name: 'build_project',
    arguments: { projectId, revision },
  })
  assert.equal(built.structuredContent.status, 'ready', JSON.stringify(built))
  assert.equal(built.structuredContent.revision, revision)
  const assets = []
  let transferredBytes = 0
  let transferredChunks = 0
  for (const asset of built.structuredContent.assets) {
    if (asset.resourceUri === undefined) continue
    const chunks = []
    for (let index = 0; index < asset.chunks; index += 1) {
      const result = await client.readResource({ uri: `${asset.resourceUri}/${index}` })
      const bytes = Buffer.from(result.contents[0].blob, 'base64')
      chunks.push(bytes)
      transferredBytes += bytes.length
      transferredChunks += 1
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
    projectId,
    revision,
    build: built.structuredContent,
    bundle: await resourceText(built.structuredContent.bundleUri),
    assets,
    transfer: { bytes: transferredBytes, chunks: transferredChunks },
  }
}

async function loadRuntime(candidate, debugMode = 'final') {
  await page.setContent(
    '<style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style>'
      + '<iframe title="M9 Runtime" sandbox="allow-scripts"></iframe>',
  )
  const iframe = page.locator('iframe')
  await iframe.evaluate((frame, html) => {
    frame.srcdoc = html
  }, workspaceRuntimeHtml())
  const frame = await (await iframe.elementHandle()).contentFrame()
  assert.notEqual(frame, null)
  await frame.waitForSelector('canvas')
  const run = {
    projectId: candidate.projectId,
    revision: candidate.revision,
    runId: randomUUID(),
    nonce: randomUUID(),
  }
  const evidenceToken = randomUUID()
  await page.evaluate(({ request, bundle, assets }) => {
    globalThis.__m9Events = []
    globalThis.addEventListener('message', event => {
      if (event.data?.channel === 'threejs-editor-m7-runtime') {
        globalThis.__m9Events.push(event.data)
      }
    })
    const payload = assets.map(asset => {
      const raw = atob(asset.base64)
      return {
        sha256: asset.sha256,
        mediaType: asset.mediaType,
        bytes: Uint8Array.from(raw, character => character.charCodeAt(0)).buffer,
      }
    })
    document.querySelector('iframe').contentWindow.postMessage({
      channel: 'threejs-editor-m7-runtime',
      action: 'run',
      ...request,
      bundle,
      assets: payload,
      debugMode: request.debugMode,
      mode: 'run',
      evidenceToken: request.evidenceToken,
      buildId: request.buildId,
    }, '*')
  }, {
    request: {
      ...run,
      debugMode,
      evidenceToken,
      buildId: candidate.build.buildId,
    },
    bundle: candidate.bundle,
    assets: candidate.assets,
  })
  await page.waitForFunction(identity => globalThis.__m9Events.some(event => (
    event.runId === identity.runId
      && event.nonce === identity.nonce
      && (event.type === 'ready' || event.type === 'runtime-error')
  )), run, { timeout: 120_000 })
  const startup = await lastEvent(run, ['ready', 'runtime-error'])
  assert.equal(startup.type, 'ready', JSON.stringify(startup))
  return { frame, run, evidenceToken, startup }
}

async function lastEvent(run, types, commandId) {
  return page.evaluate(({ identity, accepted, expectedCommand }) => {
    const events = globalThis.__m9Events.filter(event => (
      event.projectId === identity.projectId
        && event.revision === identity.revision
        && event.runId === identity.runId
        && event.nonce === identity.nonce
        && accepted.includes(event.type)
        && (expectedCommand === undefined || event.data?.commandId === expectedCommand)
    ))
    return events.at(-1)
  }, { identity: run, accepted: types, expectedCommand: commandId })
}

async function command(run, action, payload = {}, types = [action]) {
  const before = await page.evaluate(() => globalThis.__m9Events.length)
  await page.locator('iframe').evaluate((frame, request) => {
    frame.contentWindow.postMessage({
      channel: 'threejs-editor-m7-runtime',
      ...request,
    }, '*')
  }, { ...run, action, ...payload })
  await page.waitForFunction(({ offset, identity, accepted, commandId }) => (
    globalThis.__m9Events.slice(offset).some(event => (
      event.runId === identity.runId
        && event.nonce === identity.nonce
        && accepted.includes(event.type)
        && (commandId === undefined || event.data?.commandId === commandId)
    ))
  ), {
    offset: before,
    identity: run,
    accepted: types,
    commandId: payload.commandId,
  }, { timeout: 120_000 })
  return lastEvent(run, types, payload.commandId)
}

async function metrics(run) {
  return (await command(run, 'metrics', {}, ['metrics'])).data
}

async function setDebug(run, mode) {
  await command(run, 'set-debug', { debugMode: mode }, ['debug-mode'])
  await page.waitForTimeout(300)
}

async function screenshot(name) {
  const path = join(artifactRoot, name)
  await page.locator('iframe').screenshot({ path })
  return path
}

async function pixelStats(frame) {
  return frame.evaluate(() => {
    const source = document.querySelector('canvas')
    const sample = document.createElement('canvas')
    sample.width = 256
    sample.height = 160
    const context = sample.getContext('2d', { willReadFrequently: true })
    context.drawImage(source, 0, 0, sample.width, sample.height)
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
    return { sampled: pixels.length / 16, lit, colors: colors.size }
  })
}

async function sampledPixels(frame) {
  return frame.evaluate(() => {
    const source = document.querySelector('canvas')
    const sample = document.createElement('canvas')
    sample.width = 128
    sample.height = 80
    const context = sample.getContext('2d', { willReadFrequently: true })
    context.drawImage(source, 0, 0, sample.width, sample.height)
    return [...context.getImageData(0, 0, sample.width, sample.height).data]
  })
}

function pixelDifference(left, right) {
  assert.equal(left.length, right.length)
  let changed = 0
  let total = 0
  for (let index = 0; index < left.length; index += 4) {
    const difference = Math.abs(left[index] - right[index])
      + Math.abs(left[index + 1] - right[index + 1])
      + Math.abs(left[index + 2] - right[index + 2])
    if (difference >= 24) changed += 1
    total += difference
  }
  return {
    changedRatio: changed / (left.length / 4),
    meanAbsoluteDifference: total / (left.length / 4 * 3),
  }
}

async function deterministicCapture(run) {
  const commandId = randomUUID()
  const event = await command(run, 'harness-command', {
    commandId,
    kind: 'capture-frame',
    target: 'validation',
    expiresAt: new Date(Date.now() + 20_000).toISOString(),
    deterministic: true,
    format: 'jpeg',
    maxWidth: 512,
    maxHeight: 512,
  }, ['harness-result', 'harness-error'])
  assert.equal(event.type, 'harness-result', JSON.stringify(event))
  return event.data.result
}

async function stopRuntime(run) {
  return command(run, 'stop', {}, ['disposed'])
}

async function contactSheet(name, title, images) {
  const data = await Promise.all(images.map(async path => (
    `data:image/png;base64,${(await readFile(path)).toString('base64')}`
  )))
  const sheet = await browser.newPage({ viewport: { width: 1280, height: 760 } })
  await sheet.setContent(`
    <style>
      body{margin:0;padding:24px;background:#07101b;color:#eef6ff;font:16px system-ui}
      h1{margin:0 0 18px;font-size:24px}
      main{display:grid;grid-template-columns:repeat(${String(images.length)},1fr);gap:12px}
      figure{margin:0;padding:8px;background:#101c2a;border:1px solid #29415a}
      img{display:block;width:100%;height:620px;object-fit:cover}
      figcaption{padding-top:8px;text-align:center}
    </style>
    <h1>${title}</h1>
    <main>${data.map((url, index) => (
      `<figure><img src="${url}"><figcaption>${images[index].split('/').at(-1)}</figcaption></figure>`
    )).join('')}</main>
  `)
  const path = join(artifactRoot, name)
  await sheet.screenshot({ path, fullPage: true })
  await sheet.close()
  return path
}

async function validateOcean() {
  process.stderr.write('[m9-browser] validating ocean\n')
  const ocean = await buildCase('threejs-spectral-ocean/spectral-cascade-ocean')
  const oceanRuntime = await loadRuntime(ocean)
  const oceanMetrics = await metrics(oceanRuntime.run)
  assert.match(oceanMetrics.fftTest, /^pass /)
  assert.match(oceanMetrics.resolution, /× 3$/)
  assert.equal(oceanMetrics.buildId, ocean.build.buildId)
  assert.equal(oceanRuntime.startup.revision, ocean.revision)
  const oceanPixels = await pixelStats(oceanRuntime.frame)
  assert.ok(oceanPixels.lit > oceanPixels.sampled * 0.5)
  assert.ok(oceanPixels.colors > 100)
  const oceanShots = []
  for (const mode of [
    'final',
    'cascade-bands',
    'normals',
    'jacobian',
    'spectrum-0',
    'spectrum-1',
    'spectrum-2',
  ]) {
    if (mode !== 'final') await setDebug(oceanRuntime.run, mode)
    oceanShots.push(await screenshot(`m9-p4-${mode}.png`))
  }
  const oceanCaptureA = await deterministicCapture(oceanRuntime.run)
  await page.waitForTimeout(500)
  const oceanAfterCapture = await metrics(oceanRuntime.run)
  assert.ok(oceanAfterCapture.frame > oceanCaptureA.frame)
  const oceanCaptureB = await deterministicCapture(oceanRuntime.run)
  assert.equal(oceanCaptureA.digest, oceanCaptureB.digest)
  assert.equal(oceanCaptureA.runtime.buildId, ocean.build.buildId)
  assert.equal(oceanCaptureA.runtime.revision, ocean.revision)
  await stopRuntime(oceanRuntime.run)
  const reloadedOceanRuntime = await loadRuntime(ocean, 'spectrum-2')
  const oceanCaptureReloaded = await deterministicCapture(reloadedOceanRuntime.run)
  assert.equal(oceanCaptureA.digest, oceanCaptureReloaded.digest)
  assert.notEqual(oceanRuntime.run.runId, reloadedOceanRuntime.run.runId)
  await stopRuntime(reloadedOceanRuntime.run)
  return {
    projectId: ocean.projectId,
    revision: ocean.revision,
    buildId: ocean.build.buildId,
    metrics: oceanMetrics,
    pixels: oceanPixels,
    deterministic: {
      firstDigest: oceanCaptureA.digest,
      repeatedDigest: oceanCaptureB.digest,
      reloadDigest: oceanCaptureReloaded.digest,
      frameBeforeResume: oceanCaptureA.frame,
      frameAfterResume: oceanAfterCapture.frame,
      independentRunIds: [oceanRuntime.run.runId, reloadedOceanRuntime.run.runId],
    },
    transfer: ocean.transfer,
    contactSheet: await contactSheet(
      'm9-p4-contact-sheet.png',
      'M9 P4 Spectral Cascade Ocean',
      oceanShots,
    ),
  }
}

async function validateClouds() {
  process.stderr.write('[m9-browser] validating clouds\n')
  const clouds = await buildCase('threejs-volumetric-clouds/weather-volume-clouds')
  assert.ok(clouds.build.assets.some(asset => asset.mediaType === 'application/octet-stream'))
  assert.ok(clouds.build.assets.some(asset => asset.mediaType === 'image/x-exr'))
  const cloudRuntime = await loadRuntime(clouds)
  const cloudMetrics = await metrics(cloudRuntime.run)
  assert.match(cloudMetrics.tier, /temporal upscale/)
  assert.equal(cloudMetrics.buildId, clouds.build.buildId)
  const cloudPixels = await pixelStats(cloudRuntime.frame)
  assert.ok(cloudPixels.lit > cloudPixels.sampled * 0.2)
  assert.ok(cloudPixels.colors > 100)
  assert.equal(cloudMetrics.renderPath, 'example-render')
  const temporalPixels = await sampledPixels(cloudRuntime.frame)
  const cloudShots = [await screenshot('m9-p5-temporal.png')]
  await setDebug(cloudRuntime.run, 'native-resolution')
  const nativeMetrics = await metrics(cloudRuntime.run)
  assert.match(nativeMetrics.tier, /native/)
  cloudShots.push(await screenshot('m9-p5-native.png'))
  await setDebug(cloudRuntime.run, 'no-post')
  const noPostMetrics = await metrics(cloudRuntime.run)
  assert.equal(noPostMetrics.renderPath, 'direct-renderer')
  const noPostDifference = pixelDifference(
    temporalPixels,
    await sampledPixels(cloudRuntime.frame),
  )
  assert.ok(noPostDifference.changedRatio > 0.1, JSON.stringify(noPostDifference))
  assert.ok(noPostDifference.meanAbsoluteDifference > 3, JSON.stringify(noPostDifference))
  cloudShots.push(await screenshot('m9-p5-no-post.png'))
  const cloudCaptureA = await deterministicCapture(cloudRuntime.run)
  const cloudCaptureB = await deterministicCapture(cloudRuntime.run)
  assert.equal(cloudCaptureA.digest, cloudCaptureB.digest)
  assert.equal(cloudCaptureA.runtime.buildId, clouds.build.buildId)
  await page.waitForTimeout(1_000)
  assert.deepEqual(browserProblems, [])

  const beforeLoss = await page.evaluate(() => globalThis.__m9Events.length)
  const lost = await cloudRuntime.frame.evaluate(() => {
    const canvas = document.querySelector('canvas')
    const gl = canvas.getContext('webgl2')
    const extension = gl?.getExtension('WEBGL_lose_context')
    extension?.loseContext()
    return extension !== null && extension !== undefined
  })
  assert.equal(lost, true)
  await page.waitForFunction(offset => globalThis.__m9Events.slice(offset).some(event => (
    event.type === 'runtime-error'
      && event.data?.code === 'webgl-context-lost'
      && event.data?.fatal === true
      && event.data?.recoverable === true
  )), beforeLoss)
  const contextLoss = (await page.evaluate(offset => globalThis.__m9Events.slice(offset).find(
    event => event.type === 'runtime-error' && event.data?.code === 'webgl-context-lost',
  ), beforeLoss)).data
  const frameAtLoss = (await metrics(cloudRuntime.run)).frame
  await page.waitForTimeout(500)
  assert.equal((await metrics(cloudRuntime.run)).frame, frameAtLoss)
  await stopRuntime(cloudRuntime.run)
  const recoveredCloudRuntime = await loadRuntime(clouds)
  const recoveredCloudMetrics = await metrics(recoveredCloudRuntime.run)
  assert.notEqual(recoveredCloudRuntime.run.runId, cloudRuntime.run.runId)
  assert.equal(recoveredCloudRuntime.startup.data.buildId, clouds.build.buildId)
  assert.equal(recoveredCloudMetrics.renderPath, 'example-render')
  await stopRuntime(recoveredCloudRuntime.run)

  const pipelineMetrics = {
    effectComposer: /EffectComposer/.test(clouds.bundle),
    data3DTextureLoader: /createData3DTextureLoaderClass/.test(clouds.bundle),
    volumeAssets: clouds.build.assets.filter(asset => (
      asset.mediaType === 'application/octet-stream'
    )).length,
    gpuTextures: cloudMetrics.gpuTextures,
    temporal: cloudMetrics.tier,
    native: nativeMetrics.tier,
  }
  assert.equal(pipelineMetrics.effectComposer, true)
  assert.equal(pipelineMetrics.data3DTextureLoader, true)
  assert.ok(pipelineMetrics.volumeAssets >= 2)
  assert.ok(pipelineMetrics.gpuTextures >= pipelineMetrics.volumeAssets)
  return {
    projectId: clouds.projectId,
    revision: clouds.revision,
    buildId: clouds.build.buildId,
    temporalMetrics: cloudMetrics,
    nativeMetrics,
    noPostMetrics,
    noPostDifference,
    pipelineMetrics,
    pixels: cloudPixels,
    deterministicDigest: cloudCaptureA.digest,
    transfer: clouds.transfer,
    contextLoss,
    recovery: {
      previousRunId: cloudRuntime.run.runId,
      runId: recoveredCloudRuntime.run.runId,
      buildId: recoveredCloudRuntime.startup.data.buildId,
      ready: recoveredCloudRuntime.startup.type === 'ready',
    },
    contactSheet: await contactSheet(
      'm9-p5-contact-sheet.png',
      'M9 P5 Weather Volume Clouds',
      cloudShots,
    ),
  }
}

try {
  const ocean = selectedCase === 'clouds' ? undefined : await validateOcean()
  const clouds = selectedCase === 'ocean' ? undefined : await validateClouds()
  const result = {
    corpusCommit: '98453747cc0678f6a5d910f38d7483596a5f9a40',
    browser: await browser.version(),
    ...(ocean === undefined ? {} : { ocean }),
    ...(clouds === undefined ? {} : { clouds }),
    browserProblems,
  }
  if (resultPath !== undefined) await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} finally {
  await browser.close()
  await new Promise(resolve => webServer.close(resolve))
  await client.close()
  await rm(projectRoot, { recursive: true, force: true })
}
