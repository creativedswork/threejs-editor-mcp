import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const serverPath = fileURLToPath(new URL('../dist/server.js', import.meta.url))

test('normalized Runtime registry and broker preserve identity invariants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threejs-editor-r5-projects-'))
  const parent = await mkdtemp(join(tmpdir(), 'threejs-editor-r5-workspaces-'))
  const workspace = join(parent, 'game')
  await mkdir(join(workspace, 'src'), { recursive: true })
  await writeFile(join(workspace, 'package.json'), JSON.stringify({
    name: 'r5-runtime-registry',
    private: true,
    dependencies: { three: '0.185.1' },
  }))
  await writeFile(join(workspace, 'src', 'main.js'), 'export default {}\n')

  const client = new Client({
    name: 'threejs-editor-r5-runtime-registry-test',
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

  const owner = {
    sessionId: 'r5-registry',
    connectionGeneration: '11111111-1111-4111-8111-111111111111',
  }
  const ownerMeta = { 'ai.deepseek.dsh/session': owner }
  const objectUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

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
    const candidate = {
      projectId: 'game',
      revision,
      buildId: built.structuredContent.buildId,
      runId: '22222222-2222-4222-8222-222222222222',
      nonce: '33333333-3333-4333-8333-333333333333',
    }

    const prepared = await client.callTool({
      name: 'prepare_runtime_run',
      arguments: candidate,
      _meta: ownerMeta,
    })
    assert.equal(prepared.isError, undefined)
    assert.deepEqual(prepared.structuredContent.execution, {
      projectId: candidate.projectId,
      runId: candidate.runId,
      nonce: candidate.nonce,
      owner,
    })
    assert.deepEqual(prepared.structuredContent.projection, {
      workspaceRevision: revision,
      generation: 0,
      loadedBuild: {
        buildId: candidate.buildId,
        sourceRevision: revision,
      },
    })

    const committed = await client.callTool({
      name: 'commit_runtime_run',
      arguments: {
        projectId: candidate.projectId,
        runtimeRef: prepared.structuredContent.runtimeRef,
      },
      _meta: ownerMeta,
    })
    assert.equal(committed.isError, undefined)
    const runtimeRef = committed.structuredContent.runtimeRef
    const address = { projectId: candidate.projectId, runtimeRef }
    assert.deepEqual(
      (await client.callTool({
        name: 'inspect_project',
        arguments: { projectId: candidate.projectId },
        _meta: ownerMeta,
      })).structuredContent.runtime,
      address,
    )

    const pendingResult = client.callTool({
      name: 'read_runtime_logs',
      arguments: { ...address, target: 'validation', cursor: 0, limit: 1 },
      _meta: ownerMeta,
    })
    await new Promise(resolve => setImmediate(resolve))
    const pulled = await client.callTool({
      name: 'pull_runtime_command',
      arguments: address,
      _meta: ownerMeta,
    })
    const command = pulled.structuredContent.command
    assert.notEqual(command, undefined)
    assert.deepEqual(command.runtime, {
      execution: committed.structuredContent.execution,
      projection: committed.structuredContent.projection,
    })
    assert.equal('projectionGeneration' in command, false)

    const targetRuntime = {
      execution: {
        ...command.runtime.execution,
        runId: '44444444-4444-4444-8444-444444444444',
        nonce: '55555555-5555-4555-8555-555555555555',
      },
      projection: command.runtime.projection,
      target: 'validation',
    }
    const started = await client.callTool({
      name: 'start_runtime_command',
      arguments: { ...address, commandId: command.commandId, targetRuntime },
      _meta: ownerMeta,
    })
    assert.equal(started.isError, undefined)

    const outcome = {
      status: 'succeeded',
      evidence: {
        kind: 'runtime-logs',
        runtime: targetRuntime,
        evidenceId: crypto.randomUUID(),
        evidenceToken: command.evidenceToken,
        entries: [],
        nextCursor: 0,
        truncated: false,
      },
    }
    const settled = await client.callTool({
      name: 'settle_runtime_command',
      arguments: { ...address, commandId: command.commandId, outcome },
      _meta: ownerMeta,
    })
    const duplicate = await client.callTool({
      name: 'settle_runtime_command',
      arguments: { ...address, commandId: command.commandId, outcome },
      _meta: ownerMeta,
    })
    const conflicting = await client.callTool({
      name: 'settle_runtime_command',
      arguments: {
        ...address,
        commandId: command.commandId,
        outcome: {
          status: 'failed',
          stage: 'settle',
          code: 'EVIDENCE_REJECTED',
          message: 'conflicting duplicate',
        },
      },
      _meta: ownerMeta,
    })
    assert.equal(settled.isError, undefined)
    assert.equal(duplicate.isError, undefined)
    assert.equal(conflicting.isError, true)
    assert.match(conflicting.content[0].text, /RUNTIME_COMMAND_STATE/)
    assert.equal((await pendingResult).isError, undefined)

    const reported = await client.callTool({
      name: 'report_editor_scene',
      arguments: {
        projectId: candidate.projectId,
        revision,
        runId: candidate.runId,
        objects: [{
          uuid: objectUuid,
          path: 'scene/TestObject#0',
          name: 'TestObject',
          type: 'Object3D',
          visible: true,
          position: [0, 0, 0],
          rotationDegrees: [0, 0, 0],
          scale: [1, 1, 1],
          commands: ['set_position'],
        }],
      },
      _meta: ownerMeta,
    })
    assert.equal(reported.isError, undefined)

    const edited = await client.callTool({
      name: 'apply_editor_commands',
      arguments: {
        projectId: candidate.projectId,
        baseRevision: revision,
        runId: candidate.runId,
        source: 'human',
        operations: [{
          type: 'set_position',
          objectUuid,
          value: [1, 0, 0],
        }],
      },
      _meta: ownerMeta,
    })
    assert.equal(edited.isError, undefined)
    const pendingProjection = edited.structuredContent.pendingProjection
    assert.deepEqual(
      pendingProjection.execution,
      committed.structuredContent.execution,
    )
    assert.equal(pendingProjection.expectedGeneration, 0)

    const advanced = await client.callTool({
      name: 'commit_runtime_projection',
      arguments: {
        ...address,
        transitionId: pendingProjection.transitionId,
        revision: pendingProjection.targetRevision,
      },
      _meta: ownerMeta,
    })
    assert.equal(advanced.isError, undefined)
    assert.equal(advanced.structuredContent.projection.generation, 1)
    assert.equal(
      advanced.structuredContent.projection.workspaceRevision,
      pendingProjection.targetRevision,
    )
    assert.notEqual(advanced.structuredContent.runtimeRef, runtimeRef)

    const staleReference = await client.callTool({
      name: 'capture_runtime_frame',
      arguments: { ...address, target: 'validation' },
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
