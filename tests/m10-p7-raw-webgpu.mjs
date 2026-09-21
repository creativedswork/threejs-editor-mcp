import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { chromium } from 'playwright'
import { WORKSPACE_RUNTIME_CHANNEL, workspaceRuntimeHtml } from '../src/workspace-runtime.ts'

const workspace = resolve(process.env.THREEJS_EDITOR_MCP_WORKSPACE ?? '')
if (workspace === resolve('')) throw new Error('THREEJS_EDITOR_MCP_WORKSPACE is required')
const serverPath = resolve(process.env.THREEJS_EDITOR_MCP_SERVER ?? 'dist/server.js')
const root = await mkdtemp(join(tmpdir(), 'threejs-editor-m10-p7-'))
const client = new Client({ name: 'm10-p7-raw-webgpu', version: '0.0.0' })
let browser
let webServer

try {
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, '--root', root],
  }))
  const opened = await client.callTool({
    name: 'open_editor',
    arguments: {
      projectPath: 'threejs-procedural-vegetation/gpu-culled-flower-field',
    },
    _meta: { 'ai.deepseek.dsh/workspace': { cwd: workspace } },
  })
  assert.equal(opened.isError, undefined, JSON.stringify(opened))
  assert.equal(opened.structuredContent.title, 'GPU-Culled Flower Field')

  const built = await client.callTool({
    name: 'build_project',
    arguments: {
      projectId: opened.structuredContent.projectId,
      revision: opened.structuredContent.revision,
    },
  })
  assert.equal(built.structuredContent.status, 'ready', JSON.stringify(built))
  assert.equal(built.structuredContent.backend, 'raw-webgpu')
  assert.deepEqual(built.structuredContent.diagnostics, [])

  const bundle = (await client.readResource({
    uri: built.structuredContent.bundleUri,
  })).contents[0]?.text
  assert.equal(typeof bundle, 'string')
  const assets = []
  for (const asset of built.structuredContent.assets) {
    if (asset.external !== true) continue
    const chunks = []
    for (let index = 0; index < asset.chunks; index += 1) {
      const uri = `${asset.resourceUri}/${String(index)}`
      const resource = await client.readResource({ uri })
      const blob = resource.contents.find(content => content.uri === uri)?.blob
      assert.equal(typeof blob, 'string')
      chunks.push(Buffer.from(blob, 'base64'))
    }
    const bytes = Buffer.concat(chunks)
    assert.equal(bytes.byteLength, asset.size)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256)
    assets.push({
      sha256: asset.sha256,
      mediaType: asset.mediaType,
      base64: bytes.toString('base64'),
    })
  }

  webServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>P7 raw WebGPU regression</title>')
  })
  await new Promise(resolveListen => webServer.listen(0, '127.0.0.1', resolveListen))
  const address = webServer.address()
  assert.notEqual(address, null)
  assert.equal(typeof address, 'object')

  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: process.platform === 'darwin' ? ['--use-angle=metal'] : [],
  })
  const page = await browser.newPage({
    viewport: { width: 960, height: 640 },
    deviceScaleFactor: 1,
  })
  const browserProblems = []
  page.on('console', message => {
    if (message.type() === 'error') browserProblems.push(`console: ${message.text()}`)
  })
  page.on('pageerror', error => browserProblems.push(`pageerror: ${error.message}`))
  await page.goto(`http://127.0.0.1:${String(address.port)}`)
  await page.setContent(
    '<style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style>'
      + '<iframe sandbox="allow-scripts" style="width:960px;height:640px"></iframe>',
  )
  await page.evaluate(() => {
    globalThis.__p7Events = []
    window.addEventListener('message', event => {
      if (event.data?.channel === 'threejs-editor-m7-runtime') {
        globalThis.__p7Events.push(event.data)
      }
    })
  })
  const iframe = page.locator('iframe')
  await iframe.evaluate((frame, html) => { frame.srcdoc = html }, workspaceRuntimeHtml())
  await iframe.contentFrame().locator('canvas').waitFor()

  const identity = {
    projectId: opened.structuredContent.projectId,
    revision: opened.structuredContent.revision,
    runId: randomUUID(),
    nonce: randomUUID(),
    evidenceToken: randomUUID(),
  }
  await page.evaluate(value => {
    const runtimeAssets = value.assets.map(asset => ({
      sha256: asset.sha256,
      mediaType: asset.mediaType,
      bytes: Uint8Array.from(
        atob(asset.base64),
        character => character.charCodeAt(0),
      ).buffer,
    }))
    document.querySelector('iframe').contentWindow.postMessage({
      channel: value.channel,
      action: 'run',
      ...value.identity,
      bundle: value.bundle,
      assets: runtimeAssets,
      backend: 'raw-webgpu',
      buildId: value.buildId,
      debugMode: 'final',
      mode: 'run',
    }, '*')
  }, {
    channel: WORKSPACE_RUNTIME_CHANNEL,
    identity,
    bundle,
    assets,
    buildId: built.structuredContent.buildId,
  })
  await page.waitForFunction(value => globalThis.__p7Events.some(event => (
    event.projectId === value.projectId
      && event.runId === value.runId
      && event.nonce === value.nonce
      && (event.type === 'ready' || event.type === 'runtime-error')
  )), identity, { timeout: 120_000 })
  const startup = await page.evaluate(value => globalThis.__p7Events.find(event => (
    event.projectId === value.projectId
      && event.runId === value.runId
      && event.nonce === value.nonce
      && (event.type === 'ready' || event.type === 'runtime-error')
  )), identity)
  assert.equal(startup.type, 'ready', JSON.stringify(startup))
  assert.equal(startup.data.backend, 'raw-webgpu')
  assert.equal(startup.data.rendererCount, 0)
  assert.equal(startup.data.rendererBackend, 'RawWebGPU')
  assert.equal(startup.data.renderPath, 'example-render')
  assert.ok(Number(startup.data.candidates) > 0)

  await page.waitForFunction(value => globalThis.__p7Events.some(event => (
    event.projectId === value.projectId
      && event.runId === value.runId
      && event.nonce === value.nonce
      && event.type === 'frame'
      && event.data?.frame >= 30
  )), identity, { timeout: 120_000 })
  const screenshot = await iframe.screenshot({ type: 'png' })
  const pixels = await page.evaluate(async base64 => {
    const image = new Image()
    image.src = `data:image/png;base64,${base64}`
    await image.decode()
    const sample = document.createElement('canvas')
    sample.width = 120
    sample.height = 80
    const context = sample.getContext('2d', { willReadFrequently: true })
    context.drawImage(image, 0, 0, sample.width, sample.height)
    const data = context.getImageData(0, 0, sample.width, sample.height).data
    const colors = new Set()
    let lit = 0
    for (let index = 0; index < data.length; index += 16) {
      const red = data[index] ?? 0
      const green = data[index + 1] ?? 0
      const blue = data[index + 2] ?? 0
      if (red + green + blue > 60) lit += 1
      colors.add((red << 16) | (green << 8) | blue)
    }
    return { colors: colors.size, lit, samples: data.length / 16 }
  }, screenshot.toString('base64'))
  assert.ok(pixels.lit > pixels.samples * 0.2, JSON.stringify(pixels))
  assert.ok(pixels.colors > 20, JSON.stringify(pixels))

  const offset = await page.evaluate(() => globalThis.__p7Events.length)
  await iframe.evaluate((frame, value) => {
    frame.contentWindow.postMessage({
      channel: value.channel,
      action: 'stop',
      ...value.identity,
    }, '*')
  }, { channel: WORKSPACE_RUNTIME_CHANNEL, identity })
  await page.waitForFunction(start => globalThis.__p7Events.slice(start).some(
    event => event.type === 'disposed',
  ), offset)
  const finalEvents = await page.evaluate(() => globalThis.__p7Events)
  assert.equal(finalEvents.slice(offset).some(event => event.type === 'runtime-error'), false)
  assert.deepEqual(browserProblems, [])

  process.stdout.write(`${JSON.stringify({
    projectId: identity.projectId,
    revision: identity.revision,
    buildId: built.structuredContent.buildId,
    bundleBytes: built.structuredContent.bundleBytes,
    assets: built.structuredContent.assets.length,
    runtime: {
      backend: startup.data.backend,
      frame: startup.data.frame,
      rendererCount: startup.data.rendererCount,
      candidates: startup.data.candidates,
      pixels,
    },
  }, null, 2)}\n`)
} finally {
  await browser?.close()
  if (webServer !== undefined) {
    await new Promise(resolveClose => webServer.close(resolveClose))
  }
  await client.close()
  await rm(root, { recursive: true, force: true })
}
