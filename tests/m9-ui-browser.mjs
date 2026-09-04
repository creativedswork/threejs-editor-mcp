import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import {
  createWriteStream,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, resolve } from 'node:path'
import { chromium } from 'playwright'

const projectRoot = resolve(process.env.THREEJS_EDITOR_MCP_ROOT ?? '.')
const harnessRoot = resolve(
  process.env.DSH_HARNESS_ROOT ?? `${projectRoot}/../deepseek-harness`,
)
const dshEntrypoint = resolve(
  process.env.DSH_ENTRYPOINT ?? `${harnessRoot}/apps/cli/lib/bin.js`,
)
const uniEditorRoot = resolve(
  process.env.DSH_UNI_EDITOR_ROOT ?? `${projectRoot}/../dsh-uni-editor`,
)
const replayRoot = resolve(
  process.env.DSH_REPLAY_ROOT ?? `${harnessRoot}/packages/test-support/llm-replay`,
)
const workspacePath = resolve(process.env.THREEJS_EDITOR_MCP_WORKSPACE ?? '')
const runRoot = process.env.M9_RUN_ROOT === undefined
  ? mkdtempSync(`${tmpdir()}/threejs-m9-ui.`)
  : resolve(process.env.M9_RUN_ROOT)
const projectsPath = resolve(process.env.THREEJS_EDITOR_MCP_PROJECTS ?? `${runRoot}/projects`)
const artifactPath = resolve(process.env.M9_UI_SCREENSHOT ?? 'reports/assets/m9-p5-ui.png')
const resultPath = resolve(process.env.M9_UI_RESULT ?? 'reports/M9-ui-result.json')
const tracePath = resolve(process.env.M9_UI_TRACE ?? 'reports/M9-ui-trace.zip')
const runTracePath = resolve(runRoot, 'trace.zip')
const startupTimeout = Number(process.env.M9_START_TIMEOUT ?? 120_000)
if (workspacePath === projectRoot) throw new Error('THREEJS_EDITOR_MCP_WORKSPACE is required')
const startedAt = Date.now()

function stage(message) {
  process.stderr.write(`[m9-ui +${String(Date.now() - startedAt)}ms] ${message}\n`)
}

const dshHome = resolve(runRoot, 'home')
const agentHome = resolve(runRoot, 'agents-home')
const pnpmHome = resolve(runRoot, 'pnpm-home')
const cacheHome = resolve(runRoot, 'cache')
const hostLogPath = resolve(runRoot, 'host.log')
const replayPatch = resolve(
  process.env.M9_REPLAY_PATCH ?? `${projectRoot}/tests/fixtures/m9/replay.patch.yml`,
)
const serverPatch = resolve(projectRoot, 'tests/fixtures/m9/cordis.patch.yml')
const serverPath = resolve(
  process.env.THREEJS_EDITOR_MCP_SERVER ?? `${projectRoot}/dist/server.js`,
)
mkdirSync(projectsPath, { recursive: true })
mkdirSync(agentHome, { recursive: true })
mkdirSync(pnpmHome, { recursive: true })
mkdirSync(cacheHome, { recursive: true })
mkdirSync(runRoot, { recursive: true })
mkdirSync(resolve(artifactPath, '..'), { recursive: true })
mkdirSync(resolve(resultPath, '..'), { recursive: true })
mkdirSync(resolve(tracePath, '..'), { recursive: true })

const isolatedEnv = {
  ...process.env,
  DSH_HOME: dshHome,
  DSH_AGENTS_HOME: agentHome,
  DSH_TELEMETRY_DISABLED: '1',
  PNPM_HOME: pnpmHome,
  XDG_CACHE_HOME: cacheHome,
  THREEJS_EDITOR_MCP_SERVER: serverPath,
  THREEJS_EDITOR_MCP_ROOT: projectRoot,
  THREEJS_EDITOR_MCP_PROJECTS: projectsPath,
  THREEJS_EDITOR_MCP_WORKSPACE: workspacePath,
}

function dsh(args, options = {}) {
  return execFileSync('pnpm', ['dsh', ...args], {
    cwd: harnessRoot,
    env: isolatedEnv,
    encoding: 'utf8',
    timeout: startupTimeout,
    ...options,
  })
}

async function freePort() {
  const server = createServer()
  await new Promise((accept, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', accept)
  })
  const address = server.address()
  assert.notEqual(address, null)
  assert.equal(typeof address, 'object')
  await new Promise((accept, reject) => server.close(error => (
    error === undefined ? accept() : reject(error)
  )))
  return address.port
}

