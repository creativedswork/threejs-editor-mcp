import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  installOwnedAssetFetch,
  installOwnedAssetImageSource,
  workspaceRuntimeHtml,
  shouldPickAfterPointerGesture,
} from '../src/workspace-runtime.ts'

const click = {
  pointerId: 1,
  x: 100,
  y: 80,
  moved: false,
  blocked: false,
}

test('selects only an unchanged primary click gesture', () => {
  assert.equal(shouldPickAfterPointerGesture(click, 1, 102, 82, false), true)
  assert.equal(shouldPickAfterPointerGesture(click, 2, 102, 82, false), false)
  assert.equal(shouldPickAfterPointerGesture(click, 1, 110, 80, false), false)
})

test('does not select through gizmo or camera gestures', () => {
  assert.equal(shouldPickAfterPointerGesture({
    ...click,
    blocked: true,
  }, 1, 100, 80, false), false)
  assert.equal(shouldPickAfterPointerGesture({
    ...click,
    moved: true,
  }, 1, 100, 80, false), false)
  assert.equal(shouldPickAfterPointerGesture(click, 1, 100, 80, true), false)
})

test('emits a syntactically valid Runtime bootstrap script', () => {
  const html = workspaceRuntimeHtml()
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1]
  assert.notEqual(script, undefined)
  assert.doesNotThrow(() => new Function(script))
  assert.match(html, /<canvas tabindex="0"/)
  assert.match(script, /'keydown',\s*'keyup',/)
})

test('degrades incompatible persisted editor operations without aborting startup', async () => {
  const script = workspaceRuntimeHtml().match(/<script>([\s\S]*)<\/script>/)?.[1]
  assert.notEqual(script, undefined)
  const replay = script.slice(
    script.indexOf('const replayOperations ='),
    script.indexOf('current.transform ='),
  )
  assert.match(replay, /try \{\s*applyOperation\(current, operation, false\)/)
  assert.match(replay, /restorationWarnings\.push\(warning\)/)
  assert.match(replay, /appendLog\('warn', \[warning\]\)/)
  assert.match(script, /editState: current\.editState,\s*restorationWarnings,/)
  const view = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8')
  assert.match(
    view,
    /for \(const warning of restorationWarnings\) recordRuntimeWarning\(\[warning\]\)/,
  )
  assert.match(view, /' · Restore warnings'/)
})

test('validation frame pumping yields without throttled timers', () => {
  const script = workspaceRuntimeHtml().match(/<script>([\s\S]*)<\/script>/)?.[1]
  assert.notEqual(script, undefined)
  const waitFrames = script.slice(
    script.indexOf('const waitFrames = async'),
    script.indexOf('const pointerOptions ='),
  )
  assert.match(waitFrames, /await yieldTask\(\)/)
  assert.doesNotMatch(waitFrames, /setTimeout\(resolve, 0\)/)
  assert.match(
    waitFrames,
    /await current\.framePromise\s+if \(current\.stopped \|\| active !== current\)/,
  )
  assert.match(script, /const channel = new MessageChannel\(\)/)
})

test('fetches only owned Runtime asset URLs and restores fetch on teardown', async () => {
  const calls = []
  const originalFetch = async input => {
    calls.push(input)
    return new Response('passthrough')
  }
  const target = { fetch: originalFetch }
  const ownedAssets = new Map([
    ['blob:owned', new Blob(['owned'], { type: 'text/plain' })],
  ])
  const restore = installOwnedAssetFetch(target, ownedAssets)

  assert.equal(await (await target.fetch('blob:owned')).text(), 'owned')
  assert.equal(await (await target.fetch('blob:unknown')).text(), 'passthrough')
  assert.equal(await (await target.fetch('data:text/plain,unknown')).text(), 'passthrough')
  assert.deepEqual(calls, ['blob:unknown', 'data:text/plain,unknown'])

  restore()
  assert.equal(target.fetch, originalFetch)
  assert.equal(ownedAssets.size, 0)

  const script = workspaceRuntimeHtml().match(/<script>([\s\S]*)<\/script>/)?.[1]
  assert.notEqual(script, undefined)
  assert.ok(script.indexOf('restoreAssetFetch?.()') < script.indexOf('URL.revokeObjectURL(url)'))
  assert.match(script, /__THREEJS_EDITOR_REGISTER_INLINE_ASSET__/)
  assert.match(script, /assetBlobs\.set\(url, blob\)/)
  assert.ok(script.includes('delete globalThis.__THREEJS_EDITOR_REGISTER_INLINE_ASSET__'))
})

test('resolves native image source aliases and restores the original setter', () => {
  class RuntimeImage {}
  Object.defineProperty(RuntimeImage.prototype, 'src', {
    configurable: true,
    get() {
      return this.source
    },
    set(value) {
      this.source = value
    },
  })
  const original = Object.getOwnPropertyDescriptor(RuntimeImage.prototype, 'src')
  const restore = installOwnedAssetImageSource(
    { HTMLImageElement: RuntimeImage },
    value => value === '~owned' ? 'blob:owned' : value,
  )
  const image = new RuntimeImage()
  image.src = '~owned'
  assert.equal(image.src, 'blob:owned')

  restore()
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(RuntimeImage.prototype, 'src'),
    original,
  )
})


