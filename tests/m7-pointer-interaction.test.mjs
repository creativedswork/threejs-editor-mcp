import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  installOwnedAssetFetch,
  m7BootstrapHtml,
  shouldPickAfterPointerGesture,
} from '../src/m7-runtime.ts'

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
  const script = m7BootstrapHtml().match(/<script>([\s\S]*)<\/script>/)?.[1]
  assert.notEqual(script, undefined)
  assert.doesNotThrow(() => new Function(script))
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

  const script = m7BootstrapHtml().match(/<script>([\s\S]*)<\/script>/)?.[1]
  assert.notEqual(script, undefined)
  assert.ok(script.indexOf('restoreAssetFetch?.()') < script.indexOf('URL.revokeObjectURL(url)'))
  assert.match(script, /__THREEJS_EDITOR_REGISTER_INLINE_ASSET__/)
  assert.match(script, /assetBlobs\.set\(url, blob\)/)
  assert.ok(script.includes('delete globalThis.__THREEJS_EDITOR_REGISTER_INLINE_ASSET__'))
})


test('waits for a laid out canvas before publishing Runtime ready', () => {
  const script = m7BootstrapHtml().match(/<script>([\s\S]*)<\/script>/)?.[1]
  assert.notEqual(script, undefined)
  const layoutGuard = script.indexOf('canvas.clientWidth === 0 || canvas.clientHeight === 0')
  assert.ok(layoutGuard >= 0)
  assert.ok(layoutGuard < script.indexOf('current.frame += 1', layoutGuard))
  assert.ok(layoutGuard < script.indexOf("emit(runId, nonce, 'ready'", layoutGuard))
})

test('retries the first Runtime frame when its canvas becomes laid out', () => {
  const script = m7BootstrapHtml().match(/<script>([\s\S]*)<\/script>/)?.[1]
  assert.notEqual(script, undefined)
  const observer = script.indexOf('current.layoutObserver = new ResizeObserver')
  assert.ok(observer >= 0)
  assert.ok(script.indexOf('current.frame !== 0', observer) > observer)
  assert.ok(script.indexOf('cancelAnimationFrame(current.animation)', observer) > observer)
  assert.ok(script.indexOf('current.renderFrame(performance.now())', observer) > observer)
  assert.ok(script.includes('current.layoutObserver?.disconnect()'))
})

test('waits for canvas layout before creating the WebGL renderer', () => {
  const script = m7BootstrapHtml().match(/<script>([\s\S]*)<\/script>/)?.[1]
  assert.notEqual(script, undefined)
  const wait = script.indexOf('await new Promise(resolve => {')
  const renderer = script.indexOf('new THREE.WebGLRenderer(options)')
  assert.ok(wait >= 0)
  assert.ok(renderer > wait)
  assert.ok(script.includes('starting.cancelLayoutWait?.()'))
})

test('keeps the Runtime frame visible while replacing an active run', async () => {
  const source = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8')
  const stop = source.slice(
    source.indexOf('async function stopM7Runtime('),
    source.indexOf('async function startM7Runtime('),
  )
  const start = source.slice(
    source.indexOf('async function startM7Runtime('),
    source.indexOf('function startM7RuntimePort('),
  )
  assert.match(stop, /hideFrame = true/)
  assert.match(stop, /if \(hideFrame\) runtimeFrame\.hidden = true/)
  assert.match(start, /if \(m5ActiveRun !== undefined\) await stopIsolatedRuntime\(\)/)
  assert.match(start, /await stopM7Runtime\(false, false\)/)
})

test('projects readiness from the Runtime transition controller', async () => {
  const source = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /m7StartQueue|m7PendingStartController/)
  assert.match(source, /new RuntimeTransitionController<CommittedRuntime>/)
  assert.match(source, /function projectRuntimeUi\(/)
  assert.match(source, /runtimeEffects\.run\('model-context'/)
  assert.match(
    source,
    /lifecyclePending: runtimeTransitions\.snapshot\(\)\.operation !== undefined/,
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
    /runtimeTransitions\.enqueue\('adopt-snapshot', M7_TRANSITION_TIMEOUT/,
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
  assert.match(save, /projectRuntimeUi\(runtimeTransitions\.snapshot\(\)\)/)
})

test('preserves the last framebuffer until replacement navigation', async () => {
  const script = m7BootstrapHtml().match(/<script>([\s\S]*)<\/script>/)?.[1]
  assert.notEqual(script, undefined)
  const preserve = script.indexOf('!preserveSurface')
  assert.ok(preserve >= 0)
  assert.ok(script.indexOf('current.renderer.forceContextLoss', preserve) > preserve)
  assert.match(
    script,
    /dispose\(runId, nonce, true, request\.preserveSurface === true\)/,
  )
  const source = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8')
  assert.match(source, /postM7Run\(run, 'stop', \{ preserveSurface \}\)/)
  assert.match(source, /disposeM7Runtime\(run, !hideFrame\)/)
})

test('keeps example cleanup failures non-fatal to Runtime teardown', () => {
  const script = m7BootstrapHtml().match(/<script>([\s\S]*)<\/script>/)?.[1]
  assert.notEqual(script, undefined)
  const exampleDispose = script.indexOf('await current.example?.dispose?.()')
  const frameworkCleanup = script.indexOf('cleanup(() => current.renderer.dispose())', exampleDispose)
  assert.ok(exampleDispose >= 0)
  assert.ok(frameworkCleanup > exampleDispose)
  assert.ok(script.slice(exampleDispose, frameworkCleanup).includes('exampleDisposeError = message(error)'))
  assert.doesNotMatch(script.slice(exampleDispose, frameworkCleanup), /failures.push/)
  assert.ok(script.includes('exampleDisposeError === undefined ? {} : { exampleDisposeError }'))
})

test('keeps an async Runtime setup owned until disposal completes', () => {
  const script = m7BootstrapHtml().match(/<script>([\s\S]*)<\/script>/)?.[1]
  assert.notEqual(script, undefined)
  assert.ok(script.indexOf('active = current') < script.indexOf('current.setupPromise ='))
  assert.equal(script.match(/await current\.setupPromise/g)?.length, 2)
  assert.match(script, /if \(current\.stopped \|\| active !== current\) return/)
})

test('binds Runtime commands to exact identity and cancels input before stopping', () => {
  const script = m7BootstrapHtml().match(/<script>([\s\S]*)<\/script>/)?.[1]
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
