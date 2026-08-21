import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldPickAfterPointerGesture } from '../src/m7-runtime.ts'

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
