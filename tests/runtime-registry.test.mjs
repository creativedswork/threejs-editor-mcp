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
