import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const webUrl = process.env.DSH_WEB_URL
if (webUrl === undefined) throw new Error('DSH_WEB_URL is required')

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({
  viewport: { width: 1346, height: 650 },
  deviceScaleFactor: 1,
})
const appProblems = []
page.on('console', message => {
  if (message.type() === 'error') appProblems.push(`console: ${message.text()}`)
})
page.on('pageerror', error => appProblems.push(`pageerror: ${error.message}`))

try {
  await page.goto(webUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  const appFrames = page.locator('iframe[title="MCP App: mcp__threejs__open_editor"]')
  if (!await appFrames.last().isVisible({ timeout: 5_000 }).catch(() => false)) {
    const openSidebar = page.getByRole('button', { name: '打开侧边栏', exact: true })
    if (await openSidebar.isVisible().catch(() => false)) await openSidebar.click()
    const sessions = page.getByRole('treeitem')
    await sessions.last().click()
  }
  const outer = appFrames.last()
  await outer.waitFor({ state: 'visible', timeout: 60_000 })
  const outerFrame = await (await outer.elementHandle()).contentFrame()
  assert.notEqual(outerFrame, null)
  const inner = outerFrame.locator('iframe')
  await inner.waitFor({ state: 'visible', timeout: 30_000 })
  const appFrame = await (await inner.elementHandle()).contentFrame()
  assert.notEqual(appFrame, null)
  await appFrame.locator('[data-three-editor]').waitFor({ state: 'visible', timeout: 30_000 })
  await appFrame.waitForFunction(() => {
    const metrics = globalThis.__THREE_M7__?.metrics()
    return metrics?.playState === 'editing' && metrics.m7.ready?.mode === 'edit'
  }, undefined, { timeout: 120_000 })

  await page.getByTitle('Open mcp__threejs__open_editor fullscreen').click()
  await page.locator('[data-mcp-app-view][data-display-mode="fullscreen"]').waitFor()
  const runtime = appFrame.locator('iframe[data-runtime-sandbox]')
  const runtimeFrame = await (await runtime.elementHandle()).contentFrame()
  assert.notEqual(runtimeFrame, null)
  const canvas = runtimeFrame.locator('canvas')
  const bounds = await canvas.boundingBox()
  assert.notEqual(bounds, null)

  await appFrame.getByRole('button', { name: 'VF-26', exact: true }).click()
  const beforeOrbit = await appFrame.evaluate(() => globalThis.__THREE_M7__.requestM7Metrics())
  let orbitPoint
  for (const candidate of [[1000, 430], [1100, 120], [120, 100], [1180, 450]]) {
    await page.mouse.move(bounds.x + candidate[0], bounds.y + candidate[1])
    await page.waitForTimeout(30)
    const hovered = await appFrame.evaluate(() => globalThis.__THREE_M7__.requestM7Metrics())
    if (hovered.transformAxis === null) {
      orbitPoint = candidate
      break
    }
  }
  assert.notEqual(orbitPoint, undefined, 'orbit test could not find a non-Gizmo point')
  await page.mouse.move(bounds.x + orbitPoint[0], bounds.y + orbitPoint[1])
  await page.mouse.down()
  await page.mouse.move(
    bounds.x + orbitPoint[0] - 140,
    bounds.y + orbitPoint[1] - 70,
    { steps: 16 },
  )
  await page.mouse.up()
  await page.waitForTimeout(200)
  const afterOrbit = await appFrame.evaluate(() => globalThis.__THREE_M7__.requestM7Metrics())
  assert.equal(
    await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics().selected),
    'VF-26',
  )
  assert.notDeepEqual(afterOrbit.cameraPosition, beforeOrbit.cameraPosition)

  await appFrame.getByRole('searchbox', { name: 'Search scene objects' }).fill('helmet')
  await appFrame.getByRole('button', { name: 'helmet', exact: true }).click()
  const helmet = await appFrame.evaluate(() => globalThis.__THREE_M7__.requestM7Metrics())
  assert.ok(Array.isArray(helmet.selectedScreenPosition))
  assert.ok(Math.hypot(...helmet.selectedBoundsCenter) > 0.25)
  for (let axis = 0; axis < 3; axis += 1) {
    assert.ok(Math.abs(
      helmet.gizmoWorldPosition[axis] - helmet.selectedBoundsCenter[axis],
    ) < 1e-6)
  }
  const [centerX, centerY] = helmet.selectedScreenPosition
  let gizmoPoint
  for (let y = centerY - 84; y <= centerY + 84 && gizmoPoint === undefined; y += 12) {
    for (let x = centerX - 84; x <= centerX + 84; x += 12) {
      if (x < 0 || y < 0 || x > bounds.width || y > bounds.height) continue
      await page.mouse.move(bounds.x + x, bounds.y + y)
      await page.waitForTimeout(8)
      const hovered = await appFrame.evaluate(() => globalThis.__THREE_M7__.requestM7Metrics())
      if (typeof hovered.transformAxis === 'string') {
        gizmoPoint = { x, y, axis: hovered.transformAxis }
        break
      }
    }
  }
  assert.notEqual(gizmoPoint, undefined, 'helmet TransformControls handle was not found')
  await page.mouse.move(bounds.x + gizmoPoint.x, bounds.y + gizmoPoint.y)
  await page.mouse.down()
  await page.mouse.move(
    bounds.x + gizmoPoint.x + 36,
    bounds.y + gizmoPoint.y + 18,
    { steps: 10 },
  )
  await page.mouse.up()
  const afterGizmo = await appFrame.evaluate(() => globalThis.__THREE_M7__.requestM7Metrics())
  assert.equal(
    await appFrame.evaluate(() => globalThis.__THREE_M7__.metrics().selected),
    'helmet',
  )
  assert.equal(afterGizmo.lastPointerPick.blocked, true)
  assert.notDeepEqual(afterGizmo.selectedBoundsCenter, helmet.selectedBoundsCenter)
  for (let axis = 0; axis < 3; axis += 1) {
    assert.ok(Math.abs(
      afterGizmo.gizmoWorldPosition[axis] - afterGizmo.selectedBoundsCenter[axis],
    ) < 1e-6)
  }
  assert.deepEqual(appProblems, [])

  process.stdout.write(`${JSON.stringify({
    webUrl,
    selectedAfterOrbit: 'VF-26',
    cameraChanged: true,
    selectedAfterGizmoDrag: 'helmet',
    gizmoAxis: gizmoPoint.axis,
    gizmoCenteredOnHelmet: true,
    gizmoPickBlocked: afterGizmo.lastPointerPick.blocked,
    appProblems,
  }, null, 2)}\n`)
} finally {
  await browser.close()
}