async function waitForHost(webUrl, child) {
  const deadline = Date.now() + startupTimeout
  while (Date.now() < deadline) {
    assert.equal(
      child.exitCode ?? child.signalCode,
      null,
      `DSH exited before becoming ready; log: ${hostLogPath}`,
    )
    try {
      const response = await fetch(webUrl, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) {
        await new Promise(resolve_ => setTimeout(resolve_, 1_000))
        assert.equal(
          child.exitCode ?? child.signalCode,
          null,
          `DSH exited during readiness stabilization; log: ${hostLogPath}`,
        )
        const stable = await fetch(webUrl, { signal: AbortSignal.timeout(2_000) })
        if (stable.ok) return
      }
    } catch {}
    await new Promise(resolve_ => setTimeout(resolve_, 200))
  }
  throw new Error(`DSH did not become ready within ${startupTimeout} ms; log: ${hostLogPath}`)
}

async function stopProcess(child) {
  if (child === undefined || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise(resolve_ => child.once('close', resolve_)),
    new Promise(resolve_ => setTimeout(resolve_, 10_000)),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
}

if (process.env.M9_SKIP_PROVISION === '1') {
  stage(`reusing isolated profile at ${dshHome}`)
} else {
  stage(`provisioning isolated profile at ${dshHome}`)
  dsh(['plugin', '--profile', 'web', 'add', uniEditorRoot, replayRoot], { stdio: 'inherit' })
}

stage('doctor: checking installed bundle and local MCP server')
const profileDir = resolve(dshHome, 'profiles/web')
const manifest = JSON.parse(readFileSync(resolve(profileDir, 'package.json'), 'utf8'))
assert.equal(
  manifest.dependencies?.['@creative-dswork/dsh-uni-editor'],
  `link:${uniEditorRoot}`,
)
assert.ok(manifest.dsh?.profile?.bundles.includes('@creative-dswork/dsh-uni-editor'))
assert.equal(
  realpathSync(resolve(profileDir, 'node_modules/@creative-dswork/dsh-uni-editor')),
  realpathSync(uniEditorRoot),
)
assert.equal(
  realpathSync(resolve(profileDir, 'node_modules/@deepseek-ai/dsh-llm-replay')),
  realpathSync(replayRoot),
)
assert.equal(existsSync(dshEntrypoint), true, `missing DSH CLI build: ${dshEntrypoint}`)
assert.equal(existsSync(serverPath), true, `missing MCP server build: ${serverPath}`)

stage('dump-config: checking mcp-apps and threejs overlays')
const dump = dsh([
  '--profile', 'web',
  '--patch', replayPatch,
  '--patch', serverPatch,
  '--dump-config',
])
assert.match(dump, /@creative-dswork\/dsh-uni-editor/)
assert.match(dump, /id: mcp-apps/)
assert.match(dump, /serverName: threejs/)
assert.match(dump, /forwardWorkspace: true/)
assert.doesNotMatch(dump, /patch entry "mcp-apps" not found/)

const port = await freePort()
const webUrl = `http://127.0.0.1:${port}`
stage(`starting isolated DSH at ${webUrl}`)
const hostLog = createWriteStream(hostLogPath)
const host = spawn(process.execPath, [
  dshEntrypoint,
  '--profile', 'web',
  '--patch', replayPatch,
  '--patch', serverPatch,
  '--host', '127.0.0.1',
  '--port', String(port),
  '--no-open',
], {
  cwd: harnessRoot,
  env: isolatedEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
})
for (const stream of [host.stdout, host.stderr]) {
  stream.on('data', chunk => {
    hostLog.write(chunk)
    process.stderr.write(`[m9-host] ${String(chunk)}`)
  })
}

let browser
let context
let page
const browserProblems = []

function browserProblem(type, text) {
  const compact = text.replace(
    /data:[^,;\s]+(?:;[^,\s]+)*,[A-Za-z0-9+/=_-]+/g,
    '[data URL omitted]',
  )
  browserProblems.push(`${type}: ${compact.slice(0, 1_000)}`)
}

async function addWorkspace() {
  const add = page.getByRole('button', { name: '添加工作区', exact: true })
  const notice = page.getByRole('dialog', { name: '内测声明', exact: true })
  await notice.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
  if (await notice.isVisible().catch(() => false)) {
    const proceed = notice.getByRole('button', { name: '继续', exact: true })
    await proceed.click()
    await notice.waitFor({ state: 'hidden' })
  }
  const picker = page.getByRole('dialog', { name: '选择工作区目录' })
  if (!await picker.isVisible().catch(() => false)) await add.click({ timeout: 30_000 })
  await page.getByRole('button', { name: '编辑路径', exact: true }).click()
  const path = page.getByRole('textbox', { name: '编辑路径', exact: true })
  await path.fill(workspacePath)
  await path.press('Enter')
  await picker.getByRole('button', { name: '打开', exact: true }).click()
  await picker.waitFor({ state: 'hidden', timeout: 30_000 })
}

function hasConfiguredWorkspace() {
  const storePath = resolve(dshHome, 'storages/workspace.json')
  if (!existsSync(storePath)) return false
  const store = JSON.parse(readFileSync(storePath, 'utf8'))
  return Object.values(store.tables?.workspaces ?? {})
    .some(workspace => resolve(workspace.path) === workspacePath)
}

async function waitForLatestTurn(minimumTurn = 1) {
  const deadline = Date.now() + startupTimeout
  while (Date.now() < deadline) {
    const workspaceStore = JSON.parse(readFileSync(resolve(dshHome, 'storages/workspace.json'), 'utf8'))
    const workspace = Object.values(workspaceStore.tables?.workspaces ?? {})
      .find(item => resolve(item.path) === workspacePath)
    const sessionId = workspace?.sessionIds?.[0]
    const sessionStore = JSON.parse(readFileSync(resolve(
      dshHome,
      'storages/session_projcache.json',
    ), 'utf8'))
    const stats = sessionStore.tables?.sessions?.[sessionId]?.rows?.sessionStats?.val
    if (stats?.lastTurn >= minimumTurn && stats.openStep === null) return sessionId
    await new Promise(resolve_ => setTimeout(resolve_, 100))
  }
  throw new Error(`Replay turn did not settle within ${startupTimeout} ms`)
}

async function readyComposer() {
  const composer = page.locator(
    'textarea:enabled[placeholder="描述你想要构建的内容"], '
    + 'textarea:enabled[placeholder="给智能体发消息"]',
  )
  if (await composer.isVisible().catch(() => false)) return composer

  if (hasConfiguredWorkspace()) {
    const workspaceName = basename(workspacePath)
    const workspaceRow = page.getByRole('treeitem')
      .filter({ hasText: workspaceName })
      .first()
    await workspaceRow.hover({ timeout: 30_000 })
    await page.getByRole('button', {
      name: `在“${workspaceName}”中新建会话`,
      exact: true,
    }).click({ timeout: 30_000 })
  } else {
    await addWorkspace()
  }
  await composer.waitFor({ state: 'visible', timeout: 30_000 })
  return composer
}

async function appFrame() {
  stage('waiting for editor app frame')
  const outer = page.locator('iframe[title="MCP App: mcp__threejs__open_editor"]').last()
  await outer.waitFor({ state: 'visible', timeout: startupTimeout })
  const shell = await (await outer.elementHandle()).contentFrame()
  assert.notEqual(shell, null)
  const inner = shell.locator('iframe')
  try {
    await inner.waitFor({ state: 'attached', timeout: 30_000 })
  } catch (error) {
    const appError = await page.locator('[data-mcp-app-error]').last().textContent()
      .catch(() => undefined)
    throw new Error(`MCP App frame did not load: ${JSON.stringify({
      appError,
      browserProblems: browserProblems.slice(-30),
    })}`, { cause: error })
  }
  const app = await (await inner.elementHandle()).contentFrame()
  assert.notEqual(app, null)
  try {
    await app.waitForFunction(() => {
      const value = globalThis.__THREE_M7__?.metrics()
      return value?.playState === 'error'
        || (value?.sync === 'clean'
          && value.playState === 'editing'
          && value.m7?.ready?.mode === 'edit')
    }, undefined, { timeout: startupTimeout })
    const metrics = await app.evaluate(() => globalThis.__THREE_M7__?.metrics())
    if (metrics?.playState !== 'editing' || metrics.m7?.ready?.mode !== 'edit') {
      throw new Error(`Editor Runtime failed: ${JSON.stringify({
        metrics,
        browserProblems: browserProblems.slice(-30),
      })}`)
    }
  } catch (error) {
    const metrics = await app.evaluate(() => globalThis.__THREE_M7__?.metrics())
      .catch(() => undefined)
    throw new Error(`Editor Runtime did not start: ${JSON.stringify({
      metrics,
      browserProblems: browserProblems.slice(-30),
    })}`, { cause: error })
  }
  stage('editor app frame ready')
  return app
}

async function catalogEditor() {
  const catalogResponse = await fetch(`${webUrl}/api/mcp-apps/catalog`)
  const catalog = await catalogResponse.json()
  assert.equal(catalogResponse.ok, true, JSON.stringify(catalog))
  const editor = catalog.items.find(item => item.publicToolName === 'mcp__threejs__open_editor')
  assert.notEqual(editor, undefined)
  return editor
}

async function callRuntimeTool(name, arguments_, ownerSessionId) {
  const editor = await catalogEditor()
  const response = await fetch(`${webUrl}/api/mcp-apps/tool`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      viewId: editor.viewId,
      name,
      arguments: arguments_,
      sessionId: ownerSessionId,
      connectionGeneration: editor.connectionGeneration,
    }),
  })
  const result = await response.json()
  assert.equal(response.status, 200, JSON.stringify(result))
  assert.notEqual(result.isError, true, JSON.stringify(result))
  return result
}

