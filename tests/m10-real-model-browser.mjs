import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { createServer } from 'node:net'
import { basename, resolve } from 'node:path'
import { chromium } from 'playwright'

const projectRoot = resolve(process.env.THREEJS_EDITOR_MCP_ROOT ?? '.')
const corpusRoot = resolve(process.env.THREEJS_EDITOR_MCP_WORKSPACE ?? '')
if (corpusRoot === projectRoot) throw new Error('THREEJS_EDITOR_MCP_WORKSPACE is required')
const selectedCase = process.env.M10_REAL_CASE
assert.ok(['p6', 'g1'].includes(selectedCase), 'M10_REAL_CASE must be p6 or g1')
const repairMode = selectedCase === 'g1' && process.env.M10_REAL_REPAIR === '1'
const runRoot = resolve(process.env.M10_REAL_RUN_ROOT ?? `.tmp/m10-real-${selectedCase}`)
assert.equal(existsSync(runRoot), false, `run root already exists: ${runRoot}`)

const harnessRoot = resolve(process.env.DSH_HARNESS_ROOT ?? `${projectRoot}/../deepseek-harness`)
const normalDshHome = resolve(process.env.M10_NORMAL_DSH_HOME ?? `${homedir()}/.dsh`)
const dshEntrypoint = resolve(
  process.env.DSH_ENTRYPOINT ?? `${harnessRoot}/apps/cli/lib/bin.js`,
)
const dshHome = resolve(runRoot, 'home')
const workspacePath = resolve(runRoot, 'workspace')
const projectsPath = resolve(runRoot, 'projects')
const hostLogPath = resolve(runRoot, 'host.log')
const resultPath = resolve(runRoot, 'M10-real-model-result.json')
const artifactRoot = resolve(
  process.env.M10_REAL_ARTIFACT_ROOT ?? `.playwright-mcp/${basename(runRoot)}`,
)
const startupTimeout = Number(process.env.M10_REAL_TIMEOUT ?? 600_000)
const appTimeout = Number(process.env.M10_REAL_APP_TIMEOUT ?? 60_000)
const startedAt = Date.now()

mkdirSync(resolve(dshHome, 'profiles'), { recursive: true })
mkdirSync(projectsPath, { recursive: true })
mkdirSync(artifactRoot, { recursive: true })
cpSync(
  resolve(normalDshHome, 'profiles/web'),
  resolve(dshHome, 'profiles/web'),
  { recursive: true },
)
copyFileSync(resolve(normalDshHome, 'settings.yaml'), resolve(dshHome, 'settings.yaml'))
symlinkSync(resolve(normalDshHome, '.credentials.yaml'), resolve(dshHome, '.credentials.yaml'))

if (selectedCase === 'p6') {
  execFileSync(process.execPath, [
    resolve(projectRoot, 'scripts/prepare-m10-p6.mjs'),
    corpusRoot,
    workspacePath,
  ], { cwd: projectRoot, stdio: 'inherit' })
} else {
  execFileSync(process.execPath, [
    resolve(projectRoot, 'scripts/prepare-m10-g1.mjs'),
    workspacePath,
  ], { cwd: projectRoot, stdio: 'inherit' })
  if (repairMode) {
    const sourcePath = resolve(workspacePath, 'src/main.js')
    const source = readFileSync(sourcePath, 'utf8')
    const defective = source.replace(
      'paused = state.paused || state.timeScale === 0;',
      'paused = state.paused || state.timeScale === ;',
    )
    assert.notEqual(defective, source)
    writeFileSync(sourcePath, defective)
  }
}

const isolatedEnv = {
  ...process.env,
  DSH_HOME: dshHome,
  DSH_AGENTS_HOME: resolve(runRoot, 'agents-home'),
  DSH_TELEMETRY_DISABLED: '1',
  PNPM_HOME: resolve(runRoot, 'pnpm-home'),
  XDG_CACHE_HOME: resolve(runRoot, 'cache'),
  THREEJS_EDITOR_MCP_SERVER: resolve(
    process.env.THREEJS_EDITOR_MCP_SERVER ?? resolve(projectRoot, 'dist/server.js'),
  ),
  THREEJS_EDITOR_MCP_ROOT: projectRoot,
  THREEJS_EDITOR_MCP_PROJECTS: projectsPath,
  THREEJS_EDITOR_MCP_WORKSPACE: workspacePath,
}
for (const path of [
  isolatedEnv.DSH_AGENTS_HOME,
  isolatedEnv.PNPM_HOME,
  isolatedEnv.XDG_CACHE_HOME,
]) {
  mkdirSync(path, { recursive: true })
}
const serverPatch = resolve(projectRoot, 'tests/fixtures/m9/cordis.patch.yml')

