import assert from 'node:assert/strict'
import test from 'node:test'
import {
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
