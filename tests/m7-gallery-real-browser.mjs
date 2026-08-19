import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const webUrl = process.env.DSH_WEB_URL
const workspacePath = process.env.THREEJS_EDITOR_MCP_WORKSPACE
if (webUrl === undefined || workspacePath === undefined) {
  throw new Error('DSH_WEB_URL and THREEJS_EDITOR_MCP_WORKSPACE are required')
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })

try {
  await page.goto(webUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  const continueButton = page.getByText('继续', { exact: true })
  if (await continueButton.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await continueButton.click()
  }
  await page.getByRole('button', { name: '添加工作区', exact: true }).click()
  await page.getByRole('heading', { name: '选择工作区目录' }).waitFor()
  await page.getByRole('button', { name: '编辑路径' }).click()
  const pathInput = page.getByRole('textbox', { name: '编辑路径' })
  await pathInput.fill(workspacePath)
  await pathInput.press('Enter')
  await page.getByRole('button', { name: '打开', exact: true }).click()
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })

  const composer = page.getByRole('textbox', {
    name: /描述你想要构建的内容|给智能体发消息/,
  })
  await composer.waitFor({ state: 'visible', timeout: 60_000 })
  await composer.fill('列出当前threejs工程有哪些')
  await composer.press('Enter')
  await page.waitForFunction(
    () => document.body.innerText.includes(
      'threejs-procedural-geometry/formula-one-race-car',
    ),
    undefined,
    { timeout: 120_000 },
  )

  await composer.fill('打开这个 threejs-procedural-geometry/formula-one-race-car')
  await composer.press('Enter')
  const outer = page.locator('iframe[title="MCP App: mcp__threejs__open_editor"]').last()
  await outer.waitFor({ state: 'visible', timeout: 120_000 })
  const body = await page.locator('body').innerText()
  assert.doesNotMatch(body, /npm install|gallery server|打开 HTML/i)

  await page.screenshot({
    path: 'artifacts/m7-gallery-real-direct-open.png',
    fullPage: false,
  })
  process.stdout.write(`${JSON.stringify({
    webUrl,
    workspacePath,
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    toolSequence: [
      'mcp__threejs__list_projects',
      'mcp__threejs__open_editor',
    ],
  }, null, 2)}\n`)
} finally {
  await browser.close()
}
