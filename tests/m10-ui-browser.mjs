import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { basename, resolve } from 'node:path'
import { chromium } from 'playwright'

const projectRoot = resolve(process.env.THREEJS_EDITOR_MCP_ROOT ?? '.')
const corpusRoot = resolve(process.env.THREEJS_EDITOR_MCP_WORKSPACE ?? '')
if (corpusRoot === projectRoot) throw new Error('THREEJS_EDITOR_MCP_WORKSPACE is required')
const harnessRoot = resolve(process.env.DSH_HARNESS_ROOT ?? `${projectRoot}/../deepseek-harness`)
const uniEditorRoot = resolve(process.env.DSH_UNI_EDITOR_ROOT ?? `${projectRoot}/../dsh-uni-editor`)
const replayRoot = resolve(
  process.env.DSH_REPLAY_ROOT ?? `${harnessRoot}/packages/test-support/llm-replay`,
)
const dshEntrypoint = resolve(
  process.env.DSH_ENTRYPOINT ?? `${harnessRoot}/apps/cli/lib/bin.js`,
)
const runRoot = resolve(process.env.M10_DSH_RUN_ROOT ?? '.tmp/m10-dsh-runtime')
const workspacePath = resolve(runRoot, 'workspace')
const projectsPath = resolve(runRoot, 'projects')
const dshHome = resolve(runRoot, 'home')
const agentHome = resolve(runRoot, 'agents-home')
const pnpmHome = resolve(runRoot, 'pnpm-home')
const cacheHome = resolve(runRoot, 'cache')
const hostLogPath = resolve(runRoot, 'host.log')
const resultPath = resolve(runRoot, 'M10-dsh-result.json')
const screenshotPath = resolve('.playwright-mcp/m10/dsh-p6.png')
const startupTimeout = Number(process.env.M10_DSH_START_TIMEOUT ?? 120_000)
const startedAt = Date.now()

for (const path of [
  runRoot,
  projectsPath,
  agentHome,
  pnpmHome,
  cacheHome,
  resolve(screenshotPath, '..'),
]) {
  mkdirSync(path, { recursive: true })
}

execFileSync(process.execPath, [
  resolve(projectRoot, 'scripts/prepare-m10-p6.mjs'),
  corpusRoot,
  workspacePath,
], { cwd: projectRoot, stdio: 'inherit' })

const isolatedEnv = {
  ...process.env,
  DSH_HOME: dshHome,
  DSH_AGENTS_HOME: agentHome,
  DSH_TELEMETRY_DISABLED: '1',
  PNPM_HOME: pnpmHome,
  XDG_CACHE_HOME: cacheHome,
  THREEJS_EDITOR_MCP_SERVER: resolve(projectRoot, 'dist/server.js'),
  THREEJS_EDITOR_MCP_ROOT: projectRoot,
  THREEJS_EDITOR_MCP_PROJECTS: projectsPath,
  THREEJS_EDITOR_MCP_WORKSPACE: workspacePath,
}
const replayPatch = resolve(projectRoot, 'tests/fixtures/m10/replay.patch.yml')
const serverPatch = resolve(projectRoot, 'tests/fixtures/m9/cordis.patch.yml')

function stage(message) {
  process.stderr.write(`[m10-dsh +${String(Date.now() - startedAt)}ms] ${message}\n`)
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

async function waitForHost(url, host) {
  const deadline = Date.now() + startupTimeout
  while (Date.now() < deadline) {
    assert.equal(
      host.exitCode ?? host.signalCode,
      null,
      `DSH exited before readiness; see ${hostLogPath}`,
    )
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
    } catch {}
    await new Promise(resolveDelay => setTimeout(resolveDelay, 200))
  }
  throw new Error(`DSH did not become ready within ${startupTimeout} ms`)
}

