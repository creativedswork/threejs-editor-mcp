import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const webUrl = process.env.DSH_WEB_URL
if (webUrl === undefined) throw new Error('DSH_WEB_URL is required')
const projectRoot = resolve(process.env.THREEJS_EDITOR_MCP_ROOT ?? '.')
const workspacePath = resolve(process.env.THREEJS_EDITOR_MCP_WORKSPACE ?? '')
if (workspacePath === projectRoot) throw new Error('THREEJS_EDITOR_MCP_WORKSPACE is required')
const artifacts = resolve(projectRoot, 'artifacts')
mkdirSync(artifacts, { recursive: true })

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
})
const appProblems = []
page.on('console', message => {
  if (message.type() === 'error') appProblems.push(`console: ${message.text()}`)
})
page.on('pageerror', error => appProblems.push(`pageerror: ${error.message}`))

try {
  await page.goto(webUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  })
  const addWorkspace = page.getByRole('button', { name: '添加工作区', exact: true })
  try {
    await addWorkspace.click({ timeout: 30_000 })
  } catch {
    const continueButton = page.getByText('继续', { exact: true })
    await continueButton.waitFor({ state: 'visible', timeout: 60_000 })
    await continueButton.click()
    await continueButton.waitFor({ state: 'hidden' })
    await addWorkspace.click({ timeout: 30_000 })
  }
  await page.getByRole('heading', { name: '选择工作区目录' }).waitFor()
  await page.getByRole('button', { name: '编辑路径' }).click()
  const pathInput = page.getByRole('textbox', { name: '编辑路径' })
  await pathInput.fill(workspacePath)
  await pathInput.press('Enter')
  await page.getByRole('button', { name: '打开', exact: true }).click()

  let composer = page.getByRole('textbox', {
    name: /描述你想要构建的内容|给智能体发消息/,
  })
  if (!await composer.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await page.reload({
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    composer = page.getByRole('textbox', {
      name: /描述你想要构建的内容|给智能体发消息/,
    })
  }
  try {
    await composer.waitFor({ state: 'visible', timeout: 60_000 })
  } catch (error) {
    await page.screenshot({
      path: resolve(artifacts, 'm7-gallery-composer-timeout.png'),
      fullPage: false,
    })
    throw new Error(
      `Composer did not appear after workspace selection:\n${
        (await page.locator('body').innerText()).slice(0, 4_000)
      }`,
      { cause: error },
    )
  }
  await composer.fill('列出当前threejs工程有哪些')
  await composer.press('Enter')
  await page.getByText('当前 DSH Workspace 已通过 Three.js MCP 列出 37 个图形/特效演示工程。')
    .waitFor({ timeout: 30_000 })

  await composer.fill('打开这个 threejs-procedural-geometry/formula-one-race-car')
  await composer.press('Enter')
  await page.getByText('已通过 Three.js MCP App 打开 Formula One Race Car。')
    .waitFor({ timeout: 30_000 })

  const outer = page.locator('iframe[title="MCP App: mcp__threejs__open_editor"]').last()
  await outer.waitFor({ state: 'visible', timeout: 30_000 })
  const outerFrame = await (await outer.elementHandle()).contentFrame()
  assert.notEqual(outerFrame, null)
  const inner = outerFrame.locator('iframe')
  await inner.waitFor({ state: 'visible', timeout: 15_000 })
  const appFrame = await (await inner.elementHandle()).contentFrame()
  assert.notEqual(appFrame, null)
  await appFrame.locator('[data-three-editor]').waitFor({ state: 'visible', timeout: 15_000 })
  await appFrame.waitForFunction(() => {
    const metrics = globalThis.__THREE_M7__?.metrics()
    return metrics?.frame > 10
      && metrics.sync === 'clean'
      && metrics.workspaceBackend === 'webgpu'
  })
  const opened = await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics())
  assert.match(opened.projectId, /^example-[a-f0-9]{56}$/)
  assert.equal(
    opened.workspaceEntry,
    'dev/example-gallery/examples/threejs-procedural-geometry/formula-one-race-car/scene.js',
  )
  assert.equal(opened.workspaceBackend, 'webgpu')

  await appFrame.getByRole('button', { name: 'Play' }).click()
  await appFrame.waitForFunction(() => {
    const metrics = globalThis.__THREE_M7__.metrics()
    return metrics.playState === 'playing'
      && metrics.m7.ready?.emittedParts === 62
      && metrics.m7.ready?.uniqueTriangles === 375964
  }, undefined, { timeout: 120_000 })
  const runtime = appFrame.locator('iframe[data-runtime-sandbox]')
  await runtime.waitFor({ state: 'visible', timeout: 120_000 })
  const runtimeFrame = await (await runtime.elementHandle()).contentFrame()
  assert.notEqual(runtimeFrame, null)
  const metrics = await appFrame.evaluate(() => globalThis.__THREE_M7__.requestM7Metrics())
  assert.equal(metrics.rendererBackend, 'WebGPUBackend')
  assert.equal(metrics.emittedParts, 62)
  assert.equal(metrics.uniqueTriangles, 375964)
  assert.equal(await runtimeFrame.evaluate(() => location.origin), 'null')

  const conversation = await page.locator('body').innerText()
  assert.doesNotMatch(conversation, /npm install|example-gallery server|打开 HTML/i)
  await page.screenshot({
    path: resolve(artifacts, 'm7-gallery-direct-open.png'),
    fullPage: false,
  })
  assert.deepEqual(appProblems, [])
  process.stdout.write(`${JSON.stringify({
    webUrl,
    transport: 'deterministic replay',
    prompts: [
      '列出当前threejs工程有哪些',
      '打开这个 threejs-procedural-geometry/formula-one-race-car',
    ],
    projectId: opened.projectId,
    entry: opened.workspaceEntry,
    backend: opened.workspaceBackend,
    rendererBackend: metrics.rendererBackend,
    emittedParts: metrics.emittedParts,
    uniqueTriangles: metrics.uniqueTriangles,
    appProblems,
  }, null, 2)}\n`)
} finally {
  await browser.close()
}
