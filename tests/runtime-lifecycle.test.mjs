import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RuntimeCoordinator,
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

test('allows a committed Runtime aggregate to restart after recoverable failure', async () => {
  const coordinator = new RuntimeCoordinator()
  await bootstrap(coordinator)
  await assert.rejects(
    coordinator.enqueue('reload', 1_000, async () => {
      throw new Error('recoverable Runtime failure')
    }),
    /recoverable Runtime failure/,
  )
  assert.equal(coordinator.snapshot().phase, 'recoverable-failure')
  await coordinator.enqueue('play', 1_000, async () => ({
    phase: 'playing',
    value: undefined,
  }))
  assert.equal(coordinator.snapshot().phase, 'playing')
})

test('promotes one candidate as the complete committed aggregate', async () => {
  const coordinator = new RuntimeCoordinator()
  await bootstrap(coordinator)
  const previous = coordinator.snapshot()
  const candidate = { runId: 'candidate-1' }
  const validation = { runId: 'validation-1' }
  const replacement = { ...runtime, runId: 'run-2' }

  await coordinator.enqueue('reload', 1_000, async context => {
    coordinator.setValidation(context.committed, validation)
    coordinator.setCandidate(context.epoch, candidate)
    assert.equal(coordinator.snapshot().candidate, candidate)
    assert.equal(coordinator.snapshot().validation, validation)

    coordinator.commitCandidate(context.epoch, candidate, replacement)
    assert.equal(coordinator.snapshot().committed, replacement)
    assert.equal(coordinator.snapshot().candidate, undefined)
    assert.equal(coordinator.snapshot().validation, undefined)
    return { phase: 'edit-ready', committed: replacement, value: undefined }
  })

  assert.equal(Object.isFrozen(previous), true)
  assert.equal(previous.committed, runtime)
  assert.deepEqual(coordinator.snapshot(), {
    phase: 'edit-ready',
    epoch: 2,
    committed: replacement,
  })
})

test('rejects stale aggregate writes and preserves newer resources', async () => {
  const coordinator = new RuntimeCoordinator()
  await bootstrap(coordinator)
  const previous = coordinator.snapshot().committed
  const validation = { runId: 'validation-1' }
  coordinator.setValidation(previous, validation)

  let release
  const blocked = new Promise(resolve => {
    release = resolve
  })
  const transition = coordinator.enqueue('reload', 1_000, async context => {
    const candidate = { runId: 'candidate-1' }
    coordinator.setCandidate(context.epoch, candidate)
    await blocked
    coordinator.discardCandidate(candidate)
    return { phase: 'edit-ready', value: undefined }
  })
  await Promise.resolve()
  const staleEpoch = coordinator.snapshot().epoch
  coordinator.cancelActive()
  release()

  await assert.rejects(transition, /Rejected stale Runtime reload epoch/)
  assert.throws(
    () => coordinator.setCandidate(staleEpoch, { runId: 'stale-candidate' }),
    /Rejected stale Runtime epoch/,
  )
  assert.throws(
    () => coordinator.setValidation({ ...runtime }, validation),
    /stale Runtime/,
  )
  assert.equal(coordinator.snapshot().committed, previous)
  assert.equal(coordinator.snapshot().candidate, undefined)
  assert.equal(coordinator.snapshot().validation, validation)
})

test('releases only the current committed aggregate outside transitions', async () => {
  const coordinator = new RuntimeCoordinator()
  await bootstrap(coordinator)
  const committed = coordinator.snapshot().committed

  assert.throws(
    () => coordinator.releaseCommitted({ ...runtime }),
    /stale committed Runtime/,
  )
  coordinator.releaseCommitted(committed)

  assert.equal(coordinator.snapshot().committed, undefined)
  assert.equal(coordinator.snapshot().phase, 'disposed')
  assert.equal(coordinator.snapshot().epoch, 2)
})