function stage(message) {
  process.stderr.write(`[m10-real-${selectedCase} +${String(Date.now() - startedAt)}ms] ${message}\n`)
}

function dsh(args) {
  return execFileSync('pnpm', ['dsh', ...args], {
    cwd: harnessRoot,
    env: isolatedEnv,
    encoding: 'utf8',
    timeout: startupTimeout,
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
    assert.equal(host.exitCode ?? host.signalCode, null, `DSH exited; see ${hostLogPath}`)
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
  const picker = page.getByRole('dialog', { name: '选择工作区目录' })
  if (!await picker.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: '添加工作区', exact: true }).click()
  }
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
  const notice = page.getByRole('dialog', { name: '内测声明', exact: true })
  await notice.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
  if (await notice.isVisible().catch(() => false)) {
    await notice.getByRole('button', { name: '继续', exact: true }).click()
    await notice.waitFor({ state: 'hidden' })
  }
  if (await composer.isVisible().catch(() => false)) return composer
  if (hasWorkspace()) {
    const workspaceName = basename(workspacePath)
    await page.getByRole('treeitem').filter({ hasText: workspaceName }).first()
      .hover({ timeout: 30_000 })
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

async function waitForLatestTurn(minimumTurn = 1) {
  const deadline = Date.now() + startupTimeout
  while (Date.now() < deadline) {
    const workspaceStorePath = resolve(dshHome, 'storages/workspace.json')
    const sessionStorePath = resolve(dshHome, 'storages/session_projcache.json')
    if (existsSync(workspaceStorePath) && existsSync(sessionStorePath)) {
      const workspaceStore = JSON.parse(readFileSync(workspaceStorePath, 'utf8'))
      const workspace = Object.values(workspaceStore.tables?.workspaces ?? {})
        .find(item => resolve(item.path) === workspacePath)
      const sessionId = workspace?.sessionIds?.[0]
      if (sessionId !== undefined) {
        const sessionStore = JSON.parse(readFileSync(sessionStorePath, 'utf8'))
        const stats = sessionStore.tables?.sessions?.[sessionId]?.rows?.sessionStats?.val
        if (stats?.lastTurn >= minimumTurn && stats.openStep === null) return sessionId
      }
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 200))
  }
  throw new Error(`Model turn did not settle within ${startupTimeout} ms`)
}

async function appFrame(page, backend, projectId) {
  const deadline = Date.now() + appTimeout
  while (Date.now() < deadline) {
    const frames = page.locator('iframe[title="MCP App: mcp__threejs__open_editor"]')
    for (let index = await frames.count() - 1; index >= 0; index -= 1) {
      const shell = await (await frames.nth(index).elementHandle())?.contentFrame()
      const inner = shell?.locator('iframe')
      if (inner === undefined || await inner.count() === 0) continue
      const app = await (await inner.elementHandle())?.contentFrame()
      if (app === undefined || app === null) continue
      const metrics = await app.evaluate(() => globalThis.__THREE_M7__?.metrics())
        .catch(() => undefined)
      if (metrics?.projectId === projectId
        && metrics.playState === 'editing'
        && metrics.sync === 'clean'
        && metrics.workspaceBackend === backend
        && metrics.m7?.ready?.mode === 'edit') {
        return app
      }
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250))
  }
  throw new Error(`${projectId} App did not become ready within ${appTimeout} ms`)
}

