import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { chromium } from 'playwright'

const webUrl = process.env.DSH_WEB_URL
if (webUrl === undefined) throw new Error('DSH_WEB_URL is required')
const serverCommand = process.env.THREEJS_EDITOR_MCP_SERVER
if (serverCommand === undefined) throw new Error('THREEJS_EDITOR_MCP_SERVER is required')

const projectRoot = resolve(process.env.THREEJS_EDITOR_MCP_ROOT ?? '.')
const projectsRoot = resolve(
  process.env.THREEJS_EDITOR_MCP_PROJECTS ?? resolve(projectRoot, '.tmp/m4-projects'),
)
const artifacts = resolve(projectRoot, 'artifacts')
mkdirSync(artifacts, { recursive: true })

function glb(document, binary) {
  const json = Buffer.from(JSON.stringify(document))
  const paddedJson = Buffer.concat([
    json,
    Buffer.alloc((4 - json.length % 4) % 4, 0x20),
  ])
  const paddedBinary = Buffer.concat([
    binary,
    Buffer.alloc((4 - binary.length % 4) % 4),
  ])
  const total = 12 + 8 + paddedJson.length + 8 + paddedBinary.length
  const result = Buffer.alloc(total)
  result.writeUInt32LE(0x46546c67, 0)
  result.writeUInt32LE(2, 4)
  result.writeUInt32LE(total, 8)
  result.writeUInt32LE(paddedJson.length, 12)
  result.writeUInt32LE(0x4e4f534a, 16)
  paddedJson.copy(result, 20)
  const offset = 20 + paddedJson.length
  result.writeUInt32LE(paddedBinary.length, offset)
  result.writeUInt32LE(0x004e4942, offset + 4)
  paddedBinary.copy(result, offset + 8)
  return result
}

const triangleGlb = glb({
  asset: { version: '2.0' },
  buffers: [{ byteLength: 36 }],
  bufferViews: [{ buffer: 0, byteLength: 36, target: 34962 }],
  accessors: [{
    bufferView: 0,
    componentType: 5126,
    count: 3,
    type: 'VEC3',
    min: [-0.6, 0, -1],
    max: [0.6, 1.2, -1],
  }],
  materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0.2, 0.4, 1] } }],
  meshes: [{
    name: 'Imported Triangle Mesh',
    primitives: [{ attributes: { POSITION: 0 }, material: 0 }],
  }],
  nodes: [{ name: 'Imported Triangle', mesh: 0 }],
  scenes: [{ nodes: [0] }],
  scene: 0,
}, Buffer.from(new Float32Array([
  -0.6, 0, -1,
  0.6, 0, -1,
  0, 1.2, -1,
]).buffer))

const texturePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR42mP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
)

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({
  viewport: { width: 1280, height: 1000 },
  deviceScaleFactor: 1,
  acceptDownloads: true,
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
    globalThis.__THREE_M4__?.metrics().frame > 10
    && globalThis.__THREE_M4__?.metrics().sync === 'clean'
  ))
  return { outer, inner, appFrame }
}

