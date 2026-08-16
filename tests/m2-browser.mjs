import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { chromium } from 'playwright'

const webUrl = process.env.DSH_WEB_URL
if (webUrl === undefined) throw new Error('DSH_WEB_URL is required')

const projectRoot = resolve(process.env.THREEJS_EDITOR_MCP_ROOT ?? '.')
const projectsRoot = resolve(
  process.env.THREEJS_EDITOR_MCP_PROJECTS ?? resolve(projectRoot, '.tmp/m2-projects'),
)
const artifacts = resolve(projectRoot, 'artifacts')
mkdirSync(artifacts, { recursive: true })

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({
  viewport: { width: 1280, height: 1000 },
  deviceScaleFactor: 1,
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
    globalThis.__THREE_M2__?.metrics().frame > 10
    && globalThis.__THREE_M2__?.metrics().sync === 'clean'
  ))
  return { outer, inner, appFrame }
}

async function connectExternalClient() {
  const client = new Client({
    name: 'threejs-editor-m2-external-writer',
    version: '0.0.0',
  })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [resolve(projectRoot, 'dist/server.js'), '--root', projectsRoot],
  }))
  return client
}

async function externalTitleUpdate(nextTitle) {
  const pulled = await externalClient.callTool({
    name: 'pull_project',
    arguments: { projectId: 'm2-pong' },
  })
  assert.equal(pulled.isError, undefined)
  const pushed = await externalClient.callTool({
    name: 'push_project',
    arguments: {
      projectId: 'm2-pong',
      baseRevision: pulled.structuredContent.revision,
      project: {
        ...pulled.structuredContent.project,
        title: nextTitle,
      },
    },
  })
  assert.equal(pushed.isError, undefined)
  return pushed.structuredContent.revision
}

