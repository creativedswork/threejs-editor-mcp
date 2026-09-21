import assert from 'node:assert/strict'
import test from 'node:test'
import { RuntimeEffects } from '../src/runtime-effects.ts'
import { RuntimeTransitionController } from '../src/runtime-lifecycle.ts'

test('bounds failed Runtime effects without rejecting idle', async () => {
  const failures = []
  const effects = new RuntimeEffects(10, failure => failures.push(failure))

  effects.run('model-context', async signal => {
    await new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  })
  effects.run('diagnostics', async () => {
    throw new Error('host unavailable')
  })
  await effects.idle()

  assert.deepEqual(failures.map(failure => failure.name).sort(), [
    'diagnostics',
    'model-context',
  ])
})

test('effect failure cannot change a committed Runtime snapshot', async () => {
  const failures = []
  const effects = new RuntimeEffects(100, failure => failures.push(failure))
  const controller = new RuntimeTransitionController()
  await controller.enqueue('bootstrap', 100, async () => ({
    phase: 'edit-ready',
    committed: { runId: 'committed' },
    value: undefined,
  }))
  const committed = controller.snapshot()

  effects.run('model-context', async () => {
    throw new Error('host rejected context')
  })
  await effects.idle()

  assert.equal(failures.length, 1)
  assert.equal(controller.snapshot(), committed)
})
