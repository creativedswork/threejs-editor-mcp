import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RuntimeTransitionController,
  RuntimeTransitionError,
} from '../src/runtime-lifecycle.ts'

const runtime = {
  projectId: 'project',
  revision: 'revision-1',
  runId: 'run-1',
  nonce: 'nonce-1',
}

async function bootstrap(controller) {
  return controller.enqueue('bootstrap', 1_000, async () => ({
    phase: 'edit-ready',
    committed: runtime,
    value: undefined,
  }))
}

test('serializes Runtime commands and resolves idle at a stable snapshot', async () => {
  const controller = new RuntimeTransitionController()
  await bootstrap(controller)
  let releasePlay
  const enteredPlay = new Promise(resolve => {
    releasePlay = resolve
  })
  const order = []
  const play = controller.enqueue('play', 1_000, async () => {
    order.push('play:start')
    await enteredPlay
    order.push('play:end')
    return { phase: 'playing', value: undefined }
  })
  const stop = controller.enqueue('stop', 1_000, async () => {
    order.push('stop')
    return { phase: 'edit-ready', value: undefined }
  })

  await Promise.resolve()
  assert.deepEqual(order, ['play:start'])
  assert.equal(controller.snapshot().phase, 'entering-play')
  releasePlay()
  await Promise.all([play, stop])

  assert.deepEqual(order, ['play:start', 'play:end', 'stop'])
  assert.deepEqual(await controller.idle(), {
    phase: 'edit-ready',
    epoch: 3,
    committed: runtime,
  })
})

test('rejects stale epochs without replacing the committed Runtime', async () => {
  const controller = new RuntimeTransitionController()
  await bootstrap(controller)
  let observedEpoch
  let release
  const blocked = new Promise(resolve => {
    release = resolve
  })
  const play = controller.enqueue('play', 1_000, async context => {
    observedEpoch = context.epoch
    await blocked
    assert.equal(context.isCurrent(), false)
    return {
      phase: 'playing',
      committed: { ...runtime, runId: 'stale-run' },
      value: undefined,
    }
  })
  await Promise.resolve()
  controller.cancelActive()
  release()

  await assert.rejects(play, /Rejected stale Runtime play epoch/)
  assert.equal(controller.isCurrent(observedEpoch), false)
  assert.equal(controller.snapshot().committed, runtime)
})

test('settles deadlines as recoverable failures and keeps the queue usable', async () => {
  const controller = new RuntimeTransitionController()
  await bootstrap(controller)
  await assert.rejects(
    controller.enqueue('save', 10, async ({ signal }) => {
      await new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
      return { phase: 'edit-ready', value: undefined }
    }),
    /Runtime save timed out/,
  )

  assert.deepEqual(controller.snapshot().failure, {
    command: 'save',
    message: 'Runtime save timed out',
  })
  assert.equal(controller.snapshot().phase, 'edit-ready')
  await controller.enqueue('reload', 1_000, async () => ({
    phase: 'edit-ready',
    value: undefined,
  }))
  assert.equal((await controller.idle()).phase, 'edit-ready')
})

test('rejects interactive stable phases without a committed Runtime', async () => {
  const controller = new RuntimeTransitionController()
  await assert.rejects(
    controller.enqueue('bootstrap', 1_000, async () => ({
      phase: 'edit-ready',
      value: undefined,
    })),
    error => error instanceof RuntimeTransitionError
      && /requires a committed Runtime/.test(error.message),
  )
  assert.equal(controller.snapshot().phase, 'recoverable-failure')
})
