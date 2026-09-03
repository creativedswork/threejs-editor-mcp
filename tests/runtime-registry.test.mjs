import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const serverPath = fileURLToPath(new URL('../dist/server.js', import.meta.url))

test('prepared Runtime runs expire and commit with active-run CAS', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threejs-editor-m2-projects-'))
  const parent = await mkdtemp(join(tmpdir(), 'threejs-editor-m2-workspaces-'))
  const workspace = join(parent, 'game')
  await mkdir(join(workspace, 'src'), { recursive: true })
  await writeFile(join(workspace, 'package.json'), JSON.stringify({
    name: 'm2-runtime-registry',
    private: true,
    dependencies: { three: '0.185.1' },
  }))
  await writeFile(join(workspace, 'src', 'main.js'), 'export default {}\n')

  const client = new Client({
    name: 'threejs-editor-m2-runtime-registry-test',
    version: '0.0.0',
  })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [
      serverPath,
      '--root',
      root,
      '--workspace-root',
      parent,
      '--workspace',
      `game=${workspace}`,
    ],
  }))
  const ownerMeta = {
    'ai.deepseek.dsh/session': {
      sessionId: 'm2-registry',
      connectionGeneration: '11111111-1111-4111-8111-111111111111',
    },
  }
  try {
    const opened = await client.callTool({
      name: 'open_editor',
      arguments: { projectId: 'game' },
    })
    const revision = opened.structuredContent.revision
    const built = await client.callTool({
      name: 'build_project',
      arguments: { projectId: 'game', revision },
    })
    const active = {
      projectId: 'game',
      revision,
      buildId: built.structuredContent.buildId,
      runId: '22222222-2222-4222-8222-222222222222',
      nonce: '33333333-3333-4333-8333-333333333333',
    }
    const registered = await client.callTool({
      name: 'register_runtime_run',
      arguments: active,
      _meta: ownerMeta,
    })
    assert.equal(registered.isError, undefined)
    assert.match(registered.structuredContent.runtimeRef, /^[0-9a-f-]{36}$/)
    assert.equal(registered.structuredContent.projectionGeneration, 0)
    assert.equal(registered.structuredContent.buildRevision, revision)
    const referencePending = client.callTool({
      name: 'read_runtime_logs',
      arguments: {
        projectId: active.projectId,
        runtimeRef: registered.structuredContent.runtimeRef,
        target: 'validation',
        cursor: 0,
        limit: 1,
      },
      _meta: ownerMeta,
    })
    await new Promise(resolve => setImmediate(resolve))
    const referencePull = await client.callTool({
      name: 'pull_runtime_command',
      arguments: active,
      _meta: ownerMeta,
    })
    const referenceCommand = referencePull.structuredContent.command
    if (referenceCommand === undefined) {
      const earlyResult = await referencePending
      assert.fail(`runtimeRef command was not queued: ${JSON.stringify(earlyResult)}`)
    }
    assert.equal(referenceCommand.projectionGeneration, 0)
    assert.match(referenceCommand.evidenceToken, /^[0-9a-f-]{36}$/)
    assert.notEqual(referenceCommand.evidenceToken, registered.structuredContent.evidenceToken)
    const validationRuntime = {
      projectId: active.projectId,
      revision: active.revision,
      buildId: active.buildId,
      runId: '66666666-6666-4666-8666-666666666666',
      nonce: '77777777-7777-4777-8777-777777777777',
      target: 'validation',
    }
    assert.notEqual(validationRuntime.runId, active.runId)
    assert.notEqual(validationRuntime.nonce, active.nonce)
    await client.callTool({
      name: 'start_runtime_command',
      arguments: {
        ...active,
        commandId: referenceCommand.commandId,
        targetRuntime: validationRuntime,
      },
      _meta: ownerMeta,
    })
    const referenceOutcome = {
      status: 'succeeded',
      evidence: {
        kind: 'runtime-logs',
        runtime: validationRuntime,
        evidenceId: crypto.randomUUID(),
        evidenceToken: referenceCommand.evidenceToken,
        entries: [],
        nextCursor: 0,
        truncated: false,
      },
    }
    const referenceEvidence = await client.callTool({
      name: 'settle_runtime_command',
      arguments: {
        ...active,
        commandId: referenceCommand.commandId,
        outcome: referenceOutcome,
      },
      _meta: ownerMeta,
    })
    const duplicateEvidence = await client.callTool({
      name: 'settle_runtime_command',
      arguments: {
        ...active,
        commandId: referenceCommand.commandId,
        outcome: referenceOutcome,
      },
      _meta: ownerMeta,
    })
    const conflictingEvidence = await client.callTool({
      name: 'settle_runtime_command',
      arguments: {
        ...active,
        commandId: referenceCommand.commandId,
        outcome: {
          status: 'failed',
          stage: 'settle',
          code: 'EVIDENCE_REJECTED',
          message: 'conflicting duplicate',
        },
      },
      _meta: ownerMeta,
    })
    const referenceResult = await referencePending
    assert.equal(referenceEvidence.isError, undefined)
    assert.equal(duplicateEvidence.isError, undefined)
    assert.equal(conflictingEvidence.isError, true)
    assert.match(conflictingEvidence.content[0].text, /RUNTIME_COMMAND_STATE/)
    assert.equal(referenceResult.isError, undefined)

    const activeWithoutGrant = await client.callTool({
      name: 'capture_runtime_frame',
      arguments: {
        projectId: active.projectId,
        runtimeRef: registered.structuredContent.runtimeRef,
        target: 'active',
        activeIntent: 'user-requested',
      },
      _meta: ownerMeta,
    })
    assert.equal(activeWithoutGrant.isError, true)
    assert.match(activeWithoutGrant.content[0].text, /ACTIVE_CONFIRMATION_REQUIRED/)
    const grant = await client.callTool({
      name: 'grant_active_runtime_control',
      arguments: active,
      _meta: ownerMeta,
    })
    assert.equal(grant.isError, undefined)
    const activePending = client.callTool({
      name: 'read_runtime_logs',
      arguments: {
        projectId: active.projectId,
        runtimeRef: registered.structuredContent.runtimeRef,
        target: 'active',
        activeIntent: 'user-requested',
        cursor: 0,
        limit: 1,
      },
      _meta: ownerMeta,
    })
    await new Promise(resolve => setImmediate(resolve))
    const activePull = await client.callTool({
      name: 'pull_runtime_command',
      arguments: active,
      _meta: ownerMeta,
    })
    const activeCommand = activePull.structuredContent.command
    assert.notEqual(activeCommand, undefined)
    await client.callTool({
      name: 'start_runtime_command',
      arguments: {
        ...active,
        commandId: activeCommand.commandId,
        targetRuntime: {
          ...active,
          target: 'active',
        },
      },
      _meta: ownerMeta,
    })
    const activeFailure = {
      status: 'failed',
      stage: 'execute',
      code: 'TARGET_EXECUTION_FAILED',
      message: 'expected active command failure',
    }
    const mismatchedFailure = await client.callTool({
      name: 'settle_runtime_command',
      arguments: {
        ...active,
        commandId: activeCommand.commandId,
        outcome: {
          ...activeFailure,
          code: 'EVIDENCE_REJECTED',
        },
      },
      _meta: ownerMeta,
    })
    assert.equal(mismatchedFailure.isError, true)
    assert.match(mismatchedFailure.content[0].text, /RUNTIME_COMMAND_STATE/)
    const failed = await client.callTool({
      name: 'settle_runtime_command',
      arguments: {
        ...active,
        commandId: activeCommand.commandId,
        outcome: activeFailure,
      },
      _meta: ownerMeta,
    })
    const duplicateFailure = await client.callTool({
      name: 'settle_runtime_command',
      arguments: {
        ...active,
        commandId: activeCommand.commandId,
        outcome: activeFailure,
      },
      _meta: ownerMeta,
    })
    const activeResult = await activePending
    assert.equal(failed.isError, undefined)
    assert.equal(duplicateFailure.isError, undefined)
    assert.equal(activeResult.isError, true)
    assert.match(activeResult.content[0].text, /TARGET_EXECUTION_FAILED/)
    const spentGrant = await client.callTool({
      name: 'capture_runtime_frame',
      arguments: {
        projectId: active.projectId,
        runtimeRef: registered.structuredContent.runtimeRef,
        target: 'active',
      },
      _meta: ownerMeta,
    })
    assert.equal(spentGrant.isError, true)
    assert.match(spentGrant.content[0].text, /ACTIVE_CONFIRMATION_REQUIRED/)

    const candidate = {
      ...active,
      runId: '44444444-4444-4444-8444-444444444444',
      nonce: '55555555-5555-4555-8555-555555555555',
    }
    const excessiveLease = await client.callTool({
      name: 'prepare_runtime_run',
      arguments: { ...candidate, ttlMs: 600_001 },
      _meta: ownerMeta,
    })
    assert.equal(excessiveLease.isError, true)
    const prepared = await client.callTool({
      name: 'prepare_runtime_run',
      arguments: candidate,
      _meta: ownerMeta,
    })
    assert.equal(prepared.isError, undefined)
    assert.deepEqual(
      (await client.callTool({
        name: 'inspect_project',
        arguments: { projectId: 'game' },
        _meta: ownerMeta,
      })).structuredContent.runtime,
      {
        projectId: active.projectId,
        runtimeRef: registered.structuredContent.runtimeRef,
      },
    )

    const stale = await client.callTool({
      name: 'commit_runtime_run',
      arguments: {
        ...candidate,
        expectedActive: { ...active, runId: crypto.randomUUID() },
      },
      _meta: ownerMeta,
    })
    assert.equal(stale.isError, true)
    assert.match(stale.content[0].text, /active Runtime changed/)
    assert.deepEqual(
      (await client.callTool({
        name: 'inspect_project',
        arguments: { projectId: 'game' },
        _meta: ownerMeta,
      })).structuredContent.runtime,
      {
        projectId: active.projectId,
        runtimeRef: registered.structuredContent.runtimeRef,
      },
    )

    const expiring = await client.callTool({
      name: 'prepare_runtime_run',
      arguments: { ...candidate, ttlMs: 20 },
      _meta: ownerMeta,
    })
    await new Promise(resolve => setTimeout(
      resolve,
      Math.max(0, Date.parse(expiring.structuredContent.expiresAt) - Date.now() + 20),
    ))
    const expired = await client.callTool({
      name: 'commit_runtime_run',
      arguments: { ...candidate, expectedActive: active },
      _meta: ownerMeta,
    })
    assert.equal(expired.isError, true)
    assert.match(expired.content[0].text, /missing, expired, or stale/)

    await client.callTool({
      name: 'prepare_runtime_run',
      arguments: candidate,
      _meta: ownerMeta,
    })
    const committed = await client.callTool({
      name: 'commit_runtime_run',
      arguments: { ...candidate, expectedActive: active },
      _meta: ownerMeta,
    })
    assert.equal(committed.isError, undefined)
    assert.match(committed.structuredContent.runtimeRef, /^[0-9a-f-]{36}$/)
    assert.equal(committed.structuredContent.projectionGeneration, 0)
    assert.notEqual(
      committed.structuredContent.runtimeRef,
      registered.structuredContent.runtimeRef,
    )
    assert.deepEqual(
      (await client.callTool({
        name: 'inspect_project',
        arguments: { projectId: 'game' },
        _meta: ownerMeta,
      })).structuredContent.runtime,
      {
        projectId: candidate.projectId,
        runtimeRef: committed.structuredContent.runtimeRef,
      },
    )
    const staleReference = await client.callTool({
      name: 'capture_runtime_frame',
      arguments: {
        projectId: active.projectId,
        runtimeRef: registered.structuredContent.runtimeRef,
        target: 'validation',
      },
      _meta: ownerMeta,
    })
    assert.equal(staleReference.isError, true)
    assert.match(staleReference.content[0].text, /RUNTIME_REFERENCE_STALE/)
  } finally {
    await client.close()
    await rm(root, { recursive: true, force: true })
    await rm(parent, { recursive: true, force: true })
  }
})