test('waits for a laid out canvas before publishing Runtime ready', () => {
  const script = workspaceRuntimeHtml().match(/<script>([\s\S]*)<\/script>/)?.[1]
  assert.notEqual(script, undefined)
  const layoutGuard = script.indexOf('canvas.clientWidth === 0 || canvas.clientHeight === 0')
  assert.ok(layoutGuard >= 0)
  assert.ok(layoutGuard < script.indexOf('current.frame += 1', layoutGuard))
  assert.ok(layoutGuard < script.indexOf("emit(runId, nonce, 'ready'", layoutGuard))
})

test('retries the first Runtime frame when its canvas becomes laid out', () => {
  const script = workspaceRuntimeHtml().match(/<script>([\s\S]*)<\/script>/)?.[1]
  assert.notEqual(script, undefined)
  const observer = script.indexOf('current.layoutObserver = new ResizeObserver')
  assert.ok(observer >= 0)
  assert.ok(script.indexOf('current.frame !== 0', observer) > observer)
  assert.ok(script.indexOf('cancelAnimationFrame(current.animation)', observer) > observer)
  assert.ok(script.indexOf('current.renderFrame(performance.now())', observer) > observer)
  assert.ok(script.includes('current.layoutObserver?.disconnect()'))
})

test('waits for canvas layout before creating the WebGL renderer', () => {
  const script = workspaceRuntimeHtml().match(/<script>([\s\S]*)<\/script>/)?.[1]
  assert.notEqual(script, undefined)
  const wait = script.indexOf('await new Promise(resolve => {')
  const renderer = script.indexOf('new THREE.WebGLRenderer(options)')
  assert.ok(wait >= 0)
  assert.ok(renderer > wait)
  assert.ok(script.includes('starting.cancelLayoutWait?.()'))
})

test('promotes a hidden candidate before disposing the active Runtime', async () => {
  const source = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8')
  const start = source.slice(
    source.indexOf('async function startM7Runtime('),
    source.indexOf('function startM7RuntimePort('),
  )
  const candidate = start.indexOf('createM7CandidateFrame()')
  const ready = start.indexOf('await Promise.all([ready, editorScene])')
  const commit = start.indexOf("name: 'commit_runtime_run'")
  const promote = start.indexOf('promoteM7CandidateFrame(candidateFrame)')
  const dispose = start.indexOf('await disposeM7Runtime(previousRun, previousFrame)')
  assert.ok(candidate >= 0)
  assert.ok(ready > candidate)
  assert.ok(commit > ready)
  assert.ok(promote > commit)
  assert.ok(dispose > promote)
  assert.doesNotMatch(start, /stopM7Runtime\(false, false\)/)
})