async function stopProcess(child) {
  if (child === undefined || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise(resolveClose => child.once('close', resolveClose)),
    new Promise(resolveDelay => setTimeout(resolveDelay, 10_000)),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
}

function hasWorkspace() {
  const path = resolve(dshHome, 'storages/workspace.json')
  if (!existsSync(path)) return false
  const store = JSON.parse(readFileSync(path, 'utf8'))
  return Object.values(store.tables?.workspaces ?? {})
    .some(workspace => resolve(workspace.path) === workspacePath)
}

async function addWorkspace(page) {
  const notice = page.getByRole('dialog', { name: '内测声明', exact: true })
  await notice.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
  if (await notice.isVisible().catch(() => false)) {
    await notice.getByRole('button', { name: '继续', exact: true }).click()
    await notice.waitFor({ state: 'hidden' })
  }
  const add = page.getByRole('button', { name: '添加工作区', exact: true })
  const picker = page.getByRole('dialog', { name: '选择工作区目录' })
  if (!await picker.isVisible().catch(() => false)) await add.click({ timeout: 30_000 })
  await page.getByRole('button', { name: '编辑路径', exact: true }).click()
  const path = page.getByRole('textbox', { name: '编辑路径', exact: true })
  await path.fill(workspacePath)
  await path.press('Enter')
  await picker.getByRole('button', { name: '打开', exact: true }).click()
  await picker.waitFor({ state: 'hidden', timeout: 30_000 })
}

async function readyComposer(page) {
  const composer = page.locator(
    'textarea:enabled[placeholder="描述你想要构建的内容"], '
      + 'textarea:enabled[placeholder="给智能体发消息"]',
  )
  if (await composer.isVisible().catch(() => false)) return composer
  if (hasWorkspace()) {
    const workspaceName = basename(workspacePath)
    const workspaceRow = page.getByRole('treeitem').filter({ hasText: workspaceName }).first()
    await workspaceRow.hover({ timeout: 30_000 })
    await page.getByRole('button', {
      name: `在“${workspaceName}”中新建会话`,
      exact: true,
    }).click({ timeout: 30_000 })
  } else {
    await addWorkspace(page)
  }
  await composer.waitFor({ state: 'visible', timeout: 30_000 })
  return composer
}

async function waitForLatestTurn() {
  const deadline = Date.now() + startupTimeout
  while (Date.now() < deadline) {
    const workspaceStore = JSON.parse(readFileSync(
      resolve(dshHome, 'storages/workspace.json'),
      'utf8',
    ))
    const workspace = Object.values(workspaceStore.tables?.workspaces ?? {})
      .find(item => resolve(item.path) === workspacePath)
    const sessionId = workspace?.sessionIds?.[0]
    if (sessionId !== undefined) {
      const sessionStore = JSON.parse(readFileSync(
        resolve(dshHome, 'storages/session_projcache.json'),
        'utf8',
      ))
      const stats = sessionStore.tables?.sessions?.[sessionId]?.rows?.sessionStats?.val
      if (stats?.lastTurn >= 1 && stats.openStep === null) return sessionId
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
  }
  throw new Error(`Replay turn did not settle within ${startupTimeout} ms`)
}

async function appFrame(page) {
  const outer = page.locator('iframe[title="MCP App: mcp__threejs__open_editor"]').last()
  await outer.waitFor({ state: 'visible', timeout: startupTimeout })
  const shell = await (await outer.elementHandle()).contentFrame()
  assert.notEqual(shell, null)
  const inner = shell.locator('iframe')
  await inner.waitFor({ state: 'attached', timeout: 30_000 })
  const app = await (await inner.elementHandle()).contentFrame()
  assert.notEqual(app, null)
  await app.waitForFunction(() => {
    const value = globalThis.__THREE_M7__?.metrics()
    return value?.playState === 'editing'
      && value.sync === 'clean'
      && value.workspaceBackend === 'webgpu'
      && value.m7?.ready?.mode === 'edit'
  }, undefined, { timeout: startupTimeout })
  return app
}

async function callRuntimeTool(url, name, arguments_, sessionId) {
  const catalog = await fetch(`${url}/api/mcp-apps/catalog`).then(response => response.json())
  const editor = catalog.items.find(item => item.publicToolName === 'mcp__threejs__open_editor')
  assert.notEqual(editor, undefined)
  const response = await fetch(`${url}/api/mcp-apps/tool`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      viewId: editor.viewId,
      name,
      arguments: arguments_,
      sessionId,
      connectionGeneration: editor.connectionGeneration,
    }),
  })
  const result = await response.json()
  assert.equal(response.status, 200, JSON.stringify(result))
  assert.notEqual(result.isError, true, JSON.stringify(result))
  return result
}

stage('provisioning isolated DSH profile')
dsh(['plugin', '--profile', 'web', 'add', uniEditorRoot, replayRoot], { stdio: 'inherit' })
const profileDir = resolve(dshHome, 'profiles/web')
assert.equal(
  realpathSync(resolve(profileDir, 'node_modules/@creative-dswork/dsh-uni-editor')),
  realpathSync(uniEditorRoot),
)
assert.equal(existsSync(dshEntrypoint), true)
const dump = dsh([
  '--profile', 'web',
  '--patch', replayPatch,
  '--patch', serverPatch,
  '--dump-config',
])
assert.match(dump, /serverName: threejs/)
assert.match(dump, /forwardWorkspace: true/)

const port = await freePort()
const webUrl = `http://127.0.0.1:${String(port)}`
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
    process.stderr.write(`[m10-host] ${String(chunk)}`)
  })
}