async function connectExternalClient() {
  const client = new Client({
    name: 'threejs-editor-m4-evidence',
    version: '0.1.0',
  })
  await client.connect(new StdioClientTransport({
    command: serverCommand,
    args: ['--root', projectsRoot],
  }))
  return client
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

  const rejected = await page.request.post(`${webUrl}/api/mcp-apps/tool`, {
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://untrusted.example',
    },
    data: {},
  })
  assert.equal(rejected.status(), 403)

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
  await composer.fill('创建并打开 M4 Pong 项目')
  await composer.press('Enter')
  await page.getByText('Three.js M4 editor opened.').waitFor({ timeout: 20_000 })

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

  const initialPixels = await appFrame.evaluate(() => globalThis.__THREE_M4__.pixelStats())
  assert.ok(initialPixels.lit > initialPixels.sampled * 0.08)
  assert.ok(initialPixels.colors > 20)

  const assetInput = appFrame.locator('[data-asset-input]')
  await assetInput.setInputFiles({
    name: 'triangle.glb',
    mimeType: 'model/gltf-binary',
    buffer: triangleGlb,
  })
  await appFrame.waitForFunction(() => {
    const metrics = globalThis.__THREE_M4__.metrics()
    return metrics.sync === 'dirty'
      && metrics.importedAssets.includes('triangle.glb')
      && metrics.hierarchy.includes('triangle')
  })

  await appFrame.getByRole('button', { name: 'Ball', exact: true }).click()
  await assetInput.setInputFiles({
    name: 'ball.png',
    mimeType: 'image/png',
    buffer: texturePng,
  })
  await appFrame.waitForFunction(() => (
    globalThis.__THREE_M4__.metrics().importedAssets.includes('ball.png')
    && globalThis.__THREE_M4__.metrics().pendingOperations.some(
      operation => operation.includes('Applied texture ball.png'),
    )
  ))

  await appFrame.getByRole('button', { name: 'Save', exact: true }).click()
  await appFrame.getByText('Saved', { exact: true }).waitFor({ timeout: 10_000 })
  const saved = await appFrame.evaluate(() => globalThis.__THREE_M4__.metrics())
  assert.equal(saved.sync, 'clean')
  assert.equal(saved.pendingOperations.length, 0)
  assert.equal(
    await page.locator('iframe[title="MCP App: mcp__threejs__create_project"]').count(),
    1,
  )

  externalClient = await connectExternalClient()
  const inspected = await externalClient.callTool({
    name: 'inspect_project',
    arguments: { projectId: 'm4-pong' },
  })
  assert.equal(inspected.isError, undefined)
  assert.equal(inspected.structuredContent.revision, saved.revision)
  assert.deepEqual(
    inspected.structuredContent.assets.map(asset => asset.name),
    ['ball.png', 'triangle.glb'],
  )
  assert.equal(
    inspected.structuredContent.objects.some(object => object.name === 'Imported_Triangle'),
    true,
  )

  const projectPath = resolve(projectsRoot, 'm4-pong', 'project.json')
  const projectBytes = readFileSync(projectPath)
  const storedProject = JSON.parse(projectBytes)
  assert.equal(createHash('sha256').update(projectBytes).digest('hex'), saved.revision)
  assert.equal(
    storedProject.scene.images.some(image => (
      typeof image.url === 'string' && image.url.startsWith('data:image/png;base64,')
    )),
    true,
  )

  const downloadPromise = page.waitForEvent('download')
  await appFrame.getByRole('button', { name: 'Export project' }).click()
  const download = await downloadPromise
  assert.equal(download.suggestedFilename(), 'm4-pong.threejs-project.json')
  const downloadPath = await download.path()
  assert.notEqual(downloadPath, null)
  const exported = JSON.parse(readFileSync(downloadPath, 'utf8'))
  assert.equal(exported.format, 'threejs-editor-mcp')
  assert.equal(exported.formatVersion, 1)
  assert.equal(exported.projectId, 'm4-pong')
  assert.equal(exported.revision, saved.revision)
  assert.deepEqual(exported.assets.map(asset => asset.name), ['ball.png', 'triangle.glb'])
  assert.equal(exported.assets[0].data, texturePng.toString('base64'))
  await appFrame.getByText('Exported m4-pong.threejs-project.json', { exact: true })
    .waitFor({ timeout: 10_000 })

  await appFrame.getByRole('button', { name: 'Play' }).click()
  await appFrame.waitForFunction(() => (
    globalThis.__THREE_M4__.metrics().playState === 'playing'
  ))
  await appFrame.getByRole('button', { name: 'Stop' }).click()
  await appFrame.getByText('Stopped; diagnostics recorded', { exact: true })
    .waitFor({ timeout: 10_000 })
  const checked = await externalClient.callTool({
    name: 'check_project',
    arguments: { projectId: 'm4-pong' },
  })
  assert.deepEqual(checked.structuredContent.errors, [])
  assert.deepEqual(checked.structuredContent.warnings, [])

  const finalPixels = await appFrame.evaluate(() => globalThis.__THREE_M4__.pixelStats())
  assert.ok(finalPixels.lit > finalPixels.sampled * 0.08)
  assert.ok(finalPixels.colors > 20)

  await page.screenshot({
    path: resolve(artifacts, 'm4-harness-assets-export.png'),
    fullPage: true,
  })
  assert.deepEqual(appProblems, [])

  process.stdout.write(`${JSON.stringify({
    webUrl,
    serverCommand,
    catalog: publicToolNames,
    crossOriginStatus: rejected.status(),
    outer: outerBox,
    inner: innerBox,
    canvas: canvasBox,
    initialPixels,
    saved: {
      revision: saved.revision,
      assets: inspected.structuredContent.assets,
      operations: inspected.structuredContent.operations,
      projectPath,
    },
    export: {
      filename: download.suggestedFilename(),
      revision: exported.revision,
      assets: exported.assets.map(asset => ({
        name: asset.name,
        size: asset.size,
        sha256: asset.sha256,
      })),
    },
    finalPixels,
    diagnostics: checked.structuredContent,
    appProblems,
  }, null, 2)}\n`)
} catch (error) {
  await page.screenshot({
    path: resolve(artifacts, 'm4-harness-assets-export-failure.png'),
    fullPage: true,
  })
  throw error
} finally {
  if (externalClient !== undefined) await externalClient.close()
  await browser.close()
}
