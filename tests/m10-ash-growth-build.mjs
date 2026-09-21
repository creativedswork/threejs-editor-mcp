import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { chromium } from 'playwright'
import { build as esbuild } from 'esbuild'
import { WORKSPACE_RUNTIME_CHANNEL, workspaceRuntimeHtml } from '../src/workspace-runtime.ts'

const workspace = resolve(process.env.THREEJS_EDITOR_MCP_WORKSPACE ?? '')
if (workspace === resolve('')) throw new Error('THREEJS_EDITOR_MCP_WORKSPACE is required')
const server = resolve(process.env.THREEJS_EDITOR_MCP_SERVER ?? 'dist/server.js')
const projectPath = process.env.THREEJS_EDITOR_MCP_CASE
  ?? 'threejs-procedural-vegetation/structured-ash-growth'
const root = await mkdtemp(join(tmpdir(), 'threejs-editor-m10-ash-'))
const client = new Client({ name: 'm10-ash-growth-build', version: '0.0.0' })
let browser

try {
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [server, '--root', root],
  }))
  const opened = await client.callTool({
    name: 'open_editor',
    arguments: {
      projectPath,
    },
    _meta: { 'ai.deepseek.dsh/workspace': { cwd: workspace } },
  })
  assert.match(opened.content[0].text, /App loading is pending/)

  const built = await client.callTool({
    name: 'build_project',
    arguments: {
      projectId: opened.structuredContent.projectId,
      revision: opened.structuredContent.revision,
    },
  })
  assert.equal(built.structuredContent.status, 'ready', JSON.stringify(built))
  assert.deepEqual(built.structuredContent.diagnostics, [])
  assert.equal(built.structuredContent.backend, 'webgl')
  const assets = built.structuredContent.assets
  if (projectPath === 'threejs-procedural-vegetation/structured-ash-growth') {
    for (const name of [
      'draco_decoder.js',
      'draco_decoder.wasm',
      'draco_wasm_wrapper.js',
    ]) {
      assert.ok(assets.some(asset => (
        asset.path === `node_modules/three/examples/jsm/libs/draco/gltf/${name}`
      )))
    }
  }

  const bundleResource = await client.readResource({
    uri: built.structuredContent.bundleUri,
  })
  const bundle = bundleResource.contents.find(
    content => content.uri === built.structuredContent.bundleUri,
  )?.text
  assert.equal(typeof bundle, 'string')
  const runtimeAssets = []
  for (const asset of assets.filter(candidate => candidate.external === true)) {
    const parts = []
    for (let index = 0; index < asset.chunks; index += 1) {
      const uri = `${asset.resourceUri}/${String(index)}`
      const resource = await client.readResource({ uri })
      const blob = resource.contents.find(content => content.uri === uri)?.blob
      assert.equal(typeof blob, 'string')
      parts.push(Buffer.from(blob, 'base64'))
    }
    const bytes = Buffer.concat(parts)
    assert.equal(bytes.byteLength, asset.size)
    runtimeAssets.push({
      sha256: asset.sha256,
      mediaType: asset.mediaType,
      base64: bytes.toString('base64'),
    })
  }

  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: process.platform === 'darwin' ? ['--use-angle=metal'] : [],
  })
  const page = await browser.newPage({ viewport: { width: 960, height: 640 } })
  const browserProblems = []
  page.on('console', message => {
    if (message.type() === 'error') browserProblems.push(`console: ${message.text()}`)
  })
  page.on('pageerror', error => browserProblems.push(`pageerror: ${error.message}`))
  await page.setContent('<iframe sandbox="allow-scripts" style="width:960px;height:640px"></iframe>')
  await page.locator('iframe').evaluate(
    (frame, html) => { frame.srcdoc = html },
    workspaceRuntimeHtml(),
  )
  await page.frameLocator('iframe').locator('canvas').waitFor()
  const identity = {
    channel: WORKSPACE_RUNTIME_CHANNEL,
    projectId: opened.structuredContent.projectId,
    runId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    nonce: '11111111-2222-4333-8444-555555555555',
    revision: opened.structuredContent.revision,
    evidenceToken: 'm10-ash-growth',
  }
  await page.evaluate(value => {
    globalThis.__ashEvents = []
    const frame = document.querySelector('iframe')
    window.addEventListener('message', event => {
      if (event.source === frame?.contentWindow
        && event.data?.channel === value.identity.channel
        && event.data.projectId === value.identity.projectId
        && event.data.runId === value.identity.runId
        && event.data.nonce === value.identity.nonce
        && event.data.revision === value.identity.revision) {
        globalThis.__ashEvents.push(event.data)
      }
    })
    const assets = value.assets.map(asset => ({
      sha256: asset.sha256,
      mediaType: asset.mediaType,
      bytes: Uint8Array.from(
        atob(asset.base64),
        character => character.charCodeAt(0),
      ).buffer,
    }))
    frame.contentWindow.postMessage({
      ...value.identity,
      action: 'run',
      bundle: value.bundle,
      backend: 'webgl',
      buildId: value.buildId,
      assets,
      debugMode: 'final',
      mode: 'edit',
    }, '*')
  }, {
    identity,
    assets: runtimeAssets,
    bundle,
    buildId: built.structuredContent.buildId,
  })
  await page.waitForFunction(() => (
    globalThis.__ashEvents.some(event => (
      event.type === 'ready' || event.type === 'runtime-error'
    ))
  ), undefined, { timeout: 120_000 })
  const events = await page.evaluate(() => globalThis.__ashEvents)
  const runtimeError = events.find(event => event.type === 'runtime-error')
  assert.equal(runtimeError, undefined, JSON.stringify(runtimeError))
  const ready = events.find(event => event.type === 'ready')
  assert.equal(ready?.data?.backend, 'webgl')
  assert.ok(ready.data.frame >= 1)
  const runtimeFrame = page.frames().find(frame => frame !== page.mainFrame())
  assert.notEqual(runtimeFrame, undefined)
  const pixels = await runtimeFrame.evaluate(() => {
    const canvas = document.querySelector('canvas')
    const sample = document.createElement('canvas')
    sample.width = 120
    sample.height = 80
    const context = sample.getContext('2d', { willReadFrequently: true })
    context.drawImage(canvas, 0, 0, sample.width, sample.height)
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
  })
  assert.ok(pixels.lit > pixels.samples * 0.2, JSON.stringify(pixels))
  assert.ok(pixels.colors > 50, JSON.stringify(pixels))
  assert.deepEqual(browserProblems, [])

  const appResource = await client.readResource({ uri: 'ui://threejs-editor/app' })
  const appHtml = appResource.contents[0]?.text
  assert.equal(typeof appHtml, 'string')
  const hostBundle = (await esbuild({
    stdin: {
      contents: `
        import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge'
        globalThis.__createAshFailureHost = async (frame, projectId, revision) => {
          globalThis.__ashFailureContexts = []
          globalThis.__ashFailureMessages = []
          const bridge = new AppBridge(
            null,
            { name: 'M10 Ash failure host', version: '0.0.0' },
            {
              serverTools: {},
              serverResources: {},
              message: { text: {} },
              updateModelContext: { text: {}, structuredContent: {} },
            },
            {
              hostContext: {
                displayMode: 'inline',
                availableDisplayModes: ['inline', 'fullscreen'],
              },
            },
          )
          bridge.oncalltool = async () => ({
            isError: true,
            content: [{
              type: 'text',
              text: JSON.stringify([{
                path: ['execution'],
                message: 'Invalid input: expected object, received undefined',
              }], null, 2),
            }],
          })
          bridge.onupdatemodelcontext = async params => {
            globalThis.__ashFailureContexts.push(params)
            return {}
          }
          bridge.onmessage = async params => {
            globalThis.__ashFailureMessages.push(params)
            return {}
          }
          const initialized = new Promise(resolve => { bridge.oninitialized = resolve })
          await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow))
          await initialized
          bridge.sendToolInput({ arguments: { projectId } })
          bridge.sendToolResult({
            content: [{ type: 'text', text: 'Open request accepted; App loading is pending' }],
            structuredContent: { projectId, revision },
          })
        }
      `,
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    write: false,
  })).outputFiles[0].text
  const feedbackPage = await browser.newPage()
  await feedbackPage.setContent('<iframe sandbox="allow-scripts allow-same-origin"></iframe>')
  await feedbackPage.addScriptTag({ content: hostBundle })
  await feedbackPage.evaluate(({ html, projectId, revision }) => {
    const frame = document.querySelector('iframe')
    const connected = globalThis.__createAshFailureHost(frame, projectId, revision)
    frame.srcdoc = html
    return connected
  }, {
    html: appHtml,
    projectId: opened.structuredContent.projectId,
    revision: opened.structuredContent.revision,
  })
  await feedbackPage.waitForFunction(() => (
    globalThis.__ashFailureContexts?.some(context => (
      context.structuredContent?.kind === 'threejs-editor-open-status'
      && context.structuredContent.open?.status === 'failed'
    ))
    && globalThis.__ashFailureMessages?.length === 1
  ), undefined, { timeout: 15_000 })
  const feedback = await feedbackPage.evaluate(() => ({
    contexts: globalThis.__ashFailureContexts,
    messages: globalThis.__ashFailureMessages,
  }))
  assert.match(
    feedback.contexts.at(-1).structuredContent.open.error,
    /execution: Invalid input: expected object, received undefined/,
  )
  assert.match(
    feedback.messages[0].content[0].text,
    /Report its final App status/,
  )

  process.stdout.write(`${JSON.stringify({
    projectPath,
    projectId: opened.structuredContent.projectId,
    revision: opened.structuredContent.revision,
    buildId: built.structuredContent.buildId,
    bundleBytes: built.structuredContent.bundleBytes,
    assets: assets.length,
    decoderAssets: projectPath === 'threejs-procedural-vegetation/structured-ash-growth'
      ? 3
      : 0,
    runtime: {
      backend: ready.data.backend,
      frame: ready.data.frame,
      pixels,
    },
    failureFeedback: {
      status: feedback.contexts.at(-1).structuredContent.open.status,
      messages: feedback.messages.length,
    },
  }, null, 2)}\n`)
} finally {
  await browser?.close().catch(() => {})
  await client.close()
  await rm(root, { recursive: true, force: true })
}