try {
  await page.goto(webUrl, { waitUntil: 'domcontentloaded' })

  const disclaimer = page.locator('[role="presentation"]')
    .filter({ hasText: '内测声明' })
    .last()
  await disclaimer.waitFor({ state: 'visible', timeout: 60_000 })
  await disclaimer.getByText('继续', { exact: true }).click()
  await disclaimer.waitFor({ state: 'hidden' })

  const catalog = await page.evaluate(async () => {
    const response = await fetch('/api/mcp-apps/catalog')
    return response.json()
  })
  const publicToolNames = catalog.items.map(item => item.publicToolName).sort()
  assert.deepEqual(publicToolNames, [
    'mcp__threejs__create_project',
    'mcp__threejs__open_editor',
  ])
  assert.equal(publicToolNames.some(name => name.includes('save_project_copy')), false)

  await page.getByRole('button', { name: '添加工作区' }).click()
  await page.getByRole('heading', { name: '选择工作区目录' }).waitFor()
  await page.getByRole('button', { name: '编辑路径' }).click()
  const pathInput = page.getByRole('textbox', { name: '编辑路径' })
  await pathInput.fill(projectRoot)
  await pathInput.press('Enter')
  await page.getByRole('button', { name: '打开', exact: true }).click()

  const composer = page.getByRole('textbox', { name: '描述你想要构建的内容' })
  await composer.fill('创建并打开 M2 Pong 项目')
  await composer.press('Enter')
  await page.getByText('Three.js M2 editor opened.').waitFor({ timeout: 20_000 })

  let { outer, inner, appFrame } = await appSurface()
  const canvas = appFrame.locator('[data-three-canvas]')
  const hierarchyPanel = appFrame.locator('.hierarchy')
  const inspectorPanel = appFrame.locator('.inspector')
  const outerBox = await outer.boundingBox()
  const innerBox = await inner.boundingBox()
  const canvasBox = await canvas.boundingBox()
  const hierarchyBox = await hierarchyPanel.boundingBox()
  const inspectorBox = await inspectorPanel.boundingBox()
  assert.notEqual(outerBox, null)
  assert.notEqual(innerBox, null)
  assert.notEqual(canvasBox, null)
  assert.notEqual(hierarchyBox, null)
  assert.notEqual(inspectorBox, null)
  assert.ok(outerBox.height >= 620, `outer iframe is only ${String(outerBox.height)}px high`)
  assert.equal(innerBox.height, outerBox.height)
  assert.ok(canvasBox.width >= 700, `canvas is only ${String(canvasBox.width)}px wide`)
  assert.ok(canvasBox.height >= 330, `canvas is only ${String(canvasBox.height)}px high`)
  assert.ok(hierarchyBox.y >= canvasBox.y + canvasBox.height - 1)
  assert.equal(Math.round(hierarchyBox.y), Math.round(inspectorBox.y))

  const initial = await appFrame.evaluate(() => globalThis.__THREE_M2__.metrics())
  assert.deepEqual(initial.hierarchy, [
    'HemisphereLight',
    'Key Light',
    'Field',
    'Left Paddle',
    'Right Paddle',
    'Ball',
  ])
  const pixels = await appFrame.evaluate(() => globalThis.__THREE_M2__.pixelStats())
  assert.ok(pixels.lit > pixels.sampled * 0.08, 'canvas is effectively blank')
  assert.ok(pixels.colors > 20, `canvas has only ${String(pixels.colors)} sampled colors`)

  await appFrame.getByRole('button', { name: 'Left Paddle', exact: true }).click()
  await appFrame.waitForFunction(() => globalThis.__THREE_M2__.metrics().selected === 'Left Paddle')
  const positionX = appFrame.getByRole('spinbutton', { name: 'Position X' })
  assert.equal(Number(await positionX.inputValue()), -4.45)

  await positionX.fill('-3.75')
  await positionX.press('Tab')
  await appFrame.waitForFunction(() => (
    globalThis.__THREE_M2__.object('Left Paddle').position[0] === -3.75
    && globalThis.__THREE_M2__.metrics().sync === 'dirty'
  ))
  await appFrame.getByRole('button', { name: 'Undo' }).click()
  await appFrame.waitForFunction(() => globalThis.__THREE_M2__.object('Left Paddle').position[0] === -4.45)
  await appFrame.getByRole('button', { name: 'Redo' }).click()
  await appFrame.waitForFunction(() => globalThis.__THREE_M2__.object('Left Paddle').position[0] === -3.75)

  await appFrame.getByRole('button', { name: 'Left Paddle', exact: true }).click()
  await appFrame.getByRole('button', { name: 'Rotate' }).click()
  assert.equal(
    (await appFrame.evaluate(() => globalThis.__THREE_M2__.metrics())).transformMode,
    'rotate',
  )

  await appFrame.getByRole('button', { name: 'Save', exact: true }).click()
  await appFrame.getByText('Saved', { exact: true }).waitFor({ timeout: 10_000 })
  const humanSaved = await appFrame.evaluate(() => globalThis.__THREE_M2__.metrics())
  const originalPath = resolve(projectsRoot, 'm2-pong', 'project.json')
  let originalProject = JSON.parse(readFileSync(originalPath))
  const humanPaddle = originalProject.scene.object.children
    .find(child => child.name === 'Left Paddle')
  assert.equal(humanPaddle.matrix[12], -3.75)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByText('Three.js M2 editor opened.').waitFor({ timeout: 30_000 })
  ;({ outer, inner, appFrame } = await appSurface())
  const reloaded = await appFrame.evaluate(() => ({
    metrics: globalThis.__THREE_M2__.metrics(),
    paddle: globalThis.__THREE_M2__.object('Left Paddle'),
  }))
  assert.equal(reloaded.paddle.position[0], -3.75)
  assert.equal(reloaded.metrics.revision, humanSaved.revision)

  externalClient = await connectExternalClient()
  const cleanExternalRevision = await externalTitleUpdate('AI Clean Update')
  await appFrame.waitForFunction(expected => (
    globalThis.__THREE_M2__.metrics().inputTitle === expected
    && globalThis.__THREE_M2__.metrics().sync === 'clean'
  ), 'AI Clean Update')
  const cleanReload = await appFrame.evaluate(() => globalThis.__THREE_M2__.metrics())
  assert.equal(cleanReload.revision, cleanExternalRevision)

  await appFrame.getByRole('button', { name: 'Left Paddle', exact: true }).click()
  const conflictPositionX = appFrame.getByRole('spinbutton', { name: 'Position X' })
  await conflictPositionX.fill('-3.25')
  await conflictPositionX.press('Tab')
  await appFrame.waitForFunction(() => globalThis.__THREE_M2__.metrics().sync === 'dirty')

  const conflictRevision = await externalTitleUpdate('AI Conflict Update')
  await appFrame.waitForFunction(expected => (
    globalThis.__THREE_M2__.metrics().sync === 'conflict'
    && globalThis.__THREE_M2__.metrics().remoteRevision === expected
  ), conflictRevision)
  const conflictState = await appFrame.evaluate(() => ({
    metrics: globalThis.__THREE_M2__.metrics(),
    paddle: globalThis.__THREE_M2__.object('Left Paddle'),
  }))
  assert.equal(conflictState.metrics.inputTitle, 'AI Clean Update')
  assert.equal(conflictState.paddle.position[0], -3.25)

  await appFrame.getByRole('button', { name: 'Save local copy', exact: true }).click()
  await appFrame.waitForFunction(() => (
    globalThis.__THREE_M2__.metrics().sync === 'clean'
    && globalThis.__THREE_M2__.metrics().projectId.startsWith('m2-pong-copy-')
  ))
  const copied = await appFrame.evaluate(() => globalThis.__THREE_M2__.metrics())
  const copyPath = resolve(projectsRoot, copied.projectId, 'project.json')
  const copyBytes = readFileSync(copyPath)
  const copiedProject = JSON.parse(copyBytes)
  const copiedPaddle = copiedProject.scene.object.children
    .find(child => child.name === 'Left Paddle')
  originalProject = JSON.parse(readFileSync(originalPath))
  assert.equal(originalProject.title, 'AI Conflict Update')
  assert.equal(copiedProject.title, 'AI Clean Update (Local copy)')
  assert.equal(copiedPaddle.matrix[12], -3.25)
  assert.equal(
    createHash('sha256').update(copyBytes).digest('hex'),
    copied.revision,
  )

  await appFrame.getByRole('button', { name: 'Left Paddle', exact: true }).click()
  await appFrame.waitForFunction(() => globalThis.__THREE_M2__.metrics().selected === 'Left Paddle')
  await page.screenshot({
    path: resolve(artifacts, 'm2-harness-editor-conflict-copy.png'),
    fullPage: true,
  })

  await page.setViewportSize({ width: 640, height: 1000 })
  await page.waitForTimeout(300)
  const narrowCanvas = await appFrame.locator('[data-three-canvas]').boundingBox()
  const narrowHierarchy = await appFrame.locator('.hierarchy').boundingBox()
  const narrowInspector = await appFrame.locator('.inspector').boundingBox()
  assert.notEqual(narrowCanvas, null)
  assert.notEqual(narrowHierarchy, null)
  assert.notEqual(narrowInspector, null)
  assert.ok(narrowCanvas.width >= 450)
  assert.ok(narrowCanvas.height >= 330)
  assert.ok(narrowHierarchy.y >= narrowCanvas.y + narrowCanvas.height - 1)
  assert.equal(Math.round(narrowHierarchy.y), Math.round(narrowInspector.y))
  assert.deepEqual(appProblems, [])

  process.stdout.write(`${JSON.stringify({
    webUrl,
    catalog: publicToolNames,
    outer: outerBox,
    inner: innerBox,
    desktop: {
      canvas: canvasBox,
      hierarchy: hierarchyBox,
      inspector: inspectorBox,
    },
    pixels,
    humanSaved,
    reloaded,
    cleanReload,
    conflictState,
    copied: {
      metrics: copied,
      projectPath: copyPath,
      revision: copied.revision,
      paddleX: copiedPaddle.matrix[12],
    },
    original: {
      projectPath: originalPath,
      title: originalProject.title,
      revision: conflictRevision,
    },
    responsive: {
      canvas: narrowCanvas,
      hierarchy: narrowHierarchy,
      inspector: narrowInspector,
    },
    appProblems,
  }, null, 2)}\n`)
} catch (error) {
  await page.screenshot({
    path: resolve(artifacts, 'm2-harness-editor-conflict-copy-failure.png'),
    fullPage: true,
  })
  throw error
} finally {
  if (externalClient !== undefined) await externalClient.close()
  await browser.close()
}
