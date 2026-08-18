import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { chromium } from 'playwright'
import * as THREE from 'three'

const webUrl = process.env.DSH_WEB_URL
if (webUrl === undefined) throw new Error('DSH_WEB_URL is required')
const serverCommand = process.env.THREEJS_EDITOR_MCP_SERVER
if (serverCommand === undefined) throw new Error('THREEJS_EDITOR_MCP_SERVER is required')
const projectRoot = resolve(process.env.THREEJS_EDITOR_MCP_ROOT ?? '.')
const projectsRoot = resolve(process.env.THREEJS_EDITOR_MCP_PROJECTS ?? '.tmp/m6-projects')
const workspaceRoot = resolve(process.env.THREEJS_EDITOR_MCP_WORKSPACE_ROOT ?? '.tmp/m6-workspaces')
const workspacePath = resolve(process.env.THREEJS_EDITOR_MCP_WORKSPACE ?? `${workspaceRoot}/linked-game`)
const artifacts = resolve(projectRoot, 'artifacts')
const frames = resolve(process.env.M6_FRAMES_DIR ?? `${projectRoot}/.playwright-mcp/gif-frames-m6`)
mkdirSync(artifacts, { recursive: true })
rmSync(frames, { recursive: true, force: true })
mkdirSync(frames, { recursive: true })

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
page.on('pageerror', error => appProblems.push(`pageerror: ${error.message}`))

let externalClient

function createSceneProjection() {
  const scene = new THREE.Scene()
  scene.name = 'M6 Linked Game'
  scene.background = new THREE.Color(0x050b13)
  scene.fog = new THREE.Fog(0x050b13, 12, 28)
  scene.add(new THREE.HemisphereLight(0xb8e2ff, 0x10233b, 2.4))
  const key = new THREE.DirectionalLight(0xe8f6ff, 4.1)
  key.name = 'Key Light'
  key.position.set(-3, 8, 5)
  key.castShadow = true
  scene.add(key)
  const field = new THREE.Mesh(
    new THREE.PlaneGeometry(10, 6),
    new THREE.MeshStandardMaterial({
      color: 0x102844,
      emissive: 0x061524,
      emissiveIntensity: 0.42,
      metalness: 0.2,
      roughness: 0.48,
    }),
  )
  field.name = 'Field'
  field.rotation.x = -Math.PI / 2
  field.receiveShadow = true
  scene.add(field)
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(0.32, 24, 16),
    new THREE.MeshPhysicalMaterial({
      color: 0xffd166,
      emissive: 0x5c3a00,
      emissiveIntensity: 0.2,
      roughness: 0.24,
      clearcoat: 0.85,
      clearcoatRoughness: 0.18,
    }),
  )
  ball.name = 'Ball'
  ball.position.set(0, 0.38, 0)
  ball.castShadow = true
  scene.add(ball)
  const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 100)
  camera.name = 'Camera'
  camera.position.set(0, 8.2, 9.4)
  camera.lookAt(0, 0, 0)
  scene.updateMatrixWorld(true)
  camera.updateMatrixWorld(true)
  return {
    schemaVersion: 1,
    title: 'M6 Linked Game',
    scene: scene.toJSON(),
    camera: camera.toJSON(),
    renderer: { antialias: true, shadows: true },
    script: { source: readFileSync(resolve(workspacePath, 'src/main.js'), 'utf8') },
    editor: {
      layout: 'classic',
      cameraView: 'broadcast',
      operations: [],
    },
  }
}

const scenePath = resolve(workspacePath, 'src/scene.json')
if (!readFileSync(resolve(workspacePath, 'package.json'), 'utf8').includes('m6-linked-game')) {
  throw new Error('M6 workspace fixture is not fresh')
}
writeFileSync(scenePath, `${JSON.stringify(createSceneProjection(), null, 2)}\n`)
execFileSync('git', ['add', 'src/scene.json'], { cwd: workspacePath })
execFileSync('git', ['commit', '-m', 'fixture: add scene projection'], {
  cwd: workspacePath,
  stdio: 'ignore',
})

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
  await appFrame.waitForFunction(() => (
    globalThis.__THREE_M6__?.metrics().frame > 10
    && globalThis.__THREE_M6__?.metrics().sync === 'clean'
    && globalThis.__THREE_M6__?.metrics().workspaceKind === 'linked-workspace'
  ))
  return { outer, inner, appFrame }
}