async function runtimeSurface(app) {
  const runtime = app.locator('iframe[data-runtime-sandbox]')
  await runtime.waitFor({ state: 'visible', timeout: startupTimeout })
  const frame = await (await runtime.elementHandle()).contentFrame()
  assert.notEqual(frame, null)
  return { runtime, frame }
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

function modelSessionEvidence() {
  const files = readdirSync(resolve(dshHome, 'sessions'), {
    recursive: true,
    withFileTypes: true,
  })
  const transcript = files.find(entry => entry.isFile() && entry.name.endsWith('.jsonl.zstd'))
  assert.notEqual(transcript, undefined)
  const text = execFileSync('zstdcat', [resolve(transcript.parentPath, transcript.name)], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  const events = text.trim().split('\n').map(line => JSON.parse(line))
  return {
    calls: events
      .filter(event => event.type === 'tool/call')
      .map(event => event.data.name),
  }
}

function readyBuild() {
  const revision = readFileSync(resolve(workspacePath, '.threejs-editor/HEAD'), 'utf8').trim()
  const buildsRoot = resolve(workspacePath, '.threejs-editor/builds')
  const builds = readdirSync(buildsRoot)
    .map(buildId => JSON.parse(readFileSync(resolve(buildsRoot, buildId, 'build.json'), 'utf8')))
    .filter(build => build.status === 'ready' && build.revision === revision)
  assert.ok(builds.length > 0, `no ready build for revision ${revision}`)
  return builds.at(-1)
}

stage('composing normal real-provider web profile')
const dump = dsh(['--profile', 'web', '--patch', serverPatch, '--dump-config'])
assert.match(dump, /serverName: threejs/)
assert.match(dump, /forwardWorkspace: true/)
assert.doesNotMatch(dump, /llm-replay/)

const port = await freePort()
const webUrl = `http://127.0.0.1:${String(port)}`
const hostLog = createWriteStream(hostLogPath)
const host = spawn(process.execPath, [
  dshEntrypoint,
  '--profile', 'web',
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
    process.stderr.write(`[m10-real-host] ${String(chunk)}`)
  })
}

let browser
const browserProblems = []
try {
  await waitForHost(webUrl, host)
  stage(`launching real-model DSH at ${webUrl}`)
  browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH === undefined
      ? { channel: 'chrome' }
      : { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }),
    headless: true,
    args: process.platform === 'darwin' ? ['--use-angle=metal'] : [],
  })
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
  })
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') {
      browserProblems.push(`${message.type()}: ${message.text()}`)
    }
  })
  page.on('pageerror', error => browserProblems.push(`pageerror: ${error.message}`))
  page.on('requestfailed', request => {
    browserProblems.push(
      `requestfailed: ${request.url()} (${request.failure()?.errorText ?? 'unknown error'})`,
    )
  })

  const workspaceResponse = await fetch(`${webUrl}/api/workspace.create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `m10-real-${selectedCase}-workspace`,
      method: 'workspace.create',
      payload: { path: workspacePath },
    }),
  })
  const workspaceBody = await workspaceResponse.json()
  assert.equal(workspaceResponse.status, 200, JSON.stringify(workspaceBody))
  assert.equal(workspaceBody.result?.ok, true, JSON.stringify(workspaceBody))

  await page.goto(webUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  const composer = await readyComposer(page)
  const prompt = selectedCase === 'g1'
    ? repairMode
      ? [
          'Call mcp__threejs__open_editor with exactly {} for the current workspace.',
          'It contains one deliberately injected gameplay pause syntax defect.',
          'Use build_project and its exact diagnostics, read the relevant source, repair',
          'only that defect with apply_project_files, then run build_project again until',
          'status is ready. Report the failed and successful build evidence concisely.',
          'Do not use shell commands or inspect test harness files.',
        ].join(' ')
      : [
          'Call mcp__threejs__open_editor with exactly {} for the current G1 workspace,',
          'then call build_project once for its current revision. Do not modify files,',
          'use shell commands, inspect test harness files, or perform extra investigation.',
          'Report the ready build ID concisely.',
        ].join(' ')
    : [
        'Call mcp__threejs__open_editor with exactly {} for the current P6 Volumetric',
        'Fluid Fire workspace, then call build_project once for its current revision.',
        'Do not modify files, use shell commands, inspect test harness files, or perform',
        'extra investigation. Report the ready build ID concisely.',
      ].join(' ')
  stage('submitting real model task')
  await composer.fill(prompt)
  await composer.press('Enter')
  const ownerSessionId = await waitForLatestTurn()
  const build = readyBuild()
  const sessionEvidence = modelSessionEvidence()
  assert.ok(sessionEvidence.calls.includes('mcp__threejs__open_editor'))
  assert.ok(sessionEvidence.calls.includes('mcp__threejs__build_project'))
  const modelEvidence = {
    calls: sessionEvidence.calls,
    openEditor: true,
    buildProject: true,
    applyProjectFiles: sessionEvidence.calls.includes('mcp__threejs__apply_project_files'),
    buildDiagnostic: repairMode && readdirSync(resolve(
      workspacePath,
      '.threejs-editor/builds',
    )).some(buildId => {
      const candidate = JSON.parse(readFileSync(resolve(
        workspacePath,
        '.threejs-editor/builds',
        buildId,
        'build.json',
      ), 'utf8'))
      return candidate.status === 'failed' && candidate.diagnostics?.length > 0
    }),
  }
  assert.equal(modelEvidence.applyProjectFiles, repairMode)
  assert.equal(modelEvidence.buildDiagnostic, repairMode)
  if (repairMode) {
    const repairedSource = readFileSync(resolve(workspacePath, 'src/main.js'), 'utf8')
    assert.match(repairedSource, /paused = state\.paused \|\| state\.timeScale === 0;/)
    assert.doesNotMatch(repairedSource, /state\.timeScale === ;/)
  }

  const locateEditor = page.getByRole('button', { name: 'Locate Editor', exact: true }).last()
  if (await locateEditor.isVisible().catch(() => false)) {
    await locateEditor.click()
  }
  const app = await appFrame(page, build.backend, build.projectId)
  const editing = await app.evaluate(() => globalThis.__THREE_M7__.metrics())
  assert.equal(editing.projectId, build.projectId)
  assert.equal(editing.revision, build.revision)

  await page.locator('[data-mcp-app-header-action]')
    .getByTitle('Open mcp__threejs__open_editor fullscreen', { exact: true })
    .click()
  await page.locator('[data-mcp-app-view][data-display-mode="fullscreen"]').waitFor()
  const fullscreenApp = await appFrame(page, build.backend, build.projectId)
  await fullscreenApp.getByRole('button', { name: 'Play', exact: true }).click()
  await fullscreenApp.waitForFunction(caseName => {
    const value = globalThis.__THREE_M7__?.metrics()
    if (value?.playState !== 'playing') return false
    if (caseName === 'p6') {
      return value.m7?.metrics?.frame >= 60
        && value.m7.metrics.rendererBackend === 'WebGPUBackend'
        && value.m7.metrics.gpuResources === 1
        && value.m7.metrics.pressureIterations === 4
    }
    return value.m7?.metrics?.gltfSkin === true
      && value.m7.metrics.animationClips === 1
      && value.m7.metrics.morphTargets === 1
  }, selectedCase, { timeout: startupTimeout })
  const running = await fullscreenApp.evaluate(() => globalThis.__THREE_M7__.metrics())
  const { runtime, frame } = await runtimeSurface(fullscreenApp)

  if (selectedCase === 'p6') {
    await runtime.screenshot({ path: resolve(artifactRoot, '00-final.png') })
    const debug = fullscreenApp.getByRole('combobox', { name: '画面检查' })
    await debug.selectOption('temperature')
    await fullscreenApp.waitForFunction(() => (
      globalThis.__THREE_M7__?.metrics().m7?.metrics?.debugMode === 'temperature'
    ))
    await runtime.screenshot({ path: resolve(artifactRoot, '01-temperature.png') })
    await debug.selectOption('colliders')
    await fullscreenApp.waitForFunction(() => (
      globalThis.__THREE_M7__?.metrics().m7?.metrics?.debugMode === 'colliders'
    ))
    await runtime.screenshot({ path: resolve(artifactRoot, '02-colliders.png') })
  } else {
    await runtime.screenshot({ path: resolve(artifactRoot, '00-running.png') })
    await frame.locator('canvas').click({ position: { x: 640, y: 400 } })
    await page.keyboard.down('KeyW')
    await fullscreenApp.waitForFunction(() => {
      const metrics = globalThis.__THREE_M7__?.metrics().m7?.metrics
      return metrics?.playerPosition?.[2] < -0.2
        && metrics.audioUnlocked === true
        && metrics.audioState === 'running'
    })
    await page.keyboard.up('KeyW')
    await runtime.screenshot({ path: resolve(artifactRoot, '01-moved-audio.png') })
    await fullscreenApp.getByRole('combobox', { name: '画面检查' })
      .selectOption('skeleton')
    await fullscreenApp.waitForFunction(() => (
      globalThis.__THREE_M7__?.metrics().m7?.metrics?.debugMode === 'skeleton'
    ))
    await runtime.screenshot({ path: resolve(artifactRoot, '02-skeleton.png') })
  }

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
  assert.equal(evidence.structuredContent.runtime.projection.workspaceRevision, running.revision)
  assert.equal(evidence.structuredContent.runtime.projection.loadedBuild.buildId, running.m7.build.buildId)
  assert.deepEqual(browserProblems, [])

  const result = {
    transport: 'real model through DSH Agent Loop',
    provider: 'normal configured provider',
    case: selectedCase,
    projectId: running.projectId,
    revision: running.revision,
    buildId: running.m7.build.buildId,
    runId: running.m7.runId,
    modelEvidence,
    runtime: selectedCase === 'p6'
      ? {
          rendererBackend: running.m7.metrics.rendererBackend,
          gpuResources: running.m7.metrics.gpuResources,
          pressureIterations: running.m7.metrics.pressureIterations,
        }
      : {
          gltfSkin: running.m7.metrics.gltfSkin,
          animationClips: running.m7.metrics.animationClips,
          morphTargets: running.m7.metrics.morphTargets,
        },
    evidence: {
      digest: evidence.structuredContent.digest,
      runtime: evidence.structuredContent.runtime,
    },
    artifactRoot,
    hostLog: hostLogPath,
    browserProblems,
  }
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`)
  stage('all real-model assertions passed')
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} finally {
  await browser?.close().catch(() => {})
  await stopProcess(host)
  hostLog.end()
  stage(`cleaned isolated processes; run root preserved at ${runRoot}`)
}