let browser
let page
const browserProblems = []
try {
  await waitForHost(webUrl, host)
  stage(`launching browser at ${webUrl}`)
  browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH === undefined
      ? { channel: 'chrome' }
      : { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }),
    headless: true,
    args: process.platform === 'darwin' ? ['--use-angle=metal'] : [],
  })
  page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
  })
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') {
      const text = message.text()
      const source = message.location().url
      if (!/http:\/\/127\.0\.0\.1:777[78]\//u.test(source)
        && !/http:\/\/127\.0\.0\.1:777[78]\//u.test(text)) {
        browserProblems.push(`${message.type()}: ${text}`)
      }
    }
  })
  page.on('pageerror', error => browserProblems.push(`pageerror: ${error.message}`))

  await page.goto(webUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  const composer = await readyComposer(page)
  stage('submitting P6 open-editor replay prompt')
  await composer.fill('打开 M10 Volumetric Fluid Fire')
  await composer.press('Enter')
  const ownerSessionId = await waitForLatestTurn()
  let app = await appFrame(page)

  await page.locator('[data-mcp-app-header-action]')
    .getByTitle('Open mcp__threejs__open_editor fullscreen', { exact: true })
    .click()
  await page.locator('[data-mcp-app-view][data-display-mode="fullscreen"]').waitFor()
  app = await appFrame(page)
  stage('starting P6 through the DSH editor')
  await app.getByRole('button', { name: 'Play', exact: true }).click()
  await app.waitForFunction(() => {
    const value = globalThis.__THREE_M7__?.metrics()
    return value?.playState === 'playing'
      && value.m7?.metrics?.rendererBackend === 'WebGPUBackend'
      && value.m7.metrics.gpuResources === 1
      && value.m7.metrics.pressureIterations === 4
  }, undefined, { timeout: startupTimeout })
  const running = await app.evaluate(() => globalThis.__THREE_M7__.metrics())
  const runtimeRef = running.m7.lifecycle.committed.runtime.run.runtimeRef
  const evidence = await callRuntimeTool(webUrl, 'capture_runtime_frame', {
    projectId: running.projectId,
    runtimeRef,
    target: 'validation',
    deterministic: true,
    format: 'jpeg',
    maxWidth: 512,
    maxHeight: 512,
  }, ownerSessionId)
  assert.equal(evidence.structuredContent.runtime.projection.loadedBuild.buildId, running.m7.build.buildId)
  assert.equal(evidence.structuredContent.runtime.projection.workspaceRevision, running.revision)
  await page.screenshot({ path: screenshotPath, fullPage: false })

  await app.getByRole('button', { name: 'Stop', exact: true }).click()
  await app.waitForFunction(previousRunId => {
    const value = globalThis.__THREE_M7__?.metrics()
    return value?.playState === 'editing'
      && value.m7?.ready?.mode === 'edit'
      && value.m7.runId !== previousRunId
  }, running.m7.runId, { timeout: startupTimeout })
  const stopped = await app.evaluate(() => globalThis.__THREE_M7__.metrics())
  assert.notEqual(stopped.m7.runId, running.m7.runId)
  assert.equal(stopped.m7.build.buildId, running.m7.build.buildId)
  assert.deepEqual(browserProblems, [])

  const runtimeEvidence = evidence.structuredContent
  const result = {
    transport: 'deterministic Replay through DSH Agent Loop',
    url: webUrl,
    profile: {
      dshHome,
      bundle: realpathSync(resolve(
        profileDir,
        'node_modules/@creative-dswork/dsh-uni-editor',
      )),
      mcpServer: isolatedEnv.THREEJS_EDITOR_MCP_SERVER,
    },
    projectId: running.projectId,
    revision: running.revision,
    buildId: running.m7.build.buildId,
    runIds: [running.m7.runId, stopped.m7.runId],
    stopReplacement: {
      playState: stopped.playState,
      mode: stopped.m7.ready.mode,
      distinctRun: stopped.m7.runId !== running.m7.runId,
    },
    runtime: {
      rendererBackend: running.m7.metrics.rendererBackend,
      capability: running.m7.metrics.capabilities,
      gpuResources: running.m7.metrics.gpuResources,
      pressureIterations: running.m7.metrics.pressureIterations,
    },
    evidence: {
      kind: runtimeEvidence.kind,
      digest: runtimeEvidence.digest,
      deterministic: runtimeEvidence.deterministic,
      runtime: runtimeEvidence.runtime,
      width: runtimeEvidence.width,
      height: runtimeEvidence.height,
    },
    screenshot: screenshotPath,
    hostLog: hostLogPath,
    browserProblems,
  }
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`)
  stage('all DSH Runtime assertions passed')
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} finally {
  await browser?.close().catch(() => {})
  await stopProcess(host)
  hostLog.end()
  stage(`cleaned isolated processes; run root preserved at ${runRoot}`)
}