async function connectExternalClient() {
  const client = new Client({
    name: 'threejs-editor-m6-external-writer',
    version: '0.0.0',
  })
  await client.connect(new StdioClientTransport({
    command: serverCommand,
    args: [
      '--root',
      projectsRoot,
      '--workspace-root',
      workspaceRoot,
      '--workspace',
      `linked-game=${workspacePath}`,
    ],
  }))
  return client
}

async function enterFullscreen(appFrame) {
  await appFrame.getByRole('button', { name: 'Enter fullscreen' }).click()
  await page.locator('[data-mcp-app-view][data-display-mode="fullscreen"]')
    .waitFor({ state: 'visible' })
  await appFrame.waitForFunction(() => (
    globalThis.__THREE_M6__.metrics().displayMode === 'fullscreen'
  ))
}

async function exitFullscreen(appFrame) {
  const focus = appFrame.locator('[data-file-source]:not([disabled])')
  if (await focus.count() === 1) await focus.press('Escape')
  else await appFrame.getByRole('button', { name: 'Exit fullscreen' }).click()
  await page.locator('[data-mcp-app-view][data-display-mode="inline"]')
    .waitFor({ state: 'visible' })
  await appFrame.waitForFunction(() => (
    globalThis.__THREE_M6__.metrics().displayMode === 'inline'
  ))
}