try {
  await waitForHost(webUrl, host)
  stage('launching browser')
  browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH === undefined
      ? { channel: 'chrome' }
      : { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }),
    headless: true,
    args: process.platform === 'darwin' ? ['--use-angle=metal'] : [],
  })
  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
  })
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
  page = await context.newPage()
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') {
      browserProblem(message.type(), message.text())
    }
  })
  page.on('pageerror', error => browserProblem('pageerror', error.message))

  stage(`navigating to ${webUrl}`)
  await page.goto(webUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  let composer = await readyComposer()
  stage('submitting open-editor replay prompt')
  await composer.fill('打开 threejs-volumetric-clouds/weather-volume-clouds')
  await composer.press('Enter')
  const ownerSessionId = await waitForLatestTurn()
  stage('reloading settled replay session')
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.getByRole('tab', { name: '对话', exact: true }).click()
  composer = page.locator(
    'textarea:enabled[placeholder="描述你想要构建的内容"], '
    + 'textarea:enabled[placeholder="给智能体发消息"]',
  )
  await composer.waitFor({ state: 'visible', timeout: 30_000 })
  let app = await appFrame()
  const initial = await app.evaluate(() => globalThis.__THREE_M7__.metrics())

  const quality = app.getByRole('combobox', { name: '画质' })
  await quality.waitFor({ state: 'visible' })
  assert.deepEqual(await quality.locator('option').allTextContents(), ['均衡', '流畅', '精细'])
  await quality.selectOption('performance')
  await app.waitForFunction(previous => {
    const value = globalThis.__THREE_M7__.metrics()
    return value.revision !== previous
      && value.sync === 'clean'
      && value.runtimeQualityTier === 'performance'
      && value.m7?.ready?.qualityTier === 'performance'
  }, initial.revision, { timeout: 120_000 })
  const human = await app.evaluate(() => globalThis.__THREE_M7__.metrics())
  const statePath = resolve(
    projectsPath,
    '.managed-workspaces',
    human.projectId,
    'threejs.editor.json',
  )
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).qualityTier, 'performance')

  stage('submitting agent edit and build replay prompt')
  await composer.fill(
    `把项目 projectId=${human.projectId} 在 baseRevision=${human.revision} `
    + '的云层覆盖度改为 0.46，并构建当前版本。',
  )
  await composer.press('Enter')
  assert.equal(await waitForLatestTurn(2), ownerSessionId)
  await app.waitForFunction(previous => {
    const value = globalThis.__THREE_M7__.metrics()
    return value.revision !== previous
      && value.sync === 'clean'
      && value.playState === 'editing'
      && value.m7?.build?.revision === value.revision
  }, human.revision, { timeout: 120_000 })
  const ai = await app.evaluate(() => globalThis.__THREE_M7__.metrics())
  const source = readFileSync(resolve(
    projectsPath,
    '.managed-workspaces',
    ai.projectId,
    'dev/example-gallery/examples/threejs-volumetric-clouds/weather-volume-clouds/scene.js',
  ), 'utf8')
  assert.match(source, /clouds\.coverage = 0\.46;/)

  await page.locator('[data-mcp-app-header-action]')
    .getByTitle('Open mcp__threejs__open_editor fullscreen', { exact: true }).click()
  await page.locator('[data-mcp-app-view][data-display-mode="fullscreen"]').waitFor()
  app = await appFrame()
  stage('starting runtime')
  await app.getByRole('button', { name: 'Play', exact: true }).click()
  await app.waitForFunction(() => {
    const value = globalThis.__THREE_M7__.metrics()
    return value.playState === 'playing'
      && value.m7?.metrics?.qualityTier === 'performance'
      && value.m7?.build?.revision === value.revision
      && value.m7?.metrics?.buildId === value.m7?.build?.buildId
  }, undefined, { timeout: 120_000 })
  const running = await app.evaluate(() => globalThis.__THREE_M7__.metrics())
  const runtimeRef = running.m7?.lifecycle?.committed?.runtime?.run?.runtimeRef
  assert.equal(typeof runtimeRef, 'string')
  const evidence = await callRuntimeTool('capture_runtime_frame', {
    projectId: running.projectId,
    runtimeRef,
    target: 'validation',
    deterministic: true,
    format: 'jpeg',
    maxWidth: 512,
    maxHeight: 512,
  }, ownerSessionId)
  assert.equal(evidence.isError, undefined, JSON.stringify(evidence))
  const evidenceRuntime = evidence.structuredContent.runtime
  const afterEvidence = await app.evaluate(() => globalThis.__THREE_M7__.metrics())
  assert.equal(evidenceRuntime.execution.projectId, running.projectId)
  assert.equal(evidenceRuntime.execution.runId, afterEvidence.m7.validationRunId)
  assert.equal(evidenceRuntime.execution.nonce, afterEvidence.m7.validationNonce)
  assert.equal(evidenceRuntime.projection.workspaceRevision, running.revision)
  assert.equal(evidenceRuntime.projection.loadedBuild.sourceRevision, running.revision)
  assert.equal(evidenceRuntime.projection.loadedBuild.buildId, running.m7.build.buildId)
  assert.equal(evidence.structuredContent.deterministic, true)

  stage('inducing and recovering from WebGL context loss')
  await page.screenshot({ path: artifactPath, fullPage: false })
  const runtimeElement = app.locator('iframe[data-runtime-sandbox]')
  const runtime = await (await runtimeElement.elementHandle()).contentFrame()
  assert.notEqual(runtime, null)
  const lost = await runtime.evaluate(() => {
    const gl = document.querySelector('canvas').getContext('webgl2')
    const extension = gl?.getExtension('WEBGL_lose_context')
    extension?.loseContext()
    return extension !== null && extension !== undefined
  })
  assert.equal(lost, true)
  await app.waitForFunction(() => {
    const value = globalThis.__THREE_M7__.metrics()
    return value.playState === 'error'
      && value.m7.active === false
      && value.runtimeErrors.some(message => message.includes('restart the Runtime'))
  }, undefined, { timeout: 30_000 })
  const stopped = await app.evaluate(() => globalThis.__THREE_M7__.metrics())
  await app.getByRole('button', { name: 'Play', exact: true }).click()
  await app.waitForFunction(previousRunId => {
    const value = globalThis.__THREE_M7__.metrics()
    return value.playState === 'playing'
      && value.m7?.active === true
      && value.m7?.runId !== previousRunId
      && value.m7?.build?.revision === value.revision
      && value.m7?.metrics?.buildId === value.m7?.build?.buildId
  }, running.m7.runId, { timeout: 120_000 })
  const recovered = await app.evaluate(() => globalThis.__THREE_M7__.metrics())

  assert.deepEqual(browserProblems, [])
  stage('all assertions passed')
  const result = {
    transport: 'deterministic Replay through DSH Agent Loop',
    profile: {
      dshHome,
      bundle: realpathSync(resolve(
        profileDir,
        'node_modules/@creative-dswork/dsh-uni-editor',
      )),
      mcpServer: serverPath,
    },
    projectId: running.projectId,
    revisions: {
      source: initial.revision,
      humanQuality: human.revision,
      aiVisualParameter: ai.revision,
    },
    buildId: running.m7.build.buildId,
    runId: running.m7.runId,
    evidence: evidence.structuredContent,
    qualityTier: running.runtimeQualityTier,
    contextLoss: {
      stopped: stopped.m7.active === false,
      state: stopped.playState,
      diagnostic: stopped.runtimeErrors.at(-1),
      recovered: true,
      recoveryRunId: recovered.m7.runId,
      recoveryBuildId: recovered.m7.build.buildId,
    },
    screenshot: artifactPath,
    trace: tracePath,
    hostLog: hostLogPath,
    browserProblems,
  }
  await context.tracing.stop({ path: runTracePath })
  context = undefined
  copyFileSync(runTracePath, tracePath)
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} finally {
  if (context !== undefined) {
    await context.tracing.stop({ path: runTracePath }).catch(() => {})
  }
  await browser?.close()
  await stopProcess(host)
  hostLog.end()
  stage(`cleaned isolated processes; run root preserved at ${runRoot}`)
}