test('Runtime projection advances only after acknowledgement and recovers by replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threejs-editor-r2-projects-'))
  const parent = await mkdtemp(join(tmpdir(), 'threejs-editor-r2-workspaces-'))
  const workspace = join(parent, 'game')
  await mkdir(join(workspace, 'src'), { recursive: true })
  await writeFile(join(workspace, 'package.json'), JSON.stringify({
    name: 'r2-runtime-projection',
    private: true,
    dependencies: { three: '0.185.1' },
  }))
  await writeFile(join(workspace, 'src', 'main.js'), 'export default {}\n')

  const client = new Client({
    name: 'threejs-editor-r2-runtime-projection-test',
    version: '0.0.0',
  })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [
      serverPath,
      '--root',
      root,
      '--workspace-root',
      parent,
      '--workspace',
      `game=${workspace}`,
    ],
  }))
  const ownerMeta = {
    'ai.deepseek.dsh/session': {
      sessionId: 'r2-projection',
      connectionGeneration: '88888888-8888-4888-8888-888888888888',
    },
  }
  const reconnectedOwnerMeta = {
    'ai.deepseek.dsh/session': {
      sessionId: 'r2-projection',
      connectionGeneration: '99999999-9999-4999-8999-999999999999',
    },
  }
  const objectUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const objectAt = position => ({
    uuid: objectUuid,
    path: 'scene/TestObject#0',
    name: 'TestObject',
    type: 'Object3D',
    visible: true,
    position,
    rotationDegrees: [0, 0, 0],
    scale: [1, 1, 1],
    commands: ['set_position'],
  })
  const inspectRuntime = async meta => (
    await client.callTool({
      name: 'inspect_project',
      arguments: { projectId: 'game' },
      _meta: meta,
    })
  ).structuredContent.runtime
  const reportScene = (runtime, position, meta = ownerMeta) => client.callTool({
    name: 'report_editor_scene',
    arguments: {
      projectId: runtime.projectId,
      revision: runtime.revision,
      runId: runtime.runId,
      objects: [objectAt(position)],
    },
    _meta: meta,
  })
  const applyPosition = (runtime, position, meta = ownerMeta) => client.callTool({
    name: 'apply_editor_commands',
    arguments: {
      projectId: runtime.projectId,
      baseRevision: runtime.revision,
      runId: runtime.runId,
      source: 'human',
      operations: [{
        type: 'set_position',
        objectUuid,
        value: position,
      }],
    },
    _meta: meta,
  })

  try {
    const opened = await client.callTool({
      name: 'open_editor',
      arguments: { projectId: 'game' },
    })
    const initialRevision = opened.structuredContent.revision
    const built = await client.callTool({
      name: 'build_project',
      arguments: { projectId: 'game', revision: initialRevision },
    })
    const active = {
      projectId: 'game',
      revision: initialRevision,
      buildId: built.structuredContent.buildId,
      runId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      nonce: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    }
    const registered = await client.callTool({
      name: 'register_runtime_run',
      arguments: active,
      _meta: ownerMeta,
    })
    assert.equal(registered.isError, undefined)
    assert.equal(registered.structuredContent.projectionGeneration, 0)
    const registeredRuntime = {
      projectId: active.projectId,
      runtimeRef: registered.structuredContent.runtimeRef,
    }
    assert.equal((await reportScene(active, [0, 0, 0])).isError, undefined)

    const firstEdit = await applyPosition(active, [1, 0, 0])
    assert.equal(firstEdit.isError, undefined)
    const firstPending = firstEdit.structuredContent.pendingProjection
    assert.equal(firstPending.baseRevision, initialRevision)
    assert.equal(firstPending.targetRevision, firstEdit.structuredContent.revision)
    assert.equal(firstPending.expectedGeneration, 0)
    assert.deepEqual(await inspectRuntime(ownerMeta), registeredRuntime)

    const stale = await client.callTool({
      name: 'commit_runtime_projection',
      arguments: {
        projectId: active.projectId,
        transitionId: crypto.randomUUID(),
        runId: active.runId,
        nonce: active.nonce,
        revision: firstPending.targetRevision,
      },
      _meta: ownerMeta,
    })
    assert.equal(stale.isError, true)
    assert.match(stale.content[0].text, /RUNTIME_PROJECTION_STALE/)
    assert.deepEqual(await inspectRuntime(ownerMeta), registeredRuntime)

    const advanced = await client.callTool({
      name: 'commit_runtime_projection',
      arguments: {
        projectId: active.projectId,
        transitionId: firstPending.transitionId,
        runId: active.runId,
        nonce: active.nonce,
        revision: firstPending.targetRevision,
      },
      _meta: ownerMeta,
    })
    assert.equal(advanced.isError, undefined)
    assert.equal(advanced.structuredContent.projectionGeneration, 1)
    assert.equal(advanced.structuredContent.revision, firstPending.targetRevision)
    assert.notEqual(
      advanced.structuredContent.runtimeRef,
      registered.structuredContent.runtimeRef,
    )
    const advancedRuntime = {
      projectId: active.projectId,
      runtimeRef: advanced.structuredContent.runtimeRef,
    }
    const duplicate = await client.callTool({
      name: 'commit_runtime_projection',
      arguments: {
        projectId: active.projectId,
        transitionId: firstPending.transitionId,
        runId: active.runId,
        nonce: active.nonce,
        revision: firstPending.targetRevision,
      },
      _meta: ownerMeta,
    })
    assert.equal(duplicate.isError, true)
    assert.deepEqual(await inspectRuntime(ownerMeta), advancedRuntime)

    const projected = { ...active, revision: firstPending.targetRevision }
    assert.equal((await reportScene(projected, [1, 0, 0])).isError, undefined)
    const unacknowledgedEdit = await applyPosition(projected, [2, 0, 0])
    const unacknowledged = unacknowledgedEdit.structuredContent.pendingProjection
    assert.deepEqual(await inspectRuntime(ownerMeta), advancedRuntime)
    const unacknowledgedBuild = await client.callTool({
      name: 'build_project',
      arguments: { projectId: 'game', revision: unacknowledged.targetRevision },
    })
    const recoveredBeforeCommit = {
      projectId: 'game',
      revision: unacknowledged.targetRevision,
      buildId: unacknowledgedBuild.structuredContent.buildId,
      runId: 'cccccccc-dddd-4eee-8fff-000000000000',
      nonce: 'dddddddd-eeee-4fff-8000-111111111111',
    }
    await client.callTool({
      name: 'prepare_runtime_run',
      arguments: recoveredBeforeCommit,
      _meta: ownerMeta,
    })
    const recovered = await client.callTool({
      name: 'commit_runtime_run',
      arguments: {
        ...recoveredBeforeCommit,
        expectedActive: projected,
      },
      _meta: ownerMeta,
    })
    assert.equal(recovered.isError, undefined)
    assert.deepEqual(await inspectRuntime(ownerMeta), {
      projectId: recoveredBeforeCommit.projectId,
      runtimeRef: recovered.structuredContent.runtimeRef,
    })

    assert.equal(
      (await reportScene(recoveredBeforeCommit, [2, 0, 0])).isError,
      undefined,
    )
    const ambiguousEdit = await applyPosition(recoveredBeforeCommit, [3, 0, 0])
    const ambiguous = ambiguousEdit.structuredContent.pendingProjection
    const committedWithoutObservedResponse = await client.callTool({
      name: 'commit_runtime_projection',
      arguments: {
        projectId: recoveredBeforeCommit.projectId,
        transitionId: ambiguous.transitionId,
        runId: recoveredBeforeCommit.runId,
        nonce: recoveredBeforeCommit.nonce,
        revision: ambiguous.targetRevision,
      },
      _meta: ownerMeta,
    })
    assert.equal(committedWithoutObservedResponse.isError, undefined)
    assert.deepEqual(await inspectRuntime(ownerMeta), {
      projectId: recoveredBeforeCommit.projectId,
      runtimeRef: committedWithoutObservedResponse.structuredContent.runtimeRef,
    })
    const ambiguousBuild = await client.callTool({
      name: 'build_project',
      arguments: { projectId: 'game', revision: ambiguous.targetRevision },
    })
    const recoveredAfterCommit = {
      projectId: 'game',
      revision: ambiguous.targetRevision,
      buildId: ambiguousBuild.structuredContent.buildId,
      runId: 'eeeeeeee-ffff-4000-8111-222222222222',
      nonce: 'ffffffff-0000-4111-8222-333333333333',
    }
    await client.callTool({
      name: 'prepare_runtime_run',
      arguments: recoveredAfterCommit,
      _meta: ownerMeta,
    })
    const recoveredFromAmbiguousCommit = await client.callTool({
      name: 'commit_runtime_run',
      arguments: {
        ...recoveredAfterCommit,
        expectedActive: recoveredBeforeCommit,
      },
      _meta: ownerMeta,
    })
    assert.equal(recoveredFromAmbiguousCommit.isError, undefined)
    assert.deepEqual(await inspectRuntime(ownerMeta), {
      projectId: recoveredAfterCommit.projectId,
      runtimeRef: recoveredFromAmbiguousCommit.structuredContent.runtimeRef,
    })

    const reconnected = {
      ...recoveredAfterCommit,
      runId: '11111111-2222-4333-8444-555555555555',
      nonce: '22222222-3333-4444-8555-666666666666',
    }
    await client.callTool({
      name: 'prepare_runtime_run',
      arguments: reconnected,
      _meta: reconnectedOwnerMeta,
    })
    const reconnectedCommit = await client.callTool({
      name: 'commit_runtime_run',
      arguments: reconnected,
      _meta: reconnectedOwnerMeta,
    })
    assert.equal(reconnectedCommit.isError, undefined)
    assert.deepEqual(await inspectRuntime(reconnectedOwnerMeta), {
      projectId: reconnected.projectId,
      runtimeRef: reconnectedCommit.structuredContent.runtimeRef,
    })
  } finally {
    await client.close()
    await rm(root, { recursive: true, force: true })
    await rm(parent, { recursive: true, force: true })
  }
})