try {
  await page.goto(webUrl, { waitUntil: 'domcontentloaded' })

  const catalog = await page.evaluate(async () => {
    const response = await fetch('/api/mcp-apps/catalog')
    return response.json()
  })
  assert.deepEqual(catalog.items.map(item => item.publicToolName).sort(), [
    'mcp__threejs__create_project',
    'mcp__threejs__create_workspace',
    'mcp__threejs__open_editor',
  ])

  const addWorkspace = page.getByRole('button', {
    name: '添加工作区',
    exact: true,
  })
  try {
    await addWorkspace.click({ timeout: 10_000 })
  } catch {
    const continueButton = page.getByRole('button', { name: '继续', exact: true })
    if (await continueButton.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await continueButton.click()
      await continueButton.waitFor({ state: 'hidden' })
    }
    await addWorkspace.click({ timeout: 30_000 })
  }
  await page.getByRole('heading', { name: '选择工作区目录' }).waitFor()
  await page.getByRole('button', { name: '编辑路径' }).click()
  const pathInput = page.getByRole('textbox', { name: '编辑路径' })
  await pathInput.fill(projectRoot)
  await pathInput.press('Enter')
  await page.getByRole('button', { name: '打开', exact: true }).click()

  const composer = page.getByRole('textbox', {
    name: /描述你想要构建的内容|给智能体发消息/,
  })
  await composer.fill('打开 M6 本地 Three.js 工程')
  await composer.press('Enter')
  await page.getByText('Three.js M6 linked workspace opened.').waitFor({ timeout: 20_000 })

  const { outer, inner, appFrame } = await appSurface()
  assert.equal(
    await page.locator('iframe[title="MCP App: mcp__threejs__open_editor"]').count(),
    1,
  )
  const initial = await appFrame.evaluate(() => globalThis.__THREE_M6__.metrics())
  assert.deepEqual(initial.workspaceFiles, [
    'package.json',
    'src/game-state.js',
    'src/main.js',
    'src/scene.json',
  ])
  assert.equal(initial.navigationTab, 'scene')
  assert.equal(await appFrame.getByText('THREE / VFX', { exact: true }).count(), 0)
  assert.equal(await appFrame.getByRole('combobox').count(), 0)
  assert.equal(await appFrame.getByRole('tab', { name: 'Files', exact: true }).count(), 0)
  assert.equal(await appFrame.getByRole('textbox', { name: 'Workspace file' }).count(), 0)
  assert.equal(await appFrame.getByRole('textbox', { name: 'Game script' }).count(), 0)
  assert.deepEqual(await appFrame.evaluate(() => ({
    uiDirection: document.querySelector('[data-three-editor]').dataset.uiDirection,
    visualStyle: document.querySelector('[data-three-editor]').dataset.visualStyle,
    panelBackground: getComputedStyle(document.querySelector('.panel')).backgroundColor,
    sceneBackground: getComputedStyle(document.querySelector('.workspace')).backgroundColor,
  })), {
    uiDirection: 'ethereal-glass',
    visualStyle: 'taste-ethereal-glass',
    panelBackground: 'rgba(4, 9, 16, 0.46)',
    sceneBackground: 'rgb(5, 11, 19)',
  })
  assert.ok((await appFrame.evaluate(() => globalThis.__THREE_M6__.pixelStats())).colors > 2)

  await enterFullscreen(appFrame)
  const fullscreenBox = await outer.boundingBox()
  const innerBox = await inner.boundingBox()
  assert.notEqual(fullscreenBox, null)
  assert.notEqual(innerBox, null)
  assert.ok(fullscreenBox.width >= 1270)
  assert.ok(fullscreenBox.height >= 990)
  assert.equal(Math.round(innerBox.width), Math.round(fullscreenBox.width))
  assert.equal(Math.round(innerBox.height), Math.round(fullscreenBox.height))
  await page.screenshot({
    path: resolve(frames, '00-linked-workspace.png'),
    fullPage: false,
  })

  await appFrame.getByRole('button', { name: 'Key Light', exact: true }).click()
  const positionX = appFrame.getByRole('spinbutton', { name: 'Position X' })
  await positionX.fill('-2.5')
  await positionX.press('Tab')
  await appFrame.waitForFunction(() => {
    const metrics = globalThis.__THREE_M6__.metrics()
    return metrics.sync === 'dirty'
      && metrics.lastOfficialCommands === 'SetPositionCommand'
  })
  await appFrame.getByRole('button', { name: 'Save', exact: true }).click()
  await appFrame.waitForFunction(() => (
    globalThis.__THREE_M6__.metrics().sync === 'clean'
  ))
  const humanRevision = (await appFrame.evaluate(() => globalThis.__THREE_M6__.metrics())).revision
  assert.match(readFileSync(resolve(workspacePath, 'src/main.js'), 'utf8'), /initial/)
  assert.equal(await page.getByText('AI updated both workspace files at the human revision.').count(), 0)
  await page.screenshot({
    path: resolve(frames, '01-human-scene-saved.png'),
    fullPage: false,
  })

  assert.match(
    execFileSync('git', ['diff', '--', 'src/scene.json'], {
      cwd: workspacePath,
      encoding: 'utf8',
    }),
    /-3[\s\S]*-2\.5/,
  )

  await exitFullscreen(appFrame)
  await composer.fill('读取我刚保存的 revision，并基于它同时更新协作状态和游戏配色')
  await composer.press('Enter')
  await page.getByText('AI updated both workspace files at the human revision.')
    .waitFor({ timeout: 30_000 })
  await appFrame.waitForFunction(previous => {
    const metrics = globalThis.__THREE_M6__.metrics()
    return metrics.sync === 'clean'
      && metrics.revision !== previous
  }, humanRevision)
  const aiState = await appFrame.evaluate(() => globalThis.__THREE_M6__.metrics())
  assert.equal(aiState.navigationTab, 'scene')
  assert.equal(aiState.activeFile, undefined)
  assert.match(readFileSync(resolve(workspacePath, 'src/main.js'), 'utf8'), /human \+ AI/)
  assert.match(readFileSync(resolve(workspacePath, 'src/game-state.js'), 'utf8'), /#56a8ff/)
  await enterFullscreen(appFrame)
  await page.screenshot({
    path: resolve(frames, '02-ai-two-file-update.png'),
    fullPage: false,
  })

  const aiDiff = execFileSync('git', ['diff', '--', 'src/main.js', 'src/game-state.js'], {
    cwd: workspacePath,
    encoding: 'utf8',
  })
  assert.match(aiDiff, /human \+ AI/)
  assert.match(aiDiff, /#56a8ff/)

  await appFrame.getByRole('button', { name: 'Key Light', exact: true }).click()
  await positionX.fill('-2.25')
  await positionX.press('Tab')
  await appFrame.waitForFunction(() => (
    globalThis.__THREE_M6__.metrics().sync === 'dirty'
    && globalThis.__THREE_M6__.object('Key Light').position[0] === -2.25
  ))
  externalClient = await connectExternalClient()
  const inspected = await externalClient.callTool({
    name: 'inspect_project',
    arguments: { projectId: 'linked-game' },
  })
  const external = await externalClient.callTool({
    name: 'apply_project_files',
    arguments: {
      projectId: 'linked-game',
      baseRevision: inspected.structuredContent.revision,
      changes: [{
        type: 'write',
        path: 'src/game-state.js',
        text: "export const gameState = {\n  collaboration: 'external',\n  accent: '#ffd166',\n}\n",
      }],
    },
  })
  assert.equal(external.isError, undefined)
  await appFrame.waitForFunction(expected => {
    const metrics = globalThis.__THREE_M6__.metrics()
    return metrics.sync === 'conflict'
      && metrics.remoteRevision === expected
      && globalThis.__THREE_M6__.object('Key Light').position[0] === -2.25
  }, external.structuredContent.revision)
  await page.screenshot({
    path: resolve(frames, '03-scene-conflict.png'),
    fullPage: false,
  })
  await page.screenshot({
    path: resolve(artifacts, 'm6-human-ai-workspace.png'),
    fullPage: false,
  })

  await page.setViewportSize({ width: 390, height: 844 })
  await appFrame.waitForFunction(() => (
    document.documentElement.clientWidth === 390
    && globalThis.__THREE_M6__.metrics().viewport?.startsWith('390x')
  ))
  const compactLayout = await appFrame.evaluate(() => {
    const hierarchy = document.querySelector('.hierarchy').getBoundingClientRect()
    const inspector = document.querySelector('.inspector').getBoundingClientRect()
    const canvas = document.querySelector('[data-three-canvas]').getBoundingClientRect()
    return {
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      canvas: { width: canvas.width, height: canvas.height },
      hierarchy: { left: hierarchy.left, right: hierarchy.right, top: hierarchy.top },
      inspector: { left: inspector.left, right: inspector.right, top: inspector.top },
    }
  })
  assert.equal(compactLayout.scrollWidth, compactLayout.width)
  assert.ok(compactLayout.canvas.height > 700)
  assert.ok(compactLayout.hierarchy.right < compactLayout.inspector.left)
  assert.equal(compactLayout.hierarchy.top, compactLayout.inspector.top)
  await page.screenshot({
    path: resolve(artifacts, 'm6-vfx-editor-mobile.png'),
    fullPage: false,
  })
  await page.setViewportSize({ width: 1280, height: 1000 })
  await appFrame.waitForFunction(() => (
    document.documentElement.clientWidth === 1280
    && globalThis.__THREE_M6__.metrics().viewport?.startsWith('1280x')
  ))

  await appFrame.getByRole('button', { name: 'Load external', exact: true }).click()
  await appFrame.waitForFunction(() => (
    globalThis.__THREE_M6__.metrics().sync === 'clean'
    && globalThis.__THREE_M6__.object('Key Light').position[0] === -2.5
  ))

  const transactionRoot = resolve(workspacePath, '.threejs-editor/transactions')
  const transactions = readdirSync(transactionRoot)
    .filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(resolve(transactionRoot, name), 'utf8')))
  const aiTransaction = transactions.find(transaction => (
    transaction.baseRevision === humanRevision
    && transaction.changes.some(change => change.path === 'src/main.js')
    && transaction.changes.some(change => change.path === 'src/game-state.js')
  ))
  assert.equal(aiTransaction.status, 'committed')
  assert.equal(
    readFileSync(resolve(workspacePath, '.threejs-editor/HEAD'), 'utf8').trim(),
    external.structuredContent.revision,
  )
  assert.deepEqual(appProblems, [])

  process.stdout.write(`${JSON.stringify({
    webUrl,
    transport: 'deterministic replay',
    catalog: catalog.items.map(item => item.publicToolName).sort(),
    humanRevision,
    aiRevision: aiState.revision,
    externalRevision: external.structuredContent.revision,
    command: aiState.lastOfficialCommands,
    workspaceFiles: aiState.workspaceFiles,
    fullscreen: fullscreenBox,
    compactLayout,
    frames: [
      '00-linked-workspace.png',
      '01-human-scene-saved.png',
      '02-ai-two-file-update.png',
      '03-scene-conflict.png',
    ],
    gitDiffSha256: createHash('sha256').update(aiDiff).digest('hex'),
    appProblems,
  }, null, 2)}\n`)
} catch (error) {
  await page.screenshot({
    path: resolve(artifacts, 'm6-human-ai-workspace-failure.png'),
    fullPage: true,
  })
  throw error
} finally {
  await externalClient?.close()
  await browser.close()
}