test('binds Runtime harness targets and settles failures by stage', async () => {
  const source = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8')
  const execute = source.slice(
    source.indexOf('async function executeRuntimeHarnessCommand('),
    source.indexOf('async function pullRuntimeHarnessCommand('),
  )
  assert.match(execute, /targetRuntime: targetIdentity/)
  assert.match(execute, /evidenceToken: command\.evidenceToken/)
  assert.match(execute, /stage: 'prepare',\s*code: 'TARGET_PREPARATION_FAILED'/)
  assert.match(execute, /stage: 'execute',\s*code: 'TARGET_EXECUTION_FAILED'/)
  assert.match(execute, /stage: 'settle',\s*code: 'EVIDENCE_REJECTED'/)
})

test('reuses one validated Runtime artifact for an unchanged revision', async () => {
  const source = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8')
  const bundleFor = source.slice(
    source.indexOf('async function runtimeBundleFor('),
    source.indexOf('async function stopValidationRuntime('),
  )
  const start = source.slice(
    source.indexOf('async function startM7Runtime('),
    source.indexOf('function startM7RuntimePort('),
  )
  const cacheHit = bundleFor.indexOf('const artifact = activeRuntime()?.artifact')
  const build = bundleFor.indexOf("name: 'build_project'")
  assert.ok(cacheHit >= 0)
  assert.ok(build > cacheHit)
  assert.match(bundleFor, /artifact\?\.projectId === run\.projectId/)
  assert.match(bundleFor, /artifact\.revision === run\.revision/)
  assert.match(bundleFor, /buildId: build\.buildId/)
  assert.match(bundleFor, /validated: false/)
  assert.match(start, /artifact = await runtimeBundleFor\(run, signal\)/)
  assert.doesNotMatch(start, /name: 'build_project'/)
  assert.doesNotMatch(start, /runtimeAssets\(/)
  assert.match(start, /const validatesArtifact = !artifact\.validated/)
  assert.match(start, /artifact = \{ \.\.\.artifact, validated: true \}/)
  assert.match(source, /buildRequests: m7BuildRequests/)
  assert.match(source, /assetFetches: m7AssetFetches/)
  assert.match(source, /validationStarts: m7ValidationStarts/)
})

test('keeps retained and restored Runtime state on the current lifecycle epoch', async () => {
  const view = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8')
  const runtime = workspaceRuntimeHtml()
  assert.match(view, /publishingRuntimeIdentity === undefined/)
  assert.match(view, /queueMicrotask\(\(\) => projectRuntimeUi/)
  assert.match(view, /modelContextRetryCount < 3/)
  assert.match(view, /postM7Run\(run, 'sync-epoch'\)/)
  assert.match(runtime, /action === 'sync-epoch'/)
  assert.match(runtime, /'epoch-synced'/)
  assert.match(runtime, /timeScale: Number\.isFinite\(request\.timeScale\)/)
  assert.match(runtime, /operationObject\(current, operation\)[\s\S]*?applyOperation\(current, operation, false\)/)
  assert.match(view, /postM7Run\(run, 'apply-draft-operations'/)
  assert.match(view, /projectId === targetProjectId[\s\S]*?revision === targetRevision/)
  assert.match(view, /void runSave\(async context =>/)
  assert.match(view, /runtimeCoordinator\.setValidation\(current\.committed, undefined\)/)
  assert.match(view, /status\.textContent = error instanceof Error[\s\S]*?finally\(\(\) => \{\s*saveCopy\.disabled = false/)
})

test('serializes project loads without dropping later results', async () => {
  const source = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8')
  const loadProject = source.slice(
    source.indexOf('async function loadProject('),
    source.indexOf('app.ontoolresult ='),
  )
  assert.match(loadProject, /const previousLoad = loadQueue/)
  assert.match(loadProject, /await previousLoad/)
  assert.match(loadProject, /releaseLoad\(\)/)
  assert.doesNotMatch(loadProject, /loadingId !== undefined/)
})

test('projects readiness from the Runtime transition controller', async () => {
  const source = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /m7StartQueue|m7PendingStartController/)
  assert.match(source, /new RuntimeCoordinator</)
  assert.match(source, /function projectRuntimeUi\(/)
  assert.match(source, /runtimeEffects\.run\('model-context'/)
  assert.match(
    source,
    /lifecyclePending: runtimeCoordinator\.snapshot\(\)\.operation !== undefined/,
  )
})

test('keeps external snapshot adoption on the lifecycle deadline', async () => {
  const source = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8')
  const pullLatest = source.slice(
    source.indexOf('async function pullLatest('),
    source.indexOf('async function loadProject('),
  )
  assert.match(
    pullLatest,
    /runtimeCoordinator\.enqueue\('adopt-snapshot', M7_TRANSITION_TIMEOUT/,
  )
})

test('releases every Save path through one finally block', async () => {
  const source = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8')
  const save = source.slice(
    source.indexOf('async function runSave('),
    source.indexOf('async function saveProjectPort('),
  )
  assert.match(save, /finally \{/)
  assert.match(save, /root\.dataset\.sync === 'saving'/)
  assert.match(save, /projectRuntimeUi\(runtimeCoordinator\.snapshot\(\)\)/)
})

test('does not rely on preserveSurface during Runtime replacement', async () => {
  const script = workspaceRuntimeHtml().match(/<script>([\s\S]*)<\/script>/)?.[1]
  assert.notEqual(script, undefined)
  assert.match(script, /!preserveSurface/)
  assert.match(
    script,
    /dispose\(runId, nonce, true, request\.preserveSurface === true\)/,
  )
  const source = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /postM7Run\(run, 'stop', \{ preserveSurface \}\)/)
})

test('keeps example cleanup failures non-fatal to Runtime teardown', () => {
  const script = workspaceRuntimeHtml().match(/<script>([\s\S]*)<\/script>/)?.[1]
  assert.notEqual(script, undefined)
  const exampleDispose = script.indexOf('await current.example?.dispose?.()')
  const cleanupFinally = script.indexOf('} finally {', exampleDispose)
  const frameworkCleanup = script.indexOf('cleanup(() => current.renderer?.dispose())', exampleDispose)
  assert.ok(exampleDispose >= 0)
  assert.ok(cleanupFinally > exampleDispose)
  assert.ok(frameworkCleanup > cleanupFinally)
  assert.ok(script.slice(exampleDispose, cleanupFinally).includes('exampleDisposeError = message(error)'))
  assert.doesNotMatch(script.slice(exampleDispose, cleanupFinally), /failures.push/)
  assert.ok(script.includes('exampleDisposeError === undefined ? {} : { exampleDisposeError }'))
})

test('keeps an async Runtime setup owned until disposal completes', () => {
  const script = workspaceRuntimeHtml().match(/<script>([\s\S]*)<\/script>/)?.[1]
  assert.notEqual(script, undefined)
  assert.ok(script.indexOf('active = current') < script.indexOf('current.setupPromise ='))
  assert.equal(script.match(/await current\.setupPromise/g)?.length, 2)
  assert.match(script, /if \(current\.stopped \|\| active !== current\) return/)
})

test('binds Runtime commands to exact identity and cancels input before stopping', () => {
  const script = workspaceRuntimeHtml().match(/<script>([\s\S]*)<\/script>/)?.[1]
  assert.notEqual(script, undefined)
  assert.match(script, /requestEpoch < eventEpoch/)
  assert.match(script, /epoch: eventEpoch/)
  assert.match(script, /active\.projectId !== request\.projectId/)
  assert.match(script, /active\.revision !== request\.revision/)
  assert.match(script, /request\.previousRevision !== current\.revision/)
  assert.match(script, /active\.revisionTransition !== undefined/)
  const dispose = script.indexOf('const disposeCurrent')
  assert.ok(dispose >= 0)
  assert.ok(
    script.indexOf('cancelRuntimeInput(current)', dispose)
      < script.indexOf('current.stopped = true', dispose),
  )
})
