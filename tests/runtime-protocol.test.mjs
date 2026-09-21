import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RuntimeProtocolError,
  advanceRuntimeProjection,
  runtimeCommandOutcomeMessage,
  runtimeProtocolErrorMessage,
  sameRuntimeExecution,
  sameRuntimeIdentity,
  sameRuntimeOwner,
  sameRuntimeProjection,
} from '../src/runtime-protocol.ts'

const owner = {
  sessionId: 'session-a',
  connectionGeneration: '11111111-1111-4111-8111-111111111111',
}

const execution = {
  projectId: 'game',
  runId: '22222222-2222-4222-8222-222222222222',
  nonce: '33333333-3333-4333-8333-333333333333',
  owner,
}

const projection = {
  workspaceRevision: 'a'.repeat(64),
  generation: 0,
  loadedBuild: {
    buildId: 'b'.repeat(64),
    sourceRevision: 'a'.repeat(64),
  },
}

test('compares every execution identity coordinate', () => {
  assert.equal(sameRuntimeExecution(execution, structuredClone(execution)), true)
  const alternatives = [
    { ...execution, projectId: 'other-game' },
    { ...execution, runId: '44444444-4444-4444-8444-444444444444' },
    { ...execution, nonce: '55555555-5555-4555-8555-555555555555' },
    { ...execution, owner: { ...owner, sessionId: 'session-b' } },
    {
      ...execution,
      owner: {
        ...owner,
        connectionGeneration: '66666666-6666-4666-8666-666666666666',
      },
    },
  ]
  for (const alternative of alternatives) {
    assert.equal(sameRuntimeExecution(execution, alternative), false)
  }
  assert.equal(sameRuntimeOwner(owner, { ...owner }), true)
  assert.equal(sameRuntimeOwner(owner, alternatives[3].owner), false)
})

test('compares every projection coordinate', () => {
  assert.equal(sameRuntimeProjection(projection, structuredClone(projection)), true)
  const alternatives = [
    { ...projection, workspaceRevision: 'c'.repeat(64) },
    { ...projection, generation: 1 },
    {
      ...projection,
      loadedBuild: { ...projection.loadedBuild, buildId: 'd'.repeat(64) },
    },
    {
      ...projection,
      loadedBuild: { ...projection.loadedBuild, sourceRevision: 'e'.repeat(64) },
    },
  ]
  for (const alternative of alternatives) {
    assert.equal(sameRuntimeProjection(projection, alternative), false)
  }
})

test('compares normalized execution and projection as one Runtime identity', () => {
  const identity = { execution, projection }
  assert.equal(sameRuntimeIdentity(identity, structuredClone(identity)), true)
  assert.equal(sameRuntimeIdentity(identity, {
    execution,
    projection: { ...projection, generation: 1 },
  }), false)
  assert.equal(sameRuntimeIdentity(identity, {
    execution: { ...execution, runId: '44444444-4444-4444-8444-444444444444' },
    projection,
  }), false)
})

test('advances projection once without mutating execution or build provenance', () => {
  const before = structuredClone(projection)
  const next = advanceRuntimeProjection(
    projection,
    {
      workspaceRevision: projection.workspaceRevision,
      generation: projection.generation,
    },
    'c'.repeat(64),
  )

  assert.deepEqual(projection, before)
  assert.equal(next.workspaceRevision, 'c'.repeat(64))
  assert.equal(next.generation, 1)
  assert.deepEqual(next.loadedBuild, projection.loadedBuild)
  assert.equal(sameRuntimeProjection(next, projection), false)
})

test('rejects stale projection revision and generation expectations', () => {
  const staleExpectations = [
    {
      workspaceRevision: 'c'.repeat(64),
      generation: projection.generation,
    },
    {
      workspaceRevision: projection.workspaceRevision,
      generation: 1,
    },
  ]
  for (const expected of staleExpectations) {
    assert.throws(
      () => advanceRuntimeProjection(projection, expected, 'd'.repeat(64)),
      error => error instanceof RuntimeProtocolError
        && error.code === 'RUNTIME_PROJECTION_STALE'
        && error.message.startsWith('[RUNTIME_PROJECTION_STALE]'),
    )
  }
})

test('formats every typed terminal outcome deterministically for replay', () => {
  const cases = [
    {
      outcome: { status: 'succeeded', evidence: { digest: 'abc' } },
      message: 'Runtime Harness command succeeded',
    },
    {
      outcome: {
        status: 'failed',
        stage: 'prepare',
        code: 'TARGET_PREPARATION_FAILED',
        message: 'validation frame failed',
      },
      message:
        '[TARGET_PREPARATION_FAILED] Runtime Harness prepare failed: validation frame failed',
    },
    {
      outcome: { status: 'cancelled', reason: 'Runtime was replaced' },
      message: '[RUNTIME_COMMAND_CANCELLED] Runtime was replaced',
    },
    {
      outcome: { status: 'expired', stage: 'settle' },
      message: '[RUNTIME_COMMAND_EXPIRED] Runtime Harness settle timed out',
    },
  ]

  for (const { outcome, message } of cases) {
    assert.equal(runtimeCommandOutcomeMessage(outcome), message)
    assert.equal(runtimeCommandOutcomeMessage(outcome), message)
  }
})

test('maps protocol error codes to stable default and detailed messages', () => {
  assert.equal(
    runtimeProtocolErrorMessage('RUNTIME_EXECUTION_STALE'),
    '[RUNTIME_EXECUTION_STALE] Runtime execution is stale or incomplete',
  )
  assert.equal(
    runtimeProtocolErrorMessage('RUNTIME_OWNER_FOREIGN', 'connection changed'),
    '[RUNTIME_OWNER_FOREIGN] connection changed',
  )
})
