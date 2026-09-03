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
    await client.callTool({
      name: 'register_runtime_run',
      arguments: active,
      _meta: ownerMeta,
    })

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
    assert.equal(
      (await client.callTool({
        name: 'inspect_project',
        arguments: { projectId: 'game' },
        _meta: ownerMeta,
      })).structuredContent.runtime.runId,
      active.runId,
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
    assert.equal(
      (await client.callTool({
        name: 'inspect_project',
        arguments: { projectId: 'game' },
        _meta: ownerMeta,
      })).structuredContent.runtime.runId,
      active.runId,
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
    assert.equal(
      (await client.callTool({
        name: 'inspect_project',
        arguments: { projectId: 'game' },
        _meta: ownerMeta,
      })).structuredContent.runtime.runId,
      candidate.runId,
    )
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
    assert.equal((await reportScene(active, [0, 0, 0])).isError, undefined)

    const firstEdit = await applyPosition(active, [1, 0, 0])
    assert.equal(firstEdit.isError, undefined)
    const firstPending = firstEdit.structuredContent.pendingProjection
    assert.equal(firstPending.baseRevision, initialRevision)
    assert.equal(firstPending.targetRevision, firstEdit.structuredContent.revision)
    assert.equal(firstPending.expectedGeneration, 0)
    assert.equal((await inspectRuntime(ownerMeta)).revision, initialRevision)

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
    assert.equal((await inspectRuntime(ownerMeta)).revision, initialRevision)

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
    assert.equal((await inspectRuntime(ownerMeta)).revision, firstPending.targetRevision)

    const projected = { ...active, revision: firstPending.targetRevision }
    assert.equal((await reportScene(projected, [1, 0, 0])).isError, undefined)
    const unacknowledgedEdit = await applyPosition(projected, [2, 0, 0])
    const unacknowledged = unacknowledgedEdit.structuredContent.pendingProjection
    assert.equal((await inspectRuntime(ownerMeta)).revision, projected.revision)
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
    assert.equal((await inspectRuntime(ownerMeta)).revision, unacknowledged.targetRevision)

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
    assert.equal((await inspectRuntime(ownerMeta)).revision, ambiguous.targetRevision)

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
    assert.equal((await inspectRuntime(reconnectedOwnerMeta)).revision, ambiguous.targetRevision)
  } finally {
    await client.close()
    await rm(root, { recursive: true, force: true })
    await rm(parent, { recursive: true, force: true })
  }
})
